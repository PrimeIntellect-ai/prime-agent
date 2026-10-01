//! Append-only session store on disk.
//!
//! Port of the session-file layout of `core/session-manager.ts`: one JSONL file
//! per session under `<agent-dir>/sessions/<uuid>.jsonl`, first line is the
//! `session` header, entries form a parent-id chain (tree). Layout compatibility
//! with the TS product is load-bearing: TUI reattach, checkpoint/resume, and
//! external tooling read the same files.

use anyhow::{anyhow, Context, Result};
use pa_types::ai::Usage;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
// `BufRead` re-exports to the session-store children through this facade
// (the split children import it via `super`).
#[allow(unused_imports)]
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};

#[cfg(test)]
#[path = "session_store_info_tests.rs"]
mod info_tests;
#[cfg(test)]
#[path = "session_store_stream_tests.rs"]
mod stream_tests;

#[cfg(test)]
#[path = "session_store_window_tests.rs"]
mod window_tests;

// The index concern (the entry-chain index maintenance: the push-side
// by_id/leaf_id bookkeeping, the child-usage attribution folds, and the
// entry-id mint) moved to the child module at the same tree position
// (session_store::index); the facade re-imports keep the bare-path callers
// in scope (the read/write arms and the stream equivalence tests).
mod index;

use index::fold_child_usage_attributions;
pub(crate) use index::new_entry_id;

// The read arm (the file-IO load surface: the streamed and windowed
// opens, the bounded header-only readers, the file-layout helpers, and the
// in-memory create) moved to the child module at the same tree position
// (session_store::read); the facade re-exports keep the crate paths
// stable (session_scan.rs, rlm_ledger.rs, session_archive.rs,
// agent_engine/model.rs, worker/tests.rs).
mod read;

pub use read::{
    is_valid_session_file, parse_session_entries, read_session_header, read_session_header_bounded,
    session_file_name, SESSION_LIST_HEADER_READ_MAX_BYTES,
};
pub(crate) use read::{
    parse_session_header_line, read_first_line_bounded, read_first_line_bounded_from,
};

// The write arm (the in-memory append family, the atomic full-file
// rewrite, the durable persist paths, and the store lease discipline that
// serializes writers onto the file) moved to the child module at the same
// tree position (session_store::write); the facade re-export keeps the
// header-line API path stable for the rewrite arm and the unit battery.
mod write;

pub use write::session_header_line;

// The loaded-session view (the branch walks, the window/settings reads,
// the compacted message fold and its scalars, and the wire-shape message
// helpers) moved to the child module at the same tree position
// (session_store::view); the facade bindings keep the bare-path callers in
// scope (the read arm's windowed open, the info scan's state fold, and the
// test children).
mod view;

use view::{message_text, normalize_state_status};

// The message-role helper's remaining bare-path callers are the test
// children; the binding rides the test builds only.
#[cfg(test)]
use view::message_role;

// The per-file info scan (the resumable listing fold: the generation
// identity, the LRU-bounded scan-state cache, the resumed line fold, and
// the derived SessionInfo) moved to the child module at the same tree
// position (session_store::info); the facade re-exports keep the crate
// paths stable (rlm_roster.rs, session_catalog.rs, scheduling_catalog.rs,
// saved_session_commands.rs, session_scan.rs, messaging.rs, revival_gate.rs,
// scheduled_jobs.rs, stop_cleanup.rs, supervisor/sessions.rs), and the
// test-scoped binding keeps the scan internals' test callers in scope.
mod info;

// The persisted scan-state sidecar.
mod info_sidecar;

pub(crate) use info::read_session_info_from;
#[cfg(test)]
use info::{
    append_capped_search_text, fold_scan_entry, message_content_text, raw_string, raw_u64,
    session_info_cache, SessionInfoEntry, SessionInfoGeneration, SessionInfoScanCache,
    SessionScanAccumulator, SessionScanState, SESSION_SCAN_MAX_CACHED_STATES,
    SESSION_SCAN_RESUME_TAIL_BYTES,
};
pub use info::{
    find_most_recent_session_for_cwd, read_session_info, SessionInfo,
    SESSION_LIST_SEARCH_TEXT_MAX_CHARS,
};
pub(crate) use info_sidecar::persist_info_sidecar;

// The inline unit battery moved to the child module at the same tree
// position (session_store::tests); its use-super glob keeps resolving
// through the facade's bindings and the wire types.
#[cfg(test)]
mod tests;

pub use pa_types::session::SessionHeader;

/// The roster scan lives in `session_scan` (the bounded-header reshape of
/// the listing loop); re-exported for the listing call sites.
pub use crate::session_scan::list_sessions;

/// One stored entry: message lifecycle, bookkeeping, or a custom record.
/// Fields beyond the entry envelope are preserved as raw JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    #[serde(rename = "type")]
    pub type_: String,
    pub id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub timestamp: String,
    #[serde(flatten)]
    pub fields: Value,
}

/// The windowed message sequence's summary scalars (TS
/// `summaryForActiveSession`): the newest message timestamp and the
/// window's message count. Produced by
/// [`SessionFile::scan_message_scalars`] without materializing the fold.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct MessageWindowScalars {
    /// The timestamp of the last windowed message that carries one (the
    /// fold's reverse `find_map`, preserved in walk order).
    pub last_timestamp_ms: Option<u64>,
    pub message_count: usize,
}

/// A loaded session: header plus the full entry chain, indexed by id.
#[derive(Debug, Clone)]
pub struct SessionFile {
    pub path: PathBuf,
    pub header: SessionHeader,
    pub(crate) entries: Vec<SessionEntry>,
    pub(crate) by_id: HashMap<String, usize>,
    pub(crate) leaf_id: Option<String>,
    pub(crate) window: Option<SessionWindow>,
    pub(crate) lease: Option<std::sync::Arc<crate::lease::SessionLease>>,
    /// Whether this session has already drawn the Anthropic subscription
    /// ban-risk warning (the once-per-session-lifecycle gate, operator
    /// directive 2026-09-29): hydrated from the persisted
    /// [`pa_core::session::ANTHROPIC_WARNING_SHOWN_CUSTOM_TYPE`] row at open
    /// (full or windowed), flipped by
    /// [`SessionFile::mark_anthropic_warning_shown`]. Client-facing reads
    /// serve it through `get_state`
    /// (`SessionSummary::anthropic_warning_shown`).
    pub(crate) anthropic_warning_shown: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct SessionWindow {
    message_count: usize,
    first_message: Option<String>,
    loaded_entries: usize,
    compaction_count: usize,
    has_thinking_level: bool,
    has_service_tier: bool,
    model: Option<(String, String)>,
    /// The model in effect at the retained-window boundary (the newest
    /// `model_change` in the discarded prefix): the per-model usage fold's
    /// timeline seed — `model` above is the leaf's model, not the
    /// boundary's.
    boundary_model: Option<(String, String)>,
    thinking_level: String,
    service_tier: Option<pa_types::ai::ServiceTier>,
    retained_ids: std::collections::HashSet<String>,
    /// The discarded prefix's on-chain spend (attribution-folded — the
    /// window walk's older-path stats): the active stats add it when no
    /// compaction bounds the region (the prefix rows are in the kept
    /// region then — a window is a load optimization, not session state).
    pub(crate) older_path_stats: pa_core::session::window::WindowStats,
}
