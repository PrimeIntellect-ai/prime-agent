//! Compact-session recent-state-anchor selection: the newest kept-tail
//! assistant text the history summary anchors on, tail-truncated to
//! the bound.
use super::{message_from_entry, AgentMessage, FileEntry};

/// Maximum characters kept from the retained tail for the recency anchor:
/// the end of a message holds the newest state, so long text keeps its tail.
const RECENT_STATE_ANCHOR_MAX_CHARS: usize = 2_000;

/// Extract the newest retained assistant text from the kept tail
/// `[kept_start, kept_end)`: newest-first, the first assistant whose joined
/// text blocks trim to non-empty wins; compaction/digest rows never qualify.
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
