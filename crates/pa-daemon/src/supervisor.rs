//! Supervisor runtime: one process spawning one worker per active session.
//!
//! Port of `modes/daemon/daemon-supervisor.ts`: the supervisor hosts no sessions
//! itself. Clients connect over a JSONL Unix socket; the supervisor spawns a
//! dedicated worker process per session, supervises it (restart with
//! exponential backoff, bounded attempts), persists worker descriptors so a
//! restarted supervisor can adopt or relaunch live sessions, and routes
//! commands and events between clients and workers (private-framed channel).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures::future::join_all;
use pa_types::daemon::{
    DaemonCommand, DaemonErrorInfo, DaemonOutbound, DaemonWorkerDescriptor, DaemonWorkerLifecycle,
    DurableDaemonCreateCommand, SnapshotPurpose, UpdateId, UpdatePreparedMarker,
    UpdateTimeoutBudget,
};
use pa_types::platform::transport::{bind_transport, connect_transport, TransportStream};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::descriptor::{
    create_command_payload, load_descriptors, persist_supervisor_config, persist_worker,
    PersistedSupervisorConfig, SUPERVISOR_CONFIG_FILE_NAME,
};
use crate::engine::EngineModelSelection;
use crate::framing::{write_frame, PrivateFrameReader, DEFAULT_PRIVATE_FRAME_LIMITS};
use crate::lease::is_process_alive;
use crate::paths;
use crate::prompt_admission::input_admission_id;
use crate::protocol::{
    command_active_session_id, command_type_name, current_protocol_info,
    default_server_capabilities, parse_supervisor_command_line, response_failure, response_line,
    response_success, DaemonResponse, DaemonRuntimeIdentity, EnvelopeParseError,
    DAEMON_APP_VERSION, DAEMON_SCHEMA_ID, DAEMON_SCHEMA_REVISION,
};
use crate::registry::{ResidentWorker, SessionRegistry, WorkerRegistration, WorkerRequest};
use crate::session_store::{find_most_recent_session_for_cwd, list_sessions};
use crate::snapshot_stream::{attach_client_capabilities, stream_attach, wants_chunked};
use crate::update_prepare::{
    marker_expires_at_iso, update_gate_refuses, write_prepared_artifacts, AbortOutcome,
    BeginOutcome, MutationDrainLatch, PrepareCoordinator, PrepareOp, UPDATE_PREPARING_MESSAGE,
};
use crate::update_roster::{
    build_update_roster, supervisor_identity, UpdateRosterInputs, WorkerSnapshot,
};
use crate::update_stop::{stop_workers_gracefully, WorkerStopVerdict, WORKER_REQUEST_TIMEOUT_MS};
use crate::{socket, util};

/// Worker connect budget: socket probes, connect, and the auth handshake
/// all share this deadline from spawn time (TS `WORKER_CONNECT_TIMEOUT_MS`:
/// 30s on Unix, 90s on Windows). A worker that never comes up fails the
/// launch within this budget instead of hanging.
#[cfg(unix)]
const WORKER_CONNECT_TIMEOUT_MS: u64 = 30_000;
#[cfg(not(unix))]
const WORKER_CONNECT_TIMEOUT_MS: u64 = 90_000;
/// One socket probe attempt (TS `WORKER_CONNECT_PROBE_MS`).
#[cfg(unix)]
const WORKER_CONNECT_PROBE_MS: u64 = 500;
#[cfg(not(unix))]
const WORKER_CONNECT_PROBE_MS: u64 = 2_000;
/// Pause between probe attempts (TS backoff min = max on Unix).
#[cfg(unix)]
const WORKER_CONNECT_BACKOFF_MS: u64 = 25;
#[cfg(not(unix))]
const WORKER_CONNECT_BACKOFF_MS: u64 = 2_000;
pub(crate) const ROUTE_TIMEOUT_MS: u64 = 30_000;
pub(crate) const LONG_ROUTE_TIMEOUT_MS: u64 = 600_000;
const MAX_CONSECUTIVE_FAILURES: u32 = 5;
/// A crash-path child that lived at least this long proved health: its death
/// resets the failure count (a fresh count) instead of accumulating toward
/// the give-up cap. Below it, a spawn-dies-fast child counts as another
/// consecutive failure - the restart storm's counter could never grow.
const STABLE_LIFETIME_MS: u64 = 30_000;
const BASE_BACKOFF_MS: u64 = 250;
const MAX_BACKOFF_MS: u64 = 30_000;

#[derive(Debug, Clone)]
pub struct SupervisorOptions {
    pub socket_path: PathBuf,
    pub agent_dir: PathBuf,
}

/// Which clients a worker outbound frame reaches.
#[derive(Debug, Clone)]
pub(crate) enum ClientRouting {
    /// Every connected client (e.g. `daemon_closing`).
    Broadcast,
    /// Clients attached to the session.
    AttachedSession { active_session_id: String },
    /// Clients holding a roster subscription (`roster_subscribe`).
    RosterSubscribers,
}

pub struct Supervisor {
    pub(crate) options: SupervisorOptions,
    descriptor_dir: PathBuf,
    /// Daemon-lifecycle telemetry (`daemon event` schema v1), resolved at
    /// run start (None = opted out); never blocks supervision paths.
    telemetry: std::sync::Mutex<Option<pa_telemetry::TelemetryClient>>,
    pub(crate) registry: SessionRegistry,
    /// Worker outbound frames, with their client routing.
    pub(crate) events: broadcast::Sender<(ClientRouting, Value)>,
    /// The supervisor's agent roster (classified entries; the roster arms
    /// live in `supervisor_roster.rs`).
    pub(crate) roster: std::sync::Mutex<crate::agent_roster::AgentRoster>,
    /// In-flight saved-session renames (TS `pendingSessionNames`): one
    /// reservation per `[depth, parent, name]` scope, so a concurrent
    /// rename of the same name fails the second caller.
    pub(crate) pending_session_names: std::sync::Mutex<std::collections::HashSet<String>>,
    shutting_down: AtomicBool,
    /// Wakes the accept loop when [`Supervisor::begin_shutdown`] sets the
    /// flag: a listening socket blocks in `accept` until a client connects,
    /// so the shutdown must interrupt it for the process to exit.
    shutdown_notify: tokio::sync::Notify,
    log: paths::RotatingLog,
    /// Memoized ledger over the default sessions dir (ledgers are per
    /// sessions-dir families; another dir gets a fresh instance).
    rlm_ledger: tokio::sync::Mutex<Option<std::sync::Arc<crate::rlm_ledger::RlmSpawnLedger>>>,
    /// The update-prepare transaction (spec
    /// `docs/update-flow-state-machine.md` §5): at most one per supervisor;
    /// empty = `Serving`.
    update_prepare: PrepareCoordinator,
    /// In-flight mutating-command counter feeding the prepare transaction's
    /// `Draining` wait (TS `MutationDrainLatch`).
    mutation_drain: MutationDrainLatch,
    /// Timeout budget of the update flow (`PRIME_AGENT_UPDATE_*_MS`
    /// overridable for CI).
    update_budget: UpdateTimeoutBudget,
    /// The boot-time restore pass (spec §6, slice 5): sweep + roster
    /// restore + scheduled-work re-arm. Read by the hello resume contract,
    /// the `update_restore_status` RPC, and the queued-attach path.
    pub(crate) restore: crate::update_restore::RestoreProgress,
    /// The session input-pause leases (wave b8): pause id -> lease, the
    /// bookkeeping behind `acquire`/`release_session_input_pause`.
    pub(crate) input_pauses: crate::input_pause_lease::SupervisorPauseTable,
}

impl Supervisor {
    pub fn new(options: SupervisorOptions) -> Result<Self> {
        let descriptor_dir =
            crate::descriptor::descriptor_dir(&options.agent_dir, &options.socket_path);
        paths::ensure_dir(&descriptor_dir)?;
        persist_supervisor_config(
            &descriptor_dir.join(SUPERVISOR_CONFIG_FILE_NAME),
            &PersistedSupervisorConfig {
                version: 1,
                socket_path: options.socket_path.to_string_lossy().to_string(),
                default_session_dir: Some(
                    paths::sessions_dir(&options.agent_dir)?
                        .to_string_lossy()
                        .to_string(),
                ),
            },
        )?;
        let (events, _) = broadcast::channel(4096);
        let log = paths::RotatingLog::new(paths::daemon_log_path(
            &options.socket_path,
            &options.agent_dir,
        ));
        Ok(Supervisor {
            options,
            descriptor_dir,
            telemetry: std::sync::Mutex::new(None),
            registry: SessionRegistry::new(),
            events,
            roster: std::sync::Mutex::new(crate::agent_roster::AgentRoster::new()),
            pending_session_names: std::sync::Mutex::new(std::collections::HashSet::new()),
            shutting_down: AtomicBool::new(false),
            shutdown_notify: tokio::sync::Notify::new(),
            log,
            rlm_ledger: tokio::sync::Mutex::new(None),
            update_prepare: PrepareCoordinator::new(),
            mutation_drain: MutationDrainLatch::new(),
            update_budget: UpdateTimeoutBudget::from_env(),
            restore: crate::update_restore::RestoreProgress::new(),
            input_pauses: crate::input_pause_lease::SupervisorPauseTable::default(),
        })
    }

    /// Emit the `daemon event` adoption signal for a session-archive sweep
    /// (best-effort, non-blocking; no-op when the daemon is opted out).
    pub(crate) fn note_sessions_archived(&self, count: usize) {
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_sessions_archived(client, count);
        }
    }

    /// Emit the parent-death child close's `daemon event` (schema v1,
    /// kind `worker_children_closed`): a count only, never session
    /// payload. Zero closes never emit (no children died with the
    /// worker).
    pub(crate) fn note_children_closed(&self, count: usize) {
        if count == 0 {
            return;
        }
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_worker_children_closed(client, count);
        }
    }

    /// Emit a `daemon event` (best-effort, non-blocking; no-op when the
    /// daemon is opted out).
    fn note_daemon_event(&self, kind: &str, exit_reason: Option<&str>) {
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_daemon_event(client, kind, exit_reason);
        }
    }

    /// Bind the client socket, adopt or relaunch persisted workers, serve.
    pub async fn run(self: Arc<Self>) -> Result<()> {
        // Daemon telemetry: same env/settings posture as the sessions
        // (the supervisor is the `daemon` execution mode).
        {
            let settings = pa_core::settings::SettingsManager::create(
                std::env::current_dir().unwrap_or_default(),
                &self.options.agent_dir,
            );
            let disabled = match pa_telemetry::env_telemetry_override() {
                Some(enabled) => !enabled,
                None => !settings.get_telemetry_enabled(),
            };
            *self.telemetry.lock().unwrap() = (!disabled).then(|| {
                pa_core::session_engine::telemetry::build_client(&settings, &self.options.agent_dir)
            });
        }
        socket::prepare_socket_path(&self.options.socket_path).await?;
        let listener = bind_transport(&self.options.socket_path)
            .await
            .with_context(|| {
                format!(
                    "bind supervisor socket {}",
                    self.options.socket_path.display()
                )
            })?;
        socket::restrict_socket_path(&self.options.socket_path);
        self.log
            .append(&format!("supervisor started pid {}", std::process::id()));

        // Update boot (spec §6): consume the roster from the spawn env
        // BEFORE the sweep deletes the file it points at, sweep this
        // socket's update scratch dir unconditionally (invariant I2 by
        // construction), then run the restore + re-arm pass concurrently
        // with serving — the accept loop must keep serving hellos so
        // reconnecting clients see the resume contract (§10.3).
        let roster = crate::update_restore::consume_roster_env();
        self.restore
            .begin(roster.as_ref().map(|roster| roster.update_id.clone()));
        crate::update_restore::boot_sweep(&self.options.agent_dir, &self.options.socket_path);
        // Descriptor adoption runs concurrently with the accept loop: a
        // supervisor restarted over live sessions must accept their
        // self-registrations immediately, not behind the whole descriptor
        // scan. The restore pass awaits this task (spec §6 step 2's
        // create-or-adopt order: kept workers relaunch from their
        // descriptors first, the roster covers the rest).
        let adoption = {
            let supervisor = Arc::clone(&self);
            tokio::spawn(async move {
                supervisor.adopt_persisted_workers().await;
            })
        };
        {
            let supervisor = Arc::clone(&self);
            tokio::spawn(async move {
                crate::update_restore::restore_pass(&supervisor, adoption, roster).await;
            });
        }

        // Session-archive sweep (roadmap: the sessions directory must not
        // grow forever): boot sweep, then the periodic re-sweep at the TS
        // idle-eviction cadence. Housekeeping only — it never gates serving.
        {
            let supervisor = Arc::clone(&self);
            tokio::spawn(async move {
                crate::session_archive::archive_sweep_loop(&supervisor).await;
            });
        }

        // Update-prepare watchdog: aborts deadline- or self-expiry-breached
        // prepare transactions even when no command arrives to re-check.
        {
            let supervisor = Arc::clone(&self);
            tokio::spawn(async move {
                supervisor.update_prepare_watchdog().await;
            });
        }

        while !self.shutting_down.load(Ordering::SeqCst) {
            let stream = tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        if self.shutting_down.load(Ordering::SeqCst) {
                            continue;
                        }
                        return Err(anyhow!("supervisor accept: {error}"));
                    }
                },
                // begin_shutdown fired: loop back and fall out of the loop.
                _ = self.shutdown_notify.notified() => continue,
            };
            let supervisor = Arc::clone(&self);
            tokio::spawn(async move {
                if let Err(error) = supervisor.handle_client(stream).await {
                    eprintln!("pa-daemon client connection error: {error:#}");
                }
            });
        }
        socket::cleanup_socket_path(
            &self.options.socket_path,
            socket::socket_identity(&self.options.socket_path),
        );
        Ok(())
    }

    pub(crate) fn log_line(&self, message: &str) {
        self.log.append(&format!("[{}] {message}", util::now_iso()));
    }

    /// The spawn ledger for one sessions dir (TS `rlmSpawnLedgerFor`): the
    /// default dir's ledger is memoized; any other dir constructs a fresh
    /// instance (its seeding no-ops when its ledger file exists).
    pub(crate) async fn rlm_spawn_ledger_for(
        self: &Arc<Self>,
        session_dir: Option<&str>,
    ) -> Result<std::sync::Arc<crate::rlm_ledger::RlmSpawnLedger>> {
        let default_dir = paths::sessions_dir(&self.options.agent_dir)?;
        let requested = match session_dir {
            Some(dir) => paths::expand_tilde(dir)?,
            None => default_dir.clone(),
        };
        if requested != default_dir {
            let log = paths::RotatingLog::new(paths::daemon_log_path(
                &self.options.socket_path,
                &self.options.agent_dir,
            ));
            return Ok(std::sync::Arc::new(crate::rlm_ledger::RlmSpawnLedger::new(
                &self.options.agent_dir,
                &requested,
                move |message| {
                    log.append(&format!("[{}] {message}", util::now_iso()));
                },
            )));
        }
        let mut cached = self.rlm_ledger.lock().await;
        if let Some(ledger) = cached.as_ref() {
            return Ok(std::sync::Arc::clone(ledger));
        }
        let log = paths::RotatingLog::new(paths::daemon_log_path(
            &self.options.socket_path,
            &self.options.agent_dir,
        ));
        let ledger = std::sync::Arc::new(crate::rlm_ledger::RlmSpawnLedger::new(
            &self.options.agent_dir,
            &requested,
            move |message| {
                log.append(&format!("[{}] {message}", util::now_iso()));
            },
        ));
        *cached = Some(std::sync::Arc::clone(&ledger));
        Ok(ledger)
    }

    /// Adopt or relaunch persisted workers, concurrently: one dead worker's
    /// relaunch (create replay) must not delay adopting live sessions.
    async fn adopt_persisted_workers(self: &Arc<Self>) {
        let descriptors = load_descriptors(&self.descriptor_dir, &self.options.socket_path);
        let mut tasks = Vec::new();
        for (path, descriptor) in descriptors {
            let supervisor = Arc::clone(self);
            tasks.push(tokio::spawn(async move {
                supervisor.adopt_persisted_worker(path, descriptor).await;
            }));
        }
        for task in tasks {
            let _ = task.await;
        }
    }

    /// Adopt one persisted worker descriptor. Serialized against worker
    /// self-registration by the per-worker adoption gate: whichever path
    /// arrives first (descriptor scan or live re-registration) builds the
    /// roster entry; the other one finds it present.
    async fn adopt_persisted_worker(
        self: &Arc<Self>,
        path: PathBuf,
        descriptor: crate::descriptor::WorkerDescriptor,
    ) {
        let worker_id = descriptor.worker_id.clone();
        let guard = self.registry.adoption_guard(&worker_id).await;
        if self.registry.get(&worker_id).await.is_some() {
            // The worker re-registered before the descriptor scan reached it.
            self.log_line(&format!(
                "session worker {worker_id} already registered; skipping descriptor adoption"
            ));
            return;
        }
        let socket_path = PathBuf::from(&descriptor.socket_path);
        let alive = socket::can_connect(&socket_path, Duration::from_millis(500)).await;
        let pid = descriptor.pid;
        let resident = ResidentWorker::new(worker_id.clone(), descriptor, path);
        let result = if alive {
            self.connect_worker(&resident, worker_connect_deadline())
                .await
        } else {
            // Dead worker: relaunch from the durable create command. The
            // worker rehydrates the session store, restoring history and
            // the persisted queue snapshot.
            self.relaunch_worker(&resident).await.map(|_| ())
        };
        match result {
            Ok(()) => {
                self.registry.insert(Arc::clone(&resident)).await;
                self.spawn_monitor(Arc::clone(&resident), None, pid);
                // The adopted worker joins the roster from its live state.
                self.refresh_roster_entry(&resident).await;
                self.log_line(&format!(
                    "adopted session worker {worker_id} (was alive: {alive})"
                ));
            }
            Err(error) => {
                self.log_line(&format!("could not adopt worker {worker_id}: {error:#}"));
            }
        }
        drop(guard);
    }

    /// Watch a worker process: on unexpected exit, restart with backoff.
    /// The crash path's failure-count update: a child that lived past the
    /// stable window was healthy, so its death starts a fresh count; a
    /// spawn-dies-fast child (or an adopted pid with no spawn time of our
    /// own) accumulates toward the give-up cap - the storm's counter could
    /// never grow while relaunch-spawns kept resetting it.
    fn next_failure_count(resident: &ResidentWorker, now_ms: u64) -> u32 {
        let spawned_at = resident.spawned_at_ms.load(Ordering::SeqCst);
        let stable = spawned_at > 0 && now_ms.saturating_sub(spawned_at) >= STABLE_LIFETIME_MS;
        if stable {
            resident.consecutive_failures.store(1, Ordering::SeqCst);
            1
        } else {
            resident.consecutive_failures.fetch_add(1, Ordering::SeqCst) + 1
        }
    }

    fn spawn_monitor(
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
                .map(|elapsed| elapsed.as_millis() as u64)
                .unwrap_or(0);
            let failures = Self::next_failure_count(&resident, now_ms);
            if failures > MAX_CONSECUTIVE_FAILURES {
                let mut descriptor = resident.descriptor.lock().await;
                descriptor.lifecycle = DaemonWorkerLifecycle::Failed;
                descriptor.last_failure_at = Some(util::now_iso());
                let _ = persist_worker(&resident.descriptor_path, &descriptor);
                drop(descriptor);
                self.registry.remove(&resident.worker_id).await;
                self.registry.forget(&resident.worker_id).await;
                self.remove_roster_worker(&resident.worker_id);
                self.log_line(&format!(
                    "session worker {} failed after {failures} consecutive failures",
                    resident.worker_id
                ));
                // The dead worker's transcript stays a passive family row
                // while any resident root anchors it (the seed walk).
                self.seed_roster_ledger().await;
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
        let deadline = worker_connect_deadline();
        let child = self.spawn_worker_process(resident, deadline).await?;
        if let Err(error) = self.connect_worker(resident, deadline).await {
            // Never leave a spawned-but-unwired worker process behind.
            let mut child = child;
            let _ = child.start_kill();
            return Err(error);
        }
        let payload = {
            let descriptor = resident.descriptor.lock().await;
            create_command_payload(&descriptor.create_command)
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
                let _ = child.start_kill();
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
            let _ = child.start_kill();
            return Err(anyhow!("supervisor is shutting down"));
        }
        if !response.success {
            // Same rule as the route error above: a worker whose create
            // replay failed must not be left running.
            let mut child = child;
            let _ = child.start_kill();
            return Err(anyhow!(
                "worker create failed on relaunch: {}",
                response.error.unwrap_or_default()
            ));
        }
        let mut descriptor = resident.descriptor.lock().await;
        descriptor.lifecycle = DaemonWorkerLifecycle::Ready;
        // The persisted failure count stays: the give-up cap and any
        // adoption decision read the real history, not a relaunch-blanked one.
        let _ = persist_worker(&resident.descriptor_path, &descriptor);
        Ok(child)
    }

    async fn spawn_worker_process(
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
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0);
        resident.spawned_at_ms.store(now_ms, Ordering::SeqCst);
        if std::env::var("PA_DAEMON_DEBUG").is_ok() {
            eprintln!("[supervisor] spawned worker pid {:?}", child.id());
        }
        {
            let mut descriptor = resident.descriptor.lock().await;
            descriptor.pid = child.id().unwrap_or(0) as u64;
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
            let _ = child.start_kill();
            return Err(error);
        }
        Ok(child)
    }

    /// Connect to the worker socket, authenticate, and wire the request pump.
    /// The auth handshake must complete inside the remaining connect budget.
    async fn connect_worker(
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

        // Writer pump: send command frames.
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
                        written.as_ref().map(|_| "ok").map_err(|e| e.to_string())
                    );
                }
                if written.is_err() {
                    break;
                }
            }
        });
        // Reader: route responses to pending requests, forward session events.
        {
            let reader_resident = Arc::clone(resident);
            let events = events.clone();
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
                        let routing = active_session_id
                            .map(|active_session_id| ClientRouting::AttachedSession {
                                active_session_id,
                            })
                            .unwrap_or(ClientRouting::Broadcast);
                        let _ = events.send((routing, payload));
                    } else if outbound_type == "session_status" {
                        let active_session_id = payload
                            .get("activeSessionId")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        let routing = active_session_id
                            .map(|active_session_id| ClientRouting::AttachedSession {
                                active_session_id,
                            })
                            .unwrap_or(ClientRouting::Broadcast);
                        let _ = events.send((routing, payload));
                    } else if outbound_type == "side_question_event" {
                        let active_session_id = payload
                            .get("activeSessionId")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        let routing = active_session_id
                            .map(|active_session_id| ClientRouting::AttachedSession {
                                active_session_id,
                            })
                            .unwrap_or(ClientRouting::Broadcast);
                        let _ = events.send((routing, payload));
                    } else if outbound_type == "heartbeats_changed" {
                        // A worker's heartbeat catalog changed (TS
                        // `broadcastHeartbeatsChanged` re-broadcast): every
                        // client re-reads the catalog.
                        let _ = events.send((ClientRouting::Broadcast, payload));
                    }
                }
            });
        }
        *resident.cmd_tx.lock().await = Some(cmd_tx);

        // Authenticate against the worker within the remaining connect
        // budget (TS `handshakeBudgetMs`: probes, connect, and auth share one
        // deadline).
        let auth_budget_ms = connect_deadline
            .saturating_duration_since(tokio::time::Instant::now())
            .as_millis() as u64;
        if auth_budget_ms == 0 {
            return Err(anyhow!(
                "session worker {} did not come up in time",
                resident.worker_id
            ));
        }
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
            .await?;
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
            .map(|capabilities| {
                capabilities
                    .iter()
                    .any(|capability| capability == "direct_peer_transport")
            })
            .unwrap_or(false);
        resident
            .peer_transport_capable
            .store(peer_transport_capable, Ordering::SeqCst);
        Ok(())
    }

    pub(crate) async fn route_command(
        &self,
        resident: &Arc<ResidentWorker>,
        command_type: &str,
        payload: Value,
        timeout_ms: u64,
    ) -> Result<DaemonResponse> {
        let cmd_tx = {
            let guard = resident.cmd_tx.lock().await;
            guard
                .clone()
                .ok_or_else(|| anyhow!("Session worker is not connected"))?
        };
        let (reply_tx, reply_rx) = oneshot::channel();
        let request_id = uuid::Uuid::new_v4().to_string();
        resident
            .pending
            .lock()
            .await
            .insert(request_id.clone(), reply_tx);
        cmd_tx
            .send(WorkerRequest {
                request_id,
                command_type: command_type.to_string(),
                payload,
            })
            .map_err(|_| anyhow!("Session worker is not connected"))?;
        match tokio::time::timeout(Duration::from_millis(timeout_ms), reply_rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err(anyhow!("Session worker dropped the request")),
            Err(_) => Err(anyhow!("Session worker timed out")),
        }
    }

    /// Launch a brand-new worker for a create command.
    pub(crate) async fn launch_worker(
        self: &Arc<Self>,
        create: &DaemonCommand,
        owner_client_id: Option<String>,
    ) -> Result<Arc<ResidentWorker>> {
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
        let session_dir_path = match session_dir.as_deref() {
            Some(dir) => paths::expand_tilde(dir)?,
            None => paths::sessions_dir(&self.options.agent_dir)?,
        };
        if *continue_recent == Some(true) {
            let recent = find_most_recent_session_for_cwd(&session_dir_path, &cwd_value);
            if recent.is_none() {
                return Err(anyhow!("No recent session found for {}", cwd_value));
            }
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
            rest: Default::default(),
        };
        let descriptor_path = self.descriptor_dir.join(format!("{worker_id}.json"));
        let resident = ResidentWorker::new(worker_id.clone(), descriptor, descriptor_path.clone());
        // Register the resident before spawning the process: the worker
        // self-registers on boot, and the registration handler must find its
        // identity in the registry (registration races the create replay).
        self.registry.insert(Arc::clone(&resident)).await;
        let deadline = worker_connect_deadline();
        let child = self.spawn_worker_process(&resident, deadline).await?;
        if let Err(error) = self.connect_worker(&resident, deadline).await {
            // Never leave a spawned-but-unwired worker process behind.
            let mut child = child;
            let _ = child.start_kill();
            return Err(error);
        }
        let create_payload = {
            let descriptor = resident.descriptor.lock().await;
            create_command_payload(&descriptor.create_command)
        };
        let response = self
            .route_command(&resident, "create", create_payload, LONG_ROUTE_TIMEOUT_MS)
            .await?;
        if !response.success {
            let _ = std::fs::remove_file(&descriptor_path);
            return Err(anyhow!(
                "session worker create failed: {}",
                response.error.unwrap_or_default()
            ));
        }
        {
            let mut descriptor = resident.descriptor.lock().await;
            descriptor.lifecycle = DaemonWorkerLifecycle::Ready;
            if let Some(summary) = &response.data {
                descriptor.root_session_id = summary
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(session_file) = summary
                    .get("sessionFile")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                {
                    descriptor.session_file = Some(session_file.clone());
                    // The durable create command must reopen the same session
                    // file on relaunch, or a respawned worker would create a
                    // fresh session and lose history.
                    descriptor.create_command.session_path = Some(session_file.clone());
                }
            }
            persist_worker(&descriptor_path, &descriptor)?;
        }
        let pid = child.id().unwrap_or(0);
        self.spawn_monitor(Arc::clone(&resident), Some(child), pid as u64);
        Ok(resident)
    }

    // ------------------------------------------------------------------
    // Client connections (JSONL transport)
    // ------------------------------------------------------------------

    async fn handle_client(self: Arc<Self>, stream: Box<dyn TransportStream>) -> Result<()> {
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
            supervisor_pid: Some(std::process::id() as u64),
            supervisor_owner_token: Some(uuid::Uuid::new_v4().to_string()),
            supervisor_process_start_id: crate::protocol::process_start_id(std::process::id()),
            supervisor_socket_path: Some(self.options.socket_path.to_string_lossy().to_string()),
            update_resume: Some(self.restore.hello_resume()),
            client_id: client_id.clone(),
            server_capabilities: default_server_capabilities(),
            rest: Default::default(),
        };
        write_line(&mut writer, &serde_json::to_value(&hello)?).await?;

        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        let mut events = self.events.subscribe();
        // Connection state shared with the per-command dispatch tasks: the
        // envelope-overridden client id and the attached-session list (the
        // event arm reads the latter to route session events).
        let attached: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
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
        // daemon's async command handlers.
        let (dispatch_tx, mut dispatch_rx) =
            tokio::sync::mpsc::unbounded_channel::<(Vec<Value>, bool)>();
        loop {
            line.clear();
            tokio::select! {
                read = reader.read_line(&mut line) => {
                    let Ok(read) = read else { break };
                    if read == 0 {
                        break;
                    }
                    let trimmed = line.trim().to_string();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let supervisor = Arc::clone(&self);
                    let effective_client_id = Arc::clone(&effective_client_id);
                    let attached = Arc::clone(&attached);
                    let roster_subscribed = Arc::clone(&roster_subscribed);
                    let connection = Arc::clone(&connection);
                    let dispatch_tx = dispatch_tx.clone();
                    tokio::spawn(async move {
                        let (lines, stop) = supervisor
                            .dispatch_client(
                                &trimmed,
                                &effective_client_id,
                                &attached,
                                &roster_subscribed,
                                &connection,
                            )
                            .await;
                        let _ = dispatch_tx.send((lines, stop));
                    });
                }
                dispatched = dispatch_rx.recv() => {
                    let Some((lines, stop)) = dispatched else { break };
                    for outbound in lines {
                        write_line(&mut writer, &outbound).await?;
                    }
                    if stop {
                        break;
                    }
                }
                event = events.recv() => {
                    match event {
                        Ok((routing, payload)) => {
                            let deliver = match &routing {
                                ClientRouting::Broadcast => true,
                                ClientRouting::AttachedSession { active_session_id } => {
                                    attached.lock().unwrap().iter().any(|id| id == active_session_id)
                                }
                                ClientRouting::RosterSubscribers => {
                                    roster_subscribed.load(std::sync::atomic::Ordering::SeqCst)
                                }
                            };
                            if deliver {
                                write_line(&mut writer, &payload).await?;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
        // Detach from every attached session on disconnect (a TUI exit does
        // not stop the session; the worker keeps running).
        let attached_sessions = attached.lock().unwrap().clone();
        for active_session_id in attached_sessions.iter() {
            if let Ok(resident) = self.registry.resolve(active_session_id).await {
                let payload = json!({ "type": "detach", "clientId": effective_client_id.lock().unwrap().clone() });
                let _ = self
                    .route_command(&resident, "detach", payload, ROUTE_TIMEOUT_MS)
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
    async fn dispatch_client(
        self: &Arc<Self>,
        line: &str,
        effective_client_id: &Arc<std::sync::Mutex<String>>,
        attached: &Arc<std::sync::Mutex<Vec<String>>>,
        roster_subscribed: &Arc<std::sync::atomic::AtomicBool>,
        connection: &Arc<crate::input_pause_lease::ClientConnectionState>,
    ) -> (Vec<Value>, bool) {
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
                    vec![response_line(&response_failure(
                        id.as_deref(),
                        type_name,
                        &error.to_string(),
                        None,
                    ))],
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
                    vec![response_line(&response_failure(
                        Some(&command_id),
                        "parse",
                        &error,
                        None,
                    ))],
                    false,
                );
            }
        }
        let type_name = command_type_name(&envelope.command).to_string();
        // Update-prepare watchdog on any later command (spec §5): a prepared
        // transaction whose marker expired returns the supervisor to Serving
        // before the command is served.
        if let Some(abort) = self.update_prepare.abort_if_expired(util::now_ms()) {
            self.finish_update_abort(abort).await;
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
                        vec![response_line(&response_failure(
                            Some(&command_id),
                            &type_name,
                            UPDATE_PREPARING_MESSAGE,
                            None,
                        ))],
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
                command_id,
                type_name,
            )
            .await;
        if mutating {
            self.mutation_drain.end();
        }
        outcome
    }

    /// The parsed-command match of [`Self::dispatch_client`], executed under
    /// the mutation-drain latch by that wrapper.
    #[allow(clippy::too_many_arguments)]
    async fn execute_parsed_command(
        self: &Arc<Self>,
        command: &DaemonCommand,
        effective_client_id: &Arc<std::sync::Mutex<String>>,
        attached: &Arc<std::sync::Mutex<Vec<String>>>,
        roster_subscribed: &Arc<std::sync::atomic::AtomicBool>,
        connection: &Arc<crate::input_pause_lease::ClientConnectionState>,
        command_id: String,
        type_name: String,
    ) -> (Vec<Value>, bool) {
        match command {
            DaemonCommand::AckResult { .. } => (Vec::new(), false),
            DaemonCommand::Restart { .. } | DaemonCommand::Shutdown { .. } => {
                let response = response_success(Some(&command_id), &type_name, None);
                let mut lines = vec![response_line(&response)];
                // daemon_closing goes to every client before the exit.
                let closing = json!({ "type": "daemon_closing", "reason": "shutdown" });
                let _ = self
                    .events
                    .send((ClientRouting::Broadcast, closing.clone()));
                lines.push(closing);
                self.begin_shutdown().await;
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
                let lines = self.handle_saved_session_list(command, &command_id).await;
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
                ..
            } => {
                let response = self
                    .handle_worker_roster_delta(
                        &command_id,
                        &type_name,
                        worker_token,
                        summary.clone(),
                        removed.clone().unwrap_or_default(),
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
                    Err(error) => (
                        vec![response_line(&response_failure(
                            Some(&command_id),
                            &type_name,
                            &error.to_string(),
                            None,
                        ))],
                        false,
                    ),
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
                let attached_ids = attached.lock().unwrap().clone();
                let marked = self
                    .begin_detach_pause_bookkeeping(
                        connection,
                        active_session_id.as_deref(),
                        &attached_ids,
                    )
                    .await;
                let outcome = self
                    .route_client_command(
                        command,
                        &client_id,
                        attached,
                        command_id.clone(),
                        type_name.clone(),
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
                    .route_client_command(command, &client_id, attached, command_id, type_name)
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
                self.route_client_command(command, &client_id, attached, command_id, type_name)
                    .await
            }
        }
    }

    /// `prepare_update_restart`: accept or poll the prepare transaction.
    ///
    /// The RPC contract: a new `updateId` starts the transaction and waits
    /// for the mutation drain, then reports `fenced`; a repeat with the same
    /// id reports the current state (the poll never extends the budget); a
    /// different id is refused (the coordinator maps the refusal to `Join`).
    /// Any failure aborts the transaction - rollback is the default, the
    /// supervisor returns to `Serving`, and nothing is left half-prepared.
    async fn handle_prepare_update_restart(
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
                        self.finish_update_abort(abort).await;
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
                                    self.finish_update_abort(abort).await;
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
                anyhow::bail!(
                    "Cannot prepare update restart while resident worker {} is {state}",
                    resident.worker_id
                );
            }
        }
        let remaining = prepare_deadline_ms.saturating_sub(util::now_ms());
        let rpc_timeout = WORKER_REQUEST_TIMEOUT_MS.min(remaining).max(1);
        let snapshots = join_all(residents.iter().map(|resident| {
            let resident = Arc::clone(resident);
            async move {
                let response = self
                    .route_command(&resident, "update_snapshot", json!({}), rpc_timeout)
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
            snapshots,
        )?;
        let marker = UpdatePreparedMarker {
            update_id: update_id.clone(),
            expires_at: marker_expires_at_iso(now, &self.update_budget),
            supervisor: identity,
            rest: Default::default(),
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
    async fn handle_commit_update_restart(
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
                        self.finish_update_abort(abort).await;
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
                    .send((ClientRouting::Broadcast, closing.clone()));
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
        self.shutting_down.store(true, Ordering::SeqCst);
        self.shutdown_notify.notify_one();
    }

    /// Apply one abort outcome: delete the prepared artifacts if any, and
    /// log the return to `Serving` (clients are notified through the
    /// aborting RPC response; the per-phase banner event is the UX slice).
    async fn finish_update_abort(self: &Arc<Self>, abort: AbortOutcome) {
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

    /// Update-prepare watchdog (spec §5): the deadline and the marker
    /// self-expiry are re-checked on a timer, so a coordinator that dies
    /// mid-prepare can never wedge the supervisor - every state has a
    /// watchdog exit (invariant I1).
    async fn update_prepare_watchdog(self: Arc<Self>) {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if let Some(abort) = self.update_prepare.abort_if_expired(util::now_ms()) {
                self.finish_update_abort(abort).await;
            }
        }
    }

    /// `worker_register`: a session worker presenting its identity (boot
    /// registration or re-registration after this supervisor restarted).
    /// The token was issued when the supervisor spawned or adopted the
    /// worker, so an unknown worker id or a token mismatch is rejected.
    async fn handle_worker_register(
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
                Err(error) => return fail(&format!("{error:#}")),
            },
        };
        // Refresh the durable identity from the live worker (the token was
        // issued by this supervisor; a mismatch is a rogue registration).
        {
            let mut descriptor = resident.descriptor.lock().await;
            if token.as_str() != descriptor.authentication_token {
                return fail("Session worker authentication failed");
            }
            descriptor.pid = *pid;
            descriptor.socket_path = socket_path.clone();
            descriptor.worker_instance_id = worker_instance_id.clone();
            if let Some(session_id) = &registration.session_id {
                descriptor.root_session_id = Some(session_id.clone());
            }
            descriptor.lifecycle = DaemonWorkerLifecycle::Ready;
            let _ = persist_worker(&resident.descriptor_path, &descriptor);
        }
        let record = self.registry.record_registration(registration).await;
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
        let Ok(content) = std::fs::read_to_string(&descriptor_path) else {
            return Err(anyhow!(
                "Unknown session worker: {}",
                registration.active_session_id
            ));
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
        self.connect_worker(&resident, worker_connect_deadline())
            .await?;
        self.registry.insert(Arc::clone(&resident)).await;
        self.spawn_monitor(Arc::clone(&resident), None, registration.pid);
        self.refresh_roster_entry(&resident).await;
        self.log_line(&format!(
            "adopted session worker {worker_id} via self-registration"
        ));
        Ok(resident)
    }

    /// `list_saved_sessions` (port of `handleSavedSessionList`): stream
    /// `session_list_item`/`session_list_progress` events, then a final
    /// response with the full saved-session rows.
    async fn handle_saved_session_list(
        self: &Arc<Self>,
        command: &DaemonCommand,
        command_id: &str,
    ) -> Vec<Value> {
        let DaemonCommand::ListSavedSessions {
            cwd,
            session_dir,
            active_session_id,
            scope,
            ..
        } = command
        else {
            return Vec::new();
        };
        // Session-addressed form: use the live worker's cwd and session dir.
        let (cwd, session_dir) = match active_session_id {
            Some(active_session_id) => {
                let resident = self.registry.get(active_session_id).await;
                match resident {
                    Some(resident) => {
                        let descriptor = resident.descriptor.lock().await;
                        let cwd = descriptor
                            .create_command
                            .rest
                            .get("cwd")
                            .and_then(Value::as_str)
                            .unwrap_or("/")
                            .to_string();
                        let session_dir = descriptor
                            .create_command
                            .rest
                            .get("sessionDir")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        (cwd, session_dir)
                    }
                    None => {
                        return vec![response_line(&response_failure(
                            Some(command_id),
                            "list_saved_sessions",
                            &format!("Unknown active session: {active_session_id}"),
                            None,
                        ))];
                    }
                }
            }
            None => {
                let Some(cwd) = cwd else {
                    // The TS supervisor runs Node's path.resolve on the
                    // missing cwd; reproduce the observable error string.
                    return vec![response_line(&response_failure(
                        Some(command_id),
                        "list_saved_sessions",
                        "The \"paths[0]\" property must be of type string, got undefined",
                        None,
                    ))];
                };
                (cwd.clone(), session_dir.clone())
            }
        };
        let dir = match session_dir.as_deref() {
            Some(dir) => crate::paths::expand_tilde(dir),
            None => crate::paths::sessions_dir(&self.options.agent_dir),
        };
        let dir = match dir {
            Ok(dir) => dir,
            Err(error) => {
                return vec![response_line(&response_failure(
                    Some(command_id),
                    "list_saved_sessions",
                    &error.to_string(),
                    None,
                ))];
            }
        };
        let scope_current = scope.as_str() == Some("current");
        let mut infos = crate::session_store::list_sessions(&dir);
        if scope_current {
            infos.retain(|info| info.cwd == cwd);
        }
        // The saved catalog scan never visits session-artifacts, where RLM
        // children persist: merge the passive ledger walk so a passivated
        // descendant stays catalog-visible (TS
        // `withPassiveRlmDescendantInfos`; a broken ledger degrades to the
        // saved rows alone, it never fails the catalog).
        let mut roots: Vec<crate::rlm_roster::RosterWalkRoot> = infos
            .iter()
            .map(|info| crate::rlm_roster::RosterWalkRoot {
                session_file: info.path.clone(),
                active_session_id: None,
            })
            .collect();
        for resident in self.registry.list().await {
            let descriptor = resident.descriptor.lock().await;
            if let Some(session_file) = &descriptor.session_file {
                roots.push(crate::rlm_roster::RosterWalkRoot {
                    session_file: crate::lease::canonical_session_path(Path::new(session_file)),
                    active_session_id: Some(descriptor.root_active_session_id.clone()),
                });
            }
        }
        let ledger = match self.rlm_spawn_ledger_for(session_dir.as_deref()).await {
            Ok(ledger) => ledger,
            Err(error) => {
                return vec![response_line(&response_failure(
                    Some(command_id),
                    "list_saved_sessions",
                    &error.to_string(),
                    None,
                ))];
            }
        };
        let passive = match crate::rlm_roster::walk_passive_rlm_children(&ledger, &roots) {
            Ok(children) => children,
            Err(error) => {
                self.log_line(&format!(
                    "Could not merge passive RLM descendants: {error:#}"
                ));
                Vec::new()
            }
        };
        let mut merged = passive
            .iter()
            .map(crate::rlm_roster::passive_child_info)
            .filter(|info| !scope_current || info.cwd == cwd)
            .collect::<Vec<_>>();
        infos.append(&mut merged);
        let total = infos.len();
        let mut lines = Vec::new();
        for (index, info) in infos.iter().enumerate() {
            let row = saved_session_row(info);
            let mut item = json!({
                "id": command_id,
                "type": "session_list_item",
                "command": "list_saved_sessions",
                "session": row,
            });
            if let Some(active_session_id) = active_session_id {
                item["activeSessionId"] = json!(active_session_id);
            }
            lines.push(item);
            let mut progress = json!({
                "id": command_id,
                "type": "session_list_progress",
                "command": "list_saved_sessions",
                "loaded": index + 1,
                "total": total,
            });
            if let Some(active_session_id) = active_session_id {
                progress["activeSessionId"] = json!(active_session_id);
            }
            lines.push(progress);
        }
        let sessions: Vec<Value> = infos.iter().map(saved_session_row).collect();
        lines.push(response_line(&response_success(
            Some(command_id),
            "list_saved_sessions",
            Some(json!({ "sessions": sessions })),
        )));
        lines
    }

    async fn handle_list(
        self: &Arc<Self>,
        command_id: String,
        type_name: String,
        all: Option<bool>,
        cwd: Option<String>,
        session_dir: Option<String>,
    ) -> DaemonResponse {
        let dir = match session_dir.as_deref() {
            Some(dir) => paths::expand_tilde(dir),
            None => paths::sessions_dir(&self.options.agent_dir),
        };
        let dir = match dir {
            Ok(dir) => dir,
            Err(error) => {
                return response_failure(Some(&command_id), &type_name, &error.to_string(), None);
            }
        };
        let summaries: Vec<Value> = match all {
            Some(true) => {
                // TS `buildSessionList` order: saved rows (resident ones
                // replaced in place by their live summary), then passive
                // ledger children, then resident-only rows.
                let mut infos = list_sessions(&dir);
                if let Some(cwd) = cwd {
                    infos.retain(|info| info.cwd == cwd);
                }
                let residents = self.registry.list().await;
                let mut resident_by_file: Vec<ResidentRoot> = Vec::new();
                for resident in residents.iter() {
                    let descriptor = resident.descriptor.lock().await;
                    if let Some(session_file) = &descriptor.session_file {
                        resident_by_file.push(ResidentRoot {
                            session_file: crate::lease::canonical_session_path(Path::new(
                                session_file,
                            )),
                            resident: Arc::clone(resident),
                            // Resident roots carry their active session id
                            // so passive children of a resident parent
                            // report parentActiveSessionId.
                            active_session_id: Some(descriptor.root_active_session_id.clone()),
                        });
                    }
                }
                let mut summaries = Vec::new();
                let mut roots: Vec<crate::rlm_roster::RosterWalkRoot> = Vec::new();
                for info in &infos {
                    roots.push(crate::rlm_roster::RosterWalkRoot {
                        session_file: info.path.clone(),
                        active_session_id: None,
                    });
                    let canonical = crate::lease::canonical_session_path(&info.path);
                    let resident = resident_by_file
                        .iter()
                        .position(|root| root.session_file == canonical)
                        .map(|at| resident_by_file.swap_remove(at));
                    match resident {
                        Some(root) => {
                            roots.last_mut().expect("saved root").active_session_id =
                                root.active_session_id;
                            summaries.push(self.worker_summary(&root.resident).await);
                        }
                        None => summaries.push(saved_session_summary(info)),
                    }
                }
                let mut resident_only = Vec::new();
                for root in resident_by_file {
                    roots.push(crate::rlm_roster::RosterWalkRoot {
                        session_file: root.session_file,
                        active_session_id: root.active_session_id,
                    });
                    resident_only.push(self.worker_summary(&root.resident).await);
                }
                let ledger = match self.rlm_spawn_ledger_for(session_dir.as_deref()).await {
                    Ok(ledger) => ledger,
                    Err(error) => {
                        return response_failure(
                            Some(&command_id),
                            &type_name,
                            &error.to_string(),
                            None,
                        );
                    }
                };
                match crate::rlm_roster::walk_passive_rlm_children(&ledger, &roots) {
                    Ok(children) => {
                        for child in &children {
                            summaries.push(crate::rlm_roster::passive_child_summary(child));
                        }
                    }
                    Err(error) => {
                        let message = format!("Could not walk passive RLM children: {error:#}");
                        self.log_line(&message);
                        return response_failure(Some(&command_id), &type_name, &message, None);
                    }
                }
                // TS `buildSessionList` order: saved rows, passive children,
                // then resident-only rows.
                summaries.append(&mut resident_only);
                summaries
            }
            _ => {
                // Live residents of this supervisor.
                let mut summaries = Vec::new();
                for resident in self.registry.list().await {
                    summaries.push(self.worker_summary(&resident).await);
                }
                summaries
            }
        };
        response_success(
            Some(&command_id),
            &type_name,
            Some(json!({ "sessions": summaries })),
        )
    }

    /// Persist one subagent deletion (TS `recordRlmSubagentDeletion`): the
    /// ledger delete record is the topology tombstone, the display file gets
    /// a status tombstone for hydration. The child's transcript stays (a
    /// tombstoned-but-undeleted file is the accepted orphan of a failed
    /// teardown); the row disappears from rosters because live-edge reads
    /// drop tombstones.
    async fn tombstone_rlm_child(
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
                .map(str::to_string)
                .unwrap_or_else(|| {
                    Path::new(&session_file)
                        .parent()
                        .map(|dir| dir.to_string_lossy().to_string())
                        .unwrap_or_default()
                });
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
                .map(|entry| entry.session_file.clone())
                .unwrap_or_else(|| session_file.clone()),
            rlm_parent_node_id: display
                .as_ref()
                .and_then(|entry| entry.rlm_parent_node_id.clone()),
            prompt: display.as_ref().and_then(|entry| entry.prompt.clone()),
            spawn_code: display.as_ref().and_then(|entry| entry.spawn_code.clone()),
            model: display.as_ref().and_then(|entry| entry.model.clone()),
            status: "deleted".to_string(),
            created_at: display.as_ref().map(|entry| entry.created_at).unwrap_or(0),
        };
        if let Err(error) = crate::rlm_ledger::write_rlm_subagent_display(&tombstone) {
            self.log_line(&format!(
                "failed to reconcile display entry for tombstoned RLM subagent {child_id}: {error:#}"
            ));
        }
        Ok(())
    }

    /// One resident's live summary (`get_state`), with the recovering-row
    /// fallback for an unreachable worker.
    async fn worker_summary(self: &Arc<Self>, resident: &Arc<ResidentWorker>) -> Value {
        let response = self
            .route_command(resident, "get_state", json!({}), ROUTE_TIMEOUT_MS)
            .await;
        match response {
            Ok(response) if response.success => response
                .data
                .unwrap_or_else(|| offline_summary(&resident.worker_id)),
            _ => offline_summary(&resident.worker_id),
        }
    }

    pub(crate) async fn handle_create(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: String,
    ) -> Result<Value> {
        if let DaemonCommand::Create {
            name: Some(name), ..
        } = command
        {
            self.assert_session_name_available(name).await?;
        }
        let resident = self.launch_worker(command, Some(client_id)).await?;
        // Fresh get_state so the response matches attach/list rows exactly.
        let response = self
            .route_command(&resident, "get_state", json!({}), ROUTE_TIMEOUT_MS)
            .await?;
        let summary = response
            .data
            .unwrap_or_else(|| json!({ "id": resident.worker_id }));
        // Spawn admission is the moment the supervisor knows the child's
        // edge firsthand. The ledger is the only topology store, so the
        // append's outcome is load-bearing: admission fails if the spawn
        // record cannot be made durable (a swallowed failure would admit a
        // child that listing and hydration can never find after
        // passivation).
        if let Err(error) = self.record_rlm_child_admission(command, &summary).await {
            // Never leave an admitted-but-unrecorded child running: the
            // ledger is the only topology store.
            let _ = self.stop_worker(&resident).await;
            return Err(error);
        }
        // The new session joins the agent roster immediately (subscribers
        // see the roster_update before their next list).
        self.write_roster_summary(&summary, Some(&resident.worker_id));
        // The spawn append is a ledger-append moment: the new edge can be
        // the first time this family is live in the roster (a resumed
        // parent, a supervisor restart), so the seed runs here too - after
        // the fresh child's own row, so it only touches genuinely passive
        // descendants (TS `seedRosterLedger` skips present rows).
        self.seed_roster_ledger().await;
        Ok(summary)
    }

    /// Record one RLM child admission: the spawn edge in the daemon-owned
    /// ledger (durable topology) and the child's display file (hydration
    /// metadata). No-op for top-level sessions.
    async fn record_rlm_child_admission(
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
            .map(str::to_string)
            .unwrap_or_else(|| {
                Path::new(child)
                    .parent()
                    .map(|dir| dir.to_string_lossy().to_string())
                    .unwrap_or_default()
            });
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
                self.log_line(&format!("failed to append RLM ledger spawn: {error:#}"))
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
                ))
            })?;
        if !written {
            self.log_line(&format!(
                "skipped RLM subagent display entry for {}: deleted tombstone exists",
                display.child_id
            ));
        }
        Ok(())
    }

    async fn assert_session_name_available(self: &Arc<Self>, name: &str) -> Result<()> {
        if name.trim().is_empty() {
            return Err(anyhow!("Session name cannot be empty"));
        }
        for resident in self.registry.list().await {
            let response = self
                .route_command(&resident, "get_state", json!({}), ROUTE_TIMEOUT_MS)
                .await;
            if let Ok(response) = response {
                if let Some(data) = &response.data {
                    let session_name = data
                        .get("sessionName")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if session_name == name {
                        return Err(anyhow!(
                            "Agent name \"{name}\" is unavailable: an agent of that name already exists at depth 0 under this parent"
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    pub(crate) async fn route_client_command(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: &str,
        attached: &Arc<std::sync::Mutex<Vec<String>>>,
        command_id: String,
        type_name: String,
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
        let resident = match self.registry.resolve(&selector).await {
            Ok(resident) => resident,
            Err(_) => {
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
        };
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
        let (worker_command, payload) = match client_command_payload(command, client_id) {
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
        let response = self
            .route_command(&resident, worker_command, payload, timeout)
            .await;
        match response {
            Ok(mut response) => {
                // Worker replies carry no client request id; clients match
                // responses by the id they sent, so stamp it back here.
                response.id = Some(command_id.clone());
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
                    if response.success {
                        if let Some(data) = response.data.as_mut() {
                            let active_id = data
                                .get("activeSessionId")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .unwrap_or_else(|| resident.worker_id.clone());
                            self.note_daemon_event(
                                if matches!(command, DaemonCommand::Reattach { .. }) {
                                    "reattach"
                                } else {
                                    "attach"
                                },
                                None,
                            );
                            let mut attached = attached.lock().unwrap();
                            if !attached.iter().any(|id| id == &active_id) {
                                attached.push(active_id.clone());
                            }
                            // The client's own capability set, not the
                            // supervisor's worker-facing one, is echoed in
                            // the attach result.
                            let client_capabilities = attach_client_capabilities(
                                capabilities.as_deref(),
                                *supports_extension_ui,
                            );
                            if let Some(client) = data.get_mut("client") {
                                client["capabilities"] = json!(client_capabilities.clone());
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
                        attached
                            .lock()
                            .unwrap()
                            .retain(|id| id != &resident.worker_id);
                    }
                }
                if let DaemonCommand::Kill { .. } = command {
                    if response.success {
                        self.stop_worker(&resident).await;
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
            Err(error) => (
                vec![response_line(&response_failure(
                    Some(&command_id),
                    &type_name,
                    &error.to_string(),
                    None,
                ))],
                false,
            ),
        }
    }

    pub(crate) async fn stop_worker(self: &Arc<Self>, resident: &Arc<ResidentWorker>) {
        resident.intentional_stop.store(true, Ordering::SeqCst);
        let _ = self
            .route_command(resident, "shutdown", json!({}), ROUTE_TIMEOUT_MS)
            .await;
        let _ = std::fs::remove_file(&resident.descriptor_path);
        self.registry.remove(&resident.worker_id).await;
        self.registry.forget(&resident.worker_id).await;
        self.remove_roster_worker(&resident.worker_id);
        // A plain stop carries no ledger tombstone: the child's passive
        // row must survive the stop for subscribers (TS keeps the
        // passivated row in the worker's roster push; the Rust
        // equivalent reseeds it from the ledger here). A tombstoned
        // child no longer has a live edge, so the seed skips it.
        self.seed_roster_ledger().await;
    }

    async fn begin_shutdown(self: &Arc<Self>) {
        self.shutting_down.store(true, Ordering::SeqCst);
        for resident in self.registry.list().await {
            resident.intentional_stop.store(true, Ordering::SeqCst);
            let _ = self
                .route_command(&resident, "shutdown", json!({}), ROUTE_TIMEOUT_MS)
                .await;
            let _ = std::fs::remove_file(&resident.descriptor_path);
        }
        self.registry.clear().await;
        // Wake the accept loop only after the workers stopped, so the process
        // cannot exit mid-stop and orphan a live worker.
        self.shutdown_notify.notify_one();
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
async fn probe_worker_socket(
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
/// fit inside one [`WORKER_CONNECT_TIMEOUT_MS`] budget from spawn time.
fn worker_connect_deadline() -> tokio::time::Instant {
    tokio::time::Instant::now() + Duration::from_millis(WORKER_CONNECT_TIMEOUT_MS)
}

fn streamed_attach_lines(
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
fn salvage_id(line: &str) -> Option<String> {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| value.get("id").and_then(Value::as_str).map(str::to_string))
}

/// The command type of an unparsable line, salvaged for the failure echo
/// (bare commands carry the type at the top level; envelopes nest it).
fn salvage_command_type(line: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    value
        .get("command")
        .unwrap_or(&value)
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_string)
}

async fn write_line<W: AsyncWriteExt + Unpin>(writer: &mut W, value: &Value) -> Result<()> {
    let mut line = serde_json::to_string(value)?;
    line.push('\n');
    writer.write_all(line.as_bytes()).await?;
    writer.flush().await?;
    Ok(())
}

/// The worker-side command name plus payload for a routed client command.
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
        if matches!(
            command,
            DaemonCommand::Attach { .. } | DaemonCommand::Reattach { .. }
        ) {
            object.insert(
                "capabilities".to_string(),
                json!(["attach_snapshot", "event_sequence", "slim_attach"]),
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

/// One resident's roster identity for the `list --all` merge.
struct ResidentRoot {
    session_file: PathBuf,
    resident: Arc<ResidentWorker>,
    active_session_id: Option<String>,
}

fn saved_session_summary(info: &crate::session_store::SessionInfo) -> Value {
    let mut row = json!({
        "id": info.id,
        // TS `inactiveLifecycleForSession`: archived/crash markers stay
        // archived; everything else is live once a message exists, draft
        // otherwise.
        "lifecycle": match info.state.as_deref() {
            Some("archived") | Some("crash") => "archived",
            _ if info.message_count > 0 => "live",
            _ => "draft",
        },
        "activity": "idle",
        "isSessionActive": false,
        "activeSessionId": info.id,
        "sessionId": info.id,
        "sessionFile": info.path.to_string_lossy(),
        "sessionName": info.name,
        "cwd": info.cwd,
        "isStreaming": false,
        "isCompacting": false,
        "attachedClients": 0,
        "messageCount": info.message_count,
        "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
        "created": info.created,
        "modified": info.modified,
        "firstMessage": info.first_message,
    });
    // The persisted thinking level rides every saved-session summary row
    // (the durable `thinking_level_change` entry): the agents-view Model
    // column renders "model:level" for sessions without a live worker,
    // top-level and subagent alike.
    if let Some(level) = &info.thinking_level {
        if let Some(object) = row.as_object_mut() {
            object.insert("thinkingLevel".to_string(), json!(level));
        }
    }
    row
}

fn offline_summary(worker_id: &str) -> Value {
    json!({
        "id": worker_id,
        "lifecycle": "recovering",
        "activity": "idle",
        "isSessionActive": false,
        "sessionId": "",
        "cwd": "",
        "isStreaming": false,
        "isCompacting": false,
        "attachedClients": 0,
        "messageCount": 0,
        "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
    })
}

/// Entry point for the supervisor process.
pub async fn run_supervisor(options: SupervisorOptions) -> Result<()> {
    let supervisor = Arc::new(Supervisor::new(options)?);
    supervisor.run().await
}

/// Saved-session row (port of `serializeSavedSessionInfo`).
fn saved_session_row(info: &crate::session_store::SessionInfo) -> Value {
    let mut row = json!({
        "path": info.path.to_string_lossy(),
        "id": info.id,
        "cwd": info.cwd,
        "rlmDepth": info.rlm_depth,
        "created": info.created,
        "modified": info.modified,
        "messageCount": info.message_count,
        "firstMessage": info.first_message,
        // The scan's capped transcript corpus (TS `allMessagesText`): the
        // agents-view full-transcript search field.
        "allMessagesText": info.all_messages_text,
        "state": info.state.as_ref().map(|state| json!({ "status": state })),
    });
    if let Some(status) = &info.agent_status {
        row.as_object_mut()
            .expect("row object")
            .insert("agentStatus".to_string(), status.clone());
    }
    let object = row.as_object_mut().expect("row object");
    if let Some(name) = &info.name {
        object.insert("name".to_string(), json!(name));
    }
    if let Some(parent) = &info.parent_session_path {
        object.insert("parentSessionPath".to_string(), json!(parent));
    }
    if let Some((provider, model_id)) = &info.model {
        object.insert(
            "model".to_string(),
            json!({ "provider": provider, "modelId": model_id }),
        );
    }
    // The persisted thinking level rides the catalog row too: the TUI merges
    // it into live summaries that lack one (the same enrichment as `model`).
    if let Some(level) = &info.thinking_level {
        object.insert("thinkingLevel".to_string(), json!(level));
    }
    row
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
            .route_command(resident, "shutdown", json!({}), timeout.as_millis() as u64)
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
                && start_id
                    .as_deref()
                    .map(|start| {
                        crate::protocol::process_start_id(pid as u32).as_deref() == Some(start)
                    })
                    .unwrap_or(true);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The crash-path failure count: spawn-dies-fast churn accumulates to
    /// the give-up cap (the storm's counter could never grow while
    /// relaunch-spawns kept resetting it); a child that lived past the
    /// stable window was healthy, so its death starts a fresh count.
    #[test]
    fn churn_accumulates_and_a_stable_lifetime_resets() {
        let descriptor: DaemonWorkerDescriptor = serde_json::from_value(serde_json::json!({
            "version": 2,
            "workerId": "test-worker",
            "pid": 0,
            "socketPath": "/tmp/none.sock",
            "recoveryJournalPath": "/tmp/none.jsonl",
            "supervisorSocketPath": "/tmp/none.sock",
            "authenticationToken": "test",
            "rootActiveSessionId": "none",
            "createdAt": "2026-09-23T00:00:00Z",
            "updatedAt": "2026-09-23T00:00:00Z",
            "lifecycle": "ready",
            "createCommand": {},
            "consecutiveFailures": 0,
        }))
        .expect("descriptor");
        let resident = ResidentWorker::new(
            "test-worker".to_string(),
            descriptor,
            std::path::PathBuf::from("/tmp/none"),
        );
        let now = 1_000_000_000u64;
        // No spawn time (an adopted pid): plain accumulation.
        assert_eq!(Supervisor::next_failure_count(&resident, now), 1);
        assert_eq!(Supervisor::next_failure_count(&resident, now), 2);
        // A stable lifetime: the healthy death starts a fresh count.
        resident
            .spawned_at_ms
            .store(now - STABLE_LIFETIME_MS - 1, Ordering::SeqCst);
        assert_eq!(Supervisor::next_failure_count(&resident, now), 1);
        // A spawn that lived past the stable window but died young still accumulates.
        resident
            .spawned_at_ms
            .store(now - STABLE_LIFETIME_MS + 10_000, Ordering::SeqCst);
        assert_eq!(Supervisor::next_failure_count(&resident, now), 2);
    }

    /// The saved-session surfaces (the `list --all` summary row and the
    /// `list_saved_sessions` catalog row) carry the persisted thinking
    /// level: the agents-view Model column renders "model:level" for
    /// sessions without a live worker, top-level and subagent alike.
    #[test]
    fn saved_session_rows_carry_the_persisted_thinking_level() {
        let dir = std::env::temp_dir().join(format!("pa-saved-tl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
        let path = dir.join(format!("{}.jsonl", session.session_id()));
        session.set_path(path.clone());
        session.append_model_change("p", "m");
        session.append_thinking_level_change("high");
        session.append_message(json!({"role": "user", "content": "hi", "timestamp": 1u64}));
        session.rewrite().unwrap();
        let info = crate::session_store::read_session_info(&path).unwrap();
        assert_eq!(info.thinking_level.as_deref(), Some("high"));
        let summary = saved_session_summary(&info);
        assert_eq!(summary["thinkingLevel"], json!("high"));
        assert!(summary["model"].is_null(), "saved rows carry no model");
        let row = saved_session_row(&info);
        assert_eq!(row["thinkingLevel"], json!("high"));
        assert_eq!(row["model"], json!({ "provider": "p", "modelId": "m" }));
        // A session file without a persisted level stays bare (a fresh
        // draft, or a model that cannot think).
        let mut draft = crate::session_store::SessionFile::create("/tmp", None, 0);
        let draft_path = dir.join(format!("{}.jsonl", draft.session_id()));
        draft.set_path(draft_path.clone());
        draft.rewrite().unwrap();
        let draft_info = crate::session_store::read_session_info(&draft_path).unwrap();
        assert_eq!(draft_info.thinking_level, None);
        assert!(saved_session_summary(&draft_info)
            .get("thinkingLevel")
            .is_none());
        assert!(saved_session_row(&draft_info)
            .get("thinkingLevel")
            .is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn worker_probe_fails_at_the_deadline_and_names_the_worker() {
        let dir = std::env::temp_dir().join(format!("pa-probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("never.sock");
        let expired = tokio::time::Instant::now() - Duration::from_millis(1);
        let error = probe_worker_socket("worker-abc", &socket, expired)
            .await
            .expect_err("expired budget errors");
        assert_eq!(
            error.to_string(),
            "session worker worker-abc did not come up in time"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn worker_probe_accepts_a_live_socket() {
        let dir = std::env::temp_dir().join(format!("pa-probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("live.sock");
        let listener = pa_types::platform::transport::bind_transport(&socket)
            .await
            .unwrap();
        let deadline = worker_connect_deadline();
        probe_worker_socket("worker-abc", &socket, deadline)
            .await
            .expect("a live worker socket satisfies the probe");
        let _ = std::fs::remove_file(&socket);
        drop(listener);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
