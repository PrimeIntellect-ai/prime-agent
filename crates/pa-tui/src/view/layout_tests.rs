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
                    index > 0 && matches!(view.chat[index - 1], ChatEntry::Tool(_)),
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
                    index > 0 && matches!(view.chat[index - 1], ChatEntry::Tool(_)),
                ));
            }
            assert_eq!(layout.total, reference.len());
            assert_eq!(view.transcript_window(&layout, 0, usize::MAX), reference);
        }
    }
}
