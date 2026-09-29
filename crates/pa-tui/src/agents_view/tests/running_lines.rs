//! The subagent summary lines: the scoped view, the header counts, and
//! the running/inactive pair under live transitions.

use super::*;

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
