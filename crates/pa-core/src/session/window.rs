//! Bounded reverse reads for compacted sessions. Older message bodies are not
//! materialized; full-history consumers explicitly hydrate on a blocking worker.
use std::collections::HashSet;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use pa_types::session::{FileEntry, SessionHeader};
use serde::Deserialize;

use super::{build_session_context, SessionContext};

const CHUNK_BYTES: usize = 64 * 1024;
const WINDOW_BYTES: u64 = 8 * 1024 * 1024;
const SCAN_BYTES: u64 = 128 * 1024 * 1024;
const DISPLAY_MESSAGES: usize = 100;

struct ReverseLines {
    file: std::fs::File,
    position: u64,
    pending: Vec<u8>,
}

impl ReverseLines {
    fn next(&mut self) -> io::Result<Option<Vec<u8>>> {
        let mut pieces = Vec::new();
        loop {
            if let Some(index) = self.pending.iter().rposition(|byte| *byte == b'\n') {
                let mut line = self.pending.split_off(index + 1);
                self.pending.pop();
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
                let line: Vec<u8> = pieces.into_iter().rev().flatten().collect();
                return Ok((!line.is_empty()).then_some(line));
            }
            let count = self.position.min(CHUNK_BYTES as u64) as usize;
            self.position -= count as u64;
            self.file.seek(SeekFrom::Start(self.position))?;
            self.pending.resize(count, 0);
            self.file.read_exact(&mut self.pending)?;
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
}

#[derive(Deserialize)]
struct MessageMetadata {
    role: String,
    provider: Option<String>,
    model: Option<String>,
    usage: Option<pa_types::ai::Usage>,
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
#[derive(Default, Clone, Debug)]
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
}

impl WindowedSessionStore {
    /// Return `None` for old schemas, missing boundaries, oversized windows,
    /// or ambiguous ancestry so callers can use their ordinary full reader.
    pub fn open(path: &Path) -> io::Result<Option<Self>> {
        let mut file = std::fs::File::open(path)?;
        let size = file.metadata()?.len();
        if size == 0 || size > SCAN_BYTES {
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
        let mut reader = ReverseLines {
            file,
            position: size,
            pending: Vec::new(),
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
        let mut display_messages = 0;
        let mut window_done = false;
        let mut scanned = 0;
        let mut seen = HashSet::new();
        let mut thinking = None;
        let mut tier = None;
        let mut model = None;
        let mut header = None;
        while let Some(line) = reader.next()? {
            scanned += line.len() as u64 + 1;
            let Ok(meta) = serde_json::from_slice::<Envelope>(&line) else {
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
            if meta.kind == "message" {
                message_count += 1;
                if meta
                    .message
                    .as_ref()
                    .is_some_and(|message| message.role == "user")
                {
                    first_user_line = Some(line.clone());
                }
            } else if window_done && meta.kind != "custom_message" {
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
                                    older_path_stats.input += usage.input;
                                    older_path_stats.output += usage.output;
                                    older_path_stats.cache_read += usage.cache_read;
                                    older_path_stats.cache_write += usage.cache_write;
                                    older_costs.push(usage.cost.total.as_f64());
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
                    && matches!(
                        meta.kind.as_str(),
                        "model_change" | "thinking_level_change" | "service_tier_change"
                    )) {
                match serde_json::from_slice::<FileEntry>(&line) {
                    Ok(entry) => Some(entry),
                    Err(_) => return Ok(None),
                }
            } else {
                None
            };
            if on_path {
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
                if matches!(meta.kind.as_str(), "message" | "custom_message") {
                    display_messages += 1;
                }
            }
            if !window_done {
                if scanned > WINDOW_BYTES {
                    return Ok(None);
                }
                retained.push(entry.expect("window entries parsed"));
                raw_entries.push(
                    String::from_utf8(line)
                        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?,
                );
                window_done = found_boundary && display_messages >= DISPLAY_MESSAGES;
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
        if !found_boundary || expected.is_some() || !window_done {
            return Ok(None);
        }
        retained.push(header.expect("header checked"));
        retained.reverse();
        raw_entries.reverse();
        metadata_entries.reverse();
        older_path_stats.cost = older_costs
            .into_iter()
            .rev()
            .fold(0.0, |total, cost| total + cost);
        let first_user_message = first_user_line
            .and_then(|line| serde_json::from_slice::<serde_json::Value>(&line).ok())
            .and_then(|row| row.get("message").cloned());
        super::apply_child_usage_attributions(&mut retained);
        Ok(Some(Self {
            path: path.to_owned(),
            entries: retained,
            raw_entries,
            metadata_entries,
            message_count,
            older_path_stats,
            first_user_message,
            leaf_id: leaf_id.expect("boundary requires leaf"),
            settings: SessionContext {
                messages: Vec::new(),
                thinking_level: thinking.unwrap_or_else(|| "off".to_owned()),
                service_tier: tier.flatten(),
                model,
            },
            full: false,
        }))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> String {
        let mut rows = vec![
            json!({"type":"session","id":"s","version":3,"cwd":"/tmp","timestamp":"2026-01-01T00:00:00Z"}),
            json!({"type":"thinking_level_change","id":"settings","parentId":null,"thinkingLevel":"high"}),
        ];
        let mut parent = "settings".to_owned();
        for i in 0..220 {
            let id = format!("u{i}");
            rows.push(json!({"type":"message","id":id,"parentId":parent,"message":{"role":"user","content":if i == 0 { "x".repeat(CHUNK_BYTES * 3) } else { format!("hello {i}") },"timestamp":0}}));
            parent = id;
        }
        rows.push(json!({"type":"compaction","id":"compact","parentId":parent,"summary":"summary","firstKeptEntryId":"u210","tokensBefore":999}));
        // A sibling compaction must not replace the one on the active path.
        rows.push(json!({"type":"compaction","id":"sibling","parentId":"u0","summary":"wrong","firstKeptEntryId":"u0","tokensBefore":999}));
        rows.push(json!({"type":"message","id":"leaf","parentId":"compact","message":{"role":"user","content":"latest","timestamp":0}}));
        rows.into_iter().map(|row| row.to_string() + "\n").collect()
    }

    #[tokio::test]
    async fn context_and_hydration_match_full_reader() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let body = fixture();
        std::fs::write(&path, &body).unwrap();
        let full = super::super::parse_session_entries(&body);
        let expected = build_session_context(&full, Some("leaf"));
        let mut window = WindowedSessionStore::open(&path).unwrap().unwrap();
        assert!(window.entries().len() < full.len());
        let actual = window.context();
        assert_eq!(
            serde_json::to_vec(&actual.messages).unwrap(),
            serde_json::to_vec(&expected.messages).unwrap()
        );
        assert_eq!(
            (actual.thinking_level, actual.service_tier, actual.model),
            (
                expected.thinking_level,
                expected.service_tier,
                expected.model
            )
        );
        window.ensure_full_history().await.unwrap();
        assert_eq!(
            serde_json::to_vec(window.entries()).unwrap(),
            serde_json::to_vec(&full).unwrap()
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), body);
    }

    #[tokio::test]
    async fn metadata_and_concurrent_disk_append_survive_hydration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("metadata.jsonl");
        let body = fixture();
        std::fs::write(&path, &body).unwrap();
        let mut store = WindowedSessionStore::open(&path).unwrap().unwrap();
        assert_eq!(store.message_count(), 221);
        assert_eq!(store.older_path_stats().user_messages, 121);
        assert_eq!(
            store.first_user_message().unwrap()["content"],
            "x".repeat(CHUNK_BYTES * 3)
        );
        assert_eq!(store.metadata_entries().len(), 1);
        let settings: serde_json::Value =
            serde_json::from_str(&store.metadata_entries()[0]).unwrap();
        assert_eq!(settings["thinkingLevel"], "high");
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file, "{}", json!({"type":"message","id":"appended","parentId":"leaf","message":{"role":"user","content":"new","timestamp":0}})).unwrap();
        store.ensure_full_history().await.unwrap();
        assert_eq!(store.leaf_id(), "leaf");
        assert_eq!(store.entries().last().unwrap().id(), Some("appended"));
        let expected =
            super::super::parse_session_entries(&std::fs::read_to_string(&path).unwrap());
        assert_eq!(
            serde_json::to_vec(store.entries()).unwrap(),
            serde_json::to_vec(&expected).unwrap()
        );
    }

    #[tokio::test]
    async fn manager_opens_window_then_hydrates_before_append() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("manager.jsonl");
        let body = fixture();
        std::fs::write(&path, &body).unwrap();
        let mut manager =
            super::super::manager::SessionManager::open_windowed(dir.path(), dir.path(), &path)
                .await
                .unwrap();
        assert!(!manager.is_full_history());
        let expected =
            build_session_context(&super::super::parse_session_entries(&body), Some("leaf"));
        assert_eq!(
            serde_json::to_vec(&manager.active_context().messages).unwrap(),
            serde_json::to_vec(&expected.messages).unwrap()
        );
        manager.ensure_full_history().await.unwrap();
        manager.append_session_info("resumed");
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.starts_with(&body));
        let reopened = super::super::manager::SessionManager::open(dir.path(), dir.path(), &path);
        assert_eq!(
            serde_json::to_vec(manager.get_all_entries()).unwrap(),
            serde_json::to_vec(reopened.get_all_entries()).unwrap()
        );
    }

    #[test]
    fn sparse_settings_and_sibling_changes_match_full_context() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.jsonl");
        let mut rows: Vec<serde_json::Value> = fixture()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        rows[1]["parentId"] = json!("tier");
        rows.insert(1, json!({"type":"model_change","id":"model","parentId":null,"provider":"openai","modelId":"gpt-test"}));
        rows.insert(2, json!({"type":"service_tier_change","id":"tier","parentId":"model","serviceTier":"default"}));
        rows.insert(rows.len() - 1, json!({"type":"thinking_level_change","id":"other-settings","parentId":"sibling","thinkingLevel":"low"}));
        let body: String = rows.into_iter().map(|row| row.to_string() + "\n").collect();
        std::fs::write(&path, &body).unwrap();
        let expected =
            build_session_context(&super::super::parse_session_entries(&body), Some("leaf"));
        let actual = WindowedSessionStore::open(&path)
            .unwrap()
            .unwrap()
            .context();
        assert_eq!(
            serde_json::to_vec(&actual.messages).unwrap(),
            serde_json::to_vec(&expected.messages).unwrap()
        );
        assert_eq!(
            (actual.thinking_level, actual.service_tier, actual.model),
            (
                expected.thinking_level,
                expected.service_tier,
                expected.model
            )
        );
    }

    #[test]
    fn unterminated_session_uses_repair_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("torn.jsonl");
        std::fs::write(&path, fixture().trim_end()).unwrap();
        assert!(WindowedSessionStore::open(&path).unwrap().is_none());
    }

    #[test]
    fn reverse_reader_preserves_long_lines_and_unterminated_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lines");
        let long = "é".repeat(CHUNK_BYTES * 2);
        let body = format!("first\n{long}\nlast");
        std::fs::write(&path, &body).unwrap();
        let mut reader = ReverseLines {
            file: std::fs::File::open(path).unwrap(),
            position: body.len() as u64,
            pending: Vec::new(),
        };
        let mut lines = Vec::new();
        while let Some(line) = reader.next().unwrap() {
            lines.push(String::from_utf8(line).unwrap());
        }
        assert_eq!(lines, vec!["last".to_owned(), long, "first".to_owned()]);
    }
}
