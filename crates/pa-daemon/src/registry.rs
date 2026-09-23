//! Session registry: the supervisor's roster of resident session workers,
//! their durable identities, and worker self-registration records.
//!
//! The registry is the supervisor's core state under the thin-supervisor
//! architecture: which sessions exist, where each worker's socket is, and
//! how clients select them. Process supervision (spawn/restart/health) and
//! client command routing live in `supervisor.rs`; later migration stages
//! move routing out while the registry stays.
//!
//! Two paths build registry entries: the supervisor's own launch/adoption
//! flows, and session-worker self-registration
//! (`DaemonCommand::WorkerRegister`) - the path that rebuilds the roster
//! after a supervisor restart. A per-worker adoption gate serializes the two
//! so a worker is never adopted twice concurrently.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use pa_types::daemon::DaemonWorkerDescriptor;
use serde_json::Value;
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::protocol::DaemonResponse;

/// One supervisor -> worker private-frame request.
pub(crate) struct WorkerRequest {
    pub(crate) request_id: String,
    pub(crate) command_type: String,
    pub(crate) payload: Value,
}

/// Command-route liveness for one resident worker, watched by the
/// supervisor's replacement-aware route (`route_command_ready`):
/// `connected` tracks the live worker socket (both supervisor-side pumps
/// flip it false when the connection dies), `session_ready` marks the
/// worker's session-create boundary (a fresh create and a replacement's
/// create replay; a client command must never overtake it), and `retired`
/// marks a worker that will not come back (restart give-up, intentional
/// stop) so waiting routes fail fast instead of parking on the deadline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WorkerRouteState {
    pub(crate) connected: bool,
    pub(crate) session_ready: bool,
    pub(crate) retired: bool,
}

impl WorkerRouteState {
    fn initial() -> Self {
        Self {
            connected: false,
            session_ready: false,
            retired: false,
        }
    }
}

/// One resident session worker: the durable identity (descriptor) plus the
/// live request channel once the supervisor has connected to the worker.
pub(crate) struct ResidentWorker {
    pub(crate) worker_id: String,
    pub(crate) descriptor: Mutex<DaemonWorkerDescriptor>,
    pub(crate) descriptor_path: PathBuf,
    pub(crate) cmd_tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<WorkerRequest>>>,
    /// Pending replies for in-flight requests on the current connection.
    pub(crate) pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<DaemonResponse>>>,
    pub(crate) intentional_stop: AtomicBool,
    pub(crate) consecutive_failures: AtomicU32,
    /// Unix-millis timestamp of the current child's spawn (0 for an adopted
    /// pid we never spawned): the crash path measures the child's lifetime
    /// against it - only a lifetime past the stable window earns a counter
    /// reset, so spawn-dies-fast churn accumulates to the give-up cap.
    pub(crate) spawned_at_ms: AtomicU64,
    /// The worker advertised `direct_peer_transport` in its `worker_auth`
    /// response (TS `workerAuthAdvertisesPeerTransport`).
    pub(crate) peer_transport_capable: AtomicBool,
    /// The last-good selector-less heartbeats catalog the worker answered
    /// with (TS `worker.heartbeatSnapshot`), tagged with the catalog
    /// generation it was read at: served when the worker is too busy to
    /// answer a fresh list, so a slow turn cannot empty the merged catalog
    /// while its scheduler keeps firing. Fresh only while the generation
    /// is still current (see `heartbeat_snapshot_generation`).
    pub(crate) heartbeat_snapshot: Mutex<Option<WorkerHeartbeatSnapshot>>,
    /// The worker's heartbeat-catalog generation (TS
    /// `worker.heartbeatSnapshotStale` + the queued re-read): bumped by
    /// every `heartbeats_changed` invalidation. A snapshot is fresh only
    /// while its generation is current, so an in-flight catalog read —
    /// which captured an older generation — can never store itself back
    /// as fresh over a newer invalidation.
    pub(crate) heartbeat_snapshot_generation: AtomicU64,
    /// Route liveness, published to waiters through a watch channel (the
    /// replacement-aware route clones a receiver and sleeps until the
    /// worker is route-ready or retired).
    route_state_tx: tokio::sync::watch::Sender<WorkerRouteState>,
    /// Monotonic connection epoch: only the pumps of the current
    /// connection may flip `connected` false, so a superseded socket's
    /// late EOF cannot retire a live replacement.
    connection_epoch: AtomicU64,
}

/// The last-good heartbeats rows a worker answered with, tagged with the
/// catalog generation they were read at (TS `worker.heartbeatSnapshot`):
/// the rows are only trustworthy while their generation is still current
/// (TS `worker.heartbeatSnapshotStale !== true`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkerHeartbeatSnapshot {
    pub(crate) rows: Vec<Value>,
    pub(crate) generation: u64,
}

impl ResidentWorker {
    pub(crate) fn new(
        worker_id: String,
        descriptor: DaemonWorkerDescriptor,
        descriptor_path: PathBuf,
    ) -> Arc<Self> {
        let (route_state_tx, _) = tokio::sync::watch::channel(WorkerRouteState::initial());
        Arc::new(ResidentWorker {
            worker_id,
            descriptor: Mutex::new(descriptor),
            descriptor_path,
            cmd_tx: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            intentional_stop: AtomicBool::new(false),
            consecutive_failures: AtomicU32::new(0),
            spawned_at_ms: AtomicU64::new(0),
            peer_transport_capable: AtomicBool::new(false),
            heartbeat_snapshot: Mutex::new(None),
            heartbeat_snapshot_generation: AtomicU64::new(0),
            route_state_tx,
            connection_epoch: AtomicU64::new(0),
        })
    }

    pub(crate) fn route_state(&self) -> WorkerRouteState {
        *self.route_state_tx.borrow()
    }

    /// A receiver that follows every route-state transition (the
    /// replacement-aware route waits on it).
    pub(crate) fn route_state_watcher(&self) -> tokio::sync::watch::Receiver<WorkerRouteState> {
        self.route_state_tx.subscribe()
    }

    fn publish_route_state(&self, edit: impl FnOnce(&mut WorkerRouteState)) {
        self.route_state_tx.send_if_modified(|state| {
            let mut next = *state;
            edit(&mut next);
            if next == *state {
                false
            } else {
                *state = next;
                true
            }
        });
    }

    /// The supervisor wired a live worker socket (a fresh launch, a
    /// replacement relaunch, or an adoption): connections become routable
    /// from this moment. Returns the connection's epoch, which the
    /// reader/writer pumps carry so only this connection can retire it.
    pub(crate) fn note_connection_live(&self) -> u64 {
        let epoch = self
            .connection_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        self.publish_route_state(|state| state.connected = true);
        epoch
    }

    /// A connection's pumps ended (worker death or socket close). Stale
    /// epochs (a superseded connection ending late) never flip the state.
    pub(crate) fn note_connection_lost(&self, epoch: u64) {
        if epoch
            != self
                .connection_epoch
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        self.publish_route_state(|state| state.connected = false);
    }

    /// The worker's session create completed (the fresh create response or
    /// the replacement's create replay): client commands may now be routed
    /// to it without overtaking the session into existence.
    pub(crate) fn note_session_ready(&self) {
        self.publish_route_state(|state| state.session_ready = true);
    }

    /// A replacement started: the create replay is pending, so routed
    /// commands must wait for the replayed session.
    pub(crate) fn note_session_replaying(&self) {
        self.publish_route_state(|state| state.session_ready = false);
    }

    /// The worker will not come back (restart give-up or an intentional
    /// stop): waiting routes fail fast instead of parking.
    pub(crate) fn note_retired(&self) {
        self.publish_route_state(|state| state.retired = true);
    }

    /// Selector labels: root active session id, session-file stem, name.
    pub(crate) async fn labels(&self) -> (String, String, String) {
        let descriptor = self.descriptor.lock().await;
        let session_file = descriptor.session_file.as_deref().unwrap_or_default();
        let file_stem = std::path::Path::new(session_file)
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default();
        let name = descriptor
            .create_command
            .rest
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        (descriptor.root_active_session_id.clone(), file_stem, name)
    }

    /// Store a catalog read as the worker's last-good heartbeat snapshot.
    ///
    /// The store is generation-monotonic: a read whose captured generation
    /// is older than the stored snapshot's never replaces it, so a late
    /// in-flight read cannot retag a newer snapshot as stale (freshness is
    /// `stored.generation == current`) or drop the last-good rows a
    /// busy-worker fallback serves. A read in the stored generation still
    /// refreshes the rows, because the catalog is constant within a
    /// generation.
    pub(crate) async fn store_heartbeat_snapshot(&self, rows: Vec<Value>, generation: u64) {
        let mut snapshot = self.heartbeat_snapshot.lock().await;
        if snapshot
            .as_ref()
            .is_none_or(|stored| generation >= stored.generation)
        {
            *snapshot = Some(WorkerHeartbeatSnapshot { rows, generation });
        }
    }
}

/// Identity presented by a session worker's `worker_register` command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkerRegistration {
    pub(crate) active_session_id: String,
    pub(crate) session_id: Option<String>,
    pub(crate) socket_path: String,
    pub(crate) worker_instance_id: Option<String>,
    pub(crate) pid: u64,
}

/// Accepted registration state per worker: the identity plus how many times
/// this supervisor has seen it register (epoch 1 = boot registration,
/// epoch > 1 = re-registration after a supervisor restart).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RegistrationRecord {
    pub(crate) registration: WorkerRegistration,
    pub(crate) registered_at: String,
    pub(crate) epoch: u64,
}

/// Per-worker adoption lock: `lock_owned()` on the returned guard.
type AdoptionLock = Mutex<()>;

/// The roster of resident session workers and their registration records.
pub(crate) struct SessionRegistry {
    workers: Mutex<HashMap<String, Arc<ResidentWorker>>>,
    registrations: Mutex<HashMap<String, RegistrationRecord>>,
    adoption_locks: Mutex<HashMap<String, Arc<AdoptionLock>>>,
}

impl SessionRegistry {
    pub(crate) fn new() -> Self {
        SessionRegistry {
            workers: Mutex::new(HashMap::new()),
            registrations: Mutex::new(HashMap::new()),
            adoption_locks: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) async fn insert(&self, resident: Arc<ResidentWorker>) {
        self.workers
            .lock()
            .await
            .insert(resident.worker_id.clone(), resident);
    }

    /// Remove a worker; returns it when it was registered.
    pub(crate) async fn remove(&self, worker_id: &str) -> Option<Arc<ResidentWorker>> {
        self.workers.lock().await.remove(worker_id)
    }

    pub(crate) async fn clear(&self) {
        self.workers.lock().await.clear();
    }

    /// Forget a worker's registration bookkeeping: its registration record
    /// and adoption gate. Called when the worker is terminally gone (a kill
    /// or the max-failure stop) so long-lived supervisors do not
    /// accumulate one map entry per session ever created. A forgotten
    /// worker cannot re-register: its descriptor is removed with it, so a
    /// later `worker_register` fails with the TS unknown-worker error.
    pub(crate) async fn forget(&self, worker_id: &str) {
        self.registrations.lock().await.remove(worker_id);
        self.adoption_locks.lock().await.remove(worker_id);
    }

    pub(crate) async fn get(&self, worker_id: &str) -> Option<Arc<ResidentWorker>> {
        self.workers.lock().await.get(worker_id).cloned()
    }

    /// Snapshot of all residents, insertion order unspecified.
    pub(crate) async fn list(&self) -> Vec<Arc<ResidentWorker>> {
        self.workers.lock().await.values().cloned().collect()
    }

    /// The resident hosting one session file (TS `findWorkerBySessionFile`):
    /// the wake path reuses a worker that already owns the saved file instead
    /// of spawning a second one over it. Canonicalized comparison, so a
    /// respawned worker's descriptor path still matches.
    pub(crate) async fn find_by_session_file(
        &self,
        session_file: &str,
    ) -> Option<Arc<ResidentWorker>> {
        let target = std::path::Path::new(session_file)
            .canonicalize()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| session_file.to_string());
        for resident in self.list().await {
            let owned = resident
                .descriptor
                .lock()
                .await
                .session_file
                .clone()
                .unwrap_or_default();
            let owned = std::path::Path::new(&owned)
                .canonicalize()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or(owned);
            if owned == target {
                return Some(resident);
            }
        }
        None
    }

    /// The resident whose durable authentication token matches (worker-
    /// authenticated supervisor requests, the TS `list_agent_peers`
    /// requester lookup). `None` rejects with the TS auth error.
    pub(crate) async fn find_by_token(&self, token: &str) -> Option<Arc<ResidentWorker>> {
        for resident in self.list().await {
            if resident.descriptor.lock().await.authentication_token == token {
                return Some(resident);
            }
        }
        None
    }

    /// Record an accepted registration; bumps the epoch when the worker had
    /// already registered on this supervisor (re-registration).
    pub(crate) async fn record_registration(
        &self,
        registration: WorkerRegistration,
    ) -> RegistrationRecord {
        let mut registrations = self.registrations.lock().await;
        let epoch = registrations
            .get(&registration.active_session_id)
            .map(|record| record.epoch + 1)
            .unwrap_or(1);
        let record = RegistrationRecord {
            registration,
            registered_at: crate::util::now_iso(),
            epoch,
        };
        registrations.insert(
            record.registration.active_session_id.clone(),
            record.clone(),
        );
        record
    }

    /// Resolve one session worker by any accepted selector: the full root
    /// active session id, a suffix of it, the session-file stem, or the
    /// session name. Errors for unknown and ambiguous selectors.
    pub(crate) async fn resolve(&self, selector: &str) -> Result<Arc<ResidentWorker>> {
        if let Some(resident) = self.get(selector).await {
            return Ok(resident);
        }
        let mut matches: Vec<(Arc<ResidentWorker>, String, String)> = Vec::new();
        for resident in self.list().await {
            let (root_id, file_stem, name) = resident.labels().await;
            if selector_matches(&root_id, selector)
                || selector_matches(&file_stem, selector)
                || (!name.is_empty() && name == selector)
            {
                matches.push((resident, root_id, name));
            }
        }
        if matches.len() == 1 {
            return Ok(matches.pop().map(|(r, ..)| r).expect("one match"));
        }
        if matches.len() > 1 {
            let rendered = matches
                .iter()
                .map(|(_, root, name)| {
                    if name.is_empty() {
                        root.clone()
                    } else {
                        format!("{root} ({name})")
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            return Err(anyhow!(
                "Ambiguous active session \"{selector}\": matches {rendered}"
            ));
        }
        Err(anyhow!("Unknown active session: {selector}"))
    }

    /// Per-worker gate serializing launch-adoption against self-registration
    /// for the same worker id. Holders must not acquire another worker's
    /// gate while holding this one.
    pub(crate) async fn adoption_guard(&self, worker_id: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.adoption_locks.lock().await;
            Arc::clone(locks.entry(worker_id.to_string()).or_default())
        };
        lock.lock_owned().await
    }
}

pub(crate) fn selector_matches(candidate: &str, suffix: &str) -> bool {
    let normalize = |value: &str| -> String { value.replace('-', "").to_lowercase() };
    let candidate = normalize(candidate);
    let suffix = normalize(suffix);
    !candidate.is_empty() && !suffix.is_empty() && candidate.ends_with(&suffix)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resident(worker_id: &str) -> Arc<ResidentWorker> {
        ResidentWorker::new(
            worker_id.to_string(),
            DaemonWorkerDescriptor {
                version: 2,
                worker_id: worker_id.to_string(),
                pid: 1,
                process_start_id: None,
                socket_path: "/w.sock".to_string(),
                recovery_journal_path: "/w.jsonl".to_string(),
                orphan_process_journal_path: None,
                supervisor_socket_path: "/s.sock".to_string(),
                authentication_token: "t".to_string(),
                worker_instance_id: None,
                root_active_session_id: worker_id.to_string(),
                owner_client_id: None,
                root_session_id: None,
                session_file: Some("/sessions/some-session.jsonl".to_string()),
                session_dir: None,
                telemetry_disabled: None,
                created_at: "t".to_string(),
                updated_at: "t".to_string(),
                lifecycle: pa_types::daemon::DaemonWorkerLifecycle::Ready,
                create_command: pa_types::daemon::DurableDaemonCreateCommand {
                    session_path: None,
                    no_session: None,
                    rest: Default::default(),
                },
                consecutive_failures: 0,
                stop_requested_at: None,
                archive_on_stop: None,
                last_failure_at: None,
                last_error: None,
                rest: Default::default(),
            },
            PathBuf::from("/d.json"),
        )
    }

    fn registration(worker_id: &str) -> WorkerRegistration {
        WorkerRegistration {
            active_session_id: worker_id.to_string(),
            session_id: Some("session-uuid".to_string()),
            socket_path: "/w.sock".to_string(),
            worker_instance_id: Some("inst".to_string()),
            pid: 7,
        }
    }

    #[tokio::test]
    async fn registrations_bump_epoch_and_records_survive_removal() {
        let registry = SessionRegistry::new();
        let worker = resident("abc123def456");
        registry.insert(Arc::clone(&worker)).await;
        let first = registry
            .record_registration(registration("abc123def456"))
            .await;
        assert_eq!(first.epoch, 1);
        registry.remove("abc123def456").await;
        let second = registry
            .record_registration(registration("abc123def456"))
            .await;
        assert_eq!(second.epoch, 2);
        assert!(registry.get("abc123def456").await.is_none());
    }

    #[tokio::test]
    async fn resolve_by_suffix_and_name() {
        let registry = SessionRegistry::new();
        let named = resident("aaa111bbb222");
        {
            let mut descriptor = named.descriptor.lock().await;
            descriptor
                .create_command
                .rest
                .insert("name".to_string(), Value::from("faux"));
        }
        registry.insert(named).await;
        registry.insert(resident("ccc333ddd444")).await;
        let by_suffix = registry.resolve("bbb222").await.expect("suffix matches");
        assert_eq!(by_suffix.worker_id, "aaa111bbb222");
        let by_name = registry.resolve("faux").await.expect("name matches");
        assert_eq!(by_name.worker_id, "aaa111bbb222");
        assert!(registry.resolve("zzz").await.is_err());
    }

    #[tokio::test]
    async fn forget_drops_registration_and_adoption_gate() {
        let registry = SessionRegistry::new();
        registry.insert(resident("abc123def456")).await;
        let _guard = registry.adoption_guard("abc123def456").await;
        drop(_guard);
        registry
            .record_registration(registration("abc123def456"))
            .await;
        registry.forget("abc123def456").await;
        // Long-lived supervisors must not accumulate one map entry per
        // session ever created: a terminal kill forgets the bookkeeping.
        assert!(registry.registrations.lock().await.is_empty());
        assert!(registry.adoption_locks.lock().await.is_empty());
        // A forgotten worker re-registering is epoch 1 again: it is
        // unknown to this supervisor until re-adopted.
        let record = registry
            .record_registration(registration("abc123def456"))
            .await;
        assert_eq!(record.epoch, 1);
    }

    #[tokio::test]
    async fn adoption_guard_serializes_same_worker() {
        let registry = Arc::new(SessionRegistry::new());
        let first = {
            let registry = Arc::clone(&registry);
            tokio::spawn(async move {
                let _guard = registry.adoption_guard("w1").await;
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        let started = std::time::Instant::now();
        let _guard = registry.adoption_guard("w1").await;
        assert!(
            started.elapsed() >= std::time::Duration::from_millis(30),
            "second guard waited for the first"
        );
        let _ = first.await;
    }

    #[tokio::test]
    async fn an_older_catalog_read_never_poisons_the_stored_snapshot() {
        use serde_json::json;

        let worker = resident("poison");
        worker
            .store_heartbeat_snapshot(vec![json!({"job": {"id": "first"}})], 5)
            .await;
        worker
            .store_heartbeat_snapshot(vec![json!({"job": {"id": "second"}})], 6)
            .await;
        // A late read that captured generation 5 returning after the
        // generation-6 store must not retag the newer snapshot as stale.
        worker
            .store_heartbeat_snapshot(vec![json!({"job": {"id": "late"}})], 5)
            .await;
        let snapshot = worker.heartbeat_snapshot.lock().await.clone();
        assert_eq!(
            snapshot,
            Some(WorkerHeartbeatSnapshot {
                rows: vec![json!({"job": {"id": "second"}})],
                generation: 6,
            })
        );
        // A read in the stored generation refreshes the rows.
        worker
            .store_heartbeat_snapshot(vec![json!({"job": {"id": "refreshed"}})], 6)
            .await;
        let snapshot = worker.heartbeat_snapshot.lock().await.clone();
        assert_eq!(
            snapshot,
            Some(WorkerHeartbeatSnapshot {
                rows: vec![json!({"job": {"id": "refreshed"}})],
                generation: 6,
            })
        );
    }
}
