//! The catalog-driven `McpManager` surface: service-catalog resolution
//! (compiled built-ins -> local sources -> remote snapshot), integrations
//! over resolved descriptors with ENDPOINT PINNING (an installed record or
//! bound credential keeps its approved endpoint even when the catalog URL
//! moves), the static-token paste install, and demand-driven verification.
//! Port of the catalog half of
//! `packages/coding-agent/src/core/mcp/mcp-manager.ts` `resolveIntegrations`
//! plus the TS `verifyMcpConnection`/static-token install flow.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use super::catalog_plugin_views::{build_plugin_views, BuildViewsInputs, McpPluginView};
use super::catalog_schema::{AuthStrategy, SetupStatus};
use super::catalog_status_views::SnapshotCredentials;
use super::catalog_views::{is_pasteable_token_service, mcp_login_eligibility};
use super::connection_store::{
    new_pending_record, McpConnectionRecord, McpConnectionStatus as RecordStatus,
    McpConnectionStore,
};
use super::probe::{McpEndpointProbe, PROBE_ERROR_UNAUTHORIZED};
use super::service_catalog::{
    default_local_catalog_source, resolve_mcp_service_catalog, LocalCatalogSource,
    McpServiceDescriptor,
};
use super::McpServerConfig;
use super::{McpManager, ResolvedIntegration};
use crate::auth::types::AuthCredential;

/// The remote catalog seam: returns the parsed snapshot when one is
/// available (the default reads the disk cache, then the bundled asset).
pub type RemoteCatalogSourceFn =
    Box<dyn Fn() -> Option<super::catalog_schema::PluginsCatalog> + Send + Sync>;

/// The paste-install outcome for the view.
#[derive(Debug, Clone, PartialEq)]
pub struct StaticTokenInstall {
    /// The endpoint the token is now bound to (the pin).
    pub endpoint: String,
    pub verified: bool,
    pub tool_count: Option<usize>,
    /// Fixed failure category when verification did not complete.
    pub error: Option<String>,
}

impl McpManager {
    /// Resolve the service catalog now: compiled built-ins, declared local
    /// sources plus the default `mcp-services.json`, the remote snapshot,
    /// and the durable pins from the connection records. Visible
    /// diagnostics never fail the resolution.
    pub(crate) fn resolve_service_catalog(&mut self) {
        let mut sources: Vec<LocalCatalogSource> = Vec::new();
        if let Some(agent_dir) = self.agent_dir.as_deref() {
            sources.push(default_local_catalog_source(agent_dir));
        }
        if let Some(declared) = &self.get_catalog_sources {
            for path in (declared)() {
                sources.push(LocalCatalogSource {
                    path: expand_tilde(&path),
                    declared: true,
                });
            }
        }
        let remote = self.remote_source.as_ref().and_then(|source| source());
        let catalog_available = remote.is_some();
        let remote_entries = remote.map(|catalog| catalog.entries);
        let records = self.connection_store.lock().unwrap().records();
        self.service_catalog =
            resolve_mcp_service_catalog(&sources, remote_entries.as_deref(), &records);
        self.catalog_available = catalog_available;
    }

    /// The resolved descriptors (host integration + view surfaces).
    pub fn service_descriptors(&self) -> &[McpServiceDescriptor] {
        &self.service_catalog.descriptors
    }

    /// The resolution diagnostics (the picker banner / host logs).
    pub fn service_catalog_diagnostics(&self) -> &[String] {
        &self.service_catalog.diagnostics
    }

    /// The manager's credential snapshot (status reads never refresh).
    pub(crate) fn credential_snapshot(&self) -> SnapshotCredentials {
        let all = self.auth_storage_blocking_snapshot();
        let credentials = all
            .iter()
            .filter_map(|(key, value)| {
                serde_json::from_value::<AuthCredential>(value.clone())
                    .ok()
                    .map(|credential| (key.clone(), credential))
            })
            .collect();
        SnapshotCredentials { credentials }
    }

    /// Records keyed by connectionId (view + status computations).
    pub(crate) fn records_by_id(&self) -> HashMap<String, McpConnectionRecord> {
        self.connection_store
            .lock()
            .unwrap()
            .records()
            .into_iter()
            .map(|record| (record.connection_id.clone(), record))
            .collect()
    }

    /// The plugin views for the `/mcp` service-catalog surface: the resolved
    /// catalog plus user-declared servers, connected-first.
    pub fn service_catalog_views(&self) -> Vec<McpPluginView> {
        let credentials = self.credential_snapshot();
        let records = self.records_by_id();
        let user_servers = (self.get_user_servers)().unwrap_or_default();
        build_plugin_views(&BuildViewsInputs {
            services: &self.service_catalog.descriptors,
            user_servers: Some(&user_servers),
            credentials: &credentials,
            records: &records,
            catalog_available: self.catalog_available,
        })
    }

    /// One descriptor by service id.
    pub fn service_descriptor(&self, service_id: &str) -> Option<&McpServiceDescriptor> {
        self.service_catalog
            .descriptors
            .iter()
            .find(|service| service.service_id == service_id)
    }

    /// Gather the paste-install inputs under a SHORT lock: the async install
    /// then runs without holding the manager mutex (the probe and the auth
    /// store await freely).
    ///
    /// # Errors
    ///
    /// Returns a human-readable error when the server is not a known
    /// service that collects exactly one pasted credential.
    ///
    /// # Panics
    ///
    /// The `expect` on the service's endpoint is unreachable: the
    /// pasteability filter already rejects services without an endpoint.
    pub fn paste_install_inputs(&self, server: &str) -> Result<PasteInstallInputs, String> {
        let token = String::new();
        let _ = token;
        let service = self
            .service_descriptor(server)
            .filter(|service| is_pasteable_token_service(service))
            .ok_or_else(|| {
                format!("{server} does not collect a single credential; it is not pasteable.")
            })?;
        let endpoint = service
            .transport
            .endpoint()
            .expect("pasteable services carry an endpoint")
            .to_string();
        Ok(PasteInstallInputs {
            server: server.to_string(),
            endpoint,
            label: service.label.clone(),
            auth_storage: self.auth_storage_handle(),
            store: std::sync::Arc::clone(&self.connection_store),
            probe: self.probe(),
        })
    }

    /// The async handles one connection acts through (credential store,
    /// records, probe): gathered under a short manager lock, used freely.
    pub fn connection_handles(&self) -> McpConnectionHandles {
        McpConnectionHandles {
            auth_storage: self.auth_storage_handle(),
            store: std::sync::Arc::clone(&self.connection_store),
        }
    }

    /// The probe seam (injected in tests; the real handshake in product).
    fn probe(&self) -> McpEndpointProbe {
        self.probe_override.clone().unwrap_or_else(|| {
            McpEndpointProbe::new(Arc::new(super::probe::ReqwestMcpProbe::default()))
        })
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default()
}

fn expand_tilde(path: &str) -> PathBuf {
    if path == "~" {
        return std::env::var("HOME").map_or_else(|_| PathBuf::from("~"), PathBuf::from);
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

/// The TS `resolveIntegrations` catalog path: every HTTP catalog service is
/// an integration whose config URL is the REPAIR endpoint (an installed
/// record or bound credential) when one exists — the endpoint pin — and the
/// catalog URL otherwise.
impl McpManager {
    pub(crate) fn resolve_integrations_over_catalog(&mut self) {
        self.resolve_service_catalog();
        // Resolution never takes the auth-store lock: construction may run
        // on an async runtime, and the durable RECORD endpoint is the pin
        // (credential-bound repair re-resolves at view/serve time).
        let credentials = SnapshotCredentials::empty();
        let records = self.records_by_id();
        let mut integrations: HashMap<String, ResolvedIntegration> = HashMap::new();
        for service in self.service_catalog.descriptors.clone() {
            if service.transport.endpoint().is_none() {
                continue;
            }
            let uses_oauth = matches!(
                service.auth_strategy,
                AuthStrategy::Oauth | AuthStrategy::Unknown
            );
            let record = records.get(&service.service_id);
            let credential = credentials.get(&format!("mcp:{}", service.service_id));
            let eligibility = mcp_login_eligibility(
                &service.service_id,
                Some(&service),
                None,
                None,
                record,
                credential,
                false,
                false,
            );
            // Token services authenticate with a pasted static token
            // credential: the marker tells the kernel where the bearer
            // comes from, and the config is only served once credentials
            // exist (is_authed).
            let static_token = is_pasteable_token_service(&service);
            let config_url = if eligibility.repair && record.is_some() {
                eligibility
                    .endpoint
                    .clone()
                    .expect("repair eligibility carries an endpoint")
            } else {
                service.transport.endpoint().expect("checked").to_string()
            };
            integrations.insert(
                service.service_id.clone(),
                ResolvedIntegration {
                    server: service.service_id.clone(),
                    label: service.label.clone(),
                    config: http_config(&config_url, uses_oauth),
                    uses_oauth,
                    user_declared: false,
                    catalog_service_id: Some(service.service_id.clone()),
                    static_token_eligible: static_token,
                    credential_free_eligible: service.auth_strategy == AuthStrategy::None
                        && service.setup.status == SetupStatus::Ready,
                    blocked_reason: None,
                },
            );
        }
        // Per-account connections (`acme-2`): each record of a catalog
        // service is its own dispatchable id with its own credentials.
        for record in records.values() {
            if record.connection_id == record.service_id {
                continue;
            }
            let Some(service) = self
                .service_catalog
                .descriptors
                .iter()
                .find(|service| service.service_id == record.service_id)
            else {
                continue;
            };
            if service.transport.endpoint().is_none() {
                continue;
            }
            if integrations.contains_key(&record.connection_id) {
                continue;
            }
            let uses_oauth = matches!(
                service.auth_strategy,
                AuthStrategy::Oauth | AuthStrategy::Unknown
            );
            let credential = credentials.get(&format!("mcp:{}", record.connection_id));
            let eligibility = mcp_login_eligibility(
                &record.connection_id,
                Some(service),
                None,
                None,
                Some(record),
                credential,
                false,
                false,
            );
            // The per-account config pins to the record endpoint when the
            // credential proves it, else the catalog URL.
            let config_url = eligibility
                .repair
                .then(|| eligibility.endpoint.clone())
                .flatten()
                .unwrap_or_else(|| service.transport.endpoint().expect("checked").to_string());
            integrations.insert(
                record.connection_id.clone(),
                ResolvedIntegration {
                    server: record.connection_id.clone(),
                    label: format!("{} ({})", service.label, record.connection_id),
                    config: http_config(&config_url, uses_oauth),
                    uses_oauth,
                    user_declared: false,
                    catalog_service_id: Some(service.service_id.clone()),
                    static_token_eligible: is_pasteable_token_service(service),
                    credential_free_eligible: service.auth_strategy == AuthStrategy::None
                        && service.setup.status == SetupStatus::Ready,
                    blocked_reason: None,
                },
            );
        }
        // User-declared servers: a legacy-builtin shadow is a dead entry
        // (disabled integration with the conflict hint); any other user
        // entry owns its id.
        let user_servers = (self.get_user_servers)().unwrap_or_default();
        for (server, config) in user_servers {
            let reserved = self
                .service_catalog
                .descriptors
                .iter()
                .find(|service| service.service_id == server && service.legacy_builtin);
            if let Some(service) = reserved {
                let ownership =
                    super::catalog_views::reserved_mcp_ownership(Some(service), Some(&config));
                for integration in integrations.values_mut() {
                    if integration.server != server
                        && integration.catalog_service_id.as_deref() != Some(server.as_str())
                    {
                        continue;
                    }
                    match &ownership {
                        super::catalog_views::ReservedOwnership::Canonical => {
                            // Settings exactly mirror the canonical entry:
                            // merge nothing (the catalog config stands).
                        }
                        super::catalog_views::ReservedOwnership::Disabled => {
                            integration.config = disabled_config(integration.config.clone());
                            integration.blocked_reason = Some("Disabled in settings.".to_string());
                        }
                        super::catalog_views::ReservedOwnership::Conflict(hint) => {
                            integration.config = disabled_config(integration.config.clone());
                            integration.blocked_reason = Some(hint.clone());
                        }
                    }
                }
                continue;
            }
            integrations.insert(
                server.clone(),
                ResolvedIntegration {
                    server: server.clone(),
                    label: server.clone(),
                    uses_oauth: super::uses_oauth(&config),
                    user_declared: true,
                    config,
                    catalog_service_id: None,
                    static_token_eligible: false,
                    credential_free_eligible: false,
                    blocked_reason: None,
                },
            );
        }
        self.integrations = integrations;
    }

    /// Whether an integration's name is a legacy-builtin reserved id.
    pub(crate) fn is_reserved_server_name(&self, server: &str) -> bool {
        self.service_catalog
            .descriptors
            .iter()
            .any(|service| service.legacy_builtin && service.service_id == server)
    }

    /// The endpoint-pinned URL of an installed connection (the pinning
    /// verifier's read; the config handler serves the same value).
    #[cfg(test)]
    pub(crate) fn integration_endpoint(&self, server: &str) -> Option<String> {
        let integration = self.integrations.get(server)?;
        match &integration.config {
            McpServerConfig::Http { url, .. } => Some(url.clone()),
            McpServerConfig::Stdio { .. } => None,
        }
    }
}

fn http_config(url: &str, uses_oauth: bool) -> McpServerConfig {
    McpServerConfig::Http {
        url: url.to_string(),
        headers: None,
        bearer_token_env_var: None,
        oauth: uses_oauth.then_some(true),
        enabled: None,
        enabled_tools: None,
        disabled_tools: None,
        startup_timeout_ms: None,
        call_timeout_ms: None,
    }
}

fn disabled_config(config: McpServerConfig) -> McpServerConfig {
    match config {
        McpServerConfig::Http { url, .. } => McpServerConfig::Http {
            url,
            headers: None,
            bearer_token_env_var: None,
            oauth: None,
            enabled: Some(false),
            enabled_tools: None,
            disabled_tools: None,
            startup_timeout_ms: None,
            call_timeout_ms: None,
        },
        other @ McpServerConfig::Stdio { .. } => other,
    }
}

impl McpManager {
    /// The telemetry usage reporter hook (server name only): the paste
    /// install and connect flows report through it.
    pub(crate) fn report_usage(&self, action: &str, server: &str) {
        if let Some(report) = &self.usage_report {
            report(action, server);
        }
    }

    /// Report a usage action (daemon-side telemetry surface).
    pub fn note_usage(&self, action: &str, server: &str) {
        self.report_usage(action, server);
    }
}

/// The async handles for one connection's install/remove flow.
#[derive(Clone)]
pub struct McpConnectionHandles {
    auth_storage: Arc<tokio::sync::Mutex<crate::auth::AuthStorage>>,
    store: Arc<std::sync::Mutex<McpConnectionStore>>,
}

/// The paste-install inputs: service identity plus the async handles.
pub struct PasteInstallInputs {
    pub server: String,
    pub endpoint: String,
    pub label: String,
    auth_storage: Arc<tokio::sync::Mutex<crate::auth::AuthStorage>>,
    store: Arc<std::sync::Mutex<McpConnectionStore>>,
    probe: McpEndpointProbe,
}

/// Install a pasted static token for a pasteable service (the inline paste
/// flow): store the credential bound to the service endpoint (the pin),
/// verify with a real handshake, and persist the record under the guard.
/// Never holds a manager mutex across the probe.
///
/// # Errors
///
/// Returns a human-readable error when the pasted token is empty or the
/// connection record cannot be written.
///
/// # Panics
///
/// Panics if the connection store mutex is poisoned.
pub async fn install_static_token(
    inputs: PasteInstallInputs,
    token: &str,
) -> Result<StaticTokenInstall, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("The pasted token is empty.".to_string());
    }
    // The credential: bound to exactly this endpoint (the pin), stored under
    // `mcp:<server>`. Setup field ids are metadata, never env vars.
    let provider_id = format!("mcp:{}", inputs.server);
    {
        let mut auth = inputs.auth_storage.lock().await;
        auth.set(
            &provider_id,
            AuthCredential::McpStaticToken {
                bearer: token.to_string(),
                endpoint: Some(inputs.endpoint.clone()),
            },
        );
    }
    // Verify with a real handshake against the pinned endpoint.
    let outcome = inputs.probe.probe(&inputs.endpoint, token).await;
    let mut record = new_pending_record(
        &inputs.server,
        &inputs.server,
        &inputs.label,
        &inputs.endpoint,
    );
    match outcome {
        Ok(tool_count) => {
            record.status = RecordStatus::Connected;
            record.verified_at = Some(now_ms());
            record.tool_count = Some(tool_count);
        }
        Err(PROBE_ERROR_UNAUTHORIZED) => {
            record.status = RecordStatus::Error;
            record.last_error = Some(PROBE_ERROR_UNAUTHORIZED.to_string());
        }
        Err(category) => {
            record.last_error = Some(category.to_string());
        }
    }
    // The guard: the stored credential must still be exactly the token we
    // probed, bound to exactly this endpoint — a rotation or logout between
    // reads discards the whole result.
    let current = {
        let auth = inputs.auth_storage.lock().await;
        auth.get_all().get(&provider_id).cloned()
    };
    let credential: Option<AuthCredential> =
        current.and_then(|value| serde_json::from_value(value).ok());
    let still_current = matches!(
        &credential,
        Some(AuthCredential::McpStaticToken { bearer, endpoint: Some(bound) })
            if bearer == token && bound == &inputs.endpoint
    );
    let mut store = inputs.store.lock().unwrap();
    let committed = store
        .apply_verify_result(record, still_current)
        .map_err(|error| format!("connection record write failed: {error}"))?;
    let committed_record = store.get(&inputs.server).cloned();
    drop(store);
    if !committed {
        return Ok(StaticTokenInstall {
            endpoint: inputs.endpoint.clone(),
            verified: false,
            tool_count: None,
            error: Some("credential-changed".to_string()),
        });
    }
    let verified = committed_record
        .as_ref()
        .is_some_and(|record| record.status == RecordStatus::Connected);
    Ok(StaticTokenInstall {
        endpoint: inputs.endpoint.clone(),
        verified,
        tool_count: committed_record
            .as_ref()
            .and_then(|record| record.tool_count),
        error: committed_record
            .as_ref()
            .and_then(|record| record.last_error.clone()),
    })
}

/// Remove one connection: delete its credential and its connection record
/// (the durable endpoint pin) in one step — the view's remove-account
/// action. Returns whether the credential was removed.
///
/// # Errors
///
/// Returns a human-readable error when the connection record cannot be
/// written.
///
/// # Panics
///
/// Panics if the connection store mutex is poisoned.
pub async fn remove_mcp_connection(
    handles: &McpConnectionHandles,
    server: &str,
) -> Result<bool, String> {
    let provider_id = format!("mcp:{server}");
    let credential_removed = {
        let mut auth = handles.auth_storage.lock().await;
        auth.remove(&provider_id);
        auth.drain_errors().is_empty()
    };
    let mut store = handles.store.lock().unwrap();
    store
        .remove(server)
        .map_err(|error| format!("connection record write failed: {error}"))?;
    Ok(credential_removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::catalog_schema::{parse_plugins_catalog, McpServiceEntry};
    use crate::mcp::catalog_views::{fresh_mcp_login_allowed, is_pasteable_token_service};
    use crate::mcp::connection_store::McpConnectionStatus as RecordStatus;
    use crate::mcp::probe::McpEndpointProbeImpl;
    use crate::mcp::probe::ProbeOutcome;
    use crate::mcp::McpManagerOptions;
    use crate::mcp::McpServerConfig;
    use std::collections::HashMap;
    use std::path::PathBuf;

    /// The REAL shipped catalog payload projected to the v2 client contract.
    const REAL_PAYLOAD: &str = include_str!("../../tests/fixtures/mcp/plugins-catalog.v2.json");

    fn real_catalog() -> crate::mcp::catalog_schema::PluginsCatalog {
        parse_plugins_catalog(REAL_PAYLOAD.as_bytes()).expect("fixture parses")
    }

    fn entry_json(server: &str, url: &str) -> serde_json::Value {
        serde_json::json!({
            "server": server, "service": server, "label": server, "url": url,
            "aliases": [],
            "transport": { "type": "http", "url": url },
            "auth": { "strategy": "oauth", "clientRegistration": "dynamic" },
            "setup": { "status": "ready" },
            "verification": { "status": "unverified" },
            "legacyBuiltin": false, "provenance": [{ "source": "prime" }],
            "oauth": { "kind": "oauth" }
        })
    }

    fn pasteable_entry_json(server: &str, url: &str) -> serde_json::Value {
        serde_json::json!({
            "server": server, "service": server, "label": server, "url": url,
            "aliases": [],
            "transport": { "type": "http", "url": url },
            "auth": { "strategy": "api_key", "clientRegistration": "unknown" },
            "setup": {
                "status": "requires-setup",
                "reason": "paste a token",
                "fields": [
                    { "id": "SERVICE_PAT_TOKEN", "label": "SERVICE_PAT_TOKEN",
                      "required": true, "kind": "bearer-token", "credentialSet": "pat" }
                ]
            },
            "verification": { "status": "unverified" },
            "legacyBuiltin": false, "provenance": [{ "source": "prime" }]
        })
    }

    fn catalog_from_entries(entries: &[serde_json::Value]) -> Vec<McpServiceEntry> {
        let doc = serde_json::json!({ "version": 2, "counts": {}, "entries": entries });
        parse_plugins_catalog(doc.to_string().as_bytes())
            .expect("test catalog parses")
            .entries
    }

    fn no_user_servers() -> Box<dyn Fn() -> Option<HashMap<String, McpServerConfig>> + Send + Sync>
    {
        Box::new(|| None)
    }

    fn manager_with_remote(agent_dir: PathBuf, remote: Vec<McpServiceEntry>) -> McpManager {
        McpManager::new(McpManagerOptions {
            // File-backed store in the agent dir: credentials persist across
            // manager instances like the product paths.
            auth_storage: crate::auth::AuthStorage::create(&agent_dir),
            get_user_servers: no_user_servers(),
            begin_login: None,
            agent_dir: Some(agent_dir),
            get_catalog_sources: None,
            remote_source: Some(Box::new(move || {
                let entries = remote.clone();
                Some(crate::mcp::catalog_schema::PluginsCatalog {
                    version: 2,
                    counts: crate::mcp::catalog_schema::CatalogCounts::default(),
                    entries,
                })
            })),
            probe_override: None,
        })
    }

    /// Resolution order, first wins per id: builtins > local > remote.
    #[test]
    fn resolution_order_builtins_local_remote() {
        let agent_dir = tempfile::tempdir().expect("tempdir");
        let local = serde_json::json!({
            "version": 1,
            "entries": [
                {
                    "server": "my-local", "service": "my-local", "label": "My Local",
                    "url": "https://my-local.example/mcp", "aliases": [],
                    "transport": { "type": "http", "url": "https://my-local.example/mcp" },
                    "auth": { "strategy": "oauth", "clientRegistration": "dynamic" },
                    "setup": { "status": "ready" },
                    "verification": { "status": "unverified" },
                    "legacyBuiltin": false,
                    "provenance": [{ "source": "user" }]
                }
            ]
        });
        std::fs::write(
            agent_dir.path().join("mcp-services.json"),
            local.to_string(),
        )
        .expect("write local source");
        let remote = catalog_from_entries(&[
            entry_json("linear", "https://evil.example/mcp"),
            entry_json("my-local", "https://remote-wins.example/mcp"),
            entry_json("remote-only", "https://remote-only.example/mcp"),
        ]);
        let manager = manager_with_remote(agent_dir.path().to_path_buf(), remote);
        let descriptors = manager.service_descriptors();
        // Builtins always present; the remote linear entry could not shadow
        // or rebind the compiled builtin.
        let linear = descriptors
            .iter()
            .find(|service| service.service_id == "linear")
            .expect("linear resolved");
        assert!(linear.legacy_builtin);
        assert_eq!(
            linear.transport.endpoint(),
            Some("https://mcp.linear.app/mcp"),
            "the compiled builtin wins over the remote entry"
        );
        // Local source wins per id over the remote catalog; the shadowed
        // remote entry surfaces as a diagnostic (never silently rebinds).
        let my_local = descriptors
            .iter()
            .find(|service| service.service_id == "my-local")
            .expect("local entry resolved");
        assert!(
            my_local.local_source,
            "diagnostics: {:?}",
            manager.service_catalog_diagnostics()
        );
        assert_eq!(
            my_local.transport.endpoint(),
            Some("https://my-local.example/mcp")
        );
        assert!(
            manager
                .service_catalog_diagnostics()
                .iter()
                .any(|diagnostic| diagnostic.contains("my-local")),
            "the id collision is visible: {:?}",
            manager.service_catalog_diagnostics()
        );
        // Remote entries resolve as discovery-only.
        assert!(descriptors
            .iter()
            .any(|service| service.service_id == "remote-only"));
        // The remote-only entry is never connectable through a user server
        // shadow until the user owns the id (dead shadows are dropped in
        // views) — and fresh login only runs on ready, oauth, concrete
        // entries.
        let remote_only = descriptors
            .iter()
            .find(|service| service.service_id == "remote-only")
            .expect("remote-only");
        assert!(fresh_mcp_login_allowed(remote_only));
    }

    /// Local sources cannot shadow a bundled id: a local `linear` entry is
    /// refused at load time with a visible diagnostic (TS loader parity).
    #[test]
    fn local_sources_cannot_shadow_builtins() {
        let agent_dir = tempfile::tempdir().expect("tempdir");
        let local = serde_json::json!({
            "version": 1,
            "entries": [
                {
                    "server": "linear", "service": "linear", "label": "Fake Linear",
                    "url": "https://evil.example/mcp", "aliases": [],
                    "transport": { "type": "http", "url": "https://evil.example/mcp" },
                    "auth": { "strategy": "oauth", "clientRegistration": "dynamic" },
                    "setup": { "status": "ready" },
                    "verification": { "status": "unverified" },
                    "legacyBuiltin": false,
                    "provenance": [{ "source": "user" }]
                }
            ]
        });
        std::fs::write(
            agent_dir.path().join("mcp-services.json"),
            local.to_string(),
        )
        .expect("write local source");
        let manager = manager_with_remote(agent_dir.path().to_path_buf(), Vec::new());
        let linear = manager
            .service_descriptor("linear")
            .expect("linear still resolves");
        assert_eq!(
            linear.transport.endpoint(),
            Some("https://mcp.linear.app/mcp"),
            "the compiled builtin is never shadowed"
        );
        assert!(
            manager
                .service_catalog_diagnostics()
                .iter()
                .any(|diagnostic| diagnostic.contains("collides with the bundled catalog entry")),
            "the refusal is visible: {:?}",
            manager.service_catalog_diagnostics()
        );
    }

    /// ENDPOINT PINNING: an installed connection keeps its approved record
    /// endpoint even when the catalog URL changes afterwards — for config
    /// serving (dispatch), for views, and for management.
    #[test]
    fn installed_connections_are_endpoint_pinned_across_catalog_url_changes() {
        let agent_dir = tempfile::tempdir().expect("tempdir");
        let endpoint_a = "https://service-a.example/mcp";
        let endpoint_b = "https://service-b.example/mcp";
        // Install a connected record at endpoint A.
        let mut manager = manager_with_remote(
            agent_dir.path().to_path_buf(),
            catalog_from_entries(&[entry_json("pinned-service", endpoint_a)]),
        );
        let mut store = manager.connection_store.lock().unwrap();
        store
            .upsert(new_pending_record(
                "pinned-service",
                "pinned-service",
                "pinned-service",
                endpoint_a,
            ))
            .map_err(|_| ())
            .unwrap();
        // Make the record connected (a verified handshake in the past) and
        // store the OAuth grant the handshake proved, bound to endpoint A.
        {
            let mut record = store.get("pinned-service").cloned().unwrap();
            record.status = RecordStatus::Connected;
            record.verified_at = Some(now_ms());
            store.upsert(record).map_err(|_| ()).unwrap();
        }
        drop(store);
        {
            let storage = manager.auth_storage_handle();
            let mut auth = futures::executor::block_on(storage.lock());
            auth.set(
                "mcp:pinned-service",
                AuthCredential::Oauth {
                    access: "pinned-access".to_string(),
                    refresh: Some("pinned-refresh".to_string()),
                    expires: (now_ms() as i64) + 3_600_000,
                    account_id: None,
                    endpoint: Some(endpoint_a.to_string()),
                    token_endpoint: None,
                    client_id: None,
                    resource: None,
                    issuer: None,
                    enterprise_url: None,
                },
            );
        }
        // Re-resolve at endpoint A: the integration serves A.
        manager.refresh();
        assert_eq!(
            manager.integration_endpoint("pinned-service").as_deref(),
            Some(endpoint_a),
            "dispatch config serves the installed endpoint"
        );
        // The catalog moves to endpoint B.
        let manager = {
            std::mem::drop(manager);
            manager_with_remote(
                agent_dir.path().to_path_buf(),
                catalog_from_entries(&[entry_json("pinned-service", endpoint_b)]),
            )
        };
        // The connection keeps its approved endpoint for BOTH dispatch and
        // management — even though the catalog URL changed.
        assert_eq!(
            manager.integration_endpoint("pinned-service").as_deref(),
            Some(endpoint_a),
            "the pin survives the catalog URL change"
        );
        // And the record remains manageable: the roster still lists it.
        let roster = manager.connection_roster();
        let pinned = roster
            .iter()
            .find(|entry| entry.server == "pinned-service")
            .expect("the pinned connection stays manageable");
        assert!(pinned.connected);
    }

    /// A vanished source keeps a durable pin built from the record: the
    /// connection stays manageable and is NEVER one-click connectable.
    #[test]
    fn vanished_sources_pin_from_the_record_and_stay_manageable() {
        let agent_dir = tempfile::tempdir().expect("tempdir");
        let endpoint = "https://vanished.example/mcp";
        let manager = manager_with_remote(
            agent_dir.path().to_path_buf(),
            catalog_from_entries(&[entry_json("vanished-service", endpoint)]),
        );
        let mut store = manager.connection_store.lock().unwrap();
        store
            .upsert(new_pending_record(
                "vanished-service",
                "vanished-service",
                "Vanished",
                endpoint,
            ))
            .map_err(|_| ())
            .unwrap();
        drop(store);
        // The catalog source vanishes entirely.
        let manager = manager_with_remote(agent_dir.path().to_path_buf(), Vec::new());
        let pinned = manager
            .service_descriptor("vanished-service")
            .expect("pinned from the record");
        assert!(pinned.pinned_from_record);
        assert_eq!(pinned.transport.endpoint(), Some(endpoint));
        // Never one-click connectable, but still manageable (roster row).
        assert!(!fresh_mcp_login_allowed(pinned));
        let roster = manager.connection_roster();
        assert!(
            roster
                .iter()
                .any(|entry| entry.server == "vanished-service"),
            "the pinned connection stays manageable (verify/disconnect)"
        );
        // The pinned service is NOT offered as pasteable (it is ready-shaped).
        assert!(!is_pasteable_token_service(pinned));
    }

    /// The pinned-definition hint needs PROOF: a record whose service is
    /// missing from a VALIDATED remote snapshot is genuinely gone (TS's
    /// always-in-hand catalog proves the same absence), so the card shows
    /// the byte-exact TS hint.
    #[test]
    fn pinned_hint_shows_when_a_snapshot_proves_the_service_gone() {
        let agent_dir = tempfile::tempdir().expect("tempdir");
        let endpoint = "https://vanished.example/mcp";
        let mut manager = manager_with_remote(
            agent_dir.path().to_path_buf(),
            catalog_from_entries(&[entry_json(
                "unrelated-service",
                "https://unrelated.example/mcp",
            )]),
        );
        {
            let mut store = manager.connection_store.lock().unwrap();
            store
                .upsert(new_pending_record(
                    "vanished-service",
                    "vanished-service",
                    "Vanished",
                    endpoint,
                ))
                .map_err(|_| ())
                .unwrap();
        }
        manager.refresh();
        let view = manager
            .service_catalog_views()
            .into_iter()
            .find(|view| view.service_id == "vanished-service")
            .expect("pinned row");
        assert_eq!(
            view.setup_hint.as_deref(),
            Some(crate::mcp::catalog_plugin_views::PINNED_FROM_RECORD_HINT),
        );
    }

    /// Without a validated snapshot (the fetch never ran, failed, or the
    /// bundle is missing) a pinned record CANNOT prove its source is
    /// unavailable — TS always has its catalog in hand and never claims
    /// absence it cannot prove, so the card stays silent while the pin
    /// keeps the connection manageable and never one-click connectable.
    #[test]
    fn pinned_hint_stays_silent_without_a_snapshot() {
        let agent_dir = tempfile::tempdir().expect("tempdir");
        let endpoint = "https://vanished.example/mcp";
        let mut manager = McpManager::new(McpManagerOptions {
            auth_storage: crate::auth::AuthStorage::create(agent_dir.path()),
            get_user_servers: no_user_servers(),
            begin_login: None,
            agent_dir: Some(agent_dir.path().to_path_buf()),
            get_catalog_sources: None,
            remote_source: Some(Box::new(|| None)),
            probe_override: None,
        });
        {
            let mut store = manager.connection_store.lock().unwrap();
            store
                .upsert(new_pending_record(
                    "vanished-service",
                    "vanished-service",
                    "Vanished",
                    endpoint,
                ))
                .map_err(|_| ())
                .unwrap();
        }
        manager.refresh();
        let view = manager
            .service_catalog_views()
            .into_iter()
            .find(|view| view.service_id == "vanished-service")
            .expect("the pinned row stays manageable");
        assert_ne!(
            view.setup_hint.as_deref(),
            Some(crate::mcp::catalog_plugin_views::PINNED_FROM_RECORD_HINT),
            "no snapshot in hand means no source-unavailable claim"
        );
        assert!(!view.connectable, "a pin is never one-click connectable");
    }

    /// A snapshot that still defines the service is not a pin at all: the
    /// record resolves against the catalog and no hint renders.
    #[test]
    fn pinned_hint_stays_hidden_when_the_snapshot_defines_the_service() {
        let agent_dir = tempfile::tempdir().expect("tempdir");
        let endpoint = "https://lives-on.example/mcp";
        let mut manager = manager_with_remote(
            agent_dir.path().to_path_buf(),
            catalog_from_entries(&[entry_json("lives-on", endpoint)]),
        );
        {
            let mut store = manager.connection_store.lock().unwrap();
            store
                .upsert(new_pending_record(
                    "lives-on", "lives-on", "Lives On", endpoint,
                ))
                .map_err(|_| ())
                .unwrap();
        }
        manager.refresh();
        let resolved = manager
            .service_descriptor("lives-on")
            .expect("resolved from the catalog");
        assert!(!resolved.pinned_from_record);
        let view = manager
            .service_catalog_views()
            .into_iter()
            .find(|view| view.service_id == "lives-on")
            .expect("catalog row");
        assert_ne!(
            view.setup_hint.as_deref(),
            Some(crate::mcp::catalog_plugin_views::PINNED_FROM_RECORD_HINT),
            "a service the snapshot defines never renders the pin hint"
        );
    }

    /// A fake probe: records the (url, token) pairs it verified in a shared
    /// log the test asserts over.
    struct FakeProbe {
        log: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>,
        tool_count: usize,
    }

    impl McpEndpointProbeImpl for FakeProbe {
        fn probe_dyn(
            &self,
            url: &str,
            token: &str,
        ) -> futures::future::BoxFuture<'static, ProbeOutcome> {
            self.log
                .lock()
                .unwrap()
                .push((url.to_string(), token.to_string()));
            let tool_count = self.tool_count;
            Box::pin(async move { Ok(tool_count) })
        }
    }

    /// The paste flow e2e (manager level): a bearer-token service installs
    /// end-to-end — credential stored bound to the endpoint, real handshake
    /// run, record persisted connected, and the views reflect it.
    #[tokio::test]
    async fn paste_flow_installs_a_bearer_token_service_end_to_end() {
        let agent_dir = tempfile::tempdir().expect("tempdir");
        let endpoint = "https://paste-service.example/mcp";
        let remote = catalog_from_entries(&[pasteable_entry_json("paste-service", endpoint)]);
        let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let probe = McpEndpointProbe::new(std::sync::Arc::new(FakeProbe {
            log: std::sync::Arc::clone(&log),
            tool_count: 3,
        }));
        let probe_for_inputs = probe.clone();
        let manager =
            std::sync::Arc::new(std::sync::Mutex::new(McpManager::new(McpManagerOptions {
                auth_storage: crate::auth::AuthStorage::in_memory(
                    crate::auth::types::AuthStorageData::default(),
                    std::sync::Arc::new(crate::auth::manager::NoOAuth),
                ),
                get_user_servers: no_user_servers(),
                begin_login: None,
                agent_dir: Some(agent_dir.path().to_path_buf()),
                get_catalog_sources: None,
                remote_source: Some(Box::new(move || {
                    let entries = remote.clone();
                    Some(crate::mcp::catalog_schema::PluginsCatalog {
                        version: 2,
                        counts: crate::mcp::catalog_schema::CatalogCounts::default(),
                        entries,
                    })
                })),
                probe_override: Some(probe_for_inputs),
            })));
        // The pre-install view: setup_required with the paste marker.
        let views = {
            let manager = std::sync::Arc::clone(&manager);
            tokio::task::spawn_blocking(move || manager.lock().unwrap().service_catalog_views())
                .await
                .expect("blocking view read")
        };
        let before = views
            .iter()
            .find(|view| view.service_id == "paste-service")
            .expect("discovery row");
        assert_eq!(
            before.connection_status.as_str(),
            crate::mcp::catalog_status_views::McpConnectionStatus::SetupRequired.as_str()
        );
        assert_eq!(before.paste_token, Some(true));
        assert!(before
            .setup_hint
            .as_deref()
            .is_some_and(|hint| hint.contains("paste")));
        // Install: paste a token for the service.
        let inputs = manager
            .lock()
            .unwrap()
            .paste_install_inputs("paste-service")
            .expect("the service is pasteable");
        assert_eq!(inputs.endpoint, endpoint);
        let install = install_static_token(inputs, "ghp_pasted-token-value")
            .await
            .expect("install completes");
        assert!(install.verified, "verified: {:?}", install.error);
        assert_eq!(
            install.endpoint, endpoint,
            "the token is pinned to the endpoint"
        );
        assert_eq!(install.tool_count, Some(3));
        // The probe verified exactly the service endpoint with the token.
        let probed = log.lock().unwrap().clone();
        assert_eq!(
            probed,
            vec![(endpoint.to_string(), "ghp_pasted-token-value".to_string())]
        );
        // The post-install view: connected, with the record's verification.
        // The view reads snapshot the auth store (blocking) — the daemon
        // wraps them in spawn_blocking; the test does the same.
        let (views, roster, credential) = {
            let manager = std::sync::Arc::clone(&manager);
            tokio::task::spawn_blocking(move || {
                manager.lock().unwrap().refresh();
                let views = manager.lock().unwrap().service_catalog_views();
                let roster = manager.lock().unwrap().connection_roster();
                let credential = manager
                    .lock()
                    .unwrap()
                    .credential_snapshot()
                    .get("mcp:paste-service")
                    .cloned();
                (views, roster, credential)
            })
            .await
            .expect("blocking view read")
        };
        let after = views
            .iter()
            .find(|view| view.service_id == "paste-service")
            .expect("row after install");
        assert_eq!(after.connection_status.as_str(), "connected");
        assert_eq!(after.connection_ids, vec!["paste-service".to_string()]);
        assert_eq!(after.tool_count, Some(3));
        // The roster shows the connection connected and generic.
        let entry = roster
            .iter()
            .find(|entry| entry.server == "paste-service")
            .expect("roster row");
        assert!(entry.connected);
        assert!(
            entry.generic,
            "the kernel dispatches it through the generic API"
        );
        // The credential: typed, bound to the endpoint.
        let credential = credential.expect("credential stored");
        match credential {
            AuthCredential::McpStaticToken {
                bearer,
                endpoint: bound,
            } => {
                assert_eq!(bearer, "ghp_pasted-token-value");
                assert_eq!(bound.as_deref(), Some(endpoint));
            }
            other => panic!("wrong credential type: {other:?}"),
        }
        // A multi-credential service is NOT pasteable (fail closed).
        let two_cred = serde_json::json!({
            "server": "two-cred", "service": "two-cred", "label": "Two",
            "url": "https://two.example/mcp", "aliases": [],
            "transport": { "type": "http", "url": "https://two.example/mcp" },
            "auth": { "strategy": "api_key", "clientRegistration": "unknown" },
            "setup": {
                "status": "requires-setup", "reason": "two secrets",
                "fields": [
                    { "id": "A_KEY", "label": "A", "required": true,
                      "kind": "bearer-token", "credentialSet": "cred-a" },
                    { "id": "B_KEY", "label": "B", "required": true,
                      "kind": "api-key", "credentialSet": "cred-b" }
                ]
            },
            "verification": { "status": "unverified" },
            "legacyBuiltin": false, "provenance": [{ "source": "prime" }]
        });
        let entries = catalog_from_entries(&[two_cred]);
        for entry in &entries {
            let descriptor =
                crate::mcp::service_catalog::McpServiceDescriptor::from_entry(entry, false);
            assert!(
                !is_pasteable_token_service(&descriptor),
                "fail closed on two distinct credentials"
            );
        }
    }

    /// The GitHub alias pair from the REAL payload resolves to exactly ONE
    /// credential (credentialSet aliasing), and the derived prompt label
    /// reads "GitHub personal access token".
    #[test]
    fn real_github_entry_is_pasteable_with_one_aliased_credential() {
        let catalog = real_catalog();
        let github = catalog
            .entries
            .iter()
            .find(|entry| entry.server == "github")
            .expect("github");
        let descriptor =
            crate::mcp::service_catalog::McpServiceDescriptor::from_entry(github, false);
        assert!(is_pasteable_token_service(&descriptor));
        let pasted =
            crate::mcp::catalog_views::mcp_paste_credential(&descriptor).expect("one credential");
        assert_eq!(pasted.field.id, "GITHUB_PAT_TOKEN");
        assert_eq!(
            pasted.field_ids,
            vec![
                "GITHUB_PAT_TOKEN".to_string(),
                "GITHUB_PERSONAL_ACCESS_TOKEN".to_string()
            ]
        );
        assert_eq!(
            crate::mcp::catalog_views::mcp_credential_field_prompt_label(
                &descriptor,
                &pasted.field
            ),
            "GitHub personal access token"
        );
    }

    /// The full real catalog flows through the manager: 68 descriptors
    /// resolve (builtins first, discovery rows connected-first).
    #[test]
    fn the_real_catalog_resolves_through_the_manager() {
        let agent_dir = tempfile::tempdir().expect("tempdir");
        let manager = manager_with_remote(agent_dir.path().to_path_buf(), real_catalog().entries);
        assert_eq!(manager.service_descriptors().len(), 68);
        // Both legacy builtins present and reserved.
        assert!(manager.is_reserved_server_name("linear"));
        assert!(manager.is_reserved_server_name("notion"));
        assert!(!manager.is_reserved_server_name("github"));
        // All 68 http services resolve integrations with configs.
        assert_eq!(
            manager
                .connection_roster()
                .iter()
                .filter(|entry| !entry.user_declared)
                .count(),
            68
        );
    }
}
