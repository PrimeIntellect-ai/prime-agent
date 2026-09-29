//! The key wiring: user overrides over the inert defaults, the page keys,
//! the double ctrl+c exit, and the kitty releases.

use super::*;

#[test]
fn open_key_override_fires_and_the_default_is_inert() {
    let mut mode = mode_with_user_bindings(&[("app.agents.open", "ctrl+g")]);
    mode.handle_key("down");
    assert_eq!(mode.rows[mode.selected].kind, RowKind::SubagentSummary);
    // The override fires: the summary row toggles its list.
    mode.handle_key("ctrl+g");
    assert_eq!(mode.rows.len(), 3);
    assert!(mode.rows[1].expanded);
    // The default key no longer opens (a rebound binding replaces the
    // default keys outright).
    mode.handle_key("right");
    assert_eq!(mode.rows.len(), 3, "right is inert after the override");
    assert!(mode.rows[1].expanded);
}

#[test]
fn page_keys_step_by_visible_list_rows() {
    let (mut mode, _) = mode_with_row("paged", "mock-1");
    // 40 extra selectable rows: every step below lands inside the
    // list instead of clamping at an edge.
    let template = mode.rows[0].clone();
    for i in 0..40 {
        let mut row = template.clone();
        row.identity = format!("row-{i}");
        row.title = row.identity.clone();
        row.summary = serde_json::json!({ "sessionName": row.identity.clone() });
        mode.rows.push(row);
    }
    // TS `visibleListRows()` is `max(4, terminal rows - 9)` and the
    // page keys move by `max(1, visibleListRows())`: the terminal
    // height of the last frame sets the step, with the 4-row floor
    // covering short terminals and the pre-render height 0.
    for (height, step) in [(40usize, 31usize), (24, 15), (12, 4), (5, 4), (0, 4)] {
        mode.render_frame(120, height);
        assert_eq!(mode.page_step(), step, "step at terminal height {height}");
        mode.selected = 0;
        mode.handle_key("pageDown");
        assert_eq!(mode.selected, step, "pageDown at terminal height {height}");
        mode.handle_key("pageUp");
        assert_eq!(mode.selected, 0, "pageUp at terminal height {height}");
    }
}

#[test]
fn expand_and_new_key_overrides_fire_and_defaults_are_inert() {
    let mut mode =
        mode_with_user_bindings(&[("app.agents.expand", "alt+x"), ("app.agents.new", "alt+n")]);
    mode.handle_key("alt+x");
    assert_eq!(mode.rows.len(), 3, "the expand override fires");
    mode.handle_key("alt+right");
    assert_eq!(mode.rows.len(), 3, "the default expand key is inert");
    // The new-session override ends the run for a fresh session; the
    // default ctrl+n no longer does.
    mode.handle_key("alt+n");
    assert!(!mode.running);
    assert!(mode.new_session);
    let mut mode =
        mode_with_user_bindings(&[("app.agents.expand", "alt+x"), ("app.agents.new", "alt+n")]);
    mode.handle_key("ctrl+n");
    assert!(mode.running, "the default new key is inert");
    assert!(!mode.new_session);
}

/// TS `cycleProgramForSelected` (the `app.agents.program` key, default
/// ctrl+o): the parent with a code-carrying child expands its list with
/// the program's rows above the child — the code block capped and
/// padded — and a second press hides them while the list stays open;
/// the code rows never take the selection; a parent whose children
/// carry no code reports instead.
#[test]
fn program_key_shows_and_hides_the_spawn_program() {
    let mut mode = mode_with_parent_and_child();
    // The child spawned from a 12-line cell: the program block caps at
    // 10 lines and counts the remainder (the trailing newline strips).
    mode.roster[1]["summary"]["spawnCode"] = serde_json::json!(
        "line0\nline1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\n"
    );
    mode.rebuild_rows();
    mode.handle_key("ctrl+o");
    // Parent, summary line, pad-top + 10 code lines + the remainder row
    // + pad-bottom, then the child (the whole-vec equality below pins
    // the row set).
    let after_summary: Vec<(RowKind, String)> = mode.rows[2..]
        .iter()
        .map(|row| (row.kind, row.title.clone()))
        .collect();
    let mut expected = vec![(RowKind::Code, String::new())];
    for index in 0..10 {
        expected.push((RowKind::Code, format!("line{index}")));
    }
    expected.push((RowKind::Code, "\u{2026} +2 more lines".to_string()));
    expected.push((RowKind::Code, String::new()));
    expected.push((RowKind::Subagent, "worker one".to_string()));
    assert_eq!(
        after_summary, expected,
        "the program rows precede the child"
    );
    // The selection walks over the program: down from the parent is the
    // summary line, the next down skips every code row.
    mode.handle_key("down");
    assert_eq!(mode.rows[mode.selected].kind, RowKind::SubagentSummary);
    mode.handle_key("down");
    assert_eq!(
        mode.rows[mode.selected].title, "worker one",
        "the code rows are not selectable"
    );
    // A second ctrl+o hides the program, the list stays expanded.
    mode.handle_key("ctrl+o");
    assert_eq!(mode.rows.len(), 3);
    assert!(mode.rows[1].expanded);
    assert!(mode.rows.iter().all(|row| row.kind != RowKind::Code));
    // A parent whose children carry no code reports TS's status.
    let mut mode = mode_with_parent_and_child();
    mode.selected = 0;
    mode.handle_key("ctrl+o");
    assert_eq!(
        mode.status.as_deref(),
        Some("No program recorded for these subagents")
    );
}
