//! Frozen pre-geometry renderer for full-object differential tests.
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
    // edit-diffs toggle.
    out.extend(event_summary_rows(
        summary,
        detail.tool_output_expanded(),
        ThemeColor::RefinementSummary,
        theme,
        width,
    ));
    if detail.tool_output_expanded() {
        out.push(spacer());
        out.extend(text_rows(
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

/// TS `EventSummary`: wrapped at `width - 1` with a one-column inset; the
/// collapsed view whitespace-collapses and clamps to two lines (the second
/// truncated with an ellipsis).
fn event_summary_rows(
    summary: &str,
    expanded: bool,
    color: ThemeColor,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let content_width = width.saturating_sub(1).max(1);
    let text = if expanded {
        summary.to_string()
    } else {
        summary.split_whitespace().collect::<Vec<_>>().join(" ")
    };
    let style = theme.fg_style(color);
    let mut lines: Vec<Line> = Vec::new();
    for source in text.split('\n') {
        let plain: Line = vec![Span::raw(source.to_string())];
        lines.extend(wrap_line(&plain, content_width));
    }
    if lines.is_empty() {
        lines.push(Vec::new());
    }
    if !expanded && lines.len() > 2 {
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

/// One edit section (TS `RefinementEditSection`): the label row, then one
/// muted field-label row per field with plain value rows or -/+ change rows.
fn edit_section_rows(edit: &RefinementEditRow, theme: &Theme, width: usize) -> Vec<Line> {
    let mut label: Line = Vec::new();
    for part in &edit.label {
        label.push(label_part(part, theme));
    }
    let mut out = text_rows(label, width);
    for field in &edit.fields {
        out.extend(text_rows(
            vec![Span::styled(
                field.label.clone(),
                theme.fg_style(ThemeColor::Muted),
            )],
            width,
        ));
        match &field.change {
            None => {
                out.extend(text_rows(vec![Span::raw(field.value.join("\n"))], width));
            }
            Some((removed, added)) => {
                for row in rich_change_rows(removed, added, theme, width.saturating_sub(1)) {
                    let mut inset: Line = vec![Span::raw(" ")];
                    inset.extend(row);
                    out.push(inset);
                }
            }
        }
    }
    if let Some(reason) = &edit.reason {
        out.extend(text_rows(
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
            // TS `theme.bg` covers the row's trailing padding too: the
            // background block reaches the full width.
            rows.push(pad_with(row, width, theme.bg_style(bg)));
        }
    }
    rows
}
