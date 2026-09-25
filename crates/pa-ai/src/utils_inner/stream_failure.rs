//! Shared classification and reporting for provider stream failures, so no
//! provider collapses a specific cause (refusal, safety filter, overload, ...)
//! into a generic string before it is logged and persisted.
//! Ported from `packages/ai/src/utils/stream-failure.ts`.

use std::fmt::Write as _;

use serde::Serialize;

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
    Overloaded,
    RateLimit,
    ServerError,
    Auth,
    Permission,
    InvalidRequest,
    MalformedResponse,
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

/// A stream failure carrying structured classification info.
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

/// Connection-level transport failure kinds: connect failures, request
/// timeouts, and the post-connection transport failures (AWS handler
/// surfaces: http1 reset, http2 stream/session/protocol failures).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionErrorKind {
    /// The transport could not be established (refused, unreachable, DNS).
    Connect,
    /// The request exceeded its configured deadline.
    Timeout,
    /// The peer closed or reset the connection before a response arrived.
    /// For the AWS http1 handler surface this is node's `read ECONNRESET`.
    Reset,
    /// An http2-level failure before any response arrived (bedrock's default
    /// transport): the `H2Failure` text without the deserialization hint.
    H2Request(H2Failure),
    /// An http2-level failure inside a received response body (bedrock's
    /// default transport): the AWS SDK's event-stream reader fails, so the
    /// message carries its deserialization hint.
    H2MidStream(H2Failure),
}

/// The http2 transport failure detail, with the byte-exact user-facing text
/// the TS bedrock client (bun's node:http2 behind the AWS SDK's
/// `NodeHttp2Handler`) surfaces for it. Verified against the TS binary by the
/// provider-error probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum H2Failure {
    /// A `RST_STREAM` received from the peer: "Stream closed with error code
    /// NGHTTP2_<NAME>" with the nghttp2 name of the carried code.
    StreamReset { nghttp2_code: String },
    /// A GOAWAY received from the peer: "Session closed with error code N"
    /// with the numeric code.
    SessionClosed { code: u32 },
    /// A stream/socket failure (peer reset or closed mid-stream):
    /// "The pending stream has been canceled".
    Canceled,
    /// Any other http2 protocol violation (e.g. an HTTP/1.1 answer at a
    /// prior-knowledge h2 peer): "Protocol error".
    Protocol,
}

/// Connection-error shapes per provider family, verified against the TS
/// binary (0.9.5, refused-connect probes): each family surfaces a fixed
/// text and records a fixed diagnostic `error.name` / `err.code`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionErrorProfile {
    /// The openai/anthropic SDK family (openai-completions,
    /// openai-responses, azure, anthropic): the SDK's fixed texts
    /// ("Connection error." / "Request timed out.") and a plain `Error`
    /// name with no error code.
    Sdk,
    /// Raw `fetch` providers (openai-codex-responses, google): the
    /// runtime's own error text (bun's refused-connect message), `TypeError`
    /// name, `ConnectionRefused` code.
    RawFetch,
    /// The mistral SDK's `UnexpectedClientError` wrapper shape.
    MistralSdk,
    /// The AWS node/http1 handler: the node `connect ECONNREFUSED
    /// <host>:<port>` text with the `ECONNREFUSED` code — the TS
    /// `AWS_BEDROCK_FORCE_HTTP1` surface (and the proxy-env handler mode).
    /// A peer close before the response is node's `read ECONNRESET`
    /// (`TimeoutError` name, TS-binary verified).
    AwsHttp1 { host: String, port: u16 },
    /// The AWS `NodeHttp2Handler` surface — the TS default bedrock transport
    /// (http2 with h2c prior knowledge over cleartext): the bun node:http2
    /// failure texts and `ERR_HTTP2_*` codes, TS-binary verified.
    AwsHttp2 { host: String, port: u16 },
}

/// The AWS SDK's deserialization hint the TS binary appends to failures
/// inside a received response body (the event-stream reader has a response
/// to lose). Byte-exact, TS-binary verified.
pub const AWS_DESERIALIZATION_HINT: &str =
    "\n  Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object.";

/// The base failure text of an http2 transport failure (without the
/// deserialization hint).
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

/// The user-facing failure text, with the AWS SDK deserialization hint for
/// mid-body failures.
pub fn h2_failure_message(failure: &H2Failure, mid_stream: bool) -> String {
    let mut message = h2_failure_text(failure);
    if mid_stream {
        message.push_str(AWS_DESERIALIZATION_HINT);
    }
    message
}

/// Errors raised by provider HTTP/SSE plumbing, carrying the raw pieces the TS
/// reference extracts from provider SDK exceptions.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderHttpError {
    pub message: String,
    pub status: Option<u16>,
    pub body: Option<String>,
    pub headers: std::collections::HashMap<String, String>,
    pub request_id: Option<String>,
    /// The TS SDK error class name recorded in the `provider_stream_failure`
    /// diagnostic (e.g. "`BadRequestError`", "`CodexApiError`", "`SDKError`"); the
    /// `ProviderHttpError` internal fallback when unset.
    pub sdk_name: Option<String>,
    /// Server-requested wait already resolved by the provider (Retry-After
    /// header, `resets_at` body); overrides header re-parsing, like the TS
    /// `err.retryAfterMs` field takes precedence over `parseRetryAfterMs`.
    pub retry_after_ms: Option<u64>,
    /// The provider error's own wire `code` (TS `err.code`), which the
    /// classification prefers over the class name when the body carries no
    /// error type.
    pub provider_error_type: Option<String>,
}

impl std::fmt::Display for ProviderHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProviderHttpError {}

/// A connection-level transport failure. `Display` is the user-facing text
/// the TS binary surfaces for the provider's SDK/runtime connection error
/// (fixed strings per provider family, verified against the installed TS
/// binary); the raw `cause` is kept for logging.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderConnectionError {
    pub kind: ConnectionErrorKind,
    pub profile: ConnectionErrorProfile,
    pub cause: String,
}

/// The runtime's refused-connect message the TS binary (bun `fetch`) surfaces
/// verbatim on the raw-`fetch` providers (codex, google).
pub const RUNTIME_CONNECT_REFUSED_MESSAGE: &str =
    "Unable to connect. Is the computer able to access the url?";

impl ProviderConnectionError {
    /// The user-facing text the TS binary surfaces for this failure.
    pub fn message(&self) -> String {
        // A peer reset before the response carries the same fixed text as the
        // connect failure for the raw-fetch/SDK families (the TS binary
        // surfaces one per-family connection error; reset-vs-refused is only
        // distinguishable on the AWS handler surfaces, which have dedicated
        // texts below).
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
            // Raw `fetch` (bun) and the mistral `RequestTimeoutError` append
            // the raw cause to a fixed timeout prefix; the refused-connect
            // text is the runtime's own fixed message.
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
                // The refused connect surfaces as a canceled pending stream
                // with the node-style connect cause embedded.
                format!(
                    "The pending stream has been canceled (caused by: connect ECONNREFUSED {host}:{port})"
                )
            }
            (ConnectionErrorProfile::AwsHttp2 { .. }, ConnectionErrorKind::Timeout) => {
                // No TS ground truth: the TS client configures no transport
                // timeout (NodeHttp2Handler without requestTimeout).
                "Request timed out.".to_string()
            }
            (ConnectionErrorProfile::AwsHttp2 { .. }, ConnectionErrorKind::Reset) => {
                // A pre-response non-connect failure at a cleartext prior-
                // knowledge h2 peer (HTTP/1.1 answer): bun's protocol error.
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

    /// The TS runtime/SDK error class name recorded in the
    /// `provider_stream_failure` diagnostic.
    pub fn error_name(&self) -> &'static str {
        if matches!(self.profile, ConnectionErrorProfile::RawFetch) {
            return "TypeError";
        }
        if matches!(self.profile, ConnectionErrorProfile::MistralSdk) {
            return "UnexpectedClientError";
        }
        // bun records the http1 pre-response reset as a TimeoutError
        // (TS-binary verified); every other AWS handler failure is a plain
        // Error.
        if matches!(self.profile, ConnectionErrorProfile::AwsHttp1 { .. })
            && matches!(self.kind, ConnectionErrorKind::Reset)
        {
            return "TimeoutError";
        }
        "Error"
    }

    /// The TS `err.code` the classification uses as the provider error type
    /// (bun's `ConnectionRefused` for raw `fetch`, the SDK class name for
    /// mistral, node's `ECONNREFUSED` for the AWS http1 handler and bun's
    /// `ERR_HTTP2_*` codes for the AWS http2 handler; the openai/anthropic
    /// SDK family records none).
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
            // The TS client configures no AWS transport timeout, so there is
            // no ground-truth code; the classification records none.
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

/// A WebSocket transport failure thrown out of a provider stream (the codex
/// WS path, after events were emitted): `Display` is the raw runtime text
/// (verbatim, like the TS), and the TS `provider_stream_failure` diagnostic
/// records the runtime WS error class name — `WebSocketCloseError` for
/// close events, plain `Error` otherwise — plus the numeric close code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderWsTransportError {
    pub message: String,
    pub close_code: Option<u16>,
}

impl ProviderWsTransportError {
    /// The TS runtime/WS error class name recorded in the diagnostic
    /// (`error.name`); the close-code presence decides it.
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
    /// WebSocket transport failure (codex WS path): raw runtime text plus
    /// the TS diagnostic's WS error class name and close code.
    Transport(ProviderWsTransportError),
    /// Plain error message; classified from its text like unrecognized TS errors.
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
    /// Build an HTTP error from a status code and response body, classifying
    /// the failure from the body text like the TS `stream-failure.ts` parser.
    pub fn from_http_status_body(
        status: u16,
        body: &str,
        headers: std::collections::HashMap<String, String>,
    ) -> Self {
        // The OpenAI SDK surfaces `400 <body>` as the error message; the
        // classification pipeline reads the structured `body` field, and the
        // user-facing message is rebuilt from the classified parts.
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
    (StreamFailureKind::Unknown, "Provider stream failed"),
];

fn kind_message(kind: StreamFailureKind) -> &'static str {
    KIND_MESSAGES
        .iter()
        .find(|(candidate, _)| *candidate == kind)
        .map_or("Provider stream failed", |(_, message)| *message)
}

/// Build a user-facing message like "Provider overloaded (`overloaded_error`, 529) [`request_id`: `req_abc`]".
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
/// Panics only if one of the built-in regex patterns fails to compile; the
/// patterns are static literals, so this never fires in practice.
pub fn classify_stream_failure(
    provider_error_type: Option<&str>,
    status: Option<u16>,
) -> StreamFailureKind {
    let type_lower = provider_error_type.unwrap_or("").to_lowercase();
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

/// Failure for a stream that terminated with a provider stop/finish reason that
/// maps to "error" (e.g. Anthropic "refusal", Gemini "SAFETY").
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

const MAX_RAW_LENGTH: usize = 2000;

pub fn truncate_raw_payload(raw: &str) -> String {
    if raw.len() > MAX_RAW_LENGTH {
        // Match the TS slice-by-16-bit-code-unit behavior closely enough for
        // post-mortem truncation while staying on char boundaries in Rust.
        let mut end = MAX_RAW_LENGTH;
        while end > 0 && !raw.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\u{2026}", &raw[..end])
    } else {
        raw.to_string()
    }
}

fn header_value(headers: &std::collections::HashMap<String, String>, name: &str) -> Option<String> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
}

/// Parse Retry-After / Retry-After-Ms headers into a millisecond wait.
pub fn parse_retry_after_ms(headers: &std::collections::HashMap<String, String>) -> Option<u64> {
    if let Some(value) = header_value(headers, "retry-after-ms") {
        if let Ok(ms) = value.parse::<f64>() {
            if ms.is_finite() && ms >= 0.0 {
                return Some(ms as u64);
            }
        }
    }
    let raw = header_value(headers, "retry-after")?;
    if let Ok(seconds) = raw.parse::<f64>() {
        if seconds.is_finite() && seconds >= 0.0 {
            return Some((seconds * 1000.0) as u64);
        }
    }
    // HTTP-date form: compute the delta against now.
    match parse_http_date(&raw) {
        Some(date_ms) => {
            let now = now_ms() as i64;
            Some((date_ms - now).max(0) as u64)
        }
        None => None,
    }
}

fn parse_http_date(raw: &str) -> Option<i64> {
    // Minimal IMF-fixdate parser: "Sun, 06 Nov 1994 08:49:37 GMT".
    let parts: Vec<&str> = raw.split_whitespace().collect();
    if parts.len() < 6 {
        return None;
    }
    let day: i64 = parts[1].parse().ok()?;
    let month = match parts[2].to_ascii_lowercase().as_str() {
        "jan" => 1,
        "feb" => 2,
        "mar" => 3,
        "apr" => 4,
        "may" => 5,
        "jun" => 6,
        "jul" => 7,
        "aug" => 8,
        "sep" => 9,
        "oct" => 10,
        "nov" => 11,
        "dec" => 12,
        _ => return None,
    };
    let year: i64 = parts[3].parse().ok()?;
    let time: Vec<&str> = parts[4].split(':').collect();
    if time.len() < 3 {
        return None;
    }
    let (h, m, s): (i64, i64, i64) = (
        time[0].parse().ok()?,
        time[1].parse().ok()?,
        time[2].parse().ok()?,
    );
    let days = days_from_civil(year, month, day);
    Some((days * 86_400 + h * 3600 + m * 60 + s) * 1000)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

struct ExtractedParts {
    info: StreamFailureInfo,
    detail: Option<String>,
}

fn extract_parts_from_http(error: &ProviderHttpError) -> ExtractedParts {
    let mut body_type: Option<String> = None;
    let mut body_message: Option<String> = None;
    if let Some(body) = &error.body {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
            // Error bodies come nested differently per SDK: Anthropic/OpenAI expose
            // `error.error = {type|code, message}` (sometimes doubly nested).
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
    // An error-resolved wait (Retry-After vs resets_at maximum) overrides the
    // raw header, like the TS `err.retryAfterMs` field takes precedence.
    let retry_after_ms = error
        .retry_after_ms
        .or_else(|| parse_retry_after_ms(&error.headers));

    // TS `extractStreamFailureParts`: the SDK error's own `code` field and
    // then its class `name` stand in for the provider error type when the
    // body does not carry one.
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
        // The TS connection errors never classify (their names/codes —
        // "Error", "TypeError", "UnexpectedClientError", "ConnectionRefused",
        // "ECONNREFUSED" — match no kind pattern); the provider error type
        // is the recorded err.code (if any).
        ProviderError::Connection(connection) => StreamFailureInfo {
            provider_error_type: connection.error_code().map(str::to_string),
            ..StreamFailureInfo::unknown()
        },
        // The TS WS transport errors never classify ("WebSocketCloseError"
        // matches no kind pattern); the provider error type is the error's
        // class name, like `err.name !== "Error"` in the TS extraction.
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

/// User-facing message for a thrown stream error: a classified one-liner with
/// the provider's own short message, never the raw payload/trace. Unrecognized
/// errors pass through verbatim so their text (which downstream retry matching
/// may depend on) is preserved.
pub fn format_stream_failure_message(error: &ProviderError) -> String {
    match error {
        ProviderError::StreamFailure(failure) => failure.message.clone(),
        ProviderError::Aborted => "Request was aborted".to_string(),
        ProviderError::Connection(connection) => connection.message(),
        // The TS WS transport errors classify as "unknown", so the raw
        // runtime text passes through verbatim.
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
        // The TS diagnostic records the provider SDK's error class name
        // ("BadRequestError", "APIError", "SDKError", ...); the provider sets
        // it where it builds the HTTP error, falling back to the internal
        // name for raw plumbing errors.
        // The TS Stainless-generated SDK errors (openai, anthropic, azure)
        // do not set `error.name`, so JS records the inherited plain "Error";
        // providers whose SDK names the class record it (mistral "SDKError",
        // codex "CodexApiError", google "ApiError", AWS exception names).
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
        // The TS diagnostic records the runtime WS error class name and,
        // for close events, the numeric close code as `error.code`.
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

/// Record a terminal stream failure on the message (structured diagnostic that
/// persists to session JSONL) and emit one structured log line. Call from the
/// provider's terminal catch after `stop_reason/error_message` are set; no-op for
/// user-initiated aborts.
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
mod tests {
    use super::*;

    #[test]
    fn classifies_provider_error_types() {
        assert_eq!(
            classify_stream_failure(Some("refusal"), None),
            StreamFailureKind::Refusal
        );
        assert_eq!(
            classify_stream_failure(Some("SAFETY"), None),
            StreamFailureKind::Safety
        );
        assert_eq!(
            classify_stream_failure(Some("overloaded_error"), None),
            StreamFailureKind::Overloaded
        );
        assert_eq!(
            classify_stream_failure(Some("other"), Some(529)),
            StreamFailureKind::Overloaded
        );
        assert_eq!(
            classify_stream_failure(Some("rate_limit_error"), None),
            StreamFailureKind::RateLimit
        );
        assert_eq!(
            classify_stream_failure(Some("usage_not_included"), None),
            StreamFailureKind::RateLimit
        );
        assert_eq!(
            classify_stream_failure(Some("other"), Some(429)),
            StreamFailureKind::RateLimit
        );
        assert_eq!(
            classify_stream_failure(Some("authentication_error"), None),
            StreamFailureKind::Auth
        );
        assert_eq!(
            classify_stream_failure(Some("forbidden"), None),
            StreamFailureKind::Permission
        );
        assert_eq!(
            classify_stream_failure(Some("invalid_request_error"), None),
            StreamFailureKind::InvalidRequest
        );
        assert_eq!(
            classify_stream_failure(Some("api_error"), None),
            StreamFailureKind::ServerError
        );
        assert_eq!(
            classify_stream_failure(Some("other"), Some(503)),
            StreamFailureKind::ServerError
        );
        assert_eq!(
            classify_stream_failure(Some("weird"), None),
            StreamFailureKind::Unknown
        );
    }

    #[test]
    fn builds_user_facing_messages() {
        let info = StreamFailureInfo {
            kind: StreamFailureKind::Overloaded,
            provider_error_type: Some("overloaded_error".into()),
            status: Some(529),
            request_id: Some("req_abc".into()),
            retry_after_ms: None,
            raw: None,
        };
        assert_eq!(
            stream_failure_message(&info, Some("slow down")),
            "Provider overloaded (overloaded_error, 529): slow down [request_id: req_abc]"
        );
    }

    /// The classified shape the anthropic/openai-responses providers surface
    /// (`formatStreamFailureMessage`): kind text, parenthesized qualifiers
    /// (provider type and/or status), detail after the colon.
    #[test]
    fn classified_message_with_parenthesized_status() {
        let status_only = StreamFailureInfo {
            kind: StreamFailureKind::InvalidRequest,
            provider_error_type: None,
            status: Some(400),
            request_id: None,
            retry_after_ms: None,
            raw: None,
        };
        assert_eq!(
            stream_failure_message(&status_only, Some("bad request")),
            "Provider rejected the request (400): bad request"
        );
        assert_eq!(
            stream_failure_message(&status_only, None),
            "Provider rejected the request (400)"
        );
    }

    #[test]
    fn stop_reason_failures() {
        let err = stream_failure_from_stop_reason(Some("refusal"), None);
        assert_eq!(err.info.kind, StreamFailureKind::Refusal);
        assert_eq!(err.message, "Model refused to respond (refusal)");

        let missing = stream_failure_from_stop_reason(None, None);
        assert_eq!(
            missing.message,
            "Provider stream failed: stream ended with an error and no stop reason"
        );
    }

    #[test]
    fn truncates_raw_payload() {
        let long = "x".repeat(2500);
        let truncated = truncate_raw_payload(&long);
        assert_eq!(truncated.chars().count(), 2001);
        assert!(truncated.ends_with('\u{2026}'));
    }

    #[test]
    fn parses_retry_after_headers() {
        let mut headers = std::collections::HashMap::new();
        headers.insert("retry-after-ms".to_string(), "250".to_string());
        assert_eq!(parse_retry_after_ms(&headers), Some(250));
        headers.clear();
        headers.insert("retry-after".to_string(), "3".to_string());
        assert_eq!(parse_retry_after_ms(&headers), Some(3000));
    }

    /// Connection-level failures carry the per-family texts the TS binary
    /// surfaces (verified by the provider-error probe), never classify, and
    /// record the family's `error.name` / `err.code`.
    #[test]
    fn connection_error_texts() {
        let connect = ProviderError::Connection(ProviderConnectionError {
            kind: ConnectionErrorKind::Connect,
            profile: ConnectionErrorProfile::Sdk,
            cause: "tcp connect error".to_string(),
        });
        let timeout = ProviderError::Connection(ProviderConnectionError {
            kind: ConnectionErrorKind::Timeout,
            profile: ConnectionErrorProfile::Sdk,
            cause: "request exceeded the 10000ms timeout".to_string(),
        });
        assert_eq!(connect.to_string(), "Connection error.");
        assert_eq!(timeout.to_string(), "Request timed out.");
        // The classified-format providers surface them verbatim too.
        assert_eq!(format_stream_failure_message(&connect), "Connection error.");
        // The classification is unknown, like the TS SDK connection errors,
        // and the openai/anthropic family records no error code.
        assert_eq!(
            extract_stream_failure_info(&connect),
            StreamFailureInfo::unknown()
        );
        // The TS Stainless SDK errors do not set `error.name`: JS records
        // the inherited plain "Error".
        assert_eq!(
            diagnostic_error_info(&connect).name.as_deref(),
            Some("Error")
        );

        let raw_connect = ProviderError::Connection(ProviderConnectionError {
            kind: ConnectionErrorKind::Connect,
            profile: ConnectionErrorProfile::RawFetch,
            cause: "tcp connect error".to_string(),
        });
        assert_eq!(
            raw_connect.to_string(),
            "Unable to connect. Is the computer able to access the url?"
        );
        let raw_info = extract_stream_failure_info(&raw_connect);
        assert_eq!(
            raw_info.provider_error_type.as_deref(),
            Some("ConnectionRefused")
        );
        assert_eq!(raw_info.kind, StreamFailureKind::Unknown);
        assert_eq!(
            diagnostic_error_info(&raw_connect).name.as_deref(),
            Some("TypeError")
        );

        let mistral_connect = ProviderError::Connection(ProviderConnectionError {
            kind: ConnectionErrorKind::Connect,
            profile: ConnectionErrorProfile::MistralSdk,
            cause: "tcp connect error".to_string(),
        });
        assert_eq!(
            mistral_connect.to_string(),
            "Unexpected HTTP client error: TypeError: Unable to connect. Is the computer able to access the url?"
        );
        assert_eq!(
            diagnostic_error_info(&mistral_connect).name.as_deref(),
            Some("UnexpectedClientError")
        );
        assert_eq!(
            extract_stream_failure_info(&mistral_connect)
                .provider_error_type
                .as_deref(),
            Some("UnexpectedClientError")
        );

        let aws_connect = ProviderError::Connection(ProviderConnectionError {
            kind: ConnectionErrorKind::Connect,
            profile: ConnectionErrorProfile::AwsHttp1 {
                host: "127.0.0.1".to_string(),
                port: 1,
            },
            cause: "tcp connect error".to_string(),
        });
        assert_eq!(aws_connect.to_string(), "connect ECONNREFUSED 127.0.0.1:1");
        assert_eq!(
            diagnostic_error_info(&aws_connect).name.as_deref(),
            Some("Error")
        );
        assert_eq!(
            extract_stream_failure_info(&aws_connect)
                .provider_error_type
                .as_deref(),
            Some("ECONNREFUSED")
        );
    }

    /// The AWS http2 transport failure texts (TS-binary verified, bedrock
    /// http2 mode): connect-refused stream cancel, pre-response protocol
    /// error, and the mid-stream classes carrying the AWS SDK deserialization
    /// hint.
    #[test]
    fn aws_http2_transport_texts() {
        let profile = || ConnectionErrorProfile::AwsHttp2 {
            host: "127.0.0.1".to_string(),
            port: 1,
        };
        let error = |kind| {
            ProviderError::Connection(ProviderConnectionError {
                kind,
                profile: profile(),
                cause: "transport".to_string(),
            })
        };

        // Refused connect: the canceled pending stream embeds the node-style
        // connect cause.
        let connect = error(ConnectionErrorKind::Connect);
        assert_eq!(
            connect.to_string(),
            "The pending stream has been canceled (caused by: connect ECONNREFUSED 127.0.0.1:1)"
        );
        let info = extract_stream_failure_info(&connect);
        assert_eq!(info.kind, StreamFailureKind::Unknown);
        assert_eq!(
            info.provider_error_type.as_deref(),
            Some("ERR_HTTP2_STREAM_CANCEL")
        );
        assert_eq!(
            diagnostic_error_info(&connect).name.as_deref(),
            Some("Error")
        );

        // An HTTP/1.1 answer at a prior-knowledge h2 peer.
        let protocol = error(ConnectionErrorKind::H2Request(H2Failure::Protocol));
        assert_eq!(protocol.to_string(), "Protocol error");
        let info = extract_stream_failure_info(&protocol);
        assert_eq!(info.provider_error_type.as_deref(), Some("ERR_HTTP2_ERROR"));
        assert_eq!(
            diagnostic_error_info(&protocol).name.as_deref(),
            Some("Error")
        );

        // RST_STREAM mid-body: the nghttp2 code name plus the AWS SDK's
        // deserialization hint.
        let reset = error(ConnectionErrorKind::H2MidStream(H2Failure::StreamReset {
            nghttp2_code: "NGHTTP2_INTERNAL_ERROR".to_string(),
        }));
        assert_eq!(
            reset.to_string(),
            "Stream closed with error code NGHTTP2_INTERNAL_ERROR\n  Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object."
        );
        let info = extract_stream_failure_info(&reset);
        assert_eq!(
            info.provider_error_type.as_deref(),
            Some("ERR_HTTP2_STREAM_ERROR")
        );

        // GOAWAY mid-body: the numeric session code plus the hint.
        let session = error(ConnectionErrorKind::H2MidStream(H2Failure::SessionClosed {
            code: 1,
        }));
        assert_eq!(
            session.to_string(),
            "Session closed with error code 1\n  Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object."
        );
        let info = extract_stream_failure_info(&session);
        assert_eq!(
            info.provider_error_type.as_deref(),
            Some("ERR_HTTP2_SESSION_ERROR")
        );

        // Socket reset/close mid-body: the canceled pending stream plus the
        // hint (no connect cause — the request had already gone out).
        let canceled = error(ConnectionErrorKind::H2MidStream(H2Failure::Canceled));
        assert_eq!(
            canceled.to_string(),
            "The pending stream has been canceled\n  Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object."
        );
        let info = extract_stream_failure_info(&canceled);
        assert_eq!(
            info.provider_error_type.as_deref(),
            Some("ERR_HTTP2_STREAM_CANCEL")
        );
    }

    /// The AWS http1 handler's pre-response reset text (TS-binary verified):
    /// node's `read ECONNRESET` recorded under a `TimeoutError` name with the
    /// `ECONNRESET` code.
    #[test]
    fn aws_http1_reset_text() {
        let reset = ProviderError::Connection(ProviderConnectionError {
            kind: ConnectionErrorKind::Reset,
            profile: ConnectionErrorProfile::AwsHttp1 {
                host: "127.0.0.1".to_string(),
                port: 1,
            },
            cause: "connection closed".to_string(),
        });
        assert_eq!(reset.to_string(), "read ECONNRESET");
        let info = extract_stream_failure_info(&reset);
        assert_eq!(info.provider_error_type.as_deref(), Some("ECONNRESET"));
        assert_eq!(info.kind, StreamFailureKind::Unknown);
        assert_eq!(
            diagnostic_error_info(&reset).name.as_deref(),
            Some("TimeoutError")
        );
    }

    /// Mid-stream protocol failures (h2 framing errors inside the body)
    /// surface the deserialization hint too, like every failure the AWS
    /// SDK's event-stream reader can hit.
    #[test]
    fn h2_mid_stream_protocol_hint() {
        let failure = H2Failure::Protocol;
        assert_eq!(
            h2_failure_message(&failure, true),
            "Protocol error\n  Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object."
        );
        // Pre-response failures carry no hint (no response to deserialize).
        assert_eq!(h2_failure_message(&failure, false), "Protocol error");
    }

    /// The TS `extractStreamFailureParts` fallback chain: a body without an
    /// error type takes the SDK error's own class name, and an error-resolved
    /// retry wait overrides the raw header.
    #[test]
    fn http_error_name_fallback_and_retry_override() {
        let error = ProviderError::Http(ProviderHttpError {
            // A type-less 429 body, like a google `ApiError` (its error
            // `code` is numeric): the qualifiers show the class name.
            message: "429 {\"error\":{\"code\":429}}".to_string(),
            status: Some(429),
            body: Some("{\"error\":{\"code\":429}}".to_string()),
            headers: HashMap::default(),
            request_id: None,
            sdk_name: Some("ApiError".to_string()),
            retry_after_ms: None,
            provider_error_type: None,
        });
        let info = extract_stream_failure_info(&error);
        assert_eq!(info.provider_error_type.as_deref(), Some("ApiError"));
        assert_eq!(info.kind, StreamFailureKind::RateLimit);
        assert_eq!(
            format_stream_failure_message(&error),
            "Provider rate limit exceeded (ApiError, 429)"
        );
        assert_eq!(
            diagnostic_error_info(&error).name.as_deref(),
            Some("ApiError")
        );

        // An explicit `err.code` beats both the body type and the class name,
        // and the error-resolved wait beats the header.
        let mut headers = std::collections::HashMap::new();
        headers.insert("retry-after".to_string(), "1".to_string());
        let error = ProviderError::Http(ProviderHttpError {
            message: "boom".to_string(),
            status: Some(429),
            body: None,
            headers,
            request_id: None,
            sdk_name: Some("CodexApiError".to_string()),
            retry_after_ms: Some(60_000),
            provider_error_type: Some("usage_limit_reached".to_string()),
        });
        let info = extract_stream_failure_info(&error);
        assert_eq!(
            info.provider_error_type.as_deref(),
            Some("usage_limit_reached")
        );
        assert_eq!(info.retry_after_ms, Some(60_000));
        assert_eq!(
            diagnostic_error_info(&error).name.as_deref(),
            Some("CodexApiError")
        );
    }

    /// The google `ApiError` carrier: the class name is the qualifier and
    /// the classified form carries no detail (the genai `ApiError` exposes
    /// no `.error` object to the TS classifier); unnamed plumbing errors
    /// fall back to the plain JS "Error" the Stainless SDK family records.
    #[test]
    fn http_error_records_sdk_name() {
        let mut named = ProviderError::from_http_status_body(
            400,
            "{\"error\":{\"code\":400,\"message\":\"bad\"}}",
            HashMap::default(),
        );
        if let ProviderError::Http(http) = &mut named {
            http.sdk_name = Some("ApiError".to_string());
            http.body = None;
        }
        assert_eq!(
            diagnostic_error_info(&named).name.as_deref(),
            Some("ApiError")
        );
        assert_eq!(
            format_stream_failure_message(&named),
            "Provider rejected the request (ApiError, 400)"
        );

        let unnamed = ProviderError::from_http_status_body(
            400,
            "{\"error\":{\"type\":\"invalid_request_error\",\"message\":\"bad\"}}",
            HashMap::default(),
        );
        assert_eq!(
            diagnostic_error_info(&unnamed).name.as_deref(),
            Some("Error")
        );
        assert_eq!(
            format_stream_failure_message(&unnamed),
            "Provider rejected the request (invalid_request_error, 400): bad"
        );
    }
}
