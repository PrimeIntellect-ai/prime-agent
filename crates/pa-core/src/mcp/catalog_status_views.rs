//! Connection-status computation for MCP services: ONE shared state machine
//! over the credential binding and the connection record (port of the status
//! half of `packages/coding-agent/src/core/mcp/service-catalog.ts`:
//! `httpConnectionStatus`, `accountStateFor`, `accountStatesFor`).
//!
//! Token presence alone never yields "connected": without a verified
//! connection record the state stays "pending" until the probe succeeds.
//! Expiry, retargeting, and missing grants surface as reconnect-required
//! regardless of what the record last said — one truth, no stale
//! `record.status` reads.

use std::collections::HashMap;

use super::connection_store::{McpConnectionRecord, McpConnectionStatus as RecordStatus};
use crate::auth::types::AuthCredential;

/// Connection status vocabulary shared with the kernel host-request
/// contract. "connected" requires a verified handshake (connection record),
/// never bare token presence; "pending" means credentials exist but
/// verification has not succeeded yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpConnectionStatus {
    Connected,
    Pending,
    NotConnected,
    SetupRequired,
    Disabled,
    Error,
}

impl McpConnectionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            McpConnectionStatus::Connected => "connected",
            McpConnectionStatus::Pending => "pending",
            McpConnectionStatus::NotConnected => "not_connected",
            McpConnectionStatus::SetupRequired => "setup_required",
            McpConnectionStatus::Disabled => "disabled",
            McpConnectionStatus::Error => "error",
        }
    }
}

/// The computed state of one connection at one endpoint.
#[derive(Debug, Clone)]
pub(crate) struct HttpStatusResult {
    pub status: McpConnectionStatus,
    pub login_pending: bool,
    pub setup_hint: Option<String>,
    pub record: Option<McpConnectionRecord>,
}

/// Credentials resolved from the on-disk auth store, keyed by provider id.
pub struct SnapshotCredentials {
    pub(crate) credentials: HashMap<String, AuthCredential>,
}

impl SnapshotCredentials {
    pub fn empty() -> Self {
        Self {
            credentials: HashMap::new(),
        }
    }

    pub fn get(&self, key: &str) -> Option<&AuthCredential> {
        self.credentials.get(key)
    }
}

fn bearer_token_present(bearer_token_env_var: &str) -> bool {
    std::env::var(bearer_token_env_var).is_ok_and(|value| !value.trim().is_empty())
}

/// Options for [`http_connection_status`].
#[derive(Debug, Clone, Default)]
pub(crate) struct HttpStatusOptions<'a> {
    pub connection_id: &'a str,
    pub endpoint: &'a str,
    pub uses_oauth: bool,
    pub bearer_token_env_var: Option<&'a str>,
    /// The connection authenticates with a pasted static token credential.
    pub static_token: bool,
    /// Declared no-auth endpoint: dispatchable without credentials (the
    /// kernel handshakes).
    pub declared_no_auth: bool,
}

/// Status for an HTTP connection with an optional OAuth credential or static
/// bearer token (TS `httpConnectionStatus`).
#[allow(clippy::too_many_arguments)]
pub(crate) fn http_connection_status(
    options: HttpStatusOptions<'_>,
    credentials: &SnapshotCredentials,
    records: &HashMap<String, McpConnectionRecord>,
) -> HttpStatusResult {
    let connection_id = options.connection_id;
    let record = records.get(connection_id).cloned();
    if record
        .as_ref()
        .is_some_and(|record| record.attempt_id.is_some())
    {
        return HttpStatusResult {
            status: McpConnectionStatus::Pending,
            login_pending: true,
            setup_hint: Some(
                "Login in progress. Finish it or remove the account to cancel.".to_string(),
            ),
            record,
        };
    }
    let credential_key = super::catalog_views::mcp_credential_key(connection_id);
    if options.uses_oauth && options.bearer_token_env_var.is_none() {
        // ONE shared grant-usability rule: wrong-type, empty-access, unbound,
        // cross-endpoint, and expired-no-refresh grants are all unusable.
        match super::catalog_views::oauth_grant_usable(
            credentials.get(&credential_key),
            options.endpoint,
        ) {
            Ok(()) => match record.as_ref().map(|record| record.status) {
                Some(RecordStatus::Connected) => {
                    return HttpStatusResult {
                        status: McpConnectionStatus::Connected,
                        login_pending: false,
                        setup_hint: None,
                        record,
                    }
                }
                Some(RecordStatus::Pending) => {
                    return HttpStatusResult {
                        status: McpConnectionStatus::Pending,
                        login_pending: false,
                        setup_hint: record.as_ref().and_then(|r| r.last_error.clone()),
                        record,
                    }
                }
                Some(RecordStatus::Error) => {
                    return HttpStatusResult {
                        status: McpConnectionStatus::Error,
                        login_pending: false,
                        setup_hint: record.as_ref().and_then(|r| r.last_error.clone()),
                        record,
                    }
                }
                None => {
                    return HttpStatusResult {
                        status: McpConnectionStatus::Pending,
                        login_pending: false,
                        setup_hint: Some(
                            "Credentials stored; connection verification pending.".to_string(),
                        ),
                        record,
                    }
                }
            },
            Err(
                super::catalog_views::OAuthGrantUsabilityReason::Unbound
                | super::catalog_views::OAuthGrantUsabilityReason::CrossEndpoint,
            ) => {
                // Endpoint binding: a token must prove where it belongs.
                return HttpStatusResult {
                    status: McpConnectionStatus::Error,
                    login_pending: false,
                    setup_hint: Some(
                        "Stored credentials are not bound to this endpoint. Reconnect required."
                            .to_string(),
                    ),
                    record,
                };
            }
            Err(super::catalog_views::OAuthGrantUsabilityReason::ExpiredNoRefresh) => {
                return HttpStatusResult {
                    status: McpConnectionStatus::Error,
                    login_pending: false,
                    setup_hint: Some(
                        "Stored credentials expired without a refresh token. Reconnect required."
                            .to_string(),
                    ),
                    record,
                };
            }
            Err(_) => {
                // No usable grant (missing, wrong-type, or empty access): a
                // record without one is a stale connection, not a fresh one.
                let pending_stale = record.as_ref().is_some_and(|record| {
                    record.status == RecordStatus::Pending && record.attempt_id.is_none()
                });
                if pending_stale {
                    return HttpStatusResult {
                        status: McpConnectionStatus::NotConnected,
                        login_pending: false,
                        setup_hint: Some(
                            "Account settings kept. Connect to finish setup, or remove the account."
                                .to_string(),
                        ),
                        record,
                    };
                }
                if record.is_some() {
                    return HttpStatusResult {
                        status: McpConnectionStatus::Error,
                        login_pending: false,
                        setup_hint: Some(
                            "Stored credentials are missing. Reconnect required.".to_string(),
                        ),
                        record,
                    };
                }
                return HttpStatusResult {
                    status: McpConnectionStatus::NotConnected,
                    login_pending: false,
                    setup_hint: None,
                    record,
                };
            }
        }
    }
    if let Some(env_var) = options.bearer_token_env_var {
        if !bearer_token_present(env_var) {
            if record.is_some() {
                return HttpStatusResult {
                    status: McpConnectionStatus::Error,
                    login_pending: false,
                    setup_hint: Some(format!(
                        "The {env_var} environment variable is no longer set. Reconnect required."
                    )),
                    record,
                };
            }
            return HttpStatusResult {
                status: McpConnectionStatus::NotConnected,
                login_pending: false,
                setup_hint: Some(format!(
                    "Set the {env_var} environment variable to use this server."
                )),
                record,
            };
        }
        return record_driven(record);
    }
    if options.static_token {
        // A pasted static token: the ONE shared usability rule (type,
        // endpoint binding, non-empty bearer), then the SAME record-driven
        // states as the env-var path. No expiry: usable until removed or
        // replaced, and setup field ids are never read as env vars.
        match super::catalog_views::mcp_static_token_usable(
            credentials.get(&credential_key),
            options.endpoint,
        ) {
            Ok(()) => {}
            Err(
                super::catalog_views::McpStaticTokenUsabilityReason::Unbound
                | super::catalog_views::McpStaticTokenUsabilityReason::CrossEndpoint,
            ) => {
                return HttpStatusResult {
                    status: McpConnectionStatus::Error,
                    login_pending: false,
                    setup_hint: Some(
                        "Stored credentials are not bound to this endpoint. Reconnect required."
                            .to_string(),
                    ),
                    record,
                };
            }
            Err(_) => {
                if record.is_some() {
                    return HttpStatusResult {
                        status: McpConnectionStatus::Error,
                        login_pending: false,
                        setup_hint: Some(
                            "Stored credentials are missing. Reconnect required.".to_string(),
                        ),
                        record,
                    };
                }
                return HttpStatusResult {
                    status: McpConnectionStatus::NotConnected,
                    login_pending: false,
                    setup_hint: None,
                    record,
                };
            }
        }
        return record_driven(record);
    }
    if options.declared_no_auth {
        return HttpStatusResult {
            status: McpConnectionStatus::Connected,
            login_pending: false,
            setup_hint: None,
            record,
        };
    }
    HttpStatusResult {
        status: McpConnectionStatus::NotConnected,
        login_pending: false,
        setup_hint: None,
        record,
    }
}

fn record_driven(record: Option<McpConnectionRecord>) -> HttpStatusResult {
    match record.as_ref().map(|record| record.status) {
        Some(RecordStatus::Connected) => HttpStatusResult {
            status: McpConnectionStatus::Connected,
            login_pending: false,
            setup_hint: None,
            record,
        },
        Some(RecordStatus::Pending) => HttpStatusResult {
            status: McpConnectionStatus::Pending,
            login_pending: false,
            setup_hint: record.as_ref().and_then(|r| r.last_error.clone()),
            record,
        },
        Some(RecordStatus::Error) => HttpStatusResult {
            status: McpConnectionStatus::Error,
            login_pending: false,
            setup_hint: record.as_ref().and_then(|r| r.last_error.clone()),
            record,
        },
        None => HttpStatusResult {
            status: McpConnectionStatus::Pending,
            login_pending: false,
            setup_hint: Some("Bearer token present; connection verification pending.".to_string()),
            record,
        },
    }
}

/// One account's honestly-computed state (TS `McpAccountState`).
#[derive(Debug, Clone, PartialEq)]
pub struct McpAccountState {
    pub connection_id: String,
    pub login_pending: bool,
    pub status: McpConnectionStatus,
    pub setup_hint: Option<String>,
    pub tool_count: Option<usize>,
    pub verified_at: Option<u64>,
    pub last_error: Option<String>,
}

fn account_state_for(
    connection_id: &str,
    endpoint: &str,
    credentials: &SnapshotCredentials,
    records: &HashMap<String, McpConnectionRecord>,
    uses_oauth: bool,
    static_token: bool,
) -> McpAccountState {
    let state = http_connection_status(
        HttpStatusOptions {
            connection_id,
            endpoint,
            uses_oauth,
            bearer_token_env_var: None,
            static_token,
            declared_no_auth: false,
        },
        credentials,
        records,
    );
    McpAccountState {
        connection_id: connection_id.to_string(),
        login_pending: state.login_pending,
        status: state.status,
        setup_hint: state.setup_hint,
        tool_count: state.record.as_ref().and_then(|r| r.tool_count),
        verified_at: state.record.as_ref().and_then(|r| r.verified_at),
        last_error: state.record.as_ref().and_then(|r| r.last_error.clone()),
    }
}

/// Every account of a service (primary first), each with its computed state
/// (TS `accountStatesFor`).
pub(crate) fn account_states_for(
    service: &super::service_catalog::McpServiceDescriptor,
    credentials: &SnapshotCredentials,
    records: &HashMap<String, McpConnectionRecord>,
) -> Vec<McpAccountState> {
    let Some(url) = service.transport.endpoint() else {
        return Vec::new();
    };
    let uses_oauth = matches!(
        service.auth_strategy,
        super::catalog_schema::AuthStrategy::Oauth | super::catalog_schema::AuthStrategy::Unknown
    );
    let static_token = super::catalog_views::is_pasteable_token_service(service);
    let mut ids = vec![service.service_id.clone()];
    let mut aliases: Vec<String> = records
        .values()
        .filter(|record| {
            record.service_id == service.service_id && record.connection_id != service.service_id
        })
        .map(|record| record.connection_id.clone())
        .collect();
    aliases.sort();
    ids.extend(aliases);
    ids.into_iter()
        .map(|connection_id| {
            // The repair endpoint: an installed record/credential endpoint
            // the account is bound to wins over the catalog URL.
            let endpoint = repair_endpoint(&connection_id, service, credentials, records)
                .unwrap_or_else(|| url.to_string());
            account_state_for(
                &connection_id,
                &endpoint,
                credentials,
                records,
                uses_oauth,
                static_token,
            )
        })
        .filter(|account| {
            account.status != McpConnectionStatus::NotConnected
                || records.contains_key(&account.connection_id)
        })
        .collect()
}

/// The endpoint an installed account is pinned to, when a record or bound
/// credential proves it (endpoint pinning: the catalog URL may have moved).
fn repair_endpoint(
    connection_id: &str,
    service: &super::service_catalog::McpServiceDescriptor,
    credentials: &SnapshotCredentials,
    records: &HashMap<String, McpConnectionRecord>,
) -> Option<String> {
    let credential_key = super::catalog_views::mcp_credential_key(connection_id);
    let eligibility = super::catalog_views::mcp_login_eligibility(
        connection_id,
        Some(service),
        None,
        None,
        records.get(connection_id),
        credentials.get(&credential_key),
        false,
        false,
    );
    eligibility
        .repair
        .then_some(eligibility.endpoint)
        .flatten()
        .filter(|_| records.contains_key(connection_id))
}
