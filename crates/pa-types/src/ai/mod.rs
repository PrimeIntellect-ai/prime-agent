//! Model-facing AI message surface, ported from `packages/ai/src/types.ts`.
//!
//! Field names and JSON shapes match the TypeScript wire format exactly
//! (camelCase keys, `type`-tagged content blocks, `role`-tagged messages).

pub mod thinking_levels;

pub use thinking_levels::{
    clamp_thinking_level, get_supported_thinking_levels, models_are_equal, supports_thinking,
    thinking_level_from_str, thinking_level_index, thinking_level_map, EXTENDED_THINKING_LEVELS,
    SUPPORTED_THINKING_LEVELS,
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
    #[must_use]
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
    /// `OpenAI` Responses message metadata: a legacy id string or a
    /// [`TextSignatureV1`] JSON payload (TS wire key `textSignature`; the
    /// camelCase rename keeps the provider signature attached to the block
    /// across the pa-ai <-> pa-agent wire-shape round trips, which have no
    /// catch-all field to carry a dropped key through).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_signature: Option<String>,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// `OpenAI` Responses text signature payload (`textSignature` holds its JSON).
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
    /// Provider reasoning item id (e.g. `OpenAI` Responses), or the encoded
    /// reasoning-details payload for redacted blocks. TS wire key
    /// `thinkingSignature`; the camelCase rename keeps the provider
    /// signature attached to the block across the pa-ai <-> pa-agent
    /// wire-shape round trips (pa-agent has no catch-all field, so a
    /// `snake_case` key was silently dropped there) and matches the TS
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
    #[must_use]
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
    /// also accepts the raw `OpenAI` wire value `tool_calls` (TS's loader
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
// The compatibility settings family (the OpenAI-completions compat block,
// the three format enums, the OpenAI-responses and Anthropic compat
// blocks, and ModelCompat/CompatKind) lives in the child module; every
// member keeps its pub level and the pub use re-exports keep every
// external ai:: path stable. ZERO bumps.
mod compat;
pub use compat::{
    AnthropicMessagesCompat, CacheControlFormat, CompatKind, MaxTokensField, ModelCompat,
    OpenAiCompletionsCompat, OpenAiResponsesCompat, ThinkingFormat,
};

// The routing family (the OpenRouter routing block with its sort/max-
// price/threshold types and the Vercel gateway routing) lives in the
// child module; every member keeps its pub level and the pub use
// re-exports keep every external ai:: path stable. ZERO bumps.
mod routing;
pub use routing::{
    DataCollection, NumOrString, OpenRouterMaxPrice, OpenRouterRouting, OpenRouterSort,
    OpenRouterThreshold, VercelGatewayRouting,
};
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

/// TS `supportsServiceTier` over the eligibility fields: whether a
/// provider accepts (and honors) a requested service tier. The
/// Model-typed [`supports_service_tier`] delegates here so the surfaces
/// that only hold the connection-state model metadata (provider, api, id)
/// share one predicate.
#[must_use]
pub fn supports_service_tier_fields(
    provider: &str,
    api: &str,
    model_id: &str,
    tier: ServiceTier,
) -> bool {
    if tier == ServiceTier::Default {
        return true;
    }
    // OpenRouter accepts top-level service_tier (flex|priority) for every
    // model, routes to matching tier endpoints where they exist, and bills
    // by the tier that actually served the request:
    // https://openrouter.ai/docs/guides/features/service-tiers
    if provider == "openrouter" && api == "openai-completions" {
        return matches!(tier, ServiceTier::Flex | ServiceTier::Priority);
    }
    let openai_responses = provider == "openai" && api == "openai-responses";
    let codex_responses = provider == "openai-codex" && api == "openai-codex-responses";
    if !openai_responses && !codex_responses {
        return false;
    }
    // "auto" defers the tier choice to OpenAI and is valid for every model
    // there; "scale" is entitlement-gated, so pass it through for callers
    // that have it.
    if matches!(tier, ServiceTier::Auto | ServiceTier::Scale) {
        return true;
    }
    let eligible_id = model_id == "gpt-5.4"
        || model_id == "gpt-5.5"
        || model_id == "gpt-5.6"
        || model_id == "gpt-6-astra"
        || model_id.starts_with("gpt-5.6-");
    if tier == ServiceTier::Priority {
        return eligible_id;
    }
    // Flex processing is an API-key feature; the ChatGPT (Codex OAuth)
    // backend has no flex tier.
    tier == ServiceTier::Flex && eligible_id && openai_responses
}

/// TS `supportsServiceTier`: whether a model's provider accepts (and
/// honors) a requested service tier. The single eligibility predicate
/// behind the `/tier` command, the settings row, and the `/fast` toggle
/// (the TS product keeps the same function in the shared AI package).
#[must_use]
pub fn supports_service_tier(model: &Model, tier: ServiceTier) -> bool {
    supports_service_tier_fields(&model.provider, &model.api, &model.id, tier)
}

/// TS `clampServiceTier`: clamp a requested tier to `default` when the
/// model does not support it. An absent model (a session with no resolved
/// model) clamps every non-default tier, exactly like the TS
/// `model == null` arm; an unset (`null`) preference passes through.
#[must_use]
pub fn clamp_service_tier(model: Option<&Model>, tier: Option<ServiceTier>) -> Option<ServiceTier> {
    match tier {
        None | Some(ServiceTier::Default) => tier,
        Some(tier) => model
            .is_some_and(|model| supports_service_tier(model, tier))
            .then_some(tier)
            .or(Some(ServiceTier::Default)),
    }
}

/// TS `supportsFastMode` (now `supportsServiceTier(model, "priority")`):
/// the fast-mode (priority) tier exists on the eligible ids served over
/// the `OpenAI` Responses APIs. Shared by the surfaces that gate the
/// `/fast` command on model eligibility.
#[must_use]
pub fn supports_fast_mode(model: &Model) -> bool {
    supports_service_tier(model, ServiceTier::Priority)
}

// The unit battery lives in the child module (ai::tests); its use-super
// glob resolves through this facade's bindings and re-exports.
#[cfg(test)]
mod tests;
