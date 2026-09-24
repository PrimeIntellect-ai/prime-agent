//! Reference renderer for full-object differential tests: a second,
//! independent implementation of the refinement row whose output must
//! byte-match the production traversal at every width and detail level.
//! The expanded block hangs off the `◆` header on the `╰─ ` gutter with
//! continuation rows at the branch depth (the parity note lives in
//! `docs/FEATURE_PARITY.md`).
use super::*;

pub(crate) fn render_refinement_outcome(
    row: &RefinementOutcomeRow,
    detail: Detail,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let mut out = vec![spacer()];
    let header = text_rows(
        vec![Span::styled(
            format!("\u{25c6} {}", row.header),
            theme.fg_style(ThemeColor::RefinementHeader),
        )],
        width,
    );
    out.extend(header);
    let summary = if row.summary.trim().is_empty() {
        "No summary was recorded for this harness change."
    } else {
        row.summary.trim()
    };
    // TS `ExpandableEventMessage.addSummary`: the summary follows the
    // component's `setExpanded` state (`toolOutputExpanded`), not the
    // edit-diffs toggle. Expanded hangs on the branch grammar.
    out.extend(event_summary_rows(
        summary,
        detail.tool_output_expanded(),
        ThemeColor::RefinementSummary,
        theme,
        width,
    ));
    if detail.tool_output_expanded() {
        out.push(spacer());
        out.extend(continuation_rows_over(
            vec![Span::styled(
                row.meta.clone(),
                theme.fg_style(ThemeColor::Dim),
            )],
            width,
        ));
        for edit in &row.edits {
            out.push(spacer());
            out.extend(edit_section_rows(edit, theme, width));
        }
    }
    out
}

/// The summary row set: collapsed keeps the TS `EventSummary` shape
/// (whitespace-collapsed, `width - 1`, one-column inset inside the styled
/// span, clamped to two lines); expanded hangs on the branch gutter.
fn event_summary_rows(
    summary: &str,
    expanded: bool,
    color: ThemeColor,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let text = if expanded {
        summary.to_string()
    } else {
        summary.split_whitespace().collect::<Vec<_>>().join(" ")
    };
    if expanded {
        let rows = branch_rows_over(
            vec![Span::styled(text, theme.fg_style(color))],
            theme,
            width,
        );
        return rows;
    }
    let content_width = width.saturating_sub(1).max(1);
    let style = theme.fg_style(color);
    let mut lines: Vec<Line> = Vec::new();
    for source in text.split('\n') {
        let plain: Line = vec![Span::raw(source.to_string())];
        lines.extend(wrap_line(&plain, content_width));
    }
    if lines.is_empty() {
        lines.push(Vec::new());
    }
    if lines.len() > 2 {
        lines.truncate(2);
        let second = lines.remove(1);
        let mut joined: Line = second;
        joined.push(Span::raw(" \u{2026}"));
        lines.insert(1, truncate_line(&joined, content_width, "\u{2026}"));
    }
    lines
        .into_iter()
        .map(|line| {
            // TS `EventSummary` colors the inset space with the summary
            // color (`theme.fg(color, \` ${line}\`)`), so the first span
            // carries the leading space.
            let mut row: Line = Vec::new();
            for (index, span) in line.into_iter().enumerate() {
                let content = if index == 0 {
                    format!(" {}", span.content)
                } else {
                    span.content
                };
                row.push(Span::styled(content, style));
            }
            row
        })
        .collect()
}

/// The expanded-content row set on the branch grammar: wrap at the branch
/// content width, first row the dim `╰─ ` gutter, continuation rows the
/// matching indent, truncated to the full width.
fn branch_rows_over(line: Line, theme: &Theme, width: usize) -> Vec<Line> {
    crate::branch::branch_block(line, theme, width)
}

/// The continuation row set on the branch depth: every row starts four
/// plain spaces and wraps at the branch content width.
fn continuation_rows_over(line: Line, width: usize) -> Vec<Line> {
    let flat: String = line.iter().map(|span| span.content.as_str()).collect();
    if flat.trim().is_empty() {
        return Vec::new();
    }
    let content_width = crate::branch::branch_content_width(width);
    let mut rows: Vec<Line> = Vec::new();
    for source in crate::branch::split_line_on_newlines(&line) {
        for wrapped in wrap_line(&source, content_width) {
            let mut row: Line = vec![Span::raw(crate::branch::BRANCH_INDENT.to_string())];
            row.extend(wrapped);
            rows.push(truncate_line(&row, width, ""));
        }
    }
    rows
}

/// One edit section: the label row hangs off the branch, then one muted
/// field-label row per field with plain value rows or -/+ change rows on
/// the continuation indent.
fn edit_section_rows(edit: &RefinementEditRow, theme: &Theme, width: usize) -> Vec<Line> {
    let mut label: Line = Vec::new();
    for part in &edit.label {
        label.push(label_part(part, theme));
    }
    let mut out = branch_rows_over(label, theme, width);
    for field in &edit.fields {
        out.extend(continuation_rows_over(
            vec![Span::styled(
                field.label.clone(),
                theme.fg_style(ThemeColor::Muted),
            )],
            width,
        ));
        match &field.change {
            None => {
                out.extend(continuation_rows_over(
                    vec![Span::raw(field.value.join("\n"))],
                    width,
                ));
            }
            Some((removed, added)) => {
                for row in rich_change_rows(
                    removed,
                    added,
                    theme,
                    crate::branch::branch_content_width(width),
                ) {
                    let mut inset: Line = vec![Span::raw(crate::branch::BRANCH_INDENT)];
                    inset.extend(row);
                    // At tiny widths the branch prefix alone outgrows the
                    // viewport: clip the prefixed row like the production
                    // traversal does before paint.
                    out.push(crate::width::truncate_line(&inset, width, ""));
                }
            }
        }
    }
    if let Some(reason) = &edit.reason {
        out.extend(continuation_rows_over(
            vec![Span::styled(
                format!("Reason: {reason}"),
                theme.fg_style(ThemeColor::Muted),
            )],
            width,
        ));
    }
    out
}

/// One label span (the colored verb or failed line).
fn label_part(part: &LabelPart, theme: &Theme) -> Span {
    match part.color {
        Some(color) => Span::styled(part.text.clone(), theme.fg_style(color)),
        None => Span::raw(part.text.clone()),
    }
}

/// Full-context line diff rows in the rich-diff row shape (TS
/// `buildRichDiffLine` over `generateDiffString` with infinite context):
/// a ` <num> <prefix> ` gutter on the diff backgrounds, wrapped content in
/// `mdCodeBlock`, continuation rows keep a blank gutter.
fn rich_change_rows(
    removed: &[String],
    added: &[String],
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let line_num_width = removed.len().max(added.len()).to_string().len();
    let mut rows: Vec<Line> = Vec::new();
    let mut old_num = 1usize;
    let mut new_num = 1usize;
    for op in line_diff(removed, added) {
        let (prefix, num, line) = match op {
            DiffOp::Context(line) => {
                // TS `generateDiffString` advances both counters on
                // context lines, so added rows after a change keep the
                // new-file numbering.
                let num = old_num;
                old_num += 1;
                new_num += 1;
                (' ', num, line)
            }
            DiffOp::Removed(line) => {
                let num = old_num;
                old_num += 1;
                ('-', num, line)
            }
            DiffOp::Added(line) => {
                let num = new_num;
                new_num += 1;
                ('+', num, line)
            }
        };
        let (bg, gutter_color, content_color) = match prefix {
            '+' => {
                if theme.mode == ColorMode::TrueColor {
                    (
                        ThemeBg::ToolDiffAddedBg,
                        ThemeColor::ToolDiffAdded,
                        ThemeColor::MdCodeBlock,
                    )
                } else {
                    (
                        ThemeBg::ToolPanelBg,
                        ThemeColor::ToolDiffAdded,
                        ThemeColor::ToolDiffAdded,
                    )
                }
            }
            '-' => {
                if theme.mode == ColorMode::TrueColor {
                    (
                        ThemeBg::ToolDiffRemovedBg,
                        ThemeColor::ToolDiffRemoved,
                        ThemeColor::MdCodeBlock,
                    )
                } else {
                    (
                        ThemeBg::ToolPanelBg,
                        ThemeColor::ToolDiffRemoved,
                        ThemeColor::ToolDiffRemoved,
                    )
                }
            }
            _ => (
                ThemeBg::ToolPanelBg,
                ThemeColor::ToolDiffContext,
                ThemeColor::MdCodeBlock,
            ),
        };
        let gutter = format!(" {num:>line_num_width$} {prefix} ");
        let content = line.replace('\t', "   ");
        let content_width = width.saturating_sub(str_width(&gutter)).max(1);
        let wrapped = wrap_text(&content, content_width);
        for (index, wrapped_line) in wrapped.into_iter().enumerate() {
            let mut row: Line = Vec::new();
            if index == 0 {
                row.push(Span::styled(
                    gutter.clone(),
                    theme.fg_style(gutter_color).patch(theme.bg_style(bg)),
                ));
            } else {
                row.push(Span::styled(
                    " ".repeat(str_width(&gutter)),
                    theme.bg_style(bg),
                ));
            }
            for span in wrapped_line {
                row.push(Span::styled(
                    span.content,
                    theme.fg_style(content_color).patch(theme.bg_style(bg)),
                ));
            }
            rows.push(pad_with(row, width, theme.bg_style(bg)));
        }
    }
    rows
}
