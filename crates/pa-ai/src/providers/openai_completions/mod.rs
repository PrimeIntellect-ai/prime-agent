//! `OpenAI` Chat Completions streaming provider.
//!
//! Full port of `packages/ai/src/providers/openai-completions.ts`, split
//! across submodules: compat detection and options here, message/tool/usage
//! conversion in [`convert`], params and header assembly in [`params`], the
//! SDK-shaped user-facing error surface in [`errors`], and the chunk-driven
//! streaming core in [`stream`]. Compat detection
//! (provider/baseUrl heuristics plus explicit `model.compat`) and reasoning
//! effort mapping live here.

use serde_json::{json, Map, Value};

use crate::env_api_keys::get_env_api_key;
use crate::event_stream::{
    create_assistant_message_event_stream, AssistantMessageEvent, AssistantMessageEventStream,
};
use crate::models::clamp_thinking_level;
use crate::providers::simple_options::build_base_options;
use crate::registry::Provider;
use crate::types::{
    AssistantContent, AssistantMessage, CacheRetention, Context, Model, ModelExt,
    ModelThinkingLevel, SimpleStreamOptions, StopReason, StreamOptions, Usage, UsageCost,
};

mod convert;
mod errors;
mod params;
mod stream;

pub use stream::stream_openai_completions;

pub const API_OPENAI_COMPLETIONS: &str = "openai-completions";

const REASONING_DETAILS_SIGNATURE_TYPE: &str = "openai-completions.reasoning_details.v1";
pub(crate) const REASONING_FIELDS: [&str; 3] = ["reasoning_content", "reasoning", "reasoning_text"];

/// Tool selection passed to the API.
#[derive(Clone, Debug, PartialEq)]
#[allow(dead_code)] // full TS option surface; variants set by callers
pub enum ToolChoice {
    Auto,
    None,
    Required,
    Function { name: String },
}

impl ToolChoice {
    fn to_json(&self) -> Value {
        match self {
            ToolChoice::Auto => json!("auto"),
            ToolChoice::None => json!("none"),
            ToolChoice::Required => json!("required"),
            ToolChoice::Function { name } => json!({
                "type": "function",
                "function": { "name": name }
            }),
        }
    }
}

/// Provider-native options (`OpenAICompletionsOptions` in the TS reference).
#[derive(Clone, Default)]
pub struct OpenAICompletionsOptions {
    pub base: StreamOptions,
    pub tool_choice: Option<ToolChoice>,
    pub reasoning_effort: Option<ModelThinkingLevel>,
    /// Explicit reasoning toggle. `None` preserves the provider/model default.
    pub reasoning_enabled: Option<bool>,
}

impl OpenAICompletionsOptions {
    pub fn from_base(base: StreamOptions) -> Self {
        Self {
            base,
            tool_choice: None,
            reasoning_effort: None,
            reasoning_enabled: None,
        }
    }
}

/// Anthropic-style `cache_control` payload on OpenAI-compat proxies.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct OpenAICompatCacheControl {
    ttl: Option<&'static str>, // Some("1h") or None (default 5m)
}

impl OpenAICompatCacheControl {
    fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("type".into(), json!("ephemeral"));
        if let Some(ttl) = self.ttl {
            map.insert("ttl".into(), json!(ttl));
        }
        Value::Object(map)
    }
}

/// Fully resolved compat settings (`ResolvedOpenAICompletionsCompat`).
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedCompat {
    pub supports_store: bool,
    pub supports_developer_role: bool,
    pub supports_reasoning_effort: bool,
    pub supports_usage_in_streaming: bool,
    pub max_tokens_field: crate::types::MaxTokensField,
    pub requires_tool_result_name: bool,
    pub requires_assistant_after_tool_result: bool,
    pub requires_thinking_as_text: bool,
    pub requires_reasoning_content_on_assistant_messages: bool,
    pub thinking_format: crate::types::ThinkingFormat,
    pub supports_strict_mode: bool,
    pub cache_control_format: Option<crate::types::CacheControlFormat>,
    pub send_session_affinity_headers: bool,
    pub supports_long_cache_retention: bool,
    pub zai_tool_stream: bool,
    pub open_router_routing: Option<crate::types::OpenRouterRouting>,
    pub vercel_gateway_routing: Option<pa_types::ai::VercelGatewayRouting>,
}

/// Detect compatibility settings from provider and baseUrl for known providers.
/// Provider takes precedence over URL-based detection since it's explicitly configured.
pub fn detect_compat(model: &Model) -> ResolvedCompat {
    let provider = model.provider.as_str();
    let base_url = model.base_url.as_str();

    let is_zai = provider == "zai" || base_url.contains("api.z.ai");
    let is_moonshot = provider == "moonshotai"
        || provider == "moonshotai-cn"
        || base_url.contains("api.moonshot.");
    let is_cloudflare_workers_ai =
        provider == "cloudflare-workers-ai" || base_url.contains("api.cloudflare.com");
    let is_cloudflare_ai_gateway =
        provider == "cloudflare-ai-gateway" || base_url.contains("gateway.ai.cloudflare.com");
    let is_prime_inference =
        provider == "prime-inference" || base_url.contains("api.pinference.ai");

    let is_non_standard = provider == "cerebras"
        || base_url.contains("cerebras.ai")
        || provider == "xai"
        || base_url.contains("api.x.ai")
        || base_url.contains("chutes.ai")
        || base_url.contains("deepseek.com")
        || is_zai
        || is_moonshot
        || provider == "opencode"
        || base_url.contains("opencode.ai")
        || is_cloudflare_workers_ai
        || is_cloudflare_ai_gateway
        || is_prime_inference;

    let use_max_tokens = base_url.contains("chutes.ai")
        || is_moonshot
        || is_cloudflare_ai_gateway
        || is_prime_inference;

    let is_grok = provider == "xai" || base_url.contains("api.x.ai");
    let is_deep_seek = provider == "deepseek" || base_url.contains("deepseek.com");
    let is_anthropic_model = model.id.starts_with("anthropic/");
    let cache_control_format =
        if is_anthropic_model && (provider == "openrouter" || is_prime_inference) {
            Some(crate::types::CacheControlFormat::Anthropic)
        } else {
            None
        };

    ResolvedCompat {
        supports_store: !is_non_standard,
        supports_developer_role: !is_non_standard,
        supports_reasoning_effort: !is_grok && !is_zai && !is_moonshot && !is_cloudflare_ai_gateway,
        supports_usage_in_streaming: true,
        max_tokens_field: if use_max_tokens {
            crate::types::MaxTokensField::MaxTokens
        } else {
            crate::types::MaxTokensField::MaxCompletionTokens
        },
        requires_tool_result_name: false,
        requires_assistant_after_tool_result: false,
        requires_thinking_as_text: false,
        requires_reasoning_content_on_assistant_messages: is_deep_seek,
        thinking_format: if is_deep_seek {
            crate::types::ThinkingFormat::Deepseek
        } else if is_zai {
            crate::types::ThinkingFormat::Zai
        } else if provider == "openrouter" || base_url.contains("openrouter.ai") {
            crate::types::ThinkingFormat::Openrouter
        } else {
            crate::types::ThinkingFormat::Openai
        },
        open_router_routing: None,
        vercel_gateway_routing: None,
        zai_tool_stream: false,
        supports_strict_mode: !is_moonshot && !is_cloudflare_ai_gateway && !is_prime_inference,
        cache_control_format,
        send_session_affinity_headers: false,
        supports_long_cache_retention: !(is_cloudflare_workers_ai || is_cloudflare_ai_gateway),
    }
}

/// Resolve compat for a model: explicit `model.compat` fields override the
/// detected defaults.
pub fn get_compat(model: &Model) -> ResolvedCompat {
    let detected = detect_compat(model);
    let Some(compat) = model.compat_kind() else {
        return detected;
    };
    let crate::types::CompatKind::OpenAiCompletions(compat) = compat else {
        return detected;
    };
    let compat = compat.as_ref();
    ResolvedCompat {
        supports_store: compat.supports_store.unwrap_or(detected.supports_store),
        supports_developer_role: compat
            .supports_developer_role
            .unwrap_or(detected.supports_developer_role),
        supports_reasoning_effort: compat
            .supports_reasoning_effort
            .unwrap_or(detected.supports_reasoning_effort),
        supports_usage_in_streaming: compat
            .supports_usage_in_streaming
            .unwrap_or(detected.supports_usage_in_streaming),
        max_tokens_field: compat.max_tokens_field.unwrap_or(detected.max_tokens_field),
        requires_tool_result_name: compat
            .requires_tool_result_name
            .unwrap_or(detected.requires_tool_result_name),
        requires_assistant_after_tool_result: compat
            .requires_assistant_after_tool_result
            .unwrap_or(detected.requires_assistant_after_tool_result),
        requires_thinking_as_text: compat
            .requires_thinking_as_text
            .unwrap_or(detected.requires_thinking_as_text),
        requires_reasoning_content_on_assistant_messages: compat
            .requires_reasoning_content_on_assistant_messages
            .unwrap_or(detected.requires_reasoning_content_on_assistant_messages),
        thinking_format: compat.thinking_format.unwrap_or(detected.thinking_format),
        open_router_routing: compat
            .open_router_routing
            .clone()
            .or(detected.open_router_routing),
        vercel_gateway_routing: compat
            .vercel_gateway_routing
            .clone()
            .or(detected.vercel_gateway_routing),
        zai_tool_stream: compat.zai_tool_stream.unwrap_or(detected.zai_tool_stream),
        supports_strict_mode: compat
            .supports_strict_mode
            .unwrap_or(detected.supports_strict_mode),
        cache_control_format: compat
            .cache_control_format
            .or(detected.cache_control_format),
        send_session_affinity_headers: compat
            .send_session_affinity_headers
            .unwrap_or(detected.send_session_affinity_headers),
        supports_long_cache_retention: compat
            .supports_long_cache_retention
            .unwrap_or(detected.supports_long_cache_retention),
    }
}

pub fn resolve_cache_retention(cache_retention: Option<CacheRetention>) -> CacheRetention {
    if let Some(retention) = cache_retention {
        return retention;
    }
    if std::env::var("PI_CACHE_RETENTION").as_deref() == Ok("long") {
        return CacheRetention::Long;
    }
    CacheRetention::Short
}

pub(crate) fn get_compat_cache_control(
    compat: &ResolvedCompat,
    cache_retention: CacheRetention,
) -> Option<OpenAICompatCacheControl> {
    if compat.cache_control_format != Some(crate::types::CacheControlFormat::Anthropic)
        || cache_retention == CacheRetention::None
    {
        return None;
    }
    let ttl = if cache_retention == CacheRetention::Long && compat.supports_long_cache_retention {
        Some("1h")
    } else {
        None
    };
    Some(OpenAICompatCacheControl { ttl })
}

pub(crate) fn has_tool_history(messages: &[crate::types::Message]) -> bool {
    use crate::types::Message;
    for msg in messages {
        if let Message::ToolResult(_) = msg {
            return true;
        }
        if let Message::Assistant(assistant) = msg {
            if assistant
                .content
                .iter()
                .any(|block| matches!(block, AssistantContent::ToolCall(_)))
            {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Reasoning details signatures
// ---------------------------------------------------------------------------

pub(crate) fn encode_reasoning_details(details: &[Value]) -> String {
    json!({
        "type": REASONING_DETAILS_SIGNATURE_TYPE,
        "details": details,
    })
    .to_string()
}

pub(crate) fn decode_reasoning_details(signature: Option<&str>) -> Option<Vec<Value>> {
    let signature = signature?;
    if !signature.starts_with('{') {
        return None;
    }
    let parsed: Value = serde_json::from_str(signature).ok()?;
    if parsed.get("type")?.as_str()? != REASONING_DETAILS_SIGNATURE_TYPE {
        return None;
    }
    let details = parsed.get("details")?.as_array()?;
    for detail in details {
        if !detail.is_object() {
            return None;
        }
    }
    Some(details.clone())
}

/// Port of `streamSimpleOpenAICompletions`.
pub fn stream_simple_openai_completions(
    model: &Model,
    context: &Context,
    options: Option<&SimpleStreamOptions>,
) -> AssistantMessageEventStream {
    let api_key = options
        .and_then(|options| options.base.api_key.clone())
        .or_else(|| get_env_api_key(&model.provider));
    let Some(api_key) = api_key else {
        let (writer, reader) = create_assistant_message_event_stream();
        let mut message = AssistantMessage {
            content: Vec::new(),
            api: model.api.clone(),
            provider: model.provider.clone(),
            model: model.id.clone(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::default(),
            stop_reason: StopReason::Error,
            stop_reason_raw: None,
            error_message: Some(format!("No API key for provider: {}", model.provider)),
            timestamp: crate::utils_inner::diagnostics::now_ms(),
            rest: Map::default(),
        };
        message.usage.cost = UsageCost::default();
        writer.push(AssistantMessageEvent::Error {
            reason: crate::types::ErrorStopReason::Error,
            error: message.clone(),
        });
        writer.end(Some(message));
        return reader;
    };

    let base = build_base_options(model, options, Some(&api_key));
    let requested_reasoning = options.and_then(|options| options.reasoning);
    let reasoning_specified = requested_reasoning.is_some();
    let clamped_reasoning =
        requested_reasoning.map(|reasoning| clamp_thinking_level(model, reasoning));
    let reasoning_effort = clamped_reasoning.filter(|level| *level != ModelThinkingLevel::Off);

    let stream_options = OpenAICompletionsOptions {
        base,
        tool_choice: None,
        reasoning_effort,
        reasoning_enabled: if reasoning_specified {
            Some(clamped_reasoning != Some(ModelThinkingLevel::Off))
        } else {
            None
        },
    };
    stream_openai_completions(model, context, Some(&stream_options))
}

/// Registry provider for the `openai-completions` API.
pub struct OpenAICompletionsProvider;

impl Provider for OpenAICompletionsProvider {
    fn api(&self) -> &str {
        API_OPENAI_COMPLETIONS
    }

    fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> AssistantMessageEventStream {
        let options = options.map(|base| OpenAICompletionsOptions::from_base(base.clone()));
        stream_openai_completions(model, context, options.as_ref())
    }

    fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> AssistantMessageEventStream {
        stream_simple_openai_completions(model, context, options)
    }
}
