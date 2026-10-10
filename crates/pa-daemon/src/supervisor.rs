//! Supervisor runtime: one process spawning one worker per active session:
//! clients connect over a JSONL Unix socket; the supervisor spawns a dedicated
//! worker per session, supervises it (restart with backoff, bounded attempts),
//! and persists worker descriptors so a restarted supervisor can adopt live sessions.

mod accept_loop;
mod adoption;
mod clients;
mod launch_budget;
mod notes;
mod options;
mod root_identity;
mod routing;
mod sessions;
mod signals_shutdown;
pub(crate) mod subscribers;
mod update_restart;
mod worker_lifecycle;

use adoption::AdoptionBoot;
use launch_budget::WORKER_AUTH_FLOOR_MS;
// Called only by the clients sibling module (its `use super::*` glob); unused on the lib target.
#[allow(unused_imports)]
use signals_shutdown::daemon_closing_shutdown_event;
mod supervision;

#[cfg(test)]
mod handshake_tests;
#[cfg(test)]
mod spawn_record_tests;
#[cfg(test)]
mod tests;

// Read only by this facade's in-file tests; the lib-target import is flagged unused.
#[allow(unused_imports)]
use supervision::{MAX_CONSECUTIVE_FAILURES, STABLE_LIFETIME_MS};

// Called only by this facade's in-file test modules; the lib-target import is unused.
#[allow(unused_imports)]
use sessions::{saved_session_row, saved_session_summary};

pub(crate) use options::ClientRouting;
pub use options::SupervisorOptions;

// Called only by the routing and clients siblings (their `use super::*` globs); lib-unused.
#[allow(unused_imports)]
use update_restart::{salvage_command_type, salvage_id, streamed_attach_lines};

pub(crate) use clients::client_command_payload;

// The routing consts and refusal string keep their crate::supervisor::* paths stable
// (external callers: supervisor_parent_death, create_reuse, prompt_admission, update_restore).
pub(crate) use routing::{
    client_route_timeout, ROUTE_TIMEOUT_MS, SUMMARY_TIMEOUT_MS, WORKER_NOT_CONNECTED,
};

// Called only by the supervision sibling module and in-file tests; lib-target unused.
#[allow(unused_imports)]
use worker_lifecycle::{probe_worker_socket, worker_connect_deadline};

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use futures::future::join_all;
use pa_types::daemon::{
    DaemonCommand, DaemonErrorInfo, DaemonOutbound, DaemonSessionLifecycle, DaemonWorkerDescriptor,
    DaemonWorkerLifecycle, DurableDaemonCreateCommand, SnapshotPurpose, UpdateId,
    UpdatePreparedMarker, UpdateTimeoutBudget,
};
use pa_types::platform::transport::{bind_transport, connect_transport, TransportStream};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::backpressure::RouteAdmission;
use crate::descriptor::{
    create_command_payload, load_descriptors, persist_supervisor_config, persist_worker,
    persist_worker_at, PersistedSupervisorConfig, TempSync, SUPERVISOR_CONFIG_FILE_NAME,
};
use crate::engine::EngineModelSelection;
use crate::framing::{write_frame, PrivateFrameReader, DEFAULT_PRIVATE_FRAME_LIMITS};
use crate::paths;
use crate::prompt_admission::input_admission_id;
use crate::protocol::{
    app_version, command_active_session_id, command_type_name, current_protocol_info,
    parse_supervisor_command_line, response_failure, response_line, response_success,
    DaemonResponse, DaemonRuntimeIdentity, EnvelopeParseError, TypedCreateRejection,
    DAEMON_SCHEMA_ID, DAEMON_SCHEMA_REVISION,
};
use crate::registry::{
    ResidentWorker, SessionRegistry, WorkerRegistration, WorkerReply, WorkerRequest,
};
use crate::saved_session_commands::{name_unavailable_error, reservation_key, NameScope};
use crate::session_store::list_sessions;
use crate::snapshot_stream::{attach_client_capabilities, stream_attach, wants_chunked};
use crate::update_prepare::{
    marker_expires_at_iso, update_gate_refuses, write_prepared_artifacts, AbortOutcome,
    BeginOutcome, MutationDrainLatch, PrepareCoordinator, PrepareOp, UPDATE_PREPARING_MESSAGE,
};
// The drain-state machine that names it is the unix signal path.
#[cfg(unix)]
use crate::update_prepare::PrepareState;
use crate::update_roster::{
    build_update_roster, supervisor_identity, UpdateRosterInputs, WorkerSnapshot,
};
use crate::update_stop::{stop_workers_gracefully, WorkerStopVerdict, WORKER_REQUEST_TIMEOUT_MS};
use crate::{socket, util};

pub struct Supervisor {
    pub(crate) options: SupervisorOptions,
    descriptor_dir: PathBuf,
    /// The bind-time filesystem identity of this supervisor's socket file
    /// (TS `DaemonSupervisor` captures `socketIdentity` right after
    /// `listen`, daemon-supervisor.ts:879): the exit cleanup passes it as
    /// the unlink's expected identity, so a file REPLACED at the path
    /// after this bind - an external sweep plus a successor's bind - is
    /// never unlinked by this process. `None` until `run` binds (named
    /// pipes keep `None`: there is no file to stat).
    bound_socket_identity: std::sync::Mutex<Option<socket::SocketIdentity>>,
    /// The per-supervisor launch-probe budget override: `None` rides the
    /// process-wide env seam (`PA_DAEMON_WORKER_CONNECT_TIMEOUT_MS`),
    /// a pinned budget keeps a launch oracle's probe immediate without
    /// mutating that env var (a set value would leak into every
    /// parallel test's launch).
    worker_connect_budget: std::sync::Mutex<Option<Duration>>,
    /// The durable session-binding table (the stale-active-id rebind
    /// surface): every active id the supervisor has routed stays
    /// addressable through its session's durable identity, so a client
    /// holding a superseded id resolves to the session's current
    /// resident instead of `Unknown active session`.
    pub(crate) session_bindings: crate::session_bindings::SessionBindingTable,
    /// Per-session-file single-flight for opens (TS `openingWorkers`): a concurrent create
    /// reuses the first one's worker instead of losing the runtime session lease.
    pub(crate) opening_files:
        std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Daemon-lifecycle telemetry (`daemon event` schema v1), resolved at
    /// run start (None = opted out); never blocks supervision paths.
    telemetry: std::sync::Mutex<Option<pa_telemetry::TelemetryClient>>,
    /// The frequent supervision events (attach/detach, worker exits and
    /// restarts, overloads, saved-session listings), counted and sent as
    /// one `daemon event` summary per window instead of one event each.
    daemon_event_counts: std::sync::Mutex<notes::DaemonEventCounts>,
    pub(crate) registry: SessionRegistry,
    /// Worker outbound frames, with their client routing. The payload is shared (`Arc`):
    /// a per-receiver deep `Value` clone would multiply the heap by the connection
    /// count on every event.
    pub(crate) events: broadcast::Sender<(ClientRouting, std::sync::Arc<Value>)>,
    /// Session-event subscribers: the send-time routing index (TS parity —
    /// `handleWorkerFrame` evaluates the attached set in the same pass that
    /// writes the socket). Broadcast-class events keep the ring above.
    pub(crate) session_subscribers: subscribers::SessionSubscribers,
    /// Live client connections: connection id -> the connection's
    /// effective client id (TS `this.clients` + `protocolClientId`).
    pub(crate) client_connections:
        std::sync::Mutex<std::collections::HashMap<String, Arc<std::sync::Mutex<String>>>>,
    /// The supervisor's agent roster (classified entries; the roster arms
    /// live in `supervisor_roster.rs`).
    pub(crate) roster: std::sync::Mutex<crate::agent_roster::AgentRoster>,
    /// The last `roster_update` content published per agent id (the content-diff
    /// guard): an unchanged row is dropped from the push.
    pub(crate) last_published_roster:
        std::sync::Mutex<std::collections::HashMap<String, serde_json::Value>>,
    /// In-flight registration-seed tasks: a `roster_subscribe` drains and awaits
    /// them before building its snapshot, so a seeded row's push never overtakes
    /// the answer.
    pub(crate) pending_registration_seeds: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// In-flight name reservations (TS `pendingSessionNames`): one per `[depth, parent, name]`
    /// scope, shared by the rename ladder and the subagent spawn admission, so a concurrent
    /// same-name rename or spawn fails the second caller.
    pub(crate) pending_session_names: std::sync::Mutex<std::collections::HashSet<String>>,
    pub(crate) shutting_down: AtomicBool,
    /// Whether some path has taken ownership of the one terminal stop pass: exactly one
    /// connection runs `begin_shutdown`, even if several clients notice the shutdown.
    shutdown_started: AtomicBool,
    /// The connection that accepted the one terminal shutdown request: only it may
    /// run the stop pass from its response-write or disconnect paths.
    shutdown_owner: std::sync::Mutex<Option<String>>,
    /// The accept loop's exit flag: the loop must stay up until
    /// [`Supervisor::begin_shutdown`] has stopped every resident worker — an
    /// inbound connection must not fall it out mid-stop.
    accept_exit: AtomicBool,
    /// Wakes the accept loop when [`Supervisor::begin_shutdown`] sets [`Self::accept_exit`]:
    /// a socket blocking in `accept` must be interrupted by the completed shutdown.
    shutdown_notify: tokio::sync::Notify,
    log: paths::RotatingLog,
    /// Memoized ledger over the default sessions dir (ledgers are per
    /// sessions-dir families; another dir gets a fresh instance).
    rlm_ledger: tokio::sync::Mutex<Option<std::sync::Arc<crate::rlm_ledger::RlmSpawnLedger>>>,
    /// The update-prepare transaction: at most one per supervisor;
    /// empty = `Serving`.
    update_prepare: PrepareCoordinator,
    /// In-flight mutating-command counter feeding the prepare transaction's `Draining` wait.
    mutation_drain: MutationDrainLatch,
    /// Timeout budget of the update flow (`PRIME_AGENT_UPDATE_*_MS`
    /// overridable for CI).
    update_budget: UpdateTimeoutBudget,
    /// The boot-time restore pass (spec §6): sweep + roster restore + scheduled-work
    /// re-arm; read by the hello resume contract and the `update_restore_status` RPC.
    pub(crate) restore: crate::update_restore::RestoreProgress,
    /// The session input-pause leases: pause id -> lease, the bookkeeping
    /// behind `acquire`/`release_session_input_pause`.
    pub(crate) input_pauses: crate::input_pause_lease::SupervisorPauseTable,
    /// The passive scheduled-jobs snapshot the catalog READ paths serve: the
    /// session-artifacts tree scans once per generation instead of once per request;
    /// daemon-owned mutations drop it through `invalidate_passive_catalog`.
    pub(crate) passive_catalog:
        std::sync::Mutex<Option<crate::scheduling_catalog::PassiveCatalogSnapshot>>,
    /// One passive-catalog scan at a time: concurrent cold reads share one in-flight scan.
    pub(crate) passive_scan_gate: tokio::sync::Mutex<()>,
    /// A stale refresh is already queued: readers that arrive while it runs share it.
    pub(crate) passive_scan_pending: std::sync::atomic::AtomicBool,
    /// The passive snapshot's publish epoch: an invalidation claims a newer epoch, so a
    /// scan that raced the invalidation cannot republish its pre-mutation rows as fresh.
    pub(crate) passive_catalog_epoch: std::sync::atomic::AtomicU64,
    /// The terminal-compaction journal: durable record of compactions declared aborted
    /// when the worker could not answer; feeds the replacement-worker create replay,
    /// cleared by a landed `compaction_end`.
    pub(crate) compaction_journal:
        std::sync::Mutex<crate::compaction_supervision::TerminalCompactionJournal>,
    /// The stop-admission boundary: the shutdown flags publish
    /// SYNCHRONOUSLY at loss discovery, and every stop transition takes
    /// this lock for its final gate and durable tombstone persist - the
    /// lease-loss fence then acquires the lock after the flip, so every
    /// stop already past its final recheck finishes its durable persist
    /// before the lease can release, and no later stop admits at all.
    pub(crate) stop_admission: tokio::sync::Mutex<()>,
    /// Every armed owner-cleanup timer's handle, pruned of finished
    /// entries: the lease-loss teardown aborts and joins them, so no
    /// parked or mid-gate timer outlives the supervisor's lease.
    pub(crate) owner_cleanup_timers: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// Test-only witness: notified when a lease-loss fence reaches its
    /// stop-gate step (the timers and boot passes are aborted and
    /// joined; the gate acquire is next). Production builds carry no
    /// such wake - tests use it as the fence's observable readiness.
    #[cfg(all(test, unix))]
    pub(crate) fence_at_gate: tokio::sync::Notify,
}

/// Register a boot pass in the shared slot. Every spawn registers in
/// its own step (no await between the spawn and the registration), so
/// a lease compromise firing while the boot block is still mid-flight
/// fences every pass spawned so far - a handle left inside the
/// cancelled future would detach its task to act against a successor.
fn register_boot_task(
    slot: &std::sync::Arc<std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    handle: tokio::task::JoinHandle<()>,
) {
    slot.lock().expect("boot task slot lock").push(handle);
}

impl Supervisor {
    /// Build the supervisor: descriptor dir, persisted config, event channel, log, journal.
    ///
    /// # Errors
    ///
    /// Returns an error when the descriptor dir, sessions dir, config, or journal cannot be opened.
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
        let (events, _) = broadcast::channel(crate::backpressure::EVENT_RING_CAPACITY);
        let log = paths::RotatingLog::new(paths::daemon_log_path(
            &options.socket_path,
            &options.agent_dir,
        ));
        let compaction_journal = crate::compaction_supervision::TerminalCompactionJournal::open(
            &descriptor_dir.join("compaction-supervision.jsonl"),
        )?;
        Ok(Supervisor {
            options,
            descriptor_dir,
            bound_socket_identity: std::sync::Mutex::new(None),
            worker_connect_budget: std::sync::Mutex::new(None),
            session_bindings: crate::session_bindings::SessionBindingTable::new(),
            opening_files: std::sync::Mutex::new(std::collections::HashMap::new()),
            telemetry: std::sync::Mutex::new(None),
            daemon_event_counts: std::sync::Mutex::default(),
            registry: SessionRegistry::new(),
            events,
            session_subscribers: subscribers::SessionSubscribers::new(),
            client_connections: std::sync::Mutex::new(std::collections::HashMap::new()),
            roster: std::sync::Mutex::new(crate::agent_roster::AgentRoster::new()),
            last_published_roster: std::sync::Mutex::new(std::collections::HashMap::new()),
            pending_registration_seeds: std::sync::Mutex::new(Vec::new()),
            pending_session_names: std::sync::Mutex::new(std::collections::HashSet::new()),
            shutting_down: AtomicBool::new(false),
            shutdown_started: AtomicBool::new(false),
            shutdown_owner: std::sync::Mutex::new(None),
            accept_exit: AtomicBool::new(false),
            shutdown_notify: tokio::sync::Notify::new(),
            log,
            rlm_ledger: tokio::sync::Mutex::new(None),
            update_prepare: PrepareCoordinator::new(),
            mutation_drain: MutationDrainLatch::new(),
            update_budget: UpdateTimeoutBudget::from_env(),
            restore: crate::update_restore::RestoreProgress::new(),
            input_pauses: crate::input_pause_lease::SupervisorPauseTable::default(),
            passive_catalog: std::sync::Mutex::new(None),
            passive_scan_gate: tokio::sync::Mutex::new(()),
            passive_scan_pending: std::sync::atomic::AtomicBool::new(false),
            passive_catalog_epoch: std::sync::atomic::AtomicU64::new(0),
            compaction_journal: std::sync::Mutex::new(compaction_journal),
            stop_admission: tokio::sync::Mutex::new(()),
            owner_cleanup_timers: std::sync::Mutex::new(Vec::new()),
            #[cfg(all(test, unix))]
            fence_at_gate: tokio::sync::Notify::new(),
        })
    }

    /// Close admission the moment a lease loss is KNOWN: the shutdown and
    /// accept-exit flags plus the waiter notification must land BEFORE the
    /// serving-exit fence waits out in-flight boot steps - client handlers
    /// and owner-cleanup timers must not act on a lost lease while the
    /// fence drains - with NO await ahead of the flag flip (a slow
    /// gated stop persist must never hold the admission window open).
    /// The tracked owner-cleanup timers are fenced by the lease-loss
    /// fence that follows: parked ones never wake, and a mid-gate one
    /// dies at its next await (its stop transition still faces the
    /// gated recheck).
    #[cfg(unix)]
    fn mark_supervisor_shutting_down(&self) {
        self.close_supervisor_admission(
            "daemon socket lease compromised; relinquishing supervisor ownership",
        );
    }

    /// Close admission - SYNCHRONOUSLY, with NO await ahead of the
    /// flags (a slow gated stop persist must never hold the admission
    /// window open): the shutdown and accept-exit flags plus the waiter
    /// notification. Every TERMINAL serving exit closes admission
    /// before its fence: live client handlers must not start a stop or
    /// arm a fresh timer behind the one-shot fence while the exit
    /// flush and the lease release run.
    #[cfg(unix)]
    fn close_supervisor_admission(&self, reason: &str) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.accept_exit.store(true, Ordering::SeqCst);
        self.shutdown_notify.notify_waiters();
        self.log.append(reason);
    }

    /// The serving exit's admission close: on EVERY terminal serving
    /// exit (healthy accept-exhaustion included) the admission flags
    /// close FIRST - synchronously, before ANY lease probe runs. The
    /// probe that follows is the ASYNC grace form (the blocking one
    /// would sleep the worker for the whole displacement grace on a
    /// displaced lease, landing the flags late exactly when new stops
    /// or owner-cleanup timers could still admit). A lost-lease verdict
    /// appends the compromise record on top of the already-closed
    /// admission. Returns the loss verdict for the caller's logging and
    /// exit decision.
    #[cfg(unix)]
    async fn serving_exit_closes_admission_then_samples(
        &self,
        socket_lease: &crate::socket::SocketLease,
    ) -> bool {
        self.close_supervisor_admission("daemon serving ended; closing supervisor admission");
        let lease_lost = socket_lease.assert_held_async().await.is_err();
        if lease_lost {
            // The serving-end close above already stands; the loss
            // verdict adds its compromise record.
            self.log
                .append("daemon socket lease compromised; relinquishing supervisor ownership");
        }
        lease_lost
    }

    /// The lease-loss fence: with the flags already up, EVERY tracked
    /// handle - owner-cleanup timers AND boot passes - is aborted FIRST
    /// (a handle caught in an unpreemptible step must not strand the
    /// other handles' aborts behind its join), and only then are the
    /// joins awaited. The stop gate runs last: stop transitions already
    /// past their final recheck complete their durable persist before
    /// the lease can release, and every later stop is refused at the
    /// gate (the flags are already up).
    #[cfg(unix)]
    async fn lease_loss_fence(&self, boot_tasks: &mut Vec<tokio::task::JoinHandle<()>>) {
        let timers: Vec<_> = self
            .owner_cleanup_timers
            .lock()
            .expect("owner-cleanup timer registry lock")
            .drain(..)
            .collect();
        for timer in &timers {
            timer.abort();
        }
        for task in boot_tasks.iter() {
            task.abort();
        }
        for timer in timers {
            let _ = timer.await;
        }
        for task in boot_tasks.drain(..) {
            let _ = task.await;
        }
        #[cfg(all(test, unix))]
        self.fence_at_gate.notify_waiters();
        drop(self.stop_admission.lock().await);
    }

    /// Bind the client socket, adopt or relaunch persisted workers, serve.
    ///
    /// # Errors
    ///
    /// Returns an error when the socket path cannot be prepared (already in use), the
    /// socket cannot be bound, or the accept loop exhausts its give-up budget.
    ///
    /// # Panics
    ///
    /// Panics when the telemetry mutex is poisoned (the holder panicked mid-lock).
    pub async fn run(self: Arc<Self>) -> Result<()> {
        // Before any socket or worker exists: workers and their kernels
        // inherit the raised limit.
        let open_file_limit = pa_core::platform::process::raise_open_file_limit();
        // Daemon telemetry: same env/settings posture as the sessions
        // (the supervisor is the `daemon` execution mode). Only an
        // environment opt-out skips the client: a settings opt-out is the
        // client's live switch, so `/telemetry on` resumes without a
        // daemon restart.
        {
            let settings = pa_core::settings::SettingsManager::create(
                std::env::current_dir().unwrap_or_default(),
                &self.options.agent_dir,
            );
            let env_forced_off = matches!(
                pa_core::session_engine::telemetry::telemetry_switch(&settings),
                pa_core::session_engine::telemetry::TelemetrySwitch::Env { enabled: false, .. }
            );
            *self.telemetry.lock().unwrap() = (!env_forced_off).then(|| {
                pa_core::session_engine::telemetry::build_client(&settings, &self.options.agent_dir)
            });
        }
        // Live model catalog (both fetch layers): the supervisor keeps the disk caches warm
        // for every worker it spawns — startup refresh plus the hourly loop, fire-and-forget.
        let _ = pa_core::models::startup_refresh(&self.options.agent_dir);
        pa_core::models::spawn_hourly_refresh(&self.options.agent_dir);
        // The plugins service catalog's keep-warm (the `/mcp` view's remote catalog): same
        // cadence — startup refresh plus the hourly loop, failures keep the last-good cache.
        pa_core::mcp::startup_plugins_refresh(&self.options.agent_dir);
        pa_core::mcp::spawn_hourly_plugins_refresh(&self.options.agent_dir);
        // Adoption telemetry: one `daemon event` (kind `catalog_refresh`) when the startup
        // refresh settles — the served model count, primitives only.
        {
            let supervisor = Arc::clone(&self);
            tokio::spawn(async move {
                let agent_dir = &supervisor.options.agent_dir;
                let catalog = pa_core::models::catalog_for(Some(&agent_dir.join("models.json")));
                let credentials = pa_core::models::prime_credentials_for_dir(agent_dir);
                catalog
                    .refresh_with_credentials(false, credentials.as_ref())
                    .await;
                let count = catalog.resolve(credentials.as_ref()).len();
                supervisor.note_catalog_refresh(count);
            });
        }
        #[cfg(unix)]
        {
            // TS refuses a duplicate daemon before any lock queueing (the
            // fast in-use check `prepareDaemonSocketPath` runs first): a
            // live listener must fail in ~250ms, not after the lease's
            // 600x25ms retry budget.
            if socket::can_connect(&self.options.socket_path, Duration::from_millis(250)).await {
                return Err(anyhow!(
                    "Daemon socket already in use: {}",
                    self.options.socket_path.display()
                ));
            }
        }
        #[cfg(unix)]
        let socket_lease = socket::SocketLease::acquire(&self.options.socket_path).await?;
        #[cfg(unix)]
        socket::prepare_socket_path_with_lease(&self.options.socket_path, &socket_lease).await?;
        #[cfg(not(unix))]
        socket::prepare_socket_path(&self.options.socket_path).await?;
        #[cfg(unix)]
        socket_lease.assert_held_async().await?;
        let listener = bind_transport(&self.options.socket_path)
            .await
            .with_context(|| {
                format!(
                    "bind supervisor socket {}",
                    self.options.socket_path.display()
                )
            })?;
        #[cfg(unix)]
        socket_lease.assert_held_async().await?;
        socket::bind_capture_gap().await;
        // Capture the bound file's identity before anything can replace
        // it (TS daemon-supervisor.ts:879, between `listen` and
        // `restrictDaemonSocketPath`): the exit cleanup below compares
        // against THIS value, never a fresh read, so a successor's file
        // at the same path survives this supervisor's exit.
        *self.bound_socket_identity.lock().unwrap() =
            socket::socket_identity(&self.options.socket_path);
        socket::restrict_socket_path(&self.options.socket_path);
        self.log
            .append(&format!("supervisor started pid {}", std::process::id()));
        match open_file_limit {
            Ok(Some(limit)) => self.log.append(&format!("open file limit {limit}")),
            Ok(None) => {}
            Err(error) => self
                .log
                .append(&format!("open file limit raise failed: {error}")),
        }

        // The OS-signal drain (the loop lives in `crate::signal_drain`): `install` registers
        // the handlers synchronously here — before the boot passes and their first await —
        // so no signal can land with the default disposition still active.
        tokio::spawn(crate::signal_drain::install(Arc::clone(&self)));

        // The boot's ownership actions - reaping this socket's predecessor
        // lineage, the update restore, descriptor adoption - may only run
        // while the lease holds: a supervisor displaced mid-boot must
        // never reap or adopt against a successor that took the socket
        // over while these passes ran, so the whole block races the
        // lease-compromise monitor and aborts the boot the moment
        // ownership is lost (the accept loop's select below is the same
        // monitor's steady-state arm).
        //
        // The spawned handles are registered in a slot the CANCELLED
        // block's spawns still reach: the boot select's compromise arm
        // fires while the block is mid-flight, and every pass spawned so
        // far must be fenceable from there - a handle left inside the
        // cancelled future would detach its task against the successor.
        // The adoption fan-out drain is created outside for the same
        // reason: the fence below awaits the nested jobs' actual settle.
        let boot_tasks_slot = std::sync::Arc::new(std::sync::Mutex::new(Vec::<
            tokio::task::JoinHandle<()>,
        >::new()));
        let adoption_fanout = crate::recovery_pacing::FanoutDrain::new();
        let boot_ownership = async {
            // The reap is an OWNERSHIP action against the socket's
            // lineage, and it must not race a successor's publication:
            // (1) the RECLAIM-SIDECAR EXCLUSION is held ACROSS the whole
            // pass - every COMPLIANT successor (a judge or stale-reclaim
            // dance) must hold this same sidecar before displacing
            // anything, so a protocol-following takeover cannot publish
            // mid-signal; the lease is REASSERTED under the held
            // exclusion, where a path mismatch is a real compromise and
            // never a transient dance. (2) the grace-waited assert
            // settles any displacement that predates the exclusion. (3)
            // the per-step displacement probe remains the belt for
            // NON-compliant actors (the select's `biased` monitor is only
            // a tie-breaker - a grace-parked monitor does not stop this
            // block).
            #[cfg(target_os = "linux")]
            {
                let exclusion_budget = std::time::Duration::from_millis(500);
                match socket_lease.hold_reclaim_exclusion(exclusion_budget).await {
                    Ok(Some(exclusion)) => {
                        // The exclusion is held for the REASSERT only -
                        // never across the reap: the lease heartbeat's
                        // refresh thread skips its mtime write while the
                        // sidecar is taken, so a whole-pass hold would
                        // age this lock toward the stale threshold and
                        // invite a takeover the moment it dropped. The
                        // reap itself takes its own STEP-SCOPED holds
                        // around every signal and removal.
                        socket_lease.assert_held_async().await?;
                        drop(exclusion);
                        // The boot reap (the operator's same-socket
                        // predecessor rule): this daemon now owns the
                        // socket's lineage, so leftover worker processes
                        // of a dead predecessor - alive, still holding
                        // their runtime session leases, unreachable
                        // through any descriptor or registration - die
                        // here, and a wedged predecessor supervisor dies
                        // with them. Daemons and workers on OTHER
                        // sockets are never touched (the scan matches
                        // the socket path alone). The reap precedes the
                        // adoption pass and the first client: a create
                        // racing a leftover holder would answer the lease
                        // refusal this pass exists to clear. Bounded by
                        // construction (every target shares one
                        // escalation window). A FROZEN reap fails the
                        // whole ownership boot - no sweep, adoption, or
                        // restore runs against a possibly-successor's
                        // socket.
                        if crate::boot_reap::reap_predecessors(
                            &self,
                            Some(&|| socket_lease.path_displaced()),
                        )
                        .await
                        {
                            return Err(anyhow!(
                                "boot ownership unavailable: the socket lease was displaced during the reap"
                            ));
                        }
                    }
                    Ok(None) => {
                        // The sidecar stayed with a suspended dance past
                        // the budget: OWNERSHIP IS UNPROVABLE - a
                        // suspended dance may already have displaced this
                        // lease, and no further ownership action of this
                        // boot may run against what may be a successor's
                        // socket. The whole ownership boot fails here;
                        // the select's boot arm runs the full lease-loss
                        // teardown (admission closes, everything tracked
                        // is fenced, the lease is consumed off the
                        // worker).
                        return Err(anyhow!(
                            "boot ownership unavailable: the lock reclaim exclusion was held past its budget"
                        ));
                    }
                    Err(error) => {
                        // The acquisition task itself failed (distinct
                        // from budget contention): the same fail-closed
                        // ownership abort, with the real cause surfaced.
                        return Err(error.context(
                            "boot ownership unavailable: the lock reclaim exclusion acquisition failed",
                        ));
                    }
                }
            }
            #[cfg(all(unix, not(target_os = "linux")))]
            {
                // No sidecar primitive exists on this platform (the
                // documented floor): the grace-waited assert plus the
                // per-step displacement probe is the belt the floor
                // allows - a suspended dance cannot exist without the
                // exchange primitives.
                socket_lease.assert_held_async().await?;
                if crate::boot_reap::reap_predecessors(
                    &self,
                    Some(&|| socket_lease.path_displaced()),
                )
                .await
                {
                    return Err(anyhow!(
                        "boot ownership unavailable: the socket lease was displaced during the reap"
                    ));
                }
            }
            #[cfg(not(unix))]
            {
                crate::boot_reap::reap_predecessors(&self, None).await;
            }

            // Update boot (spec §6): consume the roster from the spawn
            // env BEFORE the sweep deletes the file it points at, sweep
            // this socket's update scratch dir unconditionally (invariant
            // I2 by construction), then run the restore + re-arm pass
            // concurrently with serving — the accept loop must keep
            // serving hellos so reconnecting clients see the resume
            // contract (§10.3).
            let roster = crate::update_restore::consume_roster_env();
            self.restore.begin(roster.as_ref());
            crate::update_restore::boot_sweep(&self.options.agent_dir, &self.options.socket_path);
            // Descriptor adoption runs concurrently with the accept loop:
            // a supervisor restarted over live sessions must accept their
            // self-registrations immediately, not behind the whole
            // descriptor scan. The fan-out is capped (recovery_pacing) so
            // a large sessions dir cannot starve the control plane. The
            // restore pass waits on the adopt pass's completion signal
            // (spec §6 step 2's create-or-adopt order: kept workers
            // relaunch from their descriptors first, the roster covers
            // the rest); the adopt task's own handle stays abortable for
            // the lease-compromise fence below.
            // The adopt pass's completion signal: the passive-catalog
            // warmup waits on it (see below), and so does the restore
            // pass (both waiters observe the same signal).
            let (adoption_tx, adoption_signal) = tokio::sync::watch::channel(false);
            // The spawned passes stay detached (they run concurrently with
            // serving by design), but their handles are registered in the
            // shared slot IN THE SPAWN'S OWN STEP (no await between the
            // spawn and its registration): a lease compromise aborts them
            // instead of letting ownership passes act against a successor
            // - from the serving-exit fences AND from a compromise that
            // fires while this block is still mid-flight.
            let boot_tasks_slot = std::sync::Arc::clone(&boot_tasks_slot);
            // The adoption pass's nested fan-out drain: the fence below
            // aborts and awaits the pass's own handle, but the JoinSet's
            // drop only abort-FLAGS the nested jobs - an in-flight job
            // step (a socket connect, a relaunch spawn) can still be
            // executing after the handle is joined. The drain lives
            // outside the spawned pass (created before the boot block),
            // so the fence can await the fan-out's actual settle before
            // the socket cleanup and the lease release below - even when
            // the compromise fires while this block is mid-flight.
            let adoption = {
                let supervisor = Arc::clone(&self);
                let fanout = adoption_fanout.clone();
                let boot = match roster.as_ref() {
                    Some(roster) => AdoptionBoot::UpdateRoster {
                        kept: Arc::new(
                            roster
                                .workers
                                .iter()
                                .map(|worker| worker.worker_id.clone())
                                .collect(),
                        ),
                    },
                    None => AdoptionBoot::PlainStartup,
                };
                tokio::spawn(async move {
                    supervisor.adopt_persisted_workers(boot, fanout).await;
                    let _ = adoption_tx.send(true);
                })
            };
            register_boot_task(&boot_tasks_slot, adoption);
            {
                let supervisor = Arc::clone(&self);
                let adoption_signal = adoption_signal.clone();
                register_boot_task(
                    &boot_tasks_slot,
                    tokio::spawn(async move {
                        crate::update_restore::restore_pass(&supervisor, adoption_signal, roster)
                            .await;
                    }),
                );
            }

            // Warm the passive scheduled-jobs snapshot (the input-latency
            // lane): the first selector-less `heartbeats_list`/`cron_list`
            // after boot would otherwise scan the whole session-artifacts
            // tree inline while the interactive client's open waits on it.
            // The scan waits out the boot's adopt pass first (the pre-bar
            // review's race finding): the scan's live-worker filter
            // consults the registry, so a scan that raced the adopt pass
            // would cache the just-adopted worker's artifacts as a
            // passive row and serve the stale row for the snapshot's whole
            // refresh window — adoption never invalidates the catalog.
            // After the signal (a plain startup's adopt pass is ms-scale)
            // the scan still lands well before the first client read;
            // every invalidation and refresh rule is unchanged. The signal
            // is fail-open: an adopt pass that died without signaling
            // still warms (a degraded boot keeps the pre-warmup cold-read
            // behavior, never a colder one).
            {
                let supervisor = Arc::clone(&self);
                let mut adopted = adoption_signal;
                register_boot_task(
                    &boot_tasks_slot,
                    tokio::spawn(async move {
                        Supervisor::wait_for_adoption_signal(&mut adopted).await;
                        supervisor.spawn_passive_catalog_warmup();
                    }),
                );
            }

            // Session-archive sweep (roadmap: the sessions directory must
            // not grow forever): boot sweep, then the periodic re-sweep at
            // the TS idle-eviction cadence. Housekeeping only — it never
            // gates serving.
            {
                let supervisor = Arc::clone(&self);
                register_boot_task(
                    &boot_tasks_slot,
                    tokio::spawn(async move {
                        crate::session_archive::archive_sweep_loop(&supervisor).await;
                    }),
                );
            }

            // Update-prepare watchdog: aborts deadline- or
            // self-expiry-breached prepare transactions even when no
            // command arrives to re-check.
            {
                let supervisor = Arc::clone(&self);
                register_boot_task(
                    &boot_tasks_slot,
                    tokio::spawn(async move {
                        supervisor.update_prepare_watchdog().await;
                    }),
                );
            }
            Ok::<(), anyhow::Error>(())
        };
        #[cfg(unix)]
        tokio::select! {
            // `biased` polls the monitor first, deterministically: an
            // already-compromised lease must win the tie against a boot
            // block that finishes on its first poll (no reap targets, the
            // spawns are instant) - a random pick could run the ownership
            // actions against a successor that took the socket over.
            biased;
            () = socket_lease.wait_compromised() => {
                // The shutdown/admission flags land FIRST - client
                // handlers and owner-cleanup timers must not act on a
                // lost lease while the fence below waits out in-flight
                // boot steps - then the passes spawned so far (the
                // shared slot, registered per-spawn) are aborted, joined,
                // and the nested adoption fan-out drains before the
                // lease can drop: nothing boot-spawned outlives this
                // arm against the successor.
                self.mark_supervisor_shutting_down();
                let mut boot_tasks = std::mem::take(
                    &mut *boot_tasks_slot.lock().expect("boot task slot lock"),
                );
                self.lease_loss_fence(&mut boot_tasks).await;
                adoption_fanout.wait_drained().await;
                // The lease is consumed through its awaited SHUTDOWN, not a
                // plain drop: a drop on the Tokio worker joins the refresh
                // thread (and its up-to-350ms in-thread grace wait) right
                // there, stalling signal_drain and catalog refresh work -
                // the exact stall shutdown exists to avoid. The shutdown
                // join error surfaces in the daemon log (the compromise
                // remains the primary returned error - nothing is
                // swallowed).
                if let Err(join_error) = socket_lease.shutdown().await {
                    self.log.append(&format!(
                        "daemon socket lease shutdown join failed: {join_error:#}"
                    ));
                }
                return Err(anyhow!("daemon socket lease compromised"));
            }
            boot = boot_ownership => {
                if let Err(error) = boot {
                    // The boot block's own lease assert failed (the grace
                    // settled into a real displacement): the same loss
                    // teardown the monitor arm runs - admission closes,
                    // everything tracked is fenced, and the lease is
                    // consumed off the worker.
                    self.mark_supervisor_shutting_down();
                    let mut boot_tasks = std::mem::take(
                        &mut *boot_tasks_slot.lock().expect("boot task slot lock"),
                    );
                    self.lease_loss_fence(&mut boot_tasks).await;
                    adoption_fanout.wait_drained().await;
                    if let Err(join_error) = socket_lease.shutdown().await {
                        self.log.append(&format!(
                            "daemon socket lease shutdown join failed: {join_error:#}"
                        ));
                    }
                    return Err(error);
                }
            },
        };
        #[cfg(not(unix))]
        boot_ownership.await?;

        // The boot block completed: take the registered passes for the
        // fences below (the non-unix daemon has no lease choreography -
        // its passes stay detached exactly as before).
        #[cfg(unix)]
        let mut boot_tasks =
            std::mem::take(&mut *boot_tasks_slot.lock().expect("boot task slot lock"));
        #[cfg(not(unix))]
        drop(std::mem::take(
            &mut *boot_tasks_slot.lock().expect("boot task slot lock"),
        ));

        #[cfg(unix)]
        if let Err(error) = socket_lease.assert_held_async().await {
            // Admission closes FIRST - an adoption pass that already armed
            // detached owner-cleanup timers must not have them act after
            // this return (the boot fence below owns neither the timers
            // nor anything else already past an earlier gate) - then the
            // same fence the serving loop's compromise arm runs: the
            // spawned ownership passes must not outlive a lost lease on
            // this exit path either - aborting ALL and joining ALL (not
            // dropping the handles, which detaches) and draining the
            // nested adoption fan-out keeps none adopting or sweeping
            // against a successor while the lease's release marks land.
            self.mark_supervisor_shutting_down();
            self.lease_loss_fence(&mut boot_tasks).await;
            adoption_fanout.wait_drained().await;
            // The lease shutdown runs off the Tokio worker (the refresh
            // thread's join and its in-thread grace wait would otherwise
            // stall in-flight signal_drain and catalog work at the drop).
            // The shutdown join error surfaces in the daemon log - the
            // assertion failure remains the primary returned error.
            if let Err(join_error) = socket_lease.shutdown().await {
                self.log.append(&format!(
                    "daemon socket lease shutdown join failed: {join_error:#}"
                ));
            }
            return Err(error);
        }
        // The archive-sweep and update-prepare-watchdog passes already
        // started inside the boot-ownership block as fenceable
        // boot_tasks: a lease compromise aborts them there, so the
        // detached duplicates this block used to spawn (which no fence
        // could reach) are gone - one sweeper, one watchdog, both
        // fenced.

        // Journals without verifiable ownership and flat TS update status
        // records stay intact: a missing descriptor or a dead coordinator
        // does not prove that no worker or waiting caller still needs them.
        {
            let supervisor = Arc::clone(&self);
            tokio::task::spawn_blocking(move || {
                let leases = crate::lease::reclaim_dead_owner_leases(&supervisor.options.agent_dir);
                let logs = crate::worker_stderr::prune_socket_logs(
                    &supervisor.options.agent_dir,
                    &supervisor.options.socket_path,
                );
                let leftovers =
                    crate::ts_era::sweep_ts_era_leftovers(&supervisor.options.agent_dir);
                if leases + logs + leftovers > 0 {
                    supervisor.log_line(&format!(
                        "boot cleanup: removed {leases} dead-owner lease dir(s), {logs} old socket log(s), {leftovers} TS-era leftover(s)"
                    ));
                }
            });
        }

        // The accept loop OWNS the listener, so whichever arm ends serving
        // the listener is closed before the cleanup below probes the path:
        // a successor's live socket at the path survives even a poisoned
        // bind-time capture. On unix the lease-gated cleanup claims the
        // bound socket atomically (asserting the lease still holds), and a
        // compromised lease leaves the successor's socket untouched; the
        // lease-monitor select's compromise arm mirrors the boot fence.
        #[cfg(unix)]
        let serving = tokio::select! {
            result = accept_loop::serve(&self, listener) => {
                // The accept loop has ended - healthy, accept-error, or a
                // return racing the compromise monitor. The boot's
                // ownership passes must not outlive it: with the monitor
                // arm gone, nothing else would abort the archive sweep or
                // the restore pass if a successor takes the socket over
                // during the exit path, so the tasks die here in every
                // outcome, and a lease lost by then additionally takes
                // the same shutdown path the compromise arm runs.
                // The aborts are AWAITED: an unawaited abort leaves
                // the task's in-flight archive sweep free to move
                // session files with a stale protected-worker snapshot
                // after a successor has opened them - the lease must
                // not be releasable while any boot task still runs. The
                // shared fence aborts EVERY task first, then joins all.
                //
                // The loss verdict is sampled BEFORE the joins so the
                // shutdown/admission flags close the moment the loss is
                // known (client handlers and owner-cleanup timers must
                // not act on a lost lease while the fence waits out
                // in-flight steps), and re-sampled after (the monitor
                // arm is gone once serving ends; a loss landing inside
                // the join window is caught there and takes the same
                // shutdown path).
                // EVERY terminal serving exit closes admission FIRST - the
                // healthy accept-exhaustion exit included - and with NO
                // probe ahead of the flags: the lease sample below is
                // the ASYNC grace probe (the blocking form would sleep
                // this worker for the whole displacement grace on a
                // displaced lease, landing the flags late exactly when
                // new stops or owner-cleanup timers could still admit).
                // The fence below is a one-shot snapshot of the tracked
                // timers and passes, and a live client handler could
                // otherwise start a stop or arm a fresh timer behind it
                // while the exit flush and the lease release below run.
                let mut lease_lost = self
                    .serving_exit_closes_admission_then_samples(&socket_lease)
                    .await;
                // The fence runs in EVERY outcome - a healthy exit also
                // releases the lease, so the same timers, boot passes,
                // and in-flight stop transitions must not outlive it.
                self.lease_loss_fence(&mut boot_tasks).await;
                if !lease_lost && socket_lease.assert_held_async().await.is_err() {
                    lease_lost = true;
                    self.log.append(
                        "daemon socket lease compromised; relinquishing supervisor ownership",
                    );
                }
                if lease_lost {
                    Err(anyhow!("daemon socket lease compromised"))
                } else {
                    result
                }
            }
            () = socket_lease.wait_compromised() => {
                // The boot's ownership passes die with the lease: none may
                // adopt or restore against a successor that holds the
                // socket now. The shutdown/admission flags land FIRST -
                // handlers and owner-cleanup timers must not act on a
                // lost lease while the fence below waits - and the shared
                // fence aborts EVERY task first, then joins all, so the
                // release below cannot land while a task's archive sweep
                // is still moving files.
                self.mark_supervisor_shutting_down();
                self.lease_loss_fence(&mut boot_tasks).await;
                Err(anyhow!("daemon socket lease compromised"))
            }
        };
        #[cfg(not(unix))]
        let serving = accept_loop::serve(&self, listener).await;

        // The nested adoption fan-out drains BEFORE the socket cleanup and
        // the lease release: the awaited aborts above settle the boot
        // tasks themselves, but the adoption pass's JoinSet drop only
        // abort-FLAGS its jobs - an in-flight job step (a socket
        // connect, a relaunch spawn, an archive move in a task that
        // wrapped the pass) can still be executing after the handles
        // are joined. The drain resolves only once every job future is
        // dropped, so no adoption work outlives the fence.
        #[cfg(unix)]
        adoption_fanout.wait_drained().await;
        let expected_identity = self.bound_socket_identity.lock().unwrap().clone();
        #[cfg(unix)]
        socket_lease.cleanup_socket_path(&self.options.socket_path, expected_identity);
        #[cfg(not(unix))]
        socket::cleanup_socket_path_after_close(&self.options.socket_path, expected_identity);
        self.flush_telemetry_on_exit().await;
        // The lease's awaited shutdown runs LAST: consuming it any
        // earlier releases the socket lock while this supervisor still
        // runs, letting a successor acquire, bind, and reap this
        // live process - and the refresh thread's join (and its
        // up-to-350ms in-thread waits) runs off the async worker
        // instead of stalling every task and timer on it.
        #[cfg(unix)]
        socket_lease.shutdown().await?;
        serving
    }
}

/// One outbound client-socket line: a JSON value the connection serializes, or the
/// pre-serialized bytes of a relayed worker response.
pub(crate) enum Outbound {
    Line(Value),
    Raw(Vec<u8>),
}

/// Entry point for the supervisor process.
///
/// # Errors
///
/// Returns an error when the supervisor cannot start or its serve loop fails.
pub async fn run_supervisor(options: SupervisorOptions) -> Result<()> {
    let supervisor = Arc::new(Supervisor::new(options)?);
    supervisor.run().await
}
