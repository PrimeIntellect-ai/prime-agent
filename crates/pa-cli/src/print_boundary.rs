//! The print runtime's turn-boundary compaction checks: the overflow
//! compact-and-retry plus the requested/threshold arms, at the settled-turn
//! boundary and before every admitted prompt (a pre-turn compaction never
//! re-issues). The planning refinements are the refinement child's, so the
//! boundary only refuses a pending request; json mode streams the wire
//! events, text mode stays quiet.

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

mod events;

use events::{compaction_end_success_event, compaction_start_event};

mod compaction_arms;

use compaction_arms::{OverflowBoundary, OverflowOutcome, OverflowRecovery};

#[cfg(test)]
use compaction_arms::OVERFLOW_RECOVERY_FAILED_MESSAGE;

mod autorefine;

/// Where the boundary's json events go: stdout in the product, a captured
/// buffer in tests.
type EventSink = std::sync::Arc<dyn Fn(&serde_json::Value) + Send + Sync>;

/// The print loop's turn-boundary state: the one-attempt overflow machine, the
/// compact-trigger auto-refine bookkeeping, and the json/text output mode.
pub(crate) struct TurnBoundary {
    recovery: OverflowRecovery,
    /// json mode streams the session events on stdout; text mode reads
    /// the durable rows through the headless terminal result.
    json_mode: bool,
    sink: EventSink,
}

impl TurnBoundary {
    pub(crate) fn new(json_mode: bool) -> Self {
        Self {
            recovery: OverflowRecovery::Idle,
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
            json_mode,
            sink,
        }
    }

    /// The pre-turn check before an admitted prompt: an aborted trailing
    /// turn drops any pending model request, then the same arm order as
    /// the settled boundary (the requested/threshold arms only when the
    /// overflow arm stayed silent). A pre-turn compaction never re-issues:
    /// the admitted prompt continues on the compacted context.
    pub(crate) async fn run_pre_turn(
        &mut self,
        engine: &SessionEngine,
        model: &Model,
        api_key: Option<String>,
    ) -> Result<(), String> {
        // An aborted trailing assistant drops any pending model request
        // (the pre-prompt path never returns early).
        if matches!(
            engine.session.last_assistant_message().await,
            Some(SessionAgentMessage::Assistant(wire))
                if wire.stop_reason == pa_types::ai::StopReason::Aborted
        ) {
            engine.turn_boundary.clear_pending().await;
        }
        // When the overflow arm fires, the requested/threshold arms never run in
        // the same pass (the overflow run consumes the pending request).
        let outcome = self
            .overflow_recovery_attempt(engine, model, api_key.clone(), OverflowBoundary::PreTurn)
            .await?;
        if matches!(outcome, OverflowOutcome::NotApplicable) {
            self.requested_and_threshold_arms(engine, model, api_key)
                .await?;
        }
        self.reset();
        Ok(())
    }

    /// The settled-turn boundary: the overflow arm with its retry loop,
    /// then the requested and threshold arms, then the pending
    /// refinement's refusal.
    pub(crate) async fn run_at_settled_turn(
        &mut self,
        engine: &SessionEngine,
        model: &Model,
        api_key: Option<String>,
    ) -> Result<(), String> {
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
                continue;
            }
            break matches!(outcome, OverflowOutcome::Finished);
        };
        if !arm_finished {
            self.requested_and_threshold_arms(engine, model, api_key.clone())
                .await?;
        }
        // The pending refinement refuses whenever the turn did not re-issue
        // (a retried turn consumes it at its own boundary): the planning
        // refinement is the refinement child's, and this session has no
        // child runtime, so the request fails visibly instead of silently
        // dropping.
        self.refuse_pending_refinement(engine).await;
        Ok(())
    }

    /// Admit one autonomous continuation turn through the same boundary pair the
    /// CLI prompts run: the arms belong to the session loop, not the prompt loop.
    pub(crate) async fn admit_continuation(
        &mut self,
        engine: &SessionEngine,
        model: &Model,
        api_key: Option<String>,
        prompt: &str,
        _global_harness_dir: PathBuf,
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
        self.run_at_settled_turn(engine, model, api_key).await
    }
}

#[cfg(test)]
mod tests;
