//! The guest end of a bot's parent edge. A guest daemon started with
//! `PRIME_AGENT_REMOTE_PARENT=<owner name>` shows one parent family member.
//! A send to that member appends one line to `remote-parent.jsonl` in the
//! agent dir and answers `queued`. The owner's daemon reads the file over the
//! link (`read_remote_parent`) and delivers each line at most once. A line's
//! sequence number is its 1-based line index: the file only grows.

use std::io::Write;
use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};

pub const REMOTE_PARENT_ENV: &str = "PRIME_AGENT_REMOTE_PARENT";
/// The parent name a bot sees for its owner.
pub const REMOTE_PARENT_NAME: &str = "owner";
/// The family member id of the remote parent inside the guest.
pub const REMOTE_PARENT_TARGET: &str = "remote-parent";
const OUTBOX_FILE: &str = "remote-parent.jsonl";
/// The most lines one read answers: a backlog is read in pages, so one
/// answer never outgrows a link frame.
pub const READ_PAGE_LINES: usize = 64;

/// The owner's name when this daemon runs inside a bot.
#[must_use]
pub fn remote_parent_name() -> Option<String> {
    std::env::var(REMOTE_PARENT_ENV)
        .ok()
        .filter(|name| !name.trim().is_empty())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteParentEntry {
    #[serde(default)]
    pub seq: u64,
    pub id: String,
    pub message: String,
    pub at_ms: u64,
}

/// Append one message for the owner, durable before it returns.
///
/// # Errors
///
/// Returns an error when the outbox file cannot be written or synced.
pub fn append(agent_dir: &Path, message: &str) -> Result<RemoteParentEntry> {
    let entry = RemoteParentEntry {
        seq: 0,
        id: format!("botmsg_{}", uuid::Uuid::new_v4()),
        message: message.to_string(),
        at_ms: crate::util::now_ms(),
    };
    let mut line = serde_json::to_value(&entry)?;
    if let Some(object) = line.as_object_mut() {
        object.remove("seq");
    }
    let path = agent_dir.join(OUTBOX_FILE);
    // A line a crash tore keeps no newline: start on a fresh line so only
    // the torn line is lost.
    let torn =
        std::fs::read(&path).is_ok_and(|bytes| bytes.last().is_some_and(|byte| *byte != b'\n'));
    let created = !path.exists();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    // One write per line: O_APPEND keeps concurrent writers' lines whole.
    let prefix = if torn { "\n" } else { "" };
    file.write_all(format!("{prefix}{line}\n").as_bytes())?;
    file.sync_all()?;
    // The first line also makes the new file's directory entry durable.
    if created {
        pa_core::platform::fs::sync_directory(agent_dir)?;
    }
    Ok(entry)
}

/// At most [`READ_PAGE_LINES`] entries after `after_seq`. Only
/// newline-terminated lines count, so a line torn by a crash never takes a
/// sequence number.
///
/// # Errors
///
/// Returns an error when the outbox file exists but cannot be read.
pub fn read_after(agent_dir: &Path, after_seq: u64) -> Result<Vec<RemoteParentEntry>> {
    let bytes = match std::fs::read(agent_dir.join(OUTBOX_FILE)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    // Each line parses alone: a torn line loses only itself.
    Ok(bytes
        .split_inclusive(|byte| *byte == b'\n')
        .filter(|line| line.last() == Some(&b'\n'))
        .zip(1u64..)
        .filter(|(_, seq)| *seq > after_seq)
        .filter_map(|(line, seq)| {
            let entry: RemoteParentEntry = serde_json::from_slice(line).ok()?;
            Some(RemoteParentEntry { seq, ..entry })
        })
        .take(READ_PAGE_LINES)
        .collect())
}
