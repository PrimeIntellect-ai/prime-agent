//! Worker adoption: the boot discovery pass and the per-worker
//! adoption outcomes.

use std::sync::Arc;

use super::{adoption, clients, options, routing, sessions, subscribers};

/// The boot the descriptor-adoption pass runs under. An update boot
/// relaunches kept workers from their descriptors before the roster
/// restore walks the rows (spec §6 step 2's create-or-adopt order). A
/// plain startup adopts live workers and revives only genuinely
/// interrupted ones: a supervisor restart must not mass-revive the
/// historical idle/completed sessions a TS daemon leaves down (their
/// clients reopen them lazily through a fresh create).
#[derive(Clone, PartialEq, Eq)]
pub(super) enum AdoptionBoot {
    /// Update boot: the roster's kept workers (by worker id) relaunch
    /// eagerly ahead of the restore pass; busy-at-crash workers revive
    /// too. Descriptors the update does not keep stay down — the update
    /// must not revive the sessions a plain boot parked (a reopened
    /// session file may already have a newer worker). The kept set is
    /// shared (an `Arc`): one clone per descriptor task, not a deep
    /// copy of every kept id per task.
    UpdateRoster {
        kept: Arc<std::collections::HashSet<String>>,
    },
    /// Plain startup: only journal-proven live work revives.
    PlainStartup,
}

/// One descriptor's boot-adoption decision, reported as a count in the
/// pass's `worker_adoption` event (telemetry: counts only, never session
/// payload).
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
    /// Adoption or relaunch failed.
    Failed,
}

impl Supervisor {
    /// Emit the boot descriptor-adoption pass's `daemon event` (schema v1,
    /// kind `worker_adoption`): the boot kind and per-outcome counts,
    /// primitives only — never session payload.
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

    /// Adopt or relaunch persisted workers, concurrently: one dead worker's
    /// relaunch (create replay) must not delay adopting live sessions. The
    /// fan-out is capped ([`crate::recovery_pacing::ADOPTION_CONCURRENCY`]):
    /// a large sessions dir must not turn the pass into a relaunch storm
    /// that starves the control plane for its whole duration. The pass
    /// reports its decisions as one `worker_adoption` event (counts only,
    /// never session payload).
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
    /// arrives first (descriptor scan or live re-registration) builds the
    /// roster entry; the other one finds it present.
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
        // The stop tombstone outranks liveness (TS's stop ownership: the
        // stop was durable intent BEFORE the worker was told): a
        // supervisor that died between the tombstone and the worker's
        // shutdown finishes the stop on the next boot — never adopts the
        // still-reachable worker as healthy (that would drop the stop and
        // leave the stopped session resident).
        if resident.descriptor.lock().await.stop_requested_at.is_some() {
            self.finish_tombstoned_stop(&resident, alive).await;
            return AdoptionOutcome::Stopped;
        }
        // The adoption answer plus the revival's spawned child, when one
        // was launched: the monitor must watch the process that actually
        // runs, never the descriptor's stale pre-restart pid (the
        // zombie-holder incident: a revived worker was alive and serving
        // while the monitor polled the dead pid the supervisor replaced,
        // counted six phantom exits, gave up on the id, and left the live
        // holder - lease and all - orphaned with every create refused).
        let (result, revived_child) = if alive {
            let adopted = self
                .connect_worker(&resident, worker_connect_deadline())
                .await;
            if adopted.is_ok() {
                // The adopted worker's session already exists (its create
                // ran before the supervisor restart): routed client
                // commands may reach it immediately.
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
                // Dead worker with no durable busy state — and, on an
                // update boot, not kept by the update's roster: not
                // interrupted work. Leave it down (the descriptor stays
                // on disk, inert) — the session reopens lazily through
                // the next client create, like a TS supervisor that
                // parks dead workers instead of reviving them; an
                // update that did not keep it must not revive it either.
                self.log_line(&format!(
                    "session worker {worker_id} was idle at exit; not revived (reopens on the next client open)"
                ));
                return AdoptionOutcome::SkippedIdle;
            }
            // The revival ownership gate: the busy-evidence filter above
            // answered "did the journal ever prove live work?"; this gate
            // answers "is that proof still a genuine interruption THIS
            // boot must heal?" A give-up verdict (lifecycle `failed`), a
            // stopped session (the #2592 archived belt), a live session
            // lease held by another worker (this daemon's or another
            // daemon's, on a shared agent dir), or busy evidence older
            // than the freshness bound each vetoes the relaunch: the
            // descriptor stays down and the session reopens through the
            // next client create. Without the gate a boot re-storms the
            // same dead slots (stale journals outliving their era) and
            // resurrects stopped sessions as active workers.
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
            // Dead worker with journal-proven live work (or a kept
            // worker on an update boot): relaunch from the durable
            // create command. The worker rehydrates the session store,
            // restoring history and the persisted queue snapshot. The
            // spawned child rides out to the monitor arming below: the
            // descriptor's pid is the DEAD pre-restart holder, and a
            // monitor parked on it reports a phantom exit of a process
            // this very adoption just launched.
            match self.relaunch_worker(&resident).await {
                Ok(child) => (Ok(()), Some(child)),
                Err(error) => (Err(error), None),
            }
        };
        let outcome = match result {
            Ok(()) => {
                self.registry.insert(Arc::clone(&resident)).await;
                // A live leftover keeps its real pid; a revived worker is
                // watched through the child handle itself (the pid the
                // spawn recorded in the descriptor, never the stale one).
                match revived_child {
                    Some(child) => {
                        let child_pid = child.id().unwrap_or(0);
                        self.spawn_monitor(Arc::clone(&resident), Some(child), u64::from(child_pid));
                    }
                    None => self.spawn_monitor(Arc::clone(&resident), None, pid),
                }
                // The adopted worker joins the roster from its live state.
                self.refresh_roster_entry(&resident).await;
                // A restore pass that owns this session's roster row can
                // settle it now (spec §10.4): the per-target waiters attach
                // to the live worker instead of queueing behind the rest
                // of the recovery — unless the row still needs its
                // continuation prompt (§10.5): those waiters wake only
                // when the pass routes it. No pass, no roster row: a no-op.
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

    /// `worker_register`: a session worker presenting its identity (boot
    /// registration or re-registration after this supervisor restarted).
    /// The token was issued when the supervisor spawned or adopted the
    /// worker, so an unknown worker id or a token mismatch is rejected.
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
                    // The definitive unknown-worker refusal is the one
                    // registration verdict the box incident left invisible:
                    // a live worker whose descriptor is gone can never be
                    // adopted again, and before the self-heal it lingered
                    // silently, holding its session lease against every
                    // future resume. The refusal is now observable (log +
                    // telemetry) and the worker retires on it.
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
        // Refresh the durable identity from the live worker (the token was
        // issued by this supervisor; a mismatch is a rogue registration).
        // The registration's durable id is optional on the wire: a
        // re-registering worker that does not report it still owns its
        // persisted descriptor, whose session-file stem addresses the same
        // roster row (a fresh create's registration lands before the
        // create replay assigns the session, so this reads the persisted
        // path). Both reads share this one lock acquisition - the
        // create path holds this mutex around its own replay steps, and a
        // second acquisition here let the two race into a stall.
        let durable_session_id = {
            let mut descriptor = resident.descriptor.lock().await;
            if token.as_str() != descriptor.authentication_token {
                return fail("Session worker authentication failed");
            }
            let previous_worker_instance_id = descriptor.worker_instance_id.clone();
            // A REPLACEMENT registration flips the roster's stale-delta
            // slot to the replacement BEFORE the replacement is exposed
            // anywhere — the descriptor update below, the persisted
            // record, the recorded registration: a predecessor's pull or
            // frame still in flight must already meet the slot naming the
            // replacement (its own stamp mismatches and drops), never the
            // predecessor it carries. A same-process re-register (a
            // dropped supervisor link, a create replay) keeps the slot
            // untouched — the counter did not restart.
            if previous_worker_instance_id.as_deref() != worker_instance_id.as_deref() {
                let replacement = worker_instance_id.clone().unwrap_or_default();
                let mut roster = self.roster.lock().unwrap();
                roster.note_worker_generation(&resident.worker_id, &replacement);
            }
            descriptor.pid = *pid;
            // Refresh the identity from the live registrant (TS captures
            // an identity while the process is known alive): a supervisor
            // restart re-adopts the worker, and a pid that was recycled in
            // between must not keep the old holder's identity. An
            // unobservable start id keeps the previous value (a possibly
            // live worker is never orphaned on a transient lookup failure).
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
            // A (re-)registered worker refreshes its binding: the id stays
            // addressable with its current durable identity across supervisor
            // restarts, and a session file this id newly owns supersedes any
            // earlier binding to it.
            self.record_session_binding(
                active_session_id,
                descriptor.root_session_id.as_deref(),
                descriptor.session_file.as_deref(),
            );
            let _ = persist_worker(&resident.descriptor_path, &descriptor);
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
        // A restore pass that owns this session's roster row can settle it
        // now (spec §10.4): the live worker serves the row's waiters
        // without queueing behind the rest of the recovery. Covers the
        // self-registration that beats the descriptor scan (the adoption
        // early return) and `adopt_registered_worker` alike; a no-op when
        // no pass owns the row, and never wakes a row still pending its
        // §10.5 continuation prompt. The settle lands after the
        // registration is recorded, so a woken waiter's re-resolve cannot
        // miss it.
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
        // A worker that registers after the boot seed (a supervisor
        // restart's re-registration, a mid-tree resume, a wakened ledger
        // child) publishes its passive ledger family in the background:
        // TS reseeds the family when the worker's first roster snapshot
        // applies (`applyWorkerRosterSnapshot`), and this port's workers
        // push only their own summary, so the daemon walks the family
        // here instead. Registration answers on the client's open path -
        // the seed never blocks it.
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
                // The TS unknown-worker error: this supervisor holds no
                // descriptor for the identity, so it can never adopt the
                // registrant. The worker treats the verdict as terminal
                // (the refused-registration self-heal) and retires
                // instead of retrying forever.
                return Err(anyhow!(
                    "{}: {}",
                    crate::registration::UNKNOWN_SESSION_WORKER_PREFIX,
                    registration.active_session_id
                ));
            }
            // An unreadable descriptor is NOT an unknown worker: the
            // identity exists on disk, and retiring it over a transient
            // I/O failure (permissions, a torn read) would strand a live
            // lease holder behind a healable condition. The worker keeps
            // its backoff loop; the next attempt re-reads the file.
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
        // A tombstoned identity is mid-stop (TS `adoptOrRecoverWorker`'s
        // stopRequestedAt branch): adoption finishes the stop — the
        // original command forwarded, the variant's finalize belt, the
        // descriptor retired with the process — and never adopts the
        // worker as healthy (that would undo the stop and leave the
        // stopped session held by the leftover process). The refusal is
        // transient: the worker's next attempt reads the retired
        // descriptor (or the still-tombstoned one) and converges on the
        // stop's completion - the definitive verdict once the process is
        // provably gone.
        if resident.descriptor.lock().await.stop_requested_at.is_some() {
            // The registering process is the identity the stop must
            // retire: the persisted descriptor still carries the stopped
            // worker's stale pid, so observing the registrant's live
            // identity first keeps the retire pass's escalation - and the
            // descriptor's death - tied to the process that actually
            // holds the session (TS `adoptOrRecoverWorker` persists the
            // observed start id after its authenticated connect).
            // Without this, a replacement registrant's stop would retire
            // the stale pid, conclude the replacement was gone, and
            // orphan the live worker as an unadoptable lease holder.
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
        // The self-registered worker's session already exists: routed
        // client commands may reach it immediately.
        resident.note_session_ready();
        self.registry.insert(Arc::clone(&resident)).await;
        self.spawn_monitor(Arc::clone(&resident), None, registration.pid);
        self.refresh_roster_entry(&resident).await;
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
            .append_spawn(crate::rlm_ledger::RlmSpawnInput {
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
