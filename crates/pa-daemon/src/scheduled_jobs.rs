//! The scheduling surface (protocol breadth wave b10): the worker arms for
//! the cron/heartbeat catalog (`cron_list`, `heartbeats_list`,
//! `heartbeat_manage`, `cron_add`, `cron_cancel`, `heartbeat_get`,
//! `heartbeat_set`, `heartbeat_update` — TS daemon-mode cases over
//! `AgentCronJobStore`), the per-session artifact store they read, and the
//! scheduler that fires due jobs into the session queue (TS
//! `AgentCronScheduler` + `runCronJob`).
//!
//! Store: one `AgentCronJobStore::for_session_artifacts()` per worker
//! process, like TS daemon-mode (`options.worker ?
//! AgentCronJobStore.forSessionArtifacts() : ...`); sessions register
//! their artifact partition when they bind (create and every
//! replacement flow - new_session / switch_session / import_jsonl /
//! fork) and jobs rebind with them.
//!
//! Delivery: a due job is claimed by the store and fired through the
//! session's queue lanes — heartbeats on their delivery-mode lane (steer
//! -> steering, follow-up -> follow-up) with the TS queue key
//! `heartbeat:<id>` (a later fire replaces the queued one) as the
//! injected `heartbeat_prompt` custom row (TS `promptHeartbeat` /
//! `createHeartbeatPromptMessage`), plain cron jobs on the follow-up
//! lane as a regular prompt (TS queues a busy session's scheduled prompt
//! as a follow-up). The fire settles when its turn settles, so the
//! store's run bookkeeping (`lastRunAt`/`runCount`) matches the TS
//! record-after-run timing.
//!
//! Deviation (deferred fires): TS `promptHeartbeat` steers a running
//! turn mid-stream; this port's lanes deliver at the next turn boundary
//! (the same queue semantics the `steer` command uses).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::{oneshot, Notify};

use pa_core::cron::scheduler::{AgentCronScheduler, AgentCronSchedulerHooks};
use pa_core::cron::store::{
    AgentCronJobStore, CancelJobsFilter, CreateAgentCronJobInput, HeartbeatManagementAction,
    SessionBinding,
};
use pa_core::cron::{
    is_heartbeat_cron_job, normalize_heartbeat_delivery_mode, normalize_heartbeat_schedule,
    should_defer_heartbeat_cron_job, AgentCronJob, DeliveryMode, HeartbeatSessionActivity,
    JobStatus,
};

use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::{QueuedItem, SessionCore, Worker};

/// How long a scheduler fire waits for its turn to settle before answering
/// the scheduler with a skip (a stuck turn must not pin the dispatch lane
/// forever).
const FIRE_SETTLE_TIMEOUT_MS: u64 = 15 * 60 * 1000;

/// The session-artifact directory for one session file (TS
/// `getSessionArtifactPathForFile`): `<sessions>/../session-artifacts/<id>`.
pub(crate) fn session_artifact_dir(session_file: &Path, session_id: &str) -> Option<PathBuf> {
    session_file
        .parent()?
        .parent()
        .map(|root| root.join("session-artifacts").join(session_id))
}

/// The scheduler hooks: how a claimed job reaches this session.
pub(crate) struct QueueHooks {
    core: Arc<Mutex<SessionCore>>,
    work_notify: Arc<Notify>,
    user_bash: Arc<crate::user_bash::UserBash>,
    store: Arc<AgentCronJobStore>,
    /// The worker recovery journal (the fire checkpoint's busy evidence).
    recovery: Arc<Mutex<Option<crate::journal::WorkerRecoveryJournal>>>,
}

impl QueueHooks {
    /// The session's activity snapshot (TS `shouldDeferHeartbeatCronJob`
    /// inputs): busy flags off the core plus the bash slot.
    fn activity(&self) -> HeartbeatSessionActivity {
        let core = self
            .core
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        HeartbeatSessionActivity {
            is_streaming: core.busy,
            is_compacting: core.compacting,
            // The abort flag the retry lane reads: the closest live
            // signal this port keeps for an in-flight retry.
            is_retrying: core.retry_abort_requested,
            is_bash_running: self.user_bash.is_running(),
            has_pending_session_work: !core.pending_next_turn.is_empty(),
            unfinished_action_count: core.steering.len() + core.follow_up.len(),
        }
    }
}

impl QueueHooks {
    /// TS `isPersistedCronJobRunnable` (the persisted-job half): a
    /// persisted job may only fire at a session that still exists — the
    /// session file present, still the job's session, still carrying the
    /// `active` state. A killed (`archived`) or deleted session fails the
    /// check.
    fn persisted_target_gone(&self, job: &AgentCronJob) -> bool {
        if job.session_file.is_empty() {
            return true;
        }
        match crate::session_store::read_session_info(Path::new(&job.session_file)) {
            None => true,
            Some(info) => info.id != job.session_id || info.state.as_deref() != Some("active"),
        }
    }

    /// The failed-runnable cancel (TS
    /// `cancelScheduledJobsForSessionFile`): the store cancels the dead
    /// session's whole job set by file, so the artifact never re-fires.
    fn cancel_jobs_for_dead_target(&self, job: &AgentCronJob) {
        self.store.cancel_jobs_for_session(
            &CancelJobsFilter {
                active_session_id: None,
                session_id: None,
                session_file: Some(job.session_file.clone()),
            },
            crate::util::now_ms(),
        );
    }
}

impl AgentCronSchedulerHooks for QueueHooks {
    async fn run_job(&self, job: &AgentCronJob) -> anyhow::Result<Option<&'static str>> {
        // TS `runCronJob` -> `getOrCreateCronJobSession` ->
        // `isPersistedCronJobRunnable`: a persisted job whose target is no
        // longer live (killed — state `archived` — or deleted) cancels the
        // session's jobs and skips, so a fire can never revive a stopped
        // session (the zombie fix's delivery-side gate).
        if self.persisted_target_gone(job) {
            self.cancel_jobs_for_dead_target(job);
            return Ok(Some("skipped"));
        }
        let activity = self.activity();
        if should_defer_heartbeat_cron_job(job, &activity) {
            return Ok(Some("skipped"));
        }
        let (done_tx, done_rx) = oneshot::channel();
        let heartbeat = is_heartbeat_cron_job(job);
        let queue_key = heartbeat.then(|| format!("heartbeat:{}", job.id));
        // A heartbeat rides its delivery-mode lane; a plain cron job
        // queues on the follow-up lane (the fire checkpoint after the
        // admission reads the same lane decision).
        let rides_steering =
            heartbeat && !matches!(job.delivery_mode, Some(DeliveryMode::FollowUp));
        {
            let mut core = self
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !core.created || core.shutdown_requested || job.status != JobStatus::Active {
                return Ok(Some("skipped"));
            }
            // TS cron fires resume the suspension before admission
            // (`promptHeartbeat`/`promptUntilAccepted` carry
            // `resumeIfIdle: true`): a fire on a post-abort/post-compact
            // session is a resume site.
            core.queued_input_suspended = false;
            // The TS `heartbeat:<id>` queue key: a later fire replaces the
            // queued one instead of stacking.
            if let Some(key) = &queue_key {
                core.steering
                    .retain(|item| item.queue_key.as_deref() != Some(key.as_str()));
                core.follow_up
                    .retain(|item| item.queue_key.as_deref() != Some(key.as_str()));
            }
            let lane = if rides_steering {
                &mut core.steering
            } else {
                &mut core.follow_up
            };
            // TS `runCronJob`: a heartbeat fire delivers through
            // `promptHeartbeat`, so the turn IS the injected
            // `heartbeat_prompt` custom row (TS
            // `createHeartbeatPromptMessage`) — the transcript renders the
            // heartbeat prompt component while the model turn runs on the
            // row's content. A plain cron job stays a regular prompt (TS
            // `promptUntilAccepted`).
            let (message, preview, custom_message) = if heartbeat {
                let row = pa_core::session_engine::messages::create_heartbeat_prompt_message(
                    job,
                    crate::util::now_ms(),
                );
                let content = row.content.text();
                // TS `_createPreparedTurnAction` over
                // `injectedMessagePreviewLabel`: the parked row reads
                // `Heartbeat prompt: <content>` (the TUI renders it with its
                // own label, no lane label), while the active-action label
                // keeps the raw content (TS `compactRlmText(payload.text)`).
                let preview = format!(
                    "{}: {content}",
                    pa_core::session_engine::messages::HEARTBEAT_PROMPT_PREVIEW_LABEL
                );
                (
                    content,
                    Some(preview),
                    Some(crate::session_commands::custom_message_value(&row)),
                )
            } else {
                (job.prompt.clone(), None, None)
            };
            lane.push_back(QueuedItem {
                message,
                preview,
                custom_message,
                agent_message: None,
                admission_id: None,
                images: Vec::new(),
                queue_key,
                done: Some(done_tx),
                queue_visible: true,
                policy: crate::worker::TurnPolicy::Injected,
                forced_batch: false,
            });
        }
        // The fire checkpoint (busy=true): a scheduled prompt is admitted
        // live work, and heartbeats/cron jobs run unattended — no client
        // reopens a parked session, so a crash mid-fire must revive the
        // worker to run it. The operation is the lane's TS queue string.
        crate::worker::checkpoint_queue_recovery(
            &self.recovery,
            &self.core,
            crate::worker::QueueCheckpoint::Admitted {
                operation: if rides_steering {
                    "steer_queued"
                } else {
                    "follow_up_queued"
                },
            },
        );
        self.work_notify.notify_one();
        match tokio::time::timeout(
            std::time::Duration::from_millis(FIRE_SETTLE_TIMEOUT_MS),
            done_rx,
        )
        .await
        {
            // The turn ran. A turn that settled with an error still
            // counts as a run (the store bumps runCount and records
            // lastError, the TS recordRunResult-with-error shape), but
            // the error propagates to the scheduler so its failure
            // backoff stretches the next fire (documented deviation: TS
            // re-fires per schedule regardless of failures).
            Ok(Ok(Ok(()))) => Ok(None),
            Ok(Ok(Err(error))) => Err(anyhow::anyhow!(error)),
            // The queued item was consumed without a settle handshake
            // (its waiter dropped — a runner that died mid-turn, or the
            // harness's direct pop): the fire ran as far as the queue
            // could deliver it.
            Ok(Err(_)) => Ok(None),
            // The settle window expired: the fire did not run.
            Err(_) => Ok(Some("skipped")),
        }
    }
}

/// The worker's schedule catalog: the shared artifact store plus the
/// scheduler (started when the first session binds).
pub(crate) struct ScheduledJobs {
    store: Arc<AgentCronJobStore>,
    hooks: Arc<QueueHooks>,
    scheduler: tokio::sync::Mutex<Option<Arc<AgentCronScheduler<QueueHooks>>>>,
}

impl ScheduledJobs {
    pub(crate) fn new(
        core: Arc<Mutex<SessionCore>>,
        work_notify: Arc<Notify>,
        user_bash: Arc<crate::user_bash::UserBash>,
        events: Arc<crate::worker::EventPump>,
        recovery: Arc<Mutex<Option<crate::journal::WorkerRecoveryJournal>>>,
    ) -> Self {
        let mut store = AgentCronJobStore::for_session_artifacts();
        // TS daemon-mode's `cronStore.onHeartbeatChange` →
        // `broadcastGlobal({ type: "heartbeats_changed" })`: any heartbeat
        // catalog change (user set/manage, agent `rlm_heartbeat` CRUD, a
        // fire's bookkeeping) broadcasts to the clients and the supervisor
        // re-broadcasts daemon-wide.
        store.on_heartbeat_change(Box::new(move || {
            events.send(crate::worker::OutboundFrame::heartbeats_changed());
        }));
        let store = Arc::new(store);
        ScheduledJobs {
            hooks: Arc::new(QueueHooks {
                core,
                work_notify,
                user_bash,
                store: Arc::clone(&store),
                recovery,
            }),
            store,
            scheduler: tokio::sync::Mutex::new(None),
        }
    }

    pub(crate) fn store(&self) -> &Arc<AgentCronJobStore> {
        &self.store
    }

    /// Bind the live session (TS `rebindCronJobsToState`): register the
    /// session's artifact partition, move its stored jobs onto the live
    /// ids, and start (or wake) the scheduler.
    pub(crate) async fn bind_session(
        &self,
        binding: SessionBinding,
        artifact_dir: Option<PathBuf>,
    ) {
        if let Some(dir) = artifact_dir {
            let _ = std::fs::create_dir_all(&dir);
            self.store
                .register_session_artifact(&binding.session_id, &dir);
        }
        if !binding.session_file.is_empty() {
            self.store.rebind_session_jobs(&binding);
        }
        let mut guard = self.scheduler.lock().await;
        if let Some(scheduler) = guard.as_ref() {
            scheduler.wake().await;
            return;
        }
        let scheduler = Arc::new(AgentCronScheduler::new(
            Arc::clone(&self.store),
            Arc::clone(&self.hooks),
        ));
        scheduler.start().await;
        *guard = Some(scheduler);
    }

    /// Re-arm the timer after a catalog mutation (TS `cronScheduler.wake`).
    pub(crate) async fn wake(&self) {
        let guard = self.scheduler.lock().await;
        if let Some(scheduler) = guard.as_ref() {
            scheduler.wake().await;
        }
    }

    /// The kernel rlm heartbeat mutation hook (TS daemon-mode's
    /// controller post-mutation work: `removeQueuedHeartbeatFollowUp`
    /// where the mutation withdraws the queued fire, then
    /// `cronScheduler.wake()`): installed by the worker onto the session
    /// engine's kernel cron wiring, invoked by the `rlm_heartbeat.*` host
    /// handlers after every create/update/delete. Without the wake the
    /// bind-time arm — taken over an empty store — leaves no timer, and a
    /// heartbeat created afterwards never fires.
    pub(crate) fn mutation_hook(
        self: &std::sync::Arc<Self>,
    ) -> pa_core::session_engine::host_requests::RlmHeartbeatMutationHook {
        let scheduled = std::sync::Arc::clone(self);
        std::sync::Arc::new(move |mutation| {
            let scheduled = std::sync::Arc::clone(&scheduled);
            Box::pin(async move {
                if mutation.drop_queued {
                    scheduled.remove_queued_heartbeat_follow_up(&mutation.job);
                }
                scheduled.wake().await;
            })
        })
    }

    /// `removeQueuedHeartbeatFollowUp` (TS daemon-mode): drop the queued
    /// fire of a heartbeat job from the session's queue.
    pub(crate) fn remove_queued_heartbeat_follow_up(&self, job: &AgentCronJob) {
        if !is_heartbeat_cron_job(job) {
            return;
        }
        let key = format!("heartbeat:{}", job.id);
        {
            let mut core = self
                .hooks
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            core.steering
                .retain(|item| item.queue_key.as_deref() != Some(key.as_str()));
            core.follow_up
                .retain(|item| item.queue_key.as_deref() != Some(key.as_str()));
        }
        // Same settle as the other withdrawals: the mutation withdrew a
        // queued fire, so the verdict and the snapshot must not keep the
        // fire's admission busy=true (a revive would replay the deleted
        // heartbeat's prompt from the stale snapshot).
        crate::worker::checkpoint_queue_recovery(
            &self.hooks.recovery,
            &self.hooks.core,
            crate::worker::QueueCheckpoint::Settle {
                operation: "queue_purged",
            },
        );
    }
}

/// The bind inputs of one live session (TS `SessionBinding` plus the
/// session's artifact partition): `None` for in-memory sessions.
pub(crate) fn live_binding(core: &SessionCore) -> Option<(SessionBinding, Option<PathBuf>)> {
    let store = core.store.as_ref()?;
    if store.path.as_os_str().is_empty() {
        return None;
    }
    Some((
        SessionBinding {
            active_session_id: core.active_session_id.clone(),
            session_id: store.session_id().to_string(),
            session_file: store.path.to_string_lossy().to_string(),
            cwd: core.cwd.clone(),
        },
        session_artifact_dir(&store.path, store.session_id()),
    ))
}

impl Worker {
    /// Register the live session's artifact partition on the store
    /// (idempotent) so catalog reads see this session's jobs.
    fn bind_store_artifact(&self, core: &SessionCore) {
        let Some(store) = core.store.as_ref() else {
            return;
        };
        if store.path.as_os_str().is_empty() {
            return;
        }
        if let Some(dir) = session_artifact_dir(&store.path, store.session_id()) {
            self.scheduled
                .store()
                .register_session_artifact(store.session_id(), &dir);
        }
    }

    /// TS `cancelScheduledJobsForSession(state)` (the killed close's
    /// schedule cancel): the session's whole job set cancels (matched by
    /// any of the session's three identities, exactly the TS filter), each
    /// cancelled heartbeat's queued follow-up withdraws
    /// (`removeQueuedHeartbeatFollowUp`), and the scheduler re-arms. The
    /// cancel is durable, so the stopped session's own heartbeats can
    /// never revive it.
    pub(crate) async fn cancel_session_scheduled_jobs(&self) {
        let (active_session_id, session_id, session_file) = {
            let core = self
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.bind_store_artifact(&core);
            let Some(store) = core.store.as_ref() else {
                return;
            };
            (
                core.active_session_id.clone(),
                store.session_id().to_string(),
                store.path.to_string_lossy().to_string(),
            )
        };
        let cancelled = self.scheduled.store().cancel_jobs_for_session(
            &pa_core::cron::store::CancelJobsFilter {
                active_session_id: Some(active_session_id),
                session_id: Some(session_id),
                session_file: Some(session_file),
            },
            crate::util::now_ms(),
        );
        for job in &cancelled {
            self.scheduled.remove_queued_heartbeat_follow_up(job);
        }
        if !cancelled.is_empty() {
            self.scheduled.wake().await;
        }
    }

    /// TS `cancelSubagentRlmHeartbeats(state)` (the replaced close of a
    /// subagent): only the subagent's RLM heartbeat jobs cancel; the plain
    /// cron jobs survive the replacement. A top-level session cancels
    /// nothing here (the TS `kind !== "subagent"` gate).
    pub(crate) async fn cancel_session_rlm_heartbeats(&self) {
        let (is_subagent, active_session_id) = {
            let core = self
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.bind_store_artifact(&core);
            (
                core.runtime_kind == "subagent",
                core.active_session_id.clone(),
            )
        };
        if !is_subagent {
            return;
        }
        let cancelled = self
            .scheduled
            .store()
            .cancel_rlm_heartbeats_for_session(&active_session_id, crate::util::now_ms());
        for job in &cancelled {
            self.scheduled.remove_queued_heartbeat_follow_up(job);
        }
        if !cancelled.is_empty() {
            self.scheduled.wake().await;
        }
    }

    /// TS `cancelScheduledJobsForSessionFile` (the saved-session delete's
    /// `afterFileRemoved` hook): register the deleted file's artifact
    /// partition (only when its store file exists) and cancel its whole
    /// job set by file, so the jobs die with the delete even if the
    /// partition removal fails. The hook runs once the file is gone, so
    /// the partition derives from the file's stem (the session file IS
    /// `<session id>.jsonl`), not from a session-info read. Best-effort:
    /// the deletion never fails on a store error (the TS hook's failures
    /// are logged, not thrown).
    pub(crate) fn cancel_deleted_session_jobs(&self, session_file: &std::path::Path) {
        let Some(session_id) = session_file
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|stem| !stem.is_empty())
        else {
            return;
        };
        let Some(dir) = session_artifact_dir(session_file, session_id) else {
            return;
        };
        if !dir
            .join(pa_core::cron::store::SESSION_SCHEDULED_JOBS_FILENAME)
            .is_file()
        {
            return;
        }
        self.scheduled
            .store()
            .register_session_artifact(session_id, &dir);
        self.scheduled.store().cancel_jobs_for_session(
            &pa_core::cron::store::CancelJobsFilter {
                active_session_id: None,
                session_id: None,
                session_file: Some(session_file.to_string_lossy().to_string()),
            },
            crate::util::now_ms(),
        );
    }

    /// `cron_list` (TS daemon-mode case): the store's jobs filtered by the
    /// selector and the inactive cut.
    pub(crate) async fn handle_cron_list(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("cron_list") {
            return response;
        }
        let include_inactive = payload
            .get("includeInactive")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let selector = payload.get("activeSessionId").and_then(Value::as_str);
        {
            let core = self
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.bind_store_artifact(&core);
        }
        let jobs: Vec<Value> = self
            .scheduled
            .store()
            .list()
            .into_iter()
            .filter(|job| {
                if !include_inactive && !matches!(job.status, JobStatus::Active | JobStatus::Paused)
                {
                    return false;
                }
                match selector {
                    Some(selector) => job.active_session_id == selector,
                    None => true,
                }
            })
            .filter_map(|job| serde_json::to_value(&job).ok())
            .collect();
        response_success(None, "cron_list", Some(json!({ "jobs": jobs })))
    }

    /// `heartbeats_list` (TS daemon-mode `listHeartbeats`): the live or
    /// paused heartbeat jobs as `{ job, sessionName?, firstMessage? }`.
    pub(crate) fn handle_heartbeats_list(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("heartbeats_list") {
            return response;
        }
        let summary = {
            let core = self
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.bind_store_artifact(&core);
            self.summary_locked(&core)
        };
        let heartbeats: Vec<Value> = self
            .scheduled
            .store()
            .list()
            .into_iter()
            .filter(|job| {
                is_heartbeat_cron_job(job)
                    && matches!(job.status, JobStatus::Active | JobStatus::Paused)
            })
            .map(|job| {
                let mut heartbeat = json!({
                    "job": serde_json::to_value(&job).unwrap_or(Value::Null),
                });
                if let Some(name) = summary.session_name.as_deref() {
                    heartbeat["sessionName"] = json!(name);
                }
                if let Some(first) = summary.first_message.as_deref() {
                    heartbeat["firstMessage"] = json!(first);
                }
                heartbeat
            })
            .collect();
        response_success(
            None,
            "heartbeats_list",
            Some(json!({ "heartbeats": heartbeats })),
        )
    }

    /// `heartbeat_manage` (TS daemon-mode case over `manageHeartbeat`):
    /// pause/resume/stop a heartbeat by job id; an unknown id answers the
    /// TS error.
    pub(crate) async fn handle_heartbeat_manage(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("heartbeat_manage") {
            return response;
        }
        let active_session_id = payload
            .get("activeSessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let job_id = payload
            .get("jobId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        // The TS store treats any non-pause/non-stop action as resume.
        let action = match payload.get("action").and_then(Value::as_str) {
            Some("pause") => HeartbeatManagementAction::Pause,
            Some("stop") => HeartbeatManagementAction::Stop,
            _ => HeartbeatManagementAction::Resume,
        };
        {
            let core = self
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.bind_store_artifact(&core);
        }
        let managed = self.scheduled.store().manage_heartbeat(
            &active_session_id,
            &job_id,
            action,
            crate::util::now_ms(),
        );
        let Ok(Some(job)) = managed else {
            return response_failure(
                None,
                "heartbeat_manage",
                &format!("No active heartbeat found: {job_id}"),
                None,
            );
        };
        if action != HeartbeatManagementAction::Resume {
            self.scheduled.remove_queued_heartbeat_follow_up(&job);
        }
        self.scheduled.wake().await;
        response_success(
            None,
            "heartbeat_manage",
            Some(json!({ "heartbeat": serde_json::to_value(&job).unwrap_or(Value::Null) })),
        )
    }

    /// `cron_add` (TS daemon-mode case over `createCronJobForState`).
    pub(crate) async fn handle_cron_add(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("cron_add") {
            return response;
        }
        let input = {
            let core = self
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.bind_store_artifact(&core);
            let store = match core.store.as_ref() {
                Some(store) if !store.path.as_os_str().is_empty() => store,
                _ => {
                    return response_failure(
                        None,
                        "cron_add",
                        "Cron jobs require a persisted session file",
                        None,
                    )
                }
            };
            CreateAgentCronJobInput {
                active_session_id: core.active_session_id.clone(),
                session_id: store.session_id().to_string(),
                session_file: store.path.to_string_lossy().to_string(),
                cwd: core.cwd.clone(),
                runtime_kind: Some(core.runtime_kind.clone()),
                prompt: payload
                    .get("prompt")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                schedule_text: payload
                    .get("schedule")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                ..Default::default()
            }
        };
        match self.scheduled.store().create(&input) {
            Ok(job) => {
                self.scheduled.wake().await;
                response_success(
                    None,
                    "cron_add",
                    Some(json!({ "job": serde_json::to_value(&job).unwrap_or(Value::Null) })),
                )
            }
            Err(error) => response_failure(None, "cron_add", &error.to_string(), None),
        }
    }

    /// `cron_cancel` (TS daemon-mode case): cancel by job id, drop any
    /// queued fire, and re-arm the timer.
    pub(crate) async fn handle_cron_cancel(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("cron_cancel") {
            return response;
        }
        let job_id = payload
            .get("jobId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        {
            let core = self
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.bind_store_artifact(&core);
        }
        match self
            .scheduled
            .store()
            .cancel(&job_id, crate::util::now_ms())
        {
            Some(job) => {
                self.scheduled.remove_queued_heartbeat_follow_up(&job);
                self.scheduled.wake().await;
                response_success(
                    None,
                    "cron_cancel",
                    Some(json!({ "job": serde_json::to_value(&job).unwrap_or(Value::Null) })),
                )
            }
            None => response_failure(
                None,
                "cron_cancel",
                &format!("No cron job found: {job_id}"),
                None,
            ),
        }
    }

    /// `heartbeat_get` (TS daemon-mode case): the session's live or paused
    /// heartbeat, or null.
    pub(crate) fn handle_heartbeat_get(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("heartbeat_get") {
            return response;
        }
        let active_session_id = payload
            .get("activeSessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        {
            let core = self
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.bind_store_artifact(&core);
        }
        let heartbeat = self
            .scheduled
            .store()
            .get_heartbeat(&active_session_id)
            .and_then(|job| serde_json::to_value(&job).ok());
        response_success(
            None,
            "heartbeat_get",
            Some(json!({ "heartbeat": heartbeat.unwrap_or(Value::Null) })),
        )
    }

    /// `heartbeat_set` (TS daemon-mode case over `createHeartbeatForState`):
    /// replace the session's heartbeat.
    pub(crate) async fn handle_heartbeat_set(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("heartbeat_set") {
            return response;
        }
        let delivery_mode = match normalize_heartbeat_delivery_mode(
            payload.get("deliveryMode").and_then(Value::as_str),
        ) {
            Ok(mode) => mode,
            Err(error) => return response_failure(None, "heartbeat_set", &error.to_string(), None),
        };
        let (previous, input) = {
            let core = self
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.bind_store_artifact(&core);
            let store = match core.store.as_ref() {
                Some(store) if !store.path.as_os_str().is_empty() => store,
                _ => {
                    return response_failure(
                        None,
                        "heartbeat_set",
                        "Heartbeats require a persisted session file",
                        None,
                    )
                }
            };
            let previous = self
                .scheduled
                .store()
                .get_heartbeat(&core.active_session_id);
            // A replacement keeps the previous delivery mode unless the
            // command carries one (TS `createHeartbeatForState`).
            let delivery_mode =
                delivery_mode.or(previous.as_ref().and_then(|job| job.delivery_mode));
            (
                previous,
                CreateAgentCronJobInput {
                    active_session_id: core.active_session_id.clone(),
                    session_id: store.session_id().to_string(),
                    session_file: store.path.to_string_lossy().to_string(),
                    cwd: core.cwd.clone(),
                    runtime_kind: Some(core.runtime_kind.clone()),
                    delivery_mode,
                    schedule_text: normalize_heartbeat_schedule(Some(
                        payload
                            .get("schedule")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    )),
                    prompt: payload
                        .get("prompt")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    ..Default::default()
                },
            )
        };
        match self.scheduled.store().create_heartbeat(&input) {
            Ok(job) => {
                if let Some(previous) = previous {
                    self.scheduled.remove_queued_heartbeat_follow_up(&previous);
                }
                self.scheduled.wake().await;
                response_success(
                    None,
                    "heartbeat_set",
                    Some(json!({ "heartbeat": serde_json::to_value(&job).unwrap_or(Value::Null) })),
                )
            }
            Err(error) => response_failure(None, "heartbeat_set", &error.to_string(), None),
        }
    }

    /// `heartbeat_update` (TS daemon-mode case over
    /// `updateHeartbeatForState`): pause/resume/clear the session's
    /// heartbeat.
    pub(crate) async fn handle_heartbeat_update(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("heartbeat_update") {
            return response;
        }
        let active_session_id = payload
            .get("activeSessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let resume = payload.get("action").and_then(Value::as_str) == Some("resume");
        let now = crate::util::now_ms();
        {
            let core = self
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.bind_store_artifact(&core);
        }
        let outcome = match payload.get("action").and_then(Value::as_str) {
            Some("pause") => Ok(self
                .scheduled
                .store()
                .pause_heartbeat(&active_session_id, now)),
            Some("resume") => self
                .scheduled
                .store()
                .resume_heartbeat(&active_session_id, now),
            // TS `updateHeartbeatForState`: anything but pause/resume
            // clears the heartbeat.
            _ => Ok(self
                .scheduled
                .store()
                .clear_heartbeat(&active_session_id, now)),
        };
        let outcome = match outcome {
            Ok(job) => job,
            Err(error) => {
                return response_failure(None, "heartbeat_update", &error.to_string(), None)
            }
        };
        if let Some(job) = &outcome {
            if !resume {
                self.scheduled.remove_queued_heartbeat_follow_up(job);
            }
        }
        self.scheduled.wake().await;
        let heartbeat = outcome
            .and_then(|job| serde_json::to_value(&job).ok())
            .unwrap_or(Value::Null);
        response_success(
            None,
            "heartbeat_update",
            Some(json!({ "heartbeat": heartbeat })),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::Worker;
    use std::sync::Arc;

    fn persisted_worker_config(dir: &std::path::Path) -> crate::worker::WorkerConfig {
        crate::worker::WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "hb-fire-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(serde_json::json!({ "responses": ["ack", "ack", "ack", "ack"] })),
        }
    }

    /// The fire-chain e2e behind the dogfood P0 (a heartbeat created by
    /// the kernel never fired): the kernel's `rlm_heartbeat.create` store
    /// mutation plus the mutation hook the worker installs must re-arm the
    /// bind-time (empty) scheduler, fire the job on schedule, deliver its
    /// prompt onto the session's steer lane, and record the run.
    /// An active rlm heartbeat job due to fire (`every 10s`, never run).
    fn heartbeat_job(
        id: &str,
        prompt: &str,
        delivery_mode: DeliveryMode,
        session: &(String, std::path::PathBuf),
    ) -> AgentCronJob {
        AgentCronJob {
            id: id.to_string(),
            status: JobStatus::Active,
            source: Some("rlm_heartbeat".to_string()),
            runtime_kind: None,
            delivery_mode: Some(delivery_mode),
            active_session_id: session.0.clone(),
            session_id: session.0.clone(),
            session_file: session.1.to_string_lossy().to_string(),
            cwd: "/w".to_string(),
            label: None,
            prompt: prompt.to_string(),
            schedule: pa_core::cron::AgentCronSchedule {
                kind: pa_core::cron::ScheduleKind::Interval,
                expression: "every 10s".to_string(),
                interval_ms: Some(10_000),
            },
            created_at: "2026-09-22T00:00:00.000Z".to_string(),
            updated_at: "2026-09-22T00:00:00.000Z".to_string(),
            next_run_at: None,
            last_run_at: None,
            last_skipped_at: None,
            last_error: None,
            run_count: 0,
        }
    }

    /// A persisted, `active`-state session file the fire's target
    /// verification (TS `isPersistedCronJobRunnable`) reads.
    fn write_active_session(dir: &std::path::Path) -> (String, std::path::PathBuf) {
        let mut session = crate::session_store::SessionFile::create("/w", None, 0);
        session.append_message(serde_json::json!({
            "role": "user", "content": "hi", "timestamp": 1u64
        }));
        let path = dir.join(crate::session_store::session_file_name(
            session.session_id(),
        ));
        session.set_path(path.clone());
        let _ = session.append_session_state("active");
        session.rewrite().unwrap();
        (session.session_id().to_string(), path)
    }

    /// The delivery-side verification (TS `isPersistedCronJobRunnable`):
    /// a fire whose target was killed (state `archived`) cancels the
    /// session's jobs and skips instead of reviving it, and the queue
    /// lanes stay empty.
    #[tokio::test]
    async fn a_fire_at_a_killed_session_cancels_and_skips() {
        let dir = std::env::temp_dir().join(format!("pa-sched-dead-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (session_id, session_file) = write_active_session(&dir);
        let store = AgentCronJobStore::for_session_artifacts();
        let artifact_dir = session_artifact_dir(&session_file, &session_id).unwrap();
        std::fs::create_dir_all(&artifact_dir).unwrap();
        store.register_session_artifact(&session_id, &artifact_dir);
        let job = store
            .create(&CreateAgentCronJobInput {
                active_session_id: session_id.clone(),
                session_id: session_id.clone(),
                session_file: session_file.to_string_lossy().to_string(),
                cwd: "/w".to_string(),
                prompt: "lane-liveness ping".to_string(),
                schedule_text: "every 10s".to_string(),
                now: Some(1),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(job.status, JobStatus::Active);

        // The session is killed: the close appended the `archived` state.
        let mut session = crate::session_store::SessionFile::open(&session_file).unwrap();
        let _ = session.append_session_state("archived");
        session.rewrite().unwrap();

        let core = Arc::new(std::sync::Mutex::new(
            crate::worker::SessionCore::test_core(None, "/w".to_string()),
        ));
        let hooks = QueueHooks {
            core: Arc::clone(&core),
            work_notify: Arc::new(Notify::new()),
            user_bash: Arc::new(crate::user_bash::UserBash::new()),
            store: Arc::new(AgentCronJobStore::for_session_artifacts()),
            recovery: Arc::new(std::sync::Mutex::new(None)),
        };
        // The dead-target cancel registers the artifact partition itself
        // (a fresh store knows nothing of the session yet).
        hooks
            .store
            .register_session_artifact(&session_id, &artifact_dir);

        let verdict = AgentCronSchedulerHooks::run_job(&hooks, &job)
            .await
            .unwrap();
        assert_eq!(verdict, Some("skipped"));
        let stored = hooks.store.list();
        let cancelled = stored
            .iter()
            .find(|candidate| candidate.id == job.id)
            .expect("the job stays in the store");
        assert_eq!(cancelled.status, JobStatus::Cancelled);
        assert_eq!(cancelled.next_run_at, None);
        let core = core.lock().unwrap();
        assert!(
            core.steering.is_empty() && core.follow_up.is_empty(),
            "no fire parks at a killed session"
        );
    }

    /// The fire's parked shape (TS `runCronJob` -> `promptHeartbeat`): a
    /// heartbeat parks on its delivery-mode lane as the injected
    /// `heartbeat_prompt` row with the TS preview — the queue strip reads
    /// `Heartbeat prompt: <content>` (no lane label), while the turn text
    /// and the active-action label keep the raw content — and a plain cron
    /// job parks as a regular follow-up prompt.
    #[tokio::test]
    async fn heartbeat_fire_parks_the_labeled_preview_on_its_lane() {
        let dir = std::env::temp_dir().join(format!("pa-sched-fire-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let session = write_active_session(&dir);
        let core = Arc::new(std::sync::Mutex::new(
            crate::worker::SessionCore::test_core(None, "/w".to_string()),
        ));
        let hooks = Arc::new(QueueHooks {
            core: Arc::clone(&core),
            work_notify: Arc::new(Notify::new()),
            user_bash: Arc::new(crate::user_bash::UserBash::new()),
            store: Arc::new(AgentCronJobStore::for_session_artifacts()),
            recovery: Arc::new(std::sync::Mutex::new(None)),
        });
        let steer_heartbeat =
            heartbeat_job("hb-1", "steer the mission", DeliveryMode::Steer, &session);
        let follow_up_heartbeat = heartbeat_job(
            "hb-2",
            "wrap the mission up",
            DeliveryMode::FollowUp,
            &session,
        );
        let plain_cron = AgentCronJob {
            source: Some("cron".to_string()),
            ..heartbeat_job("cron-1", "nightly sweep", DeliveryMode::Steer, &session)
        };
        for job in [&steer_heartbeat, &follow_up_heartbeat, &plain_cron] {
            let hooks = Arc::clone(&hooks);
            let spawned_job = job.clone();
            let run = tokio::spawn(async move {
                pa_core::cron::scheduler::AgentCronSchedulerHooks::run_job(&*hooks, &spawned_job)
                    .await
            });
            // The spawned fire parks its item before its settle wait; the
            // runner is absent, so the item stays parked until this test
            // pops it (releasing the settle).
            let park_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            let (lane, item) = loop {
                let popped = {
                    let mut core = core.lock().unwrap();
                    core.steering
                        .pop_front()
                        .map(|item| ("steering", item))
                        .or_else(|| core.follow_up.pop_front().map(|item| ("follow_up", item)))
                };
                if let Some(popped) = popped {
                    break popped;
                }
                assert!(
                    std::time::Instant::now() < park_deadline,
                    "the fire for {} never parked",
                    job.id
                );
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            };
            let content = item.message.clone();
            if is_heartbeat_cron_job(job) {
                assert_eq!(
                    content,
                    format!("[heartbeat: every 10s run#0]\n\n{}", job.prompt)
                );
                assert_eq!(
                    item.preview.as_deref(),
                    Some(
                        format!(
                            "{}: {content}",
                            pa_core::session_engine::messages::HEARTBEAT_PROMPT_PREVIEW_LABEL
                        )
                        .as_str()
                    ),
                    "the parked row must carry the labeled preview"
                );
                assert_eq!(
                    item.queue_key.as_deref(),
                    Some(format!("heartbeat:{}", job.id).as_str())
                );
                assert_eq!(
                    item.custom_message
                        .as_ref()
                        .and_then(|row| row.get("customType"))
                        .and_then(Value::as_str),
                    Some(pa_core::session_engine::messages::HEARTBEAT_PROMPT_CUSTOM_TYPE)
                );
                assert_eq!(
                    lane,
                    if job.delivery_mode == Some(DeliveryMode::Steer) {
                        "steering"
                    } else {
                        "follow_up"
                    }
                );
            } else {
                assert_eq!(content, "nightly sweep");
                assert_eq!(item.preview, None);
                assert_eq!(item.custom_message, None);
                assert_eq!(item.queue_key, None);
                assert_eq!(lane, "follow_up");
            }
            drop(item);
            let outcome = run.await.unwrap().expect("run_job");
            assert_eq!(outcome, None);
        }
    }

    /// The failure propagation behind the backoff (dogfood incident: a
    /// failing heartbeat re-fired ~120x at its full cadence): a turn that
    /// settles with an error surfaces it to the scheduler — still a run,
    /// with the error riding it — instead of the old unconditional
    /// success verdict.
    #[tokio::test]
    async fn a_failed_settle_reports_the_failure() {
        let dir = std::env::temp_dir().join(format!("pa-sched-fail-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let session = write_active_session(&dir);
        let core = Arc::new(std::sync::Mutex::new(
            crate::worker::SessionCore::test_core(None, "/w".to_string()),
        ));
        let hooks = Arc::new(QueueHooks {
            core: Arc::clone(&core),
            work_notify: Arc::new(Notify::new()),
            user_bash: Arc::new(crate::user_bash::UserBash::new()),
            store: Arc::new(AgentCronJobStore::for_session_artifacts()),
            recovery: Arc::new(std::sync::Mutex::new(None)),
        });
        let job = heartbeat_job("hb-1", "steer the mission", DeliveryMode::Steer, &session);
        let hooks_for_run = Arc::clone(&hooks);
        let spawned_job = job.clone();
        let run = tokio::spawn(async move {
            pa_core::cron::scheduler::AgentCronSchedulerHooks::run_job(
                &*hooks_for_run,
                &spawned_job,
            )
            .await
        });
        // The spawned fire parks its item before its settle wait; pop it
        // and settle it as the runner would a provider-failed turn.
        let park_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let settled_error = "404 No endpoints found that support tool use.".to_string();
        loop {
            let popped = {
                let mut core = core.lock().unwrap();
                core.steering
                    .pop_front()
                    .or_else(|| core.follow_up.pop_front())
            };
            if let Some(item) = popped {
                let done = item.done.expect("a fire settles through done");
                let _ = done.send(Err(settled_error.clone()));
                break;
            }
            assert!(std::time::Instant::now() < park_deadline, "never parked");
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let error = run
            .await
            .expect("run task")
            .expect_err("the failed settle surfaces");
        assert_eq!(error.to_string(), settled_error);
    }

    #[tokio::test]
    async fn rlm_heartbeat_mutation_hook_fires_into_the_session_queue() {
        let dir = std::env::temp_dir().join(format!("pa-hb-fire-{}", uuid::Uuid::new_v4()));
        let sessions_dir = dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let worker = Arc::new(Worker::new(persisted_worker_config(&dir), None));
        let created = worker
            .dispatch(
                "create",
                &json!({
                    "cwd": dir.to_string_lossy(),
                    "sessionDir": sessions_dir.to_string_lossy(),
                }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");

        // The kernel host handler's store mutation (the same live binding
        // the engine's kernel cron wiring binds): `rlm_heartbeat.create`
        // through the shared session-artifacts store.
        let job = {
            let core = worker
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let (binding, _) = live_binding(&core).expect("the created session is persisted");
            worker
                .scheduled
                .store()
                .create_rlm_heartbeat(&CreateAgentCronJobInput {
                    active_session_id: binding.active_session_id,
                    session_id: binding.session_id,
                    session_file: binding.session_file,
                    cwd: binding.cwd,
                    source: Some("rlm_heartbeat".to_string()),
                    prompt: "print hello world".to_string(),
                    schedule_text: "every 10s".to_string(),
                    delivery_mode: Some(DeliveryMode::Steer),
                    ..Default::default()
                })
                .expect("rlm heartbeat create")
        };
        assert_eq!(job.status, JobStatus::Active);

        // The mutation hook the worker installs on the engine's kernel
        // cron wiring (the handler invokes it right after the store
        // mutation): withdraws dropped queued fires, then re-arms the
        // scheduler (TS `removeQueuedHeartbeatFollowUp` +
        // `cronScheduler.wake()`).
        let hook = worker.scheduled.mutation_hook();
        hook(
            pa_core::session_engine::host_requests::RlmHeartbeatMutation {
                job: job.clone(),
                drop_queued: false,
            },
        )
        .await;

        // The re-armed timer fires within the interval: the job's prompt
        // lands on the session's steer lane, the turn runs, and the store
        // records the run (`runCount` + `lastRunAt`).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
        loop {
            let recorded = worker
                .scheduled
                .store()
                .list()
                .into_iter()
                .find(|listed| listed.id == job.id);
            let Some(recorded) = recorded else {
                panic!("the created heartbeat vanished from the store");
            };
            if recorded.run_count >= 1 {
                assert!(recorded.last_run_at.is_some());
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the heartbeat never fired: {recorded:?}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        // The fired prompt ran as the session's turn and persisted as the
        // injected `heartbeat_prompt` custom row (TS `promptHeartbeat`):
        // the ♥ Heartbeat transcript component's wire shape, never a
        // plain user message.
        let fired_row = {
            let core = worker
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(store) = core.store.as_ref() else {
                panic!("the session store vanished");
            };
            store
                .entries()
                .iter()
                .find(|entry| {
                    entry.fields.get("customType").and_then(Value::as_str)
                        == Some(pa_core::session_engine::messages::HEARTBEAT_PROMPT_CUSTOM_TYPE)
                })
                .map(|entry| entry.fields.clone())
        };
        let fired_row = fired_row.expect("the heartbeat fire never persisted its prompt row");
        let content = fired_row.get("content").and_then(Value::as_str).unwrap();
        // The claimed job snapshot carries the pre-increment run count.
        assert_eq!(content, "[heartbeat: every 10s run#0]\n\nprint hello world");
        let details = fired_row.get("details").cloned().unwrap_or(Value::Null);
        assert_eq!(details["jobId"], job.id);
        assert_eq!(details["schedule"], "every 10s");
        assert_eq!(details["status"], "active");
        assert_eq!(details["runCount"], 0);
    }
}
