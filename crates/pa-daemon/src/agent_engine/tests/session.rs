//! The session-surface tests (skills enumeration, replacement teardown, the branch rebuild).
use super::*;

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
