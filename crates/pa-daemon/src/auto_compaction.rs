//! The automatic threshold compaction at the daemon engine's turn boundaries: the TS
//! `_checkCompaction` threshold arm, fired after every settled turn (`agent_end`) and
//! before the next admitted prompt (`_runPreTurnCompaction`). The decision is pa-core's
//! [`AgentSession::auto_compaction_due`]; this module owns the threshold event pair and
//! the persist-and-broadcast contract.

use pa_agent::abort::AbortController;
use serde_json::Value;

use crate::agent_engine::AgentSessionEngine;
use crate::engine::EngineEvent;
use pa_core::session_engine::compact_session::CompactOutcome;
use pa_core::session_engine::messages::{CompactionOutcomeKind, CompactionOutcomeReason};

/// The outcome of one turn-boundary threshold check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AutoCompactionRun {
    /// No threshold crossing (the common turn): nothing ran, nothing fired.
    NotDue,
    /// The check fired and a compaction ran (success, skip, or failure —
    /// the `compaction_start`/`compaction_end` pair went out either way).
    Ran,
    /// The emit callback cancelled the run (an aborted turn): the caller
    /// stops the turn loop like any other cancelled emit.
    Cancelled,
}

impl AgentSessionEngine {
    /// The TS `_checkCompaction` threshold arm at a turn boundary: check the context against
    /// the reserve headroom; when crossed, run one compaction with the `threshold` event
    /// pair, persisting and broadcasting exactly like the `/compact` flow.
    pub(crate) fn run_auto_compaction(
        &self,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> AutoCompactionRun {
        // TS runs the summarizer on the session's live model; a fresh
        // startup-chain resolution can land it on a provider the session
        // never used (R8: "No AWS credentials available for Bedrock" in a
        // prime-inference session), so the arm follows the target.
        let Ok(model) = self.session_model() else {
            return AutoCompactionRun::NotDue;
        };
        // TS `_thresholdCompactionNeeded` reads `_runModel()` — the routed image model
        // while a routed turn is armed — so the threshold decision compares against the
        // model that actually serves; the summarizer below stays on the session model.
        let run_model = self
            .armed_image_route()
            .map_or_else(|| model.clone(), |route| route.target.model);
        let due = {
            let guard = self.session.blocking_lock();
            match guard.as_deref() {
                Some(engine) => self
                    .runtime
                    .block_on(async { engine.session.auto_compaction_due(&run_model).await }),
                // No built session: the live context is empty, matching the
                // TS pre-turn check on a fresh session.
                None => false,
            }
        };
        if !due {
            return AutoCompactionRun::NotDue;
        }
        // TS `_runAutoCompaction` emits the start event before the
        // summarizer runs, so attached surfaces see the loader.
        if !emit(EngineEvent::CompactionStart {
            event: crate::compaction::compaction_start_event("threshold", None),
        }) {
            return AutoCompactionRun::Cancelled;
        }
        pa_core::session_engine::compaction_trace::trace(
            "auto.threshold_start_emitted",
            &serde_json::Value::Null,
        );
        // TS assigns `_autoCompactionAbortController` for the run's duration: an
        // `abort_compaction` command lands in the slot and cancels the in-flight summarizer.
        let controller = std::sync::Arc::new(AbortController::new());
        let signal = controller.signal();
        {
            *self
                .auto_compaction_abort
                .lock()
                .expect("auto compaction abort lock") = Some(std::sync::Arc::clone(&controller));
        }
        let api_key = self.resolve_request_api_key(&model);
        let outcome = {
            let guard = self.session.blocking_lock();
            let Some(engine) = guard.as_deref() else {
                self.clear_auto_compaction_abort(&controller);
                return AutoCompactionRun::NotDue;
            };
            // The abort race drops the summarizer request in flight; the
            // signal also lands the pre-commit check inside the compaction.
            let compact = async {
                engine
                    .session
                    .compact(None, &model, api_key, Some(&signal))
                    .await
            };
            let outcome = self
                .runtime
                .block_on(pa_agent::abort::race_with_abort(compact, &signal));
            self.clear_auto_compaction_abort(&controller);
            outcome
        };
        pa_core::session_engine::compaction_trace::trace(
            "auto.compact_returned",
            &(match &outcome {
                Ok(Ok(CompactOutcome::Ran(_))) => {
                    serde_json::json!({ "outcome": "ran" })
                }
                Ok(Ok(CompactOutcome::Skipped(_))) => {
                    serde_json::json!({ "outcome": "skipped" })
                }
                // The abort marker (from either layer) is checked before the
                // generic failure, so a cancelled run traces "cancelled".
                Ok(Err(error)) | Err(error) if pa_agent::abort::is_abort_error(error) => {
                    serde_json::json!({ "outcome": "cancelled" })
                }
                Ok(Err(_)) | Err(_) => {
                    serde_json::json!({ "outcome": "failed" })
                }
            }),
        );
        match &outcome {
            Ok(Ok(CompactOutcome::Ran(run))) => {
                // The post-compaction kernel notice goes out before the settled end (TS
                // `_syncKernelStateAfterCompaction`): its `message_start`/`message_end` pair
                // precedes `compaction_end`.
                if let Some(message) = &run.ipython_state {
                    if !emit(EngineEvent::CustomMessage(
                        crate::session_commands::custom_message_value(message),
                    )) {
                        return AutoCompactionRun::Cancelled;
                    }
                    pa_core::session_engine::compaction_trace::trace(
                        "auto.notice_emitted",
                        &serde_json::Value::Null,
                    );
                }
                // Adoption telemetry (TS `compaction_end` handling counts
                // every completed compaction into the active run).
                {
                    let guard = self.session.blocking_lock();
                    if let Some(telemetry) = guard
                        .as_deref()
                        .and_then(|engine| engine.telemetry.as_ref())
                    {
                        telemetry.note_compaction(Some(run.duration_ms));
                    }
                }
                // TS `_scheduleAutoRefineAfterCompaction`: the compaction
                // arms the compact-trigger review.
                self.mark_compact_auto_refine_pending();
                // The wire result is the TS `CompactionResult` shape (details included).
                let result = crate::compaction::compaction_result_value(&run.result, &run.entry);
                let entry = serde_json::to_value(&run.entry).unwrap_or(Value::Null);
                let event =
                    crate::compaction::compaction_end_success("threshold", &result, false, None);
                if !emit(EngineEvent::Compaction { entry, event }) {
                    return AutoCompactionRun::Cancelled;
                }
                pa_core::session_engine::compaction_trace::trace(
                    "auto.end_emitted",
                    &serde_json::Value::Null,
                );
            }
            // A skip consumed the check (TS `CompactionSkippedError`): the disclosure row
            // goes out with its message pair, then the end event carries the warning.
            Ok(Ok(CompactOutcome::Skipped(message))) => {
                if !self.emit_unsuccessful_compaction(
                    CompactionOutcomeReason::Threshold,
                    CompactionOutcomeKind::Skipped,
                    &format!("Auto-compaction skipped: {message}"),
                    None,
                    emit,
                ) {
                    return AutoCompactionRun::Cancelled;
                }
            }
            // An abort from either layer — the race dropped the in-flight summarizer request,
            // or the pre-commit signal check fired (TS `_runAutoCompaction`'s aborted arm,
            // checked before the skip and failure arms).
            Ok(Err(error)) | Err(error) if pa_agent::abort::is_abort_error(error) => {
                if !self.emit_unsuccessful_compaction(
                    CompactionOutcomeReason::Threshold,
                    CompactionOutcomeKind::Cancelled,
                    "Compaction cancelled",
                    None,
                    emit,
                ) {
                    return AutoCompactionRun::Cancelled;
                }
            }
            // A failed run persists the disclosure row and emits the `compaction_end` failure
            // (TS `_endCompactionUnsuccessfully`: automatic failures carry no `errorSeverity`).
            Ok(Err(error)) | Err(error) => {
                if !self.emit_unsuccessful_compaction(
                    CompactionOutcomeReason::Threshold,
                    CompactionOutcomeKind::Failed,
                    &format!("Auto-compaction failed: {error:#}"),
                    None,
                    emit,
                ) {
                    return AutoCompactionRun::Cancelled;
                }
            }
        }
        AutoCompactionRun::Ran
    }
}
