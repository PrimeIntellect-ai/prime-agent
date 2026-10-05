//! The turn boundary (moved with its concern): the boundary run
//! (compaction + overflow arms + goal continuation), the stale
//! boundary-request drop, and the auto-compaction abort clear.
use super::{AbortController, AgentSessionEngine, BoundaryRun, EngineEvent, Value};

impl AgentSessionEngine {
    /// Clear the automatic-compaction abort slot when `controller`'s run
    /// settles (TS `_runAutoCompaction`'s `finally`: only the run that
    /// assigned the controller clears it, so a stale run cannot clear a
    /// newer run's slot).
    pub(crate) fn clear_auto_compaction_abort(&self, controller: &std::sync::Arc<AbortController>) {
        let mut slot = self
            .auto_compaction_abort
            .lock()
            .expect("auto compaction abort lock");
        if slot
            .as_ref()
            .is_some_and(|live| std::sync::Arc::ptr_eq(live, controller))
        {
            *slot = None;
        }
    }

    /// Drop pending turn-boundary requests (aborted turns; TS `_checkCompaction`
    /// abort arm clears both the compaction and the refine request).
    pub(super) fn drop_turn_boundary_requests(&self) {
        let guard = self.session.blocking_lock();
        if let Some(engine) = guard.as_deref() {
            self.runtime.block_on(engine.turn_boundary.clear_pending());
        }
    }

    /// Consume pending `compact.run`/`refine.run` requests at the settled
    /// turn boundary, in TS order (compaction, then refinement). The
    /// compaction outcome reaches the transcript like `/compact` (the
    /// worker persists the entry and broadcasts `compaction_end`); the
    /// model-facing refinement notice reaches it like the `/refine` notice
    /// row. A consumed compaction stops the run (TS: requested compaction
    /// stops the loop on purpose; the model resumes on the next prompt or
    /// queued continuation).
    pub(super) fn run_turn_boundary(
        &self,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> BoundaryRun {
        // Fast path: nothing scheduled (the common turn).
        let has_pending = {
            let guard = self.session.blocking_lock();
            match guard.as_deref() {
                Some(engine) => self.runtime.block_on(async {
                    engine.turn_boundary.compaction_scheduled().await
                        || engine.turn_boundary.refine_pending().await
                }),
                None => false,
            }
        };
        if !has_pending {
            return BoundaryRun::Proceed;
        }
        // The session's live model (the provider target the turn stream
        // reads), never a fresh startup-chain resolution (R8: a
        // re-resolution landed the summarizer on an unconfigured provider).
        let model = match self.session_model() {
            Ok(model) => model,
            Err(error) => {
                eprintln!("pa-daemon: boundary request could not resolve a model: {error:#}");
                return BoundaryRun::Proceed;
            }
        };
        let api_key = self.resolve_request_api_key(&model);
        let global_harness_dir = self.config.agent_dir.clone();
        // TS `_runAutoCompaction("requested")` emits the start event before
        // the summarizer runs (the `Agent requested compaction, compacting
        // context...` loader swap), carrying the pending instructions.
        let scheduled = {
            let guard = self.session.blocking_lock();
            match guard.as_deref() {
                Some(engine) => self
                    .runtime
                    .block_on(async { engine.turn_boundary.scheduled_compaction().await }),
                None => None,
            }
        };
        if let Some(pending) = scheduled {
            if !emit(EngineEvent::CompactionStart {
                event: crate::compaction::compaction_start_event(
                    "requested",
                    pending.instructions.as_deref(),
                ),
            }) {
                return BoundaryRun::Cancelled;
            }
        }
        // TS `_runAutoCompaction` assigns `_autoCompactionAbortController`
        // for the requested run's duration: an `abort_compaction` command
        // lands in the slot and cancels the in-flight summarizer.
        let controller = std::sync::Arc::new(AbortController::new());
        let signal = controller.signal();
        {
            *self
                .auto_compaction_abort
                .lock()
                .expect("auto compaction abort lock") = Some(std::sync::Arc::clone(&controller));
        }
        let consumption = {
            let guard = self.session.blocking_lock();
            let Some(engine) = guard.as_deref() else {
                self.clear_auto_compaction_abort(&controller);
                return BoundaryRun::Proceed;
            };
            let consumed = self.runtime.block_on(async {
                engine
                    .consume_turn_boundary_requests(
                        &model,
                        api_key,
                        global_harness_dir,
                        Some(&signal),
                    )
                    .await
            });
            self.clear_auto_compaction_abort(&controller);
            consumed
        };
        let mut stopped_for_compaction = false;
        let mut compacted = false;
        match consumption.compaction {
            Some(Ok(pa_core::session_engine::compact_session::CompactOutcome::Ran(run))) => {
                // The post-compaction kernel notice goes out before the
                // settled end (TS `_syncKernelStateAfterCompaction` runs
                // inside `_performCompaction`): its `message_start` /
                // `message_end` pair precedes `compaction_end`.
                if let Some(message) = &run.ipython_state {
                    if !emit(EngineEvent::CustomMessage(
                        crate::session_commands::custom_message_value(message),
                    )) {
                        return BoundaryRun::Cancelled;
                    }
                }
                // Adoption telemetry (TS `compaction_end` handling counts
                // every completed compaction into the active run; the
                // centrally-measured duration fires the timing stage).
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
                // arms the compact-trigger review; the run stops on
                // purpose, and the worker services the armed round off the
                // turn's settle (the review never runs before the `Done`).
                self.mark_compact_auto_refine_pending();
                let entry = serde_json::to_value(&run.entry).unwrap_or(Value::Null);
                // The wire result is the TS `CompactionResult` shape
                // (`_performCompaction`'s return, details included); the
                // event reason is `requested` (TS `_runAutoCompaction`).
                let result = crate::compaction::compaction_result_value(&run.result, &run.entry);
                let event =
                    crate::compaction::compaction_end_success("requested", &result, false, None);
                if !emit(EngineEvent::Compaction { entry, event }) {
                    return BoundaryRun::Cancelled;
                }
                stopped_for_compaction = true;
                compacted = true;
            }
            // A skip consumed the request (the Rust `/compact` contract):
            // the durable disclosure row goes out with its message pair,
            // then the end event carries the TS warning.
            Some(Ok(pa_core::session_engine::compact_session::CompactOutcome::Skipped(
                message,
            ))) => {
                eprintln!("pa-daemon: requested compaction skipped: {message}");
                if !self.emit_unsuccessful_compaction(
                    pa_core::session_engine::messages::CompactionOutcomeReason::Requested,
                    pa_core::session_engine::messages::CompactionOutcomeKind::Skipped,
                    &format!("Requested compaction skipped: {message}"),
                    None,
                    emit,
                ) {
                    return BoundaryRun::Cancelled;
                }
                stopped_for_compaction = true;
            }
            Some(Err(error)) => {
                // An aborted run is user-initiated, not a failure (TS
                // `_runAutoCompaction`'s `aborted` check before the skip and
                // failure arms): the request is consumed either way, so the
                // run stops like a completed requested compaction.
                let cancelled = pa_agent::abort::is_abort_error(&error);
                let message = if cancelled {
                    "Requested compaction cancelled".to_string()
                } else {
                    eprintln!("pa-daemon: requested compaction failed: {error:#}");
                    format!("Requested compaction failed: {error:#}")
                };
                let outcome = if cancelled {
                    pa_core::session_engine::messages::CompactionOutcomeKind::Cancelled
                } else {
                    pa_core::session_engine::messages::CompactionOutcomeKind::Failed
                };
                if !self.emit_unsuccessful_compaction(
                    pa_core::session_engine::messages::CompactionOutcomeReason::Requested,
                    outcome,
                    &message,
                    None,
                    emit,
                ) {
                    return BoundaryRun::Cancelled;
                }
                stopped_for_compaction = true;
            }
            None => {}
        }
        match consumption.refinement {
            Some(Ok(refinement)) => {
                // The model-facing notice row (durable, like the session
                // persistence of TS `refine()`).
                if refinement.applied_edits.iter().any(|edit| edit.applied) {
                    let notice = pa_core::session_engine::refine::create_refinement_notice_message(
                        &refinement,
                        pa_core::session_engine::refine::RefinementSource::SelfRefine,
                    );
                    if !emit(EngineEvent::CustomMessage(
                        crate::session_commands::custom_message_value(&notice),
                    )) {
                        return BoundaryRun::Cancelled;
                    }
                }
                if let Ok(result) = serde_json::to_value(&refinement) {
                    if !emit(EngineEvent::RefineComplete { result }) {
                        return BoundaryRun::Cancelled;
                    }
                }
            }
            Some(Err(error)) => {
                eprintln!("pa-daemon: requested refinement failed: {error:#}");
                if !emit(EngineEvent::RefineFailed {
                    error: format!("{error:#}"),
                }) {
                    return BoundaryRun::Cancelled;
                }
            }
            None => {}
        }
        if stopped_for_compaction {
            BoundaryRun::StoppedForCompaction { compacted }
        } else {
            BoundaryRun::Proceed
        }
    }
}
