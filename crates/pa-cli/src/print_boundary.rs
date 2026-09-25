//! The print runtime's turn-boundary compaction checks: the TS
//! `_checkCompaction` flow at the settled-turn boundary (`agent_end`) and
//! its pre-turn companion (`_runPreTurnCompaction`, which TS runs before
//! every admitted prompt).
//!
//! The overflow arm (Case 1) is the compact-and-retry recovery for a request
//! that exceeds the context window: a settled turn that errors with a
//! provider context-overflow drops the error turn from the loop context,
//! runs one compaction, and re-issues the turn on the compacted context
//! without re-adding the user message (TS `agent.continue()`). One attempt
//! per overflow; a retry that still overflows ends the turn with the TS
//! failure surface — the durable `compaction_outcome` row plus the
//! `compaction_end` event carrying the TS failure text. The arm also runs
//! before the next admitted prompt, so a stale overflow error left by a
//! previous run gets its recovery attempt on the resumed context.
//!
//! The pre-turn check is the full TS `_checkCompaction` call, not just the
//! overflow arm: an aborted trailing turn drops any pending
//! model-requested compaction/refinement (the `skipAbortedCheck=false`
//! pass), and when Case 1 stays silent the requested and threshold arms
//! run too — a session resumed above the reserve headroom compacts before
//! its first admitted prompt, and a pending model request consumes the
//! check. A pre-turn compaction never re-issues: the admitted prompt
//! continues the loop on the compacted context.
//!
//! Every turn the print loop issues crosses the boundary pair, not just
//! the CLI prompts: the autonomous continuation loop admits its follow-up
//! turns through [`TurnBoundary::admit_continuation`] (TS: the session
//! admits an owed continuation through its own turn loop, so the arms
//! fire on continuation turns exactly like on prompt turns — #229's
//! print flag was reconciled here; see docs/PORTING-NOTES.md).
//!
//! Output surfaces: json mode streams the TS session events (the
//! `compaction_start`/`compaction_end` pair and the outcome row's message
//! pair) on stdout; text mode stays quiet here — the durable rows surface
//! through the headless terminal result (stderr plus the exit code).

use std::path::PathBuf;

use pa_core::session_engine::compact_session::{CompactOutcome, CompactRun};
use pa_core::session_engine::engine::SessionEngine;
use pa_core::session_engine::messages::{CompactionOutcomeKind, CompactionOutcomeReason};
use pa_core::session_engine::provider_adapter::json_round_trip;
use pa_core::session_engine::provider_retry::is_context_overflow_failure;
use pa_core::session_engine::TrailingAssistantFilter;
use pa_types::ai::Model;
use pa_types::session::AgentMessage as SessionAgentMessage;
use serde_json::{json, Value};

/// The TS failure text when one compact-and-retry attempt could not save
/// the turn (`_checkCompaction`'s reported state).
const OVERFLOW_RECOVERY_FAILED_MESSAGE: &str = "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";

/// Wall-clock milliseconds (the review-cooldown stamps, TS `Date.now()`).
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// The `compaction_start` event (TS `_runAutoCompaction`): the reason plus
/// the consumed request's instructions when it carried any.
fn compaction_start_event(reason: &str, custom_instructions: Option<&str>) -> Value {
    let mut event = json!({ "type": "compaction_start", "reason": reason });
    if let Some(instructions) = custom_instructions {
        event["customInstructions"] = json!(instructions);
    }
    event
}

/// The successful `compaction_end` event (TS `_runAutoCompaction`): the TS
/// `CompactionResult` wire shape plus `willRetry` (true only for the
/// overflow compact-and-retry arm).
fn compaction_end_success_event(
    reason: &str,
    run: &CompactRun,
    will_retry: bool,
    custom_instructions: Option<&str>,
) -> Value {
    // The wire result is the TS `CompactionResult` shape: the client-facing
    // summary fields plus the persisted entry's `details` (the TS default
    // when the entry carried none).
    let result = json!({
        "summary": run.result.summary,
        "firstKeptEntryId": run.result.first_kept_entry_id,
        "tokensBefore": run.result.tokens_before,
        "details": run
            .entry
            .details
            .clone()
            .unwrap_or(json!({ "readFiles": [], "modifiedFiles": [] })),
    });
    let mut event = json!({
        "type": "compaction_end",
        "reason": reason,
        "result": result,
        "aborted": false,
        "willRetry": will_retry,
    });
    if let Some(instructions) = custom_instructions {
        event["customInstructions"] = json!(instructions);
    }
    event
}

/// One recovery attempt per overflow (TS `_overflowRecovery`): "attempted"
/// marks a compact-and-retry in flight; "reported" dedups the failure
/// notice when the retry overflows too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum OverflowRecovery {
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
enum OverflowBoundary {
    SettledTurn,
    PreTurn,
}

/// What the overflow arm decided for the settled turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OverflowOutcome {
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

/// Where the boundary's json events go: stdout in the product, a captured
/// buffer in tests.
type EventSink = std::sync::Arc<dyn Fn(&serde_json::Value) + Send + Sync>;

/// Where the compact-trigger auto-refine surfaces (TS: the serialized
/// checkpoint runs mid-run, so its events stream; the disposal drain runs
/// after the print client tore its subscription down, so its events land
/// nowhere — only the durable rows persist).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RefineSurface {
    /// The serialized checkpoint at a turn boundary (`shouldStopAfterTurn`).
    Checkpoint,
    /// The session disposal drain (TS `dispose`: best-effort, silent).
    Dispose,
}

/// The print loop's turn-boundary state: the one-attempt overflow machine,
/// the compact-trigger auto-refine machine (TS `_compactAutoRefinePending`
/// and its review bookkeeping), plus the json/text output mode the
/// surfaces depend on.
pub(crate) struct TurnBoundary {
    recovery: OverflowRecovery,
    /// TS `_compactAutoRefinePending`: a successful compaction schedules
    /// the compact-trigger auto-refine review for the next serialized
    /// checkpoint (or the disposal drain).
    compact_auto_refine_pending: bool,
    /// TS `_lastAutoRefineReviewAt` (millis): every review attempt —
    /// decline, success, or failure — stamps the cooldown window.
    last_auto_refine_review_at: Option<u64>,
    /// TS `_assistantTurnsSinceAutoRefine`: the settled non-error,
    /// non-aborted assistant turns since the run's start or the last
    /// review, the count the review prompt's trigger line carries.
    assistant_turns_since_review: u32,
    /// The entry-count baseline the turn counter diffs against (set at the
    /// first pre-turn check, so resumed history never counts — the TS
    /// counter is per-session-instance).
    entry_baseline: Option<usize>,
    /// json mode streams the TS session events on stdout; text mode reads
    /// the durable rows through the headless terminal result.
    json_mode: bool,
    sink: EventSink,
}

impl TurnBoundary {
    pub(crate) fn new(json_mode: bool) -> Self {
        Self {
            recovery: OverflowRecovery::Idle,
            compact_auto_refine_pending: false,
            last_auto_refine_review_at: None,
            assistant_turns_since_review: 0,
            entry_baseline: None,
            json_mode,
            sink: std::sync::Arc::new(|event| println!("{event}")),
        }
    }

    /// A boundary with an explicit event sink (json-mode event-capture
    /// verifiers; the product path always uses [`TurnBoundary::new`]).
    #[cfg(test)]
    pub(crate) fn with_sink(json_mode: bool, sink: EventSink) -> Self {
        Self {
            recovery: OverflowRecovery::Idle,
            compact_auto_refine_pending: false,
            last_auto_refine_review_at: None,
            assistant_turns_since_review: 0,
            entry_baseline: None,
            json_mode,
            sink,
        }
    }

    /// Reset the overflow recovery state (TS: a message that starts an
    /// agent run — the admitted prompt — and every settled non-error
    /// assistant turn reset `_overflowRecovery`).
    pub(crate) fn reset(&mut self) {
        self.recovery = OverflowRecovery::Idle;
    }

    /// The pre-turn check before an admitted prompt: the full TS
    /// `_runPreTurnCompaction` -> `_checkCompaction(lastAssistant,
    /// skipAbortedCheck=false, queueAutonomousContinuation=false)`. An
    /// aborted trailing turn first drops any pending model request (the
    /// turn that would service it never ran); then the same arm order as
    /// the settled boundary: the overflow recovery first (a stale overflow
    /// error from a previous run gets its compact-and-retry attempt here),
    /// and — only when Case 1 stayed silent — the model-requested
    /// compaction and the threshold arm (a resumed session above the
    /// reserve headroom compacts before its first admitted prompt). A
    /// pre-turn compaction never re-issues (TS
    /// `resumeAfterFailure`/`_runPreTurnCompaction` leave the loop to the
    /// admitted prompt, which continues on the compacted context). The
    /// admitted prompt resets the recovery state right after the check
    /// (TS resets at the agent run's message start).
    pub(crate) async fn run_pre_turn(
        &mut self,
        engine: &SessionEngine,
        model: &Model,
        api_key: Option<String>,
    ) -> Result<(), String> {
        // TS abort arm (skipAbortedCheck=false): an aborted trailing
        // assistant drops any pending model-requested compaction and
        // refinement — the turn that would service them never ran, and a
        // stale request must not leak into the admitted turn. The check
        // then continues to the later arms (the pre-prompt path never
        // returns early).
        if matches!(
            engine.session.last_assistant_message().await,
            Some(SessionAgentMessage::Assistant(wire))
                if wire.stop_reason == pa_types::ai::StopReason::Aborted
        ) {
            engine.turn_boundary.clear_pending().await;
        }
        // Case 1 (overflow): when it fires, TS returns from the check and
        // the requested/threshold arms never run in the same pass (the
        // overflow run itself consumes a pending model request).
        let outcome = self
            .overflow_recovery_attempt(engine, model, api_key.clone(), OverflowBoundary::PreTurn)
            .await?;
        // The auto-refine turn counter's baseline: the entries present
        // when the first prompt of this run admits (the TS counter is
        // per-session-instance, so resumed history never counts).
        if self.entry_baseline.is_none() {
            self.entry_baseline = Some(engine.session.entries().await.len());
        }
        if matches!(outcome, OverflowOutcome::NotApplicable) {
            self.requested_and_threshold_arms(engine, model, api_key)
                .await?;
        }
        self.reset();
        Ok(())
    }

    /// The settled-turn boundary (TS `agent_end`): the serialized
    /// checkpoint's compact-trigger auto-refine consumption for a trigger
    /// an earlier boundary scheduled, then the overflow arm with its retry
    /// loop (a retry's newly settled turn drains its own trigger at the
    /// TS `shouldStopAfterTurn` position, before the arm re-checks), then
    /// — when the arm did not fire — the model-requested compaction and
    /// the threshold arm (the order TS keeps inside `_checkCompaction`: a
    /// requested run consumes the check, so the threshold is not
    /// re-evaluated after it), then the requested refinement (TS
    /// `_consumePendingRequestedRefine`, which runs whenever the turn did
    /// not re-issue). A compaction that runs here and has no further turn
    /// leaves its trigger to the disposal drain.
    pub(crate) async fn run_at_settled_turn(
        &mut self,
        engine: &SessionEngine,
        model: &Model,
        api_key: Option<String>,
        global_harness_dir: PathBuf,
    ) -> Result<(), String> {
        self.count_settled_turns(engine).await;
        self.consume_compact_auto_refine(
            engine,
            model,
            api_key.clone(),
            global_harness_dir.clone(),
            RefineSurface::Checkpoint,
        )
        .await?;
        let arm_finished = loop {
            let outcome = self
                .overflow_recovery_attempt(
                    engine,
                    model,
                    api_key.clone(),
                    OverflowBoundary::SettledTurn,
                )
                .await?;
            if let OverflowOutcome::RetryTurn = outcome {
                // The retried turn settled: its serialized checkpoint
                // drains the trigger the overflow compaction scheduled
                // before the arm re-checks the new turn.
                self.consume_compact_auto_refine(
                    engine,
                    model,
                    api_key.clone(),
                    global_harness_dir.clone(),
                    RefineSurface::Checkpoint,
                )
                .await?;
            } else {
                break matches!(outcome, OverflowOutcome::Finished);
            }
        };
        if !arm_finished {
            self.requested_and_threshold_arms(engine, model, api_key.clone())
                .await?;
        }
        // The requested refinement runs whenever the turn did not re-issue
        // (a retried turn consumes it at its own boundary). TS emits the
        // durable rows' message pairs plus `refine_complete` on success and
        // `refine_failed` on failure; text mode keeps the stderr diagnostic.
        let entries_before = engine.session.entries().await.len();
        if let Some(outcome) = engine
            .consume_pending_refinement(model, api_key, global_harness_dir)
            .await
        {
            self.stream_refinement_outcome(engine, &outcome, entries_before, true, "requested")
                .await;
        }
        Ok(())
    }

    /// Admit one autonomous continuation turn through the same boundary
    /// pair the CLI prompts run (TS: the session admits an owed
    /// continuation through `_createPreparedTurnAction("followUp", ...)`,
    /// so it crosses `_prepareForCommit` -> `_runPreTurnCompaction` before
    /// the prompt and the `agent_end` checks after it — the arms are part
    /// of the session loop, not the CLI prompt loop). The `followUp`
    /// streaming behavior and the queue-if-busy admission match the
    /// autonomous driver seam the print loop calls.
    pub(crate) async fn admit_continuation(
        &mut self,
        engine: &SessionEngine,
        model: &Model,
        api_key: Option<String>,
        prompt: &str,
        global_harness_dir: PathBuf,
    ) -> Result<(), String> {
        self.run_pre_turn(engine, model, api_key.clone()).await?;
        engine
            .session
            .prompt(
                prompt,
                pa_core::session_engine::PromptOptions {
                    streaming_behavior: Some(pa_core::session_engine::StreamingBehavior::FollowUp),
                    queue_if_busy: true,
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| format!("{error:#}"))?;
        engine.session.agent().wait_for_idle().await;
        self.run_at_settled_turn(engine, model, api_key, global_harness_dir)
            .await
    }

    /// TS `_assistantTurnsSinceAutoRefine` (the `message_end` increments): the
    /// settled non-error, non-aborted assistant turns appended since the
    /// last boundary call, added to the counter the review prompt's trigger
    /// line carries.
    async fn count_settled_turns(&mut self, engine: &SessionEngine) {
        let Some(baseline) = self.entry_baseline else {
            return;
        };
        let entries = engine.session.entries().await;
        let settled = entries
            .iter()
            .skip(baseline)
            .filter(|entry| {
                matches!(
                    entry,
                    pa_types::session::FileEntry::Message {
                        message: SessionAgentMessage::Assistant(assistant),
                        ..
                    } if assistant.stop_reason != pa_types::ai::StopReason::Error
                        && assistant.stop_reason != pa_types::ai::StopReason::Aborted
                )
            })
            .count();
        self.assistant_turns_since_review += settled as u32;
        self.entry_baseline = Some(entries.len());
    }

    /// The disposal drain (TS `dispose`: "a serialized compaction can finish
    /// without another model turn — drain its pending review here so
    /// disposal does not silently lose the trigger"). The print client's
    /// event subscription is already torn down at this point, so the
    /// round's surface stays off the stream: only the durable rows and
    /// the harness state persist. Best-effort, like the TS drain.
    pub(crate) async fn drain_compact_auto_refine_at_disposal(
        &mut self,
        engine: &SessionEngine,
        model: &Model,
        api_key: Option<String>,
        global_harness_dir: PathBuf,
    ) {
        let _ = self
            .consume_compact_auto_refine(
                engine,
                model,
                api_key,
                global_harness_dir,
                RefineSurface::Dispose,
            )
            .await;
    }

    /// The compact-trigger auto-refine consumption (TS
    /// `_runSerializedRefineCheckpointAfterBackground`'s compact arm plus
    /// `_runSerializedAutoRefineReview`): gates first — the session's
    /// refine surface, the `enabled`/`compact` settings, and the review
    /// cooldown — then the review, and only an approving review runs the
    /// refinement. The checkpoint surface preserves the trigger while the
    /// cooldown runs (TS keeps it for a later boundary); the disposal
    /// surface clears it. Every review attempt — decline, success, or
    /// failure — stamps the cooldown and resets the turn counter.
    async fn consume_compact_auto_refine(
        &mut self,
        engine: &SessionEngine,
        model: &Model,
        api_key: Option<String>,
        global_harness_dir: PathBuf,
        surface: RefineSurface,
    ) -> Result<(), String> {
        if !self.compact_auto_refine_pending {
            return Ok(());
        }
        // TS `_autoRefineAllowedForSession`: sessions without the refine
        // surface drop the trigger outright.
        if !engine.session.auto_refine_allowed() {
            self.compact_auto_refine_pending = false;
            return Ok(());
        }
        let gates = engine.session.auto_refine_gates();
        if !gates.enabled || !gates.compact {
            self.compact_auto_refine_pending = false;
            return Ok(());
        }
        let under_cooldown = self
            .last_auto_refine_review_at
            .is_some_and(|last| now_millis().saturating_sub(last) < gates.cooldown_ms);
        if under_cooldown && surface == RefineSurface::Checkpoint {
            // Preserve the compact trigger for a later boundary (TS keeps
            // the pending flag while the cooldown is active).
            return Ok(());
        }
        self.compact_auto_refine_pending = false;
        if under_cooldown {
            // The disposal drain clears a cooled-down trigger without a
            // review (TS dispose).
            return Ok(());
        }
        let entries_before = engine.session.entries().await.len();
        let turns = self.assistant_turns_since_review;
        let outcome = engine
            .session
            .auto_refine_after_compaction(model, api_key, global_harness_dir, turns)
            .await;
        // Every review attempt stamps the cooldown and resets the turn
        // counter (TS stamps decline, success, and failure alike).
        self.last_auto_refine_review_at = Some(now_millis());
        self.assistant_turns_since_review = 0;
        // The reviewer declined: no refinement, nothing surfaces.
        let streamed = match outcome {
            Ok(None) => return Ok(()),
            Ok(Some(result)) => Ok(result),
            Err(error) => Err(error),
        };
        self.stream_refinement_outcome(
            engine,
            &streamed,
            entries_before,
            surface == RefineSurface::Checkpoint,
            "automatic",
        )
        .await;
        Ok(())
    }

    /// One refinement outcome's TS surface: the durable rows' message
    /// pairs plus `refine_complete` on success, the `refine_failed` event
    /// on failure. `emit` false (the disposal drain) keeps the stream
    /// quiet — the rows still persist. Text mode prints the failure's
    /// stderr diagnostic.
    async fn stream_refinement_outcome(
        &self,
        engine: &SessionEngine,
        outcome: &anyhow::Result<pa_core::refinement::RefinementResult>,
        entries_before: usize,
        emit: bool,
        kind: &str,
    ) {
        match outcome {
            Ok(result) => {
                if emit && self.json_mode {
                    // The refinement rows this run appended (TS
                    // `_appendDurableRefineMessage`: the outcome row always,
                    // the model-facing notice when edits applied).
                    for row in Self::refinement_rows_since(engine, entries_before).await {
                        let value = crate::headless_autonomous::custom_row_wire_value(&row);
                        for event_type in ["message_start", "message_end"] {
                            (self.sink)(&json!({ "type": event_type, "message": value }));
                        }
                    }
                    self.emit_json(json!({
                        "type": "refine_complete",
                        "result": serde_json::to_value(result)
                            .unwrap_or(serde_json::Value::Null),
                    }));
                }
            }
            Err(error) => {
                if emit {
                    if self.json_mode {
                        self.emit_json(json!({
                            "type": "refine_failed",
                            "error": format!("{error}"),
                        }));
                    } else {
                        eprintln!("pa-cli: {kind} refinement failed: {error:#}");
                    }
                }
            }
        }
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
    async fn requested_and_threshold_arms(
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

    /// The durable refinement rows appended after an entry count (the
    /// outcome row, then the model-facing notice when edits applied; both
    /// land in that order, so the tail scan reads them in TS emission
    /// order).
    pub(crate) async fn refinement_rows_since(
        engine: &SessionEngine,
        entries_before: usize,
    ) -> Vec<pa_types::session::CustomMessage> {
        engine
            .session
            .entries()
            .await
            .into_iter()
            .skip(entries_before)
            .filter_map(|entry| match entry {
                pa_types::session::FileEntry::CustomMessage { payload, base }
                    if payload.custom_type
                        == pa_core::session_engine::refine::REFINEMENT_OUTCOME_CUSTOM_TYPE
                        || payload.custom_type
                            == pa_core::session_engine::refine::REFINEMENT_NOTICE_CUSTOM_TYPE =>
                {
                    Some(pa_types::session::CustomMessage {
                        custom_type: payload.custom_type.clone(),
                        content: payload.content.clone(),
                        display: payload.display,
                        details: payload.details.clone(),
                        timestamp: base
                            .timestamp
                            .as_deref()
                            .map(pa_core::session::timestamp_to_millis)
                            .unwrap_or_default(),
                        rest: payload.rest,
                    })
                }
                _ => None,
            })
            .collect()
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
    async fn overflow_recovery_attempt(
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

    /// The post-compaction kernel notice (TS
    /// `_syncKernelStateAfterCompaction` runs inside `_performCompaction`):
    /// json mode streams its `message_start`/`message_end` pair before the
    /// `compaction_end` event, exactly like the TS session's `_emit` pair;
    /// text mode keeps the row as durable bookkeeping (`display: false`).
    fn emit_ipython_state_row(&self, run: &CompactRun) {
        if !self.json_mode {
            return;
        }
        let Some(row) = &run.ipython_state else {
            return;
        };
        let value = crate::headless_autonomous::custom_row_wire_value(row);
        for event_type in ["message_start", "message_end"] {
            (self.sink)(&json!({ "type": event_type, "message": value }));
        }
    }

    /// The unsuccessful-compaction surface (TS `_endCompactionUnsuccessfully`
    /// -> `_persistCompactionOutcome`): record the durable
    /// `compaction_outcome` row (json mode also broadcasts its
    /// `message_start`/`message_end` pair on the event stream, exactly like
    /// the TS session's row push), then emit the `compaction_end` event. A
    /// skip carries `errorSeverity: "warning"`; automatic failures carry no
    /// `errorSeverity` (TS passes none). The text-mode surface rides the
    /// durable rows through the headless terminal result.
    async fn end_unsuccessfully(
        &self,
        engine: &SessionEngine,
        reason: CompactionOutcomeReason,
        outcome: CompactionOutcomeKind,
        message: &str,
        custom_instructions: Option<&str>,
    ) {
        let row = engine
            .session
            .record_compaction_outcome(reason, outcome, message)
            .await;
        // A failed durable row skips only the row events; the terminal
        // `compaction_end` below still fires so a streamed
        // `compaction_start` never stays pending.
        match row {
            Ok(row) => {
                if self.json_mode {
                    let value = crate::headless_autonomous::custom_row_wire_value(&row);
                    for event_type in ["message_start", "message_end"] {
                        (self.sink)(&json!({ "type": event_type, "message": value }));
                    }
                }
            }
            Err(error) => {
                self.emit_json(json!({ "type": "error", "message": error.to_string() }));
            }
        }
        let mut event = json!({
            "type": "compaction_end",
            "reason": reason.wire(),
            "aborted": false,
            "willRetry": false,
            "errorMessage": message,
        });
        if outcome == CompactionOutcomeKind::Skipped {
            event["errorSeverity"] = json!("warning");
        }
        if let Some(instructions) = custom_instructions {
            event["customInstructions"] = json!(instructions);
        }
        self.emit_json(event);
    }

    /// Stream one session event in json mode (text mode stays quiet here).
    fn emit_json(&self, event: Value) {
        if self.json_mode {
            (self.sink)(&event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_core::session::manager::SessionManager;
    use pa_core::session_engine::engine::{create_session, SessionEngineConfig};
    use pa_types::session::FileEntry;
    use serde_json::json;

    /// The faux model's per-request output budget (maxTokens `16_384` under the
    /// `32_000` request cap): threshold fixtures subtract it from the window
    /// alongside the headroom (the combined input+output ceiling).
    const FAUX_REQUEST_BUDGET: u64 = 16_384;

    /// The faux provider registers process-globally; one test at a time
    /// keeps the queued responses deterministic. Async-aware: the guard
    /// spans the whole await-driven test body.
    static FAUX_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

    /// The faux error text as it surfaces on the settled message.
    const OVERFLOW_ERROR: &str = "prompt is too long: 213462 tokens > 200000 maximum";

    /// The compactable compaction settings (the `keepRecentTokens` cut
    /// keeps ~10 tokens, so an overflow recovery with pre-cut history
    /// summarizes it).
    fn compactable_settings() -> Value {
        json!({ "compaction": { "enabled": true, "reserveTokens": 1, "keepRecentTokens": 10 } })
    }

    /// One faux-driven engine over its own tempdir with explicit compaction
    /// settings, optionally resuming a persisted session file (the
    /// `--continue` shape).
    async fn faux_engine_with_settings(
        script: Value,
        settings: Value,
        session_manager: Option<SessionManager>,
    ) -> (SessionEngine, tempfile::TempDir, Model) {
        faux_engine_with_telemetry(script, settings, session_manager, None).await
    }

    /// The same faux engine with session telemetry wired to a mock sink
    /// (batch-per-event flush, like the pa-core telemetry fixture): the
    /// arm tests read the run counters straight off the recorded events.
    async fn faux_engine_with_mock_telemetry(
        script: Value,
        settings: Value,
    ) -> (
        SessionEngine,
        tempfile::TempDir,
        Model,
        std::sync::Arc<pa_telemetry::MockSink>,
    ) {
        let mock = std::sync::Arc::new(pa_telemetry::MockSink::new());
        let mut config = pa_telemetry::TelemetryClientConfig::new("install-1");
        config.batch_size = 1;
        config.flush_interval = std::time::Duration::from_mins(10);
        config.sinks = vec![mock.clone() as std::sync::Arc<dyn pa_telemetry::TelemetrySink>];
        let client = pa_telemetry::TelemetryClient::spawn(config).expect("spawn client");
        let telemetry = pa_core::session_engine::telemetry::TelemetryWiring {
            client,
            execution_mode: Some("print".to_string()),
            now: None,
        };
        let (engine, dir, model) =
            faux_engine_with_telemetry(script, settings, None, Some(telemetry)).await;
        (engine, dir, model, mock)
    }

    /// The engine builder both faux helpers share.
    async fn faux_engine_with_telemetry(
        script: Value,
        settings: Value,
        session_manager: Option<SessionManager>,
        telemetry: Option<pa_core::session_engine::telemetry::TelemetryWiring>,
    ) -> (SessionEngine, tempfile::TempDir, Model) {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(agent_dir.join("settings.json"), settings.to_string()).unwrap();
        let parsed = pa_ai::faux::script::parse_faux_script(&script).unwrap();
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                models: Some(vec![parsed.model]),
                ..Default::default()
            });
        registration.set_responses(parsed.responses);
        let model = registration.get_model();
        let stream_fn =
            pa_core::session_engine::provider_adapter::real_stream_fn(None, model.clone());
        let agent_model: pa_agent::types::Model =
            json_round_trip(&model).expect("the faux model crosses the loop boundary");
        let session_manager = session_manager
            .or_else(|| {
                Some(SessionManager::persisted(
                    dir.path(),
                    &dir.path().join("sessions"),
                ))
            })
            .expect("a session manager");
        let engine = create_session(SessionEngineConfig {
            cron_store: None,
            steering_mode: None,
            follow_up_mode: None,
            telemetry,
            cwd: dir.path().to_path_buf(),
            agent_dir,
            mcp_manager: None,
            model: Some(agent_model),
            thinking_level: None,
            stream_fn: Some(stream_fn),
            tools: Vec::new(),
            custom_system_prompt: None,
            prompt_guidelines: Vec::new(),
            generic_mcp_servers: Vec::new(),
            allow_recursion: None,
            session_manager: Some(session_manager),
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
            queued_steering_probe: None,
        })
        .await
        .expect("the faux session assembles");
        (engine, dir, model)
    }

    /// Finalize the open run, emit the session totals, and flush the mock
    /// sink (TS session dispose). Idempotent: a second call is a no-op.
    async fn end_telemetry(engine: &SessionEngine) {
        engine
            .telemetry
            .as_ref()
            .expect("the faux engine has telemetry installed")
            .end()
            .await
            .expect("telemetry end flushes");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    /// One named event's recorded properties from the mock sink.
    fn mock_properties(mock: &std::sync::Arc<pa_telemetry::MockSink>, name: &str) -> Vec<Value> {
        mock.events()
            .iter()
            .filter(|event| event.name == name)
            .map(|event| serde_json::to_value(&event.properties).expect("properties serialize"))
            .collect()
    }

    /// Admit one prompt through the production flow: the pre-turn check,
    /// the prompt, and the settled-turn boundary.
    async fn admit(
        boundary: &mut TurnBoundary,
        engine: &SessionEngine,
        model: &Model,
        prompt: String,
    ) -> Result<(), String> {
        admit_with_harness_dir(boundary, engine, model, prompt, std::path::PathBuf::new()).await
    }

    async fn admit_with_harness_dir(
        boundary: &mut TurnBoundary,
        engine: &SessionEngine,
        model: &Model,
        prompt: String,
        global_harness_dir: std::path::PathBuf,
    ) -> Result<(), String> {
        boundary.run_pre_turn(engine, model, None).await?;
        engine
            .session
            .prompt(&prompt, pa_core::session_engine::PromptOptions::default())
            .await
            .expect("the prompt admits");
        engine.session.agent().wait_for_idle().await;
        boundary
            .run_at_settled_turn(engine, model, None, global_harness_dir)
            .await
    }

    /// The mid-turn-request shape: a `compact.run` scheduled DURING a turn
    /// is consumed at that same turn's settled boundary (TS `compact.run`
    /// refuses to schedule on an idle session, so a pending request never
    /// survives to a pre-turn check in the product flow). No `run_pre_turn`
    /// precedes the prompt — the schedule happened after the turn's
    /// admission, mid-turn.
    async fn admit_turn_with_scheduled_request(
        boundary: &mut TurnBoundary,
        engine: &SessionEngine,
        model: &Model,
        prompt: String,
    ) -> Result<(), String> {
        engine
            .session
            .prompt(&prompt, pa_core::session_engine::PromptOptions::default())
            .await
            .expect("the prompt admits");
        engine.session.agent().wait_for_idle().await;
        boundary
            .run_at_settled_turn(engine, model, None, std::path::PathBuf::new())
            .await
    }

    /// The durable `compaction_outcome` rows, in order.
    async fn outcome_rows(engine: &SessionEngine) -> Vec<pa_types::session::CustomMessageEntry> {
        engine
            .session
            .entries()
            .await
            .iter()
            .filter_map(|entry| match entry {
                FileEntry::CustomMessage { payload, .. }
                    if payload.custom_type == "compaction_outcome" =>
                {
                    Some(payload.clone())
                }
                _ => None,
            })
            .collect()
    }

    /// The number of persisted compaction entries.
    async fn compaction_count(engine: &SessionEngine) -> usize {
        engine
            .session
            .entries()
            .await
            .iter()
            .filter(|entry| matches!(entry, FileEntry::Compaction { .. }))
            .count()
    }

    /// The persisted user messages (the retry must not re-add one).
    async fn user_texts(engine: &SessionEngine) -> Vec<String> {
        engine
            .session
            .entries()
            .await
            .iter()
            .filter_map(|entry| match entry {
                FileEntry::Message {
                    message: SessionAgentMessage::User(user),
                    ..
                } => Some(user.content.text()),
                _ => None,
            })
            .collect()
    }

    /// The last assistant message of the live loop context, if any.
    async fn last_assistant(engine: &SessionEngine) -> Option<pa_types::ai::AssistantMessage> {
        if let SessionAgentMessage::Assistant(assistant) =
            engine.session.last_assistant_message().await?
        {
            return Some(assistant);
        }
        None
    }

    /// The compact-and-retry recovery (TS `_checkCompaction` Case 1): an
    /// overflow error drops the failed turn from the loop context, runs one
    /// compaction, and re-issues the turn; when the retried turn overflows
    /// too, the turn ends with the reported failure surface — the durable
    /// `compaction_outcome` row with the TS failure text, exactly once.
    #[tokio::test]
    async fn overflow_compacts_retries_once_then_reports_the_failure() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    overflow_error(0),
                    {"text": "the summary"},
                    overflow_error(25),
                ]
            }),
            compactable_settings(),
            None,
        )
        .await;
        let mut boundary = TurnBoundary::new(false);
        // A large seed turn, so the overflow recovery has pre-cut history
        // to summarize (the `keepRecentTokens` cut keeps ~10 tokens).
        admit(
            &mut boundary,
            &engine,
            &model,
            format!("seed turn {}", "x".repeat(48_000)),
        )
        .await
        .unwrap();
        admit(
            &mut boundary,
            &engine,
            &model,
            format!("overflow probe {}", "x".repeat(48_000)),
        )
        .await
        .unwrap();

        // One compact-and-retry attempt: the durable compaction entry
        // landed, and the reported failure row is the only outcome row.
        assert_eq!(compaction_count(&engine).await, 1);
        let rows = outcome_rows(&engine).await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].content.text(), OVERFLOW_RECOVERY_FAILED_MESSAGE);
        assert_eq!(
            rows[0].details,
            Some(json!({ "reason": "overflow", "outcome": "failed" }))
        );
        // The retried turn settled after the compaction (the serve-time
        // pacing puts its timestamp past the compaction boundary), and the
        // live context ends with the second overflow error — the surface
        // the headless terminal result reads (the row trails it).
        let last = last_assistant(&engine).await.expect("a settled error turn");
        assert_eq!(last.stop_reason, pa_types::ai::StopReason::Error);
        assert_eq!(last.error_message.as_deref(), Some(OVERFLOW_ERROR));
        // The retry re-issued without re-adding the user message.
        assert_eq!(user_texts(&engine).await.len(), 2);
    }

    /// The retry on the compacted context succeeds: one compaction entry,
    /// no failure rows, and the recovered turn is the settled outcome.
    #[tokio::test]
    async fn overflow_retry_succeeds_on_the_compacted_context() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    overflow_error(0),
                    {"text": "the summary"},
                    {"text": "recovered reply"},
                ]
            }),
            compactable_settings(),
            None,
        )
        .await;
        let mut boundary = TurnBoundary::new(false);
        admit(
            &mut boundary,
            &engine,
            &model,
            format!("seed turn {}", "x".repeat(48_000)),
        )
        .await
        .unwrap();
        admit(
            &mut boundary,
            &engine,
            &model,
            format!("overflow probe {}", "x".repeat(48_000)),
        )
        .await
        .unwrap();

        assert_eq!(compaction_count(&engine).await, 1);
        assert!(outcome_rows(&engine).await.is_empty());
        let last = last_assistant(&engine).await.expect("a settled turn");
        let text = last
            .content
            .iter()
            .filter_map(|block| match block {
                pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            })
            .collect::<String>();
        assert_eq!(text, "recovered reply");
        assert_eq!(last.stop_reason, pa_types::ai::StopReason::Stop);
        assert_eq!(user_texts(&engine).await.len(), 2);
    }

    /// A skipped overflow recovery does not re-issue (TS excludes overflow
    /// from `resumeAfterFailure`): the durable `skipped` outcome row
    /// surfaces, the error turn is gone from the loop context (the next
    /// prompt's pre-turn check sees the prior non-error turn, exactly like
    /// the TS drop), and the next prompt proceeds without another
    /// compaction.
    #[tokio::test]
    async fn overflow_recovery_skip_surfaces_the_warning_row() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        // `keepRecentTokens` beyond the whole session: the cut keeps
        // everything, so the compaction has no history to summarize.
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    overflow_error(0),
                    {"text": "next reply"},
                ]
            }),
            json!({
                "compaction": {
                    "enabled": true, "reserveTokens": 1, "keepRecentTokens": 100_000
                }
            }),
            None,
        )
        .await;
        let mut boundary = TurnBoundary::new(false);
        admit(&mut boundary, &engine, &model, "seed turn".to_string())
            .await
            .unwrap();
        admit(&mut boundary, &engine, &model, "overflow probe".to_string())
            .await
            .unwrap();

        let rows = outcome_rows(&engine).await;
        assert_eq!(rows.len(), 1);
        let skipped =
            "Auto-compaction skipped: Session is too short to compact — try again once it grows";
        assert_eq!(rows[0].content.text(), skipped);
        assert_eq!(
            rows[0].details,
            Some(json!({ "reason": "overflow", "outcome": "skipped" }))
        );
        assert_eq!(compaction_count(&engine).await, 0, "nothing committed");
        // The skipped recovery dropped the error turn: the next prompt's
        // pre-turn check finds the prior settled turn and no-ops, so the
        // prompt runs with no second compaction.
        admit(&mut boundary, &engine, &model, "next prompt".to_string())
            .await
            .unwrap();
        assert_eq!(compaction_count(&engine).await, 0);
        assert_eq!(outcome_rows(&engine).await.len(), 1);
        let last = last_assistant(&engine).await.expect("a settled turn");
        assert_eq!(last.stop_reason, pa_types::ai::StopReason::Stop);
        assert_eq!(
            user_texts(&engine).await,
            ["seed turn", "overflow probe", "next prompt"]
                .map(str::to_string)
                .to_vec()
        );
    }

    /// A stale overflow error from a previous run gets its recovery attempt
    /// before the next admitted prompt (TS `_runPreTurnCompaction` runs the
    /// same Case 1): the resumed session compacts first, then the prompt
    /// runs on the compacted context — the flow a `--continue` print run
    /// exhibits, verified against the TS binary.
    #[tokio::test]
    async fn stale_overflow_error_recovers_before_the_next_prompt_after_a_resume() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        // Run one: compaction disabled, the probe overflows, and the error
        // turn stays in the persisted context with no recovery attempt.
        let (engine_a, dir_a, model_a) = faux_engine_with_settings(
            json!({ "responses": [{"text": "seed reply"}, overflow_error(0)] }),
            json!({
                "compaction": { "enabled": false, "reserveTokens": 1, "keepRecentTokens": 10 }
            }),
            None,
        )
        .await;
        let mut boundary = TurnBoundary::new(false);
        admit(
            &mut boundary,
            &engine_a,
            &model_a,
            format!("seed turn {}", "x".repeat(48_000)),
        )
        .await
        .unwrap();
        admit(
            &mut boundary,
            &engine_a,
            &model_a,
            format!("overflow probe {}", "x".repeat(48_000)),
        )
        .await
        .unwrap();
        assert_eq!(compaction_count(&engine_a).await, 0);
        assert!(outcome_rows(&engine_a).await.is_empty());

        // Run two: a fresh boundary over the persisted session (the
        // `--continue` shape) with compaction enabled — the pre-turn arm
        // recovers before the admitted prompt. The faux queue carries the
        // remaining responses (the summarizer, then the recovered turn).
        let session_file = dir_a
            .path()
            .join("sessions")
            .read_dir()
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.extension().and_then(|extension| extension.to_str()) == Some("jsonl"))
            .expect("the run-one session file");
        let resumed =
            SessionManager::open(dir_a.path(), &dir_a.path().join("sessions"), &session_file);
        let (engine_b, _dir_b, model_b) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "the stale recovery summary"},
                    {"text": "recovered after the resume"},
                ]
            }),
            compactable_settings(),
            Some(resumed),
        )
        .await;
        let mut boundary = TurnBoundary::new(false);
        boundary
            .run_pre_turn(&engine_b, &model_b, None)
            .await
            .unwrap();
        assert_eq!(
            compaction_count(&engine_b).await,
            1,
            "the pre-turn arm compacted the stale overflow"
        );
        assert!(outcome_rows(&engine_b).await.is_empty());
        // The stale error turn left the loop context: the admitted prompt
        // runs on the compacted context.
        let stale = last_assistant(&engine_b).await;
        assert!(
            !matches!(
                &stale,
                Some(message) if message.stop_reason == pa_types::ai::StopReason::Error
            ),
            "the stale overflow error is gone from the context"
        );
        admit(
            &mut boundary,
            &engine_b,
            &model_b,
            "next prompt".to_string(),
        )
        .await
        .unwrap();
        let last = last_assistant(&engine_b).await.expect("a settled turn");
        assert_eq!(last.stop_reason, pa_types::ai::StopReason::Stop);
        assert_eq!(user_texts(&engine_b).await.len(), 3);
    }

    /// The in-run autonomous continuation loop (the composed
    /// natural-turn-end hook) still crosses the boundary arms where TS
    /// runs them inside the loop: a continuation turn that overflows gets
    /// its compact-and-retry at the settled boundary — the run ends on the
    /// error turn, the boundary recovers it (the #229 reconciliation
    /// under the in-run shape). The limit stop writes no row: the durable
    /// store carries no `autonomous_status` stop entry, and the headless
    /// exit contract carries the stop.
    #[tokio::test]
    async fn autonomous_continuation_turns_cross_the_boundary_arms() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        let (built, dir, model) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    overflow_error(0),
                    {"text": "the summary"},
                    {"text": "recovered reply"},
                ]
            }),
            compactable_settings(),
            None,
        )
        .await;
        let engine = std::sync::Arc::new(built);
        let mut boundary = TurnBoundary::new(false);
        // The autonomous run (one continuation, no gates) with its
        // accounting and the composed in-run hook wired: the settled seed
        // turn mints the continuation inside the same agent run.
        let run = std::sync::Arc::new(crate::headless_autonomous::HeadlessAutonomous::from_cli(
            &crate::args::AutonomousConfig {
                max_continuations: Some(1),
                ..Default::default()
            },
            dir.path(),
        ));
        let _accounting = run.wire_accounting(engine.session.agent()).await;
        let goal = std::sync::Arc::new(crate::print_goal::PrintGoalSurface::new(false));
        crate::print_autonomous::wire_continuation_hook(
            &engine,
            engine.session.agent(),
            &model,
            &goal,
            &run,
        );
        admit(
            &mut boundary,
            &engine,
            &model,
            format!("seed turn {}", "x".repeat(48_000)),
        )
        .await
        .unwrap();
        // The in-run continuation turn overflows and the settled boundary
        // recovered it: one compaction, the retry settled, no failure rows.
        assert_eq!(compaction_count(&engine).await, 1);
        assert!(outcome_rows(&engine).await.is_empty());
        let last = last_assistant(&engine).await.expect("a settled turn");
        assert_eq!(last.stop_reason, pa_types::ai::StopReason::Stop);
        let text = last
            .content
            .iter()
            .filter_map(|block| match block {
                pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            })
            .collect::<String>();
        assert_eq!(text, "recovered reply");
        // The CLI prompt plus the injected continuation; the overflow
        // retry re-issued without re-adding a user message.
        assert_eq!(user_texts(&engine).await.len(), 2);
        assert!(user_texts(&engine).await[1].starts_with("[autonomous-continuation]"));
        // The limit stop surfaces only through the headless exit contract:
        // no durable `autonomous_status` row (the TS shape, probed against
        // the binary).
        assert!(engine
            .session
            .entries()
            .await
            .into_iter()
            .all(|entry| !matches!(
                &entry,
                pa_types::session::FileEntry::CustomMessage { payload, .. }
                    if payload.custom_type == "autonomous_status"
            )));
        let stderr = run
            .exit_stderr()
            .await
            .expect("the limit stop exits non-zero");
        assert!(stderr.starts_with("Autonomous run stopped before terminal evidence;"));
    }

    /// A capturing sink for json-mode event verification.
    fn capture_sink() -> (EventSink, std::sync::Arc<std::sync::Mutex<Vec<Value>>>) {
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink: EventSink = {
            let events = std::sync::Arc::clone(&events);
            std::sync::Arc::new(move |event: &Value| events.lock().unwrap().push(event.clone()))
        };
        (sink, events)
    }

    /// The durable `refinement_outcome` / `refinement_notice` rows, in order.
    async fn refine_rows(engine: &SessionEngine) -> Vec<pa_types::session::CustomMessage> {
        engine
            .session
            .entries()
            .await
            .into_iter()
            .filter_map(|entry| match entry {
                FileEntry::CustomMessage { payload, base } => {
                    let row = pa_types::session::CustomMessage {
                        custom_type: payload.custom_type.clone(),
                        content: payload.content.clone(),
                        display: payload.display,
                        details: payload.details.clone(),
                        timestamp: base
                            .timestamp
                            .as_deref()
                            .map(pa_core::session::timestamp_to_millis)
                            .unwrap_or_default(),
                        rest: payload.rest,
                    };
                    (row.custom_type == "refinement_outcome"
                        || row.custom_type == "refinement_notice")
                        .then_some(row)
                }
                _ => None,
            })
            .collect()
    }

    /// The requested compaction (TS `_runAutoCompaction("requested")`): the
    /// `compaction_start` event carries the consumed request's
    /// instructions, and the successful run ends with the client-facing
    /// result and `willRetry: false` (only the overflow arm re-issues).
    #[tokio::test]
    async fn requested_compaction_streams_the_ts_event_pair() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "second reply"},
                    {"text": "the summary"},
                ]
            }),
            compactable_settings(),
            None,
        )
        .await;
        let (sink, events) = capture_sink();
        let mut boundary = TurnBoundary::with_sink(true, sink);
        admit(
            &mut boundary,
            &engine,
            &model,
            format!("seed turn {}", "x".repeat(48_000)),
        )
        .await
        .unwrap();
        events.lock().unwrap().clear();
        // A mid-turn request consumed at that turn's settled boundary: the
        // events pair with the `requested` reason (the requested arm
        // consumes the check, so the threshold never re-evaluates).
        engine
            .turn_boundary
            .schedule_compaction(Some("focus on the goal".to_string()))
            .await;
        admit_turn_with_scheduled_request(
            &mut boundary,
            &engine,
            &model,
            format!("second turn {}", "x".repeat(2_000)),
        )
        .await
        .unwrap();
        let events = events.lock().unwrap().clone();
        let start_at = events
            .iter()
            .position(|event| event["type"] == "compaction_start")
            .expect("the compaction_start event");
        assert_eq!(
            events[start_at],
            json!({
                "type": "compaction_start",
                "reason": "requested",
                "customInstructions": "focus on the goal",
            })
        );
        let end_at = events
            .iter()
            .position(|event| event["type"] == "compaction_end")
            .expect("the compaction_end event");
        assert!(start_at < end_at);
        assert_eq!(events[end_at]["reason"], "requested");
        assert_eq!(events[end_at]["result"]["summary"], "the summary");
        assert_eq!(events[end_at]["aborted"], false);
        assert_eq!(events[end_at]["willRetry"], false);
        assert_eq!(events[end_at]["customInstructions"], "focus on the goal");
        assert!(
            !events
                .iter()
                .any(|event| event["type"] == "refine_complete"),
            "no refinement ran"
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event["type"] == "compaction_start")
                .count(),
            1,
            "exactly one compaction pair"
        );
        assert_eq!(compaction_count(&engine).await, 1, "the compaction ran");
    }

    /// A skipped requested compaction surfaces the durable outcome row (its
    /// `message_start`/`message_end` pair) before the `compaction_end`
    /// warning, exactly like the TS `_endCompactionUnsuccessfully` order.
    #[tokio::test]
    async fn requested_compaction_skip_streams_the_warning_row_and_end_event() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        // `keepRecentTokens` beyond the whole session: the compaction has
        // no history to summarize.
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({ "responses": [{"text": "seed reply"}] }),
            json!({
                "compaction": {
                    "enabled": true, "reserveTokens": 1, "keepRecentTokens": 100_000
                }
            }),
            None,
        )
        .await;
        let (sink, events) = capture_sink();
        let mut boundary = TurnBoundary::with_sink(true, sink);
        engine.turn_boundary.schedule_compaction(None).await;
        admit_turn_with_scheduled_request(&mut boundary, &engine, &model, "seed turn".to_string())
            .await
            .unwrap();
        let events = events.lock().unwrap().clone();
        let row_at = events
            .iter()
            .position(|event| {
                event["type"] == "message_start"
                    && event["message"]["customType"] == "compaction_outcome"
            })
            .expect("the outcome row's message pair");
        assert_eq!(
            events[row_at]["message"]["details"],
            json!({ "reason": "requested", "outcome": "skipped" })
        );
        let end_at = events
            .iter()
            .position(|event| event["type"] == "compaction_end")
            .expect("the compaction_end event");
        assert!(row_at < end_at, "the row pair precedes the end event");
        assert_eq!(events[end_at]["reason"], "requested");
        assert_eq!(events[end_at]["willRetry"], false);
        assert_eq!(
            events[end_at]["errorMessage"],
            "Requested compaction skipped: Session is too short to compact — try again once it grows"
        );
        assert_eq!(events[end_at]["errorSeverity"], "warning");
    }

    /// The requested arm feeds the run counter (TS `compaction_end`
    /// handling counts every completed compaction): the boundary
    /// compaction counts into the still-open run it settles, exactly
    /// like the overflow arm.
    #[tokio::test]
    async fn requested_compaction_counts_into_the_run_telemetry() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        let (engine, _dir, model, mock) = faux_engine_with_mock_telemetry(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "second reply"},
                    {"text": "the summary"},
                ]
            }),
            compactable_settings(),
        )
        .await;
        let mut boundary = TurnBoundary::new(false);
        admit(
            &mut boundary,
            &engine,
            &model,
            format!("seed turn {}", "x".repeat(48_000)),
        )
        .await
        .unwrap();
        engine.turn_boundary.schedule_compaction(None).await;
        admit_turn_with_scheduled_request(
            &mut boundary,
            &engine,
            &model,
            format!("second turn {}", "x".repeat(2_000)),
        )
        .await
        .unwrap();
        assert_eq!(compaction_count(&engine).await, 1, "the compaction ran");
        end_telemetry(&engine).await;
        let runs = mock_properties(&mock, "agent run completed");
        assert_eq!(runs.len(), 2, "one run per admitted prompt");
        assert_eq!(runs[0]["compaction_count"], json!(0));
        assert_eq!(
            runs[1]["compaction_count"],
            json!(1),
            "the requested compaction counted into the open run"
        );
        let ended = mock_properties(&mock, "agent session ended");
        assert_eq!(ended.len(), 1);
        assert_eq!(ended[0]["compaction_count"], json!(1));
    }

    /// The threshold arm feeds the same run counter: the crossing turn's
    /// boundary compaction counts into that turn's run.
    #[tokio::test]
    async fn threshold_compaction_counts_into_the_run_telemetry() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        // Probe: one settled turn's measured usage (no telemetry needed).
        let (probe, _dir, probe_model) = faux_engine_with_settings(
            json!({ "responses": [{"text": "seed reply"}] }),
            compactable_settings(),
            None,
        )
        .await;
        let mut probe_boundary = TurnBoundary::new(false);
        admit(
            &mut probe_boundary,
            &probe,
            &probe_model,
            "seed turn".to_string(),
        )
        .await
        .unwrap();
        let baseline = last_assistant(&probe)
            .await
            .map(|message| message.usage.total_tokens)
            .expect("probe turn produced usage");
        drop(probe);

        // The crossing prompt adds ~12k tokens; the headroom sits halfway.
        let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
        let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
        let headroom = baseline + big_tokens / 2;
        let (engine, _dir, model, mock) = faux_engine_with_mock_telemetry(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "crossing reply"},
                    {"text": "the summary"},
                ]
            }),
            json!({
                "compaction": {
                    "enabled": true,
                    "reserveTokens": 128_000u64.saturating_sub(FAUX_REQUEST_BUDGET + headroom).max(1),
                    "keepRecentTokens": 10
                }
            }),
        )
        .await;
        let mut boundary = TurnBoundary::new(false);
        admit(&mut boundary, &engine, &model, "seed turn".to_string())
            .await
            .unwrap();
        assert_eq!(
            compaction_count(&engine).await,
            0,
            "no compaction below the headroom"
        );
        admit(&mut boundary, &engine, &model, big_prompt)
            .await
            .unwrap();
        assert_eq!(
            compaction_count(&engine).await,
            1,
            "the crossing turn compacted"
        );
        end_telemetry(&engine).await;
        let runs = mock_properties(&mock, "agent run completed");
        assert_eq!(runs.len(), 2, "one run per admitted prompt");
        assert_eq!(runs[0]["compaction_count"], json!(0));
        assert_eq!(
            runs[1]["compaction_count"],
            json!(1),
            "the threshold compaction counted into the open run"
        );
        let ended = mock_properties(&mock, "agent session ended");
        assert_eq!(ended[0]["compaction_count"], json!(1));
    }

    /// A multi-compaction scenario across arms: the run property counts
    /// each arm's completed compaction, and the session total equals the
    /// number of compactions that ran (TS counts every completed
    /// `compaction_end`, whichever arm fired it).
    #[tokio::test]
    async fn multi_compaction_run_counts_every_arm() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        // Probe: one settled turn's measured usage.
        let (probe, _dir, probe_model) = faux_engine_with_settings(
            json!({ "responses": [{"text": "seed reply"}] }),
            compactable_settings(),
            None,
        )
        .await;
        let mut probe_boundary = TurnBoundary::new(false);
        admit(
            &mut probe_boundary,
            &probe,
            &probe_model,
            "seed turn".to_string(),
        )
        .await
        .unwrap();
        let baseline = last_assistant(&probe)
            .await
            .map(|message| message.usage.total_tokens)
            .expect("probe turn produced usage");
        drop(probe);

        let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
        let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
        let headroom = baseline + big_tokens / 2;
        let (engine, _dir, model, mock) = faux_engine_with_mock_telemetry(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "second reply"},
                    {"text": "requested summary"},
                    {"text": "crossing reply"},
                    {"text": "threshold summary"},
                ]
            }),
            json!({
                "compaction": {
                    "enabled": true,
                    "reserveTokens": 128_000u64.saturating_sub(FAUX_REQUEST_BUDGET + headroom).max(1),
                    "keepRecentTokens": 10
                },
                "autoRefine": { "enabled": false }
            }),
        )
        .await;
        let mut boundary = TurnBoundary::new(false);
        // Run 1: a small seed turn, below the headroom.
        admit(&mut boundary, &engine, &model, "seed turn".to_string())
            .await
            .unwrap();
        // Run 2: the requested compaction at the settled boundary (the
        // request consumes the check, so the threshold never fires there).
        engine.turn_boundary.schedule_compaction(None).await;
        admit_turn_with_scheduled_request(
            &mut boundary,
            &engine,
            &model,
            format!("second turn {}", "x".repeat(48_000)),
        )
        .await
        .unwrap();
        // Run 3: the threshold arm on the re-crossed context.
        admit(&mut boundary, &engine, &model, big_prompt)
            .await
            .unwrap();
        assert_eq!(compaction_count(&engine).await, 2, "both arms compacted");
        end_telemetry(&engine).await;
        let runs = mock_properties(&mock, "agent run completed");
        assert_eq!(runs.len(), 3, "one run per admitted prompt");
        assert_eq!(runs[0]["compaction_count"], json!(0));
        assert_eq!(
            runs[1]["compaction_count"],
            json!(1),
            "the requested compaction counted into its run"
        );
        assert_eq!(
            runs[2]["compaction_count"],
            json!(1),
            "the threshold compaction counted into its run"
        );
        let ended = mock_properties(&mock, "agent session ended");
        assert_eq!(
            ended[0]["compaction_count"],
            json!(2),
            "the session total matches the arm count"
        );
    }

    /// The threshold arm (TS `_checkCompaction` Case 3): a settled turn whose
    /// usage crosses the reserve headroom emits the `threshold` event pair —
    /// the start without instructions, the end with the client-facing
    /// result and `willRetry: false`. The faux provider estimates usage
    /// from the serialized context, so the headroom is measured from a
    /// baseline probe turn and placed between the seed turn and the
    /// crossing turn (the f14 battery shape; environment-independent
    /// margins on both sides).
    #[tokio::test]
    async fn threshold_compaction_streams_the_ts_event_pair() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        // Probe: one settled turn's measured usage.
        let (probe, _probe_dir, probe_model) = faux_engine_with_settings(
            json!({ "responses": [{"text": "seed reply"}] }),
            compactable_settings(),
            None,
        )
        .await;
        let mut probe_boundary = TurnBoundary::new(false);
        admit(
            &mut probe_boundary,
            &probe,
            &probe_model,
            "seed turn".to_string(),
        )
        .await
        .unwrap();
        let baseline = last_assistant(&probe)
            .await
            .map(|message| message.usage.total_tokens)
            .expect("probe turn produced usage");
        assert!(baseline < 100_000, "implausible baseline: {baseline}");

        // The crossing prompt adds ~12k tokens; the headroom sits halfway.
        let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
        let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
        let headroom = baseline + big_tokens / 2;
        let settings = json!({
            "compaction": {
                "enabled": true,
                "reserveTokens": 128_000u64.saturating_sub(FAUX_REQUEST_BUDGET + headroom).max(1),
                "keepRecentTokens": 10,
            }
        });
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "crossing reply"},
                    {"text": "the summary"},
                ]
            }),
            settings,
            None,
        )
        .await;
        let (sink, events) = capture_sink();
        let mut boundary = TurnBoundary::with_sink(true, sink);
        // The seed turn stays below the headroom: no compaction events.
        admit(&mut boundary, &engine, &model, "seed turn".to_string())
            .await
            .unwrap();
        assert!(
            events
                .lock()
                .unwrap()
                .iter()
                .all(|event| event["type"] != "compaction_start"),
            "no compaction below the headroom"
        );
        // The crossing turn: the settled usage fires the pair.
        admit(&mut boundary, &engine, &model, big_prompt)
            .await
            .unwrap();
        let events = events.lock().unwrap().clone();
        let start_at = events
            .iter()
            .position(|event| event["type"] == "compaction_start")
            .expect("the compaction_start event");
        assert_eq!(
            events[start_at],
            json!({"type": "compaction_start", "reason": "threshold"})
        );
        let end_at = events
            .iter()
            .position(|event| event["type"] == "compaction_end")
            .expect("the compaction_end event");
        assert!(start_at < end_at);
        assert_eq!(events[end_at]["reason"], "threshold");
        assert_eq!(events[end_at]["result"]["summary"], "the summary");
        assert_eq!(events[end_at]["aborted"], false);
        assert_eq!(events[end_at]["willRetry"], false);
        assert!(
            events[end_at].get("customInstructions").is_none(),
            "the threshold arm carries no request instructions"
        );
        assert_eq!(compaction_count(&engine).await, 1, "the compaction ran");
    }

    /// The pre-turn requested arm (TS `_runPreTurnCompaction` ->
    /// `_checkCompaction`'s pending-request branch): a request left pending
    /// before an admitted prompt consumes at the pre-turn check — the
    /// `requested` event pair with the request's instructions — so the
    /// prompt runs on the compacted context, and no second compaction
    /// fires at its settled boundary.
    #[tokio::test]
    async fn pre_turn_check_consumes_a_pending_request_before_the_prompt() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "second reply"},
                    {"text": "the summary"},
                    {"text": "next reply"},
                ]
            }),
            compactable_settings(),
            None,
        )
        .await;
        let (sink, events) = capture_sink();
        let mut boundary = TurnBoundary::with_sink(true, sink);
        // A large seed turn, so the pre-turn compaction has pre-cut history
        // to summarize (the `keepRecentTokens` cut keeps ~10 tokens).
        admit(
            &mut boundary,
            &engine,
            &model,
            format!("seed turn {}", "x".repeat(48_000)),
        )
        .await
        .unwrap();
        // The second turn absorbs the keep-recent budget on its own, so
        // the cut leaves the seed turn as summarizable history.
        admit(
            &mut boundary,
            &engine,
            &model,
            format!("second turn {}", "x".repeat(2_000)),
        )
        .await
        .unwrap();
        // A pending request (e.g. a previous run's schedule that its turn
        // never serviced) consumes at the next prompt's pre-turn check.
        engine
            .turn_boundary
            .schedule_compaction(Some("focus on the goal".to_string()))
            .await;
        events.lock().unwrap().clear();
        boundary.run_pre_turn(&engine, &model, None).await.unwrap();
        let captured = events.lock().unwrap().clone();
        assert_eq!(
            captured[0],
            json!({
                "type": "compaction_start",
                "reason": "requested",
                "customInstructions": "focus on the goal",
            })
        );
        assert_eq!(captured[1]["type"], "compaction_end");
        assert_eq!(captured[1]["reason"], "requested");
        assert_eq!(captured[1]["result"]["summary"], "the summary");
        assert_eq!(captured[1]["willRetry"], false);
        assert_eq!(
            captured
                .iter()
                .filter(|event| event["type"] == "compaction_start")
                .count(),
            1,
            "exactly one compaction pair"
        );
        assert_eq!(compaction_count(&engine).await, 1);
        // The admitted prompt runs on the compacted context; its settled
        // boundary finds nothing pending and no threshold crossing.
        admit(&mut boundary, &engine, &model, "next prompt".to_string())
            .await
            .unwrap();
        let events = events.lock().unwrap().clone();
        assert_eq!(
            events
                .iter()
                .filter(|event| event["type"] == "compaction_start")
                .count(),
            1,
            "no second compaction"
        );
        assert_eq!(compaction_count(&engine).await, 1);
        assert_eq!(user_texts(&engine).await.len(), 3);
        let last = last_assistant(&engine).await.expect("a settled turn");
        let text = last
            .content
            .iter()
            .filter_map(|block| match block {
                pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            })
            .collect::<String>();
        assert_eq!(text, "next reply");
    }

    /// The pre-turn threshold arm (TS `_runPreTurnCompaction` Case 3): a
    /// session that ended above the reserve headroom (run one, compaction
    /// disabled) compacts before its first resumed prompt (run two, the
    /// `--continue` shape with compaction enabled) — the `threshold` event
    /// pair streams, and the admitted prompt runs on the compacted
    /// context.
    #[tokio::test]
    async fn pre_turn_threshold_arm_compacts_a_resumed_session_before_the_prompt() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        // Run one: compaction disabled, the crossing turn settles above
        // the headroom (20000-token window, reserve 1) with no compaction.
        let (engine_a, dir_a, model_a) = faux_engine_with_settings(
            json!({
                "contextWindow": 20000,
                // A small output budget keeps the combined input+output
                // ceiling satisfiable on the 20k window.
                "maxTokens": 2000,
                "responses": [{"text": "seed reply"}, {"text": "crossing reply"}],
            }),
            json!({
                "compaction": { "enabled": false, "reserveTokens": 1, "keepRecentTokens": 10 }
            }),
            None,
        )
        .await;
        let mut boundary = TurnBoundary::new(false);
        admit(&mut boundary, &engine_a, &model_a, "seed turn".to_string())
            .await
            .unwrap();
        admit(
            &mut boundary,
            &engine_a,
            &model_a,
            format!("crossing turn {}", "x".repeat(100_000)),
        )
        .await
        .unwrap();
        assert_eq!(compaction_count(&engine_a).await, 0);
        assert!(outcome_rows(&engine_a).await.is_empty());

        // Run two: a fresh boundary over the persisted session with
        // compaction enabled — the pre-turn arm compacts above the
        // headroom before the admitted prompt.
        let session_file = dir_a
            .path()
            .join("sessions")
            .read_dir()
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.extension().and_then(|extension| extension.to_str()) == Some("jsonl"))
            .expect("the run-one session file");
        let resumed =
            SessionManager::open(dir_a.path(), &dir_a.path().join("sessions"), &session_file);
        let (engine_b, _dir_b, model_b) = faux_engine_with_settings(
            json!({
                "contextWindow": 20000,
                "maxTokens": 2000,
                "responses": [{"text": "the resumed summary"}, {"text": "recovered after the resume"}],
            }),
            json!({
                "compaction": { "enabled": true, "reserveTokens": 1, "keepRecentTokens": 10 }
            }),
            Some(resumed),
        )
        .await;
        let (sink, events) = capture_sink();
        let mut boundary = TurnBoundary::with_sink(true, sink);
        boundary
            .run_pre_turn(&engine_b, &model_b, None)
            .await
            .unwrap();
        let events = events.lock().unwrap().clone();
        assert_eq!(
            events[0],
            json!({"type": "compaction_start", "reason": "threshold"})
        );
        assert_eq!(events[1]["type"], "compaction_end");
        assert_eq!(events[1]["reason"], "threshold");
        assert_eq!(events[1]["result"]["summary"], "the resumed summary");
        assert_eq!(events[1]["willRetry"], false);
        assert_eq!(compaction_count(&engine_b).await, 1);
        assert!(outcome_rows(&engine_b).await.is_empty());
        // The admitted prompt runs on the compacted context; its settled
        // boundary stays quiet (the stale-usage guard holds).
        admit(
            &mut boundary,
            &engine_b,
            &model_b,
            "next prompt".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(compaction_count(&engine_b).await, 1);
        let last = last_assistant(&engine_b).await.expect("a settled turn");
        assert_eq!(last.stop_reason, pa_types::ai::StopReason::Stop);
        assert_eq!(user_texts(&engine_b).await.len(), 3);
    }

    /// The pre-turn abort arm (TS `_checkCompaction`'s aborted branch with
    /// `skipAbortedCheck=false`): an aborted trailing turn drops any
    /// pending model-requested compaction and refinement — the turn that
    /// would service them never ran — and the check continues without
    /// firing (no compaction entries, no outcome rows); the next prompt
    /// proceeds normally.
    #[tokio::test]
    async fn pre_turn_abort_arm_drops_pending_requests_and_continues() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "", "stopReason": "aborted"},
                    {"text": "next reply"},
                ]
            }),
            compactable_settings(),
            None,
        )
        .await;
        let (sink, events) = capture_sink();
        let mut boundary = TurnBoundary::with_sink(true, sink);
        admit(&mut boundary, &engine, &model, "seed turn".to_string())
            .await
            .unwrap();
        admit(&mut boundary, &engine, &model, "abort me".to_string())
            .await
            .unwrap();
        let last = last_assistant(&engine).await.expect("a settled turn");
        assert_eq!(last.stop_reason, pa_types::ai::StopReason::Aborted);
        // Requests pending against the aborted turn: the pre-turn check
        // drops both.
        engine
            .turn_boundary
            .schedule_compaction(Some("stale request".to_string()))
            .await;
        engine
            .turn_boundary
            .schedule_refine(pa_core::session_engine::turn_boundary::PendingRefine {
                instructions: None,
                global: false,
            })
            .await;
        events.lock().unwrap().clear();
        boundary.run_pre_turn(&engine, &model, None).await.unwrap();
        assert!(!engine.turn_boundary.compaction_scheduled().await);
        assert!(!engine.turn_boundary.refine_pending().await);
        assert!(events.lock().unwrap().is_empty(), "no compaction events");
        assert_eq!(compaction_count(&engine).await, 0);
        assert!(outcome_rows(&engine).await.is_empty());
        // The check continued: the next prompt admits normally.
        admit(&mut boundary, &engine, &model, "next prompt".to_string())
            .await
            .unwrap();
        assert_eq!(compaction_count(&engine).await, 0);
        let last = last_assistant(&engine).await.expect("a settled turn");
        assert_eq!(last.stop_reason, pa_types::ai::StopReason::Stop);
    }

    /// A failed requested refinement emits the TS `refine_failed` event
    /// with the failure's message; text mode keeps the stderr diagnostic.
    #[tokio::test]
    async fn requested_refinement_failure_emits_the_refine_failed_event() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        // The refiner consumes the next faux response; a non-JSON reply
        // fails the plan parse.
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({ "responses": [{"text": "seed reply"}, {"text": "not a plan"}] }),
            compactable_settings(),
            None,
        )
        .await;
        let global_dir = tempfile::TempDir::new().unwrap().keep();
        let (sink, events) = capture_sink();
        let mut boundary = TurnBoundary::with_sink(true, sink);
        engine
            .turn_boundary
            .schedule_refine(pa_core::session_engine::turn_boundary::PendingRefine {
                instructions: None,
                global: true,
            })
            .await;
        admit_with_harness_dir(
            &mut boundary,
            &engine,
            &model,
            "seed turn".to_string(),
            global_dir,
        )
        .await
        .unwrap();
        let events = events.lock().unwrap().clone();
        let failed = events
            .iter()
            .find(|event| event["type"] == "refine_failed")
            .expect("the refine_failed event");
        let error = failed["error"].as_str().unwrap_or_default();
        assert!(!error.is_empty(), "the failure message rides the event");
        assert!(
            events
                .iter()
                .all(|event| event["type"] != "compaction_start"),
            "no compaction ran"
        );
    }

    /// A successful requested refinement streams the TS surface: the
    /// durable outcome row's message pair, the model-facing notice's pair
    /// (edits applied), then the `refine_complete` event carrying the
    /// wire-shaped result.
    #[tokio::test]
    async fn requested_refinement_streams_rows_and_refine_complete() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        let plan = r#"{"summary":"note it","rationale":"repeated","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m1","title":"Tactic","content":"Use tactic A"}]}"#;
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({ "responses": [{"text": "seed reply"}, {"text": plan}] }),
            compactable_settings(),
            None,
        )
        .await;
        let global_dir = tempfile::TempDir::new().unwrap().keep();
        let (sink, events) = capture_sink();
        let mut boundary = TurnBoundary::with_sink(true, sink);
        engine
            .turn_boundary
            .schedule_refine(pa_core::session_engine::turn_boundary::PendingRefine {
                instructions: None,
                global: true,
            })
            .await;
        admit_with_harness_dir(
            &mut boundary,
            &engine,
            &model,
            "seed turn".to_string(),
            global_dir,
        )
        .await
        .unwrap();
        let events = events.lock().unwrap().clone();
        // The durable rows first: the outcome row's pair, then the notice.
        let outcome_at = events
            .iter()
            .position(|event| {
                event["type"] == "message_start"
                    && event["message"]["customType"] == "refinement_outcome"
            })
            .expect("the outcome row pair");
        let notice_at = events
            .iter()
            .position(|event| {
                event["type"] == "message_start"
                    && event["message"]["customType"] == "refinement_notice"
            })
            .expect("the notice row pair");
        assert!(outcome_at < notice_at);
        assert_eq!(events[outcome_at]["message"]["display"], true);
        assert_eq!(events[notice_at]["message"]["display"], false);
        // Then the completion event with the wire-shaped result.
        let complete_at = events
            .iter()
            .position(|event| event["type"] == "refine_complete")
            .expect("the refine_complete event");
        assert!(notice_at < complete_at);
        assert_eq!(events[complete_at]["result"]["summary"], "note it");
        assert_eq!(events[complete_at]["result"]["appliedEdits"][0]["id"], "m1");
        // The durable rows persisted in the session file.
        let rows = refine_rows(&engine).await;
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].custom_type, "refinement_outcome");
        assert_eq!(rows[1].custom_type, "refinement_notice");
    }

    /// The compact-trigger auto-refine at the next serialized checkpoint (TS
    /// `_runSerializedRefineCheckpointAfterBackground`'s compact arm): a
    /// compaction at one boundary schedules the review, and the next
    /// boundary's checkpoint consumes it — the review gate first (an LLM
    /// call), then the approved refinement run streaming the durable rows'
    /// pairs and `refine_complete` exactly like the requested path.
    #[tokio::test]
    async fn compact_trigger_auto_refine_streams_at_the_next_boundary() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        let review = r#"{"shouldRefine": true, "rationale": "the crossing turn shows a reusable tactic", "instructions": "record the tactic"}"#;
        let plan = r#"{"summary":"note it","rationale":"repeated","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m1","title":"Tactic","content":"Use tactic A"}]}"#;
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "second reply"},
                    {"text": "the summary"},
                    {"text": "third reply"},
                    {"text": review},
                    {"text": plan},
                ]
            }),
            compactable_settings(),
            None,
        )
        .await;
        let global_dir = tempfile::TempDir::new().unwrap().keep();
        let (sink, events) = capture_sink();
        let mut boundary = TurnBoundary::with_sink(true, sink);
        admit_with_harness_dir(
            &mut boundary,
            &engine,
            &model,
            format!("seed turn {}", "x".repeat(48_000)),
            global_dir.clone(),
        )
        .await
        .unwrap();
        // A requested compaction at the second boundary (the #214 shape):
        // the trigger is scheduled with no further turn to consume it here.
        engine.turn_boundary.schedule_compaction(None).await;
        // The mid-turn-request shape (#223's contract: a `compact.run`
        // scheduled during a turn consumes at that turn's settled boundary;
        // a pending request never survives to a pre-turn check in the
        // product flow — the pre-turn arm would skip it here, the seed
        // turn alone is too short to compact).
        admit_turn_with_scheduled_request(
            &mut boundary,
            &engine,
            &model,
            format!("second turn {}", "x".repeat(2_000)),
        )
        .await
        .unwrap();
        assert_eq!(compaction_count(&engine).await, 1, "the compaction ran");
        assert!(
            events
                .lock()
                .unwrap()
                .iter()
                .all(|event| event["type"] != "refine_complete"),
            "no auto-refine before the next boundary"
        );
        // The next boundary's checkpoint consumes the trigger: the review
        // approves and the refinement streams the TS surface.
        admit_with_harness_dir(
            &mut boundary,
            &engine,
            &model,
            "third turn".to_string(),
            global_dir,
        )
        .await
        .unwrap();
        let events = events.lock().unwrap().clone();
        let outcome_at = events
            .iter()
            .position(|event| {
                event["type"] == "message_start"
                    && event["message"]["customType"] == "refinement_outcome"
            })
            .expect("the outcome row pair");
        let notice_at = events
            .iter()
            .position(|event| {
                event["type"] == "message_start"
                    && event["message"]["customType"] == "refinement_notice"
            })
            .expect("the notice row pair");
        let complete_at = events
            .iter()
            .position(|event| event["type"] == "refine_complete")
            .expect("the refine_complete event");
        assert!(outcome_at < notice_at && notice_at < complete_at);
        assert_eq!(events[complete_at]["result"]["summary"], "note it");
        // The source is the auto review (the notice's details).
        assert_eq!(events[notice_at]["message"]["details"]["source"], "auto");
        let rows = refine_rows(&engine).await;
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].custom_type, "refinement_outcome");
        assert_eq!(rows[1].custom_type, "refinement_notice");
    }

    /// The overflow compact-and-retry's checkpoint (the observed TS surface):
    /// the compaction schedules the trigger, the retried turn settles, and
    /// its serialized checkpoint runs the review and — on approval — the
    /// refinement, streaming mid-run before the boundary re-checks the
    /// retried turn.
    #[tokio::test]
    async fn overflow_retry_compact_trigger_streams_the_ts_surface() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        let review = r#"{"shouldRefine": true, "rationale": "the overflow recovery is reusable"}"#;
        let plan = r#"{"summary":"note it","rationale":"repeated","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m1","title":"Tactic","content":"Use tactic A"}]}"#;
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    overflow_error(0),
                    {"text": "the summary"},
                    {"text": "recovered reply"},
                    {"text": review},
                    {"text": plan},
                ]
            }),
            compactable_settings(),
            None,
        )
        .await;
        let global_dir = tempfile::TempDir::new().unwrap().keep();
        let (sink, events) = capture_sink();
        let mut boundary = TurnBoundary::with_sink(true, sink);
        admit_with_harness_dir(
            &mut boundary,
            &engine,
            &model,
            format!("seed turn {}", "x".repeat(48_000)),
            global_dir,
        )
        .await
        .unwrap();
        admit_with_harness_dir(
            &mut boundary,
            &engine,
            &model,
            format!("overflow probe {}", "x".repeat(48_000)),
            std::path::PathBuf::new(),
        )
        .await
        .unwrap();
        let events = events.lock().unwrap().clone();
        // The compaction pair re-issues (willRetry true), the retried turn
        // settles, and its checkpoint drains the trigger: the row pairs,
        // then refine_complete.
        let end_at = events
            .iter()
            .position(|event| event["type"] == "compaction_end")
            .expect("the compaction_end event");
        assert_eq!(events[end_at]["willRetry"], true);
        let outcome_at = events
            .iter()
            .position(|event| {
                event["type"] == "message_start"
                    && event["message"]["customType"] == "refinement_outcome"
            })
            .expect("the outcome row pair");
        let complete_at = events
            .iter()
            .position(|event| event["type"] == "refine_complete")
            .expect("the refine_complete event");
        assert!(end_at < outcome_at && outcome_at < complete_at);
        assert_eq!(
            events
                .iter()
                .filter(|event| event["type"] == "compaction_start")
                .count(),
            1,
            "exactly one compaction"
        );
        assert_eq!(refine_rows(&engine).await.len(), 2);
    }

    /// The disposal drain (TS `dispose`): a compaction at the final settled
    /// boundary schedules a trigger no later boundary consumes; the print
    /// client's subscription is already torn down, so the drain's review and
    /// refinement stay off the event stream while the durable rows persist.
    #[tokio::test]
    async fn compact_trigger_drains_at_disposal_off_the_stream() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        let review =
            r#"{"shouldRefine": true, "rationale": "the seed turn shows a reusable tactic"}"#;
        let plan = r#"{"summary":"note it","rationale":"repeated","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m1","title":"Tactic","content":"Use tactic A"}]}"#;
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "second reply"},
                    {"text": "the summary"},
                    {"text": review},
                    {"text": plan},
                ]
            }),
            compactable_settings(),
            None,
        )
        .await;
        let global_dir = tempfile::TempDir::new().unwrap().keep();
        let (sink, events) = capture_sink();
        let mut boundary = TurnBoundary::with_sink(true, sink);
        admit_with_harness_dir(
            &mut boundary,
            &engine,
            &model,
            format!("seed turn {}", "x".repeat(48_000)),
            global_dir.clone(),
        )
        .await
        .unwrap();
        engine.turn_boundary.schedule_compaction(None).await;
        // The mid-turn-request shape (#223's contract: a `compact.run`
        // scheduled during a turn consumes at that turn's settled boundary;
        // a pending request never survives to a pre-turn check in the
        // product flow — the pre-turn arm would skip it here, the seed
        // turn alone is too short to compact).
        admit_turn_with_scheduled_request(
            &mut boundary,
            &engine,
            &model,
            format!("second turn {}", "x".repeat(2_000)),
        )
        .await
        .unwrap();
        assert_eq!(compaction_count(&engine).await, 1);
        assert!(
            events
                .lock()
                .unwrap()
                .iter()
                .all(|event| event["type"] != "refine_complete"),
            "no auto-refine before disposal"
        );
        // The print runtime's disposal order: the terminal output is done,
        // the subscription is gone, and the drain runs the round silently.
        boundary
            .drain_compact_auto_refine_at_disposal(&engine, &model, None, global_dir)
            .await;
        let rows = refine_rows(&engine).await;
        assert_eq!(rows.len(), 2, "the durable rows persisted");
        assert_eq!(rows[0].custom_type, "refinement_outcome");
        assert_eq!(rows[1].custom_type, "refinement_notice");
        assert!(
            events
                .lock()
                .unwrap()
                .iter()
                .all(|event| event["type"] != "refine_complete"),
            "the drain stays off the event stream"
        );
    }

    /// A declining review surfaces nothing (TS: the decline only stamps the
    /// cooldown): no refinement rows, no events.
    #[tokio::test]
    async fn auto_refine_review_decline_surfaces_nothing() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        let review = r#"{"shouldRefine": false, "rationale": "one-off tool output"}"#;
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "second reply"},
                    {"text": "the summary"},
                    {"text": "third reply"},
                    {"text": review},
                ]
            }),
            compactable_settings(),
            None,
        )
        .await;
        let global_dir = tempfile::TempDir::new().unwrap().keep();
        let (sink, events) = capture_sink();
        let mut boundary = TurnBoundary::with_sink(true, sink);
        admit_with_harness_dir(
            &mut boundary,
            &engine,
            &model,
            format!("seed turn {}", "x".repeat(48_000)),
            global_dir.clone(),
        )
        .await
        .unwrap();
        engine.turn_boundary.schedule_compaction(None).await;
        // The mid-turn-request shape (#223's contract: a `compact.run`
        // scheduled during a turn consumes at that turn's settled boundary;
        // a pending request never survives to a pre-turn check in the
        // product flow — the pre-turn arm would skip it here, the seed
        // turn alone is too short to compact).
        admit_turn_with_scheduled_request(
            &mut boundary,
            &engine,
            &model,
            format!("second turn {}", "x".repeat(2_000)),
        )
        .await
        .unwrap();
        assert_eq!(compaction_count(&engine).await, 1, "the compaction ran");
        admit_with_harness_dir(
            &mut boundary,
            &engine,
            &model,
            "third turn".to_string(),
            global_dir,
        )
        .await
        .unwrap();
        assert!(refine_rows(&engine).await.is_empty(), "no refinement ran");
        let events = events.lock().unwrap().clone();
        assert!(
            events
                .iter()
                .all(|event| event["type"] != "refine_complete"
                    && event["type"] != "refine_failed"),
            "the decline surfaces nothing"
        );
        // The unconsumed review response stays queued (the reviewer ran
        // exactly once).
        assert_eq!(
            events
                .iter()
                .filter(|event| event["type"] == "compaction_start")
                .count(),
            1
        );
    }

    /// The settings gate (TS `autoRefine.enabled`): a disabled auto-refine
    /// drops the compaction trigger without a review call.
    #[tokio::test]
    async fn auto_refine_disabled_settings_drop_the_trigger() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "second reply"},
                    {"text": "the summary"},
                    {"text": "third reply"},
                ]
            }),
            json!({
                "compaction": { "enabled": true, "reserveTokens": 1, "keepRecentTokens": 10 },
                "autoRefine": { "enabled": false }
            }),
            None,
        )
        .await;
        let global_dir = tempfile::TempDir::new().unwrap().keep();
        let (sink, events) = capture_sink();
        let mut boundary = TurnBoundary::with_sink(true, sink);
        admit_with_harness_dir(
            &mut boundary,
            &engine,
            &model,
            format!("seed turn {}", "x".repeat(48_000)),
            global_dir.clone(),
        )
        .await
        .unwrap();
        engine.turn_boundary.schedule_compaction(None).await;
        // The mid-turn-request shape (#223's contract: a `compact.run`
        // scheduled during a turn consumes at that turn's settled boundary;
        // a pending request never survives to a pre-turn check in the
        // product flow — the pre-turn arm would skip it here, the seed
        // turn alone is too short to compact).
        admit_turn_with_scheduled_request(
            &mut boundary,
            &engine,
            &model,
            format!("second turn {}", "x".repeat(2_000)),
        )
        .await
        .unwrap();
        admit_with_harness_dir(
            &mut boundary,
            &engine,
            &model,
            "third turn".to_string(),
            global_dir,
        )
        .await
        .unwrap();
        assert_eq!(compaction_count(&engine).await, 1, "the compaction ran");
        assert!(refine_rows(&engine).await.is_empty(), "no refinement ran");
        let events = events.lock().unwrap().clone();
        assert!(
            events
                .iter()
                .all(|event| event["type"] != "refine_complete"
                    && event["type"] != "refine_failed"),
            "the disabled trigger surfaces nothing"
        );
    }

    /// A plain provider error is not an overflow: the arm never fires and
    /// the turn ends like any error turn.
    #[tokio::test]
    async fn non_overflow_error_never_triggers_the_arm() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "", "stopReason": "error", "errorMessage": "529 overloaded"},
                ]
            }),
            compactable_settings(),
            None,
        )
        .await;
        let mut boundary = TurnBoundary::new(false);
        admit(&mut boundary, &engine, &model, "seed turn".to_string())
            .await
            .unwrap();
        admit(&mut boundary, &engine, &model, "flaky turn".to_string())
            .await
            .unwrap();
        assert_eq!(compaction_count(&engine).await, 0);
        assert!(outcome_rows(&engine).await.is_empty());
        let last = last_assistant(&engine)
            .await
            .expect("the settled error turn");
        assert_eq!(last.error_message.as_deref(), Some("529 overloaded"));
    }

    /// The settings gate (TS `settings.enabled`): with automatic compaction
    /// disabled, an overflow error ends the turn with no recovery.
    #[tokio::test]
    async fn overflow_error_with_compaction_disabled_ends_without_recovery() {
        let _faux = FAUX_TEST_LOCK.lock().await;
        let (engine, _dir, model) = faux_engine_with_settings(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    overflow_error(0),
                    {"text": "the summary"},
                ]
            }),
            json!({
                "compaction": { "enabled": false, "reserveTokens": 1, "keepRecentTokens": 10 }
            }),
            None,
        )
        .await;
        let mut boundary = TurnBoundary::new(false);
        admit(&mut boundary, &engine, &model, "seed turn".to_string())
            .await
            .unwrap();
        admit(&mut boundary, &engine, &model, "overflow probe".to_string())
            .await
            .unwrap();
        assert_eq!(compaction_count(&engine).await, 0);
        assert!(outcome_rows(&engine).await.is_empty());
        let last = last_assistant(&engine)
            .await
            .expect("the settled error turn");
        assert_eq!(last.error_message.as_deref(), Some(OVERFLOW_ERROR));
    }
}
