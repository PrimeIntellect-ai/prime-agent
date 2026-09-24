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
mod jsonrpc;
mod mcp;
mod meta;
mod producer;
mod prompt;
mod session;
mod types;
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

use config_options::{
    acp_model_registry, config_options_value, discover_available_models, model_value,
    publish_config_options, session_config_options, PickerModel, ProviderTargetSlot,
    SessionConfigOption,
};

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
    api_key: Option<String>,
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
}

/// One hosted session and its in-flight prompt turn, if any.
struct SessionEntry {
    session: Arc<AcpSession>,
    prompt_task: Option<tokio::task::JoinHandle<()>>,
    /// The picker state (TS `AcpSessionEntry`'s configOptions/models) plus
    /// the serialized config queue (`configTask`).
    config: Arc<InProcessConfig>,
}

/// The in-process picker state: the published options, the discovered
/// models, and the serialized queue every config operation runs through
/// (TS `enqueueConfig`/`configTask` — close drains it before the
/// producer fences).
struct InProcessConfig {
    queue: tokio::sync::Mutex<()>,
    published: tokio::sync::Mutex<Vec<SessionConfigOption>>,
    models: tokio::sync::Mutex<Vec<pa_types::ai::Model>>,
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
        api_key: options.api_key.clone(),
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
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
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
    // The serialized config work settles before the producer fences.
    let _ = entry.config.queue.lock().await;
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
            handle_set_config_option(id, params, state, mode, tx).await;
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

    // The pickers ride the same engine the session runs on: discovery must
    // not block admission (TS `entry.models = []` on a discovery failure).
    let agent = mode.engine.session.agent().clone();
    let models = tokio::task::spawn_blocking({
        let agent_dir = mode.agent_dir.clone();
        move || discover_available_models(&agent_dir)
    })
    .await
    .ok()
    .and_then(|discovery| discovery.ok())
    .unwrap_or_default();
    let published = {
        let current = mode.current_model().await;
        let state = agent.state().await;
        let thinking_level =
            pa_core::session_engine::provider_adapter::model_thinking_level(state.thinking_level)
                .wire_name()
                .to_string();
        let levels = current
            .as_ref()
            .map(|model| {
                pa_ai::models::get_supported_thinking_levels(model)
                    .into_iter()
                    .map(|level| level.wire_name().to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        session_config_options(
            current.as_ref().map(PickerModel::from_model),
            &thinking_level,
            &levels,
            &models,
        )
    };
    let config = Arc::new(InProcessConfig {
        queue: tokio::sync::Mutex::new(()),
        published: tokio::sync::Mutex::new(published),
        models: tokio::sync::Mutex::new(models),
    });

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
    // queue as the request handler.
    wire_config_refresh(&session, config.clone(), mode.clone()).await;

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
    })
}

/// `session/set_config_option`: apply one picker selection and answer the
/// refreshed options (TS #2455). Config work is serialized through the
/// session's queue, so selections and event-driven refreshes observe one
/// another in arrival order.
async fn handle_set_config_option(
    id: Value,
    params: Value,
    state: Arc<Mutex<ConnectionState>>,
    mode: AcpModeState,
    tx: producer::FrameSink,
) {
    let params = types::SetConfigOptionParams::parse(&params);
    // The session resolves before the queue (TS reads `session?.id`).
    let resolved = {
        let state = state.lock().await;
        state
            .session
            .as_ref()
            .filter(|entry| entry.session.id == params.session_id)
            .map(|entry| (Arc::clone(&entry.session), Arc::clone(&entry.config)))
    };
    let Some((session, config)) = resolved else {
        let _ = tx.send(jsonrpc::error_response(
            id,
            jsonrpc::INVALID_PARAMS,
            "Invalid params",
            Some(json!({ "reason": format!("Unknown ACP session: {}", params.session_id) })),
        ));
        return;
    };
    // One config operation at a time (TS `enqueueConfig`): the queue also
    // serializes the agent-run refreshes.
    let _guard = config.queue.lock().await;
    // The queue can outlive the session: a close admitted between the
    // resolution and the run refuses further config work (TS
    // `sessionCloseInFlight`).
    let live = {
        let state = state.lock().await;
        !state.session_close_in_flight
            && state
                .session
                .as_ref()
                .is_some_and(|current| current.session.id == session.id)
    };
    let outcome = if live {
        apply_in_process_config(
            &session,
            &config,
            &mode,
            &params.config_id,
            params.value.as_str(),
        )
        .await
    } else {
        Err(ConfigOptionError::invalid_params(
            "ACP session is closed or closing",
        ))
    };
    let options = match outcome {
        Ok(options) => options,
        Err(error) => {
            let _ = tx.send(error.response(id));
            return;
        }
    };
    let _ = tx.send(jsonrpc::response(id, config_options_value(&options)));
}

/// One failed config operation: the TS handler's `RequestError` shape.
enum ConfigOptionError {
    InvalidParams(String),
    Internal(String),
}

impl ConfigOptionError {
    fn invalid_params(reason: &str) -> ConfigOptionError {
        ConfigOptionError::InvalidParams(reason.to_string())
    }

    /// The JSON-RPC error frame (the TS `invalidParams` data shape).
    fn response(self, id: Value) -> Value {
        match self {
            ConfigOptionError::InvalidParams(reason) => jsonrpc::error_response(
                id,
                jsonrpc::INVALID_PARAMS,
                "Invalid params",
                Some(json!({ "reason": reason })),
            ),
            ConfigOptionError::Internal(details) => internal_error(&id, &details),
        }
    }
}

/// Apply one selection (TS `session/set_config_option`'s handler body):
/// validate against the live session state, apply through the engine, then
/// return the refreshed options with the change published.
async fn apply_in_process_config(
    session: &Arc<AcpSession>,
    config: &Arc<InProcessConfig>,
    mode: &AcpModeState,
    config_id: &str,
    value: Option<&str>,
) -> Result<Vec<SessionConfigOption>, ConfigOptionError> {
    match (config_id, value) {
        ("model", Some(value)) => {
            let current = mode.current_model().await;
            let current_value = current
                .as_ref()
                .map(|model| model_value(&model.provider, &model.id));
            if current_value.as_deref() == Some(value) {
                // The current model re-selected: refresh only, no discovery
                // (a resync during a discovery outage still answers).
                return Ok(refresh_in_process_config(session, config, mode).await);
            }
            let models = discover_models(mode).await?;
            let model = models
                .iter()
                .find(|model| model_value(&model.provider, &model.id) == value)
                .cloned()
                .ok_or_else(|| {
                    ConfigOptionError::invalid_params(&format!("Unavailable model: {value}"))
                })?;
            apply_in_process_model_switch(session, mode, model).await?;
            *config.models.lock().await = models;
            Ok(refresh_in_process_config(session, config, mode).await)
        }
        ("thought_level", Some(value)) => {
            let current = mode.current_model().await;
            let levels = supported_levels(current.as_ref());
            let supported = current.as_ref().is_some_and(|model| model.reasoning)
                && levels.iter().any(|level| level == value);
            if !supported {
                return Err(ConfigOptionError::invalid_params(&format!(
                    "Unsupported reasoning effort: {value}"
                )));
            }
            apply_in_process_thinking_level(session, mode, value).await?;
            Ok(refresh_in_process_config(session, config, mode).await)
        }
        _ => Err(ConfigOptionError::invalid_params(&format!(
            "Invalid configuration option: {config_id}"
        ))),
    }
}

/// Discover the available models (TS `getAvailableModels`): the registry
/// the composition resolved against. Discovery failures are the handler's
/// "try again later" invalid-params.
async fn discover_models(
    mode: &AcpModeState,
) -> Result<Vec<pa_types::ai::Model>, ConfigOptionError> {
    tokio::task::spawn_blocking({
        let agent_dir = Arc::clone(&mode.agent_dir);
        move || discover_available_models(&agent_dir)
    })
    .await
    .map_err(|_| ConfigOptionError::Internal("model discovery task failed".to_string()))?
    .map_err(|_| {
        ConfigOptionError::invalid_params("Model discovery is unavailable; try again later")
    })
}

/// The model's supported thinking levels as wire names (TS
/// `availableThinkingLevels`).
fn supported_levels(model: Option<&pa_types::ai::Model>) -> Vec<String> {
    model
        .map(|model| {
            pa_ai::models::get_supported_thinking_levels(model)
                .into_iter()
                .map(|level| level.wire_name().to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Switch the session's model (TS `setModel`): swap the provider stream
/// target, set the agent's model, record the durable row and the settings
/// default, and restore the thinking level against the new model.
async fn apply_in_process_model_switch(
    session: &Arc<AcpSession>,
    mode: &AcpModeState,
    model: pa_types::ai::Model,
) -> Result<(), ConfigOptionError> {
    // The request key for the switched model: the same registry resolution
    // the create-time composition ran (TS re-registers the stream with the
    // model's own auth).
    let mut registry = tokio::task::spawn_blocking({
        let agent_dir = Arc::clone(&mode.agent_dir);
        move || acp_model_registry(&agent_dir)
    })
    .await
    .map_err(|_| ConfigOptionError::Internal("model registry task failed".to_string()))?;
    let resolved = registry.get_api_key_and_headers(&model, model.headers.as_ref());
    // The stream target swaps in place: the next turn streams on the
    // selected model (the service-tier preference survives the switch).
    {
        let mut target = mode.provider_target.write().expect("provider target lock");
        match target.as_mut() {
            Some(target) => {
                target.api_key = resolved.api_key;
                target.model = model.clone();
            }
            None => {
                *target = Some(pa_core::session_engine::provider_adapter::ProviderTarget {
                    api_key: resolved.api_key,
                    model: model.clone(),
                    service_tier: None,
                });
            }
        }
    }
    // The agent's model plus the durable `model_change` row (TS records
    // every switch, even to the current model).
    mode.engine
        .session
        .set_model(&model, &model.provider, &model.id)
        .await
        .map_err(|error| ConfigOptionError::Internal(format!("model switch failed: {error:#}")))?;
    // TS `session.setModel` persists the default provider/model so the
    // next session starts on the switched model.
    {
        let mut settings =
            pa_core::settings::SettingsManager::create(mode.actual_cwd.as_path(), &mode.agent_dir);
        let _ = settings.set_default_model_and_provider(model.provider.clone(), model.id.clone());
    }
    // The thinking level follows the switch (TS
    // `_getThinkingLevelForModelSwitch` + `setThinkingLevel`): the current
    // level when the current model reasons, else the settings default —
    // always clamped to the switched model.
    let previous = mode.current_model().await;
    let current_level = session.agent().state().await.thinking_level;
    let requested = if previous.as_ref().is_some_and(|model| model.reasoning) {
        pa_core::session_engine::provider_adapter::model_thinking_level(current_level)
    } else {
        let settings =
            pa_core::settings::SettingsManager::create(mode.actual_cwd.as_path(), &mode.agent_dir);
        settings
            .get_default_thinking_level()
            .map(pa_core::settings::ThinkingLevelSetting::model_level)
            .unwrap_or(pa_types::ai::ModelThinkingLevel::Medium)
    };
    let effective = pa_ai::models::clamp_thinking_level(&model, requested);
    apply_level_change(session, mode, effective, model.reasoning).await?;
    // The session's live model is the switched model (the session-command
    // executors follow it).
    *mode.model.lock().await = Some(model);
    Ok(())
}

/// Apply a thinking-level selection (TS `setThinkingLevel`): the level was
/// validated against the model's supported levels, so the agent follows it
/// and the durable row plus the settings default record the change.
async fn apply_in_process_thinking_level(
    session: &Arc<AcpSession>,
    mode: &AcpModeState,
    level: &str,
) -> Result<(), ConfigOptionError> {
    let parsed = pa_types::ai::thinking_level_from_str(level)
        .ok_or_else(|| ConfigOptionError::invalid_params("Invalid thinking level"))?;
    let current = mode.current_model().await;
    let reasoning = current.as_ref().is_some_and(|model| model.reasoning);
    apply_level_change(session, mode, parsed, reasoning).await
}

/// The shared level application: agent + durable row when the effective
/// level changed, settings default when the model reasons or the level is
/// not `off` (TS `setThinkingLevel`'s persist gate).
async fn apply_level_change(
    session: &Arc<AcpSession>,
    mode: &AcpModeState,
    level: pa_types::ai::ModelThinkingLevel,
    reasoning: bool,
) -> Result<(), ConfigOptionError> {
    let mapped = pa_core::session_engine::provider_adapter::map_thinking_level(level);
    let current = session.agent().state().await.thinking_level;
    if current == mapped {
        return Ok(());
    }
    mode.engine
        .session
        .set_thinking_level(mapped)
        .await
        .map_err(|error| {
            ConfigOptionError::Internal(format!("thinking level switch failed: {error:#}"))
        })?;
    if reasoning || level != pa_types::ai::ModelThinkingLevel::Off {
        let mut settings =
            pa_core::settings::SettingsManager::create(mode.actual_cwd.as_path(), &mode.agent_dir);
        let _ = settings.set_default_thinking_level(
            pa_core::settings::ThinkingLevelSetting::from_model_level(level),
        );
    }
    Ok(())
}

/// Recompute the options from the live session state and publish the
/// change (TS `refreshConfig`): the current model and thinking level are
/// the engine's own view, so an out-of-band switch still republishes.
async fn refresh_in_process_config(
    session: &Arc<AcpSession>,
    config: &Arc<InProcessConfig>,
    mode: &AcpModeState,
) -> Vec<SessionConfigOption> {
    let current = mode.current_model().await;
    let state = session.agent().state().await;
    let thinking_level =
        pa_core::session_engine::provider_adapter::model_thinking_level(state.thinking_level)
            .wire_name()
            .to_string();
    let options = session_config_options(
        current.as_ref().map(PickerModel::from_model),
        &thinking_level,
        &supported_levels(current.as_ref()),
        &config.models.lock().await,
    );
    publish_config_options(session.producer(), &config.published, options.clone()).await;
    options
}

/// Wire the picker refresh to the end of every agent run (the TS
/// `agent_end` trigger): the refresh is fire-and-forget through the
/// serialized queue, so the agent loop never waits on config work.
async fn wire_config_refresh(
    session: &Arc<AcpSession>,
    config: Arc<InProcessConfig>,
    mode: AcpModeState,
) {
    let agent = Arc::clone(session.agent());
    agent
        .subscribe(move |event, _signal| {
            let session = Arc::clone(session);
            let config = Arc::clone(&config);
            let mode = mode.clone();
            Box::pin(async move {
                if matches!(event, pa_agent::types::AgentEvent::AgentEnd { .. }) {
                    tokio::spawn(async move {
                        let _guard = config.queue.lock().await;
                        let _ = refresh_in_process_config(&session, &config, &mode).await;
                    });
                }
                Ok(())
            })
        })
        .await;
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
    // The serialized config work settles before the producer fences (TS
    // `await configTask` in `session/close`).
    let _ = entry.config.queue.lock().await;
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
