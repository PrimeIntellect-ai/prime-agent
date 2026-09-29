//! Compact-session tests, the split-turn family (moved with their
//! concerns): the mid-turn cut's two summarizer calls and merged
//! turn context, the injected-custom-turn whole-turn cut, and the
//! no-history prefix-only arm.
use super::*;

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
