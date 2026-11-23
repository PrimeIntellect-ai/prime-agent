//! `roster.json` — the update flow's session/worker/subagent/heartbeat snapshot (spec §8): a
//! *projection*, written once durably at `Snapshotted`, consumed exactly once by `Prepared ->
//! Stopping`. The durable truth for every row stays where it lives (`sessions/*.jsonl`, session
//! artifacts, `rlm-ledger/`); restore is create-or-adopt in place.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::session::CustomMessage;
use crate::JsonMap;

use super::artifact::UpdateId;
use super::marker::UpdateSupervisorIdentity;

/// `roster.json` schema revision (spec §8: `format_version`-gated).
pub const UPDATE_ROSTER_FORMAT_VERSION: u64 = 1;

/// The binary versions a snapshot is taken across.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateRosterBinary {
    pub from_version: String,
    pub to_version: String,
}

/// Whether a rostered session is top-level or a subagent child.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateRosterSessionKind {
    TopLevel,
    Subagent,
}

/// Queued work that must be restored before any continuation prompt (spec §8): `next_turn` custom
/// messages plus the session engine's session-action recovery snapshot (`actions`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateRosterQueue {
    #[serde(default)]
    pub next_turn: Vec<CustomMessage>,
    pub actions: Value,
}

/// What one rostered session was doing when the snapshot was taken; the restore pass uses these to
/// decide continuation treatment. Wire/API contract: the flags serialize as-is; enum reshaping
/// changes the snapshot schema.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct UpdateRosterInFlight {
    pub streaming: bool,
    pub compacting: bool,
    pub bash_running: bool,
    pub rlm_children: bool,
    pub retrying: bool,
    pub prompt_in_flight: bool,
}

/// One session row: durable `session_id` (stable across restore), transient `active_session_id`
/// (preserved so clients resume by the same handle), durable `parent_session_id` for subagents.
/// `runtime_config` and `queue.actions` are opaque (session-engine schema).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateRosterSession {
    pub session_id: String,
    pub active_session_id: String,
    pub session_file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub kind: UpdateRosterSessionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    pub rlm_depth: u32,
    pub cwd: String,
    pub runtime_config: Value,
    pub queue: UpdateRosterQueue,
    pub in_flight: UpdateRosterInFlight,
    /// `false`: an idle session restored without a continuation prompt.
    pub should_resume: bool,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// One worker row: the durable session ids this worker process hosts plus the
/// launch environment needed to respawn it identically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateRosterWorker {
    pub worker_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_instance_id: Option<String>,
    pub sessions: Vec<String>,
    pub launch_env: BTreeMap<String, String>,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// Whether a rostered subagent was running or already completed. Restore
/// re-creates subagent sessions bottom-up; a completed subagent restores
/// as a passive entry only (no worker until its parent addresses it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateRosterSubagentStatus {
    Running,
    Completed,
}

/// One subagent topology row — a projection for reporting; the durable
/// truth stays in the `rlm-ledger/` files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateRosterSubagent {
    pub child_id: String,
    pub session_id: String,
    pub parent_session_id: String,
    pub name: String,
    pub status: UpdateRosterSubagentStatus,
    pub depth: u32,
    pub session_file: String,
    pub display_file: String,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// How a heartbeat prompt is delivered when the session is busy (TS
/// `AgentHeartbeatDeliveryMode`): `"steer"` interrupts, `"follow_up"` waits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateHeartbeatDeliveryMode {
    Steer,
    #[serde(rename = "follow_up")]
    FollowUp,
}

/// Whether a rostered heartbeat was active or paused at snapshot time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateHeartbeatStatus {
    Active,
    Paused,
}

/// One heartbeat row — a projection for UX reporting and re-arm only, never a restore input:
/// `scheduled-jobs.json` is the only write path, and re-arm rescans it after restore (spec §6 step
/// 3). No archive flag: heartbeats are never archived by the update flow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateRosterHeartbeat {
    pub job_id: String,
    /// The owning session, by durable id.
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub schedule: String,
    pub delivery_mode: UpdateHeartbeatDeliveryMode,
    pub status: UpdateHeartbeatStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// `roster.json` (spec §8): the supervisor's durable snapshot of everything
/// the new (or rollback) supervisor must restore to serve the same sessions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateRoster {
    pub format_version: u64,
    pub update_id: UpdateId,
    pub socket_path: String,
    pub created_at: String,
    pub supervisor: UpdateSupervisorIdentity,
    pub binary: UpdateRosterBinary,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sessions: Vec<UpdateRosterSession>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workers: Vec<UpdateRosterWorker>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subagents: Vec<UpdateRosterSubagent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub heartbeats: Vec<UpdateRosterHeartbeat>,
    #[serde(flatten)]
    pub rest: JsonMap,
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
    fn queue_next_turn_carries_custom_messages() {
        rt::<UpdateRosterQueue>(
            r#"{"next_turn":[{"customType":"queued.note","content":"finish the build","display":true,"timestamp":1790856000000}],"actions":{"a":1}}"#,
        );
    }
}
