//! The create-open reuse seam (TS `createOrReuseWorker`'s reuse half): a
//! create that targets a session file a live worker already serves answers
//! THE LIVE WORKER instead of launching over the same file (the second
//! worker's create would bounce off the live one's session lease).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use pa_types::daemon::{DaemonCommand, DaemonSessionLifecycle};
use serde_json::{json, Value};

use crate::backpressure::RouteAdmission;
use crate::registry::ResidentWorker;
use crate::supervisor::{Supervisor, ROUTE_TIMEOUT_MS, WORKER_NOT_CONNECTED};

/// How many settled teardown waits one open re-checks before it answers the typed
/// `worker is {state}` error (a holder that never dies must not ping-pong the open).
const SETTLED_WAIT_ROUNDS: usize = 2;

/// How long an open waits for a stopping worker's teardown before it answers
/// the `worker is stopping` error (the dying process still holds the lease).
const STOP_SETTLE_WAIT: Duration = Duration::from_secs(10);
const STOP_SETTLE_POLL: Duration = Duration::from_millis(50);
/// How long a concurrent open waits for the per-file single-flight before it answers the
/// `worker is starting` shape (a sibling's whole launch holds the lock).
const OPENING_LOCK_WAIT: Duration = Duration::from_mins(2);

/// What reusing one resident answered: the live binding's summary, or a
/// holder whose teardown frees the file.
enum ReuseAnswer {
    Summary(Value),
    HolderGone,
}

/// The held per-file single-flight. Dropping it releases the mutex and then
/// retires the map entry when no other opener is waiting (else a
/// history-heavy daemon leaks one entry per session file ever opened).
pub(crate) struct OpeningGuard<'a> {
    supervisor: &'a Supervisor,
    key: String,
    guard: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl Drop for OpeningGuard<'_> {
    fn drop(&mut self) {
        // The mutex releases first: a concurrent opener's count keeps the entry alive, so the
        // retirement below only lands when this was the last one.
        self.guard.take();
        self.supervisor.retire_opening_entry(&self.key);
    }
}

/// The residents registered for one session file, by reuse class.
#[derive(Default)]
struct ReuseCandidates {
    /// Connected, create completed, and not stopping: reused now.
    ready: Option<Arc<ResidentWorker>>,
    /// Neither stopping nor retired: a replacement may still be coming
    /// (crash backoff, create replay), so an open waits it out.
    waitable: Option<Arc<ResidentWorker>>,
    /// Stopping or retired: the launch must wait out its teardown.
    stopping: Option<Arc<ResidentWorker>>,
}

/// The single-flight key for one session file (the registry's comparison
/// rule: canonicalize when the path exists, keep the raw path otherwise).
fn canonical_opening_key(path: &Path) -> String {
    path.canonicalize().map_or_else(
        |_| path.to_string_lossy().to_string(),
        |canonical| canonical.to_string_lossy().to_string(),
    )
}

/// Whether one resident's process is provably gone, identity-aware: a recycled
/// pid is a DIFFERENT process, so the original holder is gone and its file is
/// free. A pid the platform cannot answer for counts as alive.
async fn resident_process_alive(resident: &Arc<ResidentWorker>) -> bool {
    let (pid, start_id) = {
        let descriptor = resident.descriptor.lock().await;
        (descriptor.pid, descriptor.process_start_id.clone())
    };
    if pid == 0 {
        return false;
    }
    if !crate::lease::is_process_alive(pid as u32).unwrap_or(true) {
        return false;
    }
    match start_id.as_deref() {
        None => true,
        Some(expected) => match crate::lease::get_process_start_id(pid as u32) {
            Some(current) => current == expected,
            None => true,
        },
    }
}

/// The create's target session file, resolved once for the whole open (the single-flight
/// key and the reuse lookup share one resolution); `Ok(None)` for creates with no file.
fn create_target_file(command: &DaemonCommand) -> Result<Option<PathBuf>> {
    let DaemonCommand::Create {
        session_path,
        no_session,
        ..
    } = command
    else {
        return Ok(None);
    };
    if *no_session == Some(true) {
        return Ok(None);
    }
    let Some(raw_path) = session_path.as_deref() else {
        return Ok(None);
    };
    let path = crate::paths::expand_tilde(raw_path)?;
    Ok(path.exists().then_some(path))
}

impl Supervisor {
    /// The per-file open single-flight (TS `openingWorkers`'s join): one create at a time
    /// per session file, so a concurrent open finds the first open's worker, not a race.
    /// `Ok(None)` for creates that address no existing file.
    pub(crate) async fn opening_guard(
        &self,
        command: &DaemonCommand,
    ) -> Result<Option<OpeningGuard<'_>>> {
        let Some(path) = create_target_file(command)? else {
            return Ok(None);
        };
        let key = canonical_opening_key(&path);
        let lock = {
            let mut map = self
                .opening_files
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            map.entry(key.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        // A sibling open holds the lock for its whole launch; the wait is bounded so a wedged
        // sibling answers the TS `worker is starting` shape instead of parking the client forever.
        // A timed-out wait drops its Arc, so it never pins the map entry.
        let guard = tokio::time::timeout(OPENING_LOCK_WAIT, lock.lock_owned())
            .await
            .map_err(|_| anyhow!("Session \"{}\" worker is starting", path.to_string_lossy()))?;
        Ok(Some(OpeningGuard {
            supervisor: self,
            key,
            guard: Some(guard),
        }))
    }

    /// Retire a released guard's map entry when no other opener is waiting
    /// on the file: the Arc's strong count is the coordination truth.
    fn retire_opening_entry(&self, key: &str) {
        let mut map = self
            .opening_files
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(entry) = map.get(key) {
            if Arc::strong_count(entry) == 1 {
                map.remove(key);
            }
        }
    }

    /// TS `createOrReuseWorker`'s reuse half: when a resident already serves the create's
    /// session file, answer the LIVE binding (the resident's root summary — the create response
    /// shape the client's attach consumes) instead of launching over the same file.
    pub(crate) async fn reuse_live_worker_for_create(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: &str,
    ) -> Result<Option<Value>> {
        let DaemonCommand::Create { lifecycle, .. } = command else {
            return Ok(None);
        };
        let Some(path) = create_target_file(command)? else {
            return Ok(None);
        };
        let path_text = path.to_string_lossy().to_string();

        // Each wait re-checks the file's residents before launching over it:
        // a settled teardown may have handed the file to a concurrent opener's
        // successor.
        let mut settled_waits = 0;
        loop {
            let residents = self.registry.list_by_session_file(&path_text).await;
            let mut candidates = ReuseCandidates::default();
            for resident in residents {
                let state = resident.route_state();
                if self.is_stopping(&resident) || state.retired {
                    candidates.stopping.get_or_insert(resident);
                } else if state.connected && state.session_ready {
                    candidates.ready.get_or_insert(resident);
                } else {
                    candidates.waitable.get_or_insert(resident);
                }
            }

            // The live binding answers first: a route-ready resident is the
            // session's current worker; a resident whose replacement is still
            // coming is waited out, then reused the same way.
            for class in [&candidates.ready, &candidates.waitable] {
                let Some(resident) = class else {
                    continue;
                };
                if let Some(rejection) =
                    client_owned_conflict(resident, *lifecycle, client_id, &path_text).await
                {
                    return Err(anyhow!(rejection));
                }
                match self.reuse_summary_or_holder(resident, &path_text).await? {
                    ReuseAnswer::Summary(summary) => return Ok(Some(summary)),
                    // The routed resident went away with no successor: its teardown must
                    // settle, then the fresh classification re-checks the file (including any
                    // waitable successor).
                    ReuseAnswer::HolderGone => {
                        settled_waits += 1;
                        if settled_waits > SETTLED_WAIT_ROUNDS {
                            bail!(
                                "Session \"{path_text}\" worker is {}",
                                self.effective_reuse_state(resident).await
                            );
                        }
                        self.await_holder_gone(resident, &path_text).await?;
                    }
                }
            }

            // A stopping or retired resident still owns the lease until its process dies: wait
            // out the settle window so the fresh launch lands on a free file.
            let Some(holder) = candidates.stopping.clone() else {
                // No resident serves the file: the launch path (a stale binding
                // rebinds through `record_session_binding` at create success).
                return Ok(None);
            };
            settled_waits += 1;
            if settled_waits > SETTLED_WAIT_ROUNDS {
                bail!(
                    "Session \"{path_text}\" worker is {}",
                    self.effective_reuse_state(&holder).await
                );
            }
            self.await_holder_gone(&holder, &path_text).await?;
        }
    }

    /// The summary a reused worker answers the create with: the live binding's
    /// root state. The route is replacement-aware, so an open landing mid-replay
    /// attaches once the replacement's create replay completed.
    async fn reuse_summary_or_holder(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
        session_path: &str,
    ) -> Result<ReuseAnswer> {
        match self
            .route_command_ready_typed(
                resident,
                "get_state",
                json!({}),
                ROUTE_TIMEOUT_MS,
                RouteAdmission::SupervisorInternal,
            )
            .await
        {
            Ok(response) => {
                let data = response.data.filter(serde_json::Value::is_object);
                match (response.success, data) {
                    (true, Some(data)) => Ok(ReuseAnswer::Summary(data)),
                    _ => Err(anyhow!(
                        "Session \"{session_path}\" worker is unavailable for reuse: \
                         assigned root session is missing"
                    )),
                }
            }
            // The worker retired with no successor in flight: its registry row may be gone while
            // its process still holds the lease, so the caller waits for the confirmed death.
            Err(error) if error.to_string() == WORKER_NOT_CONNECTED => Ok(ReuseAnswer::HolderGone),
            Err(_) => {
                let state = self.effective_reuse_state(resident).await;
                let detail = {
                    let last_error = resident.descriptor.lock().await.last_error.clone();
                    last_error
                        .map(|error| format!(": {error}"))
                        .unwrap_or_default()
                };
                Err(anyhow!(
                    "Session \"{session_path}\" worker is {state}{detail}"
                ))
            }
        }
    }

    /// Wait until a holder that will not serve the create again is confirmed gone: only the
    /// process death frees the session file (the registry row leaves first); past the settle
    /// budget the open answers the TS `worker is {state}` shape — never the lease rejection.
    async fn await_holder_gone(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
        session_path: &str,
    ) -> Result<()> {
        let deadline = tokio::time::Instant::now() + STOP_SETTLE_WAIT;
        loop {
            if !resident_process_alive(resident).await {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                bail!(
                    "Session \"{session_path}\" worker is {}",
                    self.effective_reuse_state(resident).await
                );
            }
            tokio::time::sleep(STOP_SETTLE_POLL).await;
        }
    }

    /// TS `effectiveWorkerState` for a reuse answer (the peer-tickets
    /// definition stays the one source).
    async fn effective_reuse_state(&self, resident: &Arc<ResidentWorker>) -> &'static str {
        let connected = resident.cmd_tx.lock().await.is_some();
        let lifecycle = resident.descriptor.lock().await.lifecycle;
        crate::peer_tickets::effective_worker_state(
            connected,
            lifecycle,
            self.is_stopping(resident),
        )
    }
}

/// TS `assertWorkerCreateOwner`: only an explicit client-owned create is exclusive. A
/// client-owned open of another client's worker keeps the `SessionAlreadyActiveError`
/// rejection — naming the LIVE binding's active id, never the stale lease id.
async fn client_owned_conflict(
    resident: &Arc<ResidentWorker>,
    lifecycle: Option<DaemonSessionLifecycle>,
    client_id: &str,
    session_path: &str,
) -> Option<String> {
    if lifecycle != Some(DaemonSessionLifecycle::ClientOwned) {
        return None;
    }
    let (owner, live_id) = {
        let descriptor = resident.descriptor.lock().await;
        (
            descriptor.owner_client_id.clone(),
            descriptor.root_active_session_id.clone(),
        )
    };
    match owner.as_deref() {
        Some(owner) if owner != client_id => Some(format!(
            "Session is already active in {live_id}: {session_path}"
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resident_with(
        owner_client_id: Option<&str>,
        root_active_session_id: &str,
    ) -> Arc<ResidentWorker> {
        let descriptor: pa_types::daemon::DaemonWorkerDescriptor =
            serde_json::from_value(serde_json::json!({
                "version": 2,
                "workerId": "w-1",
                "pid": 0,
                "socketPath": "/tmp/none.sock",
                "recoveryJournalPath": "/tmp/none.jsonl",
                "supervisorSocketPath": "/tmp/none.sock",
                "authenticationToken": "test",
                "rootActiveSessionId": root_active_session_id,
                "ownerClientId": owner_client_id,
                "createdAt": "2026-09-23T00:00:00Z",
                "updatedAt": "2026-09-23T00:00:00Z",
                "lifecycle": "ready",
                "createCommand": {},
                "consecutiveFailures": 0,
            }))
            .expect("descriptor");
        ResidentWorker::new(
            "w-1".to_string(),
            descriptor,
            std::path::PathBuf::from("/tmp/none"),
        )
    }

    #[tokio::test]
    async fn a_client_owned_create_names_the_live_binding_on_owner_conflicts() {
        let resident = resident_with(Some("daemon-tui:1"), "live-id");
        let conflict = client_owned_conflict(
            &resident,
            Some(DaemonSessionLifecycle::ClientOwned),
            "daemon-tui:2",
            "/sessions/s.jsonl",
        )
        .await
        .expect("the owner conflict rejects");
        assert_eq!(
            conflict,
            "Session is already active in live-id: /sessions/s.jsonl"
        );
    }

    #[tokio::test]
    async fn a_plain_create_never_conflicts_on_ownership() {
        let resident = resident_with(Some("daemon-tui:1"), "live-id");
        assert!(
            client_owned_conflict(&resident, None, "daemon-tui:2", "/s.jsonl")
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn the_owning_clients_reopen_reuses() {
        let resident = resident_with(Some("daemon-tui:1"), "live-id");
        assert!(client_owned_conflict(
            &resident,
            Some(DaemonSessionLifecycle::ClientOwned),
            "daemon-tui:1",
            "/s.jsonl"
        )
        .await
        .is_none());
    }

    #[tokio::test]
    async fn an_unowned_worker_is_reusable() {
        let resident = resident_with(None, "live-id");
        assert!(client_owned_conflict(
            &resident,
            Some(DaemonSessionLifecycle::ClientOwned),
            "daemon-tui:2",
            "/s.jsonl"
        )
        .await
        .is_none());
    }

    #[tokio::test]
    async fn an_unlaunched_registration_counts_as_dead() {
        let resident = resident_with(None, "live-id");
        assert!(!resident_process_alive(&resident).await);
    }

    fn resident_with_identity(pid: u64, start_id: Option<&str>) -> Arc<ResidentWorker> {
        let mut descriptor = serde_json::json!({
            "version": 2,
            "workerId": "w-1",
            "pid": pid,
            "socketPath": "/tmp/none.sock",
            "recoveryJournalPath": "/tmp/none.jsonl",
            "supervisorSocketPath": "/tmp/none.sock",
            "authenticationToken": "test",
            "rootActiveSessionId": "live-id",
            "ownerClientId": serde_json::Value::Null,
            "createdAt": "2026-09-23T00:00:00Z",
            "updatedAt": "2026-09-23T00:00:00Z",
            "lifecycle": "ready",
            "createCommand": {},
            "consecutiveFailures": 0,
        });
        if let Some(start_id) = start_id {
            descriptor["processStartId"] = serde_json::json!(start_id);
        }
        ResidentWorker::new(
            "w-1".to_string(),
            serde_json::from_value(descriptor).expect("descriptor"),
            std::path::PathBuf::from("/tmp/none"),
        )
    }

    #[tokio::test]
    async fn the_spawned_identity_keeps_a_live_holder_alive() {
        let pid = std::process::id();
        let start_id = crate::lease::get_process_start_id(pid);
        let resident = resident_with_identity(u64::from(pid), start_id.as_deref());
        assert!(resident_process_alive(&resident).await);
    }

    #[tokio::test]
    async fn a_recycled_pid_counts_as_dead() {
        let pid = std::process::id();
        let resident = resident_with_identity(u64::from(pid), Some("1/1"));
        assert!(!resident_process_alive(&resident).await);
    }

    #[tokio::test]
    async fn an_unverifiable_identity_counts_as_alive() {
        let pid = std::process::id();
        let resident = resident_with_identity(u64::from(pid), None);
        assert!(resident_process_alive(&resident).await);
    }
}
