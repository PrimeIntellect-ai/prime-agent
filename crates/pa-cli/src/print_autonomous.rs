//! The print run's autonomous continuation loop — the in-run drive (the
//! #254 ambiguity, resolved against the TS binary).
//!
//! TS ruling (probed over the shared faux-provider harness,
//! `prime-agent --mode json`): the autonomous continuation rides the agent
//! loop's natural-turn-end hook (`getContinuationMessages` -> the
//! autonomous arm of `_getContinuationMessages`), so the continuation
//! churns INSIDE the one prompt wait — `turn_end -> turn_start` with the
//! continuation user row's message pair between them, no
//! `agent_start`/`agent_end` between continuation turns, one
//! `agent_end` per prompt wait. What ends the loop: the driver's stop
//! decisions (a passing gate, an exhausted limit) or `/autonomous off` —
//! the stop never writes a row or a stream frame (the headless exit
//! contract reports it); a threshold compaction due at the settled turn
//! queues the continuation as a `followUp` admission (TS
//! `_queueAutonomousContinuationForThresholdCompaction`: the mint bumps
//! the budget ahead of the loop stop, the boundary compacts, the queued
//! turn runs post-compaction).
//!
//! The Rust mapping: the composed hook installed here runs the goal arm
//! first (TS gives the goal exclusive priority) and the autonomous arm on
//! the fall-through; the driver's held continuation drains through the
//! print boundary pair (the queued `followUp` shape). Text mode runs the
//! same loop silently; the process exit contract stays the headless one.

use std::sync::Arc;

use pa_agent::agent::Agent;
use pa_agent::types::AgentMessage;
use pa_core::session_engine::engine::SessionEngine;
use pa_types::ai::Model;

use crate::headless_autonomous::HeadlessAutonomous;
use crate::print_goal::{NaturalContinuation, PrintGoalSurface};

/// Install the composed natural-turn-end continuation hook (TS
/// `_getContinuationMessages`): the goal arm runs first — an active goal's
/// mint owns the turn, its gates end the run — and the autonomous arm
/// consults only on the fall-through. The gates (queued input, a pending
/// requested compaction, a threshold compaction due) apply to both arms;
/// the threshold arm mints the owed continuation (the goal's, or the
/// autonomous driver's) ahead of the loop stop and holds it for the
/// post-compaction admission.
pub(crate) fn wire_continuation_hook(
    engine: &Arc<SessionEngine>,
    agent: &Arc<Agent>,
    model: &Model,
    goal: &Arc<PrintGoalSurface>,
    autonomous: &Arc<HeadlessAutonomous>,
) {
    let weak_engine = Arc::downgrade(engine);
    let weak_goal = Arc::downgrade(goal);
    let weak_autonomous = Arc::downgrade(autonomous);
    let context_window = model.context_window;
    agent.set_continuation_hook(Some(Arc::new(move |context, _signal| {
        let weak_engine = weak_engine.clone();
        let weak_goal = weak_goal.clone();
        let weak_autonomous = weak_autonomous.clone();
        Box::pin(async move {
            let (Some(engine), Some(goal), Some(autonomous)) = (
                weak_engine.upgrade(),
                weak_goal.upgrade(),
                weak_autonomous.upgrade(),
            ) else {
                return Ok(Vec::new());
            };
            match goal.natural_continuation(&engine, context_window).await {
                NaturalContinuation::QueuedInput | NaturalContinuation::RequestedCompaction => {
                    Ok(Vec::new())
                }
                NaturalContinuation::ThresholdDue => {
                    // The autonomous continuation the threshold arm owes:
                    // minted (budget bumped) and held, the run ends, the
                    // boundary compacts, the driver admits the held turn.
                    if let Some(text) = autonomous.follow_up_text(&context.message).await {
                        autonomous.hold_threshold_continuation(text).await;
                    }
                    Ok(Vec::new())
                }
                NaturalContinuation::GoalRow(row) => Ok(vec![*row]),
                NaturalContinuation::FallThrough => {
                    // The natural autonomous mint: the continuation user row
                    // runs as the next turn of the same run (TS
                    // pendingMessages).
                    match autonomous.follow_up_text(&context.message).await {
                        Some(text) => Ok(vec![autonomous_continuation_row(&text)]),
                        None => Ok(Vec::new()),
                    }
                }
            }
        }) as pa_agent::BoxFut<'static, anyhow::Result<Vec<AgentMessage>>>
    })));
}

/// The continuation user row for the agent loop (TS
/// `createAutonomousContinuationMessage`'s wire shape).
fn autonomous_continuation_row(text: &str) -> AgentMessage {
    pa_core::autonomous::autonomous_continuation_loop_row(text, pa_core::autonomous::now_millis())
}
