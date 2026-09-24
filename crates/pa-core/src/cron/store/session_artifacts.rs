//! Session-artifact partitioning: registration of per-session scheduled-jobs
//! artifact files, recovery of a session's jobs from its artifact partition,
//! and the partitioned merge-write that keeps each artifact file holding only
//! its session's jobs and dispatches.
//! Section of the port of the AgentCronJobStore half of core/cron-jobs.ts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::state::{
    merge_fresh_jobs, read_jobs_state, recover_interrupted_in_state, with_state_locks,
    write_jobs_state,
};
use super::{
    AgentCronDispatchRecord, AgentCronJobStore, CronJobsState, SESSION_SCHEDULED_JOBS_FILENAME,
};
use crate::cron::AgentCronJob;

impl AgentCronJobStore {
    /// Register one session's artifact partition. Idempotent: re-registering
    /// the same directory is a no-op, so call sites can bind on every read.
    pub fn register_session_artifact(&self, session_id: &str, artifact_dir: &Path) -> bool {
        if !self.session_artifact_mode {
            return false;
        }
        let path = artifact_dir.join(SESSION_SCHEDULED_JOBS_FILENAME);
        let mut files = self
            .session_artifact_files
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if files.get(session_id) == Some(&path) {
            return false;
        }
        files.insert(session_id.to_string(), path);
        true
    }

    /// Every registered `(session id, artifact file)` pair.
    pub fn session_artifacts(&self) -> Vec<(String, PathBuf)> {
        let files = self
            .session_artifact_files
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        files.clone().into_iter().collect()
    }

    pub fn recover_session_artifact(&self, session_id: &str, now: u64) -> Vec<AgentCronJob> {
        let Some(path) = self
            .session_artifacts()
            .into_iter()
            .find(|(id, _)| id == session_id)
            .map(|(_, path)| path)
        else {
            return Vec::new();
        };
        with_state_locks(std::slice::from_ref(&path), || {
            let mut state = read_jobs_state(&path);
            let mut recovered = Vec::new();
            if !state.dispatches.is_empty() {
                recover_interrupted_in_state(&mut state, now, &mut recovered, None);
                write_jobs_state(&path, &state);
            }
            recovered
        })
    }
    pub(crate) fn write_jobs_session_artifacts(&self, jobs: &[AgentCronJob]) {
        let artifact_files = self
            .session_artifact_files
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let registered: std::collections::HashSet<String> =
            artifact_files.keys().cloned().collect();
        for job in jobs {
            if !registered.contains(&job.session_id) {
                // Mirror the TS error contract.
                return;
            }
        }
        let paths: Vec<PathBuf> = artifact_files.values().cloned().collect();
        with_state_locks(&paths, || {
            let current_by_session_id: HashMap<String, CronJobsState> = artifact_files
                .iter()
                .map(|(session_id, path)| (session_id.clone(), read_jobs_state(path)))
                .collect();
            let incoming_by_id: HashMap<&str, &AgentCronJob> =
                jobs.iter().map(|job| (job.id.as_str(), job)).collect();
            let mut merged_by_session_id: HashMap<String, Vec<AgentCronJob>> = HashMap::new();
            for (session_id, current) in &current_by_session_id {
                let retained: Vec<AgentCronJob> = current
                    .jobs
                    .iter()
                    .filter(|job| {
                        incoming_by_id
                            .get(job.id.as_str())
                            .is_none_or(|incoming| incoming.session_id == *session_id)
                    })
                    .cloned()
                    .collect();
                let session_jobs: Vec<AgentCronJob> = jobs
                    .iter()
                    .filter(|job| job.session_id == *session_id)
                    .cloned()
                    .collect();
                merged_by_session_id
                    .insert(session_id.clone(), merge_fresh_jobs(retained, session_jobs));
            }
            let session_id_by_job_id: HashMap<String, String> = merged_by_session_id
                .iter()
                .flat_map(|(session_id, session_jobs)| {
                    session_jobs
                        .iter()
                        .map(move |job| (job.id.clone(), session_id.clone()))
                })
                .collect();
            let all_dispatches: Vec<AgentCronDispatchRecord> = current_by_session_id
                .values()
                .flat_map(|state| state.dispatches.clone())
                .collect();
            for (session_id, path) in &artifact_files {
                let current = current_by_session_id
                    .get(session_id)
                    .cloned()
                    .unwrap_or_default();
                let next_state = CronJobsState {
                    jobs: merged_by_session_id
                        .get(session_id)
                        .cloned()
                        .unwrap_or_default(),
                    dispatches: all_dispatches
                        .iter()
                        .filter(|dispatch| {
                            session_id_by_job_id.get(&dispatch.job_id) == Some(session_id)
                        })
                        .cloned()
                        .collect(),
                };
                if serde_json::to_string(&current).unwrap_or_default()
                    != serde_json::to_string(&next_state).unwrap_or_default()
                {
                    write_jobs_state(path, &next_state);
                }
            }
        });
    }
}

/// Read one scheduled-jobs artifact file's job rows: a locked, read-only
/// scan shared by the update-flow roster projection (spec
/// `docs/update-flow-state-machine.md` §8: heartbeat rows are a projection
/// of these files, never a separate write path) and the supervisor's boot
/// re-arm. A missing or unparseable file reads as no jobs.
pub fn read_scheduled_jobs_artifact(path: &Path) -> Vec<AgentCronJob> {
    with_state_locks(&[path.to_path_buf()], || read_jobs_state(path).jobs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cron::store::{input, CancelJobsFilter, SessionBinding};

    #[test]
    fn session_artifact_partitioning() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = AgentCronJobStore::for_session_artifacts();
        let artifacts_a = dir.path().join("a");
        let artifacts_b = dir.path().join("b");
        std::fs::create_dir_all(&artifacts_a).unwrap();
        std::fs::create_dir_all(&artifacts_b).unwrap();
        assert!(store.register_session_artifact("session-1", &artifacts_a));
        assert!(!store.register_session_artifact("session-1", &artifacts_a)); // idempotent
        assert!(store.register_session_artifact("session-2", &artifacts_b));
        let now = 1_700_000_000_000;
        store.create(&input("job a", "every 10m", now)).unwrap();
        let mut job_b = input("job b", "every 20m", now);
        job_b.session_id = "session-2".to_string();
        store.create(&job_b).unwrap();
        let jobs = store.list();
        assert_eq!(jobs.len(), 2);
        // Each artifact file holds only its session's jobs.
        let state_a = read_jobs_state(&artifacts_a.join(SESSION_SCHEDULED_JOBS_FILENAME));
        assert_eq!(state_a.jobs.len(), 1);
        assert_eq!(state_a.jobs[0].prompt, "job a");
        let state_b = read_jobs_state(&artifacts_b.join(SESSION_SCHEDULED_JOBS_FILENAME));
        assert_eq!(state_b.jobs.len(), 1);
        // Rebind moves jobs to a new session binding.
        let rebound = store.rebind_session_jobs(&SessionBinding {
            active_session_id: "live-2".to_string(),
            session_id: "session-1".to_string(),
            session_file: "/w/session.jsonl".to_string(),
            cwd: "/w".to_string(),
        });
        assert_eq!(rebound.len(), 2);
        assert!(rebound.iter().all(|job| job.active_session_id == "live-2"));
        // Cancel by session file.
        let cancelled = store.cancel_jobs_for_session(
            &CancelJobsFilter {
                session_file: Some("/w/session.jsonl".to_string()),
                ..Default::default()
            },
            now + 1,
        );
        // Both jobs share the session file (the rebind moved both), so both cancel.
        assert_eq!(cancelled.len(), 2);
    }
}
