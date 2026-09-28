//! `SessionManager`: the stateful session writer. Port of the class half of
//! core/session-manager.ts (create/new/append/persist, crash repair, index).

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use pa_types::session::{
    AgentMessage, ChildUsageOrigin, EntryBase, FileEntry, GitContext, SessionHeader, SessionState,
    SessionStateStatus,
};

use super::tree::SessionTree;
use super::{migrate_to_current_version, parse_session_entries, CURRENT_SESSION_VERSION};

// The inline unit battery moved to the child module at the same tree
// position (session::manager::tests); its use-super glob keeps resolving
// through the facade bindings and re-exports (the session_store stage-1
// precedent).
#[cfg(test)]
mod tests;

// The append concern (the append family: messages, retained variants,
// changes, compactions, customs, child-usage attributions, session
// info/state - and the leaf/label mutators) moved to the child module at
// the same tree position (session::manager::append); every member keeps
// its pub/pub(crate) level (manager_ext.rs + the daemon callers resolve
// through the type). ZERO bumps.
mod append;

// The persist concern (the entry index, the rewrite/flush/notify plumbing,
// the durable append arm, and the atomic write) moved to the child module
// at the same tree position (session::manager::persist); the pub(super)
// bumps carry the cross-child callers (lifecycle/queries refresh +
// build_index + rewrite_file; append persist_entry; repair atomic_write)
// and the binding row serves the repair child bare call. on_persist,
// is_persisted + flush_now keep their pub levels; try_rewrite_file +
// notify_persist_listeners stay private (child-internal callers).
mod persist;
use persist::atomic_write;

// The queries concern (the derived state + accessor arm: the active
// context/history snapshot, the branch scans, the window-backed reads,
// and the getters) moved to the child module at the same tree position
// (session::manager::queries); every member keeps its pub level and the
// facade binding below serves the child super:: paths (active_context:
// SessionContext + build_session_context).
mod queries;
use super::{build_session_context, SessionContext};

// The lifecycle concern (the constructors, the open/fork/new/materialize/
// adopt arm, and the fork branch-copy helpers) moved to the child module
// at the same tree position (session::manager::lifecycle); every member
// keeps its pub level (external callers resolve through the type), the
// child resolves the facade re-exports/bindings via its use-super glob,
// and the `use super::window;` module binding serves the childrens
// super::window:: paths (open_windowed, adopt_window,
// set_append_ownership).
mod lifecycle;
use super::window;

// The id + timestamp mint (the session id minters, the session file
// path, and the ISO-8601 timestamps) moved to the child module at the
// same tree position (session::manager::ids); the re-exports keep the
// pub API paths stable (format_iso 8 + format_iso_now 5 external callers;
// get_session_file_path has zero external callers - the re-export keeps
// the path stable and avoids dead-code lint churn, the session_store
// find_most_recent_session_for_cwd precedent) and the pub(super)
// bindings keep the constructors' + the append arm's bare calls in scope.
mod ids;
use ids::{create_session_id, generate_id};
pub use ids::{format_iso, format_iso_now, get_session_file_path};

// The header + rlm-depth concern (the first-line header read and the
// RLM depth resolution) moved to the child module at the same tree
// position (session::manager::header); the re-export keeps the pub API
// path stable (discovery.rs) and the pub(super) bindings keep the
// constructors' bare calls in scope (set_session_file, new_session,
// fork_from, materialize_session_file).
mod header;
pub use header::read_session_header;
use header::{is_valid_rlm_depth, resolve_session_rlm_depth, root_rlm_depth_from_env};

// The git-context concern (the quiet git probes and the header capture)
// moved to the child module at the same tree position
// (session::manager::git); the re-export keeps the pub API path stable
// (manager_ext.rs + the git-context integration tests) and the
// constructors bare calls.
mod git;
pub use git::capture_git_context;

// The crash-repair + load concern (the serialized entry wire, the
// bounded damage scan, the torn-tail repair, and the header-validating
// load) moved to the child module at the same tree position
// (session::manager::repair); the re-export keeps the pub API path stable
// (zero external callers - the find_most_recent_session_for_cwd
// precedent) and the bindings keep the bare-path callers in scope (the
// write arms until their own cut + the test child).
mod repair;
pub use repair::load_entries_from_file;
#[cfg(test)]
use repair::repair_jsonl_damage;
use repair::serialize_entry;

/// A persist observer; must not break session writes (panics are contained).
pub type SessionPersistListener = Box<dyn Fn(&Path) + Send + Sync>;

/// Options for creating a new session.
#[derive(Default)]
pub struct NewSessionOptions {
    pub id: Option<String>,
    pub parent_session: Option<String>,
    pub rlm_depth: Option<u64>,
}

/// The stateful session writer/reader.
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
