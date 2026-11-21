use serde_json::{json, Map, Value};

use super::*;

/// The canonical index of the join `[review-a, review-b] -> triage`.
const JOIN: usize = 4;

/// The compiled form of a plan, two parallel reviews, a join, and a route.
fn spec(run: &Value) -> Value {
    json!({
        "run": run,
        "states": [
            {"id": "design"}, {"id": "review-a"}, {"id": "review-b"},
            {"id": "triage"}, {"id": "ship"},
        ],
        "transitions": [
            {"from": "design", "to": "review-a"},
            {"from": "design", "to": "review-b"},
            {"from": "triage", "to": "ship", "when": {"output": "action", "op": "eq", "value": "ship"}},
            {"from": "triage", "to": "design", "when": {"output": "action", "op": "eq", "value": "rework"}},
            {"from": ["review-a", "review-b"], "to": "triage"},
        ],
    })
}

fn start(run: &Value) -> Run {
    Run::start(&spec(run), 0).unwrap()
}

/// A transition into a state with entries left.
fn open(join: Option<JoinClaim>) -> Fire {
    Fire {
        target_entries_used: 0,
        target_max_entries: 1,
        join,
    }
}

fn settled(a: u64, b: u64) -> impl Fn(&str) -> SourceProgress {
    move |source| match source {
        "review-a" => SourceProgress::Settled(a),
        _ => SourceProgress::Settled(b),
    }
}

fn ready(run: &Run, a: u64, b: u64) -> JoinClaim {
    match run.evaluate_join(JOIN, settled(a, b)) {
        Some(JoinOutcome::Ready(claim)) => claim,
        other => panic!("expected a ready join, got {other:?}"),
    }
}

const EVENTS: [RunEvent; 8] = [
    RunEvent::Admit,
    RunEvent::Fire,
    RunEvent::Pause(PauseReason::Escalate),
    RunEvent::Resume,
    RunEvent::Finish,
    RunEvent::Fail,
    RunEvent::Stop,
    RunEvent::StopComplete,
];

#[test]
fn a_run_moves_through_pause_resume_finish_and_stop() {
    let mut run = start(&json!({}));
    let seen: Vec<RunStatus> = [
        RunEvent::Pause(PauseReason::Escalate),
        RunEvent::Resume,
        RunEvent::Finish,
        RunEvent::Stop,
        RunEvent::StopComplete,
    ]
    .into_iter()
    .map(|event| run.apply(event, 0).unwrap())
    .collect();
    assert_eq!(
        seen,
        [
            RunStatus::Paused(PauseReason::Escalate),
            RunStatus::Running,
            RunStatus::Done,
            RunStatus::Stopping,
            RunStatus::Stopped,
        ]
    );
}

#[test]
fn resume_on_a_running_run_is_an_illegal_transition() {
    let mut run = start(&json!({}));
    assert_eq!(
        run.apply(RunEvent::Resume, 0),
        Err(IllegalTransition {
            from: RunStatus::Running,
            event: RunEvent::Resume,
        })
    );
    assert_eq!(run.status(), RunStatus::Running);
}

#[test]
fn fire_on_a_paused_run_is_an_illegal_transition() {
    let mut run = start(&json!({}));
    run.apply(RunEvent::Pause(PauseReason::Escalate), 0)
        .unwrap();
    assert_eq!(
        run.fire(open(None), 0),
        Err(IllegalTransition {
            from: RunStatus::Paused(PauseReason::Escalate),
            event: RunEvent::Fire,
        })
    );
    assert_eq!(run.transitions_fired(), 0);
}

#[test]
fn a_stopped_run_accepts_no_event() {
    let refused: Vec<bool> = EVENTS
        .into_iter()
        .map(|event| RunStatus::Stopped.next(event).is_err())
        .collect();
    assert_eq!(refused, [true; 8]);
}

#[test]
fn a_stopping_run_accepts_only_stop_and_stop_complete() {
    let accepted: Vec<RunEvent> = EVENTS
        .into_iter()
        .filter(|&event| RunStatus::Stopping.next(event).is_ok())
        .collect();
    assert_eq!(accepted, [RunEvent::Stop, RunEvent::StopComplete]);
}

#[test]
fn a_join_waits_for_every_source() {
    let run = start(&json!({}));
    let outcome = run.evaluate_join(JOIN, |source| match source {
        "review-a" => SourceProgress::Settled(0),
        _ => SourceProgress::Unsettled,
    });
    assert_eq!(outcome, Some(JoinOutcome::Unsettled));
}

#[test]
fn a_join_waits_for_a_live_source() {
    let run = start(&json!({}));
    let outcome = run.evaluate_join(JOIN, |source| match source {
        "review-a" => SourceProgress::Live,
        _ => SourceProgress::Settled(0),
    });
    assert_eq!(outcome, Some(JoinOutcome::Live));
}

#[test]
fn a_join_defers_while_an_arrival_is_queued() {
    let run = start(&json!({}));
    let outcome = run.evaluate_join(JOIN, |source| match source {
        "review-b" => SourceProgress::ArrivalQueued,
        _ => SourceProgress::Settled(0),
    });
    assert_eq!(outcome, Some(JoinOutcome::ArrivalQueued));
}

#[test]
fn a_single_source_transition_is_not_a_join() {
    let run = start(&json!({}));
    assert_eq!(run.evaluate_join(0, settled(0, 0)), None);
}

#[test]
fn a_join_fires_one_time_for_each_settle_combination() {
    let mut run = start(&json!({}));
    let claim = ready(&run, 0, 0);
    assert_eq!(run.fire(open(Some(claim)), 0), Ok(FireOutcome::Fired));
    assert_eq!(
        run.evaluate_join(JOIN, settled(0, 0)),
        Some(JoinOutcome::Stale)
    );
    ready(&run, 0, 1);
}

#[test]
fn a_blocked_join_consumes_its_settle_combination() {
    let mut run = start(&json!({}));
    let fire = Fire {
        target_entries_used: 1,
        target_max_entries: 1,
        join: Some(ready(&run, 0, 0)),
    };
    assert_eq!(run.fire(fire, 0), Ok(FireOutcome::Blocked));
    assert_eq!(
        run.evaluate_join(JOIN, settled(0, 0)),
        Some(JoinOutcome::Stale)
    );
    assert_eq!(run.transitions_fired(), 0);
}

#[test]
fn a_max_transitions_pause_does_not_consume_the_join() {
    let mut run = start(&json!({"max_transitions": 1}));
    run.fire(open(None), 0).unwrap();
    let claim = ready(&run, 0, 0);
    assert_eq!(
        run.fire(open(Some(claim.clone())), 0),
        Ok(FireOutcome::Paused)
    );
    assert_eq!(run.status(), RunStatus::Paused(PauseReason::MaxTransitions));
    assert_eq!(ready(&run, 0, 0), claim);
}

#[test]
fn max_transitions_pauses_the_run_one_time() {
    let mut run = start(&json!({"max_transitions": 1}));
    let mut outcomes = vec![
        run.fire(open(None), 0).unwrap(),
        run.fire(open(None), 0).unwrap(),
    ];
    run.apply(RunEvent::Resume, 0).unwrap();
    outcomes.push(run.fire(open(None), 0).unwrap());
    outcomes.push(run.fire(open(None), 0).unwrap());
    assert_eq!(
        outcomes,
        [
            FireOutcome::Fired,
            FireOutcome::Paused,
            FireOutcome::Fired,
            FireOutcome::Fired,
        ]
    );
}

#[test]
fn the_run_budget_excludes_paused_time() {
    let mut run = start(&json!({"budget_ms": 1000}));
    run.apply(RunEvent::Pause(PauseReason::Escalate), 600)
        .unwrap();
    run.apply(RunEvent::Resume, 5600).unwrap();
    assert_eq!(run.active_ms(5900), 900);
    assert_eq!(run.admit(ChildKind::Agent, 5900), Ok(Admission::Admit));
    assert_eq!(
        run.admit(ChildKind::Agent, 6500),
        Ok(Admission::Paused(PauseReason::Budget))
    );
}

#[test]
fn the_run_budget_pauses_admission_one_time() {
    let mut run = start(&json!({"budget_ms": 1000}));
    assert_eq!(
        run.admit(ChildKind::Python, 2000),
        Ok(Admission::Paused(PauseReason::Budget))
    );
    run.apply(RunEvent::Resume, 3000).unwrap();
    assert_eq!(run.admit(ChildKind::Python, 9000), Ok(Admission::Admit));
}

#[test]
fn the_child_budget_counts_agent_children_only() {
    let mut run = start(&json!({"max_children": 1}));
    let admissions = [
        run.admit(ChildKind::Agent, 0),
        run.admit(ChildKind::Python, 0),
        run.admit(ChildKind::Agent, 0),
    ];
    assert_eq!(
        admissions,
        [
            Ok(Admission::Admit),
            Ok(Admission::Admit),
            Ok(Admission::Paused(PauseReason::MaxChildren)),
        ]
    );
}

#[test]
fn a_state_budget_measures_the_child_run_time_first() {
    assert_eq!(
        [
            state_budget_overrun(1000, 900, 5000),
            state_budget_overrun(1000, 1200, 0),
            state_budget_overrun(1000, 0, 1500),
        ],
        [None, Some(1200), Some(1500)]
    );
}

#[test]
fn a_python_time_limit_takes_the_state_then_the_run_budget() {
    assert_eq!(
        [
            python_time_limit_ms(Some(5), Some(9)),
            python_time_limit_ms(None, Some(9)),
            python_time_limit_ms(None, None),
        ],
        [5, 9, PYTHON_TIME_LIMIT_MS_DEFAULT]
    );
}

#[test]
fn a_guard_compares_the_routed_value_strictly() {
    let guard = Guard {
        port: "verdict".to_string(),
        path: Some("decision.ok".to_string()),
        value: json!(true),
    };
    let outputs = |value: Value| -> Map<String, Value> {
        json!({"verdict": {"decision": {"ok": value}}})
            .as_object()
            .unwrap()
            .clone()
    };
    assert_eq!(
        [
            guard.passes(&outputs(json!(true))),
            guard.passes(&outputs(json!(1))),
            guard.passes(&Map::new()),
        ],
        [true, false, false]
    );
}

#[test]
fn the_index_lists_a_join_under_every_source() {
    let run = start(&json!({}));
    let outgoing = |state: &str| -> Vec<usize> {
        run.transitions()
            .outgoing(state)
            .map(|(index, _)| index)
            .collect()
    };
    assert_eq!(
        [
            outgoing("review-a"),
            outgoing("review-b"),
            outgoing("triage")
        ],
        [vec![JOIN], vec![JOIN], vec![2, 3]]
    );
}

#[test]
fn the_index_refuses_a_guard_other_than_eq() {
    let spec = json!({"transitions": [
        {"from": "a", "to": "b", "when": {"output": "n", "op": "gt", "value": 1}},
    ]});
    assert_eq!(
        TransitionIndex::from_spec(&spec),
        Err(SpecError(
            "transitions[0]: the guard op Some(\"gt\") is not \"eq\"".to_string()
        ))
    );
}

#[test]
fn the_limits_default_to_ten_transitions_for_each_state() {
    assert_eq!(
        RunLimits::from_spec(&spec(&json!({"budget_ms": 60_000}))),
        RunLimits {
            budget_ms: Some(60_000),
            max_transitions: 50,
            max_children: MAX_CHILDREN_DEFAULT,
        }
    );
}
