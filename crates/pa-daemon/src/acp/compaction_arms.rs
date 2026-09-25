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
        let Some(model) = mode.model.clone() else {
            // TS reads `this.model?.contextWindow ?? 0`: a session
            // without a resolvable model never crosses a threshold.
            return (CompactionCheckRun::Proceed, None);
        };
        match self.overflow_attempt(mode, assistant).await {
            OverflowAttempt::Retry => return (CompactionCheckRun::OverflowRetry, None),
            // A matched case is done (TS `return false`): the requested
            // and threshold arms never fire after it.
            OverflowAttempt::Done => return (CompactionCheckRun::Proceed, None),
            OverflowAttempt::Continue => {}
        }
        if self.requested_arm(mode, &model).await.was_consumed() {
            return (CompactionCheckRun::RequestedStop, None);
        }
        let held = self
            .threshold_arm(mode, &model, assistant, goal_queue)
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
        let Some(model) = mode.model.clone() else {
            return;
        };
        let Some(refinement) = mode
            .engine
            .consume_pending_refinement(
                &model,
                mode.api_key.clone(),
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
    pub(super) async fn reset_overflow_recovery(&self) {
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
        let outcome = run_compaction(self, engine, model, mode.api_key.clone(), None).await;
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
    async fn requested_arm(&self, mode: &AcpModeState, model: &Model) -> RequestedArmRun {
        let engine = &mode.engine;
        if !engine.turn_boundary.compaction_scheduled().await {
            return RequestedArmRun::None;
        }
        let instructions = engine
            .turn_boundary
            .take_compaction()
            .await
            .and_then(|pending| pending.instructions);
        let outcome = run_compaction(
            self,
            engine,
            model,
            mode.api_key.clone(),
            instructions.as_deref(),
        )
        .await;
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
                    telemetry.note_compaction();
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
    ) -> OverflowAttempt {
        let engine = &mode.engine;
        let Some(model) = mode.model.clone() else {
            return OverflowAttempt::Continue;
        };
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
        let outcome = run_compaction(
            self,
            engine,
            &model,
            mode.api_key.clone(),
            instructions.as_deref(),
        )
        .await;
        match outcome {
            Ok(CompactOutcome::Ran(run)) => {
                if let Some(telemetry) = &engine.telemetry {
                    telemetry.note_compaction();
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

#[cfg(test)]
// The faux provider registry is process-global and shared with the
// daemon engine tests: the std lock serializes every test that drives
// it, and the async tests here hold it across their awaits on purpose
// (the tests are the only contenders, so no cross-task deadlock).
#[allow(clippy::await_holding_lock)]
mod tests {
    use super::*;
    use crate::agent_engine::FAUX_TEST_LOCK;

    /// The faux model's per-request output budget (maxTokens `16_384` under the
    /// `32_000` request cap): threshold fixtures subtract it from the window
    /// alongside the headroom (the combined input+output ceiling).
    const FAUX_REQUEST_BUDGET: u64 = 16_384;

    use pa_core::session_engine::engine::{create_session, SessionEngineConfig};
    use pa_core::session_engine::provider_adapter::{json_round_trip, real_stream_fn};
    use serde_json::json;
    use tokio::sync::{mpsc, Mutex};

    use super::super::producer::UpdateProducer;
    use super::super::prompt::handle_session_prompt;
    use super::super::session::AcpSession;
    use super::super::{AcpModeState, ConnectionState, SessionEntry};

    /// The ACP meta namespace on the wire.
    const META: &str = "ai.primeintellect.prime-agent";

    /// One armed ACP prompt turn over an in-process faux engine. The faux
    /// provider registry is process-global, so every test holds the
    /// shared lock like the daemon engine tests.
    struct AcpTestBed {
        mode: AcpModeState,
        state: std::sync::Arc<Mutex<ConnectionState>>,
        session_id: String,
        tx: super::super::producer::FrameSink,
        frames: mpsc::UnboundedReceiver<serde_json::Value>,
        next_request_id: u64,
        engine: std::sync::Arc<SessionEngine>,
        /// Held so the engine's cwd outlives the test.
        _dir: tempfile::TempDir,
    }

    /// Build one bed: the faux script drives the provider, the compaction
    /// settings come from the agent dir, and the ACP session wraps the
    /// engine exactly like `session/new` does.
    async fn acp_test_bed(
        script: serde_json::Value,
        reserve_tokens: u64,
        keep_recent_tokens: u64,
    ) -> AcpTestBed {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("settings.json"),
            json!({
                "compaction": {
                    "enabled": true,
                    "reserveTokens": reserve_tokens,
                    "keepRecentTokens": keep_recent_tokens,
                }
            })
            .to_string(),
        )
        .unwrap();
        let parsed = pa_ai::faux::script::parse_faux_script(&script)
            .map_err(anyhow::Error::msg)
            .unwrap();
        let registration = pa_ai::faux::script::register_faux_provider_from_script(&parsed);
        let model = registration.get_model();
        let agent_model: pa_agent::types::Model =
            json_round_trip(&model).expect("model conversion");
        let stream_fn = real_stream_fn(None, model.clone());
        let engine = std::sync::Arc::new(
            create_session(SessionEngineConfig {
                cron_store: None,
                queued_steering_probe: None,
                steering_mode: None,
                follow_up_mode: None,
                telemetry: None,
                cwd: dir.path().to_path_buf(),
                agent_dir: agent_dir.clone(),
                mcp_manager: None,
                model: Some(agent_model),
                thinking_level: None,
                stream_fn: Some(stream_fn),
                tools: Vec::new(),
                custom_system_prompt: None,
                prompt_guidelines: Vec::new(),
                generic_mcp_servers: Vec::new(),
                allow_recursion: None,
                session_manager: None,
                extra_host_handlers: None,
                conversation_log_path: None,
                additional_skill_paths: Vec::new(),
                additional_prompt_paths: Vec::new(),
                extra_builtin_skill_overrides: Vec::new(),
                rlm_subagent_host: None,
                rlm_depth: None,
                model_info: Some(model.clone()),
                cli_extension_sources: Vec::new(),
                extension_tool_allow_list: None,
                prewarm_ipython_kernel: None,
                queued_goal_context_purge: None,
            })
            .await
            .unwrap(),
        );
        let (tx, frames) = mpsc::unbounded_channel::<serde_json::Value>();
        let session_id = "acp-test-session".to_string();
        let producer = UpdateProducer::new(session_id.clone(), tx.clone());
        let autonomous = std::sync::Arc::new(Mutex::new(
            pa_core::autonomous::create_autonomous_runtime_state(None, None),
        ));
        let driver: std::sync::Arc<dyn pa_core::autonomous::AutonomousDriver> =
            std::sync::Arc::new(pa_core::autonomous::ShellAutonomousDriver::new(dir.path()));
        let session = std::sync::Arc::new(
            AcpSession::new(
                session_id.clone(),
                engine.clone(),
                producer.clone(),
                autonomous,
                driver,
            )
            .await,
        );
        producer.commit_session_new_response().await;
        let state = std::sync::Arc::new(Mutex::new(ConnectionState {
            session: Some(SessionEntry {
                session,
                prompt_task: None,
            }),
            session_new_in_flight: false,
            session_close_in_flight: false,
        }));
        let mode = AcpModeState {
            engine: engine.clone(),
            actual_cwd: std::sync::Arc::new(dir.path().to_path_buf()),
            product_version: std::sync::Arc::new("test".to_string()),
            model: Some(model),
            api_key: None,
            agent_dir: std::sync::Arc::new(agent_dir),
            autonomous_config: None,
            mcp: engine.mcp_manager.clone(),
            mcp_owner_id: std::sync::Arc::new("acp-test-owner".to_string()),
            mcp_server_names: std::sync::Arc::new(Mutex::new(Vec::new())),
        };
        AcpTestBed {
            mode,
            state,
            session_id,
            tx,
            frames,
            next_request_id: 0,
            engine,
            _dir: dir,
        }
    }

    impl AcpTestBed {
        /// Admit one prompt through the real ACP prompt handler and read
        /// frames until its response: (response, notifications in order).
        async fn prompt(&mut self, text: String) -> (serde_json::Value, Vec<serde_json::Value>) {
            self.next_request_id += 1;
            let id = serde_json::Value::from(self.next_request_id);
            handle_session_prompt(
                id.clone(),
                json!({
                    "sessionId": self.session_id,
                    "prompt": [{ "type": "text", "text": text }],
                }),
                self.state.clone(),
                self.mode.clone(),
                self.tx.clone(),
            )
            .await;
            let mut notifications = Vec::new();
            loop {
                let Some(frame) = self.frames.recv().await else {
                    panic!("ACP frame channel closed before the response");
                };
                if frame.get("id") == Some(&id)
                    && (frame.get("result").is_some() || frame.get("error").is_some())
                {
                    return (frame, notifications);
                }
                notifications.push(frame);
            }
        }

        /// The published `compaction` metas (the ACP `compaction_end`
        /// mapping) among a turn's notifications.
        fn compaction_metas(notifications: &[serde_json::Value]) -> Vec<serde_json::Value> {
            notifications
                .iter()
                .filter_map(|frame| {
                    Some(
                        frame
                            .get("params")?
                            .get("update")?
                            .get("_meta")?
                            .get(META)?
                            .get("compaction")?
                            .clone(),
                    )
                })
                .collect()
        }

        /// The settled assistant usage of the newest assistant turn.
        async fn latest_usage(&self) -> u64 {
            super::super::session::latest_assistant_message(self.engine.session.agent())
                .await
                .expect("an assistant message")
                .usage
                .total_tokens
        }

        /// The durable entry chain.
        async fn entries(&self) -> Vec<pa_types::session::FileEntry> {
            self.engine
                .session
                .shared_persistence()
                .lock()
                .await
                .get_entries()
                .clone()
        }
    }

    /// The TS overflow error shape: an Anthropic token-overflow message.
    /// The retry-turn entry paces the stream (`delayMs`) so its settled
    /// message timestamp lands strictly after the compaction entry's (the
    /// `assistantIsFromBeforeCompaction` guard compares millisecond
    /// timestamps; a real provider round-trip spans more than one).
    fn overflow_error(delay_ms: u64) -> serde_json::Value {
        let mut entry = json!({
            "text": "",
            "stopReason": "error",
            "errorMessage": "prompt is too long: 213462 tokens > 200000 maximum",
        });
        if delay_ms > 0 {
            entry["delayMs"] = json!(delay_ms);
        }
        entry
    }

    /// The threshold arm on the ACP turn path: a settled turn whose usage
    /// crosses the reserve headroom runs one compaction at the boundary
    /// and publishes the `compaction` meta (tokensBefore + summary), and
    /// the turn still settles with `end_turn`. The faux provider
    /// estimates usage from the serialized context, so the probe measures
    /// one seed turn's usage and the reserve sits between the two turns'
    /// usage (the daemon engine tests' environment-independent recipe).
    #[tokio::test]
    async fn threshold_arm_compacts_and_publishes_the_acp_meta() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Probe: the seed turn's total usage (system prompt included).
        let mut probe =
            acp_test_bed(json!({ "responses": [{ "text": "seed reply" }] }), 1, 10).await;
        probe
            .prompt(format!("seed turn {}", "x".repeat(48_000)))
            .await;
        let seed_usage = probe.latest_usage().await;
        assert!(
            seed_usage > 0 && seed_usage < 100_000,
            "usage: {seed_usage}"
        );
        drop(probe);

        // The crossing prompt adds ~2000 tokens; the headroom sits
        // between the two turns' usage (500-token margins on both
        // sides).
        let crossing_delta = (8_000 + "seed turn  crossing".len() as u64).div_ceil(4);
        let mut bed = acp_test_bed(
            json!({
                "responses": [
                    { "text": "seed reply" },
                    { "text": "crossing reply" },
                    { "text": "the summary" },
                ]
            }),
            128_000u64
                .saturating_sub(FAUX_REQUEST_BUDGET + seed_usage + crossing_delta / 4)
                .max(1),
            10,
        )
        .await;
        // The seed turn stays below the headroom: no compaction.
        let (response, notifications) = bed
            .prompt(format!("seed turn {}", "x".repeat(48_000)))
            .await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        assert!(AcpTestBed::compaction_metas(&notifications).is_empty());
        // The threshold-crossing turn: the settled usage fires one
        // compaction at the boundary (the summarizer consumed the third
        // scripted response).
        let (response, notifications) = bed
            .prompt(format!("crossing turn {}", "x".repeat(8_000)))
            .await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        let metas = AcpTestBed::compaction_metas(&notifications);
        assert_eq!(metas.len(), 1, "one compaction meta: {metas:?}");
        assert_eq!(metas[0]["summary"], "the summary");
        assert!(metas[0]["tokensBefore"].as_u64().unwrap() > 0);
        assert!(
            bed.entries()
                .await
                .iter()
                .any(|entry| matches!(entry, pa_types::session::FileEntry::Compaction { .. })),
            "the compaction persisted"
        );
    }

    /// Below the headroom nothing fires: no compaction meta, no entry.
    #[tokio::test]
    async fn below_headroom_no_arm_fires() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut bed =
            acp_test_bed(json!({ "responses": [{ "text": "small reply" }] }), 1, 10).await;
        let (response, notifications) = bed.prompt("small turn".to_string()).await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        assert!(AcpTestBed::compaction_metas(&notifications).is_empty());
        assert!(!bed
            .entries()
            .await
            .iter()
            .any(|entry| matches!(entry, pa_types::session::FileEntry::Compaction { .. })));
    }

    /// The overflow arm on the ACP turn path: an overflow error turn
    /// compacts once (the compact-and-retry) and the retried turn settles
    /// the prompt with `end_turn` instead of the error.
    #[tokio::test]
    async fn overflow_arm_compacts_and_retries_the_turn() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut bed = acp_test_bed(
            json!({
                "responses": [
                    { "text": "seed reply" },
                    overflow_error(0),
                    { "text": "the summary" },
                    { "text": "recovered reply" },
                ]
            }),
            1,
            10,
        )
        .await;
        let (response, _) = bed
            .prompt(format!("seed turn {}", "x".repeat(48_000)))
            .await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        let (response, notifications) = bed
            .prompt(format!("overflow probe {}", "x".repeat(2_000)))
            .await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        let metas = AcpTestBed::compaction_metas(&notifications);
        assert_eq!(metas.len(), 1, "one compaction meta: {metas:?}");
        assert_eq!(metas[0]["summary"], "the summary");
        assert!(metas[0]["tokensBefore"].as_u64().unwrap() > 0);
        // The retried turn is the settled outcome: no failure rows on the
        // recovered run (the daemon worker's contract).
        let latest = super::super::session::latest_assistant_message(bed.engine.session.agent())
            .await
            .expect("an assistant message");
        assert_eq!(latest.stop_reason, pa_types::ai::StopReason::Stop);
        assert!(
            bed.entries()
                .await
                .iter()
                .any(|entry| matches!(entry, pa_types::session::FileEntry::Compaction { .. })),
            "the compaction persisted"
        );
    }

    /// A retry that still overflows reports once (the TS failure text) and
    /// ends the run with the overflow error: the successful
    /// compact-and-retry publishes the result meta, the report publishes
    /// the empty payload, and the prompt errors.
    #[tokio::test]
    async fn overflow_retry_that_overflows_again_reports_once() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut bed = acp_test_bed(
            json!({
                "responses": [
                    { "text": "seed reply" },
                    overflow_error(0),
                    { "text": "the summary" },
                    overflow_error(25),
                ]
            }),
            1,
            10,
        )
        .await;
        let (response, _) = bed
            .prompt(format!("seed turn {}", "x".repeat(48_000)))
            .await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        let (response, notifications) = bed
            .prompt(format!("overflow probe {}", "x".repeat(2_000)))
            .await;
        assert_eq!(response["error"]["code"], -32603, "the turn failed");
        let details = response["error"]["data"]["details"]
            .as_str()
            .unwrap_or_default();
        assert!(
            details.contains("prompt is too long"),
            "the overflow error text surfaces: {response}"
        );
        let metas = AcpTestBed::compaction_metas(&notifications);
        assert_eq!(metas.len(), 2, "the run + the report: {metas:?}");
        assert_eq!(metas[0]["summary"], "the summary");
        assert_eq!(metas[1], json!({}));
        // The durable disclosure row carries the TS report text.
        let entries = bed.entries().await;
        let rows = entries
            .iter()
            .filter_map(|entry| match entry {
                pa_types::session::FileEntry::CustomMessage { payload, .. } => Some(payload),
                _ => None,
            })
            .filter(|payload| payload.custom_type == "compaction_outcome")
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 1, "one disclosure row");
        assert_eq!(
            serde_json::to_value(&rows[0].content).unwrap(),
            json!("Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.")
        );
    }

    /// The requested arm on the ACP turn path: a scheduled `compact.run`
    /// request is consumed at the next admitted prompt's pre-turn boundary
    /// (TS `_runPreTurnCompaction` runs the requested arm too), publishes
    /// the compaction meta, and stops the turn loop on purpose (the run
    /// still settles `end_turn`); the request is taken regardless of
    /// outcome.
    #[tokio::test]
    async fn requested_arm_consumes_the_scheduled_compaction() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut bed = acp_test_bed(
            json!({
                "responses": [
                    { "text": "seed reply" },
                    { "text": "turn two reply" },
                    { "text": "the requested summary" },
                    { "text": "turn three reply" },
                ]
            }),
            1,
            10,
        )
        .await;
        let (response, _) = bed
            .prompt(format!("seed turn {}", "x".repeat(48_000)))
            .await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        let (response, _) = bed.prompt(format!("turn two {}", "x".repeat(2_000))).await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        // Schedule a requested compaction (the `compact.run` write path):
        // the next prompt's pre-turn boundary consumes it. The session
        // carries two settled turns, so the keep-recent cut leaves the
        // first turn summarizable.
        bed.engine
            .turn_boundary
            .schedule_compaction(Some("keep the checklist".to_string()))
            .await;
        let (response, notifications) = bed.prompt("turn three".to_string()).await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        let metas = AcpTestBed::compaction_metas(&notifications);
        assert_eq!(metas.len(), 1, "one compaction meta: {metas:?}");
        assert_eq!(metas[0]["summary"], "the requested summary");
        assert!(!bed.engine.turn_boundary.compaction_scheduled().await);
        assert!(
            bed.entries()
                .await
                .iter()
                .any(|entry| matches!(entry, pa_types::session::FileEntry::Compaction { .. })),
            "the requested compaction persisted"
        );
    }

    /// A skipped requested compaction still consumes the request and
    /// publishes the empty payload (the TS `compaction_end` with
    /// `result: undefined`), plus the durable disclosure row with the
    /// requested-skip message.
    #[tokio::test]
    async fn requested_arm_skip_publishes_the_empty_payload() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // `keepRecentTokens` beyond the whole session: the cut keeps
        // everything, so the compaction skips as too short.
        let mut bed = acp_test_bed(
            json!({ "responses": [{ "text": "seed reply" }, { "text": "turn two reply" }] }),
            1,
            100_000,
        )
        .await;
        let (response, _) = bed.prompt("seed turn".to_string()).await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        bed.engine.turn_boundary.schedule_compaction(None).await;
        let (response, notifications) = bed.prompt("turn two".to_string()).await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        let metas = AcpTestBed::compaction_metas(&notifications);
        assert_eq!(metas.len(), 1, "the skip is observable: {metas:?}");
        assert_eq!(metas[0], json!({}));
        assert!(!bed.engine.turn_boundary.compaction_scheduled().await);
        let entries = bed.entries().await;
        let row = entries
            .iter()
            .filter_map(|entry| match entry {
                pa_types::session::FileEntry::CustomMessage { payload, .. } => Some(payload),
                _ => None,
            })
            .find(|payload| payload.custom_type == "compaction_outcome")
            .expect("the disclosure row persisted");
        assert_eq!(
            serde_json::to_value(&row.content).unwrap(),
            json!("Requested compaction skipped: Session is too short to compact — try again once it grows")
        );
    }

    /// The overflow machine resets at a user row that starts an agent run
    /// (TS `startsAgentRun` at `message_start`): the reported state from
    /// the previous prompt's failed recovery never suppresses the next
    /// prompt's fresh attempt, and the fresh turn's overflow recovers at
    /// its own boundary.
    #[tokio::test]
    async fn overflow_state_resets_per_agent_run() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut bed = acp_test_bed(
            json!({
                "responses": [
                    { "text": "seed reply" },
                    overflow_error(0),
                    { "text": "the summary" },
                    overflow_error(25),
                    overflow_error(25),
                    { "text": "the second summary" },
                    { "text": "recovered after the stale overflow" },
                ]
            }),
            1,
            10,
        )
        .await;
        let (response, _) = bed
            .prompt(format!("seed turn {}", "x".repeat(48_000)))
            .await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        // Prompt two: attempt, the retry overflows, reported — the run
        // ends with the error.
        let (response, notifications) = bed
            .prompt(format!("overflow probe {}", "x".repeat(2_000)))
            .await;
        assert_eq!(response["error"]["code"], -32603);
        assert_eq!(
            AcpTestBed::compaction_metas(&notifications).len(),
            2,
            "the run + the report"
        );
        // Prompt three: the fresh user row reset the machine, so the
        // turn's own overflow gets a fresh attempt and the retry
        // recovers.
        let (response, notifications) = bed.prompt("second prompt".to_string()).await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        let metas = AcpTestBed::compaction_metas(&notifications);
        assert_eq!(metas.len(), 1, "a fresh attempt ran: {metas:?}");
        assert_eq!(metas[0]["summary"], "the second summary");
    }

    /// The overflow retry re-issues without re-adding the user message (TS
    /// `agent.continue()`): the durable chain carries the seed and probe
    /// rows only.
    #[tokio::test]
    async fn overflow_retry_turn_adds_no_user_row() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut bed = acp_test_bed(
            json!({
                "responses": [
                    { "text": "seed reply" },
                    overflow_error(0),
                    { "text": "the summary" },
                    { "text": "recovered reply" },
                ]
            }),
            1,
            10,
        )
        .await;
        let (response, _) = bed
            .prompt(format!("seed turn {}", "x".repeat(48_000)))
            .await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        let (response, _) = bed
            .prompt(format!("overflow probe {}", "x".repeat(2_000)))
            .await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        let users = bed
            .entries()
            .await
            .iter()
            .filter(|entry| {
                matches!(
                    entry,
                    pa_types::session::FileEntry::Message {
                        message: pa_types::session::AgentMessage::User(_),
                        ..
                    }
                )
            })
            .count();
        assert_eq!(users, 2, "the retry added no user row");
    }
}
