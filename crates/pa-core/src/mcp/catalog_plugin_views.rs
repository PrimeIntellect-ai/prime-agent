//! Cards for the service-catalog view: the shared projection of resolved
//! catalog services and user-declared MCP servers (port of the view half of
//! `packages/coding-agent/src/core/mcp/service-catalog.ts`:
//! `buildPluginViews`, `buildConnectionViews`, search/filter/paging).
//! Pure data assembly over the auth snapshot and connection records; no
//! secrets ever leave this module.

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

/// The pinned-definition hint (TS `service-catalog.ts:1081,1102`): shown
/// when a connection record outlives its catalog entry. The claim "the
/// catalog source is unavailable" is honest only when a validated remote
/// catalog snapshot is in hand — TS always has one (the compiled catalog
/// in the deployed release, the fetch lane's last-good cache or the
/// packaged bundle on main), so it never claims absence it cannot prove;
/// without a snapshot the pin keeps the connection manageable but makes
/// no source-unavailable claim.
pub(crate) const PINNED_FROM_RECORD_HINT: &str =
    "This service's catalog source is unavailable; its connection keeps the pinned definition.";

/// One card for the service-catalog view (TS `McpPluginView`).
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
    /// View-only marker: this row opens the inline paste panel (a
    /// requires-setup token service with credential fields). Never a
    /// connected/verified claim.
    pub paste_token: Option<bool>,
    /// Catalog metadata aliases (searchable; never runtime claims).
    pub aliases: Option<Vec<String>>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub publisher: Option<String>,
    pub docs_url: Option<String>,
    /// Honest requirement or failure detail; non-empty for setup_required and
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
    /// A validated remote catalog snapshot is in hand (the fetch lane's
    /// last-good cache or the packaged bundle): the pinned-definition hint
    /// claims the service left the catalog, so it renders only when a
    /// snapshot can PROVE that. Without one (the fetch never ran, failed,
    /// or the bundle is missing) the pin keeps the connection manageable
    /// but stays silent.
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
        _ => None,
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
        HttpStatusOptions {
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

/// Cards for the service-catalog view (TS `buildPluginViews`): the resolved
/// services plus user-declared servers, deduplicated per id (a user entry
/// owns its id unless the service is a legacy builtin — dead shadows are
/// dropped), sorted connected-first then label, then id.
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
