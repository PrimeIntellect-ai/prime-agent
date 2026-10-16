//! The print run's autonomous continuation loop — the in-run drive (the
//! ambiguity, resolved against the TS binary).
//!
//! TS ruling: the continuation rides the natural-turn-end hook, churning
//! INSIDE the one prompt wait. A stop never writes a row or stream frame
//! (the headless exit contract reports it); a threshold compaction queues
//! the continuation as a `followUp` admission. The goal arm runs first.

use std::sync::atomic::{AtomicBool, Ordering};
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
    let stop_eligible = Arc::new(AtomicBool::new(false));
    let eligibility = Arc::clone(&stop_eligible);
    let eligibility_engine = weak_engine.clone();
    let eligibility_goal = weak_goal.clone();
    let eligibility_autonomous = weak_autonomous.clone();
    let eligibility_model = Arc::clone(&model);
    let eligibility_root = weak_root.clone();
    agent.set_stop_hook_eligibility(Some(Arc::new(move || {
        let eligibility = Arc::clone(&eligibility);
        let weak_engine = eligibility_engine.clone();
        let weak_goal = eligibility_goal.clone();
        let weak_autonomous = eligibility_autonomous.clone();
        let model = Arc::clone(&eligibility_model);
        let weak_root = eligibility_root.clone();
        Box::pin(async move {
            let (Some(engine), Some(goal), Some(_autonomous)) = (
                weak_engine.upgrade(),
                weak_goal.upgrade(),
                weak_autonomous.upgrade(),
            ) else {
                return false;
            };
            // Probe only; rerunning either continuation driver here would
            // consume work or repeat autonomous acceptance commands.
            if !eligibility.load(Ordering::Acquire)
                || goal.has_queued_input().await
                || engine.turn_boundary.compaction_scheduled().await
            {
                return false;
            }
            let unsettled_rlm_work = match weak_root.as_ref().and_then(std::sync::Weak::upgrade) {
                Some(root) => crate::print_rlm::has_unsettled_rlm_work(&root).await,
                None => false,
            };
            if unsettled_rlm_work {
                return false;
            }
            let goal_owns_boundary = engine.goal_driver.lock().await.owns_continuation_wakeup();
            !goal_owns_boundary && !engine.session.auto_compaction_due(&model).await
        }) as pa_agent::BoxFut<'static, bool>
    })));
    agent.set_continuation_hook(Some(Arc::new(move |context, signal| {
        stop_eligible.store(false, Ordering::Release);
        let stop_eligible = Arc::clone(&stop_eligible);
        let weak_engine = weak_engine.clone();
        let weak_goal = weak_goal.clone();
        let weak_autonomous = weak_autonomous.clone();
        let weak_root = weak_root.clone();
        let model = Arc::clone(&model);
        Box::pin(async move {
            if signal.is_aborted() {
                return Ok(Vec::new());
            }
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
                    // Hold autonomous work until inline descendants settle;
                    // final Stop must not compete with that boundary owner.
                    if unsettled_rlm_work && autonomous.hold_rlm_continuation().await {
                        return Ok(Vec::new());
                    }
                    if let Some(text) = autonomous.follow_up_text(&context.message).await {
                        Ok(vec![autonomous_continuation_row(&text)])
                    } else {
                        stop_eligible.store(!signal.is_aborted(), Ordering::Release);
                        Ok(Vec::new())
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
