//! Host side of MCP integrations. The protocol itself runs Python-side in the
//! kernel; the host only gates integration skills by auth and serves `mcp.*`
//! host requests. Port of core/mcp/mcp-manager.ts plus the TS MCP catalog
//! (the OAuth flow lives in the `oauth*` submodules).

mod catalog_plugin_views;
mod catalog_schema;
mod catalog_status_views;
mod catalog_views;
mod connection_store;
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

pub use catalog_views::{
    mcp_credential_field_prompt_label, mcp_paste_credential, McpPasteCredential,
};
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

/// Session-scoped server supplied by the active ACP client. This is the
/// TS `AcpMcpServerConfig` wire shape (core/mcp/acp-mcp-types.ts): literal
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
    pub fn name(&self) -> &str {
        match self {
            AcpMcpServerConfig::Stdio { name, .. } | AcpMcpServerConfig::Http { name, .. } => name,
        }
    }
}

/// A resolved integration: catalog/user entry plus auth state.
#[derive(Debug, Clone)]
pub(crate) struct ResolvedIntegration {
    pub(crate) server: String,
    pub(crate) label: String,
    pub(crate) config: McpServerConfig,
    pub(crate) uses_oauth: bool,
    /// True when this came from the `mcpServers` setting.
    pub(crate) user_declared: bool,
    /// Catalog entries only: the parent service id (records keep it).
    pub(crate) catalog_service_id: Option<String>,
    /// Catalog token services only: the entry collects exactly ONE
    /// credential (alternative field names collapse to one prompt), so a
    /// stored `mcp_static_token` credential under this exact id is a valid
    /// credential source — bound to this endpoint.
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
    /// The agent dir: connection records (`mcp-connections.json`) and the
    /// default local source (`mcp-services.json`) live here. `None` in
    /// embedded hosts (in-memory records, no local source).
    pub agent_dir: Option<std::path::PathBuf>,
    /// Declared local service-catalog sources (settings
    /// `mcpCatalogSources`, ~-relative allowed); re-read on refresh.
    pub get_catalog_sources: Option<Box<dyn Fn() -> Vec<String> + Send + Sync>>,
    /// The remote plugins-catalog snapshot source; defaults to the disk
    /// cache then the packaged bundled snapshot. Never fetches — the
    /// fetch/cadence layer owns writing the cache.
    pub remote_source: Option<manager_catalog::RemoteCatalogSourceFn>,
    /// Injectable verification probe (tests); the real streamable-HTTP
    /// handshake by default.
    pub probe_override: Option<probe::McpEndpointProbe>,
}

/// Telemetry usage reporter for MCP connector activity: called with
/// `(action, server)` on every successful `mcp.*` host request. Server name
/// only — never tool names, arguments, or results. Set by the session engine
/// before host handlers register (the wire handlers capture it).
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
    /// Whether the last resolution had a validated remote catalog snapshot
    /// in hand (the fetch lane's last-good cache or the packaged bundle):
    /// the pinned-definition hint claims a service left the catalog, so it
    /// renders only when a snapshot can prove that.
    catalog_available: bool,
    connection_store: std::sync::Arc<std::sync::Mutex<connection_store::McpConnectionStore>>,
    acp_servers: std::sync::Arc<std::sync::Mutex<HashMap<String, AcpMcpServerConfig>>>,
    acp_owner_id: std::sync::Mutex<Option<String>>,
}

impl McpManager {
    /// Set the telemetry usage reporter (session engine wiring; see
    /// [`McpUsageReporter`]). Must run before
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
            service_catalog: Default::default(),
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

    /// The resolved integrations (login resolution and status displays).
    pub(crate) fn integrations(&self) -> &HashMap<String, ResolvedIntegration> {
        &self.integrations
    }

    /// The shared auth store the login flow persists into.
    pub(crate) fn auth_storage_handle(&self) -> Arc<tokio::sync::Mutex<AuthStorage>> {
        Arc::clone(&self.auth_storage)
    }

    /// Wire (or clear) the interactive login behind the
    /// `mcp.begin_login` host request. Hosts with a login UI set it
    /// before the session registers host handlers.
    pub fn set_begin_login(&mut self, begin_login: Option<BeginLoginFn>) {
        self.begin_login = begin_login;
    }

    fn resolve_integrations(&mut self) {
        self.resolve_integrations_over_catalog();
    }

    pub fn can_release_acp_servers(&self, owner_id: &str) -> bool {
        self.acp_owner_id
            .lock()
            .unwrap()
            .as_deref()
            .is_none_or(|owner| owner == owner_id)
    }

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

    /// True when valid credentials exist for the integration (drives
    /// enablement; TS `isAuthed` over the resolved catalog).
    fn is_authed(&self, integration: &ResolvedIntegration) -> bool {
        if integration.blocked_reason.is_some() {
            return false;
        }
        if !integration.config.is_enabled() {
            return false;
        }
        // A bundled catalog service owns its name; a shadowing user entry
        // is dead by design so its token can never replay against the
        // official endpoint.
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
            // Catalog entry without OAuth: credential-free dispatch ONLY
            // for an explicitly public no-auth, setup-ready descriptor. A
            // token service additionally accepts its STORED pasted static
            // token — bound to this exact id and endpoint. Everything else
            // (no stored token, unbound token, or a non-token service with
            // a stray credential) fails closed. Credential binding is never
            // inferred from setup field ids: the env vars the fields NAME
            // are never read as credential sources.
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
            // The configured env var is the ONLY credential source for this
            // server: when it is unset, a stale OAuth credential stored
            // under the same id must never authorize dispatch.
            return std::env::var(env_var).is_ok_and(|value| !value.trim().is_empty());
        }
        // ONE shared grant-usability rule (with the view states): typed
        // oauth, non-empty access, endpoint binding, and no
        // expired-without-refresh state.
        super::mcp::catalog_views::oauth_grant_usable(credential.as_ref(), url).is_ok()
    }

    fn auth_storage_blocking_snapshot(&self) -> serde_json::Map<String, Value> {
        // The auth storage data map, read without refresh side effects.
        let storage = self.auth_storage.clone();
        let handle = storage.blocking_lock();
        let all = handle.get_all();
        match serde_json::to_value(&all) {
            Ok(Value::Object(map)) => map,
            _ => Default::default(),
        }
    }

    /// Auth gating the system prompt and resource loader need, as one shared
    /// source: `-<server>/SKILL.md` overrides for built-in integrations the user
    /// is not logged into, plus the enabled persistent generic servers (prompt
    /// MCP guidance). Returns the manager the caller keeps for `mcp.*` host
    /// requests.
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

    /// Register the `mcp.*` host-request handlers onto a handler map.
    pub fn register_host_handlers(&self, handlers: &mut HostRequestHandlers) {
        let auth = self.auth_storage.clone();
        let acp_servers = self.acp_servers.clone();
        let usage_refresh = self.usage_report.clone();
        let acp_servers_for_config = self.acp_servers.clone();
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
                    // Re-read the file first: a login from another process
                    // (the interactive client's `/mcp login`) wrote the
                    // credential after this manager cached its store. The
                    // TS manager shares one in-process store; the daemon
                    // worker's store must not serve the stale snapshot.
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
        let integrations = self.integrations.clone();
        let usage_config = self.usage_report.clone();
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
                        // A catalog service: the kernel dispatches it through
                        // the same generic API once the host resolves it.
                        // The static-token marker tells the kernel which
                        // credential store the bearer comes from; a
                        // disabled/blocked entry never dispatches.
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
        if let Some(begin_login) = self.begin_login.clone() {
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
    }

    /// Session-scoped servers supplied by the active ACP client.
    pub fn get_acp_servers(&self) -> Vec<AcpMcpServerConfig> {
        self.acp_servers.lock().unwrap().values().cloned().collect()
    }

    /// Enabled servers available through the generic kernel API: user-
    /// declared servers plus connected catalog services (a pasted-token
    /// install or an OAuth login) — legacy builtins surface through
    /// integration skills instead.
    pub fn get_enabled_persistent_generic_servers(&self) -> Vec<String> {
        let mut servers: Vec<String> = self
            .integrations
            .values()
            .filter(|integration| {
                // Ownership/id checks first: `is_authed` reads the auth
                // store and must not run for integrations that are filtered
                // out anyway (async callers).
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

    /// The connections roster for the `/mcp` connections view: every
    /// resolved integration (built-in catalog plus user-declared servers)
    /// with its connected state, display kind, transport, and whether it
    /// surfaces through the generic kernel API (whose tools the view can
    /// list). Sorted by label.
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

/// One `/mcp` connections-view row (the daemon's `get_mcp_connections`
/// response): the roster entry plus the tool listing the kernel reported
/// for it. `tools` is `None` when the listing was unavailable (no kernel,
/// session busy) or the server failed; `error` carries the failure text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
            Default::default(),
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
        // The /mcp view's roster: built-ins with their catalog kind, user
        // stdio servers with their transport, label-sorted.
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
        // A bearer-token env server reports the TS api-key kind.
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
        // Both built-ins start disabled without credentials.
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
        // No user servers -> no generic persistent servers.
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
        assert!(!is_generic_server_name("")); // empty
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
        // Same owner, identical servers -> no change reported.
        assert!(!manager.replace_acp_servers(&servers, "client-a").unwrap());
        // Another client cannot take ownership.
        assert!(manager.replace_acp_servers(&servers, "client-b").is_err());
        assert!(!manager.can_release_acp_servers("client-b"));
        assert!(manager.can_release_acp_servers("client-a"));
        // Duplicates are rejected.
        let duplicate = vec![servers[0].clone(), servers[0].clone()];
        assert!(manager.replace_acp_servers(&duplicate, "client-a").is_err());
        // Clearing requires the owner.
        assert!(manager.replace_acp_servers(&[], "client-a").unwrap());
        assert_eq!(manager.get_acp_servers().len(), 0);
        // Owner id is required.
        assert!(manager.replace_acp_servers(&servers, "").is_err());
    }

    #[tokio::test]
    async fn config_host_handler_returns_user_stdio_server_config() {
        // The product path for a settings-declared stdio server: gating
        // enables it for the generic kernel API and `mcp.config` hands the
        // kernel the exact command/args the user declared.
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
        let manager = manager_with(Some(user_servers));
        assert_eq!(
            manager.get_enabled_persistent_generic_servers(),
            vec!["fixture-echo".to_string()]
        );
        let mut handlers = HostRequestHandlers::default();
        manager.register_host_handlers(&mut handlers);
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
        let manager = manager_with(None);
        let mut handlers = HostRequestHandlers::default();
        manager.register_host_handlers(&mut handlers);
        let config = handlers.get("mcp.config").unwrap().clone();
        // Unknown server -> empty object.
        let result = config(crate::kernel::shared::HostRequestPayload {
            data: json!({ "server": "nope" }),
            cell_source_code: None,
        })
        .await
        .unwrap();
        assert!(result.as_object().unwrap().is_empty());
        // ACP server -> config with credentialSource.
        let servers = vec![AcpMcpServerConfig::Stdio {
            name: "session-tool".to_string(),
            command: "run".to_string(),
            args: vec![],
            cwd: "/tmp".to_string(),
            env: HashMap::new(),
        }];

        manager.replace_acp_servers(&servers, "client-a").unwrap();
        let mut handlers = HostRequestHandlers::default();
        manager.register_host_handlers(&mut handlers);
        let config = handlers.get("mcp.config").unwrap().clone();
        let result = config(crate::kernel::shared::HostRequestPayload {
            data: json!({ "server": "session-tool" }),
            cell_source_code: None,
        })
        .await
        .unwrap();
        assert_eq!(result["type"], "stdio");
        assert_eq!(result["credentialSource"], "acp");
        // Missing server argument errors.
        let error = config(crate::kernel::shared::HostRequestPayload {
            data: json!({}),
            cell_source_code: None,
        })
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "mcp.config requires a server");
        // begin_login is not registered when no login is wired.
        assert!(handlers.get("mcp.begin_login").is_none());
    }
}
