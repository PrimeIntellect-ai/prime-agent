//! OpenAI Completions conversion: reasoning-details signatures, messages, and tools.
//! Section of the port of `packages/ai/src/providers/openai-completions.ts`.

use serde_json::{json, Map, Value};

use crate::models::{calculate_cost, CostOverrides};
use crate::providers::openai_completions::{decode_reasoning_details, ResolvedCompat};
use crate::providers::transform_messages::transform_messages_with_normalizer;
use crate::types::{
    AssistantContent, Context, MessageExt, Model, ModelInput, StopReason, TextContent,
    ThinkingContent, Tool, ToolCall, Usage, UserMessageContent, UserOrToolContent,
};
use crate::utils_inner::sanitize_unicode::sanitize_surrogates;

/// Convert a conversation into Chat Completions `messages` params.
/// Port of `convertMessages` including tool-result bridging and image replay.
pub fn convert_messages(model: &Model, context: &Context, compat: &ResolvedCompat) -> Vec<Value> {
    use crate::types::Message;
    let mut params: Vec<Value> = Vec::new();

    let transformed =
        transform_messages_with_normalizer(&context.messages, model, &|id, model, _| {
            Some(normalize_tool_call_id(id, model))
        });

    if let Some(system_prompt) = &context.system_prompt {
        let use_developer_role = model.reasoning && compat.supports_developer_role;
        let role = if use_developer_role {
            "developer"
        } else {
            "system"
        };
        params.push(json!({
            "role": role,
            "content": sanitize_surrogates(system_prompt),
        }));
    }

    let mut last_role: Option<&'static str> = None;
    let mut index = 0usize;
    while index < transformed.len() {
        let msg = &transformed[index];
        // Some providers don't allow user messages directly after tool results.
        if compat.requires_assistant_after_tool_result
            && last_role == Some("toolResult")
            && matches!(msg, Message::User(_))
        {
            params.push(json!({
                "role": "assistant",
                "content": "I have processed the tool results.",
            }));
        }

        match msg {
            Message::User(user) => match &user.content {
                UserMessageContent::Text(text) => params.push(json!({
                    "role": "user",
                    "content": sanitize_surrogates(text),
                })),
                UserMessageContent::Blocks(blocks) => {
                    let content: Vec<Value> = blocks
                        .iter()
                        .map(|item| match crate::types::user_block_payload(item) {
                            crate::types::UserBlockPayload::Text(text) => json!({
                                "type": "text",
                                "text": sanitize_surrogates(text),
                            }),
                            crate::types::UserBlockPayload::Image { data, mime_type } => json!({
                                "type": "image_url",
                                "image_url": { "url": format!("data:{};base64,{}", mime_type, data) },
                            }),
                            crate::types::UserBlockPayload::Opaque(json) => json!({
                                "type": "text",
                                "text": sanitize_surrogates(&json),
                            }),
                        })
                        .collect();
                    if content.is_empty() {
                        index += 1;
                        continue;
                    }
                    params.push(json!({
                        "role": "user",
                        "content": content,
                    }));
                }
            },
            Message::Assistant(assistant) => {
                let mut assistant_msg = Map::new();
                assistant_msg.insert("role".into(), json!("assistant"));
                // Some providers don't accept null content; use empty string instead.
                assistant_msg.insert(
                    "content".into(),
                    if compat.requires_assistant_after_tool_result {
                        json!("")
                    } else {
                        Value::Null
                    },
                );

                let text_blocks: Vec<&TextContent> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        AssistantContent::Text(text) if !text.text.trim().is_empty() => Some(text),
                        _ => None,
                    })
                    .collect();
                let assistant_text = text_blocks
                    .iter()
                    .map(|block| sanitize_surrogates(&block.text))
                    .collect::<Vec<_>>()
                    .join("");

                let replay_reasoning_details: Vec<Value> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        AssistantContent::Thinking(thinking) => {
                            decode_reasoning_details(thinking.thinking_signature.as_deref())
                        }
                        _ => None,
                    })
                    .flatten()
                    .collect();
                if !replay_reasoning_details.is_empty() {
                    assistant_msg
                        .insert("reasoning_details".into(), json!(replay_reasoning_details));
                }

                let non_empty_thinking_blocks: Vec<&ThinkingContent> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        AssistantContent::Thinking(thinking)
                            if decode_reasoning_details(thinking.thinking_signature.as_deref())
                                .is_none()
                                && !thinking.thinking.trim().is_empty() =>
                        {
                            Some(thinking)
                        }
                        _ => None,
                    })
                    .collect();

                if !non_empty_thinking_blocks.is_empty() {
                    if compat.requires_thinking_as_text {
                        let thinking_text = non_empty_thinking_blocks
                            .iter()
                            .map(|block| sanitize_surrogates(&block.thinking))
                            .collect::<Vec<_>>()
                            .join("\n\n");
                        assistant_msg.insert(
                            "content".into(),
                            json!([{
                                "type": "text",
                                "text": thinking_text,
                            }]),
                        );
                        for block in &text_blocks {
                            assistant_msg["content"]
                                .as_array_mut()
                                .expect("content is an array")
                                .push(json!({
                                    "type": "text",
                                    "text": sanitize_surrogates(&block.text),
                                }));
                        }
                    } else {
                        // Always send assistant text as a plain string.
                        if !assistant_text.is_empty() {
                            assistant_msg.insert("content".into(), json!(assistant_text));
                        }

                        let reasoning_text = non_empty_thinking_blocks
                            .iter()
                            .map(|block| sanitize_surrogates(&block.thinking))
                            .collect::<Vec<_>>()
                            .join("\n");
                        let reasoning_field =
                            if compat.requires_reasoning_content_on_assistant_messages {
                                Some("reasoning_content")
                            } else {
                                non_empty_thinking_blocks[0].thinking_signature.as_deref()
                            };
                        match reasoning_field {
                            Some(field) => {
                                assistant_msg.insert(field.to_string(), json!(reasoning_text));
                            }
                            None => {
                                assistant_msg.insert(
                                    "content".into(),
                                    if !assistant_text.is_empty() {
                                        json!(format!("{reasoning_text}\n\n{assistant_text}"))
                                    } else {
                                        json!(reasoning_text)
                                    },
                                );
                            }
                        }
                    }
                } else if !assistant_text.is_empty() {
                    assistant_msg.insert("content".into(), json!(assistant_text));
                }

                let tool_calls: Vec<&ToolCall> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        AssistantContent::ToolCall(tool_call) => Some(tool_call),
                        _ => None,
                    })
                    .collect();
                if !tool_calls.is_empty() {
                    assistant_msg.insert(
                        "tool_calls".into(),
                        json!(tool_calls
                            .iter()
                            .map(|tool_call| json!({
                                "id": tool_call.id,
                                "type": "function",
                                "function": {
                                    "name": tool_call.name,
                                    "arguments": serde_json::Value::Object(tool_call.arguments.clone()).to_string(),
                                },
                            }))
                            .collect::<Vec<_>>()),
                    );
                    let reasoning_details: Vec<Value> = tool_calls
                        .iter()
                        .filter_map(|tool_call| {
                            tool_call
                                .thought_signature
                                .as_ref()
                                .and_then(|signature| serde_json::from_str(signature).ok())
                        })
                        .collect();
                    if !reasoning_details.is_empty() && replay_reasoning_details.is_empty() {
                        assistant_msg.insert("reasoning_details".into(), json!(reasoning_details));
                    }
                }
                if compat.requires_reasoning_content_on_assistant_messages
                    && model.reasoning
                    && !assistant_msg.contains_key("reasoning_content")
                {
                    assistant_msg.insert("reasoning_content".into(), json!(""));
                }
                if !replay_reasoning_details.is_empty()
                    && assistant_msg.get("content") == Some(&Value::Null)
                    && !assistant_msg.contains_key("tool_calls")
                {
                    assistant_msg.insert("content".into(), json!(""));
                }
                // Skip assistant messages that have no content and no tool calls.
                let content = assistant_msg.get("content");
                let has_content = match content {
                    Some(Value::Null) | None => false,
                    Some(Value::String(text)) => !text.is_empty(),
                    Some(Value::Array(array)) => !array.is_empty(),
                    Some(_) => true,
                };
                if !has_content
                    && !assistant_msg.contains_key("tool_calls")
                    && replay_reasoning_details.is_empty()
                {
                    index += 1;
                    continue;
                }
                params.push(Value::Object(assistant_msg));
            }
            Message::ToolResult(_) => {
                let mut image_blocks: Vec<Value> = Vec::new();
                let mut j = index;
                while j < transformed.len() {
                    let Message::ToolResult(tool_msg) = &transformed[j] else {
                        break;
                    };

                    let text_result = tool_msg
                        .content
                        .iter()
                        .filter_map(|block| match block {
                            UserOrToolContent::Text(text) => Some(text.text.clone()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    let has_images = tool_msg
                        .content
                        .iter()
                        .any(|block| matches!(block, UserOrToolContent::Image(_)));

                    let has_text = !text_result.is_empty();
                    let mut tool_result_msg = Map::new();
                    tool_result_msg.insert("role".into(), json!("tool"));
                    tool_result_msg.insert(
                        "content".into(),
                        json!(sanitize_surrogates(if has_text {
                            text_result.as_str()
                        } else if has_images {
                            "(see attached image)"
                        } else {
                            ""
                        })),
                    );
                    tool_result_msg.insert("tool_call_id".into(), json!(tool_msg.tool_call_id));
                    if compat.requires_tool_result_name && !tool_msg.tool_name.is_empty() {
                        tool_result_msg.insert("name".into(), json!(tool_msg.tool_name));
                    }
                    params.push(Value::Object(tool_result_msg));

                    if has_images
                        && model
                            .input
                            .iter()
                            .any(|mode| matches!(mode, ModelInput::Image))
                    {
                        for block in &tool_msg.content {
                            if let UserOrToolContent::Image(image) = block {
                                image_blocks.push(json!({
                                    "type": "image_url",
                                    "image_url": { "url": format!("data:{};base64,{}", image.mime_type, image.data) },
                                }));
                            }
                        }
                    }
                    j += 1;
                }

                index = j;
                if !image_blocks.is_empty() {
                    if compat.requires_assistant_after_tool_result {
                        params.push(json!({
                            "role": "assistant",
                            "content": "I have processed the tool results.",
                        }));
                    }
                    let mut content = vec![json!({
                        "type": "text",
                        "text": "Attached image(s) from tool result:",
                    })];
                    content.extend(image_blocks);
                    params.push(json!({
                        "role": "user",
                        "content": content,
                    }));
                    last_role = Some("user");
                } else {
                    last_role = Some("toolResult");
                }
                continue;
            }
        }

        last_role = Some(msg.role());
        index += 1;
    }

    params
}

/// Normalize a tool call ID for providers that reject long/pipe-separated IDs.
pub fn normalize_tool_call_id(id: &str, model: &Model) -> String {
    if id.contains('|') {
        let call_id = id.split('|').next().unwrap_or("");
        call_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .take(40)
            .collect()
    } else if model.provider == "openai" {
        id.chars().take(40).collect()
    } else {
        id.to_string()
    }
}

pub fn convert_tools(tools: &[Tool], compat: &ResolvedCompat) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            let mut function = Map::new();
            function.insert("name".into(), json!(tool.name));
            function.insert("description".into(), json!(tool.description));
            function.insert("parameters".into(), tool.parameters.clone());
            // Only include strict if provider supports it. Some reject unknown fields.
            if compat.supports_strict_mode {
                function.insert("strict".into(), json!(false));
            }
            json!({
                "type": "function",
                "function": Value::Object(function),
            })
        })
        .collect()
}

pub(crate) fn parse_chunk_usage(
    raw_usage: &Value,
    model: &Model,
    cache_write_cost: Option<f64>,
) -> Usage {
    let get_u64 = |value: &Value| value.as_u64().unwrap_or(0);
    let prompt_tokens = raw_usage.get("prompt_tokens").map(get_u64).unwrap_or(0);
    let reported_cached_tokens = raw_usage
        .get("prompt_tokens_details")
        .and_then(|details| details.get("cached_tokens"))
        .map(get_u64)
        .or_else(|| raw_usage.get("prompt_cache_hit_tokens").map(get_u64))
        .unwrap_or(0);
    let cache_write_tokens = raw_usage
        .get("prompt_tokens_details")
        .and_then(|details| details.get("cache_write_tokens"))
        .map(get_u64)
        .unwrap_or(0);

    // Normalize to the provider-layer usage accounting semantics:
    // - cacheRead: hits from cache created by previous requests only
    // - cacheWrite: tokens written to cache in this request
    // Some OpenAI-compatible providers (observed on OpenRouter) report
    // cached_tokens as (previous hits + current writes). Remove cacheWrite from
    // cacheRead in that case.
    let cache_read_tokens = if cache_write_tokens > 0 {
        reported_cached_tokens.saturating_sub(cache_write_tokens)
    } else {
        reported_cached_tokens
    };

    let input = prompt_tokens
        .saturating_sub(cache_read_tokens)
        .saturating_sub(cache_write_tokens);
    // OpenAI completion_tokens already includes reasoning_tokens.
    let output_tokens = raw_usage.get("completion_tokens").map(get_u64).unwrap_or(0);
    let mut usage = Usage {
        input,
        output: output_tokens,
        cache_read: cache_read_tokens,
        cache_write: cache_write_tokens,
        total_tokens: input + output_tokens + cache_read_tokens + cache_write_tokens,
        cost: Default::default(),
    };
    calculate_cost(
        model,
        &mut usage,
        cache_write_cost
            .map(|cache_write| CostOverrides {
                cache_write: Some(cache_write),
            })
            .as_ref(),
    );
    usage
}

pub(crate) fn map_stop_reason(reason: &str) -> (StopReason, Option<String>) {
    match reason {
        "stop" | "end" => (StopReason::Stop, None),
        "length" => (StopReason::Length, None),
        "function_call" | "tool_calls" => (StopReason::ToolUse, None),
        "content_filter" => (
            StopReason::Error,
            Some("Provider finish_reason: content_filter".to_string()),
        ),
        "network_error" => (
            StopReason::Error,
            Some("Provider finish_reason: network_error".to_string()),
        ),
        other => (
            StopReason::Error,
            Some(format!("Provider finish_reason: {other}")),
        ),
    }
}
