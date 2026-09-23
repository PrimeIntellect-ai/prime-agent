//! Inline menu-panel primitives (the inline paths of TS `menu-panel.ts`):
//! the bordered search field, the `›`-marker menu rows with right-aligned
//! trailing segments, and the shared truncate/pad budgeting. The `/model`
//! picker renders through these; the same geometry serves any future
//! inline menu surface.

use crate::theme::{Theme, ThemeColor};
use crate::width::{str_width, truncate_line};
use crate::{Line, Span};

/// The field prompt (TS `Input` renders `"> "`).
const FIELD_PROMPT: &str = "> ";

/// Trailing segments are joined with `" · "` and shrink from the front when
/// the row is too narrow (TS `reduceInlineTrailingSegments`).
fn reduce_trailing_segments<'a>(segments: &[&'a str], budget: usize) -> Vec<&'a str> {
    let mut current: Vec<&str> = segments
        .iter()
        .copied()
        .filter(|segment| !segment.is_empty())
        .collect();
    while current.len() > 1 && str_width(&current.join(" · ")) > budget {
        current.remove(0);
    }
    current
}

/// Rendered width of a trailing cluster at the given row width, mirroring how
/// the row degrades and truncates it (TS `getInlineTrailingWidth`). Pickers
/// use this to budget row content.
pub(crate) fn trailing_width(segments: &[&str], width: usize) -> usize {
    let inner_width = width.saturating_sub(2).max(1);
    let budget = inner_width.saturating_sub(5).max(1);
    let reduced = reduce_trailing_segments(segments, budget);
    if reduced.is_empty() {
        return 0;
    }
    str_width(&reduced.join(" · ")).min(budget)
}

/// Render the trailing cluster: segments joined with `" · "`, muted, shrunk
/// from the front and truncated to the row's trailing budget (TS
/// `MenuRow.getInlineTrailing`).
pub(crate) fn trailing_spans(theme: &Theme, segments: &[&str], inner_width: usize) -> Line {
    let budget = inner_width.saturating_sub(5).max(1);
    let reduced = reduce_trailing_segments(segments, budget);
    if reduced.is_empty() {
        return Vec::new();
    }
    let mut line = vec![theme.fg_span(ThemeColor::Muted, reduced.join(" · "))];
    line = truncate_line(&line, budget, "\u{2026}");
    line
}

/// One inline menu row (TS `MenuRow.renderContent`, inline mode): the `›`
/// marker, the primary cell, a filler gap, and the trailing cluster flush to
/// the right edge. Selected rows carry the soft selection background.
pub(crate) fn menu_row(
    theme: &Theme,
    width: usize,
    primary: Line,
    trailing: &[&str],
    selected: bool,
) -> Line {
    // Trailing rows run flush to the right edge; the trailing cell leaves a
    // two-column gap after the primary cell.
    let inner_width = width.saturating_sub(2).max(1);
    let trailing = trailing_spans(theme, trailing, inner_width);
    let trailing_width = crate::width::spans_width(&trailing);
    let gap = if trailing_width > 0 { 2 } else { 0 };
    let primary_width = inner_width.saturating_sub(trailing_width + gap).max(1);
    let mut primary = primary;
    if selected {
        primary = primary
            .into_iter()
            .map(|mut span| {
                span.style = span.style.add_modifier(ratatui::style::Modifier::BOLD);
                span
            })
            .collect();
    }
    let primary = truncate_line(&primary, primary_width, "\u{2026}");
    // The filler centers the trailing cluster against the right edge.
    let filler_width = inner_width
        .saturating_sub(crate::width::spans_width(&primary))
        .saturating_sub(trailing_width);
    let mut row: Line = Vec::with_capacity(primary.len() + trailing.len() + 4);
    row.push(Span::raw(if selected { "\u{203a}" } else { " " }));
    row.push(Span::raw(" "));
    row.extend(primary);
    if filler_width > 0 {
        row.push(Span::raw(" ".repeat(filler_width)));
    }
    row.extend(trailing);
    finish_menu_row(theme, row, width, selected)
}

/// The shared row finish: truncate to the width, pad so the selection
/// band spans the row, and patch the soft selection background.
fn finish_menu_row(theme: &Theme, row: Line, width: usize, selected: bool) -> Line {
    let mut row = truncate_line(&row, width, "");
    // Pad to the full width so the selection band spans the row.
    let used = crate::width::spans_width(&row);
    if used < width {
        row.push(Span::raw(" ".repeat(width - used)));
    }
    if selected {
        let style = theme.soft_selection_style();
        row = row
            .into_iter()
            .map(|mut span| {
                span.style = span.style.patch(style);
                span
            })
            .collect();
    }
    row
}

/// How far the selection hug trails past the text (TS
/// `OnboardingChoiceComponent`'s `ROW_TRAILING`).
pub(crate) const HUG_TRAILING: usize = 6;

/// The selection hug's floor (TS `MIN_ROW_WIDTH`).
pub(crate) const MIN_HUG_WIDTH: usize = 30;

/// The selected row's wash width (TS `OnboardingChoiceComponent.render`'s
/// `rowWidth`): the content plus a little trailing pad, floored at
/// [`MIN_HUG_WIDTH`] and capped at the pane width — never the full-width
/// band of the plain menu rows.
pub(crate) fn hug_width(content_width: usize, width: usize) -> usize {
    (content_width + HUG_TRAILING).max(MIN_HUG_WIDTH).min(width)
}

/// One hug row: the content truncated to the pane, the selected row
/// padded to its wash width and washed over the hug only (the
/// onboarding-highlight treatment — a little past the text, not the
/// whole terminal width).
pub(crate) fn hug_row(
    theme: &Theme,
    row: Line,
    content_width: usize,
    selected: bool,
    width: usize,
) -> Line {
    let mut row = truncate_line(&row, width, "");
    if !selected {
        return row;
    }
    let used = crate::width::spans_width(&row);
    let hug = hug_width(content_width, width);
    if used < hug {
        row.push(Span::raw(" ".repeat(hug - used)));
    }
    let wash = crate::onboarding::highlight_wash(theme);
    row.into_iter()
        .map(|mut span| {
            span.style = span.style.bg(wash);
            span
        })
        .collect()
}

/// The inline search field (TS `MenuSearchInput.render`, inline mode): a
/// full-width border rule, the field row, a border rule. The field is the
/// single-line input with its `"> "` prompt; an empty field shows the dim
/// placeholder with the caret on its first cell when focused.
pub(crate) fn search_field_lines(
    theme: &Theme,
    width: usize,
    value: &str,
    cursor: usize,
    focused: bool,
    placeholder: &str,
) -> Vec<Line> {
    let border = || vec![theme.fg_span(ThemeColor::BorderMuted, "\u{2500}".repeat(width.max(1)))];
    let field = render_input_field(theme, width, value, cursor, focused, placeholder);
    vec![border(), field, border()]
}

/// The field row: `" " + "> " + <input render at width-2>` (TS
/// `MenuSearchInput` inline composition).
fn render_input_field(
    theme: &Theme,
    width: usize,
    value: &str,
    cursor: usize,
    focused: bool,
    placeholder: &str,
) -> Line {
    let input_width = width.saturating_sub(2).max(1);
    let mut line: Line = vec![Span::raw(" "), Span::raw(FIELD_PROMPT)];
    if value.is_empty() {
        if focused {
            // The empty input renders its caret (a reversed space); the dim
            // placeholder trails it, so the field keeps the same left edge
            // as the rows below it.
            line.push(Span::styled(
                " ".to_string(),
                ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::REVERSED),
            ));
            line.push(theme.fg_span(ThemeColor::Dim, placeholder));
        } else {
            line.push(theme.fg_span(ThemeColor::Dim, placeholder));
        }
    } else {
        line.extend(input_render(theme, input_width, value, cursor, focused));
    }
    let mut line = truncate_line(&line, width, "");
    let used = crate::width::spans_width(&line);
    if used < width {
        line.push(Span::raw(" ".repeat(width - used)));
    }
    line
}

/// One input render (TS `Input.render`): prompt, the visible slice with the
/// caret (a reversed cell) at the cursor, and trailing padding.
fn input_render(theme: &Theme, width: usize, value: &str, cursor: usize, focused: bool) -> Line {
    let _ = theme;
    let available_width = width.saturating_sub(FIELD_PROMPT.len());
    if available_width == 0 {
        return vec![Span::raw(FIELD_PROMPT)];
    }
    // Cursor position in characters, clamped to the value.
    let cursor = cursor.min(value.chars().count());
    let total_width = str_width(value);
    let (visible, cursor_display) = if total_width < available_width {
        (value.to_string(), cursor)
    } else {
        // Horizontal scroll: keep the caret visible, centered otherwise.
        let scroll_width = if cursor == value.chars().count() {
            available_width.saturating_sub(1)
        } else {
            available_width
        };
        let cursor_col = str_width(&value.chars().take(cursor).collect::<String>());
        let start_col = if cursor_col < scroll_width / 2 {
            0
        } else if cursor_col > total_width.saturating_sub(scroll_width / 2) {
            total_width.saturating_sub(scroll_width)
        } else {
            cursor_col.saturating_sub(scroll_width / 2)
        };
        let visible = slice_by_chars(value, start_col, scroll_width);
        let before_cursor = slice_by_chars(value, start_col, cursor_col.saturating_sub(start_col));
        (visible, before_cursor.chars().count())
    };
    let chars: Vec<char> = visible.chars().collect();
    let before: String = chars[..cursor_display.min(chars.len())].iter().collect();
    let at = chars.get(cursor_display).copied().unwrap_or(' ');
    let after: String = if cursor_display < chars.len() {
        chars[cursor_display + 1..].iter().collect()
    } else {
        String::new()
    };
    let mut line = vec![Span::raw(before)];
    if focused {
        line.push(Span::styled(
            at.to_string(),
            ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::REVERSED),
        ));
    } else {
        line.push(Span::raw(at.to_string()));
    }
    if !after.is_empty() {
        line.push(Span::raw(after));
    }
    line
}

/// Slice a string by character count (TS `String.prototype.slice` here is
/// column-based in the reference; both agree for the ASCII field content).
fn slice_by_chars(text: &str, start_chars: usize, count: usize) -> String {
    text.chars().skip(start_chars).take(count).collect()
}

/// The inline list's visible-row count (TS `getMenuListLayout`, inline
/// shape: one row per item, no list padding, one scroll-indicator row when
/// the window cannot show everything).
pub(crate) fn menu_list_layout(
    viewport_rows: Option<usize>,
    preferred: usize,
    total: usize,
    reserved: usize,
    scroll_rows: usize,
) -> usize {
    let Some(rows) = viewport_rows else {
        return preferred;
    };
    let capacity = |extra: usize| rows.saturating_sub(reserved + extra);
    let without_scroll = capacity(0).min(preferred).max(1);
    let extra = if total > without_scroll {
        scroll_rows
    } else {
        0
    };
    if extra > 0 {
        capacity(extra).min(preferred).max(1)
    } else {
        without_scroll
    }
}
