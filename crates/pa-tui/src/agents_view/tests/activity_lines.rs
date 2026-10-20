//! The shells and factory-run lines: Enter on a line opens its node's session with the matching
//! panel requested, the line's identity carried for the return.

use super::*;
use crate::agents_view_forest::SessionActivity;
use crate::interactive::SessionPanel;

fn with_activity(mode: &mut AgentsViewMode, active: &str, shells: usize, factory_runs: usize) {
    mode.session_activity.insert(
        active.to_string(),
        SessionActivity {
            shells,
            factory_runs,
        },
    );
    mode.rebuild_rows();
}

fn select_title(mode: &mut AgentsViewMode, title: &str) {
    mode.selected = mode
        .rows
        .iter()
        .position(|row| row.title == title)
        .unwrap_or_else(|| panic!("no {title:?} row: {:?}", mode.rows));
}

#[test]
fn enter_on_the_shells_line_opens_the_node_with_the_shells_panel() {
    let mut mode = mode_with_parent_and_child();
    with_activity(&mut mode, "p-live", 2, 0);
    let (lines, _) = mode.render_frame(120, 36);
    let shells_line = lines
        .iter()
        .map(flat)
        .find(|line| line.contains("$ 2 shells"))
        .expect("the shells line renders");
    assert!(
        !shells_line.contains("$0.00"),
        "the line has no cost cell: {shells_line:?}"
    );
    select_title(&mut mode, "$ 2 shells");
    mode.handle_key("enter");
    let opened = mode.opened.as_ref().expect("open recorded");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("p-live".to_string())
    );
    assert_eq!(opened.panel, Some(SessionPanel::Shells { shell_id: None }));
    assert_eq!(opened.selected_row_identity, "shells:file:/x/p.jsonl");
    assert!(opened.expanded_ancestors.is_empty());
}

#[test]
fn enter_on_a_nested_factory_line_opens_the_child_with_the_factory_panel() {
    let mut mode = mode_with_parent_and_child();
    mode.expanded_parents.insert("file:/x/p.jsonl".to_string());
    with_activity(&mut mode, "c-live", 0, 1);
    select_title(&mut mode, "\u{2699} 1 factory run");
    mode.handle_key("enter");
    let opened = mode.opened.as_ref().expect("open recorded");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("c-live".to_string())
    );
    assert_eq!(opened.panel, Some(SessionPanel::FactoryRuns));
    assert_eq!(opened.expanded_ancestors, vec!["p".to_string()]);
}

/// Each node's child lines sit one indent step past its row: the session's at column 4, an
/// expanded subagent's at column 8.
#[test]
fn child_lines_sit_one_indent_step_past_their_row() {
    let mut mode = mode_with_parent_and_child();
    mode.expanded_parents.insert("file:/x/p.jsonl".to_string());
    with_activity(&mut mode, "p-live", 2, 0);
    with_activity(&mut mode, "c-live", 1, 0);
    let (lines, _) = mode.render_frame(120, 36);
    let column = |needle: &str| {
        lines
            .iter()
            .map(flat)
            .find_map(|line| line.find(needle).map(|at| line[..at].chars().count()))
            .unwrap_or_else(|| panic!("no {needle:?} line"))
    };
    assert_eq!(
        [
            column("\u{2022} p name"),
            column("\u{25be} 1 subagent"),
            column("worker one"),
            column("$ 1 shell"),
            column("$ 2 shells"),
        ],
        [0, 4, 6, 8, 4]
    );
}
