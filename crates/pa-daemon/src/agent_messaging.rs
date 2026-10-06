//! Kernel `agent_message`/`agent_observe` controllers for daemon workers:
//! the supervisor-link family roster, worker-to-worker direct peer delivery
//! with the supervisor-routed fallback, and the wire receipt mapping.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use pa_core::session_engine::agent_messaging::{
    AgentFamilyMember, AgentFamilyRelationship, AgentFamilyStatus, AgentMessageController,
    AgentMessageDeliveryStatus, AgentMessageReceipt, AgentMessageSendInput, AgentObserveActivity,
    AgentObserveController, AgentObserveMessagePreview, AgentObserveSummary,
};

use crate::supervisor_link::SupervisorLink;

/// One session's durable family identity: the ids its family references it
/// by, and its recorded parent edge in every identifier form the roster
/// exposes. Membership derives from these edges alone, never from names.
#[derive(Debug, Clone, Default)]
pub(crate) struct FamilyIdentity {
    pub active_session_id: String,
    pub session_id: Option<String>,
    pub session_file: Option<String>,
    pub parent_active_session_id: Option<String>,
    pub parent_session_id: Option<String>,
    pub parent_session_path: Option<String>,
    /// This session's RLM depth (roots at 0): a child sits exactly one
    /// level down, a sibling at the same depth (TS `selectAgentFamily`).
    pub rlm_depth: u64,
}

impl FamilyIdentity {
    /// The identity from the worker's own pushed summary (its wire shape),
    /// with the active session id from the supervisor-link config.
    pub(crate) fn from_summary(summary: Option<&Value>, active_session_id: &str) -> Self {
        let non_empty = |value: Option<&Value>, key: &str| {
            value
                .and_then(|summary| summary.get(key))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        let summary_ref = summary;
        FamilyIdentity {
            active_session_id: active_session_id.to_string(),
            session_id: non_empty(summary_ref, "sessionId"),
            session_file: non_empty(summary_ref, "sessionFile"),
            parent_active_session_id: non_empty(summary_ref, "parentActiveSessionId"),
            parent_session_id: non_empty(summary_ref, "parentSessionId"),
            parent_session_path: summary_ref.and_then(parent_binding).map(str::to_string),
            rlm_depth: summary_ref.map_or(0, row_depth),
        }
    }

    /// A top-level session has no recorded parent edge in any form.
    fn is_top_level(&self) -> bool {
        self.parent_active_session_id.is_none()
            && self.parent_session_id.is_none()
            && self.parent_session_path.is_none()
    }
}

/// The non-empty string value of one roster-row field.
fn row_str<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

/// The row's RLM depth (TS `agent.rlmDepth ?? 0`); a row without the
/// field sits at the root depth.
fn row_depth(row: &Value) -> u64 {
    row.get("rlmDepth").and_then(Value::as_u64).unwrap_or(0)
}

/// A summary's session-file parent edge (TS `familyCatalogEntry`): a
/// depth-0 binding is a root fork's source, never a parent.
fn parent_binding(summary: &Value) -> Option<&str> {
    row_str(summary, "parentSessionPath").filter(|_| row_depth(summary) > 0)
}

/// Whether two session-file paths name the same session: canonical-path
/// equality first, then the durable session id from the file name.
pub(crate) fn same_session_file(left: &str, right: &str) -> bool {
    let canonical = |path: &str| {
        crate::lease::canonical_session_path(Path::new(path))
            .to_string_lossy()
            .to_string()
    };
    if canonical(left) == canonical(right) {
        return true;
    }
    session_file_id(left).is_some_and(|left_id| session_file_id(right) == Some(left_id))
}

/// The durable session id of one session-file path (the `.jsonl` file
/// stem), when the stem parses as a uuid-shaped session id.
fn session_file_id(path: &str) -> Option<String> {
    let stem = Path::new(path).file_stem()?.to_string_lossy().to_string();
    (!stem.is_empty() && uuid::Uuid::parse_str(&stem).is_ok()).then_some(stem)
}

/// Whether `row` is the parent of the session `identity` describes: the persisted session
/// id decides first, then the live active id, then the session-file alias.
fn row_is_parent(row: &Value, identity: &FamilyIdentity) -> bool {
    if let Some(parent_id) = identity.parent_session_id.as_deref() {
        if row_str(row, "sessionId") == Some(parent_id) {
            return true;
        }
    }
    if let Some(parent_active) = identity.parent_active_session_id.as_deref() {
        if row_str(row, "activeSessionId").or_else(|| row_str(row, "id")) == Some(parent_active) {
            return true;
        }
    }
    if let Some(parent_path) = identity.parent_session_path.as_deref() {
        // The peers roster carries the session file under `sessionPath`;
        // the supervisor's own roster rows carry `sessionFile`.
        if row_str(row, "sessionFile")
            .or_else(|| row_str(row, "sessionPath"))
            .is_some_and(|file| same_session_file(file, parent_path))
        {
            return true;
        }
    }
    false
}

/// Whether `row` is a child of the session `identity` describes: the row's durable parent
/// edge points back at this session. A file-bound row must sit exactly one level down
/// — a same-depth binding is a fork, never a child (TS `selectAgentFamily`).
fn row_is_child(row: &Value, identity: &FamilyIdentity) -> bool {
    if identity
        .session_id
        .as_deref()
        .is_some_and(|id| row_str(row, "parentSessionId").is_some_and(|parent| parent == id))
    {
        return true;
    }
    if !identity.active_session_id.is_empty()
        && row_str(row, "parentActiveSessionId") == Some(identity.active_session_id.as_str())
    {
        return true;
    }
    if identity.session_file.as_deref().is_some_and(|file| {
        parent_binding(row).is_some_and(|parent| same_session_file(parent, file))
            && row_depth(row) == identity.rlm_depth + 1
    }) {
        return true;
    }
    false
}

/// Whether `row` is a sibling of the session `identity` describes: for a subagent, the
/// row's durable parent edge points at the same parent; for a top-level session, another
/// parentless top-level session. A resumed subagent file re-opened top-level is not a root sibling.
fn row_is_sibling(row: &Value, identity: &FamilyIdentity) -> bool {
    if identity.is_top_level() {
        // A root session's siblings are the other root sessions: no recorded
        // parent edge in any form, and not a subagent runtime.
        let subagent_runtime = row_str(row, "runtimeKind").is_some_and(|kind| kind == "subagent");
        return !subagent_runtime
            && row_str(row, "parentSessionId").is_none()
            && row_str(row, "parentActiveSessionId").is_none()
            && parent_binding(row).is_none();
    }
    if let Some(parent_id) = identity.parent_session_id.as_deref() {
        if row_str(row, "parentSessionId") == Some(parent_id) {
            return true;
        }
    }
    if let Some(parent_active) = identity.parent_active_session_id.as_deref() {
        if row_str(row, "parentActiveSessionId") == Some(parent_active) {
            return true;
        }
    }
    if let Some(parent_path) = identity.parent_session_path.as_deref() {
        if parent_binding(row).is_some_and(|path| same_session_file(path, parent_path))
            && row_depth(row) == identity.rlm_depth
        {
            return true;
        }
    }
    false
}

mod message;
mod observe;

pub use message::LinkAgentMessageController;
pub(crate) use observe::LinkAgentObserveController;

#[cfg(test)]
mod controller_tests;
