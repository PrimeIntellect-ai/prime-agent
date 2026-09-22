//! GFM table rendering for the chat markdown (TS
//! `markdown.ts renderTable`): pipe tables with a header row, an
//! alignment/delimiter row, and data rows, sized so every column fits the
//! available width, with cells wrapped and padded per column.

use crate::markdown::{render_inline, wrap_spans, MarkdownStyle};
use crate::width::str_width;
use crate::{Line, Span};
use ratatui::style::Style;

/// A parsed pipe table: header cells, data rows (normalized to the header
/// width like marked's `splitCells(row, header.length)`), and the raw
/// source lines (the too-narrow fallback re-renders them as wrapped text).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Table {
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub raw: Vec<String>,
}

/// Split one table row into cells on unescaped pipes (marked `splitCells`):
/// leading/trailing pipes drop their empty edge cell, cells are trimmed,
/// and `\|` unescapes to `|`. With `expected`, rows are truncated or padded
/// to the header column count.
fn split_cells(row: &str, expected: Option<usize>) -> Vec<String> {
    let mut cells: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut escaped = false;
    for ch in row.chars() {
        match ch {
            '\\' if !escaped => {
                escaped = true;
                cell.push(ch);
            }
            '|' if !escaped => {
                cells.push(std::mem::take(&mut cell));
            }
            _ => {
                escaped = false;
                cell.push(ch);
            }
        }
    }
    cells.push(cell);
    // marked drops the first/last cell only when it trims to empty, i.e.
    // a leading/trailing pipe.
    if cells.len() > 1 && cells[0].trim().is_empty() {
        cells.remove(0);
    }
    if matches!(cells.last(), Some(last) if last.trim().is_empty()) && cells.len() > 1 {
        cells.pop();
    }
    let mut cells: Vec<String> = cells
        .into_iter()
        .map(|c| c.trim().replace("\\|", "|"))
        .collect();
    if let Some(expected) = expected {
        if cells.len() > expected {
            cells.truncate(expected);
        }
        while cells.len() < expected {
            cells.push(String::new());
        }
    }
    cells
}

/// The number of delimiter cells when the line is a table delimiter row:
/// one or more `:?-+:?` cells separated by pipes (marked strips the row's
/// leading/trailing pipe, then splits on `|`), and the row must carry a pipe
/// or colon (marked's `tableDelimiter` test, which keeps plain `---` setext
/// rules out of the table rule).
fn delimiter_columns(line: &str) -> Option<usize> {
    let trimmed = line.trim();
    if trimmed.is_empty() || !(trimmed.contains('|') || trimmed.contains(':')) {
        return None;
    }
    let body = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let body = body.strip_suffix('|').unwrap_or(body);
    let cells: Vec<&str> = body.split('|').collect();
    let valid = cells.iter().all(|cell| {
        let cell = cell.trim();
        let dashes = cell.trim_matches(':');
        !dashes.is_empty() && dashes.chars().all(|c| c == '-')
    });
    valid.then_some(cells.len())
}

/// True when `header_line` followed by `next_line` starts a table (marked's
/// `table` rule): a non-blank header row whose cell count equals the
/// delimiter row's.
pub(crate) fn is_table_start(header_line: &str, next_line: Option<&&str>) -> bool {
    let Some(next) = next_line else {
        return false;
    };
    let Some(delimiter_cols) = delimiter_columns(next) else {
        return false;
    };
    let header_cols = split_cells(header_line, None).len();
    header_cols == delimiter_cols
}

/// True when a line ends a table body (marked stops rows at blank lines and
/// at other block starts: fences, headings, hr, quotes, lists).
fn ends_table(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return true;
    }
    let heading = trimmed.starts_with('#')
        && (trimmed.len() == 1 || trimmed[1..].starts_with(char::is_whitespace));
    trimmed.starts_with("```")
        || heading
        || trimmed.starts_with('>')
        || crate::markdown::is_hr(trimmed)
        || crate::markdown::list_marker(trimmed).is_some()
}

/// Parse a table block starting at `lines[*index]` (already known to be a
/// table start): consumes the header, delimiter, and body rows, and
/// advances `index` past them.
pub(crate) fn parse_table_block(lines: &[&str], index: &mut usize) -> Table {
    let header = split_cells(lines[*index], None);
    let num_cols = header.len();
    let mut raw = vec![lines[*index].to_string(), lines[*index + 1].to_string()];
    *index += 2;
    let mut rows: Vec<Vec<String>> = Vec::new();
    while *index < lines.len() && !ends_table(lines[*index]) {
        rows.push(split_cells(lines[*index], Some(num_cols)));
        raw.push(lines[*index].to_string());
        *index += 1;
    }
    Table { header, rows, raw }
}

/// Render the table (TS `renderTable`): compute per-column widths from the
/// natural cell widths and the longest unbroken word (capped at 30), wrap
/// cells that overflow their column, pad every cell to the column width,
/// bold the header row, and draw the box borders. When the width is too
/// small for a stable table, fall back to the raw markdown wrapped.
pub(crate) fn render_table(
    header: &[String],
    rows: &[Vec<String>],
    raw: &[String],
    width: usize,
    style: &MarkdownStyle,
    out: &mut Vec<Line>,
) {
    let num_cols = header.len();
    if num_cols == 0 {
        return;
    }
    let border_overhead = 3 * num_cols + 1;
    let available_for_cells = width.saturating_sub(border_overhead);
    if available_for_cells < num_cols {
        // Too narrow to render a stable table: fall back to raw markdown,
        // unstyled (the TS fallback pushes the raw lines with no theme
        // wrapper, so they carry the terminal default color).
        for raw_line in raw {
            wrap_spans(&[Span::raw(raw_line.clone())], width, Style::default(), out);
        }
        return;
    }

    let max_unbroken_word_width = 30usize;

    // Render each cell's inline content once; measure natural and
    // minimum-word widths from it.
    let header_spans: Vec<Line> = header
        .iter()
        .map(|cell| render_inline(cell, style))
        .collect();
    let mut natural: Vec<usize> = header_spans.iter().map(spans_width).collect();
    let mut min_word: Vec<usize> = header_spans
        .iter()
        .map(|s| longest_word_width(s, max_unbroken_word_width))
        .collect();
    let row_spans: Vec<Vec<Line>> = rows
        .iter()
        .map(|row| row.iter().map(|cell| render_inline(cell, style)).collect())
        .collect();
    for row in &row_spans {
        for (col, spans) in row.iter().enumerate() {
            natural[col] = natural[col].max(spans_width(spans));
            min_word[col] = min_word[col].max(longest_word_width(spans, max_unbroken_word_width));
        }
    }

    // Minimum column widths: the longest unbroken word per column, capped at
    // 30. When the minimums overflow the space available, redistribute
    // proportionally to the words' growth potential.
    let mut min_widths = min_word.clone();
    if min_widths.iter().sum::<usize>() > available_for_cells {
        min_widths = vec![1; num_cols];
        let remaining = available_for_cells.saturating_sub(num_cols);
        if remaining > 0 {
            let total_weight: usize = min_word.iter().copied().map(|w| w.saturating_sub(1)).sum();
            let mut allocated = 0usize;
            for col in 0..num_cols {
                let weight = min_word[col].saturating_sub(1);
                let growth = (weight * remaining).checked_div(total_weight).unwrap_or(0);
                min_widths[col] += growth;
                allocated += growth;
            }
            let mut leftover = remaining.saturating_sub(allocated);
            let mut col = 0;
            while leftover > 0 && col < num_cols {
                min_widths[col] += 1;
                leftover -= 1;
                col += 1;
            }
        }
    }
    let min_cells_width: usize = min_widths.iter().sum();

    let total_natural_width = natural.iter().sum::<usize>() + border_overhead;
    let mut column_widths: Vec<usize>;
    if total_natural_width <= width {
        column_widths = natural
            .iter()
            .zip(&min_widths)
            .map(|(&natural, &min)| natural.max(min))
            .collect();
    } else {
        let total_grow_potential: usize = natural
            .iter()
            .zip(&min_widths)
            .map(|(&natural, &min)| natural.saturating_sub(min))
            .sum();
        let extra_width = available_for_cells.saturating_sub(min_cells_width);
        column_widths = min_widths
            .iter()
            .zip(&natural)
            .map(|(&min, &natural)| {
                let delta = natural.saturating_sub(min);
                let grow = (delta * extra_width)
                    .checked_div(total_grow_potential)
                    .unwrap_or(0);
                min + grow
            })
            .collect();
        // Distribute rounding remainder to columns still below natural.
        let mut remaining = available_for_cells.saturating_sub(column_widths.iter().sum::<usize>());
        loop {
            let mut grew = false;
            for col in 0..num_cols {
                if remaining == 0 {
                    break;
                }
                if column_widths[col] < natural[col] {
                    column_widths[col] += 1;
                    remaining -= 1;
                    grew = true;
                }
            }
            if !grew || remaining == 0 {
                break;
            }
        }
    }

    let dashes = |w: usize| "─".repeat(w);
    let join = |left: char, mid: char, right: char| -> String {
        let inner: Vec<String> = column_widths.iter().map(|&w| dashes(w)).collect();
        format!("{left}─{}─{right}", inner.join(&format!("─{mid}─")))
    };
    out.push(vec![Span::raw(join('┌', '┬', '┐'))]);

    // The observed TS binary output (0.9.5, the parity ground truth) draws
    // the header row exactly like the data rows: inline-rendered cell text
    // in the body color, unstyled padding, plain borders. The TS source's
    // `theme.bold(headerCell)` never reaches the wire, so the port must not
    // emit the bold modifier either (a Rust-only bold would be a parity
    // bug in every frame diff).

    // Header row: wrapped and padded like the data rows (see the note above:
    // the TS binary output carries no header bold).
    let header_cells: Vec<Vec<Line>> = header_spans
        .iter()
        .zip(&column_widths)
        .map(|(spans, &width)| wrap_cell(spans, width))
        .collect();
    let header_lines = header_cells.iter().map(|c| c.len()).max().unwrap_or(0);
    for line_idx in 0..header_lines {
        let mut row: Line = vec![Span::raw("│ ")];
        for (col, cell) in header_cells.iter().enumerate() {
            if col > 0 {
                row.push(Span::raw(" │ "));
            }
            let text = cell.get(line_idx).cloned().unwrap_or_default();
            let pad = column_widths[col].saturating_sub(spans_width(&text));
            row.extend(text);
            if pad > 0 {
                row.push(Span::raw(" ".repeat(pad)));
            }
        }
        row.push(Span::raw(" │"));
        out.push(row);
    }

    let separator = join('├', '┼', '┤');
    out.push(vec![Span::raw(separator.clone())]);

    for (row_idx, row) in row_spans.iter().enumerate() {
        let cells: Vec<Vec<Line>> = row
            .iter()
            .zip(&column_widths)
            .map(|(spans, &width)| wrap_cell(spans, width))
            .collect();
        let row_lines = cells.iter().map(|c| c.len()).max().unwrap_or(0);
        for line_idx in 0..row_lines {
            let mut row_line: Line = vec![Span::raw("│ ")];
            for (col, cell) in cells.iter().enumerate() {
                if col > 0 {
                    row_line.push(Span::raw(" │ "));
                }
                let text = cell.get(line_idx).cloned().unwrap_or_default();
                let pad = column_widths[col].saturating_sub(spans_width(&text));
                row_line.extend(text);
                if pad > 0 {
                    row_line.push(Span::raw(" ".repeat(pad)));
                }
            }
            row_line.push(Span::raw(" │"));
            out.push(row_line);
        }
        if row_idx + 1 < row_spans.len() {
            out.push(vec![Span::raw(separator.clone())]);
        }
    }

    out.push(vec![Span::raw(join('└', '┴', '┘'))]);
}

/// Wrap a cell's spans to its column width (TS `wrapCellText`, which
/// delegates to the ANSI-aware wrapTextWithAnsi).
fn wrap_cell(spans: &Line, width: usize) -> Vec<Line> {
    let mut wrapped: Vec<Line> = Vec::new();
    wrap_spans(spans, width.max(1), Style::default(), &mut wrapped);
    if wrapped.is_empty() {
        wrapped.push(Vec::new());
    }
    wrapped
}

/// The visible width of one line of spans.
fn spans_width(spans: &Line) -> usize {
    spans.iter().map(|s| str_width(&s.content)).sum()
}

/// The longest word width in rendered spans, capped (TS `getLongestWordWidth`:
/// words split on whitespace across the whole cell text; escape sequences
/// measure zero width).
fn longest_word_width(spans: &Line, max_width: usize) -> usize {
    let text: String = spans.iter().map(|s| s.content.as_str()).collect();
    let mut longest = 0usize;
    for word in text.split_whitespace() {
        longest = longest.max(str_width(word));
    }
    longest.min(max_width).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Modifier;

    fn rows(out: Vec<Line>) -> Vec<String> {
        out.iter()
            .map(|l| l.iter().map(|s| s.content.as_str()).collect())
            .collect()
    }

    fn plain(text: &str, width: usize) -> Vec<String> {
        let style = MarkdownStyle::default();
        let mut out = Vec::new();
        let src_lines: Vec<&str> = text.lines().collect();
        let mut i = 0usize;
        let table = parse_table_block(&src_lines, &mut i);
        render_table(
            &table.header,
            &table.rows,
            &table.raw,
            width,
            &style,
            &mut out,
        );
        rows(out)
    }

    #[test]
    fn simple_table_renders_boxed() {
        let out = plain("| a | b |\n| --- | --- |\n| 1 | 2 |", 40);
        assert_eq!(
            out,
            vec![
                "┌───┬───┐",
                "│ a │ b │",
                "├───┼───┤",
                "│ 1 │ 2 │",
                "└───┴───┘",
            ]
        );
    }

    #[test]
    fn header_row_matches_the_observed_ts_binary_output() {
        // The TS binary draws the header exactly like the data rows: cell
        // text in the body color, unstyled padding, no bold anywhere.
        let style = MarkdownStyle::default();
        let mut out = Vec::new();
        let header = vec!["a".to_string(), "b".to_string()];
        let rows_in = vec![vec!["1".to_string(), "2".to_string()]];
        let raw = vec!["| a | b |".to_string()];
        render_table(&header, &rows_in, &raw, 40, &style, &mut out);
        for row in &out {
            for span in row {
                assert!(
                    !span.style.add_modifier.contains(Modifier::BOLD),
                    "no bold in table rows: {:?}",
                    row
                );
            }
        }
        // Cell text carries the body color; borders and padding are plain.
        assert_eq!(out[1][0].style, Style::default());
        assert_eq!(out[1][1].style.fg, style.body.fg);
        assert_eq!(out[1][3].style.fg, style.body.fg);
    }

    #[test]
    fn wide_cells_get_padded_to_column_width() {
        let out = plain("| col | x |\n| --- | --- |\n| alpha | 1 |", 40);
        assert_eq!(
            out,
            vec![
                "┌───────┬───┐",
                "│ col   │ x │",
                "├───────┼───┤",
                "│ alpha │ 1 │",
                "└───────┴───┘",
            ]
        );
    }

    #[test]
    fn mixed_width_cells_measure_display_columns() {
        // CJK cells measure two columns per glyph and pad to the column.
        let out = plain("| 列 | n |\n| --- | --- |\n| 数据 | 1 |", 40);
        assert_eq!(
            out,
            vec![
                "┌──────┬───┐",
                "│ 列   │ n │",
                "├──────┼───┤",
                "│ 数据 │ 1 │",
                "└──────┴───┘",
            ]
        );
    }

    #[test]
    fn long_cells_wrap_inside_their_column() {
        // Natural widths (11 and 3) exceed the 10 columns available after
        // the 7-column border overhead, so the first column shrinks to 7
        // and its cell wraps while every row stays box-aligned.
        let out = plain("| a | b |\n| --- | --- |\n| aa bb cc dd | one |", 17);
        assert_eq!(
            out,
            vec![
                "┌─────────┬─────┐",
                "│ a       │ b   │",
                "├─────────┼─────┤",
                "│ aa bb   │ one │",
                "│ cc dd   │     │",
                "└─────────┴─────┘",
            ]
        );
    }

    #[test]
    fn delimiter_colons_are_accepted_and_left_aligned() {
        let out = plain("| a | b |\n| :-: | ---: |\n| 1 | 2 |", 40);
        assert_eq!(out[1], "│ a │ b │");
        assert_eq!(out[3], "│ 1 │ 2 │");
    }

    #[test]
    fn narrow_width_falls_back_to_raw_markdown() {
        // The 7-column border overhead leaves less than one column per
        // cell, so the block renders as the wrapped raw source instead.
        let raw = "| a | b |\n| --- | --- |\n| 1 | 2 |";
        let out = plain(raw, 6);
        let joined = out.join("\n");
        for line in raw.lines() {
            let words: Vec<&str> = line.split_whitespace().collect();
            for word in words {
                assert!(joined.contains(word), "fallback lost {word}: {joined}");
            }
        }
        assert!(
            !out.iter().any(|l| l.contains('│')),
            "fallback must not draw a box: {joined}"
        );
        for l in &out {
            assert!(str_width(l) <= 6, "fallback row too wide: {l}");
        }
    }

    #[test]
    fn is_table_start_requires_matching_delimiter() {
        assert!(is_table_start("| a | b |", Some(&"| --- | --- |")));
        // Column count mismatch: marked keeps the block a paragraph.
        assert!(!is_table_start("| a | b | c |", Some(&"| --- | --- |")));
        // A setext-style dash row without pipes is a heading, not a table.
        assert!(!is_table_start("para", Some(&"---")));
        // Blank line after: not a table.
        assert!(!is_table_start("| a | b |", None));
    }

    #[test]
    fn escaped_pipes_stay_inside_cells() {
        let out = plain("| a\\|b | c |\n| --- | --- |\n| 1 | 2 |", 40);
        assert_eq!(out[1], "│ a|b │ c │");
    }

    #[test]
    fn rows_shorter_than_the_header_are_padded() {
        let out = plain("| a | b |\n| --- | --- |\n| 1 |", 40);
        assert_eq!(out[3], "│ 1 │   │");
    }

    #[test]
    fn body_ends_at_other_block_starts() {
        let text = "| a | b |\n| --- | --- |\n| 1 | 2 |\n- item";
        let src_lines: Vec<&str> = text.lines().collect();
        let mut i = 0usize;
        let table = parse_table_block(&src_lines, &mut i);
        assert_eq!(table.rows, vec![vec!["1".to_string(), "2".to_string()]]);
        assert_eq!(src_lines[i], "- item");
    }
}
