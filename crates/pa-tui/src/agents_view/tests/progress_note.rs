//! The selected agent row's progress-note expansion and its viewport
//! behavior.

use super::*;

fn note_into(mode: &mut AgentsViewMode, index: usize, note: &str) {
    mode.rows[index]
        .summary
        .as_object_mut()
        .expect("row summary is an object")
        .insert("progressNote".to_string(), serde_json::json!(note));
}

fn flat_lines(mode: &mut AgentsViewMode, width: usize, max_rows: usize) -> Vec<String> {
    mode.render_list(width, max_rows, 0)
        .iter()
        .map(flat)
        .collect()
}

fn note_line_count(lines: &[String]) -> usize {
    lines
        .iter()
        .filter(|line| line.starts_with("  word"))
        .count()
}

/// The selected row expands its note under it; unselected rows never expand.
#[test]
fn the_selected_row_expands_its_wrapped_note() {
    let (mut mode, index) = mode_with_row("worker", "mock-1");
    note_into(&mut mode, index, "running   the\n final gate  suite");
    mode.selected = index;
    let lines = flat_lines(&mut mode, 60, 30);
    let worker_row = lines
        .iter()
        .position(|line| line.contains("worker"))
        .expect("the worker row renders");
    assert_eq!(
        lines[worker_row + 1].trim(),
        "running the final gate suite",
        "the note line renders collapsed under the row: {lines:?}"
    );
    assert_eq!(
        &lines[worker_row + 1][..2],
        "  ",
        "the note indents to the title column: {lines:?}"
    );
    assert_eq!(lines.len(), worker_row + 2, "no further lines: {lines:?}");
    let rendered = mode.render_list(60, 30, 0);
    let dim = mode.theme.fg_style(ThemeColor::Dim);
    assert!(
        rendered[worker_row + 1]
            .iter()
            .all(|span| span.style == dim),
        "the note renders dim"
    );
    mode.selected = 0;
    let lines = flat_lines(&mut mode, 60, 30);
    assert!(
        !lines.iter().any(|line| line.contains("gate")),
        "an unselected row never expands: {lines:?}"
    );
}

/// A long note wraps within the width, keeps the indent, and carries the
/// whole text.
#[test]
fn a_long_note_wraps_within_the_width() {
    let (mut mode, index) = mode_with_row("worker", "mock-1");
    let note = (0..30)
        .map(|n| format!("word{n}"))
        .collect::<Vec<_>>()
        .join(" ");
    note_into(&mut mode, index, &note);
    mode.selected = index;
    let width = 40;
    let lines = flat_lines(&mut mode, width, 40);
    let worker_row = lines
        .iter()
        .position(|line| line.contains("worker"))
        .expect("the worker row renders");
    let note_lines: Vec<&String> = lines[worker_row + 1..]
        .iter()
        .take_while(|line| line.starts_with("  word"))
        .collect();
    assert!(note_lines.len() > 1, "the note wrapped: {note_lines:?}");
    for line in &note_lines {
        assert!(str_width(line) <= width, "a line overran: {line:?}");
        assert!(line.starts_with("  "), "a line lost the indent: {line:?}");
    }
    let joined = note_lines
        .iter()
        .map(|line| line.trim())
        .collect::<Vec<_>>()
        .join(" ");
    assert_eq!(joined, note, "the wrapped lines carry the whole note");
}

/// A short pane keeps the selected row plus the note lines that fit.
#[test]
fn a_short_pane_keeps_the_row_and_the_fitting_note_lines() {
    let (mut mode, index) = mode_with_row("worker", "mock-1");
    let note = (0..30)
        .map(|n| format!("word{n}"))
        .collect::<Vec<_>>()
        .join(" ");
    note_into(&mut mode, index, &note);
    mode.selected = index;
    let mut third = mode.rows[index].clone();
    third.identity = "third".to_string();
    third.title = "third".to_string();
    mode.rows.push(third);
    let full_count = note_line_count(&flat_lines(&mut mode, 60, 40));
    assert!(full_count > 1, "the note wraps: {full_count}");
    let lines = flat_lines(&mut mode, 60, 7);
    assert!(
        lines.iter().any(|line| line.contains("worker")),
        "the selected row stays visible: {lines:?}"
    );
    let shown = note_line_count(&lines);
    assert!(shown > 0, "the note lines ride the window: {lines:?}");
    assert!(
        shown < full_count,
        "the overflow clips behind the ellipsis: shown {shown} of {full_count}: {lines:?}"
    );
    assert_eq!(
        lines.last().expect("a trailing line").trim(),
        "...",
        "the trailing ellipsis covers the clip: {lines:?}"
    );
    assert!(
        !lines.iter().any(|line| line.contains("third")),
        "a below-the-fold row gives way to the note lines: {lines:?}"
    );
}

/// A top-section selection with a note taller than the viewport shifts
/// the slice past the section heading; the clipped heading still gets
/// its leading `...`.
#[test]
fn a_top_row_with_a_tall_note_keeps_the_leading_ellipsis() {
    let (mut mode, index) = mode_with_row("worker", "mock-1");
    let note = (0..40)
        .map(|n| format!("word{n}"))
        .collect::<Vec<_>>()
        .join(" ");
    note_into(&mut mode, index, &note);
    mode.selected = index;
    let lines = flat_lines(&mut mode, 60, 7);
    let worker_row = lines
        .iter()
        .position(|line| line.contains("worker"))
        .expect("the selected row stays visible: {lines:?}");
    assert!(
        worker_row > 2,
        "the worker row must sit under the header rows: {lines:?}"
    );
    assert_eq!(
        lines[worker_row - 1].trim(),
        "...",
        "the leading ellipsis marks the clipped heading: {lines:?}"
    );
}

/// The note lines are no click targets; rows below still click their own
/// rows.
#[test]
fn rows_below_the_expansion_still_click_their_own_rows() {
    let (mut mode, index) = mode_with_row("worker", "mock-1");
    note_into(&mut mode, index, "one note line");
    mode.selected = index;
    let mut third = mode.rows[index].clone();
    third.identity = "third".to_string();
    third.title = "third".to_string();
    mode.rows.push(third);
    mode.render_list(60, 30, 0);
    let mut clicks = mode.click_rows.clone();
    clicks.sort_unstable();
    assert_eq!(
        clicks.len(),
        3,
        "the note line is no click target: {clicks:?}"
    );
    let row_targets: Vec<usize> = clicks.iter().map(|(_, row)| *row).collect();
    assert_eq!(row_targets, [0, 1, 2]);
    let lines = flat_lines(&mut mode, 60, 30);
    for (position, row) in clicks {
        assert!(
            lines[position].contains(&mode.rows[row].title),
            "click position {position} must sit on row {row}: {lines:?}"
        );
    }
}

/// Summary rows never expand, even when their summary carries the note.
#[test]
fn summary_rows_never_expand_a_note() {
    let (mut mode, index) = mode_with_row("worker", "mock-1");
    mode.rows[index].kind = RowKind::SubagentSummary;
    mode.rows[index].identity = "subagents:worker".to_string();
    mode.rows[index].parent_identity = Some("holder".to_string());
    mode.rows[index].depth = 1;
    note_into(&mut mode, index, "a note that must not render");
    mode.selected = index;
    let lines = flat_lines(&mut mode, 60, 30);
    assert!(
        lines.iter().any(|line| line.contains("\u{25b8} worker")),
        "the summary row renders nested: {lines:?}"
    );
    assert!(
        !lines.iter().any(|line| line.contains("must not render")),
        "a summary row never expands: {lines:?}"
    );
}
