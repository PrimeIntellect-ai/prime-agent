use super::*;
use crate::chat::{
    working_icon_frame, AssistantMessage, MessageBlock, ToolCallCard, ToolResultView,
};
use crate::theme::{ColorMode, Theme};
use crate::Line;

fn theme() -> Theme {
    Theme::builtin("prime", ColorMode::TrueColor)
}

fn thinking_assistant() -> ChatEntry {
    ChatEntry::Assistant(Box::new(AssistantMessage {
        blocks: vec![MessageBlock::Thinking("planning".to_string())],
        has_tool_calls: true,
        streaming: false,
        error: None,
        aborted: false,
    }))
}

fn text_assistant() -> ChatEntry {
    ChatEntry::Assistant(Box::new(AssistantMessage {
        blocks: vec![
            MessageBlock::Thinking("planning".to_string()),
            MessageBlock::Text("the answer".to_string()),
        ],
        has_tool_calls: false,
        streaming: false,
        error: None,
        aborted: false,
    }))
}

fn settled_card(id: &str, name: &str) -> ChatEntry {
    ChatEntry::Tool(Box::new(ToolCallCard {
        id: id.to_string(),
        name: name.to_string(),
        args: serde_json::json!({"code": "print(1)"}),
        started: true,
        started_at: Some(std::time::Instant::now()),
        ended_at: Some(std::time::Instant::now()),
        result: Some(ToolResultView {
            content: vec![serde_json::json!({"type": "text", "text": "ok"})],
            details: serde_json::Value::Null,
            is_error: false,
        }),
        result_partial: false,
        ..Default::default()
    }))
}

fn run_map(chat: &[ChatEntry]) -> ToolRuns {
    let mut map = ToolRuns::default();
    map.rebuild_from(chat, 0);
    map
}

fn flat(rows: &[Line]) -> Vec<String> {
    rows.iter()
        .map(|row| row.iter().map(|span| span.content.as_str()).collect())
        .collect()
}

#[test]
fn five_calls_condense_four_do_not() {
    let four: Vec<ChatEntry> = (0..4)
        .map(|index| settled_card(&format!("c{index}"), "ipython"))
        .collect();
    let map = run_map(&four);
    assert_eq!(map.slot(0), Some(RunSlot::Solo), "four cards stay solo");
    let five: Vec<ChatEntry> = (0..5)
        .map(|index| settled_card(&format!("c{index}"), "ipython"))
        .collect();
    let map = run_map(&five);
    assert_eq!(
        map.slot(0),
        Some(RunSlot::Start(ToolRun {
            start: 0,
            end: 5,
            calls: 5
        }))
    );
    assert_eq!(map.slot(4), Some(RunSlot::Member));
    assert_eq!(
        map.run_at(0),
        Some(ToolRun {
            start: 0,
            end: 5,
            calls: 5
        })
    );
    assert_eq!(
        map.block_owner(3),
        Some(0),
        "a member finds its block owner"
    );
}

#[test]
fn hidden_thinking_binds_visible_text_breaks() {
    // [T, T, A(thinking), T] is one run of three calls.
    let mut chat = vec![settled_card("c0", "bash"), settled_card("c1", "bash")];
    chat.push(thinking_assistant());
    chat.push(settled_card("c2", "bash"));
    let map = run_map(&chat);
    assert_eq!(
        map.slot(0),
        Some(RunSlot::Solo),
        "three calls never qualify"
    );
    // Same shape above the threshold: the glue binds.
    let mut chat = vec![settled_card("c0", "bash"), settled_card("c1", "bash")];
    chat.push(thinking_assistant());
    for index in 2..6 {
        chat.push(settled_card(&format!("c{index}"), "bash"));
    }
    let map = run_map(&chat);
    assert_eq!(
        map.run_at(0),
        Some(ToolRun {
            start: 0,
            end: 7,
            calls: 6
        }),
        "the hidden thinking binds between cards"
    );
    assert_eq!(
        map.slot(2),
        Some(RunSlot::Member),
        "the hidden assistant is a member"
    );
    // A text-bearing assistant breaks the run in two.
    chat[2] = text_assistant();
    let map = run_map(&chat);
    assert_eq!(map.slot(0), Some(RunSlot::Solo), "two calls stay solo");
    assert_eq!(map.slot(3), Some(RunSlot::Solo), "four calls stay solo");
    // A received agent message breaks the run the same way (a
    // turn-shaping row renders in place, never inside a block).
    let mut chat = vec![settled_card("c0", "ipython"), settled_card("c1", "ipython")];
    chat.push(ChatEntry::AgentMessage(Box::new(
        crate::custom_message::AgentMessageRow {
            direction: crate::custom_message::AgentMessageDirection::Received,
            participant: "from parent".to_string(),
            message: "steer".to_string(),
        },
    )));
    for index in 2..7 {
        chat.push(settled_card(&format!("c{index}"), "ipython"));
    }
    let map = run_map(&chat);
    assert_eq!(
        map.slot(0),
        Some(RunSlot::Solo),
        "two cards before the message"
    );
    assert_eq!(
        map.run_at(3),
        Some(ToolRun {
            start: 3,
            end: 8,
            calls: 5
        }),
        "the five cards after the message form one run"
    );
    assert_eq!(
        map.slot(2),
        Some(RunSlot::Solo),
        "the message itself stays solo"
    );
}

#[test]
fn trailing_hidden_assistant_stays_solo() {
    // [T x5, A(thinking), text]: the trailing hidden assistant renders
    // nothing on its own today, and it stays out of the run (no card
    // follows it to bind the glue).
    let mut chat: Vec<ChatEntry> = (0..5)
        .map(|index| settled_card(&format!("c{index}"), "ipython"))
        .collect();
    chat.push(thinking_assistant());
    chat.push(text_assistant());
    let map = run_map(&chat);
    assert_eq!(
        map.run_at(0),
        Some(ToolRun {
            start: 0,
            end: 5,
            calls: 5
        }),
        "the run ends at the trailing glue"
    );
    assert_eq!(map.slot(5), Some(RunSlot::Solo), "the glue stays solo");
    assert_eq!(map.slot(6), Some(RunSlot::Solo));
}

#[test]
fn class_labels_follow_the_cards_and_receipts() {
    let mut chat: Vec<ChatEntry> = vec![
        settled_card("c0", "ipython"),
        settled_card("c1", "bash"),
        settled_card("c2", "edit"),
    ];
    // A python cell carrying one delivered and one queued receipt.
    let mut card = settled_card("c3", "ipython");
    if let ChatEntry::Tool(card) = &mut card {
        card.result = Some(ToolResultView {
            content: vec![serde_json::json!({"type": "text", "text": "out"})],
            details: serde_json::json!({
                "sentAgentMessages": [
                    { "id": "m1", "message": "a", "deliveryStatus": "delivered", "receiverRole": "parent" },
                    { "id": "m2", "message": "b", "deliveryStatus": "queued" }
                ]
            }),
            is_error: false,
        });
    }
    chat.push(card);
    chat.push(settled_card("c4", "ipython"));
    let map = run_map(&chat);
    let run = map.run_at(0).expect("qualifies");
    let summary = run_summary(&chat, run);
    let labels: Vec<(String, usize)> = summary
        .classes
        .iter()
        .map(|class| (class.label.clone(), class.count))
        .collect();
    assert_eq!(
        labels,
        vec![
            ("python".to_string(), 3),
            ("bash".to_string(), 1),
            ("edit".to_string(), 1),
            ("agent messages sent".to_string(), 1),
            ("agent messages queued".to_string(), 1),
        ],
        "first-occurrence order with the receipt classes trailing"
    );
}

#[test]
fn bash_cells_classify_as_bash() {
    let bash_cell = |id: &str| {
        let mut card = settled_card(id, "ipython");
        if let ChatEntry::Tool(card) = &mut card {
            card.args = serde_json::json!({"code": "bash('ls -la')"});
        }
        card
    };
    let chat = vec![
        bash_cell("c0"),
        bash_cell("c1"),
        bash_cell("c2"),
        bash_cell("c3"),
        bash_cell("c4"),
    ];
    let map = run_map(&chat);
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    assert_eq!(
        summary.classes,
        vec![ClassCount {
            label: "bash".to_string(),
            count: 5
        }]
    );
}

#[test]
fn wall_clock_prefers_the_wire_timestamps() {
    let mut chat: Vec<ChatEntry> = (0..5)
        .map(|index| {
            let mut card = settled_card(&format!("c{index}"), "ipython");
            if let ChatEntry::Tool(card) = &mut card {
                card.started_ms = Some(1_000);
                card.ended_ms = Some(62_000);
            }
            card
        })
        .collect();
    let map = run_map(&chat);
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    // The instants collapse to the build instant; the wire stamps carry
    // the honest 61 seconds.
    assert_eq!(summary.wall_ms, Some(61_000));
    // A live run extends the wire wall-clock is not used (instants to
    // now, so the elapsed keeps moving).
    if let ChatEntry::Tool(card) = &mut chat[4] {
        card.result = None;
        card.ended_at = None;
        card.ended_ms = None;
    }
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    assert!(summary.live, "a card without a result runs");
    assert!(
        summary.wall_ms.unwrap_or(0) < 60_000,
        "the live wall clock moves from now"
    );
}

#[test]
fn block_rows_and_render_match() {
    let theme = theme();
    let chat: Vec<ChatEntry> = (0..5)
        .map(|index| settled_card(&format!("c{index}"), "ipython"))
        .collect();
    let map = run_map(&chat);
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    for width in [0, 1, 8, 24, 80] {
        for hint in ["", "Alt+T to expand"] {
            assert_eq!(
                run_block_rows(&summary, hint, width),
                render_run_block(&summary, 0, hint, &theme, width).len(),
                "width {width} hint {hint:?}"
            );
        }
    }
}

#[test]
fn block_rows_read_like_the_grammar() {
    let theme = theme();
    let chat: Vec<ChatEntry> = (0..6)
        .map(|index| settled_card(&format!("c{index}"), "ipython"))
        .collect();
    let map = run_map(&chat);
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    let rows = render_run_block(&summary, 0, "Alt+T to expand", &theme, 80);
    let text = flat(&rows);
    assert!(
        text[0].trim_start().starts_with("\u{2713} 6 tool calls"),
        "the summary row: {:?}",
        text[0]
    );
    assert!(
        text[1]
            .trim_start()
            .starts_with("\u{2570}\u{2500} 6 python"),
        "the breakdown row hangs on the branch gutter: {:?}",
        text[1]
    );
    assert!(
        text[1].ends_with("Alt+T to expand"),
        "the drill-in hint rides the breakdown row: {:?}",
        text[1]
    );
}

#[test]
fn a_live_run_renders_the_working_icon() {
    let theme = theme();
    let mut chat: Vec<ChatEntry> = (0..5)
        .map(|index| settled_card(&format!("c{index}"), "ipython"))
        .collect();
    if let ChatEntry::Tool(card) = &mut chat[4] {
        card.result = None;
        card.ended_at = None;
        card.started = true;
    }
    let map = run_map(&chat);
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    assert!(summary.live);
    let rows = render_run_block(&summary, 0, "", &theme, 80);
    let text = flat(&rows);
    assert!(
        text[0].contains(working_icon_frame(0)) || text[0].contains(working_icon_frame(1)),
        "the live block carries the working icon: {:?}",
        text[0]
    );
    // A failed card flips the glyph to the error marker.
    if let ChatEntry::Tool(card) = &mut chat[2] {
        card.result = Some(ToolResultView {
            content: vec![serde_json::json!({"type": "text", "text": "boom"})],
            details: serde_json::Value::Null,
            is_error: true,
        });
        card.result_partial = false;
    }
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    assert!(summary.failed);
    let rows = render_run_block(&summary, 0, "", &theme, 80);
    let text = flat(&rows);
    assert!(
        text[0].contains("\u{2717}"),
        "the error glyph wins: {:?}",
        text[0]
    );
}

#[test]
fn rebuild_from_keeps_the_prefix() {
    let mut chat: Vec<ChatEntry> = vec![text_assistant()];
    chat.extend((0..5).map(|index| settled_card(&format!("c{index}"), "ipython")));
    let mut map = ToolRuns::default();
    map.rebuild_from(&chat, 0);
    assert_eq!(map.slot(0), Some(RunSlot::Solo));
    assert!(map.run_at(1).is_some());
    // A tail push rebuilds only the suffix: the prefix keeps its slots.
    chat.push(settled_card("c5", "ipython"));
    map.rebuild_from(&chat, 6);
    assert_eq!(map.slot(0), Some(RunSlot::Solo), "the prefix stays");
    assert_eq!(
        map.run_at(1),
        Some(ToolRun {
            start: 1,
            end: 7,
            calls: 6
        })
    );
}

#[test]
fn a_live_run_extends_the_wire_span_to_now() {
    // The wire stamps settle every card (the replay path), but the run
    // stays live through a still-running background shell: the clock
    // extends to now instead of freezing at the last settled stamp.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    let wire_card = |id: &str, shell: bool| {
        ChatEntry::Tool(Box::new(ToolCallCard {
            id: id.to_string(),
            name: "ipython".to_string(),
            args: if shell {
                serde_json::json!({"code": "bash('sleep 60')"})
            } else {
                serde_json::json!({"code": "print(1)"})
            },
            started: true,
            started_ms: Some(now - 60_000),
            ended_ms: Some(now - 50_000),
            result: Some(ToolResultView {
                content: Vec::new(),
                details: if shell {
                    serde_json::json!({
                        "result": "<BashHandle pid=123 running command='sleep 60'>"
                    })
                } else {
                    serde_json::Value::Null
                },
                is_error: false,
            }),
            result_partial: false,
            ..Default::default()
        }))
    };
    let mut chat: Vec<ChatEntry> = Vec::new();
    for index in 0..4 {
        chat.push(wire_card(&format!("c{index}"), false));
    }
    chat.push(wire_card("c4", true));
    let map = run_map(&chat);
    let run = map.run_at(0).expect("the five-call run condenses");
    let summary = run_summary(&chat, run);
    assert!(summary.live, "the background shell keeps the run live");
    let Some(wall) = summary.wall_ms else {
        panic!("the wire span renders");
    };
    assert!(
        wall > 10_000,
        "the clock extends past the settled 10s span: {wall}ms"
    );
}

#[test]
fn receipts_count_only_parseable_ipython_entries() {
    // The receipt classes mirror the rows the renderer shows: a
    // malformed `sentAgentMessages` entry is not a receipt (never a
    // phantom `queued` class), and a non-ipython tool never carries
    // them.
    let mut chat: Vec<ChatEntry> = Vec::new();
    for index in 0..3 {
        chat.push(settled_card(&format!("c{index}"), "ipython"));
    }
    // A bash tool whose result details carry a delivered receipt: the
    // generic renderer never shows it, so the breakdown never counts it.
    let mut foreign = settled_card("c3", "bash");
    if let ChatEntry::Tool(card) = &mut foreign {
        card.result = Some(ToolResultView {
            content: vec![serde_json::json!({"type": "text", "text": "out"})],
            details: serde_json::json!({
                "sentAgentMessages": [
                    { "id": "m1", "message": "a", "deliveryStatus": "delivered", "receiverRole": "parent" }
                ]
            }),
            is_error: false,
        });
    }
    chat.push(foreign);
    // An ipython cell whose receipts include a malformed entry: the
    // parseable one counts, the malformed one never becomes a phantom
    // `queued` class.
    let mut cell = settled_card("c4", "ipython");
    if let ChatEntry::Tool(card) = &mut cell {
        card.result = Some(ToolResultView {
            content: vec![serde_json::json!({"type": "text", "text": "out"})],
            details: serde_json::json!({
                "sentAgentMessages": [
                    { "id": "m2", "message": "b", "deliveryStatus": "delivered", "receiverRole": "parent" },
                    { "id": "x" }
                ]
            }),
            is_error: false,
        });
    }
    chat.push(cell);
    let map = run_map(&chat);
    let summary = run_summary(&chat, map.run_at(0).expect("the five-call run condenses"));
    let labels: Vec<String> = summary
        .classes
        .iter()
        .map(|class| class.label.clone())
        .collect();
    assert!(
        !labels.iter().any(|label| label.contains("queued")),
        "the malformed entry never counts: {labels:?}"
    );
    assert_eq!(
        labels.iter().filter(|label| label.contains("sent")).count(),
        1,
        "exactly one parseable receipt counts (the bash tool's never does): {labels:?}"
    );
}

#[test]
fn a_run_with_a_running_background_shell_stays_live() {
    // An ipython cell that launched a background shell settles itself
    // (the final result lands) while the spawned shell keeps working:
    // the renderer's own status for the card is Running (the
    // no-exit-code shell case), so the condensed block stays live -
    // the working icon animates and the wall-clock runs on instead of
    // showing a settled checkmark.
    let mut chat: Vec<ChatEntry> = Vec::new();
    for index in 0..4 {
        chat.push(settled_card(&format!("c{index}"), "ipython"));
    }
    chat.push(ChatEntry::Tool(Box::new(ToolCallCard {
        id: "c4".to_string(),
        name: "ipython".to_string(),
        args: serde_json::json!({"code": "bash('sleep 60')"}),
        started: true,
        started_at: Some(std::time::Instant::now()),
        ended_at: Some(std::time::Instant::now()),
        result: Some(ToolResultView {
            content: Vec::new(),
            details: serde_json::json!({
                "result": "<BashHandle pid=123 running command='sleep 60'>"
            }),
            is_error: false,
        }),
        result_partial: false,
        ..Default::default()
    })));
    let map = run_map(&chat);
    let run = map
        .run_at(0)
        .expect("the five-call run condenses (the settled background-shell cell is a member)");
    let summary = run_summary(&chat, run);
    assert!(
        summary.live,
        "the run stays live while the background shell runs"
    );
}
