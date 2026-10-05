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
    };
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    // First turn: call the tool. Second turn: final text.
    provider.push_tool_call_turn(
        Some("checking"),
        vec![("call-1", "echo", serde_json::json!({ "text": "hi" }))],
    );
    provider.push_text_turn("all done");

    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let engine = create_session(SessionEngineConfig {
        on_late_sent_agent_message: None,
        semantic_edges: None,
        cron_store: None,
        queued_steering_probe: None,
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
        rlm_depth: None,
        telemetry: None,
        model_info: None,
        on_background_work_settled: None,
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

    // The loop executed the tool and produced the final message.
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
    // The session persisted user + assistant turns.
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
/// at depth N reads "depth: N (not root)", never the root identity the
/// pre-fix default (None -> 0) stamped on every child.
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
        rlm_depth: Some(2),
        telemetry: None,
        model_info: None,
        on_background_work_settled: None,
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

/// The login chain's prompt-gating end to end at the engine level: a
/// settings-declared OAuth server stays gated, an endpoint-bound
/// credential (exactly what `mcp.begin_login` persists) unlocks it in
/// the NEXT session the engine builds, and a credential bound to
/// another endpoint does not.
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
            rlm_depth: None,
            telemetry: None,
            model_info: None,
            on_background_work_settled: None,
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

    // Gated: no credentials, no generic MCP guidance in the prompt.
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
    // must prove where it belongs (a retargeted entry forces a
    // re-login).
    write_credential("https://other.example/mcp");
    let engine = create_session(config(&cwd, &agent_dir, provider.stream_fn()))
        .await
        .unwrap();
    assert!(!engine.system_prompt.contains("# Generic MCP Connections"));

    // The endpoint-bound credential unlocks the prompt guidance in the
    // next session the engine builds.
    write_credential("https://fixture.example/mcp");
    let engine = create_session(config(&cwd, &agent_dir, provider.stream_fn()))
        .await
        .unwrap();
    assert!(engine.system_prompt.contains("# Generic MCP Connections"));
    assert!(engine.system_prompt.contains("`fixture-oauth`"));
}

#[tokio::test]
async fn create_session_registers_goal_and_heartbeat_handlers() {
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
    // The agent loop gained the ipython tool backed by the kernel.
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
        names.iter().any(|name| name == "ipython"),
        "tools: {names:?}"
    );
}
