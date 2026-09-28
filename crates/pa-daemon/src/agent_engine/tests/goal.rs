//! The goal tests (recovery, continuation minting, the goal loop's turn-end accounting).
use super::*;

/// The post-compaction goal-continue mint (TS `compact()`'s
/// `didCompact` + active-goal branch -> `resumeQueuedWork()` ->
/// `_maybeResumeGoalContinuationAfterRlmWork`): an active goal's
/// mint consumes one continuation slot, persists the state change
/// (the wire state read reflects it), and returns the queued
/// follow-up turn — the continuation prompt text carrying the durable
/// goal-context row — plus the `goal_update` payload of the state
/// change. A goal that is not active mints nothing.
/// A recovery rebuild rehydrates the goal driver from the worker-owned
/// session file (TS constructor `_loadPersistedGoalState`): the fresh
/// engine continues the persisted objective and counts, the rehydrated
/// state never announces itself (the published baseline is seeded),
/// and later state changes (usage accounting) announce from the
/// rehydrated base, not from zero.
#[test]
fn recovery_rebuild_rehydrates_the_goal_from_the_session_file() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    // The durable store a killed worker leaves behind: an active goal
    // mid-pursuit with usage and continuation counts on the books.
    let mut store = crate::session_store::SessionFile::create("/tmp", None, 0);
    let session_path = dir.path().join("session.jsonl");
    store.set_path(session_path.clone());
    store.append_entry(
        "custom",
        json!({
            "customType": pa_core::goals::GOAL_STATE_CUSTOM_TYPE,
            "data": {
                "active": true,
                "status": "active",
                "goalId": "goal-1",
                "objective": "ship the port",
                "tokensUsed": 340,
                "timeUsedSeconds": 9,
                "continuationsUsed": 2,
            },
        }),
    );
    store.rewrite().expect("write session file");
    let engine = std::sync::Arc::new(
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir,
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: Some(session_path),
            faux_script: Some(r#"{"responses": [{"text": "recovery reply"}]}"#.to_string()),
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap(),
    );
    // The turn-end seam: the engine has no worker, so a collector
    // stands in for the queue-lane admission sink.
    let goal_work = goal_admission_collector(&engine);
    // The first turn builds the session; the adoption rehydrates the
    // driver from the session file.
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "keep working".to_string(), &mut events);
    let goal = engine.goal_state_value();
    assert_eq!(goal["status"], "active");
    assert_eq!(goal["objective"], "ship the port");
    assert_eq!(goal["goalId"], "goal-1");
    // The rehydrated count continues the pursuit: the turn's natural
    // end minted the next continuation (the TS goal loop).
    assert_eq!(goal["continuationsUsed"], 3);
    assert!(goal["tokensUsed"].as_u64().unwrap() >= 340);
    // Usage accounting announced from the rehydrated base (TS
    // `_accountGoalUsageForAssistantMessage` -> `_emitGoalUpdate`): one
    // `goal_update` through the run's emit, carrying the continued
    // objective and the rehydrated count (the turn-end mint's update
    // surfaces through the admission sink, not the run's emit).
    let goal_updates: Vec<&EngineEvent> = events
        .iter()
        .filter(|event| matches!(event, EngineEvent::GoalUpdate { .. }))
        .collect();
    assert_eq!(goal_updates.len(), 1, "events: {events:?}");
    let EngineEvent::GoalUpdate { goal } = goal_updates[0] else {
        unreachable!();
    };
    assert_eq!(goal["objective"], "ship the port");
    assert_eq!(goal["continuationsUsed"], 2);
    // The turn-end continuation minted at the natural boundary: one
    // admitted follow-up whose `goal_update` continues the count.
    let work = goal_work.lock().unwrap();
    let [crate::engine::GoalTurnEndWork::Continuation(minted)] = work.as_slice() else {
        panic!("unexpected goal work: {work:?}");
    };
    assert!(minted.request.message.contains("[goal: continuation]"));
    assert_eq!(
        minted
            .goal_update
            .as_ref()
            .expect("the mint moved the state")["continuationsUsed"],
        3
    );
    drop(work);
    // A post-compaction mint continues the pursuit's count further.
    let minted = engine
        .mint_post_compaction_goal_continuation()
        .expect("the rehydrated goal mints");
    assert_eq!(
        minted.goal_update.expect("mint moved the state")["continuationsUsed"],
        4
    );
}

/// A durable message row in the worker's persisted wire shape.
fn wire_user_message(text: String) -> Value {
    serde_json::to_value(pa_types::session::AgentMessage::User(
        pa_types::ai::UserMessage {
            content: pa_types::ai::UserContent::Text(text),
            timestamp: 1,
            rest: Map::default(),
        },
    ))
    .expect("user message serializes")
}

/// A durable assistant row in the worker's persisted wire shape.
fn wire_assistant_message(text: String) -> Value {
    serde_json::to_value(pa_types::session::AgentMessage::Assistant(
        pa_types::ai::AssistantMessage {
            content: vec![pa_types::ai::AssistantContentBlock::Text(
                pa_types::ai::TextContent {
                    text,
                    text_signature: None,
                    rest: Map::default(),
                },
            )],
            api: "faux".to_string(),
            provider: "faux".to_string(),
            model: "faux-1".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_types::ai::Usage::default(),
            stop_reason: pa_types::ai::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 2,
            rest: Map::default(),
        },
    ))
    .expect("assistant message serializes")
}

/// The recovered engine's compaction walk sees the durable history (TS
/// one-store recovery: the owned-session worker respawns with
/// `--resume <sessionFile>`, so the rebuilt session's branch carries
/// the pre-crash history and a post-recovery compact runs over it —
/// never a skip on the fresh engine's empty branch). The daemon worker
/// owns the file writes while the engine keeps an in-memory manager,
/// so the recovery build adopts the durable branch and the walk
/// (prepareCompaction over the branch) reads the same history TS's
/// single store holds.
#[test]
fn recovered_engine_compaction_walk_sees_the_durable_history() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    write_compaction_settings(dir.path(), 1);
    // The durable store a killed worker leaves behind: a long
    // conversation the fresh engine never saw in memory.
    let long = "x".repeat(48_000);
    let mut store = crate::session_store::SessionFile::create("/tmp", None, 0);
    let session_path = dir.path().join("session.jsonl");
    store.set_path(session_path.clone());
    store.append_message(wire_user_message(format!("work turn one {long}")));
    store.append_message(wire_assistant_message(format!("reply one {long}")));
    store.rewrite().expect("write session file");
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: Some(session_path),
        faux_script: Some(
            serde_json::json!({
                "responses": [{"text": "recovery reply"}, {"text": "the summary"}]
            })
            .to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    // The recovery turn builds the session; the build adopts the
    // durable branch (TS `--resume`: one store).
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(
        &engine,
        format!("keep working after the crash {}", "y".repeat(2_000)),
        &mut events,
    );
    let entries = engine_session_entries(&engine);
    assert!(
        entries.iter().any(|entry| match entry {
            pa_types::session::FileEntry::Message {
                message: pa_types::session::AgentMessage::User(user),
                ..
            } => user.content.text().contains("work turn one"),
            _ => false,
        }),
        "the recovery build adopted the durable history: {entries:?}"
    );
    // The compact runs over the durable history instead of skipping
    // "too short" on the fresh branch.
    let controller = std::sync::Arc::new(pa_agent::abort::AbortController::new());
    let signal = controller.signal();
    let outcome = engine.run_compaction(
        crate::engine::CompactionRequest {
            custom_instructions: None,
        },
        &signal,
    );
    match outcome {
        crate::engine::CompactionOutcome::Compacted { run } => {
            assert_eq!(run.result["summary"], "the summary", "the compact ran");
            assert!(
                run.result["firstKeptEntryId"].is_string(),
                "the cut resolved a kept entry: {run:?}"
            );
        }
        other => panic!("the recovered compact did not run: {other:?}"),
    }
    // The post-compaction branch summary stands in for the durable
    // prefix: the compaction entry landed in the engine branch.
    assert!(compaction_entry_in_entries(&engine));
}

#[test]
fn post_compaction_goal_continuation_mint() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, _engine_dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "goal turn reply"}] }),
        1,
    );
    let engine = std::sync::Arc::new(engine);
    // The turn-end seam: the engine has no worker, so a collector
    // stands in for the queue-lane admission sink.
    let goal_work = goal_admission_collector(&engine);
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(
        &engine,
        "/goal ship the post-compact continue".to_string(),
        &mut events,
    );
    // The goal-start continuation turn ran (TS `/goal` start does not
    // consume a continuation slot), the goal active; the turn's
    // natural end then minted the goal loop's next continuation (the
    // TS `_getGoalContinuationMessages` hook).
    assert_eq!(engine.goal_state_value()["status"], "active");
    assert_eq!(engine.goal_state_value()["continuationsUsed"], 1);
    let work = goal_work.lock().unwrap();
    let [crate::engine::GoalTurnEndWork::Continuation(turn_end)] = work.as_slice() else {
        panic!("unexpected goal work: {work:?}");
    };
    assert!(turn_end.request.message.contains("[goal: continuation]"));
    assert_eq!(
        turn_end.goal_update.as_ref().expect("mint moved the state")["continuationsUsed"],
        1
    );
    drop(work);
    let minted = engine
        .mint_post_compaction_goal_continuation()
        .expect("active goal mints the continuation");
    let message = minted.request.message;
    assert!(
        message.contains("[goal: continuation]"),
        "unexpected continuation text: {message}"
    );
    assert!(
        message.contains("ship the post-compact continue"),
        "the continuation context lost the objective: {message}"
    );
    let row = minted
        .request
        .custom_message
        .expect("the goal-context row rides the turn");
    assert_eq!(row["customType"], "goal_context");
    assert_eq!(row["role"], "custom");
    assert_eq!(row["content"], json!(message));
    assert_eq!(row["details"]["kind"], "continuation");
    assert_eq!(row["details"]["continuationsUsed"], 2);
    // The state change persisted (TS `_setGoalState`): the wire state
    // read reflects the mint, and the `goal_update` payload carries
    // the same state.
    assert_eq!(engine.goal_state_value()["continuationsUsed"], 2);
    let goal_update = minted.goal_update.expect("the mint moved the state");
    assert_eq!(goal_update["status"], "active");
    assert_eq!(goal_update["continuationsUsed"], 2);
    // TS #2465: a live background bash handle holds the post-compaction
    // mint the same way (the TS resume site's gate): the mint defers
    // (owed, not consumed) until the handle settles.
    let live_probe: std::sync::Arc<dyn Fn() -> bool + Send + Sync> = std::sync::Arc::new(|| true);
    *engine.background_bash_probe.lock().unwrap() = Some(live_probe);
    assert!(
        engine.mint_post_compaction_goal_continuation().is_none(),
        "a live handle minted the post-compaction continuation"
    );
    {
        let handles = engine
            .goal_runtime
            .lock()
            .unwrap()
            .clone()
            .expect("goal runtime");
        assert!(
            engine
                .runtime
                .block_on(async { handles.driver.lock().await.owes_continuation() }),
            "the deferred mint must be owed"
        );
    }
    let settled_probe: std::sync::Arc<dyn Fn() -> bool + Send + Sync> =
        std::sync::Arc::new(|| false);
    *engine.background_bash_probe.lock().unwrap() = Some(settled_probe);
    assert!(
        engine.mint_post_compaction_goal_continuation().is_some(),
        "the settled handle releases the post-compaction mint"
    );
    // A mint over a paused goal produces nothing (TS checks the
    // active status at the resume site).
    let mut pause_events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "/goal pause".to_string(), &mut pause_events);
    assert_eq!(engine.goal_state_value()["status"], "paused");
    assert!(
        engine.mint_post_compaction_goal_continuation().is_none(),
        "a paused goal minted a continuation"
    );
}

/// Admit one full turn request (the minted continuation's injected
/// goal-context row), collecting its events.
pub(crate) fn admit_request(
    engine: &AgentSessionEngine,
    request: crate::engine::PromptRequest,
    events: &mut Vec<EngineEvent>,
) {
    engine.run_prompt(0, request, &|| false, &mut |event| {
        events.push(event);
        true
    });
}

/// TS `_getGoalContinuationMessages` at the natural turn end: an
/// active goal mints one continuation per settled turn, the minted
/// follow-up carries the continuation context (objective, count, and
/// the durable goal-context row), and a completed goal stops the loop
/// (no mint at the boundary after the completion).
#[test]
fn goal_turn_end_mints_the_loop_until_the_goal_completes() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let engine = std::sync::Arc::new(
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: dir.path().join("agent"),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: Some(
                serde_json::json!({ "responses": [
                    {"text": "first turn"},
                    {"text": "second turn"},
                    {"text": "third turn"},
                    {"text": "final turn"},
                ]})
                .to_string(),
            ),
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap(),
    );
    let goal_work = goal_admission_collector(&engine);
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "/goal ship the goal loop".to_string(), &mut events);
    // The goal-start turn's natural end minted the first continuation.
    assert_eq!(engine.goal_state_value()["status"], "active");
    assert_eq!(engine.goal_state_value()["continuationsUsed"], 1);
    // The worker queue would drive the minted turn: admit it like the
    // runner does, twice — each settled turn mints the next
    // continuation (the TS loop keeps prompting the model), the minted
    // row carrying the incremented count.
    let mut request = {
        let mut work = goal_work.lock().unwrap();
        let crate::engine::GoalTurnEndWork::Continuation(follow_up) =
            work.pop().expect("the start turn minted one continuation")
        else {
            panic!("expected a continuation");
        };
        assert!(follow_up.request.message.contains("[goal: continuation]"));
        assert!(follow_up.request.message.contains("ship the goal loop"));
        follow_up.request
    };
    for expected_count in [2u64, 3] {
        let mut turn_events: Vec<EngineEvent> = Vec::new();
        admit_request(&engine, request, &mut turn_events);
        request = {
            let mut work = goal_work.lock().unwrap();
            assert_eq!(work.len(), 1, "unexpected goal work: {work:?}");
            let crate::engine::GoalTurnEndWork::Continuation(follow_up) = work
                .pop()
                .expect("the settled turn minted the next continuation")
            else {
                panic!("expected a continuation");
            };
            let row = follow_up
                .request
                .custom_message
                .as_ref()
                .expect("the row rides");
            assert_eq!(row["customType"], "goal_context");
            assert_eq!(row["details"]["kind"], "continuation");
            assert_eq!(
                row["details"]["continuationsUsed"],
                serde_json::json!(expected_count)
            );
            assert_eq!(
                follow_up.goal_update.expect("mint moved the state")["continuationsUsed"],
                serde_json::json!(expected_count)
            );
            follow_up.request
        };
        assert_eq!(
            engine.goal_state_value()["continuationsUsed"],
            serde_json::json!(expected_count)
        );
    }
    // The goal completes (the kernel host request's driver path):
    // the queued continuation's boundary mints nothing more.
    let handles = engine
        .goal_runtime
        .lock()
        .unwrap()
        .clone()
        .expect("goal runtime");
    engine.runtime.block_on(async {
        let mut driver = handles.driver.lock().await;
        let mut session = handles.session.lock().await;
        driver.complete(&mut session).unwrap();
    });
    let mut turn_events: Vec<EngineEvent> = Vec::new();
    admit_request(&engine, request, &mut turn_events);
    assert_eq!(engine.goal_state_value()["status"], "complete");
    assert_eq!(
        engine.goal_state_value()["continuationsUsed"],
        3,
        "a completed goal mints no continuation at the boundary"
    );
    assert!(goal_work.lock().unwrap().is_empty());
}

/// The TS gate ladder's inactive arms: a paused goal (and a cleared
/// one) mints nothing at the natural turn end, and no continuation
/// slot is consumed.
#[test]
fn paused_goal_mints_no_turn_end_continuation() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, _engine_dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [
            {"text": "start turn reply"},
            {"text": "paused turn reply"},
        ]}),
        1,
    );
    let engine = std::sync::Arc::new(engine);
    let goal_work = goal_admission_collector(&engine);
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "/goal ship while paused".to_string(), &mut events);
    // The start turn's boundary minted one continuation; pause the
    // goal, then drive that minted turn: its boundary mints nothing.
    let request = {
        let mut work = goal_work.lock().unwrap();
        let crate::engine::GoalTurnEndWork::Continuation(follow_up) =
            work.pop().expect("the start turn minted")
        else {
            panic!("expected a continuation");
        };
        follow_up.request
    };
    let count_before = engine.goal_state_value()["continuationsUsed"].clone();
    let mut pause_events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "/goal pause".to_string(), &mut pause_events);
    assert_eq!(engine.goal_state_value()["status"], "paused");
    let mut turn_events: Vec<EngineEvent> = Vec::new();
    admit_request(&engine, request, &mut turn_events);
    // No mint: the paused goal consumed no slot at the boundary.
    assert!(goal_work.lock().unwrap().is_empty());
    assert_eq!(engine.goal_state_value()["continuationsUsed"], count_before);
    assert_eq!(turn_events.last(), Some(&EngineEvent::Done(Ok(()))));
    // A cleared goal behaves the same.
    admit(&engine, "/goal clear".to_string(), &mut Vec::new());
    let mut after_clear: Vec<EngineEvent> = Vec::new();
    admit(&engine, "plain turn".to_string(), &mut after_clear);
    assert!(goal_work.lock().unwrap().is_empty());
    assert_eq!(engine.goal_state_value()["status"], "idle");
}

/// The budget-exhausted gate (TS `_accountGoalUsageForAssistantMessage`
/// returning true -> the `budget_limit` context steer): the crossing
/// turn ends the run, the wrap-up steer queues on the steering surface,
/// the goal moves to `budget_limited` with the TS reason, and no
/// continuation mints at that boundary.
#[test]
fn budget_exhausted_stops_with_the_ts_budget_steer() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, _engine_dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "crossing turn reply"}] }),
        1,
    );
    let engine = std::sync::Arc::new(engine);
    let goal_work = goal_admission_collector(&engine);
    let mut events: Vec<EngineEvent> = Vec::new();
    // A tiny budget: the goal-start turn's usage crosses it (the faux
    // provider estimates usage from the context).
    admit(
        &engine,
        "/goal --budget 10 budget the runaway turn".to_string(),
        &mut events,
    );
    let goal = engine.goal_state_value();
    assert_eq!(goal["status"], "budget_limited");
    assert_eq!(
        goal["lastReason"],
        serde_json::json!("Reached 10 token goal budget")
    );
    // The crossing turn's boundary minted the budget-limit steer, not
    // a continuation.
    let work = goal_work.lock().unwrap();
    let [crate::engine::GoalTurnEndWork::BudgetLimitSteer(steer)] = work.as_slice() else {
        panic!("expected exactly the budget steer: {work:?}");
    };
    let steer_text = &steer.request.message;
    assert!(
        steer_text.starts_with("[goal: budget-limit]"),
        "text: {steer_text}"
    );
    assert!(steer_text.contains("budget the runaway turn"));
    assert!(steer_text.contains("status: budget_limited"));
    assert!(steer_text.contains("Do not start new substantive work"));
    let row = steer
        .request
        .custom_message
        .as_ref()
        .expect("the row rides");
    assert_eq!(row["customType"], "goal_context");
    assert_eq!(row["details"]["kind"], "budget_limit");
    // The steer carries no goal_update: the budget transition was
    // announced through the run's own `goal_update` event.
    assert!(steer.goal_update.is_none());
    drop(work);
    let goal_updates: Vec<&EngineEvent> = events
        .iter()
        .filter(|event| matches!(event, EngineEvent::GoalUpdate { .. }))
        .collect();
    assert!(
        goal_updates
            .iter()
            .any(|event| matches!(event, EngineEvent::GoalUpdate { goal }
                if goal["status"] == serde_json::json!("budget_limited"))),
        "the budget transition never announced: {events:?}"
    );
    // The run stopped at the crossing turn (TS: queued steer owns the
    // next turn, `resumeIfIdle`).
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
}

/// The queued-input gate (TS `queuedActionCount > 0`): queued session
/// input owns the turn boundary, the mint defers without consuming a
/// slot, and the boundary after the queued work drains re-mints.
#[test]
fn queued_input_defers_the_turn_end_mint() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, _engine_dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "first"}, {"text": "second"}] }),
        1,
    );
    let engine = std::sync::Arc::new(engine);
    // A probe that reports queued input while the flag is set: the
    // test flips it to simulate the queue draining.
    let queued = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let probe_queued = std::sync::Arc::clone(&queued);
    let goal_work: std::sync::Arc<std::sync::Mutex<Vec<crate::engine::GoalTurnEndWork>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = std::sync::Arc::clone(&goal_work);
    engine.set_goal_admission(
        std::sync::Arc::new(move || probe_queued.load(std::sync::atomic::Ordering::SeqCst)),
        std::sync::Arc::new(move |work| sink.lock().unwrap().push(work)),
        std::sync::Arc::new(|| {}),
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(
        &engine,
        "/goal ship past the queue".to_string(),
        &mut events,
    );
    // Queued input owns the boundary: no mint, no slot consumed.
    assert!(goal_work.lock().unwrap().is_empty());
    assert_eq!(engine.goal_state_value()["continuationsUsed"], 0);
    assert_eq!(engine.goal_state_value()["status"], "active");
    // The queue drains: the next boundary mints the continuation.
    queued.store(false, std::sync::atomic::Ordering::SeqCst);
    let mut after_drain: Vec<EngineEvent> = Vec::new();
    admit(&engine, "the queued work ran".to_string(), &mut after_drain);
    let work = goal_work.lock().unwrap();
    let [crate::engine::GoalTurnEndWork::Continuation(follow_up)] = work.as_slice() else {
        panic!("expected exactly one continuation: {work:?}");
    };
    assert_eq!(
        follow_up.request.custom_message.as_ref().unwrap()["details"]["continuationsUsed"],
        serde_json::json!(1)
    );
    assert_eq!(engine.goal_state_value()["continuationsUsed"], 1);
}

/// The quiescence gate (TS `_getGoalContinuationMessages`'s
/// `_hasUnsettledRlmQuiescenceWork` arm and
/// `_maybeResumeGoalContinuationAfterRlmWork`): the natural turn end
/// defers the continuation behind a running child (owed, not
/// consumed), and the child's settle delivers it once through the
/// admission sink.
#[test]
fn running_children_owe_the_continuation_and_settle_delivers_it() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let engine = std::sync::Arc::new(
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: dir.path().join("agent"),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: Some(
                serde_json::json!({ "responses": [{"text": "parent turn reply"}] }).to_string(),
            ),
            supervisor_link: Some(crate::agent_engine::SupervisorLinkConfig {
                socket_path: dir.path().join("dead.sock"),
                active_session_id: "parent-session".to_string(),
                worker_token: "token".to_string(),
            }),
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap(),
    );
    let goal_work = goal_admission_collector(&engine);
    let children = engine.children.clone().expect("children registry");
    // A running child (the test seam): the quiescence gate holds.
    engine.runtime.block_on(async {
        children
            .push_test_child(crate::rlm_children::RlmChildIdentity {
                rlm_child_id: "child-1".to_string(),
                active_session_id: "child-session".to_string(),
                session_id: None,
                session_name: "worker-1".to_string(),
            })
            .await;
    });
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(
        &engine,
        "/goal ship behind the children".to_string(),
        &mut events,
    );
    // No mint while the child runs; the deferral is owed, not consumed,
    // and the run still settles normally (the TS goal holds the
    // continuation instead of re-prompting a waiting parent).
    assert!(goal_work.lock().unwrap().is_empty(), "events: {events:?}");
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
    assert_eq!(engine.goal_state_value()["status"], "active");
    assert_eq!(engine.goal_state_value()["continuationsUsed"], 0);
    let handles = engine
        .goal_runtime
        .lock()
        .unwrap()
        .clone()
        .expect("goal runtime");
    assert!(engine
        .runtime
        .block_on(async { handles.driver.lock().await.owes_continuation() }));
    // The child settles (the cancel walk): the settle hook delivers the
    // owed continuation exactly once through the admission sink.
    engine
        .runtime
        .block_on(async { children.cancel_child_run("child-1").await });
    for _ in 0..200 {
        if !goal_work.lock().unwrap().is_empty() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    let work = goal_work.lock().unwrap();
    let [crate::engine::GoalTurnEndWork::Continuation(follow_up)] = work.as_slice() else {
        panic!("expected exactly the owed continuation: {work:?}");
    };
    assert!(follow_up.request.message.contains("[goal: continuation]"));
    assert!(follow_up
        .request
        .message
        .contains("ship behind the children"));
    assert_eq!(
        follow_up.request.custom_message.as_ref().unwrap()["details"]["continuationsUsed"],
        serde_json::json!(1)
    );
    drop(work);
    // The deferral cleared and the slot was consumed exactly once.
    assert!(!engine
        .runtime
        .block_on(async { handles.driver.lock().await.owes_continuation() }));
    assert_eq!(engine.goal_state_value()["continuationsUsed"], 1);
}

/// The engine session's entries as their persisted wire shapes (the
/// hydrating snapshot: a windowed manager holds only the suffix).
fn engine_session_entries(engine: &AgentSessionEngine) -> Vec<pa_types::session::FileEntry> {
    let guard = engine.session.blocking_lock();
    let core = guard.as_deref().expect("session built");
    let persistence = core.session.shared_persistence();
    engine.runtime.block_on(async {
        let snapshot = persistence.lock().await.history_snapshot();
        snapshot.await.expect("history snapshot")
    })
}

/// An injected custom turn (wire `customMessage`, the RLM child
/// terminal-notice path) holds ONE representation in the engine
/// branch: the accepted custom row persists and renders as itself
/// (the wire pair, exactly once), the engine session's transcript
/// gains the custom row and NO user row with the same text, and the
/// model turn still runs on the notice text (TS
/// `_promptInjectedMessage` -> `agent.prompt([customMessage])`).
#[test]
fn injected_custom_turn_holds_one_representation() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, _dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "notice acknowledged"}] }),
        1,
    );
    let notice_text = "[child-exited: no-reply child:lane]";
    let notice = serde_json::json!({
        "role": "custom",
        "customType": "rlm_child_terminal_notice",
        "content": notice_text,
        "display": true,
        "details": {
            "kind": "completed_without_reply",
            "childId": "sub-1",
            "sessionName": "lane",
        },
        "timestamp": crate::util::now_ms(),
    });
    let mut events: Vec<EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: notice_text.to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: Some(notice),
        },
        &|| false,
        &mut |event| {
            events.push(event);
            true
        },
    );
    // The wire: the accepted custom row's pair, no user row, the
    // model turn settled on the notice text.
    let custom_rows: Vec<&Value> = events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::CustomMessage(row) if row["customType"] == "rlm_child_terminal_notice" => {
                Some(row)
            }
            _ => None,
        })
        .collect();
    assert_eq!(custom_rows.len(), 1, "events: {events:?}");
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::UserMessage(_))),
        "the injected turn must not emit a user row: {events:?}"
    );
    assert_eq!(
        assistant_texts(&events),
        vec!["notice acknowledged".to_string()],
        "the model turn ran on the notice text: {events:?}"
    );
    // The engine session's transcript: one custom row, no duplicate
    // user row with the notice text, the assistant settled.
    let entries = engine_session_entries(&engine);
    let notice_rows = entries
        .iter()
        .filter(|entry| {
            matches!(entry, pa_types::session::FileEntry::CustomMessage { payload, .. }
                if payload.custom_type == "rlm_child_terminal_notice")
        })
        .count();
    assert_eq!(notice_rows, 1, "entries: {entries:?}");
    let user_rows = entries
        .iter()
        .filter(|entry| match entry {
            pa_types::session::FileEntry::Message {
                message: pa_types::session::AgentMessage::User(user),
                ..
            } => user.content.text().contains(notice_text),
            _ => false,
        })
        .count();
    assert_eq!(
        user_rows, 0,
        "the injected turn must not persist a user row: {entries:?}"
    );
    let assistant_rows = entries
        .iter()
        .filter(|entry| {
            matches!(
                entry,
                pa_types::session::FileEntry::Message {
                    message: pa_types::session::AgentMessage::Assistant(_),
                    ..
                }
            )
        })
        .count();
    assert_eq!(assistant_rows, 1, "entries: {entries:?}");
}

/// A `/goal` start schedules its continuation as an injected custom
/// row (TS `_runOrQueueGoalContext` -> the prepared-turn primary
/// record): the engine session's transcript holds the goal-context
/// row once and NO user row carrying the goal-context prompt — the
/// pre-fix double representation that shifted the compaction walk.
#[test]
fn goal_start_continuation_holds_one_representation() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, _dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "goal turn reply"}] }),
        1,
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(
        &engine,
        "/goal land the post-compact continue".to_string(),
        &mut events,
    );
    assert_eq!(engine.goal_state_value()["status"], "active");
    let entries = engine_session_entries(&engine);
    let goal_rows: Vec<String> = entries
        .iter()
        .filter_map(|entry| match entry {
            pa_types::session::FileEntry::CustomMessage { payload, .. } => {
                (payload.custom_type == "goal_context").then(|| payload.content.text())
            }
            _ => None,
        })
        .collect();
    assert_eq!(goal_rows.len(), 1, "entries: {entries:?}");
    let goal_prompt = goal_rows[0].clone();
    let user_rows = entries
        .iter()
        .filter(|entry| match entry {
            pa_types::session::FileEntry::Message {
                message: pa_types::session::AgentMessage::User(user),
                ..
            } => user.content.text().contains(&goal_prompt),
            _ => false,
        })
        .count();
    assert_eq!(
        user_rows, 0,
        "the goal continuation must not persist a duplicate user row: {entries:?}"
    );
    // The wire: the goal-context row's message pair goes out with
    // the command rows, before the turn's assistant.
    let goal_pair_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::CustomMessage(row) if row["customType"] == "goal_context")
        })
        .expect("the goal-context row rides the wire");
    let assistant_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::AssistantMessage(message) if message["content"][0]["text"] == "goal turn reply")
        })
        .expect("the continuation turn settled");
    assert!(
        goal_pair_index < assistant_index,
        "the row precedes the turn it drives: {events:?}"
    );
}

/// The aborted turn's goal accounting (TS
/// `_accountGoalUsageForAssistantMessage`'s aborted guard): an active
/// goal's turn aborted mid-provider-wait settles on its aborted row —
/// broadcast through the engine's stream as the `message_start`/
/// `message_end` pair (the row's own start frame plus the settled row,
/// `createAbortedAssistantMessage`'s shape: empty content, the abort
/// error, EMPTY usage) — and the row persists, yet the goal accounting
/// skips it: the goal state the goal-start turn left is the state the
/// abort returns (same status, same tokens, same continuation count).
#[test]
fn active_goal_aborted_turn_row_broadcasts_and_goal_accounting_skips_it() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(
            json!({
                "engine": "faux",
                "responses": [
                    { "text": "goal start reply" },
                    { "text": "held reply", "delayMs": 60000 },
                ],
            })
            .to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let engine = std::sync::Arc::new(engine);
    // No worker owns the queue here: minted continuation work collects
    // instead of running, so the held turn below is the only live one.
    let _goal_work = goal_admission_collector(&engine);
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(
        &engine,
        "/goal land the aborted row accounting".to_string(),
        &mut events,
    );
    // The goal-start continuation turn ran inside the command's prompt and
    // its usage was accounted (faux usage is nonzero).
    let before = engine.goal_state_value();
    assert_eq!(before["status"], json!("active"), "state: {before:?}");
    assert!(
        before["tokensUsed"].as_u64().unwrap_or(0) > 0,
        "the goal-start turn's usage accounted: {before:?}"
    );
    // The second turn holds mid-provider-wait; the abort cancels the fetch
    // (the eager funnel) and the turn settles on the aborted row.
    let turn_engine = std::sync::Arc::clone(&engine);
    let turn_events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> = Arc::default();
    let row_events = std::sync::Arc::clone(&turn_events);
    let turn = std::thread::spawn(move || {
        turn_engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message: "held turn".to_string(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                row_events.lock().unwrap().push(event);
                true
            },
        );
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let agent = engine.turn_agent.lock().expect("turn agent lock").clone();
        if let Some(agent) = agent {
            let state = engine.runtime.block_on(agent.state());
            if state.is_streaming {
                break;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the held turn never started streaming"
        );
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    engine.abort_in_flight_turn();
    turn.join().expect("the aborted turn settles");
    // The aborted row broadcast as a pair: the row's own start frame (the
    // no-partial abort begins a new message) plus the settled end row.
    let events = turn_events.lock().unwrap();
    let aborted_start = events
        .iter()
        .find_map(|event| match event {
            EngineEvent::AssistantUpdate {
                message,
                stream_event,
            } => (message.get("stopReason").and_then(Value::as_str) == Some("aborted")
                && stream_event
                    .as_ref()
                    .and_then(|event| event.get("type"))
                    .and_then(Value::as_str)
                    == Some("start"))
            .then_some(message.clone()),
            _ => None,
        })
        .expect("the aborted row's start frame broadcast");
    assert_eq!(aborted_start["role"], json!("assistant"));
    assert_eq!(aborted_start["errorMessage"], json!("Request was aborted"));
    let aborted_end = events
        .iter()
        .rev()
        .find_map(|event| match event {
            EngineEvent::AssistantMessage(message)
                if message.get("stopReason").and_then(Value::as_str) == Some("aborted") =>
            {
                Some(message.clone())
            }
            _ => None,
        })
        .expect("the aborted row's settled frame broadcast");
    assert_eq!(aborted_end["role"], json!("assistant"));
    assert_eq!(aborted_end["stopReason"], json!("aborted"));
    assert_eq!(aborted_end["errorMessage"], json!("Request was aborted"));
    assert_eq!(
        aborted_end["content"],
        json!([{ "type": "text", "text": "" }]),
        "the no-partial abort carries empty content"
    );
    assert_eq!(aborted_end["usage"]["totalTokens"], json!(0));
    assert_eq!(aborted_end["usage"]["input"], json!(0));
    assert_eq!(aborted_end["usage"]["output"], json!(0));
    // The goal accounting skipped the aborted row: the goal state the
    // goal-start turn left is unchanged (the wall-clock fields are
    // time-based, so the accounting fields compare).
    let after = engine.goal_state_value();
    assert_eq!(after["status"], json!("active"), "state: {after:?}");
    assert_eq!(after["objective"], before["objective"]);
    assert_eq!(after["tokensUsed"], before["tokensUsed"]);
    assert_eq!(after["continuationsUsed"], before["continuationsUsed"]);
}

/// The shared window's goal seed must equal the reference goal reader
/// over the windowed and fallback classes, including the off-branch
/// row both readers must skip (the window walk's on-path gate and the
/// fallback's active-branch scan agree).
#[test]
fn shared_window_goal_seed_matches_persisted_goal_state() {
    let header = || {
        json!({
            "type": "session", "version": 3, "id": "s",
            "timestamp": "2026-01-01T00:00:00.000Z", "cwd": "/w",
        })
    };
    // A message row: `parent: Some(_)` links it into the branch
    // chain; `None` terminates the ancestry at this row (the window
    // walk's `expected` must resolve to `None` before the header or
    // the open reads as ambiguous ancestry and falls back).
    let message = |id: &str, parent: Option<&str>, role: &str| {
        let mut row = json!({
            "type": "message", "id": id, "parentId": parent,
            "timestamp": "2026-01-01T00:00:01.000Z",
            "message": { "role": role, "content": "hi", "timestamp": 0 },
        });
        if parent.is_none() {
            row.as_object_mut().unwrap().remove("parentId");
        }
        // The window walk requires the assistant message's provider/model
        // pair (the leaf's model fold): an assistant row without them
        // reads as ambiguous ancestry and the open falls back.
        if role == "assistant" {
            let message = row["message"].as_object_mut().unwrap();
            message.insert("provider".into(), json!("faux"));
            message.insert("model".into(), json!("faux-1"));
        }
        row
    };
    let goal_row = |id: &str, parent: &str| {
        json!({
            "type": "custom", "id": id, "parentId": parent,
            "timestamp": "2026-01-01T00:00:02.000Z",
            "customType": pa_core::goals::GOAL_STATE_CUSTOM_TYPE,
            "data": {
                "active": true, "status": "active", "goalId": "goal-1",
                "objective": "ship the port", "tokensUsed": 340,
                "timeUsedSeconds": 9, "continuationsUsed": 2,
            },
        })
    };
    // (name, rows, terminated tail, the window MUST serve): an
    // unterminated row forces the ordinary full-reader fallback for
    // both readers. The `window_serves` flag is the anti-vacuity gate:
    // the windowed classes must genuinely take the WINDOW path (the
    // exact surface the shared-open changes) — a fixture regression
    // that silently falls back fails the open-outcome assertion, not
    // just the (trivially equal) goal comparison.
    let classes: Vec<(&str, Vec<serde_json::Value>, bool, bool)> = [
        (
            "windowed_with_goal",
            vec![header(), message("m1", None, "user"), goal_row("g1", "m1")],
            true,
            true,
        ),
        (
            "windowed_no_goal",
            vec![header(), message("m1", None, "user")],
            true,
            true,
        ),
        (
            "windowed_off_branch_goal",
            vec![
                header(),
                // The goal links to a row no chain reaches: the active
                // branch (leaf m2 -> m1 -> header) never visits it, so
                // the window's on-path capture skips it exactly like
                // the reference reader does.
                goal_row("g1", "ghost-id"),
                message("m1", None, "user"),
                message("m2", Some("m1"), "assistant"),
            ],
            true,
            true,
        ),
        (
            "fallback_with_goal",
            vec![header(), message("m1", None, "user"), goal_row("g1", "m1")],
            false,
            false,
        ),
        (
            "fallback_no_goal",
            vec![header(), message("m1", None, "user")],
            false,
            false,
        ),
    ]
    .into();
    for (name, rows, terminated, window_serves) in classes {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut content = rows
            .iter()
            .map(std::string::ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        if terminated {
            content.push('\n');
        }
        std::fs::write(&path, content).unwrap();
        let opened = pa_core::session::window::WindowedSessionStore::open(&path);
        let window_served = opened.as_ref().is_ok_and(std::option::Option::is_some);
        assert_eq!(
            window_served, window_serves,
            "goal class {name}: the window-served outcome must match the class (the windowed classes must exercise the WINDOW path, the fallback classes the full reader)"
        );
        // The shared open's extraction (adopt_built_session's block):
        // the window's snapshot goal when the window serves, else the
        // loaded store's active-branch scan.
        let shared = match opened {
            Ok(Some(window)) => window.goal_state().cloned(),
            _ => crate::session_store::SessionFile::open(&path)
                .ok()
                .as_ref()
                .and_then(crate::goal_state_persist::goal_state_in_session_file),
        };
        assert_eq!(
            shared,
            crate::goal_state_persist::persisted_goal_state(Some(&path)),
            "goal class {name}"
        );
    }
}
