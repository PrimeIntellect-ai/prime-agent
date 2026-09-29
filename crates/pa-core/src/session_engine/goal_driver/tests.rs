//! The goal driver's test battery (split out of the parent module: the
//! driver's core lifecycle and the progress child each stay under the
//! repo's file-size bar).

use super::*;
use crate::goals::MAX_THREAD_GOAL_OBJECTIVE_CHARS;
use crate::session::manager::SessionManager;
use pa_types::ai::UserContent;
use std::fmt::Write as _;

/// The latest persisted goal state with the terminal row reverted:
/// the newest ACTIVE streak-3 row (the interrupted-transition shape).
fn session_rows_with_reverted_terminal(session: &mut SessionManager) -> GoalState {
    let mut state = session.active_goal_state().unwrap_or_else(empty_goal_state);
    if state.status == GoalStatus::Error {
        // Roll the terminal row back to its pre-finish shape: the
        // streak-3 Active row the persist left as the newest.
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

/// A failed provider turn in the pa-agent wire shape (the mint's
/// progress-check input), carrying the `provider_stream_failure`
/// diagnostic the classification reads.
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

/// A turn that settled without output and without a provider failure
/// (an abort conversion's corpse, or a degenerate empty settle).
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

/// A turn that produced output: progress.
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
    // Validation errors.
    assert!(driver.start(&mut session, "", None).is_err());
    let long = "x".repeat(MAX_THREAD_GOAL_OBJECTIVE_CHARS + 1);
    assert!(driver.start(&mut session, &long, None).is_err());
    assert!(driver.start(&mut session, "ok", Some(0)).is_err());
    // Pause keeps the objective; resume returns a continuation context.
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
    // Rehydrating from the session restores the active goal.
    let reloaded = GoalDriver::load_persisted(&session);
    assert_eq!(reloaded.state().status, GoalStatus::Active);
    assert_eq!(
        reloaded.state().objective.as_deref(),
        Some("ship the mission")
    );
    // Clear resets everything.
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
    // Double-counting the same message is ignored.
    assert_eq!(
        driver
            .record_assistant_usage(&mut session, "a1", &usage(30, 10))
            .unwrap(),
        UsageOutcome::Ignored
    );
    assert_eq!(driver.state().tokens_used, 40);
    // Budget reached transitions to budget_limited.
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
    // Usage while inactive is ignored.
    assert_eq!(
        driver
            .record_assistant_usage(&mut session, "a3", &usage(50, 10))
            .unwrap(),
        UsageOutcome::Ignored
    );
    // Resuming an exhausted goal stays budget_limited.
    assert!(driver.resume(&mut session).unwrap().is_none());
    assert_eq!(driver.state().status, GoalStatus::BudgetLimited);
}

#[test]
fn terminal_messages_fail_or_keep_the_goal() {
    use pa_types::ai::StopReason;
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    // Aborted keeps the goal active.
    driver
        .finish_for_terminal_message(&mut session, StopReason::Aborted, None)
        .unwrap();
    assert_eq!(driver.state().status, GoalStatus::Active);
    // Error fails it with the provided message.
    driver
        .finish_for_terminal_message(&mut session, StopReason::Error, Some("provider exploded"))
        .unwrap();
    assert_eq!(driver.state().status, GoalStatus::Error);
    assert_eq!(
        driver.state().last_error.as_deref(),
        Some("provider exploded")
    );
    // Terminal handling is inert when the goal is not active.
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
    // The first mint's admission (its surface consumed it) releases the
    // pending guard: the next boundary mints again.
    driver.continuation_consumed();
    assert!(driver
        .next_continuation_message(&mut session, None)
        .unwrap()
        .is_some());
    assert_eq!(driver.state().continuations_used, 2);
    // Inactive goals produce no continuations.
    driver.pause(&mut session, "Paused by user").unwrap();
    assert!(driver
        .next_continuation_message(&mut session, None)
        .unwrap()
        .is_none());
    // The mint persists the state change: the session branch's latest
    // goal-state entry carries the incremented count.
    driver.start(&mut session, "work again", None).unwrap();
    assert!(driver
        .next_continuation_message(&mut session, None)
        .unwrap()
        .is_some());
    assert_eq!(driver.state().continuations_used, 1);
    let reloaded = GoalDriver::load_persisted(&session);
    assert_eq!(reloaded.state().continuations_used, 1);
}

/// THE 402 REGRESSION (the diagnosis's (a), the repro's acceptance):
/// the mint refuses the continuation when the just-settled turn
/// errored, and finishes the goal with the turn's error text instead
/// of re-prompting the dead provider. The hot loop dies at the first
/// failed boundary.
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
    // The refusal persisted: a reload keeps the goal dead.
    assert_eq!(
        GoalDriver::load_persisted(&session).state().status,
        GoalStatus::Error
    );
}

/// The quota-park class keeps the goal (TS `_finishQuotaParkedTurn`:
/// the parked turn is the park's pause, not the goal's death): a
/// rate-limited corpse never triggers the mint's hard finish — the
/// goal stays Active for the park's wake. The empty parked corpse
/// still counts toward the no-output backoff (a delay, not a death),
/// so this consult mints nothing; the next progress turn mints
/// normally.
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
    // Inside the refusal's backoff window even a progress row
    // refuses (the window is the refusal's stickiness).
    let wake_progress = test_progress_turn(created_at as i64 + 2);
    assert!(driver
        .next_continuation_message(&mut session, Some(&wake_progress))
        .unwrap()
        .is_none());
    // The park's wake, minutes later: both refusal windows have
    // elapsed (the wall clock modeled directly in the unit), and the
    // NEW progress turn mints — the goal resumes.
    driver.no_progress_backoff_until_ms = 0;
    driver.parked_refusal_until_ms = 0;
    assert!(driver
        .next_continuation_message(&mut session, Some(&wake_progress))
        .unwrap()
        .is_some());
    assert_eq!(driver.state().continuations_used, 1);
}

/// The consecutive-no-output cap with backoff (the diagnosis's (b)):
/// a turn that produced no output counts once; the consult refuses
/// while the backoff window is armed; the third distinct no-output
/// turn finishes the goal. A turn that produced output resets the
/// streak.
#[test]
fn no_output_turns_count_to_the_cap_and_backoff() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    let created_at = driver.state().created_at.unwrap();
    let empty_one = test_empty_turn(created_at as i64 + 1);
    // The first no-output turn: counted, refused, the goal lives —
    // and the streak is DURABLE (the persisted row carries it, so a
    // worker restart cannot reset the strikes).
    assert!(driver
        .next_continuation_message(&mut session, Some(&empty_one))
        .unwrap()
        .is_none());
    assert_eq!(driver.state().status, GoalStatus::Active);
    assert_eq!(driver.state().continuations_used, 0);
    assert_eq!(driver.state().no_progress_streak, Some(1));
    // The same turn re-consulted inside the window: still refused,
    // not re-counted (the counted-turn key dedups within the live
    // process).
    assert!(driver
        .next_continuation_message(&mut session, Some(&empty_one))
        .unwrap()
        .is_none());
    assert_eq!(driver.state().no_progress_streak, Some(1));
    // A rebuilt driver (the worker restart) adopts the persisted
    // strikes: the streak survives the restart — and the counted-turn
    // key too, so the same corpse never strikes twice however often
    // the session rebuilds.
    let mut driver = GoalDriver::load_persisted(&session);
    assert_eq!(driver.state().no_progress_streak, Some(1));
    assert_eq!(driver.no_progress_streak(), 1);
    // The same turn re-consulted after the restart: NOT re-counted
    // (the durable no_progress_turn_ms carries the dedup across the
    // rebuild) — and the wall-clock backoff window does not survive
    // the restart (the rebuild retries the mint immediately; the
    // streak carries the cap, not the delay).
    let reconsult = driver
        .next_continuation_message(&mut session, Some(&empty_one))
        .unwrap();
    assert!(reconsult.is_some(), "the restart retries the mint");
    assert_eq!(driver.no_progress_streak(), 1);
    driver.continuation_consumed();
    // A second distinct no-output turn: counted again (the streak
    // carried over the restart: strike two — a fresh corpse, the
    // restart's own counted-turn key starting empty).
    let empty_two = test_empty_turn(created_at as i64 + 2);
    assert!(driver
        .next_continuation_message(&mut session, Some(&empty_two))
        .unwrap()
        .is_none());
    assert_eq!(driver.state().no_progress_streak, Some(2));
    assert_eq!(driver.state().status, GoalStatus::Active);
    // A progress turn resets the streak and mints (the restart's
    // immediate re-mint above already consumed one slot; this is the
    // second).
    let progress = test_progress_turn(created_at as i64 + 3);
    assert!(driver
        .next_continuation_message(&mut session, Some(&progress))
        .unwrap()
        .is_some());
    assert_eq!(driver.state().continuations_used, 2);
    assert_eq!(driver.state().no_progress_streak, Some(0));
    // Three consecutive no-output turns (the fresh streak): the
    // third hits the cap and finishes the goal.
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
    // The cap persisted: a reload keeps the goal dead.
    assert_eq!(
        GoalDriver::load_persisted(&session).state().status,
        GoalStatus::Error
    );
}

/// The progress check's scope (the review round's finding): a stale
/// pre-goal error corpse — the live loop's leftover from BEFORE
/// `/goal start` — must not finish the fresh goal. Only a turn the
/// goal's own lifetime produced can judge it (the turn's timestamp
/// against the goal's `created_at`).
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
    // The minted continuation admits (the pending guard releases) —
    // then a stale pre-goal EMPTY row does not count toward the cap
    // either: the fresh goal's own three-strike budget is intact.
    driver.continuation_consumed();
    let stale_empty = test_empty_turn(created_at as i64 - 500);
    assert!(driver
        .next_continuation_message(&mut session, Some(&stale_empty))
        .unwrap()
        .is_some());
    assert_eq!(driver.state().no_progress_streak, Some(0));
}

/// A replacement goal never inherits the terminal goal's strikes (the
/// review round's finding): `start` resets the streak, and the fresh
/// goal's row carries its own zero.
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
    // A fresh goal on the same session: its own three-strike budget.
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
    // The reload adopts the fresh goal's own streak, not the dead
    // goal's.
    assert_eq!(
        GoalDriver::load_persisted(&session)
            .state()
            .no_progress_streak,
        Some(2)
    );
}

/// THE WAVE'S REGRESSIONS (the late-review round):
/// (1) the quota-park class never consumes the no-progress budget —
///     three parked corpses must not mark an otherwise live goal dead
///     (the park's own wake/budget owns the retry cadence);
/// (2) an all-empty-parts corpse (the abort conversion's
///     `vec![Text { text: "" }]` shape) IS a no-output turn;
/// (3) the streak survives a consult that sees an OLDER progress row
///     (the drop-revealed row after the failed pair's removal).
#[test]
fn rate_limit_and_empty_text_corpses_and_the_examined_gate() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    let created_at = driver.state().created_at.unwrap();

    // (1) Three parked corpses: no strikes, the goal stays alive (the
    // mint refuses the parked boundary without counting).
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
    // skips it — the strike survives (the naive consult would have
    // reset the streak to 0).
    let older_progress = test_progress_turn(created_at as i64 + 5);
    assert!(driver
        .next_continuation_message(&mut session, Some(&older_progress))
        .unwrap()
        .is_none());
    assert_eq!(driver.no_progress_streak(), 1, "the older row never resets");

    // A NEWER progress row still resets (the wake's turn made it).
    let newer_progress = test_progress_turn(created_at as i64 + 20);
    assert!(driver
        .next_continuation_message(&mut session, Some(&newer_progress))
        .unwrap()
        .is_some());
    assert_eq!(driver.no_progress_streak(), 0);
    driver.continuation_consumed();
}

/// THE ORDER-SAFETY PIN (the operator's ruling, the last thread): the
/// wire rows carry no per-attempt id, so the examined-turn dedup keys
/// on the millisecond timestamp — NOT a total order across settle
/// paths. A TERMINAL provider error that shares the preceding
/// no-output turn's millisecond (or precedes it) must still refuse the
/// continuation: the kill is UNCONDITIONAL (outside the dedup gate),
/// so the collision can never resurrect the loop.
#[test]
fn a_terminal_error_sharing_the_millisecond_still_refuses() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    let created_at = driver.state().created_at.unwrap();

    // Strike one: a no-output turn at millisecond T (the streak
    // counts, the examined key adopts T).
    let empty = test_empty_turn(created_at as i64 + 1000);
    assert!(driver
        .next_continuation_message(&mut session, Some(&empty))
        .unwrap()
        .is_none());
    assert_eq!(driver.no_progress_streak(), 1);

    // The same millisecond T: a TERMINAL provider error — the dedup's
    // timestamp comparison alone would skip it as already-examined
    // (`T > T` is false). The unconditional kill refuses the
    // continuation and finishes the goal.
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

/// THE WAVE-7 PINS (the split-head review):
/// (T1) a fresh goal started in the SAME millisecond as a prior
///      terminal-error row never adopts that pre-goal row — the gate
///      requires a STRICTLY later turn (a same-ms row is not the new
///      goal's own);
/// (T2) a parked refusal clears an earlier strike's backoff window:
///      `backoff_wake_at` never exposes a deadline during the quota
///      park (the park's own wake owns the retry).
#[test]
fn a_same_ms_pre_goal_corpse_never_judges_the_new_goal() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    let created_at = driver.state().created_at.unwrap();

    // A pre-goal terminal corpse AT the goal's own creation
    // millisecond: the strict-later gate excludes it — the fresh
    // goal mints.
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

    // Strike one: the backoff window arms (the wake would be exposed).
    let empty = test_empty_turn(created_at as i64 + 1);
    assert!(driver
        .next_continuation_message(&mut session, Some(&empty))
        .unwrap()
        .is_none());
    assert_eq!(driver.no_progress_streak(), 1);
    assert!(driver.backoff_wake_at().is_some());

    // The parked corpse: the refusal CLEARS the strike's window and
    // arms only the parked refusal — no wake is ever exposed during
    // the quota park.
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

/// THE WAVE-4 REGRESSION: the quota-park refusal STICKS — the
/// standard backoff window arms, so a re-consult (the same corpse,
/// or the older progress row the pair-drop exposes) refuses too;
/// only a NEW turn (the wake's) re-enters.
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
    // The re-consult of the SAME corpse: refused (the window).
    assert!(driver
        .next_continuation_message(&mut session, Some(&parked))
        .unwrap()
        .is_none());
    // The drop-revealed OLDER progress row: refused too (the window
    // holds; the row never resets anything).
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

/// THE WAVE-3 REGRESSION: a restored goal already AT the cap (a
/// restart or a failed terminal persist between the streak row and
/// the error row leaves `Active` with `no_progress_streak == 3`)
/// finishes at the FIRST consult — the examined-turn gate must never
/// shield a cap that already struck.
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
    // Simulate the interrupted terminal transition: the durable rows
    // keep the streak-3 Active row as the newest (the error row
    // never landed). A rebuilt driver adopts Active-at-cap.
    let rows = session_rows_with_reverted_terminal(&mut session);
    let mut driver = GoalDriver::restore_persisted(rows);
    assert_eq!(driver.state().status, GoalStatus::Active);
    assert_eq!(driver.no_progress_streak(), 3);
    // The FIRST consult — of ANY turn, examined or not — enforces
    // the cap: the goal finishes.
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

/// The restore-resurrection guard (the diagnosis's (d)): an active
/// newest goal row with a terminal provider failure settled after it
/// (the interrupted settle — the worker died before the error row
/// persisted) adopts the failure as the goal's terminal state at
/// rehydration instead of resurrecting the loop.
#[test]
fn load_persisted_adopts_the_stale_active_failure() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    // The mint's active row is the newest goal row; the corpse
    // message persists after it (message_end precedes the settle's
    // error row — the interrupted-settle ordering).
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
    // The rate-limit corpse is the park's pause: the goal resurrects
    // (the park wake owns the resume).
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
    // A settled terminal row (the error row landed after the corpse)
    // is the newest row: no stale adoption, the error stands on its
    // own.
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

/// TS `_getGoalContinuationMessages`'s quiescence arm and
/// `_maybeResumeGoalContinuationAfterRlmWork`: the owed continuation
/// waits without consuming a slot, delivers exactly once when taken,
/// and drops for an inactive goal instead of minting.
#[test]
fn owed_continuation_defers_and_delivers_once() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    // Deferral: no slot consumed while the continuation waits.
    assert!(!driver.owes_continuation());
    driver.mark_continuation_owed();
    assert!(driver.owes_continuation());
    assert_eq!(driver.state().continuations_used, 0);
    // Delivery: one slot consumed, the flag clears.
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
    // A second take (a racing settle site) delivers nothing.
    assert!(driver
        .take_owed_continuation(&mut session, None)
        .unwrap()
        .is_none());
    assert_eq!(driver.state().continuations_used, 1);
    // An inactive goal drops the deferral without minting (TS:
    // "drops the deferral for inactive goals").
    driver.mark_continuation_owed();
    driver.pause(&mut session, "Paused by user").unwrap();
    assert!(driver
        .take_owed_continuation(&mut session, None)
        .unwrap()
        .is_none());
    assert_eq!(driver.state().continuations_used, 1);
    assert!(!driver.owes_continuation());
    // Pause/clear/start reset the flag with the queued contexts.
    driver.mark_continuation_owed();
    driver.clear(&mut session).unwrap();
    assert!(!driver.owes_continuation());
    driver.start(&mut session, "again", None).unwrap();
    driver.mark_continuation_owed();
    driver.start(&mut session, "once more", None).unwrap();
    assert!(!driver.owes_continuation());
}

/// The mint rollback (TS `_getContinuationMessages`'s arrival-epoch
/// restore): a rolled-back mint decrements the slot so the next
/// boundary re-mints without double-counting.
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
    // The rollback persists: the reloaded branch sees the restored
    // count (TS `_setGoalState` re-persists the snapshot).
    assert_eq!(
        GoalDriver::load_persisted(&session)
            .state()
            .continuations_used,
        0
    );
    // The next mint counts from the restored slot.
    assert!(driver
        .next_continuation_message(&mut session, None)
        .unwrap()
        .is_some());
    assert_eq!(driver.state().continuations_used, 1);
}

/// TS `_resumeGoal` semantics: resume continues the same goal (same
/// id and objective, no re-creation) and only sets a reason when the
/// budget is already exhausted.
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
    // An exhausted budget stays budget_limited with the TS reason.
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

/// TS `_loadPersistedGoalState` construction rehydration: the
/// persisted state (counts included) is adopted verbatim, wall-clock
/// attribution restarts for an active goal, and nothing re-persists.
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
    // The durable no-progress streak adopts with the state (the
    // review round's finding: a restart cannot reset the strikes).
    assert_eq!(driver.no_progress_streak(), 2);
    assert!(driver.owns_continuation_wakeup());
    assert_eq!(driver.active_objective().as_deref(), Some("ship the port"));
    // A budget_limited state stays inactive: no wakeup, no anchor.
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
    // The next continuation continues the persisted count.
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
    // A persisted goal means the branch is not seedable.
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    assert!(!GoalDriver::is_branch_seedable(&session));
    // Messages also block seeding.
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

/// Append one raw `thread_goal_state` row (the TS test seam
/// `sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, ...)`)
/// so a reload can observe a branch entry the driver did not write
/// through its own state machine.
fn append_goal_row(session: &mut SessionManager, state: &GoalState) {
    let value = serde_json::to_value(state).unwrap();
    session
        .append_custom_entry(GOAL_STATE_CUSTOM_TYPE, Some(value))
        .unwrap();
}

/// TS `agent-session-goal.test.ts` "reloads the goal state from the
/// branch after a summary context rebuild" (the monotonic arm): a
/// stale same-goal snapshot never regresses the accounting, while a
/// plain branch move stays faithful to the branch even when lower.
#[test]
fn same_timeline_reload_never_regresses_the_same_goal() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "do work", None).unwrap();
    let goal_id = driver.state().goal_id.clone();
    assert_eq!(driver.state().status, GoalStatus::Active);

    // Bill usage through the same path a real assistant message uses.
    assert_eq!(
        driver
            .record_assistant_usage(&mut session, "a1", &usage(40, 10))
            .unwrap(),
        UsageOutcome::Accounted
    );
    assert!(driver.state().tokens_used >= 50);

    // Simulate a stale persisted snapshot for the SAME goal: an older
    // accounting entry re-persisted after the newer usage (queue/flush
    // race, or child-usage attribution landing after the branch write).
    append_goal_row(
        &mut session,
        &GoalState {
            tokens_used: 1,
            continuations_used: 0,
            time_used_seconds: 0,
            ..driver.state().clone()
        },
    );

    // A summary navigation (compaction) continues the same timeline:
    // the same goal's accounting must not regress to the stale row.
    driver.reload_from_branch(&session, GoalBranchReload::SameTimeline);
    assert_eq!(driver.state().status, GoalStatus::Active);
    assert_eq!(driver.state().goal_id, goal_id);
    assert!(driver.state().tokens_used >= 50);

    // Plain branch moves are time travel and stay faithful to the
    // branch's last persisted entry, even when it is lower.
    driver.reload_from_branch(&session, GoalBranchReload::FaithfulBranch);
    assert_eq!(driver.state().goal_id, goal_id);
    assert_eq!(driver.state().tokens_used, 1);
}

/// TS `agent-session-goal.test.ts` "keeps a fired budget gate
/// monotonic across summary context rebuilds": the gate that already
/// fired survives the same-timeline reload and the counter never
/// regresses.
#[test]
fn same_timeline_reload_keeps_a_fired_budget_gate() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "do work", Some(100)).unwrap();
    let goal_id = driver.state().goal_id.clone();

    // Bill usage until the budget gate fires.
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

    // A summary rebuild continues the same timeline: the gate that
    // already fired must survive, and the counter must not regress.
    driver.reload_from_branch(&session, GoalBranchReload::SameTimeline);
    assert_eq!(driver.state().status, GoalStatus::BudgetLimited);
    assert_eq!(driver.state().goal_id, goal_id);
    assert!(driver.state().tokens_used >= 110);
}

/// A different goal on the moved branch adopts faithfully even under
/// the same-timeline rule (TS clamps only
/// `reloaded.goalId === previous.goalId`).
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

    // The moved branch carries another goal with lower counters.
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
    // own row wins on both arms when the ids differ.
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

/// The reload's newest-first scan skips invalid rows (TS
/// `isPersistedGoalState` guard) and the empty state is the
/// no-entry fallthrough.
#[test]
fn reload_skips_invalid_rows() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "do work", None).unwrap();

    // An invalid row (missing the counters) lands after the valid one:
    // the scan skips it and keeps the branch's last VALID entry.
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

    // A branch without any goal entry reloads to the empty state.
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

/// The operator's exact case (2026-09-28): a goal created ~2 hours ago
/// reads ~2 hours — the creation-based timer computes fresh from
/// `created_at` on every read, and no accounting write compounds it
/// (the pre-ruling anchor read 73h for the same goal).
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
    // The created_at is fabricated 2h in the past, so the read is
    // arithmetic — the lower bound cannot fail; the generous upper
    // bound tolerates a descheduled CI worker between the fabricated
    // anchor and the read (never a tight execution-time window).
    assert!(
        (7_190..=7_260).contains(&elapsed.time_used_seconds),
        "a 2h-old goal reads ~2h, got {}",
        elapsed.time_used_seconds
    );
    // The persisted rows carry the age at write, never an accumulated
    // value (the quadratic compounding class is dead).
    assert!(
        (7_190..=7_260).contains(&reloaded.state().time_used_seconds),
        "the durable row carries the age: {}",
        reloaded.state().time_used_seconds
    );
    // The idle state reads zero: no `created_at`, no age.
    let idle = GoalDriver::new();
    assert_eq!(idle.state_with_creation_elapsed().time_used_seconds, 0);
}

/// The paused goal displays the same creation-based age (the goal's
/// age, not a separately stopped clock — the operator's ruling).
#[test]
fn paused_goal_reads_its_age() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "ship it", None).unwrap();
    driver.pause(&mut session, "Paused by user").unwrap();
    assert_eq!(driver.state().status, GoalStatus::Paused);
    // The paused state keeps `created_at`: its served state still reads
    // the goal's age.
    assert!(driver.state().created_at.is_some());
    assert!(
        driver.state_with_creation_elapsed().time_used_seconds <= 60,
        "a freshly paused goal reads its (small) age"
    );
    // A rehydrated paused goal created 2h ago reads ~2h.
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

/// Goals persisted before the creation-based contract have no
/// `created_at`: the load backfills it from `updated_at`, so the row
/// reads its age sanely instead of compounding nothing.
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
    // The backfill: `created_at` adopts `updated_at` (documented
    // migration for pre-contract rows).
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
    // An empty state (no goal) never fabricates a creation time.
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

/// The pending-never-re-arms contract: a minted continuation blocks
/// every further mint until its surface admits it
/// (`continuation_consumed`), and a rollback or an inactive state
/// drops the guard with the mint.
#[test]
fn pending_continuation_never_re_arms() {
    let mut session = persisted_session();
    let mut driver = GoalDriver::new();
    driver.start(&mut session, "work", None).unwrap();
    // The first mint arms the pending guard.
    assert!(driver
        .next_continuation_message(&mut session, None)
        .unwrap()
        .is_some());
    assert!(driver.pending_continuation());
    // A second mint refuses while the first is pending.
    assert!(
        driver
            .next_continuation_message(&mut session, None)
            .unwrap()
            .is_none(),
        "a pending continuation must not re-arm another"
    );
    assert_eq!(driver.state().continuations_used, 1);
    // The arm never fires BESIDE a pending mint (TS
    // `_goalContinuationAwaitsRlmWork ||= !hasQueuedMessages()`:
    // the pending mint IS this boundary's queued delivery, so a
    // later settle must never deliver a second continuation for the
    // same boundary once the pending one admits).
    driver.mark_continuation_owed();
    assert!(
        !driver.owes_continuation(),
        "the arm is a no-op while a mint is pending"
    );
    // An arm that fired BEFORE the mint waits behind it: the take
    // refuses while the pending mint holds the guard, the armed flag
    // stays put, and the delivery lands once the admission released
    // the guard.
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
    // The admission releases the guard; the owed delivery mints next.
    driver.continuation_consumed();
    let delivered = driver.take_owed_continuation(&mut session, None).unwrap();
    assert!(delivered.is_some());
    assert!(!driver.owes_continuation());
    assert!(driver.pending_continuation());
    assert_eq!(driver.state().continuations_used, 3);
    // A rollback un-mints and releases the guard together.
    driver.rollback_continuation_mint(&mut session).unwrap();
    assert!(!driver.pending_continuation());
    assert_eq!(driver.state().continuations_used, 2);
    // Pausing drops a pending mint with the queued contexts.
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
    // A fresh start resets the guard with the queued contexts.
    driver.start(&mut session, "again", None).unwrap();
    assert!(!driver.pending_continuation());
    assert!(driver
        .next_continuation_message(&mut session, None)
        .unwrap()
        .is_some());
    driver.clear(&mut session).unwrap();
    assert!(!driver.pending_continuation());
}
