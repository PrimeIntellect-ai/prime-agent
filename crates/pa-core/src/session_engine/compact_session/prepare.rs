//! Compact-session preparation (moved with its concern): the skip guards,
//! the prior-compaction boundary and previous-summary anchors, the cut
//! resolution, and the session-cut test seam.
use super::recent_state_anchor::extract_recent_state_anchor;
use super::{
    context_tokens, find_cut_point, message_from_entry, AgentMessage, CutPointResult, FileEntry,
    SessionManager,
};

/// Why a compaction cannot prepare (TS `prepareCompaction` returning
/// `undefined`). The two surfaces spell it differently: `/compact` raises
/// the `CompactionSkippedError` message, the kernel `compact.run` host
/// request returns the short reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactSkip {
    AlreadyCompacted,
    TooShort,
}

impl CompactSkip {
    /// The `/compact` skip message (TS `CompactionSkippedError`).
    #[must_use]
    pub fn user_message(self) -> &'static str {
        match self {
            CompactSkip::AlreadyCompacted => "Already compacted",
            CompactSkip::TooShort => "Session is too short to compact — try again once it grows",
        }
    }

    /// The `compact.run` host-request reason (TS `handleCompactHostRequest`).
    #[must_use]
    pub fn request_reason(self) -> &'static str {
        match self {
            CompactSkip::AlreadyCompacted => "already compacted",
            CompactSkip::TooShort => "session is too short to compact",
        }
    }
}

/// A prepared compaction (TS `prepareCompaction`'s `CompactionPreparation`):
/// the resolved cut plus the iterative-update anchors derived from the prior
/// compaction — the retained boundary the new summary covers and the
/// previous summary the update-mode summarizer merges into.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionPreparation {
    /// The chosen cut point.
    pub cut: CutPointResult,
    /// TS `boundaryStart`: the prior compaction's first kept entry (or the
    /// entry after the compaction when its boundary is gone — session
    /// migration). Everything before it is already summarized by the prior
    /// compaction; the new summary covers only what follows.
    pub boundary_start: usize,
    /// TS `previousSummary`: the prior compaction's summary, wired into the
    /// history summarizer request so it updates the existing summary instead
    /// of re-summarizing from scratch. File-list blocks never ride it (TS
    /// #2385 `stripFileListBlocks`): they strip before the update prompt,
    /// and a summary that contained only file blocks leaves no
    /// `previous_summary` at all (the initial-prompt path).
    pub previous_summary: Option<String>,
    /// TS #2385 `recentStateAnchor`: the newest kept-tail assistant text
    /// (tail-truncated), wired into the history summarizer request so the
    /// update summary cannot lag behind the retained tail it merges into.
    pub recent_state_anchor: Option<String>,
}

/// Resolve the compaction cut and the skip guards without a model call
/// (TS `prepareCompaction`): a branch that already ends in a compaction has
/// nothing new to summarize, and a branch with no summarizable history has
/// no compaction to run.
///
/// # Errors
///
/// Returns the TS `CompactionSkippedError` case as `Err`: the branch
/// already ends in a compaction, or it carries no summarizable history.
pub fn prepare_compaction(
    entries: &[FileEntry],
    keep_recent_tokens: u64,
) -> Result<CompactionPreparation, CompactSkip> {
    // Skip guard (TS prepareCompaction): a branch that already ends in a
    // compaction has nothing new to summarize.
    if matches!(entries.last(), Some(FileEntry::Compaction { .. })) {
        return Err(CompactSkip::AlreadyCompacted);
    }
    // The header is not a compact candidate.
    let start = usize::from(matches!(entries.first(), Some(FileEntry::Header { .. })));
    // Iterative update mode (TS prepareCompaction): a prior compaction is
    // the update anchor. Its summary becomes `previousSummary` (the
    // update-in-place mode for the history summarizer), and its first kept
    // entry becomes the boundary the new compaction covers — the new
    // summary summarizes only the retained conversation since, never the
    // already-summarized history before it.
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
            // TS boundaryStart: the retained entry when it still exists,
            // else the entry after the compaction (session migration).
            let boundary_start = first_kept_index.unwrap_or(index + 1);
            // File-list blocks never reach the update prompt (TS #2385):
            // they are re-appended mechanically below and compound when
            // the model re-summarizes them. A previous summary that
            // contained only file blocks falls back to the initial-prompt
            // path.
            let stripped = super::compaction_utils::strip_file_list_blocks(&payload.summary);
            let previous_summary = (!stripped.is_empty()).then_some(stripped);
            (boundary_start, previous_summary)
        }
        None => (start, None),
    };
    let cut = find_cut_point(entries, boundary_start, entries.len(), keep_recent_tokens);
    // Messages the summarizer would see (TS prepareCompaction): the
    // conversation since the boundary, plus the prefix of a split turn.
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
    // The recency anchor (TS #2385): the summarizer sees only messages
    // before the cut, so its summary would describe pre-tail state. The
    // newest retained assistant text is the state the next turn actually
    // sees; it anchors the history summary to the kept tail.
    let recent_state_anchor =
        extract_recent_state_anchor(entries, cut.first_kept_entry_index, entries.len());

    // Avoid a compaction that would summarize no history (TS prepareCompaction
    // — a prior summary alone is enough to run: the update merges it).
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
