//! OpenAI Responses stream event processor.
//!
//! Port of `processResponsesStream` from
//! `packages/ai/src/providers/openai-responses-shared.ts`: output-item slots,
//! reasoning summary/text deltas, refusal deltas, function-call argument
//! accumulation, xai encrypted-reasoning merge, and usage accounting. Hook
//! types and service-tier pricing live in
//! [`super::openai_responses_hooks`].
//!
//! Size note: `handle_event` is intentionally kept as one large function. It
//! is a 1:1 port of the single `processResponsesStream` event match in
//! `openai-responses-shared.ts`, and splitting its arms would break
//! traceability to the TS source.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::event_stream::{AssistantMessageEvent, AssistantMessageEventWriter};
use crate::models::calculate_cost;
pub use crate::providers::openai_responses_hooks::{
    apply_service_tier_pricing, ResponsesStreamHooks,
};
use crate::providers::openai_responses_shared::encode_text_signature_v1;
use crate::types::{
    AssistantContent, AssistantMessage, Model, StopReason, TextContent, TextSignaturePhase,
    ThinkingContent, ToolCall, Usage,
};
use crate::utils_inner::json_parse::parse_streaming_json;
use crate::utils_inner::stream_failure::{
    classify_stream_failure, ProviderError, StreamFailureError, StreamFailureInfo,
    StreamFailureKind,
};

/// Streaming slot state for one output item.
struct Slot {
    /// The provider's item object (reasoning/message), kept for replay.
    item: Value,
    /// Scratch for tool-call argument accumulation.
    partial_json: String,
    /// Assistant content index for this slot.
    content_index: usize,
}

/// Incremental Responses stream event processor (port of `processResponsesStream`).
pub struct ResponsesStreamProcessor<'a> {
    model: &'a Model,
    output: &'a mut AssistantMessage,
    writer: &'a AssistantMessageEventWriter,
    hooks: ResponsesStreamHooks,
    slots: HashMap<u64, Slot>,
    current_output_index: Option<u64>,
    saw_terminal_response: bool,
}

impl<'a> ResponsesStreamProcessor<'a> {
    pub fn new(
        model: &'a Model,
        output: &'a mut AssistantMessage,
        writer: &'a AssistantMessageEventWriter,
        hooks: ResponsesStreamHooks,
    ) -> Self {
        Self {
            model,
            output,
            writer,
            hooks,
            slots: HashMap::new(),
            current_output_index: None,
            saw_terminal_response: false,
        }
    }

    fn block_kind(&self, content_index: usize) -> Option<&'static str> {
        match self.output.content.get(content_index)? {
            AssistantContent::Text(_) => Some("text"),
            AssistantContent::Thinking(_) => Some("thinking"),
            AssistantContent::ToolCall(_) => Some("toolCall"),
        }
    }

    fn current_slot(&mut self, output_index: Option<u64>) -> Option<&mut Slot> {
        match output_index.or(self.current_output_index) {
            Some(index) => self.slots.get_mut(&index),
            None => None,
        }
    }

    /// Process one parsed stream event. Errors mirror the TS thrown
    /// `StreamFailureError`s.
    pub fn handle_event(&mut self, event: &Value) -> Result<(), ProviderError> {
        let event_type = event
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let output_index = event
            .get("output_index")
            .and_then(serde_json::Value::as_u64);
        if event.get("output_index").is_some() {
            self.current_output_index = output_index;
        }

        match event_type {
            "response.created" => {
                if let Some(id) = event
                    .get("response")
                    .and_then(|response| response.get("id"))
                    .and_then(|value| value.as_str())
                {
                    self.output.response_id = Some(id.to_string());
                }
            }
            "response.output_item.added" => {
                let content_index = self.output.content.len();
                let item = event.get("item").cloned().unwrap_or(Value::Null);
                let item_type = item
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                match item_type {
                    "reasoning" => {
                        self.output
                            .content
                            .push(AssistantContent::Thinking(ThinkingContent {
                                thinking: String::new(),
                                thinking_signature: None,
                                redacted: None,
                                rest: Default::default(),
                            }));
                        self.writer.push(AssistantMessageEvent::ThinkingStart {
                            content_index: content_index as u64,
                            partial: self.output.clone(),
                        });
                        if let Some(index) = output_index {
                            self.slots.insert(
                                index,
                                Slot {
                                    item,
                                    partial_json: String::new(),
                                    content_index,
                                },
                            );
                        }
                    }
                    "message" => {
                        self.output
                            .content
                            .push(AssistantContent::Text(TextContent {
                                text: String::new(),
                                text_signature: None,
                                rest: Default::default(),
                            }));
                        self.writer.push(AssistantMessageEvent::TextStart {
                            content_index: content_index as u64,
                            partial: self.output.clone(),
                        });
                        if let Some(index) = output_index {
                            self.slots.insert(
                                index,
                                Slot {
                                    item,
                                    partial_json: String::new(),
                                    content_index,
                                },
                            );
                        }
                    }
                    "function_call" => {
                        let call_id = item
                            .get("call_id")
                            .and_then(|value| value.as_str())
                            .unwrap_or("");
                        let item_id = item
                            .get("id")
                            .and_then(|value| value.as_str())
                            .unwrap_or("");
                        let name = item
                            .get("name")
                            .and_then(|value| value.as_str())
                            .unwrap_or("");
                        let initial_arguments = item
                            .get("arguments")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .to_string();
                        self.output
                            .content
                            .push(AssistantContent::ToolCall(ToolCall {
                                id: format!("{call_id}|{item_id}"),
                                name: name.to_string(),
                                arguments: Default::default(),
                                thought_signature: None,
                                rest: Default::default(),
                            }));
                        self.writer.push(AssistantMessageEvent::ToolcallStart {
                            content_index: content_index as u64,
                            partial: self.output.clone(),
                        });
                        if let Some(index) = output_index {
                            self.slots.insert(
                                index,
                                Slot {
                                    item,
                                    partial_json: initial_arguments,
                                    content_index,
                                },
                            );
                        }
                    }
                    _ => {}
                }
            }
            "response.reasoning_summary_part.added" => {
                if let Some(slot) = self.current_slot(output_index) {
                    if slot.item.get("type").and_then(|v| v.as_str()) == Some("reasoning") {
                        let summary = slot
                            .item
                            .as_object_mut()
                            .expect("item is an object")
                            .entry("summary".to_string())
                            .or_insert_with(|| json!([]));
                        if let Some(array) = summary.as_array_mut() {
                            array.push(event.get("part").cloned().unwrap_or(Value::Null));
                        }
                    }
                }
            }
            "response.reasoning_summary_text.delta" => {
                let delta = event
                    .get("delta")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let content_index = self
                    .current_slot(output_index)
                    .map(|slot| slot.content_index);
                if let Some(content_index) = content_index {
                    if self.block_kind(content_index) == Some("thinking") {
                        let mut append = false;
                        if let Some(slot) = self.current_slot(output_index) {
                            let last_part = slot
                                .item
                                .get_mut("summary")
                                .and_then(|summary| summary.as_array_mut())
                                .and_then(|parts| parts.last_mut());
                            if let Some(last_part) = last_part {
                                if let Some(text) = last_part
                                    .as_object_mut()
                                    .expect("part is an object")
                                    .get_mut("text")
                                {
                                    if let Some(text) = text.as_str() {
                                        let joined = format!("{text}{delta}");
                                        *last_part
                                            .as_object_mut()
                                            .expect("part is an object")
                                            .get_mut("text")
                                            .expect("text exists") = json!(joined);
                                        append = true;
                                    }
                                }
                            }
                        }
                        if append {
                            if let Some(AssistantContent::Thinking(block)) =
                                self.output.content.get_mut(content_index)
                            {
                                block.thinking.push_str(delta);
                            }
                            self.writer.push(AssistantMessageEvent::ThinkingDelta {
                                content_index: content_index as u64,
                                delta: delta.to_string(),
                                partial: self.output.clone(),
                            });
                        }
                    }
                }
            }
            "response.reasoning_summary_part.done" => {
                let content_index = self
                    .current_slot(output_index)
                    .map(|slot| slot.content_index);
                if let Some(content_index) = content_index {
                    if self.block_kind(content_index) == Some("thinking") {
                        if let Some(slot) = self.current_slot(output_index) {
                            let summary = slot
                                .item
                                .as_object_mut()
                                .expect("item is an object")
                                .entry("summary".to_string())
                                .or_insert_with(|| json!([]));
                            if let Some(array) = summary.as_array_mut() {
                                if let Some(last_part) = array.last_mut() {
                                    if let Some(text) = last_part.get_mut("text") {
                                        if let Some(text) = text.as_str() {
                                            let joined = format!("{text}\n\n");
                                            *last_part.get_mut("text").expect("text exists") =
                                                json!(joined);
                                        }
                                    }
                                }
                            }
                        }
                        if let Some(AssistantContent::Thinking(block)) =
                            self.output.content.get_mut(content_index)
                        {
                            block.thinking.push_str("\n\n");
                        }
                        self.writer.push(AssistantMessageEvent::ThinkingDelta {
                            content_index: content_index as u64,
                            delta: "\n\n".to_string(),
                            partial: self.output.clone(),
                        });
                    }
                }
            }
            "response.reasoning_text.delta" => {
                let delta = event
                    .get("delta")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let content_index = self
                    .current_slot(output_index)
                    .map(|slot| slot.content_index);
                if let Some(content_index) = content_index {
                    if self.block_kind(content_index) == Some("thinking") {
                        if let Some(AssistantContent::Thinking(block)) =
                            self.output.content.get_mut(content_index)
                        {
                            block.thinking.push_str(delta);
                        }
                        self.writer.push(AssistantMessageEvent::ThinkingDelta {
                            content_index: content_index as u64,
                            delta: delta.to_string(),
                            partial: self.output.clone(),
                        });
                    }
                }
            }
            "response.content_part.added" => {
                if let Some(slot) = self.current_slot(output_index) {
                    if slot.item.get("type").and_then(|value| value.as_str()) == Some("message") {
                        let part_type = event
                            .get("part")
                            .and_then(|part| part.get("type"))
                            .and_then(|value| value.as_str())
                            .unwrap_or("");
                        if part_type == "output_text" || part_type == "refusal" {
                            let content = slot
                                .item
                                .as_object_mut()
                                .expect("item is an object")
                                .entry("content".to_string())
                                .or_insert_with(|| json!([]));
                            if let Some(array) = content.as_array_mut() {
                                array.push(event.get("part").cloned().unwrap_or(Value::Null));
                            }
                        }
                    }
                }
            }
            "response.output_text.delta" => {
                let delta = event
                    .get("delta")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let content_index = self
                    .current_slot(output_index)
                    .map(|slot| slot.content_index);
                if let Some(content_index) = content_index {
                    if self.block_kind(content_index) == Some("text") {
                        let mut append = false;
                        if let Some(slot) = self.current_slot(output_index) {
                            let last_part = slot
                                .item
                                .get_mut("content")
                                .and_then(|content| content.as_array_mut())
                                .and_then(|parts| parts.last_mut());
                            if let Some(last_part) = last_part {
                                if last_part.get("type").and_then(|value| value.as_str())
                                    == Some("output_text")
                                {
                                    if let Some(text) =
                                        last_part.get_mut("text").and_then(|value| value.as_str())
                                    {
                                        let joined = format!("{text}{delta}");
                                        *last_part.get_mut("text").expect("text exists") =
                                            json!(joined);
                                        append = true;
                                    }
                                }
                            }
                        }
                        if append {
                            if let Some(AssistantContent::Text(block)) =
                                self.output.content.get_mut(content_index)
                            {
                                block.text.push_str(delta);
                            }
                            self.writer.push(AssistantMessageEvent::TextDelta {
                                content_index: content_index as u64,
                                delta: delta.to_string(),
                                partial: self.output.clone(),
                            });
                        }
                    }
                }
            }
            "response.refusal.delta" => {
                let delta = event
                    .get("delta")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let content_index = self
                    .current_slot(output_index)
                    .map(|slot| slot.content_index);
                if let Some(content_index) = content_index {
                    if self.block_kind(content_index) == Some("text") {
                        let mut append = false;
                        if let Some(slot) = self.current_slot(output_index) {
                            let last_part = slot
                                .item
                                .get_mut("content")
                                .and_then(|content| content.as_array_mut())
                                .and_then(|parts| parts.last_mut());
                            if let Some(last_part) = last_part {
                                if last_part.get("type").and_then(|value| value.as_str())
                                    == Some("refusal")
                                {
                                    if let Some(refusal) = last_part
                                        .get_mut("refusal")
                                        .and_then(|value| value.as_str())
                                    {
                                        let joined = format!("{refusal}{delta}");
                                        *last_part.get_mut("refusal").expect("refusal exists") =
                                            json!(joined);
                                        append = true;
                                    }
                                }
                            }
                        }
                        if append {
                            if let Some(AssistantContent::Text(block)) =
                                self.output.content.get_mut(content_index)
                            {
                                block.text.push_str(delta);
                            }
                            self.writer.push(AssistantMessageEvent::TextDelta {
                                content_index: content_index as u64,
                                delta: delta.to_string(),
                                partial: self.output.clone(),
                            });
                        }
                    }
                }
            }
            "response.function_call_arguments.delta" => {
                let delta = event
                    .get("delta")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let content_index = self
                    .current_slot(output_index)
                    .map(|slot| slot.content_index);
                if let Some(content_index) = content_index {
                    if self.block_kind(content_index) == Some("toolCall") {
                        let mut parsed = Value::Null;
                        if let Some(slot) = self.current_slot(output_index) {
                            slot.partial_json.push_str(delta);
                            parsed = parse_streaming_json(Some(&slot.partial_json));
                        }
                        if let Some(AssistantContent::ToolCall(tool_call)) =
                            self.output.content.get_mut(content_index)
                        {
                            tool_call.arguments = parsed.as_object().cloned().unwrap_or_default();
                        }
                        self.writer.push(AssistantMessageEvent::ToolcallDelta {
                            content_index: content_index as u64,
                            delta: delta.to_string(),
                            partial: self.output.clone(),
                        });
                    }
                }
            }
            "response.function_call_arguments.done" => {
                let arguments = event
                    .get("arguments")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let content_index = self
                    .current_slot(output_index)
                    .map(|slot| slot.content_index);
                if let Some(content_index) = content_index {
                    if self.block_kind(content_index) == Some("toolCall") {
                        let (previous_partial, parsed) = match self.current_slot(output_index) {
                            Some(slot) => {
                                let previous = slot.partial_json.clone();
                                slot.partial_json = arguments.to_string();
                                (previous, parse_streaming_json(Some(&slot.partial_json)))
                            }
                            None => (String::new(), parse_streaming_json(Some(arguments))),
                        };
                        if let Some(AssistantContent::ToolCall(tool_call)) =
                            self.output.content.get_mut(content_index)
                        {
                            tool_call.arguments = parsed.as_object().cloned().unwrap_or_default();
                        }
                        if let Some(delta) = arguments.strip_prefix(&previous_partial) {
                            if !delta.is_empty() {
                                self.writer.push(AssistantMessageEvent::ToolcallDelta {
                                    content_index: content_index as u64,
                                    delta: delta.to_string(),
                                    partial: self.output.clone(),
                                });
                            }
                        }
                    }
                }
            }
            "response.output_item.done" => {
                if let Some(index) = output_index {
                    self.slots.remove(&index);
                }
                let item = event.get("item").cloned().unwrap_or(Value::Null);
                let item_type = item
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let content_index = self
                    .current_slot(output_index)
                    .map(|slot| slot.content_index);
                match item_type {
                    "reasoning" => {
                        if let Some(content_index) = content_index {
                            if self.block_kind(content_index) == Some("thinking") {
                                let summary_text = item
                                    .get("summary")
                                    .and_then(|summary| summary.as_array())
                                    .map(|parts| {
                                        parts
                                            .iter()
                                            .filter_map(|part| {
                                                part.get("text").and_then(|t| t.as_str())
                                            })
                                            .collect::<Vec<_>>()
                                            .join("\n\n")
                                    })
                                    .unwrap_or_default();
                                let content_text = item
                                    .get("content")
                                    .and_then(|content| content.as_array())
                                    .map(|parts| {
                                        parts
                                            .iter()
                                            .filter_map(|part| {
                                                part.get("text").and_then(|t| t.as_str())
                                            })
                                            .collect::<Vec<_>>()
                                            .join("\n\n")
                                    })
                                    .unwrap_or_default();
                                let final_text = if !summary_text.is_empty() {
                                    summary_text
                                } else if !content_text.is_empty() {
                                    content_text
                                } else {
                                    match self.output.content.get(content_index) {
                                        Some(AssistantContent::Thinking(block)) => {
                                            block.thinking.clone()
                                        }
                                        _ => String::new(),
                                    }
                                };
                                if let Some(AssistantContent::Thinking(block)) =
                                    self.output.content.get_mut(content_index)
                                {
                                    block.thinking.clone_from(&final_text);
                                    block.thinking_signature = Some(item.to_string());
                                }
                                self.writer.push(AssistantMessageEvent::ThinkingEnd {
                                    content_index: content_index as u64,
                                    content: final_text,
                                    partial: self.output.clone(),
                                });
                            }
                        }
                    }
                    "message" => {
                        if let Some(content_index) = content_index {
                            if self.block_kind(content_index) == Some("text") {
                                let text = item
                                    .get("content")
                                    .and_then(|content| content.as_array())
                                    .map(|parts| {
                                        parts
                                            .iter()
                                            .map(|part| {
                                                match part
                                                    .get("type")
                                                    .and_then(|value| value.as_str())
                                                {
                                                    Some("output_text") => part
                                                        .get("text")
                                                        .and_then(|value| value.as_str())
                                                        .unwrap_or(""),
                                                    _ => part
                                                        .get("refusal")
                                                        .and_then(|value| value.as_str())
                                                        .unwrap_or(""),
                                                }
                                            })
                                            .collect::<String>()
                                    })
                                    .unwrap_or_default();
                                let signature = encode_text_signature_v1(
                                    item.get("id")
                                        .and_then(|value| value.as_str())
                                        .unwrap_or_default(),
                                    item.get("phase").and_then(|value| value.as_str()).and_then(
                                        |phase| match phase {
                                            "commentary" => Some(TextSignaturePhase::Commentary),
                                            "final_answer" => Some(TextSignaturePhase::FinalAnswer),
                                            _ => None,
                                        },
                                    ),
                                );
                                if let Some(AssistantContent::Text(block)) =
                                    self.output.content.get_mut(content_index)
                                {
                                    block.text.clone_from(&text);
                                    block.text_signature = Some(signature);
                                }
                                self.writer.push(AssistantMessageEvent::TextEnd {
                                    content_index: content_index as u64,
                                    content: text,
                                    partial: self.output.clone(),
                                });
                            }
                        }
                    }
                    "function_call" => {
                        let content_index = content_index.or_else(|| {
                            output_index
                                .and_then(|index| self.slots.get(&index))
                                .map(|slot| slot.content_index)
                        });
                        if let Some(content_index) = content_index {
                            if self.block_kind(content_index) == Some("toolCall") {
                                let slot_json =
                                    match self.slots.get(&output_index.unwrap_or_default()) {
                                        Some(slot) => slot.partial_json.clone(),
                                        None => String::new(),
                                    };
                                let arguments_text = item
                                    .get("arguments")
                                    .and_then(|value| value.as_str())
                                    .filter(|text| !text.is_empty())
                                    .unwrap_or(&slot_json);
                                let arguments = if arguments_text.is_empty() {
                                    json!({})
                                } else {
                                    parse_streaming_json(Some(arguments_text))
                                };
                                let call_id = item
                                    .get("call_id")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("");
                                let item_id = item
                                    .get("id")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("");
                                let tool_call = ToolCall {
                                    id: format!("{call_id}|{item_id}"),
                                    name: item
                                        .get("name")
                                        .and_then(|value| value.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                    arguments: arguments.as_object().cloned().unwrap_or_default(),
                                    thought_signature: None,
                                    rest: Default::default(),
                                };
                                if let Some(AssistantContent::ToolCall(block)) =
                                    self.output.content.get_mut(content_index)
                                {
                                    *block = tool_call.clone();
                                }
                                self.writer.push(AssistantMessageEvent::ToolcallEnd {
                                    content_index: content_index as u64,
                                    tool_call,
                                    partial: self.output.clone(),
                                });
                            } else {
                                // No live block: emit a synthesized tool call.
                                let arguments_text = item
                                    .get("arguments")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("{}");
                                let arguments = parse_streaming_json(Some(arguments_text))
                                    .as_object()
                                    .cloned()
                                    .unwrap_or_default();
                                let call_id = item
                                    .get("call_id")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("");
                                let item_id = item
                                    .get("id")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("");
                                self.output
                                    .content
                                    .push(AssistantContent::ToolCall(ToolCall {
                                        id: format!("{call_id}|{item_id}"),
                                        name: item
                                            .get("name")
                                            .and_then(|value| value.as_str())
                                            .unwrap_or("")
                                            .to_string(),
                                        arguments,
                                        thought_signature: None,
                                        rest: Default::default(),
                                    }));
                                let content_index = self.output.content.len() - 1;
                                let tool_call = match self.output.content.last() {
                                    Some(AssistantContent::ToolCall(tool_call)) => {
                                        tool_call.clone()
                                    }
                                    _ => unreachable!("just pushed a tool call"),
                                };
                                self.writer.push(AssistantMessageEvent::ToolcallEnd {
                                    content_index: content_index as u64,
                                    tool_call,
                                    partial: self.output.clone(),
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
            "response.completed" | "response.incomplete" => {
                self.saw_terminal_response = true;
                let response = event.get("response").cloned().unwrap_or(Value::Null);
                if self.model.provider == "xai" {
                    if let Some(output_items) =
                        response.get("output").and_then(|value| value.as_array())
                    {
                        for item in output_items {
                            if item.get("type").and_then(|value| value.as_str())
                                != Some("reasoning")
                            {
                                continue;
                            }
                            let encrypted = item.get("encrypted_content");
                            if encrypted.is_none() || encrypted == Some(&Value::Null) {
                                continue;
                            }
                            let item_id = item
                                .get("id")
                                .and_then(|value| value.as_str())
                                .unwrap_or("");
                            for block in self.output.content.iter_mut() {
                                let AssistantContent::Thinking(thinking) = block else {
                                    continue;
                                };
                                let Some(signature) = &thinking.thinking_signature else {
                                    continue;
                                };
                                let Ok(mut stored) = serde_json::from_str::<Value>(signature)
                                else {
                                    continue;
                                };
                                if stored.get("id").and_then(|value| value.as_str())
                                    == Some(item_id)
                                    && stored.get("encrypted_content").is_none()
                                {
                                    if let Some(object) = stored.as_object_mut() {
                                        object.insert(
                                            "encrypted_content".into(),
                                            encrypted.cloned().unwrap_or(Value::Null),
                                        );
                                    }
                                    thinking.thinking_signature = Some(stored.to_string());
                                }
                            }
                        }
                    }
                }
                if let Some(id) = response.get("id").and_then(|value| value.as_str()) {
                    self.output.response_id = Some(id.to_string());
                }
                if let Some(usage) = response.get("usage") {
                    let cached_tokens = usage
                        .get("input_tokens_details")
                        .and_then(|details| details.get("cached_tokens"))
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0);
                    let input_tokens = usage
                        .get("input_tokens")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0);
                    // OpenAI includes cached tokens in input_tokens; subtract them.
                    self.output.usage = Usage {
                        input: input_tokens.saturating_sub(cached_tokens),
                        output: usage
                            .get("output_tokens")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0),
                        cache_read: cached_tokens,
                        cache_write: 0,
                        total_tokens: usage
                            .get("total_tokens")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0),
                        cost: Default::default(),
                    };
                }
                calculate_cost(self.model, &mut self.output.usage, None);
                if let Some(apply) = &self.hooks.apply_service_tier_pricing {
                    let response_tier = response
                        .get("service_tier")
                        .and_then(|value| value.as_str())
                        .map(std::string::ToString::to_string);
                    let request_tier = self.hooks.request_service_tier.map(|tier| {
                        serde_json::to_value(tier)
                            .unwrap_or_default()
                            .as_str()
                            .unwrap_or_default()
                            .to_string()
                    });
                    let service_tier = match &self.hooks.resolve_service_tier {
                        Some(resolve) => resolve(response_tier, request_tier),
                        None => response_tier.or(request_tier),
                    };
                    apply(&mut self.output.usage, service_tier);
                }
                let status = response.get("status").and_then(|value| value.as_str());
                self.output.stop_reason = map_responses_stop_reason(status);
                let has_tool_call = self
                    .output
                    .content
                    .iter()
                    .any(|block| matches!(block, AssistantContent::ToolCall(_)));
                if has_tool_call && self.output.stop_reason == StopReason::Stop {
                    self.output.stop_reason = StopReason::ToolUse;
                }
                if self.output.stop_reason == StopReason::Error {
                    if let Some(status) = status {
                        self.output.stop_reason_raw = Some(status.to_string());
                    }
                }
            }
            "error" => {
                let code = event.get("code").and_then(|value| value.as_str());
                let message = event
                    .get("message")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                return Err(ProviderError::StreamFailure(StreamFailureError {
                    message: format!("Error Code {}: {}", code.unwrap_or_default(), message),
                    info: StreamFailureInfo {
                        kind: classify_stream_failure(code, None),
                        provider_error_type: code.map(std::string::ToString::to_string),
                        ..StreamFailureInfo::unknown()
                    },
                }));
            }
            "response.failed" => {
                let response = event.get("response").cloned().unwrap_or(Value::Null);
                let error = response.get("error");
                let details = response.get("incomplete_details");
                let provider_error_type = error
                    .and_then(|error| error.get("code"))
                    .and_then(|value| value.as_str())
                    .or_else(|| {
                        details
                            .and_then(|details| details.get("reason"))
                            .and_then(|value| value.as_str())
                    });
                let msg = if let Some(error) = error {
                    format!(
                        "{}: {}",
                        error
                            .get("code")
                            .and_then(|value| value.as_str())
                            .unwrap_or("unknown"),
                        error
                            .get("message")
                            .and_then(|value| value.as_str())
                            .unwrap_or("no message")
                    )
                } else if let Some(reason) = details
                    .and_then(|details| details.get("reason"))
                    .and_then(|value| value.as_str())
                {
                    format!("incomplete: {reason}")
                } else {
                    "Unknown error (no error details in response)".to_string()
                };
                return Err(ProviderError::StreamFailure(StreamFailureError {
                    message: msg,
                    info: StreamFailureInfo {
                        kind: classify_stream_failure(provider_error_type, None),
                        provider_error_type: provider_error_type
                            .map(std::string::ToString::to_string),
                        ..StreamFailureInfo::unknown()
                    },
                }));
            }
            _ => {}
        }

        Ok(())
    }

    /// Check invariants after the stream ended (port of the trailing checks).
    pub fn finish(&self) -> Result<(), ProviderError> {
        if self.model.provider == "xai" && !self.saw_terminal_response {
            return Err(ProviderError::StreamFailure(StreamFailureError {
                message: "xAI Responses stream ended before a terminal response event".to_string(),
                info: StreamFailureInfo {
                    kind: StreamFailureKind::Unknown,
                    ..StreamFailureInfo::unknown()
                },
            }));
        }
        Ok(())
    }
}

fn map_responses_stop_reason(status: Option<&str>) -> StopReason {
    match status {
        None | Some("completed") | Some("in_progress") | Some("queued") => StopReason::Stop,
        Some("incomplete") => StopReason::Length,
        Some("failed") | Some("cancelled") => StopReason::Error,
        Some(_) => StopReason::Error,
    }
}
