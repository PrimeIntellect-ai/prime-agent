//! Mistral Conversations conversion: tools, chat messages, tool-result text,
//! chat payload assembly, and tool-call-id derivation/normalization.
//! Section of the port of `packages/ai/src/providers/mistral.ts`.

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::providers::mistral::MistralOptions;
use crate::types::{Context, Message, Model, ModelExt, Tool};
use crate::utils_inner::hash::short_hash;
use crate::utils_inner::sanitize_unicode::sanitize_surrogates;

const MISTRAL_TOOL_CALL_ID_LENGTH: usize = 9;

/// Stateful tool-call-id normalizer port
/// (`createMistralToolCallIdNormalizer` in the TS reference).
#[derive(Default)]
pub(crate) struct MistralToolCallIdNormalizer {
    id_map: RefCell<HashMap<String, String>>,
    reverse_map: RefCell<HashMap<String, String>>,
}

impl MistralToolCallIdNormalizer {
    pub(crate) fn normalize(&self, id: &str) -> String {
        if let Some(existing) = self.id_map.borrow().get(id) {
            return existing.clone();
        }
        let mut attempt = 0;
        loop {
            let candidate = derive_mistral_tool_call_id(id, attempt);
            let owner = self.reverse_map.borrow().get(&candidate).cloned();
            if owner.is_none() || owner.as_deref() == Some(id) {
                self.id_map
                    .borrow_mut()
                    .insert(id.to_string(), candidate.clone());
                self.reverse_map
                    .borrow_mut()
                    .insert(candidate.clone(), id.to_string());
                return candidate;
            }
            attempt += 1;
        }
    }
}

/// Port of `deriveMistralToolCallId`.
pub(crate) fn derive_mistral_tool_call_id(id: &str, attempt: u32) -> String {
    let normalized: String = id.chars().filter(char::is_ascii_alphanumeric).collect();
    if attempt == 0 && normalized.len() == MISTRAL_TOOL_CALL_ID_LENGTH {
        return normalized;
    }
    let seed_base = if normalized.is_empty() {
        id
    } else {
        &normalized
    };
    let seed = if attempt == 0 {
        seed_base.to_string()
    } else {
        format!("{seed_base}:{attempt}")
    };
    short_hash(&seed)
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(MISTRAL_TOOL_CALL_ID_LENGTH)
        .collect()
}

pub(crate) fn build_chat_payload(
    model: &Model,
    context: &Context,
    transformed_messages: &[Message],
    options: &MistralOptions,
) -> Value {
    let supports_images = model.supports_image_input();
    let mut messages = to_chat_messages(transformed_messages, supports_images);

    if let Some(system_prompt) = &context.system_prompt {
        messages.insert(
            0,
            json!({
                "role": "system",
                "content": sanitize_surrogates(system_prompt),
            }),
        );
    }

    let mut payload = Map::new();
    payload.insert("model".into(), json!(model.id));
    payload.insert("stream".into(), json!(true));
    payload.insert("messages".into(), Value::Array(messages));
    if let Some(tools) = &context.tools {
        if !tools.is_empty() {
            payload.insert("tools".into(), json!(to_function_tools(tools)));
        }
    }
    if let Some(temperature) = options.base.temperature {
        payload.insert("temperature".into(), json!(temperature));
    }
    if let Some(max_tokens) = options.base.max_tokens {
        payload.insert("max_tokens".into(), json!(max_tokens));
    }
    if let Some(tool_choice) = &options.tool_choice {
        payload.insert("tool_choice".into(), tool_choice.to_json());
    }
    if let Some(prompt_mode) = options.prompt_mode {
        payload.insert("prompt_mode".into(), json!(prompt_mode.as_str()));
    }
    if let Some(reasoning_effort) = options.reasoning_effort {
        payload.insert("reasoning_effort".into(), json!(reasoning_effort.as_str()));
    }

    Value::Object(payload)
}

/// Port of `toFunctionTools`.
fn to_function_tools(tools: &[Tool]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": strip_symbol_keys(&tool.parameters),
                    "strict": false,
                },
            })
        })
        .collect()
}

/// Port of `stripSymbolKeys`: rebuild the JSON tree as plain objects.
fn strip_symbol_keys(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(strip_symbol_keys).collect()),
        Value::Object(map) => {
            let mut result = Map::new();
            for (key, entry) in map {
                result.insert(key.clone(), strip_symbol_keys(entry));
            }
            Value::Object(result)
        }
        other => other.clone(),
    }
}

/// Port of `toChatMessages`.
fn to_chat_messages(messages: &[Message], supports_images: bool) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();

    for msg in messages {
        match msg {
            Message::User(user) => match &user.content {
                crate::types::UserMessageContent::Text(text) => {
                    result.push(json!({
                        "role": "user",
                        "content": sanitize_surrogates(text),
                    }));
                    continue;
                }
                crate::types::UserMessageContent::Blocks(blocks) => {
                    let had_images = blocks.iter().any(|item| {
                        matches!(
                            crate::types::user_block_payload(item),
                            crate::types::UserBlockPayload::Image { .. }
                        )
                    });
                    let mut content: Vec<Value> = Vec::new();
                    for item in blocks {
                        match crate::types::user_block_payload(item) {
                            crate::types::UserBlockPayload::Text(text) => {
                                content.push(json!({
                                    "type": "text",
                                    "text": sanitize_surrogates(text),
                                }));
                            }
                            crate::types::UserBlockPayload::Image { data, mime_type }
                                if supports_images =>
                            {
                                content.push(json!({
                                    "type": "image_url",
                                    "image_url": format!("data:{mime_type};base64,{data}"),
                                }));
                            }
                            crate::types::UserBlockPayload::Image { .. } => {}
                            crate::types::UserBlockPayload::Opaque(json) => {
                                content.push(json!({
                                    "type": "text",
                                    "text": sanitize_surrogates(&json),
                                }));
                            }
                        }
                    }
                    if !content.is_empty() {
                        result.push(json!({ "role": "user", "content": content }));
                        continue;
                    }
                    if had_images && !supports_images {
                        result.push(json!({
                            "role": "user",
                            "content": "(image omitted: model does not support images)",
                        }));
                    }
                    continue;
                }
            },
            Message::Assistant(assistant) => {
                let mut content_parts: Vec<Value> = Vec::new();
                let mut tool_calls: Vec<Value> = Vec::new();

                for block in &assistant.content {
                    match block {
                        crate::types::AssistantContent::Text(text) => {
                            if !text.text.trim().is_empty() {
                                content_parts.push(json!({
                                    "type": "text",
                                    "text": sanitize_surrogates(&text.text),
                                }));
                            }
                        }
                        crate::types::AssistantContent::Thinking(thinking) => {
                            if !thinking.thinking.trim().is_empty() {
                                content_parts.push(json!({
                                    "type": "thinking",
                                    "thinking": [{ "type": "text", "text": sanitize_surrogates(&thinking.thinking) }],
                                }));
                            }
                        }
                        crate::types::AssistantContent::ToolCall(call) => {
                            tool_calls.push(json!({
                                "id": call.id,
                                "type": "function",
                                "function": {
                                    "name": call.name,
                                    "arguments": serde_json::to_string(
                                        &call.arguments,
                                    ).unwrap_or_else(|_| "{}".to_string()),
                                },
                                "index": 0,
                            }));
                        }
                    }
                }

                if !content_parts.is_empty() || !tool_calls.is_empty() {
                    let mut assistant_message = Map::new();
                    assistant_message.insert("role".into(), json!("assistant"));
                    if !content_parts.is_empty() {
                        assistant_message.insert("content".into(), Value::Array(content_parts));
                    }
                    if !tool_calls.is_empty() {
                        assistant_message.insert("tool_calls".into(), Value::Array(tool_calls));
                    }
                    result.push(Value::Object(assistant_message));
                }
                continue;
            }
            Message::ToolResult(tool_result) => {
                let text_result = tool_result
                    .content
                    .iter()
                    .filter_map(|part| match part {
                        crate::types::UserOrToolContent::Text(text) => {
                            Some(sanitize_surrogates(&text.text))
                        }
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let has_images = tool_result
                    .content
                    .iter()
                    .any(|part| matches!(part, crate::types::UserOrToolContent::Image(_)));
                let tool_text = build_tool_result_text(
                    &text_result,
                    has_images,
                    supports_images,
                    tool_result.is_error,
                );

                let mut tool_content: Vec<Value> =
                    vec![json!({ "type": "text", "text": tool_text })];
                for part in &tool_result.content {
                    if !supports_images {
                        continue;
                    }
                    if let crate::types::UserOrToolContent::Image(image) = part {
                        tool_content.push(json!({
                            "type": "image_url",
                            "image_url": format!("data:{};base64,{}", image.mime_type, image.data),
                        }));
                    }
                }

                result.push(json!({
                    "role": "tool",
                    "tool_call_id": tool_result.tool_call_id,
                    "name": tool_result.tool_name,
                    "content": tool_content,
                }));
            }
        }
    }

    result
}

/// Port of `buildToolResultText`.
fn build_tool_result_text(
    text: &str,
    has_images: bool,
    supports_images: bool,
    is_error: bool,
) -> String {
    let trimmed = text.trim();
    let error_prefix = if is_error { "[tool error] " } else { "" };

    if !trimmed.is_empty() {
        let image_suffix = if has_images && !supports_images {
            "\n[tool image omitted: model does not support images]"
        } else {
            ""
        };
        return format!("{error_prefix}{trimmed}{image_suffix}");
    }

    if has_images {
        if supports_images {
            return if is_error {
                "[tool error] (see attached image)".to_string()
            } else {
                "(see attached image)".to_string()
            };
        }
        return if is_error {
            "[tool error] (image omitted: model does not support images)".to_string()
        } else {
            "(image omitted: model does not support images)".to_string()
        };
    }

    if is_error {
        "[tool error] (no tool output)".to_string()
    } else {
        "(no tool output)".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_nine_char_alnum_ids() {
        assert_eq!(
            derive_mistral_tool_call_id("abcdefghi", 0),
            "abcdefghi",
            "already-normal ids pass through"
        );
        let derived = derive_mistral_tool_call_id("toolcall:0", 0);
        assert_eq!(derived.len(), MISTRAL_TOOL_CALL_ID_LENGTH);
        assert!(derived.chars().all(|c| c.is_ascii_alphanumeric()));

        let second = derive_mistral_tool_call_id("toolcall:0", 1);
        assert_ne!(derived, second);
    }

    #[test]
    fn normalizer_is_stable_and_collision_free() {
        let normalizer = MistralToolCallIdNormalizer::default();
        let first = normalizer.normalize("call_abc123");
        let second = normalizer.normalize("call_abc123");
        assert_eq!(first, second);

        // A different id that derives the same candidate must not collide.
        let other = normalizer.normalize("call_abc123");
        assert_eq!(other, first);
    }

    #[test]
    fn builds_tool_result_text() {
        assert_eq!(build_tool_result_text("done", false, false, false), "done");
        assert_eq!(
            build_tool_result_text("boom", false, false, true),
            "[tool error] boom"
        );
        assert_eq!(
            build_tool_result_text("", true, true, false),
            "(see attached image)"
        );
        assert_eq!(
            build_tool_result_text("", true, false, false),
            "(image omitted: model does not support images)"
        );
        assert_eq!(
            build_tool_result_text("", false, false, true),
            "[tool error] (no tool output)"
        );
    }
}
