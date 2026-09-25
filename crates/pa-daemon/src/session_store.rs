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
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
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

pub const CURRENT_SESSION_VERSION: u32 = 3;
/// Entry types that represent user intent (vs daemon bookkeeping).
const CONTENT_ENTRY_TYPES: &[&str] = &[
    "message",
    "custom_message",
    "custom",
    "model_change",
    "thinking_level_change",
    "service_tier_change",
    "session_info",
    "label",
    "compaction",
    "branch_summary",
];

pub fn new_session_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub(crate) fn new_entry_id(used: &HashMap<String, ()>) -> String {
    for _ in 0..100 {
        let id: String = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        if !used.contains_key(&id) {
            return id;
        }
    }
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

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

impl SessionEntry {
    fn new(
        type_: &str,
        parent_id: Option<String>,
        used: &HashMap<String, ()>,
        fields: Value,
        timestamp: &str,
    ) -> Self {
        SessionEntry {
            type_: type_.to_string(),
            id: new_entry_id(used),
            parent_id,
            timestamp: timestamp.to_string(),
            fields,
        }
    }
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

pub fn session_file_name(session_id: &str) -> String {
    format!("{session_id}.jsonl")
}

pub fn parse_session_entries(content: &str) -> Vec<Value> {
    content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            serde_json::from_str(trimmed).ok()
        })
        .collect()
}

/// `applyChildUsageAttributions` (TS `core/session-manager.ts`): fold each
/// `child_usage_attributed` entry's `aggregateUsage` into its target
/// assistant row. TS performs this fold on every session read, so the
/// daemon's usage walks — which sum assistant rows — must see the same
/// attributed aggregates the live turn did (`get_session_stats`, the
/// /context own/total split, and the top-bar cost all read folded rows).
/// The last attribution per target wins (each aggregate is cumulative),
/// and a target that never loaded stays untouched. In-memory only: the
/// file keeps the raw row plus the attribution entries, the same view the
/// TS loader serves.
fn fold_child_usage_attributions(entries: &mut [SessionEntry]) {
    let mut assistant_rows: HashMap<&str, usize> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if entry.type_ == "message"
            && entry
                .fields
                .get("message")
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str)
                == Some("assistant")
        {
            assistant_rows.insert(entry.id.as_str(), index);
        }
    }
    let mut folds: Vec<(usize, Value)> = Vec::new();
    for entry in entries.iter() {
        if entry.type_ != "child_usage_attributed" {
            continue;
        }
        let Some(row) = entry
            .fields
            .get("targetId")
            .and_then(Value::as_str)
            .and_then(|id| assistant_rows.get(id))
        else {
            continue;
        };
        // A malformed aggregate (null, a scalar) must not overwrite the
        // row's valid usage with nothing — the typed session reader
        // rejects invalid attribution payloads the same way.
        let Some(aggregate) = entry
            .fields
            .get("aggregateUsage")
            .filter(|aggregate| aggregate.is_object())
        else {
            continue;
        };
        folds.push((*row, aggregate.clone()));
    }
    for (row, aggregate) in folds {
        // TS assigns `target.message.usage = cloneUsage(aggregate)` —
        // assignment, not merge: a row that never carried a `usage` field
        // still gets the aggregate inserted (an assistant row without
        // usage exists in foreign or synthetic files), and a row that
        // carried one is overwritten. Insert-through, exactly like TS.
        if let Some(message) = entries[row].fields.get_mut("message") {
            if let Some(object) = message.as_object_mut() {
                object.insert("usage".to_string(), aggregate);
            }
        }
    }
}

/// The bounded first-line read cap for header-only judgments (TS
/// `SESSION_LIST_HEADER_PREFIX_MAX_CHARS`): a session header line is a
/// serialized `SessionHeader` and lands well inside 512 bytes.
pub const SESSION_LIST_HEADER_READ_MAX_BYTES: usize = 512;

/// Parse one session file line as the `session` header (the TS
/// `readSessionHeader` body): a JSON object tagged `session` that
/// deserializes into the typed header.
pub(crate) fn parse_session_header_line(line: &str) -> Option<SessionHeader> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    serde_json::from_value(value).ok()
}

/// Read the file's first line when it ends within `max_bytes` bytes.
///
/// `None` when no line ends within the bound (an over-long first line, an
/// unreadable file, an empty file): the caller judges such a file with a full
/// read, never on truncated bytes. A final line without a trailing newline is
/// still a line (`str::lines` reads one too).
pub(crate) fn read_first_line_bounded(path: &Path, max_bytes: usize) -> Option<Vec<u8>> {
    let mut file = fs::File::open(path).ok()?;
    // One byte over the cap separates "a line that fits the cap" (judgeable)
    // from "an over-long line" (not): a newline at index `max_bytes` still
    // bounds a complete `max_bytes`-byte line.
    let mut buf = vec![0u8; max_bytes + 1];
    let mut filled = 0;
    while filled < buf.len() {
        let read = file.read(&mut buf[filled..]).ok()?;
        if read == 0 {
            return (filled > 0).then(|| strip_line_return(&buf[..filled]));
        }
        if let Some(at) = buf[filled..filled + read]
            .iter()
            .position(|&byte| byte == b'\n')
        {
            if filled + at > max_bytes {
                return None;
            }
            return Some(strip_line_return(&buf[..filled + at]));
        }
        filled += read;
    }
    None
}

/// Drop one `\r\n` line return off the line's own bytes, like `str::lines`.
fn strip_line_return(line: &[u8]) -> Vec<u8> {
    let mut line = line.to_vec();
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    line
}

/// The session file's header, read from the first line bounded to
/// [`SESSION_LIST_HEADER_READ_MAX_BYTES`] (the TS `isValidSessionFile`
/// precedent: judge a file by its header line, not a full-file read).
/// `None` also covers an over-long first line: the bounded read refuses to
/// judge a truncated one.
pub fn read_session_header_bounded(path: &Path) -> Option<SessionHeader> {
    let line = read_first_line_bounded(path, SESSION_LIST_HEADER_READ_MAX_BYTES)?;
    let text = std::str::from_utf8(&line).ok()?;
    parse_session_header_line(text)
}

/// Read the first line of a session file and parse it as a header.
pub fn read_session_header(path: &Path) -> Option<SessionHeader> {
    let file = fs::File::open(path).ok()?;
    let mut first = String::new();
    std::io::BufReader::new(file).read_line(&mut first).ok()?;
    parse_session_header_line(&first)
}

/// A session file is valid when its first line is a `session` header with an
/// id, judged on the bounded header read.
pub fn is_valid_session_file(path: &Path) -> bool {
    read_session_header_bounded(path).is_some_and(|header| !header.id.is_empty())
}

impl SessionFile {
    /// Load an existing session file. Errors when the header is missing/invalid.
    ///
    /// # Errors
    ///
    /// Returns an error when the file cannot be read, is empty, or its
    /// header is missing or invalid; malformed entry lines are skipped,
    /// matching the TS loader.
    pub fn open(path: &Path) -> Result<Self> {
        // Streamed line-by-line load: one line is resident at a time, so a
        // grown session never holds the raw file bytes alongside the parsed
        // entries (the whole-body String read was a transient copy the
        // allocator kept resident long after `open` returned).
        let file = fs::File::open(path)
            .with_context(|| format!("read session file {}", path.display()))?;
        let mut lines = std::io::BufReader::new(file).lines();
        let read_context = || format!("read session file {}", path.display());
        let mut first = None;
        for line in lines.by_ref() {
            let line = line.with_context(read_context)?;
            if !line.trim().is_empty() {
                first = Some(line);
                break;
            }
        }
        let first = first.ok_or_else(|| anyhow!("empty session file {}", path.display()))?;
        let header_value: Value = serde_json::from_str(first.trim())
            .with_context(|| format!("invalid session header in {}", path.display()))?;
        if header_value.get("type").and_then(Value::as_str) != Some("session") {
            return Err(anyhow!("missing session header in {}", path.display()));
        }
        let header: SessionHeader = serde_json::from_value(header_value)
            .with_context(|| format!("invalid session header in {}", path.display()))?;
        let mut file = SessionFile {
            path: path.to_path_buf(),
            header,
            entries: Vec::new(),
            by_id: HashMap::new(),
            leaf_id: None,
            window: None,
            lease: None,
        };
        for line in lines {
            let line = line.with_context(read_context)?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Malformed lines are skipped, matching the TS loader.
            if let Ok(entry) = serde_json::from_str::<SessionEntry>(trimmed) {
                file.push_index(entry);
            }
        }
        fold_child_usage_attributions(&mut file.entries);
        Ok(file)
    }

    /// Load the verified compacted context without decoding old message bodies.
    ///
    /// # Errors
    ///
    /// Returns an error when the windowed load fails or the window holds
    /// no session header; a malformed retained row falls back to the
    /// full [`SessionFile::open`] load, so its errors surface here too.
    pub fn open_windowed(path: &Path) -> Result<Self> {
        let Some(mut window) = pa_core::session::window::WindowedSessionStore::open(path)? else {
            return Self::open(path);
        };
        let header = window
            .entries()
            .iter()
            .find_map(|entry| match entry {
                pa_types::session::FileEntry::Header { header } => Some(header.clone()),
                _ => None,
            })
            .ok_or_else(|| anyhow!("window has no session header"))?;
        let mut file = Self {
            path: path.to_owned(),
            header,
            entries: Vec::new(),
            by_id: HashMap::new(),
            leaf_id: None,
            window: None,
            lease: None,
        };
        // The raw rows are consumed in place: each line String drops as
        // soon as its parsed entry joins the store, instead of keeping the
        // raw copy resident for the whole build.
        let raw_count = window.raw_entries().len();
        for line in window
            .take_metadata_entries()
            .into_iter()
            .chain(window.take_raw_entries())
        {
            let Ok(entry) = serde_json::from_str(&line) else {
                return Self::open(path);
            };
            file.push_index(entry);
        }
        // The window keeps the retained-target attributions as metadata and
        // parses them BEFORE the raw retained rows, so the fold runs once
        // every row is in (the push_index live-fold cannot see a target
        // that has not joined the index yet).
        fold_child_usage_attributions(&mut file.entries);
        file.leaf_id = Some(window.leaf_id().to_owned());
        let context = window.context();
        file.window = Some(SessionWindow {
            message_count: window.message_count(),
            first_message: window
                .first_user_message()
                .map(message_text)
                .filter(|text| !text.is_empty()),
            loaded_entries: file.entries.len(),
            compaction_count: window.compaction_count(),
            has_thinking_level: window.has_thinking_level(),
            has_service_tier: window.has_service_tier(),
            model: context.model,
            boundary_model: window.boundary_model().cloned(),
            thinking_level: context.thinking_level,
            service_tier: context.service_tier,
            // The retained rows joined the store verbatim above (any
            // unparsable row fell back to the full reader), so their ids are
            // exactly the trailing `raw_count` store ids — no third parse
            // pass over the retained body.
            retained_ids: file.entries[file.entries.len() - raw_count..]
                .iter()
                .map(|entry| entry.id.clone())
                .collect(),
            older_path_stats: window.older_path_stats().clone(),
        });
        Ok(file)
    }

    #[cfg(test)]
    fn ensure_full_history(&mut self) -> Result<()> {
        if self.window.is_some() {
            let full = Self::open(&self.path)?;
            self.install_full_history(full);
        }
        Ok(())
    }

    /// Merge appends made while the disk snapshot loaded without holding the store lock.
    pub(crate) fn install_full_history(&mut self, mut full: Self) {
        let Some(window) = &self.window else {
            return;
        };
        for entry in &self.entries[window.loaded_entries..] {
            if !full.by_id.contains_key(&entry.id) {
                full.push_index(entry.clone());
            }
        }
        full.leaf_id.clone_from(&self.leaf_id);
        full.lease.clone_from(&self.lease);
        *self = full;
    }

    /// Persist only the newly appended creation records on a resumed file.
    pub(crate) fn persist_appended(&self, start: usize) -> Result<()> {
        let mut bytes = Vec::new();
        for entry in &self.entries[start..] {
            write_line(&mut bytes, entry)?;
        }
        match &self.lease {
            Some(lease) => lease.append(&self.path, &bytes)?,
            None => pa_core::session::window::append_cached(
                &self.path,
                &bytes,
                pa_core::session::window::AppendOwnership::Unleased,
            )?,
        }
        Ok(())
    }

    /// Create a new in-memory session; persisted with the first flush.
    pub fn create(cwd: &str, parent_session: Option<&str>, rlm_depth: u32) -> Self {
        let header = SessionHeader {
            version: Some(CURRENT_SESSION_VERSION),
            id: new_session_id(),
            timestamp: crate::util::now_iso(),
            cwd: cwd.to_string(),
            parent_session: parent_session.map(str::to_string),
            rlm_depth: Some(rlm_depth as u64),
            git: None,
            rest: Default::default(),
        };
        SessionFile {
            path: PathBuf::new(),
            header,
            entries: Vec::new(),
            by_id: HashMap::new(),
            leaf_id: None,
            window: None,
            lease: None,
        }
    }

    fn push_index(&mut self, entry: SessionEntry) {
        self.push_index_inner(entry, true);
    }

    /// The load and in-memory build paths fold live attributions as they
    /// push (the end-of-load fold re-applies idempotently); the
    /// rewrite-persist path defers the fold until the rewrite succeeds —
    /// a failed rewrite rolls the index back, and the target row must not
    /// keep a fold whose durable attribution row never landed (TS reverts
    /// the live row in the same failure path).
    fn push_index_inner(&mut self, entry: SessionEntry, fold_live: bool) {
        // The live-append seam of the attribution fold (TS
        // `SessionManager.append_child_usage_attribution` folds after the
        // durable append): an attribution entry joining the index folds its
        // aggregate into the target assistant row, or the in-memory view
        // keeps stale usage until a reopen. The end-of-load fold re-applies
        // idempotently (the fold SETS the aggregate) and also catches forward
        // references in foreign files.
        if fold_live && entry.type_ == "child_usage_attributed" {
            self.fold_live_attribution(&entry);
        }
        self.by_id.insert(entry.id.clone(), self.entries.len());
        self.leaf_id = Some(entry.id.clone());
        self.entries.push(entry);
    }

    /// Fold one already-indexed attribution entry's aggregate (the
    /// rewrite-persist path calls this after the durable write succeeds).
    fn fold_attribution_id(&mut self, id: &str) {
        let Some(&row) = self.by_id.get(id) else {
            return;
        };
        if self.entries[row].type_ != "child_usage_attributed" {
            return;
        }
        let entry = self.entries[row].clone();
        self.fold_live_attribution(&entry);
    }

    /// Fold one attribution entry's aggregate into its already-indexed
    /// target assistant row, when the row has joined the index.
    fn fold_live_attribution(&mut self, entry: &SessionEntry) {
        let Some(row) = entry
            .fields
            .get("targetId")
            .and_then(Value::as_str)
            .and_then(|id| self.by_id.get(id).copied())
        else {
            return;
        };
        // A malformed aggregate (null, a scalar) must not overwrite the
        // row's valid usage with nothing — the typed session reader
        // rejects invalid attribution payloads the same way.
        let Some(aggregate) = entry
            .fields
            .get("aggregateUsage")
            .filter(|aggregate| aggregate.is_object())
        else {
            return;
        };
        // TS assigns `target.message.usage = cloneUsage(aggregate)`:
        // insert the aggregate even when the row never carried a `usage`
        // field (the same insert-through as the end-of-load fold).
        if let Some(message) = self.entries[row].fields.get_mut("message") {
            if let Some(object) = message.as_object_mut() {
                object.insert("usage".to_string(), aggregate.clone());
            }
        }
    }

    pub fn entries(&self) -> &[SessionEntry] {
        &self.entries
    }

    pub fn entry(&self, id: &str) -> Option<&SessionEntry> {
        self.by_id.get(id).map(|&index| &self.entries[index])
    }

    pub fn leaf_id(&self) -> Option<&str> {
        self.leaf_id.as_deref()
    }

    pub fn session_id(&self) -> &str {
        &self.header.id
    }

    /// The header's RLM depth (TS `sessionManager.getHeader()?.rlmDepth`):
    /// a resumed session inherits its persisted depth when the create
    /// payload does not carry one (TS `config.rlmDepth ?? header.rlmDepth`).
    pub fn rlm_depth(&self) -> Option<u32> {
        self.header
            .rlm_depth
            .and_then(|depth| u32::try_from(depth).ok())
    }

    /// Walk the leaf-to-root entry path (the active branch). A corrupt
    /// file can hold a parent cycle; the walk must terminate anyway (the
    /// same guard `build_session_context` has).
    pub fn branch(&self) -> Vec<&SessionEntry> {
        let mut path = Vec::new();
        let mut visited = std::collections::HashSet::new();
        let mut current = self.leaf_id.as_deref().and_then(|id| self.entry(id));
        while let Some(entry) = current {
            if !visited.insert(entry.id.as_str()) {
                break;
            }
            if let Some(window) = &self.window {
                let index = self.by_id[&entry.id];
                if index < window.loaded_entries && !window.retained_ids.contains(&entry.id) {
                    break;
                }
            }
            path.push(entry);
            current = entry.parent_id.as_deref().and_then(|id| self.entry(id));
        }
        path.reverse();
        path
    }

    /// The leaf-to-root walk with parent gaps bridged: a session file can
    /// carry a parent id that was minted but never persisted (one lost
    /// append). At a gap the walk continues from the gap entry's file
    /// predecessor — the last entry that reached the file, and the gap
    /// entry's true parent whenever the writer persisted anything after a
    /// branch move (a `branch_summary` marker chains from the moved-to
    /// entry, so the abandoned fork stays out). A gap directly after an
    /// unmarked `branch_to` is indistinguishable from a plain chain gap —
    /// the minted parent id is simply absent from the file — so the walk
    /// keeps the persisted chain rather than dropping spend the session
    /// really logged. The strict [`Self::branch`] stays the model-facing
    /// truth (a gap really truncates the rebuilt context); this walk
    /// serves the cumulative usage accounting (`get_session_stats`, the
    /// /context totals). Forks resolve by parent id; only a missing
    /// parent bridges.
    pub fn branch_bridged(&self) -> Vec<&SessionEntry> {
        self.branch_bridged_positions()
            .into_iter()
            .map(|position| &self.entries[position])
            .collect()
    }

    /// [`Self::branch_bridged`] as file positions — the accounting walks
    /// (the compaction-kept region of `get_session_stats`) restrict the
    /// chain by file position.
    pub(crate) fn branch_bridged_positions(&self) -> Vec<usize> {
        let mut positions: Vec<usize> = Vec::new();
        let mut seen: std::collections::HashSet<usize> = std::collections::HashSet::new();
        let mut current = self
            .leaf_id
            .as_deref()
            .and_then(|id| self.by_id.get(id).copied());
        while let Some(position) = current {
            if !seen.insert(position) {
                break;
            }
            positions.push(position);
            let entry = &self.entries[position];
            current = match entry
                .parent_id
                .as_deref()
                .and_then(|id| self.by_id.get(id))
                .copied()
            {
                Some(parent) => Some(parent),
                // A minted-but-never-persisted parent: bridge to the file
                // predecessor. The first entry has none, so the walk ends
                // there, exactly like a plain root.
                None if entry.parent_id.is_some() => (position > 0).then(|| position - 1),
                None => None,
            };
        }
        positions.reverse();
        positions
    }

    /// The model in effect at the retained-window boundary (the newest
    /// `model_change` in the discarded prefix; `None` on a full-history
    /// load): the per-model cost fold seeds its timeline with it, so
    /// retained rows before the branch's first in-window `model_change`
    /// bill on the boundary's model instead of the leaf's.
    pub(crate) fn window_boundary_model(&self) -> Option<(String, String)> {
        self.window.as_ref()?.boundary_model.clone()
    }

    pub(crate) fn restored_settings(&self) -> pa_core::session::SessionContext {
        let entries = self.branch_file_entries();
        let mut context = pa_core::session::build_session_context(&entries, self.leaf_id());
        if let Some(window) = &self.window {
            context.model.clone_from(&window.model);
            context.thinking_level.clone_from(&window.thinking_level);
            context.service_tier = window.service_tier;
            for entry in &self.entries[window.loaded_entries..] {
                match entry.type_.as_str() {
                    "model_change" => {
                        if let (Some(provider), Some(model)) = (
                            entry.fields.get("provider").and_then(Value::as_str),
                            entry.fields.get("modelId").and_then(Value::as_str),
                        ) {
                            context.model = Some((provider.to_owned(), model.to_owned()));
                        }
                    }
                    "message" => {
                        if let Some(message) = entry.fields.get("message").filter(|message| {
                            message.get("role").and_then(Value::as_str) == Some("assistant")
                        }) {
                            if let (Some(provider), Some(model)) = (
                                message.get("provider").and_then(Value::as_str),
                                message.get("model").and_then(Value::as_str),
                            ) {
                                context.model = Some((provider.to_owned(), model.to_owned()));
                            }
                        }
                    }
                    "thinking_level_change" => {
                        if let Some(level) =
                            entry.fields.get("thinkingLevel").and_then(Value::as_str)
                        {
                            level.clone_into(&mut context.thinking_level);
                        }
                    }
                    "service_tier_change" => {
                        context.service_tier = entry
                            .fields
                            .get("serviceTier")
                            .and_then(|tier| serde_json::from_value(tier.clone()).ok());
                    }
                    _ => {}
                }
            }
        }
        context
    }

    pub(crate) fn has_thinking_level(&self) -> bool {
        self.window
            .as_ref()
            .is_some_and(|window| window.has_thinking_level)
            || self
                .branch()
                .iter()
                .any(|entry| entry.type_ == "thinking_level_change")
    }

    pub(crate) fn has_service_tier(&self) -> bool {
        self.window
            .as_ref()
            .is_some_and(|window| window.has_service_tier)
            || self
                .branch()
                .iter()
                .any(|entry| entry.type_ == "service_tier_change")
    }

    pub(crate) fn compaction_count(&self) -> usize {
        match &self.window {
            Some(window) => {
                window.compaction_count
                    + self.entries[window.loaded_entries..]
                        .iter()
                        .filter(|entry| entry.type_ == "compaction")
                        .count()
            }
            None => self
                .entries
                .iter()
                .filter(|entry| entry.type_ == "compaction")
                .count(),
        }
    }

    /// Session name from the latest `session_info` entry.
    pub fn session_name(&self) -> Option<&str> {
        self.entries()
            .iter()
            .rev()
            .find(|entry| entry.type_ == "session_info")
            .and_then(|entry| entry.fields.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
    }

    /// Lifecycle state from the latest `session_state` entry.
    pub fn state(&self) -> Option<String> {
        self.entries()
            .iter()
            .rev()
            .find(|entry| entry.type_ == "session_state")
            .and_then(|entry| entry.fields.get("state"))
            .and_then(|state| state.get("status"))
            .and_then(Value::as_str)
            .map(normalize_state_status)
    }

    /// The branch's conversation, compacted view first (port of the TS
    /// `buildSessionContext` fold): when the branch holds a compaction, the
    /// read starts at a `compactionSummary` message, followed by the
    /// retained messages from `firstKeptEntryId`, then everything appended
    /// after the compaction. Without a compaction this is the plain
    /// message list.
    pub fn messages(&self) -> Vec<Value> {
        // The transcript form of one entry: `message` rows contribute their
        // persisted message; custom rows rejoin as their wire message form
        // (`role: "custom"`), the shape TS sessions keep in
        // `agent.state.messages`.
        let entry_message = |entry: &SessionEntry| -> Option<Value> {
            match entry.type_.as_str() {
                "message" => entry.fields.get("message").cloned(),
                "custom_message" => {
                    let mut message = entry.fields.clone();
                    if let Some(object) = message.as_object_mut() {
                        object.insert("role".to_string(), Value::String("custom".to_string()));
                        object.insert(
                            "timestamp".to_string(),
                            Value::String(entry.timestamp.clone()),
                        );
                    }
                    Some(message)
                }
                _ => None,
            }
        };
        let branch = self.branch();
        let Some(compaction_position) =
            branch.iter().rposition(|entry| entry.type_ == "compaction")
        else {
            return branch
                .iter()
                .filter_map(|entry| entry_message(entry))
                .collect();
        };
        let compaction = branch[compaction_position];
        let first_kept_entry_id = compaction
            .fields
            .get("firstKeptEntryId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut retained: Vec<Value> = Vec::new();
        let mut keeping = false;
        for entry in &branch[..compaction_position] {
            if entry_message(entry).is_none() {
                continue;
            }
            if !keeping && entry.id == first_kept_entry_id {
                keeping = true;
            }
            if keeping {
                if let Some(message) = entry_message(entry) {
                    retained.push(message);
                }
            }
        }
        let mut messages = vec![compaction_summary_message(compaction, retained.len())];
        messages.extend(retained);
        messages.extend(
            branch[compaction_position + 1..]
                .iter()
                .filter_map(|entry| entry_message(entry)),
        );
        messages
    }

    /// The durable entry id the compaction cut keeps: the same
    /// `find_cut_point` walk the engine ran over its in-memory entries,
    /// re-run over this store's branch. The engine's own
    /// `firstKeptEntryId` references its in-memory entry ids, which never
    /// exist in the session file (the store mints fresh ids on persist);
    /// verbatim it retains nothing on the `messages` read. TS has a single
    /// store so its ids match by construction — the durable re-cut here
    /// pins the boundary the file read recognizes (TS: one store, ids
    /// match by construction).
    pub fn durable_first_kept_entry_id(&self, keep_recent_tokens: u64) -> Option<String> {
        let branch = self.branch();
        let entries: Vec<pa_types::session::FileEntry> = branch
            .iter()
            .filter_map(|entry| serde_json::to_value(entry).ok())
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect();
        // The header is not a compact candidate (TS `prepareCompaction`).
        let start = usize::from(matches!(
            entries.first(),
            Some(pa_types::session::FileEntry::Header { .. })
        ));
        let cut = pa_core::session_engine::compaction::find_cut_point(
            &entries,
            start,
            entries.len(),
            keep_recent_tokens,
        );
        entries
            .get(cut.first_kept_entry_index)
            .and_then(|entry| entry.id())
            .filter(|id| !id.is_empty())
            .map(str::to_string)
    }

    pub fn message_count(&self) -> usize {
        match &self.window {
            Some(window) => {
                window.message_count
                    + self.entries[window.loaded_entries..]
                        .iter()
                        .filter(|entry| entry.type_ == "message")
                        .count()
            }
            None => self
                .entries
                .iter()
                .filter(|entry| entry.type_ == "message")
                .count(),
        }
    }

    pub fn first_message(&self) -> Option<String> {
        if let Some(window) = &self.window {
            return window.first_message.clone();
        }
        self.entries
            .iter()
            .filter(|e| e.type_ == "message")
            .filter_map(|e| e.fields.get("message"))
            .find(|m| message_role(m) == Some("user"))
            .map(message_text)
            .filter(|t| !t.is_empty())
    }

    /// True when the session holds user-meaningful persisted content (port of
    /// `hasUserContent`): the default model/thinking/service-tier creation
    /// prefix is skipped.
    pub fn has_user_content(&self) -> bool {
        let content: Vec<&SessionEntry> = self
            .entries
            .iter()
            .filter(|entry| CONTENT_ENTRY_TYPES.contains(&entry.type_.as_str()))
            .collect();
        let mut start = 0usize;
        if content.get(start).map(|e| e.type_.as_str()) == Some("model_change") {
            start += 1;
        }
        if content.get(start).map(|e| e.type_.as_str()) == Some("thinking_level_change") {
            start += 1;
        }
        if content.get(start).map(|e| e.type_.as_str()) == Some("service_tier_change") {
            start += 1;
        }
        content.len() > start
    }

    fn index_map(&self) -> HashMap<String, ()> {
        self.entries.iter().map(|e| (e.id.clone(), ())).collect()
    }

    pub fn append_entry(&mut self, type_: &str, fields: Value) -> String {
        let parent_id = self.leaf_id.clone();
        let mut entry = SessionEntry::new(
            type_,
            parent_id,
            &self.index_map(),
            fields,
            &crate::util::now_iso(),
        );
        if self.window.is_some() {
            entry.id = uuid::Uuid::new_v4().to_string();
        }
        let id = entry.id.clone();
        self.push_index(entry);
        id
    }

    pub fn append_message(&mut self, message: Value) -> String {
        self.append_entry("message", serde_json::json!({ "message": message }))
    }

    pub fn append_session_state(&mut self, status: &str) -> String {
        self.append_entry(
            "session_state",
            serde_json::json!({ "state": { "status": status } }),
        )
    }

    pub fn append_session_info(&mut self, name: &str) -> String {
        self.append_entry("session_info", serde_json::json!({ "name": name.trim() }))
    }

    pub fn append_model_change(&mut self, provider: &str, model_id: &str) -> String {
        self.append_entry(
            "model_change",
            serde_json::json!({ "provider": provider, "modelId": model_id }),
        )
    }

    pub fn append_thinking_level_change(&mut self, level: &str) -> String {
        self.append_entry(
            "thinking_level_change",
            serde_json::json!({ "thinkingLevel": level }),
        )
    }

    /// Write the full file atomically (header + every entry), like `_rewriteFile`.
    ///
    /// # Errors
    ///
    /// Returns an error when the store only holds a window (the full
    /// history is required), or when the session dir, the temp file, the
    /// write, flush, sync, or the final rename fails; an empty path
    /// answers `Ok(())` without writing.
    pub fn rewrite(&self) -> Result<()> {
        anyhow::ensure!(
            self.window.is_none(),
            "full history required before rewriting session"
        );
        let path = self.path.as_path();
        let Some(path) = (if path.as_os_str().is_empty() {
            None
        } else {
            Some(path)
        }) else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create session dir {}", parent.display()))?;
        }
        let temp = path.with_extension(format!("jsonl.tmp-{}", std::process::id()));
        {
            let file =
                fs::File::create(&temp).with_context(|| format!("create {}", temp.display()))?;
            let mut writer = std::io::BufWriter::new(file);
            write_line(&mut writer, &session_header_line(&self.header))?;
            for entry in &self.entries {
                write_line(&mut writer, entry)?;
            }
            writer.flush()?;
            writer.get_ref().sync_all()?;
        }
        pa_core::platform::rename_onto(&temp, path)
            .with_context(|| format!("persist {}", path.display()))?;
        Ok(())
    }

    /// Append one entry line to the file, rewriting first when the file is
    /// missing. The entry joins the in-memory index only after its line
    /// reaches the file: a failed write (or rewrite) leaves the store
    /// exactly as it was, so the next append parents to the last entry
    /// the file holds. `sync_data` past the flush only enforces
    /// durability — when it fails the entry stays indexed (a reload of
    /// the file would load it as the leaf) and the error still surfaces.
    ///
    /// # Errors
    ///
    /// Returns an error when the entry cannot be written: the append (or
    /// the rewriting bootstrap on a missing file) fails, or the
    /// post-write durability sync fails — the entry stays indexed and
    /// the error still surfaces.
    pub fn persist_entry(&mut self, entry_type: &str, fields: Value) -> Result<String> {
        self.persist_entry_at(entry_type, fields, &crate::util::now_iso())
    }

    /// Append one entry stamped with the given time. The interrupted-
    /// compaction replay re-stamps the supervisor's declaration, so the
    /// entry's timestamp is the row's stable identity: a replacement that
    /// already persisted the disclosure but died before the supervisor
    /// consumed the record replays the same declaration, and the create
    /// handler recognizes its own row instead of duplicating it.
    ///
    /// # Errors
    ///
    /// Returns an error when the entry cannot be written: the
    /// window-backed file is missing, the entry cannot be serialized, or
    /// the append, the rewriting bootstrap, or the post-write durability
    /// sync fails.
    pub fn persist_entry_at(
        &mut self,
        entry_type: &str,
        fields: Value,
        timestamp: &str,
    ) -> Result<String> {
        anyhow::ensure!(
            self.window.is_none() || self.path.exists(),
            "window-backed session file is missing"
        );
        let mut entry = SessionEntry::new(
            entry_type,
            self.leaf_id.clone(),
            &self.index_map(),
            fields,
            timestamp,
        );
        // A windowed index lacks the pre-window IDs, so the short minted ID
        // could collide with unloaded history; a UUID cannot (same rule as
        // `append_entry`).
        if self.window.is_some() {
            entry.id = uuid::Uuid::new_v4().to_string();
        }
        let id = entry.id.clone();
        if !self.path.as_os_str().is_empty() && self.path.exists() {
            let mut bytes = Vec::new();
            write_line(&mut bytes, &entry)?;
            match &self.lease {
                Some(lease) => lease.append(&self.path, &bytes)?,
                None => pa_core::session::window::append_cached(
                    &self.path,
                    &bytes,
                    pa_core::session::window::AppendOwnership::Unleased,
                )
                .with_context(|| format!("append to {}", self.path.display()))?,
            }
            // The line is in the file now: index it so the in-memory leaf
            // matches what a reload sees (the write left no index state).
            self.push_index(entry);
        } else {
            // The rewrite path serializes the whole index, so the entry must
            // be indexed first; a failed rewrite rolls the index back. The
            // live attribution fold is DEFERRED until the rewrite succeeds —
            // the rolled-back index must leave the target row untouched.
            let previous_leaf = self.leaf_id.clone();
            self.push_index_inner(entry, false);
            if let Err(error) = self.rewrite() {
                self.by_id.remove(&id);
                self.entries.pop();
                self.leaf_id = previous_leaf;
                return Err(error);
            }
            self.fold_attribution_id(&id);
        }
        Ok(id)
    }

    /// Point the session at a concrete file path (after `create`), preserving entries.
    pub fn set_path(&mut self, path: PathBuf) {
        if self.path != path {
            self.lease = None;
        }
        self.path = path;
    }
}

/// The stored first line: the typed header plus the `session` type tag.
///
/// The tag leads the line (TS `SessionHeader` declares `type` first, so the
/// TS session file's first line starts with `{"type":"session",...}`); the
/// JSON map preserves insertion order (the workspace's `serde_json` runs
/// with `preserve_order`), so the tag is rebuilt into the leading slot
/// instead of appended.
pub fn session_header_line(header: &SessionHeader) -> Value {
    let value = serde_json::to_value(header).unwrap_or(Value::Null);
    let Some(object) = value.as_object() else {
        return json!({ "type": "session" });
    };
    let mut ordered = serde_json::Map::new();
    ordered.insert("type".to_string(), Value::String("session".to_string()));
    ordered.extend(
        object
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    Value::Object(ordered)
}

fn write_line<T: Serialize>(writer: &mut impl Write, value: &T) -> Result<()> {
    let mut line = serde_json::to_string(value)?;
    line.push('\n');
    writer.write_all(line.as_bytes())?;
    Ok(())
}

fn message_role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

/// The `compactionSummary` message a compaction fold starts with (TS
/// `createCompactionSummaryMessage`).
fn compaction_summary_message(entry: &SessionEntry, retained_count: usize) -> Value {
    let timestamp = crate::util::iso_to_unix_ms(&entry.timestamp).unwrap_or(0);
    // TS `createCompactionSummaryMessage` key order: role, summary,
    // tokensBefore, retainedMessageCount, customInstructions?,
    // harnessDigest?, timestamp. The JSON map preserves insertion order,
    // so the optional keys insert before `timestamp`.
    let mut message = json!({
        "role": "compactionSummary",
        "summary": entry.fields.get("summary").cloned().unwrap_or_default(),
        "tokensBefore": entry.fields.get("tokensBefore").cloned().unwrap_or(json!(0)),
        "retainedMessageCount": retained_count as u64,
    });
    if let Some(custom_instructions) = entry.fields.get("customInstructions") {
        message["customInstructions"] = custom_instructions.clone();
    }
    if let Some(harness_digest) = entry.fields.get("harnessDigest") {
        message["harnessDigest"] = harness_digest.clone();
    }
    message["timestamp"] = json!(timestamp);
    message
}

fn message_text(message: &Value) -> String {
    crate::types::message_text(message)
}

fn normalize_state_status(status: &str) -> String {
    match status {
        "hidden" | "sleep" => "archived".to_string(),
        other => other.to_string(),
    }
}

/// Port of `readSessionInfo`'s fold (single pass, no resume cache): the durable
/// metadata the daemon list surfaces for one session file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    pub path: PathBuf,
    pub id: String,
    pub cwd: String,
    pub name: Option<String>,
    pub state: Option<String>,
    pub model: Option<(String, String)>,
    /// The last persisted `thinking_level_change` level (the durable row
    /// `set_thinking_level` writes); agents-view summaries surface it for
    /// sessions without a live worker (top-level and subagent alike).
    pub thinking_level: Option<String>,
    pub parent_session_path: Option<String>,
    pub rlm_depth: u32,
    pub created: String,
    pub modified: String,
    pub message_count: usize,
    pub first_message: String,
    /// Every user/assistant message text, concatenated, capped at
    /// `SESSION_LIST_SEARCH_TEXT_MAX_CHARS` (TS `allMessagesText`: the
    /// agents-view full-transcript search corpus).
    pub all_messages_text: String,
    /// TS `SessionInfo.usage`: the own-usage summary — assistant
    /// aggregates plus summarization calls, minus every attributed child
    /// block (`session_usage::UsageScan`; the child's own row carries the
    /// child spend). `None` when the session recorded no billable work.
    pub usage: Option<crate::session_usage::SessionUsageSummary>,
    /// TS `SessionInfo.deletedDescendantUsage`: the recursive spend of
    /// ledger-tombstoned descendants, attached by the catalog's listing
    /// arm from the spawn ledger's deleted-descendant bucket (one read
    /// per list, keyed by canonical parent path — TS
    /// `withPassiveRlmDescendantInfos`). The agents-view recursive cost
    /// rollup bills it to this row's own cost. Never set by the file
    /// scan: it is ledger-derived, not transcript-derived.
    pub deleted_descendant_usage: Option<crate::session_usage::SessionUsageSummary>,
}

/// TS `SESSION_LIST_SEARCH_TEXT_MAX_CHARS`: the transcript search-text cap.
pub const SESSION_LIST_SEARCH_TEXT_MAX_CHARS: usize = 64 * 1024;

/// TS `appendCappedSearchText`: space-join the texts, cut the final
/// addition so the corpus never grows past the cap.
fn append_capped_search_text(current: &mut String, text: &str) {
    if text.is_empty() {
        return;
    }
    let used = current.chars().count();
    if used >= SESSION_LIST_SEARCH_TEXT_MAX_CHARS {
        return;
    }
    if used > 0 {
        current.push(' ');
    }
    let remaining = SESSION_LIST_SEARCH_TEXT_MAX_CHARS - current.chars().count();
    current.extend(text.chars().take(remaining));
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SessionInfoGeneration {
    len: u64,
    dev: u64,
    ino: u64,
    mtime: i64,
    mtime_ns: i64,
    ctime: i64,
    ctime_ns: i64,
}

impl SessionInfoGeneration {
    #[cfg(unix)]
    fn from_metadata(meta: &fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            len: meta.len(),
            dev: meta.dev(),
            ino: meta.ino(),
            mtime: meta.mtime(),
            mtime_ns: meta.mtime_nsec(),
            ctime: meta.ctime(),
            ctime_ns: meta.ctime_nsec(),
        }
    }

    #[cfg(not(unix))]
    fn from_metadata(meta: &fs::Metadata) -> Self {
        Self {
            len: meta.len(),
            dev: 0,
            ino: 0,
            mtime: 0,
            mtime_ns: 0,
            ctime: 0,
            ctime_ns: 0,
        }
    }
}

/// TS `SESSION_SCAN_MAX_RETAINED_USAGE_ENTRIES`: the cross-file memory
/// budget on retained per-assistant-message usage records. Whole-state
/// LRU eviction can force a full catalog rescan every refresh, so keep
/// large families (~2k sessions, 150k usage entries) and growth headroom
/// resident (session-manager.ts).
const SESSION_SCAN_MAX_RETAINED_USAGE_ENTRIES: usize = 400_000;

/// The cached-state count ceiling: files with no usage records never trip
/// the usage budget, so the state count needs its own cap. The cap must
/// sit well ABOVE a catalog refresh's working set (every saved session
/// plus every passive child walks into the cache on one list; TS's design
/// point is ~2k sessions resident) - a cap inside the working set would
/// evict mid-walk and thrash every pass into a full rescan. 4096 keeps
/// the ~2k families plus headroom while bounding unbounded-growth; eviction
/// stays LRU-first (never the old clear-all).
const SESSION_SCAN_MAX_CACHED_STATES: usize = 4096;

/// TS `sessionScanStates` + `storeSessionScanState`'s accounting: the
/// states map with its insertion order (JS Map iteration order — the LRU
/// eviction walks from the front) and the retained-usage-entry counter.
#[derive(Default)]
struct SessionInfoScanCache {
    states: HashMap<PathBuf, SessionScanState>,
    /// Insertion order; a re-store moves a path to the back (LRU recency).
    order: Vec<PathBuf>,
    retained_usage_entries: usize,
}

impl SessionInfoScanCache {
    /// TS `dropSessionScanState`.
    fn drop_state(&mut self, path: &Path) {
        if let Some(state) = self.states.remove(path) {
            self.retained_usage_entries -= state.accounted_usage_entries;
        }
        self.order.retain(|p| p != path);
    }

    /// The unchanged-file hit re-stores in TS (`storeSessionScanState
    /// (filePath, previous)`) — LRU recency without re-accounting.
    fn touch(&mut self, path: &Path) {
        if !self.states.contains_key(path) {
            return;
        }
        self.order.retain(|p| p.as_path() != path);
        self.order.push(path.to_path_buf());
    }

    /// TS `storeSessionScanState`: (re-)store with fresh accounting, then
    /// evict insertion-order-first states until the budget holds.
    fn store_state(&mut self, path: &Path, state: SessionScanState) {
        self.drop_state(path);
        let mut state = state;
        state.accounted_usage_entries = state.acc.usage_scan.retained_entries();
        self.retained_usage_entries += state.accounted_usage_entries;
        self.order.push(path.to_path_buf());
        self.states.insert(path.to_path_buf(), state);
        while self.retained_usage_entries > SESSION_SCAN_MAX_RETAINED_USAGE_ENTRIES
            || self.states.len() > SESSION_SCAN_MAX_CACHED_STATES
        {
            let Some(front) = self.order.first().cloned() else {
                break;
            };
            self.drop_state(&front);
        }
    }
}

fn session_info_cache() -> &'static std::sync::Mutex<SessionInfoScanCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<SessionInfoScanCache>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(SessionInfoScanCache::default()))
}

/// TS `SESSION_SCAN_RESUME_TAIL_BYTES`: the trailing window of the consumed
/// prefix a resumed scan verifies before trusting the cached fold state
/// (`scannedPrefixIntact`). The product appends, so a same-identity,
/// same-size rewrite is the aliasing risk the check covers.
const SESSION_SCAN_RESUME_TAIL_BYTES: usize = 16;

/// TS `SessionScanAccumulator`: the per-file fold state a resume continues
/// from. The finished [`SessionInfo`] is derived from this; the cached state
/// carries the accumulator so a grown file folds ONLY its appended entries.
/// Clone is the snapshot fold's copy (TS `snapshotSessionInfo`).
#[derive(Clone, Default)]
struct SessionScanAccumulator {
    header: Option<SessionHeader>,
    name: Option<String>,
    state: Option<String>,
    model: Option<(String, String)>,
    thinking_level: Option<String>,
    message_count: usize,
    first_message: String,
    all_messages_text: String,
    last_activity_ms: Option<u64>,
    usage_scan: crate::session_usage::UsageScan,
}

/// One cached scan state (TS `SessionScanState`): the generation the state
/// was certified at, the fold accumulator, the consumed-prefix cursor, the
/// resume tail, and the derived info.
struct SessionScanState {
    generation: SessionInfoGeneration,
    acc: SessionScanAccumulator,
    /// Bytes consumed through the end of the last complete line.
    offset: u64,
    /// The trailing window of the consumed prefix (TS `advanceScanTail`).
    tail: [u8; SESSION_SCAN_RESUME_TAIL_BYTES],
    info: Option<SessionInfo>,
    /// Usage entries counted against the retained bound at the last store
    /// (TS `accountedUsageEntries`).
    accounted_usage_entries: usize,
}

impl SessionScanState {
    fn fresh(generation: SessionInfoGeneration) -> Self {
        Self {
            generation,
            acc: SessionScanAccumulator::default(),
            offset: 0,
            tail: [b'\n'; SESSION_SCAN_RESUME_TAIL_BYTES],
            info: None,
            accounted_usage_entries: 0,
        }
    }

    /// The resume copy: the fold state travels, the derived info does not
    /// (the appended entries rebuild it).
    fn clone_for_resume(&self) -> Self {
        Self {
            generation: self.generation,
            acc: SessionScanAccumulator {
                header: self.acc.header.clone(),
                name: self.acc.name.clone(),
                state: self.acc.state.clone(),
                model: self.acc.model.clone(),
                thinking_level: self.acc.thinking_level.clone(),
                message_count: self.acc.message_count,
                first_message: self.acc.first_message.clone(),
                all_messages_text: self.acc.all_messages_text.clone(),
                last_activity_ms: self.acc.last_activity_ms,
                usage_scan: self.acc.usage_scan.clone(),
            },
            offset: self.offset,
            tail: self.tail,
            info: None,
            accounted_usage_entries: 0,
        }
    }

    /// TS `seedRosterLedger`-side identity: the resume requires the same
    /// file (dev/ino) with a grown-or-equal length.
    fn same_file_identity(&self, generation: &SessionInfoGeneration) -> bool {
        #[cfg(unix)]
        {
            self.generation.dev == generation.dev && self.generation.ino == generation.ino
        }
        // No dev/ino from std on this platform, so a grown file cannot be
        // certified as the same inode: every grown file rescans whole (TS
        // always has dev/ino from Node fs stats). An mtime-based identity
        // would instead certify an in-place rewrite as a resume.
        #[cfg(not(unix))]
        {
            false
        }
    }

    /// TS `advanceScanTail`: the consumed prefix's trailing window. A line at
    /// least as long as the window keeps only its last bytes plus the
    /// newline; a short line rolls into the previous window first.
    fn advance_tail(&mut self, line: &[u8]) {
        let keep = SESSION_SCAN_RESUME_TAIL_BYTES - 1;
        let mut combined = Vec::with_capacity(SESSION_SCAN_RESUME_TAIL_BYTES + line.len() + 1);
        if line.len() >= keep {
            combined.extend_from_slice(&line[line.len() - keep..]);
        } else {
            combined.extend_from_slice(&self.tail);
            combined.extend_from_slice(line);
        }
        combined.push(b'\n');
        let start = combined
            .len()
            .saturating_sub(SESSION_SCAN_RESUME_TAIL_BYTES);
        self.tail.copy_from_slice(&combined[start..]);
    }

    /// TS `scannedPrefixIntact`: the bytes just before the cursor match the
    /// cached window, proving the resume starts where the cached fold left
    /// off (a torn write or a rewrite that raced the scan is caught here).
    /// Session files are append-only between whole-file rewrites; an
    /// in-place interior edit that keeps the identity, growth, and this
    /// window intact defeats the check on TS too - outside the writer
    /// model (session-manager.ts: "In-place interior edits that defeat all
    /// four are outside the writer model").
    fn prefix_intact(&self, file: &fs::File) -> bool {
        use std::io::{Read, Seek, SeekFrom};
        if self.offset == 0 {
            return true;
        }
        let window = SESSION_SCAN_RESUME_TAIL_BYTES as u64;
        let start = self.offset.saturating_sub(window);
        let len = (self.offset - start) as usize;
        let mut read_back = vec![0u8; len];
        let mut cursor = file;
        if cursor.seek(SeekFrom::Start(start)).is_err() {
            return false;
        }
        if cursor.read_exact(&mut read_back).is_err() {
            return false;
        }
        read_back.as_slice() == &self.tail[self.tail.len() - len..]
    }
}

/// The listing fold only needs message metadata after the search corpus is full.
/// Unknown fields (especially large assistant content) are skipped by serde.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfoMessage {
    #[serde(default)]
    role: Option<Value>,
    #[serde(default)]
    provider: Option<Value>,
    #[serde(default)]
    model: Option<Value>,
    #[serde(default)]
    timestamp: Option<Value>,
    /// The lenient scan-side shape ([`crate::session_usage::ScanUsage`]):
    /// a partial persisted block must not reject the row.
    #[serde(default)]
    usage: Option<crate::session_usage::ScanUsage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfoEntry {
    #[serde(rename = "type")]
    type_: String,
    #[serde(rename = "id")]
    id: String,
    #[serde(rename = "timestamp")]
    _timestamp: String,
    #[serde(default, rename = "parentId")]
    _parent_id: Option<String>,
    #[serde(default)]
    name: Option<Value>,
    #[serde(default)]
    state: Option<Value>,
    #[serde(default)]
    provider: Option<Value>,
    #[serde(default)]
    model_id: Option<Value>,
    #[serde(default)]
    thinking_level: Option<Value>,
    #[serde(default)]
    message: Option<SessionInfoMessage>,
    /// `child_usage_attributed`: the parent entry the aggregate folds into.
    #[serde(default)]
    target_id: Option<String>,
    #[serde(default)]
    child_usage: Option<crate::session_usage::ScanUsage>,
    #[serde(default)]
    aggregate_usage: Option<crate::session_usage::ScanUsage>,
    /// `compaction`/`branch_summary`: the summarization call's own usage.
    #[serde(default)]
    usage: Option<crate::session_usage::ScanUsage>,
}

/// Read a session file's list metadata (TS `readSessionInfo` over the
/// resumable per-file scan states): an unchanged file answers from the
/// cached fold, a grown file folds ONLY its appended entries after the
/// prefix-tail check, and a rewritten file rescans from the top.
pub fn read_session_info(path: &Path) -> Option<SessionInfo> {
    let mut file = fs::File::open(path).ok()?;
    let generation = SessionInfoGeneration::from_metadata(&file.metadata().ok()?);

    // The unchanged case answers from the cache; the grown case resumes.
    let mut state = {
        let mut cache = session_info_cache().lock().ok()?;
        match cache.states.get(path) {
            Some(cached) if cached.generation == generation => {
                let info = cached.info.clone();
                cache.touch(path);
                return info;
            }
            Some(cached)
                if cached.same_file_identity(&generation)
                    && generation.len > cached.generation.len =>
            {
                if cached.prefix_intact(&file) {
                    cached.clone_for_resume()
                } else {
                    SessionScanState::fresh(generation)
                }
            }
            _ => SessionScanState::fresh(generation),
        }
    };
    // Position the shared cursor at the resume point. A fresh state rewinds
    // to byte 0: `prefix_intact` leaves the cursor at the old consumed end
    // (its tail-window read), and a fresh scan started there would miss the
    // session header. TS restarts its stream at `state.offset` every scan.
    if std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(state.offset)).is_err() {
        return None;
    }
    let mut reader = std::io::BufReader::new(&mut file);
    let torn_tail = state.scan_from_cursor(&mut reader, generation.len)?;
    // TS's listing stat (`stats.mtime`): the durable last-resort value for
    // `modified`, captured from the open file like TS captures it at
    // readdir. `None` keeps unavailable (unreadable, pre-epoch) metadata
    // distinct from a real epoch timestamp.
    let stats_mtime_ms = file.metadata().ok().and_then(|meta| {
        meta.modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
    });
    let info = state.build_info(path, stats_mtime_ms, Some(&torn_tail))?;
    // A concurrent append/replacement must never certify stale metadata.
    // Records without message timestamps never certify either: their
    // `modified` is a durable value now (header time, then mtime), but the
    // fold re-reads them instead of trusting a certified copy.
    let modified_ms = state.acc.last_activity_ms.unwrap_or(0);
    if cfg!(unix)
        && modified_ms > 0
        && file
            .metadata()
            .ok()
            .is_some_and(|meta| SessionInfoGeneration::from_metadata(&meta) == generation)
        && fs::metadata(path)
            .ok()
            .is_some_and(|meta| SessionInfoGeneration::from_metadata(&meta) == generation)
    {
        state.generation = generation;
        state.info = Some(info.clone());
        if let Ok(mut cache) = session_info_cache().lock() {
            cache.store_state(path, state);
        }
    }
    Some(info)
}

impl SessionScanState {
    /// Fold lines from the cursor (TS `scanSessionLines`): a complete line
    /// advances the cursor and the tail; an unterminated final line is
    /// never consumed (it may still be an in-progress append) and is
    /// returned as the snapshot-only torn tail. `None` = the abort arm.
    fn scan_from_cursor(
        &mut self,
        reader: &mut std::io::BufReader<&mut fs::File>,
        size: u64,
    ) -> Option<String> {
        let mut line = String::new();
        loop {
            line.clear();
            let consumed = std::io::BufRead::read_line(reader, &mut line).ok()?;
            if consumed == 0 {
                break;
            }
            let complete = line.ends_with('\n');
            if !complete && (self.offset + consumed as u64) >= size {
                // A torn trailing line: not folded here, the cursor stays
                // put so the completed line folds on the next scan; the
                // caller folds it into the current snapshot only.
                return Some(line);
            }
            if complete {
                line.pop();
            }
            fold_scan_entry(&mut self.acc, &line)?;
            self.offset += consumed as u64;
            self.advance_tail(line.as_bytes());
            if !complete {
                break;
            }
        }
        Some(String::new())
    }

    /// Derive the listing row (the tail of the old full scan). A non-empty
    /// torn tail folds into a SNAPSHOT copy of the accumulator (TS
    /// `snapshotSessionInfo`): the valid unterminated final line reaches
    /// the row, while the consumed prefix - the resumable state - stays
    /// untouched for the scan that sees the terminating newline.
    fn build_info(
        &self,
        path: &Path,
        stats_mtime_ms: Option<u64>,
        torn: Option<&str>,
    ) -> Option<SessionInfo> {
        let snapshot;
        let acc = match torn.filter(|tail| !tail.trim().is_empty()) {
            Some(tail) => {
                let mut snap = self.acc.clone();
                fold_scan_entry(&mut snap, tail)?;
                snapshot = snap;
                &snapshot
            }
            None => &self.acc,
        };
        let usage = acc.usage_scan.summary();
        let header = acc.header.as_ref()?;
        // TS `getSessionModifiedDateFromLastActivity`: the newest
        // user/assistant message timestamp, then the header's own creation
        // timestamp, then the file's mtime — never scan time. The port's
        // `now()` fallback refreshed `modified` to the moment of every
        // re-enumeration for records without message timestamps, so
        // long-old sessions read as minutes old in the agents view. A zero
        // here is a real epoch timestamp (a 1970 header or mtime renders
        // 1970-01-01, like TS `toISOString`); only the message-timestamp
        // arm filters zero, because the append path stamps a missing
        // entry timestamp as 0, not activity. `None` — undatable header,
        // unavailable mtime — renders blank, never a fabricated age.
        let modified_ms = acc
            .last_activity_ms
            .filter(|ms| *ms > 0)
            .or_else(|| crate::util::iso_to_unix_ms(&header.timestamp))
            .or(stats_mtime_ms);
        let modified = modified_ms
            .map(crate::util::iso_from_unix_ms)
            .unwrap_or_default();
        Some(SessionInfo {
            path: path.to_path_buf(),
            id: header.id.clone(),
            cwd: header.cwd.clone(),
            name: acc.name.clone(),
            state: acc.state.clone(),
            model: acc.model.clone(),
            thinking_level: acc.thinking_level.clone(),
            parent_session_path: header.parent_session.clone(),
            rlm_depth: header.rlm_depth.unwrap_or(0) as u32,
            created: header.timestamp.clone(),
            modified,
            message_count: acc.message_count,
            first_message: if acc.first_message.is_empty() {
                "(no messages)".to_string()
            } else {
                acc.first_message.clone()
            },
            all_messages_text: acc.all_messages_text.clone(),
            usage,
            // Ledger-derived (`withPassiveRlmDescendantInfos`), never the
            // file scan's: the listing arm attaches it from the spawn
            // ledger's deleted-descendant bucket.
            deleted_descendant_usage: None,
        })
    }
}

/// Fold one complete line into the scan state (the old scan-loop body).
/// `None` = the abort arm (a `model_change` without its model identity).
fn fold_scan_entry(acc: &mut SessionScanAccumulator, raw: &str) -> Option<()> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(());
    }
    let Ok(entry) = serde_json::from_str::<SessionInfoEntry>(trimmed) else {
        return Some(());
    };
    match entry.type_.as_str() {
        "session" => {
            let parsed: SessionHeader = serde_json::from_str(trimmed).ok()?;
            acc.header = Some(parsed);
        }
        "session_info" => {
            acc.name = entry
                .name
                .as_ref()
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .map(str::to_string);
        }
        "session_state" => {
            if let Some(status) = entry
                .state
                .as_ref()
                .and_then(|s| s.get("status"))
                .and_then(Value::as_str)
            {
                acc.state = Some(normalize_state_status(status));
            }
        }
        "model_change" => {
            acc.model = Some((
                entry.provider.as_ref()?.as_str()?.to_string(),
                entry.model_id.as_ref()?.as_str()?.to_string(),
            ));
        }
        "thinking_level_change" => {
            if let Some(level) = entry
                .thinking_level
                .as_ref()
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|level| !level.is_empty())
            {
                acc.thinking_level = Some(level.to_string());
            }
        }
        "child_usage_attributed" => {
            acc.usage_scan.fold_child_attribution(
                entry.target_id.as_deref(),
                entry.child_usage.map(Usage::from),
                entry.aggregate_usage.map(Usage::from),
            );
        }
        "compaction" | "branch_summary" => {
            acc.usage_scan
                .fold_summarization(entry.usage.map(Usage::from));
        }
        "message" => {
            acc.message_count += 1;
            if let Some(message) = entry.message {
                let role = message.role.as_ref().and_then(Value::as_str);
                acc.usage_scan
                    .fold_message(&entry.id, role, message.usage.map(Usage::from));
                if role == Some("assistant") {
                    if let (Some(provider), Some(model_id)) = (
                        message.provider.as_ref().and_then(Value::as_str),
                        message.model.as_ref().and_then(Value::as_str),
                    ) {
                        acc.model = Some((provider.to_string(), model_id.to_string()));
                    }
                }
                if matches!(role, Some("user" | "assistant")) {
                    if let Some(timestamp) = message.timestamp.as_ref().and_then(Value::as_u64) {
                        acc.last_activity_ms =
                            Some(acc.last_activity_ms.unwrap_or(0).max(timestamp));
                    }
                }
                if (role == Some("user") && acc.first_message.is_empty())
                    || (matches!(role, Some("user" | "assistant"))
                        && acc.all_messages_text.chars().count()
                            < SESSION_LIST_SEARCH_TEXT_MAX_CHARS)
                {
                    if let Ok(full) = serde_json::from_str::<SessionEntry>(trimmed) {
                        if let Some(message) = full.fields.get("message") {
                            if role == Some("user") && acc.first_message.is_empty() {
                                let text = message_text(message);
                                if !text.is_empty() {
                                    acc.first_message = text;
                                }
                            }
                            if matches!(role, Some("user" | "assistant")) {
                                append_capped_search_text(
                                    &mut acc.all_messages_text,
                                    &message_text(message),
                                );
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }
    Some(())
}

/// Most recent valid session for a cwd (port of `findMostRecentSessionForCwd`).
pub fn find_most_recent_session_for_cwd(session_dir: &Path, cwd: &str) -> Option<PathBuf> {
    list_sessions(session_dir)
        .into_iter()
        .find(|info| {
            !info.cwd.is_empty()
                && Path::new(&info.cwd).canonicalize().map_or_else(
                    |_| info.cwd == cwd,
                    |p| {
                        p == Path::new(cwd)
                            .canonicalize()
                            .unwrap_or_else(|_| PathBuf::from(cwd))
                    },
                )
        })
        .map(|info| info.path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pa-daemon-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The captured-attribution fixture: real devbox session rows
    /// (content sanitized; ids, timestamps, and usage verbatim) — six
    /// `child_usage_attributed` entries target one assistant row.
    fn captured_attribution_fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/attribution-fold-captured.jsonl")
    }

    #[test]
    fn bounded_header_matches_the_line_read() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/repo", None, 0);
        session.append_message(json!({"role": "user", "content": "hi", "timestamp": 1u64}));
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.rewrite().unwrap();
        assert_eq!(
            read_session_header_bounded(&path),
            read_session_header(&path)
        );
        assert!(is_valid_session_file(&path));
    }

    #[test]
    fn bounded_header_rejects_a_non_json_first_line() {
        let dir = temp_dir();
        let path = dir.join("bad.jsonl");
        fs::write(&path, "truncated junk without json\n").unwrap();
        assert_eq!(read_session_header_bounded(&path), None);
        assert!(!is_valid_session_file(&path));
    }

    #[test]
    fn bounded_header_refuses_an_over_long_first_line() {
        let dir = temp_dir();
        // A cwd long enough to push the serialized header past the 512-byte
        // bound: the bounded read judges nothing; the line read still does.
        let mut session = SessionFile::create(&format!("/repo/{}", "x".repeat(600)), None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.rewrite().unwrap();
        assert_eq!(read_session_header_bounded(&path), None);
        assert!(read_session_header(&path).is_some());
    }

    #[test]
    fn bounded_header_reads_an_unterminated_first_line() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/repo", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.rewrite().unwrap();
        let header_line = fs::read_to_string(&path).unwrap();
        fs::write(&path, header_line.trim_end()).unwrap();
        assert_eq!(
            read_session_header_bounded(&path),
            read_session_header(&path)
        );
    }

    #[test]
    fn bounded_header_strips_a_crlf_line_return() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/repo", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.rewrite().unwrap();
        let header_line = fs::read_to_string(&path).unwrap();
        fs::write(&path, format!("{}\r\n", header_line.trim_end())).unwrap();
        assert_eq!(
            read_session_header_bounded(&path),
            read_session_header(&path)
        );
    }

    #[test]
    fn bounded_header_treats_an_empty_file_as_headerless() {
        let dir = temp_dir();
        let path = dir.join("empty.jsonl");
        fs::write(&path, "").unwrap();
        assert_eq!(read_session_header_bounded(&path), None);
        assert!(!is_valid_session_file(&path));
    }

    #[test]
    fn open_folds_captured_child_usage_attributions() {
        let store = SessionFile::open(&captured_attribution_fixture()).unwrap();
        // The raw file row: input 2690 / totalTokens 23032 / cost $0. The
        // last attribution's cumulative aggregate replaces it (TS
        // `applyChildUsageAttributions`): input 52898 / totalTokens 23032
        // (unchanged — the aggregate keeps the row's context size) / cost
        // $0.0089957. Six entries fold once, never sum.
        let assistant = store.entry("4f61089a").expect("captured target row");
        let usage = &assistant.fields["message"]["usage"];
        assert_eq!(usage["input"], json!(52898));
        assert_eq!(usage["output"], json!(5863));
        assert_eq!(usage["cacheRead"], json!(18560));
        assert_eq!(usage["cacheWrite"], json!(0));
        assert_eq!(usage["totalTokens"], json!(23032));
        assert_eq!(usage["cost"]["total"].as_f64(), Some(0.008_995_7));
    }

    #[test]
    fn append_entry_folds_a_live_child_usage_attribution() {
        let mut store = SessionFile::create("/tmp", None, 0);
        store.append_message(json!({"role": "user", "content": "hi", "timestamp": 1u64}));
        let assistant = store.append_message(json!({
            "role": "assistant", "content": "hello", "provider": "p", "model": "m",
            "timestamp": 2u64,
            "usage": {"input": 10, "output": 2, "cacheRead": 0, "cacheWrite": 0,
                      "totalTokens": 12,
                      "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
        }));
        store.append_entry(
            "child_usage_attributed",
            json!({
                "targetId": assistant,
                "origin": "spawn_task",
                "childUsage": {"input": 5, "output": 1, "cacheRead": 0, "cacheWrite": 0,
                               "totalTokens": 6,
                               "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.01}},
                "aggregateUsage": {"input": 15, "output": 3, "cacheRead": 0, "cacheWrite": 0,
                                   "totalTokens": 12,
                                   "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.01}},
            }),
        );
        // The live seam folds without a reopen (TS
        // `SessionManager.append_child_usage_attribution` folds after the
        // durable append).
        let row = store.entry(&assistant).unwrap();
        assert_eq!(row.fields["message"]["usage"]["input"], json!(15));
        assert_eq!(row.fields["message"]["usage"]["output"], json!(3));
        assert_eq!(row.fields["message"]["usage"]["totalTokens"], json!(12));
        assert_eq!(
            row.fields["message"]["usage"]["cost"]["total"].as_f64(),
            Some(0.01)
        );
    }

    #[test]
    fn a_malformed_aggregate_does_not_zero_the_target_row() {
        let mut store = SessionFile::create("/tmp", None, 0);
        store.append_message(json!({"role": "user", "content": "hi", "timestamp": 1u64}));
        let assistant = store.append_message(json!({
            "role": "assistant", "content": "hello", "provider": "p", "model": "m",
            "timestamp": 2u64,
            "usage": {"input": 10, "output": 2, "cacheRead": 0, "cacheWrite": 0,
                      "totalTokens": 12,
                      "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
        }));
        // A malformed aggregate (null / a scalar) must not overwrite the
        // row's valid usage with nothing — the fold skips it, exactly like
        // the typed session reader rejects invalid attribution payloads.
        store.append_entry(
            "child_usage_attributed",
            json!({"targetId": assistant, "origin": "spawn_task", "aggregateUsage": null}),
        );
        store.append_entry(
            "child_usage_attributed",
            json!({"targetId": assistant, "origin": "direct_user", "aggregateUsage": 42}),
        );
        let row = store.entry(&assistant).unwrap();
        assert_eq!(row.fields["message"]["usage"]["input"], json!(10));
        assert_eq!(row.fields["message"]["usage"]["totalTokens"], json!(12));
    }

    /// The depth-2 chain (the Macroscope #2671 thread's design pin): a
    /// child session file carrying its OWN grandchild attributions (the
    /// child spawned a child) opens FOLDED — the end-of-load fold replaces
    /// the target assistant row's usage with the newest cumulative
    /// aggregate — and the observer walk (`child_usage_batches` over the
    /// OPENED store) reports the FOLDED aggregate to the root: the
    /// grandchild's billable spend reaches the root parent exactly like
    /// the TS in-process fold does.
    #[test]
    fn the_depth_two_chain_reports_the_folded_aggregate() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("depth-two.jsonl");
        let row = |id: &str, parent: Option<&str>, message: Value| {
            json!({
                "type": "message", "id": id, "parentId": parent,
                "timestamp": "2026-09-24T00:00:00.000Z",
                "message": message,
            })
            .to_string()
        };
        let assistant_usage = json!({
            "input": 1_000, "output": 40, "cacheRead": 0, "cacheWrite": 0,
            "totalTokens": 1_040,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.10 },
        });
        let lines = [
            json!({"type": "session", "version": 3, "id": "child-s1", "timestamp": "2026-09-24T00:00:00.000Z", "cwd": "/tmp"}).to_string(),
            row("u1", None, json!({"role": "user", "content": "task"})),
            row(
                "a1",
                Some("u1"),
                json!({
                    "role": "assistant",
                    "provider": "prime-inference", "model": "internal/glm-5.3-fast",
                    "content": [{ "type": "text", "text": "hi" }],
                    "stopReason": "stop",
                    "usage": assistant_usage,
                }),
            ),
            // The grandchild's attribution into the child's spawning row: the
            // cumulative aggregate (raw + grandchild spend) that the fold
            // installs at load.
            json!({
                "type": "child_usage_attributed", "id": "attr1", "parentId": "a1",
                "timestamp": "2026-09-24T00:00:01.000Z",
                "targetId": "a1", "origin": "spawn_task",
                "childUsage": { "input": 500, "output": 10, "cacheRead": 0, "cacheWrite": 0,
                                "totalTokens": 510,
                                "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.05 } },
                "aggregateUsage": { "input": 1_500, "output": 50, "cacheRead": 0, "cacheWrite": 0,
                                    "totalTokens": 1_040,
                                    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.15 } },
            })
            .to_string(),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();
        // The fold applies at open (TS applyChildUsageAttributions).
        let store = SessionFile::open(&path).unwrap();
        let folded = store.entry("a1").expect("the target row");
        assert_eq!(
            folded.fields["message"]["usage"]["input"],
            json!(1_500),
            "the end-of-load fold installed the cumulative aggregate"
        );
        // The observer walk reads the FOLDED store: the depth-2 batch the
        // root receives carries the grandchild's spend (input 1,500 — the
        // raw 1,000 would mean the grandchild vanished at depth 2).
        let (batches, next) = crate::rlm_child_usage::child_usage_batches(store.entries(), 0);
        assert_eq!(next, store.entries().len(), "the walk consumes the file");
        let spawn = batches
            .iter()
            .find(|(origin, _)| matches!(origin, pa_types::session::ChildUsageOrigin::SpawnTask))
            .expect("the spawning turn's batch");
        assert_eq!(
            spawn.1.input, 1_500,
            "the folded aggregate rides the report"
        );
        assert_eq!(spawn.1.cost.total, pa_types::JsNumber(0.15));
    }

    #[test]
    fn creates_and_loads_a_session() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.append_session_state("active");
        session.append_message(json!({"role": "user", "content": "hi", "timestamp": 1u64}));
        session.append_message(json!({"role": "assistant", "content": "hello", "provider": "p", "model": "m", "timestamp": 2u64}));
        session.rewrite().unwrap();

        let loaded = SessionFile::open(&path).unwrap();
        assert_eq!(loaded.session_id(), session.session_id());
        assert_eq!(loaded.message_count(), 2);
        assert_eq!(loaded.state().as_deref(), Some("active"));
        let messages = loaded.messages();
        assert_eq!(messages.len(), 2);
        assert_eq!(crate::types::message_text(&messages[0]), "hi");

        let info = read_session_info(&path).unwrap();
        assert_eq!(info.message_count, 2);
        assert_eq!(info.first_message, "hi");
        assert_eq!(
            info.model.as_ref().map(|(p, m)| (p.as_str(), m.as_str())),
            Some(("p", "m"))
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// A corrupt file can hold a parent cycle; the branch walk must
    /// terminate anyway (the same guard `build_session_context` has). The
    /// session-model restore reads the branch through this walk, so a
    /// cyclic file would otherwise hang the create's blocking task.
    #[test]
    fn a_cyclic_parent_chain_terminates_the_branch_walk() {
        let mut session = SessionFile::create("/tmp", None, 0);
        session.append_message(json!({"role": "user", "content": "a", "timestamp": 1u64}));
        session.append_message(json!({"role": "user", "content": "b", "timestamp": 2u64}));
        // Forge the cycle: the two entries point at each other.
        let first = session.entries[0].id.clone();
        let second = session.entries[1].id.clone();
        session.entries[0].parent_id = Some(second);
        session.entries[1].parent_id = Some(first);
        let branch = session.branch();
        assert!(
            branch.len() <= 2,
            "the cyclic walk terminates: {:?}",
            branch
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>()
        );
        // The root-to-leaf typed walk (the restore's reader) terminates too.
        let typed = session.branch_file_entries();
        assert!(typed.len() <= 2, "branch_file_entries terminates");
    }

    /// The persisted thinking level (`thinking_level_change`): the last
    /// entry wins, like the model; a malformed or empty level never
    /// replaces a prior good one.
    #[test]
    fn scan_keeps_the_latest_persisted_thinking_level() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.append_thinking_level_change("medium");
        session.append_thinking_level_change("high");
        session.rewrite().unwrap();
        let info = read_session_info(&path).unwrap();
        assert_eq!(info.thinking_level.as_deref(), Some("high"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// A failed append leaves the store unchanged: the in-memory index
    /// only adopts entries the file accepted, so the next append parents
    /// to the last persisted entry and the reloaded file stays walkable.
    #[test]
    fn failed_persist_keeps_the_store_walkable() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let file = dir.join(session_file_name(session.session_id()));
        session.set_path(file.clone());
        let first = session
            .persist_entry(
                "message",
                json!({ "message": { "role": "user", "content": "hi" } }),
            )
            .unwrap();
        let blocker = dir.join("blocked");
        fs::create_dir_all(&blocker).unwrap();
        session.set_path(blocker);
        assert!(session
            .persist_entry(
                "message",
                json!({ "message": { "role": "user", "content": "x" } })
            )
            .is_err());
        assert_eq!(
            session.entries().len(),
            1,
            "only the persisted entry stays indexed"
        );
        assert_eq!(session.leaf_id(), Some(first.as_str()));
        session.set_path(file.clone());
        let third = session
            .persist_entry(
                "message",
                json!({ "message": { "role": "user", "content": "again" } }),
            )
            .unwrap();
        // The reloaded file chains first -> third: the failed append added
        // nothing to the file, so the next one chains from the last
        // persisted entry.
        let loaded = SessionFile::open(&file).unwrap();
        let chain: Vec<&str> = loaded
            .branch()
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        assert_eq!(chain, [first.as_str(), third.as_str()]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// The replay's dedup predicate is the disclosure row's fields: the
    /// create handler recognizes the exact row wherever it came from —
    /// this replacement's own declaration-stamped persist, an earlier
    /// crash-replay's identical row, or the dead worker's own abort arm
    /// (the same fields carrying the worker's persist-time stamp) — and
    /// appends nothing. A different disclosure (another reason or
    /// outcome) stays distinct.
    #[test]
    fn declaration_stamped_entry_survives_reload_as_the_same_identity() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let file = dir.join(session_file_name(session.session_id()));
        session.set_path(file.clone());
        let disclosure = json!({
            "customType": "compaction_outcome",
            "content": "Compaction cancelled",
            "display": true,
            "details": { "reason": "threshold", "outcome": "cancelled" },
        });
        let declared_at = "2026-09-23T06:00:00Z";
        session
            .persist_entry_at("custom_message", disclosure.clone(), declared_at)
            .unwrap();

        // The rebuilt transcript (a fresh open) holds the exact row: the
        // replay's fields-only dedup matches it — the declaration stamp
        // and any other stamp alike — so the row is not appended twice.
        let loaded = SessionFile::open(&file).unwrap();
        let already_disclosed =
            |entry: &SessionEntry| entry.type_ == "custom_message" && entry.fields == disclosure;
        assert!(loaded.entries().iter().any(already_disclosed));

        // The worker's own abort arm carries the same fields under its own
        // persist-time stamp: still the same disclosure, still not a
        // duplicate.
        let mut with_own_row = SessionFile::open(&file).unwrap();
        with_own_row
            .persist_entry("custom_message", disclosure.clone())
            .unwrap();
        assert!(with_own_row.entries().iter().any(already_disclosed));

        // A different disclosure (a failed run's row) stays distinct.
        let failed = json!({
            "customType": "compaction_outcome",
            "content": "Compaction failed: Summarization failed",
            "display": true,
            "details": { "reason": "threshold", "outcome": "failed" },
        });
        assert!(!loaded
            .entries()
            .iter()
            .any(|entry| entry.type_ == "custom_message" && entry.fields == failed));
        let _ = fs::remove_dir_all(&dir);
    }

    /// `branch_bridged` reconstructs the intended chain across a
    /// ghost-parent gap: the missing id was minted but never persisted, so
    /// the walk continues from the gap entry's file predecessor (the
    /// writer's leaf at the time).
    #[test]
    fn branch_bridged_bridges_ghost_parent_gaps() {
        let dir = temp_dir();
        let path = dir.join("ghosted.jsonl");
        let content = [
            json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}),
            json!({"type": "message", "id": "e1", "parentId": null, "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "user", "content": "hi"}}),
            json!({"type": "session_state", "id": "e2", "parentId": "e1", "timestamp": "2026-09-22T00:00:02.000Z", "state": {"status": "active"}}),
            json!({"type": "message", "id": "e3", "parentId": "8b5f0d21", "timestamp": "2026-09-22T00:00:03.000Z", "message": {"role": "user", "content": "after the gap"}}),
            json!({"type": "message", "id": "e4", "parentId": "e3", "timestamp": "2026-09-22T00:00:04.000Z", "message": {"role": "assistant", "content": "ok"}}),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
        fs::write(&path, content).unwrap();
        let store = SessionFile::open(&path).unwrap();
        let strict: Vec<&str> = store
            .branch()
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        assert_eq!(
            strict,
            ["e3", "e4"],
            "the strict walk truncates at the ghost"
        );
        let bridged: Vec<&str> = store
            .branch_bridged()
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        assert_eq!(bridged, ["e1", "e2", "e3", "e4"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A gap after a persisted branch move follows the active lineage:
    /// the `branch_summary` marker is the gap entry's file predecessor
    /// and chains from the moved-to entry, so the bridged walk keeps the
    /// active branch and skips the abandoned fork.
    #[test]
    fn branch_bridged_skips_abandoned_chains_after_a_persisted_branch_move() {
        let dir = temp_dir();
        let path = dir.join("moved.jsonl");
        let content = [
            json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}),
            json!({"type": "message", "id": "e1", "parentId": null, "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "user", "content": "root"}}),
            json!({"type": "message", "id": "e2", "parentId": "e1", "timestamp": "2026-09-22T00:00:02.000Z", "message": {"role": "user", "content": "abandoned a"}}),
            json!({"type": "message", "id": "e3", "parentId": "e2", "timestamp": "2026-09-22T00:00:03.000Z", "message": {"role": "user", "content": "abandoned b"}}),
            json!({"type": "branch_summary", "id": "m1", "parentId": "e1", "timestamp": "2026-09-22T00:00:04.000Z", "fromId": "e1", "summary": "moved back"}),
            json!({"type": "message", "id": "e4", "parentId": "8b5f0d21", "timestamp": "2026-09-22T00:00:05.000Z", "message": {"role": "user", "content": "after the move"}}),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
        fs::write(&path, content).unwrap();
        let store = SessionFile::open(&path).unwrap();
        let bridged: Vec<&str> = store
            .branch_bridged()
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        assert_eq!(bridged, ["e1", "m1", "e4"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A clean file bridges nothing: the bridged walk equals the strict
    /// walk, and forked-off entries stay excluded (they resolve by parent
    /// id; only a MISSING parent bridges).
    #[test]
    fn branch_bridged_matches_the_strict_walk_on_clean_files() {
        let dir = temp_dir();
        let path = dir.join("clean.jsonl");
        let content = [
            json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}),
            json!({"type": "message", "id": "e1", "parentId": null, "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "user", "content": "root"}}),
            json!({"type": "message", "id": "fork", "parentId": "e1", "timestamp": "2026-09-22T00:00:02.000Z", "message": {"role": "user", "content": "forked away"}}),
            json!({"type": "message", "id": "e2", "parentId": "e1", "timestamp": "2026-09-22T00:00:03.000Z", "message": {"role": "assistant", "content": "leaf chain"}}),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
        fs::write(&path, content).unwrap();
        let store = SessionFile::open(&path).unwrap();
        let strict: Vec<&str> = store
            .branch()
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        let bridged: Vec<&str> = store
            .branch_bridged()
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        assert_eq!(strict, bridged);
        assert_eq!(strict, ["e1", "e2"], "the fork stays off the leaf chain");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_builds_transcript_search_text() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.append_message(
            json!({"role": "user", "content": "fix the login bug", "timestamp": 1u64}),
        );
        session.append_message(json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "fixed in auth.rs" }],
            "provider": "p", "model": "m", "timestamp": 2u64
        }));
        // Tool traffic is counted but never enters the search corpus.
        session.append_message(
            json!({"role": "toolResult", "content": "tool noise", "timestamp": 3u64}),
        );
        session.rewrite().unwrap();

        let info = read_session_info(&path).unwrap();
        assert_eq!(info.all_messages_text, "fix the login bug fixed in auth.rs");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The saved-row usage summary folds like the TS scan: raw assistant
    /// usage keyed by entry id, the latest attribution aggregate replacing
    /// the raw block, every child block accumulating, summarization usage
    /// added, and the child spend subtracted — the child's own row carries
    /// it, so rollups never double count. `session_usage`'s tests pin the
    /// fold unit-by-unit; this pins the listing scan's wiring.
    #[test]
    fn scan_folds_the_saved_row_usage_summary() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        let assistant_id = session.append_message(json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "run it" }],
            "provider": "p", "model": "m", "timestamp": 1u64,
            "usage": {
                "input": 100, "output": 10, "cacheRead": 20, "cacheWrite": 0,
                "totalTokens": 130,
                "cost": { "input": 0.0, "output": 0.5, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.5 }
            }
        }));
        session.append_entry(
            "child_usage_attributed",
            json!({
                "targetId": assistant_id, "origin": "spawn_task",
                "childUsage": {
                    "input": 30, "output": 3, "cacheRead": 0, "cacheWrite": 0,
                    "totalTokens": 33,
                    "cost": { "input": 0.0, "output": 0.125, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.125 }
                },
                "aggregateUsage": {
                    "input": 130, "output": 13, "cacheRead": 20, "cacheWrite": 0,
                    "totalTokens": 163,
                    "cost": { "input": 0.0, "output": 0.5, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.5 }
                }
            }),
        );
        session.append_entry(
            "compaction",
            json!({
                "summary": "kept", "firstKeptEntryId": assistant_id, "tokensBefore": 100,
                "usage": {
                    "input": 50, "output": 5, "cacheRead": 0, "cacheWrite": 0,
                    "totalTokens": 55,
                    "cost": { "input": 0.0, "output": 0.25, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.25 }
                }
            }),
        );
        session.rewrite().unwrap();

        let info = read_session_info(&path).unwrap();
        // Own: aggregate (150 in + 20 cache, 13 out, $0.5) + compaction
        // (50, 5, $0.25) - child (30, 3, $0.125).
        assert_eq!(
            info.usage,
            Some(crate::session_usage::SessionUsageSummary {
                input_tokens: 170,
                output_tokens: 15,
                cost: 0.625
            })
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// A persisted partial usage object (`{input, output, totalTokens}`
    /// without `cacheRead`/`cacheWrite`/`cost`) must not reject the whole
    /// entry: TS `JSON.parse` keeps the row, so the count, model, search
    /// text, and every present usage field survive.
    #[test]
    fn scan_keeps_messages_with_partial_usage_objects() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.append_message(json!({"role": "user", "content": "run it", "timestamp": 1u64}));
        session.append_message(json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "done" }],
            "provider": "p", "model": "m", "timestamp": 2u64,
            "usage": { "input": 5, "output": 1, "totalTokens": 6 }
        }));
        session.rewrite().unwrap();

        let info = read_session_info(&path).unwrap();
        assert_eq!(info.message_count, 2);
        assert_eq!(info.model, Some(("p".to_string(), "m".to_string())));
        assert!(info.all_messages_text.contains("done"));
        assert_eq!(
            info.usage,
            Some(crate::session_usage::SessionUsageSummary {
                input_tokens: 5,
                output_tokens: 1,
                cost: 0.0
            })
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// A session with no billable work publishes no usage field (TS
    /// `sessionUsageSummaryFrom` returns undefined).
    #[test]
    fn scan_omits_usage_without_billable_work() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.append_message(json!({"role": "user", "content": "hi", "timestamp": 1u64}));
        session.rewrite().unwrap();

        let info = read_session_info(&path).unwrap();
        assert_eq!(info.usage, None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn transcript_search_text_caps_at_the_ts_limit() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        for round in 0..3 {
            let message = "x".repeat(30 * 1024);
            session.append_message(json!({
                "role": "user", "content": format!("{round} {message}"), "timestamp": round + 1
            }));
        }
        session.rewrite().unwrap();

        let info = read_session_info(&path).unwrap();
        assert_eq!(
            info.all_messages_text.chars().count(),
            SESSION_LIST_SEARCH_TEXT_MAX_CHARS
        );
        // Space-joined like TS: exactly one separator between messages.
        assert!(info.all_messages_text.starts_with("0 xxx"));
        assert!(info.all_messages_text.contains("1 xxx"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn durable_first_kept_entry_id_pins_the_boundary_the_read_retains() {
        // The parity scenario the frame diff caught: the engine compacts its
        // in-memory entries and reports an id that never exists in the
        // session file. The durable re-cut must pin the boundary the
        // `messages()` read recognizes, or the retained tail is lost.
        let mut session = SessionFile::create("/tmp", None, 0);
        session.append_message(json!({"role": "user", "content": "first", "timestamp": 1u64}));
        let usage = json!({
            "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 }
        });
        let assistant = |text: String, timestamp: u64| {
            json!({
                "role": "assistant",
                "content": [{ "type": "text", "text": text }],
                "api": "faux", "provider": "p", "model": "m",
                "usage": usage, "stopReason": "stop", "timestamp": timestamp
            })
        };
        session.append_message(assistant(format!("history {}", "word ".repeat(40)), 2u64));
        session
            .append_message(json!({"role": "user", "content": "second turn", "timestamp": 3u64}));
        session.append_message(assistant("second turn done".to_string(), 4u64));

        let durable_id = session.durable_first_kept_entry_id(5);
        // The cut keeps the whole second turn: its user message is the
        // boundary (estimate: 4 + 2 >= 5 stops at the user entry).
        let kept = session
            .branch()
            .iter()
            .find(|entry| {
                entry.fields.get("message").and_then(|m| m.get("content"))
                    == Some(&json!("second turn"))
            })
            .map(|entry| entry.id.clone())
            .expect("the second-turn user entry");
        assert_eq!(durable_id, Some(kept));

        let _ = session.persist_entry(
            "compaction",
            json!({ "summary": "the story", "firstKeptEntryId": durable_id, "tokensBefore": 12 }),
        );
        let messages = session.messages();
        // Wire order is summary-first (TS `buildSessionContext`); the
        // retained messages follow.
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].get("role"), Some(&json!("compactionSummary")));
        assert_eq!(crate::types::message_text(&messages[1]), "second turn");
        assert_eq!(crate::types::message_text(&messages[2]), "second turn done");
    }

    #[test]
    fn entry_chain_links_parents() {
        let mut session = SessionFile::create("/tmp", None, 0);
        let a = session.append_entry("custom", json!({"customType": "x"}));
        let b = session.append_entry("custom", json!({"customType": "y"}));
        assert_eq!(
            session.entry(&b).unwrap().parent_id.as_deref(),
            Some(a.as_str())
        );
        assert_eq!(session.leaf_id(), Some(b.as_str()));
    }

    #[test]
    fn skips_malformed_lines() {
        let dir = temp_dir();
        let path = dir.join("s.jsonl");
        fs::write(
            &path,
            format!(
                "{}\nnot json\n{}\n",
                json!({"type":"session","version":3,"id":"abc","timestamp":"t","cwd":"/x"}),
                json!({"type":"message","id":"aaaa1111","parentId":null,"timestamp":"t","message":{"role":"user","content":"hi"}})
            ),
        )
        .unwrap();
        let loaded = SessionFile::open(&path).unwrap();
        assert_eq!(loaded.message_count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    /// The durable compaction row must byte-serialize in the TS key order
    /// (TS `appendCompaction`'s `CompactionEntry` literal, verified against
    /// the TS binary's session file — battery run 20260921T140248Z,
    /// `ts/f7_compaction/sessions/*.jsonl`):
    /// type, id, parentId, timestamp, summary, firstKeptEntryId,
    /// tokensBefore, details, fromHook, customInstructions?, usage,
    /// harnessDigest — with `details` as `{readFiles, modifiedFiles}` and
    /// `usage` in the TS `Usage` field order. The JSON map preserves
    /// insertion order (`serde_json` `preserve_order`), so any drift shows
    /// up here as a wrong key sequence, not just a wrong shape.
    #[test]
    fn durable_compaction_row_serializes_in_the_ts_key_order() {
        let entry = pa_types::session::CompactionEntry {
            summary: "pre-compaction reply 6".to_string(),
            first_kept_entry_id: "ebd5e444".to_string(),
            tokens_before: 110,
            details: Some(
                serde_json::to_value(
                    &pa_core::session_engine::compaction_exec::CompactionDetails {
                        read_files: vec!["a.rs".to_string()],
                        modified_files: vec!["b.rs".to_string()],
                    },
                )
                .unwrap(),
            ),
            from_hook: Some(false),
            custom_instructions: None,
            usage: Some(pa_types::ai::Usage {
                input: 20,
                output: 10,
                cache_read: 80,
                cache_write: 0,
                total_tokens: 110,
                cost: pa_types::ai::UsageCost::default(),
            }),
            harness_digest: Some("# Continual Harness State".to_string()),
        };
        let fields = serde_json::to_value(&entry).unwrap();
        let mut session = SessionFile::create("/tmp", None, 0);
        session.append_entry("compaction", fields);
        let row = serde_json::to_string(session.entries.last().unwrap()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&row).unwrap();
        let keys: Vec<&str> = parsed
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "type",
                "id",
                "parentId",
                "timestamp",
                "summary",
                "firstKeptEntryId",
                "tokensBefore",
                "details",
                "fromHook",
                "usage",
                "harnessDigest",
            ]
        );
        // The details block is the TS `readFiles`-first literal order, and
        // usage keeps the TS field order (input, output, cacheRead,
        // cacheWrite, totalTokens, cost).
        let details = serde_json::to_string(parsed["details"].as_object().unwrap()).unwrap();
        assert_eq!(
            details,
            "{\"readFiles\":[\"a.rs\"],\"modifiedFiles\":[\"b.rs\"]}"
        );
        let usage: Vec<&str> = parsed["usage"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            usage,
            vec![
                "input",
                "output",
                "cacheRead",
                "cacheWrite",
                "totalTokens",
                "cost"
            ]
        );
    }

    /// The session header line leads with the `type` tag, exactly like the
    /// TS session file's first line (`{"type":"session","version":...}`).
    #[test]
    fn session_header_line_leads_with_the_type_tag() {
        let header = SessionHeader {
            version: Some(3),
            id: "abc".to_string(),
            timestamp: "t".to_string(),
            cwd: "/x".to_string(),
            parent_session: None,
            rlm_depth: Some(0),
            git: None,
            rest: serde_json::Map::new(),
        };
        let line = serde_json::to_string(&session_header_line(&header)).unwrap();
        assert!(line.starts_with("{\"type\":\"session\",\"version\":3,\"id\":\"abc\""));
    }
}
