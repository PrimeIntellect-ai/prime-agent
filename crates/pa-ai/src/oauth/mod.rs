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
                .redirect(crate::utils_inner::tls::same_origin_redirect_policy())
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
            let body = response.text().await.map_err(|error| error.to_string())?;
            Ok(CodexHttpResponse { status, body })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[tokio::test]
    async fn codex_refresh_token_does_not_cross_a_redirect_origin() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_addr = target.local_addr().unwrap();
        let (captured_tx, mut captured_rx) = tokio::sync::oneshot::channel();
        let target_task = tokio::spawn(async move {
            let (mut stream, _) = target.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            while !String::from_utf8_lossy(&request).contains("refresh_token=test-secret") {
                let read = stream.read(&mut buffer).await.unwrap();
                assert_ne!(read, 0);
                request.extend_from_slice(&buffer[..read]);
            }
            let _ = captured_tx.send(String::from_utf8_lossy(&request).to_string());
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
        });

        let source = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let source_addr = source.local_addr().unwrap();
        let source_task = tokio::spawn(async move {
            let (mut stream, _) = source.accept().await.unwrap();
            let mut request = vec![0u8; 4096];
            let _ = stream.read(&mut request).await.unwrap();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{target_addr}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let response = ReqwestCodexHttp::new()
            .post_form(
                &format!("http://{source_addr}/"),
                "refresh_token=test-secret",
                3_000,
            )
            .await;
        source_task.await.unwrap();
        let captured = captured_rx.try_recv().ok();
        target_task.abort();
        assert!(
            !captured
                .as_deref()
                .is_some_and(|request| request.contains("refresh_token=test-secret")),
            "OAuth refresh token crossed the redirect origin"
        );
        assert!(response.is_err(), "cross-origin redirect was followed");
    }
}
