//! The ctrl+x stop-or-delete family: the arm/execute grammar, the honest
//! no-effect reports, the re-arm/retirement rules, and the deleted row
//! the late catalog apply cannot resurrect.

use super::*;

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
    // rides the same row. The parent's ONE merged group already
    // carries the settled child (the merged line renders every
    // child, running or not), so the armed row stays visible through
    // the rebuild (the arm only rides a row the list still carries).
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
    // key; the hint reads the settled row's word. The parent's ONE
    // merged group keeps the settled child visible through the
    // rebuild, so the armed row stays rendered for the hint to ride.
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
        "Deleted session a deleted session",
        StatusTone::Muted,
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
        "Deleted session a deleted session",
        StatusTone::Muted,
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
        "Deleted session Some Other Name",
        StatusTone::Muted,
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
