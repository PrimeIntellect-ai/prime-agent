//! `OpenAI` Completions error surface: the user-facing error message for a failed request, composed
//! exactly like the `openai` npm SDK (`APIError.makeMessage`, openai 6.47.0), which the TS provider
//! surfaces verbatim.

use serde_json::Value;

use crate::utils_inner::stream_failure::{ProviderError, ProviderHttpError};

/// Build the user-facing message for a non-OK provider response, mirroring the `openai` SDK's
/// `APIError` text (which `streamOpenAICompletions` copies into the assistant message's error
/// message as-is):
///
/// - JSON body whose `error.message` is a non-empty string: `"{status} {message}"`.
/// - JSON body whose `error` is present without a usable message: `"{status} {error}"`
///   (stringified).
/// - JSON body without a usable `error` field: `"{status} status code (no body)"`.
/// - Non-JSON body: `"{status} {raw body}"`; empty body: `"{status} status code (no body)"`.
///
/// JS truthiness decides "usable" (`null`/`false`/`0`/`""` are falsy). Two accepted stringification
/// divergences (real provider error bodies carry a string `error.message`): serde renders `1.0` as
/// `1.0` where `JSON.stringify` renders `1`, and object keys sort alphabetically where JS keeps
/// body order.
pub fn openai_sdk_error_message(status: u16, body: &str) -> String {
    let parsed = match serde_json::from_str::<Value>(body) {
        Ok(value) if js_truthy(&value) => Some(value),
        _ => None,
    };
    // The SDK's message argument only carries the raw text when the body did not parse as (truthy)
    // JSON.
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

/// Build the error for a non-OK provider response: the SDK-style message plus the structured pieces
/// (`status`, body, headers) the stream-failure classification reads for diagnostics and retry
/// decisions.
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
        // The openai SDK errors do not set `error.name`: the TS diagnostic records the inherited
        // plain JS "Error".
        sdk_name: None,
        retry_after_ms: None,
        provider_error_type: None,
    })
}

/// The `OpenRouter` extra-information field the TS provider appends to the error message:
/// `error.metadata.raw` on the SDK error (the response body's `error` object). `None` unless truthy
/// per JS rules.
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

/// JS `String(value)` coercion for the template-literal append in the TS provider. Objects
/// stringify as `"[object Object]"`, arrays join their elements with `,` (recursively,
/// `null`/`undefined` as empty).
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
        // The Cerebras context-overflow pattern matches this empty-body text.
        assert_eq!(
            openai_sdk_error_message(400, ""),
            "400 status code (no body)"
        );
    }
}
