//! Proxy stream function, porting `packages/agent/src/proxy.ts`.
//!
//! Streams through a proxy server (`POST {proxyUrl}/api/stream`) instead of
//! calling LLM providers directly. The server strips the `partial` field from
//! delta events to reduce bandwidth; the partial message is reconstructed
//! client-side from the proxy events (TS `processProxyEvent`).
//!
//! Wire events are SSE lines starting with `data: ` (TS reference protocol).
//! Failures - HTTP error status, transport error, abort - are encoded as a
//! terminal `error` event carrying the partial message with `stopReason`
//! "aborted" or "error", exactly like the TS implementation.

use std::collections::HashMap;
use std::fmt::Write;

use futures::StreamExt;
use serde::Deserialize;

use crate::abort::AbortSignal;
use crate::stream::{
    event_stream, AssistantMessageEvent, AssistantMessageEventStreamHandle, LlmContext,
    StreamRequestOptions,
};
use crate::types::{
    AssistantContent, AssistantMessage, Model, StopReason, TextContent, ThinkingContent, ToolCall,
    Usage,
};

/// Serializable proxy event (TS `ProxyAssistantMessageEvent`). The server
/// strips `partial`; field names match the wire protocol.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProxyAssistantMessageEvent {
    Start,
    TextStart {
        #[serde(rename = "contentIndex")]
        content_index: usize,
    },
    TextDelta {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        delta: String,
    },
    TextEnd {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        content_signature: Option<String>,
    },
    ThinkingStart {
        #[serde(rename = "contentIndex")]
        content_index: usize,
    },
    ThinkingDelta {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        delta: String,
    },
    ThinkingEnd {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        content_signature: Option<String>,
    },
    ToolcallStart {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
    },
    ToolcallDelta {
        #[serde(rename = "contentIndex")]
        content_index: usize,
        delta: String,
    },
    ToolcallEnd {
        #[serde(rename = "contentIndex")]
        content_index: usize,
    },
    Done {
        reason: ProxyDoneReason,
        usage: Usage,
    },
    Error {
        reason: ProxyErrorReason,
        #[serde(rename = "errorMessage")]
        error_message: Option<String>,
        usage: Usage,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub enum ProxyDoneReason {
    #[serde(rename = "stop")]
    Stop,
    #[serde(rename = "length")]
    Length,
    #[serde(rename = "toolUse")]
    ToolUse,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub enum ProxyErrorReason {
    #[serde(rename = "aborted")]
    Aborted,
    #[serde(rename = "error")]
    Error,
}

/// Options for [`stream_proxy`].
pub struct ProxyStreamOptions {
    pub auth_token: String,
    pub proxy_url: String,
    pub signal: AbortSignal,
}

/// State for reconstructing the partial message (TS keeps `partialJson` on the
/// tool-call content; here it lives in a side map because the domain type has
/// no partial-JSON field).
struct ProxyReconstruction {
    partial: AssistantMessage,
    partial_json: HashMap<usize, StreamingJsonAccumulator>,
}

fn empty_usage() -> Usage {
    Usage::zero()
}

/// Port of `streamProxy`: returns a producer/consumer event stream pair.
///
/// The consumer side implements [`crate::stream::ModelStream`]; use it as the
/// `streamFn` for an agent that goes through the proxy.
pub fn stream_proxy(
    model: Model,
    context: LlmContext,
    options: StreamRequestOptions,
    proxy_options: ProxyStreamOptions,
) -> (
    AssistantMessageEventStreamHandle,
    crate::stream::AssistantMessageEventStream,
) {
    let (handle, stream) = event_stream();
    let task_handle = handle.clone();
    let signal = proxy_options.signal.clone();

    tokio::spawn(async move {
        let mut reconstruction = ProxyReconstruction {
            partial: AssistantMessage {
                content: Vec::new(),
                api: model.api.clone(),
                provider: model.provider.clone(),
                model: model.id.clone(),
                response_model: None,
                response_id: None,
                diagnostics: None,
                usage: empty_usage(),
                stop_reason: StopReason::Stop,
                stop_reason_raw: None,
                error_message: None,
                timestamp: crate::now_ms(),
            },
            partial_json: HashMap::new(),
        };

        let result = proxy_run(
            &proxy_options,
            &options,
            model,
            context,
            &mut reconstruction,
            &task_handle,
            &signal,
        )
        .await;

        // TS catch block: encode the failure as a terminal error event. The
        // catch settles partial tool calls first (TS PR #2783).
        match result {
            Ok(()) => {
                if signal.is_aborted() {
                    settle_partial_tool_calls(&mut reconstruction);
                    reconstruction.partial.stop_reason = StopReason::Aborted;
                    reconstruction.partial.error_message =
                        Some("Request aborted by user".to_string());
                    task_handle.push(AssistantMessageEvent::Error {
                        reason: StopReason::Aborted,
                        error: reconstruction.partial.clone(),
                    });
                }
                task_handle.end(None);
            }
            Err(error_message) => {
                let reason = if signal.is_aborted() {
                    StopReason::Aborted
                } else {
                    StopReason::Error
                };
                settle_partial_tool_calls(&mut reconstruction);
                reconstruction.partial.stop_reason = reason;
                reconstruction.partial.error_message = Some(error_message);
                task_handle.push(AssistantMessageEvent::Error {
                    reason,
                    error: reconstruction.partial.clone(),
                });
                task_handle.end(None);
            }
        }
    });

    (handle, stream)
}

/// Request body options subset (TS `buildProxyRequestOptions` keeps the
/// serializable `SimpleStreamOptions` fields).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyRequestOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u64>,
    reasoning: ThinkingLevelWire,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum ThinkingLevelWire {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

async fn proxy_run(
    proxy_options: &ProxyStreamOptions,
    options: &StreamRequestOptions,
    model: Model,
    context: LlmContext,
    reconstruction: &mut ProxyReconstruction,
    handle: &AssistantMessageEventStreamHandle,
    signal: &AbortSignal,
) -> Result<(), String> {
    let request_options = ProxyRequestOptions {
        temperature: options.temperature,
        max_tokens: options.max_tokens,
        reasoning: match options.reasoning {
            crate::types::ThinkingLevel::Off => ThinkingLevelWire::Off,
            crate::types::ThinkingLevel::Minimal => ThinkingLevelWire::Minimal,
            crate::types::ThinkingLevel::Low => ThinkingLevelWire::Low,
            crate::types::ThinkingLevel::Medium => ThinkingLevelWire::Medium,
            crate::types::ThinkingLevel::High => ThinkingLevelWire::High,
            crate::types::ThinkingLevel::Xhigh => ThinkingLevelWire::Xhigh,
            crate::types::ThinkingLevel::Max => ThinkingLevelWire::Max,
        },
        session_id: options.session_id.clone(),
    };
    let body = serde_json::json!({
        "model": model,
        "context": context,
        "options": request_options,
    });

    let client = reqwest::Client::new();
    let send = async {
        client
            .post(format!("{}/api/stream", proxy_options.proxy_url))
            .header(
                "Authorization",
                format!("Bearer {}", proxy_options.auth_token),
            )
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
    };

    let response = match run_aborting(send, signal).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(format!("{error}")),
        Err(()) => return Err("Request aborted by user".to_string()),
    };

    if !response.status().is_success() {
        let status = response.status();
        let mut error_message = format!(
            "Proxy error: {} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        );
        if let Ok(payload) = response.json::<serde_json::Value>().await {
            if let Some(error) = payload.get("error").and_then(|v| v.as_str()) {
                error_message = format!("Proxy error: {error}");
            }
        }
        return Err(error_message);
    }

    let mut byte_buffer: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();
    loop {
        let chunk = async { stream.next().await };
        let chunk = match run_aborting(chunk, signal).await {
            Err(()) => return Err("Request aborted by user".to_string()),
            Ok(None) => break,
            Ok(Some(Err(error))) => return Err(format!("{error}")),
            Ok(Some(Ok(bytes))) => bytes,
        };

        byte_buffer.extend_from_slice(&chunk);
        // Split on newline; keep the trailing partial line in the buffer.
        while let Some(position) = byte_buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = byte_buffer.drain(..=position).collect();
            let line = String::from_utf8_lossy(&line[..line.len() - 1]).to_string();
            if let Some(data) = line.strip_prefix("data: ") {
                let data = data.trim();
                if !data.is_empty() {
                    let Ok(proxy_event) = serde_json::from_str::<ProxyAssistantMessageEvent>(data)
                    else {
                        return Err(format!("Invalid proxy event: {data}"));
                    };
                    match process_proxy_event(proxy_event, reconstruction) {
                        Ok(Some(event)) => handle.push(event),
                        Ok(None) => {}
                        Err(message) => return Err(message),
                    }
                }
            }
        }
    }

    if signal.is_aborted() {
        return Err("Request aborted by user".to_string());
    }

    // Clean EOF without a terminal event: end the stream (TS `stream.end()`).
    Ok(())
}

/// Race a future against the abort signal; `Err(())` means aborted.
async fn run_aborting<T>(
    future: impl std::future::Future<Output = T>,
    signal: &AbortSignal,
) -> Result<T, ()> {
    tokio::select! {
        value = future => Ok(value),
        () = signal.aborted() => Err(()),
    }
}

/// Port of `processProxyEvent`: mutate the reconstructed partial message and
/// return the full assistant event to push. `Err` mirrors the TS `throw`s for
/// mismatched content types.
fn process_proxy_event(
    proxy_event: ProxyAssistantMessageEvent,
    state: &mut ProxyReconstruction,
) -> Result<Option<AssistantMessageEvent>, String> {
    fn ensure_content(partial: &mut AssistantMessage, index: usize) -> Result<usize, String> {
        if partial.content.len() < index + 1 {
            partial.content.resize(
                index + 1,
                AssistantContent::Text(TextContent {
                    text: String::new(),
                    text_signature: None,
                }),
            );
        }
        Ok(index)
    }
    let partial = &mut state.partial;

    match proxy_event {
        ProxyAssistantMessageEvent::Start => Ok(Some(AssistantMessageEvent::Start {
            partial: partial.clone(),
        })),
        ProxyAssistantMessageEvent::TextStart { content_index } => {
            ensure_content(partial, content_index)?;
            partial.content[content_index] = AssistantContent::Text(TextContent {
                text: String::new(),
                text_signature: None,
            });
            Ok(Some(AssistantMessageEvent::TextStart {
                content_index,
                partial: partial.clone(),
            }))
        }
        ProxyAssistantMessageEvent::TextDelta {
            content_index,
            delta,
        } => match partial.content.get_mut(content_index) {
            Some(AssistantContent::Text(text)) => {
                text.text.push_str(&delta);
                Ok(Some(AssistantMessageEvent::TextDelta {
                    content_index,
                    delta,
                    partial: partial.clone(),
                }))
            }
            _ => Err("Received text_delta for non-text content".to_string()),
        },
        ProxyAssistantMessageEvent::TextEnd {
            content_index,
            content_signature,
        } => match partial.content.get_mut(content_index) {
            Some(AssistantContent::Text(text)) => {
                text.text_signature = content_signature;
                let content = text.text.clone();
                Ok(Some(AssistantMessageEvent::TextEnd {
                    content_index,
                    content,
                    partial: partial.clone(),
                }))
            }
            _ => Err("Received text_end for non-text content".to_string()),
        },
        ProxyAssistantMessageEvent::ThinkingStart { content_index } => {
            ensure_content(partial, content_index)?;
            partial.content[content_index] = AssistantContent::Thinking(ThinkingContent {
                thinking: String::new(),
                thinking_signature: None,
                redacted: None,
            });
            Ok(Some(AssistantMessageEvent::ThinkingStart {
                content_index,
                partial: partial.clone(),
            }))
        }
        ProxyAssistantMessageEvent::ThinkingDelta {
            content_index,
            delta,
        } => match partial.content.get_mut(content_index) {
            Some(AssistantContent::Thinking(thinking)) => {
                thinking.thinking.push_str(&delta);
                Ok(Some(AssistantMessageEvent::ThinkingDelta {
                    content_index,
                    delta,
                    partial: partial.clone(),
                }))
            }
            _ => Err("Received thinking_delta for non-thinking content".to_string()),
        },
        ProxyAssistantMessageEvent::ThinkingEnd {
            content_index,
            content_signature,
        } => match partial.content.get_mut(content_index) {
            Some(AssistantContent::Thinking(thinking)) => {
                thinking.thinking_signature = content_signature;
                Ok(Some(AssistantMessageEvent::ThinkingEnd {
                    content_index,
                    partial: partial.clone(),
                }))
            }
            _ => Err("Received thinking_end for non-thinking content".to_string()),
        },
        ProxyAssistantMessageEvent::ToolcallStart {
            content_index,
            id,
            tool_name,
        } => {
            ensure_content(partial, content_index)?;
            partial.content[content_index] = AssistantContent::ToolCall(ToolCall {
                id,
                name: tool_name,
                arguments: serde_json::Value::Object(serde_json::Map::new()),
                thought_signature: None,
            });
            state
                .partial_json
                .insert(content_index, StreamingJsonAccumulator::default());
            Ok(Some(AssistantMessageEvent::ToolCallStart {
                content_index,
                partial: partial.clone(),
            }))
        }
        ProxyAssistantMessageEvent::ToolcallDelta {
            content_index,
            delta,
        } => match partial.content.get_mut(content_index) {
            Some(AssistantContent::ToolCall(tool_call)) => {
                let parsed = state
                    .partial_json
                    .entry(content_index)
                    .or_default()
                    .append(&delta);
                if let Some(parsed) = parsed {
                    tool_call.arguments = parsed;
                }
                Ok(Some(AssistantMessageEvent::ToolCallDelta {
                    content_index,
                    delta,
                    partial: partial.clone(),
                }))
            }
            _ => Err("Received toolcall_delta for non-toolCall content".to_string()),
        },
        ProxyAssistantMessageEvent::ToolcallEnd { content_index } => {
            match partial.content.get_mut(content_index) {
                Some(AssistantContent::ToolCall(tool_call)) => {
                    // TS PR #2783: the throttled preview can lag the final
                    // text; `toolcall_end` finalizes the arguments.
                    let flushed = state
                        .partial_json
                        .remove(&content_index)
                        .and_then(|mut accumulator| accumulator.flush());
                    if let Some(parsed) = flushed {
                        tool_call.arguments = parsed;
                    }
                    Ok(Some(AssistantMessageEvent::ToolCallEnd {
                        content_index,
                        tool_call: tool_call.clone(),
                        partial: partial.clone(),
                    }))
                }
                // TS returns undefined for toolcall_end on non-toolCall content.
                _ => Ok(None),
            }
        }
        ProxyAssistantMessageEvent::Done { reason, usage } => {
            partial.stop_reason = match reason {
                ProxyDoneReason::Stop => StopReason::Stop,
                ProxyDoneReason::Length => StopReason::Length,
                ProxyDoneReason::ToolUse => StopReason::ToolUse,
            };
            partial.usage = usage;
            Ok(Some(AssistantMessageEvent::Done {
                reason: partial.stop_reason,
                message: partial.clone(),
            }))
        }
        ProxyAssistantMessageEvent::Error {
            reason,
            error_message,
            usage,
        } => {
            let stop_reason = match reason {
                ProxyErrorReason::Aborted => StopReason::Aborted,
                ProxyErrorReason::Error => StopReason::Error,
            };
            // TS PR #2783: the error result settles the partial tool calls
            // (the throttled preview can lag the accumulated text).
            settle_partial_tool_calls(state);
            state.partial.stop_reason = stop_reason;
            state.partial.error_message = error_message;
            state.partial.usage = usage;
            Ok(Some(AssistantMessageEvent::Error {
                reason: state.partial.stop_reason,
                error: state.partial.clone(),
            }))
        }
    }
}

/// Port of the TS `settlePartialToolCalls`: finalize tool-call blocks whose
/// parsed preview may lag the accumulated text under the growth throttle.
/// Error paths call this before the error event carries the message.
fn settle_partial_tool_calls(state: &mut ProxyReconstruction) {
    let keys: Vec<usize> = state.partial_json.keys().copied().collect();
    for key in keys {
        let Some(parsed) = state
            .partial_json
            .get_mut(&key)
            .and_then(StreamingJsonAccumulator::flush)
        else {
            continue;
        };
        if let Some(AssistantContent::ToolCall(tool_call)) = state.partial.content.get_mut(key) {
            tool_call.arguments = parsed;
        }
    }
}

// ---------------------------------------------------------------------------
// Streaming JSON utilities (port of `packages/ai/src/utils/json-parse.ts`)
// ---------------------------------------------------------------------------

const VALID_JSON_ESCAPES: [char; 8] = ['"', '\\', '/', 'b', 'f', 'n', 'r', 't'];

fn is_control_character(ch: char) -> bool {
    (ch as u32) <= 0x1f
}

fn escape_control_character(ch: char) -> String {
    match ch {
        '\u{08}' => "\\b".to_string(),
        '\u{0c}' => "\\f".to_string(),
        '\n' => "\\n".to_string(),
        '\r' => "\\r".to_string(),
        '\t' => "\\t".to_string(),
        _ => format!("\\u{:04x}", ch as u32),
    }
}

/// Port of `repairJson`: escape raw control characters inside strings and
/// double backslashes before invalid escape characters.
pub fn repair_json(json: &str) -> String {
    let mut repaired = String::new();
    let mut in_string = false;
    let chars: Vec<char> = json.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if !in_string {
            repaired.push(ch);
            if ch == '"' {
                in_string = true;
            }
            index += 1;
            continue;
        }
        if ch == '"' {
            repaired.push(ch);
            in_string = false;
            index += 1;
            continue;
        }
        if ch == '\\' {
            let next_char = chars.get(index + 1);
            match next_char {
                Some('u') => {
                    let digits: String = chars[index + 2..(index + 6).min(chars.len())]
                        .iter()
                        .collect();
                    if digits.len() == 4 && digits.chars().all(|c| c.is_ascii_hexdigit()) {
                        let _ = write!(repaired, "\\u{digits}");
                        index += 6;
                    } else {
                        repaired.push_str("\\\\");
                        index += 1;
                    }
                }
                Some(&next) if VALID_JSON_ESCAPES.contains(&next) => {
                    repaired.push('\\');
                    repaired.push(next);
                    index += 2;
                }
                None | Some(_) => {
                    repaired.push_str("\\\\");
                    index += 1;
                }
            }
            continue;
        }
        if is_control_character(ch) {
            repaired.push_str(&escape_control_character(ch));
        } else {
            repaired.push(ch);
        }
        index += 1;
    }
    repaired
}

fn parse_json_with_repair(json: &str) -> Result<serde_json::Value, ()> {
    serde_json::from_str(json).map_err(|_| ()).or_else(|()| {
        let repaired = repair_json(json);
        if repaired == json {
            Err(())
        } else {
            serde_json::from_str(&repaired).map_err(|_| ())
        }
    })
}

#[derive(Clone, Copy, PartialEq)]
enum ContainerKind {
    Object,
    Array,
}

#[derive(Clone, Copy, PartialEq)]
enum Expect {
    /// A key string (object) or a value (array).
    KeyOrValue,
    /// After a key string; expecting ':'.
    Colon,
    /// After ':' or '[' or ','; expecting a value.
    Value,
    /// A value is complete; expecting ',' or the closing bracket.
    AfterValue,
}

/// Completes a truncated JSON document by closing open strings and containers,
/// filling missing values with `null` and dropping dangling separators - the
/// same results the TS `partial-json` library produces for streaming tool-call
/// arguments.
fn complete_partial_json(input: &str) -> Option<String> {
    let mut stack: Vec<ContainerKind> = Vec::new();
    let mut expects: Vec<Expect> = Vec::new();
    let mut in_string = false;
    let mut escaping = false;
    let mut literal_start: Option<usize> = None;
    let mut last_comma: Option<usize> = None;

    for (position, ch) in input.char_indices() {
        if in_string {
            if escaping {
                escaping = false;
            } else if ch == '\\' {
                escaping = true;
            } else if ch == '"' {
                in_string = false;
                if let Some(top) = stack.last() {
                    let top_kind = *top;
                    let top_expect = expects.last().copied();
                    match (top_kind, top_expect) {
                        (ContainerKind::Object, Some(Expect::KeyOrValue)) => {
                            *expects.last_mut().unwrap() = Expect::Colon;
                        }
                        _ => {
                            *expects.last_mut().unwrap() = Expect::AfterValue;
                        }
                    }
                }
            }
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                literal_start = None;
            }
            '{' => {
                stack.push(ContainerKind::Object);
                expects.push(Expect::KeyOrValue);
                literal_start = None;
            }
            '[' => {
                stack.push(ContainerKind::Array);
                expects.push(Expect::Value);
                literal_start = None;
            }
            '}' | ']' => {
                stack.pop();
                expects.pop();
                if let Some(expect) = expects.last_mut() {
                    *expect = Expect::AfterValue;
                }
                literal_start = None;
            }
            ',' => {
                last_comma = Some(position);
                if let Some(expect) = expects.last_mut() {
                    let kind = *stack.last().unwrap_or(&ContainerKind::Array);
                    *expect = if kind == ContainerKind::Object {
                        Expect::KeyOrValue
                    } else {
                        Expect::Value
                    };
                }
                literal_start = None;
            }
            ':' => {
                if let Some(expect) = expects.last_mut() {
                    if *expect == Expect::Colon {
                        *expect = Expect::Value;
                    }
                }
                literal_start = None;
            }
            c if c.is_ascii_digit()
                || c == '-'
                || literal_start.is_some()
                    && (c == '.'
                        || c == 'e'
                        || c == 'E'
                        || c == '+'
                        || c.is_ascii_alphanumeric()) =>
            {
                if literal_start.is_none() {
                    literal_start = Some(position);
                }
            }
            _ => {
                if !ch.is_whitespace() && literal_start.is_some() {
                    // literal like true/false/null continues
                }
                // whitespace outside literals
            }
        }
    }

    let mut completed = input.to_string();

    // Close an unterminated string.
    if in_string {
        if escaping {
            completed.pop(); // drop the dangling backslash
        }
        completed.push('"');
        // The closed string is either a key or a value; replicate the close
        // handling from the scan loop.
        if let Some(top) = stack.last() {
            let top_kind = *top;
            match (top_kind, expects.last().copied()) {
                (ContainerKind::Object, Some(Expect::KeyOrValue)) => {
                    *expects.last_mut().unwrap() = Expect::Colon;
                }
                _ => {
                    *expects.last_mut().unwrap() = Expect::AfterValue;
                }
            }
        }
    } else if let Some(literal_start) = literal_start {
        // Possibly truncated number; strip trailing invalid characters.
        let literal = &input[literal_start..];
        let trimmed = literal.trim_end_matches(['.', 'e', 'E', '+', '-']);
        completed = format!("{}{}", &input[..literal_start], trimmed);
        if let Some(expect) = expects.last_mut() {
            *expect = Expect::AfterValue;
        }
    }

    // Close remaining containers from the inside out.
    while let Some(kind) = stack.pop() {
        let expect = expects.pop().unwrap_or(Expect::AfterValue);
        match (kind, expect) {
            (_, Expect::Colon) => completed.push_str(": null"),
            (_, Expect::Value) => {
                // Array/object expecting a value: a dangling comma is invalid.
                if completed.trim_end().ends_with(',') {
                    completed = completed.trim_end().trim_end_matches(',').to_string();
                } else if kind == ContainerKind::Object {
                    completed.push_str("null");
                }
            }
            (_, Expect::KeyOrValue | Expect::AfterValue) => {}
        }
        completed.push(match kind {
            ContainerKind::Object => '}',
            ContainerKind::Array => ']',
        });
        let _ = last_comma.take();
    }

    Some(completed)
}

/// Port of `parseStreamingJson`: parse potentially incomplete JSON, always
/// returning a value (empty object on total failure).
pub fn parse_streaming_json(partial_json: &str) -> serde_json::Value {
    if partial_json.trim().is_empty() {
        return serde_json::Value::Object(serde_json::Map::new());
    }

    if let Ok(value) = parse_json_with_repair(partial_json) {
        return value;
    }
    for candidate in [partial_json.to_string(), repair_json(partial_json)] {
        if let Some(completed) = complete_partial_json(&candidate) {
            if let Ok(value) = serde_json::from_str(&completed) {
                return value;
            }
        }
    }
    serde_json::Value::Object(serde_json::Map::new())
}

const EAGER_PARSE_LENGTH: usize = 8 * 1024;

/// Streamed tool-call argument JSON with a best-effort parsed preview (port
/// of the TS `StreamingJsonAccumulator`; `pa-agent` keeps its own copy of the
/// json-parse utilities because it does not depend on `pa-ai`).
///
/// Re-parsing the whole buffer on every delta is quadratic in the argument
/// size, so past `EAGER_PARSE_LENGTH` the preview is refreshed only after the
/// buffer grew by 1/16 since the last parse, keeping total parse work linear.
/// Callers still parse `text` with [`parse_streaming_json`] when the call ends.
pub struct StreamingJsonAccumulator {
    text: String,
    /// Buffer length in UTF-16 code units, the metric of the TS reference
    /// (`String::length`); maintained incrementally so `append` stays O(delta).
    len_utf16: usize,
    parsed_length: usize,
}

impl StreamingJsonAccumulator {
    pub fn new(text: impl Into<String>) -> Self {
        let text = text.into();
        let len_utf16 = text.chars().map(char::len_utf16).sum();
        Self {
            text,
            len_utf16,
            parsed_length: 0,
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    /// Appends a delta and returns a fresh partial parse, or `None` while the
    /// refresh is throttled (the caller keeps the previous preview).
    pub fn append(&mut self, delta: &str) -> Option<serde_json::Value> {
        self.text.push_str(delta);
        self.len_utf16 += delta.chars().map(char::len_utf16).sum::<usize>();
        let length = self.len_utf16;
        // `length - parsed_length < parsed_length / 16` (the TS float
        // comparison) in exact integer form.
        if length > EAGER_PARSE_LENGTH && 16 * (length - self.parsed_length) < self.parsed_length {
            return None;
        }
        Some(self.parse())
    }

    /// Parses text not covered by the last returned parse; `None` when the
    /// preview is already current.
    pub fn flush(&mut self) -> Option<serde_json::Value> {
        (self.parsed_length != self.len_utf16).then(|| self.parse())
    }

    fn parse(&mut self) -> serde_json::Value {
        self.parsed_length = self.len_utf16;
        parse_streaming_json(&self.text)
    }
}

impl Default for StreamingJsonAccumulator {
    fn default() -> Self {
        Self::new(String::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abort::AbortSignal;
    use crate::stream::{LlmContext, ModelStream, StreamRequestOptions};
    use crate::types::ThinkingLevel;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Serve the SSE body for the proxy's POST. `truncate` claims a larger
    /// Content-Length than the bytes actually sent, so the client's body
    /// stream errors mid-response (the TS stub's mid-stream failure).
    async fn serve_proxy_sse(body: String, truncate: bool) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            // Read the full request: headers, then Content-Length body bytes.
            let mut request = Vec::new();
            let mut chunk = [0u8; 4096];
            let headers_end = loop {
                let read = socket.read(&mut chunk).await.unwrap();
                request.extend_from_slice(&chunk[..read]);
                if let Some(position) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    break position + 4;
                }
            };
            let headers = String::from_utf8_lossy(&request[..headers_end]).to_string();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    if !name.eq_ignore_ascii_case("content-length") {
                        return None;
                    }
                    value.trim().parse::<usize>().ok()
                })
                .unwrap_or(0);
            while request.len() < headers_end + content_length {
                let read = socket.read(&mut chunk).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            let claimed = if truncate {
                body.len() + 8192
            } else {
                body.len()
            };
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {claimed}\r\nConnection: close\r\n\r\n"
            );
            socket.write_all(head.as_bytes()).await.unwrap();
            socket.write_all(body.as_bytes()).await.unwrap();
            let _ = socket.shutdown().await;
        });
        format!("http://{addr}")
    }

    fn proxy_options(proxy_url: String) -> ProxyStreamOptions {
        ProxyStreamOptions {
            auth_token: "test-token".to_string(),
            proxy_url,
            signal: AbortSignal::never(),
        }
    }

    fn request_options() -> StreamRequestOptions {
        StreamRequestOptions {
            temperature: None,
            max_tokens: None,
            reasoning: ThinkingLevel::Off,
            session_id: None,
            api_key: None,
            signal: AbortSignal::never(),
            on_payload: None,
            on_response: None,
        }
    }

    /// Port of the TS proxy.test.ts "finalizes throttled large tool-call
    /// arguments" test: 20 KiB arguments streamed in 16-byte deltas stay past
    /// the eager-parse threshold, so the per-delta preview lags and only the
    /// `toolcall_end` flush (ends cleanly) or the error settle (mid-stream
    /// failure) carries the full parse.
    async fn finalize_throttled_tool_call_arguments(ends_cleanly: bool) {
        let arguments = serde_json::json!({"content": "x".repeat(20 * 1024)}).to_string();
        let mut events = vec![
            r#"{"type":"start"}"#.to_string(),
            r#"{"type":"toolcall_start","contentIndex":0,"id":"call","toolName":"write"}"#
                .to_string(),
        ];
        for delta in arguments.as_bytes().chunks(16) {
            let delta = String::from_utf8_lossy(delta);
            events.push(
                serde_json::json!({"type": "toolcall_delta", "contentIndex": 0, "delta": delta})
                    .to_string(),
            );
        }
        if ends_cleanly {
            events.push(r#"{"type":"toolcall_end","contentIndex":0}"#.to_string());
            events.push(r#"{"type":"done","reason":"toolUse","usage":{}}"#.to_string());
        }
        let mut body = String::new();
        for event in &events {
            use std::fmt::Write as _;
            let _ = write!(body, "data: {event}\n\n");
        }

        let base_url = serve_proxy_sse(body, !ends_cleanly).await;
        let (_handle, mut stream) = stream_proxy(
            test_model(base_url.clone()),
            LlmContext {
                system_prompt: None,
                messages: Vec::new(),
                tools: Vec::new(),
            },
            request_options(),
            proxy_options(base_url),
        );

        let final_message = tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let Some(event) = stream.next_event().await else {
                    break None;
                };
                if let Some(message) = event.terminal_message() {
                    break Some(message.clone());
                }
            }
        })
        .await
        .expect("terminal event within the timeout");
        let message = final_message.expect("terminal done/error event");
        let expected_stop_reason = if ends_cleanly {
            StopReason::ToolUse
        } else {
            StopReason::Error
        };
        assert_eq!(message.stop_reason, expected_stop_reason);
        let Some(AssistantContent::ToolCall(tool_call)) = message.content.first() else {
            panic!("expected a tool call");
        };
        assert_eq!(
            tool_call.arguments,
            serde_json::json!({"content": "x".repeat(20 * 1024)})
        );
    }

    fn test_model(base_url: String) -> Model {
        Model {
            id: "proxy-model".into(),
            name: "Proxy Model".into(),
            api: "proxy".into(),
            provider: "proxy".into(),
            base_url,
            reasoning: false,
            cost: crate::types::UsageCost::default(),
            context_window: 128_000,
            max_tokens: 8_192,
        }
    }

    #[tokio::test]
    async fn finalizes_throttled_large_tool_call_arguments_when_the_call_ends_cleanly() {
        finalize_throttled_tool_call_arguments(true).await;
    }

    #[tokio::test]
    async fn finalizes_throttled_large_tool_call_arguments_when_the_stream_fails_mid_call() {
        finalize_throttled_tool_call_arguments(false).await;
    }
}
