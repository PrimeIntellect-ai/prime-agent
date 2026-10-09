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
    assistant_entry(&format!(
        "{prefix} body {index} {}",
        "words ".repeat(index % 9)
    ))
}

fn frame_text(frame: &[crate::Line]) -> String {
    frame
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn prepended_history_keeps_a_paused_tail_window() {
    let mut sparse = view();
    sparse.splash_suppressed = true;
    let mut full = view();
    full.sparse_enabled = false;
    full.splash_suppressed = true;
    let head: Vec<ChatEntry> = (0..120).map(|index| body("head", index)).collect();
    for entry in head.iter().cloned() {
        full.push_entry(entry);
    }
    for index in 0..300 {
        let entry = body("tail", index);
        sparse.push_entry(entry.clone());
        full.push_entry(entry);
    }
    let card = super::expansion::tests::finished_tool_card("card-b", "beta");
    sparse.push_entry(card.clone());
    full.push_entry(card);
    sparse.toggle_card_expansion(300);
    full.toggle_card_expansion(300 + head.len());

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
        "the paused window and the toggled card keep their content across the prepend"
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
    sparse.splash_suppressed = true;
    let head: Vec<ChatEntry> = (0..80).map(|index| body("head", index)).collect();
    sparse.push_entry(ChatEntry::User {
        text: "the tail opens\nwith a user row".to_string(),
    });
    for index in 0..200 {
        sparse.push_entry(body("tail", index));
    }
    sparse.render_frame(37, 24);
    sparse.scroll_to_top();
    let home = sparse.render_frame(37, 24);
    assert!(
        frame_text(&home).contains("the tail opens"),
        "the home window renders the tail's first row: {home:?}"
    );

    sparse.prepend_entries(head);
    assert_eq!(
        sparse.render_frame(37, 24),
        home,
        "the home window keeps its content across the prepend"
    );

    sparse.scroll_to_top();
    let true_top = frame_text(&sparse.render_frame(37, 24));
    assert!(
        true_top.contains("head body 0"),
        "the true top renders the head's first row: {true_top}"
    );
    assert!(
        !true_top.contains("the tail opens"),
        "the top row is the head's first row: {true_top}"
    );

    let mut tool_first = view();
    tool_first.splash_suppressed = true;
    let mut tool_head: Vec<ChatEntry> = (0..80).map(|index| body("head", index)).collect();
    tool_head.push(super::expansion::tests::finished_tool_card(
        "card-a", "alpha",
    ));
    tool_first.push_entry(super::expansion::tests::finished_tool_card(
        "card-b", "beta",
    ));
    for index in 0..200 {
        tool_first.push_entry(body("tail", index));
    }
    tool_first.render_frame(37, 24);
    tool_first.scroll_to_top();
    tool_first.scroll_by(2);
    let tool_home = tool_first.render_frame(37, 24);
    assert!(
        frame_text(&tool_home).contains("echo hi"),
        "the tool-first tail renders from its top: {tool_home:?}"
    );
    tool_first.prepend_entries(tool_head);
    assert_eq!(
        tool_first.render_frame(37, 24),
        tool_home,
        "a shrinking seam entry keeps the paused window's content"
    );
}
