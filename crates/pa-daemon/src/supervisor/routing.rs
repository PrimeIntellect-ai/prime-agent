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
/// The route failure for a worker whose command channel is gone (never
/// connected, or the writer pump broke on a dead socket): the request did
/// not leave the supervisor, so the replacement-aware route may retry it
/// against the next connection without risking a duplicate landing.
pub(crate) const WORKER_NOT_CONNECTED: &str = "Session worker is not connected";

/// Resolve a pending request whose frame provably never reached the worker
/// (a failed frame write, or a request still queued when the writer pump
/// ended) with the not-connected failure: `route_command` surfaces it as
/// the unambiguous retryable error, never as an ambiguous timeout.
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
pub(crate) const LONG_ROUTE_TIMEOUT_MS: u64 = 600_000;

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

    /// Route one command over an explicit worker channel: the handshake's
    /// own private channel (a connect holds its channel until the auth
    /// answer installs it for routing — see `connect_worker`), or the
    /// resident's installed channel via [`Self::route_command`]. The
    /// admission, enqueue, and reply-wait semantics are one
    /// implementation: only the channel differs.
    pub(crate) async fn route_command_on(
        &self,
        resident: &Arc<ResidentWorker>,
        cmd_tx: mpsc::Sender<WorkerRequest>,
        command_type: &str,
        payload: Value,
        timeout_ms: u64,
        admission: RouteAdmission,
    ) -> Result<WorkerReply> {
        // Bounded admission (the Codex request/await split): a client's
        // request-shaped command answers the explicit overload refusal
        // the moment the worker's in-flight bound is full — nothing is
        // queued and nothing is dropped, so the caller's retry cannot
        // duplicate the command; supervisor-internal traffic waits for a
        // slot inside the route's own budget, so control-plane routes are
        // never refused. The whole route — admission, enqueue, and reply
        // waits — never exceeds the caller's budget.
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        // The semaphore methods take their Arc by value (the permit owns
        // it for its lifetime), so the route hands them a strong reference
        // of their own.
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
                    // Both remaining shapes are budget exhaustion: the
                    // wait elapsed, or the semaphore closed with its
                    // resident. The budget error is the same one a wedged
                    // worker's silent route produces.
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
        // The enqueue seam of the bounded queue (the Codex full-queue
        // answer, `mod.rs:228-259`): a full channel means the writer pump
        // is wedged — parked frames whose routes already timed out freed
        // their permits, so a slot can be free while the queue is not. A
        // client command answers the same explicit overload refusal there;
        // supervisor-internal traffic instead waits out the remaining
        // budget (never refused, never silently dropped — the cancelled
        // send enqueues nothing, so the refused request provably never
        // left the supervisor and a retry cannot duplicate it).
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
            // The writer pump resolves provably-unsent requests with the
            // not-connected failure: surface it as the retryable route
            // error instead of a worker response. Only a typed reply can
            // carry that marker (the supervisor itself produces it), so
            // relayed bytes pass through untouched.
            Ok(Ok(WorkerReply::Typed(response)))
                if !response.success && response.error.as_deref() == Some(WORKER_NOT_CONNECTED) =>
            {
                Err(anyhow!(WORKER_NOT_CONNECTED))
            }
            Ok(Ok(reply)) => Ok(reply),
            Ok(Err(_)) => Err(anyhow!("Session worker dropped the request")),
            Err(_) => {
                // A timed-out request's reply slot must not sit in the
                // pending map forever (a wedged worker never answers, and
                // repeated bounded-timeout routes would otherwise grow the
                // map without bound).
                resident.pending.lock().await.remove(&request_id);
                Err(anyhow!("Session worker timed out"))
            }
        }
    }

    /// Route one client-facing command to a resident worker, waiting out an
    /// in-flight worker replacement (crash backoff, relaunch, create
    /// replay) inside the caller's own timeout budget instead of failing
    /// into the dead window: a child's detached task prompt that fires while
    /// its worker is being replaced must land exactly once, never bounce
    /// off a dead socket and never overtake the replayed session into
    /// existence. The wait ends only once the replacement's create replay
    /// completed; a send that fails with the unambiguous not-connected
    /// error (the request never left the supervisor) is retried against the
    /// next connection, while ambiguous failures (timeouts, dropped
    /// replies) are returned as-is so a possibly-processed command is
    /// never duplicated. The [`RouteAdmission`] overload refusal passes
    /// through untouched: the request never left the supervisor, and the
    /// caller — not this loop — owns the retry (a saturated worker stays
    /// saturated for the remainder of the budget).
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
            match self
                .route_command(
                    resident,
                    command_type,
                    payload.clone(),
                    remaining_ms,
                    admission,
                )
                .await
            {
                // The socket died between the liveness check and the send
                // (or the writer pump broke on an earlier request): the
                // command never reached a worker, so waiting for the
                // replacement and sending again cannot duplicate it.
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

    /// The typed [`Self::route_command`]: supervisor-internal forwards read
    /// the response tree, so the relayed byte path parses back here (the
    /// payloads those routes carry are small).
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

    /// The typed [`Self::route_command_on`]: the handshake's private-channel
    /// route with the response tree parsed back.
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

    /// The typed [`Self::route_command_ready`]: the replacement-aware route
    /// with the response tree parsed back for callers that read it.
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

    /// Wait until the resident is route-ready (a live connection whose
    /// session create completed), bailing fast on retired/stopping workers
    /// and on the deadline otherwise.
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
        // The connection's raw outbound queue, when the caller is the
        // client connection dispatch itself: the byte relay hands the
        // spliced line to the connection writer directly. `None` (the
        // supervisor-internal callers) forces the typed path - their
        // responses are small and their callers read the returned lines.
        raw_out: Option<&tokio::sync::mpsc::Sender<(Vec<Outbound>, bool)>>,
    ) -> (Vec<Value>, bool) {
        // TS routing gate: the generic forward requires the
        // `activeSessionId` field (present-but-empty is an unknown session,
        // the same error TS `findWorkerForClient` produces). A command that
        // addresses no session and has no supervisor arm here cannot be
        // routed - the TS arms for the optional-selector commands
        // (agent_messages_*, cron_*, heartbeats_list, detach-all,
        // saved-session renames/deletes) land with their breadth waves.
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
        // The rebind target when the selector addresses a superseded id: a
        // binding whose session has a live resident again (a new worker took
        // the session file over). The routed command is rewritten to the
        // current id, so the rest of this route - and the response handling
        // below - addresses the session's current worker.
        let mut rebound_to: Option<String> = None;
        let resident = if let Ok(resident) = self.registry.resolve(&selector).await {
            resident
        } else {
            // Spec §10.4: attach-by-durable-id at any time. A restore
            // pass may still be bringing the rostered session up, so
            // the command queues server-side behind the pass (no
            // client-visible retry); a settled restore answers with the
            // per-row failure (session file + manual-resume hint)
            // instead of the plain unknown-session error.
            self.await_restore_target(&selector).await;
            match self.registry.resolve(&selector).await {
                Ok(resident) => resident,
                Err(_) => {
                    // The stale-active-id rebind: the selector is a
                    // superseded id the binding table still maps to the
                    // session's durable identity, and a live resident
                    // owns that identity now. The command failed before
                    // it ever reached a worker, so routing it once to
                    // the current resident delivers it exactly once.
                    if let Some(resident) = self.binding_target(&selector).await {
                        // A detach addressed to a superseded id has
                        // no worker to reach: the stale worker is
                        // gone (its client-side state died with it),
                        // and forwarding the detach to the
                        // replacement would drop the very attach
                        // the client may have just established there
                        // (the worker keys its detach by client). The
                        // supervisor retires the stale address
                        // itself and answers the detach.
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
                        // ledger edge and tombstones without a worker.
                        if matches!(
                            command,
                            DaemonCommand::Prompt { .. }
                                | DaemonCommand::PromptAndWait { .. }
                                | DaemonCommand::Steer { .. }
                                | DaemonCommand::FollowUp { .. }
                                | DaemonCommand::Attach { .. }
                                | DaemonCommand::Reattach { .. }
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
                                // The delete of a stopped child: no worker
                                // to kill — the ledger tombstone IS the
                                // deletion boundary (TS
                                // `recordRlmSubagentDeletion` without a
                                // stop).
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
                            // The fallthrough (no delete marker): the plain
                            // unknown-session error — a kill of a stopped
                            // session without the marker stays an error,
                            // nothing to kill.
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
        // A kill is the worker's own root kill (TS `isRootKill`) — a
        // parent's child-close cascade carries the `rlmCloseReason` marker
        // and is NOT one (TS forwards a child close without a supervisor
        // stop): only the plain kill tombstones and finalizes. The stop
        // tombstone persists BEFORE the worker is told (TS
        // `persistWorkerStopTombstone(worker, true)`), so a supervisor that
        // dies mid-stop adopts the tombstone instead of relaunching the
        // killed worker, and the durable half of the stop (the session
        // tree's scheduled-job cancel + the `archived` state belt) re-runs.
        // The plain-kill gate (TS `isRootKill`): the `rlmCloseReason`
        // marker is the parent's child-close cascade and only ever targets
        // a subagent session — a top-level target is ALWAYS a plain kill
        // regardless of the wire marker (a client cannot forge the softer
        // close semantics for a root session; the finalize belt below
        // cancels its jobs and archives its file either way).
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
        // A delete flows through the kill route with the `rlmLedgerDelete`
        // marker (the parent-side `delete_subagent`). The deletion boundary
        // is persisted BEFORE the teardown (TS `recordRlmSubagentDeletion`):
        // a failed tombstone is a failed deletion with the child still
        // alive and retryable; a plain stop carries no marker and must not
        // tombstone the child - its passive row survives the stop.
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
                // TS `assertTelemetryAttachAllowed`: a telemetry-disabled
                // client may not attach to a worker running with telemetry
                // enabled.
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
        let timeout = if matches!(
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
            LONG_ROUTE_TIMEOUT_MS
        } else {
            ROUTE_TIMEOUT_MS
        };
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
        // A rebind retargets the routed frame: the worker reads the session
        // selector the payload carries, and the superseded id is not one it
        // knows. A rebound reattach routes as the worker's attach - the
        // worker has no reattach arm; the reattach semantics (detach-mark
        // clearing, replacement snapshot purpose) live supervisor-side.
        let mut worker_command = worker_command;
        if let Some(current) = &rebound_to {
            if let Some(object) = payload.as_object_mut() {
                object.insert("activeSessionId".to_string(), json!(current));
            }
            if worker_command == "reattach" {
                worker_command = "attach";
            }
        }
        // Client-facing routes wait out an in-flight worker replacement
        // inside the command's own budget: a command aimed at a worker that
        // crashed and is being relaunched (crash backoff, relaunch, create
        // replay) must not be lost to the dead window, and must never
        // overtake the replayed session into existence. `Kill` is the one
        // client command with a durable pre-route side effect — its stop
        // tombstone persists before the route — so it rides the
        // never-refused control admission: a saturation refusal ("nothing
        // happened, retry") would contradict the landed tombstone, while
        // the budget-bounded wait keeps the route's honest timeout shape.
        let admission = match command {
            DaemonCommand::Kill { .. } => RouteAdmission::SupervisorInternal,
            _ => RouteAdmission::ClientRequest,
        };
        let response = self
            .route_command_ready(&resident, worker_command, payload, timeout, admission)
            .await;
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
        // small-payload bookkeeping commands (detach, kill, rename, the
        // promote-owned catalog forms). An attach-family relay also needs
        // the frame header's success/activeSessionId hints for the
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
                // Only the response_line shape splices: an object that opens
                // with the response tag carries no id field, so prepending
                // one reproduces the typed path's key order exactly.
                let has_payload = reply
                    .relayed_payload()
                    .is_some_and(|payload| payload.starts_with(b"{\"type\":\"response\""));
                let hints_present = !attach_family
                    || (reply.relayed_success().is_some()
                        && reply.relayed_active_session_id().is_some());
                has_payload && hints_present && !typed_needed
            }
            // No raw queue (a supervisor-internal caller) or a typed-only
            // command: the typed path below.
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
                            // The binding table learns the id the worker
                            // reports (a durable-id or file-stem attach
                            // resolves to the worker's current id), keyed
                            // by the session's durable identity.
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
                            // The client's own capability set, not the
                            // supervisor's worker-facing one, is echoed in
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
                        // The retire removes the RESIDENT's active id - the
                        // id the attached list actually holds (the selector
                        // may be a durable-id alias for the same session).
                        // A rebound detach never reaches this handler; the
                        // rebind seam retires its superseded address itself.
                        // The registry entry goes first: delivery stops at
                        // the detach instant (TS send-time semantics).
                        attached.detach(&self.session_subscribers, &resident.worker_id);
                    }
                }
                if let DaemonCommand::Kill { rest, .. } = command {
                    // TS's root-kill block wraps the forward in a `finally`
                    // (daemon-supervisor.ts: `try { response = await
                    // this.forwardToWorker(...) } finally { await
                    // this.stopWorker(...) }`): the stop completes on a
                    // rejected or timed-out forward too — a worker that
                    // ignores the routed kill would otherwise keep its
                    // session lease behind a route that never answers (the
                    // supervisor lives, so no supervisor-lost GC fires) and
                    // the escalation in `retire_worker_after_stop` would
                    // never run. The marker-carrying child closes keep the
                    // success gate: TS forwards them without a stop, and a
                    // failed cascade is the parent's retry, not a stop.
                    if plain_kill {
                        self.finish_plain_kill_stop(&resident, rest).await;
                    } else if response.success {
                        // The cascade stop: a failure is observable (logged)
                        // instead of silently skipping the
                        // retire/registry/passivation tail — the boot's
                        // tombstoned-stop finalization owns whatever this
                        // pass could not finish.
                        if let Err(error) = self.stop_worker(&resident).await {
                            self.log_line(&format!(
                                "session worker {} stop after kill failed: {error:#}; the tombstoned descriptor holds the stop for the next boot",
                                resident.worker_id
                            ));
                        }
                    }
                }
                if let DaemonCommand::Rename { name, .. } = command {
                    // A subagent rename is durable in the ledger, so the
                    // passive roster keeps the new name after passivation.
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
                // TS's root-kill `finally` runs its stop on a thrown
                // forward as well (a hung worker never answers the routed
                // kill): the stop escalates — the bounded `shutdown` route,
                // then `retire_worker_after_stop`'s SIGTERM -> SIGKILL ->
                // hard-deadline pass — so the stopped worker's session
                // lease cannot outlive the command. The marker-carrying
                // child closes keep TS's plain forward: a failed cascade is
                // the parent's retry.
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

    /// The saved-session wake for a passivated (worker-stopped) session
    /// (TS's tier-2 relaunch: `matchWorkers` misses -> resolve the
    /// session path -> `launchWorker` over the file). Reuses the
    /// messaging wake's resolution and reuse-or-launch; a selector that
    /// resolves to no saved session (or a ledger miss) falls through to
    /// the caller's unknown-session error, so only resolvable sessions
    /// ever wake.
    pub(super) async fn wake_saved_session(self: &Arc<Self>, selector: &str) -> WakeRoute {
        let resolve_error = anyhow!("Unknown active session: {selector}");
        match self.wake_saved_target(&resolve_error, selector, None).await {
            crate::messaging::WakeOutcome::Woken(resident) => WakeRoute::Woken(resident),
            crate::messaging::WakeOutcome::Unknown => {
                // The routing selector is the session's ACTIVE id (the
                // registry key), which the saved-session catalog and the
                // ledger edges do not carry — the ROSTER row does (the
                // passive row keeps the durable fields, `sessionFile`
                // included): resolve the active id through the roster
                // and launch a worker over the row's session file.
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
        // The command itself is untouched: the caller rebinds and routes
        // it to the woken resident (the create replay restored the
        // session; the prompt lands as the next turn on the replayed
        // file, exactly like TS).
    }

    /// The roster-row wake: one passive (or live-but-unregistered) row
    /// carrying this active session id names the session file to launch
    /// a worker over (the passivated child's revival path).
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
        // The passive row's durable summary carries the child identity:
        // the depth + the agent id ride the create's rest so the revived
        // worker keeps them (the supervisor's parent-owned passivation
        // fence reads `rest.rlmDepth` - without it the revived child
        // never re-passivates).
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
        // The identity rides `config.rlmDepth` + `runtime_metadata.rlmChildId`
        // - the keys launch_worker copies into the DURABLE create command's
        // rest (the parent-owned passivation fence reads that rest; a bare
        // create `rest` is never read on this path).
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
        // Reuse before launching (TS `createOrReuseWorker`): a concurrent
        // revival — or the resident the previous wake launched — may
        // already host the file.
        if let Some(resident) = self.registry.find_by_session_file(&session_file).await {
            return Some(crate::messaging::WakeOutcome::Woken(resident));
        }
        // The caller's route budget bounds the WAIT, not the launch
        // (the round-7 bots' finding: dropping the future skipped the
        // launch's own cleanup): the launch detaches and runs to
        // completion; a timeout tries the join lookup first and answers
        // with the retryable budget note otherwise.
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
                // The check-and-launch race (two concurrent prompt/
                // attach wakes for the same passivated row): the rival
                // wins the session lease while this launch runs, so the
                // loser joins the rival's registered resident instead
                // of failing its command (TS's in-flight-join revival
                // semantics, `hydratePassiveRlmSubagent`'s single-flight
                // outcome).
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

    /// The ledger tombstone for a delete aimed at a STOPPED child (the
    /// passivation-aware delete: no worker to kill, the tombstone IS the
    /// deletion boundary). Resolves the child's session file and identity
    /// from the spawn ledger's live edges (the same resolution the
    /// messaging wake uses for child selectors), then appends the delete
    /// tombstone - the durable boundary TS `recordRlmSubagentDeletion`
    /// persists before any teardown.
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
        // The child's identity: the explicit id the parent's delete
        // carries, else the live ledger edge matching the selector (the
        // child's session id is the edge's child path stem).
        let edges = ledger
            .live_edges()
            .with_context(|| "read the spawn ledger edges".to_string())?;
        // The resolution (the fresh bots' never-matches finding): an
        // explicit `rlmChildId` is the durable key, and the routed
        // selector is the child's LIVE id - NOT the file stem - so the
        // stem==selector arm alone never fired. The order: (1a) the edge
        // matching BOTH the stem and the id (a stem-shaped caller never
        // tombstones an unrelated edge sharing the id); (1b) the LAST
        // live edge carrying the id (the live-id callers; a replaced
        // child's newest edge wins); (2) without the id, the
        // stem-matching edge (the ledger-edge fallback).
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
        // The stopped child's teardown mirrors the resident delete's end
        // state (the second bot round's leftover-partition finding): no
        // worker to finalize — the tombstone is the deletion boundary —
        // but the usage capture, the archived state, and the artifact
        // sweep must land the way a live child's kill route leaves them.
        let sessions_dir = crate::paths::sessions_dir(&self.options.agent_dir)
            .with_context(|| "resolve the sessions dir for the delete finalize".to_string())?;
        // The live coverage captured AFTER the tombstone append: a wake
        // that registered a resident for this child between the append
        // and the finalize must be visible here (the revived worker's
        // tree is covered - the archive/sweep skips it exactly like the
        // resident delete's covered-tree belt).
        let live = self.live_session_files().await;
        if self
            .registry
            .find_by_session_file(&session_file)
            .await
            .is_some()
        {
            // A revival raced the delete: the tombstone stands as the
            // durable boundary, but the revived worker's session stays
            // live - no archive, no artifact sweep.
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
/// The worker serializes its responses with the id field absent, so the
/// payload opens with `"type":"response"` and the splice reproduces the
/// exact bytes the typed path's `response_line` -> `to_string` round trip
/// emits. The trailing newline is part of the line.
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
