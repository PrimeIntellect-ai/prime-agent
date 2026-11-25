//! Every secret bots can get, and the one plan that decides which of them
//! reach a bot. A candidate is one secret source (an API key, a login,
//! GitHub, a custom secret, or an MCP login) with its platform secrets and its header
//! rules. [`plan`] gives each candidate a status under the
//! `bots.inject.<name>` settings and the platform's limits. A bot's
//! network rules are the rules of the [`SecretStatus::Ok`] and
//! [`SecretStatus::Stale`] candidates. The `/secrets` view lists the same
//! plan, so the view and the bots never disagree.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{bail, Result};
use base64::Engine as _;
use pa_core::auth::{AuthCredential, AuthStorage, PRIME_INFERENCE_PROVIDER_ID};
use pa_core::settings::{BotSecretDef, SettingsManager};
use pa_sandbox::HeaderRule;
use serde_json::{json, Value};

use super::credentials::{self, key_fingerprint};
use super::{github, logins};

/// The platform's limit on header-rule hosts per sandbox.
pub const MAX_RULE_HOSTS: usize = 32;
/// The platform's limit on one secret value.
pub const MAX_SECRET_BYTES: usize = 16 * 1024;
/// The platform's limit on the header names and values of one rule host.
const MAX_HEADER_BYTES_PER_HOST: usize = 8 * 1024;
/// The platform's limit on different secrets per rule host.
const MAX_SECRETS_PER_HOST: usize = 10;
/// The auth storage entries that hold custom secret values.
pub const CUSTOM_AUTH_PREFIX: &str = "bot-secret:";
/// The headers the platform refuses to set.
const RESERVED_HEADERS: [&str; 9] = [
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "upgrade",
    "keep-alive",
    "te",
    "trailer",
    ":authority",
];

/// Where a secret comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
    /// A provider API key in the auth storage.
    ApiKey,
    /// A subscription login ([`super::logins`]).
    Login,
    /// A remote MCP server login (`mcp:<server>`).
    Mcp,
    /// The GitHub token.
    GitHub,
    /// A custom secret from `/secrets`.
    Custom,
}

impl SecretKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ApiKey => "api key",
            Self::Login => "login",
            Self::Mcp => "mcp login",
            Self::GitHub => "github",
            Self::Custom => "custom",
        }
    }

    /// Secrets with a stable name get their value updated in place; the
    /// others carry a fingerprint of the value in the name.
    pub(super) fn stable_names(self) -> bool {
        matches!(self, Self::GitHub | Self::Login | Self::Mcp)
    }
}

/// What the plan decided for one candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretStatus {
    /// Bots get it.
    Ok,
    /// Bots get it, but the value is out of date.
    Stale,
    /// `bots.inject.<name>` is `false`.
    Off,
    /// A platform limit left no rule host for it.
    OverCap,
    /// A value is over the platform's 16 KiB limit.
    TooLarge,
}

impl SecretStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Stale => "stale",
            Self::Off => "off",
            Self::OverCap => "over-cap",
            Self::TooLarge => "too large",
        }
    }

    /// Whether bots get the candidate's rules.
    #[must_use]
    pub fn injected(self) -> bool {
        matches!(self, Self::Ok | Self::Stale)
    }
}

/// One secret source.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    /// The `bots.inject.<name>` key: the auth storage id, or the custom
    /// secret's name.
    pub name: String,
    pub kind: SecretKind,
    /// The platform secrets, as name and value.
    pub secrets: Vec<(String, String)>,
    /// The header rules that reference the secrets, by host.
    pub rules: BTreeMap<String, HeaderRule>,
    pub stale: bool,
}

/// One candidate and its status. The rules hold only the hosts it got.
#[derive(Debug, Clone, PartialEq)]
pub struct Planned {
    pub candidate: Candidate,
    pub status: SecretStatus,
}

/// The header bytes of one rule after the platform fills in `secrets`.
fn header_bytes(rule: &HeaderRule, secrets: &[(String, String)]) -> usize {
    rule.headers
        .iter()
        .map(|(name, template)| {
            let filled = secrets
                .iter()
                .fold(template.clone(), |text, (secret, value)| {
                    text.replace(&format!("${{prime.secrets.{secret}}}"), value)
                });
            name.len() + filled.len()
        })
        .sum()
}

/// The secrets one rule references.
fn referenced(rule: &HeaderRule, secrets: &[(String, String)]) -> usize {
    secrets
        .iter()
        .filter(|(secret, _)| {
            let reference = format!("${{prime.secrets.{secret}}}");
            rule.headers
                .values()
                .any(|value| value.contains(&reference))
        })
        .count()
}

/// Decide each candidate's status, in order: earlier candidates keep their
/// hosts. A host an earlier candidate holds is left out (the platform
/// never combines rules), and so is a host past `max_hosts` or a rule
/// over the per-host limits.
#[must_use]
pub fn plan(
    candidates: Vec<Candidate>,
    inject: impl Fn(&str) -> bool,
    max_hosts: usize,
) -> Vec<Planned> {
    let mut hosts: BTreeSet<String> = BTreeSet::new();
    candidates
        .into_iter()
        .map(|mut candidate| {
            let status = if !inject(&candidate.name) {
                SecretStatus::Off
            } else if candidate
                .secrets
                .iter()
                .any(|(_, value)| value.len() > MAX_SECRET_BYTES)
            {
                SecretStatus::TooLarge
            } else {
                let secrets = candidate.secrets.clone();
                candidate.rules.retain(|host, rule| {
                    hosts.len() < max_hosts
                        && !hosts.contains(host)
                        && header_bytes(rule, &secrets) <= MAX_HEADER_BYTES_PER_HOST
                        && referenced(rule, &secrets) <= MAX_SECRETS_PER_HOST
                        && hosts.insert(host.clone())
                });
                if candidate.rules.is_empty() {
                    SecretStatus::OverCap
                } else if candidate.stale {
                    SecretStatus::Stale
                } else {
                    SecretStatus::Ok
                }
            };
            Planned { candidate, status }
        })
        .collect()
}

/// The rule hosts bots get under `planned`.
#[must_use]
pub fn host_count(planned: &[Planned]) -> usize {
    planned
        .iter()
        .filter(|entry| entry.status.injected())
        .map(|entry| entry.candidate.rules.len())
        .sum()
}

/// The candidates a new bot's API keys, GitHub access, and custom secrets
/// give, in plan order: `required` (the bot's provider, when it uses an
/// API key) first, then Prime Inference, the other API keys, GitHub (when
/// `github`), and the custom secrets. `owner` names the GitHub secrets.
/// Blocking: it may run a `!command` key or the `gh` CLI.
fn candidates(
    auth: &mut AuthStorage,
    settings: &SettingsManager,
    agent_dir: &Path,
    owner: &str,
    required: Option<&str>,
    github: bool,
) -> Vec<Candidate> {
    let mut candidates = credentials::api_key_candidates(auth, required);
    if github {
        candidates.extend(github::candidate(agent_dir, owner));
    }
    candidates.extend(custom_candidates(auth, &settings.get_bots_secrets()));
    candidates
}

/// The plan for a new bot; its logins hold `reserved_hosts` rule hosts
/// already. Blocking, like [`candidates`].
#[must_use]
pub fn plan_for(
    agent_dir: &Path,
    owner: &str,
    required: Option<&str>,
    github: bool,
    reserved_hosts: usize,
) -> Vec<Planned> {
    let mut auth = AuthStorage::create(agent_dir);
    let settings = SettingsManager::create(agent_dir, agent_dir);
    let candidates = candidates(&mut auth, &settings, agent_dir, owner, required, github);
    plan(
        candidates,
        |name| settings.get_bots_inject(name),
        MAX_RULE_HOSTS.saturating_sub(reserved_hosts),
    )
}

/// The stored logins as candidates: the subscription logins, or (with
/// `mcp`) the MCP server logins. An OAuth login past its expiry is stale.
fn login_candidates(auth: &AuthStorage, owner: &str, mcp: bool) -> Vec<Candidate> {
    let stored = auth.get_all();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        });
    let providers: Vec<String> = if mcp {
        stored
            .0
            .keys()
            .filter(|provider| provider.starts_with(logins::MCP_PREFIX))
            .cloned()
            .collect()
    } else {
        logins::LOGIN_PROVIDERS.map(str::to_string).to_vec()
    };
    providers
        .into_iter()
        .filter_map(|provider| {
            let credential = stored.credential(&provider)?;
            let stale =
                matches!(credential, AuthCredential::Oauth { expires, .. } if expires <= now);
            let injection = logins::injection(&provider, owner, &credential)?;
            Some(Candidate {
                name: provider,
                kind: if mcp {
                    SecretKind::Mcp
                } else {
                    SecretKind::Login
                },
                secrets: injection.secrets,
                rules: injection.rules,
                stale,
            })
        })
        .collect()
}

/// The plan the `/secrets` view shows, in a new bot's order: the
/// subscription logins, a Prime Inference bot's candidates (with GitHub as
/// `bots.github` sets it), then the MCP server logins. Blocking, like
/// [`candidates`].
#[must_use]
pub fn view_plan(agent_dir: &Path, owner: &str) -> Vec<Planned> {
    let mut auth = AuthStorage::create(agent_dir);
    let settings = SettingsManager::create(agent_dir, agent_dir);
    let mut all = login_candidates(&auth, owner, false);
    all.extend(candidates(
        &mut auth,
        &settings,
        agent_dir,
        owner,
        Some(PRIME_INFERENCE_PROVIDER_ID),
        settings.get_bots_github(),
    ));
    all.extend(login_candidates(&auth, owner, true));
    plan(all, |name| settings.get_bots_inject(name), MAX_RULE_HOSTS)
}

/// The `/secrets` view's rows. A row shows a short fingerprint of the
/// value, never the value.
#[must_use]
pub fn view_rows(planned: &[Planned]) -> Value {
    let rows: Vec<Value> = planned
        .iter()
        .map(|entry| {
            let candidate = &entry.candidate;
            json!({
                "name": candidate.name,
                "kind": candidate.kind.as_str(),
                "inject": entry.status != SecretStatus::Off,
                "status": entry.status.as_str(),
                "hosts": candidate.rules.keys().collect::<Vec<_>>(),
                "fingerprint": candidate.secrets.first().map(|(_, value)| key_fingerprint(value)),
                "removable": candidate.kind == SecretKind::Custom,
            })
        })
        .collect();
    json!({
        "secrets": rows,
        "hosts": host_count(planned),
        "maxHosts": MAX_RULE_HOSTS,
    })
}

/// The platform secret name of a custom secret's `value`.
fn custom_secret_name(name: &str, value: &str) -> String {
    format!("{}{}", custom_secret_prefix(name), key_fingerprint(value))
}

/// The prefix of every platform secret a custom secret ever had.
#[must_use]
pub fn custom_secret_prefix(name: &str) -> String {
    let id: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("PRIME_AGENT_SECRET_{id}_")
}

/// The value the platform stores: Basic credentials are sent encoded.
fn platform_value(def: &BotSecretDef, value: &str) -> String {
    if def
        .scheme
        .as_deref()
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("basic"))
    {
        base64::engine::general_purpose::STANDARD.encode(value)
    } else {
        value.to_string()
    }
}

/// One custom secret's candidate.
fn custom_candidate(name: &str, def: &BotSecretDef, value: &str) -> Candidate {
    let value = platform_value(def, value);
    let secret = custom_secret_name(name, &value);
    let prefix = def
        .scheme
        .as_deref()
        .map(|scheme| format!("{scheme} "))
        .unwrap_or_default();
    Candidate {
        name: name.to_string(),
        kind: SecretKind::Custom,
        rules: BTreeMap::from([(
            def.host.clone(),
            HeaderRule {
                headers: BTreeMap::from([(
                    def.header.clone(),
                    format!("{prefix}${{prime.secrets.{secret}}}"),
                )]),
            },
        )]),
        secrets: vec![(secret, value)],
        stale: false,
    }
}

/// The custom secrets whose value the auth storage holds.
fn custom_candidates(auth: &AuthStorage, defs: &BTreeMap<String, BotSecretDef>) -> Vec<Candidate> {
    let stored = auth.get_all();
    defs.iter()
        .filter_map(
            |(name, def)| match stored.credential(&custom_auth_id(name)) {
                Some(AuthCredential::ApiKey { key, .. }) if !key.is_empty() => {
                    Some(custom_candidate(name, def, &key))
                }
                _ => None,
            },
        )
        .collect()
}

/// The auth storage entry of the custom secret `name`.
#[must_use]
pub fn custom_auth_id(name: &str) -> String {
    format!("{CUSTOM_AUTH_PREFIX}{name}")
}

/// Whether `secret` is a platform secret of the custom secret `name`.
fn is_custom_secret_of(secret: &str, name: &str) -> bool {
    secret
        .strip_prefix(&custom_secret_prefix(name))
        .is_some_and(|fingerprint| {
            fingerprint.len() == 12 && fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
        })
}

/// Store a custom secret: the value in the auth storage, the host and
/// header in `bots.secrets`. When the settings save fails, the auth
/// storage gets its old value back, so no value ever pairs with another
/// host. Blocking.
///
/// # Errors
/// Returns the reason the secret is refused, or a storage error.
pub fn add(agent_dir: &Path, new: &NewSecret) -> Result<()> {
    let def = validate(new, &view_plan(agent_dir, ""))?;
    let id = custom_auth_id(&new.name);
    let mut auth = AuthStorage::create(agent_dir);
    if let Some(error) = auth.load_error() {
        bail!("the auth storage could not be read: {error}");
    }
    let previous = auth.get_all().credential(&id);
    auth.set(
        &id,
        AuthCredential::ApiKey {
            key: new.value.clone(),
            prime_team: None,
        },
    );
    if let Some(error) = auth.drain_errors().into_iter().next() {
        bail!("the secret was not stored: {error}");
    }
    let saved =
        SettingsManager::create(agent_dir, agent_dir).set_bots_secret(&new.name, Some(&def));
    if saved.is_err() {
        match previous {
            Some(credential) => auth.set(&id, credential),
            None => auth.remove(&id),
        }
    }
    saved
}

/// Remove a custom secret: its platform secrets first, then the value and
/// the settings entry on this machine. A failed platform delete changes
/// nothing here, so the removal can run again. Bots lose the secret with
/// the next rules update; a deleted platform secret stops working within
/// a minute.
///
/// # Errors
/// Returns an error for a secret that is not custom, a failed platform
/// delete, or a storage error.
pub async fn remove(agent_dir: &Path, name: &str) -> Result<()> {
    let (dir, owned) = (agent_dir.to_path_buf(), name.to_string());
    let client = tokio::task::spawn_blocking(move || -> Result<_> {
        if !SettingsManager::create(&dir, &dir)
            .get_bots_secrets()
            .contains_key(&owned)
        {
            bail!("\"{owned}\" is not a custom secret; turn it off for bots instead");
        }
        // Without a Prime credential no platform secret was ever made.
        Ok(super::prime_client(&dir).ok().map(|(client, _)| client))
    })
    .await??;
    if let Some(client) = client {
        for secret in client.list_secrets().await? {
            if is_custom_secret_of(&secret.name, name) {
                client.delete_secret(&secret.id).await?;
            }
        }
    }
    let (dir, owned) = (agent_dir.to_path_buf(), name.to_string());
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut auth = AuthStorage::create(&dir);
        auth.remove(&custom_auth_id(&owned));
        if let Some(error) = auth.drain_errors().into_iter().next() {
            bail!("the secret was not removed: {error}");
        }
        SettingsManager::create(&dir, &dir).set_bots_secret(&owned, None)
    })
    .await?
}

/// A new custom secret, as the `/secrets` view sends it.
#[derive(Debug, Clone)]
pub struct NewSecret {
    pub name: String,
    pub host: String,
    pub header: String,
    pub scheme: Option<String>,
    pub value: String,
}

/// A rule host as the platform accepts it: an exact host name or a
/// one-label wildcard (`*.example.com`), lowercased. An `https://` prefix
/// is dropped; other schemes, ports, paths, and IP addresses are refused.
///
/// # Errors
/// Returns the reason the host is refused.
pub fn normalize_host(host: &str) -> Result<String> {
    let host = host.trim().to_ascii_lowercase();
    let host = match host.split_once("://") {
        Some(("https", rest)) => rest.trim_end_matches('/').to_string(),
        Some(_) => bail!("bots send secrets only over HTTPS; use an https host"),
        None => host,
    };
    if host.contains([':', '/', '?', '#', '@']) {
        bail!("give a host name only, with no port or path");
    }
    let name = host.strip_prefix("*.").unwrap_or(&host);
    let labels: Vec<&str> = name.split('.').collect();
    let label_ok = |label: &&str| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    if labels.len() < 2 || !labels.iter().all(label_ok) {
        bail!("\"{host}\" is not a host name (a wildcard covers one label: *.example.com)");
    }
    if labels
        .iter()
        .all(|label| label.bytes().all(|b| b.is_ascii_digit()))
    {
        bail!("the platform does not take IP addresses; give a host name");
    }
    Ok(host)
}

/// Check a new custom secret against the names, headers, and limits, and
/// return its settings entry.
///
/// # Errors
/// Returns the reason the secret is refused.
pub fn validate(new: &NewSecret, existing: &[Planned]) -> Result<BotSecretDef> {
    let name = &new.name;
    if name.is_empty()
        || name.len() > 64
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        bail!("a secret name is 1 to 64 letters, digits, or '_'");
    }
    // Platform secret names are upper case.
    if existing.iter().any(|entry| {
        entry.candidate.name.eq_ignore_ascii_case(name)
            && (entry.candidate.kind != SecretKind::Custom || entry.candidate.name != *name)
    }) {
        bail!("\"{name}\" is already a secret name; choose another");
    }
    let host = normalize_host(&new.host)?;
    let header = new.header.trim().to_string();
    if header.is_empty()
        || !header
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
    {
        bail!("\"{header}\" is not a header name");
    }
    let lower = header.to_ascii_lowercase();
    if RESERVED_HEADERS.contains(&lower.as_str()) || lower.starts_with("proxy-") {
        bail!("the platform does not set the {header} header");
    }
    if new.value.is_empty() || new.value.contains(['\r', '\n']) {
        bail!("the value is one line of text");
    }
    let def = BotSecretDef {
        host,
        header,
        scheme: new.scheme.clone().filter(|scheme| !scheme.is_empty()),
    };
    if platform_value(&def, &new.value).len() > MAX_SECRET_BYTES {
        bail!("the value is over the platform's 16 KiB limit");
    }
    // Plan the machine's secrets with this one in place of any old one.
    let mut candidates: Vec<Candidate> = existing
        .iter()
        .filter(|entry| entry.candidate.name != *name)
        .map(|entry| entry.candidate.clone())
        .collect();
    let off: BTreeSet<String> = existing
        .iter()
        .filter(|entry| entry.status == SecretStatus::Off)
        .map(|entry| entry.candidate.name.clone())
        .collect();
    candidates.push(custom_candidate(name, &def, &new.value));
    let planned = plan(
        candidates,
        |candidate| !off.contains(candidate),
        MAX_RULE_HOSTS,
    );
    // A secret that is off for bots needs no rule host.
    if !matches!(
        planned.last().map(|added| added.status),
        Some(SecretStatus::Ok | SecretStatus::Off)
    ) {
        if let Some(holder) = planned.iter().find(|entry| {
            entry.status.injected()
                && entry.candidate.name != *name
                && entry.candidate.rules.contains_key(&def.host)
        }) {
            bail!(
                "{} already gets headers from {}; the platform sets one rule per host",
                def.host,
                holder.candidate.name
            );
        }
        bail!(
            "bots already use {}/{MAX_RULE_HOSTS} rule hosts; remove a secret or turn one off first",
            host_count(&planned)
        );
    }
    Ok(def)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(name: &str, hosts: &[&str]) -> Candidate {
        let secret = format!("S_{}", name.to_ascii_uppercase());
        Candidate {
            name: name.to_string(),
            kind: SecretKind::ApiKey,
            rules: hosts
                .iter()
                .map(|host| {
                    (
                        (*host).to_string(),
                        HeaderRule {
                            headers: BTreeMap::from([(
                                "Authorization".to_string(),
                                format!("Bearer ${{prime.secrets.{secret}}}"),
                            )]),
                        },
                    )
                })
                .collect(),
            secrets: vec![(secret, "v".to_string())],
            stale: false,
        }
    }

    fn statuses(planned: &[Planned]) -> Vec<(&str, &str)> {
        planned
            .iter()
            .map(|entry| (entry.candidate.name.as_str(), entry.status.as_str()))
            .collect()
    }

    /// The plan applies the toggle, the value limit, held hosts, and the
    /// 32-host limit in order.
    #[test]
    fn the_plan_applies_the_toggle_and_the_platform_limits() {
        let many: Vec<String> = (0..31).map(|i| format!("h{i}.example.com")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        let mut big = candidate("big", &["big.example.com"]);
        big.secrets[0].1 = "x".repeat(MAX_SECRET_BYTES + 1);
        let mut stale = candidate("stale", &["stale.example.com"]);
        stale.stale = true;
        let planned = plan(
            vec![
                candidate("first", &many),
                candidate("off", &["off.example.com"]),
                big,
                candidate("held", &["h0.example.com"]),
                stale,
                candidate("late", &["late.example.com"]),
            ],
            |name| name != "off",
            MAX_RULE_HOSTS,
        );
        assert_eq!(
            statuses(&planned),
            [
                ("first", "ok"),
                ("off", "off"),
                ("big", "too large"),
                ("held", "over-cap"),
                ("stale", "stale"),
                ("late", "over-cap"),
            ]
        );
        assert_eq!(host_count(&planned), MAX_RULE_HOSTS);
    }

    #[test]
    fn a_custom_secret_owns_only_its_own_platform_secrets() {
        let own = custom_secret_name("ci", "v");
        assert!(is_custom_secret_of(&own, "ci"));
        assert!(!is_custom_secret_of(&custom_secret_name("ci_b", "v"), "ci"));
        assert!(!is_custom_secret_of("PRIME_AGENT_SECRET_CI_KEY", "ci"));
    }

    #[test]
    fn hosts_must_be_https_names_or_one_label_wildcards() {
        assert_eq!(
            normalize_host("https://API.Example.com/").unwrap(),
            "api.example.com"
        );
        assert_eq!(normalize_host("*.example.com").unwrap(), "*.example.com");
        for refused in [
            "http://api.example.com",
            "api.example.com:8443",
            "api.example.com/v1",
            "*.*.example.com",
            "a.*.example.com",
            "localhost",
            "10.0.0.1",
        ] {
            assert!(normalize_host(refused).is_err(), "{refused}");
        }
    }

    /// A custom secret becomes one rule with its scheme; Basic values are
    /// encoded, and the save refuses a held host and the 33rd host.
    #[test]
    fn a_custom_secret_is_validated_against_the_plan() {
        let new = |name: &str, host: &str, scheme: Option<&str>| NewSecret {
            name: name.to_string(),
            host: host.to_string(),
            header: "Authorization".to_string(),
            scheme: scheme.map(str::to_string),
            value: "user:pass".to_string(),
        };
        let existing = plan(
            vec![candidate("anthropic", &["api.anthropic.com"])],
            |_| true,
            MAX_RULE_HOSTS,
        );
        let def = validate(
            &new("ci", "https://ci.example.com", Some("Basic")),
            &existing,
        )
        .unwrap();
        let added = custom_candidate("ci", &def, "user:pass");
        assert_eq!(added.secrets[0].1, "dXNlcjpwYXNz");
        assert!(added.secrets[0].0.starts_with("PRIME_AGENT_SECRET_CI_"));
        assert_eq!(
            added.rules["ci.example.com"].headers["Authorization"],
            format!("Basic ${{prime.secrets.{}}}", added.secrets[0].0)
        );

        assert!(validate(&new("anthropic", "x.example.com", None), &existing).is_err());
        assert!(validate(&new("dup", "api.anthropic.com", None), &existing).is_err());

        let hosts: Vec<String> = (0..MAX_RULE_HOSTS)
            .map(|i| format!("h{i}.example.com"))
            .collect();
        let hosts: Vec<&str> = hosts.iter().map(String::as_str).collect();
        let full = plan(vec![candidate("wide", &hosts)], |_| true, MAX_RULE_HOSTS);
        assert!(validate(&new("more", "more.example.com", None), &full).is_err());
        let off = plan(vec![candidate("wide", &hosts)], |_| false, MAX_RULE_HOSTS);
        assert!(validate(&new("more", "more.example.com", None), &off).is_ok());
        // A secret that is off needs no host: its replacement saves on a full plan.
        let mut ci = candidate("ci", &["ci.example.com"]);
        ci.kind = SecretKind::Custom;
        let full_and_off = plan(
            vec![candidate("wide", &hosts), ci],
            |name| name != "ci",
            MAX_RULE_HOSTS,
        );
        assert!(validate(&new("ci", "ci2.example.com", None), &full_and_off).is_ok());
    }
}
