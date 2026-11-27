//! The scheduling surface: the worker arms for the cron/heartbeat catalog,
//! the per-session artifact store, and the scheduler that fires due jobs
//! into the session queue. Deviation: TS `promptHeartbeat` steers a running
//! turn mid-stream; this port's lanes deliver at the next turn boundary.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::oneshot;

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
use crate::worker::{store_and_announce, Lane, QueuedItem, SessionCore, Worker};

/// How long a fire waits for its turn to settle before answering the scheduler with a skip (a stuck
/// turn must not pin the dispatch lane forever).
const FIRE_SETTLE_TIMEOUT_MS: u64 = 15 * 60 * 1000;

/// The session-artifact directory for one session file: `<sessions>/../session-artifacts/<id>`.
pub(crate) fn session_artifact_dir(session_file: &Path, session_id: &str) -> Option<PathBuf> {
    session_file
        .parent()?
        .parent()
        .map(|root| root.join("session-artifacts").join(session_id))
}

/// The scheduler hooks: how a claimed job reaches this session.
pub(crate) struct QueueHooks {
    core: Arc<Mutex<SessionCore>>,
    work_notify: Arc<crate::worker::WorkNotify>,
    user_bash: Arc<crate::user_bash::UserBash>,
    store: Arc<AgentCronJobStore>,
    /// The worker recovery journal (the fire checkpoint's busy evidence).
    recovery: Arc<Mutex<Option<crate::journal::WorkerRecoveryJournal>>>,
    /// The worker's inbox router, set once the engine exists (heartbeat
    /// fires route into the session's inbox; unset keeps the direct lane).
    inbox_router: std::sync::OnceLock<crate::agent_inbox::InboxRouter>,
}

impl QueueHooks {
    /// The session's activity snapshot: busy flags off the core plus the bash slot.
    fn activity(&self) -> HeartbeatSessionActivity {
        let core = self
            .core
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        HeartbeatSessionActivity {
            is_streaming: core.busy,
            is_compacting: core.compacting,
            // The abort flag the retry lane reads: the closest live signal
            // for an in-flight retry.
            is_retrying: core.retry_abort_requested,
            is_bash_running: self.user_bash.is_running(),
            has_pending_session_work: !core.pending_next_turn.is_empty(),
            unfinished_action_count: core.steering.len() + core.follow_up.len(),
        }
    }
}

impl QueueHooks {
    /// A persisted job may only fire at a session that still exists — file
    /// present, still the job's session, still `active`.
    fn persisted_target_gone(job: &AgentCronJob) -> bool {
        if job.session_file.is_empty() {
            return true;
        }
        match crate::session_store::read_session_info(Path::new(&job.session_file)) {
            None => true,
            Some(info) => info.id != job.session_id || info.state.as_deref() != Some("active"),
        }
    }

    /// The failed-runnable cancel: the store cancels the dead session's whole
    /// job set by file, so the artifact never re-fires.
    fn cancel_jobs_for_dead_target(&self, job: &AgentCronJob) -> anyhow::Result<()> {
        self.store.cancel_jobs_for_session(
            &CancelJobsFilter {
                active_session_id: None,
                session_id: None,
                session_file: Some(job.session_file.clone()),
            },
            crate::util::now_ms(),
        )?;
        Ok(())
    }
}

impl QueueHooks {
    /// Route one heartbeat fire into the session's durable inbox: the
    /// fired prompt becomes one `heartbeat` entry and the queued arrival
    /// row announces it on the delivery-mode lane. The instruction is
    /// durable at admission, so the fire counts as ran (no turn-settle
    /// handshake). Answers `None` when the direct lane row serves the
    /// fire (`agentInbox.enabled: false`).
    fn route_heartbeat_fire(&self, job: &AgentCronJob) -> Option<RoutedFire> {
        let router = self.inbox_router.get()?;
        router.admission(|core, inbox, closed| {
            if !core.created || core.shutdown_requested {
                return (Some(RoutedFire::Skipped), false);
            }
            // The LIVE job, read inside the admission's critical section
            // (`job` is the scheduler's pre-run snapshot): pause, stop,
            // delete, and rewrite write the store before their withdrawal
            // takes this lock, so a fire never lands after its withdrawal.
            let Some(live) = self.store.get_claimed_job(&job.id) else {
                return (Some(RoutedFire::Skipped), false);
            };
            let row = pa_core::session_engine::messages::create_heartbeat_prompt_message(
                &live,
                crate::util::now_ms(),
            );
            let Some(fields) =
                pa_core::session_engine::inbox::heartbeat_notice_fields(&live.id, &row)
            else {
                return (None, false);
            };
            // One waiting fire per job: the newest replaces the older (the
            // arrival row's covers drop the withdrawn one).
            inbox.withdraw_heartbeat(&live.id);
            // TS cron fires resume the suspension before admission
            // (`resumeIfIdle: true`): a fire on a post-abort/post-compact
            // session is a resume site (the runner refuses suspended lanes).
            core.queued_input_suspended = false;
            // A heartbeat rides its delivery-mode lane; the wake row keeps it.
            let lane = if matches!(live.delivery_mode, Some(DeliveryMode::FollowUp)) {
                Lane::FollowUp
            } else {
                Lane::Steering
            };
            // A fired heartbeat is a scheduled turn: `wake_delay` lets it wake at once.
            let wake_delay = crate::worker::wake_delay(&fields, None);
            store_and_announce(core, inbox, closed, fields, lane, wake_delay);
            (Some(RoutedFire::Ran), true)
        })?
    }
}

/// The verdict of a heartbeat fire the inbox route took.
enum RoutedFire {
    /// The prompt waits in the inbox.
    Ran,
    /// The session or the live job no longer takes the fire.
    Skipped,
}

impl AgentCronSchedulerHooks for QueueHooks {
    async fn run_job(&self, job: &AgentCronJob) -> anyhow::Result<Option<&'static str>> {
        // A persisted job whose target is no longer live (killed — `archived` — or deleted)
        // cancels the session's jobs and skips: a fire can never revive a stopped session.
        if Self::persisted_target_gone(job) {
            self.cancel_jobs_for_dead_target(job)?;
            return Ok(Some("skipped"));
        }
        let activity = self.activity();
        if should_defer_heartbeat_cron_job(job, &activity) {
            return Ok(Some("skipped"));
        }
        // The inbox route: a heartbeat fire lands its prompt in the
        // session's durable inbox (the `heartbeat` class) and ONE
        // coalesced wake row replaces the injected full-row turn — the
        // instruction is durable at admission, so the fire counts as ran.
        // The direct queue below serves a disabled inbox, an engine
        // without a store, and plain (non-heartbeat) cron jobs.
        if is_heartbeat_cron_job(job) {
            match self.route_heartbeat_fire(job) {
                Some(RoutedFire::Ran) => return Ok(None),
                Some(RoutedFire::Skipped) => return Ok(Some("skipped")),
                None => {}
            }
        }
        let (done_tx, done_rx) = oneshot::channel();
        let heartbeat = is_heartbeat_cron_job(job);
        let queue_key = heartbeat.then(|| format!("heartbeat:{}", job.id));
        // A heartbeat rides its delivery-mode lane; a plain cron job queues on the follow-up lane.
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
            // TS cron fires resume the suspension before admission (`resumeIfIdle: true`): a
            // fire on a post-abort/post-compact session is a resume site.
            core.queued_input_suspended = false;
            // The TS `heartbeat:<id>` queue key: a later fire replaces the queued one instead of
            // stacking.
            if let Some(key) = &queue_key {
                crate::worker::remove_keyed(&mut core, key);
            }
            let lane = if rides_steering {
                &mut core.steering
            } else {
                &mut core.follow_up
            };
            // A heartbeat fire delivers through `promptHeartbeat`: the turn IS
            // the injected `heartbeat_prompt` custom row, a plain cron job a regular prompt.
            let (message, preview, custom_message) = if heartbeat {
                let row = pa_core::session_engine::messages::create_heartbeat_prompt_message(
                    job,
                    crate::util::now_ms(),
                );
                let content = row.content.text();
                // The parked row reads `Heartbeat prompt: <content>`, while the
                // active-action label keeps the raw content.
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
        // The fire checkpoint (busy=true): a scheduled prompt runs unattended —
        // a crash mid-fire must revive the worker.
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
            // The typed settle classifies the fire (never the error text): a
            // settled or failed turn counts as a run (the failure backoff
            // stretches the next fire; deviation: TS re-fires per schedule);
            // an aborted turn is a clean run; a withdrawn fire skips, no backoff.
            Ok(Ok(settle)) => match settle {
                crate::worker::TurnSettle::Completed | crate::worker::TurnSettle::Aborted => {
                    Ok(None)
                }
                crate::worker::TurnSettle::Withdrawn(_) => Ok(Some("skipped")),
                crate::worker::TurnSettle::Failed(error) => Err(anyhow::anyhow!(error)),
            },
            // The queued item was consumed without a settle handshake (its waiter dropped):
            // the fire ran as far as the queue could deliver it.
            Ok(Err(_)) => Ok(None),
            // The settle window expired: the fire did not run.
            Err(_) => Ok(Some("skipped")),
        }
    }
}

/// The worker's schedule catalog: the shared artifact store plus the scheduler (started when the
/// first session binds).
pub(crate) struct ScheduledJobs {
    store: Arc<AgentCronJobStore>,
    hooks: Arc<QueueHooks>,
    scheduler: tokio::sync::Mutex<Option<Arc<AgentCronScheduler<QueueHooks>>>>,
}

impl ScheduledJobs {
    pub(crate) fn new(
        core: Arc<Mutex<SessionCore>>,
        work_notify: Arc<crate::worker::WorkNotify>,
        user_bash: Arc<crate::user_bash::UserBash>,
        events: Arc<crate::worker::EventPump>,
        recovery: Arc<Mutex<Option<crate::journal::WorkerRecoveryJournal>>>,
    ) -> Self {
        let mut store = AgentCronJobStore::for_session_artifacts();
        // `cronStore.onHeartbeatChange` broadcasts `{ type: "heartbeats_changed" }`
        // to the clients; the supervisor re-broadcasts daemon-wide.
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
                inbox_router: std::sync::OnceLock::new(),
            }),
            store,
            scheduler: tokio::sync::Mutex::new(None),
        }
    }

    pub(crate) fn store(&self) -> &Arc<AgentCronJobStore> {
        &self.store
    }

    /// Hand the queue hooks the worker's inbox router (set once, after
    /// the engine exists).
    pub(crate) fn set_inbox_router(&self, router: crate::agent_inbox::InboxRouter) {
        let _ = self.hooks.inbox_router.set(router);
    }

    /// Bind the live session (TS `rebindCronJobsToState`): register the session's artifact
    /// partition, move its stored jobs onto the live ids, and start (or wake) the scheduler.
    pub(crate) async fn bind_session(
        &self,
        binding: SessionBinding,
        artifact_dir: Option<PathBuf>,
    ) -> anyhow::Result<()> {
        if let Some(dir) = artifact_dir {
            std::fs::create_dir_all(&dir)?;
            self.store
                .register_session_artifact(&binding.session_id, &dir);
        }
        if !binding.session_file.is_empty() {
            self.store.rebind_session_jobs(&binding)?;
        }
        let mut guard = self.scheduler.lock().await;
        if let Some(scheduler) = guard.as_ref() {
            scheduler.wake().await;
            return Ok(());
        }
        let scheduler = Arc::new(AgentCronScheduler::new(
            Arc::clone(&self.store),
            Arc::clone(&self.hooks),
        ));
        scheduler.start().await;
        *guard = Some(scheduler);
        Ok(())
    }

    /// Re-arm the timer after a catalog mutation (TS `cronScheduler.wake`).
    pub(crate) async fn wake(&self) {
        let guard = self.scheduler.lock().await;
        if let Some(scheduler) = guard.as_ref() {
            scheduler.wake().await;
        }
    }

    /// The kernel rlm heartbeat mutation hook (after every create/update/delete):
    /// without the wake, a heartbeat created after the bind never fires.
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

    /// Drop the queued fire of a heartbeat job from the session's queue.
    pub(crate) fn remove_queued_heartbeat_follow_up(&self, job: &AgentCronJob) {
        if !is_heartbeat_cron_job(job) {
            return;
        }
        let key = format!("heartbeat:{}", job.id);
        crate::worker::remove_keyed(
            &mut self
                .hooks
                .core
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            &key,
        );
        // The fire waiting in the inbox goes too, and the wake rows that
        // announced it follow.
        if let Some(router) = self.hooks.inbox_router.get() {
            router.withdraw(|_, inbox| !inbox.withdraw_heartbeat(&job.id).is_empty());
        }
        // Same settle as the other withdrawals: the verdict and snapshot must not keep the
        // withdrawn fire's busy=true (a revive would replay the deleted heartbeat's prompt).
        crate::worker::checkpoint_queue_recovery(
            &self.hooks.recovery,
            &self.hooks.core,
            crate::worker::QueueCheckpoint::Settle {
                operation: "queue_purged",
            },
        );
    }
}

/// The bind inputs of one live session plus the session's artifact partition:
/// `None` for in-memory sessions.
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
    /// Register the live session's artifact partition on the store (idempotent) so catalog reads
    /// see this session's jobs.
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

    /// The killed close's cancel: the session's whole job set cancels by any of
    /// its three identities — durably, so the session's own heartbeats can
    /// never revive it.
    pub(crate) async fn cancel_session_scheduled_jobs(&self) -> anyhow::Result<()> {
        let (active_session_id, session_id, session_file) = {
            let core = self
                .core
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            self.bind_store_artifact(&core);
            let Some(store) = core.store.as_ref() else {
                return Ok(());
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
        )?;
        for job in &cancelled {
            self.scheduled.remove_queued_heartbeat_follow_up(job);
        }
        if !cancelled.is_empty() {
            self.scheduled.wake().await;
        }
        Ok(())
    }

    /// Only a subagent's RLM heartbeat jobs cancel here (the plain cron jobs
    /// survive the replacement); a top-level session cancels nothing.
    pub(crate) async fn cancel_session_rlm_heartbeats(&self) -> anyhow::Result<()> {
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
            return Ok(());
        }
        let cancelled = self
            .scheduled
            .store()
            .cancel_rlm_heartbeats_for_session(&active_session_id, crate::util::now_ms())?;
        for job in &cancelled {
            self.scheduled.remove_queued_heartbeat_follow_up(job);
        }
        if !cancelled.is_empty() {
            self.scheduled.wake().await;
        }
        Ok(())
    }

    /// The saved-session delete's cancel: cancel the deleted file's whole job
    /// set by file (its partition derives from the file's stem); best-effort —
    /// the deletion never fails on a store error.
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
        if let Err(error) = self.scheduled.store().cancel_jobs_for_session(
            &pa_core::cron::store::CancelJobsFilter {
                active_session_id: None,
                session_id: None,
                session_file: Some(session_file.to_string_lossy().to_string()),
            },
            crate::util::now_ms(),
        ) {
            eprintln!("failed to cancel deleted session jobs: {error}");
        }
    }
}

// The scheduling protocol arms live in scheduled_jobs::arms as the same
// inherent impl Worker block.
mod arms;

// The inline unit battery lives in scheduled_jobs::tests.
#[cfg(test)]
mod tests;
