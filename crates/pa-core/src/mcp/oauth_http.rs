//! The HTTP transport seam for the MCP OAuth flow: the flow is transport-agnostic, so
//! tests inject a scripted transport and the product uses a `reqwest` client that never
//! follows redirects (the TS flow passes `redirect: "error"` — a redirected request must
//! fail, not silently follow).

use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context, Result};

/// OAuth discovery and token JSON are small; bound remote responses before parsing.
const MAX_OAUTH_RESPONSE_BYTES: usize = 1024 * 1024;
/// Covers connection, headers, and body, including a peer that stalls mid-response.
const OAUTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

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
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(header, _)| *header == name)
            .map(|(_, value)| value.as_str())
    }

    /// The `content-type` media type (parameters stripped, lowercased),
    /// matching `response.headers.get("content-type")?.split(";", 1)[0].trim()`.
    #[must_use]
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

/// Production transport: one redirect-refusing `reqwest` client, built on
/// the first request so a process that never refreshes an MCP credential
/// never loads the native trust store.
pub struct ReqwestOAuthHttp {
    client: OnceLock<reqwest::Client>,
}

impl Default for ReqwestOAuthHttp {
    fn default() -> Self {
        Self::new()
    }
}

impl ReqwestOAuthHttp {
    #[must_use]
    pub fn new() -> Self {
        ReqwestOAuthHttp {
            client: OnceLock::new(),
        }
    }

    fn client(&self) -> &reqwest::Client {
        self.client.get_or_init(|| {
            pa_ai::utils::tls::http_client_builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("oauth client")
        })
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
            let mut builder = self
                .client()
                .request(method, &request.url)
                .timeout(OAUTH_REQUEST_TIMEOUT);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            if let Some(body) = &request.body {
                builder = builder.body(body.clone());
            }
            let mut response = builder.send().await.with_context(|| {
                format!("{} {} failed", method_label(request.method), request.url)
            })?;
            if response
                .content_length()
                .is_some_and(|length| length > MAX_OAUTH_RESPONSE_BYTES as u64)
            {
                anyhow::bail!("MCP OAuth response exceeded {MAX_OAUTH_RESPONSE_BYTES} bytes");
            }
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
            let mut raw = Vec::new();
            while let Some(chunk) = response.chunk().await.with_context(|| {
                format!(
                    "{} {} body read failed",
                    method_label(request.method),
                    request.url
                )
            })? {
                if chunk.len() > MAX_OAUTH_RESPONSE_BYTES.saturating_sub(raw.len()) {
                    anyhow::bail!("MCP OAuth response exceeded {MAX_OAUTH_RESPONSE_BYTES} bytes");
                }
                raw.extend_from_slice(&chunk);
            }
            let body = String::from_utf8_lossy(&raw).into_owned();
            Ok(OAuthHttpResponse {
                status,
                headers,
                body,
            })
        })
    }
}

fn method_label(method: OAuthHttpMethod) -> &'static str {
    match method {
        OAuthHttpMethod::Get => "GET",
        OAuthHttpMethod::Post => "POST",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn oversized_oauth_response_is_rejected_before_the_peer_finishes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        for chunked in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let (close_tx, close_rx) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut head = Vec::new();
                let mut buffer = [0u8; 4096];
                while !head.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let read = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(read, 0);
                    head.extend_from_slice(&buffer[..read]);
                }
                let framing = if chunked {
                    "Transfer-Encoding: chunked".to_string()
                } else {
                    format!("Content-Length: {}", 1024 * 1024 + 1)
                };
                let headers = format!("HTTP/1.1 200 OK\r\n{framing}\r\n\r\n");
                socket.write_all(headers.as_bytes()).await.unwrap();
                let body = vec![b'x'; 1024 * 1024 + 1];
                if chunked {
                    socket
                        .write_all(format!("{:x}\r\n", body.len()).as_bytes())
                        .await
                        .unwrap();
                }
                let _ = socket.write_all(&body).await;
                if chunked {
                    let _ = socket.write_all(b"\r\n").await;
                }
                let _ = close_rx.await;
            });
            let request = OAuthHttpRequest {
                method: OAuthHttpMethod::Get,
                url: format!("http://{addr}/oauth"),
                headers: Vec::new(),
                body: None,
            };
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                ReqwestOAuthHttp::new().request(request),
            )
            .await;
            let _ = close_tx.send(());
            server.await.unwrap();
            assert!(
                matches!(result, Ok(Err(_))),
                "oversized OAuth metadata waited for EOF or was accepted"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_oauth_response_finishes_at_the_request_deadline() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (close_tx, close_rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 4096];
            let _ = socket.read(&mut buffer).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\nshort")
                .await
                .unwrap();
            let _ = ready_tx.send(());
            let _ = close_rx.await;
        });
        let request = OAuthHttpRequest {
            method: OAuthHttpMethod::Get,
            url: format!("http://{addr}/oauth"),
            headers: Vec::new(),
            body: None,
        };
        let request_task =
            tokio::spawn(async move { ReqwestOAuthHttp::new().request(request).await });
        ready_rx.await.unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(31)).await;
        let result = tokio::time::timeout(Duration::from_secs(1), request_task).await;
        let _ = close_tx.send(());
        server.await.unwrap();
        assert!(matches!(result, Ok(Ok(Err(_)))));
    }

    #[tokio::test]
    async fn ordinary_oauth_response_keeps_its_text_and_headers() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 4096];
            let _ = socket.read(&mut buffer).await.unwrap();
            let body = "{\"issuer\":\"https://example.com/é\"}";
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).await.unwrap();
            socket.write_all(body.as_bytes()).await.unwrap();
        });
        let response = ReqwestOAuthHttp::new()
            .request(OAuthHttpRequest {
                method: OAuthHttpMethod::Get,
                url: format!("http://{addr}/oauth"),
                headers: Vec::new(),
                body: None,
            })
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(
            response.content_type(),
            Some("application/json".to_string())
        );
        assert_eq!(response.body, "{\"issuer\":\"https://example.com/é\"}");
    }

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
