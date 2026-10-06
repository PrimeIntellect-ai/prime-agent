//! The `command_session` wire helpers shared by the client and the
//! stream pump: RPC URL construction, per-RPC headers, media-type checks,
//! codec-fault mapping, bounded error-body previews, the non-2xx status
//! mapping, end-of-stream parsing, and empty-message validation. Port of
//! the helper half of `vm-process-client.ts` (TS branch
//! `feat/direct-cloud-sandbox`); see [`crate::vm_process`] for the wire
//! contract and the safety contract.

use std::time::Duration;

use crate::error::SandboxError;
use crate::gateway::{validate_gateway_credentials, GatewayAuth, MAX_ERROR_BODY_BYTES};
use crate::proto::{ProtoError, ProtoErrorKind, Reader};
use crate::transport::{ResponseChunks, SandboxTransport};
use crate::vm_error::{CommandSessionError, CommandSessionErrorCode};
use crate::vm_process::{ClientInner, GatewayAuthSource};

/// The RPC URL
/// `{gateway}/{ns}/{job}/command_session.CommandSession/{Method}`,
/// validated first (TS `rpcUrl`).
/// The RPC URL `{gateway}/{ns}/{job}/command_session.CommandSession/{Method}`,
/// validated first (TS `rpcUrl`).
pub(crate) fn rpc_url<T, A>(
    inner: &ClientInner<T, A>,
    auth: &GatewayAuth,
    method: &str,
) -> Result<String, CommandSessionError>
where
    T: SandboxTransport,
    A: GatewayAuthSource,
{
    validate_gateway_credentials(
        &auth.gateway_url,
        &auth.user_namespace,
        &auth.job_id,
        inner.allow_insecure_localhost,
    )
    .map_err(|error| CommandSessionError::invalid_response(error.to_string()))?;
    let gateway_url = auth.gateway_url.trim_end_matches('/');
    Ok(format!(
        "{gateway_url}/{}/{}/command_session.CommandSession/{method}",
        auth.user_namespace, auth.job_id
    ))
}

/// Streaming-RPC headers (TS `streamHeaders`).
pub(crate) fn stream_headers(
    auth: &GatewayAuth,
    keepalive_interval_seconds: u32,
    connect_timeout_ms: Option<u64>,
) -> Vec<(String, String)> {
    let mut headers = vec![
        (
            "Authorization".to_string(),
            format!("Bearer {}", auth.token),
        ),
        (
            "Content-Type".to_string(),
            "application/connect+proto".to_string(),
        ),
        ("Connect-Protocol-Version".to_string(), "1".to_string()),
        (
            "Keepalive-Ping-Interval".to_string(),
            keepalive_interval_seconds.to_string(),
        ),
    ];
    if let Some(ms) = connect_timeout_ms {
        headers.push(("Connect-Timeout-Ms".to_string(), ms.to_string()));
    }
    headers
}

/// Unary-RPC headers (TS `unaryHeaders`): the standard Connect deadline
/// header; sandboxd additionally reads it as the process deadline only in
/// Start.
pub(crate) fn unary_headers(auth: &GatewayAuth, timeout: Duration) -> Vec<(String, String)> {
    vec![
        (
            "Authorization".to_string(),
            format!("Bearer {}", auth.token),
        ),
        ("Content-Type".to_string(), "application/proto".to_string()),
        ("Connect-Protocol-Version".to_string(), "1".to_string()),
        (
            "Connect-Timeout-Ms".to_string(),
            timeout.as_millis().to_string(),
        ),
    ]
}

/// True when a content-type header's media type equals `expected` (TS
/// `mediaType`).
pub(crate) fn is_media_type(value: Option<&str>, expected: &str) -> bool {
    value.is_some_and(|value| {
        value
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case(expected)
    })
}

/// Map a codec failure onto the typed client error (TS
/// `toVmProcessError`): oversize frames are `too_large`, invalid wire is
/// `invalid_response`, invalid input is `invalid_request`.
pub(crate) fn proto_fault(
    error: &ProtoError,
    method: &'static str,
    url: &str,
) -> CommandSessionError {
    let fault = match error.kind() {
        ProtoErrorKind::OversizeFrame => {
            CommandSessionError::too_large(format!("Command session stream frame: {error}"))
        }
        ProtoErrorKind::InvalidWire => CommandSessionError::invalid_response(error.to_string()),
        ProtoErrorKind::InvalidInput => CommandSessionError::invalid_request(error.to_string()),
    };
    fault.with_context(method, url, None, None)
}

/// Read at most [`MAX_ERROR_BODY_BYTES`] of an error response body for a
/// preview (TS `boundedErrorBody`).
pub(crate) async fn read_error_preview(body: &mut ResponseChunks) -> String {
    let mut read = Vec::new();
    while read.len() < MAX_ERROR_BODY_BYTES {
        match body.next_chunk().await {
            Ok(Some(chunk)) => {
                let room = MAX_ERROR_BODY_BYTES - read.len();
                let take = chunk.len().min(room);
                read.extend_from_slice(&chunk[..take]);
            }
            Ok(None) | Err(_) => break,
        }
    }
    String::from_utf8_lossy(&read).into_owned()
}

/// Map a non-2xx response onto the typed error contract (TS
/// `errorFromResponse`): Connect JSON bodies (`{"code","message"}`) win;
/// gateway 502 `{ "error": "sandbox_not_found" }` is
/// [`CommandSessionErrorCode::SandboxNotFound`]; gateway-shaped bodies
/// (`{"error","message"}`) fall back to the status map; everything else
/// is the status map. The message and preview are redacted against the
/// gateway token.
pub(crate) fn error_from_status_body(
    status: u16,
    text: &str,
    method: &'static str,
    url: &str,
    auth: &GatewayAuth,
) -> CommandSessionError {
    let secrets = [auth.token.as_str()];
    let preview = if text.is_empty() {
        None
    } else {
        Some(crate::SandboxError::bound_preview(
            &crate::SandboxError::redact_secrets(text, &secrets),
        ))
    };
    let parsed = serde_json::from_str::<serde_json::Value>(text).ok();
    let generic = || CommandSessionErrorCode::from_status(status);
    let context = format!("Command session {method}");
    let (code, message) = match parsed.as_ref() {
        Some(value) if value.is_object() => {
            if let Some(code) = value
                .get("code")
                .and_then(serde_json::Value::as_str)
                .and_then(CommandSessionErrorCode::from_connect)
            {
                (
                    code,
                    value
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                )
            } else if status == 502
                && value.get("error").and_then(serde_json::Value::as_str)
                    == Some("sandbox_not_found")
            {
                (
                    CommandSessionErrorCode::SandboxNotFound,
                    value
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                )
            } else if value
                .get("error")
                .and_then(serde_json::Value::as_str)
                .is_some()
            {
                // Gateway-shaped errors: {"error": "...", "message": "..."}.
                (
                    generic(),
                    value
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                )
            } else {
                (generic(), None)
            }
        }
        _ => (generic(), None),
    };
    let message = message.unwrap_or_else(|| format!("{context} failed with HTTP {status}"));
    let redacted = crate::SandboxError::redact_secrets(&message, &secrets);
    CommandSessionError::new(code, redacted).with_context(method, url, Some(status), preview)
}

/// Parse a Connect end-of-stream frame; a body carrying `error` throws
/// the typed stream error, everything else is a clean end of stream (TS
/// `parseEndOfStreamFrame`). The message is redacted against the active
/// gateway token (a reviewed hardening over the TS module, which trusts
/// the peer not to echo credentials).
pub(crate) fn parse_end_of_stream(
    payload: &[u8],
    method: &'static str,
    url: &str,
    token: &str,
) -> Result<(), CommandSessionError> {
    let parsed = if payload.is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_slice::<serde_json::Value>(payload).map_err(|error| {
            CommandSessionError::invalid_response(format!(
                "Command session {method} end-of-stream frame is not JSON: {error}"
            ))
            .with_context(method, url, None, None)
        })?
    };
    if !parsed.is_object() {
        return Err(CommandSessionError::invalid_response(format!(
            "Command session {method} end-of-stream frame is not an object"
        ))
        .with_context(method, url, None, None));
    }
    let Some(stream_error) = parsed.get("error") else {
        return Ok(());
    };
    if !stream_error.is_object() {
        return Err(CommandSessionError::invalid_response(format!(
            "Command session {method} end-of-stream error is malformed"
        ))
        .with_context(method, url, None, None));
    }
    let code = stream_error
        .get("code")
        .and_then(serde_json::Value::as_str)
        .and_then(CommandSessionErrorCode::from_connect)
        .unwrap_or(CommandSessionErrorCode::Unknown);
    let message = stream_error
        .get("message")
        .and_then(serde_json::Value::as_str)
        .map_or_else(
            || format!("Command session {method} failed ({})", code.as_str()),
            |message| SandboxError::redact_secrets(message, std::slice::from_ref(&token)),
        );
    Err(CommandSessionError::new(code, message).with_context(method, url, None, None))
}

/// Decode a proto message that may contain only unknown fields; any
/// malformed structure is a typed fault (TS `decodeEmptyMessage`).
pub(crate) fn decode_empty_message(body: &[u8]) -> Result<(), ProtoError> {
    let mut reader = Reader::new(body);
    while !reader.is_eof() {
        let (field, wire) = reader.tag("empty response")?;
        reader.skip(wire, &format!("empty response.{field}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
