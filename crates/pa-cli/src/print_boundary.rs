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
//! print flag was reconciled here).
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

// The boundary renderers (the TS wire-event surface: the
// `compaction_start`/`compaction_end` event builders and the json-mode
// emission methods) moved to the child module; the arms child reaches
// the builders through the facade glob (the `use` below) and the methods
// through the type at pub(super).
mod events;

use events::{compaction_end_success_event, compaction_start_event};

// The divider logic (the TS `_checkCompaction` arms: the overflow
// compact-and-retry machine with its three state enums, and the
// requested/threshold compaction arms) moved to the child module; the
// facade drivers reach the machine through pub(super) + the `use` below
// (the tests glob re-exposes the failure-text const through cfg(test)).
mod compaction_arms;

use compaction_arms::{OverflowBoundary, OverflowOutcome, OverflowRecovery};

#[cfg(test)]
use compaction_arms::OVERFLOW_RECOVERY_FAILED_MESSAGE;

// The compact-trigger auto-refine machine (the review gates, the
// durable-row surface, and the disposal drain) moved to the child
// module; the facade drivers reach it through pub(super) + the `use`
// below.
mod autorefine;

use autorefine::RefineSurface;

/// Where the boundary's json events go: stdout in the product, a captured
/// buffer in tests.
type EventSink = std::sync::Arc<dyn Fn(&serde_json::Value) + Send + Sync>;

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
}

// The test mass (the faux harness and the boundary battery) moved to the
// child module at the same tree position (print_boundary::tests); the
// facade's cfg(test) re-export above keeps the failure-text const in the
// tests glob scope.
#[cfg(test)]
mod tests;
