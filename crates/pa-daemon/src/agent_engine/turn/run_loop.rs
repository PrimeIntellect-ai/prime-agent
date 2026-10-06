//! The turn loop: the queue-mode mapping, the turn runner over the
//! admission/boundary/once machinery, and the session-agent constructor.
use super::{
    AgentSessionEngine, AutoCompactionRun, BoundaryRun, EngineEvent, GoalBoundary, Model,
    OverflowArmRun, TurnAdmission, TurnPrompt, TurnResult,
};

impl AgentSessionEngine {
    /// Map a wire/settings queue mode ("all"/"one-at-a-time") onto the
    /// agent's `QueueMode`; an unknown value keeps the default.
    pub(in crate::agent_engine) fn queue_mode(mode: &str) -> Option<pa_agent::agent::QueueMode> {
        match mode {
            "all" => Some(pa_agent::agent::QueueMode::All),
            "one-at-a-time" => Some(pa_agent::agent::QueueMode::OneAtATime),
            _ => None,
        }
    }

    /// The turn loop: run one model turn, consume turn-boundary requests,
    /// then ask the autonomous driver what follows. The single trailing
    /// `Done` ends the run.
    pub(in crate::agent_engine) fn run_turns(
        &self,
        first: TurnPrompt,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        // The first turn admits the prompt; every autonomous follow-up turn
        // runs text-only (attachments are never re-sent).
        let prompt = first;
        let mut overflow_retry = false;
        // Whether a loop-boundary frame already passed in this item: the
        // worker's run-opening frames are the first run's, so the engine
        // forwards the later runs' opening frames.
        let boundary_passed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        // TS resets `_overflowRecovery` when a message that starts an agent run enters the loop.
        self.reset_overflow_recovery();
        self.quota_parked_this_run
            .store(false, std::sync::atomic::Ordering::SeqCst);
        loop {
            // A stale overflow error gets its compact-and-retry attempt on the
            // newly admitted prompt, then an earlier threshold crossing compacts
            // first.
            if !self.run_pre_turn_overflow_compaction(emit) {
                return;
            }
            if self.run_auto_compaction(emit) == AutoCompactionRun::Cancelled {
                return;
            }
            // The overflow retry re-issues the loop without a new user
            // message; every other iteration runs a fresh prompt (`mem::take`
            // clears the slot as it reads it — a plain clear would be a dead store).
            let admission = if std::mem::take(&mut overflow_retry) {
                TurnAdmission::Continue
            } else {
                TurnAdmission::FreshPrompt
            };
            let turn = self.run_model_turn(admission, &prompt, &boundary_passed, aborted, emit);
            match turn {
                TurnResult::Message(_assistant) => {
                    // A settled non-error turn resets the overflow state and
                    // counts into the auto-refine review's turn line.
                    self.reset_overflow_recovery();
                    self.note_settled_turn_since_auto_refine_review();
                    // A parked session that completes a model call has its quota back:
                    // clear the park and resume; an early success queues a marker so the
                    // interrupted task continues.
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
                // An aborted turn never services boundary requests: drop any pending ones.
                TurnResult::Aborted => {
                    self.reset_overflow_recovery();
                    self.drop_turn_boundary_requests();
                    emit(EngineEvent::DoneAborted);
                    return;
                }
                TurnResult::Error { error, assistant } => {
                    // A context-overflow error triggers one compact-and-retry attempt.
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
                    // A live quota park owns the resume: the parked turn is the park's
                    // pause, not the goal's death, so the goal survives until the wake ends
                    // it (a restored park too).
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
                            emit(EngineEvent::Done(Err(error)));
                            return;
                        }
                        // The wake was consumed and this give-up did not re-park:
                        // the episode ends here, so the stale park must not
                        // linger without a wake.
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
                    // An error assistant message fails an active goal.
                    self.finish_goal_for_terminal_error(&error);
                    emit(EngineEvent::Done(Err(error)));
                    return;
                }
            }
            // Turn-boundary consumption: requests scheduled during this turn run now.
            match self.run_turn_boundary(emit) {
                BoundaryRun::Cancelled => return,
                BoundaryRun::StoppedForCompaction { compacted } => {
                    // The requested compaction armed the trigger; the worker services it
                    // off the settle. A compaction that ran re-consults the goal; a skip
                    // stays stopped.
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
            // The settled turn's usage crossing the headroom auto-compacts; the
            // autonomous continuation decision below still runs after it.
            if self.run_auto_compaction(emit) == AutoCompactionRun::Cancelled {
                return;
            }
            // The compact-trigger round is NOT consumed here: the review runs
            // in the background while idle (a review call on this boundary held
            // the queued prompt behind the whole round). The goal takes exclusive
            // priority over autonomous; `signal?.aborted` gates it.
            if !aborted() {
                match self.goal_turn_end_boundary() {
                    GoalBoundary::End => {
                        emit(EngineEvent::Done(Ok(())));
                        return;
                    }
                    GoalBoundary::Proceed => {}
                }
            }
            // What may remain here is the continuation the threshold arm minted
            // ahead of the boundary's compaction: hand it to the worker's queue
            // lanes. A stop surfaces nothing here.
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
        // Build (once) through the shared gated funnel, so the turn-driven
        // build, the read-seam builds, and the replacement rebuild all adopt
        // the same pre-build state.
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
