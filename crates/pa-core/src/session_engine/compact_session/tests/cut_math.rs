//! Compact-session tests, the cut-math family (moved with their
//! concerns): the cut-and-tokens computation, the entry-message
//! extraction, the tokens-before anchoring, and the summary-request
//! window estimate.
use super::*;
use pa_types::session::EntryBase;

#[test]
fn cut_and_tokens_computed_from_entries() {
    let tmp = tempfile::tempdir().unwrap();
    let session = session_with_turns(tmp.path(), 3);
    let (cut, tokens) = compute_cut(&session, 10_000);
    // A large keep budget keeps from the start.
    assert_eq!(cut.first_kept_entry_index, 1); // after the header
    assert_eq!(tokens, 120);
}

#[test]
fn message_extraction_skips_compaction_and_tool_results() {
    let mut compaction = FileEntry::Compaction {
        payload: pa_types::session::CompactionEntry {
            summary: "s".to_string(),
            first_kept_entry_id: "x".to_string(),
            tokens_before: 1,
            details: None,
            from_hook: None,
            custom_instructions: None,
            usage: None,
            harness_digest: None,
            harness_state_fingerprint: None,
        },
        base: EntryBase {
            id: Some("c".to_string()),
            parent_id: None,
            timestamp: Some("2024-01-01T00:00:00.000Z".to_string()),
            rest: serde_json::Map::default(),
        },
    };
    let _ = &mut compaction;
    assert!(message_from_entry(&compaction).is_none());
    let tool_result = FileEntry::Message {
        message: AgentMessage::ToolResult(pa_types::ai::ToolResultMessage {
            tool_call_id: "c".to_string(),
            tool_name: "bash".to_string(),
            content: vec![],
            details: None,
            is_error: false,
            timestamp: 0,
            rest: serde_json::Map::default(),
        }),
        base: EntryBase {
            id: Some("t".to_string()),
            parent_id: None,
            timestamp: Some("2024-01-01T00:00:00.000Z".to_string()),
            rest: serde_json::Map::default(),
        },
    };
    assert!(message_from_entry(&tool_result).is_none());
}

/// A usage-less error turn never anchors `tokensBefore`: the estimate
/// uses the last settled (probe-measured) usage plus a chars/4
/// estimate of everything that trails it — the exact TS overflow-row
/// scenario (`getLastAssistantUsageInfo` skips error turns).
#[test]
fn tokens_before_anchors_on_last_valid_usage_plus_trailing() {
    let reply = |usage: pa_types::ai::Usage, error: bool| {
        // A failed request carries no content: the failure lives in
        // `errorMessage` (the TS and Rust durable error turns both
        // record an empty content list).
        let content = if error {
            Vec::new()
        } else {
            vec![pa_types::ai::AssistantContentBlock::Text(
                pa_types::ai::TextContent {
                    text: "seed reply".to_string(),
                    text_signature: None,
                    rest: serde_json::Map::default(),
                },
            )]
        };
        AgentMessage::Assistant(AssistantMessage {
            content,
            api: "openai-completions".to_string(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage,
            stop_reason: if error {
                pa_types::ai::StopReason::Error
            } else {
                pa_types::ai::StopReason::Stop
            },
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: serde_json::Map::default(),
        })
    };
    let tmp = tempfile::tempdir().unwrap();
    let mut session = SessionManager::in_memory(tmp.path());
    let settled = pa_types::ai::Usage {
        input: 20,
        output: 10,
        cache_read: 80,
        cache_write: 0,
        total_tokens: 110,
        cost: pa_types::ai::UsageCost::default(),
    };
    let probe = |text: &str| {
        AgentMessage::User(pa_types::ai::UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        })
    };
    session.append_message(probe("seed turn")).unwrap();
    session.append_message(reply(settled, false)).unwrap();
    session
        .append_message(probe(&("overflow probe ".to_string() + &"x".repeat(400))))
        .unwrap();
    // The overflow error turn: stopReason "error" with zeroed usage
    // (what the provider returns for a failed request).
    session
        .append_message(reply(pa_types::ai::Usage::default(), true))
        .unwrap();
    // TS: 110 (last valid usage) + ceil(415/4) (the probe turn) = 214.
    assert_eq!(
        context_tokens(session.get_all_entries(), session.get_leaf_id()),
        214
    );
}

/// The window estimate covers the exact wire bodies the compaction
/// will issue (TS #2411's `estimateSummaryRequestTokens`): a split
/// turn estimates BOTH the history request and the turn-prefix
/// request (each with the shared system prompt and its own
/// completion budget), and the no-history split arm estimates only the
/// prefix call.
#[test]
fn summary_window_estimate_covers_both_split_requests() {
    let history = vec![user_message("some history to summarize")];
    let turn_prefix = vec![user_message(&"a very long turn prefix ".repeat(2_000))];
    let full =
        estimate_summary_request_tokens(&history, &turn_prefix, true, None, None, None, 10_000);
    let history_only =
        estimate_summary_request_tokens(&history, &[], false, None, None, None, 10_000);
    let prefix_only =
        estimate_summary_request_tokens(&[], &turn_prefix, true, None, None, None, 10_000);
    // A split turn must fit every request it will issue: the estimate
    // is the larger of the two arms' estimates (each with the shared
    // system prompt and its own completion budget).
    assert_eq!(full, history_only.max(prefix_only));
    assert!(full > history_only);
    // The previous summary, the recency anchor, and the custom
    // instructions grow the history request, so they grow the
    // estimate.
    let with_anchors = estimate_summary_request_tokens(
        &history,
        &[],
        false,
        Some("the previous summary text"),
        Some("the newest kept-tail assistant text"),
        Some("focus on the goal"),
        10_000,
    );
    assert!(with_anchors > history_only);
    // The recency anchor alone grows the estimate (TS follow-up
    // 771611b14: the estimator mirrors the anchor block the wire
    // request carries).
    let with_anchor = estimate_summary_request_tokens(
        &history,
        &[],
        false,
        None,
        Some("the newest kept-tail assistant text"),
        None,
        10_000,
    );
    assert!(with_anchor > history_only);
    // The completion budgets draw on the reserve: a larger reserve
    // grows the estimate.
    let bigger_reserve =
        estimate_summary_request_tokens(&history, &[], false, None, None, None, 100_000);
    assert!(bigger_reserve > history_only);
}

fn user_message(text: &str) -> AgentMessage {
    AgentMessage::User(pa_types::ai::UserMessage {
        content: UserContent::Text(text.to_string()),
        timestamp: 0,
        rest: serde_json::Map::default(),
    })
}
