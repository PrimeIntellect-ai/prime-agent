//! Append-only recovery journals: the command journal makes supervisor
//! mutations exactly-once (a received record is durable before dispatch; a
//! missing result after a crash is uncertain, never replayed); the worker
//! journal records the latest busy/operation state and queue snapshots.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

const COMPACT_AFTER_RECORDS: usize = 4096;

pub(crate) fn append_record(path: &Path, record: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("open journal {}", path.display()))?;
    let mut line = serde_json::to_string(record)?;
    line.push('\n');
    file.write_all(line.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

/// Append several records as ONE durable write: the batch is
/// all-or-nothing; the on-disk bytes match the records appended one by one.
///
/// # Errors
///
/// Returns an error when the open, serialization, write, or sync fails;
/// the loader skips a partial write's truncated trailing lines.
pub(crate) fn append_records(path: &Path, records: &[Value]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("open journal {}", path.display()))?;
    let mut lines = Vec::new();
    for record in records {
        serde_json::to_writer(&mut lines, record)?;
        lines.push(b'\n');
    }
    file.write_all(&lines)?;
    file.sync_all()?;
    Ok(())
}

/// How the temp journal lands on its path, and whether its data rides a
/// full sync before the swap.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Finalize {
    /// Rename through `rename_onto` (the bounded win32 destination-busy
    /// retry), temp synced before the swap.
    RetryBusy,
    /// Bare rename, temp synced before the swap: every failure surfaces
    /// immediately.
    Synced,
    /// Bare rename with an UNSYNCED temp: durability is owned by the
    /// append path — a lost compact falls back to the append-only history.
    Bare,
}

pub(crate) fn rewrite_records(path: &Path, records: &[Value], finalize: Finalize) -> Result<()> {
    let temp = path.with_extension(format!("jsonl.tmp-{}", std::process::id()));
    {
        let file = File::create(&temp).with_context(|| format!("create {}", temp.display()))?;
        let mut writer = BufWriter::new(file);
        for record in records {
            let mut line = serde_json::to_string(record)?;
            line.push('\n');
            writer.write_all(line.as_bytes())?;
        }
        writer.flush()?;
        if !matches!(finalize, Finalize::Bare) {
            writer.get_ref().sync_all()?;
        }
    }
    let rename = match finalize {
        Finalize::RetryBusy => pa_core::platform::rename_onto(&temp, path),
        Finalize::Synced | Finalize::Bare => fs::rename(&temp, path),
    };
    rename.with_context(|| format!("persist {}", path.display()))?;
    Ok(())
}

pub(crate) fn tail_is_torn(path: &Path) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    if !file.metadata().is_ok_and(|metadata| metadata.len() > 0) {
        return false;
    }
    if file.seek(SeekFrom::End(-1)).is_err() {
        return false;
    }
    let mut tail = [0u8];
    file.read_exact(&mut tail).is_ok() && tail[0] != b'\n'
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandJournalEntry {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<Value>,
}

pub struct CommandRecoveryJournal {
    path: std::path::PathBuf,
    entries: HashMap<String, CommandJournalEntry>,
    record_count: usize,
}

impl CommandRecoveryJournal {
    /// Open the journal at `path`, creating the parent directory as needed.
    ///
    /// # Errors
    ///
    /// Returns an error when the parent directory cannot be created, or
    /// the torn-tail heal cannot rewrite it; a missing journal loads as
    /// empty. Other record-read errors are returned before any rewrite.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut journal = CommandRecoveryJournal {
            path: path.to_path_buf(),
            entries: HashMap::new(),
            record_count: 0,
        };
        journal.load()?;
        if tail_is_torn(path) {
            journal.compact()?;
        }
        Ok(journal)
    }

    fn key(client_id: &str, command_id: &str) -> String {
        serde_json::json!([client_id, command_id]).to_string()
    }

    #[must_use]
    pub fn lookup(&self, client_id: &str, command_id: &str) -> Option<CommandJournalEntry> {
        self.entries.get(&Self::key(client_id, command_id)).cloned()
    }

    /// Record durable receipt before dispatch. Returns the prior state when the
    /// command was already journaled.
    ///
    /// # Errors
    ///
    /// Returns an error when the receipt record cannot be appended.
    pub fn begin(
        &mut self,
        client_id: &str,
        command_id: &str,
        command_type: &str,
    ) -> Result<Option<CommandJournalEntry>> {
        if let Some(existing) = self.lookup(client_id, command_id) {
            return Ok(Some(existing));
        }
        let record = serde_json::json!({
            "version": 1,
            "type": "received",
            "key": Self::key(client_id, command_id),
            "clientId": client_id,
            "commandId": command_id,
            "commandType": command_type,
            "recordedAt": crate::util::now_iso(),
        });
        append_record(&self.path, &record)?;
        self.record_count += 1;
        self.entries.insert(
            Self::key(client_id, command_id),
            CommandJournalEntry {
                status: "pending".to_string(),
                response: None,
            },
        );
        Ok(None)
    }

    /// Record the settled command result; a later replay of the command
    /// answers from it.
    ///
    /// # Errors
    ///
    /// Returns an error when no receipt was journaled, the result record
    /// cannot be appended, or the post-append compaction fails.
    pub fn record_result(
        &mut self,
        client_id: &str,
        command_id: &str,
        response: &Value,
    ) -> Result<()> {
        let key = Self::key(client_id, command_id);
        if !self.entries.contains_key(&key) {
            return Err(anyhow::anyhow!(
                "Cannot record a result before command receipt: {key}"
            ));
        }
        let record = serde_json::json!({
            "version": 1,
            "type": "result",
            "key": key,
            "response": response,
            "recordedAt": crate::util::now_iso(),
        });
        append_record(&self.path, &record)?;
        self.record_count += 1;
        self.entries.insert(
            key,
            CommandJournalEntry {
                status: "complete".to_string(),
                response: Some(response.clone()),
            },
        );
        if self.record_count >= COMPACT_AFTER_RECORDS {
            self.compact()?;
        }
        Ok(())
    }

    /// Acknowledge the command: the durable receipt is no longer needed.
    /// Acknowledging an unknown command is a no-op.
    ///
    /// # Errors
    ///
    /// Returns an error when the acknowledgment record cannot be appended
    /// or the post-acknowledge compaction fails.
    pub fn acknowledge(&mut self, client_id: &str, command_id: &str) -> Result<()> {
        let key = Self::key(client_id, command_id);
        if !self.entries.contains_key(&key) {
            return Ok(());
        }
        let record = serde_json::json!({
            "version": 1,
            "type": "acknowledged",
            "key": key,
            "recordedAt": crate::util::now_iso(),
        });
        append_record(&self.path, &record)?;
        self.entries.remove(&key);
        if self.entries.is_empty() || self.record_count >= COMPACT_AFTER_RECORDS {
            self.compact()?;
        }
        Ok(())
    }

    /// Rewrite the journal as the record grammar `load` replays: a
    /// `received` record for every entry, then the `result` record that
    /// restores a complete entry's cached response.
    fn compact(&mut self) -> Result<()> {
        let mut records = Vec::new();
        for (key, entry) in &self.entries {
            records.push(serde_json::json!({
                "version": 1,
                "type": "received",
                "key": key,
            }));
            if let Some(response) = &entry.response {
                records.push(serde_json::json!({
                    "version": 1,
                    "type": "result",
                    "key": key,
                    "response": response,
                }));
            }
        }
        rewrite_records(&self.path, &records, Finalize::RetryBusy)?;
        self.record_count = records.len();
        Ok(())
    }

    fn load(&mut self) -> Result<()> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("read journal {}", self.path.display()));
            }
        };
        for line in String::from_utf8_lossy(&bytes).lines() {
            if line.is_empty() {
                continue;
            }
            let Ok(record) = serde_json::from_str::<Value>(line) else {
                // A crash may leave only the final append truncated.
                continue;
            };
            if record.get("version").and_then(Value::as_u64) != Some(1) {
                continue;
            }
            self.record_count += 1;
            let key = record
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            match record.get("type").and_then(Value::as_str) {
                Some("received") => {
                    self.entries.insert(
                        key,
                        CommandJournalEntry {
                            status: "pending".to_string(),
                            response: None,
                        },
                    );
                }
                Some("acknowledged") => {
                    self.entries.remove(&key);
                }
                Some("result") => {
                    if let Some(entry) = self.entries.get_mut(&key) {
                        entry.status = "complete".to_string();
                        entry.response = record.get("response").cloned();
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRecoveryRecord {
    pub active_session_id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    pub busy: bool,
    pub operation: String,
    pub recorded_at: String,
}

fn parse_worker_records(path: &Path) -> Result<HashMap<String, WorkerRecoveryRecord>> {
    let mut latest = HashMap::new();
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(latest),
        Err(error) => {
            return Err(error).with_context(|| format!("read journal {}", path.display()));
        }
    };
    for line in String::from_utf8_lossy(&bytes).lines() {
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<WorkerRecoveryRecord>(line) else {
            continue;
        };
        latest.insert(record.active_session_id.clone(), record);
    }
    Ok(latest)
}

/// One parked queue row in a worker queue snapshot: a restored queued
/// heartbeat still delivers as the `heartbeat_prompt` component instead of
/// a plain user message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkerQueueItemRecord {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<crate::worker::QueuePriority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_message: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_key: Option<String>,
    #[serde(default = "queue_visible_default")]
    pub queue_visible: bool,
    /// The item's turn-execution class ("queued"/"injected"/"direct"):
    /// the batch gathering's compatibility gate. A pre-field record
    /// restores as "queued" — the only class a fresh snapshot can batch.
    #[serde(default = "queue_policy_default")]
    pub policy: String,
}

fn queue_visible_default() -> bool {
    true
}

fn queue_policy_default() -> String {
    "queued".to_string()
}

impl WorkerQueueItemRecord {
    /// The record's turn-execution class; an unknown value restores as
    /// the dominant "queued" class.
    pub(crate) fn policy(&self) -> crate::worker::TurnPolicy {
        match self.policy.as_str() {
            "injected" => crate::worker::TurnPolicy::Injected,
            "direct" => crate::worker::TurnPolicy::Direct,
            _ => crate::worker::TurnPolicy::Queued,
        }
    }
}

/// A worker queue snapshot record: the pending steering/follow-up lanes so
/// a respawned worker restores its queues. Version 2 lanes carry the full
/// item records; a version-1 lane is a bare message-text array.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerQueueSnapshotRecord {
    pub version: u32,
    pub r#type: String,
    pub active_session_id: String,
    pub steering: Vec<WorkerQueueItemRecord>,
    pub follow_up: Vec<WorkerQueueItemRecord>,
    pub recorded_at: String,
}

/// Latest busy/operation per active session, plus the latest queue
/// snapshot per session.
pub struct WorkerRecoveryJournal {
    path: std::path::PathBuf,
    latest: HashMap<String, WorkerRecoveryRecord>,
    queue_snapshots: HashMap<String, WorkerQueueSnapshotRecord>,
}

impl WorkerRecoveryJournal {
    /// Open the worker journal at `path`, creating the parent directory as needed.
    ///
    /// # Errors
    ///
    /// Returns an error when the parent directory cannot be created, either
    /// record pass cannot read an existing journal, or the
    /// torn-tail heal cannot rewrite it.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let queue_snapshots = parse_queue_snapshot_records(path)?;
        let journal = WorkerRecoveryJournal {
            path: path.to_path_buf(),
            latest: parse_worker_records(path)?,
            queue_snapshots,
        };
        if tail_is_torn(path) {
            // Recovery can still contain busy verdicts and queued prompts.
            // Sync the replacement before it takes over their durable history.
            journal.compact(Finalize::Synced)?;
        }
        Ok(journal)
    }

    /// Read the latest worker record per active session straight from a
    /// journal file.
    ///
    /// # Errors
    ///
    /// Returns an error when an existing journal cannot be read; a missing
    /// journal reads as an empty set.
    pub fn read_latest(path: &Path) -> Result<Vec<WorkerRecoveryRecord>> {
        Ok(parse_worker_records(path)?.into_values().collect())
    }

    /// Does the journal prove live work at the worker's last exit? A
    /// restart must not mass-revive historical sessions: a latest `busy`
    /// record marks in-flight work; an unreadable journal proves nothing.
    #[must_use]
    pub fn read_interrupted(path: &Path) -> bool {
        Self::read_latest(path).is_ok_and(|records| records.iter().any(|record| record.busy))
    }

    /// The newest `busy` record's `recorded_at`, when the journal proves
    /// live work: the timestamp the boot-revival gate ages the evidence against.
    #[must_use]
    pub fn latest_busy_recorded_at(path: &Path) -> Option<String> {
        Self::read_latest(path)
            .ok()?
            .iter()
            .filter(|record| record.busy)
            .map(|record| record.recorded_at.clone())
            .max()
    }

    /// Settle every busy session to idle with `operation` (the give-up
    /// belt): stale busy evidence must not outlive the give-up that
    /// superseded it, or every boot re-storms the slot.
    ///
    /// # Errors
    ///
    /// Returns an error when the journal cannot be opened or a settle record cannot be appended.
    pub fn settle_busy_records(path: &Path, operation: &str) -> Result<()> {
        let mut journal = Self::open(path)?;
        let busy: Vec<WorkerRecoveryRecord> = journal
            .get_latest()
            .into_iter()
            .filter(|record| record.busy)
            .collect();
        for record in busy {
            journal.record(
                &record.active_session_id,
                &record.session_id,
                record.session_file.as_deref(),
                false,
                operation,
            )?;
        }
        Ok(())
    }

    /// Record the latest busy/operation state for an active session; an
    /// unchanged record is skipped.
    ///
    /// # Errors
    ///
    /// Returns an error when the record cannot be serialized or appended,
    /// or the all-idle compaction fails.
    pub fn record(
        &mut self,
        active_session_id: &str,
        session_id: &str,
        session_file: Option<&str>,
        busy: bool,
        operation: &str,
    ) -> Result<()> {
        if let Some(previous) = self.latest.get(active_session_id) {
            if previous.busy == busy
                && previous.operation == operation
                && previous.session_file.as_deref() == session_file
            {
                return Ok(());
            }
        }
        let record = WorkerRecoveryRecord {
            active_session_id: active_session_id.to_string(),
            session_id: session_id.to_string(),
            session_file: session_file.map(str::to_string),
            busy,
            operation: operation.to_string(),
            recorded_at: crate::util::now_iso(),
        };
        append_record(&self.path, &serde_json::to_value(&record)?)?;
        self.latest.insert(active_session_id.to_string(), record);
        // TS parity: the all-idle check runs AFTER the insert (TS checks
        // after `set`); checking before it, a single-session journal never
        // compacted.
        if self.latest.values().all(|entry| !entry.busy) {
            self.compact(Finalize::Bare)?;
        }
        Ok(())
    }

    #[must_use]
    pub fn get_latest(&self) -> Vec<WorkerRecoveryRecord> {
        self.latest.values().cloned().collect()
    }

    /// Persist the pending queue lanes; latest record wins per session.
    ///
    /// # Errors
    ///
    /// Returns an error when the snapshot record cannot be serialized or appended.
    pub fn record_queue_snapshot(
        &mut self,
        active_session_id: &str,
        steering: &[WorkerQueueItemRecord],
        follow_up: &[WorkerQueueItemRecord],
    ) -> Result<()> {
        let record = WorkerQueueSnapshotRecord {
            version: QUEUE_SNAPSHOT_VERSION,
            r#type: QUEUE_SNAPSHOT_RECORD_TYPE.to_string(),
            active_session_id: active_session_id.to_string(),
            steering: steering.to_vec(),
            follow_up: follow_up.to_vec(),
            recorded_at: crate::util::now_iso(),
        };
        append_record(&self.path, &serde_json::to_value(&record)?)?;
        self.queue_snapshots
            .insert(active_session_id.to_string(), record);
        Ok(())
    }

    /// Record the queue snapshot and the busy/operation verdict in ONE
    /// durable append: the verdict never publishes over a snapshot that
    /// did not persist.
    ///
    /// # Errors
    ///
    /// Returns an error when either record cannot be serialized, the
    /// batched append fails, or the all-idle compaction fails.
    #[allow(clippy::too_many_arguments)]
    pub fn record_queue_checkpoint(
        &mut self,
        active_session_id: &str,
        session_id: &str,
        session_file: Option<&str>,
        busy: bool,
        operation: &str,
        steering: &[WorkerQueueItemRecord],
        follow_up: &[WorkerQueueItemRecord],
    ) -> Result<()> {
        let snapshot = WorkerQueueSnapshotRecord {
            version: QUEUE_SNAPSHOT_VERSION,
            r#type: QUEUE_SNAPSHOT_RECORD_TYPE.to_string(),
            active_session_id: active_session_id.to_string(),
            steering: steering.to_vec(),
            follow_up: follow_up.to_vec(),
            recorded_at: crate::util::now_iso(),
        };
        let verdict_unchanged = self.latest.get(active_session_id).is_some_and(|previous| {
            previous.busy == busy
                && previous.operation == operation
                && previous.session_file.as_deref() == session_file
        });
        let record = if verdict_unchanged {
            None
        } else {
            Some(WorkerRecoveryRecord {
                active_session_id: active_session_id.to_string(),
                session_id: session_id.to_string(),
                session_file: session_file.map(str::to_string),
                busy,
                operation: operation.to_string(),
                recorded_at: crate::util::now_iso(),
            })
        };
        let mut batch = Vec::with_capacity(2);
        batch.push(serde_json::to_value(&snapshot)?);
        if let Some(record) = &record {
            batch.push(serde_json::to_value(record)?);
        }
        append_records(&self.path, &batch)?;
        self.queue_snapshots
            .insert(active_session_id.to_string(), snapshot);
        if let Some(record) = record {
            self.latest.insert(active_session_id.to_string(), record);
            // TS parity (same post-insert check as `record`): the
            // compaction fires on the all-idle map including the verdict.
            if self.latest.values().all(|entry| !entry.busy) {
                self.compact(Finalize::Bare)?;
            }
        }
        Ok(())
    }

    /// The latest persisted queue rows for `active_session_id`.
    #[must_use]
    pub fn latest_queue_snapshot(
        &self,
        active_session_id: &str,
    ) -> Option<(Vec<WorkerQueueItemRecord>, Vec<WorkerQueueItemRecord>)> {
        self.queue_snapshots
            .get(active_session_id)
            .map(|record| (record.steering.clone(), record.follow_up.clone()))
    }

    /// Read the latest queue snapshot for a session straight from a journal
    /// file (worker restore on a fresh process).
    ///
    /// # Errors
    ///
    /// Returns an error when the journal exists but cannot be read (a
    /// missing journal answers `Ok(None)`).
    pub fn read_queue_snapshot(
        path: &Path,
        active_session_id: &str,
    ) -> Result<Option<(Vec<WorkerQueueItemRecord>, Vec<WorkerQueueItemRecord>)>> {
        Ok(parse_queue_snapshot_records(path)?
            .remove(active_session_id)
            .map(|record| (record.steering, record.follow_up)))
    }

    fn compact(&self, finalize: Finalize) -> Result<()> {
        let mut records: Vec<Value> = self
            .latest
            .values()
            .map(serde_json::to_value)
            .collect::<std::result::Result<_, _>>()?;
        let snapshots: Vec<Value> = self
            .queue_snapshots
            .values()
            .map(serde_json::to_value)
            .collect::<std::result::Result<_, _>>()?;
        records.extend(snapshots);
        rewrite_records(&self.path, &records, finalize)
    }
}

const QUEUE_SNAPSHOT_RECORD_TYPE: &str = "queue_snapshot";
/// The current queue-snapshot record version: the lanes carry the full
/// item records.
const QUEUE_SNAPSHOT_VERSION: u32 = 2;

fn parse_queue_snapshot_records(path: &Path) -> Result<HashMap<String, WorkerQueueSnapshotRecord>> {
    let mut latest: HashMap<String, WorkerQueueSnapshotRecord> = HashMap::new();
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(latest),
        Err(error) => {
            return Err(error).with_context(|| format!("read journal {}", path.display()))
        }
    };
    for line in String::from_utf8_lossy(&bytes)
        .split('\n')
        .filter(|line| !line.is_empty())
    {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some(QUEUE_SNAPSHOT_RECORD_TYPE) {
            continue;
        }
        let version = record.get("version").and_then(Value::as_u64);
        if version != Some(1) && version != Some(u64::from(QUEUE_SNAPSHOT_VERSION)) {
            continue;
        }
        let Some(active_session_id) = record.get("active_session_id").and_then(Value::as_str)
        else {
            continue;
        };
        let entry = WorkerQueueSnapshotRecord {
            version: QUEUE_SNAPSHOT_VERSION,
            r#type: QUEUE_SNAPSHOT_RECORD_TYPE.to_string(),
            active_session_id: active_session_id.to_string(),
            steering: parse_snapshot_lane(record.get("steering")),
            follow_up: parse_snapshot_lane(record.get("follow_up")),
            recorded_at: record
                .get("recorded_at")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        };
        latest.insert(active_session_id.to_string(), entry);
    }
    Ok(latest)
}

/// One snapshot lane: a version-2 entry is the full item record; a
/// version-1 entry is the bare message text and restores as a plain row.
fn parse_snapshot_lane(value: Option<&Value>) -> Vec<WorkerQueueItemRecord> {
    value
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| match entry {
                    Value::String(message) => Some(WorkerQueueItemRecord {
                        message: message.clone(),
                        priority: None,
                        preview: None,
                        custom_message: None,
                        queue_key: None,
                        queue_visible: true,
                        policy: queue_policy_default(),
                    }),
                    Value::Object(_) => serde_json::from_value(entry.clone()).ok(),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pa-daemon-journal-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn command_journal_survives_restart_with_uncertainty() {
        let path = temp_path("command-journal.jsonl");
        let mut journal = CommandRecoveryJournal::open(&path).unwrap();
        assert!(journal.begin("client", "c1", "create").unwrap().is_none());
        let response =
            serde_json::json!({"type": "response", "command": "create", "success": true});
        journal.record_result("client", "c1", &response).unwrap();

        let mut reloaded = CommandRecoveryJournal::open(&path).unwrap();
        let entry = reloaded.lookup("client", "c1").unwrap();
        assert_eq!(entry.status, "complete");
        assert_eq!(entry.response, Some(response));

        // Pending (received, no result) is reported but not replayed.
        reloaded.begin("client", "c2", "kill").unwrap();
        let reloaded2 = CommandRecoveryJournal::open(&path).unwrap();
        assert_eq!(reloaded2.lookup("client", "c2").unwrap().status, "pending");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn journal_read_failures_are_not_empty_recovery_state() {
        let path = temp_path("unreadable.jsonl");
        fs::create_dir_all(&path).unwrap();
        let sentinel = path.join("preserve");
        fs::write(&sentinel, b"original data").unwrap();

        assert!(CommandRecoveryJournal::open(&path).is_err());
        assert!(parse_worker_records(&path).is_err());
        assert!(WorkerRecoveryJournal::open(&path).is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"original data");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn command_journal_open_heals_torn_tail_keeping_results() {
        let path = temp_path("torn-tail.command.jsonl");
        let mut journal = CommandRecoveryJournal::open(&path).unwrap();
        journal.begin("client", "c1", "create").unwrap();
        let response =
            serde_json::json!({"type": "response", "command": "create", "success": true});
        journal.record_result("client", "c1", &response).unwrap();
        journal.begin("client", "c2", "kill").unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(br#"{"version":1,"type":"res"#).unwrap();
        drop(file);

        // The first open heals the torn tail; the reload proves the heal
        // kept the completed command's cached result.
        let _healed = CommandRecoveryJournal::open(&path).unwrap();
        let reloaded = CommandRecoveryJournal::open(&path).unwrap();
        let entry = reloaded.lookup("client", "c1").unwrap();
        assert_eq!(entry.status, "complete");
        assert_eq!(entry.response, Some(response));
        assert_eq!(reloaded.lookup("client", "c2").unwrap().status, "pending");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn worker_journal_keeps_latest_per_session() {
        let path = temp_path("worker.recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal
            .record("s1", "sess1", Some("/a.jsonl"), true, "prompt")
            .unwrap();
        journal.record("s2", "sess2", None, false, "ready").unwrap();
        journal
            .record("s1", "sess1", Some("/a.jsonl"), false, "idle")
            .unwrap();
        let latest = WorkerRecoveryJournal::read_latest(&path).unwrap();
        assert_eq!(latest.len(), 2);
        let s1 = latest.iter().find(|r| r.active_session_id == "s1").unwrap();
        assert!(!s1.busy);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn worker_journal_interrupted_evidence_tracks_latest_busy() {
        let path = temp_path("interrupted.recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal
            .record("s1", "sess1", None, false, "shutdown")
            .unwrap();
        journal.record("s2", "sess2", None, false, "ready").unwrap();
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        journal
            .record("s2", "sess2", Some("/b.jsonl"), true, "create")
            .unwrap();
        assert!(WorkerRecoveryJournal::read_interrupted(&path));
        journal
            .record("s2", "sess2", None, false, "shutdown")
            .unwrap();
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn worker_journal_batched_checkpoint_matches_sequential_form() {
        let sequential_path = temp_path("sequential.recovery.jsonl");
        let batched_path = temp_path("batched.recovery.jsonl");
        let mut sequential = WorkerRecoveryJournal::open(&sequential_path).unwrap();
        let mut batched = WorkerRecoveryJournal::open(&batched_path).unwrap();
        let item = WorkerQueueItemRecord {
            message: "steer me".to_string(),
            priority: Some(crate::worker::QueuePriority::Human),
            preview: Some("preview".to_string()),
            custom_message: None,
            queue_key: None,
            queue_visible: true,
            policy: queue_policy_default(),
        };
        sequential
            .record_queue_snapshot("s1", std::slice::from_ref(&item), &[])
            .unwrap();
        sequential
            .record("s1", "sess1", Some("/a.jsonl"), true, "prompt_accepted")
            .unwrap();
        sequential.record_queue_snapshot("s1", &[], &[]).unwrap();
        sequential
            .record("s1", "sess1", Some("/a.jsonl"), false, "turn_end")
            .unwrap();
        sequential.record_queue_snapshot("s1", &[], &[]).unwrap();
        sequential
            .record("s1", "sess1", Some("/a.jsonl"), false, "turn_end")
            .unwrap();
        batched
            .record_queue_checkpoint(
                "s1",
                "sess1",
                Some("/a.jsonl"),
                true,
                "prompt_accepted",
                std::slice::from_ref(&item),
                &[],
            )
            .unwrap();
        batched
            .record_queue_checkpoint("s1", "sess1", Some("/a.jsonl"), false, "turn_end", &[], &[])
            .unwrap();
        batched
            .record_queue_checkpoint("s1", "sess1", Some("/a.jsonl"), false, "turn_end", &[], &[])
            .unwrap();

        let strip_stamps = |path: &std::path::Path| -> Vec<Value> {
            std::fs::read_to_string(path)
                .unwrap()
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| {
                    let mut value: Value = serde_json::from_str(line).unwrap();
                    if let Some(object) = value.as_object_mut() {
                        object.remove("recordedAt");
                        object.remove("recorded_at");
                    }
                    value
                })
                .collect()
        };
        assert_eq!(
            strip_stamps(&sequential_path),
            strip_stamps(&batched_path),
            "the batched checkpoint writes the same journal lines as the sequential form"
        );
        let latest_a = sequential.get_latest();
        let latest_b = batched.get_latest();
        assert_eq!(latest_a.len(), latest_b.len());
        assert_eq!(latest_a[0].busy, latest_b[0].busy);
        assert_eq!(latest_a[0].operation, latest_b[0].operation);
        let restored = WorkerRecoveryJournal::read_queue_snapshot(&batched_path, "s1").unwrap();
        assert_eq!(restored, Some((Vec::new(), Vec::new())));
        let _ = fs::remove_dir_all(sequential_path.parent().unwrap());
        let _ = fs::remove_dir_all(batched_path.parent().unwrap());
    }

    #[test]
    fn worker_journal_batched_checkpoint_is_all_or_nothing() {
        let path = temp_path("allornothing.recovery.jsonl");
        fs::write(&path, "").unwrap();
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal.record("s1", "sess1", None, false, "ready").unwrap();
        // Replace the journal with a directory: every append open now fails.
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        let result =
            journal.record_queue_checkpoint("s1", "sess1", None, true, "prompt_accepted", &[], &[]);
        assert!(result.is_err());
        assert!(journal.latest.get("s1").is_some_and(|record| !record.busy));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// TS parity oracle: TS compacts at every changed-idle record, and so
    /// does the port.
    #[test]
    fn worker_journal_settle_compacts_single_session() {
        let path = temp_path("settle-compacts.recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal
            .record("s1", "sess1", Some("/a.jsonl"), true, "prompt_accepted")
            .unwrap();
        journal
            .record("s1", "sess1", Some("/a.jsonl"), false, "turn_end")
            .unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap().lines().count(),
            1,
            "the first settle compacted to the latest record"
        );
        journal
            .record("s1", "sess1", Some("/a.jsonl"), true, "prompt_accepted")
            .unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap().lines().count(),
            2,
            "the second admission grows the compacted file"
        );
        journal
            .record("s1", "sess1", Some("/a.jsonl"), false, "turn_end")
            .unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 1, "the settle compacts to the latest record");
        let record: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(record["busy"], false);
        assert_eq!(record["operation"], "turn_end");
        let reopened = WorkerRecoveryJournal::open(&path).unwrap();
        let latest = reopened.get_latest();
        assert_eq!(latest.len(), 1);
        assert!(!latest[0].busy);
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn worker_journal_batched_settle_compacts_and_restores() {
        let path = temp_path("batched-settle.recovery.jsonl");
        let item = WorkerQueueItemRecord {
            message: "steer me".to_string(),
            priority: Some(crate::worker::QueuePriority::Human),
            preview: Some("preview".to_string()),
            custom_message: None,
            queue_key: None,
            queue_visible: true,
            policy: queue_policy_default(),
        };
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal
            .record_queue_checkpoint(
                "s1",
                "sess1",
                Some("/a.jsonl"),
                true,
                "prompt_accepted",
                std::slice::from_ref(&item),
                &[],
            )
            .unwrap();
        journal
            .record_queue_checkpoint("s1", "sess1", Some("/a.jsonl"), false, "turn_end", &[], &[])
            .unwrap();
        let after_first_settle = fs::read_to_string(&path).unwrap().lines().count();
        journal
            .record_queue_checkpoint(
                "s1",
                "sess1",
                Some("/a.jsonl"),
                true,
                "prompt_accepted",
                std::slice::from_ref(&item),
                &[],
            )
            .unwrap();
        let after_second_admission = fs::read_to_string(&path).unwrap().lines().count();
        journal
            .record_queue_checkpoint("s1", "sess1", Some("/a.jsonl"), false, "turn_end", &[], &[])
            .unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 2, "the settle compacts to verdict + snapshot");
        assert_eq!(after_first_settle, 2, "the first settle compacted");
        assert_eq!(
            after_second_admission, 4,
            "the second admission grew the file"
        );
        let verdict: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(verdict["busy"], false);
        assert_eq!(verdict["operation"], "turn_end");
        let snapshot: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(snapshot["type"], "queue_snapshot");
        // the compact keeps the LATEST snapshot per session: the
        // settle's (empty) lanes, not the admission's parked row.
        assert_eq!(snapshot["steering"].as_array().map(Vec::len), Some(0));
        let reopened = WorkerRecoveryJournal::open(&path).unwrap();
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        let restored = reopened.latest_queue_snapshot("s1").unwrap();
        assert_eq!(restored.0, Vec::new());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// An unchanged verdict appends the snapshot alone and never compacts
    /// (TS `record` early-returns before its compaction check).
    #[test]
    fn worker_journal_unchanged_verdict_does_not_compact() {
        let path = temp_path("unchanged-nocompact.recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal
            .record_queue_checkpoint("s1", "sess1", None, true, "prompt_accepted", &[], &[])
            .unwrap();
        journal
            .record_queue_checkpoint("s1", "sess1", None, false, "turn_end", &[], &[])
            .unwrap();
        let lines_after_settle = fs::read_to_string(&path).unwrap().lines().count();
        journal
            .record_queue_checkpoint("s1", "sess1", None, false, "turn_end", &[], &[])
            .unwrap();
        let lines_after_unchanged = fs::read_to_string(&path).unwrap().lines().count();
        assert_eq!(lines_after_unchanged, lines_after_settle + 1);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn worker_journal_missing_or_unreadable_file_is_not_interrupted() {
        let path = temp_path("missing.recovery.jsonl");
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        std::fs::write(&path, "not json").unwrap();
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn worker_journal_open_skips_torn_utf8_tail() {
        let path = temp_path("torn-utf8-tail.recovery.jsonl");
        let item = WorkerQueueItemRecord {
            message: "steer ünïcode".to_string(),
            priority: Some(crate::worker::QueuePriority::Human),
            preview: Some("preview".to_string()),
            custom_message: None,
            queue_key: None,
            queue_visible: true,
            policy: queue_policy_default(),
        };
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal
            .record_queue_checkpoint(
                "s1",
                "sess1",
                Some("/a.jsonl"),
                true,
                "prompt_accepted",
                std::slice::from_ref(&item),
                &[],
            )
            .unwrap();
        let whole = serde_json::to_string(&WorkerRecoveryRecord {
            active_session_id: "s2".to_string(),
            session_id: "sess2".to_string(),
            session_file: None,
            busy: false,
            operation: "shütdown".to_string(),
            recorded_at: "2026-10-07T00:00:00Z".to_string(),
        })
        .unwrap();
        let torn = &whole.as_bytes()[..=whole.find('ü').unwrap()];
        assert!(std::str::from_utf8(torn).is_err());
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(torn).unwrap();
        drop(file);

        let mut healed = WorkerRecoveryJournal::open(&path).unwrap();
        // Reload after a fresh append so the assertions exercise the healed
        // file, rather than only the state loaded before the rewrite.
        healed
            .record("s1", "sess1", Some("/a.jsonl"), true, "resumed")
            .unwrap();
        let reopened = WorkerRecoveryJournal::open(&path).unwrap();
        assert!(WorkerRecoveryJournal::read_interrupted(&path));
        let latest = reopened.get_latest();
        assert_eq!(latest.len(), 1);
        assert_eq!(latest[0].active_session_id, "s1");
        assert!(latest[0].busy);
        let restored = reopened.latest_queue_snapshot("s1").unwrap();
        assert_eq!(restored.0, vec![item]);
        assert!(restored.1.is_empty());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn worker_journal_open_heals_torn_ascii_tail() {
        let path = temp_path("torn-ascii-tail.recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal
            .record("s1", "sess1", Some("/a.jsonl"), true, "prompt_accepted")
            .unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(br#"{"activeSessionId":"s3","sessionId":"ses"#)
            .unwrap();
        drop(file);

        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal.record("s2", "sess2", None, false, "ready").unwrap();
        let reopened = WorkerRecoveryJournal::open(&path).unwrap();
        assert!(WorkerRecoveryJournal::read_interrupted(&path));
        assert_eq!(
            reopened
                .get_latest()
                .iter()
                .filter(|record| record.active_session_id == "s2")
                .count(),
            1,
            "the record appended after the reopened journal must survive a reload"
        );
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
