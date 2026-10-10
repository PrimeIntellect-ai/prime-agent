//! Append-only recovery journals: the worker journal records the latest
//! busy/operation state and queue snapshots.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::Path;

pub(crate) const RECOVERY_JOURNAL_SUFFIX: &str = ".recovery.jsonl";

/// Sync a regular file before using its rows as proof. Windows needs a
/// writable flush handle even when the caller only reads the contents.
pub(crate) fn sync_regular_file(path: &Path) -> Result<()> {
    let mut options = File::options();
    options.read(true);
    #[cfg(windows)]
    options.write(true);
    options.open(path)?.sync_all()?;
    Ok(())
}

pub(crate) fn append_record(path: &Path, record: &Value) -> Result<()> {
    let created = !path.exists();
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
    pa_core::platform::fsync(&file)?;
    if created {
        if let Some(parent) = path.parent() {
            pa_core::platform::fs::sync_directory(parent)?;
        }
    }
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
    let created = !path.exists();
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
    pa_core::platform::fsync(&file)?;
    if created {
        if let Some(parent) = path.parent() {
            pa_core::platform::fs::sync_directory(parent)?;
        }
    }
    Ok(())
}

/// The temp journal's data rides a full sync before the swap.
pub(crate) fn rewrite_records(path: &Path, records: &[Value]) -> Result<()> {
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
        writer.get_ref().sync_all()?;
    }
    let rename = fs::rename(&temp, path);
    rename.with_context(|| format!("persist {}", path.display()))?;
    Ok(())
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) shutdown_attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) worker_instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) shutdown_verdict: Option<ShutdownVerdict>,
}

/// A shutdown's durable decision, independent of whether its wire reply lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ShutdownVerdict {
    BusyContinued,
    Parked,
    Idle,
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

/// One parked queue row in a worker queue snapshot: a restored queued
/// heartbeat still delivers as the `heartbeat_prompt` component instead of
/// a plain user message.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct WorkerQueueItemRecord {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<crate::worker::QueuePriority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_message: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) agent_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) admission_id: Option<String>,
    /// Stable session-entry identity assigned before the engine accepts a
    /// picked input. Queue rows that have not been picked have none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) entry_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) images: Vec<pa_agent::types::ImageContent>,
    #[serde(default = "queue_visible_default")]
    pub queue_visible: bool,
    /// The item's turn-execution class ("queued"/"injected"/"direct"):
    /// the batch gathering's compatibility gate. A pre-field record
    /// restores as "queued" — the only class a fresh snapshot can batch.
    #[serde(default = "queue_policy_default")]
    pub policy: String,
    #[serde(default)]
    pub(crate) forced_batch: bool,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shutdown_attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_instance_id: Option<String>,
}

/// Latest busy/operation per active session, plus the latest queue
/// snapshot per session.
pub struct WorkerRecoveryJournal {
    path: std::path::PathBuf,
    latest: HashMap<String, WorkerRecoveryRecord>,
    queue_snapshots: HashMap<String, WorkerQueueSnapshotRecord>,
    latest_resume_pair: Option<(WorkerQueueSnapshotRecord, WorkerRecoveryRecord)>,
}

impl WorkerRecoveryJournal {
    /// Open the worker journal at `path`, creating the parent directory as needed.
    ///
    /// # Errors
    ///
    /// Returns an error when the parent directory cannot be created, or
    /// the queue-snapshot pass cannot read an existing journal.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let queue_snapshots = parse_queue_snapshot_records(path)?;
        Ok(WorkerRecoveryJournal {
            path: path.to_path_buf(),
            latest: parse_worker_records(path)?,
            queue_snapshots,
            latest_resume_pair: Self::find_latest_resume_pair(path)?,
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
            shutdown_attempt_id: None,
            worker_instance_id: None,
            shutdown_verdict: None,
        };
        append_record(&self.path, &serde_json::to_value(&record)?)?;
        self.latest.insert(active_session_id.to_string(), record);
        // TS parity: the all-idle check runs AFTER the insert (TS checks
        // after `set`); checking before it, a single-session journal never
        // compacted.
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
            shutdown_attempt_id: None,
            worker_instance_id: None,
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
            shutdown_attempt_id: None,
            worker_instance_id: None,
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
                shutdown_attempt_id: None,
                worker_instance_id: None,
                shutdown_verdict: None,
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
                self.compact()?;
            }
        }
        Ok(())
    }

    /// Publish the complete final queue and the shutdown decision under one
    /// attempt identity. The supervisor may verify this after losing the ACK.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_shutdown_checkpoint(
        &mut self,
        active_session_id: &str,
        session_id: &str,
        session_file: Option<&str>,
        shutdown_attempt_id: &str,
        worker_instance_id: &str,
        verdict: ShutdownVerdict,
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
            shutdown_attempt_id: Some(shutdown_attempt_id.to_string()),
            worker_instance_id: Some(worker_instance_id.to_string()),
        };
        let record = WorkerRecoveryRecord {
            active_session_id: active_session_id.to_string(),
            session_id: session_id.to_string(),
            session_file: session_file.map(str::to_string),
            busy: verdict == ShutdownVerdict::BusyContinued,
            operation: "shutdown".to_string(),
            recorded_at: crate::util::now_iso(),
            shutdown_attempt_id: Some(shutdown_attempt_id.to_string()),
            worker_instance_id: Some(worker_instance_id.to_string()),
            shutdown_verdict: Some(verdict),
        };
        append_records(
            &self.path,
            &[
                serde_json::to_value(&snapshot)?,
                serde_json::to_value(&record)?,
            ],
        )?;
        self.queue_snapshots
            .insert(active_session_id.to_string(), snapshot);
        self.latest.insert(active_session_id.to_string(), record);
        self.latest_resume_pair = None;
        // Do not replace this fsynced attempt pair with the ordinary
        // compactor's intentionally unsynced rename before the ACK.
        Ok(())
    }

    /// Sync and verify a matching paired shutdown checkpoint. An ordinary
    /// stale busy row is not proof of this stop attempt.
    pub(crate) fn read_shutdown_checkpoint(
        path: &Path,
        shutdown_attempt_id: &str,
        worker_instance_id: &str,
    ) -> Result<Option<ShutdownVerdict>> {
        let Some((snapshot, record)) = Self::read_attempt_pair(path)? else {
            return Ok(None);
        };
        let Some(verdict) = record.shutdown_verdict else {
            return Ok(None);
        };
        Ok((record.operation == "shutdown"
            && record.shutdown_attempt_id.as_deref() == Some(shutdown_attempt_id)
            && snapshot.shutdown_attempt_id.as_deref() == Some(shutdown_attempt_id)
            && record.worker_instance_id.as_deref() == Some(worker_instance_id)
            && snapshot.worker_instance_id.as_deref() == Some(worker_instance_id)
            && record.active_session_id == snapshot.active_session_id
            && record.busy == (verdict == ShutdownVerdict::BusyContinued))
            .then_some(verdict))
    }

    /// An explicit resume request supersedes a held shutdown only after its
    /// queue and release decision have been synced together.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_resume_checkpoint(
        &mut self,
        active_session_id: &str,
        session_id: &str,
        session_file: Option<&str>,
        resume_attempt_id: &str,
        worker_instance_id: &str,
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
            shutdown_attempt_id: Some(resume_attempt_id.to_string()),
            worker_instance_id: Some(worker_instance_id.to_string()),
        };
        let record = WorkerRecoveryRecord {
            active_session_id: active_session_id.to_string(),
            session_id: session_id.to_string(),
            session_file: session_file.map(str::to_string),
            busy: !steering.is_empty() || !follow_up.is_empty(),
            operation: "resume_queue".to_string(),
            recorded_at: crate::util::now_iso(),
            shutdown_attempt_id: Some(resume_attempt_id.to_string()),
            worker_instance_id: Some(worker_instance_id.to_string()),
            shutdown_verdict: None,
        };
        append_records(
            &self.path,
            &[
                serde_json::to_value(&snapshot)?,
                serde_json::to_value(&record)?,
            ],
        )?;
        self.queue_snapshots
            .insert(active_session_id.to_string(), snapshot.clone());
        self.latest
            .insert(active_session_id.to_string(), record.clone());
        self.latest_resume_pair = Some((snapshot, record));
        Ok(())
    }

    pub(crate) fn read_resume_checkpoint(
        path: &Path,
        resume_attempt_id: &str,
        worker_instance_id: &str,
    ) -> Result<bool> {
        if !path.exists() {
            return Ok(false);
        }
        sync_regular_file(path)?;
        let Some((snapshot, record)) = Self::find_latest_resume_pair(path)? else {
            return Ok(false);
        };
        Ok(record.operation == "resume_queue"
            && record.shutdown_attempt_id.as_deref() == Some(resume_attempt_id)
            && snapshot.shutdown_attempt_id.as_deref() == Some(resume_attempt_id)
            && record.worker_instance_id.as_deref() == Some(worker_instance_id)
            && snapshot.worker_instance_id.as_deref() == Some(worker_instance_id)
            && record.active_session_id == snapshot.active_session_id
            && record.busy == (!snapshot.steering.is_empty() || !snapshot.follow_up.is_empty()))
    }

    fn find_latest_resume_pair(
        path: &Path,
    ) -> Result<Option<(WorkerQueueSnapshotRecord, WorkerRecoveryRecord)>> {
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
        };
        let mut latest = None;
        let mut preceding = None;
        for line in text.lines() {
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                preceding = None;
                continue;
            };
            if value.get("type").and_then(Value::as_str) == Some(QUEUE_SNAPSHOT_RECORD_TYPE) {
                preceding = serde_json::from_value::<WorkerQueueSnapshotRecord>(value).ok();
                continue;
            }
            if let (Some(snapshot), Ok(record)) = (
                preceding.take(),
                serde_json::from_value::<WorkerRecoveryRecord>(value),
            ) {
                if record.operation == "resume_queue"
                    && record.shutdown_attempt_id == snapshot.shutdown_attempt_id
                    && record.worker_instance_id == snapshot.worker_instance_id
                    && record.active_session_id == snapshot.active_session_id
                {
                    latest = Some((snapshot, record));
                }
            }
        }
        Ok(latest)
    }

    /// Only the final complete pair can prove an attempt. A torn final line
    /// or a later write invalidates the proof rather than restoring old work.
    fn read_attempt_pair(
        path: &Path,
    ) -> Result<Option<(WorkerQueueSnapshotRecord, WorkerRecoveryRecord)>> {
        if !path.exists() {
            return Ok(None);
        }
        sync_regular_file(path)?;
        let text = fs::read_to_string(path)?;
        if !text.ends_with('\n') {
            return Ok(None);
        }
        let mut lines = text.lines().rev();
        let Some(record_line) = lines.next() else {
            return Ok(None);
        };
        let Some(snapshot_line) = lines.next() else {
            return Ok(None);
        };
        let Ok(record) = serde_json::from_str::<WorkerRecoveryRecord>(record_line) else {
            return Ok(None);
        };
        let Ok(snapshot) = serde_json::from_str::<WorkerQueueSnapshotRecord>(snapshot_line) else {
            return Ok(None);
        };
        if snapshot.version != QUEUE_SNAPSHOT_VERSION
            || snapshot.r#type != QUEUE_SNAPSHOT_RECORD_TYPE
        {
            return Ok(None);
        }
        Ok(Some((snapshot, record)))
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
        if let Some((snapshot, record)) = &self.latest_resume_pair {
            // Keep the explicit release proof across ordinary idle compaction,
            // ahead of the latest state so standard readers still see it.
            records.insert(0, serde_json::to_value(record)?);
            records.insert(0, serde_json::to_value(snapshot)?);
        }
        // Any idle rewrite can replace a previously acknowledged cancel or
        // picked-input checkpoint. The replacement must be just as durable.
        rewrite_records(&self.path, &records)?;
        #[cfg(unix)]
        if let Some(parent) = self.path.parent() {
            File::open(parent)?.sync_all()?;
        }
        Ok(())
    }
}

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
            shutdown_attempt_id: record
                .get("shutdown_attempt_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            worker_instance_id: record
                .get("worker_instance_id")
                .and_then(Value::as_str)
                .map(str::to_string),
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
                        ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
}
