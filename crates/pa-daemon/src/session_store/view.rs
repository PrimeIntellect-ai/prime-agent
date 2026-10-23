//! The loaded-session view: the branch walks, the window/settings reads, the
//! compacted message fold and its scalars, and the wire-shape message helpers.

use super::{json, MessageWindowScalars, SessionEntry, SessionFile, TranscriptPageRows, Value};
use pa_types::daemon::TranscriptPage;

/// One display-transcript row: its entry id and wire message.
type DisplayRow<'a> = (&'a str, std::borrow::Cow<'a, Value>);

#[cfg(test)]
thread_local! {
    /// Steps the branch walk and the ancestor lookup took on this thread (the page-cost pin).
    pub(super) static CHAIN_STEPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
#[path = "page_walk_tests.rs"]
mod page_walk_tests;

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

    /// Walk the leaf-to-root entry path (the active branch), root first.
    #[must_use]
    pub fn branch(&self) -> Vec<&SessionEntry> {
        let mut path: Vec<&SessionEntry> = self
            .walk_back(self.branch_leaf())
            .map(|position| &self.entries[position])
            .collect();
        path.reverse();
        path
    }

    /// Whether a windowed store's branch walk stops at `position`: a loaded row
    /// outside the retained window.
    fn window_excludes(&self, position: usize) -> bool {
        self.window.as_ref().is_some_and(|window| {
            position < window.loaded_entries
                && !window.retained_ids.contains(&self.entries[position].id)
        })
    }

    /// The active branch's newest position.
    fn branch_leaf(&self) -> Option<usize> {
        self.leaf_id
            .as_deref()
            .and_then(|id| self.by_id.get(id).copied())
            .filter(|&position| !self.window_excludes(position))
    }

    /// The branch walk's one step: the parent, unless it starts a new chain or the window
    /// excludes it.
    fn branch_parent(&self, position: usize) -> Option<usize> {
        #[cfg(test)]
        CHAIN_STEPS.with(|steps| steps.set(steps.get() + 1));
        self.chain[position]
            .parent()
            .filter(|&parent| !self.window_excludes(parent))
    }

    /// Branch positions from `from` back to the branch start, newest first.
    fn walk_back(&self, from: Option<usize>) -> impl Iterator<Item = usize> + '_ {
        std::iter::successors(from, move |&position| self.branch_parent(position))
    }

    /// Branch positions after `after` (exclusive; the branch start when `None`) through
    /// `last`, oldest first. `after` must be an ancestor of `last`. Reads `last`'s
    /// ancestors in chunks of doubling size, so the cost follows the rows consumed.
    fn walk_forward(&self, after: Option<usize>, last: usize) -> impl Iterator<Item = usize> + '_ {
        let top = self.chain[last].depth();
        let mut low = after.map_or(0, |after| self.chain[after].depth() + 1);
        let mut chunk = 64;
        std::iter::from_fn(move || {
            if low > top {
                return None;
            }
            let high = top.min(low + chunk - 1);
            let start = Some(self.ancestor_at(last, high))
                .filter(|&position| !self.window_excludes(position));
            let mut positions: Vec<usize> = self.walk_back(start).take(high + 1 - low).collect();
            positions.reverse();
            low = high + 1;
            chunk *= 2;
            Some(positions)
        })
        .flatten()
    }

    /// Whether `position` is on the active branch: the leaf's ancestor at its depth. A
    /// window's excluded rows precede every row it keeps, and parents precede children,
    /// so no excluded row sits between a kept row and the leaf.
    fn on_branch(&self, position: usize) -> bool {
        self.branch_leaf().is_some_and(|leaf| {
            let depth = self.chain[position].depth();
            depth <= self.chain[leaf].depth()
                && self.ancestor_at(leaf, depth) == position
                && !self.window_excludes(position)
        })
    }

    /// Whether entry `id` is on the active branch.
    #[must_use]
    pub fn branch_contains(&self, id: &str) -> bool {
        self.by_id
            .get(id)
            .is_some_and(|&position| self.on_branch(position))
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
        self.walk_message_values(|message| {
            messages.push(message.into_owned());
            true
        });
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
            true
        });
        scalars
    }

    /// The model-context message sequence behind [`Self::messages`] (`custom_message`
    /// rows rejoin as their wire form, `role: "custom"`; a compaction window
    /// prepends its summary message).
    fn walk_message_values<'a>(
        &'a self,
        mut visit: impl FnMut(std::borrow::Cow<'a, Value>) -> bool,
    ) {
        let branch = self.branch();
        let Some(compaction_position) =
            branch.iter().rposition(|entry| entry.type_ == "compaction")
        else {
            for entry in &branch {
                if let Some(message) = entry_message(entry) {
                    if !visit(message) {
                        return;
                    }
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
            // The durable cut can name bookkeeping, not just a message row.
            if !keeping && entry.id == first_kept_entry_id {
                keeping = true;
            }
            if !entry_bears_message(entry) {
                continue;
            }
            if keeping {
                retained_count += 1;
            }
        }
        let summary =
            std::borrow::Cow::Owned(compaction_summary_message(compaction, Some(retained_count)));
        if !visit(summary) {
            return;
        }
        let mut keeping = false;
        for entry in &branch[..compaction_position] {
            // The durable cut can name bookkeeping, not just a message row.
            if !keeping && entry.id == first_kept_entry_id {
                keeping = true;
            }
            if keeping {
                if let Some(message) = entry_message(entry) {
                    if !visit(message) {
                        return;
                    }
                }
            }
        }
        for entry in &branch[compaction_position + 1..] {
            if let Some(message) = entry_message(entry) {
                if !visit(message) {
                    return;
                }
            }
        }
    }

    /// One display-transcript row: a message-bearing entry, or a compaction as its summary
    /// row in place, so every entry shows once.
    fn display_row(&self, position: usize) -> Option<DisplayRow<'_>> {
        let entry = &self.entries[position];
        let message = if entry.type_ == "compaction" {
            std::borrow::Cow::Owned(compaction_summary_message(entry, None))
        } else {
            entry_message(entry)?
        };
        Some((entry.id.as_str(), message))
    }

    /// The position of page anchor `id`: a display row on the active branch.
    fn display_anchor(&self, id: &str) -> Option<usize> {
        let position = *self.by_id.get(id)?;
        let entry = &self.entries[position];
        ((entry.type_ == "compaction" || entry_bears_message(entry)) && self.on_branch(position))
            .then_some(position)
    }

    /// One page of the display transcript; `None` when an anchor row is not on the branch.
    /// The page walks from its anchor, so its cost follows the page, not the session.
    #[must_use]
    pub fn transcript_page(&self, page: &TranscriptPage) -> Option<TranscriptPageRows> {
        let (rows, more) = match page {
            TranscriptPage::End { before, limit } => self.end_page(before.as_deref(), *limit)?,
            TranscriptPage::Start {
                after,
                until,
                limit,
            } => self.start_page(after.as_deref(), until.as_deref(), *limit)?,
        };
        Some(TranscriptPageRows {
            first_entry_id: rows.first().map(|(id, _)| (*id).to_string()),
            last_entry_id: rows.last().map(|(id, _)| (*id).to_string()),
            messages: rows
                .into_iter()
                .map(|(_, message)| message.into_owned())
                .collect(),
            more,
        })
    }

    /// The newest `limit` rows before the `before` row (the tail without it).
    fn end_page(&self, before: Option<&str>, limit: usize) -> Option<(Vec<DisplayRow<'_>>, bool)> {
        let before = before.map_or(Some(None), |id| self.display_anchor(id).map(Some))?;
        let from = match before {
            Some(position) => self.branch_parent(position),
            None => self.branch_leaf(),
        };
        let mut older = self
            .walk_back(from)
            .filter_map(|position| self.display_row(position));
        // Newest first: the `before` row, the page, the run that moves its cut back,
        // then the rows the cut's tool calls may pair with.
        let mut slice: Vec<DisplayRow<'_>> = before
            .and_then(|position| self.display_row(position))
            .into_iter()
            .collect();
        slice.extend(older.by_ref().take(limit));
        while slice
            .last()
            .is_some_and(|(_, message)| continues_run(message))
        {
            let Some(row) = older.next() else {
                break;
            };
            slice.push(row);
        }
        let from_cut = slice.len();
        slice.extend(older.by_ref().take(limit));
        slice.reverse();
        let end = slice.len() - usize::from(before.is_some());
        let start = settle_cut(&slice, slice.len() - from_cut);
        // A windowed store's unloaded prefix is older history too.
        let more = start > 0 || self.window.is_some() || older.next().is_some();
        slice.truncate(end);
        slice.drain(..start);
        Some((slice, more))
    }

    /// The oldest `limit` rows after the `after` row (the head without it), stopping
    /// before the `until` row.
    fn start_page(
        &self,
        after: Option<&str>,
        until: Option<&str>,
        limit: usize,
    ) -> Option<(Vec<DisplayRow<'_>>, bool)> {
        let until = until.map_or(Some(None), |id| self.display_anchor(id).map(Some))?;
        let after = after.map_or(Some(None), |id| self.display_anchor(id).map(Some))?;
        let Some(last) = until.or_else(|| self.branch_leaf()) else {
            return Some((Vec::new(), false));
        };
        // The page, then up to `limit` rows past it (through the `until` row) for pairing.
        let mut newer = self
            .walk_forward(after, last)
            .filter_map(|position| Some((position, self.display_row(position)?)));
        let rows: Vec<(usize, DisplayRow<'_>)> = newer
            .by_ref()
            .take(limit.saturating_mul(2).saturating_add(1))
            .collect();
        let reached_until = rows
            .last()
            .is_some_and(|(position, _)| Some(*position) == until);
        let available = rows.len() - usize::from(reached_until);
        let mut rows: Vec<DisplayRow<'_>> = rows.into_iter().map(|(_, row)| row).collect();
        if available <= limit {
            rows.truncate(available);
            return Some((rows, false));
        }
        if limit == 0 {
            return Some((Vec::new(), true));
        }
        // The `limit` rows before the page, for calls whose results the cut would split.
        let mut slice: Vec<DisplayRow<'_>> = self
            .walk_back(after)
            .filter_map(|position| self.display_row(position))
            .take(limit)
            .collect();
        slice.reverse();
        let page_start = slice.len();
        slice.append(&mut rows);
        let cut = settle_cut(&slice, page_start + limit);
        let mut page = slice.split_off(page_start);
        if cut > page_start {
            page.truncate(cut - page_start);
            return Some((page, true));
        }
        // The cut fell back to the page start: the page runs to the `until` row.
        page.extend(newer.map(|(_, row)| row));
        if until.is_some() {
            page.pop();
        }
        Some((page, false))
    }

    /// The newest user prompt's time on the branch (the attach snapshot's marker); the walk
    /// reaches back only as far as that prompt.
    #[must_use]
    pub fn last_user_prompt_ms(&self) -> Option<u64> {
        self.walk_back(self.branch_leaf())
            .find_map(|position| {
                let entry = &self.entries[position];
                (entry.type_ == "message")
                    .then(|| entry.fields.get("message"))
                    .flatten()
                    .filter(|message| message_role(message) == Some("user"))
            })
            .and_then(prompt_timestamp_ms)
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

    /// The session's persisted tool calls on the ACTIVE BRANCH (gap-bridged,
    /// the same chain the usage accounting walks): `toolCall` blocks on
    /// assistant messages, the window's folded prefix included (the
    /// summary's `toolUseCount` seed; TS counts a child's assistant tool
    /// calls over the active chain).
    #[must_use]
    pub fn tool_call_count(&self) -> u64 {
        let older = self
            .window
            .as_ref()
            .map_or(0, |window| window.older_path_stats.tool_calls);
        older
            + self
                .branch_bridged()
                .iter()
                .filter(|entry| entry.type_ == "message")
                .filter_map(|entry| entry.fields.get("message"))
                .filter(|message| message_role(message) == Some("assistant"))
                .map(crate::session_stats::tool_call_count)
                .sum::<u64>()
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

/// A row's wire message (`custom_message` rows rejoin as `role: "custom"`).
fn entry_message(entry: &SessionEntry) -> Option<std::borrow::Cow<'_, Value>> {
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
}

/// A user prompt's wall-clock time, mirroring the TUI's numeric/ISO timestamp contract.
fn prompt_timestamp_ms(message: &Value) -> Option<u64> {
    match message.get("timestamp") {
        Some(Value::Number(number)) => number.as_u64().or_else(|| {
            number
                .as_f64()
                .filter(|value| value.is_finite())
                .map(|value| value.max(0.0) as u64)
        }),
        Some(Value::String(iso)) => pa_types::incident::timestamp_to_ms(iso)
            .filter(|ms| *ms > 0)
            .map(|ms| ms as u64),
        _ => None,
    }
}

/// Whether a row continues the run before it: a page never starts at one.
fn continues_run(message: &Value) -> bool {
    matches!(message_role(message), Some("toolResult" | "custom"))
}

/// Move a page boundary earlier until the page below it starts at neither a tool
/// result nor a custom row, and no tool call is split from its result.
///
/// `rows` is a local slice of the branch around the cut, not the whole branch: the
/// page, the run before its first row, and up to `limit` rows past each side, the
/// side toward the request's other anchor stopping at that anchor row. Calls pair
/// with results only inside the slice, so a call more than a page from its result
/// does not move the cut (else an orphan or aborted call drags every page to the root).
fn settle_cut(rows: &[DisplayRow<'_>], mut cut: usize) -> usize {
    while cut > 0 && cut < rows.len() && continues_run(&rows[cut].1) {
        cut -= 1;
    }
    // User bash and other message rows can land between a call and its
    // result. Match the same last-pending call as transcript replay, then
    // move only across pairs intersecting the cut. Reverse result order
    // also catches an earlier pair exposed by moving the boundary back.
    let mut pending: std::collections::HashMap<&str, Vec<usize>> = std::collections::HashMap::new();
    let mut pairs = Vec::new();
    for (index, (_, message)) in rows.iter().enumerate() {
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => {
                if let Some(content) = message.get("content").and_then(Value::as_array) {
                    for block in content {
                        if let Some(id) = block.get("id").and_then(Value::as_str).filter(|_| {
                            block.get("type").and_then(Value::as_str) == Some("toolCall")
                        }) {
                            pending.entry(id).or_default().push(index);
                        }
                    }
                }
            }
            Some("toolResult") => {
                if let Some(call) = message
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .and_then(|id| pending.get_mut(id))
                    .and_then(Vec::pop)
                {
                    pairs.push((call, index));
                }
            }
            _ => {}
        }
    }
    for (call, result) in pairs.into_iter().rev() {
        if call < cut && result >= cut {
            cut = call;
        }
    }
    cut
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

/// The `compactionSummary` message of a compaction entry; the context walk's
/// copy carries its retained count.
fn compaction_summary_message(entry: &SessionEntry, retained_count: Option<usize>) -> Value {
    let timestamp = crate::util::iso_to_unix_ms(&entry.timestamp).unwrap_or(0);
    // The TS `compactionSummary` key order: role, summary, tokensBefore,
    // retainedMessageCount, customInstructions?, harnessDigest?, timestamp —
    // optional keys insert before `timestamp`.
    let mut message = json!({
        "role": "compactionSummary",
        "summary": entry.fields.get("summary").cloned().unwrap_or_default(),
        "tokensBefore": entry.fields.get("tokensBefore").cloned().unwrap_or(json!(0)),
    });
    if let Some(retained_count) = retained_count {
        message["retainedMessageCount"] = json!(retained_count as u64);
    }
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
