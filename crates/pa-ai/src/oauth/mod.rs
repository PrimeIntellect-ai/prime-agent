//! The subscription OAuth flows: Codex, Anthropic, GitHub Copilot, and
//! xAI. Transport-agnostic: the Codex flow issues its token requests
//! through [`CodexHttp`], the other three through [`ProviderHttp`];
//! tests script the endpoints.

mod anthropic;
mod anthropic_callback;
mod callback;
mod github_copilot;
mod openai_codex;
mod pkce;
mod provider_http;
mod types;
mod xai;

pub use anthropic::{
    login_anthropic, refresh_anthropic_token, AnthropicCredentials,
    LOGIN_CANCELLED as ANTHROPIC_LOGIN_CANCELLED,
};
pub use callback::CodexCallbackServer;
pub use github_copilot::{
    get_github_copilot_base_url, login_github_copilot, refresh_github_copilot_token,
    CopilotCredentials, LOGIN_CANCELLED as COPILOT_LOGIN_CANCELLED,
};
pub use openai_codex::{
    login_openai_codex, refresh_openai_codex_token, CodexLoginUi, OAuthCredentials,
    DEFAULT_ORIGINATOR, LOGIN_CANCELLED,
};
pub use provider_http::{
    ProviderHttp, ProviderHttpMethod, ProviderHttpRequest, ProviderHttpResponse,
    ReqwestProviderHttp,
};
pub use types::{OAuthLoginUi, OAuthPrompt};
pub use xai::{
    login_xai, refresh_xai_token, XaiCredentials, LOGIN_CANCELLED as XAI_LOGIN_CANCELLED,
};

use std::future::Future;
use std::time::Duration;

const MAX_OAUTH_RESPONSE_BYTES: usize = 1024 * 1024;

async fn read_oauth_body(mut response: reqwest::Response) -> Result<String, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if chunk.len() > MAX_OAUTH_RESPONSE_BYTES - bytes.len() {
            return Err(format!(
                "OAuth response exceeds {MAX_OAUTH_RESPONSE_BYTES} bytes"
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    // Reqwest is built without its charset feature in this workspace; text()
    // uses this same lossy UTF-8 decoding after collecting the response.
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexHttpResponse {
    pub status: u16,
    pub body: String,
}

impl CodexHttpResponse {
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// The HTTP transport for the Codex flow's token requests: one form-encoded POST per call.
/// Dyn-dispatch on purpose: the product plugs in a reqwest client, tests script the responses.
pub trait CodexHttp: Send + Sync {
    /// One POST of a form-encoded body; the error string is the
    /// transport's failure.
    fn post_form<'a>(
        &'a self,
        url: &'a str,
        body: &'a str,
        timeout_ms: u64,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<CodexHttpResponse, String>> + Send + 'a>>;
}

/// The production transport: one reqwest client per request.
pub struct ReqwestCodexHttp;

impl Default for ReqwestCodexHttp {
    fn default() -> Self {
        Self::new()
    }
}

impl ReqwestCodexHttp {
    #[must_use]
    pub fn new() -> Self {
        ReqwestCodexHttp
    }
}

impl CodexHttp for ReqwestCodexHttp {
    fn post_form<'a>(
        &'a self,
        url: &'a str,
        body: &'a str,
        timeout_ms: u64,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<CodexHttpResponse, String>> + Send + 'a>>
    {
        Box::pin(async move {
            let client = crate::utils_inner::tls::http_client_builder()
                .timeout(Duration::from_millis(timeout_ms))
                .build()
                .map_err(|error| error.to_string())?;
            let response = client
                .post(url)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(body.to_string())
                .send()
                .await
                .map_err(|error| {
                    if error.is_timeout() {
                        "the token request timed out".to_string()
                    } else {
                        error.to_string()
                    }
                })?;
            let status = response.status().as_u16();
            let body = read_oauth_body(response).await?;
            Ok(CodexHttpResponse { status, body })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct ScriptedHttp(std::collections::HashMap<String, CodexHttpResponse>);

    impl ScriptedHttp {
        fn entry(url: &str, status: u16, body: &str) -> (String, CodexHttpResponse) {
            (
                url.to_string(),
                CodexHttpResponse {
                    status,
                    body: body.to_string(),
                },
            )
        }
    }

    impl CodexHttp for ScriptedHttp {
        fn post_form<'a>(
            &'a self,
            url: &'a str,
            _body: &'a str,
            _timeout_ms: u64,
        ) -> std::pin::Pin<Box<dyn Future<Output = Result<CodexHttpResponse, String>> + Send + 'a>>
        {
            let result = self.0.get(url).cloned();
            Box::pin(async move { result.ok_or_else(|| format!("{url} was not scripted")) })
        }
    }

    async fn oversized_stalled_response(chunked: bool) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            let body = vec![b'x'; 1024 * 1024 + 1];
            let headers = if chunked {
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                    .to_string()
            } else {
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len() + 1
                )
            };
            socket.write_all(headers.as_bytes()).await.unwrap();
            if chunked {
                socket
                    .write_all(format!("{:x}\r\n", body.len()).as_bytes())
                    .await
                    .unwrap();
            }
            socket.write_all(&body).await.unwrap();
            if chunked {
                socket.write_all(b"\r\n").await.unwrap();
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        (url, server)
    }

    #[tokio::test]
    async fn provider_oauth_refuses_oversized_body_before_peer_finishes() {
        let (url, server) = oversized_stalled_response(false).await;
        let transport = ReqwestProviderHttp::new();
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            transport.request(
                ProviderHttpRequest {
                    method: ProviderHttpMethod::Get,
                    url,
                    headers: Vec::new(),
                    body: None,
                    follow_redirects: true,
                },
                30_000,
            ),
        )
        .await
        .expect("oversized OAuth response should fail before the peer closes");
        server.abort();
        assert!(result.unwrap_err().contains("exceeds 1048576 bytes"));
    }

    #[tokio::test]
    async fn codex_oauth_refuses_oversized_body_before_peer_finishes() {
        let (url, server) = oversized_stalled_response(true).await;
        let transport = ReqwestCodexHttp::new();
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            transport.post_form(&url, "grant_type=authorization_code", 30_000),
        )
        .await
        .expect("oversized OAuth response should fail before the peer closes");
        server.abort();
        assert!(result.unwrap_err().contains("exceeds 1048576 bytes"));
    }

    #[tokio::test]
    async fn provider_oauth_preserves_small_error_status_and_lossy_utf8_text() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            socket
                .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 3\r\n\r\nx\xffy")
                .await
                .unwrap();
        });
        let transport = ReqwestProviderHttp::new();
        let response = transport
            .request(
                ProviderHttpRequest {
                    method: ProviderHttpMethod::Get,
                    url,
                    headers: Vec::new(),
                    body: None,
                    follow_redirects: true,
                },
                30_000,
            )
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(response.status, 400);
        assert_eq!(response.body, "x\u{fffd}y");
    }
    #[tokio::test]
    async fn the_seam_serves_scripted_responses() {
        let http = ScriptedHttp(
            [ScriptedHttp::entry(
                "https://fixture.example/token",
                200,
                r#"{"ok":true}"#,
            )]
            .into_iter()
            .collect(),
        );
        let response = http
            .post_form("https://fixture.example/token", "", 1)
            .await
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, r#"{"ok":true}"#);
        assert!(response.ok());
        assert!(http
            .post_form("https://other.example/token", "", 1)
            .await
            .is_err());
    }
}
