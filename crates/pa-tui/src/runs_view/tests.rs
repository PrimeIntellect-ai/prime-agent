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
    let listed = text
        .iter()
        .filter(|row| row.contains("tool calls"))
        .count();
    assert_eq!(listed, 2, "one row per run: {text:?}");
    assert!(
        text.iter()
            .any(|row| row.contains("\u{203a} 6 tool calls")),
        "the cursor starts on the newest run: {text:?}"
    );
}

#[test]
fn enter_drills_into_the_exact_uncondensed_rows() {
    let view = view_with_run(5);
    let runs = view.condensed_runs();
    let mut pane = RunsView::new(24, &runs);
    let kb = KeybindingsManager::new();
    pane.handle_key("enter", &kb, &runs);
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
        text.iter().any(|row| row.contains("\u{2191}/\u{2193} scroll")),
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
    pane.handle_key("enter", &kb, &runs);
    let rows = pane.render(&view, 60, &kb);
    let text = flat(&rows);
    assert!(
        text.iter().any(|row| row.trim_start() == "\u{2026}"),
        "the clipped top carries the more marker: {text:?}"
    );
    // Up lifts the window off the newest rows; the bottom marker rides.
    pane.handle_key("up", &kb, &runs);
    let rows = pane.render(&view, 60, &kb);
    let text = flat(&rows);
    assert!(
        text.iter().any(|row| row.trim_start() == "\u{2193}"),
        "the lifted window carries the bottom marker: {text:?}"
    );
    // Left (app.modal.back) returns to the list; Esc at the list closes.
    pane.handle_key("left", &kb, &runs);
    let rows = pane.render(&view, 60, &kb);
    let text = flat(&rows);
    assert!(
        text.iter().any(|row| row.contains("move")),
        "the list hint is back: {text:?}"
    );
    assert_eq!(
        pane.handle_key("escape", &kb, &runs),
        RunsViewAction::Close,
        "Esc at the list closes"
    );
}

#[test]
fn a_vanished_run_reconciles_to_the_nearest() {
    let view = view_with_run(5);
    let runs = view.condensed_runs();
    let mut pane = RunsView::new(24, &runs);
    pane.handle_key("enter", &kb(), &runs);
    // The run dissolved (a live split dropped it under the threshold).
    let empty: Vec<ToolRun> = Vec::new();
    assert_eq!(
        pane.reconcile(&empty),
        Some(RunsViewAction::Close),
        "no runs left closes the pane"
    );
    let view = view_with_run(5);
    let runs = view.condensed_runs();
    let mut pane = RunsView::new(24, &runs);
    let gone = vec![ToolRun { start: 7, end: 12, calls: 5 }];
    assert_eq!(pane.reconcile(&gone), None, "the pane stays open");
    assert_eq!(
        pane.selected, Some(7),
        "the cursor moved to the only surviving run"
    );
}

fn kb() -> KeybindingsManager {
    KeybindingsManager::new()
}
