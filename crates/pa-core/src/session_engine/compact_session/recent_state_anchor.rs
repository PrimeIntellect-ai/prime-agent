//! Compact-session recent-state-anchor selection (moved with its concern):
//! the newest kept-tail assistant text the history summary anchors on,
//! tail-truncated to the bound.
use super::{message_from_entry, AgentMessage, FileEntry};

/// Maximum characters kept from the retained tail for the recency anchor
/// (TS #2385 `RECENT_STATE_ANCHOR_MAX_CHARS`). The end of a message holds
/// the newest state, so long text keeps its tail.
const RECENT_STATE_ANCHOR_MAX_CHARS: usize = 2_000;

/// Extract the newest retained assistant text — the recency anchor (TS
/// #2385 `extractRecentStateAnchor`) — from the kept tail
/// `[kept_start, kept_end)`: scanning newest-first, the first assistant
/// message whose text blocks join to non-empty trimmed text wins; a longer
/// text keeps its tail. Compaction entries and harness digests are never
/// anchor candidates ([`message_from_entry`] drops them, mirroring TS
/// `getMessageFromEntryForCompaction`); assistants without text (tool-call
/// or thinking-only) skip until a text-bearing one is found.
pub(super) fn extract_recent_state_anchor(
    entries: &[FileEntry],
    kept_start: usize,
    kept_end: usize,
) -> Option<String> {
    for entry in entries[kept_start..kept_end].iter().rev() {
        let Some(AgentMessage::Assistant(assistant)) = message_from_entry(entry) else {
            continue;
        };
        let text = assistant
            .content
            .iter()
            .filter_map(|block| match block {
                pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        let chars = text.chars().count();
        return Some(if chars > RECENT_STATE_ANCHOR_MAX_CHARS {
            text.chars()
                .skip(chars - RECENT_STATE_ANCHOR_MAX_CHARS)
                .collect()
        } else {
            text
        });
    }
    None
}
