//! The sandbox HTTP transport: one injectable trait, one reqwest production
//! implementation. Port of the `fetchWithTimeout` + `boundedBodyText` half
//! of `prime-sandbox-client.ts` (TS branch `feat/direct-cloud-sandbox`):
//! - a per-request deadline raced against the request (the timeout wins
//!   even when the server never answers);
//! - response bodies are read through a streaming cap (32 MiB default), so
//!   an unbounded body is a typed `too_large` error, never an unbounded
//!   allocation;
//! - transport failures are already-typed [`SandboxError`]s carrying the
//!   request method and URL; non-2xx statuses are returned to the caller,
//!   which owns the error-body preview (the transport never parses);
//! - redirects are refused (`reqwest::redirect::Policy::none()`, a
//!   reviewed deviation from the TS module's default-following `fetch`):
//!   an authenticated platform call never hops origins, so the Bearer key
//!   cannot leak toward a redirect target; a moved sandbox API is a
//!   client configuration change, never a silent hop.

use std::future::Future;
use std::time::Duration;

use crate::error::SandboxError;
use crate::types::Method;

/// Default response body cap (TS `MAX_JSON_BODY_BYTES` = 32 MiB).
pub const MAX_JSON_BODY_BYTES: usize = 32 * 1024 * 1024;

/// One outbound HTTP request.
/// HTTP request values must not appear in debug output: headers contain
/// Authorization and the body may contain sandbox secrets.
#[derive(Clone)]
pub struct TransportRequest {
    /// The request method.
    pub method: Method,
    /// The absolute request URL (already validated by the caller).
    pub url: String,
    /// The request headers, in send order.
    pub headers: Vec<(String, String)>,
    /// The request body; `None` sends no body.
    pub body: Option<String>,
    /// The per-request deadline.
    pub timeout: Duration,
}

impl std::fmt::Debug for TransportRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let header_names: Vec<_> = self.headers.iter().map(|(name, _)| name).collect();
        f.debug_struct("TransportRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("headers", &header_names)
            .field("body", &self.body.as_ref().map(|_| "[redacted]"))
            .field("timeout", &self.timeout)
            .finish()
    }
}

/// One inbound HTTP response, for every status.
#[derive(Clone)]
pub struct TransportResponse {
    /// The response status.
    pub status: u16,
    /// The response body, read under the transport's byte cap.
    pub body: Vec<u8>,
}

impl std::fmt::Debug for TransportResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransportResponse")
            .field("status", &self.status)
            .field("body_bytes", &self.body.len())
            .finish()
    }
}

/// The sandbox HTTP transport. Implementations execute one request and
/// return typed errors; they never parse bodies or map statuses, which
/// stays in the client so error previews keep a single redaction path.
pub trait SandboxTransport: Send + Sync {
    /// Execute `request`; `Err` carries the request method and URL.
    fn execute(
        &self,
        request: TransportRequest,
    ) -> impl Future<Output = Result<TransportResponse, SandboxError>> + Send;
}

/// The production transport: reqwest with rustls-tls, per-request
/// deadlines, and bounded response reads.
#[derive(Debug)]
pub struct ReqwestSandboxTransport {
    client: reqwest::Client,
    max_response_bytes: usize,
}

impl Default for ReqwestSandboxTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl ReqwestSandboxTransport {
    /// The production transport: 32 MiB response cap.
    ///
    /// # Panics
    ///
    /// Panics if the reqwest client fails to build (a TLS backend failure
    /// is not recoverable at runtime).
    #[must_use]
    pub fn new() -> Self {
        Self::with_max_response_bytes(MAX_JSON_BODY_BYTES)
    }

    /// A transport with an explicit response cap (tests use a small cap to
    /// prove the streaming limit).
    ///
    /// # Panics
    ///
    /// Panics if the reqwest client fails to build.
    #[must_use]
    pub fn with_max_response_bytes(max_response_bytes: usize) -> Self {
        Self {
            client: reqwest::Client::builder()
                // Redirects are refused (a reviewed deviation from the TS
                // module, which relies on global `fetch` following them): a
                // redirected platform call would forward the request with
                // the Bearer key toward an unvalidated origin, and a moved
                // sandbox API is a client configuration change, never a
                // silent hop.
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("sandbox reqwest client"),
            max_response_bytes,
        }
    }
}

impl SandboxTransport for ReqwestSandboxTransport {
    async fn execute(&self, request: TransportRequest) -> Result<TransportResponse, SandboxError> {
        let method = request.method;
        let url = request.url.clone();
        let call = async {
            // The deadline is raced in tokio (below), never delegated to
            // reqwest: the TS contract types a lost race as `timeout`, not
            // as reqwest's transport error.
            let mut builder = self.client.request(reqwest_method(method), &url);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            if let Some(body) = request.body.as_deref() {
                builder = builder.body(body.to_string());
            }
            let response = builder.send().await.map_err(|error| {
                SandboxError::network(format!("Request failed: {method} {url}: {error}"))
                    .with_http_context(method, url.clone(), None, None)
            })?;
            let status = response.status().as_u16();
            let mut response = response;
            let mut body = Vec::new();
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        if body.len() + chunk.len() > self.max_response_bytes {
                            return Err(SandboxError::too_large(format!(
                                "Sandbox response exceeds the {} byte JSON body limit",
                                self.max_response_bytes
                            ))
                            .with_http_context(
                                method,
                                url.clone(),
                                None,
                                None,
                            ));
                        }
                        body.extend_from_slice(&chunk);
                    }
                    Ok(None) => break,
                    Err(error) => {
                        return Err(SandboxError::network(format!(
                            "Request failed: {method} {url}: {error}"
                        ))
                        .with_http_context(
                            method,
                            url.clone(),
                            None,
                            None,
                        ));
                    }
                }
            }
            Ok(TransportResponse { status, body })
        };
        // The deadline is raced against the call: an unresponsive server
        // loses even though reqwest never resolves (TS fetchWithTimeout).
        match tokio::time::timeout(request.timeout, call).await {
            Ok(outcome) => outcome,
            Err(_) => Err(SandboxError::timeout(format!(
                "Request timed out after {}ms: {method} {url}",
                request.timeout.as_millis()
            ))
            .with_http_context(method, url.clone(), None, None)),
        }
    }
}

fn reqwest_method(method: Method) -> reqwest::Method {
    match method {
        Method::Get => reqwest::Method::GET,
        Method::Post => reqwest::Method::POST,
        Method::Delete => reqwest::Method::DELETE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_debug_never_prints_server_body() {
        let key = "sk-synthetic-private-key";
        let response = TransportResponse {
            status: 403,
            body: format!("server echoed {key}").into_bytes(),
        };
        let rendered = format!("{response:?}");
        assert!(!rendered.contains(key));
        assert!(rendered.contains("status: 403"));
        assert!(rendered.contains(&format!("body_bytes: {}", response.body.len())));
    }

    #[test]
    fn request_debug_keeps_header_names_but_not_values_or_body() {
        let key = "sk-synthetic-private-key";
        let request = TransportRequest {
            method: Method::Post,
            url: "https://api.example.com/api/v1/sandbox".to_string(),
            headers: vec![("Authorization".to_string(), format!("Bearer {key}"))],
            body: Some(format!(r#"{{"secrets":{{"PRIVATE":"{key}"}}}}"#)),
            timeout: Duration::from_secs(5),
        };
        let rendered = format!("{request:?}");
        assert!(!rendered.contains(key));
        assert!(rendered.contains("Authorization"));
        assert!(rendered.contains(r#"body: Some("[redacted]")"#));
        assert!(rendered.contains("method: Post"));
    }
}
