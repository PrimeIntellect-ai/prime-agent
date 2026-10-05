//! The daemon-attached ACP transport: the same ACP JSON-RPC surface served
//! over a daemon session (TS
//! `runAcpModeWithConnection(DaemonAgentConnection)`).
//!
//! Startup creates and attaches the daemon session the CLI session flags
//! select. `session/new` binds it, admits its MCP servers through the
//! `replace_acp_mcp_servers` wire command, and every prompt runs
//! `prompt_and_wait` while the streamed session events fan out as ACP
//! updates. The turn settlement (response boundary, completion envelope
//! with the live outstanding-subagent count, terminal frame after the RLM
//! family settles, stop reason) mirrors the TS captures, and the stop
//! sequence cancels the outstanding children (TS #1612).
//! The daemon worker's `goal_update` session events surface through the
//! wire mapping (`wire_events.rs`), and the autonomous accounting rides the
//! `wait_for_headless_completion` response into the completion envelope
//! and the stop reason (TS `waitForHeadlessCompletion` + `acpStopReason`).
//!
//! The model and effort pickers (TS #2455) ride the worker's own wire
//! commands: `get_connection_state` for the live model/level,
//! `get_available_models` for discovery, `set_model` /
//! `set_thinking_level` for the applied selection.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use pa_types::daemon::{
    DaemonCommand, DaemonCommandEnvelope, DaemonCommandFrameType, DaemonProtocolInfo,
    DaemonResponse, DaemonSessionLifecycle, DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION,
};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};

use super::jsonrpc::{self, Incoming};
use super::meta::{self, PrimeAgentEventPhase, PrimeAgentOutcome, PrimeAgentSessionMeta};
use super::producer::{self, UpdateProducer};
use super::types;
use super::wire_config::{
    fetch_available_models, fetch_connection_state, handle_set_config_option,
    picker_options_from_state, refresh_wire_config, HostedConfig,
};
use super::wire_events::{self, WireMappingState};

/// Response timeout for session-scoped commands.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// One inbound supervisor frame, classified by the reader.
enum LinkFrame {
    Event(Value),
    Response(DaemonResponse),
    /// The daemon-global heartbeat-catalog broadcast the supervisor
    /// re-broadcasts to every client (`heartbeats_changed`).
    HeartbeatsChanged,
}

/// A client connection to the supervisor socket: JSONL command envelopes
/// out, responses matched by id, session events forwarded raw.
pub(crate) struct DaemonLink {
    writer: mpsc::UnboundedSender<String>,
    pending: Arc<std::sync::Mutex<HashMap<String, oneshot::Sender<DaemonResponse>>>>,
    /// Set once the frame channel ends (the socket closed and every
    /// frame the reader read is delivered): every new request fails
    /// fast instead of waiting for a response no one will send.
    closed: Arc<std::sync::atomic::AtomicBool>,
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
        let closed: Arc<std::sync::atomic::AtomicBool> =
            Arc::new(std::sync::atomic::AtomicBool::new(false));

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
                    "heartbeats_changed" => {
                        let _ = frame_tx.send(LinkFrame::HeartbeatsChanged);
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
            closed,
            frames: Mutex::new(frame_rx),
            protocol_version: version,
            next_request_id: std::sync::atomic::AtomicU64::new(0),
        })
    }

    /// Send one command envelope and wait for the matching response
    /// under the session-scoped response timeout.
    pub(crate) async fn request(&self, command: DaemonCommand) -> anyhow::Result<DaemonResponse> {
        self.exchange(command, Some(REQUEST_TIMEOUT)).await
    }

    /// Send one command envelope with no fixed cap: the response or the
    /// link close ends the wait (turn-long commands — declared
    /// divergence, TS caps them at 24 h; the link-close signal is the
    /// liveness bound here, not a timer).
    async fn request_until_close(&self, command: DaemonCommand) -> anyhow::Result<DaemonResponse> {
        self.exchange(command, None).await
    }

    /// One exchange: register the response slot, send the envelope, and
    /// wait for the answer.
    async fn exchange(
        &self,
        command: DaemonCommand,
        timeout: Option<std::time::Duration>,
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
        // A request that races the close loses either way: the flag
        // fails it here, or the pending clear already dropped its
        // sender. The flag is stored before the clear, so no request
        // parks unnoticed.
        if self.closed.load(Ordering::SeqCst) {
            self.pending.lock().unwrap().remove(&id);
            anyhow::bail!("the daemon connection is closed");
        }
        if self.writer.send(line).is_err() {
            // A closed writer leaves the pending slot behind otherwise; a
            // link that never answers again would grow one entry per
            // request.
            self.pending.lock().unwrap().remove(&id);
            anyhow::bail!("the daemon connection is closed");
        }
        match timeout {
            Some(timeout) => tokio::time::timeout(timeout, rx).await.map_err(|_| {
                self.pending.lock().unwrap().remove(&id);
                anyhow::anyhow!("timed out waiting for the daemon response")
            })?,
            None => rx.await,
        }
        .map_err(|_| anyhow::anyhow!("the daemon connection closed mid-request"))
    }
}

/// Everything the daemon-attached mode needs from the composition.
#[derive(Clone)]
pub struct DaemonAcpOptions {
    pub socket_path: PathBuf,
    pub actual_cwd: PathBuf,
    pub product_version: String,
    /// The startup `create` built from the CLI session flags.
    pub create: DaemonCommand,
}

/// The daemon session this connection created at startup; every
/// `session/new` binds it.
#[derive(Clone)]
struct DaemonBinding {
    active_session_id: String,
    /// The create's `client_owned` lifecycle (`--no-session`): the
    /// session ends with the connection.
    client_owned: bool,
}

/// The hosted daemon session: the ACP identity, the daemon routing id, the
/// update producer, and the per-connection MCP owner state.
pub(crate) struct HostedSession {
    pub(crate) acp_session_id: String,
    pub(crate) daemon_active_session_id: String,
    pub(crate) producer: Arc<UpdateProducer>,
    /// The picker state (TS `AcpSessionEntry`'s configOptions/models) and
    /// the serialized config queue (`configTask`).
    pub(crate) config: Arc<HostedConfig>,
    mcp_owner_id: String,
    mcp_server_names: Vec<String>,
    /// The running prompt turn; one at a time. A cancelled turn keeps
    /// the slot until its stop sequence finishes (TS `entry.cancelling`).
    turn: Option<ActiveTurn>,
    /// The newest assistant stop reason observed on the event stream.
    assistant_stop_reason: Option<String>,
    /// The event mapping state lives and dies with the session, like TS.
    mapping: WireMappingState,
}

struct ActiveTurn {
    /// TS `admissionId`; the stop sequence cancels the admission by it.
    admission_id: String,
    /// TS the per-turn `AbortController`.
    cancelled: bool,
    /// Resolves when the stop sequence finished; the cancelled turn's
    /// response waits for it, so the next prompt never sees "cancelling".
    stop_done_rx: Option<oneshot::Receiver<()>>,
}

/// The ACP transport state: one hosted session at most.
#[derive(Default)]
pub(crate) struct DaemonAcpState {
    pub(crate) session: Option<HostedSession>,
    pub(crate) session_new_in_flight: bool,
    pub(crate) session_close_in_flight: bool,
}

/// Serve the daemon-attached ACP mode until stdin closes. The caller
/// guarantees the socket answers (the composition spawns a supervisor
/// when none is listening).
///
/// # Errors
///
/// Returns an error, before any ACP frame is written, when the daemon
/// socket connect, the startup create, or its attach fails; a daemon that
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
            let mut frames = link.frames.lock().await;
            while let Some(frame) = frames.recv().await {
                match frame {
                    LinkFrame::Event(frame) => {
                        let event = frame.get("event").cloned().unwrap_or(Value::Null);
                        // The picker refresh triggers (TS refreshes on
                        // `agent_end`, `auto_retry_start`, and
                        // `auto_retry_end` — the runs that can restore a
                        // failover model or clamp a level): captured under
                        // the guard, spawned once it is released.
                        let mut refresh: Option<(Arc<HostedConfig>, Arc<UpdateProducer>, String)> =
                            None;
                        {
                            let mut guard = state.lock().await;
                            let Some(current) = guard.session.as_mut() else {
                                continue;
                            };
                            if let Some(stop) = wire_events::assistant_stop(&event) {
                                current.assistant_stop_reason = stop.stop_reason;
                            }
                            let turn_id = current.producer.active_prompt_turn().await;
                            for update in wire_events::wire_updates(&event, &mut current.mapping) {
                                let _ = current
                                    .producer
                                    .publish(&update, turn_id, PrimeAgentEventPhase::Event, None)
                                    .await;
                            }
                            if matches!(
                                event.get("type").and_then(Value::as_str),
                                Some("agent_end" | "auto_retry_start" | "auto_retry_end")
                            ) {
                                refresh = Some((
                                    Arc::clone(&current.config),
                                    Arc::clone(&current.producer),
                                    current.daemon_active_session_id.clone(),
                                ));
                            }
                        }
                        if let Some((config, producer, daemon_session_id)) = refresh {
                            let link = Arc::clone(&link);
                            tokio::spawn(async move {
                                // Serialized like every config operation
                                // (TS `enqueueConfig`).
                                let _guard = config.queue.lock().await;
                                // The background trigger drops refresh
                                // failures (TS's `.catch(() => undefined)`
                                // on the enqueue site).
                                let _ = refresh_wire_config(
                                    &link,
                                    &daemon_session_id,
                                    &config,
                                    &producer,
                                )
                                .await;
                            });
                        }
                    }
                    LinkFrame::Response(response) => {
                        let id = response.id.clone().unwrap_or_default();
                        if let Some(tx) = link.pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(response);
                        }
                    }
                    // Heartbeats are connection-scoped, not session events,
                    // so the consumer maps the broadcast directly instead of
                    // `wire_updates`: TS publishes the change at origin turn 0
                    // even while a prompt runs.
                    LinkFrame::HeartbeatsChanged => {
                        let guard = state.lock().await;
                        if let Some(current) = guard.session.as_ref() {
                            let _ = current
                                .producer
                                .publish(
                                    &types::AcpSessionUpdate::SessionInfoUpdate {
                                        meta: meta::prime_agent_meta(&PrimeAgentSessionMeta {
                                            heartbeats_changed: Some(true),
                                            ..Default::default()
                                        }),
                                    },
                                    0,
                                    PrimeAgentEventPhase::Event,
                                    None,
                                )
                                .await;
                        }
                    }
                }
            }
            // The reader hit the socket close and every frame it read
            // has been delivered: fail the still-pending requests
            // (dropping a sender answers with the mid-request error)
            // and fail every later request fast. The flag goes up
            // before the clear; `request` covers the race.
            link.closed.store(true, std::sync::atomic::Ordering::SeqCst);
            link.pending.lock().unwrap().clear();
        });
    }
    let binding = bind_daemon_session(&link, &state, options.create.clone()).await?;

    // Only the prompt handlers stay owned: EOF aborts them (TS aborts the
    // controller and exits), so the process never waits on a prompt still
    // settling its subagents. The other handlers spawn detached: a close
    // in flight at EOF finishes — its `tx` clone holds `writer.await` — so
    // its session still stops and releases its servers.
    let mut handlers = tokio::task::JoinSet::new();
    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut input_line = String::new();
    loop {
        input_line.clear();
        match stdin.read_line(&mut input_line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if input_line.trim().is_empty() {
            continue;
        }
        let incoming = match jsonrpc::parse_line(&input_line) {
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
        // bounded. Prompt admission and cancel marking run here, in frame
        // order (TS runs a request's synchronous prefix before the next
        // frame's handler).
        match frame_order_prefix(&incoming, &state).await {
            FrameOrder::Spawn => {
                // `session/new` settles before the next frame is read, so
                // EOF's teardown always sees the session it installs.
                if matches!(&incoming, Incoming::Request { method, .. } if method == "session/new")
                {
                    let options_tx = tx.clone();
                    handle_incoming(incoming, &link, &state, &options, &binding, options_tx).await;
                } else {
                    let link = Arc::clone(&link);
                    let state = Arc::clone(&state);
                    let options = options.clone();
                    let binding = binding.clone();
                    let options_tx = tx.clone();
                    tokio::spawn(async move {
                        handle_incoming(incoming, &link, &state, &options, &binding, options_tx)
                            .await;
                    });
                }
            }
            FrameOrder::AdmitPrompt {
                id,
                params,
                admission_id,
            } => {
                let link = Arc::clone(&link);
                let state = Arc::clone(&state);
                let options_tx = tx.clone();
                handlers.spawn(async move {
                    handle_session_prompt(id, params, admission_id, &link, &state, options_tx)
                        .await;
                });
            }
            // A refused prompt answers from the prefix; the running turn
            // is untouched.
            FrameOrder::Refused { id, message } => {
                let _ = tx.send(super::internal_error(&id, &message));
            }
            // A cancel arms the stop task (the notification form has no
            // response).
            FrameOrder::Cancel(stop) => {
                if let Some(stop) = stop {
                    let link = Arc::clone(&link);
                    tokio::spawn(async move {
                        run_cancel_stop(stop, &link).await;
                    });
                }
            }
        }
        // Reap finished prompt handlers.
        while handlers.try_join_next().is_some() {}
    }

    handlers.shutdown().await;
    teardown(&link, &state, &binding).await;
    drop(tx);
    let _ = writer.await;
    Ok(0)
}

/// Create and attach the startup daemon session (TS main.ts, before the
/// ACP connection serves). A failed attach releases the created session
/// the way EOF does.
async fn bind_daemon_session(
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    create: DaemonCommand,
) -> anyhow::Result<DaemonBinding> {
    let client_owned = matches!(
        create,
        DaemonCommand::Create {
            lifecycle: Some(DaemonSessionLifecycle::ClientOwned),
            ..
        }
    );
    let created = link.request(create).await?;
    if !created.success {
        anyhow::bail!(created.error.unwrap_or_else(|| "unknown error".to_string()));
    }
    let binding = DaemonBinding {
        active_session_id: created
            .data
            .as_ref()
            .and_then(|summary| summary.get("activeSessionId"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        client_owned,
    };
    let attached = link
        .request(DaemonCommand::Attach {
            id: None,
            active_session_id: binding.active_session_id.clone(),
            client_id: None,
            capabilities: None,
            resume_cursor: None,
            telemetry_disabled: None,
            recovery_config: None,
            env: None,
            launch_env: None,
            rest: Map::default(),
        })
        .await
        .and_then(|response| {
            if response.success {
                Ok(())
            } else {
                Err(anyhow::anyhow!(response
                    .error
                    .unwrap_or_else(|| "unknown error".to_string())))
            }
        });
    if let Err(error) = attached {
        teardown(link, state, &binding).await;
        return Err(error);
    }
    Ok(binding)
}

enum FrameOrder {
    Spawn,
    AdmitPrompt {
        id: Value,
        params: Value,
        admission_id: String,
    },
    Refused {
        id: Value,
        message: String,
    },
    Cancel(Option<CancelStop>),
}

struct CancelStop {
    daemon_session_id: String,
    admission_id: String,
    stop_done_tx: oneshot::Sender<()>,
}

/// Prompt admission and cancel marking, in the client's frame order.
async fn frame_order_prefix(incoming: &Incoming, state: &Arc<Mutex<DaemonAcpState>>) -> FrameOrder {
    match incoming {
        Incoming::Request { id, method, params } if method == "session/prompt" => {
            match admit_prompt(params, state).await {
                Ok(admission_id) => FrameOrder::AdmitPrompt {
                    id: id.clone(),
                    params: params.clone(),
                    admission_id,
                },
                Err(message) => FrameOrder::Refused {
                    id: id.clone(),
                    message,
                },
            }
        }
        Incoming::Notification { method, params } if method == "session/cancel" => {
            FrameOrder::Cancel(arm_cancel(params, state).await)
        }
        _ => FrameOrder::Spawn,
    }
}

/// Reserve the turn slot for one prompt. `Err` is the refusal message,
/// checked in TS order: unknown session, cancelling, turn running.
async fn admit_prompt(
    params: &Value,
    state: &Arc<Mutex<DaemonAcpState>>,
) -> Result<String, String> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut guard = state.lock().await;
    let Some(hosted) = guard
        .session
        .as_mut()
        .filter(|hosted| hosted.acp_session_id == session_id)
    else {
        return Err(format!("Unknown ACP session: {session_id}"));
    };
    match &hosted.turn {
        Some(turn) if turn.cancelled => {
            return Err(format!("ACP session is cancelling: {session_id}"));
        }
        Some(_) => {
            return Err("A prompt turn is already running for this ACP session".to_string());
        }
        None => {}
    }
    let admission_id = format!("prompt-admission:{}", uuid::Uuid::new_v4());
    hosted.turn = Some(ActiveTurn {
        admission_id: admission_id.clone(),
        cancelled: false,
        stop_done_rx: None,
    });
    Ok(admission_id)
}

/// Mark the addressed turn cancelled and arm its stop sequence. `None`
/// when there is no running turn or it is already cancelled.
async fn arm_cancel(params: &Value, state: &Arc<Mutex<DaemonAcpState>>) -> Option<CancelStop> {
    let session_id = params.get("sessionId").and_then(Value::as_str)?;
    let mut guard = state.lock().await;
    let hosted = guard
        .session
        .as_mut()
        .filter(|hosted| hosted.acp_session_id == session_id)?;
    let daemon_session_id = hosted.daemon_active_session_id.clone();
    let turn = hosted.turn.as_mut()?;
    if turn.cancelled {
        return None;
    }
    turn.cancelled = true;
    let (stop_done_tx, stop_done_rx) = oneshot::channel();
    turn.stop_done_rx = Some(stop_done_rx);
    Some(CancelStop {
        daemon_session_id,
        admission_id: turn.admission_id.clone(),
        stop_done_tx,
    })
}

/// The cancelled turn's stop sequence. Dropping `stop_done_tx` releases
/// the cancelled turn's response.
async fn run_cancel_stop(stop: CancelStop, link: &Arc<DaemonLink>) {
    stop_session_work(link, &stop.daemon_session_id, Some(stop.admission_id)).await;
    drop(stop.stop_done_tx);
}

/// TS `stopSessionWork`: abort the worker's running and queued work, stop
/// the owned admission (a prompt sent before the stop but committed after
/// the abort), wait the idle, then cancel the RLM children.
async fn stop_session_work(
    link: &Arc<DaemonLink>,
    daemon_session_id: &str,
    admission_id: Option<String>,
) {
    let _ = link
        .request(DaemonCommand::AbortAndClearQueue {
            id: None,
            active_session_id: daemon_session_id.to_string(),
            rest: Map::default(),
        })
        .await;
    if let Some(admission_id) = admission_id {
        cancel_owned_admission(link, daemon_session_id, admission_id).await;
    }
    let _ = link
        .request(DaemonCommand::WaitForIdle {
            id: None,
            active_session_id: daemon_session_id.to_string(),
            wait_for_rlm_quiescence: None,
            rest: Map::default(),
        })
        .await;
    cancel_outstanding_rlm_children(link, daemon_session_id).await;
}

/// TS `cancelOutstandingRlmChildren`: cancel every roster row, no status
/// filter — a row already settling keeps its own settle, and the cancels
/// run one after another (TS `Promise.allSettled` is the declared
/// divergence). A failed roster fetch or cancel is ignored, like every
/// other stop step.
async fn cancel_outstanding_rlm_children(link: &Arc<DaemonLink>, daemon_session_id: &str) {
    let Ok(children) = fetch_rlm_children(link, daemon_session_id).await else {
        return;
    };
    for child in children {
        let child_id = child
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let _ = link
            .request(DaemonCommand::CancelRlmChild {
                id: None,
                active_session_id: daemon_session_id.to_string(),
                child_id,
                rest: Map::default(),
            })
            .await;
    }
}

/// TS `cancel_prompt_admission` with `cancelOwned`: a committed prompt's
/// running turn aborts.
async fn cancel_owned_admission(
    link: &Arc<DaemonLink>,
    daemon_session_id: &str,
    admission_id: String,
) {
    let _ = link
        .request(DaemonCommand::CancelPromptAdmission {
            id: None,
            active_session_id: daemon_session_id.to_string(),
            admission_id,
            cancel_owned: Some(true),
            rest: Map::default(),
        })
        .await;
}

/// One incoming ACP frame. Requests answer.
async fn handle_incoming(
    incoming: Incoming,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    options: &DaemonAcpOptions,
    binding: &DaemonBinding,
    tx: producer::FrameSink,
) {
    let Incoming::Request { id, method, params } = incoming else {
        return;
    };
    match method.as_str() {
        "initialize" => {
            handle_initialize(&id, &params, &options.product_version, &tx);
        }
        "session/new" => {
            handle_session_new(id, params, link, state, options, binding, tx).await;
        }
        "session/set_config_option" => {
            handle_set_config_option(id, params, link, state, tx).await;
        }
        "session/close" => {
            handle_session_close(id, params, link, state, tx).await;
        }
        other => {
            let _ = tx.send(jsonrpc::error_response(
                &id,
                jsonrpc::METHOD_NOT_FOUND,
                &format!("\"Method not found\": {other}"),
                Some(&json!({ "method": other })),
            ));
        }
    }
}

fn handle_initialize(id: &Value, params: &Value, product_version: &str, tx: &producer::FrameSink) {
    if let Err(error_response) = validate_initialize(id, params) {
        let _ = tx.send(error_response);
        return;
    }
    let result =
        serde_json::to_value(types::initialize_result(product_version)).expect("serializes");
    let _ = tx.send(jsonrpc::response(id, &result));
}

/// The `initialize` schema check the TS SDK performs: the protocol version
/// must be a number. The error body mirrors the observed TS response.
fn validate_initialize(id: &Value, params: &Value) -> std::result::Result<(), Value> {
    let field_error = |received: &str| {
        jsonrpc::error_response(
            id,
            jsonrpc::INVALID_PARAMS,
            "Invalid params",
            Some(&json!({
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

/// Admit one session over the startup daemon session and admit its MCP
/// servers through the wire command.
async fn handle_session_new(
    id: Value,
    params: Value,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    options: &DaemonAcpOptions,
    binding: &DaemonBinding,
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
    // MCP admission runs first: a rejected list fails the request with
    // the same error payloads.
    let resolved =
        match super::mcp::resolve_acp_mcp_servers(&params.mcp_servers, &options.actual_cwd) {
            Ok(resolved) => resolved,
            Err(reason) => {
                *state.lock().await = DaemonAcpState::default();
                let _ = tx.send(jsonrpc::error_response(
                    &id,
                    jsonrpc::INVALID_PARAMS,
                    "Invalid params",
                    Some(&json!({ "reason": reason })),
                ));
                return;
            }
        };
    if let Err(details) = super::mcp::acp_mcp_tool_names(&resolved) {
        *state.lock().await = DaemonAcpState::default();
        let _ = tx.send(super::internal_error(&id, &details));
        return;
    }

    let acp_session_id = uuid::Uuid::new_v4().to_string();
    let producer = UpdateProducer::new(acp_session_id.clone(), tx.clone());
    // The pickers ride the worker's own state and discovery seams: neither
    // fetch may fail the admission (TS catches discovery failures to an
    // empty list, and a state fetch failure degrades to no options).
    let (state_value, models) = (
        fetch_connection_state(link, &binding.active_session_id).await,
        fetch_available_models(link, &binding.active_session_id)
            .await
            .unwrap_or_default(),
    );
    let published = picker_options_from_state(state_value.as_ref(), &models);
    let config = Arc::new(HostedConfig {
        queue: tokio::sync::Mutex::new(()),
        published: tokio::sync::Mutex::new(published),
        models: tokio::sync::Mutex::new(models),
    });
    let mcp_owner_id = uuid::Uuid::new_v4().to_string();
    let mut hosted = HostedSession {
        acp_session_id: acp_session_id.clone(),
        daemon_active_session_id: binding.active_session_id.clone(),
        producer,
        config,
        mcp_owner_id,
        mcp_server_names: Vec::new(),
        turn: None,
        assistant_stop_reason: None,
        mapping: WireMappingState::default(),
    };
    // The ACP MCP servers ride the wire command, not a local manager.
    if let Err(error) = replace_session_servers(link, &hosted, &resolved).await {
        // The worker may have applied the list before this failed (a lost
        // acknowledgement); the clear is best-effort, like TS.
        if !resolved.is_empty() {
            let _ = replace_session_servers(link, &hosted, &[]).await;
        }
        *state.lock().await = DaemonAcpState::default();
        let _ = tx.send(super::internal_error(&id, &error.to_string()));
        return;
    }
    hosted.mcp_server_names = resolved
        .iter()
        .map(pa_core::mcp::AcpMcpServerConfig::name)
        .map(str::to_string)
        .collect();

    // The admission response is queued below, after the session takes its
    // slot and before the producer gate opens.
    let mut result = json!({
        "sessionId": acp_session_id,
        "configOptions": *hosted.config.published.lock().await,
    });
    if let Some(requested) = params.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
        let actual = options.actual_cwd.display().to_string();
        if !super::same_cwd(Path::new(requested), &options.actual_cwd) {
            result["_meta"] = meta::prime_agent_meta(&PrimeAgentSessionMeta {
                cwd: Some(meta::PrimeAgentCwdMeta {
                    requested: requested.to_string(),
                    actual,
                }),
                ..Default::default()
            });
        }
    }
    // Install the hosted session before the admission response leaves: a
    // client that immediately sends `session/set_config_option` resolves
    // against the installed session, not "Unknown ACP session" (TS
    // assigns `session = entry` before returning the response). The
    // producer gate opens only after the response is queued on the
    // sink, so no held update can precede the admission response.
    let producer = Arc::clone(&hosted.producer);
    {
        let mut guard = state.lock().await;
        guard.session_new_in_flight = false;
        guard.session = Some(hosted);
    }
    let _ = tx.send(jsonrpc::response(&id, &result));
    producer.commit_session_new_response().await;
}

/// Send the MCP replacement for one hosted session.
async fn replace_session_servers(
    link: &Arc<DaemonLink>,
    hosted: &HostedSession,
    resolved: &[pa_core::mcp::AcpMcpServerConfig],
) -> anyhow::Result<()> {
    let response = link
        .request(DaemonCommand::ReplaceAcpMcpServers {
            id: None,
            active_session_id: hosted.daemon_active_session_id.clone(),
            owner_id: hosted.mcp_owner_id.clone(),
            servers: serde_json::to_value(resolved)?,
            rest: Map::default(),
        })
        .await?;
    if !response.success {
        anyhow::bail!(response
            .error
            .unwrap_or_else(|| "unknown error".to_string()));
    }
    Ok(())
}

async fn handle_session_prompt(
    id: Value,
    params: Value,
    admission_id: String,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    tx: producer::FrameSink,
) {
    let reply = prompt_turn(id, params, &admission_id, link, state).await;
    release_turn_slot(state, &admission_id).await;
    let _ = tx.send(reply);
}

/// Release this prompt's turn slot, after its stop sequence if it was
/// cancelled. A slot holding another prompt's turn (close + new while
/// this prompt ran) is left alone.
async fn release_turn_slot(state: &Arc<Mutex<DaemonAcpState>>, admission_id: &str) {
    let stop_done = {
        let mut guard = state.lock().await;
        let Some(hosted) = guard.session.as_mut() else {
            return;
        };
        let stop_done = match hosted.turn.as_mut() {
            Some(turn) if turn.admission_id != admission_id => return,
            Some(turn) => turn.stop_done_rx.take(),
            None => return,
        };
        let Some(stop_done) = stop_done else {
            hosted.turn = None;
            return;
        };
        stop_done
    };
    let _ = stop_done.await;
    if let Some(hosted) = state.lock().await.session.as_mut() {
        hosted
            .turn
            .take_if(|turn| turn.admission_id == admission_id);
    }
}

/// Whether this prompt lost its turn: cancelled, or its session was closed
/// (close, or close + new, takes the slot - like TS close aborting the turn).
fn turn_cancelled(state: &DaemonAcpState, admission_id: &str) -> bool {
    !state
        .session
        .as_ref()
        .and_then(|hosted| hosted.turn.as_ref())
        .is_some_and(|turn| turn.admission_id == admission_id && !turn.cancelled)
}

fn cancelled_response(id: &Value) -> Value {
    jsonrpc::response(
        id,
        &serde_json::to_value(types::AcpStopReasonResponse {
            stop_reason: types::AcpStopReason::Cancelled,
        })
        .expect("serializes"),
    )
}

/// Render a prompt-block failure as the ACP invalid-params error. The TS
/// SDK validates the request schema; the Rust port validates the blocks it
/// actually reads.
fn prompt_block_error(id: &Value, error: &types::PromptBlockError) -> Value {
    jsonrpc::error_response(
        id,
        jsonrpc::INVALID_PARAMS,
        "Invalid params",
        Some(&json!({ "reason": error.to_string() })),
    )
}

/// Run one admitted prompt turn and return its reply frame.
async fn prompt_turn(
    id: Value,
    params: Value,
    admission_id: &str,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
) -> Value {
    let params = types::PromptParams::parse(&params);
    let admitted = match types::AdmittedPrompt::parse(&params.prompt) {
        Ok(admitted) => admitted,
        Err(error) => return prompt_block_error(&id, &error),
    };
    let (producer, hosted_daemon_session_id) = {
        let guard = state.lock().await;
        match guard.session.as_ref() {
            Some(hosted) if hosted.acp_session_id == params.session_id => (
                Arc::clone(&hosted.producer),
                hosted.daemon_active_session_id.clone(),
            ),
            // Admission checked the session id: a miss is a close since.
            _ => return cancelled_response(&id),
        }
    };
    let turn_id = producer.begin_prompt().await;
    // TS `abort.signal.aborted` before `promptAndWait`.
    let cancelled = turn_cancelled(&*state.lock().await, admission_id);
    if cancelled {
        producer.finish_prompt(turn_id).await;
        return cancelled_response(&id);
    }
    let prompt = DaemonCommand::PromptAndWait {
        id: None,
        active_session_id: hosted_daemon_session_id.clone(),
        message: admitted.text,
        input: pa_types::daemon::PromptInput {
            content: None,
            // The image blocks ride the wire form `parse_prompt_images`
            // reads (`{type, data, mimeType}`); TS forwards `images`
            // only when the prompt carries any.
            images: (!admitted.images.is_empty()).then(|| {
                json!(admitted
                    .images
                    .into_iter()
                    .map(|image| json!({ "type": "image", "data": image.data, "mimeType": image.mime_type }))
                    .collect::<Vec<_>>())
            }),
            // TS sends `followUp` + `queueIfBusy: true` on every ACP
            // prompt (acp-mode.ts): a prompt carrying a streaming
            // behavior is the worker's resume site for the post-abort
            // queued-input suspension, so a prompt after a Stop runs.
            streaming_behavior: Some(pa_types::daemon::StreamingBehavior::FollowUp),
            queue_if_busy: Some(true),
            expand_prompt_templates: None,
            source: None,
            agent_message_id: None,
            custom_message: None,
            queue_key: None,
            prefix_messages: None,
            admission_id: Some(admission_id.to_string()),
            rlm_notice_nonce: None,
        },
        rest: Map::default(),
    };
    let response = match link.request_until_close(prompt).await {
        Ok(response) => response,
        Err(error) => {
            publish_error_boundary(&producer, turn_id).await;
            producer.finish_prompt(turn_id).await;
            return super::internal_error(&id, &error.to_string());
        }
    };
    // TS `abort.signal.aborted` after `promptAndWait`: every turn frame
    // is published by now - the worker flushes its session events before
    // the response leaves its socket, and the supervisor's per-client
    // writer writes a queued event ahead of a queued response - so the
    // settle reads the stream directly, with no marker wait.
    let cancelled = {
        let guard = state.lock().await;
        turn_cancelled(&guard, admission_id)
    };
    if cancelled {
        producer.finish_prompt(turn_id).await;
        return cancelled_response(&id);
    }
    // TS settle catch: one error boundary, no terminal-quiescence update.
    if !response.success {
        let failure = response
            .error
            .unwrap_or_else(|| "unknown error".to_string());
        // The failure text rides the internal_error reply, where a test
        // asserting only the stop reason loses it: echo it to stderr so
        // every harness's child-stderr dump shows WHY the turn failed.
        eprintln!("pa-daemon: acp turn failed: {failure}");
        publish_error_boundary(&producer, turn_id).await;
        producer.finish_prompt(turn_id).await;
        return super::internal_error(&id, &format!("prime-agent turn failed: {failure}"));
    }
    // The autonomous accounting for the completion envelope: the daemon's
    // headless-completion status (TS `waitForHeadlessCompletion`), fetched
    // after the turn settled (the response is the run's end). A failed
    // fetch degrades to no autonomous meta (the envelope still settles
    // without a run).
    let autonomous_status = fetch_autonomous_status(link, &hosted_daemon_session_id, false)
        .await
        .ok();
    // TS `abort.signal.aborted` after `waitForHeadlessCompletion`: queued
    // continuations (goal, post-compaction autonomous) run inside that wait.
    if turn_cancelled(&*state.lock().await, admission_id) {
        producer.finish_prompt(turn_id).await;
        return cancelled_response(&id);
    }
    // The completion observation's roster read (TS `getRlmChildSnapshots`
    // throws): a failed read errors the prompt before the boundary, never
    // publishes a wrong count.
    let children = match fetch_rlm_children(link, &hosted_daemon_session_id).await {
        Ok(children) => children,
        Err(error) => {
            publish_error_boundary(&producer, turn_id).await;
            producer.finish_prompt(turn_id).await;
            return super::internal_error(&id, &error.to_string());
        }
    };
    if turn_cancelled(&*state.lock().await, admission_id) {
        producer.finish_prompt(turn_id).await;
        return cancelled_response(&id);
    }
    let autonomous_meta = autonomous_status
        .as_ref()
        .filter(|status| status.enabled)
        .map(meta::autonomous_meta);
    // The boundary, completion, and terminal quiescence frames match the
    // TS captures.
    let boundary = types::AcpSessionUpdate::SessionInfoUpdate {
        meta: meta::prime_agent_meta(&PrimeAgentSessionMeta {
            terminal_quiescence_expected: Some(true),
            ..Default::default()
        }),
    };
    let published = producer
        .publish(
            &boundary,
            turn_id,
            PrimeAgentEventPhase::ResponseBoundary,
            Some(PrimeAgentOutcome::Result),
        )
        .await;
    // The completion envelope: the turn's own observation, with the
    // live outstanding-subagent count the settle loop then waits down to
    // zero.
    let quiescence = types::AcpSessionUpdate::SessionInfoUpdate {
        meta: meta::prime_agent_meta(&PrimeAgentSessionMeta {
            autonomous: autonomous_meta,
            quiescence: Some(quiescence_meta(autonomous_status.as_ref(), &children)),
            ..Default::default()
        }),
    };
    let completion_published = producer
        .publish(&quiescence, turn_id, PrimeAgentEventPhase::Event, None)
        .await;
    // The settlement loop (TS `finalizePendingTerminal`): the barrier is
    // the event, no timer, and the roster re-read is the response-cut
    // telemetry (a child can publish a terminal status before its result
    // reaches the parent). A failed barrier or read errors the prompt; a
    // degraded status would spin the loop.
    let settled_status = loop {
        let status = match fetch_autonomous_status(link, &hosted_daemon_session_id, true).await {
            Ok(status) => status,
            Err(error) => {
                producer.finish_prompt(turn_id).await;
                return super::internal_error(
                    &id,
                    &format!("ACP lifecycle reconciliation failed: {error}"),
                );
            }
        };
        if turn_cancelled(&*state.lock().await, admission_id) {
            producer.finish_prompt(turn_id).await;
            return cancelled_response(&id);
        }
        let children = match fetch_rlm_children(link, &hosted_daemon_session_id).await {
            Ok(children) => children,
            Err(error) => {
                producer.finish_prompt(turn_id).await;
                return super::internal_error(
                    &id,
                    &format!("ACP lifecycle reconciliation failed: {error}"),
                );
            }
        };
        if turn_cancelled(&*state.lock().await, admission_id) {
            producer.finish_prompt(turn_id).await;
            return cancelled_response(&id);
        }
        let terminal_quiescence = quiescence_meta(Some(&status), &children);
        if terminal_quiescence.outstanding_subagents != 0 {
            continue;
        }
        // TS `sealTerminal`: the terminal frame is the last update stamped
        // with this turn; later events resume turn 0.
        producer.finish_prompt(turn_id).await;
        let terminal = types::AcpSessionUpdate::SessionInfoUpdate {
            meta: meta::prime_agent_meta(&PrimeAgentSessionMeta {
                autonomous: status.enabled.then(|| meta::autonomous_meta(&status)),
                quiescence: Some(terminal_quiescence),
                ..Default::default()
            }),
        };
        let terminal_published = producer
            .publish(
                &terminal,
                turn_id,
                PrimeAgentEventPhase::TerminalQuiescence,
                Some(PrimeAgentOutcome::Result),
            )
            .await;
        if !published || !completion_published || !terminal_published {
            return super::internal_error(&id, "Failed to publish ACP completion");
        }
        break status;
    };
    // The stop reason follows the TS mapping (acp-stop-reason.ts): the
    // abort flag read after the settlement, and the settlement's status
    // (`pending.status`), not the first observation's.
    let stop_reason = meta::acp_stop_reason_for_status(
        turn_cancelled(&*state.lock().await, admission_id),
        Some(&settled_status),
    );
    jsonrpc::response(
        &id,
        &serde_json::to_value(types::AcpStopReasonResponse { stop_reason }).expect("serializes"),
    )
}

/// The error boundary a failed turn publishes (TS
/// `terminalQuiescenceExpected: false`).
async fn publish_error_boundary(producer: &Arc<UpdateProducer>, turn_id: u64) {
    let boundary = types::AcpSessionUpdate::SessionInfoUpdate {
        meta: meta::prime_agent_meta(&PrimeAgentSessionMeta {
            terminal_quiescence_expected: Some(false),
            ..Default::default()
        }),
    };
    let _ = producer
        .publish(
            &boundary,
            turn_id,
            PrimeAgentEventPhase::ResponseBoundary,
            Some(PrimeAgentOutcome::Error),
        )
        .await;
}

/// Fetch the session's autonomous-run status (`wait_for_headless_completion`
/// on the daemon wire; TS `waitForHeadlessCompletion`), once the daemon's
/// headless run settled. With `wait_for_rlm_quiescence`, the answer comes
/// from the quiescence barrier instead: it holds past the parent's idle
/// until every tracked child run settled, so it is the RLM-quiescence
/// event the settlement loop waits on. A failure is the caller's policy
/// (TS throws for both callers): the completion observation degrades, the
/// settlement loop errors the prompt.
///
/// # Errors
///
/// Returns an error when the daemon connection fails or closes mid-request,
/// when the response reports a failure, or when the status payload does not
/// deserialize.
async fn fetch_autonomous_status(
    link: &Arc<DaemonLink>,
    active_session_id: &str,
    wait_for_rlm_quiescence: bool,
) -> anyhow::Result<pa_core::autonomous::AgentAutonomousStatus> {
    let response = link
        .request_until_close(DaemonCommand::WaitForHeadlessCompletion {
            id: None,
            active_session_id: active_session_id.to_string(),
            wait_for_rlm_quiescence: wait_for_rlm_quiescence.then_some(true),
            rest: Map::default(),
        })
        .await?;
    if !response.success {
        anyhow::bail!(response
            .error
            .unwrap_or_else(|| "unknown error".to_string()));
    }
    Ok(serde_json::from_value(
        response.data.unwrap_or(Value::Null),
    )?)
}

/// The live child roster (`get_rlm_children` on the daemon wire; TS
/// `getRlmChildSnapshots` throws).
///
/// # Errors
///
/// Returns an error when the daemon connection fails or closes mid-request,
/// when the response reports a failure, or when the answer carries no
/// children array.
async fn fetch_rlm_children(
    link: &Arc<DaemonLink>,
    active_session_id: &str,
) -> anyhow::Result<Vec<Value>> {
    let response = link
        .request(DaemonCommand::GetRlmChildren {
            id: None,
            active_session_id: active_session_id.to_string(),
            rest: Map::default(),
        })
        .await?;
    if !response.success {
        anyhow::bail!(response
            .error
            .unwrap_or_else(|| "unknown error".to_string()));
    }
    response
        .data
        .unwrap_or(Value::Null)
        .get("children")
        .cloned()
        .and_then(|children| children.as_array().cloned())
        .ok_or_else(|| anyhow::anyhow!("get_rlm_children answered no children array"))
}

/// TS `outstandingSubagentCount`: the roster's live statuses, verbatim.
fn outstanding_subagents(children: &[Value]) -> u64 {
    children
        .iter()
        .filter(|child| {
            matches!(
                child.get("status").and_then(Value::as_str),
                Some("queued" | "running")
            )
        })
        .count() as u64
}

/// TS `quiescenceMeta`: the outstanding-subagent count plus the run's
/// remaining continuation slots, observed together at one completion point.
fn quiescence_meta(
    status: Option<&pa_core::autonomous::AgentAutonomousStatus>,
    children: &[Value],
) -> meta::PrimeAgentQuiescenceMeta {
    meta::PrimeAgentQuiescenceMeta {
        outstanding_subagents: outstanding_subagents(children),
        remaining_autonomous_continuations: status.filter(|status| status.enabled).map_or(
            0,
            |status| {
                status
                    .limits
                    .max_continuations
                    .saturating_sub(status.continuations_used)
            },
        ),
    }
}

/// Close: stop the session's work, release the servers, and fence the
/// producer. The daemon session stays; a later `session/new` binds it
/// again (TS `closeSession`).
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
        let taken = guard
            .session
            .take_if(|hosted| hosted.acp_session_id == session_id);
        if taken.is_some() {
            guard.session_close_in_flight = true;
        }
        taken
    };
    let Some(hosted) = taken else {
        let _ = tx.send(super::internal_error(
            &id,
            &format!("Unknown ACP session: {session_id}"),
        ));
        return;
    };
    let admission_id = hosted.turn.as_ref().map(|turn| turn.admission_id.clone());
    stop_session_work(link, &hosted.daemon_active_session_id, admission_id).await;
    if !hosted.mcp_server_names.is_empty() {
        let _ = replace_session_servers(link, &hosted, &[]).await;
    }
    // The serialized config work settles before the producer fences (TS
    // `await configTask`).
    let _ = hosted.config.queue.lock().await;
    hosted.producer.close().await;
    let _ = tx.send(jsonrpc::response(&id, &json!({})));
    let mut guard = state.lock().await;
    guard.session_close_in_flight = false;
}

/// Release the connection's hold after stdin closes (TS dispose): the
/// running prompt is cancelled (TS EOF abort → `cancel_prompt_admission`
/// with `cancelOwned`), the MCP servers go and the producer fences. A
/// client-owned session ends with the connection; a resident one stays
/// and is detached when the link drops.
async fn teardown(
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    binding: &DaemonBinding,
) {
    let hosted = state.lock().await.session.take();
    if let Some(turn) = hosted.as_ref().and_then(|hosted| hosted.turn.as_ref()) {
        cancel_owned_admission(link, &binding.active_session_id, turn.admission_id.clone()).await;
    }
    if let Some(hosted) = &hosted {
        if !hosted.mcp_server_names.is_empty() {
            let _ = replace_session_servers(link, hosted, &[]).await;
        }
    }
    // The owned worker stops before the config queue drains: a stalled
    // config operation holding the queue on a wire request fails fast.
    if binding.client_owned {
        let _ = link
            .request(DaemonCommand::CompleteOwnedSession {
                id: None,
                active_session_id: binding.active_session_id.clone(),
                rest: Map::default(),
            })
            .await;
    }
    if let Some(hosted) = hosted {
        let _ = hosted.config.queue.lock().await;
        hosted.producer.close().await;
    }
}
