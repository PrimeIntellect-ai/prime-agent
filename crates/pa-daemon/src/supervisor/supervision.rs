//! Worker supervision: the watch loop, the restart backoff, and
//! the spawn/connect plumbing.
use super::routing::{fail_unsent_request, WORKER_REQUEST_TIMEOUT_MS, WORKER_SOCKET_CLOSED};
use super::{
    anyhow, connect_transport, create_command_payload, json, mpsc, persist_worker,
    persist_worker_at, probe_worker_socket, util, write_frame, Arc, Child, ClientRouting, Command,
    Context, DaemonWorkerLifecycle, Duration, Ordering, PathBuf, PrivateFrameReader,
    ResidentWorker, Result, RouteAdmission, Supervisor, TempSync, TypedCreateRejection, Value,
    WorkerReply, WorkerRequest, DEFAULT_PRIVATE_FRAME_LIMITS, ROUTE_TIMEOUT_MS,
    WORKER_AUTH_FLOOR_MS,
};
use crate::lease::is_process_alive;
use crate::registry::WorkerRelay;

pub(super) const MAX_CONSECUTIVE_FAILURES: u32 = 5;
/// A crash-path child that lived at least this long proved health: its death resets
/// the failure count instead of accumulating toward the give-up cap.
pub(super) const STABLE_LIFETIME_MS: u64 = 30_000;
const BASE_BACKOFF_MS: u64 = 250;
const MAX_BACKOFF_MS: u64 = 30_000;

/// A failed/cancelled authentication must close both pump-owned socket halves.
struct PreAuthPumps {
    writer: tokio::task::JoinHandle<()>,
    reader: tokio::task::JoinHandle<()>,
    resident: Arc<ResidentWorker>,
    epoch: u64,
    installed: bool,
}

impl Drop for PreAuthPumps {
    fn drop(&mut self) {
        if !self.installed {
            self.writer.abort();
            self.reader.abort();
            self.resident.note_connection_lost(self.epoch);
            // A cancelled auth future skips route_command_on's timed-out
            // cleanup. Its dropped oneshot receiver identifies only this
            // attempt's pending slot, without disturbing newer routes.
            let resident = Arc::clone(&self.resident);
            tokio::spawn(async move {
                resident
                    .pending
                    .lock()
                    .await
                    .retain(|_, reply| !reply.is_closed());
            });
        }
    }
}
/// The adopted-worker liveness poll used only where the kernel exit watch
/// cannot register (no pidfd, descriptor exhaustion, Windows).
const ADOPTED_EXIT_FALLBACK_POLL: Duration = Duration::from_secs(30);

impl Supervisor {
    /// The crash path's failure-count update: a stable-lifetime child was healthy, so its
    /// death starts a fresh count; a spawn-dies-fast child (or an adopted pid) accumulates.
    pub(super) fn next_failure_count(resident: &ResidentWorker, now_ms: u64) -> u32 {
        let spawned_at = resident.spawned_at_ms.load(Ordering::SeqCst);
        let stable = spawned_at > 0 && now_ms.saturating_sub(spawned_at) >= STABLE_LIFETIME_MS;
        if stable {
            resident.consecutive_failures.store(1, Ordering::SeqCst);
            1
        } else {
            resident.consecutive_failures.fetch_add(1, Ordering::SeqCst) + 1
        }
    }

    pub(super) fn spawn_monitor(
        self: &Arc<Self>,
        resident: Arc<ResidentWorker>,
        child: Option<Child>,
        pid: u64,
    ) {
        let supervisor = Arc::clone(self);
        let monitor_epoch = resident.monitor_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        tokio::spawn(async move {
            supervisor
                .watch_worker_owned(resident, child, pid, monitor_epoch)
                .await;
        });
    }

    #[cfg(test)]
    pub(super) async fn watch_worker(
        self: Arc<Self>,
        resident: Arc<ResidentWorker>,
        child: Option<Child>,
        adopted_pid: u64,
    ) {
        let monitor_epoch = resident.monitor_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        self.watch_worker_owned(resident, child, adopted_pid, monitor_epoch)
            .await;
    }

    async fn watch_worker_owned(
        self: Arc<Self>,
        resident: Arc<ResidentWorker>,
        mut child: Option<Child>,
        mut adopted_pid: u64,
        monitor_epoch: u64,
    ) {
        let mut watched_identity = {
            let descriptor = resident.descriptor.lock().await;
            (
                child
                    .as_ref()
                    .and_then(Child::id)
                    .map(u64::from)
                    .or((adopted_pid != 0).then_some(adopted_pid))
                    .unwrap_or(descriptor.pid),
                descriptor.worker_instance_id.clone(),
            )
        };
        loop {
            // The monitor owns this particular process lifetime. A worker
            // that registers a replacement while this watch waits or backs
            // off takes over the resident; the old watch must not relaunch
            // over its authenticated channel.
            let (watched_pid, watched_generation) = watched_identity.clone();
            if let Some(mut child) = child.take() {
                let status = child.wait().await;
                if resident.intentional_stop.load(Ordering::SeqCst)
                    || self.shutting_down.load(Ordering::SeqCst)
                {
                    self.log_line(&format!(
                        "session worker {} stopped intentionally (status {status:?})",
                        resident.worker_id
                    ));
                    self.note_daemon_event("worker_exited", Some("normal"));
                    return;
                }
            } else if adopted_pid != 0 {
                // Adopted worker (no Child handle): park on the kernel's
                // exit notification for the pid. A previous relaunch that
                // produced no worker leaves pid 0 here - there is nothing
                // to watch, and a watch on pid 0 would report a phantom
                // exit; fall straight to the failure/backoff/relaunch arm
                // instead.
                if let Err(error) =
                    pa_core::platform::process::wait_for_exit(adopted_pid as u32).await
                {
                    // The slow fallback, only where the kernel exit watch
                    // cannot register.
                    self.log_line(&format!(
                        "session worker {}: kernel exit watch unavailable ({error}); polling liveness every {}s",
                        resident.worker_id,
                        ADOPTED_EXIT_FALLBACK_POLL.as_secs()
                    ));
                    while matches!(is_process_alive(adopted_pid as u32), Ok(true)) {
                        tokio::time::sleep(ADOPTED_EXIT_FALLBACK_POLL).await;
                    }
                }
                // A relaunch elsewhere (update abandon, retry) took over the
                // resident with a new process.
                if self.is_stopping(&resident) {
                    return;
                }
            }
            // The old process's exit is not ownership of the resident. A
            // replacement may have registered while wait() was pending;
            // serialize the identity check with registration before any
            // child cleanup, failure bookkeeping, or give-up finalization.
            let crash_guard = self.registry.adoption_guard(&resident.worker_id).await;
            let replacement_registered = {
                let descriptor = resident.descriptor.lock().await;
                descriptor.pid != watched_pid || descriptor.worker_instance_id != watched_generation
            };
            if self.is_stopping(&resident)
                || resident.monitor_epoch.load(Ordering::SeqCst) != monitor_epoch
            {
                return;
            }
            if replacement_registered {
                // Keep the one monitor owner, but watch the registrant's process
                // before attributing any exit or failure to its generation.
                let descriptor = resident.descriptor.lock().await;
                adopted_pid = descriptor.pid;
                watched_identity = (descriptor.pid, descriptor.worker_instance_id.clone());
                // An external registration has no observed spawn time. Do not
                // award it the predecessor's stable-lifetime counter reset.
                resident.spawned_at_ms.store(0, Ordering::SeqCst);
                continue;
            }
            self.note_daemon_event("worker_exited", Some("crash"));
            // A hard-killed parent bypasses every worker-side close (#246): close the
            // resident RLM children here, before the restart, so a relaunched parent
            // never resumes beside an orphaned child worker.
            self.close_children_of_dead_parent(&resident).await;
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_millis() as u64);
            let failures = Self::next_failure_count(&resident, now_ms);
            if failures > MAX_CONSECUTIVE_FAILURES {
                // A stop during the storm owns the terminal state: the give-up must
                // not persist `Failed` over the stop's tombstone or recreate a deleted
                // descriptor (the next boot would adopt a stopped worker as `GaveUp`).
                if self.is_stopping(&resident) {
                    return;
                }
                let mut descriptor = resident.descriptor.lock().await;
                descriptor.lifecycle = DaemonWorkerLifecycle::Failed;
                descriptor.last_failure_at = Some(util::now_iso());
                let journal_path = descriptor.recovery_journal_path.clone();
                let _ = persist_worker(&resident.descriptor_path, &descriptor);
                drop(descriptor);
                // The give-up settles its own revival evidence: the journal's busy records
                // are what a later boot reads as "interrupted live work" — the give-up
                // verdict must outlive them.
                if let Err(error) = crate::journal::WorkerRecoveryJournal::settle_busy_records(
                    std::path::Path::new(&journal_path),
                    "worker_gave_up",
                ) {
                    self.log_line(&format!(
                        "session worker {} give-up journal settle failed: {error:#}",
                        resident.worker_id
                    ));
                }
                // The give-up is final: routes waiting out this worker's
                // replacement must fail fast instead of parking.
                resident.note_retired();
                self.registry.remove(&resident.worker_id).await;
                // The residency change lands in the scheduled-jobs invalidation (TS
                // `broadcastHeartbeatsChanged`): the dead worker's durable jobs are passive
                // from here on, so a snapshot from while it was live must not be served again.
                self.broadcast_heartbeats_changed();
                // The give-up settles the dead worker's rows exactly like a stop: owned
                // non-ephemeral, non-queued rows passivate and keep their model/thinking/cwd.
                let ephemeral = resident.descriptor.lock().await.owner_client_id.is_some();
                self.passivate_roster_worker(&resident.worker_id, ephemeral)
                    .await;
                // The exhausted-failure state must release the session hold: the belt reaps
                // the id's same-socket leftovers identity-gated; the lease self-heals on
                // the next acquire.
                crate::boot_reap::reap_abandoned_workers(&self, &resident.worker_id).await;
                self.log_line(&format!(
                    "session worker {} failed after {failures} consecutive failures",
                    resident.worker_id
                ));
                // Keep the registration guard discoverable until every awaited
                // give-up effect has finished; a new registration must not
                // acquire a different lock while this one is still active.
                self.registry.forget(&resident.worker_id).await;
                return;
            }
            drop(crash_guard);
            let backoff_ms = (BASE_BACKOFF_MS << (failures - 1).min(7)).min(MAX_BACKOFF_MS);
            self.log_line(&format!(
                "session worker {} exited unexpectedly; restarting in {backoff_ms}ms (failure {failures}/{MAX_CONSECUTIVE_FAILURES})",
                resident.worker_id
            ));
            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            // Serialize the monitor's replacement with registration handoff.
            // A simultaneous registration's connect_worker clears pending
            // replies; it must finish before this replay installs and awaits
            // its create reply. Boot adoption already owns this same guard.
            let _registration_guard = self.registry.adoption_guard(&resident.worker_id).await;
            let replacement_registered = {
                let descriptor = resident.descriptor.lock().await;
                descriptor.pid != watched_pid || descriptor.worker_instance_id != watched_generation
            };
            if self.is_stopping(&resident)
                || resident.monitor_epoch.load(Ordering::SeqCst) != monitor_epoch
            {
                return;
            }
            if replacement_registered {
                // Keep the one monitor owner, but watch the registrant's process
                // before attributing any exit or failure to its generation.
                let descriptor = resident.descriptor.lock().await;
                adopted_pid = descriptor.pid;
                watched_identity = (descriptor.pid, descriptor.worker_instance_id.clone());
                // An external registration has no observed spawn time. Do not
                // award it the predecessor's stable-lifetime counter reset.
                resident.spawned_at_ms.store(0, Ordering::SeqCst);
                continue;
            }
            match self.relaunch_worker(&resident).await {
                Ok(new_child) => {
                    // No counter reset on a successful relaunch: a spawn that dies fast must
                    // accumulate toward the give-up cap (the reset comes only from a stable
                    // lifetime on the crash path).
                    self.note_daemon_event("worker_restarted", None);
                    watched_identity = {
                        let descriptor = resident.descriptor.lock().await;
                        (
                            new_child.id().map_or(descriptor.pid, u64::from),
                            descriptor.worker_instance_id.clone(),
                        )
                    };
                    child = Some(new_child);
                }
                Err(error) => {
                    self.log_line(&format!(
                        "worker {} relaunch failed: {error:#}",
                        resident.worker_id
                    ));
                    child = None;
                    adopted_pid = 0;
                    watched_identity = {
                        let descriptor = resident.descriptor.lock().await;
                        (descriptor.pid, descriptor.worker_instance_id.clone())
                    };
                    if self.is_stopping(&resident) {
                        return;
                    }
                    // A failed relaunch has no lifetime of its own: clear
                    // the spawn time so the count accumulates to the give-up cap.
                    resident.spawned_at_ms.store(0, Ordering::SeqCst);
                }
            }
        }
    }

    pub(crate) fn is_stopping(&self, resident: &Arc<ResidentWorker>) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
            || resident.intentional_stop.load(Ordering::SeqCst)
    }

    /// Whether the supervisor is tearing down (long-lived daemon tasks
    /// poll this instead of holding their own shutdown wiring).
    pub(crate) fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    /// Spawn a fresh worker process, connect, and replay the durable create.
    pub(crate) async fn relaunch_worker(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
    ) -> Result<Child> {
        if self.is_stopping(resident) {
            return Err(anyhow!("supervisor is shutting down"));
        }
        // The replacement's create replay is pending: routed client commands must wait
        // for the replayed session (the replacement-aware route gates on this).
        // Relaunch owns its own auth and create barrier. A prior spontaneous
        // registration handoff must not reconnect on SessionCreated and erase
        // the in-flight create reply.
        resident.reset_registration_handoff_for_relaunch();
        // The old worker is gone for good: a run with a pending abort is declared
        // terminal HERE, before the create payload is built, so the journal record
        // rides this replay even when the dead connection's EOF is late.
        self.declare_compaction_terminal(resident, || resident.compaction.observe_worker_gone())
            .await;
        let deadline = self.connect_deadline();
        // The relaunch REPLACES an established, already-durable
        // descriptor: its spawn record keeps the synced persist (the
        // fresh create is the only launch class that rides the unsynced
        // TS `persistWorker` shape).
        let child = self
            .spawn_worker_process(resident, deadline, TempSync::Synced)
            .await?;
        if let Err(error) = self.connect_worker(resident, deadline).await {
            // Never leave a spawned-but-unwired worker process behind.
            let mut child = child;
            let _ = child.kill().await;
            return Err(error);
        }
        let (payload, injected_compaction_abort) = {
            let descriptor = resident.descriptor.lock().await;
            let mut payload = create_command_payload(&descriptor.create_command);
            // A parked or unproven shutdown must become visible without
            // executing its recovered queue. The create-time flag is applied
            // before the worker's runner can wake.
            if crate::descriptor::has_shutdown_hold(&descriptor) {
                payload["restoreQueueSuspended"] = json!(true);
            }
            // The pending terminal record rides the create replay: the replacement
            // discloses the aborted run in the rebuilt transcript, and the record is
            // consumed by the reply.
            let pending = {
                let mut journal = self
                    .compaction_journal
                    .lock()
                    .expect("compaction journal lock");
                match journal.pending(&descriptor.root_active_session_id) {
                    Ok(pending) => pending.cloned(),
                    Err(error) => {
                        self.log_line(&format!(
                            "terminal compaction journal retry failed for {}: {error:#}",
                            descriptor.root_active_session_id
                        ));
                        None
                    }
                }
            };
            if let Some(record) = pending {
                // `declaredAt` is the disclosure row's identity: the replacement stamps it
                // into the persisted entry, so a replay of the same declaration is idempotent.
                payload["interruptedCompaction"] = serde_json::json!({
                    "reason": record.reason,
                    "sessionFile": record.session_file,
                    "declaredAt": record.declared_at,
                });
                (payload, Some(descriptor.root_active_session_id.clone()))
            } else {
                (payload, None)
            }
        };
        let response = match self
            .route_command_typed(
                resident,
                "create",
                payload,
                WORKER_REQUEST_TIMEOUT_MS,
                RouteAdmission::SupervisorInternal,
            )
            .await
        {
            Ok(response) => response,
            // The replay never answered: the freshly spawned worker is not supervised by the
            // monitor path, so it must die with the relaunch attempt instead of orphaning.
            Err(error) => {
                let mut child = child;
                let _ = child.kill().await;
                return Err(error);
            }
        };
        if self.is_stopping(resident) {
            // A shutdown raced the relaunch: stop the freshly spawned worker
            // instead of leaving it running with nobody supervising it.
            let _ = self
                .route_command_typed(
                    resident,
                    "shutdown",
                    json!({}),
                    ROUTE_TIMEOUT_MS,
                    RouteAdmission::SupervisorInternal,
                )
                .await;
            let mut child = child;
            let _ = child.kill().await;
            return Err(anyhow!("supervisor is shutting down"));
        }
        if !response.success {
            // Same rule as the route error above: a worker whose create replay failed must
            // not be left running; a typed rejection relays verbatim like the launch path.
            let mut child = child;
            let _ = child.kill().await;
            return Err(match response.error_info {
                Some(error_info) => {
                    let message = response.error.clone().unwrap_or_default();
                    let headline = message.lines().next().unwrap_or_default();
                    self.log_line(&format!("relaunch create refused — {headline}"));
                    TypedCreateRejection {
                        message,
                        error_info,
                    }
                    .into()
                }
                None => anyhow!(
                    "worker create failed on relaunch: {}",
                    response.error.unwrap_or_default()
                ),
            });
        }
        // The create replay consumed the terminal record only when the disclosure it
        // carried is durable; a replay whose persist failed keeps the record pending.
        if let Some(root_active_session_id) = injected_compaction_abort {
            let persisted = response
                .data
                .as_ref()
                .and_then(|data| data.get("interruptedCompactionPersisted"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            if persisted {
                if let Err(error) = self
                    .compaction_journal
                    .lock()
                    .expect("compaction journal lock")
                    .consume(&root_active_session_id)
                {
                    self.log_line(&format!(
                        "terminal compaction journal consume failed for {root_active_session_id}: {error:#}"
                    ));
                }
            } else {
                self.log_line(&format!(
                    "terminal compaction disclosure did not persist for {root_active_session_id}; the record stays pending for the next replacement"
                ));
            }
        }
        let mut descriptor = resident.descriptor.lock().await;
        descriptor.lifecycle = DaemonWorkerLifecycle::Ready;
        // The persisted failure count stays: the give-up cap and any
        // adoption decision read the real history, not a relaunch-blanked one.
        let _ = persist_worker(&resident.descriptor_path, &descriptor);
        drop(descriptor);
        // The replayed create restored the session: routed client commands
        // may run against this worker again.
        resident.note_session_ready();
        // The replacement is identity-complete and its replay answered: record the binding
        // now — the boot registration carries no session id, so this retargets every
        // stale client id.
        {
            let descriptor = resident.descriptor.lock().await;
            self.record_session_binding(
                &resident.worker_id,
                descriptor.root_session_id.as_deref(),
                descriptor.session_file.as_deref(),
            );
        }
        Ok(child)
    }

    pub(super) async fn spawn_worker_process(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
        connect_deadline: tokio::time::Instant,
        spawn_record_sync: TempSync,
    ) -> Result<Child> {
        // One env definition for spawn and for the update roster's `launch_env` row
        // (spec §8: "env snapshot to respawn the worker identically").
        let instance_id = uuid::Uuid::new_v4().to_string();
        let (worker_socket, cwd, launch_env) = {
            let descriptor = resident.descriptor.lock().await;
            (
                PathBuf::from(&descriptor.socket_path),
                descriptor
                    .create_command
                    .rest
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or("/")
                    .to_string(),
                crate::descriptor::worker_launch_env(
                    &self.options.agent_dir,
                    &self.options.socket_path.to_string_lossy(),
                    &instance_id,
                    &descriptor,
                ),
            )
        };

        let executable = std::env::current_exe().context("resolve pa-daemon executable")?;
        let stderr_log_path =
            crate::worker_stderr::log_path(&self.options.agent_dir, &resident.worker_id);
        let stderr_log = crate::worker_stderr::open_for_spawn(&stderr_log_path)?;
        let mut command = Command::new(&executable);
        command
            .arg("worker")
            .envs(launch_env)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            // The worker's stderr lands in its per-worker log (a detached supervisor has no
            // inherited stderr): the launch failure errors below tail this file.
            .stderr(std::process::Stdio::from(stderr_log));
        if std::path::Path::new(&cwd).is_dir() {
            command.current_dir(&cwd);
        }
        // Detached and window-hidden, the TS worker spawn (`spawnHidden`, `{ detached: true }`):
        // the worker leaves the supervisor's console group and shows no fresh console.
        pa_core::platform::process::set_new_process_group(command.as_std_mut());
        let child = command
            .spawn()
            .with_context(|| format!("spawn session worker {}", resident.worker_id))?;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as u64);
        resident.spawned_at_ms.store(now_ms, Ordering::SeqCst);
        if std::env::var("PA_DAEMON_DEBUG").is_ok() {
            eprintln!("[supervisor] spawned worker pid {:?}", child.id());
        }
        let spawn_record = {
            let mut descriptor = resident.descriptor.lock().await;
            // Capture the child's start identity alongside its pid (TS `getProcessStartId`
            // at spawn): the holder checks need it to recognize a recycled pid.
            let child_pid = child.id().unwrap_or(0);
            descriptor.pid = u64::from(child_pid);
            // Registration can wait behind the relaunch guard. The launch
            // identity must already name the child whose lifetime we watch.
            descriptor.worker_instance_id = Some(instance_id);
            descriptor.process_start_id = crate::protocol::process_start_id(child_pid);
            descriptor.lifecycle = DaemonWorkerLifecycle::Starting;
            // The spawn record's durability is per launch class
            // (`spawn_record_sync`): a fresh create rides the TS
            // `persistWorker` shape — the atomic rename without the
            // pre-rename fsync (TS's `writeFileAtomicSync` fsync is
            // opt-in and the descriptor family never requests it) — and
            // the create-completion persist (`launch_worker`'s
            // post-create write) re-establishes the durable write as the
            // metadata-survival barrier. A relaunch REPLACES an
            // established, already-durable descriptor: it keeps the
            // synced persist, because a torn unsynced replacement would
            // lose the descriptor's whole payload — the recovery journal
            // pointer and the durable create command the next boot's
            // revival replays.
            persist_worker_at(&resident.descriptor_path, &descriptor, spawn_record_sync)
        };
        if let Err(error) = spawn_record {
            let mut child = child;
            let _ = child.kill().await;
            return Err(error).context("persist spawned worker identity");
        }

        // A worker that never comes up inside the connect budget is killed here, so a
        // stuck child never outlives its failed launch.
        if let Err(error) =
            probe_worker_socket(&resident.worker_id, &worker_socket, connect_deadline).await
        {
            let mut child = child;
            let _ = child.kill().await;
            return Err(crate::worker_stderr::not_ready_with_tail(
                error,
                &stderr_log_path,
            ));
        }
        Ok(child)
    }

    /// Connect to the worker socket, authenticate, and wire the request pump.
    /// The auth handshake must complete inside the remaining connect budget.
    pub(super) async fn connect_worker(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
        connect_deadline: tokio::time::Instant,
    ) -> Result<()> {
        self.connect_worker_with_auth_floor(resident, connect_deadline, true)
            .await
    }

    pub(super) async fn connect_worker_for_stop(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
        connect_deadline: tokio::time::Instant,
    ) -> Result<()> {
        self.connect_worker_with_auth_floor(resident, connect_deadline, false)
            .await
    }

    async fn connect_worker_with_auth_floor(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
        connect_deadline: tokio::time::Instant,
        auth_floor: bool,
    ) -> Result<()> {
        let (socket_path, token) = {
            let descriptor = resident.descriptor.lock().await;
            (
                PathBuf::from(&descriptor.socket_path),
                descriptor.authentication_token.clone(),
            )
        };
        let stream = if auth_floor {
            connect_transport(&socket_path).await
        } else {
            tokio::time::timeout_at(connect_deadline, connect_transport(&socket_path))
                .await
                .map_err(|_| anyhow!("Session worker timed out"))?
        }
        .with_context(|| format!("connect worker socket {}", socket_path.display()))?;
        let (reader, mut writer) = stream.split();
        // Bounded at the in-flight capacity (the admission seam in `route_command` refuses
        // or waits before enqueueing): no unbounded channel on the request path.
        let (cmd_tx, mut cmd_rx) =
            mpsc::channel::<WorkerRequest>(crate::backpressure::WORKER_INFLIGHT_CAPACITY);
        resident.pending.lock().await.clear();
        let events = self.events.clone();
        // The connection epoch ties both pumps to this connection: only they
        // may retire it, and a superseded connection ending late cannot.
        let connection_epoch = resident.note_connection_live();

        // Writer pump: holds only a weak resident reference — a strong one would keep
        // `cmd_tx` alive and park this pump forever after the resident is dropped.
        let writer_resident = Arc::downgrade(resident);
        let writer_pump = tokio::spawn(async move {
            while let Some(request) = cmd_rx.recv().await {
                let header = json!({
                    "kind": "command",
                    "requestId": request.request_id,
                    "commandType": request.command_type,
                });
                let written = write_frame(
                    &mut writer,
                    &header,
                    &serde_json::to_vec(&request.payload).unwrap_or_default(),
                    DEFAULT_PRIVATE_FRAME_LIMITS,
                )
                .await;
                if std::env::var("PA_DAEMON_DEBUG").is_ok() {
                    eprintln!(
                        "[supervisor] wrote worker frame {}: {:?}",
                        request.command_type,
                        written
                            .as_ref()
                            .map(|()| "ok")
                            .map_err(std::string::ToString::to_string)
                    );
                }
                if written.is_err() {
                    // The frame never fully reached the worker (a dead or mid-replacement
                    // socket): resolve it with the not-connected failure so a route may
                    // safely retry it.
                    if let Some(resident) = writer_resident.upgrade() {
                        fail_unsent_request(&resident, &request.request_id).await;
                    }
                    break;
                }
            }
            // Requests still queued when the pump ends were never written:
            // provably unsent, so they carry the same retryable failure.
            cmd_rx.close();
            if let Some(resident) = writer_resident.upgrade() {
                while let Ok(request) = cmd_rx.try_recv() {
                    fail_unsent_request(&resident, &request.request_id).await;
                }
                resident.note_connection_lost(connection_epoch);
            }
        });
        // Reader: route responses to pending requests, forward session events.
        let reader_pump = {
            let reader_resident = Arc::clone(resident);
            let reader_supervisor = Arc::clone(self);
            tokio::spawn(async move {
                let mut reader = PrivateFrameReader::new(reader, DEFAULT_PRIVATE_FRAME_LIMITS);
                while let Ok(Some(frame)) = reader.read_frame().await {
                    if std::env::var("PA_DAEMON_DEBUG").is_ok() {
                        eprintln!(
                            "[supervisor] worker frame: {:?}",
                            frame.header.get("outboundType")
                        );
                    }
                    let outbound_type = frame
                        .header
                        .get("outboundType")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let request_id = frame
                        .header
                        .get("requestId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if outbound_type == "response" {
                        // The response rides as bytes: the route splices the client's command
                        // id in front of the worker's own line; the bookkeeping scalars travel
                        // in the frame's routing header.
                        if let Some(reply) =
                            reader_resident.pending.lock().await.remove(&request_id)
                        {
                            let relay = WorkerRelay {
                                success: frame.header.get("ok").and_then(Value::as_bool),
                                active_session_id: frame
                                    .header
                                    .get("activeSessionId")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                                payload: frame.payload,
                            };
                            let _ = reply.send(WorkerReply::Relayed(relay));
                        }
                        continue;
                    }
                    let Ok(payload) = serde_json::from_slice::<Value>(&frame.payload) else {
                        continue;
                    };
                    if outbound_type == "session_event" {
                        let active_session_id = payload
                            .get("activeSessionId")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        // The abort supervision rides the forwarded events: `compaction_start`
                        // arms the token, a settled `compaction_end` clears it; only live
                        // frames drive it.
                        if let Some(event) = payload
                            .get("event")
                            .filter(|_| reader_resident.connection_is_current(connection_epoch))
                        {
                            match event.get("type").and_then(Value::as_str) {
                                Some("compaction_start") => {
                                    let carried_abort = reader_resident.compaction.arm(
                                        active_session_id.as_deref().unwrap_or_default(),
                                        event
                                            .get("reason")
                                            .and_then(Value::as_str)
                                            .unwrap_or_default(),
                                    );
                                    // A pending fallback abort rode this start frame
                                    // onto the run it reveals: the carried epoch needs
                                    // its own watcher (the old epoch never matches again).
                                    if let Some(epoch) = carried_abort {
                                        let supervisor = Arc::clone(&reader_supervisor);
                                        let resident = Arc::clone(&reader_resident);
                                        tokio::spawn(async move {
                                            supervisor
                                                .watch_unresolved_compaction_abort(resident, epoch)
                                                .await;
                                        });
                                    }
                                }
                                Some("compaction_end") => {
                                    let clear_error = {
                                        let mut journal = reader_supervisor
                                            .compaction_journal
                                            .lock()
                                            .expect("compaction journal lock");
                                        reader_resident.compaction.observe_end();
                                        active_session_id.as_deref().and_then(|active_session_id| {
                                            // A failed clear keeps the record pending
                                            // (write-before-forget, so memory and disk agree);
                                            // retried by the next forwarded end.
                                            journal.clear(active_session_id).err()
                                        })
                                    };
                                    if let Some(error) = clear_error {
                                        reader_supervisor.log_line(&format!(
                                            "terminal compaction journal clear failed for {active_session_id:?}: {error:#}"
                                        ));
                                    }
                                }
                                _ => {}
                            }
                        }
                        // The send-time delivery pass (TS `handleWorkerFrame` parity):
                        // attached connections get the frame; an event without an active
                        // session id is dropped, not broadcast.
                        if let Some(active_session_id) = active_session_id {
                            reader_supervisor.publish_session_event(
                                &active_session_id,
                                &std::sync::Arc::new(payload),
                            );
                        }
                    } else if outbound_type == "side_question_event" {
                        let active_session_id = payload
                            .get("activeSessionId")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        if let Some(active_session_id) = active_session_id {
                            reader_supervisor.publish_session_event(
                                &active_session_id,
                                &std::sync::Arc::new(payload),
                            );
                        }
                    } else if outbound_type == "heartbeats_changed" {
                        // The worker's own catalog changed: its last-good snapshot can no longer be
                        // trusted as fresh (Rust bumps the generation, so an in-flight read can
                        // never publish over this invalidation), and every client re-reads.
                        reader_resident
                            .heartbeat_snapshot_generation
                            .fetch_add(1, Ordering::Relaxed);
                        let _ =
                            events.send((ClientRouting::Broadcast, std::sync::Arc::new(payload)));
                    } else if outbound_type == "model_catalog_changed" {
                        // A worker's background catalog refresh changed the served snapshot:
                        // every client re-fetches (the pickers fold the fresh catalog
                        // without flicker).
                        let _ =
                            events.send((ClientRouting::Broadcast, std::sync::Arc::new(payload)));
                    }
                }
                // The connection is gone: no reply can arrive on it any
                // more (TS `notifyClosed` -> `rejectAll`); each waiting
                // route fails with the dropped-request error. A stale
                // reader drops nothing - the newer connection's handshake
                // inserts only after its epoch bump.
                {
                    let mut pending = reader_resident.pending.lock().await;
                    if reader_resident.connection_is_current(connection_epoch) {
                        pending.clear();
                    }
                }
                reader_resident.note_connection_lost(connection_epoch);
                // The connection ended (EOF or frame error): a run without an abort request
                // dies with the worker; an abort-requested run is declared terminal
                // immediately — the record must be durable before the relaunch replays.
                if reader_resident.connection_is_current(connection_epoch) {
                    reader_supervisor
                        .declare_compaction_terminal(&reader_resident, || {
                            reader_resident.compaction.observe_worker_gone()
                        })
                        .await;
                }
            })
        };
        let mut pumps = PreAuthPumps {
            writer: writer_pump,
            reader: reader_pump,
            resident: Arc::clone(resident),
            epoch: connection_epoch,
            installed: false,
        };
        // The handshake owns the channel privately (TS `pendingClient`): any non-`worker_auth`
        // route winning the enqueue race would strand the handshake for the whole connect
        // budget. A pre-auth route finds no installed channel; the install is epoch-guarded.
        let auth_tx = cmd_tx.clone();

        // Authenticate within the remaining connect budget (TS `handshakeBudgetMs`: probes,
        // connect, and auth share one deadline). A worker whose probes ate the whole budget
        // still proved it is alive, so the handshake always gets at least the auth floor.
        let remaining_ms = connect_deadline
            .saturating_duration_since(tokio::time::Instant::now())
            .as_millis() as u64;
        let auth_budget_ms = if auth_floor {
            remaining_ms.max(WORKER_AUTH_FLOOR_MS)
        } else {
            if remaining_ms == 0 {
                return Err(anyhow!("Session worker timed out"));
            }
            remaining_ms
        };
        let response = self
            .route_command_on_typed(
                resident,
                auth_tx,
                "worker_auth",
                json!({
                    "token": token,
                    "supervisorGeneration": format!("sup:{}", std::process::id()),
                    "supervisorPid": std::process::id(),
                    "supervisorProcessStartId": crate::protocol::process_start_id(std::process::id()),
                    "supervisorSocketPath": self.options.socket_path.to_string_lossy(),
                    "workerInstanceId": None::<String>,
                }),
                auth_budget_ms,
                RouteAdmission::SupervisorInternal,
            )
            .await
            .map_err(|error| {
                // A handshake that never finishes is a launch failure, not a
                // route timeout: report it with the worker's stderr tail.
                let message = match error.to_string().as_str() {
                    "Session worker timed out" => {
                        format!("session worker {} did not come up in time", resident.worker_id)
                    }
                    WORKER_SOCKET_CLOSED => format!(
                        "session worker {} exited before its handshake finished",
                        resident.worker_id
                    ),
                    _ => return error,
                };
                crate::worker_stderr::not_ready_with_tail(
                    anyhow!(message),
                    &crate::worker_stderr::log_path(&self.options.agent_dir, &resident.worker_id),
                )
            })?;
        if !response.success {
            return Err(anyhow!(
                "worker authentication failed: {}",
                response.error.unwrap_or_default()
            ));
        }
        // The handshake answered: install the channel for routing (TS
        // `worker.client = client`). A superseded connect never installs over it.
        resident
            .install_command_channel(connection_epoch, cmd_tx)
            .await;
        // Peer-transport capability rides on the worker instance id (the TS
        // worker only advertises `direct_peer_transport` with one).
        let peer_transport_capable = response
            .data
            .as_ref()
            .and_then(|data| data.get("capabilities"))
            .and_then(Value::as_array)
            .is_some_and(|capabilities| {
                capabilities
                    .iter()
                    .any(|capability| capability == "direct_peer_transport")
            });
        resident
            .peer_transport_capable
            .store(peer_transport_capable, Ordering::SeqCst);
        pumps.installed = true;
        Ok(())
    }
}
