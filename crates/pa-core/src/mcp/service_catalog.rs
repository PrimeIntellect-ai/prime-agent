//! The merged MCP service catalog: resolution of the compiled legacy
//! built-ins, declared local sources, and the remote (discovery-only)
//! catalog, plus the durable endpoint pins for installed connections whose
//! source vanished. Port of
//! `packages/coding-agent/src/core/mcp/service-catalog.ts`
//! (`resolveMcpServiceCatalog` + `mapCatalogEntry`) over the
//! `packages/ai/src/mcp/local-catalog.ts` loader.
//!
//! Resolution order, first wins per id: compiled built-ins (linear, notion)
//! -> declared local sources (`mcp-services.json`, trusted by construction)
//! -> remote catalog entries (discovery-only). A local source can never
//! shadow or rebind a builtin id (refused at load with a visible
//! diagnostic); a remote id a local source already owns is dropped with a
//! visible duplicate diagnostic. The SAME resolution feeds the host
//! integrations and the `/mcp` view so both views agree.

use std::collections::HashMap;
use std::path::PathBuf;

use super::catalog_schema::VerificationStatus;
use super::catalog_schema::{AuthStrategy, ClientRegistration, McpServiceEntry, SetupStatus};
use super::connection_store::McpConnectionRecord;
use super::local_catalog::load_local_service_catalog;

/// One merged-catalog entry projected onto the host descriptor shape
/// (TS `McpServiceDescriptor`).
#[derive(Debug, Clone, PartialEq)]
pub struct McpServiceDescriptor {
    /// Stable service id; kernel dispatch id and `mcp:<serviceId>` key.
    pub service_id: String,
    pub label: String,
    pub aliases: Vec<String>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub publisher: Option<String>,
    /// Brand grouping id from the merged catalog (search groups by it).
    pub brand: Option<String>,
    pub docs_url: Option<String>,
    pub homepage: Option<String>,
    pub transport: DescriptorTransport,
    pub auth_strategy: AuthStrategy,
    pub client_registration: Option<ClientRegistration>,
    /// Reviewed upstream scope hints; joined into the engine's requested
    /// scopes when present and nothing is configured.
    pub reviewed_scopes: Vec<String>,
    pub setup: DescriptorSetup,
    /// True only for entries whose provider OAuth metadata was reviewed
    /// (`verification.status`); never a runtime/interop claim.
    pub metadata_reviewed: bool,
    /// True for pre-catalog legacy built-ins; their ids stay reserved.
    pub legacy_builtin: bool,
    /// True when the entry came from a user-declared local source.
    pub local_source: bool,
    /// True when the service's source vanished; the descriptor is pinned to
    /// the installed record's endpoint (manageable, never one-click
    /// connectable).
    pub pinned_from_record: bool,
}

/// The transport the host can act on (TS descriptor mapping): a concrete
/// http endpoint, or discovery-only shapes.
#[derive(Debug, Clone, PartialEq)]
pub enum DescriptorTransport {
    Http { url: String },
    HttpTemplate,
    Sse { url: String },
    Stdio,
    Other,
}

impl DescriptorTransport {
    /// The concrete endpoint when this transport carries one.
    pub fn endpoint(&self) -> Option<&str> {
        match self {
            DescriptorTransport::Http { url } | DescriptorTransport::Sse { url } => Some(url),
            _ => None,
        }
    }
}

/// The paste-relevant setup projection (TS `McpServiceDescriptor["setup"]`).
#[derive(Debug, Clone, PartialEq)]
pub struct DescriptorSetup {
    pub status: SetupStatus,
    pub reason: Option<String>,
    /// Setup fields the entry collects; credential kinds drive the paste flow.
    pub fields: Vec<super::catalog_schema::McpSetupField>,
}

impl McpServiceDescriptor {
    /// Map one merged-catalog entry onto the descriptor shape
    /// (TS `mapCatalogEntry`). `local_source` marks user-declared entries
    /// (trusted by construction); `metadata_reviewed` mirrors the entry's
    /// own review state and is never inferred for local files.
    pub fn from_entry(entry: &McpServiceEntry, local_source: bool) -> Self {
        let transport = match &entry.transport {
            super::catalog_schema::McpServiceTransport::Http { url } => {
                if entry.url.is_empty() {
                    DescriptorTransport::Other
                } else {
                    DescriptorTransport::Http { url: url.clone() }
                }
            }
            super::catalog_schema::McpServiceTransport::HttpTemplate { .. } => {
                DescriptorTransport::HttpTemplate
            }
            super::catalog_schema::McpServiceTransport::Sse { url } => {
                DescriptorTransport::Sse { url: url.clone() }
            }
            super::catalog_schema::McpServiceTransport::Stdio { .. } => DescriptorTransport::Stdio,
        };
        McpServiceDescriptor {
            service_id: entry.server.clone(),
            label: entry.label.clone(),
            aliases: entry.aliases.clone(),
            description: entry.description.clone(),
            category: entry.category.clone(),
            publisher: entry.publisher.clone(),
            brand: Some(entry.service.clone()).filter(|brand| brand != &entry.server),
            docs_url: entry.docs_url.clone(),
            homepage: entry.homepage.clone(),
            transport,
            auth_strategy: entry.auth.strategy,
            client_registration: Some(entry.auth.client_registration),
            reviewed_scopes: entry.auth.reviewed_scopes.clone().unwrap_or_default(),
            setup: DescriptorSetup {
                status: entry.setup.status,
                reason: entry.setup.reason.clone(),
                fields: entry.setup.fields.clone().unwrap_or_default(),
            },
            metadata_reviewed: entry.verification.status == VerificationStatus::MetadataReviewed,
            legacy_builtin: entry.legacy_builtin,
            local_source,
            pinned_from_record: false,
        }
    }

    /// The durable pin for an installed connection whose source vanished:
    /// pinned to the endpoint the credential was verified against, keeps the
    /// connection manageable (verify/disconnect) by its own id, and is never
    /// one-click connectable (`pinned_from_record` is its own trust state).
    pub fn pinned_from_record(record: &McpConnectionRecord) -> Self {
        McpServiceDescriptor {
            service_id: record.service_id.clone(),
            label: record.label.clone(),
            aliases: Vec::new(),
            description: None,
            category: None,
            publisher: None,
            brand: None,
            docs_url: None,
            homepage: None,
            transport: DescriptorTransport::Http {
                url: record.endpoint.clone(),
            },
            auth_strategy: AuthStrategy::Oauth,
            client_registration: Some(ClientRegistration::Unknown),
            reviewed_scopes: Vec::new(),
            setup: DescriptorSetup {
                status: SetupStatus::Ready,
                reason: None,
                fields: Vec::new(),
            },
            metadata_reviewed: false,
            legacy_builtin: false,
            local_source: false,
            pinned_from_record: true,
        }
    }
}

/// Result of merging the compiled built-ins with local sources and remote
/// entries: the descriptors plus visible wiring diagnostics.
#[derive(Debug, Clone, Default)]
pub struct McpCatalogResolution {
    pub descriptors: Vec<McpServiceDescriptor>,
    pub diagnostics: Vec<String>,
}

/// One local source: a file path plus whether the user DECLARED it (a
/// declared-but-missing file is a visible diagnostic; the default
/// `mcp-services.json` simply not existing is normal).
#[derive(Debug, Clone)]
pub struct LocalCatalogSource {
    pub path: PathBuf,
    pub declared: bool,
}

/// The bound on the merged catalog (TS `MAX_TOTAL_CATALOG_ENTRIES`): keeps
/// discovery bounded while never trimming manageability.
pub const MAX_TOTAL_CATALOG_ENTRIES: usize = 500;

/// Resolve the merged service catalog: compiled legacy built-ins, every
/// declared local source, the remote (discovery-only) entries, then the
/// durable pins from existing connection records. First source wins per id;
/// problems surface as visible diagnostics, never as failures.
pub fn resolve_mcp_service_catalog(
    local_sources: &[LocalCatalogSource],
    remote: Option<&[super::catalog_schema::McpServiceEntry]>,
    records: &[McpConnectionRecord],
) -> McpCatalogResolution {
    let mut diagnostics: Vec<String> = Vec::new();
    let mut by_id: HashMap<String, McpServiceDescriptor> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let add_entry = |entry: &McpServiceEntry,
                     local_source: bool,
                     by_id: &mut HashMap<String, McpServiceDescriptor>,
                     order: &mut Vec<String>,
                     diagnostics: &mut Vec<String>| {
        if by_id.contains_key(&entry.server) {
            diagnostics.push(format!(
                "Duplicate MCP service id \"{}\"; the first source wins.",
                entry.server
            ));
            return;
        }
        order.push(entry.server.clone());
        by_id.insert(
            entry.server.clone(),
            McpServiceDescriptor::from_entry(entry, local_source),
        );
    };

    // 1. Compiled legacy built-ins: their ids are reserved.
    let builtins = super::catalog_schema::compiled_builtin_services();
    let mut reserved: HashMap<String, String> = HashMap::new();
    for entry in &builtins {
        reserved.insert(entry.server.clone(), entry.label.clone());
        add_entry(entry, false, &mut by_id, &mut order, &mut diagnostics);
    }
    // 2. Reserved ids = the COMPILED builtins only (spec §3.6 resolution:
    //    first wins per id, and a local source can never shadow or rebind
    //    a builtin). Remote entries are discovery-only and later in the
    //    order, so a local id equal to a remote id wins and the dropped
    //    remote entry surfaces as a visible duplicate diagnostic. A
    //    dynamic remote refresh can therefore never break a user's local
    //    file by claiming its id later.
    // 3. Local sources: first source wins per id; one unreadable/invalid
    //    source never blocks the rest.
    for source in local_sources {
        match load_local_service_catalog(&source.path, &reserved) {
            Ok(loaded) => {
                if loaded.path.is_none() {
                    if source.declared {
                        diagnostics.push(format!(
                            "Declared MCP catalog source not found: {}",
                            source.path.display()
                        ));
                    }
                    continue;
                }
                for entry in &loaded.entries {
                    add_entry(entry, true, &mut by_id, &mut order, &mut diagnostics);
                }
            }
            Err(reason) => {
                // Bounded, visible, never a startup failure.
                let reason = if reason.is_empty() {
                    "unknown error".to_string()
                } else {
                    reason.chars().take(200).collect()
                };
                diagnostics.push(format!(
                    "MCP catalog source failed to load: {}: {reason}",
                    source.path.display()
                ));
            }
        }
    }
    // 4. Remote entries (discovery-only): dropped per id collision above.
    if let Some(remote_entries) = remote {
        for entry in remote_entries {
            add_entry(entry, false, &mut by_id, &mut order, &mut diagnostics);
        }
    }
    // 5. Durable pins: records of services the catalog no longer defines.
    for record in records {
        if by_id.contains_key(&record.service_id) {
            continue;
        }
        if !order.contains(&record.service_id) {
            order.push(record.service_id.clone());
        }
        by_id.insert(
            record.service_id.clone(),
            McpServiceDescriptor::pinned_from_record(record),
        );
    }
    let mut descriptors: Vec<McpServiceDescriptor> = order
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .collect();
    // 6. The total cap: installed connections and built-ins are never
    //    trimmed (dropping one would resurrect shadow entries or hide
    //    credential-only accounts); only uninstalled candidates fill the
    //    remaining budget, and an over-cap retained inventory still wins
    //    with an explicit diagnostic instead of silent truncation.
    if descriptors.len() > MAX_TOTAL_CATALOG_ENTRIES {
        let installed: std::collections::HashSet<&str> = records
            .iter()
            .map(|record| record.service_id.as_str())
            .collect();
        let mut kept: Vec<McpServiceDescriptor> = Vec::new();
        let mut fill: Vec<McpServiceDescriptor> = Vec::new();
        let mut ignored = 0usize;
        for descriptor in descriptors {
            let retained =
                installed.contains(descriptor.service_id.as_str()) || descriptor.legacy_builtin;
            if retained {
                kept.push(descriptor);
            } else if kept.len() + fill.len() < MAX_TOTAL_CATALOG_ENTRIES {
                fill.push(descriptor);
            } else {
                ignored += 1;
            }
        }
        diagnostics.push(format!(
            "MCP service catalog discovery capped at {MAX_TOTAL_CATALOG_ENTRIES} entries; {ignored} entries were ignored. Installed connections and built-in services are always kept{}.",
            if kept.len() > MAX_TOTAL_CATALOG_ENTRIES {
                format!(" (retained inventory alone exceeded the cap: {} kept)", kept.len())
            } else {
                String::new()
            }
        ));
        kept.extend(fill);
        descriptors = kept;
    }
    McpCatalogResolution {
        descriptors,
        diagnostics,
    }
}

/// The default local source path beside the user's settings:
/// `<agent-dir>/mcp-services.json`.
pub fn default_local_catalog_source(agent_dir: &std::path::Path) -> LocalCatalogSource {
    LocalCatalogSource {
        path: agent_dir.join("mcp-services.json"),
        declared: false,
    }
}
