//! Agent Client Protocol client provider: drives an external ACP agent (for example an agent
//! binary the user has logged into) over JSON-RPC on stdio and streams its reply as one assistant
//! message.
//!
//! The command to spawn is the model's `baseUrl`, split on whitespace. The agent owns its own
//! login, tools, and quota: this provider stores no credentials and exposes no prime-agent tools
//! to it. Permission requests from the agent are rejected.

use std::process::Stdio;

use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio_util::sync::CancellationToken;

use crate::event_stream::{
    create_assistant_message_event_stream, AssistantMessageEvent, AssistantMessageEventStream,
    AssistantMessageEventWriter,
};
use crate::registry::Provider;
use crate::types::{
    done_reason, error_reason, AssistantContent, AssistantMessage, Context, Message, Model,
    SimpleStreamOptions, StopReason, StreamOptions, TextContent, ThinkingContent, Usage,
};
use crate::utils_inner::diagnostics::now_ms;

pub const API_ACP: &str = "acp";

pub struct AcpProvider;

impl Provider for AcpProvider {
    fn api(&self) -> &str {
        API_ACP
    }

    fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> AssistantMessageEventStream {
        stream_acp(model, context, options)
    }

    fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> AssistantMessageEventStream {
        stream_acp(model, context, options.map(|simple| &simple.base))
    }
}

fn stream_acp(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
) -> AssistantMessageEventStream {
    let model = model.clone();
    let prompt = flatten_prompt(context);
    let signal = options.and_then(|options| options.signal.clone());
    let (writer, reader) = create_assistant_message_event_stream();

    tokio::spawn(async move {
        let mut output = AssistantMessage {
            content: Vec::new(),
            api: API_ACP.to_string(),
            provider: model.provider.clone(),
            model: model.id.clone(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: now_ms(),
            rest: Map::default(),
        };
        writer.push(AssistantMessageEvent::Start {
            partial: output.clone(),
        });

        match run(&model, &prompt, signal, &mut output, &writer).await {
            Ok(()) => {
                writer.push(AssistantMessageEvent::Done {
                    reason: done_reason(output.stop_reason),
                    message: output,
                });
                writer.end(None);
            }
            Err(error) => {
                output.stop_reason = match error {
                    AcpError::Aborted => StopReason::Aborted,
                    AcpError::Failed(_) => StopReason::Error,
                };
                output.error_message = Some(error.to_string());
                writer.push(AssistantMessageEvent::Error {
                    reason: error_reason(output.stop_reason),
                    error: output.clone(),
                });
                writer.end(Some(output));
            }
        }
    });

    reader
}

#[derive(Debug)]
enum AcpError {
    Aborted,
    Failed(String),
}

impl std::fmt::Display for AcpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AcpError::Aborted => write!(f, "Request was aborted"),
            AcpError::Failed(message) => write!(f, "{message}"),
        }
    }
}

fn failed(message: impl std::fmt::Display) -> AcpError {
    AcpError::Failed(message.to_string())
}

/// The agent keeps its own conversation state per process, and this provider spawns one process per
/// turn, so earlier turns ride along as a transcript.
fn flatten_prompt(context: &Context) -> String {
    let mut parts = Vec::new();
    if let Some(system) = &context.system_prompt {
        parts.push(system.clone());
    }
    let single_user_turn = context.messages.len() == 1;
    for message in &context.messages {
        match message {
            Message::User(user) if single_user_turn => parts.push(user.content.text()),
            Message::User(user) => parts.push(format!("User: {}", user.content.text())),
            Message::Assistant(assistant) => {
                let text: String = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        AssistantContent::Text(text) => Some(text.text.as_str()),
                        AssistantContent::Thinking(_) | AssistantContent::ToolCall(_) => None,
                    })
                    .collect();
                parts.push(format!("Assistant: {text}"));
            }
            Message::ToolResult(_) => {}
        }
    }
    parts.join("\n\n")
}

struct Rpc {
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
    signal: Option<CancellationToken>,
}

impl Rpc {
    async fn send(&mut self, value: &Value) -> Result<(), AcpError> {
        let mut line = value.to_string();
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(failed)?;
        self.stdin.flush().await.map_err(failed)
    }

    /// Send a request and read until its response. Notifications go to `on_notification`; agent
    /// requests are answered inline. Non-JSON stdout lines are skipped.
    async fn call(
        &mut self,
        method: &str,
        params: Value,
        on_notification: &mut impl FnMut(&Value),
    ) -> Result<Value, AcpError> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await?;
        loop {
            let line = self.next_line().await?;
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match (
                message.get("method").and_then(Value::as_str),
                message.get("id"),
            ) {
                (Some(method), Some(request_id)) => {
                    let reply = agent_request_reply(method, &message["params"]);
                    let mut response = json!({"jsonrpc": "2.0", "id": request_id});
                    match reply {
                        Ok(result) => response["result"] = result,
                        Err(error) => response["error"] = error,
                    }
                    self.send(&response).await?;
                }
                (Some(_), None) => on_notification(&message),
                (None, Some(response_id)) if response_id == &json!(id) => {
                    if let Some(error) = message.get("error") {
                        let text = error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("ACP request failed");
                        return Err(failed(format!("ACP {method}: {text}")));
                    }
                    return Ok(message.get("result").cloned().unwrap_or(Value::Null));
                }
                (None, _) => {}
            }
        }
    }

    async fn next_line(&mut self) -> Result<String, AcpError> {
        let read = async {
            self.lines
                .next_line()
                .await
                .map_err(failed)?
                .ok_or_else(|| failed("ACP agent closed its output before replying"))
        };
        match &self.signal {
            Some(signal) => tokio::select! {
                () = signal.cancelled() => Err(AcpError::Aborted),
                line = read => line,
            },
            None => read.await,
        }
    }
}

/// Answer a request the agent sent to the client. Permission prompts pick a reject option; every
/// other client capability is undeclared, so it is unsupported.
fn agent_request_reply(method: &str, params: &Value) -> Result<Value, Value> {
    if method != "session/request_permission" {
        return Err(json!({"code": -32601, "message": format!("method not supported: {method}")}));
    }
    let reject = params
        .get("options")
        .and_then(Value::as_array)
        .and_then(|options| {
            options.iter().find(|option| {
                option
                    .get("kind")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind.starts_with("reject"))
            })
        })
        .and_then(|option| option.get("optionId"));
    Ok(match reject {
        Some(option_id) => json!({"outcome": {"outcome": "selected", "optionId": option_id}}),
        None => json!({"outcome": {"outcome": "cancelled"}}),
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BlockKind {
    Text,
    Thinking,
}

/// Tracks the open streamed block of `output.content`.
struct Blocks {
    open: Option<(BlockKind, usize)>,
}

impl Blocks {
    fn append(
        &mut self,
        kind: BlockKind,
        chunk: &str,
        output: &mut AssistantMessage,
        writer: &AssistantMessageEventWriter,
    ) {
        if self.open.is_some_and(|(open, _)| open != kind) {
            self.close(output, writer);
        }
        let index = if let Some((_, index)) = self.open {
            index
        } else {
            let index = output.content.len();
            output.content.push(match kind {
                BlockKind::Text => AssistantContent::Text(TextContent {
                    text: String::new(),
                    text_signature: None,
                    rest: Map::default(),
                }),
                BlockKind::Thinking => AssistantContent::Thinking(ThinkingContent {
                    thinking: String::new(),
                    thinking_signature: None,
                    redacted: None,
                    rest: Map::default(),
                }),
            });
            self.open = Some((kind, index));
            let content_index = index as u64;
            writer.push(match kind {
                BlockKind::Text => AssistantMessageEvent::TextStart {
                    content_index,
                    partial: output.clone(),
                },
                BlockKind::Thinking => AssistantMessageEvent::ThinkingStart {
                    content_index,
                    partial: output.clone(),
                },
            });
            index
        };
        match &mut output.content[index] {
            AssistantContent::Text(block) => block.text.push_str(chunk),
            AssistantContent::Thinking(block) => block.thinking.push_str(chunk),
            AssistantContent::ToolCall(_) => {}
        }
        let content_index = index as u64;
        writer.push(match kind {
            BlockKind::Text => AssistantMessageEvent::TextDelta {
                content_index,
                delta: chunk.to_string(),
                partial: output.clone(),
            },
            BlockKind::Thinking => AssistantMessageEvent::ThinkingDelta {
                content_index,
                delta: chunk.to_string(),
                partial: output.clone(),
            },
        });
    }

    fn close(&mut self, output: &mut AssistantMessage, writer: &AssistantMessageEventWriter) {
        let Some((kind, index)) = self.open.take() else {
            return;
        };
        let content_index = index as u64;
        writer.push(match (kind, &output.content[index]) {
            (BlockKind::Thinking, AssistantContent::Thinking(block)) => {
                AssistantMessageEvent::ThinkingEnd {
                    content_index,
                    content: block.thinking.clone(),
                    partial: output.clone(),
                }
            }
            (_, AssistantContent::Text(block)) => AssistantMessageEvent::TextEnd {
                content_index,
                content: block.text.clone(),
                partial: output.clone(),
            },
            (_, AssistantContent::Thinking(block)) => AssistantMessageEvent::ThinkingEnd {
                content_index,
                content: block.thinking.clone(),
                partial: output.clone(),
            },
            (_, AssistantContent::ToolCall(_)) => return,
        });
    }
}

async fn run(
    model: &Model,
    prompt: &str,
    signal: Option<CancellationToken>,
    output: &mut AssistantMessage,
    writer: &AssistantMessageEventWriter,
) -> Result<(), AcpError> {
    let mut argv = model.base_url.split_whitespace();
    let program = argv
        .next()
        .ok_or_else(|| failed("ACP model has an empty baseUrl; set it to the agent command"))?;
    let mut child: Child = Command::new(program)
        .args(argv)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| failed(format!("failed to start ACP agent `{program}`: {error}")))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| failed("ACP agent has no stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| failed("ACP agent has no stdout"))?;
    let mut rpc = Rpc {
        stdin,
        lines: BufReader::new(stdout).lines(),
        next_id: 0,
        signal,
    };
    let mut ignore = |_: &Value| {};

    let initialized = rpc
        .call(
            "initialize",
            json!({"protocolVersion": 1, "clientCapabilities": {}}),
            &mut ignore,
        )
        .await?;
    // Native login: authenticate with the first method the agent advertises, if any.
    if let Some(method_id) = initialized
        .pointer("/authMethods/0/id")
        .and_then(Value::as_str)
    {
        rpc.call("authenticate", json!({"methodId": method_id}), &mut ignore)
            .await?;
    }
    let cwd = std::env::current_dir().map_err(failed)?;
    let session = rpc
        .call(
            "session/new",
            json!({"cwd": cwd, "mcpServers": []}),
            &mut ignore,
        )
        .await?;
    let session_id = session
        .get("sessionId")
        .cloned()
        .ok_or_else(|| failed("ACP session/new returned no sessionId"))?;

    let mut blocks = Blocks { open: None };
    let mut on_update = |message: &Value| {
        if message.get("method").and_then(Value::as_str) != Some("session/update") {
            return;
        }
        let update = &message["params"]["update"];
        let kind = match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk") => BlockKind::Text,
            Some("agent_thought_chunk") => BlockKind::Thinking,
            _ => return,
        };
        if let Some(chunk) = update.pointer("/content/text").and_then(Value::as_str) {
            blocks.append(kind, chunk, output, writer);
        }
    };
    let prompt_result = rpc
        .call(
            "session/prompt",
            json!({"sessionId": session_id, "prompt": [{"type": "text", "text": prompt}]}),
            &mut on_update,
        )
        .await;
    if matches!(prompt_result, Err(AcpError::Aborted)) {
        // Best effort: tell the agent to stop; the process is killed on drop either way.
        rpc.send(&json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": {"sessionId": session_id},
        }))
        .await
        .ok();
    }
    blocks.close(output, writer);
    let result = prompt_result?;
    output.stop_reason = match result.get("stopReason").and_then(Value::as_str) {
        Some("max_tokens" | "max_turn_requests") => StopReason::Length,
        Some("cancelled") => return Err(AcpError::Aborted),
        Some("refusal") => return Err(failed("ACP agent refused the request")),
        Some(_) | None => StopReason::Stop,
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ModelCost, UserMessage};

    fn model(command: &str) -> Model {
        Model {
            id: "agent".to_string(),
            name: "agent".to_string(),
            api: API_ACP.to_string(),
            provider: "acp-test".to_string(),
            base_url: command.to_string(),
            reasoning: false,
            thinking_level_map: None,
            input: Vec::new(),
            cost: ModelCost {
                input: 0.0.into(),
                output: 0.0.into(),
                cache_read: 0.0.into(),
                cache_write: 0.0.into(),
            },
            context_window: 1000,
            max_tokens: 1000,
            max_tokens_explicit: false,
            featured: None,
            headers: None,
            compat: None,
        }
    }

    fn user_context(text: &str) -> Context {
        Context {
            system_prompt: None,
            messages: vec![Message::User(UserMessage {
                content: crate::types::UserMessageContent::Text(text.to_string()),
                timestamp: 0,
                rest: Map::default(),
            })],
            tools: None,
        }
    }

    /// A scripted agent: reads initialize, session/new, session/prompt in order, streams a
    /// thought and two message chunks (plus a non-JSON banner line), then ends the turn.
    const FAKE_AGENT: &str = r#"
read -r _
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"authMethods":[]}}'
read -r _
echo 'banner line that is not json'
echo '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}'
read -r _
echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"hmm"}}}}'
echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"po"}}}}'
echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ng"}}}}'
echo '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
"#;

    #[tokio::test]
    async fn streams_agent_chunks_into_one_assistant_message() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("agent.sh");
        std::fs::write(&script, FAKE_AGENT).unwrap();
        let model = model(&format!("sh {}", script.display()));

        let stream = AcpProvider.stream(&model, &user_context("ping"), None);
        let message = stream.result().await;

        assert_eq!(message.stop_reason, StopReason::Stop);
        let content: Vec<(&str, &str)> = message
            .content
            .iter()
            .map(|block| match block {
                AssistantContent::Thinking(block) => ("thinking", block.thinking.as_str()),
                AssistantContent::Text(block) => ("text", block.text.as_str()),
                AssistantContent::ToolCall(_) => ("tool", ""),
            })
            .collect();
        assert_eq!(content, vec![("thinking", "hmm"), ("text", "pong")]);
    }

    #[tokio::test]
    async fn missing_agent_command_ends_in_an_error_message() {
        let stream = AcpProvider.stream(
            &model("/nonexistent/acp-agent --acp"),
            &user_context("ping"),
            None,
        );
        let message = stream.result().await;

        assert_eq!(message.stop_reason, StopReason::Error);
        assert!(message
            .error_message
            .unwrap()
            .contains("failed to start ACP agent"));
    }

    #[test]
    fn permission_requests_pick_a_reject_option() {
        let params = json!({"options": [
            {"optionId": "allow", "kind": "allow_once"},
            {"optionId": "deny", "kind": "reject_once"},
        ]});
        assert_eq!(
            agent_request_reply("session/request_permission", &params),
            Ok(json!({"outcome": {"outcome": "selected", "optionId": "deny"}}))
        );
    }
}
