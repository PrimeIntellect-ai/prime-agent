//! Session registry: the supervisor's roster of resident session workers,
//! their durable identities, and worker self-registration records. Both
//! the supervisor's launch/adoption flows and worker self-registration
//! build entries; the per-worker adoption gate serializes the two paths.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use pa_types::daemon::DaemonWorkerDescriptor;
use serde_json::Value;
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::protocol::DaemonResponse;

pub(crate) struct WorkerRequest {
    pub(crate) request_id: String,
    pub(crate) command_type: String,
    pub(crate) payload: Value,
}

/// The worker's reply to one routed request: the typed response tree, or
/// the relayed bytes untouched (zero-copy route).
pub(crate) enum WorkerReply {
    Typed(DaemonResponse),
    Relayed(WorkerRelay),
}

/// A response the supervisor relays by bytes, plus the routing-header
/// scalars the frame carries (`None` means the header said nothing).
pub(crate) struct WorkerRelay {
    pub(crate) success: Option<bool>,
    pub(crate) active_session_id: Option<String>,
    /// The worker's serialized response payload: `response_line` bytes with
    /// the id field absent, so the object opens with `"type":"response"`.
    pub(crate) payload: Vec<u8>,
}

impl WorkerReply {
    pub(crate) fn typed(self) -> anyhow::Result<DaemonResponse> {
        match self {
            WorkerReply::Typed(response) => Ok(response),
            WorkerReply::Relayed(relay) => serde_json::from_slice::<DaemonResponse>(&relay.payload)
                .map_err(|error| anyhow!("invalid worker response: {error}")),
        }
    }

    pub(crate) fn relayed_payload(&self) -> Option<&[u8]> {
        match self {
            WorkerReply::Relayed(relay) => Some(&relay.payload),
            WorkerReply::Typed(_) => None,
        }
    }

    pub(crate) fn relayed_success(&self) -> Option<bool> {
        match self {
            WorkerReply::Relayed(relay) => relay.success,
            WorkerReply::Typed(_) => None,
        }
    }

    pub(crate) fn relayed_active_session_id(&self) -> Option<&str> {
        match self {
            WorkerReply::Relayed(relay) => relay.active_session_id.as_deref(),
            WorkerReply::Typed(_) => None,
        }
    }
}

/// Command-route liveness for one resident worker: `connected` tracks the
/// live socket, `session_ready` marks the create boundary a client command
/// must never overtake, `retired` marks a worker that will not come back.
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
    /// The worker's command pump channel, bounded at
    /// [`crate::backpressure::WORKER_INFLIGHT_CAPACITY`]: admission precedes
    /// enqueue, so the queue and in-flight set share one bound.
    pub(crate) cmd_tx: Mutex<Option<tokio::sync::mpsc::Sender<WorkerRequest>>>,
    /// The worker's in-flight permits (held until each reply resolves): a client command that finds
    /// this empty is refused with the typed overload error; supervisor-internal routes wait.
    pub(crate) inflight: Arc<tokio::sync::Semaphore>,
    pub(crate) pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<WorkerReply>>>,
    pub(crate) intentional_stop: AtomicBool,
    pub(crate) consecutive_failures: AtomicU32,
    /// Unix-millis spawn time of the current child (0 for an adopted pid): only a lifetime past the
    /// stable window earns a counter reset (spawn-dies-fast churn accumulates).
    pub(crate) spawned_at_ms: AtomicU64,
    /// The worker advertised `direct_peer_transport` in its `worker_auth` response.
    pub(crate) peer_transport_capable: AtomicBool,
    /// The last-good heartbeats catalog answer, tagged with its generation: served when the worker
    /// is too busy for a fresh list (fresh only while current).
    pub(crate) heartbeat_snapshot: Mutex<Option<WorkerHeartbeatSnapshot>>,
    /// The last selector-less `cron_list` answer, tagged with its generation: served without
    /// forwarding while current (at most one consult per generation).
    pub(crate) cron_snapshot: Mutex<Option<WorkerCronSnapshot>>,
    /// The heartbeat-catalog generation, bumped by every
    /// `heartbeats_changed`: a snapshot is fresh only while its generation is current.
    pub(crate) heartbeat_snapshot_generation: AtomicU64,
    /// Route liveness, published to waiters through a watch channel
    /// (routes sleep until route-ready or retired).
    route_state_tx: tokio::sync::watch::Sender<WorkerRouteState>,
    /// The root-identity persist is unresolved (the descriptor moved but the durable write failed):
    /// the next roster write re-runs it before a restart replays the superseded session.
    identity_persist_pending: AtomicBool,
    /// The boot-reconciliation quarantine: a resident whose live reconciliation pull failed is
    /// fenced from every identity-based route (the conservative miss, never a mis-delivery).
    identity_quarantined: AtomicBool,
    /// Monotonic connection epoch: only the current connection's pumps may flip `connected` false
    /// (a superseded socket's late EOF cannot retire a live replacement).
    connection_epoch: AtomicU64,
    /// The compaction-abort token: armed by `compaction_start`, cleared by
    /// `compaction_end`, so an `abort_compaction` never needs the worker's own answer.
    pub(crate) compaction: crate::compaction_supervision::CompactionSupervision,
    /// The pending owner-disconnect stop (TS `ownerCleanupTimer`).
    pub(crate) owner_cleanup: std::sync::Mutex<Option<tokio::task::AbortHandle>>,
}

/// The last-good heartbeats rows, tagged with the catalog generation they
/// were read at; only trustworthy while their generation is still current.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkerHeartbeatSnapshot {
    pub(crate) rows: Vec<Value>,
    pub(crate) generation: u64,
}

/// The last cron jobs a worker answered a selector-less `cron_list` with, tagged with their
/// generation: trustworthy only while current, so an invalidation forces the next consult.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WorkerCronSnapshot {
    pub(crate) jobs: Vec<pa_core::cron::AgentCronJob>,
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
            inflight: Arc::new(tokio::sync::Semaphore::new(
                crate::backpressure::WORKER_INFLIGHT_CAPACITY,
            )),
            pending: Mutex::new(HashMap::new()),
            intentional_stop: AtomicBool::new(false),
            consecutive_failures: AtomicU32::new(0),
            spawned_at_ms: AtomicU64::new(0),
            peer_transport_capable: AtomicBool::new(false),
            heartbeat_snapshot: Mutex::new(None),
            cron_snapshot: Mutex::new(None),
            heartbeat_snapshot_generation: AtomicU64::new(0),
            route_state_tx,
            identity_persist_pending: AtomicBool::new(false),
            identity_quarantined: AtomicBool::new(false),
            connection_epoch: AtomicU64::new(0),
            compaction: crate::compaction_supervision::CompactionSupervision::default(),
            owner_cleanup: std::sync::Mutex::new(None),
        })
    }

    pub(crate) fn route_state(&self) -> WorkerRouteState {
        *self.route_state_tx.borrow()
    }

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

    /// A live worker socket was wired. Returns the connection's epoch,
    /// which its pumps carry so only they can retire it.
    pub(crate) fn note_connection_live(&self) -> u64 {
        let epoch = self
            .connection_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        self.publish_route_state(|state| state.connected = true);
        epoch
    }

    pub(crate) fn connection_is_current(&self, epoch: u64) -> bool {
        epoch
            == self
                .connection_epoch
                .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Install the connection's channel for routing (post-auth only): a pre-auth connection stays
    /// private to its handshake (a route winning the enqueue race would strand it).
    pub(crate) async fn install_command_channel(
        &self,
        epoch: u64,
        cmd_tx: tokio::sync::mpsc::Sender<WorkerRequest>,
    ) {
        // The epoch recheck runs UNDER the channel lock: a stale connect
        // must never overwrite a newer connection's channel.
        let mut guard = self.cmd_tx.lock().await;
        if !self.connection_is_current(epoch) {
            return;
        }
        *guard = Some(cmd_tx);
    }

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

    pub(crate) fn note_session_ready(&self) {
        self.publish_route_state(|state| state.session_ready = true);
    }

    pub(crate) fn note_session_replaying(&self) {
        self.publish_route_state(|state| state.session_ready = false);
    }

    pub(crate) fn note_retired(&self) {
        self.publish_route_state(|state| state.retired = true);
    }

    pub(crate) fn identity_persist_pending(&self) -> bool {
        self.identity_persist_pending
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Mark the root-identity persist unresolved; the next roster write repairs it.
    pub(crate) fn mark_identity_persist_pending(&self) {
        self.identity_persist_pending
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub(crate) fn clear_identity_persist_pending(&self) {
        self.identity_persist_pending
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    pub(crate) fn mark_identity_quarantined(&self) {
        self.identity_quarantined
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Open the routing again: an accepted roster write carried the identity follow.
    pub(crate) fn clear_identity_quarantine(&self) {
        self.identity_quarantined
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    pub(crate) fn identity_quarantined(&self) -> bool {
        self.identity_quarantined
            .load(std::sync::atomic::Ordering::SeqCst)
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

    /// Store a catalog read as the last-good heartbeat snapshot,
    /// generation-monotonic (a late read cannot retag a newer one).
    pub(crate) async fn store_heartbeat_snapshot(&self, rows: Vec<Value>, generation: u64) {
        let mut snapshot = self.heartbeat_snapshot.lock().await;
        if snapshot
            .as_ref()
            .is_none_or(|stored| generation >= stored.generation)
        {
            *snapshot = Some(WorkerHeartbeatSnapshot { rows, generation });
        }
    }

    /// Store the last selector-less `cron_list` answer, under the same
    /// generation-monotonic discipline as [`Self::store_heartbeat_snapshot`].
    pub(crate) async fn store_cron_snapshot(
        &self,
        jobs: Vec<pa_core::cron::AgentCronJob>,
        generation: u64,
    ) {
        let mut snapshot = self.cron_snapshot.lock().await;
        if snapshot
            .as_ref()
            .is_none_or(|stored| generation >= stored.generation)
        {
            *snapshot = Some(WorkerCronSnapshot { jobs, generation });
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

/// Accepted registration state per worker: the identity plus the
/// registration count (epoch 1 = boot, epoch > 1 = re-registration after a supervisor restart).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RegistrationRecord {
    pub(crate) registration: WorkerRegistration,
    pub(crate) registered_at: String,
    pub(crate) epoch: u64,
}

/// Per-worker adoption lock: `lock_owned()` on the returned guard.
type AdoptionLock = Mutex<()>;

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

    pub(crate) async fn remove(&self, worker_id: &str) -> Option<Arc<ResidentWorker>> {
        self.workers.lock().await.remove(worker_id)
    }

    pub(crate) async fn clear(&self) {
        self.workers.lock().await.clear();
    }

    /// Forget a worker's registration bookkeeping (a terminal kill or
    /// max-failure stop) so long-lived supervisors do not accumulate one
    /// entry per session; a forgotten worker cannot re-register.
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

    /// The resident hosting one session file (the wake path reuses the
    /// owner); canonicalized, so a respawned descriptor path still matches.
    pub(crate) async fn find_by_session_file(
        &self,
        session_file: &str,
    ) -> Option<Arc<ResidentWorker>> {
        self.list_by_session_file(session_file)
            .await
            .into_iter()
            .next()
    }

    /// Every resident registered for one session file, order unspecified:
    /// a replacement window can briefly hold two; the caller classifies.
    pub(crate) async fn list_by_session_file(
        &self,
        session_file: &str,
    ) -> Vec<Arc<ResidentWorker>> {
        let target = std::path::Path::new(session_file)
            .canonicalize()
            .map_or_else(
                |_| session_file.to_string(),
                |path| path.to_string_lossy().to_string(),
            );
        let mut matches = Vec::new();
        for resident in self.list().await {
            // The boot-reconciliation quarantine: an unreconciled persisted
            // identity never serves a by-file reuse.
            if resident.identity_quarantined() {
                continue;
            }
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
                matches.push(resident);
            }
        }
        matches
    }

    /// The resident whose durable authentication token matches; `None` rejects with the auth error.
    pub(crate) async fn find_by_token(&self, token: &str) -> Option<Arc<ResidentWorker>> {
        for resident in self.list().await {
            if resident.descriptor.lock().await.authentication_token == token {
                return Some(resident);
            }
        }
        None
    }

    pub(crate) async fn record_registration(
        &self,
        registration: WorkerRegistration,
    ) -> RegistrationRecord {
        let mut registrations = self.registrations.lock().await;
        let epoch = registrations
            .get(&registration.active_session_id)
            .map_or(1, |record| record.epoch + 1);
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
    /// session name; errors for unknown and ambiguous selectors (the
    /// quarantined miss drives reconciliation).
    pub(crate) async fn resolve(&self, selector: &str) -> Result<Arc<ResidentWorker>> {
        if let Some(resident) = self.get(selector).await {
            if !resident.identity_quarantined() {
                return Ok(resident);
            }
        }
        let mut matches: Vec<(Arc<ResidentWorker>, String, String)> = Vec::new();
        for resident in self.list().await {
            if resident.identity_quarantined() {
                continue;
            }
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

    /// Per-worker gate serializing launch-adoption against
    /// self-registration; holders must not acquire another worker's gate while holding this one.
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
    use serde_json::Map;

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
                    rest: Map::default(),
                },
                consecutive_failures: 0,
                stop_requested_at: None,
                archive_on_stop: None,
                last_failure_at: None,
                last_error: None,
                rest: Map::default(),
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
        let guard = registry.adoption_guard("abc123def456").await;
        drop(guard);
        registry
            .record_registration(registration("abc123def456"))
            .await;
        registry.forget("abc123def456").await;
        // A terminal kill forgets the bookkeeping; no entry accumulates.
        assert!(registry.registrations.lock().await.is_empty());
        assert!(registry.adoption_locks.lock().await.is_empty());
        // A forgotten worker re-registering is epoch 1 again: unknown until re-adopted.
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
