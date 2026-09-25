//! The composition root's subscription logins (TS `auth-flows.ts`'s
//! `showLoginDialog` over the AI library's `anthropic`,
//! `githubCopilot`, and `xai` providers): the browser URL block, the
//! prompts, the progress lines, and the credential write under each
//! provider's id. Every surface renders through the inline auth panel
//! (TS the login dialog in the TUI); nothing touches the plain
//! terminal. The credential the flow stores carries the TS
//! `auth.json` wire shape, and a stored credential makes the
//! provider's subscription models resolvable.
//!
//! Cancellation (#2770): the panel handle's shared flag is the seam —
//! the driving pane marks it on exit and each flow checks it between
//! its own poll steps (the flows check it again before the credential
//! write), so an exited pane never lands a credential (a task abort
//! cannot reach the started blocking body).

use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use pa_ai::oauth::{
    login_anthropic, login_github_copilot, login_xai, OAuthLoginUi, OAuthPrompt, ProviderHttp,
    ANTHROPIC_LOGIN_CANCELLED, COPILOT_LOGIN_CANCELLED, XAI_LOGIN_CANCELLED,
};
use pa_core::auth::{
    AuthCredential, AuthStorage, ANTHROPIC_PROVIDER_ID, GITHUB_COPILOT_PROVIDER_ID, XAI_PROVIDER_ID,
};
use pa_tui::auth_panel::{AuthPanelHandle, PasteStyle};
use pa_tui::provider_auth::ProviderAuthOutcome;

/// TS the login dialog's manual-input prompt (the callback-server
/// providers' paste line).
const MANUAL_INPUT_PROMPT: &str = "Paste redirect URL below, or complete login in browser:";
/// TS `showWaiting` for the Copilot device flow (the composition root's
/// onAuth handling for `github-copilot`).
const COPILOT_WAITING: &str = "Waiting for browser authentication...";

/// The inline auth panel as the subscription logins' surface (TS the
/// login dialog): the browser URL block (the flow opens the browser;
/// the panel renders), the prompts, the progress lines, and the manual
/// paste racing the browser callback ride the panel channel. The
/// Copilot provider adds its waiting line (TS the dialog's
/// provider-specific `showWaiting`).
pub(crate) struct PanelSubscriptionLoginUi {
    panel: AuthPanelHandle,
    provider_id: String,
}

impl PanelSubscriptionLoginUi {
    pub(crate) fn new(panel: AuthPanelHandle, provider_id: &str) -> Self {
        PanelSubscriptionLoginUi {
            panel,
            provider_id: provider_id.to_string(),
        }
    }
}

impl OAuthLoginUi for PanelSubscriptionLoginUi {
    fn on_auth(&self, url: &str, instructions: Option<&str>) {
        self.panel.auth_url(url, instructions);
        pa_core::platform::browser::open_in_browser(url);
        if self.provider_id == GITHUB_COPILOT_PROVIDER_ID {
            self.panel.progress(COPILOT_WAITING);
        }
    }

    fn on_prompt(
        &self,
        prompt: &OAuthPrompt,
    ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
        let panel = self.panel.clone();
        let message = prompt.message.clone();
        let allow_empty = prompt.allow_empty;
        let message = match &prompt.placeholder {
            // TS `showPrompt` renders the placeholder as an example.
            Some(placeholder) => format!("{message} (e.g. {placeholder})"),
            None => message,
        };
        Box::pin(async move {
            if allow_empty {
                // TS `OAuthPrompt.allowEmpty`: a blank submit is a valid
                // answer (the Copilot domain prompt's "blank for
                // github.com").
                panel
                    .paste_prompt_allow_empty(&message, PasteStyle::Visible)
                    .await
            } else {
                panel.paste_prompt(&message, PasteStyle::Visible).await
            }
        })
    }

    fn on_progress(&self, message: &str) {
        self.panel.progress(message);
    }

    fn on_manual_code_input(
        &self,
    ) -> Option<Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>> {
        let panel = self.panel.clone();
        Some(Box::pin(async move {
            panel
                .paste_prompt(MANUAL_INPUT_PROMPT, PasteStyle::Visible)
                .await
        }))
    }

    fn is_cancelled(&self) -> bool {
        self.panel.cancelled()
    }
}

/// TS `showLoginDialog` + `completeProviderAuthentication`: run the
/// Anthropic flow, store the credential, and report the TS status. A
/// cancelled surface stays silent; a failed flow reports the TS error
/// row.
pub(crate) async fn run_anthropic_login(
    agent_dir: &Path,
    provider_name: &str,
    http: &dyn ProviderHttp,
    ui: &dyn OAuthLoginUi,
) -> ProviderAuthOutcome {
    let credentials = match login_anthropic(http, ui).await {
        Ok(credentials) => credentials,
        Err(message) if message == ANTHROPIC_LOGIN_CANCELLED => {
            return ProviderAuthOutcome::Cancelled;
        }
        Err(message) => {
            return ProviderAuthOutcome::Error(format!(
                "Failed to login to {provider_name}: {message}"
            ));
        }
    };
    // The pane exited while the login ran: no credential write lands.
    if ui.is_cancelled() {
        return ProviderAuthOutcome::Cancelled;
    }
    let mut auth = AuthStorage::create(agent_dir);
    auth.set(
        ANTHROPIC_PROVIDER_ID,
        AuthCredential::Oauth {
            access: credentials.access,
            refresh: Some(credentials.refresh),
            expires: credentials.expires,
            account_id: None,
            enterprise_url: None,
            endpoint: None,
            token_endpoint: None,
            client_id: None,
            resource: None,
            issuer: None,
        },
    );
    if let Some(error) = auth.drain_errors().pop() {
        return ProviderAuthOutcome::Error(format!(
            "Failed to login to {provider_name}: could not save the login: {error}"
        ));
    }
    login_status(agent_dir, provider_name)
}

/// TS `showLoginDialog` + `completeProviderAuthentication` for GitHub
/// Copilot: the credential stores the Copilot token as the access and
/// the GitHub token as the refresh, with the enterprise domain riding
/// the credential (TS `enterpriseUrl`).
pub(crate) async fn run_github_copilot_login(
    agent_dir: &Path,
    provider_name: &str,
    http: &dyn ProviderHttp,
    ui: &dyn OAuthLoginUi,
) -> ProviderAuthOutcome {
    let credentials = match login_github_copilot(http, ui).await {
        Ok(credentials) => credentials,
        Err(message) if message == COPILOT_LOGIN_CANCELLED => {
            return ProviderAuthOutcome::Cancelled;
        }
        Err(message) => {
            return ProviderAuthOutcome::Error(format!(
                "Failed to login to {provider_name}: {message}"
            ));
        }
    };
    if ui.is_cancelled() {
        return ProviderAuthOutcome::Cancelled;
    }
    let mut auth = AuthStorage::create(agent_dir);
    auth.set(
        GITHUB_COPILOT_PROVIDER_ID,
        AuthCredential::Oauth {
            access: credentials.access,
            refresh: Some(credentials.refresh),
            expires: credentials.expires,
            account_id: None,
            enterprise_url: credentials.enterprise_url,
            endpoint: None,
            token_endpoint: None,
            client_id: None,
            resource: None,
            issuer: None,
        },
    );
    if let Some(error) = auth.drain_errors().pop() {
        return ProviderAuthOutcome::Error(format!(
            "Failed to login to {provider_name}: could not save the login: {error}"
        ));
    }
    login_status(agent_dir, provider_name)
}

/// TS `showLoginDialog` + `completeProviderAuthentication` for xAI.
pub(crate) async fn run_xai_login(
    agent_dir: &Path,
    provider_name: &str,
    http: &dyn ProviderHttp,
    ui: &dyn OAuthLoginUi,
) -> ProviderAuthOutcome {
    let credentials = match login_xai(http, ui).await {
        Ok(credentials) => credentials,
        Err(message) if message == XAI_LOGIN_CANCELLED => {
            return ProviderAuthOutcome::Cancelled;
        }
        Err(message) => {
            return ProviderAuthOutcome::Error(format!(
                "Failed to login to {provider_name}: {message}"
            ));
        }
    };
    if ui.is_cancelled() {
        return ProviderAuthOutcome::Cancelled;
    }
    let mut auth = AuthStorage::create(agent_dir);
    auth.set(
        XAI_PROVIDER_ID,
        AuthCredential::Oauth {
            access: credentials.access,
            refresh: Some(credentials.refresh),
            expires: credentials.expires,
            account_id: None,
            enterprise_url: None,
            endpoint: None,
            token_endpoint: None,
            client_id: None,
            resource: None,
            issuer: None,
        },
    );
    if let Some(error) = auth.drain_errors().pop() {
        return ProviderAuthOutcome::Error(format!(
            "Failed to login to {provider_name}: could not save the login: {error}"
        ));
    }
    login_status(agent_dir, provider_name)
}

/// TS `completeProviderAuthentication`'s oauth status row.
fn login_status(agent_dir: &Path, provider_name: &str) -> ProviderAuthOutcome {
    ProviderAuthOutcome::Status(format!(
        "Logged in to {provider_name}. Credentials saved to {}",
        agent_dir.join("auth.json").display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use pa_ai::oauth::ProviderHttpResponse;

    /// A scripted transport: queued responses per url (popped in
    /// order; unknown urls fail the request).
    struct ScriptedHttp {
        queued: std::sync::Mutex<HashMap<String, VecDeque<ProviderHttpResponse>>>,
    }

    impl ScriptedHttp {
        fn new() -> Self {
            ScriptedHttp {
                queued: std::sync::Mutex::new(HashMap::new()),
            }
        }

        fn entry(status: u16, body: &str) -> ProviderHttpResponse {
            ProviderHttpResponse {
                status,
                body: body.to_string(),
            }
        }

        fn queue(self, url: &str, responses: Vec<ProviderHttpResponse>) -> Self {
            self.queued.lock().unwrap().insert(
                url.to_string(),
                responses.into_iter().collect::<VecDeque<_>>(),
            );
            self
        }
    }

    impl ProviderHttp for ScriptedHttp {
        fn request(
            &self,
            request: pa_ai::oauth::ProviderHttpRequest,
            _timeout_ms: u64,
        ) -> Pin<Box<dyn Future<Output = Result<ProviderHttpResponse, String>> + Send + '_>>
        {
            let response = self
                .queued
                .lock()
                .unwrap()
                .get_mut(&request.url)
                .and_then(std::collections::VecDeque::pop_front);
            Box::pin(
                async move { response.ok_or_else(|| format!("{} was not scripted", request.url)) },
            )
        }
    }

    /// One scripted prompt answer: a value (blank included — TS
    /// `allowEmpty`'s blank entry) or a cancel.
    enum Answer {
        Value(String),
        Cancel,
    }

    /// A scripted surface: the prompt answer, the manual paste, and a
    /// shared cancel flag.
    struct ScriptedUi {
        prompt: Answer,
        manual: Option<String>,
        cancelled: Arc<AtomicBool>,
    }

    impl ScriptedUi {
        fn new() -> Self {
            ScriptedUi {
                prompt: Answer::Value(String::new()),
                manual: None,
                cancelled: Arc::new(AtomicBool::new(false)),
            }
        }

        fn prompt(mut self, answer: &str) -> Self {
            self.prompt = Answer::Value(answer.to_string());
            self
        }

        fn cancelled_prompt(mut self) -> Self {
            self.prompt = Answer::Cancel;
            self
        }

        fn flag(&self) -> Arc<AtomicBool> {
            Arc::clone(&self.cancelled)
        }
    }

    impl OAuthLoginUi for ScriptedUi {
        fn on_auth(&self, _url: &str, _instructions: Option<&str>) {}

        fn on_prompt(
            &self,
            _prompt: &OAuthPrompt,
        ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
            let answer = match &self.prompt {
                Answer::Value(value) => Some(value.clone()),
                Answer::Cancel => None,
            };
            Box::pin(std::future::ready(answer))
        }

        fn on_progress(&self, _message: &str) {}

        fn on_manual_code_input(
            &self,
        ) -> Option<Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>> {
            self.manual
                .as_ref()
                .map(|answer| Box::pin(std::future::ready(Some(answer.to_string()))) as _)
        }

        fn is_cancelled(&self) -> bool {
            self.cancelled.load(Ordering::Relaxed)
        }
    }

    /// The Copilot happy flow's scripted endpoints.
    fn copilot_http() -> ScriptedHttp {
        ScriptedHttp::new()
            .queue(
                "https://github.com/login/device/code",
                vec![ScriptedHttp::entry(
                    200,
                    r#"{"device_code":"dev-1","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","interval":0,"expires_in":900}"#,
                )],
            )
            .queue(
                "https://github.com/login/oauth/access_token",
                vec![ScriptedHttp::entry(200, r#"{"access_token":"gh-token"}"#)],
            )
            .queue(
                "https://api.github.com/copilot_internal/v2/token",
                vec![ScriptedHttp::entry(
                    200,
                    r#"{"token":"copilot-token","expires_at":4000000000}"#,
                )],
            )
    }

    /// The xAI happy flow's scripted endpoints.
    fn xai_http() -> ScriptedHttp {
        ScriptedHttp::new()
            .queue(
                "https://auth.x.ai/oauth2/device/code",
                vec![ScriptedHttp::entry(
                    200,
                    r#"{"device_code":"dev-1","user_code":"GROK-1234","verification_uri":"https://auth.x.ai/activate","interval":0,"expires_in":900}"#,
                )],
            )
            .queue(
                "https://auth.x.ai/oauth2/token",
                vec![ScriptedHttp::entry(
                    200,
                    r#"{"access_token":"grok-access","refresh_token":"grok-refresh","expires_in":3600}"#,
                )],
            )
    }

    fn agent_dir(dir: &tempfile::TempDir) -> std::path::PathBuf {
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&agent).expect("agent dir");
        agent
    }

    #[tokio::test]
    async fn the_copilot_login_stores_the_credential_and_reports_the_ts_status() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = agent_dir(&dir);
        let http = copilot_http();
        let ui = ScriptedUi::new().prompt("");
        match run_github_copilot_login(&agent, "GitHub Copilot", &http, &ui).await {
            ProviderAuthOutcome::Status(message) => {
                assert_eq!(
                    message,
                    format!(
                        "Logged in to GitHub Copilot. Credentials saved to {}",
                        agent.join("auth.json").display()
                    )
                );
            }
            other => panic!("expected the logged-in status, got {other:?}"),
        }
        // The packaged auth.json wire shape: the Copilot token as the
        // access, the GitHub token as the refresh.
        let document: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(agent.join("auth.json")).unwrap())
                .unwrap();
        let stored = &document["github-copilot"];
        assert_eq!(stored["type"], "oauth");
        assert_eq!(stored["access"], "copilot-token");
        assert_eq!(stored["refresh"], "gh-token");
        // The stored credential resolves as the provider's api key (the
        // subscription models become selectable).
        let mut auth = AuthStorage::create(&agent);
        assert_eq!(
            auth.get_api_key("github-copilot"),
            Some("copilot-token".to_string())
        );
    }

    #[tokio::test]
    async fn the_xai_login_stores_the_credential_and_reports_the_ts_status() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = agent_dir(&dir);
        let http = xai_http();
        let ui = ScriptedUi::new();
        let before_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(i64::MAX, |elapsed| elapsed.as_millis() as i64);
        match run_xai_login(&agent, "xAI (Grok)", &http, &ui).await {
            ProviderAuthOutcome::Status(message) => {
                assert_eq!(
                    message,
                    format!(
                        "Logged in to xAI (Grok). Credentials saved to {}",
                        agent.join("auth.json").display()
                    )
                );
            }
            other => panic!("expected the logged-in status, got {other:?}"),
        }
        let document: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(agent.join("auth.json")).unwrap())
                .unwrap();
        let stored = &document["xai"];
        assert_eq!(stored["type"], "oauth");
        assert_eq!(stored["access"], "grok-access");
        assert_eq!(stored["refresh"], "grok-refresh");
        // The expiry is `now + expires_in * 1000 - 5 minutes` (TS's
        // convention).
        let expires = stored["expires"].as_i64().expect("the expiry is numeric");
        let after_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert!(
            expires >= before_ms + 3_600_000 - 300_000
                && expires <= after_ms + 3_600_000 - 300_000,
            "the expiry lands one hour minus the skew out: {expires} vs {before_ms}..{after_ms}"
        );
        let mut auth = AuthStorage::create(&agent);
        assert_eq!(auth.get_api_key("xai"), Some("grok-access".to_string()));
    }

    /// The Anthropic login's run: the flow binds its registered callback
    /// port. Skip when another process holds the port — the flow-level
    /// tests cover the race; this test covers the store's wire shape.
    #[tokio::test]
    async fn the_anthropic_login_stores_the_credential_and_reports_the_ts_status() {
        let Ok(probe) = std::net::TcpListener::bind(("127.0.0.1", 53_692)) else {
            return; // the registered port is busy: this run cannot stage it.
        };
        drop(probe);
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = agent_dir(&dir);
        let http = ScriptedHttp::new().queue(
            "https://platform.claude.com/v1/oauth/token",
            vec![ScriptedHttp::entry(
                200,
                r#"{"access_token":"anthropic-access","refresh_token":"anthropic-refresh","expires_in":3600}"#,
            )],
        );
        let mut ui = ScriptedUi::new().cancelled_prompt();
        ui.manual = Some("http://localhost:53692/callback?code=anthropic-code".to_string());
        match run_anthropic_login(&agent, "Anthropic (Claude Pro/Max)", &http, &ui).await {
            ProviderAuthOutcome::Status(message) => {
                assert_eq!(
                    message,
                    format!(
                        "Logged in to Anthropic (Claude Pro/Max). Credentials saved to {}",
                        agent.join("auth.json").display()
                    )
                );
            }
            other => panic!("expected the logged-in status, got {other:?}"),
        }
        let document: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(agent.join("auth.json")).unwrap())
                .unwrap();
        let stored = &document["anthropic"];
        assert_eq!(stored["type"], "oauth");
        assert_eq!(stored["access"], "anthropic-access");
        assert_eq!(stored["refresh"], "anthropic-refresh");
        assert!(stored.get("enterpriseUrl").is_none());
        let mut auth = AuthStorage::create(&agent);
        assert_eq!(
            auth.get_api_key("anthropic"),
            Some("anthropic-access".to_string())
        );
    }

    /// A cancelled pane never receives the credential (#2770: no write
    /// after the exit) — the regression test for the abort-cleanup
    /// contract.
    #[tokio::test]
    async fn a_cancelled_pane_writes_no_credential() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = agent_dir(&dir);
        let http = copilot_http();
        let ui = ScriptedUi::new().prompt("");
        ui.flag().store(true, Ordering::Relaxed);
        assert_eq!(
            run_github_copilot_login(&agent, "GitHub Copilot", &http, &ui).await,
            ProviderAuthOutcome::Cancelled
        );
        assert!(
            !agent.join("auth.json").exists(),
            "a cancelled pane lands no credential"
        );
    }

    #[tokio::test]
    async fn a_failed_flow_reports_the_ts_error_row() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = agent_dir(&dir);
        // Nothing scripted: the device request fails.
        let http = ScriptedHttp::new();
        let ui = ScriptedUi::new().prompt("");
        assert_eq!(
            run_github_copilot_login(&agent, "GitHub Copilot", &http, &ui).await,
            ProviderAuthOutcome::Error(
                "Failed to login to GitHub Copilot: \
                 https://github.com/login/device/code was not scripted"
                    .to_string()
            )
        );
        // The xAI error row names its endpoint.
        let http = ScriptedHttp::new();
        let ui = ScriptedUi::new();
        assert_eq!(
            run_xai_login(&agent, "xAI (Grok)", &http, &ui).await,
            ProviderAuthOutcome::Error(
                "Failed to login to xAI (Grok): xAI OAuth request failed. Check your connection and try again."
                    .to_string()
            )
        );
    }

    /// The credential round-trip: the flows' stored credentials reload,
    /// resolve while unexpired, and refresh at expiry through the
    /// default provider integration (the packaged-build path: the same
    /// `AuthStorage::create` every surface uses).
    #[tokio::test]
    async fn the_stored_credentials_round_trip_and_refresh() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = agent_dir(&dir);
        let http = xai_http();
        let ui = ScriptedUi::new();
        run_xai_login(&agent, "xAI (Grok)", &http, &ui).await;
        // Reload through the default integration (the daemon's path):
        // an unexpired credential resolves its access token.
        let mut auth = AuthStorage::create(&agent);
        assert_eq!(auth.get_api_key("xai"), Some("grok-access".to_string()));
        // An expired credential refreshes through the integration's
        // scripted endpoint and the fresh token resolves.
        let mut data = auth.get_all();
        if let Some(document) = data.0.get_mut("xai") {
            document["expires"] = serde_json::json!(1);
        }
        let mut expired = AuthStorage::in_memory_without_env(
            data,
            Arc::new(pa_core::auth::ProviderOAuth::with_transports(
                Arc::new(pa_ai::oauth::ReqwestCodexHttp::new()),
                Arc::new(xai_http()),
            )),
        );
        assert_eq!(expired.get_api_key("xai"), Some("grok-access".to_string()));
    }

    #[tokio::test]
    async fn the_panel_surface_mounts_the_ts_prompts() {
        // The panel adapter's seam: on_auth renders the url block (the
        // Copilot provider adds its waiting line), the placeholder rides
        // the prompt as TS's example line, and the allow-empty prompt
        // keeps its blank answer. The url block sends immediately (a
        // plain request); the paste/prompt futures are LAZY (the request
        // sends on first poll), so the test spawns them and reads the
        // requests off the channel's receiving side, bounded by a recv
        // timeout that fails the test — never a green-on-timeout retry.
        // The prompt futures borrow their adapter, so they drive on a
        // select instead of a spawned 'static task (the first poll sends
        // the request; the pending future drops with this scope).
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let panel = AuthPanelHandle::new(tx);
        let copilot = PanelSubscriptionLoginUi::new(panel, "github-copilot");
        copilot.on_auth(
            "https://github.com/login/device",
            Some("Enter code: ABCD-1234"),
        );
        let url_request = rx.recv().await.expect("the url block sends");
        match url_request {
            pa_tui::auth_panel::AuthPanelRequest::AuthUrl { url, instructions } => {
                assert_eq!(url, "https://github.com/login/device");
                assert_eq!(instructions.as_deref(), Some("Enter code: ABCD-1234"));
            }
            _ => panic!("expected the url block request"),
        }
        // TS `showWaiting` for the Copilot device flow.
        let waiting = rx.recv().await.expect("the waiting line sends");
        match waiting {
            pa_tui::auth_panel::AuthPanelRequest::Progress { message } => {
                assert_eq!(message, "Waiting for browser authentication...");
            }
            _ => panic!("expected the waiting line request"),
        }
        // The domain prompt: the boxed future sends its PastePrompt on
        // first poll, then pends on the answer this test never gives.
        let mut domain = copilot.on_prompt(&OAuthPrompt {
            message: "GitHub Enterprise URL/domain (blank for github.com)".to_string(),
            placeholder: Some("company.ghe.com".to_string()),
            allow_empty: true,
        });
        let prompt_request = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::select! {
                request = rx.recv() => request.expect("the channel stays open"),
                _ = &mut domain => {
                    panic!("the prompt future settled without an answer")
                }
            }
        })
        .await
        .expect("the prompt request sends once polled");
        match prompt_request {
            // TS `showPrompt` renders the placeholder as an example.
            pa_tui::auth_panel::AuthPanelRequest::PastePrompt {
                prompt,
                allow_empty,
                ..
            } => {
                assert_eq!(
                    prompt,
                    "GitHub Enterprise URL/domain (blank for github.com) (e.g. company.ghe.com)"
                );
                assert!(allow_empty, "the blank entry is the valid default");
            }
            _ => panic!("expected the paste prompt request"),
        }
        // The pending prompt future drops with this scope: no answer is
        // expected (the test never mounts the panel).

        // The Anthropic adapter renders the url block without the
        // waiting line and arms the TS manual paste.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let panel = AuthPanelHandle::new(tx);
        let anthropic = PanelSubscriptionLoginUi::new(panel, "anthropic");
        anthropic.on_auth(
            "https://claude.ai/oauth/authorize",
            Some("Complete login in your browser."),
        );
        let url_request = rx.recv().await.expect("the url block sends");
        match url_request {
            pa_tui::auth_panel::AuthPanelRequest::AuthUrl { url, instructions } => {
                assert_eq!(url, "https://claude.ai/oauth/authorize");
                assert_eq!(
                    instructions.as_deref(),
                    Some("Complete login in your browser.")
                );
            }
            _ => panic!("expected the url block request"),
        }
        let mut manual = anthropic
            .on_manual_code_input()
            .expect("the panel supplies the paste");
        let paste_request = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::select! {
                request = rx.recv() => request.expect("the channel stays open"),
                _ = &mut manual => {
                    panic!("the paste future settled without an answer")
                }
            }
        })
        .await
        .expect("the paste request sends once polled");
        match paste_request {
            pa_tui::auth_panel::AuthPanelRequest::PastePrompt { prompt, .. } => {
                assert_eq!(
                    prompt,
                    "Paste redirect URL below, or complete login in browser:"
                );
            }
            _ => panic!("expected the paste request"),
        }
    }
}
