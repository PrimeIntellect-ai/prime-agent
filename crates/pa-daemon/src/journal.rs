//! Append-only recovery journals (ports of command-recovery-journal.ts and
//! worker-recovery-journal.ts).
//!
//! The command journal makes supervisor mutations exactly-once: a received
//! record is durable before dispatch, a missing result after a crash is
//! reported as uncertain and never replayed. The worker journal records the
//! latest busy/operation state per session so a replacement can mark
//! interrupted work instead of guessing.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
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

/// Append several records as ONE durable write: one open, all lines in one
/// `write_all`, one `fsync`. The records land together or not at all — a
/// batched checkpoint keeps its all-or-nothing shape (the busy verdict
/// never publishes without the queue snapshot it describes), and the
/// journal's on-disk bytes are exactly what the same records appended one
/// by one would produce.
///
/// # Errors
///
/// Returns an error when the parent directory, the open, a serialization,
/// the write, or the sync fails; a partial write may leave truncated
/// trailing lines, which the loader skips like any crash-truncated record.
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
/// full sync before the swap: the two are one seam — each variant is the
/// sync class its TS counterpart (or Rust-native owner) carries.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Finalize {
    /// Rename through `rename_onto`: the bounded win32 destination-busy
    /// retry (TS `writeFileAtomicSync` -> `renameOntoSync`), with the
    /// temp file synced before the swap (TS `fsync: true`).
    RetryBusy,
    /// Bare rename with the temp file synced before the swap: every
    /// failure surfaces immediately. The Rust-native terminal-compaction
    /// journal (no TS counterpart) keeps its belt.
    Synced,
    /// Bare rename with an UNSYNCED temp (TS
    /// `worker-recovery-journal.ts` compact: `writeFileSync` + plain
    /// `renameSync` — no retry, no temp fsync): the OS carries the temp
    /// data to the rename. Durability is owned by the append path — the
    /// compacted form holds only records the append path already made
    /// durable, so a lost compact falls back to the append-only history,
    /// which replays identically.
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandJournalEntry {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<Value>,
}

/// Port of `CommandRecoveryJournal`.
pub struct CommandRecoveryJournal {
    path: std::path::PathBuf,
    entries: HashMap<String, CommandJournalEntry>,
    record_count: usize,
}

impl CommandRecoveryJournal {
    /// Open the journal at `path` (creating the parent directory as needed)
    /// and load the pending receipts from any existing records.
    ///
    /// # Errors
    ///
    /// Returns an error when the parent directory cannot be created; a
    /// missing journal loads as empty, and the record load itself never
    /// errors (lines truncated by a crash are skipped).
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
    /// Returns an error when the receipt record cannot be appended (the
    /// parent directory, the journal open, the serialization, the write,
    /// or the sync fails).
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
    /// Returns an error when no receipt was journaled for the command (a
    /// result cannot be recorded first), when the result record cannot be
    /// appended, or when the post-append compaction fails.
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

    fn compact(&mut self) -> Result<()> {
        let mut records = Vec::new();
        for (key, entry) in &self.entries {
            let mut received = serde_json::json!({
                "version": 1,
                "type": "received",
                "key": key,
            });
            if let Some(response) = &entry.response {
                received["response"] = response.clone();
            }
            records.push(received);
        }
        rewrite_records(&self.path, &records, Finalize::RetryBusy)?;
        self.record_count = records.len();
        Ok(())
    }

    fn load(&mut self) -> Result<()> {
        let Ok(content) = fs::read_to_string(&self.path) else {
            return Ok(());
        };
        for line in content.lines() {
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
    let Ok(content) = fs::read_to_string(path) else {
        return Ok(latest);
    };
    for line in content.lines() {
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

/// One parked queue row in a worker queue snapshot: the delivery payload a
/// respawned worker needs — the message text, the labeled preview, the
/// injected custom row, the queue key, and the visibility flag — so a
/// restored queued heartbeat still delivers as the `heartbeat_prompt`
/// component (and keeps its `Heartbeat prompt:` row) instead of
/// collapsing into a plain user message.
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
    /// The item's turn-execution class ("queued"/"injected"/"direct", see
    /// `worker::TurnPolicy)`: the batch gathering's compatibility gate. A
    /// record written before the field existed restores as "queued" — the
    /// dominant lane class, and the only one a fresh snapshot can batch.
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

/// A worker queue snapshot record: the pending steering/follow-up lanes so a
/// respawned worker restores its queues. Lives in the worker recovery journal
/// (TS keeps its session files free of daemon bookkeeping; queue recovery is
/// worker-private state, so it rides the journal next to the busy records).
/// Version 2 lanes carry the full item records; a version-1 lane (written
/// before the item payload existed) is a bare message-text array and
/// restores as a plain row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerQueueSnapshotRecord {
    pub version: u32,
    pub r#type: String,
    pub active_session_id: String,
    pub steering: Vec<WorkerQueueItemRecord>,
    pub follow_up: Vec<WorkerQueueItemRecord>,
    pub recorded_at: String,
}

/// Port of `WorkerRecoveryJournal`: latest busy/operation per active session,
/// plus the latest queue snapshot per session.
pub struct WorkerRecoveryJournal {
    path: std::path::PathBuf,
    latest: HashMap<String, WorkerRecoveryRecord>,
    queue_snapshots: HashMap<String, WorkerQueueSnapshotRecord>,
}

impl WorkerRecoveryJournal {
    /// Open the worker journal at `path` (creating the parent directory as
    /// needed) and load the latest busy records and queue snapshots.
    ///
    /// # Errors
    ///
    /// Returns an error when the parent directory cannot be created, or
    /// when the journal exists but the queue-snapshot pass cannot read it
    /// (a missing journal loads as empty).
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let queue_snapshots = parse_queue_snapshot_records(path)?;
        Ok(WorkerRecoveryJournal {
            path: path.to_path_buf(),
            latest: parse_worker_records(path)?,
            queue_snapshots,
        })
    }

    /// Read the latest worker record per active session straight from a
    /// journal file.
    ///
    /// # Errors
    ///
    /// Never errors: a missing or unreadable journal reads as an empty
    /// set (the `Result` wrapper keeps the reading seam uniform).
    pub fn read_latest(path: &Path) -> Result<Vec<WorkerRecoveryRecord>> {
        Ok(parse_worker_records(path)?.into_values().collect())
    }

    /// Does the journal prove live work at the worker's last exit? A plain
    /// supervisor startup adopts a dead worker only when this holds (a
    /// restart must not mass-revive historical sessions): a latest `busy`
    /// record marks an in-flight turn or an admitted-but-undelivered
    /// prompt/queue lane. An unreadable journal proves nothing —
    /// uncertainty must not revive a session.
    #[must_use]
    pub fn read_interrupted(path: &Path) -> bool {
        Self::read_latest(path).is_ok_and(|records| records.iter().any(|record| record.busy))
    }

    /// The newest `busy` record's `recorded_at`, when the journal proves
    /// live work: the timestamp the boot-revival gate ages the evidence
    /// against (an old busy record is residue of an era that already
    /// ended, not interrupted work this boot must heal). A journal with
    /// no busy record answers `None`.
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
    /// belt): a supervisor that gave up on a worker records the verdict
    /// in the same journal a later boot would read as revival evidence —
    /// stale busy evidence must not outlive the give-up that superseded
    /// it, or every boot re-storms the slot the cap already condemned.
    ///
    /// # Errors
    ///
    /// Returns an error when the journal cannot be opened or a settle
    /// record cannot be appended.
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
    /// or when the all-idle compaction fails.
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
        // TS parity: the all-idle check includes the just-landed record
        // (TS `record` runs `[...this.latest.values()].every(!busy)`
        // AFTER `set`). Checking before the insert let the session's own
        // busy admission record block its settle's compaction, so a
        // single-session journal never compacted and grew append-only
        // for the session's lifetime; the compaction now fires at every
        // changed-idle record like TS, keeping the file bounded.
        if self.latest.values().all(|entry| !entry.busy) {
            self.compact()?;
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
    /// Returns an error when the snapshot record cannot be serialized or
    /// appended.
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
    /// durable append (the queue-checkpoint pair `checkpoint_queue_recovery`
    /// writes): the snapshot line and the verdict line share a single open,
    /// write, and `fsync`, so a checkpoint costs one journal flush instead
    /// of two. The on-disk order matches the sequential form exactly — the
    /// snapshot record first, then the verdict — and the verdict still
    /// never publishes over a snapshot that did not persist (the batch is
    /// all-or-nothing). An unchanged verdict appends the snapshot alone,
    /// like the sequential pair does.
    ///
    /// # Errors
    ///
    /// Returns an error when either record cannot be serialized or the
    /// batched append fails, or when the all-idle compaction fails after a
    /// changed verdict landed.
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
            // TS parity (the same post-insert check as `record`): the
            // settle's compaction fires on the all-idle map that includes
            // the just-landed verdict, never blocked by the session's own
            // busy admission record.
            if self.latest.values().all(|entry| !entry.busy) {
                self.compact()?;
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

    fn compact(&self) -> Result<()> {
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
        rewrite_records(&self.path, &records, Finalize::Bare)
    }
}

/// The record-type tag of a queue snapshot line.
const QUEUE_SNAPSHOT_RECORD_TYPE: &str = "queue_snapshot";
/// The current queue-snapshot record version: the lanes carry the full
/// item records.
const QUEUE_SNAPSHOT_VERSION: u32 = 2;

fn parse_queue_snapshot_records(path: &Path) -> Result<HashMap<String, WorkerQueueSnapshotRecord>> {
    let mut latest: HashMap<String, WorkerQueueSnapshotRecord> = HashMap::new();
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(latest),
        Err(error) => {
            return Err(error).with_context(|| format!("read journal {}", path.display()))
        }
    };
    for line in contents.split('\n').filter(|line| !line.is_empty()) {
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

/// One snapshot lane: a version-2 entry is the full item record, while a
/// version-1 entry is the bare message text and restores as a plain row
/// (no preview, no injected custom row — the pre-item payload).
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
        // Idle sessions prove nothing: no interrupted work to revive.
        journal
            .record("s1", "sess1", None, false, "shutdown")
            .unwrap();
        journal.record("s2", "sess2", None, false, "ready").unwrap();
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        // One busy session is durable evidence of interrupted work.
        journal
            .record("s2", "sess2", Some("/b.jsonl"), true, "create")
            .unwrap();
        assert!(WorkerRecoveryJournal::read_interrupted(&path));
        // The latest record per session decides: s2 settles back to idle.
        journal
            .record("s2", "sess2", None, false, "shutdown")
            .unwrap();
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// The batched queue checkpoint and the sequential form produce the
    /// same journal: same lines in the same order, same latest records,
    /// same restorable queue snapshots (the `recorded_at` stamps differ only
    /// because the two runs cannot share a clock instant).
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
        // Admitted (snapshot + busy verdict), settle (snapshot + idle
        // verdict + compaction), then an unchanged-verdict checkpoint whose
        // snapshot lands alone in both forms.
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
        // An unchanged verdict: the snapshot still lands, alone.
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

    /// The busy verdict rides the snapshot's single flush: a checkpoint
    /// whose batched append fails lands NEITHER record (no verdict over an
    /// unpersisted snapshot, and no snapshot without its flush).
    #[test]
    fn worker_journal_batched_checkpoint_is_all_or_nothing() {
        let path = temp_path("allornothing.recovery.jsonl");
        fs::write(&path, "").unwrap();
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        journal.record("s1", "sess1", None, false, "ready").unwrap();
        // Replace the journal with a directory: every open for append now
        // fails, so the checkpoint cannot land either record.
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        let result =
            journal.record_queue_checkpoint("s1", "sess1", None, true, "prompt_accepted", &[], &[]);
        assert!(result.is_err());
        // The in-memory verdict did not advance over the failed append.
        assert!(journal.latest.get("s1").is_some_and(|record| !record.busy));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// TS parity oracle: a single session's settle compacts (the post-
    /// insert all-idle check). The OLD pre-insert check let the session's
    /// own busy admission record block the compaction, so a single-session
    /// journal grew append-only forever; TS compacts at every changed-idle
    /// record and so does the port now.
    #[test]
    fn worker_journal_settle_compacts_single_session() {
        let path = temp_path("settle-compacts.recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        // Two busy/idle cycles through the plain `record` path: the first
        // settle compacts to one line, so the second admission starts from
        // a one-line file (two lines mid-flight, one after the settle) —
        // without the settle compaction the file would grow 2 lines per
        // cycle.
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
        // The settle compacted: the file holds exactly the latest record.
        let content = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 1, "the settle compacts to the latest record");
        let record: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(record["busy"], false);
        assert_eq!(record["operation"], "turn_end");
        // The compacted journal replays the same latest state.
        let reopened = WorkerRecoveryJournal::open(&path).unwrap();
        let latest = reopened.get_latest();
        assert_eq!(latest.len(), 1);
        assert!(!latest[0].busy);
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// The settle through the batched checkpoint compacts to the same
    /// two lines (idle verdict + latest snapshot) and restores the same
    /// queue lanes a pre-compact append-only history would.
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
        // Two turns: each admission batch grows the file; each settle
        // compacts it back — without the compaction the second admission
        // would stack on the first turn's history (6 lines by the end).
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
        // the compact keeps the LATEST snapshot per session: the settle's
        // (empty) lanes, not the admission's parked row.
        assert_eq!(snapshot["steering"].as_array().map(Vec::len), Some(0));
        // The reopened journal restores the settled verdict and the
        // settle's (empty) lanes exactly like the append-only history.
        let reopened = WorkerRecoveryJournal::open(&path).unwrap();
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        let restored = reopened.latest_queue_snapshot("s1").unwrap();
        assert_eq!(restored.0, Vec::new());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// An unchanged verdict appends the snapshot alone and never compacts
    /// (TS `record` early-returns before its compaction check): the
    /// compaction belongs to changed-idle records only.
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
        // The unchanged settle: the snapshot lands, the verdict does not,
        // and no compaction runs (the map never changed).
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
        // No journal: no evidence, so no revival on uncertainty.
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        std::fs::write(&path, "not json").unwrap();
        assert!(!WorkerRecoveryJournal::read_interrupted(&path));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
