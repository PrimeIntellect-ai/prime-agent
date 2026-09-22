//! Durable MCP connection records (port of
//! `packages/coding-agent/src/core/mcp/connection-store.ts`, the record
//! core): the verified connection state per connectionId — the stable alias
//! the kernel dispatches through — plus the catalog serviceId it connects
//! and the endpoint the verification ran against. Tokens never live here.
//!
//! The record endpoint is the ENDPOINT PIN: an installed connection keeps
//! its approved endpoint for dispatch and management even if the catalog
//! later changes the service URL, and the resolver pins vanished sources
//! from it. Writes are locked read-modify-write (the auth-storage pattern:
//! lockfile + atomic temp-file rename at mode 0600).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::settings::storage::atomic_write;

/// The connections file version.
const FILE_VERSION: u8 = 1;
/// One connection's verified state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectionRecord {
    /// Auth key suffix (`mcp:<connectionId>`) and the kernel dispatch id.
    pub connection_id: String,
    /// Catalog service id; deliberately distinct from the connectionId
    /// (`acme-2` aliases keep their parent's service id).
    pub service_id: String,
    /// Endpoint the record's verification ran against (the pin).
    pub endpoint: String,
    pub label: String,
    pub status: McpConnectionStatus,
    pub created_at: u64,
    pub updated_at: u64,
    /// Epoch ms of the last successful handshake + tools/list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_count: Option<usize>,
    /// Fixed, safe failure category (never URLs or server-controlled text).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Opaque one-time ownership nonce for a pending login attempt.
    #[serde(rename = "attemptId", default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpConnectionStatus {
    Connected,
    Pending,
    Error,
}

impl McpConnectionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            McpConnectionStatus::Connected => "connected",
            McpConnectionStatus::Pending => "pending",
            McpConnectionStatus::Error => "error",
        }
    }
}

/// The connections file: `{ "version": 1, "connections": { id: record } }`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectionsFile {
    version: u8,
    #[serde(default)]
    connections: HashMap<String, McpConnectionRecord>,
}

/// Durable connection-record store. One instance per process is fine: every
/// mutating op re-reads the latest on-disk state under the lockfile and
/// applies only this call's change, so the interactive client and the daemon
/// worker can both mutate the file.
#[derive(Debug)]
pub struct McpConnectionStore {
    path: PathBuf,
    records: HashMap<String, McpConnectionRecord>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default()
}

/// Keep only structurally valid records on load: a corrupt or partial entry
/// is dropped, never served (matching the TS `sanitizeRecord`).
fn record_valid(record: &McpConnectionRecord) -> bool {
    !record.connection_id.is_empty()
        && !record.service_id.is_empty()
        && !record.endpoint.is_empty()
        && !record.label.is_empty()
        && record.created_at > 0
        && record.updated_at > 0
}

impl McpConnectionStore {
    /// Open the store at `<agent-dir>/mcp-connections.json` and load the
    /// latest records from disk. A missing file is an empty store.
    pub fn open(path: impl Into<PathBuf>) -> Self {
        let mut store = Self {
            path: path.into(),
            records: HashMap::new(),
        };
        store.load();
        store
    }

    /// In-memory store (tests, embedded hosts).
    pub fn in_memory() -> Self {
        Self {
            path: PathBuf::new(),
            records: HashMap::new(),
        }
    }

    /// Re-read the latest on-disk state (another process may have written).
    pub fn load(&mut self) {
        if self.path.as_os_str().is_empty() {
            return;
        }
        self.records = read_records(&self.path);
    }

    /// All records, sorted by connectionId (deterministic order).
    pub fn records(&self) -> Vec<McpConnectionRecord> {
        let mut records: Vec<McpConnectionRecord> = self.records.values().cloned().collect();
        records.sort_by(|a, b| a.connection_id.cmp(&b.connection_id));
        records
    }

    /// One record by connectionId.
    pub fn get(&self, connection_id: &str) -> Option<&McpConnectionRecord> {
        self.records.get(connection_id)
    }

    /// Insert or update one record (locked read-modify-write: the on-disk
    /// state wins for every OTHER id first). Install paths and tests that
    /// build records by hand.
    #[cfg(test)]
    pub fn upsert(&mut self, record: McpConnectionRecord) -> Result<(), anyhow::Error> {
        self.with_disk_state(|records| {
            records.insert(record.connection_id.clone(), record.clone());
        })
    }

    /// Remove one record entirely (disconnect keeps nothing behind).
    pub fn remove(&mut self, connection_id: &str) -> Result<(), anyhow::Error> {
        self.with_disk_state(|records| {
            records.remove(connection_id);
        })
    }

    /// Apply one verification outcome under the shared guard: a stale probe
    /// (the credential changed) never marks a newer grant or a logged-out
    /// connection verified — the result is discarded and the caller is
    /// told. A fresh install (no record yet) commits only when the probe's
    /// credential is still the stored one; a vanished record (removed
    /// mid-probe) commits nothing.
    pub fn apply_verify_result(
        &mut self,
        record: McpConnectionRecord,
        still_current: bool,
    ) -> Result<bool, anyhow::Error> {
        let connection_id = record.connection_id.clone();
        let mut committed = false;
        self.with_disk_state(|records| {
            match records.get(&connection_id) {
                None if still_current => {
                    // A fresh install creates the record.
                    records.insert(connection_id.clone(), record.clone());
                    committed = true;
                }
                Some(existing) if existing.attempt_id.is_none() && still_current => {
                    records.insert(connection_id.clone(), record.clone());
                    committed = true;
                }
                _ => {}
            }
        })?;
        Ok(committed)
    }

    /// Locked read-modify-write: reload the disk state, apply the change,
    /// write back atomically. In-memory stores just mutate.
    fn with_disk_state(
        &mut self,
        change: impl FnOnce(&mut HashMap<String, McpConnectionRecord>),
    ) -> Result<(), anyhow::Error> {
        if self.path.as_os_str().is_empty() {
            change(&mut self.records);
            return Ok(());
        }
        let lock = crate::platform::lock_dir::LockDir::acquire(
            &self.path,
            std::time::Duration::from_secs(10),
        )
        .map_err(|error| anyhow::anyhow!("connection store lock: {error}"))?;
        let mut records = read_records(&self.path);
        change(&mut records);
        write_records(&self.path, &records)?;
        drop(lock);
        self.records = records;
        Ok(())
    }
}

/// Read and sanitize the file's records (missing file = empty).
fn read_records(path: &Path) -> HashMap<String, McpConnectionRecord> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(file) = serde_json::from_str::<ConnectionsFile>(&content) else {
        return HashMap::new();
    };
    if file.version != FILE_VERSION {
        return HashMap::new();
    }
    let mut records = HashMap::new();
    for (id, record) in file.connections {
        if id == record.connection_id && record_valid(&record) {
            records.insert(id, record);
        }
    }
    records
}

/// Write the file atomically (temp + rename, mode 0600).
fn write_records(
    path: &Path,
    records: &HashMap<String, McpConnectionRecord>,
) -> Result<(), anyhow::Error> {
    let ordered: std::collections::BTreeMap<&String, &McpConnectionRecord> =
        records.iter().collect();
    let doc = serde_json::json!({
        "version": FILE_VERSION,
        "connections": ordered,
    });
    atomic_write(path, &serde_json::to_string_pretty(&doc)?)?;
    Ok(())
}

/// A fresh pending record for one connection (verification fills the rest).
pub fn new_pending_record(
    connection_id: &str,
    service_id: &str,
    label: &str,
    endpoint: &str,
) -> McpConnectionRecord {
    let now = now_ms();
    McpConnectionRecord {
        connection_id: connection_id.to_string(),
        service_id: service_id.to_string(),
        endpoint: endpoint.to_string(),
        label: label.to_string(),
        status: McpConnectionStatus::Pending,
        created_at: now,
        updated_at: now,
        verified_at: None,
        tool_count: None,
        last_error: None,
        attempt_id: None,
    }
}
