//! Domain types for the agent loop.
//!
//! Serde field names use camelCase so serialized messages match the TS wire
//! format exactly (important for the proxy protocol and session JSONL parity).

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::abort::AbortSignal;
use crate::BoxFut;

/// Thinking/reasoning level for models that support it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    #[default]
    Medium,
    High,
    Xhigh,
    Max,
}

/// The requested provider service tier; the wire names match the shared
/// AI package's (serde lowercase).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceTier {
    Auto,
    Default,
    Flex,
    Scale,
    Priority,
}

/// How tool calls from one assistant message are executed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ToolExecutionMode {
    Sequential,
    /// Preflight sequentially, execute allowed calls concurrently.
    #[default]
    Parallel,
}

/// Why an assistant response stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StopReason {
    #[serde(rename = "stop")]
    Stop,
    #[serde(rename = "length")]
    Length,
    #[serde(rename = "toolUse")]
    ToolUse,
    #[serde(rename = "error")]
    Error,
    #[serde(rename = "aborted")]
    Aborted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextContent {
    pub text: String,
    /// e.g. `OpenAI` responses message metadata (legacy id or `TextSignatureV1` JSON).
    #[serde(
        rename = "textSignature",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub text_signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThinkingContent {
    pub thinking: String,
    #[serde(
        rename = "thinkingSignature",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub thinking_signature: Option<String>,
    /// True when safety filters redacted the thinking; the opaque payload lives
    /// in `thinking_signature` so it can be passed back to the API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted: Option<bool>,
}

/// Base64-encoded image content block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageContent {
    /// Base64 encoded image data.
    pub data: String,
    /// e.g. "image/jpeg", "image/png".
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AssistantContent {
    Text(TextContent),
    Thinking(ThinkingContent),
    ToolCall(ToolCall),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Must be a JSON object; kept as `Value` like the TS `Record<string, any>`.
    pub arguments: serde_json::Value,
    /// Google-specific: opaque signature for reusing thought context.
    #[serde(
        rename = "thoughtSignature",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub thought_signature: Option<String>,
}

/// Token and cost usage for one assistant message.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct UsageCost {
    #[serde(default)]
    pub input: f64,
    #[serde(default)]
    pub output: f64,
    #[serde(rename = "cacheRead", default)]
    pub cache_read: f64,
    #[serde(rename = "cacheWrite", default)]
    pub cache_write: f64,
    #[serde(default)]
    pub total: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub input: u64,
    #[serde(default)]
    pub output: u64,
    #[serde(rename = "cacheRead", default)]
    pub cache_read: u64,
    #[serde(rename = "cacheWrite", default)]
    pub cache_write: u64,
    #[serde(rename = "totalTokens", default)]
    pub total_tokens: u64,
    #[serde(default)]
    pub cost: UsageCost,
}

impl Usage {
    #[must_use]
    pub const fn zero() -> Self {
        Usage {
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            total_tokens: 0,
            cost: UsageCost {
                input: 0.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
                total: 0.0,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssistantMessageDiagnostic {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub timestamp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

pub fn assistant_message_diagnostic(
    kind: impl Into<String>,
    error: &anyhow::Error,
    details: Option<serde_json::Value>,
) -> AssistantMessageDiagnostic {
    AssistantMessageDiagnostic {
        kind: kind.into(),
        timestamp: crate::now_ms(),
        error: Some(serde_json::Value::String(format!("{error:#}"))),
        details,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserMessage {
    #[serde(default)]
    pub content: UserContent,
    #[serde(default)]
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UserContent {
    Text(String),
    Parts(Vec<UserPart>),
}

impl Default for UserContent {
    fn default() -> Self {
        UserContent::Text(String::new())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UserPart {
    Text(TextContent),
    Image(ImageContent),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssistantMessage {
    pub content: Vec<AssistantContent>,
    #[serde(default)]
    pub api: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    /// Concrete `chunk.model` when different from the requested model.
    #[serde(
        rename = "responseModel",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub response_model: Option<String>,
    /// Provider-specific response/message identifier when exposed.
    #[serde(
        rename = "responseId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub response_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Vec<AssistantMessageDiagnostic>>,
    pub usage: Usage,
    #[serde(rename = "stopReason")]
    pub stop_reason: StopReason,
    /// Provider's raw stop/finish reason when it mapped to "error".
    #[serde(
        rename = "stopReasonRaw",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub stop_reason_raw: Option<String>,
    #[serde(
        rename = "errorMessage",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub error_message: Option<String>,
    #[serde(default)]
    pub timestamp: i64,
}

impl AssistantMessage {
    #[must_use]
    pub fn tool_calls(&self) -> Vec<&ToolCall> {
        self.content
            .iter()
            .filter_map(|c| match c {
                AssistantContent::ToolCall(tc) => Some(tc),
                _ => None,
            })
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolResultMessage {
    #[serde(rename = "toolCallId")]
    pub tool_call_id: String,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    pub content: Vec<ToolResultContent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(rename = "isError")]
    pub is_error: bool,
    #[serde(default)]
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ToolResultContent {
    Text(TextContent),
    Image(ImageContent),
}

impl ToolResultContent {
    pub fn text(s: impl Into<String>) -> Self {
        ToolResultContent::Text(TextContent {
            text: s.into(),
            text_signature: None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum Message {
    User(UserMessage),
    Assistant(AssistantMessage),
    ToolResult(ToolResultMessage),
}

/// An app-specific custom agent message: hosts use arbitrary roles here
/// and filter/convert them in `convert_to_llm`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CustomAgentMessage {
    pub role: String,
    #[serde(flatten)]
    pub payload: serde_json::Value,
}

/// Agent-level message: standard messages plus custom app messages.
// Boxing `Standard` would ripple through every consumer of the wire type.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentMessage {
    Standard(Message),
    Custom(CustomAgentMessage),
}

impl AgentMessage {
    #[must_use]
    pub fn role(&self) -> &str {
        match self {
            AgentMessage::Standard(Message::User(_)) => "user",
            AgentMessage::Standard(Message::Assistant(_)) => "assistant",
            AgentMessage::Standard(Message::ToolResult(_)) => "toolResult",
            AgentMessage::Custom(custom) => custom.role.as_str(),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        AgentMessage::Standard(Message::User(UserMessage {
            content: UserContent::Text(content.into()),
            timestamp: crate::now_ms(),
        }))
    }

    pub fn timestamp(&self) -> i64 {
        match self {
            AgentMessage::Standard(Message::User(m)) => m.timestamp,
            AgentMessage::Standard(Message::Assistant(m)) => m.timestamp,
            AgentMessage::Standard(Message::ToolResult(m)) => m.timestamp,
            // Custom messages carry arbitrary payloads; a missing/absent
            // timestamp property reads as 0.
            AgentMessage::Custom(m) => m
                .payload
                .get("timestamp")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0),
        }
    }
}

impl From<Message> for AgentMessage {
    fn from(m: Message) -> Self {
        AgentMessage::Standard(m)
    }
}

impl From<AssistantMessage> for AgentMessage {
    fn from(m: AssistantMessage) -> Self {
        AgentMessage::Standard(Message::Assistant(m))
    }
}

impl From<ToolResultMessage> for AgentMessage {
    fn from(m: ToolResultMessage) -> Self {
        AgentMessage::Standard(Message::ToolResult(m))
    }
}

impl From<UserMessage> for AgentMessage {
    fn from(m: UserMessage) -> Self {
        AgentMessage::Standard(Message::User(m))
    }
}

/// Minimal model descriptor the loop needs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Model {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub api: String,
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub cost: UsageCost,
    #[serde(rename = "contextWindow", default)]
    pub context_window: u64,
    #[serde(rename = "maxTokens", default)]
    pub max_tokens: u64,
}

impl Model {
    #[must_use]
    pub fn unknown() -> Self {
        Model {
            id: "unknown".into(),
            name: "unknown".into(),
            api: "unknown".into(),
            provider: "unknown".into(),
            base_url: String::new(),
            reasoning: false,
            cost: UsageCost::default(),
            context_window: 0,
            max_tokens: 0,
        }
    }
}

/// Final or partial result produced by a tool.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct AgentToolResult {
    pub content: Vec<ToolResultContent>,
    #[serde(default)]
    pub details: serde_json::Value,
    /// Hint that the agent should stop after the current tool batch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminate: Option<bool>,
}

impl AgentToolResult {
    pub fn text(s: impl Into<String>) -> Self {
        AgentToolResult {
            content: vec![ToolResultContent::text(s)],
            details: serde_json::Value::Null,
            terminate: None,
        }
    }

    pub fn error(s: impl Into<String>) -> Self {
        AgentToolResult {
            content: vec![ToolResultContent::text(s)],
            details: serde_json::Value::Object(serde_json::Map::new()),
            terminate: None,
        }
    }
}

/// Callback used by tools to publish partial execution updates.
pub type AgentToolUpdateCallback = Arc<dyn Fn(AgentToolResult) + Send + Sync>;

/// Tool definition used by the agent runtime.
///
/// The schema is a plain JSON Schema `Value` (TS validates against a `TypeBox`
/// schema); validation runs through [`crate::validation`], the subset of
/// JSON Schema the product's tool schemas use.
pub trait AgentTool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters(&self) -> &serde_json::Value;
    fn label(&self) -> &str {
        self.name()
    }
    /// Optional compatibility shim for raw tool-call arguments before schema
    /// validation. Return `None` to keep the arguments unchanged.
    fn prepare_arguments(&self, _args: &serde_json::Value) -> Option<serde_json::Value> {
        None
    }
    /// Execute the tool call. Return `Err` on failure instead of encoding
    /// errors in `content`, like a `throw` in the TS reference.
    fn execute(
        self: Arc<Self>,
        tool_call_id: String,
        params: serde_json::Value,
        signal: AbortSignal,
        on_update: AgentToolUpdateCallback,
    ) -> BoxFut<'static, anyhow::Result<AgentToolResult>>;
    fn execution_mode(&self) -> Option<ToolExecutionMode> {
        None
    }
}

/// Context snapshot passed to the low-level agent loop and tool hooks.
#[derive(Clone, Default)]
pub struct AgentContext {
    pub system_prompt: String,
    pub messages: Vec<AgentMessage>,
    pub tools: Vec<Arc<dyn AgentTool>>,
}

/// Events emitted by the agent loop.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    AgentStart,
    /// Last event of a run; carries all messages produced by the run.
    AgentEnd {
        messages: Vec<AgentMessage>,
    },
    TurnStart,
    TurnEnd {
        message: AgentMessage,
        tool_results: Vec<ToolResultMessage>,
    },
    MessageStart {
        message: AgentMessage,
    },
    /// Only emitted for assistant messages during streaming. The message
    /// and the delta event are shared snapshots: a listener clone bumps two
    /// references instead of deep-copying the partial.
    MessageUpdate {
        message: Arc<AgentMessage>,
        assistant_message_event: Arc<crate::stream::AssistantMessageEvent>,
    },
    MessageEnd {
        message: AgentMessage,
    },
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        args: serde_json::Value,
    },
    ToolExecutionUpdate {
        tool_call_id: String,
        tool_name: String,
        args: serde_json::Value,
        partial_result: AgentToolResult,
    },
    ToolExecutionEnd {
        tool_call_id: String,
        tool_name: String,
        result: AgentToolResult,
        is_error: bool,
    },
}

/// Result returned from `beforeToolCall`: `block: true` prevents execution and
/// the loop emits an error tool result with `reason` instead.
#[derive(Debug, Clone, Default)]
pub struct BeforeToolCallResult {
    pub block: bool,
    pub reason: Option<String>,
}

/// Partial override returned from `afterToolCall` (field-by-field merge, no
/// deep merge; `None` keeps the original executed value).
#[derive(Debug, Clone, Default)]
pub struct AfterToolCallResult {
    pub content: Option<Vec<ToolResultContent>>,
    pub details: Option<serde_json::Value>,
    pub is_error: Option<bool>,
    /// Hint that the agent should stop after the current tool batch. Early
    /// termination only happens when every finalized tool result in the batch
    /// sets this to true.
    pub terminate: Option<bool>,
}

/// Context passed to `beforeToolCall` after arguments are validated.
#[derive(Clone)]
pub struct BeforeToolCallContext {
    pub assistant_message: AssistantMessage,
    pub tool_call: ToolCall,
    pub args: serde_json::Value,
    pub context: AgentContext,
}

#[derive(Clone)]
pub struct AfterToolCallContext {
    pub assistant_message: AssistantMessage,
    pub tool_call: ToolCall,
    pub args: serde_json::Value,
    pub result: AgentToolResult,
    pub is_error: bool,
    pub context: AgentContext,
}

/// Context passed to `should_stop_after_turn` and `get_continuation_messages`.
#[derive(Clone)]
pub struct ShouldStopAfterTurnContext {
    pub message: AssistantMessage,
    pub tool_results: Vec<ToolResultMessage>,
    pub context: AgentContext,
    /// Messages returned by this invocation; prompts include initial prompts,
    /// continuations exclude prior context.
    pub new_messages: Vec<AgentMessage>,
}

pub type GetContinuationMessagesContext = ShouldStopAfterTurnContext;
