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
fn sparse_frames_match_full_geometry_at_tail_top_scroll_and_paused_toggle() {
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
    sparse.detail = Detail::Overview;
    full.detail = Detail::Overview;
    full.resolve_sparse_geometry();
    full.sparse_enabled = false;
    assert_eq!(sparse.render_frame(37, 24), full.render_frame(37, 24));
    sparse.scroll_to_top();
    full.scroll_to_top();
    full.sparse_window = None;
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
