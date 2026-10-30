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
        // the ordering, so a turn's chunks always precede its boundary
        // frames.
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

    pub(crate) async fn request_ok(&self, command: DaemonCommand) -> anyhow::Result<()> {
        let response = self.request(command).await?;
        if !response.success {
            anyhow::bail!(response
                .error
                .unwrap_or_else(|| "unknown error".to_string()));
        }
        Ok(())
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
    mcp_owner_id: String,
}

/// The hosted daemon session: the ACP identity, the daemon routing id,
/// the update producer, and the stop state.
pub(crate) struct HostedSession {
    pub(crate) acp_session_id: String,
    pub(crate) daemon_active_session_id: String,
    pub(crate) producer: Arc<UpdateProducer>,
    pub(crate) config: Arc<HostedConfig>,
    cancelling: bool,
    stop_failure: Option<String>,
    input_pause_key: Option<String>,
    input_pause_id: Option<String>,
    cancel_task: Option<tokio::sync::watch::Receiver<bool>>,
    /// The running prompt turn; one at a time. A cancelled turn keeps
    /// the slot until its cancel stop finishes.
    turn: Option<ActiveTurn>,
    /// Steer admissions whose worker round trip has not settled yet:
    /// incremented at the steering admission point (before the round
    /// trip, under the same lock as the guard checks) and decremented at
    /// EVERY settle (receipt, refusal, link error), so the count is the
    /// live in-flight set, never a stale tally of completed steers. A
    /// `session/cancel` with no turn slot arms the stop sequence for it
    /// instead of no-opping: the steer may land at any moment. A prompt
    /// admission never touches it: a prompt that fails after admission
    /// (invalid blocks, a refused turn) releases its slot without
    /// running, and must not orphan the steered work.
    steer_in_flight: usize,
    /// The stop-sequence reset epoch for the in-flight admission count:
    /// only a COMPLETED stop resets the count and bumps the epoch (a
    /// failed stop keeps the bookkeeping so its retry's own tail still
    /// sees the unresolved admissions), so a late settle from an
    /// admission that predates the reset unwinds nothing (its unit is
    /// already gone; the count now belongs to newer admissions).
    steer_generation: u64,
    /// Steered runs with no live prompt turn to own them (an idle-queued
    /// steer, or a prompt turn's leftovers migrated at its slot release):
    /// an idle `session/cancel` probes them for live steered work and
    /// resolves the settled ones out of the list.
    steer_runs: Vec<String>,
    /// The newest assistant stop reason observed on the event stream,
    /// cleared when a prompt turn is admitted so a turn never reads a
    /// previous turn's stop reason (read after the settlement for the
    /// stop-reason response).
    assistant_stop_reason: Option<pa_types::ai::StopReason>,
    /// The event mapping state lives and dies with the session, like TS.
    mapping: WireMappingState,
    observed_children: std::collections::HashSet<String>,
}

struct ActiveTurn {
    /// TS `admissionId`; the stop sequence cancels the admission by it.
    admission_id: String,
    /// TS the per-turn `AbortController`.
    cancelled: bool,
    /// The steered runs admitted while this prompt's turn ran: the prompt
    /// settlement waits for them, and a steered run's failure fails the
    /// owning prompt's response (#3684 review).
    steered_runs: Vec<String>,
}

/// The ACP transport state: one hosted session at most.
#[derive(Default)]
pub(crate) struct DaemonAcpState {
    pub(crate) session: Option<HostedSession>,
    pub(crate) session_new_in_flight: bool,
    pub(crate) session_close_done: Option<tokio::sync::watch::Receiver<bool>>,
    pub(crate) closed_input_pause_id: Option<String>,
    pub(crate) closed_input_pause_key: Option<String>,
    pub(crate) mcp_server_names: Vec<String>,
    /// Woken at every steer admission settle, so a running stop sequence
    /// can wait out the admissions that were in flight when it armed.
    pub(crate) steer_settles: std::sync::Arc<tokio::sync::Notify>,
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

    {
        let link = Arc::clone(&link);
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let mut frames = link.frames.lock().await;
            while let Some(frame) = frames.recv().await {
                match frame {
                    LinkFrame::Event(frame) => {
                        let event = frame.get("event").cloned().unwrap_or(Value::Null);
                        // The refresh triggers: runs that can restore a
                        // failover model or clamp a level. Captured under
                        // the guard, spawned once released.
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
                            if event.get("type").and_then(Value::as_str) == Some("rlm_child_update")
                            {
                                if let Some(id) = event
                                    .get("child")
                                    .and_then(|child| child.get("id"))
                                    .and_then(Value::as_str)
                                {
                                    current.observed_children.insert(id.to_string());
                                }
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
                                let _guard = config.queue.lock().await;
                                // The background trigger drops refresh
                                // failures (TS `.catch(() => undefined)`).
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
        match frame_order_prefix(&incoming, &link, &state).await {
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
            // A refused prompt or close answers from the prefix; the
            // running turn is untouched.
            FrameOrder::Refused { id, message } => {
                let _ = tx.send(super::internal_error(&id, &message));
            }
            FrameOrder::Close { id, params, done } => {
                let link = Arc::clone(&link);
                let state = Arc::clone(&state);
                let options_tx = tx.clone();
                let owner_id = binding.mcp_owner_id.clone();
                tokio::spawn(async move {
                    handle_session_close(id, params, &link, &state, options_tx, done, owner_id)
                        .await;
                });
            }
            FrameOrder::Cancel(order) => {
                let link = Arc::clone(&link);
                let state = Arc::clone(&state);
                tokio::spawn(async move {
                    let mut order = order;
                    loop {
                        order = match order {
                            CancelOrder::None => return,
                            CancelOrder::Armed(stop) => {
                                run_cancel_stop(stop, &link, &state).await;
                                return;
                            }
                            CancelOrder::WaitForClose { session_id } => {
                                wait_for_session_close(&state).await;
                                cancel_order(&json!({ "sessionId": session_id }), &link, &state)
                                    .await
                            }
                        };
                    }
                });
            }
        }
        // Reap finished prompt handlers.
        while handlers.try_join_next().is_some() {}
    }

    handlers.shutdown().await;
    // A close frame is reserved synchronously but its stop runs detached.
    // Let it finish before EOF teardown takes the hosted session away.
    wait_for_session_close(&state).await;
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
        mcp_owner_id: uuid::Uuid::new_v4().to_string(),
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
    Close {
        id: Value,
        params: Value,
        done: tokio::sync::watch::Sender<bool>,
    },
    Cancel(CancelOrder),
}

enum CancelOrder {
    None,
    Armed(CancelStop),
    WaitForClose { session_id: String },
}

#[derive(Debug)]
struct CancelStop {
    acp_session_id: String,
    daemon_session_id: String,
    admission_id: Option<String>,
    done: tokio::sync::watch::Sender<bool>,
}

/// Prompt admission and cancel marking, in the client's frame order.
async fn frame_order_prefix(
    incoming: &Incoming,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
) -> FrameOrder {
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
        Incoming::Request { id, method, params } if method == "session/close" => {
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let (done_tx, done_rx) = tokio::sync::watch::channel(false);
            let mut guard = state.lock().await;
            if guard
                .session
                .as_ref()
                .is_none_or(|hosted| hosted.acp_session_id != session_id)
            {
                return FrameOrder::Refused {
                    id: id.clone(),
                    message: format!("Unknown ACP session: {session_id}"),
                };
            }
            if guard.session_close_done.is_some() {
                return FrameOrder::Refused {
                    id: id.clone(),
                    message: format!("ACP session is already closing: {session_id}"),
                };
            }
            guard.session_close_done = Some(done_rx);
            FrameOrder::Close {
                id: id.clone(),
                params: params.clone(),
                done: done_tx,
            }
        }
        Incoming::Notification { method, params } if method == "session/cancel" => {
            FrameOrder::Cancel(cancel_order(params, link, state).await)
        }
        _ => FrameOrder::Spawn,
    }
}

/// Reserve the turn slot for one prompt. `Err` is the refusal message,
/// checked in TS order: unknown session, closing, cancelling, stop
/// failure, turn running.
async fn admit_prompt(
    params: &Value,
    state: &Arc<Mutex<DaemonAcpState>>,
) -> Result<String, String> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut guard = state.lock().await;
    let session_closing = guard.session_close_done.is_some();
    let Some(hosted) = guard
        .session
        .as_mut()
        .filter(|hosted| hosted.acp_session_id == session_id)
    else {
        return Err(format!("Unknown ACP session: {session_id}"));
    };
    if session_closing {
        return Err(format!("ACP session is closing: {session_id}"));
    }
    if hosted.cancelling {
        return Err(format!("ACP session is cancelling: {session_id}"));
    }
    if let Some(stop_failure) = hosted.stop_failure.as_ref() {
        return Err(format!("ACP session stop failed: {stop_failure}"));
    }
    if hosted.turn.is_some() {
        return Err("A prompt turn is already running for this ACP session".to_string());
    }
    let admission_id = format!("prompt-admission:{}", uuid::Uuid::new_v4());
    // The stop reason is per-turn: a turn that runs no model call (a
    // slash command) must not inherit the previous turn's stop reason.
    hosted.assistant_stop_reason = None;
    // The steered-work tracking stays: a prompt that fails after
    // admission (invalid blocks, a refused turn) releases this slot
    // without ever running, and must not orphan the steered work the
    // slot would have covered.
    hosted.turn = Some(ActiveTurn {
        admission_id: admission_id.clone(),
        cancelled: false,
        steered_runs: Vec::new(),
    });
    Ok(admission_id)
}

async fn cancel_order(
    params: &Value,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
) -> CancelOrder {
    let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
        return CancelOrder::None;
    };
    let arm = {
        let mut guard = state.lock().await;
        if guard.session_close_done.is_some() {
            return CancelOrder::WaitForClose {
                session_id: session_id.to_string(),
            };
        }
        arm_cancel_locked(session_id, &mut guard)
    };
    match arm {
        CancelArm::None => CancelOrder::None,
        CancelArm::Armed(stop) => CancelOrder::Armed(stop),
        // Live steered work is the worker's own report now, not an
        // ACP-side count: an idle cancel probes each unresolved steered
        // run, arms only when one is still live, and resolves the
        // settled ones out of the list (#3684 review).
        CancelArm::ProbeSteeredWork {
            daemon_session_id,
            run_ids,
        } => {
            let mut live = false;
            for run_id in &run_ids {
                if steer_run_live(link, &daemon_session_id, run_id).await {
                    live = true;
                    break;
                }
            }
            {
                let mut guard = state.lock().await;
                if let Some(hosted) = guard
                    .session
                    .as_mut()
                    .filter(|hosted| hosted.acp_session_id == session_id)
                {
                    hosted
                        .steer_runs
                        .retain(|run_id| live || !run_ids.as_slice().contains(run_id));
                }
            }
            if !live {
                return CancelOrder::None;
            }
            // Live steered work: arm the stop for it directly (the probe
            // already replaced the arm classification).
            let mut guard = state.lock().await;
            let Some(hosted) = guard
                .session
                .as_mut()
                .filter(|hosted| hosted.acp_session_id == session_id)
            else {
                return CancelOrder::None;
            };
            if hosted.cancelling {
                return CancelOrder::None;
            }
            CancelOrder::Armed(arm_stop_locked(hosted, None))
        }
    }
}

/// The in-lock classification of one `session/cancel`.
#[derive(Debug)]
enum CancelArm {
    None,
    Armed(CancelStop),
    /// Unresolved steered runs with no prompt slot: the cancel must ask
    /// the worker whether one is still live before arming.
    ProbeSteeredWork {
        daemon_session_id: String,
        run_ids: Vec<String>,
    },
}

fn arm_cancel_locked(session_id: &str, guard: &mut DaemonAcpState) -> CancelArm {
    let Some(hosted) = guard
        .session
        .as_mut()
        .filter(|hosted| hosted.acp_session_id == session_id)
    else {
        return CancelArm::None;
    };
    if hosted.cancelling {
        return CancelArm::None;
    }
    let arm = |hosted: &mut HostedSession| -> CancelArm {
        let admission_id = match hosted.turn.as_mut() {
            Some(turn) => {
                turn.cancelled = true;
                Some(turn.admission_id.clone())
            }
            None if hosted.stop_failure.is_none()
                && hosted.steer_in_flight == 0
                && hosted.steer_runs.is_empty() =>
            {
                return CancelArm::None
            }
            // A steer admission whose round trip is still in flight, or
            // the stop-failure retry: arm now - the steer may land at any
            // moment and the stop sequence's own tail withdraws it.
            None if hosted.steer_in_flight > 0 || hosted.stop_failure.is_some() => None,
            // No prompt slot, only unresolved steered runs: the worker's
            // own report decides whether the stop arms (the probe).
            None => {
                return CancelArm::ProbeSteeredWork {
                    daemon_session_id: hosted.daemon_active_session_id.clone(),
                    run_ids: hosted.steer_runs.clone(),
                }
            }
        };
        CancelArm::Armed(arm_stop_locked(hosted, admission_id))
    };
    arm(hosted)
}

/// Arm the stop sequence on a hosted session: mark the cancelling flag
/// and register the cancel task's done watch. The admission id is the
/// cancelled turn's own, or `None` when the stop owns steered work
/// with no prompt slot.
fn arm_stop_locked(hosted: &mut HostedSession, admission_id: Option<String>) -> CancelStop {
    let (done_tx, done_rx) = tokio::sync::watch::channel(false);
    hosted.cancel_task = Some(done_rx);
    hosted.cancelling = true;
    CancelStop {
        acp_session_id: hosted.acp_session_id.clone(),
        daemon_session_id: hosted.daemon_active_session_id.clone(),
        admission_id,
        done: done_tx,
    }
}

async fn wait_for_session_close(state: &Arc<Mutex<DaemonAcpState>>) {
    let close_done = { state.lock().await.session_close_done.clone() };
    if let Some(mut done) = close_done {
        let _ = done.wait_for(|finished| *finished).await;
    }
}

async fn run_cancel_stop(
    stop: CancelStop,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
) {
    let outcome = match acquire_stop_input_pause(link, state, &stop.acp_session_id).await {
        Ok(lease) => {
            match stop_session_work(
                link,
                &stop.daemon_session_id,
                stop.admission_id.as_deref(),
                state,
                &stop.acp_session_id,
            )
            .await
            {
                Ok(()) => {
                    release_session_input_pause(link, &stop.daemon_session_id, &lease.pause_id)
                        .await
                        .map(|()| lease)
                }
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    };
    {
        let mut guard = state.lock().await;
        let released_closed = matches!(
            &outcome,
            Ok(lease) if guard.closed_input_pause_id.as_deref() == Some(&lease.pause_id)
        );
        if let Some(hosted) = guard
            .session
            .as_mut()
            .filter(|hosted| hosted.acp_session_id == stop.acp_session_id)
        {
            hosted.cancelling = false;
            hosted.cancel_task = None;
            match &outcome {
                Ok(lease) => {
                    if hosted.input_pause_id.as_deref() == Some(&lease.pause_id) {
                        hosted.input_pause_id = None;
                    }
                    if hosted.input_pause_key.as_deref() == Some(&lease.lease_key) {
                        hosted.input_pause_key = None;
                    }
                    hosted.stop_failure = None;
                    // Only a COMPLETED stop retires the steered-work
                    // bookkeeping: the stop sequence's tail settled every
                    // in-flight admission, so the epoch bump retires any
                    // late settle from an admission that predates it. A
                    // failed stop keeps both, so its stop-failure retry's
                    // own tail still sees the unresolved admissions.
                    hosted.steer_in_flight = 0;
                    hosted.steer_generation = hosted.steer_generation.wrapping_add(1);
                }
                Err(error) => hosted.stop_failure = Some(error.to_string()),
            }
        }
        if released_closed {
            guard.closed_input_pause_id = None;
            guard.closed_input_pause_key = None;
        }
    }
    let _ = stop.done.send(true);
}

/// TS `stopSessionWork`: abort the worker's running and queued work, stop
/// the owned admission (a prompt sent before the stop but committed after
/// the abort), wait the idle, clear the steered-work tail, then cancel
/// the RLM children.
///
/// The steered-work tail: every steer admission whose round trip was in
/// flight when the stop armed has settled by this point (the stop waits
/// for it), so its item landed either before the first abort (cleared
/// there) or after - and one final idempotent abort clears those. The
/// final abort runs while the stop still holds its input pause and
/// `cancelling` (prompts cannot admit), so it can never hit a later
/// prompt's turn; the steering handler sends no bare abort of its own
/// (#3684 review: a bare abort racing the stop's completion could abort
/// the host's next prompt).
async fn stop_session_work(
    link: &Arc<DaemonLink>,
    daemon_session_id: &str,
    admission_id: Option<&str>,
    state: &Arc<Mutex<DaemonAcpState>>,
    acp_session_id: &str,
) -> anyhow::Result<()> {
    link.request_ok(DaemonCommand::AbortAndClearQueue {
        id: None,
        active_session_id: daemon_session_id.to_string(),
        rest: Map::default(),
    })
    .await?;
    if let Some(admission_id) = admission_id {
        cancel_owned_admission(link, daemon_session_id, admission_id).await;
    }
    link.request_ok(DaemonCommand::WaitForIdle {
        id: None,
        active_session_id: daemon_session_id.to_string(),
        wait_for_rlm_quiescence: None,
        rest: Map::default(),
    })
    .await?;
    wait_for_steer_admissions(state, acp_session_id).await;
    link.request_ok(DaemonCommand::AbortAndClearQueue {
        id: None,
        active_session_id: daemon_session_id.to_string(),
        rest: Map::default(),
    })
    .await?;
    link.request_ok(DaemonCommand::WaitForIdle {
        id: None,
        active_session_id: daemon_session_id.to_string(),
        wait_for_rlm_quiescence: None,
        rest: Map::default(),
    })
    .await?;
    cancel_outstanding_rlm_children(link, daemon_session_id).await
}

/// Park until every steer admission in flight for the hosted session has
/// settled (receipt, refusal, or link error). Steers cannot admit while a
/// stop runs (the steering admission point refuses while cancelling), so
/// the count only drains. A missing hosted session (close + new replaced
/// it) has no admissions to wait for.
async fn wait_for_steer_admissions(state: &Arc<Mutex<DaemonAcpState>>, acp_session_id: &str) {
    let notify = std::sync::Arc::clone(&state.lock().await.steer_settles);
    loop {
        // Register the waiter BEFORE the count read, so a settle between
        // the two still wakes this loop.
        let notified = notify.notified();
        let in_flight = state
            .lock()
            .await
            .session
            .as_ref()
            .filter(|hosted| hosted.acp_session_id == acp_session_id)
            .map_or(0, |hosted| hosted.steer_in_flight);
        if in_flight == 0 {
            return;
        }
        notified.await;
    }
}

/// One pass of the prompt settlement's steered-run drain: whether the
/// pass is done, must drain in-flight admissions first, or waits the
/// runs its snapshot found.
///
/// A run id enters `steered_runs` at the admission point, BEFORE its
/// Steer command reaches the worker, so a run whose admission is still
/// in flight is unknown at the worker: `WaitForSteerRun` there answers
/// no settle status, and the wait fails a prompt whose own turn already
/// succeeded (#3684 review). A pass therefore waits its runs only when
/// nothing is in flight - a pass whose snapshot carries in-flight
/// admissions parks on `wait_for_steer_admissions` again and
/// resnapshots; the runs it found are not lost, they stay un-waited in
/// `steered_runs` until a later pass with nothing in flight waits them.
enum SteerSettlementPass {
    /// Nothing new and nothing in flight: the settlement is done.
    Done,
    /// An admission is still in flight: park until it settles, then
    /// resnapshot before waiting anything.
    Drain,
    /// Nothing is in flight: these runs are registered at the worker
    /// and are waited now.
    Wait(Vec<String>),
}

fn steer_settlement_pass(new_runs: Vec<String>, in_flight: usize) -> SteerSettlementPass {
    if new_runs.is_empty() && in_flight == 0 {
        SteerSettlementPass::Done
    } else if in_flight > 0 {
        SteerSettlementPass::Drain
    } else {
        SteerSettlementPass::Wait(new_runs)
    }
}

/// TS `cancelOutstandingRlmChildren`: cancel every roster row, no status
/// filter — a row already settling keeps its own settle, and the cancels
/// run one after another (TS `Promise.allSettled` is the declared
/// divergence). A failed roster fetch or the first failed cancel fails the
/// stop; every row still gets its cancel.
async fn cancel_outstanding_rlm_children(
    link: &Arc<DaemonLink>,
    daemon_session_id: &str,
) -> anyhow::Result<()> {
    let children = fetch_rlm_children(link, daemon_session_id).await?;
    let mut failure = None;
    for child in children {
        let child_id = child
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if let Err(error) = link
            .request_ok(DaemonCommand::CancelRlmChild {
                id: None,
                active_session_id: daemon_session_id.to_string(),
                child_id,
                rest: Map::default(),
            })
            .await
        {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

/// TS `cancel_prompt_admission` with `cancelOwned`: a committed prompt's
/// running turn aborts.
async fn cancel_owned_admission(
    link: &Arc<DaemonLink>,
    daemon_session_id: &str,
    admission_id: &str,
) {
    let _ = link
        .request(DaemonCommand::CancelPromptAdmission {
            id: None,
            active_session_id: daemon_session_id.to_string(),
            admission_id: admission_id.to_string(),
            cancel_owned: Some(true),
            probe: None,
            rest: Map::default(),
        })
        .await;
}

struct InputPauseLease {
    pause_id: String,
    lease_key: String,
}

async fn acquire_stop_input_pause(
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    acp_session_id: &str,
) -> anyhow::Result<InputPauseLease> {
    let (daemon_session_id, lease_key) = {
        let mut guard = state.lock().await;
        let Some(hosted) = guard
            .session
            .as_mut()
            .filter(|hosted| hosted.acp_session_id == acp_session_id)
        else {
            anyhow::bail!("Unknown ACP session: {acp_session_id}");
        };
        let lease_key = hosted
            .input_pause_key
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        hosted.input_pause_key = Some(lease_key.clone());
        (hosted.daemon_active_session_id.clone(), lease_key)
    };
    let response = link
        .request(DaemonCommand::AcquireSessionInputPause {
            id: None,
            active_session_id: daemon_session_id.clone(),
            lease_key: lease_key.clone(),
            rest: Map::default(),
        })
        .await?;
    if !response.success {
        anyhow::bail!(response
            .error
            .unwrap_or_else(|| "unknown error".to_string()));
    }
    let pause_id = response
        .data
        .unwrap_or(Value::Null)
        .get("pauseId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("the daemon returned no session input pause id"))?;
    {
        let mut guard = state.lock().await;
        if let Some(hosted) = guard
            .session
            .as_mut()
            .filter(|hosted| hosted.acp_session_id == acp_session_id)
        {
            hosted.input_pause_id = Some(pause_id.clone());
        }
    }
    Ok(InputPauseLease {
        pause_id,
        lease_key,
    })
}

async fn release_session_input_pause(
    link: &Arc<DaemonLink>,
    daemon_session_id: &str,
    pause_id: &str,
) -> anyhow::Result<()> {
    link.request_ok(DaemonCommand::ReleaseSessionInputPause {
        id: None,
        active_session_id: daemon_session_id.to_string(),
        pause_id: pause_id.to_string(),
        rest: Map::default(),
    })
    .await
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
        // The Python ACP SDK sends extension methods as `_{method}`
        // (`acp/client/connection.py`: `ext_method` prefixes the
        // underscore), and verifiers calls
        // `ext_method("session/steering", ...)` - so the wire method is
        // `_session/steering`. Both names serve the same arm.
        "session/steering" | "_session/steering" => {
            handle_session_steering(id, params, link, state, tx).await;
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
        if guard.session.is_some()
            || guard.session_new_in_flight
            || guard.session_close_done.is_some()
        {
            let _ = tx.send(super::internal_error(
                &id,
                "prime-agent ACP mode hosts one session per connection; start another prime-agent process for a second session",
            ));
            return;
        }
        guard.session_new_in_flight = true;
    }
    let params = types::NewSessionParams::parse(&params);
    if !state.lock().await.mcp_server_names.is_empty() {
        if let Err(error) = clear_connection_servers(
            link,
            &binding.active_session_id,
            &binding.mcp_owner_id,
            state,
        )
        .await
        {
            state.lock().await.session_new_in_flight = false;
            let _ = tx.send(super::internal_error(&id, &error.to_string()));
            return;
        }
    }
    // MCP admission runs after the pending-clear retry: a rejected list
    // fails the request with the same error payloads.
    let resolved =
        match super::mcp::resolve_acp_mcp_servers(&params.mcp_servers, &options.actual_cwd) {
            Ok(resolved) => resolved,
            Err(reason) => {
                state.lock().await.session_new_in_flight = false;
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
        state.lock().await.session_new_in_flight = false;
        let _ = tx.send(super::internal_error(&id, &details));
        return;
    }

    let acp_session_id = uuid::Uuid::new_v4().to_string();
    let producer = UpdateProducer::new(acp_session_id.clone(), tx.clone());
    // Neither picker fetch may fail the admission: discovery failures
    // catch to an empty list, a state fetch failure degrades to no
    // options.
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
    let mut hosted = HostedSession {
        acp_session_id: acp_session_id.clone(),
        daemon_active_session_id: binding.active_session_id.clone(),
        producer,
        config,
        cancelling: false,
        stop_failure: None,
        input_pause_key: None,
        input_pause_id: None,
        cancel_task: None,
        turn: None,
        steer_in_flight: 0,
        steer_generation: 0,
        steer_runs: Vec::new(),
        assistant_stop_reason: None,
        mapping: WireMappingState::default(),
        observed_children: std::collections::HashSet::new(),
    };
    // The ACP MCP servers ride the wire command, not a local manager.
    let replace_skipped = resolved.is_empty() && state.lock().await.mcp_server_names.is_empty();
    if !replace_skipped {
        // A failed response does not prove the worker rejected this list.
        // Keep the names until a clear is acknowledged, even if the
        // best-effort clear below also loses its acknowledgement.
        if !resolved.is_empty() {
            state.lock().await.mcp_server_names = resolved
                .iter()
                .map(pa_core::mcp::AcpMcpServerConfig::name)
                .map(str::to_string)
                .collect();
        }
        if let Err(error) = replace_connection_servers(
            link,
            &binding.active_session_id,
            &binding.mcp_owner_id,
            &resolved,
        )
        .await
        {
            // The worker may have applied the list before this failed (a
            // lost acknowledgement); the clear is best-effort, like TS.
            let _ = clear_connection_servers(
                link,
                &binding.active_session_id,
                &binding.mcp_owner_id,
                state,
            )
            .await;
            state.lock().await.session_new_in_flight = false;
            let _ = tx.send(super::internal_error(&id, &error.to_string()));
            return;
        }
        if resolved.is_empty() {
            state.lock().await.mcp_server_names.clear();
        }
    }

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
    // Install the hosted session before the admission response leaves
    // (an immediate `session/set_config_option` must resolve against
    // it). The producer gate opens only after the response is queued,
    // so no held update can precede it.
    let producer = Arc::clone(&hosted.producer);
    let inherited_pause = {
        let mut guard = state.lock().await;
        guard.session_new_in_flight = false;
        if let Some(pause_id) = guard.closed_input_pause_id.clone() {
            hosted.input_pause_id = Some(pause_id);
            hosted.input_pause_key = guard.closed_input_pause_key.clone();
        }
        guard.session = Some(hosted);
        guard
            .closed_input_pause_id
            .clone()
            .zip(guard.closed_input_pause_key.clone())
    };
    let children = match fetch_rlm_children(link, &binding.active_session_id).await {
        Ok(children) => children,
        Err(error) => {
            let _ = clear_connection_servers(
                link,
                &binding.active_session_id,
                &binding.mcp_owner_id,
                state,
            )
            .await;
            let mut guard = state.lock().await;
            guard.session = None;
            guard.session_new_in_flight = false;
            drop(guard);
            let _ = tx.send(super::internal_error(&id, &error.to_string()));
            return;
        }
    };
    {
        let mut guard = state.lock().await;
        if let Some(current) = guard.session.as_mut() {
            for child in children {
                let id = child.get("id").and_then(Value::as_str).unwrap_or_default();
                if !current.observed_children.insert(id.to_string()) {
                    continue;
                }
                let event = json!({ "type": "rlm_child_update", "child": child });
                for update in wire_events::wire_updates(&event, &mut current.mapping) {
                    let _ = current
                        .producer
                        .publish(&update, 0, PrimeAgentEventPhase::Event, None)
                        .await;
                }
            }
        }
    }
    let _ = tx.send(jsonrpc::response(&id, &result));
    if let Some((pause_id, lease_key)) = inherited_pause {
        match release_session_input_pause(link, &binding.active_session_id, &pause_id).await {
            Ok(()) => {
                let mut guard = state.lock().await;
                if guard.closed_input_pause_id.as_deref() == Some(&pause_id) {
                    guard.closed_input_pause_id = None;
                    guard.closed_input_pause_key = None;
                }
                if let Some(hosted) = guard
                    .session
                    .as_mut()
                    .filter(|hosted| hosted.input_pause_id.as_deref() == Some(&pause_id))
                {
                    hosted.input_pause_id = None;
                    if hosted.input_pause_key.as_deref() == Some(&lease_key) {
                        hosted.input_pause_key = None;
                    }
                }
            }
            Err(error) => {
                if let Some(hosted) = state
                    .lock()
                    .await
                    .session
                    .as_mut()
                    .filter(|hosted| hosted.input_pause_id.as_deref() == Some(&pause_id))
                {
                    hosted.stop_failure = Some(error.to_string());
                }
            }
        }
    }
    producer.commit_session_new_response().await;
}

async fn replace_connection_servers(
    link: &Arc<DaemonLink>,
    daemon_session_id: &str,
    owner_id: &str,
    resolved: &[pa_core::mcp::AcpMcpServerConfig],
) -> anyhow::Result<()> {
    link.request_ok(DaemonCommand::ReplaceAcpMcpServers {
        id: None,
        active_session_id: daemon_session_id.to_string(),
        owner_id: owner_id.to_string(),
        servers: serde_json::to_value(resolved)?,
        rest: Map::default(),
    })
    .await
}

async fn clear_connection_servers(
    link: &Arc<DaemonLink>,
    daemon_session_id: &str,
    owner_id: &str,
    state: &Arc<Mutex<DaemonAcpState>>,
) -> anyhow::Result<()> {
    replace_connection_servers(link, daemon_session_id, owner_id, &[]).await?;
    state.lock().await.mcp_server_names.clear();
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

/// `session/steering`: inject a user message into the bound session's
/// running turn (the nano-rlm #205 extension, ported onto the daemon's
/// `steer` lane). The text joins the busy turn's conversation at its next
/// delivery boundary - tools are never interrupted. With no running
/// turn, idle steering is refused with the nano-rlm receipt
/// `{outcome: promptRequired, reason: noRunningTurn}` (idle steering
/// never starts a turn); `_meta.steering.idleBehavior: "queued"` opts
/// back into the port's wake behavior (the steer runs as the session's
/// next turn).
///
/// The receipt's `injected` is the worker's own report that the ACP
/// prompt's turn is running (the admission probe), never an ACP-side
/// snapshot: the slot outlives the worker's busy and precedes it in
/// races, and the worker's busy flag can belong to non-ACP work (a
/// heartbeat, an agent message, an RLM child notice) while the ACP
/// prompt itself still parks on the follow-up lane.
///
/// Each admitted steer carries a `runId`: the worker registers the run
/// and resolves it at the item's turn settle, so the ACP layer can wait
/// for (or probe) the run's own outcome - the prompt settlement waits for
/// the runs admitted during its turn and surfaces a steered run's
/// failure, and an idle `session/cancel` asks whether steered work is
/// still live instead of arming on a stale count.
async fn handle_session_steering(
    id: Value,
    params: Value,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    tx: producer::FrameSink,
) {
    let params = types::SteeringParams::parse(&params);
    if let Err(response) = validate_steering_request(&id, &params) {
        let _ = tx.send(response);
        return;
    }
    // The admission is one lock window: the guard checks, the block
    // validation (no awaits), the in-flight registration, and the run-id
    // handoff all run under it, so a `session/cancel` either refuses the
    // steer (it is cancelling) or arms its stop only after the admission
    // is already tracked. The send then runs without holding the lock
    // (the busy prompt's settle locks the same state, and the
    // session-event consumer must pass through while the round trip is in
    // flight).
    let admission = {
        let mut guard = state.lock().await;
        let session_closing = guard.session_close_done.is_some();
        let Some(hosted) = guard
            .session
            .as_mut()
            .filter(|hosted| hosted.acp_session_id == params.session_id)
        else {
            let _ = tx.send(super::internal_error(
                &id,
                &format!("Unknown ACP session: {}", params.session_id),
            ));
            return;
        };
        if session_closing {
            let _ = tx.send(super::internal_error(
                &id,
                &format!("ACP session is closing: {}", params.session_id),
            ));
            return;
        }
        if hosted.cancelling {
            let _ = tx.send(super::internal_error(
                &id,
                &format!("ACP session is cancelling: {}", params.session_id),
            ));
            return;
        }
        if let Some(stop_failure) = hosted.stop_failure.clone() {
            let _ = tx.send(super::internal_error(
                &id,
                &format!("ACP session stop failed: {stop_failure}"),
            ));
            return;
        }
        // Steering admits text blocks only: the daemon's steer lane has
        // no image surface, and a dropped image block would let a client
        // believe it was accepted (the prompt-block rule).
        let blocks_invalid = params.prompt.is_empty()
            || params.prompt.iter().any(|block| {
                block.get("type").and_then(Value::as_str) != Some("text")
                    || block.get("text").and_then(Value::as_str).is_none()
            });
        let message = params
            .prompt
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        if blocks_invalid || message.trim().is_empty() {
            let _ = tx.send(jsonrpc::error_response(
                &id,
                jsonrpc::INVALID_PARAMS,
                "Invalid params",
                Some(&json!({
                    "reason": "steering requires non-empty text content blocks"
                })),
            ));
            return;
        }
        // The idle receipt (nano-rlm #205): no running turn can consume
        // the message, so idle steering never starts one. The port's
        // wake behavior stays available through the explicit opt-in.
        let daemon_session_id = hosted.daemon_active_session_id.clone();
        let prompt_admission = hosted.turn.as_ref().map(|turn| turn.admission_id.clone());
        if prompt_admission.is_none() && params.idle_behavior.as_deref() != Some("queued") {
            let _ = tx.send(jsonrpc::response(
                &id,
                &json!({ "outcome": "promptRequired", "reason": "noRunningTurn" }),
            ));
            return;
        }
        // The admission point: the in-flight registration happens BEFORE
        // the worker round trip, and only a completed stop sequence
        // resets it - a `session/cancel` that arms while the Steer
        // command is in flight must see it. The count only holds
        // unresolved round trips (every settle decrements, epoch-guarded
        // so a settle spanning a stop reset unwinds nothing), and the
        // captured epoch retires an admission whose round trip spans a
        // stop reset (its unit is already gone - the count now belongs to
        // newer admissions - so a late settle must not eat one of theirs).
        let admitted_epoch = hosted.steer_generation;
        hosted.steer_in_flight += 1;
        let run_id = format!("steer-run:{}", uuid::Uuid::new_v4());
        match hosted.turn.as_mut() {
            // A busy-turn steer belongs to the prompt's settlement: its
            // run is waited there and a failure fails the prompt.
            Some(turn) => turn.steered_runs.push(run_id.clone()),
            // An idle-queued steer runs as its own turn: the run stays
            // on the session for the idle cancel's liveness probe.
            None => hosted.steer_runs.push(run_id.clone()),
        }
        SteeringAdmission {
            daemon_session_id,
            run_id,
            prompt_admission,
            admitted_epoch,
            message,
        }
    };
    let steer = DaemonCommand::Steer {
        id: None,
        active_session_id: admission.daemon_session_id.clone(),
        message: admission.message,
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
        rest: json!({ "runId": admission.run_id })
            .as_object()
            .cloned()
            .unwrap_or_default(),
    };
    let response = match link.request(steer).await {
        Ok(response) => response,
        Err(error) => {
            // The envelope was written before the link failed, so the
            // steer MAY have landed: the refusal never claims it did not,
            // and the error data marks the ambiguity so a host does not
            // retry blindly. The run stays tracked; a `session/cancel`
            // probes it.
            settle_steer_admission(state, &params.session_id, admission.admitted_epoch).await;
            let details = format!("prime-agent steering failed: {error}");
            let _ = tx.send(jsonrpc::error_response(
                &id,
                jsonrpc::INTERNAL_ERROR,
                "Internal error",
                Some(&json!({
                    "details": details,
                    "steerMayHaveLanded": true,
                })),
            ));
            return;
        }
    };
    if !response.success {
        let failure = response
            .error
            .unwrap_or_else(|| "unknown error".to_string());
        // A refused steer provably never landed (the queue command
        // rejects before it enqueues), so this admission unwinds its own
        // registration: the in-flight count releases its unit (a later
        // idle `session/cancel` no-ops again instead of arming a full
        // stop for work that does not exist), and the run id leaves the
        // tracking - the worker never saw it, so the prompt settlement
        // must not wait an unknown run and the idle cancel must not
        // probe it. The in-flight unwind is epoch-guarded: an admission
        // whose round trip spans a stop reset unwinds nothing (the reset
        // already retired its unit, and the count now tracks newer
        // admissions whose units a bare subtraction would eat). The run
        // id is unique, so its removal needs no epoch.
        {
            let mut guard = state.lock().await;
            if let Some(hosted) = guard
                .session
                .as_mut()
                .filter(|hosted| hosted.acp_session_id == params.session_id)
            {
                if let Some(turn) = hosted.turn.as_mut() {
                    turn.steered_runs
                        .retain(|run_id| run_id != &admission.run_id);
                }
                hosted
                    .steer_runs
                    .retain(|run_id| run_id != &admission.run_id);
            }
        }
        settle_steer_admission(state, &params.session_id, admission.admitted_epoch).await;
        let _ = tx.send(super::internal_error(
            &id,
            &format!("prime-agent steering failed: {failure}"),
        ));
        return;
    }
    // The guard raced a `session/cancel` that armed while the steer was
    // in flight: the stop sequence's own tail withdraws the just-landed
    // steer (it waits for this admission to settle, then re-runs its
    // abort under its own input pause), so this is only the refusal - a
    // bare abort here could land after the stop completed and abort the
    // host's NEXT prompt (#3684 review). A close owns its own stop with
    // the same tail, so only the cancelling case refuses here.
    let raced_cancel = {
        let guard = state.lock().await;
        guard
            .session
            .as_ref()
            .filter(|hosted| hosted.acp_session_id == params.session_id)
            .is_some_and(|hosted| hosted.cancelling)
    };
    settle_steer_admission(state, &params.session_id, admission.admitted_epoch).await;
    if raced_cancel {
        let _ = tx.send(super::internal_error(
            &id,
            &format!("ACP session is cancelling: {}", params.session_id),
        ));
        return;
    }
    // The session closed during the admission: the close's own stop
    // sequence (with the same steered-work tail) dealt with the steer,
    // so this is only the refusal.
    let still_live = {
        let guard = state.lock().await;
        let session_closing = guard.session_close_done.is_some();
        guard
            .session
            .as_ref()
            .filter(|hosted| hosted.acp_session_id == params.session_id)
            .map(|_| session_closing)
    };
    if let Some(true) = still_live {
        let _ = tx.send(super::internal_error(
            &id,
            &format!("ACP session is closing: {}", params.session_id),
        ));
        return;
    }
    if still_live.is_none() {
        let _ = tx.send(super::internal_error(
            &id,
            &format!("Unknown ACP session: {}", params.session_id),
        ));
        return;
    }
    // The receipt's truth is the worker's own report of the ACP prompt's
    // turn (the admission probe): `injected` only when the prompt's own
    // turn is running. Either ACP-side snapshot alone lies - the slot is
    // set before the prompt reaches the worker and stays held through
    // the settle's trailing fetches, while the worker can be busy with
    // non-ACP work (a heartbeat, an agent message, an RLM child notice)
    // while the ACP prompt still parks on the follow-up lane, its steer
    // landing ahead of it.
    let injected = match admission.prompt_admission.as_deref() {
        Some(prompt_admission) => {
            prompt_admission_running(link, &admission.daemon_session_id, prompt_admission).await
        }
        None => false,
    };
    let outcome = steer_outcome(injected);
    let _ = tx.send(jsonrpc::response(&id, &json!({ "outcome": outcome })));
}

/// One admitted steer, handed from the admission lock window to the
/// round trip.
struct SteeringAdmission {
    daemon_session_id: String,
    run_id: String,
    prompt_admission: Option<String>,
    admitted_epoch: u64,
    message: String,
}

/// The request's own validation, before any state is read: the optional
/// `messageId` is accepted and ignored (the declared divergence - the
/// daemon steer lane has no per-message identity surface), but a
/// malformed one is the request's invalid-params error, never dropped
/// input; the `idleBehavior` opt-in must name a known behavior.
fn validate_steering_request(
    id: &Value,
    params: &types::SteeringParams,
) -> std::result::Result<(), Value> {
    let invalid = |reason: &str| {
        jsonrpc::error_response(
            id,
            jsonrpc::INVALID_PARAMS,
            "Invalid params",
            Some(&json!({ "reason": reason })),
        )
    };
    let message_id_valid = match params.message_id.as_ref() {
        None => true,
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => false,
    };
    if !message_id_valid {
        return Err(invalid(
            "steering messageId must be a non-empty string when provided",
        ));
    }
    match params.idle_behavior.as_deref() {
        None | Some("promptRequired" | "queued") => Ok(()),
        Some(other) => Err(invalid(&format!(
            "steering idleBehavior must be promptRequired or queued, not {other}"
        ))),
    }
}

/// Settle one steer admission: the in-flight count releases its unit
/// (epoch-guarded: an admission whose round trip spans a completed stop
/// reset unwinds nothing - the reset already retired its unit) and the
/// stop sequences waiting on the in-flight set wake.
async fn settle_steer_admission(
    state: &Arc<Mutex<DaemonAcpState>>,
    acp_session_id: &str,
    admitted_epoch: u64,
) {
    let notify = {
        let mut guard = state.lock().await;
        let notify = std::sync::Arc::clone(&guard.steer_settles);
        if let Some(hosted) = guard
            .session
            .as_mut()
            .filter(|hosted| hosted.acp_session_id == acp_session_id)
        {
            if hosted.steer_generation == admitted_epoch {
                hosted.steer_in_flight = hosted.steer_in_flight.saturating_sub(1);
            }
        }
        notify
    };
    notify.notify_waiters();
}

/// Whether one steered run is still live (queued or its turn in flight):
/// the worker's own probe report. A failed probe answers live - the
/// stop's own abort settles the ambiguity - and a settled run resolves
/// out of the ACP tracking.
async fn steer_run_live(link: &Arc<DaemonLink>, daemon_session_id: &str, run_id: &str) -> bool {
    let Ok(response) = link
        .request(DaemonCommand::WaitForSteerRun {
            id: None,
            active_session_id: daemon_session_id.to_string(),
            run_id: run_id.to_string(),
            probe: Some(true),
            rest: Map::default(),
        })
        .await
    else {
        return true;
    };
    if !response.success {
        return true;
    }
    response
        .data
        .as_ref()
        .and_then(|data| data.get("status"))
        .and_then(Value::as_str)
        == Some("running")
}

/// Wait for one steered run's settle. `Ok(None)` = the run settled
/// without a failure (completed, aborted, or withdrawn before delivery);
/// `Ok(Some(text))` = the run's turn failed with `text`.
///
/// # Errors
///
/// Returns an error when the daemon connection fails or the answer does
/// not carry a known status.
async fn wait_steer_run(
    link: &Arc<DaemonLink>,
    daemon_session_id: &str,
    run_id: &str,
) -> anyhow::Result<Option<String>> {
    // Turn-long: a steered run's turn may run for minutes, so the wait
    // has no fixed cap (the link close is the liveness bound, like
    // `prompt_and_wait` and `wait_for_idle`).
    let response = link
        .request_until_close(DaemonCommand::WaitForSteerRun {
            id: None,
            active_session_id: daemon_session_id.to_string(),
            run_id: run_id.to_string(),
            probe: None,
            rest: Map::default(),
        })
        .await?;
    if !response.success {
        anyhow::bail!(response
            .error
            .unwrap_or_else(|| "unknown error".to_string()));
    }
    match response
        .data
        .as_ref()
        .and_then(|data| data.get("status"))
        .and_then(Value::as_str)
    {
        Some("completed" | "aborted" | "withdrawn") => Ok(None),
        Some("failed") => Ok(Some(
            response
                .data
                .as_ref()
                .and_then(|data| data.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("unknown steered-run failure")
                .to_string(),
        )),
        _ => anyhow::bail!("the daemon returned no steered-run settle status"),
    }
}

/// Whether the ACP prompt's own turn is the worker's running turn (the
/// read-only admission probe). A failed probe answers `false`: the
/// receipt stays honest - `injected` requires the positive report.
async fn prompt_admission_running(
    link: &Arc<DaemonLink>,
    daemon_session_id: &str,
    admission_id: &str,
) -> bool {
    let Ok(response) = link
        .request(DaemonCommand::CancelPromptAdmission {
            id: None,
            active_session_id: daemon_session_id.to_string(),
            admission_id: admission_id.to_string(),
            cancel_owned: None,
            probe: Some(true),
            rest: Map::default(),
        })
        .await
    else {
        return false;
    };
    if !response.success {
        return false;
    }
    response
        .data
        .as_ref()
        .and_then(|data| data.get("running"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// The steer receipt: `injected` only when the worker reported the ACP
/// prompt's own turn running (the admission probe); everything else -
/// the prompt still parked on the follow-up lane behind non-ACP work, the
/// prompt's turn already settled (a trailing-window steer), or an
/// idle-queued steer - is `queued`.
fn steer_outcome(prompt_turn_running: bool) -> &'static str {
    if prompt_turn_running {
        "injected"
    } else {
        "queued"
    }
}

/// Release this prompt's turn slot, after its stop sequence if it was
/// cancelled. A slot holding another prompt's turn (close + new while
/// this prompt ran) is left alone.
async fn release_turn_slot(state: &Arc<Mutex<DaemonAcpState>>, admission_id: &str) {
    let mut cancel_task = {
        let mut guard = state.lock().await;
        let Some(hosted) = guard.session.as_mut() else {
            return;
        };
        let Some(turn) = hosted.turn.as_mut() else {
            return;
        };
        if turn.admission_id != admission_id {
            return;
        }
        hosted.cancel_task.clone()
    };
    if let Some(cancel_task) = cancel_task.as_mut() {
        let _ = cancel_task.changed().await;
    }
    if let Some(hosted) = state.lock().await.session.as_mut() {
        // The turn's steered runs outlive the slot (the prompt may have
        // answered before a trailing-window steer ran, or failed before
        // its settlement could wait for them): they migrate to the
        // session list, where an idle `session/cancel` probes them for
        // live steered work.
        if let Some(turn) = hosted
            .turn
            .take_if(|turn| turn.admission_id == admission_id)
        {
            hosted.steer_runs.extend(turn.steered_runs);
        }
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
            // The lost supervisor link (route timeout, worker loss) is
            // classified like every other failed-prompt arm: typed data,
            // never retryable at the boundary — the turn's outcome is
            // unknown, so a host retry may re-run side-effecting tools.
            return super::turn_failure_error(&id, &error.to_string(), &error.to_string());
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
        // The worker's failure text classifies into the #200 host
        // contract (the raw text still never rides past `details`), so
        // the reply data is machine-readable at the transport boundary.
        return super::turn_failure_error(
            &id,
            &failure,
            &format!("prime-agent turn failed: {failure}"),
        );
    }
    // The steers admitted during this turn settle inside this window: a
    // mid-turn steer joined this very turn (its run already settled with
    // it), and a trailing-window steer runs right after it. A steered
    // run's failure fails the owning prompt's response - the steered
    // text was the host's message to THIS turn, and answering success
    // while its continuation failed on the model would lose the failure
    // entirely (#3684 review).
    //
    // The drain is a fixpoint, because a steer registers its run id
    // BEFORE its worker round trip: the wait first drains the in-flight
    // admissions (so their runs are registered at the worker before any
    // run is waited), then waits the runs admitted so far, and repeats
    // until a pass admits nothing new and nothing is in flight. Steers
    // can still be admitted into this turn while the slot is held, and
    // one admitted after a drain returned but before the snapshot is
    // already in `steered_runs` with its Steer round trip still in
    // flight: its pass drains again before waiting anything, because
    // the run id is unknown at the worker until the round trip lands
    // and waiting it would fail the prompt on a missing settle status.
    let mut waited_steered_runs: Vec<String> = Vec::new();
    loop {
        wait_for_steer_admissions(state, &params.session_id).await;
        let (new_runs, in_flight) = {
            let guard = state.lock().await;
            let hosted = guard
                .session
                .as_ref()
                .filter(|hosted| hosted.acp_session_id == params.session_id);
            let new_runs = hosted
                .and_then(|hosted| hosted.turn.as_ref())
                .filter(|turn| turn.admission_id == admission_id)
                .map(|turn| {
                    turn.steered_runs
                        .iter()
                        .filter(|run_id| !waited_steered_runs.contains(run_id))
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let in_flight = hosted.map_or(0, |hosted| hosted.steer_in_flight);
            (new_runs, in_flight)
        };
        match steer_settlement_pass(new_runs, in_flight) {
            SteerSettlementPass::Done => break,
            // The loop head's wait_for_steer_admissions parks on the
            // in-flight admissions; this pass resnapshots once they
            // settle and waits its runs then.
            SteerSettlementPass::Drain => {}
            SteerSettlementPass::Wait(new_runs) => {
                for run_id in &new_runs {
                    match wait_steer_run(link, &hosted_daemon_session_id, run_id).await {
                        Ok(None) => {}
                        Ok(Some(failure)) => {
                            eprintln!("pa-daemon: acp steered run failed: {failure}");
                            publish_error_boundary(&producer, turn_id).await;
                            producer.finish_prompt(turn_id).await;
                            // The steered text was the host's message to
                            // THIS turn: its failure classifies into the
                            // #200 host contract like every other
                            // failed-prompt arm.
                            return super::turn_failure_error(
                                &id,
                                &failure,
                                &format!("prime-agent steered run failed: {failure}"),
                            );
                        }
                        Err(error) => {
                            publish_error_boundary(&producer, turn_id).await;
                            producer.finish_prompt(turn_id).await;
                            // The wait's own failure carries the typed data
                            // too, never a bare `details` arm.
                            return super::turn_failure_error(
                                &id,
                                &error.to_string(),
                                &format!("prime-agent steered run wait failed: {error}"),
                            );
                        }
                    }
                }
                waited_steered_runs.extend(new_runs);
            }
        }
    }
    // The resolved runs leave the turn's tracking: they are done, and
    // the slot release must not migrate already-settled runs into the
    // session list for idle-cancel probes.
    {
        let mut guard = state.lock().await;
        if let Some(hosted) = guard
            .session
            .as_mut()
            .filter(|hosted| hosted.acp_session_id == params.session_id)
        {
            if let Some(turn) = hosted.turn.as_mut() {
                turn.steered_runs
                    .retain(|run_id| !waited_steered_runs.contains(run_id));
            }
        }
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
    // publishes a wrong count — with the same typed data as every other
    // failed-prompt arm.
    let children = match fetch_rlm_children(link, &hosted_daemon_session_id).await {
        Ok(children) => children,
        Err(error) => {
            publish_error_boundary(&producer, turn_id).await;
            producer.finish_prompt(turn_id).await;
            return super::turn_failure_error(&id, &error.to_string(), &error.to_string());
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
                return super::turn_failure_error(
                    &id,
                    &error.to_string(),
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
                return super::turn_failure_error(
                    &id,
                    &error.to_string(),
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
            // The typed shape even for a publish failure: a host can tell
            // "classified, not retryable" from an untyped error here too.
            return super::turn_failure_error(
                &id,
                "Failed to publish ACP completion",
                "Failed to publish ACP completion",
            );
        }
        break status;
    };
    // The stop reason follows the TS mapping (acp-stop-reason.ts) plus the
    // turn's final assistant stop reason (#3363): the abort flag read after
    // the settlement, the settlement's status (`pending.status`), not the
    // first observation's, and the newest assistant stop reason — the link's
    // one frame consumer applies every message_end (the autonomous
    // continuations' included, since they run inside the waits above) before
    // the response that ended each wait resolved, so this read after the
    // settlement sees the run's final one.
    let (cancelled, assistant_stop_reason) = {
        let guard = state.lock().await;
        (
            turn_cancelled(&guard, admission_id),
            guard
                .session
                .as_ref()
                .and_then(|hosted| hosted.assistant_stop_reason),
        )
    };
    let stop_reason =
        meta::acp_stop_reason_for_status(cancelled, Some(&settled_status), assistant_stop_reason);
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

async fn handle_session_close(
    id: Value,
    params: Value,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    tx: producer::FrameSink,
    close_done: tokio::sync::watch::Sender<bool>,
    owner_id: String,
) {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let cancel_task = {
        let guard = state.lock().await;
        guard
            .session
            .as_ref()
            .filter(|hosted| hosted.acp_session_id == session_id)
            .and_then(|hosted| hosted.cancel_task.clone())
    };
    if let Some(mut cancel_task) = cancel_task {
        let _ = cancel_task.changed().await;
    }
    let (acp_session_id, daemon_session_id, config, producer, admission_id) = {
        let mut guard = state.lock().await;
        let Some(hosted) = guard
            .session
            .as_mut()
            .filter(|hosted| hosted.acp_session_id == session_id)
        else {
            drop(guard);
            state.lock().await.session_close_done = None;
            let _ = close_done.send(true);
            return;
        };
        hosted.cancelling = true;
        if let Some(turn) = hosted.turn.as_mut() {
            turn.cancelled = true;
        }
        let admission_id = hosted.turn.as_ref().map(|turn| turn.admission_id.clone());
        (
            hosted.acp_session_id.clone(),
            hosted.daemon_active_session_id.clone(),
            Arc::clone(&hosted.config),
            Arc::clone(&hosted.producer),
            admission_id,
        )
    };
    let close_result = match acquire_stop_input_pause(link, state, &acp_session_id).await {
        Ok(lease) => {
            match stop_session_work(
                link,
                &daemon_session_id,
                admission_id.as_deref(),
                state,
                &acp_session_id,
            )
            .await
            {
                Ok(()) => {
                    // The serialized config work settles before the
                    // producer fences (TS `await configTask`).
                    let _ = config.queue.lock().await;
                    producer.close().await;
                    let _ =
                        clear_connection_servers(link, &daemon_session_id, &owner_id, state).await;
                    let mut guard = state.lock().await;
                    guard.closed_input_pause_id = Some(lease.pause_id.clone());
                    guard.closed_input_pause_key = Some(lease.lease_key.clone());
                    if let Some(hosted) = guard
                        .session
                        .as_mut()
                        .filter(|hosted| hosted.acp_session_id == session_id)
                    {
                        if hosted.input_pause_id.as_deref() == Some(&lease.pause_id) {
                            hosted.input_pause_id = None;
                        }
                        if hosted.input_pause_key.as_deref() == Some(&lease.lease_key) {
                            hosted.input_pause_key = None;
                        }
                        hosted.stop_failure = None;
                    }
                    guard
                        .session
                        .take_if(|hosted| hosted.acp_session_id == session_id);
                    Ok(())
                }
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    };
    {
        let mut guard = state.lock().await;
        if let Some(hosted) = guard
            .session
            .as_mut()
            .filter(|hosted| hosted.acp_session_id == acp_session_id)
        {
            hosted.cancelling = false;
            if let Err(error) = &close_result {
                hosted.stop_failure = Some(error.to_string());
            }
        }
        guard.session_close_done = None;
    }
    let _ = close_done.send(true);
    match close_result {
        Ok(()) => {
            let _ = tx.send(jsonrpc::response(&id, &json!({})));
        }
        Err(error) => {
            let _ = tx.send(super::internal_error(&id, &error.to_string()));
        }
    }
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
    if let Some(hosted) = hosted.as_ref() {
        if let Some(turn) = hosted.turn.as_ref() {
            cancel_owned_admission(link, &binding.active_session_id, &turn.admission_id).await;
        }
        if let Some(pause_id) = hosted.input_pause_id.as_ref() {
            let _ = release_session_input_pause(link, &binding.active_session_id, pause_id).await;
        }
    }
    let closed_pause = {
        let mut guard = state.lock().await;
        guard.closed_input_pause_key = None;
        guard.closed_input_pause_id.take()
    };
    if let Some(pause_id) = closed_pause {
        let _ = release_session_input_pause(link, &binding.active_session_id, &pause_id).await;
    }
    let _ = clear_connection_servers(
        link,
        &binding.active_session_id,
        &binding.mcp_owner_id,
        state,
    )
    .await;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn hosted_session() -> HostedSession {
        let (sink, _drain) = mpsc::unbounded_channel();
        HostedSession {
            acp_session_id: "acp-1".to_string(),
            daemon_active_session_id: "daemon-1".to_string(),
            producer: UpdateProducer::new("acp-1", sink),
            config: Arc::new(HostedConfig {
                queue: tokio::sync::Mutex::new(()),
                published: tokio::sync::Mutex::new(Vec::new()),
                models: tokio::sync::Mutex::new(Vec::new()),
            }),
            cancelling: false,
            stop_failure: None,
            input_pause_key: None,
            input_pause_id: None,
            cancel_task: None,
            turn: None,
            steer_in_flight: 0,
            steer_generation: 0,
            steer_runs: Vec::new(),
            assistant_stop_reason: None,
            mapping: WireMappingState::default(),
            observed_children: std::collections::HashSet::new(),
        }
    }

    fn state(session: Option<HostedSession>) -> DaemonAcpState {
        DaemonAcpState {
            session,
            ..DaemonAcpState::default()
        }
    }

    #[tokio::test]
    async fn eof_waits_for_a_reserved_close_before_taking_the_session() {
        let state = Arc::new(Mutex::new(state(Some(hosted_session()))));
        let fake = fake_link();
        let order = frame_order_prefix(
            &Incoming::Request {
                id: json!(1),
                method: "session/close".to_string(),
                params: json!({ "sessionId": "acp-1" }),
            },
            &fake.link,
            &state,
        )
        .await;
        let FrameOrder::Close { done, .. } = order else {
            panic!("the close should reserve its stop");
        };
        let eof = tokio::spawn({
            let state = Arc::clone(&state);
            async move {
                wait_for_session_close(&state).await;
                state.lock().await.session.take().is_some()
            }
        });
        tokio::task::yield_now().await;
        assert!(
            !eof.is_finished(),
            "EOF must not take the session before close finishes"
        );
        assert!(state.lock().await.session.is_some());
        done.send(true).unwrap();
        state.lock().await.session_close_done = None;
        assert!(eof.await.unwrap());

        // A close can settle before EOF checks the state. No stale watch
        // should be awaited, and the hosted session is still available.
        let (done, mut done_rx) = tokio::sync::watch::channel(false);
        let settled = Arc::new(Mutex::new(self::state(Some(hosted_session()))));
        done.send(true).unwrap();
        assert!(*done_rx.borrow_and_update());
        settled.lock().await.session_close_done = Some(done_rx);
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            wait_for_session_close(&settled),
        )
        .await
        .expect("an already completed close must not strand EOF");
    }

    #[tokio::test]
    async fn lost_replace_and_clear_ack_retries_clear_before_an_empty_session() {
        let (writer, mut commands) = mpsc::unbounded_channel::<String>();
        let (_frames_tx, frames) = mpsc::unbounded_channel();
        let pending = Arc::new(std::sync::Mutex::new(HashMap::new()));
        let link = Arc::new(DaemonLink {
            writer,
            pending: Arc::clone(&pending),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            frames: Mutex::new(frames),
            protocol_version: DAEMON_PROTOCOL_VERSION,
            next_request_id: std::sync::atomic::AtomicU64::new(0),
        });
        let worker = tokio::spawn(async move {
            let mut replacements = Vec::new();
            let mut installed = Vec::<String>::new();
            while let Some(line) = commands.recv().await {
                let envelope: DaemonCommandEnvelope = serde_json::from_str(&line).unwrap();
                let id = envelope.id;
                let (command, data, lose_ack) = match envelope.command {
                    DaemonCommand::GetConnectionState { .. } => {
                        ("get_connection_state", None, false)
                    }
                    DaemonCommand::GetAvailableModels { .. } => {
                        ("get_available_models", Some(json!({ "models": [] })), false)
                    }
                    DaemonCommand::GetRlmChildren { .. } => {
                        ("get_rlm_children", Some(json!({ "children": [] })), false)
                    }
                    DaemonCommand::ReplaceAcpMcpServers { servers, .. } => {
                        installed = servers
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|server| server.get("name").unwrap().as_str().unwrap().to_string())
                            .collect();
                        replacements.push(installed.clone());
                        ("replace_acp_mcp_servers", None, replacements.len() <= 2)
                    }
                    other => panic!("unexpected command: {other:?}"),
                };
                let reply = pending.lock().unwrap().remove(&id).unwrap();
                if !lose_ack {
                    reply
                        .send(DaemonResponse {
                            id: Some(id),
                            command: command.to_string(),
                            success: true,
                            data,
                            error: None,
                            error_info: None,
                        })
                        .unwrap();
                }
                // Dropping the reply simulates an applied command whose
                // acknowledgement never reaches the ACP connection.
            }
            (replacements, installed)
        });
        let state = Arc::new(Mutex::new(state(None)));
        let binding = DaemonBinding {
            active_session_id: "daemon-1".to_string(),
            client_owned: false,
            mcp_owner_id: "owner-1".to_string(),
        };
        let options = DaemonAcpOptions {
            socket_path: PathBuf::new(),
            actual_cwd: PathBuf::from("/tmp"),
            product_version: "test".to_string(),
            create: DaemonCommand::GetConnectionState {
                id: None,
                active_session_id: "daemon-1".to_string(),
                rest: Map::default(),
            },
        };
        let (tx, mut responses) = mpsc::unbounded_channel();
        handle_session_new(
            json!(1),
            json!({ "mcpServers": [{ "name": "example", "command": "echo", "args": [], "env": [] }] }),
            &link, &state, &options, &binding, tx.clone(),
        ).await;
        assert!(responses.recv().await.unwrap().get("error").is_some());
        assert_eq!(state.lock().await.mcp_server_names, vec!["example"]);

        handle_session_new(
            json!(2),
            json!({ "mcpServers": [] }),
            &link,
            &state,
            &options,
            &binding,
            tx,
        )
        .await;
        assert!(responses.recv().await.unwrap().get("result").is_some());
        assert!(state.lock().await.mcp_server_names.is_empty());
        drop(link);
        let (replacements, installed) = worker.await.unwrap();
        assert_eq!(replacements, vec![vec!["example"], vec![], vec![]]);
        assert!(installed.is_empty());
    }

    #[tokio::test]
    async fn admit_prompt_matches_the_ts_refusal_order() {
        let none = Arc::new(Mutex::new(state(None)));
        assert_eq!(
            admit_prompt(&json!({ "sessionId": "nope" }), &none)
                .await
                .unwrap_err(),
            "Unknown ACP session: nope"
        );

        let closing = Arc::new(Mutex::new({
            let mut state = state(Some(hosted_session()));
            let (_done_tx, done_rx) = tokio::sync::watch::channel(false);
            state.session_close_done = Some(done_rx);
            state
        }));
        assert_eq!(
            admit_prompt(&json!({ "sessionId": "acp-1" }), &closing)
                .await
                .unwrap_err(),
            "ACP session is closing: acp-1"
        );

        let mut cancelling = state(Some(hosted_session()));
        cancelling.session.as_mut().unwrap().cancelling = true;
        let cancelling = Arc::new(Mutex::new(cancelling));
        assert_eq!(
            admit_prompt(&json!({ "sessionId": "acp-1" }), &cancelling)
                .await
                .unwrap_err(),
            "ACP session is cancelling: acp-1"
        );

        let mut failed = state(Some(hosted_session()));
        failed.session.as_mut().unwrap().stop_failure = Some("boom".to_string());
        failed.session.as_mut().unwrap().turn = Some(ActiveTurn {
            admission_id: "prompt-admission:1".to_string(),
            cancelled: false,
            steered_runs: Vec::new(),
        });
        let failed = Arc::new(Mutex::new(failed));
        assert_eq!(
            admit_prompt(&json!({ "sessionId": "acp-1" }), &failed)
                .await
                .unwrap_err(),
            "ACP session stop failed: boom"
        );

        let clean = Arc::new(Mutex::new(state(Some(hosted_session()))));
        let admitted = admit_prompt(&json!({ "sessionId": "acp-1" }), &clean)
            .await
            .unwrap();
        assert!(admitted.starts_with("prompt-admission:"));
        assert_eq!(
            admit_prompt(&json!({ "sessionId": "acp-1" }), &clean)
                .await
                .unwrap_err(),
            "A prompt turn is already running for this ACP session"
        );
    }

    #[test]
    fn arm_cancel_arms_a_running_turn_a_stop_retry_or_nothing() {
        let mut running = state(Some(hosted_session()));
        running.session.as_mut().unwrap().turn = Some(ActiveTurn {
            admission_id: "prompt-admission:1".to_string(),
            cancelled: false,
            steered_runs: Vec::new(),
        });
        let CancelArm::Armed(stop) = arm_cancel_locked("acp-1", &mut running) else {
            panic!("a running turn arms its stop");
        };
        assert_eq!(stop.admission_id.as_deref(), Some("prompt-admission:1"));
        let turn = running.session.as_ref().unwrap().turn.as_ref().unwrap();
        assert!(turn.cancelled);
        assert!(running.session.as_ref().unwrap().cancelling);
        assert!(running.session.as_ref().unwrap().cancel_task.is_some());

        let mut idle = state(Some(hosted_session()));
        assert!(matches!(
            arm_cancel_locked("acp-1", &mut idle),
            CancelArm::None
        ));
        assert!(idle.session.as_ref().unwrap().turn.is_none());

        let mut failed = state(Some(hosted_session()));
        failed.session.as_mut().unwrap().stop_failure = Some("boom".to_string());
        let CancelArm::Armed(stop) = arm_cancel_locked("acp-1", &mut failed) else {
            panic!("a stop failure arms the retry");
        };
        assert!(stop.admission_id.is_none());
        assert!(failed.session.as_ref().unwrap().turn.is_none());
        assert!(failed.session.as_ref().unwrap().cancelling);
        assert!(failed.session.as_ref().unwrap().cancel_task.is_some());

        // A steer admission whose round trip is still in flight arms the
        // stop without a probe: the steer may land at any moment.
        let mut in_flight = state(Some(hosted_session()));
        in_flight.session.as_mut().unwrap().steer_in_flight = 1;
        let CancelArm::Armed(stop) = arm_cancel_locked("acp-1", &mut in_flight) else {
            panic!("an in-flight steer admission arms the stop");
        };
        assert!(stop.admission_id.is_none());

        // Unresolved steered runs alone arm through the probe, never
        // blindly: the worker's own report decides.
        let mut steered = state(Some(hosted_session()));
        steered.session.as_mut().unwrap().steer_runs = vec!["steer-run:1".to_string()];
        match arm_cancel_locked("acp-1", &mut steered) {
            CancelArm::ProbeSteeredWork {
                daemon_session_id,
                run_ids,
            } => {
                assert_eq!(daemon_session_id, "daemon-1");
                assert_eq!(run_ids, vec!["steer-run:1".to_string()]);
            }
            other => panic!("unresolved steered runs arm through the probe: {other:?}"),
        }
        assert!(!steered.session.as_ref().unwrap().cancelling);
    }

    #[test]
    fn a_cancel_while_a_stop_runs_never_arms_a_second_stop() {
        let mut stopping = state(Some(hosted_session()));
        stopping.session.as_mut().unwrap().cancelling = true;
        stopping.session.as_mut().unwrap().turn = Some(ActiveTurn {
            admission_id: "prompt-admission:1".to_string(),
            cancelled: true,
            steered_runs: Vec::new(),
        });
        assert!(matches!(
            arm_cancel_locked("acp-1", &mut stopping),
            CancelArm::None
        ));
    }

    #[test]
    fn arm_cancel_arms_for_live_steered_work_without_a_turn_slot() {
        // The unit classification: unresolved steered runs probe. The
        // full arming decision (probe -> arm or no-op) is the
        // cancel-order test against the scripted link below.
        let mut steered = state(Some(hosted_session()));
        steered.session.as_mut().unwrap().steer_runs = vec!["steer-run:1".to_string()];
        assert!(matches!(
            arm_cancel_locked("acp-1", &mut steered),
            CancelArm::ProbeSteeredWork { .. }
        ));
        assert_eq!(steered.session.as_ref().unwrap().steer_in_flight, 0);
    }

    /// The failed worker prompt of the PR's e2e: a prompt that admits
    /// and then fails (invalid blocks) releases its slot without
    /// running - the steered work stays tracked so `session/cancel`
    /// still probes it (the failed admission must not orphan it).
    #[tokio::test]
    async fn a_prompt_admission_never_orphans_the_steered_work() {
        let mut steered = state(Some(hosted_session()));
        steered.session.as_mut().unwrap().steer_runs = vec!["steer-run:1".to_string()];
        let steered = Arc::new(Mutex::new(steered));
        let admitted = admit_prompt(&json!({ "sessionId": "acp-1" }), &steered)
            .await
            .expect("the prompt admits over steered work");
        assert!(admitted.starts_with("prompt-admission:"));
        let mut guard = steered.lock().await;
        guard.session.as_mut().unwrap().turn = None;
        assert!(matches!(
            arm_cancel_locked("acp-1", &mut guard),
            CancelArm::ProbeSteeredWork { .. }
        ));
    }

    /// A scripted fake link: the envelope channel the test drives.
    struct FakeLink {
        link: Arc<DaemonLink>,
        commands: mpsc::UnboundedReceiver<String>,
    }

    fn fake_link() -> FakeLink {
        let (writer, commands) = mpsc::unbounded_channel::<String>();
        let (frames_tx, frames) = mpsc::unbounded_channel();
        let link = Arc::new(DaemonLink {
            writer,
            pending: Arc::new(std::sync::Mutex::new(HashMap::new())),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            frames: Mutex::new(frames),
            protocol_version: DAEMON_PROTOCOL_VERSION,
            next_request_id: std::sync::atomic::AtomicU64::new(0),
        });
        let _ = frames_tx;
        FakeLink { link, commands }
    }

    impl FakeLink {
        /// Read the next command envelope and answer it.
        async fn expect(
            &mut self,
            respond: impl Fn(DaemonCommand) -> Option<DaemonResponse>,
        ) -> DaemonCommand {
            let line =
                tokio::time::timeout(std::time::Duration::from_secs(2), self.commands.recv())
                    .await
                    .expect("a command arrives")
                    .expect("the link stays open");
            let envelope: DaemonCommandEnvelope = serde_json::from_str(&line).unwrap();
            let id = envelope.id.clone();
            if let Some(response) = respond(envelope.command.clone()) {
                self.link
                    .pending
                    .lock()
                    .unwrap()
                    .remove(&id)
                    .expect("the round trip is pending")
                    .send(response)
                    .expect("the answer lands");
            }
            envelope.command
        }
    }

    fn daemon_response(command: &str, data: Option<Value>) -> DaemonResponse {
        DaemonResponse {
            id: None,
            command: command.to_string(),
            success: true,
            data,
            error: None,
            error_info: None,
        }
    }

    fn spawn_steer(
        link: &Arc<DaemonLink>,
        state: &Arc<Mutex<DaemonAcpState>>,
        prompt: &str,
    ) -> (tokio::task::JoinHandle<()>, mpsc::UnboundedReceiver<Value>) {
        let (tx, responses) = mpsc::unbounded_channel();
        let link = Arc::clone(link);
        let state = Arc::clone(state);
        // The queued idle behavior keeps the no-slot tests sending the
        // steer (the busy-turn tests hold a turn slot, where the behavior
        // is irrelevant).
        let request = json!({
            "sessionId": "acp-1",
            "prompt": [{ "type": "text", "text": prompt }],
            "_meta": { "steering": { "idleBehavior": "queued" } },
        });
        let handler = tokio::spawn(async move {
            handle_session_steering(json!(1), request, &link, &state, tx).await;
        });
        (handler, responses)
    }

    /// A steer whose worker round trip is still in flight is already
    /// tracked: a `session/cancel` landing in that window arms the stop
    /// sequence (the registration happens at the admission point, before
    /// the send), and the steer itself answers the cancelling refusal
    /// once its response arrives. The withdrawal is NOT the handler's: a
    /// bare `AbortAndClearQueue` here could land after the stop completed
    /// and abort the host's NEXT prompt - the stop sequence's own tail
    /// (wait for the admission, then one final abort under its own input
    /// pause) owns the landed item (#3684 review).
    #[tokio::test]
    async fn a_cancel_during_the_steer_round_trip_arms_and_refuses_the_steer() {
        let mut fake = fake_link();
        let state = Arc::new(Mutex::new(state(Some(hosted_session()))));
        let (handler, mut responses) = spawn_steer(&fake.link, &state, "steer note");
        // The Steer command reached the fake daemon and stays unanswered:
        // the round trip is provably in flight.
        let steer = fake.expect(|_| None).await;
        assert!(matches!(steer, DaemonCommand::Steer { .. }));
        // A cancel in this window must arm for the steered work.
        let order = frame_order_prefix(
            &Incoming::Notification {
                method: "session/cancel".to_string(),
                params: json!({ "sessionId": "acp-1" }),
            },
            &fake.link,
            &state,
        )
        .await;
        assert!(
            matches!(order, FrameOrder::Cancel(CancelOrder::Armed(_))),
            "the in-flight steer admission armed the stop"
        );
        // The steer's own response arrives after the cancel armed: the
        // handler refuses and settles - no withdrawal abort of its own.
        let pending_ids: Vec<String> = fake.link.pending.lock().unwrap().keys().cloned().collect();
        for id in pending_ids {
            let tx = fake.link.pending.lock().unwrap().remove(&id).unwrap();
            tx.send(DaemonResponse {
                id: Some(id),
                command: "steer".to_string(),
                success: true,
                data: Some(json!({ "queued": true, "busy": false })),
                error: None,
                error_info: None,
            })
            .expect("the steer answer lands");
        }
        let reply = tokio::time::timeout(std::time::Duration::from_secs(2), responses.recv())
            .await
            .expect("the steering reply")
            .expect("the reply channel stays open");
        assert_eq!(reply["id"], json!(1), "{reply}");
        assert!(
            reply["error"]["data"]["details"]
                .as_str()
                .unwrap_or_default()
                .contains("ACP session is cancelling"),
            "the raced steer answers the cancelling refusal: {reply}"
        );
        // The handler sent exactly one command: the Steer itself. No
        // bare AbortAndClearQueue raced the stop.
        assert!(
            fake.commands.try_recv().is_err(),
            "the handler sent no withdrawal abort"
        );
        assert_eq!(
            state.lock().await.session.as_ref().unwrap().steer_in_flight,
            0,
            "the raced steer settled its in-flight admission"
        );
        handler.await.expect("the handler settles");
    }

    /// A busy-turn steer answers `injected` only when the worker reports
    /// the ACP prompt's own turn running (the read-only admission probe).
    /// A steer admitted while the slot is held, whose prompt turn has
    /// already settled by the probe (or whose probe fails), answers
    /// `queued` - the ACP-side slot alone no longer decides.
    #[tokio::test]
    async fn a_busy_turn_steer_answers_injected_only_on_the_worker_report() {
        for running in [true, false] {
            let mut fake = fake_link();
            let mut with_turn = state(Some(hosted_session()));
            with_turn.session.as_mut().unwrap().turn = Some(ActiveTurn {
                admission_id: "prompt-admission:1".to_string(),
                cancelled: false,
                steered_runs: Vec::new(),
            });
            let state = Arc::new(Mutex::new(with_turn));
            let (handler, mut responses) = spawn_steer(&fake.link, &state, "steer note");
            let steer = fake.expect(|_| None).await;
            let DaemonCommand::Steer { rest, .. } = steer else {
                panic!("the steer command");
            };
            assert!(
                rest.contains_key("runId"),
                "the steer carries its run id: {rest:?}"
            );
            let run_id = rest
                .get("runId")
                .and_then(Value::as_str)
                .unwrap()
                .to_string();
            answer_pending(
                &fake.link,
                "steer",
                Some(&json!({ "queued": true, "busy": true })),
            );
            let probe = fake.expect(|_| None).await;
            assert!(
                matches!(
                    probe,
                    DaemonCommand::CancelPromptAdmission {
                        probe: Some(true),
                        ..
                    }
                ),
                "the receipt probes the prompt admission read-only: {probe:?}"
            );
            answer_pending(
                &fake.link,
                "cancel_prompt_admission",
                Some(&json!({ "status": "owned", "running": running })),
            );
            let reply = tokio::time::timeout(std::time::Duration::from_secs(2), responses.recv())
                .await
                .expect("the steering reply")
                .expect("the reply channel stays open");
            assert_eq!(reply["id"], json!(1), "{reply}");
            assert_eq!(
                reply["result"],
                json!({ "outcome": if running { "injected" } else { "queued" } }),
                "the receipt follows the worker's own report: {reply}"
            );
            let guard = state.lock().await;
            let hosted = guard.session.as_ref().unwrap();
            assert_eq!(hosted.steer_in_flight, 0, "the admission settled");
            assert!(
                hosted.turn.as_ref().unwrap().steered_runs.contains(&run_id),
                "the run is owned by the prompt's settlement"
            );
            handler.await.expect("the handler settles");
        }
    }

    fn answer_pending(link: &Arc<DaemonLink>, command: &str, data: Option<&Value>) {
        let pending_ids: Vec<String> = link.pending.lock().unwrap().keys().cloned().collect();
        for id in pending_ids {
            let tx = link.pending.lock().unwrap().remove(&id).unwrap();
            tx.send(DaemonResponse {
                id: Some(id),
                command: command.to_string(),
                success: true,
                data: data.cloned(),
                error: None,
                error_info: None,
            })
            .expect("the answer lands");
        }
    }

    #[test]
    fn steer_outcome_follows_the_worker_report() {
        assert_eq!(steer_outcome(true), "injected");
        // The ACP-side slot alone never decides: the prompt may still park
        // on the follow-up lane behind non-ACP work, or its turn may have
        // settled before the steer landed.
        assert_eq!(steer_outcome(false), "queued");
    }

    /// The settlement race a steer can win against the drain: a steer
    /// admitted after `wait_for_steer_admissions` returned but before
    /// the snapshot is already in `steered_runs` while its Steer round
    /// trip is still in flight - its run id is unknown at the worker
    /// until the round trip lands, and waiting it there answers no
    /// settle status, failing a prompt whose own turn already succeeded
    /// (#3684 review, the r4342773489 follow-up). The pass must drain
    /// the admission and resnapshot; runs wait only once nothing is in
    /// flight.
    #[test]
    fn the_settlement_waits_no_run_while_an_admission_is_in_flight() {
        assert!(
            matches!(
                steer_settlement_pass(vec!["steer-run:1".to_string()], 1),
                SteerSettlementPass::Drain
            ),
            "a run whose admission is still in flight must drain first"
        );
        assert!(
            matches!(
                steer_settlement_pass(vec!["steer-run:1".to_string()], 0),
                SteerSettlementPass::Wait(runs) if runs == vec!["steer-run:1".to_string()]
            ),
            "the same snapshot waits its runs once nothing is in flight"
        );
        assert!(matches!(
            steer_settlement_pass(Vec::new(), 0),
            SteerSettlementPass::Done
        ));
        assert!(
            matches!(
                steer_settlement_pass(Vec::new(), 1),
                SteerSettlementPass::Drain
            ),
            "an in-flight admission without new runs still drains before done"
        );
    }

    /// A steered run's failure and its wait's error are failed-prompt
    /// arms too: the prompt reply carries the #200 `kind`/`category`/
    /// `retryable` contract (`turn_failure_error`), never a bare
    /// `internal_error` `details` a host cannot classify (#3684 review).
    #[tokio::test]
    async fn steered_run_failure_arms_carry_the_failed_prompt_contract() {
        for failed_run in [true, false] {
            let mut fake = fake_link();
            let mut with_turn = state(Some(hosted_session()));
            with_turn.session.as_mut().unwrap().turn = Some(ActiveTurn {
                admission_id: "prompt-admission:1".to_string(),
                cancelled: false,
                steered_runs: vec!["steer-run:1".to_string()],
            });
            let state = Arc::new(Mutex::new(with_turn));
            let link = Arc::clone(&fake.link);
            let prompt_state = Arc::clone(&state);
            let handler = tokio::spawn(async move {
                prompt_turn(
                    json!(1),
                    json!({
                        "sessionId": "acp-1",
                        "prompt": [{ "type": "text", "text": "hi" }],
                    }),
                    "prompt-admission:1",
                    &link,
                    &prompt_state,
                )
                .await
            });
            // The turn itself succeeds; the steered run settles after it.
            let prompt = fake
                .expect(|_| Some(daemon_response("prompt_and_wait", None)))
                .await;
            assert!(
                matches!(prompt, DaemonCommand::PromptAndWait { .. }),
                "the turn ran: {prompt:?}"
            );
            let settle = fake
                .expect(|_| {
                    Some(if failed_run {
                        daemon_response(
                            "wait_for_steer_run",
                            Some(json!({
                                "status": "failed",
                                "error": "API Error: 429 rate limit exceeded",
                            })),
                        )
                    } else {
                        DaemonResponse {
                            id: None,
                            command: "wait_for_steer_run".to_string(),
                            success: false,
                            data: None,
                            error: Some("the daemon connection closed mid-request".to_string()),
                            error_info: None,
                        }
                    })
                })
                .await;
            assert!(
                matches!(
                    settle,
                    DaemonCommand::WaitForSteerRun { ref run_id, .. }
                        if run_id == "steer-run:1"
                ),
                "the settlement waits its run: {settle:?}"
            );
            let reply = tokio::time::timeout(std::time::Duration::from_secs(2), handler)
                .await
                .expect("the prompt settles")
                .expect("the handler settles");
            let (details, kind, category, retryable) = if failed_run {
                (
                    "prime-agent steered run failed",
                    "rate_limit",
                    "rate_limit",
                    false,
                )
            } else {
                (
                    "prime-agent steered run wait failed",
                    "other",
                    "other",
                    false,
                )
            };
            let data = &reply["error"]["data"];
            assert_eq!(reply["id"], json!(1), "{failed_run}: {reply}");
            assert!(
                data["details"]
                    .as_str()
                    .unwrap_or_default()
                    .contains(details),
                "{failed_run}: {reply}"
            );
            assert_eq!(data["kind"], json!(kind), "{failed_run}: {reply}");
            assert_eq!(data["category"], json!(category), "{failed_run}: {reply}");
            assert_eq!(data["retryable"], json!(retryable), "{failed_run}: {reply}");
        }
    }

    /// A steer the worker refused never landed, so its admission settles
    /// the in-flight registration: a later idle `session/cancel` no-ops
    /// again instead of arming a full stop for work that does not exist.
    /// A refused steer over earlier live steered work keeps that work
    /// unresolved (the count unwinds only the refused admission's own
    /// unit).
    #[tokio::test]
    async fn a_refused_steer_settles_its_own_in_flight_registration() {
        async fn refused_steer_reply(start_in_flight: usize) -> DaemonAcpState {
            let mut fake = fake_link();
            let mut daemon_state = state(Some(hosted_session()));
            daemon_state.session.as_mut().unwrap().steer_in_flight = start_in_flight;
            let state = Arc::new(Mutex::new(daemon_state));
            let (handler, mut responses) = spawn_steer(&fake.link, &state, "steer note");
            let steer = fake.expect(|_| None).await;
            assert!(matches!(steer, DaemonCommand::Steer { .. }));
            assert_eq!(
                state.lock().await.session.as_ref().unwrap().steer_in_flight,
                start_in_flight + 1,
                "the admission registers the steer before the round trip"
            );
            let pending_ids: Vec<String> =
                fake.link.pending.lock().unwrap().keys().cloned().collect();
            for id in pending_ids {
                let tx = fake.link.pending.lock().unwrap().remove(&id).unwrap();
                tx.send(DaemonResponse {
                    id: Some(id),
                    command: "steer".to_string(),
                    success: false,
                    data: None,
                    error: Some("steer refused".to_string()),
                    error_info: None,
                })
                .expect("the refusal lands");
            }
            let reply = tokio::time::timeout(std::time::Duration::from_secs(2), responses.recv())
                .await
                .expect("the steering reply")
                .expect("the reply channel stays open");
            assert!(
                reply["error"]["data"]["details"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("steer refused"),
                "the refused steer answers the worker refusal: {reply}"
            );
            handler.await.expect("the handler settles");
            Arc::try_unwrap(state).map_err(|_| ()).unwrap().into_inner()
        }

        let settled = refused_steer_reply(0).await;
        let settled_hosted = settled.session.as_ref().unwrap();
        assert_eq!(
            settled_hosted.steer_in_flight, 0,
            "the refused steer settled its registration: a later idle cancel no-ops again"
        );
        assert!(
            settled_hosted.steer_runs.is_empty(),
            "the refused steer leaves no ghost run to wait or probe"
        );

        let kept = refused_steer_reply(2).await;
        let kept_hosted = kept.session.as_ref().unwrap();
        assert_eq!(
            kept_hosted.steer_in_flight, 2,
            "the refusal settled only its own unit, never another in-flight admission"
        );
        assert!(
            kept_hosted.steer_runs.is_empty(),
            "the refused steer leaves no ghost run over live steered work"
        );
    }

    /// An admission whose round trip spans a completed stop reset
    /// settles nothing: the reset retired its unit, and a late settle
    /// must not eat a newer admission's registration (the count now
    /// belongs to the admissions after the reset).
    #[tokio::test]
    async fn a_late_refusal_after_a_stop_reset_orphans_nothing() {
        let mut fake = fake_link();
        let state = Arc::new(Mutex::new(state(Some(hosted_session()))));
        let (handler, mut responses) = spawn_steer(&fake.link, &state, "steer note");
        let steer = fake.expect(|_| None).await;
        assert!(matches!(steer, DaemonCommand::Steer { .. }));
        // The stop completes while the round trip is in flight: the
        // in-flight set resets and the epoch retires the admission, then
        // a newer steer is admitted under the new epoch.
        {
            let mut guard = state.lock().await;
            let hosted = guard.session.as_mut().unwrap();
            hosted.steer_in_flight = 0;
            hosted.steer_generation += 1;
            hosted.steer_in_flight += 1;
        }
        // The stale admission's late refusal arrives now.
        let pending_ids: Vec<String> = fake.link.pending.lock().unwrap().keys().cloned().collect();
        for id in pending_ids {
            let tx = fake.link.pending.lock().unwrap().remove(&id).unwrap();
            tx.send(DaemonResponse {
                id: Some(id),
                command: "steer".to_string(),
                success: false,
                data: None,
                error: Some("steer refused late".to_string()),
                error_info: None,
            })
            .expect("the late refusal lands");
        }
        let reply = tokio::time::timeout(std::time::Duration::from_secs(2), responses.recv())
            .await
            .expect("the steering reply")
            .expect("the reply channel stays open");
        assert!(
            reply["error"]["data"]["details"]
                .as_str()
                .unwrap_or_default()
                .contains("steer refused late"),
            "the refused steer answers the worker refusal: {reply}"
        );
        let mut guard = state.lock().await;
        assert_eq!(
            guard.session.as_ref().unwrap().steer_in_flight,
            1,
            "the late refusal unwound nothing: the newer admission keeps its registration"
        );
        assert!(
            matches!(arm_cancel_locked("acp-1", &mut guard), CancelArm::Armed(_)),
            "the cancel still arms for the newer admission's steered work"
        );
        handler.await.expect("the handler settles");
    }

    /// A link failure answers with the ambiguity marked: the envelope
    /// was written, so the steer MAY have landed and a host must not
    /// retry blindly.
    #[tokio::test]
    async fn a_link_error_marks_the_steer_as_possibly_landed() {
        let mut fake = fake_link();
        fake.commands.close();
        let state = Arc::new(Mutex::new(state(Some(hosted_session()))));
        let (handler, mut responses) = spawn_steer(&fake.link, &state, "steer note");
        let reply = tokio::time::timeout(std::time::Duration::from_secs(2), responses.recv())
            .await
            .expect("the steering reply")
            .expect("the reply channel stays open");
        assert_eq!(reply["error"]["code"], json!(-32603), "{reply}");
        assert_eq!(
            reply["error"]["data"]["steerMayHaveLanded"],
            json!(true),
            "the link failure marks the ambiguity: {reply}"
        );
        assert!(
            reply["error"]["data"]["details"]
                .as_str()
                .unwrap_or_default()
                .contains("steering failed"),
            "the error names the failed round trip: {reply}"
        );
        assert_eq!(
            state.lock().await.session.as_ref().unwrap().steer_in_flight,
            0,
            "the link error settles the admission (the run stays tracked for the probe)"
        );
        handler.await.expect("the handler settles");
    }

    /// The request's own validation: the optional `messageId` (accepted
    /// and ignored) must be a non-empty string, and the `idleBehavior`
    /// opt-in must name a known behavior.
    #[test]
    fn validate_steering_request_admits_and_rejects_the_known_shapes() {
        let params = |request: Value| types::SteeringParams::parse(&request);
        let id = json!(1);
        for request in [
            json!({ "sessionId": "acp-1", "prompt": [] }),
            json!({ "sessionId": "acp-1", "prompt": [], "messageId": "m-1" }),
            json!({
                "sessionId": "acp-1", "prompt": [],
                "_meta": { "steering": { "idleBehavior": "promptRequired" } }
            }),
            json!({
                "sessionId": "acp-1", "prompt": [],
                "_meta": { "steering": { "idleBehavior": "queued" } }
            }),
        ] {
            let request = params(request);
            assert!(
                validate_steering_request(&id, &request).is_ok(),
                "valid request rejected: {request:?}"
            );
        }
        for request in [
            json!({ "sessionId": "acp-1", "prompt": [], "messageId": "" }),
            json!({ "sessionId": "acp-1", "prompt": [], "messageId": 7 }),
            json!({
                "sessionId": "acp-1", "prompt": [],
                "_meta": { "steering": { "idleBehavior": "queue" } }
            }),
        ] {
            let request = params(request);
            let error = validate_steering_request(&id, &request)
                .expect_err("the malformed request is rejected");
            assert_eq!(
                error["error"]["code"],
                json!(-32602),
                "{request:?}: {error}"
            );
            assert!(
                error["error"]["data"]["reason"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("steering"),
                "the rejection names the rule: {error}"
            );
        }
    }

    /// Idle steering never starts a turn (nano-rlm #205): with no
    /// running prompt turn the default receipt is
    /// `{outcome: promptRequired, reason: noRunningTurn}` and NOTHING
    /// reaches the worker. `_meta.steering.idleBehavior: "queued"` opts
    /// back into the port's wake behavior.
    #[tokio::test]
    async fn an_idle_steer_answers_prompt_required_and_sends_nothing() {
        let mut fake = fake_link();
        let state = Arc::new(Mutex::new(state(Some(hosted_session()))));
        let (tx, mut responses) = mpsc::unbounded_channel();
        let link = Arc::clone(&fake.link);
        let handler_state = Arc::clone(&state);
        let handler = tokio::spawn(async move {
            handle_session_steering(
                json!(1),
                json!({
                    "sessionId": "acp-1",
                    "prompt": [{ "type": "text", "text": "run when ready" }],
                    "messageId": "m-1",
                }),
                &link,
                &handler_state,
                tx,
            )
            .await;
        });
        let reply = tokio::time::timeout(std::time::Duration::from_secs(2), responses.recv())
            .await
            .expect("the steering reply")
            .expect("the reply channel stays open");
        assert_eq!(
            reply["result"],
            json!({ "outcome": "promptRequired", "reason": "noRunningTurn" }),
            "the idle steer answers the nano-rlm receipt: {reply}"
        );
        assert!(
            fake.commands.try_recv().is_err(),
            "the refused idle steer reaches no worker"
        );
        assert_eq!(
            state.lock().await.session.as_ref().unwrap().steer_in_flight,
            0
        );
        handler.await.expect("the handler settles");
    }

    #[tokio::test]
    async fn an_idle_steer_with_queued_behavior_runs_as_the_next_turn() {
        let mut fake = fake_link();
        let state = Arc::new(Mutex::new(state(Some(hosted_session()))));
        let (tx, mut responses) = mpsc::unbounded_channel();
        let link = Arc::clone(&fake.link);
        let handler_state = Arc::clone(&state);
        let handler = tokio::spawn(async move {
            handle_session_steering(
                json!(1),
                json!({
                    "sessionId": "acp-1",
                    "prompt": [{ "type": "text", "text": "run when ready" }],
                    "_meta": { "steering": { "idleBehavior": "queued" } },
                }),
                &link,
                &handler_state,
                tx,
            )
            .await;
        });
        let steer = fake.expect(|_| None).await;
        assert!(matches!(steer, DaemonCommand::Steer { .. }));
        answer_pending(
            &fake.link,
            "steer",
            Some(&json!({ "queued": true, "busy": false })),
        );
        let reply = tokio::time::timeout(std::time::Duration::from_secs(2), responses.recv())
            .await
            .expect("the steering reply")
            .expect("the reply channel stays open");
        assert_eq!(
            reply["result"],
            json!({ "outcome": "queued" }),
            "the idle-queued steer answers the queued receipt: {reply}"
        );
        let guard = state.lock().await;
        let hosted = guard.session.as_ref().unwrap();
        assert_eq!(hosted.steer_in_flight, 0, "the admission settled");
        assert_eq!(
            hosted.steer_runs.len(),
            1,
            "the run stays for the liveness probe"
        );
        handler.await.expect("the handler settles");
    }

    /// An idle `session/cancel` probes the unresolved steered runs: a
    /// live one arms the stop, and settled ones resolve out of the list
    /// so the cancel no-ops (the worker's own report, not a stale count).
    #[tokio::test]
    async fn an_idle_cancel_probes_the_steered_runs_for_live_work() {
        async fn scenario(settle_status: &str, expect_armed: bool) {
            let mut fake = fake_link();
            let mut with_runs = state(Some(hosted_session()));
            with_runs.session.as_mut().unwrap().steer_runs = vec!["steer-run:1".to_string()];
            let state = Arc::new(Mutex::new(with_runs));
            let order = tokio::spawn({
                let link = Arc::clone(&fake.link);
                let state = Arc::clone(&state);
                async move { cancel_order(&json!({ "sessionId": "acp-1" }), &link, &state).await }
            });
            let probe = fake
                .expect(|command| {
                    if matches!(command, DaemonCommand::WaitForSteerRun { .. }) {
                        Some(daemon_response(
                            "wait_for_steer_run",
                            Some(json!({ "status": settle_status })),
                        ))
                    } else {
                        None
                    }
                })
                .await;
            assert!(
                matches!(
                    probe,
                    DaemonCommand::WaitForSteerRun {
                        probe: Some(true),
                        ..
                    }
                ),
                "the liveness check is a probe: {probe:?}"
            );
            let order = tokio::time::timeout(std::time::Duration::from_secs(2), order)
                .await
                .expect("the cancel order settles")
                .unwrap();
            assert_eq!(
                matches!(order, CancelOrder::Armed(_)),
                expect_armed,
                "the worker's own report decides the arming"
            );
            let unresolved = !state
                .lock()
                .await
                .session
                .as_ref()
                .unwrap()
                .steer_runs
                .is_empty();
            assert_eq!(
                unresolved, expect_armed,
                "a live run stays tracked for later probes; a settled one resolves out"
            );
        }

        // A live steered run arms the stop; a settled one no-ops like the
        // pre-steering idle cancel.
        scenario("running", true).await;
        scenario("completed", false).await;
    }

    #[tokio::test]
    async fn a_completed_stop_retires_the_steer_bookkeeping() {
        let mut fake = fake_link();
        let mut initial = state(Some(hosted_session()));
        initial.session.as_mut().unwrap().steer_in_flight = 1;
        initial.session.as_mut().unwrap().steer_generation = 7;
        let state = Arc::new(Mutex::new(initial));
        let daemon_session_id = state
            .lock()
            .await
            .session
            .as_ref()
            .unwrap()
            .daemon_active_session_id
            .clone();
        let stop = CancelStop {
            acp_session_id: "acp-1".to_string(),
            daemon_session_id,
            admission_id: None,
            done: tokio::sync::watch::channel(false).0,
        };
        let stop_run = tokio::spawn({
            let link = Arc::clone(&fake.link);
            let state = Arc::clone(&state);
            async move { run_cancel_stop(stop, &link, &state).await }
        });
        let mut aborts = 0;
        loop {
            let command = fake
                .expect(|command| match &command {
                    DaemonCommand::AcquireSessionInputPause { .. } => Some(daemon_response(
                        "acquire_session_input_pause",
                        Some(json!({ "pauseId": "pause-1" })),
                    )),
                    DaemonCommand::WaitForIdle { .. } => {
                        Some(daemon_response("wait_for_idle", None))
                    }
                    DaemonCommand::GetRlmChildren { .. } => Some(daemon_response(
                        "get_rlm_children",
                        Some(json!({ "children": [] })),
                    )),
                    DaemonCommand::ReleaseSessionInputPause { .. } => {
                        Some(daemon_response("release_session_input_pause", None))
                    }
                    DaemonCommand::AbortAndClearQueue { .. } => {
                        Some(daemon_response("abort_and_clear_queue", None))
                    }
                    other => panic!("unexpected command: {other:?}"),
                })
                .await;
            match command {
                DaemonCommand::AcquireSessionInputPause { .. } => {}
                DaemonCommand::AbortAndClearQueue { .. } => {
                    aborts += 1;
                }
                DaemonCommand::WaitForIdle { .. } => {
                    if aborts == 1 {
                        // The first idle passed: the tail now parks on the
                        // in-flight admission. Settle it (the steering
                        // handler's own settle), so the tail proceeds to
                        // its final abort.
                        let guard = state.lock().await;
                        let epoch = guard.session.as_ref().unwrap().steer_generation;
                        drop(guard);
                        settle_steer_admission(&state, "acp-1", epoch).await;
                    }
                }
                DaemonCommand::GetRlmChildren { .. } => break,
                other => panic!("unexpected command: {other:?}"),
            }
        }
        // The stop releases its input pause after the roster read.
        let release = fake
            .expect(|_| Some(daemon_response("release_session_input_pause", None)))
            .await;
        assert!(matches!(
            release,
            DaemonCommand::ReleaseSessionInputPause { .. }
        ));
        tokio::time::timeout(std::time::Duration::from_secs(2), stop_run)
            .await
            .expect("the stop settles")
            .unwrap();
        assert_eq!(aborts, 2, "the tail runs one final idempotent abort");
        let guard = state.lock().await;
        let hosted = guard.session.as_ref().unwrap();
        assert_eq!(
            hosted.steer_in_flight, 0,
            "the completed stop reset the in-flight set"
        );
        assert_eq!(
            hosted.steer_generation, 8,
            "the completed stop bumped the epoch"
        );
        assert!(hosted.stop_failure.is_none());
    }

    /// The failed stop keeps the steered-work bookkeeping for its retry:
    /// no reset, no epoch bump - the stop-failure retry's own tail must
    /// still see the unresolved admissions.
    #[tokio::test]
    async fn a_failed_stop_keeps_the_steer_bookkeeping_for_its_retry() {
        let mut fake = fake_link();
        let mut initial = state(Some(hosted_session()));
        initial.session.as_mut().unwrap().steer_in_flight = 1;
        initial.session.as_mut().unwrap().steer_generation = 3;
        let state = Arc::new(Mutex::new(initial));
        let daemon_session_id = state
            .lock()
            .await
            .session
            .as_ref()
            .unwrap()
            .daemon_active_session_id
            .clone();
        let stop = CancelStop {
            acp_session_id: "acp-1".to_string(),
            daemon_session_id,
            admission_id: None,
            done: tokio::sync::watch::channel(false).0,
        };
        let stop_run = tokio::spawn({
            let link = Arc::clone(&fake.link);
            let state = Arc::clone(&state);
            async move { run_cancel_stop(stop, &link, &state).await }
        });
        let pause = fake
            .expect(|_| {
                Some(daemon_response(
                    "acquire_session_input_pause",
                    Some(json!({ "pauseId": "pause-1" })),
                ))
            })
            .await;
        assert!(matches!(
            pause,
            DaemonCommand::AcquireSessionInputPause { .. }
        ));
        let abort = fake
            .expect(|_| {
                Some(DaemonResponse {
                    id: None,
                    command: "abort_and_clear_queue".to_string(),
                    success: false,
                    data: None,
                    error: Some("the worker refused".to_string()),
                    error_info: None,
                })
            })
            .await;
        assert!(matches!(abort, DaemonCommand::AbortAndClearQueue { .. }));
        tokio::time::timeout(std::time::Duration::from_secs(2), stop_run)
            .await
            .expect("the stop settles")
            .unwrap();
        let guard = state.lock().await;
        let hosted = guard.session.as_ref().unwrap();
        assert_eq!(
            hosted.steer_in_flight, 1,
            "the failed stop kept the in-flight set"
        );
        assert_eq!(
            hosted.steer_generation, 3,
            "the failed stop bumped no epoch"
        );
        assert_eq!(
            hosted.stop_failure.as_deref(),
            Some("the worker refused"),
            "the failure is recorded for the retry"
        );
    }
}
