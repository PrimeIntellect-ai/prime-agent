//! The bot delivery ledger: one fsynced JSON document per bot under
//! `<agent_dir>/bots/ledger/<bot_id>.json`.
//!
//! Owner-to-bot messages are at most once. Each message id moves
//! `sending -> sent | uncertain`, and the `sending` row is durable before
//! any byte reaches the bot. A row left in `sending` by a killed daemon
//! becomes `uncertain` at recovery. Nothing ever resends a message: a
//! message id that already has a row is refused.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Sent rows kept per bot; older sent rows are pruned on write.
const MAX_SENT_ROWS: usize = 512;

/// One process-wide lock orders every ledger read-modify-write.
static LEDGER_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageState {
    Sending,
    Sent,
    Uncertain,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageRow {
    state: MessageState,
    updated_at_ms: u64,
    /// The daemon process that wrote the row; recovery leaves a live
    /// owner's `sending` row alone.
    #[serde(default)]
    owner_pid: u32,
    #[serde(default)]
    owner_start_id: Option<String>,
}

impl MessageRow {
    fn new(state: MessageState) -> Self {
        let pid = std::process::id();
        Self {
            state,
            updated_at_ms: now_ms(),
            owner_pid: pid,
            owner_start_id: crate::protocol::process_start_id(pid),
        }
    }

    /// Whether the process that wrote this row still runs.
    fn owner_alive(&self) -> bool {
        match (
            &self.owner_start_id,
            crate::protocol::process_start_id(self.owner_pid),
        ) {
            (Some(recorded), Some(current)) => *recorded == current,
            (Some(_), None) => false,
            (None, _) => {
                pa_types::platform::process::is_process_alive(self.owner_pid).unwrap_or(false)
            }
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LedgerDoc {
    #[serde(default)]
    messages: BTreeMap<String, MessageRow>,
}

/// The ledger of one bot.
pub struct BotLedger {
    path: PathBuf,
}

impl BotLedger {
    #[must_use]
    pub fn new(agent_dir: &Path, bot_id: &str) -> Self {
        Self {
            path: agent_dir
                .join("bots")
                .join("ledger")
                .join(format!("{bot_id}.json")),
        }
    }

    /// The recorded state of `msg_id`, if any.
    ///
    /// # Errors
    ///
    /// Returns an error when the ledger file cannot be read or parsed.
    pub fn message_state(&self, msg_id: &str) -> Result<Option<MessageState>> {
        let _guard = LEDGER_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(self.read()?.messages.get(msg_id).map(|row| row.state))
    }

    /// Durably record `msg_id` as `sending`. Call this before any byte
    /// of the message leaves the daemon.
    ///
    /// # Errors
    ///
    /// Returns an error when `msg_id` already has a row (a resend), or
    /// when the ledger cannot be read or written. An unreadable ledger
    /// refuses the send.
    pub fn begin_message(&self, msg_id: &str) -> Result<()> {
        self.update(|doc| {
            if doc.messages.contains_key(msg_id) {
                bail!("message {msg_id} was already handed to the bot; it is never sent again");
            }
            doc.messages
                .insert(msg_id.to_string(), MessageRow::new(MessageState::Sending));
            Ok(())
        })
    }

    /// Durably record the outcome of a `sending` message.
    ///
    /// # Errors
    ///
    /// Returns an error when the ledger cannot be read or written.
    pub fn finish_message(&self, msg_id: &str, state: MessageState) -> Result<()> {
        self.update(|doc| {
            doc.messages
                .insert(msg_id.to_string(), MessageRow::new(state));
            Ok(())
        })
    }

    /// Mark every `sending` row whose writer process is gone as
    /// `uncertain`, and return those ids. Another live daemon on the same
    /// agent directory keeps its rows.
    ///
    /// # Errors
    ///
    /// Returns an error when the ledger cannot be read or written.
    pub fn recover_interrupted(&self) -> Result<Vec<String>> {
        let mut recovered = Vec::new();
        self.update(|doc| {
            for (msg_id, row) in &mut doc.messages {
                if row.state == MessageState::Sending && !row.owner_alive() {
                    row.state = MessageState::Uncertain;
                    row.updated_at_ms = now_ms();
                    recovered.push(msg_id.clone());
                }
            }
            Ok(())
        })?;
        Ok(recovered)
    }

    fn read(&self) -> Result<LedgerDoc> {
        match std::fs::read_to_string(&self.path) {
            Ok(content) => serde_json::from_str(&content)
                .with_context(|| format!("parse bot ledger {}", self.path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(LedgerDoc::default()),
            Err(error) => {
                Err(error).with_context(|| format!("read bot ledger {}", self.path.display()))
            }
        }
    }

    fn update(&self, change: impl FnOnce(&mut LedgerDoc) -> Result<()>) -> Result<()> {
        let _guard = LEDGER_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut doc = self.read()?;
        change(&mut doc)?;
        prune_sent(&mut doc);
        let content = serde_json::to_string_pretty(&doc)?;
        crate::descriptor::write_file_atomic(&self.path, &content)?;
        if let Some(parent) = self.path.parent() {
            pa_core::platform::fs::sync_directory(parent)
                .with_context(|| format!("sync {}", parent.display()))?;
        }
        Ok(())
    }
}

/// What [`recover_all`] did.
#[derive(Debug, Default)]
pub struct Recovery {
    /// `(bot_id, msg_id)` of each send that is `uncertain` now.
    pub uncertain: Vec<(String, String)>,
    /// One error per ledger that could not be read or written; recovery
    /// went on with the other ledgers.
    pub failed: Vec<anyhow::Error>,
}

/// Boot recovery: mark every `sending` row of every bot ledger whose
/// writer process is gone as `uncertain`. The supervisor runs it once
/// at start, after the boot reap. One bad ledger does not stop the
/// recovery of the others.
///
/// # Errors
///
/// Returns an error when the ledger directory cannot be read.
pub fn recover_all(agent_dir: &Path) -> Result<Recovery> {
    let dir = agent_dir.join("bots").join("ledger");
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Recovery::default())
        }
        Err(error) => return Err(error).with_context(|| format!("read {}", dir.display())),
    };
    let mut recovery = Recovery::default();
    for entry in entries {
        let path = match entry {
            Ok(entry) => entry.path(),
            Err(error) => {
                recovery
                    .failed
                    .push(anyhow::Error::new(error).context(format!("read {}", dir.display())));
                continue;
            }
        };
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Some(bot_id) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        match BotLedger::new(agent_dir, bot_id).recover_interrupted() {
            Ok(msg_ids) => recovery.uncertain.extend(
                msg_ids
                    .into_iter()
                    .map(|msg_id| (bot_id.to_string(), msg_id)),
            ),
            Err(error) => recovery.failed.push(error),
        }
    }
    Ok(recovery)
}

fn prune_sent(doc: &mut LedgerDoc) {
    let mut sent: Vec<(u64, String)> = doc
        .messages
        .iter()
        .filter(|(_, row)| row.state == MessageState::Sent)
        .map(|(id, row)| (row.updated_at_ms, id.clone()))
        .collect();
    if sent.len() <= MAX_SENT_ROWS {
        return;
    }
    sent.sort();
    for (_, id) in &sent[..sent.len() - MAX_SENT_ROWS] {
        doc.messages.remove(id);
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}
