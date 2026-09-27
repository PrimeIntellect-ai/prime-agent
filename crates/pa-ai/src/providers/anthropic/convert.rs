//! Anthropic Messages conversion: content blocks, messages, and tools.
//! Section of the port of `packages/ai/src/providers/anthropic.ts`.

use serde_json::{json, Map, Value};

use crate::providers::anthropic::{to_claude_code_name, CacheControl};
use crate::types::{
    AssistantContent, Context, Message, Model, StopReason, Tool, UserMessageContent,
    UserOrToolContent,
};
use crate::utils_inner::sanitize_unicode::sanitize_surrogates;

pub(crate) fn normalize_tool_call_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect()
}

pub(crate) fn convert_content_blocks(content: &[UserOrToolContent]) -> Value {
    let has_images = content
        .iter()
        .any(|block| matches!(block, UserOrToolContent::Image(_)));
    if !has_images {
        let text = content
            .iter()
            .map(|block| match crate::types::user_block_payload(block) {
                crate::types::UserBlockPayload::Text(text) => text.to_string(),
                crate::types::UserBlockPayload::Image { data, .. } => data.to_string(),
                crate::types::UserBlockPayload::Opaque(json) => json,
            })
            .collect::<Vec<_>>()
            .join("\n");
        return json!(sanitize_surrogates(&text));
    }
    let mut blocks: Vec<Value> = content
        .iter()
        .map(|block| match crate::types::user_block_payload(block) {
            crate::types::UserBlockPayload::Text(text) => json!({
                "type": "text",
                "text": sanitize_surrogates(text),
            }),
            crate::types::UserBlockPayload::Image { data, mime_type } => json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": mime_type,
                    "data": data,
                },
            }),
            crate::types::UserBlockPayload::Opaque(json) => json!({
                "type": "text",
                "text": sanitize_surrogates(&json),
            }),
        })
        .collect();
    let has_text = blocks
        .iter()
        .any(|block| block.get("type").and_then(|value| value.as_str()) == Some("text"));
    if !has_text {
        blocks.insert(0, json!({ "type": "text", "text": "(see attached image)" }));
    }
    json!(blocks)
}

pub fn convert_messages(
    context: &Context,
    model: &Model,
    is_oauth_token: bool,
    cache_control: Option<&CacheControl>,
) -> Vec<Value> {
    let mut params: Vec<Value> = Vec::new();
    let transformed = crate::providers::transform_messages::transform_messages_with_normalizer(
        &context.messages,
        model,
        &|id, _model, _source| Some(normalize_tool_call_id(id)),
    );

    let mut index = 0usize;
    while index < transformed.len() {
        let msg = &transformed[index];
        match msg {
            Message::User(user) => match &user.content {
                UserMessageContent::Text(text) => {
                    if !text.trim().is_empty() {
                        params.push(json!({
                            "role": "user",
                            "content": sanitize_surrogates(text),
                        }));
                    }
                }
                UserMessageContent::Blocks(blocks) => {
                    let converted: Vec<Value> = blocks
                        .iter()
                        .map(|item| match crate::types::user_block_payload(item) {
                            crate::types::UserBlockPayload::Text(text) => json!({
                                "type": "text",
                                "text": sanitize_surrogates(text),
                            }),
                            crate::types::UserBlockPayload::Image { data, mime_type } => json!({
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": mime_type,
                                    "data": data,
                                },
                            }),
                            crate::types::UserBlockPayload::Opaque(json) => json!({
                                "type": "text",
                                "text": sanitize_surrogates(&json),
                            }),
                        })
                        .collect();
                    let filtered: Vec<Value> = converted
                        .into_iter()
                        .filter(|block| {
                            if block.get("type").and_then(|value| value.as_str()) == Some("text") {
                                block["text"]
                                    .as_str()
                                    .is_some_and(|text| !text.trim().is_empty())
                            } else {
                                true
                            }
                        })
                        .collect();
                    if filtered.is_empty() {
                        index += 1;
                        continue;
                    }
                    params.push(json!({
                        "role": "user",
                        "content": filtered,
                    }));
                }
            },
            Message::Assistant(assistant) => {
                let mut blocks: Vec<Value> = Vec::new();
                for block in &assistant.content {
                    match block {
                        AssistantContent::Text(text) => {
                            if text.text.trim().is_empty() {
                                continue;
                            }
                            blocks.push(json!({
                                "type": "text",
                                "text": sanitize_surrogates(&text.text),
                            }));
                        }
                        AssistantContent::Thinking(thinking) => {
                            if thinking.redacted.unwrap_or(false) {
                                blocks.push(json!({
                                    "type": "redacted_thinking",
                                    "data": thinking.thinking_signature.clone().unwrap_or_default(),
                                }));
                                continue;
                            }
                            if thinking.thinking.trim().is_empty() {
                                continue;
                            }
                            let signature = thinking.thinking_signature.as_deref().unwrap_or("");
                            if signature.trim().is_empty() {
                                blocks.push(json!({
                                    "type": "text",
                                    "text": sanitize_surrogates(&thinking.thinking),
                                }));
                            } else {
                                blocks.push(json!({
                                    "type": "thinking",
                                    "thinking": sanitize_surrogates(&thinking.thinking),
                                    "signature": signature,
                                }));
                            }
                        }
                        AssistantContent::ToolCall(tool_call) => {
                            blocks.push(json!({
                                "type": "tool_use",
                                "id": tool_call.id,
                                "name": if is_oauth_token {
                                    to_claude_code_name(&tool_call.name)
                                } else {
                                    tool_call.name.clone()
                                },
                                "input": Value::Object(tool_call.arguments.clone()),
                            }));
                        }
                    }
                }
                if blocks.is_empty() {
                    index += 1;
                    continue;
                }
                params.push(json!({
                    "role": "assistant",
                    "content": blocks,
                }));
            }
            Message::ToolResult(_tool_result) => {
                // Collect all consecutive toolResult messages into one user turn.
                let mut tool_results: Vec<Value> = Vec::new();
                let mut j = index;
                while j < transformed.len() {
                    let Message::ToolResult(result) = &transformed[j] else {
                        break;
                    };
                    tool_results.push(json!({
                        "type": "tool_result",
                        "tool_use_id": result.tool_call_id,
                        "content": convert_content_blocks(&result.content),
                        "is_error": result.is_error,
                    }));
                    j += 1;
                }
                index = j;
                params.push(json!({
                    "role": "user",
                    "content": tool_results,
                }));
                continue;
            }
        }
        index += 1;
    }

    // Add cache_control to the last user message to cache conversation history.
    if let Some(cache_control) = cache_control {
        if let Some(last) = params.last_mut() {
            if last.get("role").and_then(|value| value.as_str()) == Some("user") {
                let content = &mut last["content"];
                if let Value::String(text) = content {
                    let text = text.clone();
                    *last = json!({
                        "role": "user",
                        "content": [{
                            "type": "text",
                            "text": text,
                            "cache_control": cache_control.to_json(),
                        }],
                    });
                } else if let Value::Array(blocks) = content {
                    if let Some(last_block) = blocks.last_mut() {
                        let block_type = last_block
                            .get("type")
                            .and_then(|value| value.as_str())
                            .unwrap_or("");
                        if block_type == "text"
                            || block_type == "image"
                            || block_type == "tool_result"
                        {
                            last_block
                                .as_object_mut()
                                .expect("content blocks are objects")
                                .insert("cache_control".into(), cache_control.to_json());
                        }
                    }
                }
            }
        }
    }

    params
}

pub fn convert_tools(
    tools: &[Tool],
    is_oauth_token: bool,
    supports_eager_tool_input_streaming: bool,
    cache_control: Option<&CacheControl>,
) -> Vec<Value> {
    tools
        .iter()
        .enumerate()
        .map(|(index, tool)| {
            let mut entry = Map::new();
            entry.insert(
                "name".into(),
                json!(if is_oauth_token {
                    to_claude_code_name(&tool.name)
                } else {
                    tool.name.clone()
                }),
            );
            entry.insert("description".into(), json!(tool.description));
            if supports_eager_tool_input_streaming {
                entry.insert("eager_input_streaming".into(), json!(true));
            }
            entry.insert(
                "input_schema".into(),
                json!({
                    "type": "object",
                    "properties": tool.parameters.get("properties").cloned().unwrap_or_else(|| json!({})),
                    "required": tool.parameters.get("required").cloned().unwrap_or_else(|| json!([])),
                }),
            );
            if let Some(cache_control) = cache_control {
                if index == tools.len() - 1 {
                    entry.insert("cache_control".into(), cache_control.to_json());
                }
            }
            Value::Object(entry)
        })
        .collect()
}

pub(crate) fn map_stop_reason(reason: &str) -> Result<StopReason, String> {
    match reason {
        "end_turn" | "pause_turn" | "stop_sequence" => Ok(StopReason::Stop),
        "max_tokens" => Ok(StopReason::Length),
        "tool_use" => Ok(StopReason::ToolUse),
        "refusal" | "sensitive" => Ok(StopReason::Error),
        other => Err(format!("Unhandled stop reason: {other}")),
    }
}
