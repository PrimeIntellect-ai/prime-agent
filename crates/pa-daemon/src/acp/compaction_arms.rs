//! The automatic compaction arms on the in-process ACP turn path: the TS
//! `_checkCompaction` boundary (overflow Case 1, the model-requested arm,
//! and the threshold arm) plus `_runPreTurnCompaction` and
//! `_consumePendingRequestedRefine`, ported onto the ACP transport.
//!
//! TS ground truth: the arms live inside the `AgentSession` turn loop
//! (agent-session.ts), so every transport that drives the session —
//! interactive, daemon, RPC, and ACP — runs them. TS acp-mode.ts relies on
//! it (its turn-boundary keying documents that auto-compaction rebuilds
//! the transcript mid-turn) and its event adapter maps the `compaction_end`
//! session event to the namespaced `compaction` meta. The Rust
//! in-process ACP transport drives the pa-core session engine directly,
//! so the arms run here, at its turn boundaries; the daemon-attached ACP
//! transport already hosts the worker turn loop with its arms
//! (`agent_engine.rs` / `auto_compaction.rs` / `overflow_compaction.rs`).
//!
//! Wire shapes: every arm outcome publishes the ACP `compaction_end`
//! mapping — a ran compaction carries `tokensBefore`/`summary`, every
//! skipped, failed, or cancelled run carries the empty payload (TS
//! `compaction_end` with `result: undefined`). `compaction_start` has no
//! ACP mapping (the TS adapter drops it), so no start frame goes out.
//! The durable `compaction_outcome` disclosure row for unsuccessful runs
//! is persisted through the pa-core session seam, exactly like the
//! daemon arms.
//!
//! The compaction abort slot mirrors TS `_autoCompactionAbortController`:
//! session/cancel and session/close abort an in-flight arm compaction (TS
//! `requestAbort` calls `abortCompaction()`).

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
/// compacts (TS `_checkCompaction`'s `queueAutonomousContinuation`
/// parameter): the settled-turn boundary queues (the minted turn drives
/// the post-compaction continue), the pre-turn check does not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ThresholdGoalQueue {
    /// The settled-turn policy (TS default `true`): mint the goal
    /// continuation before the threshold compaction runs.
    Queue,
    /// The pre-turn policy (TS `_runPreTurnCompaction` passes `false`).
    Skip,
}

/// What the settled-turn check decided for the turn loop (the TS
/// `_checkCompaction` outcome plus the stop semantics the TS loop derives
/// from it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CompactionCheckRun {
    /// The check finished without a will-retry (no arm fired, or an arm
    /// consumed the boundary without a retry): the turn loop consumes
    /// the requested refinement, then applies the turn's own semantics
    /// (a failed turn ends the run with its error, a settled turn
    /// reaches the autonomous decision).
    Proceed,
    /// The overflow arm compacted and the turn re-issues (TS
    /// `willRetry`: the model turn re-runs on the compacted context
    /// without a new user message). No refine consumption happens at a
    /// will-retry boundary (TS skips `_consumePendingRequestedRefine`
    /// when `compactionWillRetry`).
    OverflowRetry,
    /// A requested compaction consumed the boundary and stops the run on
    /// purpose: the model resumes on the next prompt.
    RequestedStop,
}

/// What one overflow Case-1 attempt decided (TS `_checkCompaction` Case 1
/// returns `false` for every non-retry outcome, so the requested and
/// threshold arms never fire after a matched case).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OverflowAttempt {
    /// The Case-1 guard did not match (no overflow, a different model, a
    /// stale pre-compaction error, or compaction disabled with no pending
    /// request): the check continues to the requested and threshold arms.
    Continue,
    /// The compact-and-retry ran: the turn re-issues.
    Retry,
    /// The case matched and is done (TS `return false`): the one-attempt
    /// state blocked a fresh run, or a compaction ran and ended without a
    /// retry.
    Done,
}

/// The arm state on one ACP session (TS session-lifetime state:
/// `_overflowRecovery` and `_autoCompactionAbortController`).
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

    /// Reset the overflow recovery state (TS `startsAgentRun` at
    /// `message_start`: a user row that starts an agent run resets
    /// `_overflowRecovery`, as does every settled non-error assistant
    /// message — the turn loop owns that reset).
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

    /// Abort an in-flight arm compaction (TS `abortCompaction`): the
    /// summarizer race drops the request and the arm settles its
    /// cancelled outcome.
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
    /// TS `_checkCompaction` at the settled-turn boundary (`agent_end`):
    /// the overflow Case 1 first (it consumes any pending model request),
    /// then the requested arm (which never falls through to the threshold
    /// arm), then the threshold arm. `assistant` is the turn's settled
    /// message; an aborted message never reaches here (the turn loop
    /// classifies aborts first, dropping the boundary requests). The
    /// return carries the threshold arm's held goal continuation (the
    /// goal-queue mint before the compaction; the settle loop runs it as
    /// the post-compaction turn).
    pub(super) async fn check_compaction(
        &self,
        mode: &AcpModeState,
        assistant: &AssistantMessage,
        goal_queue: ThresholdGoalQueue,
    ) -> (CompactionCheckRun, Option<pa_types::session::CustomMessage>) {
        // The boundary reads the model and its request key as ONE pair
        // through the config queue: a concurrent picker switch holds the
        // same queue while it swaps the slots, so no arm can pair the
        // pre-switch model with the switched provider's key.
        let (model, api_key) = mode.model_and_api_key().await;
        let Some(model) = model else {
            // TS reads `this.model?.contextWindow ?? 0`: a session
            // without a resolvable model never crosses a threshold.
            return (CompactionCheckRun::Proceed, None);
        };
        match self
            .overflow_attempt(mode, assistant, &model, api_key.clone())
            .await
        {
            OverflowAttempt::Retry => return (CompactionCheckRun::OverflowRetry, None),
            // A matched case is done (TS `return false`): the requested
            // and threshold arms never fire after it.
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

    /// TS `_runPreTurnCompaction` before an admitted prompt: the same
    /// check over the last assistant message of the loop context, with
    /// the pre-turn semantics — an aborted last assistant drops its
    /// pending requests but the checks still run, and an overflow
    /// recovery never re-issues (the admitted prompt proceeds on the
    /// compacted context; TS `resumeAfterFailure` excludes overflow).
    pub(super) async fn run_pre_turn_compaction(&self, mode: &AcpModeState) {
        let Some(assistant) =
            super::session::latest_assistant_message(mode.engine.session.agent()).await
        else {
            return;
        };
        if assistant.stop_reason == pa_types::ai::StopReason::Aborted {
            // TS `skipAbortedCheck = false`: the aborted turn's pending
            // requests drop, then the checks continue.
            mode.engine.turn_boundary.clear_pending().await;
        }
        // A pre-turn threshold compaction never queues the goal
        // continuation (TS `_runPreTurnCompaction` passes
        // `queueAutonomousContinuation = false`), so the check holds
        // nothing.
        let (_, held) = self
            .check_compaction(mode, &assistant, ThresholdGoalQueue::Skip)
            .await;
        drop(held);
    }

    /// TS `_consumePendingRequestedRefine`: taken regardless of outcome,
    /// so a failed run is not silently re-run on the next boundary. The
    /// outcomes publish like the `/refine` command events.
    pub(super) async fn consume_requested_refine(&self, mode: &AcpModeState) {
        // The config queue serializes the round against picker switches
        // (the review runs on the model the session reports).
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

    /// Drop pending turn-boundary requests (an aborted turn never
    /// services them; TS `_checkCompaction`'s abort arm clears both the
    /// compaction and the refine request).
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

    /// The TS `_checkCompaction` threshold arm: the live context over
    /// the reserve headroom (the pa-core decision), one compaction when
    /// it crossed, the `compaction_end` mapping either way. Under the
    /// settled boundary's queue policy (TS
    /// `_queueGoalContinuationForThresholdCompaction`), an active goal's
    /// continuation is minted BEFORE the compaction runs — the minted
    /// turn is what drives the post-compaction continue, and the mint's
    /// `goal_update` publishes ahead of the compaction frames like the
    /// TS event order. A cancelled compaction withdraws the mint (the
    /// slot rolls back); skip and failure keep it (TS
    /// `resumeAfterFailure`).
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
        // TS's queue-site guard: error and aborted turns never queue the
        // goal continuation.
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
            // TS `_clearQueuedGoalContinuationAfterCancelledThresholdCompaction`:
            // withdraw the queued continuation and roll the slot back.
            super::goal_continuation::rollback_goal_mint(mode).await;
            return None;
        }
        held
    }

    /// The TS `_checkCompaction` requested arm: a pending `compact.run`
    /// request consumed at the boundary (any outcome consumed it; the
    /// run stops the turn loop on purpose).
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
    /// arms (TS `_runAutoCompaction`'s success / catch arms): a ran
    /// compaction publishes its result (and counts adoption telemetry),
    /// a skip records the warning disclosure, a cancel records the
    /// aborted disclosure, and a failure records the error disclosure.
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
                // TS `_scheduleAutoRefineAfterCompaction`: the compaction
                // arms the compact-trigger review; the serialized
                // checkpoint consumes it (autorefine.rs).
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

    /// The TS `_checkCompaction` Case 1 body: guards (same model, not
    /// before the latest compaction, enabled-or-requested, and an actual
    /// context overflow), the one-attempt state machine, and the
    /// compact-and-retry. The error turn leaves the loop context before
    /// the compaction runs (it stays in the session history), and a ran
    /// compaction drops it again from the rebuilt tail.
    async fn overflow_attempt(
        &self,
        mode: &AcpModeState,
        assistant: &AssistantMessage,
        model: &Model,
        api_key: Option<String>,
    ) -> OverflowAttempt {
        let engine = &mode.engine;
        // TS `sameModel`: a model switch must not compact for the old
        // model's overflow.
        if assistant.provider != model.provider || assistant.model != model.id {
            return OverflowAttempt::Continue;
        }
        // TS `assistantIsFromBeforeCompaction`: a stale pre-compaction
        // overflow must not retrigger.
        if engine
            .session
            .latest_compaction_timestamp()
            .await
            .is_some_and(|timestamp| assistant.timestamp <= timestamp)
        {
            return OverflowAttempt::Continue;
        }
        // Enablement: the compaction settings gate, or a pending model
        // request (the run below consumes it and honors its
        // instructions).
        let pending_scheduled = engine.turn_boundary.compaction_scheduled().await;
        let enabled = engine.session.auto_compaction_enabled();
        if !enabled && !pending_scheduled {
            return OverflowAttempt::Continue;
        }
        if !pa_ai::is_context_overflow(assistant, Some(model.context_window)) {
            return OverflowAttempt::Continue;
        }
        // One recovery attempt per overflow (TS `_overflowRecovery`): a
        // matched case with a non-idle state is done (TS `return false`)
        // — the reported state publishes nothing, the attempted state
        // reports its one failure disclosure.
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
            // The retry still overflows: report once (the durable
            // outcome row plus the empty ACP payload).
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
        // Remove the error turn from the loop context first (TS: it
        // stays in the session history, but the retry must not re-send
        // it).
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
                // TS `_scheduleAutoRefineAfterCompaction`: the compaction
                // arms the compact-trigger review; the retried turn's
                // serialized checkpoint consumes it (TS defers behind the
                // will-retry continuation).
                engine.session.mark_compact_auto_refine_pending();
                publish_compaction_end(self, Some(&run.result)).await;
                // The compaction rebuild re-adds the error turn from the
                // kept tail: drop it again so the retried request is
                // free of it (TS will-retry branch).
                engine
                    .session
                    .drop_trailing_assistant(
                        pa_core::session_engine::TrailingAssistantFilter::ErrorOnly,
                    )
                    .await;
                OverflowAttempt::Retry
            }
            // A skipped overflow recovery does not re-issue (TS excludes
            // overflow from `resumeAfterFailure`).
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

/// One compaction run shared by every arm (TS `_runAutoCompaction`'s
/// provider half): the abort slot is held for the run's duration and the
/// summarizer races the abort signal. Returns the raw outcome; the caller
/// maps it to its arm's event shapes.
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
/// compaction carries its result, every other outcome carries the empty
/// payload (TS `compaction_end` with `result: undefined`).
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
/// unsuccessful run (TS `_persistCompactionOutcome` via
/// `_endCompactionUnsuccessfully`), then publish the empty ACP payload.
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
// The unit battery lives in the child module (compaction_arms::tests);
// the faux-provider std lock note moves with it (the async tests hold
// it across their awaits on purpose; the tests are the only contenders,
// so no cross-task deadlock).
#[cfg(test)]
#[allow(clippy::await_holding_lock)]
mod tests;
