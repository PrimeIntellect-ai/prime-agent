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
mod child_usage;
#[cfg(test)]
#[path = "session_store/child_usage_tests.rs"]
mod child_usage_tests;
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
pub use info::{find_most_recent_session_for_cwd, read_session_info, SessionInfo};
#[cfg(test)]
use info::{
    message_content_text, raw_string, raw_u64, session_info_cache, SessionInfoEntry,
    SessionInfoGeneration, SessionInfoScanCache, SessionScanState, SESSION_SCAN_MAX_CACHED_STATES,
    SESSION_SCAN_RESUME_TAIL_BYTES,
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

/// One display-transcript page ([`SessionFile::transcript_page`]).
#[derive(Debug, Clone)]
pub struct TranscriptPageRows {
    pub messages: Vec<Value>,
    pub first_entry_id: Option<String>,
    pub last_entry_id: Option<String>,
    /// Rows exist past the page's far side: older ones for an end page, newer
    /// ones before `until` for a start page.
    pub more: bool,
}

/// One display-transcript slice ([`SessionFile::session_messages`]).
#[derive(Debug, Clone)]
pub struct SessionMessages {
    /// Each row's index among the matching rows, entry id, and wire message, oldest first.
    pub rows: Vec<(usize, String, Value)>,
    /// How many rows match on the active branch.
    pub total: usize,
}

impl SessionMessages {
    /// The `get_session_messages` reply `{messages: [{index, id, message}], total}`,
    /// snapshot image payloads left out.
    #[must_use]
    pub fn into_reply(self) -> Value {
        let messages: Vec<Value> = self
            .rows
            .into_iter()
            .map(|(index, id, mut message)| {
                crate::snapshot_stream::elide_snapshot_image_payloads(std::slice::from_mut(
                    &mut message,
                ));
                json!({ "index": index, "id": id, "message": message })
            })
            .collect();
        json!({ "messages": messages, "total": self.total })
    }
}

/// One `get_session_messages` request: the slice bounds and the compiled role globs.
pub struct SessionMessagesQuery {
    start: i64,
    limit: usize,
    roles: globset::GlobSet,
}

impl SessionMessagesQuery {
    /// Compile the role globs.
    ///
    /// # Errors
    ///
    /// Returns an error when a role is not a valid glob.
    pub fn new(start: i64, limit: u64, roles: &[String]) -> Result<Self, globset::Error> {
        let mut globs = globset::GlobSetBuilder::new();
        for role in roles {
            globs.add(globset::Glob::new(role)?);
        }
        Ok(Self {
            start,
            limit: usize::try_from(limit).unwrap_or(usize::MAX),
            roles: globs.build()?,
        })
    }

    /// The slice from `store`; `None` when it reaches a windowed store's unloaded prefix.
    #[must_use]
    pub fn read(
        &self,
        store: &SessionFile,
        running_calls: &std::collections::HashSet<String>,
    ) -> Option<SessionMessages> {
        store.session_messages(
            self.start,
            self.limit,
            |role| self.roles.is_match(role),
            running_calls,
        )
    }

    /// The slice from a session file no worker holds, read-only: no lease and no
    /// session-file write (the windowed open may refresh its window-cache sidecar).
    /// The windowed open serves slices inside the window; one that reaches the
    /// unloaded prefix reads the full file. Nothing runs, so nothing is in flight.
    ///
    /// # Errors
    ///
    /// Returns an error when the file cannot be read.
    pub fn read_file(&self, path: &Path) -> Result<SessionMessages> {
        let idle = std::collections::HashSet::new();
        if let Some(slice) = self.read(&SessionFile::open_windowed(path)?, &idle) {
            return Ok(slice);
        }
        let slice = self.read(&SessionFile::open(path)?, &idle);
        // The whole-file load was transient: release its freed heap.
        pa_types::memory_release::trim_freed_heap();
        slice.ok_or_else(|| anyhow!("Session history is unavailable"))
    }
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
    /// Parallel to `entries`: each entry's parent-chain link (maintained with `by_id`).
    chain: Vec<index::ChainLink>,
    pub(crate) leaf_id: Option<String>,
    pub(crate) window: Option<SessionWindow>,
    pub(crate) trace_upload: Option<std::sync::Arc<pa_core::agent_traces::ContinuousTraceUpload>>,
    pub(crate) lease: Option<std::sync::Arc<crate::lease::SessionLease>>,
    child_usage_recovery: child_usage::ChildUsageRecovery,
    /// Rows the full reader skipped as unparsable (the TS loader's
    /// lenient skip): zero on a healthy file. A reopen that found damage
    /// logs this count (silent skips are how a torn session degraded
    /// unnoticed — the operator's 2026-10-08 report).
    pub(crate) skipped_lines: usize,
    /// Whether this session has already drawn the Anthropic subscription
    /// ban-risk warning (the once-per-session-lifecycle gate, operator
    /// directive 2026-09-29): hydrated from the persisted
    /// [`pa_core::session::ANTHROPIC_WARNING_SHOWN_CUSTOM_TYPE`] row at open
    /// (full or windowed), flipped by
    /// [`SessionFile::mark_anthropic_warning_shown`]. Client-facing reads
    /// serve it through `get_state`
    /// (`SessionSummary::anthropic_warning_shown`).
    pub(crate) anthropic_warning_shown: bool,
    /// Told about each appended row that bills a model call (the engine's
    /// goal budget and telemetry accounting).
    pub(crate) billed_row_sink: BilledRowSinkSlot,
}

#[derive(Clone, Default)]
pub(crate) struct BilledRowSinkSlot(pub(crate) Option<pa_core::session::billed_row::BilledRowSink>);

impl std::fmt::Debug for BilledRowSinkSlot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_tuple("BilledRowSinkSlot")
            .field(&self.0.is_some())
            .finish()
    }
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
