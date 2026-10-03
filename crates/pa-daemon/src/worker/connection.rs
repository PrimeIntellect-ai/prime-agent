//! Client connections: accept, authenticate, and the frame/event plumbing
//! between the worker and its supervisor.
use super::{
    active_session_id_of, anyhow, bind_transport, broadcast, create_daemon_replay_info,
    current_protocol_info, default_client_capabilities, json, normalize_client_capabilities,
    peer_command_allowed, response_failure, response_success, worker_peer_command_allowed,
    worker_server_capabilities, write_frame, write_frame_segments, Arc, AtomicU64, ConnectionRole,
    Context, DaemonOutbound, DaemonResponse, DaemonResumeCursor, Map, Ordering, Result,
    TransportStream, Value, Worker, WorkerRecoveryJournal, DAEMON_APP_VERSION, DAEMON_SCHEMA_ID,
    DAEMON_SCHEMA_REVISION, DEFAULT_PRIVATE_FRAME_LIMITS, PEER_COMMAND_NOT_ALLOWED,
};

/// Result of one connection's authentication command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AuthOutcome {
    Authenticated,
    Failed,
}

/// One outbound frame: the serialized JSON payload plus its private-frame
/// `outboundType` (`session_event` or `side_question_event`), mirroring the
/// TS worker frame header. The supervisor fans frames out per its own
/// routing (clients attached to the session).
pub(crate) struct OutboundFrame {
    pub(crate) payload: Vec<u8>,
    pub(crate) outbound_type: &'static str,
    /// The pump-assigned broadcast sequence. Connection sinks use it as a
    /// flush position so response frames cannot overtake event frames.
    pub(crate) seq: u64,
}

impl OutboundFrame {
    pub(crate) fn session_event(payload: Vec<u8>) -> Self {
        OutboundFrame {
            payload,
            outbound_type: "session_event",
            seq: 0,
        }
    }

    pub(crate) fn side_question_event(payload: Vec<u8>) -> Self {
        OutboundFrame {
            payload,
            outbound_type: "side_question_event",
            seq: 0,
        }
    }

    /// `heartbeats_changed` (TS daemon-mode `broadcastGlobal`): the store's
    /// heartbeat-catalog-change notification, re-broadcast daemon-wide by
    /// the supervisor.
    pub(crate) fn heartbeats_changed() -> Self {
        OutboundFrame {
            payload: br#"{"type":"heartbeats_changed"}"#.to_vec(),
            outbound_type: "heartbeats_changed",
            seq: 0,
        }
    }

    /// `model_catalog_changed`: a background catalog refresh changed what
    /// this worker would answer for `get_model_catalog` (Rust-only
    /// extension over the TS daemon-mode protocol — TS awaits
    /// `refreshModelCatalog` inside the request; the no-stall picker-open
    /// refresh returns the validated snapshot instantly and lands the
    /// fresh catalog through this broadcast instead). Every client
    /// re-fetches; an open picker folds the catalog through its stable
    /// update path, so the selection never flickers.
    pub(crate) fn model_catalog_changed() -> Self {
        OutboundFrame {
            payload: br#"{"type":"model_catalog_changed"}"#.to_vec(),
            outbound_type: "model_catalog_changed",
            seq: 0,
        }
    }
}

/// The worker's outbound event pump: one sequence-stamped broadcast stream
/// shared by every frame-emitting path (turns, compaction, side questions,
/// status lines). Sequences are assigned under a send guard so channel
/// delivery order matches sequence order, which keeps per-connection flush
/// positions monotonic.
pub(crate) struct EventPump {
    events: broadcast::Sender<Arc<OutboundFrame>>,
    next_seq: AtomicU64,
    send_guard: std::sync::Mutex<()>,
}

impl EventPump {
    pub(crate) fn new() -> Self {
        let (events, _) = broadcast::channel(4096);
        EventPump {
            events,
            next_seq: AtomicU64::new(0),
            send_guard: std::sync::Mutex::new(()),
        }
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<Arc<OutboundFrame>> {
        self.events.subscribe()
    }

    /// Stamp the frame with the next sequence and broadcast it.
    pub(crate) fn send(&self, mut frame: OutboundFrame) {
        let _guard = self.send_guard.lock().unwrap();
        frame.seq = self.next_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.events.send(Arc::new(frame));
    }

    /// The current broadcast sequence: a response written now must wait for
    /// every frame with a sequence up to this value to be flushed.
    pub(crate) fn current_seq(&self) -> u64 {
        self.next_seq.load(Ordering::SeqCst)
    }
}

/// One connection's outbound state: the framed writer plus the fan-out's
/// flush position. The TS worker writes session events synchronously while
/// a command runs, so its command response always follows them; the Rust
/// fan-out is a separate task, so response writes wait for the fan-out to
/// catch up to the sequence they observed (`wait_flushed`), restoring the
/// same ordering contract: events emitted during a command are written
/// before the command's response, never after it.
pub(crate) struct ConnectionSink {
    pub(crate) writer:
        Arc<tokio::sync::Mutex<Box<dyn pa_types::platform::transport::AsyncWriteHalf>>>,
    /// The fan-out's flush position; `FLUSH_CLOSED` once the fan-out ended.
    /// Watch semantics: a send with zero live receivers is dropped, so
    /// the sink keeps a permanent receiver and every position update is
    /// stored even while no response is waiting.
    flushed: tokio::sync::watch::Sender<u64>,
    _flushed_anchor: tokio::sync::watch::Receiver<u64>,
    /// The first broadcast sequence this connection's fan-out can receive:
    /// frames older than this were broadcast before the connection
    /// subscribed and are never delivered to it, so a gate below `entry_seq`
    /// is already satisfied.
    entry_seq: u64,
}

/// The fan-out either wrote every frame or the connection ended; a waiting
/// response proceeds on both paths.
const FLUSH_CLOSED: u64 = u64::MAX;

impl ConnectionSink {
    pub(crate) fn new(
        writer: Arc<tokio::sync::Mutex<Box<dyn pa_types::platform::transport::AsyncWriteHalf>>>,
        entry_seq: u64,
    ) -> Self {
        let (flushed, flushed_anchor) = tokio::sync::watch::channel(0);
        ConnectionSink {
            writer,
            flushed,
            _flushed_anchor: flushed_anchor,
            entry_seq,
        }
    }

    /// Record the fan-out's position after one processed frame (written or
    /// skipped for role reasons: a skipped frame cannot arrive later).
    pub(crate) fn mark_flushed(&self, seq: u64) {
        let _ = self.flushed.send(seq);
    }

    /// The fan-out ended (write failure or closed stream); waiting
    /// responses stop waiting.
    pub(crate) fn mark_closed(&self) {
        let _ = self.flushed.send(FLUSH_CLOSED);
    }

    /// Block until the fan-out flushed `gate` (or ended).
    pub(crate) async fn wait_flushed(&self, gate: u64) {
        // Frames older than `entry_seq` are never delivered to this
        // connection, so a gate below them needs no wait.
        if gate < self.entry_seq {
            return;
        }
        let mut rx = self.flushed.subscribe();
        loop {
            if *rx.borrow_and_update() >= gate {
                return;
            }
            if rx.changed().await.is_err() {
                return;
            }
        }
    }
}

/// Releases a connection's supervisor claim when the connection ends:
/// the supervisor-role connection on the worker's socket is the supervisor's
/// presence proof for the orphan-exit monitor, so its end must decrement
/// the claim count on every return path. Inspects the role at drop time —
/// only a connection that authenticated as the supervisor ever claimed.
struct SupervisorClaimRelease {
    role: Arc<std::sync::Mutex<crate::peer::ConnectionRole>>,
    claims: Arc<std::sync::atomic::AtomicUsize>,
}

/// The connection-scoped session-attach guard: its Drop releases the
/// connection's registry entry (every retained id, the anonymous
/// fallback included) and wakes the runner — on EVERY return path of
/// `handle_connection` (the clean EOF arm, the read errors, the
/// malformed/oversized frames, the failed auth), closing the fresh
/// bots' release gaps. A shared client id stays held while any other
/// live connection retains it (the reconnect shape).
struct SessionAttachGuard {
    worker: Arc<Worker>,
    token: String,
}

impl Drop for SessionAttachGuard {
    fn drop(&mut self) {
        self.worker.release_session_attachments(&self.token, true);
    }
}

impl Drop for SupervisorClaimRelease {
    fn drop(&mut self) {
        let supervisor = matches!(
            *self.role.lock().unwrap(),
            crate::peer::ConnectionRole::Supervisor { .. }
        );
        if supervisor {
            self.claims
                .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
}

impl Worker {
    /// Serve worker connections until the process is asked to shut down.
    ///
    /// # Errors
    ///
    /// Returns an error when the recovery journal cannot be opened, the
    /// socket path cannot be prepared, the worker socket cannot be
    /// bound, or an accept fails.
    ///
    /// # Panics
    ///
    /// Panics when the recovery mutex is poisoned (a holder panicked
    /// while holding it).
    pub async fn serve(self: Arc<Self>) -> Result<()> {
        *self.recovery.lock().unwrap() = Some(WorkerRecoveryJournal::open(
            &self.config.recovery_journal_path,
        )?);
        // A worker spawned under a supervisor arms the orphan-exit monitor
        // (TS `startSupervisorMonitor`): nobody else reaps it if the
        // supervisor dies without a graceful stop.
        if !self.config.supervisor_socket_path.as_os_str().is_empty() {
            crate::supervisor_lost::start(self.clone());
        }
        crate::socket::prepare_socket_path(&self.config.socket_path).await?;
        let listener = bind_transport(&self.config.socket_path)
            .await
            .with_context(|| format!("bind worker socket {}", self.config.socket_path.display()))?;
        // Capture the bound file's identity before anything can replace
        // it (TS daemon-mode.ts:718, the listen callback, between the
        // identity capture and `restrictDaemonSocketPath`): the exit
        // cleanups compare against THIS value, never a fresh read, so a
        // successor's file at the same path survives this worker's exit.
        *self.bound_socket_identity.lock().unwrap() =
            crate::socket::socket_identity(&self.config.socket_path);
        crate::socket::restrict_socket_path(&self.config.socket_path);
        loop {
            let stream = match listener.accept().await {
                Ok(accepted) => {
                    if std::env::var("PA_DAEMON_DEBUG").is_ok() {
                        eprintln!("[worker {}] accepted connection", std::process::id());
                    }
                    accepted
                }
                Err(error) => return Err(anyhow!("worker accept: {error}")),
            };
            let worker = Arc::clone(&self);
            tokio::spawn(async move {
                if let Err(error) = worker.handle_connection(stream).await {
                    eprintln!("pa-daemon worker connection error: {error:#}");
                }
            });
        }
    }

    async fn handle_connection(self: Arc<Self>, stream: Box<dyn TransportStream>) -> Result<()> {
        let (reader, writer) = stream.split();
        let writer = Arc::new(tokio::sync::Mutex::new(writer));
        // The connection's event subscription and its entry sequence are
        // captured together (before any awaited write): every frame the
        // receiver can see has a sequence at or above `entry_seq`, which is
        // what the sink's flush barrier gates on.
        let subscription = self.events.subscribe();
        let entry_seq = self.events.current_seq() + 1;
        // The connection's outbound sink: the framed writer plus the
        // fan-out flush position (response writes wait on it; see
        // `ConnectionSink`).
        let sink = Arc::new(ConnectionSink::new(Arc::clone(&writer), entry_seq));
        // daemon_hello goes out immediately on every connection. The
        // factory lane's advertisement gate reads the settings file
        // (metadata plus a locked read on a cache miss) — off the
        // executor thread, the same spawn_blocking posture as the
        // daemon's other settings reads, and the same fresh-per-connection
        // read the supervisor's hello does.
        let agent_dir = self.config.agent_dir.clone();
        let factory_capabilities =
            tokio::task::spawn_blocking(move || worker_server_capabilities(&agent_dir))
                .await
                .map_err(|error| anyhow::anyhow!("the factory settings read failed: {error:#}"))?;
        let hello = DaemonOutbound::DaemonHello {
            socket_path: self.config.socket_path.to_string_lossy().to_string(),
            protocol: current_protocol_info(),
            schema_id: Some(DAEMON_SCHEMA_ID.to_string()),
            schema_revision: Some(DAEMON_SCHEMA_REVISION),
            app_version: Some(DAEMON_APP_VERSION.to_string()),
            runtime: None,
            supervisor_generation: None,
            supervisor_pid: Some(u64::from(std::process::id())),
            supervisor_owner_token: None,
            supervisor_process_start_id: None,
            supervisor_socket_path: None,
            // The worker's hello carries no resume contract (the
            // supervisor owns the boot restore pass).
            update_resume: None,
            client_id: crate::util::new_display_id(),
            server_capabilities: factory_capabilities,
            rest: Map::default(),
        };
        let hello_bytes = serde_json::to_vec(&hello)?;
        // A supervisor liveness probe may connect and drop immediately; that
        // is not an error worth reporting (the peer simply went away first).
        if let Err(error) = self
            .write_frame(
                &writer,
                &json!({ "kind": "outbound", "outboundType": "daemon_hello" }),
                &hello_bytes,
            )
            .await
        {
            if std::env::var("PA_DAEMON_DEBUG").is_ok() {
                eprintln!(
                    "[worker {}] hello write failed: {error:#}",
                    std::process::id()
                );
            }
            return Ok(());
        }

        // The connection's authenticated role, shared with the event
        // fan-out task (streaming is gated on it).
        let role = Arc::new(std::sync::Mutex::new(ConnectionRole::Unauthenticated));

        // Releases the supervisor claim this connection may take (see
        // `SupervisorClaimRelease`): the claim's lifetime is the
        // connection's, so every return path (EOF, auth failure, frame
        // error) goes through the same decrement.
        let _claim_release = SupervisorClaimRelease {
            role: Arc::clone(&role),
            claims: Arc::clone(&self.supervisor_claims),
        };

        // Connection-closed signal: the read loop fires it when the peer is
        // gone (EOF, auth failure) or drops it on return. The fan-out task
        // must not outlive the connection - the shared-socket write half it
        // holds keeps the socket fd open, and a per-connection fd leak here
        // (probes, direct clients, peer deliveries) ends in EMFILE for a
        // long-lived worker.
        let (closed_tx, closed_rx) = tokio::sync::watch::channel(false);

        // Event fan-out: this connection's subscription to the shared pump.
        // Only authenticated roles stream: the supervisor always, a session
        // client only while it holds an attach on the session.
        {
            let worker = Arc::clone(&self);
            let sink = Arc::clone(&sink);
            let role = Arc::clone(&role);
            let mut closed = closed_rx;
            tokio::spawn(async move {
                let mut events = subscription;
                loop {
                    tokio::select! {
                        // The read loop ended (or dropped its sender):
                        // release the subscription and the write half so
                        // the socket fd closes.
                        changed = closed.changed() => {
                            let _ = changed;
                            sink.mark_closed();
                            break;
                        }
                        received = events.recv() => {
                            match received {
                                Ok(frame) => {
                                    // A frame this role does not stream still
                                    // advances the flush position: it cannot be
                                    // delivered later, so a gated response must not
                                    // wait for it.
                                    if role.lock().unwrap().streams_events() {
                                        let active_session_id = active_session_id_of(&frame.payload);
                                        let header = json!({
                                            "kind": "outbound",
                                            "outboundType": frame.outbound_type,
                                            "activeSessionId": active_session_id,
                                        });
                                        if worker
                                            .write_frame(&sink.writer, &header, &frame.payload)
                                            .await
                                            .is_err()
                                        {
                                            sink.mark_closed();
                                            break;
                                        }
                                    }
                                    sink.mark_flushed(frame.seq);
                                }
                                Err(broadcast::error::RecvError::Lagged(_)) => {}
                                Err(broadcast::error::RecvError::Closed) => {
                                    sink.mark_closed();
                                    break;
                                }
                            }
                        }
                    }
                }
            });
        }

        // The connection's attach-release guard (the fresh bots'
        // findings: the release must run on EVERY return path - the
        // clean EOF, the read errors, the malformed frames, the auth
        // failures - and it is connection-scoped, so a shared client id
        // survives a reconnect's first close). The guard's Drop releases
        // the token's registry entry + wakes the runner.
        let connection_token = crate::util::new_display_id();
        let _attach_release = SessionAttachGuard {
            worker: Arc::clone(&self),
            token: connection_token.clone(),
        };
        let mut reader =
            crate::framing::PrivateFrameReader::new(reader, DEFAULT_PRIVATE_FRAME_LIMITS);
        loop {
            let frame: Option<crate::framing::PrivateFrame> = reader.read_frame().await?;
            let Some(frame) = frame else {
                // Peer closed: wake the fan-out so it drops the write half.
                let _ = closed_tx.send(true);
                // The connection's session attaches release via the
                // guard's Drop (every return path - this EOF arm, the
                // read errors, the malformed frames, the auth failures:
                // the `?` exits drop the guard too).
                break;
            };
            let command_type = frame
                .header
                .get("commandType")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let request_id = frame
                .header
                .get("requestId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let mut payload: Value = serde_json::from_slice(&frame.payload)
                .with_context(|| format!("invalid worker command JSON for {command_type}"))?;
            if std::env::var("PA_DAEMON_DEBUG").is_ok() {
                eprintln!("[worker {}] got command {command_type}", std::process::id());
            }

            let current_role = role.lock().unwrap().clone();
            match current_role {
                ConnectionRole::Unauthenticated => {
                    // The first command authenticates the connection; a
                    // failed authentication ends it (TS worker branch).
                    let outcome = self
                        .authenticate_connection(&command_type, &payload, &request_id, &role, &sink)
                        .await;
                    if outcome == AuthOutcome::Failed {
                        // Failed auth ends the connection: wake the fan-out
                        // so it releases the write half (and the fd).
                        let _ = closed_tx.send(true);
                        break;
                    }
                }
                ConnectionRole::Supervisor { ref generation } => {
                    if command_type == "worker_register_peer_transport" {
                        let response =
                            self.handle_worker_register_peer_transport(&payload, generation);
                        self.write_response_frame(&sink, &request_id, response)
                            .await;
                        continue;
                    }
                    // Shutdown stays sequential: the reply must precede the
                    // exit. Every other command runs concurrently, like the
                    // TS daemon's async handlers: a long-running command (a
                    // turn, a compaction) must not block aborts or state
                    // reads from other clients.
                    if command_type == "shutdown" {
                        let response = self.dispatch(&command_type, &payload).await;
                        // The reply must precede the exit (the response is
                        // consumed by the write), so capture the outcome
                        // before handing the response over.
                        let success = response.success;
                        self.write_response_frame(&sink, &request_id, response)
                            .await;
                        if success {
                            self.exit_after_close();
                        }
                        continue;
                    }
                    let worker = Arc::clone(&self);
                    let sink = Arc::clone(&sink);
                    let request_id = request_id.clone();
                    let command_type = command_type.clone();
                    tokio::spawn(async move {
                        let response = worker.dispatch(&command_type, &payload).await;
                        worker
                            .write_response_frame(&sink, &request_id, response)
                            .await;
                    });
                }
                ConnectionRole::SessionClient { ref session } => {
                    // The connection token rides the attach/detach payloads
                    // (the registry keys this connection's retained ids
                    // by it; a failed attach's release is the idempotent
                    // no-op).
                    if matches!(command_type.as_str(), "attach" | "detach") {
                        if let Some(object) = payload.as_object_mut() {
                            object.insert("connectionToken".to_string(), json!(connection_token));
                        }
                    }
                    // A direct peer may only run session-plane commands for
                    // the grant's session (TS `peerClaims` gate).
                    if !peer_command_allowed(&command_type, &payload, &session.grant) {
                        let failure = response_failure(
                            Some(&request_id),
                            &command_type,
                            PEER_COMMAND_NOT_ALLOWED,
                            None,
                        );
                        self.write_response_frame(&sink, &request_id, failure).await;
                        continue;
                    }
                    // Session-plane commands run concurrently for the same
                    // reason as the supervisor arm above.
                    let worker = Arc::clone(&self);
                    let sink = Arc::clone(&sink);
                    let request_id = request_id.clone();
                    let command_type = command_type.clone();
                    let session = Arc::clone(session);
                    tokio::spawn(async move {
                        let response = worker.dispatch(&command_type, &payload).await;
                        // The attach/detach bookkeeping reads the outcome
                        // before the write consumes the response.
                        let success = response.success;
                        if success {
                            match command_type.as_str() {
                                "attach" => session.mark_attached(),
                                "detach" => session.mark_detached(),
                                _ => {}
                            }
                        }
                        worker
                            .write_response_frame(&sink, &request_id, response)
                            .await;
                    });
                }
                ConnectionRole::PeerWorker { ref session } => {
                    // A peer worker delivers agent messages only, for the
                    // grant's session; everything else bounces with the TS
                    // gate string.
                    if !worker_peer_command_allowed(&command_type, &payload, &session.grant) {
                        let failure = response_failure(
                            Some(&request_id),
                            &command_type,
                            PEER_COMMAND_NOT_ALLOWED,
                            None,
                        );
                        self.write_response_frame(&sink, &request_id, failure).await;
                        continue;
                    }
                    // Delivery runs concurrently, like the other planes.
                    let worker = Arc::clone(&self);
                    let sink = Arc::clone(&sink);
                    let request_id = request_id.clone();
                    let command_type = command_type.clone();
                    tokio::spawn(async move {
                        let response = worker.dispatch(&command_type, &payload).await;
                        worker
                            .write_response_frame(&sink, &request_id, response)
                            .await;
                    });
                }
            }
        }
        Ok(())
    }

    /// Authenticate one connection's first command: `worker_auth` promotes
    /// the connection to the supervisor role, `peer_auth` to a session
    /// client role holding a burned single-use grant. Writes the response.
    async fn authenticate_connection(
        self: &Arc<Self>,
        command_type: &str,
        payload: &Value,
        request_id: &str,
        role: &Arc<std::sync::Mutex<ConnectionRole>>,
        sink: &ConnectionSink,
    ) -> AuthOutcome {
        if command_type == "peer_auth" {
            return self.handle_peer_auth(payload, request_id, role, sink).await;
        }
        if command_type != "worker_auth" {
            let failure = response_failure(
                Some(request_id),
                "worker_auth",
                "Worker authentication failed",
                None,
            );
            self.write_response_frame(sink, request_id, failure).await;
            return AuthOutcome::Failed;
        }
        match self.authenticate(payload) {
            Ok(()) => {
                if std::env::var("PA_DAEMON_DEBUG").is_ok() {
                    eprintln!("[worker {}] auth ok", std::process::id());
                }
                let generation = payload
                    .get("supervisorGeneration")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                // The roster capability is always granted; the peer
                // transport capability rides on the worker instance
                // id, like the TS worker.
                let mut capabilities = vec!["agent_roster".to_string()];
                if !self.config.worker_instance_id.is_empty() {
                    capabilities.push("direct_peer_transport".to_string());
                }
                let success = response_success(
                    Some(request_id),
                    "worker_auth",
                    Some(json!({ "capabilities": capabilities })),
                );
                *role.lock().unwrap() = ConnectionRole::Supervisor { generation };
                self.supervisor_claims
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                self.write_response_frame(sink, request_id, success).await;
                AuthOutcome::Authenticated
            }
            Err(error) => {
                let failure =
                    response_failure(Some(request_id), "worker_auth", &error.to_string(), None);
                self.write_response_frame(sink, request_id, failure).await;
                AuthOutcome::Failed
            }
        }
    }

    fn authenticate(&self, payload: &Value) -> Result<()> {
        let token = payload
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or_default();
        // TS `worker_auth` validation: token, generation, pid, socket path are
        // mandatory; instance and process-start ids only checked when present.
        if token.is_empty() || token != self.config.token {
            return Err(anyhow!("Worker authentication failed"));
        }
        if payload
            .get("supervisorGeneration")
            .and_then(Value::as_str)
            .is_none()
        {
            return Err(anyhow!("Worker authentication failed"));
        }
        let pid = payload
            .get("supervisorPid")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if pid == 0 {
            return Err(anyhow!("Worker authentication failed"));
        }
        if payload
            .get("supervisorSocketPath")
            .and_then(Value::as_str)
            .is_none()
        {
            return Err(anyhow!("Worker authentication failed"));
        }
        if let Some(instance) = payload.get("workerInstanceId") {
            if !instance.is_null()
                && instance.as_str() != Some("")
                && instance.as_str().map(str::to_string)
                    != Some(self.config.worker_instance_id.clone())
            {
                return Err(anyhow!("Worker authentication failed"));
            }
        }
        Ok(())
    }

    pub(crate) async fn write_frame(
        &self,
        writer: &Arc<tokio::sync::Mutex<Box<dyn pa_types::platform::transport::AsyncWriteHalf>>>,
        header: &Value,
        payload: &[u8],
    ) -> Result<()> {
        let mut guard = writer.lock().await;
        write_frame(&mut *guard, header, payload, DEFAULT_PRIVATE_FRAME_LIMITS)
            .await
            .context("write private frame")
    }

    /// Write a frame whose payload skips the whole-frame re-buffer (see
    /// `write_frame_segments`); the response path serializes its payload
    /// once and hands it straight to the socket.
    pub(crate) async fn write_frame_segments(
        &self,
        writer: &Arc<tokio::sync::Mutex<Box<dyn pa_types::platform::transport::AsyncWriteHalf>>>,
        header: &Value,
        payload: &[u8],
    ) -> Result<()> {
        let mut guard = writer.lock().await;
        write_frame_segments(&mut *guard, header, payload, DEFAULT_PRIVATE_FRAME_LIMITS)
            .await
            .context("write private frame")
    }

    /// Write one command response. The response is CONSUMED: its trees and
    /// the serialized payload drop before the trim, so every transient the
    /// response path allocated returns to the OS in the phase that peaked
    /// (before, the response outlived the trim and its freed heap stayed
    /// in the arenas until the next large phase).
    pub(crate) async fn write_response_frame(
        &self,
        sink: &ConnectionSink,
        request_id: &str,
        response: DaemonResponse,
    ) {
        // Flush barrier: every event frame broadcast before this response
        // reaches the connection's writer first, so a command response
        // never overtakes the events its command emitted (the TS worker
        // gets this ordering for free from synchronous writes).
        sink.wait_flushed(self.events.current_seq()).await;
        let mut header = json!({
            "kind": "outbound",
            "requestId": request_id,
            "outboundType": "response",
        });
        // The attach family's response header carries the scalars the
        // supervisor's routed bookkeeping reads (success, the attach's
        // active session), so the response PAYLOAD can relay to the client
        // by bytes. The header is the worker socket's own routing frame;
        // direct-attach clients read it as a JSON object and ignore fields
        // they do not know.
        if matches!(response.command.as_str(), "attach" | "reattach") {
            header["ok"] = json!(response.success);
            if let Some(active_session_id) = response
                .data
                .as_ref()
                .and_then(|data| data.get("activeSessionId"))
                .and_then(Value::as_str)
            {
                header["activeSessionId"] = json!(active_session_id);
            }
        }
        // Serialize the line from the borrowed trees (no per-response
        // payload clone) and write the frame without re-buffering the
        // payload; the wire bytes are identical to the tree-built line.
        let payload = crate::protocol::response_line_bytes(&response);
        let payload_len = payload.len();
        if let Err(error) = self
            .write_frame_segments(&sink.writer, &header, &payload)
            .await
        {
            eprintln!("pa-daemon worker response write failed: {error:#}");
        }
        // A large frame (an attach snapshot, a full-history tree) carried
        // big transient Value trees; the frame is out and both the payload
        // bytes and the response's own trees are freed, so return their
        // freed heap to the OS instead of letting the arenas hold the
        // phase's peak for the process lifetime.
        drop(payload);
        drop(response);
        pa_types::memory_release::trim_freed_heap_if_large(payload_len);
    }
}

impl Worker {
    pub(crate) fn handle_attach(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("attach") {
            return response;
        }
        // Warm the context-tree cache at every (re)attach (the operators'
        // Esc agents-view round trip re-attaches): the background walk
        // fills the cache while the client rebuilds its view, so the
        // next `/context` finds it ready instead of walking the artifact
        // tree inline.
        self.poke_context_tree_refresh();
        let client_id = payload
            .get("clientId")
            .and_then(Value::as_str)
            .unwrap_or("anonymous")
            .to_string();
        let capabilities = payload
            .get("capabilities")
            .and_then(Value::as_array)
            .map_or_else(default_client_capabilities, |array| {
                normalize_client_capabilities(
                    &array
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>(),
                )
            });
        // The supervisor's routed attach carries the CLIENT's own normalized
        // capability set here (the supervisor forces slim for the
        // worker-facing behavior but the client result echoes the client's
        // set); a direct-attach client sends none and keeps the normalized
        // request set, exactly as before.
        let echoed_client_capabilities = payload
            .get("clientCapabilities")
            .and_then(Value::as_array)
            .map(|array| {
                array
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<String>>()
            });
        let resume_cursor = payload
            .get("resumeCursor")
            .cloned()
            .filter(|value| !value.is_null())
            .and_then(|value| serde_json::from_value::<DaemonResumeCursor>(value).ok());

        let mut core = self.core.lock().unwrap();
        // The connection-scoped registry (the fresh bots' release
        // findings): the attach's retention is keyed by the connection
        // token so the release on ANY return path (the guard's Drop)
        // removes exactly what this connection retained — a missing
        // clientId's `anonymous` fallback included. The core lock stays
        // held (the registry's lock nests inside it — the same order
        // the release path uses).
        //
        // The core retain rides the registration's verdict: a token the
        // guard already released (the close beat the detached handler)
        // must not recreate an unowned hold - the registry entry stays
        // empty, so nothing would ever release it and the idle
        // passivation's unattached gate closes forever. A routed attach
        // without a connection token (the supervisor's shape) owns its
        // lifecycle on the routed detach path, so its retain stands.
        let retained = match payload.get("connectionToken").and_then(Value::as_str) {
            Some(token) => self.register_session_attach(token, &client_id),
            None => true,
        };
        if retained && !core.attached_client_ids.iter().any(|id| id == &client_id) {
            core.attached_client_ids.push(client_id.clone());
        }
        let summary = self.summary_locked(&core);
        let mut messages: Vec<Value> = core
            .store
            .as_ref()
            .map(crate::session_store::SessionFile::messages)
            .unwrap_or_default();
        // The image-payload elision (the image-heavy session-open fix): a
        // client that advertised `elide_snapshot_images` reads the
        // transcript without the base64 payloads (their fallback-only
        // metadata rows travel in the marker); the client's own set is
        // the worker-facing `capabilities` here unless the supervisor's
        // routed attach carried the client's set in `clientCapabilities`.
        let client_capabilities = echoed_client_capabilities
            .clone()
            .unwrap_or_else(|| capabilities.clone());
        if crate::snapshot_stream::wants_image_elision(&client_capabilities) {
            crate::snapshot_stream::elide_snapshot_image_payloads(&mut messages);
        }
        let state = self.connection_state_locked(&core);
        let last_event_sequence = core.last_event_sequence;
        let generation = core.generation.clone();
        let active_session_id = core.active_session_id.clone();
        drop(core);
        let replay =
            create_daemon_replay_info(resume_cursor.as_ref(), last_event_sequence, &generation);
        let cursor = json!({ "generation": generation, "sequence": last_event_sequence });
        let summary_value = serde_json::to_value(&summary).unwrap_or(Value::Null);
        let state_value = serde_json::to_value(&state).unwrap_or(Value::Null);
        // The messages move into the snapshot once: the old `json!` build
        // deep-copied them here and moved the original into the non-slim
        // top level, holding two message trees per attach.
        let mut snapshot = json!({
            "activeSessionId": active_session_id,
            "summary": summary_value,
            "state": state_value,
            "messages": Value::Null,
            "lastEventSequence": last_event_sequence,
            "lastEventCursor": cursor,
            // RLM child roster; empty for top-level daemon sessions.
            "children": [],
        });
        snapshot["messages"] = Value::Array(messages);
        // Slim clients read summary/messages from the snapshot; duplicating
        // them at the top level would serialize the history twice per attach
        // (port of `createAttachResult`).
        let slim = capabilities.iter().any(|cap| cap == "slim_attach");
        // TS `createAttachResult` key order: protocol, activeSessionId,
        // state?, messages? (non-slim), snapshot, replay,
        // lastEventSequence, lastEventCursor, client. The JSON map
        // preserves insertion order (the wire byte order), so the
        // non-slim keys insert at their TS positions, not appended.
        let mut result = json!({
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "activeSessionId": active_session_id,
        });
        if !slim {
            result["state"] = summary_value;
            // The non-slim top-level duplication (same wire bytes as
            // before): one message tree lives in the snapshot, the
            // duplicate is cloned out of it.
            result["messages"] = snapshot["messages"].clone();
        }
        result["snapshot"] = snapshot;
        result["replay"] = json!(replay);
        result["lastEventSequence"] = json!(last_event_sequence);
        result["lastEventCursor"] = cursor;
        result["client"] = json!({
            "id": client_id,
            "capabilities": echoed_client_capabilities.unwrap_or(capabilities),
        });
        // Client-env adoption (TS `adoptClientEnv`): a pane opening an
        // env-less session (e.g. cron-created) hands its Herdr identity
        // to the reporter — adopt-if-absent, never overwrite: a session
        // that already reports for its creating pane keeps it, so
        // watchers must not send env at all (the client contract) and a
        // second pane cannot steal the identity mid-session.
        {
            let client_env: std::collections::BTreeMap<String, String> = payload
                .get("env")
                .cloned()
                .and_then(|env| serde_json::from_value(env).ok())
                .map(|env| crate::herdr::filter_client_env(&env))
                .unwrap_or_default();
            if let Some(config) = crate::herdr::HerdrConfig::from_env(&client_env) {
                let (active, session_ref, rlm_depth) = {
                    let core = self.core.lock().unwrap();
                    (core.busy, Worker::herdr_session_ref(&core), core.rlm_depth)
                };
                if rlm_depth == 0 {
                    // The adopt is check-and-install under ONE lock
                    // hold (no await inside): two concurrent attaches
                    // cannot both observe the slot disabled and each
                    // install a reporter — the loser would flip the
                    // pane with a stray report. The first attach wins,
                    // the second's is a no-op, and a watcher that sends
                    // no env never reaches here at all.
                    let mut slot = self.herdr.lock().unwrap();
                    if !slot.enabled() {
                        let generation = self
                            .herdr_generation
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                            + 1;
                        let reporter = crate::herdr::HerdrReporter::start(
                            config,
                            session_ref.clone(),
                            generation,
                            std::sync::Arc::clone(&self.herdr_generation),
                        );
                        reporter.session_started(active, session_ref);
                        *slot = reporter;
                    }
                }
            }
        }

        response_success(None, "attach", Some(result))
    }

    /// Register one connection's retained attach (the per-connection
    /// registry's insert arm; the connection token keys it - a shared
    /// client id across two connections is held by BOTH entries and the
    /// core keeps it until the last one releases). A token the guard
    /// already released is REJECTED (the round-8 bots' finding: the
    /// attach dispatch is detached, so the connection's close can beat
    /// the handler's registration - a late registration would recreate
    /// an unowned attachment that leaks the hold forever). The verdict
    /// rides back to the caller: the attach's CORE retain is taken only
    /// on an accepted registration (the interleave harness's residual
    /// finding - the round-8 belt closed the registry entry, but the
    /// ungated core push still leaked the id in `attached_client_ids`
    /// with no registry entry left to release it).
    pub(crate) fn register_session_attach(&self, token: &str, client_id: &str) -> bool {
        let mut attachments = self.session_attachments.lock().unwrap();
        if self.released_attach_tokens.lock().unwrap().contains(token) {
            return false;
        }
        let ids = attachments.entry(token.to_string()).or_default();
        if !ids.iter().any(|id| id == client_id) {
            ids.push(client_id.to_string());
        }
        true
    }

    /// Release one connection's retained attaches (the registry's
    /// release arm, run from the connection guard's Drop on every return
    /// path AND the explicit detach command): a shared id leaves the
    /// core only when no other live connection holds it.
    pub(crate) fn release_session_attachments(&self, token: &str, final_release: bool) {
        // `final_release` (the guard's Drop) marks the token dead - the
        // connection is gone, so a late registration from its detached
        // attach handler is rejected (the round-8 race belt, now
        // bounded: only FINAL releases enter the set, and the set caps
        // at 8192 - the round-9 bots' unbounded-growth finding). The
        // explicit DETACH is NOT final (the round-9 bots' finding: the
        // connection lives on - a later re-attach on the same
        // connection must re-register or the close would find no entry
        // and leak the hold).
        if final_release {
            let mut released = self.released_attach_tokens.lock().unwrap();
            // Clear before the insert: the token released right now is
            // the one most likely to race a late registration, so the
            // overflow must never forget it.
            if released.len() >= 8192 {
                released.clear();
            }
            released.insert(token.to_string());
        }
        let mut core = self.core.lock().unwrap();
        let ids = {
            // The attachments' lock nests INSIDE the core lock (the
            // same order the attach path uses).
            let mut attachments = self.session_attachments.lock().unwrap();
            attachments.remove(token).unwrap_or_default()
        };
        if ids.is_empty() {
            return;
        }
        for id in &ids {
            let held_elsewhere = self
                .session_attachments
                .lock()
                .unwrap()
                .values()
                .any(|other| other.iter().any(|entry| entry == id));
            if !held_elsewhere {
                core.attached_client_ids.retain(|entry| entry != id);
            }
        }
        drop(core);
        // The runner's park re-arms: the released hold opens the idle
        // passivation's unattached gate for a now-detached child.
        self.work_notify.notify_one();
    }

    pub(crate) fn handle_detach(&self, payload: &Value) -> DaemonResponse {
        let client_id = payload
            .get("clientId")
            .and_then(Value::as_str)
            .unwrap_or("anonymous")
            .to_string();
        self.side_questions.abort_for_client(&client_id);
        // The detaching client's input-pause leases go with the detach
        // (TS worker `detach` arm releases the client's pauses).
        self.release_input_pauses_for_detach(&client_id);
        // The connection-scoped release first (the token's entry drops
        // the id — the shared-id reconnect keeps its own hold); the
        // direct core retain below stays as the detach's own belt (the
        // explicit detach command is the connection's own intent).
        if let Some(token) = payload.get("connectionToken").and_then(Value::as_str) {
            self.release_session_attachments(token, false);
        }
        let mut core = self.core.lock().unwrap();
        // The belt is scoped (the fresh bots' sibling-hold finding): the
        // explicit detach removes the id only when no other live
        // connection still retains it (a reconnect sharing the client
        // id keeps its own hold - the same set-membership rule the
        // registry's release applies).
        let held_elsewhere = self
            .session_attachments
            .lock()
            .unwrap()
            .values()
            .any(|other| other.iter().any(|entry| entry == &client_id));
        if !held_elsewhere {
            core.attached_client_ids.retain(|id| id != &client_id);
        }
        drop(core);
        // The detach wake: the runner's park computed its idle-passivation
        // window while this client held the attach; the notify re-arms it
        // (a now-detached child's window opens for the threshold).
        self.work_notify.notify_one();
        response_success(None, "detach", None)
    }
}
