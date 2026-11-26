//! The per-sandbox gateway credential fetch:
//!
//! - `POST {base}/api/v1/sandbox/{id}/auth` — fetch the sandbox-bound
//!   gateway credentials (`snake_case` body). VM execution rides them
//!   through the `ConnectRPC` `command_session` stream — see
//!   [`crate::vm_process`].
//!
//! Safety contract (TS parity): no secret (API key, gateway token) ever
//! appears in an error message, URL, or `details` preview; a malformed 200
//! body is a typed `invalid_response` error, never a silent default; and
//! the gateway origin and URL segments are validated before use.

use std::time::Duration;

use crate::client::PrimeSandboxClient;
use crate::error::SandboxError;
use crate::transport::SandboxTransport;
use crate::types::Method;
use crate::wire::{assert_sandbox_id, is_url_segment, LOCAL_HOSTNAMES};
use serde::Deserialize;

/// Cap for error-body reads: previews never read more than this many
/// bytes (TS `MAX_ERROR_BODY_BYTES`).
pub const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;

/// Transfer cap for upload payloads (TS `MAX_TRANSFER_BYTES`).
pub const MAX_TRANSFER_BYTES: usize = 200 * 1024 * 1024;

/// A gateway upload request.
#[derive(Debug, Clone)]
pub struct UploadRequest {
    /// The absolute path inside the sandbox where the file is written.
    pub path: String,
    /// The multipart file name; a single path segment.
    pub filename: String,
    /// The file bytes; bounded to [`MAX_TRANSFER_BYTES`].
    pub content: Vec<u8>,
}

/// A gateway upload response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadResult {
    /// Always true on the success path (a `false` body is a typed
    /// `invalid_response`).
    pub success: bool,
    /// The path the gateway reports.
    pub path: String,
    /// The uploaded size.
    pub size: i64,
    /// The gateway's ISO-8601 timestamp (non-empty wire string).
    pub timestamp: String,
}

/// Per-sandbox gateway credentials (the `POST /sandbox/{id}/auth`
/// response; `snake_case` wire form). The token is sandbox-bound and
/// short-lived; callers own caching and expiry refresh (TS contract).
#[derive(Clone, PartialEq, Eq)]
pub struct GatewayAuth {
    /// The sandbox the credentials belong to.
    pub sandbox_id: String,
    /// The gateway origin, e.g. `https://sandbox-gw.example.com`.
    pub gateway_url: String,
    /// The gateway namespace (URL path segment).
    pub namespace: String,
    /// The gateway job id (URL path segment).
    pub job_id: String,
    /// The Bearer token for gateway calls. Never logged.
    pub token: String,
    /// ISO-8601 expiry timestamp (validated as a non-empty wire string;
    /// the crate carries no datetime parser — consumers convert on
    /// demand).
    pub expires_at: String,
}

impl std::fmt::Debug for GatewayAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GatewayAuth")
            .field("sandbox_id", &self.sandbox_id)
            .field("gateway_url", &self.gateway_url)
            .field("namespace", &self.namespace)
            .field("job_id", &self.job_id)
            .field("token", &"[redacted]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// Options for the gateway credential fetch.
#[derive(Debug, Clone, Default)]
pub struct GatewayOptions {
    /// Per-request deadline override.
    pub request_timeout: Option<Duration>,
}

impl<T: SandboxTransport> PrimeSandboxClient<T> {
    /// Fetch the per-sandbox gateway credentials. The platform call rides
    /// the user's Prime API key; the returned token is sandbox-bound.
    ///
    /// # Errors
    ///
    /// Returns [`SandboxErrorCode::InvalidRequest`] for a malformed
    /// sandbox id, a status-mapped error for non-2xx responses, and
    /// [`SandboxErrorCode::InvalidResponse`] when the 200 body is
    /// malformed or names an unusable gateway (non-https origin outside
    /// the loopback opt-in, unsafe segments).
    pub async fn get_sandbox_auth(
        &self,
        sandbox_id: &str,
        options: &GatewayOptions,
    ) -> Result<GatewayAuth, SandboxError> {
        assert_sandbox_id(sandbox_id)?;
        let allow_insecure = self.allow_insecure_localhost;
        self.request_json(
            Method::Post,
            format!("{}/api/v1/sandbox/{sandbox_id}/auth", self.base_url),
            self.platform_headers(),
            None,
            self.request_timeout_or(options.request_timeout),
            self.platform_secrets(),
            "Sandbox auth",
            move |value| parse_gateway_auth(value, allow_insecure),
        )
        .await
        .map(|mut auth| {
            // The platform does not echo the sandbox id; the credentials
            // are keyed to the requested sandbox.
            auth.sandbox_id = sandbox_id.to_string();
            auth
        })
    }

    /// Upload bytes to a path inside the sandbox through the multipart
    /// gateway upload endpoint. One request carries the whole file, so a
    /// release tarball costs one round trip instead of one per exec chunk.
    ///
    /// # Errors
    ///
    /// Returns [`SandboxErrorCode::TooLarge`] when the content exceeds
    /// [`MAX_TRANSFER_BYTES`] (nothing is sent),
    /// [`SandboxErrorCode::InvalidRequest`] for invalid paths, filenames,
    /// or gateway auth, a status-mapped error for non-2xx responses, and
    /// [`SandboxErrorCode::InvalidResponse`] for malformed bodies.
    pub async fn upload_file(
        &self,
        sandbox_id: &str,
        request: UploadRequest,
        options: &GatewayOptions,
    ) -> Result<UploadResult, SandboxError> {
        assert_sandbox_id(sandbox_id)?;
        validate_sandbox_file_path(&request.path)?;
        if request.filename.is_empty() || request.filename.contains(['/', '\\', '\0']) {
            return Err(SandboxError::invalid_request(
                "filename must be a non-empty path-segment string",
            ));
        }
        if request.content.len() > MAX_TRANSFER_BYTES {
            return Err(SandboxError::too_large(format!(
                "Upload of {} exceeds the {MAX_TRANSFER_BYTES} byte limit",
                request.path
            )));
        }
        let auth = self.get_sandbox_auth(sandbox_id, options).await?;
        let url = gateway_query_url(
            &gateway_url(&auth, "upload"),
            &[("path", request.path.as_str()), ("sandbox_id", sandbox_id)],
        )?;
        let boundary = uuid::Uuid::new_v4().simple().to_string();
        let body = build_multipart(&request.filename, &request.content, &boundary);
        let headers = gateway_headers(&auth, &format!("multipart/form-data; boundary={boundary}"));
        self.request_json(
            Method::Post,
            url,
            headers,
            Some(body),
            self.request_timeout_or(options.request_timeout),
            gateway_secrets(&auth, self.api_key.as_str()),
            "Sandbox upload",
            parse_upload_result,
        )
        .await
    }

    fn request_timeout_or(&self, override_timeout: Option<Duration>) -> Duration {
        override_timeout.unwrap_or(self.request_timeout)
    }
}

/// The gateway endpoint URL `{gateway}/{ns}/{job}/{endpoint}`.
fn gateway_url(auth: &GatewayAuth, endpoint: &str) -> String {
    format!(
        "{}/{}/{}/{}",
        auth.gateway_url, auth.namespace, auth.job_id, endpoint
    )
}

/// The gateway call headers: the sandbox-bound Bearer token and the
/// caller's content type.
fn gateway_headers(auth: &GatewayAuth, content_type: &str) -> Vec<(String, String)> {
    vec![
        (
            "Authorization".to_string(),
            format!("Bearer {}", auth.token),
        ),
        ("Content-Type".to_string(), content_type.to_string()),
    ]
}

/// The secrets an error preview must redact: the API key and the
/// sandbox-bound token.
fn gateway_secrets<'a>(auth: &'a GatewayAuth, api_key: &'a str) -> Vec<&'a str> {
    vec![api_key, auth.token.as_str()]
}

/// Validate a sandbox file path (TS `validateSandboxFilePath`):
/// non-empty, at most 4096 bytes, NUL-free.
fn validate_sandbox_file_path(path: &str) -> Result<(), SandboxError> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
        return Err(SandboxError::invalid_request(
            "Sandbox file path must be a non-empty NUL-free string",
        ));
    }
    Ok(())
}

/// Append URL-encoded query parameters to a gateway endpoint URL, in
/// order (TS `searchParams.set` order: `path`, then `sandbox_id`).
fn gateway_query_url(endpoint: &str, params: &[(&str, &str)]) -> Result<String, SandboxError> {
    let mut url = url::Url::parse(endpoint).map_err(|error| {
        SandboxError::invalid_response(format!("Gateway URL is malformed: {error}"))
    })?;
    {
        let mut pairs = url.query_pairs_mut();
        for (name, value) in params {
            pairs.append_pair(name, value);
        }
    }
    Ok(url.to_string())
}

/// Escape a multipart filename the way the WHATWG `multipart/form-data`
/// encoding algorithm (and the TS module's `FormData`) does: `"` ->
/// `%22`, `\r` -> `%0D`, `\n` -> `%0A`.
fn escape_multipart_filename(value: &str) -> String {
    value
        .replace('"', "%22")
        .replace('\r', "%0D")
        .replace('\n', "%0A")
}

/// Build the multipart body for the gateway upload: one `file` part with
/// the exact disposition the TS `FormData` emits (name `file`, the
/// filename, no per-part content type), closed by the boundary.
fn build_multipart(filename: &str, content: &[u8], boundary: &str) -> Vec<u8> {
    let mut body = Vec::with_capacity(content.len() + boundary.len() * 2 + 96);
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"file\"; filename=\"");
    body.extend_from_slice(escape_multipart_filename(filename).as_bytes());
    body.extend_from_slice(b"\"\r\n\r\n");
    body.extend_from_slice(content);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// The upload response contract (TS `uploadFile` parse): `success` must
/// be exactly true, `size` a non-negative integer, `path` and
/// `timestamp` non-empty strings.
fn parse_upload_result(value: serde_json::Value) -> Result<UploadResult, SandboxError> {
    #[derive(Deserialize)]
    struct RawUploadResult {
        success: bool,
        path: String,
        size: i64,
        timestamp: String,
    }
    if !value.is_object() {
        return Err(SandboxError::invalid_response(
            "Sandbox upload response must be a JSON object",
        ));
    }
    let raw: RawUploadResult = serde_json::from_value(value).map_err(|error| {
        SandboxError::invalid_response(format!(
            "Sandbox upload response record is malformed: {error}"
        ))
    })?;
    if !raw.success {
        return Err(SandboxError::invalid_response(
            "Sandbox upload response reported failure",
        ));
    }
    if raw.path.is_empty() || raw.timestamp.is_empty() {
        return Err(SandboxError::invalid_response(
            "Sandbox upload response path and timestamp must be non-empty strings",
        ));
    }
    if raw.size < 0 {
        return Err(SandboxError::invalid_response(
            "Sandbox upload response size must be non-negative",
        ));
    }
    Ok(UploadResult {
        success: true,
        path: raw.path,
        size: raw.size,
        timestamp: raw.timestamp,
    })
}

/// The auth response contract (TS `getSandboxAuth` parse): `snake_case`
/// fields, all required and non-empty, the gateway origin validated
/// against the client's loopback opt-in.
#[derive(Debug, Deserialize)]
struct RawGatewayAuth {
    #[serde(rename = "gateway_url")]
    gateway_url: String,
    #[serde(rename = "user_ns")]
    namespace: String,
    #[serde(rename = "job_id")]
    job_id: String,
    token: String,
    #[serde(rename = "expires_at")]
    expires_at: String,
}

fn parse_gateway_auth(
    value: serde_json::Value,
    allow_insecure_localhost: bool,
) -> Result<GatewayAuth, SandboxError> {
    let raw: RawGatewayAuth = serde_json::from_value(value).map_err(|error| {
        SandboxError::invalid_response(format!(
            "Sandbox auth response record is malformed: {error}"
        ))
    })?;
    for (field, value) in [
        ("gateway_url", raw.gateway_url.as_str()),
        ("user_ns", raw.namespace.as_str()),
        ("job_id", raw.job_id.as_str()),
        ("token", raw.token.as_str()),
        ("expires_at", raw.expires_at.as_str()),
    ] {
        if value.is_empty() {
            return Err(SandboxError::invalid_response(format!(
                "Sandbox response field {field} must be a non-empty string"
            )));
        }
    }
    validate_gateway_credentials(
        &raw.gateway_url,
        &raw.namespace,
        &raw.job_id,
        allow_insecure_localhost,
    )?;
    Ok(GatewayAuth {
        sandbox_id: String::new(),
        // Trailing slashes are trimmed (TS `gatewayUrl.replace(/\/+$/, "")`)
        gateway_url: raw.gateway_url.trim_end_matches('/').to_string(),
        namespace: raw.namespace,
        job_id: raw.job_id,
        token: raw.token,
        expires_at: raw.expires_at,
    })
}

/// Validate the gateway origin and segments (TS `getSandboxAuth` parse
/// guards): https-only except loopback `http` with the opt-in, no query
/// or fragment, no credentials, URL-safe `user_ns`/`job_id` segments.
///
/// # Errors
///
/// Returns [`SandboxErrorCode::InvalidResponse`] when any check fails.
pub(crate) fn validate_gateway_credentials(
    gateway_url: &str,
    namespace: &str,
    job_id: &str,
    allow_insecure_localhost: bool,
) -> Result<(), SandboxError> {
    let invalid =
        || SandboxError::invalid_response("Sandbox auth gateway_url must be an https URL");
    if gateway_url.contains('?') || gateway_url.contains('#') {
        return Err(invalid());
    }
    let parsed = url::Url::parse(gateway_url).map_err(|_| invalid())?;
    if parsed.username() != "" || parsed.password().is_some() || parsed.host_str().is_none() {
        return Err(invalid());
    }
    let scheme_ok = parsed.scheme() == "https"
        || (parsed.scheme() == "http"
            && allow_insecure_localhost
            && LOCAL_HOSTNAMES.contains(&parsed.host_str().unwrap_or_default()));
    if !scheme_ok {
        return Err(invalid());
    }
    if !is_url_segment(namespace) || !is_url_segment(job_id) {
        return Err(SandboxError::invalid_response(
            "Sandbox auth user_ns and job_id must be URL-safe segments",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::SandboxErrorCode;

    #[test]
    fn multipart_bodies_match_the_undici_form() {
        let body = build_multipart("x.tar", &[1, 2, 3, 4], "bnd");
        let expected: Vec<u8> = b"--bnd\r\n\
            Content-Disposition: form-data; name=\"file\"; filename=\"x.tar\"\r\n\
            \r\n\
            \x01\x02\x03\x04\r\n\
            --bnd--\r\n"
            .to_vec();
        assert_eq!(body, expected);
    }

    #[test]
    fn multipart_filenames_apply_whatwg_escaping() {
        assert_eq!(escape_multipart_filename("a\"b"), "a%22b");
        assert_eq!(escape_multipart_filename("a\nb"), "a%0Ab");
        assert_eq!(escape_multipart_filename("a\rb"), "a%0Db");
        assert_eq!(escape_multipart_filename("plain.tar.gz"), "plain.tar.gz");
    }

    #[test]
    fn upload_responses_parse_strictly() {
        let ok = serde_json::json!({
            "success": true,
            "path": "/tmp/x.tar",
            "size": 4,
            "timestamp": "2026-09-16T00:00:00Z",
        });
        assert_eq!(
            parse_upload_result(ok).unwrap(),
            UploadResult {
                success: true,
                path: "/tmp/x.tar".to_string(),
                size: 4,
                timestamp: "2026-09-16T00:00:00Z".to_string(),
            }
        );
        let failure = serde_json::json!({
            "success": false,
            "path": "/x",
            "size": 1,
            "timestamp": "2026-09-16T00:00:00Z",
        });
        assert_eq!(
            parse_upload_result(failure).unwrap_err().code(),
            SandboxErrorCode::InvalidResponse
        );
        let missing_size = serde_json::json!({
            "success": true,
            "path": "/x",
            "timestamp": "2026-09-16T00:00:00Z",
        });
        assert_eq!(
            parse_upload_result(missing_size).unwrap_err().code(),
            SandboxErrorCode::InvalidResponse
        );
    }

    #[test]
    fn gateway_credentials_validate_the_origin_and_segments() {
        validate_gateway_credentials(
            "https://sandbox-gw.example.com",
            "ns_user1",
            "job_abc",
            false,
        )
        .unwrap();
        validate_gateway_credentials("http://[::1]:9393", "ns", "job", true).unwrap();
        for bad in [
            ("http://sandbox-gw.example.com", false),
            ("http://[::1]:9393", false),
            ("https://gw.example.com?x=1", false),
            ("https://gw.example.com#f", false),
        ] {
            assert!(
                validate_gateway_credentials(bad.0, "ns", "job", bad.1).is_err(),
                "{} must be rejected",
                bad.0
            );
        }
        assert!(
            validate_gateway_credentials("https://gw.example.com", "a/b", "job", false).is_err()
        );
        assert!(
            validate_gateway_credentials("https://gw.example.com", "ns", "b c", false).is_err()
        );
    }

    #[test]
    fn auth_responses_parse_strictly() {
        let value = serde_json::json!({
            "gateway_url": "https://sandbox-gw.example.com",
            "user_ns": "ns_user1",
            "job_id": "job_abc",
            "token": "gateway-token-xyz",
            "expires_at": "2026-09-16T01:00:00Z",
        });
        let parsed = parse_gateway_auth(value, false).unwrap();
        assert_eq!(parsed.namespace, "ns_user1");
        assert_eq!(parsed.job_id, "job_abc");
        assert_eq!(parsed.token, "gateway-token-xyz");
        let missing_token = serde_json::json!({
            "gateway_url": "https://sandbox-gw.example.com",
            "user_ns": "ns_user1",
            "job_id": "job_abc",
            "expires_at": "2026-09-16T01:00:00Z",
        });
        assert!(parse_gateway_auth(missing_token, false).is_err());
        let non_https = serde_json::json!({
            "gateway_url": "http://sandbox-gw.example.com",
            "user_ns": "ns_user1",
            "job_id": "job_abc",
            "token": "t",
            "expires_at": "2026-09-16T01:00:00Z",
        });
        assert_eq!(
            parse_gateway_auth(non_https, false).unwrap_err().code(),
            SandboxErrorCode::InvalidResponse
        );
        // The loopback opt-in lets a loopback http gateway through.
        let loopback = serde_json::json!({
            "gateway_url": "http://[::1]:9393",
            "user_ns": "ns_user1",
            "job_id": "job_abc",
            "token": "t",
            "expires_at": "2026-09-16T01:00:00Z",
        });
        let parsed = parse_gateway_auth(loopback, true).unwrap();
        assert_eq!(parsed.gateway_url, "http://[::1]:9393");
        // Trailing slashes are trimmed.
        let trailing = serde_json::json!({
            "gateway_url": "https://sandbox-gw.example.com/",
            "user_ns": "ns_user1",
            "job_id": "job_abc",
            "token": "t",
            "expires_at": "2026-09-16T01:00:00Z",
        });
        let parsed = parse_gateway_auth(trailing, false).unwrap();
        assert_eq!(parsed.gateway_url, "https://sandbox-gw.example.com");
    }
}
