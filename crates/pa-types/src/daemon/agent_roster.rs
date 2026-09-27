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

/// View-specific labels for the shared activity branch table below (TS
/// `SessionActivityOptions`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionActivityOptions {
    /// Label for a row with an armed heartbeat (the agents view adds a
    /// live countdown; a static table has no next-run timer).
    pub heartbeat_label: String,
    /// Fallback when no branch fires (the agents view says "needs input";
    /// the sessions table leaves the cell empty because its status column
    /// already says idle).
    pub idle_label: String,
}

/// The one activity branch table (TS `sessionActivityDetail`): what a
/// session is doing right now, read from the wire summary's runtime flags.
/// The agents view status label and the CLI sessions table activity column
/// both derive from it, so a state added here serves every surface. The
/// TS action branch (agents-view-only labels over `sessionActions`) rides
/// with that view's port; the roster rows this table reads carry an empty
/// action snapshot, so no branch is missing.
///
/// `statusLabel` and `lastHeardFromAt` stay with the caller: the agents
/// view returns them before delegating, the sessions table gives them
/// their own columns.
pub fn session_activity_detail(summary: &Value, options: &SessionActivityOptions) -> String {
    let str_field = |name: &str| summary.get(name).and_then(Value::as_str);
    let active = |name: &str| summary.get(name).and_then(Value::as_bool) == Some(true);
    // A non-ready worker cannot report fresh runtime flags; its state is
    // the row's story. A row already carrying the ledger mark keeps that
    // mark out of the activity (its surface shows it as the status).
    if let Some(worker_state) = str_field("workerState") {
        if str_field("statusLabel").is_none() && worker_state != "ready" {
            return worker_state.to_string();
        }
    }
    if summary
        .get("isCompacting")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return "compacting".to_string();
    }
    if summary
        .get("isStreaming")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return if active("isRunningTools") {
            "running tools"
        } else {
            "thinking"
        }
        .to_string();
    }
    // Tool/bash activity classifies the session as running; the label must
    // agree with that classification instead of claiming it needs input.
    if active("isRunningTools") {
        return "running tools".to_string();
    }
    if active("isBashRunning") {
        return "running bash".to_string();
    }
    if str_field("lifecycle") == Some("archived") {
        return "archived".to_string();
    }
    if summary
        .get("hasActiveHeartbeat")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return options.heartbeat_label.clone();
    }
    if str_field("runtimeKind") == Some("subagent") && active("repliedSinceTask") {
        return "replied".to_string();
    }
    if str_field("activity") == Some("working") {
        return "classifying".to_string();
    }
    if str_field("taskState") == Some("error") {
        return "error".to_string();
    }
    if str_field("taskState") == Some("completed") {
        return "completed".to_string();
    }
    options.idle_label.clone()
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

    /// The minimal wire summary the branch table reads; tests merge field
    /// overrides into it.
    fn activity_summary(overrides: Value) -> Value {
        let mut summary = json!({
            "id": "s",
            "lifecycle": "live",
            "activity": "idle",
            "isStreaming": false,
            "isCompacting": false,
        });
        match (&mut summary, overrides) {
            (Value::Object(base), Value::Object(over)) => {
                for (key, value) in over {
                    base.insert(key, value);
                }
            }
            _ => panic!("summary fixtures must be objects"),
        }
        summary
    }

    #[test]
    fn activity_detail_branches_match_the_shared_wording() {
        let options = SessionActivityOptions {
            heartbeat_label: "heartbeat".to_string(),
            idle_label: String::new(),
        };
        let detail =
            |overrides: Value| session_activity_detail(&activity_summary(overrides), &options);
        assert_eq!(
            detail(json!({ "activity": "working", "isStreaming": true, "isRunningTools": true })),
            "running tools"
        );
        assert_eq!(
            detail(json!({ "activity": "working", "isStreaming": true })),
            "thinking"
        );
        assert_eq!(
            detail(json!({ "activity": "working", "isBashRunning": true })),
            "running bash"
        );
        assert_eq!(
            detail(json!({ "activity": "working", "isCompacting": true })),
            "compacting"
        );
        assert_eq!(
            detail(json!({ "activity": "working", "workerState": "starting" })),
            "starting"
        );
        assert_eq!(detail(json!({ "lifecycle": "archived" })), "archived");
        assert_eq!(
            detail(json!({ "runtimeKind": "subagent", "repliedSinceTask": true })),
            "replied"
        );
        assert_eq!(detail(json!({ "activity": "working" })), "classifying");
        assert_eq!(detail(json!({ "taskState": "error" })), "error");
        assert_eq!(detail(json!({ "taskState": "completed" })), "completed");
        // No branch fires: the surface's idle fallback.
        assert_eq!(detail(json!({})), "");
    }

    #[test]
    fn activity_detail_labels_carry_the_surface_options() {
        let view = SessionActivityOptions {
            heartbeat_label: "heartbeat \u{b7} next 3m".to_string(),
            idle_label: "needs input".to_string(),
        };
        assert_eq!(
            session_activity_detail(
                &activity_summary(json!({ "hasActiveHeartbeat": true })),
                &view
            ),
            "heartbeat \u{b7} next 3m"
        );
        assert_eq!(
            session_activity_detail(&activity_summary(json!({})), &view),
            "needs input"
        );
        let table = SessionActivityOptions {
            heartbeat_label: "heartbeat".to_string(),
            idle_label: String::new(),
        };
        assert_eq!(
            session_activity_detail(
                &activity_summary(json!({ "hasActiveHeartbeat": true })),
                &table
            ),
            "heartbeat"
        );
        assert_eq!(
            session_activity_detail(&activity_summary(json!({})), &table),
            ""
        );
    }

    #[test]
    fn activity_detail_worker_state_waits_for_no_ledger_mark() {
        let options = SessionActivityOptions {
            heartbeat_label: "heartbeat".to_string(),
            idle_label: String::new(),
        };
        // A ready worker is not the row's story: the runtime flags are.
        assert_eq!(
            session_activity_detail(
                &activity_summary(json!({ "workerState": "ready" })),
                &options
            ),
            ""
        );
        // A row already carrying the ledger mark keeps the worker state
        // out of the activity: its surface shows the mark as the status.
        assert_eq!(
            session_activity_detail(
                &activity_summary(
                    json!({ "statusLabel": "queued", "workerState": "starting", "activity": "working" })
                ),
                &options,
            ),
            "classifying"
        );
        // Without the mark, a non-ready worker is the story.
        assert_eq!(
            session_activity_detail(
                &activity_summary(json!({ "workerState": "recovering" })),
                &options
            ),
            "recovering"
        );
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
            rest: JsonMap::default(),
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
