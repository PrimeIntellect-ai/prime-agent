//! The goal/max-depth runtime core: the durable `rlm_max_depth_state`
//! writes (per-session custom entry + global settings), the goal-runtime
//! mirror adopted onto each built session, and the `goal_update` emission
//! family (moved with their concern).
use super::{json, AgentSessionEngine, CoreSessionEngine, EngineEvent, GoalRuntimeHandles, Value};

impl AgentSessionEngine {
    /// Write the durable `rlm_max_depth_state` custom entry (TS
    /// `RLM_MAX_DEPTH_STATE_CUSTOM_TYPE`): straight into the built
    /// session's persistence handle, or parked for the build when the
    /// first turn has not built the session yet.
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

    /// The global settings write behind `set_rlm_max_depth { global: true }`
    /// (TS `settingsManager.setRlmMaxDepth` + flush + `drainErrors`):
    /// `Some(message)` when the write failed, mirroring the TS
    /// `globalError` field.
    pub(super) fn write_global_rlm_max_depth(&self, max_depth: u64) -> Option<String> {
        let mut settings =
            pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
        match settings.set_rlm_max_depth(max_depth) {
            Ok(()) => None,
            Err(error) => Some(error.to_string()),
        }
    }

    /// Flush a parked `rlm_max_depth_state` entry once the session built
    /// (the `pending_branch` pattern's build-site twin).
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

    /// Mirror the built session's goal handles: the core session's own
    /// mutex stays held across a turn's admission, so goal checks in emit
    /// callbacks read the mirror instead of the session. The driver's
    /// pending-continuation guard mirrors lock-free as well (the
    /// admission surfaces release it from contexts that cannot take the
    /// async driver lock).
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
    /// to read (an in-flight host request holds it only for its own
    /// critical section; the next emitted event re-checks). The served
    /// state reads the goal's creation-based age fresh from `created_at`
    /// (the operator's timer contract — no anchor, no compounding).
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
    /// boundary may mint again (the pending-never-re-arms contract —
    /// the owed flag clears at the queue/admission). Lock-free through
    /// the mirrored atomic handle: the callers run from contexts that
    /// cannot take the async driver lock (a spawned settle task, a
    /// nested `block_on`, the abort-cancel path). No session yet is a
    /// no-op.
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
    /// item: the item carries its OWN mint's handle (captured under the
    /// driver lock at the mint), so the release touches exactly that
    /// mint's guard — a stale task from before a core rebuild can never
    /// clear a replacement session's guard through the mutable mirror
    /// it may have been re-swapped onto. An item that armed no guard (the
    /// budget steer, the quota-resume marker) falls back to the mirror
    /// clear (the historical behavior).
    pub(crate) fn release_goal_work_continuation(work: &crate::engine::GoalTurnEndWork) {
        let handle = match work {
            crate::engine::GoalTurnEndWork::Continuation(item)
            | crate::engine::GoalTurnEndWork::BudgetLimitSteer(item) => {
                item.pending_handle.as_ref()
            }
        };
        Self::release_goal_continuation_handle(handle);
    }

    /// The handle form of [`release_goal_work_continuation`] for sinks that
    /// hand the work item away before releasing (the admission takes
    /// ownership): clone the item's handle first, then release through
    /// this. An item that armed no guard releases NOTHING — no fallback
    /// mirror clear (an unrelated in-flight mint's armed guard must never
    /// be dropped by an admission that holds no handle).
    pub(crate) fn release_goal_continuation_handle(
        handle: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
    ) {
        if let Some(pending) = handle {
            pending.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// The mirror's current handle, READ without clearing: the
    /// post-compaction mint task's spawn-time capture — the core the mint
    /// will use at that moment. The join-failure path releases exactly
    /// this handle, never the mirror at clear time (a core rebuild may
    /// have re-swapped the mirror onto a replacement session's guard
    /// meanwhile).
    pub(crate) fn goal_pending_handle(
        &self,
    ) -> Option<std::sync::Arc<std::sync::atomic::AtomicBool>> {
        self.pending_goal_continuation
            .lock()
            .expect("pending goal continuation lock")
            .clone()
    }

    /// Emit the `goal_update` engine event when the session's goal state
    /// changed since the last emission (per-session dedupe: the TS session
    /// listener fires on state change). Returns the emit callback's verdict.
    /// A session without a goal seeds the baseline silently instead of
    /// emitting an idle-state event TS never sends.
    pub(crate) fn goal_update_if_changed(&self, emit: &mut dyn FnMut(EngineEvent) -> bool) -> bool {
        let Some(goal) = self.current_goal_state() else {
            // No session yet, or the driver is mid-mutation: a later event
            // re-checks before the turn settles.
            return true;
        };
        {
            let mut published = self.published_goal.lock().expect("published goal lock");
            // The dedupe is age-invariant: the creation-based timer's age
            // ticks with the wall clock (a second boundary between reads
            // must not re-emit an unchanged goal).
            if published.as_ref().is_some_and(|last| {
                pa_core::goals::goal_update_dedupe_projection(last)
                    == pa_core::goals::goal_update_dedupe_projection(&goal)
            }) {
                return true;
            }
            let baseline_only =
                published.is_none() && goal.status == pa_core::goals::GoalStatus::Idle;
            *published = Some(goal.clone());
            if baseline_only {
                return true;
            }
        }
        emit(EngineEvent::GoalUpdate {
            goal: serde_json::to_value(&goal).unwrap_or(Value::Null),
        })
    }

    /// Wrap one prompt's emit callback so every forwarded event is followed
    /// by a goal-change check: kernel `goal.complete`/`goal.create` host
    /// requests and session-command mutations surface as `goal_update` at
    /// the moment they happen (TS emits from `_setGoalState`), so the
    /// announcement row lands between the surrounding rows — after the
    /// echo/tool card, before the result/reply — not after the turn.
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
