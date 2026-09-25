//! OpenAI Codex Responses streaming provider (`openai-codex-responses`).
//!
//! Port of `packages/ai/src/providers/openai-codex-responses.ts`: the ChatGPT
//! backend Codex endpoint over WebSocket (session-cached connections with
//! connection-anchored continuation deltas, SSE fallback on transport
//! failures) and plain SSE, JWT `chatgpt-account-id` extraction, usage-limit
//! friendly errors, and service-tier pricing. The stream processing itself is
//! the shared Responses processor ([`crate::providers::openai_responses_shared`]).

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
        Some(ReasoningSummary::Auto) => "auto",
        Some(ReasoningSummary::Detailed) => "detailed",
        Some(ReasoningSummary::Concise) => "concise",
        None => "auto",
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
        .map(tokio_util::sync::CancellationToken::is_cancelled)
        .unwrap_or(false)
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
                        .map(tokio_util::sync::CancellationToken::is_cancelled)
                        .unwrap_or(false)
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
                        .map(tokio_util::sync::CancellationToken::is_cancelled)
                        .unwrap_or(false);
                    // Only reset the chain before visible output starts:
                    // retrying after content events would duplicate
                    // "start"/content events.
                    if !aborted
                        && !websocket_started
                        && !chain_reset_retried
                        && is_stale_codex_continuation_error(&error)
                    {
                        chain_reset_retried = true;
                        // A failed attempt may have supplied response
                        // metadata before rejecting the continuation. Do
                        // not retain that dead anchor (TS #2374
                        // `delete output.responseId`).
                        output.response_id = None;
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
        .map(tokio_util::sync::CancellationToken::is_cancelled)
        .unwrap_or(false)
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
        .map(tokio_util::sync::CancellationToken::is_cancelled)
        .unwrap_or(false)
    {
        return Err(ProviderError::Aborted);
    }

    Ok(())
}

/// Whether one parsed Codex WebSocket event can produce assistant output
/// consumed by the shared responses processor (TS #2374
/// `isCodexVisibleResponseEvent`): the terminal families plus the output,
/// reasoning, content, refusal, and function streams. Lifecycle
/// (`response.created`/`response.in_progress`), telemetry, and vendor
/// metadata cannot, so they stay internal and never mark the attempt as
/// user-visible.
fn is_codex_visible_response_event(event: &Value) -> bool {
    let Some(event_type) = event.get("type").and_then(Value::as_str) else {
        return false;
    };
    event_type == "response.completed"
        || event_type == "response.incomplete"
        || event_type.starts_with("response.output_")
        || event_type.starts_with("response.reasoning_")
        || event_type.starts_with("response.content_")
        || event_type.starts_with("response.refusal.")
        || event_type.starts_with("response.function_")
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
                    // Codex can emit lifecycle, telemetry, or vendor metadata
                    // before rejecting a stale continuation. Keep the attempt
                    // retryable until an event can produce output consumed by
                    // the shared processor (TS #2374's visible-event gate).
                    if !start_emitted && is_codex_visible_response_event(&event) {
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
                .map(tokio_util::sync::CancellationToken::is_cancelled)
                .unwrap_or(false)
            {
                keep_connection = false;
            } else if use_cached_context && connection.cached && !output.response_id.is_none() {
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
        let chunk = match response.next_text().await? {
            Some(chunk) => chunk,
            None => break,
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
    let api_key = match api_key {
        Some(api_key) => api_key,
        None => {
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
                rest: Default::default(),
            };
            writer.push(AssistantMessageEvent::Error {
                reason: crate::types::ErrorStopReason::Error,
                error: message.clone(),
            });
            writer.end(Some(message));
            return reader;
        }
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
                headers: Default::default(),
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
            rest: Default::default(),
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
                    rest: Default::default(),
                }),
                Message::Assistant(output),
                Message::ToolResult(ToolResultMessage {
                    tool_call_id: tool_call_id.into(),
                    tool_name: "bash".into(),
                    content: vec![UserOrToolContent::Text(TextContent {
                        text: "ok".into(),
                        text_signature: None,
                        rest: Default::default(),
                    })],
                    details: None,
                    is_error: false,
                    timestamp: 0,
                    rest: Default::default(),
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

    /// Degenerate wire shape: function_call items without an `fc_` item id.
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

    // --- TS #2374: the stale-chain retry gate arms on real output only ---

    /// Whether an event family can produce assistant output (the TS
    /// `isCodexVisibleResponseEvent` classifier): the terminal, output,
    /// reasoning, content, refusal, and function families do; lifecycle,
    /// telemetry, and vendor metadata do not.
    #[test]
    fn codex_visible_event_classifier() {
        let visible = [
            "response.completed",
            "response.incomplete",
            "response.output_item.added",
            "response.output_text.delta",
            "response.reasoning_summary_part.added",
            "response.content_part.added",
            "response.refusal.delta",
            "response.function_call_arguments.delta",
        ];
        for event_type in visible {
            let event = json!({ "type": event_type });
            assert!(
                is_codex_visible_response_event(&event),
                "{event_type} must be visible"
            );
        }
        let internal = [
            "response.created",
            "response.in_progress",
            "codex.response.metadata",
            "responsesapi.websocket_timing",
            "error",
        ];
        for event_type in internal {
            let event = json!({ "type": event_type });
            assert!(
                !is_codex_visible_response_event(&event),
                "{event_type} must stay internal"
            );
        }
        // A missing type is not output.
        assert!(!is_codex_visible_response_event(&json!({ "other": 1 })));
    }

    /// A mock Codex websocket server: one listener serving connections
    /// sequentially, each connection answering its scripted requests. The
    /// `response.create` bodies are captured (masked client frames), so
    /// the tests can assert the continuation anchoring.
    struct ScriptedCodexServer {
        port: u16,
        sent_bodies: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    }

    fn codex_response_events(response_id: &str, message_id: &str, text: &str) -> Vec<Value> {
        vec![
            json!({ "type": "response.created", "response": { "id": response_id } }),
            json!({
                "type": "response.output_item.added",
                "output_index": 0,
                "item": { "type": "message", "id": message_id, "role": "assistant", "status": "in_progress", "content": [] },
            }),
            json!({
                "type": "response.content_part.added",
                "output_index": 0,
                "content_index": 0,
                "part": { "type": "output_text", "text": "" },
            }),
            json!({
                "type": "response.output_text.delta",
                "output_index": 0,
                "content_index": 0,
                "delta": text,
            }),
            json!({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": { "type": "message", "id": message_id, "role": "assistant", "status": "completed", "content": [{ "type": "output_text", "text": text }] },
            }),
            json!({
                "type": "response.completed",
                "response": {
                    "id": response_id,
                    "status": "completed",
                    "usage": { "input_tokens": 5, "output_tokens": 3, "total_tokens": 8 },
                },
            }),
        ]
    }

    fn codex_error_events(code: &str, message: &str) -> Vec<Value> {
        vec![json!({ "type": "error", "code": code, "message": message })]
    }

    /// Read one masked websocket frame from the client (the request body).
    async fn read_client_frame(
        socket: &mut tokio::net::TcpStream,
    ) -> anyhow::Result<Option<(u8, Vec<u8>)>> {
        use tokio::io::AsyncReadExt;
        let mut header = [0u8; 2];
        match socket.read_exact(&mut header).await {
            Ok(_) => {}
            Err(_) => return Ok(None),
        }
        let opcode = header[0] & 0x0F;
        let masked = header[1] & 0x80 != 0;
        let mut length = (header[1] & 0x7F) as u64;
        if length == 126 {
            let mut extended = [0u8; 2];
            socket.read_exact(&mut extended).await?;
            length = u16::from_be_bytes(extended) as u64;
        } else if length == 127 {
            let mut extended = [0u8; 8];
            socket.read_exact(&mut extended).await?;
            length = u64::from_be_bytes(extended);
        }
        let mut mask = [0u8; 4];
        if masked {
            socket.read_exact(&mut mask).await?;
        }
        let mut payload = vec![0u8; length as usize];
        socket.read_exact(&mut payload).await?;
        if masked {
            for (index, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[index % 4];
            }
        }
        Ok(Some((opcode, payload)))
    }

    /// Write one unmasked websocket text frame (server -> client events).
    async fn write_server_frame(
        socket: &mut tokio::net::TcpStream,
        payload: &Value,
    ) -> anyhow::Result<()> {
        use tokio::io::AsyncWriteExt;
        let body = serde_json::to_string(payload)?;
        let mut frame = vec![0x81u8];
        let length = body.len();
        if length < 126 {
            frame.push(length as u8);
        } else if length < 65_536 {
            frame.push(126);
            frame.extend_from_slice(&(length as u16).to_be_bytes());
        } else {
            frame.push(127);
            frame.extend_from_slice(&(length as u64).to_be_bytes());
        }
        frame.extend_from_slice(body.as_bytes());
        socket.write_all(&frame).await?;
        Ok(())
    }

    /// Spawn the scripted server: `scripts[connection][request]` is the
    /// event list the server answers that request with. A connection whose
    /// scripts are exhausted is held until the client closes it.
    async fn spawn_scripted_codex_server(scripts: Vec<Vec<Vec<Value>>>) -> ScriptedCodexServer {
        use base64::Engine as _;
        use sha1::Digest as _;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("mock bind");
        let port = listener.local_addr().unwrap().port();
        let sent_bodies = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sent_bodies_handle = std::sync::Arc::clone(&sent_bodies);
        tokio::spawn(async move {
            let serve = async move {
                for (connection_number, connection_scripts) in scripts.into_iter().enumerate() {
                    let (mut socket, _) = listener.accept().await.expect("mock accept");
                    eprintln!("[mock] accepted connection {connection_number}");
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        use tokio::io::AsyncReadExt;
                        socket.read_exact(&mut byte).await.expect("mock head");
                        head.push(byte[0]);
                    }
                    let head_text = String::from_utf8_lossy(&head).to_string();
                    let key = head_text
                        .lines()
                        .find_map(|line| {
                            line.split_once(": ")
                                .filter(|(name, _)| name.eq_ignore_ascii_case("sec-websocket-key"))
                                .map(|(_, value)| value.trim().to_string())
                        })
                        .expect("upgrade key");
                    let accept =
                        base64::engine::general_purpose::STANDARD.encode(sha1::Sha1::digest(
                            format!("{key}{}", "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").as_bytes(),
                        ));
                    use tokio::io::AsyncWriteExt;
                    socket
                        .write_all(
                            format!(
                                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
                            )
                            .as_bytes(),
                        )
                        .await
                        .expect("mock write");
                    let mut request_number = 0usize;
                    loop {
                        // One frame per iteration: requests answer their
                        // script in order; a close frame ends the connection
                        // (answered, so the client's close handshake
                        // completes) and anything after the scripted
                        // requests holds without a response.
                        let Some((opcode, payload)) = read_client_frame(&mut socket).await? else {
                            eprintln!("[mock] connection {connection_number} EOF");
                            break;
                        };
                        if opcode == 8 {
                            eprintln!("[mock] connection {connection_number} close, replying");
                            socket.write_all(&[0x88, 0x02, 0x03, 0xE8]).await?;
                            break;
                        }
                        request_number += 1;
                        let body: Value = serde_json::from_slice(&payload).expect("request json");
                        eprintln!("[mock] connection {connection_number} request {request_number}");
                        sent_bodies_handle.lock().expect("bodies").push(body);
                        if let Some(script) = connection_scripts.get(request_number - 1) {
                            for event in script {
                                write_server_frame(&mut socket, event).await?;
                            }
                            eprintln!(
                                "[mock] connection {connection_number} request {request_number} answered"
                            );
                            // A script that ends in an error closes the
                            // connection (the real server ends the request
                            // with the error; the client's read loop needs
                            // the close to finish its terminal bookkeeping).
                            let ends_in_error = script
                                .last()
                                .and_then(|event| event.get("type"))
                                .and_then(Value::as_str)
                                == Some("error");
                            if ends_in_error {
                                socket.write_all(&[0x88, 0x02, 0x03, 0xE8]).await?;
                                eprintln!(
                                    "[mock] connection {connection_number} request {request_number} closed after error"
                                );
                            }
                        } else {
                            eprintln!(
                                "[mock] connection {connection_number} request {request_number} NOT scripted (holding)"
                            );
                        }
                    }
                }
                Ok::<(), anyhow::Error>(())
            };
            let _ = serve.await;
        });
        ScriptedCodexServer { port, sent_bodies }
    }

    fn mock_codex_token() -> String {
        use base64::Engine as _;
        let header = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(json!({ "alg": "RS256", "typ": "JWT" }).to_string());
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            json!({ "https://api.openai.com/auth": { "chatgpt_account_id": "acct_mock" } })
                .to_string(),
        );
        format!("{header}.{payload}.sig")
    }

    fn codex_test_options(
        _server: &ScriptedCodexServer,
        session_id: &str,
    ) -> OpenAICodexResponsesOptions {
        OpenAICodexResponsesOptions {
            base: StreamOptions {
                api_key: Some(mock_codex_token()),
                transport: Some(Transport::WebsocketCached),
                session_id: Some(session_id.to_string()),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    fn codex_test_model(port: u16) -> Model {
        Model {
            base_url: format!("http://127.0.0.1:{port}"),
            ..codex_wire_model()
        }
    }

    fn codex_test_context(text: &str) -> Context {
        Context {
            system_prompt: Some("You are a helpful assistant.".to_string()),
            messages: vec![crate::types::Message::User(crate::types::UserMessage {
                content: crate::types::UserMessageContent::Text(text.to_string()),
                timestamp: 1,
                rest: Default::default(),
            })],
            tools: None,
        }
    }

    /// The follow-up turn's context: the full conversation (the first
    /// user row, the first assistant row, then the new user row), like
    /// the TS fixture (`[...firstContext.messages, first, { user }]`).
    fn codex_followup_context(first: &AssistantMessage, text: &str) -> Context {
        Context {
            system_prompt: Some("You are a helpful assistant.".to_string()),
            messages: vec![
                crate::types::Message::User(crate::types::UserMessage {
                    content: crate::types::UserMessageContent::Text("Say hello".to_string()),
                    timestamp: 1,
                    rest: Default::default(),
                }),
                crate::types::Message::Assistant(first.clone()),
                crate::types::Message::User(crate::types::UserMessage {
                    content: crate::types::UserMessageContent::Text(text.to_string()),
                    timestamp: 2,
                    rest: Default::default(),
                }),
            ],
            tools: None,
        }
    }

    /// The first text block of a streamed assistant message.
    fn codex_message_text(message: &AssistantMessage) -> Option<String> {
        message.content.iter().find_map(|content| match content {
            crate::types::AssistantContent::Text(text) => Some(text.text.clone()),
            _ => None,
        })
    }

    /// TS #2374 regression: lifecycle and vendor metadata events before a
    /// stale `previous_response_id` rejection keep the attempt retryable —
    /// the provider retries once on a fresh socket with the full request
    /// body (no `previous_response_id`), the consumer sees exactly one
    /// `start`, and the recovered response id lands.
    #[tokio::test]
    async fn recovers_stale_chain_after_metadata_events() {
        let server = spawn_scripted_codex_server(vec![
            // Connection 1: request 1 completes (the cached chain anchor),
            // request 2 rejects the stale continuation after lifecycle and
            // vendor metadata events.
            vec![
                codex_response_events("resp_1", "msg_1", "Hello"),
                vec![
                    json!({ "type": "response.created", "response": { "id": "resp_stale" } }),
                    json!({ "type": "response.in_progress", "response": { "id": "resp_stale" } }),
                    json!({ "type": "codex.response.metadata", "headers": {} }),
                    json!({ "type": "responsesapi.websocket_timing", "elapsed_ms": 1 }),
                    // The pre-fix gate died here: metadata armed the
                    // start flag, the stale rejection surfaced.
                    codex_error_events(
                        "previous_response_not_found",
                        "Previous response with id 'resp_1' not found.",
                    )
                    .remove(0),
                ],
            ],
            // Connection 2: the chain-reset retry on a fresh socket.
            vec![codex_response_events("resp_2", "msg_2", "Done")],
        ])
        .await;
        let model = codex_test_model(server.port);
        let session_id = format!("session-chain-reset-metadata-{}", std::process::id());
        let options = codex_test_options(&server, &session_id);
        let first =
            stream_openai_codex_responses(&model, &codex_test_context("Say hello"), Some(&options))
                .result()
                .await;
        eprintln!(
            "[test] turn 1 settled: stop={:?} text={:?} response_id={:?}",
            first.stop_reason,
            codex_message_text(&first),
            first.response_id
        );
        assert_eq!(
            codex_message_text(&first).as_deref(),
            Some("Hello"),
            "the first turn completes and anchors the chain"
        );
        assert_eq!(first.response_id.as_deref(), Some("resp_1"));
        {
            use crate::providers::openai_codex_responses::session::session_state;
            let state = session_state().lock().expect("state");
            let entry = state.connections.get(&session_id);
            let summary = entry.map(|entry| {
                (
                    entry.busy,
                    entry.connection_id,
                    entry.continuation.as_ref().map(|continuation| {
                        (
                            continuation.connection_id,
                            continuation.last_response_id.clone(),
                            continuation.last_response_items.len(),
                        )
                    }),
                )
            });
            eprintln!("[test] cached entry: {summary:?}");
            drop(state);
        }

        let second_stream = stream_openai_codex_responses(
            &model,
            &codex_followup_context(&first, "Now finish"),
            Some(&options),
        );
        eprintln!("[test] turn 2 streaming");
        let events = second_stream.collect().await;
        eprintln!("[test] turn 2 collected {} events", events.len());
        let second = events
            .iter()
            .rev()
            .find_map(|event| match event {
                AssistantMessageEvent::Done { message, .. } => Some(message.clone()),
                AssistantMessageEvent::Error { error, .. } => Some(error.clone()),
                _ => None,
            })
            .expect("terminal event");
        assert_eq!(second.stop_reason, StopReason::Stop);
        assert_eq!(codex_message_text(&second).as_deref(), Some("Done"));
        assert_eq!(second.response_id.as_deref(), Some("resp_2"));
        // Exactly one start on the recovered attempt, and a final done.
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, AssistantMessageEvent::Start { .. }))
                .count(),
            1
        );
        assert!(matches!(
            events.last(),
            Some(AssistantMessageEvent::Done { .. })
        ));

        let bodies = server.sent_bodies.lock().expect("bodies").clone();
        eprintln!("[test] captured bodies: {bodies:?}");
        assert_eq!(bodies.len(), 3, "two requests + one retry: {bodies:?}");
        assert_eq!(
            bodies[1].get("previous_response_id"),
            Some(&json!("resp_1"))
        );
        assert!(
            bodies[2].get("previous_response_id").is_none(),
            "the retry sends the full context without the dead anchor: {bodies:?}"
        );
        // The metadata-supplied stale response id must not survive into
        // the surfaced message.
        assert_eq!(second.response_id.as_deref(), Some("resp_2"));
    }

    /// The second half of the TS #2374 fix: when the chain-reset retry also
    /// fails, the surfaced error carries no dead continuation anchor (the
    /// stale attempt's `response.created` id was cleared before retrying).
    #[tokio::test]
    async fn retry_failure_surfaces_no_stale_response_id() {
        let server = spawn_scripted_codex_server(vec![
            vec![
                codex_response_events("resp_1", "msg_1", "Hello"),
                vec![
                    json!({ "type": "response.created", "response": { "id": "resp_stale" } }),
                    codex_error_events(
                        "previous_response_not_found",
                        "Previous response with id 'resp_1' not found.",
                    )
                    .remove(0),
                ],
            ],
            vec![codex_error_events(
                "previous_response_not_found",
                "Previous response with id 'resp_9' not found.",
            )],
        ])
        .await;
        let model = codex_test_model(server.port);
        let session_id = format!("session-chain-reset-retry-fail-{}", std::process::id());
        let options = codex_test_options(&server, &session_id);
        let first =
            stream_openai_codex_responses(&model, &codex_test_context("Say hello"), Some(&options))
                .result()
                .await;
        assert_eq!(first.stop_reason, StopReason::Stop);

        let second = stream_openai_codex_responses(
            &model,
            &codex_followup_context(&first, "Now finish"),
            Some(&options),
        )
        .result()
        .await;
        eprintln!(
            "[test] turn 2 settled: stop={:?} error={:?} response_id={:?}",
            second.stop_reason, second.error_message, second.response_id
        );
        assert_eq!(second.stop_reason, StopReason::Error);
        assert_eq!(
            second.error_message.as_deref(),
            Some("Codex error: Previous response with id 'resp_9' not found.")
        );
        // The pre-fix bug kept the stale attempt's response id.
        assert!(
            second.response_id.is_none(),
            "the dead continuation anchor must not survive the surfaced error"
        );
        let bodies = server.sent_bodies.lock().expect("bodies").clone();
        assert_eq!(bodies.len(), 3, "two requests + one retry: {bodies:?}");
        assert!(
            bodies[2].get("previous_response_id").is_none(),
            "the retry sends the full context: {bodies:?}"
        );
    }
}
