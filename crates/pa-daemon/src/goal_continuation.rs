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

    /// Wire the kernel `bash()` launch observer: the pid→delivery
    /// binding the kernel-notice stamping reads (see
    /// [`crate::worker::admit_kernel_notice`]).
    pub(crate) fn set_kernel_bash_launch_observer(
        &self,
        observer: pa_core::kernel::shared::KernelBashLaunchCallback,
    ) {
        *self
            .kernel_bash_launch_observer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(observer);
    }

    /// Wire the kernel `bash()` activity-end observer: the drop side of
    /// the pid→delivery binding (a handle whose result the kernel
    /// consumed in-cell never sends its completion notice).
    pub(crate) fn set_kernel_bash_activity_end_observer(
        &self,
        observer: pa_core::kernel::shared::KernelBashActivityEndCallback,
    ) {
        *self
            .kernel_bash_activity_end_observer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(observer);
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

    /// Wire the parent worker's running-delivery probe for the child
    /// registry: `spawn` stamps the probe's answer on the child records,
    /// so each terminal notice's row names the delivery whose turn
    /// spawned the children (the notice then runs as that delivery's own
    /// continuation — see the runner's
    /// `is_session_own_continuation_item`).
    pub(crate) fn set_child_delivery_identity(
        &self,
        probe: crate::rlm_children::DeliveryIdentityProbe,
    ) {
        let Some(children) = self.children.clone() else {
            return;
        };
        children.set_delivery_identity_probe(probe);
    }

    /// Wire the worker's running-delivery probe for the engine's own
    /// ownership stamps: the goal's Active transition and the
    /// autonomous deferral record the delivery whose turn runs, so the
    /// identity-scoped withdrawal's stops (`pause_goal_for_withdrawn_delivery`,
    /// `retire_withdrawn_autonomous_deferral`) match the delivery they
    /// name instead of pausing or clearing whatever work the shared
    /// session holds.
    pub(crate) fn set_running_delivery_probe(
        &self,
        probe: crate::rlm_children::DeliveryIdentityProbe,
    ) {
        *self
            .running_delivery_probe
            .lock()
            .expect("running delivery probe lock") = Some(probe);
    }

    /// The running delivery's identity (the probe the worker wired): the
    /// delivery whose turn runs right now, for the engine's ownership
    /// stamps. `None` without a worker (a standalone harness engine) or
    /// while no turn runs.
    pub(crate) fn running_delivery_identity(&self) -> Option<String> {
        self.running_delivery_probe
            .lock()
            .expect("running delivery probe lock")
            .clone()
            .and_then(|probe| probe())
    }

    /// An error assistant message fails an active goal (an abort keeps
    /// it); the state change surfaces through the run's tracking wrapper.
    pub(crate) fn finish_goal_for_terminal_error(&self, error: &str) {
        let Some(handles) = self.live_handles().map(|live| live.goal.clone()) else {
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

    /// The withdrawn delivery's goal stop (the A2A cancel contract):
    /// the continuation loop the canceled task's prompt started is the
    /// task's own work — the goal the withdrawn delivery started pauses,
    /// and the owed continuation,
    /// the pending mint guard, and the backoff wake retire with the
    /// durable pause, so neither the children's settle hook nor a later
    /// boundary mints the canceled task another turn. The children the
    /// task delegated keep running exactly as before (the run-on
    /// contract); their notice turns resolve foreign to the settled
    /// task. The paused goal resumes through the session's own goal
    /// surface. A goal that is not active is untouched.
    ///
    /// The stop rides the engine's own runtime, fire-and-forget: the
    /// withdrawal's command handler answers from the worker's runtime,
    /// and a blocking pause there would stall the worker's command loop
    /// (the pause's locks and its durable write are the engine's own
    /// work, never the withdrawal's response's). The canceled task's
    /// unsettled children hold the boundary the pause must precede,
    /// and their settle hook consults the driver under the same lock
    /// this pause takes — the pause lands before any mint the children
    /// could trigger.
    pub(crate) fn pause_goal_for_withdrawn_delivery(self: &Arc<Self>, admission: &str) {
        let Some(handles) = self.live_handles().map(|live| live.goal.clone()) else {
            return;
        };
        let engine = Arc::clone(self);
        let admission = admission.to_string();
        self.runtime.spawn(async move {
            let mut driver = handles.driver.lock().await;
            if driver.state().status != pa_core::goals::GoalStatus::Active {
                return;
            }
            // The pause is identity-scoped like the sweep above it: the
            // goal's owner is the delivery whose turn started it (the
            // Active transition's stamp), so the withdrawal of one
            // delivery never pauses another client's goal on the shared
            // session. A goal with no stamp (started outside any
            // delivery's turn, or after a worker rebuild lost the
            // in-memory slot) is no waiting task's own work either —
            // the cancel leaves it to its own surface.
            if engine
                .goal_owner_delivery
                .lock()
                .expect("goal owner delivery lock")
                .as_deref()
                != Some(admission.as_str())
            {
                return;
            }
            let mut session = handles.session.lock().await;
            if let Err(persist_error) = driver.pause(&mut session, "Paused by the canceled task") {
                // The best-effort stop must not reject the withdrawal.
                eprintln!("pa-daemon: goal withdrawal pause persist failed: {persist_error:#}");
                return;
            }
            drop((driver, session));
            // The one-shot wake the goal's refusal arm scheduled retires
            // with the pause (its marker turn would spend one more model
            // turn on the canceled task's session).
            engine.cancel_goal_backoff_wake();
        });
    }

    /// Record a withdrawn delivery's goal-chain stop synchronously (the
    /// withdrawal's command handler calls this before it answers): the
    /// mint consults below read the record, so no boundary or settle
    /// hook of the withdrawn delivery's goal mints a continuation turn
    /// after the cancel — the durable pause rides its own task on this
    /// runtime and can only land after the locks it needs; under load
    /// that can come after the children's settle hook has already
    /// minted the owed continuation (the one the pause was documented
    /// to precede). Mirrors `retire_withdrawn_autonomous_deferral`'s
    /// record-first block, bounded the same way.
    pub(crate) fn retire_withdrawn_goal_delivery(&self, admission: &str) {
        let mut withdrawn = self
            .goal_withdrawn_deliveries
            .lock()
            .expect("goal withdrawn deliveries lock");
        withdrawn.retain(|id| id != admission);
        withdrawn.push(admission.to_string());
        while withdrawn.len() > crate::agent_engine::MAX_WITHDRAWN_AUTONOMOUS_CHAINS {
            withdrawn.remove(0);
        }
    }

    /// Whether a withdrawn delivery owns the session's active goal: the
    /// goal loop such a delivery started was canceled with its task, so
    /// its mints retire (the pause owns the durable stop; this record
    /// closes the mint window the pause's scheduling cannot).
    fn withdrawn_delivery_owns_goal(&self) -> bool {
        let owner = self
            .goal_owner_delivery
            .lock()
            .expect("goal owner delivery lock")
            .clone();
        owner.is_some_and(|owner| {
            self.goal_withdrawn_deliveries
                .lock()
                .expect("goal withdrawn deliveries lock")
                .contains(&owner)
        })
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
        // A closed session (killed/stopped) has no live handles: the retry drops.
        let Some(live) = self.live_handles() else {
            return;
        };
        let handles = &live.goal;
        {
            let driver = handles.driver.lock().await;
            if !driver.owes_continuation() {
                return;
            }
        }
        // A withdrawn chain's goal mints nothing here either: the settle
        // hook the children's terminal notice fired must not spend the
        // owed continuation the withdrawal retired — the pause's durable
        // drop follows on this runtime, and this record is the stop that
        // held even before it lands.
        if self.withdrawn_delivery_owns_goal() {
            return;
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
                live.publish_goal(&state);
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
        let goal_update = live.publish_goal(&driver.state_with_creation_elapsed());
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
        self.live_handles()
            .is_some_and(|live| (live.background_bash_probe)())
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
        // A closed session has no live handles: no mint, no owed-continuation
        // consumption.
        let Some(live) = self.live_handles() else {
            return GoalBoundary::Proceed;
        };
        let handles = &live.goal;
        // Read the just-settled turn BEFORE the driver lock (the session
        // mutex never nests under it). The failed pair's drop happens
        // inside, once the consult examines the corpse — an early drop
        // would hide the no-progress turn from the later consults.
        let last_turn = self.last_loop_assistant_message();
        self.runtime.block_on(async {
            // A withdrawn chain's goal mints nothing at any boundary: the
            // canceled task's loop retired with the withdrawal's
            // synchronous record (the durable pause lands on this runtime,
            // which under load can come after this very mint). The owed
            // slot stays for the pause's own durable drop; the boundary
            // passes to the autonomous arm, whose consult is
            // identity-scoped the same way.
            if self.withdrawn_delivery_owns_goal() {
                return GoalBoundary::Proceed;
            }
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
                live.publish_goal(&state);
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
            let goal_update = live.publish_goal(&driver.state_with_creation_elapsed());
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
        let handles = self.live_handles()?.goal.clone();
        let message = self.runtime.block_on(async {
            let driver = handles.driver.lock().await;
            let state = driver.state_with_creation_elapsed();
            if state.status != pa_core::goals::GoalStatus::BudgetLimited {
                return None;
            }
            pa_core::goals::create_goal_context_message(
                &state,
                pa_core::goals::GoalContextKind::BudgetLimit,
                &[],
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
    use crate::agent_engine::tests::{admit, faux_engine_with_settings, goal_admission_collector};
    use crate::engine::EngineEvent;

    /// Inject the engine's background-bash liveness probe (a `true`
    /// probe = a live background `bash()` handle).
    fn set_background_bash_probe(
        engine: &Arc<AgentSessionEngine>,
        probe: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    ) {
        engine.set_test_probes(Some(probe), None);
    }

    #[test]
    fn live_background_bash_holds_the_goal_continuation_until_it_settles() {
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
        let handles = engine.live_handles().expect("goal runtime").goal.clone();
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
