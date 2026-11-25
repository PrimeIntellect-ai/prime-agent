//! Bots: Prime VM sandboxes that each run a normal `prime-agent` daemon for
//! one owner session on this machine.
//!
//! [`BotManager`] owns the sandbox lifecycle. Platform labels are the source of
//! truth; [`registry`] is a private cache. A bot always runs this binary's
//! exact version ([`version`]).

pub mod attach;
pub mod commands;
pub mod credentials;
pub mod exec_stream;
pub mod files;
pub mod github;
pub mod guest;
pub mod ledger;
pub mod link;
pub mod logins;
pub mod manager;
pub mod nested;
pub mod platform;
pub mod registry;
pub mod relay;
pub mod remote_parent;
pub mod replies;
pub mod secrets;
pub mod self_pause;
pub mod send;
pub mod version;
pub mod wakeup_sync;

#[cfg(all(test, unix))]
mod send_tests;
#[cfg(test)]
pub(crate) mod tests;

use std::path::Path;
use std::sync::{Arc, OnceLock};

use anyhow::{anyhow, Result};
use pa_core::auth::AuthStorage;
use pa_core::settings::BotGitIdentity;
use pa_sandbox::{ClientOptions, PrimeSandboxClient, DEFAULT_BASE_URL};
use sha2::{Digest, Sha256};

pub use manager::{AttachGuard, BotManager};
pub use registry::{BotRecord, BotStatus};

/// The image a new bot boots: the team bot image, which already carries the
/// pinned guest tools, uv, the kernel venv and a prime-agent release. A bot
/// whose version matches that release skips the install. Rebuild it with
/// `make bot-image` (packaging/bot-image/README.md).
pub const DEFAULT_BOT_IMAGE: &str = "prime/primeintellect/prime-agent-bot:latest";
/// Overrides [`DEFAULT_BOT_IMAGE`].
pub const BOT_IMAGE_ENV: &str = "PRIME_AGENT_BOT_IMAGE";
/// The label every bot sandbox carries.
pub const BOT_LABEL: &str = "prime-agent-bot";
/// The label of a bot with GitHub access.
pub const GITHUB_LABEL: &str = "prime-agent-bot-github";
/// The label of a bot that may spawn its own bots.
pub const BOTS_LABEL: &str = "prime-agent-bot-spawns";
/// The prefix of a relay pause token's platform secret name: a rule that
/// names one is a bot's own pause rule, never a child's to inherit.
pub const PAUSE_SECRET_MARK: &str = "PRIME_AGENT_BOT_PAUSE_";
/// The label prefix that names each owner login a bot carries.
pub const LOGIN_LABEL_PREFIX: &str = "prime-agent-bot-login:";
/// The guest daemon's socket.
pub const GUEST_DAEMON_SOCKET: &str = "/root/.prime/agent/bot-daemon.sock";
/// The guest daemon's self-pause configuration file, rewritten by the
/// bootstrap at every wake.
pub const GUEST_SELF_PAUSE_FILE: &str = "/root/.prime/agent/bot-self-pause.json";

/// The label that names one bot.
#[must_use]
pub fn bot_label(bot_id: &str) -> String {
    format!("{BOT_LABEL}:{bot_id}")
}

/// The label that names a bot's owner (its durable session id).
#[must_use]
pub fn owner_label(owner_session_id: &str) -> String {
    format!("{BOT_LABEL}-owner:{owner_session_id}")
}

/// The label that names the bot a bot was spawned by.
#[must_use]
pub fn parent_label(bot_id: &str) -> String {
    format!("{BOT_LABEL}-parent:{bot_id}")
}

/// How deep bots nest: owner -> bot -> bot. A bot at the maximum depth
/// cannot spawn another one.
pub const MAX_BOT_DEPTH: u32 = 2;

/// The label that names one owner login a bot carries.
#[must_use]
pub fn login_label(provider: &str) -> String {
    format!("{LOGIN_LABEL_PREFIX}{provider}")
}

/// What a new bot needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotSpec {
    pub bot_id: String,
    /// The rlm spawn name.
    pub name: String,
    /// The owner's durable session id.
    pub owner_session_id: String,
    /// `provider/model`.
    pub model: Option<String>,
    pub thinking: Option<String>,
    /// The first owner message; the spawn layer sends it after [`BotManager::spawn`].
    pub prompt: String,
    /// GitHub access through the platform's header rules.
    pub github: bool,
    /// The git author the bot commits as.
    pub git_identity: Option<BotGitIdentity>,
    /// The bot may spawn its own bots (`rlm.spawn(..., bots=True)`).
    pub bots: bool,
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .fold(String::new(), |mut hex, byte| {
            use std::fmt::Write;
            write!(hex, "{byte:02x}").expect("write to String");
            hex
        })
}

/// The process-wide manager, built on first use from the daemon's Prime
/// credential (`PRIME_API_KEY` or the stored Prime Inference key and team).
///
/// # Errors
/// Returns an error when no Prime credential is configured, or the registry
/// cannot be read.
pub fn manager_for(agent_dir: &Path) -> Result<Arc<BotManager>> {
    static MANAGER: OnceLock<Arc<BotManager>> = OnceLock::new();
    if let Some(manager) = MANAGER.get() {
        return Ok(Arc::clone(manager));
    }
    let (client, owner) = prime_client(agent_dir)?;
    let platform = Arc::new(platform::PrimePlatform::new(client, agent_dir, owner));
    let manager = Arc::new(BotManager::new(agent_dir, platform)?);
    Ok(Arc::clone(MANAGER.get_or_init(|| manager)))
}

/// The Prime client bots use, and the fingerprint of its account key.
///
/// # Errors
/// Returns an error when no Prime credential is configured.
pub fn prime_client(agent_dir: &Path) -> Result<(PrimeSandboxClient, String)> {
    let mut auth = AuthStorage::create(agent_dir);
    let api_key = auth.get_api_key("prime-inference").ok_or_else(|| {
        anyhow!("Bots need a Prime API key. Log in to Prime Inference or set PRIME_API_KEY.")
    })?;
    // The team that pairs with the effective key (`PRIME_TEAM_ID` or the stored team).
    let team_id = auth
        .get_provider_headers("prime-inference")
        .and_then(|headers| headers.get("X-Prime-Team-ID").cloned());
    let client = PrimeSandboxClient::new(
        &api_key,
        ClientOptions {
            base_url: DEFAULT_BASE_URL.to_string(),
            team_id,
            request_timeout: None,
            allow_insecure_localhost: false,
        },
    )?;
    Ok((client, github::owner_fingerprint(&api_key)))
}
