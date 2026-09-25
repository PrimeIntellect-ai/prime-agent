//! The HTTP transport seam for the subscription OAuth flows (TS
//! `packages/ai/src/utils/oauth`'s plain `fetch` calls): the
//! JSON-body token exchange and refresh (Anthropic), the form-encoded
//! device flows with the client impersonation headers (GitHub
//! Copilot), and the strict-validated device flow that refuses
//! redirects (xAI). The Codex flow keeps its own narrower seam
//! (`CodexHttp`: one form POST per call); this one carries the method,
//! the headers, and the body the three providers' `fetch` shapes need.
//! Dyn-dispatch on purpose: the product plugs in a reqwest client,
//! tests script the responses (the TS suite stubs `fetch` the same
//! way).

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

/// One request's HTTP method.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderHttpMethod {
    Get,
    Post,
}

/// One OAuth request (TS `fetch(url, init)`'s method, headers, and
/// body; the body is sent verbatim — form-encoded and JSON bodies are
/// built by the caller).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderHttpRequest {
    pub method: ProviderHttpMethod,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    /// Whether a redirect is followed (TS `fetch` follows by default;
    /// the xAI flow passes `redirect: "error"` so a redirected token
    /// request fails instead of silently following).
    pub follow_redirects: bool,
}

/// One OAuth response (TS `response.status` + the read body).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderHttpResponse {
    pub status: u16,
    pub body: String,
}

impl ProviderHttpResponse {
    /// Whether the endpoint answered success (TS `response.ok`).
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// The transport the OAuth flows issue their requests through.
pub trait ProviderHttp: Send + Sync {
    /// One request; the error string is the transport's failure (TS
    /// the `fetch` throw).
    fn request(
        &self,
        request: ProviderHttpRequest,
        timeout_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<ProviderHttpResponse, String>> + Send + '_>>;
}

/// The production transport: one reqwest client per request, bounded
/// by the request timeout (the port's prime transport shape).
pub struct ReqwestProviderHttp;

impl Default for ReqwestProviderHttp {
    fn default() -> Self {
        Self::new()
    }
}

impl ReqwestProviderHttp {
    /// Construction is trivial: the client is built per request, so
    /// there is nothing to fail here.
    pub fn new() -> Self {
        ReqwestProviderHttp
    }
}

impl ProviderHttp for ReqwestProviderHttp {
    fn request(
        &self,
        request: ProviderHttpRequest,
        timeout_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<ProviderHttpResponse, String>> + Send + '_>> {
        Box::pin(async move {
            let method = match request.method {
                ProviderHttpMethod::Get => reqwest::Method::GET,
                ProviderHttpMethod::Post => reqwest::Method::POST,
            };
            let client = reqwest::Client::builder()
                .timeout(Duration::from_millis(timeout_ms))
                .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                    // TS `redirect: "error"`: a redirected request
                    // fails instead of silently following.
                    if request.follow_redirects && attempt.previous().len() < 10 {
                        attempt.follow()
                    } else {
                        attempt.error("redirect refused")
                    }
                }))
                .build()
                .map_err(|error| error.to_string())?;
            let mut request_builder = client.request(method, &request.url);
            for (name, value) in &request.headers {
                request_builder = request_builder.header(name, value);
            }
            if let Some(body) = &request.body {
                request_builder = request_builder.body(body.clone());
            }
            let response = request_builder.send().await.map_err(|error| {
                if error.is_timeout() {
                    "the request timed out".to_string()
                } else {
                    error.to_string()
                }
            })?;
            let status = response.status().as_u16();
            let body = response.text().await.map_err(|error| error.to_string())?;
            Ok(ProviderHttpResponse { status, body })
        })
    }
}
