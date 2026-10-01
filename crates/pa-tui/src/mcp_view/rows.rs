//! The `/mcp` view's row model: the two row classes the daemon's
//! `get_mcp_connections` response carries — the service-catalog cards
//! (TS `McpPluginView`) and the api-key credential rows (the stored keys
//! the view manages alongside the connections) — with their shared
//! render/search projection (the label line, the trailing status, the
//! detail copy, the Enter action hint, and the search-band fields).

use serde_json::Value;

use crate::theme::ThemeColor;

/// One service-catalog card (the daemon's resolved `services` array; TS
/// `McpPluginView`): a catalog service or a user-declared server with its
/// honestly-computed connection state.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct McpServiceRow {
    pub service_id: String,
    pub label: String,
    pub connection_status: String,
    pub connectable: bool,
    pub login_pending: bool,
    pub uses_oauth: bool,
    pub source: String,
    pub connection_ids: Vec<String>,
    /// The paste-panel marker: a requires-setup token service collecting
    /// exactly one credential. Never a connected/verified claim.
    pub paste_token: bool,
    pub aliases: Vec<String>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub publisher: Option<String>,
    pub docs_url: Option<String>,
    pub setup_hint: Option<String>,
    pub tool_count: Option<usize>,
    pub verified_at: Option<u64>,
}

impl McpServiceRow {
    /// Parse one legacy roster entry (a daemon that predates the catalog
    /// surface serves only `connections`): the row keeps the roster's
    /// honest connected state; a not-connected row stays connectable.
    pub(super) fn from_roster_entry(value: &Value) -> Option<Self> {
        let connected = value
            .get("connected")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Some(McpServiceRow {
            service_id: value.get("server")?.as_str()?.to_string(),
            label: value
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            connection_status: if connected {
                "connected"
            } else {
                "not_connected"
            }
            .to_string(),
            connectable: !connected,
            login_pending: false,
            uses_oauth: value
                .get("usesOAuth")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            source: "catalog".to_string(),
            connection_ids: Vec::new(),
            paste_token: false,
            aliases: Vec::new(),
            description: None,
            category: None,
            publisher: None,
            docs_url: None,
            setup_hint: None,
            tool_count: None,
            verified_at: None,
        })
    }

    /// Parse one daemon `services` entry.
    pub(super) fn from_value(value: &Value) -> Option<Self> {
        let connection_ids = value
            .get("connectionIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        Some(McpServiceRow {
            service_id: value.get("serviceId")?.as_str()?.to_string(),
            label: value
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            connection_status: value
                .get("connectionStatus")
                .and_then(Value::as_str)
                .unwrap_or("not_connected")
                .to_string(),
            connectable: value
                .get("connectable")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            login_pending: value
                .get("loginPending")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            uses_oauth: value
                .get("usesOAuth")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            source: value
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("catalog")
                .to_string(),
            connection_ids,
            paste_token: value
                .get("pasteToken")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            aliases: value
                .get("aliases")
                .and_then(Value::as_array)
                .map(|aliases| {
                    aliases
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            description: value
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            category: value
                .get("category")
                .and_then(Value::as_str)
                .map(str::to_string),
            publisher: value
                .get("publisher")
                .and_then(Value::as_str)
                .map(str::to_string),
            docs_url: value
                .get("docsUrl")
                .and_then(Value::as_str)
                .map(str::to_string),
            setup_hint: value
                .get("setupHint")
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_count: value
                .get("toolCount")
                .and_then(Value::as_u64)
                .map(|c| c as usize),
            verified_at: value.get("verifiedAt").and_then(Value::as_u64),
        })
    }

    /// The trailing status text (TS `statusText`, catalog mode): the honest
    /// state vocabulary, with the record-carried tool count on connected
    /// rows (the picker reads local state only, like TS).
    fn status_text(&self) -> (ThemeColor, String) {
        if self.login_pending {
            return (ThemeColor::Warning, "Login in progress".to_string());
        }
        match self.connection_status.as_str() {
            "connected" => (
                ThemeColor::Success,
                match self.tool_count {
                    Some(tool_count) => format!("Connected \u{b7} {tool_count} tools"),
                    None => "Connected".to_string(),
                },
            ),
            "pending" => (ThemeColor::Warning, "Needs verification".to_string()),
            "error" => (
                ThemeColor::Error,
                if self.connectable {
                    "Reconnect"
                } else {
                    "Needs attention"
                }
                .to_string(),
            ),
            "setup_required" => (ThemeColor::Warning, "Requires setup".to_string()),
            "disabled" => (ThemeColor::Muted, "Disabled".to_string()),
            _ => (
                if self.connectable {
                    ThemeColor::Text
                } else {
                    ThemeColor::Muted
                },
                if self.connectable {
                    "Connect"
                } else {
                    "Not connected"
                }
                .to_string(),
            ),
        }
    }

    /// The selected row's detail copy (TS `secondaryText`, catalog mode):
    /// the honest setup guidance for setup-required/error rows, the
    /// description otherwise.
    pub(super) fn detail_text(&self) -> Option<String> {
        if self.connection_status == "setup_required" || self.connection_status == "error" {
            self.setup_hint.clone().or_else(|| self.description.clone())
        } else {
            self.description.clone().or_else(|| self.setup_hint.clone())
        }
    }

    /// The action target (the service id).
    pub(super) fn target(&self) -> &str {
        self.service_id.as_str()
    }

    /// The paste-panel decision (TS: a requires-setup token service with
    /// exactly one credential and no installed account).
    pub(super) fn wants_paste(&self) -> bool {
        self.paste_token && self.connection_ids.is_empty()
    }

    /// The Enter action hint (TS `actionText`, catalog mode, in the TS
    /// order): the paste step for pasteable token services, the accounts
    /// step for rows with an account, `manage` for user-declared
    /// non-OAuth servers, then the connection-state verbs.
    fn action_text(&self) -> &'static str {
        if self.paste_token && self.connection_ids.is_empty() {
            return "paste token";
        }
        if !self.connection_ids.is_empty() {
            return "manage accounts";
        }
        if self.source == "user" && !self.uses_oauth {
            return "manage";
        }
        match self.connection_status.as_str() {
            "connected" => "re-verify",
            "pending" => "verify",
            _ if !self.connectable => "setup guidance",
            "error" => "reconnect",
            _ => "connect",
        }
    }
}

/// One api-key credential entry (the daemon's `credentials` array): a
/// non-provider key the product stores in the shared auth store, offered
/// alongside the MCP connections (the web-search key the websearch skill
/// reads). Enter opens the paste-the-key prompt; the submitted key lands
/// in the credential's auth slot.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct McpCredentialRow {
    pub(super) id: String,
    pub(super) label: String,
    configured: bool,
}

impl McpCredentialRow {
    /// Parse one daemon `credentials` entry.
    pub(super) fn from_value(value: &Value) -> Option<Self> {
        Some(McpCredentialRow {
            id: value.get("id")?.as_str()?.to_string(),
            label: value
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            configured: value
                .get("configured")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    /// The trailing status (the provider-auth vocabulary): a stored key
    /// reads `Configured`, an empty slot `Not configured`.
    fn status_text(&self) -> (ThemeColor, String) {
        if self.configured {
            (ThemeColor::Success, "Configured".to_string())
        } else {
            (ThemeColor::Muted, "Not configured".to_string())
        }
    }

    /// The Enter action hint: paste the key (a configured row's Enter
    /// replaces the stored key the same way).
    fn action_text(&self) -> &'static str {
        if self.configured {
            "replace key"
        } else {
            "add key"
        }
    }
}

/// One `/mcp` view row: a service-catalog card or an api-key credential
/// (the two row classes the daemon's `get_mcp_connections` response
/// carries).
#[derive(Debug, Clone, PartialEq)]
// The service card is the wide row (its catalog metadata); the credential
// row is deliberately small. The rows are a per-open rendered list (a
// handful of entries), never a hot data structure — boxing would spend a
// deref on every render path for no measurable size win.
#[allow(clippy::large_enum_variant)]
pub(super) enum McpRow {
    Service(McpServiceRow),
    Credential(McpCredentialRow),
}

impl McpRow {
    /// The rendered row's primary line (TS `MenuRow` primary: the label
    /// alone, flattened).
    pub(super) fn primary_line(&self) -> String {
        flatten_to_single_line(match self {
            McpRow::Service(service) => &service.label,
            McpRow::Credential(credential) => &credential.label,
        })
    }

    /// The action target (the service id or the credential's auth slot).
    pub(super) fn target(&self) -> &str {
        match self {
            McpRow::Service(service) => service.service_id.as_str(),
            McpRow::Credential(credential) => credential.id.as_str(),
        }
    }

    /// The trailing status text (TS `statusText`): the honest state
    /// vocabulary of the row's class.
    pub(super) fn status_text(&self) -> (ThemeColor, String) {
        match self {
            McpRow::Service(service) => service.status_text(),
            McpRow::Credential(credential) => credential.status_text(),
        }
    }

    /// The selected row's detail copy (TS `secondaryText`): the honest
    /// setup guidance for setup-required/error rows, the description
    /// otherwise. A credential row carries none — the detail falls back
    /// to its status (TS `secondaryText ?? statusText`).
    pub(super) fn detail_text(&self) -> Option<String> {
        match self {
            McpRow::Service(service) => service.detail_text(),
            McpRow::Credential(_) => None,
        }
    }

    /// The Enter action hint (TS `actionText`).
    pub(super) fn action_text(&self) -> &'static str {
        match self {
            McpRow::Service(service) => service.action_text(),
            McpRow::Credential(credential) => credential.action_text(),
        }
    }

    /// The identity fields the search bands rank first.
    pub(super) fn identity_fields(&self) -> Vec<&str> {
        match self {
            McpRow::Service(service) => {
                let mut fields = vec![service.label.as_str(), service.service_id.as_str()];
                fields.extend(service.aliases.iter().map(String::as_str));
                fields
            }
            McpRow::Credential(credential) => {
                vec![credential.label.as_str(), credential.id.as_str()]
            }
        }
    }

    /// The description-band fields (matched only when no identity field
    /// matched).
    pub(super) fn description_fields(&self) -> Vec<&str> {
        match self {
            McpRow::Service(service) => service
                .description
                .iter()
                .chain(service.setup_hint.iter())
                .map(String::as_str)
                .collect(),
            McpRow::Credential(_) => Vec::new(),
        }
    }
}

/// Flatten all whitespace runs to one space (TS `flattenToSingleLine`):
/// catalog copy routinely contains newlines, and a rendered row must stay
/// exactly one terminal line.
pub(super) fn flatten_to_single_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
