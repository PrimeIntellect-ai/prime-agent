//! The goal/max-depth runtime core: the durable `rlm_max_depth_state`
//! writes, the pending-continuation guard, and the `goal_update` emission
//! family.
use super::{json, AgentSessionEngine, EngineEvent, Value};

/// Which boundary outcome armed a goal wake: the no-progress backoff's
/// retry window, or the fallback that bounds how long live background work
/// can hold an owed continuation silently. One pending-wake slot
/// serves both — the consult outcomes are mutually exclusive, and a
/// successful mint retires whichever is armed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GoalWakeKind {
    /// The no-progress backoff retry window.
    Backoff,
    /// The background-work skip window (hung work must not stall the goal
    /// silently; the work's own completion notice is the normal wake).
    BackgroundSkip,
}

impl AgentSessionEngine {
    /// Write the durable `rlm_max_depth_state` entry: straight into the
    /// built session's persistence handle, or parked for the build.
    pub(super) fn persist_max_depth_state(&self, max_depth: u64) {
        match self.live_handles() {
            Some(handles) => {
                let mut manager = self
                    .runtime
                    .block_on(async { handles.goal.session.lock().await });
                if let Err(error) = manager.append_custom_entry(
                    "rlm_max_depth_state",
                    Some(json!({ "maxDepth": max_depth })),
                ) {
                    eprintln!("pa-daemon: failed to persist rlm_max_depth_state: {error:#}");
                }
            }
            None => {
                *self
                    .pending_max_depth
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(max_depth);
            }
        }
    }

    /// The global settings write behind `set_rlm_max_depth { global: true }`:
    /// `Some(message)` when the write failed, mirroring the TS `globalError`
    /// field.
    pub(super) fn write_global_rlm_max_depth(&self, max_depth: u64) -> Option<String> {
        let mut settings =
            pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
        match settings.set_rlm_max_depth(max_depth) {
            Ok(()) => None,
            Err(error) => Some(error.to_string()),
        }
    }

    /// Flush a parked `rlm_max_depth_state` entry once the session built.
    pub(super) fn flush_pending_max_depth(
        &self,
        manager: &mut pa_core::session::manager::SessionManager,
    ) {
        let pending = self
            .pending_max_depth
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(max_depth) = pending {
            if let Err(error) = manager.append_custom_entry(
                "rlm_max_depth_state",
                Some(json!({ "maxDepth": max_depth })),
            ) {
                eprintln!("pa-daemon: failed to flush pending rlm_max_depth_state: {error:#}");
            }
        }
    }

    /// Arm the background-skip fallback wake one window out, once per
    /// deferral: the deferred mint sites share the arming, and a later
    /// boundary of the same deferral (a user prompt, a steering notice, the
    /// fired wake's own marker turn) arms nothing. Work that is still
    /// running after the one marker turn holds the goal until it ends; the
    /// next deferral (after a mint, or after a goal transition retired the
    /// wake) arms again. The check and the store write run under the goal
    /// driver lock, which the mint and the goal's transitions hold: a
    /// deferral a mint already consumed, or a goal that left the active
    /// state, arms no stale wake.
    pub(crate) async fn arm_background_skip_wake(&self) {
        let Some(live) = self.live_handles() else {
            return;
        };
        let job = {
            let driver = live.goal.driver.lock().await;
            // The work probe repeats under the lock: work that settled after
            // the caller's probe already retried the continuation
            // (and may have armed its backoff wake), so it arms nothing.
            if !driver.owes_continuation()
                || !driver.owns_continuation_wakeup()
                || self.background_work_count() == 0
                || self
                    .background_skip_wake_armed
                    .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            let job = self.create_goal_wake_job(
                GoalWakeKind::BackgroundSkip,
                crate::util::now_ms()
                    + pa_core::session_engine::goal_driver::GOAL_BACKGROUND_SKIP_WINDOW_MS,
            );
            // Only a written job counts as armed: a failed write leaves the
            // next boundary of this deferral free to arm again.
            if job.is_some() {
                self.background_skip_wake_armed
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
            job
        };
        if let Some(job) = job {
            self.wake_goal_scheduler(job).await;
        }
    }

    /// Arm a goal wake: a durable one-shot cron job at `wake_at_ms` whose
    /// prompt is the kind's wake marker. The backoff kind serves the
    /// no-progress retry (without it the advertised 10s/20s/40s window would
    /// never run); the background-skip kind bounds how long live
    /// background work can hold an owed continuation silently. Best
    /// effort: `None` outside a daemon worker.
    pub(crate) async fn schedule_goal_wake(
        &self,
        kind: GoalWakeKind,
        wake_at_ms: u64,
    ) -> Option<String> {
        let job = self.create_goal_wake_job(kind, wake_at_ms)?;
        let id = job.id.clone();
        self.wake_goal_scheduler(job).await;
        Some(id)
    }

    /// The store half of arming a goal wake: retire the prior wake, then
    /// write the replacement job.
    fn create_goal_wake_job(
        &self,
        kind: GoalWakeKind,
        wake_at_ms: u64,
    ) -> Option<pa_core::cron::AgentCronJob> {
        // Exactly one wake per window: the prior job retires before the
        // replacement arms — repeated boundaries must never stack marker
        // turns.
        self.cancel_goal_wake();
        let wiring = self.cron_wiring()?;
        let binding = self.kernel_cron_binding()?;
        let schedule_text = format!(
            "at {}",
            pa_core::session::manager::format_iso(wake_at_ms as i64)
        );
        let (source, label, marker) = match kind {
            GoalWakeKind::Backoff => (
                "goal_backoff_wake",
                pa_core::session_engine::goal_driver::GOAL_BACKOFF_WAKE_CRON_LABEL,
                pa_core::session_engine::goal_driver::GOAL_BACKOFF_WAKE_MARKER_TEXT,
            ),
            GoalWakeKind::BackgroundSkip => (
                "goal_background_skip_wake",
                pa_core::session_engine::goal_driver::GOAL_BACKGROUND_SKIP_WAKE_CRON_LABEL,
                pa_core::session_engine::goal_driver::GOAL_BACKGROUND_SKIP_WAKE_MARKER_TEXT,
            ),
        };
        wiring
            .store
            .create(&pa_core::cron::store::CreateAgentCronJobInput {
                active_session_id: binding.active_session_id.clone(),
                session_id: binding.session_id.clone(),
                session_file: binding.session_file.clone(),
                cwd: binding.cwd,
                source: Some(source.to_string()),
                label: Some(label.to_string()),
                prompt: marker.to_string(),
                schedule_text,
                now: Some(crate::util::now_ms()),
                ..Default::default()
            })
            .ok()
    }

    /// Re-arm the scheduler so an armed goal wake gets a live timer
    /// (`drop_queued: false` keeps the queued-fire withdrawal a no-op).
    async fn wake_goal_scheduler(&self, job: pa_core::cron::AgentCronJob) {
        let Some(wiring) = self.cron_wiring() else {
            return;
        };
        if let Some(hook) = &wiring.mutation_hook {
            let mutation = pa_core::session_engine::host_requests::RlmHeartbeatMutation {
                job,
                drop_queued: false,
            };
            hook(mutation).await;
        }
    }

    /// Cancel the pending goal wake: the successful mint and the goal's
    /// terminal transitions retire the stale wake (either kind — the
    /// no-progress backoff or the background-skip fallback). A fired job
    /// stays untouched. Retiring the wake ends the deferral's one
    /// background-skip arming, so the next deferral arms again.
    pub(crate) fn cancel_goal_wake(&self) {
        self.background_skip_wake_armed
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let Some(wiring) = self.cron_wiring() else {
            return;
        };
        // The cron store is the only record of the wake, so the cancel
        // scans it for the session's still-Active wake jobs of both labels
        // (a rebuilt worker finds the wakes its predecessor armed); the
        // scan needs the session binding, else it would match EVERY
        // session's jobs.
        let Some(binding) = self.kernel_cron_binding() else {
            return;
        };
        for job in wiring.store.list() {
            if job.status != pa_core::cron::JobStatus::Active
                || !matches!(
                    job.label.as_deref(),
                    Some(
                        pa_core::session_engine::goal_driver::GOAL_BACKOFF_WAKE_CRON_LABEL
                            | pa_core::session_engine::goal_driver::GOAL_BACKGROUND_SKIP_WAKE_CRON_LABEL,
                    )
                )
                || job.session_id != binding.session_id
            {
                continue;
            }
            if let Err(error) = wiring.store.cancel(&job.id, crate::util::now_ms()) {
                eprintln!("failed to cancel goal wake job: {error}");
            }
        }
    }

    /// The current goal state for a wire emission, when the driver is free
    /// to read (the next emitted event re-checks). The served state reads the
    /// creation-based age fresh from `created_at` (no anchor, no
    /// compounding).
    pub(super) fn current_goal_state(&self) -> Option<pa_core::goals::GoalState> {
        let handles = self.live_handles()?;
        let driver = handles.goal.driver.try_lock().ok()?;
        Some(driver.state_with_creation_elapsed())
    }

    /// Release the driver's pending-continuation guard: the surface
    /// admitted (or withdrew) the minted goal continuation, so the next
    /// boundary may mint again (the pending-never-re-arms contract).
    /// Lock-free: the callers cannot take the async driver lock.
    pub(crate) fn clear_pending_goal_continuation(&self) {
        if let Some(handles) = self.built_handles() {
            handles
                .pending_goal_continuation
                .store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// Release the pending guard of one admitted (or dropped) goal work
    /// item: the item carries its OWN mint's handle, so a stale task from
    /// before a rebuild never clears a replacement session's guard; an item
    /// that armed no guard falls back to the mirror clear.
    pub(crate) fn release_goal_work_continuation(work: &crate::engine::GoalTurnEndWork) {
        let handle = match work {
            crate::engine::GoalTurnEndWork::Continuation(item)
            | crate::engine::GoalTurnEndWork::BudgetLimitSteer(item) => {
                item.pending_handle.as_ref()
            }
        };
        Self::release_goal_continuation_handle(handle);
    }

    /// The handle form of [`release_goal_work_continuation`] for sinks
    /// that hand the work item away before releasing (clone the item's
    /// handle first). An item that armed no guard releases NOTHING — no
    /// fallback mirror clear.
    pub(crate) fn release_goal_continuation_handle(
        handle: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
    ) {
        if let Some(pending) = handle {
            pending.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// The mirror's current handle, READ without clearing: the
    /// post-compaction mint task's spawn-time capture, which the join-failure
    /// path releases (the mirror at clear time may have been re-swapped onto
    /// a replacement session's guard).
    pub(crate) fn goal_pending_handle(
        &self,
    ) -> Option<std::sync::Arc<std::sync::atomic::AtomicBool>> {
        self.built_handles()
            .map(|handles| std::sync::Arc::clone(&handles.pending_goal_continuation))
    }

    /// Emit the `goal_update` event when the session's goal state changed
    /// since the last emission (per-session dedupe). A session without a
    /// goal seeds the baseline silently. `wait_for_driver` waits out a
    /// driver-lock holder instead of skipping the check.
    pub(crate) fn goal_update_if_changed(
        &self,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
        wait_for_driver: bool,
    ) -> bool {
        let Some(handles) = self.live_handles() else {
            return true;
        };
        let goal = if wait_for_driver {
            self.runtime
                .block_on(handles.goal.driver.lock())
                .state_with_creation_elapsed()
        } else {
            // The driver is mid-mutation: a later event re-checks.
            let Ok(driver) = handles.goal.driver.try_lock() else {
                return true;
            };
            driver.state_with_creation_elapsed()
        };
        {
            let mut published = handles.published_goal.lock().expect("published goal lock");
            // The dedupe is age-invariant (the age ticks with the wall clock).
            if published.as_ref().is_some_and(|last| {
                pa_core::goals::goal_update_dedupe_projection(last)
                    == pa_core::goals::goal_update_dedupe_projection(&goal)
            }) {
                return true;
            }
            let baseline_only =
                published.is_none() && goal.status == pa_core::goals::GoalStatus::Idle;
            let replaced = published
                .as_ref()
                .is_some_and(|last| last.goal_id != goal.goal_id);
            *published = Some(goal.clone());
            if baseline_only {
                return true;
            }
            // A goal that left the active state retires its pending wake; a
            // REPLACEMENT goal retires it too — the old goal's wake would
            // fire its marker into the new goal.
            if goal.status != pa_core::goals::GoalStatus::Active || replaced {
                self.cancel_goal_wake();
            }
        }
        emit(EngineEvent::GoalUpdate {
            goal: serde_json::to_value(&goal).unwrap_or(Value::Null),
        })
    }

    /// Wrap one prompt's emit callback so every forwarded event is followed
    /// by a goal-change check: host requests and session-command mutations
    /// surface as `goal_update` the moment they happen, so the announcement
    /// row lands between the surrounding rows.
    pub(crate) fn goal_tracking_emit<'a>(
        &'a self,
        emit: &'a mut dyn FnMut(EngineEvent) -> bool,
    ) -> impl FnMut(EngineEvent) -> bool + 'a {
        move |event: EngineEvent| {
            // The run's last event: no later event re-checks, so the check
            // waits out a driver-lock holder. Safe here: the terminal events
            // emit from the turn's synchronous frame, which holds no goal or
            // session guard; mid-turn events can emit inside async contexts.
            let terminal = matches!(event, EngineEvent::Done(_) | EngineEvent::DoneAborted);
            if !emit(event) {
                return false;
            }
            self.goal_update_if_changed(emit, terminal)
        }
    }
}
