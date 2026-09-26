//! Worker supervision: the watch loop, the restart backoff, and
//! the spawn/connect plumbing.
use super::*;

const MAX_CONSECUTIVE_FAILURES: u32 = 5;
/// A crash-path child that lived at least this long proved health: its death
/// resets the failure count (a fresh count) instead of accumulating toward
/// the give-up cap. Below it, a spawn-dies-fast child counts as another
/// consecutive failure - the restart storm's counter could never grow.
pub(super) const STABLE_LIFETIME_MS: u64 = 30_000;
const BASE_BACKOFF_MS: u64 = 250;
const MAX_BACKOFF_MS: u64 = 30_000;

impl Supervisor {
    /// Watch a worker process: on unexpected exit, restart with backoff.
    /// The crash path's failure-count update: a child that lived past the
    /// stable window was healthy, so its death starts a fresh count; a
    /// spawn-dies-fast child (or an adopted pid with no spawn time of our
    /// own) accumulates toward the give-up cap - the storm's counter could
    /// never grow while relaunch-spawns kept resetting it.
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
        tokio::spawn(async move {
            supervisor.watch_worker(resident, child, pid).await;
        });
    }

    async fn watch_worker(
        self: Arc<Self>,
        resident: Arc<ResidentWorker>,
        mut child: Option<Child>,
        mut adopted_pid: u64,
    ) {
        loop {
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
                // Adopted worker: poll liveness (cannot wait on a foreign
                // pid). A previous relaunch that produced no worker leaves
                // pid 0 here - there is nothing to watch, and polling pid 0
                // would report a phantom exit; fall straight to the
                // failure/backoff/relaunch arm instead.
                loop {
                    if self.shutting_down.load(Ordering::SeqCst)
                        || resident.intentional_stop.load(Ordering::SeqCst)
                    {
                        return;
                    }
                    if !matches!(is_process_alive(adopted_pid as u32), Ok(true)) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                if resident.intentional_stop.load(Ordering::SeqCst)
                    || self.shutting_down.load(Ordering::SeqCst)
                {
                    return;
                }
            }
            self.note_daemon_event("worker_exited", Some("crash"));
            // A hard-killed parent bypasses every worker-side close (#246's
            // teardowns never ran): the supervisor closes its resident RLM
            // children here, before the restart, so a relaunched parent
            // never resumes beside an orphaned child worker (TS children
            // die with the in-process parent).
            self.close_children_of_dead_parent(&resident).await;
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_millis() as u64);
            let failures = Self::next_failure_count(&resident, now_ms);
            if failures > MAX_CONSECUTIVE_FAILURES {
                let mut descriptor = resident.descriptor.lock().await;
                descriptor.lifecycle = DaemonWorkerLifecycle::Failed;
                descriptor.last_failure_at = Some(util::now_iso());
                let journal_path = descriptor.recovery_journal_path.clone();
                let _ = persist_worker(&resident.descriptor_path, &descriptor);
                drop(descriptor);
                // The give-up settles its own revival evidence (the storm
                // cycle's breaker): the journal's busy records are what a
                // later boot reads as "interrupted live work" — the
                // verdict that gave up must outlive them, or every boot
                // re-storms this same slot (the 12:00 → 17:07 recurrence).
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
                self.registry.forget(&resident.worker_id).await;
                // The give-up settles the dead worker's rows exactly like
                // a stop (every owned non-ephemeral, non-queued row
                // passivates and keeps its model/thinking/cwd). No ledger
                // reseed, no transcript read.
                let ephemeral = resident.descriptor.lock().await.owner_client_id.is_some();
                self.passivate_roster_worker(&resident.worker_id, ephemeral)
                    .await;
                // The exhausted-failure state must release the session
                // hold: a process this daemon spawned under the id that
                // outlived the failure loop keeps the session's runtime
                // lease and refuses every create for the file (the
                // zombie-holder incident). The belt reaps the id's
                // same-socket leftovers identity-gated; the last crashed
                // child is provably gone, and a dead holder's lease
                // self-heals on the next acquire.
                crate::boot_reap::reap_abandoned_workers(&self, &resident.worker_id).await;
                self.log_line(&format!(
                    "session worker {} failed after {failures} consecutive failures",
                    resident.worker_id
                ));
                return;
            }
            let backoff_ms = (BASE_BACKOFF_MS << (failures - 1).min(7)).min(MAX_BACKOFF_MS);
            self.log_line(&format!(
                "session worker {} exited unexpectedly; restarting in {backoff_ms}ms (failure {failures}/{MAX_CONSECUTIVE_FAILURES})",
                resident.worker_id
            ));
            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            match self.relaunch_worker(&resident).await {
                Ok(new_child) => {
                    // No counter reset on a successful relaunch: a spawn
                    // that dies fast must accumulate toward the give-up cap
                    // (the reset now comes only from a stable lifetime on
                    // the crash path).
                    self.note_daemon_event("worker_restarted", None);
                    child = Some(new_child);
                }
                Err(error) => {
                    self.log_line(&format!(
                        "worker {} relaunch failed: {error:#}",
                        resident.worker_id
                    ));
                    child = None;
                    adopted_pid = 0;
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
        // The replacement's create replay is pending: routed client
        // commands must wait for the replayed session (the replacement-
        // aware route gates on this until the replay answers).
        resident.note_session_replaying();
        // The old worker is gone for good: a run with a pending abort is
        // declared terminal HERE, before the create payload is built, so
        // the journal record deterministically rides this replay even when
        // the dead connection's EOF is late (a stale reader declares
        // nothing).
        self.declare_compaction_terminal(resident, || resident.compaction.observe_worker_gone())
            .await;
        let deadline = worker_connect_deadline();
        let child = self.spawn_worker_process(resident, deadline).await?;
        if let Err(error) = self.connect_worker(resident, deadline).await {
            // Never leave a spawned-but-unwired worker process behind.
            let mut child = child;
            let _ = child.kill().await;
            return Err(error);
        }
        let (payload, injected_compaction_abort) = {
            let descriptor = resident.descriptor.lock().await;
            let mut payload = create_command_payload(&descriptor.create_command);
            // The abort supervision's pending terminal record rides the
            // create replay: the replacement worker discloses the aborted
            // run in the rebuilt transcript (the parity shape of its own
            // auto-abort rows), and the record is consumed by the reply.
            // A declaration whose durable write failed is retried here —
            // the replay is the point the record is needed — and a
            // still-failing write only logs: the replay proceeds without
            // the disclosure and the record stays retryable for a later
            // replacement.
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
                // `declaredAt` is the disclosure row's identity: the
                // replacement stamps its persisted entry with it, so a
                // replay of the same declaration is idempotent even when
                // the previous replacement died between persisting the
                // row and the create reply that consumes the record.
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
            .route_command(resident, "create", payload, LONG_ROUTE_TIMEOUT_MS)
            .await
        {
            Ok(response) => response,
            // The replay never answered: the freshly spawned worker is not
            // supervised by the monitor path that produced it, so it must
            // die with the relaunch attempt instead of orphaning (and
            // holding its socket path against the next one).
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
                .route_command(resident, "shutdown", json!({}), ROUTE_TIMEOUT_MS)
                .await;
            let mut child = child;
            let _ = child.kill().await;
            return Err(anyhow!("supervisor is shutting down"));
        }
        if !response.success {
            // Same rule as the route error above: a worker whose create
            // replay failed must not be left running. A typed rejection
            // relays verbatim and logs the conflict like the launch path.
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
        // The create replay consumed the terminal record when the
        // disclosure it carried is durable (persisted by this replay, or
        // already held by the rebuilt transcript): it never replays again
        // (a later relaunch would duplicate the disclosure row). A replay
        // whose persist failed keeps the record pending — the next
        // replacement retries it, the same recovery the journal's
        // retryable declarations use. A missing flag on the reply is
        // treated as not-persisted: the record survives a worker that
        // did not answer the question.
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
        // The replacement is identity-complete and its session replay
        // answered: record the binding now. The replacement's boot
        // registration carries no session id (it races the create), so its
        // record supersedes nothing - this is the record that retargets
        // every stale client id at the replacement, delivered exactly
        // when the replacement can actually serve them.
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
    ) -> Result<Child> {
        // One env definition for spawn and for the update roster's
        // `launch_env` row (spec §8: "env snapshot to respawn the worker
        // identically").
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
                    &uuid::Uuid::new_v4().to_string(),
                    &descriptor,
                ),
            )
        };

        let executable = std::env::current_exe().context("resolve pa-daemon executable")?;
        let mut command = Command::new(&executable);
        command
            .arg("worker")
            .envs(launch_env)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit());
        if std::path::Path::new(&cwd).is_dir() {
            command.current_dir(&cwd);
        }
        // Detached and window-hidden, the TS worker spawn
        // (`spawnHidden(..., { detached: true })`): the worker leaves the
        // supervisor's console group and shows no fresh console.
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
        {
            let mut descriptor = resident.descriptor.lock().await;
            // Capture the child's start identity alongside its pid (TS
            // `getProcessStartId(childPid)` at spawn): the identity-aware
            // holder checks can only recognize a recycled pid when the
            // descriptor carries the start id the original holder had.
            let child_pid = child.id().unwrap_or(0);
            descriptor.pid = child_pid as u64;
            descriptor.process_start_id = crate::protocol::process_start_id(child_pid);
            descriptor.lifecycle = DaemonWorkerLifecycle::Starting;
            let _ = persist_worker(&resident.descriptor_path, &descriptor);
        }

        // Probe the worker socket until it accepts connections. A worker that
        // never comes up inside the connect budget is killed here so a stuck
        // child never outlives its failed launch (TS `connectWorker` throws
        // `DaemonWorkerProbeTimeoutError` and the launch failure path stops
        // the worker).
        if let Err(error) =
            probe_worker_socket(&resident.worker_id, &worker_socket, connect_deadline).await
        {
            let mut child = child;
            let _ = child.kill().await;
            return Err(error);
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
        let (socket_path, token) = {
            let descriptor = resident.descriptor.lock().await;
            (
                PathBuf::from(&descriptor.socket_path),
                descriptor.authentication_token.clone(),
            )
        };
        let stream = connect_transport(&socket_path)
            .await
            .with_context(|| format!("connect worker socket {}", socket_path.display()))?;
        let (reader, mut writer) = stream.split();
        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<WorkerRequest>();
        resident.pending.lock().await.clear();
        let events = self.events.clone();
        // The connection epoch ties both pumps to this connection: only they
        // may retire it, and a superseded connection ending late cannot.
        let connection_epoch = resident.note_connection_live();

        // Writer pump: send command frames. It holds only a weak resident
        // reference: a strong one would keep `cmd_tx` (inside the resident)
        // alive and park this pump forever, leaking the worker socket after
        // the resident is dropped (the pump exits via `recv() == None` when
        // the last sender drops).
        let writer_resident = Arc::downgrade(resident);
        tokio::spawn(async move {
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
                    // The frame never fully reached the worker (a dead or
                    // mid-replacement socket): resolve the request with the
                    // unambiguous not-connected failure so a
                    // replacement-aware route may safely retry it.
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
        {
            let reader_resident = Arc::clone(resident);
            let events = events.clone();
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
                    let Ok(payload) = serde_json::from_slice::<Value>(&frame.payload) else {
                        continue;
                    };
                    if outbound_type == "response" {
                        if let Some(reply) =
                            reader_resident.pending.lock().await.remove(&request_id)
                        {
                            let response: DaemonResponse = serde_json::from_value(payload)
                                .unwrap_or_else(|_| {
                                    response_failure(
                                        Some(&request_id),
                                        "parse",
                                        "invalid worker response",
                                        None,
                                    )
                                });
                            let _ = reply.send(response);
                        }
                    } else if outbound_type == "session_event" {
                        let active_session_id = payload
                            .get("activeSessionId")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        // The abort supervision rides the forwarded events:
                        // `compaction_start` arms the supervisor-visible
                        // token, a settled `compaction_end` clears it (and
                        // any pending terminal record — the worker landed
                        // the outcome itself, so a replacement must never
                        // replay it).
                        // Only the live connection's frames may drive the
                        // token: a superseded connection still draining
                        // must not arm over — or settle — the replacement
                        // connection's run. The journal lock spans the
                        // token settle and the record clear, pairing with
                        // `declare_compaction_terminal`'s take-then-write
                        // under the same lock.
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
                                    // A pending fallback abort rode this
                                    // start frame onto the run it
                                    // reveals (the fallback armed before
                                    // the delayed frame landed): the
                                    // carried epoch needs its own watcher,
                                    // the fallback's old epoch never
                                    // matches again.
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
                                            // A failed clear keeps the record
                                            // pending (write-before-forget, so
                                            // memory and disk agree) — surfaced
                                            // here so the settled run's stale
                                            // record is visible, and retried by
                                            // the next forwarded end.
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
                        let routing = active_session_id.map_or(
                            ClientRouting::Broadcast,
                            |active_session_id| ClientRouting::AttachedSession {
                                active_session_id,
                            },
                        );
                        let _ = events.send((routing, payload));
                    } else if outbound_type == "side_question_event" {
                        let active_session_id = payload
                            .get("activeSessionId")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        let routing = active_session_id.map_or(
                            ClientRouting::Broadcast,
                            |active_session_id| ClientRouting::AttachedSession {
                                active_session_id,
                            },
                        );
                        let _ = events.send((routing, payload));
                    } else if outbound_type == "heartbeats_changed" {
                        // The worker's own catalog changed: its last-good
                        // snapshot can no longer be trusted as fresh (TS
                        // `heartbeatSnapshotStale = true` + a queued re-read
                        // for an in-flight pass; Rust bumps the generation,
                        // so an in-flight read keeps an older generation
                        // and can never publish itself as fresh over this
                        // invalidation), and every client re-reads the
                        // catalog (TS `broadcastHeartbeatsChanged`
                        // re-broadcast).
                        reader_resident
                            .heartbeat_snapshot_generation
                            .fetch_add(1, Ordering::Relaxed);
                        let _ = events.send((ClientRouting::Broadcast, payload));
                    }
                }
                reader_resident.note_connection_lost(connection_epoch);
                // The connection ended (EOF or frame error): a run without
                // an abort request dies with the worker and rides the
                // normal recovery flow; an abort-requested run is declared
                // terminal immediately — the worker can never land its own
                // end now, and the record must be durable before the
                // relaunch replays the create. A stale reader (a newer
                // connection already installed its own epoch) touches
                // nothing.
                if reader_resident.connection_is_current(connection_epoch) {
                    reader_supervisor
                        .declare_compaction_terminal(&reader_resident, || {
                            reader_resident.compaction.observe_worker_gone()
                        })
                        .await;
                }
            });
        }
        *resident.cmd_tx.lock().await = Some(cmd_tx);

        // Authenticate against the worker within the remaining connect
        // budget (TS `handshakeBudgetMs`: probes, connect, and auth share one
        // deadline).
        // A worker whose probes ate the whole connect budget still proved
        // it is alive (the socket answered), so the handshake always gets
        // at least the auth floor — the floor, never the budget's crumbs,
        // and a fully-spent budget included. The launch's failure mode
        // stays the connect-budget error instead of a misleading route
        // timeout on a worker that just came up.
        let auth_budget_ms = connect_deadline
            .saturating_duration_since(tokio::time::Instant::now())
            .as_millis()
            .max(WORKER_AUTH_FLOOR_MS.into()) as u64;
        let response = self
            .route_command(
                resident,
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
            )
            .await
            .map_err(|error| {
                // The handshake route's timeout is the connect budget
                // running out, not a session command timing out: report the
                // launch-budget failure so a loaded-box launch failure says
                // what actually happened (never the generic route timeout
                // text, which pointed triage at the wrong seam).
                if error.to_string() == "Session worker timed out" {
                    anyhow!("session worker {} did not come up in time", resident.worker_id)
                } else {
                    error
                }
            })?;
        if !response.success {
            return Err(anyhow!(
                "worker authentication failed: {}",
                response.error.unwrap_or_default()
            ));
        }
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
        Ok(())
    }
}
