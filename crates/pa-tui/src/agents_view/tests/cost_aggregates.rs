//! The summary-line cost aggregate: the descendant-tree cost cell on
//! the ONE merged line, across the running, all-done, notice, and
//! click render paths.

use super::*;

/// The operator's 2026-09-26 ask carried by the ONE merged line
/// (2026-09-28): the collapsed summary row renders the
/// descendant-tree aggregate in the SAME Cost column the agent rows
/// bill — the right-aligned `${:.2}` cell, the Age column blank
/// behind it — and the merged line never unmounts (an all-done tree
/// keeps its row), so the aggregate always has a surface. TS renders
/// no cost on the summary row (`createSubagentSummaryRow` pins
/// `recursiveCost: 0`): the aggregate is a deliberate Rust
/// divergence.
#[test]
fn the_summary_line_renders_the_aggregate_in_the_cost_column() {
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
    assert_eq!(mode.rows[1].title, "4 subagents (2 running)");
    let (lines, _) = mode.render_frame(120, 36);
    let flat_lines: Vec<String> = lines.iter().map(flat).collect();
    let summary = flat_lines
        .iter()
        .find(|line| line.contains("4 subagents (2 running)"))
        .expect("the ONE line renders");
    let parent_line = flat_lines
        .iter()
        .find(|line| line.contains("p name"))
        .expect("parent row renders");
    let cost_at = summary.find("$4.75").expect("the aggregate prints");
    let parent_cost_at = parent_line.find("$5.00").expect("the parent total prints");
    assert_eq!(
        cost_at, parent_cost_at,
        "the aggregate shares the agent rows' Cost column"
    );
    assert!(
        summary.trim_end().ends_with("$4.75"),
        "the Age column stays blank behind the aggregate: {summary:?}"
    );
    // ONE line carries both statuses: no second per-status summary
    // row renders.
    assert_eq!(
        mode.rows
            .iter()
            .filter(|row| row.kind == RowKind::SubagentSummary)
            .count(),
        1,
        "the ONE merged line is the only summary row: {:?}",
        mode.rows
    );
}

/// A tree that spends nothing still prints its `$0.00` aggregate —
/// the cost cell rides the row, it is never a value-dependent
/// extra.
#[test]
fn the_summary_line_renders_zero_when_nothing_bills() {
    let mut mode = mode_with_parent_and_child();
    assert_eq!(mode.rows[1].title, "1 subagents (1 running)");
    let (lines, _) = mode.render_frame(120, 36);
    let summary = lines
        .iter()
        .map(flat)
        .find(|line| line.contains("1 subagents (1 running)"))
        .expect("the ONE line renders");
    assert!(
        summary.contains("$0.00"),
        "the zero aggregate prints in the Cost column: {summary:?}"
    );
}

/// The all-done state — the frame the operator actually inspects
/// after work completes: no descendant runs, and the ONE merged line
/// (which never unmounts — #2843's regression class: an aggregate on
/// a row that vanished when the children finished) carries the same
/// descendant-tree aggregate it billed mid-run. Its Cost cell prints
/// in the same right-aligned column, the Age column blank behind it.
#[test]
fn the_summary_line_renders_the_aggregate_in_the_all_done_state() {
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
    assert_eq!(
        mode.rows[1].title, "2 subagents (0 running)",
        "the ONE line keeps its row in the all-done state"
    );
    let (lines, _) = mode.render_frame(120, 36);
    let flat_lines: Vec<String> = lines.iter().map(flat).collect();
    let summary = flat_lines
        .iter()
        .find(|line| line.contains("2 subagents (0 running)"))
        .expect("the ONE line renders in the all-done state");
    let parent_line = flat_lines
        .iter()
        .find(|line| line.contains("p name"))
        .expect("parent row renders");
    let cost_at = summary.find("$2.00").expect("the aggregate prints");
    let parent_cost_at = parent_line.find("$2.25").expect("the parent total prints");
    assert_eq!(
        cost_at, parent_cost_at,
        "the summary line shares the agent rows' Cost column"
    );
    assert!(
        summary.trim_end().ends_with("$2.00"),
        "the Age column stays blank behind the aggregate: {summary:?}"
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
    let summary = text
        .iter()
        .find(|line| line.contains("1 subagents (0 running)"))
        .expect("the ONE line renders behind the notice");
    assert!(
        summary.contains("$1.25"),
        "the aggregate prints under the incident notice: {summary:?}"
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
    let summary = flat_lines
        .iter()
        .find(|line| line.contains("1 subagents (0 running)"))
        .expect("the ONE line renders");
    assert!(
        summary.contains("$1.25"),
        "the aggregate prints in the click-recorded frame: {summary:?}"
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
        "the click expanded the merged group"
    );
    let summary = flat_lines
        .iter()
        .find(|line| line.contains("1 subagents (0 running)"))
        .expect("the ONE line still renders expanded");
    assert!(
        summary.contains("$1.25"),
        "the aggregate stays on the expanded line: {summary:?}"
    );
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}
