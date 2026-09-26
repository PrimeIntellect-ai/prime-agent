//! `OpenAI` Completions request params assembly.
//! Section of the port of `packages/ai/src/providers/openai-completions.ts`.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::env_api_keys::get_prime_team_id;
use crate::providers::openai_completions::convert::{convert_messages, convert_tools};
use crate::providers::openai_completions::has_tool_history;
use crate::providers::openai_completions::{
    OpenAICompatCacheControl, OpenAICompletionsOptions, ResolvedCompat,
};
use crate::types::{CacheRetention, Context, Model, ModelExt, ModelThinkingLevel};

pub(crate) fn build_params(
    model: &Model,
    context: &Context,
    options: Option<&OpenAICompletionsOptions>,
    compat: &ResolvedCompat,
    cache_retention: CacheRetention,
    cache_control: Option<&OpenAICompatCacheControl>,
) -> Value {
    let options = options.cloned().unwrap_or_default();
    let messages = convert_messages(model, context, compat);
    let mut params = Map::new();
    params.insert("model".into(), json!(model.id));
    params.insert("messages".into(), json!(messages));
    params.insert("stream".into(), json!(true));

    let prompt_cache_key = if (model.base_url.contains("api.openai.com")
        && cache_retention != CacheRetention::None)
        || (cache_retention == CacheRetention::Long && compat.supports_long_cache_retention)
    {
        options.base.session_id.clone().map(Value::String)
    } else {
        None
    };
    if let Some(key) = prompt_cache_key {
        params.insert("prompt_cache_key".into(), key);
    }
    if cache_retention == CacheRetention::Long && compat.supports_long_cache_retention {
        params.insert("prompt_cache_retention".into(), json!("24h"));
    }

    if compat.supports_usage_in_streaming {
        params.insert("stream_options".into(), json!({ "include_usage": true }));
    }

    if compat.supports_store {
        params.insert("store".into(), json!(false));
    }

    if let Some(max_tokens) = options.base.max_tokens {
        if compat.max_tokens_field == crate::types::MaxTokensField::MaxTokens {
            params.insert("max_tokens".into(), json!(max_tokens));
        } else {
            params.insert("max_completion_tokens".into(), json!(max_tokens));
        }
    }

    if let Some(temperature) = options.base.temperature {
        params.insert("temperature".into(), json!(temperature));
    }

    let mut tools: Option<Vec<Value>> = None;
    if let Some(context_tools) = &context.tools {
        if !context_tools.is_empty() {
            tools = Some(convert_tools(context_tools, compat));
            if compat.zai_tool_stream {
                params.insert("tool_stream".into(), json!(true));
            }
        }
    }
    if tools.is_none() && has_tool_history(&context.messages) {
        // Anthropic (via LiteLLM/proxy) requires the tools param when the
        // conversation has tool_calls/tool_results.
        tools = Some(Vec::new());
    }
    if let Some(tools) = &tools {
        params.insert("tools".into(), json!(tools));
    }

    if let Some(cache_control) = cache_control {
        apply_anthropic_cache_control(&mut params, cache_control);
    }

    if let Some(tool_choice) = &options.tool_choice {
        params.insert("tool_choice".into(), tool_choice.to_json());
    }

    if model.reasoning {
        match compat.thinking_format {
            crate::types::ThinkingFormat::Zai | crate::types::ThinkingFormat::Qwen => {
                params.insert(
                    "enable_thinking".into(),
                    json!(options.reasoning_effort.is_some()),
                );
            }
            crate::types::ThinkingFormat::QwenChatTemplate => {
                params.insert(
                    "chat_template_kwargs".into(),
                    json!({
                        "enable_thinking": options.reasoning_effort.is_some(),
                        "preserve_thinking": true,
                    }),
                );
            }
            crate::types::ThinkingFormat::Deepseek => {
                params.insert(
                    "thinking".into(),
                    json!({
                        "type": if options.reasoning_effort.is_some() { "enabled" } else { "disabled" },
                    }),
                );
                if let Some(effort) = options.reasoning_effort {
                    let mapped = model
                        .thinking_level_map_value(effort)
                        .flatten()
                        .cloned()
                        .unwrap_or_else(|| effort.wire_name().to_string());
                    params.insert("reasoning_effort".into(), json!(mapped));
                }
            }
            crate::types::ThinkingFormat::Openrouter => {
                // OpenRouter distinguishes an omitted reasoning preference (use
                // the model default), an explicit toggle, and an explicit
                // effort selection.
                let declared_effort = options
                    .reasoning_effort
                    .filter(|_| compat.supports_reasoning_effort);
                if let Some(effort) = declared_effort {
                    let mapped = model
                        .thinking_level_map_value(effort)
                        .flatten()
                        .cloned()
                        .unwrap_or_else(|| effort.wire_name().to_string());
                    params.insert("reasoning".into(), json!({ "effort": mapped }));
                } else if options.reasoning_enabled == Some(true) {
                    params.insert("reasoning".into(), json!({ "enabled": true }));
                } else if options.reasoning_enabled == Some(false) {
                    let off = model
                        .thinking_level_map
                        .as_ref()
                        .and_then(|map| map.get(&ModelThinkingLevel::Off));
                    // TS `thinkingLevelMap?.off !== null`: only an explicit
                    // null suppresses the disable; a missing key or map still
                    // disables reasoning.
                    if !off.is_some_and(std::option::Option::is_none) {
                        if compat.supports_reasoning_effort {
                            let off_value = off
                                .and_then(|value| value.as_deref())
                                .unwrap_or("none")
                                .to_string();
                            params.insert("reasoning".into(), json!({ "effort": off_value }));
                        } else {
                            params.insert("reasoning".into(), json!({ "enabled": false }));
                        }
                    }
                }
            }
            crate::types::ThinkingFormat::Openai => {
                if let Some(effort) = options.reasoning_effort {
                    if compat.supports_reasoning_effort {
                        let mapped = model
                            .thinking_level_map_value(effort)
                            .flatten()
                            .cloned()
                            .unwrap_or_else(|| effort.wire_name().to_string());
                        params.insert("reasoning_effort".into(), json!(mapped));
                    }
                } else if options.reasoning_enabled == Some(false)
                    && compat.supports_reasoning_effort
                {
                    let off = model
                        .thinking_level_map
                        .as_ref()
                        .and_then(|map| map.get(&ModelThinkingLevel::Off));
                    // TS `thinkingLevelMap?.off !== null`: only an explicit
                    // null suppresses the disable; a missing key or map still
                    // sends the off value.
                    if !off.is_some_and(std::option::Option::is_none) {
                        let off_value = off
                            .and_then(|value| value.as_deref())
                            .unwrap_or("none")
                            .to_string();
                        params.insert("reasoning_effort".into(), json!(off_value));
                    }
                }
            }
        }
    }

    if model.base_url.contains("openrouter.ai") {
        if let Some(crate::types::CompatKind::OpenAiCompletions(compat)) = model.compat_kind() {
            if let Some(routing) = &compat.as_ref().open_router_routing {
                params.insert(
                    "provider".into(),
                    serde_json::to_value(routing).unwrap_or(Value::Null),
                );
            }
        }
    }

    if model.base_url.contains("ai-gateway.vercel.sh") {
        if let Some(crate::types::CompatKind::OpenAiCompletions(compat)) = model.compat_kind() {
            if let Some(routing) = &compat.as_ref().vercel_gateway_routing {
                let mut gateway_options = Map::new();
                if let Some(only) = &routing.only {
                    gateway_options.insert("only".into(), json!(only));
                }
                if let Some(order) = &routing.order {
                    gateway_options.insert("order".into(), json!(order));
                }
                if !gateway_options.is_empty() {
                    params.insert(
                        "providerOptions".into(),
                        json!({ "gateway": Value::Object(gateway_options) }),
                    );
                }
            }
        }
    }

    Value::Object(params)
}

fn apply_anthropic_cache_control(
    params: &mut Map<String, Value>,
    cache_control: &OpenAICompatCacheControl,
) {
    // Last tool.
    if let Some(tools) = params
        .get_mut("tools")
        .and_then(|value| value.as_array_mut())
    {
        if let Some(last_tool) = tools.last_mut() {
            last_tool
                .as_object_mut()
                .expect("tools entries are objects")
                .insert("cache_control".into(), cache_control.to_json());
        }
    }
    let Some(messages) = params
        .get_mut("messages")
        .and_then(|value| value.as_array_mut())
    else {
        return;
    };
    // System prompt.
    for message in messages.iter_mut() {
        let role = message.get("role").and_then(|value| value.as_str());
        if role == Some("system") || role == Some("developer") {
            add_cache_control_to_message(message, cache_control);
            break;
        }
    }
    // Last conversation message (user/assistant/tool), from the end.
    for message in messages.iter_mut().rev() {
        let role = message
            .get("role")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if (role == "user" || role == "assistant" || role == "tool")
            && add_cache_control_to_message(message, cache_control)
        {
            break;
        }
    }
}

fn add_cache_control_to_message(
    message: &mut Value,
    cache_control: &OpenAICompatCacheControl,
) -> bool {
    let cache_json = cache_control.to_json();
    match message.get_mut("content") {
        Some(Value::String(content)) => {
            if content.is_empty() {
                return false;
            }
            let text = content.clone();
            message
                .as_object_mut()
                .expect("messages are objects")
                .insert(
                    "content".into(),
                    json!([{
                        "type": "text",
                        "text": text,
                        "cache_control": cache_json,
                    }]),
                );
            true
        }
        Some(Value::Array(content)) => {
            for part in content.iter_mut().rev() {
                if part.get("type").and_then(|value| value.as_str()) == Some("text") {
                    part.as_object_mut()
                        .expect("text parts are objects")
                        .insert("cache_control".into(), cache_json);
                    return true;
                }
            }
            false
        }
        _ => false,
    }
}

pub(crate) fn build_headers(
    model: &Model,
    api_key: &str,
    options_headers: Option<&HashMap<String, String>>,
    cache_session_id: Option<&str>,
    compat: &ResolvedCompat,
    conversation_id: Option<&str>,
) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = Vec::new();
    for (name, value) in model.headers.iter().flatten() {
        headers.push((name.clone(), value.clone()));
    }

    if model.provider == "prime-inference" {
        if let Some(team_id) = get_prime_team_id() {
            headers.push(("X-Prime-Team-ID".into(), team_id));
        }
    }

    if let Some(session_id) = cache_session_id {
        if compat.send_session_affinity_headers {
            headers.push(("session_id".into(), session_id.to_string()));
            headers.push(("x-client-request-id".into(), session_id.to_string()));
            headers.push(("x-session-affinity".into(), session_id.to_string()));
        }
    }

    if let Some(options_headers) = options_headers {
        for (name, value) in options_headers {
            headers.retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
            headers.push((name.clone(), value.clone()));
        }
    }

    headers.insert(0, ("Authorization".into(), format!("Bearer {api_key}")));
    let _ = conversation_id;
    headers
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::clamp_thinking_level;
    use crate::models_generated;
    use crate::types::{Message, StreamOptions, UserMessage, UserMessageContent};

    /// Assemble params for a compiled catalog model with a reasoning level
    /// requested. Mirrors `streamSimpleOpenAICompletions`: the requested
    /// level clamps through the model's thinking-level map, the effort
    /// rides along as `reasoning_effort` unless clamped to off, and the
    /// explicit on/off toggle rides along as `reasoning_enabled`.
    fn reasoning_params_for(model: &Model, level: ModelThinkingLevel) -> Map<String, Value> {
        let context = Context {
            system_prompt: None,
            messages: vec![Message::User(UserMessage {
                content: UserMessageContent::Text("Hi".into()),
                timestamp: 1,
                rest: Map::default(),
            })],
            tools: None,
        };
        let clamped = clamp_thinking_level(model, level);
        let mut options = OpenAICompletionsOptions::from_base(StreamOptions {
            api_key: Some("test".into()),
            ..Default::default()
        });
        options.reasoning_effort = (clamped != ModelThinkingLevel::Off).then_some(clamped);
        options.reasoning_enabled = Some(clamped != ModelThinkingLevel::Off);
        let params = build_params(
            model,
            &context,
            Some(&options),
            &crate::providers::openai_completions::get_compat(model),
            CacheRetention::None,
            None,
        );
        match params {
            Value::Object(map) => map,
            _ => panic!("build_params returns a JSON object"),
        }
    }

    /// A compiled fallback catalog entry, straight from `models_generated`
    /// (the conservative offline floor).
    fn compiled_params(
        provider: &str,
        model_id: &str,
        level: ModelThinkingLevel,
    ) -> Map<String, Value> {
        let model = models_generated::get_model(provider, model_id)
            .unwrap_or_else(|| panic!("compiled catalog carries {provider}/{model_id}"));
        reasoning_params_for(model, level)
    }

    /// Port of the TS regression (#2519, gateway-verified 2026-09-21):
    /// a Prime Inference route sends only the reasoning parameters its live
    /// catalog declaration selects — an effort-declared route sends
    /// `reasoning_effort` values, a toggle-declared route the `reasoning`
    /// object — and `enable_thinking` never reaches a Prime Inference
    /// route. The live declarations rebuild each model's compat and
    /// thinking levels (pa-models `build_prime_inference_models`); these
    /// fixtures hold the two rebuilt shapes, so the request shaping keeps
    /// its #2519 coverage independent of the compiled fallback catalog.
    #[test]
    fn sends_only_the_declared_reasoning_parameters_for_live_rebuilt_routes() {
        // Effort-declared route (the glm-5.3 shape): reasoning_effort with
        // the declared levels, no reasoning object, no enable_thinking.
        let mut effort_model = models_generated::get_model("prime-inference", "z-ai/glm-5.3")
            .expect("compiled template")
            .clone();
        effort_model.compat = Some(crate::types::ModelCompat::from_kind(
            crate::types::CompatKind::OpenAiCompletions(Box::new(
                crate::types::OpenAiCompletionsCompat {
                    supports_reasoning_effort: Some(true),
                    ..Default::default()
                },
            )),
        ));
        for level in [ModelThinkingLevel::High, ModelThinkingLevel::Medium] {
            let params = reasoning_params_for(&effort_model, level);
            for key in ["enable_thinking", "chat_template_kwargs", "reasoning"] {
                assert!(
                    !params.contains_key(key),
                    "effort route: request must not carry {key}"
                );
            }
            // medium is not declared by the route; the clamp sends the nearest level
            assert_eq!(params.get("reasoning_effort"), Some(&json!("high")));
        }

        // Toggle-declared route (the glm-4.7 shape): the reasoning object
        // only, with the declared on and off arms.
        let mut toggle_model = effort_model;
        toggle_model.compat = Some(crate::types::ModelCompat::from_kind(
            crate::types::CompatKind::OpenAiCompletions(Box::new(
                crate::types::OpenAiCompletionsCompat {
                    supports_reasoning_effort: Some(false),
                    thinking_format: Some(crate::types::ThinkingFormat::Openrouter),
                    ..Default::default()
                },
            )),
        ));
        let mut declared_map = crate::types::ThinkingLevelMap::new();
        declared_map.insert(ModelThinkingLevel::Minimal, None);
        declared_map.insert(ModelThinkingLevel::Low, None);
        declared_map.insert(ModelThinkingLevel::Medium, None);
        declared_map.insert(ModelThinkingLevel::High, Some("high".to_string()));
        declared_map.insert(ModelThinkingLevel::Xhigh, None);
        declared_map.insert(ModelThinkingLevel::Max, None);
        toggle_model.thinking_level_map = Some(declared_map);

        let params = reasoning_params_for(&toggle_model, ModelThinkingLevel::High);
        assert_eq!(params.get("reasoning"), Some(&json!({ "enabled": true })));
        assert!(!params.contains_key("reasoning_effort"));
        for key in ["enable_thinking", "chat_template_kwargs"] {
            assert!(
                !params.contains_key(key),
                "toggle route: request must not carry {key}"
            );
        }
        let params = reasoning_params_for(&toggle_model, ModelThinkingLevel::Off);
        assert_eq!(params.get("reasoning"), Some(&json!({ "enabled": false })));
    }

    /// The compiled fallback catalog is conservative (TS #2519: the live
    /// catalog owns the reasoning declarations): offline, a Prime
    /// Inference route declares neither the effort selector nor a thinking
    /// format, so a reasoning request sends no reasoning parameter at all
    /// — and `enable_thinking` still never reaches the route.
    #[test]
    fn compiled_fallback_prime_inference_routes_send_no_reasoning_parameters() {
        for (model_id, level) in [
            ("z-ai/glm-5.3", ModelThinkingLevel::High),
            ("z-ai/glm-5.3", ModelThinkingLevel::Medium),
            ("z-ai/glm-4.7", ModelThinkingLevel::High),
            ("z-ai/glm-4.7", ModelThinkingLevel::Off),
        ] {
            let params = compiled_params("prime-inference", model_id, level);
            for key in [
                "enable_thinking",
                "chat_template_kwargs",
                "reasoning",
                "reasoning_effort",
            ] {
                assert!(
                    !params.contains_key(key),
                    "compiled fallback {model_id}: request must not carry {key}"
                );
            }
        }
    }

    /// The direct z.ai routes keep the toggle: their compat still selects the
    /// zai thinking format, so reasoning requests send `enable_thinking`.
    #[test]
    fn keeps_the_zai_thinking_toggle_on_direct_zai_routes() {
        let params = compiled_params("zai", "glm-4.7", ModelThinkingLevel::High);
        assert_eq!(params.get("enable_thinking"), Some(&json!(true)));
    }
}
