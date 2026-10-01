//! Kernel `agent_message`/`agent_observe` controllers for daemon workers:
//! the supervisor-link family roster, worker-to-worker direct peer delivery
//! (thin-supervisor stage 3) with the supervisor-routed fallback, and the
//! wire receipt mapping.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use pa_core::session_engine::agent_messaging::{
    AgentFamilyMember, AgentFamilyRelationship, AgentFamilyStatus, AgentMessageController,
    AgentMessageDeliveryStatus, AgentMessageReceipt, AgentMessageSendInput, AgentObserveActivity,
    AgentObserveController, AgentObserveMessagePreview, AgentObserveSummary,
};

use crate::supervisor_link::SupervisorLink;

// ---------------------------------------------------------------------------
// Supervisor-link controllers (kernel agent_message/agent_observe bridges)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Durable family edges (the nuclear-family classification)
// ---------------------------------------------------------------------------

/// One session's durable family identity: the ids its family references it
/// by, and its recorded parent edge in every identifier form the roster
/// exposes. Family membership is derived from these edges alone — never
/// from session names — so a parent-reply reaches its true parent across
/// worker restarts and storage moves, and a role-addressed send can never
/// cross families on a name collision.
#[derive(Debug, Clone, Default)]
pub(crate) struct FamilyIdentity {
    /// This session's live active session id.
    pub active_session_id: String,
    /// This session's persisted session id (the durable uuid).
    pub session_id: Option<String>,
    /// This session's session-file path.
    pub session_file: Option<String>,
    /// The parent's live active-session id (subagent sessions).
    pub parent_active_session_id: Option<String>,
    /// The parent's persisted session id (subagent sessions).
    pub parent_session_id: Option<String>,
    /// The parent's session-file path (subagent sessions and seeded rows).
    pub parent_session_path: Option<String>,
    /// This session's RLM depth (roots at 0): the family depth rule reads
    /// it — a child sits exactly one level down, a sibling at the same
    /// depth (TS `selectAgentFamily`).
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

/// The row's RLM depth (TS `agent.rlmDepth ?? 0`): a row without the
/// field sits at the root depth.
fn row_depth(row: &Value) -> u64 {
    row.get("rlmDepth").and_then(Value::as_u64).unwrap_or(0)
}

/// A summary's session-file parent edge (TS `familyCatalogEntry`:
/// `depth > 0 && parentSessionPath`): a depth-0 binding is a root
/// fork's source, never a parent — the fork stays a root.
fn parent_binding(summary: &Value) -> Option<&str> {
    row_str(summary, "parentSessionPath").filter(|_| row_depth(summary) > 0)
}

/// Whether two session-file paths name the same session: canonical-path
/// equality first, then the durable session id extracted from the file
/// name (the storage-root alias — the same session recorded under the
/// pre-migration root and the migrated root resolves to one parent).
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

/// Whether `row` is the parent of the session `identity` describes: the
/// persisted session id decides first (it survives worker replacements
/// and storage moves), then the live active id, then the session-file
/// alias (a passivated parent's seeded row carries only the path).
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
        // The peers roster (`list_agent_peers` -> `agent_peer_summary`)
        // carries the session file under `sessionPath`; the supervisor's
        // own roster rows carry `sessionFile`.
        if row_str(row, "sessionFile")
            .or_else(|| row_str(row, "sessionPath"))
            .is_some_and(|file| same_session_file(file, parent_path))
        {
            return true;
        }
    }
    false
}

/// Whether `row` is a child of the session `identity` describes: the row's
/// durable parent edge points back at this session by its persisted id,
/// its live id, or its session file. The spawn-id edges decide on their
/// own (only spawned children carry them, and a spawn always sits one
/// level below its parent); a file-bound row must sit exactly one level
/// down as well — a same-depth binding is a fork of this session, never
/// its child (TS `selectAgentFamily`).
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

/// Whether `row` is a sibling of the session `identity` describes: for a
/// subagent, the row's durable parent edge points at the same parent
/// (persisted id, live id, or session-file alias ([`parent_binding`]);
/// a file-bound row must also sit at this session's depth (TS
/// `selectAgentFamily`)); for a top-level session, the row is another
/// parentless top-level session (root sessions are each other's
/// family). A resumed subagent file re-opened as a top-level runtime
/// keeps its parent edge and is not a root sibling.
fn row_is_sibling(row: &Value, identity: &FamilyIdentity) -> bool {
    if identity.is_top_level() {
        // A root session's siblings are the other root sessions: no
        // recorded parent edge in any form, and not a subagent runtime
        // (an orphaned subagent row has no durable family at all; a
        // resumed subagent file re-opened top-level keeps its parent
        // path and is not a root either). A root fork's depth-0
        // binding is no parent edge, so it is a root too.
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

// The kernel agent_message/agent_observe bridge controllers moved to the
// child modules at the same tree position
// (agent_messaging::{message,observe}); the re-exports keep the facade's
// type paths stable (agent_engine.rs's use + the agent-family e2e
// verifier), the binding exposes the observe family helper to the tests
// glob. The durable family-edges concern (FamilyIdentity + the row
// classification) stays facade-resident: both controllers drive it.
mod message;
mod observe;

pub use message::LinkAgentMessageController;
pub(crate) use observe::LinkAgentObserveController;

// The controller test battery moved to the child module at the same tree
// position (agent_messaging::controller_tests); the #[cfg(test)] decl
// rides at the facade tail.
#[cfg(test)]
mod controller_tests;
