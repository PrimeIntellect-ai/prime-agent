//! Shared refinement rendering traversal and count-only geometry.
use super::*;

enum Output {
    Paint(Vec<Line>),
    Count(usize),
}
impl Output {
    fn blank(&mut self) {
        match self {
            Self::Paint(rows) => rows.push(spacer()),
            Self::Count(count) => *count += 1,
        }
    }
    fn text<'a>(
        &mut self,
        parts: impl IntoIterator<Item = (&'a str, Option<ThemeColor>)>,
        theme: &Theme,
        width: usize,
    ) {
        match self {
            Self::Paint(rows) => {
                let line = parts
                    .into_iter()
                    .map(|(text, color)| match color {
                        Some(color) => Span::styled(text, theme.fg_style(color)),
                        None => Span::raw(text),
                    })
                    .collect();
                rows.extend(text_rows(line, width));
            }
            Self::Count(count) => {
                let runs: Vec<_> = parts.into_iter().map(|(text, _)| text).collect();
                if runs.iter().any(|text| !text.trim().is_empty()) {
                    *count += crate::width::wrapped_runs_count(
                        runs.iter().copied(),
                        width.saturating_sub(2).max(1),
                    );
                }
            }
        }
    }
}

pub(crate) fn render_refinement_outcome(
    row: &RefinementOutcomeRow,
    detail: Detail,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let mut out = Output::Paint(Vec::new());
    traverse(row, detail, theme, width, &mut out);
    match out {
        Output::Paint(rows) => rows,
        Output::Count(_) => unreachable!(),
    }
}

pub(crate) fn count_refinement_outcome(
    row: &RefinementOutcomeRow,
    detail: Detail,
    theme: &Theme,
    width: usize,
) -> usize {
    let mut out = Output::Count(0);
    traverse(row, detail, theme, width, &mut out);
    match out {
        Output::Count(rows) => rows,
        Output::Paint(_) => unreachable!(),
    }
}

fn traverse(
    row: &RefinementOutcomeRow,
    detail: Detail,
    theme: &Theme,
    width: usize,
    out: &mut Output,
) {
    out.blank();
    out.text(
        [(
            format!("\u{25c6} {}", row.header).as_str(),
            Some(ThemeColor::RefinementHeader),
        )],
        theme,
        width,
    );
    let summary = if row.summary.trim().is_empty() {
        "No summary was recorded for this harness change."
    } else {
        row.summary.trim()
    };
    event_summary_rows(
        summary,
        detail.tool_output_expanded(),
        ThemeColor::RefinementSummary,
        theme,
        width,
        out,
    );
    if detail.tool_output_expanded() {
        out.blank();
        out.text([(row.meta.as_str(), Some(ThemeColor::Dim))], theme, width);
        for edit in &row.edits {
            out.blank();
            edit_section_rows(edit, theme, width, out);
        }
    }
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
    out: &mut Output,
) {
    let content_width = width.saturating_sub(1).max(1);
    let text = if expanded {
        summary.to_string()
    } else {
        summary.split_whitespace().collect::<Vec<_>>().join(" ")
    };
    if let Output::Count(count) = out {
        let rows = crate::width::wrapped_text_count(&text, content_width).max(1);
        *count += if expanded { rows } else { rows.min(2) };
        return;
    }
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
    let rows = lines
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
        .collect::<Vec<Line>>();
    if let Output::Paint(output) = out {
        output.extend(rows);
    }
}

/// One edit section (TS `RefinementEditSection`): the label row, then one
/// muted field-label row per field with plain value rows or -/+ change rows.
fn edit_section_rows(edit: &RefinementEditRow, theme: &Theme, width: usize, out: &mut Output) {
    out.text(
        edit.label
            .iter()
            .map(|part| (part.text.as_str(), part.color)),
        theme,
        width,
    );
    for field in &edit.fields {
        out.text(
            [(field.label.as_str(), Some(ThemeColor::Muted))],
            theme,
            width,
        );
        match &field.change {
            None => out.text([(field.value.join("\n").as_str(), None)], theme, width),
            Some((removed, added)) => {
                rich_change_rows(removed, added, theme, width.saturating_sub(1), out)
            }
        }
    }
    if let Some(reason) = &edit.reason {
        out.text(
            [(
                format!("Reason: {reason}").as_str(),
                Some(ThemeColor::Muted),
            )],
            theme,
            width,
        );
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
    out: &mut Output,
) {
    let line_num_width = removed.len().max(added.len()).to_string().len();
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
        let gutter = format!(" {num:>line_num_width$} {prefix} ");
        let content = line.replace('\t', "   ");
        let content_width = width.saturating_sub(str_width(&gutter)).max(1);
        if let Output::Count(count) = out {
            *count += crate::width::wrapped_text_count(&content, content_width);
            continue;
        }
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
            let mut inset = vec![Span::raw(" ")];
            inset.extend(pad_with(row, width, theme.bg_style(bg)));
            if let Output::Paint(rows) = out {
                rows.push(inset);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn change_rows_render_full_context_diff() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let mut out = Output::Paint(Vec::new());
        rich_change_rows(
            &["alpha".to_string(), "beta".to_string()],
            &["alpha".to_string(), "gamma".to_string()],
            &theme,
            40,
            &mut out,
        );
        let Output::Paint(rows) = out else {
            unreachable!()
        };
        let text: Vec<String> = rows
            .iter()
            .map(|r| {
                r.iter()
                    .map(|s| s.content.as_str())
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
            .collect();
        // Gutter ` <num> <prefix> ` (TS `buildRichDiffLine`), removed
        // rows on the removed background, added rows on the added one.
        assert_eq!(
            text,
            vec![
                "  1   alpha".to_string(),
                "  2 - beta".to_string(),
                "  2 + gamma".to_string(),
            ],
            "{text:?}"
        );
        assert_eq!(
            rows[1][1].style,
            theme
                .fg_style(ThemeColor::ToolDiffRemoved)
                .patch(theme.bg_style(ThemeBg::ToolDiffRemovedBg))
        );
        assert_eq!(
            rows[2][1].style,
            theme
                .fg_style(ThemeColor::ToolDiffAdded)
                .patch(theme.bg_style(ThemeBg::ToolDiffAddedBg))
        );
    }
}
