//! The daemon's core-session lifecycle: one state says whether the core
//! session is built and whether the session is closed, and carries the
//! handles copied out of the built session.

use std::sync::{Arc, Mutex};

use super::{AgentSessionEngine, CoreSessionEngine, GoalRuntimeHandles, SettledKernelRelease};
use crate::autonomous_continuation::AutonomousBoundaryMirror;

/// The handles copied out of the built core session at adoption. The core
/// session's mutex is held across a turn's admission and across compaction
/// turns, so emit callbacks, continuation gates, and the abort funnel read
/// these instead of locking it.
pub(crate) struct BuiltHandles {
    pub(crate) goal: GoalRuntimeHandles,
    /// The pending-continuation guard: contexts that cannot take the async
    /// driver lock release it through this atomic handle.
    pub(crate) pending_goal_continuation: Arc<std::sync::atomic::AtomicBool>,
    /// The eager turn-abort funnel's target.
    pub(crate) turn_agent: Arc<pa_agent::agent::Agent>,
    /// The in-run autonomous consult's view (see
    /// [`crate::autonomous_continuation`]).
    pub(crate) autonomous_boundary: AutonomousBoundaryMirror,
    /// `true` while the kernel still runs background `bash()` handles.
    pub(crate) background_bash_probe: Arc<dyn Fn() -> bool + Send + Sync>,
    /// The stop-with-snapshot kernel release over a weak provisioner
    /// reference (the park arm never takes the session mutex).
    pub(crate) kernel_release: SettledKernelRelease,
    pub(crate) progress_notes: Arc<pa_core::session_engine::rlm_host::RlmProgressNotes>,
    /// The last emitted `goal_update`; unchanged states stay silent.
    pub(crate) published_goal: Mutex<Option<pa_core::goals::GoalState>>,
}

impl BuiltHandles {
    pub(super) async fn of(built: &Arc<CoreSessionEngine>) -> Self {
        let provisioner = built.kernel_provisioner_weak();
        let release_provisioner = built.kernel_provisioner_weak();
        Self {
            goal: GoalRuntimeHandles {
                driver: built.goal_driver.clone(),
                session: built.session.shared_persistence(),
            },
            pending_goal_continuation: built.goal_driver.lock().await.pending_continuation_handle(),
            turn_agent: Arc::clone(built.session.agent()),
            autonomous_boundary: AutonomousBoundaryMirror {
                turn_boundary: Arc::clone(&built.turn_boundary),
                agent: Arc::clone(built.session.agent()),
                session: Arc::downgrade(built),
            },
            background_bash_probe: Arc::new(move || {
                provisioner
                    .upgrade()
                    .and_then(|provisioner| provisioner.manager())
                    .is_some_and(|manager| manager.has_background_work())
            }),
            kernel_release: Arc::new(move || {
                let provisioner = release_provisioner.clone();
                Box::pin(async move {
                    if let Some(provisioner) = provisioner.upgrade() {
                        provisioner
                            .stop_kernel(Some(pa_core::kernel::shared::KernelShutdownOptions {
                                snapshot: true,
                                drain_host_requests: true,
                            }))
                            .await;
                    }
                })
            }),
            progress_notes: Arc::clone(&built.rlm_progress_notes),
            published_goal: Mutex::new(None),
        }
    }

    /// Publish a minted state change as the `goal_update` payload. The dedupe
    /// is age-invariant: the creation-based age ticks with the wall clock, so
    /// a second boundary must not re-emit an unchanged goal.
    pub(crate) fn publish_goal(
        &self,
        goal: &pa_core::goals::GoalState,
    ) -> Option<serde_json::Value> {
        let mut published = self.published_goal.lock().expect("published goal lock");
        if published.as_ref().is_some_and(|last| {
            pa_core::goals::goal_update_dedupe_projection(last)
                == pa_core::goals::goal_update_dedupe_projection(goal)
        }) {
            return None;
        }
        *published = Some(goal.clone());
        Some(serde_json::to_value(goal).unwrap_or(serde_json::Value::Null))
    }
}

/// The core session's lifecycle. `AgentSessionEngine::session` still owns
/// the core session itself: its async guard is held across `block_on`
/// calls, so a retirement's `take()` waits for them. Adoption and
/// retirement, under `session_build`, are the only writers of both, so
/// `Built` or `Closed(Some(_))` holds exactly while `session` is `Some`
/// (an adoption in flight sets the state first).
pub(crate) enum CoreSessionState {
    Unbuilt,
    Built(Arc<BuiltHandles>),
    /// Kill, shutdown, or a replacement teardown closed the session: no
    /// continuation mints. The handles stay for the abort funnel and the
    /// summary until retirement drops them.
    Closed(Option<Arc<BuiltHandles>>),
}

impl CoreSessionState {
    fn built(&self) -> Option<Arc<BuiltHandles>> {
        match self {
            Self::Built(handles) | Self::Closed(Some(handles)) => Some(Arc::clone(handles)),
            Self::Unbuilt | Self::Closed(None) => None,
        }
    }
}

impl AgentSessionEngine {
    fn core_state(&self) -> std::sync::MutexGuard<'_, CoreSessionState> {
        self.core_state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The continuation gates' view: only a built, open session continues.
    pub(crate) fn live_handles(&self) -> Option<Arc<BuiltHandles>> {
        match &*self.core_state() {
            CoreSessionState::Built(handles) => Some(Arc::clone(handles)),
            CoreSessionState::Unbuilt | CoreSessionState::Closed(_) => None,
        }
    }

    pub(crate) fn built_handles(&self) -> Option<Arc<BuiltHandles>> {
        self.core_state().built()
    }

    pub fn session_is_closed(&self) -> bool {
        match *self.core_state() {
            CoreSessionState::Closed(_) => true,
            CoreSessionState::Unbuilt | CoreSessionState::Built(_) => false,
        }
    }

    /// A session closed while it built stays closed.
    pub(super) fn adopt_handles(&self, handles: Arc<BuiltHandles>) {
        let mut state = self.core_state();
        *state = match &*state {
            CoreSessionState::Closed(_) => CoreSessionState::Closed(Some(handles)),
            CoreSessionState::Unbuilt | CoreSessionState::Built(_) => {
                CoreSessionState::Built(handles)
            }
        };
    }

    /// A closed session stays closed.
    pub(super) fn retire_handles(&self) {
        let mut state = self.core_state();
        *state = match &*state {
            CoreSessionState::Closed(_) => CoreSessionState::Closed(None),
            CoreSessionState::Unbuilt | CoreSessionState::Built(_) => CoreSessionState::Unbuilt,
        };
    }

    pub fn mark_session_closed(&self) {
        let mut state = self.core_state();
        *state = match std::mem::replace(&mut *state, CoreSessionState::Unbuilt) {
            CoreSessionState::Built(handles) => CoreSessionState::Closed(Some(handles)),
            CoreSessionState::Unbuilt => CoreSessionState::Closed(None),
            closed @ CoreSessionState::Closed(_) => closed,
        };
    }

    /// A created or replacement session starts live.
    pub fn clear_session_closed(&self) {
        let mut state = self.core_state();
        *state = match std::mem::replace(&mut *state, CoreSessionState::Unbuilt) {
            CoreSessionState::Closed(Some(handles)) | CoreSessionState::Built(handles) => {
                CoreSessionState::Built(handles)
            }
            CoreSessionState::Closed(None) | CoreSessionState::Unbuilt => CoreSessionState::Unbuilt,
        };
    }

    /// Swap one probe into the built session's handles (tests stand in for a
    /// kernel's background work or release).
    #[cfg(test)]
    pub(crate) fn set_test_probes(
        &self,
        background_bash: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
        kernel_release: Option<SettledKernelRelease>,
    ) {
        let mut state = self.core_state();
        let CoreSessionState::Built(handles) = &*state else {
            panic!("probes need a built session");
        };
        let published_goal = handles.published_goal.lock().unwrap().clone();
        *state = CoreSessionState::Built(Arc::new(BuiltHandles {
            goal: handles.goal.clone(),
            pending_goal_continuation: Arc::clone(&handles.pending_goal_continuation),
            turn_agent: Arc::clone(&handles.turn_agent),
            autonomous_boundary: handles.autonomous_boundary.clone(),
            background_bash_probe: background_bash
                .unwrap_or_else(|| Arc::clone(&handles.background_bash_probe)),
            kernel_release: kernel_release.unwrap_or_else(|| Arc::clone(&handles.kernel_release)),
            progress_notes: Arc::clone(&handles.progress_notes),
            published_goal: Mutex::new(published_goal),
        }));
    }
}
