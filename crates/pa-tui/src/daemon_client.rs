//! JSONL daemon client for the interactive UI.
//!
//! Connects to the supervisor's client socket, performs the `daemon_hello`
//! handshake, sends `type: "command"` envelopes, and matches responses by
//! envelope id. Frames that are not responses (session events, list progress,
//! closing notices) are forwarded to the caller through an event channel, so
//! the UI loop can render live session state while requests are in flight.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use pa_types::daemon::{
    is_session_plane_daemon_command, DaemonCommand, DaemonCommandEnvelope, DaemonCommandFrameType,
    DaemonProtocolInfo, DaemonResponse, DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION,
};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::direct_transport::{
    connect_direct, direct_attach_capabilities, read_session_transport_ticket,
    supervisor_supports_direct, DirectLink, TICKET_TIMEOUT_MS,
};

/// Default response timeout (TS `DEFAULT_DAEMON_REQUEST_TIMEOUT_MS`).
pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 30_000;
/// Requests whose completion is bounded by the turn itself
/// (`prompt_and_wait`, `wait_for_idle`) use the supervisor's long route
/// timeout so a long turn cannot expire the request.
pub const LONG_RUNNING_REQUEST_TIMEOUT_MS: u64 = 600_000;
const CONNECT_TIMEOUT_MS: u64 = 3_000;
/// Hello handshake budget. A daemon loading a very large session can take
/// well over the 3s TS default to greet.
const HELLO_TIMEOUT_MS: u64 = 15_000;
/// Connect attempts before a connect/handshake failure surfaces (the
/// fatal error paths the operator hit: "Timed out after 15000ms waiting
/// for the Prime Agent daemon handshake" exited their TUI on the FIRST
/// miss at box load). A loaded or restarting daemon usually greets within
/// the retry window; the caller's error path only runs after the last
/// attempt.
pub(crate) const CONNECT_ATTEMPTS: u32 = 3;
/// The first retry's backoff; each further attempt doubles it.
const CONNECT_RETRY_BACKOFF_MS: u64 = 1_000;

/// A non-response frame forwarded to the UI event loop. Payloads that are
/// owned by the session engine stay raw JSON (`Value`) so the client keeps
/// working across schema revisions.
/// The update resume contract of a `daemon_closing` frame (spec §10.1).
#[derive(Debug, Clone)]
pub struct DaemonClosingUpdate {
    pub update_id: String,
    pub est_seconds: u64,
    /// The stopped sessions `[{sessionId, name}]`: what the client can
    /// reattach to by durable id after the restart.
    pub sessions: Vec<Value>,
}

#[derive(Debug, Clone)]
pub enum DaemonClientEvent {
    /// `session_event`: one streamed agent/turn event for an attached session.
    SessionEvent {
        active_session_id: String,
        event: Value,
    },
    /// `session_closed`: the attached session stopped existing.
    SessionClosed {
        active_session_id: String,
        reason: String,
    },
    /// The direct worker link for `active_session_id` died (the worker
    /// process exited). TS `handleTransportClose` with a direct-transport
    /// loss: "a direct-transport loss is never itself a session loss" —
    /// the UI re-attaches through the supervisor, which respawns the
    /// worker and hands out a fresh peer ticket.
    DirectLinkLost { active_session_id: String },
    /// `session_list_item` progress frame of `list_saved_sessions`: one
    /// saved row as the scan streams it (newest first), tagged with the
    /// request id it belongs to (TS's connection routes the stream to
    /// the originating `listDaemonSavedSessions` callbacks; the agents
    /// view applies only the frames of its own in-flight fetch).
    SessionListItem { session: Value, request_id: String },
    /// `session_list_progress` progress frame of `list_saved_sessions`.
    SessionListProgress { loaded: u64, total: u64 },
    /// `daemon_closing`: the supervisor is going down. An update restart
    /// carries the resume contract (spec §10.1): the client keeps its UI
    /// mounted and reconnects instead of exiting.
    DaemonClosing {
        reason: String,
        update: Option<DaemonClosingUpdate>,
    },
    /// `side_question_event`: one streamed side-question run (the `/btw`
    /// pane tracks the run by its id).
    SideQuestionEvent {
        active_session_id: String,
        event: Value,
    },
    /// `roster_update`: live roster deltas for subscribers (the agents
    /// view): changed entries upsert by agent id, `removed` deletes, and
    /// `resync` replaces the whole roster.
    RosterUpdate {
        changed: Vec<Value>,
        removed: Vec<String>,
        resync: bool,
    },
    /// `heartbeats_changed`: the daemon-global broadcast every client sees
    /// when the heartbeat catalog changes (TS `broadcastGlobal`). The
    /// session view refreshes its open `/heartbeats` picker on it.
    HeartbeatsChanged,
    /// `session_binding`: the supervisor rebound a session to a new active
    /// id (a worker replacement) and the id this client holds is
    /// superseded. The session view re-attaches to the current id so its
    /// event routing follows the session.
    SessionBinding {
        previous_active_session_id: String,
        active_session_id: String,
    },
}

/// One non-response frame, parsed from a supervisor JSONL line or a direct
/// worker frame payload (both carry the same `DaemonOutbound` shapes).
pub(crate) fn client_event_from_value(value: &Value) -> Option<DaemonClientEvent> {
    let frame_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match frame_type {
        "session_event" => Some(DaemonClientEvent::SessionEvent {
            active_session_id: value
                .get("activeSessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            event: value.get("event").cloned().unwrap_or(Value::Null),
        }),
        "session_closed" => Some(DaemonClientEvent::SessionClosed {
            active_session_id: value
                .get("activeSessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            reason: value
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }),
        "side_question_event" => Some(DaemonClientEvent::SideQuestionEvent {
            active_session_id: value
                .get("activeSessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            event: value.get("event").cloned().unwrap_or(Value::Null),
        }),
        "session_list_item" => Some(DaemonClientEvent::SessionListItem {
            session: value.get("session").cloned().unwrap_or(Value::Null),
            request_id: value
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }),
        "session_list_progress" => Some(DaemonClientEvent::SessionListProgress {
            loaded: value.get("loaded").and_then(Value::as_u64).unwrap_or(0),
            total: value.get("total").and_then(Value::as_u64).unwrap_or(0),
        }),
        "daemon_closing" => Some(DaemonClientEvent::DaemonClosing {
            reason: value
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            update: value.get("payload").cloned().and_then(|payload| {
                (payload.get("resume").and_then(Value::as_bool) == Some(true)).then(|| {
                    DaemonClosingUpdate {
                        update_id: payload
                            .get("updateId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        est_seconds: payload
                            .get("estSeconds")
                            .and_then(Value::as_u64)
                            .unwrap_or_default(),
                        sessions: payload
                            .get("sessions")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default(),
                    }
                })
            }),
        }),
        "roster_update" => Some(DaemonClientEvent::RosterUpdate {
            changed: value
                .get("changed")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            removed: value
                .get("removed")
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            resync: value.get("resync") == Some(&Value::Bool(true)),
        }),
        "heartbeats_changed" => Some(DaemonClientEvent::HeartbeatsChanged),
        "session_binding" => Some(DaemonClientEvent::SessionBinding {
            previous_active_session_id: value
                .get("previousActiveSessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            active_session_id: value
                .get("activeSessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }),
        _ => None,
    }
}

/// Connection state shared between the request side and the reader task.
#[derive(Default)]
pub(crate) struct Shared {
    /// Pending requests keyed by envelope id. `Ok` is a daemon answer
    /// (including a `success: false` refusal); `Err` is a transport
    /// failure — the two must stay distinguishable, because a refusal is
    /// recoverable UI data while a dead connection is fatal.
    pending: Mutex<HashMap<String, oneshot::Sender<Result<DaemonResponse, anyhow::Error>>>>,
}

impl Shared {
    pub(crate) fn resolve(&self, id: &str, response: DaemonResponse) -> bool {
        let mut pending = self.pending.lock().unwrap();
        pending
            .remove(id)
            .is_some_and(|tx| tx.send(Ok(response)).is_ok())
    }

    /// Fail every pending request whose id starts with `prefix` with a
    /// transport error: the connection that carried them died.
    ///
    /// This is what keeps a dead supervisor or worker from leaving the UI
    /// waiting out the full request timeout — the exit-hang class of bugs:
    /// the abort was accepted, but the client then hung on a request whose
    /// socket peer was already gone. The reader task of each connection
    /// calls this when its socket closes (supervisor reader fails the
    /// `daemon_`-routed requests, a direct worker pump the `direct_` ones,
    /// so a live link keeps serving its own in-flight requests). The
    /// failure resolves on the `Err` half of the channel — never as a
    /// synthetic response — so a dead connection can never be mistaken
    /// for a daemon refusal.
    pub(crate) fn fail_pending(&self, prefix: &str, error: &str) {
        let mut pending = self.pending.lock().unwrap();
        let dead: Vec<String> = pending
            .keys()
            .filter(|id| id.starts_with(prefix))
            .cloned()
            .collect();
        for id in dead {
            if let Some(tx) = pending.remove(&id) {
                let _ = tx.send(Err(anyhow!(error.to_string())));
            }
        }
    }
}

/// A live connection to the daemon supervisor socket, optionally upgraded
/// with a direct worker link (session-plane commands and events go straight
/// to the session process; the supervisor stays the control plane).
///
/// Cheap to clone: clones share the same socket, pending-request table, and
/// direct link, so a background request (the Ctrl+C abort) races a live
/// client exactly.
#[derive(Clone)]
pub struct DaemonClient {
    socket_path: PathBuf,
    client_id: String,
    protocol: DaemonProtocolInfo,
    /// Full `daemon_hello` frame (schema id, app version, capabilities).
    hello: Value,
    next_request_id: Arc<AtomicU64>,
    shared: Arc<Shared>,
    writer: mpsc::UnboundedSender<String>,
    /// Direct-transport state (retained event sender + live worker link),
    /// one pointer so this struct stays small.
    direct: std::sync::Arc<crate::direct_transport::DirectState>,
    /// The supervisor reader's death watch (see `reader_dead`).
    reader_dead_rx: tokio::sync::watch::Receiver<bool>,
}

impl DaemonClient {
    /// Connect to `socket_path`, complete the hello handshake, and return the
    /// client plus the event receiver. The event receiver must be polled or
    /// the reader task stalls once the channel's buffer fills.
    pub async fn connect(
        socket_path: &Path,
    ) -> Result<(Self, mpsc::UnboundedReceiver<DaemonClientEvent>)> {
        let connect = tokio::time::timeout(
            Duration::from_millis(CONNECT_TIMEOUT_MS),
            pa_types::platform::transport::connect_transport(socket_path),
        )
        .await
        .map_err(|_| {
            anyhow!(
                "Timed out after {CONNECT_TIMEOUT_MS}ms connecting to the Prime Agent daemon. Socket: {}.",
                socket_path.display()
            )
        })?
        .with_context(|| {
            format!(
                "Failed to connect to the Prime Agent daemon. Socket: {}.",
                socket_path.display()
            )
        })?;

        let (reader_half, writer_half) = connect.split();
        let (line_tx, mut line_rx) = mpsc::unbounded_channel::<String>();
        let (event_tx, event_rx) = mpsc::unbounded_channel::<DaemonClientEvent>();
        let retained_event_tx = event_tx.clone();
        // The supervisor reader's death signal: the retained event sender
        // keeps the event channel open after the reader exits (direct
        // reader pumps may still feed it), so a channel close can never
        // observe a supervisor socket loss — the watch is the observable
        // signal the UI loop arms its reconnect driver on.
        let (reader_dead_tx, reader_dead_rx) = tokio::sync::watch::channel(false);
        let (hello_tx, hello_rx) = oneshot::channel::<Value>();
        let shared = Arc::new(Shared {
            pending: Mutex::new(HashMap::new()),
        });
        let reader_shared = Arc::clone(&shared);

        // Writer task: serializes one line per write.
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

        // Reader task: dispatch every inbound line. The handle is kept so
        // the handshake-failure paths can abort it: a daemon that accepts
        // the socket but never greets must not leave a blocked reader task
        // (and its socket halves) behind per retry attempt.
        let reader_task = tokio::spawn(async move {
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
                let frame_type = value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match frame_type {
                    "daemon_hello" => {
                        let Some(tx) = hello_tx.take() else { continue };
                        let _ = tx.send(value);
                    }
                    "response" => {
                        if let Ok(response) =
                            serde_json::from_value::<DaemonResponse>(value.clone())
                        {
                            let id = response.id.clone().unwrap_or_default();
                            reader_shared.resolve(&id, response);
                        }
                    }
                    _ => {
                        if let Some(event) = client_event_from_value(&value) {
                            let _ = event_tx.send(event);
                        }
                    }
                }
            }
            // The supervisor socket closed: every supervisor-routed request
            // in flight fails now instead of riding out its timeout, and
            // the death watch wakes the UI loop's reconnect driver.
            let _ = reader_dead_tx.send(true);
            reader_shared.fail_pending("daemon_", "the daemon connection closed");
        });

        // Hello handshake: the supervisor sends daemon_hello immediately on
        // connect (TS `waitForHello`). Every failure path aborts the
        // blocked reader task so a failed attempt leaks no socket halves.
        let hello = tokio::time::timeout(Duration::from_millis(HELLO_TIMEOUT_MS), hello_rx)
            .await
            .map_err(|_| {
                reader_task.abort();
                anyhow!(
                    "Timed out after {HELLO_TIMEOUT_MS}ms waiting for the Prime Agent daemon handshake. Socket: {}.",
                    socket_path.display()
                )
            })?
            .map_err(|_| {
                reader_task.abort();
                anyhow!("the daemon connection closed before the handshake")
            })?;
        let protocol = hello
            .get("protocol")
            .cloned()
            .and_then(|p| serde_json::from_value::<DaemonProtocolInfo>(p).ok())
            .unwrap_or(DaemonProtocolInfo {
                name: DAEMON_PROTOCOL_NAME.to_string(),
                version: DAEMON_PROTOCOL_VERSION,
            });
        if protocol.name != DAEMON_PROTOCOL_NAME {
            reader_task.abort();
            return Err(anyhow!(
                "the daemon on {} speaks an unknown protocol \"{}\"",
                socket_path.display(),
                protocol.name
            ));
        }
        // Envelope protocol version: the shared minimum (TS `request`).
        let version = protocol.version.min(DAEMON_PROTOCOL_VERSION);

        Ok((
            DaemonClient {
                socket_path: socket_path.to_path_buf(),
                client_id: format!("daemon-tui:{}", std::process::id()),
                protocol: DaemonProtocolInfo {
                    name: DAEMON_PROTOCOL_NAME.to_string(),
                    version,
                },
                hello,
                next_request_id: Arc::new(AtomicU64::new(0)),
                shared,
                writer: line_tx,
                direct: std::sync::Arc::new(crate::direct_transport::DirectState::new(
                    retained_event_tx,
                )),
                reader_dead_rx,
            },
            event_rx,
        ))
    }

    /// A fresh receiver for the supervisor reader's death watch: fires
    /// (`true`) when the supervisor socket's reader task ends — a daemon
    /// hiccup the UI loop's reconnect driver observes (the event channel
    /// itself stays open: the retained sender keeps it alive for direct
    /// reader pumps). Poll it with `watch::Receiver::changed`.
    pub fn reader_dead(&self) -> tokio::sync::watch::Receiver<bool> {
        self.reader_dead_rx.clone()
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// [`Self::connect`] with bounded retries and doubling backoff: a
    /// missed hello (a loaded daemon mid-fanout, a supervisor coming up
    /// after a restart) is a hiccup, not a fatal condition — the one-shot
    /// connect cost the operator their TUI twice on 2026-09-24 ("Timed
    /// out after 15000ms waiting for the Prime Agent daemon handshake").
    /// The caller's error path (fatal exit or view fallback) only runs
    /// after the last attempt.
    pub async fn connect_with_retry(
        socket_path: &Path,
    ) -> Result<(Self, mpsc::UnboundedReceiver<DaemonClientEvent>)> {
        let mut delay = CONNECT_RETRY_BACKOFF_MS;
        for attempt in 1..=CONNECT_ATTEMPTS {
            match DaemonClient::connect(socket_path).await {
                Ok(pair) => return Ok(pair),
                Err(error) => {
                    if attempt == CONNECT_ATTEMPTS {
                        return Err(error);
                    }
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    delay = delay.saturating_mul(2);
                }
            }
        }
        unreachable!("the attempt range is non-empty")
    }

    /// Protocol identity negotiated in the hello handshake.
    pub fn protocol(&self) -> &DaemonProtocolInfo {
        &self.protocol
    }

    /// The full `daemon_hello` frame the supervisor sent on connect.
    /// Whether the daemon's `daemon_hello` advertised `capability` (TS
    /// `supportsServerCapability`): capability-gated commands fall back to
    /// their older shape without it.
    pub fn supports_server_capability(&self, capability: &str) -> bool {
        self.hello
            .get("serverCapabilities")
            .and_then(Value::as_array)
            .is_some_and(|capabilities| {
                capabilities
                    .iter()
                    .any(|entry| entry.as_str() == Some(capability))
            })
    }

    pub fn hello(&self) -> &Value {
        &self.hello
    }

    /// Send one command envelope and wait for the matching response, using
    /// the TS default timeout for the command class.
    pub async fn request(&self, command: DaemonCommand) -> Result<DaemonResponse> {
        let timeout_ms = match &command {
            DaemonCommand::PromptAndWait { .. } | DaemonCommand::WaitForIdle { .. } => {
                LONG_RUNNING_REQUEST_TIMEOUT_MS
            }
            _ => DEFAULT_REQUEST_TIMEOUT_MS,
        };
        self.request_with_timeout(command, timeout_ms).await
    }

    /// Send one command envelope and wait up to `timeout_ms` for the response.
    ///
    /// Session-plane commands for the direct link's session go straight to
    /// the session worker socket; everything else goes to the supervisor.
    /// A direct link that died before the request was written falls back to
    /// the supervisor (the request never reached the worker); a request that
    /// was sent and timed out surfaces the error instead of retrying, so a
    /// prompt can never execute twice.
    pub async fn request_with_timeout(
        &self,
        command: DaemonCommand,
        timeout_ms: u64,
    ) -> Result<DaemonResponse> {
        if let Some(link) = self.direct_link_for(&command) {
            let id = format!(
                "direct_{}",
                self.next_request_id.fetch_add(1, Ordering::SeqCst) + 1
            );
            match self.request_direct(&link, &command, &id, timeout_ms).await {
                Ok(response) => return Ok(response),
                Err(DirectRequestError::NotSent) => {
                    // The link was dead before the frame was queued; the
                    // request never reached the worker, so supervisor
                    // routing is safe.
                    self.direct.drop_link();
                }
                Err(DirectRequestError::Wait(error)) => return Err(error),
            }
        }
        self.request_supervisor(command, timeout_ms).await
    }

    /// Send one command envelope to the supervisor, bypassing any direct
    /// worker link, and require `success: true`. The supervisor-owned arms
    /// (`abort_compaction`) must reach the supervisor even when a direct
    /// link serves the session: the direct link IS the wedged worker in
    /// the case the supervisor arm exists for.
    pub async fn request_ok_via_supervisor(&self, command: DaemonCommand) -> Result<Value> {
        let name = command_type_debug(&command);
        let response = self
            .request_supervisor(command, DEFAULT_REQUEST_TIMEOUT_MS)
            .await?;
        response_data_or_error(&name, response)
    }

    /// The supervisor leg of [`Self::request_with_timeout`]: one JSONL
    /// envelope on the supervisor connection.
    async fn request_supervisor(
        &self,
        command: DaemonCommand,
        timeout_ms: u64,
    ) -> Result<DaemonResponse> {
        let id = format!(
            "daemon_{}",
            self.next_request_id.fetch_add(1, Ordering::SeqCst) + 1
        );
        self.request_supervisor_with_id(command, &id, timeout_ms)
            .await
    }

    /// One JSONL envelope on the supervisor connection, under the caller's
    /// own envelope id: the streamed `session_list_item` frames of
    /// `list_saved_sessions` carry it, so the caller can attribute the
    /// catalog stream to its own fetch (TS's connection routes the
    /// stream to the originating `listDaemonSavedSessions` callbacks).
    /// The id must start with `daemon_` - the supervisor reader's
    /// socket-close failure pass filters by that prefix.
    pub async fn request_supervisor_with_id(
        &self,
        command: DaemonCommand,
        id: &str,
        timeout_ms: u64,
    ) -> Result<DaemonResponse> {
        let id = id.to_string();
        let envelope = DaemonCommandEnvelope {
            frame_type: DaemonCommandFrameType::Command,
            id: id.clone(),
            protocol: self.protocol.clone(),
            client_id: Some(self.client_id.clone()),
            command,
        };
        let line = serde_json::to_string(&envelope)?;
        let (tx, rx) = oneshot::channel::<Result<DaemonResponse>>();
        self.shared.pending.lock().unwrap().insert(id.clone(), tx);
        self.writer
            .send(line)
            .map_err(|_| anyhow!("the daemon connection is closed"))?;
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            // The daemon answered (its response says whether it was happy).
            Ok(Ok(result)) => result,
            // The reader task died before resolving this request: the
            // connection was already gone.
            Ok(Err(_)) => Err(anyhow!(
                "Connection to the Prime Agent daemon closed. Socket: {}.",
                self.socket_path.display()
            )),
            Err(_) => {
                self.shared.pending.lock().unwrap().remove(&id);
                Err(anyhow!(
                    "Timed out after {timeout_ms}ms waiting for the Prime Agent daemon response. Socket: {}.",
                    self.socket_path.display()
                ))
            }
        }
    }

    /// Send a command and require `success: true`, surfacing the daemon error
    /// string otherwise.
    pub async fn request_ok(&self, command: DaemonCommand) -> Result<Value> {
        let name = command_type_debug(&command);
        let response = self.request(command).await?;
        response_data_or_error(&name, response)
    }

    /// Whether a session-plane command for the direct link's session may
    /// travel over the direct link (TS `servesDirect`).
    /// The live direct link that may serve `command` (TS `servesDirect`):
    /// the command must be session-plane and address the link's session.
    fn direct_link_for(&self, command: &DaemonCommand) -> Option<DirectLink> {
        let link = self.direct.live_link()?;
        let command_type = command_type_debug(command);
        if !is_session_plane_daemon_command(&command_type) {
            return None;
        }
        let session = serde_json::to_value(command).ok().and_then(|payload| {
            payload
                .get("activeSessionId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        });
        (session.as_deref() == Some(link.active_session_id.as_str())).then_some(link)
    }

    /// One request over the direct worker link.
    async fn request_direct(
        &self,
        link: &DirectLink,
        command: &DaemonCommand,
        id: &str,
        timeout_ms: u64,
    ) -> std::result::Result<DaemonResponse, DirectRequestError> {
        let payload = self
            .direct_command_payload(command)
            .map_err(|_| DirectRequestError::NotSent)?;
        let frame = pa_types::daemon::framing::encode_private_frame(
            &serde_json::json!({
                "kind": "command",
                "requestId": id,
                "commandType": command_type_debug(command),
            }),
            &serde_json::to_vec(&payload).unwrap_or_default(),
            pa_types::daemon::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .map_err(|_| DirectRequestError::NotSent)?;
        let (reply_tx, reply_rx) = oneshot::channel::<Result<DaemonResponse>>();
        self.shared
            .pending
            .lock()
            .unwrap()
            .insert(id.to_string(), reply_tx);
        if !link.send(frame) {
            self.shared.pending.lock().unwrap().remove(id);
            return Err(DirectRequestError::NotSent);
        }
        match tokio::time::timeout(Duration::from_millis(timeout_ms), reply_rx).await {
            // The worker answered (its response says whether it was happy).
            Ok(Ok(Ok(response))) => Ok(response),
            // The worker link died: a transport failure, never a refusal.
            Ok(Ok(Err(error))) => Err(DirectRequestError::Wait(error)),
            Ok(Err(_)) => Err(DirectRequestError::Wait(anyhow!(
                "the direct session connection closed. Socket: {}.",
                link.socket_path
            ))),
            Err(_) => {
                self.shared.pending.lock().unwrap().remove(id);
                Err(DirectRequestError::Wait(anyhow!(
                    "Timed out after {timeout_ms}ms waiting for the session response. Socket: {}.",
                    link.socket_path
                )))
            }
        }
    }

    /// The wire payload for a direct session command: the command itself,
    /// stamped with this client's id (the supervisor stamps it on the routed
    /// path) and, for attach, the slim-snapshot capability set the
    /// supervisor's routed attach uses, so both paths return identical
    /// attach results.
    fn direct_command_payload(&self, command: &DaemonCommand) -> Result<Value> {
        let mut payload = serde_json::to_value(command)?;
        if let Some(object) = payload.as_object_mut() {
            object.insert("clientId".to_string(), serde_json::json!(self.client_id));
            if matches!(command, DaemonCommand::Attach { .. }) {
                object.insert(
                    "capabilities".to_string(),
                    serde_json::json!(direct_attach_capabilities()),
                );
            }
        }
        Ok(payload)
    }

    /// The active direct link's session, when this client upgraded.
    pub fn direct_session_id(&self) -> Option<String> {
        self.direct.session_id()
    }

    /// Drop the direct link and keep plain supervisor routing (TS
    /// `fallbackToSupervisor`).
    pub fn drop_direct(&self) {
        self.direct.drop_link();
    }

    /// Upgrade this connection with a direct worker link for
    /// `active_session_id` (TS `createDaemonSessionTransport`): request a
    /// ticket from the supervisor, validate it, connect to the worker
    /// socket, and authenticate with the single-use grant. Every failure
    /// returns `Ok(false)` and leaves the plain supervisor connection in
    /// place.
    pub async fn upgrade_direct(&self, active_session_id: &str) -> Result<bool> {
        if !supervisor_supports_direct(&self.hello) {
            return Ok(false);
        }
        if self.direct_session_id().as_deref() == Some(active_session_id) {
            return Ok(true);
        }
        self.drop_direct();
        let ticket_response = match self
            .request_with_timeout(
                DaemonCommand::GetDirectWorkerTransport {
                    id: None,
                    active_session_id: active_session_id.to_string(),
                    rest: Default::default(),
                },
                TICKET_TIMEOUT_MS,
            )
            .await
        {
            Ok(response) => response,
            Err(_) => return Ok(false),
        };
        if !ticket_response.success {
            return Ok(false);
        }
        let Some(data) = ticket_response.data else {
            return Ok(false);
        };
        let ticket = match read_session_transport_ticket(&data, active_session_id) {
            Ok(ticket) => ticket,
            Err(_) => return Ok(false),
        };
        let Some(event_tx) = self.direct.event_sender() else {
            return Ok(false);
        };
        match connect_direct(&ticket, Arc::clone(&self.shared), event_tx).await {
            Ok(link) => {
                self.direct.set_link(link);
                Ok(true)
            }
            Err(_) => Ok(false),
        }
    }

    /// Close the connection; pending requests fail with the closed error.
    pub fn close(&self) {
        self.direct.take_event_sender();
        self.drop_direct();
        let _ = self.writer.send(String::new());
    }

    /// Dispose the connection outright: like [`Self::close`], but the
    /// writer sender is DROPPED too (a replacement dummy takes its
    /// place), so the writer task finishes its queue, shuts the socket's
    /// write half down, and the reader EOFs — a half-attached client is
    /// never left running through the reconnect window. The failure
    /// paths that replace an installed client use this (the plain
    /// `close` keeps the writer alive for teardown-order cases).
    pub fn hard_close(&mut self) {
        self.direct.take_event_sender();
        self.drop_direct();
        let (replacement, _) = mpsc::unbounded_channel::<String>();
        let writer = std::mem::replace(&mut self.writer, replacement);
        let _ = writer.send(String::new());
    }
}

/// Why a direct request failed: `NotSent` never reached the worker (safe to
/// fall back to the supervisor), `Wait` did and must not be retried.
enum DirectRequestError {
    NotSent,
    Wait(anyhow::Error),
}

/// The daemon answered with `success: false` for one request: the daemon
/// is alive and healthy — it refused THIS request ("Prompt cannot be
/// empty", a queue/admission refusal, an unknown session selector, a
/// model the allowlist refuses, ...). Rejections carry data about the
/// request, never about the connection: the interactive loop renders
/// them inline and keeps running, while transport failures (dead
/// socket, timeout, closed connection) stay fatal.
#[derive(Debug, PartialEq)]
pub struct RequestRejected {
    /// Wire `type` of the refused command, for the rendered message.
    pub command: String,
    /// The daemon's raw error string.
    pub message: String,
    /// The typed refusal info (`errorInfo`), when the daemon typed it:
    /// `update_restarting` (the update-prepare fence, TS #2391),
    /// `session_already_active`, ... `None` for untyped refusals and
    /// older daemons.
    pub error_info: Option<pa_types::daemon::DaemonErrorInfo>,
}

impl std::fmt::Display for RequestRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "the daemon rejected the {} request: {}",
            self.command, self.message
        )
    }
}

impl std::error::Error for RequestRejected {}

/// Whether the error is (or wraps) a daemon refusal, not a transport
/// failure: the daemon answered and refused the request itself.
pub fn is_daemon_rejection(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.downcast_ref::<RequestRejected>().is_some())
}

/// True when an open failure is the update-restart transient state (TS
/// `isDaemonUpdateRestartingError`): a typed `update_restarting`
/// rejection from a current daemon, or the exact-message fallback that
/// also recognizes older daemons rejecting with the same plain string.
pub fn is_update_restarting_rejection(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<RequestRejected>()
            .is_some_and(|rejected| {
                matches!(
                    &rejected.error_info,
                    Some(pa_types::daemon::DaemonErrorInfo::UpdateRestarting)
                ) || rejected.message == pa_types::daemon::UPDATE_RESTART_PREPARING_MESSAGE
            })
    })
}

/// Whether an error is a response/handshake timeout ("Timed out after
/// Nms waiting for the Prime Agent daemon (response|handshake)"): a
/// transient under-load failure, not a protocol error — the caller
/// degrades (retry or surface the queued state) instead of exiting.
pub fn is_daemon_timeout(error: &anyhow::Error) -> bool {
    // Case-insensitive: the TUI's own bounded requests say
    // "timed out after Nms ...", the daemon client's hello/connect paths
    // "Timed out after Nms ...".
    error
        .chain()
        .any(|cause| cause.to_string().to_lowercase().contains("timed out after"))
}

/// Whether an error means the daemon connection could not carry the
/// request at all (a timeout, or a closed connection): a transient the
/// submit path surfaces without exiting — the pane stays mounted for the
/// reconnect driver to restore the connection.
pub fn is_daemon_unreachable(error: &anyhow::Error) -> bool {
    is_daemon_timeout(error)
        || error.chain().any(|cause| {
            let cause = cause.to_string().to_lowercase();
            cause.contains("daemon connection")
                || cause.contains("prime agent daemon closed")
                || cause.contains("direct session connection closed")
                || cause.contains("the session connection closed")
        })
}

/// Unwrap a settled response into its `data`, surfacing the daemon
/// refusal as a typed [`RequestRejected`] on failure.
fn response_data_or_error(name: &str, response: DaemonResponse) -> Result<Value> {
    if !response.success {
        return Err(anyhow::Error::new(RequestRejected {
            command: name.to_string(),
            message: response
                .error
                .unwrap_or_else(|| "unknown error".to_string()),
            error_info: response.error_info,
        }));
    }
    Ok(response.data.unwrap_or(Value::Null))
}

/// Wire `type` tag of a command, for error messages.
fn command_type_debug(command: &DaemonCommand) -> String {
    serde_json::to_value(command)
        .ok()
        .and_then(|value| value.get("type").cloned())
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "command".to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::net::UnixListener;

    /// Minimal scripted supervisor used by client tests: hello on connect,
    /// canned responses keyed by command type.
    async fn spawn_mock_daemon(listener: UnixListener) {
        let (stream, _) = listener.accept().await.expect("accept");
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        let hello = json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "clientId": "srv",
            "serverCapabilities": [],
        });
        let mut line = serde_json::to_string(&hello).unwrap();
        line.push('\n');
        writer.write_all(line.as_bytes()).await.unwrap();
        let mut seen = String::new();
        loop {
            seen.clear();
            match reader.read_line(&mut seen).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let envelope: Value = serde_json::from_str(seen.trim()).unwrap();
            let id = envelope["id"].as_str().unwrap().to_string();
            let command_type = envelope["command"]["type"].as_str().unwrap();
            if command_type == "prompt" {
                // Stream an event before the response, like the real worker.
                let event = json!({
                    "type": "session_event",
                    "activeSessionId": "s1",
                    "event": { "type": "turn_end" },
                });
                let mut payload = serde_json::to_string(&event).unwrap();
                payload.push('\n');
                writer.write_all(payload.as_bytes()).await.unwrap();
            }
            let response = json!({
                "type": "response",
                "id": id,
                "command": command_type,
                "success": true,
                "data": { "ok": true },
            });
            let mut payload = serde_json::to_string(&response).unwrap();
            payload.push('\n');
            writer.write_all(payload.as_bytes()).await.unwrap();
        }
    }

    fn empty_prompt_input() -> pa_types::daemon::PromptInput {
        pa_types::daemon::PromptInput {
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
        }
    }

    #[tokio::test]
    async fn handshake_and_request_round_trip() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("d.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        tokio::spawn(async move { spawn_mock_daemon(listener).await });

        let (client, mut events) = DaemonClient::connect(&socket).await.unwrap();
        assert_eq!(client.protocol().version, 7);
        let data = client
            .request_ok(DaemonCommand::List {
                id: None,
                all: None,
                cwd: None,
                session_dir: None,
                include_client_owned: None,
                rest: Default::default(),
            })
            .await
            .unwrap();
        assert_eq!(data["ok"], true);

        // A session event frames arrives out of band, ahead of its response.
        client
            .request_ok(DaemonCommand::Prompt {
                id: None,
                active_session_id: "s1".to_string(),
                message: "hi".to_string(),
                input: empty_prompt_input(),
                rest: Default::default(),
            })
            .await
            .unwrap();
        let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(
                event,
                DaemonClientEvent::SessionEvent { ref event, .. } if event["type"] == "turn_end"
            ),
            "unexpected event: {event:?}"
        );
        client.close();
    }

    #[tokio::test]
    async fn request_timeout_reports_socket() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("d.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        // A daemon that sends hello but never answers commands.
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut writer = stream;
            let mut hello = json!({
                "type": "daemon_hello",
                "protocol": { "name": "prime-agent.daemon", "version": 7 },
                "clientId": "srv",
                "serverCapabilities": [],
            })
            .to_string();
            hello.push('\n');
            writer.write_all(hello.as_bytes()).await.unwrap();
            std::future::pending::<()>().await;
        });
        let (client, _events) = DaemonClient::connect(&socket).await.unwrap();
        let error = client
            .request_with_timeout(
                DaemonCommand::List {
                    id: None,
                    all: None,
                    cwd: None,
                    session_dir: None,
                    include_client_owned: None,
                    rest: Default::default(),
                },
                100,
            )
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("Timed out after"),
            "unexpected error: {error}"
        );
        assert!(error
            .to_string()
            .contains(socket.display().to_string().as_str()));
        // A transport failure is never a rejection.
        assert!(!is_daemon_rejection(&error));
    }

    #[test]
    fn failed_response_is_a_typed_rejection() {
        let response = DaemonResponse {
            id: None,
            command: "prompt".to_string(),
            success: false,
            data: None,
            error: Some("Prompt cannot be empty".to_string()),
            error_info: None,
        };
        let error = response_data_or_error("prompt", response).unwrap_err();
        assert!(is_daemon_rejection(&error));
        let rejection = error
            .downcast_ref::<RequestRejected>()
            .expect("typed rejection");
        assert_eq!(rejection.command, "prompt");
        assert_eq!(rejection.message, "Prompt cannot be empty");
        // The rendered message is byte-identical to the pre-typed string.
        assert_eq!(
            rejection.to_string(),
            "the daemon rejected the prompt request: Prompt cannot be empty"
        );
    }

    #[test]
    fn plain_errors_are_not_rejections() {
        let error = anyhow!("the daemon connection is closed");
        assert!(!is_daemon_rejection(&error));
    }

    /// TS #2391 `update_restarting` wire round-trip (the
    /// daemon-errors.test.ts mirror): the typed info survives the wire
    /// to a `RequestRejected`, and the exact-message fallback recognizes
    /// the older daemon's plain-string rejection. An unrelated refusal
    /// never classifies as the update-restart transient state.
    #[test]
    fn update_restarting_rejection_round_trips_the_wire() {
        let line = serde_json::from_str::<DaemonResponse>(
            r#"{"type":"response","command":"create","success":false,"error":"Daemon is preparing an update restart","errorInfo":{"code":"update_restarting"}}"#,
        )
        .expect("typed refusal parses");
        let error = response_data_or_error("create", line).unwrap_err();
        assert!(is_update_restarting_rejection(&error));
        let rejection = error
            .downcast_ref::<RequestRejected>()
            .expect("typed rejection");
        assert_eq!(
            rejection.error_info,
            Some(pa_types::daemon::DaemonErrorInfo::UpdateRestarting)
        );
        // The legacy daemon: the same plain string with no errorInfo.
        let legacy = serde_json::from_str::<DaemonResponse>(
            r#"{"type":"response","command":"create","success":false,"error":"Daemon is preparing an update restart"}"#,
        )
        .expect("legacy refusal parses");
        let error = response_data_or_error("create", legacy).unwrap_err();
        assert!(is_update_restarting_rejection(&error));
        // An unrelated refusal is not the update-restart state.
        let other = serde_json::from_str::<DaemonResponse>(
            r#"{"type":"response","command":"create","success":false,"error":"Unknown active session: active-gap"}"#,
        )
        .expect("unrelated refusal parses");
        let error = response_data_or_error("create", other).unwrap_err();
        assert!(!is_update_restarting_rejection(&error));
    }

    #[test]
    fn fail_pending_resolves_a_transport_failure_not_a_refusal() {
        // The reader task's dead-connection failure must stay on the
        // transport half of the pending channel: a closed socket can never
        // masquerade as a daemon refusal and keep the UI alive.
        let shared = Shared::default();
        let (tx, rx) = oneshot::channel();
        shared
            .pending
            .lock()
            .unwrap()
            .insert("daemon_1".to_string(), tx);
        shared.fail_pending("daemon_", "the daemon connection closed");
        let error = rx.blocking_recv().unwrap().unwrap_err();
        assert!(!is_daemon_rejection(&error));
        assert_eq!(error.to_string(), "the daemon connection closed");
    }

    /// A scripted worker socket for the direct-link tests: hello frame,
    /// `peer_auth` acceptance, one attach response, then one streamed event.
    async fn spawn_mock_worker(listener: tokio::net::UnixListener) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (stream, _) = listener.accept().await.expect("worker accept");
        let (mut reader, mut writer) = stream.into_split();
        let hello = pa_types::daemon::framing::encode_private_frame(
            &serde_json::json!({ "kind": "outbound", "outboundType": "daemon_hello" }),
            br#"{"type":"daemon_hello","protocol":{"name":"prime-agent.daemon","version":7}}"#,
            pa_types::daemon::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .unwrap();
        writer.write_all(&hello).await.unwrap();

        let mut pending = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut attached = false;
        loop {
            let read = reader.read(&mut chunk).await.expect("worker read");
            if read == 0 {
                break;
            }
            pending.extend_from_slice(&chunk[..read]);
            let mut decoder = pa_types::daemon::framing::PrivateFrameDecoder::new(
                pa_types::daemon::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
            );
            let frames = decoder.push(&pending).expect("decode frames");
            pending.clear();
            for frame in frames {
                let command_type = frame.header["commandType"].as_str().unwrap_or_default();
                let request_id = frame.header["requestId"].as_str().unwrap_or_default();
                let (success, data) = match command_type {
                    "peer_auth" => (
                        true,
                        Some(serde_json::json!({
                            "workerInstanceId": "inst-1",
                            "activeSessionId": "s1",
                            "purpose": "session_client",
                        })),
                    ),
                    "attach" => {
                        attached = true;
                        (
                            true,
                            Some(serde_json::json!({
                                "activeSessionId": "s1",
                                "snapshot": { "messages": [], "summary": {} },
                            })),
                        )
                    }
                    "get_state" => (
                        true,
                        Some(serde_json::json!({ "id": "s1", "activity": "idle" })),
                    ),
                    _ => (false, None),
                };
                let response = serde_json::json!({
                    "id": request_id,
                    "type": "response",
                    "command": command_type,
                    "success": success,
                    "data": data,
                });
                let frame = pa_types::daemon::framing::encode_private_frame(
                    &serde_json::json!({
                        "kind": "outbound",
                        "requestId": request_id,
                        "outboundType": "response",
                    }),
                    &serde_json::to_vec(&response).unwrap(),
                    pa_types::daemon::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
                )
                .unwrap();
                writer.write_all(&frame).await.unwrap();
            }
            if attached {
                // Stream one event, then wait for the client to close.
                let event = serde_json::json!({
                    "type": "session_event",
                    "activeSessionId": "s1",
                    "event": { "type": "turn_end" },
                });
                let frame = pa_types::daemon::framing::encode_private_frame(
                    &serde_json::json!({
                        "kind": "outbound",
                        "outboundType": "session_event",
                        "activeSessionId": "s1",
                    }),
                    &serde_json::to_vec(&event).unwrap(),
                    pa_types::daemon::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
                )
                .unwrap();
                writer.write_all(&frame).await.unwrap();
                attached = false;
            }
        }
    }

    #[tokio::test]
    async fn direct_upgrade_routes_attach_and_streams_events() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("d.sock");
        let worker_socket = dir.path().join("w.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let worker_listener = tokio::net::UnixListener::bind(&worker_socket).unwrap();
        tokio::spawn(async move { spawn_mock_worker(worker_listener).await });

        // Scripted supervisor: advertises direct_peer_transport, answers the
        // ticket request with a ticket for the mock worker socket.
        let ticket_socket = worker_socket.clone();
        let supervisor = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("supervisor accept");
            let (reader, mut writer) = stream.into_split();
            let mut reader = tokio::io::BufReader::new(reader);
            let mut line = String::new();
            let hello = serde_json::json!({
                "type": "daemon_hello",
                "protocol": { "name": "prime-agent.daemon", "version": 7 },
                "serverCapabilities": ["direct_peer_transport"],
            });
            writer
                .write_all(format!("{hello}\n").as_bytes())
                .await
                .unwrap();
            loop {
                line.clear();
                if reader.read_line(&mut line).await.unwrap() == 0 {
                    break;
                }
                let envelope: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
                let id = envelope["id"].as_str().unwrap().to_string();
                let command_type = envelope["command"]["type"].as_str().unwrap();
                let response = if command_type == "get_direct_worker_transport" {
                    let identity = pa_types::platform::socket_identity(&ticket_socket).unwrap();
                    serde_json::json!({
                        "type": "response",
                        "id": id,
                        "command": command_type,
                        "success": true,
                        "data": {
                            "purpose": "session_client",
                            "socketPath": ticket_socket.to_string_lossy(),
                            "socketIdentity": { "dev": identity.dev, "ino": identity.ino },
                            "workerInstanceId": "inst-1",
                            "activeSessionId": "s1",
                            "grantId": "g1",
                            "token": "t",
                            "expiresAt": "2999-01-01T00:00:00.000Z",
                        },
                    })
                } else {
                    serde_json::json!({
                        "type": "response",
                        "id": id,
                        "command": command_type,
                        "success": true,
                        "data": { "ok": true },
                    })
                };
                writer
                    .write_all(format!("{response}\n").as_bytes())
                    .await
                    .unwrap();
            }
        });

        let (client, mut events) = DaemonClient::connect(&socket).await.unwrap();
        assert!(
            crate::direct_transport::supervisor_supports_direct(client.hello()),
            "capability advertised"
        );
        assert!(client.upgrade_direct("s1").await.unwrap());
        assert_eq!(client.direct_session_id().as_deref(), Some("s1"));

        // The attach travels over the direct link and its event streams
        // from the worker socket through the same event channel.
        let data = client
            .request_ok(DaemonCommand::Attach {
                id: None,
                active_session_id: "s1".to_string(),
                supports_extension_ui: None,
                client_id: None,
                capabilities: None,
                resume_cursor: None,
                telemetry_disabled: None,
                recovery_config: None,
                env: None,
                launch_env: None,
                rest: Default::default(),
            })
            .await
            .unwrap();
        assert_eq!(data["activeSessionId"], "s1");
        // The link survives across requests: a second session-plane request
        // still routes over the direct socket.
        let state = client
            .request_ok(DaemonCommand::GetState {
                id: None,
                active_session_id: "s1".to_string(),
                rest: Default::default(),
            })
            .await
            .unwrap();
        assert_eq!(state["id"], "s1");
        let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(
                event,
                DaemonClientEvent::SessionEvent { ref event, .. } if event["type"] == "turn_end"
            ),
            "unexpected event: {event:?}"
        );
        client.close();
        let _ = supervisor.await;
    }

    #[tokio::test]
    async fn dead_connection_fails_pending_requests_immediately() {
        // The supervisor dies after the handshake while a request is in
        // flight: the reader task must fail the pending request at once
        // (the exit-hang class: the abort was accepted, but the client
        // then waited out the full request timeout on a dead socket).
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("d.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let handle = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut writer = stream;
            let mut hello = json!({
                "type": "daemon_hello",
                "protocol": { "name": "prime-agent.daemon", "version": 7 },
                "clientId": "srv",
                "serverCapabilities": [],
            })
            .to_string();
            hello.push('\n');
            writer.write_all(hello.as_bytes()).await.unwrap();
            // Hold the accept open until the request is in flight, then
            // close the socket (the supervisor process dies).
            tokio::time::sleep(Duration::from_millis(100)).await;
            drop(writer);
        });
        let (client, _events) = DaemonClient::connect(&socket).await.unwrap();
        // The default timeout is 30s; the failure must land in well under a
        // second because the socket died, not because a timer fired.
        let started = std::time::Instant::now();
        let error = client
            .request_ok(DaemonCommand::List {
                id: None,
                all: None,
                cwd: None,
                session_dir: None,
                include_client_owned: None,
                rest: Default::default(),
            })
            .await
            .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(
            error.to_string().contains("the daemon connection closed"),
            "unexpected error: {error}"
        );
        // The dead-connection failure is transport, never a daemon
        // refusal: the interactive loop must still exit on it.
        assert!(!is_daemon_rejection(&error));
        client.close();
        let _ = handle.await;
    }

    #[tokio::test]
    async fn without_capability_upgrade_is_a_no_op() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("d.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        tokio::spawn(async move { spawn_mock_daemon(listener).await });
        let (client, _events) = DaemonClient::connect(&socket).await.unwrap();
        assert!(!crate::direct_transport::supervisor_supports_direct(
            client.hello()
        ));
        assert!(!client.upgrade_direct("s1").await.unwrap());
        assert_eq!(client.direct_session_id(), None);
        client.close();
    }
}
