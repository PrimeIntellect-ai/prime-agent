//! The shared HTTP transport seam for the Anthropic, GitHub Copilot,
//! and xAI flows (the Codex flow keeps its own narrower `CodexHttp`).
//! Dyn-dispatch on purpose: the product plugs in a reqwest client,
//! tests script the responses.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderHttpMethod {
    Get,
    Post,
}

/// One OAuth request; the body is sent verbatim (form-encoded and
/// JSON bodies are built by the caller).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderHttpRequest {
    pub method: ProviderHttpMethod,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    /// Whether redirects are followed (TS `fetch` follows by default;
    /// the xAI flow passes `redirect: "error"`).
    pub follow_redirects: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderHttpResponse {
    pub status: u16,
    pub body: String,
}

impl ProviderHttpResponse {
    #[must_use]
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// The transport the OAuth flows issue their requests through.
pub trait ProviderHttp: Send + Sync {
    /// One request; the error string is the transport's failure.
    fn request(
        &self,
        request: ProviderHttpRequest,
        timeout_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<ProviderHttpResponse, String>> + Send + '_>>;
}

/// The production transport: one reqwest client per request.
pub struct ReqwestProviderHttp;

impl Default for ReqwestProviderHttp {
    fn default() -> Self {
        Self::new()
    }
}

impl ReqwestProviderHttp {
    #[must_use]
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
