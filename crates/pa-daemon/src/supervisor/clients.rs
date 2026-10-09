//! Client connections: the per-connection task - read loop, dispatch,
//! and the parsed-command execution surface.
use anyhow::anyhow;
use std::time::Duration;

use super::{
    app_version, broadcast, command_type_name, current_protocol_info,
    daemon_closing_shutdown_event, input_admission_id, json, parse_supervisor_command_line,
    response_failure, response_line, response_success, salvage_command_type, salvage_id,
    subscribers, update_gate_refuses, util, Arc, AsyncBufReadExt, AsyncWriteExt, BufReader,
    ClientRouting, ClientTrust, DaemonCommand, DaemonOutbound, DaemonRuntimeIdentity,
    EnvelopeParseError, Map, Ordering, Outbound, ResidentWorker, Result, RouteAdmission,
    Supervisor, TransportStream, TypedCreateRejection, Value, DAEMON_SCHEMA_ID,
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

/// TS `OWNED_WORKER_DISCONNECT_GRACE_MS`: how long a client-owned worker
/// keeps running after its owner's last connection closes.
const OWNED_WORKER_DISCONNECT_GRACE: Duration = Duration::from_secs(30);

async fn write_line<W: AsyncWriteExt + Unpin>(writer: &mut W, value: &Value) -> Result<usize> {
    let mut line = serde_json::to_string(value)?;
    line.push('\n');
    let bytes = line.len();
    writer.write_all(line.as_bytes()).await?;
    writer.flush().await?;
    Ok(bytes)
}

/// Write one pre-serialized client line (the byte relay's raw form
/// already carries its trailing newline).
async fn write_raw_line<W: AsyncWriteExt + Unpin>(writer: &mut W, line: &[u8]) -> Result<usize> {
    let bytes = line.len();
    writer.write_all(line).await?;
    writer.flush().await?;
    Ok(bytes)
}

/// One client write bounded by the connection's scheduled admission
/// deadline - the same watch value the expiry watchdog arms (the
/// pre-ready budget, the auth window, or the traffic-renewed idle
/// window). A remote peer that stops reading parks `write_all` in flow
/// control, and the select loop never returns to the expired arm while a
/// write waits, so the deadline must cut the parked write itself: a
/// stalled authenticated peer otherwise pins its
/// `DAEMON_TCP_MAX_CONNECTIONS` slot past every window. Local
/// connections carry no deadline: their writes pass through unbounded,
/// exactly as before.
async fn deadline_write<F>(deadline: Option<tokio::time::Instant>, write: F) -> Result<usize>
where
    F: std::future::Future<Output = Result<usize>>,
{
    let Some(deadline) = deadline else {
        return write.await;
    };
    match tokio::time::timeout_at(deadline, write).await {
        Ok(written) => written,
        Err(_stalled) => Err(anyhow!(
            "TCP admission deadline expired while a client write was stalled"
        )),
    }
}

pub(crate) fn client_command_payload(
    command: &DaemonCommand,
    client_id: &str,
) -> Result<(&'static str, Value)> {
    let type_name = command_type_name(command);
    let mut payload = serde_json::to_value(command)?;
    if let Some(object) = payload.as_object_mut() {
        object.insert("clientId".to_string(), json!(client_id));
        // The supervisor always attaches slim; the client's OWN capability set rides
        // alongside as `clientCapabilities`, which the worker echoes into the attach result.
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

    /// The unauthenticated pre-ready admission budget: a pinned test
    /// budget, else the production constant.
    pub(crate) fn tcp_pre_ready_timeout(&self) -> Duration {
        self.tcp_pre_ready_budget
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .unwrap_or(crate::tcp::DAEMON_TCP_PRE_READY_TIMEOUT)
    }

    /// Test-only: pin this supervisor's pre-ready admission budget so
    /// the deadline state machine's tests can fire the budget without
    /// waiting the production 120 seconds. Unix only: its caller is
    /// the unix-gated stale-signal oracle.
    #[cfg(all(test, unix))]
    pub(crate) fn pin_tcp_pre_ready_timeout_for_tests(&self, timeout: Duration) {
        *self
            .tcp_pre_ready_budget
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(timeout);
    }
}

impl Supervisor {
    /// Register the connection, serve it, then deregister and arm the
    /// owner-disconnect cleanup (TS socket `cleanup`) on every exit path.
    pub(super) async fn handle_client(
        self: Arc<Self>,
        stream: Box<dyn TransportStream>,
        trust: ClientTrust,
    ) -> Result<()> {
        let connection_id = util::new_display_id();
        let effective_client_id = Arc::new(std::sync::Mutex::new(connection_id.clone()));
        self.client_connections
            .lock()
            .unwrap()
            .insert(connection_id.clone(), Arc::clone(&effective_client_id));
        let served = Arc::clone(&self)
            .serve_client(
                stream,
                trust,
                connection_id.clone(),
                Arc::clone(&effective_client_id),
            )
            .await;
        self.client_connections
            .lock()
            .unwrap()
            .remove(&connection_id);
        let owner = effective_client_id.lock().unwrap().clone();
        self.schedule_owned_worker_cleanup_for_client(&owner).await;
        served
    }

    async fn serve_client(
        self: Arc<Self>,
        stream: Box<dyn TransportStream>,
        trust: ClientTrust,
        connection_id: String,
        effective_client_id: Arc<std::sync::Mutex<String>>,
    ) -> Result<()> {
        let (reader, mut writer) = stream.split();
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
        // The write-side view of the same deadline: a second watch
        // receiver for the loop's writes to borrow (the expired arm owns
        // the mpsc signal; the writes must observe the SAME scheduled
        // instant the watchdog fires at, so a parked write is cut at the
        // exact moment the expired arm would have honored).
        let mut tcp_deadline_rx = None;
        let mut tcp_authenticated = false;
        if let ClientTrust::Remote { .. } = trust {
            let (deadline_tx, deadline_rx) = tokio::sync::watch::channel(
                tokio::time::Instant::now() + self.tcp_pre_ready_timeout(),
            );
            let (expired_tx, expired_rx) = tokio::sync::mpsc::channel::<tokio::time::Instant>(1);
            let watchdog = tokio::spawn(async move {
                let mut deadline_rx = deadline_rx;
                loop {
                    let deadline = *deadline_rx.borrow_and_update();
                    let changed = tokio::time::timeout_at(deadline, deadline_rx.changed()).await;
                    match changed {
                        Err(_expired) => {
                            // The signal names the window that elapsed so
                            // the consumer can tell it apart from a window
                            // renewed while the signal sat queued.
                            if expired_tx.send(deadline).await.is_err() {
                                return;
                            }
                            // Stay armed instead of exiting: the consumer
                            // may drain this signal as stale (a traffic arm
                            // renewed the window after the fire) and keep
                            // the peer open, and that renewed window still
                            // needs its own expiry. The next iteration
                            // re-borrows whatever window the watch holds
                            // once the queue drains.
                        }
                        Ok(Ok(())) => {}
                        Ok(Err(_)) => return,
                    }
                }
            });
            // The watchdog ends with its channel ends: this connection
            // dropping its deadline sender makes `changed()` error and the
            // task return (the TS `clearTimeout` on close), and a closed
            // connection's dropped receiver fails the signal send the same
            // way. Dropping the handle does not abort the spawned task.
            drop(watchdog);
            tcp_deadline_rx = Some(deadline_tx.subscribe());
            tcp_deadline_tx = Some(deadline_tx);
            tcp_expired_rx = Some(expired_rx);
        }

        // The factory lane's advertisement gate reads the settings file
        // (metadata plus a locked read on a cache miss) — off the
        // executor thread, the same spawn_blocking posture as the daemon's
        // other settings reads. The read stays fresh per connection, so a
        // `/factory on` toggle surfaces on the next client start.
        let agent_dir = self.options.agent_dir.clone();
        let factory_capabilities = tokio::task::spawn_blocking(move || {
            crate::factory_activity::advertised_server_capabilities(&agent_dir)
        })
        .await
        .map_err(|error| anyhow::anyhow!("the factory settings read failed: {error:#}"))?;
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
            app_version: Some(app_version().to_string()),
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
            client_id: connection_id.clone(),
            server_capabilities: factory_capabilities,
            rest: Map::default(),
        };
        // The greeting write rides the pre-ready budget (the hello round's
        // settled claim - "the budget still has a real job: bounding a
        // wedged write" - is only true if the parked write observes the
        // budget): a peer that wedges the banner write is closed at the
        // budget instead of parking outside the loop where the expired
        // arm cannot reach it.
        let write_deadline = tcp_deadline_rx.as_ref().map(|rx| *rx.borrow());
        deadline_write(
            write_deadline,
            write_line(&mut writer, &serde_json::to_value(&hello)?),
        )
        .await?;
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
        // Session events ride this per-connection queue (the subscriber
        // registry resolves delivery at publish time, TS `handleWorkerFrame`
        // parity); broadcast-class events keep the ring above.
        let (targeted_tx, mut targeted_rx) = tokio::sync::mpsc::channel::<Arc<Value>>(
            crate::backpressure::TARGETED_EVENT_QUEUE_CAPACITY,
        );
        // Connection state shared with the per-command dispatch tasks (the registry
        // insertion is the delivery boundary).
        let attached = subscribers::ClientSubscriptions::new(connection_id.clone(), targeted_tx);
        // Roster subscription flag shared with the per-command dispatch
        // tasks (`roster_subscribe` flips it; the event arm filters pushes).
        let roster_subscribed: Arc<std::sync::atomic::AtomicBool> =
            Arc::new(std::sync::atomic::AtomicBool::new(false));
        let connection = Arc::new(crate::input_pause_lease::ClientConnectionState::new());
        // Completed dispatches flow back through this channel so the loop keeps
        // writing: a long command must not block this client's events or its other
        // commands. Bounded so a slow client stalls only its own dispatch tasks.
        let (dispatch_tx, mut dispatch_rx) = tokio::sync::mpsc::channel::<(Vec<Outbound>, bool)>(
            crate::backpressure::CLIENT_OUTBOUND_CAPACITY,
        );
        // One dispatch slot per concurrent command. The read arm is armed only while a
        // slot is free — at the bound the loop stops reading the client's socket
        // (transport-level flow control, not unbounded task spawn).
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
            // The deadline this iteration's client writes are bounded by:
            // the same watch value the expiry watchdog fires at, so a
            // write parked on a stalled peer is cut at the identical
            // instant the expired arm would have honored it. None on
            // local connections: their writes stay unbounded as before.
            let mut write_deadline = tcp_deadline_rx.as_ref().map(|rx| *rx.borrow());
            tokio::select! {
                biased;
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
                            // The refusal write rides the pre-auth window
                            // like every other unauthenticated write.
                            let _ =
                                deadline_write(write_deadline, write_line(&mut writer, &failure))
                                    .await;
                            return Err(anyhow!(
                                "TCP authentication failed ({}); closing connection",
                                verdict.reason
                            ));
                        }
                        if !tcp_authenticated {
                            tcp_authenticated = true;
                        }
                    }
                    // The arm's guard proved a slot free (this loop is the only slot
                    // acquirer), so the non-blocking take always succeeds.
                    let dispatch_slot = Arc::clone(&dispatch_slots)
                        .try_acquire_owned()
                        .expect("the read arm's guard held a dispatch slot");
                    let supervisor = Arc::clone(&self);
                    let effective_client_id = Arc::clone(&effective_client_id);
                    let attached = Arc::clone(&attached);
                    let roster_subscribed = Arc::clone(&roster_subscribed);
                    let connection = Arc::clone(&connection);
                    let dispatch_tx = dispatch_tx.clone();
                    // A streaming command (list_saved_sessions) writes its progress frames
                    // through the SAME channel the response later takes, so they stay ordered.
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
                            // Only a terminal shutdown owns the descriptor-deleting stop pass; an
                            // update restart must leave its descriptors for the successor.
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
                        // The slot frees only once the bundle is in the queue.
                        drop(dispatch_slot);
                    });
                }
                targeted = targeted_rx.recv() => {
                    // A session event routed by the subscriber registry at
                    // publish time: the delivery decision already ran, the
                    // frame only writes (the queue preserves per-session
                    // publish order). The arm polls ahead of the response
                    // arm, so an event published before a response bundle
                    // is queued is written first - the worker's own
                    // event-before-response socket order survives the hop.
                    if let Some(payload) = targeted {
                        saw_socket_traffic = true;
                        if let Err(error) =
                            deadline_write(write_deadline, write_line(&mut writer, &payload)).await
                        {
                            // An event-write failure must not strand an
                            // accepted shutdown: if this connection owns the
                            // stop, it still starts the pass.
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
                dispatched = dispatch_rx.recv() => {
                    let Some((lines, stop)) = dispatched else { break };
                    for outbound in lines {
                        let written = match &outbound {
                            Outbound::Line(value) => {
                                deadline_write(write_deadline, write_line(&mut writer, value))
                                    .await
                            }
                            Outbound::Raw(line) => {
                                deadline_write(write_deadline, write_raw_line(&mut writer, line))
                                    .await
                            }
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
                        // A large outbound response freed big transients: return the heap to
                        // the OS instead of letting the arenas hold the phase's peak.
                        drop(outbound);
                        pa_types::memory_release::trim_freed_heap_if_large(bytes);
                        saw_socket_traffic = true;
                        // A completed write is socket traffic: the next
                        // line of the same bundle rides a fresh idle
                        // window (TS `socket.setTimeout` resets on every
                        // socket write), so a slow-but-live reader is
                        // never cut mid-bundle while a stalled one parks
                        // and is closed at the armed deadline. The fresh
                        // window rides the ONE signal the expiry watchdog
                        // arms - never a private copy: the watchdog
                        // re-arms to the same instant the write path
                        // honors, so a later stalled write is cut at the
                        // window the expired arm committed, and a
                        // slow-but-live bundle that crosses the original
                        // armed window never outlives the watchdog: it
                        // re-arms with the renewal, and even a signal
                        // queued at the crossed boundary names the old
                        // window, which the expired arm drains as stale
                        // instead of closing the live peer.
                        if let Some(deadline_tx) = tcp_deadline_tx.as_ref() {
                            if tcp_authenticated {
                                let renewed =
                                    tokio::time::Instant::now() + self.tcp_idle_timeout();
                                deadline_tx.send_replace(renewed);
                                write_deadline = Some(renewed);
                            }
                        }
                    }
                    if stop {
                        // The initiating client's response and daemon_closing lines are flushed
                        // above; only now may the stop pass end the runtime (the accept loop
                        // stays up until begin_shutdown sets accept_exit).
                        self.ensure_shutdown_started().await;
                        break;
                    }
                }
                expired = async { match tcp_expired_rx.as_mut() { Some(rx) => rx.recv().await, None => std::future::pending().await } }, if tcp_admission_armed => {
                    // The admission deadline fired: an unauthenticated
                    // TCP peer held its window without authenticating
                    // (dribbled partial lines renew nothing), or an
                    // authenticated one went silent past the idle window.
                    // Destroy the connection like the TS timers do.
                    if let Some(fired_at) = expired {
                        // The signal names the window it fired at, and the
                        // window may have moved since: this select is
                        // biased, so a traffic arm ready in the same
                        // instant the watchdog fired runs first, its write
                        // renews the idle window, and the queued signal
                        // waits for a quiet iteration. A signal from a
                        // window the traffic arms already replaced must
                        // not close the live peer - drain it and keep
                        // serving; the watchdog stayed armed at the renewed
                        // window and fires again if that one elapses
                        // unanswered too.
                        let renewed = tcp_deadline_rx.as_ref().map(|rx| *rx.borrow());
                        if renewed.is_some_and(|window| window > fired_at) {
                            continue;
                        }
                    }
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
                                if let Err(error) =
                                    deadline_write(write_deadline, write_line(&mut writer, &payload))
                                        .await
                                {
                                    // An event-write failure must not strand an accepted shutdown.
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
                        // A lagged receiver means the ring dropped this many events for THIS
                        // connection: the loss is the defined backpressure, but never invisible —
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
        // Only the connection that accepted the shutdown may run the stop pass from this
        // fallback: another client disconnecting in the response window must not preempt the
        // acknowledgement.
        let is_shutdown_owner =
            self.shutdown_owner.lock().unwrap().as_deref() == Some(connection_id.as_str());
        if is_shutdown_owner
            && self.shutting_down.load(Ordering::SeqCst)
            && !self.accept_exit.load(Ordering::SeqCst)
        {
            self.ensure_shutdown_started().await;
        }
        // Detach from every attached session on disconnect (a TUI exit does not
        // stop the session). The registry entries go first — no session event may
        // be enqueued for a connection whose loop has exited.
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
        // The disconnect's pause-lease cleanup: in-flight acquisitions invalidate, every held
        // lease releases, and waiting prompt admissions cancel with the TS cancellation error.
        self.release_all_client_pauses(&connection).await;
        connection.prompt_admissions.cancel_all_waiting();
        Ok(())
    }

    /// Whether any live connection still speaks for `client_id` (one
    /// process may hold several connections).
    fn client_connected(&self, client_id: &str) -> bool {
        self.client_connections
            .lock()
            .unwrap()
            .values()
            .any(|effective| *effective.lock().unwrap() == client_id)
    }

    /// TS `scheduleOwnedWorkerCleanupForClient`.
    async fn schedule_owned_worker_cleanup_for_client(self: &Arc<Self>, client_id: &str) {
        for resident in self.registry.list().await {
            let owner = resident.descriptor.lock().await.owner_client_id.clone();
            if owner.as_deref() == Some(client_id) {
                self.schedule_owned_worker_cleanup(&resident).await;
            }
        }
    }

    /// Stop a client-owned worker [`OWNED_WORKER_DISCONNECT_GRACE`] after
    /// its owner's last connection closed (TS `scheduleOwnedWorkerCleanup`).
    /// A later arm replaces a pending timer; an owner connected at expiry
    /// keeps the worker.
    pub(super) async fn schedule_owned_worker_cleanup(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
    ) {
        let owner = resident.descriptor.lock().await.owner_client_id.clone();
        let Some(owner) = owner else { return };
        if self.client_connected(&owner) {
            return;
        }
        let supervisor = Arc::clone(self);
        let timer_resident = Arc::clone(resident);
        let deadline = tokio::time::Instant::now() + OWNED_WORKER_DISCONNECT_GRACE;
        let task = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            // Clear this timer's own handle first, so a later arm can only
            // abort a sleeping timer, never a stop in progress. A newer arm's
            // handle in the slot means this timer was replaced (and aborted).
            {
                let mut slot = timer_resident.owner_cleanup.lock().unwrap();
                if slot.as_ref().map(tokio::task::AbortHandle::id) != Some(tokio::task::id()) {
                    return;
                }
                slot.take();
            }
            if supervisor.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            if supervisor.client_connected(&owner) {
                return;
            }
            if timer_resident
                .descriptor
                .lock()
                .await
                .owner_client_id
                .as_deref()
                != Some(owner.as_str())
            {
                return;
            }
            // Skip if the worker was stopped or replaced since the arm.
            let Some(current) = supervisor.registry.get(&timer_resident.worker_id).await else {
                return;
            };
            if !Arc::ptr_eq(&current, &timer_resident) {
                return;
            }
            // Descriptor and registry reads can yield while the owner
            // reconnects. Recheck immediately before claiming the stop.
            if supervisor.client_connected(&owner) {
                return;
            }
            match supervisor.stop_worker(&timer_resident).await {
                Ok(()) => supervisor.log_line(&format!(
                    "stopped client-owned worker {} after its owner {owner} disconnected",
                    timer_resident.worker_id
                )),
                Err(error) => supervisor.log_line(&format!(
                    "could not clean up client-owned worker {}: {error:#}",
                    timer_resident.worker_id
                )),
            }
        });
        let previous = resident
            .owner_cleanup
            .lock()
            .unwrap()
            .replace(task.abort_handle());
        if let Some(previous) = previous {
            previous.abort();
        }
    }

    /// Handle one client command line: returns outbound lines in order and
    /// whether this client connection should stop.
    // The per-connection stream sender rides the same context bundle (lint budget +1).
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
                // TS has two failure spellings: envelope/protocol failures answer
                // `command: "parse"`, while a known envelope holding an unknown or
                // malformed command type echoes that type.
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
        // THE REQUEST'S OWN CLIENT ID, captured at parse time: the shutdown
        // attribution must name the client that SENT the shutdown, not whoever
        // spoke next (an envelope without a clientId rides the sticky id).
        let request_client_id = envelope
            .client_id
            .clone()
            .unwrap_or_else(|| effective_client_id.lock().unwrap().clone());
        if let Some(client_id) = envelope.client_id.clone() {
            *effective_client_id.lock().unwrap() = client_id;
        }
        // A prompt carrying an admissionId reserves it before dispatch (TS parse-time);
        // duplicates and empty ids answer the TS parse errors with `command: "parse"`.
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
        // Terminal shutdown admission gate: once `shutting_down` has flipped, no later
        // client command may reach a worker (the stop pass may already be retiring it).
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
        // Update-prepare watchdog on any later command (spec §5): an expired marker
        // returns the supervisor to Serving before the command is served.
        if let Some(abort) = self.update_prepare.abort_if_expired(util::now_ms()) {
            self.finish_update_abort(&abort);
        }
        // Admission gate: mutating commands are refused while a prepare transaction is
        // active, except the drain commands during `Draining`.
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
                            // The typed `update_restarting` info rides beside the plain message,
                            // so clients can recognize the transient state and wait through it.
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
                // WHO asked: the request's client id and command id land in the daemon log
                // the moment the drain commits, so the client that stopped the daemon is
                // nameable from the log alone. Both values are newline-stripped: a
                // client-chosen id carrying \n must not forge attribution lines.
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
                // Answer first, then shut down: the client receives the response and
                // daemon_closing before the stop pass can end the process. The gate flips
                // synchronously here, so no create dispatched after the shutdown can slip past it.
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
                        // A typed worker rejection carries its wire info to the client.
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
                // Direct-attach ticket: a single-use grant for a registered session, handed to
                // the client with the worker's own socket; it stays out of the streaming path.
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
                // Worker-to-worker peer ticket: a single-use `worker` grant pushed into
                // the target worker's memory, so the delivery bypasses this route plane.
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
                // Worker self-registration: rebuilds the roster entry from the worker's
                // own identity instead of routing to a session.
                let response = self
                    .handle_worker_register(&command_id, &type_name, command)
                    .await;
                (vec![response_line(&response)], false)
            }
            DaemonCommand::CommitUpdateRestart { .. } => {
                // The coordinator's commit (spec §5 `Prepared -> Stopping`): consume the
                // prepared transaction, stop the workers in budget, and exit or abandon it.
                self.handle_commit_update_restart(&command_id, &type_name, command)
                    .await
            }
            DaemonCommand::PrepareUpdateRestart { .. } => {
                // The update-flow coordinator's prepare RPC: accepts (or idempotently
                // polls) the supervisor-side prepare transaction (spec §5).
                let response = self
                    .handle_prepare_update_restart(&command_id, &type_name, command)
                    .await;
                (vec![response_line(&response)], false)
            }
            DaemonCommand::UpdateRestoreStatus { .. } => {
                // The boot restore pass's live snapshot (spec §6/§9): the successor
                // coordinator's `Restoring` report polls this for real counts and failures.
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
                // An admitted prompt: the cancellation checks, the admission-id rewrite,
                // and the owned commit around the routed prompt.
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
                // The supervisor's status ladder over the admission registry.
                self.handle_cancel_prompt_admission(connection, command, &command_id, &type_name)
                    .await
            }
            DaemonCommand::CompleteOwnedSession { .. } => {
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_complete_owned_session(command, &client_id, &command_id, &type_name)
                    .await
            }
            DaemonCommand::PromoteOwnedSession { .. } => {
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_promote_owned_session(command, &client_id, &command_id, &type_name)
                    .await
            }
            DaemonCommand::RetryWorker { .. } => {
                // The recovery is a supervisor arm — the worker never sees the command.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_retry_worker(command, &client_id, &command_id, &type_name)
                    .await
            }
            DaemonCommand::AbortCompaction { .. } => {
                // The supervisor answers the abort itself: a wedged worker must not turn
                // the abort into its own 30s route timeout and a loader that never clears.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_abort_compaction(command, &client_id, attached, &command_id, &type_name)
                    .await
            }
            DaemonCommand::AcquireSessionInputPause { .. } => {
                // The supervisor-owned lease path: resolve, rewrite the lease key, forward, record.
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
                // Detach carries the pause-lease bookkeeping: mark the detaching sessions and
                // bump the epoch BEFORE the routed detach, then release the client's leases.
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
                // A selector that resolves to nothing detaches nothing and still answers success.
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
                // Reattach clears the detach marks for the reattached sessions (TS
                // reattach arm): a reattached session may acquire pauses again.
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
                // Selector-less `agent_messages_status`: the first live worker answers,
                // else the TS empty-status object.
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
                // `list_agent_peers`: the worker-token-authenticated peer roster.
                self.handle_list_agent_peers(command, &command_id, &type_name)
                    .await
            }
            DaemonCommand::RenameSavedSession { .. } => {
                // `rename_saved_session`: reservation ladder, then catalog rename or worker route.
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
                // Selector-less `delete_saved_session`: the supervisor's catalog delete.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_delete_saved_session(command, &client_id, &command_id, &type_name)
                    .await
            }
            DaemonCommand::CronList {
                active_session_id, ..
            } if active_session_id.is_none() => {
                // Selector-less `cron_list`: merge the live workers' jobs with the passive ones.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_cron_list_catalog(command, &client_id, &command_id, &type_name)
                    .await
            }
            DaemonCommand::HeartbeatsList {
                active_session_id, ..
            } if active_session_id.is_none() => {
                // Selector-less `heartbeats_list`: the merged heartbeat catalog.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_heartbeats_list_catalog(command, &client_id, &command_id, &type_name)
                    .await
            }
            DaemonCommand::CronCancel {
                active_session_id, ..
            } if active_session_id.is_none() => {
                // Selector-less `cron_cancel`: the owner-worker search, then the passive
                // store, then the TS error.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_cron_cancel_catalog(command, &client_id, &command_id, &type_name)
                    .await
            }
            DaemonCommand::HeartbeatManage { .. } => {
                // `heartbeat_manage`: passive jobs are managed against their durable store,
                // live ones route to their worker.
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
                // `cron_add`: the routed add plus the ownership promotion the command may
                // ask for.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_cron_add_catalog(command, &client_id, attached, &command_id, &type_name)
                    .await
            }
            DaemonCommand::HeartbeatSet { .. } => {
                // `heartbeat_set`: the same forward-and-promote path as `cron_add`.
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
                // Selector-less pause/resume: the broadcast to every live worker.
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
    use pa_types::daemon::DaemonWorkerDescriptor;
    #[cfg(unix)]
    use pa_types::platform::transport::TransportStream;
    #[cfg(unix)]
    use serde_json::json;
    #[cfg(unix)]
    use std::sync::Arc;
    use std::time::Duration;

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
        // The greeting arrives before the loop reads: consume it first.
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
        // The drain commits synchronously with the log line, so the log is the wait
        // point; the response and daemon_closing follow on their own schedule.
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
        // The write half stays held so the connection's writes fail only when the test ends.
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
        // The greeting is written BEFORE the loop subscribes to the event ring, so the
        // flood waits for the subscription — sends into a receiver-less ring are dropped.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while supervisor.events.receiver_count() == 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "the connection loop never subscribed"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // Flood the ring past its capacity with frames too big for the client's socket
        // buffer: the loop parks in its event write and its receiver falls out of the
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
        // Drain the parked connection while watching for the log line: the loop unparks
        // as the reader frees the buffer, and its next event read reports the dropped span.
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

    /// A remote peer that authenticates, then stalls its reads, parks the
    /// daemon's response write in flow control (a response the peer never
    /// reads cannot drain the transport window). The expired arm only
    /// fires while the select loop polls, and a write parked inside an
    /// arm body never yields to it, so the deadline must cut the parked
    /// write itself - otherwise the stalled peer pins its
    /// `DAEMON_TCP_MAX_CONNECTIONS` slot past every window (the Bugbot
    /// "idle deadline misses blocked writes" round). The idle window is
    /// pinned short (the production 10 minutes is pinned by
    /// `admission_budgets_pin_the_ts_values`); the response line rides a
    /// command id far larger than the duplex pipe, so the write parks the
    /// moment it starts and the pinned window must close it.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_stalled_write_is_cut_at_the_admission_deadline() {
        use pa_types::platform::transport::{AsyncReadHalf, AsyncWriteHalf};

        struct DuplexTransport(tokio::io::DuplexStream);
        impl TransportStream for DuplexTransport {
            fn split(self: Box<Self>) -> (Box<dyn AsyncReadHalf>, Box<dyn AsyncWriteHalf>) {
                let (reader, writer) = tokio::io::split(self.0);
                (Box::new(reader), Box::new(writer))
            }
        }

        let dir = tempfile::TempDir::new().unwrap();
        let options = SupervisorOptions {
            tcp_port: None,
            tcp_bind_host: None,
            remote_agent_mesh: None,
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        };
        let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
        supervisor.pin_tcp_idle_timeout_for_tests(Duration::from_millis(300));
        // A 64KB duplex pipe: the greeting (<1KB) lands; a response line
        // carrying a ~700KB command id can never fit, so the daemon's
        // response write parks in flow control against the stalled peer.
        let (server_side, mut client_side) = tokio::io::duplex(64 * 1024);
        let connection = {
            let supervisor = Arc::clone(&supervisor);
            let stream: Box<dyn TransportStream> = Box::new(DuplexTransport(server_side));
            tokio::spawn(async move {
                supervisor
                    .handle_client(
                        stream,
                        crate::supervisor::ClientTrust::Remote {
                            auth_token: "token".to_string(),
                        },
                    )
                    .await
            })
        };
        // Authenticate with a `list` whose echoed id dwarfs the pipe: the
        // authenticated line re-arms the idle window, the dispatch answers
        // a response the peer never reads, and the write parks.
        let big_id = "i".repeat(700 * 1024);
        let line = format!(
            "{{\"type\":\"command\",\"id\":\"{big_id}\",\"protocol\":{{\"name\":\"{}\",\"version\":{}}},\"command\":{{\"type\":\"list\"}},\"auth\":{{\"token\":\"token\"}}}}\n",
            crate::protocol::DAEMON_PROTOCOL_NAME,
            crate::protocol::DAEMON_PROTOCOL_VERSION,
        );
        let armed = std::time::Instant::now();
        client_side.write_all(line.as_bytes()).await.unwrap();
        // The pinned window must cut the parked write: the connection
        // resolves closed, instead of parking until this timeout fails.
        let closed = tokio::time::timeout(Duration::from_secs(10), connection)
            .await
            .expect("the idle window must cut the stalled write, not park forever");
        let outcome = closed.expect("the connection task must end");
        assert!(
            outcome.is_err(),
            "a stalled write closes the connection with an error"
        );
        assert!(
            armed.elapsed() <= Duration::from_secs(4),
            "the cut must ride the pinned 300ms window, not another timeout (closed after {:?})",
            armed.elapsed()
        );
    }

    /// A bundle's per-write renewal must ride the ONE deadline signal the
    /// expiry watchdog arms - a private `write_deadline` copy desyncs the
    /// write path from the watchdog (the Bugbot "write deadline desyncs
    /// from watchdog" round): the watchdog, still armed at the ORIGINAL
    /// idle window, fired and exited for good while the bundle's writes
    /// kept riding the local copy's renewals, so a later stalled write
    /// outlived the window the expired arm committed and - the live-peer
    /// harm - the leftover expiry signal dropped a slow-but-live peer at
    /// the next select. This drives one saved-catalog [item, progress]
    /// bundle (two writes in ONE dispatched arm body) over a paced drain
    /// that keeps every write live while crossing the original armed
    /// window, then pins that the connection keeps serving afterwards.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_slow_but_live_bundle_survives_crossing_the_armed_window() {
        use pa_types::platform::transport::{AsyncReadHalf, AsyncWriteHalf};
        use tokio::io::AsyncReadExt as _;

        struct DuplexTransport(tokio::io::DuplexStream);
        impl TransportStream for DuplexTransport {
            fn split(self: Box<Self>) -> (Box<dyn AsyncReadHalf>, Box<dyn AsyncWriteHalf>) {
                let (reader, writer) = tokio::io::split(self.0);
                (Box::new(reader), Box::new(writer))
            }
        }

        // Read one newline-terminated frame off the duplex, retaining any
        // bytes read past the newline for the next frame (the daemon is
        // the only writer, so a chunk cannot overrun into a frame that
        // does not exist yet; the retention keeps the drain byte-exact).
        async fn drain_frame(
            stream: &mut tokio::io::DuplexStream,
            carry: &mut Vec<u8>,
        ) -> serde_json::Value {
            loop {
                if let Some(newline) = carry.iter().position(|byte| *byte == b'\n') {
                    let mut frame: Vec<u8> = carry.drain(..=newline).collect();
                    frame.pop();
                    let text = String::from_utf8_lossy(&frame);
                    return serde_json::from_str(&text)
                        .unwrap_or_else(|error| panic!("a daemon frame is not JSON: {error}"));
                }
                let mut chunk = vec![0u8; 64 * 1024];
                let read = stream
                    .read(&mut chunk)
                    .await
                    .expect("the client pipe stayed readable");
                assert!(
                    read > 0,
                    "the daemon closed the connection before the frame arrived"
                );
                carry.extend_from_slice(&chunk[..read]);
            }
        }

        let dir = tempfile::TempDir::new().unwrap();
        let options = SupervisorOptions {
            tcp_port: None,
            tcp_bind_host: None,
            remote_agent_mesh: None,
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        };
        let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
        supervisor.pin_tcp_idle_timeout_for_tests(Duration::from_millis(750));
        // One valid saved session in its own scan dir: `list_saved_sessions`
        // streams a per-file [item, progress] bundle - two writes in ONE
        // dispatched arm body, the multi-write surface whose renewal must
        // reach the watchdog.
        let scan_dir = tempfile::TempDir::new().unwrap();
        let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
        session.append_session_info("slow-live-bundle");
        session.set_path(
            scan_dir
                .path()
                .join(crate::session_store::session_file_name(
                    session.session_id(),
                )),
        );
        session.rewrite().unwrap();
        // A 64KB duplex pipe: every catalog frame (each embeds the echoed
        // ~350KB command id) dwarfs it, so each of the bundle's two writes
        // parks until the client drains.
        let (server_side, mut client_side) = tokio::io::duplex(64 * 1024);
        let connection = {
            let supervisor = Arc::clone(&supervisor);
            let stream: Box<dyn TransportStream> = Box::new(DuplexTransport(server_side));
            tokio::spawn(async move {
                supervisor
                    .handle_client(
                        stream,
                        crate::supervisor::ClientTrust::Remote {
                            auth_token: "token".to_string(),
                        },
                    )
                    .await
            })
        };
        let mut carry: Vec<u8> = Vec::new();
        let hello = drain_frame(&mut client_side, &mut carry).await;
        assert_eq!(hello["type"], "daemon_hello", "the greeting: {hello}");
        // The paced-drain schedule (the idle window pinned to 750ms): the
        // item frame drains at t=500ms - live, inside the original window -
        // and the progress frame at t=1000ms - past the original 750ms
        // armed instant, inside the window the item's completion renewed.
        // Every write stays live; the bundle crosses the armed window.
        let envelope = serde_json::json!({
            "type": "command",
            "id": "i".repeat(350 * 1024),
            "protocol": {
                "name": crate::protocol::DAEMON_PROTOCOL_NAME,
                "version": crate::protocol::DAEMON_PROTOCOL_VERSION,
            },
            "command": {
                "type": "list_saved_sessions",
                "cwd": "/tmp",
                "sessionDir": scan_dir.path().to_string_lossy(),
            },
            "auth": { "token": "token" },
        });
        client_side
            .write_all((serde_json::to_string(&envelope).unwrap() + "\n").as_bytes())
            .await
            .unwrap();

        tokio::time::sleep(Duration::from_millis(500)).await;
        let item = drain_frame(&mut client_side, &mut carry).await;
        assert_eq!(
            item["type"], "session_list_item",
            "the bundle's first write"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
        let progress = drain_frame(&mut client_side, &mut carry).await;
        assert_eq!(
            progress["type"], "session_list_progress",
            "the bundle's second write"
        );
        // The bundle finished past the original armed window while every
        // write stayed live: a desynced watchdog has already fired and
        // left its expiry signal behind, so the harm lands HERE - the next
        // select must not drop this live peer.
        let completion = drain_frame(&mut client_side, &mut carry).await;
        assert_eq!(
            completion["type"], "session_list_progress",
            "the scan's completion frame after the bundle"
        );
        assert_eq!(
            completion["loaded"], 1,
            "the completion frame reaches the scan's file total"
        );
        let response = drain_frame(&mut client_side, &mut carry).await;
        assert_eq!(response["type"], "response", "the terminal response");
        assert_eq!(response["success"], true, "the catalog answer: {response}");
        // Liveness past the crossed window, the direct live-peer proof: a
        // follow-up command round-trips on the SAME connection.
        let follow_up = serde_json::json!({
            "type": "command",
            "id": "after-the-window",
            "protocol": {
                "name": crate::protocol::DAEMON_PROTOCOL_NAME,
                "version": crate::protocol::DAEMON_PROTOCOL_VERSION,
            },
            "command": { "type": "list" },
            "auth": { "token": "token" },
        });
        client_side
            .write_all((serde_json::to_string(&follow_up).unwrap() + "\n").as_bytes())
            .await
            .expect("the connection stays writable for the follow-up command");
        let after = drain_frame(&mut client_side, &mut carry).await;
        assert_eq!(
            after["type"], "response",
            "a frame after the crossed window"
        );
        assert_eq!(
            after["success"], true,
            "a command answered after the crossed window: {after}"
        );
        connection.abort();
    }

    /// A queued expiry signal must be validated against the window the
    /// traffic arms hold, never trusted as terminal: the biased select
    /// polls every traffic arm ahead of the expired arm, so when a write
    /// and the watchdog's fire land in the same instant the write renews
    /// the window and the signal waits for the next quiet iteration -
    /// closing on it would drop a live peer whose traffic landed exactly
    /// at its window boundary (the Bugbot "expiry signal can drop live
    /// peers" round). The watchdog must also stay armed after a stale
    /// drain: a one-shot watchdog leaves the peer with no idle
    /// enforcement at all.
    ///
    /// The stale state is pinned at the pre-ready boundary, where it is
    /// deterministic: the connection parks on the factory settings read
    /// (the locked read a fresh settings file forces) while the pinned
    /// pre-ready budget elapses, so the watchdog fires the pre-ready
    /// window's expiry signal before the greeting exists; the greeting
    /// that completes afterwards re-arms the deadline to the auth window
    /// - a queued signal naming the pre-ready window against a window
    /// that moved after the fire. The stale signal must drain, the peer
    /// must authenticate and round-trip a command on the same
    /// connection, and the watchdog must still close the silent peer at
    /// the renewed idle window.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_stale_expiry_signal_spares_the_peer_whose_window_was_renewed() {
        use pa_types::platform::transport::{AsyncReadHalf, AsyncWriteHalf};
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        struct DuplexTransport(tokio::io::DuplexStream);
        impl TransportStream for DuplexTransport {
            fn split(self: Box<Self>) -> (Box<dyn AsyncReadHalf>, Box<dyn AsyncWriteHalf>) {
                let (reader, writer) = tokio::io::split(self.0);
                (Box::new(reader), Box::new(writer))
            }
        }

        // Read one newline-terminated frame off the duplex, retaining any
        // bytes read past the newline for the next frame (the daemon is
        // the only writer, so a chunk cannot overrun into a frame that
        // does not exist yet; the retention keeps the drain byte-exact).
        async fn drain_frame(
            stream: &mut tokio::io::DuplexStream,
            carry: &mut Vec<u8>,
        ) -> serde_json::Value {
            loop {
                if let Some(newline) = carry.iter().position(|byte| *byte == b'\n') {
                    let mut frame: Vec<u8> = carry.drain(..=newline).collect();
                    frame.pop();
                    let text = String::from_utf8_lossy(&frame);
                    return serde_json::from_str(&text)
                        .unwrap_or_else(|error| panic!("a daemon frame is not JSON: {error}"));
                }
                let mut chunk = vec![0u8; 64 * 1024];
                let read = stream
                    .read(&mut chunk)
                    .await
                    .expect("the client pipe stayed readable");
                assert!(
                    read > 0,
                    "the daemon closed the connection before the frame arrived"
                );
                carry.extend_from_slice(&chunk[..read]);
            }
        }

        let dir = tempfile::TempDir::new().unwrap();
        let options = SupervisorOptions {
            tcp_port: None,
            tcp_bind_host: None,
            remote_agent_mesh: None,
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        };
        let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
        // The settings file lands AFTER the supervisor's own telemetry
        // read so the connection's factory read is a cache miss (the
        // read-through cache serves any stat identity it has seen, and
        // an absent file is never cached): a fresh file forces the
        // locked protocol, the pre-loop await this test parks the
        // connection on.
        std::fs::create_dir_all(dir.path().join("agent")).unwrap();
        std::fs::write(dir.path().join("agent/settings.json"), "{}").unwrap();
        // The 50ms pre-ready budget elapses while the connection parks
        // on the held settings lock (the read's 10x20ms retry ladder
        // outlasts it), so the watchdog fires its expiry signal before
        // the greeting exists; the 300ms idle window pins the close
        // phase at the end.
        supervisor.pin_tcp_pre_ready_timeout_for_tests(Duration::from_millis(50));
        supervisor.pin_tcp_idle_timeout_for_tests(Duration::from_millis(300));
        // Hold the same directory lock the daemon's settings read
        // acquires: the connection parks before the greeting until the
        // read's retry ladder gives up (the failed read serves
        // defaults; it is not fatal).
        let settings_guard = pa_core::platform::lock_dir::LockDir::acquire(
            &dir.path().join("agent/settings.json"),
            Duration::from_secs(10),
        )
        .expect("the test takes the settings lock first");
        let (server_side, mut client_side) = tokio::io::duplex(64 * 1024);
        let connection = {
            let supervisor = Arc::clone(&supervisor);
            let stream: Box<dyn TransportStream> = Box::new(DuplexTransport(server_side));
            tokio::spawn(async move {
                supervisor
                    .handle_client(
                        stream,
                        crate::supervisor::ClientTrust::Remote {
                            auth_token: "token".to_string(),
                        },
                    )
                    .await
            })
        };

        let mut carry: Vec<u8> = Vec::new();
        let hello = drain_frame(&mut client_side, &mut carry).await;
        assert_eq!(hello["type"], "daemon_hello", "the greeting: {hello}");
        // The stale signal must not close the peer: an authenticated
        // command round-trips on the same connection.
        let command = serde_json::json!({
            "type": "command",
            "id": "past-the-stale-signal",
            "protocol": {
                "name": crate::protocol::DAEMON_PROTOCOL_NAME,
                "version": crate::protocol::DAEMON_PROTOCOL_VERSION,
            },
            "command": { "type": "list" },
            "auth": { "token": "token" },
        });
        client_side
            .write_all((serde_json::to_string(&command).unwrap() + "\n").as_bytes())
            .await
            .expect("the connection stays writable past the stale signal");
        let response = drain_frame(&mut client_side, &mut carry).await;
        assert_eq!(response["type"], "response", "a live peer's answer");
        assert_eq!(
            response["success"], true,
            "the stale expiry signal drained instead of closing: {response}"
        );
        drop(settings_guard);
        // The watchdog must still guard the renewed windows: the now
        // silent peer closes at the idle window the response's write
        // re-armed - never with a one-shot watchdog (it would never
        // close) and never on the unvalidated stale signal (it would
        // have closed before the answer above).
        let closed = tokio::time::timeout(Duration::from_secs(10), connection)
            .await
            .expect("the drained connection still closes at its idle window");
        let outcome = closed.expect("the connection task must end");
        assert!(
            outcome.is_err(),
            "the silent peer closes at the renewed idle window"
        );
    }
    // One real connection speaking for `client_id`, driven through its
    // first response so the envelope id is the connection's effective
    // id before it closes. "Closed" = drop the write half (EOF) and
    // await the connection task, which runs the disconnect cleanup.
    async fn connect_as(
        supervisor: &Arc<Supervisor>,
        client_id: &str,
    ) -> (
        tokio::task::JoinHandle<Result<()>>,
        tokio::net::unix::OwnedWriteHalf,
    ) {
        let (server_side, client_side) = tokio::net::UnixStream::pair().expect("socket pair");
        let connection = {
            let supervisor = Arc::clone(supervisor);
            let stream: Box<dyn TransportStream> = Box::new(server_side);
            tokio::spawn(async move {
                supervisor
                    .handle_client(stream, crate::supervisor::ClientTrust::Local)
                    .await
            })
        };
        let (client_read, mut client_write) = client_side.into_split();
        let mut client = BufReader::new(client_read);
        let mut hello = String::new();
        client.read_line(&mut hello).await.expect("hello line");
        let envelope = json!({
            "type": "command",
            "id": format!("{client_id}-command"),
            "protocol": {"name": "prime-agent.daemon", "version": 7},
            "clientId": client_id,
            "command": {"type": "roster_unsubscribe", "id": format!("{client_id}-command")},
        });
        client_write
            .write_all((serde_json::to_string(&envelope).unwrap() + "\n").as_bytes())
            .await
            .expect("send the id envelope");
        let mut response = String::new();
        client.read_line(&mut response).await.expect("the response");
        assert!(
            response.contains("\"success\":true"),
            "the roster_unsubscribe response: {response}"
        );
        (connection, client_write)
    }

    /// Reconnecting while an expired timer waits on the descriptor must
    /// prevent a stop. The first connectivity check already happened when
    /// the slot clears, but the descriptor read can yield to a new client.
    #[cfg(unix)]
    #[tokio::test]
    async fn reconnect_during_expired_cleanup_keeps_owned_worker() {
        let dir = tempfile::TempDir::new().unwrap();
        let supervisor = Arc::new(
            Supervisor::new(SupervisorOptions {
                tcp_port: None,
                tcp_bind_host: None,
                remote_agent_mesh: None,
                socket_path: dir.path().join("daemon.sock"),
                agent_dir: dir.path().join("agent"),
            })
            .expect("supervisor"),
        );
        let descriptor: DaemonWorkerDescriptor = serde_json::from_value(json!({
            "version": 2,
            "workerId": "w-reconnect",
            "pid": 0,
            "socketPath": "/tmp/none.sock",
            "recoveryJournalPath": "/tmp/none.jsonl",
            "supervisorSocketPath": "/tmp/none.sock",
            "authenticationToken": "token",
            "rootActiveSessionId": "w-reconnect",
            "ownerClientId": "acp:reconnect",
            "createdAt": "t",
            "updatedAt": "t",
            "lifecycle": "ready",
            "createCommand": {},
            "consecutiveFailures": 0,
        }))
        .expect("descriptor");
        let resident = ResidentWorker::new(
            "w-reconnect".to_string(),
            descriptor,
            dir.path().join("w-reconnect.json"),
        );
        supervisor.registry.insert(Arc::clone(&resident)).await;
        let (first, first_write) = connect_as(&supervisor, "acp:reconnect").await;
        drop(first_write);
        first.await.expect("first connection").unwrap();
        assert!(resident.owner_cleanup.lock().unwrap().is_some());

        // Hold the descriptor AFTER arming, while the expired timer passes
        // its first client_connected check and waits to read ownership.
        let guard = resident.descriptor.lock().await;
        tokio::time::pause();
        tokio::time::advance(OWNED_WORKER_DISCONNECT_GRACE + Duration::from_secs(1)).await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert!(
            resident.owner_cleanup.lock().unwrap().is_none(),
            "timer expired"
        );
        let (reconnected, reconnected_write) = connect_as(&supervisor, "acp:reconnect").await;
        drop(guard);
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert!(
            supervisor.registry.get("w-reconnect").await.is_some(),
            "reconnected owner keeps worker even when old timer expired"
        );
        assert!(
            resident.descriptor.lock().await.stop_requested_at.is_none(),
            "reconnect must veto the stop tombstone"
        );
        drop(reconnected_write);
        reconnected.await.expect("reconnected connection").unwrap();
    }

    /// A client-owned worker stops 30 seconds after its owner's LAST
    /// connection closes (the TS `scheduleOwnedWorkerCleanup` port): a
    /// second connection of the same client id (one process, several
    /// connections) keeps the worker, an owner that reconnects inside
    /// the grace keeps it, and the stop waits out the full grace instead
    /// of firing at the disconnect.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_client_owned_worker_stops_after_its_owner_s_last_connection_closes() {
        let dir = tempfile::TempDir::new().unwrap();
        let supervisor = Arc::new(
            Supervisor::new(SupervisorOptions {
                tcp_port: None,
                tcp_bind_host: None,
                remote_agent_mesh: None,
                socket_path: dir.path().join("daemon.sock"),
                agent_dir: dir.path().join("agent"),
            })
            .expect("supervisor"),
        );
        let descriptor: DaemonWorkerDescriptor = serde_json::from_value(json!({
            "version": 2,
            "workerId": "w-owned",
            "pid": 0,
            "socketPath": "/tmp/none.sock",
            "recoveryJournalPath": "/tmp/none.jsonl",
            "supervisorSocketPath": "/tmp/none.sock",
            "authenticationToken": "token",
            "rootActiveSessionId": "w-owned",
            "ownerClientId": "acp:1",
            "createdAt": "t",
            "updatedAt": "t",
            "lifecycle": "ready",
            "createCommand": {},
            "consecutiveFailures": 0,
        }))
        .expect("descriptor");
        let resident = ResidentWorker::new(
            "w-owned".to_string(),
            descriptor,
            dir.path().join("w-owned.json"),
        );
        supervisor.registry.insert(Arc::clone(&resident)).await;

        // Phase 1: two connections speak for acp:1; closing one must leave
        // the worker alone while the other still holds the id.
        let (a, a_write) = connect_as(&supervisor, "acp:1").await;
        let (b, b_write) = connect_as(&supervisor, "acp:1").await;
        drop(a_write);
        a.await.expect("connection a's task").unwrap();
        // Phase 2: the last connection closes -> the grace timer is armed.
        drop(b_write);
        b.await.expect("connection b's task").unwrap();
        // Phase 3: the owner reconnects well inside the grace.
        let (c, c_write) = connect_as(&supervisor, "acp:1").await;
        // Phase 4: the timer expires with the reconnected owner live, so
        // it must leave the worker alone.
        tokio::time::pause();
        tokio::time::advance(OWNED_WORKER_DISCONNECT_GRACE + Duration::from_secs(1)).await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert!(
            resident.owner_cleanup.lock().unwrap().is_none(),
            "the expiry ran"
        );
        assert!(
            supervisor.registry.get("w-owned").await.is_some(),
            "the reconnecting owner keeps its worker"
        );
        // Phase 5: the last connection closes with no timer pending, so a
        // fresh grace runs: the worker keeps running a grace-minus-a-
        // second past the disconnect, then stops.
        drop(c_write);
        c.await.expect("connection c's task").unwrap();
        tokio::time::advance(OWNED_WORKER_DISCONNECT_GRACE.saturating_sub(Duration::from_secs(1)))
            .await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert!(
            supervisor.registry.get("w-owned").await.is_some(),
            "the worker keeps running inside the grace"
        );
        tokio::time::advance(Duration::from_secs(2)).await;
        let stopped = tokio::time::timeout(Duration::from_secs(5), async {
            while supervisor.registry.get("w-owned").await.is_some() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(stopped.is_ok(), "the owned worker was never stopped");
    }
}
