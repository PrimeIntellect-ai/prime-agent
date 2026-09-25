//! The daemon worker's autonomous continuation loop — the in-run drive
//! (the #254 ambiguity, resolved against the TS binary).
//!
//! TS ruling (probed against the installed TS daemon over the shared
//! faux-provider harness): the autonomous continuation rides the agent
//! loop's natural-turn-end hook (`getContinuationMessages` -> the
//! autonomous arm of `_getContinuationMessages`), so the continuation
//! churns INSIDE the one prompt wait — `turn_end -> turn_start` with the
//! continuation user row's message pair between them, no run boundary
//! between continuation turns, one `agent_end` per prompt wait. What ends
//! the loop: the driver's stop decisions (a passing gate, an exhausted
//! limit), `/autonomous off`, or an error/abort turn — the stop never
//! writes a row or a stream frame (the headless status request and the
//! print exit contract carry it).
//!
//! The Rust mapping: the in-run hook (installed at session build) is the
//! natural mint. The gates mirror TS `_getContinuationMessages` and
//! `_shouldStopForThresholdCompaction`: queued session input defers, an
//! active goal owns the boundary (the goal arm's exclusive priority), a
//! pending requested compaction consumes the stop, unsettled RLM
//! descendant work holds the continuation (the settle hook delivers the
//! owed turn), and a threshold compaction due mints the continuation
//! ahead of the loop stop and holds it — the turn loop's settled boundary
//! runs the compaction and hands the held turn to the worker's queue
//! lanes (TS `_queueAutonomousContinuationForThresholdCompaction`'s queued
//! `followUp` admission).

use std::sync::Arc;

use pa_core::session_engine::provider_adapter::json_round_trip;

use crate::agent_engine::AgentSessionEngine;

/// The queue key of a held autonomous continuation item (the worker's
/// follow-up lane): the `/autonomous off` purge withdraws exactly these.
pub(crate) const AUTONOMOUS_QUEUE_KEY: &str = "autonomous:continuation";

/// The in-run consult's deadlock-free view of the built session. The
/// consult runs inside the agent loop's turn end — possibly a compaction
/// turn, and a compaction run holds the engine's session mutex across its
/// whole model turn — so the consult must never take that mutex. The
/// mirrored shared slot and agent answer the same questions (TS
/// `_getContinuationMessages` reads plain fields: `_scheduledCompaction`,
/// the goal flags, the driver) without owning the session.
#[derive(Clone)]
pub(crate) struct AutonomousBoundaryMirror {
    pub(crate) turn_boundary:
        std::sync::Arc<pa_core::session_engine::turn_boundary::TurnBoundaryRequests>,
    pub(crate) agent: std::sync::Arc<pa_agent::agent::Agent>,
    pub(crate) compaction: pa_core::session_engine::compaction::CompactionSettings,
}

impl AgentSessionEngine {
    /// The built session's consult mirror (adopted at every build; cleared
    /// with the runtime's retirement).
    fn autonomous_boundary_mirror(&self) -> Option<AutonomousBoundaryMirror> {
        self.autonomous_boundary
            .lock()
            .expect("autonomous boundary lock")
            .clone()
    }
}

impl AgentSessionEngine {
    /// Install the in-run autonomous continuation hook on the built
    /// session's agent (every build path adopts it; the replacement flow's
    /// fresh agent included). The hook runs at each natural turn end,
    /// inside the agent loop's own run. The engine holds itself weakly
    /// (registered by the worker's [`Self::register_arc`]); an engine
    /// without a registered arc (direct-construction harnesses) installs
    /// nothing.
    pub(crate) fn install_autonomous_continuation_hook_on(
        &self,
        agent: &Arc<pa_agent::agent::Agent>,
    ) {
        let weak = self
            .self_weak
            .lock()
            .expect("engine self weak lock")
            .clone();
        let Some(weak) = weak else {
            return;
        };
        agent.set_continuation_hook(Some(Arc::new(move |context, signal| {
            let weak = weak.clone();
            Box::pin(async move {
                let Some(engine) = weak.upgrade() else {
                    return Ok(Vec::new());
                };
                // TS `_getGoalContinuationMessages`/`_getContinuationMessages`:
                // an aborted run mints no continuation — a kill that lands
                // mid-turn never rolls one more zombie turn.
                if signal.is_aborted() || engine.session_is_closed() {
                    return Ok(Vec::new());
                }
                Ok(engine.autonomous_continuation_rows(&context.message).await)
            })
                as pa_agent::BoxFut<'static, anyhow::Result<Vec<pa_agent::types::AgentMessage>>>
        })));
    }

    /// Register the engine's own arc (the weak the in-run continuation hook
    /// upgrades): the worker calls this once after wrapping the engine.
    ///
    /// # Panics
    ///
    /// Panics when the self-weak mutex is poisoned (a holder panicked
    /// while holding the lock).
    pub fn register_arc(self: &Arc<Self>) {
        *self.self_weak.lock().expect("engine self weak lock") = Some(Arc::downgrade(self));
    }

    /// The hook's consult for one settled turn (TS `_getContinuationMessages`'s
    /// autonomous arm plus its boundary gates): `Continue` mints the
    /// continuation user row the agent loop runs as the next turn of the
    /// same run; a hold (queued input, the goal's exclusive priority, a
    /// requested compaction, unsettled descendant work, a threshold
    /// compaction due) or a stop mints nothing.
    pub(crate) async fn autonomous_continuation_rows(
        self: &Arc<Self>,
        message: &pa_agent::types::AssistantMessage,
    ) -> Vec<pa_agent::types::AgentMessage> {
        // A closed session (killed/stopped) mints no continuation (the TS
        // loop's abort race drops the hook; the closed gate is the same
        // boundary for the in-process consult).
        if self.session_is_closed() {
            return Vec::new();
        }
        // TS `_getContinuationMessages`: queued session input owns the
        // boundary before any continuation work.
        if self.session_input_queued() {
            return Vec::new();
        }
        // The goal arm takes exclusive priority over the autonomous arm:
        // an active goal's own continuation machinery owns the boundary,
        // and its deferral cases (queued input, unsettled descendant work)
        // hold the autonomous arm too (TS falls through only to arms whose
        // own gates hold it).
        if self.goal_owns_continuation_wakeup().await {
            return Vec::new();
        }
        // A pending requested compaction consumes the stop (TS
        // `_shouldStopForThresholdCompaction`'s first arm): the settled
        // boundary consumes the request.
        if self.requested_compaction_scheduled().await {
            return Vec::new();
        }
        // Unsettled RLM descendant work holds the continuation (TS
        // `_holdAutonomousContinuationForRlmWork`): the children
        // registry's settle hook delivers the owed turn.
        if self.has_unsettled_rlm_work().await {
            self.autonomous_awaits_rlm_work
                .store(true, std::sync::atomic::Ordering::SeqCst);
            return Vec::new();
        }
        // The threshold arm: the crossing turn mints the continuation
        // BEFORE the loop stops (the budget bump rides the mint, TS
        // `nextAutonomousContinuation`); the settled boundary compacts and
        // the turn loop hands the held text to the worker's queue lanes.
        if self.autonomous_threshold_due().await {
            if let Some(text) = self.autonomous_follow_up_text(message).await {
                *self
                    .held_autonomous_continuation
                    .lock()
                    .expect("held autonomous continuation lock") = Some(text);
            }
            return Vec::new();
        }
        // The natural mint: the continuation user row runs as the next
        // turn of the same run (TS pendingMessages).
        match self.autonomous_follow_up_text(message).await {
            Some(text) => vec![pa_core::autonomous::autonomous_continuation_loop_row(
                &text,
                pa_core::autonomous::now_millis(),
            )],
            None => Vec::new(),
        }
    }

    /// The driver's decision for one settled turn (gate evaluation runs on
    /// the engine runtime): `Continue` returns the continuation text, a
    /// stop or an inactive mode returns `None`.
    async fn autonomous_follow_up_text(
        self: &Arc<Self>,
        message: &pa_agent::types::AssistantMessage,
    ) -> Option<String> {
        let message = json_round_trip::<_, pa_types::ai::AssistantMessage>(message)?;
        let driver = std::sync::Arc::clone(
            &*self
                .autonomous_driver
                .read()
                .expect("autonomous driver lock"),
        );
        let follow_up = {
            let mut state = self.autonomous.lock().await;
            driver.after_turn(&mut state, &message).await
        };
        match follow_up {
            pa_core::autonomous::AutonomousFollowUp::Continue { text } => Some(text),
            pa_core::autonomous::AutonomousFollowUp::Inactive
            | pa_core::autonomous::AutonomousFollowUp::Stop { .. } => None,
        }
    }

    /// Whether an active thread goal owns the continuation wakeup (TS
    /// `_goalOwnsContinuationWakeup`): the goal arm's exclusive priority.
    async fn goal_owns_continuation_wakeup(&self) -> bool {
        let Some(handles) = self.goal_runtime.lock().expect("goal runtime lock").clone() else {
            return false;
        };
        let driver = handles.driver.lock().await;
        driver.owns_continuation_wakeup()
    }

    /// Whether a pending model-requested compaction consumes the stop (the
    /// core session's turn-boundary request slot).
    async fn requested_compaction_scheduled(&self) -> bool {
        let Some(mirror) = self.autonomous_boundary_mirror() else {
            return false;
        };
        mirror.turn_boundary.compaction_scheduled().await
    }

    /// Whether a threshold compaction is due at this turn boundary (the
    /// core session's context estimate over the resolved model's window).
    async fn autonomous_threshold_due(&self) -> bool {
        // The same live model the threshold arm compacts on (the provider
        // target): the consult and the arm must agree, or a continuation
        // queues for a threshold crossing the arm never sees (R8).
        let Ok(model) = self.session_model() else {
            return false;
        };
        let Some(mirror) = self.autonomous_boundary_mirror() else {
            return false;
        };
        // The same check as the core session's `auto_compaction_due`, over
        // the mirrored agent state and settings: never through the session
        // mutex (see [`AutonomousBoundaryMirror`]).
        let state = mirror.agent.state().await;
        let messages: Vec<pa_types::session::AgentMessage> = state
            .messages
            .iter()
            .filter_map(json_round_trip::<_, pa_types::session::AgentMessage>)
            .collect();
        pa_core::session_engine::compaction::threshold_compaction_due(
            &messages,
            model.context_window,
            pa_core::session_engine::compaction::request_output_budget(
                &model,
                pa_core::session_engine::provider_adapter::model_thinking_level(
                    state.thinking_level,
                ),
            ),
            &mirror.compaction,
        )
    }

    /// The RLM settle site (TS `_maybeResumeAutonomousContinuationAfterRlmWork`):
    /// deliver the continuation the in-run hook held behind descendant
    /// work once the descendants settle — the driver decides again (its
    /// budget bump rides the delivery), and a `Continue` hands the text to
    /// the worker's queue lanes (the TS owed delivery admits as session
    /// input). Queued input, an active goal's wakeup, or a stop keeps the
    /// deferral or drops it, exactly the TS gates.
    pub fn retry_owed_autonomous_continuation(self: &Arc<Self>) {
        let engine = Arc::clone(self);
        self.runtime
            .spawn(async move { engine.autonomous_children_settled().await });
    }

    async fn autonomous_children_settled(self: &Arc<Self>) {
        // A closed session (killed/stopped) drops the retry: no
        // continuation for a session that is no longer live (TS
        // `_disposed || _disposing` in the autonomous resume site).
        if self.session_is_closed() {
            return;
        }
        if !self
            .autonomous_awaits_rlm_work
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        // TS keeps the deferral while descendant work stays unsettled or
        // queued input owns the boundary; an inactive mode or an active
        // goal drops it without delivery.
        if self.has_unsettled_rlm_work().await || self.session_input_queued() {
            self.autonomous_awaits_rlm_work
                .store(true, std::sync::atomic::Ordering::SeqCst);
            return;
        }
        if self.goal_owns_continuation_wakeup().await {
            return;
        }
        let Some(message) = self.latest_settled_assistant().await else {
            return;
        };
        if let Some(text) = self.autonomous_follow_up_text(&message).await {
            let admission = self
                .autonomous_admission
                .lock()
                .expect("autonomous admission lock")
                .clone();
            if let Some(admit) = admission {
                admit(text);
            }
        }
    }

    /// The latest settled assistant message of the built session, if any.
    async fn latest_settled_assistant(&self) -> Option<pa_agent::types::AssistantMessage> {
        let guard = self.session.lock().await;
        let engine = guard.as_deref()?;
        let state = engine.session.agent().state().await;
        state
            .messages
            .iter()
            .rev()
            .find_map(|message| match message {
                pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::Assistant(
                    assistant,
                )) => Some(assistant.clone()),
                _ => None,
            })
    }

    /// Wire the worker's autonomous admission sink: the turn loop hands the
    /// held threshold continuation to it at the settled boundary.
    ///
    /// # Panics
    ///
    /// Panics when the admission mutex is poisoned (a holder panicked
    /// while holding the lock).
    pub fn set_autonomous_admission(&self, sink: crate::agent_engine::AutonomousAdmission) {
        *self
            .autonomous_admission
            .lock()
            .expect("autonomous admission lock") = Some(sink);
    }

    /// Wire the worker's queue purge for held autonomous continuations (the
    /// `/autonomous off` withdrawal).
    ///
    /// # Panics
    ///
    /// Panics when the queue-purge mutex is poisoned (a holder panicked
    /// while holding the lock).
    pub fn set_autonomous_queue_purge(&self, purge: std::sync::Arc<dyn Fn() + Send + Sync>) {
        *self
            .autonomous_queue_purge
            .lock()
            .expect("autonomous queue purge lock") = Some(purge);
    }

    /// `/autonomous off` (and a failed on-flip): clear the held threshold
    /// continuation and the RLM-work deferral, and withdraw the queued
    /// continuation item from the worker's lanes (TS
    /// `_handleAutonomousSlashCommand`'s off branch drops the queued and
    /// owed continuations; the on branch resets the run state the same
    /// way).
    ///
    /// # Panics
    ///
    /// Panics when an internal mutex is poisoned (the held-continuation
    /// or the queue-purge lock, after a holder panicked while holding
    /// it).
    pub fn clear_autonomous_continuations(&self) {
        *self
            .held_autonomous_continuation
            .lock()
            .expect("held autonomous continuation lock") = None;
        self.autonomous_awaits_rlm_work
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let purge = self
            .autonomous_queue_purge
            .lock()
            .expect("autonomous queue purge lock")
            .clone();
        if let Some(purge) = purge {
            purge();
        }
    }
}
