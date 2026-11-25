//! GitHub access for bots. One GitHub token on this machine (stored with
//! `prime-agent bots github set`, else the `gh` CLI's login) serves every
//! bot that has GitHub on. The token never enters a sandbox: it is stored
//! as two platform secrets, and header rules set them on the bot's HTTPS
//! requests to GitHub, outside the sandbox. The guest holds
//! [`GUEST_API_KEY_PLACEHOLDER`] as its token.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use pa_core::auth::{AuthCredential, AuthStorage};
use pa_core::platform::lock_dir::LockDir;
use pa_core::settings::BotGitIdentity;
use pa_sandbox::transport::SandboxTransport;
use pa_sandbox::{HeaderRule, PrimeSandboxClient};

use super::credentials::{key_fingerprint, GUEST_API_KEY_PLACEHOLDER, PLATFORM_CA_PATH};
use super::secrets::{Candidate, SecretKind};

/// The auth storage entry that holds the stored token.
pub const GITHUB_AUTH_ID: &str = "prime-agent-bots-github";
/// The command that stores a token.
pub const SET_TOKEN_COMMAND: &str = "prime-agent bots github set";
/// The REST and GraphQL host (`gh`, the API clients).
const API_HOST: &str = "api.github.com";
/// The git smart-HTTP host.
const GIT_HOST: &str = "github.com";
/// The platform's limit on one secret value.
const MAX_SECRET_BYTES: usize = 16 * 1024;
/// The prefix of every platform secret the GitHub plan ever made, on any
/// Prime account: the account's key fingerprint follows it. `clear`
/// deletes by this prefix, so a rotated Prime key cannot leave the old
/// account's secrets behind.
pub const SECRET_NAME_PREFIX: &str = "PRIME_AGENT_GITHUB_";
/// How long a holder may keep [`lock`] before a stalled one is reclaimed:
/// a provisioning or a clear holds it for seconds, not minutes.
const LOCK_STALE_AFTER: Duration = Duration::from_mins(5);
/// How long [`lock`] waits on a fresh foreign holder before giving up.
const LOCK_ATTEMPTS: u32 = 120;
const LOCK_INTERVAL: Duration = Duration::from_millis(500);

/// Where the token comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenSource {
    /// `prime-agent bots github set`.
    Stored,
    /// `gh auth token` on this machine.
    GhCli,
}

impl TokenSource {
    #[must_use]
    pub fn describe(self) -> &'static str {
        match self {
            Self::Stored => "the stored token",
            Self::GhCli => "the gh CLI login",
        }
    }
}

/// The stored token, if any.
#[must_use]
pub fn stored_token(agent_dir: &Path) -> Option<String> {
    match AuthStorage::create(agent_dir)
        .get_all()
        .credential(GITHUB_AUTH_ID)
    {
        Some(AuthCredential::ApiKey { key, .. }) if !key.is_empty() => Some(key),
        _ => None,
    }
}

/// The token of the `gh` CLI's github.com login on this machine.
#[must_use]
pub fn gh_cli_token() -> Option<String> {
    // A daemon started by a service manager may not have Homebrew on PATH.
    ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]
        .into_iter()
        .find_map(|gh| {
            let output = std::process::Command::new(gh)
                .args(["auth", "token", "--hostname", GIT_HOST])
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .output()
                .ok()?;
            let token = String::from_utf8(output.stdout).ok()?.trim().to_string();
            (output.status.success() && !token.is_empty()).then_some(token)
        })
}

/// The token bots use: the stored one, else the `gh` CLI login. Blocking.
#[must_use]
pub fn resolve_token(agent_dir: &Path) -> Option<(String, TokenSource)> {
    stored_token(agent_dir)
        .map(|token| (token, TokenSource::Stored))
        .or_else(|| gh_cli_token().map(|token| (token, TokenSource::GhCli)))
}

/// Store `token` for bots.
///
/// # Errors
/// Returns an error for a malformed token or when the auth storage cannot
/// be written.
pub fn store_token(agent_dir: &Path, token: &str) -> Result<()> {
    if token.is_empty() || token.len() > MAX_SECRET_BYTES / 2 || token.contains(char::is_whitespace)
    {
        bail!("a GitHub token is one line with no spaces");
    }
    let mut auth = AuthStorage::create(agent_dir);
    if let Some(error) = auth.load_error() {
        bail!("the auth storage could not be read: {error}");
    }
    auth.set(
        GITHUB_AUTH_ID,
        AuthCredential::ApiKey {
            key: token.to_string(),
            prime_team: None,
        },
    );
    if let Some(error) = auth.drain_errors().into_iter().next() {
        bail!("the token was not stored: {error}");
    }
    Ok(())
}

/// Remove the stored token. True when one was stored.
///
/// # Errors
/// Returns an error when the auth storage cannot be written.
pub fn clear_token(agent_dir: &Path) -> Result<bool> {
    let mut auth = AuthStorage::create(agent_dir);
    if let Some(error) = auth.load_error() {
        bail!("the auth storage could not be read: {error}");
    }
    let stored = auth.has(GITHUB_AUTH_ID);
    auth.remove(GITHUB_AUTH_ID);
    if let Some(error) = auth.drain_errors().into_iter().next() {
        bail!("the token was not removed: {error}");
    }
    Ok(stored)
}

/// The secret names for one Prime account (`owner` is its key's
/// fingerprint): the token, and the git Basic credential. The names stay
/// the same when the token rotates; the values are updated.
#[must_use]
pub fn secret_names(owner: &str) -> [String; 2] {
    let token = format!("{SECRET_NAME_PREFIX}{owner}");
    let basic = format!("{token}_BASIC");
    [token, basic]
}

/// The Prime account fingerprint that names its GitHub secrets.
#[must_use]
pub fn owner_fingerprint(prime_api_key: &str) -> String {
    key_fingerprint(prime_api_key)
}

/// The git Basic credential of `token`. The platform cannot encode a
/// header value, so it is stored as its own secret.
fn basic_value(token: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"))
}

/// The header rules: the token as a Bearer token on the API host, and the
/// Basic credential on the git host.
fn rules(owner: &str) -> BTreeMap<String, HeaderRule> {
    let [token, basic] = secret_names(owner);
    let rule = |value: String| HeaderRule {
        headers: BTreeMap::from([("Authorization".to_string(), value)]),
    };
    BTreeMap::from([
        (
            API_HOST.to_string(),
            rule(format!("Bearer ${{prime.secrets.{token}}}")),
        ),
        (
            GIT_HOST.to_string(),
            rule(format!("Basic ${{prime.secrets.{basic}}}")),
        ),
    ])
}

/// The GitHub plan candidate: the current token as the account's two
/// secrets, with their header rules. `None` when no token is available.
/// Blocking: it may run the gh CLI.
#[must_use]
pub fn candidate(agent_dir: &Path, owner: &str) -> Option<Candidate> {
    let (token, _) = resolve_token(agent_dir)?;
    let [token_secret, basic_secret] = secret_names(owner);
    Some(Candidate {
        name: GITHUB_AUTH_ID.to_string(),
        kind: SecretKind::GitHub,
        secrets: vec![
            (token_secret, token.clone()),
            (basic_secret, basic_value(&token)),
        ],
        rules: rules(owner),
        stale: false,
    })
}

/// Delete the GitHub secrets of every Prime account this client sees:
/// bots lose GitHub access within a minute. The names carry the account
/// key's fingerprint, but a rotated key must not protect the old account's
/// secrets, so every [`SECRET_NAME_PREFIX`] name goes.
///
/// # Errors
/// Returns an error when listing or a delete fails.
pub async fn delete_secrets<T: SandboxTransport>(client: &PrimeSandboxClient<T>) -> Result<usize> {
    let mut deleted = 0;
    for secret in client.list_secrets().await? {
        if secret.name.starts_with(SECRET_NAME_PREFIX) {
            client.delete_secret(&secret.id).await?;
            deleted += 1;
        }
    }
    Ok(deleted)
}

/// The file whose `{file}.lock` directory is the agent-dir GitHub write
/// lock: `bots/github` under the agent dir, beside the registry.
fn lock_file(agent_dir: &Path) -> PathBuf {
    agent_dir.join("bots").join("github")
}

/// The lock that serializes the GitHub secret writes of one agent dir: a
/// bot spawn's provisioning and `bots github clear` both take it, so a
/// provisioning that planned before a clear cannot recreate the cleared
/// secrets after it. The `LockDir` protocol the settings storage uses.
///
/// # Errors
/// Returns an error when the lock directory cannot be created, or a live
/// holder keeps the lock past the retry budget.
pub fn lock(agent_dir: &Path) -> Result<LockDir> {
    let file = lock_file(agent_dir);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    LockDir::acquire_retrying(&file, LOCK_STALE_AFTER, LOCK_ATTEMPTS, LOCK_INTERVAL)
        .map_err(|error| anyhow::anyhow!("the bots github lock is held: {error}"))
}

/// The post-write recheck of a provisioning: when the token the machine
/// resolves now differs from the one just written (a `clear` or a rotation
/// that did not take [`lock`], an older binary), the secrets must not keep
/// the old token. Delete them; the next spawn provisions the current one.
pub(super) async fn recheck_provisioned_token<T: SandboxTransport>(
    client: &PrimeSandboxClient<T>,
    agent_dir: &Path,
    planned_token: &str,
) {
    let dir = agent_dir.to_path_buf();
    let resolved = match tokio::task::spawn_blocking(move || resolve_token(&dir)).await {
        Ok(resolved) => resolved,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    };
    if resolved.as_ref().map(|(token, _)| token.as_str()) != Some(planned_token) {
        eprintln!(
            "bot credentials: the GitHub token changed while provisioning; the bots' GitHub \
             secrets are removed until the next spawn provisions the current one"
        );
        if let Err(error) = delete_secrets(client).await {
            eprintln!("bot credentials: removing the GitHub secrets failed: {error:#}");
        }
    }
}

/// This machine's git author (`git config --global`). Blocking.
#[must_use]
pub fn mac_git_identity() -> Option<BotGitIdentity> {
    let read = |key: &str| {
        let output = std::process::Command::new("git")
            .args(["config", "--global", "--get", key])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
        (output.status.success() && !value.is_empty()).then_some(value)
    };
    Some(BotGitIdentity {
        name: read("user.name")?,
        email: read("user.email")?,
    })
}

/// The git author bots commit as: the `bots.gitIdentity` setting, else
/// this machine's git author. Blocking.
#[must_use]
pub fn git_identity(agent_dir: &Path) -> Option<BotGitIdentity> {
    pa_core::settings::SettingsManager::create(agent_dir, agent_dir)
        .get_bots_git_identity()
        .or_else(mac_git_identity)
}

/// A new bot's GitHub access and git author. `requested` is the spawn's
/// `github` argument; without one, the `bots.github` setting decides, and
/// a machine with no token spawns the bot without GitHub. Blocking.
///
/// # Errors
/// Returns an error when the spawn asks for GitHub and no token is available.
pub fn for_spawn(
    agent_dir: &Path,
    requested: Option<bool>,
) -> Result<(bool, Option<BotGitIdentity>)> {
    let identity = git_identity(agent_dir);
    let wanted = requested.unwrap_or_else(|| {
        pa_core::settings::SettingsManager::create(agent_dir, agent_dir).get_bots_github()
    });
    if !wanted {
        return Ok((false, identity));
    }
    let available = resolve_token(agent_dir).is_some();
    if !available && requested == Some(true) {
        bail!(
            "github=True needs a GitHub token on this machine. Run `{SET_TOKEN_COMMAND}` and \
             paste a fine-grained token, or log in with `gh auth login`."
        );
    }
    Ok((available, identity))
}

/// The bootstrap environment for the guest's git and `gh`.
pub(super) fn guest_env(
    github: bool,
    identity: Option<&BotGitIdentity>,
    env: &mut BTreeMap<String, String>,
) {
    if let Some(identity) = identity {
        env.insert("BOT_GIT_NAME".to_string(), identity.name.clone());
        env.insert("BOT_GIT_EMAIL".to_string(), identity.email.clone());
    }
    if github {
        env.insert(
            "GH_TOKEN".to_string(),
            GUEST_API_KEY_PLACEHOLDER.to_string(),
        );
        env.insert("PLATFORM_CA".to_string(), PLATFORM_CA_PATH.to_string());
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::future::Future;
    use std::sync::Mutex;

    use pa_sandbox::transport::{
        ResponseChunks, StreamedResponse, TransportRequest, TransportResponse,
    };
    use pa_sandbox::{ClientOptions, SandboxError};
    use serde_json::json;

    use super::*;

    /// Answers from a queue (the last answer repeats) and records requests.
    #[derive(Default)]
    struct Platform {
        answers: Mutex<VecDeque<serde_json::Value>>,
        requests: Mutex<Vec<TransportRequest>>,
    }

    impl SandboxTransport for &Platform {
        fn execute(
            &self,
            request: TransportRequest,
        ) -> impl Future<Output = Result<TransportResponse, SandboxError>> + Send {
            self.requests.lock().unwrap().push(request);
            let mut answers = self.answers.lock().unwrap();
            let body = if answers.len() > 1 {
                answers.pop_front()
            } else {
                answers.front().cloned()
            };
            std::future::ready(Ok(TransportResponse {
                status: 200,
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

    fn client(platform: &Platform) -> PrimeSandboxClient<&Platform> {
        PrimeSandboxClient::with_transport(
            platform,
            "prime-key",
            ClientOptions {
                base_url: "https://api.test".to_string(),
                team_id: None,
                request_timeout: None,
                allow_insecure_localhost: false,
            },
        )
        .unwrap()
    }

    #[test]
    fn the_rules_name_the_secrets_only() {
        let [token, basic] = secret_names("OWNER1");
        assert_eq!(token, "PRIME_AGENT_GITHUB_OWNER1");
        assert_eq!(basic, "PRIME_AGENT_GITHUB_OWNER1_BASIC");
        let rules = rules("OWNER1");
        assert_eq!(
            rules[API_HOST].headers["Authorization"],
            "Bearer ${prime.secrets.PRIME_AGENT_GITHUB_OWNER1}"
        );
        assert_eq!(
            rules[GIT_HOST].headers["Authorization"],
            "Basic ${prime.secrets.PRIME_AGENT_GITHUB_OWNER1_BASIC}"
        );
        assert_eq!(rules.len(), 2);
        assert_eq!(
            basic_value("ghp_abc"),
            base64::engine::general_purpose::STANDARD.encode("x-access-token:ghp_abc")
        );
    }

    #[test]
    fn the_guest_env_holds_the_placeholder_and_the_identity() {
        let identity = BotGitIdentity {
            name: "Ada".to_string(),
            email: "ada@example.com".to_string(),
        };
        let mut on = BTreeMap::new();
        guest_env(true, Some(&identity), &mut on);
        assert_eq!(on["GH_TOKEN"], GUEST_API_KEY_PLACEHOLDER);
        assert_eq!(on["BOT_GIT_NAME"], "Ada");
        assert_eq!(on["BOT_GIT_EMAIL"], "ada@example.com");
        let mut off = BTreeMap::new();
        guest_env(false, None, &mut off);
        assert!(off.is_empty());
    }

    /// Put the candidate's secrets on the platform, as provisioning does.
    async fn ensure(agent_dir: &Path, platform: &Platform) {
        let candidate = candidate(agent_dir, "OWNER1").unwrap();
        assert!(!format!("{:?}", candidate.rules).contains("ghp_"));
        let client = client(platform);
        for (name, value) in &candidate.secrets {
            super::super::credentials::ensure_secret(&client, name, value, "test")
                .await
                .unwrap();
        }
    }

    /// A new token creates both secrets; a rotated one updates them in
    /// place. The token goes only into secret bodies, never into the rules.
    #[tokio::test]
    async fn provisioning_creates_then_updates_the_secrets() {
        let dir = tempfile::tempdir().unwrap();
        store_token(dir.path(), "ghp_first").unwrap();
        let created = |name: &str| json!({ "data": { "id": format!("id-{name}"), "name": name } });
        let platform = Platform::default();
        platform.answers.lock().unwrap().extend([
            json!({ "data": [] }),
            created("PRIME_AGENT_GITHUB_OWNER1"),
            json!({ "data": [] }),
            created("PRIME_AGENT_GITHUB_OWNER1_BASIC"),
        ]);
        ensure(dir.path(), &platform).await;
        let bodies: Vec<(String, String)> = platform
            .requests
            .lock()
            .unwrap()
            .drain(..)
            .filter_map(|request| {
                let body = String::from_utf8(request.body?).unwrap();
                Some((request.method.as_str().to_string(), body))
            })
            .collect();
        assert_eq!(bodies.len(), 2);
        assert!(bodies[0].1.contains("\"value\":\"ghp_first\""));
        assert!(bodies[1].1.contains(&basic_value("ghp_first")));

        store_token(dir.path(), "ghp_second").unwrap();
        let listed = json!({ "data": [
            { "id": "id-1", "name": "PRIME_AGENT_GITHUB_OWNER1" },
            { "id": "id-2", "name": "PRIME_AGENT_GITHUB_OWNER1_BASIC" },
        ] });
        *platform.answers.lock().unwrap() =
            VecDeque::from([listed.clone(), json!({}), listed, json!({})]);
        ensure(dir.path(), &platform).await;
        let updates: Vec<String> = platform
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method.as_str() == "PATCH")
            .map(|request| request.url.clone())
            .collect();
        assert_eq!(
            updates,
            [
                "https://api.test/api/v1/secrets/id-1",
                "https://api.test/api/v1/secrets/id-2"
            ]
        );
    }

    /// The GitHub write lock is one agent-dir lock: a second taker contends
    /// until the first drops it, and the lock directory lives beside the
    /// bot registry.
    #[test]
    fn the_github_lock_serializes_its_writers() {
        let dir = tempfile::tempdir().unwrap();
        let held = lock(dir.path()).unwrap();
        let path = LockDir::path_for(&lock_file(dir.path()));
        assert!(path.is_dir());
        let error =
            LockDir::acquire(&lock_file(dir.path()), LOCK_STALE_AFTER).expect_err("contention");
        assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
        drop(held);
        assert!(lock(dir.path()).is_ok());
    }

    /// `clear` deletes every `PRIME_AGENT_GITHUB_` secret, not only the
    /// current Prime account's: a rotated Prime key must not leave the old
    /// account's secrets (and the bots' access) behind.
    #[tokio::test]
    async fn clear_deletes_the_github_secrets_of_every_account() {
        let platform = Platform::default();
        platform.answers.lock().unwrap().extend([
            json!({ "data": [
                { "id": "id-old", "name": "PRIME_AGENT_GITHUB_OLDFP" },
                { "id": "id-old-basic", "name": "PRIME_AGENT_GITHUB_OLDFP_BASIC" },
                { "id": "id-new", "name": "PRIME_AGENT_GITHUB_NEWFP" },
                { "id": "id-new-basic", "name": "PRIME_AGENT_GITHUB_NEWFP_BASIC" },
                { "id": "id-keep", "name": "PRIME_AGENT_PRIME_INFERENCE_KEY_ABC123" },
            ] }),
            json!({}),
            json!({}),
            json!({}),
            json!({}),
        ]);
        let client = client(&platform);
        assert_eq!(delete_secrets(&client).await.unwrap(), 4);
        let deletes: Vec<String> = platform
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method.as_str() == "DELETE")
            .map(|request| request.url.clone())
            .collect();
        assert_eq!(
            deletes,
            [
                "https://api.test/api/v1/secrets/id-old",
                "https://api.test/api/v1/secrets/id-old-basic",
                "https://api.test/api/v1/secrets/id-new",
                "https://api.test/api/v1/secrets/id-new-basic",
            ]
        );
    }

    /// The post-write recheck: the secrets stay when the machine still
    /// resolves the planned token, and go when a clear removed it.
    #[tokio::test]
    async fn a_changed_token_removes_the_provisioned_secrets() {
        let dir = tempfile::tempdir().unwrap();
        store_token(dir.path(), "ghp_first").unwrap();
        let platform = Platform::default();
        platform.answers.lock().unwrap().extend([
            json!({ "data": [
                { "id": "id-1", "name": "PRIME_AGENT_GITHUB_OWNER1" },
                { "id": "id-2", "name": "PRIME_AGENT_GITHUB_OWNER1_BASIC" },
            ] }),
            json!({}),
            json!({}),
        ]);
        let client = client(&platform);
        recheck_provisioned_token(&client, dir.path(), "ghp_first").await;
        assert!(platform
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.method.as_str() != "DELETE"));
        clear_token(dir.path()).unwrap();
        recheck_provisioned_token(&client, dir.path(), "ghp_first").await;
        let deletes: Vec<String> = platform
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method.as_str() == "DELETE")
            .map(|request| request.url.clone())
            .collect();
        assert_eq!(
            deletes,
            [
                "https://api.test/api/v1/secrets/id-1",
                "https://api.test/api/v1/secrets/id-2",
            ]
        );
    }
}
