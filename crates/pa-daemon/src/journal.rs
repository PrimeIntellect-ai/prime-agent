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

fn append_record(path: &Path, record: &Value) -> Result<()> {
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

/// How the temp journal lands on its path.
#[derive(Debug, Clone, Copy)]
enum Finalize {
    /// Rename through `rename_onto`: the bounded win32 destination-busy
    /// retry (TS `writeFileAtomicSync` -> `renameOntoSync`).
    RetryBusy,
    /// Bare rename; every failure surfaces immediately (TS
    /// `worker-recovery-journal.ts` uses plain `renameSync` - no retry).
    Bare,
}

fn rewrite_records(path: &Path, records: &[Value], finalize: Finalize) -> Result<()> {
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
    let rename = match finalize {
        Finalize::RetryBusy => pa_core::platform::rename_onto(&temp, path),
        Finalize::Bare => fs::rename(&temp, path),
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

    pub fn lookup(&self, client_id: &str, command_id: &str) -> Option<CommandJournalEntry> {
        self.entries.get(&Self::key(client_id, command_id)).cloned()
    }

    /// Record durable receipt before dispatch. Returns the prior state when the
    /// command was already journaled.
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

/// A worker queue snapshot record: the pending steering/follow-up lanes so a
/// respawned worker restores its queues. Lives in the worker recovery journal
/// (TS keeps its session files free of daemon bookkeeping; queue recovery is
/// worker-private state, so it rides the journal next to the busy records).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerQueueSnapshotRecord {
    pub version: u32,
    pub r#type: String,
    pub active_session_id: String,
    pub steering: Vec<String>,
    pub follow_up: Vec<String>,
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

    pub fn read_latest(path: &Path) -> Result<Vec<WorkerRecoveryRecord>> {
        Ok(parse_worker_records(path)?.into_values().collect())
    }

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
        let all_idle = self.latest.values().all(|entry| !entry.busy) && !busy;
        self.latest.insert(active_session_id.to_string(), record);
        if all_idle {
            self.compact()?;
        }
        Ok(())
    }

    pub fn get_latest(&self) -> Vec<WorkerRecoveryRecord> {
        self.latest.values().cloned().collect()
    }

    /// Persist the pending queue lanes; latest record wins per session.
    pub fn record_queue_snapshot(
        &mut self,
        active_session_id: &str,
        steering: &[String],
        follow_up: &[String],
    ) -> Result<()> {
        let record = WorkerQueueSnapshotRecord {
            version: 1,
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

    /// The latest persisted queue lanes for `active_session_id`.
    pub fn latest_queue_snapshot(
        &self,
        active_session_id: &str,
    ) -> Option<(Vec<String>, Vec<String>)> {
        self.queue_snapshots
            .get(active_session_id)
            .map(|record| (record.steering.clone(), record.follow_up.clone()))
    }

    /// Read the latest queue snapshot for a session straight from a journal
    /// file (worker restore on a fresh process).
    pub fn read_queue_snapshot(
        path: &Path,
        active_session_id: &str,
    ) -> Result<Option<(Vec<String>, Vec<String>)>> {
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
        let Ok(record) = serde_json::from_str::<WorkerQueueSnapshotRecord>(line) else {
            continue;
        };
        if record.version == 1 && record.r#type == QUEUE_SNAPSHOT_RECORD_TYPE {
            latest.insert(record.active_session_id.clone(), record);
        }
    }
    Ok(latest)
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
}
