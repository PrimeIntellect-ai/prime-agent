//! The sandbox HTTP transport: one injectable trait, one reqwest production
//! implementation. Port of the `fetchWithTimeout` + `boundedBodyText` half
//! of `prime-sandbox-client.ts` (TS branch `feat/direct-cloud-sandbox`):
//! - a per-request deadline raced against the request (the timeout wins
//!   even when the server never answers);
//! - buffered responses are read through a streaming cap (32 MiB default,
//!   per-request overridable), so an unbounded body is a typed `too_large`
//!   error, never an unbounded allocation;
//! - transport failures are already-typed [`SandboxError`]s carrying the
//!   request method and URL; non-2xx statuses are returned to the caller,
//!   which owns the error-body preview (the transport never parses);
//! - redirects are refused (`reqwest::redirect::Policy::none()`, a
//!   reviewed deviation from the TS module's default-following `fetch`):
//!   an authenticated platform or gateway call never hops origins, so the
//!   Bearer key cannot leak toward a redirect target; a moved sandbox API
//!   is a client configuration change, never a silent hop;
//! - [`SandboxTransport::execute_streaming`] opens a request and returns
//!   the live response for incremental reads: the gateway download path
//!   (TS streams it under its own transfer cap) and the `ConnectRPC`
//!   `command_session` streams (a live process event stream is unbounded)
//!   need the body while it arrives, not buffered after the fact.

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
    /// The request body bytes; `None` sends no body. JSON callers pass
    /// the serialized string as bytes; the gateway upload passes a
    /// multipart body; the `command_session` client passes enveloped proto
    /// frames.
    pub body: Option<Vec<u8>>,
    /// Per-request response byte cap for buffered reads; `None` uses the
    /// transport default (32 MiB). The TS client applies per-call caps
    /// (JSON bodies 32 MiB, unary proto 1 MiB); the transport mirrors that
    /// per call.
    pub max_response_bytes: Option<usize>,
    /// The per-request deadline; `None` is no deadline (the `ConnectRPC`
    /// streams that inherit the server default rather than sending
    /// `Connect-Timeout-Ms`).
    pub timeout: Option<Duration>,
}

impl TransportRequest {
    /// Build a request with the transport-default body cap.
    #[must_use]
    pub fn new(
        method: Method,
        url: String,
        headers: Vec<(String, String)>,
        body: Option<Vec<u8>>,
    ) -> Self {
        Self {
            method,
            url,
            headers,
            body,
            max_response_bytes: None,
            timeout: Some(crate::types::DEFAULT_REQUEST_TIMEOUT),
        }
    }
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
            .field("max_response_bytes", &self.max_response_bytes)
            .finish()
    }
}

/// One inbound HTTP response, for every status.
#[derive(Clone)]
pub struct TransportResponse {
    /// The response status.
    pub status: u16,
    /// The response body, read under the request's (or transport's) byte
    /// cap.
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

/// One inbound streaming HTTP response: the status, the response headers,
/// and a body readable incrementally. The deadline covered only the open;
/// reads run as long as the server streams.
#[derive(Debug)]
pub struct StreamedResponse {
    /// The response status.
    pub status: u16,
    /// The response headers in received order (names as sent).
    pub headers: Vec<(String, String)>,
    /// The incrementally readable body.
    pub body: ResponseChunks,
}

impl StreamedResponse {
    /// The first value of a case-insensitive header, when present.
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header_name, _)| header_name.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// The incrementally readable body of a streaming response.
#[derive(Debug)]
pub enum ResponseChunks {
    /// Backed by a live reqwest response; reads pull network chunks.
    Reqwest(reqwest::Response),
    /// Pre-loaded chunks for in-process scripted transports; drains to
    /// end-of-body.
    Queued(std::collections::VecDeque<Vec<u8>>),
}

impl ResponseChunks {
    /// Read the next body chunk; `Ok(None)` is a clean end of body. A
    /// dropped reader aborts the underlying connection (dropping the
    /// reqwest response closes it).
    ///
    /// # Errors
    ///
    /// Returns [`SandboxErrorCode::Network`] when the live body read
    /// fails.
    pub async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, SandboxError> {
        match self {
            Self::Reqwest(response) => match response.chunk().await {
                Ok(Some(chunk)) => Ok(Some(chunk.to_vec())),
                Ok(None) => Ok(None),
                Err(error) => Err(SandboxError::network(format!(
                    "Request failed while reading the response body: {error}"
                ))),
            },
            Self::Queued(chunks) => Ok(chunks.pop_front()),
        }
    }
}

/// The sandbox HTTP transport. Implementations execute one request and
/// return typed errors; they never parse bodies or map statuses, which
/// stays in the client so error previews keep a single redaction path.
pub trait SandboxTransport: Send + Sync {
    /// Execute `request` and read the whole response under its cap;
    /// `Err` carries the request method and URL.
    fn execute(
        &self,
        request: TransportRequest,
    ) -> impl Future<Output = Result<TransportResponse, SandboxError>> + Send;

    /// Execute `request` and return the open response for incremental
    /// reads. The deadline covers only the open (request send + response
    /// head); body reads stream unbounded. Non-2xx statuses are returned
    /// as-is with the body still readable; the caller owns status
    /// handling and error previews. Redirects are refused the same way as
    /// [`SandboxTransport::execute`].
    fn execute_streaming(
        &self,
        request: TransportRequest,
    ) -> impl Future<Output = Result<StreamedResponse, SandboxError>> + Send;
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

    /// A transport with an explicit default response cap (tests use a
    /// small cap to prove the streaming limit).
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
                // redirected platform or gateway call would forward the
                // request with the Bearer key toward an unvalidated origin,
                // and a moved sandbox API is a client configuration change,
                // never a silent hop.
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("sandbox reqwest client"),
            max_response_bytes,
        }
    }

    async fn open(&self, request: &TransportRequest) -> Result<reqwest::Response, SandboxError> {
        let method = request.method;
        let url = request.url.clone();
        {
            // The deadline is raced in tokio (below), never delegated to
            // reqwest: the TS contract types a lost race as `timeout`, not
            // as reqwest's transport error.
            let mut builder = self.client.request(reqwest_method(method), &url);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            if let Some(body) = request.body.as_deref() {
                builder = builder.body(body.to_vec());
            }
            builder.send().await.map_err(|error| {
                SandboxError::network(format!("Request failed: {method} {url}: {error}"))
                    .with_http_context(method, url.clone(), None, None)
            })
        }
    }
}

impl SandboxTransport for ReqwestSandboxTransport {
    async fn execute(&self, request: TransportRequest) -> Result<TransportResponse, SandboxError> {
        let method = request.method;
        let url = request.url.clone();
        let max_response_bytes = request
            .max_response_bytes
            .unwrap_or(self.max_response_bytes);
        let call = async {
            let mut response = self.open(&request).await?;
            let status = response.status().as_u16();
            let mut body = Vec::new();
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        if body.len() + chunk.len() > max_response_bytes {
                            return Err(SandboxError::too_large(format!(
                                "Sandbox response exceeds the {max_response_bytes} byte limit"
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
        // `None` is no deadline (the TS streaming opens without
        // `Connect-Timeout-Ms`).
        raced_deadline(request.timeout, call, method, &url).await
    }

    async fn execute_streaming(
        &self,
        request: TransportRequest,
    ) -> Result<StreamedResponse, SandboxError> {
        let method = request.method;
        let url = request.url.clone();
        let call = async {
            let response = self.open(&request).await?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .map(|(name, value)| {
                    (
                        name.as_str().to_string(),
                        value.to_str().unwrap_or_default().to_string(),
                    )
                })
                .collect();
            Ok(StreamedResponse {
                status,
                headers,
                body: ResponseChunks::Reqwest(response),
            })
        };
        // The deadline covers the open only: body reads stream for as long
        // as the server sends (TS fetchWithDeadline resolves on the head,
        // then reads outside the timeout). `None` is no deadline.
        raced_deadline(request.timeout, call, method, &url).await
    }
}

/// Race `call` against an optional deadline; the deadline losing race is a
/// typed `timeout` error carrying the request context.
async fn raced_deadline<F, R>(
    timeout: Option<Duration>,
    call: F,
    method: Method,
    url: &str,
) -> Result<R, SandboxError>
where
    F: Future<Output = Result<R, SandboxError>> + Send,
{
    let Some(timeout) = timeout else {
        return call.await;
    };
    match tokio::time::timeout(timeout, call).await {
        Ok(outcome) => outcome,
        Err(_) => Err(SandboxError::timeout(format!(
            "Request timed out after {}ms: {method} {url}",
            timeout.as_millis()
        ))
        .with_http_context(method, url.to_string(), None, None)),
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
            body: Some(format!(r#"{{"secrets":{{"PRIVATE":"{key}"}}}}"#).into_bytes()),
            timeout: Some(Duration::from_secs(5)),
            max_response_bytes: None,
        };
        let rendered = format!("{request:?}");
        assert!(!rendered.contains(key));
        assert!(rendered.contains("Authorization"));
        assert!(rendered.contains(r#"body: Some("[redacted]")"#));
        assert!(rendered.contains("method: Post"));
    }
}
