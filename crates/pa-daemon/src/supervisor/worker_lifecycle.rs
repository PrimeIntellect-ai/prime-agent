//! Worker lifecycle: the launch/probe/connect plumbing for new workers
//! and the stop, kill, retire, and tombstone passes for resident ones.

use super::launch_budget::{
    DEFAULT_WORKER_CONNECT_TIMEOUT_MS, WORKER_CONNECT_BACKOFF_MS, WORKER_CONNECT_PROBE_MS,
    WORKER_CONNECT_TIMEOUT_ENV,
};
use super::{
    anyhow, bail, clients, create_command_payload, json, launch_budget, options, persist_worker,
    sessions, socket, util, Arc, Context, DaemonCommand, DaemonWorkerDescriptor,
    DaemonWorkerLifecycle, DurableDaemonCreateCommand, Duration, EngineModelSelection, Map,
    Ordering, Path, ResidentWorker, Result, RouteAdmission, Supervisor, TypedCreateRejection,
    Value, LONG_ROUTE_TIMEOUT_MS, ROUTE_TIMEOUT_MS,
};
use crate::lease::is_process_alive;

impl Supervisor {
    /// Complete a tombstoned stop for a worker encountered at adoption —
    /// the boot scan's descriptor pass and a live re-registration alike
    /// (TS `adoptOrRecoverWorker`'s `stopRequestedAt` branch: adoption
    /// finishes the stop, never adopts the worker as healthy). The
    /// tombstone's variant rides `archive_on_stop`: the kill stop
    /// (`Some(true)`) is irreversible — its killed close cancels jobs,
    /// archives the file, and cascades children; the per-session stop
    /// (`Some(false)`) keeps the session resumable — its graceful
    /// shutdown close and its schedule-cancel belt are all it owns.
    pub(super) async fn finish_tombstoned_stop(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
        alive: bool,
    ) {
        let kill_stop = resident.descriptor.lock().await.archive_on_stop == Some(true);
        if alive {
            // The worker outlived the stop (a crash between the tombstone
            // and the forward, or a survivor of the escalation): connect
            // to it and forward the ORIGINAL stop intent — kill for the
            // kill stop, shutdown for the resumable per-session stop. A
            // failed connect degrades to the dead-worker finalize below.
            resident.intentional_stop.store(true, Ordering::SeqCst);
            if self
                .connect_worker(resident, worker_connect_deadline())
                .await
                .is_ok()
            {
                let command = if kill_stop { "kill" } else { "shutdown" };
                let _ = self
                    .route_command_typed(
                        resident,
                        command,
                        json!({}),
                        ROUTE_TIMEOUT_MS,
                        RouteAdmission::SupervisorInternal,
                    )
                    .await;
            }
        }
        // TS `scheduleWorkerStopFinalization`: the interrupted stop's
        // cleanup re-runs instead of a relaunch, honoring the variant.
        if kill_stop {
            // The descriptor survives an unsettled finalize (a later boot
            // retries the archived-state belt); a settled stop still dies
            // only with a provably-gone process. The forwarded kill
            // releases the lease without exiting the worker, and the
            // registration path's refused worker is not yet in the
            // registry, so the finalize's registry-coverage checks cannot
            // observe it — the settle is not a death certificate. The
            // retire pass's escalation is: a survivor keeps its
            // tombstoned descriptor for the next boot exactly like the
            // per-session arm, and only a provable death removes it.
            let settled = self.finalize_worker_stop(resident, None).await;
            if settled {
                self.retire_worker_after_stop(resident).await;
                self.log_line(&format!(
                    "finished the tombstoned stop of session worker {}",
                    resident.worker_id
                ));
            } else {
                self.log_line(&format!(
                    "tombstoned stop of session worker {} not settled; descriptor kept",
                    resident.worker_id
                ));
            }
        } else {
            // The per-session stop's durable half is the ephemeral
            // schedule cancel (no archived-state belt — the session stays
            // resumable), and the descriptor dies only with a
            // provably-gone process: the retire pass removes it once the
            // escalation confirms death and keeps a survivor's tombstone
            // for the next boot (never orphaning a live lease holder
            // behind a deleted descriptor). Only an owned (ephemeral)
            // stop cancels its tree — `stop_worker`'s own gate: a
            // resident RLM child's preserved jobs must survive a parent's
            // stop-driven death.
            if resident.descriptor.lock().await.owner_client_id.is_some() {
                self.finalize_owned_stop(resident).await;
            }
            self.retire_worker_after_stop(resident).await;
            self.log_line(&format!(
                "finished the tombstoned per-session stop of session worker {}",
                resident.worker_id
            ));
        }
    }

    /// Launch a brand-new worker for a create command.
    pub(crate) async fn launch_worker(
        self: &Arc<Self>,
        create: &DaemonCommand,
        owner_client_id: Option<String>,
    ) -> Result<(Arc<ResidentWorker>, Value)> {
        let DaemonCommand::Create {
            session_path,
            continue_recent,
            no_session,
            name,
            config,
            telemetry_disabled,
            runtime_metadata,
            ..
        } = create
        else {
            return Err(anyhow!("launch_worker requires a create command"));
        };
        // The shutdown gate: a create dispatched while the supervisor is
        // stopping must never launch a worker the stop pass would miss (a
        // late create racing a shutdown would otherwise orphan its worker
        // process). The command surfaces the same failure as any refused
        // create.
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(anyhow!("Supervisor is shutting down"));
        }
        let config_object = config.as_ref().and_then(Value::as_object);
        let cwd_value = config_object
            .and_then(|config| config.get("cwd"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                std::env::current_dir()
                    .ok()
                    .map(|p| p.to_string_lossy().to_string())
            })
            .unwrap_or_else(|| "/".to_string());
        let session_dir = config_object
            .and_then(|config| config.get("sessionDir"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let script = config_object
            .and_then(|config| config.get("script"))
            .and_then(Value::as_str)
            .map(str::to_string);
        // Explicit model selection from the create config: carried into the
        // durable create command so respawned workers resolve the same model
        // and thinking level.
        let requested_thinking = match config_object.and_then(|config| config.get("thinking")) {
            None => None,
            Some(Value::String(level)) => match pa_ai::models::thinking_level_from_str(level) {
                Some(level) => Some(level),
                None => {
                    return Err(anyhow!(
                        "Invalid thinking level \"{level}\". Valid values: off, minimal, low, medium, high, xhigh, max"
                    ))
                }
            },
            Some(_) => {
                return Err(anyhow!(
                    "Invalid thinking level: expected a string"
                ))
            }
        };
        let model_selection = EngineModelSelection {
            provider: config_object
                .and_then(|config| config.get("provider"))
                .and_then(Value::as_str)
                .map(str::to_string),
            model: config_object
                .and_then(|config| config.get("model"))
                .and_then(Value::as_str)
                .map(str::to_string),
            api_key: config_object
                .and_then(|config| config.get("apiKey"))
                .and_then(Value::as_str)
                .map(str::to_string),
            thinking: requested_thinking,
        };
        if *no_session == Some(true) && session_path.is_some() {
            return Err(anyhow!(
                "Session cannot be both no-session and session-pathed"
            ));
        }
        // `continueRecent` is refused: a create must name its session
        // (`sessionPath`) or open one through the agents view. The daemon
        // never picks a session blindly — a shared session dir can hold any
        // session, and reopening one revives its context and scheduled jobs
        // (a sanctioned divergence from the TS worker's continueRecent
        // arm, which resolves the newest saved session for the cwd).
        if *continue_recent == Some(true) {
            return Err(anyhow!(
                "continueRecent is not supported: pass sessionPath to reopen a session, or open one through the agents view"
            ));
        }
        let worker_id = util::new_display_id();
        let worker_socket = socket::worker_socket_path(&self.options.socket_path, &worker_id);
        let now = util::now_iso();
        let mut durable_rest = serde_json::Map::new();
        durable_rest.insert("cwd".to_string(), json!(cwd_value));
        if let Some(session_dir) = &session_dir {
            durable_rest.insert("sessionDir".to_string(), json!(session_dir));
        }
        if let Some(name) = name {
            durable_rest.insert("name".to_string(), json!(name));
        }
        if let Some(script) = &script {
            durable_rest.insert("script".to_string(), json!(script));
        }
        if let Some(provider) = &model_selection.provider {
            durable_rest.insert("provider".to_string(), json!(provider));
        }
        if let Some(model) = &model_selection.model {
            durable_rest.insert("model".to_string(), json!(model));
        }
        if let Some(api_key) = &model_selection.api_key {
            durable_rest.insert("apiKey".to_string(), json!(api_key));
        }
        if let Some(thinking) = model_selection.thinking {
            durable_rest.insert("thinking".to_string(), json!(thinking.wire_name()));
        }
        // RLM recursion identity rides the durable create command so a
        // respawned child keeps it (children of an RLM parent must not
        // forget their depth). `thinking` is covered above: the validated
        // wire name goes into the durable command, never the raw config
        // value, so an invalid level cannot outlive the create check.
        for key in ["rlmDepth", "rlmMaxDepth", "parentSessionPath"] {
            if let Some(value) = config_object.and_then(|config| config.get(key)) {
                durable_rest.insert(key.to_string(), value.clone());
            }
        }
        // A child's RLM identity rides the durable create command too, so a
        // respawned or adopted child stays identifiable for ledger appends.
        if let Some(metadata) = &runtime_metadata {
            for key in ["rlmChildId"] {
                if let Some(value) = metadata.get(key) {
                    durable_rest.insert(key.to_string(), value.clone());
                }
            }
        }
        // The whole subagent runtime identity rides the durable create
        // command too, so a respawned child keeps its roster identity
        // (parentPath#childId) across worker restarts.
        if let Some(runtime_metadata) = &runtime_metadata {
            durable_rest.insert("runtimeMetadata".to_string(), runtime_metadata.clone());
        }
        let descriptor = DaemonWorkerDescriptor {
            version: 2,
            worker_id: worker_id.clone(),
            pid: 0,
            process_start_id: None,
            socket_path: worker_socket.to_string_lossy().to_string(),
            recovery_journal_path: self
                .descriptor_dir
                .join(format!("{worker_id}.recovery.jsonl"))
                .to_string_lossy()
                .to_string(),
            orphan_process_journal_path: None,
            supervisor_socket_path: self.options.socket_path.to_string_lossy().to_string(),
            authentication_token: uuid::Uuid::new_v4().to_string(),
            worker_instance_id: Some(uuid::Uuid::new_v4().to_string()),
            root_active_session_id: worker_id.clone(),
            owner_client_id,
            root_session_id: None,
            session_file: session_path.clone(),
            session_dir: session_dir.clone(),
            // TS main.ts `telemetryDisabled`: only ever `Some(true)`
            // (the enabled case stays absent on the wire).
            telemetry_disabled: telemetry_disabled.and(Some(true)),
            created_at: now.clone(),
            updated_at: now,
            lifecycle: DaemonWorkerLifecycle::Starting,
            create_command: DurableDaemonCreateCommand {
                session_path: session_path.clone(),
                no_session: *no_session,
                rest: durable_rest,
            },
            consecutive_failures: 0,
            stop_requested_at: None,
            archive_on_stop: None,
            last_failure_at: None,
            last_error: None,
            rest: Map::default(),
        };
        let descriptor_path = self.descriptor_dir.join(format!("{worker_id}.json"));
        let resident = ResidentWorker::new(worker_id.clone(), descriptor, descriptor_path.clone());
        // Register the resident before spawning the process: the worker
        // self-registers on boot, and the registration handler must find its
        // identity in the registry (registration races the create replay).
        self.registry.insert(Arc::clone(&resident)).await;
        let deadline = worker_connect_deadline();
        // A failed launch never leaves its half-registered resident behind:
        // a later stale-id rebind (or resolve) must not select a worker
        // that cannot route.
        let child = match self.spawn_worker_process(&resident, deadline).await {
            Ok(child) => child,
            Err(error) => {
                self.registry.remove(&worker_id).await;
                // The half-launched worker's descriptor dies with the
                // launch: a restart must not adopt it and replay its
                // durable create after the client was told the create
                // failed.
                let _ = std::fs::remove_file(&descriptor_path);
                return Err(error);
            }
        };
        if let Err(error) = self.connect_worker(&resident, deadline).await {
            // Never leave a spawned-but-unwired worker process behind.
            let mut child = child;
            let _ = child.kill().await;
            self.registry.remove(&worker_id).await;
            // The half-launched worker's descriptor dies with the launch.
            let _ = std::fs::remove_file(&descriptor_path);
            return Err(error);
        }
        let create_payload = {
            let descriptor = resident.descriptor.lock().await;
            create_command_payload(&descriptor.create_command)
        };
        let mut child = child;
        let response = match self
            .route_command_typed(
                &resident,
                "create",
                create_payload,
                LONG_ROUTE_TIMEOUT_MS,
                RouteAdmission::SupervisorInternal,
            )
            .await
        {
            Ok(response) => response,
            Err(error) => {
                // The connected child dies with the failed create: an
                // unmanaged survivor would keep the session file while a
                // retry mints a second worker over it.
                let _ = child.kill().await;
                self.registry.remove(&worker_id).await;
                // The half-launched worker's descriptor dies with the launch.
                let _ = std::fs::remove_file(&descriptor_path);
                return Err(error);
            }
        };
        if !response.success {
            let _ = child.kill().await;
            let _ = std::fs::remove_file(&descriptor_path);
            self.registry.remove(&worker_id).await;
            // A typed worker rejection relays verbatim - the typed text is
            // the user-facing refusal (the session-hold rejection the
            // lease raises against a live foreign holder) - and the daemon
            // logs the detected conflict itself, not just the raw
            // session-worker failure: the rotating log beside the socket
            // is where a refused create leaves its record. The wrap stays
            // for untyped failures, whose text is context the raw error
            // lacks.
            return Err(match response.error_info {
                Some(error_info) => {
                    let message = response.error.clone().unwrap_or_default();
                    // The typed rejection's text is multi-line (the
                    // actionable refusal); the log keeps one record per
                    // line, so only its headline rides the log line (the
                    // full text reached the client on the wire).
                    let headline = message.lines().next().unwrap_or_default();
                    match &error_info {
                        pa_types::daemon::DaemonErrorInfo::SessionAlreadyActive {
                            session_path,
                            active_session_id,
                        } => self.log_line(&format!(
                            "create refused: session file {session_path} is already active{} — {headline}",
                            active_session_id
                                .as_deref()
                                .map(|id| format!(" in {id}"))
                                .unwrap_or_default(),
                        )),
                        _ => self.log_line(&format!("create refused — {headline}")),
                    }
                    TypedCreateRejection {
                        message,
                        error_info,
                    }
                    .into()
                }
                None => anyhow!(
                    "session worker create failed: {}",
                    response.error.unwrap_or_default()
                ),
            });
        }
        // The create response is authoritative: a sessioned create must
        // carry a non-empty session file before it can succeed (the
        // descriptor, the spawn ledger, and respawn recovery all key on
        // it; a create without it would admit a child the roster can
        // never find again). `no_session` creates are in-memory by
        // design and stay exempt.
        let create_summary = response
            .data
            .clone()
            .unwrap_or_else(|| json!({ "id": resident.worker_id.clone() }));
        if *no_session != Some(true) {
            let has_session_file = create_summary
                .get("sessionFile")
                .and_then(Value::as_str)
                .is_some_and(|file| !file.is_empty());
            if !has_session_file {
                // Never leave the spawned worker behind a degraded create:
                // the shutdown is graceful, and the awaited kill reaps the
                // child (the monitor that would own it is not spawned yet).
                let _ = self.stop_worker(&resident).await;
                let _ = child.kill().await;
                let _ = std::fs::remove_file(&descriptor_path);
                return Err(anyhow!("session worker create returned no session file"));
            }
        }
        {
            let mut descriptor = resident.descriptor.lock().await;
            descriptor.lifecycle = DaemonWorkerLifecycle::Ready;
            descriptor.root_session_id = create_summary
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string);
            // An empty session file (an in-memory `no_session` session)
            // must not overwrite the descriptor's session identity: the
            // durable create stays pathless so a respawned worker
            // replays the session as in-memory.
            if let Some(session_file) = create_summary
                .get("sessionFile")
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|file| !file.is_empty())
            {
                descriptor.session_file = Some(session_file.clone());
                // The durable create command must reopen the same session
                // file on relaunch, or a respawned worker would create a
                // fresh session and lose history.
                descriptor.create_command.session_path = Some(session_file);
            }
            // The binding table learns the durable identity here: a create
            // over a session file another worker owned (the session
            // re-opened after its worker gave up or stopped) supersedes the
            // old id, and the supersede notification tells the clients
            // still attached to it to rebind.
            self.record_session_binding(
                &worker_id,
                descriptor.root_session_id.as_deref(),
                descriptor.session_file.as_deref(),
            );
            persist_worker(&descriptor_path, &descriptor)?;
        }
        // The create completed with a validated session identity: client
        // commands may now be routed to this worker (the replacement-aware
        // route gates on this, so nothing overtakes the session's create).
        resident.note_session_ready();
        let pid = child.id().unwrap_or(0);
        self.spawn_monitor(Arc::clone(&resident), Some(child), u64::from(pid));
        Ok((resident, create_summary))
    }

    /// Persist one subagent deletion (TS `recordRlmSubagentDeletion`): the
    /// ledger delete record is the topology tombstone, the display file gets
    /// a status tombstone for hydration. The child's transcript stays (a
    /// tombstoned-but-undeleted file is the accepted orphan of a failed
    /// teardown); the row disappears from rosters because live-edge reads
    /// drop tombstones.
    pub(super) async fn tombstone_rlm_child(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
        child_id: Option<&str>,
        reason: crate::rlm_ledger::RlmLedgerDeleteReason,
    ) -> Result<()> {
        let (session_file, session_dir, child_id) = {
            let descriptor = resident.descriptor.lock().await;
            let session_file = descriptor
                .session_file
                .clone()
                .ok_or_else(|| anyhow!("deleted RLM subagent has no session file"))?;
            let session_dir = descriptor
                .create_command
                .rest
                .get("sessionDir")
                .and_then(Value::as_str)
                .map_or_else(
                    || {
                        Path::new(&session_file)
                            .parent()
                            .map(|dir| dir.to_string_lossy().to_string())
                            .unwrap_or_default()
                    },
                    str::to_string,
                );
            (
                session_file,
                session_dir,
                child_id.map(str::to_string).or_else(|| {
                    descriptor
                        .create_command
                        .rest
                        .get("rlmChildId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                }),
            )
        };
        let Some(child_id) = child_id else {
            anyhow::bail!("deleted RLM subagent is missing its child id");
        };
        let ledger = self
            .rlm_spawn_ledger_for(None)
            .await
            .with_context(|| "resolve the spawn ledger sessions dir".to_string())?;
        ledger
            .append_delete(&child_id, &session_file, reason)
            .with_context(|| format!("tombstone RLM subagent {child_id}"))?;
        // The display tombstone keeps the child's identity for hydration
        // retries; best-effort because the ledger tombstone is the
        // authority.
        let display = crate::rlm_ledger::read_rlm_subagent_display(Path::new(&session_dir));
        let tombstone = crate::rlm_ledger::RlmSubagentDisplayEntry {
            type_tag: "rlm_subagent".to_string(),
            child_id: child_id.clone(),
            session_name: display
                .as_ref()
                .map(|entry| entry.session_name.clone())
                .unwrap_or_default(),
            session_dir,
            session_file: display
                .as_ref()
                .map_or_else(|| session_file.clone(), |entry| entry.session_file.clone()),
            rlm_parent_node_id: display
                .as_ref()
                .and_then(|entry| entry.rlm_parent_node_id.clone()),
            prompt: display.as_ref().and_then(|entry| entry.prompt.clone()),
            spawn_code: display.as_ref().and_then(|entry| entry.spawn_code.clone()),
            model: display.as_ref().and_then(|entry| entry.model.clone()),
            status: "deleted".to_string(),
            created_at: display.as_ref().map_or(0, |entry| entry.created_at),
        };
        if let Err(error) = crate::rlm_ledger::write_rlm_subagent_display(&tombstone) {
            self.log_line(&format!(
                "failed to reconcile display entry for tombstoned RLM subagent {child_id}: {error:#}"
            ));
        }
        Ok(())
    }

    /// The plain kill's stop aftermath, run on every route outcome: TS's
    /// root-kill block wraps the forward in a `finally`
    /// (daemon-supervisor.ts: `try { response = await
    /// this.forwardToWorker(...) } finally { await this.stopWorker(...) }`),
    /// so a kill a hung worker never answers still completes the stop —
    /// the graceful `shutdown` route bounded by the route budget, then
    /// [`Self::retire_worker_after_stop`]'s SIGTERM -> SIGKILL ->
    /// hard-deadline escalation — and the stopped worker's session lease
    /// frees through the dead-owner reclaim instead of outliving the
    /// command behind a route that never answers.
    ///
    /// The stop runs first and its failure gates the belt: the only
    /// `Err` [`Self::stop_worker`] takes is the stop tombstone's persist
    /// (the stop never durably started — TS's `stopWorkerUntracked`
    /// throws before any teardown), so the worker stays untouched and
    /// the kill stays retryable. The belt below must never run against
    /// a live worker: it cancels the session tree's jobs, archives the
    /// root file, and sweeps a ledger delete's child artifacts while
    /// the worker's resident is still serving and its transcript may
    /// still grow.
    pub(super) async fn finish_plain_kill_stop(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
        rest: &Map<String, Value>,
    ) {
        if let Err(error) = self.stop_worker(resident).await {
            self.log_line(&format!(
                "session worker {} stop after kill failed: {error:#}; the stop never durably started and stays retryable",
                resident.worker_id
            ));
            return;
        }
        // TS `stopWorkerUntracked`'s archived-stop finalize (the plain
        // kill's durable half): the killed session tree's scheduled jobs
        // cancel durably and the root file carries the `archived` state,
        // so no wake pass can revive the stopped session. A
        // ledger-tombstoned delete also sweeps the deleted child's
        // artifacts (TS `deleteRlmSubagentArtifacts`).
        let deleted_child = rest
            .get("rlmLedgerDelete")
            .and_then(Value::as_str)
            .and_then(crate::rlm_ledger::RlmLedgerDeleteReason::from_wire)
            .map(|_| crate::stop_cleanup::DeletedChild {
                child_id: rest
                    .get("rlmChildId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            });
        self.finalize_worker_stop(resident, deleted_child.as_ref())
            .await;
    }

    pub(crate) async fn stop_worker(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
    ) -> anyhow::Result<()> {
        // The stop's durable intent persists BEFORE the worker is told (TS
        // `stopWorkerUntracked(removeDescriptor)` ->
        // `persistWorkerStopTombstone`): a supervisor that dies mid-stop, or
        // a worker that survives the escalation below, must never be
        // adopted as healthy by a later boot — the tombstoned descriptor
        // routes the boot through the stop-finalization path instead. The
        // per-session stop never archives (the plain kill's earlier
        // tombstone keeps its archive intent); a persist failure fails the
        // stop before the shutdown is forwarded, exactly like TS throws
        // for non-direct-child stops, so the worker's crash-recovery
        // contract stays intact.
        self.persist_stop_tombstone_stop(resident).await?;
        resident.intentional_stop.store(true, Ordering::SeqCst);
        // The stop is intentional: routes waiting out a replacement must
        // fail fast instead of parking on this worker.
        resident.note_retired();
        let _ = self
            .route_command_typed(
                resident,
                "shutdown",
                json!({}),
                ROUTE_TIMEOUT_MS,
                RouteAdmission::SupervisorInternal,
            )
            .await;
        // The per-session stop shares the terminal-stop contract: the
        // descriptor dies only with a provably-gone process, so a worker
        // that missed the routed shutdown stays adoptable (or is
        // escalated away) instead of becoming an invisible lease holder.
        self.retire_worker_after_stop(resident).await;
        // TS `stopWorkerUntracked`: a client-owned (ephemeral) worker's
        // scheduled jobs die with the registration
        // (`cancelEphemeralWorkerScheduledJobs`) — every remove-descriptor
        // stop of an owned worker, including the degraded-create cleanups.
        let ephemeral = resident.descriptor.lock().await.owner_client_id.is_some();
        if ephemeral {
            self.finalize_owned_stop(resident).await;
        }
        self.registry.remove(&resident.worker_id).await;
        self.registry.forget(&resident.worker_id).await;
        // The residency change lands in the scheduled-jobs invalidation (TS
        // `broadcastHeartbeatsChanged`: "every daemon-owned scheduled-job
        // mutation and worker residency change"): the stopped session's
        // durable jobs are passive from here on, so a snapshot that
        // excluded them while the worker was live must not be served for
        // the rest of the refresh window.
        self.broadcast_heartbeats_changed();
        // TS `flipWorkerRosterEntriesInactive`: the stopped worker's rows
        // settle in place (every owned non-ephemeral, non-queued row
        // passivates and keeps its model/thinking/cwd, the top-level row
        // included; a tombstoned child, a queued child, and an ephemeral
        // worker's rows die with the stop). No ledger reseed, no
        // transcript read.
        self.passivate_roster_worker(&resident.worker_id, ephemeral)
            .await;
        Ok(())
    }

    /// Delete one stopped worker's descriptor only after its process is
    /// provably gone (TS `stopWorkerUntracked`'s contract; the shutdown
    /// pass and the per-session stop share it). A worker that missed the
    /// routed `shutdown` (a dead connection, a wedged socket, a flush
    /// outlasting the route budget) gets the identity-gated
    /// SIGTERM -> SIGKILL escalation; deleting the descriptor of a live
    /// worker orphans it — nothing on any later daemon can adopt or reap
    /// it through its identity, while it keeps holding its runtime
    /// session lease, so every open of its session then refuses with
    /// `Session is already active in <its id>`.
    pub(super) async fn retire_worker_after_stop(self: &Arc<Self>, resident: &Arc<ResidentWorker>) {
        let (pid, start_id) = {
            let descriptor = resident.descriptor.lock().await;
            (descriptor.pid as u32, descriptor.process_start_id.clone())
        };
        // An unobservable identity never receives the escalation's
        // signals (a pid that cannot be proven ours stays untouched);
        // a live process behind such a pid keeps its tombstoned
        // descriptor too, exactly like a SIGKILL survivor - the next
        // boot retries the stop. The unverifiable class covers BOTH a
        // descriptor without a recorded id and a recorded id the
        // platform cannot observe right now (the probe returns None
        // while the process lives).
        let alive_unverified = (start_id.is_none()
            || crate::lease::get_process_start_id(pid).is_none())
            && crate::lease::is_process_alive(pid).unwrap_or(false);
        match crate::boot_reap::stop_process(pid, start_id).await {
            crate::boot_reap::ReapOutcome::Survived => {
                self.log_line(&format!(
                    "session worker {} survived the shutdown escalation; descriptor tombstoned for the next boot",
                    resident.worker_id
                ));
            }
            _ if alive_unverified => {
                self.log_line(&format!(
                    "session worker {} cannot be identity-verified; descriptor tombstoned for the next boot",
                    resident.worker_id
                ));
            }
            _ => {
                let _ = std::fs::remove_file(&resident.descriptor_path);
            }
        }
    }
}

/// Attach outcome for a `chunked_snapshot` client: the response carries the
/// snapshot header with an empty transcript plus a `snapshotStream`
/// descriptor, and the transcript follows as `session_snapshot_begin` /
/// `session_snapshot_chunk` / `session_snapshot_end` records. A snapshot
/// that cannot be transferred after the response surfaces as
/// `session_snapshot_failed` keyed by the same snapshot id.
/// Probe a worker socket until it accepts connections or the connect budget
/// runs out. The error names the worker so a stuck launch reports which
/// session never came up.
pub(super) async fn probe_worker_socket(
    worker_id: &str,
    socket_path: &Path,
    connect_deadline: tokio::time::Instant,
) -> Result<()> {
    loop {
        if socket::can_connect(socket_path, Duration::from_millis(WORKER_CONNECT_PROBE_MS)).await {
            return Ok(());
        }
        if tokio::time::Instant::now() >= connect_deadline {
            return Err(anyhow!(
                "session worker {worker_id} did not come up in time"
            ));
        }
        tokio::time::sleep(Duration::from_millis(WORKER_CONNECT_BACKOFF_MS)).await;
    }
}

/// The shared worker-connect deadline: probes, connect, and auth must all
/// fit inside one worker-connect budget from spawn time (the TS default,
/// or the env override for load-heavy e2e environments). An override past
/// the platform's representable range falls back to the default budget
/// instead of panicking the deadline arithmetic.
pub(super) fn worker_connect_deadline() -> tokio::time::Instant {
    let timeout_ms = std::env::var(WORKER_CONNECT_TIMEOUT_ENV)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .unwrap_or(DEFAULT_WORKER_CONNECT_TIMEOUT_MS);
    let now = tokio::time::Instant::now();
    now.checked_add(Duration::from_millis(timeout_ms))
        .unwrap_or_else(|| now + Duration::from_millis(DEFAULT_WORKER_CONNECT_TIMEOUT_MS))
}

/// The real graceful-stop transport (spec §5 `Stopping`): the routed
/// `shutdown` request - the worker's handler is the flush barrier (it
/// persists the recovery journal and finalizes telemetry before replying) -
/// and a pid/start-id liveness poll for the exit wait (a foreign process
/// cannot be waited on directly). The stop is marked intentional before the
/// request so the monitor never races an exit into a crash-restart.
impl crate::update_stop::WorkerStopTransport for std::sync::Arc<Supervisor> {
    async fn request_shutdown(
        &self,
        resident: &Arc<ResidentWorker>,
        timeout: Duration,
    ) -> Result<()> {
        resident.intentional_stop.store(true, Ordering::SeqCst);
        let response = self
            .route_command_typed(
                resident,
                "shutdown",
                json!({}),
                timeout.as_millis() as u64,
                RouteAdmission::SupervisorInternal,
            )
            .await?;
        if !response.success {
            anyhow::bail!(
                "worker {} refused the graceful stop: {}",
                resident.worker_id,
                response.error.unwrap_or_default()
            );
        }
        Ok(())
    }

    async fn wait_exit(&self, resident: &Arc<ResidentWorker>, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let (pid, start_id) = {
                let descriptor = resident.descriptor.lock().await;
                (descriptor.pid, descriptor.process_start_id.clone())
            };
            let alive = is_process_alive(pid as u32).unwrap_or(false)
                && start_id.as_deref().is_none_or(|start| {
                    crate::protocol::process_start_id(pid as u32).as_deref() == Some(start)
                });
            if !alive {
                return true;
            }
            if tokio::time::Instant::now() + WORKER_EXIT_POLL >= deadline {
                return false;
            }
            tokio::time::sleep(WORKER_EXIT_POLL).await;
        }
    }
}

/// How often the graceful-stop exit wait polls worker process liveness.
const WORKER_EXIT_POLL: Duration = Duration::from_millis(250);
