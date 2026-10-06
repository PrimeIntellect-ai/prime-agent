//! The goal continuation loop at the natural turn end: an active goal
//! mints a continuation, deferred behind unsettled RLM descendant work
//! or a live background `bash()` handle until they settle. The goal
//! takes exclusive priority over autonomous continuation.

use std::sync::Arc;

use crate::agent_engine::AgentSessionEngine;
use crate::engine::{GoalContinuation, GoalTurnEndWork, PromptRequest};

/// The outcome of the natural-boundary goal consult.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalBoundary {
    /// The goal owns the boundary: work was minted (or defers), the run
    /// ends, and the autonomous continuation hook never runs.
    End,
    /// No active goal: the boundary proceeds to the autonomous hook.
    Proceed,
}

impl AgentSessionEngine {
    /// Wire the worker's session-input probe, goal admission sink, and
    /// queued-goal-context purge, and register the RLM settle hook; the
    /// hook holds a weak engine reference so the registry never pins it.
    ///
    /// # Panics
    ///
    /// Panics when an internal mutex is poisoned.
    pub fn set_goal_admission(
        self: &Arc<Self>,
        probe: crate::engine::SessionInputProbe,
        sink: crate::engine::GoalAdmissionSink,
        queue_purge: std::sync::Arc<dyn Fn() + Send + Sync>,
    ) {
        *self.goal_input_probe.lock().expect("goal probe lock") = Some(probe);
        *self.goal_admission_sink.lock().expect("goal sink lock") = Some(sink);
        *self.goal_queue_purge.lock().expect("goal queue purge lock") = Some(queue_purge);
        let Some(children) = self.children.clone() else {
            return;
        };
        let weak = Arc::downgrade(self);
        children.set_settle_hook(Arc::new(move || {
            if let Some(engine) = weak.upgrade() {
                // The settle site retries both owed continuations
                // (goal and autonomous share it).
                engine.retry_owed_goal_continuation();
                engine.retry_owed_autonomous_continuation();
            }
        }));
    }

    pub(crate) fn set_late_agent_message_sink(&self, sink: pa_core::LateSentAgentMessageHandler) {
        *self
            .late_agent_message_sink
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(sink);
    }

    /// Wire the registered-jobs gate (TS #2483's
    /// `canPassivateSettledSession` `hasRegisteredCronJob`): the worker calls
    /// this once with a probe over the shared cron store; the settled-child
    /// kernel release defers while the probe reports an active or paused
    /// scheduled job for the current session.
    ///
    /// # Panics
    ///
    /// Panics when the probe lock is poisoned.
    pub fn set_registered_jobs_probe(
        self: &Arc<Self>,
        probe: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    ) {
        *self
            .registered_jobs_probe
            .lock()
            .expect("registered jobs probe lock") = Some(probe);
    }

    /// An error assistant message fails an active goal (an abort keeps
    /// it); the state change surfaces through the run's tracking wrapper.
    pub(crate) fn finish_goal_for_terminal_error(&self, error: &str) {
        let Some(handles) = self.goal_runtime.lock().expect("goal runtime lock").clone() else {
            return;
        };
        self.runtime.block_on(async {
            let mut driver = handles.driver.lock().await;
            let mut session = handles.session.lock().await;
            if let Err(persist_error) = driver.finish_for_terminal_message(
                &mut session,
                pa_types::ai::StopReason::Error,
                Some(error),
            ) {
                // The best-effort terminal hook must not reject the caller.
                eprintln!("pa-daemon: goal terminal finish persist failed: {persist_error:#}");
            }
        });
    }

    /// The natural-turn-end goal consult: the goal arm runs before the
    /// autonomous arm; a budget steer ends the run first.
    pub(crate) fn goal_turn_end_boundary(&self) -> GoalBoundary {
        // The turn that crossed the budget ends the run and its wrap-up
        // steer queues (the steering lane owns the next turn).
        if self
            .goal_budget_crossed
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            if let Some(work) = self.mint_budget_limit_steer() {
                self.deliver_goal_work(work);
            }
            return GoalBoundary::End;
        }
        self.mint_goal_continuation()
    }

    /// Deliver the continuation owed behind descendant work once the
    /// descendants settle (the engine's runtime keeps callers non-blocking).
    pub fn retry_owed_goal_continuation(self: &Arc<Self>) {
        let engine = Arc::clone(self);
        self.runtime
            .spawn(async move { engine.goal_children_settled().await });
    }

    /// The settle-site body: exactly-once delivery under the driver lock,
    /// deferral kept while descendants or queued input own the boundary.
    async fn goal_children_settled(&self) {
        // A closed session (killed/stopped) drops the retry.
        if self.session_is_closed() {
            return;
        }
        let Some(handles) = self.goal_runtime.lock().expect("goal runtime lock").clone() else {
            return;
        };
        {
            let driver = handles.driver.lock().await;
            if !driver.owes_continuation() {
                return;
            }
        }
        if self.has_unsettled_rlm_work().await || self.has_live_background_bash_handles() {
            return;
        }
        // Queued input or the post-abort suspension owns the boundary.
        if self.session_input_queued() {
            return;
        }
        // Read the last assistant message before the driver lock (the
        // session mutex never nests under it); the failed pair's drop
        // happens inside, only once the consult examines the corpse.
        let last_turn = self.last_loop_assistant_message_async().await;
        if last_turn
            .as_ref()
            .is_some_and(|turn: &pa_agent::types::AssistantMessage| {
                turn.stop_reason == pa_agent::types::StopReason::Error
                    || pa_core::session_engine::goal_driver::turn_produced_no_output(turn)
            })
        {
            self.drop_failed_goal_continuation_pair().await;
        }
        let mut driver = handles.driver.lock().await;
        let mut session = handles.session.lock().await;
        let message = match driver.take_owed_continuation(&mut session, last_turn.as_ref()) {
            Ok(Some(message)) => message,
            Ok(None) => {
                // An inactive goal drops the deferral; a live goal in the
                // no-progress backoff arms the one-shot wake. The refusal
                // changed the durable state — publish it outside the turn.
                let state = driver.state_with_creation_elapsed();
                let wake_at = driver.backoff_wake_at();
                drop(driver);
                self.publish_goal_state(&state);
                if let Some(wake_at) = wake_at {
                    self.schedule_goal_backoff_wake(wake_at).await;
                }
                return;
            }
            Err(error) => {
                // A failed persist drops the deferral without minting.
                eprintln!("pa-daemon: owed goal continuation mint persist failed: {error:#}");
                return;
            }
        };
        // The mint succeeded: retire the pending wake instead of firing
        // one more marker turn.
        self.cancel_goal_backoff_wake();
        // This mint's own guard handle: later releases clear exactly this
        // handle, never the mutable mirror (a core rebuild may have
        // re-swapped it meanwhile).
        let pending_handle = Some(driver.pending_continuation_handle());
        // Input or a close arriving during the mint cancels it: the owed
        // slot survives (a later resumed session retries), and the stopped
        // session's durable state stays as the close left it.
        if self.session_input_queued() || self.session_is_closed() {
            if let Err(error) = driver.rollback_continuation_mint(&mut session) {
                // Warn, do not reject: a re-owed mint would double-charge.
                eprintln!("pa-daemon: goal mint rollback persist failed: {error:#}");
            } else {
                driver.mark_continuation_owed();
            }
            return;
        }
        let goal_update = self.publish_goal_state(&driver.state_with_creation_elapsed());
        drop(driver);
        // A close that lands while the awaits above ran: the mint is
        // consumed (the owed flag was already taken) and the unconsumed
        // mint releases the pending guard with it.
        if self.session_is_closed() {
            // Release the mint's own pending guard.
            AgentSessionEngine::release_goal_continuation_handle(pending_handle.as_ref());
            return;
        }
        self.deliver_goal_work(GoalTurnEndWork::Continuation(GoalContinuation {
            request: goal_prompt_request(&message),
            goal_update,
            pending_handle,
        }));
    }

    /// Whether unsettled RLM child work holds the boundary: any admitted
    /// child run without a terminal state.
    pub(crate) async fn has_unsettled_rlm_work(&self) -> bool {
        let Some(children) = self.children.clone() else {
            return false;
        };
        children.any_running().await
    }

    /// Whether a live background `bash()` handle holds the boundary: its
    /// completion notice is the wake-up a held continuation waits for. The
    /// probe reads the kernel manager without the session mutex (the
    /// consult can run inside a compaction turn, which holds it).
    pub(crate) fn has_live_background_bash_handles(&self) -> bool {
        self.background_bash_probe
            .lock()
            .expect("background bash probe lock")
            .clone()
            .is_some_and(|probe| probe())
    }

    /// The settled passivation gates (the kernel release and the whole-worker idle
    /// passivation share them): no unsettled RLM work, no live background `bash()`
    /// handle (a snapshot cannot resurrect a live process), no active-or-paused
    /// scheduled job (crons AND armed heartbeats). Deliberate divergence: no
    /// relaunch-on-fire, so the port BLOCKS while any job is armed. An unwired jobs
    /// probe passes.
    pub(crate) async fn settled_passivation_gates_pass(&self) -> bool {
        if self.has_unsettled_rlm_work().await || self.has_live_background_bash_handles() {
            return false;
        }
        let probe = self
            .registered_jobs_probe
            .lock()
            .expect("registered jobs probe lock")
            .clone();
        !probe.is_some_and(|probe| probe())
    }

    /// The worker's session-input probe: `true` while queued user work or
    /// the queued-input suspension owns the next turn boundary. An
    /// unwired probe answers `false`.
    pub(crate) fn session_input_queued(&self) -> bool {
        self.goal_input_probe
            .lock()
            .expect("goal probe lock")
            .clone()
            .is_some_and(|probe| probe())
    }

    /// The natural-turn-end continuation mint: an active goal mints one
    /// continuation turn, deferred (owed, not consumed) behind unsettled
    /// descendant work or a background bash handle.
    fn mint_goal_continuation(&self) -> GoalBoundary {
        // A closed session never continues: no mint, no owed-continuation
        // consumption.
        if self.session_is_closed() {
            return GoalBoundary::Proceed;
        }
        let Some(handles) = self.goal_runtime.lock().expect("goal runtime lock").clone() else {
            return GoalBoundary::Proceed;
        };
        // Read the just-settled turn BEFORE the driver lock (the session
        // mutex never nests under it). The failed pair's drop happens
        // inside, once the consult examines the corpse — an early drop
        // would hide the no-progress turn from the later consults.
        let last_turn = self.last_loop_assistant_message();
        self.runtime.block_on(async {
            let mut driver = handles.driver.lock().await;
            if !driver.owns_continuation_wakeup() {
                let mut session = handles.session.lock().await;
                if driver.owes_continuation() {
                    let _ = driver.take_owed_continuation(&mut session, None);
                }
                return GoalBoundary::Proceed;
            }
            // Queued session input owns the boundary; the queued work's own
            // settle re-consults.
            if self.session_input_queued() {
                return GoalBoundary::End;
            }
            // The quiescence gate: the continuation waits (not consumed)
            // until the descendants settle or the bash handles finish.
            if self.has_unsettled_rlm_work().await || self.has_live_background_bash_handles() {
                driver.mark_continuation_owed();
                return GoalBoundary::End;
            }
            // Now the trailing failed continuation pair can leave the
            // live loop (the captured `last_turn` still carries the
            // corpse's verdict for the check below).
            if last_turn
                .as_ref()
                .is_some_and(|turn: &pa_agent::types::AssistantMessage| {
                    turn.stop_reason == pa_agent::types::StopReason::Error
                        || pa_core::session_engine::goal_driver::turn_produced_no_output(turn)
                })
            {
                drop(driver);
                self.drop_failed_goal_continuation_pair().await;
                driver = handles.driver.lock().await;
            }
            let was_owed = driver.owes_continuation();
            let mut session = handles.session.lock().await;
            let message = if was_owed {
                driver.take_owed_continuation(&mut session, last_turn.as_ref())
            } else {
                driver.next_continuation_message(&mut session, last_turn.as_ref())
            };
            let message = match message {
                Ok(message) => message,
                Err(error) => {
                    // The hook must not reject: a failed persist ends the
                    // boundary without a continuation.
                    eprintln!("pa-daemon: goal continuation mint persist failed: {error:#}");
                    return GoalBoundary::End;
                }
            };
            if message.is_none() {
                // A refused mint with the window still armed schedules the
                // one-shot retry (without a wake the refusal would stall
                // the goal); publish the refused state.
                let state = driver.state_with_creation_elapsed();
                let wake_at = driver.backoff_wake_at();
                drop(driver);
                self.publish_goal_state(&state);
                if let Some(wake_at) = wake_at {
                    self.schedule_goal_backoff_wake(wake_at).await;
                }
                return GoalBoundary::End;
            }
            // The mint succeeded: retire any stale wake instead of firing
            // one more marker turn.
            self.cancel_goal_backoff_wake();
            // This mint's own guard handle.
            let pending_handle = Some(driver.pending_continuation_handle());
            // Input that arrived while the mint ran rolls the slot back
            // so the next boundary re-mints without double-counting.
            if self.session_input_queued() {
                if let Err(error) = driver.rollback_continuation_mint(&mut session) {
                    // Warn, do not reject: re-owing would re-mint and
                    // double-charge the eventual turn, so the cancelled
                    // boundary absorbs the spent slot.
                    eprintln!("pa-daemon: goal mint rollback persist failed: {error:#}");
                } else if was_owed {
                    driver.mark_continuation_owed();
                }
                return GoalBoundary::End;
            }
            let goal_update = self.publish_goal_state(&driver.state_with_creation_elapsed());
            let message = message.expect("the mint produced a message");
            drop(driver);
            self.deliver_goal_work(GoalTurnEndWork::Continuation(GoalContinuation {
                request: goal_prompt_request(&message),
                goal_update,
                pending_handle,
            }));
            GoalBoundary::End
        })
    }

    /// The budget-limit wrap-up steer (the context message queued as a
    /// steer); carries no `goal_update` — the budget transition already
    /// surfaced through the crossing turn's tracking wrapper.
    fn mint_budget_limit_steer(&self) -> Option<GoalTurnEndWork> {
        if self.session_is_closed() {
            return None;
        }
        let handles = self
            .goal_runtime
            .lock()
            .expect("goal runtime lock")
            .clone()?;
        let message = self.runtime.block_on(async {
            let driver = handles.driver.lock().await;
            let state = driver.state_with_creation_elapsed();
            if state.status != pa_core::goals::GoalStatus::BudgetLimited {
                return None;
            }
            pa_core::goals::create_goal_context_message(
                &state,
                pa_core::goals::GoalContextKind::BudgetLimit,
            )
            .ok()
        })?;
        Some(GoalTurnEndWork::BudgetLimitSteer(GoalContinuation {
            request: goal_prompt_request(&message),
            goal_update: None,
            // The budget steer mints no continuation slot: no pending guard.
            pending_handle: None,
        }))
    }

    /// Publish a minted state change as the `goal_update` payload; the
    /// dedupe contract keeps an unchanged state silent.
    pub(crate) fn publish_goal_state(
        &self,
        goal: &pa_core::goals::GoalState,
    ) -> Option<serde_json::Value> {
        let mut published = self.published_goal.lock().expect("published goal lock");
        // The dedupe is age-invariant: the creation-based timer's age ticks
        // with the wall clock (a second boundary between reads must not
        // re-emit an unchanged goal).
        if published.as_ref().is_some_and(|last| {
            pa_core::goals::goal_update_dedupe_projection(last)
                == pa_core::goals::goal_update_dedupe_projection(goal)
        }) {
            return None;
        }
        *published = Some(goal.clone());
        Some(serde_json::to_value(goal).unwrap_or(serde_json::Value::Null))
    }

    /// Hand one minted follow-up to the worker's admission sink. An
    /// unwired sink (engine without a worker) drops the turn: the mint
    /// is durable, a later retry re-consults.
    fn deliver_goal_work(&self, work: GoalTurnEndWork) {
        // The final gate: a closed session admits no minted goal work
        // (keeps the queue free of zombie rows); the pending guard
        // releases with it (a wedged guard would block every later mint).
        if self.session_is_closed() {
            AgentSessionEngine::release_goal_work_continuation(&work);
            return;
        }
        let sink = self
            .goal_admission_sink
            .lock()
            .expect("goal sink lock")
            .clone();
        if let Some(sink) = sink {
            sink(work);
        } else {
            eprintln!("pa-daemon: goal follow-up dropped: no admission sink wired");
            AgentSessionEngine::release_goal_work_continuation(&work);
        }
    }
}

/// The minted goal-context row as one admitted turn request: the
/// continuation text drives the model turn, the durable row rides as
/// the injected custom message.
fn goal_prompt_request(message: &pa_types::session::CustomMessage) -> PromptRequest {
    PromptRequest {
        message: message.content.text(),
        images: Vec::new(),
        source: "user".to_string(),
        agent_message_id: None,
        custom_message: Some(crate::session_commands::custom_message_value(message)),
        batch: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::agent_engine::tests::{
        admit, faux_engine_with_settings, goal_admission_collector, FAUX_TEST_LOCK,
    };
    use crate::engine::EngineEvent;

    /// Inject the engine's background-bash liveness probe (a `true`
    /// probe = a live background `bash()` handle).
    fn set_background_bash_probe(
        engine: &Arc<AgentSessionEngine>,
        probe: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    ) {
        *engine
            .background_bash_probe
            .lock()
            .expect("background bash probe lock") = Some(probe);
    }

    #[test]
    fn live_background_bash_holds_the_goal_continuation_until_it_settles() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _dir) = faux_engine_with_settings(
            &serde_json::json!({ "responses": [{"text": "warm ok"}, {"text": "turn reply"}] }),
            u64::MAX,
        );
        let engine = Arc::new(engine);
        let goal_work = goal_admission_collector(&engine);
        let mut events: Vec<EngineEvent> = Vec::new();
        // The first prompt builds the session; the probe then stands in
        // for a kernel running a background bash handle.
        admit(&engine, "warm".to_string(), &mut events);
        set_background_bash_probe(&engine, Arc::new(|| true));
        admit(
            &engine,
            "/goal ship behind the bash handle".to_string(),
            &mut events,
        );
        {
            let work = goal_work.lock().unwrap();
            assert!(
                work.is_empty(),
                "work minted behind a live handle: {work:?}"
            );
        }
        let handles = engine
            .goal_runtime
            .lock()
            .unwrap()
            .clone()
            .expect("goal runtime");
        assert!(
            engine
                .runtime
                .block_on(async { handles.driver.lock().await.owes_continuation() }),
            "the held continuation must be owed"
        );
        engine
            .runtime
            .block_on(async { engine.goal_children_settled().await });
        {
            let work = goal_work.lock().unwrap();
            assert!(
                work.is_empty(),
                "work minted behind a live handle: {work:?}"
            );
        }
        assert!(
            engine
                .runtime
                .block_on(async { handles.driver.lock().await.owes_continuation() }),
            "a live handle must keep the deferral owed"
        );
        set_background_bash_probe(&engine, Arc::new(|| false));
        engine
            .runtime
            .block_on(async { engine.goal_children_settled().await });
        let work = goal_work.lock().unwrap();
        let [GoalTurnEndWork::Continuation(follow_up)] = work.as_slice() else {
            panic!("expected exactly the owed continuation: {work:?}");
        };
        assert!(follow_up.request.message.contains("[goal: continuation]"));
        assert!(follow_up
            .request
            .message
            .contains("ship behind the bash handle"));
        assert_eq!(
            follow_up.request.custom_message.as_ref().unwrap()["details"]["continuationsUsed"],
            serde_json::json!(1)
        );
        drop(work);
        assert!(
            !engine
                .runtime
                .block_on(async { handles.driver.lock().await.owes_continuation() }),
            "the delivered continuation consumed the owed slot"
        );
    }
}
