//! The overflow arm of the automatic compaction check: the TS
//! `_checkCompaction` Case 1, the compact-and-retry recovery for a request
//! that exceeds the context window. When a settled turn errors with a
//! provider context-overflow (or a silent/length overflow against the
//! model window), the session drops the error turn from the loop context,
//! runs one compaction, and re-issues the turn on the compacted context
//! without re-adding the user message (TS `agent.continue()`).
//!
//! One recovery attempt per overflow: the retry that still overflows ends
//! the run with the TS failure surface — the durable `compaction_outcome`
//! row plus the `compaction_end` event carrying
//! `Context overflow recovery failed after one compact-and-retry attempt.
//! Try reducing context or switching to a larger-context model.`
//! The state machine also fires before the next admitted prompt: a stale
//! overflow error from the previous run gets its recovery attempt on the
//! freshly admitted prompt (TS `_runPreTurnCompaction` runs the same arm).
//! A new prompt admission or a settled non-error turn resets the state
//! (TS resets `_overflowRecovery` at agent-run message starts and at
//! non-error assistant message ends).

use serde_json::Value;

use crate::agent_engine::AgentSessionEngine;
use crate::engine::EngineEvent;
use pa_agent::abort::AbortController;
use pa_core::session_engine::compact_session::CompactOutcome;
use pa_core::session_engine::messages::CompactionOutcomeKind;
use pa_core::session_engine::messages::CompactionOutcomeReason;
use pa_core::session_engine::provider_adapter::json_round_trip;
use pa_core::session_engine::TrailingAssistantFilter;

/// The TS failure text when one compact-and-retry attempt could not save
/// the turn (`_checkCompaction`'s reported state).
pub(crate) const OVERFLOW_RECOVERY_FAILED_MESSAGE: &str = "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";

/// One recovery attempt per overflow (TS `_overflowRecovery`): "attempted"
/// marks a compact-and-retry in flight; "reported" dedups the failure
/// notice when the retry overflows too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum OverflowRecovery {
    #[default]
    Idle,
    Attempted,
    Reported,
}

/// What the overflow arm decided for the failed turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OverflowArmRun {
    /// Not an overflow (or a guard failed): the run ends like the plain
    /// error path.
    NotApplicable,
    /// The compact-and-retry ran: the turn re-issues on the compacted
    /// context without re-adding the user message (TS `agent.continue()`).
    RetryTurn,
    /// The failure surface went out (a skipped or failed compaction, or the
    /// reported second overflow): the run ends.
    Finished,
    /// The emitter asked to stop.
    Cancelled,
}

/// The shared overflow-check body: guards, the one-attempt state machine,
/// and the compaction run. `Retry` means the turn re-issues (the post-turn
/// caller); the pre-turn caller proceeds with the admitted prompt either
/// way, so it treats `Retry` as done.
enum OverflowAttempt {
    /// No overflow arm fired.
    None,
    /// The compact-and-retry ran and succeeded.
    Retry,
    /// The run ends (skip, failed compaction, or the reported overflow).
    Finished,
    /// The emitter asked to stop.
    Cancelled,
}

impl AgentSessionEngine {
    /// Reset the overflow recovery state (TS: a message that starts an
    /// agent run — the admitted prompt — and every settled non-error
    /// assistant message reset `_overflowRecovery`).
    pub(crate) fn reset_overflow_recovery(&self) {
        *self
            .overflow_recovery
            .lock()
            .expect("overflow recovery lock") = OverflowRecovery::Idle;
    }

    /// The overflow arm at the settled-turn boundary (TS `_checkCompaction`
    /// Case 1 at `agent_end`): `assistant` is the failed turn's message.
    pub(crate) fn run_overflow_compaction(
        &self,
        assistant: &pa_agent::types::AssistantMessage,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> OverflowArmRun {
        match self.overflow_recovery_attempt(assistant, emit) {
            OverflowAttempt::None => OverflowArmRun::NotApplicable,
            OverflowAttempt::Retry => OverflowArmRun::RetryTurn,
            OverflowAttempt::Finished => OverflowArmRun::Finished,
            OverflowAttempt::Cancelled => OverflowArmRun::Cancelled,
        }
    }

    /// The overflow arm before an admitted prompt (TS `_runPreTurnCompaction`
    /// runs the same Case 1 over the last assistant message of the loop
    /// context): a stale overflow error from the previous run gets its
    /// recovery attempt here, so the new prompt runs on the compacted
    /// context. The prompt proceeds regardless of the compaction outcome
    /// (TS `resumeAfterFailure` never re-issues for overflow); returns
    /// whether the emitter stayed alive.
    pub(crate) fn run_pre_turn_overflow_compaction(
        &self,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> bool {
        let Some(assistant) = self.last_loop_assistant_message() else {
            return true;
        };
        !matches!(
            self.overflow_recovery_attempt(&assistant, emit),
            OverflowAttempt::Cancelled
        )
    }

    /// The last assistant message of the live loop context in the wire
    /// shape (TS `_findLastAssistantMessage`).
    fn last_loop_assistant_message(&self) -> Option<pa_agent::types::AssistantMessage> {
        let guard = self.session.blocking_lock();
        let engine = guard.as_deref()?;
        let wire = self
            .runtime
            .block_on(async { engine.session.last_assistant_message().await })?;
        match wire {
            pa_types::session::AgentMessage::Assistant(assistant) => json_round_trip(&assistant),
            _ => None,
        }
    }

    /// The shared Case-1 body. Guard order is the TS one: the message may
    /// not predate the latest compaction, compaction must be enabled (or a
    /// pending model request covers it), the message must come from the
    /// session's current model, and it must be a context overflow.
    fn overflow_recovery_attempt(
        &self,
        assistant: &pa_agent::types::AssistantMessage,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> OverflowAttempt {
        // TS reads `this.model?.contextWindow ?? 0`, checks `sameModel`
        // against `this.model`, and runs the compact-and-retry summarizer on
        // `this.model` — the session's live model. The Rust equivalent is
        // the provider target the turn stream reads; a fresh startup-chain
        // resolution can land the summarizer on a provider the session
        // never used (R8: "No AWS credentials available for Bedrock" in a
        // prime-inference session), so the arm follows the target. Without
        // a resolvable model no overflow check runs.
        let Ok(model) = self.session_model() else {
            return OverflowAttempt::None;
        };
        // Skip the overflow check when the message came from a different
        // model (TS `sameModel`: a model switch must not compact for the
        // old model's overflow).
        if assistant.provider != model.provider || assistant.model != model.id {
            return OverflowAttempt::None;
        }
        let Some(wire) = json_round_trip::<_, pa_types::ai::AssistantMessage>(assistant) else {
            return OverflowAttempt::None;
        };
        // Skip the check when the message predates the latest compaction
        // boundary (TS `assistantIsFromBeforeCompaction`): a stale
        // pre-compaction overflow must not retrigger.
        if self
            .session
            .blocking_lock()
            .as_deref()
            .is_some_and(|engine| {
                self.runtime
                    .block_on(engine.session.latest_compaction_timestamp())
                    .is_some_and(|timestamp| wire.timestamp <= timestamp)
            })
        {
            return OverflowAttempt::None;
        }
        // Enablement: the compaction settings gate, or a pending model
        // request (the run below consumes it and honors its instructions).
        let pending_scheduled = self
            .session
            .blocking_lock()
            .as_deref()
            .is_some_and(|engine| {
                self.runtime
                    .block_on(async { engine.turn_boundary.compaction_scheduled().await })
            });
        let enabled = self
            .session
            .blocking_lock()
            .as_deref()
            .is_some_and(|engine| engine.session.auto_compaction_enabled());
        if !enabled && !pending_scheduled {
            return OverflowAttempt::None;
        }
        if !pa_ai::is_context_overflow(&wire, Some(model.context_window)) {
            return OverflowAttempt::None;
        }
        // One recovery attempt per overflow (TS `_overflowRecovery`).
        {
            let mut recovery = self
                .overflow_recovery
                .lock()
                .expect("overflow recovery lock");
            match *recovery {
                OverflowRecovery::Idle => *recovery = OverflowRecovery::Attempted,
                OverflowRecovery::Attempted => {
                    *recovery = OverflowRecovery::Reported;
                    drop(recovery);
                    // The retry still overflows: report once (the durable
                    // outcome row plus the `compaction_end` failure, no
                    // error severity on the wire — TS passes none).
                    if !self.emit_unsuccessful_compaction(
                        CompactionOutcomeReason::Overflow,
                        CompactionOutcomeKind::Failed,
                        OVERFLOW_RECOVERY_FAILED_MESSAGE,
                        None,
                        emit,
                    ) {
                        return OverflowAttempt::Cancelled;
                    }
                    return OverflowAttempt::Finished;
                }
                OverflowRecovery::Reported => return OverflowAttempt::None,
            }
        }
        // Remove the error turn from the loop context first (TS: it stays in
        // the session history, but the retry must not re-send it).
        {
            let guard = self.session.blocking_lock();
            if let Some(engine) = guard.as_deref() {
                self.runtime.block_on(async {
                    engine
                        .session
                        .drop_trailing_assistant(TrailingAssistantFilter::Any)
                        .await;
                });
            }
        }
        // Any compaction consumes a pending model request (overflow can
        // fire first and take the request with it).
        let custom_instructions = self
            .session
            .blocking_lock()
            .as_deref()
            .and_then(|engine| {
                self.runtime
                    .block_on(async { engine.turn_boundary.take_compaction().await })
            })
            .and_then(|pending| pending.instructions);
        if !emit(EngineEvent::CompactionStart {
            event: crate::compaction::compaction_start_event(
                "overflow",
                custom_instructions.as_deref(),
            ),
        }) {
            return OverflowAttempt::Cancelled;
        }
        pa_core::session_engine::compaction_trace::trace(
            "auto.overflow_start_emitted",
            serde_json::Value::Null,
        );
        // TS `_runAutoCompaction` assigns `_autoCompactionAbortController`
        // for the overflow run too: an `abort_compaction` command lands in
        // the shared slot and cancels the in-flight summarizer.
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
                return OverflowAttempt::None;
            };
            let compact = async {
                engine
                    .session
                    .compact(
                        custom_instructions.as_deref(),
                        &model,
                        api_key,
                        Some(&signal),
                    )
                    .await
            };
            let outcome = self
                .runtime
                .block_on(pa_agent::abort::race_with_abort(compact, &signal));
            self.clear_auto_compaction_abort(&controller);
            outcome
        };
        match outcome {
            Ok(Ok(CompactOutcome::Ran(run))) => {
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
                // The post-compaction kernel notice goes out before the
                // settled end (TS `_syncKernelStateAfterCompaction` runs
                // inside `_performCompaction`): its `message_start` /
                // `message_end` pair precedes `compaction_end`.
                if let Some(message) = &run.ipython_state {
                    if !emit(EngineEvent::CustomMessage(
                        crate::session_commands::custom_message_value(message),
                    )) {
                        return OverflowAttempt::Cancelled;
                    }
                }
                // TS `_scheduleAutoRefineAfterCompaction`: the compaction
                // arms the compact-trigger review; the retried turn's
                // settled boundary services it (TS defers behind the
                // will-retry continuation).
                self.mark_compact_auto_refine_pending();
                // The wire result is the TS `CompactionResult` shape
                // (`_performCompaction`'s return, details included); the
                // end event carries `willRetry: true` (the turn re-issues).
                let result = crate::compaction::compaction_result_value(&run.result, &run.entry);
                let entry = serde_json::to_value(&run.entry).unwrap_or(Value::Null);
                let event = crate::compaction::compaction_end_success(
                    "overflow",
                    &result,
                    true,
                    custom_instructions.as_deref(),
                );
                if !emit(EngineEvent::Compaction { entry, event }) {
                    return OverflowAttempt::Cancelled;
                }
                pa_core::session_engine::compaction_trace::trace(
                    "auto.overflow_end_emitted",
                    serde_json::Value::Null,
                );
                // The compaction rebuild re-adds the error turn from the
                // kept tail: drop it again so the retried request is free
                // of it (TS will-retry branch).
                {
                    let guard = self.session.blocking_lock();
                    if let Some(engine) = guard.as_deref() {
                        self.runtime.block_on(async {
                            engine
                                .session
                                .drop_trailing_assistant(TrailingAssistantFilter::ErrorOnly)
                                .await;
                        });
                    }
                }
                OverflowAttempt::Retry
            }
            // A skipped overflow recovery does not re-issue (TS excludes
            // overflow from `resumeAfterFailure`).
            Ok(Ok(CompactOutcome::Skipped(message))) => {
                if !self.emit_unsuccessful_compaction(
                    CompactionOutcomeReason::Overflow,
                    CompactionOutcomeKind::Skipped,
                    &format!("Auto-compaction skipped: {message}"),
                    custom_instructions.as_deref(),
                    emit,
                ) {
                    return OverflowAttempt::Cancelled;
                }
                OverflowAttempt::Finished
            }
            // An abort from either layer — the race dropped the in-flight
            // summarizer request, or the compaction's pre-commit signal
            // check fired — the run cancelled (TS `_runAutoCompaction`'s
            // aborted arm, before the failure arms); the cancelled
            // recovery does not re-issue the overflowing request.
            Ok(Err(error)) | Err(error) if pa_agent::abort::is_abort_error(&error) => {
                if !self.emit_unsuccessful_compaction(
                    CompactionOutcomeReason::Overflow,
                    CompactionOutcomeKind::Cancelled,
                    "Compaction cancelled",
                    custom_instructions.as_deref(),
                    emit,
                ) {
                    return OverflowAttempt::Cancelled;
                }
                OverflowAttempt::Finished
            }
            Ok(Err(error)) | Err(error) => {
                if !self.emit_unsuccessful_compaction(
                    CompactionOutcomeReason::Overflow,
                    CompactionOutcomeKind::Failed,
                    &format!("Context overflow recovery failed: {error:#}"),
                    custom_instructions.as_deref(),
                    emit,
                ) {
                    return OverflowAttempt::Cancelled;
                }
                OverflowAttempt::Finished
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::agent_engine::tests::{admit, faux_engine_with_settings};
    use crate::agent_engine::FAUX_TEST_LOCK;
    use crate::agent_engine::{AgentEngineConfig, AgentSessionEngine};
    use crate::engine::EngineEvent;
    use crate::engine::SessionEngine;
    use serde_json::{json, Value};

    /// The TS overflow error shape: an Anthropic token-overflow message.
    /// The retry-turn entry paces the stream (`delayMs`), so its settled
    /// message timestamp lands strictly after the compaction entry's (the
    /// `assistantIsFromBeforeCompaction` guard compares millisecond
    /// timestamps; a real provider round-trip spans more than one).
    fn overflow_error(delay_ms: u64) -> Value {
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

    /// The combined input+output limit 400 (the live Prime Inference
    /// shape): no single-part context-window wording, only the combined
    /// ceiling text.
    fn combined_limit_error(delay_ms: u64) -> Value {
        let mut entry = json!({
            "text": "",
            "stopReason": "error",
            "errorMessage": "Error: 400 This model configuration accepts at most 1048576 combined input and output tokens. However, your request has 1017457 input tokens and asks for 32000 output tokens (1049457 tokens total). Please reduce the input length or requested output length and try again.",
        });
        if delay_ms > 0 {
            entry["delayMs"] = json!(delay_ms);
        }
        entry
    }

    /// One faux-driven engine over its own tempdir with explicit compaction
    /// settings (the `keepRecentTokens` cut decides whether the overflow
    /// recovery can actually compact).
    fn faux_engine_with_compaction_settings(
        script: Value,
        settings: Value,
    ) -> (AgentSessionEngine, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(agent_dir.join("settings.json"), settings.to_string()).unwrap();
        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir,
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: Some(script.to_string()),
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap();
        (engine, dir)
    }

    /// The `compaction_start` event payloads, in order.
    fn compaction_starts(events: &[EngineEvent]) -> Vec<&Value> {
        events
            .iter()
            .filter_map(|event| match event {
                EngineEvent::CompactionStart { event } => Some(event),
                _ => None,
            })
            .collect()
    }

    /// The `compaction_end` event payloads, in order.
    fn compaction_ends(events: &[EngineEvent]) -> Vec<&Value> {
        events
            .iter()
            .filter_map(|event| match event {
                EngineEvent::Compaction { event, .. } => Some(event),
                _ => None,
            })
            .collect()
    }

    /// The durable `compaction_outcome` custom rows, in order.
    fn outcome_rows(events: &[EngineEvent]) -> Vec<&Value> {
        events
            .iter()
            .filter_map(|event| match event {
                EngineEvent::CustomMessage(message) => Some(message),
                _ => None,
            })
            .filter(|message| message["customType"] == "compaction_outcome")
            .collect()
    }

    /// The settled assistant messages (the `message_end` rows), in order.
    fn assistant_messages(events: &[EngineEvent]) -> Vec<&Value> {
        events
            .iter()
            .filter_map(|event| match event {
                EngineEvent::AssistantMessage(message) => Some(message),
                _ => None,
            })
            .collect()
    }

    /// The user-message rows (the retry must not re-add one).
    fn user_messages(events: &[EngineEvent]) -> Vec<&Value> {
        events
            .iter()
            .filter_map(|event| match event {
                EngineEvent::UserMessage(message) => Some(message),
                _ => None,
            })
            .collect()
    }

    /// The `Done` outcome of one admission.
    fn done_result(events: &[EngineEvent]) -> Option<&Result<(), String>> {
        events.iter().find_map(|event| match event {
            EngineEvent::Done(result) => Some(result),
            _ => None,
        })
    }

    /// The compact-and-retry recovery (TS `_checkCompaction` Case 1): an
    /// overflow error drops the failed turn from the loop context, runs one
    /// compaction (`willRetry: true`), and re-issues the turn; when the
    /// retried turn overflows too, the run ends with the reported failure
    /// surface — the durable `compaction_outcome` row plus the
    /// `compaction_end` failure — exactly once.
    #[test]
    fn overflow_compacts_retries_once_then_reports_the_failure() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _dir) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    overflow_error(0),
                    {"text": "the summary"},
                    overflow_error(25),
                ]
            }),
            1,
        );
        let mut events: Vec<EngineEvent> = Vec::new();
        // A large seed turn, so the overflow recovery has pre-cut history
        // to summarize (the `keepRecentTokens` cut keeps ~10 tokens).
        admit(
            &engine,
            format!("seed turn {}", "x".repeat(48_000)),
            &mut events,
        );
        let overflow_events: Vec<EngineEvent> = Vec::new();
        let mut overflow_events = overflow_events;
        admit(
            &engine,
            format!("overflow probe {}", "x".repeat(48_000)),
            &mut overflow_events,
        );

        // One compact-and-retry attempt: the start carries the overflow
        // reason, before any summarizer response.
        let starts = compaction_starts(&overflow_events);
        assert_eq!(starts.len(), 1);
        assert_eq!(
            starts[0],
            &json!({ "type": "compaction_start", "reason": "overflow" })
        );
        // The retried turn's error message precedes the recovery's failure
        // surface (the reported row lands after the second overflow).
        let assistant = assistant_messages(&overflow_events);
        assert_eq!(assistant.len(), 2);
        assert_eq!(assistant[0]["stopReason"], "error");
        assert_eq!(assistant[1]["stopReason"], "error");
        let starts_at = overflow_events
            .iter()
            .position(|event| matches!(event, EngineEvent::CompactionStart { .. }))
            .unwrap();
        let second_error_at = overflow_events
            .iter()
            .rposition(|event| {
                matches!(event, EngineEvent::AssistantMessage(message)
                    if message["stopReason"] == "error")
            })
            .unwrap();
        assert!(starts_at < second_error_at);

        // The end pair: the attempt's success (willRetry true, the
        // summarizer's text), then the reported failure (no error severity
        // on the wire — TS passes none for automatic failures).
        let ends = compaction_ends(&overflow_events);
        assert_eq!(ends.len(), 2);
        assert_eq!(ends[0]["reason"], "overflow");
        assert_eq!(ends[0]["willRetry"], true);
        assert_eq!(ends[0]["result"]["summary"], "the summary");
        // The overflow result carries the TS dataKeys too: the file-op
        // `details` verbatim from the durable entry.
        assert_eq!(
            ends[0]["result"]["details"],
            json!({ "readFiles": [], "modifiedFiles": [] })
        );
        let reported = "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";
        assert_eq!(
            ends[1],
            &json!({
                "type": "compaction_end",
                "reason": "overflow",
                "aborted": false,
                "willRetry": false,
                "errorMessage": reported,
            })
        );
        // The durable failure row: one, with the TS outcome details.
        let rows = outcome_rows(&overflow_events);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["content"], reported);
        assert_eq!(rows[0]["details"]["reason"], "overflow");
        assert_eq!(rows[0]["details"]["outcome"], "failed");
        assert_eq!(rows[0]["display"], true);
        // The retry re-issued without re-adding the user message.
        assert_eq!(user_messages(&overflow_events).len(), 1);
        // The run ends with the overflow error itself.
        assert_eq!(
            done_result(&overflow_events),
            Some(&Err(
                "prompt is too long: 213462 tokens > 200000 maximum".to_string()
            ))
        );
    }

    /// The retry on the compacted context succeeds: one `willRetry: true`
    /// compaction, the recovered turn settles the run, and no failure rows
    /// appear (the success persists the durable compaction entry instead).
    #[test]
    fn overflow_retry_succeeds_on_the_compacted_context() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _dir) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    overflow_error(0),
                    {"text": "the summary"},
                    {"text": "recovered reply"},
                ]
            }),
            1,
        );
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(
            &engine,
            format!("seed turn {}", "x".repeat(48_000)),
            &mut events,
        );
        let mut probe_events: Vec<EngineEvent> = Vec::new();
        admit(
            &engine,
            format!("overflow probe {}", "x".repeat(48_000)),
            &mut probe_events,
        );

        let starts = compaction_starts(&probe_events);
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0]["reason"], "overflow");
        let ends = compaction_ends(&probe_events);
        assert_eq!(ends.len(), 1);
        assert_eq!(ends[0]["willRetry"], true);
        assert_eq!(ends[0]["result"]["summary"], "the summary");
        // The retried turn's reply is the run's settled outcome.
        let assistant = assistant_messages(&probe_events);
        assert_eq!(assistant.len(), 2);
        assert_eq!(assistant[1]["content"][0]["text"], "recovered reply");
        assert_eq!(done_result(&probe_events), Some(&Ok(())));
        assert!(outcome_rows(&probe_events).is_empty());
        // The retry re-issued without re-adding the user message.
        assert_eq!(user_messages(&probe_events).len(), 1);
    }

    /// The live combined-limit 400 classifies as overflow: the arm
    /// compacts and retries (the recovered turn settles the run) instead
    /// of surfacing the raw 400 — before the fix this text matched no
    /// overflow pattern and the error reached the user directly.
    #[test]
    fn combined_limit_overflow_compacts_and_retries() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _dir) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    combined_limit_error(0),
                    {"text": "the summary"},
                    {"text": "recovered reply"},
                ]
            }),
            1,
        );
        let mut events: Vec<EngineEvent> = Vec::new();
        // A large seed turn, so the overflow recovery has pre-cut history
        // to summarize (the `keepRecentTokens` cut keeps ~10 tokens).
        admit(
            &engine,
            format!("seed turn {}", "x".repeat(48_000)),
            &mut events,
        );
        let mut probe_events: Vec<EngineEvent> = Vec::new();
        admit(
            &engine,
            format!("overflow probe {}", "x".repeat(48_000)),
            &mut probe_events,
        );
        // The overflow arm fired: one compact-and-retry with the overflow
        // reason.
        let starts = compaction_starts(&probe_events);
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0]["reason"], "overflow");
        let ends = compaction_ends(&probe_events);
        assert_eq!(ends.len(), 1);
        assert_eq!(ends[0]["willRetry"], true);
        assert_eq!(ends[0]["result"]["summary"], "the summary");
        // The retried turn's reply is the run's settled outcome: no
        // failure rows, no surfaced raw error.
        let assistant = assistant_messages(&probe_events);
        assert_eq!(assistant.len(), 2);
        assert_eq!(assistant[1]["content"][0]["text"], "recovered reply");
        assert_eq!(done_result(&probe_events), Some(&Ok(())));
        assert!(outcome_rows(&probe_events).is_empty());
    }

    /// A skipped overflow recovery does not re-issue (TS excludes overflow
    /// from `resumeAfterFailure`): the durable `skipped` outcome row and
    /// the warning-severity `compaction_end` surface, and the run ends with
    /// the overflow error.
    #[test]
    fn overflow_recovery_skip_surfaces_the_warning_row() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // `keepRecentTokens` beyond the whole session: the cut keeps
        // everything, so the compaction has no history to summarize.
        let (engine, _dir) = faux_engine_with_compaction_settings(
            json!({ "responses": [overflow_error(0)] }),
            json!({ "compaction": { "enabled": true, "reserveTokens": 1, "keepRecentTokens": 100_000 } }),
        );
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "overflow probe".to_string(), &mut events);
        let starts = compaction_starts(&events);
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0]["reason"], "overflow");
        let skipped =
            "Auto-compaction skipped: Session is too short to compact — try again once it grows";
        let ends = compaction_ends(&events);
        assert_eq!(ends.len(), 1);
        assert_eq!(
            ends[0],
            &json!({
                "type": "compaction_end",
                "reason": "overflow",
                "aborted": false,
                "willRetry": false,
                "errorMessage": skipped,
                "errorSeverity": "warning",
            })
        );
        let rows = outcome_rows(&events);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["content"], skipped);
        assert_eq!(rows[0]["details"]["reason"], "overflow");
        assert_eq!(rows[0]["details"]["outcome"], "skipped");
        assert_eq!(
            done_result(&events),
            Some(&Err(
                "prompt is too long: 213462 tokens > 200000 maximum".to_string()
            ))
        );
    }

    /// A stale overflow error from the previous run gets its recovery
    /// attempt before the next admitted prompt (TS `_runPreTurnCompaction`
    /// runs the same Case 1): the compaction runs before the turn, and the
    /// new prompt proceeds on the compacted context.
    #[test]
    fn stale_overflow_error_recovers_before_the_next_prompt() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _dir) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    overflow_error(0),
                    {"text": "the summary"},
                    overflow_error(25),
                    {"text": "the second summary"},
                    {"text": "recovered after the stale overflow"},
                ]
            }),
            1,
        );
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(
            &engine,
            format!("seed turn {}", "x".repeat(48_000)),
            &mut events,
        );
        // The reported run: its stale overflow error stays the loop
        // context's last assistant message.
        let mut probe_events: Vec<EngineEvent> = Vec::new();
        admit(
            &engine,
            format!("overflow probe {}", "x".repeat(48_000)),
            &mut probe_events,
        );
        assert_eq!(
            done_result(&probe_events),
            Some(&Err(
                "prompt is too long: 213462 tokens > 200000 maximum".to_string()
            ))
        );
        // The next prompt's pre-turn arm recovers first (a fresh attempt:
        // the prompt admission reset the recovery state), then the turn
        // runs on the compacted context.
        let mut next_events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "next prompt".to_string(), &mut next_events);
        let starts = compaction_starts(&next_events);
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0]["reason"], "overflow");
        let ends = compaction_ends(&next_events);
        assert_eq!(ends.len(), 1);
        assert_eq!(ends[0]["willRetry"], true);
        assert_eq!(ends[0]["result"]["summary"], "the second summary");
        let compaction_at = next_events
            .iter()
            .position(|event| matches!(event, EngineEvent::CompactionStart { .. }))
            .unwrap();
        let turn_at = next_events
            .iter()
            .position(|event| {
                matches!(event, EngineEvent::AssistantMessage(message)
                    if message["content"][0]["text"] == "recovered after the stale overflow")
            })
            .unwrap();
        assert!(
            compaction_at < turn_at,
            "the pre-turn recovery compacts before the admitted turn runs"
        );
        assert_eq!(done_result(&next_events), Some(&Ok(())));
        assert_eq!(user_messages(&next_events).len(), 1);
    }

    /// A plain provider error is not an overflow: the arm never fires, the
    /// quick-retry loop owns the turn, and the run ends without compaction
    /// events.
    #[test]
    fn non_overflow_error_never_triggers_the_arm() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _dir) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "", "stopReason": "error", "errorMessage": "529 overloaded"},
                ]
            }),
            1,
        );
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "seed turn".to_string(), &mut events);
        let mut error_events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "flaky turn".to_string(), &mut error_events);
        assert!(compaction_starts(&error_events).is_empty());
        assert!(compaction_ends(&error_events).is_empty());
        assert!(outcome_rows(&error_events).is_empty());
        assert!(matches!(done_result(&error_events), Some(Err(_))));
    }

    /// The settings gate (TS `settings.enabled`): with automatic
    /// compaction disabled, an overflow error ends the run with no recovery.
    /// The aborted arm on the overflow recovery (TS `_runAutoCompaction`'s
    /// `aborted` check): an in-flight overflow summarizer cancelled by
    /// `abort_compaction` records the durable `cancelled` row with the
    /// `Compaction cancelled` disclosure, emits the aborted
    /// `compaction_end` (no error message, no re-issue — the cancelled
    /// recovery never retries the overflowing request), and commits
    /// nothing.
    #[test]
    fn overflow_recovery_aborted_mid_run_records_the_cancelled_outcome() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _dir) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    overflow_error(0),
                    // The summarizer held in flight: the abort lands while
                    // the request is open.
                    {"text": "the summary", "delayMs": 30_000},
                ]
            }),
            1,
        );
        let engine = std::sync::Arc::new(engine);
        let mut seed_events: Vec<EngineEvent> = Vec::new();
        // A large seed turn, so the overflow recovery has pre-cut history
        // to summarize (the `keepRecentTokens` cut keeps ~10 tokens).
        crate::agent_engine::tests::admit(
            &engine,
            format!("seed turn {}", "x".repeat(48_000)),
            &mut seed_events,
        );

        let events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> = Default::default();
        let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let admission = crate::agent_engine::tests::admit_parked(
            &engine,
            format!("overflow probe {}", "x".repeat(48_000)),
            std::sync::Arc::clone(&events),
            std::sync::Arc::clone(&started),
        );
        crate::agent_engine::tests::wait_for_compaction_start(&started);
        engine.abort_auto_compaction();
        admission.join().expect("the aborted admission settles");

        let events = events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let starts = compaction_starts(&events);
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0]["reason"], "overflow");
        // The cancelled outcome row and the aborted end event (TS
        // `_endCompactionUnsuccessfully`'s `{ aborted: true }`).
        crate::agent_engine::tests::assert_cancelled_end_event(
            &events,
            "overflow",
            "Compaction cancelled",
        );
        assert!(crate::agent_engine::tests::outcome_row_in_entries(&engine));
        assert!(crate::agent_engine::tests::outcome_row_in_live_context(
            &engine
        ));
        assert!(
            !crate::agent_engine::tests::compaction_entry_in_entries(&engine),
            "the aborted overflow recovery never commits"
        );
        // The cancelled recovery does not re-issue: exactly the one
        // overflow error turn settled, and the run ends with the turn's
        // original error (the failed request, not a re-issued one).
        let assistant = assistant_messages(&events);
        assert_eq!(assistant.len(), 1, "no retried turn after the cancel");
        assert_eq!(assistant[0]["stopReason"], "error");
        assert_eq!(
            done_result(&events),
            Some(&Err(
                "prompt is too long: 213462 tokens > 200000 maximum".to_string()
            ))
        );
    }

    #[test]
    fn overflow_error_with_compaction_disabled_ends_without_recovery() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _dir) = faux_engine_with_compaction_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    overflow_error(0),
                    {"text": "the summary"},
                ]
            }),
            json!({ "compaction": { "enabled": false, "reserveTokens": 1, "keepRecentTokens": 10 } }),
        );
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "seed turn".to_string(), &mut events);
        let mut probe_events: Vec<EngineEvent> = Vec::new();
        admit(
            &engine,
            format!("overflow probe {}", "x".repeat(48_000)),
            &mut probe_events,
        );
        assert!(compaction_starts(&probe_events).is_empty());
        assert!(compaction_ends(&probe_events).is_empty());
        assert!(outcome_rows(&probe_events).is_empty());
        assert_eq!(
            done_result(&probe_events),
            Some(&Err(
                "prompt is too long: 213462 tokens > 200000 maximum".to_string()
            ))
        );
    }
}
