//! The automatic threshold compaction at the daemon engine's turn
//! boundaries: the TS `_checkCompaction` threshold arm wired into the
//! turn loop (TS `agent-session.ts`).
//!
//! TS fires the check at two boundaries: after every settled turn
//! (`agent_end`) and before the next admitted prompt
//! (`_runPreTurnCompaction`, `beforeModelSelection` for queued prompts).
//! The check itself is the pa-core decision ([`AgentSession::
//! auto_compaction_due`]: the live context against the effective
//! threshold);
//! this module owns the daemon flow around it — the `compaction_start` /
//! `compaction_end` event pair with the `threshold` reason (TS
//! `_runAutoCompaction`), the worker's persist-and-broadcast contract
//! (the `Compaction` event carries the durable entry like `/compact`), and
//! the outcome shapes: the client-facing result on success, the TS skip /
//! failure messages with their severities otherwise.

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
    /// The TS `_checkCompaction` threshold arm at a turn boundary: check
    /// the live context against the reserve headroom and, when it crossed,
    /// run one compaction with the `threshold` event pair. The worker
    /// persists the durable entry and broadcasts both events exactly like
    /// the `/compact` flow (the TUI swaps in the `Auto-compacting...`
    /// loader for the start event and the durable `◆ Context compacted`
    /// row for the end).
    pub(crate) fn run_auto_compaction(
        &self,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> AutoCompactionRun {
        // TS reads `this.model?.contextWindow ?? 0` and runs the
        // summarizer on `this.model` — the session's live model. The Rust
        // equivalent is the provider target the turn stream reads; a fresh
        // startup-chain resolution can land the summarizer on a provider
        // the session never used (R8: "No AWS credentials available for
        // Bedrock" in a prime-inference session), so the arm follows the
        // target. A session without a resolvable model never crosses a
        // threshold.
        let model = match self.session_model() {
            Ok(model) => model,
            Err(_) => return AutoCompactionRun::NotDue,
        };
        let due = {
            let guard = self.session.blocking_lock();
            match guard.as_deref() {
                Some(engine) => self
                    .runtime
                    .block_on(async { engine.session.auto_compaction_due(&model).await }),
                // No built session: the live context is empty (nothing to
                // compact), matching the TS pre-turn check on a fresh
                // session whose first turn has not run yet.
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
        // TS assigns `_autoCompactionAbortController` for the run's
        // duration: an `abort_compaction` command lands in the slot and
        // cancels the in-flight summarizer.
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
            // The abort race drops the summarizer request in flight (TS
            // cancels the provider stream through the signal); the signal
            // also lands the pre-commit check inside the compaction.
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
        match &outcome {
            Ok(Ok(CompactOutcome::Ran(run))) => {
                // The post-compaction kernel notice goes out before the
                // settled end (TS `_syncKernelStateAfterCompaction` runs
                // inside `_performCompaction`): its `message_start` /
                // `message_end` pair precedes `compaction_end`.
                if let Some(message) = &run.ipython_state {
                    if !emit(EngineEvent::CustomMessage(
                        crate::session_commands::custom_message_value(message),
                    )) {
                        return AutoCompactionRun::Cancelled;
                    }
                }
                // Adoption telemetry (TS `compaction_end` handling counts
                // every completed compaction into the active run).
                {
                    let guard = self.session.blocking_lock();
                    if let Some(telemetry) = guard
                        .as_deref()
                        .and_then(|engine| engine.telemetry.as_ref())
                    {
                        telemetry.note_compaction();
                    }
                }
                // TS `_scheduleAutoRefineAfterCompaction`: the compaction
                // arms the compact-trigger review; the turn loop's
                // settled-boundary consumption services it once this
                // arm finishes.
                self.mark_compact_auto_refine_pending();
                // The wire result is the TS `CompactionResult` shape
                // (`_performCompaction`'s return, details included).
                let result = crate::compaction::compaction_result_value(&run.result, &run.entry);
                let entry = serde_json::to_value(&run.entry).unwrap_or(Value::Null);
                let event =
                    crate::compaction::compaction_end_success("threshold", &result, false, None);
                if !emit(EngineEvent::Compaction { entry, event }) {
                    return AutoCompactionRun::Cancelled;
                }
            }
            // A skip consumed the check (TS `CompactionSkippedError`): the
            // durable disclosure row goes out with its message pair, then
            // the end event carries the warning.
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
            // An abort from either layer — the race dropped the in-flight
            // summarizer request (the outer error, always the abort
            // marker), or the compaction's pre-commit signal check fired —
            // the run cancelled (TS `_runAutoCompaction`'s aborted arm,
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
            // A failed run persists the durable disclosure row and emits
            // the `compaction_end` failure (TS
            // `_endCompactionUnsuccessfully`: automatic failures carry no
            // `errorSeverity` on the wire).
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
