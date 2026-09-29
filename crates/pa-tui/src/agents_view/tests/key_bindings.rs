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

#[test]
fn second_ctrl_c_exits_and_other_keys_clear_the_hint() {
    let mut mode = mode_with_parent_and_child();
    // The first press arms the exit hint (TS `showCtrlCExitHint`).
    mode.handle_key("ctrl+c");
    assert!(mode.exit_armed);
    assert!(mode.running);
    // A second press exits (TS `handleCtrlC`'s visible-hint arm).
    mode.handle_key("ctrl+c");
    assert!(!mode.running);
    // Any other key clears the hint, so the next press re-arms it.
    let mut mode = mode_with_parent_and_child();
    mode.handle_key("ctrl+c");
    mode.handle_key("down");
    assert!(!mode.exit_armed);
    assert!(mode.running);
    mode.handle_key("ctrl+c");
    assert!(mode.exit_armed, "the cleared hint re-arms");
    assert!(mode.running);
}

/// Kitty-protocol key releases map to no key id: the reader filters
/// them the way every session handler does, so a release never runs
/// `handle_key`'s "any other key" arm — which would clear the armed
/// exit hint between the presses of a double Ctrl+C, and the second
/// press would re-arm the hint instead of exiting.
#[test]
fn kitty_releases_map_to_no_key_id() {
    let mut release = crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Char('c'),
        crossterm::event::KeyModifiers::CONTROL,
    );
    release.kind = crossterm::event::KeyEventKind::Release;
    assert!(crate::keys::key_event_to_id(&release).is_none());
}

#[test]
fn exit_hint_renders_the_effective_app_clear_key() {
    let mut mode = mode_with_user_bindings(&[("app.clear", "ctrl+q")]);
    // The rebound key arms the hint, rendered with the override (TS
    // `renderHints`: `Press ${keyText("app.clear")} again to exit`).
    mode.handle_key("ctrl+q");
    assert!(mode.exit_armed);
    assert_eq!(
        flat(&mode.render_hints(120, None)),
        "Press Ctrl+Q again to exit"
    );
    // The default ctrl+c no longer arms the exit flow.
    mode.exit_armed = false;
    mode.handle_key("ctrl+c");
    assert!(!mode.exit_armed);
    assert!(mode.running);
    // Two presses of the override exit (the first re-arms the hint).
    mode.handle_key("ctrl+q");
    assert!(mode.exit_armed);
    mode.handle_key("ctrl+q");
    assert!(!mode.running);
}
