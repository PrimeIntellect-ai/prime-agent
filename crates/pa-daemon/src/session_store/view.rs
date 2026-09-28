//! The loaded-session view (moved with its concern): the branch walks,
//! the window/settings reads, the compacted message fold and its scalars,
//! and the wire-shape message helpers.

use super::{MessageWindowScalars, SessionEntry, SessionFile, Value, index, json, read, view};

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

impl SessionFile {
    #[must_use]
    pub fn entries(&self) -> &[SessionEntry] {
        &self.entries
    }

    #[must_use]
    pub fn entry(&self, id: &str) -> Option<&SessionEntry> {
        self.by_id.get(id).map(|&index| &self.entries[index])
    }

    #[must_use]
    pub fn leaf_id(&self) -> Option<&str> {
        self.leaf_id.as_deref()
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.header.id
    }

    /// The header's RLM depth (TS `sessionManager.getHeader()?.rlmDepth`):
    /// a resumed session inherits its persisted depth when the create
    /// payload does not carry one (TS `config.rlmDepth ?? header.rlmDepth`).
    #[must_use]
    pub fn rlm_depth(&self) -> Option<u32> {
        self.header
            .rlm_depth
            .and_then(|depth| u32::try_from(depth).ok())
    }

    /// Walk the leaf-to-root entry path (the active branch). A corrupt
    /// file can hold a parent cycle; the walk must terminate anyway (the
    /// same guard `build_session_context` has).
    #[must_use]
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
    #[must_use]
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
    #[must_use]
    pub fn messages(&self) -> Vec<Value> {
        let mut messages = Vec::new();
        self.walk_message_values(|message| messages.push(message.into_owned()));
        messages
    }

    /// The summary scalars the TS `summaryForActiveSession` fold derives
    /// from the windowed message sequence — the newest message timestamp
    /// (the last message in fold order that carries one, matching the
    /// fold's reverse scan), the summed assistant usage, and the window's
    /// message count — without materializing the transcript. One borrowed
    /// walk of the same sequence [`Self::messages`] folds, so the scan can
    /// never disagree with the materialized fold.
    #[must_use]
    pub fn scan_message_scalars(&self) -> MessageWindowScalars {
        let mut scalars = MessageWindowScalars::default();
        self.walk_message_values(|message| {
            scalars.message_count += 1;
            if let Some(timestamp) = crate::types::message_timestamp_ms(&message) {
                scalars.last_timestamp_ms = Some(timestamp);
            }
            if crate::types::message_role(&message) == Some("assistant") {
                if let Some(usage) = message.get("usage") {
                    scalars.input_tokens += usage
                        .get("input")
                        .and_then(Value::as_u64)
                        .unwrap_or_default();
                    scalars.input_tokens += usage
                        .get("cacheRead")
                        .and_then(Value::as_u64)
                        .unwrap_or_default();
                    scalars.input_tokens += usage
                        .get("cacheWrite")
                        .and_then(Value::as_u64)
                        .unwrap_or_default();
                    scalars.output_tokens += usage
                        .get("output")
                        .and_then(Value::as_u64)
                        .unwrap_or_default();
                    scalars.cost += usage
                        .get("cost")
                        .and_then(|cost| cost.get("total"))
                        .and_then(Value::as_f64)
                        .unwrap_or_default();
                }
            }
        });
        scalars
    }

    /// The windowed message sequence behind [`Self::messages`]: `message`
    /// rows borrow their persisted message; `custom_message` rows rejoin as
    /// their wire message form (`role: "custom"`), the shape TS sessions
    /// keep in `agent.state.messages`; a compaction window prepends its
    /// summary message and keeps `firstKeptEntryId` onward (the id is only
    /// recognized on a message-bearing row, matching the fold), then
    /// everything appended after the compaction. Every consumer — the
    /// materialized fold and the scalar scan — derives from this one walk,
    /// so the two can never disagree on the sequence.
    fn walk_message_values<'a>(&'a self, mut visit: impl FnMut(std::borrow::Cow<'a, Value>)) {
        let entry_message = |entry: &'a SessionEntry| -> Option<std::borrow::Cow<'a, Value>> {
            match entry.type_.as_str() {
                "message" => entry.fields.get("message").map(std::borrow::Cow::Borrowed),
                "custom_message" => {
                    let mut message = entry.fields.clone();
                    if let Some(object) = message.as_object_mut() {
                        object.insert("role".to_string(), Value::String("custom".to_string()));
                        object.insert(
                            "timestamp".to_string(),
                            Value::String(entry.timestamp.clone()),
                        );
                    }
                    Some(std::borrow::Cow::Owned(message))
                }
                _ => None,
            }
        };
        let branch = self.branch();
        let Some(compaction_position) =
            branch.iter().rposition(|entry| entry.type_ == "compaction")
        else {
            for entry in &branch {
                if let Some(message) = entry_message(entry) {
                    visit(message);
                }
            }
            return;
        };
        let compaction = branch[compaction_position];
        let first_kept_entry_id = compaction
            .fields
            .get("firstKeptEntryId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        // Counting pass: the compaction summary message carries the retained
        // count, so the kept prefix is counted before anything is visited.
        // The bearing check borrows only — no message is materialized here.
        let mut keeping = false;
        let mut retained_count = 0usize;
        for entry in &branch[..compaction_position] {
            if !entry_bears_message(entry) {
                continue;
            }
            if !keeping && entry.id == first_kept_entry_id {
                keeping = true;
            }
            if keeping {
                retained_count += 1;
            }
        }
        visit(std::borrow::Cow::Owned(compaction_summary_message(
            compaction,
            retained_count,
        )));
        let mut keeping = false;
        for entry in &branch[..compaction_position] {
            if !entry_bears_message(entry) {
                continue;
            }
            if !keeping && entry.id == first_kept_entry_id {
                keeping = true;
            }
            if keeping {
                if let Some(message) = entry_message(entry) {
                    visit(message);
                }
            }
        }
        for entry in &branch[compaction_position + 1..] {
            if let Some(message) = entry_message(entry) {
                visit(message);
            }
        }
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

    #[must_use]
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
    #[must_use]
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
}

pub(super) fn message_role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

/// The `compactionSummary` message a compaction fold starts with (TS
/// `createCompactionSummaryMessage`).
/// Whether one entry contributes a message to the windowed fold: `message`
/// rows need their persisted message; `custom_message` rows always rejoin as
/// their wire form. The borrowing twin of the `entry_message` Some-ness, so
/// counting and keeping walks never materialize what they only classify.
fn entry_bears_message(entry: &SessionEntry) -> bool {
    match entry.type_.as_str() {
        "message" => entry.fields.get("message").is_some(),
        "custom_message" => true,
        _ => false,
    }
}

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
        if let Some(harness_state_fingerprint) = entry.fields.get("harnessStateFingerprint") {
            message["harnessStateFingerprint"] = harness_state_fingerprint.clone();
        }
    }
    message["timestamp"] = json!(timestamp);
    message
}

pub(super) fn message_text(message: &Value) -> String {
    crate::types::message_text(message)
}

pub(super) fn normalize_state_status(status: &str) -> String {
    match status {
        "hidden" | "sleep" => "archived".to_string(),
        other => other.to_string(),
    }
}
