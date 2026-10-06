//! The print run's autonomous continuation loop — the in-run drive (the
//! ambiguity, resolved against the TS binary).
//!
//! TS ruling: the continuation rides the natural-turn-end hook, churning
//! INSIDE the one prompt wait. A stop never writes a row or stream frame
//! (the headless exit contract reports it); a threshold compaction queues
//! the continuation as a `followUp` admission. The goal arm runs first.

use std::sync::Arc;

use pa_agent::agent::Agent;
use pa_agent::types::AgentMessage;
use pa_core::session_engine::engine::SessionEngine;
use pa_types::ai::Model;

use crate::headless_autonomous::HeadlessAutonomous;
use crate::print_goal::{NaturalContinuation, PrintGoalSurface};

/// Install the composed natural-turn-end continuation hook: the goal arm
/// runs first (an active goal's mint owns the turn), the autonomous arm
/// consults on the fall-through. The threshold arm mints the owed
/// continuation ahead of the loop stop and holds it for the admission.
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
    let model = Arc::new(model.clone());
    agent.set_continuation_hook(Some(Arc::new(move |context, _signal| {
        let weak_engine = weak_engine.clone();
        let weak_goal = weak_goal.clone();
        let weak_autonomous = weak_autonomous.clone();
        let model = Arc::clone(&model);
        Box::pin(async move {
            let (Some(engine), Some(goal), Some(autonomous)) = (
                weak_engine.upgrade(),
                weak_goal.upgrade(),
                weak_autonomous.upgrade(),
            ) else {
                return Ok(Vec::new());
            };
            match goal.natural_continuation(&engine, &model).await {
                NaturalContinuation::QueuedInput | NaturalContinuation::RequestedCompaction => {
                    Ok(Vec::new())
                }
                NaturalContinuation::ThresholdDue => {
                    // The autonomous continuation the threshold arm owes: the run ends,
                    // the boundary compacts, the driver admits the held turn.
                    if let Some(text) = autonomous.follow_up_text(&context.message).await {
                        autonomous.hold_threshold_continuation(text).await;
                    }
                    Ok(Vec::new())
                }
                NaturalContinuation::GoalRow(row) => Ok(vec![*row]),
                NaturalContinuation::FallThrough => {
                    // The natural autonomous mint: the continuation user
                    // row runs as the next turn of the same run.
                    match autonomous.follow_up_text(&context.message).await {
                        Some(text) => Ok(vec![autonomous_continuation_row(&text)]),
                        None => Ok(Vec::new()),
                    }
                }
            }
        }) as pa_agent::BoxFut<'static, anyhow::Result<Vec<AgentMessage>>>
    })));
}

/// The continuation user row for the agent loop.
fn autonomous_continuation_row(text: &str) -> AgentMessage {
    pa_core::autonomous::autonomous_continuation_loop_row(text, pa_core::autonomous::now_millis())
}
