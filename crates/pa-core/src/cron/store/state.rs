//! State save/load for the cron job store: cross-process file locking
//! (lockfile with stale takeover), state read/write/merge helpers, and the
//! in-state due-claim / interrupted-dispatch recovery transitions.
//! Section of the port of the AgentCronJobStore half of core/cron-jobs.ts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use super::{
    iso_from_millis, AgentCronDispatch, AgentCronDispatchRecord, AgentCronJob, AgentCronJobStore,
    CronJobsState,
};
use crate::cron::{
    is_due_job, next_run_at_for_schedule, parse_iso_millis, JobStatus, ScheduleKind,
};

const LOCK_STALE_MS: u64 = 30_000;

impl AgentCronJobStore {
    pub(crate) fn read_jobs(&self) -> Vec<AgentCronJob> {
        self.read_states()
            .into_iter()
            .flat_map(|state| state.jobs)
            .collect()
    }

    pub(crate) fn read_states(&self) -> Vec<CronJobsState> {
        if self.session_artifact_mode {
            let files = self
                .session_artifact_files
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            return files.values().map(|path| read_jobs_state(path)).collect();
        }
        vec![read_jobs_state(&self.require_file_path())]
    }

    pub(crate) fn mutate_states(
        &self,
        mut mutator: impl FnMut(&mut CronJobsState) -> Vec<AgentCronDispatch>,
    ) -> Vec<AgentCronDispatch> {
        let paths: Vec<PathBuf> = if self.session_artifact_mode {
            self.session_artifact_files
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .values()
                .cloned()
                .collect()
        } else {
            vec![self.require_file_path()]
        };
        let previous_heartbeats = Self::heartbeat_catalog_signature(&self.read_jobs());
        let mut changed = false;
        let dispatches = with_state_locks(&paths, || {
            let mut dispatches = Vec::new();
            for path in &paths {
                let mut state = read_jobs_state(path);
                let before = serde_json::to_string(&state).unwrap_or_default();
                dispatches.extend(mutator(&mut state));
                if serde_json::to_string(&state).unwrap_or_default() != before {
                    write_jobs_state(path, &state);
                    changed = true;
                }
            }
            dispatches
        });
        if changed && Self::heartbeat_catalog_signature(&self.read_jobs()) != previous_heartbeats {
            self.notify_heartbeat_change();
        }
        dispatches
    }

    pub(crate) fn write_jobs(&self, jobs: &[AgentCronJob]) {
        let previous_heartbeats = Self::heartbeat_catalog_signature(&self.read_jobs());
        if self.session_artifact_mode {
            self.write_jobs_session_artifacts(jobs);
        } else {
            let path = self.require_file_path();
            with_state_locks(std::slice::from_ref(&path), || {
                write_jobs_file(&path, jobs, true);
            });
        }
        if Self::heartbeat_catalog_signature(&self.read_jobs()) != previous_heartbeats {
            self.notify_heartbeat_change();
        }
    }

    pub(crate) fn require_file_path(&self) -> PathBuf {
        self.file_path
            .clone()
            .expect("Cron job store requires a file path")
    }
}

pub(crate) fn resolve_path(path: &str) -> String {
    let clean = std::path::Path::new(path);
    let mut components: Vec<std::ffi::OsString> = Vec::new();
    for component in clean.components() {
        use std::path::Component;
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                components.pop();
            }
            other => components.push(other.as_os_str().to_os_string()),
        }
    }
    let mut resolved = PathBuf::from("/");
    for component in components {
        resolved.push(component);
    }
    resolved.to_string_lossy().to_string()
}

pub(crate) fn compare_optional_iso(
    left: &Option<String>,
    right: &Option<String>,
) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (left, right) {
        (left, right) if left == right => Ordering::Equal,
        (None, _) => Ordering::Greater,
        (_, None) => Ordering::Less,
        (Some(left), Some(right)) => parse_iso_millis(left)
            .unwrap_or(0)
            .cmp(&parse_iso_millis(right).unwrap_or(0)),
    }
}

pub(crate) fn normalize_optional_label(label: Option<&str>) -> Option<String> {
    let trimmed = label.map(str::trim).filter(|label| !label.is_empty());
    trimmed.map(|label| label.to_string())
}

pub(crate) fn merge_fresh_jobs(
    current_jobs: Vec<AgentCronJob>,
    next_jobs: Vec<AgentCronJob>,
) -> Vec<AgentCronJob> {
    let mut merged: HashMap<String, AgentCronJob> = HashMap::new();
    for job in current_jobs {
        merged.insert(job.id.clone(), job);
    }
    for job in next_jobs {
        let is_fresh = merged
            .get(&job.id)
            .is_none_or(|current| is_at_least_as_fresh(&job, current));
        if is_fresh {
            merged.insert(job.id.clone(), job);
        }
    }
    merged.into_values().collect()
}

fn is_at_least_as_fresh(candidate: &AgentCronJob, current: &AgentCronJob) -> bool {
    let Some(current_time) = parse_iso_millis(&current.updated_at) else {
        return true;
    };
    let Some(candidate_time) = parse_iso_millis(&candidate.updated_at) else {
        return false;
    };
    candidate_time >= current_time
}

pub(crate) fn claim_due_in_state(
    state: &mut CronJobsState,
    due_at: u64,
    claimed_at: u64,
) -> Vec<AgentCronDispatch> {
    let claimed_iso = iso_from_millis(claimed_at);
    let claimed_job_ids: std::collections::HashSet<String> = state
        .dispatches
        .iter()
        .map(|dispatch| dispatch.job_id.clone())
        .collect();
    let mut dispatches = Vec::new();
    let jobs = std::mem::take(&mut state.jobs);
    let mut new_jobs = Vec::with_capacity(jobs.len());
    for mut job in jobs {
        if !is_due_job(&job, due_at) {
            new_jobs.push(job);
            continue;
        }
        let scheduled_for = job.next_run_at.clone().unwrap_or_default();
        let next_run_at = next_run_at_for_schedule(&job.schedule, claimed_at)
            .ok()
            .flatten()
            .map(iso_from_millis);
        job.next_run_at = next_run_at;
        job.updated_at = claimed_iso.clone();
        if claimed_job_ids.contains(&job.id) {
            job.last_skipped_at = Some(claimed_iso.clone());
            new_jobs.push(job);
            continue;
        }
        let dispatch = AgentCronDispatchRecord {
            id: Uuid::new_v4().to_string(),
            job_id: job.id.clone(),
            claimed_at: claimed_iso.clone(),
            scheduled_for,
        };
        state.dispatches.push(dispatch.clone());
        dispatches.push(AgentCronDispatch {
            id: dispatch.id,
            job: job.clone(),
        });
        new_jobs.push(job);
    }
    state.jobs = new_jobs;
    dispatches
}

pub(crate) fn recover_interrupted_in_state(
    state: &mut CronJobsState,
    now: u64,
    recovered: &mut Vec<AgentCronJob>,
    dispatch_ids: Option<&std::collections::HashSet<String>>,
) {
    let interrupted: Vec<AgentCronDispatchRecord> = match dispatch_ids {
        Some(ids) => state
            .dispatches
            .iter()
            .filter(|dispatch| ids.contains(&dispatch.id))
            .cloned()
            .collect(),
        None => state.dispatches.clone(),
    };
    if interrupted.is_empty() {
        return;
    }
    let interrupted_ids: std::collections::HashSet<String> = interrupted
        .iter()
        .map(|dispatch| dispatch.job_id.clone())
        .collect();
    match dispatch_ids {
        Some(ids) => state
            .dispatches
            .retain(|dispatch| !ids.contains(&dispatch.id)),
        None => state.dispatches.clear(),
    }
    state.jobs = state
        .jobs
        .clone()
        .into_iter()
        .map(|mut job| {
            if !interrupted_ids.contains(&job.id) || job.status != JobStatus::Active {
                return job;
            }
            job.status = if job.schedule.kind == ScheduleKind::Once {
                JobStatus::Completed
            } else {
                job.status
            };
            job.last_error = Some("Interrupted before scheduled operation completion".to_string());
            job.updated_at = iso_from_millis(now);
            recovered.push(job.clone());
            job
        })
        .collect();
}

/// Cross-process state locks: lockfile with stale takeover, sorted by path.
pub(crate) fn with_state_locks<T>(paths: &[PathBuf], action: impl FnOnce() -> T) -> T {
    let mut unique: Vec<PathBuf> = paths.to_vec();
    unique.sort();
    unique.dedup();
    let mut guards: Vec<crate::platform::lock_dir::LockDir> = Vec::new();
    for path in &unique {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // TS `withCronJobsStateLocks`: proper-lockfile on the state file,
        // 100 attempts x 10ms, 30s staleness takeover.
        let stale = std::time::Duration::from_millis(LOCK_STALE_MS);
        let mut acquired = false;
        let mut failure: Option<std::io::Error> = None;
        for _ in 0..100 {
            match crate::platform::lock_dir::LockDir::acquire(path, stale) {
                Ok(guard) => {
                    guards.push(guard);
                    acquired = true;
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        if !acquired {
            // TS `withCronJobsStateLocks` throws when the lock is not
            // acquired. The action still runs (as it did before this
            // logging) because the store API has no failure channel, but the
            // unlocked write is never silent: a concurrent writer may be
            // mutating the same state file.
            tracing::warn!(
                error = failure.as_ref().map(ToString::to_string).unwrap_or_else(
                    || "lock still held after retries".to_string()
                ),
                path = %path.display(),
                "cron jobs state lock not acquired; running unlocked"
            );
            break;
        }
    }
    let result = action();
    drop(guards);
    result
}

pub(crate) fn read_jobs_state(path: &Path) -> CronJobsState {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return CronJobsState::default();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return CronJobsState::default();
    };
    CronJobsState {
        jobs: parsed
            .get("jobs")
            .and_then(|jobs| jobs.as_array())
            .map(|jobs| {
                jobs.iter()
                    .filter_map(|job| serde_json::from_value::<AgentCronJob>(job.clone()).ok())
                    .collect()
            })
            .unwrap_or_default(),
        dispatches: parsed
            .get("dispatches")
            .and_then(|dispatches| dispatches.as_array())
            .map(|dispatches| {
                dispatches
                    .iter()
                    .filter_map(|dispatch| {
                        serde_json::from_value::<AgentCronDispatchRecord>(dispatch.clone()).ok()
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn write_jobs_file(path: &Path, jobs: &[AgentCronJob], merge_current: bool) {
    let current = read_jobs_state(path);
    let jobs = if merge_current {
        merge_fresh_jobs(current.jobs, jobs.to_vec())
    } else {
        jobs.to_vec()
    };
    write_jobs_state(
        path,
        &CronJobsState {
            jobs,
            dispatches: current.dispatches,
        },
    );
}

pub(crate) fn write_jobs_state(path: &Path, state: &CronJobsState) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let serialized = serde_json::to_string_pretty(state).unwrap_or_default();
    let _ = crate::settings::storage::atomic_write(path, &format!("{serialized}\n"));
}
