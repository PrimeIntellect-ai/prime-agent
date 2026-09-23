//! The daemon worker's MCP login surface behind the `mcp.begin_login` host
//! request: browser + local callback only. The worker is detached from any
//! terminal, so the paste path stays closed here; the interactive client
//! surfaces its own login (`/mcp login`) with a paste fallback, and both
//! persist to the same `auth.json`.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Result};

use pa_core::mcp::{McpLoginUi, McpManager};

/// The environment path (when set) that additionally records each
/// authorization URL. Headless verification drives the browser step from
/// it; the product leaves it unset.
const AUTH_URL_FILE_ENV: &str = "PA_MCP_LOGIN_URL_FILE";

/// Browser + callback login UI for daemon workers.
pub struct WorkerMcpLoginUi {
    auth_url_file: Option<PathBuf>,
}

impl WorkerMcpLoginUi {
    /// The product UI. `PA_MCP_LOGIN_URL_FILE` (when set in the inherited
    /// environment) records authorization URLs for headless verification.
    pub fn from_env() -> Self {
        WorkerMcpLoginUi {
            auth_url_file: std::env::var_os(AUTH_URL_FILE_ENV).map(PathBuf::from),
        }
    }

    /// An explicit URL record path (tests).
    pub fn with_auth_url_file(path: Option<PathBuf>) -> Self {
        WorkerMcpLoginUi {
            auth_url_file: path,
        }
    }
}

impl McpLoginUi for WorkerMcpLoginUi {
    fn on_progress(&self, message: &str) {
        eprintln!("pa-daemon: MCP login: {message}");
    }

    fn on_auth(&self, url: &str, instructions: &str) {
        // The browser is the interface (the TS dialog tries the same
        // fire-and-forget launch and keeps showing the URL on failure).
        pa_core::platform::browser::open_in_browser(url);
        eprintln!("pa-daemon: MCP login: {url} — {instructions}");
        if let Some(path) = &self.auth_url_file {
            if let Err(error) = std::fs::write(path, url) {
                eprintln!(
                    "pa-daemon: MCP login could not record the authorization URL at {}: {error}",
                    path.display()
                );
            }
        }
    }

    fn on_prompt(
        &self,
        _message: &str,
        _placeholder: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send>> {
        // No prompt surface in the worker: this path only runs when the
        // callback settled without a code, so the login is over.
        Box::pin(async { Err(anyhow!("Login cancelled")) })
    }

    fn on_manual_code_input(
        &self,
    ) -> Option<std::pin::Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>>> {
        None
    }
}

/// Wire the worker login into a manager so its `mcp.begin_login` host
/// request runs the full OAuth flow. Call before the session registers
/// host handlers. The worker passes its browser UI; tests inject a
/// capture-only UI through the same seam.
pub fn wire_worker_mcp_login(
    manager: &Arc<std::sync::Mutex<McpManager>>,
    ui: Arc<dyn McpLoginUi>,
    http: Arc<dyn pa_core::mcp::OAuthHttp>,
) {
    pa_core::mcp::wire_begin_login(manager, ui, http);
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use pa_core::auth::{AuthCredential, AuthStorage};
    use pa_core::kernel::shared::{HostRequestHandlers, HostRequestPayload};
    use pa_core::mcp::{McpManager, McpManagerOptions, McpServerConfig, OAuthHttpResponse};
    use serde_json::json;
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    /// A scripted transport (exact URL -> response); unknown URLs fail so
    /// the flow cannot silently talk to the network.
    struct ScriptedHttp(HashMap<String, OAuthHttpResponse>);

    impl ScriptedHttp {
        fn fixture() -> Self {
            let entry = |status: u16, body: &str| OAuthHttpResponse {
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

    impl pa_core::mcp::OAuthHttp for ScriptedHttp {
        fn request(
            &self,
            request: pa_core::mcp::OAuthHttpRequest,
        ) -> futures::future::BoxFuture<'_, Result<OAuthHttpResponse>> {
            Box::pin(async move {
                self.0
                    .get(&request.url)
                    .cloned()
                    .ok_or_else(|| anyhow!("unexpected request: {}", request.url))
            })
        }
    }

    /// The test login surface (the TS tests' capture-only `onAuth`): every
    /// progress message and authorization URL lands in the record, and
    /// nothing ever drives the platform browser — no test may open a real
    /// one. The paste contract matches the worker's: no manual channel,
    /// the fallback prompt refuses.
    struct RecordingLoginUi {
        auth_url_file: Option<PathBuf>,
        progress: Arc<std::sync::Mutex<Vec<String>>>,
        auth_urls: Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl RecordingLoginUi {
        fn new(auth_url_file: Option<PathBuf>) -> Self {
            RecordingLoginUi {
                auth_url_file,
                progress: Arc::new(std::sync::Mutex::new(Vec::new())),
                auth_urls: Arc::new(std::sync::Mutex::new(Vec::new())),
            }
        }
    }

    impl McpLoginUi for RecordingLoginUi {
        fn on_progress(&self, message: &str) {
            self.progress.lock().unwrap().push(message.to_string());
        }

        fn on_auth(&self, url: &str, _instructions: &str) {
            self.auth_urls.lock().unwrap().push(url.to_string());
            if let Some(path) = &self.auth_url_file {
                if let Err(error) = std::fs::write(path, url) {
                    eprintln!(
                        "test MCP login could not record the authorization URL at {}: {error}",
                        path.display()
                    );
                }
            }
        }

        fn on_prompt(
            &self,
            _message: &str,
            _placeholder: &str,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send>> {
            Box::pin(async { Err(anyhow!("Login cancelled")) })
        }

        fn on_manual_code_input(
            &self,
        ) -> Option<std::pin::Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>>>
        {
            None
        }
    }

    /// The fixture OAuth server's discovery/registration/token responses
    /// answer through the scripted transport; the capture-only test UI
    /// records the authorization URL without a browser launch (the real
    /// callback listener catches the simulated redirect).
    #[tokio::test]
    async fn worker_begin_login_persists_creds_and_unlocks_gating() -> Result<()> {
        let agent = tempfile::tempdir()?;
        let url_file = agent.path().join("auth-url.txt");
        let http = Arc::new(ScriptedHttp::fixture());

        let mut user_servers = HashMap::new();
        user_servers.insert(
            "fixture".to_string(),
            McpServerConfig::Http {
                url: "https://fixture.example/mcp".to_string(),
                headers: None,
                bearer_token_env_var: None,
                oauth: Some(true),
                enabled: None,
                enabled_tools: None,
                disabled_tools: None,
                startup_timeout_ms: None,
                call_timeout_ms: None,
            },
        );
        let manager = McpManager::new(McpManagerOptions {
            auth_storage: AuthStorage::create_with_oauth(
                agent.path(),
                Arc::new(pa_core::mcp::McpOAuth::with_http(
                    Arc::clone(&http) as Arc<dyn pa_core::mcp::OAuthHttp>
                )),
            ),
            get_user_servers: Box::new(move || Some(user_servers.clone())),
            begin_login: None,
            agent_dir: None,
            get_catalog_sources: None,
            remote_source: None,
            probe_override: None,
        });
        let manager = Arc::new(std::sync::Mutex::new(manager));
        // Gating snapshots take the auth-store's blocking lock (the
        // session engine runs them off the async runtime; same here).
        let gated = tokio::task::spawn_blocking({
            let manager = Arc::clone(&manager);
            move || {
                manager
                    .lock()
                    .unwrap()
                    .get_enabled_persistent_generic_servers()
            }
        })
        .await?;
        assert!(
            gated.is_empty(),
            "the fixture server starts gated without credentials"
        );

        // The exact wiring the worker engine applies, with the
        // capture-only test UI standing in for the browser surface.
        let ui = Arc::new(RecordingLoginUi::new(Some(url_file.clone())));
        wire_worker_mcp_login(
            &manager,
            Arc::clone(&ui) as Arc<dyn McpLoginUi>,
            Arc::clone(&http) as Arc<dyn pa_core::mcp::OAuthHttp>,
        );
        let mut handlers = HostRequestHandlers::default();
        manager
            .lock()
            .unwrap()
            .register_host_handlers(&mut handlers);
        let begin_login = handlers.get("mcp.begin_login").expect("wired").clone();

        let login = tokio::spawn(async move {
            begin_login(HostRequestPayload {
                data: json!({ "server": "fixture" }),
                cell_source_code: None,
            })
            .await
        });

        // The browser step: the recorded authorization URL carries the
        // redirect URI and the state the callback must echo.
        let url = {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Ok(content) = std::fs::read_to_string(&url_file) {
                    break content;
                }
                assert!(
                    Instant::now() < deadline,
                    "the login never recorded its authorization URL"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        let parsed = url::Url::parse(&url)?;
        let query: HashMap<String, String> = parsed
            .query_pairs()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        let redirect = query.get("redirect_uri").expect("redirect_uri").clone();
        let state = query.get("state").expect("state").clone();

        // The simulated browser redirect lands on the real callback server.
        let mut stream = tokio::net::TcpStream::connect(
            redirect
                .trim_start_matches("http://")
                .trim_end_matches("/callback")
                .to_string(),
        )
        .await?;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        stream
            .write_all(
                format!("GET /callback?code=fixture-code&state={state} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await?;
        let mut sink = Vec::new();
        let _ = stream.read_to_end(&mut sink).await;

        login.await??;

        // The authorization surface was captured, never launched: the
        // flow narrated through the UI and produced exactly the one URL
        // the callback drive consumed.
        assert!(
            !ui.progress.lock().unwrap().is_empty(),
            "the login narrated its steps through the UI"
        );
        let auth_urls = ui.auth_urls.lock().unwrap();
        assert_eq!(
            auth_urls.len(),
            1,
            "one authorization URL, one browser launch"
        );
        assert_eq!(auth_urls[0], url);

        // The credential persisted (endpoint-bound, TS McpCredentials shape).
        let auth: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(agent.path().join("auth.json"))?)?;
        assert_eq!(auth["mcp:fixture"]["type"], "oauth");
        assert_eq!(auth["mcp:fixture"]["access"], "fixture-access");
        assert_eq!(auth["mcp:fixture"]["refresh"], "fixture-refresh");
        assert_eq!(
            auth["mcp:fixture"]["endpoint"],
            "https://fixture.example/mcp"
        );
        assert_eq!(
            auth["mcp:fixture"]["tokenEndpoint"],
            "https://fixture.example/token"
        );
        assert_eq!(auth["mcp:fixture"]["clientId"], "fixture-client");

        // Gating unlocks through the same manager the worker shares with
        // the session engine's prompt build.
        let (gated, status) = tokio::task::spawn_blocking(move || {
            let manager = manager.lock().unwrap();
            (
                manager.get_enabled_persistent_generic_servers(),
                manager
                    .list_status()
                    .into_iter()
                    .find(|row| row.server == "fixture")
                    .expect("status row"),
            )
        })
        .await?;
        assert_eq!(gated, vec!["fixture".to_string()]);
        assert!(status.enabled);
        assert!(status.uses_oauth);
        Ok(())
    }

    /// An unknown server fails with the TS wording; the handler stays
    /// registered so the kernel surfaces the error to the model.
    #[tokio::test]
    async fn worker_begin_login_rejects_unknown_servers() -> Result<()> {
        let agent = tempfile::tempdir()?;
        let http = Arc::new(ScriptedHttp::fixture());
        let manager = McpManager::new(McpManagerOptions {
            auth_storage: AuthStorage::create_with_oauth(
                agent.path(),
                Arc::new(pa_core::mcp::McpOAuth::with_http(
                    Arc::clone(&http) as Arc<dyn pa_core::mcp::OAuthHttp>
                )),
            ),
            get_user_servers: Box::new(|| None),
            begin_login: None,
            agent_dir: None,
            get_catalog_sources: None,
            remote_source: None,
            probe_override: None,
        });
        let manager = Arc::new(std::sync::Mutex::new(manager));
        wire_worker_mcp_login(
            &manager,
            Arc::new(RecordingLoginUi::new(None)) as Arc<dyn McpLoginUi>,
            Arc::clone(&http) as Arc<dyn pa_core::mcp::OAuthHttp>,
        );
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
        Ok(())
    }

    /// The UI contract for the worker: no manual paste channel, and the
    /// fallback prompt refuses (the callback is the only completion path).
    #[tokio::test]
    async fn worker_ui_has_no_paste_surface() {
        let ui = WorkerMcpLoginUi::with_auth_url_file(None);
        assert!(ui.on_manual_code_input().is_none());
        let error = ui
            .on_prompt("Paste the code:", "http://localhost")
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(error, "Login cancelled");
    }

    /// `AuthCredential::Oauth` still serializes the binding fields the
    /// persisted fixture credential shows above (shape regression fence).
    #[test]
    fn oauth_credential_serializes_ts_binding_fields() {
        let credential = AuthCredential::Oauth {
            access: "a".to_string(),
            refresh: Some("r".to_string()),
            expires: 123,
            endpoint: Some("https://fixture.example/mcp".to_string()),
            token_endpoint: Some("https://fixture.example/token".to_string()),
            client_id: Some("fixture-client".to_string()),
            resource: None,
            issuer: None,
        };
        let value = serde_json::to_value(&credential).unwrap();
        assert_eq!(value["type"], "oauth");
        assert_eq!(value["endpoint"], "https://fixture.example/mcp");
        assert_eq!(value["tokenEndpoint"], "https://fixture.example/token");
        assert_eq!(value["clientId"], "fixture-client");
    }
}
