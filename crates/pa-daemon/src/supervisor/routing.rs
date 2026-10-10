//! Command routing between clients and workers: the route tables, the
//! per-request deadlines, and the worker-not-connected refusal.
use super::{
    anyhow, attach_client_capabilities, bail, client_command_payload, command_active_session_id,
    json, mpsc, oneshot, response_failure, response_line, response_success, streamed_attach_lines,
    wants_chunked, Arc, DaemonCommand, DaemonResponse, Duration, Outbound, ResidentWorker, Result,
    RouteAdmission, SnapshotPurpose, Supervisor, Value, WorkerReply, WorkerRequest,
};
use anyhow::Context as _;

/// The route-level wake outcome: a woken resident, or the fallthrough
/// error the caller answers (no saved session matched).
pub(super) enum WakeRoute {
    Woken(Arc<ResidentWorker>),
    Fallthrough(String),
}

pub(crate) const ROUTE_TIMEOUT_MS: u64 = 30_000;
pub(crate) const SUMMARY_TIMEOUT_MS: u64 = 5_000;
/// The route failure for a worker whose command channel is gone: the request did not
/// leave the supervisor, so the route may retry it without risking a duplicate landing.
pub(crate) const WORKER_NOT_CONNECTED: &str = "Session worker is not connected";
/// TS daemon-worker-client.ts:98 reports this when the worker socket closes.
pub(crate) const WORKER_SOCKET_CLOSED: &str = "Daemon worker socket closed";

/// Resolve a pending request whose frame provably never reached the worker with the
/// retryable not-connected failure, never an ambiguous timeout.
pub(super) async fn fail_unsent_request(resident: &Arc<ResidentWorker>, request_id: &str) {
    if let Some(reply) = resident.pending.lock().await.remove(request_id) {
        let _ = reply.send(WorkerReply::Typed(response_failure(
            Some(request_id),
            "route",
            WORKER_NOT_CONNECTED,
            None,
        )));
    }
}
/// TS daemon-supervisor.ts:204 `WORKER_REQUEST_TIMEOUT_MS`.
pub(crate) const WORKER_REQUEST_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1000;

/// The route budget of a client command: turn-long waits ride TS's 24 h
/// worker-request budget; everything else is a short control route.
pub(crate) fn client_route_timeout(command: &DaemonCommand) -> u64 {
    if matches!(
        command,
        DaemonCommand::PromptAndWait { .. }
            | DaemonCommand::WaitForIdle { .. }
            // Headless completion settles a whole autonomous run.
            | DaemonCommand::WaitForHeadlessCompletion { .. }
            // Compaction runs a summarizer model call, like a turn.
            | DaemonCommand::Compact { .. }
            // A tree navigation may run a branch-summary model call.
            | DaemonCommand::NavigateTree { .. }
    ) {
        WORKER_REQUEST_TIMEOUT_MS
    } else {
        ROUTE_TIMEOUT_MS
    }
}

impl Supervisor {
    pub(crate) async fn route_command(
        &self,
        resident: &Arc<ResidentWorker>,
        command_type: &str,
        payload: Value,
        timeout_ms: u64,
        admission: RouteAdmission,
    ) -> Result<WorkerReply> {
        let cmd_tx = {
            let guard = resident.cmd_tx.lock().await;
            guard.clone().ok_or_else(|| anyhow!(WORKER_NOT_CONNECTED))?
        };
        self.route_command_on(
            resident,
            cmd_tx,
            command_type,
            payload,
            timeout_ms,
            admission,
        )
        .await
    }

    /// Route over an explicit worker channel: the handshake's own private one, or the
    /// resident's installed channel via [`Self::route_command`] — only the channel differs.
    pub(crate) async fn route_command_on(
        &self,
        resident: &Arc<ResidentWorker>,
        cmd_tx: mpsc::Sender<WorkerRequest>,
        command_type: &str,
        payload: Value,
        timeout_ms: u64,
        admission: RouteAdmission,
    ) -> Result<WorkerReply> {
        // Bounded admission: a client request answers the overload refusal when the bound is
        // full; internal traffic waits for a slot inside the budget.
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        // The semaphore methods take their Arc by value (the permit owns it for its
        // lifetime), so the route hands them a strong reference of their own.
        let inflight = Arc::clone(&resident.inflight);
        let _permit = match admission {
            RouteAdmission::ClientRequest => match inflight.try_acquire_owned() {
                Ok(permit) => permit,
                Err(_saturated) => {
                    self.note_daemon_event("worker_overloaded", None);
                    return Ok(WorkerReply::Typed(
                        crate::backpressure::overloaded_response(command_type, &resident.worker_id),
                    ));
                }
            },
            RouteAdmission::SupervisorInternal => {
                match tokio::time::timeout_at(deadline, inflight.acquire_owned()).await {
                    Ok(Ok(permit)) => permit,
                    // Both remaining shapes are budget exhaustion: the wait elapsed, or the
                    // semaphore closed with its resident.
                    Ok(Err(_)) | Err(_) => return Err(anyhow!("Session worker timed out")),
                }
            }
        };
        // A retired worker admits no client request (the
        // retire-then-release order of the idle passivation fence): the
        // check runs after admission, so a route that passed readiness
        // before the retire cannot enqueue behind it.
        if matches!(admission, RouteAdmission::ClientRequest) && resident.route_state().retired {
            return Err(anyhow!(WORKER_NOT_CONNECTED));
        }
        let (reply_tx, reply_rx) = oneshot::channel();
        let request_id = uuid::Uuid::new_v4().to_string();
        resident
            .pending
            .lock()
            .await
            .insert(request_id.clone(), reply_tx);
        // A full channel means the writer pump is wedged: client commands answer the same
        // overload refusal (a cancelled send enqueues nothing, so a retry cannot duplicate).
        let request = WorkerRequest {
            request_id: request_id.clone(),
            command_type: command_type.to_string(),
            payload,
        };
        let unsent = match cmd_tx.try_send(request) {
            Ok(()) => None,
            Err(mpsc::error::TrySendError::Full(unsent)) => Some(unsent),
            Err(mpsc::error::TrySendError::Closed(_)) => {
                resident.pending.lock().await.remove(&request_id);
                return Err(anyhow!(WORKER_NOT_CONNECTED));
            }
        };
        if let Some(unsent) = unsent {
            match admission {
                RouteAdmission::ClientRequest => {
                    resident.pending.lock().await.remove(&request_id);
                    self.note_daemon_event("worker_overloaded", None);
                    return Ok(WorkerReply::Typed(
                        crate::backpressure::overloaded_response(command_type, &resident.worker_id),
                    ));
                }
                RouteAdmission::SupervisorInternal => {
                    match tokio::time::timeout_at(deadline, cmd_tx.send(unsent)).await {
                        Ok(Ok(())) => {}
                        Ok(Err(_channel_closed)) => {
                            resident.pending.lock().await.remove(&request_id);
                            return Err(anyhow!(WORKER_NOT_CONNECTED));
                        }
                        Err(_budget_elapsed) => {
                            resident.pending.lock().await.remove(&request_id);
                            return Err(anyhow!("Session worker timed out"));
                        }
                    }
                }
            }
        }
        match tokio::time::timeout_at(deadline, reply_rx).await {
            // The writer pump resolves provably-unsent requests with the not-connected
            // failure: surface it as the retryable route error, not a worker response.
            Ok(Ok(WorkerReply::Typed(response)))
                if !response.success && response.error.as_deref() == Some(WORKER_NOT_CONNECTED) =>
            {
                Err(anyhow!(WORKER_NOT_CONNECTED))
            }
            Ok(Ok(reply)) => Ok(reply),
            Ok(Err(_)) => Err(anyhow!(WORKER_SOCKET_CLOSED)),
            Err(_) => {
                // A timed-out request's reply slot must not sit in the pending map forever
                // (a wedged worker never answers).
                resident.pending.lock().await.remove(&request_id);
                Err(anyhow!("Session worker timed out"))
            }
        }
    }

    /// Route one client-facing command, waiting out an in-flight worker replacement inside
    /// the budget; only the not-connected error is retried (never duplicates a command).
    pub(crate) async fn route_command_ready(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
        command_type: &str,
        payload: Value,
        timeout_ms: u64,
        admission: RouteAdmission,
    ) -> Result<WorkerReply> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            self.await_route_ready(resident, deadline).await?;
            let remaining_ms = deadline
                .saturating_duration_since(tokio::time::Instant::now())
                .as_millis() as u64;
            let routed = if command_type == "resume_queue" {
                self.route_ready_resume(resident, payload.clone(), remaining_ms, admission)
                    .await
            } else {
                self.route_command(
                    resident,
                    command_type,
                    payload.clone(),
                    remaining_ms,
                    admission,
                )
                .await
            };
            match routed {
                // The socket died before the send: the command never reached a worker, so
                // waiting for the replacement and sending again cannot duplicate it.
                Err(error) if error.to_string() == WORKER_NOT_CONNECTED => {
                    if tokio::time::Instant::now() >= deadline
                        || resident.route_state().retired
                        || self.is_stopping(resident)
                    {
                        return Err(error);
                    }
                }
                other => return other,
            }
        }
    }

    /// Bind a resume intent to the command channel selected after readiness.
    /// A replacement can arrive while `route_command_ready` waits; pinning the
    /// channel and reading its descriptor generation together avoids storing
    /// the predecessor's identity for a request sent to the replacement.
    async fn route_ready_resume(
        &self,
        resident: &Arc<ResidentWorker>,
        mut payload: Value,
        remaining_ms: u64,
        admission: RouteAdmission,
    ) -> Result<WorkerReply> {
        let channel = resident.cmd_tx.lock().await;
        let cmd_tx = channel.clone().ok_or_else(|| anyhow!(WORKER_NOT_CONNECTED))?;
        let mut descriptor = resident.descriptor.lock().await;
        let state = resident.route_state();
        if !state.connected || !state.session_ready || state.retired || self.is_stopping(resident) {
            return Err(anyhow!(WORKER_NOT_CONNECTED));
        }
        // Client rest fields cannot choose the private checkpoint identity.
        if let Some(object) = payload.as_object_mut() {
            object.remove("resumeQueueAttemptId");
        }
        let attempt = if crate::descriptor::has_shutdown_hold(&descriptor) {
            let mut hold = crate::descriptor::shutdown_hold(&descriptor)?
                .ok_or_else(|| anyhow!("shutdown hold vanished"))?;
            let instance = descriptor
                .worker_instance_id
                .clone()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| anyhow!("Worker generation is missing for queue resume"))?;
            // Reuse a same-generation attempt after a lost ACK. A provably
            // unsent request retried on a replacement gets a new binding.
            let attempt = if hold.resume_worker_instance_id.as_deref() == Some(instance.as_str()) {
                hold.resume_attempt_id
                    .clone()
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
            } else {
                uuid::Uuid::new_v4().to_string()
            };
            hold.resume_attempt_id = Some(attempt.clone());
            hold.resume_worker_instance_id = Some(instance);
            let mut next = descriptor.clone();
            next.rest
                .insert(crate::descriptor::SHUTDOWN_HOLD_KEY.into(), json!(hold));
            crate::descriptor::persist_shutdown_boundary(&resident.descriptor_path, &next)?;
            *descriptor = next;
            attempt
        } else {
            // A live worker can also park after a session-file persist error
            // without a descriptor hold. It still needs a supervised attempt.
            uuid::Uuid::new_v4().to_string()
        };
        payload["resumeQueueAttemptId"] = json!(attempt);
        drop(descriptor);
        drop(channel);
        self.route_command_on(
            resident,
            cmd_tx,
            "resume_queue",
            payload,
            remaining_ms,
            admission,
        )
        .await
    }

    /// The typed [`Self::route_command`]: supervisor-internal forwards read the
    /// response tree, so the relayed byte path parses back here.
    pub(crate) async fn route_command_typed(
        &self,
        resident: &Arc<ResidentWorker>,
        command_type: &str,
        payload: Value,
        timeout_ms: u64,
        admission: RouteAdmission,
    ) -> Result<DaemonResponse> {
        self.route_command(resident, command_type, payload, timeout_ms, admission)
            .await?
            .typed()
    }

    /// The typed [`Self::route_command_on`]: the handshake's private-channel route.
    pub(crate) async fn route_command_on_typed(
        &self,
        resident: &Arc<ResidentWorker>,
        cmd_tx: mpsc::Sender<WorkerRequest>,
        command_type: &str,
        payload: Value,
        timeout_ms: u64,
        admission: RouteAdmission,
    ) -> Result<DaemonResponse> {
        self.route_command_on(
            resident,
            cmd_tx,
            command_type,
            payload,
            timeout_ms,
            admission,
        )
        .await?
        .typed()
    }

    /// The typed [`Self::route_command_ready`].
    pub(crate) async fn route_command_ready_typed(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
        command_type: &str,
        payload: Value,
        timeout_ms: u64,
        admission: RouteAdmission,
    ) -> Result<DaemonResponse> {
        self.route_command_ready(resident, command_type, payload, timeout_ms, admission)
            .await?
            .typed()
    }

    /// Wait until the resident is route-ready (a live connection whose session
    /// create completed), bailing fast on retired/stopping workers.
    async fn await_route_ready(
        &self,
        resident: &Arc<ResidentWorker>,
        deadline: tokio::time::Instant,
    ) -> Result<()> {
        let mut state = resident.route_state_watcher();
        loop {
            let current = *state.borrow_and_update();
            if current.connected && current.session_ready {
                return Ok(());
            }
            if current.retired || self.is_stopping(resident) {
                bail!(WORKER_NOT_CONNECTED);
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                bail!("Session worker timed out");
            }
            // Sleep until the route state moves or the deadline passes.
            match tokio::time::timeout_at(deadline, state.changed()).await {
                Ok(Ok(())) => {}
                // The resident (and its watch sender) was dropped entirely.
                Ok(Err(_)) => bail!(WORKER_NOT_CONNECTED),
                Err(_) => bail!("Session worker timed out"),
            }
        }
    }

    pub(crate) async fn route_client_command(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: &str,
        attached: &Arc<crate::supervisor::subscribers::ClientSubscriptions>,
        command_id: String,
        type_name: String,
        // The connection's raw outbound queue when the caller is the connection dispatch
        // itself; `None` (supervisor-internal callers) forces the typed path.
        raw_out: Option<&tokio::sync::mpsc::Sender<(Vec<Outbound>, bool)>>,
    ) -> (Vec<Value>, bool) {
        // Routing gate: the generic forward requires the `activeSessionId` field
        // (present-but-empty is an unknown session).
        let Some(selector) = command_active_session_id(command) else {
            return (
                vec![response_line(&response_failure(
                    Some(&command_id),
                    &type_name,
                    &format!("Supervisor cannot route daemon command: {type_name}"),
                    None,
                ))],
                false,
            );
        };
        let selector = selector.to_string();
        // The rebind target when the selector addresses a superseded id: the
        // routed command is rewritten to the current id.
        let mut rebound_to: Option<String> = None;
        let resident = if let Ok(resident) = self.registry.resolve(&selector).await {
            resident
        } else {
            // Spec §10.4: attach-by-durable-id at any time. A restore pass may still be
            // bringing the session up, so the command queues server-side behind it.
            self.await_restore_target(&selector).await;
            match self.registry.resolve(&selector).await {
                Ok(resident) => resident,
                Err(_) => {
                    // The stale-active-id rebind: the command never reached a worker, so
                    // routing once to the current resident delivers it exactly once.
                    if let Some(resident) = self.binding_target(&selector).await {
                        // A detach addressed to a superseded id has no worker to reach:
                        // forwarding it would drop the client's fresh attach, so retire
                        // the stale address here.
                        if matches!(command, DaemonCommand::Detach { .. }) {
                            attached.detach(&self.session_subscribers, &selector);
                            return (
                                vec![response_line(&response_success(
                                    Some(&command_id),
                                    &type_name,
                                    None,
                                ))],
                                false,
                            );
                        }
                        rebound_to =
                            Some(self.rebind_connection(&selector, &resident, attached).await);
                        resident
                    } else {
                        // The passivated-session surfaces (TS's
                        // whole-worker idle eviction: the worker is gone,
                        // the session file survives). A prompt-family
                        // command (or an attach) aimed at a session whose
                        // worker stopped resolves the SAVED session and
                        // wakes it (reuse a resident host, otherwise launch
                        // a fresh worker over the file — TS's tier-2
                        // relaunch); a delete's kill marker resolves the
                        // ledger edge and tombstones without a worker. A
                        // parent-directed rename must hydrate its target
                        // the same way (TS `renameAgentFamilySession`
                        // resolves through the hydrated target).
                        if matches!(
                            command,
                            DaemonCommand::Prompt { .. }
                                | DaemonCommand::PromptAndWait { .. }
                                | DaemonCommand::Steer { .. }
                                | DaemonCommand::FollowUp { .. }
                                | DaemonCommand::Attach { .. }
                                | DaemonCommand::Reattach { .. }
                                | DaemonCommand::Rename { .. }
                                | DaemonCommand::WaitForIdle { .. }
                        ) {
                            match self.wake_saved_session(&selector).await {
                                WakeRoute::Woken(resident) => {
                                    rebound_to = Some(
                                        self.rebind_connection(&selector, &resident, attached)
                                            .await,
                                    );
                                    resident
                                }
                                WakeRoute::Fallthrough(message) => {
                                    return (
                                        vec![response_line(&response_failure(
                                            Some(&command_id),
                                            &type_name,
                                            &message,
                                            None,
                                        ))],
                                        false,
                                    );
                                }
                            }
                        } else if let DaemonCommand::Kill { rest, .. } = command {
                            if let Some(reason) = rest
                                .get("rlmLedgerDelete")
                                .and_then(Value::as_str)
                                .and_then(crate::rlm_ledger::RlmLedgerDeleteReason::from_wire)
                            {
                                // The delete of a stopped child: no worker to kill — the ledger
                                // tombstone IS the deletion boundary.
                                let child_id = rest
                                    .get("rlmChildId")
                                    .and_then(Value::as_str)
                                    .map(str::to_string);
                                match self
                                    .tombstone_saved_rlm_child(
                                        &selector,
                                        child_id.as_deref(),
                                        reason,
                                    )
                                    .await
                                {
                                    Ok(()) => {
                                        return (
                                            vec![response_line(&response_success(
                                                Some(&command_id),
                                                &type_name,
                                                None,
                                            ))],
                                            false,
                                        );
                                    }
                                    Err(error) => {
                                        return (
                                            vec![response_line(&response_failure(
                                                Some(&command_id),
                                                &type_name,
                                                &format!(
                                                    "Failed to delete RLM subagent: {error:#}"
                                                ),
                                                None,
                                            ))],
                                            false,
                                        );
                                    }
                                }
                            }
                            // No delete marker: a kill of a stopped session stays the plain
                            // unknown-session error — nothing to kill.
                            let message = self
                                .restore_failure_for(&selector)
                                .unwrap_or_else(|| format!("Unknown active session: {selector}"));
                            return (
                                vec![response_line(&response_failure(
                                    Some(&command_id),
                                    &type_name,
                                    &message,
                                    None,
                                ))],
                                false,
                            );
                        } else {
                            let message = self
                                .restore_failure_for(&selector)
                                .unwrap_or_else(|| format!("Unknown active session: {selector}"));
                            return (
                                vec![response_line(&response_failure(
                                    Some(&command_id),
                                    &type_name,
                                    &message,
                                    None,
                                ))],
                                false,
                            );
                        }
                    }
                }
            }
        };
        // The plain-kill gate (TS `isRootKill`): the `rlmCloseReason` marker is a child-close
        // cascade, not a root kill. Only the plain kill tombstones and finalizes BEFORE the
        // worker is told, so a mid-stop death adopts the tombstone.
        let plain_kill = match command {
            DaemonCommand::Kill { rest, .. } => {
                let no_marker = !rest.contains_key("rlmCloseReason");
                let target_depth = resident
                    .descriptor
                    .lock()
                    .await
                    .create_command
                    .rest
                    .get("rlmDepth")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                no_marker || target_depth == 0
            }
            _ => false,
        };
        if plain_kill {
            if let Err(error) = self.persist_stop_tombstone(&resident).await {
                return (
                    vec![response_line(&response_failure(
                        Some(&command_id),
                        &type_name,
                        &format!("Failed to persist the session stop: {error:#}"),
                        None,
                    ))],
                    false,
                );
            }
        }
        // A delete's deletion boundary persists BEFORE the teardown: a failed tombstone is
        // a failed, retryable deletion; a plain stop must not tombstone the child.
        if let DaemonCommand::Kill { rest, .. } = command {
            if let Some(reason) = rest
                .get("rlmLedgerDelete")
                .and_then(Value::as_str)
                .and_then(crate::rlm_ledger::RlmLedgerDeleteReason::from_wire)
            {
                let child_id = rest
                    .get("rlmChildId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Err(error) = self
                    .tombstone_rlm_child(&resident, child_id.as_deref(), reason)
                    .await
                {
                    return (
                        vec![response_line(&response_failure(
                            Some(&command_id),
                            &type_name,
                            &format!("Failed to delete RLM subagent: {error:#}"),
                            None,
                        ))],
                        false,
                    );
                }
            }
        }
        if let DaemonCommand::Attach {
            telemetry_disabled: Some(true),
            ..
        }
        | DaemonCommand::Reattach {
            telemetry_disabled: Some(true),
            ..
        } = command
        {
            let worker_disabled = {
                let descriptor = resident.descriptor.lock().await;
                descriptor.telemetry_disabled
            };
            if worker_disabled != Some(true) {
                // A telemetry-disabled client may not attach to a worker with telemetry enabled.
                return (
                    vec![response_line(&response_failure(
                        Some(&command_id),
                        &type_name,
                        "Cannot attach to this active agent while telemetry is disabled for the current invocation. Stop the agent and retry so it can restart without telemetry.",
                        None,
                    ))],
                    false,
                );
            }
        }
        let timeout = client_route_timeout(command);
        let (worker_command, mut payload) = match client_command_payload(command, client_id) {
            Ok(payload) => payload,
            Err(error) => {
                return (
                    vec![response_line(&response_failure(
                        Some(&command_id),
                        &type_name,
                        &error.to_string(),
                        None,
                    ))],
                    false,
                )
            }
        };
        // A rebind retargets the routed frame (the worker does not know the
        // superseded id); a rebound reattach routes as the worker's attach.
        let mut worker_command = worker_command;
        if let Some(current) = &rebound_to {
            if let Some(object) = payload.as_object_mut() {
                object.insert("activeSessionId".to_string(), json!(current));
            }
            if worker_command == "reattach" {
                worker_command = "attach";
            }
        }
        // Correlate a resume only once the ready route has selected a worker
        // generation. Waiting for a replacement before this point can change
        // the generation; the send loop below binds intent to its actual channel.
        let supervised_resume = worker_command == "resume_queue";
        // `Kill` is the one client command with a durable pre-route side effect (its stop
        // tombstone), so it rides the never-refused control admission.
        let admission = match command {
            DaemonCommand::Kill { .. } => RouteAdmission::SupervisorInternal,
            _ => RouteAdmission::ClientRequest,
        };
        // TS daemon-supervisor's `routeClientCommand` wraps the live
        // `rename`/`set_session_name` forward in the name-reservation
        // ladder: name uniqueness is daemon-owned, so a session worker's
        // own rename can never mint a duplicate sibling name.
        let response = match command {
            DaemonCommand::Rename { name, .. } | DaemonCommand::SetSessionName { name, .. } => {
                match self.live_session_name_scope(&resident.worker_id, name.trim().to_string()) {
                    Ok(scope) => self
                        .with_session_name_reservation(
                            &scope,
                            self.route_command_ready(
                                &resident,
                                worker_command,
                                payload,
                                timeout,
                                admission,
                            ),
                        )
                        .await
                        .unwrap_or_else(|error| Err(anyhow!(error))),
                    Err(error) => Err(anyhow!(error)),
                }
            }
            _ => {
                self.route_command_ready(&resident, worker_command, payload, timeout, admission)
                    .await
            }
        };
        if supervised_resume {
            if let Err(error) = self.reconcile_shutdown_resume_hold(&resident).await {
                self.log_line(&format!(
                    "session worker {} queue resume hold remains pending: {error:#}",
                    resident.worker_id
                ));
            }
        }
        // The byte relay: a routed response the supervisor neither edits nor
        // inspects goes to the client as the worker's own payload bytes with
        // the client's command id spliced in front. The worker serializes
        // `response_line` (id absent), so its payload opens with
        // `"type":"response"` and the splice reproduces the exact line the
        // typed path would - without the parse, the per-key clone walk of
        // `from_value`, the `response_line` deep clone, and the re-serialize.
        // The typed path stays for every response this arm edits or reads
        // beyond the frame header's hints: the chunked-snapshot attach
        // clients, a rebound reattach (command echo rewrite), and the
        // small-payload bookkeeping commands (detach, kill, rename,
        // set_session_name, the promote-owned catalog forms). An
        // attach-family relay also needs the frame header's
        // success/activeSessionId hints for the
        // supervisor's own bookkeeping; a hint-less one falls back to the
        // typed parse so the bookkeeping never silently changes shape.
        let client_wants_chunked = match command {
            DaemonCommand::Attach { capabilities, .. }
            | DaemonCommand::Reattach { capabilities, .. } => {
                wants_chunked(&attach_client_capabilities(capabilities.as_deref()))
            }
            _ => false,
        };
        let attach_family = matches!(
            command,
            DaemonCommand::Attach { .. } | DaemonCommand::Reattach { .. }
        );
        let typed_needed = rebound_to.is_some()
            || client_wants_chunked
            || matches!(
                command,
                DaemonCommand::Detach { .. }
                    | DaemonCommand::Kill { .. }
                    | DaemonCommand::Rename { .. }
                    | DaemonCommand::SetSessionName { .. }
                    | DaemonCommand::CronAdd {
                        promote_owned_session: Some(true),
                        ..
                    }
                    | DaemonCommand::HeartbeatSet {
                        promote_owned_session: Some(true),
                        ..
                    }
            );
        let splice = match response.as_ref() {
            Ok(reply) if raw_out.is_some() => {
                // Only the response_line shape splices: prepending the id reproduces the
                // typed path's key order exactly.
                let has_payload = reply
                    .relayed_payload()
                    .is_some_and(|payload| payload.starts_with(b"{\"type\":\"response\""));
                let hints_present = !attach_family
                    || (reply.relayed_success().is_some()
                        && reply.relayed_active_session_id().is_some());
                has_payload && hints_present && !typed_needed
            }
            // No raw queue or a typed-only command: the typed path below.
            _ => false,
        };
        if splice {
            let Ok(reply) = response.as_ref() else {
                unreachable!("the splice arm only runs on an Ok reply")
            };
            let success = reply.relayed_success();
            let payload = reply.relayed_payload().unwrap_or_default();
            if success == Some(true) && attach_family {
                let active_id = reply
                    .relayed_active_session_id()
                    .map_or_else(|| resident.worker_id.clone(), str::to_string);
                self.note_daemon_event(
                    if matches!(command, DaemonCommand::Reattach { .. }) {
                        "reattach"
                    } else {
                        "attach"
                    },
                    None,
                );
                let (session_id, session_file) = {
                    let descriptor = resident.descriptor.lock().await;
                    (
                        descriptor.root_session_id.clone(),
                        descriptor.session_file.clone(),
                    )
                };
                self.record_session_binding(
                    &active_id,
                    session_id.as_deref(),
                    session_file.as_deref(),
                );
                attached.attach(&self.session_subscribers, &active_id);
            }
            let line = spliced_client_line(&command_id, payload);
            if let Some(raw_out) = raw_out {
                let _ = raw_out.send((vec![Outbound::Raw(line)], false)).await;
            }
            return (Vec::new(), false);
        }

        match response {
            Ok(reply) => {
                let mut response = reply.typed().unwrap_or_else(|_| {
                    response_failure(
                        Some(&command_id),
                        &type_name,
                        "invalid worker response",
                        None,
                    )
                });
                // Worker replies carry no client request id; clients match
                // responses by the id they sent, so stamp it back here.
                response.id = Some(command_id.clone());
                // A rebound reattach routed as the worker's attach still
                // answers as the command the client sent.
                if rebound_to.is_some() && type_name == "reattach" {
                    response.command = type_name.clone();
                }
                if let DaemonCommand::Attach { capabilities, .. }
                | DaemonCommand::Reattach { capabilities, .. } = command
                {
                    if response.success {
                        if let Some(data) = response.data.as_mut() {
                            let active_id = data
                                .get("activeSessionId")
                                .and_then(Value::as_str)
                                .map_or_else(|| resident.worker_id.clone(), str::to_string);
                            self.note_daemon_event(
                                if matches!(command, DaemonCommand::Reattach { .. }) {
                                    "reattach"
                                } else {
                                    "attach"
                                },
                                None,
                            );
                            // The binding table learns the id the worker reports (a durable-id or
                            // file-stem attach resolves to the worker's current id).
                            let (session_id, session_file) = {
                                let descriptor = resident.descriptor.lock().await;
                                (
                                    descriptor.root_session_id.clone(),
                                    descriptor.session_file.clone(),
                                )
                            };
                            self.record_session_binding(
                                &active_id,
                                session_id.as_deref(),
                                session_file.as_deref(),
                            );
                            attached.attach(&self.session_subscribers, &active_id);
                            // The client's own capability set, not the supervisor's, is echoed in
                            // the attach result.
                            let client_capabilities =
                                attach_client_capabilities(capabilities.as_deref());
                            if let Some(client) = data.get_mut("client") {
                                client["capabilities"] = json!(client_capabilities);
                            }
                            if wants_chunked(&client_capabilities) {
                                let purpose = if matches!(command, DaemonCommand::Reattach { .. }) {
                                    SnapshotPurpose::Replacement
                                } else {
                                    SnapshotPurpose::Attach
                                };
                                return streamed_attach_lines(response, &active_id, purpose);
                            }
                            return (vec![response_line(&response)], false);
                        }
                    }
                    return (vec![response_line(&response)], false);
                }
                if let DaemonCommand::Detach { .. } = command {
                    if response.success {
                        self.note_daemon_event("detach", None);
                        // The retire removes the RESIDENT's active id — the id the attached list
                        // actually holds (the selector may be a durable-id alias). The registry
                        // entry goes first: delivery stops at the detach instant.
                        attached.detach(&self.session_subscribers, &resident.worker_id);
                    }
                }
                if let DaemonCommand::Kill { rest, .. } = command {
                    // TS's root-kill `finally`: the stop completes on a rejected or timed-out
                    // forward too; the marker-carrying child closes keep the success gate.
                    if plain_kill {
                        self.finish_plain_kill_stop(&resident, rest).await;
                    } else if response.success {
                        // A cascade-stop failure is observable (logged) instead of silently
                        // skipping the retire/registry/passivation tail.
                        if let Err(error) = self.stop_worker(&resident).await {
                            self.log_line(&format!(
                                "session worker {} stop after kill failed: {error:#}; the tombstoned descriptor holds the stop for the next boot",
                                resident.worker_id
                            ));
                        }
                    }
                }
                if let DaemonCommand::Rename { name, .. }
                | DaemonCommand::SetSessionName { name, .. } = command
                {
                    // A subagent rename is durable in the ledger, so the
                    // passive roster keeps the new name after passivation.
                    // The TS worker appends it in `applyStateSessionName`
                    // for both commands; the Rust port keeps the one
                    // supervisor-side block.
                    if response.success {
                        let descriptor = resident.descriptor.lock().await;
                        let is_child = descriptor
                            .create_command
                            .rest
                            .get("rlmDepth")
                            .and_then(Value::as_u64)
                            .unwrap_or(0)
                            >= 1;
                        let session_file = descriptor.session_file.clone();
                        drop(descriptor);
                        if is_child {
                            if let Some(session_file) = session_file {
                                if let Ok(ledger) = self.rlm_spawn_ledger_for(None).await {
                                    if let Err(error) =
                                        ledger.append_rename_by_child_path(&session_file, name)
                                    {
                                        self.log_line(&format!(
                                            "failed to append RLM ledger rename: {error:#}"
                                        ));
                                    }
                                }
                            }
                        }
                    }
                }
                (vec![response_line(&response)], false)
            }
            Err(error) => {
                // TS's root-kill `finally` runs its stop on a thrown forward as well, so the
                // lease cannot outlive the command; child closes keep the plain forward.
                if plain_kill {
                    if let DaemonCommand::Kill { rest, .. } = command {
                        self.finish_plain_kill_stop(&resident, rest).await;
                    }
                }
                (
                    vec![response_line(&response_failure(
                        Some(&command_id),
                        &type_name,
                        &error.to_string(),
                        None,
                    ))],
                    false,
                )
            }
        }
    }

    /// The saved-session wake for a passivated session (TS's tier-2 relaunch); a selector
    /// that resolves to no saved session falls through to the unknown-session error.
    pub(super) async fn wake_saved_session(self: &Arc<Self>, selector: &str) -> WakeRoute {
        let resolve_error = anyhow!("Unknown active session: {selector}");
        match self.wake_saved_target(&resolve_error, selector, None).await {
            crate::messaging::WakeOutcome::Woken(resident) => WakeRoute::Woken(resident),
            crate::messaging::WakeOutcome::Unknown => {
                // The routing selector is the session's ACTIVE id (the registry key), which
                // the catalog and ledger edges do not carry — the ROSTER row does.
                match self.wake_roster_session(selector).await {
                    Some(crate::messaging::WakeOutcome::Woken(resident)) => {
                        WakeRoute::Woken(resident)
                    }
                    Some(crate::messaging::WakeOutcome::Failed(message)) => {
                        WakeRoute::Fallthrough(message)
                    }
                    Some(crate::messaging::WakeOutcome::Unknown) | None => WakeRoute::Fallthrough(
                        self.restore_failure_for(selector)
                            .unwrap_or_else(|| format!("Unknown active session: {selector}")),
                    ),
                }
            }
            crate::messaging::WakeOutcome::Failed(message) => WakeRoute::Fallthrough(message),
        }
        // The command itself is untouched: the caller rebinds and routes it to the
        // woken resident (the prompt lands as the next turn on the replayed file).
    }

    /// The roster-row wake: a passive (or live-but-unregistered) row carrying
    /// this active session id names the session file to launch a worker over.
    async fn wake_roster_session(
        self: &Arc<Self>,
        selector: &str,
    ) -> Option<crate::messaging::WakeOutcome> {
        let mut files: Vec<String> = {
            let roster = self.roster.lock().unwrap();
            roster
                .by_active_session_id(selector)
                .map(|row| {
                    row.summary
                        .get("sessionFile")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .into_iter()
                .flatten()
                .collect()
        };
        files.sort();
        files.dedup();
        let session_file = files.first()?.clone();
        // The passive row's durable summary carries the child identity: the depth + agent id
        // ride the create's rest (without `rest.rlmDepth` the revived child never re-passivates).
        let (depth, child_id) = {
            let roster = self.roster.lock().unwrap();
            roster
                .by_active_session_id(selector)
                .map_or((0, String::new()), |row| {
                    (
                        row.summary
                            .get("rlmDepth")
                            .and_then(Value::as_u64)
                            .unwrap_or_default(),
                        row.summary
                            .get("agentId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    )
                })
        };
        let cwd = crate::session_store::read_session_info(std::path::Path::new(&session_file))
            .map_or_else(|| "/".to_string(), |info| info.cwd);
        // The identity rides `config.rlmDepth` + `runtime_metadata.rlmChildId` —
        // the keys launch_worker copies into the DURABLE create command's rest.
        let create = DaemonCommand::Create {
            id: None,
            session_path: Some(session_file.clone()),
            continue_recent: Some(false),
            no_session: None,
            name: None,
            config: Some(json!({ "cwd": cwd, "rlmDepth": depth })),
            telemetry_disabled: None,
            runtime_metadata: Some(json!({ "rlmChildId": child_id })),
            lifecycle: None,
            env: None,
            launch_env: None,
            rest: serde_json::Map::default(),
        };
        // Reuse before launching (TS `createOrReuseWorker`): a concurrent revival
        // may already host the file.
        if let Some(resident) = self.registry.find_by_session_file(&session_file).await {
            return Some(crate::messaging::WakeOutcome::Woken(resident));
        }
        // The caller's route budget bounds the WAIT, not the launch: the launch detaches and
        // runs to completion; a timeout tries the join lookup first.
        let launch = tokio::spawn({
            let supervisor = Arc::clone(self);
            let create = create;
            async move { supervisor.launch_worker(&create, None).await }
        });
        let launched =
            tokio::time::timeout(std::time::Duration::from_millis(ROUTE_TIMEOUT_MS), launch).await;
        match launched {
            Ok(Ok(Ok((resident, _create_summary)))) => {
                self.refresh_roster_entry(&resident).await;
                Some(crate::messaging::WakeOutcome::Woken(resident))
            }
            Ok(Ok(Err(error))) => {
                // The check-and-launch race: the rival wins the session lease while this launch
                // runs, so the loser joins the rival's resident instead of failing its command.
                if let Some(resident) = self.registry.find_by_session_file(&session_file).await {
                    return Some(crate::messaging::WakeOutcome::Woken(resident));
                }
                Some(crate::messaging::WakeOutcome::Failed(format!("{error:#}")))
            }
            Ok(Err(join_error)) => Some(crate::messaging::WakeOutcome::Failed(format!(
                "the revival launch task: {join_error}"
            ))),
            Err(_budget) => {
                if let Some(resident) = self.registry.find_by_session_file(&session_file).await {
                    return Some(crate::messaging::WakeOutcome::Woken(resident));
                }
                Some(crate::messaging::WakeOutcome::Failed(
                    "the revival launch exceeded the route budget; retry the command".to_string(),
                ))
            }
        }
    }

    /// The ledger tombstone for a delete aimed at a STOPPED child: no worker to kill, the
    /// tombstone IS the deletion boundary, persisted before any teardown.
    pub(super) async fn tombstone_saved_rlm_child(
        self: &Arc<Self>,
        selector: &str,
        child_id: Option<&str>,
        reason: crate::rlm_ledger::RlmLedgerDeleteReason,
    ) -> anyhow::Result<()> {
        let ledger = self
            .rlm_spawn_ledger_for(None)
            .await
            .with_context(|| "resolve the spawn ledger sessions dir".to_string())?;
        // The child's identity: the explicit id the parent's delete carries, else
        // the live ledger edge matching the selector.
        let edges = ledger
            .live_edges()
            .with_context(|| "read the spawn ledger edges".to_string())?;
        // `rlmChildId` is the durable key; the selector is the child's LIVE id, NOT
        // the file stem. Order: (1a) edge matching BOTH the stem and the id; (1b)
        // the LAST live edge carrying the id; (2) the stem-matching edge.
        let mut resolved: Option<(String, String)> = None;
        if let Some(id) = child_id {
            for edge in &edges {
                let stem = std::path::Path::new(&edge.child)
                    .file_stem()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default();
                if stem == selector && edge.child_id == id {
                    resolved = Some((edge.child_id.clone(), edge.child.clone()));
                    break;
                }
            }
            if resolved.is_none() {
                for edge in &edges {
                    if edge.child_id == id {
                        resolved = Some((edge.child_id.clone(), edge.child.clone()));
                    }
                }
            }
        } else {
            for edge in &edges {
                let stem = std::path::Path::new(&edge.child)
                    .file_stem()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default();
                if stem == selector {
                    resolved = Some((edge.child_id.clone(), edge.child.clone()));
                    break;
                }
            }
        }
        let Some((child_id, session_file)) = resolved else {
            anyhow::bail!("stopped RLM subagent \"{selector}\" is not in the spawn ledger");
        };
        ledger
            .append_delete(&child_id, &session_file, reason)
            .with_context(|| format!("tombstone RLM subagent {child_id}"))?;
        // The stopped child's teardown mirrors the resident delete's end state: the usage
        // capture, archived state, and artifact sweep land as a live child's kill leaves them.
        let sessions_dir = crate::paths::sessions_dir(&self.options.agent_dir)
            .with_context(|| "resolve the sessions dir for the delete finalize".to_string())?;
        // Live coverage captured AFTER the tombstone append: a wake that registered a resident
        // between the two must be visible here (the archive/sweep skips its tree).
        let live = self.live_session_files().await;
        if self
            .registry
            .find_by_session_file(&session_file)
            .await
            .is_some()
        {
            // A revival raced the delete: the tombstone stands as the durable boundary, but the
            // revived session stays live — no archive, no artifact sweep.
            return Ok(());
        }
        crate::stop_cleanup::finalize_archived_stop(
            &self.options.agent_dir,
            &sessions_dir,
            std::path::Path::new(&session_file),
            &live,
        );
        self.capture_deleted_child_usage(&session_file, &child_id, "rlm_delete")
            .await;
        crate::saved_session_commands::remove_session_artifacts(std::path::Path::new(
            &session_file,
        ));
        // The resident delete's end state, continued: no stop ran for
        // this child (its worker was already passivated), so the
        // passivation's row lingers unowned while the bucket bills the
        // captured spend on the parent - the same settle the resident
        // delete's pass performs, in one push.
        let changed = self.refresh_deleted_descendant_usage().await;
        let canonical = crate::lease::canonical_session_path(std::path::Path::new(&session_file))
            .to_string_lossy()
            .to_string();
        let removed: Vec<String> = {
            let mut roster = self.roster.lock().unwrap();
            let agent_id = roster
                .by_session_file(&canonical)
                .map(|row| row.agent_id.clone());
            if let Some(agent_id) = &agent_id {
                roster.delete(agent_id);
            }
            agent_id.into_iter().collect()
        };
        self.push_roster_update(changed, removed);
        Ok(())
    }
}

/// The client response line for one relayed worker payload: the worker's
/// own `response_line` bytes with the client's command id spliced in front.
pub(crate) fn spliced_client_line(command_id: &str, worker_payload: &[u8]) -> Vec<u8> {
    let mut line = Vec::with_capacity(command_id.len() + worker_payload.len() + 8);
    line.extend_from_slice(b"{\"id\":");
    serde_json::to_writer(&mut line, &Value::String(command_id.to_string()))
        .expect("a command id serializes");
    line.extend_from_slice(b",");
    if worker_payload.first() == Some(&b'{') {
        line.extend_from_slice(&worker_payload[1..]);
    } else {
        line.extend_from_slice(worker_payload);
    }
    line.push(b'\n');
    line
}
