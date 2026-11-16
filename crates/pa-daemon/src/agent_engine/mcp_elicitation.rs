//! MCP elicitation (`elicitation/create`) on the daemon side: a server asking the
//! user for one value.
//!
//! The daemon shows the request as one `[mcp_elicitation]` row carrying the exact
//! answer syntax, then waits with a bounded timeout. It always answers the server —
//! `accept` with the user's value, `decline`, or `cancel` — and a timeout is a
//! decline. Nothing blocks the TUI: the request is a message, the answer is a
//! `/elicit` command, and the session continues without the user if they never
//! answer.
//!
//! The surface represents exactly one value (text, an enum choice, a boolean, or a
//! number). A schema it cannot represent is declined up front with the reason in
//! the row — never approximated, never accepted with made-up input.
//!
//! Rollback: nothing here changes the wire (no new command, no session event, no
//! schema bump) — the request and answer are an ordinary custom row plus a
//! `/elicit` prompt routed before admission. Removing the `/elicit` intercept in
//! `run_prompt` and the handler registration in `extra_host_handlers` restores the
//! previous behavior exactly; the kernel then gets "unknown host request" and
//! returns a JSON-RPC error to the server, which is a decline with a reason, and
//! its own 300 s ceiling means no caller ever hangs.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use pa_core::kernel::shared::{host_handler, HostRequestHandlers, HostRequestPayload};
use pa_core::session_engine::mcp_notices::McpNotificationRowSink;
use pa_core::session_engine::telemetry::{McpUsageKind, McpUsageSink};
use pa_types::ai::UserContent as SessionUserContent;
use pa_types::session::CustomMessage;
use serde_json::{json, Value};
use tokio::sync::oneshot;

/// The custom row type an elicitation request/answer lands as.
pub const MCP_ELICITATION_CUSTOM_TYPE: &str = "mcp_elicitation";
/// How long a request waits for the user before it is declined. The kernel's own
/// ceiling (`_ELICITATION_TIMEOUT`, 300 s) sits above this so the daemon's decision
/// is always the one the server sees.
pub(crate) const ELICITATION_WAIT: Duration = Duration::from_secs(120);
const MAX_MESSAGE_CHARS: usize = 512;

/// The decision the user reached for one pending request.
#[derive(Debug, Clone, PartialEq)]
pub enum ElicitationDecision {
    Accept(Value),
    Decline,
    Cancel,
}

impl ElicitationDecision {
    fn action(&self) -> &'static str {
        match self {
            Self::Accept(_) => "accept",
            Self::Decline => "decline",
            Self::Cancel => "cancel",
        }
    }
}

/// What the user typed: accept carries the raw answer text, validated against the
/// pending field when it is applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ElicitationAnswer {
    Accept(String),
    Decline,
    Cancel,
}

/// One waiting request, with the field its answer must satisfy.
struct Pending {
    id: u64,
    field: AnswerField,
    sender: oneshot::Sender<ElicitationDecision>,
}

/// The pending interaction registry: one request at a time, because the user
/// answers one thing and a second concurrent request would race that answer.
#[derive(Default)]
pub struct PendingElicitations {
    inner: Mutex<PendingInner>,
}

#[derive(Default)]
struct PendingInner {
    next_id: u64,
    pending: Option<Pending>,
}

impl PendingElicitations {
    /// Open one request; the caller waits on the receiver.
    fn open(
        &self,
        field: AnswerField,
    ) -> Result<(u64, oneshot::Receiver<ElicitationDecision>), String> {
        let mut inner = self.inner.lock().expect("elicitation registry lock");
        if let Some(pending) = &inner.pending {
            return Err(format!(
                "another elicitation request (id {}) is still waiting for an answer",
                pending.id
            ));
        }
        inner.next_id += 1;
        let id = inner.next_id;
        let (tx, rx) = oneshot::channel();
        inner.pending = Some(Pending {
            id,
            field,
            sender: tx,
        });
        Ok((id, rx))
    }

    /// Apply the user's answer to the pending request.
    ///
    /// An invalid `accept` leaves the request pending so the user can retry; it
    /// returns the reason the answer did not fit.
    ///
    /// # Errors
    ///
    /// The reason when nothing is pending, or the answer does not fit the field.
    pub fn answer(&self, answer: ElicitationAnswer) -> Result<u64, String> {
        let mut inner = self.inner.lock().expect("elicitation registry lock");
        let Some(pending) = inner.pending.take() else {
            return Err("no elicitation request is waiting".to_string());
        };
        let decision = match answer {
            ElicitationAnswer::Accept(raw) => match pending.field.parse_answer(&raw) {
                Ok(value) => ElicitationDecision::Accept(value),
                Err(reason) => {
                    // Keep it pending: the user gets another try.
                    inner.pending = Some(pending);
                    return Err(reason);
                }
            },
            ElicitationAnswer::Decline => ElicitationDecision::Decline,
            ElicitationAnswer::Cancel => ElicitationDecision::Cancel,
        };
        let id = pending.id;
        pending
            .sender
            .send(decision)
            .map_err(|_| format!("elicitation request {id} already timed out"))?;
        Ok(id)
    }

    /// Drop the pending request with `id`: its wait timed out, so a later request
    /// must not be refused for a slot nobody is listening on any more.
    fn release(&self, id: u64) {
        let mut inner = self.inner.lock().expect("elicitation registry lock");
        if inner
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id == id)
        {
            inner.pending = None;
        }
    }

    /// The pending request id, when one waits.
    #[must_use]
    pub fn pending_id(&self) -> Option<u64> {
        self.inner
            .lock()
            .expect("elicitation registry lock")
            .pending
            .as_ref()
            .map(|pending| pending.id)
    }
}

/// One `/elicit` submission from the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ElicitCommand {
    /// `/elicit` — report whether anything is waiting.
    Status,
    Accept(String),
    Decline,
    Cancel,
}

/// Parse a `/elicit` submission; `None` for anything else, which stays a prompt.
#[must_use]
pub fn parse_elicit_command(text: &str) -> Option<ElicitCommand> {
    let rest = text.trim().strip_prefix("/elicit")?;
    // `/elicitfoo` is a different word.
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let rest = rest.trim();
    let (verb, tail) = match rest.split_once(char::is_whitespace) {
        Some((verb, tail)) => (verb, tail.trim()),
        None => (rest, ""),
    };
    match verb {
        "" => Some(ElicitCommand::Status),
        "accept" => Some(ElicitCommand::Accept(tail.to_string())),
        "decline" if tail.is_empty() => Some(ElicitCommand::Decline),
        "cancel" if tail.is_empty() => Some(ElicitCommand::Cancel),
        _ => None,
    }
}

/// One elicitation request, already through the wire.
pub(crate) struct ElicitationRequest {
    pub server: String,
    pub message: String,
    pub requested_schema: Value,
}

/// Validate one `mcp.elicitation` payload.
///
/// # Errors
///
/// A missing or oversized server name.
pub(crate) fn parse_request(data: &Value) -> anyhow::Result<ElicitationRequest> {
    let server = data
        .get("server")
        .and_then(Value::as_str)
        .filter(|server| !server.is_empty() && server.chars().count() <= 128)
        .ok_or_else(|| anyhow::anyhow!("mcp.elicitation requires a `server` name"))?;
    let message = data
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let requested_schema = data.get("requestedSchema").cloned().unwrap_or(Value::Null);
    Ok(ElicitationRequest {
        server: server.to_string(),
        message: message.chars().take(MAX_MESSAGE_CHARS).collect(),
        requested_schema,
    })
}

/// The single answerable field a request carries, or the reason it is unsupported.
pub(crate) fn single_field(schema: &Value) -> Result<AnswerField, String> {
    match schema.get("properties").and_then(Value::as_object) {
        Some(properties) => {
            if properties.len() != 1 {
                return Err(format!(
                    "the requested schema has {} fields; this surface asks one value at a time",
                    properties.len()
                ));
            }
            let (name, field) = properties.iter().next().expect("one property");
            AnswerField::from_schema(name, field)
        }
        // A bare primitive schema answers under `value`.
        None => AnswerField::from_schema("value", schema),
    }
}

/// The one value a user answers with, and how its text is validated.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AnswerField {
    pub name: String,
    pub kind: FieldKind,
}

/// The shapes of `AnswerField` this surface can ask for.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum FieldKind {
    Text,
    Choice(Vec<String>),
    Boolean,
    Integer,
    Number,
}

impl AnswerField {
    fn from_schema(name: &str, schema: &Value) -> Result<Self, String> {
        let kind = match schema.get("type").and_then(Value::as_str) {
            Some("string") => match schema.get("enum").and_then(Value::as_array) {
                Some(values) => {
                    let choices: Vec<String> = values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect();
                    if choices.is_empty() {
                        return Err("the requested schema's enum has no string choices".to_string());
                    }
                    FieldKind::Choice(choices)
                }
                None => FieldKind::Text,
            },
            Some("boolean") => FieldKind::Boolean,
            Some("integer") => FieldKind::Integer,
            Some("number") => FieldKind::Number,
            other => {
                return Err(format!(
                    "the requested schema's type {other:?} is not a value this surface can ask for"
                ))
            }
        };
        Ok(Self {
            name: name.to_string(),
            kind,
        })
    }

    /// Validate the user's typed answer into the field's JSON value.
    ///
    /// # Errors
    ///
    /// The reason the text does not fit the field.
    pub(crate) fn parse_answer(&self, raw: &str) -> Result<Value, String> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err("the answer is empty; use `/elicit decline` to refuse".to_string());
        }
        match &self.kind {
            FieldKind::Text => Ok(Value::String(raw.to_string())),
            FieldKind::Choice(choices) => {
                if choices.iter().any(|choice| choice == raw) {
                    Ok(Value::String(raw.to_string()))
                } else {
                    Err(format!(
                        "`{raw}` is not one of the allowed values ({})",
                        choices.join(", ")
                    ))
                }
            }
            FieldKind::Boolean => match raw.to_ascii_lowercase().as_str() {
                "true" | "yes" | "y" => Ok(Value::Bool(true)),
                "false" | "no" | "n" => Ok(Value::Bool(false)),
                _ => Err(format!("`{raw}` is not a yes/no answer")),
            },
            FieldKind::Integer => raw
                .parse::<i64>()
                .map(|value| json!(value))
                .map_err(|_| format!("`{raw}` is not an integer")),
            FieldKind::Number => raw
                .parse::<f64>()
                .map(|value| json!(value))
                .map_err(|_| format!("`{raw}` is not a number")),
        }
    }
}

/// A one-line `[mcp_elicitation]` row.
pub(crate) fn status_row(text: &str) -> CustomMessage {
    CustomMessage {
        custom_type: MCP_ELICITATION_CUSTOM_TYPE.to_string(),
        content: SessionUserContent::Text(text.to_string()),
        display: true,
        details: None,
        timestamp: 0,
        rest: pa_types::JsonMap::default(),
    }
}

/// The instruction row a waiting request shows.
pub(crate) fn instruction_row(
    request: &ElicitationRequest,
    id: u64,
    field: &AnswerField,
) -> CustomMessage {
    let hint = match &field.kind {
        FieldKind::Text | FieldKind::Integer | FieldKind::Number => {
            format!("`/elicit accept <{}>`", field.name)
        }
        FieldKind::Choice(choices) => format!(
            "`/elicit accept <{}>` (one of: {})",
            field.name,
            choices.join(", ")
        ),
        FieldKind::Boolean => "`/elicit accept yes` or `/elicit accept no`".to_string(),
    };
    let message = if request.message.is_empty() {
        String::new()
    } else {
        format!(" asks: {}", request.message)
    };
    status_row(&format!(
        "[{}]{} — request {id}. Answer with {hint} · `/elicit decline` · `/elicit cancel`",
        request.server, message
    ))
}

/// The `mcp.elicitation` host handler: show the request, wait, and always answer.
///
/// Owns only the pending registry and the row sink, so registration takes `Arc`s
/// and never borrows session state.
pub fn register_mcp_elicitation_handler(
    pending: Arc<PendingElicitations>,
    rows: McpNotificationRowSink,
    usage: Option<McpUsageSink>,
    handlers: &mut HostRequestHandlers,
) {
    register_with_wait(pending, rows, usage, ELICITATION_WAIT, handlers);
}

/// The same handler with an explicit wait, so a test can exercise the timeout
/// without sleeping for two minutes.
pub(crate) fn register_with_wait(
    pending: Arc<PendingElicitations>,
    rows: McpNotificationRowSink,
    usage: Option<McpUsageSink>,
    wait: Duration,
    handlers: &mut HostRequestHandlers,
) {
    handlers.register(
        "mcp.elicitation",
        host_handler(move |payload: HostRequestPayload| {
            let pending = Arc::clone(&pending);
            let rows = Arc::clone(&rows);
            let usage = usage.clone();
            Box::pin(async move {
                let request = parse_request(&payload.data)?;
                let field = match single_field(&request.requested_schema) {
                    Ok(field) => field,
                    Err(reason) => {
                        rows(status_row(&format!(
                            "[{}] elicitation declined: {reason}",
                            request.server
                        )));
                        report(usage.as_ref(), McpUsageKind::ElicitationDeclined);
                        return Ok(declined());
                    }
                };
                let (id, rx) = match pending.open(field.clone()) {
                    Ok(opened) => opened,
                    Err(reason) => {
                        rows(status_row(&format!(
                            "[{}] elicitation declined: {reason}",
                            request.server
                        )));
                        report(usage.as_ref(), McpUsageKind::ElicitationDeclined);
                        return Ok(declined());
                    }
                };
                rows(instruction_row(&request, id, &field));
                // A timeout or a dropped sender is a decline: the server always gets
                // an answer, and the user is told the request lapsed.
                let decision = if let Ok(Ok(decision)) = tokio::time::timeout(wait, rx).await {
                    decision
                } else {
                    pending.release(id);
                    rows(status_row(&format!(
                        "[{}] elicitation request {id} timed out; declined",
                        request.server
                    )));
                    ElicitationDecision::Decline
                };
                let content = match &decision {
                    ElicitationDecision::Accept(value) => {
                        let mut object = serde_json::Map::new();
                        object.insert(field.name.clone(), value.clone());
                        Value::Object(object)
                    }
                    ElicitationDecision::Decline | ElicitationDecision::Cancel => Value::Null,
                };
                rows(status_row(&format!(
                    "[{}] elicitation request {id} {}",
                    request.server,
                    decision.action()
                )));
                report(
                    usage.as_ref(),
                    match &decision {
                        ElicitationDecision::Accept(_) => McpUsageKind::ElicitationAccepted,
                        ElicitationDecision::Decline | ElicitationDecision::Cancel => {
                            McpUsageKind::ElicitationDeclined
                        }
                    },
                );
                Ok(json!({ "action": decision.action(), "content": content }))
            })
        }),
    );
}

/// Report one counter event when the seam is wired.
fn report(usage: Option<&McpUsageSink>, kind: McpUsageKind) {
    if let Some(usage) = usage {
        usage(kind);
    }
}

fn declined() -> Value {
    json!({ "action": "decline", "content": Value::Null })
}

impl super::AgentSessionEngine {
    /// Answer a pending elicitation from the user's `/elicit` line.
    ///
    /// Returns `false` when this engine has no row sink (a pty session, where
    /// no kernel-side elicitation exists): the text then stays a prompt.
    pub(crate) fn answer_elicitation(&self, command: ElicitCommand) -> bool {
        let rows = self
            .mcp_notification_row_sink
            .lock()
            .expect("mcp notification row sink lock")
            .clone();
        let Some(rows) = rows else {
            return false;
        };
        apply_elicit_command(&self.mcp_elicitations, &rows, command);
        true
    }
}

/// Apply one `/elicit` submission: answer the pending request.
///
/// A refused or unusable command is always a visible row; a resolved request's
/// outcome row is written by the handler, which knows the server it answers.
pub fn apply_elicit_command(
    pending: &PendingElicitations,
    rows: &McpNotificationRowSink,
    command: ElicitCommand,
) {
    let answer = match command {
        ElicitCommand::Status => {
            let text = match pending.pending_id() {
                Some(id) => format!("elicitation request {id} is waiting for an answer"),
                None => "no elicitation request is waiting".to_string(),
            };
            rows(status_row(&text));
            return;
        }
        ElicitCommand::Accept(raw) => ElicitationAnswer::Accept(raw),
        ElicitCommand::Decline => ElicitationAnswer::Decline,
        ElicitCommand::Cancel => ElicitationAnswer::Cancel,
    };
    if let Err(reason) = pending.answer(answer) {
        rows(status_row(&format!("elicitation: {reason}")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    type RowLog = Arc<StdMutex<Vec<String>>>;

    fn recorder() -> (McpNotificationRowSink, RowLog) {
        let log: RowLog = Arc::new(StdMutex::new(Vec::new()));
        let sink_rows = Arc::clone(&log);
        let sink: McpNotificationRowSink = Arc::new(move |message: CustomMessage| {
            let text = match &message.content {
                SessionUserContent::Text(text) => text.clone(),
                SessionUserContent::Blocks(_) => String::new(),
            };
            sink_rows.lock().unwrap().push(text);
        });
        (sink, log)
    }

    fn rows_of(log: &RowLog) -> Vec<String> {
        log.lock().unwrap().clone()
    }

    async fn wait_for_row(log: &RowLog, needle: &str) -> Vec<String> {
        for _ in 0..2000 {
            let rows = rows_of(log);
            if rows.iter().any(|row| row.contains(needle)) {
                return rows;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("row {needle:?} never appeared: {:?}", rows_of(log));
    }

    fn text_request() -> Value {
        json!({
            "server": "svc",
            "message": "Your name?",
            "requestedSchema": {
                "type": "object",
                "properties": { "name": { "type": "string" } }
            }
        })
    }

    /// The accept path: the request row carries the exact syntax, the user's
    /// `/elicit accept` resolves it, and the server gets its value.
    #[tokio::test]
    async fn a_slash_command_answers_the_waiting_request() {
        let (sink, log) = recorder();
        let pending = Arc::new(PendingElicitations::default());
        let mut handlers = HostRequestHandlers::default();
        register_mcp_elicitation_handler(
            Arc::clone(&pending),
            Arc::clone(&sink),
            None,
            &mut handlers,
        );
        let call = handlers.get("mcp.elicitation").expect("registered").clone();
        let task = tokio::spawn(call(HostRequestPayload {
            data: text_request(),
        }));
        let rows = wait_for_row(&log, "`/elicit accept <name>`").await;
        assert!(
            rows[0].contains("svc] asks: Your name?"),
            "the row carries the server and its question: {rows:?}"
        );
        assert_eq!(pending.pending_id(), Some(1));
        apply_elicit_command(&pending, &sink, ElicitCommand::Accept("Jev".to_string()));
        assert_eq!(
            task.await.unwrap().unwrap(),
            json!({ "action": "accept", "content": { "name": "Jev" } })
        );
        assert_eq!(pending.pending_id(), None, "the request is resolved once");
        let rows = rows_of(&log);
        assert!(
            rows.iter().any(|row| row.contains("request 1 accept")),
            "the outcome is recorded: {rows:?}"
        );
    }

    /// A wrong answer keeps the request pending so the user can retry.
    #[tokio::test]
    async fn an_answer_that_does_not_fit_keeps_the_request_pending() {
        let (sink, log) = recorder();
        let pending = Arc::new(PendingElicitations::default());
        let mut handlers = HostRequestHandlers::default();
        register_mcp_elicitation_handler(
            Arc::clone(&pending),
            Arc::clone(&sink),
            None,
            &mut handlers,
        );
        let call = handlers.get("mcp.elicitation").expect("registered").clone();
        let request = json!({
            "server": "svc",
            "requestedSchema": {
                "type": "object",
                "properties": { "color": { "type": "string", "enum": ["red", "blue"] } }
            }
        });
        let task = tokio::spawn(call(HostRequestPayload { data: request }));
        wait_for_row(&log, "one of: red, blue").await;
        apply_elicit_command(&pending, &sink, ElicitCommand::Accept("green".to_string()));
        assert_eq!(
            pending.pending_id(),
            Some(1),
            "still waiting after a bad answer"
        );
        let rows = rows_of(&log);
        assert!(
            rows.iter()
                .any(|row| row.contains("`green` is not one of the allowed values")),
            "{rows:?}"
        );
        apply_elicit_command(&pending, &sink, ElicitCommand::Accept("blue".to_string()));
        assert_eq!(
            task.await.unwrap().unwrap(),
            json!({ "action": "accept", "content": { "color": "blue" } })
        );
    }

    /// A schema this surface cannot represent is declined up front, with the reason
    /// visible, and nothing waits for the user.
    #[tokio::test]
    async fn an_unsupported_schema_is_declined_with_a_row() {
        let (sink, log) = recorder();
        let pending = Arc::new(PendingElicitations::default());
        let mut handlers = HostRequestHandlers::default();
        register_mcp_elicitation_handler(
            Arc::clone(&pending),
            Arc::clone(&sink),
            None,
            &mut handlers,
        );
        let call = handlers.get("mcp.elicitation").expect("registered").clone();
        for (schema, reason) in [
            (
                json!({ "type": "object", "properties": { "a": { "type": "string" }, "b": { "type": "boolean" } } }),
                "2 fields",
            ),
            (
                json!({ "type": "object", "properties": { "a": { "type": "object" } } }),
                "is not a value this surface can ask for",
            ),
            (Value::Null, "is not a value this surface can ask for"),
        ] {
            let reply = call(HostRequestPayload {
                data: json!({ "server": "svc", "requestedSchema": schema }),
            })
            .await
            .expect("a decline is a reply, not a failure");
            assert_eq!(reply, json!({ "action": "decline", "content": null }));
            assert_eq!(pending.pending_id(), None);
            let rows = rows_of(&log);
            assert!(
                rows.iter().any(|row| row.contains(reason)),
                "{schema}: {rows:?}"
            );
        }
    }

    /// The no-hang tooth: a request nobody answers is declined on the timeout, and the
    /// user is told it lapsed.
    #[tokio::test]
    async fn a_request_nobody_answers_is_declined_on_the_timeout() {
        let (sink, log) = recorder();
        let pending = Arc::new(PendingElicitations::default());
        let mut handlers = HostRequestHandlers::default();
        register_with_wait(
            Arc::clone(&pending),
            Arc::clone(&sink),
            None,
            Duration::from_millis(20),
            &mut handlers,
        );
        let call = handlers.get("mcp.elicitation").expect("registered").clone();
        let reply = call(HostRequestPayload {
            data: text_request(),
        })
        .await
        .expect("a timeout is a reply, not a failure");
        assert_eq!(reply, json!({ "action": "decline", "content": null }));
        assert_eq!(pending.pending_id(), None, "the slot is released");
        let rows = rows_of(&log);
        assert!(
            rows.iter().any(|row| row.contains("timed out; declined")),
            "{rows:?}"
        );
        // The next request is served, not refused for a slot nobody waits on.
        let _ = call(HostRequestPayload {
            data: text_request(),
        })
        .await
        .expect("the second request is answered too");
        let rows = rows_of(&log);
        assert_eq!(
            rows.iter()
                .filter(|row| row.contains("`/elicit accept <name>`"))
                .count(),
            2,
            "the second request reached its instruction row: {rows:?}"
        );
    }

    /// One request at a time: a second concurrent request is declined rather than
    /// racing the user's single answer.
    #[tokio::test]
    async fn a_second_concurrent_request_is_declined() {
        let (sink, log) = recorder();
        let pending = Arc::new(PendingElicitations::default());
        let mut handlers = HostRequestHandlers::default();
        register_mcp_elicitation_handler(
            Arc::clone(&pending),
            Arc::clone(&sink),
            None,
            &mut handlers,
        );
        let call = handlers.get("mcp.elicitation").expect("registered").clone();
        let first = tokio::spawn(call(HostRequestPayload {
            data: json!({ "server": "one", "requestedSchema": { "type": "string" } }),
        }));
        wait_for_row(&log, "`/elicit accept <value>`").await;
        let second = call(HostRequestPayload {
            data: json!({ "server": "two", "requestedSchema": { "type": "string" } }),
        })
        .await
        .expect("a decline is a reply, not a failure");
        assert_eq!(second, json!({ "action": "decline", "content": null }));
        let rows = rows_of(&log);
        assert!(
            rows.iter()
                .any(|row| row.contains("is still waiting for an answer")),
            "{rows:?}"
        );
        apply_elicit_command(&pending, &sink, ElicitCommand::Decline);
        assert_eq!(first.await.unwrap().unwrap()["action"], "decline");
    }

    /// Both decision paths report exactly one counter kind (the seam the session
    /// counters read), and nothing else travels with it.
    #[tokio::test]
    async fn the_user_decision_reports_one_usage_kind() {
        let reported: Arc<StdMutex<Vec<McpUsageKind>>> = Arc::new(StdMutex::new(Vec::new()));
        let usage: McpUsageSink = {
            let reported = Arc::clone(&reported);
            Arc::new(move |kind| reported.lock().unwrap().push(kind))
        };
        let (sink, log) = recorder();
        let pending = Arc::new(PendingElicitations::default());
        let mut handlers = HostRequestHandlers::default();
        register_with_wait(
            Arc::clone(&pending),
            Arc::clone(&sink),
            Some(usage),
            Duration::from_millis(20),
            &mut handlers,
        );
        let call = handlers.get("mcp.elicitation").expect("registered").clone();
        let accepted = tokio::spawn(call(HostRequestPayload {
            data: text_request(),
        }));
        wait_for_row(&log, "`/elicit accept <name>`").await;
        apply_elicit_command(&pending, &sink, ElicitCommand::Accept("Jev".to_string()));
        accepted.await.unwrap().unwrap();
        // Nobody answers this one: the timeout is the second, declined path.
        let timed_out = call(HostRequestPayload {
            data: text_request(),
        })
        .await
        .expect("a timeout is a reply");
        assert_eq!(timed_out["action"], "decline");
        assert_eq!(
            reported.lock().unwrap().clone(),
            vec![
                McpUsageKind::ElicitationAccepted,
                McpUsageKind::ElicitationDeclined,
            ]
        );
    }

    /// The answer syntax is the whole command surface: unknown verbs and bare words
    /// stay prompts.
    #[test]
    fn only_the_elicit_verb_forms_are_commands() {
        assert_eq!(parse_elicit_command("/elicit"), Some(ElicitCommand::Status));
        assert_eq!(
            parse_elicit_command("  /elicit  "),
            Some(ElicitCommand::Status)
        );
        assert_eq!(
            parse_elicit_command("/elicit accept blue"),
            Some(ElicitCommand::Accept("blue".to_string()))
        );
        assert_eq!(
            parse_elicit_command("/elicit   accept   some text "),
            Some(ElicitCommand::Accept("some text".to_string()))
        );
        assert_eq!(
            parse_elicit_command("/elicit decline"),
            Some(ElicitCommand::Decline)
        );
        assert_eq!(
            parse_elicit_command("/elicit cancel"),
            Some(ElicitCommand::Cancel)
        );
        assert_eq!(parse_elicit_command("/elicitfoo"), None);
        assert_eq!(parse_elicit_command("/elicit later"), None);
        assert_eq!(parse_elicit_command("/elicit decline now"), None);
        assert_eq!(parse_elicit_command("hello /elicit"), None);
    }

    fn bare_engine(dir: &std::path::Path) -> super::super::AgentSessionEngine {
        let agent_dir = dir.join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        super::super::AgentSessionEngine::new(super::super::AgentEngineConfig {
            cwd: dir.to_path_buf(),
            agent_dir,
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap()
    }

    /// A pty session has no row sink (nothing can be pending): `/elicit` must stay an
    /// ordinary prompt there. A worker session with the sink answers it.
    #[test]
    fn a_session_without_a_row_sink_does_not_claim_elicit() {
        let dir = tempfile::TempDir::new().unwrap();
        let engine = bare_engine(dir.path());
        assert!(!engine.answer_elicitation(ElicitCommand::Status));
        let (sink, log) = recorder();
        engine.set_mcp_notification_row_sink(sink);
        assert!(engine.answer_elicitation(ElicitCommand::Status));
        assert_eq!(
            rows_of(&log),
            vec!["no elicitation request is waiting".to_string()]
        );
    }

    /// The prompt path routes `/elicit` before admission: it answers the pending
    /// request and never starts a model turn (this engine has no provider, so a turn
    /// would fail loudly instead of answering).
    #[test]
    fn the_prompt_path_answers_elicit_without_a_model_turn() {
        let dir = tempfile::TempDir::new().unwrap();
        let engine = bare_engine(dir.path());
        let (sink, log) = recorder();
        engine.set_mcp_notification_row_sink(sink);
        let field = AnswerField {
            name: "name".to_string(),
            kind: FieldKind::Text,
        };
        let (_id, mut rx) = engine.mcp_elicitations.open(field).unwrap();
        let mut events = Vec::new();
        crate::agent_engine::tests::admit(&engine, "/elicit accept Jev".to_string(), &mut events);
        assert!(
            matches!(
                events.as_slice(),
                [crate::engine::EngineEvent::Done(Ok(()))]
            ),
            "an elicitation answer is not a turn: {events:?}"
        );
        assert_eq!(
            rx.try_recv().expect("the request was answered"),
            ElicitationDecision::Accept(Value::String("Jev".to_string()))
        );
        assert_eq!(engine.mcp_elicitations.pending_id(), None);
        assert!(
            rows_of(&log).is_empty(),
            "the outcome row belongs to the waiting handler: {:?}",
            rows_of(&log)
        );
    }
}
