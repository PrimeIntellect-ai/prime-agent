//! Factory-child state markers in the agents view.

use super::*;

#[test]
fn factory_child_rows_show_their_run_and_state_marker() {
    let mut mode = mode_with_parent_and_child();
    mode.expanded_parents.insert("file:/x/p.jsonl".to_string());
    mode.machine_children
        .insert("child-c".to_string(), "review-loop/reviewing".to_string());
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
    assert_eq!(text, "  in factory: review-loop/reviewing");
}
