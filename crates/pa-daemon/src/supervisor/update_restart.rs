//! The update/restart flow: prepare/commit/abort transactions, the prepared
//! dir + watchdog, exit-for-update, and the attach-stream salvage helpers.
use super::{
    anyhow, build_update_roster, join_all, json, marker_expires_at_iso, paths, response_failure,
    response_line, response_success, stop_workers_gracefully, stream_attach, supervisor_identity,
    util, write_prepared_artifacts, AbortOutcome, Arc, BeginOutcome, ClientRouting, DaemonCommand,
    DaemonErrorInfo, DaemonResponse, Duration, Map, Ordering, Path, PathBuf, PrepareOp, Result,
    RouteAdmission, SnapshotPurpose, Supervisor, UpdateId, UpdatePreparedMarker,
    UpdateRosterInputs, Value, WorkerSnapshot, WorkerStopVerdict, DAEMON_APP_VERSION,
    WORKER_REQUEST_TIMEOUT_MS,
};

pub(super) fn streamed_attach_lines(
    mut response: DaemonResponse,
    active_session_id: &str,
    purpose: SnapshotPurpose,
) -> (Vec<Value>, bool) {
    let Some(data) = response.data.take() else {
        return (vec![response_line(&response)], false);
    };
    match stream_attach(data, active_session_id, purpose) {
        Ok((streamed, events)) => {
            response.data = Some(streamed);
            let mut lines = vec![response_line(&response)];
            lines.extend(events.lines());
            (lines, false)
        }
        // The snapshot could not even be identified: the attach itself
        // fails, before any snapshot record exists on the wire.
        Err(error) => (
            vec![response_line(&response_failure(
                response.id.as_deref(),
                &response.command,
                &error.to_string(),
                None,
            ))],
            false,
        ),
    }
}

/// The request id of an unparsable line, so the failure stays matchable by
/// the client (TS `salvageDaemonCommandId`).
pub(super) fn salvage_id(line: &str) -> Option<String> {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| value.get("id").and_then(Value::as_str).map(str::to_string))
}

/// The command type of an unparsable line, salvaged for the failure echo
/// (bare commands carry the type at the top level; envelopes nest it).
pub(super) fn salvage_command_type(line: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    value
        .get("command")
        .unwrap_or(&value)
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_string)
}

impl Supervisor {
    /// `prepare_update_restart`: accept or poll the prepare transaction.
    ///
    /// The RPC contract: a new `updateId` starts the transaction and waits
    /// for the mutation drain, then reports `fenced`; a repeat with the same
    /// id reports the current state (the poll never extends the budget); a
    /// different id is refused (the coordinator maps the refusal to `Join`).
    /// Any failure aborts the transaction - rollback is the default, the
    /// supervisor returns to `Serving`, and nothing is left half-prepared.
    pub(super) async fn handle_prepare_update_restart(
        self: &Arc<Self>,
        command_id: &str,
        type_name: &str,
        command: &DaemonCommand,
    ) -> DaemonResponse {
        let DaemonCommand::PrepareUpdateRestart { update_id, .. } = command else {
            return response_failure(
                Some(command_id),
                type_name,
                "not a prepare_update_restart command",
                None,
            );
        };
        let Some(update_id) = update_id.clone().map(UpdateId::from) else {
            return response_failure(
                Some(command_id),
                type_name,
                "prepare_update_restart requires an updateId",
                None,
            );
        };
        let now = util::now_ms();
        match self
            .update_prepare
            .begin(update_id.clone(), now, &self.update_budget)
        {
            BeginOutcome::Refused { active_update_id } => response_failure(
                Some(command_id),
                type_name,
                "Daemon is already preparing an update restart",
                Some(DaemonErrorInfo::UpdatePrepareRefused {
                    active_update_id: active_update_id.0,
                }),
            ),
            BeginOutcome::AlreadyActive {
                state,
                accepted_at_ms,
            } => response_success(
                Some(command_id),
                type_name,
                Some(json!({
                    "updateId": update_id,
                    "state": state.wire_name(),
                    "acceptedAt": util::iso_from_unix_ms(accepted_at_ms),
                })),
            ),
            BeginOutcome::Started {
                accepted_at_ms,
                prepare_deadline_ms,
            } => {
                // Draining: wait for in-flight mutations within the hard
                // deadline, then report the fenced state.
                let deadline = tokio::time::Instant::now()
                    + Duration::from_millis(prepare_deadline_ms.saturating_sub(now));
                if let Err(error) = self.mutation_drain.wait_for_drain(0, deadline).await {
                    if let Some(abort) = self.update_prepare.abort(&update_id) {
                        self.finish_update_abort(&abort);
                    }
                    return response_failure(Some(command_id), type_name, &error.to_string(), None);
                }
                match self.update_prepare.drain_complete(&update_id) {
                    PrepareOp::Applied(_) => {
                        // Fenced: snapshot every resident worker, assemble
                        // the roster, write the prepared artifacts (fsync),
                        // and reach Prepared - all inside the remaining
                        // prepare budget (spec §5, slice 3).
                        match self
                            .complete_update_prepare(
                                &update_id,
                                command,
                                accepted_at_ms,
                                prepare_deadline_ms,
                            )
                            .await
                        {
                            Ok(data) => response_success(Some(command_id), type_name, Some(data)),
                            Err(error) => {
                                // Rollback is the default on any failure:
                                // abort, delete the artifacts, Serving.
                                if let Some(abort) = self.update_prepare.abort(&update_id) {
                                    self.finish_update_abort(&abort);
                                }
                                response_failure(
                                    Some(command_id),
                                    type_name,
                                    &format!("{error:#}"),
                                    None,
                                )
                            }
                        }
                    }
                    // The watchdog aborted the transaction while we drained
                    // (the same deadline) - the supervisor is Serving again.
                    PrepareOp::NotActive => response_failure(
                        Some(command_id),
                        type_name,
                        "Timed out draining daemon mutations for update restart",
                        None,
                    ),
                }
            }
        }
    }

    /// The snapshot phase of the prepare transaction (spec §5
    /// `Fenced -> Snapshotted -> Prepared`): collect every resident
    /// worker's `update_snapshot`, assemble the roster (spec §8), write
    /// `prepared/<update-id>/{roster,marker}.json` durably, and arm the
    /// marker self-expiry. Runs within the remaining hard prepare budget;
    /// any failure aborts the whole transaction (the caller rolls back).
    async fn complete_update_prepare(
        self: &Arc<Self>,
        update_id: &UpdateId,
        command: &DaemonCommand,
        accepted_at_ms: u64,
        prepare_deadline_ms: u64,
    ) -> Result<Value> {
        let residents = self.registry.list().await;
        // TS parity: refuse to snapshot over a worker that is stopping or
        // disconnected - its state is not collectible.
        for resident in &residents {
            let state = if self.is_stopping(resident) {
                "stopping"
            } else {
                "disconnected"
            };
            let connected = resident.cmd_tx.lock().await.is_some();
            if self.is_stopping(resident) || !connected {
                // TS #2515: the refusal names the blocking session
                // (`sessionFile`, else the root active session id) so the
                // message ties the refused prepare to a specific session.
                let descriptor = resident.descriptor.lock().await;
                let session = descriptor
                    .session_file
                    .clone()
                    .unwrap_or_else(|| descriptor.root_active_session_id.clone());
                anyhow::bail!(
                    "{}",
                    update_prepare_resident_refusal(&resident.worker_id, state, &session)
                );
            }
        }
        let remaining = prepare_deadline_ms.saturating_sub(util::now_ms());
        let rpc_timeout = WORKER_REQUEST_TIMEOUT_MS.min(remaining).max(1);
        let snapshots = join_all(residents.iter().map(|resident| {
            let resident = Arc::clone(resident);
            async move {
                let response = self
                    .route_command_typed(
                        &resident,
                        "update_snapshot",
                        json!({}),
                        rpc_timeout,
                        RouteAdmission::SupervisorInternal,
                    )
                    .await?;
                if !response.success {
                    anyhow::bail!(
                        "worker {} refused its snapshot: {}",
                        resident.worker_id,
                        response.error.unwrap_or_default()
                    );
                }
                let data = response
                    .data
                    .clone()
                    .ok_or_else(|| anyhow!("worker {} returned no snapshot", resident.worker_id))?;
                let descriptor = resident.descriptor.lock().await.clone();
                Ok(WorkerSnapshot {
                    worker_id: resident.worker_id.clone(),
                    descriptor,
                    snapshot: data,
                })
            }
        }))
        .await
        .into_iter()
        .collect::<Result<Vec<WorkerSnapshot>>>()?;

        let to_version = match command {
            DaemonCommand::PrepareUpdateRestart { rest, .. } => rest
                .get("toVersion")
                .and_then(Value::as_str)
                .unwrap_or(DAEMON_APP_VERSION),
            _ => DAEMON_APP_VERSION,
        };
        let ledger = self.rlm_spawn_ledger_for(None).await?;
        let now = util::now_ms();
        let identity = supervisor_identity(format!("sup:{}", std::process::id()));
        let roster = build_update_roster(
            UpdateRosterInputs {
                update_id,
                socket_path: self.options.socket_path.to_str().unwrap_or_default(),
                agent_dir: &self.options.agent_dir,
                supervisor: identity.clone(),
                from_version: DAEMON_APP_VERSION,
                to_version,
                created_at_ms: now,
                ledger: &ledger,
            },
            &snapshots,
        )?;
        let marker = UpdatePreparedMarker {
            update_id: update_id.clone(),
            expires_at: marker_expires_at_iso(now, &self.update_budget),
            supervisor: identity,
            rest: Map::default(),
        };
        write_prepared_artifacts(&self.update_prepared_dir(update_id), &roster, &marker)?;
        match self
            .update_prepare
            .snapshot_written(update_id, now, &self.update_budget)
        {
            PrepareOp::Applied(_) => {}
            PrepareOp::NotActive => anyhow::bail!("update prepare aborted during the snapshot"),
        }
        match self.update_prepare.prepare_acked(update_id) {
            PrepareOp::Applied(_) => {}
            PrepareOp::NotActive => anyhow::bail!("update prepare aborted before the ack"),
        }
        Ok(json!({
            "updateId": update_id,
            "state": "prepared",
            "acceptedAt": util::iso_from_unix_ms(accepted_at_ms),
            "expiresAt": marker.expires_at,
        }))
    }

    /// `commit_update_restart` (spec §5 `Prepared -> Stopping`): consume the
    /// prepared transaction and stop every worker gracefully within its
    /// budget. All workers stopped - the supervisor exits for the update
    /// (slice 4's coordinator takes over; descriptors survive on disk for
    /// the new supervisor's create-or-adopt restore). Any refusal
    /// ABANDONS the update: the supervisor returns to `Serving`, refused
    /// sessions keep running untouched, and the already-stopped workers
    /// relaunch (invariant I3 - never a kill).
    pub(super) async fn handle_commit_update_restart(
        self: &Arc<Self>,
        command_id: &str,
        type_name: &str,
        command: &DaemonCommand,
    ) -> (Vec<Value>, bool) {
        let DaemonCommand::CommitUpdateRestart { update_id, .. } = command else {
            return (
                vec![response_line(&response_failure(
                    Some(command_id),
                    type_name,
                    "not a commit_update_restart command",
                    None,
                ))],
                false,
            );
        };
        let Some(update_id) = update_id.clone().map(UpdateId::from) else {
            return (
                vec![response_line(&response_failure(
                    Some(command_id),
                    type_name,
                    "commit_update_restart requires an updateId",
                    None,
                ))],
                false,
            );
        };
        match self.update_prepare.commit(&update_id) {
            PrepareOp::NotActive => (
                vec![response_line(&response_failure(
                    Some(command_id),
                    type_name,
                    "No prepared update restart is active for that update id",
                    None,
                ))],
                false,
            ),
            PrepareOp::Applied(_) => {
                let residents = self.registry.list().await;
                let verdicts = stop_workers_gracefully(self, &residents, &self.update_budget).await;
                let refused: Vec<&str> = verdicts
                    .iter()
                    .filter(|(_, verdict)| *verdict == WorkerStopVerdict::Refused)
                    .map(|(worker_id, _)| worker_id.as_str())
                    .collect();
                if !refused.is_empty() {
                    // Abandon (I3): the sessions that refused keep running;
                    // the ones that already stopped relaunch over their own
                    // session files.
                    if let Some(abort) = self.update_prepare.abandon_stopping(&update_id) {
                        self.finish_update_abort(&abort);
                    }
                    for (resident, (_, verdict)) in residents.iter().zip(&verdicts) {
                        match verdict {
                            WorkerStopVerdict::Stopped => {
                                resident.intentional_stop.store(false, Ordering::SeqCst);
                                match self.relaunch_worker(resident).await {
                                    Ok(child) => {
                                        resident.consecutive_failures.store(0, Ordering::SeqCst);
                                        self.spawn_monitor(Arc::clone(resident), Some(child), 0);
                                    }
                                    Err(error) => {
                                        self.log_line(&format!(
                                            "worker {} abandon relaunch failed: {error:#}",
                                            resident.worker_id
                                        ));
                                    }
                                }
                            }
                            WorkerStopVerdict::Refused => {
                                // Restore normal supervision: the stop
                                // request may still land late, in which case
                                // the monitor treats the exit as a crash
                                // and relaunches with backoff - the session
                                // file is the truth either way.
                                resident.intentional_stop.store(false, Ordering::SeqCst);
                            }
                        }
                    }
                    self.log_line(&format!(
                        "update {update_id} abandoned: worker(s) {refused:?} did not stop in budget; sessions untouched"
                    ));
                    return (
                        vec![response_line(&response_failure(
                            Some(command_id),
                            type_name,
                            &format!(
                                "Update abandoned: session worker(s) {refused:?} did not stop within the budget; sessions are untouched and the daemon keeps serving"
                            ),
                            None,
                        ))],
                        false,
                    );
                }
                let stopped = verdicts.len();
                self.log_line(&format!(
                    "update {update_id}: all {stopped} worker(s) stopped; exiting for the update"
                ));
                // Spec §10.1: every client learns the update resume
                // contract BEFORE the sockets close - the close frame is an
                // instruction (reattach by durable id after the restart),
                // not an error. `estSeconds` is the successor boot + restore
                // window from the update budget.
                let mut sessions: Vec<Value> = Vec::new();
                for resident in &residents {
                    let descriptor = resident.descriptor.lock().await;
                    let session_id = descriptor
                        .root_session_id
                        .clone()
                        .or_else(|| {
                            descriptor.session_file.as_deref().and_then(|file| {
                                Path::new(file)
                                    .file_stem()
                                    .map(|stem| stem.to_string_lossy().to_string())
                            })
                        })
                        .unwrap_or_else(|| resident.worker_id.clone());
                    sessions.push(json!({
                        "sessionId": session_id,
                        "name": descriptor
                            .create_command
                            .rest
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    }));
                }
                let est_seconds =
                    (self.update_budget.boot_ms + self.update_budget.restore_overall_ms) / 1000;
                let closing = json!({
                    "type": "daemon_closing",
                    "reason": "update",
                    "payload": {
                        "updateId": update_id.to_string(),
                        "resume": true,
                        "estSeconds": est_seconds,
                        "sessions": sessions,
                    }
                });
                let _ = self
                    .events
                    .send((ClientRouting::Broadcast, std::sync::Arc::new(closing)));
                // The response is written before the accept loop exits (the
                // write path is the dispatch channel; the 100ms drain only
                // orders the exit behind it - the coordinator's Booting
                // phase recovers a lost ack by design).
                let supervisor = Arc::clone(self);
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    supervisor.exit_for_update();
                });
                (
                    vec![response_line(&response_success(
                        Some(command_id),
                        type_name,
                        Some(json!({
                            "updateId": update_id,
                            "state": "stopping",
                            "stopped": stopped,
                        })),
                    ))],
                    true,
                )
            }
        }
    }

    /// The update's exit path (spec §5 Stopping, all workers exited): set
    /// the shutdown flag so the monitors stand down and the accept loop
    /// falls out, but KEEP the worker descriptors on disk - the new
    /// supervisor's create-or-adopt restore (spec §6/§8) relaunches the
    /// workers from them. Contrast `begin_shutdown`, which deletes
    /// descriptors for a terminal stop.
    fn exit_for_update(self: &Arc<Self>) {
        // The update exit is already complete: publish the accept-loop exit
        // before the general shutdown gate, so a client disconnect can never
        // observe the transient `shutting_down && !accept_exit` window and
        // mistake the update restart for a terminal stop pass.
        self.accept_exit.store(true, Ordering::SeqCst);
        self.shutting_down.store(true, Ordering::SeqCst);
        self.shutdown_notify.notify_one();
    }

    /// Apply one abort outcome: delete the prepared artifacts if any, and
    /// log the return to `Serving` (clients are notified through the
    /// aborting RPC response; the per-phase banner event is the UX slice).
    pub(super) fn finish_update_abort(self: &Arc<Self>, abort: &AbortOutcome) {
        if abort.delete_prepared {
            let prepared_dir = self.update_prepared_dir(&abort.update_id);
            if let Err(error) = crate::update_prepare::delete_prepared_dir(&prepared_dir) {
                self.log_line(&format!(
                    "update prepare cleanup failed for {}: {error:#}",
                    abort.update_id
                ));
            }
        }
        self.log_line(&format!(
            "update prepare aborted ({}): {}",
            abort.update_id,
            abort.reason.as_str()
        ));
    }

    /// The prepared-artifact directory of one update under this socket's
    /// scratch dir (swept at boot; created only by the prepare transaction).
    fn update_prepared_dir(&self, update_id: &UpdateId) -> PathBuf {
        let socket_hash = paths::hash_key(&self.options.socket_path.to_string_lossy(), 64);
        crate::update_prepare::prepared_dir(&self.options.agent_dir, &socket_hash, update_id)
    }

    /// Update-prepare watchdog (spec §5): aborts a transaction whose
    /// deadline or marker self-expiry passes even when no command arrives
    /// to re-check, so a coordinator that dies mid-prepare can never wedge
    /// the supervisor (invariant I1). Parks with no timer while no update
    /// is in flight.
    pub(super) async fn update_prepare_watchdog(self: Arc<Self>) {
        loop {
            let abort = self.update_prepare.wait_for_expiry().await;
            self.finish_update_abort(&abort);
        }
    }
}

/// TS #2515 `prepareUpdateRestartFenced`'s resident-worker refusal: the
/// message names the blocking session, so the refused prepare ties to a
/// specific session instead of a bare worker id.
fn update_prepare_resident_refusal(worker_id: &str, state: &str, session: &str) -> String {
    format!(
        "Cannot prepare update restart while resident worker {worker_id} is {state} (session {session})"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TS #2515: the resident-worker prepare refusal names the blocking
    /// session — `sessionFile` when the descriptor carries one, else the
    /// root active session id — so the refused prepare ties to a session
    /// the user can look at, not a bare worker id.
    #[test]
    fn update_prepare_refusal_names_the_blocking_session() {
        assert_eq!(
            update_prepare_resident_refusal(
                "resident-1",
                "disconnected",
                "/sessions/blocked.jsonl"
            ),
            "Cannot prepare update restart while resident worker resident-1 is disconnected (session /sessions/blocked.jsonl)"
        );
        // The root active session id is the fallback (a worker whose
        // descriptor carries no session file yet).
        assert_eq!(
            update_prepare_resident_refusal("resident-1", "stopping", "blocked-root"),
            "Cannot prepare update restart while resident worker resident-1 is stopping (session blocked-root)"
        );
    }
}
