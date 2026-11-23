//! Factory-child state markers in the agents view.

use super::*;

use super::super::session_activity::{ActivityRead, MachineMarker};

#[test]
fn factory_child_rows_show_their_run_and_state_marker() {
    let mut mode = mode_with_parent_and_child();
    mode.expanded_parents.insert("file:/x/p.jsonl".to_string());
    mode.machine_children.insert(
        "child-c".to_string(),
        MachineMarker {
            session: "p-live".to_string(),
            label: "review-loop/reviewing".to_string(),
        },
    );
    mode.rebuild_rows();
    let child = mode
        .rows
        .iter()
        .find(|row| row.title == "worker one")
        .expect("the child row is visible");

    let text = mode
        .render_note_details(child, 120)
        .iter()
        .map(flat)
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(text, "  in machine: review-loop/reviewing");
}

/// A failed graph read keeps the session's last markers, like its factory count; a successful
/// read with no runs clears them.
#[test]
fn a_failed_graph_read_keeps_the_last_machine_markers() {
    let mut mode = mode_with_parent_and_child();
    let read = |machine_children| ActivityRead {
        active_session_id: "p-live".to_string(),
        shells: None,
        factory: None,
        machine_children,
    };
    let marker = MachineMarker {
        session: "p-live".to_string(),
        label: "review-loop/reviewing".to_string(),
    };
    mode.apply_session_activity(vec![read(Some(vec![(
        "child-c".to_string(),
        marker.label.clone(),
    )]))]);
    mode.apply_session_activity(vec![read(None)]);
    assert_eq!(
        mode.machine_children,
        std::collections::HashMap::from([("child-c".to_string(), marker)])
    );
    mode.apply_session_activity(vec![read(Some(Vec::new()))]);
    assert_eq!(mode.machine_children, std::collections::HashMap::new());
}
