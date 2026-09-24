//! Mistral Conversations streaming core: the provider stream function, SSE
//! iteration, chunk handling, and stream-state accumulation.
//! Section of the port of `packages/ai/src/providers/mistral.ts`.

use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::env_api_keys::get_env_api_key;
use crate::event_stream::{
    create_assistant_message_event_stream, AssistantMessageEvent, AssistantMessageEventStream,
    AssistantMessageEventWriter,
};
use crate::models::calculate_cost;
use crate::providers::mistral::convert::{
    build_chat_payload, derive_mistral_tool_call_id, MistralToolCallIdNormalizer,
};
use crate::providers::mistral::{build_request_headers, MistralOptions, API_MISTRAL_CONVERSATIONS};
use crate::providers::transform_messages::transform_messages_with_normalizer;
use crate::types::{
    done_reason, error_reason, AssistantContent, AssistantMessage, Context, Model, StopReason,
    TextContent, ThinkingContent, ToolCall, Usage,
};
use crate::utils_inner::diagnostics::now_ms;
use crate::utils_inner::http::{send, HttpResponse, RequestOptions};
use crate::utils_inner::json_parse::{parse_json_with_repair, parse_streaming_json};
use crate::utils_inner::sanitize_unicode::sanitize_surrogates;
use crate::utils_inner::sse::SseDecoder;
use crate::utils_inner::stream_failure::{
    record_stream_failure, stream_failure_from_stop_reason, ProviderError, ProviderHttpError,
};

const MAX_MISTRAL_ERROR_BODY_CHARS: usize = 4000;

/// Port of `streamMistral`.
pub fn stream_mistral(
    model: &Model,
    context: &Context,
    options: Option<&MistralOptions>,
) -> AssistantMessageEventStream {
    let options = options.cloned();
    let model = model.clone();
    let context = context.clone();
    let (writer, reader) = create_assistant_message_event_stream();

    tokio::spawn(async move {
        let mut output = AssistantMessage {
            content: Vec::new(),
            api: API_MISTRAL_CONVERSATIONS.to_string(),
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
                // TS surfaces `formatMistralError(error)`: the SDK's
                // statusCode/body composition, not the classified rewrite.
                output.error_message = Some(error.to_string());
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

/// Coerce a parsed streaming JSON value into an object map (non-object
/// partial parses decode to `{}`, matching `parseStreamingJson<Record<...>>`).
fn json_object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// Port of `mapChatStopReason`.
fn map_chat_stop_reason(reason: Option<&str>) -> StopReason {
    match reason {
        None => StopReason::Stop,
        Some("stop") => StopReason::Stop,
        Some("length") | Some("model_length") => StopReason::Length,
        Some("tool_calls") => StopReason::ToolUse,
        Some("error") => StopReason::Error,
        Some(_) => StopReason::Stop,
    }
}

/// JS `String.prototype.length` semantics (UTF-16 code units) so the
/// truncation limit and the reported remainder match the TS binary
/// byte-for-byte on the body text.
fn truncate_error_text(text: &str, max_chars: usize) -> String {
    let total: usize = text.chars().map(char::len_utf16).sum();
    if total <= max_chars {
        return text.to_string();
    }
    let mut consumed = 0usize;
    let mut end = text.len();
    for (index, char) in text.char_indices() {
        if consumed >= max_chars {
            end = index;
            break;
        }
        consumed += char.len_utf16();
        if consumed > max_chars {
            end = index;
            break;
        }
    }
    format!(
        "{}... [truncated {} chars]",
        &text[..end],
        total - max_chars
    )
}

/// The `@mistralai/mistralai` SDK error class name for HTTP failures
/// (`SDKError`, the fallback class the stream error matcher throws).
const MISTRAL_SDK_ERROR_NAME: &str = "SDKError";

/// The `SDKError` message the mistral SDK composes
/// (`"{prefix}: Status {N}[ Content-Type ...]. |\nBody: {body}"`), used both
/// where TS surfaces it verbatim (empty-body error path) and in diagnostics.
fn mistral_sdk_error_message(status: u16, content_type: Option<&str>, body: &str) -> String {
    let mut message = format!("API error occurred: Status {status}");
    // The SDK reads the raw content-type header; a missing one renders as
    // the literal string `""`.
    let content_type = content_type.unwrap_or(r#""""#);
    if content_type != "application/json" {
        let quoted = if content_type.contains(' ') {
            format!("\"{content_type}\"")
        } else {
            content_type.to_string()
        };
        message.push_str(&format!(" Content-Type {quoted}"));
    }
    let body_utf16_len: usize = body.chars().map(char::len_utf16).sum();
    let body_display = if body_utf16_len > 10_000 {
        // JS `substring(0, 10000)` cuts on UTF-16 code units; walk to the
        // enclosing char boundary and report the remainder in code units.
        let mut consumed = 0usize;
        let mut end = body.len();
        for (index, char) in body.char_indices() {
            if consumed + char.len_utf16() > 10_000 {
                end = index;
                break;
            }
            consumed += char.len_utf16();
        }
        format!(
            "{}...and {} more chars",
            &body[..end],
            body_utf16_len - 10_000
        )
    } else if body.is_empty() {
        // `httpMeta.body || `""``
        r#""""#.to_string()
    } else {
        body.to_string()
    };
    message.push_str(if body_utf16_len > 100 { "\n" } else { ". " });
    message.push_str(&format!("Body: {body_display}"));
    message.trim().to_string()
}

/// Port of the error the mistral SDK throws for a 4XX/5XX response
/// (`SDKError` carrying `statusCode` and the raw body), with the
/// user-facing message pre-composed through `formatMistralError`.
fn mistral_http_error(status: u16, body: &str, headers: &HashMap<String, String>) -> ProviderError {
    let body_text = body.trim();
    let content_type = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
        .map(|(_, value)| value.clone());
    let message = if body_text.is_empty() {
        // TS falls back to the SDK error's own message when the body is empty.
        format!(
            "Mistral API error ({status}): {}",
            mistral_sdk_error_message(status, content_type.as_deref(), body)
        )
    } else {
        format!(
            "Mistral API error ({status}): {}",
            truncate_error_text(body_text, MAX_MISTRAL_ERROR_BODY_CHARS)
        )
    };
    ProviderError::Http(ProviderHttpError {
        message,
        status: Some(status),
        body: Some(body.to_string()),
        headers: headers.clone(),
        request_id: None,
        sdk_name: Some(MISTRAL_SDK_ERROR_NAME.to_string()),
        retry_after_ms: None,
        provider_error_type: None,
    })
}

async fn run_stream(
    model: &Model,
    context: &Context,
    options: Option<&MistralOptions>,
    output: &mut AssistantMessage,
    writer: &AssistantMessageEventWriter,
) -> Result<(), ProviderError> {
    let options = options.cloned().unwrap_or_default();
    let api_key = options
        .base
        .api_key
        .clone()
        .filter(|key| !key.is_empty())
        .or_else(|| get_env_api_key(&model.provider))
        .ok_or_else(|| {
            ProviderError::Message(format!("No API key for provider: {}", model.provider))
        })?;

    if options
        .base
        .signal
        .as_ref()
        .map(tokio_util::sync::CancellationToken::is_cancelled)
        .unwrap_or(false)
    {
        return Err(ProviderError::Aborted);
    }

    let normalizer = MistralToolCallIdNormalizer::default();
    let transformed_messages =
        transform_messages_with_normalizer(&context.messages, model, &|id, _, _| {
            Some(normalizer.normalize(id))
        });

    let mut payload = build_chat_payload(model, context, &transformed_messages, &options);
    if let Some(on_payload) = &options.base.on_payload {
        if let Some(next) = on_payload(payload.clone(), model) {
            payload = next;
        }
    }

    // The mistralai SDK defaults to https://api.mistral.ai and posts to
    // /v1/chat/completions; a model baseUrl replaces the server URL only.
    let base_url = if model.base_url.is_empty() {
        "https://api.mistral.ai".to_string()
    } else {
        model.base_url.trim_end_matches('/').to_string()
    };
    let url = format!("{base_url}/v1/chat/completions");

    let mut headers = build_request_headers(model, &options, &api_key);
    headers.push(("content-type".into(), "application/json".into()));
    headers.push(("accept".into(), "text/event-stream".into()));

    let mut response: HttpResponse = send(RequestOptions {
        method: reqwest::Method::POST,
        url,
        headers,
        body: Some(payload.to_string()),
        signal: options.base.signal.clone(),
        timeout_ms: options.base.timeout_ms,
        connection: crate::utils_inner::stream_failure::ConnectionErrorProfile::MistralSdk,
        transport: crate::utils_inner::http::Transport::Http1,
    })
    .await?;

    if let Some(on_response) = &options.base.on_response {
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

    if response.status >= 400 {
        let body = response.read_all_text().await.unwrap_or_default();
        return Err(mistral_http_error(
            response.status,
            &body,
            &response.headers,
        ));
    }

    writer.push(AssistantMessageEvent::Start {
        partial: output.clone(),
    });

    let mut state = MistralStreamState::new();
    let mut decoder = SseDecoder::new();
    loop {
        let chunk = match response.next_text().await? {
            Some(chunk) => chunk,
            None => break,
        };
        for sse in decoder.push_text(&chunk) {
            if sse.data.trim().is_empty() || sse.data.trim() == "[DONE]" {
                continue;
            }
            let parsed = parse_json_with_repair(&sse.data).map_err(|error| {
                ProviderError::Message(format!("Could not parse Mistral SSE chunk: {error}"))
            })?;
            state.handle_chunk(&parsed, model, output, writer);
        }
    }
    for sse in decoder.finish() {
        if sse.data.trim().is_empty() || sse.data.trim() == "[DONE]" {
            continue;
        }
        let parsed = parse_json_with_repair(&sse.data).map_err(|error| {
            ProviderError::Message(format!("Could not parse Mistral SSE chunk: {error}"))
        })?;
        state.handle_chunk(&parsed, model, output, writer);
    }
    state.finish(output, writer);

    if options
        .base
        .signal
        .as_ref()
        .map(tokio_util::sync::CancellationToken::is_cancelled)
        .unwrap_or(false)
    {
        return Err(ProviderError::Aborted);
    }
    if matches!(output.stop_reason, StopReason::Aborted | StopReason::Error) {
        return Err(ProviderError::StreamFailure(
            stream_failure_from_stop_reason(output.stop_reason_raw.as_deref(), None),
        ));
    }

    Ok(())
}

/// Scratch state for the streaming loop (`consumeChatStream` in the TS).
struct MistralStreamState {
    current_block: Option<CurrentBlock>,
    tool_blocks_by_key: HashMap<String, usize>,
    tool_partial_args: HashMap<usize, String>,
}

enum CurrentBlock {
    Text { index: usize },
    Thinking { index: usize },
}

impl MistralStreamState {
    fn new() -> Self {
        Self {
            current_block: None,
            tool_blocks_by_key: HashMap::new(),
            tool_partial_args: HashMap::new(),
        }
    }

    fn finish_current_block(
        &mut self,
        output: &AssistantMessage,
        writer: &AssistantMessageEventWriter,
    ) {
        match self.current_block.take() {
            Some(CurrentBlock::Text { index }) => {
                let text = match &output.content[index] {
                    AssistantContent::Text(text) => text.text.clone(),
                    _ => String::new(),
                };
                writer.push(AssistantMessageEvent::TextEnd {
                    content_index: index as u64,
                    content: text,
                    partial: output.clone(),
                });
            }
            Some(CurrentBlock::Thinking { index }) => {
                let thinking = match &output.content[index] {
                    AssistantContent::Thinking(thinking) => thinking.thinking.clone(),
                    _ => String::new(),
                };
                writer.push(AssistantMessageEvent::ThinkingEnd {
                    content_index: index as u64,
                    content: thinking,
                    partial: output.clone(),
                });
            }
            None => {}
        }
    }

    fn ensure_text_block(
        &mut self,
        output: &mut AssistantMessage,
        writer: &AssistantMessageEventWriter,
    ) -> usize {
        if let Some(CurrentBlock::Text { index }) = self.current_block {
            return index;
        }
        self.finish_current_block(output, writer);
        output.content.push(AssistantContent::Text(TextContent {
            text: String::new(),
            text_signature: None,
            rest: Default::default(),
        }));
        let index = output.content.len() - 1;
        self.current_block = Some(CurrentBlock::Text { index });
        writer.push(AssistantMessageEvent::TextStart {
            content_index: index as u64,
            partial: output.clone(),
        });
        index
    }

    fn ensure_thinking_block(
        &mut self,
        output: &mut AssistantMessage,
        writer: &AssistantMessageEventWriter,
    ) -> usize {
        if let Some(CurrentBlock::Thinking { index }) = self.current_block {
            return index;
        }
        self.finish_current_block(output, writer);
        output
            .content
            .push(AssistantContent::Thinking(ThinkingContent {
                thinking: String::new(),
                thinking_signature: None,
                redacted: None,
                rest: Default::default(),
            }));
        let index = output.content.len() - 1;
        self.current_block = Some(CurrentBlock::Thinking { index });
        writer.push(AssistantMessageEvent::ThinkingStart {
            content_index: index as u64,
            partial: output.clone(),
        });
        index
    }

    /// Port of the `consumeChatStream` chunk loop body.
    fn handle_chunk(
        &mut self,
        chunk: &Value,
        model: &Model,
        output: &mut AssistantMessage,
        writer: &AssistantMessageEventWriter,
    ) {
        // Keep the first non-empty streamed id as the response identifier.
        if output.response_id.is_none() {
            if let Some(id) = chunk.get("id").and_then(Value::as_str) {
                if !id.is_empty() {
                    output.response_id = Some(id.to_string());
                }
            }
        }

        if let Some(usage) = chunk.get("usage").filter(|usage| usage.is_object()) {
            let input = usage
                .get("prompt_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let completion = usage
                .get("completion_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            output.usage.input = input;
            output.usage.output = completion;
            output.usage.cache_read = 0;
            output.usage.cache_write = 0;
            // TS `totalTokens || input + output`: an explicitly reported zero
            // is falsy, so only a positive reported total is kept. The sum
            // saturates — TS doubles never wrap, and a Rust u64 must not
            // panic (debug) or wrap to a wrong total (release).
            output.usage.total_tokens = usage
                .get("total_tokens")
                .and_then(Value::as_u64)
                .filter(|total| *total > 0)
                .unwrap_or(input.saturating_add(completion));
            calculate_cost(model, &mut output.usage, None);
        }

        let Some(choice) = chunk
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        else {
            return;
        };

        if let Some(finish_reason) = choice.get("finish_reason").and_then(Value::as_str) {
            output.stop_reason = map_chat_stop_reason(Some(finish_reason));
            if output.stop_reason == StopReason::Error {
                output.stop_reason_raw = Some(finish_reason.to_string());
            }
        }

        let delta = choice.get("delta").cloned().unwrap_or(Value::Null);
        if let Some(content) = delta.get("content").filter(|content| !content.is_null()) {
            let items: Vec<Value> = match content {
                Value::String(text) => vec![Value::String(text.clone())],
                Value::Array(items) => items.clone(),
                _ => Vec::new(),
            };
            for item in items {
                match &item {
                    Value::String(text) => {
                        let text_delta = sanitize_surrogates(text);
                        let index = self.ensure_text_block(output, writer);
                        if let AssistantContent::Text(block) = &mut output.content[index] {
                            block.text.push_str(&text_delta);
                        }
                        writer.push(AssistantMessageEvent::TextDelta {
                            content_index: index as u64,
                            delta: text_delta,
                            partial: output.clone(),
                        });
                        continue;
                    }
                    Value::Object(_)
                        if item.get("type").and_then(Value::as_str) == Some("thinking") =>
                    {
                        let delta_text = item
                            .get("thinking")
                            .and_then(Value::as_array)
                            .map(|parts| {
                                parts
                                    .iter()
                                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                                    .collect::<String>()
                            })
                            .unwrap_or_default();
                        let thinking_delta = sanitize_surrogates(&delta_text);
                        if thinking_delta.is_empty() {
                            continue;
                        }
                        let index = self.ensure_thinking_block(output, writer);
                        if let AssistantContent::Thinking(block) = &mut output.content[index] {
                            block.thinking.push_str(&thinking_delta);
                        }
                        writer.push(AssistantMessageEvent::ThinkingDelta {
                            content_index: index as u64,
                            delta: thinking_delta,
                            partial: output.clone(),
                        });
                        continue;
                    }
                    Value::Object(_)
                        if item.get("type").and_then(Value::as_str) == Some("text") =>
                    {
                        let text_delta = sanitize_surrogates(
                            item.get("text").and_then(Value::as_str).unwrap_or(""),
                        );
                        let index = self.ensure_text_block(output, writer);
                        if let AssistantContent::Text(block) = &mut output.content[index] {
                            block.text.push_str(&text_delta);
                        }
                        writer.push(AssistantMessageEvent::TextDelta {
                            content_index: index as u64,
                            delta: text_delta,
                            partial: output.clone(),
                        });
                    }
                    _ => {}
                }
            }
        }

        let tool_calls = delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for tool_call in tool_calls {
            if self.current_block.is_some() {
                self.finish_current_block(output, writer);
            }
            let call_id = match tool_call.get("id").and_then(Value::as_str) {
                Some(id) if !id.is_empty() && id != "null" => id.to_string(),
                _ => derive_mistral_tool_call_id(
                    &format!(
                        "toolcall:{}",
                        tool_call.get("index").and_then(Value::as_i64).unwrap_or(0)
                    ),
                    0,
                ),
            };
            let tool_index = tool_call.get("index").and_then(Value::as_i64).unwrap_or(0);
            let key = format!("{call_id}:{}", tool_index.max(0));

            let existing_index = self.tool_blocks_by_key.get(&key).copied();
            let block_index = match existing_index {
                Some(index)
                    if matches!(
                        output.content.get(index),
                        Some(AssistantContent::ToolCall(_))
                    ) =>
                {
                    index
                }
                _ => {
                    let name = tool_call
                        .pointer("/function/name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    output.content.push(AssistantContent::ToolCall(ToolCall {
                        id: call_id.clone(),
                        name,
                        arguments: Default::default(),
                        thought_signature: None,
                        rest: Default::default(),
                    }));
                    let index = output.content.len() - 1;
                    self.tool_blocks_by_key.insert(key.clone(), index);
                    writer.push(AssistantMessageEvent::ToolcallStart {
                        content_index: index as u64,
                        partial: output.clone(),
                    });
                    index
                }
            };

            let args_delta = match tool_call.pointer("/function/arguments") {
                Some(Value::String(text)) => text.clone(),
                Some(other) => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string()),
                None => "{}".to_string(),
            };
            let partial = self
                .tool_partial_args
                .entry(block_index)
                .or_default()
                .to_string();
            let partial = format!("{partial}{args_delta}");
            self.tool_partial_args.insert(block_index, partial.clone());
            let parsed = parse_streaming_json(Some(&partial));
            if let AssistantContent::ToolCall(block) = &mut output.content[block_index] {
                block.arguments = json_object(parsed);
            }
            writer.push(AssistantMessageEvent::ToolcallDelta {
                content_index: block_index as u64,
                delta: args_delta,
                partial: output.clone(),
            });
        }
    }

    /// Port of the trailing block finalization.
    fn finish(&mut self, output: &mut AssistantMessage, writer: &AssistantMessageEventWriter) {
        self.finish_current_block(output, writer);
        let mut indexes: Vec<usize> = self.tool_blocks_by_key.values().copied().collect();
        indexes.sort_unstable();
        indexes.dedup();
        for index in indexes {
            let Some(AssistantContent::ToolCall(_)) = output.content.get(index) else {
                continue;
            };
            let partial_args = self
                .tool_partial_args
                .get(&index)
                .cloned()
                .unwrap_or_default();
            let parsed = parse_streaming_json(Some(partial_args.as_str()));
            if let AssistantContent::ToolCall(block) = &mut output.content[index] {
                block.arguments = json_object(parsed);
            }
            let block = output.content[index].clone();
            writer.push(AssistantMessageEvent::ToolcallEnd {
                content_index: index as u64,
                tool_call: match block {
                    AssistantContent::ToolCall(call) => call,
                    _ => continue,
                },
                partial: output.clone(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The TS `formatMistralError` shape: "Mistral API error (N): <body>",
    /// truncated at 4000 chars (UTF-16 units) with the JS remainder count.
    #[test]
    fn mistral_http_error_body_shape() {
        let headers = HashMap::new();
        let error = mistral_http_error(400, "{\"message\":\"bad request\"}", &headers);
        assert_eq!(
            error.to_string(),
            "Mistral API error (400): {\"message\":\"bad request\"}"
        );
        // The TS diagnostic records the SDK error class name and status.
        let info = crate::utils_inner::stream_failure::extract_stream_failure_info(&error);
        assert_eq!(info.status, Some(400));
        assert_eq!(
            info.provider_error_type.as_deref(),
            Some(MISTRAL_SDK_ERROR_NAME)
        );
        assert_eq!(
            info.kind,
            crate::utils_inner::stream_failure::StreamFailureKind::InvalidRequest
        );
    }

    /// An empty error body falls back to the SDK's own composed message, per
    /// `formatMistralError`'s statusCode-without-body branch.
    #[test]
    fn mistral_http_error_empty_body_falls_back_to_sdk_message() {
        let mut headers = HashMap::new();
        headers.insert("content-type".to_string(), "application/json".to_string());
        let error = mistral_http_error(400, "", &headers);
        assert_eq!(
            error.to_string(),
            "Mistral API error (400): API error occurred: Status 400. Body: \"\""
        );

        let mut headers = HashMap::new();
        headers.insert(
            "content-type".to_string(),
            "text/html; charset=utf-8".to_string(),
        );
        let error = mistral_http_error(500, "", &headers);
        assert_eq!(
            error.to_string(),
            "Mistral API error (500): API error occurred: Status 500 Content-Type \"text/html; charset=utf-8\". Body: \"\""
        );
    }

    /// Bodies longer than 4000 chars truncate with the JS-char count.
    #[test]
    fn mistral_error_body_truncation() {
        let error = mistral_http_error(400, &"x".repeat(4100), &HashMap::new());
        assert_eq!(
            error.to_string(),
            format!(
                "Mistral API error (400): {}... [truncated 100 chars]",
                "x".repeat(4000)
            )
        );
    }

    /// Connection-level failures carry the mistral SDK's wrapper shape: the
    /// `UnexpectedClientError` fixed prefix over the runtime's refused-connect
    /// text, and the `RequestTimeoutError` fixed prefix with the raw cause.
    #[test]
    fn mistral_connection_error_texts() {
        let connect = ProviderError::Connection(
            crate::utils_inner::stream_failure::ProviderConnectionError {
                kind: crate::utils_inner::stream_failure::ConnectionErrorKind::Connect,
                profile: crate::utils_inner::stream_failure::ConnectionErrorProfile::MistralSdk,
                cause: "tcp connect error: Connection refused".to_string(),
            },
        );
        assert_eq!(
            connect.to_string(),
            "Unexpected HTTP client error: TypeError: Unable to connect. Is the computer able to access the url?"
        );
        let timeout = ProviderError::Connection(
            crate::utils_inner::stream_failure::ProviderConnectionError {
                kind: crate::utils_inner::stream_failure::ConnectionErrorKind::Timeout,
                profile: crate::utils_inner::stream_failure::ConnectionErrorProfile::MistralSdk,
                cause: "request exceeded the 30000ms timeout".to_string(),
            },
        );
        assert_eq!(
            timeout.to_string(),
            "Request timed out: request exceeded the 30000ms timeout"
        );
    }

    #[test]
    fn maps_chat_stop_reasons() {
        assert_eq!(map_chat_stop_reason(None), StopReason::Stop);
        assert_eq!(map_chat_stop_reason(Some("stop")), StopReason::Stop);
        assert_eq!(map_chat_stop_reason(Some("length")), StopReason::Length);
        assert_eq!(
            map_chat_stop_reason(Some("model_length")),
            StopReason::Length
        );
        assert_eq!(
            map_chat_stop_reason(Some("tool_calls")),
            StopReason::ToolUse
        );
        assert_eq!(map_chat_stop_reason(Some("error")), StopReason::Error);
        assert_eq!(map_chat_stop_reason(Some("whatever")), StopReason::Stop);
    }

    /// TS `mistral.ts` assigns `usage.totalTokens = chunk.usage.totalTokens ||
    /// input + output`, so an explicitly reported zero total is falsy and
    /// falls back to the prompt/completion sum; a positive reported total is
    /// kept verbatim.
    #[test]
    fn usage_total_tokens_explicit_zero_falls_back_to_sum() {
        use serde_json::json;

        let model = Model {
            id: "mistral-large-latest".into(),
            name: "mistral-large".into(),
            api: API_MISTRAL_CONVERSATIONS.to_string(),
            provider: "mistral".into(),
            base_url: "https://api.mistral.ai".into(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![crate::types::ModelInput::Text],
            cost: crate::types::zero_model_cost(),
            context_window: 128_000,
            max_tokens: 8192,
            featured: None,
            headers: None,
            compat: None,
        };
        let (writer, _stream) = create_assistant_message_event_stream();
        let mut state = MistralStreamState::new();
        let mut output = crate::event_stream::initial_assistant_message(
            API_MISTRAL_CONVERSATIONS,
            "mistral",
            &model.id,
        );

        state.handle_chunk(
            &json!({
                "id": "usage-1",
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 0},
            }),
            &model,
            &mut output,
            &writer,
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

        state.handle_chunk(
            &json!({
                "id": "usage-2",
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 99},
            }),
            &model,
            &mut output,
            &writer,
        );
        assert_eq!(output.usage.total_tokens, 99);

        state.handle_chunk(
            &json!({
                "id": "usage-3",
                "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            }),
            &model,
            &mut output,
            &writer,
        );
        assert_eq!(output.usage.total_tokens, 15);
    }
}
