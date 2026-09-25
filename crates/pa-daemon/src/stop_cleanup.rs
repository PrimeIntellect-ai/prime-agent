//! The stop/delete lifecycle cleanup (the zombie-resurrection fix):
//! stopping or deleting a session must cancel its scheduled jobs so no
//! schedule fire, wake pass, or goal continuation can revive it.
//!
//! The TS surfaces this ports (daemon-supervisor.ts + daemon-mode.ts):
//!
//! - `finalizeArchivedWorkerStop` — the root-kill stop's durable half:
//!   the supervisor cancels the session tree's scheduled jobs (the
//!   belt behind the worker's own close-time cancel) and marks the
//!   session file `archived` (the catalog `archive` belt when the
//!   worker died before its own close wrote the state).
//! - `cancelScheduledJobsForSessionTree` — the tree walk a cancel
//!   covers: children-by-parent from the spawn ledger, a live worker
//!   covering any tree member owns its stores again (the cancel must
//!   not kill new schedules), partitions register only when their
//!   `scheduled-jobs.json` exists.
//! - `cancelEphemeralWorkerScheduledJobs` — a client-owned (ephemeral)
//!   worker's schedules die with the registration.
//! - `wakeDueScheduledSessions` / `collectPassiveScheduledJobs` — the
//!   wake scan only wakes jobs whose session file still exists, is
//!   still `active`, and whose tree no live worker covers: a killed
//!   session (state `archived`) or a deleted file is never revived.
//! - `deleteRlmSubagentArtifacts` — a deleted RLM subagent's artifact
//!   partition goes with the tombstone (best-effort, never fails the
//!   deletion).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;

use pa_core::cron::store::{AgentCronJobStore, CancelJobsFilter};
use pa_core::cron::AgentCronJob;

use crate::lease::canonical_session_path;
use crate::registry::ResidentWorker;
use crate::rlm_ledger::RlmSpawnLedger;
use crate::scheduled_jobs::session_artifact_dir;
use crate::session_store::{read_session_info, SessionFile};
use crate::supervisor::Supervisor;

/// One tree member of a stopped root: its durable session id and file
/// (TS `cancelScheduledJobsForSessionTree`'s `{ sessionId, sessionFile }`
/// rows).
struct TreeMember {
    session_id: String,
    session_file: PathBuf,
}

/// The ledger's parent→child map (TS `rlmSpawnLedger().family()`'s
/// `parentSessionPath` walk): every non-deleted edge keyed by its
/// canonical parent path.
fn children_by_parent(
    agent_dir: &Path,
    sessions_dir: &Path,
) -> HashMap<String, Vec<(String, PathBuf)>> {
    let ledger = RlmSpawnLedger::new(agent_dir, sessions_dir, |_| {});
    let mut map: HashMap<String, Vec<(String, PathBuf)>> = HashMap::new();
    let Ok(edges) = ledger.edges(false) else {
        return map;
    };
    for edge in edges {
        let child = PathBuf::from(&edge.child);
        let parent = canonical_session_path(Path::new(&edge.parent));
        map.entry(parent.to_string_lossy().to_string())
            .or_default()
            .push((edge.child_id.clone(), child));
    }
    map
}

/// The stopped root's session tree (TS `cancelScheduledJobsForSessionTree`'s
/// BFS): the root file plus every descendant the ledger reaches from it.
/// A child whose own parent edge is missing from the ledger stays out (the
/// same reachability TS has — the ledger is the only topology store).
fn session_tree(
    agent_dir: &Path,
    sessions_dir: &Path,
    root_session_file: &Path,
) -> Vec<TreeMember> {
    let mut members = Vec::new();
    let root = canonical_session_path(root_session_file);
    let root_id = read_session_info(&root).map_or_else(
        || {
            root.file_stem()
                .map(|stem| stem.to_string_lossy().to_string())
                .unwrap_or_default()
        },
        |info| info.id,
    );
    if root_id.is_empty() {
        return members;
    }
    members.push(TreeMember {
        session_id: root_id,
        session_file: root.clone(),
    });
    let by_parent = children_by_parent(agent_dir, sessions_dir);
    let mut queue = vec![root.to_string_lossy().to_string()];
    let mut visited: HashSet<String> = queue.iter().cloned().collect();
    while let Some(parent) = queue.pop() {
        for (_child_id, child_file) in by_parent.get(&parent).cloned().unwrap_or_default() {
            let child = canonical_session_path(&child_file);
            let child_key = child.to_string_lossy().to_string();
            if visited.contains(&child_key) {
                continue;
            }
            visited.insert(child_key.clone());
            let Some(info) = read_session_info(&child) else {
                continue;
            };
            members.push(TreeMember {
                session_id: info.id,
                session_file: child.clone(),
            });
            queue.push(child_key);
        }
    }
    members
}

/// Cancel the stopped session tree's scheduled jobs (TS
/// `cancelScheduledJobsForSessionTree`): every member whose artifact
/// partition still holds a `scheduled-jobs.json` registers on a fresh
/// session-artifacts store and cancels by session file. A live worker
/// covering any tree member owns its stores again — the stale stop must
/// not kill new schedules — so the whole walk aborts on a coverage hit
/// (`live_files` holds the canonical paths of every resident worker's
/// session file, collected before the synchronous walk). Returns how
/// many jobs the store cancelled.
pub(crate) fn cancel_scheduled_jobs_for_tree(
    agent_dir: &Path,
    sessions_dir: &Path,
    root_session_file: &Path,
    live_files: &HashSet<String>,
) -> usize {
    let members = session_tree(agent_dir, sessions_dir, root_session_file);
    // A worker covering any tree member owns its stores again.
    if members.iter().any(|member| {
        live_files.contains(
            &canonical_session_path(&member.session_file)
                .to_string_lossy()
                .to_string(),
        )
    }) {
        return 0;
    }
    let store = AgentCronJobStore::for_session_artifacts();
    let mut registered = false;
    for member in &members {
        let Some(dir) = session_artifact_dir(&member.session_file, &member.session_id) else {
            continue;
        };
        if !dir
            .join(pa_core::cron::store::SESSION_SCHEDULED_JOBS_FILENAME)
            .is_file()
        {
            continue;
        }
        store.register_session_artifact(&member.session_id, &dir);
        registered = true;
    }
    if !registered {
        return 0;
    }
    let now = crate::util::now_ms();
    let mut cancelled = 0;
    for member in &members {
        cancelled += store
            .cancel_jobs_for_session(
                &CancelJobsFilter {
                    active_session_id: None,
                    session_id: None,
                    session_file: Some(member.session_file.to_string_lossy().to_string()),
                },
                now,
            )
            .len();
    }
    cancelled
}

/// The killed session's `archived` state belt (TS `finalizeArchivedWorkerStop`
/// -> `catalog.archive`): the worker's own close appends the state; when it
/// died before its close wrote it, the supervisor appends it here so the
/// wake scans and saved-catalog folds treat the file as archived. A file
/// already archived (or unreadable) is a no-op.
pub(crate) fn ensure_archived_state(root_session_file: &Path) -> Result<()> {
    let path = canonical_session_path(root_session_file);
    if !path.is_file() {
        return Ok(());
    }
    if read_session_info(&path)
        .and_then(|info| info.state)
        .as_deref()
        == Some("archived")
    {
        return Ok(());
    }
    let mut session = SessionFile::open(&path)?;
    session.append_session_state("archived");
    session.rewrite()
}

/// The finalize of a root-kill stop (TS `finalizeArchivedWorkerStop`): the
/// tree's scheduled jobs cancel durably and the root file carries the
/// `archived` state. `live_files` is the registry's live coverage set,
/// collected after the stopped worker left it.
pub(crate) fn finalize_archived_stop(
    agent_dir: &Path,
    sessions_dir: &Path,
    root_session_file: &Path,
    live_files: &HashSet<String>,
) -> (usize, Option<anyhow::Error>) {
    let cancelled =
        cancel_scheduled_jobs_for_tree(agent_dir, sessions_dir, root_session_file, live_files);
    // A live worker covering the tree owns its stores again — including
    // the session file's state (a replacement worker over the same file
    // must keep its session live): the archived-state belt skips covered
    // trees exactly like the cancel does.
    let covered = session_tree(agent_dir, sessions_dir, root_session_file)
        .iter()
        .any(|member| {
            live_files.contains(
                &canonical_session_path(&member.session_file)
                    .to_string_lossy()
                    .to_string(),
            )
        });
    if covered {
        return (cancelled, None);
    }
    let archive_error = ensure_archived_state(root_session_file).err();
    (cancelled, archive_error)
}

/// The kill route's deleted-child finalize (the `rlmLedgerDelete` marker):
/// the `rlmChildId` whose ledger tombstone was persisted before the kill.
/// The usage capture is keyed by the child's session path - the tombstoned
/// edges there carry the delete reason - and the child id narrows a raced
/// path to the exact edge the tombstone recorded.
pub(crate) struct DeletedChild {
    pub child_id: String,
}

/// The capture core: every tombstoned edge at the child's session path
/// (all of them, or only the delete marker's `rlmChildId`) receives the
/// amendment delete record carrying the transcript's own-usage snapshot.
/// The transcript is read post-settlement (the kill reply is the flush
/// barrier) and the sweep never runs before this returns, so the frozen
/// file is the source. Returns the amended edge count; `None` when the
/// path is not a deleted child (a live child, a plain kill, an unnamed
/// raced path) - the caller keeps the transcript and the retryability.
pub(crate) fn append_deleted_child_usage_amendments(
    ledger: &RlmSpawnLedger,
    session_file: &str,
    child_id: &str,
) -> Option<usize> {
    let path = canonical_session_path(Path::new(session_file));
    let edges = ledger.edges(true).ok()?;
    let mut tombstoned = Vec::new();
    for edge in edges {
        let edge_deleted = edge.deleted.is_some();
        let edge_at_path = canonical_session_path(Path::new(&edge.child)) == path;
        let edge_named = child_id.is_empty() || edge.child_id == child_id;
        if edge_deleted && edge_at_path && edge_named {
            tombstoned.push(edge);
        }
    }
    if tombstoned.is_empty() {
        // Not a deleted child: nothing to capture, no sweep to arm.
        return None;
    }
    let summary = crate::session_usage::read_session_usage(&path)
        .and_then(|totals| crate::session_usage::session_usage_summary_from(&totals.own));
    let mut captured = 0usize;
    for edge in &tombstoned {
        let Some(reason) = edge.deleted else {
            continue;
        };
        let Some(summary) = &summary else {
            // No billable work: a zero snapshot adds nothing - skip the
            // amendment (the bucket reads zero either way).
            continue;
        };
        if ledger
            .append_delete_with_usage(&edge.child_id, &edge.child, reason, summary)
            .is_err()
        {
            continue;
        }
        captured += 1;
    }
    Some(captured)
}

impl Supervisor {
    /// The registry's live coverage set (TS `findWorkerBySessionFile`'s
    /// scan equivalent): every resident worker's session file,
    /// canonical, collected after the stopped worker left the registry.
    pub(crate) async fn live_session_files(self: &Arc<Self>) -> HashSet<String> {
        let mut live: HashSet<String> = HashSet::new();
        for resident in self.registry.list().await {
            let owned = resident
                .descriptor
                .lock()
                .await
                .session_file
                .clone()
                .unwrap_or_default();
            if owned.is_empty() {
                continue;
            }
            live.insert(
                canonical_session_path(Path::new(&owned))
                    .to_string_lossy()
                    .to_string(),
            );
        }
        live
    }

    /// TS `persistWorkerStopTombstone(worker, true)`: the root-kill stop's
    /// durable intent, persisted BEFORE the worker is told — a supervisor
    /// that dies mid-stop adopts the tombstone (finishing the stop) instead
    /// of relaunching the killed worker. A persist failure fails the stop
    /// before the kill is forwarded, exactly like TS; the worker's
    /// intentional-stop flag flips only once the tombstone is durable, so
    /// a rejected kill leaves the worker's crash-recovery contract intact.
    pub(crate) async fn persist_stop_tombstone(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
    ) -> anyhow::Result<()> {
        let mut descriptor = resident.descriptor.lock().await;
        if descriptor.stop_requested_at.is_none() {
            descriptor.stop_requested_at = Some(crate::util::now_iso());
        }
        descriptor.archive_on_stop = Some(true);
        crate::descriptor::persist_worker(&resident.descriptor_path, &descriptor)?;
        drop(descriptor);
        resident
            .intentional_stop
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    /// The durable half of a kill stop (TS `finalizeArchivedWorkerStop` +
    /// `deleteRlmSubagentArtifacts`), run after the stopped worker left
    /// the registry: the session tree's scheduled jobs cancel (the belt
    /// behind the worker's own close-time cancel) and the root file
    /// carries the `archived` state. `deleted_child` carries the
    /// `rlmChildId` of a ledger-tombstoned delete, whose artifact
    /// partition goes with the tombstone (best-effort, never fails the
    /// deletion).
    /// Returns whether the archived-state belt settled (`true` when the
    /// root file already carries or now carries the `archived` state; the
    /// belt is a no-op for a live-covered tree, which counts as settled).
    /// The adoption scan keeps the stop tombstone when it did not, so a
    /// later boot retries the belt.
    pub(crate) async fn finalize_worker_stop(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
        deleted_child: Option<&DeletedChild>,
    ) -> bool {
        let root_session_file = resident
            .descriptor
            .lock()
            .await
            .session_file
            .clone()
            .unwrap_or_default();
        if root_session_file.is_empty() {
            return true;
        }
        let sessions_dir = match crate::paths::sessions_dir(&self.options.agent_dir) {
            Ok(dir) => dir,
            Err(error) => {
                self.log_line(&format!(
                    "stop finalize: could not resolve the sessions dir: {error:#}"
                ));
                return false;
            }
        };
        let live = self.live_session_files().await;
        let (cancelled, archive_error) = finalize_archived_stop(
            &self.options.agent_dir,
            &sessions_dir,
            Path::new(&root_session_file),
            &live,
        );
        if cancelled > 0 {
            self.log_line(&format!(
                "stop finalize: cancelled {cancelled} scheduled job(s) of {root_session_file}"
            ));
        }
        let settled = match archive_error {
            None => true,
            Some(error) => {
                self.log_line(&format!(
                    "stop finalize: could not archive {root_session_file}: {error:#}"
                ));
                false
            }
        };
        match deleted_child {
            Some(deleted) => {
                // TS `deleteRlmSubagentArtifacts` + the durable usage
                // capture (TS has none: its bucket re-reads the
                // transcript a normal delete removes - the Macroscope
                // race): the kill reply was the flush barrier (the
                // worker's close settled the aborted row with any
                // mid-turn partial usage), so the frozen transcript
                // holds the child's final own spend. Capture it into
                // the ledger amendment BEFORE the sweep; a failed
                // capture never fails the stop (the transcript
                // survives the sweep, so the bucket's lazy fallback
                // still reads it).
                self.capture_deleted_child_usage(
                    &root_session_file,
                    &deleted.child_id,
                    "rlm_delete",
                )
                .await;
                crate::saved_session_commands::remove_session_artifacts(Path::new(
                    &root_session_file,
                ));
            }
            None => {
                // The adoption finalize (an interrupted stop re-runs
                // here): a supervisor crash between the ledger tombstone
                // and this sweep leaves the capture undone. The durable
                // tombstone reconstructs the delete - the capture and
                // the sweep finish from the ledger alone (restart
                // coverage).
                if let Some(child_id) = self.tombstoned_child_at(&root_session_file).await {
                    self.capture_deleted_child_usage(&root_session_file, &child_id, "adoption")
                        .await;
                    crate::saved_session_commands::remove_session_artifacts(Path::new(
                        &root_session_file,
                    ));
                }
            }
        }
        settled
    }

    /// The tombstoned edges' child id at one session path (the adoption
    /// finalize's ledger consult): `None` when nothing is tombstoned
    /// there - a plain kill, an untouched subagent, a top-level session.
    async fn tombstoned_child_at(self: &Arc<Self>, session_file: &str) -> Option<String> {
        let ledger = self.rlm_spawn_ledger_for(None).await.ok()?;
        let path = crate::lease::canonical_session_path(Path::new(session_file));
        let edges = ledger.edges(true).ok()?;
        edges
            .iter()
            .find(|edge| {
                edge.deleted.is_some()
                    && crate::lease::canonical_session_path(Path::new(&edge.child)) == path
            })
            .map(|edge| edge.child_id.clone())
    }

    /// The deleted child's durable usage capture: read the frozen
    /// transcript's own usage and append the amendment delete record
    /// carrying the snapshot (the spend survives the transcript's later
    /// removal, a saved-session delete, and daemon restarts). Best effort
    /// by contract - a capture failure logs and leaves the lazy file
    /// fallback in force.
    async fn capture_deleted_child_usage(
        self: &Arc<Self>,
        session_file: &str,
        child_id: &str,
        source: &'static str,
    ) {
        let Ok(ledger) = self.rlm_spawn_ledger_for(None).await else {
            self.log_line("deleted-child capture: could not resolve the spawn ledger");
            return;
        };
        // The capture reads and JSON-parses the whole frozen transcript
        // and appends ledger records - blocking work that must not stall
        // an async runtime worker (a large child would delay unrelated
        // daemon tasks), so it runs on the blocking executor.
        let session_file = session_file.to_string();
        let child_id = child_id.to_string();
        let captured = tokio::task::spawn_blocking(move || {
            append_deleted_child_usage_amendments(&ledger, &session_file, &child_id)
        })
        .await
        .unwrap_or(None);
        self.note_deleted_child_usage_captured(source, captured.unwrap_or(0));
    }

    /// The ephemeral stop's schedule cancel (TS
    /// `cancelEphemeralWorkerScheduledJobs`): a client-owned worker's
    /// schedules die with the registration (the owned tree cancels, no
    /// archived-state belt — the owned stop is not a kill). The stopping
    /// worker's own file is excluded from the live coverage set (TS's
    /// `exclude` argument to `cancelScheduledJobsForSessionTree`): the
    /// worker is still in the registry at this point of the stop, and its
    /// own file must not cover the tree the stop is cancelling.
    pub(crate) async fn finalize_owned_stop(self: &Arc<Self>, resident: &Arc<ResidentWorker>) {
        let root_session_file = resident
            .descriptor
            .lock()
            .await
            .session_file
            .clone()
            .unwrap_or_default();
        if root_session_file.is_empty() {
            return;
        }
        let Ok(sessions_dir) = crate::paths::sessions_dir(&self.options.agent_dir) else {
            return;
        };
        let mut live = self.live_session_files().await;
        live.remove(
            &canonical_session_path(Path::new(&root_session_file))
                .to_string_lossy()
                .to_string(),
        );
        let cancelled = cancel_scheduled_jobs_for_tree(
            &self.options.agent_dir,
            &sessions_dir,
            Path::new(&root_session_file),
            &live,
        );
        if cancelled > 0 {
            self.log_line(&format!(
                "owned stop: cancelled {cancelled} scheduled job(s) of {root_session_file}"
            ));
        }
    }
}

/// Whether a due scheduled job's target is still revivable (TS
/// `collectPassiveScheduledJobs`' scan gates, the wake-scan half of the
/// stop lifecycle): the session file must still exist, still be the job's
/// session (`readSessionInfo`'s id check of `isPersistedCronJobRunnable`),
/// still carry the `active` state (a killed session is `archived`, a
/// deleted session is gone), and no live worker may cover the job's file
/// (a covered tree's scheduler owns the fire itself).
pub(crate) fn due_job_target_alive(job: &AgentCronJob, live_files: &HashSet<String>) -> bool {
    if job.session_file.is_empty() {
        return false;
    }
    let path = canonical_session_path(Path::new(&job.session_file));
    if !path.is_file() {
        return false;
    }
    let Some(info) = read_session_info(&path) else {
        return false;
    };
    if info.id != job.session_id {
        return false;
    }
    if info.state.as_deref() != Some("active") {
        return false;
    }
    !live_files.contains(&path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_store::{session_file_name, SessionFile};
    use std::io::Write;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pa-stop-cleanup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_session(dir: &Path, name: Option<&str>) -> (String, PathBuf) {
        let mut session = SessionFile::create("/work", None, 0);
        if let Some(name) = name {
            session.append_session_info(name);
        }
        session.append_message(serde_json::json!({
            "role": "user", "content": "hi", "timestamp": 1u64
        }));
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        // The live state a fresh session carries (the worker's create
        // appends it): the wake-scan gate requires it.
        let _ = session.append_session_state("active");
        session.rewrite().unwrap();
        (session.session_id().to_string(), path)
    }

    fn write_job(session_file: &Path, session_id: &str, job_id: &str) {
        let dir = session_artifact_dir(session_file, session_id).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let jobs = serde_json::json!([{
            "id": job_id,
            "status": "active",
            "source": "rlm_heartbeat",
            "runtimeKind": "subagent",
            "activeSessionId": session_id,
            "sessionId": session_id,
            "sessionFile": session_file.to_string_lossy(),
            "cwd": "/work",
            "prompt": "liveness ping",
            "label": "lane-liveness",
            "schedule": { "kind": "interval", "expression": "every 2m", "intervalMs": 120_000 },
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "runCount": 0,
            "nextRunAt": "2026-01-01T00:02:00Z",
        }]);
        std::fs::write(
            dir.join("scheduled-jobs.json"),
            serde_json::json!({ "jobs": jobs, "dispatches": [] }).to_string(),
        )
        .unwrap();
    }

    fn read_job(session_file: &Path, session_id: &str) -> AgentCronJob {
        let dir = session_artifact_dir(session_file, session_id).unwrap();
        let raw: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("scheduled-jobs.json")).unwrap(),
        )
        .unwrap();
        serde_json::from_value(raw["jobs"][0].clone()).unwrap()
    }

    /// A killed tree: the root and its ledger child both hold active
    /// heartbeat jobs; the finalize cancels every member's jobs and marks
    /// the root file archived.
    #[test]
    fn finalize_cancels_the_tree_and_archives_the_root() {
        let root = temp_dir();
        let agent_dir = root.join("agent");
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();

        let (root_id, root_file) = write_session(&sessions_dir, Some("orchestrator"));
        let (child_id, child_file) = write_session(&sessions_dir, Some("lane"));
        // The ledger edge parent -> child.
        let ledger = RlmSpawnLedger::new(&agent_dir, &sessions_dir, |_| {});
        ledger
            .append_spawn(crate::rlm_ledger::RlmSpawnInput {
                child_id: "child-1".to_string(),
                parent: root_file.to_string_lossy().to_string(),
                child: child_file.to_string_lossy().to_string(),
                depth: 1,
                name: "lane".to_string(),
            })
            .unwrap();

        write_job(&root_file, &root_id, "job-root");
        write_job(&child_file, &child_id, "job-child");

        let live: HashSet<String> = HashSet::new();
        let (cancelled, archive_error) =
            finalize_archived_stop(&agent_dir, &sessions_dir, &root_file, &live);
        assert!(archive_error.is_none());
        assert_eq!(cancelled, 2, "the root and child jobs both cancel");
        assert_eq!(
            read_job(&root_file, &root_id).status,
            pa_core::cron::JobStatus::Cancelled
        );
        assert_eq!(
            read_job(&child_file, &child_id).status,
            pa_core::cron::JobStatus::Cancelled
        );
        // The archived-state belt landed on the root file.
        let info = read_session_info(&root_file).unwrap();
        assert_eq!(info.state.as_deref(), Some("archived"));
    }

    /// A live worker covering any tree member owns its stores again: the
    /// stale stop must not kill its schedules.
    #[test]
    fn finalize_skips_a_tree_a_live_worker_covers() {
        let root = temp_dir();
        let agent_dir = root.join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();

        let (root_id, root_file) = write_session(&sessions_dir, None);
        write_job(&root_file, &root_id, "job-root");

        let live: HashSet<String> = [canonical_session_path(&root_file)
            .to_string_lossy()
            .to_string()]
        .into_iter()
        .collect();
        let (cancelled, _) = finalize_archived_stop(&agent_dir, &sessions_dir, &root_file, &live);
        assert_eq!(cancelled, 0, "a covered tree keeps its schedules");
        assert_eq!(
            read_job(&root_file, &root_id).status,
            pa_core::cron::JobStatus::Active
        );
    }

    /// The wake-scan gate: a due job whose session was killed (state
    /// archived) or whose file is gone is not revivable; an active session
    /// with no live worker is.
    #[test]
    fn due_job_target_alive_checks_the_session_state() {
        let root = temp_dir();
        let sessions_dir = root.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();

        let (session_id, session_file) = write_session(&sessions_dir, None);
        let job = AgentCronJob {
            session_id: session_id.clone(),
            session_file: session_file.to_string_lossy().to_string(),
            ..serde_json::from_value(serde_json::json!({
                "id": "job",
                "status": "active",
                "activeSessionId": session_id,
                "sessionId": session_id,
                "sessionFile": session_file.to_string_lossy(),
                "cwd": "/work",
                "prompt": "ping",
                "schedule": { "kind": "interval", "expression": "every 2m", "intervalMs": 120_000 },
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
                "runCount": 0,
            }))
            .unwrap()
        };

        // An active session with no live worker: revivable.
        assert!(due_job_target_alive(&job, &HashSet::new()));
        // A live worker covers it: the scan leaves the fire to its scheduler.
        let live: HashSet<String> = [canonical_session_path(&session_file)
            .to_string_lossy()
            .to_string()]
        .into_iter()
        .collect();
        assert!(!due_job_target_alive(&job, &live));
        // A killed session carries the archived state.
        let mut session = SessionFile::open(&session_file).unwrap();
        session.append_session_state("archived");
        session.rewrite().unwrap();
        assert!(!due_job_target_alive(&job, &HashSet::new()));
        // A deleted session file is gone.
        std::fs::remove_file(&session_file).unwrap();
        assert!(!due_job_target_alive(&job, &HashSet::new()));
    }

    /// A tombstoned child with a frozen transcript: the capture appends the
    /// usage amendment and the transcript survives (the sweep is the
    /// caller's, and it never runs before the capture).
    #[test]
    fn capture_reads_the_frozen_transcript_before_any_sweep() {
        let root = temp_dir();
        let agent_dir = root.join("agent");
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let (_, parent_file) = write_session(&sessions_dir, Some("orchestrator"));
        let (_, child_file) = write_session(&sessions_dir, Some("lane"));
        let ledger = RlmSpawnLedger::new(&agent_dir, &sessions_dir, |_| {});
        ledger
            .append_spawn(crate::rlm_ledger::RlmSpawnInput {
                child_id: "sub-1".to_string(),
                parent: parent_file.to_string_lossy().to_string(),
                child: child_file.to_string_lossy().to_string(),
                depth: 1,
                name: "lane".to_string(),
            })
            .unwrap();
        // The tombstone lands before the kill (the revival window); the
        // capture only runs after the kill reply settles the file.
        ledger
            .append_delete(
                "sub-1",
                &child_file.to_string_lossy(),
                crate::rlm_ledger::RlmLedgerDeleteReason::User,
            )
            .unwrap();
        // A killed-mid-turn child: an aborted assistant row with partial
        // usage is already durable (the kill reply was the barrier).
        let usage_row = serde_json::json!({
            "type": "message", "id": "m-aborted",
            "message": {
                "role": "assistant",
                "stopReason": "aborted",
                "usage": {
                    "input": 4_000, "output": 400, "cacheRead": 0, "cacheWrite": 0,
                    "totalTokens": 4_400,
                    "cost": { "input": 0.05, "output": 0.01, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.06 }
                }
            }
        });
        {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&child_file)
                .unwrap();
            writeln!(file, "{usage_row}").unwrap();
        }
        let captured =
            append_deleted_child_usage_amendments(&ledger, &child_file.to_string_lossy(), "sub-1");
        assert_eq!(captured, Some(1), "the one tombstoned edge is amended");
        let edges = ledger.edges(true).unwrap();
        assert_eq!(edges.len(), 1);
        let snapshot = edges[0]
            .deleted_usage
            .clone()
            .expect("the snapshot rides the edge");
        assert!((snapshot.cost - 0.06).abs() < 1e-9);
        // While the transcript still exists its own archived row carries
        // the spend — the bucket skips live files (the rollup sums the
        // child row AND the parent bucket, so billing both would double
        // the spend).
        let live_bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
        let parent_key = canonical_session_path(&parent_file)
            .to_string_lossy()
            .to_string();
        assert!(
            !live_bucket.contains_key(&parent_key),
            "a live transcript's spend rides its own row, not the bucket"
        );
        // The sweep never ran: the transcript is the lazy fallback's copy.
        assert!(child_file.is_file());
        // The transcript dies (the sweep or a later delete): the bucket's
        // snapshot is now the only carrier — the spend survives.
        std::fs::remove_file(&child_file).unwrap();
        let bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
        assert!((bucket[&parent_key].cost - 0.06).abs() < 1e-9);
    }

    /// Invariant A: the snapshot is OWN usage, never the attribution
    /// aggregate. A child whose file folds a deleted grandchild's spend
    /// (own 0.40 + attributed 0.10 = total 0.50) must capture 0.40: the
    /// bucket's post-order fold re-adds the grandchild's own snapshot, and
    /// an aggregate snapshot would double count it.
    #[test]
    fn capture_is_own_only_never_the_attribution_aggregate() {
        let root = temp_dir();
        let agent_dir = root.join("agent");
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let (_, parent_file) = write_session(&sessions_dir, None);
        let (_, child_file) = write_session(&sessions_dir, None);
        let ledger = RlmSpawnLedger::new(&agent_dir, &sessions_dir, |_| {});
        ledger
            .append_spawn(crate::rlm_ledger::RlmSpawnInput {
                child_id: "sub-1".to_string(),
                parent: parent_file.to_string_lossy().to_string(),
                child: child_file.to_string_lossy().to_string(),
                depth: 1,
                name: "lane".to_string(),
            })
            .unwrap();
        ledger
            .append_delete(
                "sub-1",
                &child_file.to_string_lossy(),
                crate::rlm_ledger::RlmLedgerDeleteReason::User,
            )
            .unwrap();
        let usage_block = |total: f64| {
            serde_json::json!({
                "input": 1_000, "output": 100, "cacheRead": 0, "cacheWrite": 0,
                "totalTokens": 1_100,
                "cost": { "input": total, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": total }
            })
        };
        // The child's own row (0.40) + the grandchild's attribution folded
        // onto it (childUsage 0.10, aggregate 0.50).
        let rows = [
            serde_json::json!({
                "type": "message", "id": "m1",
                "message": { "role": "assistant", "usage": usage_block(0.40) }
            }),
            serde_json::json!({
                "type": "child_usage_attributed", "targetId": "m1",
                "childUsage": usage_block(0.10), "aggregateUsage": usage_block(0.50)
            }),
        ];
        {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&child_file)
                .unwrap();
            for row in rows {
                writeln!(file, "{row}").unwrap();
            }
        }
        let totals = crate::session_usage::read_session_usage(&child_file).unwrap();
        assert!(
            (totals.total.cost.total.as_f64() - 0.50).abs() < 1e-9,
            "the file's fold"
        );
        assert!(
            (totals.own.cost.total.as_f64() - 0.40).abs() < 1e-9,
            "the own read"
        );
        append_deleted_child_usage_amendments(&ledger, &child_file.to_string_lossy(), "sub-1")
            .unwrap();
        let snapshot = ledger.edges(true).unwrap()[0]
            .deleted_usage
            .clone()
            .expect("captured");
        assert!(
            (snapshot.cost - 0.40).abs() < 1e-9,
            "own-only snapshot (0.40), never the aggregate (0.50): got {}",
            snapshot.cost
        );
    }

    /// A live child, a plain kill, an unknown path: no tombstone, no
    /// capture — the deletion stays retryable and nothing is swept.
    #[test]
    fn capture_skips_live_children_and_plain_kills() {
        let root = temp_dir();
        let agent_dir = root.join("agent");
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let (_, parent_file) = write_session(&sessions_dir, None);
        let (_, child_file) = write_session(&sessions_dir, None);
        let ledger = RlmSpawnLedger::new(&agent_dir, &sessions_dir, |_| {});
        ledger
            .append_spawn(crate::rlm_ledger::RlmSpawnInput {
                child_id: "sub-1".to_string(),
                parent: parent_file.to_string_lossy().to_string(),
                child: child_file.to_string_lossy().to_string(),
                depth: 1,
                name: "lane".to_string(),
            })
            .unwrap();
        // Still live: no capture (kill-failure retryability — the child
        // keeps its transcript, its row, and its retryability).
        assert_eq!(
            append_deleted_child_usage_amendments(&ledger, &child_file.to_string_lossy(), "sub-1"),
            None
        );
        // A path the ledger never knew: nothing to capture.
        assert_eq!(
            append_deleted_child_usage_amendments(&ledger, "/nowhere/x.jsonl", ""),
            None
        );
    }

    /// The adoption finalize's consult passes no child id: every tombstoned
    /// edge at the path receives the amendment (a raced path has more than
    /// one; both carry the same transcript's snapshot).
    #[test]
    fn capture_with_no_child_id_amends_every_tombstoned_edge() {
        let root = temp_dir();
        let agent_dir = root.join("agent");
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let (_, parent_file) = write_session(&sessions_dir, None);
        let (_, child_file) = write_session(&sessions_dir, None);
        let ledger = RlmSpawnLedger::new(&agent_dir, &sessions_dir, |_| {});
        for child_id in ["sub-1", "sub-2"] {
            ledger
                .append_spawn(crate::rlm_ledger::RlmSpawnInput {
                    child_id: child_id.to_string(),
                    parent: parent_file.to_string_lossy().to_string(),
                    child: child_file.to_string_lossy().to_string(),
                    depth: 1,
                    name: "lane".to_string(),
                })
                .unwrap();
            ledger
                .append_delete(
                    child_id,
                    &child_file.to_string_lossy(),
                    crate::rlm_ledger::RlmLedgerDeleteReason::User,
                )
                .unwrap();
        }
        let captured =
            append_deleted_child_usage_amendments(&ledger, &child_file.to_string_lossy(), "");
        assert_eq!(captured, Some(0), "no billable usage: no amendment");
        for edge in ledger.edges(true).unwrap() {
            assert_eq!(edge.deleted_usage, None);
        }
    }
}
