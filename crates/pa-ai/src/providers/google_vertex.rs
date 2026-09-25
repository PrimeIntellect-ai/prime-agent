//! Google Vertex AI streaming provider.
//! Port of `packages/ai/src/providers/google-vertex.ts`: project/location
//! resolution, API-key or OAuth (ADC) authentication, the Vertex
//! `streamGenerateContent` endpoint, and the shared Google stream processor.

use serde_json::{json, Map, Value};

use crate::event_stream::{
    create_assistant_message_event_stream, AssistantMessageEvent, AssistantMessageEventStream,
    AssistantMessageEventWriter,
};
use crate::models::clamp_thinking_level;
use crate::providers::google::GoogleOptions;
use crate::providers::google_shared::{
    budget_effort, convert_messages, convert_tools, get_disabled_thinking_config,
    get_google_thinking_budget, get_thinking_level, API_GOOGLE_VERTEX,
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

pub const VERTEX_API_VERSION: &str = "v1";
const GCP_VERTEX_CREDENTIALS_MARKER: &str = "gcp-vertex-credentials";

/// Provider-native options (`GoogleVertexOptions` in the TS reference).
#[derive(Clone, Default)]
pub struct GoogleVertexOptions {
    pub base: StreamOptions,
    pub tool_choice: Option<crate::providers::google::GoogleToolChoice>,
    pub thinking: Option<crate::providers::google::GoogleThinking>,
    pub project: Option<String>,
    pub location: Option<String>,
}

impl GoogleVertexOptions {
    pub fn from_base(base: StreamOptions) -> Self {
        Self {
            base,
            tool_choice: None,
            thinking: None,
            project: None,
            location: None,
        }
    }
}

fn resolve_api_key(options: &GoogleVertexOptions) -> Option<String> {
    let api_key = options
        .base
        .api_key
        .clone()
        .or_else(|| std::env::var("GOOGLE_CLOUD_API_KEY").ok())
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty());
    api_key.filter(|key| {
        key != GCP_VERTEX_CREDENTIALS_MARKER && !(key.starts_with('<') && key.ends_with('>'))
    })
}

fn resolve_project(options: &GoogleVertexOptions) -> Result<String, String> {
    options
        .project
        .clone()
        .or_else(|| std::env::var("GOOGLE_CLOUD_PROJECT").ok())
        .or_else(|| std::env::var("GCLOUD_PROJECT").ok())
        .ok_or_else(|| {
            "Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options."
                .to_string()
        })
}

fn resolve_location(options: &GoogleVertexOptions) -> Result<String, String> {
    options
        .location
        .clone()
        .or_else(|| std::env::var("GOOGLE_CLOUD_LOCATION").ok())
        .ok_or_else(|| {
            "Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options."
                .to_string()
        })
}

/// Resolve an OAuth access token for Application Default Credentials.
///
/// The TS reference uses google-auth-library ADC. Here the token comes from an
/// explicit `GOOGLE_OAUTH_ACCESS_TOKEN` env var, or from the gcloud CLI's
/// credential source; failures surface as provider errors.
fn resolve_adc_access_token() -> Result<String, String> {
    if let Ok(token) = std::env::var("GOOGLE_OAUTH_ACCESS_TOKEN") {
        if !token.trim().is_empty() {
            return Ok(token.trim().to_string());
        }
    }
    let output = std::process::Command::new("gcloud")
        .args(["auth", "print-access-token"])
        .output()
        .map_err(|error| format!("Failed to run gcloud for ADC access token: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "gcloud auth print-access-token failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        return Err("gcloud returned an empty access token".to_string());
    }
    Ok(token)
}

fn resolve_custom_base_url(base_url: &str) -> Option<String> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() || trimmed.contains("{location}") {
        return None;
    }
    Some(trimmed.to_string())
}

fn base_url_includes_api_version(base_url: &str) -> bool {
    let path = url::Url::parse(base_url)
        .map_or_else(|_| base_url.to_string(), |url| url.path().to_string());
    path.split('/').any(|part| {
        let stripped = part.strip_prefix('v').unwrap_or("");
        !stripped.is_empty()
            && stripped
                .chars()
                .all(|c| c.is_ascii_digit() || c == 'b' || c == 'e')
    })
}

/// Port of `streamGoogleVertex`.
pub fn stream_google_vertex(
    model: &Model,
    context: &Context,
    options: Option<&GoogleVertexOptions>,
) -> AssistantMessageEventStream {
    let options = options.cloned();
    let model = model.clone();
    let context = context.clone();
    let (writer, reader) = create_assistant_message_event_stream();

    tokio::spawn(async move {
        let mut output = AssistantMessage {
            content: Vec::new(),
            api: API_GOOGLE_VERTEX.to_string(),
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

fn build_params(model: &Model, context: &Context, options: &GoogleVertexOptions) -> Value {
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
    options: Option<&GoogleVertexOptions>,
    output: &mut AssistantMessage,
    writer: &AssistantMessageEventWriter,
) -> Result<(), ProviderError> {
    let options = options.cloned().unwrap_or_default();

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

    // Endpoint: <base>/projects/<project>/locations/<location>/publishers/google/models/<model>:streamGenerateContent?alt=sse
    let custom_base = resolve_custom_base_url(&model.base_url);
    let url = if let Some(base) = &custom_base {
        if base_url_includes_api_version(base) {
            format!(
                "{}/models/{}:streamGenerateContent?alt=sse",
                base.trim_end_matches('/'),
                model.id
            )
        } else {
            format!(
                "{}/{VERTEX_API_VERSION}/models/{}:streamGenerateContent?alt=sse",
                base.trim_end_matches('/'),
                model.id
            )
        }
    } else {
        let project = resolve_project(&options).map_err(ProviderError::Message)?;
        let location = resolve_location(&options).map_err(ProviderError::Message)?;
        format!(
            "https://aiplatform.googleapis.com/{VERTEX_API_VERSION}/projects/{project}/locations/{location}/publishers/google/models/{}:streamGenerateContent?alt=sse",
            model.id
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
    let api_key = resolve_api_key(&options);
    if let Some(api_key) = api_key {
        headers.push(("x-goog-api-key".into(), api_key));
    } else {
        let token = resolve_adc_access_token().map_err(ProviderError::Message)?;
        headers.push(("Authorization".into(), format!("Bearer {token}")));
    }

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
        let chunk = match response.next_text().await? {
            Some(chunk) => chunk,
            None => break,
        };
        for sse in decoder.push_text(&chunk) {
            if sse.data.trim().is_empty() {
                continue;
            }
            let parsed = parse_json_with_repair(&sse.data).map_err(|error| {
                ProviderError::Message(format!("Could not parse Vertex SSE chunk: {error}"))
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
            ProviderError::Message(format!("Could not parse Vertex SSE chunk: {error}"))
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

/// Port of `streamSimpleGoogleVertex`.
pub fn stream_simple_google_vertex(
    model: &Model,
    context: &Context,
    options: Option<&SimpleStreamOptions>,
) -> AssistantMessageEventStream {
    let base = build_base_options(model, options, None);
    let reasoning = options.and_then(|options| options.reasoning);
    if reasoning.is_none() || reasoning == Some(ModelThinkingLevel::Off) {
        let stream_options = GoogleVertexOptions {
            base,
            thinking: Some(crate::providers::google::GoogleThinking {
                enabled: false,
                budget_tokens: None,
                level: None,
            }),
            tool_choice: None,
            project: None,
            location: None,
        };
        return stream_google_vertex(model, context, Some(&stream_options));
    }

    let clamped = reasoning.map(|reasoning| clamp_thinking_level(model, reasoning));
    let effort = clamped.unwrap_or(ModelThinkingLevel::High);

    if crate::providers::google_shared::is_gemini3_pro_model(&model.id)
        || crate::providers::google_shared::is_gemini3_flash_model(&model.id)
    {
        let stream_options = GoogleVertexOptions {
            base,
            thinking: Some(crate::providers::google::GoogleThinking {
                enabled: true,
                budget_tokens: None,
                level: Some(get_thinking_level(effort, &model.id)),
            }),
            tool_choice: None,
            project: None,
            location: None,
        };
        return stream_google_vertex(model, context, Some(&stream_options));
    }

    let budgets = options.and_then(|options| options.thinking_budgets.as_ref());
    let budget = get_google_thinking_budget(&model.id, budget_effort(effort), budgets);
    let stream_options = GoogleVertexOptions {
        base,
        thinking: Some(crate::providers::google::GoogleThinking {
            enabled: true,
            budget_tokens: Some(budget),
            level: None,
        }),
        tool_choice: None,
        project: None,
        location: None,
    };
    stream_google_vertex(model, context, Some(&stream_options))
}

/// Registry provider for the `google-vertex` API.
pub struct GoogleVertexProvider;

impl Provider for GoogleVertexProvider {
    fn api(&self) -> &str {
        API_GOOGLE_VERTEX
    }

    fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> AssistantMessageEventStream {
        let options = options.map(|base| GoogleVertexOptions::from_base(base.clone()));
        stream_google_vertex(model, context, options.as_ref())
    }

    fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> AssistantMessageEventStream {
        stream_simple_google_vertex(model, context, options)
    }
}

// The GoogleOptions type import is kept for callers composing native options.
#[allow(dead_code)]
fn _options_marker() -> Option<GoogleOptions> {
    None
}
