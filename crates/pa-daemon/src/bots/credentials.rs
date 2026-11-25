//! The guest's provider credentials. A bot sandbox never holds a real
//! key: each provider the home auth storage holds an API key for is stored
//! once as a platform secret (`PRIME_AGENT_<PROVIDER>_KEY_<FINGERPRINT>`; a
//! rotated key gets a new secret), and the
//! sandbox's network policy has the platform set it in that provider's
//! auth header on the sandbox's HTTPS requests, outside the sandbox. The
//! guest sends [`GUEST_API_KEY_PLACEHOLDER`], which the platform replaces.
//!
//! Subscription logins are injected by [`super::logins`]. The plan in
//! [`super::secrets`] decides which keys reach a bot.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::LazyLock;

use hmac::{Hmac, KeyInit, Mac};
use pa_core::auth::{
    AuthCredential, AuthStorage, AuthStorageData, PrimeTeamCredential, StoredPrimeTeam,
    PRIME_INFERENCE_PROVIDER_ID,
};
use pa_core::models::PRIME_INFERENCE_DEFAULT_MODEL_ID;
use pa_sandbox::transport::SandboxTransport;
use pa_sandbox::{HeaderRule, PrimeSandboxClient};
use sha2::Sha256;

use super::secrets::{Candidate, Planned, SecretKind, SecretStatus};

/// The API key the guest holds. The platform replaces the auth header it
/// rides in with the real key, outside the sandbox.
pub const GUEST_API_KEY_PLACEHOLDER: &str = "injected-by-platform";

/// The host the sandbox API lives on: the host a nested bot's header rule
/// targets. The key value the rule injects never enters the sandbox.
#[must_use]
pub fn sandbox_api_host() -> String {
    base_url_host(pa_sandbox::DEFAULT_BASE_URL).unwrap_or_else(|| "api.primeintellect.ai".into())
}

/// The platform secret that holds the owner's sandbox API key for a bot
/// that spawns bots. Fingerprinted, so a rotated key gets a new secret.
#[must_use]
pub fn bots_secret_name(key: &str) -> String {
    format!("PRIME_AGENT_BOTS_KEY_{}", key_fingerprint(key))
}

/// The sandbox API rule added to a bot's current rules: every rule the
/// policy already has is kept, and the sandbox API host's entry becomes
/// the injected key (a bot that already had a rule there is upgraded, not
/// widened).
#[must_use]
pub fn with_bots_rule(
    mut rules: BTreeMap<String, HeaderRule>,
    key: &str,
) -> BTreeMap<String, HeaderRule> {
    let (host, rule) = bots_rule(key);
    rules.insert(host, rule);
    rules
}

/// The header rule that puts the owner's sandbox API key on the sandbox
/// API host's requests from inside a bot that spawns bots.
#[must_use]
pub fn bots_rule(key: &str) -> (String, HeaderRule) {
    (
        sandbox_api_host(),
        HeaderRule {
            headers: BTreeMap::from([(
                "Authorization".to_string(),
                format!("Bearer ${{prime.secrets.{}}}", bots_secret_name(key)),
            )]),
        },
    )
}

/// The platform root certificate inside the sandbox. The platform
/// terminates TLS for the rule hosts to set their headers, so the guest's
/// clients must trust it.
pub const PLATFORM_CA_PATH: &str = "/mnt/sandboxd/platform-ca.pem";

/// A secret's scope: the platform origin, the team, and the secret name.
type SecretScope = (String, Option<String>, String);

/// The secrets confirmed on the platform in this process: provisioning
/// runs once per process and scope. The lock is held across a whole
/// provisioning, so concurrent spawns never list and create the same
/// secret twice.
static CONFIRMED: LazyLock<tokio::sync::Mutex<BTreeSet<SecretScope>>> =
    LazyLock::new(Default::default);

/// The platform secret that holds `provider`'s key.
fn secret_name(provider: &str) -> String {
    let id: String = provider
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("PRIME_AGENT_{id}_KEY")
}

/// A short id of `key` for its secret name: a rotated key gets a new
/// secret. The key is the MAC key over a fixed label, never hashed data.
pub(super) fn key_fingerprint(key: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC takes any key length");
    mac.update(b"prime-agent bot credential");
    mac.finalize().into_bytes()[..6]
        .iter()
        .fold(String::new(), |mut hex, byte| {
            use std::fmt::Write;
            write!(hex, "{byte:02X}").expect("write to String");
            hex
        })
}

/// Make the platform secret `name` hold `value`: update it when it
/// exists, else create it. A refused create lists again, because another
/// process may have created it meanwhile.
///
/// # Errors
/// Returns an error when the list, the create, or the update fails.
pub async fn ensure_secret<T: SandboxTransport>(
    client: &PrimeSandboxClient<T>,
    name: &str,
    value: &str,
    description: &str,
) -> anyhow::Result<()> {
    let find = |secrets: Vec<pa_sandbox::PlatformSecret>| {
        secrets
            .into_iter()
            .find(|secret| secret.name == name)
            .map(|secret| secret.id)
    };
    let id = match find(client.list_secrets().await?) {
        Some(id) => id,
        None => match client.create_secret(name, value, Some(description)).await {
            Ok(_) => return Ok(()),
            Err(error) => find(client.list_secrets().await?).ok_or(error)?,
        },
    };
    client.update_secret(&id, value).await?;
    Ok(())
}

/// The auth header pa-ai's request builder sets for `provider` over
/// `api`, as its name and value prefix. `None` where requests
/// authenticate otherwise: signed requests (Bedrock), ambient or OAuth
/// tokens (Vertex, Codex, Copilot), and the Cloudflare gateway's own
/// header.
fn auth_header(provider: &str, api: &str) -> Option<(&'static str, &'static str)> {
    match (provider, api) {
        ("cloudflare-ai-gateway" | "github-copilot", _) => None,
        (_, "openai-completions" | "openai-responses" | "mistral-conversations") => {
            Some(("Authorization", "Bearer "))
        }
        (_, "anthropic-messages") => Some(("x-api-key", "")),
        (_, "google-generative-ai") => Some(("x-goog-api-key", "")),
        _ => None,
    }
}

/// The host of a base URL, as a header rule's key: the exact DNS name,
/// lowercased.
pub(super) fn base_url_host(base_url: &str) -> Option<String> {
    let (_, rest) = base_url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// The API hosts `provider`'s rules would cover: the hosts a child needs
/// to see in its inherited rules to run on `provider`.
#[must_use]
pub fn provider_rule_hosts(provider: &str) -> Vec<String> {
    provider_rules(provider, "").keys().cloned().collect()
}

/// The rules that set `secret` in `provider`'s auth header on each API
/// host its catalog models use.
fn provider_rules(provider: &str, secret: &str) -> BTreeMap<String, HeaderRule> {
    let mut rules: BTreeMap<String, HeaderRule> = BTreeMap::new();
    for model in pa_ai::models_generated::get_models(provider) {
        let (Some((header, prefix)), Some(host)) = (
            auth_header(provider, &model.api),
            base_url_host(&model.base_url),
        ) else {
            continue;
        };
        rules
            .entry(host)
            .or_insert_with(|| HeaderRule {
                headers: BTreeMap::new(),
            })
            .headers
            .insert(
                header.to_string(),
                format!("{prefix}${{prime.secrets.{secret}}}"),
            );
    }
    rules
}

/// The stored API keys (or the environment key of `required`) as plan
/// candidates: `required` first, then prime-inference. OAuth logins and
/// keys with no injectable API host are left out.
pub(super) fn api_key_candidates(auth: &mut AuthStorage, required: Option<&str>) -> Vec<Candidate> {
    let stored = auth.get_all();
    let mut providers = auth.list();
    providers.retain(|provider| {
        provider != super::github::GITHUB_AUTH_ID
            && !provider.starts_with(super::secrets::CUSTOM_AUTH_PREFIX)
    });
    if let Some(required) = required {
        if !providers.iter().any(|provider| provider == required) {
            providers.push(required.to_string());
        }
    }
    providers.sort_by_key(|provider| {
        (
            Some(provider.as_str()) != required,
            provider != PRIME_INFERENCE_PROVIDER_ID,
            provider.clone(),
        )
    });
    let mut candidates = Vec::new();
    for provider in providers {
        let Some(key) = injectable_key(auth, &stored, &provider) else {
            continue;
        };
        let secret = format!("{}_{}", secret_name(&provider), key_fingerprint(&key));
        let rules = provider_rules(&provider, &secret);
        if rules.is_empty() {
            continue;
        }
        candidates.push(Candidate {
            name: provider,
            kind: SecretKind::ApiKey,
            secrets: vec![(secret, key)],
            rules,
            stale: false,
        });
    }
    candidates
}

/// `provider`'s API key, unless its login is OAuth (a subscription or MCP
/// login), which is never injected.
fn injectable_key(
    auth: &mut AuthStorage,
    stored: &AuthStorageData,
    provider: &str,
) -> Option<String> {
    if !matches!(
        stored.credential(provider),
        Some(AuthCredential::ApiKey { .. }) | None
    ) {
        return None;
    }
    auth.get_api_key(provider).filter(|key| !key.is_empty())
}

/// Whether a bot inheriting a `provider` model should run on the Prime
/// Inference default model instead: `provider` holds only an OAuth login
/// that bots do not get (`login_injected` is false), and a Prime Inference
/// key can be injected.
pub fn use_prime_inference_instead(
    auth: &mut AuthStorage,
    provider: &str,
    login_injected: bool,
) -> bool {
    let stored = auth.get_all();
    !login_injected
        && provider != PRIME_INFERENCE_PROVIDER_ID
        && matches!(
            stored.credential(provider),
            Some(AuthCredential::Oauth { .. })
        )
        && injectable_key(auth, &stored, PRIME_INFERENCE_PROVIDER_ID).is_some()
}

/// What [`provision`] confirmed: the rules for the confirmed secrets, the
/// API-key providers among them, the candidates whose secrets could not
/// be confirmed, and the ones the user turned off.
#[derive(Debug, Default)]
pub struct Provisioned {
    rules: BTreeMap<String, HeaderRule>,
    providers: Vec<String>,
    failed: Vec<(String, anyhow::Error)>,
    off: Vec<String>,
    /// The team the injected Prime Inference key bills to.
    prime_team: Option<PrimeTeamCredential>,
}

impl Provisioned {
    /// The guest's `auth.json` for the confirmed providers.
    #[must_use]
    pub fn guest_auth(&self) -> Option<serde_json::Value> {
        guest_auth_json(&self.providers, self.prime_team.as_ref())
    }

    /// The network rules for a guest whose provider is not an API key
    /// here (a subscription login). Failed keys are logged.
    #[must_use]
    pub fn rules(self) -> BTreeMap<String, HeaderRule> {
        for (failed, error) in self.failed {
            eprintln!("bot credentials: the {failed} key is not injected: {error:#}");
        }
        self.rules
    }

    /// The network rules for a guest running `provider`. Fails when that
    /// provider's secret could not be confirmed (the guest could not
    /// authenticate a turn). Other failures are logged and only drop
    /// their own rules.
    ///
    /// # Errors
    ///
    /// Returns the provisioning error of `provider`'s secret.
    pub fn rules_for(self, provider: &str) -> anyhow::Result<BTreeMap<String, HeaderRule>> {
        let mut required = None;
        for (failed, error) in self.failed {
            if failed == provider {
                required = Some(error);
            } else {
                eprintln!("bot credentials: {failed} is not injected: {error:#}");
            }
        }
        match required {
            Some(error) => Err(error.context(format!(
                "the platform secret for the {provider} key could not be provisioned"
            ))),
            None if provider_rules(provider, "").is_empty() => Err(anyhow::anyhow!(
                "A bot cannot run on {provider}: its requests do not carry an API key \
                 the platform can inject. {}",
                pass_another_model()
            )),
            None if self.off.iter().any(|off| off == provider) => Err(anyhow::anyhow!(
                "A bot on {provider} needs the {provider} key, and /secrets has it off for \
                 bots. Turn it on in /secrets or choose another provider."
            )),
            None if !self.providers.iter().any(|confirmed| confirmed == provider) => {
                Err(anyhow::anyhow!(
                    "A bot on {provider} needs the owner's {provider} API key or login on the Mac, \
                     with bots.inject.{provider} on. {}",
                    pass_another_model()
                ))
            }
            None => Ok(self.rules),
        }
    }
}

/// How to pick a model a bot can run on.
fn pass_another_model() -> String {
    format!(
        "Pass a model whose provider has an API key, for example \
         rlm.spawn(..., target=\"sandbox\", model=\"{PRIME_INFERENCE_PROVIDER_ID}/{PRIME_INFERENCE_DEFAULT_MODEL_ID}\")."
    )
}

/// Make sure the platform holds the secrets of every candidate the plan
/// gives a bot (with GitHub when `github`; `provider` is its provider when
/// it uses an API key), and
/// collect their rules. `owner` names the GitHub secrets. The secrets live
/// in the client's team, the scope its sandboxes bill to, which a header
/// rule's secret must share. `reserved_hosts` rule hosts are left for the
/// bot's logins.
pub async fn provision<T: SandboxTransport>(
    client: &PrimeSandboxClient<T>,
    agent_dir: &Path,
    owner: &str,
    provider: Option<&str>,
    github: bool,
    reserved_hosts: usize,
) -> Provisioned {
    // Reading the auth storage may run a `!command` key or the gh CLI:
    // keep it off the runtime.
    let (agent_dir, owner, required) = (
        agent_dir.to_path_buf(),
        owner.to_string(),
        provider.map(str::to_string),
    );
    // The GitHub candidate is planned and written under the agent dir's
    // github lock, and `bots github clear` takes the same lock around its
    // token removal and deletes: a provisioning that planned before a
    // clear can no longer recreate the cleared secrets after it. Without
    // the lock (a live holder), this bot runs without GitHub.
    let (github_wanted, plan_dir) = (github, agent_dir.clone());
    let ((planned, prime_team), github_lock) = match tokio::task::spawn_blocking(move || {
        let github_lock = match github_wanted.then(|| super::github::lock(&plan_dir)) {
            Some(Ok(lock)) => Some(lock),
            Some(Err(error)) => {
                eprintln!("bot credentials: GitHub is left out of this bot: {error:#}");
                None
            }
            None => None,
        };
        let planned = super::secrets::plan_for(
            &plan_dir,
            &owner,
            required.as_deref(),
            github_wanted && github_lock.is_some(),
            reserved_hosts,
        );
        let prime_team = effective_prime_team(&AuthStorage::create(&plan_dir));
        ((planned, prime_team), github_lock)
    })
    .await
    {
        Ok(read) => read,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    };
    if github
        && github_lock.is_some()
        && !planned
            .iter()
            .any(|entry| entry.candidate.kind == SecretKind::GitHub)
    {
        eprintln!(
            "bot credentials: no GitHub token on this machine; the bot runs without GitHub \
             access (run `{}`)",
            super::github::SET_TOKEN_COMMAND
        );
    }
    // The token the plan would write, for the post-write recheck, and the
    // hosts its rules would send it on.
    let planned_github = planned
        .iter()
        .find(|entry| entry.candidate.kind == SecretKind::GitHub && entry.status.injected());
    let planned_github_token = planned_github.map(|entry| entry.candidate.secrets[0].1.clone());
    let planned_github_hosts: Vec<String> = planned_github
        .map(|entry| entry.candidate.rules.keys().cloned().collect())
        .unwrap_or_default();
    let mut provisioned = provision_planned(client, planned).await;
    provisioned.prime_team = prime_team;
    if let (Some(lock), Some(planned_token)) = (github_lock, planned_github_token) {
        let recheck =
            super::github::recheck_provisioned_token(client, &agent_dir, &planned_token).await;
        // A stale-reclaimed lock means a clear may have run while this
        // provisioning wrote: a wedged holder must not outlive its lock
        // silently. Treat the takeover like a failed recheck.
        let stolen = !lock.owns();
        drop(lock);
        let failure = recheck.err().or_else(|| {
            stolen
                .then(|| anyhow::anyhow!("the bots github lock was taken over while provisioning"))
        });
        if let Some(error) = failure {
            // The secrets may still hold a token the machine no longer
            // resolves, and the cleanup could not prove otherwise: this bot
            // runs without the rules that would send it, never with a token
            // the machine no longer resolves.
            eprintln!("bot credentials: GitHub is left out of this bot: {error:#}");
            provisioned
                .rules
                .retain(|host, _| !planned_github_hosts.contains(host));
        }
    }
    provisioned
}

/// The team the Prime Inference key bills to, as the auth storage resolves
/// its `X-Prime-Team-ID` header.
fn effective_prime_team(auth: &AuthStorage) -> Option<PrimeTeamCredential> {
    let team_id = auth
        .get_provider_headers(PRIME_INFERENCE_PROVIDER_ID)?
        .remove("X-Prime-Team-ID")?;
    match auth.get_prime_inference_team_selection() {
        StoredPrimeTeam::Team(team) if team.team_id == team_id => Some(team),
        _ => Some(PrimeTeamCredential {
            name: team_id.clone(),
            team_id,
            slug: None,
            role: None,
            created_at: None,
        }),
    }
}

async fn provision_planned<T: SandboxTransport>(
    client: &PrimeSandboxClient<T>,
    planned: Vec<Planned>,
) -> Provisioned {
    let mut confirmed = CONFIRMED.lock().await;
    let mut provisioned = Provisioned::default();
    let mut listed = None;
    for Planned { candidate, status } in planned {
        if status == SecretStatus::Off {
            provisioned.off.push(candidate.name);
            continue;
        }
        if !status.injected() {
            eprintln!(
                "bot credentials: {} is not injected: {}",
                candidate.name,
                status.as_str()
            );
            continue;
        }
        let mut outcome = Ok(());
        for (secret, value) in &candidate.secrets {
            let scoped = (
                client.base_url().to_string(),
                client.team_id().map(str::to_string),
                secret.clone(),
            );
            let description = format!("Prime Agent bot {} credential", candidate.name);
            let result = if candidate.kind.stable_names() {
                // Stable names: the value may have changed since the last check.
                listed = None;
                ensure_secret(client, secret, value, &description).await
            } else if confirmed.contains(&scoped) && candidate.kind != SecretKind::Custom {
                // `/secrets` can delete a custom secret, so it is listed every time.
                Ok(())
            } else {
                confirm_secret(client, secret, value, &description, &mut listed).await
            };
            match result {
                Ok(()) => {
                    confirmed.insert(scoped);
                }
                Err(error) => {
                    outcome = Err(error);
                    break;
                }
            }
        }
        match outcome {
            Ok(()) => {
                provisioned.rules.extend(candidate.rules);
                if candidate.kind == SecretKind::ApiKey {
                    provisioned.providers.push(candidate.name);
                }
            }
            Err(error) => provisioned.failed.push((candidate.name, error)),
        }
    }
    provisioned
}

/// Confirm one fingerprinted secret on the platform: listed (one list
/// serves every candidate), else created. A refused create lists again:
/// another process may have created it meanwhile.
async fn confirm_secret<T: SandboxTransport>(
    client: &PrimeSandboxClient<T>,
    secret: &str,
    value: &str,
    description: &str,
    listed: &mut Option<BTreeSet<String>>,
) -> anyhow::Result<()> {
    let mut names = match listed.take() {
        Some(names) => names,
        None => secret_names(client).await?,
    };
    if !names.contains(secret) {
        if let Err(error) = client.create_secret(secret, value, Some(description)).await {
            names = secret_names(client).await?;
            if !names.contains(secret) {
                return Err(error.into());
            }
        }
        names.insert(secret.to_string());
    }
    *listed = Some(names);
    Ok(())
}

async fn secret_names<T: SandboxTransport>(
    client: &PrimeSandboxClient<T>,
) -> anyhow::Result<BTreeSet<String>> {
    Ok(client
        .list_secrets()
        .await?
        .into_iter()
        .map(|secret| secret.name)
        .collect())
}

/// Put the Prime Inference placeholder record (with `prime_team`) into a
/// guest auth document, keeping every other record: a bot that spawns bots
/// needs a Prime record so its daemon builds a sandbox client whose
/// Authorization the platform replaces. `None` becomes the prime-inference
/// document.
///
/// # Panics
///
/// Panics when the record cannot serialize; it is a plain data struct, so
/// it always can.
#[must_use]
pub fn ensure_prime_inference(
    auth_json: Option<serde_json::Value>,
    prime_team: Option<&PrimeTeamCredential>,
) -> serde_json::Value {
    let record = AuthCredential::ApiKey {
        key: GUEST_API_KEY_PLACEHOLDER.to_string(),
        prime_team: prime_team.cloned(),
    };
    let record = serde_json::to_value(record).expect("an auth record serializes");
    let mut auth = match auth_json {
        Some(serde_json::Value::Object(auth)) => auth,
        _ => serde_json::Map::new(),
    };
    auth.insert(PRIME_INFERENCE_PROVIDER_ID.to_string(), record);
    serde_json::Value::Object(auth)
}

/// The team the guest's Prime Inference record bills to, as the auth
/// storage resolves it.
#[must_use]
pub fn effective_prime_team_of(auth: &mut AuthStorage) -> Option<PrimeTeamCredential> {
    effective_prime_team(auth)
}

/// The guest's auth storage: one API-key record per injected provider,
/// holding the placeholder. The Prime Inference record carries its billing
/// team. `None` when no provider is injected.
fn guest_auth_json(
    providers: &[String],
    prime_team: Option<&PrimeTeamCredential>,
) -> Option<serde_json::Value> {
    let auth: serde_json::Map<String, serde_json::Value> = providers
        .iter()
        .map(|provider| {
            let record = AuthCredential::ApiKey {
                key: GUEST_API_KEY_PLACEHOLDER.to_string(),
                prime_team: (provider == PRIME_INFERENCE_PROVIDER_ID)
                    .then(|| prime_team.cloned())
                    .flatten(),
            };
            let record = serde_json::to_value(record).expect("an auth record serializes");
            (provider.clone(), record)
        })
        .collect();
    (!auth.is_empty()).then_some(serde_json::Value::Object(auth))
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::future::Future;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use pa_core::auth::NoOAuth;
    use pa_sandbox::transport::{
        ResponseChunks, StreamedResponse, TransportRequest, TransportResponse,
    };
    use pa_sandbox::{ClientOptions, SandboxError};
    use serde_json::json;

    use super::*;

    fn auth(document: &serde_json::Value) -> AuthStorage {
        let serde_json::Value::Object(map) = document.clone() else {
            panic!("an auth document is an object");
        };
        AuthStorage::in_memory_without_env(&AuthStorageData(map), Arc::new(NoOAuth))
    }

    /// The live auth.json's shape: API keys, subscription logins (OAuth),
    /// and an MCP login.
    fn home_auth() -> serde_json::Value {
        json!({
            "prime-inference": {
                "type": "api_key",
                "key": "sk-prime",
                "primeTeam": { "teamId": "team-1", "name": "Team One" },
            },
            "google": { "type": "api_key", "key": "sk-google" },
            "serper": { "type": "api_key", "key": "sk-serper" },
            "prime-agent-bots-github": { "type": "api_key", "key": "ghp-bots" },
            "anthropic": { "type": "oauth", "access": "a", "refresh": "r", "expires": 1 },
            "openai-codex": {
                "type": "oauth", "access": "a", "refresh": "r", "expires": 1, "accountId": "acct",
            },
            "mcp:linear": { "type": "oauth", "access": "a", "refresh": "r", "expires": 1 },
        })
    }

    fn header_rule(host: &str, header: &str, value: &str) -> BTreeMap<String, HeaderRule> {
        BTreeMap::from([(
            host.to_string(),
            HeaderRule {
                headers: BTreeMap::from([(header.to_string(), value.to_string())]),
            },
        )])
    }

    #[test]
    fn the_bots_rule_keeps_the_current_rules() {
        let current = header_rule("api.example.com", "Authorization", "Bearer keep");
        let merged = with_bots_rule(current.clone(), "sk-prime");
        assert_eq!(
            merged["api.example.com"], current["api.example.com"],
            "the current rule is kept"
        );
        let api = &merged[&sandbox_api_host()];
        assert_eq!(
            api.headers["Authorization"],
            format!("Bearer ${{prime.secrets.{}}}", bots_secret_name("sk-prime")),
            "the sandbox API rule is added"
        );
    }

    #[test]
    fn each_provider_secret_and_rule_follow_its_api() {
        for (provider, secret, host, header, value) in [
            (
                "prime-inference",
                "PRIME_AGENT_PRIME_INFERENCE_KEY",
                "api.pinference.ai",
                "Authorization",
                "Bearer ${prime.secrets.PRIME_AGENT_PRIME_INFERENCE_KEY}",
            ),
            (
                "anthropic",
                "PRIME_AGENT_ANTHROPIC_KEY",
                "api.anthropic.com",
                "x-api-key",
                "${prime.secrets.PRIME_AGENT_ANTHROPIC_KEY}",
            ),
            (
                "openai",
                "PRIME_AGENT_OPENAI_KEY",
                "api.openai.com",
                "Authorization",
                "Bearer ${prime.secrets.PRIME_AGENT_OPENAI_KEY}",
            ),
            (
                "zai",
                "PRIME_AGENT_ZAI_KEY",
                "api.z.ai",
                "Authorization",
                "Bearer ${prime.secrets.PRIME_AGENT_ZAI_KEY}",
            ),
            (
                "google",
                "PRIME_AGENT_GOOGLE_KEY",
                "generativelanguage.googleapis.com",
                "x-goog-api-key",
                "${prime.secrets.PRIME_AGENT_GOOGLE_KEY}",
            ),
        ] {
            assert_eq!(secret_name(provider), secret);
            assert_eq!(
                provider_rules(provider, secret),
                header_rule(host, header, value),
                "{provider}"
            );
        }
    }

    /// The live set: API keys with a catalog host are injected
    /// (prime-inference first); OAuth logins and a key with no catalog
    /// host (serper) are not.
    #[test]
    fn only_stored_api_keys_with_an_api_host_are_injected() {
        let injected =
            api_key_candidates(&mut auth(&home_auth()), Some(PRIME_INFERENCE_PROVIDER_ID));
        let summary: Vec<(&str, &str)> = injected
            .iter()
            .map(|candidate| (candidate.name.as_str(), candidate.secrets[0].1.as_str()))
            .collect();
        assert_eq!(
            summary,
            [("prime-inference", "sk-prime"), ("google", "sk-google")]
        );
        // A rotated key gets a new secret.
        assert!(injected[1].secrets[0]
            .0
            .starts_with("PRIME_AGENT_GOOGLE_KEY_"));
        let rotated = api_key_candidates(
            &mut auth(&json!({ "google": { "type": "api_key", "key": "sk-google-2" } })),
            Some("google"),
        );
        assert_ne!(rotated[0].secrets[0].0, injected[1].secrets[0].0);

        let keyed = api_key_candidates(
            &mut auth(&json!({
                "zai": { "type": "api_key", "key": "sk-zai" },
                "openai": { "type": "api_key", "key": "sk-openai" },
                "anthropic": { "type": "api_key", "key": "sk-ant-api" },
                "prime-inference": { "type": "api_key", "key": "" },
            })),
            Some(PRIME_INFERENCE_PROVIDER_ID),
        );
        let providers: Vec<&str> = keyed
            .iter()
            .map(|candidate| candidate.name.as_str())
            .collect();
        assert_eq!(providers, ["anthropic", "openai", "zai"]);

        // `bots.inject` off keeps a key home, even for the bot's own provider.
        let off = super::super::secrets::plan(
            api_key_candidates(&mut auth(&home_auth()), Some("google")),
            |provider| provider != "google",
            super::super::secrets::MAX_RULE_HOSTS,
        );
        assert!(off
            .iter()
            .filter(|entry| entry.candidate.name == "google")
            .all(|entry| entry.status == SecretStatus::Off));
    }

    /// A login that bots do not get falls back to Prime Inference when its
    /// key can be injected; an injected login and an API-key provider keep
    /// their model.
    #[test]
    fn a_login_bots_do_not_get_falls_back_to_prime_inference() {
        let mut home = auth(&home_auth());
        assert!(use_prime_inference_instead(&mut home, "anthropic", false));
        assert!(!use_prime_inference_instead(&mut home, "anthropic", true));
        assert!(!use_prime_inference_instead(&mut home, "google", false));
        assert!(!use_prime_inference_instead(
            &mut home,
            PRIME_INFERENCE_PROVIDER_ID,
            false
        ));
        let mut no_prime = auth(&json!({
            "anthropic": { "type": "oauth", "access": "a", "refresh": "r", "expires": 1 },
        }));
        assert!(!use_prime_inference_instead(
            &mut no_prime,
            "anthropic",
            false
        ));
    }

    #[test]
    fn the_guest_auth_holds_placeholders_and_the_team_only() {
        let team = PrimeTeamCredential {
            team_id: "team-1".into(),
            name: "Team One".into(),
            slug: None,
            role: None,
            created_at: None,
        };
        let providers = ["prime-inference".to_string(), "google".to_string()];
        let guest = guest_auth_json(&providers, Some(&team)).unwrap();
        assert_eq!(guest["prime-inference"]["type"], "api_key");
        assert_eq!(guest["prime-inference"]["key"], GUEST_API_KEY_PLACEHOLDER);
        assert_eq!(guest["prime-inference"]["primeTeam"]["teamId"], "team-1");
        assert_eq!(
            guest["google"],
            json!({ "type": "api_key", "key": GUEST_API_KEY_PLACEHOLDER })
        );
        assert!(guest_auth_json(&[], Some(&team)).is_none());
    }

    /// Answers from a queue (the last answer repeats), records requests,
    /// can fail the next DELETE, and clears the stored GitHub token after
    /// N creates: a token changing mid-provision, as a concurrent clear
    /// does.
    #[derive(Default)]
    struct Platform {
        answers: Mutex<VecDeque<serde_json::Value>>,
        requests: Mutex<Vec<TransportRequest>>,
        fail_next_delete: AtomicBool,
        clear_token_after_creates: AtomicUsize,
        agent_dir: Mutex<Option<std::path::PathBuf>>,
        creates: AtomicUsize,
    }

    impl SandboxTransport for &Platform {
        fn execute(
            &self,
            request: TransportRequest,
        ) -> impl Future<Output = Result<TransportResponse, SandboxError>> + Send {
            if request.method.as_str() == "POST"
                && self.clear_token_after_creates.load(Ordering::SeqCst)
                    == self.creates.fetch_add(1, Ordering::SeqCst) + 1
            {
                if let Some(dir) = self.agent_dir.lock().unwrap().clone() {
                    let _ = super::super::github::clear_token(&dir);
                }
            }
            self.requests.lock().unwrap().push(request.clone());
            let mut answers = self.answers.lock().unwrap();
            let body = if answers.len() > 1 {
                answers.pop_front()
            } else {
                answers.front().cloned()
            };
            let refused = request.method.as_str() == "DELETE"
                && self.fail_next_delete.swap(false, Ordering::SeqCst);
            std::future::ready(Ok(TransportResponse {
                status: if refused { 500 } else { 200 },
                body: body.unwrap_or_default().to_string().into_bytes(),
            }))
        }

        fn execute_streaming(
            &self,
            _request: TransportRequest,
        ) -> impl Future<Output = Result<StreamedResponse, SandboxError>> + Send {
            std::future::ready(Ok(StreamedResponse {
                status: 500,
                headers: Vec::new(),
                body: ResponseChunks::Queued(VecDeque::new()),
            }))
        }
    }

    /// The provisioning wiring behind the recheck: when the token changes
    /// mid-provision and the stale-secret removal fails, the bot's rules
    /// lose the GitHub hosts (reverting the retain keeps this red).
    #[tokio::test]
    async fn a_failed_stale_removal_drops_the_github_rules() {
        let dir = tempfile::tempdir().unwrap();
        super::super::github::store_token(dir.path(), "ghp_first").unwrap();
        let platform = Platform::default();
        // ensure_secret lists and creates both secrets; the recheck then
        // lists them and refuses the first delete.
        platform.answers.lock().unwrap().extend([
            json!({ "data": [] }),
            json!({}),
            json!({ "data": [] }),
            json!({}),
            json!({ "data": [
                { "id": "id-1", "name": "PRIME_AGENT_GITHUB_OWNER" },
                { "id": "id-2", "name": "PRIME_AGENT_GITHUB_OWNER_BASIC" },
            ] }),
            json!({}),
        ]);
        platform
            .clear_token_after_creates
            .store(2, Ordering::SeqCst);
        platform.fail_next_delete.store(true, Ordering::SeqCst);
        *platform.agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        let client = PrimeSandboxClient::with_transport(
            &platform,
            "prime-key",
            ClientOptions {
                base_url: "https://api.test".to_string(),
                team_id: None,
                request_timeout: None,
                allow_insecure_localhost: false,
            },
        )
        .unwrap();

        let provisioned = provision(&client, dir.path(), "OWNER", None, true, 0).await;
        let rules = provisioned.rules();

        assert!(
            !rules.contains_key("api.github.com") && !rules.contains_key("github.com"),
            "the GitHub hosts are dropped: {rules:?}"
        );
        assert!(rules.is_empty(), "GitHub was the only candidate");
    }
}
