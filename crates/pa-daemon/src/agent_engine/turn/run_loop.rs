//! The turn loop (moved with its concern): the queue-mode mapping, the
//! turn runner over the admission/boundary/once machinery, and the
//! session-agent constructor.
use super::{
    AgentSessionEngine, AutoCompactionRun, BoundaryRun, EngineEvent, GoalBoundary, Model,
    OverflowArmRun, TurnAdmission, TurnPrompt, TurnResult,
};

impl AgentSessionEngine {
    /// Map a wire/settings queue mode ("all"/"one-at-a-time") onto the
    /// agent's `QueueMode`; an unknown value keeps the TS default
    /// ("one-at-a-time").
    pub(in crate::agent_engine) fn queue_mode(mode: &str) -> Option<pa_agent::agent::QueueMode> {
        match mode {
            "all" => Some(pa_agent::agent::QueueMode::All),
            "one-at-a-time" => Some(pa_agent::agent::QueueMode::OneAtATime),
            _ => None,
        }
    }

    /// The turn loop: run one model turn, consume turn-boundary requests,
    /// then ask the autonomous driver what follows. A continuation is
    /// injected as a durable user row and drives the next turn; a stop
    /// surfaces its reason as a durable `autonomous_status` row. The single
    /// trailing `Done` ends the run.
    pub(in crate::agent_engine) fn run_turns(
        &self,
        first: TurnPrompt,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        // The first turn admits the prompt (a user prompt with its
        // images, or an injected custom row); every autonomous follow-up
        // turn runs text-only (the TS driver regenerates from the loop
        // state, never re-sending attachments).
        let prompt = first;
        let mut overflow_retry = false;
        // Whether a loop-boundary frame already passed in this runner item
        // (a `turn_end` of an inner turn or an `agent_end` of an earlier
        // run): the worker's run-opening frames are the item's first run's
        // `agent_start`/`turn_start`, so the engine forwards the later
        // runs' opening frames — the retried/continued runs TS restarts
        // with their own frames (one `agent_start` + `agent_end` pair per
        // agent run).
        let boundary_passed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        // TS resets `_overflowRecovery` when a message that starts an agent
        // run enters the loop: the admitted prompt here.
        self.reset_overflow_recovery();
        // The quota-park flag is per-run: only this run's turns can park
        // it (the settle arms read and clear it).
        self.quota_parked_this_run
            .store(false, std::sync::atomic::Ordering::SeqCst);
        loop {
            // TS `_runPreTurnCompaction` (`beforeModelSelection` for queued
            // prompts): a stale overflow error from the previous run gets
            // its compact-and-retry attempt on the newly admitted prompt
            // (Case 1 runs before the threshold arm), then a threshold
            // crossing that predates this admission compacts before the
            // turn runs; the turn then proceeds either way.
            if !self.run_pre_turn_overflow_compaction(emit) {
                return;
            }
            if self.run_auto_compaction(emit) == AutoCompactionRun::Cancelled {
                return;
            }
            // The overflow compact-and-retry re-issues the loop without a
            // new user message; every other iteration runs a fresh prompt
            // (autonomous continuations are real user rows).
            // `mem::take` clears the retry slot as it reads it (the
            // slot's cleared value is never read back on the loop's
            // exits, so a plain clear would be a dead store).
            let admission = if std::mem::take(&mut overflow_retry) {
                TurnAdmission::Continue
            } else {
                TurnAdmission::FreshPrompt
            };
            let turn = self.run_model_turn(admission, &prompt, &boundary_passed, aborted, emit);
            match turn {
                TurnResult::Message(_assistant) => {
                    // A settled non-error turn resets the overflow
                    // recovery state (TS resets at every non-error
                    // assistant message end) and counts into the
                    // auto-refine review prompt's turn line (TS
                    // `_assistantTurnsSinceAutoRefine`'s message_end
                    // increment).
                    self.reset_overflow_recovery();
                    self.note_settled_turn_since_auto_refine_review();
                    // A parked session that completes a model call has its
                    // quota back: clear the park (cancelling any pending
                    // wake) and resume (TS `_completeQuotaParkResume`).
                    // The wake probe's own success needs no second marker;
                    // an early success queues one so the interrupted task
                    // continues right away.
                    if self.is_quota_parked() {
                        let marker =
                            pa_core::session_engine::provider_park::QUOTA_RESUME_MARKER_TEXT;
                        let wake_probe = match &prompt {
                            TurnPrompt::User { text, .. } => text == marker,
                            TurnPrompt::Injected(row) => row.content.text() == marker,
                        };
                        self.runtime.block_on(self.resume_quota_park(wake_probe));
                    }
                }
                // An aborted turn never services boundary requests (TS
                // `_checkCompaction` abort arm): drop any pending ones so
                // a stale request cannot leak into the next turn.
                TurnResult::Aborted => {
                    self.reset_overflow_recovery();
                    self.drop_turn_boundary_requests();
                    emit(EngineEvent::DoneAborted);
                    return;
                }
                TurnResult::Error { error, assistant } => {
                    // TS `_checkCompaction` Case 1 at `agent_end`: a
                    // context-overflow error triggers one compact-and-retry
                    // attempt before the run ends.
                    let arm = assistant.map_or(OverflowArmRun::NotApplicable, |assistant| {
                        self.run_overflow_compaction(&assistant, emit)
                    });
                    match arm {
                        OverflowArmRun::RetryTurn => {
                            overflow_retry = true;
                            continue;
                        }
                        OverflowArmRun::NotApplicable | OverflowArmRun::Finished => {}
                        OverflowArmRun::Cancelled => return,
                    }
                    // A live quota park owns the resume: the parked turn
                    // is the park's pause, not the goal's death, so the
                    // goal survives until the wake (or a spent park
                    // budget, which declines the park first) ends it (TS
                    // `_stopGoalContinuationForTerminalMessage`'s
                    // `_quotaPark` guard — a restored park guards too,
                    // not only this run's park decision).
                    let parked_this_run = self
                        .quota_parked_this_run
                        .swap(false, std::sync::atomic::Ordering::SeqCst);
                    let live_park = self
                        .quota_park
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .clone();
                    if parked_this_run {
                        emit(EngineEvent::Done(Err(error)));
                        return;
                    }
                    if let Some(park) = live_park {
                        if park.resume_at_ms > crate::util::now_ms() {
                            // A future wake still owns the resume: the
                            // goal survives this failed turn (TS's
                            // `_quotaPark` guard).
                            emit(EngineEvent::Done(Err(error)));
                            return;
                        }
                        // The wake was consumed and this give-up did not
                        // re-park (a non-quota failure): the episode ends
                        // here (the give-up it replaced stands), so the
                        // stale park must not linger without a wake (TS
                        // abort arm's stale-park clear).
                        if let Some(job_id) = &park.job_id {
                            self.cancel_quota_resume_job(job_id);
                        }
                        self.runtime
                            .block_on(self.append_quota_resume_entry("wake-error"));
                        *self
                            .quota_park
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
                    }
                    // TS `_stopGoalContinuationForTerminalMessage`: an
                    // error assistant message fails an active goal (the
                    // state change surfaces with the trailing `Done`
                    // through the tracking wrapper).
                    self.finish_goal_for_terminal_error(&error);
                    emit(EngineEvent::Done(Err(error)));
                    return;
                }
            }
            // Turn-boundary consumption (TS `_checkCompaction` requested
            // arm, then `_consumePendingRequestedRefine`): requests the
            // kernel `compact.run`/`refine.run` host handlers scheduled
            // during this turn run now, between turns.
            match self.run_turn_boundary(emit) {
                BoundaryRun::Cancelled => return,
                BoundaryRun::StoppedForCompaction { compacted } => {
                    // The requested compaction armed the trigger; the
                    // round stays armed past this run: TS
                    // `_scheduleAutoRefineAfterCompaction` schedules the
                    // review in the background (never on the
                    // completion path), and the worker services the
                    // armed trigger off the turn's settle.
                    // TS `compact()`'s `didCompact` + active-goal branch:
                    // a compaction that ran re-consults the goal at the
                    // post-compaction boundary (`_goalContinuationAwaitsRlmWork
                    // ||= !hasQueuedMessages(); resumeQueuedWork()`); a
                    // skip or failure stays stopped like the TS catch arm.
                    if compacted && !aborted() {
                        match self.goal_turn_end_boundary() {
                            GoalBoundary::End => {
                                emit(EngineEvent::Done(Ok(())));
                                return;
                            }
                            GoalBoundary::Proceed => {}
                        }
                    }
                    emit(EngineEvent::Done(Ok(())));
                    return;
                }
                BoundaryRun::Proceed => {}
            }
            // TS agent_end `_checkCompaction` threshold arm (after the
            // requested arm, which never falls through to it): the settled
            // turn's usage crossing the reserve headroom auto-compacts;
            // the autonomous continuation decision below still runs, so a
            // continuation the driver queues continues after the
            // compaction like the TS queued continuation.
            if self.run_auto_compaction(emit) == AutoCompactionRun::Cancelled {
                return;
            }
            // The compact-trigger round is NOT consumed here: TS
            // `_scheduleAutoRefineAfterAgentEnd` schedules the review as a
            // background round (`setTimeout(0)`) that runs while the
            // session is idle, never between the compaction and its
            // settled turn — the worker services the armed trigger off
            // the turn's settle (a review LLM call on this boundary held
            // the queued next prompt behind the whole round; the
            // compaction-completion-stall measurement pinned it).
            // TS `_getContinuationMessages` at the agent loop's natural
            // turn end: the goal continuation takes exclusive priority
            // over autonomous continuation, so the goal arm runs first
            // and an active goal ends the boundary either way (a minted
            // follow-up, or a deferral behind queued input / unsettled
            // RLM descendant work). `signal?.aborted` gates the hook.
            if !aborted() {
                match self.goal_turn_end_boundary() {
                    GoalBoundary::End => {
                        emit(EngineEvent::Done(Ok(())));
                        return;
                    }
                    GoalBoundary::Proceed => {}
                }
            }
            // The natural autonomous continuation already churned inside
            // the agent run (the in-run hook, TS `getContinuationMessages`
            // -> `_getContinuationMessages`'s autonomous arm): what may
            // remain here is the continuation the threshold arm minted and
            // held ahead of the boundary's compaction (TS
            // `_queueAutonomousContinuationForThresholdCompaction` queues
            // it as a `followUp` admission) — hand it to the worker's queue
            // lanes, which run it as its own item after this run ends. A
            // stop surfaces nothing here: the headless status and exit
            // contracts carry it (TS: no row, no stream frame).
            if let Some(text) = self
                .held_autonomous_continuation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
            {
                let admission = self
                    .autonomous_admission
                    .lock()
                    .expect("autonomous admission lock")
                    .clone();
                if let Some(admit) = admission {
                    admit(text);
                }
            }
            emit(EngineEvent::Done(Ok(())));
            return;
        }
    }

    /// The hosted session's agent loop, building the session on first use.
    pub(in crate::agent_engine) fn session_agent(
        &self,
        model: &Model,
    ) -> anyhow::Result<std::sync::Arc<pa_agent::agent::Agent>> {
        // Build (once) through the shared gated funnel, so the
        // turn-driven build and the read-seam builds (and the replacement
        // teardown's fresh rebuild) all adopt the same pre-build state -
        // goal mirrors, a parked depth override, and a parked replacement
        // branch.
        {
            let guard = self.session.blocking_lock();
            if guard.is_none() {
                drop(guard);
                self.ensure_core_session(model)?;
            }
        }
        let guard = self.session.blocking_lock();
        let engine = guard.as_deref().expect("session built");
        Ok(std::sync::Arc::clone(engine.session.agent()))
    }
}
