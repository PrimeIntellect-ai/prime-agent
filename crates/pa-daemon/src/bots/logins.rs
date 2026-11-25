//! Subscription logins for bots (Anthropic, Codex, Copilot, xAI). A bot
//! never holds a login's tokens. Each login's access token is one stable
//! platform secret per Prime account and provider, and a header rule sets
//! it on the provider's API host, outside the sandbox. The guest holds an
//! OAuth record of the right shape with a placeholder access token, a
//! far-future expiry, and no refresh token, so it never refreshes.
//!
//! The Mac refreshes the login through its own auth storage, which every
//! local session also uses. Refresh tokens rotate, so no second refresher
//! exists: a refresh here is the Mac's refresh. A refresh updates the
//! secret's value; the rules keep the same name, and the platform applies
//! the new value within 60 seconds.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Result};
use base64::Engine as _;
use pa_core::auth::{
    AuthCredential, AuthStorage, ANTHROPIC_PROVIDER_ID, GITHUB_COPILOT_PROVIDER_ID,
    OPENAI_CODEX_PROVIDER_ID, XAI_PROVIDER_ID,
};
use pa_sandbox::HeaderRule;
use serde_json::Value;

use super::credentials::{key_fingerprint, GUEST_API_KEY_PLACEHOLDER};
use super::platform::BotPlatform;

/// The subscription logins a bot can use.
pub const LOGIN_PROVIDERS: [&str; 4] = [
    ANTHROPIC_PROVIDER_ID,
    OPENAI_CODEX_PROVIDER_ID,
    GITHUB_COPILOT_PROVIDER_ID,
    XAI_PROVIDER_ID,
];

/// A login is refreshed when less than this remains.
const REFRESH_MARGIN_MS: i64 = 10 * 60 * 1000;
/// How often the refresher checks the logins of running bots.
pub const REFRESH_TICK: Duration = Duration::from_secs(60);
/// The guest's expiry (2100-01-01): the guest never refreshes.
const GUEST_EXPIRES_MS: i64 = 4_102_444_800_000;
/// The platform's limit on one secret value.
const MAX_SECRET_BYTES: usize = 16 * 1024;

/// The error a bot's turn ends with once its owner's login expired.
#[must_use]
pub fn expired_message(provider: &str) -> String {
    format!("the owner's {provider} login expired; log in again on the Mac")
}

/// One login's secrets (name, value), header rules, and guest record.
#[derive(Debug, Clone, PartialEq)]
pub struct LoginInjection {
    pub provider: String,
    pub secrets: Vec<(String, String)>,
    pub rules: BTreeMap<String, HeaderRule>,
    pub guest: AuthCredential,
}

/// The access-token secret of `provider` for the Prime account `owner`.
/// The name never changes: a refresh updates the value.
#[must_use]
pub fn secret_name(provider: &str, owner: &str) -> String {
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
    format!("PRIME_AGENT_LOGIN_{id}_{owner}")
}

fn secret_ref(name: &str) -> String {
    format!("${{prime.secrets.{name}}}")
}

fn rule(host: &str, headers: &[(&str, String)]) -> BTreeMap<String, HeaderRule> {
    BTreeMap::from([(
        host.to_string(),
        HeaderRule {
            headers: headers
                .iter()
                .map(|(name, value)| ((*name).to_string(), value.clone()))
                .collect(),
        },
    )])
}

fn guest_record(access: String) -> AuthCredential {
    AuthCredential::Oauth {
        access,
        refresh: None,
        expires: GUEST_EXPIRES_MS,
        account_id: None,
        enterprise_url: None,
        endpoint: None,
        token_endpoint: None,
        client_id: None,
        resource: None,
        issuer: None,
        audience_mode: None,
    }
}

/// A Codex access token in shape (the request reads the account id from
/// it) that carries only the placeholder.
fn placeholder_codex_token() -> String {
    let segment = |value: &Value| {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string().as_bytes())
    };
    format!(
        "{}.{}.{GUEST_API_KEY_PLACEHOLDER}",
        segment(&serde_json::json!({ "alg": "none" })),
        segment(&serde_json::json!({
            "https://api.openai.com/auth": { "chatgpt_account_id": GUEST_API_KEY_PLACEHOLDER }
        })),
    )
}

/// The host of a URL.
fn url_host(url: &str) -> Option<String> {
    let (_, rest) = url.split_once("://")?;
    let host = rest.split(['/', '?', '#', ':']).next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// What `provider`'s login puts on the platform and in the guest. `None`
/// for a credential that is not a login, a Codex login without an account
/// id, or a token past the platform's secret size.
#[must_use]
pub fn injection(
    provider: &str,
    owner: &str,
    credential: &AuthCredential,
) -> Option<LoginInjection> {
    let AuthCredential::Oauth {
        access,
        account_id,
        enterprise_url,
        ..
    } = credential
    else {
        return None;
    };
    if access.is_empty() || access.len() > MAX_SECRET_BYTES {
        return None;
    }
    let name = secret_name(provider, owner);
    let bearer = format!("Bearer {}", secret_ref(&name));
    let mut secrets = vec![(name.clone(), access.clone())];
    let (rules, guest) = match provider {
        ANTHROPIC_PROVIDER_ID => (
            rule("api.anthropic.com", &[("Authorization", bearer)]),
            // The `sk-ant-oat` prefix selects the subscription request shape.
            guest_record(format!("sk-ant-oat01-{GUEST_API_KEY_PLACEHOLDER}")),
        ),
        OPENAI_CODEX_PROVIDER_ID => {
            let account = account_id.clone().filter(|account| !account.is_empty())?;
            let account_secret = format!("{name}_ACCOUNT");
            let rules = rule(
                "chatgpt.com",
                &[
                    ("Authorization", bearer),
                    ("chatgpt-account-id", secret_ref(&account_secret)),
                ],
            );
            secrets.push((account_secret, account));
            let mut guest = guest_record(placeholder_codex_token());
            if let AuthCredential::Oauth { account_id, .. } = &mut guest {
                *account_id = Some(GUEST_API_KEY_PLACEHOLDER.to_string());
            }
            (rules, guest)
        }
        GITHUB_COPILOT_PROVIDER_ID => {
            // The token names its API endpoint; the guest's placeholder keeps
            // that part, so the guest calls the same host.
            let base =
                pa_ai::oauth::get_github_copilot_base_url(Some(access), enterprise_url.as_deref());
            let host = url_host(&base)?;
            let mut placeholder = format!("tid={GUEST_API_KEY_PLACEHOLDER}");
            if let Some(proxy) = access.split(';').find(|part| part.starts_with("proxy-ep=")) {
                placeholder = format!("{placeholder};{proxy}");
            }
            let mut guest = guest_record(placeholder);
            if let AuthCredential::Oauth {
                enterprise_url: guest_enterprise,
                ..
            } = &mut guest
            {
                guest_enterprise.clone_from(enterprise_url);
            }
            (rule(&host, &[("Authorization", bearer)]), guest)
        }
        XAI_PROVIDER_ID => (
            rule("api.x.ai", &[("Authorization", bearer)]),
            guest_record(GUEST_API_KEY_PLACEHOLDER.to_string()),
        ),
        _ => return None,
    };
    Some(LoginInjection {
        provider: provider.to_string(),
        secrets,
        rules,
        guest,
    })
}

/// One read of a login.
#[derive(Debug, Clone, PartialEq)]
pub enum Login {
    /// Valid, and not due for a refresh.
    Fresh(AuthCredential),
    /// Due, but the refresh failed; still valid until it expires.
    Stale(AuthCredential),
    /// Expired, or logged out.
    Expired,
}

/// Whether a token is due: less than [`REFRESH_MARGIN_MS`] or a quarter of
/// its life remains. `obtained` is when this process first saw the token.
#[must_use]
pub fn refresh_due(expires: i64, obtained: i64, now: i64) -> bool {
    let left = expires - now;
    left < REFRESH_MARGIN_MS || left.saturating_mul(4) < expires - obtained
}

/// Read `provider`'s login, refreshing it first when it is due. The refresh
/// runs through the auth storage's own refresh, under its single-flight gate
/// and file lock, like a local session's refresh.
pub fn read_login(
    auth: &mut AuthStorage,
    provider: &str,
    obtained: Option<i64>,
    now: i64,
) -> Login {
    let Some(credential @ AuthCredential::Oauth { expires, .. }) =
        auth.get_all().credential(provider)
    else {
        return Login::Expired;
    };
    let obtained = obtained.unwrap_or(now);
    if !refresh_due(expires, obtained, now) {
        return Login::Fresh(credential);
    }
    // Due from here on: the refresh runs when the token expires before then.
    let due_at = now + REFRESH_MARGIN_MS.max((expires - obtained) / 4);
    match auth.refresh_oauth_ahead(provider, due_at) {
        Some(refreshed @ AuthCredential::Oauth { expires, .. }) if expires > due_at => {
            Login::Fresh(refreshed)
        }
        _ if now < expires => Login::Stale(credential),
        _ => Login::Expired,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

/// Builds the auth storage the logins are read from (blocking).
pub type AuthSource = Arc<dyn Fn() -> AuthStorage + Send + Sync>;

#[derive(Default)]
struct LoginState {
    /// Provider -> (access token fingerprint, when it was first seen).
    seen: HashMap<String, (String, i64)>,
    /// Secret name -> fingerprint of the value the platform holds.
    pushed: HashMap<String, String>,
    stale: BTreeSet<String>,
    expired: BTreeSet<String>,
    warned: BTreeSet<String>,
}

/// The logins injected into the bots of one Mac, and their refresher.
pub struct Logins {
    platform: Arc<dyn BotPlatform>,
    agent_dir: PathBuf,
    auth: AuthSource,
    state: Mutex<LoginState>,
    /// True while the refresher task runs.
    pub(super) refresher: Mutex<bool>,
}

/// What [`Logins::prepare`] gives a new sandbox.
#[derive(Debug, Default)]
pub struct Prepared {
    pub providers: Vec<String>,
    pub rules: BTreeMap<String, HeaderRule>,
    /// Guest `auth.json` records by provider.
    pub guest: BTreeMap<String, AuthCredential>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Logins {
    #[must_use]
    pub fn new(platform: Arc<dyn BotPlatform>, agent_dir: &Path) -> Self {
        let dir = agent_dir.to_path_buf();
        Self::with_auth(
            platform,
            agent_dir,
            Arc::new(move || AuthStorage::create(&dir)),
        )
    }

    #[must_use]
    pub fn with_auth(platform: Arc<dyn BotPlatform>, agent_dir: &Path, auth: AuthSource) -> Self {
        Self {
            platform,
            agent_dir: agent_dir.to_path_buf(),
            auth,
            state: Mutex::default(),
            refresher: Mutex::new(false),
        }
    }

    /// The logins this Mac holds, each with whether bots get it
    /// (`bots.inject.<provider>`, on by default).
    async fn stored(&self) -> Vec<(String, bool)> {
        let (auth, agent_dir) = (Arc::clone(&self.auth), self.agent_dir.clone());
        tokio::task::spawn_blocking(move || {
            let stored = auth().get_all();
            let settings = pa_core::settings::SettingsManager::create(&agent_dir, &agent_dir);
            LOGIN_PROVIDERS
                .into_iter()
                .filter(|provider| {
                    matches!(
                        stored.credential(provider),
                        Some(AuthCredential::Oauth { .. })
                    )
                })
                .map(|provider| (provider.to_string(), settings.get_bots_inject(provider)))
                .collect()
        })
        .await
        .unwrap_or_default()
    }

    /// The logins for a new sandbox: each one refreshed when due, its
    /// secrets on the platform. A bot whose model runs on a login
    /// (`provider`) fails when that login cannot be injected; other logins
    /// are left out with a warning.
    ///
    /// # Errors
    /// Returns an error when `provider`'s login is off, expired, or its
    /// secret cannot be set.
    pub async fn prepare(&self, provider: &str) -> Result<Prepared> {
        let mut prepared = Prepared::default();
        for (login, inject) in self.stored().await {
            let required = login == provider;
            if !inject {
                if required {
                    bail!(
                        "a bot on {provider} needs the owner's {provider} login, \
                         and bots.inject.{provider} is off"
                    );
                }
                continue;
            }
            match self.refresh(&login).await {
                Ok(Some(injection)) => {
                    prepared.rules.extend(injection.rules);
                    prepared.guest.insert(login.clone(), injection.guest);
                    prepared.providers.push(login);
                }
                Ok(None) if required => bail!(expired_message(&login)),
                Ok(None) => {}
                Err(error) if required => {
                    return Err(error.context(format!("the {login} login is not injected")))
                }
                Err(error) => {
                    eprintln!("bot credentials: the {login} login is not injected: {error:#}");
                }
            }
        }
        Ok(prepared)
    }

    /// Refresh each of `providers` when due and update the secrets that
    /// changed. A failure keeps the current secret and warns once.
    pub async fn tick(&self, providers: &BTreeSet<String>) {
        for provider in providers {
            if let Err(error) = self.refresh(provider).await {
                self.warn_once(provider, &format!("its secret was not updated: {error:#}"));
            }
        }
    }

    /// Read one login (refreshing it when due) and put its secrets on the
    /// platform when they changed. `None` once it expired.
    async fn refresh(&self, provider: &str) -> Result<Option<LoginInjection>> {
        let now = now_ms();
        let obtained = lock(&self.state).seen.get(provider).map(|(_, at)| *at);
        let (auth, owned) = (Arc::clone(&self.auth), provider.to_string());
        let login =
            tokio::task::spawn_blocking(move || read_login(&mut auth(), &owned, obtained, now))
                .await?;
        let credential = match login {
            Login::Fresh(credential) => {
                let mut state = lock(&self.state);
                state.stale.remove(provider);
                state.expired.remove(provider);
                state.warned.remove(provider);
                credential
            }
            Login::Stale(credential) => {
                lock(&self.state).stale.insert(provider.to_string());
                self.warn_once(
                    provider,
                    "the refresh failed; bots keep the current token until it expires",
                );
                credential
            }
            Login::Expired => {
                let mut state = lock(&self.state);
                state.stale.insert(provider.to_string());
                state.expired.insert(provider.to_string());
                drop(state);
                self.warn_once(provider, "it expired; log in again on the Mac");
                return Ok(None);
            }
        };
        let AuthCredential::Oauth { access, .. } = &credential else {
            return Ok(None);
        };
        {
            let mut state = lock(&self.state);
            let fingerprint = key_fingerprint(access);
            if state
                .seen
                .get(provider)
                .is_none_or(|(seen, _)| *seen != fingerprint)
            {
                state.seen.insert(provider.to_string(), (fingerprint, now));
            }
        }
        let Some(injection) = injection(provider, self.platform.owner(), &credential) else {
            bail!("the {provider} login cannot be injected");
        };
        for (name, value) in &injection.secrets {
            let fingerprint = key_fingerprint(value);
            if lock(&self.state).pushed.get(name) == Some(&fingerprint) {
                continue;
            }
            self.platform.put_secret(name, value).await?;
            lock(&self.state).pushed.insert(name.clone(), fingerprint);
        }
        Ok(Some(injection))
    }

    fn warn_once(&self, provider: &str, what: &str) {
        if lock(&self.state).warned.insert(provider.to_string()) {
            eprintln!("pa-daemon: bots: the {provider} login: {what}");
        }
    }

    /// The logins among `providers` that failed to refresh or expired.
    #[must_use]
    pub fn stale(&self, providers: &[String]) -> Vec<String> {
        let state = lock(&self.state);
        providers
            .iter()
            .filter(|provider| state.stale.contains(*provider))
            .cloned()
            .collect()
    }

    /// The error for a bot on `provider` once that login expired.
    #[must_use]
    pub fn expired(&self, provider: &str) -> Option<String> {
        lock(&self.state)
            .expired
            .contains(provider)
            .then(|| expired_message(provider))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use pa_core::auth::{AuthStorageData, OAuthIntegration};
    use serde_json::json;

    use super::*;
    use crate::bots::tests::{spec, FakePlatform};
    use crate::bots::BotManager;

    /// An OAuth integration whose refresh hands out the next scripted
    /// credential, or fails when none is scripted.
    #[derive(Default)]
    struct ScriptedRefresh(Mutex<Option<AuthCredential>>);

    impl OAuthIntegration for ScriptedRefresh {
        fn api_key_for(&self, _provider: &str, credential: &AuthCredential) -> Option<String> {
            match credential {
                AuthCredential::Oauth { access, .. } => Some(access.clone()),
                _ => None,
            }
        }

        fn refresh(
            &self,
            _provider: &str,
            _stored: &AuthStorageData,
        ) -> Result<AuthCredential, String> {
            self.0
                .lock()
                .unwrap()
                .take()
                .ok_or_else(|| "no scripted refresh".to_string())
        }
    }

    fn login(access: &str, refresh: &str, expires: i64) -> AuthCredential {
        let mut credential = guest_record(access.to_string());
        if let AuthCredential::Oauth {
            refresh: stored,
            expires: stored_expires,
            ..
        } = &mut credential
        {
            *stored = Some(refresh.to_string());
            *stored_expires = expires;
        }
        credential
    }

    fn write_auth(dir: &Path, provider: &str, credential: &AuthCredential) {
        let document = json!({ provider: credential });
        std::fs::write(dir.join("auth.json"), document.to_string()).unwrap();
    }

    fn stored(dir: &Path, provider: &str) -> AuthCredential {
        AuthStorage::create(dir)
            .get_all()
            .credential(provider)
            .unwrap()
    }

    fn logins(dir: &Path, platform: &Arc<FakePlatform>, refresh: &Arc<ScriptedRefresh>) -> Logins {
        let (dir_owned, refresh) = (dir.to_path_buf(), Arc::clone(refresh));
        Logins::with_auth(
            Arc::clone(platform) as Arc<dyn BotPlatform>,
            dir,
            Arc::new(move || {
                AuthStorage::create_with_oauth(&dir_owned, Arc::clone(&refresh) as Arc<_>)
            }),
        )
    }

    const MINUTE: i64 = 60_000;

    #[tokio::test]
    async fn a_due_login_refreshes_on_the_mac_and_updates_the_same_secret() {
        let dir = tempfile::tempdir().unwrap();
        let platform = Arc::new(FakePlatform::default());
        let refresh = Arc::new(ScriptedRefresh::default());
        write_auth(
            dir.path(),
            "anthropic",
            &login("a-1", "r-1", now_ms() + 5 * MINUTE),
        );
        *refresh.0.lock().unwrap() = Some(login("a-2", "r-2", now_ms() + 480 * MINUTE));
        let logins = logins(dir.path(), &platform, &refresh);

        let prepared = logins.prepare("anthropic").await.unwrap();
        let name = secret_name("anthropic", "OWNER");
        assert_eq!(platform.state().secrets[&name], "a-2");
        // The rotated refresh token stays in the Mac's auth storage.
        let AuthCredential::Oauth { refresh: kept, .. } = stored(dir.path(), "anthropic") else {
            panic!("the login stays OAuth");
        };
        assert_eq!(kept.as_deref(), Some("r-2"));
        assert_eq!(
            prepared.rules["api.anthropic.com"].headers["Authorization"],
            format!("Bearer ${{prime.secrets.{name}}}")
        );

        // Nothing due, nothing changed: no update.
        let providers = BTreeSet::from(["anthropic".to_string()]);
        logins.tick(&providers).await;
        assert_eq!(platform.state().secret_puts, 1);

        // Due again: one update of the same secret name.
        write_auth(
            dir.path(),
            "anthropic",
            &login("a-2", "r-2", now_ms() + 3 * MINUTE),
        );
        *refresh.0.lock().unwrap() = Some(login("a-3", "r-3", now_ms() + 480 * MINUTE));
        logins.tick(&providers).await;
        let state = platform.state();
        assert_eq!(state.secret_puts, 2);
        assert_eq!(state.secrets.keys().collect::<Vec<_>>(), [&name]);
        assert_eq!(state.secrets[&name], "a-3");
    }

    #[test]
    fn the_guest_gets_a_placeholder_login_without_a_refresh_token() {
        let copilot = AuthCredential::Oauth {
            access: "tid=real;exp=1;proxy-ep=proxy.business.githubcopilot.com;sku=x".into(),
            refresh: Some("gho_real".into()),
            expires: 1,
            account_id: None,
            enterprise_url: None,
            endpoint: None,
            token_endpoint: None,
            client_id: None,
            resource: None,
            issuer: None,
            audience_mode: None,
        };
        let mut codex = login("codex-access", "codex-refresh", 1);
        if let AuthCredential::Oauth { account_id, .. } = &mut codex {
            *account_id = Some("acct-1".into());
        }
        for (provider, credential, host) in [
            (
                "anthropic",
                login("ant-access", "ant-refresh", 1),
                "api.anthropic.com",
            ),
            ("openai-codex", codex, "chatgpt.com"),
            ("github-copilot", copilot, "api.business.githubcopilot.com"),
            ("xai", login("xai-access", "xai-refresh", 1), "api.x.ai"),
        ] {
            let injection = injection(provider, "OWNER", &credential).unwrap();
            assert_eq!(
                injection.rules.keys().collect::<Vec<_>>(),
                [host],
                "{provider}"
            );
            let AuthCredential::Oauth {
                access,
                refresh,
                expires,
                ..
            } = &injection.guest
            else {
                panic!("{provider}: the guest record is OAuth");
            };
            assert_eq!(*refresh, None, "{provider}");
            assert_eq!(*expires, GUEST_EXPIRES_MS, "{provider}");
            let guest = serde_json::to_string(&injection.guest).unwrap();
            assert!(
                !guest.contains("real") && !guest.contains("-access"),
                "{provider}"
            );
            assert!(access.contains(GUEST_API_KEY_PLACEHOLDER), "{provider}");
        }
        // Codex: the account id rides the same host rule as a second secret.
        let codex = injection("openai-codex", "OWNER", &{
            let mut codex = login("codex-access", "codex-refresh", 1);
            if let AuthCredential::Oauth { account_id, .. } = &mut codex {
                *account_id = Some("acct-1".into());
            }
            codex
        })
        .unwrap();
        let account = format!("{}_ACCOUNT", secret_name("openai-codex", "OWNER"));
        assert_eq!(codex.secrets[1], (account.clone(), "acct-1".to_string()));
        assert_eq!(
            codex.rules["chatgpt.com"].headers["chatgpt-account-id"],
            format!("${{prime.secrets.{account}}}")
        );
    }

    #[tokio::test]
    async fn a_failed_refresh_keeps_the_secret_until_the_login_expires() {
        let dir = tempfile::tempdir().unwrap();
        let platform = Arc::new(FakePlatform::default());
        let refresh = Arc::new(ScriptedRefresh::default());
        write_auth(
            dir.path(),
            "anthropic",
            &login("a-1", "r-1", now_ms() + 5 * MINUTE),
        );
        let logins = logins(dir.path(), &platform, &refresh);
        let providers = BTreeSet::from(["anthropic".to_string()]);

        logins.tick(&providers).await;
        let name = secret_name("anthropic", "OWNER");
        assert_eq!(platform.state().secrets[&name], "a-1");
        assert_eq!(logins.stale(&["anthropic".to_string()]), ["anthropic"]);
        assert_eq!(logins.expired("anthropic"), None);

        write_auth(
            dir.path(),
            "anthropic",
            &login("a-1", "r-1", now_ms() - MINUTE),
        );
        logins.tick(&providers).await;
        assert_eq!(
            logins.expired("anthropic").unwrap(),
            "the owner's anthropic login expired; log in again on the Mac"
        );
        assert_eq!(platform.state().secret_puts, 1);
    }

    #[tokio::test]
    async fn a_bot_on_a_login_gets_its_rule_label_and_placeholder() {
        let dir = tempfile::tempdir().unwrap();
        let platform = Arc::new(FakePlatform::default());
        let refresh = Arc::new(ScriptedRefresh::default());
        write_auth(
            dir.path(),
            "anthropic",
            &login("a-1", "r-1", now_ms() + 480 * MINUTE),
        );
        let manager = BotManager::with_logins(
            dir.path(),
            Arc::clone(&platform) as Arc<dyn BotPlatform>,
            logins(dir.path(), &platform, &refresh),
        )
        .unwrap();
        let mut bot = spec("bot-login");
        bot.model = Some("anthropic/claude-sonnet-4-5".into());
        let record = manager.spawn(&bot).await.unwrap();
        assert_eq!(record.logins, ["anthropic"]);
        let state = platform.state();
        let create = &state.creates[0];
        assert!(create
            .labels
            .contains(&"prime-agent-bot-login:anthropic".to_string()));
        assert!(create.network_rules.contains_key("api.anthropic.com"));
        let (_, env) = state
            .execs
            .iter()
            .find(|(_, env)| env.contains_key("BOT_AUTH_JSON"))
            .unwrap();
        let auth: Value = serde_json::from_str(&env["BOT_AUTH_JSON"]).unwrap();
        assert_eq!(auth["anthropic"]["type"], "oauth");
        assert!(auth["anthropic"].get("refresh").is_none_or(Value::is_null));
        assert!(!env["BOT_AUTH_JSON"].contains("a-1"));
    }
}
