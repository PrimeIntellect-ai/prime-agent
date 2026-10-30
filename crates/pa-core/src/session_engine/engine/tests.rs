//! The engine unit battery: the scripted tool loop, the child-depth
//! stamp, the MCP-gating unlock, and the goal/heartbeat handler
//! registration.
use super::*;
use crate::session_engine::tool_bridge::{bridge_tool, ToolDefinitionBridge};
use crate::tools::tool_definition::{ExecutionMode, ToolDefinition, ToolExecutionResult};
use pa_agent::scripted::ScriptedProvider;

fn echo_definition() -> ToolDefinition {
    ToolDefinition {
        name: "echo".to_string(),
        label: "Echo".to_string(),
        description: "Echoes its input".to_string(),
        prompt_snippet: String::new(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": { "text": { "type": "string" } },
            "required": ["text"]
        }),
        execution_mode: Some(ExecutionMode::Sequential),
        prepare_arguments: None,
        execute: Arc::new(|_id, params, _signal, _on_update| {
            let text = params
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or_default()
                .to_string();
            Box::pin(async move { Ok(ToolExecutionResult::text(format!("echo: {text}"))) })
        }),
    }
}

#[tokio::test]
async fn engine_runs_tool_loop_and_persists() {
    let model = pa_agent::types::Model {
        id: "m".into(),
        name: "m".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: "http://localhost".into(),
        reasoning: false,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 1_000,
        max_tokens: 100,
        max_tokens_explicit: false,
    };
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    provider.push_tool_call_turn(
        Some("checking"),
        vec![("call-1", "echo", serde_json::json!({ "text": "hi" }))],
    );
    provider.push_text_turn("all done");

    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    // Every request of the session carries the session's identity (#3618: the
    // Codex prompt cache key, session headers, and WebSocket reuse key on it).
    let observed_ids: Arc<std::sync::Mutex<Vec<Option<String>>>> = Arc::default();
    let capture_ids = Arc::clone(&observed_ids);
    let inner_stream = provider.stream_fn();
    let stream: pa_agent::stream::StreamFn = Arc::new(move |model, context, options| {
        capture_ids.lock().unwrap().push(options.session_id.clone());
        inner_stream(model, context, options)
    });
    let engine = create_session(SessionEngineConfig {
        on_late_sent_agent_message: None,
        semantic_edges: None,
        cron_store: None,
        queued_steering_probe: None,
        should_stop_after_turn: None,
        image_model_router: None,
        steering_mode: None,
        follow_up_mode: None,
        cwd: cwd.clone(),
        agent_dir: tmp.path().join("agent"),
        mcp_manager: None,
        model: Some(model),
        thinking_level: None,
        stream_fn: Some(stream),
        tools: vec![bridge_tool(echo_definition())],
        custom_system_prompt: None,
        prompt_guidelines: vec![],
        generic_mcp_servers: vec![],
        allow_recursion: None,
        session_manager: None,
        extra_host_handlers: None,
        conversation_log_path: None,
        additional_skill_paths: vec![],
        additional_prompt_paths: vec![],
        extra_builtin_skill_overrides: vec![],
        rlm_subagent_host: None,
        rlm_usage_store: None,

        inbox: None,
        progress_note_emit: None,
        rlm_depth: None,
        daemonless: true,
        telemetry: None,
        model_info: None,
        on_background_work_settled: None,
        bash_notice_wake: None,
        prewarm_ipython_kernel: None,
        queued_goal_context_purge: None,
    })
    .await
    .unwrap();

    // The system prompt is the layered assembly: static core layer
    // first, dynamic tail after.
    assert!(engine.system_prompt.starts_with("# prime-agent harness"));
    assert!(engine
        .system_prompt
        .contains("Recursive agent depth: 0 (root)"));

    let outcome = engine
        .prompt("run the echo tool", PromptOptions::default())
        .await
        .unwrap();
    assert_eq!(outcome, PromptOutcome::Prompt);
    engine.session.agent().wait_for_idle().await;

    let expected_session_id = engine.session.session_id().await;
    assert_eq!(
        *observed_ids.lock().unwrap(),
        vec![Some(expected_session_id); 2]
    );
    let state = engine.session.agent().state().await;
    assert!(state.messages.iter().any(|message| match message {
        pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::ToolResult(result)) => {
            result.tool_name == "echo"
        }
        _ => false,
    }));
    assert!(state.messages.iter().any(|message| match message {
        pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::Assistant(assistant)) => {
            assistant.content.iter().any(|block| {
                matches!(
                    block,
                    pa_agent::types::AssistantContent::Text(text) if text.text == "all done"
                )
            })
        }
        _ => false,
    }));
    let entries = engine.session.entries().await;
    assert!(entries.iter().any(|entry| matches!(
        entry,
        pa_types::session::FileEntry::Message {
            message: pa_types::session::AgentMessage::User(user),
            ..
        } if user.content.text() == "run the echo tool"
    )));
    let _ = ToolDefinitionBridge::new;
}

/// A spawned child's prompt stamps its recursion depth: `create_session`
/// at depth N reads "depth: N (not root)", never the root identity.
#[tokio::test]
async fn spawned_child_prompt_stamps_its_depth() {
    let model = pa_agent::types::Model {
        id: "m".into(),
        name: "m".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: "http://localhost".into(),
        reasoning: false,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 1_000,
        max_tokens: 100,
        max_tokens_explicit: false,
    };
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let engine = create_session(SessionEngineConfig {
        on_late_sent_agent_message: None,
        semantic_edges: None,
        cron_store: None,
        queued_steering_probe: None,
        should_stop_after_turn: None,
        image_model_router: None,
        steering_mode: None,
        follow_up_mode: None,
        cwd: cwd.clone(),
        agent_dir: tmp.path().join("agent"),
        mcp_manager: None,
        model: Some(model),
        thinking_level: None,
        stream_fn: Some(provider.stream_fn()),
        tools: vec![bridge_tool(echo_definition())],
        custom_system_prompt: None,
        prompt_guidelines: vec![],
        generic_mcp_servers: vec![],
        allow_recursion: None,
        session_manager: None,
        extra_host_handlers: None,
        conversation_log_path: None,
        additional_skill_paths: vec![],
        additional_prompt_paths: vec![],
        extra_builtin_skill_overrides: vec![],
        rlm_subagent_host: None,
        rlm_usage_store: None,

        inbox: None,
        progress_note_emit: None,
        rlm_depth: Some(2),
        daemonless: true,
        telemetry: None,
        model_info: None,
        on_background_work_settled: None,
        bash_notice_wake: None,
        prewarm_ipython_kernel: None,
        queued_goal_context_purge: None,
    })
    .await
    .unwrap();

    assert!(engine
        .system_prompt
        .contains("Recursive agent depth: 2 (not root)"));
    assert!(!engine.system_prompt.contains("depth: 0 (root)"));
}

/// The login chain's prompt-gating end to end: a settings-declared OAuth
/// server stays gated, an endpoint-bound credential unlocks it in the NEXT
/// session, and one bound to another endpoint does not.
#[tokio::test]
async fn oauth_creds_unlock_generic_mcp_gating_in_new_sessions() {
    fn model() -> pa_agent::types::Model {
        pa_agent::types::Model {
            id: "m".into(),
            name: "m".into(),
            api: "test".into(),
            provider: "test".into(),
            base_url: "http://localhost".into(),
            reasoning: false,
            cost: pa_agent::types::UsageCost::default(),
            context_window: 1_000,
            max_tokens: 100,
            max_tokens_explicit: false,
        }
    }

    fn config(
        cwd: &std::path::Path,
        agent_dir: &std::path::Path,
        stream_fn: pa_agent::stream::StreamFn,
    ) -> SessionEngineConfig {
        SessionEngineConfig {
            on_late_sent_agent_message: None,
            semantic_edges: None,
            cron_store: None,
            queued_steering_probe: None,
            should_stop_after_turn: None,
            image_model_router: None,
            steering_mode: None,
            follow_up_mode: None,
            cwd: cwd.to_path_buf(),
            agent_dir: agent_dir.to_path_buf(),
            mcp_manager: None,
            model: Some(model()),
            thinking_level: None,
            stream_fn: Some(stream_fn),
            tools: vec![],
            custom_system_prompt: None,
            prompt_guidelines: vec![],
            generic_mcp_servers: vec![],
            allow_recursion: None,
            session_manager: None,
            extra_host_handlers: None,
            conversation_log_path: None,
            additional_skill_paths: vec![],
            additional_prompt_paths: vec![],
            extra_builtin_skill_overrides: vec![],
            rlm_subagent_host: None,
            rlm_usage_store: None,

            inbox: None,
            progress_note_emit: None,
            rlm_depth: None,
            daemonless: true,
            telemetry: None,
            model_info: None,
            on_background_work_settled: None,
            bash_notice_wake: None,
            prewarm_ipython_kernel: None,
            queued_goal_context_purge: None,
        }
    }

    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("project");
    let agent_dir = tmp.path().join("agent");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&agent_dir).unwrap();
    // The settings declaration the daemon worker's MCP manager also
    // resolves (an OAuth HTTP server, like `mcp add ... --oauth`).
    std::fs::write(
        agent_dir.join("settings.json"),
        serde_json::json!({
            "mcpServers": {
                "fixture-oauth": {
                    "type": "http",
                    "url": "https://fixture.example/mcp",
                    "oauth": true,
                },
            },
        })
        .to_string(),
    )
    .unwrap();
    let provider = Arc::new(ScriptedProvider::new(model()));

    let engine = create_session(config(&cwd, &agent_dir, provider.stream_fn()))
        .await
        .unwrap();
    assert!(!engine.system_prompt.contains("# Generic MCP Connections"));

    // The persisted credential begin_login leaves behind (the TS
    // McpCredentials shape, endpoint-bound).
    let write_credential = |endpoint: &str| {
        std::fs::write(
            agent_dir.join("auth.json"),
            serde_json::json!({
                "mcp:fixture-oauth": {
                    "type": "oauth",
                    "access": "fixture-access",
                    "refresh": "fixture-refresh",
                    "expires": 999_999_999_999_999_i64,
                    "endpoint": endpoint,
                    "tokenEndpoint": "https://fixture.example/token",
                    "clientId": "fixture-client",
                },
            })
            .to_string(),
        )
        .unwrap();
    };

    // A credential bound to another endpoint stays gated: the token
    // must prove where it belongs.
    write_credential("https://other.example/mcp");
    let engine = create_session(config(&cwd, &agent_dir, provider.stream_fn()))
        .await
        .unwrap();
    assert!(!engine.system_prompt.contains("# Generic MCP Connections"));

    write_credential("https://fixture.example/mcp");
    let engine = create_session(config(&cwd, &agent_dir, provider.stream_fn()))
        .await
        .unwrap();
    assert!(engine.system_prompt.contains("# Generic MCP Connections"));
    assert!(engine.system_prompt.contains("`fixture-oauth`"));
}

#[tokio::test]
async fn create_session_registers_the_kernel_backed_tools_without_cron_wiring() {
    let dir = tempfile::TempDir::new().unwrap();
    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            models: Some(vec![pa_ai::faux::FauxModelDefinition {
                id: "faux-1".to_string(),
                name: Some("Faux".to_string()),
                reasoning: Some(false),
                input: Some(vec![pa_types::ai::ModelInput::Text]),
                cost: None,
                context_window: Some(100_000),
                max_tokens: Some(4_096),
            }]),
            ..Default::default()
        });
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
        pa_ai::faux::faux_assistant_text_message(
            "ok",
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        ),
    )]);
    let model = registration.get_model();
    let agent_model = crate::session_engine::provider_adapter::json_round_trip(&model).unwrap();
    let stream_fn = crate::session_engine::provider_adapter::real_stream_fn(None, model.clone());
    let engine = create_session(SessionEngineConfig {
        cron_store: None,
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().to_path_buf(),
        model: Some(agent_model),
        stream_fn: Some(stream_fn),
        tools: Vec::new(),
        ..Default::default()
    })
    .await
    .unwrap();
    let names: Vec<String> = engine
        .session
        .agent()
        .state()
        .await
        .tools
        .iter()
        .map(|tool| tool.name().to_string())
        .collect();
    assert!(
        names.iter().any(|name| name == "python_repl"),
        "tools: {names:?}"
    );
}

/// A daemon-shaped resume: an in-memory session manager (the daemon's
/// non-persisted engine session) already holding a message, plus a
/// `conversation_log_path`, still auto-appends the missing
/// thinking-level and service-tier rows (#3350's gate regression).
#[tokio::test]
async fn create_session_appends_missing_resume_settings_rows() {
    let model = pa_agent::types::Model {
        id: "m".into(),
        name: "m".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: "http://localhost".into(),
        reasoning: false,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 1_000,
        max_tokens: 100,
        max_tokens_explicit: false,
    };
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let mut session_manager =
        crate::session::manager::SessionManager::in_memory_in_session_dir(&cwd, tmp.path());
    session_manager
        .append_message(pa_types::session::AgentMessage::User(
            pa_types::ai::UserMessage {
                content: pa_types::ai::UserContent::Text("resumed".into()),
                timestamp: 0,
                rest: serde_json::Map::default(),
            },
        ))
        .unwrap();
    let engine = create_session(SessionEngineConfig {
        on_late_sent_agent_message: None,
        semantic_edges: None,
        cron_store: None,
        queued_steering_probe: None,
        should_stop_after_turn: None,
        image_model_router: None,
        steering_mode: None,
        follow_up_mode: None,
        cwd: cwd.clone(),
        agent_dir: tmp.path().join("agent"),
        mcp_manager: None,
        model: Some(model),
        thinking_level: None,
        stream_fn: Some(provider.stream_fn()),
        tools: vec![],
        custom_system_prompt: None,
        prompt_guidelines: vec![],
        generic_mcp_servers: vec![],
        allow_recursion: None,
        session_manager: Some(session_manager),
        extra_host_handlers: None,
        conversation_log_path: Some(tmp.path().join("session.jsonl")),
        additional_skill_paths: vec![],
        additional_prompt_paths: vec![],
        extra_builtin_skill_overrides: vec![],
        rlm_subagent_host: None,
        rlm_usage_store: None,

        inbox: None,
        progress_note_emit: None,
        rlm_depth: None,
        daemonless: true,
        telemetry: None,
        model_info: None,
        on_background_work_settled: None,
        bash_notice_wake: None,
        prewarm_ipython_kernel: None,
        queued_goal_context_purge: None,
    })
    .await
    .unwrap();

    let entries = engine.session.entries().await;
    assert!(
        entries.iter().any(|entry| matches!(
            entry,
            pa_types::session::FileEntry::ThinkingLevelChange { .. }
        )),
        "entries: {entries:?}"
    );
    assert!(
        entries.iter().any(|entry| matches!(
            entry,
            pa_types::session::FileEntry::ServiceTierChange { .. }
        )),
        "entries: {entries:?}"
    );
}

// ---------------------------------------------------------------------------
// The model-visible surface follows the wired host handlers (#8) and the
// late agent-message receipts restore onto rebuilt tool results (#10).
// ---------------------------------------------------------------------------

use crate::session_engine::runtime_wiring::KernelCronWiring;

/// Host handlers for the wire names the skill packages send: named
/// no-ops are all the registry filter keys on.
fn handlers(names: &[&str]) -> crate::kernel::shared::HostRequestHandlers {
    let mut handlers = crate::kernel::shared::HostRequestHandlers::default();
    for name in names {
        handlers.register(
            *name,
            crate::kernel::shared::host_handler(|_payload| {
                Box::pin(async { Ok(serde_json::Value::Null) })
            }),
        );
    }
    handlers
}

fn cron_wiring(dir: &std::path::Path) -> KernelCronWiring {
    KernelCronWiring {
        store: std::sync::Arc::new(crate::cron::store::AgentCronJobStore::new(
            dir.join("jobs.json"),
        )),
        binding: None,
        mutation_hook: None,
    }
}

async fn engine_over(
    extra_host_handlers: Option<crate::kernel::shared::HostRequestHandlers>,
    cron_store: Option<KernelCronWiring>,
    daemonless: bool,
) -> (SessionEngine, tempfile::TempDir) {
    let model = pa_agent::types::Model {
        id: "m".into(),
        name: "m".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: "http://localhost".into(),
        reasoning: false,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 1_000,
        max_tokens: 100,
        max_tokens_explicit: false,
    };
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let engine = create_session(SessionEngineConfig {
        cron_store,
        cwd: cwd.clone(),
        agent_dir: tmp.path().join("agent"),
        model: Some(model),
        stream_fn: Some(provider.stream_fn()),
        extra_host_handlers,
        daemonless,
        ..Default::default()
    })
    .await
    .unwrap();
    (engine, tmp)
}

fn prompt_lists_skill(engine: &SessionEngine, name: &str) -> bool {
    engine
        .system_prompt
        .contains(&format!("<name>{name}</name>"))
}

fn kernel_skill_imports(engine: &SessionEngine) -> Vec<String> {
    engine
        .provisioner
        .python_skills()
        .iter()
        .map(|skill| skill.import_name.clone())
        .collect()
}

/// One model-visible surface per embedding, keyed on the wired host
/// handlers (#8): the prompt and the kernel pre-import list only the
/// skills whose host requests registered. Print wires the messaging
/// handlers, RPC none, the daemon shape all three (its cron wiring also
/// serves the heartbeat requests).
#[tokio::test]
async fn model_visible_skills_follow_the_embedding_wiring() {
    let all = ["agent-message", "agent-observe", "rlm-heartbeat"];
    let imports_of = [
        ("agent-message", "agent_message"),
        ("agent-observe", "agent_observe"),
        ("rlm-heartbeat", "rlm_heartbeat"),
    ];
    let cron_dir = tempfile::tempdir().unwrap();
    let daemon_cron = Some(cron_wiring(cron_dir.path()));
    let cases = [
        (
            "print",
            &["agent_message.send"][..],
            None,
            true,
            &["agent-message"][..],
        ),
        ("rpc", &[][..], None, true, &[][..]),
        (
            "daemon",
            &[
                "agent_message.send",
                "agent_observe.list",
                "rlm_heartbeat.create",
            ][..],
            daemon_cron.clone(),
            false,
            &["agent-message", "agent-observe", "rlm-heartbeat"][..],
        ),
    ];
    for (label, wired, cron, daemonless, visible) in cases {
        let (engine, _tmp) = engine_over(Some(handlers(wired)), cron, daemonless).await;
        // The bundled fixtures loaded at all.
        assert!(prompt_lists_skill(&engine, "compact"), "{label}");
        for skill in all {
            assert_eq!(
                prompt_lists_skill(&engine, skill),
                visible.contains(&skill),
                "{label}: {skill}"
            );
        }
        let imports = kernel_skill_imports(&engine);
        for (skill, import) in imports_of {
            assert_eq!(
                imports.iter().any(|name| name == import),
                visible.contains(&skill),
                "{label}: {import}"
            );
        }
    }
}

/// A receipt that landed after its cell's tool result persists as a
/// custom entry; a rebuilt engine patches it onto the tool result (#10).
#[tokio::test]
async fn engine_build_restores_late_sent_agent_message_receipts() {
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let sessions = tmp.path().join("sessions");
    let mut manager = SessionManager::persisted(&cwd, &sessions);
    // The durable-append rule delays non-assistant rows until the first
    // assistant entry, so the history needs one to reach the file.
    manager
        .append_message(pa_types::session::AgentMessage::Assistant(
            serde_json::from_value(serde_json::json!({
                "role": "assistant",
                "content": [{ "type": "text", "text": "history reply" }],
                "api": "test",
                "provider": "test",
                "model": "m",
                "usage": {
                    "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
                    "totalTokens": 0,
                    "cost": { "input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0 }
                },
                "stopReason": "stop",
                "timestamp": 1,
            }))
            .unwrap(),
        ))
        .unwrap();
    manager
        .append_message(pa_types::session::AgentMessage::ToolResult(
            pa_types::ai::ToolResultMessage {
                tool_call_id: "call-1".to_string(),
                tool_name: "python_repl".to_string(),
                content: Vec::new(),
                details: Some(serde_json::json!({ "status": "ok" })),
                is_error: false,
                timestamp: 1,
                rest: pa_types::JsonMap::new(),
            },
        ))
        .unwrap();
    manager
        .append_custom_entry(
            "ipython_sent_agent_message",
            Some(serde_json::json!({
                "toolCallId": "call-1",
                "message": {
                    "id": "agentmsg_1",
                    "message": "Ping.",
                    "deliveryStatus": "delivered",
                    "receiverRole": "parent",
                    "target": {
                        "activeSessionId": "a1",
                        "sessionId": "s1",
                        "sessionName": "Worker",
                    },
                },
            })),
        )
        .unwrap();
    let session_file = manager
        .get_session_file()
        .expect("the persisted session file")
        .to_path_buf();
    let manager = SessionManager::open(&cwd, &sessions, &session_file);

    let model = pa_agent::types::Model {
        id: "m".into(),
        name: "m".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: "http://localhost".into(),
        reasoning: false,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 1_000,
        max_tokens: 100,
        max_tokens_explicit: false,
    };
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    let engine = create_session(SessionEngineConfig {
        cwd: cwd.clone(),
        agent_dir: tmp.path().join("agent"),
        model: Some(model),
        stream_fn: Some(provider.stream_fn()),
        session_manager: Some(manager),
        daemonless: true,
        ..Default::default()
    })
    .await
    .unwrap();

    let state = engine.session.agent().state().await;
    let result = state
        .messages
        .iter()
        .find_map(|row| match row {
            pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::ToolResult(
                result,
            )) if result.tool_call_id == "call-1" => Some(result.clone()),
            _ => None,
        })
        .expect("the rebuilt tool result");
    let details = result.details.as_ref().expect("the tool result details");
    assert_eq!(details["status"], "ok");
    let sent = details["sentAgentMessages"]
        .as_array()
        .expect("the restored receipt");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["id"], "agentmsg_1");
    assert_eq!(sent[0]["target"]["sessionName"], "Worker");
}

/// The late-receipt race (#10): a receipt recorded while its cell's
/// tool-result row has not landed yet (the kernel callback fires before
/// `execute_ipython` returns) applies to the row as it lands, so the
/// live state row and the persisted one both carry it.
#[tokio::test]
async fn late_receipts_recorded_before_the_row_lands_apply_on_landing() {
    let model = pa_agent::types::Model {
        id: "m".into(),
        name: "m".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: "http://localhost".into(),
        reasoning: false,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 1_000,
        max_tokens: 100,
        max_tokens_explicit: false,
    };
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    provider.push_tool_call_turn(
        None,
        vec![("call-1", PYTHON_TOOL_NAME, serde_json::json!({}))],
    );
    provider.push_text_turn("all done");
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    // The fake python tool records the receipt through the engine's own
    // seam (like the print sink does); the engine slot binds once the
    // build returns, strictly before the first run executes the tool.
    let engine_slot: Arc<std::sync::Mutex<Option<std::sync::Weak<SessionEngine>>>> = Arc::default();
    let slot = Arc::clone(&engine_slot);
    let receipt = crate::kernel::shared::KernelSentAgentMessage {
        id: "agentmsg_1".to_string(),
        message: "Ping.".to_string(),
        delivery_status: crate::kernel::shared::SentDeliveryStatus::Delivered,
        receiver_role: Some(crate::kernel::shared::ReceiverRole::Parent),
        target: crate::kernel::shared::SentAgentMessageTarget {
            active_session_id: "a1".to_string(),
            session_id: "s1".to_string(),
            session_name: Some("Worker".to_string()),
        },
    };
    let recording_tool = ToolDefinition {
        name: PYTHON_TOOL_NAME.to_string(),
        label: "Python".to_string(),
        description: "Runs a python cell.".to_string(),
        prompt_snippet: String::new(),
        parameters: serde_json::json!({ "type": "object", "properties": {} }),
        execution_mode: Some(ExecutionMode::Sequential),
        prepare_arguments: None,
        execute: Arc::new(move |tool_call_id, _params, _signal, _on_update| {
            let slot = Arc::clone(&slot);
            let receipt = receipt.clone();
            let tool_call_id = tool_call_id.to_string();
            Box::pin(async move {
                let engine = slot
                    .lock()
                    .unwrap()
                    .as_ref()
                    .and_then(std::sync::Weak::upgrade)
                    .expect("the engine binds before the first run");
                engine
                    .record_late_sent_agent_message(&tool_call_id, receipt)
                    .await?;
                Ok(ToolExecutionResult::text("cell done"))
            })
        }),
    };
    let engine = create_session(SessionEngineConfig {
        on_late_sent_agent_message: None,
        semantic_edges: None,
        cron_store: None,
        queued_steering_probe: None,
        should_stop_after_turn: None,
        image_model_router: None,
        steering_mode: None,
        follow_up_mode: None,
        cwd: cwd.clone(),
        agent_dir: tmp.path().join("agent"),
        mcp_manager: None,
        model: Some(model),
        thinking_level: None,
        stream_fn: Some(provider.stream_fn()),
        tools: vec![bridge_tool(recording_tool)],
        custom_system_prompt: None,
        prompt_guidelines: vec![],
        generic_mcp_servers: vec![],
        allow_recursion: None,
        session_manager: None,
        extra_host_handlers: None,
        conversation_log_path: None,
        additional_skill_paths: vec![],
        additional_prompt_paths: vec![],
        extra_builtin_skill_overrides: vec![],
        rlm_subagent_host: None,
        rlm_usage_store: None,

        inbox: None,
        progress_note_emit: None,
        rlm_depth: None,
        daemonless: true,
        telemetry: None,
        model_info: None,
        on_background_work_settled: None,
        bash_notice_wake: None,
        prewarm_ipython_kernel: None,
        queued_goal_context_purge: None,
    })
    .await
    .unwrap();
    let engine = Arc::new(engine);
    *engine_slot.lock().unwrap() = Some(Arc::downgrade(&engine));

    let outcome = engine
        .prompt("run the cell", PromptOptions::default())
        .await
        .unwrap();
    assert_eq!(outcome, PromptOutcome::Prompt);
    engine.session.agent().wait_for_idle().await;

    // The live state row carries the receipt.
    let state = engine.session.agent().state().await;
    let result = state
        .messages
        .iter()
        .find_map(|message| match message {
            pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::ToolResult(
                result,
            )) if result.tool_call_id == "call-1" => Some(result.clone()),
            _ => None,
        })
        .expect("the landed tool result");
    let details = result.details.as_ref().expect("the receipt rides the row");
    assert_eq!(
        details["sentAgentMessages"][0]["id"], "agentmsg_1",
        "the live state row carries the receipt"
    );

    // So does the persisted message row, and the receipt itself persists
    // as a custom entry.
    let entries = engine.session.entries().await;
    let persisted = entries
        .iter()
        .find_map(|entry| match entry {
            pa_types::session::FileEntry::Message {
                message: pa_types::session::AgentMessage::ToolResult(result),
                ..
            } if result.tool_call_id == "call-1" => Some(result.clone()),
            _ => None,
        })
        .expect("the persisted tool result");
    let details = persisted
        .details
        .as_ref()
        .expect("the persisted row's details");
    assert_eq!(
        details["sentAgentMessages"][0]["id"], "agentmsg_1",
        "the persisted row carries the receipt"
    );
    assert!(
        entries.iter().any(|entry| matches!(
            entry,
            pa_types::session::FileEntry::Custom { payload, .. }
                if payload.custom_type
                    == crate::session_engine::late_sent_messages::IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_TYPE
        )),
        "the receipt persists as a custom entry"
    );
}
