use super::*;
use crate::chat::StatusKind;
use serde_json::json;

fn test_view() -> crate::view::AgentView {
    crate::view::AgentView::new(crate::theme::Theme::builtin(
        "prime",
        crate::theme::ColorMode::TrueColor,
    ))
}

fn card_of(view: &crate::view::AgentView) -> Option<&ToolCallCard> {
    view.chat.iter().find_map(|entry| match entry {
        ChatEntry::Tool(card) => Some(card.as_ref()),
        _ => None,
    })
}

fn cards_of(view: &crate::view::AgentView) -> Vec<ToolCallCard> {
    view.chat
        .iter()
        .filter_map(|entry| match entry {
            ChatEntry::Tool(card) => Some((**card).clone()),
            _ => None,
        })
        .collect()
}

fn rendered_card_text(view: &crate::view::AgentView) -> Vec<String> {
    let Some(card) = card_of(view) else {
        return Vec::new();
    };
    crate::tool_card::render_tool_card(
        card,
        0,
        crate::chat::Detail::Overview,
        &view.theme,
        100,
        true,
    )
    .iter()
    .map(|line| line.iter().map(|span| span.content.as_str()).collect())
    .collect()
}

#[test]
fn image_only_user_message_shows_the_image_placeholder() {
    let message = json!({
        "role": "user",
        "content": [
            { "type": "image", "data": "QUJD", "mimeType": "image/png" }
        ]
    });
    assert_eq!(user_display_text(&message), Some("[image]".to_string()));
    assert_eq!(
        message_value_to_entries(&message),
        vec![ChatEntry::User {
            text: "[image]".to_string()
        }]
    );
}

#[test]
fn a_skill_block_user_message_decodes_to_the_card() {
    let message = json!({
        "role": "user",
        "content": "<skill name=\"websearch\" location=\"/s/SKILL.md\">\nRun one query.\n</skill>\n\nfind parity tuis"
    });
    let entries = message_value_to_entries(&message);
    assert!(
        matches!(
            entries.as_slice(),
            [
                ChatEntry::SkillInvocation(card),
                ChatEntry::User { text }
            ] if card.name == "websearch"
                && card.content == "Run one query."
                && text == "find parity tuis"
        ),
        "entries: {entries:?}"
    );
}

#[test]
fn user_message_with_text_and_image_keeps_the_text() {
    let message = json!({
        "role": "user",
        "content": [
            { "type": "text", "text": "look at this" },
            { "type": "image", "data": "QUJD", "mimeType": "image/png" }
        ]
    });
    assert_eq!(
        user_display_text(&message),
        Some("look at this".to_string())
    );
}

#[test]
fn empty_user_message_renders_no_entry() {
    let message = json!({ "role": "user", "content": [] });
    assert_eq!(user_display_text(&message), None);
    assert!(message_value_to_entries(&message).is_empty());
}

#[test]
fn transcript_presents_the_summary_after_the_retained_tail() {
    let messages = vec![
        json!({
            "role": "compactionSummary", "summary": "the story",
            "retainedMessageCount": 2, "tokensBefore": 12, "timestamp": 30u64
        }),
        json!({"role": "user", "content": "second turn", "timestamp": 20u64}),
        json!({"role": "assistant", "content": "kept intact", "timestamp": 25u64}),
        json!({
            "role": "custom", "customType": "session_slash_command",
            "content": "/compact focus on the goal", "display": true, "timestamp": 40u64,
            "details": { "command": {
                "name": "compact",
                "args": "focus on the goal",
                "text": "/compact focus on the goal"
            } }
        }),
    ];
    let entries = transcript_to_entries(&messages);
    let order: Vec<String> = entries
        .iter()
        .filter_map(|entry| match entry {
            ChatEntry::User { .. } => Some("user".to_string()),
            ChatEntry::Assistant { .. } => Some("assistant".to_string()),
            ChatEntry::CompactionSummary { .. } => Some("summary".to_string()),
            ChatEntry::SlashCommand { .. } => Some("slash".to_string()),
            _ => None,
        })
        .collect();
    assert_eq!(order, ["user", "assistant", "summary", "slash"]);
}

#[test]
fn unnamed_streamed_tool_call_renders_code_once_named() {
    let mut view = test_view();
    apply_streamed_tool_card(&mut view, "call-1", "", &json!({ "code": "fibonacci(23)" }));
    assert!(
        card_of(&view).is_none(),
        "a call without a streamed name renders no card yet"
    );
    apply_streamed_tool_card(
        &mut view,
        "call-1",
        "python_repl",
        &json!({ "code": "fibonacci(23)" }),
    );
    let card = card_of(&view).expect("the named frame creates the card");
    assert_eq!(card.name, "python_repl");
    assert!(card.args.get("code").is_some(), "args stream into the card");
    let rows = rendered_card_text(&view);
    assert!(
        rows.iter()
            .any(|row| row.contains("python") && row.contains("fibonacci(23)")),
        "the python_repl card renders the code preview: {rows:?}"
    );
    assert!(
        rows.iter()
            .all(|row| !row.contains("\"code\"") && !row.contains('{')),
        "the raw arguments JSON must not render: {rows:?}"
    );
}

#[test]
fn failed_frame_sweep_settles_pending_tool_cards() {
    let mut view = test_view();
    apply_streamed_tool_card(
        &mut view,
        "call-1",
        "bash",
        &json!({ "command": "sleep 10" }),
    );
    apply_tool_execution_start(&mut view, "call-1", "bash", Value::Null);
    let mut pending = std::collections::HashSet::from(["call-1".to_string()]);
    let mut aborted = std::collections::HashSet::new();
    settle_pending_tool_cards(
        &mut view,
        &mut pending,
        &mut aborted,
        "Operation aborted \u{00b7} 3s",
    );
    assert!(pending.is_empty(), "the sweep drains the pending set");
    assert_eq!(
        aborted,
        std::collections::HashSet::from(["call-1".to_string()]),
        "the sweep records the settled ids"
    );
    let card = card_of(&view).expect("the streamed card");
    assert!(card.aborted, "the settled card flags the abort");
    let result = card.result.as_ref().expect("the settle result");
    assert!(result.is_error, "the settle result is an error");
    assert_eq!(result.text_output(false), "Operation aborted \u{00b7} 3s");
    assert!(!card.result_partial, "the settle result is final");
    assert!(card.ended_at.is_some(), "the settle stamps the card ended");
}

#[test]
fn reused_id_after_abort_re_arms_as_a_fresh_card() {
    let mut view = test_view();
    apply_streamed_tool_card(
        &mut view,
        "call-1",
        "bash",
        &json!({ "command": "sleep 10" }),
    );
    apply_tool_execution_start(&mut view, "call-1", "bash", Value::Null);
    let mut pending = std::collections::HashSet::from(["call-1".to_string()]);
    let mut aborted = std::collections::HashSet::new();
    settle_pending_tool_cards(
        &mut view,
        &mut pending,
        &mut aborted,
        "Operation aborted \u{00b7} 3s",
    );
    let settled = cards_of(&view);
    apply_streamed_tool_card(
        &mut view,
        "call-1",
        "bash",
        &json!({ "command": "echo ready" }),
    );
    let cards = cards_of(&view);
    assert_eq!(cards.len(), 2, "two cards: {cards:?}");
    assert!(cards[0].aborted, "the old card keeps its abort");
    assert_eq!(
        cards[0]
            .result
            .as_ref()
            .expect("the settle result")
            .text_output(false),
        "Operation aborted \u{00b7} 3s"
    );
    assert!(!cards[1].aborted, "the new card starts fresh");
    assert_eq!(cards[1].result, None, "the new card has no result");
    assert_eq!(cards[1].args.get("command"), Some(&json!("echo ready")));
    apply_tool_execution_start(&mut view, "call-1", "bash", Value::Null);
    let cards = cards_of(&view);
    assert_eq!(cards[0], settled[0], "the settled card is untouched");
    assert!(cards[1].started, "the fresh card runs");
}

#[test]
fn sweep_settles_the_re_armed_card_not_the_settled_one() {
    let mut view = test_view();
    apply_streamed_tool_card(
        &mut view,
        "call-1",
        "bash",
        &json!({ "command": "sleep 10" }),
    );
    let mut pending = std::collections::HashSet::from(["call-1".to_string()]);
    let mut aborted = std::collections::HashSet::new();
    settle_pending_tool_cards(
        &mut view,
        &mut pending,
        &mut aborted,
        "Operation aborted \u{00b7} 3s",
    );
    apply_streamed_tool_card(
        &mut view,
        "call-1",
        "bash",
        &json!({ "command": "echo ready" }),
    );
    let mut pending = std::collections::HashSet::from(["call-1".to_string()]);
    let mut aborted = std::collections::HashSet::new();
    settle_pending_tool_cards(
        &mut view,
        &mut pending,
        &mut aborted,
        "Aborted after 1 retry attempt \u{00b7} 8s",
    );
    let cards = cards_of(&view);
    assert_eq!(cards.len(), 2, "two cards: {cards:?}");
    assert_eq!(
        cards[0]
            .result
            .as_ref()
            .expect("the first settle")
            .text_output(false),
        "Operation aborted \u{00b7} 3s",
        "the older card keeps its own sweep result"
    );
    assert!(cards[1].aborted, "the re-armed card settled");
    assert_eq!(
        cards[1]
            .result
            .as_ref()
            .expect("the second settle")
            .text_output(false),
        "Aborted after 1 retry attempt \u{00b7} 8s"
    );
}

#[test]
fn existing_card_refreshes_name_and_args_from_latest_frame() {
    let mut view = test_view();
    view.push_entry(ChatEntry::Tool(Box::new(ToolCallCard {
        id: "call-1".into(),
        name: String::new(),
        args: Value::Null,
        ..Default::default()
    })));
    apply_streamed_tool_card(&mut view, "call-1", "ipython", &json!({ "code": "x = 1" }));
    let card = card_of(&view).expect("the streamed frame finds the card");
    assert_eq!(card.name, "ipython");
    assert_eq!(card.args.get("code"), Some(&json!("x = 1")));
}

#[test]
fn tool_execution_start_reports_the_tool_name() {
    let mut view = test_view();
    view.push_entry(ChatEntry::Tool(Box::new(ToolCallCard {
        id: "call-1".into(),
        name: String::new(),
        args: Value::Null,
        ..Default::default()
    })));
    apply_tool_execution_start(
        &mut view,
        "call-1",
        "ipython",
        json!({ "code": "print('hi')" }),
    );
    let card = card_of(&view).expect("the start event finds the card");
    assert_eq!(card.name, "ipython");
    assert!(card.started, "the start event marks execution started");

    let mut fresh = test_view();
    apply_tool_execution_start(
        &mut fresh,
        "call-2",
        "ipython",
        json!({ "code": "fibonacci(23)" }),
    );
    let rows = rendered_card_text(&fresh);
    assert!(
        rows.iter()
            .any(|row| row.contains("python") && row.contains("fibonacci(23)")),
        "a card created from the start event renders the code preview: {rows:?}"
    );
}

fn slim_attach() -> Value {
    json!({
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "activeSessionId": "abc123def456",
        "snapshot": {
            "activeSessionId": "abc123def456",
            "summary": { "id": "abc123def456", "cwd": "/tmp" },
            "state": {
                "activeSessionId": "abc123def456",
                "cwd": "/tmp",
                "sessionId": "0199-sess",
                "sessionName": "my session",
                "model": null,
                "thinkingLevel": "default",
                "serviceTier": "auto",
                "isStreaming": false,
                "isCompacting": false,
                "retryAttempt": 0,
                "steeringMode": "all",
                "followUpMode": "all",
                "autoCompactionEnabled": false,
                "messageCount": 2,
                "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                "compactionCount": 0,
                "goal": null,
                "scopedModels": [],
                "activeToolNames": [],
            },
            "messages": [
                { "role": "user", "content": "hello", "timestamp": 1 },
                { "role": "assistant", "content": "hi there", "provider": "scripted", "model": "faux-1", "usage": { "input": 120, "output": 8 }, "timestamp": 2 },
            ],
            "lastEventSequence": 9,
            "lastEventCursor": { "generation": "g", "sequence": 9 },
            "children": [],
        },
        "replay": { "status": "complete", "toSequence": 9, "toCursor": { "generation": "g", "sequence": 9 } },
        "lastEventSequence": 9,
        "lastEventCursor": { "generation": "g", "sequence": 9 },
        "client": { "id": "c1", "capabilities": ["attach_snapshot", "event_sequence", "slim_attach"] },
    })
}

#[test]
fn an_unmatched_replay_result_keeps_its_standalone_card() {
    let mut rebuilt = Reconstructed::default();
    rebuilt.push_message(&json!({
        "role": "user",
        "content": "run it",
    }));
    rebuilt.push_message(&json!({
        "role": "toolResult",
        "toolCallId": "orphan",
        "toolName": "bash",
        "content": [{ "type": "text", "text": "orphan output" }],
        "isError": false,
        "timestamp": 123,
    }));
    assert_eq!(rebuilt.chat.len(), 2, "the orphan card lands");
    match &rebuilt.chat[1] {
        ChatEntry::Tool(card) => {
            assert_eq!(card.id, "orphan");
            assert_eq!(card.name, "bash");
            assert!(
                card.result.is_some(),
                "the orphan keeps its own result card"
            );
        }
        other => panic!("the orphan is a card: {other:?}"),
    }
}

#[test]
fn a_bulk_replay_never_drops_an_orphan_result() {
    let chat = transcript_to_entries(&[
        json!({
            "role": "user",
            "content": "run it",
        }),
        json!({
            "role": "toolResult",
            "toolCallId": "orphan",
            "toolName": "bash",
            "content": [{ "type": "text", "text": "orphan output" }],
            "isError": false,
            "timestamp": 123,
        }),
    ]);
    assert_eq!(chat.len(), 2, "the orphan card lands in the bulk path");
    match &chat[1] {
        ChatEntry::Tool(card) => {
            assert_eq!(card.id, "orphan");
            assert_eq!(card.name, "bash");
            assert!(card.result.is_some(), "the bulk orphan keeps its own card");
        }
        other => panic!("the orphan is a card: {other:?}"),
    }
}

#[test]
fn a_bulk_replay_settles_the_last_pending_card_for_a_reused_id() {
    let chat = transcript_to_entries(&[
        json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "calling twice" },
                { "type": "toolCall", "id": "dup", "name": "ipython", "arguments": {"code": "1"} },
            ],
            "timestamp": 1,
        }),
        json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "again" },
                { "type": "toolCall", "id": "dup", "name": "ipython", "arguments": {"code": "2"} },
            ],
            "timestamp": 2,
        }),
        json!({
            "role": "toolResult",
            "toolCallId": "dup",
            "toolName": "ipython",
            "content": [{ "type": "text", "text": "the second run" }],
            "isError": false,
            "timestamp": 3,
        }),
    ]);
    let cards: Vec<&crate::chat::ToolCallCard> = chat
        .iter()
        .filter_map(|entry| match entry {
            ChatEntry::Tool(card) => Some(card.as_ref()),
            _ => None,
        })
        .collect();
    assert_eq!(cards.len(), 2, "two cards for the reused id: {chat:?}");
    assert!(cards[0].result.is_none(), "the first stays pending");
    let settled = cards[1].result.as_ref().expect("the LAST card settled");
    assert_eq!(
        settled.content,
        vec![json!({ "type": "text", "text": "the second run" })]
    );
}

#[test]
fn an_interleaved_replay_pairs_results_in_arrival_order() {
    let chat = transcript_to_entries(&[
        json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "first" },
                { "type": "toolCall", "id": "dup", "name": "ipython", "arguments": {"code": "1"} },
            ],
            "timestamp": 1,
        }),
        json!({
            "role": "toolResult",
            "toolCallId": "dup",
            "toolName": "ipython",
            "content": [{ "type": "text", "text": "the first run" }],
            "isError": false,
            "timestamp": 2,
        }),
        json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "second" },
                { "type": "toolCall", "id": "dup", "name": "ipython", "arguments": {"code": "2"} },
            ],
            "timestamp": 3,
        }),
        json!({
            "role": "toolResult",
            "toolCallId": "dup",
            "toolName": "ipython",
            "content": [{ "type": "text", "text": "the second run" }],
            "isError": false,
            "timestamp": 4,
        }),
    ]);
    let cards: Vec<&crate::chat::ToolCallCard> = chat
        .iter()
        .filter_map(|entry| match entry {
            ChatEntry::Tool(card) => Some(card.as_ref()),
            _ => None,
        })
        .collect();
    assert_eq!(cards.len(), 2, "two cards: {chat:?}");
    assert_eq!(
        cards[0]
            .result
            .as_ref()
            .and_then(|result| result.content.first())
            .and_then(|block| block.get("text"))
            .and_then(Value::as_str),
        Some("the first run"),
        "the FIRST call kept its own result"
    );
    assert_eq!(
        cards[1]
            .result
            .as_ref()
            .and_then(|result| result.content.first())
            .and_then(|block| block.get("text"))
            .and_then(Value::as_str),
        Some("the second run"),
        "the SECOND call kept its own result"
    );
}

#[test]
fn an_orphan_result_keeps_its_wire_position() {
    let chat = transcript_to_entries(&[
        json!({
            "role": "user",
            "content": "before",
            "timestamp": 1,
        }),
        json!({
            "role": "toolResult",
            "toolCallId": "orphan",
            "toolName": "bash",
            "content": [{ "type": "text", "text": "orphan output" }],
            "isError": false,
            "timestamp": 2,
        }),
        json!({
            "role": "user",
            "content": "after",
            "timestamp": 3,
        }),
    ]);
    assert_eq!(chat.len(), 3, "the orphan card sits between: {chat:?}");
    match &chat[1] {
        ChatEntry::Tool(card) => assert!(card.result.is_some()),
        other => panic!("the orphan sits at its wire position: {other:?}"),
    }
    assert!(matches!(&chat[2], ChatEntry::User { text } if text == "after"));
}

#[test]
fn a_leftover_settle_keeps_its_own_orphan_card() {
    let chat = transcript_to_entries(&[
        json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "first" },
                { "type": "toolCall", "id": "dup", "name": "ipython", "arguments": {"code": "1"} },
            ],
            "timestamp": 1,
        }),
        json!({
            "role": "toolResult",
            "toolCallId": "dup",
            "toolName": "ipython",
            "content": [{ "type": "text", "text": "the first run" }],
            "isError": false,
            "timestamp": 2,
        }),
        json!({
            "role": "toolResult",
            "toolCallId": "dup",
            "toolName": "ipython",
            "content": [{ "type": "text", "text": "the leftover" }],
            "isError": false,
            "timestamp": 3,
        }),
        json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "second" },
                { "type": "toolCall", "id": "dup", "name": "ipython", "arguments": {"code": "2"} },
            ],
            "timestamp": 4,
        }),
    ]);
    let cards: Vec<&crate::chat::ToolCallCard> = chat
        .iter()
        .filter_map(|entry| match entry {
            ChatEntry::Tool(card) => Some(card.as_ref()),
            _ => None,
        })
        .collect();
    assert_eq!(
        cards.len(),
        3,
        "the call, the leftover's orphan, and the later call: {chat:?}"
    );
    assert_eq!(
        cards[0]
            .result
            .as_ref()
            .and_then(|result| result.content.first())
            .and_then(|block| block.get("text"))
            .and_then(Value::as_str),
        Some("the first run"),
        "the FIRST call kept its own result"
    );
    let leftover = cards[1];
    assert_eq!(leftover.id, "dup");
    assert!(
        leftover.result.is_some(),
        "the leftover keeps its own orphan card"
    );
    assert_eq!(
        leftover
            .result
            .as_ref()
            .and_then(|result| result.content.first())
            .and_then(|block| block.get("text"))
            .and_then(Value::as_str),
        Some("the leftover")
    );
    let second_call = chat.iter().rev().find_map(|entry| match entry {
        ChatEntry::Tool(card) if card.result.is_none() => Some(card.as_ref()),
        _ => None,
    });
    let Some(second) = second_call else {
        panic!("the second call: {chat:?}")
    };
    assert!(
        second.result.is_none(),
        "the later invocation stays pending"
    );
}

/// The rebuild's loader anchor (the operator's 2026-09-28 rule: the
/// timer counts since the LAST HUMAN PROMPT): the reconstruct reads the
/// NEWEST user message's readable wall-clock time.
#[test]
fn reconstructs_the_last_user_prompt_timestamp() {
    let mut attach = slim_attach();
    let snapshot = attach.get_mut("snapshot").expect("snapshot");
    let messages = snapshot
        .get_mut("messages")
        .expect("messages")
        .as_array_mut()
        .expect("messages array");
    assert_eq!(messages[0].get("role"), Some(&json!("user")));
    messages[0]["timestamp"] = json!(1_700_000_000_000u64);
    let view = reconstruct(&attach_data_from_response(attach).unwrap());
    assert_eq!(view.last_user_prompt_ms, Some(1_700_000_000_000));
    let mut attach = slim_attach();
    let messages = attach
        .get_mut("snapshot")
        .expect("snapshot")
        .get_mut("messages")
        .expect("messages")
        .as_array_mut()
        .expect("messages array");
    messages[0]["timestamp"] = json!(1_700_000_000_050.0f64);
    let view = reconstruct(&attach_data_from_response(attach).unwrap());
    assert_eq!(view.last_user_prompt_ms, Some(1_700_000_000_050));
    let mut attach = slim_attach();
    let messages = attach
        .get_mut("snapshot")
        .expect("snapshot")
        .get_mut("messages")
        .expect("messages")
        .as_array_mut()
        .expect("messages array");
    messages[0]["timestamp"] = json!("2026-09-28T12:00:01.000Z");
    let view = reconstruct(&attach_data_from_response(attach).unwrap());
    assert_eq!(view.last_user_prompt_ms, Some(1_790_596_801_000));
    // A newer user prompt with NO readable time does not strand the
    // anchor (Macroscope 2026-09-28): the scan takes the newest user
    // message that HAS a readable time.
    let mut attach = slim_attach();
    let messages = attach
        .get_mut("snapshot")
        .expect("snapshot")
        .get_mut("messages")
        .expect("messages")
        .as_array_mut()
        .expect("messages array");
    messages[0]["timestamp"] = json!(1_700_000_000_000u64);
    messages.push(json!({
        "role": "user",
        "content": "newer but the time is garbage",
        "timestamp": "not-a-time",
    }));
    messages.push(json!({ "role": "user", "content": "newest, no time at all" }));
    let view = reconstruct(&attach_data_from_response(attach).unwrap());
    assert_eq!(
        view.last_user_prompt_ms,
        Some(1_700_000_000_000),
        "the newest READABLE user time wins, not the newest user message"
    );
    let mut attach = slim_attach();
    let messages = attach
        .get_mut("snapshot")
        .expect("snapshot")
        .get_mut("messages")
        .expect("messages")
        .as_array_mut()
        .expect("messages array");
    messages[0]
        .as_object_mut()
        .expect("the user message")
        .remove("timestamp");
    let view = reconstruct(&attach_data_from_response(attach).unwrap());
    assert_eq!(view.last_user_prompt_ms, None);
}

#[test]
fn reconstructs_slim_attach() {
    let data = attach_data_from_response(slim_attach()).unwrap();
    assert_eq!(data.active_session_id, "abc123def456");
    let view = reconstruct(&data);
    assert_eq!(view.chat.len(), 2);
    assert!(matches!(&view.chat[0], ChatEntry::User { text } if text == "hello"));
    assert!(matches!(&view.chat[1], ChatEntry::Assistant(m) if m.blocks
        == vec![MessageBlock::Text("hi there".to_string())]));
    assert_eq!(view.session_id, "0199-sess");
    assert_eq!(view.session_name.as_deref(), Some("my session"));
    assert_eq!(view.last_event_sequence, 9);
    assert_eq!(
        view.event_generation, "g",
        "the cursor's generation reconstructs for the layout handoff's key"
    );
    assert!(
        view.cursor_present,
        "the cursor's presence reconstructs: the layout handoff keys on it"
    );
}

/// A cursor-less attach reconstructs to collapsed key values that could
/// alias across attaches, so the handoff refuses to key on them.
#[test]
fn a_cursorless_attach_reconstructs_as_unkeyed_for_the_layout_handoff() {
    let mut attach = slim_attach();
    let snapshot = attach
        .get_mut("snapshot")
        .expect("the slim attach carries a snapshot")
        .as_object_mut()
        .expect("the snapshot is a map");
    snapshot.remove("lastEventSequence");
    snapshot.remove("lastEventCursor");
    let top = attach.as_object_mut().expect("the slim attach is a map");
    top.remove("lastEventSequence");
    top.remove("lastEventCursor");
    let data = attach_data_from_response(attach).unwrap();
    let view = reconstruct(&data);
    assert!(!view.cursor_present, "no cursor means no handoff key");
    assert_eq!(
        view.last_event_sequence, 0,
        "the collapsed sequence the gate protects against"
    );
    assert_eq!(
        view.event_generation, "",
        "the collapsed generation the gate protects against"
    );
}

/// The model block carries the provider next to the id: the picker
/// disambiguates the same id across providers.
#[test]
fn reconstructs_the_model_provider_alongside_the_id() {
    let mut attach = slim_attach();
    attach["snapshot"]["state"]["model"] =
        json!({ "id": "z-ai/glm-5.3", "provider": "prime-inference" });
    let data = attach_data_from_response(attach).unwrap();
    let view = reconstruct(&data);
    assert_eq!(view.model_id.as_deref(), Some("z-ai/glm-5.3"));
    assert_eq!(view.model_provider.as_deref(), Some("prime-inference"));

    let mut attach = slim_attach();
    attach["snapshot"]["state"]["model"] = json!({ "id": "z-ai/glm-5.3" });
    let data = attach_data_from_response(attach).unwrap();
    let view = reconstruct(&data);
    assert_eq!(view.model_id.as_deref(), Some("z-ai/glm-5.3"));
    assert_eq!(view.model_provider, None, "an object without a provider");

    let mut attach = slim_attach();
    attach["snapshot"]["state"]["model"] = json!("z-ai/glm-5.3");
    let data = attach_data_from_response(attach).unwrap();
    let view = reconstruct(&data);
    assert_eq!(view.model_id.as_deref(), Some("z-ai/glm-5.3"));
    assert_eq!(view.model_provider, None, "the display-string form");
}

#[test]
fn reconstructs_the_tray_effort_suffix() {
    let mut attach = slim_attach();
    attach["snapshot"]["state"]["model"] = json!({
        "id": "faux-1", "provider": "faux", "reasoning": true
    });
    attach["snapshot"]["state"]["thinkingLevel"] = json!("high");
    let data = attach_data_from_response(attach.clone()).unwrap();
    let view = reconstruct(&data);
    assert_eq!(view.model_id.as_deref(), Some("faux-1"));
    assert_eq!(
        view.thinking_suffix,
        Some("high".to_string()),
        "the attach state's level rides the reconstructed tray label"
    );
    attach["snapshot"]["state"]["model"] = json!({
        "id": "faux-plain", "provider": "faux", "reasoning": false
    });
    attach["snapshot"]["state"]["thinkingLevel"] = json!("off");
    let data = attach_data_from_response(attach).unwrap();
    let view = reconstruct(&data);
    assert_eq!(
        view.thinking_suffix, None,
        "a model without reasoning reconstructs the bare id's label"
    );
}

#[test]
fn reconstructs_the_queue_from_session_actions() {
    let mut attach = slim_attach();
    attach["snapshot"]["state"]["sessionActions"] = json!({
        "queuedCount": 2,
        "steering": ["turn right"],
        "followUps": ["then summarize"],
    });
    let data = attach_data_from_response(attach).unwrap();
    let view = reconstruct(&data);
    assert_eq!(
        view.queued,
        crate::queued::QueuedMessages {
            steering: vec!["turn right".to_string()],
            follow_ups: vec!["then summarize".to_string()],
            starting: None,
            rlm_child_status: crate::queued::QueueLaneIndices::default(),
            injected_prompts: crate::queued::QueueLaneIndices::default(),
        },
        "an attach re-syncs the queue strip from the snapshot"
    );
}

#[test]
fn reconstructs_the_child_status_provenance_from_session_actions() {
    let mut attach = slim_attach();
    attach["snapshot"]["state"]["sessionActions"] = json!({
        "queuedCount": 3,
        "steering": ["turn right"],
        "followUps": [
            "[child-exited: no-reply child:lane]\n\nLast assistant text: done",
            "then summarize",
            "[child-failed child:broken]\n\nboom",
        ],
        "rlmChildStatus": { "steering": [], "followUp": [0, 2] },
    });
    let data = attach_data_from_response(attach).unwrap();
    let view = reconstruct(&data);
    assert_eq!(
        view.queued.rlm_child_status,
        crate::queued::QueueLaneIndices {
            steering: Vec::new(),
            follow_up: vec![0, 2],
        },
        "the attach re-sync carries the typed provenance"
    );
}

#[test]
fn reconstructs_the_injected_provenance_from_session_actions() {
    let mut attach = slim_attach();
    attach["snapshot"]["state"]["sessionActions"] = json!({
        "queuedCount": 2,
        "steering": [],
        "followUps": [
            "[goal: continuation]\n\nKeep driving the goal.",
            "then summarize",
        ],
        "injectedPrompts": { "steering": [], "followUp": [0] },
    });
    let data = attach_data_from_response(attach).unwrap();
    let view = reconstruct(&data);
    assert_eq!(
        view.queued.injected_prompts,
        crate::queued::QueueLaneIndices {
            steering: Vec::new(),
            follow_up: vec![0],
        },
        "the attach re-sync carries the injected provenance"
    );
}

#[test]
fn reconstructs_the_starting_row_from_session_actions() {
    let mut attach = slim_attach();
    attach["snapshot"]["state"]["sessionActions"] = json!({
        "queuedCount": 0,
        "steering": [],
        "followUps": [],
        "active": {
            "kind": "turn",
            "phase": "preparing",
            "label": "queued before compaction",
        },
    });
    let data = attach_data_from_response(attach).unwrap();
    let view = reconstruct(&data);
    assert_eq!(
        view.queued.starting,
        Some("queued before compaction".to_string()),
        "an attach re-sync keeps the preparing turn's prompt visible"
    );
}

#[test]
fn decodes_the_user_bash_event_triple() {
    let start = event_to_update(&json!({
        "type": "bash_start",
        "command": "echo hi",
        "excludeFromContext": false,
    }))
    .expect("a bash start");
    assert_eq!(
        start,
        TurnUpdate::BashStart {
            command: "echo hi".to_string(),
            exclude_from_context: false,
            transient: false,
            run_id: None,
        }
    );
    let side_start = event_to_update(&json!({
        "type": "bash_start",
        "command": "echo pane",
        "excludeFromContext": true,
        "transient": true,
        "runId": "run-1",
    }))
    .expect("a transient bash start");
    assert_eq!(
        side_start,
        TurnUpdate::BashStart {
            command: "echo pane".to_string(),
            exclude_from_context: true,
            transient: true,
            run_id: Some("run-1".to_string()),
        }
    );
    assert_eq!(
        event_to_update(&json!({ "type": "bash_output", "chunk": "hi\n" })),
        Some(TurnUpdate::BashOutput {
            chunk: "hi\n".to_string()
        })
    );
    assert_eq!(
        event_to_update(&json!({
            "type": "bash_end",
            "exitCode": 0,
            "cancelled": false,
            "truncated": false,
        })),
        Some(TurnUpdate::BashEnd {
            exit_code: Some(0),
            cancelled: false,
            truncated: false,
            full_output_path: None,
            error_message: None,
            transient: false,
            run_id: None,
        })
    );
}

#[test]
fn decodes_session_action_update_as_the_queue_projection() {
    let update = event_to_update(&json!({
        "type": "session_action_update",
        "actions": {
            "queuedCount": 1,
            "steering": [],
            "followUps": ["queued follow-up"],
        },
    }))
    .expect("a queue update");
    assert_eq!(
        update,
        TurnUpdate::QueueUpdated {
            steering: vec![],
            follow_ups: vec!["queued follow-up".to_string()],
            starting: None,
            rlm_child_status: crate::queued::QueueLaneIndices::default(),
            injected_prompts: crate::queued::QueueLaneIndices::default(),
        }
    );
}

#[test]
fn decodes_the_child_status_provenance_from_the_live_queue_update() {
    let update = event_to_update(&json!({
        "type": "session_action_update",
        "actions": {
            "queuedCount": 2,
            "steering": ["[child-exited: no-reply child:lane]"],
            "followUps": ["then summarize"],
            "rlmChildStatus": { "steering": [0], "followUp": [] },
        },
    }))
    .expect("a queue update");
    assert_eq!(
        update,
        TurnUpdate::QueueUpdated {
            steering: vec!["[child-exited: no-reply child:lane]".to_string()],
            follow_ups: vec!["then summarize".to_string()],
            starting: None,
            rlm_child_status: crate::queued::QueueLaneIndices {
                steering: vec![0],
                follow_up: Vec::new(),
            },
            injected_prompts: crate::queued::QueueLaneIndices::default(),
        }
    );
}

#[test]
fn decodes_the_injected_provenance_from_the_live_queue_update() {
    let update = event_to_update(&json!({
        "type": "session_action_update",
        "actions": {
            "queuedCount": 2,
            "steering": [],
            "followUps": [
                "[goal: continuation]\n\nKeep driving the goal.",
                "then summarize",
            ],
            "injectedPrompts": { "steering": [], "followUp": [0] },
        },
    }))
    .expect("a queue update");
    assert_eq!(
        update,
        TurnUpdate::QueueUpdated {
            steering: Vec::new(),
            follow_ups: vec![
                "[goal: continuation]\n\nKeep driving the goal.".to_string(),
                "then summarize".to_string(),
            ],
            starting: None,
            rlm_child_status: crate::queued::QueueLaneIndices::default(),
            injected_prompts: crate::queued::QueueLaneIndices {
                steering: Vec::new(),
                follow_up: vec![0],
            },
        }
    );
}

#[test]
fn decodes_the_preparing_turn_label_as_the_starting_row() {
    let preparing = json!({
        "type": "session_action_update",
        "actions": {
            "queuedCount": 0,
            "steering": [],
            "followUps": [],
            "active": {
                "kind": "turn",
                "phase": "preparing",
                "label": "queued before compaction",
            },
        },
    });
    assert_eq!(
        event_to_update(&preparing),
        Some(TurnUpdate::QueueUpdated {
            steering: vec![],
            follow_ups: vec![],
            starting: Some("queued before compaction".to_string()),
            rlm_child_status: crate::queued::QueueLaneIndices::default(),
            injected_prompts: crate::queued::QueueLaneIndices::default(),
        })
    );
    let committed = json!({
        "type": "session_action_update",
        "actions": {
            "queuedCount": 0,
            "steering": [],
            "followUps": [],
            "active": {
                "kind": "turn",
                "phase": "committing",
                "label": "queued before compaction",
            },
        },
    });
    assert_eq!(
        event_to_update(&committed),
        Some(TurnUpdate::QueueUpdated {
            steering: vec![],
            follow_ups: vec![],
            starting: None,
            rlm_child_status: crate::queued::QueueLaneIndices::default(),
            injected_prompts: crate::queued::QueueLaneIndices::default(),
        })
    );
    let other_kind = json!({
        "type": "session_action_update",
        "actions": {
            "queuedCount": 0,
            "steering": [],
            "followUps": [],
            "active": {
                "kind": "session_command",
                "phase": "preparing",
                "label": "/theme dark",
            },
        },
    });
    assert_eq!(
        event_to_update(&other_kind),
        Some(TurnUpdate::QueueUpdated {
            steering: vec![],
            follow_ups: vec![],
            starting: None,
            rlm_child_status: crate::queued::QueueLaneIndices::default(),
            injected_prompts: crate::queued::QueueLaneIndices::default(),
        })
    );
}

/// The rebuild side of the single-line retry UX (operator ruling
/// 2026-09-23): the `provider_retry_outcome` row replaces the superseded
/// attempts — ONE line per episode, never TS's per-attempt rows.
#[test]
fn retry_outcome_row_collapses_the_superseded_attempts() {
    let user = json!({"role": "user", "content": "run the deploy"});
    let failed = |text: &str| {
        json!({
            "role": "assistant",
            "content": [],
            "stopReason": "error",
            "errorMessage": text,
        })
    };
    let outcome = json!({
        "role": "custom",
        "customType": "provider_retry_outcome",
        "content": "Recovered after 2 retries: 429 Too many concurrent requests (limit: 32)",
        "display": true,
        "details": { "success": true, "attempts": 2, "finalError": "429 Too many concurrent requests (limit: 32)" },
    });
    let recovered = json!({"role": "assistant", "content": [{"type": "text", "text": "deployed"}], "stopReason": "stop"});
    let messages = vec![
        user,
        failed("Error: 429 Too many concurrent requests (limit: 32). Try again shortly."),
        failed("Error: 429 Too many concurrent requests (limit: 32). Try again shortly."),
        outcome,
        recovered,
    ];
    let entries = transcript_to_entries(&messages);
    assert_eq!(entries.len(), 3, "entries: {entries:?}");
    assert!(matches!(
        entries[1],
        ChatEntry::Status { ref text, kind: StatusKind::Info }
            if text.contains("Recovered after 2 retries")
                && text.contains("429 Too many concurrent requests")
    ));
    assert!(
        entries
            .iter()
            .all(|entry| !is_superseded_attempt_row(entry)),
        "per-attempt rows must collapse: {entries:?}"
    );
}

#[test]
fn a_lone_failed_attempt_without_an_outcome_row_stays() {
    let user = json!({"role": "user", "content": "hi"});
    let failed = json!({
        "role": "assistant",
        "content": [],
        "stopReason": "error",
        "errorMessage": "401 Unauthorized",
    });
    let entries = transcript_to_entries(&[user, failed]);
    assert_eq!(entries.len(), 2, "entries: {entries:?}");
    assert!(
        entries.iter().any(is_superseded_attempt_row),
        "the lone failure renders its own row: {entries:?}"
    );
}

#[test]
fn aborted_attempts_never_collapse() {
    let user = json!({"role": "user", "content": "hi"});
    let aborted = json!({
        "role": "assistant",
        "content": [],
        "stopReason": "aborted",
        "errorMessage": "Operation aborted",
    });
    let outcome = json!({
        "role": "custom",
        "customType": "provider_retry_outcome",
        "content": "\u{26a0} Error: Retry failed after 1 attempts: Retry cancelled",
        "display": true,
        "details": { "success": false, "attempts": 1, "finalError": "Retry cancelled" },
    });
    let entries = transcript_to_entries(&[user, aborted, outcome]);
    assert_eq!(entries.len(), 3, "the abort row stays: {entries:?}");
    assert!(
        entries
            .iter()
            .any(|entry| matches!(entry, ChatEntry::Assistant(assistant) if assistant.aborted)),
        "the abort renders: {entries:?}"
    );
}

#[test]
fn decodes_auto_retry_events() {
    let start = event_to_update(&json!({
        "type": "auto_retry_start",
        "attempt": 1,
        "maxAttempts": 2,
        "delayMs": 50,
        "errorMessage": "provider down",
    }))
    .expect("retry start maps");
    assert_eq!(
        start,
        TurnUpdate::AutoRetryStart {
            attempt: 1,
            max_attempts: 2,
            delay_ms: 50,
            error_message: "provider down".to_string(),
            reason: RetryStartReason::Quick,
        }
    );
    let backup = event_to_update(&json!({
        "type": "auto_retry_start",
        "attempt": 3,
        "maxAttempts": 5,
        "delayMs": 0,
        "errorMessage": "provider down",
        "reason": "backup",
        "backupModel": "prime-inference/glm-5.3",
    }))
    .expect("backup switch maps");
    assert_eq!(
        backup,
        TurnUpdate::AutoRetryStart {
            attempt: 3,
            max_attempts: 5,
            delay_ms: 0,
            error_message: "provider down".to_string(),
            reason: RetryStartReason::Backup {
                backup_model: "prime-inference/glm-5.3".to_string()
            },
        }
    );
    let end = event_to_update(&json!({
        "type": "auto_retry_end",
        "success": false,
        "attempt": 2,
        "finalError": "provider down",
    }))
    .expect("retry end maps");
    assert_eq!(
        end,
        TurnUpdate::AutoRetryEnd {
            success: false,
            attempt: 2,
            final_error: Some("provider down".to_string()),
            restored_model: None,
        }
    );
    let settled = event_to_update(&json!({
        "type": "auto_retry_end",
        "success": true,
        "attempt": 2,
        "restoredModel": "prime-inference/glm-5.3",
    }))
    .expect("retry success maps");
    assert_eq!(
        settled,
        TurnUpdate::AutoRetryEnd {
            success: true,
            attempt: 2,
            final_error: None,
            restored_model: Some("prime-inference/glm-5.3".to_string()),
        }
    );
}

#[test]
fn loader_note_comes_from_starting_partials_only() {
    let booting = json!({
        "content": [
            { "type": "text", "text": "\u{203a} setting up python kernel (one-time, ~30s)\u{2026}" }
        ],
        "details": { "status": "starting" },
    });
    assert_eq!(
        working_message_from_update(&booting).as_deref(),
        Some("\u{203a} setting up python kernel (one-time, ~30s)\u{2026}")
    );
    let streamed = json!({
        "content": [{ "type": "text", "text": "visual parity ok" }],
        "details": { "status": "ok" },
    });
    assert_eq!(working_message_from_update(&streamed), None);
    let no_text = json!({
        "content": [],
        "details": { "status": "starting" },
    });
    assert_eq!(working_message_from_update(&no_text), None);
}

#[test]
fn failed_assistant_message_end_maps_final() {
    let update = event_to_update(&json!({
        "type": "message_end",
        "message": {
            "role": "assistant",
            "stopReason": "error",
            "errorMessage": "Provider server error",
            "content": [],
        },
    }))
    .expect("failed message_end maps");
    match update {
        TurnUpdate::AssistantMessage {
            streaming, message, ..
        } => {
            assert!(!streaming, "message_end is final");
            assert_eq!(message["stopReason"], "error");
        }
        other => panic!("unexpected update: {other:?}"),
    }
}

#[test]
fn decodes_block_content() {
    let items = message_value_to_entries(&json!({
        "role": "user",
        "content": [{ "text": "hello " }, { "text": "world" }],
    }));
    assert_eq!(
        items,
        vec![ChatEntry::User {
            text: "hello world".to_string()
        }]
    );
    let items = message_value_to_entries(&json!({
        "role": "assistant",
        "content": [
            { "type": "thinking", "thinking": "hmm" },
            { "type": "text", "text": "working" },
            { "type": "toolCall", "id": "t1", "name": "bash", "arguments": { "command": "ls" } },
        ],
    }));
    assert_eq!(items.len(), 2);
    assert!(matches!(
        &items[0],
        ChatEntry::Assistant(m) if m.blocks.len() == 2 && m.has_tool_calls
    ));
    assert!(matches!(&items[1], ChatEntry::Tool(card) if card.name == "bash"));
}

#[test]
fn decodes_streamed_events() {
    let user = event_to_update(&json!({
        "type": "message_start",
        "message": { "role": "user", "content": "go" },
    }))
    .unwrap();
    assert_eq!(user, TurnUpdate::UserMessage("go".to_string()));
    let partial = event_to_update(&json!({
        "type": "message_update",
        "message": { "role": "assistant", "content": "work" },
    }))
    .unwrap();
    assert!(matches!(
        &partial,
        TurnUpdate::AssistantMessage { message, streaming: true, .. } if message["content"] == "work"
    ));
    let final_message = event_to_update(&json!({
        "type": "message_end",
        "message": { "role": "assistant", "content": "done" },
    }))
    .unwrap();
    assert!(matches!(
        &final_message,
        TurnUpdate::AssistantMessage { message, streaming: false, .. } if message["content"] == "done"
    ));
    let ended = event_to_update(&json!({ "type": "turn_end" })).unwrap();
    assert_eq!(ended, TurnUpdate::TurnEnded { error: None });
    let failed = event_to_update(&json!({ "type": "turn_end", "error": "boom" })).unwrap();
    assert_eq!(
        failed,
        TurnUpdate::TurnEnded {
            error: Some("boom".to_string())
        }
    );
    assert_eq!(
        event_to_update(&json!({ "type": "agent_end" })),
        Some(TurnUpdate::Idle)
    );
}

#[test]
fn session_command_rows_decode_once() {
    let echo = json!({
        "type": "message_start",
        "message": {
            "role": "custom",
            "customType": "session_slash_command",
            "content": "/goal ship it",
            "display": true,
            "details": { "command": { "name": "goal", "args": "ship it", "text": "/goal ship it" } },
        },
    });
    assert_eq!(
        event_to_update(&echo),
        Some(TurnUpdate::CustomRow(ChatEntry::SlashCommand {
            text: "/goal ship it".to_string()
        }))
    );
    let end = json!({
        "type": "message_end",
        "message": echo["message"].clone(),
    });
    assert_eq!(event_to_update(&end), Some(TurnUpdate::StatusUpdate));

    let result = json!({
        "type": "message_start",
        "message": {
            "role": "custom",
            "customType": "session_slash_command_result",
            "content": "Goal active: ship it",
            "display": true,
            "details": {
                "command": { "name": "goal", "args": "ship it", "text": "/goal ship it" },
                "success": true, "severity": "info",
            },
        },
    });
    // The outcome row is a status row, never a user block (the
    // operator's 2026-09-25 ruling: command output is not user text).
    assert_eq!(
        event_to_update(&result),
        Some(TurnUpdate::CustomRow(ChatEntry::Status {
            text: "Goal active: ship it".to_string(),
            kind: StatusKind::Info
        }))
    );
    let failed = json!({
        "type": "message_start",
        "message": {
            "role": "custom",
            "customType": "session_slash_command_result",
            "content": "Command failed: boom",
            "display": true,
            "details": {
                "command": { "name": "goal", "args": "clear", "text": "/goal clear" },
                "success": false, "severity": "error",
            },
        },
    });
    assert_eq!(
        event_to_update(&failed),
        Some(TurnUpdate::CustomRow(ChatEntry::Status {
            text: "Command failed: boom".to_string(),
            kind: StatusKind::Error
        }))
    );
}

#[test]
fn session_command_rows_respect_display_and_shape() {
    let hidden = json!({
        "role": "custom",
        "customType": "session_slash_command_result",
        "content": "Refined continual harness state: 1 edit applied.",
        "display": false,
    });
    assert!(custom_message_entries(&hidden).is_empty());
    let outcome = json!({
        "role": "custom",
        "customType": "session_slash_command_result",
        "content": "Goal cleared.",
        "display": true,
        "details": {
            "command": { "name": "goal", "args": "clear", "text": "/goal clear" },
            "success": true, "severity": "info",
        },
    });
    assert_eq!(
        custom_message_entries(&outcome),
        vec![ChatEntry::Status {
            text: "Goal cleared.".to_string(),
            kind: StatusKind::Info,
        }]
    );
    let other = json!({
        "role": "custom",
        "customType": "harness_digest",
        "content": "digest",
        "display": true,
    });
    assert!(matches!(
        custom_message_entries(&other).as_slice(),
        [ChatEntry::CustomPanel(_)]
    ));
    let malformed = json!({
        "role": "custom",
        "customType": "session_slash_command",
        "content": "/goal",
        "display": true,
        "details": {},
    });
    assert_eq!(
        custom_message_entries(&malformed),
        vec![ChatEntry::User {
            text: "[Malformed session command message]".to_string()
        }]
    );
}

#[test]
fn transcript_replay_completes_tool_cards() {
    let transcript = [
        json!({ "role": "user", "content": "run it", "timestamp": 1 }),
        json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "calling" },
                { "type": "toolCall", "id": "call-1", "name": "ipython", "arguments": {"code": "1"} },
            ],
            "provider": "faux", "model": "faux-1",
            "usage": { "input": 10, "output": 2 }, "stopReason": "toolUse",
            "timestamp": 2,
        }),
        json!({
            "role": "toolResult",
            "toolCallId": "call-1",
            "toolName": "ipython",
            "content": [{ "type": "text", "text": "42" }],
            "details": { "durationMs": 3, "status": "ok" },
            "isError": false,
            "timestamp": 3,
        }),
        json!({
            "role": "toolResult",
            "toolCallId": "orphan",
            "toolName": "ipython",
            "content": [{ "type": "text", "text": "no card" }],
            "isError": false,
            "timestamp": 4,
        }),
        json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "done" }],
            "provider": "faux", "model": "faux-1",
            "usage": { "input": 10, "output": 2 }, "stopReason": "stop",
            "timestamp": 5,
        }),
    ];
    let chat = transcript_to_entries(&transcript);
    assert_eq!(chat.len(), 5, "chat: {chat:?}");
    let Some(ChatEntry::Tool(card)) = chat.get(2) else {
        panic!("tool card at index 2: {chat:?}");
    };
    assert!(card.started);
    assert!(!card.result_partial);
    let result = card.result.as_ref().expect("result replayed");
    assert_eq!(
        result.content,
        vec![json!({ "type": "text", "text": "42" })]
    );
    assert_eq!(result.details, json!({ "durationMs": 3, "status": "ok" }));
    assert!(!result.is_error);
    let Some(ChatEntry::Tool(orphan)) = chat.get(3) else {
        panic!("orphan card at its wire position (index 3): {chat:?}");
    };
    assert_eq!(orphan.id, "orphan");
    assert!(orphan.result.is_some(), "the orphan keeps its own card");
}

#[test]
fn transcript_replay_keeps_pending_cards_without_results() {
    let transcript = [
        json!({ "role": "user", "content": "run it", "timestamp": 1 }),
        json!({
            "role": "assistant",
            "content": [
                { "type": "toolCall", "id": "call-1", "name": "ipython", "arguments": {} },
            ],
            "provider": "faux", "model": "faux-1",
            "usage": { "input": 10, "output": 2 }, "stopReason": "toolUse",
            "timestamp": 2,
        }),
    ];
    let chat = transcript_to_entries(&transcript);
    let Some(ChatEntry::Tool(card)) = chat.get(1) else {
        panic!("tool card at index 1: {chat:?}");
    };
    assert!(!card.started);
    assert!(card.result.is_none());
}

#[test]
fn push_message_completes_pending_tool_card() {
    let mut reconstructed = Reconstructed::default();
    reconstructed.push_message(&json!({
        "role": "assistant",
        "content": [
            { "type": "toolCall", "id": "call-1", "name": "ipython", "arguments": {} },
        ],
        "provider": "faux", "model": "faux-1",
        "usage": { "input": 10, "output": 2 }, "stopReason": "toolUse",
        "timestamp": 2,
    }));
    reconstructed.push_message(&json!({
        "role": "toolResult",
        "toolCallId": "call-1",
        "toolName": "ipython",
        "content": [{ "type": "text", "text": "out" }],
        "isError": true,
        "timestamp": 3,
    }));
    assert_eq!(reconstructed.chat.len(), 1);
    let Some(ChatEntry::Tool(card)) = reconstructed.chat.first() else {
        panic!("single tool card: {:?}", reconstructed.chat);
    };
    let result = card.result.as_ref().expect("result applied");
    assert!(result.is_error);
    assert_eq!(
        result.content,
        vec![json!({ "type": "text", "text": "out" })]
    );
}

/// One component per assistant message, even a content-less failure.
#[test]
fn transcript_replay_stacks_provider_failure_rows() {
    let failed_attempt = |timestamp: u64| {
        json!({
            "role": "assistant",
            "content": [],
            "provider": "prime-inference", "model": "mock-1",
            "stopReason": "error",
            "errorMessage": "Connection error.",
            "timestamp": timestamp,
        })
    };
    let transcript = [
        json!({ "role": "user", "content": "hello", "timestamp": 1 }),
        json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "battery hello from mock" }],
            "provider": "prime-inference", "model": "mock-1",
            "usage": { "input": 10, "output": 2 }, "stopReason": "stop",
            "timestamp": 2,
        }),
        json!({ "role": "user", "content": "again", "timestamp": 3 }),
        failed_attempt(4),
        failed_attempt(5),
        failed_attempt(6),
    ];
    let chat = transcript_to_entries(&transcript);
    assert_eq!(chat.len(), 6, "chat: {chat:?}");
    let replies: Vec<&crate::chat::AssistantMessage> = chat
        .iter()
        .filter_map(|entry| match entry {
            ChatEntry::Assistant(message) => Some(message.as_ref()),
            _ => None,
        })
        .collect();
    assert_eq!(replies.len(), 4);
    assert_eq!(
        replies[0].blocks,
        vec![MessageBlock::Text("battery hello from mock".to_string())]
    );
    assert!(replies[0].error.is_none(), "the healthy reply stays clean");
    for row in &replies[1..] {
        assert!(row.blocks.is_empty());
        assert_eq!(
            row.error.as_deref(),
            Some("Error: Connection error."),
            "each failed attempt stacks its own error row"
        );
        assert!(!row.aborted);
    }
}

#[test]
fn transcript_replay_renders_contentless_abort() {
    let transcript = [
        json!({ "role": "user", "content": "hello", "timestamp": 1 }),
        json!({
            "role": "assistant",
            "content": [],
            "provider": "faux", "model": "faux-1",
            "stopReason": "aborted",
            "timestamp": 2,
        }),
    ];
    let chat = transcript_to_entries(&transcript);
    assert_eq!(chat.len(), 2, "chat: {chat:?}");
    let Some(ChatEntry::Assistant(message)) = chat.get(1) else {
        panic!("abort row: {chat:?}");
    };
    assert!(message.blocks.is_empty());
    assert_eq!(message.error.as_deref(), Some("Operation aborted"));
    assert!(message.aborted);
}

#[test]
fn decodes_compaction_events() {
    assert_eq!(
        event_to_update(&json!({
            "type": "compaction_start",
            "reason": "manual",
            "customInstructions": "focus on the goal",
        })),
        Some(TurnUpdate::CompactionStart {
            reason: "manual".to_string(),
            custom_instructions: Some("focus on the goal".to_string()),
        })
    );
    assert_eq!(
        event_to_update(&json!({ "type": "compaction_start", "reason": "manual" })),
        Some(TurnUpdate::CompactionStart {
            reason: "manual".to_string(),
            custom_instructions: None,
        })
    );
    assert_eq!(
        event_to_update(&json!({
            "type": "compaction_end",
            "reason": "manual",
            "result": { "summary": "s", "firstKeptEntryId": "e1", "tokensBefore": 12 },
            "aborted": false,
            "willRetry": false,
            "customInstructions": "focus",
        })),
        Some(TurnUpdate::CompactionEnd {
            reason: "manual".to_string(),
            result: Some(json!({ "summary": "s", "firstKeptEntryId": "e1", "tokensBefore": 12 })),
            custom_instructions: Some("focus".to_string()),
            aborted: false,
            error_message: None,
            error_severity: None,
        })
    );
    assert_eq!(
        event_to_update(&json!({
            "type": "compaction_end",
            "reason": "manual",
            "aborted": false,
            "willRetry": false,
            "errorMessage": "Session is too short to compact",
            "errorSeverity": "warning",
        })),
        Some(TurnUpdate::CompactionEnd {
            reason: "manual".to_string(),
            result: None,
            custom_instructions: None,
            aborted: false,
            error_message: Some("Session is too short to compact".to_string()),
            error_severity: Some("warning".to_string()),
        })
    );
    // The settling end stays the summary's only durable source.
    assert_eq!(
        event_to_update(&json!({
            "type": "compaction_summary_delta",
            "delta": "The session covered the goal.",
        })),
        Some(TurnUpdate::CompactionSummaryDelta {
            delta: "The session covered the goal.".to_string(),
        })
    );
    assert_eq!(
        event_to_update(&json!({ "type": "compaction_summary_delta" })),
        Some(TurnUpdate::CompactionSummaryDelta {
            delta: String::new(),
        })
    );
}

#[test]
fn transcript_replay_renders_the_compaction_outcome_row() {
    let items = message_value_to_entries(&json!({
        "role": "custom",
        "customType": "compaction_outcome",
        "content": "Auto-compaction skipped: not enough context",
        "display": true,
        "details": { "reason": "threshold", "outcome": "skipped" },
    }));
    assert_eq!(
        items,
        vec![ChatEntry::Status {
            text: "Auto-compaction skipped: not enough context".to_string(),
            kind: StatusKind::Warning,
        }]
    );
    let items = message_value_to_entries(&json!({
        "role": "custom",
        "customType": "compaction_outcome",
        "content": "Context overflow recovery failed: boom",
        "display": true,
        "details": { "reason": "overflow", "outcome": "failed" },
    }));
    assert!(matches!(
        &items[0],
        ChatEntry::Status { kind: StatusKind::Error, text }
            if text == "Context overflow recovery failed: boom"
    ));
    let items = message_value_to_entries(&json!({
        "role": "custom",
        "customType": "compaction_outcome",
        "content": "Compaction cancelled",
        "display": true,
        "details": { "reason": "threshold", "outcome": "cancelled" },
    }));
    assert!(matches!(
        &items[0],
        ChatEntry::Status { kind: StatusKind::Error, text }
            if text == "Compaction cancelled"
    ));
    // An envelope TS `isCompactionOutcomeMessage` rejects renders the
    // malformed notice.
    for details in [
        json!({ "reason": "manual", "outcome": "skipped" }),
        json!({ "reason": "threshold", "outcome": "compacted" }),
        json!({}),
    ] {
        let items = message_value_to_entries(&json!({
            "role": "custom",
            "customType": "compaction_outcome",
            "content": "text",
            "display": true,
            "details": details,
        }));
        assert_eq!(
            items,
            vec![ChatEntry::Status {
                text: "[Malformed compaction outcome message]".to_string(),
                kind: StatusKind::Error,
            }]
        );
    }
}

#[test]
fn transcript_replay_renders_the_compaction_summary() {
    let items = message_value_to_entries(&json!({
        "role": "compactionSummary",
        "summary": "the story so far",
        "tokensBefore": 1234,
        "retainedMessageCount": 2,
        "customInstructions": "tests",
        "timestamp": 1,
    }));
    assert_eq!(items.len(), 1);
    assert!(matches!(
        &items[0],
        ChatEntry::CompactionSummary { summary, tokens_before, custom_instructions }
        if summary == "the story so far"
            && *tokens_before == 1234
            && custom_instructions.as_deref() == Some("tests")
    ));
}

#[test]
fn transcript_replay_skips_contentless_settled_messages() {
    let items = message_value_to_entries(&json!({
        "role": "assistant",
        "content": [],
        "stopReason": "stop",
    }));
    assert_eq!(items, Vec::new());
    let items = message_value_to_entries(&json!({
        "role": "assistant",
        "content": [
            { "type": "toolCall", "id": "t1", "name": "bash", "arguments": { "command": "ls" } },
        ],
        "stopReason": "error",
        "errorMessage": "Connection error.",
    }));
    assert_eq!(items.len(), 1);
    assert!(matches!(&items[0], ChatEntry::Tool(card) if card.name == "bash"));
}

#[test]
fn goal_update_decodes_the_goal_payload() {
    let update = event_to_update(&json!({
        "type": "goal_update",
        "goal": {
            "active": false,
            "status": "complete",
            "goalId": "g-1",
            "objective": "ship it",
            "tokensUsed": 120,
            "timeUsedSeconds": 3,
            "continuationsUsed": 2,
            "lastReason": "Goal achieved"
        }
    }))
    .unwrap();
    let TurnUpdate::GoalUpdate(goal) = update else {
        panic!("expected a goal update");
    };
    let goal: pa_types::goal::GoalState = serde_json::from_value(goal).unwrap();
    assert_eq!(goal.status, pa_types::goal::GoalStatus::Complete);
    assert_eq!(goal.objective.as_deref(), Some("ship it"));
    assert_eq!(goal.last_reason.as_deref(), Some("Goal achieved"));
}

#[test]
fn attach_snapshot_carries_the_goal_state() {
    let attach = json!({
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "activeSessionId": "abc123def456",
        "snapshot": {
            "activeSessionId": "abc123def456",
            "summary": { "id": "abc123def456", "cwd": "/tmp" },
            "state": {
                "activeSessionId": "abc123def456",
                "cwd": "/tmp",
                "sessionId": "0199-sess",
                "model": null,
                "thinkingLevel": "default",
                "serviceTier": "auto",
                "isStreaming": false,
                "isCompacting": false,
                "retryAttempt": 0,
                "steeringMode": "all",
                "followUpMode": "all",
                "autoCompactionEnabled": false,
                "messageCount": 0,
                "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                "compactionCount": 0,
                "goal": {
                    "active": true,
                    "status": "active",
                    "objective": "keep shipping",
                    "tokensUsed": 10,
                    "timeUsedSeconds": 1,
                    "continuationsUsed": 0
                },
                "scopedModels": [],
                "activeToolNames": []
            },
            "messages": [],
            "lastEventSequence": 3,
            "lastEventCursor": { "generation": 1, "sequence": 3 }
        },
        "lastEventSequence": 3
    });
    let data = attach_data_from_response(attach).unwrap();
    let reconstructed = reconstruct(&data);
    let goal = reconstructed.goal.expect("snapshot goal");
    assert_eq!(goal.status, pa_types::goal::GoalStatus::Active);
    assert_eq!(goal.objective.as_deref(), Some("keep shipping"));
}

/// The tray's context usage rides the attach snapshot's state: the
/// reconstruct hands it to the rebuild that follows every attach.
#[test]
fn attach_snapshot_carries_the_tray_context_usage() {
    let mut attach = slim_attach();
    attach
        .get_mut("snapshot")
        .expect("snapshot")
        .get_mut("state")
        .expect("state")["contextUsage"] =
        json!({ "tokens": 9_400, "contextWindow": 128_000, "percent": 7.34 });
    let data = attach_data_from_response(attach).unwrap();
    let reconstructed = reconstruct(&data);
    let usage = reconstructed.context_usage.expect("snapshot context usage");
    assert_eq!(usage.tokens, 9_400);
    assert_eq!(usage.context_window, 128_000);

    // Unknown tokens (a fresh compaction) clear the tray display.
    let mut attach = slim_attach();
    attach
        .get_mut("snapshot")
        .expect("snapshot")
        .get_mut("state")
        .expect("state")["contextUsage"] =
        json!({ "tokens": null, "contextWindow": 128_000, "percent": null });
    let data = attach_data_from_response(attach).unwrap();
    assert_eq!(reconstruct(&data).context_usage, None);

    // A state without the field (a model-less session) stays `None`.
    let data = attach_data_from_response(slim_attach()).unwrap();
    assert_eq!(reconstruct(&data).context_usage, None);
}

/// A `role: "toolResult"` message with one 500KB image payload block
/// (the `attach_image` emit's stored shape).
fn image_heavy_tool_result(payload: &str) -> serde_json::Value {
    json!({
        "role": "toolResult",
        "toolCallId": "call-img",
        "toolName": "ipython",
        "content": [
            { "type": "text", "text": "Loaded 1 image(s) into context: /tmp/shot.png" },
            { "type": "image", "data": payload, "mimeType": "image/png" }
        ],
        "details": { "status": "ok", "stdout": "Loaded 1 image(s) into context: /tmp/shot.png" },
        "isError": false,
        "timestamp": 10u64
    })
}

fn elided_image_tool_result(elided_bytes: u64, width: u64, height: u64) -> serde_json::Value {
    json!({
        "role": "toolResult",
        "toolCallId": "call-img",
        "toolName": "ipython",
        "content": [
            { "type": "text", "text": "Loaded 1 image(s) into context: /tmp/shot.png" },
            {
                "type": "image",
                "data": "",
                "mimeType": "image/png",
                "elidedBytes": elided_bytes,
                "widthPx": width,
                "heightPx": height
            }
        ],
        "details": { "status": "ok", "stdout": "Loaded 1 image(s) into context: /tmp/shot.png" },
        "isError": false,
        "timestamp": 10u64
    })
}

fn line_text(line: &crate::Line) -> String {
    line.iter().map(|span| span.content.as_str()).collect()
}

#[test]
fn an_image_heavy_transcript_replays_and_renders_its_first_frame() {
    // A transcript whose tail carries many half-megabyte image tool
    // results: the fold and layout must complete without payload
    // processing.
    let payload = "A".repeat(500 * 1024);
    let mut messages = Vec::new();
    for index in 0..16 {
        messages.push(json!({
            "role": "user", "content": format!("turn {index}"), "timestamp": index
        }));
        let mut result = image_heavy_tool_result(&payload);
        result["toolCallId"] = json!(format!("call-img-{index}"));
        messages.push(result);
    }
    let entries = transcript_to_entries(&messages);
    assert_eq!(entries.len(), 32, "a user row and a card per turn");

    let mut view = test_view();
    for entry in entries {
        view.push_entry(entry);
    }
    let layout = view.layout_pass(100);
    let rows = view.transcript_window(&layout, 0, usize::MAX);
    assert!(rows.len() > 40, "the transcript frame renders");
    let flat: Vec<String> = rows.iter().map(line_text).collect();
    assert!(
        flat.iter().all(|row| !row.contains(&"A".repeat(64))),
        "no payload bytes reach the frame: {flat:?}"
    );
}

#[test]
fn elided_image_tool_results_render_their_marker_metadata() {
    // The elision marker the daemon writes for an `elide_snapshot_images`
    // client: the expanded card renders the marker's dimensions.
    let entries = transcript_to_entries(&[elided_image_tool_result(500 * 1024, 64, 32)]);
    let card = entries
        .iter()
        .find_map(|entry| match entry {
            ChatEntry::Tool(card) => Some(card.as_ref()),
            _ => None,
        })
        .expect("the tool card");
    let rows = crate::tool_card::render_tool_card(
        card,
        0,
        crate::chat::Detail::All,
        &crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor),
        100,
        true,
    );
    let flat: Vec<String> = rows.iter().map(line_text).collect();
    assert!(
        flat.iter()
            .any(|row| row.contains("\u{2570}\u{2500} [image/png \u{b7} 64\u{d7}32]")),
        "the marker's dimensions render: {flat:?}"
    );
    assert_eq!(
        card.result.as_ref().unwrap().text_output(false),
        "Loaded 1 image(s) into context: /tmp/shot.png\n[Image: [image/png]]"
    );
}

mod thinking_pins;
