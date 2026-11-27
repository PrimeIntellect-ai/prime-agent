//! The bot lifecycle, after the prime-orbs dispatcher: labels plus a
//! deterministic idempotency key on every create; wake by resume, then the
//! running sandbox, then the newest durable checkpoint, then a cold boot;
//! pause with a checkpoint (checkpoint and delete when pause is refused);
//! delete everything the labels name. One async mutex per bot serializes it.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use pa_core::auth::PRIME_INFERENCE_PROVIDER_ID;
use pa_core::cron::parse_iso_millis;
use serde_json::{json, Value};
use tokio::time::Instant;

use super::logins::{Logins, REFRESH_TICK};
use super::platform::{
    BotCheckpoint, BotCreate, BotPlatform, BotSandbox, ExecOutput, GuestCredentials, PlatformError,
    PlatformResult,
};
use super::registry::{BotRecord, BotRegistry, BotStatus};
use super::version::{self, Install, ReleaseSource};
use super::{
    bot_label, login_label, owner_label, sha256_hex, BotSpec, BOT_IMAGE_ENV, BOT_LABEL,
    DEFAULT_BOT_IMAGE, GITHUB_LABEL, LOGIN_LABEL_PREFIX,
};

/// The budget for one wake, create, or pause.
const OPERATION_BUDGET: Duration = Duration::from_mins(15);
/// Delete-cascade sweeps: a child the guest creates mid-delete is caught
/// by the next listing; the delete ends once a sweep finds nothing left.
const DESCENDANT_SWEEPS: usize = 3;
/// The relay registration call's deadline.
const REGISTRATION_TIMEOUT: Duration = Duration::from_secs(15);
/// Attempts for one platform call that answers 409, 429, 5xx, or a network
/// error: about 30 s of backoff, so a busy account's rate limit passes.
const RETRY_ATTEMPTS: u32 = 10;

/// The guest settings merge, run by the bootstrap script through the
/// `BOT_SETTINGS_PY` environment variable. It writes the owner's
/// `factory.enabled` and the bot's MCP servers into the guest
/// `settings.json`, and the bot's MCP connection records into
/// `mcp-connections.json`, each under the guest daemon's own `{file}.lock`
/// protocol (a `LockDir`-style empty directory, a stale one reclaimed) with
/// an atomic replace, so a concurrent update by the guest daemon is merged,
/// not overwritten by a stale snapshot.
pub(super) const GUEST_SETTINGS_PY: &str = r#"
import json, os, time


def locked_update(path, update):
    """Read-modify-write under the daemon's {file}.lock protocol."""
    lock = path + ".lock"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    while True:
        try:
            os.mkdir(lock)
            break
        except FileExistsError:
            try:
                stale = time.time() - os.stat(lock).st_mtime > 10
            except OSError:
                stale = False
            if stale:
                try:
                    os.rmdir(lock)
                except OSError:
                    pass
            else:
                time.sleep(0.02)
    try:
        try:
            document = json.load(open(path))
        except (OSError, ValueError):
            document = None
        document = update(document)
        temp = path + ".tmp" + str(os.getpid())
        handle = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(handle, "w") as file:
            json.dump(document, file)
        os.replace(temp, path)
    finally:
        try:
            os.rmdir(lock)
        except OSError:
            pass


def settings_update(settings):
    if not isinstance(settings, dict):
        settings = {}
    settings.setdefault("factory", {})["enabled"] = os.environ["BOT_FACTORY_ENABLED"] == "true"
    if os.environ.get("BOT_MCP_SERVERS"):
        settings.setdefault("mcpServers", {}).update(json.loads(os.environ["BOT_MCP_SERVERS"]))
    if os.environ.get("BOT_NESTED_JSON"):
        # This bot may spawn bots: the guest spawn gate opens. An explicit
        # non-object "bots" value is normalized, not trusted.
        bots = settings.get("bots")
        if not isinstance(bots, dict):
            bots = {}
            settings["bots"] = bots
        bots["enabled"] = True
    return settings


locked_update(os.path.join(os.environ["HOME"], ".prime/agent/settings.json"), settings_update)

if os.environ.get("BOT_NESTED_JSON"):
    # The nested-spawn context lands next to the guest registry, where the
    # daemon reads it fresh at every spawn.
    nested = os.path.join(os.environ["HOME"], ".prime/agent/bots/nested.json")
    os.makedirs(os.path.dirname(nested), exist_ok=True)
    with open(nested, "w") as file:
        file.write(os.environ["BOT_NESTED_JSON"])


def connections_update(store):
    if store is None:
        store = {"version": 1, "connections": {}}
    store.setdefault("connections", {}).update(json.loads(os.environ["BOT_MCP_CONNECTIONS"]))
    return store


if os.environ.get("BOT_MCP_CONNECTIONS"):
    locked_update(
        os.path.join(os.environ["HOME"], ".prime/agent/mcp-connections.json"), connections_update
    )
"#;

/// Writes the owner's `factory.enabled` into the guest settings, starts the
/// guest daemon when it is not up, then opens the bot session. It
/// reopens `BOT_SESSION_FILE`, or the file a marker on the guest disk names, so
/// a registry rebuilt from labels still finds the session. Prints the session ids as JSON.
/// It also writes a CA bundle that adds the platform root, sets the git
/// author, and with GitHub access (`GH_TOKEN` holds the placeholder) a git
/// credential that sends the placeholder, which the platform replaces.
const BOOTSTRAP_SCRIPT: &str = r#"set -euo pipefail
export HOME="${HOME:-/root}"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
cd "$HOME"
mkdir -p "$(dirname "$PRIME_AGENT_DAEMON_SOCKET")"
# The guest daemon's idle self-pause configuration: written before the
# daemon starts and rewritten at every wake, so a resumed daemon reads
# its current sandbox id and settings.
python3 - <<'PY'
import json, os
path = os.environ["PRIME_AGENT_BOT_SELF_PAUSE"]
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as file:
    json.dump({
        "botId": os.environ["PRIME_AGENT_BOT_ID"],
        "sandboxId": os.environ["PRIME_AGENT_BOT_SANDBOX_ID"],
        "relayUrl": os.environ.get("BOT_RELAY_URL", ""),
        "pauseUrl": os.environ.get("BOT_SELF_PAUSE_URL", ""),
        "idleMinutes": int(os.environ.get("BOT_SELF_PAUSE_MINUTES", "10")),
    }, file)
PY
if [ -n "${BOT_AUTH_JSON:-}" ] && { [ -n "${BOT_AUTH_OVERWRITE:-}" ] || [ ! -s "$HOME/.prime/agent/auth.json" ]; }; then
  (umask 077; printf '%s' "$BOT_AUTH_JSON" >"$HOME/.prime/agent/auth.json")
fi
python3 -c "$BOT_SETTINGS_PY"
if [ -f "${PLATFORM_CA:-}" ]; then
  # The platform terminates TLS for the rule hosts (model APIs, GitHub, MCP
  # servers): every client in the bot must trust its root.
  cat /etc/ssl/certs/ca-certificates.crt "$PLATFORM_CA" >"$HOME/.prime-agent-ca.pem"
  export SSL_CERT_FILE="$HOME/.prime-agent-ca.pem" REQUESTS_CA_BUNDLE="$HOME/.prime-agent-ca.pem"
fi
if [ -n "${BOT_GIT_NAME:-}" ]; then
  git config --global user.name "$BOT_GIT_NAME"
  git config --global user.email "$BOT_GIT_EMAIL"
fi
if [ -n "${GH_TOKEN:-}" ]; then
  helper="$HOME/.prime-agent-git-credential"
  printf '#!/bin/sh\ntest "$1" = get || exit 0\necho username=x-access-token\necho password=%s\n' \
    "$GH_TOKEN" >"$helper"
  chmod 755 "$helper"
  git config --global --replace-all credential.https://github.com.helper "$helper"
  if [ -f "$HOME/.prime-agent-ca.pem" ]; then
    git config --global http.sslCAInfo "$HOME/.prime-agent-ca.pem"
  fi
fi
if ! python3 -c "$BOT_CLIENT" probe; then
  # `uv pip install <pkg>` in the bot's shell installs into its kernel venv.
  export VIRTUAL_ENV="$HOME/.prime/agent/kernel-venv"
  nohup setsid prime-agent --mode daemon --daemon-socket "$PRIME_AGENT_DAEMON_SOCKET" \
    </dev/null >>"$HOME/.prime-agent-bot.log" 2>&1 &
  for _ in $(seq 1 150); do
    python3 -c "$BOT_CLIENT" probe && break
    sleep 0.2
  done
fi
python3 -c "$BOT_CLIENT" create
"#;

/// A minimal client for the daemon's JSONL socket protocol.
pub(super) const BOT_CLIENT: &str = r#"import json, os, socket, sys
def connect():
    sock = socket.socket(socket.AF_UNIX)
    sock.settimeout(60)
    sock.connect(os.environ["PRIME_AGENT_DAEMON_SOCKET"])
    stream = sock.makefile("rwb")
    frames = (json.loads(line) for line in stream if line.strip())
    hello = next(f for f in frames if f.get("type") == "daemon_hello")
    return stream, frames, hello
if sys.argv[1] == "probe":
    try:
        connect()
    except Exception:
        sys.exit(1)
    sys.exit(0)
stream, frames, hello = connect()
command = {"type": "create", "id": "bot-bootstrap", "name": os.environ["BOT_NAME"],
           "lifecycle": "resident", "config": json.loads(os.environ["BOT_CONFIG"])}
marker = os.path.join(os.environ["HOME"], ".prime-agent-bot-session")
session_file = os.environ.get("BOT_SESSION_FILE")
if not session_file and os.path.exists(marker):
    session_file = open(marker).read().strip()
if session_file and os.path.exists(session_file):
    command["sessionPath"] = session_file
    # A reopened session keeps its own model and thinking: the config's
    # are the spawn-time ones, and the session file pins every later
    # switch; an explicit create flag would override them.
    for key in ("provider", "model", "thinking"):
        command["config"].pop(key, None)
envelope = {"type": "command", "id": "bot-bootstrap", "protocol": hello["protocol"],
            "clientId": "bot-bootstrap", "command": command}
stream.write((json.dumps(envelope) + "\n").encode())
stream.flush()
reply = next(f for f in frames if f.get("type") == "response" and f.get("id") == "bot-bootstrap")
if not reply.get("success"):
    sys.exit("create failed: %s" % reply.get("error"))
data = reply.get("data") or {}
if data.get("sessionFile"):
    with open(marker, "w") as out:
        out.write(data["sessionFile"])
print(json.dumps({"activeSessionId": data.get("activeSessionId") or data.get("id"),
                  "sessionFile": data.get("sessionFile")}))
"#;

/// Writes a running bot's nested-spawn settings: the nested context next
/// to the guest registry, the guest spawn gate, and the Prime Inference
/// placeholder record (merged, keeping the guest's other records).
pub(super) const ALLOW_SPAWNS_SCRIPT: &str = r#"set -euo pipefail
export HOME="${HOME:-/root}"
python3 - <<'PY'
import json, os, time


def locked_update(path, update):
    """Read-modify-write under the daemon's {file}.lock protocol."""
    lock = path + ".lock"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    while True:
        try:
            os.mkdir(lock)
            break
        except FileExistsError:
            try:
                stale = time.time() - os.stat(lock).st_mtime > 10
            except OSError:
                stale = False
            if stale:
                try:
                    os.rmdir(lock)
                except OSError:
                    pass
            else:
                time.sleep(0.02)
    try:
        try:
            document = json.load(open(path))
        except (OSError, ValueError):
            document = None
        document = update(document)
        temp = path + ".tmp" + str(os.getpid())
        handle = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(handle, "w") as file:
            json.dump(document, file)
        os.replace(temp, path)
    finally:
        try:
            os.rmdir(lock)
        except OSError:
            pass


def settings_update(settings):
    if not isinstance(settings, dict):
        settings = {}
    bots = settings.get("bots")
    if not isinstance(bots, dict):
        bots = {}
        settings["bots"] = bots
    bots["enabled"] = True
    return settings


def auth_update(auth):
    if not isinstance(auth, dict):
        auth = {}
    auth["prime-inference"] = json.loads(os.environ["BOT_PRIME_RECORD"])
    return auth


home = os.environ["HOME"]
locked_update(os.path.join(home, ".prime/agent/settings.json"), settings_update)
locked_update(os.path.join(home, ".prime/agent/auth.json"), auth_update)
# The nested context lands next to the guest registry, where the daemon
# reads it fresh at every spawn.
nested = os.path.join(home, ".prime/agent/bots/nested.json")
os.makedirs(os.path.dirname(nested), exist_ok=True)
with open(nested, "w") as file:
    file.write(os.environ["BOT_NESTED_JSON"])
PY
"#;

/// Holds one attach open; dropping it detaches.
#[derive(Debug)]
pub struct AttachGuard {
    attached: Arc<Mutex<HashMap<String, usize>>>,
    bot_id: String,
}

impl Drop for AttachGuard {
    fn drop(&mut self) {
        let mut attached = lock(&self.attached);
        if let Some(count) = attached.get_mut(&self.bot_id) {
            *count -= 1;
            if *count == 0 {
                attached.remove(&self.bot_id);
            }
        }
    }
}

/// The outcome of one bot's in-place refresh
/// ([`BotManager::refresh_running`]).
#[derive(Debug)]
pub enum BotRefresh {
    /// The bot runs this binary's version now; the upgraded record.
    Refreshed(BotRecord),
    /// The bot no longer ran when its turn came, so nothing was done; the
    /// record as it was left (a paused bot installs on its next wake).
    Skipped(BotRecord),
}

/// The bot lifecycle for one Prime account. Lives in the supervisor process.
pub struct BotManager {
    pub(super) platform: Arc<dyn BotPlatform>,
    registry: Arc<Mutex<BotRegistry>>,
    /// The owner's subscription logins in the bots, and their refresher.
    pub(super) logins: Arc<Logins>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    attached: Arc<Mutex<HashMap<String, usize>>>,
    /// The guest auth for a sandbox created with matching header rules,
    /// until its bootstrap writes it. Keyed by sandbox id.
    guest_auth: Mutex<HashMap<String, GuestCredentials>>,
    image: String,
    /// The owner's agent dir: its `factory.enabled` carries into the bot.
    pub(super) agent_dir: PathBuf,
}

impl BotManager {
    /// A manager over `platform` with the registry cached under `agent_dir`.
    ///
    /// # Errors
    /// Returns an error when the registry file exists but cannot be read.
    pub fn new(agent_dir: &Path, platform: Arc<dyn BotPlatform>) -> Result<Self> {
        let logins = Logins::new(Arc::clone(&platform), agent_dir);
        Self::with_logins(agent_dir, platform, logins)
    }

    /// A manager whose logins come from `logins`.
    ///
    /// # Errors
    /// Returns an error when the registry file exists but cannot be read.
    pub fn with_logins(
        agent_dir: &Path,
        platform: Arc<dyn BotPlatform>,
        logins: Logins,
    ) -> Result<Self> {
        Ok(Self {
            platform,
            registry: Arc::new(Mutex::new(BotRegistry::load(agent_dir)?)),
            logins: Arc::new(logins),
            locks: Mutex::new(HashMap::new()),
            attached: Arc::new(Mutex::new(HashMap::new())),
            guest_auth: Mutex::new(HashMap::new()),
            image: std::env::var(BOT_IMAGE_ENV)
                .ok()
                .filter(|image| !image.is_empty())
                .unwrap_or_else(|| DEFAULT_BOT_IMAGE.to_string()),
            agent_dir: agent_dir.to_path_buf(),
        })
    }

    /// Every known bot.
    #[must_use]
    pub fn list(&self) -> Vec<BotRecord> {
        lock(&self.registry).all()
    }

    /// One known bot.
    #[must_use]
    pub fn get(&self, bot_id: &str) -> Option<BotRecord> {
        lock(&self.registry).get(bot_id).cloned()
    }

    /// Mark an attach of `bot_id` until the guard drops.
    #[must_use]
    pub fn attach_guard(&self, bot_id: &str) -> AttachGuard {
        *lock(&self.attached).entry(bot_id.to_string()).or_default() += 1;
        AttachGuard {
            attached: Arc::clone(&self.attached),
            bot_id: bot_id.to_string(),
        }
    }

    /// Whether this daemon owns `record`'s lifecycle: its own bot, or, in a
    /// bot's daemon, a bot this bot spawned. Other rows are mirrors.
    #[must_use]
    pub fn manages(&self, record: &BotRecord) -> bool {
        record.parent_bot_id.is_none()
            || record.parent_bot_id
                == super::nested::NestedContext::read(&self.agent_dir).map(|context| context.bot_id)
    }

    /// True while an [`AttachGuard`] for `bot_id` is alive.
    #[must_use]
    pub fn attached(&self, bot_id: &str) -> bool {
        lock(&self.attached).contains_key(bot_id)
    }

    /// The bot's logins whose refresh failed or that expired.
    #[must_use]
    pub fn login_stale(&self, record: &BotRecord) -> Vec<String> {
        self.logins.stale(&record.logins)
    }

    /// The error for a bot whose model runs on an expired owner login.
    #[must_use]
    pub fn login_expired(&self, record: &BotRecord) -> Option<String> {
        let provider = guest_provider(record);
        record
            .logins
            .iter()
            .any(|login| login == provider)
            .then(|| self.logins.expired(provider))
            .flatten()
    }

    /// Refresh the bot's logins that are due, update their secrets, and
    /// start the refresher for a running bot (also after a daemon restart,
    /// when the follow of a running bot comes here first).
    pub async fn refresh_logins(&self, record: &BotRecord) {
        if record.logins.is_empty() {
            return;
        }
        self.logins
            .tick(&record.logins.iter().cloned().collect())
            .await;
        if record.status == BotStatus::Running {
            self.watch_logins();
        }
    }

    /// Start the login refresher unless it runs. It refreshes the logins
    /// of running bots and stops once no running bot uses a login.
    fn watch_logins(&self) {
        let mut running = lock(&self.logins.refresher);
        if *running {
            return;
        }
        *running = true;
        let (logins, registry) = (Arc::clone(&self.logins), Arc::clone(&self.registry));
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(REFRESH_TICK).await;
                let in_use = {
                    let mut running = lock(&logins.refresher);
                    let in_use: BTreeSet<String> = lock(&registry)
                        .all()
                        .into_iter()
                        .filter(|record| record.status == BotStatus::Running)
                        .flat_map(|record| record.logins)
                        .collect();
                    if in_use.is_empty() {
                        *running = false;
                        return;
                    }
                    in_use
                };
                logins.tick(&in_use).await;
            }
        });
    }

    /// Send every running or paused bot its header rules again, from the
    /// current secrets plan. The platform replaces each sandbox's whole
    /// policy; a paused sandbox gets it on resume. A secret that the plan
    /// leaves out is gone from the new rules, the bot's own model key
    /// included. Returns one message per bot that kept its old rules.
    pub async fn refresh_network_rules(&self) -> Vec<String> {
        let mut failures = Vec::new();
        for bot in self.list() {
            let bot_lock = self.lock_for(&bot.bot_id);
            let _held = bot_lock.lock().await;
            let Ok(mut record) = self.record(&bot.bot_id) else {
                continue;
            };
            let Some(sandbox_id) = record
                .sandbox_id
                .clone()
                .filter(|_| matches!(record.status, BotStatus::Running | BotStatus::Paused))
            else {
                continue;
            };
            // The bot's own key or login stays required unless the user
            // turned it off; then the new rules leave it out.
            let provider = guest_provider(&record).to_string();
            let required = self.injects(&provider).await.then_some(provider.as_str());
            let outcome = match self.credentials_for(&record, required, record.github).await {
                Ok((credentials, logins, relay_host)) => self
                    .platform
                    .set_network_rules(&sandbox_id, &credentials.network_rules)
                    .await
                    .map(|()| (credentials.network_rules, logins, relay_host))
                    .map_err(anyhow::Error::from),
                Err(error) => Err(error),
            };
            let mut credentials_rules = None;
            match outcome {
                Ok((rules, logins, relay_host)) => {
                    // The refresher follows the logins the new rules carry,
                    // and the relay host they now carry.
                    record.logins = logins;
                    record.pause_rule_host = relay_host;
                    let running = record.status == BotStatus::Running;
                    let watch = running && !record.logins.is_empty();
                    if record.bots {
                        credentials_rules = Some(rules);
                    }
                    if let Err(error) = self.save(record.clone()) {
                        failures.push(format!("{}: {error:#}", record.name));
                    } else if watch {
                        self.watch_logins();
                    }
                }
                Err(error) => failures.push(format!("{}: {error:#}", record.name)),
            }
            // A bot that spawns bots hands its children the rules this
            // refresh just computed; a revoked secret must leave the guest's
            // nested context the same moment it leaves the sandbox policy.
            if let (Some(rules), true) = (credentials_rules, record.status == BotStatus::Running) {
                if let Err(error) = self
                    .rewrite_nested_context(&record, &sandbox_id, rules)
                    .await
                {
                    failures.push(format!("{}: {error:#}", record.name));
                }
            }
        }
        failures
    }

    /// Rewrite a running bot's guest nested context from `rules`: the same
    /// write `allow_spawns` performs, so the children see the current
    /// credentials, not the bootstrap-time snapshot.
    async fn rewrite_nested_context(
        &self,
        record: &BotRecord,
        sandbox_id: &str,
        rules: BTreeMap<String, pa_sandbox::HeaderRule>,
    ) -> Result<()> {
        let agent_dir = self.agent_dir.clone();
        let max_bots = tokio::task::spawn_blocking(move || {
            pa_core::settings::SettingsManager::create(&agent_dir, &agent_dir).get_bots_max_bots()
                as usize
        })
        .await
        .context("the bots.maxBots read failed")?;
        let context = super::nested::NestedContext {
            bot_id: record.bot_id.clone(),
            owner_session_id: record.owner_session_id.clone(),
            depth: 1,
            max_bots,
            network_rules: rules,
        };
        let team = self.sandbox_key_and_team().await?.1;
        let prime = serde_json::to_value(pa_core::auth::AuthCredential::ApiKey {
            key: super::credentials::GUEST_API_KEY_PLACEHOLDER.to_string(),
            prime_team: team,
        })?;
        let env = BTreeMap::from([
            (
                "BOT_NESTED_JSON".to_string(),
                serde_json::to_string(&context)?,
            ),
            ("BOT_PRIME_RECORD".to_string(), prime.to_string()),
        ]);
        let output = self
            .exec_ready(
                sandbox_id,
                ALLOW_SPAWNS_SCRIPT,
                &env,
                None,
                Instant::now() + OPERATION_BUDGET,
            )
            .await?;
        check_exit("refresh the bot's nested context", &output)?;
        Ok(())
    }

    /// Whether `bots.inject.<name>` gives bots the secret `name`.
    async fn injects(&self, name: &str) -> bool {
        let (agent_dir, name) = (self.agent_dir.clone(), name.to_string());
        tokio::task::spawn_blocking(move || {
            pa_core::settings::SettingsManager::create(&agent_dir, &agent_dir)
                .get_bots_inject(&name)
        })
        .await
        .unwrap_or(true)
    }

    /// Record a settled guest turn.
    ///
    /// # Errors
    /// Returns an error for an unknown bot or a registry write failure.
    pub fn record_turn(&self, bot_id: &str) -> Result<()> {
        let mut registry = lock(&self.registry);
        let mut record = registry
            .get(bot_id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown bot {bot_id}"))?;
        record.last_turn_at = Some(now_ms());
        registry.put(record)
    }

    /// Adopt the guest session's live model and thinking into the record
    /// (from its `get_state` summary): the /bots row shows them, and the
    /// next create provisions the model's provider key. A summary without
    /// a model leaves the record alone. The read-modify-write sits under
    /// one registry lock, so a concurrent lifecycle save cannot resurrect
    /// a stale snapshot.
    ///
    /// # Errors
    /// Returns an error when the registry cannot be written.
    pub fn adopt_guest_model(&self, bot_id: &str, state: &Value) -> Result<()> {
        let Some((model, thinking)) = guest_model_choice(state) else {
            return Ok(());
        };
        let mut registry = lock(&self.registry);
        let Some(record) = registry.get(bot_id) else {
            return Ok(());
        };
        // A `"default"` (unset) level keeps the record's thinking: the
        // summary cannot tell a deliberate clear from never-set, and the
        // record's seeds a new session.
        let thinking = thinking.or_else(|| record.thinking.clone());
        if record.model == model && record.thinking == thinking {
            return Ok(());
        }
        let mut record = record.clone();
        record.model = model;
        record.thinking = thinking;
        registry.put(record)
    }

    /// Refuse a requested sandbox size above the owner's caps
    /// (`bots.maxCpu`, `bots.maxMemoryGb`), naming the cap, before any
    /// create runs.
    ///
    /// # Errors
    /// Returns an error when a requested size is above its cap, or the
    /// cap settings cannot be read.
    async fn assert_within_size_caps(
        &self,
        cpu: Option<u32>,
        memory_gb: Option<u32>,
    ) -> Result<()> {
        let agent_dir = self.agent_dir.clone();
        let (max_cpu, max_memory_gb) = tokio::task::spawn_blocking(move || {
            let settings = pa_core::settings::SettingsManager::create(&agent_dir, &agent_dir);
            (
                settings.get_bots_max_cpu(),
                settings.get_bots_max_memory_gb(),
            )
        })
        .await
        .context("the bots size-cap settings read failed")?;
        if let Some(cpu) = cpu.filter(|cpu| *cpu > max_cpu) {
            bail!(
                "the bot's cpu={cpu} exceeds bots.maxCpu {max_cpu}: lower cpu or raise \
                 bots.maxCpu in the daemon settings.json"
            );
        }
        if let Some(memory_gb) = memory_gb.filter(|memory_gb| *memory_gb > max_memory_gb) {
            bail!(
                "the bot's memory_gb={memory_gb} exceeds bots.maxMemoryGb {max_memory_gb}: \
                 lower memory_gb or raise bots.maxMemoryGb in the daemon settings.json"
            );
        }
        Ok(())
    }

    /// Provision a new bot: a running sandbox with this binary's exact
    /// version installed and the bot session open in the guest daemon. A
    /// failed spawn deletes what it created.
    ///
    /// # Errors
    /// Returns an error when provisioning, the install, or the bootstrap fails.
    pub async fn spawn(&self, spec: &BotSpec) -> Result<BotRecord> {
        let bot_lock = self.lock_for(&spec.bot_id);
        let _held = bot_lock.lock().await;
        if self.get(&spec.bot_id).is_some() {
            return self.ensure_running_locked(&spec.bot_id).await;
        }
        self.assert_within_size_caps(spec.cpu, spec.memory_gb)
            .await?;
        let label = bot_label(&spec.bot_id);
        let existing = retry(|| self.platform.list(&label)).await?;
        if existing.iter().any(|sandbox| !sandbox.status.is_terminal()) {
            bail!(
                "bot {} already has a sandbox but no record; restart the daemon to reconcile it",
                spec.bot_id
            );
        }
        self.save(BotRecord {
            bot_id: spec.bot_id.clone(),
            name: spec.name.clone(),
            owner_session_id: spec.owner_session_id.clone(),
            owner_active_session_id: None,
            sandbox_id: None,
            status: BotStatus::Creating,
            checkpoint_id: None,
            older_checkpoint_ids: Vec::new(),
            version: version::local_version().to_string(),
            model: spec.model.clone(),
            thinking: spec.thinking.clone(),
            created_at: now_ms(),
            last_turn_at: None,
            guest_session_id: String::new(),
            guest_session_file: None,
            generation: 0,
            github: spec.github,
            git_identity: spec.git_identity.clone(),
            logins: Vec::new(),
            pause_token: Some(uuid::Uuid::new_v4().simple().to_string()),
            pause_rule_host: None,
            bots: spec.bots,
            parent_bot_id: super::nested::NestedContext::read(&self.agent_dir)
                .map(|context| context.bot_id),
            pause_at: None,
            status_since: None,
            running_ms: 0,
            cpu: spec.cpu,
            memory_gb: spec.memory_gb,
        })?;
        if spec.bots {
            let mut spawns = read_spawns_marker(&self.agent_dir);
            spawns.insert(spec.bot_id.clone());
            write_spawns_marker(&self.agent_dir, &spawns)?;
        }
        match self.ensure_running_locked(&spec.bot_id).await {
            Ok(_) => self.record(&spec.bot_id),
            Err(error) => {
                if let Err(cleanup) = self.delete_locked(&spec.bot_id).await {
                    return Err(error.context(format!("cleanup also failed: {cleanup:#}")));
                }
                Err(error)
            }
        }
    }

    /// Make a bot run: resume it when paused, keep it when running, restore
    /// it from its newest durable checkpoint, or boot it fresh. Installs this
    /// binary's version when the guest runs another one.
    ///
    /// # Errors
    /// Returns an error for an unknown bot or when every path fails.
    pub async fn ensure_running(&self, bot_id: &str) -> Result<BotRecord> {
        let bot_lock = self.lock_for(bot_id);
        let _held = bot_lock.lock().await;
        self.ensure_running_locked(bot_id).await?;
        // The registry's copy carries the stamps `save` adds.
        self.record(bot_id)
    }

    /// Bring one bot the registry says runs to this binary's version, in
    /// place: [`BotRefresh::Refreshed`] holds the upgraded record. A bot
    /// whose record no longer says Running — it paused while this refresh
    /// waited for its lock — is [`BotRefresh::Skipped`]: it stays as it is
    /// and installs the version on its next wake. The platform is the
    /// source of truth for what runs now: a guest that self-paused or a
    /// sandbox that ended leaves a stale Running row, and refreshing only
    /// what runs means never waking or recreating it. The record is read
    /// under the bot's lock, so a pause that completes first is never
    /// undone.
    ///
    /// # Errors
    /// Returns an error for an unknown bot, a bot another bot's daemon
    /// owns, or a failed upgrade.
    pub async fn refresh_running(&self, bot_id: &str) -> Result<BotRefresh> {
        let bot_lock = self.lock_for(bot_id);
        let _held = bot_lock.lock().await;
        let record = self.record(bot_id)?;
        if !self.manages(&record) {
            bail!(
                "the bot {} belongs to another bot; its parent bot refreshes it",
                record.name
            );
        }
        if record.status != BotStatus::Running {
            return Ok(BotRefresh::Skipped(record));
        }
        // The probe never touches the registry: its mutations land on the
        // clone, and the refresh only reads what the platform says runs.
        let mut probe = record.clone();
        let live = self.resolve_existing(&mut probe).await?;
        if live.as_ref().map(|sandbox| sandbox.status) != Some(BotStatus::Running) {
            let mut skipped = record;
            skipped.status = live.map_or(BotStatus::Stopped, |sandbox| sandbox.status);
            return Ok(BotRefresh::Skipped(skipped));
        }
        let record = self.ensure_running_locked(bot_id).await?;
        Ok(BotRefresh::Refreshed(record))
    }

    /// Pause a bot. Records the pause checkpoint. When the platform refuses
    /// the pause, takes a durable checkpoint and deletes the sandbox.
    ///
    /// # Errors
    /// Returns an error for an unknown bot or a failed pause.
    pub async fn pause(&self, bot_id: &str) -> Result<BotRecord> {
        let bot_lock = self.lock_for(bot_id);
        let _held = bot_lock.lock().await;
        self.pause_locked(bot_id).await?;
        // The registry's copy carries the stamps `save` adds.
        self.record(bot_id)
    }

    async fn pause_locked(&self, bot_id: &str) -> Result<BotRecord> {
        let deadline = Instant::now() + OPERATION_BUDGET;
        let mut record = self.record(bot_id)?;
        let mut sandbox = self.resolve_existing(&mut record).await?;
        if let Some(found) = sandbox.take_if(|found| found.status == BotStatus::Creating) {
            sandbox = self.poll_until_running(&found.id, deadline).await?;
            if sandbox.is_none() {
                lose_sandbox(&mut record);
            }
        }
        let Some(sandbox) = sandbox else {
            record.sandbox_id = None;
            record.status = BotStatus::Stopped;
            self.save(record.clone())?;
            return Ok(record);
        };
        if sandbox.status == BotStatus::Running {
            match retry(|| self.platform.pause(&sandbox.id)).await {
                Ok(checkpoint) => {
                    if let Some(checkpoint) = checkpoint {
                        self.replace_checkpoint(&mut record, checkpoint).await?;
                    }
                    self.poll_until_paused(&sandbox, deadline).await?;
                }
                Err(PlatformError::Other(reason)) => {
                    eprintln!("pa-daemon: bot {bot_id}: pause refused ({reason}); checkpointing and deleting");
                    let checkpoint = self.platform.checkpoint(&sandbox.id).await?;
                    self.replace_checkpoint(&mut record, checkpoint.clone())
                        .await?;
                    self.platform.wait_checkpoint(&checkpoint).await?;
                    self.prune_checkpoints(&mut record).await?;
                    retry(|| self.platform.delete(&sandbox.id)).await?;
                    lose_sandbox(&mut record);
                    self.save(record.clone())?;
                    return Ok(record);
                }
                Err(error) => return Err(error).context("pause bot sandbox"),
            }
        }
        record.status = BotStatus::Paused;
        self.save(record.clone())?;
        Ok(record)
    }

    /// Delete every sandbox the bot's label names and its checkpoints, then
    /// forget the bot. A checkpoint that fails to delete is kept in the
    /// registry, and boot reconcile tries it again. Deleting an unknown bot succeeds.
    /// The bot's descendants go first, deepest first.
    ///
    /// # Errors
    /// Returns an error when a sandbox delete fails.
    pub async fn delete(&self, bot_id: &str) -> Result<()> {
        let bot_lock = self.lock_for(bot_id);
        let _held = bot_lock.lock().await;
        self.delete_descendants_locked(bot_id).await?;
        self.delete_locked(bot_id).await
    }

    /// Delete the bots `bot_id` spawned: the registry's children plus every
    /// sandbox the parent label names, so children this daemon never
    /// learned go too. Called with the parent's lock held; each child is
    /// settled under its own lock, so a concurrent delete of the child
    /// cannot interleave.
    async fn delete_descendants_locked(&self, bot_id: &str) -> Result<()> {
        // The guest can create a child while this delete runs, so the
        // sweep repeats until the parent label names nothing live: one
        // pass can miss a create that landed after its listing.
        for _ in 0..DESCENDANT_SWEEPS {
            let mut children: Vec<String> = lock(&self.registry)
                .all()
                .into_iter()
                .filter(|record| record.parent_bot_id.as_deref() == Some(bot_id))
                .map(|record| record.bot_id)
                .collect();
            let parent = super::parent_label(bot_id);
            for sandbox in retry(|| self.platform.list(&parent)).await? {
                if let Some(child) = label_value(&sandbox.labels, &format!("{BOT_LABEL}:")) {
                    children.push(child);
                }
            }
            children.sort();
            children.dedup();
            if children.is_empty() {
                return Ok(());
            }
            for child in children {
                let child_lock = self.lock_for(&child);
                let _held = child_lock.lock().await;
                Box::pin(self.delete_descendants_locked(&child)).await?;
                self.delete_locked(&child).await?;
            }
        }
        let parent = super::parent_label(bot_id);
        let left = retry(|| self.platform.list(&parent))
            .await?
            .into_iter()
            .filter(|sandbox| !sandbox.status.is_terminal())
            .count();
        if left > 0 {
            bail!(
                "bot {bot_id}: {left} descendant sandboxes survived the delete sweeps; \
                 retry the delete"
            );
        }
        Ok(())
    }

    /// The bots of `owner_session_id` this daemon can see: its registry's
    /// records plus every sandbox the owner label names (children another
    /// daemon spawned).
    ///
    /// # Errors
    /// Returns an error when the label listing fails.
    pub async fn owner_bot_ids(&self, owner_session_id: &str) -> Result<BTreeSet<String>> {
        // A merged child's record names its parent bot's guest session as
        // the owner; the parent's record names this owner. Both count, so
        // a stopped child with a checkpoint still holds a cap slot.
        let records = lock(&self.registry).all();
        let owners: BTreeMap<String, String> = records
            .iter()
            .map(|record| (record.bot_id.clone(), record.owner_session_id.clone()))
            .collect();
        let mut bot_ids: BTreeSet<String> = records
            .into_iter()
            .filter(|record| {
                record.owner_session_id == owner_session_id
                    || record
                        .parent_bot_id
                        .as_deref()
                        .and_then(|parent| owners.get(parent))
                        .is_some_and(|owner| *owner == owner_session_id)
            })
            .map(|record| record.bot_id)
            .collect();
        let label = owner_label(owner_session_id);
        for sandbox in retry(|| self.platform.list(&label)).await? {
            // A terminated sandbox is a deleted bot: it must not keep
            // counting against the owner's bots.maxBots cap.
            if sandbox.status.is_terminal() {
                continue;
            }
            if let Some(bot_id) = label_value(&sandbox.labels, &format!("{BOT_LABEL}:")) {
                bot_ids.insert(bot_id);
            }
        }
        Ok(bot_ids)
    }

    /// Merge a bot's children (its daemon's `list_bots` rows) into this
    /// registry: each row upserts, a child that vanished from the rows is
    /// deleted (the bot deleted it itself). A row without a sandbox or
    /// checkpoint never provisioned and is skipped.
    ///
    /// # Errors
    /// Returns an error when a vanished child cannot be deleted or the
    /// registry cannot be written.
    pub async fn merge_children(&self, parent_bot_id: &str, rows: &[Value]) -> Result<()> {
        // Under the parent's lifecycle lock, in lock order with the delete
        // cascade, and never for a parent that is already gone: a stale
        // guest snapshot must not resurrect children the cascade removed.
        let parent_lock = self.lock_for(parent_bot_id);
        let _held = parent_lock.lock().await;
        if self.get(parent_bot_id).is_none() {
            return Ok(());
        }
        let mut seen = BTreeSet::new();
        for row in rows {
            // A row names this parent's child only when it says so, and
            // only when its bot id is not already another bot's record:
            // the rows come from the guest, so they never get to claim a
            // bot this daemon owns outright.
            let claims_parent = row
                .get("parentBotId")
                .and_then(Value::as_str)
                .is_none_or(|parent| parent == parent_bot_id);
            let existing = self.get_from_row(row);
            let foreign = existing
                .as_ref()
                .is_some_and(|record| record.parent_bot_id.as_deref() != Some(parent_bot_id));
            if !claims_parent || foreign {
                continue;
            }
            let Some(record) = child_record(row, parent_bot_id, existing) else {
                continue;
            };
            seen.insert(record.bot_id.clone());
            lock(&self.registry).put(record)?;
        }
        let vanished: Vec<String> = lock(&self.registry)
            .all()
            .into_iter()
            .filter(|record| {
                record.parent_bot_id.as_deref() == Some(parent_bot_id)
                    && !seen.contains(&record.bot_id)
            })
            .map(|record| record.bot_id)
            .collect();
        for bot_id in vanished {
            // An older guest snapshot omits a child that still runs; the
            // platform listing is the truth, so a live child is kept and
            // only its stale registry row waits for the next sync.
            let label = bot_label(&bot_id);
            let live = retry(|| self.platform.list(&label))
                .await?
                .into_iter()
                .any(|sandbox| !sandbox.status.is_terminal());
            if live {
                continue;
            }
            let bot_lock = self.lock_for(&bot_id);
            let _held = bot_lock.lock().await;
            self.delete_locked(&bot_id).await?;
        }
        Ok(())
    }

    /// The registry record a row's bot id already has, when it does.
    fn get_from_row(&self, row: &Value) -> Option<BotRecord> {
        lock(&self.registry)
            .get(row.get("botId")?.as_str()?)
            .cloned()
    }

    /// Give a running bot the ability to spawn bots without a respawn: the
    /// platform secret and header rule that inject the owner's sandbox API
    /// key, the guest settings and nested context, and the record flag.
    /// The whole network policy is replaced, so the current plan's rules
    /// are rebuilt and kept, with the sandbox API rule added.
    ///
    /// # Errors
    /// Returns an error for an unknown or not running bot, or when the
    /// rule, the guest write, or the registry write fails.
    pub async fn allow_spawns(&self, bot_id: &str) -> Result<BotRecord> {
        let bot_lock = self.lock_for(bot_id);
        let _held = bot_lock.lock().await;
        let mut record = self.record(bot_id)?;
        let sandbox_id = record
            .sandbox_id
            .clone()
            .context("the bot has no sandbox")?;
        if record.status != BotStatus::Running {
            bail!(
                "the bot {} is {}; only a running bot can be given bot spawns",
                record.name,
                record.status.as_str()
            );
        }
        if record.parent_bot_id.is_some() {
            bail!(
                "the bot {} is itself a bot's child; bots nest two levels deep \
                 (owner -> bot -> bot), so it cannot be given bot spawns",
                record.name
            );
        }
        record.bots = true;
        // The platform labels are fixed at create, so the durable marker
        // next to the registry carries the flag for a rebuild.
        let mut spawns = read_spawns_marker(&self.agent_dir);
        spawns.insert(bot_id.to_string());
        write_spawns_marker(&self.agent_dir, &spawns)?;
        // The merged policy: the current plan's rules plus the sandbox API
        // rule (the plan is what every /secrets refresh would set).
        let (credentials, logins, _) = self.guest_credentials(&record, record.github).await?;
        retry(|| {
            self.platform
                .set_network_rules(&sandbox_id, &credentials.network_rules)
        })
        .await?;
        // The refresher follows the logins the new rules carry, so a newly
        // injected login keeps refreshing (as `refresh_network_rules` does).
        record.logins = logins;
        if !record.logins.is_empty() {
            self.refresh_logins(&record).await;
            self.watch_logins();
        }
        let agent_dir = self.agent_dir.clone();
        let max_bots = tokio::task::spawn_blocking(move || {
            pa_core::settings::SettingsManager::create(&agent_dir, &agent_dir).get_bots_max_bots()
                as usize
        })
        .await
        .context("the bots.maxBots read failed")?;
        let context = super::nested::NestedContext {
            bot_id: record.bot_id.clone(),
            owner_session_id: record.owner_session_id.clone(),
            depth: 1,
            max_bots,
            network_rules: credentials.network_rules.clone(),
        };
        let team = self.sandbox_key_and_team().await?.1;
        let prime = serde_json::to_value(pa_core::auth::AuthCredential::ApiKey {
            key: super::credentials::GUEST_API_KEY_PLACEHOLDER.to_string(),
            prime_team: team,
        })?;
        let env = BTreeMap::from([
            (
                "BOT_NESTED_JSON".to_string(),
                serde_json::to_string(&context)?,
            ),
            ("BOT_PRIME_RECORD".to_string(), prime.to_string()),
        ]);
        let output = self
            .exec_ready(
                &sandbox_id,
                ALLOW_SPAWNS_SCRIPT,
                &env,
                None,
                Instant::now() + OPERATION_BUDGET,
            )
            .await?;
        check_exit("write the bot's spawn settings", &output)?;
        self.save(record.clone())?;
        Ok(record)
    }

    /// Rebuild the cache from labels: newest live sandbox per bot wins, the
    /// others are deleted; a lost registry record is rebuilt from the labels;
    /// a record whose sandbox is gone becomes `Stopped`. A bot this registry
    /// never held is rebuilt only when its owner label names a session of
    /// this agent dir: the team account carries every agent dir's bots, and a
    /// foreign bot is never adopted, paused, or deleted here.
    ///
    /// # Errors
    /// Returns an error when listing or a duplicate delete fails.
    pub async fn reconcile_on_boot(&self) -> Result<()> {
        let agent_dir = self.agent_dir.clone();
        let owned_sessions = tokio::task::spawn_blocking(move || agent_dir_sessions(&agent_dir))
            .await
            .context("read this agent dir's sessions")?;
        let mut bot_ids = BTreeSet::new();
        // Inside a bot, the listing scope is this bot's children only: the
        // owner's own bots belong to another daemon's registry.
        let nested = super::nested::NestedContext::read(&self.agent_dir);
        let scope = nested.as_ref().map_or_else(
            || BOT_LABEL.to_string(),
            |context| super::parent_label(&context.bot_id),
        );
        for sandbox in retry(|| self.platform.list(&scope)).await? {
            if sandbox.status.is_terminal() {
                continue;
            }
            let Some(bot_id) = label_value(&sandbox.labels, &format!("{BOT_LABEL}:")) else {
                continue;
            };
            // A bot this registry never held is adopted only when its owner
            // label names a session of this agent dir. Another agent dir's
            // bot on the same team, or one without an owner label, is left
            // entirely alone: never adopted, paused, or deleted. Inside a
            // bot, the nested context names the owner its children's labels
            // carry: that match is trusted without a provable session.
            if self.get(&bot_id).is_none()
                && !label_value(&sandbox.labels, &format!("{BOT_LABEL}-owner:")).is_some_and(
                    |owner| {
                        nested
                            .as_ref()
                            .is_some_and(|context| context.owner_session_id == owner)
                            || owned_sessions.contains(&owner)
                    },
                )
            {
                continue;
            }
            bot_ids.insert(bot_id);
        }
        // Wakes and deletes may run meanwhile: each bot is settled under its
        // lock, against a fresh listing and a fresh read of its record.
        let mut settled = BTreeSet::new();
        for bot_id in bot_ids {
            let bot_lock = self.lock_for(&bot_id);
            let _held = bot_lock.lock().await;
            let label = bot_label(&bot_id);
            let mut sandboxes: Vec<BotSandbox> = retry(|| self.platform.list(&label))
                .await?
                .into_iter()
                .filter(|sandbox| !sandbox.status.is_terminal() && sandbox.labels.contains(&label))
                .collect();
            sort_newest_first(&mut sandboxes);
            let Some(chosen) = sandboxes.first() else {
                continue;
            };
            for extra in &sandboxes[1..] {
                eprintln!(
                    "pa-daemon: bot {bot_id}: deleting duplicate sandbox {}",
                    extra.id
                );
                retry(|| self.platform.delete(&extra.id)).await?;
            }
            let mut record = self
                .get(&bot_id)
                .unwrap_or_else(|| rebuilt_record(&bot_id, chosen));
            if record.parent_bot_id.is_none()
                && read_spawns_marker(&self.agent_dir).contains(&bot_id)
            {
                record.bots = true;
            }
            record.sandbox_id = Some(chosen.id.clone());
            record.status = chosen.status;
            self.save_observed(record)?;
            settled.insert(bot_id);
        }
        for listed in self.list() {
            if settled.contains(&listed.bot_id) {
                continue;
            }
            let bot_lock = self.lock_for(&listed.bot_id);
            let _held = bot_lock.lock().await;
            let Some(mut record) = self.get(&listed.bot_id) else {
                continue;
            };
            let Some(sandbox_id) = record.sandbox_id.clone() else {
                continue;
            };
            match self.platform.get(&sandbox_id).await {
                Ok(sandbox) if !sandbox.status.is_terminal() => record.status = sandbox.status,
                Ok(_) | Err(PlatformError::NotFound(_)) => lose_sandbox(&mut record),
                Err(error) => return Err(error.into()),
            }
            self.save_observed(record)?;
        }
        let orphans = lock(&self.registry).orphans();
        self.delete_orphans(orphans).await
    }

    fn lock_for(&self, bot_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        Arc::clone(lock(&self.locks).entry(bot_id.to_string()).or_default())
    }

    fn record(&self, bot_id: &str) -> Result<BotRecord> {
        self.get(bot_id)
            .ok_or_else(|| anyhow!("unknown bot {bot_id}"))
    }

    /// Persist `record`. A lifecycle operation saves a snapshot taken before
    /// its awaits, so a newer settled-turn time from [`Self::record_turn`] wins.
    /// A status change stamps `status_since`, and a running interval that ends
    /// adds to `running_ms`. The model and thinking merge from the current
    /// record: only the guest-model adoption changes them, under the registry
    /// lock, so a stale snapshot never reverts an adopted choice. The bots
    /// tests drive a stale snapshot through it.
    pub(super) fn save(&self, record: BotRecord) -> Result<()> {
        self.save_closing(record, false)
    }

    /// Persist a status this daemon observed on the platform, not one it
    /// set. A running interval that ended off-process (a self-pause while
    /// this daemon was down, a lost sandbox) ends at the idle grace after
    /// the bot's last known activity, not now.
    fn save_observed(&self, record: BotRecord) -> Result<()> {
        self.save_closing(record, true)
    }

    fn save_closing(&self, mut record: BotRecord, observed: bool) -> Result<()> {
        let mut registry = lock(&self.registry);
        let now = now_ms();
        let current = registry.get(&record.bot_id);
        if let Some(current) = current {
            record.last_turn_at = record.last_turn_at.max(current.last_turn_at);
            // The model and thinking change only through the guest-model
            // adoption, which writes under this lock: a lifecycle snapshot
            // taken before an adoption must not overwrite the adopted
            // choice with the stale one.
            record.model.clone_from(&current.model);
            record.thinking.clone_from(&current.thinking);
        }
        (record.status_since, record.running_ms) = match current {
            // A record from before the stamp counts from its first save.
            Some(current) if current.status == record.status => {
                (current.status_since.or(Some(now)), current.running_ms)
            }
            Some(current) => {
                let end = if observed && current.status == BotStatus::Running {
                    let grace =
                        i64::try_from(super::replies::PAUSE_GRACE.as_millis()).unwrap_or(i64::MAX);
                    current
                        .status_since
                        .max(current.last_turn_at)
                        .map_or(now, |active| active.saturating_add(grace).min(now))
                } else {
                    now
                };
                (Some(end), current.running_ms_at(end))
            }
            None => (Some(now), 0),
        };
        registry.put(record)
    }

    async fn ensure_running_locked(&self, bot_id: &str) -> Result<BotRecord> {
        let deadline = Instant::now() + OPERATION_BUDGET;
        let mut record = self.record(bot_id)?;
        // A relay-configured wake gives a bot without a pause token one
        // (a record rebuilt from labels); the save below the wake
        // persists it. A relay whose host the sandbox's rules do not
        // carry — configured after the spawn, changed, or a record
        // rebuilt from labels — gets its rule pushed below.
        let relay_host = self.relay_settings().await.rule_host();
        if relay_host.is_some() && record.pause_token.is_none() {
            record.pause_token = Some(uuid::Uuid::new_v4().simple().to_string());
        }
        let woken = match self.resolve_existing(&mut record).await? {
            Some(sandbox) => {
                let woken = self.wake(sandbox, deadline).await?;
                if woken.is_none() {
                    lose_sandbox(&mut record);
                }
                woken
            }
            None => None,
        };
        let reused = woken.is_some();
        let sandbox = match woken {
            Some(sandbox) => sandbox,
            None => self.acquire_new(&mut record, deadline).await?,
        };
        record.sandbox_id = Some(sandbox.id.clone());
        record.status = BotStatus::Running;
        self.save(record.clone())?;
        // A reused sandbox whose rules predate the relay gets fresh ones
        // before the bootstrap arms the guest's self-pause; without them
        // every pause request would authenticate with the placeholder
        // and fail. A sandbox this wake created already carries the rule
        // (its create applied the fresh credentials). A failed push
        // leaves the stale marker, so the next wake retries.
        if relay_host.is_some() && record.pause_rule_host != relay_host && reused {
            // Best effort, like the registration: a credentials failure
            // must not block the wake (the sandbox keeps its old rules
            // and stays usable); the stale marker makes the next wake
            // retry the push.
            if let Err(error) = self.push_relay_rules(&mut record, &sandbox).await {
                eprintln!(
                    "pa-daemon: bots: {}: the relay rules push failed: {error:#}",
                    record.name
                );
            }
        }
        // A resumed bot gets a fresh token before its first request.
        self.refresh_logins(&record).await;
        self.install_and_bootstrap(&mut record, deadline).await?;
        self.save(record.clone())?;
        Ok(record)
    }

    /// Push `record`'s fresh credentials — the relay pause rule included —
    /// to its running sandbox, and follow the logins the new rules carry.
    /// The record marks the relay host the pushed rules carry, so the
    /// next wake pushes only when it changes again.
    async fn push_relay_rules(&self, record: &mut BotRecord, sandbox: &BotSandbox) -> Result<()> {
        let (credentials, logins, relay_host) =
            self.guest_credentials(record, record.github).await?;
        retry(|| {
            self.platform
                .set_network_rules(&sandbox.id, &credentials.network_rules)
        })
        .await?;
        record.logins = logins;
        record.pause_rule_host = relay_host;
        Ok(())
    }

    /// The bot's live sandbox: the cached id when it is live, else the
    /// newest live labeled sandbox (deleting the others).
    async fn resolve_existing(&self, record: &mut BotRecord) -> Result<Option<BotSandbox>> {
        let mut lost = false;
        if let Some(sandbox_id) = record.sandbox_id.clone() {
            match self.platform.get(&sandbox_id).await {
                Ok(sandbox) if !sandbox.status.is_terminal() => {
                    if record.status == BotStatus::Running && sandbox.status != BotStatus::Running {
                        record.status = sandbox.status;
                        self.save_observed(record.clone())?;
                    }
                    return Ok(Some(sandbox));
                }
                Ok(sandbox) if sandbox.status == BotStatus::Error => {
                    retry(|| self.platform.delete(&sandbox_id)).await?;
                    lose_sandbox(record);
                    lost = true;
                }
                Ok(_) | Err(PlatformError::NotFound(_)) => {
                    lose_sandbox(record);
                    lost = true;
                }
                Err(error) => return Err(error.into()),
            }
        }
        let label = bot_label(&record.bot_id);
        let mut live: Vec<BotSandbox> = retry(|| self.platform.list(&label))
            .await?
            .into_iter()
            .filter(|sandbox| !sandbox.status.is_terminal() && sandbox.labels.contains(&label))
            .collect();
        sort_newest_first(&mut live);
        for extra in live.iter().skip(1) {
            eprintln!(
                "pa-daemon: bot {}: deleting duplicate sandbox {}",
                record.bot_id, extra.id
            );
            retry(|| self.platform.delete(&extra.id)).await?;
        }
        let found = live.into_iter().next();
        match &found {
            Some(sandbox) => {
                record.sandbox_id = Some(sandbox.id.clone());
                let was_running = self
                    .get(&record.bot_id)
                    .is_some_and(|current| current.status == BotStatus::Running);
                if was_running && sandbox.status != BotStatus::Running {
                    record.status = sandbox.status;
                    self.save_observed(record.clone())?;
                }
            }
            // No sandbox runs the bot: a running interval ended off-process.
            None if lost => self.save_observed(record.clone())?,
            None => {}
        }
        Ok(found)
    }

    /// Bring an existing sandbox to `Running`; `None` when it died.
    async fn wake(&self, sandbox: BotSandbox, deadline: Instant) -> Result<Option<BotSandbox>> {
        match sandbox.status {
            BotStatus::Running => Ok(Some(sandbox)),
            BotStatus::Paused => self.resume_until_running(&sandbox, deadline).await,
            _ => self.poll_until_running(&sandbox.id, deadline).await,
        }
    }

    async fn resume_until_running(
        &self,
        sandbox: &BotSandbox,
        deadline: Instant,
    ) -> Result<Option<BotSandbox>> {
        let mut baseline = match retry(|| self.platform.resume(&sandbox.id)).await {
            Ok(resumed) if resumed.status == BotStatus::Running => return Ok(Some(resumed)),
            Ok(resumed) => resumed.error_message,
            Err(PlatformError::NotFound(_)) => return Ok(None),
            Err(error) => return Err(error).context("resume bot sandbox"),
        };
        let mut retried = false;
        let started = Instant::now();
        loop {
            let current = match self.platform.get(&sandbox.id).await {
                Ok(current) => current,
                Err(PlatformError::NotFound(_)) => return Ok(None),
                Err(PlatformError::Transient(_) | PlatformError::Conflict(_)) => {
                    sleep_poll(started, deadline).await?;
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            match current.status {
                BotStatus::Running => return Ok(Some(current)),
                status if status.is_terminal() => return Ok(None),
                BotStatus::Paused
                    if current.error_message.is_some() && current.error_message != baseline =>
                {
                    if retried {
                        bail!(
                            "bot sandbox {} did not resume: {}",
                            sandbox.id,
                            current.error_message.unwrap_or_default()
                        );
                    }
                    retried = true;
                    let again = retry(|| self.platform.resume(&sandbox.id)).await?;
                    if again.status == BotStatus::Running {
                        return Ok(Some(again));
                    }
                    baseline = again.error_message;
                }
                _ => {}
            }
            sleep_poll(started, deadline).await?;
        }
    }

    async fn poll_until_running(
        &self,
        sandbox_id: &str,
        deadline: Instant,
    ) -> Result<Option<BotSandbox>> {
        let started = Instant::now();
        loop {
            match self.platform.get(sandbox_id).await {
                Ok(current) if current.status == BotStatus::Running => return Ok(Some(current)),
                Ok(current) if current.status.is_terminal() => return Ok(None),
                Err(PlatformError::NotFound(_)) => return Ok(None),
                Ok(_) | Err(PlatformError::Transient(_) | PlatformError::Conflict(_)) => {}
                Err(error) => return Err(error.into()),
            }
            sleep_poll(started, deadline).await?;
        }
    }

    async fn poll_until_paused(&self, sandbox: &BotSandbox, deadline: Instant) -> Result<()> {
        let started = Instant::now();
        loop {
            let current = retry(|| self.platform.get(&sandbox.id)).await?;
            match current.status {
                BotStatus::Paused => return Ok(()),
                status if status.is_terminal() => {
                    bail!("bot sandbox {} ended while pausing", sandbox.id)
                }
                BotStatus::Running
                    if current.error_message.is_some()
                        && current.error_message != sandbox.error_message =>
                {
                    bail!(
                        "bot sandbox {} did not pause: {}",
                        sandbox.id,
                        current.error_message.unwrap_or_default()
                    );
                }
                _ => {}
            }
            sleep_poll(started, deadline).await?;
        }
    }

    /// Make the platform's newest durable checkpoint for the bot the
    /// restore head. An outside pause (the relay's self-pause) freezes
    /// checkpoints this daemon never records, so when the sandbox later
    /// ends the recorded head may be stale, and a restore from it would
    /// roll the bot back. A failed or empty query leaves the record
    /// alone, and so does a head that is still uploading and newer than
    /// the winner: that head keeps its place and the winner joins the
    /// older list behind it. The winner is recorded without pruning, so
    /// a failed restore keeps the older ones to fall back to; the
    /// successful restore prunes what it supersedes.
    async fn prefer_platform_checkpoint(&self, record: &mut BotRecord) {
        let label = bot_label(&record.bot_id);
        let listed = match retry(|| self.platform.list_checkpoints(&label)).await {
            Ok(listed) => listed,
            Err(error) => {
                eprintln!(
                    "pa-daemon: bot {}: checkpoint list failed ({error}); using the recorded ones",
                    record.bot_id
                );
                return;
            }
        };
        let mut newest: Option<&BotCheckpoint> = None;
        for checkpoint in &listed {
            if !checkpoint.durable {
                continue;
            }
            if newest.is_none_or(|found| checkpoint_millis(checkpoint) > checkpoint_millis(found)) {
                newest = Some(checkpoint);
            }
        }
        let Some(newest) = newest else {
            return;
        };
        if record.checkpoint_id.as_deref() == Some(newest.id.as_str()) {
            return;
        }
        // A pending head may still be uploading and hold newer state than
        // the newest durable checkpoint: it stays the head, and the winner
        // joins the older list behind it. The head is never demoted to
        // where prune would delete it, and the wake still restores from
        // the winner.
        let head_pending_newer = record
            .checkpoint_id
            .as_deref()
            .and_then(|head| listed.iter().find(|checkpoint| checkpoint.id == head))
            .is_some_and(|head| {
                !head.durable && checkpoint_millis(head) > checkpoint_millis(newest)
            });
        if head_pending_newer {
            if !record.older_checkpoint_ids.contains(&newest.id) {
                // Insert at the chronological position: a pending snapshot
                // already in the list may be newer in time, and the list
                // must stay oldest-first or a later prune mistakes that
                // newer pending one for an older stale one.
                let millis = checkpoint_millis(newest);
                let position = record
                    .older_checkpoint_ids
                    .iter()
                    .position(|id| {
                        listed
                            .iter()
                            .find(|checkpoint| checkpoint.id == *id)
                            .is_some_and(|checkpoint| checkpoint_millis(checkpoint) > millis)
                    })
                    .unwrap_or(record.older_checkpoint_ids.len());
                record
                    .older_checkpoint_ids
                    .insert(position, newest.id.clone());
                if let Err(error) = self.save(record.clone()) {
                    eprintln!(
                        "pa-daemon: bot {}: could not record the newest platform checkpoint: {error:#}",
                        record.bot_id
                    );
                }
            }
            return;
        }
        // The winner may already sit in the older list (the recorded head
        // never became durable): it must exist once, as the head. The
        // winner is recorded without pruning: the restore may still fail
        // and fall back to the older ones, so they must outlive it. The
        // successful restore prunes what it supersedes.
        record.older_checkpoint_ids.retain(|id| id != &newest.id);
        if let Some(old) = record.checkpoint_id.replace(newest.id.clone()) {
            record.older_checkpoint_ids.push(old);
        }
        if let Err(error) = self.save(record.clone()) {
            eprintln!(
                "pa-daemon: bot {}: could not record the newest platform checkpoint: {error:#}",
                record.bot_id
            );
        }
    }

    /// A new sandbox: restored from the newest durable checkpoint the
    /// platform reports for the bot (an outside pause may have frozen one
    /// this daemon never recorded), else from the recorded ones, else
    /// booted from the image. A restore that may still be booting keeps
    /// the checkpoint and fails, so the next wake finds that sandbox.
    async fn acquire_new(&self, record: &mut BotRecord, deadline: Instant) -> Result<BotSandbox> {
        self.prefer_platform_checkpoint(record).await;
        let candidates: Vec<String> = record
            .checkpoint_id
            .iter()
            .chain(record.older_checkpoint_ids.iter().rev())
            .cloned()
            .collect();
        for checkpoint in candidates {
            if !self.platform.checkpoint_durable(&checkpoint).await? {
                continue;
            }
            match self.create(record, Some(&checkpoint), deadline).await {
                Ok(sandbox) => {
                    // The restore succeeded: everything older than it is
                    // superseded. A promotion defers its prune to here,
                    // because the restore may fall back past the newest
                    // durable one; a bot paused only by its guest never
                    // prunes on its own.
                    if let Err(error) = self.prune_before(record, &checkpoint).await {
                        eprintln!(
                            "pa-daemon: bot {}: checkpoint prune failed: {error:#}",
                            record.bot_id
                        );
                    }
                    return Ok(sandbox);
                }
                // The restore may exist (still booting, or its create reply was
                // lost): keep the checkpoint and let the next wake find it.
                Err(error) if record.sandbox_id.is_some() || is_transient(&error) => {
                    return Err(error)
                }
                Err(error) => {
                    eprintln!(
                        "pa-daemon: bot {}: checkpoint restore failed: {error:#}",
                        record.bot_id
                    );
                }
            }
        }
        self.create(record, None, deadline).await
    }

    async fn create(
        &self,
        record: &mut BotRecord,
        checkpoint_id: Option<&str>,
        deadline: Instant,
    ) -> Result<BotSandbox> {
        let source = match checkpoint_id {
            Some(checkpoint) => format!("ckpt:disk:{checkpoint}"),
            None => format!("img:{}", self.image),
        };
        let (credentials, logins, relay_host) =
            self.guest_credentials(record, record.github).await?;
        record.logins = logins;
        // The created sandbox's rules are the fresh credentials'; mark
        // the relay host they carry, so a later wake pushes only when
        // the relay changes.
        record.pause_rule_host = relay_host;
        // Inside a bot, the labels name the Mac owner (so its bot list and
        // bots.maxBots count the children) and the spawning bot (so the
        // tree and the delete cascade find them).
        let nested = super::nested::NestedContext::read(&self.agent_dir);
        let owner = nested.as_ref().map_or(&record.owner_session_id, |context| {
            &context.owner_session_id
        });
        let mut labels = vec![
            BOT_LABEL.to_string(),
            bot_label(&record.bot_id),
            owner_label(owner),
        ];
        if let Some(context) = &nested {
            labels.push(super::parent_label(&context.bot_id));
        }
        if record.bots {
            labels.push(super::BOTS_LABEL.to_string());
        }
        if record.github {
            labels.push(GITHUB_LABEL.to_string());
        }
        labels.extend(record.logins.iter().map(|provider| login_label(provider)));
        let request = BotCreate {
            name: record.name.clone(),
            image: self.image.clone(),
            labels,
            idempotency_key: idempotency_key(&record.bot_id, record.generation, &source),
            checkpoint_id: checkpoint_id.map(str::to_string),
            network_rules: credentials.network_rules.clone(),
            cpu: record.cpu,
            memory_gb: record.memory_gb,
        };
        let created = retry(|| self.platform.create(&request)).await?;
        lock(&self.guest_auth).insert(created.id.clone(), credentials);
        record.sandbox_id = Some(created.id.clone());
        record.status = created.status;
        self.save(record.clone())?;
        if created.status == BotStatus::Running {
            return Ok(created);
        }
        if let Some(running) = self.poll_until_running(&created.id, deadline).await? {
            return Ok(running);
        }
        retry(|| self.platform.delete(&created.id)).await?;
        lose_sandbox(record);
        self.save(record.clone())?;
        bail!("bot sandbox {} ended before it ran", created.id)
    }

    /// Install this binary's version when the guest runs another one, then
    /// start the guest daemon and open the bot session.
    async fn install_and_bootstrap(&self, record: &mut BotRecord, deadline: Instant) -> Result<()> {
        let sandbox_id = record.sandbox_id.clone().context("bot has no sandbox")?;
        let local = version::local_version();
        // Resolved per install, not cached at manager creation: a tarball
        // placed next to the binary after the daemon started is used.
        let source = ReleaseSource::resolve();
        let no_env = BTreeMap::new();
        let guest = self
            .exec_ready(
                &sandbox_id,
                version::GUEST_VERSION_SCRIPT,
                &no_env,
                None,
                deadline,
            )
            .await?;
        if guest.stdout.trim() != local {
            let install = Install::prepare(local, &source)?;
            let mut env: BTreeMap<String, String> = install.env.into_iter().collect();
            // The install stops a guest daemon that runs another version.
            env.insert(
                "PRIME_AGENT_DAEMON_SOCKET".to_string(),
                super::GUEST_DAEMON_SOCKET.to_string(),
            );
            // One multipart request carries a local tarball. The exec stream
            // stays as the fallback: a guest whose gateway has no transfer
            // endpoint must still get the build.
            let mut stdin = None;
            if let Some(bytes) = install.tarball.as_deref() {
                match self
                    .platform
                    .upload(&sandbox_id, Install::UPLOAD_PATH, bytes)
                    .await
                {
                    Ok(()) => {
                        env.insert(
                            "PA_TARBALL_PATH".to_string(),
                            Install::UPLOAD_PATH.to_string(),
                        );
                    }
                    Err(error) => {
                        eprintln!(
                            "pa-daemon: bot {}: tarball upload failed, using the exec stream: {error}",
                            record.name
                        );
                        stdin = Some(bytes);
                    }
                }
            }
            let output = self
                .exec_ready(&sandbox_id, version::INSTALL_SCRIPT, &env, stdin, deadline)
                .await?;
            if let Some(message) = version::install_failure(output.exit_code, local) {
                bail!(message);
            }
            check_exit("install prime-agent in the bot", &output)?;
        }
        record.version = local.to_string();
        let guest_already_local = guest.stdout.trim() == local;
        let agent_dir = self.agent_dir.clone();
        // A record rebuilt from labels carries no git author: fall back to
        // the owner's (`bots.gitIdentity`, else this machine's git author)
        // so a cold boot still commits as the owner. The relay self-pause
        // settings and the bot-list cap ride the same blocking read.
        let missing_identity = record.git_identity.is_none();
        let (factory_enabled, identity, self_pause, max_bots) =
            tokio::task::spawn_blocking(move || {
                let settings = pa_core::settings::SettingsManager::create(&agent_dir, &agent_dir);
                let identity = missing_identity
                    .then(|| super::github::git_identity(&agent_dir))
                    .flatten();
                (
                    settings.get_factory_enabled(),
                    identity,
                    SelfPauseSettings::read(&agent_dir),
                    settings.get_bots_max_bots() as usize,
                )
            })
            .await
            .context("the factory settings read failed")?;
        if record.git_identity.is_none() {
            record.git_identity = identity;
        }
        // The relay must know the bot's pause token before the guest can
        // ask for its pause; a failure is retried at the next wake.
        self.register_pause_token(&self_pause, record).await;
        let mut env = bootstrap_env(record, &self_pause);
        env.insert(
            "BOT_FACTORY_ENABLED".to_string(),
            factory_enabled.to_string(),
        );
        // A sandbox created by this process gets the auth that matches its
        // header rules. Any other sandbox keeps its auth.json, and gets one
        // only when it has none (its create ran before a restart).
        let created_here = lock(&self.guest_auth).get(&sandbox_id).cloned();
        let guest = match created_here {
            Some(guest) => {
                env.insert("BOT_AUTH_OVERWRITE".to_string(), "1".to_string());
                // Only a sandbox created with these header rules gets the
                // matching MCP entries; another one keeps its old ones.
                if let Some(servers) = &guest.mcp_servers {
                    env.insert("BOT_MCP_SERVERS".to_string(), servers.to_string());
                }
                if let Some(connections) = &guest.mcp_connections {
                    env.insert("BOT_MCP_CONNECTIONS".to_string(), connections.to_string());
                }
                Some(guest)
            }
            // Best effort: the sandbox's rules are already set. The bot's
            // own GitHub flag decides its rules, so a reused bot's nested
            // context keeps the GitHub rules its children inherit.
            None => self
                .guest_credentials(record, record.github)
                .await
                .ok()
                .map(|(credentials, _, _)| credentials),
        };
        if let Some(auth) = guest.as_ref().and_then(|guest| guest.auth_json.as_ref()) {
            env.insert("BOT_AUTH_JSON".to_string(), auth.to_string());
        }
        if record.bots {
            // The nested-spawn context: the guest writes it next to its
            // registry, so its daemon can hand it to spawns and
            // `bots allow-spawns` can add it to a running bot.
            if let Some(guest) = guest.as_ref() {
                let context = super::nested::NestedContext {
                    bot_id: record.bot_id.clone(),
                    owner_session_id: record.owner_session_id.clone(),
                    depth: 1,
                    max_bots,
                    network_rules: guest.network_rules.clone(),
                };
                env.insert(
                    "BOT_NESTED_JSON".to_string(),
                    serde_json::to_string(&context)?,
                );
            }
        }
        // A local tarball install keeps its copy in the guest, so a bot
        // that spawns bots installs the same build into its children. A
        // wake that skipped the install (the guest already runs this
        // version) still verifies the copy exists: a sandbox restored
        // from an older checkpoint may have lost it.
        if let ReleaseSource::LocalTarball(path) = &source {
            let installed = guest_already_local;
            let guest_path = version::guest_tarball_path(local);
            if installed {
                let check_env =
                    BTreeMap::from([("PA_GUEST_TARBALL".to_string(), guest_path.clone())]);
                let check = self
                    .exec_ready(
                        &sandbox_id,
                        version::TARBALL_CHECK_SCRIPT,
                        &check_env,
                        None,
                        deadline,
                    )
                    .await;
                if !matches!(&check, Ok(output) if output.exit_code == 0) {
                    let bytes = std::fs::read(path)?;
                    let restore_env = BTreeMap::from([
                        ("PA_GUEST_TARBALL".to_string(), guest_path.clone()),
                        ("PA_TARBALL_BYTES".to_string(), bytes.len().to_string()),
                    ]);
                    let output = self
                        .exec_ready(
                            &sandbox_id,
                            version::TARBALL_RESTORE_SCRIPT,
                            &restore_env,
                            Some(&bytes),
                            deadline,
                        )
                        .await?;
                    check_exit("restore the bot tarball in the guest", &output)?;
                }
            }
            env.insert(
                version::TARBALL_OVERRIDE_ENV.to_string(),
                version::guest_tarball_path(local),
            );
        }
        // The owner's global harness rides into the bot before its daemon
        // boots, and the bot's own refinements merge back. Best effort: a
        // failed sync never blocks the spawn or wake; the next one retries.
        if let Err(error) = self.sync_global_harness(record, deadline).await {
            eprintln!(
                "pa-daemon: bots: {}: the harness sync failed: {error:#}",
                record.name
            );
        }
        let output = self
            .exec_ready(&sandbox_id, BOOTSTRAP_SCRIPT, &env, None, deadline)
            .await?;
        check_exit("start the bot daemon", &output)?;
        lock(&self.guest_auth).remove(&sandbox_id);
        let ids: Value = output
            .stdout
            .lines()
            .last()
            .and_then(|line| serde_json::from_str(line).ok())
            .context("the bot bootstrap printed no session ids")?;
        record.guest_session_id = ids["activeSessionId"]
            .as_str()
            .context("the bot bootstrap returned no session id")?
            .to_string();
        record.guest_session_file = ids["sessionFile"].as_str().map(str::to_string);
        Ok(())
    }

    /// The relay self-pause settings, off the runtime thread.
    async fn relay_settings(&self) -> SelfPauseSettings {
        let agent_dir = self.agent_dir.clone();
        tokio::task::spawn_blocking(move || SelfPauseSettings::read(&agent_dir))
            .await
            .unwrap_or_else(|error| {
                eprintln!("pa-daemon: bots: the relay settings read failed: {error}");
                SelfPauseSettings::default()
            })
    }

    /// Introduce `record`'s pause token to the relay, with the sandbox id
    /// the guest will name. Best effort: a failure is retried at the next
    /// wake and never blocks the spawn.
    async fn register_pause_token(&self, settings: &SelfPauseSettings, record: &BotRecord) {
        let (Some(endpoint), Some(token), Some(sandbox_id)) = (
            settings.register_endpoint(&record.bot_id),
            record.pause_token.as_deref(),
            record.sandbox_id.as_deref(),
        ) else {
            return;
        };
        let body = match serde_json::to_vec(&json!({
            "sandboxId": sandbox_id,
            "pauseToken": token,
        })) {
            Ok(body) => body,
            Err(error) => {
                eprintln!(
                    "pa-daemon: bots: {}: the relay registration body failed: {error}",
                    record.name
                );
                return;
            }
        };
        let client = match pa_ai::utils::tls::http_client_builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REGISTRATION_TIMEOUT)
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                eprintln!(
                    "pa-daemon: bots: {}: the relay registration client failed: {error}",
                    record.name
                );
                return;
            }
        };
        let mut request = client
            .put(&endpoint)
            .header("Content-Type", "application/json")
            .body(body);
        if let Some(owner) = settings.token.as_deref() {
            request = request.header("Authorization", format!("Bearer {owner}"));
        }
        match request.send().await {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => eprintln!(
                "pa-daemon: bots: {}: the relay registration answered {}; retrying at the next wake",
                record.name,
                response.status()
            ),
            Err(error) => eprintln!(
                "pa-daemon: bots: {}: the relay registration failed: {error}; retrying at the next wake",
                record.name
            ),
        }
    }

    /// Drop `bot_id`'s relay registration and wake-up schedules. Best
    /// effort: a missing relay or a failed call never blocks the local
    /// delete, and the relay also drops schedules when a wake answers 404.
    async fn delete_relay_bot(&self, bot_id: &str) {
        let settings = self.relay_settings().await;
        let Some(endpoint) = settings.delete_endpoint(bot_id) else {
            return;
        };
        let client = match pa_ai::utils::tls::http_client_builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REGISTRATION_TIMEOUT)
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                eprintln!("pa-daemon: bots: {bot_id}: the relay delete client failed: {error}");
                return;
            }
        };
        let mut request = client.delete(&endpoint);
        if let Some(token) = settings.token.as_deref() {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        match request.send().await {
            Ok(response)
                if response.status().is_success()
                    || response.status() == reqwest::StatusCode::NOT_FOUND => {}
            Ok(response) => eprintln!(
                "pa-daemon: bots: {bot_id}: the relay delete answered {}",
                response.status()
            ),
            Err(error) => {
                eprintln!("pa-daemon: bots: {bot_id}: the relay delete failed: {error}");
            }
        }
    }

    /// The header rules and guest auth for a new sandbox of `record`: its
    /// API keys, its GitHub access, and the owner's logins. Also returns
    /// the logins and the relay host the rules carry. Inside a bot that
    /// spawns bots, the children instead inherit this sandbox's rules and
    /// guest auth, and no platform secret is provisioned from inside a bot.
    async fn guest_credentials(
        &self,
        record: &BotRecord,
        github: bool,
    ) -> Result<(GuestCredentials, Vec<String>, Option<String>)> {
        if let Some(context) = super::nested::NestedContext::read(&self.agent_dir) {
            return Ok((
                self.nested_credentials(&context, record, github)?,
                Vec::new(),
                None,
            ));
        }
        self.credentials_for(record, Some(guest_provider(record)), github)
            .await
    }

    /// The header rules and guest auth for a bot that needs `provider`'s
    /// key or login (`None`: whatever the plan gives, with no required
    /// one). Returns the rules, the logins they carry, and the relay
    /// host they carry (`None`: no relay rule).
    async fn credentials_for(
        &self,
        record: &BotRecord,
        provider: Option<&str>,
        github: bool,
    ) -> Result<(GuestCredentials, Vec<String>, Option<String>)> {
        let logins = self.logins.prepare(provider.unwrap_or_default()).await?;
        let key_provider =
            provider.filter(|provider| !logins.providers.iter().any(|login| login == provider));
        let mut credentials = retry(|| {
            self.platform
                .credentials(key_provider, github, logins.rules.len())
        })
        .await?;
        credentials.network_rules.extend(logins.rules);
        let mut relay_rule_host = None;
        // The relay pause rule: the relay's host only, carrying the bot's
        // per-bot token. The Prime API key never gets a rule; the relay
        // holds it, not the bot.
        let relay = self.relay_settings().await;
        if let (Some(host), Some(token)) = (relay.rule_host(), record.pause_token.as_deref()) {
            let name = pause_secret_name(&record.bot_id);
            match retry(|| {
                self.platform
                    .put_secret(&name, token, "Prime Agent bot relay pause token")
            })
            .await
            {
                Ok(()) => {
                    // Another rule on the relay's host would win the pause
                    // request's Authorization header, so the guest's pause
                    // would authenticate as that rule's secret and fail.
                    // Refuse the misconfiguration instead of arming a bot
                    // whose self-pause cannot work.
                    if credentials.network_rules.contains_key(&host) {
                        bail!(
                            "the relay host {host} already carries another bot rule \
                             (a key, a login, or a custom secret); give the relay its own host"
                        );
                    }
                    credentials.network_rules.insert(
                        host.clone(),
                        pa_sandbox::HeaderRule {
                            headers: BTreeMap::from([(
                                "Authorization".to_string(),
                                format!("Bearer ${{prime.secrets.{name}}}"),
                            )]),
                        },
                    );
                    relay_rule_host = Some(host);
                }
                Err(error) => eprintln!(
                    "pa-daemon: bots: {}: the relay pause token could not be stored: {error}",
                    record.name
                ),
            }
        }
        let mut providers = logins.providers;
        let mut guest = logins.guest;
        // MCP hosts come last; past the platform's host limit they stay home.
        let mut left_out = Vec::new();
        for injection in logins.mcp {
            let fits = credentials.network_rules.len() + injection.rules.len()
                <= super::secrets::MAX_RULE_HOSTS
                && injection
                    .rules
                    .keys()
                    .all(|host| !credentials.network_rules.contains_key(host));
            if !fits {
                left_out.push(injection.provider);
                continue;
            }
            credentials.network_rules.extend(injection.rules);
            guest.insert(injection.provider.clone(), injection.guest);
            providers.push(injection.provider);
        }
        if !left_out.is_empty() {
            eprintln!(
                "bot credentials: past the platform's limit of {} rule hosts (or on a host \
                 already in use); these MCP logins are not injected: {}",
                super::secrets::MAX_RULE_HOSTS,
                left_out.join(", ")
            );
        }
        let injected = |entries: BTreeMap<String, Value>| -> Option<Value> {
            let entries: serde_json::Map<String, Value> = entries
                .into_iter()
                .filter(|(server, _)| {
                    providers
                        .iter()
                        .any(|login| login.strip_prefix(super::logins::MCP_PREFIX) == Some(server))
                })
                .collect();
            (!entries.is_empty()).then_some(Value::Object(entries))
        };
        credentials.mcp_servers = injected(logins.mcp_servers);
        credentials.mcp_connections = injected(logins.mcp_connections);
        if !guest.is_empty() {
            let mut auth = match credentials.auth_json.take() {
                Some(Value::Object(auth)) => auth,
                _ => serde_json::Map::new(),
            };
            for (provider, record) in guest {
                auth.insert(provider, serde_json::to_value(record)?);
            }
            credentials.auth_json = Some(Value::Object(auth));
        }
        if record.bots {
            let (key, team) = self.sandbox_key_and_team().await?;
            self.platform
                .put_secret(
                    &super::credentials::bots_secret_name(&key),
                    &key,
                    "Prime Agent bot sandbox credential (nested bots)",
                )
                .await?;
            let rules = std::mem::take(&mut credentials.network_rules);
            credentials.network_rules = super::credentials::with_bots_rule(rules, &key);
            credentials.auth_json = Some(super::credentials::ensure_prime_inference(
                credentials.auth_json,
                team.as_ref(),
            ));
        }
        Ok((credentials, providers, relay_rule_host))
    }

    /// The credentials a bot passes its children: this sandbox's rules
    /// minus the sandbox API rule, and this guest's own auth and MCP
    /// settings. The child's model must run on one of the injected
    /// providers.
    fn nested_credentials(
        &self,
        context: &super::nested::NestedContext,
        record: &BotRecord,
        github: bool,
    ) -> Result<GuestCredentials> {
        let auth_json = read_guest_json(&self.agent_dir, "auth.json");
        let provider = guest_provider(record);
        let mut network_rules = context.child_rules();
        if !github {
            // Both GitHub hosts go: the git smart-HTTP host and the REST
            // host the `gh` CLI and API clients use.
            network_rules.remove(super::github::GIT_HOST);
            network_rules.remove(super::github::API_HOST);
        }
        // The child's provider needs credentials this sandbox actually
        // holds: an auth record, and — for a provider whose models ride an
        // API-key rule — a rule host in the inherited set. The Prime
        // Inference placeholder is always present (it carries the billing
        // team), so the record alone proves nothing there; a login-only
        // provider (Copilot, Codex) has no API-key host, so its record is
        // the whole proof. The spawn fails here, before anything is billed.
        let injected: Vec<&str> = auth_json
            .as_ref()
            .and_then(Value::as_object)
            .map(|auth| auth.keys().map(String::as_str).collect())
            .unwrap_or_default();
        let hosts = super::credentials::provider_rule_hosts(provider);
        let credible = injected.contains(&provider)
            && (hosts.is_empty() || hosts.iter().any(|host| network_rules.contains_key(host)));
        if !credible {
            let known = if injected.is_empty() {
                "none are".to_string()
            } else {
                injected.join(", ")
            };
            bail!(
                "this bot cannot spawn a bot on {provider}: its sandbox holds no {provider} \
                 credentials; the injected providers are: {known}"
            );
        }
        Ok(GuestCredentials {
            network_rules,
            mcp_servers: read_guest_json(&self.agent_dir, "settings.json")
                .as_ref()
                .and_then(|settings| settings.get("mcpServers").cloned())
                .filter(|servers| !servers.as_object().is_some_and(serde_json::Map::is_empty)),
            mcp_connections: read_guest_json(&self.agent_dir, "mcp-connections.json"),
            auth_json,
        })
    }

    /// The owner's sandbox API key and its team, read off the runtime.
    async fn sandbox_key_and_team(
        &self,
    ) -> Result<(String, Option<pa_core::auth::PrimeTeamCredential>)> {
        let agent_dir = self.agent_dir.clone();
        tokio::task::spawn_blocking(move || {
            let mut auth = pa_core::auth::AuthStorage::create(&agent_dir);
            let key = auth
                .get_api_key(pa_core::auth::PRIME_INFERENCE_PROVIDER_ID)
                .ok_or_else(|| {
                    anyhow!(
                        "Bots need a Prime API key. Log in to Prime Inference or set \
                         PRIME_API_KEY."
                    )
                })?;
            Ok((key, super::credentials::effective_prime_team_of(&mut auth)))
        })
        .await
        .context("the Prime credential read failed")?
    }

    /// Run a guest command once the sandbox gateway answers: retries
    /// transport errors, and stops when the sandbox ends.
    pub(super) async fn exec_ready(
        &self,
        sandbox_id: &str,
        script: &str,
        env: &BTreeMap<String, String>,
        stdin: Option<&[u8]>,
        deadline: Instant,
    ) -> Result<ExecOutput> {
        let started = Instant::now();
        let mut attempt = 0_u32;
        loop {
            match self.platform.exec(sandbox_id, script, env, stdin).await {
                Ok(output) => return Ok(output),
                Err(PlatformError::Transient(reason) | PlatformError::Conflict(reason)) => {
                    attempt += 1;
                    if attempt.is_multiple_of(4) {
                        let current = retry(|| self.platform.get(sandbox_id)).await?;
                        if current.status.is_terminal() {
                            bail!("bot sandbox {sandbox_id} ended before the guest answered: {reason}");
                        }
                    }
                    if Instant::now() >= deadline {
                        bail!("the bot guest did not answer in time: {reason}");
                    }
                }
                Err(error) => return Err(error.into()),
            }
            sleep_poll(started, deadline).await?;
        }
    }

    /// Record `checkpoint` as the newest one. The older ones stay until a
    /// newer checkpoint is durable ([`Self::prune_checkpoints`]).
    async fn replace_checkpoint(&self, record: &mut BotRecord, checkpoint: String) -> Result<()> {
        if record.checkpoint_id.as_ref() == Some(&checkpoint) {
            return Ok(());
        }
        if let Some(old) = record.checkpoint_id.replace(checkpoint) {
            record.older_checkpoint_ids.push(old);
        }
        self.save(record.clone())?;
        self.prune_checkpoints(record).await
    }

    /// Delete the recorded checkpoints older than `restored`, the one the
    /// bot now runs from. Anything newer stays: it may still be uploading
    /// or may have refused to restore.
    async fn prune_before(&self, record: &mut BotRecord, restored: &str) -> Result<()> {
        let order: Vec<String> = record
            .older_checkpoint_ids
            .iter()
            .chain(record.checkpoint_id.iter())
            .cloned()
            .collect();
        let Some(index) = order.iter().position(|id| id == restored) else {
            return Ok(());
        };
        if index == 0 {
            return Ok(());
        }
        let stale: Vec<String> = record.older_checkpoint_ids.drain(..index).collect();
        lock(&self.registry).add_orphans(&stale)?;
        self.save(record.clone())?;
        self.delete_orphans(stale).await
    }

    /// Delete every checkpoint older than the newest durable one.
    async fn prune_checkpoints(&self, record: &mut BotRecord) -> Result<()> {
        let mut oldest_first = record.older_checkpoint_ids.clone();
        oldest_first.extend(record.checkpoint_id.clone());
        let mut newest_durable = None;
        for (index, checkpoint) in oldest_first.iter().enumerate().rev() {
            if self.platform.checkpoint_durable(checkpoint).await? {
                newest_durable = Some(index);
                break;
            }
        }
        let Some(index) = newest_durable.filter(|index| *index > 0) else {
            return Ok(());
        };
        let stale: Vec<String> = record.older_checkpoint_ids.drain(..index).collect();
        lock(&self.registry).add_orphans(&stale)?;
        self.save(record.clone())?;
        self.delete_orphans(stale).await
    }

    /// Delete tracked orphan checkpoints; a failed delete stays tracked.
    async fn delete_orphans(&self, checkpoints: Vec<String>) -> Result<()> {
        for checkpoint in checkpoints {
            match retry(|| self.platform.delete_checkpoint(&checkpoint)).await {
                Ok(()) => lock(&self.registry).remove_orphan(&checkpoint)?,
                Err(error) => {
                    eprintln!("pa-daemon: could not delete bot checkpoint {checkpoint}: {error}");
                }
            }
        }
        Ok(())
    }

    async fn delete_locked(&self, bot_id: &str) -> Result<()> {
        // Stop future relay wakes before the sandboxes and checkpoints go.
        self.delete_relay_bot(bot_id).await;
        let record = self.get(bot_id);
        let label = bot_label(bot_id);
        // An errored sandbox still exists on the account, so it is deleted too.
        let mut sandbox_ids: Vec<String> = retry(|| self.platform.list(&label))
            .await?
            .into_iter()
            .filter(|sandbox| sandbox.status != BotStatus::Stopped)
            .map(|sandbox| sandbox.id)
            .collect();
        if let Some(cached) = record.as_ref().and_then(|record| record.sandbox_id.clone()) {
            if !sandbox_ids.contains(&cached) {
                sandbox_ids.push(cached);
            }
        }
        for sandbox_id in &sandbox_ids {
            retry(|| self.platform.delete(sandbox_id)).await?;
        }
        let Some(record) = record else {
            return Ok(());
        };
        let mut checkpoints = record.older_checkpoint_ids;
        checkpoints.extend(record.checkpoint_id);
        {
            let mut registry = lock(&self.registry);
            registry.add_orphans(&checkpoints)?;
            registry.remove(bot_id)?;
        }
        let mut spawns = read_spawns_marker(&self.agent_dir);
        if spawns.remove(bot_id) {
            let _ = write_spawns_marker(&self.agent_dir, &spawns);
        }
        super::harness_sync::remove_base(&self.agent_dir, bot_id);
        self.delete_orphans(checkpoints).await
    }
}

/// One JSON file of this daemon's agent dir, when it parses.
fn read_guest_json(agent_dir: &Path, name: &str) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(agent_dir.join(name)).ok()?).ok()
}

/// The bot ids that may spawn bots, durably recorded next to the registry:
/// the platform labels are set at create only, so `allow_spawns` marks a
/// running bot here, where a registry rebuild still finds the flag.
fn spawns_marker_path(agent_dir: &Path) -> PathBuf {
    agent_dir.join("bots").join("spawns.json")
}

fn read_spawns_marker(agent_dir: &Path) -> BTreeSet<String> {
    std::fs::read_to_string(spawns_marker_path(agent_dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_spawns_marker(agent_dir: &Path, ids: &BTreeSet<String>) -> Result<()> {
    let path = spawns_marker_path(agent_dir);
    if let Some(dir) = path.parent() {
        pa_core::platform::perms::create_dir_all_private(dir)?;
    }
    crate::descriptor::write_file_atomic(&path, &serde_json::to_string(ids)?)
}

fn is_transient(error: &anyhow::Error) -> bool {
    matches!(
        error.downcast_ref::<PlatformError>(),
        Some(PlatformError::Transient(_) | PlatformError::Conflict(_))
    )
}

/// sha256 of `bot_id:generation:source`, first 32 hex chars (orbs
/// `_deterministic_idempotency_key`): a retried create returns the same sandbox.
#[must_use]
pub fn idempotency_key(bot_id: &str, generation: u32, source: &str) -> String {
    sha256_hex(format!("{bot_id}:{generation}:{source}").as_bytes())[..32].to_string()
}

/// The guest session's model and thinking, as the record's fields: the
/// `get_state` summary's model (its provider and id, joined like a spawn
/// selector) and its effective thinking level. `None` when the summary
/// carries no model; a `"default"` (unset) level keeps the record's
/// thinking.
fn guest_model_choice(state: &Value) -> Option<(Option<String>, Option<String>)> {
    let model = state.get("model").and_then(|model| {
        let id = model.get("id").and_then(Value::as_str)?;
        Some(match model.get("provider").and_then(Value::as_str) {
            Some(provider) => format!("{provider}/{id}"),
            None => id.to_string(),
        })
    })?;
    let thinking = state
        .get("thinkingLevel")
        .and_then(Value::as_str)
        .filter(|level| *level != "default")
        .map(str::to_string);
    Some((Some(model), thinking))
}

/// The provider the guest's model belongs to.
fn guest_provider(record: &BotRecord) -> &str {
    record
        .model
        .as_deref()
        .and_then(|model| model.split_once('/'))
        .map_or(PRIME_INFERENCE_PROVIDER_ID, |(provider, _)| provider)
}

/// The relay self-pause settings: `bots.relay.url` (the relay; unset
/// turns the guest-side self-pause off), `bots.relay.token` (the
/// registration credential), and `bots.selfPauseMinutes` (the idle
/// window; `0` disables it).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SelfPauseSettings {
    pub url: String,
    pub token: Option<String>,
    pub minutes: u64,
}

impl SelfPauseSettings {
    /// Read from the global settings of `agent_dir`.
    fn read(agent_dir: &Path) -> Self {
        let settings = pa_core::settings::SettingsManager::create(agent_dir, agent_dir);
        Self {
            url: settings.get_bots_relay_url().unwrap_or_default(),
            token: settings.get_bots_relay_token(),
            minutes: settings
                .get_bots_self_pause_minutes()
                .unwrap_or(super::self_pause::DEFAULT_IDLE_MINUTES),
        }
    }

    /// The relay's rule host: the exact DNS host of its URL, the tightest
    /// scope a header rule allows.
    fn rule_host(&self) -> Option<String> {
        super::credentials::base_url_host(&self.url)
    }

    /// The pause endpoint of one bot: the only relay path the guest calls.
    fn pause_endpoint(&self, bot_id: &str) -> Option<String> {
        let base = self.url.trim_end_matches('/');
        (!base.is_empty()).then(|| format!("{base}/api/bots/{bot_id}/pause"))
    }

    /// The registration endpoint of one bot: where the daemon introduces
    /// its pause token.
    fn register_endpoint(&self, bot_id: &str) -> Option<String> {
        let base = self.url.trim_end_matches('/');
        (!base.is_empty()).then(|| format!("{base}/api/bots/{bot_id}"))
    }

    /// The delete endpoint of one bot: where the daemon drops its relay
    /// registration and wake-up schedules.
    fn delete_endpoint(&self, bot_id: &str) -> Option<String> {
        self.register_endpoint(bot_id)
    }
}

/// The platform secret holding `bot`'s relay pause token: one per bot,
/// stable across wakes (a rotation updates the value).
fn pause_secret_name(bot_id: &str) -> String {
    format!(
        "PRIME_AGENT_BOT_PAUSE_{}",
        super::credentials::key_fingerprint(bot_id)
    )
}

fn bootstrap_env(record: &BotRecord, self_pause: &SelfPauseSettings) -> BTreeMap<String, String> {
    // The model and thinking seed a NEW session only: the guest client
    // drops them when it reopens an existing session file, because that
    // session pins its own (every guest `set_model` lands there).
    let mut config = json!({ "cwd": "/root" });
    if let Some(model) = &record.model {
        match model.split_once('/') {
            Some((provider, id)) => {
                config["provider"] = json!(provider);
                config["model"] = json!(id);
            }
            None => config["model"] = json!(model),
        }
    }
    if let Some(thinking) = &record.thinking {
        config["thinking"] = json!(thinking);
    }
    let mut env = BTreeMap::from([
        (
            "PRIME_AGENT_DAEMON_SOCKET".to_string(),
            super::GUEST_DAEMON_SOCKET.to_string(),
        ),
        ("BOT_CLIENT".to_string(), BOT_CLIENT.to_string()),
        ("BOT_SETTINGS_PY".to_string(), GUEST_SETTINGS_PY.to_string()),
        ("BOT_NAME".to_string(), record.name.clone()),
        (
            super::remote_parent::REMOTE_PARENT_ENV.to_string(),
            super::remote_parent::REMOTE_PARENT_NAME.to_string(),
        ),
        ("BOT_CONFIG".to_string(), config.to_string()),
        (
            "NODE_EXTRA_CA_CERTS".to_string(),
            super::credentials::PLATFORM_CA_PATH.to_string(),
        ),
        (
            "PLATFORM_CA".to_string(),
            super::credentials::PLATFORM_CA_PATH.to_string(),
        ),
    ]);
    if let Some(file) = &record.guest_session_file {
        env.insert("BOT_SESSION_FILE".to_string(), file.clone());
    }
    // The guest daemon's idle self-pause: the file the bootstrap writes
    // from these arms it, and every wake rewrites the file.
    if let Some(sandbox_id) = &record.sandbox_id {
        env.insert("PRIME_AGENT_BOT_ID".to_string(), record.bot_id.clone());
        env.insert("PRIME_AGENT_BOT_SANDBOX_ID".to_string(), sandbox_id.clone());
        env.insert(
            super::self_pause::SELF_PAUSE_ENV.to_string(),
            super::GUEST_SELF_PAUSE_FILE.to_string(),
        );
        env.insert("BOT_RELAY_URL".to_string(), self_pause.url.clone());
        env.insert(
            "BOT_SELF_PAUSE_URL".to_string(),
            self_pause
                .pause_endpoint(&record.bot_id)
                .unwrap_or_default(),
        );
        env.insert(
            "BOT_SELF_PAUSE_MINUTES".to_string(),
            self_pause.minutes.to_string(),
        );
    }
    super::github::guest_env(record.github, record.git_identity.as_ref(), &mut env);
    env
}

pub(super) fn check_exit(action: &str, output: &ExecOutput) -> Result<()> {
    if output.exit_code == 0 {
        return Ok(());
    }
    let detail = if output.stderr.trim().is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    bail!(
        "{action} failed (exit {}): {}",
        output.exit_code,
        detail.trim()
    )
}

/// The sandbox is gone: the next create must use a new idempotency key.
fn lose_sandbox(record: &mut BotRecord) {
    record.sandbox_id = None;
    record.status = BotStatus::Stopped;
    record.generation += 1;
}

fn label_value(labels: &[String], prefix: &str) -> Option<String> {
    labels
        .iter()
        .find_map(|label| label.strip_prefix(prefix).filter(|value| !value.is_empty()))
        .map(str::to_string)
}

fn sort_newest_first(sandboxes: &mut [BotSandbox]) {
    sandboxes.sort_by(|a, b| b.created_at.cmp(&a.created_at));
}

/// A checkpoint's creation time as epoch milliseconds; an unparseable
/// stamp counts as the oldest, so it never wins an ordering. A plain
/// string comparison misorders RFC 3339 precision variants
/// (`10:00:00Z` sorts after `10:00:00.500Z`).
fn checkpoint_millis(checkpoint: &BotCheckpoint) -> u64 {
    parse_iso_millis(&checkpoint.created_at).unwrap_or(0)
}

/// One `list_bots` row of a bot's daemon, as this daemon's record for the
/// child: the row's facts over an existing record's, the fields the row
/// does not carry kept from it. `None` for a row without identity, or one
/// whose bot never provisioned (no sandbox and no checkpoint).
fn child_record(
    row: &Value,
    parent_bot_id: &str,
    existing: Option<BotRecord>,
) -> Option<BotRecord> {
    let text = |key: &str| row.get(key).and_then(Value::as_str);
    let bot_id = text("botId")?;
    if row.get("sandboxId").and_then(Value::as_str).is_none()
        && row.get("checkpointId").and_then(Value::as_str).is_none()
    {
        return None;
    }
    let existing = existing.unwrap_or_default();
    let field = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    let status = serde_json::from_value(field("status")).unwrap_or(BotStatus::Stopped);
    // An older guest's row has no closed time: keep the registry's, and close
    // a running interval the row ends.
    let running_ms = field("closedRunningMs").as_i64().unwrap_or_else(|| {
        if existing.status == BotStatus::Running && status != BotStatus::Running {
            existing.running_ms_at(field("statusSince").as_i64().unwrap_or_else(now_ms))
        } else {
            existing.running_ms
        }
    });
    Some(BotRecord {
        bot_id: bot_id.to_string(),
        name: text("name").unwrap_or_default().to_string(),
        owner_session_id: text("ownerSessionId").unwrap_or_default().to_string(),
        owner_active_session_id: None,
        sandbox_id: text("sandboxId").map(str::to_string),
        status,
        checkpoint_id: text("checkpointId").map(str::to_string),
        older_checkpoint_ids: existing.older_checkpoint_ids,
        version: text("version").unwrap_or_default().to_string(),
        model: text("model").map(str::to_string),
        thinking: existing.thinking,
        created_at: field("createdAt").as_i64().unwrap_or_default(),
        last_turn_at: field("lastTurnAt").as_i64(),
        guest_session_id: text("guestSessionId").unwrap_or_default().to_string(),
        guest_session_file: existing.guest_session_file,
        generation: existing.generation,
        github: row.get("github").and_then(Value::as_bool).unwrap_or(false),
        git_identity: existing.git_identity,
        logins: existing.logins,
        // Host-side fields the guest rows never carry: keep what the
        // registry already holds, so a sync does not drop the child's
        // relay authentication.
        pause_rule_host: existing.pause_rule_host,
        bots: false,
        parent_bot_id: Some(parent_bot_id.to_string()),
        pause_at: field("pauseAt").as_i64(),
        // A guest row without the stamp counts from the first merge.
        status_since: field("statusSince")
            .as_i64()
            .or(existing.status_since.filter(|_| existing.status == status))
            .or_else(|| Some(now_ms())),
        // The record adds the open interval from `status_since` itself.
        running_ms,
        pause_token: existing.pause_token,
        cpu: existing.cpu,
        memory_gb: existing.memory_gb,
    })
}

/// A registry record rebuilt from a live sandbox's labels.
fn rebuilt_record(bot_id: &str, sandbox: &BotSandbox) -> BotRecord {
    BotRecord {
        bot_id: bot_id.to_string(),
        name: sandbox.name.clone(),
        owner_session_id: label_value(&sandbox.labels, &format!("{BOT_LABEL}-owner:"))
            .unwrap_or_default(),
        owner_active_session_id: None,
        sandbox_id: Some(sandbox.id.clone()),
        status: sandbox.status,
        checkpoint_id: None,
        older_checkpoint_ids: Vec::new(),
        version: String::new(),
        model: None,
        thinking: None,
        created_at: now_ms(),
        last_turn_at: None,
        guest_session_id: String::new(),
        guest_session_file: None,
        // The lost record's generation is unknown; a time-based one is past
        // every generation the bot used, so no old idempotency key repeats.
        generation: u32::try_from(now_ms() / 1000).unwrap_or(u32::MAX),
        github: sandbox.labels.iter().any(|label| label == GITHUB_LABEL),
        bots: sandbox
            .labels
            .iter()
            .any(|label| label == super::BOTS_LABEL),
        // The guest's git config already holds it.
        git_identity: None,
        logins: sandbox
            .labels
            .iter()
            .filter_map(|label| label.strip_prefix(LOGIN_LABEL_PREFIX))
            .map(str::to_string)
            .collect(),
        // A rebuilt record gets a fresh one at its next wake.
        pause_token: None,
        pause_rule_host: None,
        parent_bot_id: label_value(&sandbox.labels, &format!("{BOT_LABEL}-parent:")),
        pause_at: None,
        status_since: None,
        running_ms: 0,
        // Labels carry no size: the rebuilt record runs the small default.
        cpu: None,
        memory_gb: None,
    }
}

/// The durable session ids this agent dir can prove: every saved session
/// file (live and archived) plus every live RLM child edge in the spawn
/// ledger. A bot whose owner label names none of these belongs to another
/// agent dir on the same team account.
fn agent_dir_sessions(agent_dir: &Path) -> BTreeSet<String> {
    let mut sessions = BTreeSet::new();
    let Ok(sessions_dir) = crate::paths::sessions_dir(agent_dir) else {
        return sessions;
    };
    let archive = agent_dir.join("sessions-archive");
    for dir in [sessions_dir.as_path(), archive.as_path()] {
        sessions.extend(
            crate::session_store::list_sessions(dir)
                .into_iter()
                .map(|info| info.id),
        );
    }
    let ledger = crate::rlm_ledger::RlmSpawnLedger::new(agent_dir, &sessions_dir, |_| {});
    match ledger.edges(false) {
        Ok(edges) => sessions.extend(edges.into_iter().map(|edge| edge.child_id)),
        Err(error) => eprintln!(
            "pa-daemon: bots: spawn ledger unreadable, no ledger child proves a bot owner: {error:#}"
        ),
    }
    sessions
}

/// Retry 409, 5xx, and network failures with backoff (orbs `_request_resume_with_retry`).
async fn retry<T, F, Fut>(mut call: F) -> PlatformResult<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = PlatformResult<T>>,
{
    let mut delay = Duration::from_millis(250);
    let mut attempt = 1;
    loop {
        match call().await {
            Err(PlatformError::Conflict(_) | PlatformError::Transient(_))
                if attempt < RETRY_ATTEMPTS =>
            {
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_secs(5));
                attempt += 1;
            }
            result => return result,
        }
    }
}

/// Poll tightly during short boot and resume windows, then ease off (orbs `_fast_poll_delay`).
async fn sleep_poll(started: Instant, deadline: Instant) -> Result<()> {
    let now = Instant::now();
    if now >= deadline {
        bail!("bot operation timed out");
    }
    let elapsed = now - started;
    let delay = if elapsed < Duration::from_secs(3) {
        Duration::from_millis(150)
    } else if elapsed < Duration::from_secs(15) {
        Duration::from_millis(250)
    } else if elapsed < Duration::from_secs(45) {
        Duration::from_millis(500)
    } else {
        Duration::from_secs(1)
    };
    tokio::time::sleep(delay.min(deadline - now)).await;
    Ok(())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}
