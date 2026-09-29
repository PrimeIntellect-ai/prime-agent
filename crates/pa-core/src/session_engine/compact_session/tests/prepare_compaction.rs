//! Compact-session tests, the preparation family (moved with their
//! concerns): the split-arm skip guard, the recency-anchor selection,
//! the previous-summary file-block stripping, the update-mode
//! boundary, and the fallback + guard arms — over raw session
//! entries with explicit ids.
use super::*;
use pa_types::session::EntryBase;

/// The split arm of the skip guard (TS `prepareCompaction`): a
/// mid-turn cut with no history still has the turn prefix to
/// summarize, so the compaction prepares instead of skipping.
#[test]
fn prepare_compaction_split_arm_counts_the_turn_prefix_as_content() {
    let tmp = tempfile::tempdir().unwrap();
    let mut session = SessionManager::in_memory(tmp.path());
    let user = |text: &str| {
        AgentMessage::User(pa_types::ai::UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        })
    };
    session
        .append_message(user(&format!("big turn {}", "x".repeat(4_000))))
        .unwrap();
    session
        .append_message(AgentMessage::Assistant(AssistantMessage {
            content: vec![pa_types::ai::AssistantContentBlock::Text(
                pa_types::ai::TextContent {
                    text: format!("reply {}", "y".repeat(4_000)),
                    text_signature: None,
                    rest: serde_json::Map::default(),
                },
            )],
            api: "faux".to_string(),
            provider: "faux".to_string(),
            model: "compact-m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_types::ai::Usage::default(),
            stop_reason: pa_types::ai::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: serde_json::Map::default(),
        }))
        .unwrap();
    session.append_message(user("small")).unwrap();
    let entries = session.get_all_entries().to_vec();
    let preparation = prepare_compaction(&entries, 10).expect("split compaction prepares");
    assert!(preparation.cut.is_split_turn);
    assert_eq!(preparation.cut.turn_start_index, Some(1));
    // No prior compaction: no update-mode anchors.
    assert_eq!(preparation.previous_summary, None);
    // A fresh small session with no cut history still skips.
    let mut small = SessionManager::in_memory(tmp.path());
    small.append_message(user("one small turn")).unwrap();
    let entries = small.get_all_entries().to_vec();
    assert_eq!(
        prepare_compaction(&entries, 10_000),
        Err(CompactSkip::TooShort)
    );
}

/// A raw entry builder for prepare-level tests (explicit ids).
fn raw_user_entry(id: &str, text: &str) -> FileEntry {
    FileEntry::Message {
        message: AgentMessage::User(pa_types::ai::UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        }),
        base: EntryBase {
            id: Some(id.to_string()),
            parent_id: None,
            timestamp: Some("2024-01-01T00:00:00.000Z".to_string()),
            rest: serde_json::Map::default(),
        },
    }
}

fn raw_compaction_entry(id: &str, first_kept: &str, summary: &str) -> FileEntry {
    FileEntry::Compaction {
        payload: pa_types::session::CompactionEntry {
            summary: summary.to_string(),
            first_kept_entry_id: first_kept.to_string(),
            tokens_before: 100,
            ..Default::default()
        },
        base: EntryBase {
            id: Some(id.to_string()),
            parent_id: None,
            timestamp: Some("2024-01-01T00:00:00.000Z".to_string()),
            rest: serde_json::Map::default(),
        },
    }
}

fn raw_assistant_text_entry(id: &str, text: &str) -> FileEntry {
    FileEntry::Message {
        message: AgentMessage::Assistant(pa_types::ai::AssistantMessage {
            content: vec![pa_types::ai::AssistantContentBlock::Text(
                pa_types::ai::TextContent {
                    text: text.to_string(),
                    text_signature: None,
                    rest: serde_json::Map::default(),
                },
            )],
            api: "openai-completions".to_string(),
            provider: "p".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_types::ai::Usage::default(),
            stop_reason: pa_types::ai::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: serde_json::Map::default(),
        }),
        base: EntryBase {
            id: Some(id.to_string()),
            parent_id: None,
            timestamp: Some("2024-01-01T00:00:00.000Z".to_string()),
            rest: serde_json::Map::default(),
        },
    }
}

/// The recency anchor pins to the newest kept-tail assistant text (TS
/// #2385 `extractRecentStateAnchor`): the newest-first scan means a
/// direction flip fails this test (an older assistant sits in the
/// same kept tail), thinking-only assistants skip (text blocks only),
/// long text keeps its tail within the anchor budget, and a tail
/// without assistant text carries no anchor — compaction entries are
/// never candidates.
#[test]
fn prepare_compaction_anchors_on_the_newest_kept_tail_assistant_text() {
    // 400-char texts (100 tokens at the chars/4 heuristic) keep the
    // cuts deterministic: a 250-token keep budget cuts at the second
    // entry, so the kept tail holds BOTH assistants.
    let entries = vec![
        raw_user_entry("m0", &"0".repeat(400)),
        raw_assistant_text_entry("a1", &"older tail text ".repeat(25)),
        raw_user_entry("m1", &"1".repeat(400)),
        raw_assistant_text_entry("a2", &"newest tail text ".repeat(25)),
    ];
    let preparation = prepare_compaction(&entries, 250).expect("anchored compaction prepares");
    assert_eq!(preparation.cut.first_kept_entry_index, 1);
    // The anchor text trims like the TS scan (`.join("\n").trim()`).
    assert_eq!(
        preparation.recent_state_anchor.as_deref(),
        Some("newest tail text ".repeat(25).trim())
    );

    // A newest assistant with thinking but no text skips; the older
    // text-bearing assistant wins.
    let thinking_only = FileEntry::Message {
        message: AgentMessage::Assistant(pa_types::ai::AssistantMessage {
            content: vec![pa_types::ai::AssistantContentBlock::Thinking(
                pa_types::ai::ThinkingContent {
                    thinking: "2".repeat(400),
                    thinking_signature: None,
                    redacted: None,
                    rest: serde_json::Map::default(),
                },
            )],
            api: "openai-completions".to_string(),
            provider: "p".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_types::ai::Usage::default(),
            stop_reason: pa_types::ai::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: serde_json::Map::default(),
        }),
        base: EntryBase {
            id: Some("a2".to_string()),
            parent_id: None,
            timestamp: Some("2024-01-01T00:00:00.000Z".to_string()),
            rest: serde_json::Map::default(),
        },
    };
    let entries = vec![
        raw_user_entry("m0", &"0".repeat(400)),
        raw_assistant_text_entry("a1", &"older tail text ".repeat(25)),
        raw_user_entry("m1", &"1".repeat(400)),
        thinking_only,
    ];
    let preparation = prepare_compaction(&entries, 250).expect("anchored compaction prepares");
    assert_eq!(
        preparation.recent_state_anchor.as_deref(),
        Some("older tail text ".repeat(25).trim())
    );

    // A 3000-char text tail-truncates to the anchor budget: the END
    // of the message holds the newest state.
    let entries = vec![
        raw_user_entry("m0", &"0".repeat(400)),
        raw_user_entry("m1", &"1".repeat(400)),
        raw_assistant_text_entry("a2", &"z".repeat(3_000)),
    ];
    let preparation = prepare_compaction(&entries, 250).expect("anchored compaction prepares");
    let anchor = preparation
        .recent_state_anchor
        .expect("tail-truncated anchor");
    assert_eq!(anchor.chars().count(), 2_000);
    assert_eq!(anchor, "z".repeat(2_000));

    // A tail with no assistant text carries no anchor; the prior
    // summary alone keeps the compaction runnable.
    let entries = vec![
        raw_user_entry("m0", &"0".repeat(400)),
        raw_compaction_entry("c1", "m0", "the prior summary"),
        raw_user_entry("m1", &"1".repeat(400)),
        raw_user_entry("m2", "small"),
    ];
    let preparation = prepare_compaction(&entries, 250).expect("prior-summary compaction prepares");
    assert_eq!(preparation.recent_state_anchor, None);
    assert_eq!(
        preparation.previous_summary.as_deref(),
        Some("the prior summary")
    );
}

/// File-list blocks never reach the update prompt (TS #2385
/// `stripFileListBlocks`): the stored summary's blocks strip before it
/// becomes `previousSummary`, and a summary that contained only file
/// blocks leaves no update anchor at all — the initial-prompt path.
#[test]
fn prepare_compaction_strips_file_blocks_from_the_previous_summary() {
    let entries = vec![
        raw_user_entry("m0", "turn zero"),
        raw_compaction_entry(
            "c1",
            "m0",
            "the prior summary\n\n<read-files>\na.rs\nb.rs\n</read-files>\n\n<modified-files>\nc.rs\n</modified-files>",
        ),
        raw_user_entry("m1", "turn one"),
        raw_user_entry("m2", "turn two"),
    ];
    let preparation = prepare_compaction(&entries, 2).expect("update compaction prepares");
    assert_eq!(
        preparation.previous_summary,
        Some("the prior summary".to_string())
    );
    // Only-file-block summaries drop entirely.
    let entries = vec![
        raw_user_entry("m0", "turn zero"),
        raw_compaction_entry(
            "c1",
            "m0",
            "<read-files>\na.rs\n</read-files>\n\n<modified-files>\nb.rs\n</modified-files>",
        ),
        raw_user_entry("m1", "turn one"),
        raw_user_entry("m2", "turn two"),
    ];
    let preparation = prepare_compaction(&entries, 2).expect("update compaction prepares");
    assert_eq!(preparation.previous_summary, None);
}

/// The iterative update mode activates from a prior compaction (TS
/// `prepareCompaction`): the prior summary becomes `previousSummary`
/// and the prior compaction's first kept entry becomes the
/// summarization boundary — the cut walks only the retained
/// conversation, and the new history covers the messages since the
/// boundary, never the already-summarized prefix.
#[test]
fn prepare_compaction_update_mode_anchors_on_the_prior_compaction() {
    let entries = vec![
        raw_user_entry("m0", "turn zero"),
        raw_user_entry("m1", "turn one"),
        raw_user_entry("m2", "turn two"),
        raw_compaction_entry("c1", "m1", "the prior summary"),
        raw_user_entry("m3", "turn three"),
        raw_user_entry("m4", "turn four"),
    ];
    let preparation = prepare_compaction(&entries, 2).expect("update compaction prepares");
    // The boundary is the prior compaction's first kept entry.
    assert_eq!(preparation.boundary_start, 1);
    assert_eq!(
        preparation.previous_summary,
        Some("the prior summary".to_string())
    );
    // The cut walks only the retained region (the budget counts the
    // post-boundary messages, so it lands at the last small turn).
    assert_eq!(preparation.cut.first_kept_entry_index, 5);
    assert!(!preparation.cut.is_split_turn);
    // Without a prior compaction there are no update anchors.
    let fresh = vec![
        raw_user_entry("m0", "turn zero"),
        raw_user_entry("m1", "turn one"),
    ];
    let preparation = prepare_compaction(&fresh, 2).expect("fresh compaction prepares");
    assert_eq!(preparation.previous_summary, None);
    assert_eq!(preparation.boundary_start, 0);
}

/// The boundary fallback (TS `boundaryStart = prevCompactionIndex + 1`
/// when the retained entry is gone — session migration) and the guard
/// (TS: `!previousSummary` — a prior summary alone is enough to run).
#[test]
fn prepare_compaction_boundary_fallback_and_prior_summary_guard() {
    // The retained entry id no longer exists: the boundary falls back
    // to the entry after the compaction.
    let entries = vec![
        raw_compaction_entry("c1", "gone-entry", "the prior summary"),
        raw_user_entry("m1", "turn one"),
    ];
    let preparation = prepare_compaction(&entries, 2).expect("fallback boundary prepares");
    assert_eq!(preparation.boundary_start, 1);
    assert_eq!(
        preparation.previous_summary,
        Some("the prior summary".to_string())
    );
    // A huge keep budget leaves nothing new to summarize, but the
    // prior summary alone keeps the compaction runnable (TS: the skip
    // guard fires only without a previousSummary).
    let preparation = prepare_compaction(&entries, 10_000).expect("prior summary runs");
    assert_eq!(preparation.cut.first_kept_entry_index, 1);
    // The same shape WITHOUT a prior compaction skips as too short.
    let fresh = vec![raw_user_entry("m1", "turn one")];
    assert_eq!(
        prepare_compaction(&fresh, 10_000),
        Err(CompactSkip::TooShort)
    );
}
