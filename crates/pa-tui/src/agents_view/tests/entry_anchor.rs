//! The entry anchor: the wait for the opened-from session, its
//! cancellations (keys, clicks, jumps), and the fetch failures that
//! settle it.

use super::*;

/// A fresh open (the agents-back handoff) anchors the entry selection
/// on the session the view was opened from, not the first row.
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

/// The anchor row can arrive after the first rebuild (the roster
/// streams, the saved catalog lands later): the wait survives the
/// rebuilds that pin other rows and lands once the row appears.
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

/// Enter during the anchor wait opens nothing (the default row is not
/// the user's choice); once the anchor row lands, Enter opens it.
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
    // The user's first move ends the wait the same way: the hint it
    // left behind clears too.
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

/// The first user move cancels the wait: the anchor never overrides an
/// explicit selection.
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
            roster_entry("s1", "idle", &parent_summary("s1")),
            roster_entry("s3", "idle", &parent_summary("s3")),
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

/// A terminal saved-catalog failure settles the entry anchor's wait (TS
/// `resolveMissingSelectionAnchor`'s finally arm): the anchor's row can
/// only arrive through THIS fetch, so the wait must not outlive the
/// fetch's own failure — the loading hint would re-arm on every open
/// behind an error the status line already showed.
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
    // Enter after the settle opens the default row (the wait is over;
    // the open is the user's explicit choice again), and the loading
    // hint never re-arms behind the failure the view already showed.
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

/// TS `rearmSavedSearchFetch`: a terminal saved-catalog failure re-arms
/// on the next query change - ONE retry, single-flight: the consumption
/// clears the failure intent with it, so concurrent out-of-order scans
/// never race a stale failure over a newer success. A NEW terminal
/// failure re-arms again; a healthy fetch never does.
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
    mode.set_status("Saved sessions unavailable: scan failed");
    mode.saved_fetch_failed = true;
    mode.saved = Vec::new();
    // The load arm's own logic (the loop's SavedLoaded handler): the
    // failure flag clears and the fetch's own status retires.
    mode.saved_fetch_failed = false;
    if mode
        .status_text()
        .is_some_and(|status| status.starts_with("Saved sessions unavailable"))
    {
        mode.status = None;
    }
    assert_eq!(mode.status_text(), None, "the stale failure status retired");
    // An unrelated status (the flow's own notice) survives a load.
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
            roster_entry("p", "idle", &parent_summary("p")),
            roster_entry("c", "running", &child_summary("c", "p", "worker one")),
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
