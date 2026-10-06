//! Host side of MCP integrations. The protocol itself runs Python-side in the
//! kernel; the host only gates integration skills by auth and serves `mcp.*`
//! host requests (the OAuth flow lives in the `oauth*` submodules).

mod catalog_plugin_views;
mod catalog_schema;
mod catalog_status_views;
mod catalog_views;
mod connection_store;
mod fetch_lane;
mod local_catalog;
mod login;
mod manager_catalog;
mod oauth;
mod oauth_callback;
mod oauth_discovery;
mod oauth_http;
mod probe;
mod remote_source;
mod service_catalog;
mod url_checks;

pub use catalog_plugin_views::{McpCredentialView, API_KEY_CREDENTIALS};
pub use catalog_views::{
    mcp_credential_field_prompt_label, mcp_paste_credential, McpPasteCredential,
};
pub use fetch_lane::{spawn_hourly_plugins_refresh, startup_plugins_refresh};
pub use login::{wire_begin_login, McpLoginContext, McpOAuth};
pub use manager_catalog::{
    install_static_token, remove_mcp_connection, McpConnectionHandles, PasteInstallInputs,
    StaticTokenInstall,
};
pub use oauth::{mcp_login, mcp_refresh_token, McpLoginUi, McpOAuthConfig};
pub use oauth_http::{OAuthHttp, OAuthHttpRequest, OAuthHttpResponse, ReqwestOAuthHttp};

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::manager::AuthStorage;
use crate::kernel::shared::{host_handler, HostRequestHandlers};

/// A built-in MCP integration we ship a skill package for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCatalogEntry {
    /// Matches the skill package import name and the `mcp:<server>` auth key.
    pub server: String,
    pub label: String,
    pub url: String,
}

/// The built-in MCP catalog (user servers go in `mcpServers` instead).
pub const BUILTIN_MCP_CATALOG: &[(&str, &str, &str)] = &[
    ("linear", "Linear", "https://mcp.linear.app/mcp"),
    ("notion", "Notion", "https://mcp.notion.com/mcp"),
];

#[must_use]
pub fn get_catalog_entry(server: &str) -> Option<McpCatalogEntry> {
    BUILTIN_MCP_CATALOG
        .iter()
        .find(|(name, _, _)| *name == server)
        .map(|(server, label, url)| McpCatalogEntry {
            server: server.to_string(),
            label: label.to_string(),
            url: url.to_string(),
        })
}

/// A user-declared MCP server config (the `mcpServers` setting).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpServerConfig {
    #[serde(rename_all = "camelCase")]
    Http {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        headers: Option<HashMap<String, String>>,
        /// Env var holding a static bearer token (skips OAuth).
        #[serde(
            rename = "bearerTokenEnvVar",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        bearer_token_env_var: Option<String>,
        /// Use the generic OAuth login flow for this server.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        oauth: Option<bool>,
        /// Force-disable even when credentials exist.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        enabled: Option<bool>,
        #[serde(
            rename = "enabledTools",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        enabled_tools: Option<Vec<String>>,
        #[serde(
            rename = "disabledTools",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        disabled_tools: Option<Vec<String>>,
        #[serde(
            rename = "startupTimeoutMs",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        startup_timeout_ms: Option<u64>,
        #[serde(
            rename = "callTimeoutMs",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        call_timeout_ms: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Stdio {
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        /// Environment variables resolved from the kernel environment.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env: Option<HashMap<String, EnvRef>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        enabled: Option<bool>,
        #[serde(
            rename = "enabledTools",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        enabled_tools: Option<Vec<String>>,
        #[serde(
            rename = "disabledTools",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        disabled_tools: Option<Vec<String>>,
        #[serde(
            rename = "startupTimeoutMs",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        startup_timeout_ms: Option<u64>,
        #[serde(
            rename = "callTimeoutMs",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        call_timeout_ms: Option<u64>,
    },
}

impl McpServerConfig {
    #[must_use]
    pub fn server_type(&self) -> &'static str {
        match self {
            McpServerConfig::Http { .. } => "http",
            McpServerConfig::Stdio { .. } => "stdio",
        }
    }

    fn is_enabled(&self) -> bool {
        match self {
            McpServerConfig::Http { enabled, .. } | McpServerConfig::Stdio { enabled, .. } => {
                *enabled != Some(false)
            }
        }
    }
}

/// `{ "env": "<name>" }` stdio env reference.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EnvRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
}

/// Session-scoped server supplied by the active ACP client: literal
/// environment values and headers, no settings-only fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AcpMcpServerConfig {
    Stdio {
        name: String,
        command: String,
        #[serde(default)]
        args: Vec<String>,
        cwd: String,
        #[serde(default)]
        env: HashMap<String, String>,
    },
    Http {
        name: String,
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
}

impl AcpMcpServerConfig {
    #[must_use]
    pub fn name(&self) -> &str {
        match self {
            AcpMcpServerConfig::Stdio { name, .. } | AcpMcpServerConfig::Http { name, .. } => name,
        }
    }
}

/// A resolved integration: catalog/user entry plus auth state.
#[derive(Debug, Clone)]
// The mirrored TS API shape is deliberate (the booleans are the
// product's own surface, not a refactor target).
#[allow(clippy::struct_excessive_bools)]
pub(crate) struct ResolvedIntegration {
    pub(crate) server: String,
    pub(crate) label: String,
    pub(crate) config: McpServerConfig,
    pub(crate) uses_oauth: bool,
    /// True when this came from the `mcpServers` setting.
    pub(crate) user_declared: bool,
    /// Catalog entries only: the parent service id (records keep it).
    pub(crate) catalog_service_id: Option<String>,
    /// Catalog token services only: the entry collects exactly ONE credential,
    /// so a stored `mcp_static_token` under this exact id is a valid source, bound to this
    /// endpoint.
    pub(crate) static_token_eligible: bool,
    /// Catalog entries only: explicitly public no-auth AND setup-ready, so
    /// credential-free dispatch is honest.
    pub(crate) credential_free_eligible: bool,
    /// Ownership conflict / disabled hint for reserved names.
    pub(crate) blocked_reason: Option<String>,
}

/// Options for constructing an [`McpManager`].
pub type BeginLoginFuture = Box<dyn Future<Output = anyhow::Result<()>> + Send>;
pub type BeginLoginFn = Arc<dyn Fn(String) -> BeginLoginFuture + Send + Sync>;

pub struct McpManagerOptions {
    pub auth_storage: AuthStorage,
    /// Reads the current `mcpServers` setting; re-read on refresh.
    pub get_user_servers: Box<dyn Fn() -> Option<HashMap<String, McpServerConfig>> + Send + Sync>,
    /// Start an interactive host-side login for a server (UI mode supplies it).
    pub begin_login: Option<BeginLoginFn>,
    /// The agent dir: connection records and the default local source live
    /// here. `None` in embedded hosts (in-memory records, no local source).
    pub agent_dir: Option<std::path::PathBuf>,
    /// Declared local service-catalog sources (settings
    /// `mcpCatalogSources`, ~-relative allowed); re-read on refresh.
    pub get_catalog_sources: Option<Box<dyn Fn() -> Vec<String> + Send + Sync>>,
    /// The remote plugins-catalog snapshot source; defaults to the disk
    /// cache then the packaged bundle. Never fetches (the fetch lane writes).
    pub remote_source: Option<manager_catalog::RemoteCatalogSourceFn>,
    /// Injectable verification probe (tests); the real streamable-HTTP
    /// handshake by default.
    pub probe_override: Option<probe::McpEndpointProbe>,
}

/// Telemetry usage reporter: called with `(action, server)` on every successful `mcp.*` host
/// request; never tool names, arguments, or results.
pub type McpUsageReporter = std::sync::Arc<dyn Fn(&str, &str) + Send + Sync>;

/// Host-side MCP manager: auth gating, config resolution, `mcp.*` host
/// requests, and ACP session servers.
pub struct McpManager {
    auth_storage: Arc<tokio::sync::Mutex<AuthStorage>>,
    get_user_servers: Box<dyn Fn() -> Option<HashMap<String, McpServerConfig>> + Send + Sync>,
    begin_login: Option<BeginLoginFn>,
    agent_dir: Option<std::path::PathBuf>,
    get_catalog_sources: Option<Box<dyn Fn() -> Vec<String> + Send + Sync>>,
    remote_source: Option<manager_catalog::RemoteCatalogSourceFn>,
    probe_override: Option<probe::McpEndpointProbe>,
    usage_report: Option<McpUsageReporter>,
    integrations: HashMap<String, ResolvedIntegration>,
    /// The resolved service catalog (the SAME resolution feeds integrations
    /// and the `/mcp` view).
    service_catalog: service_catalog::McpCatalogResolution,
    /// Whether the last resolution had a validated remote catalog snapshot:
    /// the pinned-definition hint renders only when a snapshot can prove a
    /// service left the catalog.
    catalog_available: bool,
    connection_store: std::sync::Arc<std::sync::Mutex<connection_store::McpConnectionStore>>,
    acp_servers: std::sync::Arc<std::sync::Mutex<HashMap<String, AcpMcpServerConfig>>>,
    acp_owner_id: std::sync::Mutex<Option<String>>,
}

impl McpManager {
    /// Set the telemetry usage reporter. Must run before
    /// [`McpManager::register_host_handlers`] so the handlers capture it.
    pub fn set_usage_report(&mut self, reporter: Option<McpUsageReporter>) {
        self.usage_report = reporter;
    }
}

fn provider_id(server: &str) -> String {
    format!("mcp:{server}")
}

fn uses_oauth(config: &McpServerConfig) -> bool {
    matches!(
        config,
        McpServerConfig::Http {
            oauth: Some(true),
            ..
        }
    )
}

impl McpManager {
    pub fn new(options: McpManagerOptions) -> Self {
        let agent_dir = options.agent_dir;
        let connection_store = std::sync::Arc::new(std::sync::Mutex::new(match &agent_dir {
            Some(dir) => {
                connection_store::McpConnectionStore::open(dir.join("mcp-connections.json"))
            }
            None => connection_store::McpConnectionStore::in_memory(),
        }));
        let remote_source = options.remote_source.or_else(|| {
            agent_dir.as_ref().map(|dir| {
                let dir = dir.clone();
                Box::new(move || remote_source::remote_plugins_snapshot(&dir))
                    as manager_catalog::RemoteCatalogSourceFn
            })
        });
        let mut manager = Self {
            auth_storage: Arc::new(tokio::sync::Mutex::new(options.auth_storage)),
            get_user_servers: options.get_user_servers,
            begin_login: options.begin_login,
            agent_dir,
            get_catalog_sources: options.get_catalog_sources,
            remote_source,
            probe_override: options.probe_override,
            usage_report: None,
            integrations: HashMap::new(),
            service_catalog: crate::mcp::service_catalog::McpCatalogResolution::default(),
            catalog_available: false,
            connection_store,
            acp_servers: std::sync::Arc::new(std::sync::Mutex::new(HashMap::new())),
            acp_owner_id: std::sync::Mutex::new(None),
        };
        manager.resolve_integrations();
        manager
    }

    /// Re-read settings and re-resolve integrations; call after a reload.
    pub fn refresh(&mut self) {
        self.resolve_integrations();
    }

    /// Reload the shared auth store (blocking lock, never on the async
    /// runtime): a credential another process wrote — the interactive
    /// client's `/mcp` key flow stores through its own storage instance —
    /// becomes visible to the next view read, like the settings re-read
    /// above.
    pub fn reload_auth_storage(&mut self) {
        let storage = self.auth_storage.clone();
        let mut handle = storage.blocking_lock();
        handle.reload();
    }

    /// The resolved integrations (login resolution and status displays).
    pub(crate) fn integrations(&self) -> &HashMap<String, ResolvedIntegration> {
        &self.integrations
    }

    /// The shared auth store the login flow persists into.
    pub(crate) fn auth_storage_handle(&self) -> Arc<tokio::sync::Mutex<AuthStorage>> {
        Arc::clone(&self.auth_storage)
    }

    /// Wire (or clear) the interactive login behind the `mcp.begin_login`
    /// host request; hosts with a login UI set it before host handlers register.
    pub fn set_begin_login(&mut self, begin_login: Option<BeginLoginFn>) {
        self.begin_login = begin_login;
    }

    fn resolve_integrations(&mut self) {
        self.resolve_integrations_over_catalog();
    }

    /// Whether ACP server configs owned by `owner_id` may be released.
    ///
    /// # Panics
    ///
    /// Panics if the ACP owner mutex is poisoned.
    pub fn can_release_acp_servers(&self, owner_id: &str) -> bool {
        self.acp_owner_id
            .lock()
            .unwrap()
            .as_deref()
            .is_none_or(|owner| owner == owner_id)
    }

    /// Replace the ACP-supplied session servers, fenced by owner. `false`
    /// when nothing changed (or the owner does not own what is cleared).
    ///
    /// # Errors
    ///
    /// Returns an error when `owner_id` is empty, or two servers share a name.
    ///
    /// # Panics
    ///
    /// Panics if the ACP owner or ACP server mutexes are poisoned.
    pub fn replace_acp_servers(
        &self,
        servers: &[AcpMcpServerConfig],
        owner_id: &str,
    ) -> anyhow::Result<bool> {
        if owner_id.is_empty() {
            anyhow::bail!("ACP MCP owner id is required");
        }
        let owner_fence = self.acp_owner_id.lock().unwrap().clone();
        if servers.is_empty() && owner_fence.as_deref() != Some(owner_id) {
            return Ok(false);
        }
        if !servers.is_empty()
            && owner_fence
                .as_deref()
                .is_some_and(|owner| owner != owner_id)
        {
            anyhow::bail!("ACP MCP configuration is owned by another client");
        }
        let mut next: HashMap<String, AcpMcpServerConfig> = HashMap::new();
        for server in servers {
            if next.contains_key(server.name()) {
                anyhow::bail!("Duplicate ACP MCP server: {}", server.name());
            }
            next.insert(server.name().to_string(), server.clone());
        }
        let mut acp_servers = self.acp_servers.lock().unwrap();
        let unchanged = next.len() == acp_servers.len()
            && next.iter().all(|(name, config)| {
                acp_servers.get(name).is_some_and(|current| {
                    serde_json::to_value(current).ok() == serde_json::to_value(config).ok()
                })
            });
        if unchanged {
            return Ok(false);
        }
        *acp_servers = next;
        *self.acp_owner_id.lock().unwrap() = (!servers.is_empty()).then(|| owner_id.to_string());
        Ok(true)
    }

    /// True when valid credentials exist for the integration (drives enablement).
    fn is_authed(&self, integration: &ResolvedIntegration) -> bool {
        if integration.blocked_reason.is_some() {
            return false;
        }
        if !integration.config.is_enabled() {
            return false;
        }
        // A bundled catalog service owns its name; a shadowing user entry is dead by design.
        if integration.user_declared && self.is_reserved_server_name(&integration.server) {
            return false;
        }
        if matches!(integration.config, McpServerConfig::Stdio { .. }) {
            return true;
        }
        let McpServerConfig::Http {
            url,
            bearer_token_env_var,
            ..
        } = &integration.config
        else {
            unreachable!("stdio handled above");
        };
        let all = self.auth_storage_blocking_snapshot();
        let credential = all
            .get(&provider_id(&integration.server))
            .and_then(|value| {
                serde_json::from_value::<crate::auth::types::AuthCredential>(value.clone()).ok()
            });
        if !integration.user_declared && !integration.uses_oauth {
            // Catalog entry without OAuth: credential-free dispatch ONLY for an explicitly public
            // no-auth, setup-ready descriptor; a token service. Everything else fails closed.
            if integration.credential_free_eligible {
                return true;
            }
            if integration.static_token_eligible {
                return super::mcp::catalog_views::mcp_static_token_usable(
                    credential.as_ref(),
                    url,
                )
                .is_ok();
            }
            return false;
        }
        if let Some(env_var) = bearer_token_env_var {
            // The configured env var is the ONLY credential source: when it is unset, a stale OAuth
            // credential must never authorize dispatch.
            return std::env::var(env_var).is_ok_and(|value| !value.trim().is_empty());
        }
        // ONE shared grant-usability rule (with the view states): typed
        // oauth, non-empty access, endpoint binding, no expired-no-refresh.
        super::mcp::catalog_views::oauth_grant_usable(credential.as_ref(), url).is_ok()
    }

    fn auth_storage_blocking_snapshot(&self) -> serde_json::Map<String, Value> {
        // The auth storage data map, read without refresh side effects.
        let storage = self.auth_storage.clone();
        let handle = storage.blocking_lock();
        let all = handle.get_all();
        match serde_json::to_value(&all) {
            Ok(Value::Object(map)) => map,
            _ => serde_json::Map::default(),
        }
    }

    /// Auth gating the system prompt and resource loader need: `-<server>/SKILL.md` overrides for
    /// built-ins the user is not logged into, plus the enabled persistent generic servers.
    #[must_use]
    pub fn prompt_gating(
        user_servers: std::collections::HashMap<String, McpServerConfig>,
        agent_dir: &std::path::Path,
    ) -> (Vec<String>, Vec<String>, McpManager) {
        let manager = McpManager::new(McpManagerOptions {
            auth_storage: crate::auth::AuthStorage::create_with_oauth(
                agent_dir,
                std::sync::Arc::new(McpOAuth::new()),
            ),
            get_user_servers: Box::new(move || Some(user_servers.clone())),
            begin_login: None,
            agent_dir: Some(agent_dir.to_path_buf()),
            get_catalog_sources: None,
            remote_source: None,
            probe_override: None,
        });
        (
            manager.get_disabled_builtin_skill_overrides(),
            manager.get_enabled_persistent_generic_servers(),
            manager,
        )
    }

    /// `-<server>/SKILL.md` overrides for every built-in integration the user
    /// is not logged into.
    pub fn get_disabled_builtin_skill_overrides(&self) -> Vec<String> {
        BUILTIN_MCP_CATALOG
            .iter()
            .filter_map(|(server, _, _)| {
                let integration = self.integrations.get(*server)?;
                (!self.is_authed(integration)).then(|| format!("-{server}/SKILL.md"))
            })
            .collect()
    }

    /// Register the `mcp.*` host-request handlers: `refresh`/`config`/`begin_login` dispatch
    /// plumbing plus the inventory surface the kernel's generic `mcp` module reaches for.
    ///
    /// The inventory handlers capture this manager so each request serves LIVE views; view
    /// computation reads the blocking auth-store snapshot.
    ///
    /// # Panics
    ///
    /// The registered handlers panic at request time if the manager or ACP server mutex
    /// is poisoned.
    pub fn register_host_handlers(
        manager: &Arc<std::sync::Mutex<Self>>,
        handlers: &mut HostRequestHandlers,
    ) {
        /// The default when absent, a positive integer check, then a clamp to the maximum.
        fn bounded_limit(
            value: Option<&Value>,
            default_limit: usize,
            max_limit: usize,
        ) -> Result<usize, anyhow::Error> {
            let Some(value) = value else {
                return Ok(default_limit);
            };
            let number = value
                .as_u64()
                .or_else(|| {
                    value
                        .as_f64()
                        .filter(|number| number.fract() == 0.0)
                        .map(|number| number as u64)
                })
                .ok_or_else(|| {
                    anyhow::anyhow!("mcp host request limit must be a positive integer")
                })?;
            if number < 1 {
                return Err(anyhow::anyhow!(
                    "mcp host request limit must be a positive integer"
                ));
            }
            Ok(number.min(max_limit as u64) as usize)
        }

        let (
            auth,
            acp_servers,
            usage_refresh,
            acp_servers_for_config,
            integrations,
            usage_config,
            begin_login,
        ) = {
            let manager = manager.lock().unwrap();
            (
                manager.auth_storage.clone(),
                manager.acp_servers.clone(),
                manager.usage_report.clone(),
                manager.acp_servers.clone(),
                manager.integrations.clone(),
                manager.usage_report.clone(),
                manager.begin_login.clone(),
            )
        };
        handlers.register(
            "mcp.refresh",
            host_handler(move |payload| {
                let auth = auth.clone();
                let usage_refresh = usage_refresh.clone();
                let acp_servers = acp_servers.clone();
                Box::pin(async move {
                    let server = payload
                        .data
                        .get("server")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if server.is_empty() {
                        return Err(anyhow::anyhow!("mcp.refresh requires a server"));
                    }
                    if acp_servers.lock().unwrap().contains_key(&server) {
                        return Err(anyhow::anyhow!(
                            "ACP MCP server {server} does not use host OAuth"
                        ));
                    }
                    // Re-read the file first: a login from another process wrote the credential
                    // after this manager cached its store; the daemon worker's store must not serve
                    // the stale snapshot.
                    let mut store = auth.lock().await;
                    store.reload();
                    let key = store.get_api_key(&provider_id(&server));
                    drop(store);
                    if key.is_none() {
                        return Err(anyhow::anyhow!(
                            "Could not refresh credentials for {server}"
                        ));
                    }
                    if let Some(report) = &usage_refresh {
                        report("refresh", &server);
                    }
                    Ok(json!({}))
                })
            }),
        );
        handlers.register(
            "mcp.config",
            host_handler(move |payload| {
                let integrations = integrations.clone();
                let acp_servers = acp_servers_for_config.clone();
                let usage_config = usage_config.clone();
                Box::pin(async move {
                    let server = payload
                        .data
                        .get("server")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if server.is_empty() {
                        return Err(anyhow::anyhow!("mcp.config requires a server"));
                    }
                    let acp = acp_servers.lock().unwrap().get(&server).cloned();
                    if let Some(acp) = acp {
                        let mut config = serde_json::to_value(acp).unwrap_or(Value::Null);
                        if let Value::Object(map) = &mut config {
                            map.insert("credentialSource".to_string(), json!("acp"));
                        }
                        if let Some(report) = &usage_config {
                            report("config", &server);
                        }
                        return Ok(config);
                    }
                    let Some(integration) = integrations.get(&server) else {
                        return Ok(json!({}));
                    };
                    if !integration.user_declared {
                        // A catalog service: the kernel dispatches it through disabled/blocked
                        // entries never dispatch.
                        if integration.blocked_reason.is_some() {
                            return Ok(json!({}));
                        }
                        let mut config = serde_json::to_value(&integration.config)
                            .map_err(anyhow::Error::new)?;
                        if integration.static_token_eligible {
                            if let Value::Object(map) = &mut config {
                                map.insert("credentialSource".to_string(), json!("static-token"));
                            }
                        }
                        if let Some(report) = &usage_config {
                            report("config", &server);
                        }
                        return Ok(config);
                    }
                    if get_catalog_entry(&server).is_some() {
                        return Ok(json!({}));
                    }
                    serde_json::to_value(&integration.config).map_err(anyhow::Error::new)
                })
            }),
        );
        // Only expose begin_login when an interactive login is actually wired.
        if let Some(begin_login) = begin_login {
            handlers.register(
                "mcp.begin_login",
                host_handler(move |payload| {
                    let begin_login = begin_login.clone();
                    Box::pin(async move {
                        let server = payload
                            .data
                            .get("server")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        if server.is_empty() {
                            return Err(anyhow::anyhow!("mcp.begin_login requires a server"));
                        }
                        let mut future = std::pin::Pin::from(begin_login(server));
                        future.as_mut().await?;
                        Ok(json!({}))
                    })
                }),
            );
        }
        let manager = std::sync::Arc::clone(manager);
        let manager_for_plugins = std::sync::Arc::clone(&manager);
        handlers.register(
            "mcp.list_plugins",
            host_handler(move |payload| {
                let manager = std::sync::Arc::clone(&manager_for_plugins);
                Box::pin(async move {
                    let status = payload.data.get("connectionStatus");
                    let status = match status {
                        None => None,
                        Some(Value::String(status)) => Some(status.clone()),
                        Some(_) => {
                            return Err(anyhow::anyhow!(
                                "mcp.list_plugins connectionStatus must be a string"
                            ));
                        }
                    };
                    if let Some(status) = status.as_deref() {
                        if !matches!(
                            status,
                            "connected"
                                | "pending"
                                | "not_connected"
                                | "setup_required"
                                | "disabled"
                                | "error"
                        ) {
                            return Err(anyhow::anyhow!(
                                "mcp.list_plugins received an unknown connectionStatus: {status}"
                            ));
                        }
                    }
                    let limit = bounded_limit(payload.data.get("limit"), 50, 200)?;
                    let cursor = match payload.data.get("cursor") {
                        None => 0,
                        Some(Value::String(cursor)) => {
                            crate::mcp::catalog_plugin_views::decode_plugin_cursor(Some(cursor))
                                .map_err(anyhow::Error::msg)?
                        }
                        Some(_) => {
                            return Err(anyhow::anyhow!(
                                "mcp.list_plugins received an invalid cursor"
                            ));
                        }
                    };
                    // The views read the auth store through a blocking
                    // snapshot; keep that off the async runtime.
                    let views = tokio::task::spawn_blocking(move || {
                        let manager = manager.lock().unwrap();
                        manager.service_catalog_views()
                    })
                    .await
                    .map_err(|error| anyhow::anyhow!("MCP inventory read failed: {error}"))?;
                    let views = match status.as_deref() {
                        Some(status) => {
                            crate::mcp::catalog_plugin_views::filter_plugin_views_by_status(
                                &views, status,
                            )
                        }
                        None => views,
                    };
                    let (plugins, next_cursor) =
                        crate::mcp::catalog_plugin_views::page_plugin_views(&views, cursor, limit);
                    let next_cursor = match next_cursor {
                        Some(next) => json!(next),
                        None => Value::Null,
                    };
                    Ok(json!({ "plugins": plugins, "nextCursor": next_cursor }))
                })
            }),
        );
        let manager_for_search = std::sync::Arc::clone(&manager);
        handlers.register(
            "mcp.search_plugins",
            host_handler(move |payload| {
                let manager = std::sync::Arc::clone(&manager_for_search);
                Box::pin(async move {
                    let query = payload
                        .data
                        .get("query")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or_default()
                        .to_string();
                    if query.is_empty() {
                        return Err(anyhow::anyhow!(
                            "mcp.search_plugins requires a non-empty query"
                        ));
                    }
                    let limit = bounded_limit(payload.data.get("limit"), 10, 50)?;
                    let views = tokio::task::spawn_blocking(move || {
                        let manager = manager.lock().unwrap();
                        manager.service_catalog_views()
                    })
                    .await
                    .map_err(|error| anyhow::anyhow!("MCP inventory read failed: {error}"))?;
                    let plugins = crate::mcp::catalog_plugin_views::search_plugin_views(
                        &views, &query, limit,
                    );
                    Ok(json!({ "plugins": plugins, "nextCursor": Value::Null }))
                })
            }),
        );
        handlers.register(
            "mcp.list_connections",
            host_handler(move |_payload| {
                let manager = std::sync::Arc::clone(&manager);
                Box::pin(async move {
                    let connections = tokio::task::spawn_blocking(move || {
                        let manager = manager.lock().unwrap();
                        let acp_servers = manager.get_acp_servers();
                        manager.service_catalog_connection_views(&acp_servers)
                    })
                    .await
                    .map_err(|error| anyhow::anyhow!("MCP inventory read failed: {error}"))?;
                    Ok(json!({ "connections": connections }))
                })
            }),
        );
    }

    /// Session-scoped servers supplied by the active ACP client.
    ///
    /// # Panics
    ///
    /// Panics if the ACP server mutex is poisoned.
    pub fn get_acp_servers(&self) -> Vec<AcpMcpServerConfig> {
        self.acp_servers.lock().unwrap().values().cloned().collect()
    }

    /// Enabled servers available through the generic kernel API: user- declared plus connected
    /// catalog services.
    pub fn get_enabled_persistent_generic_servers(&self) -> Vec<String> {
        let mut servers: Vec<String> = self
            .integrations
            .values()
            .filter(|integration| {
                // Ownership/id checks first: `is_authed` reads the auth
                // store and must not run for filtered-out integrations.
                is_generic_server_name(&integration.server)
                    && if integration.user_declared {
                        get_catalog_entry(&integration.server).is_none()
                    } else {
                        // Catalog services: connected and not legacy
                        // builtins (their ids resolve through skills).
                        integration.catalog_service_id.is_some()
                            && self
                                .service_descriptor(&integration.server)
                                .is_some_and(|service| !service.legacy_builtin)
                    }
                    && self.is_authed(integration)
            })
            .map(|integration| integration.server.clone())
            .collect();
        servers.sort();
        servers
    }

    /// The connections roster for the `/mcp` connections view. Sorted by label.
    pub fn connection_roster(&self) -> Vec<McpConnectionEntry> {
        let generic: std::collections::HashSet<String> = self
            .get_enabled_persistent_generic_servers()
            .into_iter()
            .collect();
        let mut entries: Vec<McpConnectionEntry> = self
            .integrations
            .values()
            .map(|integration| {
                let transport = integration.config.server_type().to_string();
                let auth_kind = if integration.uses_oauth {
                    "subscription"
                } else if matches!(
                    &integration.config,
                    McpServerConfig::Http {
                        bearer_token_env_var: Some(_),
                        ..
                    }
                ) {
                    "api key"
                } else {
                    transport.as_str()
                };
                McpConnectionEntry {
                    server: integration.server.clone(),
                    label: integration.label.clone(),
                    connected: self.is_authed(integration),
                    uses_oauth: integration.uses_oauth,
                    auth_kind: auth_kind.to_string(),
                    transport,
                    user_declared: integration.user_declared,
                    generic: generic.contains(&integration.server),
                }
            })
            .collect();
        entries.sort_by_key(|entry| entry.label.to_lowercase());
        entries
    }

    /// Status for the `/mcp list` command.
    pub fn list_status(&self) -> Vec<McpServerStatus> {
        self.integrations
            .values()
            .map(|integration| McpServerStatus {
                server: integration.server.clone(),
                label: integration.label.clone(),
                enabled: self.is_authed(integration),
                uses_oauth: integration.uses_oauth,
            })
            .collect()
    }
}

/// One `/mcp list` row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub server: String,
    pub label: String,
    pub enabled: bool,
    pub uses_oauth: bool,
}

/// One `/mcp` connections-view row (the daemon's `get_mcp_connections` response).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
// The mirrored TS API shape is deliberate (the booleans are the
// product's own surface, not a refactor target).
#[allow(clippy::struct_excessive_bools)]
pub struct McpConnectionEntry {
    pub server: String,
    pub label: String,
    /// Connected: credentials present and the server enabled.
    pub connected: bool,
    pub uses_oauth: bool,
    /// The auth kind the view shows (`subscription` / `api key`), or the
    /// transport for credential-less stdio/http servers.
    pub auth_kind: String,
    /// The transport (`http` / `stdio`).
    pub transport: String,
    /// True for a user-declared `mcpServers` entry (false: built-in).
    pub user_declared: bool,
    /// True when the server surfaces through the generic kernel API (its
    /// tools are listable through `mcp.list_tools`).
    pub generic: bool,
}

fn is_generic_server_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }
    let mut chars = name.chars();
    let first = chars.next().expect("checked non-empty");
    if !(first.is_ascii_alphanumeric()) {
        return false;
    }
    chars.all(|char| char.is_ascii_alphanumeric() || char == '_' || char == '-')
}

impl ResolvedIntegration {
    fn config_url(&self) -> Option<&str> {
        match &self.config {
            McpServerConfig::Http { url, .. } => Some(url.as_str()),
            McpServerConfig::Stdio { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_auth_storage() -> AuthStorage {
        AuthStorage::in_memory(
            &crate::auth::types::AuthStorageData::default(),
            std::sync::Arc::new(crate::auth::manager::NoOAuth),
        )
    }

    fn manager_with(user_servers: Option<HashMap<String, McpServerConfig>>) -> McpManager {
        McpManager::new(McpManagerOptions {
            auth_storage: test_auth_storage(),
            get_user_servers: Box::new(move || user_servers.clone()),
            begin_login: None,
            agent_dir: None,
            get_catalog_sources: None,
            remote_source: None,
            probe_override: None,
        })
    }

    fn http_config(url: &str, oauth: Option<bool>, env_var: Option<&str>) -> McpServerConfig {
        McpServerConfig::Http {
            url: url.to_string(),
            headers: None,
            bearer_token_env_var: env_var.map(std::string::ToString::to_string),
            oauth,
            enabled: None,
            enabled_tools: None,
            disabled_tools: None,
            startup_timeout_ms: None,
            call_timeout_ms: None,
        }
    }

    #[test]
    fn connection_roster_covers_builtins_and_user_servers() {
        let mut user_servers = HashMap::new();
        user_servers.insert(
            "fixture-echo".to_string(),
            McpServerConfig::Stdio {
                command: "python3".to_string(),
                args: None,
                cwd: None,
                env: None,
                enabled: None,
                enabled_tools: None,
                disabled_tools: None,
                startup_timeout_ms: None,
                call_timeout_ms: None,
            },
        );
        let manager = manager_with(Some(user_servers));
        let roster = manager.connection_roster();
        let names: Vec<&str> = roster.iter().map(|entry| entry.server.as_str()).collect();
        assert_eq!(names, vec!["fixture-echo", "linear", "notion"]);
        let fixture = &roster[0];
        assert!(fixture.connected);
        assert!(fixture.generic);
        assert!(fixture.user_declared);
        assert_eq!(fixture.auth_kind, "stdio");
        assert_eq!(fixture.transport, "stdio");
        let linear = roster
            .iter()
            .find(|entry| entry.server == "linear")
            .expect("linear");
        assert!(!linear.connected);
        assert!(!linear.generic);
        assert!(!linear.user_declared);
        assert_eq!(linear.auth_kind, "subscription");
        assert_eq!(linear.transport, "http");
        // An OAuth-bearing user server keeps the TS auth-kind cell.
        let mut oauth_servers = HashMap::new();
        oauth_servers.insert(
            "hooked".to_string(),
            http_config("https://hooked.example/mcp", Some(true), None),
        );
        let manager = manager_with(Some(oauth_servers));
        let roster = manager.connection_roster();
        let hooked = roster
            .iter()
            .find(|entry| entry.server == "hooked")
            .expect("hooked");
        assert_eq!(hooked.auth_kind, "subscription");
        assert!(!hooked.connected, "no stored credentials yet");
        let mut env_servers = HashMap::new();
        env_servers.insert(
            "search".to_string(),
            http_config("https://search.example/mcp", None, Some("SEARCH_TOKEN")),
        );
        let manager = manager_with(Some(env_servers));
        let roster = manager.connection_roster();
        let search = roster
            .iter()
            .find(|entry| entry.server == "search")
            .expect("search");
        assert_eq!(search.auth_kind, "api key");
    }

    #[test]
    fn builtin_catalog_and_skill_overrides() {
        let manager = manager_with(None);
        let overrides = manager.get_disabled_builtin_skill_overrides();
        assert_eq!(
            overrides,
            vec![
                "-linear/SKILL.md".to_string(),
                "-notion/SKILL.md".to_string()
            ]
        );
        let status = manager.list_status();
        assert_eq!(status.len(), 2);
        let linear = status.iter().find(|row| row.server == "linear").unwrap();
        assert!(!linear.enabled);
        assert!(linear.uses_oauth);
        assert!(manager.get_enabled_persistent_generic_servers().is_empty());
    }

    #[test]
    fn stdio_and_env_token_servers_are_enabled() {
        let mut user_servers = HashMap::new();
        user_servers.insert(
            "toolchain".to_string(),
            McpServerConfig::Stdio {
                command: "npx".to_string(),
                args: Some(vec!["-y".to_string(), "server".to_string()]),
                cwd: None,
                env: None,
                enabled: None,
                enabled_tools: None,
                disabled_tools: None,
                startup_timeout_ms: None,
                call_timeout_ms: None,
            },
        );
        user_servers.insert(
            "search".to_string(),
            http_config("https://search.example/mcp", None, Some("SEARCH_TOKEN")),
        );
        let manager = manager_with(Some(user_servers));
        let generic = manager.get_enabled_persistent_generic_servers();
        assert!(generic.contains(&"toolchain".to_string()));
        // The env-var server stays disabled until SEARCH_TOKEN is set in the
        // environment (bearer-token auth requires the token at hand).
        assert!(!generic.contains(&"search".to_string()));
        // Catalog overrides by users are not enableable.
        let mut override_servers = HashMap::new();
        override_servers.insert(
            "linear".to_string(),
            http_config("https://evil.example/mcp", None, None),
        );
        let manager = manager_with(Some(override_servers));
        assert!(!manager
            .get_enabled_persistent_generic_servers()
            .contains(&"linear".to_string()));
    }

    #[test]
    fn generic_name_pattern() {
        assert!(is_generic_server_name("a"));
        assert!(is_generic_server_name("Tool_2-go"));
        assert!(!is_generic_server_name(""));
        assert!(!is_generic_server_name("-leading"));
        assert!(!is_generic_server_name("has space"));
        assert!(!is_generic_server_name(&"x".repeat(65)));
    }

    #[test]
    fn acp_server_ownership() {
        let manager = manager_with(None);
        assert!(manager.can_release_acp_servers("client-a"));
        let servers = vec![AcpMcpServerConfig::Stdio {
            name: "session-tool".to_string(),
            command: "run".to_string(),
            args: vec![],
            cwd: "/tmp".to_string(),
            env: HashMap::new(),
        }];
        assert!(manager.replace_acp_servers(&servers, "client-a").unwrap());
        assert!(!manager.replace_acp_servers(&servers, "client-a").unwrap());
        assert!(manager.replace_acp_servers(&servers, "client-b").is_err());
        assert!(!manager.can_release_acp_servers("client-b"));
        assert!(manager.can_release_acp_servers("client-a"));
        let duplicate = vec![servers[0].clone(), servers[0].clone()];
        assert!(manager.replace_acp_servers(&duplicate, "client-a").is_err());
        assert!(manager.replace_acp_servers(&[], "client-a").unwrap());
        assert_eq!(manager.get_acp_servers().len(), 0);
        assert!(manager.replace_acp_servers(&servers, "").is_err());
    }

    #[tokio::test]
    async fn config_host_handler_returns_user_stdio_server_config() {
        let mut user_servers = HashMap::new();
        user_servers.insert(
            "fixture-echo".to_string(),
            McpServerConfig::Stdio {
                command: "python3".to_string(),
                args: Some(vec!["fixtures/mcp_echo_server.py".to_string()]),
                cwd: None,
                env: None,
                enabled: None,
                enabled_tools: Some(vec!["echo".to_string()]),
                disabled_tools: None,
                startup_timeout_ms: None,
                call_timeout_ms: None,
            },
        );
        let manager = std::sync::Arc::new(std::sync::Mutex::new(manager_with(Some(user_servers))));
        assert_eq!(
            manager
                .lock()
                .unwrap()
                .get_enabled_persistent_generic_servers(),
            vec!["fixture-echo".to_string()]
        );
        let mut handlers = HostRequestHandlers::default();
        McpManager::register_host_handlers(&manager, &mut handlers);
        let config = handlers.get("mcp.config").unwrap().clone();
        let result = config(crate::kernel::shared::HostRequestPayload {
            data: json!({ "server": "fixture-echo" }),
            cell_source_code: None,
        })
        .await
        .unwrap();
        assert_eq!(result["type"], "stdio");
        assert_eq!(result["command"], "python3");
        assert_eq!(result["args"], json!(["fixtures/mcp_echo_server.py"]));
        assert_eq!(result["enabledTools"], json!(["echo"]));
    }

    #[tokio::test]
    async fn config_host_handler_resolves_user_and_acp_servers() {
        let manager = std::sync::Arc::new(std::sync::Mutex::new(manager_with(None)));
        let mut handlers = HostRequestHandlers::default();
        McpManager::register_host_handlers(&manager, &mut handlers);
        let config = handlers.get("mcp.config").unwrap().clone();
        let result = config(crate::kernel::shared::HostRequestPayload {
            data: json!({ "server": "nope" }),
            cell_source_code: None,
        })
        .await
        .unwrap();
        assert!(result.as_object().unwrap().is_empty());
        let servers = vec![AcpMcpServerConfig::Stdio {
            name: "session-tool".to_string(),
            command: "run".to_string(),
            args: vec![],
            cwd: "/tmp".to_string(),
            env: HashMap::new(),
        }];

        manager
            .lock()
            .unwrap()
            .replace_acp_servers(&servers, "client-a")
            .unwrap();
        let mut handlers = HostRequestHandlers::default();
        McpManager::register_host_handlers(&manager, &mut handlers);
        let config = handlers.get("mcp.config").unwrap().clone();
        let result = config(crate::kernel::shared::HostRequestPayload {
            data: json!({ "server": "session-tool" }),
            cell_source_code: None,
        })
        .await
        .unwrap();
        assert_eq!(result["type"], "stdio");
        assert_eq!(result["credentialSource"], "acp");
        let error = config(crate::kernel::shared::HostRequestPayload {
            data: json!({}),
            cell_source_code: None,
        })
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "mcp.config requires a server");
        assert!(handlers.get("mcp.begin_login").is_none());
    }

    #[tokio::test]
    async fn list_plugins_host_handler_pages_filters_and_validates() {
        let manager = std::sync::Arc::new(std::sync::Mutex::new(manager_with(None)));
        let mut handlers = HostRequestHandlers::default();
        McpManager::register_host_handlers(&manager, &mut handlers);
        let list_plugins = handlers.get("mcp.list_plugins").expect("wired").clone();
        // Default page: the first 50 plugin cards, and the real catalog is present.
        let page = list_plugins(crate::kernel::shared::HostRequestPayload {
            data: json!({}),
            cell_source_code: None,
        })
        .await
        .unwrap();
        assert!(page["plugins"].as_array().expect("plugins").len() > 1);
        assert!(
            page["plugins"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["serviceId"] == json!("linear")),
            "the compiled builtin catalog services page"
        );
        let filtered = list_plugins(crate::kernel::shared::HostRequestPayload {
            data: json!({ "connectionStatus": "connected" }),
            cell_source_code: None,
        })
        .await
        .unwrap();
        assert!(
            filtered["plugins"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry["connectionStatus"] == json!("connected")),
            "every filtered row carries the requested status"
        );
        let error = list_plugins(crate::kernel::shared::HostRequestPayload {
            data: json!({ "connectionStatus": "maybe" }),
            cell_source_code: None,
        })
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "mcp.list_plugins received an unknown connectionStatus: maybe"
        );
        let error = list_plugins(crate::kernel::shared::HostRequestPayload {
            data: json!({ "connectionStatus": 7 }),
            cell_source_code: None,
        })
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "mcp.list_plugins connectionStatus must be a string"
        );
        let error = list_plugins(crate::kernel::shared::HostRequestPayload {
            data: json!({ "cursor": "not-digits" }),
            cell_source_code: None,
        })
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "mcp.list_plugins received an invalid cursor"
        );
        let error = list_plugins(crate::kernel::shared::HostRequestPayload {
            data: json!({ "limit": 0 }),
            cell_source_code: None,
        })
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "mcp host request limit must be a positive integer"
        );
        let clamped = list_plugins(crate::kernel::shared::HostRequestPayload {
            data: json!({ "limit": 1000 }),
            cell_source_code: None,
        })
        .await
        .unwrap();
        assert!(
            clamped["plugins"].as_array().unwrap().len() <= 200,
            "the host clamps the page size to its maximum"
        );
        // A limit under the catalog size pages with a cursor.
        let total = page["plugins"].as_array().unwrap().len();
        if total > 2 {
            let first = list_plugins(crate::kernel::shared::HostRequestPayload {
                data: json!({ "limit": 2 }),
                cell_source_code: None,
            })
            .await
            .unwrap();
            let next_cursor = first["nextCursor"]
                .as_str()
                .expect("a cursor when more exist");
            assert_eq!(next_cursor, "2");
            let second = list_plugins(crate::kernel::shared::HostRequestPayload {
                data: json!({ "limit": 2, "cursor": next_cursor }),
                cell_source_code: None,
            })
            .await
            .unwrap();
            assert_ne!(
                second["plugins"][0]["serviceId"], first["plugins"][0]["serviceId"],
                "the next page starts where the cursor left off"
            );
        }
    }

    #[tokio::test]
    async fn search_plugins_host_handler_searches_and_validates() {
        let manager = std::sync::Arc::new(std::sync::Mutex::new(manager_with(None)));
        let mut handlers = HostRequestHandlers::default();
        McpManager::register_host_handlers(&manager, &mut handlers);
        let search = handlers.get("mcp.search_plugins").expect("wired").clone();
        let result = search(crate::kernel::shared::HostRequestPayload {
            data: json!({ "query": "linear" }),
            cell_source_code: None,
        })
        .await
        .unwrap();
        let plugins = result["plugins"].as_array().expect("plugins");
        assert!(plugins
            .iter()
            .any(|entry| entry["serviceId"] == json!("linear")));
        assert_eq!(result["nextCursor"], serde_json::Value::Null);
        for bad in [json!(["query", ""]), json!({}), json!({ "query": "   " })] {
            let error = search(crate::kernel::shared::HostRequestPayload {
                data: bad,
                cell_source_code: None,
            })
            .await
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                "mcp.search_plugins requires a non-empty query"
            );
        }
        let error = search(crate::kernel::shared::HostRequestPayload {
            data: json!({ "query": "linear", "limit": -3 }),
            cell_source_code: None,
        })
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "mcp host request limit must be a positive integer"
        );
    }

    #[tokio::test]
    async fn list_connections_host_handler_serves_the_inventory() {
        let mut user_servers = HashMap::new();
        user_servers.insert(
            "fixture-echo".to_string(),
            McpServerConfig::Stdio {
                command: "python3".to_string(),
                args: Some(vec!["fixtures/mcp_echo_server.py".to_string()]),
                cwd: None,
                env: None,
                enabled: None,
                enabled_tools: None,
                disabled_tools: None,
                startup_timeout_ms: None,
                call_timeout_ms: None,
            },
        );
        let manager = std::sync::Arc::new(std::sync::Mutex::new(manager_with(Some(user_servers))));
        manager
            .lock()
            .unwrap()
            .replace_acp_servers(
                &[AcpMcpServerConfig::Stdio {
                    name: "session-tool".to_string(),
                    command: "run".to_string(),
                    args: vec![],
                    cwd: "/tmp".to_string(),
                    env: HashMap::new(),
                }],
                "client-a",
            )
            .unwrap();
        let mut handlers = HostRequestHandlers::default();
        McpManager::register_host_handlers(&manager, &mut handlers);
        let list_connections = handlers.get("mcp.list_connections").expect("wired").clone();
        let result = list_connections(crate::kernel::shared::HostRequestPayload {
            data: json!({}),
            cell_source_code: None,
        })
        .await
        .unwrap();
        let connections = result["connections"].as_array().expect("connections");
        let mut ids = Vec::new();
        for entry in connections {
            assert!(entry["connectionId"]
                .as_str()
                .is_some_and(|id| !id.is_empty()));
            assert!(entry["status"].as_str().is_some());
            assert!(entry["transport"].as_str().is_some());
            ids.push(entry["connectionId"].as_str().unwrap().to_string());
        }
        let mut sorted_ids = ids.clone();
        sorted_ids.sort();
        assert_eq!(ids, sorted_ids, "connection rows sort by connectionId");
        assert!(ids.contains(&"fixture-echo".to_string()));
        assert!(ids.contains(&"session-tool".to_string()));
        let acp_row = connections
            .iter()
            .find(|entry| entry["connectionId"] == json!("session-tool"))
            .expect("the acp row");
        assert_eq!(acp_row["status"], json!("connected"));
        assert_eq!(acp_row["transport"], json!("stdio"));
        assert_eq!(acp_row["source"], json!("acp"));
        for entry in connections {
            assert_ne!(entry["status"], json!("setup_required"));
        }
    }
}
