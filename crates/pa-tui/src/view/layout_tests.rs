use super::*;
use crate::chat::{AssistantMessage, Detail, MessageBlock, StatusKind};
use crate::theme::{ColorMode, Theme};

fn view() -> AgentView {
    AgentView::new(Theme::builtin("prime", ColorMode::TrueColor))
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
fn an_assistant_crossing_the_glue_boundary_matches_the_full_rebuild() {
    // [T x5, A(text), T x5]: two condensed blocks around a visible
    // assistant. The assistant loses its text (the merge - one 10-call
    // block replaces the two) and regains it (the split) while a
    // tail-anchored window is paused on the rows: the mutation crosses
    // the glue boundary in BOTH directions, so the sparse bookkeeping
    // must fold the whole run-shape change, matching the full geometry
    // exactly after each step.
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
    let visible_between = || {
        ChatEntry::Assistant(Box::new(AssistantMessage {
            blocks: vec![
                MessageBlock::Thinking("between".into()),
                MessageBlock::Text("the visible body".into()),
            ],
            has_tool_calls: false,
            streaming: false,
            error: None,
            aborted: false,
        }))
    };
    let mut sparse = view();
    let mut full = view();
    full.sparse_enabled = false;
    for view in [&mut sparse, &mut full] {
        view.detail = Detail::Overview;
        for index in 0..5 {
            view.push_entry(card(&format!("a{index}")));
        }
        view.push_entry(visible_between());
        for index in 0..5 {
            view.push_entry(card(&format!("b{index}")));
        }
        // A tail of text-bearing assistant rows lifts the transcript
        // over the window height.
        for index in 0..40 {
            view.push_entry(ChatEntry::Assistant(Box::new(AssistantMessage {
                blocks: vec![
                    MessageBlock::Text(format!("tail {index} {}", "word ".repeat(index % 5))),
                    MessageBlock::Thinking("t".into()),
                ],
                has_tool_calls: false,
                streaming: false,
                error: None,
                aborted: false,
            })));
        }
    }
    let assert_two_blocks = |view: &AgentView| {
        let runs = view.condensed_runs();
        assert_eq!(runs.len(), 2, "two blocks around the visible assistant");
        assert_eq!(runs[0].calls, 5);
        assert_eq!(runs[1].calls, 5);
    };
    assert_two_blocks(&sparse);
    sparse.render_frame(37, 24);
    full.render_frame(37, 24);
    sparse.scroll_by(-40);
    full.resolve_sparse_geometry();
    full.sparse_enabled = false;
    full.scroll_by(-40);
    full.resolve_sparse_geometry();
    full.sparse_enabled = false;
    assert_eq!(
        sparse.render_frame(37, 24),
        full.render_frame(37, 24),
        "the paused window matches the full geometry before the mutation"
    );
    // The merge: the assistant loses its text and becomes hidden glue.
    sparse.prepare_entry_mutation(5);
    for view in [&mut sparse, &mut full] {
        if let ChatEntry::Assistant(message) = &mut view.chat[5] {
            message
                .blocks
                .retain(|block| !matches!(block, MessageBlock::Text(_)));
        }
    }
    sparse.mark_entry_stale(5);
    full.mark_entry_stale(5);
    full.resolve_sparse_geometry();
    full.sparse_enabled = false;
    full.resolve_sparse_geometry();
    full.sparse_enabled = false;
    let runs = sparse.condensed_runs();
    assert_eq!(runs.len(), 1, "the runs merged into one block");
    assert_eq!(
        runs[0].calls, 10,
        "all ten cards belong to the merged block"
    );
    assert_eq!(
        sparse.render_frame(37, 24),
        full.render_frame(37, 24),
        "the merge folds through the sparse window"
    );
    // The split: the assistant regains its text and the block parts
    // again.
    sparse.prepare_entry_mutation(5);
    for view in [&mut sparse, &mut full] {
        if let ChatEntry::Assistant(message) = &mut view.chat[5] {
            message
                .blocks
                .push(MessageBlock::Text("the visible body".into()));
        }
    }
    sparse.mark_entry_stale(5);
    full.mark_entry_stale(5);
    full.resolve_sparse_geometry();
    full.sparse_enabled = false;
    full.resolve_sparse_geometry();
    full.sparse_enabled = false;
    assert_two_blocks(&sparse);
    assert_eq!(
        sparse.render_frame(37, 24),
        full.render_frame(37, 24),
        "the split folds through the sparse window"
    );
}

#[test]
fn a_glue_push_after_a_user_row_folds_at_its_own_slot() {
    // [T x5 (one block), USER, tail rows...]: the window pauses with a
    // selection on the tail rows, then one tool card lands after the
    // user row. The push cannot extend the earlier run (the user row
    // ends it), so the append folds at the push's own tail slot and
    // the selection keeps its content. The walk used to fold the
    // append through the earlier run's start, treating the new rows
    // as inserted above the selection's content, so the copy jumped.
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
    let row = (1..1 + view.window_rows)
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
fn an_orphan_result_keeps_its_own_row_and_breaks_runs() {
    // Four real calls plus an unmatched wire result: the orphan keeps
    // its standalone card row (it is not a call) and breaks the run -
    // the group never reaches the condensing threshold.
    let mut view = view();
    view.detail = Detail::Overview;
    for index in 0..4 {
        view.push(crate::session::TranscriptItem::ToolCall {
            id: format!("c{index}"),
            name: "bash".to_string(),
            arguments: r#"{"command": "echo done"}"#.to_string(),
            timestamp: 1,
        });
        view.push(crate::session::TranscriptItem::ToolResult {
            tool_call_id: format!("c{index}"),
            tool_name: "bash".to_string(),
            text: "done".to_string(),
            content: Vec::new(),
            details: serde_json::Value::Null,
            is_error: false,
            timestamp: 2,
        });
    }
    view.push(crate::session::TranscriptItem::ToolResult {
        tool_call_id: "orphan".to_string(),
        tool_name: "bash".to_string(),
        text: "orphan output".to_string(),
        content: Vec::new(),
        details: serde_json::Value::Null,
        is_error: false,
        timestamp: 3,
    });
    let runs = view.condensed_runs();
    assert!(
        runs.is_empty(),
        "the orphan breaks the run: no condensed block ({runs:?})"
    );
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
fn a_background_shell_run_keeps_its_block_uncached() {
    // An ipython cell whose final result carries a still-running
    // background shell keeps its run LIVE: the block re-renders on
    // every pulse frame (the working icon and the wall-clock run on)
    // instead of caching its first paint.
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
    let run = view
        .condensed_runs()
        .first()
        .copied()
        .expect("the five-call run condenses");
    assert!(
        !view.entry_cacheable_at(run.start, &view.chat[run.start]),
        "the live block never caches while the background shell runs"
    );
}

#[test]
fn an_assistant_growth_folds_at_its_own_slot() {
    // [T x5 (one block), ASSISTANT(text), tail rows...]: the window
    // pauses with a selection on the tail rows, then the assistant
    // STREAMS (a block grows - the glue boundary never crosses). The
    // growth folds at the assistant's own slot, exactly like every
    // other self-contained mutation; the fold used to ride through the
    // earlier run's start, treating the streamed rows as inserted
    // above the selection's content, so the copy jumped mid-answer.
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
    let row = (1..1 + view.window_rows)
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
