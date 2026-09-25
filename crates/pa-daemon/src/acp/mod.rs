//! ACP stdio mode: a thin JSON-RPC transport over the session engine.
//!
//! One connection hosts at most one session. `session/new` admits the
//! session (reporting a cwd mismatch instead of adopting one) and
//! advertises the model and reasoning-effort pickers, `session/prompt`
//! drives one engine turn with follow-up queueing semantics,
//! `session/set_config_option` applies a picker selection, and
//! `session/cancel` / `session/close` stop work. Every frame leaves
//! through one ordered write queue, so responses and `session/update`
//! notifications interleave exactly in publication order. The process
//! exits when stdin closes.

mod autorefine;
mod compaction_arms;
mod config_options;
pub mod daemon;
mod events;
mod goal_continuation;
mod in_process_config;
mod jsonrpc;
mod mcp;
mod meta;
mod producer;
mod prompt;
mod session;
mod types;
mod wire_config;
mod wire_events;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use pa_core::autonomous::create_autonomous_runtime_state;
use pa_core::session_engine::engine::SessionEngine;

use jsonrpc::Incoming;
use meta::PrimeAgentSessionMeta;
use producer::UpdateProducer;
use session::AcpSession;
use types::{
    initialize_result, session_id_params, AcpStopReason, AcpStopReasonResponse, NewSessionParams,
};

use config_options::ProviderTargetSlot;
use in_process_config::{admit_session_config, InProcessConfig};

/// Everything the mode needs from the composition root.
pub struct AcpOptions {
    /// The running session engine (`create_session` output).
    pub engine: Arc<SessionEngine>,
    /// The cwd the session actually runs in, fixed at startup.
    pub actual_cwd: PathBuf,
    /// The product version reported in `initialize`.
    pub product_version: String,
    /// The session's resolved model, for session-command executors
    /// (`/compact`, `/refine`) that run their own provider calls.
    pub model: Option<pa_types::ai::Model>,
    /// Resolved request API key for those executors.
    pub api_key: Option<String>,
    /// The agent dir: the global harness directory for refinement history.
    pub agent_dir: PathBuf,
    /// The autonomous runtime configuration from the CLI flags.
    pub autonomous_config: Option<pa_core::autonomous::AgentAutonomousConfig>,
    /// The switchable provider target the session's stream reads per call
    /// (the composition's create-time output): a picker model switch swaps
    /// it so the next turn streams on the selected model (TS `setModel`'s
    /// stream re-registration).
    pub provider_target: ProviderTargetSlot,
}

/// The hosted-session slot plus the in-flight admission bookkeeping.
#[derive(Default)]
struct ConnectionState {
    session: Option<SessionEntry>,
    session_new_in_flight: bool,
    session_close_in_flight: bool,
}

/// Composition-root inputs shared by every handler: the engine plus the
/// fixed process identity (cwd, version) and the session-command inputs
/// (resolved model, api key, agent dir, autonomous config).
#[derive(Clone)]
struct AcpModeState {
    engine: Arc<SessionEngine>,
    actual_cwd: Arc<PathBuf>,
    product_version: Arc<String>,
    /// The session's live model (TS `state.model`): the composition's
    /// resolved model at admission, updated by a picker model switch so
    /// the session-command executors (`/compact`, `/refine`) follow the
    /// switched model, exactly like the TS session's own calls.
    model: Arc<Mutex<Option<pa_types::ai::Model>>>,
    /// The session's live request key: follows a picker model switch's
    /// registry resolution, so the session-command executors authenticate
    /// against the switched model's provider (TS re-resolves auth with
    /// the model).
    api_key: Arc<Mutex<Option<String>>>,
    /// The serialized config queue (TS `configTask`): picker switches and
    /// the trigger-consuming arms observe one another through it, so an
    /// armed refinement never reads the pre-switch model mid-switch.
    config_queue: Arc<tokio::sync::Mutex<()>>,
    agent_dir: Arc<PathBuf>,
    provider_target: ProviderTargetSlot,
    autonomous_config: Option<pa_core::autonomous::AgentAutonomousConfig>,
    /// Session-scoped MCP servers live on the connection, exactly like the
    /// TS process-lifetime manager: one owner id fences them and
    /// `session/close` releases. Shared with the engine's prompt gating.
    mcp: Arc<std::sync::Mutex<pa_core::mcp::McpManager>>,
    mcp_owner_id: Arc<String>,
    mcp_server_names: Arc<Mutex<Vec<String>>>,
}

impl AcpModeState {
    /// The session's current model (the live slot the picker switch
    /// updates).
    async fn current_model(&self) -> Option<pa_types::ai::Model> {
        self.model.lock().await.clone()
    }

    /// The session's current request key (the live slot the picker switch
    /// updates).
    pub(super) async fn current_api_key(&self) -> Option<String> {
        self.api_key.lock().await.clone()
    }
}

/// One hosted session and its in-flight prompt turn, if any.
struct SessionEntry {
    session: Arc<AcpSession>,
    prompt_task: Option<tokio::task::JoinHandle<()>>,
    /// The picker state (TS `AcpSessionEntry`'s configOptions/models).
    config: Arc<InProcessConfig>,
    /// The agent-end refresh subscription (unsubscribed at close so a
    /// closed session stops refreshing — the listener would otherwise
    /// outlive the session and pin its state).
    config_refresh: Option<pa_agent::agent::Subscription>,
}

/// Run the ACP stdio mode until stdin closes. Returns the process exit code.
pub async fn run_acp_mode(options: AcpOptions) -> Result<i32> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(frame) = rx.recv().await {
            let Ok(mut line) = serde_json::to_string(&frame) else {
                continue;
            };
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdout.flush().await.is_err() {
                break;
            }
        }
    });

    let state = Arc::new(Mutex::new(ConnectionState::default()));
    let mode = AcpModeState {
        engine: options.engine.clone(),
        actual_cwd: Arc::new(options.actual_cwd.clone()),
        product_version: Arc::new(options.product_version.clone()),
        model: Arc::new(Mutex::new(options.model.clone())),
        api_key: Arc::new(Mutex::new(options.api_key.clone())),
        config_queue: Arc::new(tokio::sync::Mutex::new(())),
        agent_dir: Arc::new(options.agent_dir.clone()),
        provider_target: options.provider_target.clone(),
        autonomous_config: options.autonomous_config.clone(),
        // One MCP store with the engine's prompt gating (the core engine
        // builds it at session assembly): admitted servers reach the model
        // through the same manager the kernel `mcp.*` handlers resolve.
        mcp: options.engine.mcp_manager.clone(),
        mcp_owner_id: Arc::new(uuid::Uuid::new_v4().to_string()),
        mcp_server_names: Arc::new(Mutex::new(Vec::new())),
    };
    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut line = String::new();
    loop {
        line.clear();
        match stdin.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if line.trim().is_empty() {
            continue;
        }
        let request = match jsonrpc::parse_line(&line) {
            Ok(incoming) => incoming,
            Err(error_response) => {
                let _ = tx.send(error_response);
                continue;
            }
        };
        let handler = spawn_handler(request, state.clone(), mode.clone(), tx.clone());
        handler.await.ok();
    }

    // Exit when the client disconnects: stop the resident work, release the
    // subscription, fence the producer, and let the writer drain.
    teardown(&state, &mode).await;
    drop(tx);
    let _ = writer.await;
    Ok(0)
}

/// Stop the hosted session after stdin closes: abort work, settle the prompt
/// task, release the subscription, and fence the producer.
async fn teardown(state: &Arc<Mutex<ConnectionState>>, mode: &AcpModeState) {
    let entry = {
        let mut state = state.lock().await;
        state.session.take()
    };
    let Some(mut entry) = entry else {
        return;
    };
    entry.session.abort_auto_compaction();
    entry.session.agent().abort();
    entry.session.agent().clear_all_queues();
    entry.session.agent().wait_for_idle().await;
    if let Some(task) = entry.prompt_task.take() {
        let _ = task.await;
    }
    // The refresh listener goes away with the session, then the
    // serialized config work settles before the producer fences.
    if let Some(subscription) = entry.config_refresh.take() {
        subscription.unsubscribe().await;
    }
    let _ = mode.config_queue.lock().await;
    // The serialized dispose drain (TS `dispose`): a compaction can arm
    // the compact-trigger review with no further turn to service it —
    // close runs the round one last time, best-effort, before the
    // subscription tears down.
    entry.session.drain_compact_auto_refine_at_close(mode).await;
    entry.session.unsubscribe().await;
    entry.session.close_producer().await;
}

#[allow(clippy::too_many_arguments)]
fn spawn_handler(
    request: Incoming,
    state: Arc<Mutex<ConnectionState>>,
    mode: AcpModeState,
    tx: producer::FrameSink,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        match request {
            Incoming::Request { id, method, params } => {
                handle_request(id, method, params, state, mode, tx).await;
            }
            Incoming::Notification { method, params } => {
                handle_notification(method, params, state).await;
            }
        }
    })
}

#[allow(clippy::too_many_arguments)]
async fn handle_request(
    id: Value,
    method: String,
    params: Value,
    state: Arc<Mutex<ConnectionState>>,
    mode: AcpModeState,
    tx: producer::FrameSink,
) {
    match method.as_str() {
        "initialize" => handle_initialize(id, params, &mode.product_version, tx),
        "session/new" => {
            handle_session_new(id, params, state, mode, tx).await;
        }
        "session/prompt" => {
            prompt::handle_session_prompt(id, params, state, mode, tx).await;
        }
        "session/set_config_option" => {
            in_process_config::handle_set_config_option(id, params, state, mode, tx).await;
        }
        "session/close" => {
            handle_session_close(id, params, state, mode, tx).await;
        }
        other => {
            let _ = tx.send(jsonrpc::error_response(
                id,
                jsonrpc::METHOD_NOT_FOUND,
                &format!("\"Method not found\": {other}"),
                Some(json!({ "method": other })),
            ));
        }
    }
}

fn handle_initialize(id: Value, params: Value, product_version: &str, tx: producer::FrameSink) {
    if let Err(error_response) = validate_initialize(&id, &params) {
        let _ = tx.send(error_response);
        return;
    }
    let result = serde_json::to_value(initialize_result(product_version)).expect("serializes");
    let _ = tx.send(jsonrpc::response(id, result));
}

/// The `initialize` schema check the TS SDK performs: the protocol version
/// must be a number. The error body mirrors the observed TS response.
fn validate_initialize(id: &Value, params: &Value) -> std::result::Result<(), Value> {
    let field_error = |received: &str| {
        jsonrpc::error_response(
            id.clone(),
            jsonrpc::INVALID_PARAMS,
            "Invalid params",
            Some(json!({
                "_errors": [],
                "protocolVersion": {
                    "_errors": [format!("Invalid input: expected number, received {received}")]
                },
            })),
        )
    };
    match params.get("protocolVersion") {
        None => Err(field_error("undefined")),
        Some(value) if value.is_number() => Ok(()),
        Some(Value::String(_)) => Err(field_error("string")),
        Some(Value::Bool(_)) => Err(field_error("boolean")),
        Some(Value::Null) => Err(field_error("null")),
        Some(_) => Err(field_error("object")),
    }
}

async fn handle_notification(method: String, params: Value, state: Arc<Mutex<ConnectionState>>) {
    if method != "session/cancel" {
        return;
    }
    let session_id = session_id_params(&params);
    // Only cancel the addressed session: aborting unconditionally would kill
    // whichever turn happens to be running, and leave the real turn's stop
    // reason wrong.
    let session = {
        let state = state.lock().await;
        let Some(entry) = state
            .session
            .as_ref()
            .filter(|entry| entry.session.id == session_id && entry.prompt_task.is_some())
        else {
            return;
        };
        if entry.session.cancel_requested() {
            return;
        }
        entry.session.clone()
    };
    session.request_cancel();
    // TS `requestAbort` aborts the in-flight auto-compaction too, not
    // just the agent loop: an arm summarizer must not outlive the turn
    // it was cancelling.
    session.abort_auto_compaction();
    session.agent().abort();
    session.agent().clear_all_queues();
}

#[allow(clippy::too_many_arguments)]
async fn handle_session_new(
    id: Value,
    params: Value,
    state: Arc<Mutex<ConnectionState>>,
    mode: AcpModeState,
    tx: producer::FrameSink,
) {
    // Reserve the single-session slot before the first await: two
    // concurrent requests must not both pass the empty-slot check while
    // cwd reads are in flight.
    {
        let mut state = state.lock().await;
        if state.session.is_some() || state.session_new_in_flight || state.session_close_in_flight {
            let _ = tx.send(internal_error(
                &id,
                "prime-agent ACP mode hosts one session per connection; start another prime-agent process for a second session",
            ));
            return;
        }
        state.session_new_in_flight = true;
    }

    let result = session_new(&id, params, &mode, tx.clone()).await;

    let mut state = state.lock().await;
    state.session_new_in_flight = false;
    if let Ok(entry) = result {
        state.session = Some(entry);
    }
}

/// Admit one session. On failure the error response has already been queued.
async fn session_new(
    id: &Value,
    params: Value,
    mode: &AcpModeState,
    tx: producer::FrameSink,
) -> std::result::Result<SessionEntry, ()> {
    let params = NewSessionParams::parse(&params);
    // MCP admission precedes everything else in the session identity: a
    // rejected server list fails the request with the raw error payload.
    // The zod-shaped filter drops schema-invalid entries silently (SDK
    // `vecSkipError`); validation errors are `invalid params` with a
    // `reason`, admission failures internal errors with `details`.
    if let Err(mut response) = mcp::admit_session_servers(&params.mcp_servers, mode).await {
        if let Value::Object(_) = &response {
            if let Some(id_slot) = response.get_mut("id") {
                *id_slot = id.clone();
            }
        }
        let _ = tx.send(response);
        return Err(());
    }
    // The agent's cwd is fixed at startup; a client-supplied cwd is reported
    // back in `_meta` when it differs, never adopted.
    let mut cwd_mismatch = None;
    if let Some(requested) = params.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
        if !same_cwd(Path::new(requested), &mode.actual_cwd) {
            cwd_mismatch = Some(meta::PrimeAgentCwdMeta {
                requested: requested.to_string(),
                actual: mode.actual_cwd.display().to_string(),
            });
        }
    }

    // The session's picker state: discovery and the initial options must
    // not block admission (TS `entry.models = []` on a discovery failure).
    let config = admit_session_config(mode).await;

    let session_id = uuid::Uuid::new_v4().to_string();
    let producer = UpdateProducer::new(session_id.clone(), tx.clone());
    // Autonomous state is session-scoped, like the TS session it backs.
    let autonomous = Arc::new(tokio::sync::Mutex::new(create_autonomous_runtime_state(
        mode.autonomous_config.as_ref(),
        None,
    )));
    let driver: Arc<dyn pa_core::autonomous::AutonomousDriver> = Arc::new(
        pa_core::autonomous::ShellAutonomousDriver::new(mode.actual_cwd.as_path()),
    );
    let session = Arc::new(
        AcpSession::new(
            session_id.clone(),
            mode.engine.clone(),
            producer.clone(),
            autonomous,
            driver,
        )
        .await,
    );
    // The engine subscription refreshes the pickers at the end of every
    // agent run (the TS `agent_end` trigger), through the same serialized
    // queue as the request handler. The subscription is retained on the
    // entry so close removes it (a listener that outlives the session
    // keeps refreshing it).
    let config_refresh =
        in_process_config::wire_config_refresh(&session, Arc::clone(&config), mode.clone()).await;

    let mut result = json!({
        "sessionId": session_id,
        "configOptions": *config.published.lock().await,
    });
    if let Some(cwd_mismatch) = cwd_mismatch {
        result["_meta"] = meta::prime_agent_meta(PrimeAgentSessionMeta {
            cwd: Some(cwd_mismatch),
            ..Default::default()
        });
    }
    // Queue the admission response before opening the producer gate, so no
    // held update can precede it.
    let _ = tx.send(jsonrpc::response(id.clone(), result));
    session.producer().commit_session_new_response().await;
    Ok(SessionEntry {
        session,
        prompt_task: None,
        config,
        config_refresh: Some(config_refresh),
    })
}

async fn handle_session_close(
    id: Value,
    params: Value,
    state: Arc<Mutex<ConnectionState>>,
    mode: AcpModeState,
    tx: producer::FrameSink,
) {
    let session_id = session_id_params(&params);
    // Stop real work, not just local bookkeeping: closing aborts the
    // connection the same way session/cancel does.
    let taken = {
        let mut state = state.lock().await;
        if state.session_close_in_flight {
            None
        } else {
            match state.session.take() {
                Some(entry) if entry.session.id == session_id => {
                    state.session_close_in_flight = true;
                    Some(entry)
                }
                _ => {
                    let _ = tx.send(internal_error(
                        &id,
                        &format!("Unknown ACP session: {session_id}"),
                    ));
                    return;
                }
            }
        }
    };
    let Some(mut entry) = taken else {
        let _ = tx.send(internal_error(
            &id,
            &format!("ACP session is already closing: {session_id}"),
        ));
        return;
    };
    entry.session.abort_auto_compaction();
    entry.session.agent().abort();
    entry.session.agent().clear_all_queues();
    entry.session.agent().wait_for_idle().await;
    // The cancelled prompt resolves before the close response: the turn task
    // is awaited first and its frames already sit in the write queue.
    if let Some(task) = entry.prompt_task.take() {
        let _ = task.await;
    }
    // The refresh listener goes away with the session (no later agent
    // run refreshes a closed session), then the serialized config work
    // settles before the producer fences (TS `await configTask` in
    // `session/close`).
    if let Some(subscription) = entry.config_refresh.take() {
        subscription.unsubscribe().await;
    }
    let _ = mode.config_queue.lock().await;
    // The serialized dispose drain (TS `dispose`): a compaction can arm
    // the compact-trigger review with no further turn to service it —
    // close runs the round one last time, best-effort, before the
    // subscription tears down.
    entry
        .session
        .drain_compact_auto_refine_at_close(&mode)
        .await;
    entry.session.unsubscribe().await;
    // Keep the backing session fenced until a replacement ACP session is
    // admitted.
    entry.session.close_producer().await;
    mcp::release_session_servers(&mode).await;
    let _ = tx.send(jsonrpc::response(id, json!({})));
    let mut state = state.lock().await;
    state.session_close_in_flight = false;
}

/// The `session/prompt` success response: the terminal stop reason.
fn stop_reason_response(stop_reason: AcpStopReason) -> Value {
    serde_json::to_value(AcpStopReasonResponse { stop_reason }).expect("serializes")
}

fn internal_error(id: &Value, details: &str) -> Value {
    jsonrpc::error_response(
        id.clone(),
        jsonrpc::INTERNAL_ERROR,
        "Internal error",
        Some(json!({ "details": details })),
    )
}

/// The internal-error response with a null id, for handlers that apply the
/// request id after an async admission decision.
pub(super) fn internal_error_value(details: &str) -> Value {
    internal_error(&Value::Null, details)
}

/// Two paths are the same cwd when their canonical forms match, or when they
/// are the same directory on disk (dev/inode) — the bind-mount and
/// case-normalized-FS cases a lexical comparison misses.
fn same_cwd(requested: &Path, actual: &Path) -> bool {
    let canonical = |path: &Path| -> PathBuf {
        std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    };
    let requested = canonical(requested);
    let actual = canonical(actual);
    if requested == actual {
        return true;
    }
    #[cfg(unix)]
    {
        let identity = |path: &Path| -> Option<(u64, u64)> {
            use std::os::unix::fs::MetadataExt;
            let metadata = std::fs::metadata(path).ok()?;
            if metadata.dev() == 0 || metadata.ino() == 0 {
                return None;
            }
            Some((metadata.dev(), metadata.ino()))
        };
        if let (Some(left), Some(right)) = (identity(&requested), identity(&actual)) {
            return left == right;
        }
    }
    false
}
