//! The #2117 error classifier: a failed model call's message becomes a
//! fixed (category, subtype, code, `http_status`) tuple plus a fixed
//! diagnostic, with the message policy keeping raw provider text out.
//!
//! Classification order (the TS `classifyTelemetryError`): structured
//! evidence first - a bounded HTTP status, then a recognized safe error
//! code - then the reviewed fixed-string message set, then nothing: an
//! unmatched message classifies as subtype `unknown` with the generic
//! diagnostic, and the raw text never uploads (only its length and a
//! redaction flag). Reviewed fixed strings are the ONLY message text that
//! may ride an event; they are application-authored, never provider text.

/// The fixed diagnostic messages per subtype (#2117
/// `TELEMETRY_ERROR_MESSAGES`). These are the only error descriptions
/// eligible for upload.
pub const ERROR_DIAGNOSTICS: &[(&str, &str)] = &[
    ("credential_missing", "No API key found for [provider]."),
    (
        "credential_invalid",
        "Provider rejected the supplied credentials.",
    ),
    ("credential_expired", "Provider credentials have expired."),
    (
        "authentication_rejected",
        "Provider rejected authentication; the underlying reason is unknown.",
    ),
    (
        "permission_denied",
        "Provider denied access to the requested resource.",
    ),
    (
        "model_access_denied",
        "The selected model is not accessible.",
    ),
    (
        "insufficient_balance",
        "The provider reported insufficient balance.",
    ),
    (
        "quota_exceeded",
        "The provider reported an exhausted quota.",
    ),
    ("rate_limited", "Provider rate limit exceeded."),
    ("network_error", "A network connection failed."),
    ("timeout", "The operation timed out."),
    (
        "provider_unavailable",
        "The provider is temporarily unavailable.",
    ),
    (
        "refusal",
        "The provider refused the request or blocked the response.",
    ),
    (
        "malformed_response",
        "Provider returned a malformed response.",
    ),
    (
        "stream_drop",
        "The provider ended the response stream without a stop signal.",
    ),
    (
        "context_limit",
        "The request exceeded the model context limit.",
    ),
    (
        "configuration_error",
        "The application could not load or use its configuration.",
    ),
    ("filesystem_error", "A local file operation failed."),
    (
        "session_unavailable",
        "The requested session is unavailable.",
    ),
    ("cancelled", "Request was aborted."),
    (
        "unknown",
        "An error occurred; private error details were omitted.",
    ),
];

/// The reviewed fixed-string error messages (#2117
/// `TELEMETRY_SAFE_ERROR_MESSAGES`): a message that matches one of these
/// exactly may ride the event as `error_message`.
const REVIEWED_MESSAGES: &[(&str, &str)] = &[
    ("cancelled", "Request was aborted"),
    ("cancelled", "The operation was aborted."),
    ("cancelled", "The operation was aborted"),
    ("network_error", "fetch failed"),
    ("provider_unavailable", "Provider overloaded"),
    ("rate_limited", "Provider rate limit exceeded"),
    (
        "malformed_response",
        "Provider returned a malformed response",
    ),
    ("refusal", "Model refused to respond"),
    ("refusal", "Response blocked by provider safety filters"),
    ("refusal", "Provider finish_reason: content_filter"),
    ("network_error", "Provider finish_reason: network_error"),
    ("provider_unavailable", "Provider server error"),
    ("authentication_rejected", "Provider authentication failed"),
    (
        "permission_denied",
        "Provider denied access to the requested resource",
    ),
    ("malformed_response", "Provider rejected the request"),
    ("network_error", "Provider stream failed"),
    ("filesystem_error", "Failed to acquire auth storage lock"),
    ("filesystem_error", "Auth storage lock was compromised"),
];

/// The safe error codes and their subtypes (#2117 `CODE_SUBTYPES`): a
/// code token in the message classifies the error; the message text
/// itself never uploads.
const CODE_SUBTYPES: &[(&str, &str)] = &[
    ("invalid_api_key", "credential_invalid"),
    ("invalid_token", "credential_invalid"),
    ("invalid_grant", "credential_invalid"),
    ("token_expired", "credential_expired"),
    ("expired_token", "credential_expired"),
    ("missing_api_key", "credential_missing"),
    ("authentication_error", "authentication_rejected"),
    ("unauthorized", "authentication_rejected"),
    ("permission_error", "permission_denied"),
    ("permission_denied", "permission_denied"),
    ("access_denied", "permission_denied"),
    ("forbidden", "permission_denied"),
    ("model_not_found", "model_access_denied"),
    ("model_access_denied", "model_access_denied"),
    ("usage_not_included", "model_access_denied"),
    ("insufficient_funds", "insufficient_balance"),
    ("insufficient_balance", "insufficient_balance"),
    ("insufficient_quota", "quota_exceeded"),
    ("quota_exceeded", "quota_exceeded"),
    ("resource_exhausted", "quota_exceeded"),
    ("rate_limit_error", "rate_limited"),
    ("rate_limit_exceeded", "rate_limited"),
    ("too_many_requests", "rate_limited"),
    ("overloaded_error", "provider_unavailable"),
    ("server_error", "provider_unavailable"),
    ("api_error", "provider_unavailable"),
    ("service_unavailable", "provider_unavailable"),
    ("refusal", "refusal"),
    ("content_filter", "refusal"),
    ("safety", "refusal"),
    ("malformed_response", "malformed_response"),
    ("stream_drop", "stream_drop"),
    ("context_length_exceeded", "context_limit"),
    ("context_window_exceeded", "context_limit"),
    ("ECONNRESET", "network_error"),
    ("ECONNREFUSED", "network_error"),
    ("EHOSTUNREACH", "network_error"),
    ("ENETUNREACH", "network_error"),
    ("ENOTFOUND", "network_error"),
    ("EAI_AGAIN", "network_error"),
    ("EPIPE", "network_error"),
    ("ETIMEDOUT", "timeout"),
    ("UND_ERR_CONNECT_TIMEOUT", "timeout"),
    ("UND_ERR_HEADERS_TIMEOUT", "timeout"),
    ("UND_ERR_BODY_TIMEOUT", "timeout"),
    ("UND_ERR_SOCKET", "network_error"),
    ("ENOENT", "filesystem_error"),
    ("EACCES", "filesystem_error"),
    ("EPERM", "filesystem_error"),
    ("ENOSPC", "filesystem_error"),
    ("EMFILE", "filesystem_error"),
    ("EROFS", "filesystem_error"),
    ("ELOCKED", "filesystem_error"),
];

/// The subtype's legacy category (#2117 `SUBTYPE_CATEGORIES`): structured
/// evidence names the category too, never the raw message wording.
fn subtype_category(subtype: &str) -> &'static str {
    match subtype {
        "credential_missing"
        | "credential_invalid"
        | "credential_expired"
        | "authentication_rejected" => "authentication",
        "quota_exceeded" | "rate_limited" => "rate_limit",
        "network_error" | "stream_drop" => "network",
        "timeout" => "timeout",
        "provider_unavailable" => "provider_unavailable",
        "context_limit" => "context_limit",
        _ => "other",
    }
}

/// Whether the subtype's failures are retryable by the auto-retry policy
/// (the classifier's static verdict; the retry seam corroborates it with
/// the actual retry observations).
fn subtype_retryable(subtype: &str) -> bool {
    matches!(
        subtype,
        "quota_exceeded"
            | "rate_limited"
            | "network_error"
            | "stream_drop"
            | "timeout"
            | "provider_unavailable"
            | "malformed_response"
            | "insufficient_balance"
    )
}

/// One failed call's classification. No raw message text is carried.
#[derive(Debug, Clone, PartialEq)]
pub struct ErrorClassification {
    /// The fixed diagnostic for the subtype.
    pub diagnostic: &'static str,
    /// The reviewed fixed-string message, when the raw text matched one
    /// exactly (the only message text eligible for upload).
    pub safe_message: Option<(&'static str, &'static str)>,
    /// `category` is the legacy `error_category` vocabulary.
    pub category: &'static str,
    pub subtype: &'static str,
    /// The recognized safe error code, when one named the subtype.
    pub code: Option<&'static str>,
    /// A bounded HTTP status observed in the text.
    pub http_status: Option<u64>,
    /// How the classification was reached.
    pub classification_source: &'static str,
    /// The static retryability verdict for the subtype.
    pub retryable: bool,
}

/// Classify one failed call's error message. The message itself never
/// uploads: only the fixed tuples, the diagnostic, and - when the text is
/// a reviewed fixed string - that exact string.
#[must_use]
pub fn classify_error_message(message: &str) -> ErrorClassification {
    let diagnostic = |subtype: &str| {
        ERROR_DIAGNOSTICS
            .iter()
            .find(|(known, _)| *known == subtype)
            .map_or(
                "An error occurred; private error details were omitted.",
                |(_, diagnostic)| *diagnostic,
            )
    };
    // 1. A bounded HTTP status is the strongest structured evidence.
    if let Some(status) = bounded_http_status(message) {
        let subtype = match status {
            401 | 403 => "authentication_rejected",
            402 => "insufficient_balance",
            404 => "model_access_denied",
            408 => "timeout",
            413 => "context_limit",
            429 => "rate_limited",
            500..=599 => "provider_unavailable",
            _ => "unknown",
        };
        return ErrorClassification {
            diagnostic: diagnostic(subtype),
            safe_message: None,
            category: subtype_category(subtype),
            subtype,
            code: None,
            http_status: Some(status),
            classification_source: "http_status",
            retryable: subtype_retryable(subtype),
        };
    }
    // 2. A recognized safe error code token names the subtype. The
    // match runs case-insensitively in both directions (a lowercase
    // message carries `econnreset`; the reported code keeps its canonical
    // spelling).
    let lowered = message.to_ascii_lowercase();
    if let Some((code, subtype)) = CODE_SUBTYPES.iter().find(|(code, _)| {
        let lowered_code = code.to_ascii_lowercase();
        lowered.contains(&lowered_code) || message.contains(*code)
    }) {
        return ErrorClassification {
            diagnostic: diagnostic(subtype),
            safe_message: None,
            category: subtype_category(subtype),
            subtype,
            code: Some(code),
            http_status: None,
            classification_source: "typed_error",
            retryable: subtype_retryable(subtype),
        };
    }
    // 3. A reviewed fixed-string message (exact match, the only text that
    // may upload).
    if let Some((subtype, reviewed)) = REVIEWED_MESSAGES
        .iter()
        .find(|(_, reviewed)| reviewed == &message)
    {
        return ErrorClassification {
            diagnostic: diagnostic(subtype),
            safe_message: Some(("reviewed_literal", reviewed)),
            category: subtype_category(subtype),
            subtype,
            code: None,
            http_status: None,
            classification_source: "reviewed_message",
            retryable: subtype_retryable(subtype),
        };
    }
    // 4. Unmatched: the generic diagnostic; the raw text never uploads.
    ErrorClassification {
        diagnostic: diagnostic("unknown"),
        safe_message: None,
        category: "other",
        subtype: "unknown",
        code: None,
        http_status: None,
        classification_source: "unknown",
        retryable: false,
    }
}

/// A bounded `[45]dd` HTTP status in the text (digit-bounded, the TS
/// `\b5\d\d\b` shape generalized to 4xx).
fn bounded_http_status(message: &str) -> Option<u64> {
    let bytes = message.as_bytes();
    for index in 0..bytes.len() {
        if !matches!(bytes[index], b'4' | b'5') || index + 2 >= bytes.len() {
            continue;
        }
        let (b, c) = (bytes[index + 1], bytes[index + 2]);
        if !b.is_ascii_digit() || !c.is_ascii_digit() {
            continue;
        }
        let digit_before = index > 0 && bytes[index - 1].is_ascii_digit();
        let digit_after = index + 3 < bytes.len() && bytes[index + 3].is_ascii_digit();
        // A word boundary, not just a digit boundary: `500ms` / `429s`
        // (durations in the message text) never read as statuses.
        let unit_after = index + 3 < bytes.len() && bytes[index + 3].is_ascii_alphabetic();
        if !digit_before && !digit_after && !unit_after {
            let status = u64::from(bytes[index] - b'0') * 100
                + u64::from(b - b'0') * 10
                + u64::from(c - b'0');
            return Some(status);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classify(message: &str) -> ErrorClassification {
        classify_error_message(message)
    }

    #[test]
    fn http_status_is_the_strongest_evidence() {
        let classification = classify("API Error: 429 rate limit exceeded");
        assert_eq!(classification.subtype, "rate_limited");
        assert_eq!(classification.http_status, Some(429));
        assert_eq!(classification.category, "rate_limit");
        assert_eq!(classification.classification_source, "http_status");
        assert!(classification.retryable);
        // The raw text never rides the classification.
        assert!(classification.safe_message.is_none());
        assert!(!classification.diagnostic.contains("API Error"));
    }

    #[test]
    fn status_digits_are_bounded() {
        assert_eq!(bounded_http_status("error 503 unavailable"), Some(503));
        assert_eq!(bounded_http_status("error 4012 nope"), None);
        assert_eq!(bounded_http_status("14043"), None);
        assert_eq!(bounded_http_status("no status at all"), None);
        // Durations in the text never read as statuses.
        assert_eq!(bounded_http_status("timed out after 500ms"), None);
        assert_eq!(bounded_http_status("retry in 429s"), None);
        assert_eq!(bounded_http_status("wait 30m"), None);
    }

    #[test]
    fn safe_codes_classify_without_uploading_text() {
        let classification = classify("ECONNRESET while streaming: user-secret-token");
        assert_eq!(classification.subtype, "network_error");
        assert_eq!(classification.code, Some("ECONNRESET"));
        assert_eq!(classification.category, "network");
        assert_eq!(classification.classification_source, "typed_error");
    }

    #[test]
    fn errno_tokens_match_lowercase_messages() {
        let classification = classify("request failed: econnreset during stream");
        assert_eq!(
            classification.subtype, "network_error",
            "the lowercase errno still names the typed subtype"
        );
        assert_eq!(classification.code, Some("ECONNRESET"));
    }

    #[test]
    fn reviewed_literals_are_the_only_uploaded_text() {
        let classification = classify("Provider rate limit exceeded");
        assert_eq!(classification.subtype, "rate_limited");
        assert_eq!(classification.classification_source, "reviewed_message");
        assert_eq!(
            classification.safe_message,
            Some(("reviewed_literal", "Provider rate limit exceeded"))
        );
        // The abort literal's subtype is the catalog vocabulary
        // (`cancelled`, never a message id that sanitize would rewrite).
        let aborted = classify("Request was aborted");
        assert_eq!(aborted.subtype, "cancelled");
        assert!(pa_telemetry::ERROR_SUBTYPES.contains(&aborted.subtype));
        // A near-miss uploads nothing.
        let near_miss = classify("Provider rate limit exceeded for model glm-4.6");
        assert!(near_miss.safe_message.is_none());
        assert_eq!(near_miss.classification_source, "unknown");
        assert_eq!(near_miss.subtype, "unknown");
    }

    #[test]
    fn stream_drop_messages_classify_as_the_stream_drop_category() {
        // The provider's drop disclosure (pa-ai `stream_drop_failure`):
        // every block detail names the same class.
        let classification = classify(
            "Provider dropped the response stream (stream_drop): the stream ended inside a thinking block before the stop signal"
        );
        assert_eq!(classification.subtype, "stream_drop");
        assert_eq!(classification.category, "network");
        assert_eq!(classification.code, Some("stream_drop"));
        assert_eq!(classification.classification_source, "typed_error");
        assert!(classification.retryable);
        // The raw message never uploads; the fixed diagnostic rides.
        assert!(classification.safe_message.is_none());
        assert_eq!(
            classification.diagnostic,
            "The provider ended the response stream without a stop signal."
        );
        assert!(pa_telemetry::ERROR_SUBTYPES.contains(&classification.subtype));
        // The empty-stream variant classifies identically.
        let empty = classify(
            "Provider dropped the response stream (stream_drop): the stream ended before any response content or stop signal"
        );
        assert_eq!(empty.subtype, "stream_drop");
        assert!(empty.retryable);
    }

    #[test]
    fn unmatched_messages_get_the_generic_diagnostic() {
        let classification = classify("Provider exploded with secret details about /home/user");
        assert_eq!(classification.subtype, "unknown");
        assert_eq!(classification.category, "other");
        assert!(!classification.retryable);
        assert_eq!(
            classification.diagnostic,
            "An error occurred; private error details were omitted."
        );
        assert!(classification.safe_message.is_none());
    }

    #[test]
    fn auth_and_billing_split() {
        let auth = classify("invalid_api_key");
        assert_eq!(auth.subtype, "credential_invalid");
        assert_eq!(auth.category, "authentication");
        assert!(!auth.retryable);
        let billing = classify("402");
        assert_eq!(billing.subtype, "insufficient_balance");
        assert_eq!(billing.category, "other");
        assert_eq!(billing.http_status, Some(402));
    }

    #[test]
    fn every_subtype_has_a_diagnostic() {
        for (subtype, diagnostic) in ERROR_DIAGNOSTICS {
            assert!(!diagnostic.is_empty(), "{subtype}");
            assert!(!diagnostic.contains('{'), "{subtype}: no templating");
        }
    }
}
