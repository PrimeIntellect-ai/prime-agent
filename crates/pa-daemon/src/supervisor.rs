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
mod options;
mod routing;
mod sessions;
pub(crate) mod subscribers;
mod update_restart;
mod worker_lifecycle;

use adoption::AdoptionBoot;
use launch_budget::WORKER_AUTH_FLOOR_MS;
mod supervision;

// STABLE_LIFETIME_MS is read only by this facade's in-file test modules (via the module's
// pub(super) const); the lib-target import is flagged unused since only tests use it.
#[allow(unused_imports)]
use supervision::STABLE_LIFETIME_MS;

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
    PersistedSupervisorConfig, SUPERVISOR_CONFIG_FILE_NAME,
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
use crate::session_store::list_sessions;
use crate::snapshot_stream::{attach_client_capabilities, stream_attach, wants_chunked};
use crate::update_prepare::{
    marker_expires_at_iso, update_gate_refuses, write_prepared_artifacts, AbortOutcome,
    BeginOutcome, MutationDrainLatch, PrepareCoordinator, PrepareOp, PrepareState,
    UPDATE_PREPARING_MESSAGE,
};
use crate::update_roster::{
    build_update_roster, supervisor_identity, UpdateRosterInputs, WorkerSnapshot,
};
use crate::update_stop::{stop_workers_gracefully, WorkerStopVerdict, WORKER_REQUEST_TIMEOUT_MS};
use crate::{socket, util};

pub struct Supervisor {
    pub(crate) options: SupervisorOptions,
    descriptor_dir: PathBuf,
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
    /// In-flight registration-seed tasks (each `worker_register`'s
    /// background family walk). A `roster_subscribe` drains and awaits
    /// them before building its snapshot: a seeded row's push must
    /// never overtake the snapshot answer (a client that applies the
    /// push first and then the snapshot would lose the rows).
    pub(crate) pending_registration_seeds: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// In-flight saved-session renames (TS `pendingSessionNames`): one
    /// reservation per `[depth, parent, name]` scope, so a concurrent
    /// rename of the same name fails the second caller.
    pub(crate) pending_session_names: std::sync::Mutex<std::collections::HashSet<String>>,
    shutting_down: AtomicBool,
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
            session_bindings: crate::session_bindings::SessionBindingTable::new(),
            opening_files: std::sync::Mutex::new(std::collections::HashMap::new()),
            telemetry: std::sync::Mutex::new(None),
            registry: SessionRegistry::new(),
            events,
            session_subscribers: subscribers::SessionSubscribers::new(),
            roster: std::sync::Mutex::new(crate::agent_roster::AgentRoster::new()),
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
            compaction_journal: std::sync::Mutex::new(compaction_journal),
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

    /// Emit the live-catalog warm-up settle's `daemon event` (schema v1,
    /// kind `catalog_refresh`): the served model count, primitives only.
    fn note_catalog_refresh(&self, count: usize) {
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_catalog_refresh(client, count);
        }
    }

    /// Emit the deleted-child usage capture's `daemon event` (schema v1,
    /// kind `deleted_child_usage_captured`): source + count, primitives
    /// only.
    pub(crate) fn note_deleted_child_usage_captured(&self, source: &str, count: usize) {
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_deleted_child_usage_captured(
                client, source, count,
            );
        }
    }

    /// Emit a `daemon event` (best-effort, non-blocking; no-op when the
    /// daemon is opted out).
    pub(crate) fn note_daemon_event(&self, kind: &str, exit_reason: Option<&str>) {
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_daemon_event(client, kind, exit_reason);
        }
    }

    /// Publish one session event to the session's attached connections
    /// (the send-time delivery pass — TS `handleWorkerFrame`'s fan-out
    /// evaluates the attached set in the same pass that writes). A full
    /// queue drops the frame and the stall-cycle transition lands in the
    /// daemon log (finding 4a visibility).
    pub(crate) fn publish_session_event(&self, active_session_id: &str, payload: Arc<Value>) {
        let outcome = self.session_subscribers.publish(active_session_id, payload);
        if !outcome.lagged.is_empty() {
            self.log_line(&format!(
                "clients {} lagged on the session event queue: frames dropped (session {active_session_id})",
                outcome.lagged.join(", ")
            ));
        }
    }

    /// The abort supervision's declaration event (`daemon event` schema v1,
    /// kind `compaction_abort_declared`): one count, never session payload.
    pub(crate) fn note_compaction_abort_declared(&self) {
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_compaction_abort_declared(client);
        }
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
        // Live model catalog (both fetch layers): the supervisor process
        // keeps the disk caches warm for every worker it spawns — a forced
        // startup refresh (layer A provider catalog + the credentialed
        // Prime Inference snapshot for the logged-in account) and then the
        // hourly loop. Fire-and-forget: workers always have the
        // last-good chain (disk snapshot | bundled | compiled) and the
        // refresh only adds live pricing and catalog-repo/new entries.
        pa_core::models::startup_refresh(&self.options.agent_dir);
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
        socket::restrict_socket_path(&self.options.socket_path);
        self.log
            .append(&format!("supervisor started pid {}", std::process::id()));

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

    /// Run the one terminal stop pass, whichever connection first reaches it.
    ///
    /// The shutdown command sets `shutting_down` synchronously, but the stop
    /// pass still has to start even if its initiating client disconnects or
    /// the response write fails. `shutdown_started` is the one-owner gate:
    /// the first caller runs `begin_shutdown`; every later observer returns
    /// immediately instead of duplicating the worker stops.
    async fn ensure_shutdown_started(self: &Arc<Self>) {
        if self.shutdown_started.swap(true, Ordering::SeqCst) {
            return;
        }
        self.begin_shutdown().await;
    }

    async fn begin_shutdown(self: &Arc<Self>) {
        self.shutting_down.store(true, Ordering::SeqCst);
        for resident in self.registry.list().await {
            resident.intentional_stop.store(true, Ordering::SeqCst);
            resident.note_retired();
            // The stop tombstone persists before the worker is even told (TS
            // `stopWorkerUntracked` persists before its request): a
            // supervisor that dies between here and the worker's exit
            // leaves durable stop intent, and the next boot finishes the
            // stop instead of adopting the leftover as healthy.
            if self.persist_stop_tombstone(&resident).await.is_err() {
                self.log_line(&format!(
                    "session worker {} stop tombstone could not persist; leaving the worker untouched (the next boot retries the stop)",
                    resident.worker_id
                ));
                continue;
            }
            let _ = self
                .route_command_typed(
                    &resident,
                    "shutdown",
                    json!({}),
                    ROUTE_TIMEOUT_MS,
                    RouteAdmission::SupervisorInternal,
                )
                .await;
            self.retire_worker_after_stop(&resident).await;
        }
        self.registry.clear().await;
        // The workers are all stopped now, so the accept loop may exit;
        // setting the gate alone is not enough — an inbound connection
        // could otherwise fall the loop out mid-stop.
        self.accept_exit.store(true, Ordering::SeqCst);
        self.shutdown_notify.notify_one();
    }

    /// The OS-signal drain step (SIGTERM/SIGINT; the loop in
    /// `crate::signal_drain` runs this once per received signal): the
    /// first signal enters the graceful drain, and any later signal - or
    /// one that finds a client-command shutdown or an update restart
    /// already committed to its exit - force-exits instead.
    ///
    /// The gate flips synchronously, so from this moment every later
    /// client command is refused at the dispatch gate and every create
    /// at the launch gate; the connected clients get the same
    /// `daemon_closing` event the shutdown command broadcasts. The
    /// terminal stop pass then runs in the background
    /// ([`Self::ensure_shutdown_started`]): each resident worker gets its
    /// routed `shutdown` - the worker's handler is the flush barrier, so
    /// the in-flight turn aborts and settles before the worker exits -
    /// and a worker that misses the route gets the identity-gated
    /// SIGTERM → SIGKILL escalation instead of lingering in the
    /// supervisor-lost window.
    ///
    /// Returns `true` when this call started the drain (the signal loop
    /// keeps waiting for the force signal); `false` when a drain or exit
    /// was already in flight (the caller is the forced exit). The update
    /// restart's exit windows are guarded on both ends: a signal that
    /// finds the coordinator in `Stopping` (workers already being stopped
    /// with their descriptors kept for the successor) or `accept_exit`
    /// already published never flips the shutdown gate, so it cannot
    /// convert the descriptor-preserving update exit into a terminal
    /// stop pass.
    pub(crate) fn begin_signal_drain(self: &Arc<Self>) -> bool {
        if self.update_prepare.active_state() == Some(PrepareState::Stopping)
            || self.accept_exit.load(Ordering::SeqCst)
            || self.shutting_down.swap(true, Ordering::SeqCst)
        {
            return false;
        }
        self.log_line(
            "received shutdown signal; entering graceful drain: new client commands refused, running turns settle through the workers' routed shutdown",
        );
        let _ = self.events.send((
            ClientRouting::Broadcast,
            std::sync::Arc::new(daemon_closing_shutdown_event()),
        ));
        let supervisor = Arc::clone(self);
        tokio::spawn(async move {
            supervisor.ensure_shutdown_started().await;
        });
        true
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

/// The non-update `daemon_closing` frame (the shutdown command's and the
/// OS-signal drain's shared spelling): every connected client learns the
/// daemon is going down for a shutdown, the spelling the TUI reconnects
/// attached windows on.
fn daemon_closing_shutdown_event() -> Value {
    json!({ "type": "daemon_closing", "reason": "shutdown" })
}

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
    /// TS #2506's `serializeSavedSessionInfo`: the listing arm's bucket
    /// attach publishes `deletedDescendantUsage` on the saved row - the
    /// agents-view recursive rollup's deleted-descendant term. Absent
    /// rows (no tombstoned descendants) carry no field, matching the
    /// optional wire shape.
    #[test]
    fn saved_session_rows_publish_deleted_descendant_usage() {
        let dir = std::env::temp_dir().join(format!("pa-saved-dd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
        let path = dir.join(format!("{}.jsonl", session.session_id()));
        session.set_path(path.clone());
        session.rewrite().unwrap();
        let mut info = crate::session_store::read_session_info(&path).unwrap();
        assert!(
            info.deleted_descendant_usage.is_none(),
            "the file scan never sets the ledger-derived field"
        );
        info.deleted_descendant_usage = Some(crate::session_usage::SessionUsageSummary {
            input_tokens: 1_100,
            output_tokens: 110,
            cost: 0.5,
        });
        let row = saved_session_row(&info);
        assert_eq!(
            row["deletedDescendantUsage"],
            json!({ "inputTokens": 1_100, "outputTokens": 110, "cost": 0.5 })
        );
        // Absent again: the field never rides as a null.
        info.deleted_descendant_usage = None;
        let row = saved_session_row(&info);
        assert!(row.get("deletedDescendantUsage").is_none());
    }

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

    /// The saved-session surfaces publish the scan's own-usage summary (TS
    /// `serializeSavedSessionInfo` and `summaryForInactiveSession`): the
    /// agents-view spend columns and the archived-row keep-condition read
    /// `usage.cost`; a session with no billable work stays bare, exactly
    /// like TS's undefined serialization.
    #[test]
    fn saved_session_rows_publish_the_own_usage_summary() {
        let dir = std::env::temp_dir().join(format!("pa-saved-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
        let path = dir.join(format!("{}.jsonl", session.session_id()));
        session.set_path(path.clone());
        session.append_message(json!({
            "role": "assistant", "content": "done", "provider": "p", "model": "m",
            "timestamp": 1u64,
            "usage": {
                "input": 100, "output": 10, "cacheRead": 5, "cacheWrite": 0,
                "totalTokens": 115,
                "cost": { "input": 0.0, "output": 0.25, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.25 }
            }
        }));
        session.rewrite().unwrap();
        let info = crate::session_store::read_session_info(&path).unwrap();
        let row = saved_session_row(&info);
        assert_eq!(
            row["usage"],
            json!({ "inputTokens": 105, "outputTokens": 10, "cost": 0.25 })
        );
        let summary = saved_session_summary(&info);
        assert_eq!(
            summary["usage"],
            json!({ "inputTokens": 105, "outputTokens": 10, "cost": 0.25 })
        );
        // A draft with no billable work stays bare on both surfaces.
        let mut draft = crate::session_store::SessionFile::create("/tmp", None, 0);
        let draft_path = dir.join(format!("{}.jsonl", draft.session_id()));
        draft.set_path(draft_path.clone());
        draft.rewrite().unwrap();
        let draft_info = crate::session_store::read_session_info(&draft_path).unwrap();
        assert!(saved_session_row(&draft_info).get("usage").is_none());
        assert!(saved_session_summary(&draft_info).get("usage").is_none());
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

    /// The boot roster seed runs exactly once, in the background, once
    /// adoption settles: the adoption pass hands back the seed task's
    /// handle, and the seed roots are the registry's residents. An empty
    /// descriptor dir adopts nothing; the pre-registered root anchors the
    /// family the seed must publish.
    #[tokio::test]
    async fn adoption_settles_then_seeds_the_roster_once() {
        let dir = std::env::temp_dir().join(format!("pa-adopt-seed-{}", uuid::Uuid::new_v4()));
        let agent_dir = dir.join("agent");
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let root_file = sessions_dir.join("root-1.jsonl");
        let child_file = sessions_dir.join("sub-9.jsonl");
        for path in [&root_file, &child_file] {
            std::fs::write(
                path,
                "{\"type\":\"session\",\"version\":3,\"id\":\"persisted-id\",\"timestamp\":\"t\",\"cwd\":\"/the/real/cwd\"}\n{\"type\":\"model_change\",\"id\":\"m1\",\"parentId\":null,\"timestamp\":\"t\",\"provider\":\"p\",\"modelId\":\"m\"}\n{\"type\":\"thinking_level_change\",\"id\":\"t1\",\"parentId\":\"m1\",\"timestamp\":\"t\",\"thinkingLevel\":\"high\"}\n",
            )
            .unwrap();
        }
        let supervisor = Arc::new(
            Supervisor::new(SupervisorOptions {
                socket_path: dir.join("daemon.sock"),
                agent_dir: agent_dir.clone(),
            })
            .unwrap(),
        );
        let ledger = crate::rlm_ledger::RlmSpawnLedger::new(&agent_dir, &sessions_dir, |_| {});
        ledger
            .append_spawn(crate::rlm_ledger::RlmSpawnInput {
                child_id: "sub-9".to_string(),
                parent: root_file.to_string_lossy().to_string(),
                child: child_file.to_string_lossy().to_string(),
                depth: 1,
                name: "lane".to_string(),
            })
            .unwrap();
        let descriptor = pa_types::daemon::DaemonWorkerDescriptor {
            version: 1,
            worker_id: "w-root".to_string(),
            pid: 4242,
            process_start_id: None,
            socket_path: "/tmp/none.sock".to_string(),
            recovery_journal_path: "/tmp/none.jsonl".to_string(),
            orphan_process_journal_path: None,
            supervisor_socket_path: "/tmp/none.sock".to_string(),
            authentication_token: "root-token".to_string(),
            worker_instance_id: None,
            root_active_session_id: "w-root".to_string(),
            owner_client_id: None,
            root_session_id: None,
            session_file: Some(root_file.to_string_lossy().to_string()),
            session_dir: Some(sessions_dir.to_string_lossy().to_string()),
            telemetry_disabled: Some(true),
            created_at: "t".to_string(),
            updated_at: "t".to_string(),
            lifecycle: DaemonWorkerLifecycle::Ready,
            create_command: pa_types::daemon::DurableDaemonCreateCommand {
                session_path: None,
                no_session: None,
                rest: Map::default(),
            },
            consecutive_failures: 0,
            stop_requested_at: None,
            archive_on_stop: None,
            last_failure_at: None,
            last_error: None,
            rest: Map::default(),
        };
        supervisor
            .registry
            .insert(ResidentWorker::new(
                "w-root".to_string(),
                descriptor,
                root_file.with_extension("descriptor.json"),
            ))
            .await;

        // Adoption adopts nothing (the descriptor dir is empty) and hands
        // back the boot seed task; the seed publishes the anchored family.
        supervisor
            .adopt_persisted_workers(AdoptionBoot::PlainStartup)
            .await;
        crate::supervisor_roster_seed::tests::drain_pending_seeds_for_tests(&supervisor).await;
        let row = supervisor
            .roster
            .lock()
            .unwrap()
            .entries()
            .into_iter()
            .find(|entry| entry.summary.get("rlmChildId").and_then(Value::as_str) == Some("sub-9"))
            .expect("the boot seed hydrated the family");
        assert_eq!(row.summary["cwd"], "/the/real/cwd");
        assert_eq!(
            row.summary["model"],
            json!({ "provider": "p", "modelId": "m" })
        );
        assert_eq!(row.summary["thinkingLevel"], json!("high"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The shutdown gate: a create dispatched while the supervisor stops
    /// must fail instead of launching a worker the stop pass would miss
    /// (a late create racing a shutdown would orphan its worker process).
    #[tokio::test]
    async fn a_create_while_shutting_down_is_refused() {
        let dir = tempfile::TempDir::new().unwrap();
        let options = SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        };
        let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
        supervisor.shutting_down.store(true, Ordering::SeqCst);
        let create = DaemonCommand::Create {
            id: None,
            session_path: None,
            continue_recent: None,
            no_session: None,
            name: None,
            config: None,
            telemetry_disabled: None,
            runtime_metadata: None,
            lifecycle: None,
            env: None,
            launch_env: None,
            rest: Map::default(),
        };
        let refused = supervisor
            .launch_worker(&create, None)
            .await
            .err()
            .expect("the shutting-down supervisor accepted a create");
        assert_eq!(
            refused.to_string(),
            "Supervisor is shutting down",
            "the refusal error: {refused:#}"
        );
    }

    /// The shutdown gate and the accept loop's exit flag are separate: the
    /// gate refuses creates the moment a terminal stop begins, but the
    /// loop must stay up until `begin_shutdown` finishes stopping the workers.
    #[tokio::test]
    async fn begin_shutdown_sets_the_accept_exit_after_the_stop_pass() {
        let dir = tempfile::TempDir::new().unwrap();
        let options = SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        };
        let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
        supervisor.shutting_down.store(true, Ordering::SeqCst);
        assert!(
            !supervisor.accept_exit.load(Ordering::SeqCst),
            "the gate alone must not exit the accept loop"
        );
        supervisor.begin_shutdown().await;
        assert!(
            supervisor.accept_exit.load(Ordering::SeqCst),
            "the completed stop pass must exit the accept loop"
        );
    }

    /// A kill whose stop never durably started — the stop tombstone's
    /// persist fails, the only `Err` `stop_worker` takes — must not run
    /// the kill's belt: the worker is untouched and the kill stays
    /// retryable (TS `stopWorkerUntracked` throws before any teardown).
    /// The belt otherwise cancels the session tree's jobs, archives the
    /// root file, and — for a ledger delete — sweeps the child's
    /// artifacts against a live worker whose resident still serves the
    /// file (its stores may still grow).
    #[tokio::test]
    async fn a_failed_stop_persist_gates_the_kill_stop_belt() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let session_file = sessions_dir.join("live-1.jsonl");
        std::fs::write(
            &session_file,
            "{\"type\":\"session\",\"version\":3,\"id\":\"live-1\",\"timestamp\":\"t\",\"cwd\":\"/c\"}\n",
        )
        .unwrap();
        // The live child's artifact partition: a ledger delete's belt
        // would sweep it; the gated belt must leave it in place.
        let artifacts = agent_dir.join("session-artifacts").join("live-1");
        std::fs::create_dir_all(&artifacts).unwrap();
        std::fs::write(artifacts.join("scheduled-jobs.json"), "{}").unwrap();
        let supervisor = Arc::new(
            Supervisor::new(SupervisorOptions {
                socket_path: dir.path().join("daemon.sock"),
                agent_dir: agent_dir.clone(),
            })
            .expect("supervisor"),
        );
        let descriptor = pa_types::daemon::DaemonWorkerDescriptor {
            version: 1,
            worker_id: "w-live".to_string(),
            pid: 4242,
            process_start_id: None,
            socket_path: "/tmp/none.sock".to_string(),
            recovery_journal_path: "/tmp/none.jsonl".to_string(),
            orphan_process_journal_path: None,
            supervisor_socket_path: "/tmp/none.sock".to_string(),
            authentication_token: "token".to_string(),
            worker_instance_id: None,
            root_active_session_id: "w-live".to_string(),
            owner_client_id: None,
            root_session_id: Some("live-1".to_string()),
            session_file: Some(session_file.to_string_lossy().to_string()),
            session_dir: Some(sessions_dir.to_string_lossy().to_string()),
            telemetry_disabled: None,
            created_at: "t".to_string(),
            updated_at: "t".to_string(),
            lifecycle: DaemonWorkerLifecycle::Ready,
            create_command: pa_types::daemon::DurableDaemonCreateCommand {
                session_path: None,
                no_session: None,
                rest: Map::default(),
            },
            consecutive_failures: 0,
            stop_requested_at: None,
            archive_on_stop: None,
            last_failure_at: None,
            last_error: None,
            rest: Map::default(),
        };
        // The persist target is a directory: the stop tombstone's
        // atomic write cannot land there (the rename onto a directory
        // fails), so the stop never durably starts.
        let persist_target = sessions_dir.join("w.d");
        std::fs::create_dir(&persist_target).unwrap();
        let resident = ResidentWorker::new("w-live".to_string(), descriptor, persist_target);
        supervisor.registry.insert(resident.clone()).await;

        // A ledger-delete kill (delete_subagent's shape: the rest carries
        // the marker, so the plain-kill path owns it).
        let rest = Map::from_iter([
            ("rlmLedgerDelete".to_string(), json!("user")),
            ("rlmChildId".to_string(), json!("child-1")),
        ]);
        supervisor.finish_plain_kill_stop(&resident, &rest).await;

        // The stop never started: the resident stays owned (retryable)
        // and the live child's artifacts survive the belt.
        assert!(
            supervisor.registry.get("w-live").await.is_some(),
            "the stop never durably started, so the worker stays owned"
        );
        assert!(
            artifacts.join("scheduled-jobs.json").is_file(),
            "a belt gated behind a failed stop must not sweep a live child's artifacts"
        );
    }

    /// A plain kill holds the route-side tombstone when its stop's
    /// redundant re-write fails: the durable intent is already on disk,
    /// so the stop proceeds (the escalation runs, the registry row goes,
    /// the stop is intentional) instead of aborting and leaving the
    /// killed worker running on its session lease until the next boot —
    /// the finding-#5 symptom. The belt gate stays keyed on the stop
    /// that never durably started: no tombstone at all still fails.
    #[tokio::test]
    async fn an_existing_tombstone_carries_the_stop_past_its_failed_re_write() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let supervisor = Arc::new(
            Supervisor::new(SupervisorOptions {
                socket_path: dir.path().join("daemon.sock"),
                agent_dir: agent_dir.clone(),
            })
            .expect("supervisor"),
        );
        let descriptor = pa_types::daemon::DaemonWorkerDescriptor {
            version: 1,
            worker_id: "w-live".to_string(),
            pid: 4242,
            process_start_id: None,
            socket_path: "/tmp/none.sock".to_string(),
            recovery_journal_path: "/tmp/none.jsonl".to_string(),
            orphan_process_journal_path: None,
            supervisor_socket_path: "/tmp/none.sock".to_string(),
            authentication_token: "token".to_string(),
            worker_instance_id: None,
            root_active_session_id: "w-live".to_string(),
            owner_client_id: None,
            root_session_id: Some("live-1".to_string()),
            session_file: None,
            session_dir: Some(sessions_dir.to_string_lossy().to_string()),
            telemetry_disabled: None,
            created_at: "t".to_string(),
            updated_at: "t".to_string(),
            lifecycle: DaemonWorkerLifecycle::Ready,
            create_command: pa_types::daemon::DurableDaemonCreateCommand {
                session_path: None,
                no_session: None,
                rest: Map::default(),
            },
            consecutive_failures: 0,
            // The route-side tombstone the plain kill's pre-route persist
            // wrote before the forward.
            stop_requested_at: Some("2026-09-26T00:00:00Z".to_string()),
            archive_on_stop: Some(true),
            last_failure_at: None,
            last_error: None,
            rest: Map::default(),
        };
        // The persist target is a directory: the tombstone's redundant
        // re-write fails (the rename onto a directory cannot land).
        let persist_target = sessions_dir.join("w.d");
        std::fs::create_dir(&persist_target).unwrap();
        let resident = ResidentWorker::new("w-live".to_string(), descriptor, persist_target);
        supervisor.registry.insert(resident.clone()).await;

        supervisor
            .stop_worker(&resident)
            .await
            .expect("the durable tombstone must carry the stop past its failed re-write");

        assert!(
            supervisor.registry.get("w-live").await.is_none(),
            "the stop completed: the worker left the registry"
        );
        assert!(
            resident.intentional_stop.load(Ordering::SeqCst),
            "the stop is intentional"
        );
    }

    /// The first OS signal's drain: the gate rejects new work, every
    /// client gets the `daemon_closing` event, and the running turn
    /// settles inside its worker's routed `shutdown` before the stop
    /// pass retires the worker (descriptor gone - no supervisor-lost
    /// lingering) and lets the accept loop exit. The fake worker holds
    /// its `shutdown` reply on a test-controlled settle, so a pass that
    /// does not wait for the flush barrier fails the assertions below.
    #[tokio::test]
    async fn first_signal_drains_a_settling_turn_and_rejects_new_work() {
        let dir = tempfile::TempDir::new().unwrap();
        let options = SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        };
        let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
        let descriptor: DaemonWorkerDescriptor = serde_json::from_value(serde_json::json!({
            "version": 2,
            "workerId": "w-signal",
            "pid": 0,
            "socketPath": "/tmp/none.sock",
            "recoveryJournalPath": "/tmp/none.jsonl",
            "supervisorSocketPath": "/tmp/none.sock",
            "authenticationToken": "test",
            "rootActiveSessionId": "w-signal",
            "createdAt": "t",
            "updatedAt": "t",
            "lifecycle": "ready",
            "createCommand": {},
            "consecutiveFailures": 0,
        }))
        .expect("descriptor");
        let descriptor_dir = dir.path().join("descriptors");
        std::fs::create_dir_all(&descriptor_dir).unwrap();
        let descriptor_path = descriptor_dir.join("w-signal.descriptor.json");
        let resident = Arc::new(ResidentWorker::new(
            "w-signal".to_string(),
            descriptor,
            descriptor_path.clone(),
        ));
        // The fake worker connection: the routed `shutdown` reply is the
        // flush barrier, so it is held until the test releases the turn's
        // settle.
        // The bounded command-channel type (the backpressure lane's
        // request-path bound): one slot is plenty for the single routed
        // `shutdown`.
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<WorkerRequest>(1);
        *resident.cmd_tx.lock().await = Some(cmd_tx);
        let (shutdown_routed_tx, shutdown_routed_rx) = oneshot::channel::<()>();
        let (turn_settled_tx, turn_settled_rx) = oneshot::channel::<()>();
        let (settle_release_tx, settle_release_rx) = oneshot::channel::<()>();
        let pump_resident = Arc::clone(&resident);
        let pump = tokio::spawn(async move {
            let request = cmd_rx.recv().await.expect("the drain routes a command");
            assert_eq!(request.command_type, "shutdown");
            let _ = shutdown_routed_tx.send(());
            settle_release_rx.await.expect("the turn settles first");
            let _ = turn_settled_tx.send(());
            let reply = pump_resident
                .pending
                .lock()
                .await
                .remove(&request.request_id)
                .expect("the routed shutdown holds a reply slot");
            let _ = reply.send(WorkerReply::Typed(crate::protocol::response_success(
                None, "shutdown", None,
            )));
        });
        supervisor.registry.insert(Arc::clone(&resident)).await;
        let mut events = supervisor.events.subscribe();
        let create = DaemonCommand::Create {
            id: None,
            session_path: None,
            continue_recent: None,
            no_session: None,
            name: None,
            config: None,
            telemetry_disabled: None,
            runtime_metadata: None,
            lifecycle: None,
            env: None,
            launch_env: None,
            rest: Map::default(),
        };
        assert!(
            supervisor.begin_signal_drain(),
            "the first signal must start the drain"
        );
        let refused = supervisor
            .launch_worker(&create, None)
            .await
            .err()
            .expect("a create during the drain must be rejected");
        assert_eq!(
            refused.to_string(),
            "Supervisor is shutting down",
            "the refusal error: {refused:#}"
        );
        let (routing, closing) = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .expect("the drain broadcasts daemon_closing")
            .expect("the events channel stays open");
        assert!(
            matches!(routing, ClientRouting::Broadcast),
            "every client learns the closing"
        );
        assert_eq!(
            *closing,
            json!({ "type": "daemon_closing", "reason": "shutdown" })
        );
        tokio::time::timeout(Duration::from_secs(2), shutdown_routed_rx)
            .await
            .expect("the drain routes the worker's shutdown")
            .expect("the routed channel stays open");
        // While the settle is held the pass can never finish (the routed
        // reply is the flush barrier), so assert it stays unexited across
        // a polled window: a fire-and-forget drain that retired the
        // worker early fails here deterministically, not on one fixed
        // sleep.
        let hold_deadline = std::time::Instant::now() + Duration::from_millis(100);
        while std::time::Instant::now() < hold_deadline {
            assert!(
                !supervisor.accept_exit.load(Ordering::SeqCst),
                "the stop pass must wait for the settling turn"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let _ = settle_release_tx.send(());
        tokio::time::timeout(Duration::from_secs(2), turn_settled_rx)
            .await
            .expect("the turn settles within the drain")
            .expect("the settle channel stays open");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !supervisor.accept_exit.load(Ordering::SeqCst) {
            assert!(
                std::time::Instant::now() < deadline,
                "the completed stop pass must exit the accept loop"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            supervisor.registry.list().await.is_empty(),
            "the drained worker leaves the registry"
        );
        assert!(
            !descriptor_path.exists(),
            "the drained worker's descriptor is retired with it"
        );
        assert!(
            !supervisor.begin_signal_drain(),
            "a second signal while shutting down forces"
        );
        pump.abort();
    }

    /// Every signal that finds a shutdown already in flight is the force
    /// request: the drain's own second signal, a signal racing the
    /// shutdown command's gate, and a signal racing an update exit - the
    /// last without flipping the gate, so the update's
    /// descriptor-preserving exit never becomes a terminal stop pass.
    #[tokio::test]
    async fn a_signal_during_an_in_flight_shutdown_forces() {
        let dir = tempfile::TempDir::new().unwrap();
        let options = SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        };
        let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
        assert!(
            supervisor.begin_signal_drain(),
            "the first signal starts the drain"
        );
        assert!(
            !supervisor.begin_signal_drain(),
            "the second signal forces the exit"
        );

        // A client-command shutdown already flipped the gate: a signal
        // racing it forces.
        let dir = tempfile::TempDir::new().unwrap();
        let options = SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        };
        let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
        supervisor.shutting_down.store(true, Ordering::SeqCst);
        assert!(
            !supervisor.begin_signal_drain(),
            "a signal racing the shutdown command forces"
        );

        // An update exit published accept_exit before the gate: the
        // signal forces without flipping the gate.
        let dir = tempfile::TempDir::new().unwrap();
        let options = SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        };
        let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
        supervisor.accept_exit.store(true, Ordering::SeqCst);
        assert!(
            !supervisor.begin_signal_drain(),
            "a signal racing the update exit forces"
        );
        assert!(
            !supervisor.shutting_down.load(Ordering::SeqCst),
            "the update exit must not become a terminal stop pass"
        );

        // The update's committed stop window (the coordinator's Stopping
        // state, before exit_for_update publishes accept_exit): a signal
        // forces without flipping the gate, so the terminal pass can never
        // tombstone and delete the descriptors the successor must adopt.
        let dir = tempfile::TempDir::new().unwrap();
        let options = SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        };
        let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
        let update_id = UpdateId::from("u-signal".to_string());
        let budget = UpdateTimeoutBudget::from_env();
        supervisor
            .update_prepare
            .begin(update_id.clone(), util::now_ms(), &budget);
        supervisor.update_prepare.drain_complete(&update_id);
        supervisor
            .update_prepare
            .snapshot_written(&update_id, util::now_ms(), &budget);
        supervisor.update_prepare.prepare_acked(&update_id);
        supervisor.update_prepare.commit(&update_id);
        assert_eq!(
            supervisor.update_prepare.active_state(),
            Some(PrepareState::Stopping),
            "the transaction reached the committed stop window"
        );
        assert!(
            !supervisor.begin_signal_drain(),
            "a signal racing the committed update stop forces"
        );
        assert!(
            !supervisor.shutting_down.load(Ordering::SeqCst),
            "the committed update stop must not become a terminal stop pass"
        );
    }
}
