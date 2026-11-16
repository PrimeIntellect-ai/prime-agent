//! MCP sampling (`sampling/createMessage`) on the daemon side: the handler the
//! kernel's callback calls, and the bounded, tool-free completion it may run.
//!
//! Policy lives in pa-core (`session_engine::mcp_sampling`): default deny, per
//! server, no global switch. This module makes the refusal *visible* — a row in
//! the conversation saying which server asked and why it was refused — and runs
//! the completion itself (one turn, no tools, a token cap) only for a server the
//! user listed.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use pa_agent::agent::{Agent, AgentInitialState, AgentOptions};
use pa_agent::agent_loop::{BeforeToolCallFn, ShouldStopAfterTurnFn};
use pa_agent::types::{
    AgentEvent, AgentMessage, AssistantContent, Message, Usage, UserContent, UserPart,
};
use pa_types::ai::UserContent as SessionUserContent;
use pa_types::session::CustomMessage;
use serde_json::{json, Value};

use pa_core::session_engine::telemetry::McpUsageKind;

use super::AgentSessionEngine;

/// The custom row type a sampling request/refusal lands as.
pub const MCP_SAMPLING_CUSTOM_TYPE: &str = "mcp_sampling";
/// The most completions one session serves, even for an allowed server.
const MAX_SAMPLING_CALLS_PER_SESSION: u32 = 16;

/// The runner seam the worker installs: one request in, one bounded completion out.
pub type SamplingRunner = Arc<
    dyn Fn(SamplingRequest) -> pa_agent::BoxFut<'static, Result<SamplingReply, String>>
        + Send
        + Sync,
>;

/// One sampling request, already through the wire.
#[derive(Debug, Clone)]
pub struct SamplingRequest {
    pub server: String,
    /// The request's messages, as the server sent them (`{role, content}`).
    pub messages: Vec<Value>,
    pub system_prompt: Option<String>,
    pub max_tokens: Option<u64>,
}

/// One served completion.
#[derive(Debug, Clone)]
pub struct SamplingReply {
    pub text: String,
    pub model: String,
    pub usage: Usage,
}

impl AgentSessionEngine {
    /// Serve one `sampling/createMessage` request.
    ///
    /// Runs on a plain thread: the session build takes its blocking lock, which panics
    /// under a runtime context (the side-question seam runs the same way).
    ///
    /// # Errors
    ///
    /// The refusal reason (also written as a visible row) when the server is not
    /// allowed, the session is over its call budget, or the request is malformed.
    pub(crate) fn run_mcp_sampling_blocking(
        self: &Arc<Self>,
        request: SamplingRequest,
    ) -> Result<SamplingReply, String> {
        let settings =
            pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
        let policy = settings.get_mcp_sampling();
        let server = request.server.clone();
        if !pa_core::session_engine::mcp_sampling::sampling_allowed(&policy, &server) {
            let reason = if policy.allowed_servers.is_empty() {
                "mcpSampling.allowedServers is empty"
            } else {
                "this server is not in mcpSampling.allowedServers"
            };
            return Err(self.refuse_sampling(&server, reason));
        }
        let used = self.mcp_sampling_calls.fetch_add(1, Ordering::SeqCst);
        if used >= MAX_SAMPLING_CALLS_PER_SESSION {
            return Err(self.refuse_sampling(
                &server,
                &format!("this session served {MAX_SAMPLING_CALLS_PER_SESSION} sampling requests"),
            ));
        }
        let messages = pa_core::session_engine::mcp_sampling::sampling_messages(&request.messages)?;
        let max_tokens = pa_core::session_engine::mcp_sampling::clamp_sampling_max_tokens(
            request.max_tokens,
            &policy,
        );
        let model = self.session_model().map_err(|error| format!("{error:#}"))?;
        // Before any runtime is entered: `session_agent` takes the blocking lock.
        let parent = self
            .session_agent(&model)
            .map_err(|error| format!("{error:#}"))?;
        let engine = Arc::clone(self);
        let reply = self.runtime.block_on(async move {
            engine
                .run_sampling_turn(&parent, messages, request.system_prompt, max_tokens)
                .await
        })?;
        self.write_sampling_row(
            &server,
            &format!(
                "served a completion on {}/{} ({} in, {} out)",
                model.provider, model.id, reply.usage.input, reply.usage.output
            ),
        );
        self.note_mcp_usage(McpUsageKind::SamplingServed);
        Ok(reply)
    }

    /// Record the refusal as a visible row and answer the caller with the reason.
    fn refuse_sampling(&self, server: &str, reason: &str) -> String {
        self.write_sampling_row(server, &format!("refused a sampling request ({reason})"));
        self.note_mcp_usage(McpUsageKind::SamplingRefused);
        format!("MCP sampling is refused for server '{server}': {reason}")
    }

    fn write_sampling_row(&self, server: &str, detail: &str) {
        let sink = self
            .mcp_notification_row_sink
            .lock()
            .expect("mcp notification row sink lock")
            .clone();
        let Some(sink) = sink else {
            return;
        };
        sink(CustomMessage {
            custom_type: MCP_SAMPLING_CUSTOM_TYPE.to_string(),
            content: SessionUserContent::Text(format!("[{server}] {detail}")),
            display: true,
            details: None,
            timestamp: 0,
            rest: pa_types::JsonMap::default(),
        });
    }

    async fn run_sampling_turn(
        &self,
        parent: &Arc<Agent>,
        messages: Vec<Message>,
        system_prompt: Option<String>,
        max_tokens: u64,
    ) -> Result<SamplingReply, String> {
        let parent_state = parent.state().await;
        let built = self.session.lock().await.clone();
        let stream_fn = built
            .as_deref()
            .and_then(|engine| engine.session.side_question_stream_fn())
            .ok_or_else(|| "the session has no side-call stream function".to_string())?;
        // `sampling/createMessage` ends on a user turn; that message is the prompt and
        // everything before it is the initial context.
        let mut context = messages;
        let Some(prompt) = take_last_user_text(&mut context) else {
            return Err("the sampling request does not end on a user message".to_string());
        };
        let before_tool_call: BeforeToolCallFn = Arc::new(|_context, _signal| {
            Box::pin(async move {
                Ok(Some(pa_agent::types::BeforeToolCallResult {
                    block: true,
                    reason: Some("MCP sampling runs without tools".to_string()),
                }))
            })
        });
        let should_stop_after_turn: ShouldStopAfterTurnFn =
            Arc::new(|_context| Box::pin(async move { Ok(true) }));
        let model_id = parent_state.model.id.clone();
        let agent = Arc::new(Agent::new(AgentOptions {
            initial_state: AgentInitialState {
                system_prompt,
                model: Some(parent_state.model.clone()),
                thinking_level: Some(parent_state.thinking_level),
                tools: Some(Vec::new()),
                messages: Some(context.into_iter().map(AgentMessage::Standard).collect()),
            },
            // The token cap rides the stream call: the agent has no max-token option.
            stream_fn: Some(capped_stream_fn(stream_fn, max_tokens)),
            before_tool_call: Some(before_tool_call),
            should_stop_after_turn: Some(should_stop_after_turn),
            session_id: parent.session_id().map(str::to_string),
            transport: Some(pa_agent::types::Transport::Sse),
            ..Default::default()
        }));
        let text = Arc::new(std::sync::Mutex::new(String::new()));
        let usage = Arc::new(std::sync::Mutex::new(Usage::zero()));
        let text_sink = Arc::clone(&text);
        let usage_sink = Arc::clone(&usage);
        let subscription = agent
            .subscribe(move |event, _signal| {
                let text = Arc::clone(&text_sink);
                let usage = Arc::clone(&usage_sink);
                Box::pin(async move {
                    if let AgentEvent::MessageEnd {
                        message: AgentMessage::Standard(Message::Assistant(assistant)),
                    } = &event
                    {
                        *usage.lock().expect("sampling usage lock") = assistant.usage.clone();
                        *text.lock().expect("sampling text lock") =
                            assistant_text(&assistant.content);
                    }
                    Ok(())
                })
            })
            .await;
        let outcome = agent
            .prompt(pa_agent::agent::AgentPromptInput::text(prompt))
            .await;
        let () = subscription.unsubscribe().await;
        outcome.map_err(|error| format!("{error:#}"))?;
        let text = text.lock().expect("sampling text lock").clone();
        let usage = usage.lock().expect("sampling usage lock").clone();
        if text.trim().is_empty() {
            return Err("the sampling completion returned no text".to_string());
        }
        Ok(SamplingReply {
            text,
            model: model_id,
            usage,
        })
    }
}

/// The session's stream fn with the sampling token cap applied to every call.
fn capped_stream_fn(
    base: pa_agent::stream::StreamFn,
    max_tokens: u64,
) -> pa_agent::stream::StreamFn {
    Arc::new(move |model, context, mut options| {
        options.max_tokens = Some(
            options
                .max_tokens
                .map_or(max_tokens, |requested| requested.min(max_tokens)),
        );
        base(model, context, options)
    })
}

/// Drop the trailing user message and return its text (the sampling prompt).
fn take_last_user_text(messages: &mut Vec<Message>) -> Option<String> {
    let text = match messages.last()? {
        Message::User(user) => match &user.content {
            UserContent::Text(text) => Some(text.clone()),
            UserContent::Parts(parts) => {
                let text: String = parts
                    .iter()
                    .filter_map(|part| match part {
                        UserPart::Text(text) => Some(text.text.clone()),
                        UserPart::Image(_) => None,
                    })
                    .collect();
                (!text.is_empty()).then_some(text)
            }
        },
        // A tool-result turn cannot be a sampling prompt, and neither can an
        // assistant turn: `sampling/createMessage` ends on a user message.
        Message::Assistant(_) | Message::ToolResult(_) => None,
    }?;
    messages.pop();
    Some(text)
}

fn assistant_text(content: &[AssistantContent]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            AssistantContent::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect()
}

/// The `mcp.sampling` host handler: bounded validation, then the runner.
pub fn register_mcp_sampling_handler(
    runner: SamplingRunner,
    handlers: &mut pa_core::kernel::shared::HostRequestHandlers,
) {
    use pa_core::kernel::shared::{host_handler, HostRequestPayload};

    handlers.register(
        "mcp.sampling",
        host_handler(move |payload: HostRequestPayload| {
            let runner = Arc::clone(&runner);
            Box::pin(async move {
                let request = parse_request(&payload.data)?;
                let reply = runner(request).await.map_err(anyhow::Error::msg)?;
                Ok(json!({
                    "text": reply.text,
                    "model": reply.model,
                    "usage": {
                        "input": reply.usage.input,
                        "output": reply.usage.output,
                    },
                }))
            })
        }),
    );
}

/// Validate one `mcp.sampling` payload into a request.
fn parse_request(data: &Value) -> anyhow::Result<SamplingRequest> {
    let server = data
        .get("server")
        .and_then(Value::as_str)
        .filter(|server| !server.is_empty() && server.chars().count() <= 128)
        .ok_or_else(|| anyhow::anyhow!("mcp.sampling requires a `server` name"))?;
    let messages = data
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("mcp.sampling requires a `messages` array"))?;
    let system_prompt = data
        .get("systemPrompt")
        .and_then(Value::as_str)
        .map(str::to_string);
    let max_tokens = data.get("maxTokens").and_then(Value::as_u64);
    Ok(SamplingRequest {
        server: server.to_string(),
        messages: messages.clone(),
        system_prompt,
        max_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::SessionEngine as _;
    use serde_json::json;
    use std::sync::Mutex;

    fn engine_with_settings(
        dir: &std::path::Path,
        settings: &serde_json::Value,
    ) -> Arc<AgentSessionEngine> {
        let agent_dir = dir.join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(agent_dir.join("settings.json"), settings.to_string()).unwrap();
        Arc::new(
            AgentSessionEngine::new(super::super::AgentEngineConfig {
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
            .unwrap(),
        )
    }

    /// The engine's sampling path takes the session's blocking lock, which panics under
    /// a runtime context: every test drives it on a plain thread, like the worker does.
    fn on_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        std::thread::spawn(f).join().expect("sampling thread")
    }

    fn recorder(engine: &Arc<AgentSessionEngine>) -> Arc<Mutex<Vec<String>>> {
        let rows = Arc::new(Mutex::new(Vec::new()));
        let sink_rows = Arc::clone(&rows);
        engine.set_mcp_notification_row_sink(Arc::new(move |message: CustomMessage| {
            let text = match &message.content {
                SessionUserContent::Text(text) => text.clone(),
                SessionUserContent::Blocks(_) => String::new(),
            };
            sink_rows
                .lock()
                .unwrap()
                .push(format!("{}: {text}", message.custom_type));
        }));
        rows
    }

    fn request(server: &str) -> SamplingRequest {
        SamplingRequest {
            server: server.to_string(),
            messages: vec![json!({"role": "user", "content": "summarize this"})],
            system_prompt: None,
            max_tokens: None,
        }
    }

    /// The default-deny tooth: with no `mcpSampling` settings, any server's request is
    /// refused, the refusal is a visible row, and nothing reaches a model (the engine has
    /// no provider configured, so a completion could not even be attempted).
    #[tokio::test]
    async fn sampling_is_refused_by_default_and_says_so() {
        let dir = tempfile::TempDir::new().unwrap();
        let engine = engine_with_settings(dir.path(), &json!({}));
        let rows = recorder(&engine);
        let error = on_thread(move || engine.run_mcp_sampling_blocking(request("notion")))
            .expect_err("default deny");
        assert!(error.contains("refused"), "{error}");
        assert!(error.contains("notion"), "{error}");
        assert!(
            error.contains("mcpSampling.allowedServers is empty"),
            "{error}"
        );
        let rows = rows.lock().unwrap().clone();
        assert_eq!(rows.len(), 1, "one refusal row: {rows:?}");
        assert_eq!(rows[0], "mcp_sampling: [notion] refused a sampling request (mcpSampling.allowedServers is empty)");
    }

    /// An allow list that does not name the server refuses it too — no wildcard, no
    /// case folding.
    #[tokio::test]
    async fn a_server_outside_the_allow_list_is_refused() {
        for server in ["notion", "Notion", "not"] {
            let dir = tempfile::TempDir::new().unwrap();
            let engine = engine_with_settings(
                dir.path(),
                &json!({ "mcpSampling": { "allowedServers": ["github"] } }),
            );
            let rows = recorder(&engine);
            let engine_for_call = Arc::clone(&engine);
            let error =
                on_thread(move || engine_for_call.run_mcp_sampling_blocking(request(server)))
                    .expect_err("not in the allow list");
            assert!(
                error.contains("not in mcpSampling.allowedServers"),
                "{server}: {error}"
            );
            assert_eq!(rows.lock().unwrap().len(), 1, "{server}");
        }
    }

    /// The allowed server gets past the policy gate: the run reaches the model path
    /// (this engine has no provider auth, so it fails there) — the point is that the
    /// error is not a refusal and no refusal row was written.
    #[tokio::test]
    async fn an_allowed_server_passes_the_policy_gate() {
        let dir = tempfile::TempDir::new().unwrap();
        let engine = engine_with_settings(
            dir.path(),
            &json!({ "mcpSampling": { "allowedServers": ["notion"] } }),
        );
        let rows = recorder(&engine);
        let engine_for_call = Arc::clone(&engine);
        let error = on_thread(move || engine_for_call.run_mcp_sampling_blocking(request("notion")))
            .expect_err("the engine has no provider auth");
        assert!(!error.contains("refused"), "{error}");
        assert!(
            !error.contains("allowedServers"),
            "the policy gate opened: {error}"
        );
        assert!(rows.lock().unwrap().is_empty(), "no refusal row");
    }

    /// The allowed path end to end: one bounded, tool-free completion on the session
    /// model, and a served row that carries token counts only.
    #[test]
    fn an_allowed_server_gets_a_bounded_completion() {
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                provider: Some("battery".to_string()),
                models: Some(vec![pa_ai::faux::FauxModelDefinition {
                    id: "mock-1".to_string(),
                    name: Some("Mock 1".to_string()),
                    reasoning: Some(false),
                    input: Some(vec![pa_types::ai::ModelInput::Text]),
                    cost: None,
                    context_window: Some(128_000),
                    max_tokens: Some(4096),
                }]),
                ..Default::default()
            });
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                "sampled reply",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("models.json"),
            serde_json::json!({
                "providers": {
                    "battery": {
                        "api": registration.api,
                        "baseUrl": "http://127.0.0.1:9",
                        "apiKey": "sk-battery",
                        "models": [{"id": "mock-1", "name": "Mock 1", "contextWindow": 128_000, "maxTokens": 4096}]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            agent_dir.join("settings.json"),
            serde_json::json!({
                "mcpSampling": { "allowedServers": ["svc"], "maxTokens": 64 }
            })
            .to_string(),
        )
        .unwrap();
        let engine = Arc::new(
            AgentSessionEngine::new(super::super::AgentEngineConfig {
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
            .unwrap(),
        );
        engine.register_arc();
        engine.configure_model(crate::engine::EngineModelSelection {
            provider: Some("battery".to_string()),
            model: Some("mock-1".to_string()),
            api_key: None,
            thinking: None,
        });
        let rows = recorder(&engine);
        let engine_for_call = Arc::clone(&engine);
        let reply = on_thread(move || engine_for_call.run_mcp_sampling_blocking(request("svc")))
            .expect("the allowed server is served");
        assert_eq!(reply.text, "sampled reply");
        assert_eq!(reply.model, "mock-1");
        assert_eq!(registration.call_count(), 1, "exactly one model call");
        assert!(reply.usage.input > 0, "the completion is billed: {reply:?}");
        let rows = rows.lock().unwrap().clone();
        assert_eq!(rows.len(), 1, "one served row: {rows:?}");
        assert!(
            rows[0].contains("served a completion on battery/mock-1"),
            "{rows:?}"
        );
        assert!(
            !rows[0].contains("sampled reply"),
            "the row never carries the completion's content: {rows:?}"
        );
        registration.unregister();
    }

    /// A malformed sampling payload never reaches the handler's runner.
    #[test]
    fn the_handler_payload_is_validated() {
        assert!(parse_request(&json!({})).is_err());
        assert!(parse_request(&json!({ "server": "", "messages": [] })).is_err());
        assert!(parse_request(&json!({ "server": "svc" })).is_err());
        let parsed = parse_request(&json!({
            "server": "svc",
            "messages": [{"role": "user", "content": "hi"}],
            "systemPrompt": "be brief",
            "maxTokens": 128
        }))
        .expect("a valid payload parses");
        assert_eq!(parsed.server, "svc");
        assert_eq!(parsed.system_prompt.as_deref(), Some("be brief"));
        assert_eq!(parsed.max_tokens, Some(128));
    }
}
