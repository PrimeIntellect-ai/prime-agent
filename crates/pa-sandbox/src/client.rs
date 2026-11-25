//! `PrimeSandboxClient`: the Prime Sandboxes VM lifecycle over the platform
//! REST API:
//!
//! - `POST   {base}/api/v1/sandbox` — create; `snake_case` body, `vm: true`
//!   forced, idempotent through the server-side `idempotency_key` with
//!   client-side retries of transient transport failures;
//! - `GET    {base}/api/v1/sandbox/{id}` — fetch;
//! - `GET    {base}/api/v1/sandbox?labels=..` — list by label, all pages;
//! - `POST   {base}/api/v1/sandbox/{id}/pause|resume` — pause and resume;
//! - `PUT    {base}/api/v1/sandbox/{id}/egress-policy` — replace the
//!   network policy (header rules included);
//! - `DELETE {base}/api/v1/sandbox/{id}` — delete; a 404 is success;
//! - `{base}/api/v1/sandbox/{id}/checkpoints` and
//!   `{base}/api/v1/sandbox/checkpoints/{id}` — filesystem checkpoints;
//! - `GET    {base}/api/v1/sandbox/checkpoints?labels=..` — the
//!   account's checkpoints across sandboxes (deleted ones included).

use std::collections::{BTreeMap, HashSet};
use std::time::{Duration, Instant};

use crate::error::SandboxError;
use crate::record::{
    parse_checkpoint, parse_checkpoint_page, parse_paused, parse_sandbox, parse_sandbox_page,
};
use crate::transport::{ReqwestSandboxTransport, SandboxTransport, TransportRequest};
use crate::types::{
    HeaderRule, Method, PausedSandbox, Sandbox, SandboxCheckpoint, SandboxStatus, VmCreateRequest,
    WaitOptions, DEFAULT_REQUEST_TIMEOUT, PRIME_SANDBOX_CREATE_MAX_ATTEMPTS,
};
use crate::wire::{
    assert_sandbox_id, build_create_body, normalize_base_url, validate_create_request,
};

/// The Prime platform API origin.
pub const DEFAULT_BASE_URL: &str = "https://api.primeintellect.ai";

/// Construction options; every field except the base URL has a safe
/// default.
#[derive(Debug, Clone)]
pub struct ClientOptions {
    /// The Prime platform API origin, e.g. `https://api.primeintellect.ai`.
    /// A trailing `/api/v1` is accepted and normalized away.
    pub base_url: String,
    /// Team id appended to create requests when set; an empty string is
    /// treated as unset.
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
    pub(crate) transport: T,
    pub(crate) api_key: String,
    pub(crate) base_url: String,
    pub(crate) team_id: Option<String>,
    pub(crate) request_timeout: Duration,
    pub(crate) allow_insecure_localhost: bool,
}

impl<T: SandboxTransport + std::fmt::Debug> std::fmt::Debug for PrimeSandboxClient<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrimeSandboxClient")
            .field("transport", &self.transport)
            .field("api_key", &"[redacted]")
            .field("base_url", &self.base_url)
            .field("team_id", &self.team_id)
            .field("request_timeout", &self.request_timeout)
            .field("allow_insecure_localhost", &self.allow_insecure_localhost)
            .finish()
    }
}

impl PrimeSandboxClient<ReqwestSandboxTransport> {
    /// The production client against `options.base_url`.
    ///
    /// # Errors
    ///
    /// Returns [`crate::SandboxErrorCode::InvalidRequest`] when the API key is
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
    /// Returns [`crate::SandboxErrorCode::InvalidRequest`] when the API key is
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
            allow_insecure_localhost: options.allow_insecure_localhost,
        })
    }

    /// The normalized platform origin the client calls.
    #[must_use]
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// The team the client scopes creates and secrets to, when set.
    #[must_use]
    pub fn team_id(&self) -> Option<&str> {
        self.team_id.as_deref()
    }

    /// Create a VM-backed sandbox. Idempotent: transient (network or
    /// timeout) failures retry up to [`PRIME_SANDBOX_CREATE_MAX_ATTEMPTS`]
    /// times reusing the same server-side `idempotency_key`, so a retried
    /// create can never provision a second sandbox.
    ///
    /// # Errors
    ///
    /// Returns [`crate::SandboxErrorCode::InvalidRequest`] when the request fails
    /// local validation (nothing is sent); the last transient transport
    /// error when every retry fails; a status-mapped error otherwise.
    pub async fn create_vm_sandbox(
        &self,
        request: &VmCreateRequest,
    ) -> Result<Sandbox, SandboxError> {
        validate_create_request(request)?;
        let idempotency_key = request
            .idempotency_key
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        let body = build_create_body(request, &idempotency_key, self.team_id.as_deref());
        let url = format!("{}/api/v1/sandbox", self.base_url);
        let mut last_error = None;
        for attempt in 1..=PRIME_SANDBOX_CREATE_MAX_ATTEMPTS {
            let outcome = self
                .request_json(
                    Method::Post,
                    url.clone(),
                    self.platform_headers(),
                    Some(body.to_string().into_bytes()),
                    self.request_timeout,
                    self.platform_secrets(),
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
    /// [`crate::SandboxErrorCode::InvalidResponse`] for malformed 200 bodies.
    pub async fn get_sandbox(&self, sandbox_id: &str) -> Result<Sandbox, SandboxError> {
        assert_sandbox_id(sandbox_id)?;
        self.request_json(
            Method::Get,
            format!("{}/api/v1/sandbox/{sandbox_id}", self.base_url),
            self.platform_headers(),
            None,
            self.request_timeout,
            self.platform_secrets(),
            "Sandbox fetch",
            parse_sandbox,
        )
        .await
    }

    /// List the sandboxes carrying every label in `labels`, following
    /// every page. Terminated sandboxes are left out.
    ///
    /// # Errors
    ///
    /// Returns a status-mapped error for non-2xx responses and
    /// [`crate::SandboxErrorCode::InvalidResponse`] for a malformed page or
    /// pagination that does not advance.
    pub async fn list_sandboxes(&self, labels: &[String]) -> Result<Vec<Sandbox>, SandboxError> {
        let mut sandboxes = Vec::new();
        let mut page: u64 = 1;
        let mut cursor: Option<String> = None;
        let mut seen_cursors = HashSet::new();
        loop {
            let mut url = url::Url::parse(&format!("{}/api/v1/sandbox", self.base_url))
                .map_err(|_| SandboxError::invalid_request("Sandbox list URL is invalid"))?;
            {
                let mut query = url.query_pairs_mut();
                query.append_pair("per_page", "100");
                query.append_pair("is_active", "true");
                for label in labels {
                    query.append_pair("labels", label);
                }
                if let Some(team_id) = self.team_id.as_deref() {
                    query.append_pair("team_id", team_id);
                }
                match cursor.as_deref() {
                    Some(cursor) => query.append_pair("cursor", cursor),
                    None => query.append_pair("page", &page.to_string()),
                };
            }
            let result = self
                .request_json(
                    Method::Get,
                    url.to_string(),
                    self.platform_headers(),
                    None,
                    self.request_timeout,
                    self.platform_secrets(),
                    "Sandbox list",
                    parse_sandbox_page,
                )
                .await?;
            sandboxes.extend(result.sandboxes);
            if !result.has_next {
                return Ok(sandboxes);
            }
            match result.next_cursor {
                Some(next) if seen_cursors.insert(next.clone()) => cursor = Some(next),
                None if cursor.is_none() && result.page >= page => page = result.page + 1,
                Some(_) | None => {
                    return Err(SandboxError::invalid_response(
                        "Sandbox list pagination did not advance",
                    ));
                }
            }
        }
    }

    /// Request a pause of a running VM sandbox. It reaches `PAUSED`
    /// asynchronously; [`Self::resume_sandbox`] continues it.
    ///
    /// # Errors
    ///
    /// Returns a status-mapped error for non-2xx responses (a 409
    /// `conflict` when the sandbox cannot pause now) and
    /// [`crate::SandboxErrorCode::InvalidResponse`] for a malformed 200 body.
    pub async fn pause_sandbox(&self, sandbox_id: &str) -> Result<PausedSandbox, SandboxError> {
        assert_sandbox_id(sandbox_id)?;
        self.request_json(
            Method::Post,
            format!("{}/api/v1/sandbox/{sandbox_id}/pause", self.base_url),
            self.platform_headers(),
            None,
            self.request_timeout,
            self.platform_secrets(),
            "Sandbox pause",
            parse_paused,
        )
        .await
    }

    /// Request a resume of a paused VM sandbox. It reaches `RUNNING`
    /// asynchronously; use [`Self::wait_for_running`].
    ///
    /// # Errors
    ///
    /// Returns a status-mapped error for non-2xx responses and
    /// [`crate::SandboxErrorCode::InvalidResponse`] for a malformed 200 body.
    pub async fn resume_sandbox(&self, sandbox_id: &str) -> Result<Sandbox, SandboxError> {
        assert_sandbox_id(sandbox_id)?;
        self.request_json(
            Method::Post,
            format!("{}/api/v1/sandbox/{sandbox_id}/resume", self.base_url),
            self.platform_headers(),
            None,
            self.request_timeout,
            self.platform_secrets(),
            "Sandbox resume",
            parse_sandbox,
        )
        .await
    }

    /// Replace the egress policy of a running or paused VM sandbox: no
    /// allow or deny list (all egress allowed) and `rules` as the full set
    /// of header rules. The platform replaces the whole policy; a paused
    /// sandbox gets it on resume.
    ///
    /// # Errors
    ///
    /// Returns a status-mapped error for non-2xx responses.
    pub async fn set_network_rules(
        &self,
        sandbox_id: &str,
        rules: &BTreeMap<String, HeaderRule>,
    ) -> Result<(), SandboxError> {
        assert_sandbox_id(sandbox_id)?;
        // An empty denylist is the platform's "allow all".
        let body = serde_json::json!({ "denylist": [], "rules": rules })
            .to_string()
            .into_bytes();
        self.request_json(
            Method::Put,
            format!(
                "{}/api/v1/sandbox/{sandbox_id}/egress-policy",
                self.base_url
            ),
            self.platform_headers(),
            Some(body),
            self.request_timeout,
            self.platform_secrets(),
            "Sandbox egress policy update",
            |_| Ok(()),
        )
        .await
    }

    /// Delete a sandbox by id. Idempotent: a 404 is success.
    ///
    /// # Errors
    ///
    /// Returns a status-mapped error for other non-2xx responses. Any 2xx
    /// is success, whatever its body.
    pub async fn delete_sandbox(&self, sandbox_id: &str) -> Result<(), SandboxError> {
        assert_sandbox_id(sandbox_id)?;
        self.delete_tolerating_404(
            format!("{}/api/v1/sandbox/{sandbox_id}", self.base_url),
            "Sandbox delete",
        )
        .await
    }

    /// Poll a sandbox until it reports `RUNNING`: fail fast with a typed
    /// `terminal_status` error as soon as the sandbox reaches a terminal
    /// state (`ERROR`/`TERMINATED`/`TIMEOUT`), and fail with `timeout`
    /// when the wait budget is exhausted first.
    ///
    /// # Errors
    ///
    /// Returns [`crate::SandboxErrorCode::TerminalStatus`] with the redacted
    /// platform error in `details`, or [`crate::SandboxErrorCode::Timeout`] with
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
            tokio::time::sleep(options.poll_interval.min(deadline - Instant::now())).await;
        }
    }

    pub(crate) fn platform_headers(&self) -> Vec<(String, String)> {
        vec![
            (
                "Authorization".to_string(),
                format!("Bearer {}", self.api_key),
            ),
            ("Content-Type".to_string(), "application/json".to_string()),
        ]
    }

    pub(crate) fn platform_secrets(&self) -> Vec<&str> {
        vec![self.api_key.as_str()]
    }

    /// The shared JSON request pipeline: typed transport errors, status
    /// mapping with a bounded redacted `details` preview, and strict
    /// response parsing.
    // Each argument is part of the request; bundling them would add a single-use struct.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn request_json<R, Parse>(
        &self,
        method: Method,
        url: String,
        headers: Vec<(String, String)>,
        body: Option<Vec<u8>>,
        timeout: Duration,
        secrets: Vec<&str>,
        context: &str,
        parse: Parse,
    ) -> Result<R, SandboxError>
    where
        Parse: FnOnce(serde_json::Value) -> Result<R, SandboxError>,
    {
        let request = TransportRequest {
            method,
            headers,
            url: url.clone(),
            body,
            max_response_bytes: None,
            timeout: Some(timeout),
        };
        // Transport errors already carry the method and url.
        let response = self.transport.execute(request).await?;
        if !(200..300).contains(&response.status) {
            return Err(http_error(
                method,
                &url,
                response.status,
                &response.body,
                &secrets,
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
    /// Create a filesystem checkpoint of the sandbox's root filesystem.
    /// The checkpoint only outlives the sandbox once it reaches `DURABLE`
    /// ([`Self::wait_for_checkpoint`]); keep the source sandbox alive
    /// until then.
    ///
    /// # Errors
    ///
    /// Returns a status-mapped error for non-2xx responses and
    /// [`crate::SandboxErrorCode::InvalidResponse`] for a malformed 200 body.
    pub async fn create_checkpoint(
        &self,
        sandbox_id: &str,
    ) -> Result<SandboxCheckpoint, SandboxError> {
        assert_sandbox_id(sandbox_id)?;
        self.request_json(
            Method::Post,
            format!("{}/api/v1/sandbox/{sandbox_id}/checkpoints", self.base_url),
            self.platform_headers(),
            None,
            self.request_timeout,
            self.platform_secrets(),
            "Checkpoint create",
            parse_checkpoint,
        )
        .await
    }

    /// Fetch one checkpoint by id.
    ///
    /// # Errors
    ///
    /// Returns a status-mapped error for non-2xx responses and
    /// [`crate::SandboxErrorCode::InvalidResponse`] for a malformed 200 body.
    pub async fn get_checkpoint(
        &self,
        checkpoint_id: &str,
    ) -> Result<SandboxCheckpoint, SandboxError> {
        assert_sandbox_id(checkpoint_id)?;
        self.request_json(
            Method::Get,
            format!(
                "{}/api/v1/sandbox/checkpoints/{checkpoint_id}",
                self.base_url
            ),
            self.platform_headers(),
            None,
            self.request_timeout,
            self.platform_secrets(),
            "Checkpoint fetch",
            parse_checkpoint,
        )
        .await
    }

    /// List the account's rootfs checkpoints across sandboxes — only
    /// those of sandboxes carrying every `label` — all pages, oldest
    /// first. Checkpoints of deleted sandboxes are included, so a
    /// sandbox's newest checkpoint stays findable after it ends.
    ///
    /// # Errors
    ///
    /// Returns a status-mapped error for non-2xx responses and
    /// [`crate::SandboxErrorCode::InvalidResponse`] for a malformed 200
    /// body or a pagination that does not advance.
    pub async fn list_checkpoints(
        &self,
        labels: &[String],
    ) -> Result<Vec<SandboxCheckpoint>, SandboxError> {
        let mut checkpoints = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen_cursors = HashSet::new();
        loop {
            let mut url = url::Url::parse(&format!("{}/api/v1/sandbox/checkpoints", self.base_url))
                .map_err(|_| SandboxError::invalid_request("Checkpoint list URL is invalid"))?;
            {
                let mut query = url.query_pairs_mut();
                query.append_pair("limit", "500");
                for label in labels {
                    query.append_pair("labels", label);
                }
                if let Some(team_id) = self.team_id.as_deref() {
                    query.append_pair("team_id", team_id);
                }
                if let Some(cursor) = cursor.as_deref() {
                    query.append_pair("cursor", cursor);
                }
            }
            let result = self
                .request_json(
                    Method::Get,
                    url.to_string(),
                    self.platform_headers(),
                    None,
                    self.request_timeout,
                    self.platform_secrets(),
                    "Checkpoint list",
                    parse_checkpoint_page,
                )
                .await?;
            checkpoints.extend(result.checkpoints);
            match result.next_cursor {
                Some(next) if seen_cursors.insert(next.clone()) => cursor = Some(next),
                Some(_) => {
                    return Err(SandboxError::invalid_response(
                        "Checkpoint list pagination did not advance",
                    ));
                }
                None => return Ok(checkpoints),
            }
        }
    }

    /// Delete one checkpoint by id; its storage billing stops (the
    /// platform keeps the data while descendant checkpoints still need
    /// it). Idempotent: a 404 is success, and so is any 2xx whatever its
    /// body (the platform may answer 204 with none).
    ///
    /// # Errors
    ///
    /// Returns a status-mapped error for other non-2xx responses — a 409
    /// `conflict` while the checkpoint is pending or is the active tip of
    /// a running sandbox.
    pub async fn delete_checkpoint(&self, checkpoint_id: &str) -> Result<(), SandboxError> {
        assert_sandbox_id(checkpoint_id)?;
        self.delete_tolerating_404(
            format!(
                "{}/api/v1/sandbox/checkpoints/{checkpoint_id}",
                self.base_url
            ),
            "Checkpoint delete",
        )
        .await
    }

    /// An idempotent platform delete: any 2xx (whatever its body) and a
    /// 404 are success.
    pub(crate) async fn delete_tolerating_404(
        &self,
        url: String,
        context: &str,
    ) -> Result<(), SandboxError> {
        let response = self
            .transport
            .execute(TransportRequest {
                method: Method::Delete,
                headers: self.platform_headers(),
                url: url.clone(),
                body: None,
                max_response_bytes: None,
                timeout: Some(self.request_timeout),
            })
            .await?;
        if (200..300).contains(&response.status) || response.status == 404 {
            return Ok(());
        }
        Err(http_error(
            Method::Delete,
            &url,
            response.status,
            &response.body,
            &self.platform_secrets(),
            context,
        ))
    }

    /// Poll a checkpoint until it becomes `DURABLE` (fail fast on a
    /// terminal failure state, `timeout` when the wait budget runs out).
    ///
    /// # Errors
    ///
    /// Returns [`crate::SandboxErrorCode::TerminalStatus`] with the terminal
    /// state in the message and the redacted checkpoint error in `details`, or
    /// [`crate::SandboxErrorCode::Timeout`] with the last state in the message.
    pub async fn wait_for_checkpoint(
        &self,
        checkpoint_id: &str,
        timeout: Duration,
        poll_interval: Duration,
    ) -> Result<SandboxCheckpoint, SandboxError> {
        if timeout.is_zero() || poll_interval.is_zero() {
            return Err(SandboxError::invalid_request(
                "wait_for_checkpoint requires positive timeout and pollInterval",
            ));
        }
        let deadline = Instant::now() + timeout;
        loop {
            let checkpoint = self.get_checkpoint(checkpoint_id).await?;
            if checkpoint.is_durable() {
                return Ok(checkpoint);
            }
            // The platform freezes the sandbox's disk while snapshotting;
            // FROZEN is an in-flight state on the way to DURABLE.
            if checkpoint.state != "PENDING" && checkpoint.state != "FROZEN" {
                let details = checkpoint
                    .error
                    .as_deref()
                    .map(|error| SandboxError::redact_secrets(error, &[self.api_key.as_str()]));
                return Err(SandboxError::terminal_status(format!(
                    "checkpoint {checkpoint_id} reached terminal state {}",
                    checkpoint.state
                ))
                .with_details(details));
            }
            if Instant::now() >= deadline {
                return Err(SandboxError::timeout(format!(
                    "checkpoint {checkpoint_id} never reached DURABLE (last state {})",
                    checkpoint.state
                )));
            }
            tokio::time::sleep(poll_interval.min(deadline - Instant::now())).await;
        }
    }
}

/// Map a non-2xx response onto the typed error contract:
/// a 3xx is a refused redirect (the transport never follows one),
/// HTTP 408 is a `request_timeout`, HTTP 409 a `conflict`, and HTTP 502
/// with `{ "error": "sandbox_not_found" }` a `sandbox_not_found`; anything
/// else is a generic `http` error. `details` carries a bounded,
/// secret-scrubbed preview of the response body.
pub(crate) fn http_error(
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
