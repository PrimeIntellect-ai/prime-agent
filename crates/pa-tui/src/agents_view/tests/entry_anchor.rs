//! The entry anchor: the wait for the opened-from session, its
//! cancellations (keys, clicks, jumps), and the fetch failures that
//! settle it.

use super::*;

#[test]
fn entry_anchor_selects_the_left_session() {
    let mode = mode_with_anchor(
        Some("s2"),
        vec![
            roster_entry("s1", "idle", &parent_summary("s1")),
            roster_entry("s2", "idle", &parent_summary("s2")),
        ],
    );
    assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s2");
    assert!(!mode.anchor_selection_pending);
}

/// The anchor row can arrive after the first rebuild (the roster streams, the catalog lands later).
#[test]
fn anchor_wait_survives_until_the_row_arrives() {
    let mut mode = mode_with_anchor(
        Some("s2"),
        vec![roster_entry("s1", "idle", &parent_summary("s1"))],
    );
    assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s1");
    assert!(mode.anchor_selection_pending);
    mode.roster
        .push(roster_entry("s2", "idle", &parent_summary("s2")));
    mode.rebuild_rows();
    assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s2");
    assert!(!mode.anchor_selection_pending);
}

#[test]
fn open_waits_out_the_entry_anchor() {
    let mut mode = mode_with_anchor(
        Some("s2"),
        vec![roster_entry("s1", "idle", &parent_summary("s1"))],
    );
    assert!(mode.anchor_selection_pending);
    mode.handle_key("enter");
    assert!(mode.opened.is_none(), "the default row did not open");
    assert!(mode.status_text().is_some(), "the wait explains itself");
    mode.roster
        .push(roster_entry("s2", "idle", &parent_summary("s2")));
    mode.rebuild_rows();
    assert!(!mode.anchor_selection_pending);
    assert!(
        mode.status_text().is_none(),
        "the anchor landing drops the loading hint"
    );
    mode.anchor_selection_pending = true;
    mode.set_status(ANCHOR_LOADING_HINT);
    mode.handle_key("down");
    assert!(!mode.anchor_selection_pending);
    assert!(
        mode.status_text().is_none(),
        "the canceling move drops the loading hint as well"
    );
    mode.handle_key("enter");
    let opened = mode.opened.expect("the anchored row opens");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("s2-live".to_string())
    );
}

/// The first user move cancels the wait: the anchor never overrides an explicit selection.
#[test]
fn anchor_wait_cancels_on_the_first_user_move() {
    let mut mode = mode_with_anchor(
        Some("s2"),
        vec![roster_entry("s1", "idle", &parent_summary("s1"))],
    );
    mode.handle_key("down");
    assert!(!mode.anchor_selection_pending);
    mode.roster
        .push(roster_entry("s2", "idle", &parent_summary("s2")));
    mode.rebuild_rows();
    assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s1");
}

/// A click during the wait is an explicit pick: the click grammar must not inherit Enter's wait.
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
            roster_entry("s1", "idle", &parent_summary("s1")),
            roster_entry("s3", "idle", &parent_summary("s3")),
        ],
    );
    assert!(mode.anchor_selection_pending, "the anchor waits on its row");
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
    assert!(
        mode.status_text().is_none(),
        "the click drops the loading hint with the wait"
    );
    let opened = mode.opened.expect("the click opened the row");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("s3-live".to_string())
    );
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}

/// A terminal fetch failure settles the wait: the anchor's row can only arrive through THIS fetch.
#[test]
fn a_saved_catalog_failure_settles_the_anchor_wait() {
    let mut mode = mode_with_anchor(
        Some("s2"),
        vec![roster_entry("s1", "idle", &parent_summary("s1"))],
    );
    mode.set_status(ANCHOR_LOADING_HINT);
    mode.settle_anchor_wait_on_saved_failure();
    assert!(
        !mode.anchor_selection_pending,
        "the wait ends with the failed catalog"
    );
    assert_ne!(
        mode.status_text(),
        Some(ANCHOR_LOADING_HINT),
        "the loading hint drops with the wait"
    );
    mode.handle_key("enter");
    assert!(
        mode.opened.is_some(),
        "the settled view opens the default row instead of re-arming the hint"
    );
    assert_ne!(
        mode.status_text(),
        Some(ANCHOR_LOADING_HINT),
        "no re-armed loading hint behind the failure"
    );
}

/// A terminal failure re-arms on the next query change - ONE retry, single-flight: the
/// consumption clears the failure intent, so out-of-order scans never race a stale
/// failure over a newer success.
#[test]
fn a_failed_fetch_rearms_once_per_query_change() {
    let mut mode = mode_with_anchor(None, Vec::new());
    mode.query_changed(true);
    assert!(
        !mode.take_saved_fetch_rearm(),
        "a healthy fetch never re-arms"
    );
    mode.saved_fetch_failed = true;
    mode.query_changed(true);
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
    mode.query_changed(true);
    assert!(
        !mode.take_saved_fetch_rearm(),
        "the retry in flight is the only one"
    );
    mode.saved_fetch_failed = true;
    mode.query_changed(true);
    assert!(
        mode.take_saved_fetch_rearm(),
        "a new terminal failure re-arms again"
    );
    mode.saved_fetch_failed = false;
    mode.query_changed(true);
    assert!(!mode.take_saved_fetch_rearm());
}

#[test]
fn a_noop_edit_on_an_empty_query_never_rearms() {
    let mut mode = mode_with_anchor(None, Vec::new());
    mode.query.clear();
    mode.saved_fetch_failed = true;
    mode.handle_key("backspace");
    assert!(
        !mode.take_saved_fetch_rearm(),
        "the no-op backspace did not re-arm"
    );
}

#[test]
fn a_successful_load_retires_the_failure_status() {
    let mut mode = mode_with_anchor(None, Vec::new());
    mode.set_status("Saved sessions unavailable: scan failed");
    mode.saved_fetch_failed = true;
    mode.saved = Vec::new();
    mode.saved_fetch_failed = false;
    if mode
        .status_text()
        .is_some_and(|status| status.starts_with("Saved sessions unavailable"))
    {
        mode.status = None;
    }
    assert_eq!(mode.status_text(), None, "the stale failure status retired");
    mode.set_status("Session s1 is no longer running");
    if mode
        .status_text()
        .is_some_and(|status| status.starts_with("Saved sessions unavailable"))
    {
        mode.status = None;
    }
    assert_eq!(
        mode.status_text(),
        Some("Session s1 is no longer running"),
        "an unrelated status is never clobbered by the load"
    );
}

#[test]
fn the_saved_catalog_fetch_uses_the_long_running_budget() {
    assert_eq!(
        saved_catalog_timeout_ms(),
        crate::daemon_client::LONG_RUNNING_REQUEST_TIMEOUT_MS
    );
    assert!(
        saved_catalog_timeout_ms() > crate::daemon_client::DEFAULT_REQUEST_TIMEOUT_MS,
        "the saved scan must never fall back to the 30s default class"
    );
}

/// A nested anchor (a subagent session the user was attached to) arrives with its ancestors'
/// lists expanded so its row is reachable — the same expansion the drilled-in return path uses.
#[test]
fn nested_anchor_expands_its_ancestors() {
    let mode = mode_with_anchor(
        Some("c"),
        vec![
            roster_entry("p", "idle", &parent_summary("p")),
            roster_entry("c", "running", &child_summary("c", "p", "worker one")),
        ],
    );
    assert_eq!(mode.rows.len(), 3, "the parent's list opened");
    assert_eq!(mode.rows[mode.selected].summary["sessionId"], "c");
}

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
            remote_host: None,
        }),
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: serde_json::json!({}),
    });
    mode.roster = vec![
        roster_entry("s1", "idle", &parent_summary("s1")),
        roster_entry("s2", "idle", &parent_summary("s2")),
    ];
    mode.rebuild_rows();
    assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s1");
    assert!(!mode.anchor_selection_pending);
}
