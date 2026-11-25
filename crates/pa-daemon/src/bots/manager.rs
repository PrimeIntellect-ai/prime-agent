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
use serde_json::{json, Value};
use tokio::time::Instant;

use super::logins::{Logins, REFRESH_TICK};
use super::platform::{
    BotCreate, BotPlatform, BotSandbox, ExecOutput, GuestCredentials, PlatformError, PlatformResult,
};
use super::registry::{BotRecord, BotRegistry, BotStatus};
use super::version::{self, Install, ReleaseSource};
use super::{
    bot_label, login_label, owner_label, sha256_hex, BotSpec, BOT_IMAGE_ENV, BOT_LABEL,
    DEFAULT_BOT_IMAGE, GITHUB_LABEL, LOGIN_LABEL_PREFIX,
};

/// The budget for one wake, create, or pause.
const OPERATION_BUDGET: Duration = Duration::from_mins(15);
/// Attempts for one platform call that answers 409, 429, 5xx, or a network
/// error: about 30 s of backoff, so a busy account's rate limit passes.
const RETRY_ATTEMPTS: u32 = 10;

/// Writes the owner's `factory.enabled` into the guest settings, starts the
/// guest daemon when it is not up, then opens the bot session. It
/// reopens `BOT_SESSION_FILE`, or the file a marker on the guest disk names, so
/// a registry rebuilt from labels still finds the session. Prints the session ids as JSON.
/// It also sets the git author, and with GitHub access (`GH_TOKEN` holds the
/// placeholder) a git credential that sends the placeholder, which the
/// platform replaces, and a CA bundle that adds the platform root.
const BOOTSTRAP_SCRIPT: &str = r#"set -euo pipefail
export HOME="${HOME:-/root}"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
cd "$HOME"
mkdir -p "$(dirname "$PRIME_AGENT_DAEMON_SOCKET")"
if [ -n "${BOT_AUTH_JSON:-}" ] && { [ -n "${BOT_AUTH_OVERWRITE:-}" ] || [ ! -s "$HOME/.prime/agent/auth.json" ]; }; then
  (umask 077; printf '%s' "$BOT_AUTH_JSON" >"$HOME/.prime/agent/auth.json")
fi
python3 - <<'PY'
import json, os
path = os.path.join(os.environ["HOME"], ".prime/agent/settings.json")
try:
    settings = json.load(open(path))
except (OSError, ValueError):
    settings = {}
settings.setdefault("factory", {})["enabled"] = os.environ["BOT_FACTORY_ENABLED"] == "true"
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as file:
    json.dump(settings, file)
PY
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
  if [ -f "$PLATFORM_CA" ]; then
    cat /etc/ssl/certs/ca-certificates.crt "$PLATFORM_CA" >"$HOME/.prime-agent-ca.pem"
    git config --global http.sslCAInfo "$HOME/.prime-agent-ca.pem"
    export SSL_CERT_FILE="$HOME/.prime-agent-ca.pem"
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
const BOT_CLIENT: &str = r#"import json, os, socket, sys
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
    guest_auth: Mutex<HashMap<String, Value>>,
    image: String,
    release: ReleaseSource,
    /// The owner's agent dir: its `factory.enabled` carries into the bot.
    agent_dir: PathBuf,
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
            release: ReleaseSource::resolve(),
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
        })?;
        match self.ensure_running_locked(&spec.bot_id).await {
            Ok(record) => Ok(record),
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
        self.ensure_running_locked(bot_id).await
    }

    /// Pause a bot. Records the pause checkpoint. When the platform refuses
    /// the pause, takes a durable checkpoint and deletes the sandbox.
    ///
    /// # Errors
    /// Returns an error for an unknown bot or a failed pause.
    pub async fn pause(&self, bot_id: &str) -> Result<BotRecord> {
        let bot_lock = self.lock_for(bot_id);
        let _held = bot_lock.lock().await;
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
    ///
    /// # Errors
    /// Returns an error when a sandbox delete fails.
    pub async fn delete(&self, bot_id: &str) -> Result<()> {
        let bot_lock = self.lock_for(bot_id);
        let _held = bot_lock.lock().await;
        self.delete_locked(bot_id).await
    }

    /// Rebuild the cache from labels: newest live sandbox per bot wins, the
    /// others are deleted; a lost registry record is rebuilt from the labels;
    /// a record whose sandbox is gone becomes `Stopped`.
    ///
    /// # Errors
    /// Returns an error when listing or a duplicate delete fails.
    pub async fn reconcile_on_boot(&self) -> Result<()> {
        let mut bot_ids = BTreeSet::new();
        for sandbox in retry(|| self.platform.list(BOT_LABEL)).await? {
            if sandbox.status.is_terminal() {
                continue;
            }
            if let Some(bot_id) = label_value(&sandbox.labels, &format!("{BOT_LABEL}:")) {
                bot_ids.insert(bot_id);
            }
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
            record.sandbox_id = Some(chosen.id.clone());
            record.status = chosen.status;
            self.save(record)?;
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
            self.save(record)?;
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
    fn save(&self, mut record: BotRecord) -> Result<()> {
        let mut registry = lock(&self.registry);
        if let Some(current) = registry.get(&record.bot_id) {
            record.last_turn_at = record.last_turn_at.max(current.last_turn_at);
        }
        registry.put(record)
    }

    async fn ensure_running_locked(&self, bot_id: &str) -> Result<BotRecord> {
        let deadline = Instant::now() + OPERATION_BUDGET;
        let mut record = self.record(bot_id)?;
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
        let sandbox = match woken {
            Some(sandbox) => sandbox,
            None => self.acquire_new(&mut record, deadline).await?,
        };
        record.sandbox_id = Some(sandbox.id.clone());
        record.status = BotStatus::Running;
        self.save(record.clone())?;
        // A resumed bot gets a fresh token before its first request.
        self.refresh_logins(&record).await;
        self.install_and_bootstrap(&mut record, deadline).await?;
        self.save(record.clone())?;
        Ok(record)
    }

    /// The bot's live sandbox: the cached id when it is live, else the
    /// newest live labeled sandbox (deleting the others).
    async fn resolve_existing(&self, record: &mut BotRecord) -> Result<Option<BotSandbox>> {
        if let Some(sandbox_id) = record.sandbox_id.clone() {
            match self.platform.get(&sandbox_id).await {
                Ok(sandbox) if !sandbox.status.is_terminal() => return Ok(Some(sandbox)),
                Ok(sandbox) if sandbox.status == BotStatus::Error => {
                    retry(|| self.platform.delete(&sandbox_id)).await?;
                    lose_sandbox(record);
                }
                Ok(_) | Err(PlatformError::NotFound(_)) => lose_sandbox(record),
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
        if let Some(sandbox) = &found {
            record.sandbox_id = Some(sandbox.id.clone());
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

    /// A new sandbox: restored from the recorded durable checkpoint, else
    /// booted from the image. A restore that may still be booting keeps the
    /// checkpoint and fails, so the next wake finds that sandbox.
    async fn acquire_new(&self, record: &mut BotRecord, deadline: Instant) -> Result<BotSandbox> {
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
                Ok(sandbox) => return Ok(sandbox),
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
        let (credentials, logins) = self.guest_credentials(record, record.github).await?;
        record.logins = logins;
        let mut labels = vec![
            BOT_LABEL.to_string(),
            bot_label(&record.bot_id),
            owner_label(&record.owner_session_id),
        ];
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
            network_rules: credentials.network_rules,
        };
        let created = retry(|| self.platform.create(&request)).await?;
        if let Some(auth) = credentials.auth_json {
            lock(&self.guest_auth).insert(created.id.clone(), auth);
        }
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
            let install = Install::prepare(local, &self.release)?;
            let mut env: BTreeMap<String, String> = install.env.into_iter().collect();
            // The install stops a guest daemon that runs another version.
            env.insert(
                "PRIME_AGENT_DAEMON_SOCKET".to_string(),
                super::GUEST_DAEMON_SOCKET.to_string(),
            );
            let output = self
                .exec_ready(
                    &sandbox_id,
                    version::INSTALL_SCRIPT,
                    &env,
                    install.stdin.as_deref(),
                    deadline,
                )
                .await?;
            if let Some(message) = version::install_failure(output.exit_code, local) {
                bail!(message);
            }
            check_exit("install prime-agent in the bot", &output)?;
        }
        record.version = local.to_string();
        let mut env = bootstrap_env(record);
        let agent_dir = self.agent_dir.clone();
        let factory_enabled = tokio::task::spawn_blocking(move || {
            pa_core::settings::SettingsManager::create(&agent_dir, &agent_dir).get_factory_enabled()
        })
        .await
        .context("the factory.enabled read failed")?;
        env.insert(
            "BOT_FACTORY_ENABLED".to_string(),
            factory_enabled.to_string(),
        );
        // A sandbox created by this process gets the auth that matches its
        // header rules. Any other sandbox keeps its auth.json, and gets one
        // only when it has none (its create ran before a restart).
        let created_here = lock(&self.guest_auth).get(&sandbox_id).cloned();
        let auth = match created_here {
            Some(auth) => {
                env.insert("BOT_AUTH_OVERWRITE".to_string(), "1".to_string());
                Some(auth)
            }
            // Best effort: the sandbox's rules are already set.
            None => self
                .guest_credentials(record, false)
                .await
                .ok()
                .and_then(|(credentials, _)| credentials.auth_json),
        };
        if let Some(auth) = auth {
            env.insert("BOT_AUTH_JSON".to_string(), auth.to_string());
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

    /// The header rules and guest auth for a new sandbox of `record`: its
    /// API keys, its GitHub access, and the owner's logins. Also returns
    /// the logins it carries.
    async fn guest_credentials(
        &self,
        record: &BotRecord,
        github: bool,
    ) -> Result<(GuestCredentials, Vec<String>)> {
        let provider = guest_provider(record);
        let logins = self.logins.prepare(provider).await?;
        let key_provider =
            (!logins.providers.iter().any(|login| login == provider)).then_some(provider);
        let mut credentials = retry(|| {
            self.platform
                .credentials(key_provider, github, logins.rules.len())
        })
        .await?;
        credentials.network_rules.extend(logins.rules);
        if !logins.guest.is_empty() {
            let mut auth = match credentials.auth_json.take() {
                Some(Value::Object(auth)) => auth,
                _ => serde_json::Map::new(),
            };
            for (provider, record) in logins.guest {
                auth.insert(provider, serde_json::to_value(record)?);
            }
            credentials.auth_json = Some(Value::Object(auth));
        }
        Ok((credentials, logins.providers))
    }

    /// Run a guest command once the sandbox gateway answers: retries
    /// transport errors, and stops when the sandbox ends.
    async fn exec_ready(
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
        self.delete_orphans(checkpoints).await
    }
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

/// The provider the guest's model belongs to.
fn guest_provider(record: &BotRecord) -> &str {
    record
        .model
        .as_deref()
        .and_then(|model| model.split_once('/'))
        .map_or(PRIME_INFERENCE_PROVIDER_ID, |(provider, _)| provider)
}

fn bootstrap_env(record: &BotRecord) -> BTreeMap<String, String> {
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
    ]);
    if let Some(file) = &record.guest_session_file {
        env.insert("BOT_SESSION_FILE".to_string(), file.clone());
    }
    super::github::guest_env(record.github, record.git_identity.as_ref(), &mut env);
    env
}

fn check_exit(action: &str, output: &ExecOutput) -> Result<()> {
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
        // The guest's git config already holds it.
        git_identity: None,
        logins: sandbox
            .labels
            .iter()
            .filter_map(|label| label.strip_prefix(LOGIN_LABEL_PREFIX))
            .map(str::to_string)
            .collect(),
    }
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}
