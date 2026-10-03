//! The routing-criteria battery: gates, refusal streaks, repetition,
//! terminal reasons, budgets, and the abort contract.

use std::sync::Arc;
use std::time::Duration;

use pa_agent::abort::AbortController;

use super::super::decide::{RouterDecisionFn, RouterDecisionOutcome};
use super::super::test_support as support;
use super::super::types::{RouterGateSpec, RouterModelInfo, RouterRunStatus};
use super::*;

fn model() -> RouterModelInfo {
    RouterModelInfo {
        provider: "test".to_string(),
        id: "action-model".to_string(),
        thinking_level: "off".to_string(),
    }
}

fn options(
    env: Arc<support::ScriptedEnvironment>,
    decide: RouterDecisionFn,
) -> SystemRouterLoopOptions {
    SystemRouterLoopOptions {
        env,
        goal: "reach the overworld".to_string(),
        actions: support::sample_action_space(),
        decide,
        model: model(),
        gate: RouterGateSpec::default(),
        max_steps: 10,
        timeout_ms: 5_000,
        budget_ms: None,
        history_steps: 8,
        observation_chars: 6_000,
        signal: None,
    }
}

#[tokio::test]
async fn finish_ends_the_segment_done() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("title screen"));
    let result = run_system_router_loop(options(
        Arc::clone(&env),
        support::scripted_decide(vec![support::valid_decision(FINISH_ACTION, &[], 0.9)]),
    ))
    .await
    .unwrap();
    assert_eq!(result.status, RouterRunStatus::Done);
    assert_eq!(result.reason, "goal_reached");
    assert_eq!(result.steps, 1);
    assert_eq!(result.executed, 0);
    assert!(result.trace[0].terminal);
    assert_eq!(result.trace[0].action.as_deref(), Some(FINISH_ACTION));
    assert_eq!(result.trace[0].thinking_level, "off");
    assert_eq!(result.usage.input_tokens, 7);
    assert_eq!(result.usage.output_tokens, 3);
    assert_eq!(*env.closes.lock().unwrap(), 1);
    assert_eq!(
        result.summary,
        "Goal declared reached at step 0 after 0 executed action(s)."
    );
}

#[tokio::test]
async fn a_terminal_observation_ends_the_segment_done() {
    let mut terminal = support::observation("the ending credits roll");
    terminal.terminal = true;
    let env = support::ScriptedEnvironment::new(vec![terminal]);
    let result =
        run_system_router_loop(options(Arc::clone(&env), support::scripted_decide(vec![])))
            .await
            .unwrap();
    assert_eq!(result.status, RouterRunStatus::Done);
    assert_eq!(result.reason, "environment_terminal");
    assert_eq!(result.steps, 0);
    assert!(env.calls.lock().unwrap().contains(&"reset".to_string()));
}

/// A terminal observation that completes in the same poll the segment
/// deadline fires wins the biased race; its terminal state must land as
/// `done`, not be dropped as a timeout for a finished episode.
#[tokio::test(start_paused = true)]
async fn a_terminal_observation_at_the_deadline_lands() {
    let mut terminal = support::observation("the ending credits roll");
    terminal.terminal = true;
    let env = support::ScriptedEnvironment::new(vec![terminal]).with_observe_delay_ms(50);
    let mut options = options(Arc::clone(&env), support::scripted_decide(vec![]));
    options.timeout_ms = 50;
    let result = run_system_router_loop(options).await.unwrap();
    assert_eq!(result.status, RouterRunStatus::Done);
    assert_eq!(result.reason, "environment_terminal");
    assert_eq!(result.steps, 0);
    assert_eq!(result.executed, 0);
    assert_eq!(
        result.summary,
        "Environment reported terminal state at step 0 after 0 executed action(s)."
    );
}

/// The leftover-budget check still fires for a non-terminal observation that
/// wins the biased race: a drained segment must not dispatch a decision.
#[tokio::test(start_paused = true)]
async fn a_non_terminal_observation_at_the_deadline_times_out() {
    let env = support::ScriptedEnvironment::new(vec![support::observation("slow")])
        .with_observe_delay_ms(50);
    // An empty decision script: a dispatched decision would fail the run as
    // a decision_model_error instead of the timeout this test pins.
    let mut options = options(Arc::clone(&env), support::scripted_decide(vec![]));
    options.timeout_ms = 50;
    let result = run_system_router_loop(options).await.unwrap();
    assert_eq!(result.status, RouterRunStatus::Incomplete);
    assert_eq!(result.reason, "timeout");
    assert_eq!(result.steps, 0);
    assert!(result.summary.contains("elapsed while observing"));
}

#[tokio::test]
async fn a_terminal_execution_ends_the_segment_done() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("boss room"))
        .then_execute("the boss falls", true);
    let result = run_system_router_loop(options(
        Arc::clone(&env),
        support::scripted_decide(vec![support::valid_decision(
            "press",
            &[("button", "a")],
            0.9,
        )]),
    ))
    .await
    .unwrap();
    assert_eq!(result.status, RouterRunStatus::Done);
    assert_eq!(result.reason, "environment_terminal");
    assert_eq!(result.executed, 1);
    assert!(result.trace[0].terminal);
    assert_eq!(result.trace[0].result, "the boss falls");
}

#[tokio::test]
async fn escalation_is_honored_even_at_zero_confidence() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("stuck"));
    let result = run_system_router_loop(options(
        Arc::clone(&env),
        support::scripted_decide(vec![support::valid_decision(ESCALATE_ACTION, &[], 0.0)]),
    ))
    .await
    .unwrap();
    assert_eq!(result.status, RouterRunStatus::Escalated);
    assert_eq!(result.reason, "escalation_requested");
    assert_eq!(result.trace[0].gate.threshold, 0.0);
    assert_eq!(result.trace[0].gate.verdict, RouterGateVerdict::Pass);
}

#[tokio::test]
async fn three_low_confidence_decisions_end_the_segment_stuck() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("wall"));
    let low = || support::valid_decision("press", &[("button", "a")], 0.2);
    let result = run_system_router_loop(options(
        Arc::clone(&env),
        support::scripted_decide(vec![low(), low(), low()]),
    ))
    .await
    .unwrap();
    assert_eq!(result.status, RouterRunStatus::Stuck);
    assert_eq!(result.reason, "no_confident_decision");
    assert_eq!(result.refused, 3);
    assert_eq!(result.executed, 0);
    assert_eq!(result.steps, 3);
    assert_eq!(result.trace[0].gate.verdict, RouterGateVerdict::Refused);
    assert_eq!(result.trace[0].gate.threshold, 0.6);
    assert_eq!(
        result.trace[0].result,
        "refused: confidence 0.20 below write gate 0.60"
    );
}

/// A below-gate `finish` refusal names the `finish` gate its threshold came
/// from, not the `read` risk the action is compiled with.
#[tokio::test]
async fn a_below_gate_finish_refusal_names_the_finish_gate() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("title screen"));
    let low_finish = || support::valid_decision(FINISH_ACTION, &[], 0.4);
    let mut run_options = options(
        Arc::clone(&env),
        support::scripted_decide(vec![low_finish(), low_finish(), low_finish()]),
    );
    // Diverge the gates: `read` is loose, `finish` is strict, so a refusal
    // labeled `read` would also expose the wrong threshold source.
    run_options.gate = RouterGateSpec {
        read: Some(0.1),
        write: Some(0.1),
        destructive: Some(0.1),
        finish: Some(0.9),
    };
    let result = run_system_router_loop(run_options).await.unwrap();
    assert_eq!(result.status, RouterRunStatus::Stuck);
    assert_eq!(result.reason, "no_confident_decision");
    assert_eq!(result.refused, 3);
    assert_eq!(result.trace[0].gate.threshold, 0.9);
    assert_eq!(result.trace[0].gate.verdict, RouterGateVerdict::Refused);
    assert_eq!(
        result.trace[0].result,
        "refused: confidence 0.40 below finish gate 0.90"
    );
}

#[tokio::test]
async fn three_unparseable_decisions_end_the_segment_stuck() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("wall"));
    let refused = || support::refused_decision("unknown action \"jump\"");
    let result = run_system_router_loop(options(
        Arc::clone(&env),
        support::scripted_decide(vec![refused(), refused(), refused()]),
    ))
    .await
    .unwrap();
    assert_eq!(result.status, RouterRunStatus::Stuck);
    assert_eq!(result.reason, "no_confident_decision");
    assert_eq!(result.refused, 3);
    assert_eq!(
        result.trace[0].gate.verdict,
        RouterGateVerdict::ParseFailure
    );
    assert_eq!(result.trace[0].result, "refused: unknown action \"jump\"");
}

/// A decision naming an action outside the compiled space is refused exactly
/// like a parse failure.
#[tokio::test]
async fn an_unknown_action_from_the_decider_is_refused() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("wall"));
    let result = run_system_router_loop(options(
        Arc::clone(&env),
        support::scripted_decide(vec![
            support::valid_decision("ghost", &[], 0.99),
            support::valid_decision(FINISH_ACTION, &[], 0.99),
        ]),
    ))
    .await
    .unwrap();
    assert_eq!(result.status, RouterRunStatus::Done);
    assert_eq!(result.refused, 1);
    assert_eq!(
        result.trace[0].result,
        "refused: decision was not a valid choice"
    );
}

#[tokio::test]
async fn repeating_one_action_on_the_same_observation_ends_the_segment_stuck() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("wall"))
        .then_execute("nothing changes", false);
    let decision = || support::valid_decision("press", &[("button", "a")], 0.9);
    let result = run_system_router_loop(options(
        Arc::clone(&env),
        support::scripted_decide(vec![decision(), decision()]),
    ))
    .await
    .unwrap();
    assert_eq!(result.status, RouterRunStatus::Stuck);
    assert_eq!(result.reason, "repeated_state");
    assert_eq!(result.executed, 1);
    assert_eq!(result.refused, 1);
    assert_eq!(
        result.trace[1].result,
        "repeated press on the same observation 2 times"
    );
}

/// The repetition signature includes the params: a different parameter value
/// on the same observation is new work, not a repeat.
#[tokio::test]
async fn a_different_parameter_value_is_not_a_repeat() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("menu"))
        .then_execute("a highlighted", false)
        .then_execute("b highlighted", false);
    let result = run_system_router_loop(options(
        Arc::clone(&env),
        support::scripted_decide(vec![
            support::valid_decision("press", &[("button", "a")], 0.9),
            support::valid_decision("press", &[("button", "b")], 0.9),
            support::valid_decision(FINISH_ACTION, &[], 0.9),
        ]),
    ))
    .await
    .unwrap();
    assert_eq!(result.status, RouterRunStatus::Done);
    assert_eq!(result.executed, 2);
    assert_eq!(result.refused, 0);
}

/// The observation moving resets the repetition counts: the same action on a
/// new observation is new work.
#[tokio::test]
async fn a_new_observation_resets_the_repetition_counts() {
    let env = support::ScriptedEnvironment::new(vec![
        support::observation("frame one"),
        support::observation("frame two"),
    ])
    .then_execute("advanced", false)
    .then_execute("advanced", false);
    let decision = || support::valid_decision("press", &[("button", "a")], 0.9);
    let result = run_system_router_loop(options(
        Arc::clone(&env),
        support::scripted_decide(vec![
            decision(),
            decision(),
            support::valid_decision(FINISH_ACTION, &[], 0.9),
        ]),
    ))
    .await
    .unwrap();
    assert_eq!(result.status, RouterRunStatus::Done);
    assert_eq!(result.executed, 2);
    assert_eq!(result.refused, 0);
}

/// A passing decision clears the refusal streak.
#[tokio::test]
async fn a_passing_decision_resets_the_refusal_streak() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("wall"))
        .then_execute("screen advanced", false);
    let refused = || support::refused_decision("unknown action \"jump\"");
    let result = run_system_router_loop(options(
        Arc::clone(&env),
        support::scripted_decide(vec![
            refused(),
            refused(),
            support::valid_decision("look", &[], 0.9),
            refused(),
            refused(),
            support::valid_decision(FINISH_ACTION, &[], 0.9),
        ]),
    ))
    .await
    .unwrap();
    assert_eq!(result.status, RouterRunStatus::Done);
    assert_eq!(result.refused, 4);
    assert_eq!(result.executed, 1);
}

#[tokio::test]
async fn the_step_budget_ends_the_segment_incomplete() {
    let env = support::ScriptedEnvironment::new(vec![
        support::observation("step one"),
        support::observation("step two"),
    ])
    .then_execute("one", false)
    .then_execute("two", false);
    let mut options = options(
        Arc::clone(&env),
        support::scripted_decide(vec![
            support::valid_decision("look", &[], 0.9),
            support::valid_decision("look", &[], 0.9),
        ]),
    );
    options.max_steps = 2;
    let result = run_system_router_loop(options).await.unwrap();
    assert_eq!(result.status, RouterRunStatus::Incomplete);
    assert_eq!(result.reason, "max_steps");
    assert_eq!(result.executed, 2);
    assert!(result.summary.contains("segment step budget is exhausted"));
}

#[tokio::test]
async fn the_wall_clock_budget_ends_the_segment_incomplete() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("slow"));
    let mut options = options(Arc::clone(&env), support::slow_decide());
    options.timeout_ms = 100;
    let started = std::time::Instant::now();
    let result = run_system_router_loop(options).await.unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the segment budget bounds the decision wait"
    );
    assert_eq!(result.status, RouterRunStatus::Incomplete);
    assert_eq!(result.reason, "timeout");
    assert!(result.summary.contains("elapsed mid-decision"));
}

#[tokio::test]
async fn a_model_failure_fails_the_segment_and_records_the_step() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("wall"));
    let result = run_system_router_loop(options(
        Arc::clone(&env),
        support::scripted_decide(vec![support::model_error_decision(
            "decision model stopped early (length)",
        )]),
    ))
    .await
    .unwrap();
    assert_eq!(result.status, RouterRunStatus::Failed);
    assert_eq!(result.reason, "decision_model_error");
    assert_eq!(result.steps, 1);
    assert_eq!(
        result.trace[0].result,
        "decision model stopped early (length)"
    );
    assert_eq!(
        result.trace[0].gate.verdict,
        RouterGateVerdict::ParseFailure
    );
}

#[tokio::test]
async fn a_decider_error_fails_the_segment() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("wall"));
    let decide: RouterDecisionFn =
        Arc::new(move |_request| Box::pin(async move { Err(anyhow::anyhow!("transport down")) }));
    let result = run_system_router_loop(options(Arc::clone(&env), decide))
        .await
        .unwrap();
    assert_eq!(result.status, RouterRunStatus::Failed);
    assert_eq!(result.reason, "decision_model_error");
    assert_eq!(result.steps, 0);
    assert!(result.summary.contains("Decision function threw at step 0"));
}

#[tokio::test]
async fn an_environment_failure_is_reported_at_each_phase() {
    let reset_env = support::ScriptedEnvironment::with_observation(support::observation("x"))
        .reset_with(Some("no rom"));
    let result = run_system_router_loop(options(
        Arc::clone(&reset_env),
        support::scripted_decide(vec![]),
    ))
    .await
    .unwrap();
    assert_eq!(result.status, RouterRunStatus::Failed);
    assert_eq!(result.reason, "environment_error");
    assert!(result
        .summary
        .contains("failed resetting at segment start: no rom"));

    let execute_env = support::ScriptedEnvironment::with_observation(support::observation("x"))
        .then_execute_error("adapter crashed");
    let result = run_system_router_loop(options(
        Arc::clone(&execute_env),
        support::scripted_decide(vec![support::valid_decision("look", &[], 0.9)]),
    ))
    .await
    .unwrap();
    assert_eq!(result.status, RouterRunStatus::Failed);
    assert_eq!(result.reason, "environment_error");
    // A dispatched action with an unknown outcome still counts as executed.
    assert_eq!(result.executed, 1);
    assert!(result.summary.contains("outcome unknown"));
}

#[tokio::test]
async fn usage_accumulates_across_steps() {
    let env = support::ScriptedEnvironment::new(vec![
        support::observation("one"),
        support::observation("two"),
    ])
    .then_execute("one", false)
    .then_execute("two", false);
    let result = run_system_router_loop(options(
        Arc::clone(&env),
        support::scripted_decide(vec![
            support::valid_decision("look", &[], 0.9),
            support::valid_decision("look", &[], 0.9),
            support::valid_decision(FINISH_ACTION, &[], 0.9),
        ]),
    ))
    .await
    .unwrap();
    assert_eq!(result.usage.input_tokens, 21);
    assert_eq!(result.usage.output_tokens, 9);
}

/// A pre-aborted signal never mutates the environment.
#[tokio::test]
async fn a_pre_aborted_signal_fails_before_reset() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("x"));
    let controller = AbortController::new();
    controller.abort();
    let mut options = options(Arc::clone(&env), support::scripted_decide(vec![]));
    options.signal = Some(controller.signal());
    let result = run_system_router_loop(options).await.unwrap();
    assert_eq!(result.status, RouterRunStatus::Failed);
    assert_eq!(result.reason, "aborted");
    assert_eq!(result.summary, "Router aborted before reset.");
    assert!(env.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_abort_mid_decision_fails_the_segment() {
    let env = support::ScriptedEnvironment::with_observation(support::observation("x"));
    let controller = AbortController::new();
    let aborting = controller.clone();
    let decide: RouterDecisionFn = Arc::new(move |_request| {
        let aborting = aborting.clone();
        Box::pin(async move {
            aborting.abort();
            tokio::time::sleep(Duration::from_millis(50)).await;
            Ok(support::valid_decision(FINISH_ACTION, &[], 0.99))
        })
    });
    let mut options = options(Arc::clone(&env), decide);
    options.signal = Some(controller.signal());
    let result = run_system_router_loop(options).await.unwrap();
    assert_eq!(result.status, RouterRunStatus::Failed);
    assert_eq!(result.reason, "aborted");
    assert!(!result.summary.contains("Goal declared reached"));
}

/// The gate defaults are the documented `SystemOneHarness` values.
#[tokio::test]
async fn the_default_gates_match_the_documented_thresholds() {
    let outcome = RouterDecisionOutcome {
        action: Some("look".to_string()),
        params: BTreeMap::default(),
        confidence: Some(0.5),
        parse_error: None,
        model_error: None,
        usage: None,
    };
    let env = support::ScriptedEnvironment::with_observation(support::observation("x"))
        .then_execute("ok", false);
    let result = run_system_router_loop(options(
        Arc::clone(&env),
        support::scripted_decide(vec![
            outcome,
            support::valid_decision(FINISH_ACTION, &[], 0.5),
        ]),
    ))
    .await
    .unwrap();
    // read gate 0.5: exactly at the threshold passes.
    assert_eq!(result.executed, 1);
    assert_eq!(result.status, RouterRunStatus::Done);
}
