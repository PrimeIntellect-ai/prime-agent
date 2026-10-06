//! Shared classification and reporting for provider stream failures, so no
//! provider collapses a specific cause (refusal, safety filter, overload, ...)
//! into a generic string before it is logged and persisted.

use std::fmt::Write as _;

use serde::Serialize;
use serde_json::Map;

use crate::types::AssistantMessage;
use crate::utils::diagnostics::{
    append_assistant_message_diagnostic, create_assistant_message_diagnostic, now_ms,
    DiagnosticErrorInfo,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamFailureKind {
    Refusal,
    Safety,
    /// A payment/balance rejection (HTTP 402), deterministic by status (credits do not refill
    /// inside a retry ladder).
    PaymentRequired,
    Overloaded,
    RateLimit,
    ServerError,
    Auth,
    Permission,
    InvalidRequest,
    MalformedResponse,
    /// The provider ended the response stream without its terminal marker:
    /// mid-block, no stop signal, no error frame (the connection just
    /// ends). Transient by nature — the same request can be re-issued.
    StreamDrop,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StreamFailureInfo {
    pub kind: StreamFailureKind,
    /// Provider's own error/stop identifier, e.g. "`overloaded_error`" or "SAFETY".
    #[serde(
        rename = "providerErrorType",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub provider_error_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(rename = "requestId", default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// Server-requested wait before retrying (Retry-After header or reset info), in milliseconds.
    #[serde(
        rename = "retryAfterMs",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub retry_after_ms: Option<u64>,
    /// Truncated raw provider payload for post-mortems.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
}

impl StreamFailureInfo {
    #[must_use]
    pub fn unknown() -> Self {
        Self {
            kind: StreamFailureKind::Unknown,
            provider_error_type: None,
            status: None,
            request_id: None,
            retry_after_ms: None,
            raw: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StreamFailureError {
    pub message: String,
    pub info: StreamFailureInfo,
}

impl std::fmt::Display for StreamFailureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for StreamFailureError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionErrorKind {
    /// The transport could not be established (refused, unreachable, DNS).
    Connect,
    Timeout,
    /// The peer closed or reset the connection before a response arrived. For the AWS http1 handler
    /// surface this is node's `read ECONNRESET`.
    Reset,
    /// An http2-level failure before any response arrived (bedrock's default transport): the
    /// `H2Failure` text without the deserialization hint.
    H2Request(H2Failure),
    /// An http2-level failure inside a received response body (bedrock's default transport): the
    /// AWS SDK's event-stream reader fails, so the message carries its deserialization hint.
    H2MidStream(H2Failure),
}

/// The http2 transport failure detail, with the byte-exact user-facing text the TS bedrock client
/// surfaces (bun's node:http2 behind the AWS SDK's `NodeHttp2Handler`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum H2Failure {
    /// A `RST_STREAM` received from the peer.
    StreamReset { nghttp2_code: String },
    /// A GOAWAY received from the peer.
    SessionClosed { code: u32 },
    /// A stream/socket failure: peer reset or closed mid-stream.
    Canceled,
    /// Any other http2 protocol violation (e.g. an HTTP/1.1 answer at a prior-knowledge h2 peer).
    Protocol,
}

/// Connection-error shapes per provider family: each family surfaces a fixed text and records a
/// fixed diagnostic `error.name` / `err.code` (TS-binary verified).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionErrorProfile {
    /// The openai/anthropic SDK family (openai-completions, openai-responses, azure, anthropic): a
    /// plain `Error` name with no error code.
    Sdk,
    /// Raw `fetch` providers (openai-codex-responses, google): the runtime's own error text.
    RawFetch,
    /// The mistral SDK's `UnexpectedClientError` wrapper shape.
    MistralSdk,
    /// The AWS node/http1 handler: the TS `AWS_BEDROCK_FORCE_HTTP1` surface (and the proxy-env
    /// handler mode).
    AwsHttp1 { host: String, port: u16 },
    /// The AWS `NodeHttp2Handler` surface — the TS default bedrock transport (h2c prior knowledge
    /// over cleartext), TS-binary verified.
    AwsHttp2 { host: String, port: u16 },
}

/// The AWS SDK's deserialization hint the TS binary appends to failures inside a received response
/// body.
pub const AWS_DESERIALIZATION_HINT: &str =
    "\n  Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object.";

/// The base failure text of an http2 transport failure (without the deserialization hint).
#[must_use]
pub fn h2_failure_text(failure: &H2Failure) -> String {
    match failure {
        H2Failure::StreamReset { nghttp2_code } => {
            format!("Stream closed with error code {nghttp2_code}")
        }
        H2Failure::SessionClosed { code } => format!("Session closed with error code {code}"),
        H2Failure::Canceled => "The pending stream has been canceled".to_string(),
        H2Failure::Protocol => "Protocol error".to_string(),
    }
}

/// The user-facing failure text, with the AWS SDK deserialization hint for mid-body failures.
#[must_use]
pub fn h2_failure_message(failure: &H2Failure, mid_stream: bool) -> String {
    let mut message = h2_failure_text(failure);
    if mid_stream {
        message.push_str(AWS_DESERIALIZATION_HINT);
    }
    message
}

/// Errors raised by provider HTTP/SSE plumbing, carrying the raw pieces the TS reference extracts
/// from provider SDK exceptions.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderHttpError {
    pub message: String,
    pub status: Option<u16>,
    pub body: Option<String>,
    pub headers: std::collections::HashMap<String, String>,
    pub request_id: Option<String>,
    /// The TS SDK error class name recorded in the `provider_stream_failure` diagnostic (e.g.
    /// "`BadRequestError`").
    pub sdk_name: Option<String>,
    /// Server-requested wait already resolved by the provider (Retry-After header, `resets_at`
    /// body); overrides header re-parsing.
    pub retry_after_ms: Option<u64>,
    /// The provider error's own wire `code`, which the classification prefers over the class name
    /// when the body carries no error type.
    pub provider_error_type: Option<String>,
}

impl std::fmt::Display for ProviderHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProviderHttpError {}

/// A connection-level transport failure. `Display` is the fixed per-family user-facing text the TS
/// binary surfaces; the raw `cause` is kept for logging.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderConnectionError {
    pub kind: ConnectionErrorKind,
    pub profile: ConnectionErrorProfile,
    pub cause: String,
}

/// The runtime's refused-connect message the TS binary (bun `fetch`) surfaces verbatim on the
/// raw-`fetch` providers (codex, google).
pub const RUNTIME_CONNECT_REFUSED_MESSAGE: &str =
    "Unable to connect. Is the computer able to access the url?";

impl ProviderConnectionError {
    /// The user-facing text the TS binary surfaces for this failure.
    #[must_use]
    pub fn message(&self) -> String {
        // A peer reset before the response carries the same fixed text as the connect failure for
        // the raw-fetch/SDK families; reset-vs-refused is only distinguishable on the AWS handler
        // surfaces.
        match (&self.profile, &self.kind) {
            (
                ConnectionErrorProfile::Sdk,
                ConnectionErrorKind::Connect
                | ConnectionErrorKind::Reset
                | ConnectionErrorKind::H2Request(_)
                | ConnectionErrorKind::H2MidStream(_),
            ) => "Connection error.".to_string(),
            (
                ConnectionErrorProfile::Sdk | ConnectionErrorProfile::AwsHttp1 { .. },
                ConnectionErrorKind::Timeout,
            ) => "Request timed out.".to_string(),
            // Raw `fetch` (bun) and the mistral `RequestTimeoutError` append the raw cause to a
            // fixed timeout prefix.
            (
                ConnectionErrorProfile::RawFetch,
                ConnectionErrorKind::Connect
                | ConnectionErrorKind::Reset
                | ConnectionErrorKind::H2Request(_)
                | ConnectionErrorKind::H2MidStream(_),
            ) => RUNTIME_CONNECT_REFUSED_MESSAGE.to_string(),
            (
                ConnectionErrorProfile::RawFetch | ConnectionErrorProfile::MistralSdk,
                ConnectionErrorKind::Timeout,
            ) => {
                format!("Request timed out: {}", self.cause)
            }
            (
                ConnectionErrorProfile::MistralSdk,
                ConnectionErrorKind::Connect
                | ConnectionErrorKind::Reset
                | ConnectionErrorKind::H2Request(_)
                | ConnectionErrorKind::H2MidStream(_),
            ) => format!(
                "Unexpected HTTP client error: TypeError: {RUNTIME_CONNECT_REFUSED_MESSAGE}"
            ),
            (ConnectionErrorProfile::AwsHttp1 { host, port }, ConnectionErrorKind::Connect) => {
                format!("connect ECONNREFUSED {host}:{port}")
            }
            (ConnectionErrorProfile::AwsHttp1 { .. }, ConnectionErrorKind::Reset) => {
                "read ECONNRESET".to_string()
            }
            (
                ConnectionErrorProfile::AwsHttp1 { .. },
                ConnectionErrorKind::H2Request(_) | ConnectionErrorKind::H2MidStream(_),
            ) => "read ECONNRESET".to_string(),
            (ConnectionErrorProfile::AwsHttp2 { host, port }, ConnectionErrorKind::Connect) => {
                // The refused connect surfaces as a canceled pending stream with the node-style
                // connect cause embedded.
                format!(
                    "The pending stream has been canceled (caused by: connect ECONNREFUSED {host}:{port})"
                )
            }
            (ConnectionErrorProfile::AwsHttp2 { .. }, ConnectionErrorKind::Timeout) => {
                // No TS ground truth: the TS client configures no transport timeout
                // (NodeHttp2Handler without requestTimeout).
                "Request timed out.".to_string()
            }
            (ConnectionErrorProfile::AwsHttp2 { .. }, ConnectionErrorKind::Reset) => {
                // A pre-response non-connect failure at a cleartext prior- knowledge h2 peer
                // (HTTP/1.1 answer): bun's protocol error.
                "Protocol error".to_string()
            }
            (ConnectionErrorProfile::AwsHttp2 { .. }, ConnectionErrorKind::H2Request(failure)) => {
                h2_failure_message(failure, false)
            }
            (
                ConnectionErrorProfile::AwsHttp2 { .. },
                ConnectionErrorKind::H2MidStream(failure),
            ) => h2_failure_message(failure, true),
        }
    }

    /// The TS runtime/SDK error class name recorded in the `provider_stream_failure` diagnostic.
    #[must_use]
    pub fn error_name(&self) -> &'static str {
        if matches!(self.profile, ConnectionErrorProfile::RawFetch) {
            return "TypeError";
        }
        if matches!(self.profile, ConnectionErrorProfile::MistralSdk) {
            return "UnexpectedClientError";
        }
        // bun records the http1 pre-response reset as a TimeoutError (TS-binary verified); every
        // other AWS handler failure is a plain Error.
        if matches!(self.profile, ConnectionErrorProfile::AwsHttp1 { .. })
            && matches!(self.kind, ConnectionErrorKind::Reset)
        {
            return "TimeoutError";
        }
        "Error"
    }

    /// The TS `err.code` the classification uses as the provider error type; the openai/anthropic
    /// SDK family records none.
    #[must_use]
    pub fn error_code(&self) -> Option<&'static str> {
        match (&self.profile, &self.kind) {
            (ConnectionErrorProfile::RawFetch, _) => Some("ConnectionRefused"),
            (ConnectionErrorProfile::MistralSdk, _) => Some("UnexpectedClientError"),
            (ConnectionErrorProfile::AwsHttp1 { .. }, ConnectionErrorKind::Connect) => {
                Some("ECONNREFUSED")
            }
            (ConnectionErrorProfile::AwsHttp1 { .. }, ConnectionErrorKind::Reset) => {
                Some("ECONNRESET")
            }
            // The TS client configures no AWS transport timeout, so there is no ground-truth code;
            // the classification records none.
            (ConnectionErrorProfile::Sdk, _)
            | (
                ConnectionErrorProfile::AwsHttp1 { .. },
                ConnectionErrorKind::Timeout
                | ConnectionErrorKind::H2Request(_)
                | ConnectionErrorKind::H2MidStream(_),
            )
            | (ConnectionErrorProfile::AwsHttp2 { .. }, ConnectionErrorKind::Timeout) => None,
            (ConnectionErrorProfile::AwsHttp2 { .. }, ConnectionErrorKind::Connect) => {
                Some("ERR_HTTP2_STREAM_CANCEL")
            }
            (ConnectionErrorProfile::AwsHttp2 { .. }, ConnectionErrorKind::Reset) => {
                Some("ERR_HTTP2_ERROR")
            }
            (
                ConnectionErrorProfile::AwsHttp2 { .. },
                ConnectionErrorKind::H2Request(ref failure)
                | ConnectionErrorKind::H2MidStream(ref failure),
            ) => match failure {
                H2Failure::StreamReset { .. } => Some("ERR_HTTP2_STREAM_ERROR"),
                H2Failure::SessionClosed { .. } => Some("ERR_HTTP2_SESSION_ERROR"),
                H2Failure::Canceled => Some("ERR_HTTP2_STREAM_CANCEL"),
                H2Failure::Protocol => Some("ERR_HTTP2_ERROR"),
            },
        }
    }
}

/// A WebSocket transport failure thrown out of a provider stream (the codex WS path): `Display` is
/// the raw runtime text, verbatim like the TS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderWsTransportError {
    pub message: String,
    pub close_code: Option<u16>,
}

impl ProviderWsTransportError {
    /// The runtime WS error class name recorded in the diagnostic; the close code decides it.
    #[must_use]
    pub fn error_name(&self) -> &'static str {
        match self.close_code {
            Some(_) => "WebSocketCloseError",
            None => "Error",
        }
    }
}

impl std::fmt::Display for ProviderWsTransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProviderWsTransportError {}

/// Unified provider error used across the crate.
#[derive(Debug, Clone, PartialEq)]
pub enum ProviderError {
    StreamFailure(StreamFailureError),
    Http(ProviderHttpError),
    Connection(ProviderConnectionError),
    /// WebSocket transport failure (codex WS path).
    Transport(ProviderWsTransportError),
    /// Plain error message; classified from its text.
    Message(String),
    Aborted,
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderError::StreamFailure(e) => write!(f, "{}", e.message),
            ProviderError::Http(e) => write!(f, "{}", e.message),
            ProviderError::Connection(e) => f.write_str(&e.message()),
            ProviderError::Transport(e) => f.write_str(&e.message),
            ProviderError::Message(m) => f.write_str(m),
            ProviderError::Aborted => f.write_str("Request was aborted"),
        }
    }
}

impl std::error::Error for ProviderError {}

impl ProviderError {
    /// Build an HTTP error from a status code and response body, classifying the failure from the
    /// body text.
    #[must_use]
    pub fn from_http_status_body(
        status: u16,
        body: &str,
        headers: std::collections::HashMap<String, String>,
    ) -> Self {
        // The OpenAI SDK surfaces `400 <body>` as the error message; the user-facing message is
        // rebuilt from the classified parts.
        let message = if body.trim().is_empty() {
            format!("{status}")
        } else {
            format!("{status} {body}")
        };
        let http_error = ProviderHttpError {
            message,
            status: Some(status),
            body: Some(body.to_string()),
            headers,
            request_id: None,
            sdk_name: None,
            retry_after_ms: None,
            provider_error_type: None,
        };
        let parts = extract_parts_from_http(&http_error);
        if parts.info.kind == StreamFailureKind::Unknown {
            ProviderError::Http(http_error)
        } else {
            ProviderError::Http(ProviderHttpError {
                message: stream_failure_message(&parts.info, parts.detail.as_deref()),
                ..http_error
            })
        }
    }
}

impl From<StreamFailureError> for ProviderError {
    fn from(value: StreamFailureError) -> Self {
        ProviderError::StreamFailure(value)
    }
}

impl From<ProviderHttpError> for ProviderError {
    fn from(value: ProviderHttpError) -> Self {
        ProviderError::Http(value)
    }
}

const KIND_MESSAGES: &[(StreamFailureKind, &str)] = &[
    (StreamFailureKind::Refusal, "Model refused to respond"),
    (
        StreamFailureKind::Safety,
        "Response blocked by provider safety filters",
    ),
    (StreamFailureKind::Overloaded, "Provider overloaded"),
    (StreamFailureKind::RateLimit, "Provider rate limit exceeded"),
    (StreamFailureKind::ServerError, "Provider server error"),
    (StreamFailureKind::Auth, "Provider authentication failed"),
    (
        StreamFailureKind::Permission,
        "Provider denied access to the requested resource",
    ),
    (
        StreamFailureKind::InvalidRequest,
        "Provider rejected the request",
    ),
    (
        StreamFailureKind::MalformedResponse,
        "Provider returned a malformed response",
    ),
    (
        StreamFailureKind::PaymentRequired,
        "Provider requires payment",
    ),
    (
        StreamFailureKind::StreamDrop,
        "Provider dropped the response stream",
    ),
    (StreamFailureKind::Unknown, "Provider stream failed"),
];

fn kind_message(kind: StreamFailureKind) -> &'static str {
    KIND_MESSAGES
        .iter()
        .find(|(candidate, _)| *candidate == kind)
        .map_or("Provider stream failed", |(_, message)| *message)
}

/// Build a user-facing message like "Provider overloaded (`overloaded_error`, 529) [`request_id`: `req_abc`]".
#[must_use]
pub fn stream_failure_message(info: &StreamFailureInfo, detail: Option<&str>) -> String {
    let mut qualifiers: Vec<String> = Vec::new();
    if let Some(provider_error_type) = &info.provider_error_type {
        qualifiers.push(provider_error_type.clone());
    }
    if let Some(status) = info.status {
        qualifiers.push(status.to_string());
    }
    let mut message = kind_message(info.kind).to_string();
    if !qualifiers.is_empty() {
        let _ = write!(message, " ({})", qualifiers.join(", "));
    }
    if let Some(detail) = detail {
        let _ = write!(message, ": {detail}");
    }
    if let Some(request_id) = &info.request_id {
        let _ = write!(message, " [request_id: {request_id}]");
    }
    message
}

/// Classify a stream failure from the provider's error type and status code.
///
/// # Panics
///
/// Panics only if one of the built-in regex patterns fails to compile (static literals).
#[must_use]
pub fn classify_stream_failure(
    provider_error_type: Option<&str>,
    status: Option<u16>,
) -> StreamFailureKind {
    let type_lower = provider_error_type.unwrap_or("").to_lowercase();
    // A 402 is a payment failure regardless of the body's `error.type` text: gateways surface
    // wallet drains as `insufficient_credits`, `insufficient_balance`, or bare numeric codes.
    // Credits do not refill inside a retry ladder, so the status wins.
    if status == Some(402) {
        return StreamFailureKind::PaymentRequired;
    }
    if type_lower == "refusal" {
        return StreamFailureKind::Refusal;
    }
    let safety = regex::Regex::new(
        r"sensitive|safety|prohibited_content|blocklist|spii|recitation|content.?filter|guardrail|flagged",
    )
    .expect("static regex");
    if safety.is_match(&type_lower) {
        return StreamFailureKind::Safety;
    }
    if type_lower.contains("overloaded") || status == Some(529) {
        return StreamFailureKind::Overloaded;
    }
    // usage_not_included is Codex's plan-entitlement rejection, not bad credentials.
    let rate_limit = regex::Regex::new(r"rate_limit|usage_limit|usage_not_included|throttl")
        .expect("static regex");
    if rate_limit.is_match(&type_lower) || status == Some(429) {
        return StreamFailureKind::RateLimit;
    }
    // Permission/403 shapes are entitlement or policy denials, not bad credentials: never auth-stale.
    if type_lower.contains("authentication")
        || type_lower.contains("unauthorized")
        || status == Some(401)
    {
        return StreamFailureKind::Auth;
    }
    let permission =
        regex::Regex::new(r"permission|forbidden|access.?denied").expect("static regex");
    if permission.is_match(&type_lower) || status == Some(403) {
        return StreamFailureKind::Permission;
    }
    if type_lower.contains("invalid_request")
        || type_lower.contains("not_found_error")
        || status == Some(400)
        || status == Some(404)
    {
        return StreamFailureKind::InvalidRequest;
    }
    if type_lower.contains("malformed") {
        return StreamFailureKind::MalformedResponse;
    }
    if type_lower.contains("api_error")
        || type_lower.contains("server_error")
        || type_lower.contains("unavailable")
        || status.is_some_and(|status| status >= 500)
    {
        return StreamFailureKind::ServerError;
    }
    StreamFailureKind::Unknown
}

/// Failure for a stream that terminated with a provider stop/finish reason that maps to "error"
/// (e.g. Anthropic "refusal", Gemini "SAFETY").
pub fn stream_failure_from_stop_reason(
    raw_stop_reason: Option<&str>,
    request_id: Option<&str>,
) -> StreamFailureError {
    let mut info = StreamFailureInfo {
        kind: match raw_stop_reason {
            Some(reason) => classify_stream_failure(Some(reason), None),
            None => StreamFailureKind::Unknown,
        },
        provider_error_type: raw_stop_reason.map(std::string::ToString::to_string),
        request_id: request_id.map(std::string::ToString::to_string),
        status: None,
        retry_after_ms: None,
        raw: None,
    };
    if info.kind == StreamFailureKind::Unknown
        && raw_stop_reason.is_some_and(|reason| reason.to_lowercase().contains("malformed"))
    {
        info.kind = StreamFailureKind::MalformedResponse;
    }
    let message = match raw_stop_reason {
        Some(_) => stream_failure_message(&info, None),
        None => {
            stream_failure_message(&info, Some("stream ended with an error and no stop reason"))
        }
    };
    StreamFailureError { message, info }
}

/// Which content block a dropped stream was inside when the provider ended
/// it (the disclosure detail names what the turn was mid-way through).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenStreamBlock {
    Thinking,
    Text,
    ToolCall,
    /// No content block had opened yet (the stream died before any).
    None,
}

/// Failure for a stream the provider ended without its terminal marker:
/// the connection closed mid-block with no stop signal and no error frame
/// (the silent drop class: the turn would otherwise settle as a completed
/// message with no error anywhere). Retryable by nature — the auto-retry
/// arms re-issue the same request — and disclosed as the `stream_drop`
/// class when the retries exhaust.
#[must_use]
pub(crate) fn stream_drop_failure(open_block: OpenStreamBlock) -> StreamFailureError {
    let detail = match open_block {
        OpenStreamBlock::Thinking => {
            "the stream ended inside a thinking block before the stop signal"
        }
        OpenStreamBlock::Text => "the stream ended inside a text block before the stop signal",
        OpenStreamBlock::ToolCall => {
            "the stream ended inside a tool-call block before the stop signal"
        }
        OpenStreamBlock::None => "the stream ended before any response content or stop signal",
    };
    let info = StreamFailureInfo {
        kind: StreamFailureKind::StreamDrop,
        provider_error_type: Some("stream_drop".to_string()),
        status: None,
        request_id: None,
        retry_after_ms: None,
        raw: None,
    };
    StreamFailureError {
        message: stream_failure_message(&info, Some(detail)),
        info,
    }
}

const MAX_RAW_LENGTH: usize = 2000;

#[must_use]
pub fn truncate_raw_payload(raw: &str) -> String {
    if raw.len() > MAX_RAW_LENGTH {
        // Match the TS slice-by-16-bit-code-unit behavior closely enough for post-mortem truncation
        // while staying on char boundaries in Rust.
        let mut end = MAX_RAW_LENGTH;
        while end > 0 && !raw.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\u{2026}", &raw[..end])
    } else {
        raw.to_string()
    }
}

mod http_retry;
use http_retry::header_value;
pub(crate) use http_retry::parse_retry_after_ms;

struct ExtractedParts {
    info: StreamFailureInfo,
    detail: Option<String>,
}

fn extract_parts_from_http(error: &ProviderHttpError) -> ExtractedParts {
    let mut body_type: Option<String> = None;
    let mut body_message: Option<String> = None;
    if let Some(body) = &error.body {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
            // Error bodies come nested differently per SDK: Anthropic/OpenAI expose `error.error =
            // {type|code, message}` (sometimes doubly nested).
            let mut node = &parsed;
            if let Some(nested) = node.get("error") {
                if nested.is_object() && nested.get("error").is_some() {
                    node = nested.get("error").unwrap();
                }
                if nested.is_object() {
                    node = nested;
                }
            }
            if let Some(value) = node.get("type").or_else(|| node.get("code")) {
                if let Some(text) = value.as_str() {
                    body_type = Some(text.to_string());
                }
            }
            if let Some(value) = node.get("message") {
                if let Some(text) = value.as_str() {
                    body_message = Some(text.to_string());
                }
            }
        }
    }

    let header_request_id = header_value(&error.headers, "request-id")
        .or_else(|| header_value(&error.headers, "x-request-id"));
    let request_id = error.request_id.clone().or(header_request_id);
    // An error-resolved wait (Retry-After vs resets_at maximum) overrides the raw header.
    let retry_after_ms = error
        .retry_after_ms
        .or_else(|| parse_retry_after_ms(&error.headers));

    // The SDK error's own `code` and then its class `name` stand in for the provider error type
    // when the body carries none (TS `extractStreamFailureParts`).
    let provider_error_type = body_type
        .or_else(|| error.provider_error_type.clone())
        .or_else(|| error.sdk_name.clone());
    let mut kind = classify_stream_failure(
        provider_error_type
            .as_deref()
            .or(Some(error.message.as_str())),
        error.status,
    );
    // Message text is too weak for these verdicts: without a structured type, only the status decides.
    if (kind == StreamFailureKind::Auth || kind == StreamFailureKind::Permission)
        && provider_error_type.is_none()
    {
        kind = classify_stream_failure(None, error.status);
    }

    ExtractedParts {
        info: StreamFailureInfo {
            kind,
            provider_error_type,
            status: error.status,
            request_id,
            retry_after_ms,
            raw: None,
        },
        detail: body_message,
    }
}

/// Best-effort extraction of structured failure info from any provider error.
pub fn extract_stream_failure_info(error: &ProviderError) -> StreamFailureInfo {
    match error {
        ProviderError::StreamFailure(failure) => failure.info.clone(),
        ProviderError::Http(http) => extract_parts_from_http(http).info,
        // TS connection errors never classify (their names/codes match no kind pattern); the
        // provider error type is the recorded `err.code`.
        ProviderError::Connection(connection) => StreamFailureInfo {
            provider_error_type: connection.error_code().map(str::to_string),
            ..StreamFailureInfo::unknown()
        },
        // TS WS transport errors never classify; the provider error type is the error's class name,
        // like `err.name !== "Error"` in TS.
        ProviderError::Transport(transport) => StreamFailureInfo {
            provider_error_type: match transport.error_name() {
                "Error" => None,
                name => Some(name.to_string()),
            },
            ..StreamFailureInfo::unknown()
        },
        ProviderError::Message(message) => StreamFailureInfo {
            kind: classify_stream_failure(Some(message), None),
            ..StreamFailureInfo::unknown()
        },
        ProviderError::Aborted => StreamFailureInfo::unknown(),
    }
}

/// User-facing message for a thrown stream error: a classified one-liner with the provider's own
/// short message, never the raw payload/trace. Unrecognized errors pass through verbatim so their
/// text (which downstream retry matching may depend on) is preserved.
#[must_use]
pub fn format_stream_failure_message(error: &ProviderError) -> String {
    match error {
        ProviderError::StreamFailure(failure) => failure.message.clone(),
        ProviderError::Aborted => "Request was aborted".to_string(),
        ProviderError::Connection(connection) => connection.message(),
        // WS transport errors classify as "unknown", so the raw runtime text passes through
        // verbatim.
        ProviderError::Transport(transport) => transport.message.clone(),
        ProviderError::Http(http) => {
            let parts = extract_parts_from_http(http);
            if parts.info.kind == StreamFailureKind::Unknown {
                http.message.clone()
            } else {
                stream_failure_message(&parts.info, parts.detail.as_deref())
            }
        }
        ProviderError::Message(message) => message.clone(),
    }
}

pub(crate) fn diagnostic_error_info(error: &ProviderError) -> DiagnosticErrorInfo {
    let (name, message, code) = match error {
        ProviderError::StreamFailure(_) => (
            Some("StreamFailureError".to_string()),
            error.to_string(),
            None,
        ),
        // The TS diagnostic records the provider SDK's error class name; Stainless-generated SDKs
        // (openai, anthropic, azure) do not set `error.name`, so JS records the inherited plain
        // "Error".
        ProviderError::Http(http) => (
            Some(http.sdk_name.clone().unwrap_or_else(|| "Error".to_string())),
            error.to_string(),
            None,
        ),
        ProviderError::Connection(connection) => (
            Some(connection.error_name().to_string()),
            error.to_string(),
            None,
        ),
        // The TS diagnostic records the runtime WS error class name and, for close events, the
        // numeric close code as `error.code`.
        ProviderError::Transport(transport) => (
            Some(transport.error_name().to_string()),
            transport.message.clone(),
            transport.close_code.map(|code| {
                crate::types::DiagnosticCode::Num(crate::types::JsNumber::from(u64::from(code)))
            }),
        ),
        ProviderError::Message(_) => (None, error.to_string(), None),
        ProviderError::Aborted => (
            Some("AbortError".to_string()),
            "Request was aborted".to_string(),
            None,
        ),
    };
    DiagnosticErrorInfo {
        name,
        message,
        stack: None,
        code,
        rest: Map::default(),
    }
}

/// Record a terminal stream failure on the message (structured diagnostic that persists to session
/// JSONL) and emit one structured log line. Call from the provider's terminal catch after
/// `stop_reason/error_message` are set; no-op for user-initiated aborts.
pub fn record_stream_failure(
    model: (&str, &str, &str),
    output: &mut AssistantMessage,
    error: &ProviderError,
) {
    if output.stop_reason != crate::types::StopReason::Error {
        return;
    }
    let info = extract_stream_failure_info(error);
    let info_json = serde_json::to_value(&info).unwrap_or(serde_json::Value::Null);
    append_assistant_message_diagnostic(
        output,
        create_assistant_message_diagnostic(
            "provider_stream_failure",
            Some(diagnostic_error_info(error)),
            Some(info_json),
        ),
    );
    let raw_message = error.to_string();
    let error_message = output.error_message.clone().unwrap_or_default();
    crate::utils_inner::log::get_logger("ai.provider").error(
        "provider stream failure",
        serde_json::json!({
            "provider": model.0,
            "model": model.1,
            "api": model.2,
            "kind": info.kind,
            "providerErrorType": info.provider_error_type,
            "status": info.status,
            "requestId": info.request_id,
            "message": output.error_message,
            "cause": if raw_message == error_message {
                serde_json::Value::Null
            } else {
                serde_json::Value::String(truncate_raw_payload(&raw_message))
            },
        }),
    );
}

#[cfg(test)]
mod tests;
