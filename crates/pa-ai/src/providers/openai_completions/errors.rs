//! `OpenAI` Completions error surface.
//! Section of the port of `packages/ai/src/providers/openai-completions.ts`:
//! the user-facing error message for a failed request, composed exactly like
//! the `openai` npm SDK (`APIError.makeMessage`, openai 6.47.0) whose message
//! the TS provider surfaces verbatim — unlike the anthropic/responses
//! providers, which classify through `formatStreamFailureMessage`.

use serde_json::Value;

use crate::utils_inner::stream_failure::{ProviderError, ProviderHttpError};

/// Build the user-facing message for a non-OK provider response, mirroring the
/// `openai` SDK's `APIError` text (which `streamOpenAICompletions` copies into
/// the assistant message's error message as-is):
///
/// - JSON body whose `error.message` is a non-empty string: `"{status} {message}"`.
/// - JSON body whose `error` is present without a usable message:
///   `"{status} {error}"` (stringified).
/// - JSON body without a usable `error` field: `"{status} status code (no body)"`.
/// - Non-JSON body: `"{status} {raw body}"`; empty body: `"{status} status code
///   (no body)"`.
///
/// JS truthiness decides "usable" (`null`/`false`/`0`/`""` are falsy). Two
/// stringification divergences are accepted for non-string payloads and
/// key-less-order objects (real provider error bodies carry a string
/// `error.message`): serde renders `1.0` as `1.0` where `JSON.stringify`
/// renders `1`, and object keys sort alphabetically where JS keeps body order.
pub fn openai_sdk_error_message(status: u16, body: &str) -> String {
    let parsed = match serde_json::from_str::<Value>(body) {
        Ok(value) if js_truthy(&value) => Some(value),
        _ => None,
    };
    // The SDK's message argument only carries the raw text when the body did
    // not parse as (truthy) JSON.
    let err_message = parsed.is_none().then_some(body);
    let error = parsed
        .as_ref()
        .and_then(|value| value.get("error"))
        .filter(|error| js_truthy(error));
    let msg = match error {
        Some(error) => match error.get("message").filter(|message| js_truthy(message)) {
            Some(Value::String(message)) => Some(message.clone()),
            Some(message) => Some(message.to_string()),
            None => Some(error.to_string()),
        },
        None => err_message.map(str::to_string),
    };
    match msg.filter(|msg| !msg.is_empty()) {
        Some(msg) => format!("{status} {msg}"),
        None => format!("{status} status code (no body)"),
    }
}

/// Build the error for a non-OK provider response: the SDK-style message plus
/// the structured pieces (`status`, body, headers) the stream-failure
/// classification reads for diagnostics and retry decisions.
pub fn openai_http_error(
    status: u16,
    body: &str,
    headers: std::collections::HashMap<String, String>,
) -> ProviderError {
    ProviderError::Http(ProviderHttpError {
        message: openai_sdk_error_message(status, body),
        status: Some(status),
        body: Some(body.to_string()),
        headers,
        request_id: None,
        // The openai SDK errors do not set `error.name`: the TS diagnostic
        // records the inherited plain JS "Error".
        sdk_name: None,
        retry_after_ms: None,
        provider_error_type: None,
    })
}

/// The `OpenRouter` extra-information field the TS provider appends to the
/// error message: `error.metadata.raw` on the SDK error (the response body's
/// `error` object). `None` unless truthy per JS rules.
pub fn openrouter_raw_metadata(error: &ProviderError) -> Option<String> {
    let body = match error {
        ProviderError::Http(http) => http.body.as_deref()?,
        _ => return None,
    };
    let parsed = serde_json::from_str::<Value>(body).ok()?;
    let raw = parsed.get("error")?.get("metadata")?.get("raw")?.clone();
    js_truthy(&raw).then(|| js_to_string(&raw))
}

/// JS truthiness for JSON values: `null`, `false`, `0`, and `""` are falsy;
/// every other value is truthy.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(bool) => *bool,
        Value::Number(number) => number.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// JS `String(value)` coercion for the template-literal append in the TS
/// provider. Objects stringify as `"[object Object]"`, arrays join their
/// elements with `,` (recursively, `null`/`undefined` as empty).
fn js_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(bool) => bool.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Null => String::new(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact composition the TS `openai` SDK produces for an `OpenAI` error
    /// body and the TS provider surfaces verbatim (the parity harness's
    /// scripted overflow probe: `{"error": {"message": ...}}` with status 400).
    #[test]
    fn sdk_message_from_error_body_message() {
        let body =
            r#"{"error": {"message": "prompt is too long: 213462 tokens > 200000 maximum"}}"#;
        assert_eq!(
            openai_sdk_error_message(400, body),
            "400 prompt is too long: 213462 tokens > 200000 maximum"
        );
    }

    #[test]
    fn sdk_message_compositions() {
        // `error.type`/`error.code` qualifiers ride along inside the message.
        assert_eq!(
            openai_sdk_error_message(
                429,
                r#"{"error": {"message": "Rate limit", "type": "rate_limit_error"}}"#
            ),
            "429 Rate limit"
        );
        // Non-JSON body: the raw text becomes the detail.
        assert_eq!(
            openai_sdk_error_message(500, "upstream exploded"),
            "500 upstream exploded"
        );
        // JSON body without an `error` field: no detail is recoverable.
        assert_eq!(
            openai_sdk_error_message(400, r#"{"detail": "bad request"}"#),
            "400 status code (no body)"
        );
        // Empty body.
        assert_eq!(
            openai_sdk_error_message(400, ""),
            "400 status code (no body)"
        );
        // `error` without a usable message stringifies the whole object.
        assert_eq!(
            openai_sdk_error_message(400, r#"{"error": {"code": "x"}}"#),
            r#"400 {"code":"x"}"#
        );
        // Falsy `error.message` falls back to stringifying `error`.
        assert_eq!(
            openai_sdk_error_message(400, r#"{"error": {"message": ""}}"#),
            r#"400 {"message":""}"#
        );
        // Non-string truthy `error.message` stringifies the message value.
        assert_eq!(
            openai_sdk_error_message(400, r#"{"error": {"message": 42}}"#),
            "400 42"
        );
        // Falsy `error` (JSON null) leaves the message argument, which a JSON
        // body leaves undefined.
        assert_eq!(
            openai_sdk_error_message(400, r#"{"error": null}"#),
            "400 status code (no body)"
        );
        // Whitespace body parses as nothing and carries the raw text.
        assert_eq!(openai_sdk_error_message(400, "  "), "400   ");
    }

    #[test]
    fn http_error_carries_structured_pieces() {
        let mut headers = std::collections::HashMap::new();
        headers.insert("x-request-id".to_string(), "req_1".to_string());
        let error = openai_http_error(400, r#"{"error": {"message": "bad"}}"#, headers.clone());
        let http = match &error {
            ProviderError::Http(http) => http,
            other => panic!("expected http error, got {other:?}"),
        };
        assert_eq!(http.message, "400 bad");
        assert_eq!(http.status, Some(400));
        assert_eq!(
            http.headers.get("x-request-id").map(String::as_str),
            Some("req_1")
        );
    }

    #[test]
    fn openrouter_metadata_appends_only_when_truthy() {
        let body = r#"{"error": {"message": "boom", "metadata": {"raw": "extra context"}}}"#;
        let error = openai_http_error(400, body, HashMap::default());
        assert_eq!(
            openrouter_raw_metadata(&error).as_deref(),
            Some("extra context")
        );

        let no_metadata =
            openai_http_error(400, r#"{"error": {"message": "boom"}}"#, HashMap::default());
        assert_eq!(openrouter_raw_metadata(&no_metadata), None);

        let falsy = openai_http_error(
            400,
            r#"{"error": {"message": "boom", "metadata": {"raw": ""}}}"#,
            HashMap::default(),
        );
        assert_eq!(openrouter_raw_metadata(&falsy), None);

        // Non-HTTP errors never carry the field.
        assert_eq!(
            openrouter_raw_metadata(&ProviderError::Message("boom".into())),
            None
        );
    }
}
