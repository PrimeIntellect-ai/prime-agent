use super::*;
use crate::chat::{AssistantMessage, Detail, MessageBlock, StatusKind};
use crate::theme::{ColorMode, Theme};

fn view() -> AgentView {
    AgentView::new(Theme::builtin("prime", ColorMode::TrueColor))
}

#[test]
fn row_pack_expands_byte_exact() {
    let styled = ratatui::style::Style::new().fg(ratatui::style::Color::Rgb(1, 2, 3));
    let plain = ratatui::style::Style::default();
    let span = |text: &str, is_styled: bool| crate::Span {
        style: if is_styled { styled } else { plain },
        content: text.to_string(),
    };
    let rows: Vec<crate::Line> = vec![
        vec![span("one ", true), span("two ", true), span("界", false)],
        vec![span("", true), span("pad", false), span("", false)],
        Vec::new(),
        vec![span("tail", false), span("tail", false)],
    ];
    let pack = RowPack::pack(&rows).expect("representable rows pack");
    assert_eq!(pack.len(), rows.len());
    // every range expands to the exact original spans: same boundaries,
    // same styles, same content bytes (empty spans included).
    assert_eq!(pack.range(0, rows.len()), rows);
    assert_eq!(pack.range(0, 1), rows[0..1].to_vec());
    assert_eq!(pack.range(1, 3), rows[1..3].to_vec());
    assert_eq!(pack.range(2, 4), rows[2..4].to_vec());
    assert_eq!(pack.range(9, 12), Vec::<crate::Line>::new());
}

#[test]
fn row_pack_expands_every_range_byte_exact_with_many_styles() {
    // The style-table and running-offset encodings must be invisible:
    // a row set with more distinct styles than any single entry uses in
    // practice, long spans past the u16 range, repeated styles, empty
    // rows, and empty spans, expanded over EVERY contiguous range.
    let styles: Vec<ratatui::style::Style> = (0..48u8)
        .map(|i| {
            let mut style = ratatui::style::Style::new();
            if i % 2 == 0 {
                style = style.fg(ratatui::style::Color::Rgb(i, i.wrapping_add(1), 3));
            }
            if i % 3 == 0 {
                style = style.bg(ratatui::style::Color::Indexed(i));
            }
            if i % 5 == 0 {
                style = style.add_modifier(ratatui::style::Modifier::BOLD);
            }
            style
        })
        .collect();
    let long = "x".repeat(70_000);
    let multi = "\u{1f9e2} unicode \u{754c}".repeat(300);
    let mut rows: Vec<crate::Line> = vec![
        vec![
            crate::Span {
                style: styles[0],
                content: long.clone(),
            },
            crate::Span {
                style: styles[47],
                content: multi,
            },
            crate::Span {
                style: styles[0],
                content: String::new(),
            },
        ],
        Vec::new(),
        (0..17)
            .map(|i| crate::Span {
                style: styles[i * 3 % 48],
                content: format!("span {i} padded text"),
            })
            .collect(),
        vec![crate::Span {
            style: styles[9],
            content: String::new(),
        }],
        vec![crate::Span {
            style: styles[0],
            content: long,
        }],
    ];
    rows.push(Vec::new());
    let pack = RowPack::pack(&rows).expect("representable rows");
    assert_eq!(pack.len(), rows.len());
    for from in 0..=rows.len() {
        for to in from..=rows.len() {
            assert_eq!(
                pack.range(from, to),
                rows[from..to].to_vec(),
                "range [{from}, {to}) must expand byte-exact"
            );
        }
    }
}

#[test]
fn cached_packed_rows_render_identical_to_a_fresh_layout() {
    let mut v = view();
    v.push_entry(ChatEntry::User {
        text: "hello wrapped text ".repeat(9),
    });
    v.push_entry(ChatEntry::Assistant(Box::new(AssistantMessage {
        blocks: vec![
            MessageBlock::Text("para one\n\npara two with more words to wrap\n".repeat(2)),
            MessageBlock::Thinking("thinking body".to_string()),
        ],
        has_tool_calls: false,
        streaming: false,
        error: None,
        aborted: false,
    })));
    let reference = v.render_frame(37, 24);
    // a second render replays the packed cache: byte-identical rows.
    let replayed = v.render_frame(37, 24);
    assert_eq!(reference, replayed);
    // a width change re-renders from scratch and matches the same bytes.
    let mut fresh = view();
    fresh.push_entry(ChatEntry::User {
        text: "hello wrapped text ".repeat(9),
    });
    fresh.push_entry(ChatEntry::Assistant(Box::new(AssistantMessage {
        blocks: vec![
            MessageBlock::Text("para one\n\npara two with more words to wrap\n".repeat(2)),
            MessageBlock::Thinking("thinking body".to_string()),
        ],
        has_tool_calls: false,
        streaming: false,
        error: None,
        aborted: false,
    })));
    assert_eq!(fresh.render_frame(37, 24), reference);
}

#[test]
fn windows_match_uncached_reference_with_variable_height_and_hidden_entries() {
    let mut view = view();
    for index in 0..80 {
        view.push_entry(ChatEntry::Status {
            text: format!("row {index} {}", "wide 界 text ".repeat(index % 7)),
            kind: StatusKind::Info,
        });
        view.push_entry(ChatEntry::Assistant(Box::new(AssistantMessage {
            blocks: vec![MessageBlock::Thinking(format!("thinking {index}"))],
            has_tool_calls: index % 2 == 0,
            streaming: false,
            error: None,
            aborted: false,
        })));
    }
    for width in [19, 80, 37] {
        for detail in [
            Detail::Overview,
            Detail::Details,
            Detail::All,
            Detail::Overview,
        ] {
            view.detail = detail;
            let layout = view.layout_pass(width);
            let mut reference = render_splash(&view.chrome, &view.theme, width);
            for (index, entry) in view.chat.iter().enumerate() {
                reference.extend(view.render_entry(
                    index,
                    entry,
                    width,
                    index == 0,
                    index > 0 && view.is_compact_neighbor(&view.chat[index - 1]),
                ));
            }
            assert_eq!(layout.total, reference.len());
            for start in (0..reference.len() + 20).step_by(11) {
                let from = start.min(reference.len());
                let to = start.saturating_add(23).min(reference.len());
                assert_eq!(
                    view.transcript_window(&layout, start, 23),
                    reference[from..to]
                );
            }
        }
    }
}

#[test]
fn cold_tail_detail_cycles_and_nearby_scroll_are_bounded_for_100k_entries() {
    let mut view = view();
    for index in 0..100_000 {
        view.push_entry(ChatEntry::Status {
            text: format!("row {index}"),
            kind: StatusKind::Info,
        });
    }
    for detail in [Detail::Overview, Detail::Details, Detail::All] {
        view.detail = detail;
        ENTRY_RENDERS.with(|count| count.set(0));
        view.render_frame(80, 24);
        assert!(ENTRY_RENDERS.with(std::cell::Cell::get) < 30);
    }
    ENTRY_RENDERS.with(|count| count.set(0));
    view.scroll_by(-30);
    view.render_frame(80, 24);
    assert!(ENTRY_RENDERS.with(std::cell::Cell::get) < 30);
    ENTRY_RENDERS.with(|count| count.set(0));
    view.render_frame(80, 24);
    assert_eq!(ENTRY_RENDERS.with(std::cell::Cell::get), 0);
    assert!(view.begin_selection(2, 0));
    view.extend_active_selection(5, 8);
    ENTRY_RENDERS.with(|count| count.set(0));
    view.render_frame(80, 24);
    view.scroll_selection(-1, 0);
    view.render_frame(80, 24);
    assert!(ENTRY_RENDERS.with(std::cell::Cell::get) < 3);
    view.clear_selection();
    view.scroll_by(-100_000);
    view.render_frame(80, 24);
    ENTRY_VISITS.with(|count| count.set(0));
    view.render_frame(80, 24);
    assert!(ENTRY_VISITS.with(std::cell::Cell::get) < 30);
    assert!(view.begin_selection(2, 0));
    view.extend_active_selection(5, 8);
    ENTRY_VISITS.with(|count| count.set(0));
    view.render_frame(80, 24);
    view.scroll_selection(-1, 0);
    view.render_frame(80, 24);
    assert!(ENTRY_VISITS.with(std::cell::Cell::get) < 60);
    view.clear_selection();
    view.scroll_to_top();
    ENTRY_RENDERS.with(|count| count.set(0));
    view.render_frame(80, 24);
    assert!(ENTRY_RENDERS.with(std::cell::Cell::get) < 30);
    // Visited rows remain cached for scrolling back; unseen rows remain raw.
}

#[test]
fn sparse_frames_match_full_geometry_at_tail_top_and_scroll() {
    let mut sparse = view();
    let mut full = view();
    full.sparse_enabled = false;
    for index in 0..200 {
        let entry = ChatEntry::Assistant(Box::new(AssistantMessage {
            blocks: vec![
                MessageBlock::Text(format!("message {index} {}", "word ".repeat(index % 13))),
                MessageBlock::Thinking("hidden thinking\nsecond line".into()),
            ],
            has_tool_calls: false,
            streaming: false,
            error: None,
            aborted: false,
        }));
        sparse.push_entry(entry.clone());
        full.push_entry(entry);
    }
    for detail in [Detail::Overview, Detail::Details, Detail::All] {
        sparse.detail = detail;
        full.detail = detail;
        full.resolve_sparse_geometry();
        full.sparse_enabled = false;
        assert_eq!(sparse.render_frame(37, 24), full.render_frame(37, 24));
    }
    for delta in [-7, -30, 10, -100_000, 1, 100_000, -1] {
        sparse.scroll_by(delta);
        full.resolve_sparse_geometry();
        full.scroll_by(delta);
        full.resolve_sparse_geometry();
        full.sparse_enabled = false;
        assert_eq!(
            sparse.render_frame(37, 24),
            full.render_frame(37, 24),
            "delta {delta}"
        );
    }
    sparse.scroll_to_top();
    full.scroll_to_top();
    full.sparse_window = None;
    full.resolve_sparse_geometry();
    full.sparse_enabled = false;
    assert_eq!(sparse.render_frame(37, 24), full.render_frame(37, 24));
}

#[test]
fn paused_detail_toggle_revisits_only_the_window_for_100k_entries() {
    let mut view = view();
    for index in 0..100_000 {
        view.push_entry(ChatEntry::Status {
            text: format!("row {index}"),
            kind: StatusKind::Info,
        });
    }
    view.render_frame(80, 24);
    view.scroll_by(-100);
    view.render_frame(80, 24);
    ENTRY_VISITS.with(|count| count.set(0));
    view.detail = Detail::All;
    view.render_frame(80, 24);
    // Zero off-window visits: the paused toggle re-renders the walked
    // window under the new detail without measuring the transcript
    // around it.
    assert!(ENTRY_VISITS.with(std::cell::Cell::get) < 40);
}

#[test]
fn paused_detail_round_trip_restores_the_window_without_a_walk() {
    let mut view = view();
    // The round trip starts from the collapsed overview level — the
    // scenario pins its own start (the startup level is the middle
    // details since TS #2447).
    view.detail = Detail::Overview;
    for index in 0..200 {
        view.push_entry(ChatEntry::Assistant(Box::new(AssistantMessage {
            blocks: vec![
                MessageBlock::Text(format!("message {index} body {}", "words ".repeat(8))),
                MessageBlock::Thinking("thought\nthought\nthought".into()),
            ],
            has_tool_calls: false,
            streaming: false,
            error: None,
            aborted: false,
        })));
    }
    view.render_frame(37, 24);
    view.scroll_by(-60);
    view.render_frame(37, 24);
    let overview = view.render_frame(37, 24);
    ENTRY_VISITS.with(|count| count.set(0));
    view.detail = Detail::All;
    let expanded = view.render_frame(37, 24);
    view.detail = Detail::Overview;
    assert_eq!(view.render_frame(37, 24), overview);
    // The detail round trip re-rendered the walked window twice without
    // visiting the transcript around it.
    assert!(ENTRY_VISITS.with(std::cell::Cell::get) < 80);
    assert_ne!(expanded, overview);
}

#[test]
fn paused_offscreen_growth_matches_the_full_rebuild() {
    let mut sparse = view();
    let mut full = view();
    full.sparse_enabled = false;
    for index in 0..400 {
        let entry = ChatEntry::Assistant(Box::new(AssistantMessage {
            blocks: vec![
                MessageBlock::Text(format!("message {index} {}", "word ".repeat(index % 9))),
                MessageBlock::Thinking("thought\nthought".into()),
            ],
            has_tool_calls: false,
            streaming: false,
            error: None,
            aborted: false,
        }));
        sparse.push_entry(entry.clone());
        full.push_entry(entry);
    }
    sparse.render_frame(37, 24);
    full.render_frame(37, 24);
    sparse.scroll_by(-120);
    full.resolve_sparse_geometry();
    full.sparse_enabled = false;
    full.scroll_by(-120);
    full.resolve_sparse_geometry();
    full.sparse_enabled = false;
    assert_eq!(sparse.render_frame(37, 24), full.render_frame(37, 24));
    // Grow an entry far above the paused window: the full rebuild keeps
    // the absolute scroll start, so the sparse window must keep it too.
    sparse.prepare_entry_mutation(3);
    let before = sparse.count_entry_rows(3, 37);
    for view in [&mut sparse, &mut full] {
        if let ChatEntry::Assistant(message) = &mut view.chat[3] {
            message
                .blocks
                .push(MessageBlock::Text("grown words\nmore words".into()));
        }
    }
    assert_ne!(sparse.count_entry_rows(3, 37), before);
    sparse.mark_entry_stale(3);
    full.mark_entry_stale(3);
    full.resolve_sparse_geometry();
    full.sparse_enabled = false;
    assert_eq!(sparse.render_frame(37, 24), full.render_frame(37, 24));
}

#[test]
fn cold_variable_detail_tail_and_streaming_selection() {
    let mut sparse = view();
    for index in 0..100_000 {
        sparse.push_entry(ChatEntry::Assistant(Box::new(AssistantMessage {
            blocks: vec![
                MessageBlock::Text(format!("body {index}")),
                MessageBlock::Thinking("thought\nthought".repeat(index % 5 + 1)),
            ],
            has_tool_calls: false,
            streaming: false,
            error: None,
            aborted: false,
        })));
    }
    for detail in [Detail::Overview, Detail::Details, Detail::All] {
        sparse.detail = detail;
        ENTRY_RENDERS.with(|count| count.set(0));
        sparse.render_frame(80, 24);
        assert!(ENTRY_RENDERS.with(std::cell::Cell::get) < 20);
    }
    sparse.scroll_by(-5);
    sparse.render_frame(80, 24);
    let mut full = view();
    full.chat = sparse.chat.clone();
    full.detail = sparse.detail;
    full.sparse_enabled = false;
    full.render_frame(80, 24);
    full.scroll_by(-5);
    full.resolve_sparse_geometry();
    assert_eq!(sparse.render_frame(80, 30), full.render_frame(80, 30));
}

#[test]
fn same_window_copy_is_bounded_for_100k_entries() {
    let mut view = view();
    for index in 0..100_000 {
        view.push_entry(ChatEntry::Status {
            text: format!("row {index}"),
            kind: StatusKind::Info,
        });
    }
    view.render_frame(80, 24);
    assert!(view.begin_selection(2, 0));
    view.extend_active_selection(5, 80);
    ENTRY_VISITS.with(|count| count.set(0));
    ENTRY_RENDERS.with(|count| count.set(0));
    assert!(view.end_active_selection().is_some());
    assert!(ENTRY_VISITS.with(std::cell::Cell::get) < 10);
    assert_eq!(ENTRY_RENDERS.with(std::cell::Cell::get), 0);
    ENTRY_VISITS.with(|count| count.set(0));
    view.render_frame(80, 24);
    assert!(ENTRY_VISITS.with(std::cell::Cell::get) < 30);
}

#[test]
fn mutation_invalidates_every_detail_slot() {
    let mut view = view();
    view.push_entry(ChatEntry::Status {
        text: "old".into(),
        kind: StatusKind::Info,
    });
    for detail in [Detail::Overview, Detail::Details, Detail::All] {
        view.detail = detail;
        view.render_frame(80, 24);
    }
    assert!(view.update_status_row(0, "new", StatusKind::Warning));
    ENTRY_RENDERS.with(|count| count.set(0));
    for detail in [Detail::Overview, Detail::Details, Detail::All] {
        view.detail = detail;
        let rows = view.render_frame(80, 24);
        assert!(rows
            .iter()
            .flatten()
            .any(|span| span.content.contains("new")));
    }
    assert_eq!(ENTRY_RENDERS.with(std::cell::Cell::get), 3);
}

#[test]
fn cold_paused_detail_uses_counts_not_offscreen_lines_for_supported_entries() {
    let mut view = view();
    for index in 0..100_000 {
        view.push_entry(ChatEntry::Assistant(Box::new(AssistantMessage {
            blocks: vec![
                MessageBlock::Text(format!("body {index}")),
                MessageBlock::Thinking("thought\nthought".into()),
            ],
            has_tool_calls: false,
            streaming: false,
            error: None,
            aborted: false,
        })));
    }
    view.render_frame(80, 24);
    view.scroll_by(-100);
    view.render_frame(80, 24);
    view.detail = Detail::All;
    ENTRY_RENDERS.with(|count| count.set(0));
    view.render_frame(80, 24);
    assert!(ENTRY_RENDERS.with(std::cell::Cell::get) < 30);
    ENTRY_RENDERS.with(|count| count.set(0));
    view.detail = Detail::Overview;
    view.render_frame(80, 24);
    assert!(ENTRY_RENDERS.with(std::cell::Cell::get) < 30);
}

#[test]
fn mixed_100k_paused_toggle_materializes_only_viewport_entries() {
    let mut view = view();
    for index in 0..100_000 {
        let entry = match index % 4 {
            0 => ChatEntry::User {
                text: format!("message {index}"),
            },
            1 => ChatEntry::Assistant(Box::new(AssistantMessage {
                blocks: vec![
                    MessageBlock::Text("body".into()),
                    MessageBlock::Thinking("reasoning".into()),
                ],
                has_tool_calls: true,
                streaming: false,
                error: None,
                aborted: false,
            })),
            2 => ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
                name: "other".into(),
                result: Some(crate::chat::ToolResultView {
                    content: vec![
                        serde_json::json!({"type":"text","text":"one\ntwo\nthree\nfour"}),
                    ],
                    details: serde_json::Value::Null,
                    is_error: false,
                }),
                ..Default::default()
            })),
            3 => ChatEntry::CompactionSummary {
                summary: "summary\nnext".into(),
                tokens_before: 100,
                custom_instructions: None,
            },
            _ => unreachable!("modulo four"),
        };
        view.push_entry(entry);
    }
    view.render_frame(80, 24);
    view.scroll_by(-100);
    view.render_frame(80, 24);
    ENTRY_RENDERS.with(|count| count.set(0));
    view.detail = Detail::All;
    view.render_frame(80, 24);
    assert!(ENTRY_RENDERS.with(std::cell::Cell::get) < 30);
    assert!(
        view.entry_layout
            .iter()
            .filter(|slots| slots.iter().any(Option::is_some))
            .count()
            < 100
    );
}

#[test]
fn height_cache_tracks_mutations_and_spacing_in_all_details() {
    let mut view = view();
    view.push_entry(ChatEntry::Assistant(Box::new(AssistantMessage {
        blocks: vec![MessageBlock::Thinking("hidden".into())],
        has_tool_calls: false,
        streaming: true,
        error: None,
        aborted: false,
    })));
    view.push_entry(ChatEntry::Tool(Box::default()));
    for detail in [Detail::Overview, Detail::Details, Detail::All] {
        view.detail = detail;
        view.layout_pass(30);
    }
    view.prepare_entry_mutation(0);
    if let ChatEntry::Assistant(message) = &mut view.chat[0] {
        message
            .blocks
            .push(MessageBlock::Text("visible words\nmore words".into()));
        message.streaming = false;
        message.has_tool_calls = true;
    }
    view.mark_entry_stale(0);
    for detail in [Detail::Overview, Detail::Details, Detail::All] {
        view.detail = detail;
        for width in [30, 12] {
            let layout = view.layout_pass(width);
            let mut reference = render_splash(&view.chrome, &view.theme, width);
            for (index, entry) in view.chat.iter().enumerate() {
                reference.extend(view.render_entry(
                    index,
                    entry,
                    width,
                    index == 0,
                    index > 0 && view.is_compact_neighbor(&view.chat[index - 1]),
                ));
            }
            assert_eq!(layout.total, reference.len());
            assert_eq!(view.transcript_window(&layout, 0, usize::MAX), reference);
        }
    }
}

#[test]
fn a_push_after_a_user_row_folds_at_its_own_slot() {
    // [T x5, USER, tail rows...]: the window pauses with a selection
    // on the tail rows, then one tool card lands after the user row.
    // The append folds at the push's own tail slot and the selection
    // keeps its content; the walk must not treat the new rows as
    // inserted above the selection's content, or the copy jumps.
    let card = |id: &str| {
        ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
            id: id.to_string(),
            name: "bash".to_string(),
            args: serde_json::json!({"command": "echo done"}),
            started: true,
            started_at: Some(std::time::Instant::now()),
            ended_at: Some(std::time::Instant::now()),
            result: Some(crate::chat::ToolResultView {
                content: vec![serde_json::json!({"type": "text", "text": "done"})],
                details: serde_json::Value::Null,
                is_error: false,
            }),
            result_partial: false,
            ..Default::default()
        }))
    };
    let row_text = |frame: &[crate::Line], row: usize| -> String {
        frame
            .get(row)
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .unwrap_or_default()
    };
    let mut view = view();
    view.detail = Detail::Overview;
    for index in 0..5 {
        view.push_entry(card(&format!("a{index}")));
    }
    view.push_entry(ChatEntry::User {
        text: "the question".into(),
    });
    for index in 0..30 {
        view.push_entry(ChatEntry::Status {
            text: format!("original {index}"),
            kind: StatusKind::Info,
        });
    }
    view.render_frame(80, 12);
    view.scroll_by(-6);
    let frame = view.render_frame(80, 12);
    let row = (1..=view.window_rows)
        .find(|row| row_text(&frame, *row).contains("original"))
        .unwrap();
    assert!(view.begin_selection(row, 0));
    view.extend_active_selection(row, 80);
    let expected = row_text(&frame, row).trim_end().to_string();
    view.push_entry(card("z0"));
    view.render_frame(80, 12);
    view.render_frame(80, 12);
    assert_eq!(
        view.end_active_selection(),
        Some(expected),
        "the paused selection keeps its content across the append"
    );
}

#[test]
fn an_orphan_result_keeps_its_own_row() {
    // Two real calls plus an unmatched wire result: the orphan keeps
    // its standalone card row (it is not a call) in the collapsed
    // view, exactly like every other activity item.
    let mut view = view();
    view.detail = Detail::Overview;
    for index in 0..2 {
        view.push(crate::session::TranscriptItem::ToolCall {
            id: format!("c{index}"),
            name: "bash".to_string(),
            arguments: r#"{"command": "echo done"}"#.to_string(),
        });
        view.push(crate::session::TranscriptItem::ToolResult {
            tool_call_id: format!("c{index}"),
            tool_name: "bash".to_string(),
            text: "done".to_string(),
            content: Vec::new(),
            details: serde_json::Value::Null,
            is_error: false,
        });
    }
    view.push(crate::session::TranscriptItem::ToolResult {
        tool_call_id: "orphan".to_string(),
        tool_name: "bash".to_string(),
        text: "orphan output".to_string(),
        content: Vec::new(),
        details: serde_json::Value::Null,
        is_error: false,
    });
    let frame = view.render_frame(80, 30);
    let rendered: Vec<String> = frame
        .iter()
        .map(|line| line.iter().map(|span| span.content.as_str()).collect())
        .collect();
    assert!(
        rendered.iter().any(|row| row.contains("orphan output")),
        "the orphan's own row renders: {rendered:?}"
    );
}

#[test]
fn a_card_push_folds_at_the_pushed_slot() {
    // [user, status rows..., T]: the window pauses with a selection on
    // a card row, then one more card lands at the tail. The push owns
    // its own slot exactly like a plain append - a walk that folds
    // through an earlier entry would treat the new rows as inserted
    // above the selection's content, so the copy would jump.
    let card = |id: &str| {
        ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
            id: id.to_string(),
            name: "bash".to_string(),
            args: serde_json::json!({"command": format!("echo out {id}")}),
            started: true,
            started_at: Some(std::time::Instant::now()),
            ended_at: Some(std::time::Instant::now()),
            result: Some(crate::chat::ToolResultView {
                content: vec![serde_json::json!({
                    "type": "text",
                    "text": "done"
                })],
                details: serde_json::Value::Null,
                is_error: false,
            }),
            result_partial: false,
            ..Default::default()
        }))
    };
    let row_text = |frame: &[crate::Line], row: usize| -> String {
        frame
            .get(row)
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .unwrap_or_default()
    };
    let mut view = view();
    view.detail = Detail::Overview;
    view.push_entry(ChatEntry::User {
        text: "the question".into(),
    });
    for index in 0..30 {
        view.push_entry(ChatEntry::Status {
            text: format!("original {index}"),
            kind: StatusKind::Info,
        });
    }
    for index in 0..1 {
        view.push_entry(card(&format!("a{index}")));
    }
    let frame = view.render_frame(80, 12);
    let row = (1..=view.window_rows)
        .find(|row| row_text(&frame, *row).contains("out a0"))
        .unwrap();
    assert!(view.begin_selection(row, 0));
    view.extend_active_selection(row, 80);
    let expected = row_text(&frame, row).trim_end().to_string();
    // The push: a second card lands at the tail.
    view.push_entry(card("a1"));
    view.render_frame(80, 12);
    view.render_frame(80, 12);
    assert_eq!(
        view.end_active_selection(),
        Some(expected),
        "the paused selection keeps its content across the append"
    );
}

#[test]
fn a_card_growth_folds_at_its_own_slot() {
    // [status rows..., T x2]: the window pauses with a selection on a
    // card row, then the card MUTATES in place (its output grows).
    // The mutation folds at the card's own slot exactly like every
    // other self-contained mutation; a walk that folds through an
    // earlier entry would make the copy jump.
    let card = |id: &str| {
        ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
            id: id.to_string(),
            name: "bash".to_string(),
            args: serde_json::json!({"command": format!("echo out {id}")}),
            started: true,
            started_at: Some(std::time::Instant::now()),
            ended_at: Some(std::time::Instant::now()),
            result: Some(crate::chat::ToolResultView {
                content: vec![serde_json::json!({
                    "type": "text",
                    "text": "done"
                })],
                details: serde_json::Value::Null,
                is_error: false,
            }),
            result_partial: false,
            ..Default::default()
        }))
    };
    let row_text = |frame: &[crate::Line], row: usize| -> String {
        frame
            .get(row)
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .unwrap_or_default()
    };
    let mut view = view();
    view.detail = Detail::Overview;
    for index in 0..30 {
        view.push_entry(ChatEntry::Status {
            text: format!("original {index}"),
            kind: StatusKind::Info,
        });
    }
    for index in 0..2 {
        view.push_entry(card(&format!("b{index}")));
    }
    let frame = view.render_frame(80, 12);
    let row = (1..=view.window_rows)
        .find(|row| row_text(&frame, *row).contains("out b1"))
        .unwrap();
    assert!(view.begin_selection(row, 0));
    view.extend_active_selection(row, 80);
    let expected = row_text(&frame, row).trim_end().to_string();
    // The mutation: the LAST card's output grows.
    view.prepare_entry_mutation(31);
    if let ChatEntry::Tool(owned) = &mut view.chat[31] {
        owned.result = Some(crate::chat::ToolResultView {
            content: vec![
                serde_json::json!({"type": "text", "text": "done"}),
                serde_json::json!({"type": "text", "text": "grown\nmore"}),
            ],
            details: serde_json::Value::Null,
            is_error: false,
        });
    }
    view.mark_entry_stale(31);
    view.render_frame(80, 12);
    view.render_frame(80, 12);
    assert_eq!(
        view.end_active_selection(),
        Some(expected),
        "the paused selection keeps its content while the card's rows grow"
    );
}

#[test]
fn a_card_pop_folds_at_the_popped_slot() {
    // [status rows..., T x2]: the window pauses with a selection on a
    // card row, then the LAST card pops (the retry-episode collapse).
    // The shrink folds at the popped card's own slot - a walk that
    // folds through an earlier entry would make the copy jump.
    let card = |id: &str| {
        ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
            id: id.to_string(),
            name: "bash".to_string(),
            args: serde_json::json!({"command": format!("echo out {id}")}),
            started: true,
            started_at: Some(std::time::Instant::now()),
            ended_at: Some(std::time::Instant::now()),
            result: Some(crate::chat::ToolResultView {
                content: vec![serde_json::json!({
                    "type": "text",
                    "text": "done"
                })],
                details: serde_json::Value::Null,
                is_error: false,
            }),
            result_partial: false,
            ..Default::default()
        }))
    };
    let row_text = |frame: &[crate::Line], row: usize| -> String {
        frame
            .get(row)
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .unwrap_or_default()
    };
    let mut view = view();
    view.detail = Detail::Overview;
    for index in 0..30 {
        view.push_entry(ChatEntry::Status {
            text: format!("original {index}"),
            kind: StatusKind::Info,
        });
    }
    for index in 0..2 {
        view.push_entry(card(&format!("b{index}")));
    }
    // A taller viewport: the whole tail sequence stays visible with
    // the dock riding under it.
    let frame = view.render_frame(80, 30);
    // The selection sits on a card ABOVE the popped one (the popped
    // card's own content vanishes with it).
    let row = (1..=view.window_rows)
        .find(|row| row_text(&frame, *row).contains("out b0"))
        .unwrap();
    assert!(view.begin_selection(row, 0));
    view.extend_active_selection(row, 80);
    let expected = row_text(&frame, row).trim_end().to_string();
    // The pop: the TAIL card (b1, below the selection) leaves.
    view.pop_chat_entry();
    view.render_frame(80, 30);
    view.render_frame(80, 30);
    assert_eq!(
        view.end_active_selection(),
        Some(expected),
        "the paused selection keeps its content across the pop"
    );
}

#[test]
fn a_replayed_result_into_a_pending_card_folds_its_row_delta() {
    // [status rows..., T x2 (a pair of QUEUED cards)]: the window
    // pauses with a selection on a card row, then the result REPLAYS
    // into the pending card - the card's rows grow when the result
    // lands. The replay prepares the sparse fold (exactly like the
    // live settle path), so the tail-anchored window keeps its
    // geometry and the selection stays on the card's rows.
    let queued_card = |id: &str| {
        ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
            id: id.to_string(),
            name: "bash".to_string(),
            args: serde_json::json!({"command": format!("echo out {id}")}),
            ..Default::default()
        }))
    };
    let row_text = |frame: &[crate::Line], row: usize| -> String {
        frame
            .get(row)
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .unwrap_or_default()
    };
    let mut view = view();
    view.detail = Detail::Overview;
    for index in 0..30 {
        view.push_entry(ChatEntry::Status {
            text: format!("original {index}"),
            kind: StatusKind::Info,
        });
    }
    for index in 0..2 {
        view.push_entry(queued_card(&format!("b{index}")));
    }
    let frame = view.render_frame(80, 12);
    let row = (1..=view.window_rows)
        .find(|row| row_text(&frame, *row).contains("out b1"))
        .unwrap();
    assert!(view.begin_selection(row, 0));
    view.extend_active_selection(row, 80);
    // The replay: the result lands on the pending card.
    view.push(crate::session::TranscriptItem::ToolResult {
        tool_call_id: "b1".to_string(),
        tool_name: "bash".to_string(),
        text: "done".to_string(),
        content: Vec::new(),
        details: serde_json::Value::Null,
        is_error: false,
    });
    view.render_frame(80, 12);
    view.render_frame(80, 12);
    let selected = view.end_active_selection();
    assert!(
        selected.as_deref().is_some_and(|text| text.contains("b1")),
        "the selection stays on the card's own rows (never a drifted row): {selected:?}"
    );
}

#[test]
fn a_background_shell_card_stays_uncached() {
    // An ipython cell whose final result carries a still-running
    // background shell keeps its card LIVE: the summary line renders the
    // working icon (CardStatus::Running while the shell has no exit
    // code), so the rows re-render on every pulse frame instead of
    // caching the first paint.
    let card = |id: &str, shell: bool| {
        ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
            id: id.to_string(),
            name: "ipython".to_string(),
            args: if shell {
                serde_json::json!({"code": "bash('sleep 60')"})
            } else {
                serde_json::json!({"code": "print(1)"})
            },
            started: true,
            started_at: Some(std::time::Instant::now()),
            ended_at: Some(std::time::Instant::now()),
            result: Some(crate::chat::ToolResultView {
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
    let mut view = view();
    view.detail = Detail::Overview;
    for index in 0..4 {
        view.push_entry(card(&format!("c{index}"), false));
    }
    view.push_entry(card("c4", true));
    let shell_entry = view.chat.last().expect("the shell card").clone();
    assert!(
        !view.entry_cacheable(&shell_entry),
        "the live card never caches while the background shell runs"
    );
    let settled = card("c5", false);
    assert!(
        view.entry_cacheable(&settled),
        "a settled cell without a background shell caches"
    );
}

#[test]
fn an_assistant_growth_folds_at_its_own_slot() {
    // [T x5, ASSISTANT(text), tail rows...]: the window pauses with a
    // selection on the tail rows, then the assistant STREAMS (a block
    // grows). The growth folds at the assistant's own slot, exactly
    // like every other self-contained mutation; a fold through an
    // earlier entry would treat the streamed rows as inserted above
    // the selection's content, so the copy would jump mid-answer.
    let card = |id: &str| {
        ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
            id: id.to_string(),
            name: "bash".to_string(),
            args: serde_json::json!({"command": "echo done"}),
            started: true,
            started_at: Some(std::time::Instant::now()),
            ended_at: Some(std::time::Instant::now()),
            result: Some(crate::chat::ToolResultView {
                content: vec![serde_json::json!({"type": "text", "text": "done"})],
                details: serde_json::Value::Null,
                is_error: false,
            }),
            result_partial: false,
            ..Default::default()
        }))
    };
    let row_text = |frame: &[crate::Line], row: usize| -> String {
        frame
            .get(row)
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .unwrap_or_default()
    };
    let mut view = view();
    view.detail = Detail::Overview;
    for index in 0..5 {
        view.push_entry(card(&format!("a{index}")));
    }
    view.push_entry(ChatEntry::Assistant(Box::new(AssistantMessage {
        blocks: vec![
            MessageBlock::Thinking("a thought".into()),
            MessageBlock::Text("the answer".into()),
        ],
        has_tool_calls: false,
        streaming: true,
        error: None,
        aborted: false,
    })));
    for index in 0..30 {
        view.push_entry(ChatEntry::Status {
            text: format!("original {index}"),
            kind: StatusKind::Info,
        });
    }
    view.render_frame(80, 12);
    view.scroll_by(-6);
    let frame = view.render_frame(80, 12);
    let row = (1..=view.window_rows)
        .find(|row| row_text(&frame, *row).contains("original"))
        .unwrap();
    assert!(view.begin_selection(row, 0));
    view.extend_active_selection(row, 80);
    let expected = row_text(&frame, row).trim_end().to_string();
    // The streaming grow: the answer gains a block.
    view.prepare_entry_mutation(5);
    if let ChatEntry::Assistant(message) = &mut view.chat[5] {
        message
            .blocks
            .push(MessageBlock::Text("grown words\nmore words".into()));
    }
    view.mark_entry_stale(5);
    view.render_frame(80, 12);
    view.render_frame(80, 12);
    assert_eq!(
        view.end_active_selection(),
        Some(expected),
        "the paused selection keeps its content while the answer streams"
    );
}
