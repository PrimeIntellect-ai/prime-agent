//! The automatic compaction arms on the in-process ACP turn path: the
//! settled-turn boundary check, the pre-turn compaction, and the pending
//! requested-refine consumption, run at this transport's turn boundaries.
//! `compaction_start` has no ACP mapping (the TS adapter drops it).

use std::sync::Arc;

use pa_agent::abort::AbortController;
use pa_core::session_engine::compact_session::CompactOutcome;
use pa_core::session_engine::compaction_exec::CompactionResult;
use pa_core::session_engine::engine::SessionEngine;
use pa_core::session_engine::messages::{CompactionOutcomeKind, CompactionOutcomeReason};
use pa_types::ai::{AssistantMessage, Model};

use crate::overflow_compaction::{OverflowRecovery, OVERFLOW_RECOVERY_FAILED_MESSAGE};

use super::events::AcpEngineEvent;
use super::session::AcpSession;
use super::AcpModeState;

/// Whether the threshold arm queues the goal continuation before it
/// compacts: the settled-turn boundary queues, the pre-turn check does
/// not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ThresholdGoalQueue {
    Queue,
    Skip,
}

/// What the settled-turn check decided for the turn loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CompactionCheckRun {
    /// No arm fired, or an arm consumed the boundary without a retry.
    Proceed,
    /// The overflow arm compacted and the turn re-issues on the
    /// compacted context; no refine consumption happens at a
    /// will-retry boundary.
    OverflowRetry,
    /// A requested compaction consumed the boundary and stops the run on
    /// purpose: the model resumes on the next prompt.
    RequestedStop,
}

/// What one overflow Case-1 attempt decided: every non-retry outcome
/// stops the check, so the requested and threshold arms never fire
/// after a matched case.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OverflowAttempt {
    Continue,
    Retry,
    /// The case matched and is done: the one-attempt state blocked a
    /// fresh run, or a compaction ran without a retry.
    Done,
}

pub(super) struct CompactionArms {
    overflow_recovery: std::sync::Mutex<OverflowRecovery>,
    auto_compaction_abort: std::sync::Mutex<Option<Arc<AbortController>>>,
}

impl CompactionArms {
    pub(super) fn new() -> Self {
        Self {
            overflow_recovery: std::sync::Mutex::new(OverflowRecovery::Idle),
            auto_compaction_abort: std::sync::Mutex::new(None),
        }
    }

    pub(super) fn reset(&self) {
        *self
            .overflow_recovery
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = OverflowRecovery::Idle;
    }

    fn overflow_recovery(&self) -> std::sync::MutexGuard<'_, OverflowRecovery> {
        self.overflow_recovery
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Abort an in-flight arm compaction (the summarizer race drops
    /// the request).
    fn abort_in_flight(&self) {
        if let Some(controller) = self
            .auto_compaction_abort
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            controller.abort();
        }
    }

    fn install_abort_controller(&self) -> Arc<AbortController> {
        let controller = Arc::new(AbortController::new());
        *self
            .auto_compaction_abort
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Arc::clone(&controller));
        controller
    }

    fn clear_abort_controller(&self, controller: &Arc<AbortController>) {
        let mut slot = self
            .auto_compaction_abort
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if slot
            .as_ref()
            .is_some_and(|live| Arc::ptr_eq(live, controller))
        {
            *slot = None;
        }
    }
}

impl AcpSession {
    /// The settled-turn compaction boundary. An aborted message never
    /// reaches here (the turn loop classifies aborts first); the return
    /// carries the threshold arm's held goal continuation.
    pub(super) async fn check_compaction(
        &self,
        mode: &AcpModeState,
        assistant: &AssistantMessage,
        goal_queue: ThresholdGoalQueue,
    ) -> (CompactionCheckRun, Option<pa_types::session::CustomMessage>) {
        let (model, api_key) = mode.model_and_api_key().await;
        let Some(model) = model else {
            return (CompactionCheckRun::Proceed, None);
        };
        match self
            .overflow_attempt(mode, assistant, &model, api_key.clone())
            .await
        {
            OverflowAttempt::Retry => return (CompactionCheckRun::OverflowRetry, None),
            OverflowAttempt::Done => return (CompactionCheckRun::Proceed, None),
            OverflowAttempt::Continue => {}
        }
        if self
            .requested_arm(mode, &model, api_key.clone())
            .await
            .was_consumed()
        {
            return (CompactionCheckRun::RequestedStop, None);
        }
        let held = self
            .threshold_arm(mode, &model, api_key, assistant, goal_queue)
            .await;
        (CompactionCheckRun::Proceed, held)
    }

    /// The pre-turn compaction before an admitted prompt: the same check
    /// over the last assistant message, but an overflow recovery never
    /// re-issues.
    pub(super) async fn run_pre_turn_compaction(&self, mode: &AcpModeState) {
        let Some(assistant) =
            super::session::latest_assistant_message(mode.engine.session.agent()).await
        else {
            return;
        };
        if assistant.stop_reason == pa_types::ai::StopReason::Aborted {
            // The aborted turn's pending requests drop, then the checks continue.
            mode.engine.turn_boundary.clear_pending().await;
        }
        let (_, held) = self
            .check_compaction(mode, &assistant, ThresholdGoalQueue::Skip)
            .await;
        drop(held);
    }

    /// Taken regardless of outcome, so a failed run is not silently re-run
    /// on the next boundary.
    pub(super) async fn consume_requested_refine(&self, mode: &AcpModeState) {
        let _guard = mode.config_queue.lock().await;
        let Some(model) = mode.current_model().await else {
            return;
        };
        let Some(refinement) = mode
            .engine
            .consume_pending_refinement(
                &model,
                mode.current_api_key().await,
                mode.agent_dir.as_path().to_path_buf(),
            )
            .await
        else {
            return;
        };
        match refinement {
            Ok(result) => {
                let event = super::autorefine::refine_complete_event(&result);
                self.publish_engine_event(&event).await;
            }
            Err(error) => {
                self.publish_engine_event(&AcpEngineEvent::RefineFailed {
                    error: format!("{error:#}"),
                })
                .await;
            }
        }
    }

    /// Drop pending turn-boundary requests; an aborted turn never
    /// services them.
    pub(super) async fn clear_turn_boundary_requests(&self, engine: &SessionEngine) {
        engine.turn_boundary.clear_pending().await;
    }

    /// Reset the overflow recovery state (the turn loop calls it at
    /// every settled non-error turn and every admitted prompt).
    pub(super) fn reset_overflow_recovery(&self) {
        self.arms.reset();
    }

    /// Abort an in-flight arm compaction (session/cancel, session/close,
    /// and stdin teardown).
    pub(super) fn abort_auto_compaction(&self) {
        self.arms.abort_in_flight();
    }

    /// The threshold arm. The goal continuation is minted BEFORE the
    /// compaction runs (the minted turn drives the post-compaction
    /// continue); a cancelled compaction withdraws the mint, skip and
    /// failure keep it.
    async fn threshold_arm(
        &self,
        mode: &AcpModeState,
        model: &Model,
        api_key: Option<String>,
        assistant: &AssistantMessage,
        goal_queue: ThresholdGoalQueue,
    ) -> Option<pa_types::session::CustomMessage> {
        let engine = &mode.engine;
        if !engine.session.auto_compaction_due(model).await {
            return None;
        }
        // Error and aborted turns never queue the goal continuation.
        let settled_turn = !matches!(
            assistant.stop_reason,
            pa_types::ai::StopReason::Error | pa_types::ai::StopReason::Aborted
        );
        let held = match goal_queue {
            ThresholdGoalQueue::Queue if settled_turn => {
                super::goal_continuation::mint_goal_continuation(mode, self).await
            }
            _ => None,
        };
        let outcome = run_compaction(self, engine, model, api_key, None).await;
        let cancelled = outcome
            .as_ref()
            .err()
            .is_some_and(pa_agent::abort::is_abort_error);
        self.finish_compaction(engine, CompactionOutcomeReason::Threshold, outcome)
            .await;
        if cancelled && held.is_some() {
            super::goal_continuation::rollback_goal_mint(mode).await;
            return None;
        }
        held
    }

    /// The requested arm: a pending `compact.run` request consumed at the
    /// boundary; any outcome stops the turn loop on purpose.
    async fn requested_arm(
        &self,
        mode: &AcpModeState,
        model: &Model,
        api_key: Option<String>,
    ) -> RequestedArmRun {
        let engine = &mode.engine;
        if !engine.turn_boundary.compaction_scheduled().await {
            return RequestedArmRun::None;
        }
        let instructions = engine
            .turn_boundary
            .take_compaction()
            .await
            .and_then(|pending| pending.instructions);
        let outcome = run_compaction(self, engine, model, api_key, instructions.as_deref()).await;
        self.finish_compaction(engine, CompactionOutcomeReason::Requested, outcome)
            .await;
        RequestedArmRun::Consumed
    }

    /// The shared outcome→event mapping for the threshold and requested
    /// arms.
    async fn finish_compaction(
        &self,
        engine: &SessionEngine,
        reason: CompactionOutcomeReason,
        outcome: anyhow::Result<CompactOutcome>,
    ) {
        match outcome {
            Ok(CompactOutcome::Ran(run)) => {
                if let Some(telemetry) = &engine.telemetry {
                    telemetry.note_compaction(Some(run.duration_ms));
                }
                // The compaction arms the compact-trigger review; the
                // serialized checkpoint consumes it (autorefine.rs).
                engine.session.mark_compact_auto_refine_pending();
                publish_compaction_end(self, Some(&run.result)).await;
            }
            Ok(CompactOutcome::Skipped(message)) => {
                let text = if reason == CompactionOutcomeReason::Requested {
                    format!("Requested compaction skipped: {message}")
                } else {
                    format!("Auto-compaction skipped: {message}")
                };
                end_compaction_unsuccessfully(
                    self,
                    engine,
                    reason,
                    CompactionOutcomeKind::Skipped,
                    &text,
                )
                .await;
            }
            Err(error) if pa_agent::abort::is_abort_error(&error) => {
                let text = if reason == CompactionOutcomeReason::Requested {
                    "Requested compaction cancelled"
                } else {
                    "Compaction cancelled"
                };
                end_compaction_unsuccessfully(
                    self,
                    engine,
                    reason,
                    CompactionOutcomeKind::Cancelled,
                    text,
                )
                .await;
            }
            Err(error) => {
                let text = match reason {
                    CompactionOutcomeReason::Requested => {
                        format!("Requested compaction failed: {error:#}")
                    }
                    _ => format!("Auto-compaction failed: {error:#}"),
                };
                end_compaction_unsuccessfully(
                    self,
                    engine,
                    reason,
                    CompactionOutcomeKind::Failed,
                    &text,
                )
                .await;
            }
        }
    }

    async fn overflow_attempt(
        &self,
        mode: &AcpModeState,
        assistant: &AssistantMessage,
        model: &Model,
        api_key: Option<String>,
    ) -> OverflowAttempt {
        let engine = &mode.engine;
        // A model switch must not compact for the old model's overflow.
        if assistant.provider != model.provider || assistant.model != model.id {
            return OverflowAttempt::Continue;
        }
        // A stale pre-compaction overflow must not retrigger.
        if engine
            .session
            .latest_compaction_timestamp()
            .await
            .is_some_and(|timestamp| assistant.timestamp <= timestamp)
        {
            return OverflowAttempt::Continue;
        }
        let pending_scheduled = engine.turn_boundary.compaction_scheduled().await;
        let enabled = engine.session.auto_compaction_enabled();
        if !enabled && !pending_scheduled {
            return OverflowAttempt::Continue;
        }
        if !pa_ai::is_context_overflow(assistant, Some(model.context_window)) {
            return OverflowAttempt::Continue;
        }
        // One recovery attempt per overflow: a matched case with a
        // non-idle state is done — the reported state publishes nothing,
        // the attempted state reports its one failure disclosure.
        let first_attempt = {
            let mut recovery = self.arms.overflow_recovery();
            match *recovery {
                OverflowRecovery::Idle => {
                    *recovery = OverflowRecovery::Attempted;
                    true
                }
                OverflowRecovery::Attempted => {
                    *recovery = OverflowRecovery::Reported;
                    false
                }
                OverflowRecovery::Reported => return OverflowAttempt::Done,
            }
        };
        if !first_attempt {
            // The retry still overflows: report once.
            end_compaction_unsuccessfully(
                self,
                engine,
                CompactionOutcomeReason::Overflow,
                CompactionOutcomeKind::Failed,
                OVERFLOW_RECOVERY_FAILED_MESSAGE,
            )
            .await;
            return OverflowAttempt::Done;
        }
        // Remove the error turn from the loop context first (it stays in the
        // session history, but the retry must not re-send it).
        engine
            .session
            .drop_trailing_assistant(pa_core::session_engine::TrailingAssistantFilter::Any)
            .await;
        // Any compaction consumes a pending model request (overflow can
        // fire first and take the request with it).
        let instructions = engine
            .turn_boundary
            .take_compaction()
            .await
            .and_then(|pending| pending.instructions);
        let outcome = run_compaction(self, engine, model, api_key, instructions.as_deref()).await;
        match outcome {
            Ok(CompactOutcome::Ran(run)) => {
                if let Some(telemetry) = &engine.telemetry {
                    telemetry.note_compaction(Some(run.duration_ms));
                }
                engine.session.mark_compact_auto_refine_pending();
                publish_compaction_end(self, Some(&run.result)).await;
                // The compaction rebuild re-adds the error turn from the kept tail:
                // drop it again so the retried request is free of it.
                engine
                    .session
                    .drop_trailing_assistant(
                        pa_core::session_engine::TrailingAssistantFilter::ErrorOnly,
                    )
                    .await;
                OverflowAttempt::Retry
            }
            // A skipped overflow recovery does not re-issue.
            Ok(CompactOutcome::Skipped(message)) => {
                end_compaction_unsuccessfully(
                    self,
                    engine,
                    CompactionOutcomeReason::Overflow,
                    CompactionOutcomeKind::Skipped,
                    &format!("Auto-compaction skipped: {message}"),
                )
                .await;
                OverflowAttempt::Done
            }
            Err(error) if pa_agent::abort::is_abort_error(&error) => {
                end_compaction_unsuccessfully(
                    self,
                    engine,
                    CompactionOutcomeReason::Overflow,
                    CompactionOutcomeKind::Cancelled,
                    "Compaction cancelled",
                )
                .await;
                OverflowAttempt::Done
            }
            Err(error) => {
                end_compaction_unsuccessfully(
                    self,
                    engine,
                    CompactionOutcomeReason::Overflow,
                    CompactionOutcomeKind::Failed,
                    &format!("Context overflow recovery failed: {error:#}"),
                )
                .await;
                OverflowAttempt::Done
            }
        }
    }
}

/// Whether the requested arm consumed the boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequestedArmRun {
    None,
    Consumed,
}

impl RequestedArmRun {
    fn was_consumed(self) -> bool {
        self == RequestedArmRun::Consumed
    }
}

/// One compaction run shared by every arm: the abort slot is held for
/// the run's duration. Returns the raw outcome; the caller maps it to
/// its arm's event shapes.
async fn run_compaction(
    session: &AcpSession,
    engine: &SessionEngine,
    model: &Model,
    api_key: Option<String>,
    instructions: Option<&str>,
) -> anyhow::Result<CompactOutcome> {
    let controller = session.arms.install_abort_controller();
    let signal = controller.signal();
    let compact = async {
        engine
            .session
            .compact(instructions, model, api_key, Some(&signal))
            .await
    };
    let outcome = pa_agent::abort::race_with_abort(compact, &signal).await;
    session.arms.clear_abort_controller(&controller);
    // The race's outer `Err` is the abort marker (the summarizer was
    // dropped); the inner `Err` is the compaction's own failure — both
    // surface as the caller's `Err` for `is_abort_error` to classify.
    outcome?
}

/// Publish the ACP `compaction_end` mapping for one arm outcome: a ran
/// compaction carries its result, every other outcome the empty payload.
async fn publish_compaction_end(session: &AcpSession, ran: Option<&CompactionResult>) {
    let event = match ran {
        Some(result) => AcpEngineEvent::CompactionEnd {
            tokens_before: Some(result.tokens_before),
            summary: Some(result.summary.clone()),
        },
        None => AcpEngineEvent::CompactionEnd {
            tokens_before: None,
            summary: None,
        },
    };
    session.publish_engine_event(&event).await;
}

/// Record the durable `compaction_outcome` disclosure row for an
/// unsuccessful run, then publish the empty ACP payload.
async fn end_compaction_unsuccessfully(
    session: &AcpSession,
    engine: &SessionEngine,
    reason: CompactionOutcomeReason,
    outcome: CompactionOutcomeKind,
    message: &str,
) {
    engine
        .session
        .record_compaction_outcome(reason, outcome, message)
        .await
        .inspect_err(|error| {
            eprintln!("pa-daemon: compaction outcome persistence failed: {error:#}");
        })
        .ok();
    publish_compaction_end(session, None).await;
}
// The async tests hold the faux-provider std lock across their awaits
// on purpose: the tests are the only contenders, so no cross-task
// deadlock.
#[cfg(test)]
#[allow(clippy::await_holding_lock)]
mod tests;
