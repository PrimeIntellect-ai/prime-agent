//! Generation-certified active session windows. Cold reads scan metadata to root;
//! warm reads touch only the canonical header and the retained transcript suffix.
//! JSONL remains authoritative; historical consumers explicitly hydrate.
use std::collections::HashSet;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use super::window_cache::{self, Generation, Snapshot};
pub use super::window_cache::{append_cached, flush as flush_cache, AppendOwnership};
use pa_types::session::{FileEntry, SessionHeader};
use serde::{Deserialize, Serialize};

use super::{build_session_context, SessionContext};

const CHUNK_BYTES: usize = 64 * 1024;
/// Actual source read ranges and sidecar bytes for this open.
#[derive(Default, Clone, Debug)]
pub struct WindowReadStats {
    pub jsonl_bytes: u64,
    pub jsonl_ranges: Vec<(u64, u64)>,
    pub cache_bytes: u64,
    pub cache_hit: bool,
}

struct ReverseLines {
    file: std::fs::File,
    position: u64,
    pending: Vec<u8>,
    reads: WindowReadStats,
    line_start: u64,
}

impl ReverseLines {
    fn next(&mut self) -> io::Result<Option<Vec<u8>>> {
        let mut pieces = Vec::new();
        loop {
            if let Some(index) = self.pending.iter().rposition(|byte| *byte == b'\n') {
                let mut line = self.pending.split_off(index + 1);
                self.pending.pop();
                self.line_start = self.position + self.pending.len() as u64 + 1;
                for piece in pieces.into_iter().rev() {
                    line.extend(piece);
                }
                if !line.is_empty() {
                    return Ok(Some(line));
                }
                pieces = Vec::new();
                continue;
            }
            pieces.push(std::mem::take(&mut self.pending));
            if self.position == 0 {
                self.line_start = 0;
                let line: Vec<u8> = pieces.into_iter().rev().flatten().collect();
                return Ok((!line.is_empty()).then_some(line));
            }
            let count = self.position.min(CHUNK_BYTES as u64) as usize;
            self.position -= count as u64;
            self.file.seek(SeekFrom::Start(self.position))?;
            self.pending.resize(count, 0);
            self.file.read_exact(&mut self.pending)?;
            self.reads.jsonl_bytes += count as u64;
            self.reads.jsonl_ranges.push((self.position, count as u64));
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    #[serde(rename = "type")]
    kind: String,
    id: Option<String>,
    parent_id: Option<String>,
    message: Option<MessageMetadata>,
    custom_type: Option<String>,
}

#[derive(Deserialize)]
struct MessageMetadata {
    role: String,
    provider: Option<String>,
    model: Option<String>,
    usage: Option<serde_json::Value>,
    content: Option<MessageContentMetadata>,
}

enum MessageContentMetadata {
    Blocks(Vec<ContentMetadata>),
    Text,
}

impl<'de> Deserialize<'de> for MessageContentMetadata {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ContentVisitor;
        impl<'de> serde::de::Visitor<'de> for ContentVisitor {
            type Value = MessageContentMetadata;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("message text or content blocks")
            }
            fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(MessageContentMetadata::Text)
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Self::Value, A::Error> {
                let mut blocks = Vec::new();
                while let Some(block) = seq.next_element()? {
                    blocks.push(block);
                }
                Ok(MessageContentMetadata::Blocks(blocks))
            }
        }
        deserializer.deserialize_any(ContentVisitor)
    }
}

#[derive(Deserialize)]
struct ContentMetadata {
    #[serde(rename = "type")]
    kind: String,
}

/// Whole-branch accounting older than the retained suffix.
#[derive(Default, Clone, Debug, Serialize, Deserialize)]
pub struct WindowStats {
    pub total_messages: u64,
    pub user_messages: u64,
    pub assistant_messages: u64,
    pub tool_results: u64,
    pub tool_calls: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    #[serde(with = "super::window_cache::float_bits")]
    pub cost: f64,
}

/// An active compacted window plus verified settings from its older ancestry.
/// The underlying JSONL is never rewritten by this reader.
pub struct WindowedSessionStore {
    path: PathBuf,
    entries: Vec<FileEntry>,
    raw_entries: Vec<String>,
    metadata_entries: Vec<String>,
    message_count: usize,
    older_path_stats: WindowStats,
    first_user_message: Option<serde_json::Value>,
    leaf_id: String,
    settings: SessionContext,
    full: bool,
    snapshot: Snapshot,
    reads: WindowReadStats,
}

impl WindowedSessionStore {
    /// Return `None` for old schemas, torn rows, or ambiguous ancestry so callers
    /// can use their ordinary full reader. No size or message-count admission cap.
    pub fn open(path: &Path) -> io::Result<Option<Self>> {
        let mut file = std::fs::File::open(path)?;
        let generation = Generation::of(&file.metadata()?);
        let size = file.metadata()?.len();
        let mut reads = WindowReadStats::default();
        if let Some(snapshot) = window_cache::load(path, &file, &mut reads) {
            if let Some(store) = Self::from_snapshot(path, &mut file, snapshot, reads.clone())? {
                return Ok(Some(store));
            }
        }
        if size == 0 {
            return Ok(None);
        }
        // Appending to an unterminated row would merge two JSON records.
        // Let the ordinary repair/rewrite path handle this file instead.
        file.seek(SeekFrom::End(-1))?;
        let mut last = [0];
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            return Ok(None);
        }
        reads.jsonl_bytes += 1;
        reads.jsonl_ranges.push((size - 1, 1));
        let mut reader = ReverseLines {
            file,
            position: size,
            pending: Vec::new(),
            line_start: 0,
            reads,
        };
        let mut retained = Vec::new();
        let mut raw_entries = Vec::new();
        let mut metadata_entries = Vec::new();
        let mut message_count = 0;
        let mut older_path_stats = WindowStats::default();
        let mut older_costs = Vec::new();
        let mut first_user_line = None;
        let mut expected: Option<String> = None;
        let mut leaf_id = None;
        let mut first_kept = None;
        let mut found_boundary = false;
        let mut retained_start = 0;
        let mut compaction_count = 0;
        let mut non_bootstrap = false;
        let mut goal = None;
        let mut window_done = false;
        let mut seen = HashSet::new();
        let mut thinking = None;
        let mut tier = None;
        let mut model = None;
        let mut header = None;
        while let Some(line) = reader.next()? {
            let Ok(text) = std::str::from_utf8(&line) else {
                return Ok(None);
            };
            let Ok(meta) = serde_json::from_str::<Envelope>(text) else {
                return Ok(None);
            };
            if meta.kind == "session" {
                if reader.position != 0
                    || reader
                        .pending
                        .iter()
                        .any(|byte| !byte.is_ascii_whitespace())
                {
                    return Ok(None);
                }
                header = serde_json::from_slice::<FileEntry>(&line).ok();
                break;
            }
            if !matches!(
                meta.kind.as_str(),
                "model_change" | "thinking_level_change" | "service_tier_change"
            ) {
                non_bootstrap = true;
            }
            if meta.kind == "compaction" {
                compaction_count += 1;
            }
            if meta.kind == "message" {
                message_count += 1;
                if meta
                    .message
                    .as_ref()
                    .is_some_and(|message| message.role == "user")
                {
                    first_user_line = Some(line.clone());
                }
            } else if window_done
                && (matches!(
                    meta.kind.as_str(),
                    "session_info"
                        | "session_state"
                        | "agent_status"
                        | "git_state"
                        | "child_usage_attributed"
                ) || (meta.kind == "custom"
                    && meta.custom_type.as_deref()
                        == Some(crate::session_engine::refine::REFINEMENT_AUDIT_CUSTOM_TYPE)))
            {
                metadata_entries.push(
                    String::from_utf8(line.clone())
                        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?,
                );
            }
            let Some(id) = meta.id.as_deref() else {
                return Ok(None);
            };
            if !seen.insert(id.to_owned()) {
                return Ok(None);
            }
            if leaf_id.is_none() {
                leaf_id = Some(id.to_owned());
                expected = leaf_id.clone();
            }
            let on_path = expected.as_deref() == Some(id);
            if on_path {
                if window_done && meta.kind == "message" {
                    if let Some(message) = &meta.message {
                        older_path_stats.total_messages += 1;
                        match message.role.as_str() {
                            "user" => older_path_stats.user_messages += 1,
                            "toolResult" => older_path_stats.tool_results += 1,
                            "assistant" => {
                                older_path_stats.assistant_messages += 1;
                                if let Some(MessageContentMetadata::Blocks(blocks)) =
                                    &message.content
                                {
                                    older_path_stats.tool_calls += blocks
                                        .iter()
                                        .filter(|block| block.kind == "toolCall")
                                        .count()
                                        as u64;
                                }
                                if let Some(usage) = &message.usage {
                                    older_path_stats.input += usage
                                        .get("input")
                                        .and_then(serde_json::Value::as_u64)
                                        .unwrap_or_default();
                                    older_path_stats.output += usage
                                        .get("output")
                                        .and_then(serde_json::Value::as_u64)
                                        .unwrap_or_default();
                                    older_path_stats.cache_read += usage
                                        .get("cacheRead")
                                        .and_then(serde_json::Value::as_u64)
                                        .unwrap_or_default();
                                    older_path_stats.cache_write += usage
                                        .get("cacheWrite")
                                        .and_then(serde_json::Value::as_u64)
                                        .unwrap_or_default();
                                    older_costs.push(
                                        usage
                                            .get("cost")
                                            .and_then(|cost| cost.get("total"))
                                            .and_then(serde_json::Value::as_f64)
                                            .unwrap_or_default(),
                                    );
                                }
                            }
                            _ => {}
                        }
                    }
                }
                expected = meta.parent_id.clone();
                if let Some(message) = meta
                    .message
                    .as_ref()
                    .filter(|message| message.role == "assistant" && model.is_none())
                {
                    let (Some(provider), Some(name)) = (&message.provider, &message.model) else {
                        return Ok(None);
                    };
                    model = Some((provider.clone(), name.clone()));
                }
            }
            // Parse only retained bodies and sparse setting records from the
            // older ancestry. Serde ignores old content without allocating it.
            let entry = if !window_done
                || (on_path
                    && (matches!(
                        meta.kind.as_str(),
                        "model_change" | "thinking_level_change" | "service_tier_change"
                    ) || (goal.is_none()
                        && meta.custom_type.as_deref()
                            == Some(crate::goals::GOAL_STATE_CUSTOM_TYPE))))
            {
                match serde_json::from_slice::<FileEntry>(&line) {
                    Ok(entry) => Some(entry),
                    Err(_) => return Ok(None),
                }
            } else {
                None
            };
            if on_path {
                if goal.is_none() {
                    goal = entry.as_ref().and_then(valid_goal);
                }
                match entry.as_ref() {
                    Some(FileEntry::ThinkingLevelChange { payload, .. }) if thinking.is_none() => {
                        thinking = Some(payload.thinking_level.clone())
                    }
                    Some(FileEntry::ServiceTierChange { payload, .. }) if tier.is_none() => {
                        tier = Some(payload.service_tier)
                    }
                    Some(FileEntry::ModelChange { payload, .. }) if model.is_none() => {
                        model = Some((payload.provider.clone(), payload.model_id.clone()))
                    }
                    Some(FileEntry::Compaction { payload, .. }) if first_kept.is_none() => {
                        first_kept = Some(payload.first_kept_entry_id.clone())
                    }
                    _ => {}
                }
                if first_kept.as_deref() == Some(id) {
                    found_boundary = true;
                }
            }
            if !window_done {
                retained_start = reader.line_start;
                retained.push(entry.expect("window entries parsed"));
                raw_entries.push(
                    String::from_utf8(line)
                        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?,
                );
                window_done = found_boundary;
            }
        }
        let Some(FileEntry::Header {
            header: SessionHeader {
                version: Some(3), ..
            },
        }) = &header
        else {
            return Ok(None);
        };
        if expected.is_some() {
            return Ok(None);
        }
        retained.push(header.expect("header checked"));
        retained.reverse();
        raw_entries.reverse();
        metadata_entries.reverse();
        let retained_ids: HashSet<&str> = retained.iter().filter_map(FileEntry::id).collect();
        let mut latest = std::collections::HashMap::new();
        let mut keep = HashSet::new();
        for (index, row) in metadata_entries.iter().enumerate() {
            let value: serde_json::Value = serde_json::from_str(row)?;
            let kind = value["type"].as_str().unwrap_or("");
            match kind {
                "session_info" | "session_state" | "agent_status" | "git_state" => {
                    latest.insert(kind.to_owned(), index);
                }
                "child_usage_attributed"
                    if value["targetId"]
                        .as_str()
                        .is_some_and(|id| retained_ids.contains(id)) =>
                {
                    latest.insert(format!("attribution:{}", value["targetId"]), index);
                }
                // Every refinement audit stays: refinement_history() is a
                // complete list, not a latest-wins setting.
                "custom"
                    if value["customType"].as_str()
                        == Some(crate::session_engine::refine::REFINEMENT_AUDIT_CUSTOM_TYPE) =>
                {
                    keep.insert(index);
                }
                _ => {}
            }
        }
        keep.extend(latest.into_values());
        metadata_entries = metadata_entries
            .into_iter()
            .enumerate()
            .filter_map(|(index, row)| keep.contains(&index).then_some(row))
            .collect();
        older_path_stats.cost = older_costs
            .into_iter()
            .rev()
            .fold(0.0, |total, cost| total + cost);
        let first_user_message = first_user_line
            .and_then(|line| serde_json::from_slice::<serde_json::Value>(&line).ok())
            .and_then(|row| row.get("message").cloned());
        let thinking_present = thinking.is_some();
        let tier_present = tier.is_some();
        let Some(leaf_id) = leaf_id else {
            return Ok(None);
        };
        let snapshot = Snapshot {
            version: 3,
            generation: generation.clone(),
            header: serde_json::to_string(&retained[0])?,
            start: retained_start,
            leaf: leaf_id.clone(),
            thinking: thinking.clone().unwrap_or_else(|| "off".to_owned()),
            thinking_present,
            tier: tier.flatten(),
            tier_present,
            model: model.clone(),
            metadata: metadata_entries.clone(),
            message_count,
            compaction_count,
            stats: older_path_stats.clone(),
            first_user: first_user_message.clone(),
            goal,
            non_bootstrap,
        };
        if !generation.valid(&reader.file, path)? {
            return Ok(None);
        }
        // A disposable sidecar failure must never prevent opening the source.
        let _ = window_cache::save(path, &snapshot);
        apply_attributions(&mut retained, &metadata_entries);
        super::apply_child_usage_attributions(&mut retained);
        Ok(Some(Self {
            path: path.to_owned(),
            entries: retained,
            raw_entries,
            metadata_entries,
            message_count,
            older_path_stats,
            first_user_message,
            leaf_id,
            settings: SessionContext {
                messages: Vec::new(),
                thinking_level: thinking.unwrap_or_else(|| "off".to_owned()),
                service_tier: tier.flatten(),
                model,
            },
            full: false,
            snapshot,
            reads: reader.reads,
        }))
    }

    fn from_snapshot(
        path: &Path,
        file: &mut std::fs::File,
        snapshot: Snapshot,
        mut reads: WindowReadStats,
    ) -> io::Result<Option<Self>> {
        file.seek(SeekFrom::Start(0))?;
        let mut header = Vec::new();
        let mut byte = [0];
        while file.read(&mut byte)? != 0 {
            header.push(byte[0]);
            if byte[0] == b'\n' {
                break;
            }
        }
        reads.jsonl_bytes += header.len() as u64;
        reads.jsonl_ranges.push((0, header.len() as u64));
        let Ok(canonical) = serde_json::from_slice::<FileEntry>(&header) else {
            return Ok(None);
        };
        if serde_json::to_string(&canonical)? != snapshot.header
            || snapshot.start < header.len() as u64
            || snapshot.start > file.metadata()?.len()
        {
            return Ok(None);
        }
        file.seek(SeekFrom::Start(snapshot.start))?;
        let mut suffix = String::new();
        file.read_to_string(&mut suffix)?;
        reads.jsonl_bytes += suffix.len() as u64;
        reads
            .jsonl_ranges
            .push((snapshot.start, suffix.len() as u64));
        let raw_entries: Vec<String> = suffix
            .lines()
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect();
        let mut entries = vec![canonical];
        for line in &raw_entries {
            let Ok(entry) = serde_json::from_str::<FileEntry>(line) else {
                return Ok(None);
            };
            entries.push(entry);
        }
        if entries.last().and_then(FileEntry::id) != Some(snapshot.leaf.as_str())
            || !snapshot.generation.valid(file, path)?
        {
            return Ok(None);
        }
        apply_attributions(&mut entries, &snapshot.metadata);
        super::apply_child_usage_attributions(&mut entries);
        reads.cache_hit = true;
        Ok(Some(Self {
            path: path.to_owned(),
            entries,
            raw_entries,
            metadata_entries: snapshot.metadata.clone(),
            message_count: snapshot.message_count,
            older_path_stats: snapshot.stats.clone(),
            first_user_message: snapshot.first_user.clone(),
            leaf_id: snapshot.leaf.clone(),
            settings: SessionContext {
                messages: Vec::new(),
                thinking_level: snapshot.thinking.clone(),
                service_tier: snapshot.tier,
                model: snapshot.model.clone(),
            },
            full: false,
            snapshot,
            reads,
        }))
    }
    pub fn has_non_bootstrap_entries(&self) -> bool {
        self.snapshot.non_bootstrap
    }
    pub fn refinement_history(&self) -> Vec<crate::refinement::RefinementResult> {
        self.entries
            .iter()
            .cloned()
            .filter_map(|entry| {
                if let FileEntry::Custom { payload, .. } = entry {
                    if payload.custom_type == "prime-agent.refinement" {
                        return payload
                            .data
                            .and_then(|data| serde_json::from_value(data).ok());
                    }
                }
                None
            })
            .collect()
    }
    pub fn read_stats(&self) -> &WindowReadStats {
        &self.reads
    }
    pub fn compaction_count(&self) -> usize {
        self.snapshot.compaction_count
    }
    pub fn goal_state(&self) -> Option<&crate::goals::GoalState> {
        self.snapshot.goal.as_ref()
    }
    pub fn has_thinking_level(&self) -> bool {
        self.snapshot.thinking_present
    }
    pub fn has_service_tier(&self) -> bool {
        self.snapshot.tier_present
    }
    /// Fold a newly persisted linear entry without hydrating historical bodies.
    pub fn append_entry(&mut self, entry: FileEntry) {
        if let FileEntry::ChildUsageAttributed { payload, .. } = &entry {
            // The full reader folds attributions at parse time; a live append
            // must fold into the retained assistant copy too, or `context()`
            // serves stale usage until reopen.
            for retained in self.entries.iter_mut().rev() {
                if retained.id() == Some(payload.target_id.as_str()) {
                    if let FileEntry::Message {
                        message: pa_types::session::AgentMessage::Assistant(assistant),
                        ..
                    } = retained
                    {
                        assistant.usage = payload.aggregate_usage;
                    }
                    break;
                }
            }
        }
        update_snapshot(&mut self.snapshot, &entry);
        self.settings
            .thinking_level
            .clone_from(&self.snapshot.thinking);
        self.settings.service_tier = self.snapshot.tier;
        self.settings.model.clone_from(&self.snapshot.model);
        if let Some(id) = entry.id() {
            self.leaf_id = id.to_owned();
        }
        self.entries.push(entry);
    }

    /// Retained file-order entries, including the original header.
    pub fn entries(&self) -> &[FileEntry] {
        &self.entries
    }

    /// Original retained JSONL records, excluding the header. Preserves wire
    /// fields and map order for consumers with a separate raw entry type.
    pub fn raw_entries(&self) -> &[String] {
        &self.raw_entries
    }

    /// Older non-message records, in file order, for persisted metadata
    /// consumers. These are not a complete ancestor chain.
    pub fn metadata_entries(&self) -> &[String] {
        &self.metadata_entries
    }

    pub fn older_path_stats(&self) -> &WindowStats {
        &self.older_path_stats
    }

    pub fn message_count(&self) -> usize {
        self.message_count
    }

    pub fn first_user_message(&self) -> Option<&serde_json::Value> {
        self.first_user_message.as_ref()
    }

    pub fn leaf_id(&self) -> &str {
        &self.leaf_id
    }

    pub fn source_path(&self) -> &Path {
        &self.path
    }

    #[cfg(test)]
    pub fn is_full_history(&self) -> bool {
        self.full
    }

    /// Model context with settings resolved across the entire active ancestry.
    pub fn context(&self) -> SessionContext {
        let mut context = build_session_context(&self.entries, Some(&self.leaf_id));
        if !self.full {
            context
                .thinking_level
                .clone_from(&self.settings.thinking_level);
            context.service_tier = self.settings.service_tier;
            context.model.clone_from(&self.settings.model);
        }
        context
    }

    /// Hydrate off the async executor; I/O and task failures reach the caller.
    /// This store is read-only: disk appends are included, while the selected
    /// leaf remains pinned. Mutable stores must merge their own pending rows
    /// rather than replacing their state with this snapshot.
    pub async fn ensure_full_history(&mut self) -> anyhow::Result<()> {
        if self.full {
            return Ok(());
        }
        let path = self.path.clone();
        let entries = tokio::task::spawn_blocking(move || {
            std::fs::read_to_string(path).map(|text| super::parse_session_entries(&text))
        })
        .await??;
        self.entries = entries;
        self.full = true;
        Ok(())
    }
}

fn valid_goal(entry: &FileEntry) -> Option<crate::goals::GoalState> {
    let FileEntry::Custom { payload, .. } = entry else {
        return None;
    };
    let data = payload.data.as_ref()?;
    if payload.custom_type != crate::goals::GOAL_STATE_CUSTOM_TYPE
        || !crate::goals::is_persisted_goal_state(data)
    {
        return None;
    }
    serde_json::from_value(data.clone())
        .ok()
        .map(crate::goals::normalize_goal_state)
}
fn apply_attributions(entries: &mut [FileEntry], metadata: &[String]) {
    for row in metadata {
        if let Ok(FileEntry::ChildUsageAttributed { payload, .. }) = serde_json::from_str(row) {
            for entry in entries.iter_mut() {
                if entry.id() == Some(payload.target_id.as_str()) {
                    if let FileEntry::Message {
                        message: pa_types::session::AgentMessage::Assistant(message),
                        ..
                    } = entry
                    {
                        message.usage = payload.aggregate_usage;
                    }
                }
            }
        }
    }
}
pub(super) fn update_snapshot(snapshot: &mut Snapshot, entry: &FileEntry) {
    if !matches!(
        entry,
        FileEntry::Header { .. }
            | FileEntry::ModelChange { .. }
            | FileEntry::ThinkingLevelChange { .. }
            | FileEntry::ServiceTierChange { .. }
    ) {
        snapshot.non_bootstrap = true;
    }
    if let Some(goal) = valid_goal(entry) {
        snapshot.goal = Some(goal);
    }
    match entry {
        FileEntry::ThinkingLevelChange { payload, .. } => {
            snapshot.thinking = payload.thinking_level.clone();
            snapshot.thinking_present = true;
        }
        FileEntry::ServiceTierChange { payload, .. } => {
            snapshot.tier = payload.service_tier;
            snapshot.tier_present = true;
        }
        FileEntry::ModelChange { payload, .. } => {
            snapshot.model = Some((payload.provider.clone(), payload.model_id.clone()));
        }
        FileEntry::Message { message, .. } => {
            snapshot.message_count += 1;
            if let pa_types::session::AgentMessage::Assistant(message) = message {
                snapshot.model = Some((message.provider.clone(), message.model.clone()));
            }
            if snapshot.first_user.is_none()
                && matches!(message, pa_types::session::AgentMessage::User(_))
            {
                snapshot.first_user = serde_json::to_value(message).ok();
            }
        }
        _ => {}
    }
}

#[cfg(test)]
#[path = "window_tests.rs"]
mod tests;
