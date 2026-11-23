//! The bot registry: a private JSON cache of [`BotRecord`]s in the agent dir.
//!
//! Platform labels are the source of truth. The manager rebuilds this cache
//! from labels at boot ([`super::BotManager::reconcile_on_boot`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// A bot's lifecycle state, mapped from the sandbox status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BotStatus {
    /// The sandbox is pending or provisioning.
    Creating,
    /// The sandbox runs.
    Running,
    /// The sandbox is paused.
    Paused,
    /// No sandbox runs (terminated or timed out); a checkpoint may restore it.
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    /// The newest durable checkpoint that can restore this bot.
    #[serde(default)]
    pub checkpoint_id: Option<String>,
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
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RegistryFile {
    bots: BTreeMap<String, BotRecord>,
}

/// The on-disk cache. Callers serialize access (the manager holds it in a mutex).
#[derive(Debug)]
pub struct BotRegistry {
    path: PathBuf,
    bots: BTreeMap<String, BotRecord>,
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
        let bots = match std::fs::read_to_string(&path) {
            Ok(text) => {
                serde_json::from_str::<RegistryFile>(&text)
                    .with_context(|| format!("parse {}", path.display()))?
                    .bots
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
        };
        Ok(Self { path, bots })
    }

    #[must_use]
    pub fn get(&self, bot_id: &str) -> Option<&BotRecord> {
        self.bots.get(bot_id)
    }

    #[must_use]
    pub fn all(&self) -> Vec<BotRecord> {
        self.bots.values().cloned().collect()
    }

    /// Insert or replace one record and persist.
    ///
    /// # Errors
    /// Returns an error when the file cannot be written.
    pub fn put(&mut self, record: BotRecord) -> Result<()> {
        self.bots.insert(record.bot_id.clone(), record);
        self.save()
    }

    /// Remove one record and persist.
    ///
    /// # Errors
    /// Returns an error when the file cannot be written.
    pub fn remove(&mut self, bot_id: &str) -> Result<()> {
        if self.bots.remove(bot_id).is_some() {
            self.save()?;
        }
        Ok(())
    }

    fn save(&self) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            pa_core::platform::perms::create_dir_all_private(dir)?;
        }
        let text = serde_json::to_string_pretty(&RegistryFile {
            bots: self.bots.clone(),
        })?;
        crate::descriptor::write_file_atomic(&self.path, &text)
    }
}
