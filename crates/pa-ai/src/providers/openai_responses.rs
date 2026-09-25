//! `OpenAI` Responses API streaming provider.
//! Port of `packages/ai/src/providers/openai-responses.ts`: session-affinity
//! headers, prompt-cache retention, reasoning params with encrypted-content
//! include, service-tier pricing, and the shared Responses stream processor.

use serde_json::{json, Map, Value};

use crate::env_api_keys::get_env_api_key;
use crate::event_stream::{
    create_assistant_message_event_stream, AssistantMessageEvent, AssistantMessageEventStream,
    AssistantMessageEventWriter,
};
use crate::models::clamp_thinking_level;
use crate::providers::openai_responses_shared::{
    apply_service_tier_pricing, convert_responses_messages, convert_responses_tools,
    ConvertResponsesMessagesOptions, ConvertResponsesToolsOptions, ReasoningSummary,
    ResponsesStreamHooks, OPENAI_TOOL_CALL_PROVIDERS,
};
use crate::providers::simple_options::build_base_options;
use crate::registry::Provider;
use crate::types::{
    done_reason, error_reason, AssistantMessage, CacheRetention, Context, Model, ModelExt,
    ModelThinkingLevel, ServiceTier, SimpleStreamOptions, StopReason, StreamOptions, Usage,
};
use crate::utils_inner::diagnostics::now_ms;
use crate::utils_inner::http::{send, HttpResponse, RequestOptions};
use crate::utils_inner::json_parse::{parse_json_with_repair, parse_streaming_json};
use crate::utils_inner::sse::SseDecoder;
use crate::utils_inner::stream_failure::{
    format_stream_failure_message, record_stream_failure, stream_failure_from_stop_reason,
    ProviderError,
};

pub const API_OPENAI_RESPONSES: &str = "openai-responses";

fn resolve_cache_retention(cache_retention: Option<CacheRetention>) -> CacheRetention {
    if let Some(retention) = cache_retention {
        return retention;
    }
    if std::env::var("PI_CACHE_RETENTION").as_deref() == Ok("long") {
        return CacheRetention::Long;
    }
    CacheRetention::Short
}

/// Resolved compat (`Required<OpenAIResponsesCompat>`).
pub struct ResolvedResponsesCompat {
    pub send_session_id_header: bool,
    pub supports_long_cache_retention: bool,
}

pub fn get_responses_compat(model: &Model) -> ResolvedResponsesCompat {
    // TS reads the responses compat directly: the wire object cannot tag
    // its shape, and a shared-key-only object (the xAI subscription's
    // `supportsLongCacheRetention: false`) still decodes — every field is
    // optional and unknown keys are ignored, so the responses view of any
    // compat object is lossless for this API.
    let compat = model.compat.as_ref().and_then(|compat| {
        serde_json::from_value::<pa_types::ai::OpenAiResponsesCompat>(compat.raw.clone().into())
            .ok()
    });
    ResolvedResponsesCompat {
        send_session_id_header: compat
            .as_ref()
            .and_then(|c| c.send_session_id_header)
            .unwrap_or(true),
        supports_long_cache_retention: compat
            .as_ref()
            .and_then(|c| c.supports_long_cache_retention)
            .unwrap_or(true),
    }
}

fn get_prompt_cache_retention(
    compat: &ResolvedResponsesCompat,
    cache_retention: CacheRetention,
) -> Option<&'static str> {
    if cache_retention == CacheRetention::Long && compat.supports_long_cache_retention {
        Some("24h")
    } else {
        None
    }
}

/// Provider-native options (`OpenAIResponsesOptions` in the TS reference).
#[derive(Clone, Default)]
pub struct OpenAIResponsesOptions {
    pub base: StreamOptions,
    pub reasoning_effort: Option<ModelThinkingLevel>,
    pub reasoning_summary: Option<ReasoningSummary>,
    pub service_tier: Option<ServiceTier>,
}

impl OpenAIResponsesOptions {
    pub fn from_base(base: StreamOptions) -> Self {
        Self {
            base,
            reasoning_effort: None,
            reasoning_summary: None,
            service_tier: None,
        }
    }
}

/// Port of `streamOpenAIResponses`.
pub fn stream_openai_responses(
    model: &Model,
    context: &Context,
    options: Option<&OpenAIResponsesOptions>,
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

fn build_headers(
    model: &Model,
    api_key: &str,
    options: &OpenAIResponsesOptions,
    cache_session_id: Option<&str>,
) -> Vec<(String, String)> {
    let compat = get_responses_compat(model);
    let mut headers: Vec<(String, String)> = Vec::new();
    for (name, value) in model.headers.iter().flatten() {
        headers.push((name.clone(), value.clone()));
    }
    if let Some(cache_session_id) = cache_session_id {
        if compat.send_session_id_header {
            headers.push(("session_id".into(), cache_session_id.to_string()));
        }
        headers.push(("x-client-request-id".into(), cache_session_id.to_string()));
    }
    if let Some(options_headers) = &options.base.headers {
        for (name, value) in options_headers {
            headers.retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
            headers.push((name.clone(), value.clone()));
        }
    }
    headers.push(("Authorization".into(), format!("Bearer {api_key}")));
    headers
}

fn build_params(model: &Model, context: &Context, options: &OpenAIResponsesOptions) -> Value {
    let messages = convert_responses_messages(
        model,
        context,
        &OPENAI_TOOL_CALL_PROVIDERS,
        ConvertResponsesMessagesOptions::include_system_prompt(),
    );

    let cache_retention = resolve_cache_retention(options.base.cache_retention);
    let compat = get_responses_compat(model);
    let mut params = Map::new();
    params.insert("model".into(), json!(model.id));
    params.insert("input".into(), json!(messages));
    params.insert("stream".into(), json!(true));
    if cache_retention != CacheRetention::None {
        if let Some(session_id) = &options.base.session_id {
            params.insert("prompt_cache_key".into(), json!(session_id));
        }
    }
    if let Some(retention) = get_prompt_cache_retention(&compat, cache_retention) {
        params.insert("prompt_cache_retention".into(), json!(retention));
    }
    params.insert("store".into(), json!(false));

    if let Some(max_tokens) = options.base.max_tokens {
        params.insert("max_output_tokens".into(), json!(max_tokens));
    }
    if let Some(temperature) = options.base.temperature {
        params.insert("temperature".into(), json!(temperature));
    }
    // GitHub Copilot rejects the service_tier FIELD itself (400) for every value.
    if options.service_tier.is_some() && model.provider != "github-copilot" {
        params.insert(
            "service_tier".into(),
            serde_json::to_value(options.service_tier).unwrap_or(Value::Null),
        );
    }
    if let Some(tools) = &context.tools {
        if !tools.is_empty() {
            params.insert(
                "tools".into(),
                json!(convert_responses_tools(
                    tools,
                    ConvertResponsesToolsOptions { strict: None }
                )),
            );
        }
    }
    if model.reasoning {
        if options.reasoning_effort.is_some() || options.reasoning_summary.is_some() {
            let effort = match options.reasoning_effort {
                Some(effort) => model
                    .thinking_level_map_value(effort)
                    .and_then(Option::<&String>::cloned)
                    .unwrap_or_else(|| effort.wire_name().to_string()),
                None => "medium".to_string(),
            };
            let summary = options.reasoning_summary.map_or(
                "auto",
                super::openai_responses_hooks::ReasoningSummary::as_str,
            );
            params.insert(
                "reasoning".into(),
                json!({ "effort": effort, "summary": summary }),
            );
            params.insert("include".into(), json!(["reasoning.encrypted_content"]));
        } else if model.provider != "github-copilot" {
            let off_null = model
                .thinking_level_map_value(ModelThinkingLevel::Off)
                .is_some_and(|value| value.is_none());
            if !off_null {
                let off_value = model
                    .thinking_level_map_value(ModelThinkingLevel::Off)
                    .and_then(Option::<&String>::cloned)
                    .unwrap_or_else(|| "none".to_string());
                params.insert("reasoning".into(), json!({ "effort": off_value }));
            }
        }
        if model.provider == "xai" {
            params.insert("include".into(), json!(["reasoning.encrypted_content"]));
        }
    }

    Value::Object(params)
}

async fn run_stream(
    model: &Model,
    context: &Context,
    options: Option<&OpenAIResponsesOptions>,
    output: &mut AssistantMessage,
    writer: &AssistantMessageEventWriter,
) -> Result<(), ProviderError> {
    let options = options.cloned().unwrap_or_default();
    let api_key = options
        .base
        .api_key
        .clone()
        .or_else(|| get_env_api_key(&model.provider))
        .unwrap_or_default();
    let cache_retention = resolve_cache_retention(options.base.cache_retention);
    let cache_session_id = if cache_retention == CacheRetention::None {
        None
    } else {
        options.base.session_id.clone()
    };

    let mut params = build_params(model, context, &options);
    if let Some(on_payload) = &options.base.on_payload {
        if let Some(next) = on_payload(params.clone(), model) {
            params = next;
        }
    }

    let url = format!("{}/responses", model.base_url.trim_end_matches('/'));
    let headers = build_headers(model, &api_key, &options, cache_session_id.as_deref());
    let mut response: HttpResponse = send(RequestOptions {
        method: reqwest::Method::POST,
        url,
        headers,
        body: Some(params.to_string()),
        signal: options.base.signal.clone(),
        timeout_ms: options.base.timeout_ms,
        connection: crate::utils_inner::stream_failure::ConnectionErrorProfile::Sdk,
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
    let request_id = response.headers.get("x-request-id").cloned();

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

    let model_id = model.id.clone();
    let hooks = ResponsesStreamHooks {
        request_service_tier: options.service_tier,
        resolve_service_tier: None,
        apply_service_tier_pricing: Some(Box::new(move |usage, service_tier| {
            apply_service_tier_pricing(usage, service_tier.as_deref(), &model_id);
        })),
    };

    {
        let mut processor =
            crate::providers::openai_responses_shared::ResponsesStreamProcessor::new(
                model, output, writer, hooks,
            );
        let mut decoder = SseDecoder::new();
        loop {
            let chunk = match response.next_text().await? {
                Some(chunk) => chunk,
                None => break,
            };
            for sse in decoder.push_text(&chunk) {
                if sse.data.trim().is_empty() {
                    continue;
                }
                let event = match parse_json_with_repair(&sse.data) {
                    Ok(event) => event,
                    Err(_) => parse_streaming_json(Some(&sse.data)),
                };
                processor.handle_event(&event)?;
            }
        }
        for sse in decoder.finish() {
            if sse.data.trim().is_empty() {
                continue;
            }
            let event = match parse_json_with_repair(&sse.data) {
                Ok(event) => event,
                Err(_) => parse_streaming_json(Some(&sse.data)),
            };
            processor.handle_event(&event)?;
        }
        processor.finish()?;
    }

    if options
        .base
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

    Ok(())
}

/// Port of `streamSimpleOpenAIResponses`.
pub fn stream_simple_openai_responses(
    model: &Model,
    context: &Context,
    options: Option<&SimpleStreamOptions>,
) -> AssistantMessageEventStream {
    let api_key = options
        .and_then(|options| options.base.api_key.clone())
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
            rest: Default::default(),
        };
        writer.push(AssistantMessageEvent::Error {
            reason: crate::types::ErrorStopReason::Error,
            error: message.clone(),
        });
        writer.end(Some(message));
        return reader;
    };
    let base = build_base_options(model, options, Some(&api_key));
    let clamped_reasoning = options
        .and_then(|options| options.reasoning)
        .map(|reasoning| clamp_thinking_level(model, reasoning));
    let reasoning_effort = clamped_reasoning.filter(|level| *level != ModelThinkingLevel::Off);
    let stream_options = OpenAIResponsesOptions {
        base,
        reasoning_effort,
        reasoning_summary: None,
        service_tier: None,
    };
    stream_openai_responses(model, context, Some(&stream_options))
}

/// Registry provider for the `openai-responses` API.
pub struct OpenAIResponsesProvider;

impl Provider for OpenAIResponsesProvider {
    fn api(&self) -> &str {
        API_OPENAI_RESPONSES
    }

    fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> AssistantMessageEventStream {
        let options = options.map(|base| OpenAIResponsesOptions::from_base(base.clone()));
        stream_openai_responses(model, context, options.as_ref())
    }

    fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> AssistantMessageEventStream {
        stream_simple_openai_responses(model, context, options)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A responses-served model with a wire `compat` object (the whole
    /// model need not be responses-shaped for the compat resolution).
    fn compat_model(raw: serde_json::Value) -> Model {
        serde_json::from_value(serde_json::json!({
            "id": "m", "name": "m", "api": "openai-responses", "provider": "xai",
            "baseUrl": "https://api.x.ai/v1", "reasoning": true, "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1000, "maxTokens": 100,
            "compat": raw,
        }))
        .unwrap()
    }

    #[test]
    fn the_shared_key_only_compat_decodes_for_responses_models() {
        // TS `getXaiSubscriptionModel`'s compat carries only
        // `supportsLongCacheRetention: false`; the responses provider
        // reads the responses view directly (the wire object cannot tag
        // its shape).
        let model = compat_model(serde_json::json!({ "supportsLongCacheRetention": false }));
        let compat = get_responses_compat(&model);
        assert!(!compat.supports_long_cache_retention);
        assert!(
            compat.send_session_id_header,
            "the absent header flag defaults on"
        );
    }

    #[test]
    fn the_responses_shaped_compat_keeps_its_values() {
        let model = compat_model(
            serde_json::json!({ "sendSessionIdHeader": false, "supportsLongCacheRetention": true }),
        );
        let compat = get_responses_compat(&model);
        assert!(!compat.send_session_id_header);
        assert!(compat.supports_long_cache_retention);
        // Absent compat: both defaults on (TS's defaults).
        let plain = serde_json::from_value::<Model>(serde_json::json!({
            "id": "m", "name": "m", "api": "openai-responses", "provider": "openai",
            "baseUrl": "https://api.openai.com/v1", "reasoning": false, "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1000, "maxTokens": 100
        }))
        .unwrap();
        let compat = get_responses_compat(&plain);
        assert!(compat.send_session_id_header);
        assert!(compat.supports_long_cache_retention);
    }
}
