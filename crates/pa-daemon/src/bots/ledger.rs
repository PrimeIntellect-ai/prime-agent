//! The bot delivery ledger: one fsynced JSON document per bot under
//! `<agent_dir>/bots/ledger/<bot_id>.json`, removed with the bot.
//!
//! It keeps two bot-to-owner delivery marks: the last settled turn handed
//! to the owner and the last guest outbox line. A mark is written before
//! its delivery starts, so it never moves back. Owner-to-bot messages need
//! no rows: each send has a fresh id and nothing resends one.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// One process-wide lock orders every ledger read-modify-write.
static LEDGER_LOCK: Mutex<()> = Mutex::new(());

/// The state of one bot-to-owner delivery mark.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeliveryState {
    Sending,
    Sent,
    Uncertain,
    /// A turn whose answer the bot already sent as a message to its owner.
    Replied,
}

/// One bot-to-owner delivery mark: a turn's last assistant row id, or an
/// outbox sequence number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryMark<K> {
    pub key: K,
    pub state: DeliveryState,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LedgerDoc {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    delivered_turn: Option<DeliveryMark<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remote_parent: Option<DeliveryMark<u64>>,
    /// When the latest outbox lines were written (guest clock, ms): a turn
    /// that settles after its own message was delivered still counts as
    /// replied.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    outbox_times: Vec<u64>,
}

/// Outbox write times kept for reply attribution.
const MAX_OUTBOX_TIMES: usize = 64;

/// The bot-to-owner delivery marks of one bot.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DeliveryMarks {
    pub delivered_turn: Option<DeliveryMark<String>>,
    pub remote_parent: Option<DeliveryMark<u64>>,
    pub outbox_times: Vec<u64>,
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

    /// The bot-to-owner delivery marks.
    ///
    /// # Errors
    ///
    /// Returns an error when the ledger file cannot be read or parsed.
    pub fn delivery_marks(&self) -> Result<DeliveryMarks> {
        let _guard = LEDGER_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let doc = self.read()?;
        Ok(DeliveryMarks {
            delivered_turn: doc.delivered_turn,
            remote_parent: doc.remote_parent,
            outbox_times: doc.outbox_times,
        })
    }

    /// Durably set the last delivered turn.
    ///
    /// # Errors
    ///
    /// Returns an error when the ledger cannot be read or written.
    pub fn mark_turn(&self, turn_id: &str, state: DeliveryState) -> Result<()> {
        self.update(|doc| {
            doc.delivered_turn = Some(DeliveryMark {
                key: turn_id.to_string(),
                state,
            });
        })
    }

    /// Durably set the last delivered outbox line.
    ///
    /// # Errors
    ///
    /// Returns an error when the ledger cannot be read or written.
    pub fn mark_remote_parent(&self, seq: u64, state: DeliveryState) -> Result<()> {
        self.update(|doc| {
            doc.remote_parent = Some(DeliveryMark { key: seq, state });
        })
    }

    /// Durably start the delivery of one outbox line and keep its write
    /// time for reply attribution.
    ///
    /// # Errors
    ///
    /// Returns an error when the ledger cannot be read or written.
    pub fn begin_remote_parent(&self, seq: u64, at_ms: u64) -> Result<()> {
        self.update(|doc| {
            doc.remote_parent = Some(DeliveryMark {
                key: seq,
                state: DeliveryState::Sending,
            });
            doc.outbox_times.push(at_ms);
            let excess = doc.outbox_times.len().saturating_sub(MAX_OUTBOX_TIMES);
            doc.outbox_times.drain(..excess);
        })
    }

    /// Remove the ledger of a deleted bot.
    pub fn delete(&self) {
        let _ = std::fs::remove_file(&self.path);
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

    fn update(&self, change: impl FnOnce(&mut LedgerDoc)) -> Result<()> {
        let _guard = LEDGER_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut doc = self.read()?;
        change(&mut doc);
        let content = serde_json::to_string_pretty(&doc)?;
        crate::descriptor::write_file_atomic(&self.path, &content)?;
        if let Some(parent) = self.path.parent() {
            pa_core::platform::fs::sync_directory(parent)
                .with_context(|| format!("sync {}", parent.display()))?;
        }
        Ok(())
    }
}
