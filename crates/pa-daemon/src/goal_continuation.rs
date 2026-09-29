//! The goal continuation loop at the natural turn end: the port of the
//! TS `_getGoalContinuationMessages` hook and its sibling surfaces
//! (`agent-session.ts`).
//!
//! TS drives an active goal across turns: at the agent loop's natural turn
//! end the continuation hook mints a goal-context message, the budget
//! crossing of `_shouldStopAfterTurn` queues a wrap-up steer, and a
//! continuation deferred behind unsettled RLM descendant work
//! (`_goalContinuationAwaitsRlmWork`) is delivered once the descendants
//! settle (`_maybeResumeGoalContinuationAfterRlmWork`). A live background
//! `bash()` handle holds the same deferral (TS #2465): the handle settling
//! — its completion notice, when one is owed — is the wake-up, and the
//! kernel's background-work settlement retries the owed turn. The goal takes
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
//! worker's resume sites and the kernel's background-work settlement call
//! the same retry.

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
    ///
    /// # Panics
    ///
    /// Panics when an internal mutex is poisoned (the input probe,
    /// admission sink, or queue purge lock).
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
    /// at the RLM settle, kernel background-work settlement, and resume
    /// sites): deliver the continuation owed behind descendant work once
    /// the descendants settle and the background bash handles finish.
    /// The engine's own runtime keeps the sync callers non-blocking.
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
        // TS keeps the deferral while descendant work is unsettled or a
        // background bash handle still runs.
        if self.has_unsettled_rlm_work().await || self.has_live_background_bash_handles() {
            return;
        }
        // The resume sites keep the deferral while queued input or the
        // post-abort suspension owns the boundary.
        if self.session_input_queued() {
            return;
        }
        // The progress check's input (the 402 diagnosis's (a)) + the
        // failed pair's drop ((c)), read before the driver lock like the
        // natural-boundary mint.
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
                // An inactive goal drops the deferral without minting (TS:
                // "drops the deferral for inactive goals"). A live goal in
                // the no-progress backoff keeps the deferral (the take
                // restored it) and arms the one-shot wake so the
                // advertised retry actually runs. The refusal still changed
                // the durable goal state (an Error finish or a backoff
                // strike): publish it — this settle task runs OUTSIDE a
                // turn's tracking wrapper, so nothing else would.
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
                // The mint's catch (TS `_getGoalContinuationMessages`):
                // a failed persist drops the deferral without minting.
                eprintln!("pa-daemon: owed goal continuation mint persist failed: {error:#}");
                return;
            }
        };
        // The mint succeeded: the progress turn reset any armed streak —
        // retire the pending wake instead of firing one more marker turn.
        self.cancel_goal_backoff_wake();
        // This mint's own guard handle, captured under the driver lock:
        // every later release of the mint (the admission sink, the drop
        // paths, this task's own close-race branch) clears exactly this
        // handle, never the mutable mirror (a core rebuild may have
        // re-swapped the mirror onto a replacement session's handle
        // meanwhile).
        let pending_handle = Some(driver.pending_continuation_handle());
        // TS `_getContinuationMessages`: new session input arriving
        // during the mint cancels it (the arrival-epoch restore).
        // A close that lands during the mint cancels it the same way:
        // the owed slot survives (a later resumed session retries), and
        // the stopped session's durable state stays as the close left it.
        if self.session_input_queued() || self.session_is_closed() {
            if let Err(error) = driver.rollback_continuation_mint(&mut session) {
                // The restore hook must not reject: warn. The failed
                // decrement leaves the slot durably charged (the mint's
                // increment already landed) and the guard released with
                // the dead mint — re-owing would re-mint and double-charge
                // the eventual turn, so the cancelled boundary absorbs the
                // spent slot and the next natural boundary mints normally.
                eprintln!("pa-daemon: goal mint rollback persist failed: {error:#}");
            } else {
                driver.mark_continuation_owed();
            }
            return;
        }
        let goal_update = self.publish_goal_state(&driver.state_with_creation_elapsed());
        drop(driver);
        // The close can land while the awaits above ran (the worker's kill
        // sets the marker before its own children close — each child's
        // settle fires this retry): a session that closed mid-mint mints
        // nothing (the driver's owed flag is already taken, so the mint is
        // consumed — the same TS race, but the zombie never runs). The
        // unconsumed mint releases the pending guard with it.
        if self.session_is_closed() {
            // The unconsumed mint releases its OWN pending guard (the
            // handle captured under the driver lock at the mint — a
            // rebuild may have re-swapped the mirror onto a replacement
            // session's handle while this task's awaits ran). The mint
            // always arms the guard, so the handle is always `Some`
            // here; the release names it, and an item that armed no
            // guard would release nothing.
            AgentSessionEngine::release_goal_continuation_handle(pending_handle.as_ref());
            return;
        }
        self.deliver_goal_work(GoalTurnEndWork::Continuation(GoalContinuation {
            request: goal_prompt_request(&message),
            goal_update,
            pending_handle,
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

    /// Whether a live background `bash()` handle holds the boundary (TS
    /// `_hasLiveBackgroundBashHandles`): the session's kernel still runs
    /// one. The kernel's bash-activity tracking (the same state that
    /// powers the bash-done completion follow-ups) is the liveness
    /// surface, so a live handle's completion notice is the wake-up a
    /// held continuation waits for. The probe reads the provisioner's
    /// kernel manager without ever taking the session mutex (the
    /// consult can run inside a compaction turn, which holds it); an
    /// unwired probe (engine without a built session) answers `false`.
    pub(crate) fn has_live_background_bash_handles(&self) -> bool {
        self.background_bash_probe
            .lock()
            .expect("background bash probe lock")
            .clone()
            .is_some_and(|probe| probe())
    }

    /// The settled passivation gates shared by the settled-child kernel
    /// release and the whole-worker idle passivation (TS #2483's
    /// `canPassivateSettledSession`): no unsettled RLM descendant work,
    /// no live background `bash()` handle (a kernel snapshot cannot
    /// resurrect a live process — TS `isSessionActive`'s
    /// `hasBackgroundWork` arm), and no registered active-or-paused
    /// scheduled job. The jobs gate covers plain cron jobs AND armed
    /// heartbeats alike (the shared scheduled-jobs store holds both):
    /// the port has no relaunch-on-fire for a stopped worker's jobs, so
    /// unlike TS's tier-2 (which evicts cron-armed workers and lets the
    /// fire relaunch) the port BLOCKS while any job is armed — the
    /// wake-blind substitution, a disclosed deliberate divergence until
    /// a relaunch-on-fire port exists. An unwired jobs probe passes (an
    /// engine without a scheduled-jobs store has no job to protect).
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
    /// continuation context turn, deferred (and owed, not consumed)
    /// while descendant work is unsettled or a background bash handle is
    /// still running; queued session input defers the mint entirely (TS
    /// `queuedActionCount > 0`); an inactive goal clears any stale
    /// deferral and proceeds to the autonomous hook.
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
        // The progress check's input (the 402 diagnosis's (a)): the
        // just-settled turn of the live loop context, read BEFORE the
        // driver lock (the engine-session mutex never nests under the
        // driver lock). The trailing failed continuation pair's DROP
        // ((c)) happens inside, only once the consult is actually about
        // to examine the corpse — never before the deferral gates (an
        // early drop would hide the no-progress turn from the later owed
        // or post-compaction consult, which would then read the previous
        // progress row and reset the streak).
        let last_turn = self.last_loop_assistant_message();
        self.runtime.block_on(async {
            let mut driver = handles.driver.lock().await;
            if !driver.owns_continuation_wakeup() {
                // No active goal: TS returns [] (and the resume site
                // drops a stale deferral for inactive goals).
                let mut session = handles.session.lock().await;
                if driver.owes_continuation() {
                    let _ = driver.take_owed_continuation(&mut session, None);
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
            // until the descendants settle or the background bash handles
            // finish.
            if self.has_unsettled_rlm_work().await || self.has_live_background_bash_handles() {
                driver.mark_continuation_owed();
                return GoalBoundary::End;
            }
            // The consult is about to examine the just-settled turn: now
            // the trailing failed continuation pair can leave the live
            // loop (the captured `last_turn` still carries the corpse's
            // verdict for the check below).
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
                    // TS `_getGoalContinuationMessages`'s catch: the hook
                    // must not reject; a failed persist ends the boundary
                    // without a continuation.
                    eprintln!("pa-daemon: goal continuation mint persist failed: {error:#}");
                    return GoalBoundary::End;
                }
            };
            if message.is_none() {
                // The no-progress backoff's wake: a refused mint with the
                // window still armed schedules the one-shot retry (the
                // advertised 10s/20s/40s backoff actually runs — without
                // a wake the refusal would stall the goal until an
                // unrelated boundary event). The refusal also changed the
                // durable goal state (an Error finish or a backoff
                // strike): publish it here too — the run's tracking
                // wrapper re-checks at the trailing Done, but the direct
                // publish keeps every refusal site consistent and lets
                // an attach mid-boundary see the transition.
                let state = driver.state_with_creation_elapsed();
                let wake_at = driver.backoff_wake_at();
                drop(driver);
                self.publish_goal_state(&state);
                if let Some(wake_at) = wake_at {
                    self.schedule_goal_backoff_wake(wake_at).await;
                }
                return GoalBoundary::End;
            }
            // The mint succeeded: the streak reset retires any stale
            // wake instead of firing one more marker turn.
            self.cancel_goal_backoff_wake();
            // This mint's own guard handle, captured under the driver
            // lock: the admission sink and the drop paths release exactly
            // this mint's guard, never the mutable mirror (a rebuild may
            // have re-swapped it meanwhile).
            let pending_handle = Some(driver.pending_continuation_handle());
            // The mint's arrival-epoch restore: input that arrived while
            // the mint ran rolls the slot back so the next boundary
            // re-mints without double-counting.
            if self.session_input_queued() {
                if let Err(error) = driver.rollback_continuation_mint(&mut session) {
                    // The restore hook must not reject: warn. The failed
                    // decrement leaves the slot durably charged (the
                    // mint's increment already landed) and the guard
                    // released with the dead mint — re-owing would re-mint
                    // and double-charge the eventual turn, so the
                    // cancelled boundary absorbs the spent slot and the
                    // next natural boundary mints normally.
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
            // The budget steer mints no continuation slot: no pending
            // guard exists for this item.
            pending_handle: None,
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

    /// Hand one minted follow-up to the worker's admission sink (the
    /// queue lanes admit the turn, the `goal_update` surfaces, and the
    /// runner wakes). An unwired sink (engine without a worker) drops the
    /// turn: the mint is durable, a later retry re-consults.
    fn deliver_goal_work(&self, work: GoalTurnEndWork) {
        // The final gate: a closed session admits no minted goal work (the
        // worker's kill sets the marker; the runner is parked — this keeps
        // the queue itself free of zombie rows). The minted continuation
        // never reaches a turn on this path, so the driver's pending guard
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
/// continuation text drives the model turn, the durable goal-context row
/// rides as the injected custom message (one representation of the turn,
/// the TS prepared-turn primary record).
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

    /// Inject the engine's background-bash liveness probe: the test
    /// stand-in for the kernel's activity track (a `true` probe = a live
    /// background `bash()` handle).
    fn set_background_bash_probe(
        engine: &Arc<AgentSessionEngine>,
        probe: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    ) {
        *engine
            .background_bash_probe
            .lock()
            .expect("background bash probe lock") = Some(probe);
    }

    /// TS #2465's goal rows: a turn that ends while a background `bash()`
    /// handle runs holds the timer-driven goal continuation (owed, not
    /// consumed), the settlement retry while the handle still runs keeps
    /// the deferral, and the settled handle's retry delivers the owed
    /// continuation exactly once. Without the gate the boundary mints the
    /// continuation immediately (the raced re-prompt the fix removes).
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
        // The first prompt builds the session; the probe injected after the
        // build stands in for a kernel running a background bash handle.
        admit(&engine, "warm".to_string(), &mut events);
        set_background_bash_probe(&engine, Arc::new(|| true));
        admit(
            &engine,
            "/goal ship behind the bash handle".to_string(),
            &mut events,
        );
        // Held: no mint while the handle runs, the deferral owed (not
        // consumed), and the run still settles normally.
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
        // The settlement retry while the handle still runs keeps the
        // deferral (TS keeps the resume gate behind live handles too).
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
        // The handle settles: the retry delivers the owed continuation
        // exactly once, behind the handle's own completion notice (the
        // admission ordering the worker's queue lanes own).
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
