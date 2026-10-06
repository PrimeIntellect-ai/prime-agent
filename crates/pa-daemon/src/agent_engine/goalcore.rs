//! The goal/max-depth runtime core: the durable `rlm_max_depth_state`
//! writes, the goal-runtime mirror adopted onto each built session, and
//! the `goal_update` emission family.
use super::{json, AgentSessionEngine, CoreSessionEngine, EngineEvent, GoalRuntimeHandles, Value};

impl AgentSessionEngine {
    /// Write the durable `rlm_max_depth_state` entry: straight into the
    /// built session's persistence handle, or parked for the build.
    pub(super) fn persist_max_depth_state(&self, max_depth: u64) {
        let handles = self.goal_runtime.lock().expect("goal runtime lock").clone();
        match handles {
            Some(handles) => {
                let mut manager = self
                    .runtime
                    .block_on(async { handles.session.lock().await });
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

    /// Arm the no-progress backoff's one-shot wake: a durable cron job at
    /// `wake_at_ms` whose prompt is the wake marker. Without it the advertised
    /// 10s/20s/40s retry would never run. Best effort: `None` outside a
    /// daemon worker.
    pub(crate) async fn schedule_goal_backoff_wake(&self, wake_at_ms: u64) -> Option<String> {
        // Exactly one wake per window: the prior job retires before the
        // replacement arms — repeated boundaries must never stack marker
        // turns.
        self.cancel_goal_backoff_wake();
        let wiring = self.cron_wiring()?;
        let binding = self.kernel_cron_binding()?;
        let schedule_text = format!(
            "at {}",
            pa_core::session::manager::format_iso(wake_at_ms as i64)
        );
        let job = wiring
            .store
            .create(&pa_core::cron::store::CreateAgentCronJobInput {
                active_session_id: binding.active_session_id.clone(),
                session_id: binding.session_id.clone(),
                session_file: binding.session_file.clone(),
                cwd: binding.cwd.clone(),
                source: Some("goal_backoff_wake".to_string()),
                label: Some(
                    pa_core::session_engine::goal_driver::GOAL_BACKOFF_WAKE_CRON_LABEL.to_string(),
                ),
                prompt: pa_core::session_engine::goal_driver::GOAL_BACKOFF_WAKE_MARKER_TEXT
                    .to_string(),
                schedule_text,
                now: Some(crate::util::now_ms()),
                ..Default::default()
            })
            .ok()?;
        // Re-arm the scheduler so the armed job gets a live timer
        // (`drop_queued: false` keeps the queued-fire withdrawal a no-op).
        if let Some(hook) = &wiring.mutation_hook {
            let mutation = pa_core::session_engine::host_requests::RlmHeartbeatMutation {
                job: job.clone(),
                drop_queued: false,
            };
            hook(mutation).await;
        }
        *self
            .goal_backoff_wake_job_id
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(job.id.clone());
        Some(job.id)
    }

    /// Cancel the pending backoff wake: the successful mint and the goal's
    /// terminal transitions retire the stale wake. A fired job stays
    /// untouched.
    pub(crate) fn cancel_goal_backoff_wake(&self) {
        self.goal_backoff_wake_job_id
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let Some(wiring) = self.cron_wiring() else {
            return;
        };
        // The cancel is DURABLE-JOB-RECOVERING: a worker rebuild loses the
        // in-memory slot, so the store itself is scanned for the session's
        // still-Active goal-backoff-wake jobs (a fired job stays untouched);
        // the scan needs the session binding, else it would match EVERY
        // session's jobs.
        let Some(binding) = self.kernel_cron_binding() else {
            return;
        };
        for job in wiring.store.list() {
            if job.status != pa_core::cron::JobStatus::Active
                || job.label.as_deref()
                    != Some(pa_core::session_engine::goal_driver::GOAL_BACKOFF_WAKE_CRON_LABEL)
                || job.session_id != binding.session_id
            {
                continue;
            }
            let _ = wiring.store.cancel(&job.id, crate::util::now_ms());
        }
    }

    /// Mirror the built session's goal handles: the core session's mutex
    /// stays held across a turn's admission, so goal checks in emit callbacks
    /// read the mirror.
    pub(super) async fn mirror_goal_runtime(&self, core: &CoreSessionEngine) {
        let pending = core.goal_driver.lock().await.pending_continuation_handle();
        *self
            .pending_goal_continuation
            .lock()
            .expect("pending goal continuation lock") = Some(pending);
        *self.goal_runtime.lock().expect("goal runtime lock") = Some(GoalRuntimeHandles {
            driver: core.goal_driver.clone(),
            session: core.session.shared_persistence(),
        });
    }

    /// The current goal state for a wire emission, when the driver is free
    /// to read (the next emitted event re-checks). The served state reads the
    /// creation-based age fresh from `created_at` (no anchor, no
    /// compounding).
    pub(super) fn current_goal_state(&self) -> Option<pa_core::goals::GoalState> {
        let handles = self
            .goal_runtime
            .lock()
            .expect("goal runtime lock")
            .clone()?;
        let driver = handles.driver.try_lock().ok()?;
        Some(driver.state_with_creation_elapsed())
    }

    /// Release the driver's pending-continuation guard: the surface
    /// admitted (or withdrew) the minted goal continuation, so the next
    /// boundary may mint again (the pending-never-re-arms contract).
    /// Lock-free: the callers cannot take the async driver lock.
    ///
    /// # Panics
    ///
    /// Panics when the pending-handle mirror's mutex is poisoned.
    pub(crate) fn clear_pending_goal_continuation(&self) {
        let handle = self
            .pending_goal_continuation
            .lock()
            .expect("pending goal continuation lock")
            .clone();
        if let Some(pending) = handle {
            pending.store(false, std::sync::atomic::Ordering::SeqCst);
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
        self.pending_goal_continuation
            .lock()
            .expect("pending goal continuation lock")
            .clone()
    }

    /// Emit the `goal_update` event when the session's goal state changed
    /// since the last emission (per-session dedupe). A session without a
    /// goal seeds the baseline silently.
    pub(crate) fn goal_update_if_changed(&self, emit: &mut dyn FnMut(EngineEvent) -> bool) -> bool {
        let Some(goal) = self.current_goal_state() else {
            // No session yet, or the driver is mid-mutation: a later event re-checks.
            return true;
        };
        {
            let mut published = self.published_goal.lock().expect("published goal lock");
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
                self.cancel_goal_backoff_wake();
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
            if !emit(event) {
                return false;
            }
            self.goal_update_if_changed(emit)
        }
    }
}
