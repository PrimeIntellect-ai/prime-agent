//! The `rlm.*` kernel host-request bridge: wire validation, the child-session
//! host seam, and handler registration for `rlm.spawn` (`rlm.run`),
//! `rlm.create_session`, `rlm.find_models`, `rlm.list_subagents`,
//! `rlm.collect`, `rlm.progress.note`, and `rlm.delete_subagent`.
//!
//! Wire contract: the Python side (`rlm/__init__.py`) sends typed requests and
//! parses strict snake_case replies. Pure normalization lives in
//! `kernel/rlm_runtime`; this module owns payload validation and the split
//! between what pa-core decides locally (shape checks, model search, note
//! throttling) and what the child-session host owns (spawn, roster, collect).

use std::future::Future;
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

use crate::kernel::rlm_runtime::{
    find_rlm_model_matches, kwargs_from_payload, normalize_requested_rlm_subagent_model,
    normalize_requested_rlm_subagent_session_name, normalize_requested_rlm_subagent_thinking_level,
    RlmModelInfo, DEFAULT_RLM_MODEL_SEARCH_LIMIT, MAX_RLM_MODEL_SEARCH_LIMIT,
};
use crate::kernel::shared::{host_handler, HostRequestHandlers};
use crate::models::registry::ModelRegistry;

use super::agent_messaging::assert_direct_agent_message_target;

/// Hard bound for one progress note; the throttle interval lives here too.
pub const RLM_PROGRESS_NOTE_MAX_LENGTH: usize = 512;
pub const RLM_PROGRESS_NOTE_MIN_INTERVAL_MS: u64 = 10_000;
const RLM_COLLECT_MAX_TIMEOUT_MS: u64 = 2_147_483_647;

// ---------------------------------------------------------------------------
// Wire shapes (strict snake_case, parsed by the Python rlm module)
// ---------------------------------------------------------------------------

/// `rlm.spawn` handle returned once the child task is admitted.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RlmSpawnHandle {
    pub rlm_child_id: String,
    pub name: String,
    pub session_dir: String,
    pub model: String,
}

/// `rlm.create_session` handle: one resident depth-0 daemon session.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RlmCreateSessionHandle {
    pub active_session_id: String,
    pub session_id: String,
    pub name: String,
    pub session_file: String,
    pub model: String,
}

/// One roster row of `rlm.list_subagents`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RlmSubagentEntry {
    pub rlm_child_id: String,
    pub active_session_id: Option<String>,
    pub session_id: Option<String>,
    pub session_name: String,
    pub session_dir: String,
    /// `running` | `completed` | `error`.
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<RlmSubagentActivity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replied_since_task: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_stale_ms: Option<u64>,
}

/// Live child activity projected onto the roster row.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RlmSubagentActivity {
    /// `waiting` | `writing` | `executing`.
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

/// `rlm.delete_subagent` reply: the deleted row plus the outcome.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RlmDeleteSubagentResult {
    pub subagent: RlmSubagentEntry,
    /// `deleted` | `skipped_running`; absent when the host reports neither.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<&'static str>,
}

/// One `rlm.collect` result envelope.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RlmChildResult {
    pub rlm_child_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_dir: Option<String>,
    /// `queued` | `running` | `done` | `error` | `cancelled`.
    pub status: &'static str,
    pub settled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replied_since_task: Option<bool>,
}

// ---------------------------------------------------------------------------
// Requests into the host
// ---------------------------------------------------------------------------

/// Validated `rlm.spawn` request handed to the child-session host.
#[derive(Debug, Clone)]
pub struct RlmSpawnRequest {
    pub prompt: String,
    /// Explicit session name; the host derives a default when absent.
    pub name: Option<String>,
    /// Model reference (selector or short form); the host resolves it.
    pub model: Option<String>,
    /// Validated thinking level; the host checks model support.
    pub thinking: Option<String>,
    pub cell_source_code: Option<String>,
}

/// Validated `rlm.create_session` request handed to the host.
#[derive(Debug, Clone)]
pub struct RlmCreateSessionRequest {
    pub prompt: String,
    pub name: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub cwd: Option<String>,
}

/// One pending host call. Boxed (not RPITIT) because the host crosses the
/// pa-core/pa-daemon boundary as a dyn object: the daemon supplies the
/// implementation and pa-core only owns the contract.
pub type RlmHostFuture<T> = std::pin::Pin<Box<dyn Future<Output = anyhow::Result<T>> + Send>>;

/// The child-session machinery the daemon supplies. Sessions without a host
/// (headless print mode today) answer with the no-children behavior:
/// rosters are empty, spawns fail explicitly, and selectors cannot match.
pub trait RlmSubagentHost: Send + Sync {
    /// Spawn a recursive child session and return once its task is admitted.
    fn spawn(&self, request: RlmSpawnRequest) -> RlmHostFuture<RlmSpawnHandle>;
    /// Create and prompt a resident depth-0 daemon session.
    fn create_session(
        &self,
        request: RlmCreateSessionRequest,
    ) -> RlmHostFuture<RlmCreateSessionHandle>;
    /// Roster of direct children retained by this parent session.
    fn list_subagents(&self) -> RlmHostFuture<Vec<RlmSubagentEntry>>;
    /// Delete one running or retained direct child.
    fn delete_subagent(&self, target: String) -> RlmHostFuture<RlmDeleteSubagentResult>;
    /// Typed fan-in of child results; a timeout returns snapshots, never errors.
    fn collect(&self, targets: Vec<String>, timeout_ms: u64) -> RlmHostFuture<Vec<RlmChildResult>>;
}

/// Host behavior for sessions with no child runtime: truthful empties and the
/// TS selector errors, so the kernel surface never silently invents children.
pub struct NoRlmChildren;

impl RlmSubagentHost for NoRlmChildren {
    fn spawn(&self, _request: RlmSpawnRequest) -> RlmHostFuture<RlmSpawnHandle> {
        Box::pin(async {
            anyhow::bail!(
                "rlm.spawn requires a daemon-backed session: this session has no RLM child runtime"
            );
        })
    }
    fn create_session(
        &self,
        _request: RlmCreateSessionRequest,
    ) -> RlmHostFuture<RlmCreateSessionHandle> {
        Box::pin(async {
            anyhow::bail!("rlm.create_session requires a daemon-backed depth-0 session");
        })
    }
    fn list_subagents(&self) -> RlmHostFuture<Vec<RlmSubagentEntry>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn delete_subagent(&self, target: String) -> RlmHostFuture<RlmDeleteSubagentResult> {
        Box::pin(async move {
            anyhow::bail!(
                "No direct RLM subagent matches \"{target}\" in the current parent session"
            );
        })
    }
    fn collect(
        &self,
        targets: Vec<String>,
        _timeout_ms: u64,
    ) -> RlmHostFuture<Vec<RlmChildResult>> {
        Box::pin(async move { no_children_collect(targets) })
    }
}

/// `collect` against an empty roster: every target is a miss.
pub fn no_children_collect(targets: Vec<String>) -> anyhow::Result<Vec<RlmChildResult>> {
    if let Some(target) = targets.first() {
        anyhow::bail!("No direct RLM child matches \"{target}\" in the current parent session");
    }
    Ok(Vec::new())
}

// ---------------------------------------------------------------------------
// Progress notes
// ---------------------------------------------------------------------------

/// Outcome of one `rlm.progress.note`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RlmProgressNoteResult {
    pub accepted: bool,
    /// Present only when throttled; ms until the next note is accepted.
    pub retry_after_ms: Option<u64>,
}

/// Latest-note store with the 10-second throttle. The daemon roster reads
/// `latest_note` so a child snapshot surfaces the note to its parent.
#[derive(Debug, Default)]
pub struct RlmProgressNotes {
    state: Mutex<RlmProgressNoteState>,
}

#[derive(Debug, Default)]
struct RlmProgressNoteState {
    last_at: Option<Instant>,
    latest: Option<(String, u64)>,
}

impl RlmProgressNotes {
    /// Accept or throttle one note. The message is already validated.
    pub async fn note(&self, message: &str, now_ms: u64) -> RlmProgressNoteResult {
        let mut state = self.state.lock().await;
        if let Some(last_at) = state.last_at {
            let elapsed_ms = last_at.elapsed().as_millis() as u64;
            if elapsed_ms < RLM_PROGRESS_NOTE_MIN_INTERVAL_MS {
                return RlmProgressNoteResult {
                    accepted: false,
                    retry_after_ms: Some(RLM_PROGRESS_NOTE_MIN_INTERVAL_MS - elapsed_ms),
                };
            }
        }
        state.last_at = Some(Instant::now());
        state.latest = Some((message.to_string(), now_ms));
        RlmProgressNoteResult {
            accepted: true,
            retry_after_ms: None,
        }
    }

    /// The newest accepted note with its wall-clock timestamp.
    pub async fn latest_note(&self) -> Option<(String, u64)> {
        self.state.lock().await.latest.clone()
    }
}

/// Message length in UTF-16 code units, matching the host-side bound.
pub fn utf16_length(message: &str) -> usize {
    message.chars().map(char::len_utf16).sum()
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/// Session-scoped RLM state the handlers share.
pub struct RlmHostBridge {
    registry: Arc<ModelRegistry>,
    pub notes: Arc<RlmProgressNotes>,
    host: Arc<dyn RlmSubagentHost>,
    /// The child-usage attribution producer `rlm.spawn` registers into
    /// and the daemon's child observation drives.
    pub usage: Arc<super::rlm_usage::RlmChildUsageAttributions>,
}

impl RlmHostBridge {
    /// Build the bridge: an explicit host, or the no-children behavior.
    pub fn new(
        registry: Arc<ModelRegistry>,
        host: Option<Arc<dyn RlmSubagentHost>>,
        usage: Arc<super::rlm_usage::RlmChildUsageAttributions>,
    ) -> Self {
        Self {
            registry,
            notes: Arc::new(RlmProgressNotes::default()),
            host: host.unwrap_or_else(|| Arc::new(NoRlmChildren)),
            usage,
        }
    }
}

/// Register every `rlm.*` host handler onto the handler map.
pub fn register_rlm_host_handlers(handlers: &mut HostRequestHandlers, bridge: &Arc<RlmHostBridge>) {
    register_find_models(handlers, bridge);
    register_progress_note(handlers, bridge);
    register_run(handlers, bridge);
    register_create_session(handlers, bridge);
    register_list_subagents(handlers, bridge);
    register_delete_subagent(handlers, bridge);
    register_collect(handlers, bridge);
}

fn register_find_models(handlers: &mut HostRequestHandlers, bridge: &Arc<RlmHostBridge>) {
    let registry = Arc::clone(&bridge.registry);
    handlers.register(
        "rlm.find_models",
        host_handler(move |payload| {
            let registry = Arc::clone(&registry);
            Box::pin(async move {
                let data = &payload.data;
                let Some(query) = data.get("query").and_then(Value::as_str) else {
                    anyhow::bail!("rlm.find_models query must be a string");
                };
                let limit = match data.get("limit") {
                    None | Some(Value::Null) => Some(DEFAULT_RLM_MODEL_SEARCH_LIMIT as u64),
                    Some(value) => value.as_u64().filter(|limit| {
                        (1..=MAX_RLM_MODEL_SEARCH_LIMIT as u64).contains(limit)
                    }),
                };
                let Some(limit) = limit else {
                    anyhow::bail!(
                        "rlm.find_models limit must be an integer from 1 to {MAX_RLM_MODEL_SEARCH_LIMIT}"
                    );
                };
                let models: Vec<RlmModelInfo> = registry
                    .get_rlm_searchable_models()
                    .into_iter()
                    .map(|model| RlmModelInfo {
                        provider: model.provider.clone(),
                        id: model.id.clone(),
                        name: if model.name.is_empty() {
                            model.id.clone()
                        } else {
                            model.name.clone()
                        },
                    })
                    .collect();
                let matches = find_rlm_model_matches(query, &models, limit as usize);
                Ok(json!({ "models": matches }))
            })
        }),
    );
}

fn register_progress_note(handlers: &mut HostRequestHandlers, bridge: &Arc<RlmHostBridge>) {
    let notes = Arc::clone(&bridge.notes);
    handlers.register(
        "rlm.progress.note",
        host_handler(move |payload| {
            let notes = Arc::clone(&notes);
            Box::pin(async move {
                let Some(raw) = payload.data.get("message").and_then(Value::as_str) else {
                    anyhow::bail!("rlm.progress.note message must be a non-empty string");
                };
                let message = raw.trim();
                if message.is_empty() {
                    anyhow::bail!("rlm.progress.note message must be a non-empty string");
                }
                if utf16_length(message) > RLM_PROGRESS_NOTE_MAX_LENGTH {
                    anyhow::bail!(
                        "rlm.progress.note message must be at most {RLM_PROGRESS_NOTE_MAX_LENGTH} characters"
                    );
                }
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or_default();
                let outcome = notes.note(message, now_ms).await;
                Ok(match outcome.retry_after_ms {
                    None => json!({ "accepted": true }),
                    Some(retry_after_ms) => json!({
                        "accepted": false,
                        "retry_after_ms": retry_after_ms
                    }),
                })
            })
        }),
    );
}

fn register_run(handlers: &mut HostRequestHandlers, bridge: &Arc<RlmHostBridge>) {
    let host = Arc::clone(&bridge.host);
    let usage = Arc::clone(&bridge.usage);
    handlers.register(
        "rlm.run",
        host_handler(move |payload| {
            let host = Arc::clone(&host);
            let usage = Arc::clone(&usage);
            Box::pin(async move {
                let data = &payload.data;
                let Some(prompt) = data.get("prompt").and_then(Value::as_str) else {
                    anyhow::bail!("rlm.spawn prompt must be a string");
                };
                let mut request = spawn_request_from_payload(prompt, data)?;
                request.cell_source_code = payload.cell_source_code.clone();
                let handle = host.spawn(request).await?;
                // TS `_findLastAssistantMessage` at spawn: the spawning
                // assistant row (persisted at `message_end` before tool
                // execution) is the target every child-usage attribution
                // folds into.
                usage.register_spawn(&handle.rlm_child_id).await;
                serde_json::to_value(&handle).map_err(anyhow::Error::new)
            })
        }),
    );
}

/// Shared kwargs validation for `rlm.run`: unsupported keys are rejected with
/// the sorted key list, and name/model/thinking normalize through the pure
/// helpers.
fn spawn_request_from_payload(prompt: &str, data: &Value) -> anyhow::Result<RlmSpawnRequest> {
    const OPERATION: &str = "rlm.spawn";
    let kwargs = kwargs_from_payload(data);
    reject_unsupported_kwargs(&kwargs, OPERATION, &["name", "model", "thinking"])?;
    let name = optional_string_kwarg(&kwargs, "name", OPERATION)?;
    let name = normalize_requested_rlm_subagent_session_name(name, OPERATION)?;
    if let Some(name) = &name {
        assert_direct_agent_message_target(name)?;
    }
    let model = optional_string_kwarg(&kwargs, "model", OPERATION)?;
    let model = normalize_requested_rlm_subagent_model(model, OPERATION)?;
    let thinking = optional_string_kwarg(&kwargs, "thinking", OPERATION)?;
    let thinking =
        normalize_requested_rlm_subagent_thinking_level(thinking, OPERATION)?.map(String::from);
    Ok(RlmSpawnRequest {
        prompt: prompt.to_string(),
        name,
        model,
        thinking,
        cell_source_code: None,
    })
}

fn register_create_session(handlers: &mut HostRequestHandlers, bridge: &Arc<RlmHostBridge>) {
    let host = Arc::clone(&bridge.host);
    handlers.register(
        "rlm.create_session",
        host_handler(move |payload| {
            let host = Arc::clone(&host);
            Box::pin(async move {
                const OPERATION: &str = "rlm.create_session";
                let data = &payload.data;
                let Some(prompt) = data.get("prompt").and_then(Value::as_str) else {
                    anyhow::bail!("rlm.create_session prompt must be a string");
                };
                if prompt.trim().is_empty() {
                    anyhow::bail!("rlm.create_session prompt must not be empty");
                }
                let kwargs = kwargs_from_payload(data);
                reject_unsupported_kwargs(
                    &kwargs,
                    OPERATION,
                    &["name", "model", "thinking", "cwd"],
                )?;
                let name = optional_string_kwarg(&kwargs, "name", OPERATION)?;
                let name = normalize_requested_rlm_subagent_session_name(name, OPERATION)?;
                if let Some(name) = &name {
                    assert_direct_agent_message_target(name)?;
                }
                let model = optional_string_kwarg(&kwargs, "model", OPERATION)?;
                let model = normalize_requested_rlm_subagent_model(model, OPERATION)?;
                let thinking = optional_string_kwarg(&kwargs, "thinking", OPERATION)?;
                let thinking =
                    normalize_requested_rlm_subagent_thinking_level(thinking, OPERATION)?
                        .map(String::from);
                let cwd = match kwargs.get("cwd") {
                    None => None,
                    Some(Value::String(cwd)) => {
                        let cwd = cwd.trim();
                        if cwd.is_empty() {
                            anyhow::bail!("rlm.create_session cwd must be a non-empty string");
                        }
                        Some(cwd.to_string())
                    }
                    Some(_) => anyhow::bail!("rlm.create_session cwd must be a non-empty string"),
                };
                let handle = host
                    .create_session(RlmCreateSessionRequest {
                        prompt: prompt.to_string(),
                        name,
                        model,
                        thinking,
                        cwd,
                    })
                    .await?;
                serde_json::to_value(&handle).map_err(anyhow::Error::new)
            })
        }),
    );
}

fn register_list_subagents(handlers: &mut HostRequestHandlers, bridge: &Arc<RlmHostBridge>) {
    let host = Arc::clone(&bridge.host);
    handlers.register(
        "rlm.list_subagents",
        host_handler(move |_payload| {
            let host = Arc::clone(&host);
            Box::pin(async move {
                let subagents = host.list_subagents().await?;
                Ok(json!({ "subagents": subagents }))
            })
        }),
    );
}

fn register_delete_subagent(handlers: &mut HostRequestHandlers, bridge: &Arc<RlmHostBridge>) {
    let host = Arc::clone(&bridge.host);
    handlers.register(
        "rlm.delete_subagent",
        host_handler(move |payload| {
            let host = Arc::clone(&host);
            Box::pin(async move {
                let Some(target) = payload
                    .data
                    .get("target")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|target| !target.is_empty())
                else {
                    anyhow::bail!("rlm.delete_subagent target must be a non-empty string");
                };
                let result = host.delete_subagent(target.to_string()).await?;
                serde_json::to_value(&result).map_err(anyhow::Error::new)
            })
        }),
    );
}

fn register_collect(handlers: &mut HostRequestHandlers, bridge: &Arc<RlmHostBridge>) {
    let host = Arc::clone(&bridge.host);
    handlers.register(
        "rlm.collect",
        host_handler(move |payload| {
            let host = Arc::clone(&host);
            Box::pin(async move {
                let data = &payload.data;
                let targets = match data.get("targets") {
                    None | Some(Value::Null) => Vec::new(),
                    Some(Value::Array(items)) => {
                        let mut targets = Vec::with_capacity(items.len());
                        for item in items {
                            let Some(target) = item.as_str().map(str::trim) else {
                                anyhow::bail!("rlm.collect targets must be non-empty strings");
                            };
                            if target.is_empty() {
                                anyhow::bail!("rlm.collect targets must be non-empty strings");
                            }
                            targets.push(target.to_string());
                        }
                        targets
                    }
                    Some(_) => {
                        anyhow::bail!("rlm.collect targets must be an array of child ids or names")
                    }
                };
                let timeout_ms = match data.get("timeout_ms") {
                    None | Some(Value::Null) => Some(0),
                    Some(value) => value
                        .as_u64()
                        .filter(|timeout| *timeout <= RLM_COLLECT_MAX_TIMEOUT_MS),
                };
                let Some(timeout_ms) = timeout_ms else {
                    anyhow::bail!(
                        "rlm.collect timeout_ms must be a non-negative integer up to {RLM_COLLECT_MAX_TIMEOUT_MS}"
                    );
                };
                let results = host.collect(targets, timeout_ms).await?;
                Ok(json!({ "results": results }))
            })
        }),
    );
}

/// Present-but-non-string kwargs fail like the TS normalizers do.
fn optional_string_kwarg<'a>(
    kwargs: &'a Map<String, Value>,
    key: &str,
    operation: &str,
) -> anyhow::Result<Option<&'a str>> {
    match kwargs.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => anyhow::bail!("{operation} {key} must be a string"),
    }
}

fn reject_unsupported_kwargs(
    kwargs: &Map<String, Value>,
    operation: &str,
    supported: &[&str],
) -> anyhow::Result<()> {
    let mut unsupported: Vec<&str> = kwargs
        .keys()
        .map(String::as_str)
        .filter(|key| !supported.contains(key))
        .collect();
    if unsupported.is_empty() {
        return Ok(());
    }
    unsupported.sort_unstable();
    anyhow::bail!("Unsupported {operation} kwargs: {}", unsupported.join(", "));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::shared::HostRequestPayload;
    use crate::session::manager::SessionManager;
    use std::sync::Arc;

    /// A host recording every call, answering with fixed handles.
    /// One recorded collect call: its targets and timeout.
    type CollectCall = (Vec<String>, u64);

    struct RecordingHost {
        spawn_requests: Arc<Mutex<Vec<RlmSpawnRequest>>>,
        create_requests: Arc<Mutex<Vec<RlmCreateSessionRequest>>>,
        targets: Arc<Mutex<Vec<String>>>,
        collects: Arc<Mutex<Vec<CollectCall>>>,
    }

    impl RecordingHost {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                spawn_requests: Arc::new(Mutex::new(Vec::new())),
                create_requests: Arc::new(Mutex::new(Vec::new())),
                targets: Arc::new(Mutex::new(Vec::new())),
                collects: Arc::new(Mutex::new(Vec::new())),
            })
        }
    }

    impl RlmSubagentHost for RecordingHost {
        fn spawn(&self, request: RlmSpawnRequest) -> RlmHostFuture<RlmSpawnHandle> {
            let requests = Arc::clone(&self.spawn_requests);
            Box::pin(async move {
                requests.lock().await.push(request);
                Ok(RlmSpawnHandle {
                    rlm_child_id: "sub-1".into(),
                    name: "worker".into(),
                    session_dir: "/tmp/sub-1".into(),
                    model: "p/m".into(),
                })
            })
        }
        fn create_session(
            &self,
            request: RlmCreateSessionRequest,
        ) -> RlmHostFuture<RlmCreateSessionHandle> {
            let requests = Arc::clone(&self.create_requests);
            Box::pin(async move {
                requests.lock().await.push(request);
                Ok(RlmCreateSessionHandle {
                    active_session_id: "live-2".into(),
                    session_id: "s-2".into(),
                    name: "root-2".into(),
                    session_file: "/tmp/s-2.jsonl".into(),
                    model: "p/m".into(),
                })
            })
        }
        fn list_subagents(&self) -> RlmHostFuture<Vec<RlmSubagentEntry>> {
            Box::pin(async {
                Ok(vec![RlmSubagentEntry {
                    rlm_child_id: "sub-1".into(),
                    active_session_id: Some("live-2".into()),
                    session_id: Some("s-2".into()),
                    session_name: "worker".into(),
                    session_dir: "/tmp/sub-1".into(),
                    status: "running",
                    activity: Some(RlmSubagentActivity {
                        kind: "executing",
                        tool_name: Some("bash".into()),
                    }),
                    tool_use_count: Some(3),
                    duration_ms: Some(1_500),
                    answer_preview: None,
                    replied_since_task: Some(false),
                    progress_note: Some("halfway".into()),
                    label: Some("child agent".into()),
                    last_activity_at: Some(1_000),
                    activity_stale_ms: None,
                }])
            })
        }
        fn delete_subagent(&self, target: String) -> RlmHostFuture<RlmDeleteSubagentResult> {
            let targets = Arc::clone(&self.targets);
            Box::pin(async move {
                targets.lock().await.push(target);
                Ok(RlmDeleteSubagentResult {
                    subagent: RlmSubagentEntry {
                        rlm_child_id: "sub-1".into(),
                        active_session_id: None,
                        session_id: None,
                        session_name: "worker".into(),
                        session_dir: "/tmp/sub-1".into(),
                        status: "completed",
                        activity: None,
                        tool_use_count: None,
                        duration_ms: None,
                        answer_preview: None,
                        replied_since_task: None,
                        progress_note: None,
                        label: None,
                        last_activity_at: None,
                        activity_stale_ms: None,
                    },
                    outcome: Some("deleted"),
                })
            })
        }
        fn collect(
            &self,
            targets: Vec<String>,
            timeout_ms: u64,
        ) -> RlmHostFuture<Vec<RlmChildResult>> {
            let collects = Arc::clone(&self.collects);
            Box::pin(async move {
                collects.lock().await.push((targets, timeout_ms));
                Ok(vec![RlmChildResult {
                    rlm_child_id: "sub-1".into(),
                    session_name: Some("worker".into()),
                    session_dir: Some("/tmp/sub-1".into()),
                    status: "done",
                    settled: true,
                    answer_preview: Some("all done".into()),
                    error: None,
                    duration_ms: Some(2_000),
                    tool_use_count: Some(3),
                    replied_since_task: Some(true),
                }])
            })
        }
    }

    fn persisted_session(dir: &std::path::Path) -> SessionManager {
        let session_dir = dir.join("session");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut session = SessionManager::in_memory(dir);
        session.materialize_session_file(Some(session_dir));
        session
    }

    /// Write a models.json with one auth-configured custom provider.
    fn registry_with_custom_model(dir: &std::path::Path) -> Arc<ModelRegistry> {
        // Hermetic environment credential source: this sandbox exports
        // PRIME_API_KEY globally, which would unlock the built-in providers
        // and evict the custom catalog from the default empty-query limit.
        struct NoEnvCredentials;
        impl crate::auth::manager::EnvCredentialSource for NoEnvCredentials {
            fn key_names(&self, _provider: &str) -> Option<Vec<String>> {
                None
            }
            fn api_key(&self, _provider: &str) -> Option<String> {
                None
            }
            fn prime_team_id(&self) -> Option<String> {
                None
            }
            fn ambient_identity_material(&self, _provider: &str) -> String {
                String::new()
            }
        }
        std::fs::write(
            dir.join("models.json"),
            r#"{
                "providers": {
                    "test-provider": {
                        "baseUrl": "http://localhost:9",
                        "apiKey": "test-key",
                        "api": "openai-completions",
                        "models": [
                            { "id": "glm-5.3", "name": "GLM 5.3", "contextWindow": 1000, "maxTokens": 100 },
                            { "id": "glm-5.3-turbo", "name": "GLM Turbo", "contextWindow": 1000, "maxTokens": 100 }
                        ]
                    }
                }
            }"#,
        )
        .unwrap();
        let auth = crate::auth::AuthStorage::in_memory_with_env(
            Default::default(),
            std::sync::Arc::new(crate::auth::NoOAuth),
            std::sync::Arc::new(NoEnvCredentials),
        );
        Arc::new(ModelRegistry::create(auth, dir.join("models.json")))
    }

    fn wired(
        dir: &std::path::Path,
        host: Option<Arc<dyn RlmSubagentHost>>,
    ) -> crate::session_engine::runtime_wiring::SessionKernelWiring {
        let session = persisted_session(dir);
        let registry = registry_with_custom_model(dir);
        crate::session_engine::runtime_wiring::wire_session_runtime(
            session,
            dir,
            crate::session_engine::runtime_wiring::RlmWiring {
                model_registry: Some(Arc::clone(&registry)),
                subagent_host: host,
            },
            None,
            None,
        )
    }

    fn payload(data: Value) -> HostRequestPayload {
        HostRequestPayload {
            data,
            cell_source_code: None,
        }
    }

    async fn call(
        wiring: &crate::session_engine::runtime_wiring::SessionKernelWiring,
        request_type: &str,
        data: Value,
    ) -> anyhow::Result<Value> {
        let handler = wiring
            .handlers
            .get(request_type)
            .unwrap_or_else(|| panic!("{request_type} handler registered"))
            .clone();
        handler(payload(data)).await
    }

    #[tokio::test]
    async fn find_models_round_trip_through_the_registry() {
        let dir = tempfile::TempDir::new().unwrap();
        let wiring = wired(dir.path(), None);
        // The bundled catalog also answers, so query by the custom selector.
        let response = call(
            &wiring,
            "rlm.find_models",
            json!({ "type": "rlm.find_models", "query": "test-provider/glm-5.3" }),
        )
        .await
        .unwrap();
        let models = response["models"].as_array().unwrap();
        // Exact selector first; the turbo sibling matches by substring.
        assert_eq!(models.len(), 2);
        assert_eq!(
            models[0],
            json!({
                "provider": "test-provider",
                "id": "glm-5.3",
                "name": "GLM 5.3",
                "selector": "test-provider/glm-5.3",
            })
        );
        assert_eq!(models[1]["selector"], "test-provider/glm-5.3-turbo");
        // A shared id fragment ranks the exact selector match first.
        let response = call(
            &wiring,
            "rlm.find_models",
            json!({ "type": "rlm.find_models", "query": "glm-5.3", "limit": 2 }),
        )
        .await
        .unwrap();
        let models = response["models"].as_array().unwrap();
        assert_eq!(
            models[0]["selector"], "test-provider/glm-5.3",
            "exact selector match ranks first: {models:?}"
        );
        // Default limit 8, empty query lists every searchable model.
        let response = call(
            &wiring,
            "rlm.find_models",
            json!({ "type": "rlm.find_models", "query": "" }),
        )
        .await
        .unwrap();
        let listed = response["models"].as_array().unwrap();
        assert!(listed.len() >= 2);
        let selectors: Vec<&str> = listed
            .iter()
            .map(|model| model["selector"].as_str().unwrap())
            .collect();
        assert!(selectors.contains(&"test-provider/glm-5.3"));
        assert!(selectors.contains(&"test-provider/glm-5.3-turbo"));
        // Validation: query type, limit range.
        let error = call(&wiring, "rlm.find_models", json!({ "limit": 3 }))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "rlm.find_models query must be a string");
        let error = call(
            &wiring,
            "rlm.find_models",
            json!({ "query": "glm", "limit": 0 }),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "rlm.find_models limit must be an integer from 1 to 20"
        );
        let error = call(
            &wiring,
            "rlm.find_models",
            json!({ "query": "glm", "limit": "eight" }),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "rlm.find_models limit must be an integer from 1 to 20"
        );
    }

    #[tokio::test]
    async fn progress_note_throttles_and_stores() {
        let dir = tempfile::TempDir::new().unwrap();
        let wiring = wired(dir.path(), None);
        let accepted = call(
            &wiring,
            "rlm.progress.note",
            json!({ "type": "rlm.progress.note", "message": "  making progress  " }),
        )
        .await
        .unwrap();
        assert_eq!(accepted, json!({ "accepted": true }));
        let (latest, _) = wiring.rlm.notes.latest_note().await.unwrap();
        assert_eq!(latest, "making progress");
        // An immediate second note is throttled with a retry hint.
        let throttled = call(
            &wiring,
            "rlm.progress.note",
            json!({ "type": "rlm.progress.note", "message": "again" }),
        )
        .await
        .unwrap();
        assert_eq!(throttled["accepted"], false);
        let retry = throttled["retry_after_ms"].as_u64().unwrap();
        assert!(retry > 0 && retry <= RLM_PROGRESS_NOTE_MIN_INTERVAL_MS);
        // Validation: empty and oversized messages.
        let error = call(&wiring, "rlm.progress.note", json!({ "message": "  " }))
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "rlm.progress.note message must be a non-empty string"
        );
        let astral = "\u{1F600}".repeat(513);
        let error = call(&wiring, "rlm.progress.note", json!({ "message": astral }))
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "rlm.progress.note message must be at most 512 characters"
        );
    }

    #[tokio::test]
    async fn spawn_round_trip_through_the_registry() {
        let dir = tempfile::TempDir::new().unwrap();
        let host = RecordingHost::new();
        let spawn_requests = Arc::clone(&host.spawn_requests);
        let wiring = wired(dir.path(), Some(host));
        let response = call(
            &wiring,
            "rlm.run",
            json!({
                "type": "rlm.run",
                "prompt": "ship the lane",
                "kwargs": { "name": "worker", "model": "p/m", "thinking": "High" }
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            response,
            json!({
                "rlm_child_id": "sub-1",
                "name": "worker",
                "session_dir": "/tmp/sub-1",
                "model": "p/m",
            })
        );
        let requests = spawn_requests.lock().await;
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].prompt, "ship the lane");
        assert_eq!(requests[0].name.as_deref(), Some("worker"));
        assert_eq!(requests[0].model.as_deref(), Some("p/m"));
        assert_eq!(requests[0].thinking.as_deref(), Some("high"));
        drop(requests);

        // Validation: prompt type, unsupported kwargs, name rules.
        let error = call(&wiring, "rlm.run", json!({ "kwargs": {} }))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "rlm.spawn prompt must be a string");
        let error = call(
            &wiring,
            "rlm.run",
            json!({ "prompt": "p", "kwargs": { "name": "w", "depth": 1, "budget": 2 } }),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Unsupported rlm.spawn kwargs: budget, depth"
        );
        let error = call(
            &wiring,
            "rlm.run",
            json!({ "prompt": "p", "kwargs": { "name": "  " } }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "rlm.spawn name must not be empty");
        let error = call(
            &wiring,
            "rlm.run",
            json!({ "prompt": "p", "kwargs": { "name": "all" } }),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Broadcast agent messaging is not supported"
        );
        let error = call(
            &wiring,
            "rlm.run",
            json!({ "prompt": "p", "kwargs": { "thinking": "sideways" } }),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "rlm.spawn thinking must be one of: off, minimal, low, medium, high, xhigh, max"
        );
        let error = call(
            &wiring,
            "rlm.run",
            json!({ "prompt": "p", "kwargs": { "name": 5 } }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "rlm.spawn name must be a string");
    }

    #[tokio::test]
    async fn create_session_round_trip_through_the_registry() {
        let dir = tempfile::TempDir::new().unwrap();
        let host = RecordingHost::new();
        let create_requests = Arc::clone(&host.create_requests);
        let wiring = wired(dir.path(), Some(host));
        let response = call(
            &wiring,
            "rlm.create_session",
            json!({
                "type": "rlm.create_session",
                "prompt": "start a root session",
                "kwargs": { "name": "root-2", "cwd": "/tmp" }
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            response,
            json!({
                "active_session_id": "live-2",
                "session_id": "s-2",
                "name": "root-2",
                "session_file": "/tmp/s-2.jsonl",
                "model": "p/m",
            })
        );
        let requests = create_requests.lock().await;
        assert_eq!(requests[0].cwd.as_deref(), Some("/tmp"));
        drop(requests);

        // Validation: empty prompt, unsupported kwargs, empty cwd.
        let error = call(
            &wiring,
            "rlm.create_session",
            json!({ "prompt": "   ", "kwargs": {} }),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "rlm.create_session prompt must not be empty"
        );
        let error = call(
            &wiring,
            "rlm.create_session",
            json!({ "prompt": "p", "kwargs": { "env": {} } }),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Unsupported rlm.create_session kwargs: env"
        );
        let error = call(
            &wiring,
            "rlm.create_session",
            json!({ "prompt": "p", "kwargs": { "cwd": "  " } }),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "rlm.create_session cwd must be a non-empty string"
        );
        // Without a host the TS error is exact.
        let dir2 = tempfile::TempDir::new().unwrap();
        let no_host = wired(dir2.path(), None);
        let error = call(
            &no_host,
            "rlm.create_session",
            json!({ "prompt": "p", "kwargs": {} }),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "rlm.create_session requires a daemon-backed depth-0 session"
        );
    }

    #[tokio::test]
    async fn roster_collect_and_delete_round_trip() {
        let dir = tempfile::TempDir::new().unwrap();
        let host = RecordingHost::new();
        let targets = Arc::clone(&host.targets);
        let collects = Arc::clone(&host.collects);
        let wiring = wired(dir.path(), Some(host));
        let listed = call(&wiring, "rlm.list_subagents", json!({}))
            .await
            .unwrap();
        assert_eq!(
            listed["subagents"][0],
            json!({
                "rlm_child_id": "sub-1",
                "active_session_id": "live-2",
                "session_id": "s-2",
                "session_name": "worker",
                "session_dir": "/tmp/sub-1",
                "status": "running",
                "activity": { "kind": "executing", "tool_name": "bash" },
                "tool_use_count": 3,
                "duration_ms": 1500,
                "replied_since_task": false,
                "progress_note": "halfway",
                "label": "child agent",
                "last_activity_at": 1000,
            })
        );
        let deleted = call(
            &wiring,
            "rlm.delete_subagent",
            json!({ "target": "  sub-1  " }),
        )
        .await
        .unwrap();
        assert_eq!(deleted["subagent"]["status"], "completed");
        assert_eq!(deleted["outcome"], "deleted");
        assert_eq!(*targets.lock().await, vec!["sub-1".to_string()]);

        let collected = call(
            &wiring,
            "rlm.collect",
            json!({ "targets": ["sub-1"], "timeout_ms": 250 }),
        )
        .await
        .unwrap();
        assert_eq!(collected["results"][0]["status"], "done");
        assert_eq!(collected["results"][0]["settled"], true);
        assert_eq!(collected["results"][0]["answer_preview"], "all done");
        assert_eq!(
            *collects.lock().await,
            vec![(vec!["sub-1".to_string()], 250u64)]
        );
        // Defaults: absent targets mean every child, absent timeout is 0.
        call(&wiring, "rlm.collect", json!({})).await.unwrap();
        assert_eq!(
            collects
                .lock()
                .await
                .last()
                .map(|(targets, timeout)| (targets.clone(), *timeout)),
            Some((vec![], 0))
        );
        // Validation: target shapes and timeout bound.
        let error = call(&wiring, "rlm.collect", json!({ "targets": "sub-1" }))
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "rlm.collect targets must be an array of child ids or names"
        );
        let error = call(&wiring, "rlm.collect", json!({ "targets": ["sub-1", " "] }))
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "rlm.collect targets must be non-empty strings"
        );
        let error = call(&wiring, "rlm.collect", json!({ "timeout_ms": -1 }))
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "rlm.collect timeout_ms must be a non-negative integer up to 2147483647"
        );
        let error = call(&wiring, "rlm.delete_subagent", json!({ "target": "" }))
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "rlm.delete_subagent target must be a non-empty string"
        );
    }

    #[tokio::test]
    async fn no_host_session_reports_empty_roster_and_selector_misses() {
        let dir = tempfile::TempDir::new().unwrap();
        let wiring = wired(dir.path(), None);
        let listed = call(&wiring, "rlm.list_subagents", json!({}))
            .await
            .unwrap();
        assert_eq!(listed, json!({ "subagents": [] }));
        let collected = call(&wiring, "rlm.collect", json!({})).await.unwrap();
        assert_eq!(collected, json!({ "results": [] }));
        let error = call(&wiring, "rlm.collect", json!({ "targets": ["ghost"] }))
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "No direct RLM child matches \"ghost\" in the current parent session"
        );
        let error = call(&wiring, "rlm.delete_subagent", json!({ "target": "ghost" }))
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "No direct RLM subagent matches \"ghost\" in the current parent session"
        );
        let error = call(&wiring, "rlm.run", json!({ "prompt": "p", "kwargs": {} }))
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "rlm.spawn requires a daemon-backed session: this session has no RLM child runtime"
        );
    }
}
