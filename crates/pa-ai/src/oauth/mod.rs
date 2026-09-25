//! The AI library's OAuth flows (TS `packages/ai/src/utils/oauth`):
//! the ChatGPT Plus/Pro (Codex Subscription) provider — the PKCE
//! authorization request, the localhost callback server, the token
//! exchange, the JWT account-id claim, and the token refresh — plus the
//! Anthropic (Claude Pro/Max) PKCE flow with its own localhost
//! callback, the GitHub Copilot device flow with the client
//! impersonation headers and the post-login model-policy pass, and the
//! xAI (Grok) device flow with strict response validation.
//!
//! The flows are transport-agnostic: the Codex flow issues its token
//! requests through the [`CodexHttp`] seam, the other three through
//! [`ProviderHttp`] (the JSON bodies, the GETs, and the custom
//! headers their TS `fetch` shapes carry), so tests script the
//! endpoints (the TS suite stubs `fetch` the same way) and the
//! product plugs in one reqwest client.

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
    login_anthropic, refresh_anthropic_token, AnthropicCredentials, ANTHROPIC_CLIENT_ID,
    LOGIN_CANCELLED as ANTHROPIC_LOGIN_CANCELLED,
};
pub use callback::CodexCallbackServer;
pub use github_copilot::{
    get_github_copilot_base_url, login_github_copilot, normalize_domain,
    refresh_github_copilot_token, CopilotCredentials, COPILOT_CLIENT_HEADERS,
    COPILOT_CLIENT_USER_AGENT, LOGIN_CANCELLED as COPILOT_LOGIN_CANCELLED,
};
pub use openai_codex::{
    login_openai_codex, refresh_openai_codex_token, CodexLoginUi, OAuthCredentials,
    DEFAULT_ORIGINATOR, LOGIN_CANCELLED,
};
pub use pkce::generate_pkce;
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

/// One token-endpoint POST's outcome (TS `fetch`'s `response.status` +
/// `response.text()`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexHttpResponse {
    pub status: u16,
    pub body: String,
}

impl CodexHttpResponse {
    /// Whether the endpoint answered success (TS `response.ok`).
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// The HTTP transport the OAuth flows issue their token requests
/// through: one form-encoded POST per call (TS `fetch` with
/// `Content-Type: application/x-www-form-urlencoded`). Dyn-dispatch on
/// purpose: the product plugs in a reqwest client, tests script the
/// responses.
pub trait CodexHttp: Send + Sync {
    /// One POST of a form-encoded body; the error string is the
    /// transport's failure (TS the `fetch` throw).
    fn post_form<'a>(
        &'a self,
        url: &'a str,
        body: &'a str,
        timeout_ms: u64,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<CodexHttpResponse, String>> + Send + 'a>>;
}

/// The production transport: one reqwest client per request, bounded by
/// the request timeout (the port's prime transport shape).
pub struct ReqwestCodexHttp;

impl Default for ReqwestCodexHttp {
    fn default() -> Self {
        Self::new()
    }
}

impl ReqwestCodexHttp {
    /// Construction is trivial: the client is built per request, so
    /// there is nothing to fail here.
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
            let client = reqwest::Client::builder()
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
            let body = response.text().await.map_err(|error| error.to_string())?;
            Ok(CodexHttpResponse { status, body })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scripted transport (url -> response); unknown urls fail the
    /// request (the TS suite throws on unexpected fetches).
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
        // An unscripted url fails the request.
        assert!(http
            .post_form("https://other.example/token", "", 1)
            .await
            .is_err());
    }
}
