//! The cron job store: file-backed job state with cross-process locking,
//! claim-based dispatch, and heartbeat lifecycle management. Submodules:
//! state save/load, generic jobs and dispatches, `/heartbeat` jobs, RLM
//! heartbeats, per-session artifacts.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::{is_heartbeat_cron_job, AgentCronJob, DeliveryMode, JobStatus};

mod heartbeat;
mod jobs;
mod rlm_heartbeat;
mod session_artifacts;
mod state;

pub use session_artifacts::read_scheduled_jobs_artifact;

pub const SESSION_SCHEDULED_JOBS_FILENAME: &str = "scheduled-jobs.json";

/// One claimed dispatch of a due job.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentCronDispatch {
    pub id: String,
    pub job: AgentCronJob,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCronDispatchRecord {
    pub id: String,
    pub job_id: String,
    pub claimed_at: String,
    pub scheduled_for: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub(crate) struct CronJobsState {
    pub(crate) jobs: Vec<AgentCronJob>,
    pub(crate) dispatches: Vec<AgentCronDispatchRecord>,
}

/// `/heartbeat`-visible result states.
pub type CronJobRunResult = &'static str; // "ran" | "skipped"

/// The file-backed job store.
pub struct AgentCronJobStore {
    file_path: Option<PathBuf>,
    session_artifact_mode: bool,
    /// Interior-mutex so an `Arc`-shared store can register a session's
    /// artifact partition as sessions bind.
    session_artifact_files: std::sync::Mutex<HashMap<String, PathBuf>>,
    heartbeat_change_listeners: Vec<Box<dyn Fn() + Send + Sync>>,
}

pub(crate) fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

pub(crate) fn iso_from_millis(millis: u64) -> String {
    crate::session::manager::format_iso(millis as i64)
}

/// Opaque debug form (the store holds change listeners that have no debug
/// representation); config dumps carry it as an unread marker.
impl std::fmt::Debug for AgentCronJobStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentCronJobStore").finish_non_exhaustive()
    }
}

impl AgentCronJobStore {
    /// Store backed by a single file.
    #[must_use]
    pub fn new(file_path: PathBuf) -> Self {
        Self {
            file_path: Some(file_path),
            session_artifact_mode: false,
            session_artifact_files: std::sync::Mutex::new(HashMap::new()),
            heartbeat_change_listeners: Vec::new(),
        }
    }

    /// Store spanning per-session artifact files.
    #[must_use]
    pub fn for_session_artifacts() -> Self {
        Self {
            file_path: None,
            session_artifact_mode: true,
            session_artifact_files: std::sync::Mutex::new(HashMap::new()),
            heartbeat_change_listeners: Vec::new(),
        }
    }

    pub fn on_heartbeat_change(&mut self, listener: Box<dyn Fn() + Send + Sync>) {
        self.heartbeat_change_listeners.push(listener);
    }

    pub(crate) fn notify_heartbeat_change(&self) {
        for listener in &self.heartbeat_change_listeners {
            listener();
        }
    }

    /// The listed heartbeat rows as one comparable string: any change a client renders (a fire
    /// rolling `nextRunAt`, the run count, the last error) changes it, so a fire broadcasts
    /// `heartbeats_changed` like a create or pause does.
    pub(crate) fn heartbeat_catalog_signature(jobs: &[AgentCronJob]) -> String {
        let mut heartbeat_jobs: Vec<&AgentCronJob> = jobs
            .iter()
            .filter(|job| {
                is_heartbeat_cron_job(job)
                    && matches!(job.status, JobStatus::Active | JobStatus::Paused)
            })
            .collect();
        heartbeat_jobs.sort_by(|left, right| left.id.cmp(&right.id));
        serde_json::to_string(&heartbeat_jobs).unwrap_or_default()
    }
}

/// Input to `create`/`create_heartbeat`/`create_rlm_heartbeat`.
#[derive(Debug, Clone, Default)]
pub struct CreateAgentCronJobInput {
    pub active_session_id: String,
    pub session_id: String,
    pub session_file: String,
    pub cwd: String,
    pub label: Option<String>,
    pub prompt: String,
    pub schedule_text: String,
    pub source: Option<String>,
    pub runtime_kind: Option<String>,
    pub delivery_mode: Option<DeliveryMode>,
    pub now: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct SessionBinding {
    pub active_session_id: String,
    pub session_id: String,
    pub session_file: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Default)]
pub struct CancelJobsFilter {
    pub active_session_id: Option<String>,
    pub session_id: Option<String>,
    pub session_file: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeartbeatManagementAction {
    Pause,
    Resume,
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RlmHeartbeatStatusUpdate {
    Pause,
    Resume,
}

#[derive(Debug, Clone, Default)]
pub struct RlmHeartbeatUpdate {
    pub label: Option<String>,
    pub prompt: Option<String>,
    pub schedule_text: Option<String>,
    pub status: Option<RlmHeartbeatStatusUpdate>,
    pub delivery_mode: Option<DeliveryMode>,
    pub now: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct RecordRunOptions {
    pub now: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DispatchResultOptions {
    pub now: Option<u64>,
    pub outcome: &'static str, // "ran" | "skipped"
    pub error: Option<String>,
}

/// Shared builder for [`CreateAgentCronJobInput`] used by the store's tests.
#[cfg(test)]
pub(crate) fn input(prompt: &str, schedule_text: &str, now: u64) -> CreateAgentCronJobInput {
    CreateAgentCronJobInput {
        active_session_id: "live-1".to_string(),
        session_id: "session-1".to_string(),
        session_file: "/w/session.jsonl".to_string(),
        cwd: "/w".to_string(),
        prompt: prompt.to_string(),
        schedule_text: schedule_text.to_string(),
        now: Some(now),
        ..Default::default()
    }
}
