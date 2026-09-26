//! Anthropic Messages streaming provider.
//!
//! Full port of `packages/ai/src/providers/anthropic.ts`, split across
//! submodules: request headers and options here, message/tool conversion in
//! [`convert`], params assembly in [`params`], and the SSE streaming core in
//! [`stream`]. OAuth/Claude-Code header modes, beta headers, and adaptive vs
//! budget-based thinking selection live here.

use serde_json::{json, Map, Value};

use crate::env_api_keys::get_env_api_key;
use crate::event_stream::{
    create_assistant_message_event_stream, AssistantMessageEvent, AssistantMessageEventStream,
};
use crate::models::clamp_thinking_level;
use crate::providers::simple_options::{adjust_max_tokens_for_thinking, build_base_options};
use crate::registry::Provider;
use crate::types::{
    AssistantMessage, CacheRetention, Context, Model, ModelExt, ModelThinkingLevel,
    SimpleStreamOptions, StopReason, StreamOptions, Tool, Usage,
};
use crate::utils_inner::diagnostics::now_ms;

mod convert;
mod params;
mod stream;

pub use stream::stream_anthropic;

pub const API_ANTHROPIC_MESSAGES: &str = "anthropic-messages";

/// Claude Code version mimicked in OAuth mode. The API gates newer models
/// on the claimed client version (e.g. claude-opus-5.5 requires >= 2.280),
/// so keep this at or above the latest released Claude Code.
const CLAUDE_CODE_VERSION: &str = "2.1.281";
const FINE_GRAINED_TOOL_STREAMING_BETA: &str = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA: &str = "interleaved-thinking-2025-05-14";

const CLAUDE_CODE_TOOLS: [&str; 17] = [
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Grep",
    "Glob",
    "AskUserQuestion",
    "EnterPlanMode",
    "ExitPlanMode",
    "KillShell",
    "NotebookEdit",
    "Skill",
    "Task",
    "TaskOutput",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
];

pub(crate) fn to_claude_code_name(name: &str) -> String {
    CLAUDE_CODE_TOOLS
        .iter()
        .find(|tool| tool.eq_ignore_ascii_case(name))
        .map_or_else(|| name.to_string(), std::string::ToString::to_string)
}

pub(crate) fn from_claude_code_name(name: &str, tools: Option<&[Tool]>) -> String {
    if let Some(tools) = tools {
        if let Some(matched) = tools
            .iter()
            .find(|tool| tool.name.eq_ignore_ascii_case(name))
        {
            return matched.name.clone();
        }
    }
    name.to_string()
}

/// Effort levels for adaptive thinking.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnthropicEffort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl AnthropicEffort {
    pub fn as_str(self) -> &'static str {
        match self {
            AnthropicEffort::Low => "low",
            AnthropicEffort::Medium => "medium",
            AnthropicEffort::High => "high",
            AnthropicEffort::Xhigh => "xhigh",
            AnthropicEffort::Max => "max",
        }
    }
}

/// Thinking display mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)] // full TS option surface; variants set by callers
pub enum AnthropicThinkingDisplay {
    Summarized,
    Omitted,
}

impl AnthropicThinkingDisplay {
    pub fn as_str(self) -> &'static str {
        match self {
            AnthropicThinkingDisplay::Summarized => "summarized",
            AnthropicThinkingDisplay::Omitted => "omitted",
        }
    }
}

/// Tool selection passed to the API.
#[derive(Clone, Debug, PartialEq)]
#[allow(dead_code)] // full TS option surface; variants set by callers
pub enum AnthropicToolChoice {
    Auto,
    Any,
    None,
    Tool { name: String },
}

impl AnthropicToolChoice {
    fn to_json(&self) -> Value {
        match self {
            AnthropicToolChoice::Auto => json!({ "type": "auto" }),
            AnthropicToolChoice::Any => json!({ "type": "any" }),
            AnthropicToolChoice::None => json!({ "type": "none" }),
            AnthropicToolChoice::Tool { name } => json!({ "type": "tool", "name": name }),
        }
    }
}

/// Provider-native options (`AnthropicOptions` in the TS reference).
#[derive(Clone, Default)]
pub struct AnthropicOptions {
    pub base: StreamOptions,
    pub thinking_enabled: Option<bool>,
    pub thinking_budget_tokens: Option<u64>,
    pub effort: Option<AnthropicEffort>,
    pub thinking_display: Option<AnthropicThinkingDisplay>,
    pub interleaved_thinking: Option<bool>,
    pub tool_choice: Option<AnthropicToolChoice>,
}

/// Resolved anthropic compat (`Required<AnthropicMessagesCompat>`).
pub struct ResolvedAnthropicCompat {
    pub supports_eager_tool_input_streaming: bool,
    pub supports_long_cache_retention: bool,
}

pub fn get_anthropic_compat(model: &Model) -> ResolvedAnthropicCompat {
    let compat = model.compat_kind().and_then(|kind| match kind {
        crate::types::CompatKind::AnthropicMessages(compat) => Some(compat),
        _ => None,
    });
    ResolvedAnthropicCompat {
        supports_eager_tool_input_streaming: compat
            .as_ref()
            .and_then(|c| c.supports_eager_tool_input_streaming)
            .unwrap_or(true),
        supports_long_cache_retention: compat
            .as_ref()
            .and_then(|c| c.supports_long_cache_retention)
            .unwrap_or(true),
    }
}

pub(crate) fn resolve_cache_retention(cache_retention: Option<CacheRetention>) -> CacheRetention {
    if let Some(retention) = cache_retention {
        return retention;
    }
    if std::env::var("PI_CACHE_RETENTION").as_deref() == Ok("long") {
        return CacheRetention::Long;
    }
    CacheRetention::Short
}

/// `cache_control` payload derived from the retention preference.
pub struct CacheControl {
    pub ttl: Option<&'static str>,
}

impl CacheControl {
    fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("type".into(), json!("ephemeral"));
        if let Some(ttl) = self.ttl {
            map.insert("ttl".into(), json!(ttl));
        }
        Value::Object(map)
    }

    fn duration(&self) -> &'static str {
        if self.ttl == Some("1h") {
            "1h"
        } else {
            "5m"
        }
    }
}

pub(crate) fn get_cache_control(
    model: &Model,
    cache_retention: Option<CacheRetention>,
) -> (CacheRetention, Option<CacheControl>) {
    let retention = resolve_cache_retention(cache_retention);
    if retention == CacheRetention::None {
        return (retention, None);
    }
    let ttl = if retention == CacheRetention::Long
        && get_anthropic_compat(model).supports_long_cache_retention
    {
        Some("1h")
    } else {
        None
    };
    (retention, Some(CacheControl { ttl }))
}

/// Fable/Mythos models — and Claude Opus 5.5 — think every turn and reject an
/// explicit `thinking: {type: "disabled"}` (and any sampling params) with a
/// 400.
pub(crate) fn is_always_on_adaptive_thinking_model(model_id: &str) -> bool {
    model_id.contains("fable-5")
        || model_id.contains("mythos-5")
        || model_id.contains("mythos-preview")
        || model_id.contains("opus-5-5")
        || model_id.contains("opus-5.5")
}

/// Check if a model supports adaptive thinking (Opus 4.6+, Sonnet 4.6+).
pub(crate) fn supports_adaptive_thinking(model_id: &str) -> bool {
    model_id.contains("opus-4-6")
        || model_id.contains("opus-4.6")
        || model_id.contains("opus-5")
        || model_id.contains("opus-4-7")
        || model_id.contains("opus-4.7")
        || model_id.contains("opus-4-8")
        || model_id.contains("opus-4.8")
        || model_id.contains("sonnet-4-6")
        || model_id.contains("sonnet-4.6")
        || model_id.contains("sonnet-5")
        || model_id.contains("fable-5")
        || model_id.contains("mythos-5")
        || model_id.contains("mythos-preview")
}

fn map_thinking_level_to_effort(
    model: &Model,
    level: Option<ModelThinkingLevel>,
) -> AnthropicEffort {
    let effective = level.map(|level| clamp_thinking_level(model, level));
    let mapped = effective.and_then(|level| {
        model
            .thinking_level_map_value(level)
            .and_then(Option::<&String>::cloned)
    });
    if let Some(mapped) = mapped {
        return match mapped.as_str() {
            "low" => AnthropicEffort::Low,
            "medium" => AnthropicEffort::Medium,
            "xhigh" => AnthropicEffort::Xhigh,
            "max" => AnthropicEffort::Max,
            _ => AnthropicEffort::High,
        };
    }
    match effective {
        Some(ModelThinkingLevel::Minimal | ModelThinkingLevel::Low) => AnthropicEffort::Low,
        Some(ModelThinkingLevel::Medium) => AnthropicEffort::Medium,
        Some(ModelThinkingLevel::Xhigh) => AnthropicEffort::Xhigh,
        Some(ModelThinkingLevel::Max) => AnthropicEffort::Max,
        _ => AnthropicEffort::High,
    }
}

pub(crate) fn is_oauth_token(api_key: &str) -> bool {
    api_key.contains("sk-ant-oat")
}

pub(crate) fn should_use_fine_grained_tool_streaming_beta(
    model: &Model,
    context: &Context,
) -> bool {
    context
        .tools
        .as_ref()
        .is_some_and(|tools| !tools.is_empty())
        && !get_anthropic_compat(model).supports_eager_tool_input_streaming
}

pub(crate) fn merge_headers(sources: &[Option<Map<String, Value>>]) -> Map<String, Value> {
    let mut merged = Map::new();
    for source in sources.iter().flatten() {
        for (key, value) in source {
            merged.insert(key.clone(), value.clone());
        }
    }
    merged
}

pub(crate) fn headers_to_pairs(headers: &Map<String, Value>) -> Vec<(String, String)> {
    headers
        .iter()
        .filter_map(|(key, value)| match value {
            Value::String(text) => Some((key.clone(), text.clone())),
            _ => None,
        })
        .collect()
}

/// Build the request headers for the messages endpoint, mirroring the SDK
/// client configurations (OAuth/Claude Code mode, cloudflare gateway,
/// github-copilot, plain API key).
pub(crate) fn build_request_headers(
    model: &Model,
    api_key: &str,
    interleaved_thinking: bool,
    use_fine_grained_tool_streaming_beta: bool,
    options_headers: Option<&std::collections::HashMap<String, String>>,
    session_id: Option<&str>,
) -> (Vec<(String, String)>, bool) {
    let is_oauth = is_oauth_token(api_key);
    let needs_interleaved_beta = interleaved_thinking && !supports_adaptive_thinking(&model.id);
    let mut beta_features: Vec<&str> = Vec::new();
    if use_fine_grained_tool_streaming_beta {
        beta_features.push(FINE_GRAINED_TOOL_STREAMING_BETA);
    }
    if needs_interleaved_beta {
        beta_features.push(INTERLEAVED_THINKING_BETA);
    }
    let beta_header = if beta_features.is_empty() {
        None
    } else {
        Some(beta_features.join(","))
    };

    let model_headers: Option<Map<String, Value>> = model.headers.as_ref().map(|headers| {
        headers
            .iter()
            .map(|(key, value)| (key.clone(), json!(value)))
            .collect()
    });
    let options_headers_json: Option<Map<String, Value>> = options_headers.map(|headers| {
        headers
            .iter()
            .map(|(key, value)| (key.clone(), json!(value)))
            .collect()
    });

    let mut default_headers = match model.provider.as_str() {
        "cloudflare-ai-gateway" => {
            let mut headers = Map::new();
            headers.insert("accept".into(), json!("application/json"));
            headers.insert(
                "anthropic-dangerous-direct-browser-access".into(),
                json!("true"),
            );
            headers.insert(
                "cf-aig-authorization".into(),
                json!(format!("Bearer {api_key}")),
            );
            headers.insert("x-api-key".into(), Value::Null);
            headers.insert("Authorization".into(), Value::Null);
            if let Some(beta) = &beta_header {
                headers.insert("anthropic-beta".into(), json!(beta));
            }
            merge_headers(&[Some(headers), model_headers, options_headers_json])
        }
        "github-copilot" => {
            let mut headers = Map::new();
            headers.insert("accept".into(), json!("application/json"));
            headers.insert(
                "anthropic-dangerous-direct-browser-access".into(),
                json!("true"),
            );
            if let Some(beta) = &beta_header {
                headers.insert("anthropic-beta".into(), json!(beta));
            }
            merge_headers(&[Some(headers), model_headers, options_headers_json])
        }
        _ => {
            let mut headers = Map::new();
            headers.insert("accept".into(), json!("application/json"));
            headers.insert(
                "anthropic-dangerous-direct-browser-access".into(),
                json!("true"),
            );
            if is_oauth {
                headers.insert(
                    "anthropic-beta".into(),
                    json!(["claude-code-20250219", "oauth-2025-04-20"]
                        .iter()
                        .chain(beta_features.iter())
                        .copied()
                        .collect::<Vec<_>>()
                        .join(",")),
                );
                headers.insert(
                    "user-agent".into(),
                    json!(format!("claude-cli/{CLAUDE_CODE_VERSION}")),
                );
                headers.insert("x-app".into(), json!("cli"));
            } else if let Some(beta) = &beta_header {
                headers.insert("anthropic-beta".into(), json!(beta));
            }
            merge_headers(&[Some(headers), model_headers, options_headers_json])
        }
    };

    // withOpenCodeHeaders: session header for opencode providers.
    if model.provider == "opencode" || model.provider == "opencode-go" {
        if let Some(session_id) = session_id {
            default_headers.insert("session_id".into(), json!(session_id));
        }
    }

    let mut pairs = headers_to_pairs(&default_headers);
    // The Anthropic SDK always sends the API version; mirror it.
    pairs.insert(0, ("anthropic-version".into(), "2023-06-01".into()));
    if model.provider == "cloudflare-ai-gateway" || model.provider == "github-copilot" || is_oauth {
        pairs.push(("Authorization".into(), format!("Bearer {api_key}")));
    } else {
        pairs.push(("x-api-key".into(), api_key.to_string()));
    }
    (pairs, is_oauth)
}

/// Port of `streamSimpleAnthropic`.
pub fn stream_simple_anthropic(
    model: &Model,
    context: &Context,
    options: Option<&SimpleStreamOptions>,
) -> AssistantMessageEventStream {
    let api_key = options
        .and_then(|options| options.base.api_key.clone())
        .or_else(|| get_env_api_key(&model.provider));
    let Some(api_key) = api_key else {
        let (writer, reader) = create_assistant_message_event_stream();
        let message = AssistantMessage {
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
            timestamp: now_ms(),
            rest: Map::default(),
        };
        writer.push(AssistantMessageEvent::Error {
            reason: crate::types::ErrorStopReason::Error,
            error: message.clone(),
        });
        writer.end(Some(message));
        return reader;
    };

    let base = build_base_options(model, options, Some(&api_key));
    let reasoning = options.and_then(|options| options.reasoning);
    if reasoning.is_none() || reasoning == Some(ModelThinkingLevel::Off) {
        let mut anthropic_options = AnthropicOptions::from_base(base);
        anthropic_options.thinking_enabled = Some(false);
        return stream_anthropic(model, context, Some(&anthropic_options));
    }

    // Adaptive thinking models use effort; older models use budgets.
    if supports_adaptive_thinking(&model.id) {
        let effort = map_thinking_level_to_effort(model, reasoning);
        let mut anthropic_options = AnthropicOptions::from_base(base);
        anthropic_options.thinking_enabled = Some(true);
        anthropic_options.effort = Some(effort);
        return stream_anthropic(model, context, Some(&anthropic_options));
    }

    let budgets = options.and_then(|options| options.thinking_budgets.as_ref());
    let adjusted = match adjust_max_tokens_for_thinking(
        base.max_tokens.unwrap_or(0),
        model.max_tokens,
        reasoning.expect("checked above"),
        budgets,
    ) {
        Ok(adjusted) => adjusted,
        Err(message) => {
            let (writer, reader) = create_assistant_message_event_stream();
            let message = AssistantMessage {
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
                error_message: Some(message),
                timestamp: now_ms(),
                rest: Map::default(),
            };
            writer.push(AssistantMessageEvent::Error {
                reason: crate::types::ErrorStopReason::Error,
                error: message.clone(),
            });
            writer.end(Some(message));
            return reader;
        }
    };
    let mut anthropic_options = AnthropicOptions::from_base(base);
    anthropic_options.base.max_tokens = Some(adjusted.0);
    anthropic_options.thinking_enabled = Some(true);
    anthropic_options.thinking_budget_tokens = Some(adjusted.1);
    stream_anthropic(model, context, Some(&anthropic_options))
}

impl AnthropicOptions {
    pub fn from_base(base: StreamOptions) -> Self {
        Self {
            base,
            thinking_enabled: None,
            thinking_budget_tokens: None,
            effort: None,
            thinking_display: None,
            interleaved_thinking: None,
            tool_choice: None,
        }
    }
}

/// Registry provider for the `anthropic-messages` API.
pub struct AnthropicMessagesProvider;

impl Provider for AnthropicMessagesProvider {
    fn api(&self) -> &str {
        API_ANTHROPIC_MESSAGES
    }

    fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> AssistantMessageEventStream {
        let options = options.map(|base| AnthropicOptions::from_base(base.clone()));
        stream_anthropic(model, context, options.as_ref())
    }

    fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> AssistantMessageEventStream {
        stream_simple_anthropic(model, context, options)
    }
}

#[cfg(test)]
mod always_on_adaptive_thinking_tests {
    use super::is_always_on_adaptive_thinking_model;

    #[test]
    fn always_on_models_reject_thinking_disabled_and_sampling_params() {
        assert!(is_always_on_adaptive_thinking_model("claude-fable-5"));
        assert!(is_always_on_adaptive_thinking_model("claude-mythos-5"));
        assert!(is_always_on_adaptive_thinking_model("claude-opus-5-5"));
        assert!(is_always_on_adaptive_thinking_model(
            "anthropic/claude-opus-5.5"
        ));
    }

    #[test]
    fn optional_thinking_models_still_accept_disabled() {
        assert!(!is_always_on_adaptive_thinking_model("claude-opus-5"));
        assert!(!is_always_on_adaptive_thinking_model("claude-sonnet-5"));
    }
}

#[cfg(test)]
mod subscription_identity_tests {
    use super::build_request_headers;
    use crate::types::{zero_model_cost, Model, ModelInput};

    // TS #2645's wire-contract assertions (anthropic-thinking-disable.test.ts):
    // subscription requests claim the Claude Code client identity, and the
    // claimed version must stay at or above what the API's model gates require
    // (the opus-5.5 family rejects anything below 2.280).
    fn test_model() -> Model {
        Model {
            id: "claude-opus-5-5".into(),
            name: "Claude Opus 5.5".into(),
            api: "anthropic-messages".into(),
            provider: "anthropic".into(),
            base_url: "https://api.anthropic.com".into(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![ModelInput::Text],
            cost: zero_model_cost(),
            context_window: 200_000,
            max_tokens: 32_000,
            featured: None,
            headers: None,
            compat: None,
        }
    }

    #[test]
    fn oauth_requests_claim_the_claude_code_identity() {
        let (headers, is_oauth) =
            build_request_headers(&test_model(), "sk-ant-oat-test", false, false, None, None);
        assert!(is_oauth);
        let header = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        };
        let user_agent = header("user-agent").expect("the OAuth request sends a user-agent");
        assert!(user_agent.starts_with("claude-cli/"), "got {user_agent}");
        assert_eq!(header("x-app"), Some("cli"));
        let beta = header("anthropic-beta").expect("the OAuth request sends the claude-code beta");
        assert!(beta.contains("claude-code-20250219"));
    }
}
