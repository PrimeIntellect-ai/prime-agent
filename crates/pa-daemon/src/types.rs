//! Shared wire DTOs for the daemon protocol (session summaries, connection
//! state, queue snapshots, agent messages).
//!
//! Message payloads are carried as raw JSON (`serde_json::Value`) so the daemon
//! stays forward-compatible with the agent-loop lane's message evolution while
//! text helpers cover everything the session store and UI need.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type AgentMessage = Value;

/// Extract the text of a message content field (string or content blocks).
pub fn message_text(message: &Value) -> String {
    let Some(content) = message.get("content") else {
        return String::new();
    };
    content_to_text(content)
}

pub fn content_to_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    block.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

pub fn message_role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

pub fn message_timestamp_ms(message: &Value) -> Option<u64> {
    message.get("timestamp").and_then(Value::as_u64)
}

/// Lightweight daemon session shape used by list, create, rename, attach, and
/// state responses (port of `SessionSummary` in daemon-session-list.ts).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub lifecycle: String,
    pub activity: String,
    pub is_session_active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_registered_cron_job: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rlm_depth: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_session_id: Option<String>,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    pub is_streaming: bool,
    pub is_compacting: bool,
    /// True while the session is parked waiting out a provider-reported
    /// usage reset (TS `session.isQuotaParked`); the parked banner names
    /// the wake time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_quota_parked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_bash_running: Option<bool>,
    /// A streaming turn with tool calls in flight (TS `isRunningTools`:
    /// `isStreaming && pendingToolCalls.size > 0`); drives the agents-view
    /// activity label's `running tools` state.
    #[serde(default)]
    pub is_running_tools: bool,
    pub attached_clients: u32,
    pub message_count: u32,
    pub session_actions: SessionActionSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub streaming_message: Option<AgentMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_path: Option<String>,
    /// The parent's live active-session id (subagent summaries).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_active_session_id: Option<String>,
    /// The parent's persisted session id (subagent summaries).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    /// This subagent's child id under its parent (unique per parent; the
    /// roster agent id qualifies it with the parent path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rlm_child_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_state: Option<String>,
    /// The worker's roster-delta sequence counter at snapshot time (every
    /// roster delta this worker stamped before the snapshot carries a
    /// sequence at or below it): the supervisor's authoritative pulls
    /// (registration, create, refresh) gate against it in the same
    /// roster-lock section that writes the summary, so a delta still in
    /// flight when the pull answered is dropped instead of overwriting
    /// the pull's fresher state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roster_delta_sequence: Option<u64>,
    /// The worker process instance that took this summary (stamped with
    /// [`SessionSummary::roster_delta_sequence`], so the pair names the
    /// generation the counter orders): the supervisor's pull gate keys
    /// its stale-delta watermark by the generation that answered the
    /// pull, never by whichever process registered last — a delayed
    /// pull from a replaced process is stale by construction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<Value>,
    /// TS `modelFallbackMessage`: why a revived session's saved model fell
    /// back (the restore missed after the catalog-readiness window). A
    /// model fallback is never silent — the summary publishes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_fallback_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unfinished_action_count: Option<u32>,
}

/// Port of `SessionActionSnapshot` (core/session-action-store.ts).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActionSnapshot {
    pub queued_count: u32,
    pub steering: Vec<String>,
    pub follow_ups: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<SessionActionActive>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActionActive {
    pub kind: String,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Port of `AgentConnectionState` (modes/agent-connection/types.ts), the
/// per-session state block inside attach snapshots.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_session_id: Option<String>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<Value>,
    pub thinking_level: String,
    pub service_tier: String,
    pub available_thinking_levels: Vec<String>,
    pub is_streaming: bool,
    pub is_compacting: bool,
    pub is_bash_running: bool,
    pub retry_attempt: u32,
    pub steering_mode: String,
    pub follow_up_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_dir: Option<String>,
    #[serde(default)]
    pub leaf_id: Option<String>,
    pub auto_compaction_enabled: bool,
    pub message_count: u32,
    pub session_actions: SessionActionSnapshot,
    pub compaction_count: u32,
    pub goal: Value,
    #[serde(default)]
    pub scoped_models: Vec<Value>,
    #[serde(default)]
    pub active_tool_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recap: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_text_from_content_blocks() {
        let message = json!({
            "role": "user",
            "content": [{"type": "text", "text": "hello "}, {"type": "image"}, {"type": "text", "text": "world"}],
        });
        assert_eq!(message_text(&message), "hello  world");
        assert_eq!(message_role(&message), Some("user"));
    }

    #[test]
    fn session_summary_serializes_snake_case_and_reads_camel_case() {
        let wire = r#"{
            "id": "abc123def456",
            "lifecycle": "live",
            "activity": "idle",
            "isSessionActive": false,
            "sessionId": "sess",
            "cwd": "/tmp",
            "isStreaming": false,
            "isCompacting": false,
            "attachedClients": 1,
            "messageCount": 3,
            "sessionActions": {"queuedCount": 0, "steering": [], "followUps": []}
        }"#;
        let summary: SessionSummary =
            serde_json::from_str(wire).expect("parses camelCase wire format");
        assert_eq!(summary.message_count, 3);
        let out = serde_json::to_value(&summary).unwrap();
        assert_eq!(out["messageCount"], 3);
    }
}
