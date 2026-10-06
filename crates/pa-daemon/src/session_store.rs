//! Append-only session store on disk: one JSONL file per session under
//! `<agent-dir>/sessions/<uuid>.jsonl`, first line is the `session` header,
//! entries form a parent-id chain (tree). Layout compatibility with the TS
//! product is load-bearing: TUI reattach, checkpoint/resume, and external
//! tooling read the same files.

use anyhow::{anyhow, Context, Result};
use pa_types::ai::Usage;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
// `BufRead` re-exports to the session-store children through this facade.
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

// The index concern lives in session_store::index; the facade re-imports keep the callers in scope.
mod index;

use index::fold_child_usage_attributions;
pub(crate) use index::new_entry_id;

// The read arm lives in session_store::read; the facade re-exports keep the crate paths stable.
mod read;

pub use read::{
    is_valid_session_file, parse_session_entries, read_session_header, read_session_header_bounded,
    session_file_name, SESSION_LIST_HEADER_READ_MAX_BYTES,
};
pub(crate) use read::{
    parse_session_header_line, read_first_line_bounded, read_first_line_bounded_from,
};

// The write arm lives in session_store::write; the facade re-export keeps the API path stable.
mod write;

pub use write::session_header_line;

// The loaded-session view lives in session_store::view; the facade bindings keep callers in scope.
mod view;

use view::{message_text, normalize_state_status};

// The message-role helper's remaining bare-path callers are the test children; the binding
// rides the test builds only.
#[cfg(test)]
use view::message_role;

// The per-file info scan lives in session_store::info; the facade re-exports keep the paths stable.
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

// The inline unit battery lives in session_store::tests.
#[cfg(test)]
mod tests;

pub use pa_types::session::SessionHeader;

/// The roster scan lives in `session_scan`; re-exported for the listing call sites.
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

/// The windowed sequence's summary scalars (newest timestamp, message count),
/// from [`SessionFile::scan_message_scalars`] without materializing the fold.
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
    /// `model_change` in the discarded prefix): the per-model fold's timeline seed.
    boundary_model: Option<(String, String)>,
    thinking_level: String,
    service_tier: Option<pa_types::ai::ServiceTier>,
    retained_ids: std::collections::HashSet<String>,
    /// The discarded prefix's on-chain spend (attribution-folded): added by the
    /// active stats when no compaction bounds the region.
    pub(crate) older_path_stats: pa_core::session::window::WindowStats,
}
