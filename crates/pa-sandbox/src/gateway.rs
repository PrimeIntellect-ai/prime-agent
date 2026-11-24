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

    fn request_timeout_or(&self, override_timeout: Option<Duration>) -> Duration {
        override_timeout.unwrap_or(self.request_timeout)
    }
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
