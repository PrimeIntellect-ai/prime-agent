//! Compact-session tests, the second-compaction family (moved with
//! their concerns): the iterative update mode — the prior summary
//! riding the history call, the stripped previous summary plus
//! recency anchor, and the split-turn arm whose prefix call never
//! carries the previous summary.
use super::*;

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
