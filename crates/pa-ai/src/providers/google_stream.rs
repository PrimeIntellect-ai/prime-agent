//! Shared Google stream-chunk processing.
//!
//! The chunk handler in the TS reference is duplicated across `google.ts` and
//! `google-vertex.ts`; this module is the single Rust implementation used by
//! both providers: text/thinking part transitions with thought-signature
//! retention, function-call tool calls, finish-reason mapping, and usage
//! accounting.

use serde_json::Value;

use crate::event_stream::{AssistantMessageEvent, AssistantMessageEventWriter};
use crate::models::calculate_cost;
use crate::providers::google_shared::{
    is_thinking_part, map_google_stop_reason, retain_thought_signature,
};
use crate::types::{
    AssistantContent, AssistantMessage, Model, StopReason, TextContent, ThinkingContent, ToolCall,
    Usage,
};

/// Streaming state shared by the Gemini and Vertex providers.
pub struct GoogleStreamState {
    /// Currently open block kind ("text" or "thinking").
    current_kind: Option<&'static str>,
    tool_call_counter: u64,
}

impl GoogleStreamState {
    pub fn new() -> Self {
        Self {
            current_kind: None,
            tool_call_counter: 0,
        }
    }

    fn close_current_block(
        &mut self,
        output: &AssistantMessage,
        writer: &AssistantMessageEventWriter,
    ) {
        let Some(kind) = self.current_kind.take() else {
            return;
        };
        let Some(index) = output.content.len().checked_sub(1) else {
            return;
        };
        match kind {
            "text" => writer.push(AssistantMessageEvent::TextEnd {
                content_index: index as u64,
                content: match &output.content[index] {
                    AssistantContent::Text(text) => text.text.clone(),
                    _ => String::new(),
                },
                partial: output.clone(),
            }),
            _ => writer.push(AssistantMessageEvent::ThinkingEnd {
                content_index: index as u64,
                content: match &output.content[index] {
                    AssistantContent::Thinking(thinking) => thinking.thinking.clone(),
                    _ => String::new(),
                },
                partial: output.clone(),
            }),
        }
    }

    /// Process one streamed `GenerateContentResponse` chunk.
    pub fn handle_chunk(
        &mut self,
        chunk: &Value,
        model: &Model,
        output: &mut AssistantMessage,
        writer: &AssistantMessageEventWriter,
    ) -> Result<(), String> {
        use AssistantMessageEvent;
        if output.response_id.is_none() {
            if let Some(id) = chunk.get("responseId").and_then(|value| value.as_str()) {
                output.response_id = Some(id.to_string());
            }
        }
        let candidate = chunk
            .get("candidates")
            .and_then(|value| value.as_array())
            .and_then(|candidates| candidates.first())
            .cloned();

        if let Some(candidate) = &candidate {
            if let Some(parts) = candidate
                .get("content")
                .and_then(|content| content.get("parts"))
                .and_then(|value| value.as_array())
            {
                for part in parts {
                    if let Some(text) = part.get("text").and_then(|value| value.as_str()) {
                        let is_thinking = is_thinking_part(part);
                        let matches_kind = match &self.current_kind {
                            Some(kind) => {
                                (is_thinking && *kind == "thinking")
                                    || (!is_thinking && *kind == "text")
                            }
                            None => false,
                        };
                        if !matches_kind {
                            self.close_current_block(output, writer);
                            if is_thinking {
                                output
                                    .content
                                    .push(AssistantContent::Thinking(ThinkingContent {
                                        thinking: String::new(),
                                        thinking_signature: None,
                                        redacted: None,
                                        rest: Map::default(),
                                    }));
                                self.current_kind = Some("thinking");
                                writer.push(AssistantMessageEvent::ThinkingStart {
                                    content_index: (output.content.len() - 1) as u64,
                                    partial: output.clone(),
                                });
                            } else {
                                output.content.push(AssistantContent::Text(TextContent {
                                    text: String::new(),
                                    text_signature: None,
                                    rest: Map::default(),
                                }));
                                self.current_kind = Some("text");
                                writer.push(AssistantMessageEvent::TextStart {
                                    content_index: (output.content.len() - 1) as u64,
                                    partial: output.clone(),
                                });
                            }
                        }
                        let index = output.content.len() - 1;
                        let signature = part
                            .get("thoughtSignature")
                            .and_then(|value| value.as_str());
                        if is_thinking {
                            if let Some(AssistantContent::Thinking(thinking)) =
                                output.content.get_mut(index)
                            {
                                thinking.thinking.push_str(text);
                                thinking.thinking_signature = retain_thought_signature(
                                    thinking.thinking_signature.as_deref(),
                                    signature,
                                );
                            }
                            writer.push(AssistantMessageEvent::ThinkingDelta {
                                content_index: index as u64,
                                delta: text.to_string(),
                                partial: output.clone(),
                            });
                        } else {
                            if let Some(AssistantContent::Text(text_block)) =
                                output.content.get_mut(index)
                            {
                                text_block.text.push_str(text);
                                text_block.text_signature = retain_thought_signature(
                                    text_block.text_signature.as_deref(),
                                    signature,
                                );
                            }
                            writer.push(AssistantMessageEvent::TextDelta {
                                content_index: index as u64,
                                delta: text.to_string(),
                                partial: output.clone(),
                            });
                        }
                    }

                    if part.get("functionCall").is_some() {
                        self.close_current_block(output, writer);
                        let function_call =
                            part.get("functionCall").cloned().unwrap_or(Value::Null);
                        let provided_id = function_call.get("id").and_then(|value| value.as_str());
                        let needs_new_id = match provided_id {
                            None => true,
                            Some(id) => output.content.iter().any(|block| {
                                matches!(block, AssistantContent::ToolCall(tool_call) if tool_call.id == id)
                            }),
                        };
                        let tool_call_id = if needs_new_id {
                            self.tool_call_counter += 1;
                            format!(
                                "{}_{}_{}",
                                function_call
                                    .get("name")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or_default(),
                                crate::utils_inner::diagnostics::now_ms(),
                                self.tool_call_counter
                            )
                        } else {
                            provided_id.unwrap_or_default().to_string()
                        };

                        let tool_call = ToolCall {
                            id: tool_call_id,
                            name: function_call
                                .get("name")
                                .and_then(|value| value.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            arguments: function_call
                                .get("args")
                                .and_then(|value| value.as_object())
                                .cloned()
                                .unwrap_or_default(),
                            thought_signature: part
                                .get("thoughtSignature")
                                .and_then(|value| value.as_str())
                                .map(std::string::ToString::to_string),
                            rest: Map::default(),
                        };

                        let arguments_json = Value::Object(tool_call.arguments.clone()).to_string();
                        output
                            .content
                            .push(AssistantContent::ToolCall(tool_call.clone()));
                        let index = (output.content.len() - 1) as u64;
                        writer.push(AssistantMessageEvent::ToolcallStart {
                            content_index: index,
                            partial: output.clone(),
                        });
                        writer.push(AssistantMessageEvent::ToolcallDelta {
                            content_index: index,
                            delta: arguments_json,
                            partial: output.clone(),
                        });
                        writer.push(AssistantMessageEvent::ToolcallEnd {
                            content_index: index,
                            tool_call,
                            partial: output.clone(),
                        });
                    }
                }
            }

            if let Some(finish_reason) = candidate
                .get("finishReason")
                .and_then(|value| value.as_str())
            {
                output.stop_reason = map_google_stop_reason(finish_reason)?;
                let has_tool_call = output
                    .content
                    .iter()
                    .any(|block| matches!(block, AssistantContent::ToolCall(_)));
                if has_tool_call {
                    output.stop_reason = StopReason::ToolUse;
                }
                if output.stop_reason == StopReason::Error {
                    output.stop_reason_raw = Some(finish_reason.to_string());
                }
            }
        }

        if let Some(usage_metadata) = chunk.get("usageMetadata") {
            let get = |field: &str| {
                usage_metadata
                    .get(field)
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0)
            };
            let prompt_tokens = get("promptTokenCount");
            let cached_tokens = get("cachedContentTokenCount");
            output.usage = Usage {
                input: prompt_tokens.saturating_sub(cached_tokens),
                output: get("candidatesTokenCount") + get("thoughtsTokenCount"),
                cache_read: cached_tokens,
                cache_write: 0,
                total_tokens: get("totalTokenCount"),
                cost: UsageCost::default(),
            };
            calculate_cost(model, &mut output.usage, None);
        }

        Ok(())
    }

    /// Close any remaining open block at end of stream.
    pub fn finish(&mut self, output: &AssistantMessage, writer: &AssistantMessageEventWriter) {
        self.close_current_block(output, writer);
    }
}

impl Default for GoogleStreamState {
    fn default() -> Self {
        Self::new()
    }
}
