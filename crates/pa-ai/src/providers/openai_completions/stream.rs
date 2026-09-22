//! OpenAI Completions streaming core.
//! Section of the port of `packages/ai/src/providers/openai-completions.ts`:
//! chunk-driven block state (text/thinking/toolcalls/reasoning_details), SSE
//! decoding, and the provider stream function.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::cache_pricing::{get_anthropic_cache_write_cost, has_standard_anthropic_cache_pricing};
use crate::env_api_keys::get_env_api_key;
use crate::event_stream::{
    create_assistant_message_event_stream, AssistantMessageEvent, AssistantMessageEventStream,
    AssistantMessageEventWriter,
};
use crate::providers::openai_completions::convert::{map_stop_reason, parse_chunk_usage};
use crate::providers::openai_completions::errors::{openai_http_error, openrouter_raw_metadata};
use crate::providers::openai_completions::get_compat_cache_control;
use crate::providers::openai_completions::params::{build_headers, build_params};
use crate::providers::openai_completions::{
    encode_reasoning_details, get_compat, resolve_cache_retention, OpenAICompletionsOptions,
    REASONING_FIELDS,
};
use crate::types::{
    done_reason, error_reason, AssistantContent, AssistantMessage, CacheRetention, Context, Model,
    StopReason, TextContent, ThinkingContent, ToolCall, Usage,
};
use crate::utils_inner::http::{send, HttpResponse, RequestOptions};
use crate::utils_inner::json_parse::{parse_json_with_repair, parse_streaming_json};
use crate::utils_inner::sse::{ServerSentEvent, SseDecoder};
use crate::utils_inner::stream_failure::{record_stream_failure, ProviderError};

struct StreamingState {
    output: AssistantMessage,
    blocks: Vec<AssistantContent>,
    text_block: Option<usize>,
    thinking_block: Option<usize>,
    tool_call_blocks_by_index: HashMap<u64, usize>,
    tool_call_blocks_by_id: HashMap<String, usize>,
    tool_call_partial_args: HashMap<usize, String>,
    reasoning_details_by_index: Vec<(u64, Value)>,
    next_reasoning_details_index: u64,
    reasoning_details_block: Option<usize>,
}

impl StreamingState {
    fn new(output: AssistantMessage) -> Self {
        Self {
            output,
            blocks: Vec::new(),
            text_block: None,
            thinking_block: None,
            tool_call_blocks_by_index: HashMap::new(),
            tool_call_blocks_by_id: HashMap::new(),
            tool_call_partial_args: HashMap::new(),
            reasoning_details_by_index: Vec::new(),
            next_reasoning_details_index: 0,
            reasoning_details_block: None,
        }
    }

    fn ensure_text_block(&mut self, writer: &AssistantMessageEventWriter) -> usize {
        if let Some(index) = self.text_block {
            return index;
        }
        self.blocks.push(AssistantContent::Text(TextContent {
            text: String::new(),
            text_signature: None,
            rest: Default::default(),
        }));
        let index = self.blocks.len() - 1;
        self.text_block = Some(index);
        self.sync_output();
        writer.push(AssistantMessageEvent::TextStart {
            content_index: index as u64,
            partial: self.output.clone(),
        });
        index
    }

    fn ensure_thinking_block(
        &mut self,
        thinking_signature: &str,
        writer: &AssistantMessageEventWriter,
    ) -> usize {
        if let Some(index) = self.thinking_block {
            return index;
        }
        self.blocks
            .push(AssistantContent::Thinking(ThinkingContent {
                thinking: String::new(),
                thinking_signature: Some(thinking_signature.to_string()),
                redacted: None,
                rest: Default::default(),
            }));
        let index = self.blocks.len() - 1;
        self.thinking_block = Some(index);
        self.sync_output();
        writer.push(AssistantMessageEvent::ThinkingStart {
            content_index: index as u64,
            partial: self.output.clone(),
        });
        index
    }

    fn ensure_tool_call_block(
        &mut self,
        stream_index: Option<u64>,
        id: Option<&str>,
        writer: &AssistantMessageEventWriter,
    ) -> usize {
        let mut block =
            stream_index.and_then(|index| self.tool_call_blocks_by_index.get(&index).copied());
        if block.is_none() {
            if let Some(id) = id {
                block = self.tool_call_blocks_by_id.get(id).copied();
            }
        }
        if let Some(index) = block {
            if let Some(stream_index) = stream_index {
                self.tool_call_blocks_by_index.insert(stream_index, index);
            }
            if let Some(id) = id {
                self.tool_call_blocks_by_id.insert(id.to_string(), index);
            }
            return index;
        }
        self.blocks.push(AssistantContent::ToolCall(ToolCall {
            id: id.unwrap_or("").to_string(),
            name: String::new(),
            arguments: Default::default(),
            thought_signature: None,
            rest: Default::default(),
        }));
        let index = self.blocks.len() - 1;
        if let Some(stream_index) = stream_index {
            self.tool_call_blocks_by_index.insert(stream_index, index);
        }
        if let Some(id) = id {
            self.tool_call_blocks_by_id.insert(id.to_string(), index);
        }
        self.sync_output();
        writer.push(AssistantMessageEvent::ToolcallStart {
            content_index: index as u64,
            partial: self.output.clone(),
        });
        index
    }

    fn sync_output(&mut self) {
        self.output.content = self.blocks.clone();
    }
}

/// Finish all open blocks, emitting `*_end` events (port of `finishBlock`).
fn finish_blocks(state: &mut StreamingState, writer: &AssistantMessageEventWriter) {
    for index in 0..state.blocks.len() {
        match &state.blocks[index] {
            AssistantContent::Text(text) => writer.push(AssistantMessageEvent::TextEnd {
                content_index: index as u64,
                content: text.text.clone(),
                partial: state.output.clone(),
            }),
            AssistantContent::Thinking(thinking) => {
                writer.push(AssistantMessageEvent::ThinkingEnd {
                    content_index: index as u64,
                    content: thinking.thinking.clone(),
                    partial: state.output.clone(),
                })
            }
            AssistantContent::ToolCall(_) => {
                let partial_args = state.tool_call_partial_args.remove(&index);
                let arguments = partial_args
                    .as_deref()
                    .map(|partial| parse_streaming_json(Some(partial)))
                    .unwrap_or_else(|| json!({}));
                let arguments = arguments.as_object().cloned().unwrap_or_default();
                if let AssistantContent::ToolCall(tool_call) = &mut state.blocks[index] {
                    tool_call.arguments = arguments;
                }
                state.sync_output();
                let tool_call = match &state.blocks[index] {
                    AssistantContent::ToolCall(tool_call) => tool_call.clone(),
                    _ => unreachable!("index points at a tool call"),
                };
                writer.push(AssistantMessageEvent::ToolcallEnd {
                    content_index: index as u64,
                    tool_call,
                    partial: state.output.clone(),
                });
            }
        }
    }
}

/// Handle one parsed SSE chunk. Returns the chunk value for testability.
fn handle_chunk(
    chunk: &Value,
    model: &Model,
    cache_write_cost: Option<f64>,
    state: &mut StreamingState,
    writer: &AssistantMessageEventWriter,
) {
    if !chunk.is_object() {
        return;
    }
    if let Some(id) = chunk.get("id").and_then(|value| value.as_str()) {
        if state.output.response_id.is_none() {
            state.output.response_id = Some(id.to_string());
        }
    }
    if let Some(chunk_model) = chunk.get("model").and_then(|value| value.as_str()) {
        if !chunk_model.is_empty()
            && chunk_model != model.id
            && state.output.response_model.is_none()
        {
            state.output.response_model = Some(chunk_model.to_string());
        }
    }
    if let Some(usage) = chunk.get("usage") {
        if usage.is_object() {
            state.output.usage = parse_chunk_usage(usage, model, cache_write_cost);
        }
    }

    let Some(choice) = chunk
        .get("choices")
        .and_then(|choices| choices.as_array())
        .and_then(|choices| choices.first())
    else {
        return;
    };

    // Fallback: some providers (e.g., Moonshot) return usage in choice.usage.
    if !chunk
        .get("usage")
        .map(|usage| usage.is_object())
        .unwrap_or(false)
    {
        if let Some(usage) = choice.get("usage") {
            if usage.is_object() {
                state.output.usage = parse_chunk_usage(usage, model, cache_write_cost);
            }
        }
    }

    if let Some(finish_reason) = choice.get("finish_reason").and_then(|value| value.as_str()) {
        let (stop_reason, error_message) = map_stop_reason(finish_reason);
        state.output.stop_reason = stop_reason;
        if error_message.is_some() {
            state.output.error_message = error_message;
        }
    }

    let Some(delta) = choice.get("delta").and_then(|value| value.as_object()) else {
        return;
    };

    // Text content.
    if let Some(content) = delta.get("content").and_then(|value| value.as_str()) {
        if !content.is_empty() {
            let index = state.ensure_text_block(writer);
            if let Some(AssistantContent::Text(text)) = state.blocks.get_mut(index) {
                text.text.push_str(content);
            }
            state.sync_output();
            writer.push(AssistantMessageEvent::TextDelta {
                content_index: index as u64,
                delta: content.to_string(),
                partial: state.output.clone(),
            });
        }
    }

    // Some endpoints return reasoning in reasoning_content (llama.cpp),
    // or reasoning (other openai compatible endpoints). Use the first
    // non-empty reasoning field to avoid duplication.
    let mut found_reasoning_field: Option<(&str, &str)> = None;
    for field in REASONING_FIELDS {
        if let Some(value) = delta.get(field).and_then(|value| value.as_str()) {
            if !value.is_empty() {
                found_reasoning_field = Some((field, value));
                break;
            }
        }
    }
    if let Some((field, reasoning_delta)) = found_reasoning_field {
        let index = state.ensure_thinking_block(field, writer);
        if let Some(AssistantContent::Thinking(thinking)) = state.blocks.get_mut(index) {
            thinking.thinking.push_str(reasoning_delta);
        }
        state.sync_output();
        writer.push(AssistantMessageEvent::ThinkingDelta {
            content_index: index as u64,
            delta: reasoning_delta.to_string(),
            partial: state.output.clone(),
        });
    }

    // Tool calls.
    if let Some(tool_calls) = delta.get("tool_calls").and_then(|value| value.as_array()) {
        for tool_call in tool_calls {
            let stream_index = tool_call.get("index").and_then(|value| value.as_u64());
            let id = tool_call.get("id").and_then(|value| value.as_str());
            let index = state.ensure_tool_call_block(stream_index, id, writer);
            if let Some(AssistantContent::ToolCall(block)) = state.blocks.get_mut(index) {
                if block.id.is_empty() {
                    if let Some(id) = id {
                        block.id = id.to_string();
                        state.tool_call_blocks_by_id.insert(id.to_string(), index);
                    }
                }
                if block.name.is_empty() {
                    if let Some(name) = tool_call
                        .get("function")
                        .and_then(|function| function.get("name"))
                        .and_then(|value| value.as_str())
                    {
                        block.name = name.to_string();
                    }
                }
            }
            let mut delta_text = String::new();
            if let Some(arguments) = tool_call
                .get("function")
                .and_then(|function| function.get("arguments"))
                .and_then(|value| value.as_str())
            {
                delta_text = arguments.to_string();
                let entry = state.tool_call_partial_args.entry(index).or_default();
                entry.push_str(arguments);
                if let Some(AssistantContent::ToolCall(block)) = state.blocks.get_mut(index) {
                    block.arguments = parse_streaming_json(Some(entry))
                        .as_object()
                        .cloned()
                        .unwrap_or_default();
                }
            }
            state.sync_output();
            writer.push(AssistantMessageEvent::ToolcallDelta {
                content_index: index as u64,
                delta: delta_text,
                partial: state.output.clone(),
            });
        }
    }

    // Structured reasoning details (e.g., encrypted reasoning + tool binding).
    if let Some(reasoning_details) = delta
        .get("reasoning_details")
        .and_then(|value| value.as_array())
    {
        for detail in reasoning_details {
            if !detail.is_object() {
                continue;
            }
            let explicit_index = detail.get("index").and_then(|value| value.as_u64());
            let index = explicit_index.unwrap_or(state.next_reasoning_details_index);
            state.next_reasoning_details_index = state.next_reasoning_details_index.max(index + 1);
            let previous = state
                .reasoning_details_by_index
                .iter()
                .find(|(existing, _)| *existing == index)
                .map(|(_, value)| value.clone());
            let mut merged = previous.clone().unwrap_or_else(|| json!({}));
            if let (Some(previous), Some(merged_object)) = (previous, merged.as_object_mut()) {
                for (key, value) in detail.as_object().expect("detail is an object") {
                    merged_object.insert(key.clone(), value.clone());
                }
                for field in ["text", "summary"] {
                    let previous_fragment = previous.get(field).and_then(|value| value.as_str());
                    let fragment = detail.get(field).and_then(|value| value.as_str());
                    if let (Some(previous_fragment), Some(fragment)) = (previous_fragment, fragment)
                    {
                        merged_object.insert(
                            field.to_string(),
                            json!(format!("{previous_fragment}{fragment}")),
                        );
                    }
                }
            } else {
                merged = detail.clone();
            }
            state
                .reasoning_details_by_index
                .retain(|(existing, _)| *existing != index);
            state
                .reasoning_details_by_index
                .push((index, merged.clone()));

            if detail.get("type").and_then(|value| value.as_str()) == Some("reasoning.encrypted") {
                if let (Some(id), Some(data)) = (
                    detail.get("id").and_then(|value| value.as_str()),
                    detail.get("data").filter(|value| !value.is_null()),
                ) {
                    let _ = data;
                    for block in state.blocks.iter_mut() {
                        if let AssistantContent::ToolCall(tool_call) = block {
                            if tool_call.id == id {
                                tool_call.thought_signature = Some(detail.to_string());
                            }
                        }
                    }
                }
            }
        }
        if !state.reasoning_details_by_index.is_empty() {
            if state.reasoning_details_block.is_none() {
                state
                    .blocks
                    .push(AssistantContent::Thinking(ThinkingContent {
                        thinking: String::new(),
                        thinking_signature: None,
                        redacted: Some(true),
                        rest: Default::default(),
                    }));
                let index = state.blocks.len() - 1;
                state.reasoning_details_block = Some(index);
                state.sync_output();
                writer.push(AssistantMessageEvent::ThinkingStart {
                    content_index: index as u64,
                    partial: state.output.clone(),
                });
            }
            let mut sorted = state.reasoning_details_by_index.clone();
            sorted.sort_by_key(|(index, _)| *index);
            let details: Vec<Value> = sorted.into_iter().map(|(_, detail)| detail).collect();
            if let Some(index) = state.reasoning_details_block {
                if let Some(AssistantContent::Thinking(thinking)) = state.blocks.get_mut(index) {
                    thinking.thinking_signature = Some(encode_reasoning_details(&details));
                }
            }
        }
    }
}

fn error_to_message(error: &ProviderError) -> String {
    let mut message = match error {
        ProviderError::StreamFailure(failure) => failure.message.clone(),
        other => other.to_string(),
    };
    // Some providers via OpenRouter give additional information in this field.
    if let Some(raw_metadata) = openrouter_raw_metadata(error) {
        message.push('\n');
        message.push_str(&raw_metadata);
    }
    message
}

/// Port of `streamOpenAICompletions`.
pub fn stream_openai_completions(
    model: &Model,
    context: &Context,
    options: Option<&OpenAICompletionsOptions>,
) -> AssistantMessageEventStream {
    let options = options.cloned();
    let model = model.clone();
    let context = context.clone();
    let (writer, reader) = create_assistant_message_event_stream();

    tokio::spawn(async move {
        let mut output = AssistantMessage {
            content: Vec::new(),
            api: model.api.clone(),
            provider: model.provider.clone(),
            model: model.id.clone(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: crate::utils_inner::diagnostics::now_ms(),
            rest: Default::default(),
        };

        let result = run_stream(&model, &context, options.as_ref(), &mut output, &writer).await;
        match result {
            Ok(()) => {
                writer.push(AssistantMessageEvent::Done {
                    reason: done_reason(output.stop_reason),
                    message: output,
                });
                writer.end(None);
            }
            Err(error) => {
                output.stop_reason = if error == ProviderError::Aborted {
                    StopReason::Aborted
                } else {
                    StopReason::Error
                };
                output.error_message = Some(error_to_message(&error));
                record_stream_failure(
                    (&model.provider, &model.id, &model.api),
                    &mut output,
                    &error,
                );
                writer.push(AssistantMessageEvent::Error {
                    reason: error_reason(output.stop_reason),
                    error: output.clone(),
                });
                writer.end(Some(output));
            }
        }
    });

    reader
}

async fn run_stream(
    model: &Model,
    context: &Context,
    options: Option<&OpenAICompletionsOptions>,
    output: &mut AssistantMessage,
    writer: &AssistantMessageEventWriter,
) -> Result<(), ProviderError> {
    let base_options = options
        .map(|options| options.base.clone())
        .unwrap_or_default();
    let api_key = base_options
        .api_key
        .clone()
        .or_else(|| get_env_api_key(&model.provider))
        .unwrap_or_default();
    let compat = get_compat(model);
    let cache_retention = resolve_cache_retention(base_options.cache_retention);
    let cache_control = get_compat_cache_control(&compat, cache_retention);
    let cache_write_cost = if cache_control.is_some() && has_standard_anthropic_cache_pricing(model)
    {
        Some(get_anthropic_cache_write_cost(
            model.cost.input.as_f64(),
            if cache_control.as_ref().and_then(|control| control.ttl) == Some("1h") {
                "1h"
            } else {
                "5m"
            },
            None,
        ))
    } else {
        None
    };
    let cache_session_id = if cache_retention == CacheRetention::None {
        None
    } else {
        base_options.session_id.clone()
    };

    let mut params = build_params(
        model,
        context,
        options,
        &compat,
        cache_retention,
        cache_control.as_ref(),
    );
    if let Some(on_payload) = &base_options.on_payload {
        if let Some(next) = on_payload(params.clone(), model) {
            params = next;
        }
    }

    let url = format!("{}/chat/completions", model.base_url.trim_end_matches('/'));
    let headers = build_headers(
        model,
        &api_key,
        base_options.headers.as_ref(),
        cache_session_id.as_deref(),
        &compat,
        base_options.session_id.as_deref(),
    );

    let mut response: HttpResponse = send(RequestOptions {
        method: reqwest::Method::POST,
        url,
        headers,
        body: Some(params.to_string()),
        signal: base_options.signal.clone(),
        timeout_ms: base_options.timeout_ms,
        connection: crate::utils_inner::stream_failure::ConnectionErrorProfile::Sdk,
        transport: crate::utils_inner::http::Transport::Http1,
    })
    .await?;

    if let Some(on_response) = &base_options.on_response {
        on_response(
            crate::types::ProviderResponse {
                status: response.status,
                // Collected into the ordered map: the hook payload can
                // serialize, and the HTTP header arrival order is not a
                // stable serialization order.
                headers: response.headers.clone().into_iter().collect(),
            },
            model,
        );
    }

    // The TS provider goes through the `openai` SDK, which throws on every
    // non-OK status (2xx only) and whose `APIError` message the provider
    // surfaces verbatim as the assistant message's error message.
    if !(200..300).contains(&response.status) {
        let body = response.read_all_text().await.unwrap_or_default();
        return Err(openai_http_error(
            response.status,
            &body,
            response.headers.clone(),
        ));
    }

    writer.push(AssistantMessageEvent::Start {
        partial: output.clone(),
    });

    let mut state = StreamingState::new(output.clone());
    let mut decoder = SseDecoder::new();
    loop {
        let chunk = match response.next_text().await? {
            Some(chunk) => chunk,
            None => break,
        };
        let events = decoder.push_text(&chunk);
        for event in &events {
            if let Some(chunk) = parse_sse_event_data(event) {
                handle_chunk(&chunk, model, cache_write_cost, &mut state, writer);
                output.clone_from(&state.output);
            }
        }
    }
    for event in decoder.finish() {
        if let Some(chunk) = parse_sse_event_data(&event) {
            handle_chunk(&chunk, model, cache_write_cost, &mut state, writer);
        }
    }
    output.clone_from(&state.output);

    finish_blocks(&mut state, writer);
    output.clone_from(&state.output);

    if base_options
        .signal
        .as_ref()
        .map(|signal| signal.is_cancelled())
        .unwrap_or(false)
    {
        return Err(ProviderError::Aborted);
    }
    if output.stop_reason == StopReason::Aborted {
        return Err(ProviderError::Aborted);
    }
    if output.stop_reason == StopReason::Error {
        return Err(ProviderError::Message(
            output
                .error_message
                .clone()
                .unwrap_or_else(|| "Provider returned an error stop reason".to_string()),
        ));
    }

    Ok(())
}

/// Parse the JSON payload of an SSE event; `None` for `[DONE]` and comments.
fn parse_sse_event_data(event: &ServerSentEvent) -> Option<Value> {
    if event.data.trim() == "[DONE]" {
        return None;
    }
    match parse_json_with_repair(&event.data) {
        Ok(value) => Some(value),
        Err(_) => Some(parse_streaming_json(Some(&event.data))),
    }
}
