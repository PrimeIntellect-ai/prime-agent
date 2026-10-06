//! The composition root's MCP auth flows behind the TUI's
//! `/mcp login <name>` and `/mcp logout <name>` plus the `/mcp` view's
//! api-key credential flow (`key <name>`): resolve the server through
//! the settings + builtin catalog, run the pa-core OAuth login against
//! the inline auth panel (the authorization URL block and the paste
//! fallbacks render in the TUI; the browser launch rides the request),
//! and persist the endpoint-bound credential in the shared auth store —
//! the api-key credentials store their key in the auth slot the runtime
//! reads (the web-search key). The TS interactive client runs the same
//! flow in its own process (auth-flows.ts `runMcpLogin`) and reloads the
//! session; this build surfaces the activation state instead (the skill
//! gating resolves at session build).
use std::path::PathBuf;
use std::pin::Pin;

use anyhow::{anyhow, Context, Result};

use pa_core::auth::{AuthCredential, AuthStorage};
use pa_core::mcp::{
    McpLoginUi, McpManager, McpManagerOptions, McpServerConfig, OAuthHttp, ReqwestOAuthHttp,
};
use pa_tui::auth_panel::{PastePromptTone, PasteStyle};
use pa_tui::client_auth::{AuthFuture, ClientAuthCommands};

/// The CLI's live MCP manager: the shared auth store, `mcpServers`, and
/// `mcpCatalogSources` all re-read per resolve. No interactive login: hosts with
/// a login UI call `set_begin_login` before the session registers host handlers.
pub(crate) fn cli_mcp_manager(cwd: &std::path::Path, agent_dir: &std::path::Path) -> McpManager {
    let user_cwd = cwd.to_path_buf();
    let user_agent_dir = agent_dir.to_path_buf();
    let catalog_cwd = cwd.to_path_buf();
    let catalog_agent_dir = agent_dir.to_path_buf();
    McpManager::new(McpManagerOptions {
        auth_storage: AuthStorage::create_with_oauth(
            agent_dir,
            std::sync::Arc::new(pa_core::mcp::McpOAuth::new()),
        ),
        get_user_servers: Box::new(move || {
            let settings = pa_core::settings::SettingsManager::create(&user_cwd, &user_agent_dir);
            Some(
                settings
                    .settings()
                    .mcp_servers
                    .clone()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|(server, config)| {
                        serde_json::from_value::<McpServerConfig>(config)
                            .ok()
                            .map(|parsed| (server, parsed))
                    })
                    .collect(),
            )
        }),
        begin_login: None,
        agent_dir: Some(agent_dir.to_path_buf()),
        get_catalog_sources: Some(Box::new(move || {
            let settings =
                pa_core::settings::SettingsManager::create(&catalog_cwd, &catalog_agent_dir);
            settings
                .settings()
                .mcp_catalog_sources
                .clone()
                .unwrap_or_default()
        })),
        remote_source: None,
        probe_override: None,
    })
}

#[derive(Clone)]
pub struct TerminalMcpAuth {
    cwd: PathBuf,
    agent_dir: PathBuf,
}

impl TerminalMcpAuth {
    pub fn new(cwd: impl Into<PathBuf>, agent_dir: impl Into<PathBuf>) -> Self {
        TerminalMcpAuth {
            cwd: cwd.into(),
            agent_dir: agent_dir.into(),
        }
    }

    /// The manager that resolves integrations the same way the session engine's
    /// gating does (settings `mcpServers` + the builtin catalog).
    fn manager(&self) -> McpManager {
        cli_mcp_manager(&self.cwd, &self.agent_dir)
    }

    /// Run one login against an injectable UI/transport (tests script the
    /// flow).
    async fn login_with(
        &self,
        server: &str,
        ui: &dyn McpLoginUi,
        http: &dyn OAuthHttp,
    ) -> Result<String> {
        // Unknown and non-OAuth servers fail with the TS wording.
        let context = self.manager().login_context(server)?;
        context.run(ui, http).await?;
        // `Connected <name>.` (the skill gating resolves at the next
        // session build).
        Ok(format!(
            "Connected {server}. Its skill activates in new sessions (/new)."
        ))
    }

    async fn login_inner(
        &self,
        server: &str,
        panel: pa_tui::auth_panel::AuthPanelHandle,
    ) -> Result<String> {
        let ui = PanelMcpLoginUi { panel };
        self.login_with(server, &ui, &ReqwestOAuthHttp::new()).await
    }

    /// The inline paste panel's flow: prompt for the ONE credential a pasteable
    /// service collects (the masked field never renders the secret).
    async fn paste_inner(
        &self,
        server: &str,
        panel: pa_tui::auth_panel::AuthPanelHandle,
    ) -> Result<String> {
        let manager = self.manager();
        let service = manager
            .service_descriptor(server)
            .ok_or_else(|| anyhow!("{server} is not a resolved MCP service."))?;
        let pasted = pa_core::mcp::mcp_paste_credential(service).ok_or_else(|| {
            anyhow!("{server} does not collect a single credential; it is not pasteable.")
        })?;
        let prompt = pa_core::mcp::mcp_credential_field_prompt_label(service, &pasted.field);
        let token = panel
            .paste_prompt(
                &format!("Paste the {prompt} for {server}:"),
                PastePromptTone::Text,
                PasteStyle::Masked,
            )
            .await
            .filter(|line| !line.is_empty())
            .ok_or_else(|| anyhow!("Paste cancelled"))?;
        let inputs = manager
            .paste_install_inputs(server)
            .map_err(|message| anyhow!("{message}"))?;
        let outcome = pa_core::mcp::install_static_token(inputs, &token)
            .await
            .map_err(|message| anyhow!("{message}"))?;
        if outcome.verified {
            Ok(format!("Connected {server}."))
        } else {
            Ok(format!(
                "Saved the token for {server}; verification pending{}.",
                outcome
                    .error
                    .map(|error| format!(" ({error})"))
                    .unwrap_or_default()
            ))
        }
    }

    /// The api-key credential flow (the `/mcp` view's key rows): prompt
    /// for the ONE key the credential collects (the masked field never
    /// renders the secret) and store it in the credential's auth slot —
    /// the exact contract the runtime reads (auth.json's `serper` key,
    /// the `AuthCredential::ApiKey` form).
    async fn api_key_inner(
        &self,
        credential: &str,
        panel: pa_tui::auth_panel::AuthPanelHandle,
    ) -> Result<String> {
        let label = pa_core::mcp::API_KEY_CREDENTIALS
            .iter()
            .find(|(id, _)| *id == credential)
            .map(|(_, label)| *label)
            .ok_or_else(|| anyhow!("{credential} is not a known api-key credential."))?;
        let key = panel
            .paste_prompt(
                &format!("Paste the API key for {label}:"),
                PastePromptTone::Text,
                PasteStyle::Masked,
            )
            .await
            .filter(|line| !line.is_empty())
            .ok_or_else(|| anyhow!("Paste cancelled"))?;
        let mut auth = AuthStorage::create(&self.agent_dir);
        auth.set(
            credential,
            AuthCredential::ApiKey {
                key,
                prime_team: None,
            },
        );
        if let Some(error) = auth.drain_errors().pop() {
            return Err(anyhow!(error)).context("could not save the API key");
        }
        Ok(format!("Saved API key for {label}. Web search is ready."))
    }

    fn logout_inner(&self, server: &str) -> Result<String> {
        let provider = format!("mcp:{server}");
        let mut auth = AuthStorage::create(&self.agent_dir);
        // A missing credential is a no-op notice, not an error.
        if auth.get_all().get(&provider).is_none() {
            return Ok(format!("{server} is not connected."));
        }
        auth.logout(&provider);
        if let Some(error) = auth.drain_errors().pop() {
            return Err(anyhow!(error)).context("could not remove the stored credential");
        }
        Ok(format!(
            "Disconnected {server}. Its skill deactivates in new sessions (/new)."
        ))
    }
}

impl ClientAuthCommands for TerminalMcpAuth {
    fn login(&self, server: &str, panel: pa_tui::auth_panel::AuthPanelHandle) -> AuthFuture {
        let (auth, server) = (self.clone(), server.to_string());
        Box::pin(async move { auth.login_inner(&server, panel).await })
    }

    fn paste_token(&self, server: &str, panel: pa_tui::auth_panel::AuthPanelHandle) -> AuthFuture {
        let (auth, server) = (self.clone(), server.to_string());
        Box::pin(async move { auth.paste_inner(&server, panel).await })
    }

    fn api_key(&self, credential: &str, panel: pa_tui::auth_panel::AuthPanelHandle) -> AuthFuture {
        let (auth, credential) = (self.clone(), credential.to_string());
        Box::pin(async move { auth.api_key_inner(&credential, panel).await })
    }

    fn logout(&self, server: &str) -> AuthFuture {
        let (auth, server) = (self.clone(), server.to_string());
        Box::pin(async move { auth.logout_inner(&server) })
    }
}

/// The login's inline-panel surface: progress lines, the authorization URL block,
/// and the paste fallbacks drive the auth panel through the request channel; never
/// touches the terminal.
struct PanelMcpLoginUi {
    panel: pa_tui::auth_panel::AuthPanelHandle,
}

impl McpLoginUi for PanelMcpLoginUi {
    fn on_progress(&self, message: &str) {
        // Unguarded chatter — a direct progress line: renders on every
        // surface.
        self.panel.progress_line(message);
    }

    fn on_auth(&self, url: &str, instructions: &str) {
        self.panel.auth_url(url, Some(instructions));
        pa_core::platform::browser::open_in_browser(url);
    }

    fn on_prompt(
        &self,
        message: &str,
        placeholder: &str,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<String>> + Send>> {
        let panel = self.panel.clone();
        let message = format!("{message} (e.g. {placeholder})");
        Box::pin(async move {
            panel
                .paste_prompt(&message, PastePromptTone::Text, PasteStyle::Visible)
                .await
                .filter(|line| !line.is_empty())
                .ok_or_else(|| anyhow!("Login cancelled"))
        })
    }

    fn on_manual_code_input(
        &self,
    ) -> Option<Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>>> {
        let panel = self.panel.clone();
        Some(Box::pin(async move {
            panel
                .paste_prompt(
                    "Paste the redirect URL below, or complete login in the browser:",
                    PastePromptTone::Muted,
                    PasteStyle::Visible,
                )
                .await
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;

    /// A scripted transport (exact URL -> response): a plain origin-level
    /// authorization server.
    struct ScriptedHttp(HashMap<String, pa_core::mcp::OAuthHttpResponse>);

    impl ScriptedHttp {
        fn fixture() -> Self {
            let entry = |status: u16, body: &str| pa_core::mcp::OAuthHttpResponse {
                status,
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: body.to_string(),
            };
            ScriptedHttp(
                vec![
                    ("https://fixture.example/mcp".to_string(), entry(404, "")),
                    (
                        "https://fixture.example/.well-known/oauth-protected-resource/mcp"
                            .to_string(),
                        entry(404, ""),
                    ),
                    (
                        "https://fixture.example/.well-known/oauth-authorization-server"
                            .to_string(),
                        entry(
                            200,
                            r#"{"issuer":"https://fixture.example","authorization_endpoint":"https://fixture.example/authorize","token_endpoint":"https://fixture.example/token","registration_endpoint":"https://fixture.example/register"}"#,
                        ),
                    ),
                    (
                        "https://fixture.example/register".to_string(),
                        entry(200, r#"{"client_id":"fixture-client"}"#),
                    ),
                    (
                        "https://fixture.example/token".to_string(),
                        entry(
                            200,
                            r#"{"access_token":"fixture-access","refresh_token":"fixture-refresh","expires_in":3600}"#,
                        ),
                    ),
                ]
                .into_iter()
                .collect(),
            )
        }
    }

    impl OAuthHttp for ScriptedHttp {
        fn request(
            &self,
            request: pa_core::mcp::OAuthHttpRequest,
        ) -> futures::future::BoxFuture<'_, Result<pa_core::mcp::OAuthHttpResponse>> {
            Box::pin(async move {
                self.0
                    .get(&request.url)
                    .cloned()
                    .ok_or_else(|| anyhow!("unexpected request: {}", request.url))
            })
        }
    }

    struct PasteUi {
        auth_url: std::sync::Arc<std::sync::Mutex<String>>,
    }

    impl McpLoginUi for PasteUi {
        fn on_progress(&self, _message: &str) {}
        fn on_auth(&self, url: &str, _instructions: &str) {
            *self.auth_url.lock().unwrap() = url.to_string();
        }
        fn on_prompt(
            &self,
            _message: &str,
            _placeholder: &str,
        ) -> Pin<Box<dyn std::future::Future<Output = Result<String>> + Send>> {
            Box::pin(async { Err(anyhow!("no prompt surface")) })
        }
        fn on_manual_code_input(
            &self,
        ) -> Option<Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>>> {
            let auth_url = Arc::clone(&self.auth_url);
            Some(Box::pin(async move {
                let url = url::Url::parse(&auth_url.lock().unwrap()).ok()?;
                let redirect = url
                    .query_pairs()
                    .find(|(key, _)| key == "redirect_uri")
                    .map(|(_, value)| value.to_string())?;
                let state = url
                    .query_pairs()
                    .find(|(key, _)| key == "state")
                    .map(|(_, value)| value.to_string())?;
                Some(format!("{redirect}?code=the-code&state={state}"))
            }))
        }
    }

    fn settings_with_fixture_server(agent_dir: &std::path::Path) {
        std::fs::create_dir_all(agent_dir).expect("agent dir");
        std::fs::write(
            agent_dir.join("settings.json"),
            serde_json::json!({
                "mcpServers": {
                    "fixture": {
                        "type": "http",
                        "url": "https://fixture.example/mcp",
                        "oauth": true,
                    },
                },
            })
            .to_string(),
        )
        .expect("write settings.json");
    }

    #[tokio::test]
    async fn login_persists_endpoint_bound_creds_and_reports_connected() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let agent_dir = dir.path().join("agent");
        settings_with_fixture_server(&agent_dir);
        let auth = TerminalMcpAuth::new(dir.path().to_path_buf(), agent_dir.clone());
        let http = ScriptedHttp::fixture();
        let ui = PasteUi {
            auth_url: Arc::new(std::sync::Mutex::new(String::new())),
        };
        let status = auth.login_with("fixture", &ui, &http).await?;
        assert_eq!(
            status,
            "Connected fixture. Its skill activates in new sessions (/new)."
        );

        // The credential persisted in the TS McpCredentials shape.
        let stored: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(agent_dir.join("auth.json")).expect("auth.json"),
        )?;
        assert_eq!(stored["mcp:fixture"]["type"], "oauth");
        assert_eq!(stored["mcp:fixture"]["access"], "fixture-access");
        assert_eq!(
            stored["mcp:fixture"]["endpoint"],
            "https://fixture.example/mcp"
        );
        assert_eq!(
            stored["mcp:fixture"]["tokenEndpoint"],
            "https://fixture.example/token"
        );
        assert_eq!(stored["mcp:fixture"]["clientId"], "fixture-client");

        let error = auth
            .login_with("nope", &ui, &http)
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(error, "Unknown MCP integration: nope");
        Ok(())
    }

    #[tokio::test]
    async fn logout_removes_the_credential_with_ts_wording() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir)?;
        let mut auth = AuthStorage::create(&agent_dir);
        auth.set(
            "mcp:linear",
            pa_core::auth::AuthCredential::Oauth {
                access: "linear-access".to_string(),
                refresh: None,
                expires: i64::MAX,
                account_id: None,
                endpoint: Some("https://mcp.linear.app/mcp".to_string()),
                token_endpoint: None,
                client_id: None,
                resource: None,
                issuer: None,
                enterprise_url: None,
            },
        );

        let hook = TerminalMcpAuth::new(dir.path().to_path_buf(), agent_dir.clone());
        let status = hook.logout_inner("linear")?;
        assert_eq!(
            status,
            "Disconnected linear. Its skill deactivates in new sessions (/new)."
        );
        let stored: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(agent_dir.join("auth.json")).expect("auth.json"),
        )?;
        assert!(
            stored.get("mcp:linear").is_none(),
            "the credential was removed"
        );
        let status = hook.logout_inner("linear")?;
        assert_eq!(status, "linear is not connected.");
        Ok(())
    }

    #[tokio::test]
    async fn the_api_key_flow_stores_the_exact_runtime_contract() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir)?;
        let hook = TerminalMcpAuth::new(dir.path().to_path_buf(), agent_dir.clone());

        // The flow prompts (masked) for the key, then stores it.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let panel = pa_tui::auth_panel::AuthPanelHandle::new(tx);
        let flow = tokio::spawn({
            let hook = hook.clone();
            let panel = panel.clone();
            async move { hook.api_key_inner("serper", panel).await }
        });
        let request = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("the paste request sends")
            .expect("the channel stays open");
        let pa_tui::auth_panel::AuthPanelRequest::PastePrompt { prompt, reply, .. } = request
        else {
            panic!("expected the paste request")
        };
        assert_eq!(prompt, "Paste the API key for Serper (web search):");
        reply
            .send(Some("the-serper-key".to_string()))
            .expect("the reply lands");
        assert_eq!(
            flow.await.expect("the flow ran")?,
            "Saved API key for Serper (web search). Web search is ready."
        );

        // The stored credential is the EXACT contract the websearch runtime
        // reads: auth.json's `serper` slot, the `api_key` form.
        let stored: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(agent_dir.join("auth.json")).expect("auth.json"),
        )?;
        assert_eq!(stored["serper"]["type"], "api_key");
        assert_eq!(stored["serper"]["key"], "the-serper-key");

        // An unknown credential keeps its wording.
        let error = hook
            .api_key_inner("nope", panel.clone())
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(error, "nope is not a known api-key credential.");

        // A cancelled prompt answers the cancel (the stored key stays).
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let panel = pa_tui::auth_panel::AuthPanelHandle::new(tx);
        let flow = tokio::spawn({
            let hook = hook.clone();
            let panel = panel.clone();
            async move { hook.api_key_inner("serper", panel).await }
        });
        let request = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("the paste request sends")
            .expect("the channel stays open");
        let pa_tui::auth_panel::AuthPanelRequest::PastePrompt { reply, .. } = request else {
            panic!("expected the paste request")
        };
        reply.send(None).expect("the cancel lands");
        let error = flow.await.expect("the flow ran").unwrap_err().to_string();
        assert_eq!(error, "Paste cancelled");
        let stored: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(agent_dir.join("auth.json")).expect("auth.json"),
        )?;
        assert_eq!(stored["serper"]["key"], "the-serper-key");
        Ok(())
    }
}
