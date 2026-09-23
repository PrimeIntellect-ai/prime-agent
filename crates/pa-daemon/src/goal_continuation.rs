//! The goal continuation loop at the natural turn end: the port of the
//! TS `_getGoalContinuationMessages` hook and its sibling surfaces
//! (`agent-session.ts`).
//!
//! TS drives an active goal across turns: at the agent loop's natural turn
//! end the continuation hook mints a goal-context message, the budget
//! crossing of `_shouldStopAfterTurn` queues a wrap-up steer, and a
//! continuation deferred behind unsettled RLM descendant work
//! (`_goalContinuationAwaitsRlmWork`) is delivered once the descendants
//! settle (`_maybeResumeGoalContinuationAfterRlmWork`). The goal takes
//! exclusive priority over autonomous continuation, and queued session
//! input owns the turn boundary before any goal work.
//!
//! The Rust mapping: the engine's turn loop consults
//! [`AgentSessionEngine::goal_turn_end_boundary`] at its natural
//! boundary; minted work is admitted through the worker's queue lanes by
//! the admission sink the worker installs
//! ([`AgentSessionEngine::set_goal_admission`]), with the worker's
//! queue/suspension state visible through the session-input probe. The
//! RLM settle sites of the children registry retry the owed continuation
//! through [`AgentSessionEngine::retry_owed_goal_continuation`], the
//! worker's resume sites call the same retry.

use std::sync::Arc;

use crate::agent_engine::AgentSessionEngine;
use crate::engine::{GoalContinuation, GoalTurnEndWork, PromptRequest};

/// The outcome of the natural-boundary goal consult.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalBoundary {
    /// The goal owns the boundary: work was minted (or defers behind
    /// queued input / unsettled descendant work), the run ends, and the
    /// autonomous continuation hook never runs (TS gives goal
    /// continuation exclusive priority).
    End,
    /// No active goal: the boundary proceeds to the autonomous hook.
    Proceed,
}

impl AgentSessionEngine {
    /// Wire the worker's session-input probe, goal admission sink, and
    /// queued-goal-context purge, and register the RLM settle hook on the
    /// children registry. The worker calls this once after the engine is
    /// built; the hook holds a weak engine reference so the registry never
    /// pins the engine.
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
                // The settle site retries both owed continuations (TS
                // `_maybeResumeGoalContinuationAfterRlmWork` and
                // `_maybeResumeAutonomousContinuationAfterRlmWork` share
                // the RLM settle sites).
                engine.retry_owed_goal_continuation();
                engine.retry_owed_autonomous_continuation();
            }
        }));
    }

    /// TS `_finishGoalForTerminalAssistantMessage` for a failed run: an
    /// error assistant message fails an active goal (an abort keeps it).
    /// The state change surfaces through the run's tracking wrapper with
    /// the trailing `Done` event.
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
                // The best-effort terminal hook must not reject the caller
                // (the state change surfaces through the tracking wrapper).
                eprintln!("pa-daemon: goal terminal finish persist failed: {persist_error:#}");
            }
        });
    }

    /// The natural-turn-end goal consult (TS `_getContinuationMessages`:
    /// the goal arm runs before the autonomous arm, and a budget steer
    /// ends the run first). Minted work is admitted through the sink; the
    /// caller owns the trailing `Done`.
    pub(crate) fn goal_turn_end_boundary(&self) -> GoalBoundary {
        // TS `_shouldStopAfterTurn`'s budget arm: the turn that crossed
        // the budget ends the run and its wrap-up steer queues (the
        // steering lane owns the next turn).
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

    /// The owed-continuation retry (TS `_maybeResumeGoalContinuationAfterRlmWork`
    /// at the RLM settle and resume sites): deliver the continuation
    /// owed behind descendant work once the descendants settle. The
    /// engine's own runtime keeps the sync callers non-blocking.
    pub fn retry_owed_goal_continuation(self: &Arc<Self>) {
        let engine = Arc::clone(self);
        self.runtime
            .spawn(async move { engine.goal_children_settled().await });
    }

    /// The settle-site body: exactly-once delivery under the driver lock
    /// (`take_owed_continuation` claims the flag atomically), deferral
    /// kept while descendants stay unsettled or queued input/suspension
    /// owns the boundary.
    async fn goal_children_settled(&self) {
        // A closed session (killed/stopped) drops the retry: no mint for a
        // session that is no longer live (TS `_disposed || _disposing`).
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
        // TS keeps the deferral while descendant work is unsettled.
        if self.has_unsettled_rlm_work().await {
            return;
        }
        // The resume sites keep the deferral while queued input or the
        // post-abort suspension owns the boundary.
        if self.session_input_queued() {
            return;
        }
        let mut driver = handles.driver.lock().await;
        let mut session = handles.session.lock().await;
        let message = match driver.take_owed_continuation(&mut session) {
            Ok(Some(message)) => message,
            Ok(None) => {
                // An inactive goal drops the deferral without minting (TS:
                // "drops the deferral for inactive goals").
                return;
            }
            Err(error) => {
                // The mint's catch (TS `_getGoalContinuationMessages`):
                // a failed persist drops the deferral without minting.
                eprintln!("pa-daemon: owed goal continuation mint persist failed: {error:#}");
                return;
            }
        };
        // TS `_getContinuationMessages`: new session input arriving
        // during the mint cancels it (the arrival-epoch restore).
        if self.session_input_queued() {
            if let Err(error) = driver.rollback_continuation_mint(&mut session) {
                // The restore hook must not reject: warn and re-owe anyway.
                eprintln!("pa-daemon: goal mint rollback persist failed: {error:#}");
            }
            driver.mark_continuation_owed();
            return;
        }
        let goal_update = self.publish_goal_state(driver.state());
        drop(driver);
        // The close can land while the awaits above ran (the worker's kill
        // sets the marker before its own children close — each child's
        // settle fires this retry): a session that closed mid-mint mints
        // nothing (the driver's owed flag is already taken, so the mint is
        // consumed — the same TS race, but the zombie never runs).
        if self.session_is_closed() {
            return;
        }
        self.deliver_goal_work(GoalTurnEndWork::Continuation(GoalContinuation {
            request: goal_prompt_request(&message),
            goal_update,
        }));
    }

    /// Whether unsettled RLM child work holds the boundary (TS
    /// `_hasUnsettledRlmQuiescenceWork`: any admitted child run without a
    /// terminal state).
    pub(crate) async fn has_unsettled_rlm_work(&self) -> bool {
        let Some(children) = self.children.clone() else {
            return false;
        };
        children.any_running().await
    }

    /// The worker's session-input probe: `true` while queued user work or
    /// the queued-input suspension owns the next turn boundary. An
    /// unwired probe (engine without a worker) answers `false`.
    pub(crate) fn session_input_queued(&self) -> bool {
        self.goal_input_probe
            .lock()
            .expect("goal probe lock")
            .clone()
            .is_some_and(|probe| probe())
    }

    /// The natural-turn-end continuation mint (TS
    /// `_getGoalContinuationMessages`): an active goal mints one
    /// continuation context turn, deferred (and owed, not consumed) while
    /// descendant work is unsettled; queued session input defers the
    /// mint entirely (TS `queuedActionCount > 0`); an inactive goal
    /// clears any stale deferral and proceeds to the autonomous hook.
    fn mint_goal_continuation(&self) -> GoalBoundary {
        // A closed session (killed/stopped) never continues: no mint, no
        // owed-continuation consumption (TS `_disposed || _disposing` in the
        // goal resume sites; the zombie fix).
        if self.session_is_closed() {
            return GoalBoundary::Proceed;
        }
        let Some(handles) = self.goal_runtime.lock().expect("goal runtime lock").clone() else {
            return GoalBoundary::Proceed;
        };
        self.runtime.block_on(async {
            let mut driver = handles.driver.lock().await;
            if !driver.owns_continuation_wakeup() {
                // No active goal: TS returns [] (and the resume site
                // drops a stale deferral for inactive goals).
                let mut session = handles.session.lock().await;
                if driver.owes_continuation() {
                    let _ = driver.take_owed_continuation(&mut session);
                }
                return GoalBoundary::Proceed;
            }
            // Queued session input owns the turn boundary: no continuation
            // this boundary (TS `queuedActionCount > 0`); the queued
            // work's own settle re-consults.
            if self.session_input_queued() {
                return GoalBoundary::End;
            }
            // TS's quiescence gate: delegating and ending the turn is
            // correct behavior; the continuation waits (not consumed)
            // until the descendants settle.
            if self.has_unsettled_rlm_work().await {
                driver.mark_continuation_owed();
                return GoalBoundary::End;
            }
            let was_owed = driver.owes_continuation();
            let mut session = handles.session.lock().await;
            let message = if was_owed {
                driver.take_owed_continuation(&mut session)
            } else {
                driver.next_continuation_message(&mut session)
            };
            let message = match message {
                Ok(message) => message,
                Err(error) => {
                    // TS `_getGoalContinuationMessages`'s catch: the hook
                    // must not reject; a failed persist ends the boundary
                    // without a continuation.
                    eprintln!("pa-daemon: goal continuation mint persist failed: {error:#}");
                    return GoalBoundary::End;
                }
            };
            if message.is_none() {
                return GoalBoundary::End;
            }
            // The mint's arrival-epoch restore: input that arrived while
            // the mint ran rolls the slot back so the next boundary
            // re-mints without double-counting.
            if self.session_input_queued() {
                if let Err(error) = driver.rollback_continuation_mint(&mut session) {
                    // The restore hook must not reject: warn and re-owe anyway.
                    eprintln!("pa-daemon: goal mint rollback persist failed: {error:#}");
                }
                if was_owed {
                    driver.mark_continuation_owed();
                }
                return GoalBoundary::End;
            }
            let goal_update = self.publish_goal_state(driver.state());
            let message = message.expect("the mint produced a message");
            drop(driver);
            self.deliver_goal_work(GoalTurnEndWork::Continuation(GoalContinuation {
                request: goal_prompt_request(&message),
                goal_update,
            }));
            GoalBoundary::End
        })
    }

    /// The budget-limit wrap-up steer (TS
    /// `_accountGoalUsageForAssistantMessage`'s arm: the budget-limit
    /// context message queued as a steer with `resumeIfIdle: true`). The
    /// budget transition's `goal_update` already surfaced through the
    /// crossing turn's tracking wrapper, so the mint carries no update.
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
            let state = driver.state();
            if state.status != pa_core::goals::GoalStatus::BudgetLimited {
                return None;
            }
            pa_core::goals::create_goal_context_message(
                state,
                pa_core::goals::GoalContextKind::BudgetLimit,
            )
            .ok()
        })?;
        Some(GoalTurnEndWork::BudgetLimitSteer(GoalContinuation {
            request: goal_prompt_request(&message),
            goal_update: None,
        }))
    }

    /// Publish a minted state change as the `goal_update` payload (TS
    /// `_setGoalState` -> `_emitGoalUpdate`): the dedupe contract keeps
    /// an unchanged state silent. Shared with the post-compaction mint.
    pub(crate) fn publish_goal_state(
        &self,
        goal: &pa_core::goals::GoalState,
    ) -> Option<serde_json::Value> {
        let mut published = self.published_goal.lock().expect("published goal lock");
        if published.as_ref() == Some(goal) {
            return None;
        }
        *published = Some(goal.clone());
        Some(serde_json::to_value(goal).unwrap_or(serde_json::Value::Null))
    }

    /// Hand one minted follow-up to the worker's admission sink (the
    /// queue lanes admit the turn, the `goal_update` surfaces, and the
    /// runner wakes). An unwired sink (engine without a worker) drops the
    /// turn: the mint is durable, a later retry re-consults.
    fn deliver_goal_work(&self, work: GoalTurnEndWork) {
        // The final gate: a closed session admits no minted goal work (the
        // worker's kill sets the marker; the runner is parked — this keeps
        // the queue itself free of zombie rows).
        if self.session_is_closed() {
            return;
        }
        let sink = self
            .goal_admission_sink
            .lock()
            .expect("goal sink lock")
            .clone();
        match sink {
            Some(sink) => sink(work),
            None => {
                eprintln!("pa-daemon: goal follow-up dropped: no admission sink wired");
            }
        }
    }
}

/// The minted goal-context row as one admitted turn request: the
/// continuation text drives the model turn, the durable goal-context row
/// rides as the injected custom message (one representation of the turn,
/// the TS prepared-turn primary record).
fn goal_prompt_request(message: &pa_types::session::CustomMessage) -> PromptRequest {
    PromptRequest {
        message: message.content.text().to_string(),
        images: Vec::new(),
        source: "user".to_string(),
        agent_message_id: None,
        custom_message: Some(crate::session_commands::custom_message_value(message)),
    }
}
