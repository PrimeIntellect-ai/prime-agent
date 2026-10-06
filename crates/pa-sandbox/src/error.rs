//! Typed, redacted errors for the sandbox lifecycle client.
//!
//! Port of the `PrimeSandboxError` + preview-scrubbing half of
//! `prime-sandbox-client.ts` (TS branch `feat/direct-cloud-sandbox`):
//! - every failure is a typed code, never a bare string;
//! - no secret (API key) ever appears in a message, URL, or `details`
//!   preview;
//! - a non-2xx response body surfaces as a bounded (512 chars),
//!   secret-scrubbed `details` preview: JSON bodies are key-scrubbed
//!   (`authorization`, `api[-_]?key`, `token`, `secret`, `password`)
//!   then string-redacted; plain-text bodies are string-redacted.

use crate::types::Method;
use thiserror::Error;

/// Cap for the `details` preview of an error response body (TS
/// `MAX_RESPONSE_PREVIEW_CHARS`).
pub const MAX_RESPONSE_PREVIEW_CHARS: usize = 512;

/// The failure codes, wire-identical to the TS `PrimeSandboxErrorCode` set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxErrorCode {
    /// A caller-supplied argument failed local validation; nothing was sent.
    InvalidRequest,
    /// The request could not reach the server (connection refused, DNS,
    /// broken connection mid-read).
    Network,
    /// The per-request deadline elapsed before the server answered.
    Timeout,
    /// A non-2xx response with no more specific mapping.
    Http,
    /// A 2xx response body failed strict parsing; never a silent default.
    InvalidResponse,
    /// A response body exceeded the JSON body cap (32 MiB).
    TooLarge,
    /// The sandbox reached `ERROR`/`TERMINATED`/`TIMEOUT` while waiting for
    /// `RUNNING`.
    TerminalStatus,
    /// Server-reported request timeout (HTTP 408).
    RequestTimeout,
    /// Server-reported conflict (HTTP 409), typically transient.
    Conflict,
    /// Gateway 502 with `{ "error": "sandbox_not_found" }`: the sandbox is
    /// gone.
    SandboxNotFound,
}

impl SandboxErrorCode {
    /// The wire name, identical to the TS code strings.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::Network => "network",
            Self::Timeout => "timeout",
            Self::Http => "http",
            Self::InvalidResponse => "invalid_response",
            Self::TooLarge => "too_large",
            Self::TerminalStatus => "terminal_status",
            Self::RequestTimeout => "request_timeout",
            Self::Conflict => "conflict",
            Self::SandboxNotFound => "sandbox_not_found",
        }
    }
}

/// A typed, redacted sandbox client failure.
///
/// `details` carries a bounded, secret-scrubbed preview of a non-2xx
/// response body; messages never contain the API key. Build with the
/// code-specific constructors ([`SandboxError::invalid_request`],
/// [`SandboxError::network`], ...) and attach HTTP context with
/// [`SandboxError::with_http_context`].
#[derive(Debug, Error)]
#[error("{message}")]
pub struct SandboxError {
    code: SandboxErrorCode,
    message: String,
    method: Option<Method>,
    url: Option<String>,
    status: Option<u16>,
    details: Option<String>,
}

impl SandboxError {
    /// A local validation failure; nothing was sent.
    #[must_use]
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(SandboxErrorCode::InvalidRequest, message)
    }

    /// A strict-response-parsing failure.
    #[must_use]
    pub fn invalid_response(message: impl Into<String>) -> Self {
        Self::new(SandboxErrorCode::InvalidResponse, message)
    }

    /// A connection-level failure.
    #[must_use]
    pub fn network(message: impl Into<String>) -> Self {
        Self::new(SandboxErrorCode::Network, message)
    }

    /// A deadline failure.
    #[must_use]
    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(SandboxErrorCode::Timeout, message)
    }

    /// The sandbox reached a terminal status while waiting.
    #[must_use]
    pub fn terminal_status(message: impl Into<String>) -> Self {
        Self::new(SandboxErrorCode::TerminalStatus, message)
    }

    /// A response body over the JSON cap.
    #[must_use]
    pub fn too_large(message: impl Into<String>) -> Self {
        Self::new(SandboxErrorCode::TooLarge, message)
    }

    /// A server-reported request timeout (HTTP 408).
    #[must_use]
    pub fn request_timeout(message: impl Into<String>) -> Self {
        Self::new(SandboxErrorCode::RequestTimeout, message)
    }

    /// A server-reported conflict (HTTP 409), typically transient.
    #[must_use]
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(SandboxErrorCode::Conflict, message)
    }

    /// A sandbox that is no longer present on the runtime node (gateway 502
    /// with `{ "error": "sandbox_not_found" }`).
    #[must_use]
    pub fn sandbox_not_found(message: impl Into<String>) -> Self {
        Self::new(SandboxErrorCode::SandboxNotFound, message)
    }

    /// A non-2xx response with no more specific mapping.
    #[must_use]
    pub fn http(message: impl Into<String>) -> Self {
        Self::new(SandboxErrorCode::Http, message)
    }

    fn new(code: SandboxErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            method: None,
            url: None,
            status: None,
            details: None,
        }
    }

    /// The typed code.
    #[must_use]
    pub fn code(&self) -> SandboxErrorCode {
        self.code
    }

    /// The request method, when the failure carries HTTP context.
    #[must_use]
    pub fn method(&self) -> Option<Method> {
        self.method
    }

    /// The sanitized request URL (never carries credentials).
    #[must_use]
    pub fn url(&self) -> Option<&str> {
        self.url.as_deref()
    }

    /// The HTTP status for status-mapped codes.
    #[must_use]
    pub fn status(&self) -> Option<u16> {
        self.status
    }

    /// The bounded, secret-scrubbed response preview.
    #[must_use]
    pub fn details(&self) -> Option<&str> {
        self.details.as_deref()
    }

    /// True for the transient codes the create retry loop tolerates.
    #[must_use]
    pub fn is_transient_transport(&self) -> bool {
        matches!(
            self.code,
            SandboxErrorCode::Network | SandboxErrorCode::Timeout
        )
    }

    /// Attach a `details` preview without HTTP context (wait outcomes).
    #[must_use]
    pub fn with_details(mut self, details: Option<String>) -> Self {
        if details.is_some() {
            self.details = details;
        }
        self
    }

    /// Attach the request context (method, url, status, details) to a status
    /// or response error, mirroring the TS error properties.
    #[must_use]
    pub fn with_http_context(
        mut self,
        method: Method,
        url: impl Into<String>,
        status: Option<u16>,
        details: Option<String>,
    ) -> Self {
        self.method = Some(method);
        self.url = Some(url.into());
        self.status = status;
        if details.is_some() {
            self.details = details;
        }
        self
    }

    /// True when the key name marks a secret value (TS
    /// `REDACTED_KEY_PATTERN`): `authorization`, `api[-_]?key`, `token`,
    /// `secret`, or `password`, case-insensitive.
    fn is_secret_key(key: &str) -> bool {
        let lowered = key.to_lowercase();
        lowered.contains("authorization")
            || lowered.contains("token")
            || lowered.contains("secret")
            || lowered.contains("password")
            || lowered.contains("apikey")
            || lowered.contains("api-key")
            || lowered.contains("api_key")
    }

    /// Scrub secret-bearing keys from a parsed JSON value, recursively (TS
    /// `scrubJsonSecrets`).
    #[must_use]
    pub fn scrub_json_secrets(value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Array(entries) => {
                serde_json::Value::Array(entries.iter().map(Self::scrub_json_secrets).collect())
            }
            serde_json::Value::Object(map) => {
                let mut scrubbed = serde_json::Map::with_capacity(map.len());
                for (key, entry) in map {
                    let scrubbed_value = if Self::is_secret_key(key) {
                        serde_json::Value::from("[redacted]")
                    } else {
                        Self::scrub_json_secrets(entry)
                    };
                    // serde_json preserve_order: insertion order is kept,
                    // so the preview keeps the body's own field order.
                    scrubbed.insert(key.clone(), scrubbed_value);
                }
                serde_json::Value::Object(scrubbed)
            }
            other => other.clone(),
        }
    }

    /// Replace every occurrence of a known secret with `[redacted]` (TS
    /// `redactSecrets`).
    #[must_use]
    pub fn redact_secrets(text: &str, secrets: &[&str]) -> String {
        let mut redacted = text.to_string();
        for secret in secrets {
            if !secret.is_empty() {
                redacted = redacted.replace(secret, "[redacted]");
            }
        }
        redacted
    }

    /// Bound a preview to [`MAX_RESPONSE_PREVIEW_CHARS`] (TS
    /// `boundPreview`).
    #[must_use]
    pub fn bound_preview(text: &str) -> String {
        if text.len() <= MAX_RESPONSE_PREVIEW_CHARS {
            text.to_string()
        } else {
            // The char boundary keeps the truncation valid UTF-8; preview
            // quality beyond the cap does not matter.
            let mut end = MAX_RESPONSE_PREVIEW_CHARS;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}\u{2026}", &text[..end])
        }
    }

    /// Build a bounded, secret-scrubbed preview from an error-response body:
    /// JSON bodies are key-scrubbed and re-serialized, plain bodies are
    /// string-redacted, and known secret strings are redacted either way
    /// (TS `previewFromText`).
    #[must_use]
    pub fn preview_from_text(text: &str, secrets: &[&str]) -> Option<String> {
        if text.is_empty() {
            return None;
        }
        match serde_json::from_str::<serde_json::Value>(text) {
            Ok(parsed) => Some(Self::bound_preview(&Self::redact_secrets(
                &Self::scrub_json_secrets(&parsed).to_string(),
                secrets,
            ))),
            Err(_) => Some(Self::bound_preview(&Self::redact_secrets(text, secrets))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_keys_are_detected_case_insensitively() {
        for key in [
            "Authorization",
            "authorization",
            "x-api-key",
            "API_KEY",
            "apikey",
            "refreshToken",
            "client_secret",
            "userPassword",
        ] {
            assert!(SandboxError::is_secret_key(key), "{key}");
        }
        for key in ["name", "docker_image", "id", "createdAt"] {
            assert!(!SandboxError::is_secret_key(key), "{key}");
        }
    }

    #[test]
    fn json_previews_scrub_secret_keys_and_values() {
        let body =
            r#"{"detail":"denied","api_key":"sk-live-abcdef","nested":{"token":"t1","ok":1}}"#;
        let preview = SandboxError::preview_from_text(body, &["sk-live-abcdef"]).unwrap();
        assert!(preview.contains("\"api_key\":\"[redacted]\""));
        assert!(preview.contains("\"token\":\"[redacted]\""));
        assert!(preview.contains("denied"));
        assert!(!preview.contains("sk-live-abcdef"));
        // Field order is preserved (serde_json preserve_order).
        assert!(preview.starts_with("{\"detail\":"));
    }

    #[test]
    fn plain_previews_redact_known_secrets_only() {
        let body = "oops sk-live-abcdef happened";
        let preview = SandboxError::preview_from_text(body, &["sk-live-abcdef"]).unwrap();
        assert_eq!(preview, "oops [redacted] happened");
    }

    #[test]
    fn previews_are_bounded() {
        let body = "a".repeat(MAX_RESPONSE_PREVIEW_CHARS + 40);
        let preview = SandboxError::preview_from_text(&body, &[]).unwrap();
        assert_eq!(preview.len(), MAX_RESPONSE_PREVIEW_CHARS + "\u{2026}".len());
        assert!(preview.ends_with('\u{2026}'));
    }

    #[test]
    fn codes_round_trip_the_ts_wire_names() {
        assert_eq!(SandboxErrorCode::InvalidRequest.as_str(), "invalid_request");
        assert_eq!(SandboxErrorCode::TerminalStatus.as_str(), "terminal_status");
        assert_eq!(
            SandboxErrorCode::SandboxNotFound.as_str(),
            "sandbox_not_found"
        );
    }
}
