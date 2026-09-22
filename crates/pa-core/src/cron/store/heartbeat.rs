//! `/heartbeat` job management: create/pause/resume/clear lifecycle plus
//! the heartbeat management actions (pause/resume/stop).
//! Section of the port of the AgentCronJobStore half of core/cron-jobs.ts.

use uuid::Uuid;

use super::state::normalize_optional_label;
use super::{
    iso_from_millis, now_millis, AgentCronJobStore, CreateAgentCronJobInput,
    HeartbeatManagementAction,
};
use crate::cron::{
    is_heartbeat_cron_job, next_run_at_for_schedule, parse_agent_cron_schedule, parse_iso_millis,
    AgentCronJob, JobStatus, ScheduleKind, DEFAULT_HEARTBEAT_DELIVERY_MODE,
};

impl AgentCronJobStore {
    pub fn get_heartbeat(&self, active_session_id: &str) -> Option<AgentCronJob> {
        self.read_jobs()
            .into_iter()
            .filter(|job| {
                job.active_session_id == active_session_id
                    && job.source.as_deref() == Some("heartbeat")
                    && matches!(job.status, JobStatus::Active | JobStatus::Paused)
            })
            .max_by_key(|job| parse_iso_millis(&job.updated_at).unwrap_or(0))
    }

    pub fn get_latest_heartbeat(&self, active_session_id: &str) -> Option<AgentCronJob> {
        self.read_jobs()
            .into_iter()
            .filter(|job| {
                job.active_session_id == active_session_id
                    && job.source.as_deref() == Some("heartbeat")
            })
            .max_by_key(|job| parse_iso_millis(&job.updated_at).unwrap_or(0))
    }

    pub fn create_heartbeat(
        &self,
        input: &CreateAgentCronJobInput,
    ) -> anyhow::Result<AgentCronJob> {
        let now = input.now.unwrap_or_else(now_millis);
        let parsed = parse_agent_cron_schedule(&input.schedule_text, now)?;
        if parsed.0.kind == ScheduleKind::Once {
            anyhow::bail!("Heartbeat schedule must be recurring");
        }
        let prompt = input.prompt.trim();
        if prompt.is_empty() {
            anyhow::bail!("Heartbeat instruction cannot be empty");
        }
        let now_iso = iso_from_millis(now);
        // Cancel existing active/paused heartbeats for this session.
        let existing: Vec<AgentCronJob> = self
            .read_jobs()
            .into_iter()
            .map(|job| {
                if job.active_session_id == input.active_session_id
                    && job.source.as_deref() == Some("heartbeat")
                    && matches!(job.status, JobStatus::Active | JobStatus::Paused)
                {
                    AgentCronJob {
                        status: JobStatus::Cancelled,
                        next_run_at: None,
                        updated_at: now_iso.clone(),
                        ..job
                    }
                } else {
                    job
                }
            })
            .collect();
        let job = AgentCronJob {
            id: Uuid::new_v4().to_string(),
            status: JobStatus::Active,
            source: Some("heartbeat".to_string()),
            runtime_kind: input.runtime_kind.clone(),
            delivery_mode: Some(
                input
                    .delivery_mode
                    .unwrap_or(DEFAULT_HEARTBEAT_DELIVERY_MODE),
            ),
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
        let mut jobs = existing;
        jobs.push(job.clone());
        self.write_jobs(&jobs);
        Ok(job)
    }
    pub fn pause_heartbeat(&self, active_session_id: &str, now: u64) -> Option<AgentCronJob> {
        let current = self.get_heartbeat(active_session_id)?;
        let now_iso = iso_from_millis(now);
        let mut paused = None;
        let jobs: Vec<AgentCronJob> = self
            .read_jobs()
            .into_iter()
            .map(|job| {
                if job.id != current.id {
                    return job;
                }
                let paused_job = AgentCronJob {
                    status: JobStatus::Paused,
                    next_run_at: None,
                    updated_at: now_iso.clone(),
                    ..job
                };
                paused = Some(paused_job.clone());
                paused_job
            })
            .collect();
        self.write_jobs(&jobs);
        paused
    }

    pub fn resume_heartbeat(
        &self,
        active_session_id: &str,
        now: u64,
    ) -> anyhow::Result<Option<AgentCronJob>> {
        let Some(current) = self.get_heartbeat(active_session_id) else {
            return Ok(None);
        };
        let Some(next_run_at) = next_run_at_for_schedule(&current.schedule, now)? else {
            anyhow::bail!("Heartbeat schedule must be recurring");
        };
        let now_iso = iso_from_millis(now);
        let mut resumed = None;
        let jobs: Vec<AgentCronJob> = self
            .read_jobs()
            .into_iter()
            .map(|job| {
                if job.id != current.id {
                    return job;
                }
                let resumed_job = AgentCronJob {
                    status: JobStatus::Active,
                    next_run_at: Some(iso_from_millis(next_run_at)),
                    updated_at: now_iso.clone(),
                    ..job
                };
                resumed = Some(resumed_job.clone());
                resumed_job
            })
            .collect();
        self.write_jobs(&jobs);
        Ok(resumed)
    }

    pub fn clear_heartbeat(&self, active_session_id: &str, now: u64) -> Option<AgentCronJob> {
        let current = self.get_heartbeat(active_session_id)?;
        let now_iso = iso_from_millis(now);
        let mut cleared = None;
        let jobs: Vec<AgentCronJob> = self
            .read_jobs()
            .into_iter()
            .map(|job| {
                if job.id != current.id {
                    return job;
                }
                let cleared_job = AgentCronJob {
                    status: JobStatus::Cancelled,
                    next_run_at: None,
                    updated_at: now_iso.clone(),
                    ..job
                };
                cleared = Some(cleared_job.clone());
                cleared_job
            })
            .collect();
        self.write_jobs(&jobs);
        cleared
    }

    pub fn manage_heartbeat(
        &self,
        active_session_id: &str,
        id: &str,
        action: HeartbeatManagementAction,
        now: u64,
    ) -> anyhow::Result<Option<AgentCronJob>> {
        let now_iso = iso_from_millis(now);
        let mut updated = None;
        let jobs: Vec<AgentCronJob> = self
            .read_jobs()
            .into_iter()
            .map(|job| {
                if job.id != id
                    || job.active_session_id != active_session_id
                    || !is_heartbeat_cron_job(&job)
                {
                    return job;
                }
                if matches!(job.status, JobStatus::Cancelled | JobStatus::Completed) {
                    return job;
                }
                let next_job = match action {
                    HeartbeatManagementAction::Pause => AgentCronJob {
                        status: JobStatus::Paused,
                        next_run_at: None,
                        updated_at: now_iso.clone(),
                        ..job
                    },
                    HeartbeatManagementAction::Stop => AgentCronJob {
                        status: JobStatus::Cancelled,
                        next_run_at: None,
                        updated_at: now_iso.clone(),
                        ..job
                    },
                    HeartbeatManagementAction::Resume => AgentCronJob {
                        status: JobStatus::Active,
                        updated_at: now_iso.clone(),
                        ..job
                    },
                };
                updated = Some(next_job.clone());
                next_job
            })
            .collect();
        let Some(mut updated_job) = updated else {
            return Ok(None);
        };
        if action == HeartbeatManagementAction::Resume {
            let Some(next_run_at) = next_run_at_for_schedule(&updated_job.schedule, now)? else {
                anyhow::bail!("Heartbeat schedule must be recurring");
            };
            updated_job.next_run_at = Some(iso_from_millis(next_run_at));
            let jobs: Vec<AgentCronJob> = jobs
                .into_iter()
                .map(|job| {
                    if job.id == updated_job.id {
                        updated_job.clone()
                    } else {
                        job
                    }
                })
                .collect();
            self.write_jobs(&jobs);
            return Ok(Some(updated_job));
        }
        self.write_jobs(&jobs);
        Ok(Some(updated_job))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cron::store::input;

    #[test]
    fn heartbeat_lifecycle() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = AgentCronJobStore::new(dir.path().join("jobs.json"));
        let now = 1_700_000_000_000;
        let heartbeat = store
            .create_heartbeat(&input("continue the mission", "every 5m", now))
            .unwrap();
        assert_eq!(store.get_heartbeat("live-1").unwrap().id, heartbeat.id);
        // Pause clears nextRunAt.
        let paused = store.pause_heartbeat("live-1", now + 1).unwrap();
        assert_eq!(paused.status, JobStatus::Paused);
        assert_eq!(paused.next_run_at, None);
        // Resume recomputes nextRunAt.
        let resumed = store.resume_heartbeat("live-1", now + 2).unwrap().unwrap();
        assert_eq!(resumed.status, JobStatus::Active);
        assert!(resumed.next_run_at.is_some());
        // A second create cancels the first.
        let second = store
            .create_heartbeat(&input("new instruction", "every 2m", now + 3))
            .unwrap();
        assert_eq!(store.get_heartbeat("live-1").unwrap().id, second.id);
        assert_eq!(store.list().len(), 2);
        let jobs = store.list();
        let cancelled_first = jobs.iter().find(|job| job.id != second.id).unwrap();
        assert_eq!(cancelled_first.status, JobStatus::Cancelled);
        // Clear cancels.
        let cleared = store.clear_heartbeat("live-1", now + 4).unwrap();
        assert_eq!(cleared.status, JobStatus::Cancelled);
        // One-shot schedules are rejected for heartbeats.
        assert!(store
            .create_heartbeat(&input("nope", "in 10m", now))
            .is_err());
    }
}
