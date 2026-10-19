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

/// Install the composed natural-turn-end continuation hook: the goal
/// arm first, the autonomous arm on the fall-through. Both defer behind
/// unsettled inline-subagent work; the quiescence drive delivers after
/// the settle.
pub(crate) fn wire_continuation_hook(
    engine: &Arc<SessionEngine>,
    agent: &Arc<Agent>,
    model: &Model,
    goal: &Arc<PrintGoalSurface>,
    autonomous: &Arc<HeadlessAutonomous>,
    root_node: Option<&Arc<crate::print_rlm::InlineSessionNode>>,
) {
    let weak_engine = Arc::downgrade(engine);
    let weak_goal = Arc::downgrade(goal);
    let weak_autonomous = Arc::downgrade(autonomous);
    let weak_root = root_node.map(Arc::downgrade);
    let model = Arc::new(model.clone());
    agent.set_continuation_hook(Some(Arc::new(move |context, _signal| {
        let weak_engine = weak_engine.clone();
        let weak_goal = weak_goal.clone();
        let weak_autonomous = weak_autonomous.clone();
        let weak_root = weak_root.clone();
        let model = Arc::clone(&model);
        Box::pin(async move {
            let (Some(engine), Some(goal), Some(autonomous)) = (
                weak_engine.upgrade(),
                weak_goal.upgrade(),
                weak_autonomous.upgrade(),
            ) else {
                return Ok(Vec::new());
            };
            // Without the inline-subagent runtime no descendant work
            // exists: both arms mint as before.
            let unsettled_rlm_work = match weak_root.as_ref().and_then(std::sync::Weak::upgrade) {
                Some(root) => crate::print_rlm::has_unsettled_rlm_work(&root).await,
                None => false,
            };
            match goal
                .natural_continuation(&engine, &model, unsettled_rlm_work)
                .await
            {
                NaturalContinuation::QueuedInput | NaturalContinuation::RequestedCompaction => {
                    Ok(Vec::new())
                }
                NaturalContinuation::ThresholdDue => {
                    // Unsettled inline-subagent work holds the mint (the
                    // daemon checks it before the threshold arm): the
                    // post-settle drive decides, the boundary still
                    // compacts.
                    if unsettled_rlm_work && autonomous.hold_rlm_continuation().await {
                        return Ok(Vec::new());
                    }
                    // The autonomous continuation the threshold arm owes: the run ends,
                    // the boundary compacts, the driver admits the held turn.
                    if let Some(text) = autonomous.follow_up_text(&context.message).await {
                        autonomous.hold_threshold_continuation(text).await;
                    }
                    Ok(Vec::new())
                }
                NaturalContinuation::HeldForRlmWork => {
                    // The goal deferral rides the driver's owed flag; the
                    // run ends and the quiescence drive delivers it after
                    // the settle.
                    Ok(Vec::new())
                }
                NaturalContinuation::GoalRow(row) => Ok(vec![*row]),
                NaturalContinuation::FallThrough => {
                    // The natural autonomous mint runs as the next turn
                    // of the same run; while inline-subagent work is
                    // unsettled only a flag is held (nothing is spent
                    // pre-settle) and the drive decides after the settle.
                    if unsettled_rlm_work && autonomous.hold_rlm_continuation().await {
                        return Ok(Vec::new());
                    }
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
