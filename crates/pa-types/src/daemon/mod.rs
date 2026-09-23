//! Daemon wire protocol, ported from
//! `packages/coding-agent/src/modes/daemon/daemon-protocol.ts` and
//! `daemon-worker-protocol.ts`.
//!
//! This is the local JSONL transport between clients (TUI/CLI), the supervisor,
//! and per-session worker processes. Frame and command shapes match the TS
//! wire format exactly. Payloads owned by other subsystems (session summaries,
//! agent-connection state objects, session events) are carried as opaque
//! [`Value`]s and will gain typed shapes in their owning crates.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::session::AgentMessage;
use crate::JsonMap;

pub const DAEMON_PROTOCOL_NAME: &str = "prime-agent.daemon";
pub const DAEMON_PROTOCOL_VERSION: u64 = 7;
pub const DAEMON_SCHEMA_REVISION: u64 = 29;
pub const DAEMON_SCHEMA_ID: &str = "protocol-7-schema-29-a5c9d20f8b13";

pub type DaemonClientId = String;
pub type DaemonCommandId = String;
pub type DaemonEventId = String;
pub type DaemonEventSequence = u64;
/// Client/server capability wire strings (closed TS unions, open on the wire
/// for older/newer builds, so carried as raw strings).
pub type DaemonClientCapability = String;
pub type DaemonServerCapability = String;

// ---------------------------------------------------------------------------
// Common frames
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonProtocolInfo {
    pub name: String,
    pub version: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonEventCursor {
    pub generation: String,
    pub sequence: DaemonEventSequence,
}

/// Resume cursor accepted on attach. The TS wire shape is a union: either a
/// `DaemonEventCursor` (`generation` + `sequence`, optionally with
/// `activeSessionId`) or a bare `eventSequence` with optional
/// `activeSessionId`. A single optional-field struct accepts both forms and
/// serializes each back to its original shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonResumeCursor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<DaemonEventSequence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_sequence: Option<DaemonEventSequence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DaemonReplayStatus {
    Complete,
    Partial,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonReplayInfo {
    pub status: DaemonReplayStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_sequence: Option<DaemonEventSequence>,
    pub to_sequence: DaemonEventSequence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_cursor: Option<DaemonEventCursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_cursor: Option<DaemonEventCursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonEventMeta {
    pub id: DaemonEventId,
    pub protocol: DaemonProtocolInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<DaemonEventSequence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<DaemonEventCursor>,
    pub emitted_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replayed: Option<bool>,
}

pub mod agent_roster;
mod command;
pub mod framing;
mod outbound;
mod plane;
pub mod update_flow;
mod worker;

pub use command::{
    CycleDirection, DaemonCommand, DaemonCommandEnvelope, DaemonCommandFrameType,
    DaemonCommandWire, DaemonExtensionUiResponse, DaemonSessionLifecycle, ForkPosition,
    PromptInput, StreamingBehavior,
};
pub use outbound::{
    DaemonClosingReason, DaemonErrorInfo, DaemonEventEnvelope, DaemonOutbound,
    DaemonPeerTransportTicket, DaemonResponse, DaemonRuntimeIdentity, DaemonSavedSessionInfo,
    DaemonSessionClosedReason, DaemonSessionSnapshot, SnapshotPurpose, SocketIdentity,
};
pub use plane::{
    command_plane, is_daemon_mutating_command, is_session_plane_daemon_command,
    is_update_drain_command, DaemonCommandPlane,
};
pub use update_flow::{
    legacy_update_restart_status, legacy_update_restarts_dir, prepared_marker_expiry,
    socket_update_dir, update_intent_path, update_marker_path, update_prepared_dir,
    update_restarts_dir, update_roster_path, update_status_path, update_transition_allowed,
    PreparedMarkerExpiry, UpdateHeartbeatDeliveryMode, UpdateHeartbeatStatus, UpdateId,
    UpdateIntent, UpdatePreparedMarker, UpdateProcessIdentity, UpdateRoster, UpdateRosterBinary,
    UpdateRosterHeartbeat, UpdateRosterInFlight, UpdateRosterQueue, UpdateRosterSession,
    UpdateRosterSessionKind, UpdateRosterSubagent, UpdateRosterSubagentStatus, UpdateRosterWorker,
    UpdateState, UpdateStatus, UpdateStatusCounts, UpdateStatusFailure, UpdateSupervisorIdentity,
    UpdateTimeoutBudget, UPDATE_ENV_PREFIX, UPDATE_ROSTER_FORMAT_VERSION,
    UPDATE_STATUS_FORMAT_VERSION,
};
pub use worker::{
    DaemonPeerCommand, DaemonUpdateRestartManifest, DaemonUpdateRestartQueue,
    DaemonUpdateRestartSession, DaemonWorkerCommand, DaemonWorkerDescriptor,
    DaemonWorkerFrameHeader, DaemonWorkerLifecycle, DaemonWorkerPeerGrant,
    DaemonWorkerRosterOutbound, DurableDaemonCreateCommand, PayloadEncoding,
    DAEMON_UPDATE_RESTART_FORMAT_VERSION,
};

/// Round-trip helper shared by the daemon wire tests: a parsed type must
/// serialize back to the exact original value.
#[cfg(test)]
pub(crate) fn rt<T: serde::Serialize + for<'de> serde::Deserialize<'de>>(json: &str) {
    let original: serde_json::Value = serde_json::from_str(json).unwrap();
    let parsed: T = serde_json::from_str(json).expect("deserialize");
    let out = serde_json::to_string(&parsed).expect("serialize");
    let reparsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(original, reparsed, "round trip changed the value: {out}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_wire_bare_and_envelope() {
        rt::<DaemonCommandWire>(r#"{"type":"list","id":"c1","cwd":"/w","future":1}"#);
        rt::<DaemonCommandWire>(
            r#"{"type":"command","id":"e1","protocol":{"name":"prime-agent.daemon","version":7},"clientId":"cl","command":{"type":"prompt","activeSessionId":"s1","message":"hi","queueIfBusy":true,"extra":"kept"}}"#,
        );
    }

    #[test]
    fn resume_cursor_and_replay_roundtrip() {
        rt::<DaemonResumeCursor>(r#"{"generation":"g","sequence":3,"activeSessionId":"s"}"#);
        rt::<DaemonResumeCursor>(r#"{"activeSessionId":"s","eventSequence":3}"#);
        rt::<DaemonReplayInfo>(
            r#"{"status":"unavailable","fromSequence":1,"toSequence":5,"fromCursor":{"generation":"g","sequence":1},"toCursor":{"generation":"g","sequence":5},"reason":"event_replay_not_available"}"#,
        );
    }

    #[test]
    fn protocol_constants_match_ts() {
        assert_eq!(DAEMON_PROTOCOL_NAME, "prime-agent.daemon");
        assert_eq!(DAEMON_PROTOCOL_VERSION, 7);
        assert_eq!(DAEMON_SCHEMA_REVISION, 29);
        assert_eq!(DAEMON_SCHEMA_ID, "protocol-7-schema-29-a5c9d20f8b13");
        assert_eq!(DAEMON_UPDATE_RESTART_FORMAT_VERSION, 1);
    }
}
