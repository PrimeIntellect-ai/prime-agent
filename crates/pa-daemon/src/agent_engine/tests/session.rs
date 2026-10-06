//! The session-surface tests (skills enumeration, replacement teardown, the branch rebuild).
use super::*;
use crate::engine::PromptBatchRow;

/// `get_commands` enumerates the session's skills as `skill:<name>`
/// commands, including before the first prompt (the read seam demand-builds
/// the core session). The faux provider registers under `FAUX_TEST_LOCK`
/// on a blocking thread (the lock is std, so it never rides an await).
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
        // Register under the lock; the async section resolves the cached model.
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
    // The checkout's bundled skills enumerate too, so the assertion is
    // on the test's own skill, not the count.
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
    // Every skill command carries the `skill:` name form and source info.
    for command in &skill_commands {
        assert!(command
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| name.starts_with("skill:")));
        assert!(command.get("sourceInfo").is_some());
    }
}

#[tokio::test]
async fn replacement_teardown_retires_the_session_and_the_funnel_adopts_the_branch() {
    let engine = {
        let (engine, _events) = tokio::task::spawn_blocking(|| {
            run_prompts(
                &json!({ "engine": "faux", "responses": [{ "text": "first" }] }),
                &["hello"],
            )
        })
        .await
        .expect("prompt join");
        engine
    };
    assert!(engine.session.lock().await.is_some());

    // Retire: the built session drops with its mirrored goal handles.
    engine.retire_session_runtime().await;
    assert!(engine.session.lock().await.is_none());
    assert!(engine
        .goal_runtime
        .lock()
        .expect("goal runtime lock")
        .is_none());

    // Park the moved branch on the unbuilt engine (the worker parks it on a blocking thread).
    let mut store = crate::session_store::SessionFile::create("/tmp", None, 0);
    store.append_message(&json!({
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

    // The async funnel's build adopts the parked branch.
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
    // context panics — the teardown rides a blocking thread.
    tokio::task::spawn_blocking(move || drop(engine))
        .await
        .expect("engine drop join");
}

#[tokio::test]
async fn live_branch_rebuild_reloads_the_goal_state_from_the_moved_branch() {
    let engine = {
        let (engine, _events) = tokio::task::spawn_blocking(|| {
            run_prompts(
                &json!({
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
    // The goal commands left the paused goal's rows on the live branch.
    assert!(engine.session.lock().await.is_some());
    let goal_before = engine.goal_state_value();
    assert_eq!(goal_before["status"], "paused", "state: {goal_before:?}");
    assert_eq!(goal_before["objective"], "ship it");
    let goal_id = goal_before["goalId"].as_str().expect("goal id").to_string();

    // The live branch, captured for the move back. Every engine call
    // (the block_on the capture needs) rides a blocking thread.
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
            // The moved branch is the post-header path (the worker's
            // store form carries no header row).
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
    store.append_message(&json!({
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
    // The reload publishes its change once, then stays silent (the dedupe).
    let update = engine
        .goal_update_after_rebuild()
        .expect("the reload announced the change");
    assert_eq!(update["status"], "idle");
    assert!(engine.goal_update_after_rebuild().is_none());

    // Moving back onto the branch that owns the goal rows restores them.
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

    tokio::task::spawn_blocking(move || drop(engine))
        .await
        .expect("engine drop join");
}

/// The model-side user rows of the built core session: the texts the
/// admitted turn actually carried.
fn core_session_user_texts(engine: &AgentSessionEngine) -> Vec<String> {
    engine.runtime.block_on(async {
        let guard = engine.session.lock().await;
        match guard.as_deref() {
            Some(core) => core
                .session
                .entries()
                .await
                .iter()
                .filter_map(|entry| match entry {
                    pa_types::session::FileEntry::Message {
                        message: pa_types::session::AgentMessage::User(user),
                        ..
                    } => Some(user.content.text()),
                    _ => None,
                })
                .collect(),
            None => Vec::new(),
        }
    })
}

/// One faux-driven engine with a demo skill installed on disk, running
/// `prompt` (+ any `batch` rows) through the admission seam (the
/// `/skill:` expansion site).
fn run_skill_prompt_body(
    skill_body: &str,
    prompt: &str,
    batch: &[&str],
) -> (std::sync::Arc<AgentSessionEngine>, Vec<EngineEvent>) {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let skill_dir = dir.path().join("agent").join("skills").join("demo-skill");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        format!("---\nname: demo-skill\ndescription: Demo the admission seam\n---\n{skill_body}"),
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
        faux_script: Some(json!({ "engine": "faux", "responses": [{ "text": "ok" }] }).to_string()),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let engine = std::sync::Arc::new(engine);
    engine.register_arc();
    let mut events: Vec<EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: batch
                .iter()
                .map(|text| PromptBatchRow {
                    text: text.to_string(),
                    images: Vec::new(),
                })
                .collect(),
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
    (engine, events)
}

/// The single-prompt form of [`run_skill_prompt_body`].
fn run_skill_prompt(prompt: &str) -> Vec<EngineEvent> {
    run_skill_prompt_body("Run the demo protocol.", prompt, &[]).1
}

#[test]
fn a_bare_skill_invocation_admits_with_the_no_task_instruction() {
    let events = run_skill_prompt("/skill:demo-skill");
    let texts = user_texts(&events);
    assert!(
        texts.iter().all(|text| !text.starts_with("/skill:")),
        "the raw command never reaches the rows: {texts:?}"
    );
    let row = texts
        .iter()
        .find(|text| text.starts_with("<skill"))
        .unwrap_or_else(|| panic!("the accepted row carries the expanded block: {texts:?}"));
    let parsed = pa_types::skill_blocks::parse_skill_block(row)
        .unwrap_or_else(|| panic!("the accepted row parses as a skill block: {row:?}"));
    assert_eq!(parsed.name, "demo-skill");
    assert_eq!(
        parsed.user_message.as_deref(),
        Some(crate::agent_engine::lifecycle::BARE_SKILL_INVOCATION_INSTRUCTION),
        "the floor's instruction rides the block's trailing user message"
    );
    assert!(
        parsed.content.contains("Run the demo protocol."),
        "the block body carries the skill content: {parsed:?}"
    );
    assert_eq!(assistant_texts(&events), vec!["ok"]);
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::Done(Err(_)))),
        "the bare invocation admits without an error: {events:?}"
    );
}

#[test]
fn a_skill_invocation_with_args_persists_the_block_and_the_args() {
    let events = run_skill_prompt("/skill:demo-skill fix the flake");
    let texts = user_texts(&events);
    let row = texts
        .iter()
        .find(|text| text.starts_with("<skill"))
        .unwrap_or_else(|| panic!("the accepted row carries the expanded block: {texts:?}"));
    let parsed = pa_types::skill_blocks::parse_skill_block(row)
        .unwrap_or_else(|| panic!("the accepted row parses as a skill block: {row:?}"));
    assert_eq!(parsed.name, "demo-skill");
    assert_eq!(
        parsed.user_message.as_deref(),
        Some("fix the flake"),
        "the user's args persist as the trailing user message"
    );
    assert!(
        !row.contains(crate::agent_engine::lifecycle::BARE_SKILL_INVOCATION_INSTRUCTION),
        "the with-args row never carries the floor's instruction: {row:?}"
    );
    assert_eq!(assistant_texts(&events), vec!["ok"]);
}

#[test]
fn a_batched_bare_skill_row_admits_on_the_floored_text() {
    let (engine, events) =
        run_skill_prompt_body("Run the demo protocol.", "hello", &["/skill:demo-skill"]);
    let texts = user_texts(&events);
    // The primary accepted row, then the batched row, in delivery order.
    assert_eq!(
        texts.first().map(String::as_str),
        Some("hello"),
        "the primary row admits first: {texts:?}"
    );
    let row = texts
        .iter()
        .find(|text| text.starts_with("<skill"))
        .unwrap_or_else(|| panic!("the batched row carries the expanded block: {texts:?}"));
    let parsed = pa_types::skill_blocks::parse_skill_block(row)
        .unwrap_or_else(|| panic!("the batched row parses as a skill block: {row:?}"));
    assert_eq!(parsed.name, "demo-skill");
    assert_eq!(
        parsed.user_message.as_deref(),
        Some(crate::agent_engine::lifecycle::BARE_SKILL_INVOCATION_INSTRUCTION),
        "the floor rides the batched row too"
    );
    // The model-side row is the SAME text: the turn ran on the floored
    // block, not a re-expanded bare command.
    let core_rows = core_session_user_texts(&engine);
    assert!(
        core_rows.iter().any(|text| text == row),
        "the admitted model-side row matches the accepted row: {core_rows:?}"
    );
    assert_eq!(assistant_texts(&events), vec!["ok"]);
}

#[test]
fn a_bare_invocation_of_a_close_tagged_body_still_floors() {
    let (_engine, events) = run_skill_prompt_body(
        "Run the demo.\n</skill>\n\nnot a user message",
        "/skill:demo-skill",
        &[],
    );
    let texts = user_texts(&events);
    let row = texts
        .iter()
        .find(|text| text.starts_with("<skill"))
        .unwrap_or_else(|| panic!("the accepted row carries the expanded block: {texts:?}"));
    let parsed = pa_types::skill_blocks::parse_skill_block(row)
        .unwrap_or_else(|| panic!("the close-tagged body still parses: {row:?}"));
    assert_eq!(parsed.name, "demo-skill");
    assert!(
        row.ends_with(&format!(
            "\n\n{}",
            crate::agent_engine::lifecycle::BARE_SKILL_INVOCATION_INSTRUCTION
        )),
        "the bare invocation floors even when the body's own close-tag tail misparses: {row:?}"
    );
    assert_eq!(assistant_texts(&events), vec!["ok"]);
}
