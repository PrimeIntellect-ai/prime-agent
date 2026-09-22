//! Codex API error types and event mapping.
//! Section of the port of
//! `packages/ai/src/providers/openai-codex-responses.ts`.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::types::{AssistantMessage, Usage};
use crate::utils::stream_failure::parse_retry_after_ms;
use crate::utils_inner::diagnostics::now_ms;
use crate::utils_inner::http::HttpResponse;
use crate::utils_inner::stream_failure::ProviderError;

/// Codex API error (`CodexApiError` in the TS reference). Carries the wire
/// error code, HTTP status, and retry delay parsed from headers/body.
#[derive(Debug, Clone)]
#[allow(dead_code)] // full TS error surface; fields are read by future retry plumbing
pub struct CodexApiError {
    pub message: String,
    pub code: Option<String>,
    pub status: Option<u16>,
    pub retry_after_ms: Option<u64>,
    pub payload: Option<Value>,
}

impl CodexApiError {
    #[allow(dead_code)] // parity helper; the transport loops build the struct literally
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            status: None,
            retry_after_ms: None,
            payload: None,
        }
    }

    /// The TS provider surfaces `CodexApiError.message` verbatim (its catch
    /// sets `output.errorMessage = error.message`, keeping the usage-limit
    /// friendly text); the structured pieces ride along for the
    /// `provider_stream_failure` diagnostic and retry classification.
    pub fn into_provider_error(self) -> ProviderError {
        ProviderError::Http(crate::utils_inner::stream_failure::ProviderHttpError {
            message: self.message,
            status: self.status,
            // The TS error carries its wire `code` and no body/error field:
            // the classification reads the code, not a parsed body.
            body: None,
            headers: HashMap::new(),
            request_id: None,
            sdk_name: Some("CodexApiError".to_string()),
            retry_after_ms: self.retry_after_ms,
            provider_error_type: self.code,
        })
    }
}

impl std::fmt::Display for CodexApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Codex protocol (framing/JSON) error (`CodexProtocolError` in the TS).
#[derive(Debug, Clone)]
pub struct CodexProtocolError {
    pub message: String,
    /// The invalid frame the TS error keeps for debugging; user-facing text
    /// never embeds it.
    #[allow(dead_code)] // full TS error surface; parity helper for debugging
    pub payload: Option<Value>,
}

impl CodexProtocolError {
    pub fn into_provider_error(self) -> ProviderError {
        // TS surfaces `CodexProtocolError.message` verbatim; the payload
        // stays on the error (here: nowhere user-facing), and the class name
        // is recorded for the diagnostic.
        ProviderError::Http(crate::utils_inner::stream_failure::ProviderHttpError {
            message: self.message,
            status: None,
            body: None,
            headers: HashMap::new(),
            request_id: None,
            sdk_name: Some("CodexProtocolError".to_string()),
            retry_after_ms: None,
            provider_error_type: None,
        })
    }
}

/// The TS WebSocket transport-error surface, probe-verified against the TS
/// binary (bun runtime): close-event failures compose the
/// `WebSocket closed {code} {reason}` message, carry the numeric close code
/// the diagnostics record, and record the `WebSocketCloseError` class name;
/// every other runtime failure (connect, send) is a plain `Error` with no
/// close code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebSocketTransportError {
    /// A close-event failure (`WebSocketCloseError` in the TS): the composed
    /// close message plus the numeric close code.
    Close { message: String, code: u16 },
    /// A connect- or send-phase runtime failure (plain `Error` in the TS).
    Runtime { message: String },
}

/// Close code the TS runtime reports for a close frame that carries none
/// (WHATWG `Status`; probe-pinned as "WebSocket closed 1005").
pub const WEBSOCKET_CLOSE_CODE_STATUS: u16 = 1005;
/// Close code the runtime reports for a socket death without a close frame.
pub const WEBSOCKET_CLOSE_CODE_ABNORMAL: u16 = 1006;
/// Close code the runtime reports for frames it cannot parse.
pub const WEBSOCKET_CLOSE_CODE_PROTOCOL: u16 = 1002;
/// Close code for a message the runtime refuses as too big.
pub const WEBSOCKET_CLOSE_CODE_TOO_BIG: u16 = 1009;
/// The runtime's close-event reason for an abrupt socket death.
pub const WEBSOCKET_CONNECTION_ENDED_REASON: &str = "Connection ended";

impl WebSocketTransportError {
    /// Port of `extractWebSocketCloseError`'s composition:
    /// `WebSocket closed {code} {reason}` (trimmed), with the 1009 no-reason
    /// special case (`"message too big"`).
    pub fn close(code: u16, reason: &str) -> Self {
        let mut reason_text = if reason.is_empty() {
            String::new()
        } else {
            format!(" {reason}")
        };
        if reason_text.is_empty() && code == WEBSOCKET_CLOSE_CODE_TOO_BIG {
            reason_text = " message too big".to_string();
        }
        let message = format!("WebSocket closed {code}{reason_text}")
            .trim()
            .to_string();
        Self::Close { message, code }
    }

    /// A plain runtime failure (`Error` in the TS) with the given text.
    pub fn runtime(message: impl Into<String>) -> Self {
        Self::Runtime {
            message: message.into(),
        }
    }

    /// The TS error class name the diagnostics record (`error.name`).
    pub fn error_name(&self) -> &'static str {
        match self {
            Self::Close { .. } => "WebSocketCloseError",
            Self::Runtime { .. } => "Error",
        }
    }

    /// The numeric close code the TS diagnostic records (`error.code`);
    /// plain runtime failures carry none.
    pub fn close_code(&self) -> Option<u16> {
        match self {
            Self::Close { code, .. } => Some(*code),
            Self::Runtime { .. } => None,
        }
    }

    /// The user-facing text (TS `error.message`).
    pub fn message(&self) -> &str {
        match self {
            Self::Close { message, .. } | Self::Runtime { message } => message,
        }
    }
}

impl std::fmt::Display for WebSocketTransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

/// Unified in-band stream error used by the transport loops.
#[derive(Debug, Clone)]
pub enum CodexStreamError {
    Api(CodexApiError),
    Protocol(CodexProtocolError),
    /// Transport-level failure (WebSocket close/connect error) with the TS
    /// runtime's error surface.
    Transport(WebSocketTransportError),
    /// Abort requested by the cancellation token.
    Aborted,
}

impl From<ProviderError> for CodexStreamError {
    fn from(error: ProviderError) -> Self {
        match error {
            ProviderError::Aborted => CodexStreamError::Aborted,
            other => CodexStreamError::Api(CodexApiError {
                message: other.to_string(),
                code: None,
                status: None,
                retry_after_ms: None,
                payload: None,
            }),
        }
    }
}

impl CodexStreamError {
    pub fn into_provider_error(self) -> ProviderError {
        match self {
            CodexStreamError::Api(error) => error.into_provider_error(),
            CodexStreamError::Protocol(error) => error.into_provider_error(),
            CodexStreamError::Transport(error) => ProviderError::Transport(
                crate::utils_inner::stream_failure::ProviderWsTransportError {
                    message: error.message().to_string(),
                    close_code: error.close_code(),
                },
            ),
            CodexStreamError::Aborted => ProviderError::Aborted,
        }
    }

    /// Port of `isCodexNonTransportError`.
    pub fn is_non_transport_error(&self) -> bool {
        matches!(
            self,
            CodexStreamError::Api(_) | CodexStreamError::Protocol(_)
        )
    }
}

impl std::fmt::Display for CodexStreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodexStreamError::Api(error) => f.write_str(&error.message),
            CodexStreamError::Protocol(error) => f.write_str(&error.message),
            CodexStreamError::Transport(error) => f.write_str(error.message()),
            CodexStreamError::Aborted => f.write_str("Request was aborted"),
        }
    }
}

/// Port of `isStaleCodexContinuationError`: a `previous_response_not_found`
/// API error means the request must be resent in full instead of chained.
pub fn is_stale_codex_continuation_error(error: &CodexStreamError) -> bool {
    match error {
        CodexStreamError::Api(api) => api
            .code
            .as_deref()
            .map(|code| code.to_lowercase() == STALE_CONTINUATION_ERROR_CODE)
            .unwrap_or(false),
        _ => false,
    }
}

const STALE_CONTINUATION_ERROR_CODE: &str = "previous_response_not_found";

/// Codex error payload fields (`CodexErrorPayload` in the TS).
struct CodexErrorPayload<'a> {
    code: Option<&'a str>,
    type_: Option<&'a str>,
    message: Option<&'a str>,
    plan_type: Option<&'a str>,
    resets_at: Option<i64>,
}

fn error_payload(value: &Value) -> CodexErrorPayload<'_> {
    let str_field = |name: &str| value.get(name).and_then(Value::as_str);
    CodexErrorPayload {
        code: str_field("code"),
        type_: str_field("type"),
        message: str_field("message"),
        plan_type: str_field("plan_type"),
        resets_at: value.get("resets_at").and_then(Value::as_i64),
    }
}

/// Port of `codexUsageLimitMessage`.
fn codex_usage_limit_message(
    error: &CodexErrorPayload<'_>,
    status: Option<u16>,
) -> Option<(String, Option<u64>)> {
    let code = error.code.or(error.type_).unwrap_or("");
    let usage_limit = code_regex_match(code) || status == Some(429);
    if !usage_limit {
        return None;
    }
    let plan = error
        .plan_type
        .map(|plan| format!(" ({plan} plan)"))
        .unwrap_or_default();
    let retry_after_ms = error
        .resets_at
        .map(|resets_at| {
            resets_at
                .saturating_mul(1000)
                .saturating_sub(now_ms() as i64)
        })
        .map(|ms| ms.max(0) as u64);
    let when = retry_after_ms
        .map(|ms| {
            format!(
                " Try again in ~{} min.",
                (ms as f64 / 60_000.0).round() as u64
            )
        })
        .unwrap_or_default();
    let friendly = format!("You have hit your ChatGPT usage limit{plan}.{when}")
        .trim()
        .to_string();
    Some((friendly, retry_after_ms))
}

fn code_regex_match(code: &str) -> bool {
    code.contains("usage_limit_reached")
        || code.contains("usage_not_included")
        || code.contains("rate_limit_exceeded")
}

/// Port of `parseErrorResponse`: map an HTTP error response to a
/// [`CodexApiError`], honoring usage-limit friendly messages and the
/// max(Retry-After header, resets_at) rule.
pub async fn parse_error_response(response: &mut HttpResponse) -> CodexApiError {
    let status = response.status;
    let mut message;
    let mut code: Option<String> = None;
    let mut retry_after_ms = parse_retry_after_ms(&response.headers);

    let raw = response.read_all_text().await.unwrap_or_default();
    // TS: `raw || response.statusText || "Request failed"`. The HTTP reason
    // phrase is the canonical one (what real servers send).
    message = if raw.is_empty() {
        reqwest::StatusCode::from_u16(status)
            .ok()
            .and_then(|status| status.canonical_reason())
            .unwrap_or("Request failed")
            .to_string()
    } else {
        raw.clone()
    };

    if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
        if let Some(err) = parsed.get("error") {
            let payload = error_payload(err);
            code = payload.code.or(payload.type_).map(str::to_string);
            if let Some((friendly, body_retry_after_ms)) =
                codex_usage_limit_message(&payload, Some(status))
            {
                message = friendly;
                // Neither server delay (Retry-After header, resets_at body)
                // may undercut the other.
                if let Some(body_retry_after_ms) = body_retry_after_ms {
                    retry_after_ms = Some(retry_after_ms.unwrap_or(0).max(body_retry_after_ms));
                }
            } else if let Some(err_message) = payload.message {
                message = err_message.to_string();
            }
        }
    }

    CodexApiError {
        message,
        code,
        status: Some(status),
        retry_after_ms,
        payload: serde_json::from_str(&raw).ok(),
    }
}

/// One mapped Codex stream event: either a Responses event to process or an
/// error. `done` marks the terminal event after which the transport closes.
#[derive(Debug)]
pub struct MappedCodexEvent {
    pub event: Value,
    pub done: bool,
}

/// Port of `mapCodexEvents` for one event. Errors arrive flat
/// (`{ code, message }`) or nested under `event.error`.
pub fn map_codex_event(event: Value) -> Result<MappedCodexEvent, CodexStreamError> {
    let Some(event_type) = event.get("type").and_then(Value::as_str) else {
        return Ok(MappedCodexEvent { event, done: false });
    };

    if event_type == "error" {
        let flat_code = event.get("code").and_then(Value::as_str).unwrap_or("");
        let flat_message = event.get("message").and_then(Value::as_str).unwrap_or("");
        let nested = event.get("error").filter(|error| error.is_object());
        let status = event
            .get("status_code")
            .and_then(Value::as_u64)
            .map(|s| s as u16);
        let code = if !flat_code.is_empty() {
            Some(flat_code.to_string())
        } else {
            nested
                .and_then(|nested| {
                    nested
                        .get("code")
                        .and_then(Value::as_str)
                        .or_else(|| nested.get("type").and_then(Value::as_str))
                })
                .map(str::to_string)
        };
        let usage_limit =
            nested.and_then(|nested| codex_usage_limit_message(&error_payload(nested), status));
        let message = if !flat_message.is_empty() {
            flat_message
        } else {
            nested
                .and_then(|nested| nested.get("message").and_then(Value::as_str))
                .unwrap_or("")
        };
        let friendly = usage_limit
            .as_ref()
            .map(|(message, _)| message.clone())
            .unwrap_or_else(|| {
                format!(
                    "Codex error: {}",
                    if message.is_empty() {
                        code.clone().unwrap_or_else(|| event.to_string())
                    } else {
                        message.to_string()
                    }
                )
            });
        return Err(CodexStreamError::Api(CodexApiError {
            message: friendly,
            code,
            status,
            retry_after_ms: usage_limit.and_then(|(_, retry)| retry),
            payload: Some(event),
        }));
    }

    if event_type == "response.failed" {
        let response = event.get("response");
        let code = response
            .and_then(|response| response.pointer("/error/code"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let message = response
            .and_then(|response| response.pointer("/error/message"))
            .and_then(Value::as_str)
            .unwrap_or("Codex response failed")
            .to_string();
        return Err(CodexStreamError::Api(CodexApiError {
            message,
            code,
            status: None,
            retry_after_ms: None,
            payload: Some(event),
        }));
    }

    if event_type == "response.done"
        || event_type == "response.completed"
        || event_type == "response.incomplete"
    {
        let mut normalized = event.clone();
        if let Some(response) = event.get("response") {
            let mut response = response.clone();
            if let Some(status) = response.get("status") {
                let normalized_status = normalize_codex_status(status);
                response["status"] = match normalized_status {
                    Some(status) => json!(status),
                    None => Value::Null,
                };
            }
            normalized["response"] = response;
        }
        normalized["type"] = json!("response.completed");
        return Ok(MappedCodexEvent {
            event: normalized,
            done: true,
        });
    }

    Ok(MappedCodexEvent { event, done: false })
}

/// Port of `normalizeCodexStatus`.
fn normalize_codex_status(status: &Value) -> Option<&'static str> {
    match status.as_str() {
        Some("completed") => Some("completed"),
        Some("incomplete") => Some("incomplete"),
        Some("failed") => Some("failed"),
        Some("cancelled") => Some("cancelled"),
        Some("queued") => Some("queued"),
        Some("in_progress") => Some("in_progress"),
        _ => None,
    }
}

/// Multipliers per https://developers.openai.com/api/docs/pricing
/// (retrieved 2026-08-21). Takes the wire-tier string to match the shared
/// Responses hook signature.
pub fn get_codex_service_tier_cost_multiplier(model_id: &str, service_tier: Option<&str>) -> f64 {
    match service_tier {
        Some("flex") => 0.5,
        Some("priority") => {
            if model_id.starts_with("gpt-5.5") {
                2.5
            } else {
                2.0
            }
        }
        _ => 1.0,
    }
}

/// Port of `applyServiceTierPricing` (codex variant).
pub fn apply_codex_service_tier_pricing(
    usage: &mut Usage,
    service_tier: Option<&str>,
    model_id: &str,
) {
    let multiplier = get_codex_service_tier_cost_multiplier(model_id, service_tier);
    if multiplier == 1.0 {
        return;
    }
    usage.cost.input = (usage.cost.input.as_f64() * multiplier).into();
    usage.cost.output = (usage.cost.output.as_f64() * multiplier).into();
    usage.cost.cache_read = (usage.cost.cache_read.as_f64() * multiplier).into();
    usage.cost.cache_write = (usage.cost.cache_write.as_f64() * multiplier).into();
    usage.cost.total = (usage.cost.input.as_f64()
        + usage.cost.output.as_f64()
        + usage.cost.cache_read.as_f64()
        + usage.cost.cache_write.as_f64())
    .into();
}

/// Port of `resolveCodexServiceTier`.
pub fn resolve_codex_service_tier(
    response_service_tier: Option<String>,
    request_service_tier: Option<String>,
) -> Option<String> {
    if response_service_tier.as_deref() == Some("default")
        && matches!(
            request_service_tier.as_deref(),
            Some("flex") | Some("priority")
        )
    {
        return request_service_tier;
    }
    response_service_tier.or(request_service_tier)
}

/// Port of the transport-failure diagnostic payload. The TS attaches it via
/// `appendAssistantMessageDiagnostic(output, createAssistantMessageDiagnostic(...))`,
/// and `extractDiagnosticError` records the thrown error's runtime class
/// name (`WebSocketCloseError` for close events, plain `Error` otherwise)
/// and, for close events, the numeric close code as `error.code`
/// (TS-binary probe-verified).
pub fn append_transport_failure_diagnostic(
    output: &mut AssistantMessage,
    error: &WebSocketTransportError,
    configured_transport: &str,
    events_emitted: bool,
    request_bytes: usize,
) {
    let diagnostic = crate::utils_inner::diagnostics::create_assistant_message_diagnostic(
        "provider_transport_failure",
        Some(crate::types::DiagnosticErrorInfo {
            name: Some(error.error_name().to_string()),
            message: error.message().to_string(),
            stack: None,
            code: error.close_code().map(|code| {
                crate::types::DiagnosticCode::Num(crate::types::JsNumber::from(u64::from(code)))
            }),
            rest: Default::default(),
        }),
        Some(transport_failure_details(
            configured_transport,
            events_emitted,
            request_bytes,
        )),
    );
    crate::utils_inner::diagnostics::append_assistant_message_diagnostic(output, diagnostic);
}

/// Port of the diagnostic's `details`: the TS sets `fallbackTransport:
/// websocketStarted ? undefined : "sse"`, and `JSON.stringify` omits the
/// undefined key entirely, so the after-start diagnostic carries no key.
fn transport_failure_details(
    configured_transport: &str,
    events_emitted: bool,
    request_bytes: usize,
) -> Value {
    let mut details = serde_json::Map::new();
    details.insert(
        "configuredTransport".to_string(),
        Value::String(configured_transport.to_string()),
    );
    if !events_emitted {
        details.insert(
            "fallbackTransport".to_string(),
            Value::String("sse".to_string()),
        );
    }
    details.insert("eventsEmitted".to_string(), Value::Bool(events_emitted));
    details.insert(
        "phase".to_string(),
        Value::String(
            if events_emitted {
                "after_message_stream_start"
            } else {
                "before_message_stream_start"
            }
            .to_string(),
        ),
    );
    details.insert("requestBytes".to_string(), json!(request_bytes));
    Value::Object(details)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::openai_codex_responses::API_OPENAI_CODEX_RESPONSES;

    #[test]
    fn maps_flat_error_events() {
        let error = map_codex_event(json!({
            "type": "error",
            "code": "usage_limit_reached",
            "message": "limit hit",
            "status_code": 429,
        }))
        .expect_err("error events map to errors");
        let CodexStreamError::Api(api) = &error else {
            panic!("expected API error");
        };
        assert_eq!(api.status, Some(429));
        // Flat errors surface the raw message with the codex prefix (the TS
        // only builds friendly usage-limit text from nested payloads).
        assert_eq!(api.message, "Codex error: limit hit");
    }

    #[test]
    fn maps_response_failed_events() {
        let error = map_codex_event(json!({
            "type": "response.failed",
            "response": { "error": { "code": "server_error", "message": "boom" } },
        }))
        .expect_err("response.failed maps to an API error");
        let CodexStreamError::Api(api) = &error else {
            panic!("expected API error");
        };
        assert_eq!(api.message, "boom");
        assert_eq!(api.code.as_deref(), Some("server_error"));
    }

    #[test]
    fn normalizes_completion_events() {
        for event_type in ["response.done", "response.completed", "response.incomplete"] {
            let mapped = map_codex_event(json!({
                "type": event_type,
                "response": { "status": "completed" },
            }))
            .expect("completion events map through");
            assert!(mapped.done);
            assert_eq!(mapped.event["type"], "response.completed");
            assert_eq!(mapped.event["response"]["status"], "completed");
        }
    }

    #[test]
    fn unknown_statuses_normalize_to_null() {
        let mapped = map_codex_event(json!({
            "type": "response.done",
            "response": { "status": "weird" },
        }))
        .expect("maps through");
        assert!(mapped.event["response"]["status"].is_null());
    }

    #[test]
    fn stale_continuation_detection() {
        let error = CodexStreamError::Api(CodexApiError {
            message: "previous response not found".into(),
            code: Some("Previous_Response_Not_Found".into()),
            status: None,
            retry_after_ms: None,
            payload: None,
        });
        assert!(is_stale_codex_continuation_error(&error));
        assert!(error.is_non_transport_error());
    }

    #[test]
    fn service_tier_multipliers() {
        assert_eq!(
            get_codex_service_tier_cost_multiplier("gpt-5.5-codex", Some("priority")),
            2.5
        );
        assert_eq!(
            get_codex_service_tier_cost_multiplier("gpt-5.4", Some("priority")),
            2.0
        );
        assert_eq!(
            get_codex_service_tier_cost_multiplier("gpt-5.4", Some("flex")),
            0.5
        );
        assert_eq!(
            get_codex_service_tier_cost_multiplier("gpt-5.4", Some("default")),
            1.0
        );
    }

    #[test]
    fn resolves_service_tier_fallbacks() {
        assert_eq!(
            resolve_codex_service_tier(Some("default".to_string()), Some("flex".to_string())),
            Some("flex".to_string())
        );
        assert_eq!(
            resolve_codex_service_tier(None, Some("priority".to_string())),
            Some("priority".to_string())
        );
        assert_eq!(resolve_codex_service_tier(None, None), None);
    }

    /// The TS provider surfaces `CodexApiError.message` verbatim — the
    /// usage-limit friendly text included — instead of the classified
    /// stream-failure rewrite, while the diagnostic keeps the structured
    /// classification (kind, provider type, status, retry delay).
    #[test]
    fn api_error_message_stays_verbatim_with_structured_info() {
        let api_error = CodexApiError {
            message: "You have hit your ChatGPT usage limit (free plan).".to_string(),
            code: Some("usage_limit_reached".to_string()),
            status: Some(429),
            retry_after_ms: Some(60_000),
            payload: None,
        };
        let error = api_error.into_provider_error();
        assert_eq!(
            error.to_string(),
            "You have hit your ChatGPT usage limit (free plan)."
        );
        let info = crate::utils_inner::stream_failure::extract_stream_failure_info(&error);
        assert_eq!(
            info.provider_error_type.as_deref(),
            Some("usage_limit_reached")
        );
        assert_eq!(info.status, Some(429));
        assert_eq!(info.retry_after_ms, Some(60_000));
        assert_eq!(
            crate::utils_inner::stream_failure::StreamFailureKind::RateLimit,
            info.kind
        );
        // The diagnostic records the TS SDK error class name.
        let diagnostic = crate::utils_inner::stream_failure::diagnostic_error_info(&error);
        assert_eq!(diagnostic.name.as_deref(), Some("CodexApiError"));
    }

    /// A plain HTTP-level codex error keeps the server's error message text
    /// (the classified rewrite would turn it into
    /// "Provider rejected the request (400): ...").
    #[test]
    fn api_error_http_message_stays_verbatim() {
        let api_error = CodexApiError {
            message: "The requested model does not exist".to_string(),
            code: Some("not_found_error".to_string()),
            status: Some(400),
            retry_after_ms: None,
            payload: None,
        };
        let error = api_error.into_provider_error();
        assert_eq!(error.to_string(), "The requested model does not exist");
        let info = crate::utils_inner::stream_failure::extract_stream_failure_info(&error);
        assert_eq!(info.provider_error_type.as_deref(), Some("not_found_error"));
        assert_eq!(
            info.kind,
            crate::utils_inner::stream_failure::StreamFailureKind::InvalidRequest
        );
    }

    /// A flat mid-stream error event keeps its "Codex error: ..." composed
    /// message through the provider error.
    #[test]
    fn flat_error_event_message_survives_provider_error() {
        let error = map_codex_event(json!({
            "type": "error",
            "code": "server_error",
            "message": "upstream exploded",
        }))
        .expect_err("error event")
        .into_provider_error();
        assert_eq!(error.to_string(), "Codex error: upstream exploded");
        let info = crate::utils_inner::stream_failure::extract_stream_failure_info(&error);
        assert_eq!(info.provider_error_type.as_deref(), Some("server_error"));
        assert_eq!(
            info.kind,
            crate::utils_inner::stream_failure::StreamFailureKind::ServerError
        );
    }

    /// Protocol errors surface their message verbatim and record the TS
    /// `CodexProtocolError` class name.
    #[test]
    fn protocol_error_message_and_name() {
        let error = CodexStreamError::Protocol(CodexProtocolError {
            message: "Invalid Codex SSE JSON: unexpected token".to_string(),
            payload: Some(Value::String("{oops".to_string())),
        })
        .into_provider_error();
        assert_eq!(
            error.to_string(),
            "Invalid Codex SSE JSON: unexpected token"
        );
        let diagnostic = crate::utils_inner::stream_failure::diagnostic_error_info(&error);
        assert_eq!(diagnostic.name.as_deref(), Some("CodexProtocolError"));
        // The class name is the classification key; it never classifies.
        let info = crate::utils_inner::stream_failure::extract_stream_failure_info(&error);
        assert_eq!(
            info.kind,
            crate::utils_inner::stream_failure::StreamFailureKind::Unknown
        );
    }

    #[test]
    fn passes_plain_events_through() {
        let mapped =
            map_codex_event(json!({ "type": "response.output_text.delta", "delta": "hi" }))
                .expect("plain events pass through");
        assert!(!mapped.done);
        assert_eq!(mapped.event["type"], "response.output_text.delta");
    }

    /// The transport-failure diagnostic for a close event, before the SSE
    /// fallback (TS-binary probe ground truth): the `WebSocketCloseError`
    /// name, the numeric close code as `error.code`, and the fallback
    /// details; `error.code` is absent for non-close runtime failures.
    #[test]
    fn transport_failure_diagnostic_shapes() {
        let close = WebSocketTransportError::close(1011, "mock server reason");
        let runtime = WebSocketTransportError::runtime(
            "WebSocket connection to 'ws://127.0.0.1:1/codex/responses' failed: Failed to connect",
        );

        let mut output = AssistantMessage {
            content: Vec::new(),
            api: API_OPENAI_CODEX_RESPONSES.to_string(),
            provider: "openai-codex".to_string(),
            model: "gpt-5-codex".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: crate::types::Usage::default(),
            stop_reason: crate::types::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: Default::default(),
        };
        append_transport_failure_diagnostic(&mut output, &close, "auto", false, 23_377);
        append_transport_failure_diagnostic(&mut output, &runtime, "auto", true, 23_361);
        let diagnostics = serde_json::to_value(output.diagnostics.as_deref()).unwrap();
        assert_eq!(
            diagnostics,
            json!([
                {
                    "type": "provider_transport_failure",
                    "timestamp": diagnostics[0]["timestamp"],
                    "error": {
                        "name": "WebSocketCloseError",
                        "message": "WebSocket closed 1011 mock server reason",
                        "code": 1011
                    },
                    "details": {
                        "configuredTransport": "auto",
                        "fallbackTransport": "sse",
                        "eventsEmitted": false,
                        "phase": "before_message_stream_start",
                        "requestBytes": 23377
                    }
                },
                {
                    "type": "provider_transport_failure",
                    "timestamp": diagnostics[1]["timestamp"],
                    "error": {
                        "name": "Error",
                        "message": "WebSocket connection to 'ws://127.0.0.1:1/codex/responses' failed: Failed to connect"
                    },
                    "details": {
                        "configuredTransport": "auto",
                        "eventsEmitted": true,
                        "phase": "after_message_stream_start",
                        "requestBytes": 23361
                    }
                }
            ])
        );
    }

    /// A transport error thrown mid-stream (after events were emitted)
    /// carries its TS surface through the provider error: the verbatim
    /// runtime text, the `WebSocketCloseError` name, and the close code —
    /// exactly what the TS `provider_stream_failure` diagnostic records
    /// (TS-binary probe ground truth).
    #[test]
    fn transport_error_provider_stream_failure_shape() {
        let error =
            CodexStreamError::Transport(WebSocketTransportError::close(1011, "mock server reason"))
                .into_provider_error();
        assert_eq!(
            error.to_string(),
            "WebSocket closed 1011 mock server reason"
        );
        let mut output = AssistantMessage {
            content: Vec::new(),
            api: API_OPENAI_CODEX_RESPONSES.to_string(),
            provider: "openai-codex".to_string(),
            model: "gpt-5-codex".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: crate::types::Usage::default(),
            stop_reason: crate::types::StopReason::Error,
            stop_reason_raw: None,
            error_message: Some(error.to_string()),
            timestamp: 0,
            rest: Default::default(),
        };
        crate::utils_inner::stream_failure::record_stream_failure(
            ("openai-codex", "gpt-5-codex", API_OPENAI_CODEX_RESPONSES),
            &mut output,
            &error,
        );
        let diagnostics = serde_json::to_value(output.diagnostics.as_deref()).unwrap();
        assert_eq!(
            diagnostics,
            json!([
                {
                    "type": "provider_stream_failure",
                    "timestamp": diagnostics[0]["timestamp"],
                    "error": {
                        "name": "WebSocketCloseError",
                        "message": "WebSocket closed 1011 mock server reason",
                        "code": 1011
                    },
                    "details": {
                        "kind": "unknown",
                        "providerErrorType": "WebSocketCloseError"
                    }
                }
            ])
        );
    }
}
