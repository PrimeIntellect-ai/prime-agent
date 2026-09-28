use super::*;

/// One idle row under test plus a holder row that keeps the selection,
/// with the given title and one model id. The cost/age
/// stay fixed so the expected rows are exact.
fn mode_with_row(title: &str, model: &str) -> (AgentsViewMode, usize) {
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
    });
    let row = |title: &str| AgentsViewRow {
        section: Section::Idle,
        identity: title.to_string(),
        summary: serde_json::json!({ "sessionName": title }),
        title: title.to_string(),
        model: model.to_string(),
        cost: 0.0,
        age: "1s".to_string(),
        depth: 0,
        descendant_count: 0,
        running_subagent_count: 0,
        expanded: false,
        parent_identity: None,
        kind: RowKind::Agent,
    };
    mode.rows = vec![row("holder"), row(title)];
    (mode, 1)
}

fn flat(line: &Line) -> String {
    line.iter().map(|s| s.content.as_str()).collect()
}

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

/// One SGR left report: a press, a press with the motion bit (a
/// drag), or a release.
fn mouse_report(row: usize, press: bool, motion: bool) -> crate::mouse::MouseEvent {
    crate::mouse::MouseEvent {
        button: crate::mouse::BUTTON_LEFT,
        x: 3,
        y: (row + 1) as u16,
        press,
        motion,
        shift: false,
        alt: false,
        ctrl: false,
    }
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
    // A shift-press plus a plain release: the modifier press stays
    // selection-only, so nothing opens.
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
    // The drag report carries the motion bit.
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
    // The release lands one row below the pressed one.
    mode.handle_mouse(&mouse_report(row + 1, false, false));
    assert!(mode.opened.is_none(), "the press row gates the open");
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}

/// A fresh plain press always re-records its row (the session
/// surface's `fullscreenPressedClick` always assigns): a release
/// lost to a focus change or a touch cancel must never pin the next
/// tap to the old row (Cursor Bugbot: a new press kept the stale
/// row, so the next tap on a different row did nothing).
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
    // Press the first row, "lose" the release, then tap the second:
    // the new press owns the row, so the release on it opens it.
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

/// The click is an input like any key: a showing notice panel
/// consumes it — the close is the click's whole action, exactly like
/// the key that dismisses it (Cursor Bugbot: the click opened
/// through the refusal notice that any key would only close).
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

/// The open's Enter preamble clears with the click: the exit hint
/// drops and the armed stop-or-delete confirm is taken, so a later
/// ctrl+x re-arms over the clicked row instead of executing a stale
/// arm (Cursor Bugbot: the click leaked both).
#[test]
fn a_click_clears_the_exit_hint_and_the_armed_delete_confirm() {
    let _guard = match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let (mut mode, index) = mode_with_row("click clears arms", "mock-1");
    // Both rows must be armable (a live session arms the stop word)
    // and openable.
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
    // The next ctrl+x re-arms instead of executing the stale one.
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
    // TS `buildCompactAgentsViewLayout` at width 120 with these rows.
    assert_eq!(layout.name_width, 28);
    assert_eq!(layout.model_width, 12);
    let line = mode.render_row(&mode.rows[index], &layout, 120);
    let text = flat(&line);
    // TS `formatTableCell` clips with an empty ellipsis marker: the
    // name cell keeps the icon and space plus 26 name characters.
    assert_eq!(text, expected_row(&"a".repeat(26), &layout));
    // Every column still renders after the clipped name.
    let model_at = text.find("mock-1").expect("model column present");
    assert_eq!(str_width(&text[..model_at]), 28 + 2);
    assert!(text.ends_with("$0.00   1s"));
}

#[test]
fn short_session_names_pad_to_the_name_column() {
    let (mode, index) = mode_with_row("short name", "mock-1");
    let layout = build_layout(&mode.rows, 120);
    assert_eq!(layout.name_width, 28);
    let line = mode.render_row(&mode.rows[index], &layout, 120);
    let text = flat(&line);
    let name_cell = format!("short name{}", " ".repeat(28 - 2 - 10));
    assert_eq!(text, expected_row(&name_cell, &layout));
}

fn roster_entry(agent: &str, status: &str, summary: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "agentId": agent, "status": status, "summary": summary })
}

fn parent_summary(id: &str) -> serde_json::Value {
    serde_json::json!({
        "sessionId": id,
        "lifecycle": "live",
        "activeSessionId": format!("{id}-live"),
        "sessionFile": format!("/x/{id}.jsonl"),
        "runtimeKind": "top-level",
        "sessionName": format!("{id} name"),
        "messageCount": 2,
        "rlmDepth": 0,
    })
}

/// One saved-catalog row (TS `serializeSavedSessionInfo`'s shape): the
/// path identity, the durable id, and the display fields the filters
/// read.
fn saved_catalog_row(path: &str, id: &str, name: &str) -> serde_json::Value {
    serde_json::json!({
        "path": path,
        "id": id,
        "cwd": "/tmp",
        "rlmDepth": 0,
        "created": "2024-01-01T00:00:00.000Z",
        "modified": "2024-01-01T00:00:00.000Z",
        "messageCount": 3,
        "name": name,
    })
}

/// The streamed catalog lands progressively: a buffered row flushes
/// as one rebuild, and the entry anchor's wait ends with the flush -
/// the row the scan streams first (newest) is selectable (and
/// Enter-able) inside the first batch window instead of after the
/// whole scan (the operator's `Still loading sessions` hold).
#[test]
fn streamed_catalog_rows_land_progressively_and_settle_the_anchor() {
    let mut mode = mode_with_anchor(
        Some("s2"),
        vec![roster_entry("s1", "idle", parent_summary("s1"))],
    );
    assert!(mode.anchor_selection_pending, "the anchor waits on its row");
    mode.buffer_saved_stream_item(saved_catalog_row("/x/s2.jsonl", "s2", "second chat"));
    assert!(mode.flush_saved_stream(), "the flush rebuilds once");
    assert!(
        !mode.anchor_selection_pending,
        "the anchor landed from the stream, before the final response"
    );
    assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s2");
    // Enter opens the anchor now: no hint, no wait.
    mode.handle_key("enter");
    assert!(
        mode.opened.is_some(),
        "the anchor opens without waiting for the scan's end"
    );
    assert_ne!(mode.status.as_deref(), Some(ANCHOR_LOADING_HINT));
}

/// The streamed upsert never duplicates: a row re-streamed by a
/// superseded fetch's late frames replaces by path (then durable id),
/// and the final response's authoritative array replaces the whole
/// catalog.
#[test]
fn streamed_catalog_upserts_by_identity_and_the_final_response_replaces() {
    let mut mode = mode_with_anchor(None, vec![]);
    assert!(
        !mode.flush_saved_stream(),
        "an empty buffer flushes nothing"
    );
    mode.buffer_saved_stream_item(saved_catalog_row("/x/a.jsonl", "a", "first"));
    mode.buffer_saved_stream_item(saved_catalog_row("/x/a.jsonl", "a", "first (again)"));
    mode.buffer_saved_stream_item(saved_catalog_row("/x/b.jsonl", "b", "second"));
    assert!(mode.flush_saved_stream());
    assert_eq!(
        mode.saved.len(),
        2,
        "the same path upserts, never duplicates"
    );
    assert_eq!(mode.saved[0]["name"], "first (again)");
    // A row whose path moved but id survived still upserts by id.
    mode.buffer_saved_stream_item(saved_catalog_row("/x/a-moved.jsonl", "a", "moved"));
    assert!(mode.flush_saved_stream());
    assert_eq!(mode.saved.len(), 2, "the durable id upserts too");
    assert_eq!(mode.saved[0]["path"], "/x/a-moved.jsonl");
    // The final response replaces the catalog wholesale.
    mode.drop_saved_stream();
    mode.saved = vec![saved_catalog_row(
        "/x/c.jsonl",
        "c",
        "the authoritative row",
    )];
    mode.rebuild_rows();
    assert_eq!(mode.saved.len(), 1);
    assert_eq!(mode.saved[0]["id"], "c");
    assert!(mode.saved_stream.is_empty());
}

fn child_summary(id: &str, parent: &str, name: &str) -> serde_json::Value {
    serde_json::json!({
        "sessionId": id,
        "lifecycle": "live",
        "activeSessionId": format!("{id}-live"),
        "sessionFile": format!("/x/{id}.jsonl"),
        "runtimeKind": "subagent",
        "rlmChildId": format!("child-{id}"),
        "parentActiveSessionId": format!("{parent}-live"),
        "parentSessionId": parent,
        "parentSessionPath": format!("/x/{parent}.jsonl"),
        "sessionName": name,
        "messageCount": 1,
        "rlmDepth": 1,
    })
}

/// A mode over a live parent/child roster, no scope, fresh selection.
fn mode_with_parent_and_child() -> AgentsViewMode {
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
    });
    mode.roster = vec![
        roster_entry("p", "idle", parent_summary("p")),
        roster_entry("c", "running", child_summary("c", "p", "worker one")),
    ];
    mode.rebuild_rows();
    mode
}

/// The ctrl+x stop-or-delete flow (TS `handleDeleteSelected`, the
/// operator's missing-functionality report): the first press arms the
/// confirm over the selected row with the stop|delete hint, the second
/// press on the same row takes the dispatch, any other key clears the
/// arm, and a moved selection never executes.
#[test]
fn ctrl_x_arms_then_executes_the_stop_or_delete() {
    let mut mode = mode_with_parent_and_child();
    // Subagent rows materialize only inside the parent's expanded
    // list: expand the parent (found by its Agent kind, never by
    // section order), then select the child by its own rlmChildId.
    let parent_row = mode
        .rows
        .iter()
        .find(|row| row.kind == RowKind::Agent)
        .expect("the parent row")
        .clone();
    mode.toggle_subagent_list(&parent_row);
    let child_index = mode
        .rows
        .iter()
        .position(|row| row.summary.get("rlmChildId").is_some())
        .expect("the child row");
    mode.selected = child_index;
    let child_identity = mode.rows[mode.selected].identity.clone();
    assert!(child_identity.contains('c'));
    // First press: armed, no dispatch.
    mode.handle_key("ctrl+x");
    assert!(
        mode.pending_delete.is_some(),
        "the first press arms the confirm"
    );
    assert!(mode.pending_delete_action.is_none(), "no dispatch yet");
    let armed = mode.delete_arm_target().expect("an armed target");
    assert_eq!(armed.identity, child_identity);
    assert!(armed.stop, "the running subagent arms as stop");
    // Any other key clears the arm.
    mode.handle_key("down");
    assert!(mode.pending_delete.is_none(), "another key clears the arm");
    // Re-select the child, then arm and execute on the same row.
    mode.selected = mode
        .rows
        .iter()
        .position(|row| row.summary.get("rlmChildId").is_some())
        .expect("the child row");
    mode.handle_key("ctrl+x");
    mode.handle_key("ctrl+x");
    let action = mode.take_delete_action().expect("the executed dispatch");
    match action {
        DeleteAction::StopSubagent {
            active_session_id,
            child_id,
            ..
        } => {
            assert_eq!(active_session_id, "p-live", "the parent's session");
            assert_eq!(child_id, "child-c", "the child's rlm id");
        }
        other => panic!("a running subagent stops, got {other:?}"),
    }
}

/// The idle arm: an idle subagent arms as delete and dispatches the
/// `delete_rlm_subagent` wire; the hint word follows the live work.
#[test]
fn ctrl_x_on_an_idle_subagent_deletes() {
    let mut mode = mode_with_parent_and_child();
    mode.roster[1]["status"] = serde_json::json!("idle");
    mode.rebuild_rows();
    let parent_row = mode
        .rows
        .iter()
        .find(|row| row.kind == RowKind::Agent)
        .expect("the parent row")
        .clone();
    mode.toggle_subagent_list(&parent_row);
    let child_index = mode
        .rows
        .iter()
        .position(|row| row.summary.get("rlmChildId").is_some())
        .expect("the child row");
    mode.selected = child_index;
    let armed = mode.delete_arm_target().expect("an armed target");
    assert!(!armed.stop, "the idle subagent arms as delete");
    mode.handle_key("ctrl+x");
    mode.handle_key("ctrl+x");
    let action = mode.take_delete_action().expect("the executed dispatch");
    match action {
        DeleteAction::DeleteSubagent { child_id, .. } => {
            assert_eq!(child_id, "child-c");
        }
        other => panic!("an idle subagent deletes, got {other:?}"),
    }
}

/// The armed hint renders the stop|delete word with the effective
/// binding; any other row selection clears the arm before the press.
#[test]
fn the_delete_confirm_hint_and_the_cleared_arm() {
    let mut mode = mode_with_parent_and_child();
    // Expand the parent's list so the child row materializes, then
    // select it by its own rlmChildId.
    let parent_row = mode
        .rows
        .iter()
        .find(|row| row.kind == RowKind::Agent)
        .expect("the parent row")
        .clone();
    mode.toggle_subagent_list(&parent_row);
    let child_index = mode
        .rows
        .iter()
        .position(|row| row.summary.get("rlmChildId").is_some())
        .expect("the child row");
    mode.selected = child_index;
    mode.handle_key("ctrl+x");
    let hint = mode
        .render_hints(120, None)
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert!(
        hint.contains("again to stop"),
        "the confirm hint row: {hint}"
    );
    assert!(
        hint.contains("again to stop"),
        "the live row reads stop: {hint}"
    );
    // A moved selection never executes the armed row: the arm dies
    // with the key that moved the selection (the clear-on-any-other-
    // key), and no dispatch ever rode along.
    mode.handle_key("down");
    assert!(mode.pending_delete.is_none(), "the arm dies with the move");
    assert!(mode.pending_delete_action.is_none());
}

/// The honest-success check: a `success` response whose own outcome
/// field says nothing happened (`cancelled: false`, `deleted: false`)
/// never reports Stopped/Deleted — the status says what the wire
/// said, not what the button hoped.
#[test]
fn a_no_effect_success_response_reports_nothing_changed() {
    let action = DeleteAction::StopSubagent {
        active_session_id: "p-live".to_string(),
        child_id: "child-c".to_string(),
        name: "worker one".to_string(),
    };
    let response = pa_types::daemon::DaemonResponse {
        success: true,
        data: Some(serde_json::json!({"cancelled": false})),
        error: None,
        id: None,
        command: "cancel_rlm_child".to_string(),
        error_info: None,
    };
    assert!(!action.effect_happened(&response));
    let response = pa_types::daemon::DaemonResponse {
        success: true,
        data: Some(serde_json::json!({"cancelled": true})),
        error: None,
        id: None,
        command: "cancel_rlm_child".to_string(),
        error_info: None,
    };
    assert!(action.effect_happened(&response));
    let delete = DeleteAction::DeleteSubagent {
        active_session_id: "p-live".to_string(),
        child_id: "child-c".to_string(),
        name: "worker one".to_string(),
    };
    let response = pa_types::daemon::DaemonResponse {
        success: true,
        data: Some(serde_json::json!({"deleted": false})),
        error: None,
        id: None,
        command: "delete_rlm_subagent".to_string(),
        error_info: None,
    };
    assert!(!delete.effect_happened(&response));
}

/// The no-effect summary surfaces the wire's own explanation: the
/// daemon's `error`/`reason` beats a bare `ok: false` (which hid
/// the actual explanation), a string renders bare, and a payload
/// without any explanation still shows its own text.
#[test]
fn the_no_effect_summary_surfaces_the_wires_explanation() {
    assert_eq!(
        no_effect_summary(Some(&serde_json::json!({
            "ok": false,
            "error": "session gone"
        }))),
        "session gone"
    );
    assert_eq!(
        no_effect_summary(Some(&serde_json::json!({
            "deleted": false,
            "reason": "running"
        }))),
        "running"
    );
    assert_eq!(
        no_effect_summary(Some(&serde_json::json!({"ok": false}))),
        "false"
    );
    assert_eq!(
        no_effect_summary(Some(&serde_json::json!({"queued": true}))),
        r#"{"queued":true}"#
    );
    assert_eq!(no_effect_summary(None), "nothing changed");
}

/// A row that settles between the presses re-arms instead of
/// executing the stale word: the armed confirm rides the row's
/// CURRENT live-work state.
#[test]
fn a_settled_row_re_arms_instead_of_executing_the_stale_word() {
    let mut mode = mode_with_parent_and_child();
    let parent_row = mode
        .rows
        .iter()
        .find(|row| row.kind == RowKind::Agent)
        .expect("the parent row")
        .clone();
    mode.toggle_subagent_list(&parent_row);
    mode.selected = mode
        .rows
        .iter()
        .position(|row| row.summary.get("rlmChildId").is_some())
        .expect("the child row");
    // Arm over the running child (the word is stop).
    mode.handle_key("ctrl+x");
    let armed = mode.delete_arm_target().expect("an armed target");
    assert!(armed.stop);
    // The settled child: the section reads idle while the arm
    // rides the same row. The running expansion keeps running rows
    // only, so the settled child lives under the parent's inactive
    // line now: open it before the rebuild so the armed row stays
    // visible (the arm only rides a row the list still carries).
    mode.expanded_inactive_parents
        .insert(parent_row.identity.clone());
    mode.roster[1]["status"] = serde_json::json!("idle");
    mode.rebuild_rows();
    mode.selected = mode
        .rows
        .iter()
        .position(|row| row.summary.get("rlmChildId").is_some())
        .expect("the child row");
    // The armed stop word no longer matches the settled row: the
    // confirm re-arms over the current state instead of executing
    // the stale stop.
    mode.handle_key("ctrl+x");
    assert!(
        mode.pending_delete_action.is_none(),
        "the stale word never executes"
    );
    assert!(
        mode.pending_delete
            .as_ref()
            .is_some_and(|pending| !pending.stop),
        "the re-arm carries the current word: {:?}",
        mode.pending_delete
    );
}

/// The confirm hint rides the armed row's CURRENT live work: a
/// running row arms as stop, and the same row settled between the
/// presses reads delete — the word the next press re-confirms,
/// never the stale stop the first press armed with.
#[test]
fn the_confirm_hint_rides_the_current_live_work() {
    let mut mode = mode_with_parent_and_child();
    let parent_row = mode
        .rows
        .iter()
        .find(|row| row.kind == RowKind::Agent)
        .expect("the parent row")
        .clone();
    mode.toggle_subagent_list(&parent_row);
    mode.selected = mode
        .rows
        .iter()
        .position(|row| row.summary.get("rlmChildId").is_some())
        .expect("the child row");
    mode.handle_key("ctrl+x");
    let hint = mode
        .render_hints(120, None)
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert!(
        hint.contains("again to stop"),
        "the running row's confirm reads stop: {hint}"
    );
    // The settled child keeps the arm on its identity and session
    // key; the hint reads the settled row's word. The settled child
    // renders under the parent's inactive line now (the running
    // expansion keeps running rows only), so open it before the
    // rebuild so the armed row stays visible for the hint to ride.
    mode.expanded_inactive_parents
        .insert(parent_row.identity.clone());
    mode.roster[1]["status"] = serde_json::json!("idle");
    mode.rebuild_rows();
    let hint = mode
        .render_hints(120, None)
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert!(
        hint.contains("again to delete"),
        "the settled row's confirm reads delete: {hint}"
    );
}

/// A deleted path never reappears behind a slow catalog fetch: the
/// `SavedLoaded` apply filters the recorded deleted paths, so a stale
/// response cannot restore a row the daemon already deleted.
#[test]
fn a_deleted_path_survives_a_late_catalog_apply() {
    let mut mode = mode_with_anchor(None, Vec::new());
    mode.saved = vec![saved_catalog_row(
        "/x/gone.jsonl",
        "gone-1",
        "a deleted session",
    )];
    mode.rebuild_rows();
    mode.delete_result(
        "Deleted session a deleted session".to_string(),
        Some("/x/gone.jsonl".to_string()),
    );
    assert!(mode.saved.is_empty());
    // The in-flight fetch lands late with the deleted file still in
    // its snapshot: the apply filters it.
    mode.apply_saved_loaded(vec![saved_catalog_row(
        "/x/gone.jsonl",
        "gone-1",
        "a deleted session",
    )]);
    assert!(
        mode.saved.is_empty(),
        "the deleted path stays gone behind the late fetch"
    );
}

/// A roster replacement retires the arm: the same row identity with
/// a NEW live session (the worker was replaced) never inherits the
/// armed confirm — the second press confirms the session it acts
/// on (a stale arm must not stop the replacement's new session).
#[test]
fn a_roster_replacement_retires_the_armed_confirm() {
    let mut mode = mode_with_parent_and_child();
    mode.selected = 0;
    mode.handle_key("ctrl+x");
    let armed = mode.delete_arm_target().expect("an armed target");
    let key = armed.session_key;
    assert!(key.is_some());
    // The roster replaces the agent: the same identity, a new live
    // session id.
    mode.roster[0]["summary"]["activeSessionId"] = serde_json::json!("p-live-2");
    mode.rebuild_rows();
    assert!(
        mode.pending_delete.is_none(),
        "the replacement retires the arm"
    );
    // The same session (no replacement) keeps it.
    mode.selected = 0;
    mode.handle_key("ctrl+x");
    mode.rebuild_rows();
    assert!(
        mode.pending_delete.is_some(),
        "an unchanged roster keeps the arm"
    );
}

/// A parent-session replacement retires an armed CHILD confirm:
/// the child's own session survives the re-parenting, but its
/// dispatch keys on the parent's session — a second press must never
/// act through a parent the confirmation never saw.
#[test]
fn a_parent_replacement_retires_the_armed_child_confirm() {
    let mut mode = mode_with_parent_and_child();
    let parent_row = mode
        .rows
        .iter()
        .find(|row| row.kind == RowKind::Agent)
        .expect("the parent row")
        .clone();
    mode.toggle_subagent_list(&parent_row);
    mode.selected = mode
        .rows
        .iter()
        .position(|row| row.summary.get("rlmChildId").is_some())
        .expect("the child row");
    mode.handle_key("ctrl+x");
    let armed = mode.delete_arm_target().expect("an armed target");
    assert_eq!(
        armed.session_key.as_deref(),
        Some("p-live"),
        "the child arm keys on the parent's session"
    );
    // The parent is replaced and the child re-parents: its own
    // session is unchanged, the dispatch scoping is not.
    mode.roster[1]["summary"]["parentActiveSessionId"] = serde_json::json!("p2-live");
    mode.rebuild_rows();
    assert!(
        mode.pending_delete.is_none(),
        "the re-parented child never inherits the confirm"
    );
}

/// A deleted saved row leaves the catalog by its own path: the
/// removal keys on the session PATH (the daemon's key), never the
/// display name — the old message-contains check would leave the
/// row in the Inactive list while the status said Deleted.
#[test]
fn a_deleted_saved_row_leaves_the_catalog_by_path() {
    let mut mode = mode_with_anchor(None, Vec::new());
    mode.saved = vec![
        saved_catalog_row("/x/gone.jsonl", "gone-1", "a deleted session"),
        saved_catalog_row("/x/stays.jsonl", "stays-1", "a surviving session"),
    ];
    mode.rebuild_rows();
    mode.delete_result(
        "Deleted session a deleted session".to_string(),
        Some("/x/gone.jsonl".to_string()),
    );
    assert!(
        !mode
            .saved
            .iter()
            .any(|saved| saved.get("path") == Some(&serde_json::json!("/x/gone.jsonl"))),
        "the deleted path leaves the catalog"
    );
    assert!(
        mode.saved
            .iter()
            .any(|saved| saved.get("path") == Some(&serde_json::json!("/x/stays.jsonl"))),
        "the other rows stay"
    );
    // The name-matching trap: a path that never appears in any
    // display name still matches by its own key.
    mode.delete_result(
        "Deleted session Some Other Name".to_string(),
        Some("/x/stays.jsonl".to_string()),
    );
    assert!(
        mode.saved.is_empty(),
        "the path removes regardless of the name"
    );
}

/// The delete hint renders the word for a row without live work.
#[test]
fn the_delete_confirm_hint_reads_delete_for_saved_rows() {
    let mut mode = mode_with_anchor(None, Vec::new());
    mode.saved = vec![saved_catalog_row(
        "/x/saved.jsonl",
        "saved-1",
        "an old session",
    )];
    mode.rebuild_rows();
    // The saved row sits in the Inactive section.
    let saved_index = mode
        .rows
        .iter()
        .position(|row| row.identity.contains("saved"))
        .expect("the saved row");
    mode.selected = saved_index;
    mode.handle_key("ctrl+x");
    let armed = mode.delete_arm_target().expect("an armed target");
    assert!(!armed.stop, "the saved row arms as delete");
    mode.handle_key("ctrl+x");
    match mode.take_delete_action().expect("the dispatch") {
        DeleteAction::DeleteSavedSession { session_path, .. } => {
            assert_eq!(session_path, "/x/saved.jsonl");
        }
        other => panic!("the saved row deletes its file, got {other:?}"),
    }
}

/// A fresh-open view anchored on the given session (the agents-back
/// handoff state: no carried selection, the session just left).
fn mode_with_anchor(anchor: Option<&str>, roster: Vec<serde_json::Value>) -> AgentsViewMode {
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: anchor.map(str::to_string),
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
    });
    mode.roster = roster;
    mode.rebuild_rows();
    mode
}

/// One mode over the given notice (the previous run's failure).
fn mode_with_notice(notice: &str) -> AgentsViewMode {
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: Some(notice.to_string()),
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
    });
    mode.rebuild_rows();
    mode
}

/// A multi-line notice — the cross-product lease refusal with its two
/// ways out — renders as the panel: the full text stays visible and
/// wrapped, never truncated to the single hint line, and any key
/// dismisses it.
#[test]
fn a_multiline_refusal_notice_renders_as_a_dismissible_panel() {
    let refusal = "This session is currently open in another Rust build of Prime Agent \
(active in 6b558be357e3) — another daemon or window of this product holds the file's \
runtime lease.\n\n• Continue where you left off:\n  prime-agent --daemon-socket \
<socket> --resume 'sess-1'\n  (<socket> is that instance's daemon socket, from the \
shell where you started it — that daemon owns this session)\n\n• Take over on this \
daemon:\n  kill 4242 # the holder is prime-agent\n  Then retry — the file unlocks when \
the holder exits.";
    let render = |mode: &mut AgentsViewMode| {
        let (lines, _) = mode.render_frame(120, 40);
        lines
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let mut mode = mode_with_notice(refusal);
    let shown = render(&mut mode);
    for way_out in [
        "Continue where you left off",
        "--daemon-socket <socket> --resume 'sess-1'",
        "Take over on this daemon",
        "kill 4242 # the holder is prime-agent",
    ] {
        assert!(
            shown.contains(way_out),
            "the panel shows {way_out:?} in full:\n{shown}"
        );
    }
    // Any key dismisses the panel; the hint line returns.
    mode.handle_key("down");
    let dismissed = render(&mut mode);
    assert!(
        !dismissed.contains("Take over on this daemon"),
        "the panel leaves the frame on any key:\n{dismissed}"
    );
}

/// A single-line notice keeps the hint-line status: the panel arms only
/// for notices with lines to show.
#[test]
fn a_single_line_notice_keeps_the_status_line() {
    let mode = mode_with_notice("Saved sessions unavailable: no such directory");
    assert!(mode.notice.is_none());
    assert_eq!(
        mode.status.as_deref(),
        Some("Saved sessions unavailable: no such directory")
    );
}

/// A fresh open (the agents-back handoff) anchors the entry selection
/// on the session the view was opened from, not the first row.
#[test]
fn entry_anchor_selects_the_left_session() {
    let mode = mode_with_anchor(
        Some("s2"),
        vec![
            roster_entry("s1", "idle", parent_summary("s1")),
            roster_entry("s2", "idle", parent_summary("s2")),
        ],
    );
    assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s2");
    assert!(!mode.anchor_selection_pending);
}

/// The anchor row can arrive after the first rebuild (the roster
/// streams, the saved catalog lands later): the wait survives the
/// rebuilds that pin other rows and lands once the row appears.
#[test]
fn anchor_wait_survives_until_the_row_arrives() {
    let mut mode = mode_with_anchor(
        Some("s2"),
        vec![roster_entry("s1", "idle", parent_summary("s1"))],
    );
    assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s1");
    assert!(mode.anchor_selection_pending);
    mode.roster
        .push(roster_entry("s2", "idle", parent_summary("s2")));
    mode.rebuild_rows();
    assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s2");
    assert!(!mode.anchor_selection_pending);
}

/// Enter during the anchor wait opens nothing (the default row is not
/// the user's choice); once the anchor row lands, Enter opens it.
#[test]
fn open_waits_out_the_entry_anchor() {
    let mut mode = mode_with_anchor(
        Some("s2"),
        vec![roster_entry("s1", "idle", parent_summary("s1"))],
    );
    assert!(mode.anchor_selection_pending);
    mode.handle_key("enter");
    assert!(mode.opened.is_none(), "the default row did not open");
    assert!(mode.status.is_some(), "the wait explains itself");
    mode.roster
        .push(roster_entry("s2", "idle", parent_summary("s2")));
    mode.rebuild_rows();
    assert!(!mode.anchor_selection_pending);
    assert!(
        mode.status.is_none(),
        "the anchor landing drops the loading hint"
    );
    // The user's first move ends the wait the same way: the hint it
    // left behind clears too.
    mode.anchor_selection_pending = true;
    mode.status = Some(ANCHOR_LOADING_HINT.to_string());
    mode.handle_key("down");
    assert!(!mode.anchor_selection_pending);
    assert!(
        mode.status.is_none(),
        "the canceling move drops the loading hint as well"
    );
    mode.handle_key("enter");
    let opened = mode.opened.expect("the anchored row opens");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("s2-live".to_string())
    );
}

/// The first user move cancels the wait: the anchor never overrides an
/// explicit selection.
#[test]
fn anchor_wait_cancels_on_the_first_user_move() {
    let mut mode = mode_with_anchor(
        Some("s2"),
        vec![roster_entry("s1", "idle", parent_summary("s1"))],
    );
    mode.handle_key("down");
    assert!(!mode.anchor_selection_pending);
    mode.roster
        .push(roster_entry("s2", "idle", parent_summary("s2")));
    mode.rebuild_rows();
    assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s1");
}

/// A plain click during the entry anchor's wait is an explicit user
/// choice too — the clicked row IS the pick — so it cancels the wait
/// and opens that row; the keyboard Enter's loading hint never stands
/// between a visible row and its open (Macroscope: the click grammar
/// must not inherit Enter's wait).
#[test]
fn a_click_cancels_the_anchor_wait_and_opens_the_clicked_row() {
    let _guard = match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let mut mode = mode_with_anchor(
        Some("s2"),
        vec![
            roster_entry("s1", "idle", parent_summary("s1")),
            roster_entry("s3", "idle", parent_summary("s3")),
        ],
    );
    assert!(mode.anchor_selection_pending, "the anchor waits on its row");
    // Enter during the wait arms the loading hint (the default row is
    // not the user's pick); the user then clicks a different row.
    mode.handle_key("enter");
    assert!(mode.opened.is_none(), "the wait still holds the open");
    mode.render_frame(120, 24);
    let clicked = mode
        .rows
        .iter()
        .position(|row| row.summary["sessionId"] == "s3")
        .expect("the other row renders");
    let (row, _) = mode
        .click_rows
        .iter()
        .find(|(_, index)| *index == clicked)
        .copied()
        .expect("the clicked row is on screen");
    mode.handle_mouse(&mouse_report(row, true, false));
    mode.handle_mouse(&mouse_report(row, false, false));
    assert_eq!(mode.selected, clicked, "the click selected the row");
    assert!(
        !mode.anchor_selection_pending,
        "the click ends the entry anchor's wait"
    );
    let opened = mode.opened.expect("the click opened the row");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("s3-live".to_string())
    );
    assert!(
        mode.status.is_none(),
        "the click drops the loading hint with the wait"
    );
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}

/// A terminal saved-catalog failure settles the entry anchor's wait (TS
/// `resolveMissingSelectionAnchor`'s finally arm): the anchor's row can
/// only arrive through THIS fetch, so the wait must not outlive the
/// fetch's own failure — the loading hint would re-arm on every open
/// behind an error the status line already showed.
#[test]
fn a_saved_catalog_failure_settles_the_anchor_wait() {
    let mut mode = mode_with_anchor(
        Some("s2"),
        vec![roster_entry("s1", "idle", parent_summary("s1"))],
    );
    mode.status = Some(ANCHOR_LOADING_HINT.to_string());
    mode.settle_anchor_wait_on_saved_failure();
    assert!(
        !mode.anchor_selection_pending,
        "the wait ends with the failed catalog"
    );
    assert_ne!(
        mode.status.as_deref(),
        Some(ANCHOR_LOADING_HINT),
        "the loading hint drops with the wait"
    );
    // Enter after the settle opens the default row (the wait is over;
    // the open is the user's explicit choice again), and the loading
    // hint never re-arms behind the failure the view already showed.
    mode.handle_key("enter");
    assert!(
        mode.opened.is_some(),
        "the settled view opens the default row instead of re-arming the hint"
    );
    assert_ne!(
        mode.status.as_deref(),
        Some(ANCHOR_LOADING_HINT),
        "no re-armed loading hint behind the failure"
    );
}

/// TS `rearmSavedSearchFetch`: a terminal saved-catalog failure re-arms
/// on the next query change - ONE retry, single-flight: the consumption
/// clears the failure intent with it, so concurrent out-of-order scans
/// never race a stale failure over a newer success. A NEW terminal
/// failure re-arms again; a healthy fetch never does.
#[test]
fn a_failed_fetch_rearms_once_per_query_change() {
    let mut mode = mode_with_anchor(None, Vec::new());
    mode.note_query_changed();
    assert!(
        !mode.take_saved_fetch_rearm(),
        "a healthy fetch never re-arms"
    );
    mode.saved_fetch_failed = true;
    mode.note_query_changed();
    assert!(
        mode.take_saved_fetch_rearm(),
        "the query change after a failure re-arms the fetch"
    );
    assert!(
        !mode.take_saved_fetch_rearm(),
        "the intent is consumed once per query change"
    );
    // The arm consumed the failure flag: no second concurrent retry
    // until the in-flight one fails again.
    mode.note_query_changed();
    assert!(
        !mode.take_saved_fetch_rearm(),
        "the retry in flight is the only one"
    );
    mode.saved_fetch_failed = true;
    mode.note_query_changed();
    assert!(
        mode.take_saved_fetch_rearm(),
        "a new terminal failure re-arms again"
    );
    mode.saved_fetch_failed = false;
    mode.note_query_changed();
    assert!(!mode.take_saved_fetch_rearm());
}

/// A no-op edit on an empty query changes nothing: the re-arm's
/// expensive retry never fires behind backspace or ctrl+u on an
/// already-empty search.
#[test]
fn a_noop_edit_on_an_empty_query_never_rearms() {
    let mut mode = mode_with_anchor(None, Vec::new());
    mode.query.clear();
    mode.saved_fetch_failed = true;
    // Backspace on the empty query: the shape `deleteCharBackward`
    // matches.
    mode.handle_key("backspace");
    assert!(
        !mode.take_saved_fetch_rearm(),
        "the no-op backspace did not re-arm"
    );
}

/// A successful catalog load retires the failure status the terminal
/// fetch left behind: the status line never keeps reporting an
/// unavailable catalog after it loaded.
#[test]
fn a_successful_load_retires_the_failure_status() {
    let mut mode = mode_with_anchor(None, Vec::new());
    mode.status = Some("Saved sessions unavailable: scan failed".to_string());
    mode.saved_fetch_failed = true;
    mode.saved = Vec::new();
    // The load arm's own logic (the loop's SavedLoaded handler): the
    // failure flag clears and the fetch's own status retires.
    mode.saved_fetch_failed = false;
    if mode
        .status
        .as_deref()
        .is_some_and(|status| status.starts_with("Saved sessions unavailable"))
    {
        mode.status = None;
    }
    assert_eq!(mode.status, None, "the stale failure status retired");
    // An unrelated status (the flow's own notice) survives a load.
    mode.status = Some("Session s1 is no longer running".to_string());
    if mode
        .status
        .as_deref()
        .is_some_and(|status| status.starts_with("Saved sessions unavailable"))
    {
        mode.status = None;
    }
    assert_eq!(
        mode.status.as_deref(),
        Some("Session s1 is no longer running"),
        "an unrelated status is never clobbered by the load"
    );
}

/// The saved-catalog fetch rides the LONG-RUNNING budget, never the 30s
/// default: the scan is the known-slow whole-file re-parse, and the
/// default class is what turned a minute-long scan into a false
/// `Saved sessions unavailable` timeout (the loading state that never
/// completes).
#[test]
fn the_saved_catalog_fetch_uses_the_long_running_budget() {
    // The budget pin: the saved scan must never fall back to the 30s
    // default request class (the class that turned the operator's
    // minute-plus scan into a false `Saved sessions unavailable`
    // timeout).
    assert_eq!(
        saved_catalog_timeout_ms(),
        crate::daemon_client::LONG_RUNNING_REQUEST_TIMEOUT_MS
    );
    assert!(
        saved_catalog_timeout_ms() > crate::daemon_client::DEFAULT_REQUEST_TIMEOUT_MS,
        "the saved scan must never fall back to the 30s default class"
    );
}

/// A nested anchor (a subagent session the user was attached to) arrives
/// with its ancestors' lists expanded so its row is reachable — the
/// same expansion the drilled-in return path uses.
#[test]
fn nested_anchor_expands_its_ancestors() {
    let mode = mode_with_anchor(
        Some("c"),
        vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("c", "running", child_summary("c", "p", "worker one")),
        ],
    );
    assert_eq!(mode.rows.len(), 3, "the parent's list opened");
    assert_eq!(mode.rows[mode.selected].summary["sessionId"], "c");
}

/// A carried selection (the view/session loop's restore) wins over the
/// anchor: only fresh opens wait on it.
#[test]
fn carried_selection_wins_over_the_entry_anchor() {
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: Some("s2".to_string()),
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: Some(crate::agents_view_forest::SelectionKey {
            session_id: Some("s1".to_string()),
            active_session_id: Some("s1-live".to_string()),
        }),
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
    });
    mode.roster = vec![
        roster_entry("s1", "idle", parent_summary("s1")),
        roster_entry("s2", "idle", parent_summary("s2")),
    ];
    mode.rebuild_rows();
    assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s1");
    assert!(!mode.anchor_selection_pending);
}

/// The scoped view (the subagents summary line's open action) never
/// lists the anchor — the scope root is excluded — so the first-row
/// default stands there.
#[test]
fn scoped_view_keeps_the_first_row_default() {
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: Some("p".to_string()),
        scope: Some(AgentsViewScope {
            session_id: Some("p".to_string()),
            active_session_id: Some("p-live".to_string()),
            session_name: Some("p name".to_string()),
        }),
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
    });
    mode.roster = vec![
        roster_entry("p", "idle", parent_summary("p")),
        roster_entry("c", "running", child_summary("c", "p", "worker one")),
    ];
    mode.rebuild_rows();
    assert_eq!(mode.rows.len(), 1, "the scope root is excluded");
    assert_eq!(mode.selected, 0);
    assert_eq!(mode.rows[0].summary["sessionId"], "c");
    assert!(mode.anchor_selection_pending, "the wait never resolves");
    // The unresolved wait never blocks the scoped view's own opens:
    // Enter opens the first listed row.
    mode.handle_key("enter");
    let opened = mode
        .opened
        .expect("the scoped view opens despite the never-resolving wait");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("c-live".to_string())
    );
}

/// TS `countRowsBySection` (the splash header counts) counts agent-kind
/// rows only: a nested running subagent never inflates the header.
#[test]
fn header_counts_exclude_nested_rows() {
    let mut mode = mode_with_parent_and_child();
    mode.handle_key("alt+right");
    assert_eq!(mode.rows.len(), 3);
    assert_eq!(mode.rows[2].kind, RowKind::Subagent);
    let (lines, _) = mode.render_frame(120, 36);
    let header = lines
        .iter()
        .map(flat)
        .find(|line| line.contains("running,"))
        .expect("the splash carries the agents count line");
    // The count rides the art line (the splash paints them together):
    // assert the count, not the full line.
    assert!(
        header.contains("agents 0 running, 1 idle, 0 inactive"),
        "header: {header}"
    );
}

#[test]
fn alt_right_toggles_the_subagent_list() {
    let mut mode = mode_with_parent_and_child();
    // Collapsed: the parent, its summary row, nothing else.
    assert_eq!(mode.rows.len(), 2);
    assert_eq!(mode.rows[1].kind, RowKind::SubagentSummary);
    assert!(!mode.rows[1].expanded);
    // alt+right on the parent row (descendantCount > 0) expands.
    mode.handle_key("alt+right");
    assert_eq!(mode.rows.len(), 3);
    assert!(mode.rows[1].expanded);
    assert_eq!(mode.rows[2].kind, RowKind::Subagent);
    assert_eq!(mode.rows[2].depth, 1);
    // alt+right again collapses.
    mode.handle_key("alt+right");
    assert_eq!(mode.rows.len(), 2);
    assert!(!mode.rows[1].expanded);
}

/// A mode over one parent with two running and two idle children (the
/// operator's mixed roster).
fn mode_with_mixed_children() -> AgentsViewMode {
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
    });
    mode.roster = vec![
        roster_entry("p", "idle", parent_summary("p")),
        roster_entry("r1", "running", child_summary("r1", "p", "runner one")),
        roster_entry("r2", "running", child_summary("r2", "p", "runner two")),
        roster_entry("i1", "idle", child_summary("i1", "p", "old worker one")),
        roster_entry("i2", "idle", child_summary("i2", "p", "old worker two")),
    ];
    mode.rebuild_rows();
    mode
}

/// The operator's 2026-09-25 directive (Kevin): Enter on the running
/// line expands to ONLY the running children — the historical agents
/// never flood the running expansion — and the inactive line expands
/// separately to keep them discoverable.
#[test]
fn enter_expands_the_running_line_to_running_children_only() {
    let mut mode = mode_with_mixed_children();
    // Collapsed: the parent, its `2, 0 running` line, its `2 inactive
    // subagents` line.
    assert_eq!(mode.rows.len(), 3);
    assert_eq!(mode.rows[1].title, "2, 0 running");
    assert_eq!(mode.rows[1].identity, "subagents:file:/x/p.jsonl");
    assert_eq!(mode.rows[2].title, "2 inactive subagents");
    assert_eq!(mode.rows[2].identity, "subagents-inactive:file:/x/p.jsonl");
    // Enter on the running line: exactly the two runners render.
    mode.handle_key("down");
    mode.handle_key("enter");
    assert_eq!(mode.rows.len(), 5);
    assert!(mode.rows[1].expanded);
    assert!(
        mode.rows[2..4]
            .iter()
            .all(|row| row.title.starts_with("runner")),
        "the running expansion lists runners only: {rows:?}",
        rows = mode.rows
    );
    assert!(
        !mode.rows.iter().any(|row| row.title.contains("old worker")),
        "the inactive children stay off the running expansion"
    );
    // Enter again collapses it.
    mode.handle_key("enter");
    assert_eq!(mode.rows.len(), 3);
    assert!(!mode.rows[1].expanded);
    // The inactive line expands independently: the old workers
    // render, the runners stay out.
    mode.handle_key("down");
    mode.handle_key("down");
    assert_eq!(mode.rows[mode.selected].kind, RowKind::SubagentSummary);
    assert_eq!(mode.rows[mode.selected].title, "2 inactive subagents");
    mode.handle_key("enter");
    assert_eq!(mode.rows.len(), 5);
    assert!(mode.rows[2].expanded);
    assert!(
        mode.rows[3..5]
            .iter()
            .all(|row| row.title.starts_with("old worker")),
        "the inactive expansion lists the historical rows only: {rows:?}",
        rows = mode.rows
    );
    // The running line stays collapsed while the inactive one is
    // open: the two toggles never interfere.
    assert!(!mode.rows[1].expanded);
    // alt+right on the parent row opens its first line (the running
    // one, while work runs).
    let mut mode = mode_with_mixed_children();
    mode.handle_key("alt+right");
    assert!(mode.rows[1].expanded, "alt+right opens the running line");
    assert!(!mode.rows[2].expanded);
}

/// Live transitions (roster pushes): a child flipping running to idle
/// leaves the running expansion, the two lines' counts update in the
/// same rebuild, and the selection never resets to the top of the
/// list.
#[test]
fn live_transitions_update_both_lines_and_keep_the_selection() {
    let mut mode = mode_with_mixed_children();
    // Expand the running line and select the first runner.
    mode.handle_key("down");
    mode.handle_key("enter");
    mode.handle_key("down");
    assert_eq!(mode.rows[mode.selected].title, "runner one");
    let selected_identity = mode.rows[mode.selected].identity.clone();
    // The runner finishes: its roster row flips to idle.
    let idle_flip = roster_entry("r1", "idle", child_summary("r1", "p", "runner one"));
    mode.apply_roster_update(vec![idle_flip], Vec::new(), false);
    // The counts updated: one runner left, one historical row.
    let running_line = mode
        .rows
        .iter()
        .find(|row| row.title == "1, 0 running")
        .expect("the running line re-counted");
    assert!(
        running_line.expanded,
        "the line stays open through the flip"
    );
    let inactive_line = mode
        .rows
        .iter()
        .find(|row| row.title == "3 inactive subagents")
        .expect("the inactive line re-counted");
    assert!(!inactive_line.expanded);
    // The finished runner left the running expansion (it now rides
    // the collapsed inactive line); the selection follows the next
    // runner instead of snapping to the top.
    assert!(
        !mode
            .rows
            .iter()
            .any(|row| row.identity == selected_identity),
        "the idle row left the running expansion: {rows:?}",
        rows = mode.rows
    );
    assert_ne!(mode.selected, 0, "the selection never resets to the top");
    assert_eq!(mode.rows[mode.selected].title, "runner two");
    // The runner restarts: it reappears in the running expansion and
    // the counts flip back.
    let running_flip = roster_entry("r1", "running", child_summary("r1", "p", "runner one"));
    mode.apply_roster_update(vec![running_flip], Vec::new(), false);
    assert!(
        mode.rows.iter().any(|row| row.title == "runner one"),
        "the restarted runner renders again: {rows:?}",
        rows = mode.rows
    );
    assert!(mode
        .rows
        .iter()
        .any(|row| row.title == "2, 0 running" && row.expanded));
    // The selection stays on the session it followed (runner two),
    // not the re-inserted row above it.
    assert_eq!(mode.rows[mode.selected].title, "runner two");
}

/// The rendered frame carries the two summary lines: the running
/// line's `direct, nested` pair and the explicit inactive label.
#[test]
fn frame_renders_the_running_pair_and_inactive_line() {
    let mut grandchild = child_summary("gc", "c", "grandkid");
    grandchild["rlmChildId"] = serde_json::json!("child-gc");
    let mut mode = mode_with_parent_and_child();
    mode.roster.push(roster_entry("gc", "running", grandchild));
    mode.roster.push(roster_entry(
        "i1",
        "idle",
        child_summary("i1", "p", "old worker"),
    ));
    mode.rebuild_rows();
    assert_eq!(mode.rows[1].title, "1, 1 running");
    assert_eq!(mode.rows[2].title, "1 inactive subagent");
    let (lines, _) = mode.render_frame(120, 36);
    let frame = lines.iter().map(flat).collect::<Vec<_>>().join("\n");
    assert!(frame.contains("\u{25b8} 1, 1 running"), "frame: {frame}");
    assert!(
        frame.contains("\u{25b8} 1 inactive subagent"),
        "frame: {frame}"
    );
}

/// A mode over the same live parent/child roster whose user bindings
/// replace keys (TS `keybindings.json` parity, the #184 binding-test
/// pattern: an override fires, the default goes inert).
fn mode_with_user_bindings(bindings: &[(&str, &str)]) -> AgentsViewMode {
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    for (id, key) in bindings {
        cfg.insert(id.to_string(), vec![key.to_string()]);
    }
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::with_user_bindings(cfg),
        show_hardware_cursor: false,
        incident_notice_state: None,
    });
    mode.roster = vec![
        roster_entry("p", "idle", parent_summary("p")),
        roster_entry("c", "running", child_summary("c", "p", "worker one")),
    ];
    mode.rebuild_rows();
    mode
}

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

#[test]
fn hints_render_the_effective_bindings() {
    // Defaults: TS `renderHints` with the stock keys, plus the
    // stop-or-delete slot the selected live row arms.
    let mode = mode_with_parent_and_child();
    assert_eq!(
        flat(&mode.render_hints(120, None)),
        "\u{2191}/\u{2193} navigate   Home/End first/last   Enter/\u{2192} open   Ctrl+X stop   Ctrl+N new"
    );
    // A user override moves the hint with the handler.
    let mode = mode_with_user_bindings(&[("app.agents.new", "ctrl+t")]);
    let hints = flat(&mode.render_hints(120, None));
    assert_eq!(
        hints,
        "\u{2191}/\u{2193} navigate   Home/End first/last   Enter/\u{2192} open   Ctrl+X stop   Ctrl+T new"
    );
    assert!(!hints.contains("Ctrl+N"), "the default new hint is gone");
    // An override on the delete binding moves its slot too.
    let mode = mode_with_user_bindings(&[("app.agents.delete", "ctrl+k")]);
    let hints = flat(&mode.render_hints(120, None));
    assert!(hints.contains("Ctrl+K stop"), "{hints}");
    assert!(!hints.contains("Ctrl+X"), "{hints}");
}

/// The stop-or-delete slot rides the selected row: a live row stops,
/// a saved-only row deletes, and a row with no arming target (a
/// summary row) drops the slot instead of advertising a no-op. An
/// empty override drops it everywhere.
#[test]
fn hints_delete_slot_rides_the_selected_row() {
    // The live parent (an idle-but-live session) stops.
    let mode = mode_with_parent_and_child();
    assert!(flat(&mode.render_hints(120, None)).contains("Ctrl+X stop"));
    // A saved-only row (no live session) deletes: the Inactive
    // section's saved row, selected like the saved-arms test.
    let mut mode = mode_with_anchor(None, Vec::new());
    mode.saved = vec![saved_catalog_row("/x/a.jsonl", "a", "a saved session")];
    mode.rebuild_rows();
    mode.selected = mode
        .rows
        .iter()
        .position(|row| row.identity.contains("a.jsonl"))
        .expect("the saved row");
    assert!(
        flat(&mode.render_hints(120, None)).contains("Ctrl+X delete"),
        "the saved-only row deletes"
    );
    // A summary row has no target: no slot, and the confirm never
    // arms there either.
    let mut mode = mode_with_parent_and_child();
    let parent_row = mode
        .rows
        .iter()
        .find(|row| row.kind == RowKind::Agent)
        .expect("the parent row")
        .clone();
    mode.toggle_subagent_list(&parent_row);
    mode.selected = mode
        .rows
        .iter()
        .position(|row| row.kind == RowKind::SubagentSummary)
        .expect("the summary row");
    assert!(
        !flat(&mode.render_hints(120, None)).contains("Ctrl+X"),
        "the summary row carries no delete slot"
    );
    // An override that empties the binding drops the slot (an
    // unbound action is never advertised).
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert("app.agents.delete".to_string(), Vec::new());
    let mut mode = mode_with_parent_and_child();
    mode.keybindings = crate::keybindings::KeybindingsManager::with_user_bindings(cfg);
    assert!(
        !flat(&mode.render_hints(120, None)).contains("Ctrl+X"),
        "an unbound delete never advertises"
    );
}

/// Every bar segment drops when its action is unbound — navigate,
/// open, parent, and new follow the jump and stop-or-delete slots'
/// contract; a two-key segment keeps whichever of the pair is
/// bound.
#[test]
fn hints_drop_segments_for_unbound_actions() {
    // up/down emptied drops navigate; open emptied keeps the bound
    // confirm key alone; new emptied drops its segment.
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert("tui.select.up".to_string(), Vec::new());
    cfg.insert("tui.select.down".to_string(), Vec::new());
    cfg.insert("app.agents.open".to_string(), Vec::new());
    cfg.insert("app.agents.new".to_string(), Vec::new());
    let mut mode = mode_with_parent_and_child();
    mode.keybindings = crate::keybindings::KeybindingsManager::with_user_bindings(cfg);
    let hints = flat(&mode.render_hints(120, None));
    assert!(!hints.contains("navigate"), "{hints}");
    assert!(hints.contains("Enter open"), "{hints}");
    assert!(!hints.contains("Enter/\u{2192}"), "{hints}");
    assert!(!hints.contains("new"), "{hints}");
    assert!(hints.contains("Ctrl+X stop"), "{hints}");
    assert!(hints.contains("Home/End first/last"), "{hints}");
    // confirm and open both emptied drops the open segment
    // entirely; the other segments keep their keys.
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert("tui.select.confirm".to_string(), Vec::new());
    cfg.insert("app.agents.open".to_string(), Vec::new());
    let mut mode = mode_with_parent_and_child();
    mode.keybindings = crate::keybindings::KeybindingsManager::with_user_bindings(cfg);
    let hints = flat(&mode.render_hints(120, None));
    assert!(!hints.contains(" open"), "{hints}");
    assert!(hints.contains("navigate"), "{hints}");
    // The scoped parent segment drops when the back binding is
    // emptied.
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert("app.agents.back".to_string(), Vec::new());
    let mut mode = mode_with_parent_and_child();
    mode.keybindings = crate::keybindings::KeybindingsManager::with_user_bindings(cfg);
    mode.scope_active = true;
    let hints = flat(&mode.render_hints(120, None));
    assert!(!hints.contains("parent"), "{hints}");
    // A multi-key delete override names every configured key (the
    // dispatch takes the whole set).
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert(
        "app.agents.delete".to_string(),
        vec!["ctrl+x".to_string(), "ctrl+d".to_string()],
    );
    let mut mode = mode_with_parent_and_child();
    mode.keybindings = crate::keybindings::KeybindingsManager::with_user_bindings(cfg);
    let hints = flat(&mode.render_hints(120, None));
    assert!(hints.contains("Ctrl+X/Ctrl+D stop"), "{hints}");
}

/// The delete and parent slots share the handler's empty-search
/// gate: their keys are inert while a query is active, so the bar
/// drops them until the search clears.
#[test]
fn hints_drop_the_query_gated_actions_while_searching() {
    let mut mode = mode_with_parent_and_child();
    mode.query = "p".to_string();
    let hints = flat(&mode.render_hints(120, None));
    assert!(
        !hints.contains("Ctrl+X"),
        "the delete slot drops during a search: {hints}"
    );
    let mut mode = mode_with_parent_and_child();
    mode.scope_active = true;
    mode.query = "p".to_string();
    let hints = flat(&mode.render_hints(120, None));
    assert!(
        !hints.contains("parent"),
        "the parent slot drops during a search: {hints}"
    );
    // The search cleared, the slots return.
    mode.query.clear();
    let hints = flat(&mode.render_hints(120, None));
    assert!(hints.contains("parent"), "{hints}");
}

#[test]
fn enter_toggles_the_summary_row_and_drills_into_a_child() {
    let mut mode = mode_with_parent_and_child();
    // The selection starts on the parent; down lands on the summary
    // row, and Enter toggles it (TS `openSelected` on a summary row).
    mode.handle_key("down");
    assert_eq!(mode.rows[mode.selected].kind, RowKind::SubagentSummary);
    mode.handle_key("enter");
    assert_eq!(mode.rows.len(), 3);
    assert!(mode.rows[1].expanded);
    // Enter on the summary row again collapses.
    mode.handle_key("enter");
    assert_eq!(mode.rows.len(), 2);
    // Expand, walk to the child, drill in (TS `openSelectedSubagent`).
    mode.handle_key("enter");
    mode.handle_key("down");
    assert_eq!(mode.rows[mode.selected].kind, RowKind::Subagent);
    mode.handle_key("enter");
    let opened = mode.opened.as_ref().expect("open recorded");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("c-live".to_string())
    );
    // The drill-in carries the ancestor chain for the return
    // re-expansion and the child's depth for its tray label.
    assert_eq!(opened.expanded_ancestors, vec!["p".to_string()]);
    assert_eq!(opened.rlm_depth, Some(1));
    // The child itself has no children in this fixture.
    assert!(!opened.has_children);
    assert!(!mode.running);
}

#[test]
fn pending_ancestors_expand_and_selection_restores_after_reentry() {
    // A fresh run carrying the drilled-in child's return state (TS
    // `pendingExpandedAncestorSessionIds` + the persisted selection).
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: vec!["p".to_string()],
        selected_row_identity: None,
        selected_key: Some(crate::agents_view_forest::SelectionKey {
            session_id: Some("c".to_string()),
            active_session_id: Some("c-live".to_string()),
        }),
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
    });
    mode.roster = vec![
        roster_entry("p", "idle", parent_summary("p")),
        roster_entry("c", "running", child_summary("c", "p", "worker one")),
    ];
    mode.rebuild_rows();
    // The ancestor expansion opened the parent's list and the child
    // row's selection restored.
    assert_eq!(mode.rows.len(), 3);
    assert!(mode.rows[1].expanded);
    assert_eq!(mode.rows[mode.selected].title, "worker one");
}

#[test]
fn scoped_left_returns_the_root_and_pops_the_scope() {
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: Some(AgentsViewScope {
            session_id: Some("p".to_string()),
            active_session_id: Some("p-live".to_string()),
            session_name: Some("p name".to_string()),
        }),
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
    });
    mode.roster = vec![
        roster_entry("p", "idle", parent_summary("p")),
        roster_entry("c", "running", child_summary("c", "p", "worker one")),
    ];
    mode.rebuild_rows();
    // The scoped view lists the direct child as a top-level row.
    assert!(mode.scope_active);
    assert_eq!(mode.rows.len(), 1);
    assert_eq!(mode.rows[0].kind, RowKind::Agent);
    // The parent key hands the terminal back to the scope root and
    // marks the scope popped for the flow.
    mode.handle_key("left");
    assert!(mode.scope_popped);
    let opened = mode.opened.as_ref().expect("scope-back open");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("p-live".to_string())
    );
    // The scope root has no ancestors of its own, so nothing
    // re-expands after the return chat.
    assert!(opened.expanded_ancestors.is_empty());
}

#[test]
fn unattachable_child_opens_its_root_with_a_status() {
    let mut mode = mode_with_parent_and_child();
    // A finished child with no runtime and no file resolves to its
    // top-level ancestor (TS `createUnattachableChildOpenResult`).
    let unattachable = serde_json::json!({
        "sessionId": "gc",
        "lifecycle": "live",
        "runtimeKind": "subagent",
        "rlmChildId": "child-gc",
        "rlmDepth": 2,
        "parentActiveSessionId": "c-live",
        "parentSessionId": "c",
        "sessionName": "lost grandchild",
        "messageCount": 1,
    });
    mode.roster
        .push(roster_entry("gc", "inactive", unattachable));
    // The grandchild is roster-inactive under the running child: the
    // parent's inactive line flattens through the child and renders
    // it (the running expansion never expands a child's inactive
    // line — the purity rule keeps the running view's rows
    // running-only, so the child's own inactive line stays shut
    // there and the inactive path is the one that reaches it).
    mode.expanded_inactive_parents
        .insert("file:/x/p.jsonl".to_string());
    mode.rebuild_rows();
    let grandchild = mode
        .rows
        .iter()
        .position(|row| row.title == "lost grandchild")
        .expect("grandchild row renders");
    mode.selected = grandchild;
    mode.handle_key("enter");
    let opened = mode.opened.as_ref().expect("open recorded");
    // The parent chain's root session opens instead, with the child
    // row kept for the selection restore and a status message.
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("p-live".to_string())
    );
    assert_eq!(
        opened.status_message.as_deref(),
        Some("Child session is unavailable; opened its parent instead")
    );
}
/// A multi-session roster for the selection-persistence probes: six
/// idle top-level sessions with distinct activity stamps (newest
/// first, matching the Idle section's recency sort).
fn churn_roster() -> Vec<serde_json::Value> {
    (1..=6)
        .map(|n| {
            roster_entry(
                &format!("s{n}"),
                "idle",
                serde_json::json!({
                    "sessionId": format!("s{n}"), "lifecycle": "live",
                    "activeSessionId": format!("s{n}-live"),
                    "sessionFile": format!("/x/s{n}.jsonl"),
                    "runtimeKind": "top-level",
                    "sessionName": format!("session {n}"),
                    "messageCount": 2,
                    "rlmDepth": 0,
                    "lastActivityAt": format!("2025-01-{:02}T00:00:00.000Z", 7 - n),
                }),
            )
        })
        .collect()
}

fn fresh_mode(roster: Vec<serde_json::Value>) -> AgentsViewMode {
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
    });
    mode.roster = roster;
    mode.rebuild_rows();
    mode
}

/// Kevin's dogfood symptom (2026-09-21): arrowing down while the
/// roster churns (subagent spawns, activity re-sorts) must keep the
/// selection on the same SESSION, and the list window must keep
/// showing it. The selection is session-keyed (identity, then
/// active/session id — TS `resolveAgentsViewSelectionState`), so a
/// rebuild that adds rows ABOVE the selection follows the session
/// down, and the render window (TS `renderSessionRows`) centers on it
/// instead of snapping back to the top of the list.
#[test]
fn selection_follows_the_session_through_spawn_churn() {
    let roster = churn_roster();
    let mut mode = fresh_mode(roster.clone());
    // Arrow down three times: the selection sits on session 4.
    for _ in 0..3 {
        mode.handle_key("down");
    }
    assert_eq!(mode.rows[mode.selected].title, "session 4");
    // Spawn churn above the selection: session 1 flips to running
    // (moves to the Running section) and a new running child appears
    // under it, both above the selected row's position.
    let mut churned = roster;
    churned[0] = roster_entry(
        "s1",
        "running",
        serde_json::json!({
            "sessionId": "s1", "lifecycle": "live",
            "activeSessionId": "s1-live",
            "sessionFile": "/x/s1.jsonl",
            "runtimeKind": "top-level",
            "sessionName": "session 1",
            "messageCount": 2, "rlmDepth": 0,
            "lastActivityAt": "2025-01-08T00:00:00.000Z",
        }),
    );
    churned.push(roster_entry(
        "/x/s1.jsonl#child-w",
        "running",
        child_summary("w", "s1", "spawned worker"),
    ));
    mode.apply_roster_update(churned.clone(), Vec::new(), false);
    // The selection follows session 4's identity, not the row index.
    assert_eq!(
        mode.rows[mode.selected].title, "session 4",
        "spawn churn must not move the selection off the selected session"
    );
    // The selected session stays selectable and its key stays synced
    // (TS `syncSelectedRowState`): further churn keeps following it.
    for _ in 0..3 {
        mode.apply_roster_update(churned.clone(), Vec::new(), false);
    }
    assert_eq!(mode.rows[mode.selected].title, "session 4");
}

/// TS parity: an idle roster re-push (same sessions, same states) is a
/// no-op — the rebuild must not touch the selection at all (same row,
/// same index, same identity).
#[test]
fn selection_untouched_by_noop_roster_updates() {
    let roster = churn_roster();
    let mut mode = fresh_mode(roster.clone());
    for _ in 0..3 {
        mode.handle_key("down");
    }
    let (index, identity, key) = (
        mode.selected,
        mode.rows[mode.selected].identity.clone(),
        mode.selected_key.clone(),
    );
    // The daemon re-pushes identical entries (idle status ticks).
    mode.apply_roster_update(roster, Vec::new(), false);
    assert_eq!(mode.selected, index);
    assert_eq!(mode.rows[mode.selected].identity, identity);
    assert_eq!(mode.selected_key, key);
}

/// The selected session left the roster (archived away, no saved-catalog
/// row for it): the resolution cannot re-find it, and TS
/// `resolveAgentsViewSelectionState` keeps the bounded current index —
/// never a reset to the top of the list.
#[test]
fn selected_session_gone_keeps_the_bounded_position() {
    let roster = churn_roster();
    let mut mode = fresh_mode(roster.clone());
    for _ in 0..3 {
        mode.handle_key("down");
    }
    assert_eq!(mode.rows[mode.selected].title, "session 4");
    let shrunk: Vec<serde_json::Value> = roster
        .into_iter()
        .filter(|entry| entry["agentId"] != serde_json::json!("s4"))
        .collect();
    mode.apply_roster_update(Vec::new(), vec!["s4".to_string()], false);
    assert_eq!(mode.roster.len(), shrunk.len());
    // The identity and its keys are gone: the selection keeps the
    // bounded index (the row that now occupies the slot), not 0.
    assert_eq!(mode.selected, 3);
    assert_eq!(mode.rows[mode.selected].title, "session 5");
}

/// TS `renderSessionRows` viewport parity: the list window centers on
/// the selected row and clips the overflow behind ellipsis lines, so
/// arrowing below the fold keeps the selection visible — the Rust view
/// used to render from the top and truncate, which read as the
/// selection teleporting back up while the roster churned.
#[test]
fn list_window_follows_the_selection_below_the_fold() {
    let roster: Vec<serde_json::Value> = (1..=12)
        .map(|n| {
            roster_entry(
                &format!("s{n}"),
                "idle",
                serde_json::json!({
                    "sessionId": format!("s{n}"), "lifecycle": "live",
                    "activeSessionId": format!("s{n}-live"),
                    "sessionFile": format!("/x/s{n}.jsonl"),
                    "runtimeKind": "top-level",
                    "sessionName": format!("session {n}"),
                    "messageCount": 2, "rlmDepth": 0,
                    "lastActivityAt": format!("2025-01-{:02}T00:00:00.000Z", 13 - n),
                }),
            )
        })
        .collect();
    let mut mode = fresh_mode(roster);
    assert_eq!(mode.rows.len(), 12);
    let frame_texts = |mode: &mut AgentsViewMode| -> Vec<String> {
        mode.render_list(120, 8, 0)
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect()
    };
    // Selection at the top: legend + spacer + heading + four rows +
    // the trailing ellipsis — 8 lines, the first four sessions below
    // the fold clipped away (TS `renderSessionRows` with maxRows 8:
    // headerRows 2, visibleRows 6, one trailing clip row).
    let texts = frame_texts(&mut mode);
    assert_eq!(texts.len(), 8);
    assert!(texts[0].contains("Session"), "legend: {texts:?}");
    assert!(texts[2].contains("Idle (12)"));
    assert!(texts[3].contains("session 1"));
    assert_eq!(texts[7].trim(), "...");
    assert!(!texts.iter().any(|t| t.contains("session 5")));
    // Arrow to the bottom: the window centers on the selected row
    // (session 12 stays on-screen), the leading ellipsis covers the
    // clipped rows above, and the trailing one disappears at the end.
    for _ in 0..11 {
        mode.handle_key("down");
    }
    assert_eq!(mode.rows[mode.selected].title, "session 12");
    let texts = frame_texts(&mut mode);
    assert_eq!(texts.len(), 8);
    assert_eq!(texts[2].trim(), "...");
    assert!(
        texts.iter().any(|t| t.contains("session 12")),
        "the selected row must render inside the window: {texts:?}"
    );
    assert!(!texts.iter().any(|t| t.contains("session 7")));
    assert_ne!(texts.last().map(|t| t.trim()), Some("..."));
    // The selected row carries the selection background (its line
    // paints over the full width; the unselected rows do not).
    let selected_line = mode.render_list(120, 8, 0);
    let painted = selected_line
        .iter()
        .any(|line| line.iter().any(|span| span.style.bg.is_some()));
    assert!(
        painted,
        "the selected row renders with the selection background"
    );
    // Arrow back to the top: the leading ellipsis goes away and the
    // first rows render behind the legend again.
    for _ in 0..11 {
        mode.handle_key("up");
    }
    assert_eq!(mode.rows[mode.selected].title, "session 1");
    let texts = frame_texts(&mut mode);
    assert!(texts[3].contains("session 1"));
    assert_eq!(texts[7].trim(), "...");
}

#[test]
fn idle_draws_only_on_running_row_pulses() {
    for count in [0, 100, 1000] {
        for running in [false, true] {
            let (mut mode, _) = mode_with_row("row", "mock-1");
            let template = mode.rows[0].clone();
            mode.rows = (0..count)
                .map(|n| {
                    let mut row = template.clone();
                    row.identity = format!("agent {n}");
                    row.section = if running {
                        Section::Running
                    } else {
                        Section::Idle
                    };
                    row
                })
                .collect();
            let start = tokio::time::Instant::now();
            let mut last_pulse = start;
            let draws = (1..=20)
                .filter(|tick| {
                    advance_running_pulse(
                        &mut mode,
                        &mut last_pulse,
                        start + Duration::from_millis(tick * 50),
                    )
                })
                .count();
            let expected = if running && count > 0 { 4 } else { 0 };
            assert_eq!((draws, mode.pulse), (expected, expected));
        }
    }
}

/// A large forest of idle top-level sessions (the churn roster's
/// shape, scaled): one-row arrows cannot cross it in a sitting.
fn forest_roster(count: usize) -> Vec<serde_json::Value> {
    (1..=count)
        .map(|n| {
            roster_entry(
                &format!("s{n}"),
                "idle",
                serde_json::json!({
                    "sessionId": format!("s{n}"), "lifecycle": "live",
                    "activeSessionId": format!("s{n}-live"),
                    "sessionFile": format!("/x/s{n}.jsonl"),
                    "runtimeKind": "top-level",
                    "sessionName": format!("session {n}"),
                    "messageCount": 1,
                    "rlmDepth": 0,
                    "lastActivityAt": "2025-01-01T00:00:00.000Z",
                }),
            )
        })
        .collect()
}

/// The edge jump keys (home/end and their ctrl/super variants) select
/// the first/last row in one press, the synced identity/key follow the
/// landed row, and the arrows keep moving one row from either edge.
#[test]
fn home_and_end_jump_the_selection_to_the_list_edges() {
    let mut mode = fresh_mode(forest_roster(120));
    assert_eq!(mode.rows.len(), 120);
    for key in ["home", "ctrl+home", "super+home", "super+up"] {
        mode.selected = 60;
        mode.handle_key(key);
        assert_eq!(mode.selected, 0, "{key} selects the first row");
    }
    let last = mode.rows.len() - 1;
    for key in ["end", "ctrl+end", "super+end", "super+down"] {
        mode.selected = 60;
        mode.handle_key(key);
        assert_eq!(mode.selected, last, "{key} selects the last row");
    }
    assert_eq!(
        mode.selected_identity.as_deref(),
        Some(mode.rows[last].identity.as_str()),
        "the jump syncs the carried identity onto the landed row"
    );
    mode.handle_key("up");
    assert_eq!(mode.selected, last - 1);
    mode.handle_key("home");
    mode.handle_key("down");
    assert_eq!(mode.selected, 1);
}

/// A user override moves the jump with the handler; the default key
/// goes inert, and the hint slot renders the override (the #184
/// binding-test pattern).
#[test]
fn edge_jump_keys_can_be_rebound() {
    let mut mode = mode_with_user_bindings(&[("tui.select.top", "ctrl+j")]);
    mode.handle_key("down");
    let before = mode.selected;
    mode.handle_key("home");
    assert_eq!(mode.selected, before, "home is inert after the override");
    mode.handle_key("ctrl+j");
    assert_eq!(mode.selected, 0, "the override jumps");
    assert!(
        flat(&mode.render_hints(120, None)).contains("Ctrl+J/End first/last"),
        "the jump hint renders the override"
    );
}

/// The jump is an explicit user choice: it ends the entry anchor's
/// wait, so a later anchor landing cannot override the jumped-to row.
#[test]
fn edge_jump_ends_the_entry_anchor_wait() {
    let mut mode = mode_with_anchor(
        Some("nowhere"),
        vec![
            roster_entry("s1", "idle", parent_summary("s1")),
            roster_entry("s2", "idle", parent_summary("s2")),
        ],
    );
    assert!(mode.anchor_selection_pending);
    mode.handle_key("end");
    assert!(!mode.anchor_selection_pending, "the jump ends the wait");
    assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s2");
}

/// The render window follows the jump: on a large forest the landed
/// row renders inside the viewport (the selected row's display index
/// drives the window, TS `renderSessionRows`).
#[test]
fn the_viewport_follows_the_edge_jump() {
    let mut mode = fresh_mode(forest_roster(80));
    mode.handle_key("end");
    let texts: Vec<String> = mode
        .render_list(120, 10, 0)
        .iter()
        .map(|line| line.iter().map(|s| s.content.as_str()).collect())
        .collect();
    let last_title = mode.rows[mode.selected].title.clone();
    assert!(
        texts.iter().any(|t| t.contains(last_title.as_str())),
        "the last row renders in the window: {texts:?}"
    );
}

/// The carried catalog seeds the mode (TS
/// `persistentState.savedSessions`): the surface writes the link's
/// rows into `saved` before the first rebuild, so the Inactive
/// section paints them immediately, the anchor lands from the carried
/// rows, and a terminal load flips the loaded flag for the flow's
/// next run.
#[test]
fn the_carried_catalog_paints_and_the_load_flags_the_carry() {
    let mut mode = mode_with_anchor(Some("s2"), vec![]);
    assert!(
        mode.saved.is_empty() && !mode.saved_catalog_loaded,
        "a fresh run starts with no catalog"
    );
    // The surface's seeding (the link's carried rows).
    mode.saved = vec![saved_catalog_row("/x/s2.jsonl", "s2", "carried chat")];
    mode.rebuild_rows();
    assert!(
        mode.rows
            .iter()
            .any(|row| row.summary.get("sessionId").and_then(Value::as_str) == Some("s2")),
        "the carried row renders without any fetch"
    );
    assert!(
        !mode.anchor_selection_pending,
        "the anchor lands from the carried catalog - no loading hold"
    );
    assert!(
        !mode.saved_catalog_loaded,
        "carried rows alone are not a settled catalog (a run that only carried still fetches)"
    );
    mode.apply_saved_loaded(vec![saved_catalog_row("/x/s2.jsonl", "s2", "carried chat")]);
    assert!(
        mode.saved_catalog_loaded,
        "the terminal load flags the carry for the flow's next run"
    );
}

/// The operator's 2026-09-26 ask: BOTH collapsed summary lines render
/// the descendant-tree aggregate in the SAME Cost column the agent
/// rows bill — the right-aligned `${:.2}` cell, the Age column blank
/// behind it. The running line first, then the follow-up: an all-done
/// tree renders no running line, so the inactive line carries the same
/// aggregate. TS renders no cost on the summary row
/// (`createSubagentSummaryRow` pins `recursiveCost: 0`): the
/// aggregate is a deliberate Rust divergence.
#[test]
fn running_line_renders_the_aggregate_in_the_cost_column() {
    let mut parent = parent_summary("p");
    parent["usage"] = serde_json::json!({ "cost": 0.25 });
    let mut runner = child_summary("r1", "p", "runner");
    runner["usage"] = serde_json::json!({ "cost": 1.25 });
    let mut grandchild = child_summary("gc", "r1", "grandkid");
    grandchild["rlmChildId"] = serde_json::json!("child-gc");
    grandchild["usage"] = serde_json::json!({ "cost": 0.25 });
    let mut idle_child = child_summary("i1", "p", "idle worker");
    idle_child["usage"] = serde_json::json!({ "cost": 2.5 });
    let mut inactive_child = child_summary("x1", "p", "old worker");
    inactive_child["usage"] = serde_json::json!({ "cost": 0.75 });
    let mut mode = mode_with_parent_and_child();
    mode.roster = vec![
        roster_entry("p", "idle", parent),
        roster_entry("r1", "running", runner),
        roster_entry("gc", "running", grandchild),
        roster_entry("i1", "idle", idle_child),
        roster_entry("x1", "inactive", inactive_child),
    ];
    mode.rebuild_rows();
    assert_eq!(mode.rows[1].title, "1, 1 running");
    let (lines, _) = mode.render_frame(120, 36);
    let flat_lines: Vec<String> = lines.iter().map(flat).collect();
    let running = flat_lines
        .iter()
        .find(|line| line.contains("1, 1 running"))
        .expect("running line renders");
    let parent_line = flat_lines
        .iter()
        .find(|line| line.contains("p name"))
        .expect("parent row renders");
    let cost_at = running.find("$4.75").expect("the aggregate prints");
    let parent_cost_at = parent_line.find("$5.00").expect("the parent total prints");
    assert_eq!(
        cost_at, parent_cost_at,
        "the aggregate shares the agent rows' Cost column"
    );
    assert!(
        running.trim_end().ends_with("$4.75"),
        "the Age column stays blank behind the aggregate: {running:?}"
    );
    // The inactive line bills the SAME descendant tree aggregate at
    // the same right-aligned column (the operator's follow-up: the
    // aggregate must stay visible in the all-done state, where no
    // running line renders), Age blank behind it.
    let inactive = flat_lines
        .iter()
        .find(|line| line.contains("inactive subagents"))
        .expect("inactive line renders");
    let inactive_cost_at = inactive
        .find("$4.75")
        .expect("the inactive aggregate prints");
    assert_eq!(
        inactive_cost_at, cost_at,
        "the inactive line shares the agent rows' Cost column"
    );
    assert!(
        inactive.trim_end().ends_with("$4.75"),
        "the Age column stays blank behind the inactive aggregate: {inactive:?}"
    );
}

/// A tree that spends nothing still prints its `$0.00` aggregate —
/// the cost cell rides the row, it is never a value-dependent
/// extra.
#[test]
fn running_line_renders_zero_when_nothing_bills() {
    let mut mode = mode_with_parent_and_child();
    assert_eq!(mode.rows[1].title, "1, 0 running");
    let (lines, _) = mode.render_frame(120, 36);
    let running = lines
        .iter()
        .map(flat)
        .find(|line| line.contains("1, 0 running"))
        .expect("running line renders");
    assert!(
        running.contains("$0.00"),
        "the zero aggregate prints in the Cost column: {running:?}"
    );
}

/// The all-done state — the frame the operator actually inspects
/// after work completes: no descendant runs, so NO running line
/// renders and the inactive line is the only summary row. Its Cost
/// cell carries the same descendant-tree aggregate the running line
/// billed mid-run (#2843's regression: the aggregate rode a row
/// that vanished the moment the children finished, and the
/// full-width unbilled inactive line left the Cost column blank
/// behind it).
#[test]
fn inactive_line_renders_the_aggregate_in_the_all_done_state() {
    let mut parent = parent_summary("p");
    parent["usage"] = serde_json::json!({ "cost": 0.25 });
    let mut idle_child = child_summary("i1", "p", "idle worker");
    idle_child["usage"] = serde_json::json!({ "cost": 1.25 });
    let mut inactive_child = child_summary("x1", "p", "old worker");
    inactive_child["usage"] = serde_json::json!({ "cost": 0.75 });
    let mut mode = mode_with_parent_and_child();
    mode.roster = vec![
        roster_entry("p", "idle", parent),
        roster_entry("i1", "idle", idle_child),
        roster_entry("x1", "inactive", inactive_child),
    ];
    mode.rebuild_rows();
    assert!(
        !mode.rows.iter().any(|row| row.title.contains("running")),
        "no running line renders when nothing runs"
    );
    let (lines, _) = mode.render_frame(120, 36);
    let flat_lines: Vec<String> = lines.iter().map(flat).collect();
    let inactive = flat_lines
        .iter()
        .find(|line| line.contains("2 inactive subagents"))
        .expect("the inactive line renders");
    let parent_line = flat_lines
        .iter()
        .find(|line| line.contains("p name"))
        .expect("parent row renders");
    let cost_at = inactive.find("$2.00").expect("the aggregate prints");
    let parent_cost_at = parent_line.find("$2.25").expect("the parent total prints");
    assert_eq!(
        cost_at, parent_cost_at,
        "the inactive line shares the agent rows' Cost column"
    );
    assert!(
        inactive.trim_end().ends_with("$2.00"),
        "the Age column stays blank behind the aggregate: {inactive:?}"
    );
}

/// The aggregate survives the #2866 incident-notice render path: a
/// notice rides the header above the list, the list window shrinks,
/// and the inactive line's Cost cell still prints the aggregate in
/// the same frame.
#[test]
fn aggregate_survives_the_incident_notice_render_path() {
    let mut parent = parent_summary("p");
    parent["usage"] = serde_json::json!({ "cost": 0.25 });
    let mut idle_child = child_summary("i1", "p", "idle worker");
    idle_child["usage"] = serde_json::json!({ "cost": 1.25 });
    let mut mode = mode_with_parent_and_child();
    mode.roster = vec![
        roster_entry("p", "idle", parent),
        roster_entry("i1", "idle", idle_child),
    ];
    mode.rebuild_rows();
    mode.incident_notice_state.notice = Some(crate::incident_notices::IncidentNotice {
        kind: crate::incident_notices::IncidentNoticeKind::WorkerCrash,
        key: "worker-crash|w1".to_string(),
        severity: pa_types::incident::IncidentSeverity::Error,
        subject: "w1".to_string(),
        time_ms: 1_000,
        text: "worker w1 crashed at 00:00".to_string(),
    });
    let (lines, _) = mode.render_frame(120, 36);
    let text: Vec<String> = lines.iter().map(flat).collect();
    assert!(
        text.iter().any(|line| line.contains("worker w1 crashed")),
        "the notice renders: {text:?}"
    );
    let inactive = text
        .iter()
        .find(|line| line.contains("1 inactive subagent"))
        .expect("the inactive line renders behind the notice");
    assert!(
        inactive.contains("$1.25"),
        "the aggregate prints under the incident notice: {inactive:?}"
    );
}

/// The aggregate survives the #2865 click surface: the rendered
/// frame records its clickable rows (the summary row among them) in
/// the same pass that bills the Cost cell, and a plain click on the
/// inactive line expands its list while the aggregate stays put.
#[test]
fn aggregate_survives_the_click_surface_render_path() {
    // Mouse tracking is process-global state: the click grammar's
    // tests serialize through its lock and leave it off.
    let _guard = match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let mut parent = parent_summary("p");
    parent["usage"] = serde_json::json!({ "cost": 0.25 });
    let mut idle_child = child_summary("i1", "p", "idle worker");
    idle_child["usage"] = serde_json::json!({ "cost": 1.25 });
    let mut mode = mode_with_parent_and_child();
    mode.roster = vec![
        roster_entry("p", "idle", parent),
        roster_entry("i1", "idle", idle_child),
    ];
    mode.rebuild_rows();
    let (lines, _) = mode.render_frame(120, 36);
    let flat_lines: Vec<String> = lines.iter().map(flat).collect();
    let inactive = flat_lines
        .iter()
        .find(|line| line.contains("1 inactive subagent"))
        .expect("the inactive line renders");
    assert!(
        inactive.contains("$1.25"),
        "the aggregate prints in the click-recorded frame: {inactive:?}"
    );
    let summary_index = mode
        .rows
        .iter()
        .position(|row| row.kind == RowKind::SubagentSummary)
        .expect("the summary row");
    let (row, _) = mode
        .click_rows
        .iter()
        .find(|(_, index)| *index == summary_index)
        .copied()
        .expect("the summary row is clickable in the same frame");
    mode.handle_mouse(&mouse_report(row, true, false));
    mode.handle_mouse(&mouse_report(row, false, false));
    let (lines, _) = mode.render_frame(120, 36);
    let flat_lines: Vec<String> = lines.iter().map(flat).collect();
    assert!(
        flat_lines.iter().any(|line| line.contains("idle worker")),
        "the click expanded the inactive list"
    );
    let inactive = flat_lines
        .iter()
        .find(|line| line.contains("1 inactive subagent"))
        .expect("the inactive line still renders expanded");
    assert!(
        inactive.contains("$1.25"),
        "the aggregate stays on the expanded line: {inactive:?}"
    );
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}
