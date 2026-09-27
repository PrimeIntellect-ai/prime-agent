//! The daemon-attached ACP transport: the same ACP JSON-RPC surface served
//! over a client-owned daemon session (TS
//! `runAcpModeWithConnection(DaemonAgentConnection)`).
//!
//! `session/new` creates the client-owned daemon session (`--no-session`
//! semantics), admits its MCP servers through the
//! `replace_acp_mcp_servers` wire command, and every prompt runs
//! `prompt_and_wait` while the streamed session events fan out as ACP
//! updates. The turn settlement (response boundary, quiescence envelope,
//! stop reason) mirrors the in-process mode: both serve the same captures.
//! The daemon worker's `goal_update` session events surface through the
//! wire mapping (`wire_events.rs`), and the autonomous accounting rides the
//! `wait_for_headless_completion` response into the completion envelope
//! and the stop reason (TS `waitForHeadlessCompletion` + `acpStopReason`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use pa_types::daemon::{
    DaemonCommand, DaemonCommandEnvelope, DaemonCommandFrameType, DaemonProtocolInfo,
    DaemonResponse, DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION,
};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};

use super::jsonrpc::{self, Incoming};
use super::meta::{self, PrimeAgentEventPhase, PrimeAgentOutcome, PrimeAgentSessionMeta};
use super::producer::{self, UpdateProducer};
use super::types;
use super::wire_events::{self, WireMappingState};

/// Response timeout for turn-long commands (the turn itself bounds them).
const TURN_TIMEOUT_MS: u64 = 600_000;
/// Response timeout for session-scoped commands.
const REQUEST_TIMEOUT_MS: u64 = 30_000;

/// One inbound supervisor frame, classified by the reader.
enum LinkFrame {
    Event(Value),
    Response(DaemonResponse),
}

/// A client connection to the supervisor socket: JSONL command envelopes
/// out, responses matched by id, session events forwarded raw.
struct DaemonLink {
    writer: mpsc::UnboundedSender<String>,
    pending: Arc<std::sync::Mutex<HashMap<String, oneshot::Sender<DaemonResponse>>>>,
    frames: Mutex<mpsc::UnboundedReceiver<LinkFrame>>,
    protocol_version: u64,
    next_request_id: std::sync::atomic::AtomicU64,
}

impl DaemonLink {
    /// Connect and complete the `daemon_hello` handshake.
    async fn connect(socket_path: &Path) -> anyhow::Result<Self> {
        let stream = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            pa_types::platform::transport::connect_transport(socket_path),
        )
        .await
        .map_err(|_| anyhow::anyhow!("timed out connecting to the daemon socket"))??;
        let (reader_half, writer_half) = stream.split();
        let (line_tx, mut line_rx) = mpsc::unbounded_channel::<String>();
        let (frame_tx, frame_rx) = mpsc::unbounded_channel::<LinkFrame>();
        let (hello_tx, hello_rx) = oneshot::channel::<Value>();
        let pending: Arc<std::sync::Mutex<HashMap<String, oneshot::Sender<DaemonResponse>>>> =
            Arc::new(std::sync::Mutex::new(HashMap::new()));

        tokio::spawn(async move {
            let mut writer = writer_half;
            while let Some(line) = line_rx.recv().await {
                let mut payload = line.into_bytes();
                payload.push(b'\n');
                if writer.write_all(&payload).await.is_err() {
                    break;
                }
            }
            let _ = writer.shutdown().await;
        });
        // The reader only classifies frames; the consumer loop below owns
        // the ordering: every session event observed before a response on
        // the wire is published before that response resolves its caller,
        // so a turn's chunks always precede its boundary frames.
        tokio::spawn(async move {
            let mut reader = BufReader::new(reader_half);
            let mut line = String::new();
            let mut hello_tx = Some(hello_tx);
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
                    continue;
                };
                match value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                {
                    "daemon_hello" => {
                        if let Some(tx) = hello_tx.take() {
                            let _ = tx.send(value);
                        }
                    }
                    "response" => {
                        let Ok(response) = serde_json::from_value::<DaemonResponse>(value.clone())
                        else {
                            continue;
                        };
                        let _ = frame_tx.send(LinkFrame::Response(response));
                    }
                    "session_event" => {
                        let _ = frame_tx.send(LinkFrame::Event(value));
                    }
                    _ => {}
                }
            }
        });

        let hello = tokio::time::timeout(std::time::Duration::from_secs(3), hello_rx)
            .await
            .map_err(|_| anyhow::anyhow!("the daemon did not send its handshake"))?
            .map_err(|_| anyhow::anyhow!("the daemon connection closed before the handshake"))?;
        let protocol = hello
            .get("protocol")
            .cloned()
            .and_then(|p| serde_json::from_value::<DaemonProtocolInfo>(p).ok())
            .unwrap_or(DaemonProtocolInfo {
                name: DAEMON_PROTOCOL_NAME.to_string(),
                version: DAEMON_PROTOCOL_VERSION,
            });
        let version = protocol.version.min(DAEMON_PROTOCOL_VERSION);
        Ok(DaemonLink {
            writer: line_tx,
            pending,
            frames: Mutex::new(frame_rx),
            protocol_version: version,
            next_request_id: std::sync::atomic::AtomicU64::new(0),
        })
    }

    /// Send one command envelope and wait for the matching response.
    async fn request(
        &self,
        command: DaemonCommand,
        timeout_ms: u64,
    ) -> anyhow::Result<DaemonResponse> {
        use std::sync::atomic::Ordering;
        let id = format!(
            "acp-{}",
            self.next_request_id.fetch_add(1, Ordering::SeqCst) + 1
        );
        let envelope = DaemonCommandEnvelope {
            frame_type: DaemonCommandFrameType::Command,
            id: id.clone(),
            protocol: DaemonProtocolInfo {
                name: DAEMON_PROTOCOL_NAME.to_string(),
                version: self.protocol_version,
            },
            client_id: Some(format!("acp:{}", std::process::id())),
            command,
        };
        let line = serde_json::to_string(&envelope)?;
        let (tx, rx) = oneshot::channel::<DaemonResponse>();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        self.writer
            .send(line)
            .map_err(|_| anyhow::anyhow!("the daemon connection is closed"))?;
        tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), rx)
            .await
            .map_err(|_| {
                self.pending.lock().unwrap().remove(&id);
                anyhow::anyhow!("timed out waiting for the daemon response")
            })?
            .map_err(|_| anyhow::anyhow!("the daemon connection closed mid-request"))
    }
}

/// Everything the daemon-attached mode needs from the composition.
#[derive(Clone)]
pub struct DaemonAcpOptions {
    pub socket_path: PathBuf,
    pub actual_cwd: PathBuf,
    pub product_version: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
}

/// The hosted daemon session: the ACP identity, the daemon routing id, the
/// update producer, and the per-connection MCP owner state.
struct HostedSession {
    acp_session_id: String,
    daemon_active_session_id: String,
    producer: Arc<UpdateProducer>,
    mcp_owner_id: String,
    mcp_server_names: Vec<String>,
    cancel_requested: bool,
    /// The newest assistant stop reason observed on the event stream.
    assistant_stop_reason: Option<String>,
    /// Resolved when the worker emits the turn's last `agent_end` event:
    /// the worker sends its `prompt_and_wait` response BEFORE that marker,
    /// so the marker is the deterministic "every turn frame is on the
    /// wire" signal the settlement waits for (the supervisor's event relay
    /// may otherwise trail the response). One `agent_end` per agent run —
    /// retried and continued runs restart with their own pair — so the
    /// marker resolves only when every started run ended (a fallback
    /// `agent_end` for a run without a model turn settles immediately).
    turn_emitted: Option<oneshot::Sender<()>>,
    /// `agent_start` frames seen since the marker armed.
    agent_runs_started: u64,
    /// `agent_end` frames seen since the marker armed.
    agent_runs_ended: u64,
}

/// The daemon-attached transport state: one hosted session at most, like
/// the in-process connection state.
#[derive(Default)]
struct DaemonAcpState {
    session: Option<HostedSession>,
    session_new_in_flight: bool,
    session_close_in_flight: bool,
}

/// Serve the daemon-attached ACP mode until stdin closes. The caller
/// guarantees the socket answers (the composition spawns a supervisor
/// when none is listening); a daemon that drops mid-session fails the
/// hosted session's requests, exactly like the TS daemon connection.
///
/// # Errors
///
/// Returns an error when the daemon socket connect fails; a daemon that
/// drops mid-session fails the hosted session's requests instead, exactly
/// like the TS daemon connection.
///
/// # Panics
///
/// The frame-consumer task panics when the link's pending-response map
/// lock is poisoned (a holder panicked while holding it).
pub async fn run_daemon_attached_acp_mode(options: DaemonAcpOptions) -> anyhow::Result<i32> {
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

    let link = Arc::new(DaemonLink::connect(&options.socket_path).await?);
    let state = Arc::new(Mutex::new(DaemonAcpState::default()));

    // Session events and responses share one socket, so one consumer owns
    // the ordering: events publish at the active turn before the response
    // resolves the waiting request (a turn's chunks can never trail its
    // boundary frames).
    {
        let link = Arc::clone(&link);
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let mut mapping = WireMappingState::default();
            let mut frames = link.frames.lock().await;
            while let Some(frame) = frames.recv().await {
                match frame {
                    LinkFrame::Event(frame) => {
                        let event = frame.get("event").cloned().unwrap_or(Value::Null);
                        let mut guard = state.lock().await;
                        let Some(current) = guard.session.as_mut() else {
                            continue;
                        };
                        if let Some(stop) = wire_events::assistant_stop(&event) {
                            current.assistant_stop_reason = stop.stop_reason;
                        }
                        // The worker's post-turn marker: the settlement
                        // waiting on it may resume once every agent run of
                        // the turn ended (a retried or continued run
                        // restarts with its own `agent_start`, so the LAST
                        // `agent_end` is the marker — an early one leaves
                        // the trailing retry frames behind the settlement).
                        match event.get("type").and_then(Value::as_str) {
                            Some("agent_start") => current.agent_runs_started += 1,
                            Some("agent_end") => {
                                current.agent_runs_ended += 1;
                                if current.agent_runs_ended >= current.agent_runs_started.max(1) {
                                    if let Some(emitted) = current.turn_emitted.take() {
                                        let _ = emitted.send(());
                                    }
                                }
                            }
                            _ => {}
                        }
                        let turn_id = current.producer.active_prompt_turn().await;
                        for update in wire_events::wire_updates(&event, &mut mapping) {
                            let _ = current
                                .producer
                                .publish(&update, turn_id, PrimeAgentEventPhase::Event, None)
                                .await;
                        }
                    }
                    LinkFrame::Response(response) => {
                        let id = response.id.clone().unwrap_or_default();
                        if let Some(tx) = link.pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(response);
                        }
                    }
                }
            }
        });
    }

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
        let incoming = match jsonrpc::parse_line(&line) {
            Ok(incoming) => incoming,
            Err(error_response) => {
                let _ = tx.send(error_response);
                continue;
            }
        };
        // Handlers run concurrently (like the TS acp agent's request
        // handling): a prompt turn may span minutes, and `session/cancel`
        // must reach the daemon while it is in flight. The state machine
        // (one hosted session, one in-flight close) keeps the concurrency
        // bounded.
        // Frame-order admission for `session/prompt` (TS ordering parity):
        // the spawned handlers race each other, but TS runs a request's
        // synchronous prefix before the next frame's handler. A
        // `session/cancel` that arrives after the prompt must win, so the
        // prompt's cancel-flag reset happens here, in read order, instead
        // of inside the spawned prompt task.
        if matches!(&incoming, Incoming::Request { method, .. } if method == "session/prompt") {
            if let Some(hosted) = state.lock().await.session.as_mut() {
                hosted.cancel_requested = false;
            }
        }
        let link = Arc::clone(&link);
        let state = Arc::clone(&state);
        let options = options.clone();
        let options_tx = tx.clone();
        tokio::spawn(async move {
            handle_incoming(incoming, &link, &state, &options, options_tx).await;
        });
    }

    // A client-owned session dies with the connection: stop the work,
    // release the servers, and kill the worker (TS dispose semantics).
    teardown(&link, &state).await;
    drop(tx);
    let _ = writer.await;
    Ok(0)
}

/// One incoming ACP frame. Requests answer; notifications may drive state.
async fn handle_incoming(
    incoming: Incoming,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    options: &DaemonAcpOptions,
    tx: producer::FrameSink,
) {
    match incoming {
        Incoming::Request { id, method, params } => {
            handle_request(id, method, params, link, state, options, tx).await;
        }
        Incoming::Notification { method, params } => {
            // `session/cancel` also arrives as a notification; treat it
            // like the request form without a response.
            if method == "session/cancel" {
                let _ = session_cancel(params, link, state).await;
            }
        }
    }
}

async fn handle_request(
    id: Value,
    method: String,
    params: Value,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    options: &DaemonAcpOptions,
    tx: producer::FrameSink,
) {
    match method.as_str() {
        "initialize" => {
            let result = serde_json::to_value(types::initialize_result(&options.product_version))
                .expect("serializes");
            let _ = tx.send(jsonrpc::response(id, result));
        }
        "session/new" => {
            handle_session_new(id, params, link, state, options, tx).await;
        }
        "session/prompt" => {
            handle_session_prompt(id, params, link, state, tx).await;
        }
        "session/cancel" => {
            let _ = session_cancel(params, link, state).await;
            let _ = tx.send(jsonrpc::response(id, json!({})));
        }
        "session/close" => {
            handle_session_close(id, params, link, state, tx).await;
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

/// Admit one session: create the client-owned daemon session, attach, and
/// admit the MCP servers through the wire command.
async fn handle_session_new(
    id: Value,
    params: Value,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    options: &DaemonAcpOptions,
    tx: producer::FrameSink,
) {
    {
        let mut guard = state.lock().await;
        if guard.session.is_some() || guard.session_new_in_flight || guard.session_close_in_flight {
            let _ = tx.send(super::internal_error(
                &id,
                "prime-agent ACP mode hosts one session per connection; start another prime-agent process for a second session",
            ));
            return;
        }
        guard.session_new_in_flight = true;
    }
    // Failures below clear the in-flight flag on the way out; on success
    // the hosted session takes the slot.
    let params = types::NewSessionParams::parse(&params);
    // MCP admission runs first, exactly like the in-process path: a
    // rejected list fails the request with the same error payloads.
    let resolved =
        match super::mcp::resolve_acp_mcp_servers(&params.mcp_servers, &options.actual_cwd) {
            Ok(resolved) => resolved,
            Err(reason) => {
                *state.lock().await = DaemonAcpState::default();
                let _ = tx.send(jsonrpc::error_response(
                    id,
                    jsonrpc::INVALID_PARAMS,
                    "Invalid params",
                    Some(json!({ "reason": reason })),
                ));
                return;
            }
        };
    if let Err(details) = super::mcp::acp_mcp_tool_names(&resolved) {
        *state.lock().await = DaemonAcpState::default();
        let _ = tx.send(super::internal_error(&id, &details));
        return;
    }

    // The client-owned daemon session: `--no-session` semantics, the same
    // model selection the process resolved.
    let mut config = json!({ "cwd": options.actual_cwd.display().to_string() });
    // Verification seam: a scripted daemon session (the same `{"engine":
    // "faux", ...}` form the in-process e2e rides). The product never sets
    // it; the supervisor turns the path into the worker's script env.
    if let Some(script) = std::env::var_os("PRIME_AGENT_ACP_DAEMON_SCRIPT") {
        config["script"] = Value::String(script.to_string_lossy().to_string());
    }
    if let Some(provider) = &options.provider {
        config["provider"] = json!(provider);
    }
    if let Some(model) = &options.model {
        config["model"] = json!(model);
    }
    if let Some(api_key) = &options.api_key {
        config["apiKey"] = json!(api_key);
    }
    let create = DaemonCommand::Create {
        id: None,
        session_path: None,
        continue_recent: None,
        no_session: Some(true),
        name: None,
        config: Some(config),
        // ACP-created sessions follow the worker's own telemetry posture
        // (settings + env); external clients never toggle telemetry.
        telemetry_disabled: None,
        runtime_metadata: None,
        lifecycle: None,
        env: None,
        launch_env: None,
        rest: Map::default(),
    };
    let create_response = match link.request(create, REQUEST_TIMEOUT_MS).await {
        Ok(response) => response,
        Err(error) => {
            *state.lock().await = DaemonAcpState::default();
            let _ = tx.send(super::internal_error(&id, &error.to_string()));
            return;
        }
    };
    if !create_response.success {
        let failure = create_response
            .error
            .unwrap_or_else(|| "unknown error".to_string());
        *state.lock().await = DaemonAcpState::default();
        let _ = tx.send(super::internal_error(&id, &failure));
        return;
    }
    let summary = create_response.data.unwrap_or(Value::Null);
    let daemon_active_session_id = summary
        .get("activeSessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_default();

    let attach = DaemonCommand::Attach {
        id: None,
        active_session_id: daemon_active_session_id.clone(),
        supports_extension_ui: Some(false),
        client_id: None,
        capabilities: None,
        resume_cursor: None,
        telemetry_disabled: None,
        recovery_config: None,
        env: None,
        launch_env: None,
        rest: Map::default(),
    };
    if let Ok(response) = link.request(attach, REQUEST_TIMEOUT_MS).await {
        if !response.success {
            let failure = response
                .error
                .unwrap_or_else(|| "unknown error".to_string());
            let _ = link
                .request(
                    DaemonCommand::Kill {
                        id: None,
                        active_session_id: daemon_active_session_id.clone(),
                        rest: Map::default(),
                    },
                    REQUEST_TIMEOUT_MS,
                )
                .await;
            *state.lock().await = DaemonAcpState::default();
            let _ = tx.send(super::internal_error(&id, &failure));
            return;
        }
    }

    let acp_session_id = uuid::Uuid::new_v4().to_string();
    let producer = UpdateProducer::new(acp_session_id.clone(), tx.clone());
    let mcp_owner_id = uuid::Uuid::new_v4().to_string();
    let mut hosted = HostedSession {
        acp_session_id: acp_session_id.clone(),
        daemon_active_session_id,
        producer,
        mcp_owner_id,
        mcp_server_names: Vec::new(),
        cancel_requested: false,
        assistant_stop_reason: None,
        turn_emitted: None,
        agent_runs_started: 0,
        agent_runs_ended: 0,
    };
    // The ACP MCP servers ride the wire command, not a local manager.
    if let Err(error) = replace_session_servers(link, &hosted, &resolved).await {
        let failure = error.to_string();
        let _ = link
            .request(
                DaemonCommand::Kill {
                    id: None,
                    active_session_id: hosted.daemon_active_session_id.clone(),
                    rest: Map::default(),
                },
                REQUEST_TIMEOUT_MS,
            )
            .await;
        *state.lock().await = DaemonAcpState::default();
        let _ = tx.send(super::internal_error(&id, &failure));
        return;
    }
    hosted.mcp_server_names = resolved
        .iter()
        .map(pa_core::mcp::AcpMcpServerConfig::name)
        .map(str::to_string)
        .collect();

    // Queue the admission response before opening the producer gate.
    let mut result = json!({ "sessionId": acp_session_id });
    if let Some(requested) = params.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
        let actual = options.actual_cwd.display().to_string();
        if !super::same_cwd(Path::new(requested), &options.actual_cwd) {
            result["_meta"] = meta::prime_agent_meta(PrimeAgentSessionMeta {
                cwd: Some(meta::PrimeAgentCwdMeta {
                    requested: requested.to_string(),
                    actual,
                }),
                ..Default::default()
            });
        }
    }
    let _ = tx.send(jsonrpc::response(id, result));
    hosted.producer.commit_session_new_response().await;
    let mut guard = state.lock().await;
    guard.session_new_in_flight = false;
    guard.session = Some(hosted);
}

/// Send the MCP replacement for one hosted session (the wire form of the
/// in-process manager call).
async fn replace_session_servers(
    link: &Arc<DaemonLink>,
    hosted: &HostedSession,
    resolved: &[pa_core::mcp::AcpMcpServerConfig],
) -> anyhow::Result<()> {
    let response = link
        .request(
            DaemonCommand::ReplaceAcpMcpServers {
                id: None,
                active_session_id: hosted.daemon_active_session_id.clone(),
                owner_id: hosted.mcp_owner_id.clone(),
                servers: serde_json::to_value(resolved)?,
                rest: Map::default(),
            },
            REQUEST_TIMEOUT_MS,
        )
        .await?;
    if !response.success {
        anyhow::bail!(response
            .error
            .unwrap_or_else(|| "unknown error".to_string()));
    }
    Ok(())
}

/// Run one prompt turn: `prompt_and_wait` while the event stream fans out.
async fn handle_session_prompt(
    id: Value,
    params: Value,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    tx: producer::FrameSink,
) {
    let params = types::PromptParams::parse(&params);
    let admitted = match super::session::AdmittedPrompt::parse(&params.prompt) {
        Ok(admitted) => admitted,
        Err(error) => {
            let _ = tx.send(super::session::prompt_block_error(&id, error));
            return;
        }
    };
    let (producer, hosted_daemon_session_id) = {
        let mut guard = state.lock().await;
        match guard.session.as_mut() {
            Some(hosted) if hosted.acp_session_id == params.session_id => {
                // TS `entry.cancelling`: a prompt admitted while a cancel
                // is in flight is dropped by the cancel and answers the
                // protocol stop reason instead of running a turn. Taking
                // the flag (not clearing it) settles the cancel so the
                // next prompt runs normally. The reader loop already reset
                // the flag in frame order when it admitted this prompt, so
                // this only fires for a cancel that arrived between the
                // prompt frame's admission and this task starting.
                if std::mem::take(&mut hosted.cancel_requested) {
                    let _ = tx.send(jsonrpc::response(
                        id,
                        serde_json::to_value(types::AcpStopReasonResponse {
                            stop_reason: types::AcpStopReason::Cancelled,
                        })
                        .expect("serializes"),
                    ));
                    return;
                }
                (
                    Arc::clone(&hosted.producer),
                    hosted.daemon_active_session_id.clone(),
                )
            }
            _ => {
                let _ = tx.send(super::internal_error(
                    &id,
                    &format!("Unknown ACP session: {}", params.session_id),
                ));
                return;
            }
        }
    };
    let turn_id = producer.begin_prompt().await;
    // The turn-end marker: the consumer loop resolves it on the worker's
    // post-turn `agent_end` event (after the `prompt_and_wait` response).
    let (emitted_tx, emitted_rx) = oneshot::channel::<()>();
    if let Some(hosted) = state.lock().await.session.as_mut() {
        hosted.turn_emitted = Some(emitted_tx);
        hosted.agent_runs_started = 0;
        hosted.agent_runs_ended = 0;
    }
    let prompt = DaemonCommand::PromptAndWait {
        id: None,
        active_session_id: hosted_daemon_session_id.clone(),
        message: admitted.text,
        input: pa_types::daemon::PromptInput {
            content: None,
            images: None,
            streaming_behavior: None,
            queue_if_busy: None,
            expand_prompt_templates: None,
            source: None,
            agent_message_id: None,
            custom_message: None,
            queue_key: None,
            prefix_messages: None,
            admission_id: None,
            rlm_notice_nonce: None,
        },
        rest: Map::default(),
    };
    let response = match link.request(prompt, TURN_TIMEOUT_MS).await {
        Ok(response) => response,
        Err(error) => {
            producer.finish_prompt(turn_id).await;
            let _ = tx.send(super::internal_error(&id, &error.to_string()));
            return;
        }
    };
    // The worker answers the response before its post-turn marker; wait
    // for the marker so every turn frame is published before the settle
    // (the event relay may otherwise trail the response). A prompt that
    // failed before any run started (the aborted-before-delivery cancel:
    // no agent_start/agent_end ever follows) resolves the marker now -
    // the settle must not pay the full marker window for a turn that
    // never ran.
    let marker_resolved = {
        let mut guard = state.lock().await;
        matches!(
            guard.session.as_mut(),
            Some(hosted) if hosted.agent_runs_started == 0
        )
    };
    if !response.success && marker_resolved {
        let mut guard = state.lock().await;
        if let Some(hosted) = guard.session.as_mut() {
            if let Some(emitted) = hosted.turn_emitted.take() {
                let _ = emitted.send(());
            }
        }
    }
    let _ = tokio::time::timeout(std::time::Duration::from_secs(30), emitted_rx).await;
    // Read-and-take the flag (TS clears `entry.cancelling` when the
    // cancel settles): this turn settles as cancelled, the next starts clean.
    let cancelled = state
        .lock()
        .await
        .session
        .as_mut()
        .is_none_or(|hosted| std::mem::take(&mut hosted.cancel_requested));
    if cancelled {
        producer.finish_prompt(turn_id).await;
        let _ = tx.send(jsonrpc::response(
            id,
            serde_json::to_value(types::AcpStopReasonResponse {
                stop_reason: types::AcpStopReason::Cancelled,
            })
            .expect("serializes"),
        ));
        return;
    }
    let outcome = if response.success {
        PrimeAgentOutcome::Result
    } else {
        PrimeAgentOutcome::Error
    };
    // The autonomous accounting for the completion envelope: the daemon's
    // headless-completion status (TS `waitForHeadlessCompletion`), fetched
    // after the turn marker settled the run. A failed fetch degrades to no
    // autonomous meta (the envelope still settles, like an in-process
    // session without a run).
    let autonomous_status = if response.success {
        fetch_autonomous_status(link, &hosted_daemon_session_id).await
    } else {
        None
    };
    let autonomous_meta = autonomous_status
        .as_ref()
        .filter(|status| status.enabled)
        .map(meta::autonomous_meta);
    // The remaining continuation slots the quiescence observation reports
    // (the in-process settlement computes the same subtraction).
    let remaining_continuations = autonomous_status
        .as_ref()
        .filter(|status| status.enabled)
        .map_or(0, |status| {
            status
                .limits
                .max_continuations
                .saturating_sub(status.continuations_used)
        });
    // The boundary, completion, and terminal quiescence frames match the
    // in-process settlement because both serve the same captures.
    let boundary = types::AcpSessionUpdate::SessionInfoUpdate {
        meta: meta::prime_agent_meta(PrimeAgentSessionMeta {
            terminal_quiescence_expected: Some(true),
            ..Default::default()
        }),
    };
    let published = producer
        .publish(
            &boundary,
            turn_id,
            PrimeAgentEventPhase::ResponseBoundary,
            Some(outcome),
        )
        .await;
    // The completion envelope mirrors the in-process settlement: the
    // autonomous accounting rides the quiescence event, then the terminal
    // quiescence envelope repeats the observation.
    let quiescence = types::AcpSessionUpdate::SessionInfoUpdate {
        meta: meta::prime_agent_meta(PrimeAgentSessionMeta {
            autonomous: autonomous_meta.clone(),
            quiescence: Some(meta::PrimeAgentQuiescenceMeta {
                outstanding_subagents: 0,
                remaining_autonomous_continuations: remaining_continuations,
            }),
            ..Default::default()
        }),
    };
    let completion_published = producer
        .publish(&quiescence, turn_id, PrimeAgentEventPhase::Event, None)
        .await;
    let terminal = types::AcpSessionUpdate::SessionInfoUpdate {
        meta: meta::prime_agent_meta(PrimeAgentSessionMeta {
            autonomous: autonomous_meta.clone(),
            quiescence: Some(meta::PrimeAgentQuiescenceMeta {
                outstanding_subagents: 0,
                remaining_autonomous_continuations: remaining_continuations,
            }),
            ..Default::default()
        }),
    };
    let terminal_published = producer
        .publish(
            &terminal,
            turn_id,
            PrimeAgentEventPhase::TerminalQuiescence,
            Some(outcome),
        )
        .await;
    producer.finish_prompt(turn_id).await;
    if !published || !completion_published || !terminal_published {
        let _ = tx.send(super::internal_error(
            &id,
            "Failed to publish ACP completion",
        ));
        return;
    }
    if !response.success {
        let failure = response
            .error
            .unwrap_or_else(|| "unknown error".to_string());
        let _ = tx.send(super::internal_error(
            &id,
            &format!("prime-agent turn failed: {failure}"),
        ));
        return;
    }
    // The stop reason follows the TS mapping (acp-stop-reason.ts): a limit
    // reached on the enabled run is the only non-end_turn outcome.
    let stop_reason = meta::acp_stop_reason_for_status(false, autonomous_status.as_ref());
    let _ = tx.send(jsonrpc::response(
        id,
        serde_json::to_value(types::AcpStopReasonResponse { stop_reason }).expect("serializes"),
    ));
}

/// Fetch the session's autonomous-run status (`wait_for_headless_completion`
/// on the daemon wire; TS `waitForHeadlessCompletion`). `None` degrades the
/// settlement to no autonomous meta, never to a failed prompt.
async fn fetch_autonomous_status(
    link: &Arc<DaemonLink>,
    active_session_id: &str,
) -> Option<pa_core::autonomous::AgentAutonomousStatus> {
    let response = link
        .request(
            DaemonCommand::WaitForHeadlessCompletion {
                id: None,
                active_session_id: active_session_id.to_string(),
                wait_for_rlm_quiescence: None,
                rest: Map::default(),
            },
            TURN_TIMEOUT_MS,
        )
        .await
        .ok()?;
    if !response.success {
        return None;
    }
    serde_json::from_value(response.data.unwrap_or(Value::Null)).ok()
}

/// Abort the hosted session's work (the request and notification forms).
async fn session_cancel(
    params: Value,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
) -> anyhow::Result<()> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut guard = state.lock().await;
    let Some(hosted) = guard
        .session
        .as_mut()
        .filter(|hosted| hosted.acp_session_id == session_id)
    else {
        return Ok(());
    };
    hosted.cancel_requested = true;
    let abort = DaemonCommand::Abort {
        id: None,
        active_session_id: hosted.daemon_active_session_id.clone(),
        rest: Map::default(),
    };
    drop(guard);
    let _ = link.request(abort, REQUEST_TIMEOUT_MS).await;
    Ok(())
}

/// Close: abort, release the servers, kill the client-owned worker, fence
/// the producer.
async fn handle_session_close(
    id: Value,
    params: Value,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    tx: producer::FrameSink,
) {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let taken = {
        let mut guard = state.lock().await;
        match guard.session.take() {
            Some(hosted) if hosted.acp_session_id == session_id => {
                guard.session_close_in_flight = true;
                Some(hosted)
            }
            _ => None,
        }
    };
    let Some(hosted) = taken else {
        let _ = tx.send(super::internal_error(
            &id,
            &format!("Unknown ACP session: {session_id}"),
        ));
        return;
    };
    let _ = link
        .request(
            DaemonCommand::Abort {
                id: None,
                active_session_id: hosted.daemon_active_session_id.clone(),
                rest: Map::default(),
            },
            REQUEST_TIMEOUT_MS,
        )
        .await;
    if !hosted.mcp_server_names.is_empty() {
        let _ = replace_session_servers(link, &hosted, &[]).await;
    }
    hosted.producer.close().await;
    let _ = link
        .request(
            DaemonCommand::Kill {
                id: None,
                active_session_id: hosted.daemon_active_session_id.clone(),
                rest: Map::default(),
            },
            REQUEST_TIMEOUT_MS,
        )
        .await;
    let _ = tx.send(jsonrpc::response(id, json!({})));
    let mut guard = state.lock().await;
    guard.session_close_in_flight = false;
}

/// Stop everything after stdin closes (TS dispose semantics).
async fn teardown(link: &Arc<DaemonLink>, state: &Arc<Mutex<DaemonAcpState>>) {
    let hosted = state.lock().await.session.take();
    let Some(hosted) = hosted else {
        return;
    };
    let _ = link
        .request(
            DaemonCommand::Abort {
                id: None,
                active_session_id: hosted.daemon_active_session_id.clone(),
                rest: Map::default(),
            },
            REQUEST_TIMEOUT_MS,
        )
        .await;
    let _ = link
        .request(
            DaemonCommand::Kill {
                id: None,
                active_session_id: hosted.daemon_active_session_id.clone(),
                rest: Map::default(),
            },
            REQUEST_TIMEOUT_MS,
        )
        .await;
    hosted.producer.close().await;
}
