//! Agent engine tests (moved with their concerns).
/// The faux provider registry is process-global; faux-driven tests must
/// not register concurrently (each registration replaces the queue).
#[cfg(test)]
pub(crate) static FAUX_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

use super::*;
use serde_json::Map;

/// The faux model's per-request output budget (maxTokens `16_384` under the
/// `32_000` request cap): threshold fixtures subtract it from the window
/// alongside the headroom (the combined input+output ceiling).
const FAUX_REQUEST_BUDGET: u64 = 16_384;

/// A models.json custom provider (name has no env-key mapping), with an
/// apiKey the registry must resolve for request auth (the env-key map
/// alone cannot find it).
fn write_custom_provider_models_json(agent_dir: &std::path::Path, base_url: &str) {
    std::fs::create_dir_all(agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": base_url,
                    "apiKey": "sk-battery",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096,
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
}

/// A models.json custom-provider pair for the thinking clamp: a
/// reasoning model (supports the full level ladder up to `high`) and a
/// non-reasoning one (supports only `off`) — the restore must clamp
/// the requested level against whichever one the session file pins.
fn write_thinking_pair_models_json(agent_dir: &std::path::Path, base_url: &str) {
    std::fs::create_dir_all(agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": base_url,
                    "apiKey": "sk-battery",
                    "models": [
                        {
                            "id": "mock-reason",
                            "name": "Mock Reasoning",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096,
                            "reasoning": true,
                        },
                        {
                            "id": "mock-plain",
                            "name": "Mock Plain",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096,
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
}

#[test]
fn create_config_flags_reach_the_engine_model_resolution() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");

    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        // No process-level fallback: the wire flags must be the source.
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    // The explicit selection from the session's create config is
    // authoritative over any process-wide fallback model.
    engine.configure_model(EngineModelSelection {
        provider: Some("battery".to_string()),
        model: Some("mock-1".to_string()),
        api_key: None,
        thinking: None,
    });
    let model = engine.resolve_registry_model().expect("resolved model");
    assert_eq!(model.provider, "battery");
    assert_eq!(model.id, "mock-1");
    // The registry resolves the models.json apiKey (the provider name has
    // no env-key mapping), so the engine can authenticate without env.
    assert_eq!(
        engine.resolve_request_api_key(&model).as_deref(),
        Some("sk-battery")
    );
}

fn bare_engine(dir: &std::path::Path) -> AgentSessionEngine {
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.to_path_buf(),
        agent_dir,
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap()
}

/// A settings.json with an explicit compaction reserve (the f14 battery
/// shape: `reserveTokens` set so a seeded usage crosses the headroom).
fn write_compaction_settings(dir: &std::path::Path, reserve_tokens: u64) {
    std::fs::create_dir_all(dir.join("agent")).unwrap();
    std::fs::write(
        dir.join("agent").join("settings.json"),
        serde_json::json!({ "compaction": { "enabled": true, "reserveTokens": reserve_tokens, "keepRecentTokens": 10 } })
            .to_string(),
    )
    .unwrap();
}

/// One faux-driven engine over its own tempdir (settings written before
/// the first prompt so the session build resolves them).
pub(crate) fn faux_engine_with_settings(
    script: serde_json::Value,
    reserve_tokens: u64,
) -> (AgentSessionEngine, tempfile::TempDir) {
    let dir = tempfile::TempDir::new().unwrap();
    write_compaction_settings(dir.path(), reserve_tokens);
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(script.to_string()),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    (engine, dir)
}

/// The goal-admission collector: installs the turn-end seam (a probe
/// reporting no queued input plus a sink capturing minted work) on an
/// engine built without a worker.
pub(crate) fn goal_admission_collector(
    engine: &std::sync::Arc<AgentSessionEngine>,
) -> std::sync::Arc<std::sync::Mutex<Vec<crate::engine::GoalTurnEndWork>>> {
    let collected: std::sync::Arc<std::sync::Mutex<Vec<crate::engine::GoalTurnEndWork>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = std::sync::Arc::clone(&collected);
    engine.set_goal_admission(
        std::sync::Arc::new(|| false),
        std::sync::Arc::new(move |work| sink.lock().unwrap().push(work)),
        std::sync::Arc::new(|| {}),
    );
    collected
}

/// Admit one prompt through the engine, collecting its events.
pub(crate) fn admit(engine: &AgentSessionEngine, message: String, events: &mut Vec<EngineEvent>) {
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message,
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        &|| false,
        &mut |event| {
            events.push(event);
            true
        },
    );
}

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

/// The automatic threshold compaction at the turn boundary (TS
/// `_checkCompaction` threshold arm): a settled turn whose usage
/// crosses the reserve headroom emits the `compaction_start` /
/// `compaction_end` pair with the `threshold` reason, runs the
/// summarizer, and rewrites the loop context.
///
/// The faux provider estimates usage from the serialized context (the
/// f14 battery's mock-provider shape is not part of the faux script),
/// so the probe engine first measures one baseline turn's usage and the
/// threshold engine places the headroom halfway between that baseline
/// and the baseline plus the big prompt (~12k tokens of `x`s) —
/// environment-independent margins on both sides.
#[test]
fn threshold_crossing_auto_compacts_with_the_event_pair() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Probe: the baseline turn's total usage (system prompt included).
    let (probe, _probe_dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "seed reply"}] }),
        1,
    );
    let mut probe_events: Vec<EngineEvent> = Vec::new();
    admit(&probe, "seed turn".to_string(), &mut probe_events);
    let baseline = probe_events
        .iter()
        .find_map(|event| match event {
            EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
            _ => None,
        })
        .expect("probe turn produced usage");
    assert!(
        baseline < 100_000,
        "the probe baseline is implausibly large: {baseline}"
    );
    drop(probe);

    // ~12k tokens of deterministic extra context on the crossing turn.
    let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
    let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
    // The headroom sits between the two turns' usage (the f14 battery
    // shape: reserveTokens so exactly the seeded crossing fires).
    let headroom = baseline + big_tokens / 2;
    let (engine, _engine_dir) = faux_engine_with_settings(
        serde_json::json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "crossing reply"},
                {"text": "the summary"},
            ],
        }),
        128_000u64
            .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
            .max(1),
    );

    let mut events: Vec<EngineEvent> = Vec::new();
    // The seed turn stays below the headroom: no compaction events.
    admit(&engine, "seed turn".to_string(), &mut events);
    assert_eq!(
        assistant_texts(&events),
        vec!["seed reply".to_string()],
        "the seed turn answered"
    );
    assert!(
        !events.iter().any(|event| matches!(
            event,
            EngineEvent::CompactionStart { .. } | EngineEvent::Compaction { .. }
        )),
        "no compaction below the headroom"
    );
    // The threshold-crossing turn: the settled usage fires the
    // `compaction_start`/`compaction_end` pair with the `threshold`
    // reason, after the assistant message (TS agent_end order).
    admit(&engine, big_prompt, &mut events);
    let assistant_index = events
        .iter()
        .rposition(|event| matches!(event, EngineEvent::AssistantMessage(_)))
        .expect("assistant message emitted");
    let start_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::CompactionStart { event } if event["reason"] == "threshold")
        })
        .expect("threshold compaction_start emitted");
    assert!(
        start_index > assistant_index,
        "the check fires at the settled turn boundary"
    );
    let EngineEvent::CompactionStart { event } = &events[start_index] else {
        unreachable!();
    };
    assert_eq!(
        event,
        &serde_json::json!({ "type": "compaction_start", "reason": "threshold" })
    );
    // The durable end event carries the entry and the client-facing
    // result with the summarizer's text (the summarizer consumed the
    // third scripted response).
    let compaction_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::Compaction { .. }))
        .expect("compaction_end emitted");
    let EngineEvent::Compaction { entry, event } = &events[compaction_index] else {
        unreachable!();
    };
    assert!(compaction_index > start_index);
    assert_eq!(event["reason"], "threshold");
    assert_eq!(event["result"]["summary"], "the summary");
    // The threshold event's result carries the TS dataKeys too: the
    // file-op `details` verbatim from the durable entry.
    assert_eq!(
        event["result"]["details"],
        serde_json::json!({ "readFiles": [], "modifiedFiles": [] })
    );
    assert!(entry["firstKeptEntryId"].is_string());
    // Exactly one pair for the admission: the pre-turn check on the
    // first iteration sees no built session (nothing to compact), and
    // the post-turn check fires once — no double compaction.
    let start_count = events
        .iter()
        .filter(|event| matches!(event, EngineEvent::CompactionStart { .. }))
        .count();
    let end_count = events
        .iter()
        .filter(|event| matches!(event, EngineEvent::Compaction { .. }))
        .count();
    assert_eq!((start_count, end_count), (1, 1));
}

/// The compaction summarizer stays on the session's provider when a
/// fresh startup-chain resolution drifts mid-session (R8): the live
/// report was a prime-inference session whose threshold
/// auto-compaction re-resolved to `amazon-bedrock` and failed with
/// "No AWS credentials available for Bedrock" while the session's
/// turns kept streaming through the target's provider. The session
/// builds on the models.json faux model; the settings default then
/// changes under it (the drift a live catalog or settings edit
/// produces), so [`AgentSessionEngine::resolve_model`] now lands on
/// a dead provider — but the threshold arm follows the session's
/// provider target ([`AgentSessionEngine::session_model`]): the
/// summarizer request still hits the faux provider and the
/// compaction succeeds instead of failing on the drift model.
#[test]
fn threshold_compaction_stays_on_the_session_provider_after_a_resolution_drift() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    // The session's provider: the process-global faux provider
    // (api "faux"), serving the turn replies and the summarizer.
    let script = json!({
        "responses": [
            {"text": "seed reply"},
            {"text": "crossing reply"},
            {"text": "the drifted summary"},
        ],
    });
    let parsed = pa_ai::faux::script::parse_faux_script(&script).expect("faux script parses");
    let registration = pa_ai::faux::script::register_faux_provider_from_script(&parsed);
    // The registry catalog: the faux model the session builds on,
    // and the drift model — an openai-completions endpoint nothing
    // serves (the live R8 shape: Bedrock with no credentials), so a
    // request against it fails.
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "faux": {
                    "api": "faux",
                    "baseUrl": "http://localhost:0",
                    "apiKey": "sk-faux",
                    "models": [{
                        "id": "faux-1",
                        "name": "Faux Model",
                        "contextWindow": 128_000,
                        "maxTokens": 16384,
                    }],
                },
                "drift": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9",
                    "apiKey": "sk-drift",
                    "models": [{
                        "id": "drift-1",
                        "name": "Drift Model",
                        "contextWindow": 128_000,
                        "maxTokens": 16384,
                    }],
                },
            }
        })
        .to_string(),
    )
    .unwrap();
    let write_settings = |default_provider: &str, default_model: &str, reserve_tokens: u64| {
        std::fs::write(
            agent_dir.join("settings.json"),
            json!({
                "defaultProvider": default_provider,
                "defaultModel": default_model,
                "compaction": {
                    "enabled": true,
                    "reserveTokens": reserve_tokens,
                    "keepRecentTokens": 10,
                },
            })
            .to_string(),
        )
        .unwrap();
    };
    let new_engine = || {
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap()
    };
    // Probe: the baseline turn's total usage (the faux provider
    // estimates usage from the serialized context, system prompt
    // included) with the threshold far away.
    write_settings("faux", "faux-1", 1);
    let probe = new_engine();
    let mut probe_events: Vec<EngineEvent> = Vec::new();
    admit(&probe, "seed turn".to_string(), &mut probe_events);
    let baseline = probe_events
        .iter()
        .find_map(|event| match event {
            EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
            _ => None,
        })
        .expect("probe turn produced usage");
    assert!(baseline < 100_000, "implausible baseline: {baseline}");
    drop(probe);

    // The threshold engine: the combined input+output ceiling sits
    // between the seed turn's usage and the crossing turn's (the
    // same probe margins the sibling threshold tests use; the
    // 16_384 per-request output budget is part of the ceiling).
    let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
    let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
    let headroom = baseline + big_tokens / 2;
    let reserve = 128_000u64
        .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
        .max(1);
    write_settings("faux", "faux-1", reserve);
    registration.set_responses(parsed.responses);
    let engine = new_engine();
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    assert_eq!(assistant_texts(&events), vec!["seed reply".to_string()]);
    assert!(
        !events.iter().any(|event| matches!(
            event,
            EngineEvent::CompactionStart { .. } | EngineEvent::Compaction { .. }
        )),
        "no compaction below the threshold"
    );

    // The mid-session resolution drift (the live R8 shape): the
    // settings default changes under the built session, so a fresh
    // startup-chain resolution lands on the dead provider while the
    // session's live model stays the provider target.
    write_settings("drift", "drift-1", reserve);
    let drifted = engine.resolve_model().expect("the drift model resolves");
    assert_eq!(
        (drifted.provider.as_str(), drifted.id.as_str()),
        ("drift", "drift-1")
    );
    let session = engine.session_model().expect("the session model resolves");
    assert_eq!(
        (session.provider.as_str(), session.id.as_str()),
        ("faux", "faux-1")
    );

    // The threshold arm compacts on the session's provider: the
    // crossing turn's boundary runs the summarizer through the faux
    // provider (its queued reply is the compaction result), never
    // the dead drift model.
    let calls_before_crossing = registration.call_count();
    let mut crossing_events: Vec<EngineEvent> = Vec::new();
    admit(&engine, big_prompt, &mut crossing_events);
    let starts = crossing_events
        .iter()
        .filter(
            |event| matches!(event, EngineEvent::CompactionStart { event } if event["reason"] == "threshold"),
        )
        .count();
    let ends = crossing_events
        .iter()
        .filter(|event| matches!(event, EngineEvent::Compaction { .. }))
        .count();
    assert_eq!((starts, ends), (1, 1));
    let summary = crossing_events
        .iter()
        .find_map(|event| match event {
            EngineEvent::Compaction { event, .. } => {
                event["result"]["summary"].as_str().map(str::to_string)
            }
            _ => None,
        })
        .expect("the compaction end carries the summarizer's text");
    assert_eq!(summary, "the drifted summary");
    // The crossing turn and the summarizer both served through the
    // session's provider — the drift model was never called.
    assert_eq!(
        registration.call_count(),
        calls_before_crossing + 2,
        "the crossing turn and the summarizer ran on the session provider"
    );
    assert_eq!(
        assistant_texts(&crossing_events),
        vec!["crossing reply".to_string()]
    );
    // The summarizer followed the live target's key too (the R8
    // seam's key arm): every request against the registration carried
    // the models.json faux key — the engine's config key is `None`,
    // so a summarizer reading the stale config key would surface as
    // a `None` entry here.
    let keys = registration.received_api_keys();
    assert_eq!(keys.len() as u64, registration.call_count());
    assert!(
        keys.iter().all(|key| key.as_deref() == Some("sk-faux")),
        "every call followed the live target's key: {keys:?}"
    );
    assert!(matches!(
        crossing_events.last(),
        Some(EngineEvent::Done(Ok(())))
    ));
}

/// Retirement clears the provider target with the session (the TS
/// replacement teardown): a demand seam before the replacement build
/// (an immediate `/compact` after the teardown) resolves the CURRENT
/// model through the pre-build `resolve_model` fallback, never the
/// retired session's target — a cwd/settings model change lands with
/// the replacement, not the stale target.
#[test]
fn retire_clears_the_provider_target_for_the_replacement_build() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let script = json!({ "responses": [{"text": "seed reply"}] });
    let parsed = pa_ai::faux::script::parse_faux_script(&script).expect("faux script parses");
    let _registration = pa_ai::faux::script::register_faux_provider_from_script(&parsed);
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "faux": {
                    "api": "faux", "baseUrl": "http://localhost:0", "apiKey": "sk-faux",
                    "models": [{
                        "id": "faux-1", "name": "Faux Model",
                        "contextWindow": 128_000, "maxTokens": 16384,
                    }],
                },
                "drift": {
                    "api": "faux", "baseUrl": "http://localhost:0", "apiKey": "sk-drift",
                    "models": [{
                        "id": "drift-1", "name": "Drift Model",
                        "contextWindow": 128_000, "maxTokens": 16384,
                    }],
                },
            }
        })
        .to_string(),
    )
    .unwrap();
    let write_settings = |default_provider: &str, default_model: &str| {
        std::fs::write(
            agent_dir.join("settings.json"),
            json!({
                "defaultProvider": default_provider,
                "defaultModel": default_model,
            })
            .to_string(),
        )
        .unwrap();
    };
    let new_engine = || {
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap()
    };
    write_settings("faux", "faux-1");
    let engine = new_engine();
    // The turn builds the session and pins the provider target.
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    let model = engine.session_model().expect("the session model resolves");
    assert_eq!(
        (model.provider.as_str(), model.id.as_str()),
        ("faux", "faux-1")
    );

    // The replacement teardown retires the session while the settings
    // default moves under it (the cwd/settings change the
    // replacement carries).
    write_settings("drift", "drift-1");
    engine
        .runtime
        .block_on(async { engine.retire_session_runtime().await });
    assert!(engine
        .runtime
        .block_on(async { engine.session.lock().await.is_none() }));

    // A demand seam before the replacement build (the prewarm has not
    // rebuilt yet) resolves the CURRENT model, never the retired
    // session's target.
    let model = engine
        .session_model()
        .expect("the replacement model resolves");
    assert_eq!(
        (model.provider.as_str(), model.id.as_str()),
        ("drift", "drift-1"),
        "the retired session's provider target must not outlive it"
    );
}

/// End the session telemetry (flushing every queued event through the
/// local mirror sink) and read one named event's properties: the
/// transparency mirror is the product's own observable surface for the
/// run counters.
fn mirror_telemetry_properties(
    engine: &AgentSessionEngine,
    dir: &std::path::Path,
    name: &str,
) -> Vec<Value> {
    {
        let guard = engine.session.blocking_lock();
        let telemetry = guard
            .as_ref()
            .and_then(|core| core.telemetry.as_ref())
            .expect("the faux engine has telemetry installed");
        engine
            .runtime
            .block_on(async { telemetry.end().await })
            .expect("telemetry end flushes");
    }
    let mirror = std::fs::read_to_string(dir.join("agent").join("telemetry.jsonl"))
        .expect("the telemetry mirror exists");
    mirror
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| event["name"] == name)
        .map(|event| event["properties"].clone())
        .collect()
}

/// The threshold arm feeds the compaction telemetry seam: the crossing
/// turn's compaction counts into the open run's `compaction_count` and
/// the session total (TS `compaction_end` handling).
#[test]
fn threshold_compaction_counts_into_the_run_telemetry() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Probe: the baseline turn's total usage (system prompt included).
    let (probe, _probe_dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "seed reply"}] }),
        1,
    );
    let mut probe_events: Vec<EngineEvent> = Vec::new();
    admit(&probe, "seed turn".to_string(), &mut probe_events);
    let baseline = probe_events
        .iter()
        .find_map(|event| match event {
            EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
            _ => None,
        })
        .expect("probe turn produced usage");
    drop(probe);

    let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
    let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
    let headroom = baseline + big_tokens / 2;
    let (engine, dir) = faux_engine_with_settings(
        serde_json::json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "crossing reply"},
                {"text": "the summary"},
            ],
        }),
        128_000u64
            .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
            .max(1),
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut events);
    admit(&engine, big_prompt, &mut events);
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::Compaction { .. })),
        "the crossing turn compacted"
    );
    let runs = mirror_telemetry_properties(&engine, dir.path(), "agent run completed");
    assert_eq!(runs.len(), 2, "one run per admitted prompt");
    assert_eq!(runs[0]["compaction_count"], serde_json::json!(0));
    assert_eq!(
        runs[1]["compaction_count"],
        serde_json::json!(1),
        "the threshold compaction counted into the open run"
    );
    let ended = mirror_telemetry_properties(&engine, dir.path(), "agent session ended");
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0]["compaction_count"], serde_json::json!(1));
}

/// The requested arm feeds the same seam: the boundary compaction the
/// kernel's `compact.run` scheduled counts into the open run.
#[test]
fn requested_compaction_counts_into_the_run_telemetry() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // A tiny reserve keeps the threshold arm silent (TS reserve 1 means
    // the context must nearly fill the window).
    let (engine, dir) = faux_engine_with_settings(
        serde_json::json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "second reply"},
                {"text": "the summary"},
            ]
        }),
        1,
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(
        &engine,
        format!("turn one {}", "x".repeat(48_000)),
        &mut events,
    );
    {
        let guard = engine.session.blocking_lock();
        let core = guard.as_deref().expect("session built");
        engine
            .runtime
            .block_on(async { core.turn_boundary.schedule_compaction(None).await });
    }
    // The second turn carries enough tokens that the keep-recent cut
    // leaves the first turn summarizable (a tiny prompt cuts past it
    // and the compaction skips as too short).
    admit(
        &engine,
        format!("turn two {}", "x".repeat(2_000)),
        &mut events,
    );
    assert!(
        events.iter().any(|event| matches!(
            event,
            EngineEvent::Compaction { event, .. } if event["reason"] == "requested"
        )),
        "the requested compaction ran"
    );
    let runs = mirror_telemetry_properties(&engine, dir.path(), "agent run completed");
    assert_eq!(runs.len(), 2, "one run per admitted prompt");
    assert_eq!(runs[0]["compaction_count"], serde_json::json!(0));
    assert_eq!(
        runs[1]["compaction_count"],
        serde_json::json!(1),
        "the requested compaction counted into the open run"
    );
    let ended = mirror_telemetry_properties(&engine, dir.path(), "agent session ended");
    assert_eq!(ended[0]["compaction_count"], serde_json::json!(1));
}

/// The manual wire `compact` command (TS daemon-mode `compact`) feeds
/// the same seam: the compaction the `CompactionManager` runs counts
/// into the still-open run it interrupts.
#[test]
fn manual_wire_compaction_counts_into_the_run_telemetry() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, dir) = faux_engine_with_settings(
        serde_json::json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "second reply"},
                {"text": "the summary"},
            ]
        }),
        1,
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(
        &engine,
        format!("turn one {}", "x".repeat(48_000)),
        &mut events,
    );
    // A second, small-but-not-tiny turn: the keep-recent cut keeps it
    // (with turn one's tiny tail it would cut past everything and the
    // compaction would skip as too short).
    admit(
        &engine,
        format!("turn two {}", "x".repeat(2_000)),
        &mut events,
    );
    // The wire `compact` command: the CompactionManager's engine call
    // (the run happens between turns, so it counts into the deferred
    // run exactly like TS `compact()` between agent runs).
    let controller = std::sync::Arc::new(pa_agent::abort::AbortController::new());
    let signal = controller.signal();
    let outcome = engine.run_compaction(
        crate::engine::CompactionRequest {
            custom_instructions: None,
        },
        &signal,
    );
    assert!(
        matches!(outcome, crate::engine::CompactionOutcome::Compacted { .. }),
        "the manual compaction ran"
    );
    let runs = mirror_telemetry_properties(&engine, dir.path(), "agent run completed");
    assert_eq!(runs.len(), 2, "one run per admitted prompt");
    assert_eq!(runs[0]["compaction_count"], serde_json::json!(0));
    assert_eq!(
        runs[1]["compaction_count"],
        serde_json::json!(1),
        "the manual wire compaction counted into the open run"
    );
    let ended = mirror_telemetry_properties(&engine, dir.path(), "agent session ended");
    assert_eq!(ended[0]["compaction_count"], serde_json::json!(1));
}

/// The `compaction_outcome` rows an unsuccessful auto-compaction
/// records, with the indices of the disclosure pair and the end event
/// within the event list (the disclosure goes out first, the end event
/// second — TS `_endCompactionUnsuccessfully`).
fn outcome_row_and_end_event(
    events: &[EngineEvent],
    expected_reason: &str,
    expected_outcome: &str,
    expected_message: &str,
    expected_severity: &str,
) -> (usize, Value) {
    let row_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::CustomMessage(row) if row["customType"] == "compaction_outcome")
        })
        .expect("the outcome row was broadcast as a custom message");
    let row = match &events[row_index] {
        EngineEvent::CustomMessage(row) => row.clone(),
        _ => unreachable!("matched above"),
    };
    assert_eq!(row["role"], "custom", "the row is a custom message");
    assert_eq!(row["customType"], "compaction_outcome");
    assert_eq!(row["content"], serde_json::json!(expected_message));
    assert_eq!(row["display"], serde_json::json!(true));
    assert_eq!(
        row["details"],
        serde_json::json!({
            "reason": expected_reason,
            "outcome": expected_outcome,
        })
    );
    let end_index = events[row_index + 1..]
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::Compaction { event, .. } if event["type"] == "compaction_end")
        })
        .map(|offset| offset + row_index + 1)
        .expect("the settled compaction_end follows the row");
    let event = match &events[end_index] {
        EngineEvent::Compaction { event, .. } => event.clone(),
        _ => unreachable!("matched above"),
    };
    assert_eq!(event["reason"], serde_json::json!(expected_reason));
    assert_eq!(event["errorMessage"], serde_json::json!(expected_message));
    assert_eq!(event["errorSeverity"], serde_json::json!(expected_severity));
    assert_eq!(event["aborted"], serde_json::json!(false));
    assert_eq!(event["willRetry"], serde_json::json!(false));
    assert!(
        event.get("result").is_none(),
        "no result on an unsuccessful compaction"
    );
    (row_index, event)
}

/// The engine session's durable entry chain carries the outcome row.
pub(crate) fn outcome_row_in_entries(engine: &AgentSessionEngine) -> bool {
    let guard = engine.session.blocking_lock();
    let Some(core) = guard.as_deref() else {
        return false;
    };
    let persistence = core.session.shared_persistence();
    let entries = engine
        .runtime
        .block_on(async { persistence.lock().await.get_entries() });
    entries.iter().any(|entry| {
        matches!(entry, pa_types::session::FileEntry::CustomMessage { payload, .. }
            if payload.custom_type == "compaction_outcome")
    })
}

/// The live loop context carries the outcome row (TS
/// `agent.state.messages.push`); the loop's converter keeps it out of
/// the provider request.
pub(crate) fn outcome_row_in_live_context(engine: &AgentSessionEngine) -> bool {
    let guard = engine.session.blocking_lock();
    let Some(core) = guard.as_deref() else {
        return false;
    };
    engine.runtime.block_on(async {
        let state = core.session.agent().state().await;
        state
            .messages
            .last()
            .is_some_and(|message| message.role() == "custom")
    })
}

/// The threshold call site (TS `_runAutoCompaction` -> the
/// `CompactionSkippedError` arm): a threshold compaction that skips
/// records the durable `compaction_outcome` row, broadcasts its
/// message pair before the settled `compaction_end` warning, keeps it
/// in the live context, and never persists a compaction entry.
#[test]
fn threshold_skip_records_the_durable_outcome_row() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Probe: the baseline turn's total usage (system prompt included).
    let (probe, _probe_dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "seed reply"}] }),
        1,
    );
    let mut probe_events: Vec<EngineEvent> = Vec::new();
    admit(&probe, "seed turn".to_string(), &mut probe_events);
    let baseline = probe_events
        .iter()
        .find_map(|event| match event {
            EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
            _ => None,
        })
        .expect("probe turn produced usage");
    drop(probe);

    // One big crossing turn whose only summarizable history is itself:
    // the threshold fires, and the compaction skips (too short).
    let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
    let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
    let headroom = baseline + big_tokens / 2;
    let (engine, _engine_dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "crossing reply"}] }),
        128_000u64
            .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
            .max(1),
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, big_prompt, &mut events);
    assert_eq!(
        assistant_texts(&events),
        vec!["crossing reply".to_string()],
        "the crossing turn answered"
    );
    let skip_message =
        "Auto-compaction skipped: Session is too short to compact — try again once it grows";
    let (row_index, _) =
        outcome_row_and_end_event(&events, "threshold", "skipped", skip_message, "warning");
    let start_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::CompactionStart { event } if event["reason"] == "threshold")
        })
        .expect("threshold compaction_start emitted");
    assert!(
        row_index > start_index,
        "the disclosure pair goes out after the start event"
    );
    // The engine's durable entry chain and the live context both carry
    // the row; no compaction entry was written for the skip.
    assert!(outcome_row_in_entries(&engine));
    assert!(outcome_row_in_live_context(&engine));
    let guard = engine.session.blocking_lock();
    let core = guard.as_deref().expect("session built");
    let persistence = core.session.shared_persistence();
    let has_compaction_entry = engine.runtime.block_on(async {
        persistence
            .lock()
            .await
            .get_entries()
            .iter()
            .any(|entry| matches!(entry, pa_types::session::FileEntry::Compaction { .. }))
    });
    assert!(
        !has_compaction_entry,
        "a skipped compaction persists no compaction entry"
    );
}

/// The requested call site (the turn-boundary consumption): a scheduled
/// `compact.run` request that skips at consumption records the same
/// durable disclosure with the `requested` reason.
#[test]
fn requested_compaction_skip_records_the_durable_outcome_row() {
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
            serde_json::json!({ "responses": [{"text": "seed reply"}, {"text": "second reply"}] })
                .to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "turn one".to_string(), &mut events);
    // Schedule a requested compaction (the `compact.run` write path):
    // the boundary consumes it after the next turn settles.
    {
        let guard = engine.session.blocking_lock();
        let core = guard.as_deref().expect("session built");
        engine
            .runtime
            .block_on(async { core.turn_boundary.schedule_compaction(None).await });
    }
    admit(&engine, "turn two".to_string(), &mut events);
    assert_eq!(
        assistant_texts(&events),
        vec!["seed reply".to_string(), "second reply".to_string()],
        "both turns answered"
    );
    outcome_row_and_end_event(
        &events,
        "requested",
        "skipped",
        "Requested compaction skipped: Session is too short to compact — try again once it grows",
        "warning",
    );
    assert!(outcome_row_in_entries(&engine));
    assert!(outcome_row_in_live_context(&engine));
}

/// The engine session's durable entry chain carries a compaction
/// entry (an aborted run must never commit one).
pub(crate) fn compaction_entry_in_entries(engine: &AgentSessionEngine) -> bool {
    let guard = engine.session.blocking_lock();
    let Some(core) = guard.as_deref() else {
        return false;
    };
    let persistence = core.session.shared_persistence();
    let entries = engine.runtime.block_on(async {
        let snapshot = persistence.lock().await.history_snapshot();
        snapshot.await.expect("history snapshot")
    });
    entries
        .iter()
        .any(|entry| matches!(entry, pa_types::session::FileEntry::Compaction { .. }))
}

/// Admit one prompt on a parked thread, sharing its events; `started`
/// flips on the first compaction start event so the caller can abort
/// the run mid-flight. Returns the join handle.
pub(crate) fn admit_parked(
    engine: &std::sync::Arc<AgentSessionEngine>,
    message: String,
    events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>>,
    started: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> std::thread::JoinHandle<()> {
    let engine = std::sync::Arc::clone(engine);
    std::thread::spawn(move || {
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message,
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                if matches!(event, EngineEvent::CompactionStart { .. }) {
                    started.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                events
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(event);
                true
            },
        );
    })
}

/// Wait until the parked admission's compaction started (a deadline
/// instead of a hang when the run never reaches the summarizer).
pub(crate) fn wait_for_compaction_start(started: &std::sync::atomic::AtomicBool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !started.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(
            std::time::Instant::now() < deadline,
            "the auto compaction never started"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// The aborted `compaction_end` event for a cancelled auto compaction:
/// `aborted` with no `errorMessage`, no `errorSeverity`, and no
/// `result` (TS `_endCompactionUnsuccessfully`'s `{ aborted: true }`).
pub(crate) fn assert_cancelled_end_event(
    events: &[EngineEvent],
    expected_reason: &str,
    expected_row_message: &str,
) {
    let row_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::CustomMessage(row) if row["customType"] == "compaction_outcome")
        })
        .expect("the cancelled outcome row was broadcast");
    let EngineEvent::CustomMessage(row) = &events[row_index] else {
        unreachable!("matched above");
    };
    assert_eq!(row["customType"], "compaction_outcome");
    assert_eq!(row["content"], serde_json::json!(expected_row_message));
    assert_eq!(
        row["details"],
        serde_json::json!({
            "reason": expected_reason,
            "outcome": "cancelled",
        })
    );
    assert_eq!(row["display"], serde_json::json!(true));
    let EngineEvent::Compaction { event, .. } = events
        .iter()
        .rev()
        .find(|event| {
            matches!(event, EngineEvent::Compaction { event, .. }
                if event["type"] == "compaction_end" && event["reason"] == expected_reason)
        })
        .expect("the aborted compaction_end follows the row")
    else {
        unreachable!("matched above");
    };
    assert_eq!(event["aborted"], serde_json::json!(true));
    assert_eq!(event["willRetry"], serde_json::json!(false));
    assert!(
        event.get("errorMessage").is_none(),
        "aborts carry no error message: {event}"
    );
    assert!(
        event.get("errorSeverity").is_none(),
        "aborts carry no error severity: {event}"
    );
    assert!(
        event.get("result").is_none(),
        "an aborted run has no result: {event}"
    );
}

/// TS `_runAutoCompaction`'s aborted arm at the threshold call site: a
/// threshold compaction aborted while the summarizer is in flight
/// records the durable cancelled outcome row (`Compaction cancelled`,
/// `{threshold, cancelled}`), broadcasts the aborted `compaction_end`
/// (no error message — the row owns the disclosure), and never commits
/// a compaction entry; the turn still settles.
#[test]
fn threshold_compaction_aborted_mid_run_records_the_cancelled_outcome() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Probe: the baseline turn's total usage (the same shape as the
    // threshold crossing test; the headroom sits between the two
    // turns' usage).
    let (probe, _probe_dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "seed reply"}] }),
        1,
    );
    let mut probe_events: Vec<EngineEvent> = Vec::new();
    admit(&probe, "seed turn".to_string(), &mut probe_events);
    let baseline = probe_events
        .iter()
        .find_map(|event| match event {
            EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
            _ => None,
        })
        .expect("probe turn produced usage");
    drop(probe);

    let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
    let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
    let headroom = baseline + big_tokens / 2;
    let (engine, _engine_dir) = faux_engine_with_settings(
        serde_json::json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "crossing reply"},
                // The summarizer held in flight: the abort lands while
                // the request is open.
                {"text": "the summary", "delayMs": 30_000},
            ],
        }),
        128_000u64
            .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
            .max(1),
    );
    let engine = std::sync::Arc::new(engine);
    let mut seed_events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "seed turn".to_string(), &mut seed_events);
    assert!(
        !seed_events
            .iter()
            .any(|event| matches!(event, EngineEvent::CompactionStart { .. })),
        "the seed turn stays below the headroom"
    );

    let events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> = Arc::default();
    let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let admission = admit_parked(
        &engine,
        big_prompt,
        std::sync::Arc::clone(&events),
        std::sync::Arc::clone(&started),
    );
    wait_for_compaction_start(&started);
    engine.abort_auto_compaction();
    admission.join().expect("the aborted admission settles");

    let events = events
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    assert_cancelled_end_event(&events, "threshold", "Compaction cancelled");
    assert!(outcome_row_in_entries(&engine));
    assert!(outcome_row_in_live_context(&engine));
    assert!(
        !compaction_entry_in_entries(&engine),
        "the aborted threshold compaction never commits"
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::Done(Ok(())))),
        "the turn settles after the cancelled compaction"
    );
}

/// The aborted arm at the requested call site (the turn-boundary
/// consumption): a `compact.run` request aborted mid-summarizer
/// records the `Requested compaction cancelled` row with the
/// `requested` reason, broadcasts the aborted `compaction_end`
/// (`compaction_start` carries the run's reason), consumes the
/// pending request, and never commits.
#[test]
fn requested_compaction_aborted_mid_run_records_the_cancelled_outcome() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // A tiny reserve keeps the threshold check silent (the headroom is
    // the whole window) while the 10-token keep-recent budget leaves
    // the turns summarizable for the requested run.
    let (engine, _engine_dir) = faux_engine_with_settings(
        serde_json::json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "second reply"},
                // The summarizer held in flight for the abort.
                {"text": "the summary", "delayMs": 30_000},
            ],
        }),
        1_000,
    );
    let engine = std::sync::Arc::new(engine);
    let mut seed_events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "turn one".to_string(), &mut seed_events);
    // Schedule a requested compaction (the `compact.run` write path):
    // the boundary consumes it after the next turn settles.
    {
        let guard = engine.session.blocking_lock();
        let core = guard.as_deref().expect("session built");
        engine
            .runtime
            .block_on(async { core.turn_boundary.schedule_compaction(None).await });
    }

    let events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> = Arc::default();
    let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // A padded second turn keeps the cut's kept tail over the 10-token
    // keep-recent budget, leaving the first turn as summarizable
    // history for the requested run.
    let padded_turn_two = format!("turn two {}", "y".repeat(400));
    let admission = admit_parked(
        &engine,
        padded_turn_two,
        std::sync::Arc::clone(&events),
        std::sync::Arc::clone(&started),
    );
    wait_for_compaction_start(&started);
    let start_reason = events
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .find_map(|event| match event {
            EngineEvent::CompactionStart { event } => Some(event["reason"].clone()),
            _ => None,
        })
        .expect("the requested compaction_start event");
    assert_eq!(start_reason, serde_json::json!("requested"));
    engine.abort_auto_compaction();
    admission.join().expect("the aborted admission settles");

    let events = events
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    assert_cancelled_end_event(&events, "requested", "Requested compaction cancelled");
    assert!(outcome_row_in_entries(&engine));
    assert!(outcome_row_in_live_context(&engine));
    assert!(
        !compaction_entry_in_entries(&engine),
        "the aborted requested compaction never commits"
    );
    // The pending request was consumed: no stale compaction runs at
    // the next boundary (TS `_runAutoCompaction` takes it before the
    // run).
    {
        let guard = engine.session.blocking_lock();
        let core = guard.as_deref().expect("session built");
        assert!(!engine
            .runtime
            .block_on(async { core.turn_boundary.compaction_scheduled().await }));
    }
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::Done(Ok(())))),
        "the turn settles after the cancelled compaction"
    );
}

/// Below the headroom nothing fires: the threshold check stays silent
/// for turns whose usage fits the default 16k reserve (a 111k headroom
/// on the 128k window).
#[test]
fn threshold_below_the_headroom_stays_silent() {
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
            serde_json::json!({ "responses": [{"text": "plain reply"}] }).to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let mut events: Vec<EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "a small turn".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        &|| false,
        &mut |event| {
            events.push(event);
            true
        },
    );
    assert_eq!(assistant_texts(&events), vec!["plain reply".to_string()]);
    assert!(
        !events.iter().any(|event| matches!(
            event,
            EngineEvent::CompactionStart { .. } | EngineEvent::Compaction { .. }
        )),
        "no compaction events below the headroom"
    );
}

/// A prompt with images records the attachments as multimodal content
/// blocks after the text (TS prompt admission), even when the model
/// turn itself cannot run.
#[test]
fn prompt_images_ride_the_user_message_content() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = bare_engine(dir.path());
    let mut events: Vec<EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: vec![pa_agent::types::ImageContent {
                data: "QUJD".to_string(),
                mime_type: "image/png".to_string(),
            }],
            message: "look at this".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        &|| false,
        &mut |event| {
            events.push(event);
            true
        },
    );
    let user = events.iter().find_map(|event| match event {
        EngineEvent::UserMessage(message) => Some(message.clone()),
        _ => None,
    });
    let user = user.expect("user message emitted");
    assert_eq!(
        user["content"][0],
        json!({ "type": "text", "text": "look at this" })
    );
    assert_eq!(
        user["content"][1],
        json!({ "type": "image", "data": "QUJD", "mimeType": "image/png" })
    );
}

#[test]
fn settings_default_drives_unflagged_resolution() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
    let mut settings = pa_core::settings::SettingsManager::create(dir.path(), &agent_dir);
    settings
        .set_default_model_and_provider("battery".into(), "mock-1".into())
        .unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let model = engine.resolve_registry_model().expect("resolved model");
    assert_eq!(model.provider, "battery");
    assert_eq!(model.id, "mock-1");
}

/// A scripted loopback HTTP server (the pa-core tests/common pattern,
/// in-crate): answers from a queue of raw responses and records every
/// request head. Nothing leaves loopback.
struct MockCatalogServer {
    port: u16,
    requests: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl MockCatalogServer {
    async fn start(responses: Vec<Vec<u8>>) -> Self {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock catalog server");
        let port = listener.local_addr().unwrap().port();
        let requests: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let queue = std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::from(
            responses,
        )));
        let request_log = std::sync::Arc::clone(&requests);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let requests = std::sync::Arc::clone(&request_log);
                let queue = std::sync::Arc::clone(&queue);
                tokio::spawn(async move {
                    let mut buffer = [0u8; 8_192];
                    let mut read = 0usize;
                    loop {
                        let Ok(n) = socket.read(&mut buffer[read..]).await else {
                            return;
                        };
                        if n == 0 {
                            return;
                        }
                        read += n;
                        if buffer[..read].windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                        if read == buffer.len() {
                            break;
                        }
                    }
                    let head = String::from_utf8_lossy(&buffer[..read]).to_string();
                    requests.lock().unwrap().push(head);
                    let response = queue.lock().unwrap().pop_front().unwrap_or_else(|| {
                        b"HTTP/1.1 500 Drained\r\ncontent-length: 0\r\n\r\n".to_vec()
                    });
                    let _ = socket.write_all(&response).await;
                    let _ = socket.flush().await;
                });
            }
        });
        Self { port, requests }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.port, path)
    }

    fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

fn catalog_ok_json(body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// One auth.json with a Prime Inference key + team: the file auth the
/// engine's registry reads (the private-model lane's scope).
fn write_prime_auth(agent_dir: &std::path::Path) {
    std::fs::create_dir_all(agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("auth.json"),
        serde_json::json!({
            "prime-inference": {
                "type": "api_key",
                "key": "test-key",
                "primeTeam": { "teamId": "team-1", "name": "Test Team" }
            }
        })
        .to_string(),
    )
    .unwrap();
}

/// The Prime Inference `/models` payload: every compiled offline
/// entry (the coverage gate keeps thin fetches out) plus the private
/// `internal/glm-5.3-fast` the compiled fallback lacks.
fn pi_payload() -> String {
    let mut data: Vec<Value> = pa_models::transports::prime_inference_offline_entries()
        .iter()
        .map(|model| {
            serde_json::json!({
                "id": model.id,
                "display_name": model.name,
                "pricing": {
                    "input_usd_per_mtok": 1.0, "output_usd_per_mtok": 2.0
                },
                "specs": {
                    "context_window": model.context_window,
                    "max_output_tokens": model.max_tokens,
                    "supports_reasoning": model.reasoning,
                    "modalities": { "input": ["text"], "output": ["text"] },
                },
            })
        })
        .collect();
    data.push(serde_json::json!({
        "id": "internal/glm-5.3-fast",
        "display_name": "GLM 5.3 Fast (internal)",
        "pricing": { "input_usd_per_mtok": 0.42, "output_usd_per_mtok": 2.1 },
        "specs": {
            "context_window": 400_000, "max_output_tokens": 131_072,
            "supports_reasoning": true,
            "modalities": { "input": ["text"], "output": ["text"] },
        },
    }));
    serde_json::json!({ "data": data }).to_string()
}

/// Install a loopback catalog for `agent_dir` (both fetch layers point
/// at `server`; no bundled snapshot, so the compiled fallback is the
/// base and only the fetches add the private team model).
fn install_loopback_catalog(agent_dir: &std::path::Path, server: &MockCatalogServer) {
    let catalog = pa_models::ModelCatalog::with_urls(
        Some(agent_dir.join("models")),
        None,
        &server.url("/catalog"),
        &server.url("/api/v1"),
    );
    pa_core::models::install_catalog(&agent_dir.join("models.json"), std::sync::Arc::new(catalog));
}

/// A session file whose last `model_change` row pins the private team
/// model — what a revived worker reads at create.
fn session_file_pinning_private_model(dir: &std::path::Path) -> std::path::PathBuf {
    session_file_pinning_model(dir, "prime-inference", "internal/glm-5.3-fast")
}

/// A session file whose last `model_change` row pins the given model —
/// what a revived worker reads at create (and what a replacement
/// flow re-restores at its session boot).
fn session_file_pinning_model(
    dir: &std::path::Path,
    provider: &str,
    model: &str,
) -> std::path::PathBuf {
    let mut session =
        crate::session_store::SessionFile::create(dir.to_str().unwrap_or("/tmp"), None, 0);
    let path = dir.join(crate::session_store::session_file_name(
        session.session_id(),
    ));
    session.set_path(path.clone());
    session.append_model_change(provider, model);
    session.rewrite().unwrap();
    path
}

fn restore_test_engine(
    dir: &std::path::Path,
    provider: Option<&str>,
    model: Option<&str>,
) -> AgentSessionEngine {
    AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.to_path_buf(),
        agent_dir: dir.join("agent"),
        provider: provider.map(str::to_string),
        model: model.map(str::to_string),
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: Some(true),
        cron_store: None,
        queued_steering_probe: None,
    })
    .expect("engine")
}

/// The daemon model allowlist enforcement at the startup chain
/// (`resolve_registry_model`): a resolution outside settings
/// `allowedModels` fails loudly with the typed refusal — the chain
/// never lands a session on an off-list model (no silent fallback to
/// the featured default) — and an allowing allowlist keeps the
/// resolution.
#[test]
fn the_startup_chain_refuses_models_outside_the_allowlist() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
    std::fs::write(
        agent_dir.join("settings.json"),
        serde_json::json!({ "allowedModels": ["anthropic/*"] }).to_string(),
    )
    .unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: Some(true),
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let error = engine
        .resolve_registry_model()
        .expect_err("off-allowlist model refused");
    let refusal = error
        .downcast_ref::<pa_core::models::ModelAllowlistRefusal>()
        .expect("typed refusal");
    assert_eq!(refusal.selector, "battery/mock-1");
    assert!(
        error
            .to_string()
            .contains("blocked by the daemon model allowlist"),
        "{error}"
    );

    // An allowing allowlist opens the gate: the same engine resolves.
    std::fs::write(
        engine.config.agent_dir.join("settings.json"),
        serde_json::json!({ "allowedModels": ["battery/*"] }).to_string(),
    )
    .unwrap();
    let model = engine.resolve_registry_model().expect("resolved model");
    assert_eq!(model.provider, "battery");
    assert_eq!(model.id, "mock-1");
}

/// The create-config key override pins the KEY, never the headers: a
/// request target carrying an explicit `--model` key still ships the
/// registry's merged headers (the stored Prime team), so an override
/// never orphans the team (Macroscope PR #2755: `switch_model` dropped the
/// stored provider headers whenever an override was configured).
#[tokio::test]
async fn an_api_key_override_keeps_the_merged_team_headers() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_auth(&agent_dir);
    let engine = restore_test_engine(dir.path(), Some("prime-inference"), None);
    engine.configure_model(EngineModelSelection {
        provider: None,
        model: None,
        api_key: Some("explicit-override".to_string()),
        thinking: None,
    });
    let model = engine.resolve_registry_model().expect("resolved model");
    assert_eq!(model.provider, "prime-inference");
    let (api_key, headers) = engine.resolve_request_key_and_headers(&model);
    assert_eq!(api_key.as_deref(), Some("explicit-override"));
    let headers = headers.expect("the override keeps the merged headers");
    assert_eq!(
        headers.get("X-Prime-Team-ID").map(String::as_str),
        Some("team-1"),
        "an explicit key override never orphans the stored team"
    );
}

/// TS #2497: the auth storage is the single team-header owner. The
/// request auth a session's provider target carries resolves the
/// stored Prime team as `X-Prime-Team-ID` — with the provider-side
/// fallback deleted, these merged headers are what keeps the team on
/// the wire.
#[tokio::test]
async fn request_auth_carries_the_stored_team_header() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_auth(&agent_dir);
    let engine = restore_test_engine(dir.path(), Some("prime-inference"), None);
    let model = engine.resolve_registry_model().expect("resolved model");
    assert_eq!(model.provider, "prime-inference");
    let (api_key, headers) = engine.resolve_request_key_and_headers(&model);
    assert_eq!(api_key.as_deref(), Some("test-key"));
    let headers = headers.expect("merged request headers");
    assert_eq!(
        headers.get("X-Prime-Team-ID").map(String::as_str),
        Some("team-1"),
        "the stored team ships as the team header"
    );
}

/// The revival race this lane fixes (the 2026-09-23 05:57 fleet kill):
/// a revived session (scheduled wake / update restore / worker
/// relaunch — a create without model flags) resolves against the cold
/// registry and lands on the featured default while the daemon boot's
/// catalog fetch is still in flight. The create-time restore pins the
/// session's saved model after the readiness window instead.
#[tokio::test]
async fn revived_session_restores_its_pinned_model_not_the_startup_default() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_auth(&agent_dir);
    let pi = pi_payload();
    let layer_a = serde_json::json!({ "schemaVersion": 1, "models": [] }).to_string();
    let server = MockCatalogServer::start(vec![
        catalog_ok_json(&layer_a),
        catalog_ok_json(&pi),
        catalog_ok_json(&pi),
    ])
    .await;
    install_loopback_catalog(&agent_dir, &server);
    let path = session_file_pinning_private_model(dir.path());
    let engine = restore_test_engine(dir.path(), None, None);
    engine.set_session_file(path.clone());

    // The premise — the silent fallback the race produced: the cold
    // registry holds only the compiled entries, so the unflagged
    // startup chain picks the featured default (z-ai/glm-5.3), not the
    // model the session file pins. No fetch has run.
    let cold = engine.resolve_registry_model().expect("cold resolution");
    assert_eq!(cold.provider, "prime-inference");
    assert_eq!(cold.id, "z-ai/glm-5.3");
    assert_eq!(
        server.request_count(),
        0,
        "the cold resolution never fetches"
    );

    // The create-time restore: the readiness window covers the fetch,
    // the pinned model restores and every later unflagged resolution
    // runs on it.
    engine.restore_session_model(&path).await;
    let restored = engine
        .resolve_registry_model()
        .expect("restored resolution");
    assert_eq!(restored.provider, "prime-inference");
    assert_eq!(restored.id, "internal/glm-5.3-fast");
    assert!(
        engine.model_fallback_message().is_none(),
        "a successful restore leaves no fallback message"
    );
}

/// A restore that misses even after the readiness window falls back to
/// the startup chain — on the record (TS `modelFallbackMessage`), never
/// silent.
#[tokio::test]
async fn revived_session_fallback_is_on_the_record() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_auth(&agent_dir);
    // Every fetch fails instantly (the drained queue answers 500): the
    // restore misses fast, the startup chain owns the session.
    let server = MockCatalogServer::start(Vec::new()).await;
    install_loopback_catalog(&agent_dir, &server);
    let path = session_file_pinning_private_model(dir.path());
    let engine = restore_test_engine(dir.path(), None, None);
    engine.set_session_file(path.clone());

    engine.restore_session_model(&path).await;
    assert_eq!(
        engine.model_fallback_message().as_deref(),
        Some("Could not restore model prime-inference/internal/glm-5.3-fast. Using prime-inference/z-ai/glm-5.3"),
        "the fallback is published, never silent"
    );
    let resolved = engine.resolve_registry_model().expect("startup chain");
    assert_eq!(resolved.provider, "prime-inference");
    assert_eq!(resolved.id, "z-ai/glm-5.3");
}

/// Explicit create flags are authoritative (TS `options.model`): the
/// saved session model never overrides a flagged selection, and a
/// skipped restore records no fallback.
#[tokio::test]
async fn create_flags_beat_the_saved_session_model() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
    let path = session_file_pinning_private_model(dir.path());
    let engine = restore_test_engine(dir.path(), Some("battery"), Some("mock-1"));
    engine.set_session_file(path.clone());

    engine.restore_session_model(&path).await;
    let resolved = engine.resolve_registry_model().expect("flagged resolution");
    assert_eq!(resolved.provider, "battery");
    assert_eq!(resolved.id, "mock-1");
    assert!(engine.model_fallback_message().is_none());
}

/// A session with no saved model context (a fresh file) keeps the
/// startup chain — the restore is a no-op, nothing is recorded.
#[tokio::test]
async fn fresh_session_without_a_saved_model_keeps_the_startup_chain() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_auth(&agent_dir);
    let server = MockCatalogServer::start(Vec::new()).await;
    install_loopback_catalog(&agent_dir, &server);
    // A session file with no model rows at all.
    let mut session =
        crate::session_store::SessionFile::create(dir.path().to_str().unwrap_or("/tmp"), None, 0);
    let path = dir.path().join(crate::session_store::session_file_name(
        session.session_id(),
    ));
    session.set_path(path.clone());
    session.rewrite().unwrap();
    let engine = restore_test_engine(dir.path(), None, None);
    engine.set_session_file(path.clone());

    engine.restore_session_model(&path).await;
    assert!(engine.model_fallback_message().is_none());
    let resolved = engine.resolve_registry_model().expect("startup chain");
    assert_eq!(resolved.id, "z-ai/glm-5.3");
}

/// The restore decision is scoped to the file it was computed for: a
/// replacement flow that moves the worker onto another file without
/// recomputing keeps the startup chain — the previous session's pin
/// never silently overrides the moved-to session (TS re-restores at
/// every session boot).
#[tokio::test]
async fn a_restore_decision_is_scoped_to_its_session_file() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_auth(&agent_dir);
    let pi = pi_payload();
    let layer_a = serde_json::json!({ "schemaVersion": 1, "models": [] }).to_string();
    let server = MockCatalogServer::start(vec![
        catalog_ok_json(&layer_a),
        catalog_ok_json(&pi),
        catalog_ok_json(&pi),
    ])
    .await;
    install_loopback_catalog(&agent_dir, &server);
    let pinned = session_file_pinning_private_model(dir.path());
    let engine = restore_test_engine(dir.path(), None, None);
    engine.set_session_file(pinned.clone());
    engine.restore_session_model(&pinned).await;
    let restored = engine
        .resolve_registry_model()
        .expect("restored resolution");
    assert_eq!(restored.id, "internal/glm-5.3-fast");

    // The worker moves onto another file (a replacement flow that has
    // not recomputed yet): the decision for the old file no longer
    // applies — the startup chain owns the resolution again.
    let mut other =
        crate::session_store::SessionFile::create(dir.path().to_str().unwrap_or("/tmp"), None, 0);
    let other_path = dir
        .path()
        .join(crate::session_store::session_file_name(other.session_id()));
    other.set_path(other_path.clone());
    other.rewrite().unwrap();
    engine.set_session_file(other_path);
    let moved = engine.resolve_registry_model().expect("moved resolution");
    assert_eq!(moved.id, "z-ai/glm-5.3");
    assert!(
        engine.model_fallback_message().is_none(),
        "the old file's decision does not leak into the moved-to session"
    );
}

/// A mid-session `/model` switch belongs to the session it switched
/// (TS `switchSession` -> `createRuntime` rebuilds the runtime config
/// from the daemon default): a replacement onto another file drops
/// the switch and restores the moved-to file's own pin.
#[tokio::test]
async fn a_model_switch_never_leaks_into_the_replacement_session() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_auth(&agent_dir);
    write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
    let pi = pi_payload();
    let layer_a = serde_json::json!({ "schemaVersion": 1, "models": [] }).to_string();
    let server = MockCatalogServer::start(vec![
        catalog_ok_json(&layer_a),
        catalog_ok_json(&pi),
        catalog_ok_json(&pi),
    ])
    .await;
    install_loopback_catalog(&agent_dir, &server);

    // Session A pins the private model; the worker restores it.
    let file_a = session_file_pinning_private_model(dir.path());
    let engine = std::sync::Arc::new(restore_test_engine(dir.path(), None, None));
    engine.set_session_file(file_a.clone());
    engine.restore_session_model(&file_a).await;
    let restored = engine.resolve_registry_model().expect("restored");
    assert_eq!(restored.id, "internal/glm-5.3-fast");

    // A mid-session /model switch on session A (the worker runs the
    // engine's synchronous switch on the blocking pool, like the turn
    // path — a tokio context must not block on its locks).
    let switched_engine = std::sync::Arc::clone(&engine);
    let switched = tokio::task::spawn_blocking(move || {
        switched_engine.switch_model(EngineModelSelection {
            provider: Some("battery".to_string()),
            model: Some("mock-1".to_string()),
            api_key: None,
            thinking: None,
        })
    })
    .await
    .expect("blocking switch");
    assert!(switched);
    let switched = engine.resolve_registry_model().expect("switched");
    assert_eq!(switched.id, "mock-1");

    // The replacement (switch_session/fork/import) onto another file
    // that pins its own model: the switch does not leak — the
    // moved-to session restores its own pin.
    let file_b = session_file_pinning_private_model(dir.path());
    engine.set_session_file(file_b.clone());
    engine.restore_session_model(&file_b).await;
    let moved = engine.resolve_registry_model().expect("moved resolution");
    assert_eq!(
        moved.id, "internal/glm-5.3-fast",
        "the moved-to session's own file pin wins over the previous session's switch"
    );
    assert!(engine.model_fallback_message().is_none());
}

/// An unpersisted session (an in-memory fork, a no-session worker's
/// replacement) has no file to restore from: the runtime-config reset
/// must not run with nothing to restore — the live selection keeps
/// the model the session runs on (TS restores the in-memory branch's
/// own context).
#[tokio::test]
async fn an_unpersisted_session_keeps_its_live_selection() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");
    let engine = std::sync::Arc::new(restore_test_engine(dir.path(), None, None));
    engine.configure_create_model(EngineModelSelection {
        provider: Some("battery".to_string()),
        model: Some("mock-plain".to_string()),
        api_key: None,
        thinking: None,
    });
    // A mid-session /model switch on the live session (the worker
    // runs the engine's synchronous switch on the blocking pool).
    let switched_engine = std::sync::Arc::clone(&engine);
    let switched = tokio::task::spawn_blocking(move || {
        switched_engine.switch_model(EngineModelSelection {
            provider: Some("battery".to_string()),
            model: Some("mock-reason".to_string()),
            api_key: None,
            thinking: None,
        })
    })
    .await
    .expect("blocking switch");
    assert!(switched);

    // The in-memory fork's replacement restore: an empty path is a
    // no-op — the switch survives (never reset to the runtime config).
    engine.restore_session_model(std::path::Path::new("")).await;
    let resolved = engine.resolve_registry_model().expect("live selection");
    assert_eq!(
        (resolved.provider.as_str(), resolved.id.as_str()),
        ("battery", "mock-reason"),
        "the live selection survives an unpersisted replacement"
    );
}

/// A replacement re-reads the moved-to session's saved thinking level
/// (TS `createAgentSession`: `hasThinkingEntry ?
/// existingSession.thinkingLevel` when the runtime config carries no
/// explicit flag): the pinned level replaces the settings/medium
/// default and clamps against the restored model.
#[tokio::test]
async fn a_replacement_restores_the_moved_to_sessions_saved_thinking_level() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");
    let engine = restore_test_engine(dir.path(), None, None);

    // Session A pins the reasoning model at thinking `low`.
    let mut file_a =
        crate::session_store::SessionFile::create(dir.path().to_str().unwrap_or("/tmp"), None, 0);
    let path_a = dir
        .path()
        .join(crate::session_store::session_file_name(file_a.session_id()));
    file_a.set_path(path_a.clone());
    file_a.append_model_change("battery", "mock-reason");
    file_a.append_thinking_level_change("low");
    file_a.rewrite().unwrap();
    engine.set_session_file(path_a.clone());
    engine.restore_session_model(&path_a).await;
    assert_eq!(
        engine.effective_thinking_level().as_deref(),
        Some("low"),
        "the moved-to session's saved thinking level restores, not the medium default"
    );

    // Session B pins the non-reasoning model at thinking `high`: the
    // saved level restores and clamps against the restored model.
    let mut file_b =
        crate::session_store::SessionFile::create(dir.path().to_str().unwrap_or("/tmp"), None, 0);
    let path_b = dir
        .path()
        .join(crate::session_store::session_file_name(file_b.session_id()));
    file_b.set_path(path_b.clone());
    file_b.append_model_change("battery", "mock-plain");
    file_b.append_thinking_level_change("high");
    file_b.rewrite().unwrap();
    engine.set_session_file(path_b.clone());
    engine.restore_session_model(&path_b).await;
    assert_eq!(
        engine.effective_thinking_level().as_deref(),
        Some("off"),
        "the saved level re-clamps against the restored non-reasoning model"
    );
}

/// A compacted session restores the model its post-compaction
/// assistant message ran on (TS `buildSessionContext().model`: the
/// last `model_change` row before the compaction summary is
/// superseded; the surviving assistant message's provider/model is
/// the session's model context).
#[tokio::test]
async fn a_compacted_session_restores_its_post_compaction_model() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");
    let mut session =
        crate::session_store::SessionFile::create(dir.path().to_str().unwrap_or("/tmp"), None, 0);
    let path = dir.path().join(crate::session_store::session_file_name(
        session.session_id(),
    ));
    session.set_path(path.clone());
    session.append_model_change("battery", "mock-reason");
    let kept = session.append_message(serde_json::json!({
        "role": "assistant",
        "provider": "battery",
        "model": "mock-plain",
        "api": "openai-responses",
        "content": [],
        "stopReason": "stop",
        "timestamp": 0u64,
        "usage": {
            "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
            "cost": { "input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0 }
        }
    }));
    session.append_entry(
        "compaction",
        serde_json::json!({
            "summary": "summary",
            "firstKeptEntryId": kept,
            "tokensBefore": 100
        }),
    );
    session.rewrite().unwrap();

    let engine = restore_test_engine(dir.path(), None, None);
    engine.set_session_file(path.clone());
    engine.restore_session_model(&path).await;
    let restored = engine
        .resolve_registry_model()
        .expect("restored resolution");
    assert_eq!(
        (restored.provider.as_str(), restored.id.as_str()),
        ("battery", "mock-plain"),
        "the post-compaction assistant message pins the restored model, not the superseded model_change"
    );
    assert!(engine.model_fallback_message().is_none());
}

/// The create command's explicit flags survive every session
/// replacement (TS hands the merged `sessionConfig` down through
/// `switchSession`/`fork`/`import`): a later replacement honors the
/// create-time selection — never the previous session's `/model`
/// switch, and never the moved-to file's pin (a flagged selection
/// skips the restore entirely, so no fallback is recorded either).
#[tokio::test]
async fn create_flags_survive_a_session_replacement() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");
    // The worker started without an environment model; its create
    // command carries the explicit flag.
    let engine = std::sync::Arc::new(restore_test_engine(dir.path(), None, None));
    engine.configure_create_model(EngineModelSelection {
        provider: Some("battery".to_string()),
        model: Some("mock-plain".to_string()),
        api_key: None,
        thinking: None,
    });

    // A mid-session /model switch on the first session (the worker
    // runs the engine's synchronous switch on the blocking pool — a
    // tokio context must not block on its locks).
    let switched_engine = std::sync::Arc::clone(&engine);
    let switched = tokio::task::spawn_blocking(move || {
        switched_engine.switch_model(EngineModelSelection {
            provider: Some("battery".to_string()),
            model: Some("mock-reason".to_string()),
            api_key: None,
            thinking: None,
        })
    })
    .await
    .expect("blocking switch");
    assert!(switched);
    let switched = engine.resolve_registry_model().expect("switched");
    assert_eq!(switched.id, "mock-reason");

    // The replacement onto a file pinning its own model: the
    // runtime-config reset returns to the create's folded selection —
    // the switch died with the session it switched, and the file's
    // pin never even runs.
    let moved = session_file_pinning_model(dir.path(), "battery", "mock-reason");
    engine.set_session_file(moved.clone());
    engine.restore_session_model(&moved).await;
    let resolved = engine.resolve_registry_model().expect("flagged resolution");
    assert_eq!(
        (resolved.provider.as_str(), resolved.id.as_str()),
        ("battery", "mock-plain"),
        "the create command's flags survive the replacement"
    );
    assert!(
        engine.model_fallback_message().is_none(),
        "a flagged restore never records a fallback"
    );
}

/// The restore clamps the thinking level against the model the
/// session actually runs on (TS `createAgentSession` resolves the
/// model first, then `clampThinkingLevel`): a create-time `high`
/// request restores a non-reasoning pin and the session runs `off`,
/// and a later replacement onto a reasoning pin re-clamps back to
/// `high` — the previous session's clamp never leaks into the
/// moved-to one.
#[tokio::test]
async fn a_replacement_re_clamps_the_thinking_level_against_the_restored_model() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");
    let engine = restore_test_engine(dir.path(), None, None);
    // The create command requested `high`.
    engine.configure_create_model(EngineModelSelection {
        provider: None,
        model: None,
        api_key: None,
        thinking: Some(pa_types::ai::ModelThinkingLevel::High),
    });

    // The worker's first session pins the non-reasoning model: the
    // restore records the pin and the level clamps against it.
    let plain = session_file_pinning_model(dir.path(), "battery", "mock-plain");
    engine.set_session_file(plain.clone());
    engine.restore_session_model(&plain).await;
    assert_eq!(
        engine.effective_thinking_level().as_deref(),
        Some("off"),
        "the clamp follows the restored non-reasoning model, not the reset selection"
    );

    // The replacement onto a file pinning the reasoning model: the
    // moved-to session re-clamps against its own restored pin.
    let reason = session_file_pinning_model(dir.path(), "battery", "mock-reason");
    engine.set_session_file(reason.clone());
    engine.restore_session_model(&reason).await;
    assert_eq!(
        engine.effective_thinking_level().as_deref(),
        Some("high"),
        "the replacement re-clamps the requested level against its restored model"
    );
}

/// The engine's switch guard: `switch_model` refuses an off-allowlist
/// candidate BEFORE the selection mutates, so a refused cycle or switch
/// never poisons the live selection (every later resolution would fail
/// at the same gate) — the session keeps resolving its current model.
#[test]
fn switch_model_never_poisons_the_selection_with_a_refused_candidate() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
    std::fs::write(
        agent_dir.join("settings.json"),
        serde_json::json!({ "allowedModels": ["battery/mock-1"] }).to_string(),
    )
    .unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: Some(true),
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let model = engine.resolve_registry_model().expect("resolved model");
    assert_eq!(model.id, "mock-1");
    // The switched-to model does not match the allowlist: the switch is
    // refused and the selection keeps the resolvable model.
    let switched = engine.switch_model(EngineModelSelection {
        provider: Some("battery".to_string()),
        model: Some("mock-2".to_string()),
        api_key: None,
        thinking: None,
    });
    assert!(!switched, "off-allowlist switch refused");
    let model = engine.resolve_registry_model().expect("still resolvable");
    assert_eq!(model.id, "mock-1");
    // The allowed model still switches through.
    let switched = engine.switch_model(EngineModelSelection {
        provider: Some("battery".to_string()),
        model: Some("mock-1".to_string()),
        api_key: None,
        thinking: None,
    });
    assert!(switched, "allowed switch proceeds");
    let model = engine.resolve_registry_model().expect("resolved model");
    assert_eq!(model.id, "mock-1");
}

/// A live model switch propagates to the children registry's parent
/// identity: an inherited `rlm.spawn` resolves the model the session
/// NOW runs. The build-time stamp alone would go stale after a
/// switch, so the allowlist gate would refuse a stale selector the
/// parent no longer runs once the allowlist drops it.
#[test]
fn switch_model_propagates_the_new_model_to_the_child_identity() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: Some(SupervisorLinkConfig {
            socket_path: dir.path().join("absent-supervisor.sock"),
            active_session_id: "parent-live".to_string(),
            worker_token: "test-token".to_string(),
        }),
        telemetry_disabled: Some(true),
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let children = engine
        .children
        .as_ref()
        .expect("the supervisor link wires the children registry")
        .clone();
    // The pre-switch identity (the build-time stamp's shape): an
    // older selector.
    children.set_model("battery/mock-2".to_string());
    let switched = engine.switch_model(EngineModelSelection {
        provider: Some("battery".to_string()),
        model: Some("mock-1".to_string()),
        api_key: None,
        thinking: None,
    });
    assert!(switched, "the switch proceeds without an allowlist");
    assert_eq!(
        children.parent_model().as_deref(),
        Some("battery/mock-1"),
        "an inherited spawn must resolve the switched-to model, not the stale build-time selector"
    );
}

#[test]
fn configure_model_merges_only_present_fields() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        provider: Some("battery".to_string()),
        model: Some("mock-1".to_string()),
        api_key: Some("flag-key".to_string()),
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    // A create config with only a model keeps the provider and key.
    engine.configure_model(EngineModelSelection {
        provider: None,
        model: Some("mock-1".to_string()),
        api_key: None,
        thinking: None,
    });
    let model = engine.resolve_registry_model().expect("resolved model");
    assert_eq!(model.provider, "battery");
    assert_eq!(
        engine.resolve_request_api_key(&model).as_deref(),
        Some("flag-key")
    );
}

#[test]
fn agent_engine_reports_model_resolution_failures() {
    let dir = tempfile::TempDir::new().unwrap();
    // One auth-configured model keeps the available list non-empty in
    // every environment (a clean env with no credentials resolves to
    // "No models available" before the flagged-provider error, while a
    // machine with ambient env credentials reaches this test's branch).
    std::fs::create_dir_all(dir.path().join("agent")).unwrap();
    std::fs::write(
        dir.path().join("agent").join("models.json"),
        serde_json::json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9",
                    "apiKey": "sk-battery",
                    "models": [
                        { "id": "mock-1", "contextWindow": 128_000, "maxTokens": 4096 }
                    ]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: Some("no-such-provider".to_string()),
        model: Some("some-model".to_string()),
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let mut events: Vec<EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "hi".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        &|| false,
        &mut |event| {
            events.push(event);
            true
        },
    );
    // The engine degrades to a Done error with the resolver message.
    assert_eq!(events.len(), 2);
    assert!(matches!(&events[0], EngineEvent::UserMessage(_)));
    let EngineEvent::Done(Err(error)) = &events[1] else {
        panic!("expected error done");
    };
    assert!(error.contains("Unknown provider"));
}

/// A reasoning models.json model (no thinkingLevelMap): supported
/// levels are off..high, so a requested max clamps to high.
#[test]
fn configure_model_thinking_clamps_to_the_models_supported_levels() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9",
                    "apiKey": "sk-battery",
                    "models": [
                        {
                            "id": "mock-1",
                            "reasoning": true,
                            "contextWindow": 128_000,
                            "maxTokens": 4096
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        provider: Some("battery".to_string()),
        model: Some("mock-1".to_string()),
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    // Without an explicit flag the TS default applies (medium, clamped).
    assert_eq!(engine.effective_thinking_level().as_deref(), Some("medium"));
    // The create-config flag is authoritative, clamped to model support.
    engine.configure_model(EngineModelSelection {
        provider: None,
        model: None,
        api_key: None,
        thinking: Some(pa_types::ai::ModelThinkingLevel::Max),
    });
    assert_eq!(engine.effective_thinking_level().as_deref(), Some("high"));
    engine.configure_model(EngineModelSelection {
        provider: None,
        model: None,
        api_key: None,
        thinking: Some(pa_types::ai::ModelThinkingLevel::Low),
    });
    assert_eq!(engine.effective_thinking_level().as_deref(), Some("low"));
}

/// The eager turn abort (TS `requestAbort`'s closing `this.agent.abort()`):
/// an abort that lands while the provider response is pending — the
/// compaction flow's interrupt-and-settle wait, the `abort` command, kill,
/// shutdown — cancels the in-flight fetch immediately instead of at the
/// next streamed event. The turn settles on its aborted message with
/// `EMPTY_USAGE` (TS `createAbortedAssistantMessage` with no partial), so the
/// aborted turn's usage never reaches the goal accounting.
#[test]
fn abort_in_flight_turn_cancels_a_mid_provider_wait() {
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
                "responses": [{ "text": "held reply", "delayMs": 60000 }],
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
    let events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> = Arc::default();
    let turn_engine = std::sync::Arc::clone(&engine);
    let turn_events = std::sync::Arc::clone(&events);
    let turn = std::thread::spawn(move || {
        turn_engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message: "hello".to_string(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                turn_events.lock().unwrap().push(event);
                true
            },
        );
    });
    // Wait until the turn is live (the agent run started) so the abort
    // lands mid-provider-wait, the window TS's requestAbort owns.
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
            "the turn never started streaming"
        );
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    let started = std::time::Instant::now();
    engine.abort_in_flight_turn();
    // The fetch cancels now (TS aborts the fetch, not the next event): the
    // turn settles far inside the 60s hold.
    let (settled_tx, settled_rx) = std::sync::mpsc::channel::<()>();
    let waiter = std::thread::spawn(move || {
        turn.join().unwrap();
        let _ = settled_tx.send(());
    });
    settled_rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the aborted turn settles immediately, not after the 60s hold");
    waiter.join().unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    // The aborted turn settles on the aborted message with EMPTY usage —
    // the accounting input the goal accounting's aborted guard sees, so
    // the aborted turn's usage is not counted (TS parity).
    let events = events.lock().unwrap();
    let assistant = events
        .iter()
        .rev()
        .find_map(|event| match event {
            EngineEvent::AssistantMessage(message) => Some(message.clone()),
            _ => None,
        })
        .expect("an assistant message settled");
    assert_eq!(assistant["stopReason"], json!("aborted"));
    assert_eq!(assistant["errorMessage"], json!("Request was aborted"));
    assert_eq!(assistant["usage"]["totalTokens"], json!(0));
    assert_eq!(assistant["usage"]["input"], json!(0));
    assert_eq!(assistant["usage"]["output"], json!(0));
    // The terminal `turn_end` frame follows the aborted row's message
    // pair (TS `turn_end` on an aborted turn): the aborted assistant
    // message is the payload, the tool-result list is empty, and the
    // frame precedes the trailing `DoneAborted` settle.
    let turn_end_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::TurnEnd { message, .. }
                if message["stopReason"] == json!("aborted"))
        })
        .expect("the aborted turn's turn_end event");
    let EngineEvent::TurnEnd {
        message,
        tool_results,
    } = &events[turn_end_index]
    else {
        unreachable!();
    };
    assert_eq!(message, &assistant, "the aborted row is the payload");
    assert!(tool_results.is_empty(), "the aborted turn ran no tools");
    // The run's terminal settle is the structural aborted one
    // (`DoneAborted`, the #2617 typed-settles rework): TS classifies the
    // aborted settle structurally — an abort is not a failure, so the
    // retry backoff never applies and the wire keeps its own
    // `turn_end`/`agent_end` frames — not the generic `Done` variant this
    // pin predates.
    let done_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::DoneAborted))
        .expect("the run's trailing DoneAborted settle");
    assert!(turn_end_index < done_index, "turn_end precedes the settle");
    // The aborted run still ends with its `agent_end` (TS emits it on the
    // abort paths): the payload carries the run's whole message set with
    // the aborted row as the terminal message.
    let agent_end_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::AgentEnd { .. }))
        .expect("the aborted run's agent_end event");
    assert!(
        turn_end_index < agent_end_index && agent_end_index < done_index,
        "agent_end sits between the turn_end and the DoneAborted settle: {events:?}"
    );
    let EngineEvent::AgentEnd { messages } = &events[agent_end_index] else {
        unreachable!();
    };
    assert!(
        messages
            .iter()
            .any(|message| message["stopReason"] == json!("aborted")),
        "the aborted row rides the agent_end payload: {messages:?}"
    );
}

/// The settled turn's terminal frame (TS `turn_end`): the loop's boundary
/// event carries the final assistant message as its payload with the
/// turn's (empty) tool-result list, positioned between the final
/// `AssistantMessage` and the trailing `Done` — the worker frames it as
/// the wire `turn_end` with the TS shape.
#[test]
fn settled_turn_emits_the_terminal_turn_end_payload() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, _engine_dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "settled reply"}] }),
        1,
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "plain turn".to_string(), &mut events);
    let assistant_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::AssistantMessage(message) if message["content"] == json!([{ "type": "text", "text": "settled reply" }]))
        })
        .expect("the settled assistant message");
    let turn_end_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::TurnEnd { .. }))
        .expect("the settled turn's turn_end event");
    let done_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::Done(_)))
        .expect("the trailing Done");
    assert!(
        assistant_index < turn_end_index && turn_end_index < done_index,
        "turn_end sits between the final message and the Done: {events:?}"
    );
    let EngineEvent::TurnEnd {
        message,
        tool_results,
    } = &events[turn_end_index]
    else {
        unreachable!();
    };
    let EngineEvent::AssistantMessage(assistant) = &events[assistant_index] else {
        unreachable!();
    };
    assert_eq!(message, assistant, "the terminal message is the payload");
    assert!(tool_results.is_empty(), "the text-only turn ran no tools");
}

/// The run's terminal frame (TS `agent_end`): the loop's run-end event
/// carries the run's whole message set — the accepted user row and the
/// settled assistant row, in the session wire shapes — positioned after
/// the terminal `turn_end` and before the trailing `Done`. The worker
/// frames it as the wire `agent_end` with the TS `messages` payload; the
/// run-opening `agent_start` stays with the worker's own opening frames,
/// so the engine forwards none for the item's first run.
#[test]
fn settled_turn_emits_the_run_agent_end_payload() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, _engine_dir) = faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "settled reply"}] }),
        1,
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "plain turn".to_string(), &mut events);
    let turn_end_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::TurnEnd { .. }))
        .expect("the settled turn's turn_end event");
    let agent_end_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::AgentEnd { .. }))
        .expect("the run's agent_end event");
    let done_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::Done(_)))
        .expect("the trailing Done");
    assert!(
        turn_end_index < agent_end_index && agent_end_index < done_index,
        "agent_end sits between the turn_end and the Done: {events:?}"
    );
    let EngineEvent::AgentEnd { messages } = &events[agent_end_index] else {
        unreachable!();
    };
    let roles = messages
        .iter()
        .map(|message| message["role"].as_str().unwrap_or_default())
        .collect::<Vec<&str>>();
    assert_eq!(
        roles,
        ["custom", "user", "assistant"],
        "the run's message set (the deferred harness digest rides first)"
    );
    assert_eq!(
        messages[0]["customType"],
        json!("harness_digest"),
        "the deferred digest row is the run's first message"
    );
    assert_eq!(
        messages[1]["content"],
        json!([{ "type": "text", "text": "plain turn" }]),
        "the accepted user row rides the payload"
    );
    assert_eq!(
        messages[2]["content"],
        json!([{ "type": "text", "text": "settled reply" }]),
        "the settled assistant row rides the payload"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::AgentStart)),
        "the first run's agent_start stays with the worker's opening frames: {events:?}"
    );
}

/// One `agent_end` per agent run (TS emits per run, so a retried run
/// restarts with its own frames): a retryable provider failure ends the
/// first run with its whole message set — the user row and the failed
/// assistant row — then the retry re-issues as a new run whose `agent_end`
/// carries only the retry's messages (the failed row left the loop
/// context first, TS `messages.slice(0, -1)`). The retry run's opening
/// `agent_start` and `turn_start` forward — a boundary frame (the first
/// run's `agent_end`) already passed in the item.
#[test]
fn retried_run_restarts_with_its_own_agent_frames() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::create_dir_all(dir.path().join("agent")).unwrap();
    std::fs::write(
        dir.path().join("agent").join("settings.json"),
        serde_json::json!({
            "compaction": { "enabled": true, "reserveTokens": 1, "keepRecentTokens": 10 },
            "retry": { "enabled": true, "maxRetries": 1, "baseDelayMs": 10 }
        })
        .to_string(),
    )
    .unwrap();
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
            serde_json::json!({
                "responses": [
                    { "stopReason": "error", "errorMessage": "faux provider overloaded" },
                    { "text": "recovered reply" },
                ]
            })
            .to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let mut events: Vec<EngineEvent> = Vec::new();
    admit(&engine, "retried turn".to_string(), &mut events);
    let agent_end_indexes = events
        .iter()
        .enumerate()
        .filter(|(_, event)| matches!(event, EngineEvent::AgentEnd { .. }))
        .map(|(index, _)| index)
        .collect::<Vec<usize>>();
    assert_eq!(
        agent_end_indexes.len(),
        2,
        "one agent_end per run: {events:?}"
    );
    let EngineEvent::AgentEnd { messages: first } = &events[agent_end_indexes[0]] else {
        unreachable!();
    };
    let roles = first
        .iter()
        .map(|message| message["role"].as_str().unwrap_or_default())
        .collect::<Vec<&str>>();
    assert_eq!(
        roles,
        ["custom", "user", "assistant"],
        "the failed run's message set (the digest row rides first)"
    );
    assert_eq!(
        first[2]["stopReason"],
        json!("error"),
        "the failed run ends on the error row"
    );
    let EngineEvent::AgentEnd { messages: second } = &events[agent_end_indexes[1]] else {
        unreachable!();
    };
    let roles = second
        .iter()
        .map(|message| message["role"].as_str().unwrap_or_default())
        .collect::<Vec<&str>>();
    assert_eq!(
        roles,
        ["assistant"],
        "the retried run carries only its own messages: {events:?}"
    );
    assert_eq!(
        second[0]["content"],
        json!([{ "type": "text", "text": "recovered reply" }]),
        "the retried run's settled row"
    );
    // The retry run restarted with its own opening frames: the forwarded
    // `agent_start` and `turn_start` both follow the first run's
    // `agent_end`.
    let agent_start_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::AgentStart))
        .expect("the retry run's agent_start forwarded");
    assert!(
        agent_start_index > agent_end_indexes[0],
        "the retry run's agent_start follows the failed run's agent_end: {events:?}"
    );
    let retry_turn_start_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::TurnStart))
        .expect("the retry run's turn_start forwarded");
    assert!(
        agent_start_index < retry_turn_start_index && retry_turn_start_index < agent_end_indexes[1],
        "the retry run's turn_start sits between its agent_start and agent_end: {events:?}"
    );
    // The retry itself surfaced on the events between the two runs.
    let auto_retry_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::AutoRetryStart { .. }))
        .expect("the retry start event");
    assert!(
        agent_end_indexes[0] < auto_retry_index && auto_retry_index < agent_start_index,
        "the retry start sits between the two runs: {events:?}"
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

/// Scoped process-env overrides for the live-kernel tests: applied on
/// construction, restored on drop. The live-kernel tests are serialized by
/// the faux lock, so nothing races.
#[cfg(test)]
struct KernelEnvOverride {
    saved: Vec<(String, Option<String>)>,
}

#[cfg(test)]
impl KernelEnvOverride {
    fn apply(pairs: Vec<(&str, Option<String>)>) -> Self {
        let saved = pairs
            .iter()
            .map(|(key, _)| ((*key).to_string(), std::env::var(key).ok()))
            .collect();
        for (key, value) in &pairs {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        KernelEnvOverride { saved }
    }
}

#[cfg(test)]
impl Drop for KernelEnvOverride {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

/// The kernel python for the live-kernel abort test (skipped without a live
/// install).
#[cfg(test)]
fn live_kernel_python() -> Option<std::path::PathBuf> {
    let candidate = std::path::PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
        |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
    ));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!("kernel python {candidate:?} not found; skipping live kernel test");
    None
}

#[cfg(test)]
fn live_release_dir() -> Option<std::path::PathBuf> {
    let releases = std::path::PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.local/share/prime-agent/releases".to_string(),
        |home| format!("{home}/.local/share/prime-agent/releases"),
    ));
    let Ok(entries) = std::fs::read_dir(&releases) else {
        eprintln!("no releases dir at {releases:?}; skipping live kernel test");
        return None;
    };
    let mut candidates: Vec<std::path::PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.join("prime-agent-runtime").is_dir())
        .collect();
    candidates.sort();
    candidates.pop()
}

/// The abort wedge repro (dogfood P0): a turn executing a long kernel cell
/// must unwind at `abort_in_flight_turn` (the kernel interrupt +
/// force-abort path settles the tool race) - not keep the turn alive while
/// the cell runs out. Red: the run thread wedged past the cell's sleep
/// (the daemon worker's `run_turn_once` awaits the admission forever).
#[test]
fn abort_in_flight_turn_cancels_a_running_kernel_cell() {
    let Some(kernel_python) = live_kernel_python() else {
        return;
    };
    let Some(release) = live_release_dir() else {
        return;
    };
    let _env = KernelEnvOverride::apply(vec![
        (
            "PRIME_AGENT_KERNEL_PYTHON",
            Some(kernel_python.display().to_string()),
        ),
        ("PI_PACKAGE_DIR", Some(release.display().to_string())),
        ("PRIME_AGENT_CODING_AGENT_DIR", None),
        ("PRIME_API_KEY", None),
    ]);
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
                "modelId": "faux-1",
                "modelName": "Faux",
                "reasoning": false,
                "contextWindow": 128_000,
                "tokensPerSecond": 30,
                "responses": [
                    {"content": [
                        {"type": "text", "text": "Running the wedge cell."},
                        {"type": "toolCall", "name": "ipython", "id": "toolu_wedge01",
                         "arguments": {"code":
                            "import time\nopen('wedge-started', 'w').write('1')\ntime.sleep(300)\nopen('wedge-finished', 'w').write('1')\nprint('cell completed')"}}
                    ]},
                    {"content": [{"type": "text", "text": "The cell completed."}]}
                ]
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
    engine.register_arc();
    let marker = dir.path().join("wedge-started");
    let finished = dir.path().join("wedge-finished");
    let events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let runner = {
        let engine = std::sync::Arc::clone(&engine);
        let events = std::sync::Arc::clone(&events);
        std::thread::spawn(move || {
            let events = events;
            engine.run_prompt(
                0,
                PromptRequest {
                    batch: Vec::new(),
                    images: Vec::new(),
                    message: "run the wedge cell".to_string(),
                    source: "user".to_string(),
                    agent_message_id: None,
                    custom_message: None,
                },
                &|| false,
                &mut move |event: EngineEvent| {
                    events.lock().unwrap().push(event);
                    true
                },
            );
        })
    };
    // The cell started (bounded by the kernel boot).
    let deadline = std::time::Instant::now() + std::time::Duration::from_mins(3);
    while !marker.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if !marker.exists() {
        let events = events.lock().unwrap();
        let wire: Vec<String> = events.iter().map(|event| format!("{event:?}")).collect();
        panic!("the wedge cell never started; events: {wire:?}");
    }
    // Abort strictly mid-cell; the run must settle within the budget.
    engine.abort_in_flight_turn();
    let settled = runner.join();
    match settled {
        Ok(()) => {}
        Err(payload) => std::panic::resume_unwind(payload),
    }
    // The cell died: the finish marker never appears.
    std::thread::sleep(std::time::Duration::from_secs(3));
    assert!(
        !finished.exists(),
        "the interrupted cell must not run to completion"
    );
}

/// A driver loop test harness: faux script + collected events. Holds the
/// faux lock while the engine runs.
#[cfg(test)]
fn run_prompts(
    script: serde_json::Value,
    prompts: &[&str],
) -> (std::sync::Arc<AgentSessionEngine>, Vec<EngineEvent>) {
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
        faux_script: Some(script.to_string()),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let engine = std::sync::Arc::new(engine);
    // The in-run continuation hook upgrades the engine's registered arc.
    engine.register_arc();
    let mut events: Vec<EngineEvent> = Vec::new();
    for prompt in prompts {
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message: prompt.to_string(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                events.push(event);
                true
            },
        );
    }
    (engine, events)
}

/// `get_commands` enumerates the session's skills as `skill:<name>`
/// commands (TS `createAgentConnectionCommands`) — including before the
/// first prompt: the read seam demand-builds the core session (the TS
/// session exists from create), so the client's slash menu sees the
/// skill inventory right after attach. The faux provider registers under
/// `FAUX_TEST_LOCK` on a blocking thread (the lock is std, so it never
/// rides an await); the first model resolution there is the registration,
/// and the demand-build's resolution reads the cached model.
#[tokio::test]
async fn get_commands_enumerates_skills_before_the_first_prompt() {
    use crate::engine::SessionEngine as _;
    let (engine, _dir) = tokio::task::spawn_blocking(|| {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        let skill_dir = agent_dir.join("skills").join("demo-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo-skill\ndescription: Demo the slash menu wiring\n---\nRun the demo.",
        )
        .unwrap();
        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir,
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: Some(
                json!({ "engine": "faux", "responses": [{ "text": "ok" }] }).to_string(),
            ),
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap();
        let engine = std::sync::Arc::new(engine);
        engine.register_arc();
        // Register the faux provider under the lock (this resolution is
        // the registration); the async section then resolves the cached
        // model without re-registering.
        let model = engine.resolve_model().expect("faux model");
        drop(model);
        (engine, dir)
    })
    .await
    .expect("engine build join");
    // No prompt ran: the read seam must build the session itself.
    assert!(engine.session.lock().await.is_none());
    let commands = engine.connection_commands().await;
    assert!(
        engine.session.lock().await.is_some(),
        "the read built the session"
    );
    let skill_commands: Vec<&serde_json::Value> = commands
        .iter()
        .filter(|command| command.get("source").and_then(Value::as_str) == Some("skill"))
        .collect();
    // The checkout's own bundled skills (the packaged `skills/` layout)
    // enumerate too, so the assertion is on the test's own skill, not the
    // count.
    let command = skill_commands
        .iter()
        .find(|command| command.get("name").and_then(Value::as_str) == Some("skill:demo-skill"))
        .unwrap_or_else(|| panic!("the demo skill enumerated: {commands:?}"));
    assert_eq!(
        command.get("description").and_then(Value::as_str),
        Some("Demo the slash menu wiring")
    );
    assert_eq!(
        command
            .get("sourceInfo")
            .and_then(|info| info.get("scope"))
            .and_then(Value::as_str),
        Some("user")
    );
    // Every skill command carries the `skill:` name form and its source
    // info (the menu row's source label reads them).
    for command in &skill_commands {
        assert!(command
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| name.starts_with("skill:")));
        assert!(command.get("sourceInfo").is_some());
    }
}

/// The TS replacement teardown (`teardownForReplacement` -> `teardownCurrent`
/// -> `session.disposeAsync()`): retiring the built session drops it (the
/// session's kernel disposes with it), and the replacement branch parked
/// while the session was unbuilt is adopted by the async build funnel -
/// the read-seam build, not just the turn-driven one, must consume the
/// parked branch, or a read seam that rebuilt first would strand the
/// replacement's context.
#[tokio::test]
async fn replacement_teardown_retires_the_session_and_the_funnel_adopts_the_branch() {
    let engine = {
        let (engine, _events) = tokio::task::spawn_blocking(|| {
            run_prompts(
                json!({ "engine": "faux", "responses": [{ "text": "first" }] }),
                &["hello"],
            )
        })
        .await
        .expect("prompt join");
        engine
    };
    // The prompt built the session.
    assert!(engine.session.lock().await.is_some());

    // Retire: the built session drops with its mirrored goal handles (the
    // kernel dispose runs under the build gate; the harness session has
    // no live kernel).
    engine.retire_session_runtime().await;
    assert!(engine.session.lock().await.is_none());
    assert!(engine
        .goal_runtime
        .lock()
        .expect("goal runtime lock")
        .is_none());

    // The replacement tail parks the moved branch on the unbuilt engine
    // (the worker parks it on a blocking thread; so does the test).
    let mut store = crate::session_store::SessionFile::create("/tmp", None, 0);
    store.append_message(json!({
        "role": "user",
        "content": "moved branch marker",
        "timestamp": 1u64,
    }));
    let branch = store.branch_file_entries();
    {
        let engine = std::sync::Arc::clone(&engine);
        tokio::task::spawn_blocking(move || {
            use crate::engine::SessionEngine as _;
            engine.rebuild_session_context(
                branch,
                pa_core::session_engine::goal_driver::GoalBranchReload::FaithfulBranch,
            )
        })
        .await
        .expect("park join")
        .expect("park branch");
    }
    assert!(engine
        .pending_branch
        .lock()
        .expect("pending branch lock")
        .is_some());

    // The async funnel's build adopts the parked branch: the fresh
    // session starts on the moved branch, not the retired session's
    // context.
    let model = engine.resolve_model().expect("model");
    engine
        .ensure_core_session_async(&model)
        .await
        .expect("rebuild");
    assert!(engine
        .pending_branch
        .lock()
        .expect("pending branch lock")
        .is_none());
    let session = engine.session.lock().await;
    let built = session.as_deref().expect("rebuilt session");
    let state = built.session.agent().state().await;
    let texts: Vec<String> = state
        .messages
        .iter()
        .filter_map(|message| match message {
            pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::User(user)) => {
                match &user.content {
                    pa_agent::types::UserContent::Text(text) => Some(text.clone()),
                    pa_agent::types::UserContent::Parts(_) => None,
                }
            }
            _ => None,
        })
        .collect();
    assert!(
        texts
            .iter()
            .any(|text| text.contains("moved branch marker")),
        "the rebuilt session did not adopt the parked branch: {texts:?}"
    );
    drop(texts);
    drop(state);
    drop(session);
    // The engine owns a private runtime; dropping it from an async
    // context panics, so the teardown rides a blocking thread.
    tokio::task::spawn_blocking(move || drop(engine))
        .await
        .expect("engine drop join");
}

/// A live branch rebuild reloads the goal state from the moved branch (TS
/// `_reloadGoalStateFromBranch` at the `_navigateTree` tail): a branch
/// that predates the goal rows leaves the driver on the branch's own
/// (empty) state, moving back onto the branch that owns the rows
/// restores them, and each reload's change publishes as the
/// `goal_update` payload exactly once (the on-change dedupe the turn
/// emissions share).
#[tokio::test]
async fn live_branch_rebuild_reloads_the_goal_state_from_the_moved_branch() {
    let engine = {
        let (engine, _events) = tokio::task::spawn_blocking(|| {
            run_prompts(
                json!({
                    "engine": "faux",
                    "responses": (0..4).map(|index| json!({ "text": format!("reply {index}") })).collect::<Vec<_>>(),
                }),
                &["hello", "/goal ship it", "/goal pause"],
            )
        })
        .await
        .expect("prompt join");
        std::sync::Arc::new(engine)
    };
    // The prompt built the session and the goal commands left the paused
    // goal's `thread_goal_state` rows on the live branch.
    assert!(engine.session.lock().await.is_some());
    let goal_before = engine.goal_state_value();
    assert_eq!(goal_before["status"], "paused", "state: {goal_before:?}");
    assert_eq!(goal_before["objective"], "ship it");
    let goal_id = goal_before["goalId"].as_str().expect("goal id").to_string();

    // The live branch (the entries the driver's rows live on), captured
    // for the move back. The engine owns a private runtime, so every
    // engine call (the block_on the capture needs) rides a blocking
    // thread.
    let goal_branch = {
        let engine = std::sync::Arc::clone(&engine);
        tokio::task::spawn_blocking(move || {
            let handles = engine
                .goal_runtime
                .lock()
                .expect("goal runtime lock")
                .clone()
                .expect("goal handles");
            let entries = engine
                .runtime
                .block_on(async { handles.session.lock().await })
                .get_all_entries()
                .to_vec();
            // The moved branch is the post-header path (the store form the
            // worker hands the engine carries no header row).
            entries
                .iter()
                .filter(|entry| !matches!(entry, pa_types::session::FileEntry::Header { .. }))
                .cloned()
                .collect::<Vec<_>>()
        })
        .await
        .expect("branch capture join")
    };

    // A pre-goal branch: no `thread_goal_state` entry anywhere.
    let mut store = crate::session_store::SessionFile::create("/tmp", None, 0);
    store.append_message(json!({
        "role": "user",
        "content": "moved branch marker",
        "timestamp": 1u64,
    }));
    let branch = store.branch_file_entries();
    {
        let engine = std::sync::Arc::clone(&engine);
        tokio::task::spawn_blocking(move || {
            use crate::engine::SessionEngine as _;
            engine.rebuild_session_context(
                branch,
                pa_core::session_engine::goal_driver::GoalBranchReload::FaithfulBranch,
            )
        })
        .await
        .expect("rebuild join")
        .expect("live branch rebuild");
    }
    let reloaded = engine.goal_state_value();
    assert_eq!(reloaded["status"], "idle", "state: {reloaded:?}");
    // The reload publishes its change once, then stays silent (TS
    // `_emitGoalUpdate` at the reload; the dedupe keeps an unchanged
    // state quiet).
    let update = engine
        .goal_update_after_rebuild()
        .expect("the reload announced the change");
    assert_eq!(update["status"], "idle");
    assert!(engine.goal_update_after_rebuild().is_none());

    // Moving back onto the branch that owns the goal rows restores them
    // (the same-goal id and objective, the durable counters).
    {
        let engine = std::sync::Arc::clone(&engine);
        tokio::task::spawn_blocking(move || {
            use crate::engine::SessionEngine as _;
            engine.rebuild_session_context(
                goal_branch,
                pa_core::session_engine::goal_driver::GoalBranchReload::FaithfulBranch,
            )
        })
        .await
        .expect("rebuild join")
        .expect("live branch rebuild");
    }
    let restored = engine.goal_state_value();
    assert_eq!(restored["status"], "paused", "state: {restored:?}");
    assert_eq!(restored["objective"], "ship it");
    assert_eq!(restored["goalId"].as_str(), Some(goal_id.as_str()));

    // The engine owns a private runtime; dropping it from an async
    // context panics, so the teardown rides a blocking thread.
    tokio::task::spawn_blocking(move || drop(engine))
        .await
        .expect("engine drop join");
}

/// The user rows emitted by one run (message texts in order).
#[cfg(test)]
fn user_texts(events: &[EngineEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::UserMessage(value) => Some(
                value["content"][0]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            ),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
fn assistant_texts(events: &[EngineEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::AssistantMessage(value) => Some(
                value["content"][0]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            ),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
fn custom_rows(events: &[EngineEvent]) -> Vec<serde_json::Value> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::CustomMessage(value) => Some(value.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn assistant_updates_stream_live_while_the_turn_runs() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    // A paced script: 40 short words at 100 tokens/second streams for
    // roughly 0.4s wall time. If the engine buffered events until the turn
    // settled, every update would share one emit timestamp; live
    // forwarding spreads them across the stream.
    let words = (0..40).fold(String::new(), |mut words, i| {
        use std::fmt::Write;
        write!(words, "w{i} ").expect("write to String");
        words
    });
    let script = serde_json::json!({
        "engine": "faux",
        "tokensPerSecond": 100.0,
        "responses": [
            {"content": [{"type": "text", "text": words}]}
        ],
    });
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(script.to_string()),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let start = std::time::Instant::now();
    let mut updates: Vec<(std::time::Duration, usize)> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "hi".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        &|| false,
        &mut |event| {
            if let EngineEvent::AssistantUpdate { message, .. } = &event {
                let text_len = message["content"].as_array().map_or(0, |blocks| {
                    blocks
                        .iter()
                        .map(|block| {
                            block
                                .get("text")
                                .and_then(Value::as_str)
                                .map_or(0, str::len)
                        })
                        .sum()
                });
                updates.push((start.elapsed(), text_len));
            }
            true
        },
    );
    assert!(
        updates.len() >= 10,
        "the paced stream must produce many updates, got {}",
        updates.len()
    );
    let first = updates.first().unwrap().0;
    let last = updates.last().unwrap().0;
    assert!(
        last.checked_sub(first).unwrap() >= std::time::Duration::from_millis(200),
        "updates must spread across the stream, got {first:?}..{last:?}"
    );
    // Content grows monotonically: every update carries the full partial
    // message, so lengths never regress.
    let lengths: Vec<usize> = updates.iter().map(|(_, len)| *len).collect();
    let mut monotonic = lengths.clone();
    monotonic.sort_unstable();
    assert_eq!(lengths, monotonic, "partial message lengths regress");
    // The settled final message arrives too (message_end, not just updates).
    let final_len = lengths.last().copied().unwrap_or(0);
    assert!(final_len >= 40 * 3, "final partial is the full text");
}

/// The wire events one `/compact` produced, in order: the compaction
/// event pair around the durable rows.
#[cfg(test)]
fn compaction_events(events: &[EngineEvent]) -> Vec<serde_json::Value> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::CompactionStart { event } | EngineEvent::Compaction { event, .. } => {
                Some(event.clone())
            }
            _ => None,
        })
        .collect()
}

#[test]
fn compact_session_command_emits_the_ts_event_pair_on_a_skip() {
    let (_engine, events) = run_prompts(
        serde_json::json!({ "responses": ["unused"] }),
        &["/compact"],
    );
    // The echo row precedes the events (TS `_executeSelectedSessionCommand`
    // records it before the queue runs the command); a skip records no
    // result row.
    let rows = custom_rows(&events);
    assert_eq!(rows.len(), 1, "echo only, no result row: {rows:?}");
    assert_eq!(rows[0]["customType"], "session_slash_command");
    assert_eq!(rows[0]["content"], "/compact");
    // The event pair: start, then the settled skip warning.
    let compaction = compaction_events(&events);
    assert_eq!(compaction.len(), 2, "start + end: {compaction:?}");
    assert_eq!(
        compaction[0],
        serde_json::json!({ "type": "compaction_start", "reason": "manual" })
    );
    assert_eq!(
        compaction[1],
        serde_json::json!({
            "type": "compaction_end",
            "reason": "manual",
            "aborted": false,
            "willRetry": false,
            "errorMessage": "Session is too short to compact \u{2014} try again once it grows",
            "errorSeverity": "warning",
        })
    );
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
}

#[test]
fn compact_session_command_emits_the_result_on_success() {
    // Two big turns (each ~12k tokens by the chars/4 estimate) push the
    // history past the keep-recent budget: the cut keeps the last turn,
    // the summarizer (the third queued faux response) covers the first.
    // The second turn's user message carries the crossing: the
    // keep-recent walk (the 20k default budget) must absorb its budget at
    // the USER message of the last turn — a cut inside a turn (an
    // assistant crossing) is a split-turn compaction that makes TWO
    // summarizer wire calls (TS parity), which this single-summary script
    // does not serve.
    let filler = "history ".repeat(6_000); // ~48k chars = ~12k tokens each
    let big_second = format!("second {}", "padded ".repeat(6_000)); // ~10.5k tokens
    let (_engine, events) = run_prompts(
        serde_json::json!({
            "responses": [
                { "text": filler },
                { "text": filler },
                { "text": "## Summary\nthe session story" },
            ]
        }),
        &["first", &big_second, "/compact focus on the goal"],
    );
    let compaction = compaction_events(&events);
    assert_eq!(compaction.len(), 2, "{compaction:?}");
    assert_eq!(
        compaction[0],
        serde_json::json!({
            "type": "compaction_start",
            "reason": "manual",
            "customInstructions": "focus on the goal",
        })
    );
    let end = &compaction[1];
    assert_eq!(end["type"], "compaction_end");
    assert_eq!(end["reason"], "manual");
    assert_eq!(end["aborted"], false);
    assert_eq!(end["customInstructions"], "focus on the goal");
    let result = end["result"].as_object().expect("the result payload");
    assert_eq!(result["summary"], "## Summary\nthe session story");
    assert!(result["tokensBefore"].as_u64().unwrap_or_default() > 0);
    // The TS dataKeys on the wire result (the live golden,
    // `tests/goldens/compaction-live-ts.json`): summary, firstKeptEntryId,
    // tokensBefore, details — the file-op lists verbatim from the durable
    // entry, and the summarizer usage never rides the wire.
    let mut result_keys: Vec<&str> = result.keys().map(String::as_str).collect();
    result_keys.sort_unstable();
    assert_eq!(
        result_keys,
        ["details", "firstKeptEntryId", "summary", "tokensBefore"],
        "CompactionResult key set"
    );
    assert_eq!(
        result["details"],
        serde_json::json!({ "readFiles": [], "modifiedFiles": [] })
    );
    assert!(result.get("usage").is_none());
    // The durable rows stay minimal (TS's queued `/compact` catch arm
    // records no result row): the echo row is the only custom row — except
    // the `ipython_state` notice, which follows the compaction whenever the
    // session's prewarmed kernel finished booting on this machine in time
    // (kernel-dependent, so it is scoped out of this assertion).
    let rows: Vec<_> = custom_rows(&events)
        .into_iter()
        .filter(|row| row["customType"] != "ipython_state")
        .collect();
    assert_eq!(rows.len(), 1, "the /compact echo only: {rows:?}");
    assert_eq!(rows[0]["customType"], "session_slash_command");
}

#[test]
fn autonomous_on_enables_the_driver_loop() {
    let (engine, events) = run_prompts(
        serde_json::json!({ "responses": ["unused"] }),
        &["/autonomous on --max-continuations 1 --max-turns 5"],
    );
    // The enable prompt runs the session command (echo + status rows) and
    // never admits a model turn.
    let status = custom_rows(&events);
    assert!(status
        .iter()
        .any(|row| row["customType"] == "autonomous_status"
            && row["content"]
                .as_str()
                .unwrap_or_default()
                .starts_with("[autonomous-status: on]")));
    assert_eq!(assistant_texts(&events), Vec::<String>::new());
    let state = engine.autonomous.blocking_lock();
    assert!(state.enabled);
    assert_eq!(state.limits.max_continuations, 1);
    assert_eq!(state.limits.max_turns, 5);
}

#[test]
fn autonomous_limit_stops_the_run_without_a_row() {
    let (engine, events) = run_prompts(
        serde_json::json!({ "responses": ["first", "second"] }),
        &["/autonomous on --max-continuations 1 --max-turns 5", "go"],
    );
    // The continuation churns INSIDE the one run (the TS in-run shape,
    // probed against the binary): the settled turn's `turn_end` is
    // followed by the continuation turn's `turn_start` and user row, with
    // no run boundary between them. Turn 1 continues (missing terminal
    // evidence), turn 2 hits the continuation cap: the stop writes no row
    // (the headless status and exit contracts carry it).
    assert_eq!(assistant_texts(&events), vec!["first", "second"]);
    let texts = user_texts(&events);
    assert_eq!(
        texts,
        vec![
            "go".to_string(),
            "[autonomous-continuation]\n\nNo human input is available in autonomous mode. Continue working until the host evaluator, verifier, or configured autonomous limits stop the run. If you were asking the user a question, make a reasonable assumption and verify it. If you believe you are blocked, prove it with host-observable evidence, preserve that evidence, and keep looking for safe progress while budget remains. Do not end the session yourself; the verifier/evaluator decides completion when configured gates pass.".to_string()
        ]
    );
    // The continuation's frames: one `turn_start` frame between the
    // settled turn's `turn_end` and the continuation user row (the loop's
    // inner-turn start, the run-opening one stays with the worker).
    let turn_ends = events
        .iter()
        .filter(|event| matches!(event, EngineEvent::TurnEnd { .. }))
        .count();
    let turn_starts = events
        .iter()
        .filter(|event| matches!(event, EngineEvent::TurnStart))
        .count();
    assert_eq!(turn_ends, 2);
    assert_eq!(turn_starts, 1, "the continuation turn's inner start");
    // The stop surfaces no `autonomous_status` row of its own: the enable
    // announcement is the only one (the limit stop writes no row — the
    // headless status and exit contracts carry it, the TS shape).
    let status_rows: Vec<_> = custom_rows(&events)
        .into_iter()
        .filter(|row| row["customType"] == "autonomous_status")
        .collect();
    assert_eq!(status_rows.len(), 1, "the enable announcement only");
    assert!(status_rows[0]["content"]
        .as_str()
        .unwrap_or_default()
        .starts_with("[autonomous-status: on]"));
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
    // Per-turn usage accounting: two settled turns.
    let state = engine.autonomous.blocking_lock();
    assert_eq!(state.turns_used, 2);
    assert_eq!(state.continuations_used, 1);
}

#[test]
fn autonomous_gate_pass_and_failure_drive_the_loop() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // The gate passes only on its second run (a counter file in the cwd).
    let dir = tempfile::TempDir::new().unwrap();
    let gate = format!(
        "n=$(cat {0}/cnt 2>/dev/null || echo 0); echo $((n+1)) > {0}/cnt; [ $n -ge 1 ]",
        dir.path().display()
    );
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
                serde_json::json!({ "responses": ["first attempt", "fixed it"] }).to_string(),
            ),
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap(),
    );
    // The in-run continuation hook upgrades the engine's registered arc.
    engine.register_arc();
    let on = format!("/autonomous on --gate {gate:?}");
    let mut events: Vec<EngineEvent> = Vec::new();
    for prompt in [on.as_str(), "go"] {
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message: prompt.to_string(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                events.push(event);
                true
            },
        );
    }
    // Turn 1 fails the gate -> gate-failure continuation (in-run, the next
    // turn of the same run); turn 2 passes -> the run stops with no row
    // (the TS shape: the stop surfaces through the status request and the
    // exit contracts, never a durable row).
    assert_eq!(assistant_texts(&events), vec!["first attempt", "fixed it"]);
    let texts = user_texts(&events);
    assert_eq!(texts.len(), 2);
    assert!(texts[1].starts_with("[autonomous-continuation: gate-failed]"));
    assert!(texts[1].contains("exited with code 1"));
    let status_rows: Vec<_> = custom_rows(&events)
        .into_iter()
        .filter(|row| row["customType"] == "autonomous_status")
        .collect();
    assert_eq!(status_rows.len(), 1, "the enable announcement only");
    assert!(status_rows[0]["content"]
        .as_str()
        .unwrap_or_default()
        .starts_with("[autonomous-status: on]"));
    let state = engine.autonomous.blocking_lock();
    assert_eq!(state.gates.commands, vec![gate]);
    assert_eq!(state.last_gate_failure, None);
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
}

/// A scripted policy driver: the engine must inject exactly what the trait
/// returns, consult it after every turn, and account every settled message.
#[cfg(test)]
struct ScriptedDriver {
    /// Pops from the end, so reverse the desired order when building.
    follow_ups: std::sync::Mutex<Vec<pa_core::autonomous::AutonomousFollowUp>>,
    accounted: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
impl pa_core::autonomous::AutonomousDriver for ScriptedDriver {
    fn account_message(
        &self,
        _state: &mut pa_core::autonomous::AutonomousRuntimeState,
        message: &pa_types::ai::AssistantMessage,
    ) {
        assert_ne!(message.stop_reason, pa_types::ai::StopReason::Error);
        self.accounted
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    fn after_turn<'a>(
        &'a self,
        _state: &'a mut pa_core::autonomous::AutonomousRuntimeState,
        _message: &'a pa_types::ai::AssistantMessage,
    ) -> pa_core::autonomous::AutonomousFollowUpFuture<'a> {
        let next = self
            .follow_ups
            .lock()
            .unwrap()
            .pop()
            .unwrap_or(pa_core::autonomous::AutonomousFollowUp::Inactive);
        Box::pin(async move { next })
    }
}

#[test]
fn the_turn_loop_is_driven_by_the_driver_trait() {
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
            faux_script: Some(serde_json::json!({ "responses": ["one", "two"] }).to_string()),
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap(),
    );
    // The in-run continuation hook upgrades the engine's registered arc.
    engine.register_arc();
    let status = pa_core::autonomous::autonomous_status(&engine.autonomous.blocking_lock());
    // The queue pops from the end: the continuation is consulted first,
    // the stop on the second settled turn.
    let driver = std::sync::Arc::new(ScriptedDriver {
        follow_ups: std::sync::Mutex::new(vec![
            pa_core::autonomous::AutonomousFollowUp::Stop {
                reason: pa_core::autonomous::AutonomousStopReason::Limit(
                    pa_core::autonomous::AutonomousLimitReason::MaxTurns,
                ),
                status: Box::new(status),
            },
            pa_core::autonomous::AutonomousFollowUp::Continue {
                text: "scripted continuation".to_string(),
            },
        ]),
        accounted: std::sync::atomic::AtomicUsize::new(0),
    });
    engine
        .set_autonomous_driver(std::sync::Arc::clone(&driver)
            as std::sync::Arc<dyn pa_core::autonomous::AutonomousDriver>);
    let mut events: Vec<EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "go".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        &|| false,
        &mut |event| {
            events.push(event);
            true
        },
    );
    // The engine holds no autonomous logic of its own: the injected text
    // and the turn count come straight from the trait, minted by the
    // in-run hook (the continuation runs inside the one agent run).
    assert_eq!(
        user_texts(&events),
        vec!["go".to_string(), "scripted continuation".to_string()]
    );
    assert_eq!(
        assistant_texts(&events),
        vec!["one".to_string(), "two".to_string()]
    );
    // The stop surfaces no row (the TS shape).
    assert!(custom_rows(&events)
        .into_iter()
        .all(|row| row["customType"] != "autonomous_status"));
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
    // Per-message accounting ran through the trait for both settled turns.
    assert_eq!(
        driver.accounted.load(std::sync::atomic::Ordering::SeqCst),
        2
    );
}

#[test]
fn agent_engine_streams_updates_and_final_message() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    // Scoped env: the faux seam is process-global; keep the test isolated.
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(serde_json::json!({ "responses": ["streamed answer"] }).to_string()),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let mut events: Vec<EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "hi".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        &|| false,
        &mut |event| {
            events.push(event);
            true
        },
    );
    // User message, streamed updates, final message, done.
    assert!(matches!(&events[0], EngineEvent::UserMessage(_)));
    assert!(events
        .iter()
        .any(|event| matches!(event, EngineEvent::AssistantUpdate { .. })));
    let final_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::AssistantMessage(_)))
        .expect("final assistant message");
    let EngineEvent::AssistantMessage(message) = &events[final_index] else {
        unreachable!();
    };
    assert_eq!(message["content"][0]["text"], "streamed answer");
    assert_eq!(message["role"], "assistant");
    assert_eq!(message["stopReason"], "stop");
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
}

// --- TS #2375: the engine-side quota park ---

/// An engine with the quota-park seams live: the worker cron wiring
/// (store + binding + scheduler-less mutation hook), the supervisor
/// link the binding resolves, and a session file whose header names
/// the durable session id.
fn park_engine(dir: &std::path::Path) -> AgentSessionEngine {
    std::fs::create_dir_all(dir.join("agent")).unwrap();
    let session_file = dir.join("session.jsonl");
    std::fs::write(
        &session_file,
        format!(
            "{}\n",
            serde_json::json!({
                "type": "session",
                "version": 3,
                "id": "park-session",
                "timestamp": "2026-01-01T00:00:00.000Z",
                "cwd": dir.display().to_string(),
            })
        ),
    )
    .unwrap();
    let store =
        std::sync::Arc::new(pa_core::cron::store::AgentCronJobStore::for_session_artifacts());
    store.register_session_artifact("park-session", &dir.join("artifacts"));
    let cron_store = pa_core::session_engine::runtime_wiring::KernelCronWiring {
        store: std::sync::Arc::clone(&store),
        binding: None,
        mutation_hook: None,
    };
    AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.to_path_buf(),
        agent_dir: dir.join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: Some(session_file),
        faux_script: None,
        supervisor_link: Some(SupervisorLinkConfig {
            socket_path: dir.join("supervisor.sock"),
            active_session_id: "active-park".to_string(),
            worker_token: "token".to_string(),
        }),
        telemetry_disabled: None,
        cron_store: Some(cron_store),
        queued_steering_probe: None,
    })
    .unwrap()
}

fn quota_failure_message(
    kind: Option<&str>,
    retry_after_ms: Option<u64>,
) -> pa_agent::types::AssistantMessage {
    let details = serde_json::json!({
        "kind": kind,
        "retryAfterMs": retry_after_ms,
    });
    pa_agent::types::AssistantMessage {
        content: vec![],
        api: "openai-completions".to_string(),
        provider: "battery".to_string(),
        model: "mock-1".to_string(),
        response_model: None,
        response_id: None,
        diagnostics: Some(vec![pa_agent::types::AssistantMessageDiagnostic {
            kind: "provider_stream_failure".to_string(),
            timestamp: 0,
            error: None,
            details: Some(details),
        }]),
        usage: pa_agent::types::Usage::zero(),
        stop_reason: pa_agent::types::StopReason::Error,
        stop_reason_raw: None,
        error_message: Some("You have hit your usage limit".to_string()),
        timestamp: 0,
    }
}

/// The park entry appender's write-failure propagation (the
/// persist-or-decline plumbing the park-arming arms guard with): a
/// PERSISTING session manager whose file becomes a directory fails the
/// append at the write stage (EISDIR, root included — a mode-based
/// injection would not stop root), and the `io::Result` reaches the
/// caller — the arming arms' decline gate consumes exactly this Err.
///
/// The daemon worker's INSTALLED engine session stays non-persisted
/// (`in_memory_in_session_dir`: the worker owns the durable file and
/// mirrors the entries), so its appends answer `Ok` and the park
/// proceeds unchanged; this `Err` path is the persisted-manager
/// contract the gate exists for.
#[tokio::test]
async fn a_failed_park_entry_write_propagates_to_the_caller() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = park_engine(dir.path());
    let session_file = dir.path().join("session.jsonl");
    // A persisting manager over the session file (open repairs + pins
    // the durable path).
    let handle = std::sync::Arc::new(tokio::sync::Mutex::new(
        pa_core::session::manager::SessionManager::open(dir.path(), dir.path(), &session_file),
    ));
    // Seed the first assistant entry: custom appends before it defer
    // (the pre-first-assistant buffer, TS parity), so the park entry
    // must land after one to flush at all.
    handle
        .lock()
        .await
        .append_message(pa_types::session::AgentMessage::Assistant(
            pa_types::ai::AssistantMessage {
                content: vec![pa_types::ai::AssistantContentBlock::Text(
                    pa_types::ai::TextContent {
                        text: "seed".to_string(),
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
        .expect("the assistant seed persists");
    // Break the durable write: the session file becomes a directory.
    std::fs::remove_file(&session_file).expect("remove the session file");
    std::fs::create_dir(&session_file).expect("block the session file path");
    let result = engine
        .append_quota_park_entry(
            Some(handle),
            crate::util::now_ms() + 30_000,
            1,
            Some("job-1"),
            Some("battery"),
        )
        .await;
    assert!(
        result.is_err(),
        "a failed durable write must propagate to the park-arming gate"
    );
}

/// A quota failure whose reported reset exceeds the wait cap parks the
/// session: the surfaced status names the wake, the state counts the
/// park, and the durable wake job lands in the session's artifacts.
#[tokio::test]
async fn quota_failure_beyond_cap_parks_with_a_durable_wake() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = park_engine(dir.path());
    let message = quota_failure_message(Some("rate_limit"), Some(3_600_000));
    // Captured BEFORE the park call: the slack assertion measures against
    // the pre-park clock, so test-process delay can only widen the slack
    // (the park's own resume_at already includes the grace from its
    // later now_ms), never shrink it under the window's lower bound.
    let before_park_ms = crate::util::now_ms();
    let outcome = engine
            .park_for_quota_reset(
                &message,
                "Provider requested a 3600s wait before retrying (above retry.provider.maxRetryDelayMs=60000ms)",
            )
            .await
            .expect("the park fires");
    assert!(
        outcome.status_message.contains("Session parked until ")
            && outcome.status_message.contains(
                "and will resume automatically (retry.provider.waitForUsage.pauseUntilReset)"
            )
    );
    assert!(engine.is_quota_parked());
    let park = engine
        .quota_park
        .lock()
        .expect("park state")
        .clone()
        .expect("parked");
    assert_eq!(park.park_count, 1);
    let job_id = park.job_id.expect("the wake job id");
    let store = engine.config.cron_store.as_ref().expect("wiring").clone();
    let job = store
        .store
        .list()
        .into_iter()
        .find(|job| job.id == job_id)
        .expect("the durable wake job");
    assert_eq!(
        job.label.as_deref(),
        Some("quota-resume"),
        "the wake carries the quota-resume label"
    );
    assert_eq!(
        job.prompt,
        pa_core::session_engine::provider_park::QUOTA_RESUME_MARKER_TEXT
    );
    assert_eq!(job.schedule.kind, pa_core::cron::ScheduleKind::Once);
    assert_eq!(job.active_session_id, "active-park");
    assert_eq!(job.session_id, "park-session");
    // The wake sits ~30s past the reported reset (the grace).
    let resume_slack = park.resume_at_ms as i64 - (before_park_ms as i64 + 3_600_000);
    assert!(
        (25_000..=40_000).contains(&resume_slack),
        "resume slack {resume_slack}"
    );
}

/// A repeat quota failure while the wake is still armed is a no-op: no
/// new park, no new wake, the already-parked status surfaces.
#[tokio::test]
async fn repeat_failure_while_parked_keeps_the_scheduled_wake() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = park_engine(dir.path());
    let message = quota_failure_message(Some("rate_limit"), Some(3_600_000));
    let first = engine
        .park_for_quota_reset(&message, "abort sentence")
        .await
        .expect("the first park fires");
    assert!(first.status_message.contains("Session parked until"));
    let before = engine
        .quota_park
        .lock()
        .expect("park state")
        .clone()
        .expect("parked");
    let second = engine
        .park_for_quota_reset(&message, "abort sentence")
        .await
        .expect("the already-parked arm surfaces");
    assert!(
        second
            .status_message
            .starts_with("Session is parked until ")
            && second
                .status_message
                .contains("this turn ended without a retry"),
        "the already-parked wording surfaces: {second:?}"
    );
    let after = engine
        .quota_park
        .lock()
        .expect("park state")
        .clone()
        .expect("still parked");
    assert_eq!(before.job_id, after.job_id, "the wake is not rescheduled");
    assert_eq!(after.park_count, 1, "the repeat consumes no park");
    let store = engine.config.cron_store.as_ref().expect("wiring").clone();
    assert_eq!(store.store.list().len(), 1, "no second wake job is created");
}

/// Non-quota failures never park, and a quota failure without a
/// reported reset keeps the abort (a blind park would guess a wake).
#[tokio::test]
async fn non_quota_and_no_reset_failures_do_not_park() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = park_engine(dir.path());
    let non_quota = quota_failure_message(Some("server_error"), Some(3_600_000));
    assert!(engine
        .park_for_quota_reset(&non_quota, "abort")
        .await
        .is_none());
    let no_reset = quota_failure_message(Some("rate_limit"), None);
    assert!(engine
        .park_for_quota_reset(&no_reset, "abort")
        .await
        .is_none());
    assert!(!engine.is_quota_parked());
}

/// A spent park budget ends the episode: the stale park clears and
/// the give-up stands (the goal fails like the bounded wait it
/// replaced).
#[tokio::test]
async fn spent_park_budget_clears_the_stale_park() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = park_engine(dir.path());
    // Arm a wake, then age the park state past its wake time: the
    // budget check runs against a wake that already fired (the
    // store only accepts future one-shots; the state is what the
    // consumed-wake paths read).
    let fired_job_id = engine
        .create_quota_resume_job(crate::util::now_ms() + 60_000)
        .await
        .expect("wake job");
    *engine.quota_park.lock().expect("park state") = Some(QuotaParkState {
        park_count: engine.park_policy().max_parks,
        resume_at_ms: crate::util::now_ms() - 60_000,
        job_id: Some(fired_job_id),
        wake_retries: 0,
    });
    let message = quota_failure_message(Some("rate_limit"), Some(3_600_000));
    assert!(
        engine
            .park_for_quota_reset(&message, "abort")
            .await
            .is_none(),
        "the spent budget declines the park"
    );
    assert!(
        !engine.is_quota_parked(),
        "the stale park clears when the episode ends"
    );
}

/// The wake fired but its probe failed with no new reset: the bounded
/// re-arm probes again instead of parking forever.
#[tokio::test]
async fn consumed_wake_without_reset_re_arms_bounded() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = park_engine(dir.path());
    let fired_job_id = engine
        .create_quota_resume_job(crate::util::now_ms() + 60_000)
        .await
        .expect("wake job");
    *engine.quota_park.lock().expect("park state") = Some(QuotaParkState {
        park_count: 1,
        resume_at_ms: crate::util::now_ms() - 60_000,
        job_id: Some(fired_job_id),
        wake_retries: 0,
    });
    let no_reset = quota_failure_message(Some("rate_limit"), None);
    let outcome = engine
        .park_for_quota_reset(&no_reset, "abort")
        .await
        .expect("the re-arm fires");
    assert!(outcome
        .status_message
        .starts_with("Session is parked until "));
    let park = engine
        .quota_park
        .lock()
        .expect("park state")
        .clone()
        .expect("re-armed");
    assert_eq!(park.park_count, 1, "the re-arm consumes no park");
    assert_eq!(park.wake_retries, 1);
    let store = engine.config.cron_store.as_ref().expect("wiring").clone();
    assert_eq!(
        store.store.list().len(),
        2,
        "the re-arm creates a replacement wake"
    );
    // Spend the re-arm budget: the park drops and the give-up stands.
    *engine.quota_park.lock().expect("park state") = Some(QuotaParkState {
        park_count: park.park_count,
        resume_at_ms: crate::util::now_ms() - 60_000,
        job_id: park.job_id,
        wake_retries: QUOTA_WAKE_MAX_RETRIES,
    });
    assert!(
        engine
            .park_for_quota_reset(&no_reset, "abort")
            .await
            .is_none(),
        "the spent re-arm budget drops the park"
    );
    assert!(!engine.is_quota_parked());
}

/// The replacement teardown ends the retired session's park with it:
/// the state clears so an unparked replacement is never reported
/// quota-parked (the replacement build restores whatever its own
/// branch says).
#[tokio::test]
async fn retire_session_runtime_clears_the_live_park() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = park_engine(dir.path());
    let message = quota_failure_message(Some("rate_limit"), Some(3_600_000));
    engine
        .park_for_quota_reset(&message, "abort")
        .await
        .expect("the park fires");
    assert!(engine.is_quota_parked());
    engine.retire_session_runtime().await;
    assert!(
        !engine.is_quota_parked(),
        "the retired session's park ends with it"
    );
}

/// A parked session that completes a model call resumes: the park
/// clears, the pending wake cancels, and an early success queues the
/// resume marker (the wake probe's success must not).
#[tokio::test]
async fn early_resume_clears_the_park_and_cancels_the_wake() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = park_engine(dir.path());
    let message = quota_failure_message(Some("rate_limit"), Some(3_600_000));
    engine
        .park_for_quota_reset(&message, "abort")
        .await
        .expect("the park fires");
    let job_id = engine
        .quota_park
        .lock()
        .expect("park state")
        .clone()
        .expect("parked")
        .job_id
        .expect("wake");
    let store = engine.config.cron_store.as_ref().expect("wiring").clone();
    assert_eq!(store.store.list().len(), 1);
    engine.resume_quota_park(false).await;
    assert!(!engine.is_quota_parked(), "the park clears on resume");
    let job = store
        .store
        .list()
        .into_iter()
        .find(|job| job.id == job_id)
        .expect("the wake job still exists");
    assert_eq!(
        job.status,
        pa_core::cron::JobStatus::Cancelled,
        "the pending wake cancels on resume"
    );
}

// --- cold-open-residual oracles: the persisted depth scan and the shared
// --- window goal seed (P2b/P3/P4). Both differential tests pin the new
// --- fast paths against the reference readers over fixture classes.

/// The reference reader the depth scan replaced, verbatim: the whole-file
/// read plus a full `parse_session_entries` walk. The scan
/// (`model::persisted_rlm_max_depth`) must match it on every class.
fn persisted_rlm_max_depth_reference(path: Option<&str>) -> Option<u64> {
    let path = std::path::Path::new(path?);
    let content = std::fs::read_to_string(path).ok()?;
    crate::session_store::parse_session_entries(&content)
        .iter()
        .rev()
        .find_map(|entry| {
            (entry.get("type").and_then(serde_json::Value::as_str) == Some("custom")
                && entry.get("customType").and_then(serde_json::Value::as_str)
                    == Some("rlm_max_depth_state"))
                .then(|| {
                    entry
                        .get("data")
                        .and_then(|data| data.get("maxDepth"))
                        .and_then(serde_json::Value::as_u64)
                })
                .flatten()
        })
}

fn depth_override_row(id: &str, depth: serde_json::Value) -> String {
    json!({
        "type": "custom",
        "id": id,
        "timestamp": "2026-01-01T00:00:02.000Z",
        "customType": "rlm_max_depth_state",
        "data": { "maxDepth": depth },
    })
    .to_string()
}

/// The depth scan matches the reference reader over every row class: the
/// common absent case, a present override (last and mid-file), a
/// non-`u64` bound that must not stop the scan, malformed lines, the
/// shape-loose row a typed store reader would skip (no `id`), the
/// transcript-text marker false-positive gate, CRLF lines, multi-byte
/// content, the invalid-UTF-8 file (both readers return `None`), and
/// the empty/missing/absent-path fallthroughs.
#[test]
fn persisted_rlm_max_depth_scan_matches_reference_across_classes() {
    let header = || {
        json!({
            "type": "session", "version": 3, "id": "s",
            "timestamp": "2026-01-01T00:00:00.000Z", "cwd": "/w",
        })
        .to_string()
    };
    let message = || {
        json!({
            "type": "message", "id": "m1", "timestamp": "2026-01-01T00:00:01.000Z",
            "message": { "role": "user", "content": "we ship rlm_max_depth_state fixes", "timestamp": 0 },
        })
        .to_string()
    };
    let unicode_message = || {
        json!({
            "type": "message", "id": "m1", "timestamp": "2026-01-01T00:00:01.000Z",
            "message": { "role": "user", "content": "emoji \u{1f69b}\u{1f69b} bytes across boundaries", "timestamp": 0 },
        })
        .to_string()
    };
    // The shape-loose row: parses as a raw `Value` (the reference's row
    // shape) but would fail the typed `SessionEntry` reader (no `id`) -
    // the scan must see it exactly like the reference does.
    let shape_loose = || {
        json!({
            "type": "custom",
            "timestamp": "2026-01-01T00:00:03.000Z",
            "customType": "rlm_max_depth_state",
            "data": { "maxDepth": 7 },
        })
        .to_string()
    };
    let malformed = || r#"{"type": "message", "id": "broken""#.to_string();
    let missing_bound_row = || {
        json!({
            "type": "custom", "id": "d2", "timestamp": "2026-01-01T00:00:04.000Z",
            "customType": "rlm_max_depth_state", "data": {},
        })
        .to_string()
    };
    let marker_text_row = || {
        json!({
            "type": "message", "id": "m2", "timestamp": "2026-01-01T00:00:02.000Z",
            "message": { "role": "assistant", "content": "rlm_max_depth_state", "timestamp": 0 },
        })
        .to_string()
    };

    let classes: Vec<(&str, String)> = [
        ("absent", [header(), message()].join("\n")),
        (
            "present_last",
            [header(), message(), depth_override_row("d1", json!(5))].join("\n"),
        ),
        (
            "present_mid",
            [header(), message(), depth_override_row("d1", json!(5)), message()].join("\n"),
        ),
        // A newer row whose bound does not parse as u64 must not stop
        // the scan: the older valid row still wins (the reference's
        // `find_map` continues past it).
        (
            "non_u64_bound_continues",
            [
                header(),
                message(),
                depth_override_row("d1", json!(5)),
                depth_override_row("d2", json!("many")),
            ]
            .join("\n"),
        ),
        (
            "missing_bound_continues",
            [
                header(),
                message(),
                depth_override_row("d1", json!(5)),
                missing_bound_row(),
            ]
            .join("\n"),
        ),
        (
            "malformed_lines_skipped",
            [
                header(),
                malformed(),
                depth_override_row("d1", json!(9)),
                malformed(),
            ]
            .join("\n"),
        ),
        (
            "shape_loose_row_found",
            [header(), message(), shape_loose()].join("\n"),
        ),
        (
            "marker_text_not_a_row",
            [header(), message(), marker_text_row()].join("\n"),
        ),
        (
            "crlf_lines",
            [
                header(),
                message(),
                depth_override_row("d1", json!(11)),
            ]
            .join("\r\n"),
        ),
        ("unicode_content_absent", [header(), unicode_message()].join("\n")),
        (
            "unicode_content_present",
            [header(), unicode_message(), depth_override_row("d1", json!(3))].join("\n"),
        ),
        ("empty_file", String::new()),
    ]
    .into();
    for (name, content) in classes {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut bytes = content.into_bytes();
        if !bytes.is_empty() {
            bytes.push(b'\n');
        }
        std::fs::write(&path, bytes).unwrap();
        let path_str = path.display().to_string();
        assert_eq!(
            model::persisted_rlm_max_depth(Some(&path_str)),
            persisted_rlm_max_depth_reference(Some(&path_str)),
            "depth class {name}"
        );
    }
    // An invalid UTF-8 byte anywhere voids the override for both
    // readers (the reference's whole-file `read_to_string` fails).
    {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut bytes = format!(
            "{}\n{}\n{}\n",
            header(),
            message(),
            depth_override_row("d1", json!(5))
        )
        .into_bytes();
        bytes.push(0xff);
        bytes.push(b'\n');
        std::fs::write(&path, bytes).unwrap();
        let path_str = path.display().to_string();
        assert_eq!(
            model::persisted_rlm_max_depth(Some(&path_str)),
            persisted_rlm_max_depth_reference(Some(&path_str)),
            "depth class invalid_utf8"
        );
        assert!(
            model::persisted_rlm_max_depth(Some(&path_str)).is_none(),
            "invalid utf8 voids the override"
        );
    }
    // Missing file and absent path: the TS fallthrough keeps the
    // create-carried bound for both readers.
    assert_eq!(model::persisted_rlm_max_depth(None), None);
    assert_eq!(
        model::persisted_rlm_max_depth(None),
        persisted_rlm_max_depth_reference(None)
    );
    let missing = "/nonexistent-cold-open-residual/session.jsonl";
    assert_eq!(
        model::persisted_rlm_max_depth(Some(missing)),
        persisted_rlm_max_depth_reference(Some(missing))
    );
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
    let message = |id: &str, parent: &str, role: &str| {
        json!({
            "type": "message", "id": id, "parentId": parent,
            "timestamp": "2026-01-01T00:00:01.000Z",
            "message": { "role": role, "content": "hi", "timestamp": 0 },
        })
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
    // (name, rows, terminated tail: an unterminated row forces the
    // ordinary full-reader fallback for both readers)
    let classes: Vec<(&str, Vec<serde_json::Value>, bool)> = [
        (
            "windowed_with_goal",
            vec![header(), message("m1", "", "user"), goal_row("g1", "m1")],
            true,
        ),
        ("windowed_no_goal", vec![header(), message("m1", "", "user")], true),
        (
            "windowed_off_branch_goal",
            vec![
                header(),
                // The goal links to a row no chain reaches: the active
                // branch (leaf m2 -> m1 -> header) never visits it.
                goal_row("g1", "ghost-id"),
                message("m2", "m1", "assistant"),
            ],
            true,
        ),
        (
            "fallback_with_goal",
            vec![header(), message("m1", "", "user"), goal_row("g1", "m1")],
            false,
        ),
        ("fallback_no_goal", vec![header(), message("m1", "", "user")], false),
    ]
    .into();
    for (name, rows, terminated) in classes {
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
        // The shared open's extraction (adopt_built_session's block):
        // the window's snapshot goal when the window serves, else the
        // loaded store's active-branch scan.
        let shared = if let Ok(Some(window)) = pa_core::session::window::WindowedSessionStore::open(&path)
        {
            window.goal_state().cloned()
        } else {
            crate::session_store::SessionFile::open(&path)
                .ok()
                .as_ref()
                .and_then(crate::goal_state_persist::goal_state_in_session_file)
        };
        assert_eq!(
            shared,
            crate::goal_state_persist::persisted_goal_state(Some(&path)),
            "goal class {name}"
        );
    }
}
