//! Login execution for MCP integrations: resolve a server's OAuth setup, run
//! the interactive flow, persist the endpoint-bound credential, and wire the
//! `mcp.begin_login` host request in product paths.

use std::sync::{Arc, Mutex, Weak};

use anyhow::{anyhow, Context as _, Result};

use crate::auth::types::AuthCredential;
use crate::auth::{AuthStorage, OAuthIntegration};

use super::oauth::{mcp_login, McpLoginUi, McpOAuthConfig};
use super::oauth_http::OAuthHttp;
use super::{McpManager, McpServerConfig, UserServersFn};

/// One server's login execution: the resolved OAuth config plus the auth store. Detached from the
/// manager on purpose — the flow awaits UI input, so no manager lock may be held across it.
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
    /// Returns an error when the OAuth login flow fails or saving the
    /// credential fails.
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
        let McpServerConfig::Http {
            url,
            client_id,
            callback_port,
            client_secret,
            scopes,
            ..
        } = &integration.config
        else {
            unreachable!("uses_oauth implies an http config");
        };
        // Slack defaults follow the endpoint; explicit user settings take precedence.
        let slack = url == "https://mcp.slack.com/mcp";
        Some(McpOAuthConfig {
            server: integration.server.clone(),
            label: integration.label.clone(),
            url: url.clone(),
            client_id: client_id
                .clone()
                .or_else(|| slack.then(|| "1601185624273.8899143856786".to_string())),
            callback_port: (*callback_port).or(slack.then_some(3118)),
            client_secret: client_secret.clone(),
            scopes: scopes.clone(),
        })
    }

    /// The execution context for one login: resolve the config, detach the auth
    /// store handle. Unknown and non-OAuth servers error with the TS wording.
    ///
    /// # Errors
    ///
    /// Returns an error when the server is not a known MCP integration or does
    /// not use OAuth.
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

/// Wire a login UI into the manager so its `mcp.begin_login` host request runs the full flow. The
/// wire is weak on the manager: a dropped manager fails the request instead of keeping the store
/// alive.
///
/// # Panics
///
/// The wired login panics if the MCP manager mutex is poisoned.
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

/// The OAuth refresh implementation for `mcp:<server>` credentials: the `AuthStorage` expiry path
/// asks the stored endpoint for a fresh token.
pub struct McpOAuth {
    http: Arc<dyn OAuthHttp>,
    /// Reads `mcpServers`: a configured `clientSecret` stays in settings, never in the credential.
    user_servers: UserServersFn,
}

impl McpOAuth {
    #[must_use]
    pub fn new(user_servers: UserServersFn) -> Self {
        Self::with_http(Arc::new(super::ReqwestOAuthHttp::new()), user_servers)
    }

    /// A fixed transport (tests and embedded hosts).
    pub fn with_http(http: Arc<dyn OAuthHttp>, user_servers: UserServersFn) -> Self {
        McpOAuth { http, user_servers }
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
        // Only the server entry the credential was issued for may lend its secret.
        let client_secret = (self.user_servers)()
            .and_then(|mut servers| servers.remove(&server))
            .and_then(|config| match config {
                McpServerConfig::Http {
                    url, client_secret, ..
                } if url == *endpoint => client_secret,
                McpServerConfig::Http { .. } | McpServerConfig::Stdio { .. } => None,
            });
        let config = McpOAuthConfig {
            server: server.clone(),
            label: server,
            url: endpoint.clone(),
            client_id: None,
            callback_port: None,
            client_secret,
            scopes: None,
        };
        let http = Arc::clone(&self.http);
        let credential = credentials.clone();
        // The caller may sit on any thread (a runtime worker, a blocking pool, or no runtime at
        // all), so the refresh runs on its own short-lived thread with a private runtime.
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

    /// A scripted transport (url -> response) that records request bodies; unknown urls fail.
    struct ScriptedHttp {
        responses: HashMap<String, OAuthHttpResponse>,
        bodies: Mutex<Vec<(String, Option<String>)>>,
    }

    impl ScriptedHttp {
        fn new(responses: Vec<(&str, u16, &str)>) -> Self {
            ScriptedHttp {
                responses: responses
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
                bodies: Mutex::default(),
            }
        }
    }

    impl OAuthHttp for ScriptedHttp {
        fn request(
            &self,
            request: super::super::oauth_http::OAuthHttpRequest,
        ) -> futures::future::BoxFuture<'_, Result<OAuthHttpResponse>> {
            Box::pin(async move {
                self.bodies
                    .lock()
                    .unwrap()
                    .push((request.url.clone(), request.body.clone()));
                self.responses
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
        let user_servers: UserServersFn = Arc::new(move || user_servers.clone());
        let manager = McpManager::new(McpManagerOptions {
            auth_storage: AuthStorage::create_with_oauth(
                agent_dir,
                Arc::new(McpOAuth::with_http(http, Arc::clone(&user_servers))),
            ),
            get_user_servers: Box::new(move || user_servers()),
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
            client_id: None,
            callback_port: None,
            client_secret: None,
            scopes: None,
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

    #[test]
    fn oauth_config_threads_client_id_and_callback_port() {
        for endpoint in ["https://fixture.example/mcp", "https://mcp.slack.com/mcp"] {
            let agent = tempfile::tempdir().unwrap();
            let user_servers: HashMap<String, McpServerConfig> = serde_json::from_value(json!({
                "slack": {
                    "type": "http",
                    "url": endpoint,
                    "oauth": true,
                    "clientId": "custom-client",
                    "callbackPort": 4567
                }
            }))
            .unwrap();
            let http = Arc::new(fixture_http());
            let manager = manager(agent.path(), Some(user_servers), http);
            let config = manager.lock().unwrap().oauth_config("slack").unwrap();
            assert_eq!(config.client_id.as_deref(), Some("custom-client"));
            assert_eq!(config.callback_port, Some(4567));
        }
    }

    /// Slack has no DCR; drive its public desktop client through the real manager and auth store.
    #[tokio::test]
    async fn slack_login_persists_refreshes_and_can_login_again() {
        struct SlackHttp {
            responses: ScriptedHttp,
            seen: Mutex<Vec<super::super::OAuthHttpRequest>>,
        }
        impl OAuthHttp for SlackHttp {
            fn request(
                &self,
                request: super::super::OAuthHttpRequest,
            ) -> futures::future::BoxFuture<'_, Result<OAuthHttpResponse>> {
                self.seen.lock().unwrap().push(request.clone());
                let response = self.responses.request(request);
                Box::pin(async move {
                    let mut response = response.await?;
                    if response.status == 401 {
                        response.headers.push(("www-authenticate".to_string(),
                            "Bearer resource_metadata=\"https://mcp.slack.com/.well-known/oauth-protected-resource\"".to_string()));
                    }
                    Ok(response)
                })
            }
        }
        let http = Arc::new(SlackHttp {
            responses: ScriptedHttp::new(vec![
                ("https://mcp.slack.com/mcp", 401, ""),
                (
                    "https://mcp.slack.com/.well-known/oauth-protected-resource",
                    200,
                    r#"{"resource":"https://mcp.slack.com","authorization_servers":["https://mcp.slack.com"],"scopes_supported":["search:read.public","channels:history","chat:write"]}"#,
                ),
                (
                    "https://mcp.slack.com/.well-known/oauth-authorization-server",
                    200,
                    r#"{"issuer":"https://mcp.slack.com","authorization_endpoint":"https://slack.com/oauth/v2_user/authorize","token_endpoint":"https://slack.com/api/oauth.v2.user.access","code_challenge_methods_supported":["S256"]}"#,
                ),
                (
                    "https://slack.com/api/oauth.v2.user.access",
                    200,
                    r#"{"ok":true,"access_token":"slack-access","refresh_token":"slack-refresh","expires_in":43200}"#,
                ),
            ]),
            seen: Mutex::default(),
        });
        let agent = tempfile::tempdir().unwrap();
        let manager = manager(agent.path(), None, http.clone());
        let ui = PasteUi {
            auth_url: Arc::default(),
        };
        for _ in 0..2 {
            let context = manager.lock().unwrap().login_context("slack").unwrap();
            let credential = context.run(&ui, http.as_ref()).await.unwrap();
            let auth_url = url::Url::parse(&ui.auth_url.lock().unwrap()).unwrap();
            let params: HashMap<_, _> = auth_url.query_pairs().into_owned().collect();
            assert_eq!(params["client_id"], "1601185624273.8899143856786");
            assert_eq!(params["redirect_uri"], "http://localhost:3118/callback");
            assert_eq!(params["code_challenge_method"], "S256");
            assert!(!params["state"].is_empty());
            assert!(!params["code_challenge"].is_empty());

            let config = manager.lock().unwrap().oauth_config("slack").unwrap();
            let refreshed = super::super::mcp_refresh_token(http.as_ref(), &config, &credential)
                .await
                .unwrap();
            let mut refreshed = serde_json::to_value(refreshed).unwrap();
            let mut original = serde_json::to_value(&credential).unwrap();
            refreshed.as_object_mut().unwrap().remove("expires");
            original.as_object_mut().unwrap().remove("expires");
            assert_eq!(refreshed, original);
            let stored: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(agent.path().join("auth.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(
                stored["mcp:slack"],
                serde_json::to_value(&credential).unwrap()
            );
        }
        let requests = http.seen.lock().unwrap().clone();
        let tokens: Vec<_> = requests
            .iter()
            .filter(|request| request.url == "https://slack.com/api/oauth.v2.user.access")
            .map(|request| {
                url::form_urlencoded::parse(request.body.as_ref().unwrap().as_bytes())
                    .into_owned()
                    .collect::<HashMap<_, _>>()
            })
            .collect();
        assert_eq!(tokens.len(), 4);
        for token in &tokens {
            assert_eq!(token["client_id"], "1601185624273.8899143856786");
            assert_eq!(token["resource"], "https://mcp.slack.com");
            if token["grant_type"] == "authorization_code" {
                assert_eq!(token["redirect_uri"], "http://localhost:3118/callback");
                assert_eq!(token["code"], "the-code");
                assert!(!token["code_verifier"].is_empty());
            } else {
                assert_eq!(token["refresh_token"], "slack-refresh");
            }
        }
        let gating_manager = Arc::clone(&manager);
        let enabled = tokio::task::spawn_blocking(move || {
            gating_manager
                .lock()
                .unwrap()
                .get_enabled_persistent_generic_servers()
        })
        .await
        .unwrap();
        assert!(enabled.contains(&"slack".to_string()));
    }

    /// Google Workspace MCP (live metadata captured 2026-10-19: a trailing-slash PRM issuer, no
    /// registration endpoint) with a user-registered confidential client from `mcpServers`.
    #[tokio::test]
    async fn google_workspace_login_and_refresh_use_the_configured_client() {
        const SHEETS: &str = "https://sheetsmcp.googleapis.com/mcp/v1";
        const TOKEN: &str = "https://oauth2.googleapis.com/token";
        const SCOPES: &str = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets";
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let http = Arc::new(ScriptedHttp::new(vec![
            (SHEETS, 405, ""),
            (
                "https://sheetsmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1",
                200,
                r#"{"authorization_servers":["https://accounts.google.com/"],"bearer_methods_supported":["header"],"resource":"https://sheetsmcp.googleapis.com/mcp/v1","scopes_supported":["https://www.googleapis.com/auth/drive.readonly","https://www.googleapis.com/auth/spreadsheets.readonly","https://www.googleapis.com/auth/drive","https://www.googleapis.com/auth/spreadsheets"]}"#,
            ),
            (
                "https://accounts.google.com/.well-known/oauth-authorization-server",
                200,
                r#"{"issuer":"https://accounts.google.com","authorization_endpoint":"https://accounts.google.com/o/oauth2/v2/auth","token_endpoint":"https://oauth2.googleapis.com/token","token_endpoint_auth_methods_supported":["client_secret_post","client_secret_basic"],"code_challenge_methods_supported":["plain","S256"]}"#,
            ),
            // expires_in equals the expiry buffer, so the stored token is due for refresh at once.
            (
                TOKEN,
                200,
                r#"{"access_token":"google-access","refresh_token":"google-refresh","expires_in":300}"#,
            ),
        ]));
        let user_servers = serde_json::from_value(json!({ "sheets": {
            "type": "http", "url": SHEETS, "oauth": true, "callbackPort": port, "scopes": SCOPES,
            "clientId": "byo.apps.googleusercontent.com", "clientSecret": "byo-secret"
        }}))
        .unwrap();
        let agent = tempfile::tempdir().unwrap();
        let manager = manager(agent.path(), Some(user_servers), http.clone());
        let ui = PasteUi {
            auth_url: Arc::default(),
        };
        let context = manager.lock().unwrap().login_context("sheets").unwrap();
        context.run(&ui, http.as_ref()).await.unwrap();
        let mut handlers = HostRequestHandlers::default();
        McpManager::register_host_handlers(&manager, &mut handlers);
        let refresh = handlers.get("mcp.refresh").expect("wired").clone();
        refresh(HostRequestPayload {
            data: json!({ "server": "sheets" }),
        })
        .await
        .unwrap();

        let pairs = |entries: &[(&str, &str)]| -> HashMap<String, String> {
            entries
                .iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                .collect()
        };
        let redirect_uri = format!("http://localhost:{port}/callback");
        let mut authorize: HashMap<String, String> = url::Url::parse(&ui.auth_url.lock().unwrap())
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect();
        authorize.remove("state");
        authorize.remove("code_challenge");
        assert_eq!(
            authorize,
            pairs(&[
                ("client_id", "byo.apps.googleusercontent.com"),
                ("response_type", "code"),
                ("redirect_uri", redirect_uri.as_str()),
                ("code_challenge_method", "S256"),
                ("scope", SCOPES),
                ("resource", SHEETS),
                ("access_type", "offline"),
                ("prompt", "consent"),
            ])
        );
        let mut tokens: Vec<HashMap<String, String>> = http
            .bodies
            .lock()
            .unwrap()
            .iter()
            .filter(|(url, _)| url == TOKEN)
            .map(|(_, body)| {
                url::form_urlencoded::parse(body.as_deref().unwrap().as_bytes())
                    .into_owned()
                    .collect()
            })
            .collect();
        tokens[0].remove("code_verifier");
        assert_eq!(
            tokens,
            vec![
                pairs(&[
                    ("grant_type", "authorization_code"),
                    ("code", "the-code"),
                    ("redirect_uri", redirect_uri.as_str()),
                    ("client_id", "byo.apps.googleusercontent.com"),
                    ("client_secret", "byo-secret"),
                    ("resource", SHEETS),
                ]),
                pairs(&[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", "google-refresh"),
                    ("client_id", "byo.apps.googleusercontent.com"),
                    ("client_secret", "byo-secret"),
                    ("resource", SHEETS),
                ]),
            ]
        );
    }

    #[test]
    fn registered_oauth_client_follows_endpoint_instead_of_connection_name() {
        let agent = tempfile::tempdir().unwrap();
        let user_servers = HashMap::from([
            (
                "slack".to_string(),
                oauth_http_server("https://other.example/mcp"),
            ),
            (
                "team-chat".to_string(),
                oauth_http_server("https://mcp.slack.com/mcp"),
            ),
        ]);
        let manager = manager(agent.path(), Some(user_servers), Arc::new(fixture_http()));
        let manager = manager.lock().unwrap();
        let impostor = manager.oauth_config("slack").unwrap();
        assert_eq!((impostor.client_id, impostor.callback_port), (None, None));
        let alias = manager.oauth_config("team-chat").unwrap();
        assert_eq!(
            (alias.client_id.as_deref(), alias.callback_port),
            (Some("1601185624273.8899143856786"), Some(3118)),
        );
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
        McpManager::register_host_handlers(&manager, &mut handlers);
        let begin_login = handlers.get("mcp.begin_login").expect("wired").clone();
        begin_login(HostRequestPayload {
            data: json!({ "server": "fixture" }),
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
        McpManager::register_host_handlers(&manager, &mut handlers);
        let begin_login = handlers.get("mcp.begin_login").expect("wired").clone();
        begin_login(HostRequestPayload {
            data: json!({ "server": "linear" }),
        })
        .await
        .unwrap();
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
        McpManager::register_host_handlers(&manager, &mut handlers);
        let begin_login = handlers.get("mcp.begin_login").expect("wired").clone();
        let error = begin_login(HostRequestPayload {
            data: json!({ "server": "nope" }),
        })
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(error, "Unknown MCP integration: nope");
        let error = begin_login(HostRequestPayload { data: json!({}) })
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(error, "mcp.begin_login requires a server");
    }

    /// Expired credentials refresh through the `AuthStorage` seam: the stored endpoint answers a
    /// `refresh_token` grant.
    #[tokio::test]
    async fn mcp_oauth_refreshes_expired_credentials() {
        let agent = tempfile::tempdir().unwrap();
        let http = Arc::new(fixture_http());
        let mut auth = AuthStorage::create_with_oauth(
            agent.path(),
            Arc::new(McpOAuth::with_http(http, Arc::new(|| None))),
        );
        auth.set(
            "mcp:fixture",
            AuthCredential::Oauth {
                access: "stale".to_string(),
                refresh: Some("fixture-refresh".to_string()),
                expires: 1,
                account_id: None,
                endpoint: Some("https://fixture.example/mcp".to_string()),
                token_endpoint: Some("https://fixture.example/token".to_string()),
                client_id: Some("fixture-client".to_string()),
                resource: None,
                issuer: None,
                audience_mode: None,
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

    /// A credential written by another process is visible to the worker's `mcp.refresh`:.
    #[tokio::test]
    async fn refresh_sees_credentials_written_by_another_process() {
        let agent = tempfile::tempdir().unwrap();
        let http = Arc::new(fixture_http());
        let manager = manager(agent.path(), None, http);
        let mut handlers = HostRequestHandlers::default();
        McpManager::register_host_handlers(&manager, &mut handlers);
        let refresh = handlers.get("mcp.refresh").expect("wired").clone();
        let error = refresh(HostRequestPayload {
            data: json!({ "server": "fixture" }),
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
                audience_mode: None,
                enterprise_url: None,
            },
        );

        refresh(HostRequestPayload {
            data: json!({ "server": "fixture" }),
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
        McpManager::register_host_handlers(&manager, &mut handlers);
        let refresh = handlers.get("mcp.refresh").expect("wired").clone();
        let error = refresh(HostRequestPayload {
            data: json!({ "server": "session-tool" }),
        })
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(error, "ACP MCP server session-tool does not use host OAuth");
    }
}
