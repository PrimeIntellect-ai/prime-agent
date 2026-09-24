//! Credential, eligibility, and paste-flow helpers over resolved service
//! descriptors (port of the pure half of
//! `packages/coding-agent/src/core/mcp/service-catalog.ts`): the shared
//! usability rules for OAuth grants and pasted static tokens, the paste
//! credential resolution (credentialSet aliasing), the derived prompt
//! label, login eligibility (endpoint pinning), and the fresh-login gate.

use std::collections::HashSet;

use super::catalog_schema::{AuthStrategy, McpSetupField, SetupFieldKind, SetupStatus};
use super::connection_store::{McpConnectionRecord, McpConnectionStatus as RecordStatus};
use super::service_catalog::{DescriptorTransport, McpServiceDescriptor};
use super::McpServerConfig;
use crate::auth::types::AuthCredential;

/// The `mcp:<connectionId>` credential key.
pub fn mcp_credential_key(connection_id: &str) -> String {
    format!("mcp:{connection_id}")
}

/// Credential kinds the inline paste flow collects and stores.
const PASTE_CREDENTIAL_FIELD_KINDS: [SetupFieldKind; 2] =
    [SetupFieldKind::BearerToken, SetupFieldKind::ApiKey];

/// The required credential fields a service collects, in catalog order.
/// Non-credential fields (env-var kind, url, tenant) are NOT returned: the
/// flow never prompts for them and never stores values for them; setup
/// field ids are metadata, never environment variables to read.
pub fn mcp_credential_fields(service: &McpServiceDescriptor) -> Vec<&McpSetupField> {
    service
        .setup
        .fields
        .iter()
        .filter(|field| {
            field.required
                && field
                    .kind
                    .is_some_and(|kind| PASTE_CREDENTIAL_FIELD_KINDS.contains(&kind))
        })
        .collect()
}

/// The ONE credential a paste flow collects for a service, or `None` when
/// the service does not collect exactly one. The runtime sends ONE
/// `Authorization: Bearer` per connection, so multiple fields are
/// collectable ONLY as alternative names for the same credential (a shared
/// `credentialSet` id — GitHub's `GITHUB_PAT_TOKEN` and
/// `GITHUB_PERSONAL_ACCESS_TOKEN`); genuinely distinct credentials stay NOT
/// pasteable, fail closed.
#[derive(Debug, Clone, PartialEq)]
pub struct McpPasteCredential {
    /// The field the prompt labels (the first alternative).
    pub field: McpSetupField,
    /// Every alternative id naming the same credential, first first.
    pub field_ids: Vec<String>,
}

pub fn mcp_paste_credential(service: &McpServiceDescriptor) -> Option<McpPasteCredential> {
    let fields = mcp_credential_fields(service);
    if fields.is_empty() {
        return None;
    }
    let mut distinct: HashSet<String> = HashSet::new();
    let mut field_ids: Vec<String> = Vec::new();
    for field in &fields {
        distinct.insert(
            field
                .credential_set
                .clone()
                .unwrap_or_else(|| field.id.clone()),
        );
        field_ids.push(field.id.clone());
    }
    if distinct.len() > 1 {
        return None;
    }
    Some(McpPasteCredential {
        field: fields[0].clone(),
        field_ids,
    })
}

/// True when selecting this catalog entry opens the inline paste panel: an
/// HTTP endpoint that requires setup and collects EXACTLY ONE credential
/// (possibly under several alternative names). Connect-by-OAuth stays the
/// fresh-login path; entries without a concrete endpoint are not pasteable
/// (no URL, no handshake to verify against).
pub fn is_pasteable_token_service(service: &McpServiceDescriptor) -> bool {
    if service.transport.endpoint().is_none() {
        return false;
    }
    if service.setup.status != SetupStatus::RequiresSetup {
        return false;
    }
    mcp_paste_credential(service).is_some()
}

/// Tokens that stay uppercase in the derived label: real acronyms, not
/// shouty ids ("DD" is deliberately absent — it is a branding abbreviation
/// the strip rule removes: "Datadog DD_API_KEY" reads as "Datadog API key").
const FIELD_LABEL_ACRONYMS: [&str; 6] = ["api", "aws", "ci", "sdk", "cli", "id"];

/// Human prompt label for one credential field, derived from the field id
/// and the service identity ("GitHub personal access token"). The
/// derivation is display copy only — it never influences what is stored or
/// sent.
pub fn mcp_credential_field_prompt_label(
    service: &McpServiceDescriptor,
    field: &McpSetupField,
) -> String {
    let words_from = |text: &str| {
        text.split(|c: char| !(c.is_ascii_alphanumeric()))
            .filter(|word| !word.is_empty())
            .map(|word| word.trim().to_lowercase())
            .filter(|word| !word.is_empty())
            .collect::<Vec<String>>()
    };
    let mut strip: HashSet<String> = words_from(&service.service_id).into_iter().collect();
    strip.extend(words_from(&service.label));
    strip.insert("mcp".to_string());
    let tokens: Vec<&str> = field
        .id
        .split(['_', '-'])
        .filter(|t| !t.is_empty())
        .collect();
    let service_id_lower = service.service_id.to_lowercase();
    let mut kept: Vec<&str> = Vec::new();
    for token in tokens {
        let lower = token.to_lowercase();
        if strip.contains(&lower) {
            continue;
        }
        if kept.is_empty() {
            // Branding prefixes never name the credential: a direct prefix
            // of the service id ("cld" for "cloudinary") or a short
            // uppercase abbreviation sharing the id's first letter ("DD"
            // for "datadog").
            if service_id_lower.starts_with(lower.as_str()) {
                continue;
            }
            if token.len() <= 3
                && token.chars().all(|c| c.is_ascii_uppercase())
                && !FIELD_LABEL_ACRONYMS.contains(&lower.as_str())
                && service_id_lower.starts_with(
                    token
                        .chars()
                        .next()
                        .map(|c| c.to_ascii_lowercase())
                        .unwrap_or_default(),
                )
            {
                continue;
            }
        }
        kept.push(token);
    }
    let mut noun = if kept.is_empty() {
        field.label.clone()
    } else {
        kept.iter()
            .map(|token| {
                if *token == "PAT" {
                    "personal access token".to_string()
                } else if FIELD_LABEL_ACRONYMS.contains(&token.to_lowercase().as_str()) {
                    token.to_uppercase()
                } else {
                    token.to_lowercase()
                }
            })
            .collect::<Vec<String>>()
            .join(" ")
            .replace("token token", "token")
    };
    noun = noun.trim().to_string();
    format!("{} {noun}", service.label)
}

/// A discoverable OAuth candidate is not a certification or a successful
/// connection: concrete http endpoint, oauth-or-unknown strategy,
/// setup-ready, and not pinned from a vanished record.
pub fn fresh_mcp_login_allowed(service: &McpServiceDescriptor) -> bool {
    let Some(url) = service.transport.endpoint() else {
        return false;
    };
    matches!(service.transport, DescriptorTransport::Http { .. })
        && concrete_oauth_endpoint(url)
        && matches!(
            service.auth_strategy,
            AuthStrategy::Oauth | AuthStrategy::Unknown
        )
        && service.setup.status == SetupStatus::Ready
        && !service.pinned_from_record
}

/// A concrete, safe OAuth endpoint: absolute URL, no credentials or
/// fragment, https (or http on explicit loopback for local development),
/// and no unresolved template placeholders.
pub fn concrete_oauth_endpoint(endpoint: &str) -> bool {
    if endpoint.contains('{') || endpoint.contains('}') {
        return false;
    }
    let Ok(parsed) = url::Url::parse(endpoint) else {
        return false;
    };
    let loopback_host = parsed.host_str().is_some_and(|host| {
        host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1"
    });
    parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.fragment().is_none()
        && (parsed.scheme() == "https" || (parsed.scheme() == "http" && loopback_host))
}

/// Why a stored OAuth grant is not usable at an endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthGrantUsabilityReason {
    Missing,
    WrongType,
    EmptyAccess,
    Unbound,
    CrossEndpoint,
    ExpiredNoRefresh,
}

/// ONE shared rule for whether a stored credential is a usable OAuth grant
/// at an endpoint: typed oauth, non-empty access, bound to exactly this
/// endpoint, and not expired without a refresh token. Dispatch eligibility
/// and the view states consume this predicate so their answers never drift.
pub fn oauth_grant_usable(
    credential: Option<&AuthCredential>,
    endpoint: &str,
) -> Result<(), OAuthGrantUsabilityReason> {
    let Some(credential) = credential else {
        return Err(OAuthGrantUsabilityReason::Missing);
    };
    let AuthCredential::Oauth {
        access,
        refresh,
        expires,
        endpoint: bound,
        ..
    } = credential
    else {
        return Err(OAuthGrantUsabilityReason::WrongType);
    };
    if access.is_empty() {
        return Err(OAuthGrantUsabilityReason::EmptyAccess);
    }
    let Some(bound) = bound else {
        return Err(OAuthGrantUsabilityReason::Unbound);
    };
    if bound != endpoint {
        return Err(OAuthGrantUsabilityReason::CrossEndpoint);
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or_default();
    if *expires <= now_ms && refresh.as_deref().is_none_or(str::is_empty) {
        return Err(OAuthGrantUsabilityReason::ExpiredNoRefresh);
    }
    Ok(())
}

/// Why a stored static token credential is not usable at an endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpStaticTokenUsabilityReason {
    Missing,
    WrongType,
    Unbound,
    CrossEndpoint,
    EmptyBearer,
}

/// ONE shared rule for whether a stored credential is a usable pasted
/// static token at an endpoint: typed `mcp_static_token`, bound to exactly
/// this endpoint, with a non-empty bearer. No expiry: a static token is
/// usable until the user removes or replaces it.
pub fn mcp_static_token_usable(
    credential: Option<&AuthCredential>,
    endpoint: &str,
) -> Result<(), McpStaticTokenUsabilityReason> {
    let Some(credential) = credential else {
        return Err(McpStaticTokenUsabilityReason::Missing);
    };
    let AuthCredential::McpStaticToken {
        bearer,
        endpoint: bound,
    } = credential
    else {
        return Err(McpStaticTokenUsabilityReason::WrongType);
    };
    if bearer.is_empty() {
        return Err(McpStaticTokenUsabilityReason::EmptyBearer);
    }
    let Some(bound) = bound else {
        return Err(McpStaticTokenUsabilityReason::Unbound);
    };
    if bound != endpoint {
        return Err(McpStaticTokenUsabilityReason::CrossEndpoint);
    }
    Ok(())
}

/// Ownership of a reserved (legacy-builtin) id under a user settings
/// shadow: one canonical owner across UI and dispatch.
#[derive(Debug, Clone, PartialEq)]
pub enum ReservedOwnership {
    /// No reserved service involved, or the settings match the canonical
    /// entry.
    Canonical,
    Disabled,
    Conflict(String),
}

/// Reserved definitions keep one canonical owner (TS `reservedMcpOwnership`).
pub fn reserved_mcp_ownership(
    service: Option<&McpServiceDescriptor>,
    config: Option<&McpServerConfig>,
) -> ReservedOwnership {
    let Some(service) = service else {
        return ReservedOwnership::Canonical;
    };
    if !service.legacy_builtin {
        return ReservedOwnership::Canonical;
    }
    let Some(config) = config else {
        return ReservedOwnership::Canonical;
    };
    let McpServerConfig::Http {
        enabled,
        url,
        headers,
        bearer_token_env_var,
        ..
    } = config
    else {
        return ReservedOwnership::Conflict(
            "This name belongs to a built-in service. Rename or remove the conflicting server settings; saved accounts remain available for removal."
                .to_string(),
        );
    };
    if *enabled == Some(false) {
        return ReservedOwnership::Disabled;
    }
    let canonical = service.transport.endpoint() == Some(url.as_str())
        && config_uses_oauth(config)
        && bearer_token_env_var.is_none()
        && headers
            .as_ref()
            .is_none_or(std::collections::HashMap::is_empty);
    if canonical {
        ReservedOwnership::Canonical
    } else {
        ReservedOwnership::Conflict(
            "This name belongs to a built-in service. Rename or remove the conflicting server settings; saved accounts remain available for removal."
                .to_string(),
        )
    }
}

fn config_uses_oauth(config: &McpServerConfig) -> bool {
    matches!(
        config,
        McpServerConfig::Http {
            oauth: Some(true),
            ..
        }
    )
}

/// Resolved login eligibility for one connection (TS `mcpLoginEligibility`,
/// the paths the Rust port wires: ownership, disabled settings, setup
/// gating, endpoint repair from installed records/credentials — the pin —
/// and fresh catalog discovery).
#[derive(Debug, Clone, PartialEq)]
pub struct McpLoginEligibility {
    pub allowed: bool,
    pub endpoint: Option<String>,
    pub setup_hint: Option<String>,
    /// True when the resolved endpoint is the INSTALLED record/credential
    /// endpoint, not the catalog URL (an endpoint repair).
    pub repair: bool,
}

/// Evaluate whether a fresh login may run for one connection.
#[allow(clippy::too_many_arguments)]
pub fn mcp_login_eligibility(
    connection_id: &str,
    service: Option<&McpServiceDescriptor>,
    user_config: Option<&McpServerConfig>,
    reserved_config: Option<&McpServerConfig>,
    record: Option<&McpConnectionRecord>,
    credential: Option<&AuthCredential>,
    add_account: bool,
    explicit_login: bool,
) -> McpLoginEligibility {
    let deny = |hint: &str| McpLoginEligibility {
        allowed: false,
        endpoint: None,
        setup_hint: Some(hint.to_string()),
        repair: false,
    };
    let ownership = reserved_mcp_ownership(service, reserved_config);
    if ownership != ReservedOwnership::Canonical {
        return match ownership {
            ReservedOwnership::Disabled => deny("Disabled in settings."),
            ReservedOwnership::Conflict(hint) => deny(&hint),
            ReservedOwnership::Canonical => unreachable!(),
        };
    }
    if record.is_some_and(|record| record.attempt_id.is_some()) {
        return deny("Login in progress. Finish it or remove the account to cancel.");
    }
    // A legacy builtin owns its name; user settings for it are the reserved
    // path handled above (dead shadows), not a config the login uses.
    let config = if service.is_some_and(|service| service.legacy_builtin) {
        None
    } else {
        user_config
    };
    if let Some(
        McpServerConfig::Http {
            enabled: Some(false),
            ..
        }
        | McpServerConfig::Stdio {
            enabled: Some(false),
            ..
        },
    ) = config
    {
        return deny("Disabled in settings.");
    }
    if let Some(config) = config {
        let (not_http, bearer_var, oauth_flag) = match config {
            McpServerConfig::Http {
                url: _,
                headers: _,
                bearer_token_env_var,
                oauth,
                ..
            } => (false, bearer_token_env_var.is_some(), *oauth),
            McpServerConfig::Stdio { .. } => (true, false, None),
        };
        if not_http || bearer_var || (!explicit_login && oauth_flag != Some(true)) {
            return deny(
                "This server uses settings-managed authentication. Manage it through /mcp or settings.",
            );
        }
    }
    if config.is_none()
        && service.is_some_and(|service| {
            !matches!(
                service.auth_strategy,
                AuthStrategy::Oauth | AuthStrategy::Unknown
            )
        })
    {
        return match service.and_then(|service| service.setup.reason.clone()) {
            Some(reason) => deny(&reason),
            None => deny("This service does not use automatic OAuth login."),
        };
    }
    if service.is_some_and(|service| service.setup.status == SetupStatus::RequiresSetup)
        && config.is_none()
    {
        return match service.and_then(|service| service.setup.reason.clone()) {
            Some(reason) => deny(&reason),
            None => deny("This service requires setup before OAuth login."),
        };
    }
    // The ENDPOINT PIN: an installed credential or record proves the
    // endpoint the account approved; a login targets it, never a changed
    // catalog URL.
    let bound_endpoint = match credential {
        Some(AuthCredential::Oauth {
            access, endpoint, ..
        }) if !access.is_empty() => endpoint
            .clone()
            .filter(|endpoint| concrete_oauth_endpoint(endpoint)),
        _ => None,
    };
    let exact_record = record.filter(|record| {
        record.connection_id == connection_id
            && service.is_none_or(|service| service.service_id == record.service_id)
    });
    let verified_endpoint = match &exact_record {
        Some(record)
            if record.status == RecordStatus::Connected
                && record.verified_at.is_some_and(|at| at > 0) =>
        {
            Some(record.endpoint.clone())
        }
        _ => None,
    };
    let repair_endpoint = match &exact_record {
        Some(record) => bound_endpoint
            .filter(|bound| bound == &record.endpoint)
            .or_else(|| {
                verified_endpoint
                    .clone()
                    .filter(|verified| verified == &record.endpoint)
            }),
        None => bound_endpoint,
    };
    if add_account
        && repair_endpoint
            .as_deref()
            .is_some_and(concrete_oauth_endpoint)
    {
        // Add allocates a NEW account id for an INSTALLED service whose own
        // record proves the endpoint was approved: the new account lands at
        // that same durable endpoint, never at a changed or unreviewed URL.
        return McpLoginEligibility {
            allowed: true,
            endpoint: repair_endpoint,
            setup_hint: None,
            repair: true,
        };
    }
    if !add_account
        && config.is_none()
        && repair_endpoint
            .as_deref()
            .is_some_and(concrete_oauth_endpoint)
    {
        return McpLoginEligibility {
            allowed: true,
            endpoint: repair_endpoint,
            setup_hint: None,
            repair: true,
        };
    }
    if let Some(McpServerConfig::Http { url, .. }) = config {
        if concrete_oauth_endpoint(url) {
            return McpLoginEligibility {
                allowed: true,
                endpoint: Some(url.clone()),
                setup_hint: None,
                repair: false,
            };
        }
    }
    if let Some(service) = service {
        if fresh_mcp_login_allowed(service) {
            return McpLoginEligibility {
                allowed: true,
                endpoint: service.transport.endpoint().map(str::to_string),
                setup_hint: None,
                repair: false,
            };
        }
        return deny(if service.pinned_from_record {
            "The catalog source is unavailable. Only an approved saved account endpoint can be repaired; remove this account or restore its source."
        } else {
            "This service requires a concrete OAuth endpoint and supported setup before it can be connected."
        });
    }
    deny("This service requires a concrete OAuth endpoint and supported setup before it can be connected.")
}
