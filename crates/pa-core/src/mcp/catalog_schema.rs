//! Strict schema for the MCP service catalog: the `plugins/catalog.v2.json`
//! client contract (spec §1.2) and the user-authored `mcp-services.json`
//! local sources (v1), both validated with the shipped TS contract
//! (`packages/ai/src/mcp/catalog.ts` `validateMcpServiceEntry`).
//!
//! Whole-file fail-closed: any unknown key, wrong type, or broken invariant
//! rejects the entire payload — a bad catalog falls back to the last-good
//! snapshot (`deny_unknown_fields` mirrors the versioned-path discipline:
//! additive schema changes require a version bump, so old clients keep their
//! snapshot silently instead of mis-parsing).

use serde::Deserialize;

use super::url_checks::is_literal_private_or_loopback_host;

/// Envelope of the plugins catalog (`catalog.v2.json`): exactly `version`,
/// `counts`, `entries`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogFileEnvelope {
    version: u8,
    counts: CatalogCounts,
    entries: Vec<McpServiceEntry>,
}

/// The 14 derived count keys (drift-checked catalog CI side); every key is
/// informational for the client, so a missing one never fails the payload but
/// an unknown one does (additive changes need a version bump).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogCounts {
    pub total: Option<u64>,
    pub http: Option<u64>,
    #[serde(rename = "httpTemplate")]
    pub http_template: Option<u64>,
    pub sse: Option<u64>,
    pub stdio: Option<u64>,
    pub ready: Option<u64>,
    #[serde(rename = "requiresSetup")]
    pub requires_setup: Option<u64>,
    #[serde(rename = "metadataReviewed")]
    pub metadata_reviewed: Option<u64>,
    #[serde(rename = "oauthStrategy")]
    pub oauth_strategy: Option<u64>,
    #[serde(rename = "apiKeyStrategy")]
    pub api_key_strategy: Option<u64>,
    #[serde(rename = "readinessOauthReady")]
    pub readiness_oauth_ready: Option<u64>,
    #[serde(rename = "readinessUserSetup")]
    pub readiness_user_setup: Option<u64>,
    #[serde(rename = "readinessPrimeRestricted")]
    pub readiness_prime_restricted: Option<u64>,
    #[serde(rename = "readinessUnknown")]
    pub readiness_unknown: Option<u64>,
}

/// The validated plugins catalog: `version` (1 or 2), the informational
/// counts, and entries sorted by server id with unique ids.
#[derive(Debug, Clone)]
pub struct PluginsCatalog {
    pub version: u8,
    pub counts: CatalogCounts,
    pub entries: Vec<McpServiceEntry>,
}

/// One catalog entry = one reviewed connection (endpoint) of a service
/// (spec §1.2; TS `McpServiceEntry`). `server` is the stable id, the kernel
/// dispatch id, and the `mcp:<server>` credential key.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct McpServiceEntry {
    pub server: String,
    /// Brand grouping id; defaults to `server` in the aggregate.
    pub service: String,
    pub label: String,
    /// Default reviewed endpoint; empty for stdio/tenant-template transports.
    pub url: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub publisher: Option<String>,
    pub homepage: Option<String>,
    pub docs_url: Option<String>,
    pub privacy_url: Option<String>,
    pub support_url: Option<String>,
    /// Lowercase, sorted, distinct from the server id.
    pub aliases: Vec<String>,
    pub transport: McpServiceTransport,
    pub auth: McpServiceAuth,
    pub setup: McpServiceSetup,
    pub verification: McpServiceVerification,
    /// True only for legacy built-in integrations (linear, notion); their ids
    /// stay reserved — local sources can never shadow them.
    pub legacy_builtin: bool,
    pub provenance: Vec<McpServiceProvenance>,
    /// OAuth-strategy entries only; never carries a client id or secret
    /// (both keys are rejected).
    pub oauth: Option<McpServiceOauth>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum McpServiceTransport {
    #[serde(rename_all = "camelCase")]
    Http { url: String },
    #[serde(rename_all = "camelCase")]
    HttpTemplate {
        template: String,
        variables: Vec<TemplateVariable>,
    },
    #[serde(rename_all = "camelCase")]
    Sse { url: String },
    #[serde(rename_all = "camelCase")]
    Stdio { servers: Vec<StdioServerDef> },
}

impl McpServiceTransport {
    /// The concrete HTTP/SSE endpoint when the transport carries one.
    pub fn endpoint(&self) -> Option<&str> {
        match self {
            McpServiceTransport::Http { url } | McpServiceTransport::Sse { url } => {
                Some(url.as_str())
            }
            McpServiceTransport::HttpTemplate { .. } | McpServiceTransport::Stdio { .. } => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateVariable {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StdioServerDef {
    pub name: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<std::collections::BTreeMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct McpServiceAuth {
    pub strategy: AuthStrategy,
    pub client_registration: ClientRegistration,
    /// Reviewed upstream scope hints; the connect flow joins them into the
    /// requested scopes only when nothing is configured.
    #[serde(default)]
    pub reviewed_scopes: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthStrategy {
    Oauth,
    ApiKey,
    None,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClientRegistration {
    Dynamic,
    #[serde(rename = "pre-registered")]
    PreRegistered,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpServiceSetup {
    pub status: SetupStatus,
    /// Required on `requires-setup` entries (picker copy).
    pub reason: Option<String>,
    /// Setup fields the entry collects; credential kinds drive the paste flow.
    #[serde(default)]
    pub fields: Option<Vec<McpSetupField>>,
    /// INFORMATIONAL readiness; never a connect gate.
    pub readiness: Option<Readiness>,
    pub requirement: Option<SetupRequirement>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SetupStatus {
    Ready,
    #[serde(rename = "requires-setup")]
    RequiresSetup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Readiness {
    #[serde(rename = "oauth-ready")]
    OauthReady,
    #[serde(rename = "user-setup")]
    UserSetup,
    #[serde(rename = "prime-restricted")]
    PrimeRestricted,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SetupRequirement {
    #[serde(rename = "api-key")]
    ApiKey,
    #[serde(rename = "bearer-token")]
    BearerToken,
    #[serde(rename = "registered-client")]
    RegisteredClient,
    Tenant,
    #[serde(rename = "unsupported-transport")]
    UnsupportedTransport,
    #[serde(rename = "local-runtime")]
    LocalRuntime,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpSetupField {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub required: bool,
    /// What the field collects; absent means the importer had no signal.
    pub kind: Option<SetupFieldKind>,
    /// Fields sharing a credential-set id are ALTERNATIVE NAMES for one
    /// credential (GitHub's `GITHUB_PAT_TOKEN` / `GITHUB_PERSONAL_ACCESS_TOKEN`).
    #[serde(rename = "credentialSet", default)]
    pub credential_set: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SetupFieldKind {
    #[serde(rename = "env-var")]
    EnvVar,
    Url,
    #[serde(rename = "client-id")]
    ClientId,
    #[serde(rename = "client-secret")]
    ClientSecret,
    #[serde(rename = "bearer-token")]
    BearerToken,
    #[serde(rename = "api-key")]
    ApiKey,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpServiceVerification {
    pub status: VerificationStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VerificationStatus {
    #[serde(rename = "metadata-reviewed")]
    MetadataReviewed,
    Unverified,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpServiceProvenance {
    pub source: ProvenanceSource,
    pub repository: Option<String>,
    pub commit: Option<String>,
    pub path: Option<String>,
    pub url: Option<String>,
    pub license: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProvenanceSource {
    #[serde(rename = "openai-plugins")]
    OpenAiPlugins,
    #[serde(rename = "claude-plugins-official")]
    ClaudePluginsOfficial,
    Prime,
    User,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpServiceOauth {
    /// Literal `"oauth"` marker.
    pub kind: OauthKind,
    pub scopes: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum OauthKind {
    #[serde(rename = "oauth")]
    Oauth,
}

/// A bounded echo of an entry id in errors: never reprint untrusted long
/// (possibly secret-ish) input.
fn safe_entry_id(entry_id: &str) -> String {
    if entry_id.len() > 64 {
        format!("{}\u{2026}", &entry_id[..64])
    } else {
        entry_id.to_string()
    }
}

fn require_string(entry_id: &str, field: &str, value: &str) -> Result<String, String> {
    if value.is_empty() {
        Err(format!(
            "catalog entry {}: {field} must be a non-empty string",
            safe_entry_id(entry_id)
        ))
    } else {
        Ok(value.to_string())
    }
}

fn require_https_url(entry_id: &str, field: &str, url: &str) -> Result<String, String> {
    require_string(entry_id, field, url)?;
    // Do not echo the input value: it may carry query tokens or secrets.
    let parsed = url::Url::parse(url).map_err(|_| {
        format!(
            "catalog entry {}: {field} is not an absolute URL",
            safe_entry_id(entry_id)
        )
    })?;
    let has_credentials = parsed.username().is_empty() && parsed.password().is_none();
    if parsed.scheme() != "https" || !has_credentials || parsed.fragment().is_some() {
        return Err(format!(
            "catalog entry {}: {field} must be an absolute HTTPS URL without credentials or a fragment",
            safe_entry_id(entry_id)
        ));
    }
    if is_literal_private_or_loopback_host(parsed.host_str().unwrap_or_default()) {
        return Err(format!(
            "catalog entry {}: {field} must not be a literal loopback, private, link-local or unspecified endpoint",
            safe_entry_id(entry_id)
        ));
    }
    Ok(url.to_string())
}

impl McpServiceEntry {
    /// Structural validation for one entry (TS `validateMcpServiceEntry`):
    /// id pattern, transport/url consistency, aliases rules, setup honesty,
    /// and the no-secrets invariant. Unknown keys were already rejected by
    /// `deny_unknown_fields` at the serde layer.
    pub fn validate(&self) -> Result<(), String> {
        let at = safe_entry_id(&self.server);
        let fail = |message: String| Err(message);
        require_string(&at, "server", &self.server)?;
        if !server_id_valid(&self.server) {
            return fail(format!(
                "catalog entry {at}: server id must match ^[a-z0-9][a-z0-9-]{{0,63}}$"
            ));
        }
        require_string(&at, "label", &self.label)?;
        require_string(&at, "service", &self.service)?;
        match &self.transport {
            McpServiceTransport::Http { url } | McpServiceTransport::Sse { url } => {
                let endpoint = require_https_url(&at, "transport.url", url)?;
                if self.url != endpoint {
                    return fail(format!("catalog entry {at}: url must equal transport.url"));
                }
            }
            McpServiceTransport::HttpTemplate {
                template,
                variables,
            } => {
                require_string(&at, "transport.template", template)?;
                if variables.is_empty() {
                    return fail(format!(
                        "catalog entry {at}: http-template transports need at least one variable"
                    ));
                }
                for variable in variables {
                    require_string(&at, "transport.variables[].name", &variable.name)?;
                    require_string(
                        &at,
                        "transport.variables[].description",
                        &variable.description,
                    )?;
                }
                if !self.url.is_empty() {
                    return fail(format!(
                        "catalog entry {at}: url must be empty for http-template transports"
                    ));
                }
            }
            McpServiceTransport::Stdio { servers } => {
                if servers.is_empty() {
                    return fail(format!(
                        "catalog entry {at}: stdio transports need at least one server"
                    ));
                }
                for server in servers {
                    require_string(&at, "transport.servers[].name", &server.name)?;
                    require_string(&at, "transport.servers[].command", &server.command)?;
                }
                if !self.url.is_empty() {
                    return fail(format!(
                        "catalog entry {at}: url must be empty for stdio transports"
                    ));
                }
            }
        }
        for scope in self.auth.reviewed_scopes.iter().flatten() {
            require_string(&at, "auth.reviewedScopes[]", scope)?;
        }
        if self.setup.status == SetupStatus::RequiresSetup
            && self.setup.reason.as_deref().is_none_or(str::is_empty)
        {
            return fail(format!(
                "catalog entry {at}: requires-setup entries need a reason"
            ));
        }
        for field in self.setup.fields.iter().flatten() {
            require_string(&at, "setup.fields[].id", &field.id)?;
            require_string(&at, "setup.fields[].label", &field.label)?;
            if let Some(credential_set) = &field.credential_set {
                require_string(&at, "setup.fields[].credentialSet", credential_set)?;
            }
        }
        if let Some(oauth) = &self.oauth {
            if self.auth.strategy != AuthStrategy::Oauth {
                return fail(format!(
                    "catalog entry {at}: oauth is only allowed on oauth-strategy entries"
                ));
            }
            if let Some(scopes) = &oauth.scopes {
                require_string(&at, "oauth.scopes", scopes)?;
            }
        }
        let server = &self.server;
        for alias in &self.aliases {
            if alias.to_lowercase() != *alias || alias == server {
                return fail(format!(
                    "catalog entry {at}: aliases must be lowercase strings distinct from the server id"
                ));
            }
        }
        for pair in self.aliases.windows(2) {
            if pair[0] >= pair[1] {
                return fail(format!(
                    "catalog entry {at}: aliases must be sorted and unique"
                ));
            }
        }
        if self.provenance.is_empty() {
            return fail(format!(
                "catalog entry {at}: provenance must be a non-empty array"
            ));
        }
        Ok(())
    }
}

/// Stable service id pattern (also the kernel dispatch id grammar).
pub(crate) fn server_id_valid(server: &str) -> bool {
    let mut chars = server.chars();
    let first = match chars.next() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => first,
        _ => return false,
    };
    let _ = first;
    let rest: Vec<char> = chars.collect();
    rest.len() <= 63
        && rest
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-')
}

/// Parse and validate a plugins catalog payload (v1 local or v2 remote/
/// bundled). Whole-file fail-closed: any invalid entry rejects the entire
/// file; callers keep their last-good snapshot on `Err`.
pub fn parse_plugins_catalog(bytes: &[u8]) -> Result<PluginsCatalog, String> {
    // Never echo parser text: it can quote raw (possibly secret) input.
    let envelope: CatalogFileEnvelope = serde_json::from_slice(bytes)
        .map_err(|_| "catalog is not a valid catalog document".to_string())?;
    if envelope.version != 1 && envelope.version != 2 {
        return Err(format!(
            "catalog has unsupported version {}",
            envelope.version
        ));
    }
    let mut entries = envelope.entries;
    for entry in &entries {
        entry
            .validate()
            .map_err(|error| format!("{error} (rejected)"))?;
    }
    let mut seen = std::collections::HashSet::new();
    for entry in &entries {
        if !seen.insert(entry.server.clone()) {
            return Err(format!(
                "catalog contains duplicate server id {}",
                safe_entry_id(&entry.server)
            ));
        }
    }
    entries.sort_by(|a, b| a.server.cmp(&b.server));
    Ok(PluginsCatalog {
        version: envelope.version,
        counts: envelope.counts,
        entries,
    })
}

/// The compiled legacy built-ins (the offline fallback when no snapshot is
/// available): the pre-catalog integrations whose ids stay reserved. Data
/// mirrors the catalog entries for `linear` and `notion` (metadata-reviewed
/// OAuth dynamic-client services).
pub fn compiled_builtin_services() -> Vec<McpServiceEntry> {
    let json = serde_json::json!([
        {
            "server": "linear",
            "service": "linear",
            "label": "Linear",
            "url": "https://mcp.linear.app/mcp",
            "description": "Search, create and update Linear issues, projects, and initiatives. Draft PRDs, write updates, analyze customer requests, and keep plans up to date \u{2014} all from within ChatGPT",
            "category": "Productivity",
            "publisher": "Linear",
            "homepage": "https://linear.app/",
            "privacyUrl": "https://linear.app/privacy",
            "supportUrl": "https://linear.app/contact",
            "aliases": ["linear-app"],
            "transport": { "type": "http", "url": "https://mcp.linear.app/mcp" },
            "auth": { "strategy": "oauth", "clientRegistration": "dynamic" },
            "setup": { "status": "ready", "readiness": "oauth-ready" },
            "verification": { "status": "metadata-reviewed" },
            "legacyBuiltin": true,
            "provenance": [{ "source": "prime" }],
            "oauth": { "kind": "oauth" }
        },
        {
            "server": "notion",
            "service": "notion",
            "label": "Notion",
            "url": "https://mcp.notion.com/mcp",
            "description": "Notion workflows for implementation planning, research synthesis, meeting preparation, and knowledge capture.",
            "category": "Productivity",
            "publisher": "Notion",
            "homepage": "https://www.notion.so/",
            "privacyUrl": "https://www.notion.com/help/privacy",
            "aliases": ["notion-workspace"],
            "transport": { "type": "http", "url": "https://mcp.notion.com/mcp" },
            "auth": { "strategy": "oauth", "clientRegistration": "dynamic" },
            "setup": { "status": "ready", "readiness": "oauth-ready" },
            "verification": { "status": "metadata-reviewed" },
            "legacyBuiltin": true,
            "provenance": [{ "source": "prime" }],
            "oauth": { "kind": "oauth" }
        }
    ]);
    let entries: Vec<McpServiceEntry> =
        serde_json::from_value(json).expect("compiled builtin catalog entries are valid");
    for entry in &entries {
        entry.validate().expect("compiled builtin entries validate");
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The REAL shipped catalog payload projected to the v2 client contract
    /// (the shipped TS bundled catalog, audit evidence stripped per spec
    /// §1.2: envelope {version, counts, entries}, 68 entries, provenance
    /// [{"source":"prime"}]).
    const REAL_PAYLOAD: &str = include_str!("../../tests/fixtures/mcp/plugins-catalog.v2.json");

    fn parse(bytes: &[u8]) -> PluginsCatalog {
        parse_plugins_catalog(bytes).expect("catalog parses")
    }

    /// Parity gate: the real 68-service payload parses with zero failures.
    #[test]
    fn real_sixty_eight_service_payload_parses_cleanly() {
        let catalog = parse(REAL_PAYLOAD.as_bytes());
        assert_eq!(catalog.version, 2);
        assert_eq!(catalog.entries.len(), 68, "68 services, 0 failures");
        // Sorted by server id, unique ids.
        let ids: Vec<&str> = catalog.entries.iter().map(|e| e.server.as_str()).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted);
        // The two legacy built-ins ship metadata-reviewed.
        for server in ["linear", "notion"] {
            let entry = catalog
                .entries
                .iter()
                .find(|e| e.server == server)
                .expect(server);
            assert!(entry.legacy_builtin);
            assert_eq!(
                entry.verification.status,
                VerificationStatus::MetadataReviewed
            );
        }
        // The declared counts match the entries (the catalog CI drift check,
        //mirrored here over the projection).
        let counts = &catalog.counts;
        assert_eq!(counts.total, Some(68));
        assert_eq!(counts.http, Some(68));
        assert_eq!(counts.ready, Some(57));
        assert_eq!(counts.requires_setup, Some(11));
        assert_eq!(counts.metadata_reviewed, Some(2));
        assert_eq!(counts.oauth_strategy, Some(5));
        assert_eq!(counts.api_key_strategy, Some(10));
        assert_eq!(counts.readiness_oauth_ready, Some(57));
        assert_eq!(counts.readiness_user_setup, Some(11));
        assert_eq!(counts.readiness_prime_restricted, Some(0));
        assert_eq!(counts.readiness_unknown, Some(0));
        // The pasteable credential shapes survive parsing (GitHub's
        // credentialSet alias pair).
        let github = catalog
            .entries
            .iter()
            .find(|e| e.server == "github")
            .expect("github");
        let field_ids: Vec<&str> = github
            .setup
            .fields
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|f| f.id.as_str())
            .collect();
        assert_eq!(
            field_ids,
            ["GITHUB_PAT_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"]
        );
        assert!(github
            .setup
            .fields
            .as_deref()
            .unwrap_or_default()
            .iter()
            .all(|f| f.credential_set.as_deref() == Some("github-pat")));
    }

    /// Fail-closed: one malformed entry rejects the ENTIRE file (plugins do
    /// not use skip-invalid; a bad file falls back to the last-good snapshot).
    #[test]
    fn one_malformed_entry_rejects_the_whole_file() {
        let catalog: serde_json::Value = serde_json::from_str(REAL_PAYLOAD).unwrap();
        let bad = serde_json::to_string(&serde_json::json!({
            "version": 2,
            "counts": {},
            "entries": [
                catalog["entries"][0],
                { "server": "broken-entry", "service": "x", "label": "x", "url": "",
                  "aliases": [], "transport": {"type": "http", "url": "https://ok.example/mcp"},
                  "auth": {"strategy": "none", "clientRegistration": "unknown"},
                  "setup": {"status": "ready"},
                  "verification": {"status": "unverified"},
                  "legacyBuiltin": false,
                  "provenance": [{"source": "prime"}] }
            ]
        }))
        .unwrap();
        let error = parse_plugins_catalog(bad.as_bytes()).expect_err("whole file fails closed");
        assert!(
            error.contains("broken-entry"),
            "names the bad entry: {error}"
        );
    }

    /// Fail-closed: unsupported versions are rejected silently-forever (old
    /// clients stay on their snapshot).
    #[test]
    fn unsupported_version_rejects() {
        for version in [0u8, 3, 255] {
            let doc = serde_json::json!({ "version": version, "counts": {}, "entries": [] });
            let error = parse_plugins_catalog(doc.to_string().as_bytes())
                .expect_err("unsupported version rejects");
            assert!(error.contains("unsupported version"), "{error}");
        }
    }

    /// Fail-closed: unknown keys reject (additive schema changes need a
    /// version bump) — envelope, counts, entry, and auth.
    #[test]
    fn unknown_keys_reject() {
        let base = serde_json::json!({
            "version": 2,
            "counts": {},
            "entries": [valid_entry("svc-a")]
        });
        // The clean shape parses.
        parse_plugins_catalog(base.to_string().as_bytes()).expect("clean shape parses");
        // Envelope unknown key rejects.
        let mut doc = base.clone();
        doc["sources"] = serde_json::json!([]);
        assert!(
            parse_plugins_catalog(doc.to_string().as_bytes()).is_err(),
            "envelope sources key rejects"
        );
        // Counts unknown key rejects.
        let mut doc = base.clone();
        doc["counts"]["mergedFromBothSources"] = serde_json::json!(1);
        assert!(
            parse_plugins_catalog(doc.to_string().as_bytes()).is_err(),
            "counts unknown key rejects"
        );
        // Unknown ENTRY key rejects the file.
        let mut doc = base.clone();
        doc["entries"][0]["experimentalNewField"] = serde_json::json!("v3 shape");
        assert!(
            parse_plugins_catalog(doc.to_string().as_bytes()).is_err(),
            "entry unknown key rejects"
        );
        // Unknown AUTH key rejects the file.
        let mut doc = base.clone();
        doc["entries"][0]["auth"]["alternatives"] = serde_json::json!([]);
        assert!(
            parse_plugins_catalog(doc.to_string().as_bytes()).is_err(),
            "auth unknown key rejects"
        );
    }

    fn valid_entry(server: &str) -> serde_json::Value {
        serde_json::json!({
            "server": server, "service": server, "label": "Fixture",
            "url": format!("https://{server}.example/mcp"),
            "aliases": [],
            "transport": { "type": "http", "url": format!("https://{server}.example/mcp") },
            "auth": { "strategy": "oauth", "clientRegistration": "dynamic" },
            "setup": { "status": "ready" },
            "verification": { "status": "unverified" },
            "legacyBuiltin": false,
            "provenance": [{ "source": "prime" }],
            "oauth": { "kind": "oauth" }
        })
    }

    /// The compiled legacy built-ins match the shipped catalog entries for
    /// linear/notion (reserved ids, metadata-reviewed, OAuth dynamic).
    #[test]
    fn compiled_builtins_match_the_catalog_entries() {
        let catalog = parse(REAL_PAYLOAD.as_bytes());
        let builtins = compiled_builtin_services();
        for builtin in &builtins {
            let shipped = catalog
                .entries
                .iter()
                .find(|e| e.server == builtin.server)
                .expect("builtin in the shipped catalog");
            assert_eq!(builtin, shipped, "compiled fallback mirrors the payload");
        }
        assert_eq!(builtins.len(), 2);
    }
}
