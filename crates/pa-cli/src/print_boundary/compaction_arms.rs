//! The divider logic: the TS `_checkCompaction` arms of the print
//! runtime's turn boundary — the overflow compact-and-retry machine
//! (Case 1) with its three state enums, and the requested/threshold
//! compaction arms — the child cut of the `print_boundary` facade.

use super::{
    compaction_end_success_event, compaction_start_event, is_context_overflow_failure,
    json_round_trip, CompactOutcome, CompactionOutcomeKind, CompactionOutcomeReason, Model,
    SessionAgentMessage, SessionEngine, TrailingAssistantFilter, TurnBoundary,
};

/// The TS failure text when one compact-and-retry attempt could not save
/// the turn (`_checkCompaction`'s reported state).
pub(super) const OVERFLOW_RECOVERY_FAILED_MESSAGE: &str = "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";

/// One recovery attempt per overflow (TS `_overflowRecovery`): "attempted"
/// marks a compact-and-retry in flight; "reported" dedups the failure
/// notice when the retry overflows too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(super) enum OverflowRecovery {
    #[default]
    Idle,
    Attempted,
    Reported,
}

/// Which boundary the arm runs at. The re-issue differs: a settled-turn
/// overflow compaction re-issues the turn (TS `agent.continue()`); a
/// pre-turn one leaves the loop to the admitted prompt, which continues
/// on the compacted context (TS `_runPreTurnCompaction` never re-issues).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OverflowBoundary {
    SettledTurn,
    PreTurn,
}

/// What the overflow arm decided for the settled turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OverflowOutcome {
    /// No arm fired (not an overflow, or a guard skipped it): the requested
    /// compaction and threshold arms still get their turn.
    NotApplicable,
    /// The compact-and-retry ran: the turn re-issued on the compacted
    /// context, and the newly settled turn needs the same checks.
    RetryTurn,
    /// The turn is over (a skipped or failed compaction, or the reported
    /// second overflow): only the requested-refinement consumption follows.
    Finished,
}

impl TurnBoundary {
    /// Reset the overflow recovery state (TS: a message that starts an
    /// agent run — the admitted prompt — and every settled non-error
    /// assistant turn reset `_overflowRecovery`).
    pub(crate) fn reset(&mut self) {
        self.recovery = OverflowRecovery::Idle;
    }

    /// The requested and threshold arms (TS `_checkCompaction` after Case
    /// 1 stayed silent): a pending model-requested compaction consumes the
    /// check — TS `_runAutoCompaction` emits the start event before the
    /// summarizer runs, carrying the pending instructions — else the
    /// threshold arm compacts when the live context crossed the reserve
    /// headroom (Case 3: the settled turn's usage at `agent_end`, or the
    /// resumed context before an admitted prompt). Both boundaries share
    /// the body: the settled turn and the pre-turn check run the identical
    /// arms (TS `_runPreTurnCompaction` is the same `_checkCompaction`
    /// call; only the overflow arm's re-issue differs by boundary).
    pub(super) async fn requested_and_threshold_arms(
        &mut self,
        engine: &SessionEngine,
        model: &Model,
        api_key: Option<String>,
    ) -> Result<(), String> {
        let scheduled = engine.turn_boundary.scheduled_compaction().await;
        if let Some(pending) = &scheduled {
            self.emit_json(compaction_start_event(
                CompactionOutcomeReason::Requested.wire(),
                pending.instructions.as_deref(),
            ));
        }
        match engine
            .consume_pending_compaction(model, api_key.clone(), None)
            .await
        {
            Some(Ok(CompactOutcome::Ran(run))) => {
                // Adoption telemetry (TS `compaction_end` handling counts
                // every completed compaction into the active run).
                if let Some(telemetry) = engine.telemetry.as_ref() {
                    telemetry.note_compaction();
                }
                // TS `_scheduleAutoRefineAfterCompaction`: every successful
                // compaction schedules the compact-trigger auto-refine for
                // the next serialized checkpoint (or the disposal drain).
                self.compact_auto_refine_pending = true;
                self.emit_ipython_state_row(&run);
                self.emit_json(compaction_end_success_event(
                    CompactionOutcomeReason::Requested.wire(),
                    &run,
                    false,
                    scheduled
                        .as_ref()
                        .and_then(|pending| pending.instructions.as_deref()),
                ));
            }
            // A skip consumed the request: the durable warning row plus the
            // `compaction_end` event (TS `Requested compaction skipped:
            // ...`, warning severity).
            Some(Ok(CompactOutcome::Skipped(message))) => {
                self.end_unsuccessfully(
                    engine,
                    CompactionOutcomeReason::Requested,
                    CompactionOutcomeKind::Skipped,
                    &format!("Requested compaction skipped: {message}"),
                    scheduled
                        .as_ref()
                        .and_then(|pending| pending.instructions.as_deref()),
                )
                .await;
            }
            Some(Err(error)) => {
                self.end_unsuccessfully(
                    engine,
                    CompactionOutcomeReason::Requested,
                    CompactionOutcomeKind::Failed,
                    &format!("Requested compaction failed: {error:#}"),
                    scheduled
                        .as_ref()
                        .and_then(|pending| pending.instructions.as_deref()),
                )
                .await;
            }
            None => {
                // The threshold arm (TS `_checkCompaction` Case 3): the
                // live context crossing the reserve headroom compacts
                // before the next prompt. The `compaction_start` /
                // `compaction_end` pair streams in json mode (the outcome
                // persists in the session entries the headless terminal
                // result reads in text mode).
                if engine.session.auto_compaction_due(model).await {
                    self.emit_json(compaction_start_event(
                        CompactionOutcomeReason::Threshold.wire(),
                        None,
                    ));
                    match engine.session.compact(None, model, api_key, None).await {
                        Ok(CompactOutcome::Ran(run)) => {
                            // Adoption telemetry (TS `compaction_end`
                            // handling counts every completed compaction
                            // into the active run).
                            if let Some(telemetry) = engine.telemetry.as_ref() {
                                telemetry.note_compaction();
                            }
                            // TS `_scheduleAutoRefineAfterCompaction`: every
                            // successful compaction schedules the
                            // compact-trigger auto-refine for the next
                            // serialized checkpoint (or the disposal drain).
                            self.compact_auto_refine_pending = true;
                            self.emit_ipython_state_row(&run);
                            self.emit_json(compaction_end_success_event(
                                CompactionOutcomeReason::Threshold.wire(),
                                &run,
                                false,
                                None,
                            ));
                        }
                        Ok(CompactOutcome::Skipped(message)) => {
                            self.end_unsuccessfully(
                                engine,
                                CompactionOutcomeReason::Threshold,
                                CompactionOutcomeKind::Skipped,
                                &format!("Auto-compaction skipped: {message}"),
                                None,
                            )
                            .await;
                        }
                        Err(error) => {
                            self.end_unsuccessfully(
                                engine,
                                CompactionOutcomeReason::Threshold,
                                CompactionOutcomeKind::Failed,
                                &format!("Auto-compaction failed: {error:#}"),
                                None,
                            )
                            .await;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// The shared Case-1 body (TS `_checkCompaction` Case 1). Guard order is
    /// the TS one: a settled non-error turn resets the recovery state, the
    /// message must come from the session's current model, may not predate
    /// the latest compaction boundary, compaction must be enabled (or a
    /// pending model request covers it — the run consumes it), and the
    /// shared overflow classifier must recognize it. On a retry the
    /// settled-turn arm re-issues the turn without a new user message (TS
    /// `agent.continue()`); the pre-turn arm leaves the loop to the
    /// admitted prompt (the boundary the caller passes decides).
    pub(super) async fn overflow_recovery_attempt(
        &mut self,
        engine: &SessionEngine,
        model: &Model,
        api_key: Option<String>,
        boundary: OverflowBoundary,
    ) -> Result<OverflowOutcome, String> {
        let Some(SessionAgentMessage::Assistant(wire)) =
            engine.session.last_assistant_message().await
        else {
            return Ok(OverflowOutcome::NotApplicable);
        };
        // A settled non-error turn resets the recovery state (TS resets at
        // every non-error assistant message end).
        if wire.stop_reason != pa_types::ai::StopReason::Error {
            self.reset();
            return Ok(OverflowOutcome::NotApplicable);
        }
        // Skip the overflow check when the message came from a different
        // model (TS `sameModel`: a model switch must not compact for the
        // old model's overflow).
        if wire.provider != model.provider || wire.model != model.id {
            return Ok(OverflowOutcome::NotApplicable);
        }
        // Skip the check when the message predates the latest compaction
        // boundary (TS `assistantIsFromBeforeCompaction`): a stale
        // pre-compaction overflow must not retrigger.
        if engine
            .session
            .latest_compaction_timestamp()
            .await
            .is_some_and(|timestamp| wire.timestamp <= timestamp)
        {
            return Ok(OverflowOutcome::NotApplicable);
        }
        // Enablement: the compaction settings gate, or a pending model
        // request (the run below consumes it and honors its instructions).
        let pending_scheduled = engine.turn_boundary.compaction_scheduled().await;
        if !engine.session.auto_compaction_enabled() && !pending_scheduled {
            return Ok(OverflowOutcome::NotApplicable);
        }
        // The shared overflow classifier (TS `isContextOverflow`).
        let Some(assistant) = json_round_trip::<_, pa_agent::types::AssistantMessage>(&wire) else {
            return Ok(OverflowOutcome::NotApplicable);
        };
        if !is_context_overflow_failure(&assistant, model.context_window) {
            return Ok(OverflowOutcome::NotApplicable);
        }
        // One recovery attempt per overflow (TS `_overflowRecovery`).
        match self.recovery {
            OverflowRecovery::Attempted => {
                self.recovery = OverflowRecovery::Reported;
                // The retry still overflows: report once — the durable
                // outcome row plus the `compaction_end` failure (no error
                // severity on the wire — TS passes none for the auto arms).
                self.end_unsuccessfully(
                    engine,
                    CompactionOutcomeReason::Overflow,
                    CompactionOutcomeKind::Failed,
                    OVERFLOW_RECOVERY_FAILED_MESSAGE,
                    None,
                )
                .await;
                return Ok(OverflowOutcome::Finished);
            }
            OverflowRecovery::Reported => return Ok(OverflowOutcome::NotApplicable),
            OverflowRecovery::Idle => self.recovery = OverflowRecovery::Attempted,
        }
        // Remove the error turn from the loop context first (TS: it stays
        // in the session history, but the retry must not re-send it).
        engine
            .session
            .drop_trailing_assistant(TrailingAssistantFilter::Any)
            .await;
        // Any compaction consumes a pending model request and honors its
        // instructions (overflow can fire first and take the request with it).
        let custom_instructions = engine
            .turn_boundary
            .take_compaction()
            .await
            .and_then(|pending| pending.instructions);
        self.emit_json(compaction_start_event(
            CompactionOutcomeReason::Overflow.wire(),
            custom_instructions.as_deref(),
        ));
        // Headless compactions run unsignaled (TS print-mode compactions
        // have no abort trigger), so no abort race wraps the run.
        let outcome = engine
            .session
            .compact(custom_instructions.as_deref(), model, api_key, None)
            .await;
        match outcome {
            Ok(CompactOutcome::Ran(run)) => {
                self.compact_auto_refine_pending = true;
                self.emit_ipython_state_row(&run);
                // Adoption telemetry (TS `compaction_end` handling counts
                // every completed compaction into the active run).
                if let Some(telemetry) = engine.telemetry.as_ref() {
                    telemetry.note_compaction();
                }
                // The wire result is the TS `CompactionResult` shape; the
                // end event carries `willRetry: true` (the turn re-issues).
                self.emit_json(compaction_end_success_event(
                    CompactionOutcomeReason::Overflow.wire(),
                    &run,
                    true,
                    custom_instructions.as_deref(),
                ));
                // The compaction rebuild re-adds the error turn from the
                // kept tail: drop it again so the retried request is free
                // of it (TS will-retry branch).
                engine
                    .session
                    .drop_trailing_assistant(TrailingAssistantFilter::ErrorOnly)
                    .await;
                if boundary == OverflowBoundary::PreTurn {
                    // The admitted prompt continues the loop on the
                    // compacted context (TS `_runPreTurnCompaction` never
                    // re-issues; the prompt's own commit is the
                    // continuation).
                    return Ok(OverflowOutcome::Finished);
                }
                // Re-issue the turn without a new user message (TS
                // `agent.continue()`), then hand the newly settled turn
                // back to the boundary checks.
                engine
                    .session
                    .agent()
                    .continue_run()
                    .await
                    .map_err(|error| format!("{error:#}"))?;
                engine.session.agent().wait_for_idle().await;
                Ok(OverflowOutcome::RetryTurn)
            }
            // A skipped overflow recovery does not re-issue (TS excludes
            // overflow from `resumeAfterFailure`).
            Ok(CompactOutcome::Skipped(message)) => {
                self.end_unsuccessfully(
                    engine,
                    CompactionOutcomeReason::Overflow,
                    CompactionOutcomeKind::Skipped,
                    &format!("Auto-compaction skipped: {message}"),
                    custom_instructions.as_deref(),
                )
                .await;
                Ok(OverflowOutcome::Finished)
            }
            Err(error) => {
                self.end_unsuccessfully(
                    engine,
                    CompactionOutcomeReason::Overflow,
                    CompactionOutcomeKind::Failed,
                    &format!("Context overflow recovery failed: {error:#}"),
                    custom_instructions.as_deref(),
                )
                .await;
                Ok(OverflowOutcome::Finished)
            }
        }
    }
}
