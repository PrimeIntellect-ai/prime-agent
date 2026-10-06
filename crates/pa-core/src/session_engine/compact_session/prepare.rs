//! Compact-session preparation: the skip guards, the prior-compaction
//! boundary and previous-summary anchors, the cut resolution, and the
//! session-cut test seam.
use super::recent_state_anchor::extract_recent_state_anchor;
use super::{
    context_tokens, find_cut_point, message_from_entry, AgentMessage, CutPointResult, FileEntry,
    SessionManager,
};

/// Why a compaction cannot prepare: `/compact` raises the message,
/// the kernel `compact.run` host request returns the short reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactSkip {
    AlreadyCompacted,
    TooShort,
}

impl CompactSkip {
    /// The `/compact` skip message.
    #[must_use]
    pub fn user_message(self) -> &'static str {
        match self {
            CompactSkip::AlreadyCompacted => "Already compacted",
            CompactSkip::TooShort => "Session is too short to compact — try again once it grows",
        }
    }

    /// The `compact.run` host-request reason.
    #[must_use]
    pub fn request_reason(self) -> &'static str {
        match self {
            CompactSkip::AlreadyCompacted => "already compacted",
            CompactSkip::TooShort => "session is too short to compact",
        }
    }
}

/// A prepared compaction: the resolved cut plus the iterative-update anchors
/// from the prior compaction — the boundary and the previous summary.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionPreparation {
    pub cut: CutPointResult,
    /// The prior compaction's first kept entry (or the entry after it when
    /// the boundary is gone): everything before is already summarized.
    pub boundary_start: usize,
    /// The prior compaction's summary, so the history call updates it instead
    /// of re-summarizing; a file-blocks-only summary strips to no `previous_summary`.
    pub previous_summary: Option<String>,
    /// The newest kept-tail assistant text (tail-truncated), so the update
    /// summary cannot lag behind the retained tail.
    pub recent_state_anchor: Option<String>,
}

/// Resolve the cut and the skip guards without a model call: a branch that
/// already ends in a compaction, or with no summarizable history, skips.
///
/// # Errors
///
/// Returns the skip case as `Err`: the branch already ends in a
/// compaction, or carries no summarizable history.
pub fn prepare_compaction(
    entries: &[FileEntry],
    keep_recent_tokens: u64,
) -> Result<CompactionPreparation, CompactSkip> {
    if matches!(entries.last(), Some(FileEntry::Compaction { .. })) {
        return Err(CompactSkip::AlreadyCompacted);
    }
    // The header is not a compact candidate.
    let start = usize::from(matches!(entries.first(), Some(FileEntry::Header { .. })));
    // Iterative update mode: a prior compaction's summary becomes
    // `previous_summary`, its first kept entry the boundary.
    let prev_compaction_index = entries
        .iter()
        .rposition(|entry| matches!(entry, FileEntry::Compaction { .. }));
    let (boundary_start, previous_summary) = match prev_compaction_index {
        Some(index) => {
            let FileEntry::Compaction { payload, .. } = &entries[index] else {
                unreachable!("rposition matched a compaction entry")
            };
            let first_kept_index = entries
                .iter()
                .position(|entry| entry.id() == Some(payload.first_kept_entry_id.as_str()));
            let boundary_start = first_kept_index.unwrap_or(index + 1);
            let stripped = super::compaction_utils::strip_file_list_blocks(&payload.summary);
            let previous_summary = (!stripped.is_empty()).then_some(stripped);
            (boundary_start, previous_summary)
        }
        None => (start, None),
    };
    let cut = find_cut_point(entries, boundary_start, entries.len(), keep_recent_tokens);
    let history_end = if cut.is_split_turn {
        cut.turn_start_index.unwrap_or(cut.first_kept_entry_index)
    } else {
        cut.first_kept_entry_index
    };
    let messages: Vec<AgentMessage> = entries[boundary_start..history_end]
        .iter()
        .filter_map(message_from_entry)
        .collect();
    let turn_prefix_messages: Vec<AgentMessage> = entries[history_end..cut.first_kept_entry_index]
        .iter()
        .filter_map(message_from_entry)
        .collect();
    // The summarizer sees only pre-cut messages, so the newest retained
    // assistant text anchors the summary to the kept tail.
    let recent_state_anchor =
        extract_recent_state_anchor(entries, cut.first_kept_entry_index, entries.len());

    // No history at all to summarize — but a prior summary alone is
    // enough to run: the update merges it.
    if messages.is_empty() && turn_prefix_messages.is_empty() && previous_summary.is_none() {
        return Err(CompactSkip::TooShort);
    }
    Ok(CompactionPreparation {
        cut,
        boundary_start,
        previous_summary,
        recent_state_anchor,
    })
}

/// The cut computed for a session (test seam for decision verification).
#[must_use]
pub fn compute_cut(session: &SessionManager, keep_recent_tokens: u64) -> (CutPointResult, u64) {
    let entries = session.retained_entries();
    let start = usize::from(matches!(entries.first(), Some(FileEntry::Header { .. })));
    let cut = find_cut_point(entries, start, entries.len(), keep_recent_tokens);
    let tokens = context_tokens(entries, session.get_leaf_id());
    (cut, tokens)
}
