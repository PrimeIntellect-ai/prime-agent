//! Google Generative AI (Gemini API) streaming provider.
//! Port of `packages/ai/src/providers/google.ts` (the `@google/genai` SDK): REST
//! `streamGenerateContent` SSE streaming, thinking config (levels for Gemini 3,
//! budgets for Gemini 2.5), tool config, and usage accounting.

use serde_json::{json, Map, Value};

use crate::env_api_keys::get_env_api_key;
use crate::event_stream::{
    create_assistant_message_event_stream, AssistantMessageEvent, AssistantMessageEventStream,
    AssistantMessageEventWriter,
};
use crate::models::clamp_thinking_level;
use crate::providers::google_shared::{
    budget_effort, convert_messages, convert_tools, get_disabled_thinking_config,
    get_google_thinking_budget, get_thinking_level, API_GOOGLE_GENERATIVE_AI,
};
use crate::providers::google_stream::GoogleStreamState;
use crate::providers::simple_options::build_base_options;
use crate::registry::Provider;
use crate::types::{
    done_reason, error_reason, AssistantMessage, Context, Model, ModelThinkingLevel,
    SimpleStreamOptions, StopReason, StreamOptions, Usage,
};
use crate::utils_inner::diagnostics::now_ms;
use crate::utils_inner::http::{send, HttpResponse, RequestOptions};
use crate::utils_inner::json_parse::parse_json_with_repair;
use crate::utils_inner::sanitize_unicode::sanitize_surrogates;
use crate::utils_inner::sse::SseDecoder;
use crate::utils_inner::stream_failure::{
    format_stream_failure_message, record_stream_failure, stream_failure_from_stop_reason,
    ProviderError,
};

/// Thinking configuration for the provider options.
#[derive(Clone, Debug, PartialEq)]
pub struct GoogleThinking {
    pub enabled: bool,
    /// -1 for dynamic, 0 to disable.
    pub budget_tokens: Option<i64>,
    pub level: Option<crate::providers::google_shared::GoogleThinkingLevel>,
}

/// Tool selection passed to the API.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)] // full TS option surface; variants set by callers
pub enum GoogleToolChoice {
    Auto,
    None,
    Any,
}

impl GoogleToolChoice {
    pub fn as_str(self) -> &'static str {
        match self {
            GoogleToolChoice::Auto => "auto",
            GoogleToolChoice::None => "none",
            GoogleToolChoice::Any => "any",
        }
    }
}

/// Provider-native options (`GoogleOptions` in the TS reference).
#[derive(Clone, Default)]
pub struct GoogleOptions {
    pub base: StreamOptions,
    pub tool_choice: Option<GoogleToolChoice>,
    pub thinking: Option<GoogleThinking>,
}

impl GoogleOptions {
    pub fn from_base(base: StreamOptions) -> Self {
        Self {
            base,
            tool_choice: None,
            thinking: None,
        }
    }
}

/// Port of `streamGoogle`.
pub fn stream_google(
    model: &Model,
    context: &Context,
    options: Option<&GoogleOptions>,
) -> AssistantMessageEventStream {
    let options = options.cloned();
    let model = model.clone();
    let context = context.clone();
    let (writer, reader) = create_assistant_message_event_stream();

    tokio::spawn(async move {
        let mut output = AssistantMessage {
            content: Vec::new(),
            api: API_GOOGLE_GENERATIVE_AI.to_string(),
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

fn build_params(model: &Model, context: &Context, options: &GoogleOptions) -> Value {
    let contents = convert_messages(model, context);

    let mut generation_config = Map::new();
    if let Some(temperature) = options.base.temperature {
        generation_config.insert("temperature".into(), json!(temperature));
    }
    if let Some(max_tokens) = options.base.max_tokens {
        generation_config.insert("maxOutputTokens".into(), json!(max_tokens));
    }

    if let Some(thinking) = &options.thinking {
        if thinking.enabled && model.reasoning {
            let mut thinking_config = Map::new();
            thinking_config.insert("includeThoughts".into(), json!(true));
            if let Some(level) = thinking.level {
                thinking_config.insert("thinkingLevel".into(), json!(level.as_str()));
            } else if let Some(budget) = thinking.budget_tokens {
                thinking_config.insert("thinkingBudget".into(), json!(budget));
            }
            generation_config.insert("thinkingConfig".into(), Value::Object(thinking_config));
        } else if model.reasoning && !thinking.enabled {
            generation_config.insert(
                "thinkingConfig".into(),
                get_disabled_thinking_config(&model.id),
            );
        }
    }

    let mut body = Map::new();
    body.insert("contents".into(), json!(contents));
    if !generation_config.is_empty() {
        body.insert("generationConfig".into(), Value::Object(generation_config));
    }
    if let Some(system_prompt) = &context.system_prompt {
        body.insert(
            "systemInstruction".into(),
            json!(sanitize_surrogates(system_prompt)),
        );
    }
    if let Some(tools) = &context.tools {
        if !tools.is_empty() {
            if let Some(converted) = convert_tools(tools, false) {
                body.insert("tools".into(), json!(converted));
            }
        }
    }
    if context
        .tools
        .as_ref()
        .is_some_and(|tools| !tools.is_empty())
    {
        if let Some(tool_choice) = options.tool_choice {
            body.insert(
                "toolConfig".into(),
                json!({
                    "functionCallingConfig": {
                        "mode": crate::providers::google_shared::map_tool_choice(tool_choice.as_str()),
                    },
                }),
            );
        }
    }

    Value::Object(body)
}

async fn run_stream(
    model: &Model,
    context: &Context,
    options: Option<&GoogleOptions>,
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

    if options
        .base
        .signal
        .as_ref()
        .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
    {
        return Err(ProviderError::Aborted);
    }

    let mut params = build_params(model, context, &options);
    if let Some(on_payload) = &options.base.on_payload {
        if let Some(next) = on_payload(params.clone(), model) {
            params = next;
        }
    }

    // @google/genai default: https://generativelanguage.googleapis.com with
    // the v1beta version path; a model baseUrl replaces both.
    let (base_url, api_version) = if model.base_url.is_empty() {
        (
            "https://generativelanguage.googleapis.com".to_string(),
            "v1beta".to_string(),
        )
    } else {
        (
            model.base_url.trim_end_matches('/').to_string(),
            String::new(),
        )
    };
    let url = if api_version.is_empty() {
        format!(
            "{}/models/{}:streamGenerateContent?alt=sse",
            base_url, model.id
        )
    } else {
        format!(
            "{}/{api_version}/models/{}:streamGenerateContent?alt=sse",
            base_url, model.id
        )
    };

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
    if model.provider == "opencode" || model.provider == "opencode-go" {
        if let Some(session_id) = &options.base.session_id {
            headers.push(("session_id".into(), session_id.clone()));
        }
    }
    headers.push(("x-goog-api-key".into(), api_key));

    let mut response: HttpResponse = send(RequestOptions {
        method: reqwest::Method::POST,
        url,
        headers,
        body: Some(params.to_string()),
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
        let body = response.read_all_text().await.unwrap_or_default();
        // The genai `ApiError` carries no `.error` object for the TS
        // classifier (its `code` is numeric): the class name is the
        // provider error type and the classified form carries no detail.
        let mut error =
            ProviderError::from_http_status_body(response.status, &body, response.headers.clone());
        if let ProviderError::Http(http) = &mut error {
            http.sdk_name = Some("ApiError".to_string());
            http.body = None;
            http.request_id = None;
        }
        return Err(error);
    }

    writer.push(AssistantMessageEvent::Start {
        partial: output.clone(),
    });

    let mut state = GoogleStreamState::new();
    let mut decoder = SseDecoder::new();
    loop {
        let Some(chunk) = response.next_text().await? else {
            break;
        };
        for sse in decoder.push_text(&chunk) {
            if sse.data.trim().is_empty() {
                continue;
            }
            let parsed = parse_json_with_repair(&sse.data).map_err(|error| {
                ProviderError::Message(format!("Could not parse Gemini SSE chunk: {error}"))
            })?;
            state
                .handle_chunk(&parsed, model, output, writer)
                .map_err(ProviderError::Message)?;
        }
    }
    for sse in decoder.finish() {
        if sse.data.trim().is_empty() {
            continue;
        }
        let parsed = parse_json_with_repair(&sse.data).map_err(|error| {
            ProviderError::Message(format!("Could not parse Gemini SSE chunk: {error}"))
        })?;
        state
            .handle_chunk(&parsed, model, output, writer)
            .map_err(ProviderError::Message)?;
    }
    state.finish(output, writer);

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
            stream_failure_from_stop_reason(output.stop_reason_raw.as_deref(), None),
        ));
    }

    Ok(())
}

/// Port of `streamSimpleGoogle`.
pub fn stream_simple_google(
    model: &Model,
    context: &Context,
    options: Option<&SimpleStreamOptions>,
) -> AssistantMessageEventStream {
    let api_key = options
        .and_then(|options| options.base.api_key.clone())
        .or_else(|| get_env_api_key(&model.provider));
    let base = match api_key {
        Some(api_key) => build_base_options(model, options, Some(&api_key)),
        None => build_base_options(model, options, None),
    };
    let reasoning = options.and_then(|options| options.reasoning);
    if reasoning.is_none() || reasoning == Some(ModelThinkingLevel::Off) {
        let stream_options = GoogleOptions {
            base,
            tool_choice: None,
            thinking: Some(GoogleThinking {
                enabled: false,
                budget_tokens: None,
                level: None,
            }),
        };
        return stream_google(model, context, Some(&stream_options));
    }

    let clamped = reasoning.map(|reasoning| clamp_thinking_level(model, reasoning));
    let effort = clamped.unwrap_or(ModelThinkingLevel::High);

    if crate::providers::google_shared::is_gemini3_pro_model(&model.id)
        || crate::providers::google_shared::is_gemini3_flash_model(&model.id)
        || crate::providers::google_shared::is_gemma4_model(&model.id)
    {
        let stream_options = GoogleOptions {
            base,
            tool_choice: None,
            thinking: Some(GoogleThinking {
                enabled: true,
                budget_tokens: None,
                level: Some(get_thinking_level(effort, &model.id)),
            }),
        };
        return stream_google(model, context, Some(&stream_options));
    }

    let budgets = options.and_then(|options| options.thinking_budgets.as_ref());
    let budget = get_google_thinking_budget(&model.id, budget_effort(effort), budgets);
    let stream_options = GoogleOptions {
        base,
        tool_choice: None,
        thinking: Some(GoogleThinking {
            enabled: true,
            budget_tokens: Some(budget),
            level: None,
        }),
    };
    stream_google(model, context, Some(&stream_options))
}

/// Registry provider for the `google-generative-ai` API.
pub struct GoogleGenerativeAiProvider;

impl Provider for GoogleGenerativeAiProvider {
    fn api(&self) -> &str {
        API_GOOGLE_GENERATIVE_AI
    }

    fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> AssistantMessageEventStream {
        let options = options.map(|base| GoogleOptions::from_base(base.clone()));
        stream_google(model, context, options.as_ref())
    }

    fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> AssistantMessageEventStream {
        stream_simple_google(model, context, options)
    }
}
