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
    // A 402 classifies by status, before any body-text pattern: the
    // same wallet drain must not fork on the response body's
    // `error.type` text (the silent-arm diagnosis — variant A
    // retried 13-15s on a dead wallet, variant B settled silently).
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
