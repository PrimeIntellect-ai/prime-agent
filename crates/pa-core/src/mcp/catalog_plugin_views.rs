//! Cards for the service-catalog view: the shared projection of resolved catalog services and
//! user-declared MCP servers. No secrets ever leave this module.

use std::collections::HashMap;

use super::catalog_schema::{AuthStrategy, SetupStatus};
use super::catalog_status_views::{
    account_states_for, http_connection_status, HttpStatusOptions, McpConnectionStatus,
    SnapshotCredentials,
};
use super::catalog_views::{
    fresh_mcp_login_allowed, is_pasteable_token_service, mcp_login_eligibility,
    reserved_mcp_ownership, ReservedOwnership,
};
use super::connection_store::McpConnectionRecord;
use super::service_catalog::{DescriptorTransport, McpServiceDescriptor};
use super::McpServerConfig;

/// The pinned-definition hint: shown when a connection record outlives its catalog entry. The claim
/// "the catalog source is unavailable" is honest only when a validated remote catalog snapshot is
/// in hand — unlike TS, which always has one.
pub(crate) const PINNED_FROM_RECORD_HINT: &str =
    "This service's catalog source is unavailable; its connection keeps the pinned definition.";

/// One card for the service-catalog view.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPluginView {
    /// Catalog service id, or the user server name.
    pub service_id: String,
    pub label: String,
    pub connection_status: McpConnectionStatus,
    /// True when the service can be connected through the host OAuth flow
    /// right now.
    pub connectable: bool,
    pub add_account_allowed: Option<bool>,
    /// Active login ownership, distinct from pending endpoint verification.
    pub login_pending: Option<bool>,
    pub uses_oauth: bool,
    pub source: ViewSource,
    /// Kernel dispatch ids; empty unless credentials make dispatch possible.
    pub connection_ids: Vec<String>,
    /// View-only marker: this row opens the inline paste panel. Never a connected/verified claim.
    pub paste_token: Option<bool>,
    /// Catalog metadata aliases (searchable; never runtime claims).
    pub aliases: Option<Vec<String>>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub publisher: Option<String>,
    pub docs_url: Option<String>,
    /// Honest requirement or failure detail; non-empty for `setup_required` and
    /// error states.
    pub setup_hint: Option<String>,
    /// True when the catalog entry itself has not been vetted.
    pub unverified: Option<bool>,
    /// From the connection record, when connected.
    pub verified_at: Option<u64>,
    pub tool_count: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewSource {
    Catalog,
    User,
    Acp,
}

/// Inputs for the view builders.
pub struct BuildViewsInputs<'a> {
    pub services: &'a [McpServiceDescriptor],
    pub user_servers: Option<&'a HashMap<String, McpServerConfig>>,
    pub credentials: &'a SnapshotCredentials,
    pub records: &'a HashMap<String, McpConnectionRecord>,
    /// A validated remote catalog snapshot is in hand: the pinned-definition hint renders only when
    /// a snapshot can PROVE the service left the catalog.
    pub catalog_available: bool,
}

fn not_connected_catalog_view(service: &McpServiceDescriptor) -> McpPluginView {
    let http = service.transport.endpoint().map(str::to_string);
    let setup_hint: Option<String> = match service.setup.status {
        SetupStatus::RequiresSetup => Some(service.setup.reason.clone().unwrap_or_else(|| {
            "This service requires manual setup before it can be connected.".to_string()
        })),
        SetupStatus::Ready if http.is_none() => Some(
            "This service uses a stdio adapter or a tenant URL template. Add it manually with /mcp add."
                .to_string(),
        ),
        SetupStatus::Ready if service.auth_strategy == AuthStrategy::ApiKey => Some(
            "This service requires an API key. Add it manually with /mcp add.".to_string(),
        ),
        SetupStatus::Ready if service.auth_strategy == AuthStrategy::None => Some(
            "No login required. Add it manually with /mcp add to use it.".to_string(),
        ),
        SetupStatus::Ready if !service.metadata_reviewed => Some(
            "OAuth support has not been verified. Connect checks capabilities and asks for approval before login."
                .to_string(),
        ),
        SetupStatus::Ready => None,
    };
    McpPluginView {
        service_id: service.service_id.clone(),
        label: service.label.clone(),
        connection_status: match (&service.setup.status, &http, service.auth_strategy) {
            (SetupStatus::RequiresSetup, _, _) | (_, None, _)
                if service.auth_strategy != AuthStrategy::None =>
            {
                McpConnectionStatus::SetupRequired
            }
            (_, _, AuthStrategy::ApiKey) => McpConnectionStatus::SetupRequired,
            _ => McpConnectionStatus::NotConnected,
        },
        connectable: fresh_mcp_login_allowed(service),
        add_account_allowed: Some(fresh_mcp_login_allowed(service)),
        login_pending: None,
        uses_oauth: matches!(
            service.auth_strategy,
            AuthStrategy::Oauth | AuthStrategy::Unknown
        ),
        source: ViewSource::Catalog,
        connection_ids: Vec::new(),
        // A pasteable token service opens the inline paste panel from this row.
        paste_token: is_pasteable_token_service(service).then_some(true),
        aliases: (!service.aliases.is_empty()).then(|| service.aliases.clone()),
        description: service.description.clone(),
        category: service.category.clone(),
        publisher: service.publisher.clone(),
        docs_url: service.docs_url.clone(),
        setup_hint,
        unverified: (!service.metadata_reviewed).then_some(true),
        verified_at: None,
        tool_count: None,
    }
}

fn base_catalog_service_view(
    service: &McpServiceDescriptor,
    credentials: &SnapshotCredentials,
    records: &HashMap<String, McpConnectionRecord>,
    catalog_available: bool,
) -> McpPluginView {
    if !matches!(service.transport, DescriptorTransport::Http { .. }) {
        return not_connected_catalog_view(service);
    }
    let accounts = account_states_for(service, credentials, records);
    if accounts.is_empty() {
        let mut view = not_connected_catalog_view(service);
        if service.pinned_from_record && catalog_available {
            view.setup_hint = Some(PINNED_FROM_RECORD_HINT.to_string());
        }
        return view;
    }
    let any_connected = accounts
        .iter()
        .any(|account| account.status == McpConnectionStatus::Connected);
    let any_pending = accounts
        .iter()
        .any(|account| account.status == McpConnectionStatus::Pending);
    let aggregate = if any_connected {
        McpConnectionStatus::Connected
    } else if any_pending {
        McpConnectionStatus::Pending
    } else if accounts
        .iter()
        .any(|account| account.status == McpConnectionStatus::Error)
    {
        McpConnectionStatus::Error
    } else {
        McpConnectionStatus::NotConnected
    };
    let newest_connected = accounts
        .iter()
        .filter(|account| account.status == McpConnectionStatus::Connected)
        .max_by_key(|account| account.verified_at.unwrap_or(0));
    let error_hint = accounts
        .iter()
        .find(|account| account.login_pending)
        .and_then(|account| account.setup_hint.clone())
        .or_else(|| {
            accounts
                .iter()
                .find(|account| account.status == McpConnectionStatus::Error)
                .and_then(|account| account.setup_hint.clone())
        })
        .or_else(|| {
            accounts
                .iter()
                .find(|account| account.status == McpConnectionStatus::NotConnected)
                .and_then(|account| account.setup_hint.clone())
        });
    let setup_hint = if service.pinned_from_record && catalog_available {
        Some(PINNED_FROM_RECORD_HINT.to_string())
    } else {
        error_hint
    };
    let credential_key = super::catalog_views::mcp_credential_key(&service.service_id);
    let connectable = !accounts.iter().any(|account| account.login_pending)
        && matches!(
            aggregate,
            McpConnectionStatus::Error | McpConnectionStatus::NotConnected
        )
        && mcp_login_eligibility(
            &service.service_id,
            Some(service),
            None,
            None,
            records.get(&service.service_id),
            credentials.get(&credential_key),
            false,
            false,
        )
        .allowed;
    McpPluginView {
        service_id: service.service_id.clone(),
        label: service.label.clone(),
        connection_status: aggregate,
        connectable,
        add_account_allowed: Some(
            fresh_mcp_login_allowed(service)
                && !accounts.iter().any(|account| account.login_pending),
        ),
        login_pending: accounts
            .iter()
            .any(|account| account.login_pending)
            .then_some(true),
        uses_oauth: matches!(
            service.auth_strategy,
            AuthStrategy::Oauth | AuthStrategy::Unknown
        ),
        source: ViewSource::Catalog,
        connection_ids: accounts
            .iter()
            .map(|account| account.connection_id.clone())
            .collect(),
        paste_token: is_pasteable_token_service(service).then_some(true),
        aliases: (!service.aliases.is_empty()).then(|| service.aliases.clone()),
        description: service.description.clone(),
        category: service.category.clone(),
        publisher: service.publisher.clone(),
        docs_url: service.docs_url.clone(),
        setup_hint,
        unverified: (!service.metadata_reviewed).then_some(true),
        verified_at: newest_connected.and_then(|account| account.verified_at),
        tool_count: newest_connected.and_then(|account| account.tool_count),
    }
}

fn catalog_service_view(
    service: &McpServiceDescriptor,
    credentials: &SnapshotCredentials,
    records: &HashMap<String, McpConnectionRecord>,
    reserved_config: Option<&McpServerConfig>,
    catalog_available: bool,
) -> McpPluginView {
    let mut view = base_catalog_service_view(service, credentials, records, catalog_available);
    let ownership = reserved_mcp_ownership(Some(service), reserved_config);
    match ownership {
        ReservedOwnership::Canonical => view,
        ReservedOwnership::Disabled => {
            view.connection_status = McpConnectionStatus::Disabled;
            view.connectable = false;
            view.add_account_allowed = Some(false);
            view.setup_hint = Some("Disabled in settings.".to_string());
            view
        }
        ReservedOwnership::Conflict(hint) => {
            view.connection_status = McpConnectionStatus::Error;
            view.connectable = false;
            view.add_account_allowed = Some(false);
            view.setup_hint = Some(hint);
            view
        }
    }
}

fn user_server_view(
    name: &str,
    config: &McpServerConfig,
    credentials: &SnapshotCredentials,
    records: &HashMap<String, McpConnectionRecord>,
) -> McpPluginView {
    let disabled = matches!(
        config,
        McpServerConfig::Http {
            enabled: Some(false),
            ..
        } | McpServerConfig::Stdio {
            enabled: Some(false),
            ..
        }
    );
    if let McpServerConfig::Stdio { .. } = config {
        return McpPluginView {
            service_id: name.to_string(),
            label: name.to_string(),
            connection_status: if disabled {
                McpConnectionStatus::Disabled
            } else {
                McpConnectionStatus::Connected
            },
            connectable: false,
            add_account_allowed: None,
            login_pending: None,
            uses_oauth: false,
            source: ViewSource::User,
            connection_ids: if disabled {
                Vec::new()
            } else {
                vec![name.to_string()]
            },
            paste_token: None,
            aliases: None,
            description: None,
            category: None,
            publisher: None,
            docs_url: None,
            setup_hint: disabled.then(|| "Disabled in settings.".to_string()),
            unverified: None,
            verified_at: None,
            tool_count: None,
        };
    }
    let McpServerConfig::Http {
        url,
        bearer_token_env_var,
        oauth,
        ..
    } = config
    else {
        unreachable!("stdio handled above");
    };
    let uses_oauth = *oauth == Some(true);
    let state = http_connection_status(
        &HttpStatusOptions {
            connection_id: name,
            endpoint: url,
            uses_oauth,
            bearer_token_env_var: bearer_token_env_var.as_deref(),
            static_token: false,
            declared_no_auth: !uses_oauth && bearer_token_env_var.is_none(),
        },
        credentials,
        records,
    );
    let credential_key = super::catalog_views::mcp_credential_key(name);
    let connectable = !state.login_pending
        && mcp_login_eligibility(
            name,
            None,
            Some(config),
            None,
            records.get(name),
            credentials.get(&credential_key),
            false,
            false,
        )
        .allowed
        && matches!(
            state.status,
            McpConnectionStatus::NotConnected | McpConnectionStatus::Error
        );
    McpPluginView {
        service_id: name.to_string(),
        label: name.to_string(),
        connection_status: if disabled {
            McpConnectionStatus::Disabled
        } else {
            state.status
        },
        connectable,
        add_account_allowed: (!state.login_pending
            && !disabled
            && uses_oauth
            && bearer_token_env_var.is_none()
            && super::catalog_views::concrete_oauth_endpoint(url))
        .then_some(true),
        login_pending: state.login_pending.then_some(true),
        uses_oauth,
        source: ViewSource::User,
        connection_ids: if records.contains_key(name) {
            vec![name.to_string()]
        } else if disabled
            || state.status == McpConnectionStatus::Error
            || state.status == McpConnectionStatus::NotConnected
        {
            Vec::new()
        } else {
            vec![name.to_string()]
        },
        paste_token: None,
        aliases: None,
        description: None,
        category: None,
        publisher: None,
        docs_url: None,
        setup_hint: state.setup_hint,
        unverified: None,
        verified_at: None,
        tool_count: None,
    }
}

/// Cards for the service-catalog view: the resolved services plus user-declared servers, sorted
/// connected-first then label, then id.
pub fn build_plugin_views(inputs: &BuildViewsInputs<'_>) -> Vec<McpPluginView> {
    let reserved: std::collections::HashSet<&str> = inputs
        .services
        .iter()
        .filter(|service| service.legacy_builtin)
        .map(|service| service.service_id.as_str())
        .collect();
    let mut user_views: HashMap<String, McpPluginView> = HashMap::new();
    for (name, config) in inputs.user_servers.iter().flat_map(|m| m.iter()) {
        // Dead shadows: a user entry cannot override a bundled catalog service.
        if reserved.contains(name.as_str()) {
            continue;
        }
        user_views.insert(
            name.clone(),
            user_server_view(name, config, inputs.credentials, inputs.records),
        );
    }
    let mut views: Vec<McpPluginView> = Vec::new();
    for service in inputs.services {
        // A user-declared server owns the id for non-bundled services; no
        // duplicate card.
        if !service.legacy_builtin && user_views.contains_key(&service.service_id) {
            continue;
        }
        views.push(catalog_service_view(
            service,
            inputs.credentials,
            inputs.records,
            inputs.user_servers.and_then(|m| m.get(&service.service_id)),
            inputs.catalog_available,
        ));
    }
    views.extend(user_views.into_values());
    let rank = |view: &McpPluginView| -> i32 {
        match view.connection_status {
            McpConnectionStatus::Connected => 0,
            _ if view.login_pending == Some(true) => 1,
            McpConnectionStatus::Pending => 2,
            _ if view.connectable => 3,
            _ if !view.connection_ids.is_empty() => 4,
            _ => 5,
        }
    };
    views.sort_by(|left, right| {
        rank(left)
            .cmp(&rank(right))
            .then_with(|| left.label.to_lowercase().cmp(&right.label.to_lowercase()))
            .then_with(|| left.service_id.cmp(&right.service_id))
    });
    views
}

/// One row of the kernel connection inventory (TS `McpConnectionView`): the dispatch id
/// `mcp.config` / `mcp.list_tools` / `mcp.call_tool` address. `setup_required` never appears.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectionView {
    /// The dispatch id: `mcp.config` + `list_tools`/`call_tool` address this.
    pub connection_id: String,
    pub service_id: Option<String>,
    pub label: String,
    pub status: McpConnectionStatus,
    pub uses_oauth: bool,
    /// The transport (`http` / `stdio`).
    pub transport: String,
    pub login_pending: Option<bool>,
    pub source: ViewSource,
    pub setup_hint: Option<String>,
}

/// The `/mcp` view's api-key credential catalog: the non-provider keys the
/// product stores in the shared auth store and offers alongside the MCP
/// connections (the web-search key the websearch skill's runtime reads).
pub const API_KEY_CREDENTIALS: &[(&str, &str)] = &[(
    crate::auth::SERPER_CREDENTIAL_ID,
    crate::auth::SERPER_CREDENTIAL_NAME,
)];

/// One row of the `/mcp` view's api-key credential section (the daemon's
/// `get_mcp_connections` response): a stored key the surface manages. Enter
/// opens the paste-the-key prompt; the submitted key lands in the row's auth
/// slot (the `AuthCredential::ApiKey` form).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCredentialView {
    /// The auth-store slot the credential writes and the runtime reads
    /// (e.g. `serper`).
    pub id: String,
    pub label: String,
    /// True when the shared auth store holds an API key at the slot.
    pub configured: bool,
}

/// The conflict hint of a reserved-ownership ruling (canonical and disabled
/// carry none).
fn ownership_setup_hint(ownership: &ReservedOwnership) -> Option<String> {
    match ownership {
        ReservedOwnership::Conflict(hint) => Some(hint.clone()),
        _ => None,
    }
}

/// An ACP session server for [`build_connection_views`]: name + transport.
pub struct AcpServerRow {
    pub name: String,
    pub transport: String,
}

impl AcpServerRow {
    pub fn from_configs(servers: &[super::AcpMcpServerConfig]) -> Vec<Self> {
        servers
            .iter()
            .map(|server| AcpServerRow {
                name: server.name().to_string(),
                transport: match server {
                    super::AcpMcpServerConfig::Stdio { .. } => "stdio".to_string(),
                    super::AcpMcpServerConfig::Http { .. } => "http".to_string(),
                },
            })
            .collect()
    }
}

/// The kernel connection inventory (TS `buildConnectionViews`): one row per dispatchable account,
/// plus the session-scoped ACP servers a catalog/user id does not already shadow.
pub fn build_connection_views(
    inputs: &BuildViewsInputs<'_>,
    acp_servers: &[AcpServerRow],
) -> Vec<McpConnectionView> {
    let user_servers = inputs.user_servers;
    let mut views: Vec<McpConnectionView> = Vec::new();
    let reserved: std::collections::HashSet<&str> = inputs
        .services
        .iter()
        .filter(|service| service.legacy_builtin)
        .map(|service| service.service_id.as_str())
        .collect();
    let mut connected: std::collections::HashSet<String> = std::collections::HashSet::new();
    for service in inputs.services {
        let ownership = reserved_mcp_ownership(
            Some(service),
            user_servers.and_then(|servers| servers.get(&service.service_id)),
        );
        let plugin = catalog_service_view(
            service,
            inputs.credentials,
            inputs.records,
            user_servers.and_then(|servers| servers.get(&service.service_id)),
            inputs.catalog_available,
        );
        if plugin.connection_ids.is_empty() {
            if !matches!(ownership, ReservedOwnership::Canonical) {
                views.push(McpConnectionView {
                    connection_id: service.service_id.clone(),
                    service_id: Some(service.service_id.clone()),
                    label: service.label.clone(),
                    status: match ownership {
                        ReservedOwnership::Disabled => McpConnectionStatus::Disabled,
                        _ => McpConnectionStatus::Error,
                    },
                    uses_oauth: plugin.uses_oauth,
                    transport: "http".to_string(),
                    login_pending: None,
                    source: ViewSource::Catalog,
                    setup_hint: ownership_setup_hint(&ownership),
                });
            }
            continue;
        }
        // One inventory row per account, each with the SAME centralized, honestly-computed status
        // (credential binding) — never a raw record.status that could claim a stale Connected.
        for account in account_states_for(service, inputs.credentials, inputs.records) {
            connected.insert(account.connection_id.clone());
            let label = if account.connection_id == service.service_id {
                service.label.clone()
            } else {
                format!("{} ({})", service.label, account.connection_id)
            };
            views.push(McpConnectionView {
                connection_id: account.connection_id.clone(),
                service_id: Some(service.service_id.clone()),
                label,
                status: match ownership {
                    ReservedOwnership::Disabled => McpConnectionStatus::Disabled,
                    ReservedOwnership::Conflict(_) => McpConnectionStatus::Error,
                    ReservedOwnership::Canonical => {
                        if account.status == McpConnectionStatus::SetupRequired {
                            McpConnectionStatus::NotConnected
                        } else {
                            account.status
                        }
                    }
                },
                login_pending: account.login_pending.then_some(true),
                uses_oauth: plugin.uses_oauth,
                transport: "http".to_string(),
                source: ViewSource::Catalog,
                setup_hint: ownership_setup_hint(&ownership).or_else(|| account.setup_hint.clone()),
            });
        }
    }
    for (name, config) in user_servers.iter().flat_map(|servers| servers.iter()) {
        if reserved.contains(name.as_str()) {
            continue;
        }
        let plugin = user_server_view(name, config, inputs.credentials, inputs.records);
        if plugin.connection_ids.is_empty() {
            continue;
        }
        connected.insert(name.clone());
        views.push(McpConnectionView {
            connection_id: name.clone(),
            service_id: None,
            label: name.clone(),
            status: if plugin.connection_status == McpConnectionStatus::SetupRequired {
                McpConnectionStatus::NotConnected
            } else {
                plugin.connection_status
            },
            uses_oauth: plugin.uses_oauth,
            transport: config.server_type().to_string(),
            login_pending: plugin.login_pending,
            source: ViewSource::User,
            setup_hint: plugin.setup_hint.clone(),
        });
    }
    for server in acp_servers {
        if connected.contains(&server.name) {
            continue;
        }
        views.push(McpConnectionView {
            connection_id: server.name.clone(),
            service_id: None,
            label: server.name.clone(),
            status: McpConnectionStatus::Connected,
            uses_oauth: false,
            transport: server.transport.clone(),
            login_pending: None,
            source: ViewSource::Acp,
            setup_hint: None,
        });
    }
    views.sort_by(|left, right| left.connection_id.cmp(&right.connection_id));
    views
}

/// Filter the plugin cards by an exact connection status.
pub fn filter_plugin_views_by_status(views: &[McpPluginView], status: &str) -> Vec<McpPluginView> {
    views
        .iter()
        .filter(|view| view.connection_status.as_str() == status)
        .cloned()
        .collect()
}

/// Search the plugin cards by service ids, labels, aliases, account ids, descriptions, categories,
/// publishers, and docs URLs.
pub fn search_plugin_views(
    views: &[McpPluginView],
    query: &str,
    limit: usize,
) -> Vec<McpPluginView> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return views.iter().take(limit).cloned().collect();
    }
    let mut matches = Vec::new();
    for view in views {
        let mut fields: Vec<String> = vec![
            view.service_id.clone(),
            view.label.clone(),
            view.category.clone().unwrap_or_default(),
        ];
        fields.push(view.description.clone().unwrap_or_default());
        fields.push(view.publisher.clone().unwrap_or_default());
        fields.push(view.docs_url.clone().unwrap_or_default());
        fields.extend(view.aliases.iter().flatten().cloned());
        fields.extend(view.connection_ids.iter().cloned());
        if fields
            .iter()
            .any(|field| field.to_lowercase().contains(&needle))
        {
            matches.push(view.clone());
            if matches.len() >= limit {
                break;
            }
        }
    }
    matches
}

/// Decode one page cursor: digits only, `None` for the first page.
pub fn decode_plugin_cursor(cursor: Option<&str>) -> Result<usize, String> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    if cursor.is_empty() {
        return Ok(0);
    }
    if !cursor.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("mcp.list_plugins received an invalid cursor".to_string());
    }
    cursor
        .parse::<usize>()
        .map_err(|_| "mcp.list_plugins received an invalid cursor".to_string())
}

/// Slice one bounded page out of the plugin cards.
///
/// A cursor at or past the end yields an empty page and no continuation — the TS float-arithmetic
/// outcome.
pub fn page_plugin_views(
    views: &[McpPluginView],
    cursor: usize,
    limit: usize,
) -> (Vec<McpPluginView>, Option<String>) {
    if cursor >= views.len() {
        return (Vec::new(), None);
    }
    let page: Vec<McpPluginView> = views.iter().skip(cursor).take(limit).cloned().collect();
    let next_cursor = (cursor + limit < views.len()).then(|| (cursor + limit).to_string());
    (page, next_cursor)
}

#[cfg(test)]
mod connection_view_tests {
    use super::*;
    use crate::mcp::service_catalog::McpServiceDescriptor;

    fn http_descriptor(service_id: &str, legacy_builtin: bool) -> McpServiceDescriptor {
        McpServiceDescriptor::from_entry(
            &serde_json::from_value::<crate::mcp::catalog_schema::McpServiceEntry>(serde_json::json!({
                "server": service_id, "service": service_id, "label": service_id,
                "url": format!("https://{service_id}.example/mcp"),
                "aliases": [],
                "transport": { "type": "http", "url": format!("https://{service_id}.example/mcp") },
                "auth": { "strategy": "oauth", "clientRegistration": "dynamic" },
                "setup": { "status": "ready" },
                "verification": { "status": "unverified" },
                "legacyBuiltin": legacy_builtin,
                "provenance": [{ "source": "prime" }]
            }))
            .expect("fixture entry parses"),
            false,
        )
    }

    fn connected_record(connection_id: &str, service_id: &str) -> McpConnectionRecord {
        let mut record = crate::mcp::connection_store::new_pending_record(
            connection_id,
            service_id,
            connection_id,
            "https://alpha.example/mcp",
        );
        record.status = crate::mcp::connection_store::McpConnectionStatus::Connected;
        record.verified_at = Some(1_700_000_000_000);
        record
    }

    /// A usable OAuth grant bound to the service endpoint: what a Connected
    /// row requires (the status machine refuses record-only claims).
    fn bound_grant(connection_id: &str) -> crate::auth::types::AuthCredential {
        crate::auth::types::AuthCredential::Oauth {
            access: format!("access-{connection_id}"),
            refresh: Some("refresh-token".to_string()),
            expires: 4_102_444_800_000,
            endpoint: Some("https://alpha.example/mcp".to_string()),
            token_endpoint: None,
            client_id: None,
            resource: None,
            issuer: None,
            audience_mode: None,
            account_id: None,
            enterprise_url: None,
        }
    }

    fn credentials_with(
        entries: &[(&str, crate::auth::types::AuthCredential)],
    ) -> SnapshotCredentials {
        let credentials: HashMap<String, crate::auth::types::AuthCredential> = entries
            .iter()
            .map(|(id, credential)| (format!("mcp:{id}"), credential.clone()))
            .collect();
        SnapshotCredentials { credentials }
    }

    fn inputs<'a>(
        services: &'a [McpServiceDescriptor],
        user_servers: Option<&'a HashMap<String, McpServerConfig>>,
        credentials: &'a SnapshotCredentials,
        records: &'a HashMap<String, McpConnectionRecord>,
    ) -> BuildViewsInputs<'a> {
        BuildViewsInputs {
            services,
            user_servers,
            credentials,
            records,
            catalog_available: false,
        }
    }

    fn empty_credentials() -> SnapshotCredentials {
        SnapshotCredentials::empty()
    }

    /// The contract: one row per dispatchable account (the verified record wins), a legacy-builtin
    /// shadow surfaces as an error row.
    #[test]
    fn connection_views_cover_accounts_user_and_acp_rows() {
        let services = vec![
            http_descriptor("alpha", false),
            http_descriptor("linear", true),
        ];
        let mut records = HashMap::new();
        records.insert("alpha".to_string(), connected_record("alpha", "alpha"));
        records.insert("alpha-2".to_string(), connected_record("alpha-2", "alpha"));
        let mut user_servers = HashMap::new();
        user_servers.insert(
            "local-tool".to_string(),
            McpServerConfig::Stdio {
                command: "run".to_string(),
                args: Some(vec!["tool".to_string()]),
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
            "linear".to_string(),
            McpServerConfig::Http {
                url: "https://evil.example/mcp".to_string(),
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
        let credentials = credentials_with(&[
            ("alpha", bound_grant("alpha")),
            ("alpha-2", bound_grant("alpha-2")),
        ]);
        let view_inputs = inputs(&services, Some(&user_servers), &credentials, &records);
        let views = build_connection_views(
            &view_inputs,
            &[AcpServerRow {
                name: "session-tool".to_string(),
                transport: "stdio".to_string(),
            }],
        );
        let ids: Vec<&str> = views
            .iter()
            .map(|view| view.connection_id.as_str())
            .collect();
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        assert_eq!(ids, sorted, "rows sort by connectionId");
        assert_eq!(
            ids,
            vec!["alpha", "alpha-2", "linear", "local-tool", "session-tool"]
        );
        let alpha = &views[0];
        assert_eq!(alpha.status, McpConnectionStatus::Connected);
        assert_eq!(alpha.transport, "http");
        assert_eq!(alpha.source, ViewSource::Catalog);
        assert_eq!(alpha.service_id.as_deref(), Some("alpha"));
        let alpha_two = &views[1];
        assert_eq!(alpha_two.label, "alpha (alpha-2)");
        assert_eq!(alpha_two.status, McpConnectionStatus::Connected);
        let shadow = views.iter().find(|v| v.connection_id == "linear").unwrap();
        assert_eq!(shadow.status, McpConnectionStatus::Error);
        assert!(shadow.setup_hint.is_some());
        let local = views
            .iter()
            .find(|v| v.connection_id == "local-tool")
            .unwrap();
        assert_eq!(local.status, McpConnectionStatus::Connected);
        assert_eq!(local.transport, "stdio");
        assert_eq!(local.source, ViewSource::User);
        let acp = views
            .iter()
            .find(|v| v.connection_id == "session-tool")
            .unwrap();
        assert_eq!(acp.status, McpConnectionStatus::Connected);
        assert_eq!(acp.source, ViewSource::Acp);
    }

    /// An oversized cursor pages to an empty page with NO continuation
    /// instead of overflowing `cursor + limit` (the TS float outcome).
    #[test]
    fn oversized_cursor_yields_empty_page_without_overflow() {
        let views: Vec<McpPluginView> = (0..4)
            .map(|i| McpPluginView {
                service_id: format!("s{i}"),
                label: format!("s{i}"),
                connection_status: McpConnectionStatus::NotConnected,
                connectable: false,
                add_account_allowed: None,
                login_pending: None,
                uses_oauth: false,
                source: ViewSource::Catalog,
                connection_ids: Vec::new(),
                paste_token: None,
                aliases: None,
                description: None,
                category: None,
                publisher: None,
                docs_url: None,
                setup_hint: None,
                unverified: None,
                verified_at: None,
                tool_count: None,
            })
            .collect();
        let (page, next) = page_plugin_views(&views, 0, 2);
        assert_eq!(page.len(), 2);
        assert_eq!(next.as_deref(), Some("2"));
        for cursor in [views.len(), usize::MAX] {
            let (page, next) = page_plugin_views(&views, cursor, 50);
            assert!(page.is_empty(), "cursor {cursor} must page empty");
            assert_eq!(next, None, "cursor {cursor} must end paging");
        }
    }

    /// A service with no dispatchable accounts and no reserved conflict
    /// produces NO row (TS skips the empty connectionIds path silently).
    #[test]
    fn connection_views_skip_undispatchable_services() {
        let services = vec![http_descriptor("beta", false)];
        let user_servers: HashMap<String, McpServerConfig> = HashMap::new();
        let records: HashMap<String, McpConnectionRecord> = HashMap::new();
        let credentials = empty_credentials();
        let view_inputs = inputs(&services, Some(&user_servers), &credentials, &records);
        assert!(build_connection_views(&view_inputs, &[]).is_empty());
    }
}
