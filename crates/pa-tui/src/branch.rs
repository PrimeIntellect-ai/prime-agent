//! The branch row grammar for expanded content: the first content row
//! of an expansion hangs off its event's header row on a dim
//! `\u{2570}\u{2500} ` gutter, and every following row sits at the
//! four-column continuation indent (the one-column chat margin plus the
//! gutter's three columns) — the same geometry the expanded ipython cell
//! code (TS `renderCode`) and the received agent-message body use (the
//! divergence note lives in `docs/FEATURE_PARITY.md`).

use crate::{Line, Span};

/// The branch gutter: a dim `\u{2570}\u{2500} ` on the first content row
/// hanging off the event's header row.
pub(crate) const BRANCH_GUTTER: &str = "\u{2570}\u{2500} ";

/// The continuation indent: three plain spaces (the gutter's width) on
/// every row after the first (TS `OUTPUT_INDENT`).
pub(crate) const BRANCH_CONTINUATION: &str = "   ";

/// The full continuation prefix: the one-column chat margin plus the
/// three-column gutter depth — four plain spaces a continuation row (or a
/// full-width diff block) starts its content at.
pub(crate) const BRANCH_INDENT: &str = "    ";

/// The content width under the branch: the full width minus the one-column
/// chat margin and the three-column gutter.
pub(crate) fn branch_content_width(width: usize) -> usize {
    width.saturating_sub(4).max(1)
}

/// Prefix already-wrapped rows with the branch grammar: the first row
/// that carries content gets the dim gutter, every other row the
/// continuation indent, both after the one-column chat margin.
pub(crate) fn branch_rows(lines: Vec<Line>, theme: &crate::theme::Theme) -> Vec<Line> {
    let dim = theme.fg_style(crate::theme::ThemeColor::Dim);
    // `render_markdown` can emit leading empty rows (a summary beginning
    // with a blank line), so the gutter must hang off the first row that
    // actually carries content, not the vector's first row.
    let mut first_content = true;
    lines
        .into_iter()
        .map(|mut line| {
            let use_gutter =
                first_content && line.iter().any(|span| !span.content.trim().is_empty());
            if use_gutter {
                first_content = false;
            }
            let mut row: Line = vec![Span::raw(" ")];
            if use_gutter {
                row.push(Span::styled(BRANCH_GUTTER.to_string(), dim));
            } else {
                row.push(Span::raw(BRANCH_CONTINUATION.to_string()));
            }
            row.append(&mut line);
            row
        })
        .collect()
}

/// Split a line on embedded newlines, keeping each piece's span styles (a
/// newline inside a span ends the current row; the next piece starts a new
/// one).
pub(crate) fn split_line_on_newlines(line: &Line) -> Vec<Line> {
    let mut rows: Vec<Line> = Vec::new();
    let mut current: Line = Vec::new();
    for span in line {
        let mut pieces = span.content.as_str().split('\n');
        let first = pieces.next().unwrap_or_default();
        current.push(Span::styled(first.to_string(), span.style));
        for piece in pieces {
            rows.push(std::mem::take(&mut current));
            current.push(Span::styled(piece.to_string(), span.style));
        }
    }
    rows.push(current);
    rows
}

/// One branch-indented block over pre-styled spans: empty content renders
/// nothing; otherwise each newline-joined source line wraps at the branch
/// content width (styles preserved through the wrap), the first rendered
/// content row carries the dim gutter, the rest the continuation indent,
/// and every row truncates to the full width.
pub(crate) fn branch_block(line: Line, theme: &crate::theme::Theme, width: usize) -> Vec<Line> {
    let flat: String = line.iter().map(|span| span.content.as_str()).collect();
    if flat.trim().is_empty() {
        return Vec::new();
    }
    let content_width = branch_content_width(width);
    let mut wrapped: Vec<Line> = Vec::new();
    for source in split_line_on_newlines(&line) {
        wrapped.extend(crate::width::wrap_line(&source, content_width));
    }
    branch_rows(wrapped, theme)
        .into_iter()
        .map(|row| crate::width::truncate_line(&row, width, ""))
        .collect()
}

/// The row count of [`branch_block`]: the emptiness gate plus the wrapped
/// row count at the branch content width (newlines split like the paint
/// path).
pub(crate) fn branch_block_count(text: &str, width: usize) -> usize {
    if text.trim().is_empty() {
        return 0;
    }
    crate::width::wrapped_text_count(text, branch_content_width(width))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ColorMode, Theme};

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn flat(rows: &[Line]) -> Vec<String> {
        rows.iter()
            .map(|row| row.iter().map(|span| span.content.as_str()).collect())
            .collect()
    }

    #[test]
    fn block_hangs_first_row_on_the_gutter() {
        let line = vec![Span::raw("one two three four five six seven")];
        let rows = branch_block(line, &theme(), 24);
        assert_eq!(
            flat(&rows),
            vec![" \u{2570}\u{2500} one two three four", "    five six seven"]
        );
    }

    #[test]
    fn block_splits_newlines_and_keeps_span_styles() {
        let line = vec![
            Span::styled(
                "Created".to_string(),
                theme().fg_style(crate::theme::ThemeColor::Success),
            ),
            Span::raw(" local memory `x`\nsecond line"),
        ];
        let rows = branch_block(line, &theme(), 40);
        assert_eq!(flat(&rows).len(), 2);
        assert_eq!(rows[0][2].content, "Created");
        assert_eq!(
            rows[0][2].style,
            theme().fg_style(crate::theme::ThemeColor::Success)
        );
        assert_eq!(flat(&rows)[1].trim_start(), "second line");
    }

    #[test]
    fn gutter_hangs_off_the_first_nonblank_row() {
        // A summary beginning with a blank line: `render_markdown` emits
        // the leading empty row first, so the gutter must land on the
        // first row that carries content, not the first vector row.
        let line = vec![Span::raw("\nthe session story")];
        let rows = branch_block(line, &theme(), 40);
        let flat = flat(&rows);
        assert_eq!(
            flat[0], "    ",
            "the blank row carries the continuation: {flat:?}"
        );
        assert_eq!(flat[1], " \u{2570}\u{2500} the session story");
    }

    #[test]
    fn empty_block_renders_nothing() {
        assert!(branch_block(vec![Span::raw("   ")], &theme(), 40).is_empty());
        assert!(branch_block(vec![], &theme(), 40).is_empty());
        assert_eq!(branch_block_count("  ", 40), 0);
    }

    #[test]
    fn count_matches_the_painted_rows() {
        let theme = theme();
        for text in [
            "",
            "one",
            "a\nb\nc",
            "word ".repeat(40).as_str(),
            "\n",
            "  \n  x",
        ] {
            for width in 0..40usize {
                let line = vec![Span::raw(text)];
                assert_eq!(
                    branch_block(line, &theme, width).len(),
                    branch_block_count(text, width),
                    "text={text:?} width={width}"
                );
            }
        }
    }
}
