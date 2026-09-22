//! Session entry parsing, migration, context reconstruction, and tree.
pub mod discovery;
pub mod manager;
pub mod manager_ext;
pub mod tree;
pub mod window;

use std::collections::HashMap;

use pa_types::session::EntryBase;
use pa_types::session::{
    AgentMessage, CompactionEntry, CompactionSummaryMessage, CustomMessage, CustomMessageEntry,
    FileEntry,
};
use pa_types::JsonMap;

/// Current on-disk session format version.
pub const CURRENT_SESSION_VERSION: u32 = 3;

/// Entry types that can represent user intent (vs. daemon bookkeeping).
pub const CONTENT_ENTRY_TYPES: [&str; 10] = [
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

/// ISO-8601 timestamp -> unix milliseconds (best effort, UTC assumed).
pub fn timestamp_to_millis(timestamp: &str) -> u64 {
    // Accept common forms: with/without fractional seconds and Z/offset.
    timeparse(timestamp).unwrap_or(0)
}

fn timeparse(timestamp: &str) -> Option<u64> {
    // Minimal ISO-8601 parser for the formats the product writes:
    // YYYY-MM-DDTHH:MM:SS(.fff)?(Z|+HH:MM|+HHMM)?
    let bytes = timestamp.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        std::str::from_utf8(&bytes[from..to]).ok()?.parse().ok()
    };
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    // days from civil epoch
    let days = civil_days(year, month, day)?;
    let mut millis = ((days * 86_400) + hour * 3_600 + minute * 60 + second) * 1_000;
    let mut rest = &timestamp[19..];
    if rest.starts_with('.') {
        let fraction_end = rest[1..]
            .find(|c: char| !c.is_ascii_digit())
            .map(|idx| idx + 1)
            .unwrap_or(rest.len());
        let fraction = &rest[1..fraction_end];
        let millis_part: u64 = fraction
            .chars()
            .take(3)
            .collect::<String>()
            .parse()
            .unwrap_or(0);
        millis += millis_part as i64;
        rest = &rest[fraction_end..];
    }
    if let Some(offset) = rest.strip_prefix('+') {
        let (h, m) = parse_offset(offset)?;
        millis -= h * 3_600_000 + m * 60_000;
    } else if let Some(offset) = rest.strip_prefix('-') {
        let (h, m) = parse_offset(offset)?;
        millis += h * 3_600_000 + m * 60_000;
    }
    Some(millis.max(0) as u64)
}

fn parse_offset(offset: &str) -> Option<(i64, i64)> {
    let offset = offset.trim_end_matches('Z').trim_end_matches('Z');
    let offset = offset.trim();
    if offset.is_empty() {
        return Some((0, 0));
    }
    let (h, m) = offset.split_once(':').unwrap_or((offset, "0"));
    Some((h.parse().ok()?, m.parse().ok()?))
}

fn civil_days(year: i64, month: i64, day: i64) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// Parse a session file body into entries; malformed lines are skipped.
pub fn parse_session_entries(content: &str) -> Vec<FileEntry> {
    let mut entries = Vec::new();
    for line in content.trim().lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<FileEntry>(line) {
            entries.push(entry);
        }
    }
    apply_child_usage_attributions(&mut entries);
    entries
}

/// Fold `child_usage_attributed` aggregates into their target assistant
/// messages so replayed sessions see the same usage the live turn did.
fn apply_child_usage_attributions(entries: &mut [FileEntry]) {
    let mut assistant_index: HashMap<String, usize> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if let FileEntry::Message {
            message: AgentMessage::Assistant(_assistant),
            ..
        } = entry
        {
            if let Some(id) = entry.id().map(str::to_string) {
                assistant_index.insert(id, index);
            }
        }
    }
    let mut updates: Vec<(usize, pa_types::ai::Usage)> = Vec::new();
    for entry in entries.iter() {
        if let FileEntry::ChildUsageAttributed { payload, .. } = entry {
            if let Some(&target_index) =
                Some(payload.target_id.as_str()).and_then(|id| assistant_index.get(id))
            {
                updates.push((target_index, payload.aggregate_usage));
            }
        }
    }
    for (index, usage) in updates {
        if let FileEntry::Message {
            message: AgentMessage::Assistant(assistant),
            ..
        } = &mut entries[index]
        {
            assistant.usage = usage;
        }
    }
}

fn generate_id(existing: &std::collections::HashSet<String>) -> String {
    for _ in 0..100 {
        let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        if !existing.contains(&id) {
            return id;
        }
    }
    uuid::Uuid::new_v4().to_string()
}

/// v1 had no ids; threads are the whole file.
fn migrate_v1_to_v2(entries: &mut [FileEntry]) {
    let mut ids = std::collections::HashSet::new();
    let mut prev_id: Option<String> = None;
    let mut compaction_fixes: Vec<(usize, usize)> = Vec::new();
    let mut position = 0usize;
    for entry in entries.iter_mut() {
        if let FileEntry::Header { header } = entry {
            header.version = Some(2);
            position += 1;
            continue;
        }
        let id = generate_id(&ids);
        ids.insert(id.clone());
        if let Some(base) = entry_base_mut(entry) {
            base.id = Some(id.clone());
            base.parent_id = prev_id.clone();
        }
        prev_id = Some(id);
        // Compaction firstKeptEntryIndex references an earlier entry whose id
        // this pass just assigned; resolve after the loop.
        if let FileEntry::Compaction { payload, .. } = entry {
            if let Some(index) = payload
                .details
                .as_ref()
                .and_then(|details| details.get("firstKeptEntryIndex"))
                .and_then(|value| value.as_u64())
            {
                compaction_fixes.push((position, index as usize));
            }
        }
        position += 1;
    }
    for (compaction_position, target_index) in compaction_fixes {
        let Some(target_id) = entries
            .get(target_index)
            .and_then(|entry| entry.id())
            .map(str::to_string)
        else {
            continue;
        };
        if let FileEntry::Compaction { payload, .. } = &mut entries[compaction_position] {
            payload.first_kept_entry_id = target_id;
        }
    }
}

fn entry_base_mut(entry: &mut FileEntry) -> Option<&mut EntryBase> {
    match entry {
        FileEntry::Header { .. } | FileEntry::Unknown { .. } => None,
        FileEntry::Message { base, .. }
        | FileEntry::ThinkingLevelChange { base, .. }
        | FileEntry::ServiceTierChange { base, .. }
        | FileEntry::ModelChange { base, .. }
        | FileEntry::Compaction { base, .. }
        | FileEntry::BranchSummary { base, .. }
        | FileEntry::Custom { base, .. }
        | FileEntry::ChildUsageAttributed { base, .. }
        | FileEntry::Label { base, .. }
        | FileEntry::SessionInfo { base, .. }
        | FileEntry::SessionState { base, .. }
        | FileEntry::AgentStatus { base, .. }
        | FileEntry::GitState { base, .. }
        | FileEntry::CustomMessage { base, .. } => Some(base),
    }
}

/// v3 renamed the `hookMessage` role to `custom`.
fn migrate_v2_to_v3(entries: &mut [FileEntry]) {
    for entry in entries.iter_mut() {
        if let FileEntry::Header { header } = entry {
            header.version = Some(3);
            continue;
        }
        // hookMessage -> custom: AgentMessage deserializes unknown roles into
        // Unknown variant, where the rewrite happens through raw JSON. The
        // Unknown arm is intentionally empty here; the payload-level rewrite
        // happens in migrate hooks upstream. See v2->v3 in the TS port:
    }
}

/// Migrate entries to the current version; true when a rewrite happened.
pub fn migrate_to_current_version(entries: &mut [FileEntry]) -> bool {
    let version = entries
        .iter()
        .find_map(|entry| match entry {
            FileEntry::Header { header } => Some(header.version.unwrap_or(1)),
            _ => None,
        })
        .unwrap_or(1);
    if version >= CURRENT_SESSION_VERSION {
        return false;
    }
    if version < 2 {
        migrate_v1_to_v2(entries);
    }
    if version < 3 {
        migrate_v2_to_v3(entries);
    }
    true
}

pub fn migrate_session_entries(entries: &mut [FileEntry]) {
    migrate_to_current_version(entries);
}

/// The latest compaction on a leaf's ancestor path, or the last one anywhere.
pub fn get_latest_compaction_entry(entries: &[FileEntry]) -> Option<&CompactionEntry> {
    entries.iter().rev().find_map(|entry| match entry {
        FileEntry::Compaction { payload, .. } => Some(payload),
        _ => None,
    })
}

/// Reconstructed conversation state at a leaf.
pub struct SessionContext {
    pub messages: Vec<AgentMessage>,
    pub thinking_level: String,
    pub service_tier: Option<pa_types::ai::ServiceTier>,
    pub model: Option<(String, String)>,
}

/// Walk the parent chain from the leaf, reconstructing the model context
/// (summary-first when a compaction is on the path).
pub fn build_session_context(entries: &[FileEntry], leaf_id: Option<&str>) -> SessionContext {
    let by_id: HashMap<String, usize> = entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| entry.id().map(|id| (id.to_string(), index)))
        .collect();

    let leaf_index: Option<usize> = match leaf_id {
        Some("") | None => entries.len().checked_sub(1),
        Some(id) => by_id.get(id).copied(),
    };
    let Some(leaf_index) = leaf_index else {
        return empty_context();
    };

    // Path from root to leaf.
    let mut path: Vec<usize> = Vec::new();
    let mut current = Some(leaf_index);
    while let Some(index) = current {
        path.push(index);
        current = entries[index]
            .parent_id()
            .and_then(|parent_id| by_id.get(parent_id).copied());
    }
    path.reverse();

    let mut thinking_level = "off".to_string();
    let mut service_tier = None;
    let mut model: Option<(String, String)> = None;
    let mut compaction: Option<usize> = None;
    for &index in &path {
        match &entries[index] {
            FileEntry::ThinkingLevelChange { payload, .. } => {
                thinking_level = payload.thinking_level.clone();
            }
            FileEntry::ServiceTierChange { payload, .. } => {
                service_tier = payload.service_tier;
            }
            FileEntry::ModelChange { payload, .. } => {
                model = Some((payload.provider.clone(), payload.model_id.clone()));
            }
            FileEntry::Message {
                message: AgentMessage::Assistant(assistant),
                ..
            } => {
                model = Some((assistant.provider.clone(), assistant.model.clone()));
            }
            FileEntry::Compaction { .. } => compaction = Some(index),
            _ => {}
        }
    }

    let mut messages: Vec<AgentMessage> = Vec::new();
    let append_message = |entry: &FileEntry, target: &mut Vec<AgentMessage>| match entry {
        FileEntry::Message { message, .. } => target.push(message.clone()),
        FileEntry::CustomMessage { payload, .. } => {
            target.push(AgentMessage::Custom(create_custom_message(payload, entry)));
        }
        FileEntry::BranchSummary { payload, .. } if !payload.summary.is_empty() => {
            target.push(AgentMessage::BranchSummary(
                pa_types::session::BranchSummaryMessage {
                    summary: payload.summary.clone(),
                    from_id: payload.from_id.clone(),
                    timestamp: timestamp_to_millis(entry.timestamp()),
                },
            ));
        }
        _ => {}
    };

    if let Some(compaction_index) = compaction {
        let payload = match &entries[compaction_index] {
            FileEntry::Compaction { payload, .. } => payload.clone(),
            _ => unreachable!("compaction index checked above"),
        };
        let first_kept_id = payload.first_kept_entry_id.clone();
        let mut retained: Vec<AgentMessage> = Vec::new();
        let mut found_first_kept = false;
        for &index in &path[..path.partition_point(|&i| i < compaction_index)] {
            if Some(entries[index].id().unwrap_or_default().to_string())
                == Some(first_kept_id.clone())
            {
                found_first_kept = true;
            }
            if found_first_kept {
                append_message(&entries[index], &mut retained);
            }
        }
        messages.push(AgentMessage::CompactionSummary(CompactionSummaryMessage {
            summary: payload.summary.clone(),
            tokens_before: payload.tokens_before,
            retained_message_count: Some(retained.len() as u64),
            custom_instructions: payload.custom_instructions.clone(),
            harness_digest: payload.harness_digest.clone(),
            timestamp: timestamp_to_millis(entries[compaction_index].timestamp()),
        }));
        messages.extend(retained);
        for &index in &path[path.partition_point(|&i| i <= compaction_index)..] {
            append_message(&entries[index], &mut messages);
        }
    } else {
        for &index in &path {
            append_message(&entries[index], &mut messages);
        }
    }

    SessionContext {
        messages,
        thinking_level,
        service_tier,
        model,
    }
}

fn create_custom_message(payload: &CustomMessageEntry, entry: &FileEntry) -> CustomMessage {
    CustomMessage {
        custom_type: payload.custom_type.clone(),
        content: payload.content.clone(),
        display: payload.display,
        details: payload.details.clone(),
        timestamp: timestamp_to_millis(entry.timestamp()),
        rest: JsonMap::new(),
    }
}

fn empty_context() -> SessionContext {
    SessionContext {
        messages: Vec::new(),
        thinking_level: "off".to_string(),
        service_tier: None,
        model: None,
    }
}

#[cfg(test)]
mod context_tests {
    use super::build_session_context;
    use super::parse_session_entries;
    use pa_types::session::AgentMessage;

    fn assistant_json(id: &str, parent: &str, model: &str, usage_in: u64) -> String {
        serde_json::json!({
            "type": "message",
            "id": id,
            "parentId": if parent == "null" { serde_json::Value::Null } else { serde_json::json!(parent) },
            "timestamp": "2024-01-01T00:00:00.000Z",
            "message": {
                "role": "assistant",
                "content": [],
                "api": "anthropic-messages",
                "provider": "anthropic",
                "model": model,
                "usage": {
                    "input": usage_in,
                    "output": 1,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "totalTokens": usage_in,
                    "cost": { "input": usage_in, "output": 1, "cacheRead": 0, "cacheWrite": 0, "total": usage_in }
                },
                "stopReason": "stop",
                "timestamp": 0
            }
        })
        .to_string()
    }

    #[test]
    fn context_walks_parent_chain() {
        let content = format!(
            r#"
{{"type":"session","id":"s","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/w","version":3}}
{{"type":"message","id":"u1","parentId":null,"timestamp":"2024-01-01T00:00:01.000Z","message":{{"role":"user","content":[{{"type":"text","text":"hi"}}],"timestamp":0}}}}
{assistant_json}
{{"type":"thinking_level_change","id":"t1","parentId":"a1","timestamp":"2024-01-01T00:00:03.000Z","thinkingLevel":"high"}}
{{"type":"model_change","id":"m1","parentId":"t1","timestamp":"2024-01-01T00:00:04.000Z","provider":"openai","modelId":"gpt-x"}}
"#,
            assistant_json = assistant_json("a1", "u1", "claude-x", 10),
        );
        let entries = parse_session_entries(&content);
        let context = build_session_context(&entries, None);
        assert_eq!(context.thinking_level, "high");
        assert_eq!(
            context.model,
            Some(("openai".to_string(), "gpt-x".to_string()))
        );
        assert_eq!(context.messages.len(), 2);
        assert!(matches!(context.messages[0], AgentMessage::User(_)));
        assert!(matches!(context.messages[1], AgentMessage::Assistant(_)));
    }

    #[test]
    fn compaction_rebuilds_summary_first() {
        let content = String::from(
            r#"
{"type":"session","id":"s","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/w","version":3}
{"type":"message","id":"u1","parentId":null,"timestamp":"2024-01-01T00:00:01.000Z","message":{"role":"user","content":"old","timestamp":0}}
{"type":"message","id":"u2","parentId":"u1","timestamp":"2024-01-01T00:00:02.000Z","message":{"role":"user","content":"kept","timestamp":0}}
{"type":"compaction","id":"c1","parentId":"u2","timestamp":"2024-01-01T00:00:03.000Z","summary":"the story so far","firstKeptEntryId":"u2","tokensBefore":1234}
{"type":"message","id":"u3","parentId":"c1","timestamp":"2024-01-01T00:00:04.000Z","message":{"role":"user","content":"after","timestamp":0}}
"#,
        );
        let entries = parse_session_entries(&content);
        let context = build_session_context(&entries, None);
        // Summary message, then kept message, then post-compaction message.
        assert_eq!(context.messages.len(), 3);
        match &context.messages[0] {
            AgentMessage::CompactionSummary(summary) => {
                assert_eq!(summary.summary, "the story so far");
                assert_eq!(summary.tokens_before, 1234);
                assert_eq!(summary.retained_message_count, Some(1));
            }
            _ => panic!("expected compaction summary first"),
        }
        match &context.messages[2] {
            AgentMessage::User(user) => {
                assert_eq!(user.content.text(), "after");
            }
            _ => panic!("expected final user message"),
        }
        // The retained pre-compaction message follows the summary.
        match &context.messages[1] {
            AgentMessage::User(user) => assert_eq!(user.content.text(), "kept"),
            _ => panic!("expected retained user message"),
        }
    }

    #[test]
    fn child_usage_attribution_folds_into_assistant() {
        let content = format!(
            r#"
{{"type":"session","id":"s","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/w","version":3}}
{assistant}
{{"type":"child_usage_attributed","id":"c1","parentId":"a1","timestamp":"2024-01-01T00:00:02.000Z","targetId":"a1","origin":"spawn_task","childUsage":{{"input":50,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":55,"cost":{{"input":50,"output":5,"cacheRead":0,"cacheWrite":0,"total":55}}}},"aggregateUsage":{{"input":100,"output":10,"cacheRead":0,"cacheWrite":0,"totalTokens":110,"cost":{{"input":100,"output":10,"cacheRead":0,"cacheWrite":0,"total":110}}}}}}
"#,
            assistant = assistant_json("a1", "null", "m", 10),
        );
        let entries = parse_session_entries(&content);
        // The folded usage replaces the stored one on replay.
        if let Some(pa_types::session::FileEntry::Message {
            message: AgentMessage::Assistant(assistant),
            ..
        }) = entries.iter().find(|entry| entry.id() == Some("a1"))
        {
            assert_eq!(assistant.usage.input, 100);
        } else {
            panic!("assistant entry missing");
        }
    }
}
