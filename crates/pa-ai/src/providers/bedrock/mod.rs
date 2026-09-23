//! Amazon Bedrock Converse Stream provider.
//!
//! Port of `packages/ai/src/providers/amazon-bedrock.ts` as a raw-HTTP
//! implementation: SigV4-signed `POST /model/{modelId}/converse-stream`,
//! binary `vnd.amazon.eventstream` response decoding (see [`eventstream`]),
//! message conversion and cache points (see [`convert`]), and credential /
//! region resolution (see [`auth`]). Supports bearer-token auth, SigV4 skip
//! for local gateways, Claude adaptive vs budget-based thinking, and
//! GovCloud-safe request fields.

use serde_json::{json, Value};

mod auth;
mod convert;
mod events;
mod eventstream;
mod goaway;
mod h2;

use crate::env_api_keys::get_env_api_key;
use crate::event_stream::{
    create_assistant_message_event_stream, AssistantMessageEvent, AssistantMessageEventStream,
    AssistantMessageEventWriter,
};
use crate::providers::bedrock::auth::{resolve_credentials, resolve_endpoint, sigv4_headers};
use crate::providers::bedrock::convert::{
    convert_messages, convert_tool_config, map_stop_reason, map_thinking_level_to_effort,
    supports_always_on_adaptive_thinking, BedrockToolChoice,
};
pub(crate) use crate::providers::bedrock::convert::{
    is_anthropic_claude_model, supports_adaptive_thinking,
};
use crate::providers::bedrock::events::{handle_event, BedrockStreamState};
use crate::providers::bedrock::eventstream::EventStreamDecoder;
use crate::providers::simple_options::{build_base_options, clamp_reasoning};
use crate::registry::Provider;
use crate::types::{
    done_reason, error_reason, AssistantMessage, CacheRetention, Context, Model,
    ModelThinkingLevel, SimpleStreamOptions, StopReason, StreamOptions, ThinkingBudgets, Usage,
};
use crate::utils_inner::diagnostics::now_ms;
use crate::utils_inner::http::{send, HttpResponse, RequestOptions};
use crate::utils_inner::stream_failure::{
    record_stream_failure, stream_failure_from_stop_reason, ConnectionErrorProfile, ProviderError,
    ProviderHttpError,
};

pub const API_BEDROCK_CONVERSE_STREAM: &str = "bedrock-converse-stream";

/// How Claude's thinking content is returned (`thinkingDisplay` in the TS).
#[allow(dead_code)] // full TS option surface; variants set by callers
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BedrockThinkingDisplay {
    Summarized,
    Omitted,
}

impl BedrockThinkingDisplay {
    fn as_str(self) -> &'static str {
        match self {
            BedrockThinkingDisplay::Summarized => "summarized",
            BedrockThinkingDisplay::Omitted => "omitted",
        }
    }
}

/// Provider-specific request options (`BedrockOptions` in the TS reference).
#[derive(Clone, Default)]
pub struct BedrockOptions {
    pub base: StreamOptions,
    pub region: Option<String>,
    pub profile: Option<String>,
    pub tool_choice: Option<BedrockToolChoice>,
    pub reasoning: Option<ModelThinkingLevel>,
    pub thinking_budgets: Option<ThinkingBudgets>,
    pub interleaved_thinking: Option<bool>,
    pub thinking_display: Option<BedrockThinkingDisplay>,
    /// Ordered (`BTreeMap`): the metadata serializes into the provider
    /// request body (`requestMetadata`), and unordered iteration would leak
    /// random key order into the bytes (the request body feeds the
    /// provider's cacheable prefix).
    pub request_metadata: Option<std::collections::BTreeMap<String, String>>,
    pub bearer_token: Option<String>,
}

impl BedrockOptions {
    pub fn from_base(base: StreamOptions) -> Self {
        Self {
            base,
            ..Default::default()
        }
    }
}

/// Human-readable prefixes for Bedrock SDK exception names (see the TS
/// comment: the downstream retry logic in agent-session matches patterns like
/// `server.?error`, so the legacy prefix format is preserved).
const BEDROCK_ERROR_PREFIXES: [(&str, &str); 5] = [
    ("InternalServerException", "Internal server error"),
    ("ModelStreamErrorException", "Model stream error"),
    ("ValidationException", "Validation error"),
    ("ThrottlingException", "Throttling error"),
    ("ServiceUnavailableException", "Service unavailable"),
];

pub(crate) fn bedrock_error_prefix(exception_name: &str) -> String {
    for (name, prefix) in BEDROCK_ERROR_PREFIXES {
        if name == exception_name {
            return prefix.to_string();
        }
    }
    exception_name.to_string()
}

/// Port of `formatBedrockError`'s composed form for an AWS SDK exception:
/// `{prefix}: {message}` with the human-readable prefix for known exception
/// names (`prefix` falls back to the raw SDK exception name).
pub(crate) fn bedrock_exception_message(exception_name: &str, message: &str) -> String {
    format!("{}: {}", bedrock_error_prefix(exception_name), message)
}

/// The endpoint's connection port (explicit, else the scheme default).
fn bedrock_endpoint_port(endpoint: &str) -> u16 {
    url::Url::parse(endpoint)
        .ok()
        .and_then(|url| url.port())
        .unwrap_or(443)
}

/// Port of the AWS SDK error deserialization for a non-2xx HTTP response:
/// the error name comes from the body `__type`/`code` (after the `#`
/// namespace separator, like the SDK's error-code parser) and the message
/// from the body `message` (defaulting to "UnknownError", like
/// `decorateServiceException`); unknown names fall through
/// `throwDefaultError`'s `parsedBody.code || errorCode || statusCode` chain.
/// The result is what `formatBedrockError` composes for it.
fn bedrock_http_error(
    status: u16,
    body: &str,
    headers: &std::collections::HashMap<String, String>,
) -> ProviderError {
    let parsed = serde_json::from_str::<serde_json::Value>(body).ok();
    let body_code = parsed
        .as_ref()
        .and_then(|parsed| {
            let code = parsed
                .get("code")
                .or_else(|| parsed.get("Code"))
                .and_then(serde_json::Value::as_str);
            let typed = parsed
                .get("__type")
                .or_else(|| parsed.get("errorType"))
                .and_then(serde_json::Value::as_str);
            code.or(typed)
        })
        .map(|raw| raw.rsplit('#').next().unwrap_or(raw).to_string());
    let header_code = headers
        .get("x-amzn-errortype")
        .map(|value| value.split(':').next().unwrap_or(value).to_string());
    // The generic fallback names the error by the raw status code text.
    let exception_name = body_code
        .or(header_code)
        .unwrap_or_else(|| status.to_string());
    let message = parsed
        .as_ref()
        .and_then(|parsed| parsed.get("message").or_else(|| parsed.get("Message")))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        // `decorateServiceException`: `message || Message || "UnknownError"`
        .unwrap_or_else(|| "UnknownError".to_string());
    ProviderError::Http(ProviderHttpError {
        message: bedrock_exception_message(&exception_name, &message),
        // AWS SDK exceptions carry no `.status` field for the TS classifier
        // (`$metadata.httpStatusCode` is not read).
        status: None,
        body: None,
        headers: Default::default(),
        request_id: None,
        sdk_name: Some(exception_name),
        retry_after_ms: None,
        provider_error_type: None,
    })
}

/// The opened bedrock response, whichever transport produced it: the reqwest
/// path (http1 handler, https ALPN) or the direct h2c prior-knowledge path
/// (the TS default cleartext transport).
enum BedrockResponse {
    Http(HttpResponse),
    H2(crate::providers::bedrock::h2::H2Response),
}

impl BedrockResponse {
    fn status(&self) -> u16 {
        match self {
            BedrockResponse::Http(response) => response.status,
            BedrockResponse::H2(response) => response.status,
        }
    }

    fn header(&self, name: &str) -> Option<String> {
        match self {
            BedrockResponse::Http(response) => response.headers.get(name).cloned(),
            BedrockResponse::H2(response) => response.headers.get(name).cloned(),
        }
    }

    fn headers(&self) -> std::collections::HashMap<String, String> {
        match self {
            BedrockResponse::Http(response) => response.headers.clone(),
            BedrockResponse::H2(response) => response.headers.clone(),
        }
    }

    async fn next_bytes(&mut self) -> Result<Option<Vec<u8>>, ProviderError> {
        match self {
            BedrockResponse::Http(response) => response.next_bytes().await,
            BedrockResponse::H2(response) => response.next_bytes().await,
        }
    }

    async fn read_all_text(&mut self) -> Result<String, ProviderError> {
        match self {
            BedrockResponse::Http(response) => response.read_all_text().await,
            BedrockResponse::H2(response) => response.read_all_text().await,
        }
    }
}

/// Port of the TS `AWS_BEDROCK_FORCE_HTTP1` request-handler switch.
fn bedrock_force_http1() -> bool {
    std::env::var("AWS_BEDROCK_FORCE_HTTP1").as_deref() == Ok("1")
}

/// Port of the TS proxy-env request-handler switch: any configured proxy
/// environment variable selects the node http1 handler with the proxy
/// agent (reqwest honors the proxy environment natively).
fn bedrock_proxy_configured() -> bool {
    [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
    ]
    .iter()
    .any(|key| {
        std::env::var(key)
            .map(|value| !value.is_empty())
            .unwrap_or(false)
    })
}

/// Port of `streamBedrock`.
pub fn stream_bedrock(
    model: &Model,
    context: &Context,
    options: Option<&BedrockOptions>,
) -> AssistantMessageEventStream {
    let options = options.cloned();
    let model = model.clone();
    let context = context.clone();
    let (writer, reader) = create_assistant_message_event_stream();

    tokio::spawn(async move {
        let mut output = AssistantMessage {
            content: Vec::new(),
            api: API_BEDROCK_CONVERSE_STREAM.to_string(),
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
                // TS surfaces `formatBedrockError(error)`: the SDK exception
                // name prefix form, not the classified stream-failure rewrite.
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

/// Port of `resolveCacheRetention`.
fn resolve_cache_retention(cache_retention: Option<CacheRetention>) -> CacheRetention {
    if let Some(retention) = cache_retention {
        return retention;
    }
    if std::env::var("PI_CACHE_RETENTION").as_deref() == Ok("long") {
        return CacheRetention::Long;
    }
    CacheRetention::Short
}

/// Port of `isGovCloudBedrockTarget`.
fn is_gov_cloud_bedrock_target(model: &Model, options: &BedrockOptions) -> bool {
    if options
        .region
        .as_deref()
        .map(|region| region.to_lowercase().starts_with("us-gov-"))
        .unwrap_or(false)
    {
        return true;
    }
    let model_id = model.id.to_lowercase();
    model_id.starts_with("us-gov.") || model_id.starts_with("arn:aws-us-gov:")
}

/// Port of `buildAdditionalModelRequestFields`.
fn build_additional_model_request_fields(model: &Model, options: &BedrockOptions) -> Option<Value> {
    let reasoning = options.reasoning?;
    if !model.reasoning {
        return None;
    }

    if is_anthropic_claude_model(model) {
        // GovCloud Bedrock currently rejects the Claude thinking.display field.
        // Omit it there until the GovCloud Converse schema catches up.
        let display = if is_gov_cloud_bedrock_target(model, options) {
            None
        } else {
            Some(
                options
                    .thinking_display
                    .unwrap_or(BedrockThinkingDisplay::Summarized)
                    .as_str(),
            )
        };
        let mut result = if supports_adaptive_thinking(&model.id, Some(&model.name)) {
            let mut thinking = Map::new();
            thinking.insert("type".into(), json!("adaptive"));
            if let Some(display) = display {
                thinking.insert("display".into(), json!(display));
            }
            json!({
                "thinking": Value::Object(thinking),
                "output_config": {
                    "effort": map_thinking_level_to_effort(model, reasoning),
                }
            })
        } else {
            const DEFAULT_BUDGETS: [(ModelThinkingLevel, u64); 6] = [
                (ModelThinkingLevel::Minimal, 1024),
                (ModelThinkingLevel::Low, 2048),
                (ModelThinkingLevel::Medium, 8192),
                (ModelThinkingLevel::High, 16384),
                // Budget-based Claude has no xhigh tier, clamp to high
                (ModelThinkingLevel::Xhigh, 16384),
                // Budget-based Claude has no max tier, clamp to high
                (ModelThinkingLevel::Max, 16384),
            ];
            // Custom budgets are keyed by the clamped level; xhigh/max
            // resolve through the `high` entry, matching the TS.
            let clamped_level = clamp_reasoning(reasoning);
            let custom_budget =
                options
                    .thinking_budgets
                    .as_ref()
                    .and_then(|budgets| match clamped_level {
                        ModelThinkingLevel::Minimal => budgets.minimal,
                        ModelThinkingLevel::Low => budgets.low,
                        ModelThinkingLevel::Medium => budgets.medium,
                        _ => budgets.high,
                    });
            let budget = custom_budget.or_else(|| {
                DEFAULT_BUDGETS
                    .iter()
                    .find(|(level, _)| *level == reasoning)
                    .map(|(_, budget)| *budget)
            });
            let mut thinking = Map::new();
            thinking.insert("type".into(), json!("enabled"));
            thinking.insert("budget_tokens".into(), json!(budget));
            if let Some(display) = display {
                thinking.insert("display".into(), json!(display));
            }
            json!({ "thinking": Value::Object(thinking) })
        };

        if !supports_adaptive_thinking(&model.id, Some(&model.name))
            && options.interleaved_thinking.unwrap_or(true)
        {
            result["anthropic_beta"] = json!(["interleaved-thinking-2025-05-14"]);
        }

        return Some(result);
    }

    None
}

use serde_json::Map;

/// Percent-encode the model id for the `/model/{modelId}/converse-stream`
/// path, matching the SDK's URI-component encoding of path labels.
fn encode_model_id(model_id: &str) -> String {
    let mut encoded = String::new();
    for byte in model_id.bytes() {
        let c = byte as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            encoded.push(c);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

async fn run_stream(
    model: &Model,
    context: &Context,
    options: Option<&BedrockOptions>,
    output: &mut AssistantMessage,
    writer: &AssistantMessageEventWriter,
) -> Result<(), ProviderError> {
    let options = options.cloned().unwrap_or_default();
    let _ = get_env_api_key(&model.provider); // Bedrock auth never uses provider env keys

    if options
        .base
        .signal
        .as_ref()
        .map(|signal| signal.is_cancelled())
        .unwrap_or(false)
    {
        return Err(ProviderError::Aborted);
    }

    let cache_retention = resolve_cache_retention(options.base.cache_retention);

    let mut inference_config = Map::new();
    if let Some(max_tokens) = options.base.max_tokens {
        inference_config.insert("maxTokens".into(), json!(max_tokens));
    }
    if let Some(temperature) = options.base.temperature {
        if !supports_always_on_adaptive_thinking(&model.id, Some(&model.name)) {
            inference_config.insert("temperature".into(), json!(temperature));
        }
    }

    let mut command_input = Map::new();
    command_input.insert("modelId".into(), json!(model.id));
    command_input.insert(
        "messages".into(),
        json!(convert_messages(context, model, cache_retention)),
    );
    if let Some(system) =
        build_system_prompt_blocks(context.system_prompt.as_deref(), model, cache_retention)
    {
        command_input.insert("system".into(), json!(system));
    }
    if !inference_config.is_empty() {
        command_input.insert("inferenceConfig".into(), Value::Object(inference_config));
    }
    if let Some(tool_config) =
        convert_tool_config(context.tools.as_deref(), options.tool_choice.as_ref())
    {
        command_input.insert("toolConfig".into(), tool_config);
    }
    if let Some(fields) = build_additional_model_request_fields(model, &options) {
        command_input.insert("additionalModelRequestFields".into(), fields);
    }
    if let Some(metadata) = &options.request_metadata {
        command_input.insert("requestMetadata".into(), json!(metadata));
    }

    let mut payload = Value::Object(command_input);
    if let Some(on_payload) = &options.base.on_payload {
        if let Some(next) = on_payload(payload.clone(), model) {
            payload = next;
        }
    }

    let (endpoint, region) = resolve_endpoint(model, &options);
    let path_and_query = format!("/model/{}/converse-stream", encode_model_id(&model.id));
    let host = url::Url::parse(&endpoint)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .ok_or_else(|| ProviderError::Message(format!("Invalid Bedrock endpoint: {endpoint}")))?;
    let url = format!("{endpoint}{path_and_query}");

    let mut headers: Vec<(String, String)> = vec![
        ("content-type".into(), "application/json".into()),
        ("accept".into(), "application/json".into()),
    ];
    if let Some((name, value)) = model.headers.iter().flatten().next() {
        let _ = (name, value);
    }

    // requestMetadata also travels as the X-Amzn-Bedrock-Request-Metadata header.
    let mut extra_signed_headers: Vec<(String, String)> = Vec::new();
    if let Some(metadata) = &options.request_metadata {
        extra_signed_headers.push((
            "x-amzn-bedrock-request-metadata".into(),
            serde_json::to_string(metadata).unwrap_or_default(),
        ));
    }

    // Bearer-token auth bypasses SigV4 entirely.
    let bearer_token = options
        .bearer_token
        .clone()
        .or_else(|| std::env::var("AWS_BEARER_TOKEN_BEDROCK").ok())
        .filter(|token| !token.is_empty());
    let use_bearer =
        bearer_token.is_some() && std::env::var("AWS_BEDROCK_SKIP_AUTH").as_deref() != Ok("1");

    if use_bearer {
        headers.push((
            "authorization".into(),
            format!("Bearer {}", bearer_token.expect("checked above")),
        ));
        for (name, value) in &extra_signed_headers {
            headers.push((name.clone(), value.clone()));
        }
    } else {
        let credentials = resolve_credentials(options.profile.as_deref()).ok_or_else(|| {
            ProviderError::Message("No AWS credentials available for Bedrock".to_string())
        })?;
        let (amz_date, authorization, security_token) = sigv4_headers(
            &crate::providers::bedrock::auth::SigV4Params {
                method: "POST",
                path_and_query: &path_and_query,
                host: &host,
                region: &region,
                service: "bedrock",
                body: payload.to_string().as_bytes(),
                extra_signed_headers: &extra_signed_headers,
            },
            &credentials,
        );
        headers.push(("x-amz-date".into(), amz_date));
        headers.push(("authorization".into(), authorization));
        if let Some(security_token) = security_token {
            headers.push(("x-amz-security-token".into(), security_token));
        }
        for (name, value) in &extra_signed_headers {
            headers.push((name.clone(), value.clone()));
        }
    }

    // The TS request-handler selection: NodeHttp2Handler (http2) by default,
    // NodeHttpHandler (http1) for AWS_BEDROCK_FORCE_HTTP1 or a proxy
    // environment. Cleartext endpoints speak h2c prior-knowledge HTTP/2
    // directly (bun's node:http2 surface); https endpoints negotiate h2 via
    // TLS ALPN through reqwest. The connection profile carries the endpoint
    // address so the failure texts name the target.
    let scheme = url::Url::parse(&url)
        .map(|parsed| parsed.scheme().to_string())
        .unwrap_or_default();
    let endpoint_port = bedrock_endpoint_port(&url);
    let transport = crate::providers::bedrock::h2::select_transport(
        &scheme,
        bedrock_force_http1(),
        bedrock_proxy_configured(),
    );
    let mut response: BedrockResponse = match transport {
        crate::providers::bedrock::h2::BedrockTransport::Http1Handler => BedrockResponse::Http(
            send(RequestOptions {
                method: reqwest::Method::POST,
                url,
                headers,
                body: Some(payload.to_string()),
                signal: options.base.signal.clone(),
                timeout_ms: options.base.timeout_ms,
                connection: ConnectionErrorProfile::AwsHttp1 {
                    host: host.clone(),
                    port: endpoint_port,
                },
                transport: crate::utils_inner::http::Transport::Http1,
            })
            .await?,
        ),
        crate::providers::bedrock::h2::BedrockTransport::H2TlsAlpn => BedrockResponse::Http(
            send(RequestOptions {
                method: reqwest::Method::POST,
                url,
                headers,
                body: Some(payload.to_string()),
                signal: options.base.signal.clone(),
                timeout_ms: options.base.timeout_ms,
                connection: ConnectionErrorProfile::AwsHttp2 {
                    host: host.clone(),
                    port: endpoint_port,
                },
                transport: crate::utils_inner::http::Transport::H2Alpn,
            })
            .await?,
        ),
        crate::providers::bedrock::h2::BedrockTransport::H2Cleartext => BedrockResponse::H2(
            crate::providers::bedrock::h2::send_h2(
                crate::providers::bedrock::h2::H2RequestOptions {
                    url,
                    headers,
                    body: payload.to_string().into_bytes(),
                    signal: options.base.signal.clone(),
                    timeout_ms: options.base.timeout_ms,
                    connection: ConnectionErrorProfile::AwsHttp2 {
                        host: host.clone(),
                        port: endpoint_port,
                    },
                },
            )
            .await?,
        ),
    };

    if let Some(on_response) = &options.base.on_response {
        on_response(
            crate::types::ProviderResponse {
                status: response.status(),
                // Collected into the ordered map: the hook payload can
                // serialize, and the HTTP header arrival order is not a
                // stable serialization order.
                headers: response.headers().into_iter().collect(),
            },
            model,
        );
    }

    if response.status() >= 400 {
        let body = response.read_all_text().await.unwrap_or_default();
        let status = response.status();
        let headers = response.headers();
        return Err(bedrock_http_error(status, &body, &headers));
    }

    let request_id = response
        .header("x-amzn-requestid")
        .or_else(|| response.header("x-amzn-request-id"));

    let mut state = BedrockStreamState::new();
    let mut decoder = EventStreamDecoder::new();
    let mut stream_error: Option<ProviderError> = None;
    loop {
        let chunk = match response.next_bytes().await? {
            Some(chunk) => chunk,
            None => break,
        };
        for message in decoder.push(&chunk) {
            match handle_event(&message, model, output, writer, &mut state, &request_id) {
                Ok(()) => {}
                Err(error) => {
                    stream_error = Some(error);
                    break;
                }
            }
        }
        if stream_error.is_some() {
            break;
        }
    }
    if let Some(error) = stream_error {
        return Err(error);
    }

    if options
        .base
        .signal
        .as_ref()
        .map(|signal| signal.is_cancelled())
        .unwrap_or(false)
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

use crate::providers::bedrock::convert::build_system_prompt as build_system_prompt_blocks;

/// Port of `streamSimpleBedrock`.
pub fn stream_simple_bedrock(
    model: &Model,
    context: &Context,
    options: Option<&SimpleStreamOptions>,
) -> AssistantMessageEventStream {
    let base = build_base_options(model, options, None);
    let reasoning = options.and_then(|options| options.reasoning);
    let thinking_budgets = options.and_then(|options| options.thinking_budgets.clone());

    if reasoning.is_none() || reasoning == Some(ModelThinkingLevel::Off) {
        return stream_bedrock(
            model,
            context,
            Some(&BedrockOptions {
                base,
                reasoning: None,
                ..Default::default()
            }),
        );
    }

    if is_anthropic_claude_model(model) {
        if supports_adaptive_thinking(&model.id, Some(&model.name)) {
            return stream_bedrock(
                model,
                context,
                Some(&BedrockOptions {
                    base,
                    reasoning,
                    thinking_budgets,
                    ..Default::default()
                }),
            );
        }

        let adjusted = match crate::providers::simple_options::adjust_max_tokens_for_thinking(
            base.max_tokens.unwrap_or(0),
            model.max_tokens,
            reasoning.expect("checked above"),
            thinking_budgets.as_ref(),
        ) {
            Ok(adjusted) => adjusted,
            Err(message) => {
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
                    error_message: Some(message),
                    timestamp: now_ms(),
                    rest: Default::default(),
                };
                writer.push(AssistantMessageEvent::Error {
                    reason: error_reason(StopReason::Error),
                    error: message.clone(),
                });
                writer.end(Some(message));
                return reader;
            }
        };

        let clamped_level = clamp_reasoning(reasoning.expect("checked above"));
        let mut budgets = thinking_budgets.clone().unwrap_or_default();
        match clamped_level {
            ModelThinkingLevel::Minimal => budgets.minimal = Some(adjusted.1),
            ModelThinkingLevel::Low => budgets.low = Some(adjusted.1),
            ModelThinkingLevel::Medium => budgets.medium = Some(adjusted.1),
            _ => budgets.high = Some(adjusted.1),
        }

        return stream_bedrock(
            model,
            context,
            Some(&BedrockOptions {
                base: StreamOptions {
                    max_tokens: Some(adjusted.0),
                    ..base
                },
                reasoning,
                thinking_budgets: Some(budgets),
                ..Default::default()
            }),
        );
    }

    stream_bedrock(
        model,
        context,
        Some(&BedrockOptions {
            base,
            reasoning,
            thinking_budgets,
            ..Default::default()
        }),
    )
}

/// Registry provider for the `bedrock-converse-stream` API.
pub struct BedrockConverseStreamProvider;

impl Provider for BedrockConverseStreamProvider {
    fn api(&self) -> &str {
        API_BEDROCK_CONVERSE_STREAM
    }

    fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> AssistantMessageEventStream {
        let options = options.map(|base| BedrockOptions::from_base(base.clone()));
        stream_bedrock(model, context, options.as_ref())
    }

    fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> AssistantMessageEventStream {
        stream_simple_bedrock(model, context, options)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::bedrock::auth::{
        get_standard_bedrock_endpoint_region, should_use_explicit_bedrock_endpoint,
    };

    /// The TS `formatBedrockError` shape for an HTTP-level failure: the AWS
    /// SDK exception name (from the body `__type` after the namespace) maps to
    /// a stable human-readable prefix; unknown names keep the raw name.
    #[test]
    fn bedrock_http_error_prefix_shape() {
        let error = bedrock_http_error(
            400,
            "{\"__type\":\"com.amazonaws.bedrock#ValidationException\",\"message\":\"model id is invalid\"}",
            &Default::default(),
        );
        assert_eq!(error.to_string(), "Validation error: model id is invalid");
        let info = crate::utils_inner::stream_failure::extract_stream_failure_info(&error);
        assert_eq!(
            info.provider_error_type.as_deref(),
            Some("ValidationException")
        );
        // AWS exceptions carry no HTTP status to the TS classifier.
        assert_eq!(info.status, None);
        assert_eq!(
            info.kind,
            crate::utils_inner::stream_failure::StreamFailureKind::Unknown
        );
        let diagnostic = crate::utils_inner::stream_failure::diagnostic_error_info(&error);
        assert_eq!(diagnostic.name.as_deref(), Some("ValidationException"));
    }

    /// Throttling exceptions keep their name as the classification key
    /// ("throttl" -> rate_limit), like the TS rethrown stream exception.
    #[test]
    fn bedrock_throttling_error_classifies() {
        let error = bedrock_http_error(
            429,
            "{\"__type\":\"ThrottlingException\",\"message\":\"too many\"}",
            &Default::default(),
        );
        assert_eq!(error.to_string(), "Throttling error: too many");
        let info = crate::utils_inner::stream_failure::extract_stream_failure_info(&error);
        assert_eq!(
            info.kind,
            crate::utils_inner::stream_failure::StreamFailureKind::RateLimit
        );
    }

    /// An unrecognized error body names the generic fallback by the raw
    /// status text (smithy `throwDefaultError`: `parsedBody.code ||
    /// errorCode || statusCode || "UnknownError"`), and a missing message
    /// defaults to "UnknownError" like `decorateServiceException`.
    #[test]
    fn bedrock_http_error_generic_fallback() {
        let error = bedrock_http_error(400, "{\"foo\":1}", &Default::default());
        assert_eq!(error.to_string(), "400: UnknownError");
    }

    /// Connection failures surface undici's raw `TypeError` message, like the
    /// TS raw-`fetch` path (the AWS SDK does not wrap them).
    /// The in-stream exception message composition (`{prefix}: {message}`).
    #[test]
    fn bedrock_exception_message_shape() {
        assert_eq!(
            bedrock_exception_message("ModelStreamErrorException", "stream died"),
            "Model stream error: stream died"
        );
        assert_eq!(
            bedrock_exception_message("SomeUnknownException", "boom"),
            "SomeUnknownException: boom"
        );
    }

    #[test]
    fn bedrock_connection_error_text() {
        let connect = ProviderError::Connection(
            crate::utils_inner::stream_failure::ProviderConnectionError {
                kind: crate::utils_inner::stream_failure::ConnectionErrorKind::Connect,
                profile: crate::utils_inner::stream_failure::ConnectionErrorProfile::AwsHttp1 {
                    host: "127.0.0.1".to_string(),
                    port: 1,
                },
                cause: "http2 connect error".to_string(),
            },
        );
        assert_eq!(connect.to_string(), "connect ECONNREFUSED 127.0.0.1:1");
    }

    #[test]
    fn parses_standard_endpoint_regions() {
        assert_eq!(
            get_standard_bedrock_endpoint_region("https://bedrock-runtime.us-west-2.amazonaws.com"),
            Some("us-west-2".to_string())
        );
        assert_eq!(
            get_standard_bedrock_endpoint_region(
                "https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com"
            ),
            Some("us-gov-west-1".to_string())
        );
        assert_eq!(
            get_standard_bedrock_endpoint_region("https://example.com"),
            None
        );
    }

    #[test]
    fn explicit_endpoint_rules() {
        assert!(should_use_explicit_bedrock_endpoint(
            "http://localhost:8000",
            None,
            false
        ));
        assert!(!should_use_explicit_bedrock_endpoint(
            "https://bedrock-runtime.us-west-2.amazonaws.com",
            Some("us-west-2"),
            false
        ));
    }

    #[test]
    fn normalizes_tool_call_ids() {
        use crate::providers::bedrock::convert::normalize_tool_call_id;
        assert_eq!(normalize_tool_call_id("toolu_01ABCdef"), "toolu_01ABCdef");
        assert_eq!(normalize_tool_call_id(&"a".repeat(80)).len(), 64);
    }

    #[test]
    fn maps_stop_reasons() {
        use crate::types::StopReason;
        assert_eq!(map_stop_reason(Some("end_turn")), StopReason::Stop);
        assert_eq!(map_stop_reason(Some("stop_sequence")), StopReason::Stop);
        assert_eq!(map_stop_reason(Some("max_tokens")), StopReason::Length);
        assert_eq!(map_stop_reason(Some("tool_use")), StopReason::ToolUse);
        assert_eq!(map_stop_reason(Some("other")), StopReason::Error);
        assert_eq!(map_stop_reason(None), StopReason::Error);
    }

    #[test]
    fn error_prefixes_match_ts() {
        assert_eq!(
            bedrock_error_prefix("ThrottlingException"),
            "Throttling error"
        );
        assert_eq!(bedrock_error_prefix("Unknown"), "Unknown");
    }

    #[test]
    fn gov_cloud_detection() {
        let model = test_model("arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/test");
        let options = BedrockOptions::default();
        assert!(is_gov_cloud_bedrock_target(&model, &options));

        let options = BedrockOptions {
            region: Some("us-gov-east-1".into()),
            ..Default::default()
        };
        assert!(is_gov_cloud_bedrock_target(
            &test_model("us.anthropic.claude"),
            &options
        ));
    }

    fn test_model(id: &str) -> Model {
        Model {
            id: id.into(),
            name: "claude".into(),
            api: API_BEDROCK_CONVERSE_STREAM.into(),
            provider: "amazon-bedrock".into(),
            base_url: String::new(),
            reasoning: true,
            thinking_level_map: None,
            input: vec![crate::types::ModelInput::Text],
            cost: crate::types::zero_model_cost(),
            context_window: 200_000,
            max_tokens: 8192,
            featured: None,
            headers: None,
            compat: None,
        }
    }
}
