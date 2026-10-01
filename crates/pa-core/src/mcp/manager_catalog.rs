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

use super::catalog_plugin_views::{
    build_connection_views, build_plugin_views, AcpServerRow, BuildViewsInputs, McpCredentialView,
    McpPluginView, API_KEY_CREDENTIALS,
};
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

    /// The `/mcp` view's api-key credential rows (the credential catalog
    /// served alongside the MCP connections): one row per catalog entry,
    /// configured when the shared auth store holds an API key at its slot.
    pub fn api_key_credential_views(&self) -> Vec<McpCredentialView> {
        let credentials = self.credential_snapshot();
        API_KEY_CREDENTIALS
            .iter()
            .map(|(id, label)| McpCredentialView {
                id: (*id).to_string(),
                label: (*label).to_string(),
                configured: credentials
                    .credentials
                    .get(*id)
                    .is_some_and(|credential| matches!(credential, AuthCredential::ApiKey { .. })),
            })
            .collect()
    }

    /// The kernel connection inventory for `mcp.list_connections` (TS
    /// `buildConnectionViews`): the resolved services plus user-declared
    /// servers plus the session-scoped ACP servers, one row per
    /// dispatchable account.
    pub fn service_catalog_connection_views(
        &self,
        acp_servers: &[super::AcpMcpServerConfig],
    ) -> Vec<super::catalog_plugin_views::McpConnectionView> {
        let credentials = self.credential_snapshot();
        let records = self.records_by_id();
        let user_servers = (self.get_user_servers)().unwrap_or_default();
        build_connection_views(
            &BuildViewsInputs {
                services: &self.service_catalog.descriptors,
                user_servers: Some(&user_servers),
                credentials: &credentials,
                records: &records,
                catalog_available: self.catalog_available,
            },
            &AcpServerRow::from_configs(acp_servers),
        )
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
        .apply_verify_result(&record, still_current)
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

// The unit battery lives in the child module (manager_catalog::tests);
// its use-super glob resolves through this facade's bindings and re-exports.
#[cfg(test)]
mod tests;
