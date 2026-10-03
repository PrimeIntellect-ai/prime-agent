//! Supervisor runtime: one process spawning one worker per active session.
//!
//! Port of `modes/daemon/daemon-supervisor.ts`: the supervisor hosts no sessions
//! itself. Clients connect over a JSONL Unix socket; the supervisor spawns a
//! dedicated worker process per session, supervises it (restart with
//! exponential backoff, bounded attempts), persists worker descriptors so a
//! restarted supervisor can adopt or relaunch live sessions, and routes
//! commands and events between clients and workers (private-framed channel).

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
// The daemon-closing shutdown event is called only by the clients sibling
// module (through its `use super::*` glob) - the facade's own calls moved out
// with the clients concern (SS2-R2) and the signals concern (SS6) - so the
// lib-target import is flagged unused without the allow.
#[allow(unused_imports)]
use signals_shutdown::daemon_closing_shutdown_event;
mod supervision;

#[cfg(test)]
mod handshake_tests;
#[cfg(test)]
mod spawn_record_tests;
#[cfg(test)]
mod tests;

// STABLE_LIFETIME_MS is read only by this facade's in-file test modules (via the module's
// pub(super) const); the lib-target import is flagged unused since only tests use it.
#[allow(unused_imports)]
use supervision::{MAX_CONSECUTIVE_FAILURES, STABLE_LIFETIME_MS};

// The saved-session row builders are read only by this facade's in-file test
// modules (via the module's pub(super) fns); the lib-target import is flagged
// unused since only tests use it.
#[allow(unused_imports)]
use sessions::{saved_session_row, saved_session_summary};

pub(crate) use options::ClientRouting;
pub use options::SupervisorOptions;

// The salvage/streaming helpers are called only by the routing and clients sibling modules (through their `use super::*` globs); the facade's own dispatch arm moved with the clients concern (SS2-R2), so the lib-target import is flagged unused without the allow.
#[allow(unused_imports)]
use update_restart::{salvage_command_type, salvage_id, streamed_attach_lines};

pub(crate) use clients::client_command_payload;

// The routing consts and refusal string keep their crate::supervisor::* paths stable
// (external callers: supervisor_parent_death, create_reuse, prompt_admission, update_restore).
pub(crate) use routing::{LONG_ROUTE_TIMEOUT_MS, ROUTE_TIMEOUT_MS, WORKER_NOT_CONNECTED};

// probe_worker_socket/worker_connect_deadline are called only by the supervision sibling
// module and this facade's in-file tests (through the module's pub(super) fns); the
// lib-target import is flagged unused otherwise.
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
    command_active_session_id, command_type_name, current_protocol_info,
    default_server_capabilities, parse_supervisor_command_line, response_failure, response_line,
    response_success, DaemonResponse, DaemonRuntimeIdentity, EnvelopeParseError,
    TypedCreateRejection, DAEMON_APP_VERSION, DAEMON_SCHEMA_ID, DAEMON_SCHEMA_REVISION,
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
    /// Per-session-file single-flight for opens (TS `openingWorkers`):
    /// one open at a time per file, so a concurrent create reuses (or
    /// waits out) the first one's worker instead of launching over it
    /// and losing the runtime session lease. Owned by the create-reuse
    /// seam (`create_reuse.rs`).
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
    /// Worker outbound frames, with their client routing. The payload is
    /// shared (`Arc`): every connected client's event arm receives every
    /// frame to decide delivery, and a per-receiver deep `Value` clone
    /// would multiply the frame's heap by the connection count on every
    /// event — the refcount bump is the whole cost for non-matching
    /// connections.
    pub(crate) events: broadcast::Sender<(ClientRouting, std::sync::Arc<Value>)>,
    /// Session-event subscribers: the send-time routing index (TS parity —
    /// `handleWorkerFrame` evaluates the attached set in the same pass that
    /// writes the socket). Session events enqueue to the attached
    /// connections' per-connection queues here instead of waking every
    /// connection's ring arm; broadcast-class events keep the ring above.
    pub(crate) session_subscribers: subscribers::SessionSubscribers,
    /// The supervisor's agent roster (classified entries; the roster arms
    /// live in `supervisor_roster.rs`).
    pub(crate) roster: std::sync::Mutex<crate::agent_roster::AgentRoster>,
    /// The last `roster_update` content published per agent id (the
    /// content-diff guard, TS #2481): an entry whose content equals its
    /// last published form is dropped from the push (an identical
    /// rewrite broadcasts nothing), so subscribers never re-apply (and
    /// the wire never re-ships) a row that did not change.
    pub(crate) last_published_roster:
        std::sync::Mutex<std::collections::HashMap<String, serde_json::Value>>,
    /// In-flight registration-seed tasks (each `worker_register`'s
    /// background family walk). A `roster_subscribe` drains and awaits
    /// them before building its snapshot: a seeded row's push must
    /// never overtake the snapshot answer (a client that applies the
    /// push first and then the snapshot would lose the rows).
    pub(crate) pending_registration_seeds: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// In-flight name reservations (TS `pendingSessionNames`): one
    /// reservation per `[depth, parent, name]` scope, shared by the
    /// saved-session rename ladder and the subagent spawn admission (TS
    /// #2396 `createRlmSubagentRuntime`), so a concurrent rename or spawn
    /// of the same name in the same scope fails the second caller.
    pub(crate) pending_session_names: std::sync::Mutex<std::collections::HashSet<String>>,
    pub(crate) shutting_down: AtomicBool,
    /// Whether some path has taken ownership of the one terminal stop pass.
    /// `shutting_down` flips synchronously when the shutdown command is
    /// accepted; this flag ensures exactly one connection runs
    /// `begin_shutdown`, even if several clients notice the shutdown.
    shutdown_started: AtomicBool,
    /// The connection that accepted the one terminal shutdown request. Only
    /// this connection may run the stop pass from its response-write or
    /// disconnect paths; another client disconnecting in the response window
    /// cannot preempt the acknowledgement or turn an update restart into a
    /// terminal worker-descriptor sweep.
    shutdown_owner: std::sync::Mutex<Option<String>>,
    /// The accept loop's exit flag. `shutting_down` refuses new work the
    /// moment a terminal stop begins, but the loop itself must stay up
    /// until [`Supervisor::begin_shutdown`] has stopped every resident
    /// worker: an inbound connection must not fall it out mid-stop and
    /// orphan the workers that pass is still shutting down.
    accept_exit: AtomicBool,
    /// Wakes the accept loop when [`Supervisor::begin_shutdown`] sets
    /// [`Self::accept_exit`]: a listening socket blocks in `accept` until
    /// a client connects, so the completed shutdown must interrupt it for
    /// the process to exit.
    shutdown_notify: tokio::sync::Notify,
    log: paths::RotatingLog,
    /// Memoized ledger over the default sessions dir (ledgers are per
    /// sessions-dir families; another dir gets a fresh instance).
    rlm_ledger: tokio::sync::Mutex<Option<std::sync::Arc<crate::rlm_ledger::RlmSpawnLedger>>>,
    /// The update-prepare transaction: at most one per supervisor;
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
    /// The supervisor-side passive scheduled-jobs snapshot the catalog
    /// READ paths serve (TS #2487 `passiveScheduledJobs`): the
    /// session-artifacts tree scans once per generation instead of once
    /// per request. Daemon-owned mutations (and the saved-session
    /// delete/rename paths) drop it through
    /// `invalidate_passive_catalog`; a served snapshot older than the
    /// refresh window re-scans in the background
    /// (stale-while-revalidate). The mutation arms keep the fresh scan
    /// (TS `collectPassiveScheduledJobs` durable truth).
    pub(crate) passive_catalog:
        std::sync::Mutex<Option<crate::scheduling_catalog::PassiveCatalogSnapshot>>,
    /// One passive-catalog scan at a time (TS
    /// `passiveScheduledJobsScan ??=`): concurrent cold reads share one
    /// in-flight scan instead of each enqueueing its own.
    pub(crate) passive_scan_gate: tokio::sync::Mutex<()>,
    /// A stale refresh is already queued (TS `??=`'s one in-flight scan):
    /// readers that arrive while the background refresh runs share it
    /// instead of each spawning another refresh task.
    pub(crate) passive_scan_pending: std::sync::atomic::AtomicBool,
    /// The passive snapshot's publish epoch (TS #2487
    /// `passiveScheduledJobsEpoch`): an invalidation claims a newer epoch,
    /// so a scan that raced the invalidation cannot republish its
    /// pre-mutation rows as a fresh snapshot.
    pub(crate) passive_catalog_epoch: std::sync::atomic::AtomicU64,
    /// The terminal-compaction journal (the abort supervision): the
    /// supervisor's own durable record of compactions it declared aborted
    /// when the worker could not answer — feeds the replacement-worker
    /// create replay, cleared by a `compaction_end` that did land.
    pub(crate) compaction_journal:
        std::sync::Mutex<crate::compaction_supervision::TerminalCompactionJournal>,
}

impl Supervisor {
    /// Build the supervisor: the descriptor dir, the persisted config,
    /// the event channel, the log, and the compaction-supervision
    /// journal.
    ///
    /// # Errors
    ///
    /// Returns an error when the descriptor directory cannot be created,
    /// the sessions dir cannot be resolved, the supervisor config
    /// cannot be persisted, or the compaction-supervision journal cannot
    /// be opened.
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
        })
    }

    /// Bind the client socket, adopt or relaunch persisted workers, serve.
    ///
    /// # Errors
    ///
    /// Returns an error when the socket path cannot be prepared (already
    /// in use), the supervisor socket cannot be bound, or the accept
    /// loop exhausts its give-up budget on a permanently broken
    /// listener (transient accept errors are retried; see `accept_loop`).
    ///
    /// # Panics
    ///
    /// Panics when the telemetry mutex is poisoned (a holder panicked
    /// while holding the lock).
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
        // Live model catalog (both fetch layers): the supervisor process
        // keeps the disk caches warm for every worker it spawns — a forced
        // startup refresh (layer A provider catalog + the credentialed
        // Prime Inference snapshot for the logged-in account) and then the
        // hourly loop. Fire-and-forget: workers always have the
        // last-good chain (disk snapshot | bundled | compiled) and the
        // refresh only adds live pricing and catalog-repo/new entries.
        let _ = pa_core::models::startup_refresh(&self.options.agent_dir);
        pa_core::models::spawn_hourly_refresh(&self.options.agent_dir);
        // The plugins service catalog's keep-warm (the `/mcp` view's remote
        // catalog): the same supervisor-owned cadence — a forced startup
        // refresh plus the hourly loop, fire-and-forget, failures keep the
        // last-good disk cache (the packaged bundled snapshot serves
        // until the first fetch lands).
        pa_core::mcp::startup_plugins_refresh(&self.options.agent_dir);
        pa_core::mcp::spawn_hourly_plugins_refresh(&self.options.agent_dir);
        // Adoption telemetry for the wiring: one `daemon event` (kind
        // `catalog_refresh`) when the startup refresh settles — the
        // served model count, primitives only. The awaited refresh is
        // gated, so it coalesces with the startup refresh's in-flight
        // fetches instead of refetching.
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
        socket::prepare_socket_path(&self.options.socket_path).await?;
        let listener = bind_transport(&self.options.socket_path)
            .await
            .with_context(|| {
                format!(
                    "bind supervisor socket {}",
                    self.options.socket_path.display()
                )
            })?;
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

        // The OS-signal drain (SIGTERM/SIGINT; the loop lives in
        // `crate::signal_drain`): `install` registers the handlers
        // synchronously here - before the boot passes below and their
        // first await - so no signal can land with the default disposition
        // still active. From here on, the first signal drains (new work
        // refused, running turns settled) and a later signal force-exits.
        tokio::spawn(crate::signal_drain::install(Arc::clone(&self)));

        // The boot reap (the operator's same-socket predecessor rule): this
        // daemon now owns the socket's lineage, so leftover worker processes
        // of a dead predecessor - alive, still holding their runtime session
        // leases, unreachable through any descriptor or registration - die
        // here, and a wedged predecessor supervisor dies with them. Daemons
        // and workers on OTHER sockets are never touched (the scan matches
        // the socket path alone). The reap precedes the adoption pass and
        // the first client: a create racing a leftover holder would answer
        // the lease refusal this pass exists to clear. Bounded by
        // construction (every target shares one escalation window).
        crate::boot_reap::reap_predecessors(&self).await;

        // Update boot (spec §6): consume the roster from the spawn env
        // BEFORE the sweep deletes the file it points at, sweep this
        // socket's update scratch dir unconditionally (invariant I2 by
        // construction), then run the restore + re-arm pass concurrently
        // with serving — the accept loop must keep serving hellos so
        // reconnecting clients see the resume contract (§10.3).
        let roster = crate::update_restore::consume_roster_env();
        self.restore.begin(roster.as_ref());
        crate::update_restore::boot_sweep(&self.options.agent_dir, &self.options.socket_path);
        // Descriptor adoption runs concurrently with the accept loop: a
        // supervisor restarted over live sessions must accept their
        // self-registrations immediately, not behind the whole descriptor
        // scan. The fan-out is capped (recovery_pacing) so a large
        // sessions dir cannot starve the control plane. The restore pass
        // awaits this task (spec §6 step 2's create-or-adopt order: kept
        // workers relaunch from their descriptors first, the roster covers
        // the rest).
        let adoption = {
            let supervisor = Arc::clone(&self);
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
                supervisor.adopt_persisted_workers(boot).await;
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

        accept_loop::serve(&self, &*listener).await?;
        socket::cleanup_socket_path(
            &self.options.socket_path,
            self.bound_socket_identity.lock().unwrap().clone(),
        );
        self.flush_telemetry_on_exit().await;
        Ok(())
    }
}

/// One outbound client-socket line: a JSON value the connection serializes,
/// or the pre-serialized bytes of a relayed worker response (the zero-copy
/// route hands the worker's own line through with the client's command id
/// spliced in front).
pub(crate) enum Outbound {
    Line(Value),
    Raw(Vec<u8>),
}

/// Entry point for the supervisor process.
///
/// # Errors
///
/// Returns an error when the supervisor cannot start (see
/// [`Supervisor::new`]) or its serve loop fails (see
/// [`Supervisor::run`]).
pub async fn run_supervisor(options: SupervisorOptions) -> Result<()> {
    let supervisor = Arc::new(Supervisor::new(options)?);
    supervisor.run().await
}
