//! `roster.json` — the update flow's session/worker/subagent/heartbeat
//! snapshot (spec §8).
//!
//! The roster is a *projection*: written once, durably, at `Snapshotted`
//! (fsync before the `Prepared` ack), consumed exactly once by the
//! `Prepared -> Stopping` transition, and used to restore identical
//! supervision. The durable truth for every row stays where it lives
//! (`sessions/*.jsonl`, `session-artifacts/<id>/scheduled-jobs.json`,
//! `rlm-ledger/`) — the update flow never writes, moves, or archives those,
//! and restore is create-or-adopt in place.

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

/// Queued work that must be restored before any continuation prompt (spec §8):
/// `next_turn` carries the pending custom messages; `actions` is the
/// session-action recovery snapshot owned by the session engine (pa-core).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateRosterQueue {
    #[serde(default)]
    pub next_turn: Vec<CustomMessage>,
    pub actions: Value,
}

/// What one rostered session was doing when the snapshot was taken; the
/// restore pass uses these to decide continuation treatment (the TS-parity
/// update marker + continuation prompt for a session that was mid-turn).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct UpdateRosterInFlight {
    pub streaming: bool,
    pub compacting: bool,
    pub bash_running: bool,
    pub rlm_children: bool,
    pub retrying: bool,
    pub prompt_in_flight: bool,
}

/// One session row. `session_id` is the durable id (== session file id, stable
/// across restore); `active_session_id` is the transient id, preserved on
/// restore so attached clients resume by the same handle. `parent_session_id`
/// is the durable parent id for subagents. `runtime_config` and
/// `queue.actions` are opaque here — their schema belongs to the session
/// engine (pa-core).
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

/// Whether a rostered subagent was running or already completed at snapshot
/// time. Restore re-creates subagent sessions bottom-up (deepest first) so
/// parents attach to existing children; a completed subagent restores as a
/// passive entry only (no worker spawned until its parent addresses it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateRosterSubagentStatus {
    Running,
    Completed,
}

/// One subagent topology row — a projection for reporting; the durable truth
/// stays the `rlm-ledger/` files, which the update flow never rewrites.
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

/// How a scheduled heartbeat prompt is delivered when the session is busy
/// (TS `AgentHeartbeatDeliveryMode`): `"steer"` interrupts the current turn,
/// `"follow_up"` waits for it to finish.
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

/// One heartbeat row — a projection for UX reporting and re-arm only, never a
/// restore input: `scheduled-jobs.json` in the session artifacts is the only
/// write path for heartbeat jobs, and re-arm rescans it after restore (spec
/// §6 step 3). The row carries exactly the re-arm fields (`status`,
/// `next_run_at`) — deliberately no archive flag: a heartbeat is never moved
/// or archived by the update flow.
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

    /// A full roster in the spec §8 shape, exercised as the golden round-trip
    /// fixture (also mirrored in `tests/update_flow_artifacts.rs` with the
    /// full spec example).
    const ROSTER_JSON: &str = r#"{
        "format_version": 1,
        "update_id": "018f1234-abcd-7abc-8def-0123456789ab",
        "socket_path": "/tmp/prime-agent-1000/daemon.sock",
        "created_at": "2026-10-01T12:00:00Z",
        "supervisor": {"pid": 4242, "process_start_id": "4242/170000", "generation": "gen-7"},
        "binary": {"from_version": "0.9.5", "to_version": "0.9.6"},
        "sessions": [
            {
                "session_id": "01a0b4f6-0000-7000-8000-000000000001",
                "active_session_id": "a-1",
                "session_file": "~/.prime/agent/sessions/01a0b4f6-0000-7000-8000-000000000001.jsonl",
                "name": "worker-1",
                "kind": "top-level",
                "rlm_depth": 0,
                "cwd": "/home/ubuntu/prime-agent-rs",
                "runtime_config": {"model": "glm-5.3"},
                "queue": {"next_turn": [], "actions": {"pending": []}},
                "in_flight": {
                    "streaming": false, "compacting": false, "bash_running": true,
                    "rlm_children": false, "retrying": false, "prompt_in_flight": false
                },
                "should_resume": true
            },
            {
                "session_id": "01a0b4f6-0000-7000-8000-000000000002",
                "active_session_id": "a-2",
                "session_file": "~/.prime/agent/sessions/01a0b4f6-0000-7000-8000-000000000002.jsonl",
                "kind": "subagent",
                "parent_session_id": "01a0b4f6-0000-7000-8000-000000000001",
                "rlm_depth": 1,
                "cwd": "/home/ubuntu/prime-agent-rs",
                "runtime_config": {},
                "queue": {"next_turn": [], "actions": {}},
                "in_flight": {
                    "streaming": false, "compacting": false, "bash_running": false,
                    "rlm_children": false, "retrying": false, "prompt_in_flight": false
                },
                "should_resume": false
            }
        ],
        "workers": [
            {
                "worker_id": "w-1",
                "worker_instance_id": "w-1-abc",
                "sessions": ["01a0b4f6-0000-7000-8000-000000000001"],
                "launch_env": {"PRIME_AGENT_SESSION_DIR": "/tmp/sess"}
            }
        ],
        "subagents": [
            {
                "child_id": "c-1",
                "session_id": "01a0b4f6-0000-7000-8000-000000000002",
                "parent_session_id": "01a0b4f6-0000-7000-8000-000000000001",
                "name": "api-reviewer",
                "status": "completed",
                "depth": 2,
                "session_file": "~/.prime/agent/sessions/01a0b4f6-0000-7000-8000-000000000002.jsonl",
                "display_file": "~/.prime/agent/session-artifacts/01a0b4f6-0000-7000-8000-000000000002/rlm-subagent.json"
            }
        ],
        "heartbeats": [
            {
                "job_id": "j-1",
                "session_id": "01a0b4f6-0000-7000-8000-000000000001",
                "label": "watch builds",
                "schedule": "every 5m",
                "delivery_mode": "steer",
                "status": "active",
                "next_run_at": "2026-10-01T12:05:00Z"
            },
            {
                "job_id": "j-2",
                "session_id": "01a0b4f6-0000-7000-8000-000000000002",
                "schedule": "every 1h",
                "delivery_mode": "follow_up",
                "status": "paused",
                "next_run_at": "2026-10-01T13:00:00Z"
            }
        ]
    }"#;

    #[test]
    fn roster_roundtrip_spec_shape() {
        rt::<UpdateRoster>(ROSTER_JSON);
    }

    #[test]
    fn roster_rows_are_projection_data() {
        let roster: UpdateRoster = serde_json::from_str(ROSTER_JSON).unwrap();
        assert_eq!(roster.format_version, UPDATE_ROSTER_FORMAT_VERSION);
        let session = &roster.sessions[0];
        assert_eq!(session.kind, UpdateRosterSessionKind::TopLevel);
        assert!(session.should_resume);
        assert!(session.in_flight.bash_running);
        assert_eq!(
            roster.subagents[0].status,
            UpdateRosterSubagentStatus::Completed
        );
        assert_eq!(
            roster.heartbeats[0].delivery_mode,
            UpdateHeartbeatDeliveryMode::Steer
        );
        assert_eq!(
            roster.heartbeats[1].delivery_mode,
            UpdateHeartbeatDeliveryMode::FollowUp
        );
        assert_eq!(roster.heartbeats[1].status, UpdateHeartbeatStatus::Paused);
        // The heartbeat projection carries re-arm fields only: there is no
        // archive flag on the type (compile-level guarantee, asserted by
        // serialization shape here).
        let encoded = serde_json::to_value(&roster.heartbeats[0]).unwrap();
        assert!(!encoded.as_object().unwrap().contains_key("archived"));
        assert!(encoded.as_object().unwrap().contains_key("next_run_at"));
    }

    #[test]
    fn empty_collections_default_to_absent() {
        // A minimal roster with no sessions still parses, and serializes back
        // without the collection keys (spec: rows only appear when present).
        rt::<UpdateRoster>(
            r#"{"format_version":1,"update_id":"u","socket_path":"/s","created_at":"t","supervisor":{"pid":1,"generation":"g"},"binary":{"from_version":"a","to_version":"b"}}"#,
        );
    }

    #[test]
    fn queue_next_turn_carries_custom_messages() {
        rt::<UpdateRosterQueue>(
            r#"{"next_turn":[{"customType":"queued.note","content":"finish the build","display":true,"timestamp":1790856000000}],"actions":{"a":1}}"#,
        );
    }
}
