//! Anthropic Messages conversion: content blocks, messages, and tools.

use serde_json::{json, Map, Value};

use crate::providers::anthropic::{get_anthropic_compat, to_claude_code_name, CacheControl};
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

/// Merge the user turn at `position` into the user turn before it, when a skipped assistant turn
/// left the two back to back.
fn merge_user_turns_at(params: &mut Vec<Value>, position: usize) {
    let is_user = |message: Option<&Value>| {
        message
            .and_then(|message| message.get("role"))
            .and_then(Value::as_str)
            == Some("user")
    };
    if position == 0 || !is_user(params.get(position - 1)) || !is_user(params.get(position)) {
        return;
    }
    let as_blocks = |content: Value| match content {
        Value::Array(blocks) => blocks,
        Value::String(text) => vec![json!({ "type": "text", "text": text })],
        other => vec![other],
    };
    let mut next = params.remove(position);
    let mut merged = as_blocks(params[position - 1]["content"].take());
    merged.extend(as_blocks(next["content"].take()));
    params[position - 1]["content"] = Value::Array(merged);
}

// Long by design: mirrors the provider's stream shape.
#[allow(clippy::too_many_lines)]
pub fn convert_messages(
    context: &Context,
    model: &Model,
    is_oauth_token: bool,
    cache_control: Option<&CacheControl>,
) -> Vec<Value> {
    let mut params: Vec<Value> = Vec::new();
    let requires_thinking_signature = get_anthropic_compat(model).requires_thinking_signature;
    // `params` positions where an assistant turn with nothing to replay was skipped.
    let mut skipped_assistant_turns: Vec<usize> = Vec::new();
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
                            // Unsigned thinking comes from an Anthropic-compatible endpoint that
                            // never signs (MiMo, Kimi, DeepSeek), or from a Claude turn that hit
                            // `max_tokens` before the signature arrived. (Aborted and errored turns
                            // never get here: the transform step drops them, and turns thinking
                            // from another model into text.) It is never replayed as `text`: the
                            // model reads that as its own earlier reply and starts echoing its
                            // reasoning (discussion #3391). Non-signing endpoints expect their
                            // reasoning passed back, so it replays as an unsigned `thinking`
                            // block; Claude rejects a thinking block without a valid signature, so
                            // there it is dropped.
                            let signature = thinking.thinking_signature.as_deref().unwrap_or("");
                            if signature.trim().is_empty() {
                                if !requires_thinking_signature {
                                    blocks.push(json!({
                                        "type": "thinking",
                                        "thinking": sanitize_surrogates(&thinking.thinking),
                                    }));
                                }
                                continue;
                            }
                            blocks.push(json!({
                                "type": "thinking",
                                "thinking": sanitize_surrogates(&thinking.thinking),
                                "signature": signature,
                            }));
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
                    // Skipping the turn can put two user turns back to back (a Claude turn
                    // cut off by `max_tokens` mid-thinking has nothing left to replay); they
                    // are merged below.
                    skipped_assistant_turns.push(params.len());
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

    for &position in skipped_assistant_turns.iter().rev() {
        merge_user_turns_at(&mut params, position);
    }

    // Add cache_control to the last user message to cache conversation history.
    if let Some(cache_control) = cache_control {
        if let Some(last) = params.last_mut() {
            if last.get("role").and_then(|value| value.as_str()) == Some("user") {
                let content_value = &mut last["content"];
                if let Value::String(text) = content_value {
                    let text = text.clone();
                    *last = json!({
                        "role": "user",
                        "content": [{
                            "type": "text",
                            "text": text,
                            "cache_control": cache_control.to_json(),
                        }],
                    });
                } else if let Value::Array(blocks) = content_value {
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

#[cfg(test)]
mod tests {
    use super::convert_messages;
    use crate::types::{Context, Message, Model};
    use serde_json::{json, Value};

    /// A model on a non-signing Anthropic-compatible endpoint (discussion #3391).
    fn mimo() -> Model {
        model(&json!({"id": "mimo-v2.6-pro", "provider": "xiaomi"}))
    }

    fn claude() -> Model {
        model(&json!({"id": "claude-sonnet-5", "provider": "anthropic"}))
    }

    fn model(fields: &Value) -> Model {
        let mut model = json!({
            "name": "model", "api": "anthropic-messages", "baseUrl": "http://localhost",
            "reasoning": true, "input": ["text"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 128_000, "maxTokens": 8192
        });
        model
            .as_object_mut()
            .expect("model object")
            .extend(fields.as_object().expect("fields object").clone());
        serde_json::from_value(model).expect("model json")
    }

    /// The request messages for a user prompt, one same-model assistant turn of `blocks` that
    /// stopped on `stop_reason`, and a follow-up prompt.
    fn convert(model: &Model, blocks: &Value, stop_reason: &str) -> Vec<Value> {
        let messages: Vec<Message> = serde_json::from_value(json!([
            {"role": "user", "content": "rebuild", "timestamp": 1},
            {
                "role": "assistant", "content": blocks,
                "api": "anthropic-messages", "provider": model.provider, "model": model.id,
                "usage": {
                    "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}
                },
                "stopReason": stop_reason, "timestamp": 2
            },
            {"role": "user", "content": "again", "timestamp": 3}
        ]))
        .expect("messages json");
        let context = Context {
            system_prompt: None,
            messages,
            tools: None,
        };
        convert_messages(&context, model, false, None)
    }

    fn assistant_turn(model: &Model, blocks: &Value) -> Value {
        convert(model, blocks, "stop")
            .into_iter()
            .find(|message| message["role"] == "assistant")
            .unwrap_or(Value::Null)
    }

    fn unsigned_turn() -> Value {
        json!([
            {"type": "thinking", "thinking": "Let me do it fast.", "thinkingSignature": ""},
            {"type": "thinking", "thinking": "No signature field at all."},
            {"type": "text", "text": "Rebuilt."}
        ])
    }

    /// Discussion #3391: a non-signing endpoint gets its unsigned thinking back as `thinking`
    /// blocks, never as visible text the model then imitates.
    #[test]
    fn unsigned_thinking_replays_as_thinking_on_a_non_signing_endpoint() {
        assert_eq!(
            assistant_turn(&mimo(), &unsigned_turn()),
            json!({"role": "assistant", "content": [
                {"type": "thinking", "thinking": "Let me do it fast."},
                {"type": "thinking", "thinking": "No signature field at all."},
                {"type": "text", "text": "Rebuilt."}
            ]})
        );
    }

    /// Claude rejects a thinking block without a valid signature, so unsigned thinking is dropped
    /// there, and on any model whose compat says it requires one.
    #[test]
    fn unsigned_thinking_is_dropped_where_a_signature_is_required() {
        let mut flagged = mimo();
        flagged.compat = serde_json::from_value(json!({"requiresThinkingSignature": true}))
            .expect("compat json");
        for model in [claude(), flagged] {
            assert_eq!(
                assistant_turn(&model, &unsigned_turn()),
                json!({"role": "assistant", "content": [{"type": "text", "text": "Rebuilt."}]}),
                "{}",
                model.id
            );
        }
    }

    /// A Claude turn cut off by `max_tokens` mid-thinking has nothing left to replay; its
    /// neighbouring user turns merge instead of going out back to back.
    #[test]
    fn a_dropped_thinking_only_turn_leaves_no_back_to_back_user_turns() {
        let params = convert(
            &claude(),
            &json!([{"type": "thinking", "thinking": "Half a thou"}]),
            "length",
        );
        assert_eq!(
            params,
            vec![json!({"role": "user", "content": [
                {"type": "text", "text": "rebuild"},
                {"type": "text", "text": "again"}
            ]})]
        );
    }

    /// Signed thinking still replays as a `thinking` block with its signature.
    #[test]
    fn signed_thinking_replays_as_thinking() {
        let turn = assistant_turn(
            &claude(),
            &json!([
                {"type": "thinking", "thinking": "Plan.", "thinkingSignature": "sig"},
                {"type": "text", "text": "Rebuilt."}
            ]),
        );
        assert_eq!(
            turn,
            json!({"role": "assistant", "content": [
                {"type": "thinking", "thinking": "Plan.", "signature": "sig"},
                {"type": "text", "text": "Rebuilt."}
            ]})
        );
    }
}
