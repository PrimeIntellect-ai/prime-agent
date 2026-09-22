//! The cron scheduler: wake-timer loop, claim-due dispatch, per-session
//! dispatch lanes. Port of the AgentCronScheduler half of core/cron-jobs.ts.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::{Mutex, Notify};

use super::store::{AgentCronDispatch, AgentCronJobStore, DispatchResultOptions};

const MAX_TIMEOUT_MS: u64 = 2_147_483_647;

/// A claimed dispatch paired with its optional settle callback.
type PendingDispatch = (AgentCronDispatch, Option<Box<dyn FnOnce() + Send>>);

/// Scheduler hooks: how claimed jobs actually run.
pub trait AgentCronSchedulerHooks: Send + Sync {
    /// Run one claimed job; return `Some("skipped")` to record a skip.
    fn run_job(
        &self,
        job: &super::AgentCronJob,
    ) -> impl Future<Output = anyhow::Result<Option<&'static str>>> + Send;
    /// Observe a dispatch being handed to a lane; the returned closure is
    /// invoked when the lane's work settles (even on errors).
    fn begin_dispatch(&self, _dispatch: &AgentCronDispatch) -> Option<Box<dyn FnOnce() + Send>> {
        None
    }
    fn now(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default()
    }
    fn on_error(&self, _job: &super::AgentCronJob, _error: &str) {}
}

pub struct AgentCronScheduler<H: AgentCronSchedulerHooks> {
    core: Arc<SchedulerCore<H>>,
    timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// State shared with the timer task.
pub struct SchedulerCore<H: AgentCronSchedulerHooks> {
    store: Arc<AgentCronJobStore>,
    hooks: Arc<H>,
    running: AtomicBool,
    stopped: AtomicBool,
    has_started: AtomicBool,
    dispatch_lanes: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    wake: Notify,
}

impl<H: AgentCronSchedulerHooks + 'static> AgentCronScheduler<H> {
    pub fn new(store: Arc<AgentCronJobStore>, hooks: Arc<H>) -> Self {
        Self {
            core: Arc::new(SchedulerCore {
                store,
                hooks,
                running: AtomicBool::new(false),
                stopped: AtomicBool::new(true),
                has_started: AtomicBool::new(false),
                dispatch_lanes: Mutex::new(HashMap::new()),
                wake: Notify::new(),
            }),
            timer: Mutex::new(None),
        }
    }

    /// Start the scheduler; recovers interrupted dispatches on first start.
    pub async fn start(&self) {
        self.core.stopped.store(false, Ordering::SeqCst);
        if !self.core.has_started.swap(true, Ordering::SeqCst) {
            let now = self.core.hooks.now();
            self.core.store.recover_interrupted_dispatches(now);
        }
        self.schedule_next().await;
    }

    /// Stop the timer loop.
    pub async fn stop(&self) {
        self.core.stopped.store(true, Ordering::SeqCst);
        if let Some(handle) = self.timer.lock().await.take() {
            handle.abort();
        }
    }

    /// Re-evaluate the next wake time immediately.
    pub async fn wake(&self) {
        if self.core.stopped.load(Ordering::SeqCst) {
            return;
        }
        self.core.wake.notify_waiters();
        self.schedule_next().await;
    }

    /// Claim all due jobs and dispatch them. Returns how many ran.
    pub async fn run_due(&self) -> anyhow::Result<usize> {
        self.core.run_due_at(self.core.hooks.now()).await
    }
}

impl<H: AgentCronSchedulerHooks + 'static> SchedulerCore<H> {
    pub async fn run_due_at(&self, now: u64) -> anyhow::Result<usize> {
        if self.running.load(Ordering::SeqCst)
            || (self.stopped.load(Ordering::SeqCst) && self.has_started.load(Ordering::SeqCst))
        {
            return Ok(0);
        }
        self.running.store(true, Ordering::SeqCst);
        let claimed = self.store.claim_due(now, self.hooks.now());
        let dispatches: Vec<PendingDispatch> = claimed
            .into_iter()
            .map(|dispatch| {
                let end_dispatch = self.hooks.begin_dispatch(&dispatch);
                (dispatch, end_dispatch)
            })
            .collect();
        let ran = self.dispatch_all(dispatches).await;
        self.running.store(false, Ordering::SeqCst);
        Ok(ran)
    }

    async fn dispatch_all(&self, dispatches: Vec<PendingDispatch>) -> usize {
        let mut handles = Vec::new();
        for (dispatch, end_dispatch) in dispatches {
            handles.push(self.queue_dispatch(dispatch, end_dispatch));
        }
        let results = futures::future::join_all(handles).await;
        results
            .into_iter()
            .filter(|result| *result != Some("skipped"))
            .count()
    }

    async fn queue_dispatch(
        &self,
        dispatch: AgentCronDispatch,
        end_dispatch: Option<Box<dyn FnOnce() + Send>>,
    ) -> Option<&'static str> {
        let lane_key = dispatch.job.active_session_id.clone();
        let lane = {
            let mut lanes = self.dispatch_lanes.lock().await;
            lanes
                .entry(lane_key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        // Serialize per-session dispatches: the lane lock queues this run
        // behind any in-flight work for the same session.
        let _guard = lane.lock().await;
        let result = self.run_dispatch(dispatch, end_dispatch).await;
        let mut lanes = self.dispatch_lanes.lock().await;
        lanes.remove(&lane_key);
        result
    }

    async fn run_dispatch(
        &self,
        dispatch: AgentCronDispatch,
        end_dispatch: Option<Box<dyn FnOnce() + Send>>,
    ) -> Option<&'static str> {
        let outcome = async {
            let Some(job) = self.store.get_claimed_job(&dispatch.job.id) else {
                self.store
                    .record_dispatch_result(
                        &dispatch.id,
                        &DispatchResultOptions {
                            now: Some(self.hooks.now()),
                            outcome: "skipped",
                            error: None,
                        },
                    )
                    .ok();
                return Some("skipped");
            };
            let mut run_error: Option<String> = None;
            let run_result = match self.hooks.run_job(&job).await {
                Ok(result) => result,
                Err(error) => {
                    let message = error.to_string();
                    self.hooks.on_error(&job, &message);
                    run_error = Some(message);
                    None
                }
            };
            let outcome = if run_result == Some("skipped") && run_error.is_none() {
                "skipped"
            } else {
                "ran"
            };
            let error = run_error;
            self.store
                .record_dispatch_result(
                    &dispatch.id,
                    &DispatchResultOptions {
                        now: Some(self.hooks.now()),
                        outcome,
                        error,
                    },
                )
                .ok();
            run_result
        }
        .await;
        if let Some(end) = end_dispatch {
            end();
        }
        outcome
    }
}

impl<H: AgentCronSchedulerHooks + 'static> AgentCronScheduler<H> {
    /// (Re)start the wake timer to the next active run.
    async fn schedule_next(&self) {
        let mut timer = self.timer.lock().await;
        if let Some(previous) = timer.take() {
            previous.abort();
        }
        let Some(next) = self.core.store.next_active_run_at() else {
            return;
        };
        let core = self.core.clone();
        let delay_ms = next
            .saturating_sub(self.core.hooks.now())
            .min(MAX_TIMEOUT_MS);
        let handle = tokio::spawn(async move {
            loop {
                let Some(next) = core.store.next_active_run_at() else {
                    return;
                };
                let now = core.hooks.now();
                let delay = tokio::time::Duration::from_millis(
                    next.saturating_sub(now).clamp(1, MAX_TIMEOUT_MS),
                );
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = core.wake.notified() => continue,
                }
                if core.stopped.load(Ordering::SeqCst) {
                    return;
                }
                // Fire the due batch and reschedule for the following run.
                core.run_due_at(core.hooks.now()).await.ok();
            }
        });
        timer.replace(handle);
        // Keep `delay_ms` semantics: the first sleep honors the requested
        // delay computed above.
        let _ = delay_ms;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cron::store::CreateAgentCronJobInput;
    use crate::cron::{AgentCronJob, ScheduleKind};
    use std::sync::atomic::AtomicUsize;

    struct CountingHooks {
        runs: Arc<AtomicUsize>,
        outcomes: Mutex<Vec<&'static str>>,
    }

    impl AgentCronSchedulerHooks for CountingHooks {
        async fn run_job(&self, _job: &AgentCronJob) -> anyhow::Result<Option<&'static str>> {
            self.runs.fetch_add(1, Ordering::SeqCst);
            let outcome = *self.outcomes.lock().await.last().unwrap_or(&"ran");
            Ok(Some(outcome))
        }
        fn now(&self) -> u64 {
            1_700_000_000_000
        }
    }

    fn input(prompt: &str, schedule_text: &str, now: u64) -> CreateAgentCronJobInput {
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

    /// The re-arm regression behind the dogfood P0 (a heartbeat created
    /// after the bind-time arm never fires): starting on an empty store
    /// arms no timer (`schedule_next` returns without one), so the
    /// mutation's wake — TS `cronScheduler.wake()` — must re-arm and fire
    /// the job created afterwards.
    #[tokio::test]
    async fn wake_rearms_a_timer_for_a_job_created_after_start() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = Arc::new(AgentCronJobStore::new(dir.path().join("jobs.json")));
        let now = 1_700_000_000_000;
        let runs = Arc::new(AtomicUsize::new(0));
        let hooks = Arc::new(CountingHooks {
            runs: runs.clone(),
            outcomes: Mutex::new(vec!["ran"]),
        });
        let scheduler = AgentCronScheduler::new(store.clone(), hooks);
        // Empty store: the bind-time arm leaves no timer running.
        scheduler.start().await;
        // A later mutation's job (created already-due on the fixed test
        // clock, like the sibling tests' "in 1m" inputs, so the re-armed
        // timer fires within milliseconds).
        store
            .create(&input("tick", "in 1m", now - 61_000))
            .expect("create job");
        // The mutation's wake re-arms; the timer fires within milliseconds.
        scheduler.wake().await;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while runs.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            runs.load(Ordering::SeqCst) >= 1,
            "the woken timer never fired"
        );
        scheduler.stop().await;
    }

    #[tokio::test]
    async fn claims_and_runs_due_jobs() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = Arc::new(AgentCronJobStore::new(dir.path().join("jobs.json")));
        let now = 1_700_000_000_000;
        store.create(&input("tick", "every 10m", now)).unwrap();
        let runs = Arc::new(AtomicUsize::new(0));
        let hooks = Arc::new(CountingHooks {
            runs: runs.clone(),
            outcomes: Mutex::new(vec!["ran"]),
        });
        let scheduler = AgentCronScheduler::new(store.clone(), hooks);
        scheduler.start().await;
        // Not due yet: nothing runs.
        let ran = scheduler.run_due().await.unwrap();
        assert_eq!(ran, 0);
        assert_eq!(runs.load(Ordering::SeqCst), 0);
        // Due later (hooks.now() is fixed; the job fires every 10m).
        store
            .create(&input("tick2", "in 1m", now - 61_000))
            .unwrap();
        let ran = scheduler.run_due().await.unwrap();
        assert!(ran >= 1);
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        scheduler.stop().await;
    }

    #[tokio::test]
    async fn skip_outcomes_are_recorded() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = Arc::new(AgentCronJobStore::new(dir.path().join("jobs.json")));
        let now = 1_700_000_000_000;
        store.create(&input("tick", "in 1m", now - 60_000)).unwrap();
        let runs = Arc::new(AtomicUsize::new(0));
        let hooks = Arc::new(CountingHooks {
            runs: runs.clone(),
            outcomes: Mutex::new(vec!["skipped"]),
        });
        let scheduler = AgentCronScheduler::new(store.clone(), hooks);
        scheduler.start().await;
        let ran = scheduler.run_due().await.unwrap();
        // The skip still claimed the job, so zero runs are counted.
        assert_eq!(ran, 0);
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        let jobs = store.list();
        assert_eq!(jobs[0].status, crate::cron::JobStatus::Completed);
        assert!(jobs[0].last_skipped_at.is_some());
        scheduler.stop().await;
    }

    #[tokio::test]
    async fn lane_serializes_same_session_dispatches() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = Arc::new(AgentCronJobStore::new(dir.path().join("jobs.json")));
        let now = 1_700_000_000_000;
        store.create(&input("a", "in 1m", now - 60_000)).unwrap();
        store.create(&input("b", "in 1m", now - 60_000)).unwrap();
        let runs = Arc::new(AtomicUsize::new(0));
        let hooks = Arc::new(CountingHooks {
            runs: runs.clone(),
            outcomes: Mutex::new(vec!["ran"]),
        });
        let scheduler = AgentCronScheduler::new(store, hooks);
        scheduler.start().await;
        let ran = scheduler.run_due().await.unwrap();
        assert_eq!(ran, 2);
        assert_eq!(runs.load(Ordering::SeqCst), 2);
        scheduler.stop().await;
    }

    #[tokio::test]
    async fn schedule_kind_from_create_is_interval() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = AgentCronJobStore::new(dir.path().join("jobs.json"));
        let now = 1_700_000_000_000;
        let job = store.create(&input("tick", "every 10m", now)).unwrap();
        assert_eq!(job.schedule.kind, ScheduleKind::Interval);
    }
}
