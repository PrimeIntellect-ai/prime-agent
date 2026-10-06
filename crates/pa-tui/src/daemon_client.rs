//! JSONL daemon client for the interactive UI: connect, `daemon_hello`
//! handshake, `type: "command"` envelopes matched by envelope id.
//! Non-response frames (session events, list progress, closing notices)
//! are forwarded through an event channel so the UI can render live state.

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
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::direct_transport::{
    connect_direct, direct_attach_capabilities, read_session_transport_ticket,
    supervisor_supports_direct, DirectLink, TICKET_TIMEOUT_MS,
};

mod errors;
#[cfg(all(test, unix))]
mod tests;

use errors::{command_type_debug, response_data_or_error, DirectRequestError};
pub use errors::{
    is_daemon_rejection, is_daemon_timeout, is_daemon_unreachable, is_kernel_not_running,
    is_update_restarting_rejection, rejected_provider_unauthenticated, RequestRejected,
};

pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 30_000;
/// Requests whose completion is bounded by the turn itself
/// (`prompt_and_wait`, `wait_for_idle`) — a long turn cannot expire them.
pub const LONG_RUNNING_REQUEST_TIMEOUT_MS: u64 = 600_000;
const CONNECT_TIMEOUT_MS: u64 = 3_000;
/// Hello handshake budget. A daemon loading a very large session can take
/// well over the 3s TS default to greet.
const HELLO_TIMEOUT_MS: u64 = 15_000;
/// Connect attempts before a connect/handshake failure surfaces: the
/// caller's error path only runs after the last attempt.
pub(crate) const CONNECT_ATTEMPTS: u32 = 3;
/// The first retry's backoff; each further attempt doubles it.
const CONNECT_RETRY_BACKOFF_MS: u64 = 1_000;

/// The update resume contract of a `daemon_closing` frame (spec §10.1).
#[derive(Debug, Clone)]
pub struct DaemonClosingUpdate {
    pub update_id: String,
    pub est_seconds: u64,
    /// The stopped sessions `[{sessionId, name}]`: reattach targets after the restart.
    pub sessions: Vec<Value>,
}

#[derive(Debug, Clone)]
pub enum DaemonClientEvent {
    /// `session_event`: one streamed event, with the frame's
    /// `meta.sequence` (the worker's monotonic counter).
    SessionEvent {
        active_session_id: String,
        event: Value,
        meta_sequence: u64,
    },
    SessionClosed {
        active_session_id: String,
        reason: String,
    },
    /// The direct worker link died: never itself a session loss — the UI
    /// re-attaches through the supervisor, which respawns the worker.
    DirectLinkLost { active_session_id: String },
    /// `session_list_item` progress frame: one saved row as the scan streams it, tagged with its
    /// request id.
    SessionListItem { session: Value, request_id: String },
    /// `session_list_progress` progress frame of `list_saved_sessions`.
    SessionListProgress { loaded: u64, total: u64 },
    /// `daemon_closing`: the supervisor is going down — keep the UI mounted
    /// and reconnect (the update resume contract, spec §10.1).
    DaemonClosing {
        reason: String,
        update: Option<DaemonClosingUpdate>,
    },
    /// `side_question_event`: one streamed side-question run (the `/btw` pane tracks it by id).
    SideQuestionEvent {
        active_session_id: String,
        event: Value,
    },
    /// `roster_update`: live roster deltas — changed entries upsert by agent
    /// id, `removed` deletes, `resync` replaces the whole roster.
    RosterUpdate {
        changed: Vec<Value>,
        removed: Vec<String>,
        resync: bool,
    },
    /// `heartbeats_changed`: the daemon-global broadcast when the heartbeat catalog changes.
    HeartbeatsChanged,
    /// `model_catalog_changed`: a background daemon-side catalog refresh
    /// changed the served snapshot. Rust-only extension (no TS counterpart).
    ModelCatalogChanged,
    /// `session_binding`: the supervisor rebound a session to a new active id; the view
    /// re-attaches.
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
            meta_sequence: value
                .get("meta")
                .and_then(|meta| {
                    meta.get("sequence")
                        .or_else(|| meta.get("cursor").and_then(|cursor| cursor.get("sequence")))
                })
                .and_then(Value::as_u64)
                .unwrap_or_default(),
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
        "model_catalog_changed" => Some(DaemonClientEvent::ModelCatalogChanged),
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
    /// (including a refusal); `Err` is a transport failure — a refusal is
    /// recoverable UI data, a dead connection is fatal.
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
    /// transport error: the connection that carried them died. The failure
    /// resolves on the `Err` half — never a synthetic response.
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
    /// Direct-transport state (retained event sender + live worker link).
    direct: std::sync::Arc<crate::direct_transport::DirectState>,
    /// The supervisor reader's death watch (see `reader_dead`).
    reader_dead_rx: tokio::sync::watch::Receiver<bool>,
}

impl DaemonClient {
    /// Connect to `socket_path`, complete the hello handshake, and return the
    /// client plus the event receiver (the receiver must be polled or the
    /// reader task stalls once the channel's buffer fills).
    ///
    /// # Errors
    ///
    /// Returns `Err` on a connect or hello failure, timeout, or unknown protocol.
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
        // The supervisor reader's death signal: the retained event sender keeps
        // the event channel open after the reader exits, so a channel close can
        // never observe a supervisor socket loss.
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

        // Reader task: dispatch every inbound line; the handle is kept so
        // handshake-failure paths can abort it.
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
            // The supervisor socket closed: pending requests fail now and the death watch wakes the
            // reconnect driver.
            let _ = reader_dead_tx.send(true);
            reader_shared.fail_pending("daemon_", "the daemon connection closed");
        });

        // Hello handshake: the supervisor sends daemon_hello immediately on
        // connect (TS `waitForHello`).
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
        // Envelope protocol version: the shared minimum.
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

    /// A fresh receiver for the supervisor reader's death watch: fires when
    /// the reader task ends. Poll it with `watch::Receiver::changed`.
    #[must_use]
    pub fn reader_dead(&self) -> tokio::sync::watch::Receiver<bool> {
        self.reader_dead_rx.clone()
    }

    #[must_use]
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// [`Self::connect`] with bounded retries and doubling backoff: a missed
    /// hello is a hiccup, not a fatal condition.
    ///
    /// # Errors
    ///
    /// Returns the last attempt's [`Self::connect`] error.
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
    #[must_use]
    pub fn protocol(&self) -> &DaemonProtocolInfo {
        &self.protocol
    }

    /// Whether the daemon advertised `capability` (TS
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

    #[must_use]
    pub fn hello(&self) -> &Value {
        &self.hello
    }

    /// Send one command envelope and wait for the matching response, using
    /// the TS default timeout for the command class.
    ///
    /// # Errors
    ///
    /// Returns `Err` like [`Self::request_with_timeout`].
    pub async fn request(&self, command: DaemonCommand) -> Result<DaemonResponse> {
        let timeout_ms = match &command {
            DaemonCommand::PromptAndWait { .. } | DaemonCommand::WaitForIdle { .. } => {
                LONG_RUNNING_REQUEST_TIMEOUT_MS
            }
            _ => DEFAULT_REQUEST_TIMEOUT_MS,
        };
        self.request_with_timeout(command, timeout_ms).await
    }

    /// Session-plane commands for the direct link's session go straight to the
    /// session worker socket; everything else goes to the supervisor. A dead
    /// link before the write falls back to the supervisor; a sent request that
    /// times out surfaces the error instead of retrying, so a prompt can never
    /// execute twice.
    ///
    /// # Errors
    ///
    /// Returns `Err` when the frame cannot be written, the reader dies, or
    /// the timeout elapses.
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
                    // The link was dead before the frame was queued, so
                    // supervisor routing is safe.
                    self.direct.drop_link();
                }
                Err(DirectRequestError::Wait(error)) => return Err(error),
            }
        }
        self.request_supervisor(command, timeout_ms).await
    }

    /// Send one command envelope to the supervisor, bypassing any direct
    /// worker link, and require `success: true`. The supervisor-owned arms
    /// (`abort_compaction`) must reach the supervisor even when a direct link
    /// serves the session: the direct link IS the wedged worker in that case.
    ///
    /// # Errors
    ///
    /// Returns `Err` when the request fails or times out, or carries `success: false`.
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

    /// The refusal for a supervisor reader that already ended: nothing can
    /// ever answer a request registered now.
    fn dead_reader_error(&self) -> anyhow::Error {
        anyhow!(
            "the daemon connection is closed. Socket: {}.",
            self.socket_path.display()
        )
    }

    /// One JSONL envelope on the supervisor connection, under the caller's
    /// own envelope id (the streamed `session_list_item` frames carry
    /// it). The id must start with `daemon_` — the socket-close failure
    /// sweep filters by that prefix.
    ///
    /// # Errors
    ///
    /// Returns `Err` when the envelope cannot be serialized or sent, the
    /// reader has died, or the timeout elapses.
    ///
    /// # Panics
    ///
    /// Panics when the shared pending-request mutex is poisoned.
    pub async fn request_supervisor_with_id(
        &self,
        command: DaemonCommand,
        id: &str,
        timeout_ms: u64,
    ) -> Result<DaemonResponse> {
        if *self.reader_dead_rx.borrow() {
            return Err(self.dead_reader_error());
        }
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
        // The reader runs on another worker: it can die (and run its failure
        // sweep) between the entry check and this registration. Re-check after
        // inserting — a death it missed is caught here.
        if *self.reader_dead_rx.borrow() {
            self.shared.pending.lock().unwrap().remove(&id);
            return Err(self.dead_reader_error());
        }
        self.writer
            .send(line)
            .map_err(|_| anyhow!("the daemon connection is closed"))?;
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
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
    ///
    /// # Errors
    ///
    /// Returns `Err` when [`Self::request`] fails or the response carries `success: false`.
    pub async fn request_ok(&self, command: DaemonCommand) -> Result<Value> {
        let name = command_type_debug(&command);
        let response = self.request(command).await?;
        response_data_or_error(&name, response)
    }

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

    /// The wire payload for a direct session command: the command itself
    /// stamped with this client's id (the supervisor stamps it on the routed
    /// path) and, for attach, the same slim-snapshot capability set, so both
    /// paths return identical attach results.
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
    #[must_use]
    pub fn direct_session_id(&self) -> Option<String> {
        self.direct.session_id()
    }

    /// Drop the direct link and keep plain supervisor routing.
    pub fn drop_direct(&self) {
        self.direct.drop_link();
    }

    /// Upgrade this connection with a direct worker link for
    /// `active_session_id`.
    ///
    /// # Errors
    ///
    /// Never returns `Err`: every failure path returns `Ok(false)`.
    pub async fn upgrade_direct(&self, active_session_id: &str) -> Result<bool> {
        if !supervisor_supports_direct(&self.hello) {
            return Ok(false);
        }
        if self.direct_session_id().as_deref() == Some(active_session_id) {
            return Ok(true);
        }
        self.drop_direct();
        let Ok(ticket_response) = self
            .request_with_timeout(
                DaemonCommand::GetDirectWorkerTransport {
                    id: None,
                    active_session_id: active_session_id.to_string(),
                    rest: Map::default(),
                },
                TICKET_TIMEOUT_MS,
            )
            .await
        else {
            return Ok(false);
        };
        if !ticket_response.success {
            return Ok(false);
        }
        let Some(data) = ticket_response.data else {
            return Ok(false);
        };
        let Ok(ticket) = read_session_transport_ticket(&data, active_session_id) else {
            return Ok(false);
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

    /// Dispose the connection outright: like [`Self::close`], but the writer
    /// sender is DROPPED too — a half-attached client never survives the
    /// reconnect window.
    pub fn hard_close(&mut self) {
        self.direct.take_event_sender();
        self.drop_direct();
        let (replacement, _) = mpsc::unbounded_channel::<String>();
        let writer = std::mem::replace(&mut self.writer, replacement);
        let _ = writer.send(String::new());
    }
}
