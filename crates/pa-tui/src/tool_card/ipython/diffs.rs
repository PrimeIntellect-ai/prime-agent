//! Edit diffs in the cell card: one `╰─ <path> +N -M` summary line per edited file, always
//! shown, and the numbered diff rows when edit diffs are expanded. Each `details.diffs` entry
//! carries pa-core's edit-tool diff text, so the card only splits it into rows.

use std::path::Path;

use super::{highlight, Line, RowOutput, Span, Theme, ThemeColor, Value};
use crate::theme::{ColorMode, ThemeBg};
use crate::width::{
    line_width, str_width, truncate_line, truncate_to_width, wrap_line, wrapped_line_count,
};

const SUMMARY_PREFIX: &str = "    \u{2570}\u{2500} ";
const DIFF_INDENT: &str = " ";

/// Edits grouped by path in first-seen order, after a spacer row when code is shown.
pub(super) fn render_diffs(
    lines: &mut RowOutput,
    diffs: &[Value],
    has_code: bool,
    expanded: bool,
    theme: &Theme,
    width: usize,
) {
    let mut by_path: Vec<(&str, Vec<&str>)> = Vec::new();
    for entry in diffs {
        let (Some(path), Some(diff)) = (
            entry.get("path").and_then(Value::as_str),
            entry.get("diff").and_then(Value::as_str),
        ) else {
            continue;
        };
        match by_path.iter_mut().find(|(seen, _)| *seen == path) {
            Some((_, edits)) => edits.push(diff),
            None => by_path.push((path, vec![diff])),
        }
    }
    if by_path.is_empty() {
        return;
    }
    if has_code {
        lines.push(|| vec![Span::raw(" ")]);
    }
    for (path, edits) in &by_path {
        render_file(lines, path, edits, expanded, theme, width);
    }
}

/// The summary line, then (expanded) each edit's rows with a `⋮` separator between edits.
fn render_file(
    lines: &mut RowOutput,
    path: &str,
    edits: &[&str],
    expanded: bool,
    theme: &Theme,
    width: usize,
) {
    let (mut added, mut removed) = (0usize, 0usize);
    for line in edits.iter().flat_map(|diff| diff.split('\n')) {
        if line.starts_with('+') {
            added += 1;
        } else if line.starts_with('-') {
            removed += 1;
        }
    }
    lines.push(|| summary_line(path, added, removed, theme, width));
    if !expanded {
        return;
    }
    let python = Path::new(path)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("py"));
    let indent = if width > 1 { DIFF_INDENT } else { "" };
    let content_width = width.saturating_sub(indent.len()).max(1);
    for (index, diff) in edits.iter().enumerate() {
        if index > 0 {
            lines.push(|| {
                let mut row: Line = vec![Span::raw(indent)];
                row.extend(diff_separator(theme, content_width));
                truncate_line(&row, width, "")
            });
        }
        diff_rows(lines, diff, indent, content_width, python, theme);
    }
}

/// The raw path, truncated with `…` so the counts stay visible.
fn summary_line(path: &str, added: usize, removed: usize, theme: &Theme, width: usize) -> Line {
    let dim = theme.fg_style(ThemeColor::Dim);
    let added = format!("+{added}");
    let removed = format!("-{removed}");
    let counts_width = 1 + str_width(&added) + 1 + str_width(&removed);
    let width = width.max(1);
    let available = width
        .saturating_sub(str_width(SUMMARY_PREFIX) + counts_width)
        .max(1);
    let row: Line = vec![
        Span::styled(SUMMARY_PREFIX, dim),
        Span::styled(
            truncate_to_width(path, available, "\u{2026}"),
            theme.fg_style(ThemeColor::Muted),
        ),
        Span::styled(" ", dim),
        Span::styled(added, theme.fg_style(ThemeColor::ToolDiffAdded)),
        Span::raw(" "),
        Span::styled(removed, theme.fg_style(ThemeColor::ToolDiffRemoved)),
    ];
    truncate_line(&row, width, "")
}

fn diff_separator(theme: &Theme, width: usize) -> Line {
    let bg = theme.bg_style(ThemeBg::ToolPanelBg);
    let marker = " \u{22ee}";
    vec![
        Span::styled(
            marker,
            theme.fg_style(ThemeColor::ToolDiffContext).patch(bg),
        ),
        Span::styled(" ".repeat(width.saturating_sub(str_width(marker))), bg),
    ]
}

#[derive(Clone, Copy)]
enum RowKind {
    Added,
    Removed,
    Context,
}

/// One diff line split into kind, gutter, and text. Lines have the form
/// `{prefix}{number:>w} {text}`; skip rows put spaces in the number column and `...` as text.
/// Anything else renders whole as context behind a blank gutter.
fn split_row(line: &str) -> (RowKind, String, &str) {
    split_numbered(line).unwrap_or((RowKind::Context, " ".to_string(), line))
}

fn split_numbered(line: &str) -> Option<(RowKind, String, &str)> {
    let kind = match line.bytes().next()? {
        b'+' => RowKind::Added,
        b'-' => RowKind::Removed,
        b' ' => RowKind::Context,
        _ => return None,
    };
    let (prefix, rest) = line.split_at(1);
    let pad = rest.len() - rest.trim_start_matches(' ').len();
    let digits = rest[pad..].bytes().take_while(u8::is_ascii_digit).count();
    let split = if digits == 0 {
        pad.checked_sub(1)?
    } else {
        pad + digits
    };
    let (number, text) = rest.split_at(split);
    Some((
        kind,
        format!(" {number} {prefix} "),
        text.strip_prefix(' ')?,
    ))
}

/// Row background, gutter color, and the text color that replaces syntax colors when the
/// terminal lacks truecolor (changed rows are then marked by text color, not background).
fn row_colors(kind: RowKind, truecolor: bool) -> (ThemeBg, ThemeColor, Option<ThemeColor>) {
    let (block, color) = match kind {
        RowKind::Added => (ThemeBg::ToolDiffAddedBg, ThemeColor::ToolDiffAdded),
        RowKind::Removed => (ThemeBg::ToolDiffRemovedBg, ThemeColor::ToolDiffRemoved),
        RowKind::Context => return (ThemeBg::ToolPanelBg, ThemeColor::ToolDiffContext, None),
    };
    if truecolor {
        (block, color, None)
    } else {
        (ThemeBg::ToolPanelBg, color, Some(color))
    }
}

/// Full-width rows: the gutter, then the text wrapped onto blank-gutter continuation rows.
fn diff_rows(
    lines: &mut RowOutput,
    diff: &str,
    indent: &'static str,
    width: usize,
    python: bool,
    theme: &Theme,
) {
    let truecolor = theme.mode == ColorMode::TrueColor;
    for raw_line in diff.split('\n') {
        let (kind, gutter, text) = split_row(raw_line);
        let (bg, gutter_color, text_color) = row_colors(kind, truecolor);
        let text = text.replace('\t', "   ");
        let content: Line = match text_color {
            Some(color) => vec![Span::styled(text, theme.fg_style(color))],
            None if text.is_empty() => Vec::new(),
            None if python => {
                highlight::highlight_python(&text, &highlight::SyntaxPalette::from_theme(theme))
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| vec![Span::raw(text)])
            }
            None => vec![Span::styled(text, theme.fg_style(ThemeColor::MdCodeBlock))],
        };
        let gutter_width = str_width(&gutter);
        let content_width = width.saturating_sub(gutter_width).max(1);
        if lines.is_counting() {
            lines.add_count(wrapped_line_count(&content, content_width).max(1));
            continue;
        }
        let bg = theme.bg_style(bg);
        let mut rows = wrap_line(&content, content_width);
        if rows.is_empty() {
            rows.push(Vec::new());
        }
        for (index, row) in rows.into_iter().enumerate() {
            let lead = if index == 0 {
                Span::styled(gutter.clone(), theme.fg_style(gutter_color).patch(bg))
            } else {
                Span::styled(" ".repeat(gutter_width), bg)
            };
            let mut line: Line = vec![lead];
            line.extend(
                row.into_iter()
                    .map(|span| Span::styled(span.content, span.style.patch(bg))),
            );
            let mut line = truncate_line(&line, width, "");
            let pad = width.saturating_sub(line_width(&line));
            if pad > 0 {
                line.push(Span::styled(" ".repeat(pad), bg));
            }
            lines.push(|| {
                let mut out: Line = vec![Span::raw(indent)];
                out.extend(line);
                out
            });
        }
    }
}
