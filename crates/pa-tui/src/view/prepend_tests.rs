use super::*;
use crate::chat::{AssistantMessage, MessageBlock};
use crate::theme::{ColorMode, Theme};

fn view() -> AgentView {
    AgentView::new(Theme::builtin("prime", ColorMode::TrueColor))
}

fn assistant_entry(text: &str) -> ChatEntry {
    ChatEntry::Assistant(Box::new(AssistantMessage {
        blocks: vec![MessageBlock::Text(text.to_string())],
        has_tool_calls: false,
        streaming: false,
        error: None,
        aborted: false,
    }))
}

fn body(prefix: &str, index: usize) -> ChatEntry {
    assistant_entry(&format!("{prefix} body {index} {}", "words ".repeat(index % 9)))
}

fn frame_text(frame: &[crate::Line]) -> String {
    frame
        .iter()
        .map(|line| line.iter().map(|span| span.content.as_str()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn prepended_history_keeps_a_paused_tail_window() {
    let mut sparse = view();
    let mut full = view();
    full.sparse_enabled = false;
    let head: Vec<ChatEntry> = (0..120).map(|index| body("head", index)).collect();
    for entry in head.iter().cloned() {
        full.push_entry(entry);
    }
    for index in 0..300 {
        let entry = body("tail", index);
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
    assert_eq!(
        sparse.render_frame(37, 24),
        full.render_frame(37, 24),
        "the paused window matches the full rebuild before the prepend"
    );

    sparse.prepend_entries(head);
    assert_eq!(
        sparse.render_frame(37, 24),
        full.render_frame(37, 24),
        "the paused window keeps its content across the prepend"
    );

    sparse.scroll_to_top();
    full.scroll_to_top();
    full.sparse_window = None;
    full.resolve_sparse_geometry();
    full.sparse_enabled = false;
    assert_eq!(
        sparse.render_frame(37, 24),
        full.render_frame(37, 24),
        "the true top renders after the prepend"
    );
    assert!(
        frame_text(&sparse.render_frame(37, 24)).contains("head body 0"),
        "the prepended head's first row is reachable"
    );
}

#[test]
fn prepended_history_keeps_a_top_anchored_window() {
    let mut sparse = view();
    let head: Vec<ChatEntry> = (0..80).map(|index| body("head", index)).collect();
    for index in 0..200 {
        sparse.push_entry(body("tail", index));
    }
    sparse.render_frame(37, 24);
    sparse.scroll_to_top();
    let tail_top = sparse.render_frame(37, 24);
    assert!(
        frame_text(&tail_top).contains("tail body 0"),
        "the windowed transcript's top row renders"
    );
    assert!(
        !frame_text(&tail_top).contains("head body"),
        "the windowed transcript holds no head rows"
    );

    sparse.prepend_entries(head);
    assert_eq!(
        sparse.render_frame(37, 24),
        tail_top,
        "a top-anchored window keeps its content across the prepend"
    );

    sparse.scroll_to_top();
    let true_top = frame_text(&sparse.render_frame(37, 24));
    assert!(
        true_top.contains("head body 0"),
        "the true top renders after the prepend"
    );
    assert!(
        !true_top.contains("tail body 0"),
        "the top row is the head's first row"
    );
}

#[test]
fn prepended_history_keeps_a_toggled_cards_expansion() {
    let mut sparse = view();
    let head: Vec<ChatEntry> = (0..10).map(|index| body("head", index)).collect();
    for index in 0..30 {
        sparse.push_entry(body("tail", index));
    }
    sparse.push_entry(super::expansion::tests::finished_tool_card("card-a", "alpha"));
    sparse.push_entry(super::expansion::tests::finished_tool_card("card-b", "beta"));
    sparse.push_entry(body("tail", 31));
    sparse.render_frame(37, 24);
    sparse.toggle_card_expansion(31);
    let expanded = sparse.render_frame(37, 24);
    assert!(
        frame_text(&expanded).contains("beta 8"),
        "the toggled card renders its full output"
    );

    sparse.prepend_entries(head);
    assert_eq!(
        sparse.render_frame(37, 24),
        expanded,
        "the toggled card keeps its expansion across the prepend"
    );
    sparse.toggle_card_expansion(41);
    assert!(
        !frame_text(&sparse.render_frame(37, 24)).contains("beta 8"),
        "the shifted index toggles the same card back"
    );
}
