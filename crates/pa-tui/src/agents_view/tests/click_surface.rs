//! The click grammar: which presses open a row (and which never do),
//! plus the row cells they land on (the name column clip/pad).

use super::*;

/// The exact expected idle-row text: name cell (icon + title, clipped or
/// padded to `name_width`), the model cell padded to its column, then
/// the cost/age details.
fn expected_row(title_cell: &str, layout: &RowLayout) -> String {
    let bullet = "\u{2022}";
    format!(
        "{bullet} {title_cell}  {}  $0.00   1s",
        cell("mock-1", layout.model_width),
    )
}

#[test]
fn a_plain_click_selects_and_opens_the_row_under_it() {
    // Mouse tracking is process-global state: the click grammar's
    // tests serialize through its lock and leave it off.
    let _guard = match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let (mut mode, index) = mode_with_row("click me", "mock-1");
    mode.rows[index].summary = serde_json::json!({
        "sessionName": "click me",
        "activeSessionId": "s-click",
    });
    mode.render_frame(120, 24);
    let (row, _) = mode
        .click_rows
        .iter()
        .find(|(_, row_index)| *row_index == index)
        .copied()
        .expect("the row renders");
    mode.handle_mouse(&mouse_report(row, true, false));
    mode.handle_mouse(&mouse_report(row, false, false));
    assert_eq!(mode.selected, index, "the click selected the row");
    assert!(
        mode.opened.is_some(),
        "the click opened the row (the Enter action)"
    );
    assert!(!mode.running, "an open ends the view run");
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}

#[test]
fn a_modified_press_never_opens_the_row() {
    let _guard = match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let (mut mode, index) = mode_with_row("shift over me", "mock-1");
    mode.rows[index].summary = serde_json::json!({
        "sessionName": "shift over me",
        "activeSessionId": "s-shift",
    });
    mode.render_frame(120, 24);
    let (row, _) = mode
        .click_rows
        .iter()
        .find(|(_, row_index)| *row_index == index)
        .copied()
        .expect("the row renders");
    let mut shifted = mouse_report(row, true, false);
    shifted.shift = true;
    mode.handle_mouse(&shifted);
    mode.handle_mouse(&mouse_report(row, false, false));
    assert!(mode.opened.is_none(), "the modified press never opened");
    assert!(mode.running, "the view keeps running");
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}

#[test]
fn a_dragged_release_never_opens_the_row() {
    let _guard = match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let (mut mode, index) = mode_with_row("drag over me", "mock-1");
    mode.render_frame(120, 24);
    let (row, _) = mode
        .click_rows
        .iter()
        .find(|(_, row_index)| *row_index == index)
        .copied()
        .expect("the row renders");
    mode.handle_mouse(&mouse_report(row, true, false));
    mode.handle_mouse(&mouse_report(row, true, true));
    mode.handle_mouse(&mouse_report(row, false, false));
    assert!(mode.opened.is_none(), "a dragged release never opens");
    assert!(mode.running, "the view keeps running");
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}

#[test]
fn a_release_on_another_row_never_opens() {
    let _guard = match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let (mut mode, index) = mode_with_row("press here", "mock-1");
    mode.render_frame(120, 24);
    let (row, _) = mode
        .click_rows
        .iter()
        .find(|(_, row_index)| *row_index == index)
        .copied()
        .expect("the row renders");
    mode.handle_mouse(&mouse_report(row, true, false));
    mode.handle_mouse(&mouse_report(row + 1, false, false));
    assert!(mode.opened.is_none(), "the press row gates the open");
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}

/// A fresh plain press always re-records its row: a lost release must never pin the next tap
/// to the old row (Cursor Bugbot: a new press kept the stale row).
#[test]
fn a_fresh_press_re_records_the_click_row_after_a_lost_release() {
    let _guard = match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let (mut mode, index) = mode_with_row("re-record me", "mock-1");
    mode.rows[index].summary = serde_json::json!({
        "sessionName": "re-record me",
        "activeSessionId": "s-re-record",
    });
    mode.render_frame(120, 24);
    let row_of = |mode: &AgentsViewMode, wanted: usize| {
        mode.click_rows
            .iter()
            .find(|(_, row_index)| *row_index == wanted)
            .map(|(row, _)| *row)
            .expect("the row renders")
    };
    let other = row_of(&mode, 0);
    let clicked = row_of(&mode, index);
    mode.handle_mouse(&mouse_report(other, true, false));
    mode.handle_mouse(&mouse_report(clicked, true, false));
    mode.handle_mouse(&mouse_report(clicked, false, false));
    let opened = mode.opened.expect("the fresh press re-recorded its row");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("s-re-record".to_string()),
        "the tapped row opened, not the lost press's"
    );
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}

/// The click is an input like any key: a showing notice panel consumes it — the close is the
/// click's whole action (Cursor Bugbot: the click opened through the refusal notice).
#[test]
fn a_click_consumes_the_notice_panel_like_any_key() {
    let _guard = match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let (mut mode, index) = mode_with_row("click through", "mock-1");
    mode.rows[index].summary = serde_json::json!({
        "sessionName": "click through",
        "activeSessionId": "s-through",
    });
    mode.notice = Some("The refusal block.\n\n- a second line".to_string());
    mode.render_frame(120, 24);
    let (row, _) = mode
        .click_rows
        .iter()
        .find(|(_, row_index)| *row_index == index)
        .copied()
        .expect("the row renders");
    mode.handle_mouse(&mouse_report(row, true, false));
    mode.handle_mouse(&mouse_report(row, false, false));
    assert!(mode.notice.is_none(), "the click closed the panel");
    assert!(
        mode.opened.is_none(),
        "the panel consumed the click - no open behind it"
    );
    assert!(mode.running, "the view keeps running behind the panel");
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}

/// The open's Enter preamble clears with the click (the exit hint, the armed confirm), so a
/// later ctrl+x re-arms over the clicked row (Cursor Bugbot: the click leaked both).
#[test]
fn a_click_clears_the_exit_hint_and_the_armed_delete_confirm() {
    let _guard = match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let (mut mode, index) = mode_with_row("click clears arms", "mock-1");
    mode.rows[0].summary = serde_json::json!({
        "sessionName": "holder",
        "activeSessionId": "s-holder",
    });
    mode.rows[index].summary = serde_json::json!({
        "sessionName": "click clears arms",
        "activeSessionId": "s-clears",
    });
    mode.render_frame(120, 24);
    let (row, _) = mode
        .click_rows
        .iter()
        .find(|(_, row_index)| *row_index == index)
        .copied()
        .expect("the row renders");
    mode.handle_key("ctrl+c");
    assert!(mode.exit_armed, "the first ctrl+c armed the exit hint");
    mode.handle_key("ctrl+x");
    assert!(
        mode.pending_delete.is_some(),
        "the ctrl+x armed the stop-or-delete confirm"
    );
    mode.handle_mouse(&mouse_report(row, true, false));
    mode.handle_mouse(&mouse_report(row, false, false));
    assert!(!mode.exit_armed, "the click dropped the exit hint");
    assert!(
        mode.pending_delete.is_none(),
        "the click took the armed confirm"
    );
    mode.handle_key("ctrl+x");
    assert!(mode.pending_delete.is_some(), "the confirm re-arms");
    assert!(
        mode.pending_delete_action.is_none(),
        "no execution rode the re-arm"
    );
    // The selection binds last: `expect` moves `mode.opened`, so no
    // method call on `mode` may follow it.
    let opened = mode.opened.expect("the click opened the row");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("s-clears".to_string())
    );
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}

#[test]
fn long_session_names_clip_to_the_name_column() {
    let (mode, index) = mode_with_row(&"a".repeat(100), "mock-1");
    let layout = build_layout(&mode.rows, 120);
    assert_eq!(layout.name_width, 28);
    assert_eq!(layout.model_width, 12);
    let line = mode.render_row(&mode.rows[index], &layout, 120, false);
    let text = flat(&line);
    // The name cell clips with an empty ellipsis marker: it keeps the icon and space plus 26
    // name characters.
    assert_eq!(text, expected_row(&"a".repeat(26), &layout));
    let model_at = text.find("mock-1").expect("model column present");
    assert_eq!(str_width(&text[..model_at]), 28 + 2);
    assert!(text.ends_with("$0.00   1s"));
}

#[test]
fn short_session_names_pad_to_the_name_column() {
    let (mode, index) = mode_with_row("short name", "mock-1");
    let layout = build_layout(&mode.rows, 120);
    assert_eq!(layout.name_width, 28);
    let line = mode.render_row(&mode.rows[index], &layout, 120, false);
    let text = flat(&line);
    let name_cell = format!("short name{}", " ".repeat(28 - 2 - 10));
    assert_eq!(text, expected_row(&name_cell, &layout));
}

#[test]
fn a_shell_overlay_consumes_hidden_row_clicks_and_scrolls_its_output() {
    let _guard = crate::mouse_tracking::STATE_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let (mut mode, index) = mode_with_row("hidden session", "mock-1");
    let mut bindings = crate::keybindings::KeybindingsConfig::new();
    bindings.insert("tui.select.up".to_string(), vec!["alt+k".to_string()]);
    bindings.insert("tui.select.down".to_string(), vec!["alt+j".to_string()]);
    mode.keybindings = crate::keybindings::KeybindingsManager::with_user_bindings(bindings);
    mode.render_frame(100, 24);
    let (hidden_row, _) = mode
        .click_rows
        .iter()
        .find(|(_, row_index)| *row_index == index)
        .copied()
        .expect("session row");
    mode.apply_persistent_shells(serde_json::json!({ "activities": [{
        "id": "shell-a", "command": "watch build", "status": "running", "persistent": true
    }]}));
    let row = mode
        .rows
        .iter()
        .find(|row| row.kind == RowKind::PersistentShell)
        .cloned()
        .expect("shell row");
    mode.open_persistent_shell(&row);
    let crate::bash_view::BashViewAction::OpenDetail { generation, .. } =
        mode.pending_shell_action.take().expect("tail action")
    else {
        panic!("open detail")
    };
    let output = (0..50)
        .map(|n| format!("output line {n}"))
        .collect::<Vec<_>>()
        .join("\n");
    mode.shell_view
        .as_mut()
        .unwrap()
        .set_output("shell-a", &output, generation);
    let before = mode.render_frame(100, 24);
    let selected = mode.selected;
    mode.handle_mouse(&mouse_report(hidden_row, true, false));
    mode.handle_mouse(&mouse_report(hidden_row, false, false));
    assert_eq!(mode.selected, selected);
    assert!(mode.running && mode.opened.is_none() && mode.shell_view.is_some());
    let wheel = crate::mouse::parse_sgr_mouse_event("\x1b[<64;3;3M").unwrap();
    mode.handle_mouse(&wheel);
    let after = mode.render_frame(100, 24);
    assert_ne!(before, after, "the wheel scrolls the overlay's output");
    assert_eq!(mode.selected, selected);
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}

#[test]
fn unverified_persistent_group_stays_visible_without_an_unsafe_cancel() {
    let (mut mode, _) = mode_with_row("holder", "mock-1");
    mode.apply_persistent_shells(serde_json::json!({ "activities": [{
        "id": "orphan", "command": "sleep 60", "sessionId": "deleted",
        "status": "unverified", "durationMs": 4_000, "persistent": true,
    }]}));
    let row = mode.persistent_shell_rows(&[]).remove(0);
    assert_eq!(
        AgentsViewMode::persistent_shell_text(&row, 100),
        "$ sleep 60 \u{b7} 4.0s"
    );
    mode.open_persistent_shell(&row);
    mode.pending_shell_action.take();
    mode.handle_shell_view_key("enter");
    assert!(mode.pending_shell_action.is_none());
}

#[test]
fn persistent_shells_head_the_list_above_every_section() {
    let mut mode = fresh_mode(vec![
        roster_entry("r", "running", &parent_summary("r")),
        roster_entry("i", "idle", &parent_summary("i")),
    ]);
    mode.apply_saved_loaded(vec![
        saved_catalog_row("/x/old-a.jsonl", "old-a", "old session a"),
        saved_catalog_row("/x/old-b.jsonl", "old-b", "old session b"),
    ]);
    mode.rebuild_rows();
    mode.selected = mode
        .rows
        .iter()
        .position(|row| row.summary.get("sessionId").and_then(Value::as_str) == Some("i"))
        .expect("idle row");
    mode.sync_selected_row_state();
    mode.apply_persistent_shells(serde_json::json!({ "activities": [
        { "id": "s1", "command": "cargo watch", "sessionId": "i", "status": "running" },
        { "id": "s2", "command": "sleep 600", "sessionId": "gone", "status": "running" },
    ]}));

    assert_eq!(
        mode.rows[mode.selected].summary["sessionId"], "i",
        "the late shells keep the selection on its session"
    );
    let (lines, _) = mode.render_frame(100, 40);
    let texts: Vec<String> = lines.iter().map(flat).collect();
    let position = |needle: &str| {
        texts
            .iter()
            .position(|text| text.contains(needle))
            .unwrap_or_else(|| panic!("{needle:?} in:\n{}", texts.join("\n")))
    };
    let shells = position("Persistent shells (2)");
    assert!(
        texts[shells + 1].contains("$ cargo watch") && texts[shells + 2].contains("$ sleep 600"),
        "the shell rows sit under their heading:\n{}",
        texts.join("\n")
    );
    assert_eq!(texts[shells + 3].trim(), "");
    assert_eq!(position("Running (1)"), shells + 4);
    assert!(position("Running (1)") < position("Idle (1)"));
    assert!(position("Idle (1)") < position("Inactive (2)"));
    assert!(
        mode.click_rows.windows(2).all(|pair| pair[0].1 < pair[1].1),
        "the row order is the display order"
    );
}
