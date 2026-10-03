//! Client connections: the per-connection task - read loop, dispatch,
//! and the parsed-command execution surface.
use anyhow::anyhow;
use std::time::Duration;

use super::{
    broadcast, command_type_name, current_protocol_info, daemon_closing_shutdown_event,
    default_server_capabilities, input_admission_id, json, parse_supervisor_command_line,
    response_failure, response_line, response_success, salvage_command_type, salvage_id,
    subscribers, update_gate_refuses, util, Arc, AsyncBufReadExt, AsyncWriteExt, BufReader,
    ClientRouting, ClientTrust, DaemonCommand, DaemonOutbound, DaemonRuntimeIdentity,
    EnvelopeParseError, Map, Ordering, Outbound, Result, RouteAdmission, Supervisor,
    TransportStream, TypedCreateRejection, Value, DAEMON_APP_VERSION, DAEMON_SCHEMA_ID,
    DAEMON_SCHEMA_REVISION, ROUTE_TIMEOUT_MS, UPDATE_PREPARING_MESSAGE,
};

/// The outcome of one connection-line read. `Overflow` is the untrusted
/// bound: the peer sent more bytes without a newline than the line cap
/// allows, and the connection is destroyed instead of buffering without
/// limit (TS #2517's `maxLineLength`).
enum ConnectionLine {
    Line,
    Eof,
    Overflow,
}

/// Read the next newline-terminated line into `line`. Local (unix)
/// connections read without a bound - the socket file is already
/// owner-restricted local trust. Untrusted TCP connections read with the
/// per-line cap: bytes accumulate into `line_bytes` (raw, so a multi-byte
/// UTF-8 character split across TCP segments cannot corrupt the line),
/// and a line that outgrows the cap reports [`ConnectionLine::Overflow`]
/// without draining a peer's unbounded stream.
///
/// # Errors
///
/// Returns the reader's I/O error (the caller breaks the connection loop).
async fn read_connection_line(
    reader: &mut BufReader<Box<dyn pa_types::platform::transport::AsyncReadHalf>>,
    line: &mut String,
    line_bytes: &mut Vec<u8>,
    max: Option<usize>,
) -> std::io::Result<ConnectionLine> {
    let Some(max) = max else {
        let read = reader.read_line(line).await?;
        return Ok(if read == 0 {
            ConnectionLine::Eof
        } else {
            ConnectionLine::Line
        });
    };
    loop {
        let available = match reader.fill_buf().await {
            Ok(available) => available,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if available.is_empty() {
            return Ok(ConnectionLine::Eof);
        }
        let Some(newline) = available.iter().position(|byte| *byte == b'\n') else {
            if line_bytes.len() + available.len() > max {
                return Ok(ConnectionLine::Overflow);
            }
            line_bytes.extend_from_slice(available);
            let used = available.len();
            reader.consume(used);
            continue;
        };
        if line_bytes.len() + newline + 1 > max {
            return Ok(ConnectionLine::Overflow);
        }
        line_bytes.extend_from_slice(&available[..=newline]);
        let used = newline + 1;
        reader.consume(used);
        line.push_str(&String::from_utf8_lossy(line_bytes));
        // The next read starts a fresh line; the accumulated raw bytes
        // die with this one.
        line_bytes.clear();
        return Ok(ConnectionLine::Line);
    }
}

async fn write_line<W: AsyncWriteExt + Unpin>(writer: &mut W, value: &Value) -> Result<usize> {
    let mut line = serde_json::to_string(value)?;
    line.push('\n');
    let bytes = line.len();
    writer.write_all(line.as_bytes()).await?;
    writer.flush().await?;
    Ok(bytes)
}

/// Write one pre-serialized client line (the byte relay's raw form already
/// carries its trailing newline). Reports the written byte count like
/// [`write_line`].
async fn write_raw_line<W: AsyncWriteExt + Unpin>(writer: &mut W, line: &[u8]) -> Result<usize> {
    let bytes = line.len();
    writer.write_all(line).await?;
    writer.flush().await?;
    Ok(bytes)
}

pub(crate) fn client_command_payload(
    command: &DaemonCommand,
    client_id: &str,
) -> Result<(&'static str, Value)> {
    let type_name = command_type_name(command);
    let mut payload = serde_json::to_value(command)?;
    if let Some(object) = payload.as_object_mut() {
        object.insert("clientId".to_string(), json!(client_id));
        // The supervisor always attaches slim, like the TS supervisor's
        // `attachClient`: summary and messages travel inside the snapshot.
        // The client's OWN normalized capability set rides alongside as
        // `clientCapabilities`: the worker echoes it into the attach
        // result's `client.capabilities`, so the response the supervisor
        // relays by bytes already carries the echo the supervisor used to
        // patch into the parsed tree.
        if let DaemonCommand::Attach { capabilities, .. }
        | DaemonCommand::Reattach { capabilities, .. } = command
        {
            object.insert(
                "capabilities".to_string(),
                json!(["attach_snapshot", "event_sequence", "slim_attach"]),
            );
            object.insert(
                "clientCapabilities".to_string(),
                json!(crate::snapshot_stream::attach_client_capabilities(
                    capabilities.as_deref()
                )),
            );
        }
        // Create carries its fields under `config`; the worker reads them flat.
        if let Some(config) = object.remove("config") {
            if let Some(config) = config.as_object() {
                for (key, value) in config {
                    object.insert(key.clone(), value.clone());
                }
            }
        }
    }
    Ok((type_name, payload))
}

impl Supervisor {
    /// The authenticated idle window (TS #2517's
    /// `DAEMON_TCP_IDLE_TIMEOUT_MS`): the supervisor's pinned value when
    /// one is set, else the production constant.
    pub(crate) fn tcp_idle_timeout(&self) -> Duration {
        self.tcp_idle_timeout_budget
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .unwrap_or(crate::tcp::DAEMON_TCP_IDLE_TIMEOUT)
    }

    /// Test-only: pin this supervisor's TCP idle window so the deadline
    /// state machine's tests can exercise the idle expiry without
    /// sleeping the production 10 minutes.
    #[cfg(test)]
    pub(crate) fn pin_tcp_idle_timeout_for_tests(&self, timeout: Duration) {
        *self
            .tcp_idle_timeout_budget
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(timeout);
    }
}

impl Supervisor {
    pub(super) async fn handle_client(
        self: Arc<Self>,
        stream: Box<dyn TransportStream>,
        trust: ClientTrust,
    ) -> Result<()> {
        let (reader, mut writer) = stream.split();
        let client_id = util::new_display_id();
        // The untrusted admission deadline (TS #2517's review rounds):
        // an absolute pre-ready budget armed from ACCEPT - BEFORE the
        // greeting write - so a peer that accepts but never reads the
        // banner is still bounded by the budget (the write below, and
        // everything else, run inside it). The budget re-arms to the short
        // auth window at `daemon_hello` (the handshake write below), and
        // switches to the traffic-resetting idle window on the first
        // authenticated line. The deadline is an explicit timer, not a
        // socket timeout: a peer dribbling bytes without ever completing
        // a line must not renew its own admission window.
        let mut tcp_deadline_tx = None;
        let mut tcp_expired_rx = None;
        let mut tcp_authenticated = false;
        if let ClientTrust::Remote { .. } = trust {
            let (deadline_tx, deadline_rx) = tokio::sync::watch::channel(
                tokio::time::Instant::now() + crate::tcp::DAEMON_TCP_PRE_READY_TIMEOUT,
            );
            let (expired_tx, expired_rx) = tokio::sync::mpsc::channel::<()>(1);
            let watchdog = tokio::spawn(async move {
                let mut deadline_rx = deadline_rx;
                loop {
                    let deadline = *deadline_rx.borrow_and_update();
                    let changed = tokio::time::timeout_at(deadline, deadline_rx.changed()).await;
                    match changed {
                        Err(_expired) => {
                            let _ = expired_tx.send(()).await;
                            return;
                        }
                        Ok(Ok(())) => {}
                        Ok(Err(_)) => return,
                    }
                }
            });
            // The watchdog ends with its channel ends: this connection
            // dropping its deadline sender makes `changed()` error and the
            // task return (the TS `clearTimeout` on close). Dropping the
            // handle does not abort the spawned task.
            drop(watchdog);
            tcp_deadline_tx = Some(deadline_tx);
            tcp_expired_rx = Some(expired_rx);
        }

        // The connect greeting's trust split (TS #2517 `daemonHello`): a
        // TCP peer is untrusted until it authenticates, so it receives the
        // protocol banner only - the supervisor's ownership token, pid,
        // process start id, and local paths describe this machine's
        // local-trust domain and are useless to a remote client. Local
        // connections skip TCP auth entirely and keep the full identity.
        let hello = DaemonOutbound::DaemonHello {
            socket_path: match &trust {
                ClientTrust::Local => Some(self.options.socket_path.to_string_lossy().to_string()),
                ClientTrust::Remote { .. } => None,
            },
            protocol: current_protocol_info(),
            schema_id: Some(DAEMON_SCHEMA_ID.to_string()),
            schema_revision: Some(DAEMON_SCHEMA_REVISION),
            app_version: Some(DAEMON_APP_VERSION.to_string()),
            runtime: match &trust {
                ClientTrust::Local => Some(DaemonRuntimeIdentity {
                    build_id: concat!("pa-daemon-rs-", env!("CARGO_PKG_VERSION")).to_string(),
                    executable_path: std::env::current_exe()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    entrypoint_path: None,
                    launcher_path: None,
                }),
                ClientTrust::Remote { .. } => None,
            },
            supervisor_generation: match &trust {
                ClientTrust::Local => Some(format!("sup:{}", std::process::id())),
                ClientTrust::Remote { .. } => None,
            },
            supervisor_pid: match &trust {
                ClientTrust::Local => Some(u64::from(std::process::id())),
                ClientTrust::Remote { .. } => None,
            },
            supervisor_owner_token: match &trust {
                ClientTrust::Local => Some(uuid::Uuid::new_v4().to_string()),
                ClientTrust::Remote { .. } => None,
            },
            supervisor_process_start_id: match &trust {
                ClientTrust::Local => crate::protocol::process_start_id(std::process::id()),
                ClientTrust::Remote { .. } => None,
            },
            supervisor_socket_path: match &trust {
                ClientTrust::Local => Some(self.options.socket_path.to_string_lossy().to_string()),
                ClientTrust::Remote { .. } => None,
            },
            update_resume: match &trust {
                ClientTrust::Local => Some(self.restore.hello_resume()),
                ClientTrust::Remote { .. } => None,
            },
            client_id: client_id.clone(),
            server_capabilities: default_server_capabilities(),
            rest: Map::default(),
        };
        write_line(&mut writer, &serde_json::to_value(&hello)?).await?;
        // `daemon_hello` is written: the admission deadline re-arms to the
        // short auth window (TS #2517's review fix: the auth window runs
        // from the handshake, not from accept, so a pre-ready client is
        // not closed before it ever saw the greeting).
        if let Some(deadline_tx) = tcp_deadline_tx.as_ref() {
            if !tcp_authenticated {
                deadline_tx.send_replace(
                    tokio::time::Instant::now() + crate::tcp::DAEMON_TCP_AUTH_TIMEOUT,
                );
            }
        }
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        let mut events = self.events.subscribe();
        let connection_id = client_id.clone();
        // Session events ride this per-connection queue (the subscriber
        // registry resolves delivery at publish time, TS `handleWorkerFrame`
        // parity); broadcast-class events keep the ring above.
        let (targeted_tx, mut targeted_rx) = tokio::sync::mpsc::channel::<Arc<Value>>(
            crate::backpressure::TARGETED_EVENT_QUEUE_CAPACITY,
        );
        // Connection state shared with the per-command dispatch tasks: the
        // envelope-overridden client id and the attached-session handle
        // (attach/detach keep the registry and the session list consistent;
        // the registry insertion is the delivery boundary).
        let attached = subscribers::ClientSubscriptions::new(connection_id.clone(), targeted_tx);
        let effective_client_id: Arc<std::sync::Mutex<String>> =
            Arc::new(std::sync::Mutex::new(client_id.clone()));
        // Roster subscription flag shared with the per-command dispatch
        // tasks (`roster_subscribe` flips it; the event arm filters pushes).
        let roster_subscribed: Arc<std::sync::atomic::AtomicBool> =
            Arc::new(std::sync::atomic::AtomicBool::new(false));
        // Per-connection pause-lease state (wave b8): the connection id
        // lease keys embed, the detach epoch, and the detaching sessions.
        let connection = Arc::new(crate::input_pause_lease::ClientConnectionState::new());
        // Completed dispatches flow back through this channel so the loop
        // keeps writing: a long command (a turn, a compaction) must not
        // block this client's events or its other commands, like the TS
        // daemon's async command handlers. Bounded at
        // [`crate::backpressure::CLIENT_OUTBOUND_CAPACITY`]: a client that
        // reads nothing stalls only its own dispatch tasks once the queue
        // fills — memory stays bounded per connection — while every other
        // client and worker is unaffected.
        let (dispatch_tx, mut dispatch_rx) = tokio::sync::mpsc::channel::<(Vec<Outbound>, bool)>(
            crate::backpressure::CLIENT_OUTBOUND_CAPACITY,
        );
        // One dispatch slot per concurrent command. The read arm is armed
        // only while a slot is free — at the bound the loop stops reading
        // the client's socket (the client's own send buffer carries its
        // input: transport-level flow control instead of unbounded task
        // spawn), while the dispatch and event arms keep draining, so the
        // running tasks free their slots and the loop always re-arms the
        // reader. A spawned task holds its slot until its response bundle
        // has been handed to the queue, so a task parked on a full
        // outbound queue still counts against this connection's bound.
        let dispatch_slots = Arc::new(tokio::sync::Semaphore::new(
            crate::backpressure::CLIENT_DISPATCH_CONCURRENCY,
        ));
        let mut line_bytes: Vec<u8> = Vec::new();
        // Whether this connection has an admission deadline at all (untrusted
        // TCP only): a precomputed bool keeps the select arm's precondition
        // from borrowing the shared option the arm's future mutates.
        let tcp_admission_armed = tcp_expired_rx.is_some();
        // Whether the CURRENT iteration's wake moved bytes on the socket:
        // an inbound line, a dispatched response, or a delivered event.
        // Broadcast wakes the connection does not receive (and lagged-ring
        // notices) write nothing, so they must not renew the idle window
        // (TS #2517: `socket.setTimeout` counts only socket traffic; a
        // busy mesh's chatter must not keep a silent peer's cap slot
        // open past its idle window).
        let mut saw_socket_traffic = false;
        loop {
            line.clear();
            // An authenticated TCP socket's idle window resets on socket
            // traffic only (the pre-auth windows stay absolute - nothing
            // re-arms them, so a dribbling peer cannot renew its
            // admission).
            if let Some(deadline_tx) = tcp_deadline_tx.as_mut() {
                if tcp_authenticated && saw_socket_traffic {
                    deadline_tx.send_replace(tokio::time::Instant::now() + self.tcp_idle_timeout());
                }
            }
            saw_socket_traffic = false;
            tokio::select! {
                read = read_connection_line(&mut reader, &mut line, &mut line_bytes, trust.tcp_auth_token().map(|_| crate::tcp::DAEMON_TCP_MAX_LINE_CHARS)), if dispatch_slots.available_permits() > 0 => {
                    match read {
                        Err(_error) => break,
                        Ok(ConnectionLine::Overflow) => {
                            self.log_line(&format!(
                                "Refused TCP command line longer than {} chars; closing connection",
                                crate::tcp::DAEMON_TCP_MAX_LINE_CHARS
                            ));
                            return Err(anyhow!("TCP command line exceeded the length bound"));
                        }
                        Ok(ConnectionLine::Eof) => break,
                        Ok(ConnectionLine::Line) => {}
                    }
                    saw_socket_traffic = true;
                    let trimmed = line.trim().to_string();
                    if trimmed.is_empty() {
                        continue;
                    }
                    // The per-line auth gate for untrusted TCP peers (TS
                    // #2517 `authorizeDaemonTcpLine`): a refused line
                    // answers with a correlatable `tcp_auth_failed`
                    // failure naming the real command and the socket
                    // closes. The first authenticated line clears the
                    // admission deadline and switches to the idle window.
                    if let ClientTrust::Remote { auth_token } = &trust {
                        let verdict =
                            crate::tcp::check_daemon_tcp_line_auth(&trimmed, auth_token);
                        if !verdict.ok {
                            let failure = crate::supervisor::tcp::tcp_refusal_lines(&self, &verdict);
                            let _ = write_line(&mut writer, &failure).await;
                            return Err(anyhow!(
                                "TCP authentication failed ({}); closing connection",
                                verdict.reason
                            ));
                        }
                        if !tcp_authenticated {
                            tcp_authenticated = true;
                        }
                    }
                    // The arm's guard proved a slot free (this loop is
                    // the only slot acquirer, and slots only free while
                    // the loop is between iterations), so the non-blocking
                    // take always succeeds.
                    let dispatch_slot = Arc::clone(&dispatch_slots)
                        .try_acquire_owned()
                        .expect("the read arm's guard held a dispatch slot");
                    let supervisor = Arc::clone(&self);
                    let effective_client_id = Arc::clone(&effective_client_id);
                    let attached = Arc::clone(&attached);
                    let roster_subscribed = Arc::clone(&roster_subscribed);
                    let connection = Arc::clone(&connection);
                    let dispatch_tx = dispatch_tx.clone();
                    // The stream clone a mid-handler streaming command
                    // (list_saved_sessions) writes its progress frames
                    // through: the SAME channel the response later takes,
                    // so the frames stay strictly ordered ahead of it.
                    let stream_tx = dispatch_tx.clone();
                    let connection_id = connection_id.clone();
                    tokio::spawn(async move {
                        let (lines, stop) = supervisor
                            .dispatch_client(
                                &trimmed,
                                &effective_client_id,
                                &attached,
                                &roster_subscribed,
                                &connection,
                                &connection_id,
                                &stream_tx,
                            )
                            .await;
                        if dispatch_tx.send((lines, stop)).await.is_err() && stop {
                            // The initiating connection left before its response
                            // was selected. Only a terminal shutdown owns the
                            // descriptor-deleting stop pass; an update restart
                            // must leave its descriptors for the successor.
                            let is_shutdown_owner = supervisor
                                .shutdown_owner
                                .lock()
                                .unwrap()
                                .as_deref()
                                == Some(connection_id.as_str());
                            if is_shutdown_owner
                                && supervisor.shutting_down.load(Ordering::SeqCst)
                                && !supervisor.accept_exit.load(Ordering::SeqCst)
                            {
                                supervisor.ensure_shutdown_started().await;
                            }
                        }
                        // The slot frees only once the bundle is in the
                        // queue: a task parked on a full outbound queue
                        // still counts against this connection's bound.
                        drop(dispatch_slot);
                    });
                }
                dispatched = dispatch_rx.recv() => {
                    let Some((lines, stop)) = dispatched else { break };
                    for outbound in lines {
                        let written = match &outbound {
                            Outbound::Line(value) => write_line(&mut writer, value).await,
                            Outbound::Raw(line) => write_raw_line(&mut writer, line).await,
                        };
                        let bytes = match written {
                            Ok(bytes) => bytes,
                            Err(error) => {
                                // A failed response write must not strand the
                                // shutdown: the stop pass still has to run.
                                if stop {
                                    self.ensure_shutdown_started().await;
                                }
                                return Err(error);
                            }
                        };
                        // A large outbound response (a catalog scan's
                        // rows, a routed snapshot before the byte relay,
                        // any locally-built summary of a grown session)
                        // carried big transients - the Value tree of a
                        // Line, the shared payload bytes of a Raw - and
                        // the frame is out, so return the freed heap to
                        // the OS instead of letting the arenas hold the
                        // phase's peak for the daemon's lifetime (the
                        // #2872 phase-boundary guard, mirrored on the
                        // supervisor's write path).
                        drop(outbound);
                        pa_types::memory_release::trim_freed_heap_if_large(bytes);
                        saw_socket_traffic = true;
                    }
                    if stop {
                        // The initiating client's response and daemon_closing
                        // lines are flushed above; only now may the stop pass
                        // end the runtime. The accept loop stays up until
                        // begin_shutdown sets accept_exit, so worker stops
                        // cannot be cut short by another inbound connection.
                        self.ensure_shutdown_started().await;
                        break;
                    }
                }
                targeted = targeted_rx.recv() => {
                    // A session event routed by the subscriber registry at
                    // publish time: the delivery decision already ran, the
                    // frame only writes (the queue preserves per-session
                    // publish order).
                    if let Some(payload) = targeted {
                        saw_socket_traffic = true;
                        if let Err(error) = write_line(&mut writer, &payload).await {
                            // An event-write failure must not strand an
                            // accepted shutdown: if this connection owns
                            // the stop, it still starts the pass.
                            let is_shutdown_owner = self
                                .shutdown_owner
                                .lock()
                                .unwrap()
                                .as_deref()
                                == Some(connection_id.as_str());
                            if is_shutdown_owner
                                && self.shutting_down.load(Ordering::SeqCst)
                                && !self.accept_exit.load(Ordering::SeqCst)
                            {
                                self.ensure_shutdown_started().await;
                            }
                            return Err(error);
                        }
                    } else {
                        break;
                    }
                }
                expired = async { match tcp_expired_rx.as_mut() { Some(rx) => rx.recv().await, None => std::future::pending().await } }, if tcp_admission_armed => {
                    // The admission deadline fired: an unauthenticated
                    // TCP peer held its window without authenticating
                    // (dribbled partial lines renew nothing), or an
                    // authenticated one went silent past the idle window.
                    // Destroy the connection like the TS timers do.
                    let _ = expired;
                    if tcp_authenticated {
                        self.log_line("Closed idle TCP client connection");
                    } else {
                        self.log_line("Closed unauthenticated TCP client connection");
                    }
                    return Err(anyhow!("TCP admission deadline expired"));
                }
                event = events.recv() => {
                    match event {
                        Ok((routing, payload)) => {
                            let deliver = match &routing {
                                ClientRouting::Broadcast => true,
                                ClientRouting::BroadcastExcept {
                                    connection_id: excluded,
                                } => excluded.as_str() != connection_id.as_str(),
                                ClientRouting::RosterSubscribers => {
                                    roster_subscribed.load(std::sync::atomic::Ordering::SeqCst)
                                }
                            };
                            if deliver {
                                saw_socket_traffic = true;
                                if let Err(error) = write_line(&mut writer, &payload).await {
                                    // An event-write failure must not strand an
                                    // accepted shutdown: if this connection owns
                                    // the stop, it still starts the pass.
                                    let is_shutdown_owner = self
                                        .shutdown_owner
                                        .lock()
                                        .unwrap()
                                        .as_deref()
                                        == Some(connection_id.as_str());
                                    if is_shutdown_owner
                                        && self.shutting_down.load(Ordering::SeqCst)
                                        && !self.accept_exit.load(Ordering::SeqCst)
                                    {
                                        self.ensure_shutdown_started().await;
                                    }
                                    return Err(error);
                                }
                            }
                        }
                        // A lagged receiver means the shared event ring
                        // ([`crate::backpressure::EVENT_RING_CAPACITY`])
                        // dropped this many events for THIS connection:
                        // the loss itself is the broadcast's defined
                        // backpressure, but it must never stay invisible
                        // (finding 4a) — the daemon log records which
                        // client lost how much.
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            self.log_line(&format!(
                                "client {connection_id} lagged on the event ring: {skipped} events dropped"
                            ));
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
        // A shutdown command may have been accepted just before this client
        // disconnected (or its response write failed). Only the connection
        // that accepted the shutdown may run the stop pass from this
        // fallback: another client disconnecting in the response window
        // must not preempt the acknowledgement or turn an update restart
        // into a terminal descriptor sweep.
        let is_shutdown_owner =
            self.shutdown_owner.lock().unwrap().as_deref() == Some(connection_id.as_str());
        if is_shutdown_owner
            && self.shutting_down.load(Ordering::SeqCst)
            && !self.accept_exit.load(Ordering::SeqCst)
        {
            self.ensure_shutdown_started().await;
        }
        // Detach from every attached session on disconnect (a TUI exit does
        // not stop the session; the worker keeps running). The registry
        // entries go first — no session event may be enqueued for a
        // connection whose loop has exited — then the worker-side detach
        // routes run as before.
        attached.detach_all(&self.session_subscribers);
        let attached_sessions = attached.session_ids();
        for active_session_id in &attached_sessions {
            if let Ok(resident) = self.registry.resolve(active_session_id).await {
                let payload = json!({ "type": "detach", "clientId": effective_client_id.lock().unwrap().clone() });
                let _ = self
                    .route_command_typed(
                        &resident,
                        "detach",
                        payload,
                        ROUTE_TIMEOUT_MS,
                        RouteAdmission::SupervisorInternal,
                    )
                    .await;
            }
        }
        // The disconnect's pause-lease cleanup (TS socket `cleanup`):
        // in-flight acquisitions invalidate and every lease the
        // connection held releases on its worker. Every waiting prompt
        // admission cancels so its in-flight prompt fails with the TS
        // cancellation error.
        self.release_all_client_pauses(&connection).await;
        connection.prompt_admissions.cancel_all_waiting();
        Ok(())
    }
    /// Handle one client command line: returns outbound lines in order and
    /// whether this client connection should stop.
    // One more dispatch-context input than the lint's budget: the
    // per-connection stream sender rides the same context bundle
    // `execute_parsed_command` takes (its own allow below).
    #[allow(clippy::too_many_arguments)]
    async fn dispatch_client(
        self: &Arc<Self>,
        line: &str,
        effective_client_id: &Arc<std::sync::Mutex<String>>,
        attached: &Arc<crate::supervisor::subscribers::ClientSubscriptions>,
        roster_subscribed: &Arc<std::sync::atomic::AtomicBool>,
        connection: &Arc<crate::input_pause_lease::ClientConnectionState>,
        connection_id: &str,
        stream: &tokio::sync::mpsc::Sender<(Vec<Outbound>, bool)>,
    ) -> (Vec<Outbound>, bool) {
        let envelope = match parse_supervisor_command_line(line) {
            Ok(envelope) => envelope,
            Err(error) => {
                let id = salvage_id(line);
                // TS has two failure spellings: envelope/protocol failures
                // answer `command: "parse"` (`failure(salvageDaemonCommandId,
                // "parse", ...)`), while a known envelope holding an unknown
                // or malformed command type echoes that type
                // (`failure(command.id, command.type, ...)`).
                let salvaged_type = salvage_command_type(line);
                let type_name = if matches!(
                    error,
                    EnvelopeParseError::UnknownCommand(_) | EnvelopeParseError::Invalid(_)
                ) {
                    salvaged_type.as_deref().unwrap_or("parse")
                } else {
                    "parse"
                };
                return (
                    vec![Outbound::Line(response_line(&response_failure(
                        id.as_deref(),
                        type_name,
                        &error.to_string(),
                        None,
                    )))],
                    false,
                );
            }
        };
        let command_id = envelope.id.clone();
        // THE REQUEST'S OWN CLIENT ID, captured at parse time (the bots'
        // finding): `effective_client_id` is per-connection state a later
        // command on the same connection can overwrite while this
        // dispatch is still running, and the shutdown attribution must
        // name the client that SENT the shutdown, not whoever spoke next.
        // An envelope without a clientId rides the connection's sticky id.
        let request_client_id = envelope
            .client_id
            .clone()
            .unwrap_or_else(|| effective_client_id.lock().unwrap().clone());
        if let Some(client_id) = envelope.client_id.clone() {
            *effective_client_id.lock().unwrap() = client_id;
        }
        // The prompt-admission registration (wave b9, TS parse-time):
        // a prompt/prompt_and_wait carrying an admissionId reserves it
        // before dispatch; duplicates and empty ids answer the TS parse
        // errors with `command: "parse"`.
        if let Some(admission_id) = crate::prompt_admission::input_admission_id(&envelope.command) {
            let active_session_id = crate::protocol::command_active_session_id(&envelope.command)
                .unwrap_or_default()
                .to_string();
            if let Err(error) = connection
                .prompt_admissions
                .register(&active_session_id, admission_id)
            {
                return (
                    vec![Outbound::Line(response_line(&response_failure(
                        Some(&command_id),
                        "parse",
                        &error,
                        None,
                    )))],
                    false,
                );
            }
        }
        let type_name = command_type_name(&envelope.command).to_string();
        // Terminal shutdown admission gate: once the shutdown command has
        // flipped `shutting_down`, no later client command may reach a
        // worker (the stop pass may already be retiring it). The command
        // that started the shutdown passed this point before it set the
        // gate, so its own response path is unaffected.
        if self.shutting_down.load(Ordering::SeqCst) {
            return (
                vec![Outbound::Line(response_line(&response_failure(
                    Some(&command_id),
                    &type_name,
                    "Supervisor is shutting down",
                    None,
                )))],
                false,
            );
        }
        // Update-prepare watchdog on any later command (spec §5): a prepared
        // transaction whose marker expired returns the supervisor to Serving
        // before the command is served.
        if let Some(abort) = self.update_prepare.abort_if_expired(util::now_ms()) {
            self.finish_update_abort(&abort);
        }
        // Admission gate: mutating commands are refused while a prepare
        // transaction is active (TS "Daemon is preparing an update restart"),
        // except the drain commands during `Draining`. The transaction's own
        // drivers never reach the gate.
        let is_update_driver = matches!(
            &envelope.command,
            DaemonCommand::PrepareUpdateRestart { .. } | DaemonCommand::CommitUpdateRestart { .. }
        );
        if !is_update_driver {
            if let Some(state) = self.update_prepare.active_state() {
                if update_gate_refuses(state, &type_name) {
                    return (
                        vec![Outbound::Line(response_line(&response_failure(
                            Some(&command_id),
                            &type_name,
                            UPDATE_PREPARING_MESSAGE,
                            // TS #2391: the typed `update_restarting` info
                            // rides beside the unchanged plain message, so
                            // clients can recognize the normal transient
                            // state and wait through the restart.
                            Some(pa_types::daemon::DaemonErrorInfo::UpdateRestarting),
                        )))],
                        false,
                    );
                }
            }
        }
        // Mutating commands count against the prepare transaction's drain.
        let mutating =
            !is_update_driver && pa_types::daemon::is_daemon_mutating_command(&type_name);
        if mutating {
            self.mutation_drain.begin();
        }
        let outcome = self
            .execute_parsed_command(
                &envelope.command,
                effective_client_id,
                &request_client_id,
                attached,
                roster_subscribed,
                connection,
                connection_id,
                command_id,
                type_name,
                stream,
            )
            .await;
        if mutating {
            self.mutation_drain.end();
        }
        (
            outcome
                .0
                .into_iter()
                .map(Outbound::Line)
                .collect::<Vec<_>>(),
            outcome.1,
        )
    }
    /// The parsed-command match of [`Self::dispatch_client`], executed under
    /// the mutation-drain latch by that wrapper.
    #[allow(clippy::too_many_arguments)]
    async fn execute_parsed_command(
        self: &Arc<Self>,
        command: &DaemonCommand,
        effective_client_id: &Arc<std::sync::Mutex<String>>,
        request_client_id: &str,
        attached: &Arc<crate::supervisor::subscribers::ClientSubscriptions>,
        roster_subscribed: &Arc<std::sync::atomic::AtomicBool>,
        connection: &Arc<crate::input_pause_lease::ClientConnectionState>,
        connection_id: &str,
        command_id: String,
        type_name: String,
        stream: &tokio::sync::mpsc::Sender<(Vec<Outbound>, bool)>,
    ) -> (Vec<Value>, bool) {
        match command {
            DaemonCommand::AckResult { .. } => (Vec::new(), false),
            DaemonCommand::Restart { .. } | DaemonCommand::Shutdown { .. } => {
                // WHO asked (the twice-killed fleet's field diagnosis: a
                // stop seen from the outside was unattributable until the
                // wire was reconstructed): the request's client id and
                // command id land in the daemon log the moment the drain
                // commits, so the client that stopped the daemon - the
                // installer, an agent session, a person - is nameable
                // from the log alone. The id is the REQUEST's own (parse-
                // time capture, not the connection's mutable effective
                // id), and both values are newline-stripped: the log is
                // line-structured, and a client-chosen id carrying \n
                // must not forge attribution lines (the bots' finding).
                let logged_client = request_client_id.replace(['\n', '\r'], " ");
                let logged_command = command_id.replace(['\n', '\r'], " ");
                self.log_line(&format!(
                    "{type_name} requested by client {logged_client} (command {logged_command})"
                ));
                let response = response_success(Some(&command_id), &type_name, None);
                let mut lines = vec![response_line(&response)];
                // daemon_closing goes to every client before the exit.
                let closing = daemon_closing_shutdown_event();
                let _ = self.events.send((
                    ClientRouting::BroadcastExcept {
                        connection_id: connection_id.to_string(),
                    },
                    std::sync::Arc::new(closing.clone()),
                ));
                lines.push(closing);
                // Answer first, then shut down: the connection loop writes
                // these lines before it awaits begin_shutdown, so the client
                // always receives the response and daemon_closing before the
                // stop pass can end the process. The shutdown gate flips
                // synchronously here — before the response is written — so
                // no create dispatched after the shutdown can slip past it
                // and launch a worker the stop pass would miss.
                *self.shutdown_owner.lock().unwrap() = Some(connection_id.to_string());
                self.shutting_down.store(true, Ordering::SeqCst);
                (lines, true)
            }
            DaemonCommand::List {
                all,
                cwd,
                session_dir,
                include_remote_mesh,
                ..
            } => {
                let response = self
                    .handle_list(
                        command_id,
                        type_name,
                        *all,
                        cwd.clone(),
                        session_dir.clone(),
                        include_remote_mesh.unwrap_or(false),
                    )
                    .await;
                (vec![response_line(&response)], false)
            }
            DaemonCommand::ListSavedSessions { .. } => {
                let lines = self
                    .handle_saved_session_list(command, &command_id, stream)
                    .await;
                (lines, false)
            }
            DaemonCommand::RosterSubscribe { .. } => {
                roster_subscribed.store(true, std::sync::atomic::Ordering::SeqCst);
                let response = self.handle_roster_subscribe(&command_id, &type_name).await;
                (vec![response_line(&response)], false)
            }
            DaemonCommand::RosterUnsubscribe { .. } => {
                roster_subscribed.store(false, std::sync::atomic::Ordering::SeqCst);
                let response = Self::handle_roster_unsubscribe(&command_id, &type_name);
                (vec![response_line(&response)], false)
            }
            DaemonCommand::WorkerIdlePassivation {
                worker_token,
                idle_minutes,
                ..
            } => {
                let response = self
                    .handle_worker_idle_passivation(
                        &command_id,
                        &type_name,
                        worker_token,
                        *idle_minutes,
                    )
                    .await;
                (vec![response_line(&response)], false)
            }
            DaemonCommand::WorkerRosterDelta {
                worker_token,
                summary,
                removed,
                sequence,
                worker_instance_id,
                ..
            } => {
                let response = self
                    .handle_worker_roster_delta(
                        &command_id,
                        &type_name,
                        crate::supervisor_roster::WorkerRosterDelta {
                            worker_token: worker_token.clone(),
                            summary: summary.clone(),
                            removed: removed.clone().unwrap_or_default(),
                            sequence: *sequence,
                            worker_instance_id: worker_instance_id.clone(),
                        },
                    )
                    .await;
                (vec![response_line(&response)], false)
            }
            DaemonCommand::Create { .. } => {
                let client_id = effective_client_id.lock().unwrap().clone();
                match self.handle_create(command, client_id).await {
                    Ok(summary) => (
                        vec![response_line(&response_success(
                            Some(&command_id),
                            &type_name,
                            Some(summary),
                        ))],
                        false,
                    ),
                    Err(error) => {
                        // A typed worker rejection carries its wire info to
                        // the client (the TS `serializeDaemonError` shape);
                        // untyped failures stay the bare string.
                        let (message, error_info) =
                            match error.downcast_ref::<TypedCreateRejection>() {
                                Some(rejection) => (
                                    rejection.message.clone(),
                                    Some(rejection.error_info.clone()),
                                ),
                                None => (error.to_string(), None),
                            };
                        (
                            vec![response_line(&response_failure(
                                Some(&command_id),
                                &type_name,
                                &message,
                                error_info,
                            ))],
                            false,
                        )
                    }
                }
            }
            DaemonCommand::GetDirectWorkerTransport {
                active_session_id, ..
            } => {
                // Direct-attach ticket: the supervisor issues a single-use
                // grant for a registered session and hands the client the
                // worker's own socket; it stays out of the streaming path.
                let response = self
                    .handle_get_direct_worker_transport(&command_id, &type_name, active_session_id)
                    .await;
                (vec![response_line(&response)], false)
            }
            DaemonCommand::SendMessage { .. } => {
                let client_id = effective_client_id.lock().unwrap().clone();
                let response = self
                    .handle_send_message(&command_id, &client_id, command)
                    .await;
                (vec![response_line(&response)], false)
            }
            DaemonCommand::GetWorkerPeerTransport {
                worker_token,
                target_active_session_id,
                ..
            } => {
                // Worker-to-worker peer ticket: a single-use `worker`
                // grant pushed into the target worker's memory, so the
                // delivery itself bypasses this route plane.
                let response = self
                    .handle_get_worker_peer_transport(
                        &command_id,
                        &type_name,
                        worker_token,
                        target_active_session_id,
                    )
                    .await;
                (vec![response_line(&response)], false)
            }
            DaemonCommand::WorkerRegister { .. } => {
                // Worker self-registration: rebuilds the roster entry from
                // the worker's own identity instead of routing to a session.
                let response = self
                    .handle_worker_register(&command_id, &type_name, command)
                    .await;
                (vec![response_line(&response)], false)
            }
            DaemonCommand::CommitUpdateRestart { .. } => {
                // The coordinator's commit (spec §5 `Prepared -> Stopping`):
                // consume the prepared transaction, stop the workers
                // gracefully in budget, and either exit for the update or
                // abandon it (sessions untouched).
                self.handle_commit_update_restart(&command_id, &type_name, command)
                    .await
            }
            DaemonCommand::PrepareUpdateRestart { .. } => {
                // The update-flow coordinator's prepare RPC: accepts (or
                // idempotently polls) the supervisor-side prepare
                // transaction (spec §5). Slice 2 drives it to `Fenced` -
                // the worker snapshot that fills the roster and reaches
                // `Prepared` is the graceful-stop slice.
                let response = self
                    .handle_prepare_update_restart(&command_id, &type_name, command)
                    .await;
                (vec![response_line(&response)], false)
            }
            DaemonCommand::UpdateRestoreStatus { .. } => {
                // The boot restore pass's live snapshot (spec §6/§9): the
                // successor coordinator's `Restoring` report polls this
                // for real counts and per-session failures instead of
                // inferring adoption from the session list.
                let data = self.restore_status_body();
                (
                    vec![response_line(&response_success(
                        Some(&command_id),
                        &type_name,
                        Some(data),
                    ))],
                    false,
                )
            }
            DaemonCommand::Prompt {
                active_session_id, ..
            }
            | DaemonCommand::PromptAndWait {
                active_session_id, ..
            } if input_admission_id(command).is_some_and(|id| !id.is_empty()) => {
                // An admitted prompt (wave b9): the cancellation checks,
                // the admission-id rewrite, and the owned commit around
                // the routed prompt.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.route_prompt_with_admission(
                    connection,
                    command,
                    &client_id,
                    attached,
                    command_id,
                    type_name,
                    active_session_id,
                )
                .await
            }
            DaemonCommand::CancelPromptAdmission { .. } => {
                // `cancel_prompt_admission` (wave b9): the supervisor's
                // status ladder over the admission registry.
                self.handle_cancel_prompt_admission(connection, command, &command_id, &type_name)
                    .await
            }
            DaemonCommand::CompleteOwnedSession { .. } => {
                // Wave b9: the owner stops its session worker (TS
                // supervisor arm).
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_complete_owned_session(command, &client_id, &command_id, &type_name)
                    .await
            }
            DaemonCommand::PromoteOwnedSession { .. } => {
                // Wave b9: the owner clears the ownership (TS
                // `promoteOwnedWorker`).
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_promote_owned_session(command, &client_id, &command_id, &type_name)
                    .await
            }
            DaemonCommand::RetryWorker { .. } => {
                // Wave b9 (the audit's retry_worker fix): the recovery is
                // a supervisor arm - the worker never sees the command.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_retry_worker(command, &client_id, &command_id, &type_name)
                    .await
            }
            DaemonCommand::AbortCompaction { .. } => {
                // The abort supervision: the supervisor answers the abort
                // itself. The TS daemon-mode `abortCompaction` is an
                // in-process call that always replies instantly; a wedged
                // worker must not turn the abort into its own 30s route
                // timeout and a loader that never clears.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_abort_compaction(command, &client_id, attached, &command_id, &type_name)
                    .await
            }
            DaemonCommand::AcquireSessionInputPause { .. } => {
                // The supervisor-owned lease path (wave b8, TS supervisor
                // arm): resolve, rewrite the lease key, forward, record.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_acquire_session_input_pause(
                    connection,
                    command,
                    &client_id,
                    &command_id,
                    &type_name,
                )
                .await
            }
            DaemonCommand::ReleaseSessionInputPause { .. } => {
                // The supervisor-owned release (wave b8): the TS outcome
                // ladder over the lease table.
                self.handle_release_session_input_pause(
                    connection,
                    command,
                    &command_id,
                    &type_name,
                )
                .await
            }
            DaemonCommand::Detach {
                active_session_id, ..
            } => {
                // Detach carries the pause-lease bookkeeping (wave b8):
                // mark the detaching sessions and bump the epoch BEFORE the
                // routed detach, then release the client's leases for the
                // marked sessions once it answered (TS supervisor detach
                // arm ordering).
                let client_id = effective_client_id.lock().unwrap().clone();
                let attached_ids = attached.session_ids();
                let marked = Self::begin_detach_pause_bookkeeping(
                    connection,
                    active_session_id.as_deref(),
                    &attached_ids,
                );
                let outcome = self
                    .route_client_command(
                        command,
                        &client_id,
                        attached,
                        command_id.clone(),
                        type_name.clone(),
                        Some(stream),
                    )
                    .await;
                // A selector that resolves to nothing detaches nothing and
                // still answers success (TS `detachClient` no-ops an id
                // the client was never attached to).
                if outcome.0.first().is_some_and(|line| {
                    line.get("success").and_then(Value::as_bool) == Some(false)
                        && line
                            .get("error")
                            .and_then(Value::as_str)
                            .is_some_and(|error| error.starts_with("Unknown active session:"))
                }) {
                    return (
                        vec![response_line(&response_success(
                            Some(&command_id),
                            &type_name,
                            None,
                        ))],
                        false,
                    );
                }
                let succeeded = outcome
                    .0
                    .first()
                    .is_some_and(|line| line.get("success").and_then(Value::as_bool) == Some(true));
                if succeeded {
                    self.release_client_pauses_for_sessions(connection, &marked)
                        .await;
                }
                outcome
            }
            DaemonCommand::Reattach {
                active_session_id,
                target_active_session_id,
                ..
            } => {
                // Reattach clears the detach marks for the reattached
                // sessions (TS reattach arm): a reattached session may
                // acquire pauses again. The route itself stays the
                // generic one (streamed attach included).
                let client_id = effective_client_id.lock().unwrap().clone();
                let outcome = self
                    .route_client_command(
                        command,
                        &client_id,
                        attached,
                        command_id,
                        type_name,
                        Some(stream),
                    )
                    .await;
                let mut cleared = vec![active_session_id.clone(), target_active_session_id.clone()];
                if let Ok(resident) = self.registry.resolve(target_active_session_id).await {
                    cleared.push(resident.worker_id.clone());
                }
                Self::clear_detaching_after_reattach(connection, &cleared);
                outcome
            }
            DaemonCommand::AgentMessagesStatus {
                active_session_id, ..
            } if active_session_id.is_none() => {
                // Selector-less `agent_messages_status` (TS supervisor
                // arm): the first live worker answers, else the TS
                // empty-status object.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_agent_messages_status_broadcast(
                    command,
                    &client_id,
                    &command_id,
                    &type_name,
                )
                .await
            }
            DaemonCommand::ListAgentPeers { .. } => {
                // `list_agent_peers` (wave b11, TS supervisor arm): the
                // worker-token-authenticated peer roster.
                self.handle_list_agent_peers(command, &command_id, &type_name)
                    .await
            }
            DaemonCommand::RenameSavedSession { .. } => {
                // `rename_saved_session` (wave b11): the reservation ladder
                // plus the offline catalog rename or the worker forward.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_rename_saved_session(
                    command,
                    &client_id,
                    attached,
                    &command_id,
                    &type_name,
                )
                .await
            }
            DaemonCommand::DeleteSavedSession {
                active_session_id, ..
            } if active_session_id.is_none() => {
                // Selector-less `delete_saved_session` (wave b11): the
                // supervisor's catalog delete (a selector routes to the
                // owning worker's arm).
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_delete_saved_session(command, &client_id, &command_id, &type_name)
                    .await
            }
            DaemonCommand::CronList {
                active_session_id, ..
            } if active_session_id.is_none() => {
                // Selector-less `cron_list` (wave b10, TS supervisor arm):
                // merge the live workers' jobs with the passive ones.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_cron_list_catalog(command, &client_id, &command_id, &type_name)
                    .await
            }
            DaemonCommand::HeartbeatsList {
                active_session_id, ..
            } if active_session_id.is_none() => {
                // Selector-less `heartbeats_list` (wave b10): the merged
                // heartbeat catalog.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_heartbeats_list_catalog(command, &client_id, &command_id, &type_name)
                    .await
            }
            DaemonCommand::CronCancel {
                active_session_id, ..
            } if active_session_id.is_none() => {
                // Selector-less `cron_cancel` (wave b10): the owner-worker
                // search, then the passive store, then the TS error.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_cron_cancel_catalog(command, &client_id, &command_id, &type_name)
                    .await
            }
            DaemonCommand::HeartbeatManage { .. } => {
                // `heartbeat_manage` (wave b10, TS supervisor arm): passive
                // jobs are managed against their durable store, live ones
                // route to their worker.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_heartbeat_manage_catalog(
                    command,
                    &client_id,
                    attached,
                    &command_id,
                    &type_name,
                )
                .await
            }
            DaemonCommand::CronAdd { .. } => {
                // `cron_add` (wave b10): the routed add plus the
                // ownership promotion the command may ask for.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_cron_add_catalog(command, &client_id, attached, &command_id, &type_name)
                    .await
            }
            DaemonCommand::HeartbeatSet { .. } => {
                // `heartbeat_set` (wave b10): the same
                // forward-and-promote path as `cron_add`.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_heartbeat_set_catalog(
                    command,
                    &client_id,
                    attached,
                    &command_id,
                    &type_name,
                )
                .await
            }
            DaemonCommand::AgentMessagesPause {
                active_session_id, ..
            }
            | DaemonCommand::AgentMessagesResume {
                active_session_id, ..
            } if active_session_id.is_none() => {
                // Selector-less pause/resume (TS supervisor arm): the
                // broadcast to every live worker.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_agent_messages_pause_resume_broadcast(
                    command,
                    &client_id,
                    &command_id,
                    &type_name,
                )
                .await
            }
            command => {
                let client_id = effective_client_id.lock().unwrap().clone();
                self.route_client_command(
                    command,
                    &client_id,
                    attached,
                    command_id,
                    type_name,
                    Some(stream),
                )
                .await
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    #[cfg(unix)]
    use super::*;
    #[cfg(unix)]
    use crate::supervisor::SupervisorOptions;
    #[cfg(unix)]
    use pa_types::platform::transport::TransportStream;
    #[cfg(unix)]
    use serde_json::json;
    #[cfg(unix)]
    use std::sync::Arc;
    use std::time::Duration;

    /// A shutdown or restart request is attributable from the daemon log
    /// alone (the field diagnosis's ask: the stop that killed the fleet
    /// twice was unattributable until the wire was reconstructed): the
    /// request's client id and command id land in the log the moment the
    /// drain commits. Drives a real connection loop (`handle_client`)
    /// with the installer probe's own envelope shape.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_shutdown_request_logs_its_client() {
        let dir = tempfile::TempDir::new().unwrap();
        let options = SupervisorOptions {
            tcp_port: None,
            tcp_bind_host: None,
            remote_agent_mesh: None,
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        };
        let log_path = crate::paths::daemon_log_path(&options.socket_path, &options.agent_dir);
        let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
        let (server_side, client_side) = tokio::net::UnixStream::pair().expect("socket pair");
        let connection = {
            let supervisor = Arc::clone(&supervisor);
            let stream: Box<dyn TransportStream> = Box::new(server_side);
            tokio::spawn(async move {
                supervisor
                    .handle_client(stream, crate::supervisor::ClientTrust::Local)
                    .await
            })
        };
        // The greeting arrives before the loop reads: consume it, then send
        // the installer probe's exact envelope shape (clientId + command
        // id riding the protocol-7 envelope).
        let (client_read, mut client_write) = client_side.into_split();
        let mut client = BufReader::new(client_read);
        let mut hello = String::new();
        client.read_line(&mut hello).await.expect("hello line");
        assert!(
            hello.contains("\"type\":\"daemon_hello\""),
            "the greeting: {hello}"
        );
        let envelope = json!({
            "type": "command",
            "id": "installer-stop",
            "protocol": {"name": "prime-agent.daemon", "version": 7},
            "clientId": "install-rust-sh",
            "command": {"type": "shutdown", "force": true, "id": "installer-stop"},
        });
        client_write
            .write_all((serde_json::to_string(&envelope).unwrap() + "\n").as_bytes())
            .await
            .expect("send the shutdown envelope");
        // The drain commits synchronously with the log line (the gate
        // flips before the response is even written), so the log is the
        // wait point; the response and daemon_closing follow on their own
        // schedule.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let log = loop {
            let log = std::fs::read_to_string(&log_path).unwrap_or_default();
            if log.contains("shutdown requested by client") {
                break log;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the shutdown request was never logged; log: {log}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        assert!(
            log.contains("shutdown requested by client install-rust-sh (command installer-stop)"),
            "the log names the requesting client and its command: {log}"
        );
        connection.abort();
    }

    /// A client that falls behind the shared event ring loses events (the
    /// broadcast's defined backpressure), but never silently anymore
    /// (finding 4a): the loss becomes a durable daemon-log line naming the
    /// client and the dropped count. Drives a real connection loop
    /// (`handle_client`) over a real socket pair with a flooded ring.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_lagged_client_event_stream_is_logged() {
        use tokio::io::AsyncReadExt as _;
        let dir = tempfile::TempDir::new().unwrap();
        let options = SupervisorOptions {
            tcp_port: None,
            tcp_bind_host: None,
            remote_agent_mesh: None,
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        };
        let log_path = crate::paths::daemon_log_path(&options.socket_path, &options.agent_dir);
        let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
        let (server_side, client_side) = tokio::net::UnixStream::pair().expect("socket pair");
        // The test's client only reads; its write half stays held so the
        // connection's writes fail only when the test ends.
        let (client_read, _client_write) = client_side.into_split();
        let connection = {
            let supervisor = Arc::clone(&supervisor);
            let stream: Box<dyn TransportStream> = Box::new(server_side);
            tokio::spawn(async move {
                supervisor
                    .handle_client(stream, crate::supervisor::ClientTrust::Local)
                    .await
            })
        };
        // The handshake greeting arrives before the loop's first poll.
        let mut client = BufReader::new(client_read);
        let mut hello = String::new();
        client.read_line(&mut hello).await.expect("hello line");
        assert!(
            hello.contains("\"type\":\"daemon_hello\""),
            "the greeting: {hello}"
        );
        // The greeting is written BEFORE the loop subscribes to the
        // event ring, so the flood must wait for the subscription to
        // exist — sends into a receiver-less ring are dropped.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while supervisor.events.receiver_count() == 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "the connection loop never subscribed"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // Flood the ring well past its capacity with frames too big for
        // the client's socket buffer: the connection loop parks in its
        // event write, its receiver falls out of the ring's live window,
        // and the parked write only completes once the drain frees the
        // buffer again.
        let capacity = crate::backpressure::EVENT_RING_CAPACITY;
        let padding = "x".repeat(2048);
        let flood = capacity + 2048;
        for index in 0..flood {
            let _ = supervisor.events.send((
                ClientRouting::Broadcast,
                std::sync::Arc::new(json!({
                    "type": "session_event", "index": index, "padding": padding
                })),
            ));
        }
        // Drain the parked connection while watching for the log line: the
        // loop unparks as the reader frees the socket buffer, its next
        // event read reports the dropped span, and the loss lands in the
        // daemon log. The quiet counter only bounds an idle connection,
        // never a live one (a slow runner may pace the backlog, so the
        // drain continues as long as the log line has not landed).
        let mut buffer = vec![0u8; 64 * 1024];
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let log = loop {
            let log = std::fs::read_to_string(&log_path).unwrap_or_default();
            if log.contains("lagged on the event ring") {
                break log;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the lagged drain was never logged; log: {log}"
            );
            match tokio::time::timeout(Duration::from_millis(150), client.read(&mut buffer)).await {
                Ok(Ok(_) | Err(_)) => {}
                Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
            }
        };
        let line = log
            .lines()
            .rev()
            .find(|line| line.contains("lagged on the event ring"))
            .expect("the lag line");
        assert!(
            line.contains("events dropped"),
            "the log names the dropped count: {line}"
        );
        connection.abort();
    }
}
