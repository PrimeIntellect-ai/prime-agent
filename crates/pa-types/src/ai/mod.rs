//! Model-facing AI message surface, ported from `packages/ai/src/types.ts`.
//!
//! Field names and JSON shapes match the TypeScript wire format exactly
//! (camelCase keys, `type`-tagged content blocks, `role`-tagged messages).

pub mod thinking_levels;

pub use thinking_levels::{
    clamp_thinking_level, get_supported_thinking_levels, models_are_equal, thinking_level_from_str,
    thinking_level_index, thinking_level_map, EXTENDED_THINKING_LEVELS, SUPPORTED_THINKING_LEVELS,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{JsNumber, JsonMap};

// ---------------------------------------------------------------------------
// APIs and providers
// ---------------------------------------------------------------------------

/// APIs with first-class support in the TS provider registry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KnownApi {
    OpenaiCompletions,
    MistralConversations,
    OpenaiResponses,
    AzureOpenaiResponses,
    OpenaiCodexResponses,
    AnthropicMessages,
    BedrockConverseStream,
    GoogleGenerativeAi,
    GoogleVertex,
}

/// TS `Api = KnownApi | (string & {})`. The wire value is an arbitrary string.
pub type Api = String;

/// The Prime Inference provider id (the bundled/live catalog's provider
/// key; a wire identifier shared by every crate that names it).
pub const PRIME_INFERENCE_PROVIDER_ID: &str = "prime-inference";

/// Providers with well-known identifiers in the TS model registry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KnownProvider {
    #[serde(rename = "amazon-bedrock")]
    AmazonBedrock,
    Anthropic,
    Google,
    #[serde(rename = "google-vertex")]
    GoogleVertex,
    Openai,
    #[serde(rename = "azure-openai-responses")]
    AzureOpenaiResponses,
    #[serde(rename = "openai-codex")]
    OpenaiCodex,
    #[serde(rename = "prime-inference")]
    PrimeInference,
    Deepseek,
    #[serde(rename = "github-copilot")]
    GithubCopilot,
    Xai,
    Groq,
    Cerebras,
    Openrouter,
    #[serde(rename = "vercel-ai-gateway")]
    VercelAiGateway,
    Zai,
    Mistral,
    Minimax,
    #[serde(rename = "minimax-cn")]
    MinimaxCn,
    Moonshotai,
    #[serde(rename = "moonshotai-cn")]
    MoonshotaiCn,
    Huggingface,
    Fireworks,
    Opencode,
    #[serde(rename = "opencode-go")]
    OpencodeGo,
    #[serde(rename = "kimi-coding")]
    KimiCoding,
    #[serde(rename = "cloudflare-workers-ai")]
    CloudflareWorkersAi,
    #[serde(rename = "cloudflare-ai-gateway")]
    CloudflareAiGateway,
    Xiaomi,
    #[serde(rename = "xiaomi-token-plan-cn")]
    XiaomiTokenPlanCn,
    #[serde(rename = "xiaomi-token-plan-ams")]
    XiaomiTokenPlanAms,
    #[serde(rename = "xiaomi-token-plan-sgp")]
    XiaomiTokenPlanSgp,
}

/// TS `Provider = KnownProvider | string`.
pub type Provider = String;

// ---------------------------------------------------------------------------
// Thinking levels
// ---------------------------------------------------------------------------

/// Reasoning effort levels accepted by the model-facing surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// `ThinkingLevel` plus the explicit `off` value used by agent state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl ModelThinkingLevel {
    /// The wire name shared by the `thinkingLevelMap` keys, the CLI
    /// `--thinking` values, and the daemon `create` config (`"off"`,
    /// `"minimal"`, ...).
    pub fn wire_name(self) -> &'static str {
        match self {
            ModelThinkingLevel::Off => "off",
            ModelThinkingLevel::Minimal => "minimal",
            ModelThinkingLevel::Low => "low",
            ModelThinkingLevel::Medium => "medium",
            ModelThinkingLevel::High => "high",
            ModelThinkingLevel::Xhigh => "xhigh",
            ModelThinkingLevel::Max => "max",
        }
    }
}

/// Maps Prime Agent thinking levels to provider/model-specific values.
/// `None` values mark a level as unsupported.
///
/// Ordered (`BTreeMap`): the map serializes into wire JSON (the model
/// catalog) and unordered iteration would leak random key order into the
/// bytes.
pub type ThinkingLevelMap = std::collections::BTreeMap<ModelThinkingLevel, Option<String>>;

/// Token budgets for each thinking level (token-based providers only).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingBudgets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimal: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub low: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub medium: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub high: Option<u64>,
}

// ---------------------------------------------------------------------------
// Provider options
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CacheRetention {
    None,
    Short,
    Long,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Transport {
    Sse,
    Websocket,
    #[serde(rename = "websocket-cached")]
    WebsocketCached,
    Auto,
}

/// TS `ServiceTier = "auto" | "default" | "flex" | "scale" | "priority" | null`.
/// The wire value can be absent or an explicit null, both mapping to `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceTier {
    Auto,
    Default,
    Flex,
    Scale,
    Priority,
}

/// HTTP response metadata handed to the `onResponse` hook.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderResponse {
    pub status: u16,
    /// Ordered (`BTreeMap`): response metadata can serialize into failure
    /// diagnostics on the wire; unordered iteration would leak random key
    /// order into the bytes.
    pub headers: std::collections::BTreeMap<String, String>,
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

/// Text content block (`type: "text"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextContent {
    pub text: String,
    /// OpenAI Responses message metadata: a legacy id string or a
    /// [`TextSignatureV1`] JSON payload (TS wire key `textSignature`; the
    /// camelCase rename keeps the provider signature attached to the block
    /// across the pa-ai <-> pa-agent wire-shape round trips, which have no
    /// catch-all field to carry a dropped key through).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_signature: Option<String>,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// OpenAI Responses text signature payload (`textSignature` holds its JSON).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSignatureV1 {
    pub v: u32,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<TextSignaturePhase>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextSignaturePhase {
    Commentary,
    FinalAnswer,
}

/// Thinking content block (`type: "thinking"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingContent {
    pub thinking: String,
    /// Provider reasoning item id (e.g. OpenAI Responses), or the encoded
    /// reasoning-details payload for redacted blocks. TS wire key
    /// `thinkingSignature`; the camelCase rename keeps the provider
    /// signature attached to the block across the pa-ai <-> pa-agent
    /// wire-shape round trips (pa-agent has no catch-all field, so a
    /// snake_case key was silently dropped there) and matches the TS
    /// product's session files and event frames.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_signature: Option<String>,
    /// True when the thinking content was redacted by safety filters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted: Option<bool>,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// Image content block (`type: "image"`); data is base64.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageContent {
    pub data: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// Tool call content block (`type: "toolCall"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: JsonMap,
    /// Google-specific opaque signature for reusing thought context (TS
    /// wire key `thoughtSignature`; see [`ThinkingContent`] for why the
    /// camelCase rename must match pa-agent's).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// Content blocks allowed in user and tool-result messages.
///
/// The tagged forms (`type: "text"` / `type: "image"`) are the TS wire
/// contract, but live session files also carry text blocks written without a
/// `type` tag (earlier daemon builds persisted `{"text": ...}` directly), and
/// newer builds may write block kinds this version does not model. Any block
/// that is not a well-formed known variant is preserved verbatim as
/// [`UserContentBlock::Raw`] so a session load never fails on an unknown
/// shape and every entry round-trips losslessly - the same catch-all
/// contract [`crate::session::FileEntry`] applies to whole entries.
#[derive(Debug, Clone, PartialEq)]
pub enum UserContentBlock {
    Text(TextContent),
    Image(ImageContent),
    /// Un-modeled block: a missing or unknown `type` tag, or any other JSON
    /// shape that is not a known variant. Serialized verbatim.
    Raw(Value),
}

impl Serialize for UserContentBlock {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Text(text) => serialize_tagged_block("text", text, serializer),
            Self::Image(image) => serialize_tagged_block("image", image, serializer),
            Self::Raw(value) => value.serialize(serializer),
        }
    }
}

/// Serialize a known block as its flat wire object: the content fields plus
/// the `type` tag (same output as the derived `#[serde(tag = "type")]` form).
fn serialize_tagged_block<T: Serialize, S: serde::Serializer>(
    tag: &str,
    content: &T,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let mut value = serde_json::to_value(content)
        .map_err(|e| <S::Error as serde::ser::Error>::custom(e.to_string()))?;
    let Some(map) = value.as_object_mut() else {
        return Err(<S::Error as serde::ser::Error>::custom(
            "content block must serialize to an object",
        ));
    };
    map.insert("type".to_string(), Value::String(tag.to_string()));
    value.serialize(serializer)
}

impl<'de> Deserialize<'de> for UserContentBlock {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let Some(kind) = value.get("type").and_then(Value::as_str) else {
            return Ok(Self::Raw(value));
        };
        let payload = strip_block_tag(&value);
        match kind {
            "text" => serde_json::from_value::<TextContent>(payload)
                .map(Self::Text)
                .map_err(|e| <D::Error as serde::de::Error>::custom(e.to_string())),
            "image" => serde_json::from_value::<ImageContent>(payload)
                .map(Self::Image)
                .map_err(|e| <D::Error as serde::de::Error>::custom(e.to_string())),
            _ => Ok(Self::Raw(value)),
        }
    }
}

/// Copy of the block without its `type` tag, so the tag is not captured
/// into the content catch-all map (the derived tagged form consumed it the
/// same way and never exposed it in `rest`).
fn strip_block_tag(value: &Value) -> Value {
    let mut payload = value.clone();
    if let Some(map) = payload.as_object_mut() {
        map.remove("type");
    }
    payload
}

impl UserContentBlock {
    /// Text carried by this block for provider payload conversion: the modeled
    /// text, or the `text` string of an un-modeled block (live session files
    /// carry bare `{"text": ...}` blocks with no `type` tag, and a provider
    /// prompt must not silently lose them). Image blocks and raw blocks
    /// without a `text` field return `None`. TS display paths stay
    /// tag-strict ([`UserContent::text`] does not use this helper).
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::Text(content) => Some(content.text.as_str()),
            Self::Image(_) => None,
            Self::Raw(raw) => raw.get("text").and_then(Value::as_str),
        }
    }

    /// Base64 image data and mime type carried by this block for provider
    /// payload conversion: the modeled image, or the `data`/`mimeType`
    /// fields of an un-modeled block.
    pub fn image(&self) -> Option<(&str, &str)> {
        match self {
            Self::Image(content) => Some((content.data.as_str(), content.mime_type.as_str())),
            Self::Text(_) => None,
            Self::Raw(raw) => {
                let data = raw.get("data").and_then(Value::as_str)?;
                let mime_type = raw.get("mimeType").and_then(Value::as_str)?;
                Some((data, mime_type))
            }
        }
    }
}

/// Content blocks allowed in assistant messages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AssistantContentBlock {
    Text(TextContent),
    Thinking(ThinkingContent),
    ToolCall(ToolCall),
}

/// User/tool-result content: a plain string or a list of text/image blocks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UserContent {
    Text(String),
    Blocks(Vec<UserContentBlock>),
}

impl UserContent {
    /// Concatenated text of all text blocks (string content is returned as-is).
    ///
    /// Tag-strict like the TS text extraction (`block.type === "text"`):
    /// un-modeled [`UserContentBlock::Raw`] blocks contribute nothing here
    /// even when they carry a bare `text` field.
    pub fn text(&self) -> String {
        match self {
            UserContent::Text(text) => text.clone(),
            UserContent::Blocks(blocks) => blocks
                .iter()
                .filter_map(|b| match b {
                    UserContentBlock::Text(t) => Some(t.text.clone()),
                    UserContentBlock::Image(_) | UserContentBlock::Raw(_) => None,
                })
                .collect::<Vec<_>>()
                .join(" "),
        }
    }
}

// ---------------------------------------------------------------------------
// Usage and stop reasons
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCost {
    pub input: JsNumber,
    pub output: JsNumber,
    #[serde(rename = "cacheRead")]
    pub cache_read: JsNumber,
    #[serde(rename = "cacheWrite")]
    pub cache_write: JsNumber,
    pub total: JsNumber,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    #[serde(rename = "cacheRead")]
    pub cache_read: u64,
    #[serde(rename = "cacheWrite")]
    pub cache_write: u64,
    #[serde(rename = "totalTokens")]
    pub total_tokens: u64,
    pub cost: UsageCost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Stop,
    Length,
    /// Terminal reason of a turn that ended in tool calls. Deserialization
    /// also accepts the raw OpenAI wire value `tool_calls` (TS's loader
    /// keeps any `stopReason` string, so a session file written by the TS
    /// product or a foreign tool never loses its assistant rows).
    #[serde(alias = "tool_calls")]
    ToolUse,
    Error,
    Aborted,
}

/// Terminal reason of a successful stream (`done` events).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DoneStopReason {
    Stop,
    Length,
    ToolUse,
}

/// Terminal reason of a failed stream (`error` events).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorStopReason {
    Aborted,
    Error,
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum Message {
    User(UserMessage),
    Assistant(AssistantMessage),
    ToolResult(ToolResultMessage),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessage {
    pub content: UserContent,
    /// Unix timestamp in milliseconds.
    pub timestamp: u64,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// One redacted provider/runtime diagnostic attached to an assistant message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessageDiagnostic {
    #[serde(rename = "type")]
    pub type_: String,
    pub timestamp: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<DiagnosticErrorInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<JsonMap>,
}

/// Error info captured inside a diagnostic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticErrorInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    /// TS `string | number`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<DiagnosticCode>,
    #[serde(flatten)]
    pub rest: JsonMap,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DiagnosticCode {
    Str(String),
    Num(JsNumber),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessage {
    pub content: Vec<AssistantContentBlock>,
    pub api: Api,
    pub provider: Provider,
    pub model: String,
    /// Concrete `chunk.model` when different from the requested model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_model: Option<String>,
    /// Provider-specific response identifier, when exposed upstream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
    /// Redacted provider/runtime diagnostics for failures and recoveries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Vec<AssistantMessageDiagnostic>>,
    pub usage: Usage,
    pub stop_reason: StopReason,
    /// Provider's raw stop/finish reason when it mapped to `"error"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason_raw: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// Unix timestamp in milliseconds.
    pub timestamp: u64,
    #[serde(flatten)]
    pub rest: JsonMap,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultMessage {
    pub tool_call_id: String,
    /// The tool's name. The product always writes it, but a session file
    /// from a foreign tool or an older build may omit it — the TS loader
    /// keeps such rows (an undefined name renders empty), so the field
    /// defaults instead of degrading the whole entry. An empty name is not
    /// re-serialized, keeping the round trip lossless against the source.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tool_name: String,
    pub content: Vec<UserContentBlock>,
    /// Structured details for logs or UI rendering.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(rename = "isError")]
    pub is_error: bool,
    /// Unix timestamp in milliseconds.
    pub timestamp: u64,
    #[serde(flatten)]
    pub rest: JsonMap,
}

// ---------------------------------------------------------------------------
// Tools and context
// ---------------------------------------------------------------------------

/// Tool definition sent to providers. `parameters` is a TypeBox/JSON schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

/// Conversation context handed to a provider stream call.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Tool>>,
}

// ---------------------------------------------------------------------------
// Stream events
// ---------------------------------------------------------------------------

/// Event protocol for assistant message streams.
///
/// Streams emit `start` before partial updates, then terminate with either
/// `done` (success) or `error` (`stopReason` `"error"`/`"aborted"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AssistantMessageEvent {
    Start {
        partial: AssistantMessage,
    },
    TextStart {
        content_index: u64,
        partial: AssistantMessage,
    },
    TextDelta {
        content_index: u64,
        delta: String,
        partial: AssistantMessage,
    },
    TextEnd {
        content_index: u64,
        content: String,
        partial: AssistantMessage,
    },
    ThinkingStart {
        content_index: u64,
        partial: AssistantMessage,
    },
    ThinkingDelta {
        content_index: u64,
        delta: String,
        partial: AssistantMessage,
    },
    ThinkingEnd {
        content_index: u64,
        content: String,
        partial: AssistantMessage,
    },
    ToolcallStart {
        content_index: u64,
        partial: AssistantMessage,
    },
    ToolcallDelta {
        content_index: u64,
        delta: String,
        partial: AssistantMessage,
    },
    ToolcallEnd {
        content_index: u64,
        tool_call: ToolCall,
        partial: AssistantMessage,
    },
    Done {
        reason: DoneStopReason,
        message: AssistantMessage,
    },
    Error {
        reason: ErrorStopReason,
        error: AssistantMessage,
    },
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCost {
    /// $/million tokens.
    pub input: JsNumber,
    pub output: JsNumber,
    #[serde(rename = "cacheRead")]
    pub cache_read: JsNumber,
    #[serde(rename = "cacheWrite")]
    pub cache_write: JsNumber,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelInput {
    Text,
    Image,
}

/// Compatibility settings for OpenAI-compatible completions APIs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiCompletionsCompat {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_store: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_developer_role: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_reasoning_effort: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_usage_in_streaming: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens_field: Option<MaxTokensField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_tool_result_name: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_assistant_after_tool_result: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_thinking_as_text: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_reasoning_content_on_assistant_messages: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_format: Option<ThinkingFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_router_routing: Option<OpenRouterRouting>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vercel_gateway_routing: Option<VercelGatewayRouting>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zai_tool_stream: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_strict_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_control_format: Option<CacheControlFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_session_affinity_headers: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_long_cache_retention: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaxTokensField {
    MaxCompletionTokens,
    MaxTokens,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThinkingFormat {
    Openai,
    Openrouter,
    Deepseek,
    Zai,
    Qwen,
    #[serde(rename = "qwen-chat-template")]
    QwenChatTemplate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheControlFormat {
    Anthropic,
}

/// Compatibility settings for OpenAI Responses APIs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiResponsesCompat {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_session_id_header: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_long_cache_retention: Option<bool>,
}

/// Compatibility settings for Anthropic Messages-compatible APIs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicMessagesCompat {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_eager_tool_input_streaming: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_long_cache_retention: Option<bool>,
}

/// TS models `Model.compat` as an API-dependent conditional type. On the wire
/// it is one of the three compat objects, all with optional fields, so the
/// variant cannot be tagged. serde's `flatten` also cannot carry nested
/// untagged enums, so this wrapper keeps the raw object and offers typed
/// views: [`ModelCompat::kind`] sniffs distinctive keys and decodes into the
/// matching typed struct, and [`ModelCompat::from_kind`] encodes one back.
/// Keeping the raw object makes wire round-trips exactly lossless.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ModelCompat {
    pub raw: JsonMap,
}

const ANTHROPIC_COMPAT_KEYS: &[&str] = &["supportsEagerToolInputStreaming"];
const RESPONSES_COMPAT_KEYS: &[&str] = &["sendSessionIdHeader"];
/// Which compat object a `Model.compat` wire value carries.
#[derive(Debug, Clone, PartialEq)]
pub enum CompatKind {
    AnthropicMessages(AnthropicMessagesCompat),
    OpenAiResponses(OpenAiResponsesCompat),
    OpenAiCompletions(Box<OpenAiCompletionsCompat>),
}

impl ModelCompat {
    pub fn from_kind(kind: CompatKind) -> Self {
        let value = match &kind {
            CompatKind::AnthropicMessages(c) => serde_json::to_value(c),
            CompatKind::OpenAiResponses(c) => serde_json::to_value(c),
            CompatKind::OpenAiCompletions(c) => serde_json::to_value(c.as_ref()),
        }
        .expect("compat structs serialize to JSON");
        let Value::Object(map) = value else {
            unreachable!("compat structs serialize to JSON objects");
        };
        ModelCompat { raw: map }
    }

    /// Decode the raw object into the typed compat struct its keys select.
    /// When only shared keys (e.g. `supportsLongCacheRetention`) are present,
    /// every shape encodes them identically; the completions shape is the
    /// fallback because it is the common case for OpenAI-compatible providers.
    pub fn kind(&self) -> Result<CompatKind, serde_json::Error> {
        let has_key = |keys: &[&str]| keys.iter().any(|k| self.raw.contains_key(*k));
        let value = Value::Object(self.raw.clone());
        if has_key(ANTHROPIC_COMPAT_KEYS) {
            Ok(CompatKind::AnthropicMessages(serde_json::from_value(
                value,
            )?))
        } else if has_key(RESPONSES_COMPAT_KEYS) {
            Ok(CompatKind::OpenAiResponses(serde_json::from_value(value)?))
        } else {
            Ok(CompatKind::OpenAiCompletions(Box::new(
                serde_json::from_value(value)?,
            )))
        }
    }
}

/// OpenRouter provider routing preferences (`provider` request field).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterRouting {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_fallbacks: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_parameters: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_collection: Option<DataCollection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zdr: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enforce_distillable_text: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub only: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignore: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quantizations: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<OpenRouterSort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_price: Option<OpenRouterMaxPrice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_min_throughput: Option<OpenRouterThreshold>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_max_latency: Option<OpenRouterThreshold>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataCollection {
    Deny,
    Allow,
}

/// OpenRouter sort strategy: a string metric or a partitioned object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OpenRouterSort {
    Metric(String),
    Detailed {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        partition: Option<String>,
    },
}

/// OpenRouter price cap, with string-or-number fields as in the upstream API.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterMaxPrice {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<NumOrString>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion: Option<NumOrString>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<NumOrString>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<NumOrString>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<NumOrString>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum NumOrString {
    Num(JsNumber),
    Str(String),
}

/// OpenRouter percentile threshold: a scalar or a percentile map.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OpenRouterThreshold {
    Scalar(JsNumber),
    Percentiles {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        p50: Option<JsNumber>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        p75: Option<JsNumber>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        p90: Option<JsNumber>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        p99: Option<JsNumber>,
    },
}

/// Vercel AI Gateway routing preferences.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VercelGatewayRouting {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub only: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<Vec<String>>,
}

/// Unified model descriptor for the model registry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
    pub api: Api,
    pub provider: Provider,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub reasoning: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level_map: Option<ThinkingLevelMap>,
    pub input: Vec<ModelInput>,
    pub cost: ModelCost,
    #[serde(rename = "contextWindow")]
    pub context_window: u64,
    #[serde(rename = "maxTokens")]
    pub max_tokens: u64,
    /// Flagship model surfaced above non-featured models of the same provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub featured: Option<bool>,
    /// Extra request headers. Ordered (`BTreeMap`): the model serializes
    /// into wire JSON (the model catalog) and unordered iteration would
    /// leak random key order into the bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::BTreeMap<String, String>>,
    /// Compatibility overrides; auto-detected from `baseUrl` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<ModelCompat>,
}

/// TS `supportsFastMode`: the fast-mode (priority) service tier exists on
/// gpt-5.4/5.5/5.6 models served over the OpenAI Responses APIs. Shared by
/// the surfaces that gate the `/fast` command on model eligibility (the TS
/// product keeps the same function in the shared AI package).
pub fn supports_fast_mode(model: &Model) -> bool {
    let eligible_id = model.id == "gpt-5.4"
        || model.id == "gpt-5.5"
        || model.id == "gpt-5.6"
        || model.id.starts_with("gpt-5.6-");
    eligible_id
        && ((model.provider == "openai-codex" && model.api == "openai-codex-responses")
            || (model.provider == "openai" && model.api == "openai-responses"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt<T: serde::Serialize + for<'de> Deserialize<'de>>(json: &str) -> String {
        let parsed: T = serde_json::from_str(json).expect("deserialize");
        serde_json::to_string(&parsed).expect("serialize")
    }

    fn assert_roundtrip<T: serde::Serialize + for<'de> Deserialize<'de>>(json: &str) {
        let original: Value = serde_json::from_str(json).unwrap();
        let out = rt::<T>(json);
        let reparsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(original, reparsed, "round trip changed the value: {out}");
    }

    #[test]
    fn user_message_content_string_or_blocks() {
        assert_roundtrip::<Message>(r#"{"role":"user","content":"hello","timestamp":1}"#);
        assert_roundtrip::<Message>(
            r#"{"role":"user","content":[{"type":"text","text":"a"},{"type":"image","data":"QQ==","mimeType":"image/png"}],"timestamp":2}"#,
        );
    }

    #[test]
    fn assistant_message_roundtrip_and_unknown_fields() {
        assert_roundtrip::<Message>(
            r#"{"role":"assistant","content":[{"type":"thinking","thinking":"t","thinkingSignature":"r","redacted":false},{"type":"toolCall","id":"1","name":"bash","arguments":{"code":"ls"},"thoughtSignature":"g"},{"type":"text","text":"done","textSignature":"{\"v\":1,\"id\":\"x\"}"}],"api":"openai-completions","provider":"p","model":"m","responseModel":"m2","responseId":"rid","usage":{"input":1,"output":2,"cacheRead":3,"cacheWrite":4,"totalTokens":10,"cost":{"input":0.5,"output":0.25,"cacheRead":0,"cacheWrite":0,"total":0.75}},"stopReason":"toolUse","stopReasonRaw":"stop_sequence","timestamp":9,"future":"kept"}"#,
        );
    }

    #[test]
    fn stream_event_roundtrip() {
        let msg = r#"{"role":"assistant","content":[],"api":"a","provider":"p","model":"m","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1}"#;
        assert_roundtrip::<AssistantMessageEvent>(&format!(
            r#"{{"type":"text_delta","contentIndex":3,"delta":"abc","partial":{msg}}}"#
        ));
        assert_roundtrip::<AssistantMessageEvent>(&format!(
            r#"{{"type":"done","reason":"toolUse","message":{msg}}}"#
        ));
        assert_roundtrip::<AssistantMessageEvent>(&format!(
            r#"{{"type":"error","reason":"aborted","error":{msg}}}"#
        ));
    }

    #[test]
    fn tool_result_message_roundtrip() {
        assert_roundtrip::<Message>(
            r#"{"role":"toolResult","toolCallId":"c1","toolName":"ipython","content":[{"type":"text","text":"out"}],"details":{"durationMs":3},"isError":false,"timestamp":4}"#,
        );
    }

    #[test]
    fn model_with_compat_roundtrip() {
        // Anthropic-flavored compat is recognized by its distinctive key.
        assert_roundtrip::<Model>(
            r#"{"id":"m","name":"M","api":"anthropic-messages","provider":"anthropic","baseUrl":"https://x","reasoning":true,"input":["text","image"],"cost":{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75},"contextWindow":200000,"maxTokens":8192,"thinkingLevelMap":{"minimal":null,"low":"low"},"compat":{"supportsEagerToolInputStreaming":false},"headers":{"x":"y"},"featured":true}"#,
        );
        // OpenAI-completions-flavored compat.
        assert_roundtrip::<Model>(
            r#"{"id":"m2","name":"M2","api":"openai-completions","provider":"p","baseUrl":"https://y","reasoning":false,"input":["text"],"cost":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0},"contextWindow":1000,"maxTokens":100,"compat":{"thinkingFormat":"openrouter","openRouterRouting":{"only":["a"],"sort":{"by":"price","partition":"model"},"max_price":{"prompt":"0.5","completion":2}}}}"#,
        );
    }

    #[test]
    fn user_content_untagged_text_block_roundtrips_losslessly() {
        // Live session files carry user text blocks without a `type` tag
        // (persisted by earlier daemon builds, e.g. session
        // 01a0abe1-ab24-73c0-b363-0cc4e4d6cc5f.jsonl line 4). The block must
        // deserialize and re-serialize verbatim, without injecting a tag.
        assert_roundtrip::<Message>(r#"{"role":"user","content":[{"text":"hi"}],"timestamp":3}"#);
    }

    #[test]
    fn user_content_unknown_block_kind_is_preserved() {
        // A block kind this version does not model (written by a newer
        // build) must never fail the load; it round-trips verbatim.
        assert_roundtrip::<Message>(
            r#"{"role":"user","content":[{"type":"video","url":"x","meta":{"a":1}}],"timestamp":4}"#,
        );
    }

    #[test]
    fn bare_block_payload_views() {
        let content: UserContent = serde_json::from_str(
            r#"[{"text":"hi"},{"type":"image","data":"QQ==","mimeType":"image/png"},{"type":"file","id":"f"}]"#,
        )
        .unwrap();
        // Tag-strict display text ignores un-modeled blocks, matching the TS
        // text extraction (`block.type === "text"`).
        assert_eq!(content.text(), "");
        let UserContent::Blocks(blocks) = content else {
            panic!("expected blocks");
        };
        // Provider payload views recover the bare text/image structurally.
        assert_eq!(blocks[0].text(), Some("hi"));
        assert_eq!(blocks[1].image(), Some(("QQ==", "image/png")));
        assert_eq!(blocks[2].text(), None);
        assert_eq!(blocks[2].image(), None);
    }

    #[test]
    fn user_content_text_helper() {
        let content: UserContent = serde_json::from_str(
            r#"[{"type":"text","text":"a b"},{"type":"image","data":"x","mimeType":"i"},{"type":"text","text":"c"}]"#,
        )
        .unwrap();
        assert_eq!(content.text(), "a b c");
    }
}
