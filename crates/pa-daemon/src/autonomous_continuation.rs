//! The daemon worker's autonomous continuation loop - the in-run drive. The
//! TS ruling: the continuation rides the agent loop's natural-turn-end hook
//! (`_getContinuationMessages`), churning INSIDE the one prompt wait - no
//! run boundary between continuation turns, one `agent_end` per prompt wait.

use std::sync::Arc;

use pa_core::session_engine::provider_adapter::json_round_trip;

use crate::agent_engine::AgentSessionEngine;

/// The queue key of a held autonomous continuation item: `/autonomous off` withdraws exactly these.
pub(crate) const AUTONOMOUS_QUEUE_KEY: &str = "autonomous:continuation";

/// The in-run consult's deadlock-free view of the built session: the consult
/// may run inside a compaction turn that holds the engine's session mutex
/// across its whole model turn, so it must never take that mutex.
#[derive(Clone)]
pub(crate) struct AutonomousBoundaryMirror {
    pub(crate) turn_boundary:
        std::sync::Arc<pa_core::session_engine::turn_boundary::TurnBoundaryRequests>,
    pub(crate) agent: std::sync::Arc<pa_agent::agent::Agent>,
    pub(crate) compaction: pa_core::session_engine::compaction::CompactionSettings,
}

impl AgentSessionEngine {
    /// The built session's consult mirror (cleared with the runtime's retirement).
    fn autonomous_boundary_mirror(&self) -> Option<AutonomousBoundaryMirror> {
        self.autonomous_boundary
            .lock()
            .expect("autonomous boundary lock")
            .clone()
    }
}

impl AgentSessionEngine {
    /// Install the in-run autonomous continuation hook on the built session's
    /// agent. The engine holds itself weakly ([`Self::register_arc`]); an
    /// engine without a registered arc installs nothing.
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
                // An aborted run mints no continuation — a kill that lands
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
    /// Panics when the self-weak mutex is poisoned.
    pub fn register_arc(self: &Arc<Self>) {
        *self.self_weak.lock().expect("engine self weak lock") = Some(Arc::downgrade(self));
    }

    /// The hook's consult for one settled turn (TS `_getContinuationMessages`):
    /// `Continue` mints the continuation user row the agent loop runs as
    /// the next turn of the same run; a hold or a stop mints nothing.
    pub(crate) async fn autonomous_continuation_rows(
        self: &Arc<Self>,
        message: &pa_agent::types::AssistantMessage,
    ) -> Vec<pa_agent::types::AgentMessage> {
        // A closed session (killed/stopped) mints no continuation.
        if self.session_is_closed() {
            return Vec::new();
        }
        // Queued session input owns the boundary before any continuation work.
        if self.session_input_queued() {
            return Vec::new();
        }
        // The goal arm takes exclusive priority (an active goal owns the boundary).
        if self.goal_owns_continuation_wakeup().await {
            return Vec::new();
        }
        // A pending requested compaction consumes the stop.
        if self.requested_compaction_scheduled().await {
            return Vec::new();
        }
        // Unsettled RLM work or a live background bash handle holds the continuation.
        if self.has_unsettled_rlm_work().await || self.has_live_background_bash_handles() {
            self.autonomous_awaits_rlm_work
                .store(true, std::sync::atomic::Ordering::SeqCst);
            // A handle that settles between the probe above and this store
            // raced the callback out of its retry: the owed turn would wait
            // for a wake that already fired - re-arm the retry once.
            if !self.has_live_background_bash_handles() && !self.has_unsettled_rlm_work().await {
                self.retry_owed_autonomous_continuation();
            }
            return Vec::new();
        }
        // The threshold arm: the crossing turn mints the continuation BEFORE the loop
        // stops; the settled boundary compacts and hands the held text to the queue lanes.
        if self.autonomous_threshold_due().await {
            if let Some(text) = self.autonomous_follow_up_text(message).await {
                *self
                    .held_autonomous_continuation
                    .lock()
                    .expect("held autonomous continuation lock") = Some(text);
            }
            return Vec::new();
        }
        match self.autonomous_follow_up_text(message).await {
            Some(text) => vec![pa_core::autonomous::autonomous_continuation_loop_row(
                &text,
                pa_core::autonomous::now_millis(),
            )],
            None => Vec::new(),
        }
    }

    /// The driver's decision for one settled turn: `Continue` returns the
    /// continuation text; a stop or an inactive mode returns `None`.
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

    /// Whether an active thread goal owns the continuation wakeup.
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
        // the mirrored agent state and settings (never through the mutex).
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

    /// The RLM settle site: deliver the continuation the in-run hook held
    /// behind descendant work once the descendants settle.
    pub fn retry_owed_autonomous_continuation(self: &Arc<Self>) {
        let engine = Arc::clone(self);
        self.runtime
            .spawn(async move { engine.autonomous_children_settled().await });
    }

    async fn autonomous_children_settled(self: &Arc<Self>) {
        // A closed session (killed/stopped) drops the retry.
        if self.session_is_closed() {
            return;
        }
        if !self
            .autonomous_awaits_rlm_work
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        // Keep the deferral while descendant work stays unsettled, a
        // background bash handle runs, or queued input owns the boundary.
        if self.has_unsettled_rlm_work().await
            || self.session_input_queued()
            || self.has_live_background_bash_handles()
        {
            self.autonomous_awaits_rlm_work
                .store(true, std::sync::atomic::Ordering::SeqCst);
            // A settlement that raced this re-store also raced the retry
            // that would deliver the owed turn: with every blocker gone the
            // deferral has no wake left - re-arm. Only the fully-cleared
            // deferral re-arms, so the loop cannot spin.
            if !self.has_live_background_bash_handles()
                && !self.has_unsettled_rlm_work().await
                && !self.session_input_queued()
            {
                self.retry_owed_autonomous_continuation();
            }
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
    /// Panics when the admission mutex is poisoned.
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
    /// Panics when the queue-purge mutex is poisoned.
    pub fn set_autonomous_queue_purge(&self, purge: std::sync::Arc<dyn Fn() + Send + Sync>) {
        *self
            .autonomous_queue_purge
            .lock()
            .expect("autonomous queue purge lock") = Some(purge);
    }

    /// `/autonomous off`: clear the held threshold continuation and the
    /// RLM-work deferral, and withdraw the queued continuation item.
    ///
    /// # Panics
    ///
    /// Panics when an internal mutex is poisoned.
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::agent_engine::tests::{admit, faux_engine_with_settings, FAUX_TEST_LOCK};
    use crate::engine::EngineEvent;

    /// Inject the engine's background-bash liveness probe (a `true` probe
    /// = a live background `bash()` handle).
    fn set_background_bash_probe(
        engine: &Arc<AgentSessionEngine>,
        probe: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    ) {
        *engine
            .background_bash_probe
            .lock()
            .expect("background bash probe lock") = Some(probe);
    }

    /// The consult's lost-wakeup guard (Macroscope's #2826 review).
    #[test]
    fn a_handle_settling_between_the_probe_and_the_flag_store_still_wakes() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _dir) = faux_engine_with_settings(
            &serde_json::json!({ "responses": [{"text": "warm ok"}, {"text": "working"}] }),
            u64::MAX,
        );
        let engine = Arc::new(engine);
        engine.register_arc();
        // The admission itself is the observable event (the sink hands the owed turn to a channel).
        let (admit_tx, admit_rx) = std::sync::mpsc::channel::<String>();
        engine.set_autonomous_admission(std::sync::Arc::new(move |text| {
            let _ = admit_tx.send(text);
        }));
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "warm".to_string(), &mut events);
        // The probe reads live exactly once (the consult's gate); every
        // later read is settled — the settle tail of the raced window.
        let flip = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let flip_read = std::sync::Arc::clone(&flip);
        set_background_bash_probe(
            &engine,
            Arc::new(move || flip_read.swap(false, std::sync::atomic::Ordering::SeqCst)),
        );
        admit(
            &engine,
            "/autonomous on --max-continuations 1 --max-turns 5".to_string(),
            &mut events,
        );
        admit(&engine, "go".to_string(), &mut events);
        // No settlement callback ever fires here — the consult's re-arm delivers the owed turn.
        let text = admit_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the re-arm delivered the owed turn without an external retry");
        assert!(text.starts_with("[autonomous-continuation]"));
        assert!(
            admit_rx.try_recv().is_err(),
            "the owed flag owns exactly one delivery"
        );
        assert!(
            !engine
                .autonomous_awaits_rlm_work
                .load(std::sync::atomic::Ordering::SeqCst),
            "the delivered turn consumed the owed flag"
        );
    }

    #[test]
    fn live_background_bash_holds_the_autonomous_continuation_until_it_settles() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _dir) = faux_engine_with_settings(
            &serde_json::json!({ "responses": [{"text": "warm ok"}, {"text": "working"}] }),
            u64::MAX,
        );
        let engine = Arc::new(engine);
        // The in-run continuation hook upgrades the engine's registered arc.
        engine.register_arc();
        // The admission collector stands in for the worker's follow-up lane.
        let admitted: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = std::sync::Arc::clone(&admitted);
        engine.set_autonomous_admission(std::sync::Arc::new(move |text| {
            sink.lock().unwrap().push(text);
        }));
        let mut events: Vec<EngineEvent> = Vec::new();
        // The first prompt builds the session; the probe injected after stands in for a live
        // handle.
        admit(&engine, "warm".to_string(), &mut events);
        set_background_bash_probe(&engine, Arc::new(|| true));
        admit(
            &engine,
            "/autonomous on --max-continuations 1 --max-turns 5".to_string(),
            &mut events,
        );
        admit(&engine, "go".to_string(), &mut events);
        assert!(
            engine
                .autonomous_awaits_rlm_work
                .load(std::sync::atomic::Ordering::SeqCst),
            "the in-run hook must hold the continuation behind the live handle"
        );
        assert!(admitted.lock().unwrap().is_empty());
        assert_eq!(engine.autonomous.blocking_lock().continuations_used, 0);
        engine
            .runtime
            .block_on(async { engine.autonomous_children_settled().await });
        assert!(
            engine
                .autonomous_awaits_rlm_work
                .load(std::sync::atomic::Ordering::SeqCst),
            "a live handle must keep the deferral owed"
        );
        assert!(admitted.lock().unwrap().is_empty());
        assert_eq!(engine.autonomous.blocking_lock().continuations_used, 0);
        set_background_bash_probe(&engine, Arc::new(|| false));
        engine
            .runtime
            .block_on(async { engine.autonomous_children_settled().await });
        let admitted = admitted.lock().unwrap().clone();
        assert_eq!(
            admitted.len(),
            1,
            "the owed continuation, once: {admitted:?}"
        );
        assert!(admitted[0].starts_with("[autonomous-continuation]"));
        assert!(
            !engine
                .autonomous_awaits_rlm_work
                .load(std::sync::atomic::Ordering::SeqCst),
            "the delivered continuation consumed the owed flag"
        );
        let state = engine.autonomous.blocking_lock();
        assert_eq!(state.continuations_used, 1);
    }
}
