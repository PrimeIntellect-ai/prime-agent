//! The stream-failure unit battery: the classification tables, the retry
//! parsing, and the wire shapes.
use super::*;
use std::collections::HashMap;

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
    // A 402 classifies by status, before any body-text pattern: the same wallet drain must not fork
    // on the response body's `error.type` text.
    assert_eq!(
        classify_stream_failure(Some("insufficient_credits"), Some(402)),
        StreamFailureKind::PaymentRequired
    );
    assert_eq!(
        classify_stream_failure(Some("invalid_request_error"), Some(402)),
        StreamFailureKind::PaymentRequired
    );
    assert_eq!(
        classify_stream_failure(None, Some(402)),
        StreamFailureKind::PaymentRequired
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

/// The connection-failure texts per family, verified against the TS binary. pa-core's
/// `TRANSPORT_DISCLOSURES` prefix-matches these to mark a failure retryable transport.
#[test]
fn connection_error_texts() {
    let aws_http1 = || ConnectionErrorProfile::AwsHttp1 {
        host: "127.0.0.1".to_string(),
        port: 1,
    };
    let aws_http2 = || ConnectionErrorProfile::AwsHttp2 {
        host: "127.0.0.1".to_string(),
        port: 1,
    };
    let hint = "\n  Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object.";
    let cases = [
        (
            ConnectionErrorProfile::Sdk,
            ConnectionErrorKind::Connect,
            "Connection error.".to_string(),
        ),
        (
            ConnectionErrorProfile::Sdk,
            ConnectionErrorKind::Timeout,
            "Request timed out.".to_string(),
        ),
        (
            ConnectionErrorProfile::RawFetch,
            ConnectionErrorKind::Connect,
            "Unable to connect. Is the computer able to access the url?".to_string(),
        ),
        (
            ConnectionErrorProfile::MistralSdk,
            ConnectionErrorKind::Connect,
            "Unexpected HTTP client error: TypeError: Unable to connect. Is the computer able to access the url?".to_string(),
        ),
        (
            aws_http1(),
            ConnectionErrorKind::Connect,
            "connect ECONNREFUSED 127.0.0.1:1".to_string(),
        ),
        (
            aws_http1(),
            ConnectionErrorKind::Reset,
            "read ECONNRESET".to_string(),
        ),
        (
            aws_http2(),
            ConnectionErrorKind::Connect,
            "The pending stream has been canceled (caused by: connect ECONNREFUSED 127.0.0.1:1)"
                .to_string(),
        ),
        (
            aws_http2(),
            ConnectionErrorKind::H2Request(H2Failure::Protocol),
            "Protocol error".to_string(),
        ),
        (
            aws_http2(),
            ConnectionErrorKind::H2MidStream(H2Failure::StreamReset {
                nghttp2_code: "NGHTTP2_INTERNAL_ERROR".to_string(),
            }),
            format!("Stream closed with error code NGHTTP2_INTERNAL_ERROR{hint}"),
        ),
        (
            aws_http2(),
            ConnectionErrorKind::H2MidStream(H2Failure::SessionClosed { code: 1 }),
            format!("Session closed with error code 1{hint}"),
        ),
        (
            aws_http2(),
            ConnectionErrorKind::H2MidStream(H2Failure::Canceled),
            format!("The pending stream has been canceled{hint}"),
        ),
    ];
    for (profile, kind, text) in cases {
        let error = ProviderError::Connection(ProviderConnectionError {
            kind,
            profile,
            cause: "transport".to_string(),
        });
        assert_eq!(error.to_string(), text);
    }
}

/// The TS `extractStreamFailureParts` fallback chain: a body without an error type takes the SDK
/// error's own class name, and an error-resolved retry wait overrides the raw header.
#[test]
fn http_error_name_fallback_and_retry_override() {
    let error = ProviderError::Http(ProviderHttpError {
        // A type-less 429 body, like a google `ApiError` (its error `code` is numeric): the
        // qualifiers show the class name.
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

    // An explicit `err.code` beats both the body type and the class name, and the error-resolved
    // wait beats the header.
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
