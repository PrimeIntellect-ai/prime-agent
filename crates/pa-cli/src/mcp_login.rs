//! The composition root's MCP auth flows behind the TUI's
//! `/mcp login <name>` and `/mcp logout <name>`: resolve the server
//! through the settings + builtin catalog, run the pa-core OAuth login on
//! the terminal (browser plus paste fallback), and persist the
//! endpoint-bound credential in the shared auth store. The TS interactive
//! client runs the same flow in its own process (auth-flows.ts
//! `runMcpLogin`) and reloads the session; this build surfaces the
/// activation state instead (the skill gating resolves at session build).
use std::path::PathBuf;
use std::pin::Pin;

use anyhow::{anyhow, Context, Result};

use pa_core::auth::AuthStorage;
use pa_core::mcp::{
    McpLoginUi, McpManager, McpManagerOptions, McpServerConfig, OAuthHttp, ReqwestOAuthHttp,
};
use pa_tui::client_auth::{AuthFuture, ClientAuthCommands};

/// The CLI's live MCP manager: the shared auth store, settings-declared
/// user servers (`mcpServers`), and local service-catalog sources
/// (`mcpCatalogSources`) all re-read per resolve — the same closures TS
/// `createAgentSessionServices` wires into every CLI session. No
/// interactive login: hosts with a login UI call `set_begin_login`
/// before the session registers host handlers; headless surfaces keep
/// the host request absent (TS registers `mcp.begin_login` only when a
/// login is wired).
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

/// `/mcp login` / `/mcp logout` against one daemon's shared directories.
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

    /// The manager that resolves integrations the same way the session
    /// engine's gating does (settings `mcpServers` + the builtin catalog):
    /// the crate's one live-manager construction.
    fn manager(&self) -> McpManager {
        cli_mcp_manager(&self.cwd, &self.agent_dir)
    }

    /// Run one login against an injectable UI/transport (the product uses
    /// the terminal UI and the reqwest transport; tests script the flow).
    async fn login_with(
        &self,
        server: &str,
        ui: &dyn McpLoginUi,
        http: &dyn OAuthHttp,
    ) -> Result<String> {
        // Unknown and non-OAuth servers fail with the TS wording
        // (`runMcpLogin`'s provider lookup).
        let context = self.manager().login_context(server)?;
        context.run(ui, http).await?;
        // TS: `Connected <name>.` after the post-login reload; the skill
        // gating here resolves when the next session builds.
        Ok(format!(
            "Connected {server}. Its skill activates in new sessions (/new)."
        ))
    }

    async fn login_inner(&self, server: &str) -> Result<String> {
        self.login_with(server, &TerminalLoginUi, &ReqwestOAuthHttp::new())
            .await
    }

    /// The inline paste panel's flow (TS: prompt for the ONE credential a
    /// pasteable service collects, store it bound to the endpoint, verify).
    async fn paste_inner(&self, server: &str) -> Result<String> {
        let manager = self.manager();
        let service = manager
            .service_descriptor(server)
            .ok_or_else(|| anyhow!("{server} is not a resolved MCP service."))?;
        let pasted = pa_core::mcp::mcp_paste_credential(service).ok_or_else(|| {
            anyhow!("{server} does not collect a single credential; it is not pasteable.")
        })?;
        let prompt = pa_core::mcp::mcp_credential_field_prompt_label(service, &pasted.field);
        println!("Paste the {prompt} for {server}:");
        let token = read_terminal_line()
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

    async fn logout_inner(&self, server: &str) -> Result<String> {
        let provider = format!("mcp:{server}");
        let mut auth = AuthStorage::create(&self.agent_dir);
        // TS: `isAuthed` reads the store; a missing credential is a no-op
        // notice, not an error.
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
    fn login(&self, server: &str) -> AuthFuture {
        let (auth, server) = (self.clone(), server.to_string());
        Box::pin(async move { auth.login_inner(&server).await })
    }

    fn paste_token(&self, server: &str) -> AuthFuture {
        let (auth, server) = (self.clone(), server.to_string());
        Box::pin(async move { auth.paste_inner(&server).await })
    }

    fn logout(&self, server: &str) -> AuthFuture {
        let (auth, server) = (self.clone(), server.to_string());
        Box::pin(async move { auth.logout_inner(&server).await })
    }
}

/// One line read from the terminal. `None` on EOF (the input surface went
/// away, so the waiting side treats it as a cancel). The read runs on the
/// blocking pool: raw mode is suspended for the login, and a cancel leaves
/// the waiting thread parked until a line arrives (the TS dialog's input
/// races the same way).
pub(crate) async fn read_terminal_line() -> Option<String> {
    tokio::task::spawn_blocking(|| {
        let mut line = String::new();
        match std::io::stdin().read_line(&mut line) {
            Ok(0) => None,
            Ok(_) => Some(line.trim().to_string()),
            Err(_) => None,
        }
    })
    .await
    .ok()
    .flatten()
}

/// The terminal login surface while the TUI is suspended: progress lines,
/// the authorization URL plus a browser launch, and the paste fallback
/// for a browser on another machine (the TS login dialog's surface).
struct TerminalLoginUi;

impl McpLoginUi for TerminalLoginUi {
    fn on_progress(&self, message: &str) {
        println!("{message}");
    }

    fn on_auth(&self, url: &str, instructions: &str) {
        println!("{instructions}");
        println!("{url}");
        println!();
        pa_core::platform::browser::open_in_browser(url);
    }

    fn on_prompt(
        &self,
        message: &str,
        placeholder: &str,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<String>> + Send>> {
        let message = message.to_string();
        let placeholder = placeholder.to_string();
        Box::pin(async move {
            println!("{message} ({placeholder})");
            read_terminal_line()
                .await
                .filter(|line| !line.is_empty())
                .ok_or_else(|| anyhow!("Login cancelled"))
        })
    }

    fn on_manual_code_input(
        &self,
    ) -> Option<Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>>> {
        Some(Box::pin(async move {
            println!("Paste the redirect URL below, or complete login in the browser:");
            read_terminal_line().await
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;

    /// A scripted transport (exact URL -> response), mirroring the pa-core
    /// login tests' fixture: a plain origin-level authorization server.
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

    /// A paste UI that derives the redirect from the authorization URL
    /// (the pa-core login tests' `PasteUi` shape).
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

        // A login through the hook path: unknown servers carry the TS
        // error wording.
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
                endpoint: Some("https://mcp.linear.app/mcp".to_string()),
                token_endpoint: None,
                client_id: None,
                resource: None,
                issuer: None,
            },
        );

        let hook = TerminalMcpAuth::new(dir.path().to_path_buf(), agent_dir.clone());
        let status = hook.logout_inner("linear").await?;
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
        // A second logout reports the TS not-connected notice.
        let status = hook.logout_inner("linear").await?;
        assert_eq!(status, "linear is not connected.");
        Ok(())
    }
}
