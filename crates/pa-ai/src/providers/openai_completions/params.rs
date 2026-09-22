//! OpenAI Completions request params assembly.
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
                if let Some(effort) = options.reasoning_effort {
                    if compat.supports_reasoning_effort {
                        let mapped = model
                            .thinking_level_map_value(effort)
                            .flatten()
                            .cloned()
                            .unwrap_or_else(|| effort.wire_name().to_string());
                        params.insert("reasoning".into(), json!({ "effort": mapped }));
                    }
                } else if options.reasoning_enabled == Some(true) {
                    params.insert("reasoning".into(), json!({ "enabled": true }));
                } else if options.reasoning_enabled == Some(false) {
                    let off_null = model
                        .thinking_level_map_value(ModelThinkingLevel::Off)
                        .map(|value| value.is_none())
                        .unwrap_or(false);
                    if !off_null {
                        if compat.supports_reasoning_effort {
                            let off_value = model
                                .thinking_level_map_value(ModelThinkingLevel::Off)
                                .flatten()
                                .cloned()
                                .unwrap_or_else(|| "none".to_string());
                            params.insert("reasoning".into(), json!({ "effort": off_value }));
                        } else {
                            params.insert("reasoning".into(), json!({ "enabled": false }));
                        }
                    }
                }
            }
            _ => {
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
                    let off = model.thinking_level_map_value(ModelThinkingLevel::Off);
                    let off_null = off.map(|value| value.is_none()).unwrap_or(false);
                    if !off_null {
                        let off_value =
                            off.flatten().cloned().unwrap_or_else(|| "none".to_string());
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
    let messages = match params
        .get_mut("messages")
        .and_then(|value| value.as_array_mut())
    {
        Some(messages) => messages,
        None => return,
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
