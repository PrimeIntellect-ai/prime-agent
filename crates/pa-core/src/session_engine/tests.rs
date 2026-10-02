use super::*;
use pa_agent::agent::{AgentInitialState, AgentOptions};
use pa_agent::scripted::ScriptedProvider;

fn test_model() -> pa_agent::types::Model {
    serde_json::from_value(serde_json::json!({
        "id": "m", "name": "m", "api": "openai-completions", "provider": "test",
        "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 1000, "maxTokens": 100
    }))
    .unwrap()
}

async fn scripted_session() -> AgentSession {
    let provider = Arc::new(ScriptedProvider::new(test_model()));
    provider.push_text_turn("hello from the model");
    let options = AgentOptions {
        initial_state: AgentInitialState {
            model: Some(test_model()),
            ..Default::default()
        },
        stream_fn: Some(provider.stream_fn()),
        ..Default::default()
    };
    let agent = Agent::new(options);
    let tmp = tempfile::tempdir().unwrap();
    let session = SessionManager::in_memory(tmp.path());
    AgentSession::new(Arc::new(agent), session, vec![])
        .await
        .unwrap()
}

#[tokio::test]
async fn prompt_persists_user_and_assistant() {
    let session = scripted_session().await;
    session
        .prompt("hi there", PromptOptions::default())
        .await
        .unwrap();
    session.agent().wait_for_idle().await;
    let entries = session.entries().await;
    let roles: Vec<String> = entries
        .iter()
        .filter_map(|entry| match entry {
            FileEntry::Message {
                message: SessionAgentMessage::User(user),
                ..
            } => Some(format!("user:{}", user.content.text())),
            FileEntry::Message {
                message: SessionAgentMessage::Assistant(assistant),
                ..
            } => Some(format!("assistant:{}", assistant.model)),
            _ => None,
        })
        .collect();
    assert_eq!(
        roles,
        vec!["user:hi there".to_string(), "assistant:m".to_string()]
    );
}

#[tokio::test]
async fn a_skill_command_prompt_expands_into_the_skill_block() {
    // TS `_expandSkillCommand`: a `/skill:<name> [args]` submission
    // persists as the `<skill>` block plus the argument text; the
    // renderer parses that block back out (TS `parseSkillBlock`).
    let mut session = scripted_session().await;
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("SKILL.md");
    std::fs::write(&file_path, "---\nname: web-search\n---\nRun a web search.").unwrap();
    session.set_skills(vec![crate::skills::Skill {
        name: "web-search".to_string(),
        description: "search the web".to_string(),
        file_path: file_path.clone(),
        base_dir: dir.path().to_path_buf(),
        source_info: crate::skills::create_synthetic_source_info(
            &file_path.display().to_string(),
            "user",
            crate::skills::SourceScope::User,
            None,
        ),
        disable_model_invocation: false,
        kind: crate::skills::SkillKind::Markdown,
        python: None,
    }]);
    session
        .prompt("/skill:web-search find rust tuis", PromptOptions::default())
        .await
        .unwrap();
    session.agent().wait_for_idle().await;
    let entries = session.entries().await;
    let user_text = entries
        .iter()
        .find_map(|entry| match entry {
            FileEntry::Message {
                message: SessionAgentMessage::User(user),
                ..
            } => Some(user.content.text()),
            _ => None,
        })
        .expect("user message persisted");
    let parsed = pa_types::skill_blocks::parse_skill_block(&user_text)
        .expect("the persisted user message is a skill block");
    assert_eq!(parsed.name, "web-search");
    assert_eq!(
        parsed.user_message.as_deref(),
        Some("find rust tuis"),
        "args persist as the trailing user message"
    );
    assert!(parsed.content.contains("Run a web search."));
}

#[tokio::test]
async fn an_unknown_skill_command_passes_through() {
    let session = scripted_session().await;
    session
        .prompt("/skill:missing do a thing", PromptOptions::default())
        .await
        .unwrap();
    session.agent().wait_for_idle().await;
    let entries = session.entries().await;
    let user_text = entries
        .iter()
        .find_map(|entry| match entry {
            FileEntry::Message {
                message: SessionAgentMessage::User(user),
                ..
            } => Some(user.content.text()),
            _ => None,
        })
        .expect("user message persisted");
    assert_eq!(user_text, "/skill:missing do a thing");
}

/// A scripted session wired like the engine wires production sessions:
/// the engine-level `convert_to_llm` plus a harness-digest context, so
/// the deferred first-turn digest rides the first prompt.
async fn digest_session(provider: Arc<ScriptedProvider>) -> (AgentSession, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let harness = crate::session_engine::harness_digest::HarnessDigestContext {
        global_dir: tmp.path().join("harness"),
        local_dir: None,
        include_ipython: false,
        include_shell_examples: false,
        include_refine: false,
    };
    let session = digest_session_with_harness(provider, harness).await;
    (session, tmp)
}

async fn digest_session_with_harness(
    provider: Arc<ScriptedProvider>,
    harness: crate::session_engine::harness_digest::HarnessDigestContext,
) -> AgentSession {
    let agent = Agent::new(AgentOptions {
        initial_state: AgentInitialState {
            model: Some(test_model()),
            ..Default::default()
        },
        convert_to_llm: Some(crate::session_engine::messages::engine_convert_to_llm()),
        stream_fn: Some(provider.stream_fn()),
        ..Default::default()
    });
    let tmp = tempfile::tempdir().unwrap();
    AgentSession::from_session_arc(
        Arc::new(agent),
        Arc::new(tokio::sync::Mutex::new(SessionManager::in_memory(
            tmp.path(),
        ))),
        vec![],
        Some(harness),
    )
    .await
    .unwrap()
}

/// A resumed session over the entries of a prior session (the engine's
/// resume wiring: the loop context is the converted built context, the
/// manager adopts the same entries).
async fn resumed_digest_session(
    entries: Vec<FileEntry>,
    harness: crate::session_engine::harness_digest::HarnessDigestContext,
) -> AgentSession {
    let provider = Arc::new(ScriptedProvider::new(test_model()));
    let context = crate::session::build_session_context(&entries, None);
    let loop_messages: Vec<pa_agent::types::AgentMessage> =
        crate::session_engine::messages::convert_to_llm(&context.messages)
            .into_iter()
            .filter_map(|message| {
                serde_json::to_value(&message)
                    .ok()
                    .and_then(|value| serde_json::from_value(value).ok())
            })
            .collect();
    let agent = Agent::new(AgentOptions {
        initial_state: AgentInitialState {
            model: Some(test_model()),
            messages: Some(loop_messages),
            ..Default::default()
        },
        convert_to_llm: Some(crate::session_engine::messages::engine_convert_to_llm()),
        stream_fn: Some(provider.stream_fn()),
        ..Default::default()
    });
    let mut manager = SessionManager::in_memory(&std::env::temp_dir());
    manager.adopt_entries(entries);
    AgentSession::from_session_arc(
        Arc::new(agent),
        Arc::new(tokio::sync::Mutex::new(manager)),
        vec![],
        Some(harness),
    )
    .await
    .unwrap()
}

/// The digest rows in the live loop context (custom wire rows and the
/// user turns a rebuild converted) with their fingerprint, when known.
async fn loop_digest_rows(session: &AgentSession) -> Vec<(String, Option<String>)> {
    let state = session.agent().state().await;
    state
        .messages
        .iter()
        .filter_map(|message| {
            crate::session_engine::harness_digest::latest_context_digest_details(
                std::slice::from_ref(message),
            )
            .map(|details| (details.digest, details.state_fingerprint))
        })
        .collect()
}

/// TS #2400 + #2394 at the resume boundary: unchanged harness state
/// does not re-deliver a digest that drifted query terms made look
/// stale (the state fingerprint matches), and a state change
/// re-delivers exactly one digest, replacing the superseded copy
/// instead of stacking.
#[tokio::test]
async fn resume_dedupes_by_state_fingerprint_and_replaces_stale_digests() {
    let tmp = tempfile::tempdir().unwrap();
    let harness_dir = tmp.path().join("harness");
    // Seeded global state: entries whose ranked order differs once the
    // resume-time query terms mention one of them.
    let mut state = crate::refinement::empty_harness_state();
    for (id, title) in [
        ("alpha_relevant", "Alpha note"),
        ("middle_plain", "Middle plain note"),
        ("zeta_relevant", "Zeta note"),
    ] {
        state
            .entries
            .get_mut(&crate::refinement::RefinementKind::Memory)
            .unwrap()
            .insert(
                id.to_string(),
                crate::refinement::HarnessEntry {
                    id: id.to_string(),
                    kind: crate::refinement::RefinementKind::Memory,
                    title: title.to_string(),
                    content: format!("{title} about the worktree parity lane."),
                    path: "general".to_string(),
                    scope: Some(crate::refinement::HarnessScope::Global),
                    reference: serde_json::Map::default(),
                    arguments: serde_json::Map::default(),
                    metadata: serde_json::Map::default(),
                    source: "test".to_string(),
                    created_at: String::new(),
                    updated_at: String::new(),
                    version: 1,
                },
            );
    }
    crate::refinement::save_harness_state(&harness_dir, &state).unwrap();
    let harness = crate::session_engine::harness_digest::HarnessDigestContext {
        global_dir: harness_dir.clone(),
        local_dir: None,
        include_ipython: false,
        include_shell_examples: false,
        include_refine: false,
    };

    // First session: the deferred first-turn digest rides the turn and
    // persists (unranked: the pre-turn context has no task signal yet).
    let provider = Arc::new(ScriptedProvider::new(test_model()));
    provider.push_text_turn("noted");
    let session = digest_session_with_harness(Arc::clone(&provider), harness.clone()).await;
    session
        .prompt("hello alpha", PromptOptions::default())
        .await
        .unwrap();
    session.agent().wait_for_idle().await;
    let entries = session.entries().await;
    let digest_rows: Vec<&FileEntry> = entries
        .iter()
        .filter(|entry| {
            matches!(entry, FileEntry::CustomMessage { payload, .. }
                if payload.custom_type == crate::session_engine::headless::HARNESS_DIGEST_CUSTOM_TYPE)
        })
        .collect();
    assert_eq!(
        digest_rows.len(),
        1,
        "the first turn persisted one digest row"
    );
    let FileEntry::CustomMessage {
        payload: first_row, ..
    } = digest_rows[0]
    else {
        panic!("expected a digest custom entry");
    };
    let Some(first_fingerprint) = first_row
        .details
        .as_ref()
        .and_then(|details| details.get("stateFingerprint"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
    else {
        panic!("the persisted digest row carries its state fingerprint");
    };

    // Resume over the same entries (converted loop context, adopted
    // manager): the fresh render ranks `alpha_relevant` first because
    // the context's task signal mentions it, so only the state
    // fingerprint can dedupe. The unchanged state must NOT re-deliver.
    let resumed = resumed_digest_session(entries.clone(), harness.clone()).await;
    let rows = loop_digest_rows(&resumed).await;
    assert_eq!(
        rows,
        vec![(
            // The converted user frame carries no fingerprint of its
            // own; the recovery view is exercised by the no-append.
            digest_of_entries(&entries),
            None
        )],
        "an unchanged state must not re-deliver at the resume boundary"
    );

    // Changed disk state: the fingerprint moves, so the boundary
    // re-delivers — and the fresh row replaces the superseded copy
    // instead of stacking (TS #2394).
    state
        .entries
        .get_mut(&crate::refinement::RefinementKind::Memory)
        .unwrap()
        .insert(
            "resume_test_memory".to_string(),
            crate::refinement::HarnessEntry {
                id: "resume_test_memory".to_string(),
                kind: crate::refinement::RefinementKind::Memory,
                title: "Resume test memory".to_string(),
                content: "Written between resumes.".to_string(),
                path: "general".to_string(),
                scope: Some(crate::refinement::HarnessScope::Global),
                reference: serde_json::Map::default(),
                arguments: serde_json::Map::default(),
                metadata: serde_json::Map::default(),
                source: "test".to_string(),
                created_at: String::new(),
                updated_at: String::new(),
                version: 1,
            },
        );
    crate::refinement::save_harness_state(&harness_dir, &state).unwrap();
    let refreshed = resumed_digest_session(entries.clone(), harness).await;
    let rows = loop_digest_rows(&refreshed).await;
    assert_eq!(rows.len(), 1, "the fresh digest replaces the old copy");
    assert!(
        rows[0].1.is_some(),
        "the delivered custom row carries its state fingerprint"
    );
    assert!(rows[0].0.contains("Resume test memory"));
    // The delivered row persisted with its fingerprint. The persisted
    // transcript keeps every copy (TS #2394: the newest digest remains
    // authoritative), so the retained row plus the fresh one ride the
    // file while the live context carries exactly one.
    let persisted: Vec<String> = refreshed
        .entries()
        .await
        .iter()
        .filter_map(|entry| match entry {
            FileEntry::CustomMessage { payload, .. }
                if payload.custom_type
                    == crate::session_engine::headless::HARNESS_DIGEST_CUSTOM_TYPE =>
            {
                payload
                    .details
                    .as_ref()
                    .and_then(|details| details.get("stateFingerprint"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            }
            _ => None,
        })
        .collect();
    assert_eq!(persisted.len(), 2);
    assert_eq!(persisted[0], first_fingerprint);
    assert_ne!(persisted[1], first_fingerprint);
    assert_eq!(Some(persisted[1].as_str()), rows[0].1.as_deref());
}

/// The digest body of the newest digest custom entry (fixture lookup).
fn digest_of_entries(entries: &[FileEntry]) -> String {
    entries
        .iter()
        .rev()
        .find_map(|entry| match entry {
            FileEntry::CustomMessage { payload, .. }
                if payload.custom_type
                    == crate::session_engine::headless::HARNESS_DIGEST_CUSTOM_TYPE =>
            {
                payload
                    .details
                    .as_ref()
                    .and_then(|details| details.get("digest"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            }
            _ => None,
        })
        .expect("a digest custom entry")
}

fn user_text(message: &pa_agent::types::Message) -> String {
    let pa_agent::types::Message::User(user) = message else {
        panic!("expected user message");
    };
    match &user.content {
        pa_agent::types::UserContent::Text(text) => text.clone(),
        pa_agent::types::UserContent::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                pa_agent::types::UserPart::Text(text) => Some(text.text.clone()),
                pa_agent::types::UserPart::Image(_) => None,
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

#[tokio::test]
async fn prompt_rides_digest_row_into_the_run() {
    let provider = Arc::new(ScriptedProvider::new(test_model()));
    provider.push_text_turn("hello from the model");
    provider.push_text_turn("second answer");
    let (session, _tmp) = digest_session(Arc::clone(&provider)).await;
    let events: Arc<std::sync::Mutex<Vec<AgentEvent>>> = Arc::default();
    let sink = Arc::clone(&events);
    session
        .agent()
        .subscribe(move |event, _signal| {
            let sink = Arc::clone(&sink);
            Box::pin(async move {
                sink.lock().unwrap().push(event);
                Ok(())
            })
        })
        .await;
    session
        .prompt("hi there", PromptOptions::default())
        .await
        .unwrap();
    session.agent().wait_for_idle().await;

    // The run's agent_end carries the digest custom row with the turn's
    // prompt messages (TS parity: the digest rides `agent_end.messages`).
    // The lock snapshots the captured events and never crosses an await.
    let (end_messages, kinds) = {
        let captured = events.lock().unwrap();
        let Some(AgentEvent::AgentEnd { messages }) = captured
            .iter()
            .rev()
            .find(|event| matches!(event, AgentEvent::AgentEnd { .. }))
        else {
            panic!("no agent_end event");
        };
        let kinds: Vec<String> = captured
            .iter()
            .filter_map(|event| match event {
                AgentEvent::TurnStart => Some("turn_start".to_string()),
                AgentEvent::MessageStart { message } | AgentEvent::MessageEnd { message } => {
                    Some(message.role().to_string())
                }
                _ => None,
            })
            .collect();
        (messages.clone(), kinds)
    };
    let roles: Vec<&str> = end_messages
        .iter()
        .map(pa_agent::types::AgentMessage::role)
        .collect();
    assert_eq!(roles, vec!["custom", "user", "assistant"]);
    let AgentMessage::Custom(custom) = &end_messages[0] else {
        panic!("expected digest custom row");
    };
    assert_eq!(
        custom
            .payload
            .get("customType")
            .and_then(serde_json::Value::as_str),
        Some(crate::session_engine::headless::HARNESS_DIGEST_CUSTOM_TYPE)
    );
    // The message pair streamed ahead of the user prompt's pair.
    assert_eq!(
        kinds,
        vec![
            "turn_start",
            "custom",
            "custom",
            "user",
            "user",
            "assistant",
            "assistant"
        ]
    );

    // The provider request carries the digest as a user turn ahead of
    // the prompt (the engine-level conversion at the LLM boundary).
    let calls = provider.calls();
    assert_eq!(calls.len(), 1);
    assert!(user_text(&calls[0].messages[0]).contains("[harness-digest]"));
    assert_eq!(user_text(&calls[0].messages[1]), "hi there");

    // The digest persisted exactly once (the loop's message_end), ahead
    // of the user row.
    let entries = session.entries().await;
    let digest_rows = entries
        .iter()
        .filter(|entry| {
            matches!(entry, FileEntry::CustomMessage { payload, .. }
                if payload.custom_type
                    == crate::session_engine::headless::HARNESS_DIGEST_CUSTOM_TYPE)
        })
        .count();
    assert_eq!(digest_rows, 1);

    // The second prompt does not re-deliver: the flag is consumed and the
    // delivered row is the newest in-context digest.
    session
        .prompt("again", PromptOptions::default())
        .await
        .unwrap();
    session.agent().wait_for_idle().await;
    let calls = provider.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(user_text(calls[1].messages.last().unwrap()), "again");
    // The second run's agent_end carries no digest row.
    let second_end_roles: Vec<String> = {
        let captured = events.lock().unwrap();
        captured
            .iter()
            .rev()
            .find_map(|event| match event {
                AgentEvent::AgentEnd { messages } => Some(
                    messages
                        .iter()
                        .map(|message| message.role().to_string())
                        .collect::<Vec<String>>(),
                ),
                _ => None,
            })
            .expect("no second agent_end event")
    };
    assert_eq!(second_end_roles, vec!["user", "assistant"]);
    let entries = session.entries().await;
    let digest_rows = entries
        .iter()
        .filter(|entry| {
            matches!(entry, FileEntry::CustomMessage { payload, .. }
                if payload.custom_type
                    == crate::session_engine::headless::HARNESS_DIGEST_CUSTOM_TYPE)
        })
        .count();
    assert_eq!(digest_rows, 1);
}

/// An injected custom message admits as the turn's prompt (TS
/// `_promptInjectedMessage` -> `agent.prompt([customMessage])`): the
/// transcript and the loop context hold ONE representation of the
/// turn — the custom row, appended once by the loop's `message_end`
/// — and the provider request carries the row's user-role view (the
/// loop-boundary conversion), never a duplicate user message.
#[tokio::test]
async fn prompt_injected_message_persists_one_custom_row() {
    let provider = Arc::new(ScriptedProvider::new(test_model()));
    provider.push_text_turn("notice acknowledged");
    let (session, _tmp) = digest_session(Arc::clone(&provider)).await;
    let notice_text = "[child-exited: no-reply child:lane]";
    let notice = pa_types::session::CustomMessage {
        custom_type: "rlm_child_terminal_notice".to_string(),
        content: pa_types::ai::UserContent::Text(notice_text.to_string()),
        display: true,
        details: Some(serde_json::json!({
            "kind": "completed_without_reply",
            "childId": "sub-1",
            "sessionName": "lane",
        })),
        timestamp: 0,
        rest: serde_json::Map::default(),
    };
    session.prompt_injected_message(&notice).await.unwrap();
    session.agent().wait_for_idle().await;

    // The provider request carries the notice text as its user-role
    // view — once, with no duplicate user message (TS `convertToLlm`
    // at the loop boundary). The first-turn harness digest rides
    // ahead of it (TS commit-time injection), exactly like a plain
    // prompt's request.
    let calls = provider.calls();
    assert_eq!(calls.len(), 1);
    let user_texts: Vec<String> = calls[0]
        .messages
        .iter()
        .filter(|message| matches!(message, pa_agent::types::Message::User(_)))
        .map(user_text)
        .collect();
    assert_eq!(user_texts.len(), 2, "digest plus notice: {calls:?}");
    assert_eq!(user_texts[1], notice_text);
    assert_eq!(
        user_texts
            .iter()
            .filter(|text| *text == notice_text)
            .count(),
        1,
        "no duplicate user message: {calls:?}"
    );

    // One representation in the transcript: the custom row, exactly
    // once, and no user row with the same text.
    let entries = session.entries().await;
    let notice_rows = entries
        .iter()
        .filter(|entry| match entry {
            FileEntry::CustomMessage { payload, .. } => {
                payload.custom_type == "rlm_child_terminal_notice"
            }
            _ => false,
        })
        .count();
    assert_eq!(notice_rows, 1);
    let user_rows = entries
        .iter()
        .filter(|entry| match entry {
            FileEntry::Message {
                message: SessionAgentMessage::User(user),
                ..
            } => user.content.text().contains(notice_text),
            _ => false,
        })
        .count();
    assert_eq!(
        user_rows, 0,
        "the injected turn must not persist a user row"
    );
}

/// A delivered agent message's custom row produces the byte-identical
/// provider context to the plain-prompt delivery (TS
/// `acceptAgentMessagePrompt`: the custom message replaces the turn's
/// user row while its prompt content still runs the model). The
/// comparison covers the whole request - system prompt, tools, and
/// every message row - with only the per-run timestamps normalized.
#[tokio::test]
async fn an_agent_message_custom_row_matches_the_plain_prompt_context() {
    let prompt = "[agent-message from child:research-lane]\n\nthe research is done";

    // The plain delivery: the prompt text as the accepted user row.
    let plain_provider = Arc::new(ScriptedProvider::new(test_model()));
    plain_provider.push_text_turn("ack");
    let (plain_session, _plain_tmp) = digest_session(Arc::clone(&plain_provider)).await;
    plain_session
        .prompt(prompt, PromptOptions::default())
        .await
        .unwrap();
    plain_session.agent().wait_for_idle().await;

    // The delivered shape: the `agent_message` custom row whose content
    // is the same prompt (TS `createAgentSessionMessage`).
    let row_provider = Arc::new(ScriptedProvider::new(test_model()));
    row_provider.push_text_turn("ack");
    let (row_session, _row_tmp) = digest_session(Arc::clone(&row_provider)).await;
    let row = pa_types::session::CustomMessage {
        custom_type: crate::session_engine::agent_messaging::AGENT_MESSAGE_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(prompt.to_string()),
        display: true,
        details: Some(serde_json::json!({
            "id": "agentmsg_golden",
            "message": "the research is done",
            "from": {
                "activeSessionId": "child-1",
                "sessionName": "research-lane",
            },
            "fromRelationship": "child",
            "target": { "activeSessionId": "parent-1" },
        })),
        timestamp: 0,
        rest: serde_json::Map::default(),
    };
    row_session.prompt_injected_message(&row).await.unwrap();
    row_session.agent().wait_for_idle().await;

    let plain_calls = plain_provider.calls();
    let row_calls = row_provider.calls();
    assert_eq!(plain_calls.len(), 1);
    assert_eq!(row_calls.len(), 1);
    assert_eq!(
        normalized_context(&plain_calls[0]),
        normalized_context(&row_calls[0]),
        "the agent_message row must not change the provider request"
    );
}

/// The provider request with the per-run message timestamps zeroed
/// (each delivery mints its own runtime stamp; every other byte is
/// compared).
fn normalized_context(context: &pa_agent::stream::LlmContext) -> serde_json::Value {
    let mut value = serde_json::to_value(context).unwrap();
    for message in value["messages"].as_array_mut().unwrap() {
        if let Some(timestamp) = message.get_mut("timestamp") {
            *timestamp = serde_json::json!(0);
        }
    }
    value
}

#[tokio::test]
async fn prompt_persists_tool_results() {
    struct EchoTool;
    impl pa_agent::types::AgentTool for EchoTool {
        fn name(&self) -> &'static str {
            "echo"
        }
        fn description(&self) -> &'static str {
            "echo the call"
        }
        fn parameters(&self) -> &serde_json::Value {
            static PARAMETERS: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
            PARAMETERS.get_or_init(|| serde_json::json!({ "type": "object" }))
        }
        fn execute(
            self: Arc<Self>,
            _tool_call_id: String,
            _params: serde_json::Value,
            _signal: pa_agent::abort::AbortSignal,
            _on_update: pa_agent::types::AgentToolUpdateCallback,
        ) -> pa_agent::BoxFut<'static, anyhow::Result<pa_agent::types::AgentToolResult>> {
            Box::pin(async { Ok(pa_agent::types::AgentToolResult::text("tool output")) })
        }
    }
    let provider = Arc::new(ScriptedProvider::new(test_model()));
    provider.push_tool_call_turn(
        Some("calling"),
        vec![("call-1", "echo", serde_json::json!({}))],
    );
    provider.push_text_turn("done");
    let options = AgentOptions {
        initial_state: AgentInitialState {
            model: Some(test_model()),
            ..Default::default()
        },
        stream_fn: Some(provider.stream_fn()),
        ..Default::default()
    };
    let agent = Agent::new(options);
    agent.set_tools(vec![Arc::new(EchoTool)]).await;
    let tmp = tempfile::tempdir().unwrap();
    let session = SessionManager::persisted(std::path::Path::new("/w"), tmp.path());
    let engine = AgentSession::new(Arc::new(agent), session, vec![])
        .await
        .unwrap();
    engine.prompt("hi", PromptOptions::default()).await.unwrap();
    engine.agent().wait_for_idle().await;
    let entries = engine.entries().await;
    let roles: Vec<&str> = entries
        .iter()
        .filter_map(|entry| match entry {
            FileEntry::Message { message, .. } => Some(match message {
                SessionAgentMessage::User(_) => "user",
                SessionAgentMessage::Assistant(_) => "assistant",
                SessionAgentMessage::ToolResult(_) => "toolResult",
                _ => "other",
            }),
            _ => None,
        })
        .collect();
    assert_eq!(
        roles,
        vec!["user", "assistant", "toolResult", "assistant"],
        "entries: {entries:?}"
    );
    let tool_result = entries
        .iter()
        .find_map(|entry| match entry {
            FileEntry::Message {
                message: SessionAgentMessage::ToolResult(result),
                ..
            } => Some(result.clone()),
            _ => None,
        })
        .expect("toolResult entry persisted");
    // Whole-object compare through the TS wire shape (timestamp is
    // turn-dependent and asserted only by type).
    let value = serde_json::to_value(SessionAgentMessage::ToolResult(tool_result)).unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "role": "toolResult",
            "toolCallId": "call-1",
            "toolName": "echo",
            "content": [{ "type": "text", "text": "tool output" }],
            "isError": false,
            "timestamp": value["timestamp"],
        })
    );
    // The persisted file line carries the live-TS entry envelope: the
    // message under `message`, chained to its assistant parent.
    let file = tmp
        .path()
        .join(format!("{}.jsonl", engine.session_id().await))
        .to_string_lossy()
        .to_string();
    let lines: Vec<serde_json::Value> = std::fs::read_to_string(file)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let entry = lines
        .iter()
        .find(|entry| {
            entry.get("message").and_then(|m| m.get("role"))
                == Some(&serde_json::json!("toolResult"))
        })
        .expect("toolResult entry on disk");
    assert_eq!(entry["type"], "message");
    assert_eq!(entry["message"]["toolCallId"], "call-1");
    assert_eq!(entry["message"]["content"][0]["text"], "tool output");
    assert_eq!(entry["message"]["isError"], false);
    assert!(entry["id"].as_str().is_some_and(|id| id.len() == 8));
    assert!(entry["parentId"].as_str().is_some());
    assert!(entry["timestamp"].as_str().is_some());
}

/// A `toolResult` entry captured from a live TS session (read-only, from
/// the installed product's own session store) parses into the Rust
/// session types and re-serializes to the identical wire shape.
#[test]
fn ts_toolresult_entry_round_trips() {
    let golden: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/golden/corpus/toolresult-entry-live-ts.json"
    ))
    .unwrap();
    let entry: FileEntry = serde_json::from_value(golden.clone()).unwrap();
    let FileEntry::Message {
        message: SessionAgentMessage::ToolResult(tool_result),
        base,
    } = &entry
    else {
        panic!("golden entry is not a toolResult message: {entry:?}");
    };
    assert_eq!(tool_result.tool_name, "ipython");
    assert_eq!(
        tool_result.tool_call_id,
        "c2425715-419e-4d06-a101-a78da1969b96"
    );
    assert!(!tool_result.is_error);
    assert_eq!(base.id.clone().unwrap_or_default().len(), 8);
    assert_eq!(base.parent_id.as_deref(), Some("8902561b"));
    // The ipython `details` block survives the round trip intact.
    assert_eq!(
        tool_result.details,
        Some(serde_json::json!({
            "durationMs": 10,
            "status": "ok",
            "stdout": "/root/prime-agent-rs\n['.git', 'MISSION.md', 'README.md', 'WATCHDOG.md']\nTrue\n",
            "stderr": "",
            "kernelRestarted": false
        }))
    );
    // Re-serialization is byte-identical (stable wire shape).
    let serialized = serde_json::to_value(&entry).unwrap();
    assert_eq!(serialized, golden);
}

#[tokio::test]
async fn template_expansion_applies() {
    let provider = Arc::new(ScriptedProvider::new(test_model()));
    provider.push_text_turn("ok");
    let options = AgentOptions {
        initial_state: AgentInitialState {
            model: Some(test_model()),
            ..Default::default()
        },
        stream_fn: Some(provider.stream_fn()),
        ..Default::default()
    };
    let agent = Agent::new(options);
    let tmp = tempfile::tempdir().unwrap();
    let session = SessionManager::in_memory(tmp.path());
    let template = PromptTemplate {
        name: "fix".to_string(),
        description: "fix".to_string(),
        argument_hint: None,
        content: "Fix $1 please".to_string(),
        source_info: crate::skills::create_synthetic_source_info(
            "/p",
            "local",
            crate::skills::SourceScope::User,
            None,
        ),
        file_path: "/p/fix.md".to_string(),
    };
    let engine = AgentSession::new(Arc::new(agent), session, vec![template])
        .await
        .unwrap();
    engine
        .prompt("/fix lint", PromptOptions::default())
        .await
        .unwrap();
    engine.agent().wait_for_idle().await;
    let entries = engine.entries().await;
    let user_text = entries
        .iter()
        .find_map(|entry| match entry {
            FileEntry::Message {
                message: SessionAgentMessage::User(user),
                ..
            } => Some(user.content.text()),
            _ => None,
        })
        .unwrap();
    assert_eq!(user_text, "Fix lint please");
}

/// Git state is captured at both run boundaries (the TS run-boundary event
/// path calls `recordGitStateIfChanged` on `agent_start`/`agent_end`): a commit
/// made between session creation and the run lands as a `git_state` entry, a
/// branch switch between turns is recorded by the next run, and an unchanged
/// context at `agent_end` adds nothing.
#[tokio::test]
async fn run_boundaries_record_git_state() {
    fn git(cwd: &std::path::Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git is available in the test environment");
        assert!(output.status.success(), "git {args:?} failed");
    }
    fn commit(dir: &std::path::Path, message: &str) -> String {
        std::fs::write(dir.join("file.txt"), format!("{message}\n")).unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", message]);
        let output = std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(dir)
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    let repo = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-q", "-b", "main"]);
    git(repo.path(), &["config", "user.email", "t@t.co"]);
    git(repo.path(), &["config", "user.name", "t"]);
    commit(repo.path(), "init");

    let provider = Arc::new(ScriptedProvider::new(test_model()));
    provider.push_text_turn("ok");
    let options = AgentOptions {
        initial_state: AgentInitialState {
            model: Some(test_model()),
            ..Default::default()
        },
        stream_fn: Some(provider.stream_fn()),
        ..Default::default()
    };
    let agent = Agent::new(options);
    let session = SessionManager::persisted(repo.path(), sessions.path());
    let engine = AgentSession::new(Arc::new(agent), session, vec![])
        .await
        .unwrap();

    // The run starts on a newer commit than the header captured.
    let second_sha = commit(repo.path(), "second");
    engine.prompt("hi", PromptOptions::default()).await.unwrap();
    engine.agent().wait_for_idle().await;

    git(repo.path(), &["checkout", "-q", "-b", "feature"]);
    provider.push_text_turn("ok");
    engine
        .prompt("again", PromptOptions::default())
        .await
        .unwrap();
    engine.agent().wait_for_idle().await;

    let entries = engine.entries().await;
    let git_states: Vec<_> = entries
        .iter()
        .filter_map(|entry| match entry {
            FileEntry::GitState { payload, .. } => Some(payload.git.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        git_states,
        vec![
            pa_types::session::GitContext {
                repo_url: None,
                commit: Some(second_sha.clone()),
                branch: Some("main".to_string()),
            },
            pa_types::session::GitContext {
                repo_url: None,
                commit: Some(second_sha),
                branch: Some("feature".to_string()),
            },
        ]
    );
}
