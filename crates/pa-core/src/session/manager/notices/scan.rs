//! The file-scan half of the durable terminal-notice concern: parsing
//! the notice state (terminal rows, consumption markers, the last
//! file-backed assistant) out of a session file body. Only fully valid
//! rows participate: parse failures are skipped lines, an unterminated
//! trailing line is torn damage, and a terminal row needs its stable
//! `noticeKey`.

use std::collections::{HashMap, HashSet};

use pa_types::session::{AgentMessage, CustomMessage, FileEntry};

use crate::session::{create_custom_message, parse_session_entries};

use super::{
    AGENT_MESSAGE_CUSTOM_TYPE, AGENT_MESSAGE_KEY_FIELD, NOTICE_CONSUMED_CUSTOM_TYPE,
    NOTICE_CONSUMED_KEYS_FIELD, NOTICE_KEY_FIELD, TERMINAL_NOTICE_CUSTOM_TYPES,
};

/// One file-backed terminal-notice row.
pub(super) struct FileNoticeRow {
    pub(super) key: String,
    pub(super) entry_id: String,
    pub(super) message: CustomMessage,
}

/// The notice state parsed fresh from the session file.
#[derive(Default)]
pub(super) struct FileNoticeScan {
    /// Entry id of the last assistant row in the file (None when no
    /// assistant response is file-backed yet).
    pub(super) last_assistant_id: Option<String>,
    /// Notice rows in file order; the first row per key is canonical.
    pub(super) notice_rows: Vec<FileNoticeRow>,
    /// Keys covered by a durable consumption marker.
    pub(super) consumed_keys: HashSet<String>,
    /// Durable agent-message reply rows: `details.id` -> entry id; the
    /// first row per id is canonical.
    pub(super) agent_message_ids: HashMap<String, String>,
}

/// The stable key of a keyed custom message row; None when the row
/// carries no non-empty string at `field`.
pub(super) fn keyed_message_id<'a>(
    details: Option<&'a serde_json::Value>,
    field: &str,
) -> Option<&'a str> {
    details?.get(field)?.as_str().filter(|key| !key.is_empty())
}

/// The stable key of a notice row; None when the row carries no
/// non-empty string `noticeKey`.
pub(super) fn notice_key_of(details: Option<&serde_json::Value>) -> Option<&str> {
    details?
        .get(NOTICE_KEY_FIELD)?
        .as_str()
        .filter(|key| !key.is_empty())
}

/// Entry id of the last assistant row in an entry list.
pub(super) fn last_assistant_entry_id(entries: &[FileEntry]) -> Option<String> {
    entries.iter().rev().find_map(|entry| match entry {
        FileEntry::Message {
            message: AgentMessage::Assistant(_),
            base,
        } => base.id.clone(),
        _ => None,
    })
}

/// The fully terminated body of a session file: an unterminated
/// trailing segment is torn damage and never counts.
fn terminated_body(content: &str) -> &str {
    if content.ends_with('\n') {
        return content;
    }
    let end = content.rfind('\n').map_or(0, |position| position + 1);
    &content[..end]
}

/// Parse the notice state out of a session file body.
pub(super) fn scan_notice_content(content: &str) -> FileNoticeScan {
    let mut scan = FileNoticeScan {
        last_assistant_id: None,
        notice_rows: Vec::new(),
        consumed_keys: HashSet::new(),
        agent_message_ids: HashMap::new(),
    };
    let mut seen_keys = HashSet::new();
    let mut seen_agent_message_ids = HashSet::new();
    for entry in parse_session_entries(terminated_body(content)) {
        match &entry {
            FileEntry::Message {
                message: AgentMessage::Assistant(_),
                base,
            } => scan.last_assistant_id.clone_from(&base.id),
            FileEntry::Custom { payload, .. }
                if payload.custom_type == NOTICE_CONSUMED_CUSTOM_TYPE =>
            {
                let Some(keys) = payload
                    .data
                    .as_ref()
                    .and_then(|data| data.get(NOTICE_CONSUMED_KEYS_FIELD))
                    .and_then(serde_json::Value::as_array)
                else {
                    continue;
                };
                for key in keys.iter().filter_map(serde_json::Value::as_str) {
                    scan.consumed_keys.insert(key.to_string());
                }
            }
            FileEntry::CustomMessage { payload, .. }
                if TERMINAL_NOTICE_CUSTOM_TYPES.contains(&payload.custom_type.as_str()) =>
            {
                let Some(key) = notice_key_of(payload.details.as_ref()) else {
                    continue;
                };
                if !seen_keys.insert(key.to_string()) {
                    continue;
                }
                scan.notice_rows.push(FileNoticeRow {
                    key: key.to_string(),
                    entry_id: entry.id().unwrap_or_default().to_string(),
                    message: create_custom_message(payload, &entry),
                });
            }
            FileEntry::CustomMessage { payload, .. }
                if payload.custom_type == AGENT_MESSAGE_CUSTOM_TYPE =>
            {
                let Some(id) = keyed_message_id(payload.details.as_ref(), AGENT_MESSAGE_KEY_FIELD)
                else {
                    continue;
                };
                if seen_agent_message_ids.insert(id.to_string()) {
                    scan.agent_message_ids
                        .insert(id.to_string(), entry.id().unwrap_or_default().to_string());
                }
            }
            _ => {}
        }
    }
    scan
}
