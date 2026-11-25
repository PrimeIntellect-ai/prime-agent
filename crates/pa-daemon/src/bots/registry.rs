//! The bot registry: a private JSON cache of [`BotRecord`]s in the agent dir.
//!
//! Platform labels are the source of truth. The manager rebuilds this cache
//! from labels at boot ([`super::BotManager::reconcile_on_boot`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// A bot's lifecycle state, mapped from the sandbox status.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BotStatus {
    /// The sandbox is pending or provisioning.
    Creating,
    /// The sandbox runs.
    Running,
    /// The sandbox is paused.
    Paused,
    /// No sandbox runs (terminated or timed out); a checkpoint may restore it.
    #[default]
    Stopped,
    /// The sandbox failed.
    Error,
}

impl BotStatus {
    /// The wire name.
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Creating => "creating",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Stopped => "stopped",
            Self::Error => "error",
        }
    }

    /// True when no live sandbox backs this state.
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Stopped | Self::Error)
    }
}

/// One bot, as the Mac daemon knows it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotRecord {
    pub bot_id: String,
    /// The rlm spawn name.
    pub name: String,
    /// The owner's durable session id.
    pub owner_session_id: String,
    /// The owner's active session id; a cache only.
    #[serde(default)]
    pub owner_active_session_id: Option<String>,
    #[serde(default)]
    pub sandbox_id: Option<String>,
    pub status: BotStatus,
    /// The newest checkpoint of this bot; it may still be uploading.
    #[serde(default)]
    pub checkpoint_id: Option<String>,
    /// Older checkpoints kept until a newer one is durable, oldest first.
    #[serde(default)]
    pub older_checkpoint_ids: Vec<String>,
    /// The prime-agent version installed in the guest.
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub thinking: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds of the last settled turn.
    #[serde(default)]
    pub last_turn_at: Option<i64>,
    /// The bot session's active id inside the guest daemon.
    #[serde(default)]
    pub guest_session_id: String,
    /// The bot session's file inside the guest; a restarted guest daemon reopens it.
    #[serde(default)]
    pub guest_session_file: Option<String>,
    /// How many sandboxes this bot lost; part of the create idempotency key.
    #[serde(default)]
    pub generation: u32,
    /// GitHub access through the platform's header rules. Every new
    /// sandbox of the bot gets the same rules.
    #[serde(default)]
    pub github: bool,
    /// The git author the bot commits as.
    #[serde(default)]
    pub git_identity: Option<pa_core::settings::BotGitIdentity>,
    /// The owner's subscription logins the bot's rules inject; the
    /// refresher keeps them fresh while the bot runs.
    #[serde(default)]
    pub logins: Vec<String>,
    /// The per-bot token of the relay pause endpoint: a platform secret
    /// the relay verifies, injected on the bot's pause request outside
    /// the sandbox. `None` until a wake with a relay configured.
    #[serde(default)]
    pub pause_token: Option<String>,
    /// The relay host the sandbox's rules carry; `None` while they carry
    /// no relay rule. A wake whose relay host differs pushes fresh rules.
    #[serde(default)]
    pub pause_rule_host: Option<String>,
    /// The bot may spawn its own bots (the `bots=True` spawn flag).
    #[serde(default)]
    pub bots: bool,
    /// The bot that spawned this one, when a bot did; `None` for the
    /// owner's own bots.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_bot_id: Option<String>,
    /// When this daemon pauses the idle bot, from the bot's own daemon
    /// (a merged child row); `None` for this daemon's own bots.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_at: Option<i64>,
    /// Unix milliseconds of the last status change.
    #[serde(default)]
    pub status_since: Option<i64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    bots: BTreeMap<String, BotRecord>,
    /// Checkpoints to delete; tracked before each delete, so boot reconcile
    /// retries the ones a failure or an exit left behind.
    #[serde(default)]
    orphaned_checkpoints: Vec<String>,
}

/// The on-disk cache. Callers serialize access (the manager holds it in a mutex).
#[derive(Debug)]
pub struct BotRegistry {
    path: PathBuf,
    file: RegistryFile,
}

impl BotRegistry {
    /// The registry file under `agent_dir`.
    #[must_use]
    pub fn path_in(agent_dir: &Path) -> PathBuf {
        agent_dir.join("bots").join("registry.json")
    }

    /// Load the cache; a missing file is an empty registry.
    ///
    /// # Errors
    /// Returns an error when the file exists but cannot be read or parsed.
    pub fn load(agent_dir: &Path) -> Result<Self> {
        let path = Self::path_in(agent_dir);
        let file = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<RegistryFile>(&text)
                .with_context(|| format!("parse {}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => RegistryFile::default(),
            Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
        };
        Ok(Self { path, file })
    }

    #[must_use]
    pub fn get(&self, bot_id: &str) -> Option<&BotRecord> {
        self.file.bots.get(bot_id)
    }

    #[must_use]
    pub fn all(&self) -> Vec<BotRecord> {
        self.file.bots.values().cloned().collect()
    }

    /// Insert or replace one record and persist.
    ///
    /// # Errors
    /// Returns an error when the file cannot be written.
    pub fn put(&mut self, record: BotRecord) -> Result<()> {
        self.file.bots.insert(record.bot_id.clone(), record);
        self.save()
    }

    /// Remove one record and persist.
    ///
    /// # Errors
    /// Returns an error when the file cannot be written.
    pub fn remove(&mut self, bot_id: &str) -> Result<()> {
        if self.file.bots.remove(bot_id).is_some() {
            self.save()?;
        }
        Ok(())
    }

    /// Track checkpoints to delete, and persist. A checkpoint stays tracked
    /// until [`Self::remove_orphan`] confirms its delete.
    ///
    /// # Errors
    /// Returns an error when the file cannot be written.
    pub fn add_orphans(&mut self, checkpoints: &[String]) -> Result<()> {
        if checkpoints.is_empty() {
            return Ok(());
        }
        self.file
            .orphaned_checkpoints
            .extend_from_slice(checkpoints);
        self.save()
    }

    /// Stop tracking a deleted checkpoint, and persist.
    ///
    /// # Errors
    /// Returns an error when the file cannot be written.
    pub fn remove_orphan(&mut self, checkpoint: &str) -> Result<()> {
        self.file
            .orphaned_checkpoints
            .retain(|tracked| tracked != checkpoint);
        self.save()
    }

    /// The checkpoints still waiting for a delete.
    #[must_use]
    pub fn orphans(&self) -> Vec<String> {
        self.file.orphaned_checkpoints.clone()
    }

    fn save(&self) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            pa_core::platform::perms::create_dir_all_private(dir)?;
        }
        let text = serde_json::to_string_pretty(&self.file)?;
        crate::descriptor::write_file_atomic(&self.path, &text)
    }
}
