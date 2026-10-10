//! The loaded-session view: the branch walks, the window/settings reads, the
//! compacted message fold and its scalars, and the wire-shape message helpers.

use super::{json, MessageWindowScalars, SessionEntry, SessionFile, Value};

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

/// Whether `entry` is the session's Anthropic subscription warning shown
/// marker: a `custom` row carrying
/// [`pa_core::session::ANTHROPIC_WARNING_SHOWN_CUSTOM_TYPE`] with
/// `data.shown == true` (the once-per-session-lifecycle gate's persisted
/// state, written by [`SessionFile::mark_anthropic_warning_shown`]).
pub(crate) fn is_warning_shown_row(entry: &SessionEntry) -> bool {
    entry.type_ == "custom"
        && entry.fields.get("customType").and_then(Value::as_str)
            == Some(pa_core::session::ANTHROPIC_WARNING_SHOWN_CUSTOM_TYPE)
        && entry
            .fields
            .get("data")
            .and_then(|data| data.get("shown"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

impl SessionFile {
    /// Whether this session has already drawn the Anthropic subscription
    /// ban-risk warning (the once-per-session-lifecycle gate): hydrated from
    /// the persisted marker row at open, flipped by
    /// [`SessionFile::mark_anthropic_warning_shown`]; `get_state` serves it
    /// as `SessionSummary::anthropic_warning_shown`.
    #[must_use]
    pub fn anthropic_warning_shown(&self) -> bool {
        self.anthropic_warning_shown
    }

    /// Re-hydrate the warning gate from the in-memory entries: the fork
    /// arms build their stores by ADOPTING copied rows (no file reopen),
    /// so the gate must agree with the rows the new store itself carries —
    /// a fork of a warned session answers its own file (the marker row
    /// rides the copied branch), not the source's live flag.
    pub(crate) fn hydrate_anthropic_warning_flag(&mut self) {
        // The active branch, exactly like the reopen paths: a marker on a
        // sibling row never flips the gate.
        self.anthropic_warning_shown = self.branch().iter().copied().any(is_warning_shown_row);
    }

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

    /// The header's RLM depth (TS `config.rlmDepth ?? header.rlmDepth`): a resumed
    /// session inherits its persisted depth when the create payload does not carry one.
    #[must_use]
    pub fn rlm_depth(&self) -> Option<u32> {
        self.header
            .rlm_depth
            .and_then(|depth| u32::try_from(depth).ok())
    }

    /// Walk the leaf-to-root entry path (the active branch). A corrupt file can
    /// hold a parent cycle; the walk must terminate anyway.
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

    /// The leaf-to-root walk with parent gaps bridged: a parent id minted but
    /// never persisted continues from the gap entry's file predecessor. The strict
    /// [`Self::branch`] stays the model-facing truth; this walk serves the usage
    /// accounting.
    #[must_use]
    pub fn branch_bridged(&self) -> Vec<&SessionEntry> {
        self.branch_bridged_positions()
            .into_iter()
            .map(|position| &self.entries[position])
            .collect()
    }

    /// [`Self::branch_bridged`] as file positions — the accounting walks restrict the chain
    /// by file position.
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
                // predecessor (the first entry has none, so the walk ends).
                None if entry.parent_id.is_some() => (position > 0).then(|| position - 1),
                None => None,
            };
        }
        positions.reverse();
        positions
    }

    /// The model in effect at the retained-window boundary (the newest
    /// `model_change` in the discarded prefix; `None` on a full-history load).
    pub(crate) fn window_boundary_model(&self) -> Option<(String, String)> {
        self.window.as_ref()?.boundary_model.clone()
    }

    pub(crate) fn restored_settings(&self) -> pa_core::session::SessionContext {
        if let Some(window) = &self.window {
            let mut context = pa_core::session::SessionContext {
                messages: Vec::new(),
                thinking_level: window.thinking_level.clone(),
                service_tier: window.service_tier,
                model: window.model.clone(),
            };
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
            context
        } else {
            let entries = self.branch_file_entries();
            pa_core::session::build_session_context(&entries, self.leaf_id())
        }
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

    /// The branch's conversation, compacted view first: a `compactionSummary`
    /// message, the retained messages from `firstKeptEntryId`, then everything
    /// appended after; without a compaction, the plain message list.
    #[must_use]
    pub fn messages(&self) -> Vec<Value> {
        let mut messages = Vec::new();
        self.walk_message_values(|message| messages.push(message.into_owned()));
        messages
    }

    /// The summary scalars — the newest message timestamp and the window's message
    /// count — without materializing the transcript: one borrowed walk.
    #[must_use]
    pub fn scan_message_scalars(&self) -> MessageWindowScalars {
        let mut scalars = MessageWindowScalars::default();
        self.walk_message_values(|message| {
            scalars.message_count += 1;
            if let Some(timestamp) = crate::types::message_timestamp_ms(&message) {
                scalars.last_timestamp_ms = Some(timestamp);
            }
        });
        scalars
    }

    /// The windowed message sequence behind [`Self::messages`] (`custom_message`
    /// rows rejoin as their wire form, `role: "custom"`; a compaction window
    /// prepends its summary message). Every consumer derives from this one walk.
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
        // Counting pass: the summary message carries the retained count, so the kept
        // prefix is counted before anything is visited (the bearing check borrows only).
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

    /// The durable entry id the compaction cut keeps: the engine's
    /// `firstKeptEntryId` references in-memory ids that never exist in the file —
    /// the re-cut pins the boundary the file read recognizes.
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

    /// True when the session holds user-meaningful persisted content: the
    /// default model/thinking/service-tier creation prefix is skipped.
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

/// Whether one entry contributes a message to the fold: `message` rows need
/// their persisted message; `custom_message` rows rejoin as their wire form.
/// The borrowing twin of the `entry_message` Some-ness.
fn entry_bears_message(entry: &SessionEntry) -> bool {
    match entry.type_.as_str() {
        "message" => entry.fields.get("message").is_some(),
        "custom_message" => true,
        _ => false,
    }
}

/// The `compactionSummary` message a compaction fold starts with.
fn compaction_summary_message(entry: &SessionEntry, retained_count: usize) -> Value {
    let timestamp = crate::util::iso_to_unix_ms(&entry.timestamp).unwrap_or(0);
    // The TS `compactionSummary` key order: role, summary, tokensBefore,
    // retainedMessageCount, customInstructions?, harnessDigest?, timestamp —
    // optional keys insert before `timestamp`.
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
