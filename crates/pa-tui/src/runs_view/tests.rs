use super::*;
use crate::chat::{AssistantMessage, MessageBlock, ToolCallCard, ToolResultView};
use crate::keybindings::KeybindingsManager;
use crate::theme::{ColorMode, Theme};
use crate::view::AgentView;

fn settled_card(id: &str, name: &str) -> crate::chat::ChatEntry {
    crate::chat::ChatEntry::Tool(Box::new(ToolCallCard {
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

fn view_with_run(calls: usize) -> AgentView {
    let mut view = AgentView::new(Theme::builtin("prime", ColorMode::TrueColor));
    view.push_entry(crate::chat::ChatEntry::User {
        text: "run it".to_string(),
    });
    for index in 0..calls {
        view.push_entry(settled_card(&format!("c{index}"), "ipython"));
    }
    view.push_entry(crate::chat::ChatEntry::Assistant(Box::new(
        AssistantMessage {
            blocks: vec![MessageBlock::Text("done".to_string())],
            has_tool_calls: false,
            streaming: false,
            error: None,
            aborted: false,
        },
    )));
    view
}

fn flat(rows: &[Line]) -> Vec<String> {
    rows.iter()
        .map(|row| row.iter().map(|span| span.content.as_str()).collect())
        .collect()
}

#[test]
fn the_list_shows_one_row_per_run_cursor_on_the_newest() {
    let mut view = view_with_run(5);
    view.push_entry(crate::chat::ChatEntry::User {
        text: "again".to_string(),
    });
    for index in 0..6 {
        view.push_entry(settled_card(&format!("d{index}"), "bash"));
    }
    let runs = view.condensed_runs();
    assert_eq!(runs.len(), 2, "two qualifying runs");
    let pane = RunsView::new(20, &runs);
    let rows = pane.render(&view, 80, &KeybindingsManager::new());
    let text = flat(&rows);
    let listed = text.iter().filter(|row| row.contains("tool calls")).count();
    assert_eq!(listed, 2, "one row per run: {text:?}");
    assert!(
        text.iter()
            .any(|row| row.contains("\u{203a} \u{2713} 6 tool calls")),
        "the cursor starts on the newest run (the status glyph rides the row): {text:?}"
    );
}

#[test]
fn enter_drills_into_the_exact_uncondensed_rows() {
    let view = view_with_run(5);
    let runs = view.condensed_runs();
    let mut pane = RunsView::new(24, &runs);
    let kb = KeybindingsManager::new();
    pane.handle_key("enter", &kb, &view.chat, &runs);
    let rows = pane.render(&view, 80, &kb);
    let text = flat(&rows);
    // The region shows the five cells' own rows (the exact overview rows
    // the block replaced), the run's summary header above them.
    assert!(
        text.iter().any(|row| row.contains("python")),
        "the cell rows render: {text:?}"
    );
    assert!(
        text.iter().any(|row| row.contains("5 tool calls")),
        "the run header renders: {text:?}"
    );
    assert!(
        text.iter()
            .any(|row| row.contains("\u{2191}/\u{2193} scroll")),
        "the detail hint renders: {text:?}"
    );
}

#[test]
fn the_detail_scrolls_and_walks_back_out() {
    let view = view_with_run(5);
    let runs = view.condensed_runs();
    let mut pane = RunsView::new(10, &runs);
    let kb = KeybindingsManager::new();
    // A short viewport forces the region to clip: the top marker rides.
    pane.handle_key("enter", &kb, &view.chat, &runs);
    let rows = pane.render(&view, 60, &kb);
    let text = flat(&rows);
    assert!(
        text.iter().any(|row| row.trim_start() == "\u{2026}"),
        "the clipped top carries the more marker: {text:?}"
    );
    // Up lifts the window off the newest rows; the bottom marker rides.
    pane.handle_key("up", &kb, &view.chat, &runs);
    let rows = pane.render(&view, 60, &kb);
    let text = flat(&rows);
    assert!(
        text.iter().any(|row| row.trim_start() == "\u{2193}"),
        "the lifted window carries the bottom marker: {text:?}"
    );
    // Down walks back to the newest rows: the bottom marker releases and
    // the top marker rides again (the window is bottom-anchored once more).
    pane.handle_key("down", &kb, &view.chat, &runs);
    let rows = pane.render(&view, 60, &kb);
    let text = flat(&rows);
    assert!(
        !text.iter().any(|row| row.trim_start() == "\u{2193}"),
        "the bottom-anchored window has no bottom marker: {text:?}"
    );
    assert!(
        text.iter().any(|row| row.trim_start() == "\u{2026}"),
        "the window anchors on the newest rows again: {text:?}"
    );
    // Left (app.modal.back) returns to the list; Esc at the list closes.
    pane.handle_key("left", &kb, &view.chat, &runs);
    let rows = pane.render(&view, 60, &kb);
    let text = flat(&rows);
    assert!(
        text.iter().any(|row| row.contains("move")),
        "the list hint is back: {text:?}"
    );
    assert_eq!(
        pane.handle_key("escape", &kb, &view.chat, &runs),
        RunsViewAction::Close,
        "Esc at the list closes"
    );
}

#[test]
fn a_vanished_run_reconciles_to_the_nearest() {
    let view = view_with_run(5);
    let runs = view.condensed_runs();
    let mut pane = RunsView::new(24, &runs);
    pane.handle_key("enter", &kb(), &view.chat, &runs);
    // The run dissolved (a live split dropped it under the threshold).
    let empty: Vec<ToolRun> = Vec::new();
    assert_eq!(
        pane.reconcile(&view.chat, &empty),
        Some(RunsViewAction::Close),
        "no runs left closes the pane"
    );
    let view = view_with_run(5);
    let runs = view.condensed_runs();
    let mut pane = RunsView::new(24, &runs);
    let gone = vec![ToolRun {
        start: 7,
        end: 12,
        calls: 5,
    }];
    assert_eq!(
        pane.reconcile(&view.chat, &gone),
        None,
        "the pane stays open"
    );
    assert_eq!(
        pane.selected,
        Some(7),
        "the cursor moved to the only surviving run"
    );
}

#[test]
fn a_rebuild_that_shifts_indices_keeps_the_detail_by_run_identity() {
    // Two runs; the pane opens the OLDER run's detail. A resync rebuild
    // replaces the chat with the same cards at shifted indices (the
    // leading user row is gone), so the old start points into another
    // run: the pane re-finds the same run by its first card's wire id
    // instead of losing the detail back to the list.
    let mut view = view_with_run(5);
    view.push_entry(crate::chat::ChatEntry::User {
        text: "again".to_string(),
    });
    for index in 0..6 {
        view.push_entry(settled_card(&format!("e{index}"), "bash"));
    }
    let runs = view.condensed_runs();
    assert_eq!(runs.len(), 2, "two qualifying runs");
    let mut pane = RunsView::new(24, &runs);
    let kb = KeybindingsManager::new();
    pane.handle_key("up", &kb, &view.chat, &runs);
    pane.handle_key("enter", &kb, &view.chat, &runs);
    // The rebuild: the same runs on a chat whose indices all moved by
    // one (no leading user row).
    let mut rebuilt = AgentView::new(Theme::builtin("prime", ColorMode::TrueColor));
    for index in 0..5 {
        rebuilt.push_entry(settled_card(&format!("c{index}"), "ipython"));
    }
    rebuilt.push_entry(crate::chat::ChatEntry::Assistant(Box::new(
        AssistantMessage {
            blocks: vec![MessageBlock::Text("done".to_string())],
            has_tool_calls: false,
            streaming: false,
            error: None,
            aborted: false,
        },
    )));
    rebuilt.push_entry(crate::chat::ChatEntry::User {
        text: "again".to_string(),
    });
    for index in 0..6 {
        rebuilt.push_entry(settled_card(&format!("e{index}"), "bash"));
    }
    let shifted = rebuilt.condensed_runs();
    assert_eq!(shifted.len(), 2, "the rebuilt chat holds both runs");
    assert_ne!(
        shifted[0].start, runs[0].start,
        "the rebuild shifted the chat indices"
    );
    assert_eq!(
        pane.reconcile(&rebuilt.chat, &shifted),
        None,
        "the pane stays open"
    );
    let rows = pane.render(&rebuilt, 80, &kb);
    let text = flat(&rows);
    assert!(
        text.iter().any(|row| row.contains("5 tool calls")),
        "the detail stayed on the c-run, not the list: {text:?}"
    );
    assert!(
        text.iter().any(|row| row.contains("scroll")),
        "the detail pane survived the rebuild: {text:?}"
    );
}

fn kb() -> KeybindingsManager {
    KeybindingsManager::new()
}
