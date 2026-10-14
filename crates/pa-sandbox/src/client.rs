//! `PrimeSandboxClient`: the Prime Sandboxes VM lifecycle — idempotent
//! create, fetch, delete, and wait-until-running. Port of the lifecycle
//! half of `prime-sandbox-client.ts` (TS branch
//! `feat/direct-cloud-sandbox`), the direct REST surface of the Prime
//! platform:
//!
//! - `POST   {base}/api/v1/sandbox` — create; `snake_case` body, `vm: true`
//!   forced, idempotent through the server-side `idempotency_key` with
//!   client-side retries of transient transport failures;
//! - `GET    {base}/api/v1/sandbox/{id}` — fetch; `camelCase` body;
//! - `DELETE {base}/api/v1/sandbox/{id}` — delete; a 404 is success
//!   (delete is idempotent);
//! - wait: poll fetch until `RUNNING`, fail fast on a terminal status,
//!   fail with `timeout` when the budget is exhausted.
//!
//! Everything is injected (API key, base URL, transport, team id,
//! deadlines); nothing is read from the environment or `~/.prime`, so the
//! client is embeddable and testable. Gateway operations (auth, exec,
//! upload, download) are the next slice; VM execution needs the
//! `ConnectRPC` `command_session` stream, not this REST surface.

use std::time::{Duration, Instant};

use crate::error::{SandboxError, SandboxErrorCode};
use crate::record::parse_sandbox;
use crate::transport::{ReqwestSandboxTransport, SandboxTransport, TransportRequest};
use crate::types::{
    Method, Sandbox, SandboxStatus, VmCreateRequest, WaitOptions, DEFAULT_REQUEST_TIMEOUT,
    PRIME_SANDBOX_CREATE_MAX_ATTEMPTS,
};
use crate::wire::{
    assert_sandbox_id, build_create_body, normalize_base_url, validate_create_request,
};

/// The Prime platform API origin (TS `DEFAULT_BASE_URL` in
/// `direct-cloud-service.ts`).
pub const DEFAULT_BASE_URL: &str = "https://api.primeintellect.ai";

/// Construction options; every field except the base URL has a safe
/// default.
#[derive(Debug, Clone)]
pub struct ClientOptions {
    /// The Prime platform API origin, e.g. `https://api.primeintellect.ai`.
    /// A trailing `/api/v1` is accepted and normalized away.
    pub base_url: String,
    /// Team id appended to create requests when set; an empty string is
    /// treated as unset (TS behavior).
    pub team_id: Option<String>,
    /// Default per-request deadline; `None` is 30 s.
    pub request_timeout: Option<Duration>,
    /// Permit plain `http://` for loopback hosts only — for local tests of
    /// the real transport. Everything else must be `https://`.
    pub allow_insecure_localhost: bool,
}

/// The Prime Sandboxes lifecycle client. The default transport is
/// reqwest; tests inject a scripted transport through
/// [`PrimeSandboxClient::with_transport`].
pub struct PrimeSandboxClient<T: SandboxTransport = ReqwestSandboxTransport> {
    transport: T,
    api_key: String,
    base_url: String,
    team_id: Option<String>,
    request_timeout: Duration,
}

impl<T: SandboxTransport + std::fmt::Debug> std::fmt::Debug for PrimeSandboxClient<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrimeSandboxClient")
            .field("transport", &self.transport)
            .field("api_key", &"[redacted]")
            .field("base_url", &self.base_url)
            .field("team_id", &self.team_id)
            .field("request_timeout", &self.request_timeout)
            .finish()
    }
}

impl PrimeSandboxClient<ReqwestSandboxTransport> {
    /// The production client against `options.base_url`.
    ///
    /// # Errors
    ///
    /// Returns [`SandboxErrorCode::InvalidRequest`] when the API key is
    /// empty, the base URL is not an acceptable https origin, or the
    /// request deadline is not positive.
    pub fn new(api_key: &str, options: ClientOptions) -> Result<Self, SandboxError> {
        Self::with_transport(ReqwestSandboxTransport::new(), api_key, options)
    }
}

impl<T: SandboxTransport> PrimeSandboxClient<T> {
    /// A client over an injected transport.
    ///
    /// # Errors
    ///
    /// Returns [`SandboxErrorCode::InvalidRequest`] when the API key is
    /// empty, the base URL is not an acceptable https origin, or the
    /// request deadline is not positive.
    pub fn with_transport(
        transport: T,
        api_key: &str,
        options: ClientOptions,
    ) -> Result<Self, SandboxError> {
        if api_key.is_empty() {
            return Err(SandboxError::invalid_request(
                "Prime sandbox client requires a non-empty apiKey",
            ));
        }
        let base_url = normalize_base_url(&options.base_url, options.allow_insecure_localhost)?;
        let request_timeout = options.request_timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT);
        if request_timeout.is_zero() {
            return Err(SandboxError::invalid_request(
                "requestTimeout must be a positive duration",
            ));
        }
        Ok(Self {
            transport,
            api_key: api_key.to_string(),
            base_url,
            team_id: options.team_id.filter(|team_id| !team_id.is_empty()),
            request_timeout,
        })
    }

    /// Create a VM-backed sandbox. Idempotent: transient (network or
    /// timeout) failures retry up to [`PRIME_SANDBOX_CREATE_MAX_ATTEMPTS`]
    /// times reusing the same server-side `idempotency_key`, so a retried
    /// create can never provision a second sandbox.
    ///
    /// # Errors
    ///
    /// Returns [`SandboxErrorCode::InvalidRequest`] when the request fails
    /// local validation (nothing is sent); the last transient transport
    /// error when every retry fails; a status-mapped error otherwise.
    pub async fn create_vm_sandbox(
        &self,
        request: VmCreateRequest,
    ) -> Result<Sandbox, SandboxError> {
        validate_create_request(&request)?;
        let idempotency_key = request
            .idempotency_key
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        let body = build_create_body(&request, &idempotency_key, self.team_id.as_deref());
        let url = format!("{}/api/v1/sandbox", self.base_url);
        let mut last_error = None;
        for attempt in 1..=PRIME_SANDBOX_CREATE_MAX_ATTEMPTS {
            let outcome = self
                .request_json(
                    Method::Post,
                    url.clone(),
                    Some(body.to_string()),
                    "Sandbox create",
                    parse_sandbox,
                )
                .await;
            match outcome {
                Ok(sandbox) => return Ok(sandbox),
                Err(error) if error.is_transient_transport() => {
                    if attempt < PRIME_SANDBOX_CREATE_MAX_ATTEMPTS {
                        last_error = Some(error);
                    } else {
                        return Err(error);
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_error.unwrap_or_else(|| SandboxError::network("Sandbox create failed")))
    }

    /// Fetch a sandbox by id.
    ///
    /// # Errors
    ///
    /// Returns a status-mapped error for non-2xx responses and
    /// [`SandboxErrorCode::InvalidResponse`] for malformed 200 bodies.
    pub async fn get_sandbox(&self, sandbox_id: &str) -> Result<Sandbox, SandboxError> {
        assert_sandbox_id(sandbox_id)?;
        self.request_json(
            Method::Get,
            format!("{}/api/v1/sandbox/{sandbox_id}", self.base_url),
            None,
            "Sandbox fetch",
            parse_sandbox,
        )
        .await
    }

    /// Delete a sandbox by id. Idempotent: a 404 is success.
    ///
    /// # Errors
    ///
    /// Returns a status-mapped error for other non-2xx responses and
    /// [`SandboxErrorCode::InvalidResponse`] when the 200 body is not a
    /// JSON object.
    pub async fn delete_sandbox(&self, sandbox_id: &str) -> Result<(), SandboxError> {
        assert_sandbox_id(sandbox_id)?;
        let outcome = self
            .request_json(
                Method::Delete,
                format!("{}/api/v1/sandbox/{sandbox_id}", self.base_url),
                None,
                "Sandbox delete",
                |value| require_delete_response(&value),
            )
            .await;
        match outcome {
            Ok(()) => Ok(()),
            Err(error) => {
                if error.code() == SandboxErrorCode::Http && error.status() == Some(404) {
                    Ok(())
                } else {
                    Err(error)
                }
            }
        }
    }

    /// Poll a sandbox until it reports `RUNNING`: fail fast with a typed
    /// `terminal_status` error as soon as the sandbox reaches a terminal
    /// state (`ERROR`/`TERMINATED`/`TIMEOUT`), and fail with `timeout`
    /// when the wait budget is exhausted first.
    ///
    /// # Errors
    ///
    /// Returns [`SandboxErrorCode::TerminalStatus`] with the redacted
    /// platform error in `details`, or [`SandboxErrorCode::Timeout`] with
    /// the last observed status in `details`.
    pub async fn wait_for_running(
        &self,
        sandbox_id: &str,
        options: WaitOptions,
    ) -> Result<Sandbox, SandboxError> {
        assert_sandbox_id(sandbox_id)?;
        if options.timeout.is_zero() || options.poll_interval.is_zero() {
            return Err(SandboxError::invalid_request(
                "wait_for_running requires positive timeout and pollInterval",
            ));
        }
        let deadline = Instant::now() + options.timeout;
        loop {
            let sandbox = self.get_sandbox(sandbox_id).await?;
            if sandbox.status == SandboxStatus::Running {
                return Ok(sandbox);
            }
            if sandbox.status.is_terminal() {
                let joined = [
                    sandbox.error_type.as_deref(),
                    sandbox.error_message.as_deref(),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<&str>>()
                .join(": ");
                let details = if joined.is_empty() {
                    None
                } else {
                    Some(SandboxError::redact_secrets(
                        &joined,
                        &[self.api_key.as_str()],
                    ))
                };
                return Err(SandboxError::terminal_status(format!(
                    "Sandbox {sandbox_id} reached terminal status {}",
                    sandbox.status.as_str()
                ))
                .with_details(details));
            }
            if Instant::now() >= deadline {
                return Err(SandboxError::timeout(format!(
                    "Timed out waiting for sandbox {sandbox_id} to become RUNNING"
                ))
                .with_details(Some(format!("last status {}", sandbox.status.as_str()))));
            }
            tokio::time::sleep(options.poll_interval).await;
        }
    }

    fn platform_headers(&self) -> Vec<(String, String)> {
        vec![
            (
                "Authorization".to_string(),
                format!("Bearer {}", self.api_key),
            ),
            ("Content-Type".to_string(), "application/json".to_string()),
        ]
    }

    fn platform_secrets(&self) -> Vec<&str> {
        vec![self.api_key.as_str()]
    }

    /// The shared JSON request pipeline: typed transport errors, status
    /// mapping with a bounded redacted `details` preview, and strict
    /// response parsing.
    async fn request_json<R, Parse>(
        &self,
        method: Method,
        url: String,
        body: Option<String>,
        context: &str,
        parse: Parse,
    ) -> Result<R, SandboxError>
    where
        Parse: FnOnce(serde_json::Value) -> Result<R, SandboxError>,
    {
        let request = TransportRequest {
            method,
            headers: self.platform_headers(),
            url: url.clone(),
            body,
            timeout: self.request_timeout,
        };
        // Transport errors already carry the method and url.
        let response = self.transport.execute(request).await?;
        if !(200..300).contains(&response.status) {
            return Err(http_error(
                method,
                &url,
                response.status,
                &response.body,
                &self.platform_secrets(),
                context,
            ));
        }
        let value = serde_json::from_slice(&response.body).map_err(|error| {
            SandboxError::invalid_response(format!(
                "{context} returned a non-JSON response: {error}"
            ))
            .with_http_context(method, url.clone(), Some(response.status), None)
        })?;
        parse(value)
            .map_err(|error| error.with_http_context(method, url, Some(response.status), None))
    }
}

/// The delete response contract: any JSON object (TS checks
/// `isRecord(value)`).
fn require_delete_response(value: &serde_json::Value) -> Result<(), SandboxError> {
    if value.is_object() {
        Ok(())
    } else {
        Err(SandboxError::invalid_response(
            "Sandbox delete response must be a JSON object",
        ))
    }
}

/// Map a non-2xx response onto the typed error contract (TS `httpError`):
/// a 3xx is a refused redirect (the transport never follows one; the
/// TS module rides the default-following `fetch`, a reviewed deviation),
/// HTTP 408 is a `request_timeout`, HTTP 409 a `conflict`, and HTTP 502
/// with `{ "error": "sandbox_not_found" }` a `sandbox_not_found`; anything
/// else is a generic `http` error. `details` carries a bounded,
/// secret-scrubbed preview of the response body.
fn http_error(
    method: Method,
    url: &str,
    status: u16,
    body: &[u8],
    secrets: &[&str],
    context: &str,
) -> SandboxError {
    let text = String::from_utf8_lossy(body);
    let details = SandboxError::preview_from_text(&text, secrets);
    let sandbox_not_found = status == 502
        && serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|parsed| {
                parsed
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .map(|error| error == "sandbox_not_found")
            })
            .unwrap_or(false);
    if (300..400).contains(&status) {
        // Refused redirect (the transport never follows): surfaced as its
        // own message so the failure reads as configuration, not as a
        // generic server error.
        return SandboxError::http(format!(
            "{context} refused a redirect (HTTP {status}); the sandbox API base URL is a client configuration change, not a silent hop"
        ))
        .with_http_context(method, url, Some(status), details);
    }
    let error = if status == 408 {
        SandboxError::request_timeout(format!("{context} timed out on the server (HTTP 408)"))
    } else if status == 409 {
        SandboxError::conflict(format!(
            "{context} returned a conflict (HTTP 409); this is typically transient"
        ))
    } else if sandbox_not_found {
        SandboxError::sandbox_not_found(format!(
            "{context} target sandbox is no longer present on the runtime node"
        ))
    } else {
        SandboxError::http(format!("{context} failed with HTTP {status}"))
    };
    error.with_http_context(method, url, Some(status), details)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_debug_redacts_api_key() {
        let key = "sk-synthetic-private-key";
        let client = PrimeSandboxClient::new(
            key,
            ClientOptions {
                base_url: DEFAULT_BASE_URL.to_string(),
                team_id: Some("team-1".to_string()),
                request_timeout: None,
                allow_insecure_localhost: false,
            },
        )
        .unwrap();
        let rendered = format!("{client:?}");
        assert!(!rendered.contains(key));
        assert!(rendered.contains(r#"api_key: "[redacted]""#));
        assert!(rendered.contains(DEFAULT_BASE_URL));
    }
}
