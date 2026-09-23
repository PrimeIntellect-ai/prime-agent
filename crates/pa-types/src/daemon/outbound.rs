//! Responses and outbound events: `DaemonResponse`, `DaemonErrorInfo`, session
//! snapshot payloads, and the `DaemonOutbound` event union.

use super::*;

// ---------------------------------------------------------------------------
// Responses and outbound events
// ---------------------------------------------------------------------------

/// `type: "response"`: success or failure outcome of one command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub command: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_info: Option<DaemonErrorInfo>,
}

/// Structured failure info carried on error responses, tagged by `code`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "code",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DaemonErrorInfo {
    MissingSessionCwd {
        issue: Value,
    },
    SessionImportFileNotFound {
        file_path: String,
    },
    SessionAlreadyActive {
        session_path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_session_id: Option<String>,
    },
    SessionRecovering {
        active_session_id: String,
    },
    CommandResultUncertain {
        client_id: DaemonClientId,
        command_id: DaemonCommandId,
    },
    /// `prepare_update_restart` with a different `updateId` while a prepare
    /// transaction is active: a typed refusal the coordinator maps to
    /// `Join` (spec `docs/update-flow-state-machine.md` §4).
    UpdatePrepareRefused {
        active_update_id: String,
    },
}

/// Saved-session row pushed by `session_list_item` progress events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonSavedSessionInfo {
    pub path: String,
    pub id: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rlm_depth: Option<u64>,
    pub created: String,
    pub modified: String,
    pub message_count: u64,
    pub first_message: String,
    pub all_messages_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_status: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<Value>,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// Full session snapshot (attach, replacement, resync).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonSessionSnapshot {
    pub active_session_id: String,
    pub summary: Value,
    pub state: Value,
    pub messages: Vec<AgentMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_context: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_tree: Option<Value>,
    pub last_event_sequence: DaemonEventSequence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_event_cursor: Option<DaemonEventCursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Value>,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// Process identity of the daemon build, published in `daemon_hello`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonRuntimeIdentity {
    pub build_id: String,
    pub executable_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entrypoint_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launcher_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DaemonClosingReason {
    Shutdown,
    Update,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DaemonSessionClosedReason {
    Killed,
    Shutdown,
    Completed,
    Replaced,
    Update,
}

/// Single-use credential for one direct TUI-to-worker connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonPeerTransportTicket {
    pub purpose: String,
    pub socket_path: String,
    pub socket_identity: SocketIdentity,
    pub worker_instance_id: String,
    pub active_session_id: String,
    pub grant_id: String,
    pub token: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SocketIdentity {
    pub dev: u64,
    pub ino: u64,
}

/// Purpose tag of a `session_snapshot_begin` record. The catch-up value is
/// `resync` on the wire (`daemon-protocol.ts`:
/// `"attach" | "replacement" | "resync"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotPurpose {
    Attach,
    Replacement,
    #[serde(rename = "resync")]
    Catchup,
}

/// `type: "event"` envelope wrapping a [`DaemonOutbound`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonEventEnvelope {
    pub id: DaemonEventId,
    pub protocol: DaemonProtocolInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<DaemonEventSequence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<DaemonEventCursor>,
    pub emitted_at: String,
    pub event: DaemonOutbound,
}

/// Supervisor -> client frames, tagged by `type`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DaemonOutbound {
    Response {
        #[serde(flatten)]
        response: DaemonResponse,
    },
    SessionListProgress {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_session_id: Option<String>,
        loaded: u64,
        total: u64,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SessionListItem {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_session_id: Option<String>,
        session: DaemonSavedSessionInfo,
        #[serde(flatten)]
        rest: JsonMap,
    },
    DaemonHello {
        socket_path: String,
        protocol: DaemonProtocolInfo,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        schema_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        schema_revision: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<DaemonRuntimeIdentity>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        supervisor_generation: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        supervisor_pid: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        supervisor_owner_token: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        supervisor_process_start_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        supervisor_socket_path: Option<String>,
        /// The update resume contract (spec §10.3): whether the supervisor's
        /// restore pass has finished, so a reconnecting client knows whether
        /// to queue its attach. Rust-only extension over the TS hello.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        update_resume: Option<crate::daemon::update_flow::DaemonUpdateResume>,
        client_id: DaemonClientId,
        server_capabilities: Vec<DaemonServerCapability>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    DaemonClosing {
        reason: DaemonClosingReason,
        #[serde(flatten)]
        rest: JsonMap,
    },
    HeartbeatsChanged {
        #[serde(flatten)]
        rest: JsonMap,
    },
    RosterUpdate {
        changed: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        removed: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resync: Option<bool>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SessionEvent {
        active_session_id: String,
        event: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<DaemonEventMeta>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SideQuestionEvent {
        active_session_id: String,
        event: Value,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SessionStatus {
        active_session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recap: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<DaemonEventMeta>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SessionReplaced {
        active_session_id: String,
        state: Value,
        messages: Vec<AgentMessage>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        snapshot_follows: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<DaemonEventMeta>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SessionResynced {
        active_session_id: String,
        snapshot: DaemonSessionSnapshot,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<DaemonEventMeta>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SessionAttached {
        active_session_id: String,
        state: Value,
        messages: Vec<AgentMessage>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        snapshot: Option<DaemonSessionSnapshot>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        replay: Option<DaemonReplayInfo>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_event_sequence: Option<DaemonEventSequence>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SessionSnapshotBegin {
        active_session_id: String,
        snapshot_id: String,
        #[serde(flatten)]
        snapshot: Value,
        message_count: u64,
        target_chunk_bytes: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        purpose: Option<SnapshotPurpose>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SessionSnapshotChunk {
        active_session_id: String,
        snapshot_id: String,
        index: u64,
        messages: Vec<AgentMessage>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SessionSnapshotEnd {
        active_session_id: String,
        snapshot_id: String,
        chunk_count: u64,
        last_event_sequence: DaemonEventSequence,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_event_cursor: Option<DaemonEventCursor>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SessionSnapshotFailed {
        active_session_id: String,
        snapshot_id: String,
        error: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SessionDetached {
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    /// The stale-id rebind notice (Rust-only extension over the TS wire): a
    /// worker replacement rebound a session, and the id the client holds is
    /// superseded. Old clients ignore the unknown type; attached clients
    /// re-attach to the session's current id so their event routing follows
    /// it.
    SessionBinding {
        previous_active_session_id: String,
        active_session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_file: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SessionClosed {
        active_session_id: String,
        reason: DaemonSessionClosedReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<DaemonEventMeta>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    ExtensionUiRequest {
        active_session_id: String,
        id: String,
        method: String,
        payload: JsonMap,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<DaemonEventMeta>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    ExtensionError {
        active_session_id: String,
        extension_path: String,
        event: String,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<DaemonEventMeta>,
        #[serde(flatten)]
        rest: JsonMap,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn response_and_error_info_roundtrip() {
        rt::<DaemonOutbound>(
            r#"{"type":"response","id":"r1","command":"prompt","success":true,"data":{"x":1}}"#,
        );
        rt::<DaemonOutbound>(
            r#"{"type":"response","id":"r2","command":"attach","success":false,"error":"boom","errorInfo":{"code":"session_already_active","sessionPath":"/s.jsonl","activeSessionId":"a"}}"#,
        );
        rt::<DaemonOutbound>(
            r#"{"type":"response","command":"import_jsonl","success":false,"error":"e","errorInfo":{"code":"session_import_file_not_found","filePath":"/x"}}"#,
        );
    }

    #[test]
    fn snapshot_purpose_tags_match_the_wire() {
        assert_eq!(
            serde_json::to_value(SnapshotPurpose::Attach).unwrap(),
            json!("attach")
        );
        assert_eq!(
            serde_json::to_value(SnapshotPurpose::Replacement).unwrap(),
            json!("replacement")
        );
        // The catch-up purpose is `resync` on the wire, never `catchup`.
        assert_eq!(
            serde_json::to_value(SnapshotPurpose::Catchup).unwrap(),
            json!("resync")
        );
        assert_eq!(
            serde_json::from_value::<SnapshotPurpose>(json!("resync")).unwrap(),
            SnapshotPurpose::Catchup
        );
    }

    #[test]
    fn hello_and_snapshot_roundtrip() {
        rt::<DaemonOutbound>(
            r#"{"type":"daemon_hello","socketPath":"/sock","protocol":{"name":"prime-agent.daemon","version":7},"schemaId":"protocol-7-schema-28-92bc5368a082","schemaRevision":28,"appVersion":"1.0","supervisorGeneration":"g","supervisorPid":42,"clientId":"c","serverCapabilities":["attach_snapshot","event_sequence"]}"#,
        );
        let msg = r#"{"role":"user","content":"hi","timestamp":1}"#;
        rt::<DaemonOutbound>(&format!(
            r#"{{"type":"session_attached","activeSessionId":"s","state":{{"a":1}},"messages":[{msg}],"replay":{{"status":"complete","toSequence":5}},"lastEventSequence":5}}"#
        ));
        rt::<DaemonOutbound>(
            r#"{"type":"session_snapshot_chunk","activeSessionId":"s","snapshotId":"sn","index":0,"messages":[{"role":"assistant","content":[{"type":"text","text":"t"}],"api":"a","provider":"p","model":"m","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1}]}"#,
        );
    }
}
