//! The create-open reuse seam (TS `createOrReuseWorker`'s reuse half): a
//! create that targets a session file a live worker already serves answers
//! THE LIVE WORKER instead of launching a second process over the same
//! file. The second launch is not a duplicate — it is a guaranteed failure:
//! the runtime session lease the live worker holds makes the new worker's
//! create bounce with `Session is already active`, which the client saw as
//! a bare rejection of its open request. TS never launches over a live
//! file (`matchWorkers`/`findWorkerBySessionFile` -> `reuseWorkerForCreate`
//! -> the create arm answers the live worker's root summary; the client
//! attaches, the roster's clients column gains a row).
//!
//! The seam classifies every resident registered for the file:
//! - **route-ready** (connected, create completed): reused immediately.
//! - **waitable** (a replacement mid-replay or crash backoff): the open
//!   waits out the replacement inside the create's own route budget, like
//!   every client-facing route, then reuses; a worker that never returns
//!   (retired, give-up) falls through to a fresh launch, and a fresh
//!   launch over a dead process's file reclaims its lease by construction.
//! - **stopping/retired**: the launch must wait out the teardown — the
//!   dying process still holds the lease — then launch; a stop that
//!   outlives the settle budget answers the TS `worker is stopping` shape
//!   instead of surfacing the lease rejection.
//!
//! A stale binding (the file's previous worker is gone) keeps the launch
//! path: `record_session_binding` supersedes the old ids at create success
//! and the `session_binding` events re-attach the superseded clients
//! (the #2575 rebind seams; unchanged here).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use pa_types::daemon::{DaemonCommand, DaemonSessionLifecycle};
use serde_json::{json, Value};

use crate::registry::ResidentWorker;
use crate::supervisor::{Supervisor, ROUTE_TIMEOUT_MS, WORKER_NOT_CONNECTED};

/// How many settled teardown waits one open re-checks before it answers
/// the typed `worker is {state}` error (a holder that never dies must
/// not ping-pong the open).
const SETTLED_WAIT_ROUNDS: usize = 2;

/// How long an open waits for a stopping worker's teardown before it
/// answers the `worker is stopping` error (the dying process still holds
/// the session lease; a launch inside the window reproduces the bare
/// lease rejection this seam exists to remove).
const STOP_SETTLE_WAIT: Duration = Duration::from_secs(10);
/// The stop-settle poll cadence.
const STOP_SETTLE_POLL: Duration = Duration::from_millis(50);
/// How long a concurrent open waits for the per-file single-flight
/// before it answers the `worker is starting` shape (a sibling's whole
/// launch — spawn, connect, create replay — holds the lock; the wait
/// must cover it without parking a wedged client forever).
const OPENING_LOCK_WAIT: Duration = Duration::from_mins(2);

/// What reusing one resident answered: the live binding's summary, or a
/// holder whose teardown frees the file (the caller settles it and
/// re-checks the file's residents before launching).
enum ReuseAnswer {
    Summary(Value),
    HolderGone,
}

/// The held per-file single-flight. Dropping it releases the mutex (the
/// next opener unblocks) and then retires the map entry when no other
/// opener is waiting on the file: without the retirement a history-heavy
/// daemon leaks one entry per session file ever opened. The count check
/// runs under the map lock, so a new opener either joined this entry
/// before the removal or starts a fresh one after it.
pub(crate) struct OpeningGuard<'a> {
    supervisor: &'a Supervisor,
    key: String,
    guard: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl Drop for OpeningGuard<'_> {
    fn drop(&mut self) {
        // The mutex releases first: a concurrent opener's count keeps
        // the entry alive, so the retirement below only lands when this
        // was the last one.
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

/// The single-flight key for one session file (the registry's
/// comparison rule: canonicalize when the path exists, keep the raw path
/// otherwise — the file exists by construction here).
fn canonical_opening_key(path: &Path) -> String {
    path.canonicalize()
        .map(|canonical| canonical.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
}

/// Whether one resident's process is provably gone, identity-aware (the
/// lease's stale-owner rule): a recycled pid is a DIFFERENT process, so
/// the original holder is gone and its file is free — a pid-only check
/// would wait the whole settle budget on an unrelated process. A pid the
/// platform cannot answer for counts as alive: launching under an
/// unverifiable-but-alive holder would surface the lease rejection again.
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

/// The create's target session file, resolved once for the whole open:
/// the single-flight key and the reuse lookup share one resolution.
/// `Ok(None)` for every create that does not address an existing file (a
/// no-session create, a `continueRecent` create — the TS session manager
/// resolves those worker-side — or a path the worker will create).
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
    /// The per-file open single-flight (TS `openingWorkers`'s join): one
    /// create at a time per session file. A concurrent open waits here,
    /// then its reuse classification finds the first open's freshly
    /// registered worker and attaches — instead of both reaching the
    /// launch and one losing the runtime session lease. `Ok(None)` for
    /// creates that address no existing file (nothing to coordinate).
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
        // A sibling open holds the lock for its whole launch (spawn,
        // connect, create replay); the wait is bounded so a wedged sibling
        // answers the TS `worker is starting` shape instead of parking
        // the client forever.
        // A timed-out wait drops its Arc with the timeout future, so it
        // never pins the map entry (the release path retires it once the
        // last referrer drops).
        let guard = tokio::time::timeout(OPENING_LOCK_WAIT, lock.lock_owned())
            .await
            .map_err(|_| anyhow!("Session \"{}\" worker is starting", path.to_string_lossy()))?;
        Ok(Some(OpeningGuard {
            supervisor: self,
            key,
            guard: Some(guard),
        }))
    }

    /// Retire a released guard's map entry when no other opener is
    /// waiting on the file: the Arc's strong count is the coordination
    /// truth (the map itself plus every in-flight waiter each hold one).
    /// Without this the map grows one entry per session file ever opened
    /// — a history-heavy daemon would leak. A file with a live waiter
    /// keeps its entry; the last release removes it, and the next open
    /// starts a fresh one.
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

    /// TS `createOrReuseWorker`'s reuse half: when a resident already
    /// serves the create's session file, answer the LIVE binding (the
    /// resident's root summary — the exact create response shape the
    /// client's attach consumes) instead of launching a second worker
    /// over the same file (a launch the runtime session lease would
    /// reject). `Ok(None)` keeps the launch path (a fresh file, no live
    /// resident, or a holder whose teardown freed the file).
    ///
    /// The caller holds the per-file opening lock across this seam and
    /// the launch, so the classification a concurrent open runs is
    /// serialized behind the first one's launch — never racing it.
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

        // A settled teardown can hand the file straight to a concurrent
        // opener's successor: each wait re-checks the file's residents
        // before launching over it, so the open attaches to that
        // successor instead of racing it. Bounded — a holder that never
        // dies answers the typed error, never a ping-pong.
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

            // The live binding answers first: a route-ready resident is
            // the session's current worker, and the open is an attach to
            // it. A resident whose replacement is still coming (crash
            // backoff, create replay) is waited out inside the create's
            // route budget — the same replacement-aware wait every
            // client-facing route applies — then reused the same way.
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
                    // The routed resident went away with no successor:
                    // its own teardown must settle (the registry row can
                    // leave while its process still holds the lease),
                    // then the fresh classification re-checks the file —
                    // including any waitable successor this snapshot
                    // already listed.
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

            // A stopping or retired resident still owns the lease until
            // its process dies: wait out the settle window so the fresh
            // launch lands on a free file instead of the lease
            // rejection.
            let Some(holder) = candidates.stopping.clone() else {
                // No resident serves the file: the launch path (a stale
                // binding rebinds through `record_session_binding` at
                // create success).
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

    /// The summary a reused worker answers the create with: the live
    /// binding's root state. The route is replacement-aware, so an open
    /// landing mid-replay attaches once the replacement's create replay
    /// completed. A worker that goes away with no successor answers
    /// [`ReuseAnswer::HolderGone`] (its teardown settles at the caller);
    /// the never-ready worker answers the TS `worker is {state}` shape.
    async fn reuse_summary_or_holder(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
        session_path: &str,
    ) -> Result<ReuseAnswer> {
        match self
            .route_command_ready(resident, "get_state", json!({}), ROUTE_TIMEOUT_MS)
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
            // The worker retired with no successor in flight. Its registry
            // row may already be gone while its process still holds the
            // lease, so the caller waits for the confirmed death and
            // re-checks the file's residents — attaching to any successor
            // that took it meanwhile instead of launching over a live
            // lease holder.
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

    /// Wait until a holder that will not serve the create again is
    /// confirmed gone: only the process death frees the session file (the
    /// registry row leaves first — `stop_worker` drops it while the child
    /// is still exiting, and a launch inside that window resurfaces the
    /// lease rejection this seam exists to remove). Past the settle
    /// budget the open answers the TS `Session "{path}" worker is
    /// {state}` shape — never the lease rejection.
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
            &lifecycle,
            self.is_stopping(resident),
        )
    }
}

/// TS `assertWorkerCreateOwner`: only an explicit client-owned create is
/// exclusive. A client-owned open of a worker another client owns keeps
/// the TS `SessionAlreadyActiveError` rejection — naming the LIVE
/// binding's active id, never the stale lease id the bug surfaced. Every
/// other create reuses the live worker (multi-client attach).
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

    /// TS `assertWorkerCreateOwner`: a client-owned create over a worker
    /// another client owns rejects with the LIVE binding's active id —
    /// never a stale lease id.
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

    /// The plain open a pane sends (no `lifecycle`) is never exclusive:
    /// the live worker answers it whatever client created it.
    #[tokio::test]
    async fn a_plain_create_never_conflicts_on_ownership() {
        let resident = resident_with(Some("daemon-tui:1"), "live-id");
        assert!(
            client_owned_conflict(&resident, None, "daemon-tui:2", "/s.jsonl")
                .await
                .is_none()
        );
    }

    /// The owning client's own re-open (TS: a client-owned create whose
    /// owner matches) reuses the worker.
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

    /// A worker with no owner stamp (an adopted worker) is reusable by a
    /// client-owned create too.
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

    /// An adopted worker (pid 0) is never "process alive": its file is
    /// free for a launch even while its registration lingers.
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

    /// The spawn path's captured pair (pid + the holder's own start id,
    /// `getProcessStartId(childPid)`) keeps a live holder alive.
    #[tokio::test]
    async fn the_spawned_identity_keeps_a_live_holder_alive() {
        let pid = std::process::id();
        let start_id = crate::lease::get_process_start_id(pid);
        let resident = resident_with_identity(pid as u64, start_id.as_deref());
        assert!(resident_process_alive(&resident).await);
    }

    /// A recycled pid is a DIFFERENT process: the descriptor still
    /// answers with the original holder's start id, so the resident
    /// counts as dead instead of waiting out the settle budget.
    #[tokio::test]
    async fn a_recycled_pid_counts_as_dead() {
        let pid = std::process::id();
        let resident = resident_with_identity(pid as u64, Some("1/1"));
        assert!(!resident_process_alive(&resident).await);
    }

    /// A pid the platform cannot answer for (no stored identity) counts
    /// as alive: a possibly-live worker is never orphaned.
    #[tokio::test]
    async fn an_unverifiable_identity_counts_as_alive() {
        let pid = std::process::id();
        let resident = resident_with_identity(pid as u64, None);
        assert!(resident_process_alive(&resident).await);
    }
}
