//! Worker adoption: the boot discovery pass and the per-worker
//! adoption outcomes.

use std::sync::Arc;

use super::{
    anyhow, json, load_descriptors, response_failure, response_success, socket,
    worker_connect_deadline, Context, DaemonCommand, DaemonResponse, DaemonWorkerLifecycle,
    Duration, Ordering, Path, PathBuf, ResidentWorker, Result, Supervisor, Value,
    WorkerRegistration,
};

/// The boot the descriptor-adoption pass runs under. An update boot relaunches kept
/// workers before the roster restore walks the rows (spec §6 step 2's create-or-adopt
/// order). A plain startup revives only genuinely interrupted ones — no mass-revival
/// of historical idle sessions.
#[derive(Clone, PartialEq, Eq)]
pub(super) enum AdoptionBoot {
    /// Update boot: the roster's kept workers relaunch eagerly ahead of the restore
    /// pass; busy-at-crash workers revive too. The kept set is shared (an `Arc`).
    UpdateRoster {
        kept: Arc<std::collections::HashSet<String>>,
    },
    /// Plain startup: only journal-proven live work revives.
    PlainStartup,
}

/// One descriptor's boot-adoption decision, reported as a count in the
/// pass's `worker_adoption` event (counts only, never session payload).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum AdoptionOutcome {
    /// Live socket adopted (incl. a worker that re-registered before the
    /// descriptor scan reached it).
    AdoptedLive,
    /// Dead descriptor relaunched (busy evidence on a plain boot, kept
    /// worker on an update boot).
    Revived,
    /// Dead descriptor with no durable busy evidence: stayed down.
    SkippedIdle,
    /// The descriptor carried a durable stop tombstone: the boot re-ran
    /// the stop's finalization instead of adopting or reviving.
    Stopped,
    Failed,
}

impl Supervisor {
    /// Emit the boot adoption pass's `worker_adoption` event: the boot kind
    /// and per-outcome counts, primitives only — never session payload.
    #[allow(clippy::too_many_arguments)]
    fn note_worker_adoption(
        &self,
        boot: &str,
        adopted_live: usize,
        revived: usize,
        skipped_idle: usize,
        stopped: usize,
        failed: usize,
    ) {
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_worker_adoption(
                client,
                boot,
                adopted_live,
                revived,
                skipped_idle,
                stopped,
                failed,
            );
        }
    }

    /// Adopt or relaunch persisted workers, concurrently: one dead worker's relaunch must
    /// not delay adopting live sessions; the fan-out is capped at
    /// [`crate::recovery_pacing::ADOPTION_CONCURRENCY`] to avoid a relaunch storm.
    pub(super) async fn adopt_persisted_workers(self: &Arc<Self>, boot: AdoptionBoot) {
        let descriptors = load_descriptors(&self.descriptor_dir, &self.options.socket_path);
        let adopted_live = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let revived = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let skipped_idle = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stopped = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let failed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let jobs: Vec<_> = descriptors
            .into_iter()
            .map(|(path, descriptor)| {
                let supervisor = Arc::clone(self);
                let boot = boot.clone();
                let adopted_live = Arc::clone(&adopted_live);
                let revived = Arc::clone(&revived);
                let skipped_idle = Arc::clone(&skipped_idle);
                let stopped = Arc::clone(&stopped);
                let failed = Arc::clone(&failed);
                move || async move {
                    let outcome = supervisor
                        .adopt_persisted_worker(path, descriptor, boot)
                        .await;
                    let counter = match outcome {
                        AdoptionOutcome::AdoptedLive => adopted_live,
                        AdoptionOutcome::Revived => revived,
                        AdoptionOutcome::SkippedIdle => skipped_idle,
                        AdoptionOutcome::Stopped => stopped,
                        AdoptionOutcome::Failed => failed,
                    };
                    counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
            })
            .collect();
        crate::recovery_pacing::run_bounded(jobs, crate::recovery_pacing::ADOPTION_CONCURRENCY)
            .await;
        let adopted_live = adopted_live.load(std::sync::atomic::Ordering::Relaxed);
        let revived = revived.load(std::sync::atomic::Ordering::Relaxed);
        let skipped_idle = skipped_idle.load(std::sync::atomic::Ordering::Relaxed);
        let stopped = stopped.load(std::sync::atomic::Ordering::Relaxed);
        let failed = failed.load(std::sync::atomic::Ordering::Relaxed);
        if adopted_live + revived + skipped_idle + stopped + failed > 0 {
            let boot_label = match boot {
                AdoptionBoot::UpdateRoster { .. } => "update",
                AdoptionBoot::PlainStartup => "plain",
            };
            self.note_worker_adoption(
                boot_label,
                adopted_live,
                revived,
                skipped_idle,
                stopped,
                failed,
            );
        }
        // TS arms the owner cleanup for every adopted worker: an owner that
        // does not reconnect within the grace loses its worker.
        for resident in self.registry.list().await {
            self.schedule_owned_worker_cleanup(&resident).await;
        }
        // The boot roster seed runs exactly once, in the background, now
        // that adoption settled: the registry's residents are the seed
        // roots. TS awaits its seed before adoption; the Rust daemon
        // deliberately accepts before and during adoption, so the seed
        // follows the pass and its one `roster_update` publish carries
        // the rows to early subscribers. Tests drain the pending-seed
        // barrier for completion.
        self.spawn_roster_boot_seed();
    }

    /// Adopt one persisted worker descriptor. Serialized against worker
    /// self-registration by the per-worker adoption gate: whichever path
    /// arrives first builds the roster entry; the other finds it present.
    async fn adopt_persisted_worker(
        self: &Arc<Self>,
        path: PathBuf,
        descriptor: crate::descriptor::WorkerDescriptor,
        boot: AdoptionBoot,
    ) -> AdoptionOutcome {
        let worker_id = descriptor.worker_id.clone();
        let guard = self.registry.adoption_guard(&worker_id).await;
        if self.registry.get(&worker_id).await.is_some() {
            // The worker re-registered before the descriptor scan reached it.
            self.log_line(&format!(
                "session worker {worker_id} already registered; skipping descriptor adoption"
            ));
            return AdoptionOutcome::AdoptedLive;
        }
        let socket_path = PathBuf::from(&descriptor.socket_path);
        let alive = socket::can_connect(&socket_path, Duration::from_millis(500)).await;
        let pid = descriptor.pid;
        let journal_path = PathBuf::from(&descriptor.recovery_journal_path);
        let resident = ResidentWorker::new(worker_id.clone(), descriptor, path);
        // The durable pending FIRST: a failed identity persist left a side record carrying the
        // moved-to identity — apply it before any routing or revival acts on the stale record.
        self.apply_identity_pending(&resident).await;
        // The stop tombstone outranks liveness (TS's stop ownership: the stop was durable intent
        // BEFORE the worker was told): a supervisor that died between the tombstone and the
        // shutdown finishes the stop on the next boot — never adopts it as healthy.
        if resident.descriptor.lock().await.stop_requested_at.is_some() {
            self.finish_tombstoned_stop(&resident, alive).await;
            return AdoptionOutcome::Stopped;
        }
        // The monitor must watch the process that actually runs, never the
        // descriptor's stale pre-restart pid (a revived worker was once left
        // orphaned behind a phantom-exit loop while serving live).
        let (result, revived_child) = if alive {
            let adopted = self
                .connect_worker(&resident, worker_connect_deadline())
                .await;
            if adopted.is_ok() {
                // The boot reconciliation: the adopted worker may already serve a superseded
                // session the persisted record never learned. Pull the live state BEFORE the
                // routing opens — the roster write carries the identity follow, so the record
                // and binding re-bind first.
                if !self.refresh_roster_entry(&resident).await {
                    // A failed pull is not proof the worker is dead: the resident is quarantined
                    // from every identity route until the live word lands (the routing refuses
                    // instead of serving the superseded identity).
                    resident.mark_identity_quarantined();
                    self.spawn_identity_reconciliation_retry(&resident);
                    self.log_line(&format!(
                        "session worker {worker_id}: the boot reconciliation pull failed; the resident is quarantined from routing until the live state lands"
                    ));
                }
                // The adopted worker's session already exists (its create ran before the
                // supervisor restart): routed client commands may reach it immediately.
                resident.note_session_ready();
            }
            (adopted, None)
        } else {
            let interrupted =
                crate::journal::WorkerRecoveryJournal::read_interrupted(&journal_path);
            let kept = match &boot {
                AdoptionBoot::UpdateRoster { kept } => kept.contains(&worker_id),
                AdoptionBoot::PlainStartup => false,
            };
            if !interrupted && !kept {
                // Dead worker with no durable busy state — and, on an update boot, not
                // kept: leave it down (the descriptor stays on disk); the session reopens
                // on the next client create.
                self.log_line(&format!(
                    "session worker {worker_id} was idle at exit; not revived (reopens on the next client open)"
                ));
                return AdoptionOutcome::SkippedIdle;
            }
            // The revival ownership gate: the busy-evidence filter answered "did the journal
            // ever prove live work?"; this gate answers "is that proof still a genuine
            // interruption THIS boot must heal?" A give-up, a stopped session, another
            // worker's lease, or stale evidence vetoes.
            let busy_recorded_at =
                crate::journal::WorkerRecoveryJournal::latest_busy_recorded_at(&journal_path);
            let gated = resident.descriptor.lock().await;
            let veto = crate::revival_gate::revival_veto(
                &self.options.agent_dir,
                &gated,
                kept,
                busy_recorded_at.as_deref(),
            );
            drop(gated);
            if let Some(veto) = veto {
                self.log_line(&format!(
                    "session worker {worker_id} not revived: {}",
                    veto.log_reason()
                ));
                return AdoptionOutcome::SkippedIdle;
            }
            // Dead worker with journal-proven live work (or a kept worker): relaunch from
            // the durable create command. The spawned child rides out to the monitor arming
            // below — the descriptor's pid is the DEAD pre-restart holder.
            match self.relaunch_worker(&resident).await {
                Ok(child) => (Ok(()), Some(child)),
                Err(error) => (Err(error), None),
            }
        };
        let outcome = match result {
            Ok(()) => {
                self.registry.insert(Arc::clone(&resident)).await;
                // A live leftover keeps its real pid; a revived worker is watched through
                // the child handle itself.
                match revived_child {
                    Some(child) => {
                        let child_pid = child.id().unwrap_or(0);
                        self.spawn_monitor(
                            Arc::clone(&resident),
                            Some(child),
                            u64::from(child_pid),
                        );
                    }
                    None => self.spawn_monitor(Arc::clone(&resident), None, pid),
                }
                // The adopted worker joins the roster from its live state.
                self.refresh_roster_entry(&resident).await;
                // A restore pass that owns this session's roster row can settle it now (spec
                // §10.4): the waiters attach to the live worker instead of queueing behind the
                // recovery — unless the row still needs its §10.5 continuation prompt.
                if let Some(session_file) = resident.descriptor.lock().await.session_file.clone() {
                    if let Some(stem) = Path::new(&session_file)
                        .file_stem()
                        .map(|stem| stem.to_string_lossy().to_string())
                    {
                        self.restore.settle_adopted(&stem);
                    }
                }
                self.log_line(&format!(
                    "adopted session worker {worker_id} (was alive: {alive})"
                ));
                if alive {
                    AdoptionOutcome::AdoptedLive
                } else {
                    AdoptionOutcome::Revived
                }
            }
            Err(error) => {
                self.log_line(&format!("could not adopt worker {worker_id}: {error:#}"));
                AdoptionOutcome::Failed
            }
        };
        drop(guard);
        outcome
    }

    /// `worker_register`: a session worker presenting its identity (boot registration or
    /// re-registration after a supervisor restart). The token was issued at spawn or
    /// adoption, so an unknown id or mismatch is rejected.
    pub(super) async fn handle_worker_register(
        self: &Arc<Self>,
        command_id: &str,
        type_name: &str,
        command: &DaemonCommand,
    ) -> DaemonResponse {
        let DaemonCommand::WorkerRegister {
            active_session_id,
            session_id,
            socket_path,
            worker_instance_id,
            token,
            pid,
            ..
        } = command
        else {
            return response_failure(Some(command_id), type_name, "not a registration", None);
        };
        let fail = |error: &str| response_failure(Some(command_id), type_name, error, None);
        if self.shutting_down.load(Ordering::SeqCst) {
            return fail("Supervisor is shutting down");
        }
        if active_session_id.is_empty() || socket_path.is_empty() || *pid == 0 {
            return fail("Session worker registration is missing identity fields");
        }
        let worker_instance_id =
            (!worker_instance_id.is_empty()).then(|| worker_instance_id.clone());
        let registration = WorkerRegistration {
            active_session_id: active_session_id.clone(),
            session_id: session_id
                .clone()
                .filter(|value: &String| !value.is_empty()),
            socket_path: socket_path.clone(),
            worker_instance_id: worker_instance_id.clone(),
            pid: *pid,
        };
        // Serialize against descriptor adoption for the same worker.
        let guard = self.registry.adoption_guard(active_session_id).await;
        let resident = match self.registry.get(active_session_id).await {
            Some(resident) => resident,
            None => match self.adopt_registered_worker(&registration, token).await {
                Ok(resident) => resident,
                Err(error) => {
                    let message = format!("{error:#}");
                    // The definitive unknown-worker refusal is observable (log + telemetry)
                    // and the worker retires on it: a live worker with no descriptor would
                    // otherwise hold its lease forever.
                    if message.starts_with(crate::registration::UNKNOWN_SESSION_WORKER_PREFIX) {
                        self.log_line(&format!(
                            "session worker {active_session_id} registration refused (no descriptor on this supervisor); the worker retires and its session file stays resumable"
                        ));
                        self.note_daemon_event("registration_refused", None);
                    }
                    return fail(&message);
                }
            },
        };
        // The registration's durable id is optional on the wire: a re-registering worker
        // that does not report it still owns its persisted descriptor. Both reads share
        // this one lock acquisition — a second one let the create path race into a stall.
        let durable_session_id = {
            let mut descriptor = resident.descriptor.lock().await;
            if token.as_str() != descriptor.authentication_token {
                return fail("Session worker authentication failed");
            }
            let previous_worker_instance_id = descriptor.worker_instance_id.clone();
            // A REPLACEMENT registration flips the roster's stale-delta slot to the replacement
            // BEFORE it is exposed anywhere: a predecessor's pull or frame still in flight must
            // meet the slot naming the replacement; a re-register keeps it untouched.
            if previous_worker_instance_id.as_deref() != worker_instance_id.as_deref() {
                let replacement = worker_instance_id.clone().unwrap_or_default();
                let mut roster = self.roster.lock().unwrap();
                roster.note_worker_generation(&resident.worker_id, &replacement);
            }
            descriptor.pid = *pid;
            // Refresh the identity from the live registrant: a recycled pid must not keep
            // the old holder's identity; an unobservable start id keeps the previous value.
            if let Some(start_id) = crate::protocol::process_start_id(*pid as u32) {
                descriptor.process_start_id = Some(start_id);
            }
            descriptor.socket_path.clone_from(socket_path);
            descriptor
                .worker_instance_id
                .clone_from(&worker_instance_id);
            if let Some(session_id) = &registration.session_id {
                descriptor.root_session_id = Some(session_id.clone());
            }
            descriptor.lifecycle = DaemonWorkerLifecycle::Ready;
            // A (re-)registered worker refreshes its binding: the id stays addressable
            // with its current durable identity; a newly owned session file supersedes.
            self.record_session_binding(
                active_session_id,
                descriptor.root_session_id.as_deref(),
                descriptor.session_file.as_deref(),
            );
            // The registration refreshes the resident in memory only — no
            // persist here. The spawn record already carries the
            // launch-time identity (pid, socket), and the create-completion
            // persist (`launch_worker`'s post-create write) owns the next
            // durable state — `Ready` with the session identity — as the
            // metadata-survival barrier. The boot scan adopts a live worker
            // socket-first regardless of the recorded lifecycle, and a dead
            // worker's recovery replays the durable create command.
            let durable_session_id = match registration.session_id.clone() {
                Some(session_id) => Some(session_id),
                None => descriptor
                    .session_file
                    .clone()
                    .as_deref()
                    .and_then(|file| Path::new(file).file_stem())
                    .map(|stem| stem.to_string_lossy().to_string()),
            };
            durable_session_id
        };
        let record = self.registry.record_registration(registration).await;
        // A restore pass that owns this session's roster row can settle it now (spec §10.4).
        // The settle lands after the registration is recorded, so a woken waiter's
        // re-resolve cannot miss it.
        if let Some(session_id) = durable_session_id {
            self.restore.settle_adopted(&session_id);
        }
        let verb = if record.epoch > 1 {
            "re-registered"
        } else {
            "registered"
        };
        self.log_line(&format!(
            "session worker {active_session_id} {verb} (epoch {}, pid {pid})",
            record.epoch
        ));
        drop(guard);
        // Registration rebuilt the resident: refresh its roster entry from
        // the live worker so the roster reflects the re-registered state.
        self.refresh_roster_entry(&resident).await;
        // A worker that registers after the boot seed publishes its passive ledger family in
        // the background: TS reseeds on the worker's first roster snapshot, and this port's
        // workers push only their own summary, so the daemon walks the family here.
        let family_root = {
            let descriptor = resident.descriptor.lock().await;
            descriptor
                .session_file
                .clone()
                .or_else(|| descriptor.create_command.session_path.clone())
        };
        if let Some(root) = family_root {
            self.spawn_roster_registration_seed(Path::new(&root));
        }
        response_success(
            Some(command_id),
            type_name,
            Some(json!({
                "workerId": active_session_id,
                "sessionId": session_id,
                "supervisorGeneration": format!("sup:{}", std::process::id()),
                "supervisorPid": std::process::id(),
                "epoch": record.epoch,
            })),
        )
    }

    /// A registration for a worker with no roster entry: adopt it from its
    /// persisted descriptor (the durable fallback record). The registration
    /// proves the worker process is alive; adoption connects it for routing.
    async fn adopt_registered_worker(
        self: &Arc<Self>,
        registration: &WorkerRegistration,
        token: &str,
    ) -> Result<Arc<ResidentWorker>> {
        let descriptor_path = self
            .descriptor_dir
            .join(format!("{}.json", registration.active_session_id));
        let content = match std::fs::read_to_string(&descriptor_path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // The TS unknown-worker error: this supervisor holds no descriptor for
                // the identity, so it can never adopt the registrant, which retires.
                return Err(anyhow!(
                    "{}: {}",
                    crate::registration::UNKNOWN_SESSION_WORKER_PREFIX,
                    registration.active_session_id
                ));
            }
            // An unreadable descriptor is NOT an unknown worker: the identity exists on disk,
            // and retiring it over a transient I/O failure would strand a live lease holder.
            Err(error) => {
                return Err(anyhow!(
                    "descriptor read failed for {}: {error}",
                    registration.active_session_id
                ));
            }
        };
        let descriptor: crate::descriptor::WorkerDescriptor = serde_json::from_str(&content)
            .with_context(|| format!("invalid descriptor {}", descriptor_path.display()))?;
        crate::descriptor::validate_descriptor(&descriptor, &self.options.socket_path)?;
        if token != descriptor.authentication_token.as_str() {
            return Err(anyhow!("Session worker authentication failed"));
        }
        let worker_id = descriptor.worker_id.clone();
        let resident = ResidentWorker::new(
            registration.active_session_id.clone(),
            descriptor,
            descriptor_path,
        );
        // The durable pending (the same repair the descriptor adoption runs): apply the failed
        // follow's side record before the routing opens, so the moved-to session is served.
        self.apply_identity_pending(&resident).await;
        // A tombstoned identity is mid-stop (TS `adoptOrRecoverWorker`'s stopRequestedAt
        // branch): adoption finishes the stop and never adopts the worker as healthy.
        // The refusal is transient: the next attempt converges on the stop's completion.
        if resident.descriptor.lock().await.stop_requested_at.is_some() {
            // The registering process is the identity the stop must retire: the persisted
            // descriptor carries the stopped worker's stale pid, so observing the
            // registrant's live identity keeps the escalation tied to the live process.
            {
                let mut descriptor = resident.descriptor.lock().await;
                if descriptor.pid != registration.pid {
                    descriptor.pid = registration.pid;
                }
                if let Some(start_id) = crate::lease::get_process_start_id(registration.pid as u32)
                {
                    descriptor.process_start_id = Some(start_id);
                }
                let _ = crate::descriptor::persist_worker(&resident.descriptor_path, &descriptor);
            }
            self.finish_tombstoned_stop(&resident, true).await;
            return Err(anyhow!(
                "session worker {} is stopping: the stop was forwarded; registration refused",
                registration.active_session_id
            ));
        }
        self.connect_worker(&resident, worker_connect_deadline())
            .await?;
        // The boot reconciliation: registration rebuilt the resident from the PERSISTED record;
        // the worker may already serve a replacement the record never learned. Pull the live
        // state BEFORE the resident joins the registry, so the record and binding re-bind first.
        if !self.refresh_roster_entry(&resident).await {
            // A failed pull is not proof the worker is dead: the resident is quarantined
            // from every identity route until the live word lands.
            resident.mark_identity_quarantined();
            self.spawn_identity_reconciliation_retry(&resident);
            self.log_line(&format!(
                "session worker {worker_id}: the registration reconciliation pull failed; the resident is quarantined from routing until the live state lands"
            ));
        }
        // The self-registered worker's session already exists: routed
        // client commands may reach it immediately.
        resident.note_session_ready();
        self.registry.insert(Arc::clone(&resident)).await;
        self.spawn_monitor(Arc::clone(&resident), None, registration.pid);
        self.log_line(&format!(
            "adopted session worker {worker_id} via self-registration"
        ));
        Ok(resident)
    }

    /// Record one RLM child admission: the spawn edge in the daemon-owned
    /// ledger (durable topology) and the child's display file (hydration
    /// metadata). No-op for top-level sessions.
    pub(super) async fn record_rlm_child_admission(
        self: &Arc<Self>,
        command: &DaemonCommand,
        summary: &Value,
    ) -> Result<()> {
        let DaemonCommand::Create {
            name,
            config,
            runtime_metadata,
            ..
        } = command
        else {
            return Ok(());
        };
        let Some(metadata) = runtime_metadata else {
            return Ok(());
        };
        if metadata.get("kind").and_then(Value::as_str) != Some("subagent") {
            return Ok(());
        }
        let child_id = metadata
            .get("rlmChildId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("RLM child admission is missing rlmChildId"))?
            .to_string();
        let depth = metadata
            .get("rlmDepth")
            .and_then(Value::as_u64)
            .unwrap_or(1) as u32;
        let parent = metadata
            .get("parentSessionFile")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("RLM child admission is missing parentSessionFile"))?;
        let child = summary
            .get("sessionFile")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("RLM child admission is missing the child session file"))?;
        let session_name = summary
            .get("sessionName")
            .and_then(Value::as_str)
            .or(name.as_deref())
            .unwrap_or_default()
            .to_string();
        let session_dir = config
            .as_ref()
            .and_then(|config| config.get("sessionDir"))
            .and_then(Value::as_str)
            .map_or_else(
                || {
                    Path::new(child)
                        .parent()
                        .map(|dir| dir.to_string_lossy().to_string())
                        .unwrap_or_default()
                },
                str::to_string,
            );
        let ledger = self.rlm_spawn_ledger_for(None).await?;
        ledger
            .append_spawn(&crate::rlm_ledger::RlmSpawnInput {
                child_id: child_id.clone(),
                parent: parent.to_string(),
                child: child.to_string(),
                depth,
                name: session_name.clone(),
            })
            .inspect_err(|error| {
                self.log_line(&format!("failed to append RLM ledger spawn: {error:#}"));
            })?;
        let display = crate::rlm_ledger::RlmSubagentDisplayEntry {
            type_tag: "rlm_subagent".to_string(),
            child_id,
            session_name,
            session_dir,
            session_file: child.to_string(),
            rlm_parent_node_id: metadata
                .get("rlmParentNodeId")
                .and_then(Value::as_str)
                .map(str::to_string),
            prompt: metadata
                .get("prompt")
                .and_then(Value::as_str)
                .map(str::to_string),
            spawn_code: metadata
                .get("spawnCode")
                .and_then(Value::as_str)
                .map(str::to_string),
            model: metadata.get("model").cloned(),
            status: "running".to_string(),
            created_at: metadata
                .get("createdAt")
                .and_then(Value::as_u64)
                .unwrap_or_else(crate::util::now_ms),
        };
        let written =
            crate::rlm_ledger::write_rlm_subagent_display(&display).inspect_err(|error| {
                self.log_line(&format!(
                    "failed to persist RLM subagent display entry: {error:#}"
                ));
            })?;
        if !written {
            self.log_line(&format!(
                "skipped RLM subagent display entry for {}: deleted tombstone exists",
                display.child_id
            ));
        }
        Ok(())
    }
}
