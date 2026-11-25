//! The guest's provider credentials. A bot sandbox never holds a real
//! key: each provider the home auth storage holds an API key for is stored
//! once as a platform secret (`PRIME_AGENT_<PROVIDER>_KEY_<FINGERPRINT>`; a
//! rotated key gets a new secret), and the
//! sandbox's network policy has the platform set it in that provider's
//! auth header on the sandbox's HTTPS requests, outside the sandbox. The
//! guest sends [`GUEST_API_KEY_PLACEHOLDER`], which the platform replaces.
//!
//! Subscription logins are injected by [`super::logins`]. A key or login
//! with `bots.inject.<provider>` set to `false` stays home.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::LazyLock;

use hmac::{Hmac, KeyInit, Mac};
use pa_core::auth::{
    AuthCredential, AuthStorage, AuthStorageData, PrimeTeamCredential, StoredPrimeTeam,
    PRIME_INFERENCE_PROVIDER_ID,
};
use pa_core::models::PRIME_INFERENCE_DEFAULT_MODEL_ID;
use pa_sandbox::transport::{ReqwestSandboxTransport, SandboxTransport};
use pa_sandbox::{HeaderRule, PrimeSandboxClient};
use sha2::Sha256;

/// The API key the guest holds. The platform replaces the auth header it
/// rides in with the real key, outside the sandbox.
pub const GUEST_API_KEY_PLACEHOLDER: &str = "injected-by-platform";

/// The platform root certificate inside the sandbox. The platform
/// terminates TLS for the rule hosts to set their headers, so the guest's
/// clients must trust it.
pub const PLATFORM_CA_PATH: &str = "/mnt/sandboxd/platform-ca.pem";

/// The platform's limit on header-rule hosts per sandbox.
pub(super) const MAX_RULE_HOSTS: usize = 32;

/// A secret's scope: the platform origin, the team, and the secret name.
type SecretScope = (String, Option<String>, String);

/// The secrets confirmed on the platform in this process: provisioning
/// runs once per process and scope. The lock is held across a whole
/// provisioning, so concurrent spawns never list and create the same
/// secret twice.
static CONFIRMED: LazyLock<tokio::sync::Mutex<BTreeSet<SecretScope>>> =
    LazyLock::new(Default::default);

/// One provider's injected key: the secret that holds it, and the rules
/// that set it on the provider's API hosts.
struct Injection {
    provider: String,
    secret: String,
    key: String,
    rules: BTreeMap<String, HeaderRule>,
}

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

/// The host of a catalog base URL.
fn base_url_host(base_url: &str) -> Option<String> {
    let (_, rest) = base_url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
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

/// The API keys the platform can inject (stored, or from the environment
/// for `required`), `required` first, then prime-inference. OAuth logins
/// and keys that `allowed` refuses are left out. A
/// host an earlier provider holds (the platform never combines rules), or
/// one past the platform's host limit, is left out.
fn injections(
    auth: &mut AuthStorage,
    required: Option<&str>,
    max_hosts: usize,
    allowed: impl Fn(&str) -> bool,
) -> Vec<Injection> {
    let stored = auth.get_all();
    let mut providers = auth.list();
    providers.retain(|provider| provider != super::github::GITHUB_AUTH_ID && allowed(provider));
    // A key that `bots.inject` turns off stays home, even for the bot's own provider.
    if let Some(required) = required.filter(|required| allowed(required)) {
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
    let mut hosts = BTreeSet::new();
    let mut injections = Vec::new();
    for provider in providers {
        let Some(key) = injectable_key(auth, &stored, &provider) else {
            continue;
        };
        let fingerprint = key_fingerprint(&key);
        let secret = format!("{}_{fingerprint}", secret_name(&provider));
        let mut rules = provider_rules(&provider, &secret);
        rules.retain(|host, _| hosts.len() < max_hosts && hosts.insert(host.clone()));
        if rules.is_empty() {
            eprintln!("bot credentials: no injectable API host for {provider}; its key stays home");
            continue;
        }
        injections.push(Injection {
            provider,
            secret,
            key,
            rules,
        });
    }
    injections
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
/// providers they belong to, and the providers whose secret could not be
/// confirmed.
#[derive(Debug, Default)]
pub struct Provisioned {
    rules: BTreeMap<String, HeaderRule>,
    providers: Vec<String>,
    failed: Vec<(String, anyhow::Error)>,
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
    /// authenticate a turn). Other providers' failures are logged and
    /// only drop their own rules.
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
                eprintln!("bot credentials: the {failed} key is not injected: {error:#}");
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

/// Make sure the platform holds a secret for each stored provider key it
/// can inject: list first, create the missing, once per process.
/// `provider` is the guest's provider when it uses an API key.
/// `reserved_hosts` rule hosts are left for other rules. The
/// secrets live in the client's team, the scope its sandboxes bill to,
/// which a header rule's secret must share.
pub async fn provision(
    client: &PrimeSandboxClient<ReqwestSandboxTransport>,
    agent_dir: &Path,
    provider: Option<&str>,
    reserved_hosts: usize,
) -> Provisioned {
    // Reading the auth storage may run a `!command` key: keep it off the runtime.
    let (agent_dir, required) = (agent_dir.to_path_buf(), provider.map(str::to_string));
    let (injections, prime_team) = match tokio::task::spawn_blocking(move || {
        let mut auth = AuthStorage::create(&agent_dir);
        let settings = pa_core::settings::SettingsManager::create(&agent_dir, &agent_dir);
        (
            injections(
                &mut auth,
                required.as_deref(),
                MAX_RULE_HOSTS.saturating_sub(reserved_hosts),
                |provider| settings.get_bots_inject(provider),
            ),
            effective_prime_team(&auth),
        )
    })
    .await
    {
        Ok(read) => read,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    };
    let mut provisioned = provision_injections(client, injections).await;
    provisioned.prime_team = prime_team;
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

async fn provision_injections(
    client: &PrimeSandboxClient<ReqwestSandboxTransport>,
    injections: Vec<Injection>,
) -> Provisioned {
    let mut confirmed = CONFIRMED.lock().await;
    let mut provisioned = Provisioned::default();
    let mut listed = None;
    for injection in injections {
        let scoped = (
            client.base_url().to_string(),
            client.team_id().map(str::to_string),
            injection.secret.clone(),
        );
        let outcome = if confirmed.contains(&scoped) {
            Ok(())
        } else {
            confirm_secret(client, &injection, &mut listed).await
        };
        match outcome {
            Ok(()) => {
                confirmed.insert(scoped);
                provisioned.rules.extend(injection.rules);
                provisioned.providers.push(injection.provider);
            }
            Err(error) => provisioned.failed.push((injection.provider, error)),
        }
    }
    provisioned
}

/// Confirm one secret on the platform: listed (one list serves every
/// provider), else created. A refused create lists again: another process
/// may have created it meanwhile.
async fn confirm_secret(
    client: &PrimeSandboxClient<ReqwestSandboxTransport>,
    injection: &Injection,
    listed: &mut Option<BTreeSet<String>>,
) -> anyhow::Result<()> {
    let mut names = match listed.take() {
        Some(names) => names,
        None => secret_names(client).await?,
    };
    if !names.contains(&injection.secret) {
        let description = format!("Prime Agent bot {} credential", injection.provider);
        if let Err(error) = client
            .create_secret(&injection.secret, &injection.key, Some(&description))
            .await
        {
            names = secret_names(client).await?;
            if !names.contains(&injection.secret) {
                return Err(error.into());
            }
        }
        names.insert(injection.secret.clone());
    }
    *listed = Some(names);
    Ok(())
}

async fn secret_names(
    client: &PrimeSandboxClient<ReqwestSandboxTransport>,
) -> anyhow::Result<BTreeSet<String>> {
    Ok(client
        .list_secrets()
        .await?
        .into_iter()
        .map(|secret| secret.name)
        .collect())
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
    use std::sync::Arc;

    use pa_core::auth::NoOAuth;
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
        let injected = injections(
            &mut auth(&home_auth()),
            Some(PRIME_INFERENCE_PROVIDER_ID),
            MAX_RULE_HOSTS,
            |_| true,
        );
        let summary: Vec<(&str, &str)> = injected
            .iter()
            .map(|injection| (injection.provider.as_str(), injection.key.as_str()))
            .collect();
        assert_eq!(
            summary,
            [("prime-inference", "sk-prime"), ("google", "sk-google")]
        );
        // A rotated key gets a new secret.
        assert!(injected[1].secret.starts_with("PRIME_AGENT_GOOGLE_KEY_"));
        let rotated = injections(
            &mut auth(&json!({ "google": { "type": "api_key", "key": "sk-google-2" } })),
            Some("google"),
            MAX_RULE_HOSTS,
            |_| true,
        );
        assert_ne!(rotated[0].secret, injected[1].secret);

        let keyed = injections(
            &mut auth(&json!({
                "zai": { "type": "api_key", "key": "sk-zai" },
                "openai": { "type": "api_key", "key": "sk-openai" },
                "anthropic": { "type": "api_key", "key": "sk-ant-api" },
                "prime-inference": { "type": "api_key", "key": "" },
            })),
            Some(PRIME_INFERENCE_PROVIDER_ID),
            MAX_RULE_HOSTS,
            |_| true,
        );
        let providers: Vec<&str> = keyed
            .iter()
            .map(|injection| injection.provider.as_str())
            .collect();
        assert_eq!(providers, ["anthropic", "openai", "zai"]);

        // `bots.inject` off keeps a key home, even for the bot's own provider.
        let off = injections(
            &mut auth(&home_auth()),
            Some("google"),
            MAX_RULE_HOSTS,
            |provider| provider != "google",
        );
        assert!(off.iter().all(|injection| injection.provider != "google"));
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
}
