//! The summary-line cost aggregate: the descendant-tree cost cell across
//! the running line, the all-done inactive line, and the notice/click
//! render paths.

use super::*;

/// The operator's 2026-09-26 ask: BOTH collapsed summary lines render
/// the descendant-tree aggregate in the SAME Cost column the agent
/// rows bill — the right-aligned `${:.2}` cell, the Age column blank
/// behind it. The running line first, then the follow-up: an all-done
/// tree renders no running line, so the inactive line carries the same
/// aggregate. TS renders no cost on the summary row
/// (`createSubagentSummaryRow` pins `recursiveCost: 0`): the
/// aggregate is a deliberate Rust divergence.
#[test]
fn running_line_renders_the_aggregate_in_the_cost_column() {
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
    assert_eq!(mode.rows[1].title, "1, 1 running");
    let (lines, _) = mode.render_frame(120, 36);
    let flat_lines: Vec<String> = lines.iter().map(flat).collect();
    let running = flat_lines
        .iter()
        .find(|line| line.contains("1, 1 running"))
        .expect("running line renders");
    let parent_line = flat_lines
        .iter()
        .find(|line| line.contains("p name"))
        .expect("parent row renders");
    let cost_at = running.find("$4.75").expect("the aggregate prints");
    let parent_cost_at = parent_line.find("$5.00").expect("the parent total prints");
    assert_eq!(
        cost_at, parent_cost_at,
        "the aggregate shares the agent rows' Cost column"
    );
    assert!(
        running.trim_end().ends_with("$4.75"),
        "the Age column stays blank behind the aggregate: {running:?}"
    );
    // The inactive line bills the SAME descendant tree aggregate at
    // the same right-aligned column (the operator's follow-up: the
    // aggregate must stay visible in the all-done state, where no
    // running line renders), Age blank behind it.
    let inactive = flat_lines
        .iter()
        .find(|line| line.contains("inactive subagents"))
        .expect("inactive line renders");
    let inactive_cost_at = inactive
        .find("$4.75")
        .expect("the inactive aggregate prints");
    assert_eq!(
        inactive_cost_at, cost_at,
        "the inactive line shares the agent rows' Cost column"
    );
    assert!(
        inactive.trim_end().ends_with("$4.75"),
        "the Age column stays blank behind the inactive aggregate: {inactive:?}"
    );
}

/// A tree that spends nothing still prints its `$0.00` aggregate —
/// the cost cell rides the row, it is never a value-dependent
/// extra.
#[test]
fn running_line_renders_zero_when_nothing_bills() {
    let mut mode = mode_with_parent_and_child();
    assert_eq!(mode.rows[1].title, "1, 0 running");
    let (lines, _) = mode.render_frame(120, 36);
    let running = lines
        .iter()
        .map(flat)
        .find(|line| line.contains("1, 0 running"))
        .expect("running line renders");
    assert!(
        running.contains("$0.00"),
        "the zero aggregate prints in the Cost column: {running:?}"
    );
}

/// The all-done state — the frame the operator actually inspects
/// after work completes: no descendant runs, so NO running line
/// renders and the inactive line is the only summary row. Its Cost
/// cell carries the same descendant-tree aggregate the running line
/// billed mid-run (#2843's regression: the aggregate rode a row
/// that vanished the moment the children finished, and the
/// full-width unbilled inactive line left the Cost column blank
/// behind it).
#[test]
fn inactive_line_renders_the_aggregate_in_the_all_done_state() {
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
    assert!(
        !mode.rows.iter().any(|row| row.title.contains("running")),
        "no running line renders when nothing runs"
    );
    let (lines, _) = mode.render_frame(120, 36);
    let flat_lines: Vec<String> = lines.iter().map(flat).collect();
    let inactive = flat_lines
        .iter()
        .find(|line| line.contains("2 inactive subagents"))
        .expect("the inactive line renders");
    let parent_line = flat_lines
        .iter()
        .find(|line| line.contains("p name"))
        .expect("parent row renders");
    let cost_at = inactive.find("$2.00").expect("the aggregate prints");
    let parent_cost_at = parent_line.find("$2.25").expect("the parent total prints");
    assert_eq!(
        cost_at, parent_cost_at,
        "the inactive line shares the agent rows' Cost column"
    );
    assert!(
        inactive.trim_end().ends_with("$2.00"),
        "the Age column stays blank behind the aggregate: {inactive:?}"
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
    let inactive = text
        .iter()
        .find(|line| line.contains("1 inactive subagent"))
        .expect("the inactive line renders behind the notice");
    assert!(
        inactive.contains("$1.25"),
        "the aggregate prints under the incident notice: {inactive:?}"
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
    let inactive = flat_lines
        .iter()
        .find(|line| line.contains("1 inactive subagent"))
        .expect("the inactive line renders");
    assert!(
        inactive.contains("$1.25"),
        "the aggregate prints in the click-recorded frame: {inactive:?}"
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
        "the click expanded the inactive list"
    );
    let inactive = flat_lines
        .iter()
        .find(|line| line.contains("1 inactive subagent"))
        .expect("the inactive line still renders expanded");
    assert!(
        inactive.contains("$1.25"),
        "the aggregate stays on the expanded line: {inactive:?}"
    );
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}
