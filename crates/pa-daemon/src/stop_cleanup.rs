//! The stop/delete lifecycle cleanup: stopping or deleting a session must cancel its
//! scheduled jobs so no schedule fire, wake pass, or goal continuation can revive it.
//! Deliberate divergence from TS: the Rust port never wakes at all — a schedule fires
//! only while its session is live; due jobs on not-running sessions report dormant.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;

use pa_core::cron::store::{AgentCronJobStore, CancelJobsFilter};

use crate::lease::canonical_session_path;
use crate::registry::ResidentWorker;
use crate::rlm_ledger::RlmSpawnLedger;
use crate::scheduled_jobs::session_artifact_dir;
use crate::session_store::{read_session_info, SessionFile};
use crate::supervisor::Supervisor;

/// One tree member of a stopped root: its durable session id and file.
struct TreeMember {
    session_id: String,
    session_file: PathBuf,
}

/// The stopped root's session tree: the root file plus every descendant the ledger
/// reaches from it (the ledger is the only topology store).
fn session_tree(ledger: &RlmSpawnLedger, root_session_file: &Path) -> Vec<TreeMember> {
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
        session_file: root,
    });
    let Ok(family) = ledger.family_edges([root_session_file.to_path_buf()]) else {
        return members;
    };
    for edge in family {
        let child = PathBuf::from(edge.child);
        let Some(info) = read_session_info(&child) else {
            continue;
        };
        members.push(TreeMember {
            session_id: info.id,
            session_file: child,
        });
    }
    members
}

/// Cancel the stopped session tree's scheduled jobs: a member cancels by session file.
/// A live worker covering any tree member owns its stores again, so the walk aborts on
/// a coverage hit (`live_files`, collected before the walk).
pub(crate) fn cancel_scheduled_jobs_for_tree(
    ledger: &RlmSpawnLedger,
    root_session_file: &Path,
    live_files: &HashSet<String>,
) -> Result<usize> {
    cancel_scheduled_jobs_for_members(&session_tree(ledger, root_session_file), live_files)
}

fn cancel_scheduled_jobs_for_members(
    members: &[TreeMember],
    live_files: &HashSet<String>,
) -> Result<usize> {
    if members.iter().any(|member| {
        live_files.contains(
            &canonical_session_path(&member.session_file)
                .to_string_lossy()
                .to_string(),
        )
    }) {
        return Ok(0);
    }
    let store = AgentCronJobStore::for_session_artifacts();
    let mut registered = false;
    for member in members {
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
        return Ok(0);
    }
    let now = crate::util::now_ms();
    let mut cancelled = 0;
    for member in members {
        cancelled += store
            .cancel_jobs_for_session(
                &CancelJobsFilter {
                    active_session_id: None,
                    session_id: None,
                    session_file: Some(member.session_file.to_string_lossy().to_string()),
                },
                now,
            )?
            .len();
    }
    Ok(cancelled)
}

/// The killed session's `archived` state belt: when the worker died before its close
/// wrote the state, the supervisor appends it here.
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

/// The finalize of a root-kill stop: the tree's scheduled jobs cancel durably
/// and the root file carries the `archived` state. `live_files` is collected
/// after the stopped worker left the registry.
pub(crate) fn finalize_archived_stop(
    ledger: &RlmSpawnLedger,
    root_session_file: &Path,
    live_files: &HashSet<String>,
) -> (usize, Option<anyhow::Error>) {
    let members = session_tree(ledger, root_session_file);
    let cancelled = cancel_scheduled_jobs_for_members(&members, live_files);
    let (cancelled, cancel_error) = match cancelled {
        Ok(count) => (count, None),
        Err(error) => (0, Some(error)),
    };
    // A live worker covering the tree owns its stores again — including the session
    // file's state — so the belt skips covered trees like the cancel does.
    let covered = members.iter().any(|member| {
        live_files.contains(
            &canonical_session_path(&member.session_file)
                .to_string_lossy()
                .to_string(),
        )
    });
    if covered {
        return (cancelled, cancel_error);
    }
    let archive_error = ensure_archived_state(root_session_file).err();
    (cancelled, cancel_error.or(archive_error))
}

/// The kill route's deleted-child finalize (the `rlmLedgerDelete` marker): the
/// ledger tombstone was persisted before the kill, so the stop sweeps the
/// child's artifacts.
pub(crate) struct DeletedChild;

impl Supervisor {
    /// The registry's live coverage set: every resident worker's session file,
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

    /// TS `persistWorkerStopTombstone(worker, true)`: the root-kill stop's durable intent,
    /// persisted BEFORE the worker is told — a mid-stop death adopts the tombstone
    /// instead of relaunching the killed worker.
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
        resident.transition(crate::registry::WorkerTransition::RequestStop);
        Ok(())
    }

    /// TS `persistWorkerStopTombstone(worker, false)`: the per-session stop's durable
    /// intent (the stopped session stays resumable); `archive_on_stop = false` routes boot
    /// adoption to the graceful shutdown + schedule-cancel half, never the kill's cascade.
    /// EXCEPT when the durable intent already exists: a re-write failure must not abort
    /// the stop (the worker would run on its lease until the next boot).
    pub(crate) async fn persist_stop_tombstone_stop(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
    ) -> anyhow::Result<()> {
        let mut descriptor = resident.descriptor.lock().await;
        let old_stop_requested_at = descriptor.stop_requested_at.clone();
        let old_archive_on_stop = descriptor.archive_on_stop;
        if descriptor.stop_requested_at.is_none() {
            descriptor.stop_requested_at = Some(crate::util::now_iso());
        }
        if descriptor.archive_on_stop.is_none() {
            descriptor.archive_on_stop = Some(false);
        }
        if let Err(error) =
            crate::descriptor::persist_worker(&resident.descriptor_path, &descriptor)
        {
            if old_stop_requested_at.is_none() {
                // No durable intent anywhere: roll the in-memory mutation back (a later
                // descriptor write must not carry a tombstone the rejected stop never
                // durably set) and fail the stop.
                descriptor.stop_requested_at = old_stop_requested_at;
                descriptor.archive_on_stop = old_archive_on_stop;
                return Err(error);
            }
        }
        drop(descriptor);
        resident.transition(crate::registry::WorkerTransition::RequestStop);
        Ok(())
    }
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
        let ledger = match self.rlm_spawn_ledger_for(None).await {
            Ok(ledger) => ledger,
            Err(error) => {
                self.log_line(&format!(
                    "stop finalize: could not resolve the spawn ledger: {error:#}"
                ));
                return false;
            }
        };
        let live = self.live_session_files().await;
        let (cancelled, archive_error) =
            finalize_archived_stop(&ledger, Path::new(&root_session_file), &live);
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
            Some(_) => {
                crate::saved_session_commands::remove_session_artifacts(Path::new(
                    &root_session_file,
                ));
            }
            None => {
                // The adoption finalize (an interrupted stop re-runs here): a crash
                // between the ledger tombstone and this sweep leaves the sweep undone;
                // the durable tombstone reconstructs the delete and the sweep finishes.
                if self.tombstoned_child_at(&root_session_file).await.is_some() {
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

    /// The ephemeral stop's schedule cancel: a client-owned worker's schedules die with
    /// the registration. The stopping worker's own file is excluded from the live
    /// coverage set (it is still in the registry at this point of the stop).
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
        let Ok(ledger) = self.rlm_spawn_ledger_for(None).await else {
            return;
        };
        let mut live = self.live_session_files().await;
        live.remove(
            &canonical_session_path(Path::new(&root_session_file))
                .to_string_lossy()
                .to_string(),
        );
        let cancelled =
            cancel_scheduled_jobs_for_tree(&ledger, Path::new(&root_session_file), &live);
        let cancelled = match cancelled {
            Ok(count) => count,
            Err(error) => {
                self.log_line(&format!("owned stop: cron cancel failed: {error}"));
                return;
            }
        };
        if cancelled > 0 {
            self.log_line(&format!(
                "owned stop: cancelled {cancelled} scheduled job(s) of {root_session_file}"
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_store::{session_file_name, SessionFile};
    use pa_core::cron::AgentCronJob;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("pa-stop-cleanup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_session(dir: &Path, name: Option<&str>) -> (String, PathBuf) {
        let mut session = SessionFile::create("/work", None, 0);
        if let Some(name) = name {
            session.append_session_info(name);
        }
        session.append_message(&serde_json::json!({
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

    #[test]
    fn finalize_cancels_the_tree_and_archives_the_root() {
        let root = temp_dir();
        let agent_dir = root.join("agent");
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();

        let (root_id, root_file) = write_session(&sessions_dir, Some("orchestrator"));
        let (child_id, child_file) = write_session(&sessions_dir, Some("lane"));
        let (moved_id, moved_at) = write_session(&sessions_dir, Some("moved"));
        let moved_dir = agent_dir
            .join("session-artifacts")
            .join(&root_id)
            .join("child-2");
        std::fs::create_dir_all(&moved_dir).unwrap();
        let moved_file = moved_dir.join(moved_at.file_name().unwrap());
        std::fs::rename(&moved_at, &moved_file).unwrap();
        let ledger = RlmSpawnLedger::new(&agent_dir, &sessions_dir, |_| {});
        ledger
            .append_spawn(&crate::rlm_ledger::RlmSpawnInput {
                child_id: "child-1".to_string(),
                parent: root_file.to_string_lossy().to_string(),
                child: child_file.to_string_lossy().to_string(),
                depth: 1,
                name: "lane".to_string(),
                factory: None,
            })
            .unwrap();
        ledger
            .append_spawn(&crate::rlm_ledger::RlmSpawnInput {
                child_id: "child-2".to_string(),
                parent: root_file.to_string_lossy().to_string(),
                child: moved_at.to_string_lossy().to_string(),
                depth: 1,
                name: "moved".to_string(),
                factory: None,
            })
            .unwrap();

        write_job(&root_file, &root_id, "job-root");
        write_job(&child_file, &child_id, "job-child");
        write_job(&moved_file, &moved_id, "job-moved");

        let live: HashSet<String> = HashSet::new();
        let (cancelled, archive_error) = finalize_archived_stop(&ledger, &root_file, &live);
        assert!(archive_error.is_none());
        assert_eq!(
            cancelled, 3,
            "the root, the child, and the relocated child's jobs all cancel"
        );
        assert_eq!(
            read_job(&root_file, &root_id).status,
            pa_core::cron::JobStatus::Cancelled
        );
        assert_eq!(
            read_job(&child_file, &child_id).status,
            pa_core::cron::JobStatus::Cancelled
        );

        let info = read_session_info(&root_file).unwrap();
        assert_eq!(info.state.as_deref(), Some("archived"));
    }

    #[test]
    fn finalize_skips_a_tree_a_live_worker_covers() {
        let root = temp_dir();
        let agent_dir = root.join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();

        let (root_id, root_file) = write_session(&sessions_dir, None);
        write_job(&root_file, &root_id, "job-root");
        let ledger = RlmSpawnLedger::new(&agent_dir, &sessions_dir, |_| {});

        let live: HashSet<String> = [canonical_session_path(&root_file)
            .to_string_lossy()
            .to_string()]
        .into_iter()
        .collect();
        let (cancelled, _) = finalize_archived_stop(&ledger, &root_file, &live);
        assert_eq!(cancelled, 0, "a covered tree keeps its schedules");
        assert_eq!(
            read_job(&root_file, &root_id).status,
            pa_core::cron::JobStatus::Active
        );
    }
}
