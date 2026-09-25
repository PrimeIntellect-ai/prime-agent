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

/// A streamed card: named and started, no result yet (the named/id
/// streamed invocation before `tool_execution_end`).
fn streamed_card(id: &str) -> ChatEntry {
    ChatEntry::Tool(Box::new(ToolCallCard {
        id: id.to_string(),
        name: "ipython".to_string(),
        args: serde_json::json!({"code": "print(1)"}),
        started: true,
        started_at: Some(std::time::Instant::now()),
        ..Default::default()
    }))
}

fn agent_message_row(message: &str) -> ChatEntry {
    ChatEntry::AgentMessage(Box::new(crate::custom_message::AgentMessageRow {
        direction: crate::custom_message::AgentMessageDirection::Received,
        counterpart: "parent".to_string(),
        message: message.to_string(),
    }))
}

/// A settled ipython cell whose result details carry `receipts` under
/// `sentAgentMessages`.
fn receipt_card(id: &str, receipts: serde_json::Value) -> ChatEntry {
    let mut card = settled_card(id, "ipython");
    if let ChatEntry::Tool(card) = &mut card {
        card.result = Some(ToolResultView {
            content: vec![serde_json::json!({"type": "text", "text": "out"})],
            details: serde_json::json!({ "sentAgentMessages": receipts }),
            is_error: false,
        });
    }
    card
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
fn three_items_condense_two_do_not() {
    // The threshold boundary: two activity items keep their own rows,
    // three condense - tool-only, message-only, and mixed alike.
    let two: Vec<ChatEntry> = (0..2)
        .map(|index| settled_card(&format!("c{index}"), "ipython"))
        .collect();
    let map = run_map(&two);
    assert_eq!(map.slot(0), Some(RunSlot::Solo), "two cards stay solo");
    assert_eq!(map.slot(1), Some(RunSlot::Solo));
    let three: Vec<ChatEntry> = (0..3)
        .map(|index| settled_card(&format!("c{index}"), "ipython"))
        .collect();
    let map = run_map(&three);
    assert_eq!(
        map.slot(0),
        Some(RunSlot::Start(ToolRun {
            start: 0,
            end: 3,
            calls: 3,
            messages: 0
        })),
        "three cards condense"
    );
    assert_eq!(map.slot(2), Some(RunSlot::Member));
    assert_eq!(map.block_owner(2), Some(0), "a member finds its owner");
}

#[test]
fn two_mixed_items_stay_solo_three_condense() {
    // [T, AM] is two items: both keep their own rows. [T, AM, T] is
    // three: one run counts both kinds.
    let two = vec![settled_card("c0", "bash"), agent_message_row("hi")];
    let map = run_map(&two);
    assert_eq!(map.slot(0), Some(RunSlot::Solo), "one card stays solo");
    assert_eq!(map.slot(1), Some(RunSlot::Solo), "one message stays solo");
    let three = vec![
        settled_card("c0", "bash"),
        agent_message_row("hi"),
        settled_card("c1", "bash"),
    ];
    let map = run_map(&three);
    assert_eq!(
        map.run_at(0),
        Some(ToolRun {
            start: 0,
            end: 3,
            calls: 2,
            messages: 1
        }),
        "the mixed trio condenses with both counts"
    );
}

#[test]
fn received_agent_messages_join_runs_hidden_thinking_binds() {
    // The regression the operator's screenshot pinned: a received
    // agent-message notice BETWEEN tool calls (with only hidden
    // thinking around it) merges into the ONE run instead of splitting
    // it into tiny groups - the row is a member, never a boundary.
    let mut chat = vec![settled_card("c0", "ipython"), settled_card("c1", "ipython")];
    chat.push(thinking_assistant());
    chat.push(agent_message_row("course correct"));
    chat.push(thinking_assistant());
    chat.push(settled_card("c2", "ipython"));
    chat.push(settled_card("c3", "ipython"));
    let map = run_map(&chat);
    assert_eq!(
        map.run_at(0),
        Some(ToolRun {
            start: 0,
            end: 7,
            calls: 4,
            messages: 1
        }),
        "one run spans the thinking and the notice"
    );
    assert_eq!(map.slot(2), Some(RunSlot::Member), "the thinking binds");
    assert_eq!(
        map.slot(3),
        Some(RunSlot::Member),
        "the received notice is a member, never a boundary"
    );
}

#[test]
fn visible_assistant_text_breaks_the_run() {
    // A text-bearing assistant is a genuine separator: the runs stay
    // split across it even when both sides condense.
    let mut chat = vec![settled_card("c0", "bash"), settled_card("c1", "bash")];
    chat.push(thinking_assistant());
    chat.push(settled_card("c2", "bash"));
    chat.push(text_assistant());
    chat.push(settled_card("c3", "bash"));
    chat.push(settled_card("c4", "bash"));
    chat.push(settled_card("c5", "bash"));
    let map = run_map(&chat);
    assert_eq!(
        map.run_at(0),
        Some(ToolRun {
            start: 0,
            end: 4,
            calls: 3,
            messages: 0
        }),
        "the first side condenses on its own"
    );
    assert_eq!(map.slot(4), Some(RunSlot::Solo), "the text breaks");
    assert_eq!(
        map.run_at(5),
        Some(ToolRun {
            start: 5,
            end: 8,
            calls: 3,
            messages: 0
        }),
        "the second side condenses on its own"
    );
}

#[test]
fn messages_only_runs_condense() {
    // A notice-only group condenses the same way: [AM, thinking, AM,
    // AM] is one run of three messages.
    let mut chat = vec![agent_message_row("one")];
    chat.push(thinking_assistant());
    chat.push(agent_message_row("two"));
    chat.push(agent_message_row("three"));
    let map = run_map(&chat);
    assert_eq!(
        map.run_at(0),
        Some(ToolRun {
            start: 0,
            end: 4,
            calls: 0,
            messages: 3
        }),
        "the notice trio condenses"
    );
}

#[test]
fn trailing_hidden_assistant_stays_solo() {
    // [T x3, A(thinking), text]: the trailing hidden assistant renders
    // nothing on its own today, and it stays out of the run (no item
    // follows it to bind the glue).
    let mut chat: Vec<ChatEntry> = (0..3)
        .map(|index| settled_card(&format!("c{index}"), "ipython"))
        .collect();
    chat.push(thinking_assistant());
    chat.push(text_assistant());
    let map = run_map(&chat);
    assert_eq!(
        map.run_at(0),
        Some(ToolRun {
            start: 0,
            end: 3,
            calls: 3,
            messages: 0
        }),
        "the run ends at the trailing glue"
    );
    assert_eq!(map.slot(3), Some(RunSlot::Solo), "the glue stays solo");
    assert_eq!(map.slot(4), Some(RunSlot::Solo));
}

#[test]
fn receipts_count_as_items_and_classes() {
    // Two cards plus a cell carrying one delivered and one queued
    // receipt: four activity items, so the run condenses and its
    // breakdown counts the sent/queued classes - the notices merge
    // into the block instead of rendering as their own rows.
    let chat = vec![
        settled_card("c0", "ipython"),
        settled_card("c1", "bash"),
        receipt_card(
            "c2",
            serde_json::json!([
                { "id": "m1", "message": "a", "deliveryStatus": "delivered", "receiverRole": "parent" },
                { "id": "m2", "message": "b", "deliveryStatus": "queued" }
            ]),
        ),
    ];
    let map = run_map(&chat);
    assert_eq!(
        map.run_at(0),
        Some(ToolRun {
            start: 0,
            end: 3,
            calls: 3,
            messages: 2
        }),
        "the receipts cross the threshold"
    );
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    let labels: Vec<(String, usize)> = summary
        .classes
        .iter()
        .map(|class| (class.label.clone(), class.count))
        .collect();
    assert_eq!(
        labels,
        vec![
            ("python".to_string(), 2),
            ("bash".to_string(), 1),
            ("agent messages sent".to_string(), 1),
            ("agent messages queued".to_string(), 1),
        ],
        "first-occurrence order with the receipt classes trailing"
    );
    assert_eq!(summary.messages, 2, "the summary's message count");
}

#[test]
fn receipt_ids_dedupe_within_a_run() {
    // The same receipt echoed by two cells of one run is ONE message
    // (the no-double-count rule): both the item count and the class
    // count see the id once; an id-less receipt is its own notice.
    let echo = serde_json::json!([
        { "id": "m1", "message": "a", "deliveryStatus": "delivered", "receiverRole": "parent" }
    ]);
    let chat = vec![
        receipt_card("c0", echo.clone()),
        receipt_card("c1", echo),
        receipt_card(
            "c2",
            serde_json::json!([
                { "message": "idless", "deliveryStatus": "delivered", "receiverRole": "parent" }
            ]),
        ),
    ];
    let map = run_map(&chat);
    assert_eq!(
        map.run_at(0),
        Some(ToolRun {
            start: 0,
            end: 3,
            calls: 3,
            messages: 2
        }),
        "the echoed id counts once, the id-less receipt separately"
    );
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    assert_eq!(summary.messages, 2);
    assert_eq!(
        summary
            .classes
            .iter()
            .find(|class| class.label == "agent messages sent")
            .map(|class| class.count),
        Some(2),
        "the class count matches the deduped item count"
    );
}

#[test]
fn receipts_count_only_parseable_ipython_entries() {
    // The receipt classes mirror the notices the rows themselves
    // carry: a malformed `sentAgentMessages` entry is not a receipt
    // (never a phantom `queued` class), and a non-ipython tool never
    // carries them.
    let mut foreign = settled_card("c0", "bash");
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
    let mut cell = settled_card("c1", "ipython");
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
    let chat = vec![foreign, cell, agent_message_row("steer")];
    let map = run_map(&chat);
    let run = map.run_at(0).expect("two cards and a notice condense");
    let summary = run_summary(&chat, run);
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
    assert_eq!(summary.messages, 2, "one receipt plus one received row");
}

#[test]
fn class_labels_follow_the_cards_and_receipts() {
    let mut chat = vec![
        settled_card("c0", "ipython"),
        settled_card("c1", "bash"),
        settled_card("c2", "edit"),
        receipt_card(
            "c3",
            serde_json::json!([
                { "id": "m1", "message": "a", "deliveryStatus": "delivered", "receiverRole": "parent" },
                { "id": "m2", "message": "b", "deliveryStatus": "queued" }
            ]),
        ),
    ];
    chat.push(agent_message_row("hi"));
    let map = run_map(&chat);
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    let labels: Vec<(String, usize)> = summary
        .classes
        .iter()
        .map(|class| (class.label.clone(), class.count))
        .collect();
    assert_eq!(
        labels,
        vec![
            ("python".to_string(), 2),
            ("bash".to_string(), 1),
            ("edit".to_string(), 1),
            ("agent messages received".to_string(), 1),
            ("agent messages sent".to_string(), 1),
            ("agent messages queued".to_string(), 1),
        ],
        "the received class rides with sent and queued"
    );
}

#[test]
fn a_bash_cell_wrapping_python_classifies_like_its_display() {
    // A `%%bash` cell whose selected heredoc preview is python shows
    // `bash · python` on its card rows - the run's class mirrors that
    // exact label instead of a bare `bash`.
    let cell = |id: &str| {
        let mut card = settled_card(id, "ipython");
        if let ChatEntry::Tool(card) = &mut card {
            card.args = serde_json::json!({
                "code": "%%bash\npython3 - <<'EOF'\nprint('hi')\nEOF\n"
            });
        }
        card
    };
    let chat = vec![cell("c0"), cell("c1"), cell("c2")];
    let map = run_map(&chat);
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    assert_eq!(
        summary.classes,
        vec![ClassCount {
            label: "bash \u{b7} python".to_string(),
            count: 3
        }],
        "the class mirrors the card's own display label"
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
    let chat = vec![bash_cell("c0"), bash_cell("c1"), bash_cell("c2")];
    let map = run_map(&chat);
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    assert_eq!(
        summary.classes,
        vec![ClassCount {
            label: "bash".to_string(),
            count: 3
        }]
    );
}

#[test]
fn wall_clock_prefers_the_wire_timestamps() {
    let mut chat: Vec<ChatEntry> = (0..3)
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
    if let ChatEntry::Tool(card) = &mut chat[2] {
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
    let chat: Vec<ChatEntry> = (0..3)
        .map(|index| settled_card(&format!("c{index}"), "ipython"))
        .collect();
    let map = run_map(&chat);
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    for width in [0, 1, 8, 24, 80] {
        assert_eq!(
            run_block_rows(&summary, width),
            render_run_block(&summary, 0, &theme, width).len(),
            "width {width}"
        );
    }
}

#[test]
fn block_rows_read_like_the_grammar() {
    let theme = theme();
    let chat: Vec<ChatEntry> = (0..3)
        .map(|index| settled_card(&format!("c{index}"), "ipython"))
        .collect();
    let map = run_map(&chat);
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    let rows = render_run_block(&summary, 0, &theme, 80);
    let text = flat(&rows);
    assert!(
        text[0].trim_start().starts_with("\u{2713} 3 tool calls"),
        "the summary row: {:?}",
        text[0]
    );
    assert!(
        text[1]
            .trim_start()
            .starts_with("\u{2570}\u{2500} 3 python"),
        "the breakdown row hangs on the branch gutter: {:?}",
        text[1]
    );
    assert!(
        !text.iter().any(|row| row.contains("expand")),
        "no drill-in hint rides the block: {text:?}"
    );
}

#[test]
fn the_mixed_block_counts_both_kinds() {
    // The summary row names both kinds when a run carries both;
    // a message-only run names the messages alone.
    let theme = theme();
    let chat = vec![
        settled_card("c0", "ipython"),
        agent_message_row("hi"),
        settled_card("c1", "ipython"),
    ];
    let map = run_map(&chat);
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    let rows = render_run_block(&summary, 0, &theme, 80);
    let text = flat(&rows);
    assert!(
        text[0].contains("2 tool calls \u{b7} 1 agent message"),
        "the mixed summary counts both kinds: {:?}",
        text[0]
    );
    assert!(
        text[1].contains("1 agent messages received"),
        "the breakdown carries the received class: {:?}",
        text[1]
    );
    let notices = vec![agent_message_row("one"), agent_message_row("two")];
    let chat = vec![agent_message_row("zero")]
        .into_iter()
        .chain(notices)
        .collect::<Vec<_>>();
    let map = run_map(&chat);
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    let rows = render_run_block(&summary, 0, &theme, 80);
    let text = flat(&rows);
    assert!(
        text[0].contains("3 agent messages"),
        "the message-only summary: {:?}",
        text[0]
    );
}

#[test]
fn a_live_run_renders_the_working_icon() {
    let theme = theme();
    let mut chat: Vec<ChatEntry> = (0..3)
        .map(|index| settled_card(&format!("c{index}"), "ipython"))
        .collect();
    if let ChatEntry::Tool(card) = &mut chat[2] {
        card.result = None;
        card.ended_at = None;
        card.started = true;
    }
    let map = run_map(&chat);
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    assert!(summary.live);
    let rows = render_run_block(&summary, 0, &theme, 80);
    let text = flat(&rows);
    assert!(
        text[0].contains(working_icon_frame(0)) || text[0].contains(working_icon_frame(1)),
        "the live block carries the working icon: {:?}",
        text[0]
    );
    // A failed card flips the glyph to the error marker.
    if let ChatEntry::Tool(card) = &mut chat[1] {
        card.result = Some(ToolResultView {
            content: vec![serde_json::json!({"type": "text", "text": "boom"})],
            details: serde_json::Value::Null,
            is_error: true,
        });
        card.result_partial = false;
    }
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    assert!(summary.failed);
    let rows = render_run_block(&summary, 0, &theme, 80);
    let text = flat(&rows);
    assert!(
        text[0].contains("\u{2717}"),
        "the error glyph wins: {:?}",
        text[0]
    );
}

#[test]
fn streamed_cards_count_before_their_results() {
    // The block appears at the THIRD named/id streamed card, before any
    // result lands: the count includes resultless cards, so the
    // streaming run reads three immediately.
    let chat = vec![
        streamed_card("c0"),
        streamed_card("c1"),
        streamed_card("c2"),
    ];
    let map = run_map(&chat);
    assert_eq!(
        map.run_at(0),
        Some(ToolRun {
            start: 0,
            end: 3,
            calls: 3,
            messages: 0
        }),
        "three streamed invocations condense before their results"
    );
    let summary = run_summary(&chat, map.run_at(0).expect("qualifies"));
    assert!(summary.live, "the streamed run is live");
    assert_eq!(summary.calls, 3);
}

#[test]
fn rebuild_from_keeps_the_prefix() {
    let mut chat = vec![text_assistant()];
    chat.extend((0..3).map(|index| settled_card(&format!("c{index}"), "ipython")));
    let mut map = ToolRuns::default();
    map.rebuild_from(&chat, 0);
    assert_eq!(map.slot(0), Some(RunSlot::Solo));
    assert!(map.run_at(1).is_some());
    // A tail push rebuilds only the suffix: the prefix keeps its slots.
    chat.push(settled_card("c3", "ipython"));
    map.rebuild_from(&chat, 5);
    assert_eq!(map.slot(0), Some(RunSlot::Solo), "the prefix stays");
    assert_eq!(
        map.run_at(1),
        Some(ToolRun {
            start: 1,
            end: 5,
            calls: 4,
            messages: 0
        })
    );
}

#[test]
fn append_tail_extends_with_calls_and_messages() {
    // The O(1) tail append widens a qualifying run by ONE item: a
    // streamed card adds a call, an agent-message notice adds a
    // message - each patch matches the full rebuild exactly.
    let mut chat: Vec<ChatEntry> = (0..3)
        .map(|index| streamed_card(&format!("c{index}")))
        .collect();
    let mut map = ToolRuns::default();
    map.rebuild_from(&chat, 0);
    assert!(map.run_at(0).is_some(), "the trio qualifies");
    chat.push(agent_message_row("hi"));
    assert!(
        map.append_tail(&chat),
        "the notice extends the run in place"
    );
    let mut fresh = ToolRuns::default();
    fresh.rebuild_from(&chat, 0);
    assert_eq!(map.slots(), fresh.slots(), "the patch matches the rebuild");
    assert_eq!(
        map.run_at(0),
        Some(ToolRun {
            start: 0,
            end: 4,
            calls: 3,
            messages: 1
        })
    );
    // A receipt-carrying card never takes the O(1) path (the run's
    // dedupe needs the whole run's receipt ids): the map falls back to
    // the rebuild and stays exact.
    chat.push(receipt_card(
        "c3",
        serde_json::json!([
            { "id": "m1", "message": "a", "deliveryStatus": "delivered", "receiverRole": "parent" }
        ]),
    ));
    assert!(!map.append_tail(&chat), "the receipt card re-derives");
    map.rebuild_from(&chat, map.run_at(0).map_or(0, |run| run.start));
    let mut fresh = ToolRuns::default();
    fresh.rebuild_from(&chat, 0);
    assert_eq!(map.slots(), fresh.slots());
    assert_eq!(
        map.run_at(0),
        Some(ToolRun {
            start: 0,
            end: 5,
            calls: 4,
            messages: 2
        }),
        "the receipt counts once it lands"
    );
}

#[test]
fn a_trailing_thinking_before_an_orphan_never_joins_a_run() {
    // An orphan result card is not an item: the hidden thinking
    // between items binds only when a REAL item follows it, so the
    // thinking before an orphan stays its own (zero-row) entry and no
    // run forms across it.
    let mut orphan = settled_card("o0", "bash");
    if let ChatEntry::Tool(card) = &mut orphan {
        card.unmatched_result = true;
    }
    let chat = vec![
        settled_card("c0", "ipython"),
        settled_card("c1", "ipython"),
        settled_card("c2", "ipython"),
        thinking_assistant(),
        orphan,
    ];
    let map = run_map(&chat);
    assert_eq!(
        map.run_at(0),
        Some(ToolRun {
            start: 0,
            end: 3,
            calls: 3,
            messages: 0
        }),
        "the run ends before the orphan's thinking"
    );
    assert_eq!(map.slot(3), Some(RunSlot::Solo), "the thinking stays solo");
    assert_eq!(map.slot(4), Some(RunSlot::Solo), "the orphan stays solo");
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
    for index in 0..2 {
        chat.push(wire_card(&format!("c{index}"), false));
    }
    chat.push(wire_card("c2", true));
    let map = run_map(&chat);
    let run = map.run_at(0).expect("the three-call run condenses");
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
fn a_run_with_a_running_background_shell_stays_live() {
    // An ipython cell that launched a background shell settles itself
    // (the final result lands) while the spawned shell keeps working:
    // the renderer's own status for the card is Running (the
    // no-exit-code shell case), so the condensed block stays live -
    // the working icon animates and the wall-clock runs on instead of
    // showing a settled checkmark.
    let mut chat: Vec<ChatEntry> = Vec::new();
    for index in 0..2 {
        chat.push(settled_card(&format!("c{index}"), "ipython"));
    }
    chat.push(ChatEntry::Tool(Box::new(ToolCallCard {
        id: "c2".to_string(),
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
        .expect("the three-call run condenses (the settled background-shell cell is a member)");
    let summary = run_summary(&chat, run);
    assert!(
        summary.live,
        "the run stays live while the background shell runs"
    );
}
