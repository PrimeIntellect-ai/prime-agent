//! Converse Stream event handling: content-block slots, deltas, metadata, and
//! exception mapping. Section of the port of
//! `packages/ai/src/providers/amazon-bedrock.ts`.

use std::collections::HashMap;

use serde_json::Value;

use crate::event_stream::{AssistantMessageEvent, AssistantMessageEventWriter};
use crate::models::calculate_cost;
use crate::providers::bedrock::{bedrock_exception_message, map_stop_reason};
use crate::types::{
    AssistantContent, AssistantMessage, Model, StopReason, TextContent, ThinkingContent, ToolCall,
};
use crate::utils_inner::json_parse::parse_streaming_json;
use crate::utils_inner::stream_failure::ProviderError;

/// Scratch state for the Converse Stream event loop.
pub(crate) struct BedrockStreamState {
    /// contentBlockIndex -> slot in `output.content`.
    slots: HashMap<u64, BlockSlot>,
}

enum BlockSlot {
    Text { index: usize },
    Thinking { index: usize },
    ToolUse { index: usize, partial_json: String },
}

impl BedrockStreamState {
    pub(crate) fn new() -> Self {
        Self {
            slots: HashMap::new(),
        }
    }
}

pub(crate) fn handle_event(
    message: &crate::providers::bedrock::eventstream::EventStreamMessage,
    model: &Model,
    output: &mut AssistantMessage,
    writer: &AssistantMessageEventWriter,
    state: &mut BedrockStreamState,
    request_id: &Option<String>,
) -> Result<(), ProviderError> {
    let payload = String::from_utf8_lossy(&message.payload);
    let parsed: Value = serde_json::from_str(payload.trim()).unwrap_or(Value::Null);

    // Exception events carry :exception-type and a JSON payload with message.
    // TS rethrows the modeled SDK exception, so `formatBedrockError` composes
    // `{prefix}: {message}` and the diagnostic records the exception name.
    if let Some(exception_type) = &message.exception_type {
        let detail = parsed
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("no detail");
        return Err(ProviderError::Http(
            crate::utils_inner::stream_failure::ProviderHttpError {
                message: bedrock_exception_message(exception_type, detail),
                // AWS SDK stream exceptions carry no HTTP status for the
                // classifier; the exception name is the classification key.
                status: None,
                body: None,
                headers: Default::default(),
                request_id: request_id.clone(),
                sdk_name: Some(exception_type.clone()),
                retry_after_ms: None,
                provider_error_type: None,
            },
        ));
    }

    if let Some(message_start) = parsed.get("messageStart") {
        let role = message_start
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("");
        if role != "assistant" {
            return Err(ProviderError::Message(
                "Unexpected assistant message start but got user message start instead".to_string(),
            ));
        }
        writer.push(AssistantMessageEvent::Start {
            partial: output.clone(),
        });
        return Ok(());
    }

    if let Some(content_block_start) = parsed.get("contentBlockStart") {
        handle_content_block_start(content_block_start, output, writer, state);
        return Ok(());
    }

    if let Some(content_block_delta) = parsed.get("contentBlockDelta") {
        handle_content_block_delta(content_block_delta, model, output, writer, state);
        return Ok(());
    }

    if let Some(content_block_stop) = parsed.get("contentBlockStop") {
        handle_content_block_stop(content_block_stop, output, writer, state)?;
        return Ok(());
    }

    if let Some(message_stop) = parsed.get("messageStop") {
        let stop_reason = message_stop.get("stopReason").and_then(Value::as_str);
        output.stop_reason = map_stop_reason(stop_reason);
        if output.stop_reason == StopReason::Error {
            output.stop_reason_raw = stop_reason.map(str::to_string);
        }
        return Ok(());
    }

    if let Some(metadata) = parsed.get("metadata") {
        handle_metadata(metadata, model, output, request_id);
        return Ok(());
    }

    Ok(())
}

fn handle_content_block_start(
    event: &Value,
    output: &mut AssistantMessage,
    writer: &AssistantMessageEventWriter,
    state: &mut BedrockStreamState,
) {
    let content_block_index = event
        .get("contentBlockIndex")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let start = event.get("start");

    if let Some(tool_use) = start.and_then(|start| start.get("toolUse")) {
        output.content.push(AssistantContent::ToolCall(ToolCall {
            id: tool_use
                .get("toolUseId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            name: tool_use
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            arguments: Default::default(),
            thought_signature: None,
            rest: Default::default(),
        }));
        let index = output.content.len() - 1;
        state.slots.insert(
            content_block_index,
            BlockSlot::ToolUse {
                index,
                partial_json: String::new(),
            },
        );
        writer.push(AssistantMessageEvent::ToolcallStart {
            content_index: index as u64,
            partial: output.clone(),
        });
    }
}

fn handle_content_block_delta(
    event: &Value,
    _model: &Model,
    output: &mut AssistantMessage,
    writer: &AssistantMessageEventWriter,
    state: &mut BedrockStreamState,
) {
    let content_block_index = event
        .get("contentBlockIndex")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let delta = event.get("delta");

    let text = delta
        .and_then(|delta| delta.get("text"))
        .and_then(Value::as_str);
    let tool_input = delta
        .and_then(|delta| delta.get("toolUse"))
        .and_then(|tool_use| tool_use.get("input"))
        .and_then(Value::as_str);
    let reasoning = delta.and_then(|delta| delta.get("reasoningContent"));

    if let Some(text) = text {
        // If no text block exists yet, create one: contentBlockStart is not
        // sent for text blocks.
        let slot = if let Some(slot) = state.slots.get(&content_block_index) {
            slot
        } else {
            output.content.push(AssistantContent::Text(TextContent {
                text: String::new(),
                text_signature: None,
                rest: Default::default(),
            }));
            let index = output.content.len() - 1;
            state
                .slots
                .insert(content_block_index, BlockSlot::Text { index });
            writer.push(AssistantMessageEvent::TextStart {
                content_index: index as u64,
                partial: output.clone(),
            });
            state
                .slots
                .get(&content_block_index)
                .expect("just inserted")
        };
        let index = match slot {
            BlockSlot::Text { index } => *index,
            _ => return,
        };
        if let AssistantContent::Text(block) = &mut output.content[index] {
            block.text.push_str(text);
        }
        writer.push(AssistantMessageEvent::TextDelta {
            content_index: index as u64,
            delta: text.to_string(),
            partial: output.clone(),
        });
        return;
    }

    if let Some(tool_input) = tool_input {
        if let Some(BlockSlot::ToolUse {
            index,
            partial_json,
        }) = state.slots.get_mut(&content_block_index)
        {
            let index = *index;
            partial_json.push_str(tool_input);
            let parsed = parse_streaming_json(Some(partial_json));
            if let AssistantContent::ToolCall(block) = &mut output.content[index] {
                if let Value::Object(map) = parsed {
                    block.arguments = map;
                }
            }
            let partial = output.clone();
            writer.push(AssistantMessageEvent::ToolcallDelta {
                content_index: index as u64,
                delta: tool_input.to_string(),
                partial,
            });
        }
        return;
    }

    if let Some(reasoning) = reasoning {
        let slot = if let Some(slot) = state.slots.get(&content_block_index) {
            slot
        } else {
            output
                .content
                .push(AssistantContent::Thinking(ThinkingContent {
                    thinking: String::new(),
                    thinking_signature: Some(String::new()),
                    redacted: None,
                    rest: Default::default(),
                }));
            let index = output.content.len() - 1;
            state
                .slots
                .insert(content_block_index, BlockSlot::Thinking { index });
            writer.push(AssistantMessageEvent::ThinkingStart {
                content_index: index as u64,
                partial: output.clone(),
            });
            state
                .slots
                .get(&content_block_index)
                .expect("just inserted")
        };
        let index = match slot {
            BlockSlot::Thinking { index } => *index,
            _ => return,
        };
        let mut signature_delta = None;
        if let AssistantContent::Thinking(block) = &mut output.content[index] {
            if let Some(text) = reasoning.get("text").and_then(Value::as_str) {
                block.thinking.push_str(text);
            }
            if let Some(signature) = reasoning.get("signature").and_then(Value::as_str) {
                signature_delta = Some(signature.to_string());
                block.thinking_signature =
                    Some(block.thinking_signature.take().unwrap_or_default() + signature);
            }
        }
        if let Some(text) = reasoning.get("text").and_then(Value::as_str) {
            writer.push(AssistantMessageEvent::ThinkingDelta {
                content_index: index as u64,
                delta: text.to_string(),
                partial: output.clone(),
            });
        }
        let _ = signature_delta;
    }
}

fn handle_content_block_stop(
    event: &Value,
    output: &mut AssistantMessage,
    writer: &AssistantMessageEventWriter,
    state: &mut BedrockStreamState,
) -> Result<(), ProviderError> {
    let content_block_index = event
        .get("contentBlockIndex")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let Some(slot) = state.slots.remove(&content_block_index) else {
        return Ok(());
    };
    match slot {
        BlockSlot::Text { index } => {
            let content = match &output.content[index] {
                AssistantContent::Text(text) => text.text.clone(),
                _ => String::new(),
            };
            writer.push(AssistantMessageEvent::TextEnd {
                content_index: index as u64,
                content,
                partial: output.clone(),
            });
        }
        BlockSlot::Thinking { index } => {
            let content = match &output.content[index] {
                AssistantContent::Thinking(thinking) => thinking.thinking.clone(),
                _ => String::new(),
            };
            writer.push(AssistantMessageEvent::ThinkingEnd {
                content_index: index as u64,
                content,
                partial: output.clone(),
            });
        }
        BlockSlot::ToolUse {
            index,
            partial_json,
        } => {
            let parsed = parse_streaming_json(Some(partial_json.as_str()));
            let call = if let AssistantContent::ToolCall(block) = &mut output.content[index] {
                if let Value::Object(map) = parsed {
                    block.arguments = map;
                }
                block.clone()
            } else {
                return Ok(());
            };
            writer.push(AssistantMessageEvent::ToolcallEnd {
                content_index: index as u64,
                tool_call: call,
                partial: output.clone(),
            });
        }
    }
    Ok(())
}

fn handle_metadata(
    event: &Value,
    model: &Model,
    output: &mut AssistantMessage,
    request_id: &Option<String>,
) {
    let _ = request_id;
    if let Some(usage) = event.get("usage") {
        output.usage.input = usage
            .get("inputTokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        output.usage.output = usage
            .get("outputTokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        output.usage.cache_read = usage
            .get("cacheReadInputTokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        output.usage.cache_write = usage
            .get("cacheWriteInputTokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        // TS `totalTokens || input + output`: an explicitly reported zero is
        // falsy, so only a positive reported total is kept. The sum
        // saturates — TS doubles never wrap, and a Rust u64 must not
        // panic (debug) or wrap to a wrong total (release).
        output.usage.total_tokens = usage
            .get("totalTokens")
            .and_then(Value::as_u64)
            .filter(|total| *total > 0)
            .unwrap_or(output.usage.input.saturating_add(output.usage.output));
        calculate_cost(model, &mut output.usage, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{zero_model_cost, ModelInput, Usage};
    use serde_json::json;

    /// TS `amazon-bedrock.ts` `handleMetadata` assigns
    /// `usage.totalTokens = event.usage.totalTokens || input + output`, so an
    /// explicitly reported zero total is falsy and falls back to the
    /// input/output sum; a positive reported total is kept verbatim.
    #[test]
    fn metadata_usage_total_tokens_explicit_zero_falls_back_to_sum() {
        let model = Model {
            id: "anthropic.claude-fable-5".into(),
            name: "Claude Fable 5".into(),
            api: crate::providers::bedrock::API_BEDROCK_CONVERSE_STREAM.to_string(),
            provider: "bedrock".into(),
            base_url: "https://bedrock-runtime.us-east-1.amazonaws.com".into(),
            reasoning: true,
            thinking_level_map: None,
            input: vec![ModelInput::Text],
            cost: zero_model_cost(),
            context_window: 200_000,
            max_tokens: 8192,
            featured: None,
            headers: None,
            compat: None,
        };
        let request_id = None;
        let mut output = crate::event_stream::initial_assistant_message(
            crate::providers::bedrock::API_BEDROCK_CONVERSE_STREAM,
            "bedrock",
            &model.id,
        );

        handle_metadata(
            &json!({"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 0}}),
            &model,
            &mut output,
            &request_id,
        );
        assert_eq!(
            output.usage,
            Usage {
                input: 10,
                output: 5,
                total_tokens: 15,
                ..Usage::default()
            }
        );

        handle_metadata(
            &json!({"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 99}}),
            &model,
            &mut output,
            &request_id,
        );
        assert_eq!(output.usage.total_tokens, 99);

        handle_metadata(
            &json!({"usage": {"inputTokens": 10, "outputTokens": 5}}),
            &model,
            &mut output,
            &request_id,
        );
        assert_eq!(output.usage.total_tokens, 15);
    }
}
