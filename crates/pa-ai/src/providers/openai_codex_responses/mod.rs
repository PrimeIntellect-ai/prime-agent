//! `OpenAI` Codex Responses streaming provider (`openai-codex-responses`).
//!
//! Port of `packages/ai/src/providers/openai-codex-responses.ts`: the `ChatGPT`
//! backend Codex endpoint over WebSocket (session-cached connections with
//! connection-anchored continuation deltas, SSE fallback on transport
//! failures) and plain SSE, JWT `chatgpt-account-id` extraction, usage-limit
//! friendly errors, and service-tier pricing. The stream processing itself is
//! the shared Responses processor ([`crate::providers::openai_responses_shared`]).

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::env_api_keys::get_env_api_key;
use crate::event_stream::{
    create_assistant_message_event_stream, AssistantMessageEvent, AssistantMessageEventStream,
    AssistantMessageEventWriter,
};
use crate::models::clamp_thinking_level;
use crate::providers::openai_codex_responses::errors::{
    append_transport_failure_diagnostic, apply_codex_service_tier_pricing,
    is_stale_codex_continuation_error, map_codex_event, parse_error_response,
    resolve_codex_service_tier, CodexProtocolError, CodexStreamError,
};
use crate::providers::openai_codex_responses::request::{
    build_sse_headers, build_websocket_headers, create_codex_request_id, extract_account_id,
    resolve_codex_url, resolve_codex_websocket_url,
};
use crate::providers::openai_codex_responses::session::{
    clear_continuation, is_websocket_sse_fallback_active, record_request_stats,
    record_websocket_failure, record_websocket_sse_fallback, take_continuation_for,
};
use crate::providers::openai_codex_responses::websocket::{
    acquire_websocket, build_cached_websocket_request_body, release_connection, ContinuationState,
};
use crate::providers::openai_responses_shared::{
    convert_responses_messages, convert_responses_tools, ConvertResponsesMessagesOptions,
    ConvertResponsesToolsOptions, ReasoningSummary, ResponsesStreamHooks, ResponsesStreamProcessor,
    OPENAI_TOOL_CALL_PROVIDERS,
};
use crate::providers::simple_options::build_base_options;
use crate::registry::Provider;
use crate::types::{
    done_reason, error_reason, AssistantMessage, Context, Model, ModelThinkingLevel, ServiceTier,
    SimpleStreamOptions, StopReason, StreamOptions, Transport, Usage,
};
use crate::utils_inner::diagnostics::now_ms;
use crate::utils_inner::http::{send, HttpResponse, RequestOptions};
use crate::utils_inner::json_parse::parse_json_with_repair;
use crate::utils_inner::sse::SseDecoder;
use crate::utils_inner::stream_failure::{record_stream_failure, ProviderError};

mod errors;
pub(crate) mod request;
pub(crate) mod session;
pub(crate) mod websocket;

pub const API_OPENAI_CODEX_RESPONSES: &str = "openai-codex-responses";

/// Provider-native options (`OpenAICodexResponsesOptions` in the TS).
#[derive(Clone, Default)]
pub struct OpenAICodexResponsesOptions {
    pub base: StreamOptions,
    pub reasoning_effort: Option<ModelThinkingLevel>,
    pub reasoning_summary: Option<ReasoningSummary>,
    pub service_tier: Option<ServiceTier>,
    pub text_verbosity: Option<CodexTextVerbosity>,
}

impl OpenAICodexResponsesOptions {
    pub fn from_base(base: StreamOptions) -> Self {
        Self {
            base,
            reasoning_effort: None,
            reasoning_summary: None,
            service_tier: None,
            text_verbosity: None,
        }
    }
}

/// `textVerbosity` request option.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)] // full TS option surface; variants set by callers
pub enum CodexTextVerbosity {
    Low,
    Medium,
    High,
}

impl CodexTextVerbosity {
    pub fn as_str(self) -> &'static str {
        match self {
            CodexTextVerbosity::Low => "low",
            CodexTextVerbosity::Medium => "medium",
            CodexTextVerbosity::High => "high",
        }
    }
}

/// `reasoningSummary` option: the TS also accepts raw string forms
/// ("on"/"off"/null); map them through the shared enum.
fn reasoning_summary_value(summary: Option<ReasoningSummary>) -> &'static str {
    match summary {
        Some(ReasoningSummary::Auto) | None => "auto",
        Some(ReasoningSummary::Detailed) => "detailed",
        Some(ReasoningSummary::Concise) => "concise",
    }
}

/// Port of `streamOpenAICodexResponses`.
pub fn stream_openai_codex_responses(
    model: &Model,
    context: &Context,
    options: Option<&OpenAICodexResponsesOptions>,
) -> AssistantMessageEventStream {
    let options = options.cloned();
    let model = model.clone();
    let context = context.clone();
    let (writer, reader) = create_assistant_message_event_stream();

    tokio::spawn(async move {
        let mut output = AssistantMessage {
            content: Vec::new(),
            api: API_OPENAI_CODEX_RESPONSES.to_string(),
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
            rest: Map::default(),
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
                // The TS provider surfaces `error.message` verbatim (including
                // the usage-limit friendly text), not the classified
                // stream-failure rewrite other providers apply.
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

async fn run_stream(
    model: &Model,
    context: &Context,
    options: Option<&OpenAICodexResponsesOptions>,
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
        .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
    {
        return Err(ProviderError::Aborted);
    }

    let account_id = extract_account_id(&api_key).map_err(|message| {
        ProviderError::Message(format!("Failed to extract accountId from token: {message}"))
    })?;

    let mut body = build_request_body(model, context, &options);
    if let Some(on_payload) = &options.base.on_payload {
        if let Some(next) = on_payload(body.clone(), model) {
            body = next;
        }
    }

    let session_id = options.base.session_id.clone();
    let websocket_request_id = session_id.clone().unwrap_or_else(create_codex_request_id);
    let sse_headers = build_sse_headers(
        model.headers.as_ref(),
        options.base.headers.as_ref(),
        &account_id,
        &api_key,
        session_id.as_deref(),
    );
    let websocket_headers = build_websocket_headers(
        model.headers.as_ref(),
        options.base.headers.as_ref(),
        &account_id,
        &api_key,
        &websocket_request_id,
    );
    let body_json = body.to_string();
    let transport = options.base.transport.unwrap_or(Transport::Auto);
    let websocket_disabled_for_session =
        transport != Transport::Sse && is_websocket_sse_fallback_active(session_id.as_deref());
    if websocket_disabled_for_session {
        record_websocket_sse_fallback(session_id.as_deref());
    }

    if transport != Transport::Sse && !websocket_disabled_for_session {
        let mut websocket_started = false;
        // Retry a stale previous_response_id once on a fresh connection: the
        // failed attempt's error cleanup already dropped the cached
        // connection, so the retry resends the full request body. Any further
        // failure takes the shared error handling below.
        let mut chain_reset_retried = false;
        loop {
            let attempt = run_websocket_attempt(
                model,
                &options,
                &body,
                &websocket_headers,
                output,
                writer,
                &mut websocket_started,
            )
            .await;
            match attempt {
                Ok(()) => {
                    if options
                        .base
                        .signal
                        .as_ref()
                        .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
                    {
                        return Err(ProviderError::Aborted);
                    }
                    return Ok(());
                }
                Err(error) => {
                    let aborted = options
                        .base
                        .signal
                        .as_ref()
                        .is_some_and(tokio_util::sync::CancellationToken::is_cancelled);
                    // Only reset the chain while nothing was streamed yet:
                    // after the first event the retry would duplicate
                    // "start"/content events.
                    if !aborted
                        && !websocket_started
                        && !chain_reset_retried
                        && is_stale_codex_continuation_error(&error)
                    {
                        chain_reset_retried = true;
                        continue;
                    }
                    if aborted || error.is_non_transport_error() {
                        return Err(error.into_provider_error());
                    }
                    // Aborts and non-transport errors (API/protocol) were
                    // handled above; only transport failures reach the SSE
                    // fallback with their diagnostic.
                    let transport_error = match &error {
                        CodexStreamError::Transport(transport) => transport,
                        CodexStreamError::Api(_) | CodexStreamError::Protocol(_) => {
                            return Err(error.into_provider_error());
                        }
                        CodexStreamError::Aborted => return Err(error.into_provider_error()),
                    };
                    append_transport_failure_diagnostic(
                        output,
                        transport_error,
                        transport_debug_name(transport),
                        websocket_started,
                        body_json.len(),
                    );
                    record_websocket_failure(session_id.as_deref(), &error);
                    if websocket_started {
                        return Err(error.into_provider_error());
                    }
                    record_websocket_sse_fallback(session_id.as_deref());
                    break;
                }
            }
        }
    }

    if options
        .base
        .signal
        .as_ref()
        .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
    {
        return Err(ProviderError::Aborted);
    }

    let url = resolve_codex_url(&model.base_url);
    let mut response: HttpResponse = send(RequestOptions {
        method: reqwest::Method::POST,
        url,
        headers: sse_headers,
        body: Some(body_json),
        signal: options.base.signal.clone(),
        timeout_ms: options.base.timeout_ms,
        connection: crate::utils_inner::stream_failure::ConnectionErrorProfile::RawFetch,
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
        let api_error = parse_error_response(&mut response).await;
        return Err(api_error.into_provider_error());
    }

    writer.push(AssistantMessageEvent::Start {
        partial: output.clone(),
    });
    run_sse_stream(&mut response, model, &options, output, writer).await?;

    if options
        .base
        .signal
        .as_ref()
        .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
    {
        return Err(ProviderError::Aborted);
    }

    Ok(())
}

/// One WebSocket attempt (port of the websocket branch of `streamOpenAICodexResponses`).
#[allow(clippy::too_many_arguments)]
async fn run_websocket_attempt(
    model: &Model,
    options: &OpenAICodexResponsesOptions,
    body: &Value,
    websocket_headers: &[(String, String)],
    output: &mut AssistantMessage,
    writer: &AssistantMessageEventWriter,
    websocket_started: &mut bool,
) -> Result<(), CodexStreamError> {
    let session_id = options.base.session_id.as_deref();
    let url = resolve_codex_websocket_url(&model.base_url);
    let connection = acquire_websocket(
        &url,
        websocket_headers,
        session_id,
        options.base.signal.clone(),
    )
    .await?;

    let use_cached_context = matches!(
        options.base.transport,
        Some(Transport::WebsocketCached | Transport::Auto) | None
    );
    // ChatGPT Codex Responses rejects `store: true` ("Store must be set to
    // false"). WebSocket continuation still works via connection-scoped
    // previous_response_id state.
    let full_body = body;
    let continuation = if use_cached_context && connection.cached {
        take_continuation_for(
            session_id.expect("cached connections are session-scoped"),
            connection.connection_id,
        )
    } else {
        None
    };
    let request_body = build_cached_websocket_request_body(
        continuation.as_ref(),
        full_body,
        connection.connection_id,
    );
    if let Some(session_id) = session_id {
        record_request_stats(
            session_id,
            connection.reused,
            use_cached_context,
            &request_body,
        );
    }

    let mut events = connection
        .send_request(&request_body, options.base.signal.clone())
        .await?;

    let mut keep_connection = true;
    let start_partial = output.clone();
    let process = async {
        let model_id = model.id.clone();
        let hooks = ResponsesStreamHooks {
            request_service_tier: options.service_tier,
            resolve_service_tier: Some(Box::new(resolve_codex_service_tier)),
            apply_service_tier_pricing: Some(Box::new(move |usage, service_tier| {
                apply_codex_service_tier_pricing(usage, service_tier.as_deref(), &model_id);
            })),
        };
        let mut start_emitted = false;
        let mut processor = ResponsesStreamProcessor::new(model, output, writer, hooks);
        while let Some(event) = events.recv().await {
            match event {
                websocket::WorkerEvent::Event(event) => {
                    if !start_emitted {
                        start_emitted = true;
                        *websocket_started = true;
                        writer.push(AssistantMessageEvent::Start {
                            partial: start_partial.clone(),
                        });
                    }
                    let mapped = map_codex_event(event)?;
                    processor.handle_event(&mapped.event)?;
                    if mapped.done {
                        break;
                    }
                }
                websocket::WorkerEvent::Terminal(result) => {
                    result?;
                    break;
                }
            }
        }
        processor.finish()?;
        Ok::<(), CodexStreamError>(())
    }
    .await;

    match process {
        Ok(()) => {
            if options
                .base
                .signal
                .as_ref()
                .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
            {
                keep_connection = false;
            } else if use_cached_context && connection.cached && output.response_id.is_some() {
                let response_items = convert_responses_messages(
                    model,
                    &Context {
                        messages: vec![assistant_as_message(output)],
                        tools: None,
                        system_prompt: None,
                    },
                    &OPENAI_TOOL_CALL_PROVIDERS,
                    ConvertResponsesMessagesOptions {
                        include_system_prompt: false,
                    },
                )
                .into_iter()
                .filter(|item| {
                    item.get("type").and_then(Value::as_str) != Some("function_call_output")
                })
                .collect::<Vec<_>>();
                let continuation = ContinuationState {
                    last_request_body: full_body.clone(),
                    last_response_id: output.response_id.clone().unwrap_or_default(),
                    last_response_items: response_items,
                    connection_id: connection.connection_id,
                };
                release_connection(connection, keep_connection, Some(continuation)).await;
                return Ok(());
            }
            release_connection(connection, keep_connection, None).await;
            Ok(())
        }
        Err(error) => {
            if connection.cached {
                clear_continuation(session_id.unwrap_or_default(), connection.connection_id);
            }
            release_connection(connection, false, None).await;
            Err(error)
        }
    }
}

/// Rebuild an `AssistantMessage` as a `Message` for continuation-item
/// conversion (the TS passes `{ messages: [output] }` directly).
fn assistant_as_message(output: &AssistantMessage) -> crate::types::Message {
    crate::types::Message::Assistant(output.clone())
}

/// Port of `processStream`: SSE decoding + shared processor with codex hooks.
async fn run_sse_stream(
    response: &mut HttpResponse,
    model: &Model,
    options: &OpenAICodexResponsesOptions,
    output: &mut AssistantMessage,
    writer: &AssistantMessageEventWriter,
) -> Result<(), ProviderError> {
    let model_id = model.id.clone();
    let hooks = ResponsesStreamHooks {
        request_service_tier: options.service_tier,
        resolve_service_tier: Some(Box::new(resolve_codex_service_tier)),
        apply_service_tier_pricing: Some(Box::new(move |usage, service_tier| {
            apply_codex_service_tier_pricing(usage, service_tier.as_deref(), &model_id);
        })),
    };
    let mut processor = ResponsesStreamProcessor::new(model, output, writer, hooks);
    let mut decoder = SseDecoder::new();
    loop {
        let Some(chunk) = response.next_text().await? else {
            break;
        };
        process_sse_chunk(&chunk, &mut decoder, model, &mut processor)?;
    }
    for sse in decoder.finish() {
        if sse.data.trim().is_empty() || sse.data.trim() == "[DONE]" {
            continue;
        }
        let event = parse_json_with_repair(&sse.data).map_err(|error| {
            CodexStreamError::Protocol(CodexProtocolError {
                message: format!("Invalid Codex SSE JSON: {error}"),
                payload: Some(Value::String(sse.data.clone())),
            })
            .into_provider_error()
        })?;
        let mapped = map_codex_event(event).map_err(CodexStreamError::into_provider_error)?;
        processor.handle_event(&mapped.event)?;
    }
    processor.finish()?;
    Ok(())
}

fn process_sse_chunk(
    chunk: &str,
    decoder: &mut SseDecoder,
    _model: &Model,
    processor: &mut ResponsesStreamProcessor<'_>,
) -> Result<(), ProviderError> {
    for sse in decoder.push_text(chunk) {
        if sse.data.trim().is_empty() || sse.data.trim() == "[DONE]" {
            continue;
        }
        let event = parse_json_with_repair(&sse.data).map_err(|error| {
            CodexStreamError::Protocol(CodexProtocolError {
                message: format!("Invalid Codex SSE JSON: {error}"),
                payload: Some(Value::String(sse.data.clone())),
            })
            .into_provider_error()
        })?;
        let mapped = map_codex_event(event).map_err(CodexStreamError::into_provider_error)?;
        processor.handle_event(&mapped.event)?;
        if mapped.done {
            return Ok(());
        }
    }
    Ok(())
}

/// Port of `buildRequestBody`.
fn build_request_body(
    model: &Model,
    context: &Context,
    options: &OpenAICodexResponsesOptions,
) -> Value {
    let messages = convert_responses_messages(
        model,
        context,
        &OPENAI_TOOL_CALL_PROVIDERS,
        ConvertResponsesMessagesOptions {
            include_system_prompt: false,
        },
    );

    let mut body = Map::new();
    body.insert("model".into(), json!(model.id));
    body.insert("store".into(), json!(false));
    body.insert("stream".into(), json!(true));
    body.insert(
        "instructions".into(),
        json!(context
            .system_prompt
            .clone()
            .unwrap_or_else(|| "You are a helpful assistant.".to_string())),
    );
    body.insert("input".into(), Value::Array(messages));
    body.insert(
        "text".into(),
        json!({
            "verbosity": options.text_verbosity.unwrap_or(CodexTextVerbosity::Low).as_str(),
        }),
    );
    body.insert("include".into(), json!(["reasoning.encrypted_content"]));
    if let Some(session_id) = &options.base.session_id {
        body.insert("prompt_cache_key".into(), json!(session_id));
    }
    body.insert("tool_choice".into(), json!("auto"));
    body.insert("parallel_tool_calls".into(), json!(true));

    if let Some(temperature) = options.base.temperature {
        body.insert("temperature".into(), json!(temperature));
    }
    if let Some(service_tier) = options.service_tier {
        body.insert("service_tier".into(), json!(service_tier_str(service_tier)));
    }
    if let Some(tools) = &context.tools {
        if !tools.is_empty() {
            body.insert(
                "tools".into(),
                Value::Array(convert_responses_tools(
                    tools,
                    ConvertResponsesToolsOptions { strict: None },
                )),
            );
        }
    }

    if let Some(reasoning_effort) = options.reasoning_effort {
        let mapped = model
            .thinking_level_map
            .as_ref()
            .and_then(|map| map.get(&reasoning_effort))
            .cloned()
            .flatten();
        let effort = match reasoning_effort {
            ModelThinkingLevel::Off => mapped.or_else(|| Some("none".to_string())),
            _ => mapped.or_else(|| Some(thinking_level_wire_name(reasoning_effort).to_string())),
        };
        if let Some(effort) = effort {
            body.insert(
                "reasoning".into(),
                json!({
                    "effort": effort,
                    "summary": reasoning_summary_value(options.reasoning_summary),
                }),
            );
        }
    }

    Value::Object(body)
}

fn service_tier_str(tier: ServiceTier) -> &'static str {
    match tier {
        ServiceTier::Auto => "auto",
        ServiceTier::Default => "default",
        ServiceTier::Flex => "flex",
        ServiceTier::Scale => "scale",
        ServiceTier::Priority => "priority",
    }
}

/// Wire name for a thinking level (matches `ModelThinkingLevel` serde).
fn thinking_level_wire_name(level: ModelThinkingLevel) -> &'static str {
    match level {
        ModelThinkingLevel::Off => "off",
        ModelThinkingLevel::Minimal => "minimal",
        ModelThinkingLevel::Low => "low",
        ModelThinkingLevel::Medium => "medium",
        ModelThinkingLevel::High => "high",
        ModelThinkingLevel::Xhigh => "xhigh",
        ModelThinkingLevel::Max => "max",
    }
}

/// Debug name for the transport in diagnostics.
fn transport_debug_name(transport: Transport) -> &'static str {
    match transport {
        Transport::Sse => "sse",
        Transport::Websocket => "websocket",
        Transport::WebsocketCached => "websocket-cached",
        Transport::Auto => "auto",
    }
}

/// Port of `streamSimpleOpenAICodexResponses`.
pub fn stream_simple_openai_codex_responses(
    model: &Model,
    context: &Context,
    options: Option<&SimpleStreamOptions>,
) -> AssistantMessageEventStream {
    let api_key = options
        .and_then(|options| options.base.api_key.clone())
        .filter(|key| !key.is_empty())
        .or_else(|| get_env_api_key(&model.provider));
    let Some(api_key) = api_key else {
        let (writer, reader) = create_assistant_message_event_stream();
        let message = AssistantMessage {
            content: Vec::new(),
            api: model.api.clone(),
            provider: model.provider.clone(),
            model: model.id.clone(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::default(),
            stop_reason: StopReason::Error,
            stop_reason_raw: None,
            error_message: Some(format!("No API key for provider: {}", model.provider)),
            timestamp: now_ms(),
            rest: Map::default(),
        };
        writer.push(AssistantMessageEvent::Error {
            reason: crate::types::ErrorStopReason::Error,
            error: message.clone(),
        });
        writer.end(Some(message));
        return reader;
    };

    let base = build_base_options(model, options, Some(&api_key));
    let reasoning = options.and_then(|options| options.reasoning);
    let reasoning_effort = reasoning
        .map(|reasoning| clamp_thinking_level(model, reasoning))
        .filter(|level| *level != ModelThinkingLevel::Off);

    let stream_options = OpenAICodexResponsesOptions {
        base,
        reasoning_effort,
        ..Default::default()
    };
    stream_openai_codex_responses(model, context, Some(&stream_options))
}

/// Registry provider for the `openai-codex-responses` API.
pub struct OpenAICodexResponsesProvider;

impl Provider for OpenAICodexResponsesProvider {
    fn api(&self) -> &str {
        API_OPENAI_CODEX_RESPONSES
    }

    fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> AssistantMessageEventStream {
        let options = options.map(|base| OpenAICodexResponsesOptions::from_base(base.clone()));
        stream_openai_codex_responses(model, context, options.as_ref())
    }

    fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> AssistantMessageEventStream {
        stream_simple_openai_codex_responses(model, context, options)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The user-facing text for a failed codex stream is the verbatim error
    /// message; the raw-`fetch` SSE connection failure surfaces the
    /// runtime's own refused-connect text (the codex provider uses no HTTP
    /// SDK).
    #[test]
    fn codex_error_message_shapes() {
        let usage_limit =
            ProviderError::Http(crate::utils_inner::stream_failure::ProviderHttpError {
                message: "You have hit your ChatGPT usage limit (pro plan).".to_string(),
                status: Some(429),
                body: None,
                headers: HashMap::default(),
                request_id: None,
                sdk_name: Some("CodexApiError".to_string()),
                retry_after_ms: Some(60_000),
                provider_error_type: Some("usage_limit_reached".to_string()),
            });
        assert_eq!(
            usage_limit.to_string(),
            "You have hit your ChatGPT usage limit (pro plan)."
        );
        let connect = ProviderError::Connection(
            crate::utils_inner::stream_failure::ProviderConnectionError {
                kind: crate::utils_inner::stream_failure::ConnectionErrorKind::Connect,
                profile: crate::utils_inner::stream_failure::ConnectionErrorProfile::RawFetch,
                cause: "tcp connect error".to_string(),
            },
        );
        assert_eq!(
            connect.to_string(),
            "Unable to connect. Is the computer able to access the url?"
        );
        assert_eq!(ProviderError::Aborted.to_string(), "Request was aborted");
    }

    #[test]
    fn additional_headers_override_model_headers() {
        let mut model_headers = std::collections::BTreeMap::new();
        model_headers.insert("x-model".to_string(), "a".to_string());
        let mut additional = std::collections::HashMap::new();
        additional.insert("x-model".to_string(), "b".to_string());
        let headers =
            build_sse_headers(Some(&model_headers), Some(&additional), "acct", "tok", None);
        let value = headers
            .iter()
            .find(|(key, _)| key == "x-model")
            .map(|(_, value)| value.as_str())
            .unwrap();
        assert_eq!(value, "b");
    }

    use crate::types::{
        Message, ModelInput, TextContent, ToolResultMessage, UserMessage, UserMessageContent,
        UserOrToolContent,
    };

    fn codex_wire_model() -> Model {
        Model {
            id: "gpt-5.1-codex".into(),
            name: "gpt-5.1-codex".into(),
            api: "openai-codex-responses".into(),
            provider: "openai-codex".into(),
            base_url: "https://chatgpt.com/backend-api".into(),
            reasoning: true,
            thinking_level_map: None,
            input: vec![ModelInput::Text],
            cost: crate::types::zero_model_cost(),
            context_window: 400_000,
            max_tokens: 128_000,
            featured: None,
            headers: None,
            compat: None,
        }
    }

    /// Replay a codex wire turn that issues one function call (the event
    /// shapes the #222 codex suite replays) and return the recorded
    /// assistant message. `item_id` omits the `fc_` item id from the wire
    /// items, the degenerate shape that produced the dogfood
    /// `[ApiParam][invalid_id]` rejection on the follow-up turn.
    fn replay_codex_tool_call_turn(model: &Model, item_id: Option<&str>) -> AssistantMessage {
        let function_call_item = |arguments: &str| {
            let mut item = Map::new();
            item.insert("type".into(), json!("function_call"));
            item.insert("call_id".into(), json!("call_abc"));
            if let Some(item_id) = item_id {
                item.insert("id".into(), json!(item_id));
            }
            item.insert("name".into(), json!("bash"));
            item.insert("arguments".into(), json!(arguments));
            Value::Object(item)
        };
        let events = vec![
            json!({"type": "response.created", "response": {"id": "resp_1"}}),
            json!({
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {"type": "reasoning", "id": "rs_1", "summary": []},
            }),
            json!({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {
                    "type": "reasoning",
                    "id": "rs_1",
                    "summary": [],
                    "encrypted_content": "enc",
                },
            }),
            json!({
                "type": "response.output_item.added",
                "output_index": 1,
                "item": function_call_item(""),
            }),
            json!({
                "type": "response.function_call_arguments.delta",
                "output_index": 1,
                "delta": "{\"cmd\":",
            }),
            json!({
                "type": "response.function_call_arguments.delta",
                "output_index": 1,
                "delta": " \"ls\"}",
            }),
            json!({
                "type": "response.function_call_arguments.done",
                "output_index": 1,
                "arguments": "{\"cmd\":\"ls\"}",
            }),
            json!({
                "type": "response.output_item.done",
                "output_index": 1,
                "item": function_call_item("{\"cmd\":\"ls\"}"),
            }),
            json!({
                "type": "response.completed",
                "response": {
                    "id": "resp_1",
                    "status": "completed",
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 5,
                        "input_tokens_details": {"cached_tokens": 0},
                        "output_tokens_details": {"reasoning_tokens": 0},
                    },
                },
            }),
        ];
        let mut output = AssistantMessage {
            content: Vec::new(),
            api: "openai-codex-responses".into(),
            provider: "openai-codex".into(),
            model: model.id.clone(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: Map::default(),
        };
        let (writer, _stream) = AssistantMessageEventStream::new();
        let mut processor = ResponsesStreamProcessor::new(
            model,
            &mut output,
            &writer,
            ResponsesStreamHooks::default(),
        );
        for event in events {
            let mapped = map_codex_event(event).expect("codex event mapping");
            processor.handle_event(&mapped.event).expect("stream event");
        }
        processor.finish().expect("stream finish");
        output
    }

    fn followup_request_input(
        model: &Model,
        output: AssistantMessage,
        tool_call_id: &str,
    ) -> Vec<Value> {
        let context = Context {
            system_prompt: Some("You are a helpful assistant.".into()),
            messages: vec![
                Message::User(UserMessage {
                    content: UserMessageContent::Text("run ls".into()),
                    timestamp: 0,
                    rest: Map::default(),
                }),
                Message::Assistant(output),
                Message::ToolResult(ToolResultMessage {
                    tool_call_id: tool_call_id.into(),
                    tool_name: "bash".into(),
                    content: vec![UserOrToolContent::Text(TextContent {
                        text: "ok".into(),
                        text_signature: None,
                        rest: Map::default(),
                    })],
                    details: None,
                    is_error: false,
                    timestamp: 0,
                    rest: Map::default(),
                }),
            ],
            tools: None,
        };
        let body = build_request_body(model, &context, &OpenAICodexResponsesOptions::default());
        body.get("input")
            .and_then(Value::as_array)
            .cloned()
            .expect("request input items")
    }

    fn assert_no_empty_ids(items: &[Value]) {
        for item in items {
            for key in ["id", "call_id"] {
                if let Some(Value::String(id)) = item.get(key) {
                    assert!(!id.is_empty(), "empty {key} in item: {item}");
                }
            }
        }
    }

    fn function_call_item(items: &[Value]) -> &Value {
        items
            .iter()
            .find(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
            .unwrap_or_else(|| panic!("missing function_call item in {items:?}"))
    }

    /// Wire-level verifier: after a codex tool-call turn, the follow-up
    /// request replays the recorded rows and every input item carries valid
    /// ids (the dogfood bug sent `input[2].id: ""` and the API rejected the
    /// turn with `[ApiParam][invalid_id]`).
    #[test]
    fn codex_tool_call_followup_request_carries_valid_ids() {
        let model = codex_wire_model();
        let output = replay_codex_tool_call_turn(&model, Some("fc_123"));
        // The recorded rows carry the `call_id|item_id` encoding and the
        // streamed arguments.
        let tool_call = match output.content.last() {
            Some(crate::types::AssistantContent::ToolCall(tool_call)) => tool_call,
            other => panic!("expected a recorded tool call, got {other:?}"),
        };
        assert_eq!(tool_call.id, "call_abc|fc_123");
        assert_eq!(tool_call.arguments["cmd"], json!("ls"));
        let items = followup_request_input(&model, output, "call_abc|fc_123");
        assert_no_empty_ids(&items);
        assert_eq!(
            items[0].get("role"),
            Some(&json!("user")),
            "expected the user row first: {items:?}"
        );
        let function_call = function_call_item(&items);
        assert_eq!(function_call.get("id"), Some(&json!("fc_123")));
        assert_eq!(function_call.get("call_id"), Some(&json!("call_abc")));
    }

    /// Degenerate wire shape: `function_call` items without an `fc_` item id.
    /// The recorded tool call id carries an empty item segment; the
    /// follow-up request must omit the `id` key (never `id: ""`).
    #[test]
    fn codex_followup_omits_missing_item_id_instead_of_sending_empty() {
        let model = codex_wire_model();
        let output = replay_codex_tool_call_turn(&model, None);
        let recorded_id = match output.content.last() {
            Some(crate::types::AssistantContent::ToolCall(tool_call)) => tool_call.id.clone(),
            other => panic!("expected a recorded tool call, got {other:?}"),
        };
        assert_eq!(recorded_id, "call_abc|");
        let items = followup_request_input(&model, output, &recorded_id);
        assert_no_empty_ids(&items);
        let function_call = function_call_item(&items);
        assert!(
            function_call.get("id").is_none(),
            "expected no item id on the degenerate replay: {function_call:?}"
        );
        assert_eq!(function_call.get("call_id"), Some(&json!("call_abc")));
    }
}
