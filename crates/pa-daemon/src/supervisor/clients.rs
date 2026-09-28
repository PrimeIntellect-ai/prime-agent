//! Client connections: the per-connection task - read loop, dispatch,
//! and the parsed-command execution surface.
use super::{
    broadcast, command_type_name, current_protocol_info, daemon_closing_shutdown_event,
    default_server_capabilities, input_admission_id, json, parse_supervisor_command_line,
    response_failure, response_line, response_success, salvage_command_type, salvage_id,
    subscribers, update_gate_refuses, util, Arc, AsyncBufReadExt, AsyncWriteExt, BufReader,
    ClientRouting, DaemonCommand, DaemonOutbound, DaemonRuntimeIdentity, EnvelopeParseError, Map,
    Ordering, Outbound, Result, RouteAdmission, Supervisor, TransportStream, TypedCreateRejection,
    Value, DAEMON_APP_VERSION, DAEMON_SCHEMA_ID, DAEMON_SCHEMA_REVISION, ROUTE_TIMEOUT_MS,
    UPDATE_PREPARING_MESSAGE,
};

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
        if let DaemonCommand::Attach {
            capabilities,
            supports_extension_ui,
            ..
        }
        | DaemonCommand::Reattach {
            capabilities,
            supports_extension_ui,
            ..
        } = command
        {
            object.insert(
                "capabilities".to_string(),
                json!(["attach_snapshot", "event_sequence", "slim_attach"]),
            );
            object.insert(
                "clientCapabilities".to_string(),
                json!(crate::snapshot_stream::attach_client_capabilities(
                    capabilities.as_deref(),
                    *supports_extension_ui
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
    pub(super) async fn handle_client(
        self: Arc<Self>,
        stream: Box<dyn TransportStream>,
    ) -> Result<()> {
        let (reader, mut writer) = stream.split();
        let client_id = util::new_display_id();
        let hello = DaemonOutbound::DaemonHello {
            socket_path: self.options.socket_path.to_string_lossy().to_string(),
            protocol: current_protocol_info(),
            schema_id: Some(DAEMON_SCHEMA_ID.to_string()),
            schema_revision: Some(DAEMON_SCHEMA_REVISION),
            app_version: Some(DAEMON_APP_VERSION.to_string()),
            runtime: Some(DaemonRuntimeIdentity {
                build_id: concat!("pa-daemon-rs-", env!("CARGO_PKG_VERSION")).to_string(),
                executable_path: std::env::current_exe()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
                entrypoint_path: None,
                launcher_path: None,
            }),
            supervisor_generation: Some(format!("sup:{}", std::process::id())),
            supervisor_pid: Some(u64::from(std::process::id())),
            supervisor_owner_token: Some(uuid::Uuid::new_v4().to_string()),
            supervisor_process_start_id: crate::protocol::process_start_id(std::process::id()),
            supervisor_socket_path: Some(self.options.socket_path.to_string_lossy().to_string()),
            update_resume: Some(self.restore.hello_resume()),
            client_id: client_id.clone(),
            server_capabilities: default_server_capabilities(),
            rest: Map::default(),
        };
        write_line(&mut writer, &serde_json::to_value(&hello)?).await?;

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
        loop {
            line.clear();
            tokio::select! {
                read = reader.read_line(&mut line), if dispatch_slots.available_permits() > 0 => {
                    let Ok(read) = read else { break };
                    if read == 0 {
                        break;
                    }
                    let trimmed = line.trim().to_string();
                    if trimmed.is_empty() {
                        continue;
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
            self.finish_update_abort(abort);
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
                ..
            } => {
                let response = self
                    .handle_list(
                        command_id,
                        type_name,
                        *all,
                        cwd.clone(),
                        session_dir.clone(),
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
                let response = self.handle_roster_unsubscribe(&command_id, &type_name);
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
                let marked =
                    self.begin_detach_pause_bookkeeping(connection, active_session_id.as_deref(), &attached_ids);
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
                self.clear_detaching_after_reattach(connection, &cleared);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::SupervisorOptions;
    use pa_types::platform::transport::TransportStream;
    use serde_json::json;
    use std::sync::Arc;
    use std::time::Duration;

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
            tokio::spawn(async move { supervisor.handle_client(stream).await })
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
