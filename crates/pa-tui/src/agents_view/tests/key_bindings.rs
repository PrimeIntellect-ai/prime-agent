//! The key wiring: user overrides over the inert defaults, the page keys,
//! the double ctrl+c exit, and the kitty releases.

use super::*;

use super::super::rename::RenameTarget;

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
    assert_eq!(
        mode.opened.as_ref().map(|opened| &opened.selection),
        Some(&SessionSelection::New)
    );
    let mut mode =
        mode_with_user_bindings(&[("app.agents.expand", "alt+x"), ("app.agents.new", "alt+n")]);
    mode.handle_key("ctrl+n");
    assert!(mode.running, "the default new key is inert");
    assert!(mode.opened.is_none());
}

/// The scoped view's ctrl+n creates the new session under the scope
/// root (the operator's 2026-09-28 directive): one level below it and
/// in its directory, so it lists in this view and the agents-back
/// return lands here.
#[test]
fn new_key_in_a_scoped_view_creates_under_the_scope_root() {
    let mut parent = parent_summary("p");
    parent["cwd"] = serde_json::json!("/work/p");
    let mut mode = scoped_mode(
        None,
        vec![
            roster_entry("p", "idle", &parent),
            roster_entry("c", "running", &child_summary("c", "p", "worker one")),
        ],
    );
    assert!(mode.scope_active);
    mode.handle_key("ctrl+n");
    assert!(!mode.running);
    assert_eq!(
        mode.opened,
        Some(OpenedRow {
            selection: SessionSelection::NewChild {
                parent_session_file: "/x/p.jsonl".into(),
                rlm_depth: 1,
            },
            expanded_ancestors: vec![],
            selected_row_identity: String::new(),
            selected_key: SelectionKey::default(),
            rlm_depth: Some(1),
            has_children: false,
            status_message: None,
            cwd: Some("/work/p".into()),
        })
    );
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
        mode.status_text(),
        Some("No program recorded for these subagents")
    );
}

/// TS `enterRenameMode`/`confirmRename` (the `app.agents.rename` key,
/// default ctrl+r): the composer owns the prompt and the key routing —
/// the header and the save/cancel hint render, the prefill is the
/// session's name, the editing grammar matches the search field, Enter
/// submits the trimmed name with the live target, a large paste saves
/// expanded, Esc exits with the query untouched, and a child row enters
/// with its own live target.
#[test]
fn rename_key_composes_edits_and_dispatches() {
    let mut mode = mode_with_parent_and_child();
    mode.handle_key("ctrl+r");
    let Composer::Rename(rename) = &mode.composer else {
        panic!("the composer entered rename mode");
    };
    assert_eq!(
        rename.editor.get_text(),
        "p name",
        "the prefill is the session name"
    );
    // The rendered frame: the real editor box (TS SF1 closes: the
    // warning header rides INSIDE the box, top and bottom bg rows
    // included); the hint: save/cancel.
    let (frame, _) = mode.render_frame(120, 20);
    let rendered: Vec<String> = frame.iter().map(flat).collect();
    let header_row = rendered
        .iter()
        .position(|row| row.starts_with("  Rename agent session"))
        .expect("the rename header rendered with TS's two-space indent");
    assert!(
        rendered[header_row - 1].trim().is_empty(),
        "the box's top bg row rides above the header"
    );
    assert!(
        rendered.iter().any(|row| row.contains("p name")),
        "the prefilled draft renders in the box:\n{}",
        rendered.join("\n")
    );
    assert_eq!(
        flat(&mode.render_hints(120, None)),
        "Enter save   Esc/Ctrl+C cancel"
    );
    // The editing grammar (the editor's own, TS's `editor.handleInput`):
    // ctrl+u clears to the dim placeholder, the typed characters land,
    // Enter submits the trimmed name with the live target.
    mode.handle_key("ctrl+u");
    let (frame, _) = mode.render_frame(120, 20);
    assert!(
        frame
            .iter()
            .map(flat)
            .any(|row| row.contains("Name this agent session")),
        "the cleared editor shows the placeholder"
    );
    mode.handle_key("n");
    mode.handle_key("e");
    mode.handle_key("w");
    mode.handle_key("enter");
    let rename = mode.pending_rename.take();
    assert_eq!(
        rename.as_ref(),
        Some(&Rename {
            target: RenameTarget::Live {
                active_session_id: "p-live".to_string()
            },
            name: "new".to_string(),
        }),
        "the confirmed rename dispatches"
    );
    assert_eq!(mode.status_text(), Some("Renaming agent..."));
    // The landed outcome reports TS's row (the dispatched request itself).
    mode.rename_result(rename.expect("the dispatched rename"), Ok(()));
    assert_eq!(mode.status_text(), Some("Renamed to new"));
    // Esc exits back to search; the query stays untouched. Ctrl+C
    // cancels too (TS :1120 — the default cancel binding includes it;
    // the force-quit guard's handled note rides the routing).
    mode.handle_key("ctrl+r");
    mode.handle_key("escape");
    assert!(matches!(mode.composer, Composer::Search));
    mode.handle_key("ctrl+r");
    mode.handle_key("ctrl+c");
    assert!(
        matches!(mode.composer, Composer::Search),
        "ctrl+c cancels rename mode (TS :1120)"
    );
    // A large paste shows as a marker; the save expands it (TS
    // `submitValue`).
    mode.handle_key("ctrl+r");
    mode.handle_key("ctrl+u");
    let pasted = "x".repeat(1200);
    mode.handle_paste(&pasted);
    mode.handle_key("enter");
    assert_eq!(
        mode.pending_rename.take().map(|rename| rename.name),
        Some(pasted)
    );
    // A subagent row enters rename mode too (TS #2529: agent and
    // subagent rows both carry a renameable session). Expand the list
    // so the child row is the selection's landing.
    mode.handle_key("down");
    mode.handle_key("enter");
    mode.handle_key("down");
    assert_eq!(mode.rows[mode.selected].kind, RowKind::Subagent);
    mode.handle_key("ctrl+r");
    let Composer::Rename(rename) = &mode.composer else {
        panic!("the subagent row entered rename mode")
    };
    assert_eq!(
        rename.target,
        RenameTarget::Live {
            active_session_id: "c-live".to_string()
        },
        "the child's live session is the rename target"
    );
    assert_eq!(rename.editor.get_text(), "worker one");
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
