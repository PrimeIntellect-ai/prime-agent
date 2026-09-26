//! The composition root's Codex Subscription login (TS
//! `auth-flows.ts`'s `showLoginDialog` over the AI library's
//! `openaiCodexOAuthProvider`): the browser authorization URL block, the
//! manual paste racing the localhost callback, the token exchange, and
//! the credential write under the `openai-codex` provider id. Every
//! surface renders through the inline auth panel (TS the login dialog in
//! the TUI); nothing touches the plain terminal. The TS flow's
//! account-id claim rides the stored credential (`accountId`, the
//! `auth.json` wire shape), and a stored credential makes the provider's
//! subscription models resolvable (the request path extracts the
//! account id from the token itself, like TS).
//!
//! Cancellation (#2770): the panel handle's shared flag is the seam —
//! the driving pane marks it on exit and this flow checks it after the
//! flow returns and before the credential write, so an exited pane never
//! lands a credential (a task abort cannot reach the started blocking
//! body).

use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use pa_ai::oauth::{
    login_openai_codex, CodexHttp, CodexLoginUi, DEFAULT_ORIGINATOR, LOGIN_CANCELLED,
};
use pa_core::auth::{AuthCredential, AuthStorage, OPENAI_CODEX_PROVIDER_ID};
use pa_tui::auth_panel::{AuthPanelHandle, PastePromptTone, PasteStyle};
use pa_tui::provider_auth::ProviderAuthOutcome;

/// The inline auth panel as the codex login's surface (TS the login
/// dialog): the browser URL block (the flow opens the browser; the panel
/// renders), the manual paste racing the browser callback, and the
/// fallback prompt ride the panel channel.
pub(crate) struct PanelCodexLoginUi {
    panel: AuthPanelHandle,
}

impl PanelCodexLoginUi {
    pub(crate) fn new(panel: AuthPanelHandle) -> Self {
        PanelCodexLoginUi { panel }
    }
}

impl CodexLoginUi for PanelCodexLoginUi {
    fn on_auth(&self, url: &str, instructions: &str) {
        self.panel.auth_url(url, Some(instructions));
        pa_core::platform::browser::open_in_browser(url);
    }

    fn on_manual_code_input(&self) -> Option<Pin<Box<dyn Future<Output = Option<String>> + Send>>> {
        let panel = self.panel.clone();
        Some(Box::pin(async move {
            panel
                .paste_prompt(
                    "Paste redirect URL below, or complete login in browser:",
                    PastePromptTone::Muted,
                    PasteStyle::Visible,
                )
                .await
        }))
    }

    fn on_prompt(&self, message: &str) -> Pin<Box<dyn Future<Output = Option<String>> + Send>> {
        let panel = self.panel.clone();
        let message = message.to_string();
        Box::pin(async move {
            panel
                .paste_prompt(&message, PastePromptTone::Text, PasteStyle::Visible)
                .await
        })
    }

    fn is_cancelled(&self) -> bool {
        self.panel.cancelled()
    }
}

/// TS `showLoginDialog` + `completeProviderAuthentication`: run the
/// flow, store the credential, and report the TS status. A cancelled
/// surface stays silent; a failed flow reports the TS error row.
pub(crate) async fn run_codex_subscription_login(
    agent_dir: &Path,
    provider_name: &str,
    http: &dyn CodexHttp,
    ui: &dyn CodexLoginUi,
) -> ProviderAuthOutcome {
    let credentials = match login_openai_codex(http, ui, DEFAULT_ORIGINATOR).await {
        Ok(credentials) => credentials,
        Err(message) if message == LOGIN_CANCELLED => {
            return ProviderAuthOutcome::Cancelled;
        }
        Err(message) => {
            return ProviderAuthOutcome::Error(format!(
                "Failed to login to {provider_name}: {message}"
            ));
        }
    };
    // The pane exited while the login ran: no credential write lands (TS
    // the dialog's abort signal; #2770 — the flag is the seam, the
    // blocking body checks it before the store).
    if ui.is_cancelled() {
        return ProviderAuthOutcome::Cancelled;
    }
    let mut auth = AuthStorage::create(agent_dir);
    auth.set(
        OPENAI_CODEX_PROVIDER_ID,
        AuthCredential::Oauth {
            access: credentials.access,
            refresh: Some(credentials.refresh),
            expires: credentials.expires,
            account_id: Some(credentials.account_id),
            endpoint: None,
            token_endpoint: None,
            client_id: None,
            resource: None,
            issuer: None,
            enterprise_url: None,
        },
    );
    if let Some(error) = auth.drain_errors().pop() {
        return ProviderAuthOutcome::Error(format!(
            "Failed to login to {provider_name}: could not save the login: {error}"
        ));
    }
    ProviderAuthOutcome::Status(format!(
        "Logged in to {provider_name}. Credentials saved to {}",
        agent_dir.join("auth.json").display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use pa_ai::oauth::CodexHttpResponse;

    /// A scripted transport (url -> response); unknown urls fail.
    struct ScriptedHttp(std::collections::HashMap<String, CodexHttpResponse>);

    impl CodexHttp for ScriptedHttp {
        fn post_form<'a>(
            &'a self,
            url: &'a str,
            _body: &'a str,
            _timeout_ms: u64,
        ) -> Pin<Box<dyn Future<Output = Result<CodexHttpResponse, String>> + Send + 'a>> {
            let response = self.0.get(url).cloned();
            Box::pin(async move { response.ok_or_else(|| format!("{url} was not scripted")) })
        }
    }

    /// A scripted surface: a fixed paste answer and a shared cancel flag.
    struct ScriptedUi {
        cancelled: Arc<AtomicBool>,
    }

    impl ScriptedUi {
        fn new() -> Self {
            ScriptedUi {
                cancelled: Arc::new(AtomicBool::new(false)),
            }
        }

        fn flag(&self) -> Arc<AtomicBool> {
            Arc::clone(&self.cancelled)
        }
    }

    impl CodexLoginUi for ScriptedUi {
        fn on_auth(&self, _url: &str, _instructions: &str) {}

        fn on_manual_code_input(
            &self,
        ) -> Option<Pin<Box<dyn Future<Output = Option<String>> + Send>>> {
            // A paste with no state echoes (TS's falsy state skips the
            // check): the code is used as-is.
            Some(Box::pin(std::future::ready(Some(
                "http://localhost:1455/auth/callback?code=abc".to_string(),
            ))))
        }

        fn on_prompt(
            &self,
            _message: &str,
        ) -> Pin<Box<dyn Future<Output = Option<String>> + Send>> {
            Box::pin(std::future::ready(None))
        }

        fn is_cancelled(&self) -> bool {
            self.cancelled.load(Ordering::Relaxed)
        }
    }

    /// One fake access token carrying the account id.
    fn account_jwt(account_id: &str) -> String {
        use base64::Engine as _;
        let segment = |value: &serde_json::Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_string(value).unwrap().as_bytes())
        };
        format!(
            "{}.{}.not-a-signature",
            segment(&serde_json::json!({"alg": "RS256"})),
            segment(&serde_json::json!({
                "https://api.openai.com/auth": {"chatgpt_account_id": account_id}
            }))
        )
    }

    /// The scripted token endpoint for one fake login.
    fn token_http(access: &str) -> ScriptedHttp {
        ScriptedHttp(
            [(
                "https://auth.openai.com/oauth/token".to_string(),
                CodexHttpResponse {
                    status: 200,
                    body: serde_json::json!({
                        "access_token": access,
                        "refresh_token": "r-1",
                        "expires_in": 3600,
                    })
                    .to_string(),
                },
            )]
            .into_iter()
            .collect(),
        )
    }

    #[tokio::test]
    async fn the_login_stores_the_credential_and_reports_the_ts_status() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&agent).expect("agent dir");
        let http = token_http(&account_jwt("acct-1"));
        let ui = ScriptedUi::new();
        let before_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(i64::MAX, |elapsed| elapsed.as_millis() as i64);
        match run_codex_subscription_login(
            &agent,
            "ChatGPT Plus/Pro (Codex Subscription)",
            &http,
            &ui,
        )
        .await
        {
            ProviderAuthOutcome::Status(message) => {
                assert_eq!(
                    message,
                    format!(
                        "Logged in to ChatGPT Plus/Pro (Codex Subscription). Credentials saved to {}",
                        agent.join("auth.json").display()
                    )
                );
            }
            other => panic!("expected the logged-in status, got {other:?}"),
        }
        // The packaged auth.json wire shape: the TS credential with its
        // `accountId` (the daemon and every packaged build read this
        // file; the flow wrote it through the shared store).
        let document: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(agent.join("auth.json")).unwrap())
                .unwrap();
        let stored = &document["openai-codex"];
        assert_eq!(stored["type"], "oauth");
        assert_eq!(stored["access"], account_jwt("acct-1"));
        assert_eq!(stored["refresh"], "r-1");
        // The expiry is `now + expires_in * 1000` (TS's convention).
        let expires = stored["expires"].as_i64().expect("the expiry is numeric");
        assert!(
            expires >= before_ms + 3_600_000 && expires <= before_ms + 3_600_000 + 5_000,
            "the expiry lands one hour out: {expires} vs {before_ms}"
        );
        assert_eq!(stored["accountId"], "acct-1");
        // The stored credential resolves as the provider's api key (the
        // subscription models become selectable).
        let mut auth = AuthStorage::create(&agent);
        assert_eq!(
            auth.get_api_key("openai-codex"),
            Some(account_jwt("acct-1"))
        );
        // The /logout row appears for it.
        assert_eq!(
            auth.get_all().credential("openai-codex").map(|credential| {
                matches!(
                    credential,
                    AuthCredential::Oauth {
                        account_id: Some(account_id),
                        ..
                    } if account_id == "acct-1"
                )
            }),
            Some(true)
        );
    }

    /// A cancelled pane never receives the credential (#2770: no write
    /// after the exit) — the regression test for the abort-cleanup
    /// contract.
    #[tokio::test]
    async fn a_cancelled_pane_writes_no_credential() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&agent).expect("agent dir");
        let http = token_http(&account_jwt("acct-1"));
        let ui = ScriptedUi::new();
        // The pane exits right before the flow returns.
        ui.flag().store(true, Ordering::Relaxed);
        assert_eq!(
            run_codex_subscription_login(
                &agent,
                "ChatGPT Plus/Pro (Codex Subscription)",
                &http,
                &ui
            )
            .await,
            ProviderAuthOutcome::Cancelled
        );
        assert!(
            !agent.join("auth.json").exists(),
            "the cancelled flow never wrote a credential"
        );
    }

    #[tokio::test]
    async fn a_failed_flow_reports_the_ts_error_row() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&agent).expect("agent dir");
        // Nothing scripted: the token request fails.
        let http = ScriptedHttp(std::collections::HashMap::new());
        let ui = ScriptedUi::new();
        assert_eq!(
            run_codex_subscription_login(
                &agent,
                "ChatGPT Plus/Pro (Codex Subscription)",
                &http,
                &ui
            )
            .await,
            ProviderAuthOutcome::Error(
                "Failed to login to ChatGPT Plus/Pro (Codex Subscription): \
                 OpenAI Codex token exchange error: https://auth.openai.com/oauth/token was not \
                 scripted"
                    .to_string()
            )
        );
    }

    /// The credential round-trip: the flow's stored credential reloads,
    /// resolves while unexpired, and refreshes at expiry through the
    /// default provider integration (the packaged-build path: the same
    /// `AuthStorage::create` every surface uses).
    #[tokio::test]
    async fn the_stored_credential_round_trips_and_refreshes() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&agent).expect("agent dir");
        let http = token_http(&account_jwt("acct-1"));
        let ui = ScriptedUi::new();
        run_codex_subscription_login(&agent, "Codex", &http, &ui).await;
        // Reload through the default integration (the daemon's path):
        // an unexpired credential resolves its access token.
        let mut auth = AuthStorage::create(&agent);
        assert_eq!(
            auth.get_api_key("openai-codex"),
            Some(account_jwt("acct-1"))
        );
        // An expired credential refreshes through the integration's
        // scripted endpoint and the fresh token resolves.
        let mut data = auth.get_all();
        if let Some(document) = data.0.get_mut("openai-codex") {
            document["expires"] = serde_json::json!(1);
        }
        let mut expired = AuthStorage::in_memory_without_env(
            data,
            Arc::new(pa_core::auth::ProviderOAuth::with_http(Arc::new(
                token_http(&account_jwt("acct-2")),
            ))),
        );
        assert_eq!(
            expired.get_api_key("openai-codex"),
            Some(account_jwt("acct-2"))
        );
    }

    #[tokio::test]
    async fn the_panel_surface_mounts_the_ts_prompts() {
        // The panel adapter's seam: on_auth renders the url block, the
        // manual paste mounts with the TS prompt, and the fallback
        // prompt passes the flow's message. The paste/prompt futures
        // are LAZY (the request sends on first poll), so the test
        // spawns them and reads the requests off the channel's
        // receiving side, bounded by a recv timeout that fails the
        // test — never a green-on-timeout retry.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let panel = AuthPanelHandle::new(tx);
        let ui = PanelCodexLoginUi::new(panel);
        ui.on_auth("https://auth.example/authorize", "Open your browser.");
        // The url block sends immediately (a plain request, not a
        // future).
        let url_request = rx.recv().await.expect("the url block sends");
        let pa_tui::auth_panel::AuthPanelRequest::AuthUrl { url, instructions } = url_request
        else {
            panic!("expected the url block request")
        };
        assert_eq!(url, "https://auth.example/authorize");
        assert_eq!(instructions.as_deref(), Some("Open your browser."));

        // The manual paste: spawned (the boxed future sends its
        // PastePrompt on first poll, then pends on the answer this test
        // never gives).
        let manual = ui
            .on_manual_code_input()
            .expect("the panel supplies the paste");
        let manual_task = tokio::spawn(async move {
            let _ = manual.await;
        });
        let paste_request = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("the paste request sends once polled")
            .expect("the channel stays open");
        let pa_tui::auth_panel::AuthPanelRequest::PastePrompt { prompt, .. } = paste_request else {
            panic!("expected the paste request")
        };
        assert_eq!(
            prompt,
            "Paste redirect URL below, or complete login in browser:"
        );

        // The fallback prompt carries the flow's own message.
        let prompt = ui.on_prompt("Paste the authorization code (or full redirect URL):");
        let prompt_task = tokio::spawn(async move {
            let _ = prompt.await;
        });
        let prompt_request = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("the prompt request sends once polled")
            .expect("the channel stays open");
        let pa_tui::auth_panel::AuthPanelRequest::PastePrompt { prompt, .. } = prompt_request
        else {
            panic!("expected the prompt request")
        };
        assert_eq!(
            prompt,
            "Paste the authorization code (or full redirect URL):"
        );

        // The pending paste/prompt tasks are dropped: no answer is
        // expected (the test never mounts the panel).
        manual_task.abort();
        prompt_task.abort();
    }
}
