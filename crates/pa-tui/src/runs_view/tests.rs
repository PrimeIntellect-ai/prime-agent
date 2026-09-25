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
    let pane = RunsView::new(20, &view.chat, &runs);
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
    let mut pane = RunsView::new(24, &view.chat, &runs);
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
    let mut pane = RunsView::new(10, &view.chat, &runs);
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
    let mut pane = RunsView::new(24, &view.chat, &runs);
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
    let mut pane = RunsView::new(24, &view.chat, &runs);
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
    let mut pane = RunsView::new(24, &view.chat, &runs);
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

#[test]
fn the_detail_keeps_its_hint_when_the_region_fills_the_viewport() {
    // A long run in a short viewport clips the region: the pad must top
    // the region up to the frame rows BEFORE the footer only - the
    // footer's own blank and hint stay inside the viewport instead of
    // being truncated away.
    let view = view_with_run(5);
    let runs = view.condensed_runs();
    let mut pane = RunsView::new(10, &view.chat, &runs);
    let kb = KeybindingsManager::new();
    pane.handle_key("enter", &kb, &view.chat, &runs);
    let rows = pane.render(&view, 60, &kb);
    let text = flat(&rows);
    assert!(
        text.iter().any(|row| row.contains("scroll")),
        "the detail hint stays visible under a full region: {text:?}"
    );
}

#[test]
fn down_answers_immediately_at_the_top_of_the_detail() {
    let view = view_with_run(5);
    let runs = view.condensed_runs();
    let mut pane = RunsView::new(10, &view.chat, &runs);
    let kb = KeybindingsManager::new();
    pane.handle_key("enter", &kb, &view.chat, &runs);
    // The paint records the region's max offset; then overshoot the
    // top: the stored scroll saturates at that max, so the NEXT Down
    // moves the window instead of draining the excess first.
    let _ = pane.render(&view, 60, &kb);
    for _ in 0..20 {
        pane.handle_key("up", &kb, &view.chat, &runs);
    }
    let at_top = pane.render(&view, 60, &kb);
    pane.handle_key("down", &kb, &view.chat, &runs);
    let one_down = pane.render(&view, 60, &kb);
    assert_ne!(
        flat(&at_top),
        flat(&one_down),
        "Down moves the window immediately after the top (no overshoot drain)"
    );
}

#[test]
fn a_pane_opened_with_no_runs_waits_for_one() {
    // The pane closes only on the TRANSITION to empty: opened with no
    // runs it keeps its empty state (status churn never kills it) and
    // the first live run lands the cursor.
    let empty_view = view_with_run(0);
    let mut pane = RunsView::new(24, &empty_view.chat, &[]);
    assert_eq!(
        pane.reconcile(&empty_view.chat, &[]),
        None,
        "no transition: the pane keeps its empty state"
    );
    let live = view_with_run(5);
    let runs = live.condensed_runs();
    assert_eq!(pane.reconcile(&live.chat, &runs), None);
    assert_eq!(
        pane.selected,
        runs.last().map(|run| run.start),
        "the first live run takes the cursor"
    );
}

#[test]
fn an_impostor_run_on_the_same_start_loses_to_identity() {
    // A rebuild can land a DIFFERENT run on the stored start: the
    // stable first-card id wins over the position, so the open detail
    // stays on the same run instead of silently switching to the
    // impostor.
    let mut view = view_with_run(5);
    view.push_entry(crate::chat::ChatEntry::User {
        text: "again".to_string(),
    });
    for index in 0..6 {
        view.push_entry(settled_card(&format!("e{index}"), "bash"));
    }
    let runs = view.condensed_runs();
    let mut pane = RunsView::new(24, &view.chat, &runs);
    let kb = KeybindingsManager::new();
    pane.handle_key("up", &kb, &view.chat, &runs);
    pane.handle_key("enter", &kb, &view.chat, &runs);
    // The rebuild swaps the two runs' positions: the E-run now starts
    // at the stored start (1).
    let mut rebuilt = AgentView::new(Theme::builtin("prime", ColorMode::TrueColor));
    rebuilt.push_entry(crate::chat::ChatEntry::User {
        text: "run it".to_string(),
    });
    for index in 0..6 {
        rebuilt.push_entry(settled_card(&format!("e{index}"), "bash"));
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
    for index in 0..5 {
        rebuilt.push_entry(settled_card(&format!("c{index}"), "ipython"));
    }
    let swapped = rebuilt.condensed_runs();
    assert_eq!(swapped.len(), 2, "the rebuilt chat holds both runs");
    assert_eq!(
        pane.reconcile(&rebuilt.chat, &swapped),
        None,
        "the pane stays open"
    );
    let rows = pane.render(&rebuilt, 80, &kb);
    let text = flat(&rows);
    assert!(
        text.iter().any(|row| row.contains("5 tool calls")),
        "the detail stayed on the c-run (identity beat the impostor): {text:?}"
    );
}

#[test]
fn a_dropped_run_loses_the_detail_even_to_an_impostor_start() {
    // The viewed run VANISHED in the rebuild and a different run now
    // starts at the stored start: the identity is gone, so the detail
    // drops to the list instead of showing the impostor's cards (and
    // refresh_keys never adopts the impostor's key).
    let mut view = view_with_run(5);
    view.push_entry(crate::chat::ChatEntry::User {
        text: "again".to_string(),
    });
    for index in 0..6 {
        view.push_entry(settled_card(&format!("e{index}"), "bash"));
    }
    let runs = view.condensed_runs();
    let mut pane = RunsView::new(24, &view.chat, &runs);
    let kb = KeybindingsManager::new();
    pane.handle_key("up", &kb, &view.chat, &runs);
    pane.handle_key("enter", &kb, &view.chat, &runs);
    // The rebuild drops the c-run entirely: the e-run now starts at the
    // stored start (1).
    let mut rebuilt = AgentView::new(Theme::builtin("prime", ColorMode::TrueColor));
    rebuilt.push_entry(crate::chat::ChatEntry::User {
        text: "run it".to_string(),
    });
    for index in 0..6 {
        rebuilt.push_entry(settled_card(&format!("e{index}"), "bash"));
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
    let shifted = rebuilt.condensed_runs();
    assert_eq!(shifted.len(), 1, "the rebuilt chat holds the e-run alone");
    assert_eq!(shifted[0].start, 1, "the e-run occupies the stored start");
    assert_eq!(
        pane.reconcile(&rebuilt.chat, &shifted),
        None,
        "the pane stays open"
    );
    let rows = pane.render(&rebuilt, 80, &kb);
    let text = flat(&rows);
    assert!(
        text.iter().any(|row| row.contains("move")),
        "the detail fell back to the list (the impostor never shows): {text:?}"
    );
    assert!(
        !text.iter().any(|row| row.contains("scroll")),
        "no drill-in rides on the impostor: {text:?}"
    );
    // The cursor re-fell to the surviving run through the fallback (not
    // the impostor coincidence) and the refresh adopted the survivor's
    // OWN identity - never the stale c-run key.
    assert_eq!(pane.selected, Some(1), "the cursor lands on the survivor");
    assert_eq!(
        pane.selected_key.as_deref(),
        Some("e0"),
        "the refresh adopts the survivor's identity"
    );
}

fn kb() -> KeybindingsManager {
    KeybindingsManager::new()
}
