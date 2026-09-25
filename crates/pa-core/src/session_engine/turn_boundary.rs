//! The turn-boundary host-request surface: `model.info`, `compact.*`, and
//! `refine.*` — the kernel-side `refine`/`compact` skill modules reach them
//! through `rlm.host_request`. Port of the `handleCompactHostRequest` /
//! `handleRefineHostRequest` / `model.info` handlers of core/agent-session.ts.
//!
//! Like the TS handlers, `compact.run`/`refine.run` only SCHEDULE: a cell runs
//! inside the active turn, so executing compaction or refinement immediately
//! would abort the requesting run. The pending request is stored here and
//! the turn loop consumes it after the turn settles (the TS `_checkCompaction`
//! / `_consumePendingRequestedRefine` boundary; the daemon's turn loop is the
//! Rust consumer).

use std::sync::Arc;

use pa_agent::agent::Agent;
use pa_types::session::FileEntry;
use serde_json::{json, Value};
use tokio::sync::{Mutex, OnceCell};

use crate::kernel::shared::{host_handler, HostRequestHandlers};
use crate::session::manager::SessionManager;

use pa_types::usage::{calculate_context_tokens, estimate_tokens, valid_assistant_usage};

use super::compact_session::{prepare_compaction, CompactSkip};
use super::engine::SessionEngine;

/// A scheduled compaction (kernel `compact.run`).
#[derive(Debug, Clone, PartialEq)]
pub struct PendingCompaction {
    pub instructions: Option<String>,
}

/// A scheduled refinement (kernel `refine.run`).
#[derive(Debug, Clone, PartialEq)]
pub struct PendingRefine {
    pub instructions: Option<String>,
    pub global: bool,
}

/// The model facts `model.info` reports (TS answers nulls when the session
/// has no model; the Rust engine always resolves one).
#[derive(Debug, Clone, PartialEq)]
pub struct ModelInfo {
    pub id: String,
    pub provider: String,
    /// Input modalities (empty when the resolved model did not declare
    /// any, e.g. harness-converted minimal models).
    pub input: Vec<pa_types::ai::ModelInput>,
}

/// The runtime the handlers read once the session is assembled: the agent
/// loop (turn-active probe), the shared persistence (usage estimate,
/// compaction preparation), the resolved model's context window, and the
/// model facts `model.info` reports. Handlers are registered before the
/// loop exists; `create_session` binds this before returning.
pub struct TurnBoundaryRuntime {
    pub agent: Arc<Agent>,
    pub session: Arc<Mutex<SessionManager>>,
    /// The resolved model's context window; `None` when unknown (compact
    /// status answers null tokens then).
    pub context_window: Option<u64>,
    pub model_info: ModelInfo,
}

/// Estimated context usage (TS `getContextUsage`): the last valid assistant
/// usage plus trailing message estimates; `tokens`/`percent` are `None`
/// right after a compaction without a usable post-compaction usage.
#[derive(Debug, Clone, PartialEq)]
pub struct ContextUsage {
    pub tokens: Option<u64>,
    pub context_window: u64,
    pub percent: Option<f64>,
}

/// The turn-boundary state: pending requests plus the late-bound runtime.
/// Shared between the kernel host bridge (scheduling side) and the turn
/// loop (consuming side); build it in `Arc` form so registered host handlers
/// observe the same cells.
#[derive(Default)]
pub struct TurnBoundaryRequests {
    runtime: OnceCell<Arc<TurnBoundaryRuntime>>,
    compaction: Mutex<Option<PendingCompaction>>,
    refine: Mutex<Option<PendingRefine>>,
}

impl TurnBoundaryRequests {
    pub fn new() -> Self {
        Self::default()
    }

    /// Bind the assembled session runtime (first bind wins).
    pub fn bind(&self, runtime: TurnBoundaryRuntime) {
        let _ = self.runtime.set(Arc::new(runtime));
    }

    /// The bound runtime (`None` until the session is assembled).
    pub fn bound(&self) -> Option<Arc<TurnBoundaryRuntime>> {
        self.runtime.get().cloned()
    }

    /// Take the pending compaction (the turn boundary consumes it once).
    pub async fn take_compaction(&self) -> Option<PendingCompaction> {
        self.compaction.lock().await.take()
    }

    /// Schedule a compaction for the next turn boundary (the `compact.run`
    /// write path): the request's instructions win over a pending one's,
    /// an absent instruction keeps what was already scheduled (TS
    /// `handleCompactionHostRequest`'s slot assignment).
    pub async fn schedule_compaction(&self, instructions: Option<String>) {
        let mut slot = self.compaction.lock().await;
        let merged = PendingCompaction {
            instructions: instructions.or_else(|| {
                slot.as_ref()
                    .and_then(|current| current.instructions.clone())
            }),
        };
        *slot = Some(merged);
    }

    /// Whether a compaction is scheduled (TS `compact.status` `scheduled`).
    pub async fn compaction_scheduled(&self) -> bool {
        self.compaction.lock().await.is_some()
    }

    /// The scheduled compaction without consuming it: the turn-boundary
    /// consumer reads the pending instructions to announce the run (TS
    /// `_runAutoCompaction`'s `compaction_start` carries them) before it
    /// takes the request.
    pub async fn scheduled_compaction(&self) -> Option<PendingCompaction> {
        self.compaction.lock().await.clone()
    }

    /// Take the pending refinement (the turn boundary consumes it once).
    pub async fn take_refine(&self) -> Option<PendingRefine> {
        self.refine.lock().await.take()
    }

    /// Schedule a refinement for the next turn boundary (the `refine.run`
    /// write path's slot assignment). The caller owns the merge contract
    /// (an absent field keeps the pending request's value), exactly like
    /// the host handler does before it stores the merged request.
    pub async fn schedule_refine(&self, pending: PendingRefine) {
        *self.refine.lock().await = Some(pending);
    }

    /// Drop both pending requests (TS `_checkCompaction` abort arm: an
    /// aborted turn never services them, and a stale request must not leak
    /// into the next turn).
    pub async fn clear_pending(&self) {
        *self.compaction.lock().await = None;
        *self.refine.lock().await = None;
    }

    /// Whether a refinement is queued (TS `refine.status` `pending`).
    pub async fn refine_pending(&self) -> bool {
        self.refine.lock().await.is_some()
    }

    /// Register `model.info` (always present, like the TS `_hostHandlers`
    /// default map).
    pub fn register_model_info_handler(
        self: &Arc<Self>,
        handlers: &mut HostRequestHandlers,
        model_info: ModelInfo,
    ) {
        // Weak, upgraded at request time: the kernel holds these handlers
        // for its whole life and its host graph reaches the session, so a
        // strong capture here loops the ownership graph and pins a dropped
        // session's kernel process until the process exits. The engine owns
        // this requests object (see SessionEngine::turn_boundary).
        let requests = Arc::downgrade(self);
        handlers.register(
            "model.info",
            host_handler(move |_payload| {
                let requests = requests.clone();
                let model_info = model_info.clone();
                Box::pin(async move {
                    // The bound runtime is authoritative once the session
                    // is live; the registration-time facts cover pre-bind
                    // probes AND a dropped session (model.info always
                    // answers, like the TS default map).
                    let model_info = requests
                        .upgrade()
                        .and_then(|requests| {
                            requests.bound().map(|runtime| runtime.model_info.clone())
                        })
                        .unwrap_or(model_info);
                    Ok(json!({
                        "id": model_info.id,
                        "provider": model_info.provider,
                        "input": model_info.input.iter().map(|input| match input {
                            pa_types::ai::ModelInput::Text => "text",
                            pa_types::ai::ModelInput::Image => "image",
                        }).collect::<Vec<&str>>(),
                    }))
                })
            }),
        );
    }

    /// Register `compact.status`/`compact.run`. Gated by the TS
    /// `_includeCompactSkill` equivalent (the compaction `agentCallable`
    /// setting); `create_session` decides and passes the resolved
    /// keep-recent budget.
    pub fn register_compact_handlers(
        self: &Arc<Self>,
        handlers: &mut HostRequestHandlers,
        keep_recent_tokens: u64,
    ) {
        let requests = Arc::downgrade(self);
        handlers.register(
            "compact.status",
            host_handler(move |_payload| {
                let requests = requests.clone();
                Box::pin(async move {
                    let Some(requests) = requests.upgrade() else {
                        return Err(anyhow::anyhow!(
                            "the session ended before the request could be served"
                        ));
                    };
                    let usage = match requests.bound() {
                        Some(runtime) => {
                            let entries = runtime.session.lock().await.retained_entries().to_vec();
                            context_usage(&entries, runtime.context_window)
                        }
                        None => None,
                    };
                    let scheduled = requests.compaction_scheduled().await;
                    let (tokens, window, percent) = match usage {
                        Some(usage) => (
                            usage.tokens.map_or(Value::Null, Value::from),
                            Value::from(usage.context_window),
                            usage.percent.map_or(Value::Null, Value::from),
                        ),
                        None => (Value::Null, Value::Null, Value::Null),
                    };
                    Ok(json!({
                        "tokens": tokens,
                        "context_window": window,
                        "percent": percent,
                        "scheduled": scheduled,
                    }))
                })
            }),
        );
        let requests = Arc::downgrade(self);
        handlers.register(
            "compact.run",
            host_handler(move |payload| {
                let requests = requests.clone();
                Box::pin(async move {
                    let Some(requests) = requests.upgrade() else {
                        return Err(anyhow::anyhow!("the session ended before the request could be served"));
                    };
                    let instructions = string_field(
                        &payload.data,
                        "instructions",
                        "compact.run instructions must be a string when provided",
                    )?;
                    let Some(runtime) = requests.bound() else {
                        return Ok(no_active_turn(
                            "no active turn; compaction can only be requested while a turn is running",
                        ));
                    };
                    let state = runtime.agent.state().await;
                    if !state.is_streaming {
                        return Ok(no_active_turn(
                            "no active turn; compaction can only be requested while a turn is running",
                        ));
                    }
                    // TS `prepareCompaction`: only schedule a compaction
                    // that has history to summarize.
                    let entries = runtime.session.lock().await.retained_entries().to_vec();
                    if let Some(reason) =
                        compaction_request_skip_reason(&entries, keep_recent_tokens)
                    {
                        return Ok(json!({ "scheduled": false, "reason": reason }));
                    }
                    requests.schedule_compaction(instructions).await;
                    Ok(json!({
                        "scheduled": true,
                        "note": "Compaction runs when the current turn ends; you resume automatically afterwards. Continue working normally.",
                    }))
                })
            }),
        );
    }

    /// Register `refine.status`/`refine.run`. Gated by the TS
    /// `_autoRefineAllowedForSession` equivalent (depth 0 with a local
    /// harness state dir); `create_session` decides.
    pub fn register_refine_handlers(self: &Arc<Self>, handlers: &mut HostRequestHandlers) {
        let requests = Arc::downgrade(self);
        handlers.register(
            "refine.status",
            host_handler(move |_payload| {
                let requests = requests.clone();
                Box::pin(async move {
                    let Some(requests) = requests.upgrade() else {
                        return Err(anyhow::anyhow!(
                            "the session ended before the request could be served"
                        ));
                    };
                    let pending = requests.refine_pending().await;
                    // The Rust turn-boundary consumption runs refinement
                    // synchronously between turns, so a cell never observes
                    // it in flight (the TS background-planning path this
                    // flag covers is not ported).
                    Ok(json!({ "pending": pending, "in_flight": false }))
                })
            }),
        );
        let requests = Arc::downgrade(self);
        handlers.register(
            "refine.run",
            host_handler(move |payload| {
                let requests = requests.clone();
                Box::pin(async move {
                    let Some(requests) = requests.upgrade() else {
                        return Err(anyhow::anyhow!("the session ended before the request could be served"));
                    };
                    let instructions = string_field(
                        &payload.data,
                        "instructions",
                        "refine.run instructions must be a string when provided",
                    )?;
                    let global = match payload.data.get("global") {
                        None | Some(Value::Null) => None,
                        Some(Value::Bool(value)) => Some(*value),
                        Some(_) => anyhow::bail!(
                            "refine.run global must be a boolean when provided"
                        ),
                    };
                    let Some(runtime) = requests.bound() else {
                        return Ok(no_active_turn(
                            "no active turn; refine can only be requested while a turn is running",
                        ));
                    };
                    let state = runtime.agent.state().await;
                    if !state.is_streaming {
                        return Ok(no_active_turn(
                            "no active turn; refine can only be requested while a turn is running",
                        ));
                    }
                    let mut slot = requests.refine.lock().await;
                    let merged = match slot.as_ref() {
                        Some(current) => PendingRefine {
                            instructions: instructions
                                .or_else(|| current.instructions.clone()),
                            global: global.unwrap_or(current.global),
                        },
                        None => PendingRefine {
                            instructions,
                            global: global.unwrap_or(false),
                        },
                    };
                    *slot = Some(merged);
                    Ok(json!({
                        "scheduled": true,
                        "note": "Refinement runs when the current turn ends; applied edits are appended to your context as a refinement notice and you resume automatically. Continue working normally.",
                    }))
                })
            }),
        );
    }
}

/// One turn-boundary consumption: the outcomes of the pending requests the
/// host runtime persists and broadcasts (it owns the wire transport and the
/// durable session file). `Err` rows are failures surfaced like the TS
/// failed-compaction / `refine_failed` events.
#[derive(Debug)]
pub struct TurnBoundaryConsumption {
    /// A consumed compaction request and its `/compact` outcome.
    pub compaction: Option<anyhow::Result<super::compact_session::CompactOutcome>>,
    /// A consumed refinement request and its run result.
    pub refinement: Option<anyhow::Result<crate::refinement::RefinementResult>>,
}

impl SessionEngine {
    /// Consume a pending model-requested compaction at a turn boundary (the
    /// TS `_checkCompaction` requested arm, which TS reaches only when the
    /// overflow arm did not fire — the overflow run consumes the request
    /// itself): taken regardless of outcome, so a failed run is not silently
    /// re-run on the next boundary. `abort` cancels the run (TS
    /// `_runAutoCompaction`'s auto controller signal): an aborted compaction
    /// surfaces as the abort marker error for the consumer to map to its
    /// cancelled outcome.
    pub async fn consume_pending_compaction(
        &self,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        abort: Option<&pa_agent::abort::AbortSignal>,
    ) -> Option<anyhow::Result<super::compact_session::CompactOutcome>> {
        let pending = self.turn_boundary.take_compaction().await?;
        let compact = async {
            self.session
                .compact(pending.instructions.as_deref(), model, api_key, abort)
                .await
        };
        Some(match abort {
            // An in-flight abort drops the summarizer request (TS cancels
            // the provider stream through the signal); the abort surfaces
            // as the marker error for the consumer to map to its cancelled
            // outcome. The refinement is not raced — TS `abortCompaction`
            // never aborts it.
            Some(signal) => match pa_agent::abort::race_with_abort(compact, signal).await {
                Ok(inner) => inner,
                Err(error) => Err(error),
            },
            None => compact.await,
        })
    }

    /// Consume a pending model-requested refinement at a turn boundary (TS
    /// `_consumePendingRequestedRefine`, which runs after `_checkCompaction`
    /// returns): taken regardless of outcome, so a failed run is not
    /// silently re-run on the next boundary.
    pub async fn consume_pending_refinement(
        &self,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        global_harness_dir: std::path::PathBuf,
    ) -> Option<anyhow::Result<crate::refinement::RefinementResult>> {
        let pending = self.turn_boundary.take_refine().await?;
        let options = super::refine::RefineOptions {
            global: pending.global,
            instructions: pending.instructions,
            rollback_id: None,
        };
        Some(
            self.session
                .refine(
                    &options,
                    super::refine::RefinementSource::SelfRefine,
                    model,
                    api_key,
                    global_harness_dir,
                )
                .await,
        )
    }

    /// Consume pending turn-boundary requests after a settled turn: run the
    /// requested compaction first, then the refinement. The pieces are also
    /// exposed separately (`consume_pending_compaction` /
    /// `consume_pending_refinement`) for hosts that mirror the TS
    /// `_checkCompaction` sequencing exactly (the overflow arm interleaves
    /// with the requested arms).
    pub async fn consume_turn_boundary_requests(
        &self,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        global_harness_dir: std::path::PathBuf,
        abort: Option<&pa_agent::abort::AbortSignal>,
    ) -> TurnBoundaryConsumption {
        let mut consumption = TurnBoundaryConsumption {
            compaction: None,
            refinement: None,
        };
        consumption.compaction = self
            .consume_pending_compaction(model, api_key.clone(), abort)
            .await;
        consumption.refinement = self
            .consume_pending_refinement(model, api_key, global_harness_dir)
            .await;
        consumption
    }
}

/// An optional string field with the exact TS validation message on a
/// non-string value; `None` for absent/null.
fn string_field(data: &Value, key: &str, error: &'static str) -> anyhow::Result<Option<String>> {
    match data.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => anyhow::bail!("{error}"),
    }
}

/// The `{ scheduled: false, reason }` shape the no-active-turn branch
/// returns (identical for compact.run and refine.run).
fn no_active_turn(reason: &'static str) -> Value {
    json!({ "scheduled": false, "reason": reason })
}

/// The `compact.run` reason for a session that cannot prepare a compaction
/// (TS `prepareCompaction` returning undefined; the handler maps it to the
/// short reasons, distinct from the `/compact` skip message).
fn compaction_request_skip_reason(
    entries: &[FileEntry],
    keep_recent_tokens: u64,
) -> Option<&'static str> {
    prepare_compaction(entries, keep_recent_tokens)
        .err()
        .map(CompactSkip::request_reason)
}

/// Estimated context usage over typed session entries (TS `getContextUsage`
/// over `estimateContextTokens`): the last valid assistant usage anchors
/// the estimate; messages after it are added with the chars/4 heuristic.
/// `None` when the context window is unknown; `tokens`/`percent` `None`
/// right after a compaction without a usable post-compaction usage.
///
/// # Panics
///
/// The `expect` on the anchoring usage cannot fire: the index came from a
/// search restricted to messages with a valid usage.
pub fn context_usage(entries: &[FileEntry], context_window: Option<u64>) -> Option<ContextUsage> {
    let context_window = context_window.filter(|window| *window > 0)?;

    // The latest compaction entry on the branch, if any (TS
    // `getLatestCompactionEntry`): only usage from an assistant that
    // responded after the compaction boundary is trustworthy.
    if let Some(compaction_index) = entries
        .iter()
        .rposition(|entry| matches!(entry, FileEntry::Compaction { .. }))
    {
        let post_compaction_usage = entries[compaction_index + 1..]
            .iter()
            .filter_map(message_value)
            .find_map(|message| valid_assistant_usage(&message));
        let usable =
            post_compaction_usage.is_some_and(|usage| calculate_context_tokens(&usage) > 0);
        if !usable {
            return Some(ContextUsage {
                tokens: None,
                context_window,
                percent: None,
            });
        }
    }

    let messages: Vec<Value> = entries.iter().filter_map(message_value).collect();
    let mut tokens = 0u64;
    match messages
        .iter()
        .rposition(|message| valid_assistant_usage(message).is_some())
    {
        Some(last_usage_index) => {
            let usage = valid_assistant_usage(&messages[last_usage_index]).expect("checked");
            tokens += calculate_context_tokens(&usage);
            tokens += messages[last_usage_index + 1..]
                .iter()
                .map(estimate_tokens)
                .sum::<u64>();
        }
        None => {
            tokens += messages.iter().map(estimate_tokens).sum::<u64>();
        }
    }
    let percent = tokens as f64 / context_window as f64 * 100.0;
    Some(ContextUsage {
        tokens: Some(tokens),
        context_window,
        percent: Some(percent),
    })
}

/// A message entry as raw JSON (the shared usage helpers read the wire shape).
fn message_value(entry: &FileEntry) -> Option<Value> {
    match entry {
        FileEntry::Message { message, .. } => serde_json::to_value(message).ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::shared::{HostRequestHandlers, HostRequestPayload};
    use crate::session::manager::SessionManager;
    use crate::session_engine::tool_bridge::bridge_tool;
    use crate::tools::tool_definition::ToolDefinition;
    use pa_agent::agent::{Agent, AgentInitialState, AgentOptions};
    use pa_agent::scripted::ScriptedProvider;
    use pa_agent::types::ThinkingLevel;
    use pa_types::ai::{
        AssistantContentBlock, AssistantMessage, StopReason, TextContent, Usage, UserContent,
    };
    use pa_types::session::AgentMessage as SessionMessage;

    fn payload(data: Value) -> HostRequestPayload {
        HostRequestPayload {
            data,
            cell_source_code: None,
        }
    }

    fn model_info() -> ModelInfo {
        ModelInfo {
            id: "faux-1".to_string(),
            provider: "faux".to_string(),
            input: vec![pa_types::ai::ModelInput::Text],
        }
    }

    fn agent_model() -> pa_agent::types::Model {
        pa_agent::types::Model {
            id: "faux-1".to_string(),
            name: "Faux".to_string(),
            api: "test".to_string(),
            provider: "faux".to_string(),
            base_url: "http://localhost".to_string(),
            reasoning: false,
            cost: pa_agent::types::UsageCost::default(),
            context_window: 100_000,
            max_tokens: 1_000,
        }
    }

    fn user_entry(text: &str) -> SessionMessage {
        SessionMessage::User(pa_types::ai::UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 1,
            rest: serde_json::Map::default(),
        })
    }

    fn assistant_entry(text: &str) -> SessionMessage {
        SessionMessage::Assistant(AssistantMessage {
            content: vec![AssistantContentBlock::Text(TextContent {
                text: text.to_string(),
                text_signature: None,
                rest: serde_json::Map::default(),
            })],
            api: "test".to_string(),
            provider: "faux".to_string(),
            model: "faux-1".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage {
                input: 40,
                output: 10,
                cache_read: 0,
                cache_write: 0,
                total_tokens: 50,
                cost: pa_agent::types::UsageCost::default(),
            },
            stop_reason: StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 1,
            rest: serde_json::Map::default(),
        })
    }

    /// A persisted session manager with a small conversation to summarize
    /// (`end_with_compaction` flips it into the `already compacted` shape).
    fn session_with_history(end_with_compaction: bool) -> SessionManager {
        let dir = tempfile::TempDir::new().unwrap();
        let session_dir = dir.path().join("session");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut session = SessionManager::in_memory(dir.path());
        session.materialize_session_file(Some(session_dir));
        for text in ["alpha task", "beta task", "gamma task"] {
            session.append_message(user_entry(text)).unwrap();
            session
                .append_message(assistant_entry(&format!("{text} done")))
                .unwrap();
        }
        if end_with_compaction {
            let first_kept = session.get_all_entries()[1]
                .id()
                .unwrap_or_default()
                .to_string();
            session
                .append_compaction(pa_types::session::CompactionEntry {
                    summary: "summary".to_string(),
                    first_kept_entry_id: first_kept,
                    tokens_before: 10,
                    ..Default::default()
                })
                .unwrap();
        }
        session
    }

    impl SessionManager {
        /// Strip the conversation entries (the fresh-session prepare case).
        fn without_history(mut self) -> Self {
            let dir = tempfile::TempDir::new().unwrap();
            let session_dir = dir.path().join("session");
            std::fs::create_dir_all(&session_dir).unwrap();
            self = SessionManager::in_memory(dir.path());
            self.materialize_session_file(Some(session_dir));
            self
        }
    }

    fn registered(requests: &Arc<TurnBoundaryRequests>) -> HostRequestHandlers {
        let mut handlers = HostRequestHandlers::default();
        requests.register_model_info_handler(&mut handlers, model_info());
        // A tiny keep-recent budget: a short conversation has history to
        // summarize above it.
        requests.register_compact_handlers(&mut handlers, 1);
        requests.register_refine_handlers(&mut handlers);
        handlers
    }

    fn handler(
        handlers: &HostRequestHandlers,
        request_type: &str,
    ) -> crate::kernel::shared::HostHandlerFn {
        handlers.get(request_type).expect("registered").clone()
    }

    #[tokio::test]
    async fn model_info_reports_the_bound_model() {
        let requests = Arc::new(TurnBoundaryRequests::new());
        let handlers = registered(&requests);
        // Before the runtime binds, the registration-time facts answer.
        let response = handler(&handlers, "model.info")(payload(json!({})))
            .await
            .unwrap();
        assert_eq!(response["id"], "faux-1");
        assert_eq!(response["provider"], "faux");
        assert_eq!(response["input"], json!(["text"]));
        // A bound runtime stays authoritative.
        let session = Arc::new(Mutex::new(SessionManager::in_memory(std::path::Path::new(
            "/tmp",
        ))));
        let agent = Arc::new(Agent::new(AgentOptions {
            initial_state: AgentInitialState {
                system_prompt: Some("s".to_string()),
                model: Some(agent_model()),
                thinking_level: Some(ThinkingLevel::Off),
                tools: None,
                messages: None,
            },
            stream_fn: None,
            ..Default::default()
        }));
        requests.bind(TurnBoundaryRuntime {
            agent,
            session,
            context_window: Some(100_000),
            model_info: ModelInfo {
                id: "other-1".to_string(),
                provider: "other".to_string(),
                input: Vec::new(),
            },
        });
        let response = handler(&handlers, "model.info")(payload(json!({})))
            .await
            .unwrap();
        assert_eq!(response["id"], "other-1");
        assert_eq!(response["provider"], "other");
        assert_eq!(response["input"], json!([]));
    }

    #[tokio::test]
    async fn compact_run_validates_and_reports_no_active_turn() {
        let requests = Arc::new(TurnBoundaryRequests::new());
        let handlers = registered(&requests);
        // Non-string instructions error with the exact TS message.
        let error = handler(&handlers, "compact.run")(payload(json!({
            "instructions": 5
        })))
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "compact.run instructions must be a string when provided"
        );
        // Without a bound runtime there is no turn to schedule against.
        let response = handler(&handlers, "compact.run")(payload(json!({})))
            .await
            .unwrap();
        assert_eq!(response["scheduled"], false);
        assert_eq!(
            response["reason"],
            "no active turn; compaction can only be requested while a turn is running"
        );
        // An idle agent answers the same way, and status stays clear.
        let session = Arc::new(Mutex::new(session_with_history(false)));
        let agent = Arc::new(Agent::new(AgentOptions {
            initial_state: AgentInitialState {
                system_prompt: Some("s".to_string()),
                model: Some(agent_model()),
                thinking_level: Some(ThinkingLevel::Off),
                tools: None,
                messages: None,
            },
            stream_fn: None,
            ..Default::default()
        }));
        requests.bind(TurnBoundaryRuntime {
            agent,
            session,
            context_window: Some(100_000),
            model_info: model_info(),
        });
        let response = handler(&handlers, "compact.run")(payload(json!({})))
            .await
            .unwrap();
        assert_eq!(response["scheduled"], false);
        let status = handler(&handlers, "compact.status")(payload(json!({})))
            .await
            .unwrap();
        assert_eq!(status["scheduled"], false);
    }

    #[tokio::test]
    async fn compact_run_prepare_skips_report_the_ts_reasons() {
        for (case, expected) in [
            // A branch ending in a compaction has nothing new to summarize.
            (session_with_history(true), "already compacted"),
            // A fresh session has no summarizable history.
            (
                session_with_history(false).without_history(),
                "session is too short to compact",
            ),
        ] {
            // A fresh request cell per case: the runtime binds once.
            let requests = Arc::new(TurnBoundaryRequests::new());
            registered(&requests);
            let session = Arc::new(Mutex::new(case));
            let provider = Arc::new(ScriptedProvider::new(agent_model()));
            provider.push_tool_call_turn(None, vec![("call-1", "probe", json!({}))]);
            provider.push_text_turn("done");
            let probe = probe_tool(&requests, "probe", "compact.run", json!({}));
            let agent = Arc::new(Agent::new(AgentOptions {
                initial_state: AgentInitialState {
                    system_prompt: Some("s".to_string()),
                    model: Some(agent_model()),
                    thinking_level: Some(ThinkingLevel::Off),
                    tools: Some(vec![probe.tool.clone()]),
                    messages: None,
                },
                stream_fn: Some(provider.stream_fn()),
                ..Default::default()
            }));
            requests.bind(TurnBoundaryRuntime {
                agent,
                session,
                context_window: Some(100_000),
                model_info: model_info(),
            });
            // The empty-history case: strip the conversation entries (the
            // handler sees them through the bound session).
            let agent = requests.bound().expect("bound").agent.clone();
            agent.prompt("run the probe tool").await.unwrap();
            agent.wait_for_idle().await;
            let response = probe.result().await;
            assert_eq!(response["scheduled"], false, "case={expected}");
            assert_eq!(response["reason"], expected);
            // Nothing was scheduled.
            assert!(requests.take_compaction().await.is_none());
        }
    }

    #[tokio::test]
    async fn compact_run_schedules_inside_a_tool_call_and_status_sees_it() {
        let requests = Arc::new(TurnBoundaryRequests::new());
        let handlers = registered(&requests);
        let session = Arc::new(Mutex::new(session_with_history(false)));
        let provider = Arc::new(ScriptedProvider::new(agent_model()));
        provider.push_tool_call_turn(None, vec![("call-1", "probe", json!({}))]);
        provider.push_text_turn("done");
        let probe = probe_tool(
            &requests,
            "probe",
            "compact.run",
            json!({ "instructions": "keep the failing test names" }),
        );
        let agent = Arc::new(Agent::new(AgentOptions {
            initial_state: AgentInitialState {
                system_prompt: Some("s".to_string()),
                model: Some(agent_model()),
                thinking_level: Some(ThinkingLevel::Off),
                tools: Some(vec![probe.tool.clone()]),
                messages: None,
            },
            stream_fn: Some(provider.stream_fn()),
            ..Default::default()
        }));
        requests.bind(TurnBoundaryRuntime {
            agent,
            session,
            context_window: Some(100_000),
            model_info: model_info(),
        });
        let agent = requests.bound().expect("bound").agent.clone();
        agent.prompt("run the probe tool").await.unwrap();
        agent.wait_for_idle().await;

        // The handler ran inside the tool call (mid-turn) and scheduled.
        let response = probe.result().await;
        assert_eq!(response["scheduled"], true);
        assert_eq!(
            response["note"],
            "Compaction runs when the current turn ends; you resume automatically afterwards. Continue working normally."
        );
        // compact.status reports the estimate over the session entries and
        // the scheduled flag (the estimate is the chars/4 sum: no usage).
        let status = handler(&handlers, "compact.status")(payload(json!({})))
            .await
            .unwrap();
        assert_eq!(status["scheduled"], true);
        assert_eq!(status["context_window"], 100_000);
        assert!(status["tokens"].as_u64().unwrap() > 0, "{status}");
        assert!(status["percent"].as_f64().unwrap() > 0.0, "{status}");
        // The boundary takes the request with its instructions.
        assert_eq!(
            requests.take_compaction().await,
            Some(PendingCompaction {
                instructions: Some("keep the failing test names".to_string())
            })
        );
        // Taking once: the request is consumed.
        assert!(requests.take_compaction().await.is_none());
    }

    #[tokio::test]
    async fn refine_run_and_status_round_trip_inside_a_tool_call() {
        let requests = Arc::new(TurnBoundaryRequests::new());
        let handlers = registered(&requests);
        let session = Arc::new(Mutex::new(session_with_history(false)));
        let provider = Arc::new(ScriptedProvider::new(agent_model()));
        provider.push_tool_call_turn(None, vec![("call-1", "probe", json!({}))]);
        provider.push_text_turn("done");
        let probe = probe_tool(
            &requests,
            "probe",
            "refine.run",
            json!({ "instructions": "create a memory about the failing gate", "global": true }),
        );
        let agent = Arc::new(Agent::new(AgentOptions {
            initial_state: AgentInitialState {
                system_prompt: Some("s".to_string()),
                model: Some(agent_model()),
                thinking_level: Some(ThinkingLevel::Off),
                tools: Some(vec![probe.tool.clone()]),
                messages: None,
            },
            stream_fn: Some(provider.stream_fn()),
            ..Default::default()
        }));
        requests.bind(TurnBoundaryRuntime {
            agent,
            session,
            context_window: Some(100_000),
            model_info: model_info(),
        });
        // refine.status before the turn: not pending, never in flight (the
        // consumption runs synchronously between turns).
        let status = handler(&handlers, "refine.status")(payload(json!({})))
            .await
            .unwrap();
        assert_eq!(status["pending"], false);
        assert_eq!(status["in_flight"], false);

        let agent = requests.bound().expect("bound").agent.clone();
        agent.prompt("run the probe tool").await.unwrap();
        agent.wait_for_idle().await;

        let response = probe.result().await;
        assert_eq!(response["scheduled"], true);
        assert_eq!(
            response["note"],
            "Refinement runs when the current turn ends; applied edits are appended to your context as a refinement notice and you resume automatically. Continue working normally."
        );
        let status = handler(&handlers, "refine.status")(payload(json!({})))
            .await
            .unwrap();
        assert_eq!(status["pending"], true);
        // The boundary takes the merged request.
        assert_eq!(
            requests.take_refine().await,
            Some(PendingRefine {
                instructions: Some("create a memory about the failing gate".to_string()),
                global: true,
            })
        );
        assert!(requests.take_refine().await.is_none());
    }

    #[tokio::test]
    async fn refine_run_validates_and_merges_into_a_pending_request() {
        let requests = Arc::new(TurnBoundaryRequests::new());
        let handlers = registered(&requests);
        let error = handler(&handlers, "refine.run")(payload(json!({ "instructions": 5 })))
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "refine.run instructions must be a string when provided"
        );
        let error = handler(&handlers, "refine.run")(payload(json!({ "global": "yes" })))
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "refine.run global must be a boolean when provided"
        );
        // Merge semantics through the real handler path: two `refine.run`
        // calls inside one turn — the second without instructions keeps the
        // first ones and ORs the global flag (TS merge).
        let session = Arc::new(Mutex::new(session_with_history(false)));
        let provider = Arc::new(ScriptedProvider::new(agent_model()));
        provider.push_tool_call_turn(None, vec![("call-1", "probe-a", json!({}))]);
        provider.push_tool_call_turn(None, vec![("call-2", "probe-b", json!({}))]);
        provider.push_text_turn("done");
        let probe = probe_tool(
            &requests,
            "probe-a",
            "refine.run",
            json!({ "instructions": "first observation" }),
        );
        let probe_again = probe_tool(
            &requests,
            "probe-b",
            "refine.run",
            json!({ "global": true }),
        );
        let agent = Arc::new(Agent::new(AgentOptions {
            initial_state: AgentInitialState {
                system_prompt: Some("s".to_string()),
                model: Some(agent_model()),
                thinking_level: Some(ThinkingLevel::Off),
                tools: Some(vec![probe.tool.clone(), probe_again.tool.clone()]),
                messages: None,
            },
            stream_fn: Some(provider.stream_fn()),
            ..Default::default()
        }));
        requests.bind(TurnBoundaryRuntime {
            agent,
            session,
            context_window: Some(100_000),
            model_info: model_info(),
        });
        let agent = requests.bound().expect("bound").agent.clone();
        agent.prompt("run both probes").await.unwrap();
        agent.wait_for_idle().await;
        assert_eq!(probe.result().await["scheduled"], true);
        assert_eq!(probe_again.result().await["scheduled"], true);
        assert_eq!(
            requests.take_refine().await,
            Some(PendingRefine {
                instructions: Some("first observation".to_string()),
                global: true,
            })
        );
    }

    #[tokio::test]
    async fn clear_pending_drops_scheduled_requests() {
        let requests = Arc::new(TurnBoundaryRequests::new());
        registered(&requests);
        let session = Arc::new(Mutex::new(session_with_history(false)));
        let provider = Arc::new(ScriptedProvider::new(agent_model()));
        provider.push_tool_call_turn(None, vec![("call-1", "probe", json!({}))]);
        provider.push_text_turn("done");
        let probe = probe_tool(
            &requests,
            "probe",
            "refine.run",
            json!({ "instructions": "x" }),
        );
        let agent = Arc::new(Agent::new(AgentOptions {
            initial_state: AgentInitialState {
                system_prompt: Some("s".to_string()),
                model: Some(agent_model()),
                thinking_level: Some(ThinkingLevel::Off),
                tools: Some(vec![probe.tool.clone()]),
                messages: None,
            },
            stream_fn: Some(provider.stream_fn()),
            ..Default::default()
        }));
        requests.bind(TurnBoundaryRuntime {
            agent,
            session,
            context_window: Some(100_000),
            model_info: model_info(),
        });
        let agent = requests.bound().expect("bound").agent.clone();
        agent.prompt("run the probe tool").await.unwrap();
        agent.wait_for_idle().await;
        assert_eq!(probe.result().await["scheduled"], true);
        assert!(requests.refine_pending().await);
        // The aborted-turn arm drops both request kinds.
        requests.clear_pending().await;
        assert!(requests.take_refine().await.is_none());
        assert!(requests.take_compaction().await.is_none());
    }

    #[tokio::test]
    async fn compact_run_merges_instructions_into_a_pending_request() {
        let requests = Arc::new(TurnBoundaryRequests::new());
        registered(&requests);
        let session = Arc::new(Mutex::new(session_with_history(false)));
        let provider = Arc::new(ScriptedProvider::new(agent_model()));
        provider.push_tool_call_turn(None, vec![("call-1", "probe-a", json!({}))]);
        provider.push_tool_call_turn(None, vec![("call-2", "probe-b", json!({}))]);
        provider.push_text_turn("done");
        let probe = probe_tool(
            &requests,
            "probe-a",
            "compact.run",
            json!({ "instructions": "first" }),
        );
        let probe_again = probe_tool(&requests, "probe-b", "compact.run", json!({}));
        let agent = Arc::new(Agent::new(AgentOptions {
            initial_state: AgentInitialState {
                system_prompt: Some("s".to_string()),
                model: Some(agent_model()),
                thinking_level: Some(ThinkingLevel::Off),
                tools: Some(vec![probe.tool.clone(), probe_again.tool.clone()]),
                messages: None,
            },
            stream_fn: Some(provider.stream_fn()),
            ..Default::default()
        }));
        requests.bind(TurnBoundaryRuntime {
            agent,
            session,
            context_window: Some(100_000),
            model_info: model_info(),
        });
        let agent = requests.bound().expect("bound").agent.clone();
        agent.prompt("run both probes").await.unwrap();
        agent.wait_for_idle().await;
        assert_eq!(probe.result().await["scheduled"], true);
        assert_eq!(probe_again.result().await["scheduled"], true);
        // The second call without instructions keeps the first ones.
        assert_eq!(
            requests.take_compaction().await,
            Some(PendingCompaction {
                instructions: Some("first".to_string())
            })
        );
    }

    #[test]
    fn context_usage_anchors_on_the_last_valid_assistant_usage() {
        let dir = tempfile::TempDir::new().unwrap();
        let session_dir = dir.path().join("session");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut session = SessionManager::in_memory(dir.path());
        session.materialize_session_file(Some(session_dir));
        let mut assistant = assistant_entry("done");
        let SessionMessage::Assistant(ref mut message) = assistant else {
            unreachable!();
        };
        message.usage = Usage {
            input: 100,
            output: 20,
            cache_read: 0,
            cache_write: 0,
            total_tokens: 130,
            cost: pa_agent::types::UsageCost::default(),
        };
        session.append_message(assistant).unwrap();
        session
            .append_message(user_entry("a somewhat long trailing message"))
            .unwrap();
        let entries = session.get_all_entries().to_vec();
        // Unknown context window -> None.
        assert!(context_usage(&entries, None).is_none());
        let usage = context_usage(&entries, Some(100_000)).unwrap();
        // The usage anchor plus the trailing estimate (chars/4).
        let trailing = "a somewhat long trailing message".chars().count() as u64 / 4;
        assert_eq!(usage.tokens, Some(130 + trailing));
        assert_eq!(usage.context_window, 100_000);
        let percent = usage.percent.unwrap();
        assert!((percent - (usage.tokens.unwrap() as f64 / 100_000.0 * 100.0)).abs() < 1e-9);
    }

    #[test]
    fn context_usage_after_a_compaction_without_post_usage_is_null_tokens() {
        let mut session = session_with_history(false);
        let first_kept = session.get_all_entries()[1]
            .id()
            .unwrap_or_default()
            .to_string();
        session
            .append_compaction(pa_types::session::CompactionEntry {
                summary: "summary".to_string(),
                first_kept_entry_id: first_kept,
                tokens_before: 10,
                ..Default::default()
            })
            .unwrap();
        let entries = session.get_all_entries().to_vec();
        let usage = context_usage(&entries, Some(100_000)).unwrap();
        assert_eq!(usage.tokens, None);
        assert_eq!(usage.percent, None);
        assert_eq!(usage.context_window, 100_000);
    }

    /// One scripted probe: a tool whose execution calls a registered host
    /// handler with `data` (the kernel-cell shape — host requests fire inside
    /// a tool call while the turn streams) and records the response.
    struct Probe {
        tool: Arc<dyn pa_agent::types::AgentTool>,
        slot: Arc<std::sync::Mutex<Option<Value>>>,
    }

    impl Probe {
        async fn result(&self) -> Value {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                if let Some(response) = self.slot.lock().unwrap().take() {
                    return response;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "probe handler result never appeared"
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }
    }

    fn probe_tool(
        requests: &Arc<TurnBoundaryRequests>,
        name: &str,
        request_type: &str,
        data: Value,
    ) -> Probe {
        let handler = {
            let mut handlers = HostRequestHandlers::default();
            requests.register_model_info_handler(&mut handlers, model_info());
            requests.register_compact_handlers(&mut handlers, 1);
            requests.register_refine_handlers(&mut handlers);
            handlers.get(request_type).expect("registered").clone()
        };
        let slot: Arc<std::sync::Mutex<Option<Value>>> = Arc::new(std::sync::Mutex::new(None));
        let slot_in_tool = Arc::clone(&slot);
        let definition = ToolDefinition {
            name: name.to_string(),
            label: "Probe".to_string(),
            description: "Calls a host handler".to_string(),
            prompt_snippet: String::new(),
            parameters: json!({ "type": "object", "properties": {} }),
            execution_mode: None,
            prepare_arguments: None,
            execute: Arc::new(move |_id, _params, _signal, _on_update| {
                let handler = handler.clone();
                let slot = slot_in_tool.clone();
                let data = data.clone();
                Box::pin(async move {
                    let response = match handler(payload(data)).await {
                        Ok(response) => response,
                        Err(error) => json!({ "__handler_error__": format!("{error:#}") }),
                    };
                    *slot.lock().unwrap() = Some(response);
                    Ok(crate::tools::tool_definition::ToolExecutionResult::text(
                        "probed",
                    ))
                })
            }),
        };
        Probe {
            tool: bridge_tool(definition),
            slot,
        }
    }
}
