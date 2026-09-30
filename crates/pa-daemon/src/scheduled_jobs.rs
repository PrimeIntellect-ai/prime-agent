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
//! replacement flow - `new_session` / `switch_session` / `import_jsonl` /
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
            .unwrap_or_else(std::sync::PoisonError::into_inner);
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
    fn persisted_target_gone(job: &AgentCronJob) -> bool {
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
        if Self::persisted_target_gone(job) {
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
                .unwrap_or_else(std::sync::PoisonError::into_inner);
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
            crate::worker::enqueue_priority(
                lane,
                QueuedItem {
                    priority: crate::worker::QueuePriority::Background,
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
                },
            );
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
            None,
        );
        self.work_notify.notify_one();
        match tokio::time::timeout(
            std::time::Duration::from_millis(FIRE_SETTLE_TIMEOUT_MS),
            done_rx,
        )
        .await
        {
            // The typed settle classifies the fire (never the
            // provider-controllable error text):
            // - a settled turn is a run; a failed turn still counts as
            //   a run (the store bumps runCount and records lastError,
            //   the TS recordRunResult-with-error shape) but the error
            //   propagates to the scheduler so its failure backoff
            //   stretches the next fire (documented deviation: TS
            //   re-fires per schedule regardless of failures);
            // - an aborted turn is a clean run (TS `promptHeartbeat`
            //   resolves normally when the turn aborts): no lastError,
            //   no backoff;
            // - a fire withdrawn before delivery (abort cancel, a queue
            //   edit deleting the row) skips, the TS
            //   unrunnable-at-admission verdict: no runCount bump, no
            //   backoff.
            Ok(Ok(settle)) => match settle {
                crate::worker::TurnSettle::Completed | crate::worker::TurnSettle::Aborted => {
                    Ok(None)
                }
                crate::worker::TurnSettle::Withdrawn(_) => Ok(Some("skipped")),
                crate::worker::TurnSettle::Failed(error) => Err(anyhow::anyhow!(error)),
            },
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
                .unwrap_or_else(std::sync::PoisonError::into_inner);
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
            None,
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
                .unwrap_or_else(std::sync::PoisonError::into_inner);
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
                .unwrap_or_else(std::sync::PoisonError::into_inner);
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
}

// The nine scheduling protocol arms (cron_list, heartbeats_list, heartbeat_manage,
// cron_add, cron_cancel, heartbeat_get, heartbeat_set, heartbeat_update) live in
// the child module (scheduled_jobs::arms) as the same inherent impl Worker block -
// every arm keeps its pub(crate) level, so the command dispatcher and the tests
// resolve them through the type, ZERO path churn.
mod arms;

// The inline unit battery lives in the child module (scheduled_jobs::tests);
// its use-super glob resolves through this facade's bindings.
#[cfg(test)]
mod tests;
