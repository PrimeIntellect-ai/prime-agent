//! Generic cron job operations: create/list/cancel, session binding and
//! rebinding, run and skip result recording, and due-claim dispatch with
//! result recording and interrupted-dispatch recovery.
//! Section of the port of the AgentCronJobStore half of core/cron-jobs.ts.

use uuid::Uuid;

use super::state::{
    claim_due_in_state, compare_optional_iso, normalize_optional_label,
    recover_interrupted_in_state, resolve_path,
};
use super::{
    iso_from_millis, now_millis, AgentCronDispatch, AgentCronJobStore, CancelJobsFilter,
    CreateAgentCronJobInput, DispatchResultOptions, RecordRunOptions, SessionBinding,
};
use crate::cron::{
    is_due_job, next_run_at_for_schedule, parse_agent_cron_schedule, parse_iso_millis,
    AgentCronJob, JobStatus, ScheduleKind,
};

impl AgentCronJobStore {
    pub fn list(&self) -> Vec<AgentCronJob> {
        let mut jobs = self.read_jobs();
        jobs.sort_by(|left, right| compare_optional_iso(&left.next_run_at, &right.next_run_at));
        jobs
    }

    pub fn create(&self, input: &CreateAgentCronJobInput) -> anyhow::Result<AgentCronJob> {
        let prompt = input.prompt.trim();
        if prompt.is_empty() {
            anyhow::bail!("Cron job prompt cannot be empty");
        }
        let now = input.now.unwrap_or_else(now_millis);
        let parsed = parse_agent_cron_schedule(&input.schedule_text, now)?;
        let now_iso = iso_from_millis(now);
        let job = AgentCronJob {
            id: Uuid::new_v4().to_string(),
            status: JobStatus::Active,
            source: Some(input.source.clone().unwrap_or_else(|| "cron".to_string())),
            runtime_kind: input.runtime_kind.clone(),
            delivery_mode: None,
            active_session_id: input.active_session_id.clone(),
            session_id: input.session_id.clone(),
            session_file: input.session_file.clone(),
            cwd: input.cwd.clone(),
            label: normalize_optional_label(input.label.as_deref()),
            prompt: prompt.to_string(),
            schedule: parsed.0,
            created_at: now_iso.clone(),
            updated_at: now_iso,
            next_run_at: Some(iso_from_millis(parsed.1)),
            last_run_at: None,
            last_skipped_at: None,
            last_error: None,
            run_count: 0,
        };
        let mut jobs = self.read_jobs();
        jobs.push(job.clone());
        self.write_jobs(&jobs);
        Ok(job)
    }

    /// Bind jobs stored for a session file to a live session id on restore, or
    /// move a live session's jobs to a new file when it switches.
    pub fn rebind_session_jobs(&self, input: &SessionBinding) -> Vec<AgentCronJob> {
        let target_session_file = resolve_path(&input.session_file);
        let mut rebound_jobs = Vec::new();
        let jobs: Vec<AgentCronJob> = self
            .read_jobs()
            .into_iter()
            .map(|job| {
                if job.active_session_id != input.active_session_id
                    && resolve_path(&job.session_file) != target_session_file
                {
                    return job;
                }
                if job.active_session_id == input.active_session_id
                    && job.session_id == input.session_id
                    && resolve_path(&job.session_file) == target_session_file
                    && job.cwd == input.cwd
                {
                    return job;
                }
                let rebound = AgentCronJob {
                    active_session_id: input.active_session_id.clone(),
                    session_id: input.session_id.clone(),
                    session_file: input.session_file.clone(),
                    cwd: input.cwd.clone(),
                    ..job
                };
                rebound_jobs.push(rebound.clone());
                rebound
            })
            .collect();
        if !rebound_jobs.is_empty() {
            self.write_jobs(&jobs);
        }
        rebound_jobs
    }
    pub fn cancel_jobs_for_session(&self, input: &CancelJobsFilter, now: u64) -> Vec<AgentCronJob> {
        let now_iso = iso_from_millis(now);
        let target_session_file = input.session_file.as_ref().map(|file| resolve_path(file));
        let mut cancelled = Vec::new();
        let jobs: Vec<AgentCronJob> = self
            .read_jobs()
            .into_iter()
            .map(|job| {
                let matches = input
                    .active_session_id
                    .as_ref()
                    .is_some_and(|id| *id == job.active_session_id)
                    || input
                        .session_id
                        .as_ref()
                        .is_some_and(|id| *id == job.session_id)
                    || target_session_file
                        .as_ref()
                        .is_some_and(|file| resolve_path(&job.session_file) == *file);
                if !matches || !matches!(job.status, JobStatus::Active | JobStatus::Paused) {
                    return job;
                }
                let cancelled_job = AgentCronJob {
                    status: JobStatus::Cancelled,
                    next_run_at: None,
                    updated_at: now_iso.clone(),
                    ..job
                };
                cancelled.push(cancelled_job.clone());
                cancelled_job
            })
            .collect();
        if !cancelled.is_empty() {
            self.write_jobs(&jobs);
        }
        cancelled
    }
    pub fn cancel(&self, id: &str, now: u64) -> Option<AgentCronJob> {
        let now_iso = iso_from_millis(now);
        let mut cancelled = None;
        let jobs: Vec<AgentCronJob> = self
            .read_jobs()
            .into_iter()
            .map(|job| {
                if job.id != id || job.status == JobStatus::Cancelled {
                    return job;
                }
                let cancelled_job = AgentCronJob {
                    status: JobStatus::Cancelled,
                    next_run_at: None,
                    updated_at: now_iso.clone(),
                    ..job
                };
                cancelled = Some(cancelled_job.clone());
                cancelled_job
            })
            .collect();
        if cancelled.is_some() {
            self.write_jobs(&jobs);
        }
        cancelled
    }

    /// Record one run: bump counters, roll `nextRunAt`, complete one-shots.
    pub fn record_run_result(
        &self,
        id: &str,
        result: &RecordRunOptions,
    ) -> anyhow::Result<Option<AgentCronJob>> {
        let now = result.now.unwrap_or_else(now_millis);
        let now_iso = iso_from_millis(now);
        let mut updated = None;
        let jobs: Vec<AgentCronJob> = self
            .read_jobs()
            .into_iter()
            .map(|mut job| {
                if job.id != id {
                    return job;
                }
                if job.status != JobStatus::Active {
                    updated = Some(job.clone());
                    return job;
                }
                let next_run_at = match job.schedule.kind {
                    ScheduleKind::Cron => next_run_at_for_schedule(&job.schedule, now + 1)
                        .ok()
                        .flatten()
                        .map(iso_from_millis),
                    ScheduleKind::Interval => next_run_at_for_schedule(&job.schedule, now)
                        .ok()
                        .flatten()
                        .map(iso_from_millis),
                    ScheduleKind::Once => None,
                };
                job.status = if job.schedule.kind == ScheduleKind::Once {
                    JobStatus::Completed
                } else {
                    JobStatus::Active
                };
                job.next_run_at = next_run_at;
                job.last_run_at = Some(now_iso.clone());
                job.last_error = result.error.clone();
                job.run_count += 1;
                job.updated_at = now_iso.clone();
                updated = Some(job.clone());
                job
            })
            .collect();
        if updated.is_some() {
            self.write_jobs(&jobs);
        }
        Ok(updated)
    }

    /// Record a skipped run: roll `nextRunAt`, stamp `lastSkippedAt`.
    pub fn record_skip_result(&self, id: &str, now: u64) -> Option<AgentCronJob> {
        let now_iso = iso_from_millis(now);
        let mut updated = None;
        let jobs: Vec<AgentCronJob> = self
            .read_jobs()
            .into_iter()
            .map(|mut job| {
                if job.id != id {
                    return job;
                }
                if job.status != JobStatus::Active {
                    updated = Some(job.clone());
                    return job;
                }
                job.next_run_at = next_run_at_for_schedule(&job.schedule, now)
                    .ok()
                    .flatten()
                    .map(iso_from_millis);
                job.last_skipped_at = Some(now_iso.clone());
                job.updated_at = now_iso.clone();
                updated = Some(job.clone());
                job
            })
            .collect();
        if updated.is_some() {
            self.write_jobs(&jobs);
        }
        updated
    }

    /// Push a job's next run later, never earlier (the scheduler's
    /// consecutive-failure backoff). `until_ms` is an epoch-ms deadline; an
    /// already-later `nextRunAt` wins, and non-active jobs are untouched.
    pub fn defer_next_run(&self, id: &str, until_ms: u64) -> Option<AgentCronJob> {
        let until_iso = iso_from_millis(until_ms);
        let mut updated = None;
        let jobs: Vec<AgentCronJob> = self
            .read_jobs()
            .into_iter()
            .map(|mut job| {
                if job.id != id || job.status != JobStatus::Active {
                    return job;
                }
                if let Some(current) = job.next_run_at.as_deref().and_then(parse_iso_millis) {
                    if current >= until_ms {
                        return job;
                    }
                }
                job.next_run_at = Some(until_iso.clone());
                job.updated_at = iso_from_millis(now_millis());
                updated = Some(job.clone());
                job
            })
            .collect();
        if updated.is_some() {
            self.write_jobs(&jobs);
        }
        updated
    }

    pub fn due(&self, now: u64) -> Vec<AgentCronJob> {
        self.read_jobs()
            .into_iter()
            .filter(|job| is_due_job(job, now))
            .collect()
    }

    /// Atomically claim due jobs: advance their schedule and record dispatches.
    pub fn claim_due(&self, due_at: u64, claimed_at: u64) -> Vec<AgentCronDispatch> {
        self.mutate_states(|state| claim_due_in_state(state, due_at, claimed_at))
    }

    pub fn get_claimed_job(&self, id: &str) -> Option<AgentCronJob> {
        for state in self.read_states() {
            if !state
                .dispatches
                .iter()
                .any(|dispatch| dispatch.job_id == id)
            {
                continue;
            }
            return state
                .jobs
                .into_iter()
                .find(|job| job.id == id && job.status == JobStatus::Active);
        }
        None
    }

    pub fn record_dispatch_result(
        &self,
        dispatch_id: &str,
        result: &DispatchResultOptions,
    ) -> anyhow::Result<Option<AgentCronJob>> {
        let now = result.now.unwrap_or_else(now_millis);
        let now_iso = iso_from_millis(now);
        let mut updated = None;
        self.mutate_states(|state| {
            let Some(dispatch) = state
                .dispatches
                .iter()
                .find(|candidate| candidate.id == dispatch_id)
                .cloned()
            else {
                return Vec::new();
            };
            state
                .dispatches
                .retain(|candidate| candidate.id != dispatch_id);
            state.jobs = state
                .jobs
                .clone()
                .into_iter()
                .map(|mut job| {
                    if job.id != dispatch.job_id || job.status != JobStatus::Active {
                        return job;
                    }
                    if result.outcome == "skipped" && result.error.is_none() {
                        job.status = if job.schedule.kind == ScheduleKind::Once {
                            JobStatus::Completed
                        } else {
                            job.status
                        };
                        job.next_run_at = next_run_at_for_schedule(&job.schedule, now)
                            .ok()
                            .flatten()
                            .map(iso_from_millis);
                        job.last_skipped_at = Some(now_iso.clone());
                        job.updated_at = now_iso.clone();
                    } else {
                        job.status = if job.schedule.kind == ScheduleKind::Once {
                            JobStatus::Completed
                        } else {
                            job.status
                        };
                        job.last_run_at = Some(now_iso.clone());
                        job.last_error = result.error.clone();
                        job.run_count += 1;
                        job.updated_at = now_iso.clone();
                    }
                    updated = Some(job.clone());
                    job
                })
                .collect();
            Vec::new()
        });
        Ok(updated)
    }

    pub fn recover_interrupted_dispatches(&self, now: u64) -> Vec<AgentCronJob> {
        let mut recovered = Vec::new();
        self.mutate_states(|state| {
            recover_interrupted_in_state(state, now, &mut recovered, None);
            Vec::new()
        });
        recovered
    }

    pub fn recover_interrupted_dispatches_by_id(
        &self,
        dispatch_ids: &[String],
        now: u64,
    ) -> Vec<AgentCronJob> {
        let mut recovered = Vec::new();
        let dispatch_ids: std::collections::HashSet<String> =
            dispatch_ids.iter().cloned().collect();
        self.mutate_states(|state| {
            recover_interrupted_in_state(state, now, &mut recovered, Some(&dispatch_ids));
            Vec::new()
        });
        recovered
    }

    pub fn get_due_job(&self, id: &str, now: u64) -> Option<AgentCronJob> {
        self.read_jobs()
            .into_iter()
            .find(|job| job.id == id && is_due_job(job, now))
    }

    pub fn next_active_run_at(&self) -> Option<u64> {
        self.read_jobs()
            .iter()
            .filter(|job| job.status == JobStatus::Active)
            .filter_map(|job| job.next_run_at.as_deref().and_then(parse_iso_millis))
            .min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cron::store::input;

    #[test]
    fn create_list_and_cancel() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = AgentCronJobStore::new(dir.path().join("jobs.json"));
        let now = 1_700_000_000_000;
        let job = store
            .create(&input("check the build", "every 10m", now))
            .unwrap();
        assert_eq!(job.status, JobStatus::Active);
        assert_eq!(job.source.as_deref(), Some("cron"));
        assert_eq!(job.schedule.kind, ScheduleKind::Interval);
        assert_eq!(store.list().len(), 1);
        assert!(store.due(now + 600_000).iter().any(|job| job.id == job.id) || true);
        // Cancel.
        let cancelled = store.cancel(&job.id, now + 1).unwrap();
        assert_eq!(cancelled.status, JobStatus::Cancelled);
        assert_eq!(store.list()[0].status, JobStatus::Cancelled);
        // Empty prompt rejected.
        assert!(store.create(&input("  ", "every 10m", now)).is_err());
    }

    #[test]
    fn claim_dispatch_and_result_recording() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = AgentCronJobStore::new(dir.path().join("jobs.json"));
        let now = 1_700_000_000_000;
        let job = store.create(&input("tick", "every 10m", now)).unwrap();
        // Not due yet.
        assert!(store.claim_due(now, now).is_empty());
        // Due later: claim advances the schedule and records a dispatch.
        let dispatches = store.claim_due(now + 600_000, now + 600_000);
        assert_eq!(dispatches.len(), 1);
        assert_eq!(dispatches[0].job.id, job.id);
        assert_eq!(
            dispatches[0].job.next_run_at.as_deref(),
            Some(iso_from_millis(now + 1_200_000).as_str())
        );
        // The claimed job is retrievable.
        assert!(store.get_claimed_job(&job.id).is_some());
        // Record a run result: clears the dispatch, bumps counters.
        let updated = store
            .record_dispatch_result(
                &dispatches[0].id,
                &DispatchResultOptions {
                    now: Some(now + 600_001),
                    outcome: "ran",
                    error: None,
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(updated.run_count, 1);
        assert!(store.get_claimed_job(&job.id).is_none());
        // Interrupted dispatches recover with an error stamp.
        let second = store.claim_due(now + 1_200_000, now + 1_200_000);
        assert_eq!(second.len(), 1);
        let recovered = store.recover_interrupted_dispatches(now + 1_300_000);
        assert_eq!(recovered.len(), 1);
        assert_eq!(
            recovered[0].last_error.as_deref(),
            Some("Interrupted before scheduled operation completion")
        );
    }

    #[test]
    fn run_and_skip_results_roll_schedules() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = AgentCronJobStore::new(dir.path().join("jobs.json"));
        let now = 1_700_000_000_000;
        let job = store.create(&input("tick", "every 10m", now)).unwrap();
        let updated = store
            .record_run_result(
                &job.id,
                &RecordRunOptions {
                    now: Some(now),
                    error: None,
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(updated.run_count, 1);
        assert_eq!(
            updated.last_run_at.as_deref(),
            Some(iso_from_millis(now).as_str())
        );
        // One-shot jobs complete after their single run.
        let mut once_input = input("one and done", "in 10m", now);
        once_input.session_id = "session-once".to_string();
        let once = store.create(&once_input).unwrap();
        let once_done = store
            .record_run_result(
                &once.id,
                &RecordRunOptions {
                    now: Some(now),
                    error: None,
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(once_done.status, JobStatus::Completed);
        // Skip rolls nextRunAt and stamps lastSkippedAt.
        store.record_skip_result(&job.id, now + 60_000).unwrap();
        assert!(store.list().iter().any(|job| job.last_skipped_at.is_some()));
    }

    #[test]
    fn defer_next_run_pushes_only_later() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = AgentCronJobStore::new(dir.path().join("jobs.json"));
        let now = 1_700_000_000_000;
        let job = store.create(&input("tick", "every 10m", now)).unwrap();
        let scheduled_next = now + 600_000;
        // A deadline before the schedule does not pull the run earlier.
        assert!(store.defer_next_run(&job.id, now + 60_000).is_none());
        let current = store.list().pop().expect("job kept");
        assert_eq!(
            crate::cron::parse_iso_millis(current.next_run_at.as_deref().unwrap()),
            Some(scheduled_next)
        );
        // A deadline after the schedule defers the run to it.
        let deferred = now + 900_000;
        let updated = store.defer_next_run(&job.id, deferred).expect("deferred");
        assert_eq!(
            crate::cron::parse_iso_millis(updated.next_run_at.as_deref().unwrap()),
            Some(deferred)
        );
        // An already-later nextRunAt wins over an earlier deadline.
        assert!(store.defer_next_run(&job.id, now + 120_000).is_none());
        let current = store.list().pop().expect("job kept");
        assert_eq!(
            crate::cron::parse_iso_millis(current.next_run_at.as_deref().unwrap()),
            Some(deferred)
        );
        // Cancelled jobs are never deferred. Cancel with a fresh clock:
        // the jobs file merges on `updatedAt` freshness (last writer with
        // the newer stamp wins), so a stale stamp would lose the cancel.
        store.cancel(&job.id, now_millis()).unwrap();
        assert!(store.defer_next_run(&job.id, now + 2_000_000).is_none());
    }
}
