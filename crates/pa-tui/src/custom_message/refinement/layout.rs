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

    /// One expanded-content row set on the branch grammar: the first row
    /// carries the dim `╰─ ` gutter hanging off the event's header, every
    /// continuation row the three-space indent — both after the
    /// one-column chat margin (the same geometry the expanded ipython
    /// cell code and the agent-message body use).
    fn branch_text<'a>(
        &mut self,
        parts: impl IntoIterator<Item = (&'a str, Option<ThemeColor>)>,
        theme: &Theme,
        width: usize,
    ) {
        match self {
            Self::Paint(rows) => {
                let line: Line = parts
                    .into_iter()
                    .map(|(text, color)| match color {
                        Some(color) => Span::styled(text, theme.fg_style(color)),
                        None => Span::raw(text),
                    })
                    .collect();
                rows.extend(crate::branch::branch_block(line, theme, width));
            }
            Self::Count(count) => {
                let joined = parts
                    .into_iter()
                    .map(|(text, _)| text)
                    .collect::<Vec<_>>()
                    .join("");
                *count += crate::branch::branch_block_count(&joined, width);
            }
        }
    }

    /// One continuation row set on the branch depth: every row starts
    /// four plain spaces (the chat margin plus the gutter's width) and
    /// wraps at the branch content width — the expanded block's non-head
    /// rows (the meta annotation, the edit-section interiors).
    fn continuation_text<'a>(
        &mut self,
        parts: impl IntoIterator<Item = (&'a str, Option<ThemeColor>)>,
        theme: &Theme,
        width: usize,
    ) {
        let content_width = crate::branch::branch_content_width(width);
        match self {
            Self::Paint(rows) => {
                let line: Line = parts
                    .into_iter()
                    .map(|(text, color)| match color {
                        Some(color) => Span::styled(text, theme.fg_style(color)),
                        None => Span::raw(text),
                    })
                    .collect();
                let flat: String = line.iter().map(|span| span.content.as_str()).collect();
                if flat.trim().is_empty() {
                    return;
                }
                for source in crate::branch::split_line_on_newlines(&line) {
                    for wrapped in crate::width::wrap_line(&source, content_width) {
                        let mut row: Line =
                            vec![Span::raw(crate::branch::BRANCH_INDENT.to_string())];
                        row.extend(wrapped);
                        rows.push(crate::width::truncate_line(&row, width, ""));
                    }
                }
            }
            Self::Count(count) => {
                let joined = parts
                    .into_iter()
                    .map(|(text, _)| text)
                    .collect::<Vec<_>>()
                    .join("");
                if !joined.trim().is_empty() {
                    *count += crate::width::wrapped_text_count(&joined, content_width);
                }
            }
        }
    }
}

/// The `◆` header's wrapped row count — the entry's click surface spans
/// the whole header (TS wraps the `RefinementOutcomeMessageComponent`
/// header in `Clickable`; #2430). Same wrap the traversal's count sink
/// applies to the header text.
pub(crate) fn refinement_header_rows(row: &RefinementOutcomeRow, width: usize) -> usize {
    let header = format!("\u{25c6} {}", row.header);
    crate::width::wrapped_runs_count([header.as_str()], width.saturating_sub(2).max(1))
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
        // The expanded block hangs on the branch (the continuation
        // indent): the meta row, every edit section, and their field rows
        // all read as content of this one refinement event.
        out.continuation_text([(row.meta.as_str(), Some(ThemeColor::Dim))], theme, width);
        for edit in &row.edits {
            out.blank();
            edit_section_rows(edit, theme, width, out);
        }
    }
}

/// The summary row set: collapsed (TS `EventSummary`) keeps the TS shape —
/// whitespace-collapsed, wrapped at `width - 1` with the one-column inset
/// (the inset space colored inside the summary span), clamped to two
/// lines. Expanded hangs the raw summary on the branch grammar instead
/// (the product improvement beyond TS): first row `╰─ `, continuation rows
/// the matching indent.
fn event_summary_rows(
    summary: &str,
    expanded: bool,
    color: ThemeColor,
    theme: &Theme,
    width: usize,
    out: &mut Output,
) {
    let text = if expanded {
        summary.to_string()
    } else {
        summary.split_whitespace().collect::<Vec<_>>().join(" ")
    };
    if expanded {
        out.branch_text([(text.as_str(), Some(color))], theme, width);
        return;
    }
    let content_width = width.saturating_sub(1).max(1);
    if let Output::Count(count) = out {
        let rows = crate::width::wrapped_text_count(&text, content_width).max(1);
        *count += rows.min(2);
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
    if lines.len() > 2 {
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

/// One edit section (TS `RefinementEditSection`): the label row hangs off
/// the event's branch (`╰─ ` head), then one muted field-label row per
/// field with plain value rows or -/+ change rows on the continuation
/// indent.
fn edit_section_rows(edit: &RefinementEditRow, theme: &Theme, width: usize, out: &mut Output) {
    out.branch_text(
        edit.label
            .iter()
            .map(|part| (part.text.as_str(), part.color)),
        theme,
        width,
    );
    for field in &edit.fields {
        out.continuation_text(
            [(field.label.as_str(), Some(ThemeColor::Muted))],
            theme,
            width,
        );
        match &field.change {
            None => out.continuation_text([(field.value.join("\n").as_str(), None)], theme, width),
            Some((removed, added)) => {
                // The diff block keeps its own row width at the branch
                // depth: the four-column continuation prefix plus the
                // block's internal width make the full width.
                rich_change_rows(removed, added, theme, width, out);
            }
        }
    }
    if let Some(reason) = &edit.reason {
        out.continuation_text(
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
/// `mdCodeBlock`, continuation rows keep a blank gutter. The whole block
/// sits on the branch continuation indent: the four-column prefix plus
/// the block's internal width make the caller's full `width`, and at tiny
/// widths the prefixed row is clipped to the viewport before paint.
fn rich_change_rows(
    removed: &[String],
    added: &[String],
    theme: &Theme,
    width: usize,
    out: &mut Output,
) {
    let block_width = crate::branch::branch_content_width(width);
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
        let content_width = block_width.saturating_sub(str_width(&gutter)).max(1);
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
            // background block reaches the row's full internal width; the
            // branch continuation prefix (chat margin + gutter depth)
            // carries the whole block at the branch depth.
            let mut inset = vec![Span::raw(crate::branch::BRANCH_INDENT)];
            inset.extend(pad_with(row, block_width, theme.bg_style(bg)));
            // At tiny widths the branch prefix alone outgrows the
            // viewport, so clip before paint: `pad_with` only pads, never
            // truncates.
            let inset = crate::width::truncate_line(&inset, width, "");
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
        // Gutter ` <num> <prefix> ` (TS `buildRichDiffLine`) on the branch
        // continuation indent, removed rows on the removed background,
        // added rows on the added one.
        assert_eq!(
            text,
            vec![
                "     1   alpha".to_string(),
                "     2 - beta".to_string(),
                "     2 + gamma".to_string(),
            ],
            "{text:?}"
        );
        // The row layout is [branch indent, diff gutter, content, ...]:
        // the gutter spans carry the diff foregrounds on the diff
        // backgrounds.
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

    /// The four-column branch prefix alone outgrows viewports of a few
    /// columns: every painted row stays inside the width.
    #[test]
    fn change_rows_never_overflow_tiny_viewports() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        for width in 0..=8 {
            let mut out = Output::Paint(Vec::new());
            rich_change_rows(
                &["one".to_string()],
                &["two".to_string()],
                &theme,
                width,
                &mut out,
            );
            let Output::Paint(rows) = out else {
                unreachable!()
            };
            for row in &rows {
                let total: usize = row.iter().map(|s| str_width(&s.content)).sum();
                assert!(total <= width, "width {width} painted {total}");
            }
        }
    }
}
