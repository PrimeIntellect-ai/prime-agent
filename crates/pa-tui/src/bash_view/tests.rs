//! The bash view's unit battery: the wire parsing, the pane geometry,
//! the key loop, and the lazy tail window's scroll, load-more, and
//! retry lifecycle.

use super::*;
use crate::keybindings::KeybindingsManager;
use crate::theme::{ColorMode, Theme};
use serde_json::json;

fn kb() -> KeybindingsManager {
    KeybindingsManager::new()
}

fn theme() -> Theme {
    Theme::builtin("prime", ColorMode::TrueColor)
}

fn activities() -> Vec<BashActivity> {
    parse_bash_activities(&json!({"activities": [
        {"id":"a","command":"cargo build --release","pid":42,"startedAt":"2026-09-22T01:00:00Z","status":"running","durationMs":3412},
        {"id":"b","command":"echo hi","status":"finished","exitCode":0,"durationMs":123},
    ]}))
}

/// A finished row with a nonzero exit (the failed state).
fn failed_activities() -> Vec<BashActivity> {
    parse_bash_activities(&json!({"activities": [
        {"id":"f","command":"grep -rn panic src/","pid":7,"startedAt":"2026-09-22T01:00:00Z","status":"finished","exitCode":2,"durationMs":5_612},
    ]}))
}

fn frame_text(frame: &[Line]) -> Vec<String> {
    frame
        .iter()
        .map(|line| line.iter().map(|span| span.content.as_str()).collect())
        .collect()
}

/// The span styles of one frame row, for the color assertions.
fn row_text(frame: &[Line], needle: &str) -> Option<Line> {
    frame
        .iter()
        .find(|line| line.iter().any(|span| span.content.contains(needle)))
        .cloned()
}

#[test]
fn parse_reads_the_wire_shape() {
    let rows = activities();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].id, "a");
    assert_eq!(rows[0].pid, Some(42));
    assert!(rows[0].running());
    assert_eq!(rows[1].exit_code, Some(0));
    assert!(!rows[1].running());
    // Rows without a nonempty id drop.
    let rows = parse_bash_activities(&json!({"activities": [
        {"command":"x"},
        {"id":"  ","command":"y"},
        {"id":"z","command":"w"},
    ]}));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "z");
}

/// The registry's own order survives within each side.
#[test]
fn running_shells_ride_the_top_of_the_list() {
    let rows = parse_bash_activities(&json!({"activities": [
        {"id":"done-1","command":"echo one","status":"finished","exitCode":0},
        {"id":"live-1","command":"sleep 10","status":"running"},
        {"id":"done-2","command":"echo two","status":"finished","exitCode":1},
        {"id":"live-2","command":"sleep 20","status":"running"},
    ]}));
    let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
    assert_eq!(ids, ["live-1", "live-2", "done-1", "done-2"]);
}

#[test]
fn the_list_renders_columned_rows_and_one_hint() {
    let view = BashView::new(activities(), 24);
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(text.iter().any(|row| row.contains("Bash")));
    assert!(text.iter().any(|row| row.contains("1 running")));
    let header = text
        .iter()
        .find(|row| row.contains("Command") && row.contains("Duration"))
        .expect("a column header row");
    assert!(header.contains("PID"));
    assert!(header.contains("Status"));
    let row = text
        .iter()
        .find(|row| row.contains("cargo build --release"))
        .expect("a columned row");
    assert!(row.contains("3.4s"));
    assert!(row.contains("42"));
    assert!(row.contains("running"));
    assert_eq!(
        text.iter().filter(|row| row.contains("Esc close")).count(),
        1,
        "the close hint appears once: {text:?}"
    );
    assert!(text
        .iter()
        .any(|row| row
            .contains("\u{2191}/\u{2193} move \u{b7} Enter open \u{b7} \u{2190}/Esc close")));
    for line in &frame {
        assert!(crate::width::spans_width(line) <= 70);
    }
}

#[test]
fn the_list_hint_drops_unbound_keys() {
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert("app.modal.back".to_string(), Vec::new());
    let kb = KeybindingsManager::with_user_bindings(cfg);
    let view = BashView::new(activities(), 24);
    let frame = view.render(&theme(), 70, &kb);
    let text = frame_text(&frame);
    assert!(
        text.iter()
            .any(|row| row.contains("\u{2191}/\u{2193} move \u{b7} Enter open \u{b7} Esc close")),
        "the emptied back binding drops the arrow: {text:?}"
    );
}

/// The command column carries the remaining width; the fixed fact columns hug their content.
#[test]
fn the_columns_distribute_across_the_full_width() {
    let view = BashView::new(activities(), 24);
    let frame = view.render(&theme(), 120, &kb());
    let selected = frame
        .iter()
        .find(|line| {
            line.iter()
                .any(|span| span.style.bg.is_some() && span.content.contains("cargo"))
        })
        .expect("the selected row carries the wash");
    let used = crate::width::spans_width(selected);
    assert_eq!(
        used, 120,
        "the selected row's wash spans the whole terminal width: {used}"
    );
    let header = frame
        .iter()
        .find(|line| line.iter().any(|span| span.content.contains("Duration")))
        .expect("the column header");
    assert_eq!(
        crate::width::spans_width(header),
        120,
        "the columns span the terminal edge to edge"
    );
    let plain = frame
        .iter()
        .find(|line| line.iter().any(|span| span.content.contains("echo hi")))
        .expect("the other row");
    assert_eq!(
        crate::width::spans_width(plain),
        120,
        "every row spans the distributed width"
    );
    assert!(plain.iter().all(|span| span.style.bg.is_none()));
}

#[test]
fn the_selection_wash_spans_the_whole_width() {
    for width in [50usize, 90, 186] {
        let view = BashView::new(activities(), 24);
        let frame = view.render(&theme(), width, &kb());
        let selected = frame
            .iter()
            .find(|line| {
                line.iter()
                    .any(|span| span.style.bg.is_some() && span.content.contains("cargo"))
            })
            .expect("the selected row carries the wash");
        assert_eq!(
            crate::width::spans_width(selected),
            width,
            "the wash fills {width}"
        );
    }
}

/// One style constant (`Theme::selection_row_style`), not a per-surface copy.
#[test]
fn the_selected_row_paints_the_shared_selection_style() {
    let theme = theme();
    let frame = BashView::new(activities(), 24).render(&theme, 90, &kb());
    let selected = frame
        .iter()
        .find(|line| line.iter().any(|span| span.content.contains("cargo")))
        .expect("the selected row");
    let band = theme.selection_row_style();
    assert!(
        selected.iter().all(|span| span.style.bg == band.bg),
        "every span of the selected row carries the shared band: {selected:?}"
    );
    assert_eq!(
        band.bg,
        theme.hover_row_style().bg,
        "the shared selection paints the hover's own color — the one-color ruling"
    );
}

/// The selected row's wash patches a background onto its spans, so
/// the color check compares the foreground only.
#[test]
fn the_status_column_color_codes_the_states() {
    let success = theme().fg_style(ThemeColor::Success).fg;
    let dim = theme().fg_style(ThemeColor::Dim).fg;
    let error = theme().fg_style(ThemeColor::Error).fg;

    let view = BashView::new(activities(), 24);
    let frame = view.render(&theme(), 90, &kb());
    let running = row_text(&frame, "\u{25cf} running").expect("the running row");
    assert!(running.iter().any(|span| span.style.fg == success));
    let finished = row_text(&frame, "\u{25cb} finished").expect("the finished row");
    assert!(finished.iter().any(|span| span.style.fg == dim));
    assert!(finished.iter().all(|span| span.style.fg != error));

    let view = BashView::new(failed_activities(), 24);
    let frame = view.render(&theme(), 90, &kb());
    let failed = row_text(&frame, "\u{25cb} finished").expect("the failed row");
    assert!(failed.iter().any(|span| span.style.fg == error));
    assert!(failed.iter().all(|span| span.style.fg != success));
}

/// No rule rides below the hint — exactly one blank under it, the same treatment as the
/// `/model` view; a tall catalog fills the whole budget, a short one still ends on the blank.
#[test]
fn the_pane_runs_to_the_bottom() {
    let rows: Vec<BashActivity> = (0..20)
        .map(|n| BashActivity {
            id: format!("run-{n}"),
            command: format!("command {n}"),
            pid: Some(n + 1),
            started_at: None,
            status: "finished".to_string(),
            exit_code: Some(0),
            duration_ms: Some(u64::from(n) * 1_000),
        })
        .collect();
    for viewport in [10usize, 16, 24] {
        let view = BashView::new(rows.clone(), viewport);
        let frame = view.render(&theme(), 70, &kb());
        // The hint is the last content row with exactly one blank below it (the dock
        // anchors the pane's rows on the screen's bottom).
        assert!(frame.len() <= viewport, "never past the budget");
        let text = frame_text(&frame);
        let last_row = text.last().expect("the trailing blank row");
        assert!(
            last_row.trim().is_empty() && !last_row.contains("\u{2500}"),
            "one blank line rides below the shortcuts, never a rule: {last_row}"
        );
        let second_to_last = &text[text.len() - 2];
        assert!(
            second_to_last.contains("close"),
            "the shortcuts hint rides just above the blank: {second_to_last}"
        );
        let third_to_last = &text[text.len() - 3];
        assert!(
            third_to_last.trim().is_empty(),
            "the one blank above the hint stays: {third_to_last}"
        );
    }
    let view = BashView::new(activities(), 24);
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    let last_row = text.last().expect("the trailing blank row");
    assert!(last_row.trim().is_empty());
    assert!(!last_row.contains("\u{2500}"));
    let mut view = BashView::new(activities(), 16);
    view.handle_key("enter", &kb());
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    let last_row = text.last().expect("the trailing blank row");
    assert!(last_row.trim().is_empty());
    assert!(text[text.len() - 2].contains("close"));
}

#[test]
fn enter_opens_the_detail_and_the_cancel_action() {
    let mut view = BashView::new(activities(), 24);
    let action = view.handle_key("enter", &kb());
    let BashViewAction::OpenDetail {
        id: open_id,
        generation: first_generation,
    } = &action
    else {
        panic!("the first enter opens the detail: {action:?}");
    };
    assert_eq!(open_id, "a");
    assert_eq!(
        view.mode,
        Mode::Detail {
            id: "a".to_string()
        }
    );
    assert_eq!(
        view.handle_key("enter", &kb()),
        BashViewAction::Kill { id: "a".into() }
    );
    // Back to the list, then the finished row: it offers no actions.
    assert_eq!(view.handle_key("left", &kb()), BashViewAction::None);
    assert_eq!(view.mode, Mode::List);
    view.handle_key("down", &kb());
    let action = view.handle_key("enter", &kb());
    let BashViewAction::OpenDetail { id: open_id, .. } = &action else {
        panic!("the finished row opens its detail: {action:?}");
    };
    assert_eq!(open_id, "b");
    assert_eq!(view.handle_key("enter", &kb()), BashViewAction::None);
    let _ = first_generation;
}

/// No labeled-pair blocks, no section labels, no duplicated title.
#[test]
fn the_detail_is_one_metadata_row_the_command_and_the_output() {
    let mut view = BashView::new(activities(), 40);
    view.handle_key("enter", &kb());
    view.set_output(
        "a",
        "line one\n\x1b[31mred\x1b[0m\nline three",
        view.detail_generation,
    );
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    let joined = text.join("\n");
    assert!(
        text.iter().any(|row| {
            row.contains("pid 42")
                && row.contains("started")
                && row.contains("3.4s")
                && row.contains("running")
        }),
        "one metadata row with the facts together: {text:?}"
    );
    assert!(!text.iter().any(|row| row.contains("  Command")));
    assert!(!text.iter().any(|row| row.contains("  Output")));
    assert_eq!(
        text.iter()
            .filter(|row| row.contains("cargo build --release"))
            .count(),
        1,
        "the command renders once, not again as a title: {text:?}"
    );
    let command_index = text
        .iter()
        .position(|row| row.contains("cargo build --release"))
        .expect("the command row");
    let output_index = text
        .iter()
        .position(|row| row.contains("line one"))
        .expect("the output row");
    assert!(
        output_index > command_index,
        "the output rides under the command"
    );
    assert!(joined.contains("red"));
    assert!(!joined.contains('\x1b'));
    assert!(text.iter().any(|row| row.contains("Cancel command")));
    assert!(text.iter().any(|row| row.contains(
        "\u{2191}/\u{2193} scroll \u{b7} Enter run \u{b7} \u{2190} back \u{b7} Esc close"
    )));
}

#[test]
fn the_detail_status_color_codes_the_state() {
    let mut view = BashView::new(activities(), 40);
    view.handle_key("enter", &kb());
    let frame = view.render(&theme(), 70, &kb());
    let metadata = row_text(&frame, "running").expect("the metadata row");
    assert!(metadata
        .iter()
        .any(|span| span.style == theme().fg_style(ThemeColor::Success)));

    let mut view = BashView::new(failed_activities(), 40);
    view.handle_key("enter", &kb());
    let frame = view.render(&theme(), 70, &kb());
    let metadata = row_text(&frame, "exit 2").expect("the failed metadata row");
    assert!(metadata
        .iter()
        .any(|span| span.style == theme().fg_style(ThemeColor::Error)));
}

#[test]
fn the_finished_detail_has_no_action_and_no_run_hint() {
    let mut view = BashView::new(activities(), 40);
    view.handle_key("down", &kb());
    view.handle_key("enter", &kb());
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(!text.iter().any(|row| row.contains("Cancel command")));
    assert!(
        text.iter()
            .any(|row| row
                .contains("\u{2191}/\u{2193} scroll \u{b7} \u{2190} back \u{b7} Esc close")),
        "no run key without an action: {text:?}"
    );
}

#[test]
fn stale_and_empty_tails_are_handled() {
    let mut view = BashView::new(activities(), 40);
    view.handle_key("enter", &kb());
    view.set_output("b", "wrong row", view.detail_generation);
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(text.iter().any(|row| row.contains("Fetching output")));
    view.set_output("a", "", view.detail_generation);
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(text.iter().any(|row| row.contains("No output yet")));
    assert!(!text.iter().any(|row| row.contains("wrong row")));
}

#[test]
fn back_returns_to_the_list_and_escape_closes() {
    let mut view = BashView::new(activities(), 24);
    view.handle_key("enter", &kb());
    assert_eq!(view.handle_key("left", &kb()), BashViewAction::None);
    assert_eq!(view.mode, Mode::List);
    assert_eq!(view.handle_key("escape", &kb()), BashViewAction::Close);
    assert_eq!(view.handle_key("ctrl+c", &kb()), BashViewAction::Close);
}

/// Drops a detail pane whose row vanished.
#[test]
fn a_refresh_keeps_the_surviving_selection() {
    let mut view = BashView::new(activities(), 24);
    view.handle_key("down", &kb());
    assert_eq!(view.selected_id.as_deref(), Some("b"));
    let refreshed = parse_bash_activities(&json!({"activities": [
        {"id":"c","command":"ls","status":"running"},
    ]}));
    view.apply_activities(refreshed);
    assert_eq!(view.selected_id.as_deref(), Some("c"));
    view.handle_key("enter", &kb());
    let emptied = parse_bash_activities(&json!({"activities": []}));
    view.apply_activities(emptied);
    assert_eq!(view.mode, Mode::List);
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(text
        .iter()
        .any(|row| row.contains("No background commands")));
}

#[test]
fn short_viewports_never_clip_the_panes() {
    for viewport_rows in [9usize, 10, 12, 14] {
        let view = BashView::new(activities(), viewport_rows);
        let frame = view.render(&theme(), 70, &kb());
        assert!(frame.len() <= viewport_rows, "viewport {viewport_rows}");
        let text = frame_text(&frame);
        assert!(text.iter().any(|row| row.contains("Esc close")));
    }
    let mut view = BashView::new(activities(), 12);
    view.handle_key("enter", &kb());
    let frame = view.render(&theme(), 70, &kb());
    assert!(frame.len() <= 12, "detail pane fits: {}", frame.len());
    let text = frame_text(&frame);
    assert!(text.iter().any(|row| row.contains("Cancel command")));
}

/// The action row and the hint never yield.
#[test]
fn a_tight_viewport_keeps_the_output_minimum_over_the_command() {
    let mut catalog = activities();
    catalog[0].command = "word ".repeat(80);
    let mut view = BashView::new(catalog, 12);
    view.handle_key("enter", &kb());
    let frame = view.render(&theme(), 70, &kb());
    assert!(frame.len() <= 12, "the drill-in fits: {}", frame.len());
    let text = frame_text(&frame);
    assert!(text.iter().any(|row| row.contains("word")));
    assert!(text.iter().any(|row| row.contains("Cancel command")));
    assert!(text.iter().any(|row| row.contains("Fetching output")));
}

/// A tail taller than the region drops the OLDEST lines, never the newest.
#[test]
fn the_region_anchors_on_the_newest_output() {
    let mut catalog = activities();
    catalog[0].command = "run".to_string(); // short command, long output
    let mut view = BashView::new(catalog, 20);
    view.handle_key("enter", &kb());
    let tail: Vec<String> = (1..=30).map(|n| format!("line-{n:02}")).collect();
    view.set_output("a", &tail.join("\n"), view.detail_generation);
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(frame.len() <= 20, "the drill-in fits: {}", frame.len());
    let joined = text.join(" ");
    assert!(joined.contains("line-30"), "the newest line renders");
    assert!(!joined.contains("line-01"), "the oldest drops first");
    let marker = text
        .iter()
        .position(|row| row.trim() == "\u{2026}")
        .expect("the leading marker");
    let newest = text
        .iter()
        .position(|row| row.contains("line-30"))
        .expect("the newest row");
    assert!(marker < newest, "the marker rides above the content");
}

/// A `\u{2193}` marker rides under the last row while scrolled up.
#[test]
fn the_region_scrolls_up_and_down() {
    let mut catalog = activities();
    catalog[0].command = "run".to_string();
    let mut view = BashView::new(catalog, 24);
    view.handle_key("enter", &kb());
    let tail: Vec<String> = (1..=40).map(|n| format!("line-{n:02}")).collect();
    view.set_output("a", &tail.join("\n"), view.detail_generation);
    // A paint records the region's height; the keys walk the same
    // window (the real flow paints before keys arrive).
    let _ = view.render(&theme(), 70, &kb());
    let mut frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(text.iter().any(|row| row.contains("line-40")));
    assert!(!text.iter().any(|row| row.contains("line-02")));

    view.handle_key("up", &kb());
    frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(
        text.iter().any(|row| row.contains("line-26")),
        "one up reveals the next older line: {text:?}"
    );
    assert!(
        !text.iter().any(|row| row.contains("line-40")),
        "the lifted window's newest edge hides under the trailing marker"
    );
    assert!(
        text.iter().any(|row| row.trim() == "\u{2193}"),
        "the trailing marker rides under a lifted window"
    );
    assert!(text.iter().any(|row| row.contains("\u{2026}")));

    view.handle_key("down", &kb());
    frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(
        text.iter().any(|row| row.contains("line-40")),
        "down walks back to the newest output"
    );
    assert!(
        !text.iter().any(|row| row.trim() == "\u{2193}"),
        "bottom-anchored again: no trailing marker"
    );
}

/// The window doubles (50 -> 100 -> 200, the wire's cap), the grown response anchors the
/// region where it stopped, and the cap or a non-growing response ends the loads.
#[test]
fn up_at_the_loaded_top_lazily_loads_more_of_the_tail() {
    let mut catalog = activities();
    catalog[0].command = "run".to_string();
    let mut view = BashView::new(catalog, 24);
    view.handle_key("enter", &kb());
    let first: Vec<String> = (1..=FIRST_TAIL_LINES)
        .map(|n| format!("line-{n:03}"))
        .collect();
    view.set_output("a", &first.join("\n"), view.detail_generation);
    let _ = view.render(&theme(), 70, &kb());
    // A full window does not promise more: up walks the loaded lines.
    assert_eq!(view.handle_key("up", &kb()), BashViewAction::None);

    // Scroll to the loaded top: the next up issues the lazy load.
    for _ in 0..FIRST_TAIL_LINES {
        match view.handle_key("up", &kb()) {
            BashViewAction::LoadMore { id, lines, .. } => {
                assert_eq!(id, "a");
                assert_eq!(lines, FIRST_TAIL_LINES * 2);
                // The grown window: same newest lines plus the older
                // ones prepended.
                let mut grown: Vec<String> = (1..=FIRST_TAIL_LINES * 2)
                    .map(|n| format!("line-{n:03}"))
                    .collect();
                grown.truncate(FIRST_TAIL_LINES as usize * 2);
                view.set_output("a", &grown.join("\n"), view.detail_generation);
                break;
            }
            BashViewAction::None => {}
            other => panic!("up only walks or loads: {other:?}"),
        }
    }
    assert_eq!(view.tail_window, FIRST_TAIL_LINES * 2);
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    let joined = text.join(" ");
    // The region continues into the older lines (anchored just above
    // where the walk stopped), not back onto the newest output.
    assert!(
        joined.contains("line-049"),
        "the region walks into the older lines: {joined}"
    );
    assert!(
        !joined.contains("line-100"),
        "the newest lines no longer fill the region: {joined}"
    );
    assert!(!view.tail_complete, "the grown window may still grow");

    // Up at the top again: the last possible window.
    for _ in 0..(FIRST_TAIL_LINES * 2 + 8) {
        match view.handle_key("up", &kb()) {
            BashViewAction::LoadMore { lines, .. } => {
                assert_eq!(lines, TAIL_LINES);
                let full: Vec<String> = (1..=TAIL_LINES).map(|n| format!("line-{n:03}")).collect();
                view.set_output("a", &full.join("\n"), view.detail_generation);
                break;
            }
            BashViewAction::None => {}
            other => panic!("up only walks or loads: {other:?}"),
        }
    }
    assert_eq!(view.tail_window, TAIL_LINES);
    assert!(view.tail_complete, "the wire's line cap is the end");
    // No further loads: the up key just walks (or rests at the top).
    for _ in 0..TAIL_LINES + 4 {
        assert!(
            matches!(view.handle_key("up", &kb()), BashViewAction::None),
            "no loads past the wire cap"
        );
    }
}

#[test]
fn a_load_more_that_grew_nothing_completes_the_tail() {
    let mut catalog = activities();
    catalog[0].command = "run".to_string();
    let mut view = BashView::new(catalog, 24);
    view.handle_key("enter", &kb());
    let tail: Vec<String> = (1..=FIRST_TAIL_LINES)
        .map(|n| format!("line-{n:03}"))
        .collect();
    view.set_output("a", &tail.join("\n"), view.detail_generation);
    let _ = view.render(&theme(), 70, &kb());
    for _ in 0..FIRST_TAIL_LINES {
        match view.handle_key("up", &kb()) {
            BashViewAction::LoadMore {
                id,
                generation,
                lines,
            } => {
                assert_eq!(id, "a");
                assert_eq!(generation, view.detail_generation);
                assert_eq!(lines, FIRST_TAIL_LINES * 2);
                // The kernel's retained buffer had nothing more.
                view.set_output("a", &tail.join("\n"), generation);
                break;
            }
            BashViewAction::None => {}
            other => panic!("up only walks or loads: {other:?}"),
        }
    }
    assert!(view.tail_complete, "a non-growing response ends the loads");
    assert!(!view.loading_more);
    for _ in 0..FIRST_TAIL_LINES {
        assert!(
            matches!(view.handle_key("up", &kb()), BashViewAction::None),
            "no further loads after completion"
        );
    }
}

#[test]
fn a_short_window_completes_the_tail() {
    let mut catalog = activities();
    catalog[0].command = "run".to_string();
    let mut view = BashView::new(catalog, 24);
    view.handle_key("enter", &kb());
    let tail: Vec<String> = (1..=20).map(|n| format!("line-{n:02}")).collect();
    view.set_output("a", &tail.join("\n"), view.detail_generation);
    assert!(view.tail_complete, "20 lines over a 50-line window");
    let _ = view.render(&theme(), 70, &kb());
    for _ in 0..30 {
        assert!(
            matches!(view.handle_key("up", &kb()), BashViewAction::None),
            "a complete tail never loads more"
        );
    }
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(
        text.iter().any(|row| row.contains("line-01")),
        "the retained beginning renders once scrolled to the top"
    );
    assert!(
        !text.iter().any(|row| row.trim() == "\u{2026}"),
        "no continuation marker over a complete tail"
    );
}

/// A kill error touches neither the window nor the claim and clears only on the registry refresh.
#[test]
fn an_error_releases_the_load_claim_and_a_success_clears_it() {
    let mut catalog = activities();
    catalog[0].command = "run".to_string();
    let mut view = BashView::new(catalog, 24);
    view.handle_key("enter", &kb());
    let tail: Vec<String> = (1..=FIRST_TAIL_LINES)
        .map(|n| format!("line-{n:03}"))
        .collect();
    view.set_output("a", &tail.join("\n"), view.detail_generation);
    let _ = view.render(&theme(), 70, &kb());
    let mut loaded = false;
    for _ in 0..FIRST_TAIL_LINES {
        match view.handle_key("up", &kb()) {
            BashViewAction::LoadMore { generation, .. } => {
                view.set_error("kernel stalled".to_string(), true, Some(generation));
                assert!(view.error.is_some());
                assert!(!view.loading_more, "the failure releases the claim");
                assert_eq!(
                    view.tail_window, FIRST_TAIL_LINES,
                    "the failed load's window is restored to the loaded size"
                );
                assert_eq!(generation, view.detail_generation);
                loaded = true;
                break;
            }
            BashViewAction::None => {}
            other => panic!("up only walks or loads: {other:?}"),
        }
    }
    assert!(loaded, "the up press issued the load");
    let frame = view.render(&theme(), 70, &kb());
    assert!(
        frame_text(&frame)
            .iter()
            .any(|row| row.contains("Error: kernel stalled")),
        "the fetch error surfaces"
    );
    // The retry re-issues the same grown window (not the wire cap):
    // the restored window doubles from the loaded size.
    let mut retried = false;
    for _ in 0..FIRST_TAIL_LINES {
        match view.handle_key("up", &kb()) {
            BashViewAction::LoadMore {
                lines, generation, ..
            } => {
                assert_eq!(lines, FIRST_TAIL_LINES * 2);
                // The grown window lands: the shown fetch error is
                // stale — the fetch just succeeded.
                let grown: Vec<String> = (1..=FIRST_TAIL_LINES * 2)
                    .map(|n| format!("line-{n:03}"))
                    .collect();
                view.set_output("a", &grown.join("\n"), generation);
                retried = true;
                break;
            }
            BashViewAction::None => {}
            other => panic!("up only walks or loads: {other:?}"),
        }
    }
    assert!(retried, "the retry loads again");
    assert!(
        view.error.is_none(),
        "the successful fetch supersedes the fetch error"
    );
    let frame = view.render(&theme(), 70, &kb());
    assert!(
        !frame_text(&frame).iter().any(|row| row.contains("Error:")),
        "the error row is gone after the landing"
    );

    // A kill error keeps its lifecycle: it neither clears the error on
    // a tail landing nor releases a load claim.
    view.set_error("Could not kill bash command: gone".to_string(), false, None);
    assert!(view.error.is_some());
    view.set_output("a", &tail.join("\n"), view.detail_generation);
    assert!(
        view.error.is_some(),
        "a tail landing never clears a kill error"
    );
    view.clear_error();
    assert!(view.error.is_none());
}

/// Restores the loaded window, so the retry re-issues the same cap request.
#[test]
fn a_failed_final_load_keeps_the_tail_reachable() {
    let mut catalog = activities();
    catalog[0].command = "run".to_string();
    let mut view = BashView::new(catalog, 24);
    view.handle_key("enter", &kb());
    let lines =
        |count: u32| -> Vec<String> { (1..=count).map(|n| format!("line-{n:03}")).collect() };
    // The real flow: 50 loads, grows to 100, then the final growth to
    // the 200-line wire cap - which FAILS.
    view.set_output(
        "a",
        &lines(FIRST_TAIL_LINES).join("\n"),
        view.detail_generation,
    );
    let _ = view.render(&theme(), 70, &kb());
    for _ in 0..FIRST_TAIL_LINES {
        match view.handle_key("up", &kb()) {
            BashViewAction::LoadMore { generation, .. } => {
                view.set_output("a", &lines(FIRST_TAIL_LINES * 2).join("\n"), generation);
                break;
            }
            BashViewAction::None => {}
            other => panic!("up only walks or loads: {other:?}"),
        }
    }
    let _ = view.render(&theme(), 70, &kb());
    let mut failed = false;
    for _ in 0..TAIL_LINES {
        match view.handle_key("up", &kb()) {
            BashViewAction::LoadMore {
                generation: gen,
                lines,
                ..
            } => {
                assert_eq!(lines, TAIL_LINES);
                view.set_error("kernel stalled".to_string(), true, Some(gen));
                failed = true;
                break;
            }
            BashViewAction::None => {}
            other => panic!("up only walks or loads: {other:?}"),
        }
    }
    assert!(failed, "the final (cap) load was issued");
    // The failure restored the loaded window, not the failed
    // request's cap, so the retry re-issues the same cap request.
    assert_eq!(view.tail_window, FIRST_TAIL_LINES * 2);
    assert!(!view.tail_complete, "the failed load never ends the tail");
    assert!(!view.loading_more);
    let mut retried = false;
    for _ in 0..TAIL_LINES {
        match view.handle_key("up", &kb()) {
            BashViewAction::LoadMore { lines, .. } => {
                assert_eq!(lines, TAIL_LINES);
                retried = true;
                break;
            }
            BashViewAction::None => {}
            other => panic!("up only walks or loads: {other:?}"),
        }
    }
    assert!(retried, "the cap retry re-issues after the failure");
}

/// The next Up stacks no duplicate; the still-in-flight load later lands and clears it.
#[test]
fn a_kill_error_never_releases_the_load_claim() {
    let mut catalog = activities();
    catalog[0].command = "run".to_string();
    let mut view = BashView::new(catalog, 24);
    view.handle_key("enter", &kb());
    let tail: Vec<String> = (1..=FIRST_TAIL_LINES)
        .map(|n| format!("line-{n:03}"))
        .collect();
    view.set_output("a", &tail.join("\n"), view.detail_generation);
    let _ = view.render(&theme(), 70, &kb());
    let mut generation = 0;
    for _ in 0..FIRST_TAIL_LINES {
        match view.handle_key("up", &kb()) {
            BashViewAction::LoadMore {
                generation: gen, ..
            } => {
                generation = gen;
                break;
            }
            BashViewAction::None => {}
            other => panic!("up only walks or loads: {other:?}"),
        }
    }
    assert!(view.loading_more, "the load is in flight");
    // The kill fails while the load is still in flight.
    view.set_error(
        "Could not kill bash command: still running".to_string(),
        false,
        None,
    );
    assert!(view.error.is_some());
    assert!(
        view.loading_more,
        "a kill error never releases the load claim"
    );
    assert_eq!(
        view.tail_window,
        FIRST_TAIL_LINES * 2,
        "a kill error never touches the window either"
    );
    assert_eq!(view.handle_key("up", &kb()), BashViewAction::None);
    assert!(view.loading_more);
    let grown: Vec<String> = (1..=FIRST_TAIL_LINES * 2)
        .map(|n| format!("line-{n:03}"))
        .collect();
    view.set_output("a", &grown.join("\n"), generation);
    assert!(!view.loading_more);
}

/// While the open fetch is still in flight, Up does nothing.
#[test]
fn an_up_press_retries_a_failed_open_fetch() {
    let mut view = BashView::new(activities(), 24);
    view.handle_key("enter", &kb());
    let generation = view.detail_generation;
    assert_eq!(view.handle_key("up", &kb()), BashViewAction::None);
    view.set_error(
        "Bash output: kernel stalled".to_string(),
        true,
        Some(generation),
    );
    assert!(view.fetch_error);
    // An Up press retries the open fetch under the same generation -
    // once: the in-flight claim holds key repeats at bay.
    assert_eq!(
        view.handle_key("up", &kb()),
        BashViewAction::OpenDetail {
            id: "a".to_string(),
            generation,
        }
    );
    assert!(view.open_retry, "the retry claim is held");
    for _ in 0..5 {
        assert_eq!(
            view.handle_key("up", &kb()),
            BashViewAction::None,
            "key repeats never stack duplicate retries"
        );
    }
    view.set_output("a", "line one", generation);
    assert!(view.error.is_none(), "the retry supersedes the fetch error");
    assert!(!view.open_retry);
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(text.iter().any(|row| row.contains("line one")));

    // A retry that FAILS releases the claim for the next Up, and a kill error meanwhile
    // never touches it: back out, reopen, fail the open fetch, retry, fail the retry, retry again.
    view.handle_key("left", &kb());
    view.handle_key("enter", &kb());
    let reopened = view.detail_generation;
    view.set_error("Bash output: first".to_string(), true, Some(reopened));
    assert_eq!(
        view.handle_key("up", &kb()),
        BashViewAction::OpenDetail {
            id: "a".to_string(),
            generation: reopened,
        }
    );
    view.set_error(
        "Bash output: retry failed".to_string(),
        true,
        Some(reopened),
    );
    assert!(!view.open_retry, "the failed retry releases the claim");
    assert_eq!(
        view.handle_key("up", &kb()),
        BashViewAction::OpenDetail {
            id: "a".to_string(),
            generation: reopened,
        }
    );
    view.set_error("Could not kill bash command: nope".to_string(), false, None);
    assert!(
        view.open_retry,
        "a kill error never releases the retry claim"
    );
    view.set_output("a", "line two", reopened);
    assert!(!view.open_retry);
    // The kill error survives the landing — its lifecycle is the
    // registry refresh, never a fetch success.
    assert!(view.error.is_some());
    view.clear_error();
    assert!(view.error.is_none());
}

/// Scrolling never underflows the region and never leaves a marker-only row.
#[test]
fn a_one_row_region_keeps_the_output_line() {
    let mut catalog = activities();
    catalog[0].command = "run".to_string();
    // viewport 9: fixed 7 (running row) leaves a 2-row budget - the
    // one-line command and exactly one output row.
    let mut view = BashView::new(catalog, 9);
    view.handle_key("enter", &kb());
    let tail: Vec<String> = (1..=5).map(|n| format!("line-{n}")).collect();
    view.set_output("a", &tail.join("\n"), view.detail_generation);
    let frame = view.render(&theme(), 70, &kb());
    assert!(frame.len() <= 9, "the pane fits: {}", frame.len());
    let text = frame_text(&frame);
    assert!(
        text.iter().any(|row| row.contains("line-5")),
        "the one-row region anchors on the newest line: {text:?}"
    );
    assert_eq!(view.detail_region_rows.get(), 1);

    // Scrolling up never panics and never leaves a marker-only row:
    // the single row shows the scrolled line itself.
    for expected in ["line-4", "line-3", "line-2", "line-1"] {
        view.handle_key("up", &kb());
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(
            text.iter().any(|row| row.contains(expected)),
            "the up press walks to {expected}: {text:?}"
        );
    }
    for _ in 0..4 {
        view.handle_key("down", &kb());
    }
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(text.iter().any(|row| row.contains("line-5")));
}

#[test]
fn the_detail_renders_the_exact_command_verbatim() {
    let mut catalog = activities();
    catalog[0].command = "echo  a\nls  --all".to_string();
    let mut view = BashView::new(catalog, 40);
    view.handle_key("enter", &kb());
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    let joined = text.join(" ");
    assert!(joined.contains("echo  a"), "repeated spaces stay: {joined}");
    assert!(joined.contains("ls  --all"), "the second line stays");
}

#[test]
fn fetched_output_keeps_its_leading_spacing() {
    let mut view = BashView::new(activities(), 40);
    view.handle_key("enter", &kb());
    view.set_output("a", "    indented line\nplain line", view.detail_generation);
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(
        text.iter().any(|row| row.contains("    indented line")),
        "leading spacing stays: {text:?}"
    );
}

#[test]
fn a_stale_generation_never_overwrites_the_reopened_detail() {
    let mut view = BashView::new(activities(), 40);
    view.handle_key("enter", &kb());
    let first_generation = view.detail_generation;
    view.set_output("a", "first fetch", first_generation);
    view.handle_key("left", &kb());
    view.handle_key("enter", &kb());
    assert_ne!(view.detail_generation, first_generation);
    view.set_output("a", "stale fetch", first_generation);
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(
        !text.iter().any(|row| row.contains("stale fetch")),
        "the stale generation never lands: {text:?}"
    );
    view.set_output("a", "fresh fetch", view.detail_generation);
    let frame = view.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(text.iter().any(|row| row.contains("fresh fetch")));
}

#[test]
fn a_clipped_command_trails_the_marker_inside_the_budget() {
    let mut catalog = activities();
    catalog[0].command = "word ".repeat(200);
    let mut view = BashView::new(catalog, 18);
    view.handle_key("enter", &kb());
    let frame = view.render(&theme(), 70, &kb());
    assert!(frame.len() <= 18, "the drill-in fits: {}", frame.len());
    let text = frame_text(&frame);
    assert!(
        text.iter().any(|row| row.contains("word")),
        "the command's head renders"
    );
    let text_idx = text
        .iter()
        .position(|row| row.trim() == "\u{2026}")
        .expect("the marker renders");
    let word_idx = text
        .iter()
        .position(|row| row.contains("word"))
        .expect("the command line");
    assert!(
        text_idx > word_idx,
        "the marker trails the command: {text:?}"
    );
    assert!(text.iter().any(|row| row.contains("Fetching output")));
}

#[test]
fn a_sub_frame_viewport_never_overflows() {
    for viewport_rows in [1usize, 2, 3, 5, 7] {
        let view = BashView::new(activities(), viewport_rows);
        let frame = view.render(&theme(), 70, &kb());
        assert!(
            frame.len() <= viewport_rows,
            "viewport {viewport_rows}: pane is {} rows",
            frame.len()
        );
    }
}

#[test]
fn durations_format_compactly() {
    assert_eq!(format_duration(None), "\u{2014}");
    assert_eq!(format_duration(Some(780)), "780ms");
    assert_eq!(format_duration(Some(3_412)), "3.4s");
    assert_eq!(format_duration(Some(125_000)), "2m 05s");
}
