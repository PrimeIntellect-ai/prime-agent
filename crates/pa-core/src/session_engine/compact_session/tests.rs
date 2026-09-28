//! Compact-session tests (moved with their concerns).
use super::*;
use pa_types::ai::{AssistantMessage, UserContent};
use pa_types::session::EntryBase;
use serde_json::Map;

fn session_with_turns(cwd: &std::path::Path, turns: usize) -> SessionManager {
    let mut session = SessionManager::in_memory(cwd);
    for i in 0..turns {
        session
            .append_message(AgentMessage::User(pa_types::ai::UserMessage {
                content: UserContent::Text(format!("turn {i} message with some words")),
                timestamp: 0,
                rest: serde_json::Map::default(),
            }))
            .unwrap();
        session
            .append_message(AgentMessage::Assistant(AssistantMessage {
                content: vec![pa_types::ai::AssistantContentBlock::Text(
                    pa_types::ai::TextContent {
                        text: format!("reply {i}"),
                        text_signature: None,
                        rest: serde_json::Map::default(),
                    },
                )],
                api: "openai-completions".to_string(),
                provider: "test".to_string(),
                model: "m".to_string(),
                response_model: None,
                response_id: None,
                diagnostics: None,
                usage: pa_types::ai::Usage {
                    input: 100,
                    output: 20,
                    cache_read: 0,
                    cache_write: 0,
                    total_tokens: 120,
                    cost: pa_types::ai::UsageCost::default(),
                },
                stop_reason: pa_types::ai::StopReason::Stop,
                stop_reason_raw: None,
                error_message: None,
                timestamp: 0,
                rest: serde_json::Map::default(),
            }))
            .unwrap();
    }
    session
}

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

/// The faux provider with one scripted summarizer response. The faux
/// seam is process-global, so every registration unregisters on drop.
fn faux_registration() -> pa_ai::faux::FauxProviderRegistration {
    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            models: Some(vec![pa_ai::faux::FauxModelDefinition {
                id: "compact-m".to_string(),
                name: Some("Compact Model".to_string()),
                reasoning: Some(false),
                input: Some(vec![pa_types::ai::ModelInput::Text]),
                cost: None,
                context_window: Some(1_000),
                max_tokens: Some(256),
            }]),
            ..Default::default()
        });
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
        pa_ai::faux::faux_assistant_text_message(
            "## Goal\nsummarized goal",
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        ),
    )]);
    registration
}

/// A turn-spanning cut is a split turn: the compaction runs TWO
/// summarizer calls — the history checkpoint call and the turn-prefix
/// call under its own instruction — and the merged summary carries the
/// turn context behind the TS split marker, with both calls' usage
/// summed onto the durable row (TS `compact`'s split arm).
#[tokio::test]
async fn split_turn_compaction_runs_two_summarizer_calls_and_merges_the_turn_context() {
    let registration = faux_registration();
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    let mut session = SessionManager::in_memory(tmp.path());
    let user = |text: &str| {
        AgentMessage::User(pa_types::ai::UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        })
    };
    let reply = |text: &str| {
        AgentMessage::Assistant(AssistantMessage {
            content: vec![pa_types::ai::AssistantContentBlock::Text(
                pa_types::ai::TextContent {
                    text: text.to_string(),
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
        })
    };
    session.append_message(user("turn one")).unwrap();
    session.append_message(reply("reply one")).unwrap();
    session
        .append_message(user(&format!("big turn {}", "x".repeat(4_000))))
        .unwrap();
    session
        .append_message(reply(&format!("reply {}", "y".repeat(4_000))))
        .unwrap();
    session.append_message(user("turn three")).unwrap();
    session.append_message(reply("reply three")).unwrap();
    // The tiny keep-recent budget lands the cut on the big turn's
    // assistant reply — a mid-turn cut.
    let (cut, _) = compute_cut(&session, 10);
    assert!(cut.is_split_turn);
    assert_eq!(cut.turn_start_index, Some(3));
    assert_eq!(cut.first_kept_entry_index, 4);
    let kept_id = session.get_all_entries()[4]
        .id()
        .expect("entry id")
        .to_string();

    // Scripted summaries: each factory call records its request and
    // answers with its scripted response, so both wire calls are
    // captured regardless of issue order.
    let seen: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>> = std::sync::Arc::default();
    let make_step = |response: &'static str| {
        let seen = seen.clone();
        pa_ai::faux::FauxResponseStep::Factory(std::sync::Arc::new(
            move |context: &pa_types::ai::Context,
                  _options: Option<&pa_ai::types::StreamOptions>,
                  _call: u64,
                  _model: &pa_types::ai::Model| {
                let text = match &context.messages[0] {
                    pa_types::ai::Message::User(user) => user.content.text(),
                    _ => panic!("expected a user request"),
                };
                seen.lock().unwrap().push((text, response.to_string()));
                Ok(pa_ai::faux::faux_assistant_text_message(
                    response,
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ))
            },
        ))
    };
    registration.set_responses(vec![
        make_step("the history summary"),
        make_step("the turn prefix summary"),
    ]);
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 10,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(run) = outcome else {
        panic!("expected the compaction to run");
    };
    // Two wire calls: the history checkpoint and the turn prefix.
    assert_eq!(registration.call_count(), 2);
    let calls = seen.lock().unwrap().clone();
    assert_eq!(calls.len(), 2);
    let (history_request, history_response) = calls
        .iter()
        .find(|(text, _)| text.contains("Create a structured context checkpoint summary"))
        .expect("history call");
    assert!(history_request.contains("[User]: turn one"));
    assert!(history_request.contains("[Assistant]: reply one"));
    assert!(!history_request.contains("big turn"));
    assert!(!history_request.contains("PREFIX of a turn"));
    assert_eq!(history_response, "the history summary");
    let (prefix_request, prefix_response) = calls
        .iter()
        .find(|(text, _)| text.contains("PREFIX of a turn"))
        .expect("turn-prefix call");
    assert!(prefix_request.contains("[User]: big turn"));
    assert!(prefix_request.contains("This is the PREFIX of a turn that was too large to keep."));
    assert!(prefix_request
        .ends_with("Be concise. Focus on what's needed to understand the kept suffix."));
    assert!(!prefix_request.contains("checkpoint summary"));
    assert_eq!(prefix_response, "the turn prefix summary");
    // The merged summary: history, the split marker, the turn context.
    assert_eq!(
        run.result.summary,
        "the history summary\n\n---\n\n**Turn Context (split turn):**\n\nthe turn prefix summary"
    );
    assert_eq!(run.result.first_kept_entry_id, kept_id);
    // The usage is the sum of the two wire calls (faux estimates each
    // call as ceil(chars/4) over the serialized prompt plus response).
    let est = |text: &str| (text.chars().count() as f64 / 4.0).ceil() as u64;
    let usage_of = |request: &str, response: &str| {
        let prompt = format!(
            "system:{}\n\nuser:{request}",
            super::super::compaction_utils::SUMMARIZATION_SYSTEM_PROMPT
        );
        let input = est(&prompt);
        let output = est(response);
        pa_types::ai::Usage {
            input,
            output,
            cache_read: 0,
            cache_write: 0,
            total_tokens: input + output,
            cost: pa_types::ai::UsageCost::default(),
        }
    };
    let mut expected = usage_of(history_request, history_response);
    super::super::compaction_exec::add_assistant_usage(
        &mut expected,
        &usage_of(prefix_request, prefix_response),
    );
    assert_eq!(run.result.usage, Some(expected));
    assert_eq!(run.entry.usage, run.result.usage);
    assert_eq!(run.entry.summary, run.result.summary);
    // The persisted durable row is the full merged entry.
    let persisted = session
        .get_entries()
        .iter()
        .rev()
        .find_map(|entry| match entry {
            FileEntry::Compaction { payload, .. } => Some(payload.clone()),
            _ => None,
        })
        .expect("compaction entry persisted");
    assert_eq!(persisted, run.entry);
    registration.unregister();
}

/// The injected-turn representation drives the compaction walk (the
/// f7 goal-continue differential's shape): a session whose last turn
/// is an injected custom row — ONE representation, the goal-context
/// row, with no duplicate user message — compacts with a whole-turn
/// cut (a single history call, the whole goal turn kept). The
/// double-represented shape the fix removes (the custom row PLUS a
/// user message with the same text, the pre-fix engine branch) shifts
/// the keep-recent crossing and lands the cut mid-turn: a split-turn
/// compaction with an extra turn-prefix summarizer call — the
/// short-session compact TS never makes.
#[tokio::test]
async fn injected_custom_turn_cuts_whole_turns_the_double_row_splits() {
    let registration = faux_registration();
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    let mut session = SessionManager::in_memory(tmp.path());
    let user = |text: &str| {
        AgentMessage::User(pa_types::ai::UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        })
    };
    let reply = |text: &str| {
        AgentMessage::Assistant(AssistantMessage {
            content: vec![pa_types::ai::AssistantContentBlock::Text(
                pa_types::ai::TextContent {
                    text: text.to_string(),
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
        })
    };
    let goal_row = |session: &mut SessionManager| {
        session.append_custom_message(
            "goal_context",
            UserContent::Text("[goal: continuation] keep going".to_string()),
            true,
            Some(serde_json::json!({ "kind": "continuation" })),
        )
    };
    let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> = std::sync::Arc::default();
    let record_summary = |recorder: std::sync::Arc<std::sync::Mutex<Vec<String>>>| {
        pa_ai::faux::FauxResponseStep::Factory(std::sync::Arc::new(
            move |context: &pa_types::ai::Context,
                  _options: Option<&pa_ai::types::StreamOptions>,
                  _call: u64,
                  _model: &pa_types::ai::Model| {
                let text = match &context.messages[0] {
                    pa_types::ai::Message::User(user) => user.content.text(),
                    _ => panic!("expected a user request"),
                };
                recorder.lock().unwrap().push(text);
                Ok(pa_ai::faux::faux_assistant_text_message(
                    "## Summary\nthe session story",
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ))
            },
        ))
    };
    registration.set_responses(vec![record_summary(seen.clone())]);
    let settings = |keep_recent_tokens: u64| super::super::compaction::CompactionSettings {
        keep_recent_tokens,
        ..Default::default()
    };

    // ONE representation (the fixed engine branch): the goal turn is
    // the custom row plus its reply.
    session.append_message(user("seed turn")).unwrap();
    session.append_message(reply("seed reply")).unwrap();
    let kept_goal_row_id = goal_row(&mut session).unwrap();
    session.append_message(reply("goal reply")).unwrap();
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model: model.clone(),
            api_key: None,
            custom_instructions: None,
            settings: settings(2),
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(run) = outcome else {
        panic!("expected the compaction to run");
    };
    // Whole-turn cut: one history call, no turn-prefix call, the
    // entire goal turn (custom row plus reply) kept.
    assert_eq!(
        registration.call_count(),
        1,
        "the whole-turn cut makes one call"
    );
    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].contains("checkpoint summary"));
    assert!(!requests[0].contains("PREFIX of a turn"));
    assert_eq!(run.result.first_kept_entry_id, kept_goal_row_id);
    assert!(
        !run.result.summary.contains("Turn Context (split turn)"),
        "a whole-turn cut never merges a turn context: {summary}",
        summary = run.result.summary
    );

    // The double-represented shape the fix removes (the pre-fix
    // engine branch): the custom row PLUS a user message with the
    // same text. The extra user row shifts the keep-recent crossing
    // and the pull-back lands the cut mid-turn — the extra
    // turn-prefix call TS never makes (the f7 goal-continue split).
    let calls_before = registration.call_count();
    seen.lock().unwrap().clear();
    // Two calls in the doubled shape (history plus the extra
    // turn-prefix summarizer the double row forces).
    registration.set_responses(vec![
        record_summary(seen.clone()),
        record_summary(seen.clone()),
    ]);
    let mut doubled = SessionManager::in_memory(tmp.path());
    doubled.append_message(user("seed turn")).unwrap();
    doubled.append_message(reply("seed reply")).unwrap();
    goal_row(&mut doubled).unwrap();
    doubled
        .append_message(user("[goal: continuation] keep going"))
        .unwrap();
    doubled.append_message(reply("goal reply")).unwrap();
    let outcome = execute_compaction(
        &mut doubled,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: settings(2),
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(run) = outcome else {
        panic!("expected the compaction to run");
    };
    assert_eq!(
        registration.call_count() - calls_before,
        2,
        "the double row splits the turn and makes the extra prefix call"
    );
    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    let prefix_request = requests
        .iter()
        .find(|text| text.contains("PREFIX of a turn"))
        .expect("the double row's turn-prefix call");
    assert!(
        prefix_request.contains("[User]: [goal: continuation] keep going"),
        "the split prefix is the duplicate user row: {prefix_request}"
    );
    assert!(run.result.summary.contains("Turn Context (split turn)"));
    registration.unregister();
}

/// A split turn with no history to summarize makes only the
/// turn-prefix wire call and stands the literal "No prior history."
/// in for the history half (TS
/// `Promise.resolve({ summary: "No prior history." })` — no history
/// wire call), billing only the prefix call.
#[tokio::test]
async fn split_turn_without_history_makes_only_the_prefix_call() {
    let registration = faux_registration();
    let model = registration.get_model();
    let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> = std::sync::Arc::default();
    let recorder = seen.clone();
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Factory(
        std::sync::Arc::new(
            move |context: &pa_types::ai::Context,
                  _options: Option<&pa_ai::types::StreamOptions>,
                  _call: u64,
                  _model: &pa_types::ai::Model| {
                let text = match &context.messages[0] {
                    pa_types::ai::Message::User(user) => user.content.text(),
                    _ => panic!("expected a user request"),
                };
                recorder.lock().unwrap().push(text);
                Ok(pa_ai::faux::faux_assistant_text_message(
                    "the turn prefix summary",
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ))
            },
        ),
    )]);
    let tmp = tempfile::tempdir().unwrap();
    let mut session = SessionManager::in_memory(tmp.path());
    let user = |text: &str| {
        AgentMessage::User(pa_types::ai::UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        })
    };
    let reply = |text: &str| {
        AgentMessage::Assistant(AssistantMessage {
            content: vec![pa_types::ai::AssistantContentBlock::Text(
                pa_types::ai::TextContent {
                    text: text.to_string(),
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
        })
    };
    // One big turn only: the cut splits it, and nothing precedes the
    // turn start, so there is no history to summarize.
    session
        .append_message(user(&format!("big turn {}", "x".repeat(4_000))))
        .unwrap();
    session
        .append_message(reply(&format!("reply {}", "y".repeat(4_000))))
        .unwrap();
    session.append_message(user("small")).unwrap();
    session.append_message(reply("small reply")).unwrap();
    let (cut, _) = compute_cut(&session, 10);
    assert!(cut.is_split_turn);
    assert_eq!(cut.turn_start_index, Some(1));
    let kept_id = session.get_all_entries()[2]
        .id()
        .expect("entry id")
        .to_string();
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 10,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(run) = outcome else {
        panic!("expected the compaction to run");
    };
    // One wire call: only the turn-prefix summary was requested.
    assert_eq!(registration.call_count(), 1);
    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].contains("[User]: big turn"));
    assert!(requests[0].contains("PREFIX of a turn that was too large to keep"));
    // The merged summary stands the literal in for the history half.
    assert_eq!(
        run.result.summary,
        "No prior history.\n\n---\n\n**Turn Context (split turn):**\n\nthe turn prefix summary"
    );
    assert_eq!(run.result.first_kept_entry_id, kept_id);
    // Only the prefix call billed.
    let est = |text: &str| (text.chars().count() as f64 / 4.0).ceil() as u64;
    let prompt = format!(
        "system:{}\n\nuser:{}",
        super::super::compaction_utils::SUMMARIZATION_SYSTEM_PROMPT,
        requests[0]
    );
    let input = est(&prompt);
    let output = est("the turn prefix summary");
    assert_eq!(
        run.result.usage,
        Some(pa_types::ai::Usage {
            input,
            output,
            cache_read: 0,
            cache_write: 0,
            total_tokens: input + output,
            cost: pa_types::ai::UsageCost::default(),
        })
    );
    registration.unregister();
}

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

/// A session compacted twice (the iterative update mode, TS `compact`
/// passing `previousSummary` into the history call): the second
/// compaction's summarizer request carries the update prompt with the
/// prior summary in `<previous-summary>` tags and summarizes only the
/// conversation since the first compaction's boundary — never the
/// history the first compaction already summarized.
#[tokio::test]
async fn second_compaction_updates_the_prior_summary_over_new_history() {
    let registration = faux_registration();
    let model = registration.get_model();
    let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> = std::sync::Arc::default();
    let make_step = |response: &'static str| {
        let seen = seen.clone();
        pa_ai::faux::FauxResponseStep::Factory(std::sync::Arc::new(
            move |context: &pa_types::ai::Context,
                  _options: Option<&pa_ai::types::StreamOptions>,
                  _call: u64,
                  _model: &pa_types::ai::Model| {
                let text = match &context.messages[0] {
                    pa_types::ai::Message::User(user) => user.content.text(),
                    _ => panic!("expected a user request"),
                };
                seen.lock().unwrap().push(text);
                Ok(pa_ai::faux::faux_assistant_text_message(
                    response,
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ))
            },
        ))
    };
    registration.set_responses(vec![
        make_step("the first summary"),
        make_step("the second summary"),
    ]);
    let tmp = tempfile::tempdir().unwrap();
    let mut session = SessionManager::in_memory(tmp.path());
    let user = |text: &str| {
        AgentMessage::User(pa_types::ai::UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        })
    };
    session.append_message(user("turn zero")).unwrap();
    session.append_message(user("turn one")).unwrap();
    session.append_message(user("turn two")).unwrap();
    let settings = super::super::compaction::CompactionSettings {
        keep_recent_tokens: 2,
        ..Default::default()
    };
    // First compaction: the initial checkpoint prompt over turns zero
    // and one, keeping turn two.
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model: model.clone(),
            api_key: None,
            custom_instructions: None,
            settings,
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(first) = outcome else {
        panic!("expected the first compaction to run")
    };
    assert_eq!(first.result.summary, "the first summary");
    let mut requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].contains("Create a structured context checkpoint summary"));
    assert!(requests[0].contains("[User]: turn zero"));
    assert!(!requests[0].contains("<previous-summary>"));

    // New turns after the first compaction.
    session.append_message(user("turn three")).unwrap();
    session.append_message(user("turn four")).unwrap();
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings,
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(second) = outcome else {
        panic!("expected the second compaction to run")
    };
    // One update-mode wire call: the update prompt, the prior summary
    // in <previous-summary> tags, and only the conversation since the
    // first compaction's boundary (turn two was RETAINED by the first
    // compaction, so it is new history; turn zero was summarized away).
    assert_eq!(registration.call_count(), 2);
    requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    let request = &requests[1];
    assert!(request.contains("NEW conversation messages to incorporate"));
    assert!(request.contains("<previous-summary>\nthe first summary\n</previous-summary>"));
    assert!(request.contains("[User]: turn two"));
    assert!(request.contains("[User]: turn three"));
    assert!(!request.contains("[User]: turn zero"));
    assert!(!request.contains("[User]: turn one"));
    // The merged durable entry: the updated summary, the new cut.
    assert_eq!(second.result.summary, "the second summary");
    let kept_id = session
        .get_all_entries()
        .iter()
        .rev()
        .find(|entry| matches!(entry, FileEntry::Message { .. }))
        .and_then(|entry| entry.id())
        .expect("kept entry id")
        .to_string();
    assert_eq!(second.result.first_kept_entry_id, kept_id);
    // Both compactions persisted.
    let compactions = session
        .get_entries()
        .iter()
        .filter_map(|entry| match entry {
            FileEntry::Compaction { payload, .. } => Some(payload.summary.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(compactions, vec!["the first summary", "the second summary"]);
    registration.unregister();
}

/// The second compaction anchors on the kept tail and never
/// re-summarizes the file lists (TS #2385's end-to-end wiring): the
/// stored first summary ends with its mechanically appended file
/// block, but the update request carries a STRIPPED
/// `<previous-summary>` plus the newest retained assistant text in a
/// `<recent-state-anchor>` block, and the fresh file block still
/// appends to the new stored summary — the entry details plus the
/// mechanical append stay the single source of truth.
#[tokio::test]
async fn second_compaction_request_carries_the_anchor_and_strips_file_blocks() {
    let registration = faux_registration();
    let model = registration.get_model();
    let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> = std::sync::Arc::default();
    let make_step = |response: &'static str| {
        let seen = seen.clone();
        pa_ai::faux::FauxResponseStep::Factory(std::sync::Arc::new(
            move |context: &pa_types::ai::Context,
                  _options: Option<&pa_ai::types::StreamOptions>,
                  _call: u64,
                  _model: &pa_types::ai::Model| {
                let text = match &context.messages[0] {
                    pa_types::ai::Message::User(user) => user.content.text(),
                    _ => panic!("expected a user request"),
                };
                seen.lock().unwrap().push(text);
                Ok(pa_ai::faux::faux_assistant_text_message(
                    response,
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ))
            },
        ))
    };
    registration.set_responses(vec![
        make_step("the first summary"),
        make_step("the second summary"),
    ]);
    let tmp = tempfile::tempdir().unwrap();
    let mut session = SessionManager::in_memory(tmp.path());
    let user = |text: &str| {
        AgentMessage::User(pa_types::ai::UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        })
    };
    session.append_message(user("turn zero")).unwrap();
    let mut edit_arguments = serde_json::Map::new();
    edit_arguments.insert("path".to_string(), serde_json::json!("a.rs"));
    session
        .append_message(AgentMessage::Assistant(pa_types::ai::AssistantMessage {
            content: vec![pa_types::ai::AssistantContentBlock::ToolCall(
                pa_types::ai::ToolCall {
                    id: "tc1".to_string(),
                    name: "edit".to_string(),
                    arguments: edit_arguments,
                    thought_signature: None,
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
            stop_reason: pa_types::ai::StopReason::ToolUse,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: serde_json::Map::default(),
        }))
        .unwrap();
    session.append_message(user("turn one")).unwrap();
    session.append_message(user("turn two")).unwrap();
    // First compaction (keep 2: the cut keeps turn two): the edit rides
    // the summarized history, so the stored summary ends with the
    // mechanically appended file block.
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model: model.clone(),
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 2,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(first) = outcome else {
        panic!("expected the first compaction to run")
    };
    assert_eq!(
        first.result.summary,
        "the first summary\n\n<modified-files>\na.rs\n</modified-files>"
    );
    // The initial-prompt path: no previous summary, no anchor.
    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert!(!requests[0].contains("<previous-summary>"));
    assert!(!requests[0].contains("<recent-state-anchor>"));

    // New history after the first compaction, ending with an
    // assistant reply in the kept tail.
    session.append_message(user("turn three")).unwrap();
    session
        .append_message(AgentMessage::Assistant(pa_types::ai::AssistantMessage {
            content: vec![pa_types::ai::AssistantContentBlock::Text(
                pa_types::ai::TextContent {
                    text: "the newest kept reply".to_string(),
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
    session.append_message(user("turn four")).unwrap();
    // Second compaction (keep 10: the cut keeps turn three, the reply,
    // and turn four, so the reply is the newest retained assistant
    // text).
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 10,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(second) = outcome else {
        panic!("expected the second compaction to run")
    };
    assert_eq!(registration.call_count(), 2);
    let request = seen.lock().unwrap().clone()[1].clone();
    // The previous summary strips its file blocks before the update
    // prompt: the lists stop compounding across compactions.
    assert!(request.contains("<previous-summary>\nthe first summary\n</previous-summary>"));
    assert!(!request.contains("<modified-files>"));
    assert!(!request.contains("<read-files>"));
    // The newest retained assistant text anchors the update after the
    // previous summary (the turn-prefix arm never carries one).
    let previous_end = request
        .find("</previous-summary>")
        .expect("previous summary block");
    let anchor_start = request.find("<recent-state-anchor>").expect("anchor block");
    assert!(anchor_start > previous_end);
    assert!(request.contains("\n\nthe newest kept reply\n</recent-state-anchor>\n\n"));
    // The fresh file block still rides the NEW stored summary: the
    // entry details plus the mechanical append are the single source
    // of truth for file lists.
    assert_eq!(
        second.result.summary,
        "the second summary\n\n<modified-files>\na.rs\n</modified-files>"
    );
    registration.unregister();
}

/// A split-turn cut after a prior compaction (the iterative update
/// mode on the split path, #225's note): the history call runs in
/// update mode over the conversation since the boundary, while the
/// turn-prefix call stays a plain prefix summary — never the previous
/// summary.
#[tokio::test]
async fn second_compaction_split_turn_history_updates_prefix_does_not() {
    let registration = faux_registration();
    let model = registration.get_model();
    let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> = std::sync::Arc::default();
    let make_step = |response: &'static str| {
        let seen = seen.clone();
        pa_ai::faux::FauxResponseStep::Factory(std::sync::Arc::new(
            move |context: &pa_types::ai::Context,
                  _options: Option<&pa_ai::types::StreamOptions>,
                  _call: u64,
                  _model: &pa_types::ai::Model| {
                let text = match &context.messages[0] {
                    pa_types::ai::Message::User(user) => user.content.text(),
                    _ => panic!("expected a user request"),
                };
                seen.lock().unwrap().push(text);
                Ok(pa_ai::faux::faux_assistant_text_message(
                    response,
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ))
            },
        ))
    };
    registration.set_responses(vec![
        make_step("the first summary"),
        make_step("the updated history summary"),
        make_step("the turn prefix summary"),
    ]);
    let tmp = tempfile::tempdir().unwrap();
    let mut session = SessionManager::in_memory(tmp.path());
    let user = |text: &str| {
        AgentMessage::User(pa_types::ai::UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        })
    };
    let reply = |text: &str| {
        AgentMessage::Assistant(AssistantMessage {
            content: vec![pa_types::ai::AssistantContentBlock::Text(
                pa_types::ai::TextContent {
                    text: text.to_string(),
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
        })
    };
    session.append_message(user("turn zero")).unwrap();
    session.append_message(user("turn one")).unwrap();
    let settings = super::super::compaction::CompactionSettings {
        keep_recent_tokens: 1,
        ..Default::default()
    };
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model: model.clone(),
            api_key: None,
            custom_instructions: None,
            settings,
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    assert!(matches!(outcome, CompactOutcome::Ran(_)));

    // A small retained turn, then a big turn the cut splits: the cut
    // lands mid big turn (keep budget 10), with the first compaction's
    // retained turns as the history and the big turn's user message as
    // the split prefix.
    session.append_message(user("kept small turn")).unwrap();
    session.append_message(reply("small kept reply")).unwrap();
    session
        .append_message(user(&format!("big turn {}", "x".repeat(4_000))))
        .unwrap();
    session
        .append_message(reply(&format!("reply {}", "y".repeat(4_000))))
        .unwrap();
    session.append_message(user("final small turn")).unwrap();
    session.append_message(reply("final reply")).unwrap();
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 10,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(second) = outcome else {
        panic!("expected the second compaction to run")
    };
    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 3);
    // The history call: update mode over the conversation since the
    // first compaction's boundary (turn one was retained, kept small
    // turn, small kept reply) — with the previous summary; turn zero
    // was summarized away and never reappears.
    let history_request = requests
        .iter()
        .find(|text| text.contains("NEW conversation messages to incorporate"))
        .expect("history call in update mode");
    assert!(history_request.contains("<previous-summary>\nthe first summary\n</previous-summary>"));
    assert!(history_request.contains("[User]: turn one"));
    assert!(history_request.contains("[User]: kept small turn"));
    assert!(!history_request.contains("[User]: turn zero"));
    // The turn-prefix call: its own instruction, never the update
    // prompt or the previous summary.
    let prefix_request = requests
        .iter()
        .find(|text| text.contains("PREFIX of a turn"))
        .expect("turn-prefix call");
    assert!(prefix_request.contains("[User]: big turn"));
    assert!(!prefix_request.contains("<previous-summary>"));
    assert!(!prefix_request.contains("NEW conversation messages to incorporate"));
    // The merged summary carries the split marker behind the updated
    // history summary.
    assert_eq!(
        second.result.summary,
        "the updated history summary\n\n---\n\n**Turn Context (split turn):**\n\nthe turn prefix summary"
    );
    registration.unregister();
}

#[tokio::test]
async fn execute_compaction_persists_and_rebuilds() {
    let registration = faux_registration();
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    let result = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: Some("focus on the goal"),
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 20,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(run) = result else {
        panic!("expected the compaction to run");
    };
    assert!(run.result.summary.contains("summarized goal"));
    assert!(run.result.usage.is_some());
    assert_eq!(run.entry.summary, run.result.summary);
    // A user-message cut is not a split turn: exactly one summarizer
    // wire call, and no split marker in the merged summary.
    assert_eq!(registration.call_count(), 1);
    assert!(!run.result.summary.contains("Turn Context (split turn)"));
    // The compaction entry persisted on the session.
    assert!(session
        .get_entries()
        .iter()
        .any(|entry| matches!(entry, FileEntry::Compaction { .. })));
    // The live context keeps the summary role; provider conversion
    // still formats it as a user turn.
    let rebuilt = rebuilt_context_after_compaction(&session);
    assert!(!rebuilt.is_empty());
    assert!(matches!(&rebuilt[0], AgentMessage::CompactionSummary(_)));
    let provider_messages = super::super::messages::convert_to_llm(&rebuilt);
    match &provider_messages[0] {
        AgentMessage::User(user) => {
            assert!(user.content.text().contains("[compaction-summary]"));
        }
        other => panic!("expected summary user message, got {other:?}"),
    }
    registration.unregister();
}

#[tokio::test]
async fn rebuilt_live_context_prevents_repeat_auto_compaction_until_new_usage() {
    let registration = faux_registration();
    registration.set_responses(vec![
        pa_ai::faux::FauxResponseStep::Message(pa_ai::faux::faux_assistant_text_message(
            "## Goal\nsummarized goal",
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        )),
        pa_ai::faux::FauxResponseStep::Message(pa_ai::faux::faux_assistant_text_message(
            "## Turn Context\nsummarized prefix",
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        )),
    ]);
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    let mut assistant = match session.active_context().messages.last().unwrap() {
        AgentMessage::Assistant(assistant) => assistant.clone(),
        other => panic!("expected last assistant, got {other:?}"),
    };
    assistant.usage.input = 126_010;
    assistant.usage.total_tokens = 126_010;
    assistant.timestamp = 1;
    session
        .append_message(AgentMessage::User(pa_types::ai::UserMessage {
            content: UserContent::Text("threshold crossing turn".to_string()),
            timestamp: 0,
            rest: Map::default(),
        }))
        .unwrap();
    session
        .append_message(AgentMessage::Assistant(assistant.clone()))
        .unwrap();
    let settings = super::super::compaction::CompactionSettings {
        reserve_tokens: 127_500,
        keep_recent_tokens: 20,
        ..Default::default()
    };
    assert!(super::super::compaction::threshold_compaction_due(
        &session.active_context().messages,
        128_000,
        0,
        &settings
    ));
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings,
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    assert!(matches!(outcome, CompactOutcome::Ran(_)));
    let mut live = rebuilt_context_after_compaction(&session);
    let summary_timestamp = match &live[0] {
        AgentMessage::CompactionSummary(summary) => summary.timestamp,
        other => panic!("expected live compaction boundary, got {other:?}"),
    };
    assert!(live.iter().any(|message| matches!(
        message,
        AgentMessage::Assistant(assistant) if assistant.usage.total_tokens == 126_010
    )));
    // Cross the same session/agent wire boundary as `set_messages` and
    // `auto_compaction_due`: the live role must survive both round trips.
    let loop_messages: Vec<pa_agent::types::AgentMessage> = live
        .iter()
        .map(|message| {
            super::super::session_message_to_loop(message)
                .expect("session message must convert to loop message")
        })
        .collect();
    live = loop_messages
        .iter()
        .map(|message| serde_json::to_value(message).expect("loop message must serialize"))
        .map(|value| serde_json::from_value(value).expect("loop message must deserialize"))
        .collect();
    assert!(matches!(&live[0], AgentMessage::CompactionSummary(_)));
    assert!(live.iter().any(|message| matches!(
        message,
        AgentMessage::Assistant(assistant) if assistant.usage.total_tokens == 126_010
    )));
    for (custom_type, text) in [
        ("agent_message", "message from agent"),
        ("ipython_state", "kernel survived compaction"),
    ] {
        live.push(AgentMessage::Custom(pa_types::session::CustomMessage {
            custom_type: custom_type.to_string(),
            content: UserContent::Text(text.to_string()),
            display: true,
            details: None,
            timestamp: summary_timestamp + 1,
            rest: Map::default(),
        }));
    }
    assert!(!super::super::compaction::threshold_compaction_due(
        &live, 128_000, 0, &settings
    ));
    assistant.timestamp = summary_timestamp + 2;
    live.push(AgentMessage::Assistant(assistant));
    assert!(super::super::compaction::threshold_compaction_due(
        &live, 128_000, 0, &settings
    ));
    registration.unregister();
}

/// The live summary-delta sink receives every summarizer text delta
/// as the model generates it (the daemon's `compaction_summary_delta`
/// broadcast): the deltas arrive in order, their concatenation is the
/// generated summary, and the final result still comes from the
/// terminal assistant message — the sink never gates the run, and
/// `None` keeps the one-shot completion untouched.
#[tokio::test]
async fn execute_compaction_streams_summary_deltas_to_the_sink() {
    let registration = faux_registration();
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    let deltas: std::sync::Arc<std::sync::Mutex<Vec<String>>> = std::sync::Arc::default();
    let sink_deltas = std::sync::Arc::clone(&deltas);
    let sink: SummaryDeltaSink = std::sync::Arc::new(move |delta| {
        sink_deltas.lock().unwrap().push(delta.to_string());
    });
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 20,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: Some(sink),
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(run) = outcome else {
        panic!("expected the compaction to run");
    };
    let deltas = deltas.lock().unwrap().join("");
    // The streamed deltas concatenate to exactly the generated
    // summary text (the faux provider chunks the scripted response
    // into provider-sized pieces; the sink receives each chunk).
    assert!(!deltas.is_empty(), "the sink saw at least one delta");
    assert_eq!(deltas, "## Goal\nsummarized goal");
    // The convergence invariant: a client accumulating every delta
    // holds exactly the committed summary the settled end carries.
    assert_eq!(deltas, run.result.summary);
    registration.unregister();
}

/// A split-turn compaction keeps the live stream in final order: the
/// history summary streams live (its own wire call, in order), the
/// concurrent turn-prefix call never streams its raw chunks (they
/// would interleave out of final order), and the split marker with
/// the completed prefix flushes through the sink as the final chunk —
/// so the accumulated stream converges to exactly the committed
/// summary (history, split marker, turn prefix), never a garbled
/// mixture.
#[tokio::test]
async fn split_turn_compaction_streams_in_final_order_and_converges() {
    let registration = faux_registration();
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    let mut session = SessionManager::in_memory(tmp.path());
    let user = |text: &str| {
        AgentMessage::User(pa_types::ai::UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: Map::default(),
        })
    };
    let reply = |text: &str| {
        AgentMessage::Assistant(AssistantMessage {
            content: vec![pa_types::ai::AssistantContentBlock::Text(
                pa_types::ai::TextContent {
                    text: text.to_string(),
                    text_signature: None,
                    rest: Map::default(),
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
            rest: Map::default(),
        })
    };
    session.append_message(user("turn one")).unwrap();
    session.append_message(reply("reply one")).unwrap();
    session
        .append_message(user(&format!("big turn {}", "x".repeat(4_000))))
        .unwrap();
    session
        .append_message(reply(&format!("reply {}", "y".repeat(4_000))))
        .unwrap();
    session.append_message(user("turn three")).unwrap();
    session.append_message(reply("reply three")).unwrap();
    // The tiny keep-recent budget lands the cut on the big turn's
    // assistant reply — a mid-turn (split) cut.
    let (cut, _) = compute_cut(&session, 10);
    assert!(cut.is_split_turn);

    // Two scripted summaries (the factories answer in issue order,
    // whichever call reaches the faux provider first).
    registration.set_responses(vec![
        pa_ai::faux::FauxResponseStep::Message(pa_ai::faux::faux_assistant_text_message(
            "the history summary",
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        )),
        pa_ai::faux::FauxResponseStep::Message(pa_ai::faux::faux_assistant_text_message(
            "the turn prefix summary",
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        )),
    ]);
    let deltas: std::sync::Arc<std::sync::Mutex<Vec<String>>> = std::sync::Arc::default();
    let sink_deltas = std::sync::Arc::clone(&deltas);
    let sink: SummaryDeltaSink = std::sync::Arc::new(move |delta| {
        sink_deltas.lock().unwrap().push(delta.to_string());
    });
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 10,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: Some(sink),
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(run) = outcome else {
        panic!("expected the compaction to run");
    };
    assert_eq!(registration.call_count(), 2, "both wire calls ran");
    // The committed summary decides which scripted response became
    // the history and which the prefix (the factories answer in
    // issue order, so the split marker's two halves identify them).
    let summary = &run.result.summary;
    let marker = "\n\n---\n\n**Turn Context (split turn):**\n\n";
    let split = summary
        .split_once(marker)
        .unwrap_or_else(|| panic!("the committed summary carries the split marker: {summary:?}"));
    let (history_text, prefix_text) = (split.0, split.1);
    // The factories answer in issue order, so whichever scripted
    // response the concurrent calls took is decided by the committed
    // summary itself — the two halves are the two scripted texts.
    let mut scripted = vec!["the history summary", "the turn prefix summary"];
    scripted.sort_unstable();
    let mut committed = vec![history_text, prefix_text];
    committed.sort_unstable();
    assert_eq!(committed, scripted);

    let deltas = deltas.lock().unwrap().clone();
    // Only the flush carries the split marker, and it is the final
    // chunk (the prefix call's raw chunks never hit the sink).
    let marker_positions: Vec<usize> = deltas
        .iter()
        .enumerate()
        .filter(|(_, delta)| delta.contains(marker))
        .map(|(index, _)| index)
        .collect();
    assert_eq!(
        marker_positions,
        vec![deltas.len() - 1],
        "the split marker rides exactly one chunk, the final flush: {deltas:?}"
    );
    // Everything before the flush is pure history summary — the
    // live view reads as the history generating, in order.
    let live_history = deltas[..deltas.len() - 1].concat();
    // The live view reads as the history summary generating, in
    // order: a raw prefix chunk interleaving here would break the
    // equality (the scripted texts differ).
    assert_eq!(live_history, history_text, "deltas: {deltas:?}");
    // The convergence invariant: the accumulated stream IS the
    // committed summary (history, split marker, turn prefix).
    assert_eq!(deltas.concat(), *summary);
    registration.unregister();
}

/// The harness digest snapshot rides the durable compaction row (TS
/// `_performCompaction` -> `appendCompaction(..., this._harnessDigest())`):
/// the harness-state disk read happens at the commit, so state written
/// after the inputs were captured (mid-run, the TS test's "written
/// before compaction" memory) is a fresh read, the digest never flows
/// through the summarizer, and the rebuilt context leads with the
/// digest block before the compaction summary.
#[tokio::test]
async fn execute_compaction_attaches_harness_digest_snapshot() {
    let registration = faux_registration();
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    let global_dir = tmp.path().join("agent").join("harness");
    let local_dir = tmp
        .path()
        .join("session-artifacts")
        .join("s1")
        .join("harness");
    // Inputs captured before the run (the live-session half); no
    // harness state exists yet.
    let inputs = super::super::harness_digest::HarnessDigestInputs {
        context: super::super::harness_digest::HarnessDigestContext {
            global_dir: global_dir.clone(),
            local_dir: Some(local_dir.clone()),
            include_ipython: true,
            include_shell_examples: true,
            include_refine: true,
        },
        terms: super::super::harness_digest::digest_query_terms(None, &[]),
    };
    // Harness state written after the inputs were captured — the
    // digest must still see it (fresh disk read at the commit).
    let mut state = crate::refinement::empty_harness_state();
    state
        .entries
        .get_mut(&crate::refinement::RefinementKind::Memory)
        .unwrap()
        .insert(
            "compaction_test_memory".to_string(),
            crate::refinement::HarnessEntry {
                id: "compaction_test_memory".to_string(),
                kind: crate::refinement::RefinementKind::Memory,
                title: "Compaction test memory".to_string(),
                content: "Written before compaction.".to_string(),
                path: "general".to_string(),
                scope: Some(crate::refinement::HarnessScope::Local),
                reference: serde_json::Map::default(),
                arguments: serde_json::Map::default(),
                metadata: serde_json::Map::default(),
                source: "refine".to_string(),
                created_at: "2026-09-07T00:00:00.000Z".to_string(),
                updated_at: "2026-09-07T00:00:00.000Z".to_string(),
                version: 1,
            },
        );
    crate::refinement::save_harness_state(&local_dir, &state).unwrap();
    let result = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 20,
                ..Default::default()
            },
            abort: None,
            harness_digest: Some(inputs),
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(run) = result else {
        panic!("expected the compaction to run");
    };
    let digest = run
        .entry
        .harness_digest
        .as_deref()
        .expect("digest snapshot");
    assert!(digest.contains("Compaction test memory"));
    // Mechanical attachment: the digest never flows through the summarizer.
    assert!(!run.entry.summary.contains("# Continual Harness State"));
    // The durable row carries the TS wire shape (`harnessDigest`) plus
    // the fingerprint of the state behind it (`harnessStateFingerprint`,
    // TS #2400): one state read feeds the digest and the fingerprint.
    let serialized = serde_json::to_value(&run.entry).unwrap();
    assert_eq!(
        serialized
            .get("harnessDigest")
            .and_then(|value| value.as_str()),
        Some(digest)
    );
    let fingerprint = run
        .entry
        .harness_state_fingerprint
        .as_deref()
        .expect("digest state fingerprint");
    assert_eq!(
        serialized
            .get("harnessStateFingerprint")
            .and_then(|value| value.as_str()),
        Some(fingerprint)
    );
    // The fingerprint is the merged-state fingerprint the digest
    // rendered: rewriting the state (same content, new timestamps)
    // must not move it, and a real content change must.
    let inputs = super::super::harness_digest::HarnessDigestInputs {
        context: super::super::harness_digest::HarnessDigestContext {
            global_dir,
            local_dir: Some(local_dir.clone()),
            include_ipython: true,
            include_shell_examples: true,
            include_refine: true,
        },
        terms: super::super::harness_digest::digest_query_terms(Some("fresh terms"), &[]),
    };
    let re_rendered = inputs.render_with_fingerprint();
    assert_eq!(re_rendered.state_fingerprint, fingerprint);
    state
        .entries
        .get_mut(&crate::refinement::RefinementKind::Memory)
        .unwrap()
        .get_mut("compaction_test_memory")
        .unwrap()
        .content
        .push_str(" changed");
    crate::refinement::save_harness_state(&local_dir, &state).unwrap();
    let changed = inputs.render_with_fingerprint();
    assert_ne!(changed.state_fingerprint, fingerprint);
    // Provider conversion leads with the digest block before the
    // compaction summary; the live context keeps the summary marker.
    let rebuilt = rebuilt_context_after_compaction(&session);
    assert!(matches!(&rebuilt[0], AgentMessage::CompactionSummary(_)));
    let provider_messages = super::super::messages::convert_to_llm(&rebuilt);
    let AgentMessage::User(user) = &provider_messages[0] else {
        panic!("expected compaction head user message");
    };
    let text = user.content.text();
    let digest_at = text
        .find("[harness-digest]")
        .expect("digest block leads the compaction head");
    let summary_at = text
        .find("[compaction-summary]")
        .expect("compaction summary follows");
    assert!(digest_at < summary_at);
    assert!(text.contains("Compaction test memory"));
    registration.unregister();
}

/// An error-stop summarizer response fails the compaction (TS throws
/// `Summarization failed: ...`), never an empty-summary success.
#[tokio::test]
async fn execute_compaction_fails_on_an_error_summarizer_response() {
    let registration = faux_registration();
    let model = registration.get_model();
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
        pa_ai::faux::faux_assistant_text_message(
            "",
            pa_ai::faux::FauxAssistantMessageOptions {
                stop_reason: Some(pa_types::ai::StopReason::Error),
                error_message: Some("summarizer exploded".to_string()),
                ..Default::default()
            },
        ),
    )]);
    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    let error = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 20,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Summarization failed: summarizer exploded"
    );
    // No compaction entry persisted for the failed run.
    assert!(session
        .get_entries()
        .iter()
        .all(|entry| !matches!(entry, FileEntry::Compaction { .. })));
    registration.unregister();
}

/// An already-aborted signal cancels the run before any summarizer
/// request (TS `throwIfAborted` at the top of the provider call):
/// the abort marker error surfaces and nothing commits.
#[tokio::test]
async fn execute_compaction_with_pre_aborted_signal_never_runs_the_summarizer() {
    let registration = faux_registration();
    let model = registration.get_model();
    let controller = pa_agent::abort::AbortController::new();
    controller.abort();
    let signal = controller.signal();
    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    let error = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 20,
                ..Default::default()
            },
            abort: Some(&signal),
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap_err();
    assert!(pa_agent::abort::is_abort_error(&error), "{error:#}");
    assert!(session
        .get_entries()
        .iter()
        .all(|entry| !matches!(entry, FileEntry::Compaction { .. })));
    registration.unregister();
}

/// A signal that aborts while the summarizer is in flight cancels the
/// run before it commits (TS `_performCompaction`'s
/// `if (signal.aborted) throw` between the summary and the ledger):
/// the summarizer's resolved summary never lands as a compaction
/// entry.
#[tokio::test]
async fn execute_compaction_with_late_abort_cancels_before_the_commit() {
    let registration = faux_registration();
    let model = registration.get_model();
    // The delayed response holds the summarizer in flight while the
    // abort lands mid-run.
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Delayed {
        message: pa_ai::faux::faux_assistant_text_message(
            "## Goal\nsummarized goal",
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        ),
        delay_ms: 200,
    }]);
    let controller = pa_agent::abort::AbortController::new();
    let signal = controller.signal();
    let aborter = {
        let controller = controller.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            controller.abort();
        })
    };
    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    let error = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 20,
                ..Default::default()
            },
            abort: Some(&signal),
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap_err();
    aborter.await.unwrap();
    assert!(pa_agent::abort::is_abort_error(&error), "{error:#}");
    assert!(
        session
            .get_entries()
            .iter()
            .all(|entry| !matches!(entry, FileEntry::Compaction { .. })),
        "the late abort never commits the compaction"
    );
    registration.unregister();
}

#[tokio::test]
async fn execute_compaction_skips_short_sessions() {
    let registration = faux_registration();
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    // Three small turns fit inside the keep-recent budget: nothing to
    // summarize, so compaction skips (TS prepareCompaction).
    let mut session = session_with_turns(tmp.path(), 3);
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings::default(),
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        outcome,
        CompactOutcome::Skipped("Session is too short to compact — try again once it grows")
    );
    assert!(session
        .get_entries()
        .iter()
        .all(|entry| !matches!(entry, FileEntry::Compaction { .. })));
    registration.unregister();
}

#[tokio::test]
async fn execute_compaction_skips_when_already_compacted() {
    let registration = faux_registration();
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    session
        .append_compaction(pa_types::session::CompactionEntry {
            summary: "summary".to_string(),
            first_kept_entry_id: "e1".to_string(),
            tokens_before: 100,
            ..Default::default()
        })
        .unwrap();
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 200,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(outcome, CompactOutcome::Skipped("Already compacted"));
    registration.unregister();
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

/// The durable row carries the full TS `CompactionEntry` record:
/// `fromHook: false` (the built-in origin), the summarizer usage, and
/// the file-operation details — not just the summary boundary.
#[tokio::test]
async fn durable_compaction_row_carries_the_ts_record() {
    let registration = faux_registration();
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    let mut session = session_with_turns(tmp.path(), 3);
    let before = context_tokens(session.get_all_entries(), session.get_leaf_id());
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 20,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: None,
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(run) = outcome else {
        panic!("expected the compaction to run");
    };
    assert_eq!(run.entry.from_hook, Some(false));
    assert_eq!(run.entry.usage, run.result.usage);
    assert_eq!(run.entry.tokens_before, before);
    // The persisted session record is the full entry, byte-for-byte
    // (TS `appendCompaction` stores the same record it returns).
    let persisted = session
        .get_entries()
        .iter()
        .rev()
        .find_map(|entry| match entry {
            FileEntry::Compaction { payload, .. } => Some(payload.clone()),
            _ => None,
        })
        .expect("compaction entry persisted");
    assert_eq!(persisted, run.entry);
}

/// An aux context whose settings pin one `auxiliaryModel` selector.
fn aux_context(
    dir: &std::path::Path,
    selector: Option<&str>,
) -> crate::session_engine::auxiliary_model::AuxiliaryModelContext {
    std::fs::write(
        dir.join("settings.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "auxiliaryModel": selector,
        }))
        .unwrap(),
    )
    .unwrap();
    crate::session_engine::auxiliary_model::AuxiliaryModelContext {
        cwd: dir.to_path_buf(),
        agent_dir: dir.to_path_buf(),
    }
}

/// The routing context present with a selector equal to the session
/// model keeps the session model: the compaction's wire call serves
/// on the session model (the faux factory records the model).
#[tokio::test]
async fn compaction_auxiliary_selector_equal_to_the_session_model_runs_on_the_session_model() {
    let registration = faux_registration();
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    let aux = aux_context(tmp.path(), Some("faux/compact-m"));
    let mut session = session_with_turns(tmp.path(), 3);
    let seen_models: std::sync::Arc<std::sync::Mutex<Vec<String>>> = std::sync::Arc::default();
    let recorder = seen_models.clone();
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Factory(
        std::sync::Arc::new(
            move |_context: &pa_types::ai::Context,
                  _options: Option<&pa_ai::types::StreamOptions>,
                  _call: u64,
                  model: &pa_types::ai::Model| {
                recorder.lock().unwrap().push(model.id.clone());
                Ok(pa_ai::faux::faux_assistant_text_message(
                    "the summary",
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ))
            },
        ),
    )]);
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 20,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: Some(&aux),
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    assert!(matches!(outcome, CompactOutcome::Ran(_)));
    assert_eq!(seen_models.lock().unwrap().as_slice(), ["compact-m"]);
    registration.unregister();
}

/// A selector that resolves to no model (unusable) falls back to the
/// session model with a warning: the compaction still runs.
#[tokio::test]
async fn compaction_auxiliary_selector_unusable_falls_back_to_the_session_model() {
    let registration = faux_registration();
    let model = registration.get_model();
    let tmp = tempfile::tempdir().unwrap();
    let aux = aux_context(tmp.path(), Some("testaux/missing-model"));
    let mut session = session_with_turns(tmp.path(), 3);
    let seen_models: std::sync::Arc<std::sync::Mutex<Vec<String>>> = std::sync::Arc::default();
    let recorder = seen_models.clone();
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Factory(
        std::sync::Arc::new(
            move |_context: &pa_types::ai::Context,
                  _options: Option<&pa_ai::types::StreamOptions>,
                  _call: u64,
                  model: &pa_types::ai::Model| {
                recorder.lock().unwrap().push(model.id.clone());
                Ok(pa_ai::faux::faux_assistant_text_message(
                    "the summary",
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ))
            },
        ),
    )]);
    let outcome = execute_compaction(
        &mut session,
        CompactOptions {
            model,
            api_key: None,
            custom_instructions: None,
            settings: super::super::compaction::CompactionSettings {
                keep_recent_tokens: 20,
                ..Default::default()
            },
            abort: None,
            harness_digest: None,
            auxiliary: Some(&aux),
            summary_delta: None,
        },
    )
    .await
    .unwrap();
    let CompactOutcome::Ran(run) = outcome else {
        panic!("expected the compaction to run on the fallback model");
    };
    assert_eq!(run.result.summary, "the summary");
    assert_eq!(seen_models.lock().unwrap().as_slice(), ["compact-m"]);
    registration.unregister();
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
