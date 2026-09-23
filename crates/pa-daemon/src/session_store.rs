//! Append-only session store on disk.
//!
//! Port of the session-file layout of `core/session-manager.ts`: one JSONL file
//! per session under `<agent-dir>/sessions/<uuid>.jsonl`, first line is the
//! `session` header, entries form a parent-id chain (tree). Layout compatibility
//! with the TS product is load-bearing: TUI reattach, checkpoint/resume, and
//! external tooling read the same files.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

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
    ) -> Self {
        SessionEntry {
            type_: type_.to_string(),
            id: new_entry_id(used),
            parent_id,
            timestamp: crate::util::now_iso(),
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

/// Read the first line of a session file and parse it as a header.
pub fn read_session_header(path: &Path) -> Option<SessionHeader> {
    let content = fs::read_to_string(path).ok()?;
    let first = content.lines().next()?;
    let value: Value = serde_json::from_str(first.trim()).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    serde_json::from_value(value).ok()
}

/// A session file is valid when its first line is a `session` header with an id.
pub fn is_valid_session_file(path: &Path) -> bool {
    read_session_header(path)
        .map(|header| !header.id.is_empty())
        .unwrap_or(false)
}

impl SessionFile {
    /// Load an existing session file. Errors when the header is missing/invalid.
    pub fn open(path: &Path) -> Result<Self> {
        let content = fs::read_to_string(path)
            .with_context(|| format!("read session file {}", path.display()))?;
        let mut lines = content.lines().filter(|l| !l.trim().is_empty());
        let first = lines
            .next()
            .ok_or_else(|| anyhow!("empty session file {}", path.display()))?;
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
        };
        for line in lines {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<SessionEntry>(trimmed) {
                Ok(entry) => file.push_index(entry),
                // Malformed lines are skipped, matching the TS loader.
                Err(_) => continue,
            }
        }
        Ok(file)
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
        }
    }

    fn push_index(&mut self, entry: SessionEntry) {
        self.by_id.insert(entry.id.clone(), self.entries.len());
        self.leaf_id = Some(entry.id.clone());
        self.entries.push(entry);
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

    /// Walk the leaf-to-root entry path (the active branch).
    pub fn branch(&self) -> Vec<&SessionEntry> {
        let mut path = Vec::new();
        let mut current = self.leaf_id.as_deref().and_then(|id| self.entry(id));
        while let Some(entry) = current {
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
                None if entry.parent_id.is_some() => (position > 0).then_some(position - 1),
                None => None,
            };
        }
        positions.reverse();
        positions
            .into_iter()
            .map(|position| &self.entries[position])
            .collect()
    }

    /// Session name from the latest `session_info` entry.
    pub fn session_name(&self) -> Option<&str> {
        self.entries()
            .iter()
            .rev()
            .find(|entry| entry.type_ == "session_info")
            .and_then(|entry| entry.fields.get("name"))
            .and_then(Value::as_str)
            .map(|name| name.trim())
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
        self.entries.iter().filter(|e| e.type_ == "message").count()
    }

    pub fn first_message(&self) -> Option<String> {
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
        let entry = SessionEntry::new(type_, parent_id, &self.index_map(), fields);
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
    pub fn rewrite(&self) -> Result<()> {
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
    pub fn persist_entry(&mut self, entry_type: &str, fields: Value) -> Result<String> {
        let entry = SessionEntry::new(entry_type, self.leaf_id.clone(), &self.index_map(), fields);
        let id = entry.id.clone();
        if !self.path.as_os_str().is_empty() && self.path.exists() {
            let file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)
                .with_context(|| format!("append to {}", self.path.display()))?;
            let mut writer = std::io::BufWriter::new(file);
            write_line(&mut writer, &entry)?;
            writer.flush()?;
            // The line is in the file now: index it before the durability
            // barrier so the in-memory leaf matches what a reload sees.
            self.push_index(entry);
            writer.get_ref().sync_data()?;
        } else {
            // The rewrite path serializes the whole index, so the entry must
            // be indexed first; a failed rewrite rolls the index back.
            let previous_leaf = self.leaf_id.clone();
            self.push_index(entry);
            if let Err(error) = self.rewrite() {
                self.by_id.remove(&id);
                self.entries.pop();
                self.leaf_id = previous_leaf;
                return Err(error);
            }
        }
        Ok(id)
    }

    /// Point the session at a concrete file path (after `create`), preserving entries.
    pub fn set_path(&mut self, path: PathBuf) {
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
#[derive(Debug, Clone)]
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
    /// The latest `agent_status` recap (`summary` is searchable).
    pub agent_status: Option<Value>,
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

pub fn read_session_info(path: &Path) -> Option<SessionInfo> {
    let content = fs::read_to_string(path).ok()?;
    let mut header: Option<SessionHeader> = None;
    let mut name = None;
    let mut state = None;
    let mut model = None;
    let mut thinking_level = None;
    let mut message_count = 0usize;
    let mut first_message = String::new();
    let mut all_messages_text = String::new();
    let mut agent_status: Option<Value> = None;
    let mut last_activity_ms: Option<u64> = None;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<SessionEntry>(trimmed) else {
            continue;
        };
        match entry.type_.as_str() {
            "session" => {
                let parsed: SessionHeader = serde_json::from_str(trimmed).ok()?;
                header = Some(parsed);
            }
            "session_info" => {
                name = entry
                    .fields
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|n| !n.is_empty())
                    .map(str::to_string)
            }
            "session_state" => {
                if let Some(status) = entry
                    .fields
                    .get("state")
                    .and_then(|s| s.get("status"))
                    .and_then(Value::as_str)
                {
                    state = Some(normalize_state_status(status));
                }
            }
            "model_change" => {
                model = Some((
                    entry.fields.get("provider")?.as_str()?.to_string(),
                    entry.fields.get("modelId")?.as_str()?.to_string(),
                ));
            }
            // The last persisted level wins, like `model_change`: a later
            // `set_thinking_level` overwrites the creation prefix.
            "thinking_level_change" => {
                if let Some(level) = entry
                    .fields
                    .get("thinkingLevel")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|level| !level.is_empty())
                {
                    thinking_level = Some(level.to_string());
                }
            }
            // Keep the latest recap/verdict (TS `agent_status` fold): the
            // `summary` text is part of the agents-view search corpus.
            "agent_status" => {
                agent_status = entry.fields.get("status").cloned();
            }
            "message" => {
                message_count += 1;
                if let Some(message) = entry.fields.get("message") {
                    let role = message_role(message);
                    if role == Some("assistant") {
                        if let (Some(provider), Some(model_id)) = (
                            message.get("provider").and_then(Value::as_str),
                            message.get("model").and_then(Value::as_str),
                        ) {
                            model = Some((provider.to_string(), model_id.to_string()));
                        }
                    }
                    if matches!(role, Some("user" | "assistant")) {
                        if let Some(timestamp) = message.get("timestamp").and_then(Value::as_u64) {
                            last_activity_ms = Some(last_activity_ms.unwrap_or(0).max(timestamp));
                        }
                    }
                    if role == Some("user") && first_message.is_empty() {
                        let text = message_text(message);
                        if !text.is_empty() {
                            first_message = text;
                        }
                    }
                    // TS `allMessagesText`: user and assistant text
                    // content feeds the full-transcript search.
                    if matches!(role, Some("user" | "assistant")) {
                        let text = message_text(message);
                        append_capped_search_text(&mut all_messages_text, &text);
                    }
                }
            }
            _ => {}
        }
    }
    let header = header?;
    let modified_ms = last_activity_ms.unwrap_or(0);
    let modified = if modified_ms > 0 {
        crate::util::iso_from_unix_ms(modified_ms)
    } else {
        crate::util::iso_from_unix_ms(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        )
    };
    Some(SessionInfo {
        path: path.to_path_buf(),
        id: header.id,
        cwd: header.cwd,
        name,
        state,
        model,
        thinking_level,
        parent_session_path: header.parent_session,
        rlm_depth: header.rlm_depth.unwrap_or(0) as u32,
        created: header.timestamp,
        modified,
        message_count,
        first_message: if first_message.is_empty() {
            "(no messages)".to_string()
        } else {
            first_message
        },
        all_messages_text,
        agent_status,
    })
}

/// List every valid session file in a directory, most recently modified first
/// (port of `SessionManager.listAll`).
pub fn list_sessions(session_dir: &Path) -> Vec<SessionInfo> {
    let Ok(read) = fs::read_dir(session_dir) else {
        return Vec::new();
    };
    let mut infos: Vec<(SessionInfo, std::time::SystemTime)> = read
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .filter_map(|path| {
            let modified = fs::metadata(&path).and_then(|m| m.modified()).ok()?;
            read_session_info(&path).map(|info| (info, modified))
        })
        .collect();
    infos.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));
    infos.into_iter().map(|(info, _)| info).collect()
}

/// Most recent valid session for a cwd (port of `findMostRecentSessionForCwd`).
pub fn find_most_recent_session_for_cwd(session_dir: &Path, cwd: &str) -> Option<PathBuf> {
    list_sessions(session_dir)
        .into_iter()
        .find(|info| {
            !info.cwd.is_empty()
                && Path::new(&info.cwd)
                    .canonicalize()
                    .map(|p| {
                        p == Path::new(cwd)
                            .canonicalize()
                            .unwrap_or_else(|_| PathBuf::from(cwd))
                    })
                    .unwrap_or_else(|_| info.cwd == cwd)
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
        .map(|value| value.to_string())
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
        .map(|value| value.to_string())
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
        .map(|value| value.to_string())
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
    fn scan_builds_transcript_search_text_and_latest_agent_status() {
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
        session.append_entry(
            "agent_status",
            json!({
                "status": { "summary": "first recap", "basedOnMessageCount": 1 }
            }),
        );
        session.append_entry(
            "agent_status",
            json!({
                "status": { "summary": "login fix landed", "basedOnMessageCount": 2 }
            }),
        );
        session.rewrite().unwrap();

        let info = read_session_info(&path).unwrap();
        assert_eq!(info.all_messages_text, "fix the login bug fixed in auth.rs");
        assert_eq!(
            info.agent_status,
            Some(json!({
                "summary": "login fix landed", "basedOnMessageCount": 2
            }))
        );
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
