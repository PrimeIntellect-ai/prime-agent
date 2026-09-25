//! RLM heartbeat operations: the agent-owned heartbeat jobs created and
//! managed through the rlm-heartbeat kernel skill (list/create/update/delete
//! plus session-teardown cancellation).
//! Section of the port of the `AgentCronJobStore` half of core/cron-jobs.ts.

use uuid::Uuid;

use super::state::{compare_optional_iso, normalize_optional_label};
use super::{
    iso_from_millis, now_millis, AgentCronJobStore, CreateAgentCronJobInput,
    RlmHeartbeatStatusUpdate, RlmHeartbeatUpdate,
};
use crate::cron::{
    next_run_at_for_schedule, parse_agent_cron_schedule, AgentCronJob, JobStatus, ScheduleKind,
    DEFAULT_HEARTBEAT_DELIVERY_MODE,
};

impl AgentCronJobStore {
    pub fn list_rlm_heartbeats(
        &self,
        active_session_id: &str,
        include_inactive: bool,
    ) -> Vec<AgentCronJob> {
        let mut jobs: Vec<AgentCronJob> = self
            .read_jobs()
            .into_iter()
            .filter(|job| {
                if job.active_session_id != active_session_id
                    || job.source.as_deref() != Some("rlm_heartbeat")
                {
                    return false;
                }
                if include_inactive {
                    return true;
                }
                matches!(job.status, JobStatus::Active | JobStatus::Paused)
            })
            .collect();
        jobs.sort_by(|left, right| compare_optional_iso(&left.next_run_at, &right.next_run_at));
        jobs
    }

    /// Create an RLM heartbeat job for a session.
    ///
    /// # Errors
    ///
    /// Returns an error when the schedule text cannot be parsed, when the
    /// schedule is not recurring, or when the heartbeat instruction is
    /// empty.
    pub fn create_rlm_heartbeat(
        &self,
        input: &CreateAgentCronJobInput,
    ) -> anyhow::Result<AgentCronJob> {
        let now = input.now.unwrap_or_else(now_millis);
        let parsed = parse_agent_cron_schedule(&input.schedule_text, now)?;
        if parsed.0.kind == ScheduleKind::Once {
            anyhow::bail!("RLM heartbeat schedule must be recurring");
        }
        let prompt = input.prompt.trim();
        if prompt.is_empty() {
            anyhow::bail!("RLM heartbeat instruction cannot be empty");
        }
        let now_iso = iso_from_millis(now);
        let job = AgentCronJob {
            id: Uuid::new_v4().to_string(),
            status: JobStatus::Active,
            source: Some("rlm_heartbeat".to_string()),
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
        let mut jobs = self.read_jobs();
        jobs.push(job.clone());
        self.write_jobs(&jobs);
        Ok(job)
    }

    /// Apply label, prompt, schedule, status, or delivery-mode updates to an
    /// RLM heartbeat job. Returns `Ok(None)` when no matching job exists.
    ///
    /// # Errors
    ///
    /// Returns an error when a matching job exists but the update was
    /// rejected because the new instruction is empty or the new schedule is
    /// invalid or not recurring.
    #[allow(clippy::too_many_arguments)]
    pub fn update_rlm_heartbeat(
        &self,
        active_session_id: &str,
        id: &str,
        update: &RlmHeartbeatUpdate,
    ) -> anyhow::Result<Option<AgentCronJob>> {
        let now = update.now.unwrap_or_else(now_millis);
        let now_iso = iso_from_millis(now);
        let mut updated: Option<AgentCronJob> = None;
        let mut matched = false;
        let jobs: Vec<AgentCronJob> = self
            .read_jobs()
            .into_iter()
            .map(|job| {
                if job.id != id
                    || job.active_session_id != active_session_id
                    || job.source.as_deref() != Some("rlm_heartbeat")
                {
                    return job;
                }
                matched = true;
                if matches!(job.status, JobStatus::Cancelled | JobStatus::Completed) {
                    return job;
                }
                let mut next = job.clone();
                if let Some(label) = &update.label {
                    next.label = normalize_optional_label(Some(label));
                }
                if let Some(delivery_mode) = &update.delivery_mode {
                    next.delivery_mode = Some(*delivery_mode);
                }
                if let Some(prompt) = &update.prompt {
                    let prompt = prompt.trim();
                    if prompt.is_empty() {
                        return job; // caller surfaces the error via !updated
                    }
                    next.prompt = prompt.to_string();
                }
                if let Some(schedule_text) = &update.schedule_text {
                    match parse_agent_cron_schedule(schedule_text, now) {
                        Ok(parsed) if parsed.0.kind != ScheduleKind::Once => {
                            next.schedule = parsed.0;
                            next.next_run_at = if next.status == JobStatus::Paused {
                                None
                            } else {
                                Some(iso_from_millis(parsed.1))
                            };
                        }
                        _ => return job,
                    }
                }
                match update.status {
                    Some(RlmHeartbeatStatusUpdate::Pause) => {
                        next.status = JobStatus::Paused;
                        next.next_run_at = None;
                    }
                    Some(RlmHeartbeatStatusUpdate::Resume) => {
                        next.status = JobStatus::Active;
                        next.next_run_at = next_run_at_for_schedule(&next.schedule, now)
                            .ok()
                            .flatten()
                            .map(iso_from_millis);
                    }
                    None => {}
                }
                next.updated_at.clone_from(&now_iso);
                updated = Some(next.clone());
                next
            })
            .collect();
        if matched {
            if let Some(updated_job) = &updated {
                self.write_jobs(&jobs);
                return Ok(Some(updated_job.clone()));
            }
            anyhow::bail!(
                "RLM heartbeat update rejected (empty instruction or non-recurring schedule)"
            );
        }
        Ok(None)
    }

    pub fn delete_rlm_heartbeat(
        &self,
        active_session_id: &str,
        id: &str,
        now: u64,
    ) -> Option<AgentCronJob> {
        let now_iso = iso_from_millis(now);
        let mut deleted = None;
        let jobs: Vec<AgentCronJob> = self
            .read_jobs()
            .into_iter()
            .map(|job| {
                if job.id != id
                    || job.active_session_id != active_session_id
                    || job.source.as_deref() != Some("rlm_heartbeat")
                {
                    return job;
                }
                let cancelled = AgentCronJob {
                    status: JobStatus::Cancelled,
                    next_run_at: None,
                    updated_at: now_iso.clone(),
                    ..job
                };
                deleted = Some(cancelled.clone());
                cancelled
            })
            .collect();
        if deleted.is_some() {
            self.write_jobs(&jobs);
        }
        deleted
    }

    pub fn cancel_rlm_heartbeats_for_session(
        &self,
        active_session_id: &str,
        now: u64,
    ) -> Vec<AgentCronJob> {
        let now_iso = iso_from_millis(now);
        let mut cancelled = Vec::new();
        let jobs: Vec<AgentCronJob> = self
            .read_jobs()
            .into_iter()
            .map(|job| {
                if job.active_session_id != active_session_id
                    || job.source.as_deref() != Some("rlm_heartbeat")
                    || !matches!(job.status, JobStatus::Active | JobStatus::Paused)
                {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cron::store::input;

    #[test]
    fn rlm_heartbeat_management() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = AgentCronJobStore::new(dir.path().join("jobs.json"));
        let now = 1_700_000_000_000;
        let mut rlm_input = input("watch pods", "every 10m", now);
        rlm_input.source = Some("rlm_heartbeat".to_string());
        let rlm = store.create_rlm_heartbeat(&rlm_input).unwrap();
        assert_eq!(store.list_rlm_heartbeats("live-1", false).len(), 1);
        // Pause via update.
        let paused = store
            .update_rlm_heartbeat(
                "live-1",
                &rlm.id,
                &RlmHeartbeatUpdate {
                    status: Some(RlmHeartbeatStatusUpdate::Pause),
                    now: Some(now + 1),
                    ..Default::default()
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(paused.status, JobStatus::Paused);
        // Resume recomputes the next run.
        let resumed = store
            .update_rlm_heartbeat(
                "live-1",
                &rlm.id,
                &RlmHeartbeatUpdate {
                    status: Some(RlmHeartbeatStatusUpdate::Resume),
                    now: Some(now + 2),
                    ..Default::default()
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(resumed.status, JobStatus::Active);
        // Delete cancels.
        let deleted = store
            .delete_rlm_heartbeat("live-1", &rlm.id, now + 3)
            .unwrap();
        assert_eq!(deleted.status, JobStatus::Cancelled);
        // Session teardown cancels all.
        let second = store.create_rlm_heartbeat(&rlm_input).unwrap();
        let cancelled = store.cancel_rlm_heartbeats_for_session("live-1", now + 4);
        assert_eq!(cancelled.len(), 1);
        assert_eq!(second.status, JobStatus::Active);
        assert!(cancelled[0].status == JobStatus::Cancelled);
    }
}
