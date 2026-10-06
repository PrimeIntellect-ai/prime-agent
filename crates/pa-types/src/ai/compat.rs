//! The model-compat family: the OpenAI-completions compat block, the format enums, the
//! OpenAI-responses and Anthropic compat blocks, and the `ModelCompat`/`CompatKind` descriptor.
use super::{Deserialize, JsonMap, OpenRouterRouting, Serialize, Value, VercelGatewayRouting};

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

/// Compatibility settings for `OpenAI` Responses APIs.
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

/// TS models `Model.compat` as an API-dependent conditional type; on the wire it is one of the
/// three
/// compat objects, all with optional fields, so the variant cannot be tagged. This wrapper keeps
/// the
/// raw object and offers typed views: [`ModelCompat::kind`] sniffs distinctive keys and decodes the
/// matching struct, [`ModelCompat::from_kind`] encodes one back.
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
    /// Build a [`ModelCompat`] from a typed compat value.
    ///
    /// # Panics
    ///
    /// Panics if serializing `kind` to a JSON value fails or if that value is not a JSON object.
    /// Both are unreachable for the current compat structs, which serialize to plain JSON objects.
    /// Workspace API consumed across crates; the by-value signature is fleet-wide.
    #[allow(clippy::needless_pass_by_value)]
    #[must_use]
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

    /// Decode the raw object into the typed compat struct its keys select; shared-only keys encode
    /// identically everywhere, and the completions shape is the fallback (the common case for
    /// OpenAI-compatible providers).
    ///
    /// # Errors
    ///
    /// Returns the `serde_json` error when the raw object does not deserialize into the compat
    /// struct its keys selected.
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
