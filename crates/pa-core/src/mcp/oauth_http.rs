//! The HTTP transport seam for the MCP OAuth flow.
//!
//! The flow itself is transport-agnostic: it issues exact requests and
//! validates exact responses, so tests inject a scripted transport (the TS
//! suite stubs `fetch` the same way) and the product uses a `reqwest` client
//! that never follows redirects (the TS flow passes `redirect: "error"`,
//! so a redirected request must fail instead of silently following).

use anyhow::{Context, Result};

/// One OAuth HTTP request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthHttpRequest {
    pub method: OAuthHttpMethod,
    pub url: String,
    pub headers: Vec<(String, String)>,
    /// Sent verbatim; form-encoded bodies are built by the caller.
    pub body: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthHttpMethod {
    Get,
    Post,
}

/// One OAuth HTTP response. Header names are lowercased.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthHttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}
impl OAuthHttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(header, _)| *header == name)
            .map(|(_, value)| value.as_str())
    }

    /// The `content-type` media type (parameters stripped, lowercased),
    /// matching `response.headers.get("content-type")?.split(";", 1)[0].trim()`.
    pub fn content_type(&self) -> Option<String> {
        self.header("content-type").map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
    }
}

/// The transport the OAuth flow issues its requests through. Dyn-dispatch
/// on purpose: the product plugs in `reqwest`, tests plug in a scripted map.
pub trait OAuthHttp: Send + Sync {
    fn request(
        &self,
        request: OAuthHttpRequest,
    ) -> futures::future::BoxFuture<'_, Result<OAuthHttpResponse>>;
}

/// Production transport: one redirect-refusing `reqwest` client.
pub struct ReqwestOAuthHttp {
    client: reqwest::Client,
}

impl Default for ReqwestOAuthHttp {
    fn default() -> Self {
        Self::new()
    }
}

impl ReqwestOAuthHttp {
    /// # Panics
    ///
    /// Panics when the underlying `reqwest` client cannot be built; with no
    /// TLS configuration and redirects disabled this construction cannot
    /// fail.
    pub fn new() -> Self {
        ReqwestOAuthHttp {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("reqwest client construction cannot fail with no TLS config"),
        }
    }
}

impl OAuthHttp for ReqwestOAuthHttp {
    fn request(
        &self,
        request: OAuthHttpRequest,
    ) -> futures::future::BoxFuture<'_, Result<OAuthHttpResponse>> {
        Box::pin(async move {
            let method = match request.method {
                OAuthHttpMethod::Get => reqwest::Method::GET,
                OAuthHttpMethod::Post => reqwest::Method::POST,
            };
            let mut builder = self.client.request(method, &request.url);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            if let Some(body) = &request.body {
                builder = builder.body(body.clone());
            }
            let response = builder.send().await.with_context(|| {
                format!("{} {} failed", method_label(&request.method), request.url)
            })?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .map(|(name, value)| {
                    (
                        name.as_str().to_ascii_lowercase(),
                        value.to_str().unwrap_or_default().to_string(),
                    )
                })
                .collect();
            let body = response.text().await.with_context(|| {
                format!(
                    "{} {} body read failed",
                    method_label(&request.method),
                    request.url
                )
            })?;
            Ok(OAuthHttpResponse {
                status,
                headers,
                body,
            })
        })
    }
}

fn method_label(method: &OAuthHttpMethod) -> &'static str {
    match method {
        OAuthHttpMethod::Get => "GET",
        OAuthHttpMethod::Post => "POST",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_header_lookup_is_case_insensitive() {
        let response = OAuthHttpResponse {
            status: 200,
            headers: vec![(
                "content-type".to_string(),
                "Application/JSON; charset=utf-8".to_string(),
            )],
            body: String::new(),
        };
        assert_eq!(
            response.header("Content-Type"),
            Some("Application/JSON; charset=utf-8")
        );
        assert_eq!(
            response.content_type(),
            Some("application/json".to_string())
        );
        assert_eq!(response.header("missing"), None);
    }
}
