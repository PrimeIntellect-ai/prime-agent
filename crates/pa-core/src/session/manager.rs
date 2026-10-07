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

mod repair;
use repair::serialize_entry;
pub use repair::{load_entries_from_file, repair_jsonl_damage};

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
