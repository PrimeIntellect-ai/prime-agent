//! Login execution for MCP integrations: resolve a server's OAuth setup,
//! run the interactive flow, persist the endpoint-bound credential, and wire
//! the `mcp.begin_login` host request in product paths (the TS manager's
//! `beginLogin` seam, provided by the UI mode).

use std::sync::{Arc, Mutex, Weak};

use anyhow::{anyhow, Context as _, Result};

use crate::auth::types::AuthCredential;
use crate::auth::{AuthStorage, OAuthIntegration};

use super::oauth::{mcp_login, McpLoginUi, McpOAuthConfig};
use super::oauth_http::OAuthHttp;
use super::McpManager;

/// One server's login execution: the resolved OAuth config plus the auth
/// store to persist into. Detached from the manager on purpose — the flow
/// awaits UI input, so no manager lock may be held across it.
pub struct McpLoginContext {
    server: String,
    config: McpOAuthConfig,
    auth_storage: Arc<tokio::sync::Mutex<AuthStorage>>,
}

impl McpLoginContext {
    /// Run the flow and persist the credential under `mcp:<server>`.
    ///
    /// # Errors
    ///
    /// Returns an error when the OAuth login flow fails, when the auth
    /// storage failed to load beforehand, or when saving the credential
    /// fails.
    pub async fn run(self, ui: &dyn McpLoginUi, http: &dyn OAuthHttp) -> Result<AuthCredential> {
        let provider_id = format!("mcp:{}", self.server);
        let credential = mcp_login(http, &self.config, ui).await?;
        let mut auth = self.auth_storage.lock().await;
        if auth.load_error().is_some() {
            return Err(anyhow!("auth storage failed to load; login was not saved"));
        }
        auth.set(&provider_id, credential.clone());
        if let Some(error) = auth.drain_errors().pop() {
            return Err(anyhow!(error)).context("could not save login credentials");
        }
        Ok(credential)
    }
}

impl McpManager {
    /// The server's OAuth config when the integration exists and uses
    /// OAuth (builtin catalog entries and `--oauth` user servers).
    pub fn oauth_config(&self, server: &str) -> Option<McpOAuthConfig> {
        let integration = self.integrations().get(server)?;
        if !integration.uses_oauth {
            return None;
        }
        let url = integration.config_url().map(str::to_string)?;
        Some(McpOAuthConfig {
            server: integration.server.clone(),
            label: integration.label.clone(),
            url,
            client_id: None,
            scopes: None,
        })
    }

    /// The execution context for one login: resolve the config, detach the
    /// auth store handle. Unknown and non-OAuth servers error with the TS
    /// wording (the kernel surfaces it to the model).
    ///
    /// # Errors
    ///
    /// Returns an error when the server is not a known MCP integration or
    /// does not use OAuth.
    pub fn login_context(&self, server: &str) -> Result<McpLoginContext> {
        let Some(config) = self.oauth_config(server) else {
            return Err(anyhow!("Unknown MCP integration: {server}"));
        };
        Ok(McpLoginContext {
            server: server.to_string(),
            config,
            auth_storage: self.auth_storage_handle(),
        })
    }
}

/// Wire a login UI into the manager so its `mcp.begin_login` host request
/// runs the full flow (registration happens on the next
/// `register_host_handlers` call, before the session starts). The wire is
/// weak on the manager: a dropped manager fails the request instead of
/// keeping the store alive.
///
/// # Panics
///
/// The wired login panics if the MCP manager mutex is poisoned (a previous
/// login panicked while holding the lock).
pub fn wire_begin_login(
    manager: &Arc<Mutex<McpManager>>,
    ui: Arc<dyn McpLoginUi>,
    http: Arc<dyn OAuthHttp>,
) {
    let weak: Weak<Mutex<McpManager>> = Arc::downgrade(manager);
    let begin_login = move |server: String| {
        let weak = Weak::clone(&weak);
        let ui = Arc::clone(&ui);
        let http = Arc::clone(&http);
        let login = async move {
            let manager = weak
                .upgrade()
                .ok_or_else(|| anyhow!("the MCP manager is no longer running"))?;
            let context = {
                let manager = manager.lock().expect("MCP manager lock poisoned");
                manager.login_context(&server)
            };
            context?.run(ui.as_ref(), http.as_ref()).await?;
            Ok(())
        };
        // The seam hands out a boxed future; the host handler pins it
        // once it takes ownership.
        let boxed: super::BeginLoginFuture = Box::new(login);
        boxed
    };
    let mut manager = manager.lock().expect("MCP manager lock poisoned");
    manager.set_begin_login(Some(Arc::new(begin_login)));
}

/// The OAuth refresh implementation for `mcp:<server>` credentials: the
/// `AuthStorage` expiry path asks the stored endpoint for a fresh token,
/// honoring every binding the login established.
pub struct McpOAuth {
    http: Arc<dyn OAuthHttp>,
}

impl Default for McpOAuth {
    fn default() -> Self {
        Self::new()
    }
}

impl McpOAuth {
    pub fn new() -> Self {
        McpOAuth {
            http: Arc::new(super::ReqwestOAuthHttp::new()),
        }
    }

    /// A fixed transport (tests and embedded hosts).
    pub fn with_http(http: Arc<dyn OAuthHttp>) -> Self {
        McpOAuth { http }
    }
}

impl McpOAuth {
    /// Refresh one provider's credential off the async runtime (the
    /// `AuthStorage` seam is synchronous by contract).
    fn refresh_blocking(
        &self,
        provider_id: &str,
        credentials: &AuthCredential,
    ) -> Option<AuthCredential> {
        let server = provider_id.strip_prefix("mcp:")?.to_string();
        let AuthCredential::Oauth {
            endpoint: Some(endpoint),
            ..
        } = credentials
        else {
            return None;
        };
        let config = McpOAuthConfig {
            server: server.clone(),
            label: server,
            url: endpoint.clone(),
            client_id: None,
            scopes: None,
        };
        let http = Arc::clone(&self.http);
        let credential = credentials.clone();
        // The caller may sit on any thread (a runtime worker, a blocking
        // pool, or no runtime at all), so the refresh runs on its own
        // short-lived thread with a private runtime. Refreshes are rare:
        // token expiry, once per hour at worst.
        let result = std::thread::Builder::new()
            .name("mcp-oauth-refresh".to_string())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .ok()?;
                Some(
                    runtime
                        .block_on(super::oauth::mcp_refresh_token(
                            http.as_ref(),
                            &config,
                            &credential,
                        ))
                        .ok(),
                )
            })
            .ok()?
            .join()
            .ok()??;
        result
    }
}

impl OAuthIntegration for McpOAuth {
    fn api_key_for(&self, _provider: &str, credential: &AuthCredential) -> Option<String> {
        match credential {
            AuthCredential::Oauth { access, .. } => Some(access.clone()),
            AuthCredential::ApiKey { .. } | AuthCredential::McpStaticToken { .. } => None,
        }
    }

    fn refresh(
        &self,
        provider_id: &str,
        credentials: &crate::auth::AuthStorageData,
    ) -> Option<AuthCredential> {
        let credential = credentials.credential(provider_id)?;
        self.refresh_blocking(provider_id, &credential)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::shared::{HostRequestHandlers, HostRequestPayload};
    use crate::mcp::oauth_http::{OAuthHttpResponse, ReqwestOAuthHttp};
    use crate::mcp::{McpManagerOptions, McpServerConfig};
    use serde_json::json;
    use std::collections::HashMap;

    /// A scripted transport (url -> response); unknown urls fail.
    struct ScriptedHttp(HashMap<String, OAuthHttpResponse>);

    impl ScriptedHttp {
        fn new(responses: Vec<(&str, u16, &str)>) -> Self {
            ScriptedHttp(
                responses
                    .into_iter()
                    .map(|(url, status, body)| {
                        (
                            url.to_string(),
                            OAuthHttpResponse {
                                status,
                                headers: vec![(
                                    "content-type".to_string(),
                                    "application/json".to_string(),
                                )],
                                body: body.to_string(),
                            },
                        )
                    })
                    .collect(),
            )
        }
    }

    impl OAuthHttp for ScriptedHttp {
        fn request(
            &self,
            request: super::super::oauth_http::OAuthHttpRequest,
        ) -> futures::future::BoxFuture<'_, Result<OAuthHttpResponse>> {
            Box::pin(async move {
                self.0
                    .get(&request.url)
                    .cloned()
                    .ok_or_else(|| anyhow!("unexpected request: {}", request.url))
            })
        }
    }

    /// A UI that pastes the redirect URL derived from the authorization URL.
    struct PasteUi {
        auth_url: Arc<std::sync::Mutex<String>>,
    }

    impl super::super::oauth::McpLoginUi for PasteUi {
        fn on_progress(&self, _message: &str) {}
        fn on_auth(&self, url: &str, _instructions: &str) {
            *self.auth_url.lock().unwrap() = url.to_string();
        }
        fn on_prompt(
            &self,
            _message: &str,
            _placeholder: &str,
        ) -> std::pin::Pin<Box<dyn futures::Future<Output = Result<String>> + Send>> {
            Box::pin(async { Err(anyhow!("no prompt surface")) })
        }
        fn on_manual_code_input(
            &self,
        ) -> Option<std::pin::Pin<Box<dyn futures::Future<Output = Option<String>> + Send>>>
        {
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

    fn manager(
        agent_dir: &std::path::Path,
        user_servers: Option<HashMap<String, McpServerConfig>>,
        http: Arc<dyn OAuthHttp>,
    ) -> Arc<Mutex<McpManager>> {
        let manager = McpManager::new(McpManagerOptions {
            auth_storage: AuthStorage::create_with_oauth(
                agent_dir,
                Arc::new(McpOAuth::with_http(http)),
            ),
            get_user_servers: Box::new(move || user_servers.clone()),
            begin_login: None,
            agent_dir: None,
            get_catalog_sources: None,
            remote_source: None,
            probe_override: None,
        });
        Arc::new(Mutex::new(manager))
    }

    fn oauth_http_server(url: &'static str) -> McpServerConfig {
        McpServerConfig::Http {
            url: url.to_string(),
            headers: None,
            bearer_token_env_var: None,
            oauth: Some(true),
            enabled: None,
            enabled_tools: None,
            disabled_tools: None,
            startup_timeout_ms: None,
            call_timeout_ms: None,
        }
    }

    /// The fixture server's discovery/registration/token responses (a
    /// plain origin-level authorization server).
    fn fixture_http() -> ScriptedHttp {
        ScriptedHttp::new(vec![
            ("https://fixture.example/mcp", 404, ""),
            (
                "https://fixture.example/.well-known/oauth-protected-resource/mcp",
                404,
                "",
            ),
            (
                "https://fixture.example/.well-known/oauth-authorization-server",
                200,
                r#"{"issuer":"https://fixture.example","authorization_endpoint":"https://fixture.example/authorize","token_endpoint":"https://fixture.example/token","registration_endpoint":"https://fixture.example/register"}"#,
            ),
            (
                "https://fixture.example/register",
                200,
                r#"{"client_id":"fixture-client"}"#,
            ),
            (
                "https://fixture.example/token",
                200,
                r#"{"access_token":"fixture-access","refresh_token":"fixture-refresh","expires_in":3600}"#,
            ),
        ])
    }

    /// `begin_login` -> persisted endpoint-bound credentials -> `is_authed`
    /// -> the server unlocks in the prompt gating.
    #[tokio::test]
    async fn begin_login_persists_creds_and_unlocks_gating() {
        let agent = tempfile::tempdir().unwrap();
        let http = Arc::new(fixture_http());
        let mut user_servers = HashMap::new();
        user_servers.insert(
            "fixture".to_string(),
            oauth_http_server("https://fixture.example/mcp"),
        );
        let manager = manager(agent.path(), Some(user_servers), http);
        let gating_manager = Arc::clone(&manager);
        let before = tokio::task::spawn_blocking(move || {
            gating_manager
                .lock()
                .unwrap()
                .get_enabled_persistent_generic_servers()
        })
        .await
        .unwrap();
        assert!(!before.contains(&"fixture".to_string()));

        // The UI paste surface and the wire: the host wires the login.
        let ui = Arc::new(PasteUi {
            auth_url: Arc::new(std::sync::Mutex::new(String::new())),
        });
        let http = Arc::new(fixture_http());
        wire_begin_login(&manager, ui, http);

        let mut handlers = HostRequestHandlers::default();
        manager
            .lock()
            .unwrap()
            .register_host_handlers(&mut handlers);
        let begin_login = handlers.get("mcp.begin_login").expect("wired").clone();
        begin_login(HostRequestPayload {
            data: json!({ "server": "fixture" }),
            cell_source_code: None,
        })
        .await
        .unwrap();

        // The credential persisted to auth.json (the kernel reads the same
        // file), endpoint-bound like the TS shape.
        let auth: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(agent.path().join("auth.json")).unwrap())
                .unwrap();
        let credential = &auth["mcp:fixture"];
        assert_eq!(credential["type"], "oauth");
        assert_eq!(credential["access"], "fixture-access");
        assert_eq!(credential["refresh"], "fixture-refresh");
        assert_eq!(credential["endpoint"], "https://fixture.example/mcp");
        assert_eq!(credential["tokenEndpoint"], "https://fixture.example/token");
        assert_eq!(credential["clientId"], "fixture-client");
        assert!(credential.get("resource").is_none());
        assert!(credential["expires"].as_i64().unwrap() > 0);

        // Gating flips: the server enables through the generic API.
        let gating_manager = Arc::clone(&manager);
        let after = tokio::task::spawn_blocking(move || {
            let manager = gating_manager.lock().unwrap();
            (
                manager.get_enabled_persistent_generic_servers(),
                manager
                    .list_status()
                    .into_iter()
                    .find(|row| row.server == "fixture")
                    .unwrap(),
            )
        })
        .await
        .unwrap();
        assert_eq!(after.0, vec!["fixture".to_string()]);
        assert!(after.1.enabled);
        assert!(after.1.uses_oauth);
    }

    /// The builtin linear integration: `begin_login` removes its skill
    /// override; notion stays disabled.
    #[tokio::test]
    async fn begin_login_unlocks_builtin_skill_gating() {
        let agent = tempfile::tempdir().unwrap();
        let http = Arc::new(ScriptedHttp::new(vec![
            ("https://mcp.linear.app/mcp", 404, ""),
            (
                "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp",
                404,
                "",
            ),
            (
                "https://mcp.linear.app/.well-known/oauth-authorization-server",
                200,
                r#"{"issuer":"https://mcp.linear.app","authorization_endpoint":"https://mcp.linear.app/authorize","token_endpoint":"https://mcp.linear.app/token","registration_endpoint":"https://mcp.linear.app/register"}"#,
            ),
            (
                "https://mcp.linear.app/register",
                200,
                r#"{"client_id":"linear-client"}"#,
            ),
            (
                "https://mcp.linear.app/token",
                200,
                r#"{"access_token":"linear-access","expires_in":3600}"#,
            ),
        ]));
        let manager = manager(agent.path(), None, Arc::clone(&http) as Arc<dyn OAuthHttp>);
        let gating_manager = Arc::clone(&manager);
        let before = tokio::task::spawn_blocking(move || {
            gating_manager
                .lock()
                .unwrap()
                .get_disabled_builtin_skill_overrides()
        })
        .await
        .unwrap();
        assert_eq!(
            before,
            vec![
                "-linear/SKILL.md".to_string(),
                "-notion/SKILL.md".to_string()
            ]
        );

        let ui = Arc::new(PasteUi {
            auth_url: Arc::new(std::sync::Mutex::new(String::new())),
        });
        wire_begin_login(&manager, ui, http);
        let mut handlers = HostRequestHandlers::default();
        manager
            .lock()
            .unwrap()
            .register_host_handlers(&mut handlers);
        let begin_login = handlers.get("mcp.begin_login").expect("wired").clone();
        begin_login(HostRequestPayload {
            data: json!({ "server": "linear" }),
            cell_source_code: None,
        })
        .await
        .unwrap();
        // Only notion stays gated.
        let gating_manager = Arc::clone(&manager);
        let after = tokio::task::spawn_blocking(move || {
            gating_manager
                .lock()
                .unwrap()
                .get_disabled_builtin_skill_overrides()
        })
        .await
        .unwrap();
        assert_eq!(after, vec!["-notion/SKILL.md".to_string()]);
    }

    /// Unknown servers and non-OAuth servers error with the TS wording;
    /// the handler surfaces it to the kernel.
    #[tokio::test]
    async fn begin_login_rejects_unknown_servers() {
        let agent = tempfile::tempdir().unwrap();
        let http = Arc::new(ReqwestOAuthHttp::new()) as Arc<dyn OAuthHttp>;
        let manager = manager(agent.path(), None, http.clone());
        let ui = Arc::new(PasteUi {
            auth_url: Arc::new(std::sync::Mutex::new(String::new())),
        });
        wire_begin_login(&manager, ui, http);
        let mut handlers = HostRequestHandlers::default();
        manager
            .lock()
            .unwrap()
            .register_host_handlers(&mut handlers);
        let begin_login = handlers.get("mcp.begin_login").expect("wired").clone();
        let error = begin_login(HostRequestPayload {
            data: json!({ "server": "nope" }),
            cell_source_code: None,
        })
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(error, "Unknown MCP integration: nope");
        let error = begin_login(HostRequestPayload {
            data: json!({}),
            cell_source_code: None,
        })
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(error, "mcp.begin_login requires a server");
    }

    /// Expired credentials refresh through the `AuthStorage` seam: the
    /// stored endpoint answers a `refresh_token` grant, and the new
    /// credential keeps every binding.
    #[tokio::test]
    async fn mcp_oauth_refreshes_expired_credentials() {
        let agent = tempfile::tempdir().unwrap();
        let http = Arc::new(fixture_http());
        let mut auth =
            AuthStorage::create_with_oauth(agent.path(), Arc::new(McpOAuth::with_http(http)));
        auth.set(
            "mcp:fixture",
            AuthCredential::Oauth {
                access: "stale".to_string(),
                refresh: Some("fixture-refresh".to_string()),
                // Expired: resolution must refresh.
                expires: 1,
                account_id: None,
                endpoint: Some("https://fixture.example/mcp".to_string()),
                token_endpoint: Some("https://fixture.example/token".to_string()),
                client_id: Some("fixture-client".to_string()),
                resource: None,
                issuer: None,
                enterprise_url: None,
            },
        );
        let api_key = auth.get_api_key("mcp:fixture");
        assert_eq!(api_key.as_deref(), Some("fixture-access"));
        let api_key = api_key.unwrap();
        assert_eq!(api_key, "fixture-access");
        // The refreshed credential persists and keeps the prior refresh
        // token (the fixture token response omits one).
        let stored = auth.get_all().get("mcp:fixture").cloned().unwrap();
        assert_eq!(stored["access"], "fixture-access");
        assert_eq!(stored["refresh"], "fixture-refresh");
        assert_eq!(stored["endpoint"], "https://fixture.example/mcp");
        // A later resolution serves the fresh token without network.
        assert_eq!(auth.get_api_key("mcp:fixture").unwrap(), "fixture-access");
    }

    /// A credential written by another process (the interactive client's
    /// `/mcp login` shares only the file) is visible to the worker's
    /// `mcp.refresh`: the handler re-reads the store instead of serving
    /// the manager's pre-login snapshot.
    #[tokio::test]
    async fn refresh_sees_credentials_written_by_another_process() {
        let agent = tempfile::tempdir().unwrap();
        let http = Arc::new(fixture_http());
        let manager = manager(agent.path(), None, http);
        let mut handlers = HostRequestHandlers::default();
        manager
            .lock()
            .unwrap()
            .register_host_handlers(&mut handlers);
        let refresh = handlers.get("mcp.refresh").expect("wired").clone();
        let error = refresh(HostRequestPayload {
            data: json!({ "server": "fixture" }),
            cell_source_code: None,
        })
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(error, "Could not refresh credentials for fixture");

        // The external write (a second store instance over the same
        // file): a fresh, endpoint-bound credential.
        let mut external = AuthStorage::create(agent.path());
        external.set(
            "mcp:fixture",
            AuthCredential::Oauth {
                access: "fixture-access".to_string(),
                refresh: Some("fixture-refresh".to_string()),
                expires: i64::MAX,
                account_id: None,
                endpoint: Some("https://fixture.example/mcp".to_string()),
                token_endpoint: Some("https://fixture.example/token".to_string()),
                client_id: Some("fixture-client".to_string()),
                resource: None,
                issuer: None,
                enterprise_url: None,
            },
        );

        refresh(HostRequestPayload {
            data: json!({ "server": "fixture" }),
            cell_source_code: None,
        })
        .await
        .unwrap();
    }

    /// mcp.refresh refuses ACP-admitted servers with the TS wording.
    #[tokio::test]
    async fn mcp_refresh_rejects_acp_servers() {
        let agent = tempfile::tempdir().unwrap();
        let http = Arc::new(ReqwestOAuthHttp::new()) as Arc<dyn OAuthHttp>;
        let manager = manager(agent.path(), None, http);
        manager
            .lock()
            .unwrap()
            .replace_acp_servers(
                &[super::super::AcpMcpServerConfig::Http {
                    name: "session-tool".to_string(),
                    url: "https://acp.example/mcp".to_string(),
                    headers: HashMap::new(),
                }],
                "client-a",
            )
            .unwrap();
        let mut handlers = HostRequestHandlers::default();
        manager
            .lock()
            .unwrap()
            .register_host_handlers(&mut handlers);
        let refresh = handlers.get("mcp.refresh").expect("wired").clone();
        let error = refresh(HostRequestPayload {
            data: json!({ "server": "session-tool" }),
            cell_source_code: None,
        })
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(error, "ACP MCP server session-tool does not use host OAuth");
    }
}
