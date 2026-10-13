//! The subagent summary line: the scoped view, the header counts, and
//! the ONE merged line under live transitions.

use super::*;

#[test]
fn scoped_view_keeps_the_first_row_default() {
    let mut mode = scoped_mode(
        Some("p"),
        vec![
            roster_entry("p", "idle", &parent_summary("p")),
            roster_entry("c", "running", &child_summary("c", "p", "worker one")),
        ],
    );
    assert_eq!(mode.rows.len(), 1, "the scope root is excluded");
    assert_eq!(mode.selected, 0);
    assert_eq!(mode.rows[0].summary["sessionId"], "c");
    assert!(mode.anchor_selection_pending, "the wait never resolves");
    mode.handle_key("enter");
    let opened = mode
        .opened
        .expect("the scoped view opens despite the never-resolving wait");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("c-live".to_string())
    );
}

/// A scoped view whose scope root has no children (the all-zero dock's
/// Subagents destination): the roster carries the root alone.
fn childless_scope() -> AgentsViewMode {
    scoped_mode(
        Some("p"),
        vec![roster_entry("p", "idle", &parent_summary("p"))],
    )
}

/// A childless scope is an empty view that keeps its keys: the TS-identical empty-state row
/// renders, search drives the no-match row, and every route out stays intact.
#[test]
fn a_childless_scope_is_an_empty_view_that_keeps_its_keys() {
    let mut mode = childless_scope();
    assert!(mode.scope_active && !mode.scope_dropped);
    assert_eq!(mode.rows, Vec::<AgentsViewRow>::new());
    let (lines, _) = mode.render_frame(120, 36);
    let frame = lines.iter().map(flat).collect::<Vec<_>>().join("\n");
    assert!(frame.contains("No sessions yet."), "frame: {frame}");
    mode.handle_key("z");
    assert_eq!(mode.query, "z");
    let (lines, _) = mode.render_frame(120, 36);
    let frame = lines.iter().map(flat).collect::<Vec<_>>().join("\n");
    assert!(
        frame.contains("No sessions match your search."),
        "frame: {frame}"
    );
    mode.handle_key("enter");
    assert!(mode.opened.is_none() && mode.running);
    mode.handle_key("escape");
    assert_eq!(mode.query, "");
    mode.handle_key("escape");
    let opened = mode
        .opened
        .as_ref()
        .expect("escape reopened the scope root");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("p-live".to_string())
    );
    assert!(mode.scope_back && !mode.scope_popped && !mode.running);
    let mut mode = childless_scope();
    mode.handle_key("ctrl+d");
    assert!(!mode.running && mode.opened.is_none());
    // ctrl+n dispatches the new-session action from the empty view too
    // (the binding's whole-object shape is pinned in the key_bindings
    // family's scoped test).
    let mut mode = childless_scope();
    mode.handle_key("ctrl+n");
    assert!(!mode.running && mode.opened.is_some());
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
    assert!(
        header.contains("agents 0 running, 1 idle, 0 inactive"),
        "header: {header}"
    );
}

#[test]
fn alt_right_toggles_the_subagent_list() {
    let mut mode = mode_with_parent_and_child();
    assert_eq!(mode.rows.len(), 2);
    assert_eq!(mode.rows[1].kind, RowKind::SubagentSummary);
    assert!(!mode.rows[1].expanded);
    mode.handle_key("alt+right");
    assert_eq!(mode.rows.len(), 3);
    assert!(mode.rows[1].expanded);
    assert_eq!(mode.rows[2].kind, RowKind::Subagent);
    assert_eq!(mode.rows[2].depth, 1);
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
        create_config: serde_json::json!({}),
    });
    mode.roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("r1", "running", &child_summary("r1", "p", "runner one")),
        roster_entry("r2", "running", &child_summary("r2", "p", "runner two")),
        roster_entry("i1", "idle", &child_summary("i1", "p", "old worker one")),
        roster_entry("i2", "idle", &child_summary("i2", "p", "old worker two")),
    ];
    mode.rebuild_rows();
    mode
}

/// The operator's 2026-09-28 one-dropdown directive: Enter on the ONE line expands to the
/// FULL roster in one group, the runners first.
#[test]
fn enter_expands_the_one_line_to_the_full_roster_running_first() {
    let mut mode = mode_with_mixed_children();
    assert_eq!(mode.rows.len(), 2);
    assert_eq!(mode.rows[1].title, "4 subagents (2 running)");
    assert_eq!(mode.rows[1].identity, "subagents:file:/x/p.jsonl");
    mode.handle_key("down");
    mode.handle_key("enter");
    assert_eq!(mode.rows.len(), 6);
    assert!(mode.rows[1].expanded);
    assert!(
        mode.rows[2..4]
            .iter()
            .all(|row| row.title.starts_with("runner")),
        "the runners render FIRST: {rows:?}",
        rows = mode.rows
    );
    assert!(
        mode.rows[4..6]
            .iter()
            .all(|row| row.title.starts_with("old worker")),
        "the historical workers follow in the SAME group: {rows:?}",
        rows = mode.rows
    );
    mode.handle_key("enter");
    assert_eq!(mode.rows.len(), 2);
    assert!(!mode.rows[1].expanded);
    let mut mode = mode_with_mixed_children();
    mode.handle_key("alt+right");
    assert_eq!(mode.rows.len(), 6);
    assert!(mode.rows[1].expanded, "alt+right opens the ONE line");
}

/// Live transitions (roster pushes): a child flipping running to idle STAYS in the merged
/// group, the ONE line's counts update, the selection never resets.
#[test]
fn live_transitions_update_the_one_line_and_keep_the_selection() {
    let mut mode = mode_with_mixed_children();
    mode.handle_key("down");
    mode.handle_key("enter");
    mode.handle_key("down");
    assert_eq!(mode.rows[mode.selected].title, "runner one");
    let selected_identity = mode.rows[mode.selected].identity.clone();
    let idle_flip = roster_entry("r1", "idle", &child_summary("r1", "p", "runner one"));
    mode.apply_roster_update(vec![idle_flip], Vec::new(), false);
    let line = mode
        .rows
        .iter()
        .find(|row| row.kind == RowKind::SubagentSummary)
        .expect("the ONE line");
    assert_eq!(line.title, "4 subagents (1 running)");
    assert!(line.expanded, "the line stays open through the flip");
    let settled = mode
        .rows
        .iter()
        .find(|row| row.identity == selected_identity)
        .expect("the settled runner keeps its row in the group");
    assert_ne!(settled.section, Section::Running, "the section flipped");
    assert_eq!(
        mode.rows[mode.selected].identity, selected_identity,
        "the selection stays on the session it followed"
    );
    let running_flip = roster_entry("r1", "running", &child_summary("r1", "p", "runner one"));
    mode.apply_roster_update(vec![running_flip], Vec::new(), false);
    let line = mode
        .rows
        .iter()
        .find(|row| row.kind == RowKind::SubagentSummary)
        .expect("the ONE line");
    assert_eq!(line.title, "4 subagents (2 running)");
    assert!(mode
        .rows
        .iter()
        .any(|row| row.identity == selected_identity && row.section == Section::Running));
    assert_eq!(mode.rows[mode.selected].identity, selected_identity);
}

/// The rendered frame carries the ONE summary line: the full-roster count with the running
/// parenthetical — no per-status pair, no second line.
#[test]
fn frame_renders_the_one_line() {
    let mut grandchild = child_summary("gc", "c", "grandkid");
    grandchild["rlmChildId"] = serde_json::json!("child-gc");
    let mut mode = mode_with_parent_and_child();
    mode.roster.push(roster_entry("gc", "running", &grandchild));
    mode.roster.push(roster_entry(
        "i1",
        "idle",
        &child_summary("i1", "p", "old worker"),
    ));
    mode.rebuild_rows();
    assert_eq!(mode.rows.len(), 2, "the parent and its ONE line");
    assert_eq!(mode.rows[1].title, "3 subagents (2 running)");
    let (lines, _) = mode.render_frame(120, 36);
    let frame = lines.iter().map(flat).collect::<Vec<_>>().join("\n");
    assert!(
        frame.contains("\u{25b8} 3 subagents (2 running)"),
        "frame: {frame}"
    );
    assert!(
        !frame.contains("inactive subagent"),
        "no second per-status line: {frame}"
    );
    assert!(
        !frame.contains(", 2 running"),
        "no `direct, nested` pair: {frame}"
    );
}
