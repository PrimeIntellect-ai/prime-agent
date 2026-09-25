//! Anthropic Messages streaming core: SSE iteration, event handling, and the
//! provider stream function. Section of the port of
//! `packages/ai/src/providers/anthropic.ts`.

use serde_json::{json, Value};

use crate::cache_pricing::{
    get_anthropic_cache_write_cost, has_standard_anthropic_cache_pricing,
    AnthropicCacheCreationUsage,
};
use crate::env_api_keys::get_env_api_key;
use crate::event_stream::AssistantMessageEventStream;
use crate::event_stream::{
    create_assistant_message_event_stream, AssistantMessageEvent, AssistantMessageEventWriter,
};
use crate::models::{calculate_cost, CostOverrides};
use crate::providers::anthropic::convert::map_stop_reason;
use crate::providers::anthropic::params::build_params;
use crate::providers::anthropic::{
    build_request_headers, from_claude_code_name, get_cache_control,
    should_use_fine_grained_tool_streaming_beta, AnthropicOptions,
};
use crate::types::{
    done_reason, error_reason, AssistantContent, AssistantMessage, Context, Model, StopReason,
    TextContent, ThinkingContent, ToolCall, Usage,
};
use crate::utils_inner::diagnostics::now_ms;
use crate::utils_inner::http::{send, HttpResponse, RequestOptions};
use crate::utils_inner::json_parse::{parse_json_with_repair, parse_streaming_json};
use crate::utils_inner::sse::{ServerSentEvent, SseDecoder};
use crate::utils_inner::stream_failure::{
    classify_stream_failure, format_stream_failure_message, record_stream_failure,
    stream_failure_from_stop_reason, stream_failure_message, truncate_raw_payload, ProviderError,
    StreamFailureError, StreamFailureInfo, StreamFailureKind,
};

const ANTHROPIC_MESSAGE_EVENTS: [&str; 6] = [
    "message_start",
    "message_delta",
    "message_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
];

/// Turn an in-stream `error` SSE event into a classified failure.
fn anthropic_sse_error(data: &str, request_id: Option<&str>) -> StreamFailureError {
    let mut error_type: Option<String> = None;
    let mut detail: Option<String> = None;
    let mut request_id = request_id.map(std::string::ToString::to_string);
    match parse_json_with_repair(data) {
        Ok(parsed) => {
            if let Some(error) = parsed.get("error") {
                error_type = error
                    .get("type")
                    .and_then(|value| value.as_str())
                    .map(std::string::ToString::to_string);
                detail = error
                    .get("message")
                    .and_then(|value| value.as_str())
                    .map(std::string::ToString::to_string);
            }
            if let Some(id) = parsed.get("request_id").and_then(|value| value.as_str()) {
                request_id = Some(id.to_string());
            }
        }
        Err(_) => {
            detail = Some(data.to_string());
        }
    }
    let info = StreamFailureInfo {
        kind: classify_stream_failure(error_type.as_deref(), None),
        provider_error_type: error_type,
        status: None,
        request_id,
        retry_after_ms: None,
        raw: Some(truncate_raw_payload(data)),
    };
    let message = stream_failure_message(&info, detail.as_deref());
    StreamFailureError { message, info }
}

/// Marker error for an unhandled Anthropic stop reason.
struct StopReasonError(String);

/// Streaming block with its wire index.
struct IndexedBlocks {
    blocks: Vec<AssistantContent>,
    indices: Vec<u64>,
    partial_json: Vec<String>,
}

impl IndexedBlocks {
    fn new() -> Self {
        Self {
            blocks: Vec::new(),
            indices: Vec::new(),
            partial_json: Vec::new(),
        }
    }

    fn position(&self, index: u64) -> Option<usize> {
        self.indices.iter().position(|existing| *existing == index)
    }
}

/// Port of `streamAnthropic`.
pub fn stream_anthropic(
    model: &Model,
    context: &Context,
    options: Option<&AnthropicOptions>,
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
            timestamp: now_ms(),
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
                output.error_message = Some(format_stream_failure_message(&error));
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
    options: Option<&AnthropicOptions>,
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

    let interleaved_thinking = options
        .and_then(|options| options.interleaved_thinking)
        .unwrap_or(true);
    let use_fine_grained = should_use_fine_grained_tool_streaming_beta(model, context);
    let (headers, is_oauth) = build_request_headers(
        model,
        &api_key,
        interleaved_thinking,
        use_fine_grained,
        base_options.headers.as_ref(),
        base_options.session_id.as_deref(),
    );

    let (_retention, cache_control) = get_cache_control(model, base_options.cache_retention);
    let uses_anthropic_cache_pricing = has_standard_anthropic_cache_pricing(model);
    let mut cache_write_cost: Option<f64> = match (&cache_control, uses_anthropic_cache_pricing) {
        (Some(cache_control), true) => Some(get_anthropic_cache_write_cost(
            model.cost.input.as_f64(),
            cache_control.duration(),
            None,
        )),
        _ => None,
    };

    let mut params = build_params(model, context, is_oauth, options, cache_control.as_ref());
    if let Some(on_payload) = &base_options.on_payload {
        if let Some(next) = on_payload(params.clone(), model) {
            params = next;
        }
    }

    let url = format!("{}/v1/messages", model.base_url.trim_end_matches('/'));
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
    let request_id = response
        .headers
        .get("request-id")
        .or_else(|| response.headers.get("x-request-id"))
        .cloned();

    if response.status >= 400 {
        let body = response.read_all_text().await.unwrap_or_default();
        return Err(ProviderError::from_http_status_body(
            response.status,
            &body,
            response.headers.clone(),
        ));
    }

    writer.push(AssistantMessageEvent::Start {
        partial: output.clone(),
    });

    let mut blocks = IndexedBlocks::new();
    let mut decoder = SseDecoder::new();
    let mut saw_message_start = false;
    let mut saw_message_end = false;

    macro_rules! handle_event {
        ($event:expr) => {{
            let event: Value = $event;
            (|| {
                match event
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                {
                    "message_start" => {
                        saw_message_start = true;
                        if let Some(message) = event.get("message") {
                            if let Some(id) = message.get("id").and_then(|value| value.as_str()) {
                                output.response_id = Some(id.to_string());
                            }
                            let get = |field: &str| {
                                message
                                    .get(field)
                                    .and_then(|value| value.as_u64())
                                    .unwrap_or(0)
                            };
                            output.usage.input = get("input_tokens");
                            output.usage.output = get("output_tokens");
                            output.usage.cache_read = get("cache_read_input_tokens");
                            output.usage.cache_write = get("cache_creation_input_tokens");
                            output.usage.total_tokens =
                                crate::types::usage_total_tokens(&output.usage);
                            if cache_control.is_some() && uses_anthropic_cache_pricing {
                                let creation = message
                                    .get("cache_creation")
                                    .and_then(|value| value.as_object())
                                    .map(|map| AnthropicCacheCreationUsage {
                                        ephemeral_5m_input_tokens: map
                                            .get("ephemeral_5m_input_tokens")
                                            .and_then(|v| v.as_u64())
                                            .unwrap_or(0),
                                        ephemeral_1h_input_tokens: map
                                            .get("ephemeral_1h_input_tokens")
                                            .and_then(|v| v.as_u64())
                                            .unwrap_or(0),
                                    });
                                cache_write_cost = Some(get_anthropic_cache_write_cost(
                                    model.cost.input.as_f64(),
                                    cache_control.as_ref().expect("checked").duration(),
                                    creation.as_ref(),
                                ));
                            }
                            recalculate_cost(model, output, cache_write_cost);
                        }
                    }
                    "content_block_start" => {
                        let index = event
                            .get("index")
                            .and_then(|value| value.as_u64())
                            .unwrap_or(0);
                        let content_block =
                            event.get("content_block").cloned().unwrap_or(Value::Null);
                        match content_block
                            .get("type")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                        {
                            "text" => {
                                blocks.blocks.push(AssistantContent::Text(TextContent {
                                    text: String::new(),
                                    text_signature: None,
                                    rest: Default::default(),
                                }));
                                blocks.indices.push(index);
                                blocks.partial_json.push(String::new());
                                sync_blocks(output, &blocks);
                                writer.push(AssistantMessageEvent::TextStart {
                                    content_index: (blocks.blocks.len() - 1) as u64,
                                    partial: output.clone(),
                                });
                            }
                            "thinking" => {
                                blocks
                                    .blocks
                                    .push(AssistantContent::Thinking(ThinkingContent {
                                        thinking: String::new(),
                                        thinking_signature: Some(String::new()),
                                        redacted: None,
                                        rest: Default::default(),
                                    }));
                                blocks.indices.push(index);
                                blocks.partial_json.push(String::new());
                                sync_blocks(output, &blocks);
                                writer.push(AssistantMessageEvent::ThinkingStart {
                                    content_index: (blocks.blocks.len() - 1) as u64,
                                    partial: output.clone(),
                                });
                            }
                            "redacted_thinking" => {
                                blocks
                                    .blocks
                                    .push(AssistantContent::Thinking(ThinkingContent {
                                        thinking: "[Reasoning redacted]".to_string(),
                                        thinking_signature: Some(
                                            content_block
                                                .get("data")
                                                .and_then(|value| value.as_str())
                                                .unwrap_or_default()
                                                .to_string(),
                                        ),
                                        redacted: Some(true),
                                        rest: Default::default(),
                                    }));
                                blocks.indices.push(index);
                                blocks.partial_json.push(String::new());
                                sync_blocks(output, &blocks);
                                writer.push(AssistantMessageEvent::ThinkingStart {
                                    content_index: (blocks.blocks.len() - 1) as u64,
                                    partial: output.clone(),
                                });
                            }
                            "tool_use" => {
                                blocks.blocks.push(AssistantContent::ToolCall(ToolCall {
                                    id: content_block
                                        .get("id")
                                        .and_then(|value| value.as_str())
                                        .unwrap_or_default()
                                        .to_string(),
                                    name: if is_oauth {
                                        from_claude_code_name(
                                            content_block
                                                .get("name")
                                                .and_then(|value| value.as_str())
                                                .unwrap_or_default(),
                                            context.tools.as_deref(),
                                        )
                                    } else {
                                        content_block
                                            .get("name")
                                            .and_then(|value| value.as_str())
                                            .unwrap_or_default()
                                            .to_string()
                                    },
                                    arguments: content_block
                                        .get("input")
                                        .and_then(|value| value.as_object())
                                        .cloned()
                                        .unwrap_or_default(),
                                    thought_signature: None,
                                    rest: Default::default(),
                                }));
                                blocks.indices.push(index);
                                blocks.partial_json.push(String::new());
                                sync_blocks(output, &blocks);
                                writer.push(AssistantMessageEvent::ToolcallStart {
                                    content_index: (blocks.blocks.len() - 1) as u64,
                                    partial: output.clone(),
                                });
                            }
                            _ => {}
                        }
                    }
                    "content_block_delta" => {
                        let index = event
                            .get("index")
                            .and_then(|value| value.as_u64())
                            .unwrap_or(0);
                        let delta = event.get("delta").cloned().unwrap_or(Value::Null);
                        let delta_type = delta
                            .get("type")
                            .and_then(|value| value.as_str())
                            .unwrap_or("");
                        if let Some(position) = blocks.position(index) {
                            match delta_type {
                                "text_delta" => {
                                    let text = delta
                                        .get("text")
                                        .and_then(|value| value.as_str())
                                        .unwrap_or("");
                                    if let Some(AssistantContent::Text(block)) =
                                        blocks.blocks.get_mut(position)
                                    {
                                        block.text.push_str(text);
                                    }
                                    sync_blocks(output, &blocks);
                                    writer.push(AssistantMessageEvent::TextDelta {
                                        content_index: position as u64,
                                        delta: text.to_string(),
                                        partial: output.clone(),
                                    });
                                }
                                "thinking_delta" => {
                                    let thinking = delta
                                        .get("thinking")
                                        .and_then(|value| value.as_str())
                                        .unwrap_or("");
                                    if let Some(AssistantContent::Thinking(block)) =
                                        blocks.blocks.get_mut(position)
                                    {
                                        block.thinking.push_str(thinking);
                                    }
                                    sync_blocks(output, &blocks);
                                    writer.push(AssistantMessageEvent::ThinkingDelta {
                                        content_index: position as u64,
                                        delta: thinking.to_string(),
                                        partial: output.clone(),
                                    });
                                }
                                "input_json_delta" => {
                                    let partial_json = delta
                                        .get("partial_json")
                                        .and_then(|value| value.as_str())
                                        .unwrap_or("");
                                    if let Some(scratch) = blocks.partial_json.get_mut(position) {
                                        scratch.push_str(partial_json);
                                    }
                                    let parsed = blocks
                                        .partial_json
                                        .get(position)
                                        .map(|partial| parse_streaming_json(Some(partial)))
                                        .unwrap_or_else(|| json!({}));
                                    if let Some(AssistantContent::ToolCall(tool_call)) =
                                        blocks.blocks.get_mut(position)
                                    {
                                        tool_call.arguments =
                                            parsed.as_object().cloned().unwrap_or_default();
                                    }
                                    sync_blocks(output, &blocks);
                                    writer.push(AssistantMessageEvent::ToolcallDelta {
                                        content_index: position as u64,
                                        delta: partial_json.to_string(),
                                        partial: output.clone(),
                                    });
                                }
                                "signature_delta" => {
                                    let signature = delta
                                        .get("signature")
                                        .and_then(|value| value.as_str())
                                        .unwrap_or("");
                                    if let Some(AssistantContent::Thinking(block)) =
                                        blocks.blocks.get_mut(position)
                                    {
                                        let existing = block
                                            .thinking_signature
                                            .get_or_insert_with(String::new);
                                        existing.push_str(signature);
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    "content_block_stop" => {
                        let index = event
                            .get("index")
                            .and_then(|value| value.as_u64())
                            .unwrap_or(0);
                        if let Some(position) = blocks.position(index) {
                            match &blocks.blocks[position] {
                                AssistantContent::Text(text) => {
                                    writer.push(AssistantMessageEvent::TextEnd {
                                        content_index: position as u64,
                                        content: text.text.clone(),
                                        partial: output.clone(),
                                    })
                                }
                                AssistantContent::Thinking(thinking) => {
                                    writer.push(AssistantMessageEvent::ThinkingEnd {
                                        content_index: position as u64,
                                        content: thinking.thinking.clone(),
                                        partial: output.clone(),
                                    })
                                }
                                AssistantContent::ToolCall(_) => {
                                    let parsed = blocks
                                        .partial_json
                                        .get(position)
                                        .map(|partial| parse_streaming_json(Some(partial)))
                                        .unwrap_or_else(|| json!({}));
                                    if let Some(AssistantContent::ToolCall(tool_call)) =
                                        blocks.blocks.get_mut(position)
                                    {
                                        tool_call.arguments =
                                            parsed.as_object().cloned().unwrap_or_default();
                                    }
                                    sync_blocks(output, &blocks);
                                    let tool_call = match &blocks.blocks[position] {
                                        AssistantContent::ToolCall(tool_call) => tool_call.clone(),
                                        _ => unreachable!("position points at a tool call"),
                                    };
                                    writer.push(AssistantMessageEvent::ToolcallEnd {
                                        content_index: position as u64,
                                        tool_call,
                                        partial: output.clone(),
                                    });
                                }
                            }
                        }
                    }
                    "message_delta" => {
                        if let Some(delta) = event.get("delta") {
                            if let Some(stop_reason) =
                                delta.get("stop_reason").and_then(|value| value.as_str())
                            {
                                match map_stop_reason(stop_reason) {
                                    Ok(mapped) => {
                                        output.stop_reason = mapped;
                                        if mapped == StopReason::Error {
                                            output.stop_reason_raw = Some(stop_reason.to_string());
                                        }
                                    }
                                    Err(message) => return Err(StopReasonError(message)),
                                }
                            }
                        }
                        if let Some(usage) = event.get("usage") {
                            let get =
                                |field: &str| usage.get(field).and_then(|value| value.as_u64());
                            if let Some(input) = get("input_tokens") {
                                output.usage.input = input;
                            }
                            if let Some(out) = get("output_tokens") {
                                output.usage.output = out;
                            }
                            if let Some(cache_read) = get("cache_read_input_tokens") {
                                output.usage.cache_read = cache_read;
                            }
                            if let Some(cache_write) = get("cache_creation_input_tokens") {
                                output.usage.cache_write = cache_write;
                            }
                            if cache_control.is_some() && uses_anthropic_cache_pricing {
                                if let Some(creation) = usage
                                    .get("cache_creation")
                                    .and_then(|value| value.as_object())
                                {
                                    let creation = AnthropicCacheCreationUsage {
                                        ephemeral_5m_input_tokens: creation
                                            .get("ephemeral_5m_input_tokens")
                                            .and_then(|v| v.as_u64())
                                            .unwrap_or(0),
                                        ephemeral_1h_input_tokens: creation
                                            .get("ephemeral_1h_input_tokens")
                                            .and_then(|v| v.as_u64())
                                            .unwrap_or(0),
                                    };
                                    cache_write_cost = Some(get_anthropic_cache_write_cost(
                                        model.cost.input.as_f64(),
                                        cache_control.as_ref().expect("checked").duration(),
                                        Some(&creation),
                                    ));
                                }
                            }
                            output.usage.total_tokens =
                                crate::types::usage_total_tokens(&output.usage);
                            recalculate_cost(model, output, cache_write_cost);
                        }
                    }
                    "message_stop" => {
                        saw_message_end = true;
                    }
                    _ => {}
                }
                Ok::<(), StopReasonError>(())
            })()
        }};
    }

    loop {
        let chunk = match response.next_text().await? {
            Some(chunk) => chunk,
            None => break,
        };
        for sse in decoder.push_text(&chunk) {
            handle_sse(&sse, request_id.as_deref(), |event| {
                handle_event!(event).map_err(|error| error.0)
            })?;
        }
    }
    for sse in decoder.finish() {
        handle_sse(&sse, request_id.as_deref(), |event| {
            handle_event!(event).map_err(|error| error.0)
        })?;
    }
    if saw_message_start && !saw_message_end {
        return Err(ProviderError::StreamFailure(StreamFailureError {
            message: "Anthropic stream ended before message_stop".to_string(),
            info: StreamFailureInfo {
                kind: StreamFailureKind::MalformedResponse,
                request_id,
                ..StreamFailureInfo::unknown()
            },
        }));
    }

    sync_blocks(output, &blocks);

    if base_options
        .signal
        .as_ref()
        .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
    {
        return Err(ProviderError::Aborted);
    }
    if matches!(output.stop_reason, StopReason::Aborted | StopReason::Error) {
        return Err(ProviderError::StreamFailure(
            stream_failure_from_stop_reason(
                output.stop_reason_raw.as_deref(),
                request_id.as_deref(),
            ),
        ));
    }
    if output.stop_reason == StopReason::Length {
        // "length" is a successful stop.
    }

    Ok(())
}

fn sync_blocks(output: &mut AssistantMessage, blocks: &IndexedBlocks) {
    output.content.clone_from(&blocks.blocks);
}

fn recalculate_cost(model: &Model, output: &mut AssistantMessage, cache_write_cost: Option<f64>) {
    let overrides = cache_write_cost.map(|cache_write| CostOverrides {
        cache_write: Some(cache_write),
    });
    calculate_cost(model, &mut output.usage, overrides.as_ref());
}

/// Handle one SSE event: error events become classified failures; message
/// events are parsed and forwarded.
fn handle_sse<E>(
    sse: &ServerSentEvent,
    request_id: Option<&str>,
    mut on_event: E,
) -> Result<(), ProviderError>
where
    E: FnMut(Value) -> Result<(), String>,
{
    if sse.event.as_deref() == Some("error") {
        return Err(ProviderError::StreamFailure(anthropic_sse_error(
            &sse.data, request_id,
        )));
    }
    if !ANTHROPIC_MESSAGE_EVENTS.contains(&sse.event.as_deref().unwrap_or("")) {
        return Ok(());
    }
    let event = match parse_json_with_repair(&sse.data) {
        Ok(event) => event,
        Err(error) => {
            return Err(ProviderError::StreamFailure(StreamFailureError {
                message: format!(
                    "Could not parse Anthropic SSE event {}: {error}; data={}; raw={}",
                    sse.event.as_deref().unwrap_or_default(),
                    sse.data,
                    sse.raw.join("\\n")
                ),
                info: StreamFailureInfo {
                    kind: StreamFailureKind::MalformedResponse,
                    request_id: request_id.map(std::string::ToString::to_string),
                    raw: Some(truncate_raw_payload(&sse.data)),
                    ..StreamFailureInfo::unknown()
                },
            }));
        }
    };
    on_event(event).map_err(ProviderError::Message)?;
    Ok(())
}
