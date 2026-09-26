//! Supervisor runtime: one process spawning one worker per active session.
//!
//! Port of `modes/daemon/daemon-supervisor.ts`: the supervisor hosts no sessions
//! itself. Clients connect over a JSONL Unix socket; the supervisor spawns a
//! dedicated worker process per session, supervises it (restart with
//! exponential backoff, bounded attempts), persists worker descriptors so a
//! restarted supervisor can adopt or relaunch live sessions, and routes
//! commands and events between clients and workers (private-framed channel).

mod adoption;
mod launch_budget;
mod options;

use adoption::{AdoptionBoot, AdoptionOutcome};
use launch_budget::{
    DEFAULT_WORKER_CONNECT_TIMEOUT_MS, WORKER_AUTH_FLOOR_MS, WORKER_CONNECT_BACKOFF_MS,
    WORKER_CONNECT_PROBE_MS, WORKER_CONNECT_TIMEOUT_ENV,
};
mod supervision;

// STABLE_LIFETIME_MS is read only by this facade's in-file test modules (via the module's
// pub(super) const); the lib-target import is flagged unused since only tests use it.
#[allow(unused_imports)]
use supervision::STABLE_LIFETIME_MS;

pub(crate) use options::ClientRouting;
pub use options::SupervisorOptions;

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
use crate::lease::is_process_alive;
use crate::paths;
use crate::prompt_admission::input_admission_id;
use crate::protocol::{
    command_active_session_id, command_type_name, current_protocol_info,
    default_server_capabilities, parse_supervisor_command_line, response_failure, response_line,
    response_success, DaemonResponse, DaemonRuntimeIdentity, EnvelopeParseError,
    TypedCreateRejection, DAEMON_APP_VERSION, DAEMON_SCHEMA_ID, DAEMON_SCHEMA_REVISION,
};
use crate::registry::{ResidentWorker, SessionRegistry, WorkerRegistration, WorkerRequest};
use crate::session_store::list_sessions;
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

pub(crate) const ROUTE_TIMEOUT_MS: u64 = 30_000;
/// The route failure for a worker whose command channel is gone (never
/// connected, or the writer pump broke on a dead socket): the request did
/// not leave the supervisor, so the replacement-aware route may retry it
/// against the next connection without risking a duplicate landing.
pub(crate) const WORKER_NOT_CONNECTED: &str = "Session worker is not connected";

/// Resolve a pending request whose frame provably never reached the worker
/// (a failed frame write, or a request still queued when the writer pump
/// ended) with the not-connected failure: `route_command` surfaces it as
/// the unambiguous retryable error, never as an ambiguous timeout.
async fn fail_unsent_request(resident: &Arc<ResidentWorker>, request_id: &str) {
    if let Some(reply) = resident.pending.lock().await.remove(request_id) {
        let _ = reply.send(response_failure(
            Some(request_id),
            "route",
            WORKER_NOT_CONNECTED,
            None,
        ));
    }
}
pub(crate) const LONG_ROUTE_TIMEOUT_MS: u64 = 600_000;

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
    /// Worker outbound frames, with their client routing.
    pub(crate) events: broadcast::Sender<(ClientRouting, Value)>,
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
        let (events, _) = broadcast::channel(4096);
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

    /// Record one session binding (the stale-id rebind table). A supersede
    /// (a new worker taking over a session file another id was bound to)
    /// notifies the clients still attached to the superseded id through the
    /// `session_binding` event, so they re-attach to the session's current
    /// id and keep receiving its events.
    fn record_session_binding(
        &self,
        active_session_id: &str,
        session_id: Option<&str>,
        session_file: Option<&str>,
    ) {
        if let Some((previous_ids, binding)) =
            self.session_bindings
                .record(active_session_id, session_id, session_file)
        {
            for previous in previous_ids {
                self.log_line(&format!(
                    "session binding superseded: {previous} -> {} (file {:?})",
                    binding.active_session_id, binding.session_file
                ));
                let event = json!({
                    "type": "session_binding",
                    "previousActiveSessionId": previous,
                    "activeSessionId": binding.active_session_id,
                    "sessionId": binding.session_id,
                    "sessionFile": binding.session_file,
                });
                let _ = self.events.send((
                    ClientRouting::AttachedSession {
                        active_session_id: previous,
                    },
                    event,
                ));
            }
        }
    }

    /// Retarget one connection at a session's current resident after its
    /// selector was superseded (the stale-active-id rebind seam shared by
    /// the generic route and the admission route). The connection keeps
    /// exactly its prior attached-ness under the current id, and a
    /// previously-attached client is told where it now points through a
    /// `session_binding` frame routed to the id it now holds - the
    /// supersede-time notice raced the attach roster, so this one cannot
    /// be dropped. A Detach never reaches the rebind: the seam answers it
    /// supervisor-side (the stale worker is gone, and the replacement's
    /// attach must not be dropped). Returns the current id the routed
    /// frame must carry.
    pub(crate) async fn rebind_connection(
        &self,
        selector: &str,
        resident: &Arc<ResidentWorker>,
        attached: &Arc<std::sync::Mutex<Vec<String>>>,
    ) -> String {
        let current = resident.worker_id.clone();
        self.log_line(&format!(
            "rebinding stale session id {selector} -> {current}"
        ));
        self.note_daemon_event("session_rebound", None);
        let was_attached = {
            let mut attached = attached.lock().unwrap();
            let was = attached.iter().any(|id| id == selector);
            if was {
                attached.retain(|id| id != selector);
                if !attached.iter().any(|id| id == &current) {
                    attached.push(current.clone());
                }
            }
            was
        };
        if was_attached {
            let (session_id, session_file) = {
                let descriptor = resident.descriptor.lock().await;
                (
                    descriptor.root_session_id.clone(),
                    descriptor.session_file.clone(),
                )
            };
            let _ = self.events.send((
                ClientRouting::AttachedSession {
                    active_session_id: current.clone(),
                },
                json!({
                    "type": "session_binding",
                    "previousActiveSessionId": selector,
                    "activeSessionId": current,
                    "sessionId": session_id,
                    "sessionFile": session_file,
                }),
            ));
        }
        current
    }

    /// The current resident a superseded selector rebinds to (the
    /// stale-id rebind seam): the binding table maps the selector to its
    /// session's durable identity, the registry's live roster holds the
    /// resident that identity currently belongs to. `None` keeps the
    /// unknown-selector failure - only a binding whose session has a live
    /// resident rebinds.
    pub(crate) async fn binding_target(&self, selector: &str) -> Option<Arc<ResidentWorker>> {
        let binding = self.session_bindings.binding_for(selector)?;
        // A binding without a session id identifies no durable session:
        // its create never completed, and whatever later owns the file
        // path is a different session (or none at all) - rebinding into
        // it is the foreign-session hazard, not a recovery.
        let binding_session_id = binding.session_id.as_deref()?.to_string();
        let session_file = binding.session_file.as_deref()?.to_string();
        let resident = self.registry.find_by_session_file(&session_file).await?;
        // The resident must BE the binding's session, not merely hold its
        // file: a reused path must not let one session's stale ids
        // rebind into the different session that now owns the path - the
        // durable id is the identity the rebind follows.
        let resident_session = resident.descriptor.lock().await.root_session_id.clone();
        if resident_session.as_deref() != Some(binding_session_id.as_str()) {
            return None;
        }
        // Only a connected resident rebinds: a worker mid-teardown or one
        // left by a failed launch would answer `Session worker is not
        // connected` instead of the unknown-session failure the client can
        // act on.
        if resident.cmd_tx.lock().await.is_none() {
            return None;
        }
        // Only a session-ready resident rebinds: a replacement's command
        // channel exists before its create replay finishes, so a command
        // routed mid-replay would bounce off the worker's require-created
        // gate instead of waiting out the replacement. `None` keeps the
        // unknown-session failure - the client's own retry (the TUI
        // re-attaches by the durable session id) rides the
        // replacement-aware route and lands once the replay answers.
        if !resident.route_state().session_ready {
            return None;
        }
        Some(resident)
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
    /// loop fails while not shutting down.
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

        while !self.accept_exit.load(Ordering::SeqCst) {
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
                () = self.shutdown_notify.notified() => continue,
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
    /// relaunch (create replay) must not delay adopting live sessions. The
    /// fan-out is capped ([`crate::recovery_pacing::ADOPTION_CONCURRENCY`]):
    /// a large sessions dir must not turn the pass into a relaunch storm
    /// that starves the control plane for its whole duration. The pass
    /// reports its decisions as one `worker_adoption` event (counts only,
    /// never session payload).
    async fn adopt_persisted_workers(self: &Arc<Self>, boot: AdoptionBoot) {
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

    /// Complete a tombstoned stop for a worker encountered at adoption —
    /// the boot scan's descriptor pass and a live re-registration alike
    /// (TS `adoptOrRecoverWorker`'s `stopRequestedAt` branch: adoption
    /// finishes the stop, never adopts the worker as healthy). The
    /// tombstone's variant rides `archive_on_stop`: the kill stop
    /// (`Some(true)`) is irreversible — its killed close cancels jobs,
    /// archives the file, and cascades children; the per-session stop
    /// (`Some(false)`) keeps the session resumable — its graceful
    /// shutdown close and its schedule-cancel belt are all it owns.
    async fn finish_tombstoned_stop(self: &Arc<Self>, resident: &Arc<ResidentWorker>, alive: bool) {
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
                    .route_command(
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
                        self.spawn_monitor(Arc::clone(&resident), Some(child), child_pid as u64);
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

    pub(crate) async fn route_command(
        &self,
        resident: &Arc<ResidentWorker>,
        command_type: &str,
        payload: Value,
        timeout_ms: u64,
        admission: RouteAdmission,
    ) -> Result<DaemonResponse> {
        let cmd_tx = {
            let guard = resident.cmd_tx.lock().await;
            guard.clone().ok_or_else(|| anyhow!(WORKER_NOT_CONNECTED))?
        };
        // Bounded admission (the Codex request/await split): a client's
        // request-shaped command answers the explicit overload refusal
        // the moment the worker's in-flight bound is full — nothing is
        // queued and nothing is dropped, so the caller's retry cannot
        // duplicate the command; supervisor-internal traffic waits for a
        // slot inside the route's own budget, so control-plane routes are
        // never refused. The whole route — admission, enqueue, and reply
        // waits — never exceeds the caller's budget.
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        // The semaphore methods take their Arc by value (the permit owns
        // it for its lifetime), so the route hands them a strong reference
        // of their own.
        let inflight = Arc::clone(&resident.inflight);
        let _permit = match admission {
            RouteAdmission::ClientRequest => match inflight.try_acquire_owned() {
                Ok(permit) => permit,
                Err(_saturated) => {
                    self.note_daemon_event("worker_overloaded", None);
                    return Ok(crate::backpressure::overloaded_response(
                        command_type,
                        &resident.worker_id,
                    ));
                }
            },
            RouteAdmission::SupervisorInternal => {
                match tokio::time::timeout_at(deadline, inflight.acquire_owned()).await {
                    Ok(Ok(permit)) => permit,
                    // Both remaining shapes are budget exhaustion: the
                    // wait elapsed, or the semaphore closed with its
                    // resident. The budget error is the same one a wedged
                    // worker's silent route produces.
                    Ok(Err(_)) | Err(_) => return Err(anyhow!("Session worker timed out")),
                }
            }
        };
        let (reply_tx, reply_rx) = oneshot::channel();
        let request_id = uuid::Uuid::new_v4().to_string();
        resident
            .pending
            .lock()
            .await
            .insert(request_id.clone(), reply_tx);
        // The enqueue seam of the bounded queue (the Codex full-queue
        // answer, `mod.rs:228-259`): a full channel means the writer pump
        // is wedged — parked frames whose routes already timed out freed
        // their permits, so a slot can be free while the queue is not. A
        // client command answers the same explicit overload refusal there;
        // supervisor-internal traffic instead waits out the remaining
        // budget (never refused, never silently dropped — the cancelled
        // send enqueues nothing, so the refused request provably never
        // left the supervisor and a retry cannot duplicate it).
        let request = WorkerRequest {
            request_id: request_id.clone(),
            command_type: command_type.to_string(),
            payload,
        };
        let unsent = match cmd_tx.try_send(request) {
            Ok(()) => None,
            Err(mpsc::error::TrySendError::Full(unsent)) => Some(unsent),
            Err(mpsc::error::TrySendError::Closed(_)) => {
                resident.pending.lock().await.remove(&request_id);
                return Err(anyhow!(WORKER_NOT_CONNECTED));
            }
        };
        if let Some(unsent) = unsent {
            match admission {
                RouteAdmission::ClientRequest => {
                    resident.pending.lock().await.remove(&request_id);
                    self.note_daemon_event("worker_overloaded", None);
                    return Ok(crate::backpressure::overloaded_response(
                        command_type,
                        &resident.worker_id,
                    ));
                }
                RouteAdmission::SupervisorInternal => {
                    match tokio::time::timeout_at(deadline, cmd_tx.send(unsent)).await {
                        Ok(Ok(())) => {}
                        Ok(Err(_channel_closed)) => {
                            resident.pending.lock().await.remove(&request_id);
                            return Err(anyhow!(WORKER_NOT_CONNECTED));
                        }
                        Err(_budget_elapsed) => {
                            resident.pending.lock().await.remove(&request_id);
                            return Err(anyhow!("Session worker timed out"));
                        }
                    }
                }
            }
        }
        match tokio::time::timeout_at(deadline, reply_rx).await {
            // The writer pump resolves provably-unsent requests with the
            // not-connected failure: surface it as the retryable route
            // error instead of a worker response.
            Ok(Ok(response))
                if !response.success && response.error.as_deref() == Some(WORKER_NOT_CONNECTED) =>
            {
                Err(anyhow!(WORKER_NOT_CONNECTED))
            }
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err(anyhow!("Session worker dropped the request")),
            Err(_) => {
                // A timed-out request's reply slot must not sit in the
                // pending map forever (a wedged worker never answers, and
                // repeated bounded-timeout routes would otherwise grow the
                // map without bound).
                resident.pending.lock().await.remove(&request_id);
                Err(anyhow!("Session worker timed out"))
            }
        }
    }

    /// Route one client-facing command to a resident worker, waiting out an
    /// in-flight worker replacement (crash backoff, relaunch, create
    /// replay) inside the caller's own timeout budget instead of failing
    /// into the dead window: a child's detached task prompt that fires while
    /// its worker is being replaced must land exactly once, never bounce
    /// off a dead socket and never overtake the replayed session into
    /// existence. The wait ends only once the replacement's create replay
    /// completed; a send that fails with the unambiguous not-connected
    /// error (the request never left the supervisor) is retried against the
    /// next connection, while ambiguous failures (timeouts, dropped
    /// replies) are returned as-is so a possibly-processed command is
    /// never duplicated. The [`RouteAdmission`] overload refusal passes
    /// through untouched: the request never left the supervisor, and the
    /// caller — not this loop — owns the retry (a saturated worker stays
    /// saturated for the remainder of the budget).
    pub(crate) async fn route_command_ready(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
        command_type: &str,
        payload: Value,
        timeout_ms: u64,
        admission: RouteAdmission,
    ) -> Result<DaemonResponse> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            self.await_route_ready(resident, deadline).await?;
            let remaining_ms = deadline
                .saturating_duration_since(tokio::time::Instant::now())
                .as_millis() as u64;
            match self
                .route_command(
                    resident,
                    command_type,
                    payload.clone(),
                    remaining_ms,
                    admission,
                )
                .await
            {
                // The socket died between the liveness check and the send
                // (or the writer pump broke on an earlier request): the
                // command never reached a worker, so waiting for the
                // replacement and sending again cannot duplicate it.
                Err(error) if error.to_string() == WORKER_NOT_CONNECTED => {
                    if tokio::time::Instant::now() >= deadline
                        || resident.route_state().retired
                        || self.is_stopping(resident)
                    {
                        return Err(error);
                    }
                }
                other => return other,
            }
        }
    }

    /// Wait until the resident is route-ready (a live connection whose
    /// session create completed), bailing fast on retired/stopping workers
    /// and on the deadline otherwise.
    async fn await_route_ready(
        &self,
        resident: &Arc<ResidentWorker>,
        deadline: tokio::time::Instant,
    ) -> Result<()> {
        let mut state = resident.route_state_watcher();
        loop {
            let current = *state.borrow_and_update();
            if current.connected && current.session_ready {
                return Ok(());
            }
            if current.retired || self.is_stopping(resident) {
                bail!(WORKER_NOT_CONNECTED);
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                bail!("Session worker timed out");
            }
            // Sleep until the route state moves or the deadline passes.
            match tokio::time::timeout_at(deadline, state.changed()).await {
                Ok(Ok(())) => {}
                // The resident (and its watch sender) was dropped entirely.
                Ok(Err(_)) => bail!(WORKER_NOT_CONNECTED),
                Err(_) => bail!("Session worker timed out"),
            }
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
            .route_command(
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
        self.spawn_monitor(Arc::clone(&resident), Some(child), pid as u64);
        Ok((resident, create_summary))
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
            rest: Map::default(),
        };
        write_line(&mut writer, &serde_json::to_value(&hello)?).await?;

        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        let mut events = self.events.subscribe();
        let connection_id = client_id.clone();
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
        // daemon's async command handlers. Bounded at
        // [`crate::backpressure::CLIENT_OUTBOUND_CAPACITY`]: a client that
        // reads nothing stalls only its own dispatch tasks once the queue
        // fills — memory stays bounded per connection — while every other
        // client and worker is unaffected.
        let (dispatch_tx, mut dispatch_rx) = tokio::sync::mpsc::channel::<(Vec<Value>, bool)>(
            crate::backpressure::CLIENT_OUTBOUND_CAPACITY,
        );
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
                    // The stream clone a mid-handler streaming command
                    // (list_saved_sessions) writes its progress frames
                    // through: the SAME channel the response later takes,
                    // so the frames stay strictly ordered ahead of it.
                    let stream_tx = dispatch_tx.clone();
                    let connection_id = connection_id.clone();
                    tokio::spawn(async move {
                        let (lines, stop) = supervisor
                            .dispatch_client(
                                &trimmed,
                                &effective_client_id,
                                &attached,
                                &roster_subscribed,
                                &connection,
                                &connection_id,
                                &stream_tx,
                            )
                            .await;
                        if dispatch_tx.send((lines, stop)).await.is_err() && stop {
                            // The initiating connection left before its response
                            // was selected. Only a terminal shutdown owns the
                            // descriptor-deleting stop pass; an update restart
                            // must leave its descriptors for the successor.
                            let is_shutdown_owner = supervisor
                                .shutdown_owner
                                .lock()
                                .unwrap()
                                .as_deref()
                                == Some(connection_id.as_str());
                            if is_shutdown_owner
                                && supervisor.shutting_down.load(Ordering::SeqCst)
                                && !supervisor.accept_exit.load(Ordering::SeqCst)
                            {
                                supervisor.ensure_shutdown_started().await;
                            }
                        }
                    });
                }
                dispatched = dispatch_rx.recv() => {
                    let Some((lines, stop)) = dispatched else { break };
                    for outbound in lines {
                        if let Err(error) = write_line(&mut writer, &outbound).await {
                            // A failed response write must not strand the
                            // shutdown: the stop pass still has to run.
                            if stop {
                                self.ensure_shutdown_started().await;
                            }
                            return Err(error);
                        }
                    }
                    if stop {
                        // The initiating client's response and daemon_closing
                        // lines are flushed above; only now may the stop pass
                        // end the runtime. The accept loop stays up until
                        // begin_shutdown sets accept_exit, so worker stops
                        // cannot be cut short by another inbound connection.
                        self.ensure_shutdown_started().await;
                        break;
                    }
                }
                event = events.recv() => {
                    match event {
                        Ok((routing, payload)) => {
                            let deliver = match &routing {
                                ClientRouting::Broadcast => true,
                                ClientRouting::BroadcastExcept {
                                    connection_id: excluded,
                                } => excluded.as_str() != connection_id.as_str(),
                                ClientRouting::AttachedSession { active_session_id } => {
                                    attached.lock().unwrap().iter().any(|id| id == active_session_id)
                                }
                                ClientRouting::RosterSubscribers => {
                                    roster_subscribed.load(std::sync::atomic::Ordering::SeqCst)
                                }
                            };
                            if deliver {
                                if let Err(error) = write_line(&mut writer, &payload).await {
                                    // An event-write failure must not strand an
                                    // accepted shutdown: if this connection owns
                                    // the stop, it still starts the pass.
                                    let is_shutdown_owner = self
                                        .shutdown_owner
                                        .lock()
                                        .unwrap()
                                        .as_deref()
                                        == Some(connection_id.as_str());
                                    if is_shutdown_owner
                                        && self.shutting_down.load(Ordering::SeqCst)
                                        && !self.accept_exit.load(Ordering::SeqCst)
                                    {
                                        self.ensure_shutdown_started().await;
                                    }
                                    return Err(error);
                                }
                            }
                        }
                        // A lagged receiver means the shared event ring
                        // (capacity 4096) dropped this many events for
                        // THIS connection: the loss itself is the
                        // broadcast's defined backpressure, but it must
                        // never stay invisible (finding 4a) — the daemon
                        // log records which client lost how much.
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            self.log_line(&format!(
                                "client {connection_id} lagged on the event ring: {skipped} events dropped"
                            ));
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
        // A shutdown command may have been accepted just before this client
        // disconnected (or its response write failed). Only the connection
        // that accepted the shutdown may run the stop pass from this
        // fallback: another client disconnecting in the response window
        // must not preempt the acknowledgement or turn an update restart
        // into a terminal descriptor sweep.
        let is_shutdown_owner =
            self.shutdown_owner.lock().unwrap().as_deref() == Some(connection_id.as_str());
        if is_shutdown_owner
            && self.shutting_down.load(Ordering::SeqCst)
            && !self.accept_exit.load(Ordering::SeqCst)
        {
            self.ensure_shutdown_started().await;
        }
        // Detach from every attached session on disconnect (a TUI exit does
        // not stop the session; the worker keeps running).
        let attached_sessions = attached.lock().unwrap().clone();
        for active_session_id in &attached_sessions {
            if let Ok(resident) = self.registry.resolve(active_session_id).await {
                let payload = json!({ "type": "detach", "clientId": effective_client_id.lock().unwrap().clone() });
                let _ = self
                    .route_command(
                        &resident,
                        "detach",
                        payload,
                        ROUTE_TIMEOUT_MS,
                        RouteAdmission::SupervisorInternal,
                    )
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
    // One more dispatch-context input than the lint's budget: the
    // per-connection stream sender rides the same context bundle
    // `execute_parsed_command` takes (its own allow below).
    #[allow(clippy::too_many_arguments)]
    async fn dispatch_client(
        self: &Arc<Self>,
        line: &str,
        effective_client_id: &Arc<std::sync::Mutex<String>>,
        attached: &Arc<std::sync::Mutex<Vec<String>>>,
        roster_subscribed: &Arc<std::sync::atomic::AtomicBool>,
        connection: &Arc<crate::input_pause_lease::ClientConnectionState>,
        connection_id: &str,
        stream: &tokio::sync::mpsc::Sender<(Vec<Value>, bool)>,
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
        // Terminal shutdown admission gate: once the shutdown command has
        // flipped `shutting_down`, no later client command may reach a
        // worker (the stop pass may already be retiring it). The command
        // that started the shutdown passed this point before it set the
        // gate, so its own response path is unaffected.
        if self.shutting_down.load(Ordering::SeqCst) {
            return (
                vec![response_line(&response_failure(
                    Some(&command_id),
                    &type_name,
                    "Supervisor is shutting down",
                    None,
                ))],
                false,
            );
        }
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
                connection_id,
                command_id,
                type_name,
                stream,
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
        connection_id: &str,
        command_id: String,
        type_name: String,
        stream: &tokio::sync::mpsc::Sender<(Vec<Value>, bool)>,
    ) -> (Vec<Value>, bool) {
        match command {
            DaemonCommand::AckResult { .. } => (Vec::new(), false),
            DaemonCommand::Restart { .. } | DaemonCommand::Shutdown { .. } => {
                let response = response_success(Some(&command_id), &type_name, None);
                let mut lines = vec![response_line(&response)];
                // daemon_closing goes to every client before the exit.
                let closing = json!({ "type": "daemon_closing", "reason": "shutdown" });
                let _ = self.events.send((
                    ClientRouting::BroadcastExcept {
                        connection_id: connection_id.to_string(),
                    },
                    closing.clone(),
                ));
                lines.push(closing);
                // Answer first, then shut down: the connection loop writes
                // these lines before it awaits begin_shutdown, so the client
                // always receives the response and daemon_closing before the
                // stop pass can end the process. The shutdown gate flips
                // synchronously here — before the response is written — so
                // no create dispatched after the shutdown can slip past it
                // and launch a worker the stop pass would miss.
                *self.shutdown_owner.lock().unwrap() = Some(connection_id.to_string());
                self.shutting_down.store(true, Ordering::SeqCst);
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
                let lines = self
                    .handle_saved_session_list(command, &command_id, stream)
                    .await;
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
                sequence,
                worker_instance_id,
                ..
            } => {
                let response = self
                    .handle_worker_roster_delta(
                        &command_id,
                        &type_name,
                        crate::supervisor_roster::WorkerRosterDelta {
                            worker_token: worker_token.clone(),
                            summary: summary.clone(),
                            removed: removed.clone().unwrap_or_default(),
                            sequence: *sequence,
                            worker_instance_id: worker_instance_id.clone(),
                        },
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
                    Err(error) => {
                        // A typed worker rejection carries its wire info to
                        // the client (the TS `serializeDaemonError` shape);
                        // untyped failures stay the bare string.
                        let (message, error_info) =
                            match error.downcast_ref::<TypedCreateRejection>() {
                                Some(rejection) => (
                                    rejection.message.clone(),
                                    Some(rejection.error_info.clone()),
                                ),
                                None => (error.to_string(), None),
                            };
                        (
                            vec![response_line(&response_failure(
                                Some(&command_id),
                                &type_name,
                                &message,
                                error_info,
                            ))],
                            false,
                        )
                    }
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
            DaemonCommand::AbortCompaction { .. } => {
                // The abort supervision: the supervisor answers the abort
                // itself. The TS daemon-mode `abortCompaction` is an
                // in-process call that always replies instantly; a wedged
                // worker must not turn the abort into its own 30s route
                // timeout and a loader that never clears.
                let client_id = effective_client_id.lock().unwrap().clone();
                self.handle_abort_compaction(command, &client_id, attached, &command_id, &type_name)
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
                    .route_command(
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
            snapshots,
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
                let _ = self.events.send((ClientRouting::Broadcast, closing));
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

    /// `list_saved_sessions` (port of `handleSavedSessionList`): stream
    /// `session_list_item`/`session_list_progress` events, then a final
    /// response with the full saved-session rows.
    async fn handle_saved_session_list(
        self: &Arc<Self>,
        command: &DaemonCommand,
        command_id: &str,
        stream: &tokio::sync::mpsc::Sender<(Vec<Value>, bool)>,
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
        let (cwd, session_dir) = if let Some(active_session_id) = active_session_id {
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
        } else {
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
        // The catalog streams WHILE the scan runs (TS
        // `listSessionsFromDir`'s per-file `onSession`/`onProgress`: the
        // client's rows appear through the scan instead of after it). The
        // frames ride the SAME per-connection channel the final response
        // later travels, so the stream stays strictly ordered ahead of its
        // own response; the fold runs on the blocking pool, so a grown
        // store never head-of-lines a runtime worker (the #2723 class).
        let stream_rows = stream.clone();
        let scan_command_id = command_id.to_string();
        let scan_active_session_id = active_session_id.as_ref().cloned();
        let scan_cwd = cwd.clone();
        let scan = tokio::task::spawn_blocking(move || {
            let mut file_total = 0usize;
            let infos = crate::session_scan::list_sessions_with(&dir, |index, total, info| {
                file_total = total;
                if scope_current && info.cwd != scan_cwd {
                    // The row is out of scope, but the scan itself goes on.
                    return true;
                }
                let row = saved_session_row(info);
                let mut item = json!({
                    "id": scan_command_id,
                    "type": "session_list_item",
                    "command": "list_saved_sessions",
                    "session": row,
                });
                if let Some(active_session_id) = scan_active_session_id.as_deref() {
                    item["activeSessionId"] = json!(active_session_id);
                }
                let mut progress = json!({
                    "id": scan_command_id,
                    "type": "session_list_progress",
                    "command": "list_saved_sessions",
                    "loaded": index + 1,
                    "total": total,
                });
                if let Some(active_session_id) = scan_active_session_id.as_deref() {
                    progress["activeSessionId"] = json!(active_session_id);
                }
                // A failed send is the connection loop's death notice (its
                // receiver is gone): the remaining folds serve nobody, so
                // the callback stops the scan (the response travels the
                // same dead channel and drops with it). The bounded queue
                // blocks the scan thread until the client drains — the
                // scan paces itself to its reader instead of buffering the
                // whole catalog in memory.
                stream_rows
                    .blocking_send((vec![item, progress], false))
                    .is_ok()
            });
            (infos, file_total)
        });
        let (mut infos, file_total) = match scan.await {
            Ok(scanned) => scanned,
            Err(error) => {
                return vec![response_line(&response_failure(
                    Some(command_id),
                    "list_saved_sessions",
                    &format!("the saved-session scan failed: {error}"),
                    None,
                ))];
            }
        };
        // The current-cwd scope keeps only the session's own rows in the
        // terminal array (the stream above already skipped the others'
        // frames): the response is the authoritative catalog.
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
        // The passive ledger children stream too (TS
        // `withPassiveRlmDescendantInfos`'s `onSession`): items only, no
        // progress - the saved phase above owns the progress counts.
        let mut merged: Vec<_> = passive
            .iter()
            .map(crate::rlm_roster::passive_child_info)
            .filter(|info| !scope_current || info.cwd == cwd)
            .collect();
        for info in &merged {
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
            let _ = stream.send((vec![item], false)).await;
        }
        infos.append(&mut merged);
        // Every row - scanned or passive-merged - carries its tombstoned
        // descendants' spend (TS `withPassiveRlmDescendantInfos`'s
        // deleted-usage half): one bucket read per list, attached by
        // canonical parent path so the agents-view recursive rollup bills
        // deleted subagents to the parent that spent them. A broken ledger
        // degrades to bare rows, exactly like the passive merge above.
        match ledger.deleted_descendant_usage_by_parent() {
            Ok(bucket) => {
                for info in &mut infos {
                    let path = crate::lease::canonical_session_path(&info.path)
                        .to_string_lossy()
                        .to_string();
                    info.deleted_descendant_usage = bucket.get(&path).cloned();
                }
            }
            Err(error) => {
                self.log_line(&format!(
                    "Could not attach deleted-descendant usage: {error:#}"
                ));
            }
        }
        // The scan's completion marker: the per-file progress counts
        // DIRECTORY entries, while the rows only stream for valid files,
        // so the last per-row progress can land short of the total when
        // an invalid file yields no row (TS's onProgress counts every
        // file, valid or not, so its stream always reaches its total).
        // One final frame names the scan's end exactly; a consumer
        // waiting for `loaded == total` observes completion.
        if file_total > 0 {
            let mut completion = json!({
                "id": command_id,
                "type": "session_list_progress",
                "command": "list_saved_sessions",
                "loaded": file_total,
                "total": file_total,
            });
            if let Some(active_session_id) = active_session_id {
                completion["activeSessionId"] = json!(active_session_id);
            }
            let _ = stream.send((vec![completion], false)).await;
        }
        // The streamed rows already reached the client through the scan
        // (and the passive merge above); the terminal response is the
        // authoritative array (the scan never re-orders after streaming).
        let mut lines = Vec::new();
        let sessions: Vec<Value> = infos.iter().map(saved_session_row).collect();
        lines.push(response_line(&response_success(
            Some(command_id),
            "list_saved_sessions",
            Some(json!({ "sessions": sessions })),
        )));
        // Telemetry: how many served rows carry a usage summary — the
        // agents-view spend columns' data (a count only, never session
        // payload).
        let rows_with_usage = infos.iter().filter(|info| info.usage.is_some()).count();
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_saved_sessions_usage(client, rows_with_usage);
        }
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
        let summaries: Vec<Value> = if let Some(true) = all {
            // TS `buildSessionList` order: saved rows (resident ones
            // replaced in place by their live summary), then passive
            // ledger children, then resident-only rows.
            let mut infos = list_sessions(&dir);
            if let Some(cwd) = cwd {
                infos.retain(|info| info.cwd == cwd);
            }
            let residents = self.registry.list().await;
            let mut resident_by_file: Vec<ResidentRoot> = Vec::new();
            for resident in &residents {
                let descriptor = resident.descriptor.lock().await;
                if let Some(session_file) = &descriptor.session_file {
                    resident_by_file.push(ResidentRoot {
                        session_file: crate::lease::canonical_session_path(Path::new(session_file)),
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
        } else {
            // Live residents of this supervisor.
            let mut summaries = Vec::new();
            for resident in self.registry.list().await {
                summaries.push(self.worker_summary(&resident).await);
            }
            summaries
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

    /// One resident's live summary (`get_state`), with the recovering-row
    /// fallback for an unreachable worker.
    async fn worker_summary(self: &Arc<Self>, resident: &Arc<ResidentWorker>) -> Value {
        let response = self
            .route_command(
                resident,
                "get_state",
                json!({}),
                ROUTE_TIMEOUT_MS,
                RouteAdmission::SupervisorInternal,
            )
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
        // The per-file open single-flight (TS `openingWorkers`): one
        // create at a time per session file. A concurrent open waits
        // behind this one and then reuses the worker it launched — both
        // reaching the launch would race the runtime session lease.
        let opening_guard = self.opening_guard(command).await?;
        // TS `createOrReuseWorker`'s reuse seam: an open of a session file
        // a live worker already serves answers the LIVE binding (the
        // client attaches next) instead of launching a second worker over
        // the same file — a launch the runtime session lease would reject
        // with `Session is already active`. `None` keeps the launch path.
        // The seam runs BEFORE the name check (TS reserves names only on
        // the fresh-launch path): a named open of an already-active
        // session reuses it — its own name is not a conflict.
        if let Some(summary) = self
            .reuse_live_worker_for_create(command, &client_id)
            .await?
        {
            return Ok(summary);
        }
        if let DaemonCommand::Create {
            name: Some(name), ..
        } = command
        {
            self.assert_session_name_available(name).await?;
        }
        // TS daemon-supervisor.ts: only a `client_owned`-lifecycle create
        // is client-owned (`ownerClientId = command.lifecycle ===
        // "client_owned" ? clientId : undefined`); unspecified and
        // `Resident` lifecycles are unowned. Every RLM child spawn
        // declares `Resident`, so a spawned child never inherits the
        // spawning client's ownership: passivation deletes an owned
        // worker's rows, and a stopped child under a surviving root must
        // passivate instead (the walk e2e asserts the passive row
        // survives the kill). A `None`-lifecycle create being owner-
        // marked would hide its live session from every other client
        // (`assertWorkerAccessibleToClient`), so it stays unowned too.
        let create_lifecycle = match command {
            DaemonCommand::Create { lifecycle, .. } => *lifecycle,
            _ => None,
        };
        let owner_client_id = match create_lifecycle {
            Some(DaemonSessionLifecycle::ClientOwned) => Some(client_id),
            _ => None,
        };
        let (resident, create_summary) = self.launch_worker(command, owner_client_id).await?;
        // The launch registered its worker (the registry insert precedes
        // the spawn). The single-flight stays held through the spawn
        // admission below: an admission failure tears the resident down,
        // and a concurrent open that had just reused it would hold a
        // summary for a worker that no longer exists.
        // Spawn admission is the moment the supervisor knows the child's
        // edge firsthand. The ledger is the only topology store, so the
        // append's outcome is load-bearing: admission fails if the spawn
        // record cannot be made durable (a swallowed failure would admit a
        // child that listing and hydration can never find after
        // passivation). Admission reads the CREATE response: it is
        // authoritative (launch_worker rejects a sessioned create without
        // a durable non-empty session file). A fresh get_state here races
        // worker replacement (a rebooting worker mid-replay answers
        // without the session file yet) and would tear down a healthy
        // child on a stale miss.
        if let Err(error) = self
            .record_rlm_child_admission(command, &create_summary)
            .await
        {
            // Never leave an admitted-but-unrecorded child running: the
            // ledger is the only topology store.
            let _ = self.stop_worker(&resident).await;
            return Err(error);
        }
        // The admission settled: the single-flight may release (a
        // concurrent open's classification now finds a durable resident).
        drop(opening_guard);
        // The response still matches attach/list rows exactly: prefer a
        // fresh get_state, but a degraded one falls back to the
        // authoritative create summary instead of failing the spawn (the
        // session is durable at this point; the child is healthy).
        let summary = match self
            .route_command(
                &resident,
                "get_state",
                json!({}),
                ROUTE_TIMEOUT_MS,
                RouteAdmission::SupervisorInternal,
            )
            .await
        {
            Ok(response) if response.success => {
                response.data.unwrap_or_else(|| create_summary.clone())
            }
            _ => create_summary.clone(),
        };
        // The new session joins the agent roster immediately (subscribers
        // see the roster_update before their next list) — as an
        // authoritative pull write, so its embedded counter raises the
        // stale-delta watermark for the resident.
        self.write_roster_summary_for_resident(&resident, &summary)
            .await;
        // The new root's passive family renders immediately from the
        // ledger edges - no transcript read on the event path - then one
        // bounded background hydration fills each newly seeded row's
        // durable display fields (cwd, model, thinking level) and
        // publishes them as one update. A fresh session has no family;
        // the guards skip every row another surface already seeded. The
        // root is the CREATE response's session file (the authoritative
        // durable path, exactly what admission reads): a get_state that
        // answers mid-replay without its session file must not skip a
        // resume's family, and a live get_state file that differs is
        // still the same session.
        if let Some(root) = summary
            .get("sessionFile")
            .and_then(Value::as_str)
            .or_else(|| create_summary.get("sessionFile").and_then(Value::as_str))
        {
            let seeded = self.seed_roster_family_edges(Path::new(&root)).await;
            if !seeded.is_empty() {
                self.spawn_seeded_hydration(seeded);
            }
        }
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

    async fn assert_session_name_available(self: &Arc<Self>, name: &str) -> Result<()> {
        if name.trim().is_empty() {
            return Err(anyhow!("Session name cannot be empty"));
        }
        for resident in self.registry.list().await {
            let response = self
                .route_command(
                    &resident,
                    "get_state",
                    json!({}),
                    ROUTE_TIMEOUT_MS,
                    RouteAdmission::SupervisorInternal,
                )
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
        // The rebind target when the selector addresses a superseded id: a
        // binding whose session has a live resident again (a new worker took
        // the session file over). The routed command is rewritten to the
        // current id, so the rest of this route - and the response handling
        // below - addresses the session's current worker.
        let mut rebound_to: Option<String> = None;
        let resident = if let Ok(resident) = self.registry.resolve(&selector).await {
            resident
        } else {
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
                    // The stale-active-id rebind: the selector is a
                    // superseded id the binding table still maps to the
                    // session's durable identity, and a live resident
                    // owns that identity now. The command failed before
                    // it ever reached a worker, so routing it once to
                    // the current resident delivers it exactly once.
                    if let Some(resident) = self.binding_target(&selector).await {
                        // A detach addressed to a superseded id has
                        // no worker to reach: the stale worker is
                        // gone (its client-side state died with it),
                        // and forwarding the detach to the
                        // replacement would drop the very attach
                        // the client may have just established there
                        // (the worker keys its detach by client). The
                        // supervisor retires the stale address
                        // itself and answers the detach.
                        if matches!(command, DaemonCommand::Detach { .. }) {
                            attached.lock().unwrap().retain(|id| id != &selector);
                            return (
                                vec![response_line(&response_success(
                                    Some(&command_id),
                                    &type_name,
                                    None,
                                ))],
                                false,
                            );
                        }
                        rebound_to =
                            Some(self.rebind_connection(&selector, &resident, attached).await);
                        resident
                    } else {
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
        // A kill is the worker's own root kill (TS `isRootKill`) — a
        // parent's child-close cascade carries the `rlmCloseReason` marker
        // and is NOT one (TS forwards a child close without a supervisor
        // stop): only the plain kill tombstones and finalizes. The stop
        // tombstone persists BEFORE the worker is told (TS
        // `persistWorkerStopTombstone(worker, true)`), so a supervisor that
        // dies mid-stop adopts the tombstone instead of relaunching the
        // killed worker, and the durable half of the stop (the session
        // tree's scheduled-job cancel + the `archived` state belt) re-runs.
        // The plain-kill gate (TS `isRootKill`): the `rlmCloseReason`
        // marker is the parent's child-close cascade and only ever targets
        // a subagent session — a top-level target is ALWAYS a plain kill
        // regardless of the wire marker (a client cannot forge the softer
        // close semantics for a root session; the finalize belt below
        // cancels its jobs and archives its file either way).
        let plain_kill = match command {
            DaemonCommand::Kill { rest, .. } => {
                let no_marker = !rest.contains_key("rlmCloseReason");
                let target_depth = resident
                    .descriptor
                    .lock()
                    .await
                    .create_command
                    .rest
                    .get("rlmDepth")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                no_marker || target_depth == 0
            }
            _ => false,
        };
        if plain_kill {
            if let Err(error) = self.persist_stop_tombstone(&resident).await {
                return (
                    vec![response_line(&response_failure(
                        Some(&command_id),
                        &type_name,
                        &format!("Failed to persist the session stop: {error:#}"),
                        None,
                    ))],
                    false,
                );
            }
        }
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
        let (worker_command, mut payload) = match client_command_payload(command, client_id) {
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
        // A rebind retargets the routed frame: the worker reads the session
        // selector the payload carries, and the superseded id is not one it
        // knows. A rebound reattach routes as the worker's attach - the
        // worker has no reattach arm; the reattach semantics (detach-mark
        // clearing, replacement snapshot purpose) live supervisor-side.
        let mut worker_command = worker_command;
        if let Some(current) = &rebound_to {
            if let Some(object) = payload.as_object_mut() {
                object.insert("activeSessionId".to_string(), json!(current));
            }
            if worker_command == "reattach" {
                worker_command = "attach";
            }
        }
        // Client-facing routes wait out an in-flight worker replacement
        // inside the command's own budget: a command aimed at a worker that
        // crashed and is being relaunched (crash backoff, relaunch, create
        // replay) must not be lost to the dead window, and must never
        // overtake the replayed session into existence.
        let response = self
            .route_command_ready(
                &resident,
                worker_command,
                payload,
                timeout,
                RouteAdmission::ClientRequest,
            )
            .await;
        match response {
            Ok(mut response) => {
                // Worker replies carry no client request id; clients match
                // responses by the id they sent, so stamp it back here.
                response.id = Some(command_id.clone());
                // A rebound reattach routed as the worker's attach still
                // answers as the command the client sent.
                if rebound_to.is_some() && type_name == "reattach" {
                    response.command = type_name.clone();
                }
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
                                .map_or_else(|| resident.worker_id.clone(), str::to_string);
                            self.note_daemon_event(
                                if matches!(command, DaemonCommand::Reattach { .. }) {
                                    "reattach"
                                } else {
                                    "attach"
                                },
                                None,
                            );
                            // The binding table learns the id the worker
                            // reports (a durable-id or file-stem attach
                            // resolves to the worker's current id), keyed
                            // by the session's durable identity.
                            let (session_id, session_file) = {
                                let descriptor = resident.descriptor.lock().await;
                                (
                                    descriptor.root_session_id.clone(),
                                    descriptor.session_file.clone(),
                                )
                            };
                            self.record_session_binding(
                                &active_id,
                                session_id.as_deref(),
                                session_file.as_deref(),
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
                                client["capabilities"] = json!(client_capabilities);
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
                        // The retire removes the RESIDENT's active id - the
                        // id the attached vec actually holds (the selector
                        // may be a durable-id alias for the same session).
                        // A rebound detach never reaches this handler; the
                        // rebind seam retires its superseded address itself.
                        attached
                            .lock()
                            .unwrap()
                            .retain(|id| id != &resident.worker_id);
                    }
                }
                if let DaemonCommand::Kill { rest, .. } = command {
                    if response.success {
                        // The kill route's own tombstone already persisted
                        // before the forward, so the stop's durable intent
                        // stands even when this pass fails; a failure is
                        // observable (logged) instead of silently
                        // skipping the retire/registry/passivation tail —
                        // the boot's tombstoned-stop finalization owns
                        // whatever this pass could not finish.
                        if let Err(error) = self.stop_worker(&resident).await {
                            self.log_line(&format!(
                                "session worker {} stop after kill failed: {error:#}; the tombstoned descriptor holds the stop for the next boot",
                                resident.worker_id
                            ));
                        }
                        // TS `stopWorkerUntracked`'s archived-stop finalize
                        // (the plain kill's durable half): the killed
                        // session tree's scheduled jobs cancel durably and
                        // the root file carries the `archived` state, so no
                        // wake pass can revive the stopped session. A
                        // ledger-tombstoned delete also sweeps the deleted
                        // child's artifacts (TS `deleteRlmSubagentArtifacts`).
                        // A marker-carrying child close is a cascade, not a
                        // stop: no finalize (the child's own close arms
                        // already carried the parent's reason).
                        if plain_kill {
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
                            self.finalize_worker_stop(&resident, deleted_child.as_ref())
                                .await;
                        }
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
            .route_command(
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
    async fn retire_worker_after_stop(self: &Arc<Self>, resident: &Arc<ResidentWorker>) {
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
                .route_command(
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
/// fit inside one worker-connect budget from spawn time (the TS default,
/// or the env override for load-heavy e2e environments). An override past
/// the platform's representable range falls back to the default budget
/// instead of panicking the deadline arithmetic.
fn worker_connect_deadline() -> tokio::time::Instant {
    let timeout_ms = std::env::var(WORKER_CONNECT_TIMEOUT_ENV)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .unwrap_or(DEFAULT_WORKER_CONNECT_TIMEOUT_MS);
    let now = tokio::time::Instant::now();
    now.checked_add(Duration::from_millis(timeout_ms))
        .unwrap_or_else(|| now + Duration::from_millis(DEFAULT_WORKER_CONNECT_TIMEOUT_MS))
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
            Some("archived" | "crash") => "archived",
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
    // TS `summaryForInactiveSession` publishes the scan's own-usage
    // summary: the agents-view roster record reads it before the saved
    // catalog row's (own cost `daemon.usage ?? saved.usage`). The child's
    // own row carries the child spend, so rollups never double count.
    if let Some(usage) = &info.usage {
        if let Some(object) = row.as_object_mut() {
            object.insert("usage".to_string(), json!(usage));
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
    // TS `serializeSavedSessionInfo` publishes the scan's own-usage
    // summary: the agents-view spend columns and the archived-row
    // keep-condition read `saved.usage.cost`. The child's own row
    // carries the child spend, so rollups never double count.
    if let Some(usage) = &info.usage {
        object.insert("usage".to_string(), json!(usage));
    }
    // TS #2506 `serializeSavedSessionInfo`'s optional
    // `deletedDescendantUsage`: the recursive spend of ledger-tombstoned
    // descendants (the listing arm attaches it from the spawn ledger's
    // bucket). The agents-view recursive cost rollup adds it to this
    // row's own cost — the deleted child keeps no row anywhere, its
    // spend bills here exactly once.
    if let Some(deleted) = &info.deleted_descendant_usage {
        object.insert("deletedDescendantUsage".to_string(), json!(deleted));
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
            .route_command(
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

    /// A client that falls behind the shared event ring loses events (the
    /// broadcast's defined backpressure), but never silently anymore
    /// (finding 4a): the loss becomes a durable daemon-log line naming the
    /// client and the dropped count. Drives a real connection loop
    /// (`handle_client`) over a real socket pair with a flooded ring.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_lagged_client_event_stream_is_logged() {
        use tokio::io::AsyncReadExt as _;
        let dir = tempfile::TempDir::new().unwrap();
        let options = SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        };
        let log_path = crate::paths::daemon_log_path(&options.socket_path, &options.agent_dir);
        let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
        let (server_side, client_side) = tokio::net::UnixStream::pair().expect("socket pair");
        // The test's client only reads; its write half stays held so the
        // connection's writes fail only when the test ends.
        let (client_read, _client_write) = client_side.into_split();
        let connection = {
            let supervisor = Arc::clone(&supervisor);
            let stream: Box<dyn TransportStream> = Box::new(server_side);
            tokio::spawn(async move { supervisor.handle_client(stream).await })
        };
        // The handshake greeting arrives before the loop's first poll.
        let mut client = BufReader::new(client_read);
        let mut hello = String::new();
        client.read_line(&mut hello).await.expect("hello line");
        assert!(
            hello.contains("\"type\":\"daemon_hello\""),
            "the greeting: {hello}"
        );
        // Flood the ring well past its capacity with frames too big for
        // the client's socket buffer: the connection loop parks in its
        // event write, its receiver falls out of the ring's live window,
        // and the parked write only completes once the drain frees the
        // buffer again.
        let capacity = supervisor.events.capacity();
        let padding = "x".repeat(2048);
        let flood = capacity + 2048;
        for index in 0..flood {
            let _ = supervisor.events.send((
                ClientRouting::Broadcast,
                json!({ "type": "session_event", "index": index, "padding": padding }),
            ));
        }
        // Drain the parked connection to EOF-quiet: the loop unparks,
        // its next event read reports the dropped span, and the loss
        // lands in the daemon log.
        let mut buffer = vec![0u8; 64 * 1024];
        let mut quiet = 0;
        while quiet < 3 {
            match tokio::time::timeout(Duration::from_millis(150), client.read(&mut buffer)).await {
                Ok(Ok(0)) | Ok(Err(_)) | Err(_) => quiet += 1,
                Ok(Ok(_)) => quiet = 0,
            }
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let log = loop {
            let log = std::fs::read_to_string(&log_path).unwrap_or_default();
            if log.contains("lagged on the event ring") {
                break log;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the lagged drain was never logged; log: {log}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        let line = log
            .lines()
            .rev()
            .find(|line| line.contains("lagged on the event ring"))
            .expect("the lag line");
        assert!(
            line.contains("events dropped"),
            "the log names the dropped count: {line}"
        );
        connection.abort();
    }
}
