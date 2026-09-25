//! Azure `OpenAI` Responses API streaming provider.
//! Port of `packages/ai/src/providers/azure-openai-responses.ts`: deployment
//! name resolution (options/env map), base-URL normalization with the
//! /openai/v1 path, api-version query parameter, and the shared Responses
//! stream processor.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::env_api_keys::get_env_api_key;
use crate::event_stream::{
    create_assistant_message_event_stream, AssistantMessageEvent, AssistantMessageEventStream,
    AssistantMessageEventWriter,
};
use crate::models::clamp_thinking_level;
use crate::providers::openai_responses_shared::{
    convert_responses_messages, convert_responses_tools, ConvertResponsesMessagesOptions,
    ConvertResponsesToolsOptions, ResponsesStreamHooks, AZURE_TOOL_CALL_PROVIDERS,
};
use crate::providers::simple_options::build_base_options;
use crate::registry::Provider;
use crate::types::{
    done_reason, error_reason, AssistantMessage, Context, Model, ModelExt, ModelThinkingLevel,
    SimpleStreamOptions, StopReason, StreamOptions, Usage,
};
use crate::utils_inner::diagnostics::now_ms;
use crate::utils_inner::http::{send, HttpResponse, RequestOptions};
use crate::utils_inner::json_parse::{parse_json_with_repair, parse_streaming_json};
use crate::utils_inner::sse::SseDecoder;
use crate::utils_inner::stream_failure::{
    format_stream_failure_message, record_stream_failure, stream_failure_from_stop_reason,
    ProviderError,
};

pub const API_AZURE_OPENAI_RESPONSES: &str = "azure-openai-responses";

const DEFAULT_AZURE_API_VERSION: &str = "v1";

fn parse_deployment_name_map(value: Option<&str>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(value) = value else {
        return map;
    };
    for entry in value.split(',') {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (model_id, deployment_name) = trimmed.split_once('=').unwrap_or(("", ""));
        if model_id.is_empty() || deployment_name.is_empty() {
            continue;
        }
        map.insert(
            model_id.trim().to_string(),
            deployment_name.trim().to_string(),
        );
    }
    map
}

fn resolve_deployment_name(model: &Model, options: Option<&AzureOpenAIResponsesOptions>) -> String {
    if let Some(deployment) = options.and_then(|options| options.azure_deployment_name.as_ref()) {
        return deployment.clone();
    }
    let mapped = parse_deployment_name_map(
        std::env::var("AZURE_OPENAI_DEPLOYMENT_NAME_MAP")
            .ok()
            .as_deref(),
    )
    .get(&model.id)
    .cloned();
    mapped.unwrap_or_else(|| model.id.clone())
}

/// Provider-native options (`AzureOpenAIResponsesOptions` in the TS reference).
#[derive(Clone, Default)]
pub struct AzureOpenAIResponsesOptions {
    pub base: StreamOptions,
    pub reasoning_effort: Option<ModelThinkingLevel>,
    pub reasoning_summary: Option<crate::providers::openai_responses_shared::ReasoningSummary>,
    pub azure_api_version: Option<String>,
    pub azure_resource_name: Option<String>,
    pub azure_base_url: Option<String>,
    pub azure_deployment_name: Option<String>,
}

impl AzureOpenAIResponsesOptions {
    pub fn from_base(base: StreamOptions) -> Self {
        Self {
            base,
            reasoning_effort: None,
            reasoning_summary: None,
            azure_api_version: None,
            azure_resource_name: None,
            azure_base_url: None,
            azure_deployment_name: None,
        }
    }
}

fn normalize_azure_base_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let url = url::Url::parse(trimmed)
        .map_err(|_| format!("Invalid Azure OpenAI base URL: {base_url}"))?;
    let host = url.host_str().unwrap_or_default();
    let is_azure_host =
        host.ends_with(".openai.azure.com") || host.ends_with(".cognitiveservices.azure.com");
    let normalized_path = url.path().trim_end_matches('/');

    // Ensure Azure hosts have /openai/v1 as base path so the deployment URL
    // resolves as <base>/deployments/<name>/responses?api-version=<v>.
    if is_azure_host && (normalized_path.is_empty() || normalized_path == "/openai") {
        let mut normalized = url.clone();
        normalized.set_path("/openai/v1");
        normalized.set_query(None);
        return Ok(normalized.to_string().trim_end_matches('/').to_string());
    }

    Ok(trimmed.to_string())
}

fn build_default_base_url(resource_name: &str) -> String {
    format!("https://{resource_name}.openai.azure.com/openai/v1")
}

fn resolve_azure_config(
    model: &Model,
    options: Option<&AzureOpenAIResponsesOptions>,
) -> Result<(String, String), String> {
    let api_version = options
        .and_then(|options| options.azure_api_version.clone())
        .or_else(|| std::env::var("AZURE_OPENAI_API_VERSION").ok())
        .unwrap_or_else(|| DEFAULT_AZURE_API_VERSION.to_string());

    let base_url = options
        .and_then(|options| options.azure_base_url.as_ref())
        .map(|url| url.trim().to_string())
        .or_else(|| {
            std::env::var("AZURE_OPENAI_BASE_URL")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        });
    let resource_name = options
        .and_then(|options| options.azure_resource_name.clone())
        .or_else(|| std::env::var("AZURE_OPENAI_RESOURCE_NAME").ok())
        .filter(|value| !value.is_empty());

    let mut resolved_base_url = base_url;
    if resolved_base_url.is_none() {
        if let Some(resource) = resource_name {
            resolved_base_url = Some(build_default_base_url(&resource));
        }
    }
    if resolved_base_url.is_none() && !model.base_url.is_empty() {
        resolved_base_url = Some(model.base_url.clone());
    }
    let Some(resolved_base_url) = resolved_base_url else {
        return Err(
            "Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl."
                .to_string(),
        );
    };

    Ok((normalize_azure_base_url(&resolved_base_url)?, api_version))
}

fn build_params(
    model: &Model,
    context: &Context,
    options: &AzureOpenAIResponsesOptions,
    deployment_name: &str,
) -> Value {
    let messages = convert_responses_messages(
        model,
        context,
        &AZURE_TOOL_CALL_PROVIDERS,
        ConvertResponsesMessagesOptions::include_system_prompt(),
    );
    let mut params = Map::new();
    params.insert("model".into(), json!(deployment_name));
    params.insert("input".into(), json!(messages));
    params.insert("stream".into(), json!(true));
    if let Some(session_id) = &options.base.session_id {
        params.insert("prompt_cache_key".into(), json!(session_id));
    }
    if let Some(max_tokens) = options.base.max_tokens {
        params.insert("max_output_tokens".into(), json!(max_tokens));
    }
    if let Some(temperature) = options.base.temperature {
        params.insert("temperature".into(), json!(temperature));
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
        } else {
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
    }
    Value::Object(params)
}

/// Port of `streamAzureOpenAIResponses`.
pub fn stream_azure_openai_responses(
    model: &Model,
    context: &Context,
    options: Option<&AzureOpenAIResponsesOptions>,
) -> AssistantMessageEventStream {
    let options = options.cloned();
    let model = model.clone();
    let context = context.clone();
    let (writer, reader) = create_assistant_message_event_stream();

    tokio::spawn(async move {
        let mut output = AssistantMessage {
            content: Vec::new(),
            api: API_AZURE_OPENAI_RESPONSES.to_string(),
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
    options: Option<&AzureOpenAIResponsesOptions>,
    output: &mut AssistantMessage,
    writer: &AssistantMessageEventWriter,
) -> Result<(), ProviderError> {
    let options = options.cloned().unwrap_or_default();
    let deployment_name = resolve_deployment_name(model, Some(&options));

    let api_key = options
        .base
        .api_key
        .clone()
        .or_else(|| get_env_api_key(&model.provider))
        .unwrap_or_default();
    let (base_url, api_version) =
        resolve_azure_config(model, Some(&options)).map_err(ProviderError::Message)?;

    let mut params = build_params(model, context, &options, &deployment_name);
    if let Some(on_payload) = &options.base.on_payload {
        if let Some(next) = on_payload(params.clone(), model) {
            params = next;
        }
    }

    let url = format!(
        "{}/deployments/{deployment_name}/responses?api-version={api_version}",
        base_url.trim_end_matches('/')
    );
    let mut headers: Vec<(String, String)> = Vec::new();
    for (name, value) in model.headers.iter().flatten() {
        headers.push((name.clone(), value.clone()));
    }
    if let Some(options_headers) = &options.base.headers {
        for (name, value) in options_headers {
            headers.retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
            headers.push((name.clone(), value.clone()));
        }
    }
    headers.push(("api-key".into(), api_key));

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

    {
        let hooks = ResponsesStreamHooks::default();
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

/// Port of `streamSimpleAzureOpenAIResponses`.
pub fn stream_simple_azure_openai_responses(
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
            api: API_AZURE_OPENAI_RESPONSES.to_string(),
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
    let stream_options = AzureOpenAIResponsesOptions {
        base,
        reasoning_effort,
        reasoning_summary: None,
        azure_api_version: None,
        azure_resource_name: None,
        azure_base_url: None,
        azure_deployment_name: None,
    };
    stream_azure_openai_responses(model, context, Some(&stream_options))
}

/// Registry provider for the `azure-openai-responses` API.
pub struct AzureOpenAIResponsesProvider;

impl Provider for AzureOpenAIResponsesProvider {
    fn api(&self) -> &str {
        API_AZURE_OPENAI_RESPONSES
    }

    fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> AssistantMessageEventStream {
        let options = options.map(|base| AzureOpenAIResponsesOptions::from_base(base.clone()));
        stream_azure_openai_responses(model, context, options.as_ref())
    }

    fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> AssistantMessageEventStream {
        stream_simple_azure_openai_responses(model, context, options)
    }
}
