//! The goal driver's test battery.

use super::*;
use crate::goals::MAX_THREAD_GOAL_OBJECTIVE_CHARS;
use crate::session::manager::SessionManager;
use pa_types::ai::UserContent;
use std::fmt::Write as _;

/// The latest persisted goal state with the terminal row reverted:
/// the newest ACTIVE streak-3 row.
fn session_rows_with_reverted_terminal(session: &mut SessionManager) -> GoalState {
    let mut state = session.active_goal_state().unwrap_or_else(empty_goal_state);
    if state.status == GoalStatus::Error {
        state = GoalState {
            active: true,
            status: GoalStatus::Active,
            last_reason: None,
            last_error: None,
            ..state
        };
    }
    state
}

fn persisted_session() -> SessionManager {
    let dir = tempfile::TempDir::new().unwrap();
    let session_dir = dir.path().join("session");
    std::fs::create_dir_all(&session_dir).unwrap();
    let mut session = SessionManager::in_memory(dir.path());
    session.materialize_session_file(Some(session_dir));
    session
}

/// A failed provider turn in the pa-agent wire shape, carrying the
/// `provider_stream_failure` diagnostic.
fn test_error_turn(
    kind: &str,
    status: Option<u16>,
    error: &str,
    timestamp: i64,
) -> pa_agent::types::AssistantMessage {
    pa_agent::types::AssistantMessage {
        content: Vec::new(),
        api: String::new(),
        provider: "test".to_string(),
        model: "m".to_string(),
        response_model: None,
        response_id: None,
        diagnostics: Some(vec![pa_agent::types::AssistantMessageDiagnostic {
            kind: "provider_stream_failure".to_string(),
            timestamp: 0,
            error: None,
            details: Some(serde_json::json!({
                "kind": kind,
                "status": status,
            })),
        }]),
        usage: pa_agent::types::Usage::zero(),
        stop_reason: pa_agent::types::StopReason::Error,
        stop_reason_raw: None,
        error_message: Some(error.to_string()),
        timestamp,
    }
}

/// A turn that settled without output and without a provider failure.
fn test_empty_turn(timestamp: i64) -> pa_agent::types::AssistantMessage {
    pa_agent::types::AssistantMessage {
        content: Vec::new(),
        api: String::new(),
        provider: "test".to_string(),
        model: "m".to_string(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: pa_agent::types::Usage::zero(),
        stop_reason: pa_agent::types::StopReason::Stop,
        stop_reason_raw: None,
        error_message: None,
        timestamp,
    }
}

fn test_progress_turn(timestamp: i64) -> pa_agent::types::AssistantMessage {
    pa_agent::types::AssistantMessage {
        content: vec![pa_agent::types::AssistantContent::Text(
            pa_agent::types::TextContent {
                text: "made progress".to_string(),
                text_signature: None,
            },
        )],
        api: String::new(),
        provider: "test".to_string(),
        model: "m".to_string(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: pa_agent::types::Usage::zero(),
        stop_reason: pa_agent::types::StopReason::Stop,
        stop_reason_raw: None,
        error_message: None,
        timestamp,
    }
}

/// A failed provider turn in the session wire shape (the durable
/// row the stale-row scan reads).
fn wire_error_turn(
    kind: &str,
    status: Option<u16>,
    error: &str,
    timestamp: u64,
) -> pa_types::ai::AssistantMessage {
    pa_types::ai::AssistantMessage {
        content: Vec::new(),
        api: "openai-completions".to_string(),
        provider: "test".to_string(),
        model: "m".to_string(),
        response_model: None,
        response_id: None,
        diagnostics: Some(vec![pa_types::ai::AssistantMessageDiagnostic {
            type_: "provider_stream_failure".to_string(),
            timestamp: 0,
            error: None,
            details: Some(
                serde_json::json!({
                    "kind": kind,
                    "status": status,
                })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            ),
        }]),
        usage: pa_types::ai::Usage::default(),
        stop_reason: pa_types::ai::StopReason::Error,
        stop_reason_raw: None,
        error_message: Some(error.to_string()),
        timestamp,
        rest: serde_json::Map::default(),
    }
}

fn usage(input: u64, output: u64) -> pa_types::ai::Usage {
    pa_types::ai::Usage {
        input,
        output,
        ..Default::default()
    }
}

#[tokio::test]
async fn compacted_goal_restore_and_mutation_do_not_hydrate_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("goal.jsonl");
    let expected = GoalState {
        active: true,
        status: GoalStatus::Active,
        goal_id: Some("goal".to_owned()),
        objective: Some("finish work".to_owned()),
        tokens_used: 17,
        ..empty_goal_state()
    };
    let rows = [
        serde_json::json!({"type":"session","version":3,"id":"s","cwd":"/tmp","timestamp":"2026-01-01T00:00:00Z"}),
        serde_json::json!({"type":"custom","id":"goal","parentId":null,"customType":GOAL_STATE_CUSTOM_TYPE,"data":expected}),
        serde_json::json!({"type":"message","id":"old","parentId":"goal","message":{"role":"user","content":"old history","timestamp":0}}),
        serde_json::json!({"type":"message","id":"kept","parentId":"old","message":{"role":"user","content":"retained","timestamp":0}}),
        serde_json::json!({"type":"compaction","id":"compact","parentId":"kept","summary":"summary","firstKeptEntryId":"kept","tokensBefore":1000}),
        serde_json::json!({"type":"custom","id":"invalid","parentId":"compact","customType":GOAL_STATE_CUSTOM_TYPE,"data":{"active":true}}),
    ];
    let original: String = rows.iter().fold(String::new(), |mut output, row| {
        let _ = writeln!(output, "{row}");
        output
    });
    std::fs::write(&path, &original).unwrap();
    let mut session = SessionManager::open_windowed(dir.path(), dir.path(), &path)
        .await
        .unwrap();
    assert!(!session.is_full_history());
    assert!(!GoalDriver::is_branch_seedable(&session));
    let mut driver = GoalDriver::load_persisted(&session);
    assert_eq!(driver.state(), &expected);
    driver.pause(&mut session, "pause").unwrap();
    assert_eq!(GoalDriver::load_persisted(&session).state(), driver.state());
    assert!(!session.is_full_history());
    assert!(std::fs::read_to_string(&path)
        .unwrap()
        .starts_with(&original));
}

#[test]
fn start_resume_pause_lifecycle() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    assert_eq!(driver.state(), &empty_goal_state());
    let goal = driver
        .start(&mut session, "  ship the mission  ", Some(1000))
        .unwrap();
    assert_eq!(goal.status, GoalStatus::Active);
    assert_eq!(goal.objective.as_deref(), Some("ship the mission"));
    assert_eq!(goal.token_budget, Some(1000));
    assert!(goal.goal_id.is_some());
    assert!(driver.owns_continuation_wakeup());
    assert!(driver.start(&mut session, "", None).is_err());
    let long = "x".repeat(MAX_THREAD_GOAL_OBJECTIVE_CHARS + 1);
    assert!(driver.start(&mut session, &long, None).is_err());
    assert!(driver.start(&mut session, "ok", Some(0)).is_err());
    driver.pause(&mut session, "Paused by user").unwrap();
    assert_eq!(driver.state().status, GoalStatus::Paused);
    assert!(!driver.owns_continuation_wakeup());
    let continuation = driver.resume(&mut session).unwrap().unwrap();
    assert_eq!(
        continuation.custom_type,
        crate::goals::GOAL_CONTEXT_CUSTOM_TYPE
    );
    let UserContent::Text(text) = &continuation.content else {
        panic!("expected text content");
    };
    assert!(text.starts_with("[goal: continuation]"));
    let reloaded = GoalDriver::load_persisted(&session);
    assert_eq!(reloaded.state().status, GoalStatus::Active);
    assert_eq!(
        reloaded.state().objective.as_deref(),
        Some("ship the mission")
    );
    driver.clear(&mut session).unwrap();
    assert_eq!(driver.state().status, GoalStatus::Idle);
    assert_eq!(driver.state().objective, None);
}

#[test]
fn usage_accounting_and_budget_limit() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", Some(100)).unwrap();
    assert_eq!(
        driver
            .record_assistant_usage(&mut session, "a1", &usage(30, 10))
            .unwrap(),
        UsageOutcome::Accounted
    );
    assert_eq!(driver.state().tokens_used, 40);
    assert_eq!(
        driver
            .record_assistant_usage(&mut session, "a1", &usage(30, 10))
            .unwrap(),
        UsageOutcome::Ignored
    );
    assert_eq!(driver.state().tokens_used, 40);
    assert_eq!(
        driver
            .record_assistant_usage(&mut session, "a2", &usage(50, 10))
            .unwrap(),
        UsageOutcome::BudgetReached
    );
    assert_eq!(driver.state().status, GoalStatus::BudgetLimited);
    assert_eq!(
        driver.state().last_reason.as_deref(),
        Some("Reached 100 token goal budget")
    );
    assert_eq!(
        driver
            .record_assistant_usage(&mut session, "a3", &usage(50, 10))
            .unwrap(),
        UsageOutcome::Ignored
    );
    assert!(driver.resume(&mut session).unwrap().is_none());
    assert_eq!(driver.state().status, GoalStatus::BudgetLimited);
}

#[test]
fn terminal_messages_fail_or_keep_the_goal() {
    use pa_types::ai::StopReason;
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    driver
        .finish_for_terminal_message(&mut session, StopReason::Aborted, None)
        .unwrap();
    assert_eq!(driver.state().status, GoalStatus::Active);
    driver
        .finish_for_terminal_message(&mut session, StopReason::Error, Some("provider exploded"))
        .unwrap();
    assert_eq!(driver.state().status, GoalStatus::Error);
    assert_eq!(
        driver.state().last_error.as_deref(),
        Some("provider exploded")
    );
    driver
        .finish_for_terminal_message(&mut session, StopReason::Error, None)
        .unwrap();
    assert_eq!(driver.state().status, GoalStatus::Error);
}

#[test]
fn continuations_increment() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    let first = driver
        .next_continuation_message(&mut session, None)
        .unwrap()
        .unwrap();
    let UserContent::Text(text) = &first.content else {
        panic!("expected text content");
    };
    assert!(text.contains("- status: active"));
    assert_eq!(driver.state().continuations_used, 1);
    // The first mint's admission releases the pending guard: the next boundary mints again.
    driver.continuation_consumed();
    assert!(driver
        .next_continuation_message(&mut session, None)
        .unwrap()
        .is_some());
    assert_eq!(driver.state().continuations_used, 2);
    driver.pause(&mut session, "Paused by user").unwrap();
    assert!(driver
        .next_continuation_message(&mut session, None)
        .unwrap()
        .is_none());
    driver.start(&mut session, "work again", None).unwrap();
    assert!(driver
        .next_continuation_message(&mut session, None)
        .unwrap()
        .is_some());
    assert_eq!(driver.state().continuations_used, 1);
    let reloaded = GoalDriver::load_persisted(&session);
    assert_eq!(reloaded.state().continuations_used, 1);
}

#[test]
fn the_mint_refuses_and_finishes_on_an_errored_turn() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    let created_at = driver.state().created_at.unwrap();
    let corpse = test_error_turn(
        "server_error",
        None,
        "402 Payment required: wallet drained",
        created_at as i64 + 1,
    );
    assert!(driver
        .next_continuation_message(&mut session, Some(&corpse))
        .unwrap()
        .is_none());
    assert_eq!(driver.state().status, GoalStatus::Error);
    assert_eq!(
        driver.state().last_error.as_deref(),
        Some("402 Payment required: wallet drained")
    );
    assert!(!driver.owns_continuation_wakeup());
    assert_eq!(
        GoalDriver::load_persisted(&session).state().status,
        GoalStatus::Error
    );
}

/// A rate-limited corpse never triggers the hard finish; it counts toward the no-output backoff.
#[test]
fn a_rate_limited_turn_keeps_the_goal_alive() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    let created_at = driver.state().created_at.unwrap();
    let parked = test_error_turn(
        "rate_limit",
        Some(429),
        "429 Too many concurrent requests",
        created_at as i64 + 1,
    );
    assert!(driver
        .next_continuation_message(&mut session, Some(&parked))
        .unwrap()
        .is_none());
    assert_eq!(driver.state().status, GoalStatus::Active);
    assert!(driver.state().last_error.is_none());
    // Inside the refusal's backoff window even a progress row refuses.
    let wake_progress = test_progress_turn(created_at as i64 + 2);
    assert!(driver
        .next_continuation_message(&mut session, Some(&wake_progress))
        .unwrap()
        .is_none());
    // The park's wake, minutes later: both refusal windows have
    // elapsed, and the NEW progress turn mints.
    driver.no_progress_backoff_until_ms = 0;
    driver.parked_refusal_until_ms = 0;
    assert!(driver
        .next_continuation_message(&mut session, Some(&wake_progress))
        .unwrap()
        .is_some());
    assert_eq!(driver.state().continuations_used, 1);
}

#[test]
fn no_output_turns_count_to_the_cap_and_backoff() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    let created_at = driver.state().created_at.unwrap();
    let empty_one = test_empty_turn(created_at as i64 + 1);
    // The streak is DURABLE (the persisted row carries it, so a worker
    // restart cannot reset the strikes).
    assert!(driver
        .next_continuation_message(&mut session, Some(&empty_one))
        .unwrap()
        .is_none());
    assert_eq!(driver.state().status, GoalStatus::Active);
    assert_eq!(driver.state().continuations_used, 0);
    assert_eq!(driver.state().no_progress_streak, Some(1));
    assert!(driver
        .next_continuation_message(&mut session, Some(&empty_one))
        .unwrap()
        .is_none());
    assert_eq!(driver.state().no_progress_streak, Some(1));
    // A rebuilt driver adopts the persisted strikes and the counted-turn key:
    // the same corpse never strikes twice across rebuilds.
    let mut driver = GoalDriver::load_persisted(&session);
    assert_eq!(driver.state().no_progress_streak, Some(1));
    assert_eq!(driver.no_progress_streak(), 1);
    // Re-consulted after the restart: NOT re-counted (the dedup is durable),
    // and the backoff window does not survive the restart.
    let reconsult = driver
        .next_continuation_message(&mut session, Some(&empty_one))
        .unwrap();
    assert!(reconsult.is_some(), "the restart retries the mint");
    assert_eq!(driver.no_progress_streak(), 1);
    driver.continuation_consumed();
    // A fresh corpse after the restart: counted again (the restart's
    // counted-turn key starts empty).
    let empty_two = test_empty_turn(created_at as i64 + 2);
    assert!(driver
        .next_continuation_message(&mut session, Some(&empty_two))
        .unwrap()
        .is_none());
    assert_eq!(driver.state().no_progress_streak, Some(2));
    assert_eq!(driver.state().status, GoalStatus::Active);
    // A progress turn resets the streak and mints.
    let progress = test_progress_turn(created_at as i64 + 3);
    assert!(driver
        .next_continuation_message(&mut session, Some(&progress))
        .unwrap()
        .is_some());
    assert_eq!(driver.state().continuations_used, 2);
    assert_eq!(driver.state().no_progress_streak, Some(0));
    for offset in 4..=6 {
        let empty = test_empty_turn(created_at as i64 + offset);
        assert!(driver
            .next_continuation_message(&mut session, Some(&empty))
            .unwrap()
            .is_none());
    }
    assert_eq!(driver.state().status, GoalStatus::Error);
    assert_eq!(
        driver.state().last_reason.as_deref(),
        Some("Goal continuation cap reached: consecutive turns made no progress")
    );
    assert_eq!(
        GoalDriver::load_persisted(&session).state().status,
        GoalStatus::Error
    );
}

/// Only a turn the goal's own lifetime produced (timestamp after `created_at`) can judge it.
#[test]
fn a_stale_pre_goal_corpse_never_finishes_the_new_goal() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    let created_at = driver.state().created_at.unwrap();
    let stale = test_error_turn(
        "invalid_request",
        Some(400),
        "an old corpse from before the goal began",
        created_at as i64 - 1000,
    );
    assert!(driver
        .next_continuation_message(&mut session, Some(&stale))
        .unwrap()
        .is_some());
    assert_eq!(driver.state().status, GoalStatus::Active);
    assert_eq!(driver.state().continuations_used, 1);
    // A stale pre-goal EMPTY row does not count toward the cap either.
    driver.continuation_consumed();
    let stale_empty = test_empty_turn(created_at as i64 - 500);
    assert!(driver
        .next_continuation_message(&mut session, Some(&stale_empty))
        .unwrap()
        .is_some());
    assert_eq!(driver.state().no_progress_streak, Some(0));
}

#[test]
fn a_replacement_goal_starts_with_a_fresh_streak() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "first", None).unwrap();
    let created_at = driver.state().created_at.unwrap();
    let empty = test_empty_turn(created_at as i64 + 1);
    assert!(driver
        .next_continuation_message(&mut session, Some(&empty))
        .unwrap()
        .is_none());
    assert_eq!(driver.state().no_progress_streak, Some(1));
    driver
        .finish_for_terminal_message(
            &mut session,
            pa_types::ai::StopReason::Error,
            Some("provider exploded"),
        )
        .unwrap();
    driver.start(&mut session, "second", None).unwrap();
    assert_eq!(driver.state().no_progress_streak, Some(0));
    let fresh_created = driver.state().created_at.unwrap();
    let first_empty = test_empty_turn(fresh_created as i64 + 1);
    let second_empty = test_empty_turn(fresh_created as i64 + 2);
    for empty in [first_empty, second_empty] {
        assert!(driver
            .next_continuation_message(&mut session, Some(&empty))
            .unwrap()
            .is_none());
    }
    assert_eq!(driver.state().status, GoalStatus::Active);
    assert_eq!(driver.state().no_progress_streak, Some(2));
    assert_eq!(
        GoalDriver::load_persisted(&session)
            .state()
            .no_progress_streak,
        Some(2)
    );
}

#[test]
fn rate_limit_and_empty_text_corpses_and_the_examined_gate() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    let created_at = driver.state().created_at.unwrap();

    // (1) Three parked corpses: no strikes, the goal stays alive.
    for offset in 1..=3 {
        let parked = test_error_turn(
            "rate_limit",
            Some(429),
            "429 Too many concurrent requests",
            created_at as i64 + offset,
        );
        assert!(driver
            .next_continuation_message(&mut session, Some(&parked))
            .unwrap()
            .is_none());
    }
    assert_eq!(driver.no_progress_streak(), 0);
    assert_eq!(driver.state().status, GoalStatus::Active);

    // (2) The abort conversion's empty-text corpse counts as no-output
    // (the bare is_empty check would have mistaken it for progress).
    let mut empty_text = test_progress_turn(created_at as i64 + 10);
    empty_text.content = vec![pa_agent::types::AssistantContent::Text(
        pa_agent::types::TextContent {
            text: String::new(),
            text_signature: None,
        },
    )];
    assert!(driver
        .next_continuation_message(&mut session, Some(&empty_text))
        .unwrap()
        .is_none());
    assert_eq!(driver.no_progress_streak(), 1);

    // (3) The drop-revealed OLDER progress row: the examined gate
    // skips it — the strike survives.
    let older_progress = test_progress_turn(created_at as i64 + 5);
    assert!(driver
        .next_continuation_message(&mut session, Some(&older_progress))
        .unwrap()
        .is_none());
    assert_eq!(driver.no_progress_streak(), 1, "the older row never resets");

    // A NEWER progress row still resets.
    let newer_progress = test_progress_turn(created_at as i64 + 20);
    assert!(driver
        .next_continuation_message(&mut session, Some(&newer_progress))
        .unwrap()
        .is_some());
    assert_eq!(driver.no_progress_streak(), 0);
    driver.continuation_consumed();
}

/// The examined-turn dedup keys on the millisecond timestamp (the operator's
/// ruling) — NOT a total order across settle paths: the kill is UNCONDITIONAL.
#[test]
fn a_terminal_error_sharing_the_millisecond_still_refuses() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    let created_at = driver.state().created_at.unwrap();

    // Strike one: a no-output turn at millisecond T (the examined key adopts T).
    let empty = test_empty_turn(created_at as i64 + 1000);
    assert!(driver
        .next_continuation_message(&mut session, Some(&empty))
        .unwrap()
        .is_none());
    assert_eq!(driver.no_progress_streak(), 1);

    // A TERMINAL provider error at the same millisecond T: the dedup alone
    // would skip it (`T > T` is false); the unconditional kill finishes the goal.
    let same_ms_corpse = test_error_turn(
        "invalid_request",
        Some(400),
        "402 Insufficient balance (team wallet drained)",
        created_at as i64 + 1000,
    );
    assert!(driver
        .next_continuation_message(&mut session, Some(&same_ms_corpse))
        .unwrap()
        .is_none());
    assert_eq!(driver.state().status, GoalStatus::Error);
    assert_eq!(
        driver.state().last_error.as_deref(),
        Some("402 Insufficient balance (team wallet drained)")
    );
    // An EARLIER-millisecond terminal error on a fresh goal refuses
    // too (the wall clock is not monotonic across settle paths).
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    let created_at = driver.state().created_at.unwrap();
    assert!(driver
        .next_continuation_message(
            &mut session,
            Some(&test_empty_turn(created_at as i64 + 2000))
        )
        .unwrap()
        .is_none());
    assert!(driver
        .next_continuation_message(
            &mut session,
            Some(&test_error_turn(
                "invalid_request",
                Some(400),
                "an earlier-ms terminal error",
                created_at as i64 + 1999,
            ))
        )
        .unwrap()
        .is_none());
    assert_eq!(driver.state().status, GoalStatus::Error);
}

/// A same-ms pre-goal row never judges the new goal — the gate requires a
/// STRICTLY later turn — and a parked refusal clears an earlier strike's window.
#[test]
fn a_same_ms_pre_goal_corpse_never_judges_the_new_goal() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    let created_at = driver.state().created_at.unwrap();

    // A pre-goal corpse at the goal's own creation millisecond: the
    // strict-later gate excludes it.
    let same_ms = test_error_turn(
        "invalid_request",
        Some(400),
        "a corpse from before the goal began, same millisecond",
        created_at as i64,
    );
    assert!(driver
        .next_continuation_message(&mut session, Some(&same_ms))
        .unwrap()
        .is_some());
    assert_eq!(driver.state().status, GoalStatus::Active);
    driver.continuation_consumed();

    // A turn a millisecond LATER is the goal's own and judges it.
    let next_ms = test_error_turn(
        "invalid_request",
        Some(400),
        "the goal's own corpse, one millisecond later",
        created_at as i64 + 1,
    );
    assert!(driver
        .next_continuation_message(&mut session, Some(&next_ms))
        .unwrap()
        .is_none());
    assert_eq!(driver.state().status, GoalStatus::Error);
}

#[test]
fn a_parked_refusal_clears_an_earlier_strikes_window() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    let created_at = driver.state().created_at.unwrap();

    // Strike one: the backoff window arms.
    let empty = test_empty_turn(created_at as i64 + 1);
    assert!(driver
        .next_continuation_message(&mut session, Some(&empty))
        .unwrap()
        .is_none());
    assert_eq!(driver.no_progress_streak(), 1);
    assert!(driver.backoff_wake_at().is_some());

    // The parked refusal CLEARS the strike's window: no wake during
    // the park.
    let parked = test_error_turn(
        "rate_limit",
        Some(429),
        "429 Too many concurrent requests",
        created_at as i64 + 2,
    );
    assert!(driver
        .next_continuation_message(&mut session, Some(&parked))
        .unwrap()
        .is_none());
    assert!(
        driver.backoff_wake_at().is_none(),
        "no wake during the park"
    );
    assert_eq!(driver.no_progress_streak(), 1, "the strike stays durable");
}

#[test]
fn the_rate_limit_refusal_sticks_across_reconsults() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    let created_at = driver.state().created_at.unwrap();
    let parked = test_error_turn(
        "rate_limit",
        Some(429),
        "429 Too many concurrent requests",
        created_at as i64 + 1,
    );
    assert!(driver
        .next_continuation_message(&mut session, Some(&parked))
        .unwrap()
        .is_none());
    assert_eq!(driver.state().status, GoalStatus::Active);
    assert_eq!(driver.no_progress_streak(), 0);
    assert!(driver
        .next_continuation_message(&mut session, Some(&parked))
        .unwrap()
        .is_none());
    let older_progress = test_progress_turn(created_at as i64 - 1);
    assert!(driver
        .next_continuation_message(&mut session, Some(&older_progress))
        .unwrap()
        .is_none());
    assert_eq!(
        driver.no_progress_streak(),
        0,
        "no strikes for parked corpses"
    );
}

#[test]
fn a_restored_goal_at_the_cap_finishes_at_the_first_consult() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    let created_at = driver.state().created_at.unwrap();
    for offset in 1..=3 {
        let empty = test_empty_turn(created_at as i64 + offset);
        driver
            .next_continuation_message(&mut session, Some(&empty))
            .unwrap();
    }
    assert_eq!(driver.state().status, GoalStatus::Error);
    // Simulate the interrupted terminal transition: the streak-3
    // Active row stays newest.
    let rows = session_rows_with_reverted_terminal(&mut session);
    let mut driver = GoalDriver::restore_persisted(rows);
    assert_eq!(driver.state().status, GoalStatus::Active);
    assert_eq!(driver.no_progress_streak(), 3);
    assert!(driver
        .next_continuation_message(&mut session, Some(&test_empty_turn(created_at as i64 + 3)))
        .unwrap()
        .is_none());
    assert_eq!(driver.state().status, GoalStatus::Error);
    assert_eq!(
        driver.state().last_reason.as_deref(),
        Some("Goal continuation cap reached: consecutive turns made no progress")
    );
}

#[test]
fn load_persisted_adopts_the_stale_active_failure() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    // The corpse message persists after the newest goal row: the
    // interrupted-settle ordering.
    driver
        .next_continuation_message(&mut session, None)
        .unwrap();
    session
        .append_message(pa_types::session::AgentMessage::Assistant(wire_error_turn(
            "invalid_request",
            Some(402),
            "402 Insufficient balance",
            0,
        )))
        .unwrap();
    let rehydrated = GoalDriver::load_persisted(&session);
    assert_eq!(rehydrated.state().status, GoalStatus::Error);
    assert_eq!(
        rehydrated.state().last_error.as_deref(),
        Some("402 Insufficient balance")
    );
    // The rate-limit corpse is the park's pause: the goal
    // resurrects.
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    driver
        .next_continuation_message(&mut session, None)
        .unwrap();
    session
        .append_message(pa_types::session::AgentMessage::Assistant(wire_error_turn(
            "rate_limit",
            Some(429),
            "429 Too many requests",
            0,
        )))
        .unwrap();
    assert_eq!(
        GoalDriver::load_persisted(&session).state().status,
        GoalStatus::Active
    );
    // A settled terminal row is the newest row: no stale adoption.
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    driver
        .finish_for_terminal_message(
            &mut session,
            pa_types::ai::StopReason::Error,
            Some("settled failure"),
        )
        .unwrap();
    assert_eq!(
        GoalDriver::load_persisted(&session).state().status,
        GoalStatus::Error
    );
}

#[test]
fn owed_continuation_defers_and_delivers_once() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    assert!(!driver.owes_continuation());
    driver.mark_continuation_owed();
    assert!(driver.owes_continuation());
    assert_eq!(driver.state().continuations_used, 0);
    let delivered = driver
        .take_owed_continuation(&mut session, None)
        .unwrap()
        .unwrap();
    let UserContent::Text(text) = &delivered.content else {
        panic!("expected text content");
    };
    assert!(text.starts_with("[goal: continuation]"));
    assert_eq!(driver.state().continuations_used, 1);
    assert!(!driver.owes_continuation());
    assert!(driver
        .take_owed_continuation(&mut session, None)
        .unwrap()
        .is_none());
    assert_eq!(driver.state().continuations_used, 1);
    driver.mark_continuation_owed();
    driver.pause(&mut session, "Paused by user").unwrap();
    assert!(driver
        .take_owed_continuation(&mut session, None)
        .unwrap()
        .is_none());
    assert_eq!(driver.state().continuations_used, 1);
    assert!(!driver.owes_continuation());
    driver.mark_continuation_owed();
    driver.clear(&mut session).unwrap();
    assert!(!driver.owes_continuation());
    driver.start(&mut session, "again", None).unwrap();
    driver.mark_continuation_owed();
    driver.start(&mut session, "once more", None).unwrap();
    assert!(!driver.owes_continuation());
}

#[test]
fn rollback_continuation_mint_restores_the_count() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    assert!(driver
        .next_continuation_message(&mut session, None)
        .unwrap()
        .is_some());
    assert_eq!(driver.state().continuations_used, 1);
    driver.rollback_continuation_mint(&mut session).unwrap();
    assert_eq!(driver.state().continuations_used, 0);
    assert_eq!(
        GoalDriver::load_persisted(&session)
            .state()
            .continuations_used,
        0
    );
    assert!(driver
        .next_continuation_message(&mut session, None)
        .unwrap()
        .is_some());
    assert_eq!(driver.state().continuations_used, 1);
}

#[test]
fn resume_resolves_the_existing_goal() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "ship it", None).unwrap();
    driver.pause(&mut session, "Paused by user").unwrap();
    let paused = driver.state().clone();
    assert!(driver.resume(&mut session).unwrap().is_some());
    assert_eq!(driver.state().goal_id, paused.goal_id);
    assert_eq!(driver.state().objective.as_deref(), Some("ship it"));
    assert_eq!(driver.state().status, GoalStatus::Active);
    assert!(driver.state().last_reason.is_none());
    let mut limited = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut limited, "ship it", Some(100)).unwrap();
    driver
        .record_assistant_usage(&mut limited, "a1", &usage(120, 0))
        .unwrap();
    assert_eq!(driver.state().status, GoalStatus::BudgetLimited);
    assert!(driver.resume(&mut limited).unwrap().is_none());
    assert_eq!(driver.state().status, GoalStatus::BudgetLimited);
    assert_eq!(
        driver.state().last_reason.as_deref(),
        Some("Goal token budget already reached")
    );
}

#[test]
fn restore_persisted_adopts_the_state_without_rewriting_it() {
    let state = GoalState {
        active: true,
        status: GoalStatus::Active,
        goal_id: Some("goal-1".to_string()),
        objective: Some("ship the port".to_string()),
        token_budget: Some(1000),
        tokens_used: 340,
        time_used_seconds: 12,
        continuations_used: 2,
        created_at: Some(1),
        no_progress_streak: Some(2),
        no_progress_turn_ms: None,
        updated_at: Some(2),
        last_reason: None,
        last_error: None,
    };
    let driver = GoalDriver::restore_persisted(state);
    assert_eq!(driver.state().status, GoalStatus::Active);
    assert_eq!(driver.state().objective.as_deref(), Some("ship the port"));
    assert_eq!(driver.state().tokens_used, 340);
    assert_eq!(driver.state().continuations_used, 2);
    assert_eq!(driver.no_progress_streak(), 2);
    assert!(driver.owns_continuation_wakeup());
    assert_eq!(driver.active_objective().as_deref(), Some("ship the port"));
    let limited = GoalDriver::restore_persisted(GoalState {
        active: false,
        status: GoalStatus::BudgetLimited,
        objective: Some("ship the port".to_string()),
        continuations_used: 5,
        tokens_used: 1000,
        token_budget: Some(1000),
        ..empty_goal_state()
    });
    assert!(!limited.owns_continuation_wakeup());
    assert!(limited.active_objective().is_none());
    let mut session = persisted_session();
    let mut driver = GoalDriver::restore_persisted(GoalState {
        active: true,
        status: GoalStatus::Active,
        objective: Some("ship the port".to_string()),
        continuations_used: 2,
        ..empty_goal_state()
    });
    assert!(driver
        .next_continuation_message(&mut session, None)
        .unwrap()
        .is_some());
    assert_eq!(driver.state().continuations_used, 3);
}

#[test]
fn branch_seedable_rules() {
    let mut session = persisted_session();
    assert!(GoalDriver::is_branch_seedable(&session));
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    assert!(!GoalDriver::is_branch_seedable(&session));
    let mut other = persisted_session();
    other
        .append_message(pa_types::session::AgentMessage::User(
            pa_types::ai::UserMessage {
                content: UserContent::Text("hi".to_string()),
                timestamp: 0,
                rest: serde_json::Map::default(),
            },
        ))
        .unwrap();
    assert!(!GoalDriver::is_branch_seedable(&other));
}

/// Append one raw `thread_goal_state` row so a reload can observe a
/// branch entry the driver did not write itself.
fn append_goal_row(session: &mut SessionManager, state: &GoalState) {
    let value = serde_json::to_value(state).unwrap();
    session
        .append_custom_entry(GOAL_STATE_CUSTOM_TYPE, Some(value))
        .unwrap();
}

#[test]
fn same_timeline_reload_never_regresses_the_same_goal() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "do work", None).unwrap();
    let goal_id = driver.state().goal_id.clone();
    assert_eq!(driver.state().status, GoalStatus::Active);

    assert_eq!(
        driver
            .record_assistant_usage(&mut session, "a1", &usage(40, 10))
            .unwrap(),
        UsageOutcome::Accounted
    );
    assert!(driver.state().tokens_used >= 50);

    // A stale persisted snapshot for the SAME goal: an older
    // accounting entry re-persisted after the newer usage.
    append_goal_row(
        &mut session,
        &GoalState {
            tokens_used: 1,
            continuations_used: 0,
            time_used_seconds: 0,
            ..driver.state().clone()
        },
    );

    driver.reload_from_branch(&session, GoalBranchReload::SameTimeline);
    assert_eq!(driver.state().status, GoalStatus::Active);
    assert_eq!(driver.state().goal_id, goal_id);
    assert!(driver.state().tokens_used >= 50);

    driver.reload_from_branch(&session, GoalBranchReload::FaithfulBranch);
    assert_eq!(driver.state().goal_id, goal_id);
    assert_eq!(driver.state().tokens_used, 1);
}

#[test]
fn same_timeline_reload_keeps_a_fired_budget_gate() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "do work", Some(100)).unwrap();
    let goal_id = driver.state().goal_id.clone();

    assert_eq!(
        driver
            .record_assistant_usage(&mut session, "a1", &usage(60, 50))
            .unwrap(),
        UsageOutcome::BudgetReached
    );
    assert_eq!(driver.state().status, GoalStatus::BudgetLimited);

    // A stale branch snapshot for the same goal predates the gate.
    append_goal_row(
        &mut session,
        &GoalState {
            active: true,
            status: GoalStatus::Active,
            tokens_used: 10,
            ..driver.state().clone()
        },
    );

    driver.reload_from_branch(&session, GoalBranchReload::SameTimeline);
    assert_eq!(driver.state().status, GoalStatus::BudgetLimited);
    assert_eq!(driver.state().goal_id, goal_id);
    assert!(driver.state().tokens_used >= 110);
}

/// A different goal adopts faithfully even under the same-timeline
/// rule (the clamp is same-goal only).
#[test]
fn same_timeline_reload_adopts_a_different_goal_faithfully() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "first goal", None).unwrap();
    assert_eq!(
        driver
            .record_assistant_usage(&mut session, "a1", &usage(40, 10))
            .unwrap(),
        UsageOutcome::Accounted
    );

    append_goal_row(
        &mut session,
        &GoalState {
            active: true,
            status: GoalStatus::Active,
            goal_id: Some("other-goal".to_string()),
            objective: Some("second goal".to_string()),
            tokens_used: 3,
            continuations_used: 0,
            time_used_seconds: 0,
            ..empty_goal_state()
        },
    );
    driver.reload_from_branch(&session, GoalBranchReload::SameTimeline);
    assert_eq!(driver.state().goal_id.as_deref(), Some("other-goal"));
    assert_eq!(driver.state().objective.as_deref(), Some("second goal"));
    assert_eq!(driver.state().tokens_used, 3);

    // A newer persisted state adopts faithfully as well: the branch's
    // own row wins when the ids differ.
    append_goal_row(
        &mut session,
        &GoalState {
            active: true,
            status: GoalStatus::Active,
            goal_id: Some("other-goal".to_string()),
            objective: Some("second goal".to_string()),
            tokens_used: 500,
            continuations_used: 4,
            time_used_seconds: 9,
            ..empty_goal_state()
        },
    );
    driver.reload_from_branch(&session, GoalBranchReload::FaithfulBranch);
    assert_eq!(driver.state().tokens_used, 500);
    assert_eq!(driver.state().continuations_used, 4);
    assert_eq!(driver.state().time_used_seconds, 9);
}

#[test]
fn reload_skips_invalid_rows() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "do work", None).unwrap();

    // An invalid row lands after the valid one.
    session
        .append_custom_entry(
            GOAL_STATE_CUSTOM_TYPE,
            Some(serde_json::json!({
                "active": true,
                "status": "active",
            })),
        )
        .unwrap();
    driver.reload_from_branch(&session, GoalBranchReload::FaithfulBranch);
    assert_eq!(driver.state().status, GoalStatus::Active);
    assert!(driver.state().goal_id.is_some());

    let mut fresh = persisted_session();
    fresh
        .append_message(pa_types::session::AgentMessage::User(
            pa_types::ai::UserMessage {
                content: UserContent::Text("no goal here".to_string()),
                timestamp: 0,
                rest: serde_json::Map::default(),
            },
        ))
        .unwrap();
    driver.reload_from_branch(&fresh, GoalBranchReload::FaithfulBranch);
    assert_eq!(driver.state(), &empty_goal_state());
}

/// The operator's exact case (2026-09-28): a goal created ~2 hours
/// ago reads ~2 hours, and no accounting write compounds it.
#[test]
fn creation_based_timer_reads_the_goals_age() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver
        .start(&mut session, "make the visualizer", None)
        .unwrap();
    // The goal was created 2 hours ago (a rehydrated driver adopts the
    // persisted `created_at`).
    let two_hours_ago = now_millis().saturating_sub(2 * 60 * 60 * 1000);
    let mut reloaded = GoalDriver::restore_persisted(GoalState {
        created_at: Some(two_hours_ago),
        ..GoalDriver::latest_persisted_state(&session)
    });
    // A dozen accounting events must not compound the timer: the read
    // recomputes `now - created_at` fresh every time.
    for index in 0..12 {
        let mut usage = usage(30, 10);
        usage.output += index;
        assert_eq!(
            reloaded
                .record_assistant_usage(&mut session, &format!("a{index}"), &usage)
                .unwrap(),
            UsageOutcome::Accounted
        );
    }
    let elapsed = reloaded.state_with_creation_elapsed();
    assert_eq!(elapsed.status, GoalStatus::Active);
    // The generous upper bound tolerates a descheduled CI worker
    // between the fabricated anchor and the read.
    assert!(
        (7_190..=7_260).contains(&elapsed.time_used_seconds),
        "a 2h-old goal reads ~2h, got {}",
        elapsed.time_used_seconds
    );
    // The persisted rows carry the age at write, never an accumulated
    // value.
    assert!(
        (7_190..=7_260).contains(&reloaded.state().time_used_seconds),
        "the durable row carries the age: {}",
        reloaded.state().time_used_seconds
    );
    let idle = GoalDriver::new();
    assert_eq!(idle.state_with_creation_elapsed().time_used_seconds, 0);
}

/// The paused goal displays the same creation-based age (the
/// operator's ruling).
#[test]
fn paused_goal_reads_its_age() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "ship it", None).unwrap();
    driver.pause(&mut session, "Paused by user").unwrap();
    assert_eq!(driver.state().status, GoalStatus::Paused);
    assert!(driver.state().created_at.is_some());
    assert!(
        driver.state_with_creation_elapsed().time_used_seconds <= 60,
        "a freshly paused goal reads its (small) age"
    );
    let two_hours_ago = now_millis().saturating_sub(2 * 60 * 60 * 1000);
    let reloaded = GoalDriver::restore_persisted(GoalState {
        created_at: Some(two_hours_ago),
        ..GoalDriver::latest_persisted_state(&session)
    });
    let elapsed = reloaded.state_with_creation_elapsed();
    assert_eq!(elapsed.status, GoalStatus::Paused);
    assert!(
        (7_190..=7_260).contains(&elapsed.time_used_seconds),
        "a paused 2h-old goal reads its age, got {}",
        elapsed.time_used_seconds
    );
}

#[test]
fn rows_without_created_at_backfill_from_updated_at() {
    let mut session = persisted_session();
    let legacy = GoalState {
        active: true,
        status: GoalStatus::Active,
        goal_id: Some("legacy-goal".to_string()),
        objective: Some("legacy pursuit".to_string()),
        tokens_used: 100,
        time_used_seconds: 900,
        continuations_used: 2,
        created_at: None,
        updated_at: Some(now_millis().saturating_sub(60 * 60 * 1000)),
        ..empty_goal_state()
    };
    append_goal_row(&mut session, &legacy);
    let driver = GoalDriver::load_persisted(&session);
    assert_eq!(
        driver.state().created_at,
        driver.state().updated_at,
        "the legacy goal backfills created_at from updated_at"
    );
    let elapsed = driver.state_with_creation_elapsed();
    assert!(
        (3_590..=3_660).contains(&elapsed.time_used_seconds),
        "a legacy 1h-old goal reads ~1h, got {}",
        elapsed.time_used_seconds
    );
    let mut fresh = persisted_session();
    fresh
        .append_message(pa_types::session::AgentMessage::User(
            pa_types::ai::UserMessage {
                content: UserContent::Text("no goal".to_string()),
                timestamp: 0,
                rest: serde_json::Map::default(),
            },
        ))
        .unwrap();
    assert_eq!(GoalDriver::load_persisted(&fresh).state().created_at, None);
}

#[test]
fn pending_continuation_never_re_arms() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    assert!(driver
        .next_continuation_message(&mut session, None)
        .unwrap()
        .is_some());
    assert!(driver.pending_continuation());
    assert!(
        driver
            .next_continuation_message(&mut session, None)
            .unwrap()
            .is_none(),
        "a pending continuation must not re-arm another"
    );
    assert_eq!(driver.state().continuations_used, 1);
    // The arm never fires BESIDE a pending mint: the pending mint IS
    // this boundary's queued delivery.
    driver.mark_continuation_owed();
    assert!(
        !driver.owes_continuation(),
        "the arm is a no-op while a mint is pending"
    );
    // An arm that fired BEFORE the mint waits behind it: the take
    // refuses until the admission releases the guard.
    driver.continuation_consumed();
    assert!(!driver.pending_continuation());
    driver.mark_continuation_owed();
    assert!(driver.owes_continuation());
    assert!(
        driver
            .next_continuation_message(&mut session, None)
            .unwrap()
            .is_some(),
        "a direct mint lands while an earlier arm waits"
    );
    assert!(driver.pending_continuation());
    assert!(driver
        .take_owed_continuation(&mut session, None)
        .unwrap()
        .is_none());
    assert!(driver.owes_continuation());
    assert_eq!(driver.state().continuations_used, 2);
    driver.continuation_consumed();
    let delivered = driver.take_owed_continuation(&mut session, None).unwrap();
    assert!(delivered.is_some());
    assert!(!driver.owes_continuation());
    assert!(driver.pending_continuation());
    assert_eq!(driver.state().continuations_used, 3);
    driver.rollback_continuation_mint(&mut session).unwrap();
    assert!(!driver.pending_continuation());
    assert_eq!(driver.state().continuations_used, 2);
    assert!(driver
        .next_continuation_message(&mut session, None)
        .unwrap()
        .is_some());
    assert!(driver.pending_continuation());
    driver.pause(&mut session, "Paused by user").unwrap();
    assert!(!driver.pending_continuation());
    assert!(
        driver
            .next_continuation_message(&mut session, None)
            .unwrap()
            .is_none(),
        "an inactive goal mints nothing"
    );
    driver.start(&mut session, "again", None).unwrap();
    assert!(!driver.pending_continuation());
    assert!(driver
        .next_continuation_message(&mut session, None)
        .unwrap()
        .is_some());
    driver.clear(&mut session).unwrap();
    assert!(!driver.pending_continuation());
}
