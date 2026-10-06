//! The drill-down navigation: summary-row expansion, ancestor re-entry,
//! the scoped back key, and the unattachable child.

use super::*;

#[test]
fn enter_toggles_the_summary_row_and_drills_into_a_child() {
    let mut mode = mode_with_parent_and_child();
    mode.handle_key("down");
    assert_eq!(mode.rows[mode.selected].kind, RowKind::SubagentSummary);
    mode.handle_key("enter");
    assert_eq!(mode.rows.len(), 3);
    assert!(mode.rows[1].expanded);
    mode.handle_key("enter");
    assert_eq!(mode.rows.len(), 2);
    mode.handle_key("enter");
    mode.handle_key("down");
    assert_eq!(mode.rows[mode.selected].kind, RowKind::Subagent);
    mode.handle_key("enter");
    let opened = mode.opened.as_ref().expect("open recorded");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("c-live".to_string())
    );
    assert_eq!(opened.expanded_ancestors, vec!["p".to_string()]);
    assert_eq!(opened.rlm_depth, Some(1));
    assert!(!opened.has_children);
    assert!(!mode.running);
}

#[test]
fn pending_ancestors_expand_and_selection_restores_after_reentry() {
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
            remote_host: None,
        }),
        status_message: None,
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: serde_json::json!({}),
    });
    mode.roster = vec![
        roster_entry("p", "idle", &parent_summary("p")),
        roster_entry("c", "running", &child_summary("c", "p", "worker one")),
    ];
    mode.rebuild_rows();
    assert_eq!(mode.rows.len(), 3);
    assert!(mode.rows[1].expanded);
    assert_eq!(mode.rows[mode.selected].title, "worker one");
}

#[test]
fn scoped_left_returns_the_root_and_pops_the_scope() {
    let mut mode = scoped_mode(
        None,
        vec![
            roster_entry("p", "idle", &parent_summary("p")),
            roster_entry("c", "running", &child_summary("c", "p", "worker one")),
        ],
    );
    // The scoped view lists the direct child as a top-level row.
    assert!(mode.scope_active);
    assert_eq!(mode.rows.len(), 1);
    assert_eq!(mode.rows[0].kind, RowKind::Agent);
    mode.handle_key("left");
    assert!(mode.scope_popped);
    let opened = mode.opened.as_ref().expect("scope-back open");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("p-live".to_string())
    );
    assert!(opened.expanded_ancestors.is_empty());
}

#[test]
fn unattachable_child_opens_its_root_with_a_status() {
    let mut mode = mode_with_parent_and_child();
    // A finished child with no runtime and no file resolves to its top-level ancestor.
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
        .push(roster_entry("gc", "inactive", &unattachable));
    // The grandchild is roster-inactive under the running child: the ONE merged group nests it
    // under the child's own line — expand the parent's line first, then the child's (whose
    // identity is its parent-qualified `agent:` alias), so the row renders.
    mode.expanded_parents.insert("file:/x/p.jsonl".to_string());
    mode.rebuild_rows();
    let child_identity = mode
        .rows
        .iter()
        .find(|row| row.title == "worker one")
        .expect("the child row renders in the merged group")
        .identity
        .clone();
    mode.expanded_parents.insert(child_identity);
    mode.rebuild_rows();
    let grandchild = mode
        .rows
        .iter()
        .position(|row| row.title == "lost grandchild")
        .expect("grandchild row renders");
    mode.selected = grandchild;
    mode.handle_key("enter");
    let opened = mode.opened.as_ref().expect("open recorded");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("p-live".to_string())
    );
    assert_eq!(
        opened.status_message.as_deref(),
        Some("Child session is unavailable; opened its parent instead")
    );
}
