//! The agent-roster vocabulary shared by the supervisor's roster store and
//! every viewing surface (the TUI agents view, agent observation). Port of
//! `modes/daemon/agent-roster.ts`: the one status formula every surface
//! shares, the roster agent-id formula, and the wire entry shape carried by
//! `roster_subscribe` responses and `roster_update` pushes.

use crate::JsonMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One status formula output (TS `AgentRosterStatus`). Surfaces adapt their
/// inputs and never reimplement the classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentRosterStatus {
    Running,
    Idle,
    Inactive,
}

/// The inputs to the status formula (TS `AgentStatusInput`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentStatusInput {
    /// A live runtime exists for the agent.
    pub resident: bool,
    /// An admitted child run whose session has not materialized yet.
    pub queued_child: bool,
    /// Actively working: streaming or running tools/bash.
    pub busy: bool,
}

/// The one status formula (TS `classifyAgentStatus`).
pub fn classify_agent_status(input: AgentStatusInput) -> AgentRosterStatus {
    if input.queued_child {
        return AgentRosterStatus::Running;
    }
    if !input.resident {
        return AgentRosterStatus::Inactive;
    }
    if input.busy {
        AgentRosterStatus::Running
    } else {
        AgentRosterStatus::Idle
    }
}

/// Classify one session summary (TS `classifySessionRosterStatus`): a
/// resident session is busy when its activity is `working` or the session
/// reports an active turn.
pub fn classify_session_roster_status(
    resident: bool,
    activity: &str,
    session_active: bool,
    queued_child: bool,
) -> AgentRosterStatus {
    classify_agent_status(AgentStatusInput {
        resident,
        queued_child,
        busy: activity == "working" || session_active,
    })
}

/// Classify a summary in its wire (JSON) form: `Value` in, status out.
pub fn classify_summary_value(summary: &Value, queued_child: bool) -> AgentRosterStatus {
    let resident = summary
        .get("activeSessionId")
        .is_some_and(|id| !id.is_null() && id.as_str() != Some(""));
    let activity = summary
        .get("activity")
        .and_then(Value::as_str)
        .unwrap_or("idle");
    let session_active = summary
        .get("isSessionActive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    classify_session_roster_status(resident, activity, session_active, queued_child)
}

/// The roster agent id (TS `rosterAgentIdForSummary`): child ids are only
/// unique per parent, so the parent key (canonical session path, or the
/// live parent id for no-session parents) qualifies them daemon-wide;
/// top-level sessions key by session id. The caller passes the parent path
/// already canonicalized.
pub fn roster_agent_id(
    session_id: &str,
    runtime_kind: &str,
    rlm_child_id: Option<&str>,
    parent_key: Option<&str>,
) -> String {
    if runtime_kind == "subagent" {
        if let Some(child_id) = rlm_child_id {
            // No-session parents have no path (and no ledger edge); their
            // live parent id still disambiguates.
            return match parent_key {
                Some(key) if !key.is_empty() => format!("{key}#{child_id}"),
                _ => child_id.to_string(),
            };
        }
    }
    session_id.to_string()
}

/// The roster agent id for a summary in its wire (JSON) form.
pub fn roster_agent_id_for_summary(summary: &Value) -> String {
    let session_id = summary
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let runtime_kind = summary
        .get("runtimeKind")
        .and_then(Value::as_str)
        .unwrap_or("top-level");
    let child_id = summary.get("rlmChildId").and_then(Value::as_str);
    let parent_key = summary
        .get("parentSessionPath")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .or_else(|| {
            summary
                .get("parentActiveSessionId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
        });
    roster_agent_id(session_id, runtime_kind, child_id, parent_key)
}

/// One roster entry (TS `AgentRosterEntry`): the agent's slim session
/// summary with the supervisor's classification. `statusLabel` and
/// `lastHeardFromAt` are set only for exceptional states; viewers key label
/// display on their presence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRosterEntry {
    pub agent_id: String,
    /// `true` marks an admitted child run whose session has not
    /// materialized yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_child: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seeded_cwd: Option<bool>,
    /// The slim session summary (the wire summary without
    /// `streamingMessage`/`sessionActions`/`diagnostics`).
    pub summary: Value,
    pub status: AgentRosterStatus,
    /// `queued` / `recovering` / `failed` (TS `statusLabel`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_heard_from_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_id: Option<String>,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// The slim summary a worker reports for the roster (TS
/// `workerRosterEntryFromSummary`): the full summary minus the
/// streaming-message, session-actions, and diagnostics fields.
pub fn slim_roster_summary(summary: Value) -> Value {
    let mut summary = summary;
    if let Value::Object(map) = &mut summary {
        map.remove("streamingMessage");
        map.remove("sessionActions");
        map.remove("diagnostics");
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn status_formula_matches_ts() {
        use AgentRosterStatus::*;
        let input = |resident, queued_child, busy| AgentStatusInput {
            resident,
            queued_child,
            busy,
        };
        assert_eq!(classify_agent_status(input(false, false, false)), Inactive);
        assert_eq!(classify_agent_status(input(false, true, false)), Running);
        assert_eq!(classify_agent_status(input(true, false, false)), Idle);
        assert_eq!(classify_agent_status(input(true, false, true)), Running);
        // A queued child stays running even without a resident runtime.
        assert_eq!(classify_agent_status(input(true, true, false)), Running);
    }

    #[test]
    fn session_classification_reads_activity_and_active_turn() {
        let summary = json!({ "activeSessionId": "a1", "activity": "working" });
        assert_eq!(
            classify_summary_value(&summary, false),
            AgentRosterStatus::Running
        );
        let summary = json!({ "activeSessionId": "a1", "activity": "idle" });
        assert_eq!(
            classify_summary_value(&summary, false),
            AgentRosterStatus::Idle
        );
        // An active turn marks running even when the activity label is idle.
        let summary =
            json!({ "activeSessionId": "a1", "activity": "idle", "isSessionActive": true });
        assert_eq!(
            classify_summary_value(&summary, false),
            AgentRosterStatus::Running
        );
        // No active session id: not resident.
        let summary = json!({ "activity": "working" });
        assert_eq!(
            classify_summary_value(&summary, false),
            AgentRosterStatus::Inactive
        );
    }

    #[test]
    fn agent_ids_qualify_children_by_parent_key() {
        // Top-level: session id.
        assert_eq!(roster_agent_id("s1", "top-level", None, None), "s1");
        // Subagent: parent path + child id.
        assert_eq!(
            roster_agent_id("s2", "subagent", Some("7"), Some("/x/sess.jsonl")),
            "/x/sess.jsonl#7"
        );
        // No-session parent: live parent id qualifies.
        assert_eq!(
            roster_agent_id("s2", "subagent", Some("7"), Some("a1")),
            "a1#7"
        );
        // No parent key at all: bare child id.
        assert_eq!(roster_agent_id("s2", "subagent", Some("7"), None), "7");
    }

    #[test]
    fn agent_id_from_summary_wire_form() {
        let summary = json!({
            "sessionId": "s2",
            "runtimeKind": "subagent",
            "rlmChildId": "7",
            "parentActiveSessionId": "a1",
        });
        assert_eq!(roster_agent_id_for_summary(&summary), "a1#7");
        // parentSessionPath wins over the live parent id.
        let summary = json!({
            "sessionId": "s2",
            "runtimeKind": "subagent",
            "rlmChildId": "7",
            "parentSessionPath": "/x/sess.jsonl",
            "parentActiveSessionId": "a1",
        });
        assert_eq!(roster_agent_id_for_summary(&summary), "/x/sess.jsonl#7");
    }

    #[test]
    fn entry_round_trips_the_wire_shape() {
        let entry = AgentRosterEntry {
            agent_id: "s1".to_string(),
            queued_child: None,
            seeded_cwd: None,
            summary: json!({ "sessionId": "s1" }),
            status: AgentRosterStatus::Idle,
            status_label: None,
            last_heard_from_at: None,
            worker_id: Some("w1".to_string()),
            rest: Default::default(),
        };
        let value = serde_json::to_value(&entry).unwrap();
        assert_eq!(value["agentId"], "s1");
        assert_eq!(value["status"], "idle");
        assert_eq!(value["workerId"], "w1");
        let back: AgentRosterEntry = serde_json::from_value(value).unwrap();
        assert_eq!(back, entry);
    }

    #[test]
    fn slim_summary_drops_view_only_fields() {
        let summary = json!({
            "sessionId": "s1",
            "streamingMessage": { "role": "assistant" },
            "sessionActions": { "queuedCount": 0 },
            "diagnostics": [],
        });
        let slim = slim_roster_summary(summary);
        assert_eq!(slim["sessionId"], "s1");
        assert!(slim.get("streamingMessage").is_none());
        assert!(slim.get("sessionActions").is_none());
        assert!(slim.get("diagnostics").is_none());
    }
}
