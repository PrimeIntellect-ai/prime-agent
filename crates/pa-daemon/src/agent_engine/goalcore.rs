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
    /// callbacks read the mirror instead of the session.
    pub(super) fn mirror_goal_runtime(&self, core: &CoreSessionEngine) {
        *self.goal_runtime.lock().expect("goal runtime lock") = Some(GoalRuntimeHandles {
            driver: core.goal_driver.clone(),
            session: core.session.shared_persistence(),
        });
    }

    /// The current goal state for a wire emission, when the driver is free
    /// to read (an in-flight host request holds it only for its own
    /// critical section; the next emitted event re-checks).
    pub(super) fn current_goal_state(&self) -> Option<pa_core::goals::GoalState> {
        let handles = self
            .goal_runtime
            .lock()
            .expect("goal runtime lock")
            .clone()?;
        let driver = handles.driver.try_lock().ok()?;
        Some(driver.state().clone())
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
            if published.as_ref() == Some(&goal) {
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
