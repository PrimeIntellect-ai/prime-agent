//! The per-sandbox gateway data path: the gateway credential fetch,
//! authenticated exec, upload, and download. Port of the gateway half of
//! `prime-sandbox-client.ts` (TS branch `feat/direct-cloud-sandbox`),
//! the direct REST surface of the Prime sandbox gateway:
//!
//! - `POST {base}/api/v1/sandbox/{id}/auth` — fetch the sandbox-bound
//!   gateway credentials (`snake_case` body);
//! - `POST {gateway}/{ns}/{job}/exec` — batch exec (container sandboxes
//!   only; VM execution goes through the `ConnectRPC`
//!   `command_session` stream — see [`crate::vm_process`]);
//! - `POST {gateway}/{ns}/{job}/upload` — multipart file upload, `path`
//!   and `sandbox_id` as query params;
//! - `GET {gateway}/{ns}/{job}/download` — raw bytes, `path` and
//!   `sandbox_id` as query params.
//!
//! Safety contract (TS parity): no secret (API key, gateway token) ever
//! appears in an error message, URL, or `details` preview; every response
//! is strictly validated (a malformed 200 body is a typed
//! `invalid_response` error, never a silent default); upload and
//! download payloads are bounded to [`MAX_TRANSFER_BYTES`]; URL segments
//! derived from platform data are validated before use — including for
//! caller-provided [`GatewayAuth`] (a reviewed hardening over the TS
//! module, which validates only platform-returned credentials); and the
//! transport refuses redirects, so an authenticated gateway call never
//! hops origins.

use std::collections::BTreeMap;
use std::time::Duration;

use crate::client::{http_error, PrimeSandboxClient};
use crate::error::SandboxError;
use crate::transport::{ResponseChunks, SandboxTransport, TransportRequest};
use crate::types::Method;
use crate::wire::{assert_sandbox_id, is_env_var_key, is_url_segment, LOCAL_HOSTNAMES};
use serde::Deserialize;
use uuid::Uuid;

/// Transfer cap for upload and download payloads (TS `MAX_TRANSFER_BYTES`
/// = 200 MiB).
pub const MAX_TRANSFER_BYTES: usize = 200 * 1024 * 1024;

/// Per-exec command timeout cap in seconds (TS `MAX_EXEC_TIMEOUT_SECONDS`,
/// the platform's batch exec limit).
pub const MAX_EXEC_TIMEOUT_SECONDS: i64 = 900;

/// Default exec command timeout in seconds (TS default in
/// `execContainerCommand`).
pub const DEFAULT_EXEC_TIMEOUT_SECONDS: i64 = 300;

/// Cap for error-body reads: previews never read more than this many
/// bytes (TS `MAX_ERROR_BODY_BYTES`).
pub const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;

/// Per-sandbox gateway credentials (the `POST /sandbox/{id}/auth`
/// response; `snake_case` wire form). The token is sandbox-bound and
/// short-lived; callers own caching and expiry refresh (TS contract).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayAuth {
    /// The sandbox the credentials belong to.
    pub sandbox_id: String,
    /// The gateway origin, e.g. `https://sandbox-gw.example.com`.
    pub gateway_url: String,
    /// The gateway user namespace (URL path segment).
    pub user_namespace: String,
    /// The gateway job id (URL path segment).
    pub job_id: String,
    /// The Bearer token for gateway calls. Never logged.
    pub token: String,
    /// ISO-8601 expiry timestamp (validated as a non-empty wire string;
    /// the crate carries no datetime parser — consumers convert on
    /// demand).
    pub expires_at: String,
}

impl GatewayAuth {
    /// The secrets that must never appear in an error message, URL, or
    /// preview when these credentials are in play.
    #[must_use]
    pub fn secrets<'a>(&'a self, api_key: &'a str) -> Vec<&'a str> {
        vec![api_key, self.token.as_str()]
    }
}

/// Options shared by the gateway operations.
#[derive(Debug, Clone, Default)]
pub struct GatewayOptions {
    /// Reuse known gateway auth (must belong to the same sandbox);
    /// fetched from the platform when omitted.
    pub auth: Option<GatewayAuth>,
    /// Per-request deadline override.
    pub request_timeout: Option<Duration>,
}

/// A gateway batch exec request.
#[derive(Debug, Clone)]
pub struct ExecRequest {
    /// The command line executed via shell; non-empty, NUL-free.
    pub command: String,
    /// Working directory inside the sandbox.
    pub working_dir: Option<String>,
    /// Environment overrides; shell-identifier keys.
    pub env: Option<BTreeMap<String, String>>,
    /// Per-exec timeout in seconds; 1..=[`MAX_EXEC_TIMEOUT_SECONDS`],
    /// default [`DEFAULT_EXEC_TIMEOUT_SECONDS`].
    pub timeout_seconds: Option<i64>,
    /// Run as user (container sandboxes only).
    pub user: Option<String>,
}

/// A gateway batch exec result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecResult {
    /// Captured stdout.
    pub stdout: String,
    /// Captured stderr.
    pub stderr: String,
    /// The command's exit code.
    pub exit_code: i64,
}

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

    /// Run a batch command through the gateway REST exec endpoint. This
    /// endpoint serves CONTAINER sandboxes only; it must not be used for
    /// VM sandboxes — VM execution goes through the `ConnectRPC`
    /// `command_session` stream ([`crate::vm_process`]).
    ///
    /// # Errors
    ///
    /// Returns [`SandboxErrorCode::InvalidRequest`] when the request or
    /// the resolved gateway auth fails local validation (nothing is
    /// sent); a status-mapped error for non-2xx responses;
    /// [`SandboxErrorCode::InvalidResponse`] for malformed bodies.
    ///
    /// # Panics
    ///
    /// Panics when `timeout_seconds` falls outside 1..=
    /// [`MAX_EXEC_TIMEOUT_SECONDS`] — it was already validated in this
    /// method before the budget conversion.
    pub async fn exec_container_command(
        &self,
        sandbox_id: &str,
        request: ExecRequest,
        options: &GatewayOptions,
    ) -> Result<ExecResult, SandboxError> {
        assert_sandbox_id(sandbox_id)?;
        validate_exec_request(&request)?;
        let timeout_seconds = request
            .timeout_seconds
            .unwrap_or(DEFAULT_EXEC_TIMEOUT_SECONDS);
        let mut body = serde_json::Map::new();
        body.insert("command".into(), request.command.clone().into());
        body.insert("sandbox_id".into(), sandbox_id.into());
        body.insert("timeout".into(), timeout_seconds.into());
        if let Some(working_dir) = request.working_dir.as_deref() {
            body.insert("working_dir".into(), working_dir.into());
        }
        if let Some(env) = request.env.as_ref() {
            body.insert(
                "env".into(),
                serde_json::Value::Object(
                    env.iter()
                        .map(|(key, value)| (key.clone(), value.clone().into()))
                        .collect(),
                ),
            );
        }
        if let Some(user) = request.user.as_deref() {
            body.insert("user".into(), user.into());
        }
        let auth = self.resolve_gateway_auth(sandbox_id, options).await?;
        let url = gateway_url(&auth, "exec");
        // The request must outlive the command: command budget plus
        // transport overhead (TS scaledExecTimeoutMs).
        let command_budget =
            u64::try_from(timeout_seconds).expect("validated to 1..=MAX_EXEC_TIMEOUT_SECONDS");
        let timeout = self
            .request_timeout_or(options.request_timeout)
            .saturating_add(Duration::from_secs(command_budget));
        self.request_json(
            Method::Post,
            url,
            gateway_headers(&auth, "application/json"),
            Some(serde_json::Value::Object(body).to_string().into_bytes()),
            timeout,
            auth.secrets(self.api_key.as_str()),
            "Sandbox exec",
            parse_exec_result,
        )
        .await
    }

    /// Upload bytes to a path inside the sandbox through the multipart
    /// gateway upload endpoint.
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
        let auth = self.resolve_gateway_auth(sandbox_id, options).await?;
        let url = gateway_query_url(
            &gateway_url(&auth, "upload"),
            &[("path", request.path.as_str()), ("sandbox_id", sandbox_id)],
        )?;
        let boundary = Uuid::new_v4().simple().to_string();
        let body = build_multipart(&request.filename, &request.content, &boundary);
        let headers = gateway_headers(&auth, &format!("multipart/form-data; boundary={boundary}"));
        self.request_json(
            Method::Post,
            url,
            headers,
            Some(body),
            self.request_timeout_or(options.request_timeout),
            auth.secrets(self.api_key.as_str()),
            "Sandbox upload",
            parse_upload_result,
        )
        .await
    }

    /// Download a file from the sandbox as raw bytes, bounded to
    /// [`MAX_TRANSFER_BYTES`]. The body streams under the cap: a body
    /// that exceeds it aborts mid-read instead of buffering first, and a
    /// declared `content-length` over the cap fails before any byte is
    /// read.
    ///
    /// # Errors
    ///
    /// Returns [`SandboxErrorCode::TooLarge`] when the declared or actual
    /// body exceeds [`MAX_TRANSFER_BYTES`],
    /// [`SandboxErrorCode::InvalidRequest`] for invalid paths or gateway
    /// auth, a status-mapped error for non-2xx responses.
    pub async fn download_file(
        &self,
        sandbox_id: &str,
        path: &str,
        options: &GatewayOptions,
    ) -> Result<Vec<u8>, SandboxError> {
        assert_sandbox_id(sandbox_id)?;
        validate_sandbox_file_path(path)?;
        let auth = self.resolve_gateway_auth(sandbox_id, options).await?;
        let url = gateway_query_url(
            &gateway_url(&auth, "download"),
            &[("path", path), ("sandbox_id", sandbox_id)],
        )?;
        let request = TransportRequest {
            method: Method::Get,
            headers: vec![(
                "Authorization".to_string(),
                format!("Bearer {}", auth.token),
            )],
            url: url.clone(),
            body: None,
            max_response_bytes: None,
            timeout: Some(self.request_timeout_or(options.request_timeout)),
        };
        // The deadline covers the open; the body streams under the
        // transfer cap afterwards (TS fetch resolves on the head, then
        // reads outside the timeout).
        let mut response = self.transport.execute_streaming(request).await?;
        if !(200..300).contains(&response.status) {
            let body = read_error_body(&mut response.body, MAX_ERROR_BODY_BYTES).await;
            return Err(http_error(
                Method::Get,
                &url,
                response.status,
                &body,
                &auth.secrets(self.api_key.as_str()),
                "Sandbox download",
            ));
        }
        let declared_length = response
            .header("content-length")
            .and_then(|value| value.trim().parse::<usize>().ok());
        if let Some(declared) = declared_length {
            if declared > MAX_TRANSFER_BYTES {
                return Err(SandboxError::too_large(format!(
                    "Download of {path} declares {declared} bytes, exceeding the {MAX_TRANSFER_BYTES} byte limit"
                )));
            }
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.body.next_chunk().await? {
            if bytes.len() + chunk.len() > MAX_TRANSFER_BYTES {
                return Err(SandboxError::too_large(format!(
                    "Download of {path} exceeds the {MAX_TRANSFER_BYTES} byte limit"
                ))
                .with_http_context(Method::Get, url, None, None));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    /// Resolve the gateway credentials for a call: reuse the provided
    /// auth (same sandbox) or fetch fresh credentials from the platform.
    async fn resolve_gateway_auth(
        &self,
        sandbox_id: &str,
        options: &GatewayOptions,
    ) -> Result<GatewayAuth, SandboxError> {
        match options.auth.as_ref() {
            Some(auth) => {
                if auth.sandbox_id != sandbox_id {
                    return Err(SandboxError::invalid_request(
                        "Provided gateway auth belongs to a different sandbox",
                    ));
                }
                // Reviewed hardening over the TS module, which validates
                // only platform-returned credentials: caller-provided
                // credentials go through the same origin and segment
                // checks, mapped to `invalid_request`.
                validate_gateway_credentials(
                    &auth.gateway_url,
                    &auth.user_namespace,
                    &auth.job_id,
                    self.allow_insecure_localhost,
                )
                .map_err(|error| SandboxError::invalid_request(error.to_string()))?;
                Ok(auth.clone())
            }
            None => self.get_sandbox_auth(sandbox_id, options).await,
        }
    }

    fn request_timeout_or(&self, override_timeout: Option<Duration>) -> Duration {
        override_timeout.unwrap_or(self.request_timeout)
    }
}

/// The gateway endpoint URL `{gateway}/{ns}/{job}/{endpoint}`.
fn gateway_url(auth: &GatewayAuth, endpoint: &str) -> String {
    format!(
        "{}/{}/{}/{}",
        auth.gateway_url, auth.user_namespace, auth.job_id, endpoint
    )
}

/// The gateway call headers: the sandbox-bound Bearer token and the
/// caller's content type (TS `requestJson` headers per call).
fn gateway_headers(auth: &GatewayAuth, content_type: &str) -> Vec<(String, String)> {
    vec![
        (
            "Authorization".to_string(),
            format!("Bearer {}", auth.token),
        ),
        ("Content-Type".to_string(), content_type.to_string()),
    ]
}

/// Read at most `cap` bytes of an error-response body for a preview (TS
/// `boundedErrorBody`); a read failure yields whatever arrived.
async fn read_error_body(body: &mut ResponseChunks, cap: usize) -> Vec<u8> {
    let mut read = Vec::new();
    while read.len() < cap {
        match body.next_chunk().await {
            Ok(Some(chunk)) => {
                let room = cap - read.len();
                let take = chunk.len().min(room);
                read.extend_from_slice(&chunk[..take]);
            }
            Ok(None) | Err(_) => break,
        }
    }
    read
}

/// The auth response contract (TS `getSandboxAuth` parse): `snake_case`
/// fields, all required and non-empty, the gateway origin validated
/// against the client's loopback opt-in.
#[derive(Debug, Deserialize)]
struct RawGatewayAuth {
    #[serde(rename = "gateway_url")]
    gateway_url: String,
    #[serde(rename = "user_ns")]
    user_ns: String,
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
        ("user_ns", raw.user_ns.as_str()),
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
        &raw.user_ns,
        &raw.job_id,
        allow_insecure_localhost,
    )?;
    Ok(GatewayAuth {
        sandbox_id: String::new(),
        // Trailing slashes are trimmed (TS `gatewayUrl.replace(/\/+$/, "")`)
        gateway_url: raw.gateway_url.trim_end_matches('/').to_string(),
        user_namespace: raw.user_ns,
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
    user_namespace: &str,
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
    if !is_url_segment(user_namespace) || !is_url_segment(job_id) {
        return Err(SandboxError::invalid_response(
            "Sandbox auth user_ns and job_id must be URL-safe segments",
        ));
    }
    Ok(())
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

/// Validate an exec request exactly as the TS `execContainerCommand`
/// guards do; nothing is sent when this fails.
fn validate_exec_request(request: &ExecRequest) -> Result<(), SandboxError> {
    if request.command.trim().is_empty() || request.command.contains('\0') {
        return Err(SandboxError::invalid_request(
            "command must be a non-empty NUL-free string",
        ));
    }
    if let Some(working_dir) = request.working_dir.as_deref() {
        if working_dir.is_empty() {
            return Err(SandboxError::invalid_request(
                "workingDir must be a non-empty string",
            ));
        }
    }
    if let Some(user) = request.user.as_deref() {
        if user.is_empty() {
            return Err(SandboxError::invalid_request(
                "user must be a non-empty string",
            ));
        }
    }
    if let Some(env) = request.env.as_ref() {
        for (key, value) in env {
            if !is_env_var_key(key) {
                return Err(SandboxError::invalid_request(format!(
                    "env key {key:?} is not a valid env var name"
                )));
            }
            if value.contains('\0') {
                return Err(SandboxError::invalid_request(
                    "env values must be NUL-free strings",
                ));
            }
        }
    }
    if let Some(timeout) = request.timeout_seconds {
        if !(1..=MAX_EXEC_TIMEOUT_SECONDS).contains(&timeout) {
            return Err(SandboxError::invalid_request(format!(
                "timeoutSeconds must be an integer from 1 to {MAX_EXEC_TIMEOUT_SECONDS}"
            )));
        }
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
/// filename, no per-part content type — `new Blob([content])` carries an
/// empty type), closed by the boundary.
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

/// The exec response contract (TS `execContainerCommand` parse).
fn parse_exec_result(value: serde_json::Value) -> Result<ExecResult, SandboxError> {
    #[derive(Deserialize)]
    struct RawExecResult {
        stdout: String,
        stderr: String,
        #[serde(rename = "exit_code")]
        exit_code: i64,
    }
    if !value.is_object() {
        return Err(SandboxError::invalid_response(
            "Sandbox exec response must be a JSON object",
        ));
    }
    let raw: RawExecResult = serde_json::from_value(value).map_err(|error| {
        SandboxError::invalid_response(format!(
            "Sandbox exec response record is malformed: {error}"
        ))
    })?;
    Ok(ExecResult {
        stdout: raw.stdout,
        stderr: raw.stderr,
        exit_code: raw.exit_code,
    })
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
    fn exec_validation_rejects_each_contract_break() {
        fn request(f: impl FnOnce(&mut ExecRequest)) -> ExecRequest {
            let mut request = ExecRequest {
                command: "ls".to_string(),
                working_dir: None,
                env: None,
                timeout_seconds: None,
                user: None,
            };
            f(&mut request);
            request
        }
        assert!(
            validate_exec_request(&request(|_| {})).is_ok(),
            "the reference request is valid"
        );
        assert!(validate_exec_request(&request(|r| r.command = "  ".to_string())).is_err());
        assert!(validate_exec_request(&request(|r| r.command = "a\0b".to_string())).is_err());
        assert!(validate_exec_request(&request(|r| r.timeout_seconds = Some(0))).is_err());
        assert!(validate_exec_request(&request(
            |r| r.timeout_seconds = Some(MAX_EXEC_TIMEOUT_SECONDS + 1)
        ))
        .is_err());
        assert!(validate_exec_request(&request(|r| r.working_dir = Some(String::new()))).is_err());
        assert!(validate_exec_request(&request(|r| r.user = Some(String::new()))).is_err());
        let mut bad_env = BTreeMap::new();
        bad_env.insert("1BAD".to_string(), "v".to_string());
        assert!(validate_exec_request(&request(|r| r.env = Some(bad_env))).is_err());
    }

    #[test]
    fn sandbox_file_paths_follow_the_contract() {
        validate_sandbox_file_path("/tmp/x.tar").unwrap();
        assert!(validate_sandbox_file_path("").is_err());
        assert!(validate_sandbox_file_path(&format!("/{}", "a".repeat(4096))).is_err());
        assert!(validate_sandbox_file_path("a\0b").is_err());
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
    fn gateway_query_urls_append_params_in_order() {
        let url = gateway_query_url(
            "https://gw.example.com/ns/job/download",
            &[("path", "/out/result.tar"), ("sandbox_id", "sb-1")],
        )
        .unwrap();
        assert_eq!(
            url,
            "https://gw.example.com/ns/job/download?path=%2Fout%2Fresult.tar&sandbox_id=sb-1"
        );
        // Space becomes `+`, the WHATWG `URLSearchParams` encoding.
        let url = gateway_query_url(
            "http://127.0.0.1:1/ns/job/upload",
            &[("path", "/tmp/x y.tar"), ("sandbox_id", "sb-1")],
        )
        .unwrap();
        assert_eq!(
            url,
            "http://127.0.0.1:1/ns/job/upload?path=%2Ftmp%2Fx+y.tar&sandbox_id=sb-1"
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
        assert_eq!(parsed.user_namespace, "ns_user1");
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
    fn exec_responses_parse_strictly() {
        let ok = serde_json::json!({ "stdout": "ok", "stderr": "", "exit_code": 0 });
        assert_eq!(
            parse_exec_result(ok).unwrap(),
            ExecResult {
                stdout: "ok".to_string(),
                stderr: String::new(),
                exit_code: 0
            }
        );
        assert!(parse_exec_result(serde_json::json!({ "stdout": "x" })).is_err());
        assert!(parse_exec_result(serde_json::json!({
            "stdout": "x",
            "stderr": "",
            "exit_code": "0"
        }))
        .is_err());
    }
}
