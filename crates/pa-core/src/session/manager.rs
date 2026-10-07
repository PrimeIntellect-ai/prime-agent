//! `SessionManager`: the stateful session writer (create/new/append/persist,
//! crash repair, index).

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use pa_types::session::{
    AgentMessage, ChildUsageOrigin, EntryBase, FileEntry, GitContext, SessionHeader, SessionState,
    SessionStateStatus,
};

use super::tree::SessionTree;
use super::{migrate_to_current_version, parse_session_entries, CURRENT_SESSION_VERSION};

#[cfg(test)]
mod tests;

mod append;

// The persist concern (the entry index, the rewrite/flush/notify plumbing,
// the durable append arm, and the atomic write) moved to the child module
// at the same tree position (session::manager::persist); the pub(super)
// bumps carry the cross-child callers (lifecycle/queries refresh +
// build_index + rewrite_file; append persist_entry; repair atomic_write;
// notices try_rewrite_file + notify_persist_listeners). on_persist,
// is_persisted + flush_now keep their pub levels; try_rewrite_file +
// notify_persist_listeners stay private (child-internal callers).
mod persist;
use persist::atomic_write;

mod queries;
use super::{build_session_context, SessionContext};

mod lifecycle;
use super::window;

// `get_session_file_path` has zero external callers; the re-export keeps
// the pub path stable and avoids dead-code churn.
mod ids;
use ids::{create_session_id, generate_id};
pub use ids::{format_iso, format_iso_now, get_session_file_path};

mod header;
pub use header::read_session_header;
use header::{is_valid_rlm_depth, resolve_session_rlm_depth, root_rlm_depth_from_env};

mod git;
pub use git::capture_git_context;

// The re-export has zero external callers; it keeps the pub path stable.
mod repair;
pub use repair::load_entries_from_file;
use repair::serialize_entry;

// The durable terminal-notice concern (the strict keyed append of an
// RLM child terminal notice, the consumption marker, and the
// file-backed unconsumed scan) lives in the child module at the same
// tree position (session::manager::notices); the re-exports keep the
// wire vocabulary stable for the engine's row factories (the canonical
// factories live in session_engine::rlm_notices).
mod notices;
pub use notices::{
    AGENT_MESSAGE_CUSTOM_TYPE, AGENT_MESSAGE_KEY_FIELD, NOTICE_CONSUMED_CUSTOM_TYPE,
    NOTICE_CONSUMED_KEYS_FIELD, NOTICE_KEY_FIELD, TERMINAL_NOTICE_CUSTOM_TYPES,
};
// The test-build fault hooks for the strict notice append are pub(crate)
// inside the child module; lift them so the engine's in-process host
// tests can reach `crate::session::manager::fault_hooks::{arm, disarm,
// Fault, take}` without the private module path.
#[cfg(test)]
pub(crate) use notices::fault_hooks;

/// A persist observer; must not break session writes (panics are contained).
pub type SessionPersistListener = Box<dyn Fn(&Path) + Send + Sync>;

#[derive(Default)]
pub struct NewSessionOptions {
    pub id: Option<String>,
    pub parent_session: Option<String>,
    pub rlm_depth: Option<u64>,
}

// The mirrored TS API shape is deliberate (the booleans are the
// product's own surface, not a refactor target).
#[allow(clippy::struct_excessive_bools)]
pub struct SessionManager {
    session_id: String,
    session_file: Option<PathBuf>,
    session_dir: PathBuf,
    cwd: PathBuf,
    persist: bool,
    /// Whether the manager carries a session directory of its own (any
    /// persisted manager, and the daemon's mirrored engine session): the
    /// session-owned artifacts (local harness state) resolve under it.
    session_dir_backed: bool,
    flushed: bool,
    has_assistant_entry: bool,
    append_ownership: super::window::AppendOwnership,
    file_entries: Vec<FileEntry>,
    window: Option<super::window::WindowedSessionStore>,
    by_id: HashMap<String, usize>,
    labels_by_id: HashMap<String, String>,
    label_timestamps_by_id: HashMap<String, String>,
    leaf_id: Option<String>,
    persist_listeners: Vec<SessionPersistListener>,
    /// A failed notice-tail repair poisoned the writer: blind
    /// single-line appends would splice onto an uncertain tail, so they
    /// fail fast with the stored error until a successful wholesale
    /// rewrite (the atomic replace from the consistent in-memory index)
    /// clears it, or the session is reopened (open-time repair owns
    /// the tail then).
    write_poison: Option<std::sync::Arc<std::io::Error>>,
    /// Test builds only: refuse every strict notice write before it
    /// touches the file (`set_notice_append_fault`).
    #[cfg(test)]
    notice_append_fault: bool,
}

/// The refine transcript's consumed artifacts: the conversation message
/// rows (sequence order) and the in-session refinement history (the audit
/// scan's output). Extracting them directly spares an owned copy of every
/// entry.
#[derive(Debug, Default)]
pub struct RefineTranscriptParts {
    pub messages: Vec<AgentMessage>,
    pub refinement_history: Vec<crate::refinement::RefinementResult>,
}
