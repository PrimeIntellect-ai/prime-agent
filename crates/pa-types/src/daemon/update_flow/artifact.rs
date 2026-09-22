//! The update flow's on-disk artifact vocabulary (spec §7): the coordinator
//! identity, the intent lock, the status file, and the artifact path layout
//! under `<agent-dir>/update-restarts/`.

use std::fmt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::JsonMap;

use super::state::UpdateState;

// ---------------------------------------------------------------------------
// Update identity
// ---------------------------------------------------------------------------

/// Opaque update identifier (a UUIDv7 in practice). Typed so status records,
/// artifact paths, and prepare transactions cannot mix it up with session or
/// request ids. Idempotency keys (prepare retry, join) compare whole ids.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct UpdateId(pub String);

impl fmt::Display for UpdateId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for UpdateId {
    fn from(id: String) -> Self {
        UpdateId(id)
    }
}

impl AsRef<str> for UpdateId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

/// A process identity as recorded in update artifacts: `{pid,
/// process_start_id}` (the TS `getProcessStartId` contract, so a recycled pid
/// can never impersonate a live process), plus the supervisor-scoped fields
/// the TS status file carries. Used by the status file's coordinator,
/// predecessor, and successor identities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProcessIdentity {
    pub pid: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_start_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supervisor_generation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supervisor_owner_token: Option<String>,
    #[serde(flatten)]
    pub rest: JsonMap,
}

// ---------------------------------------------------------------------------
// intent.json — the coordinator lock
// ---------------------------------------------------------------------------

/// `intent.json`: the per-socket coordinator lock (spec §4 `Acquire`). A live
/// holder means a new coordinator `Join`s instead of stealing; a recorded
/// identity that is no longer alive (pid + start-id check) is the only legal
/// steal. The coordinator heartbeats `heartbeat_at` every 5 s while it holds
/// the lock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateIntent {
    pub update_id: UpdateId,
    pub pid: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_start_id: Option<String>,
    pub heartbeat_at: String,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// `PRIME_AGENT_UPDATE_ROSTER`: the path of the roster snapshot the
/// coordinator passes to the successor supervisor in its spawn environment
/// (spec §6: the one update-related input any boot reads - the successor
/// never discovers a roster file on disk).
pub const UPDATE_ROSTER_ENV: &str = "PRIME_AGENT_UPDATE_ROSTER";

// ---------------------------------------------------------------------------
// status.json — the TS status-file schema
// ---------------------------------------------------------------------------

pub const UPDATE_STATUS_FORMAT_VERSION: u64 = 1;

/// Restore counts for the terminal report (TS `DaemonUpdateRestartCounts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusCounts {
    pub total: u64,
    pub restored: u64,
    pub resumed: u64,
    pub failed: u64,
}

/// One per-session restore failure recorded in the terminal report (TS
/// `DaemonUpdateRestartFailure`). Restore failures never fail the boot
/// (spec §9): they are recorded, and the session stays on disk for manual
/// resume.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusFailure {
    pub session_file: String,
    pub message: String,
}

/// The successor supervisor's hello resume contract (spec §10.3): tells a
/// reconnecting client whether the restore pass behind this supervisor has
/// finished. `update_id` is `None` on a normal boot. Rust-only extension
/// (the TS close frame carries no resume contract).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonUpdateResume {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_id: Option<UpdateId>,
    pub complete: bool,
}

/// `status.json`: the TS coordinator status-file schema (`DaemonUpdateRestartStatus`
/// parity, camelCase), with the spec's additions — `updateId` (spec; the TS
/// file's `requestId`) and the monotonic `epoch` owned by the coordinator
/// process so late writes from a dying predecessor cannot regress state
/// (spec §4). `state` carries the new FSM vocabulary, not the TS phase names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub version: u64,
    pub update_id: UpdateId,
    pub socket_path: String,
    pub state: UpdateState,
    #[serde(default)]
    pub epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator: Option<UpdateProcessIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predecessor: Option<UpdateProcessIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub successor: Option<UpdateProcessIdentity>,
    pub counts: UpdateStatusCounts,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failures: Vec<UpdateStatusFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub started_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat_at: Option<String>,
    #[serde(flatten)]
    pub rest: JsonMap,
}

// ---------------------------------------------------------------------------
// Artifact path layout (spec §7)
// ---------------------------------------------------------------------------

/// The update-flow scratch root: `<agent-dir>/update-restarts/`. Everything
/// under it is swept unconditionally at supervisor boot, before the first
/// client command is served (spec §6, invariant I2).
pub fn update_restarts_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.join("update-restarts")
}

/// The per-socket scratch directory `<agent-dir>/update-restarts/<socket_hash>/`.
/// `socket_hash` is the sha256 hex of the normalized socket path (TS
/// `socketKey` parity); its derivation stays with the caller's platform layer
/// so this crate stays crypto-free — coordinator and supervisor must derive
/// it the same way.
pub fn socket_update_dir(agent_dir: &Path, socket_hash: &str) -> PathBuf {
    update_restarts_dir(agent_dir).join(socket_hash)
}

/// `intent.json` — the coordinator lock inside a socket scratch dir.
pub fn update_intent_path(socket_dir: &Path) -> PathBuf {
    socket_dir.join("intent.json")
}

/// `status.json` — the coordinator status file inside a socket scratch dir.
pub fn update_status_path(socket_dir: &Path) -> PathBuf {
    socket_dir.join("status.json")
}

/// `prepared/<update-id>/` — the old supervisor's durable prepare artifact.
/// Written at `Snapshotted` (roster + marker, fsync before the ack), deleted
/// by the supervisor's self-expiry or by the coordinator after `Restoring`.
pub fn update_prepared_dir(socket_dir: &Path, update_id: &UpdateId) -> PathBuf {
    socket_dir.join("prepared").join(update_id.as_ref())
}

/// `roster.json` inside a prepared dir.
pub fn update_roster_path(prepared_dir: &Path) -> PathBuf {
    prepared_dir.join("roster.json")
}

/// `marker.json` inside a prepared dir.
pub fn update_marker_path(prepared_dir: &Path) -> PathBuf {
    prepared_dir.join("marker.json")
}

/// The TS-era supervisor manifest directory, `<agent-dir>/daemon-update-restarts/`.
/// Nothing writes it anymore; the boot sweep deletes it if present (spec §6).
pub fn legacy_update_restarts_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.join("daemon-update-restarts")
}

/// The TS-era single-file update manifest, `<agent-dir>/daemon-update-restart.json`.
/// Nothing writes it anymore; the boot sweep deletes it if present (spec §6).
pub fn legacy_update_restart_status(agent_dir: &Path) -> PathBuf {
    agent_dir.join("daemon-update-restart.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt<T: serde::Serialize + for<'de> serde::Deserialize<'de>>(json: &str) {
        let original: serde_json::Value = serde_json::from_str(json).unwrap();
        let parsed: T = serde_json::from_str(json).expect("deserialize");
        let out = serde_json::to_string(&parsed).expect("serialize");
        let reparsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(original, reparsed, "round trip changed the value: {out}");
    }

    #[test]
    fn intent_roundtrip_snake_case() {
        rt::<UpdateIntent>(
            r#"{"update_id":"018f1234-abcd-7abc-8def-0123456789ab","pid":4242,"process_start_id":"123456/100","heartbeat_at":"2026-10-01T12:00:00.000Z"}"#,
        );
        rt::<UpdateIntent>(r#"{"update_id":"u","pid":9,"heartbeat_at":"t","note":"kept"}"#);
    }

    #[test]
    fn status_roundtrip_ts_schema_with_spec_additions() {
        rt::<UpdateStatus>(
            r#"{"version":1,"updateId":"018f1234-abcd-7abc-8def-0123456789ab","socketPath":"/tmp/prime-agent-1000/daemon.sock","state":"preparing","epoch":3,"coordinator":{"pid":99,"processStartId":"1/2"},"counts":{"total":2,"restored":0,"resumed":0,"failed":0},"startedAt":"2026-10-01T12:00:00Z","updatedAt":"2026-10-01T12:00:05Z","heartbeatAt":"2026-10-01T12:00:05Z"}"#,
        );
        rt::<UpdateStatus>(
            r#"{"version":1,"updateId":"u2","socketPath":"/s","state":"complete","epoch":7,"predecessor":{"pid":1},"successor":{"pid":2,"supervisorGeneration":"g"},"counts":{"total":3,"restored":2,"resumed":1,"failed":1},"failures":[{"sessionFile":"/sessions/a.jsonl","message":"worker refused"}],"message":"updated","startedAt":"a","updatedAt":"b","unknownField":true}"#,
        );
    }

    #[test]
    fn status_defaults_accept_ts_minimal_file() {
        // A TS-era status file (no epoch, no failures) parses and keeps its
        // unknown fields.
        let parsed: UpdateStatus = serde_json::from_str(
            r#"{"version":1,"updateId":"r1","socketPath":"/s","state":"complete","counts":{"total":0,"restored":0,"resumed":0,"failed":0},"startedAt":"a","updatedAt":"b","requestId":"r1"}"#,
        )
        .unwrap();
        assert_eq!(parsed.epoch, 0);
        assert!(parsed.failures.is_empty());
        assert_eq!(
            parsed.rest.get("requestId").and_then(|v| v.as_str()),
            Some("r1")
        );
    }

    #[test]
    fn artifact_path_layout_matches_spec() {
        let agent_dir = Path::new("/ad");
        let socket_dir = socket_update_dir(agent_dir, "deadbeef");
        assert_eq!(socket_dir, Path::new("/ad/update-restarts/deadbeef"));
        assert_eq!(
            update_intent_path(&socket_dir),
            Path::new("/ad/update-restarts/deadbeef/intent.json")
        );
        assert_eq!(
            update_status_path(&socket_dir),
            Path::new("/ad/update-restarts/deadbeef/status.json")
        );
        let update_id = UpdateId::from(String::from("018f1"));
        let prepared = update_prepared_dir(&socket_dir, &update_id);
        assert_eq!(
            prepared,
            Path::new("/ad/update-restarts/deadbeef/prepared/018f1")
        );
        assert_eq!(update_roster_path(&prepared), prepared.join("roster.json"));
        assert_eq!(update_marker_path(&prepared), prepared.join("marker.json"));
        assert_eq!(
            legacy_update_restarts_dir(agent_dir),
            Path::new("/ad/daemon-update-restarts")
        );
        assert_eq!(
            legacy_update_restart_status(agent_dir),
            Path::new("/ad/daemon-update-restart.json")
        );
    }

    #[test]
    fn update_id_is_transparent_and_displayed() {
        let id: UpdateId = serde_json::from_value("018f-uuidv7".into()).unwrap();
        assert_eq!(serde_json::to_value(&id).unwrap(), "018f-uuidv7");
        assert_eq!(id.to_string(), "018f-uuidv7");
        assert_eq!(id.as_ref(), "018f-uuidv7");
    }
}
