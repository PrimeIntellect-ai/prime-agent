//! The subscription logins (TS `showLoginDialog` over the `anthropic`,
//! `githubCopilot`, and `xai` providers), rendered through the inline auth
//! panel. Cancellation (#2770): each flow checks the cancel flag between poll
//! steps and before the credential write.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use pa_ai::oauth::{
    login_anthropic, login_github_copilot, login_xai, AnthropicCredentials, OAuthLoginUi,
    OAuthPrompt, ProviderHttp, ANTHROPIC_LOGIN_CANCELLED, COPILOT_LOGIN_CANCELLED,
    XAI_LOGIN_CANCELLED,
};
use pa_core::auth::{
    AuthCredential, AuthStorage, ANTHROPIC_PROVIDER_ID, GITHUB_COPILOT_PROVIDER_ID, XAI_PROVIDER_ID,
};
use pa_tui::auth_panel::{AuthPanelHandle, PastePromptTone, PasteStyle};
use pa_tui::provider_auth::ProviderAuthOutcome;

/// The manual-input prompt (the callback-server providers' paste line).
const MANUAL_INPUT_PROMPT: &str = "Paste redirect URL below, or complete login in browser:";
/// `showWaiting` for the Copilot device flow.
const COPILOT_WAITING: &str = "Waiting for browser authentication...";

/// The inline auth panel as the subscription logins' surface: the browser URL
/// block (the flow opens the browser), the prompts, the progress lines, and the
/// manual paste racing the browser callback.
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
            // `showWaiting` is the dialog's own method, no onboarding guard —
            // never the `onProgress` chatter arm.
            self.panel.waiting(COPILOT_WAITING);
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
            // The placeholder renders as an example.
            Some(placeholder) => format!("{message} (e.g. {placeholder})"),
            None => message,
        };
        Box::pin(async move {
            if allow_empty {
                // `allowEmpty`: a blank submit is a valid answer (the Copilot domain prompt's
                // "blank for github.com").
                panel
                    .paste_prompt_allow_empty(&message, PastePromptTone::Text, PasteStyle::Visible)
                    .await
            } else {
                panel
                    .paste_prompt(&message, PastePromptTone::Text, PasteStyle::Visible)
                    .await
            }
        })
    }

    fn on_progress(&self, message: &str) {
        // The `onProgress` arm is unguarded chatter — a direct progress line: renders on every
        // surface.
        self.panel.progress_line(message);
    }

    fn on_manual_code_input(
        &self,
    ) -> Option<Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>> {
        let panel = self.panel.clone();
        Some(Box::pin(async move {
            panel
                .paste_prompt(
                    MANUAL_INPUT_PROMPT,
                    PastePromptTone::Muted,
                    PasteStyle::Visible,
                )
                .await
        }))
    }

    fn is_cancelled(&self) -> bool {
        self.panel.cancelled()
    }
}

/// Run the Anthropic flow, store the credential, and report the status. A
/// cancelled surface stays silent; a failed flow reports the error row.
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
    store_anthropic_login(agent_dir, provider_name, credentials)
}

/// TS `completeProviderAuthentication` for Anthropic: store the
/// credential under the provider id and report the TS status.
fn store_anthropic_login(
    agent_dir: &Path,
    provider_name: &str,
    credentials: AnthropicCredentials,
) -> ProviderAuthOutcome {
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

/// The GitHub Copilot flow: the Copilot token stores as the access, the GitHub
/// token as the refresh, the enterprise domain riding the credential.
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

/// The oauth status row.
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

    /// A scripted transport: queued responses per url (popped in order; unknown urls fail the
    /// request).
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

    /// A scripted surface: the prompt answer and a shared cancel flag.
    struct ScriptedUi {
        prompt: String,
        cancelled: Arc<AtomicBool>,
    }

    impl ScriptedUi {
        fn new() -> Self {
            ScriptedUi {
                prompt: String::new(),
                cancelled: Arc::new(AtomicBool::new(false)),
            }
        }

        fn prompt(mut self, answer: &str) -> Self {
            self.prompt = answer.to_string();
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
            Box::pin(std::future::ready(Some(self.prompt.clone())))
        }

        fn on_progress(&self, _message: &str) {}

        fn on_manual_code_input(
            &self,
        ) -> Option<Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>> {
            None
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
        // The packaged auth.json wire shape: the Copilot token as the access, the GitHub token as
        // the refresh.
        let document: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(agent.join("auth.json")).unwrap())
                .unwrap();
        let stored = &document["github-copilot"];
        assert_eq!(stored["type"], "oauth");
        assert_eq!(stored["access"], "copilot-token");
        assert_eq!(stored["refresh"], "gh-token");
        // The stored credential resolves as the provider's api key (the subscription models become
        // selectable).
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
        // The expiry is `now + expires_in * 1000 - 5 minutes` (TS's convention).
        let expires = stored["expires"].as_i64().expect("the expiry is numeric");
        let after_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert!(
            expires >= before_ms + 3_600_000 - 300_000 && expires <= after_ms + 3_600_000 - 300_000,
            "the expiry lands one hour minus the skew out: {expires} vs {before_ms}..{after_ms}"
        );
        let mut auth = AuthStorage::create(&agent);
        assert_eq!(auth.get_api_key("xai"), Some("grok-access".to_string()));
    }

    /// The Anthropic login's store step: the credential's wire shape
    /// under the provider id (the flow is covered in pa-ai).
    #[test]
    fn the_anthropic_login_stores_the_credential_and_reports_the_ts_status() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = agent_dir(&dir);
        let credentials = AnthropicCredentials {
            access: "anthropic-access".to_string(),
            refresh: "anthropic-refresh".to_string(),
            expires: 4_000_000_000_000,
        };
        match store_anthropic_login(&agent, "Anthropic (Claude Pro/Max)", credentials) {
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

    /// A cancelled pane never receives the credential — the abort-cleanup regression.
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

    #[tokio::test]
    async fn the_stored_credentials_round_trip_and_refresh() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = agent_dir(&dir);
        let http = xai_http();
        let ui = ScriptedUi::new();
        run_xai_login(&agent, "xAI (Grok)", &http, &ui).await;
        // Reload through the default integration (the daemon's path): an unexpired credential
        // resolves its access token.
        let mut auth = AuthStorage::create(&agent);
        assert_eq!(auth.get_api_key("xai"), Some("grok-access".to_string()));
        // An expired credential refreshes through the integration's scripted endpoint and the fresh
        // token resolves.
        let mut data = auth.get_all();
        if let Some(document) = data.0.get_mut("xai") {
            document["expires"] = serde_json::json!(1);
        }
        let mut expired = AuthStorage::in_memory_without_env(
            &data,
            Arc::new(pa_core::auth::ProviderOAuth::with_transports(
                Arc::new(pa_ai::oauth::ReqwestCodexHttp::new()),
                Arc::new(xai_http()),
            )),
        );
        assert_eq!(expired.get_api_key("xai"), Some("grok-access".to_string()));
    }
}
