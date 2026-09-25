//! Mistral Conversations streaming provider.
//! Port of `packages/ai/src/providers/mistral.ts`: `chat/completions` SSE
//! streaming with camelCase-free `snake_case` wire keys (verified against the
//! `@mistralai/mistralai` SDK outbound schemas), thinking text-block
//! accumulation, tool-call argument streaming, `x-affinity` KV-cache header,
//! and usage accounting.
//!
//! Split across submodules mirroring the `anthropic/openai_completions`
//! layout: request options, headers, and the simple-stream entry live here,
//! message/tool conversion and payload assembly in [`convert`], and the SSE
//! streaming core in [`stream`].

use crate::env_api_keys::get_env_api_key;
use crate::event_stream::{
    create_assistant_message_event_stream, AssistantMessageEvent, AssistantMessageEventStream,
};
use crate::models::clamp_thinking_level;
use crate::providers::simple_options::build_base_options;
use crate::registry::Provider;
use crate::types::{
    error_reason, AssistantMessage, Context, Model, ModelThinkingLevel, SimpleStreamOptions,
    StopReason, StreamOptions, Usage,
};
use crate::utils_inner::diagnostics::now_ms;
use serde_json::{json, Value};

mod convert;
mod stream;

pub use stream::stream_mistral;

pub const API_MISTRAL_CONVERSATIONS: &str = "mistral-conversations";

/// Mistral reasoning-effort values (`MistralReasoningEffort` in the TS).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MistralReasoningEffort {
    None,
    High,
}

impl MistralReasoningEffort {
    pub fn as_str(self) -> &'static str {
        match self {
            MistralReasoningEffort::None => "none",
            MistralReasoningEffort::High => "high",
        }
    }
}

/// `promptMode` request option; only `reasoning` exists in the API surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MistralPromptMode {
    Reasoning,
}

impl MistralPromptMode {
    pub fn as_str(self) -> &'static str {
        "reasoning"
    }
}

/// Tool selection (`toolChoice` in the TS reference).
#[allow(dead_code)] // full TS option surface; variants set by callers
#[derive(Clone, Debug, PartialEq)]
pub enum MistralToolChoice {
    Auto,
    None,
    Any,
    Required,
    Tool { name: String },
}

impl MistralToolChoice {
    fn to_json(&self) -> Value {
        match self {
            MistralToolChoice::Auto => json!("auto"),
            MistralToolChoice::None => json!("none"),
            MistralToolChoice::Any => json!("any"),
            MistralToolChoice::Required => json!("required"),
            MistralToolChoice::Tool { name } => {
                json!({ "type": "function", "function": { "name": name } })
            }
        }
    }
}

/// Provider-specific request options (`MistralOptions` in the TS reference).
#[derive(Clone, Default)]
pub struct MistralOptions {
    pub base: StreamOptions,
    pub tool_choice: Option<MistralToolChoice>,
    pub prompt_mode: Option<MistralPromptMode>,
    pub reasoning_effort: Option<MistralReasoningEffort>,
}

impl MistralOptions {
    pub fn from_base(base: StreamOptions) -> Self {
        Self {
            base,
            tool_choice: None,
            prompt_mode: None,
            reasoning_effort: None,
        }
    }
}

pub(crate) fn build_request_headers(
    model: &Model,
    options: &MistralOptions,
    api_key: &str,
) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = Vec::new();
    for (name, value) in model.headers.iter().flatten() {
        headers.push((name.clone(), value.clone()));
    }
    if let Some(options_headers) = &options.base.headers {
        for (name, value) in options_headers {
            headers.retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
            headers.push((name.clone(), value.clone()));
        }
    }
    // Mistral infrastructure uses `x-affinity` for KV-cache reuse (prefix
    // caching). Respect explicit caller-provided header values.
    if let Some(session_id) = &options.base.session_id {
        if !headers.iter().any(|(name, _)| name == "x-affinity") {
            headers.push(("x-affinity".into(), session_id.clone()));
        }
    }
    headers.push(("authorization".into(), format!("Bearer {api_key}")));
    headers
}

fn uses_reasoning_effort(model: &Model) -> bool {
    model.id == "mistral-small-2603"
        || model.id == "mistral-small-latest"
        || model.id == "mistral-medium-3.5"
}

fn uses_prompt_mode_reasoning(model: &Model) -> bool {
    model.reasoning && !uses_reasoning_effort(model)
}

fn map_reasoning_effort(model: &Model, level: ModelThinkingLevel) -> MistralReasoningEffort {
    let mapped = model
        .thinking_level_map
        .as_ref()
        .and_then(|map| map.get(&level))
        .and_then(std::clone::Clone::clone);
    match mapped.as_deref() {
        Some("none") => MistralReasoningEffort::None,
        _ => MistralReasoningEffort::High,
    }
}

/// Port of `streamSimpleMistral`.
pub fn stream_simple_mistral(
    model: &Model,
    context: &Context,
    options: Option<&SimpleStreamOptions>,
) -> AssistantMessageEventStream {
    let api_key = options
        .and_then(|options| options.base.api_key.clone())
        .filter(|key| !key.is_empty())
        .or_else(|| get_env_api_key(&model.provider));
    let api_key = if let Some(api_key) = api_key {
        api_key
    } else {
        let (writer, reader) = create_assistant_message_event_stream();
        let mut error = AssistantMessage {
            content: Vec::new(),
            api: API_MISTRAL_CONVERSATIONS.to_string(),
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
            rest: Default::default(),
        };
        let message = error.error_message.clone().unwrap_or_default();
        writer.push(AssistantMessageEvent::Error {
            reason: error_reason(StopReason::Error),
            error: error.clone(),
        });
        error.error_message = Some(message);
        writer.end(Some(error));
        return reader;
    };

    let base = build_base_options(model, options, Some(&api_key));
    let clamped_reasoning = options
        .and_then(|options| options.reasoning)
        .map(|reasoning| clamp_thinking_level(model, reasoning));
    let reasoning = match clamped_reasoning {
        Some(ModelThinkingLevel::Off) | None => None,
        Some(level) => Some(level),
    };
    let should_use_reasoning = model.reasoning && reasoning.is_some();

    let stream_options = MistralOptions {
        base,
        tool_choice: None,
        prompt_mode: if should_use_reasoning && uses_prompt_mode_reasoning(model) {
            Some(MistralPromptMode::Reasoning)
        } else {
            None
        },
        reasoning_effort: reasoning
            .filter(|_| should_use_reasoning && uses_reasoning_effort(model))
            .map(|level| map_reasoning_effort(model, level)),
    };
    stream_mistral(model, context, Some(&stream_options))
}

/// Registry provider for the `mistral-conversations` API.
pub struct MistralConversationsProvider;

impl Provider for MistralConversationsProvider {
    fn api(&self) -> &str {
        API_MISTRAL_CONVERSATIONS
    }

    fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> AssistantMessageEventStream {
        let options = options.map(|base| MistralOptions::from_base(base.clone()));
        stream_mistral(model, context, options.as_ref())
    }

    fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> AssistantMessageEventStream {
        stream_simple_mistral(model, context, options)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_choice_serializes() {
        assert_eq!(MistralToolChoice::Auto.to_json(), json!("auto"));
        assert_eq!(
            MistralToolChoice::Tool {
                name: "grep".into()
            }
            .to_json(),
            json!({ "type": "function", "function": { "name": "grep" } })
        );
    }

    #[test]
    fn reasoning_effort_uses_thinking_level_map() {
        let model = Model {
            id: "mistral-small-2603".into(),
            name: "mistral-small".into(),
            api: "mistral-conversations".into(),
            provider: "mistral".into(),
            base_url: "https://api.mistral.ai".into(),
            reasoning: true,
            thinking_level_map: None,
            input: vec![crate::types::ModelInput::Text],
            cost: crate::types::zero_model_cost(),
            context_window: 128_000,
            max_tokens: 8192,
            featured: None,
            headers: None,
            compat: None,
        };
        assert!(uses_reasoning_effort(&model));
        assert_eq!(
            map_reasoning_effort(&model, ModelThinkingLevel::High),
            MistralReasoningEffort::High
        );
    }
}
