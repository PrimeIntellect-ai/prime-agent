//! The inline menu panel: the ONE menu component every picker and
//! completion surface renders through. The inline paths of TS
//! `menu-panel.ts` — the bordered search field, the `›`-marker menu rows
//! with right-aligned trailing segments (muted or status-colored), the
//! shared truncate/pad budgeting — plus the status rows every menu frame
//! shares: the `(n/m)` scroll indicator, the no-match row, and the key
//! hint row. The `/model` picker, the `/mcp` connections view, the
//! provider selectors, the activity panel, and the editor's
//! slash-command/file completion dropdown all compose these primitives,
//! so selection highlight, padding, and status rows read as one visual
//! grammar across every menu.

use crate::theme::{Theme, ThemeColor};
use crate::width::{str_width, truncate_line};
use crate::{Line, Span};

/// The field prompt (TS `Input` renders `"> "`).
const FIELD_PROMPT: &str = "> ";

/// One right-aligned trailing segment of a menu row: `text` joined into the
/// row's trailing cluster, colored by the theme when the surface carries a
/// status vocabulary (mcp connection states), muted otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MenuSegment<'a> {
    pub text: &'a str,
    pub color: Option<ThemeColor>,
}

impl<'a> MenuSegment<'a> {
    /// A muted segment (the TS `MenuRow` inline trailing).
    pub fn muted(text: &'a str) -> Self {
        Self { text, color: None }
    }

    /// A status segment with its theme color.
    pub fn themed(color: ThemeColor, text: &'a str) -> Self {
        Self {
            text,
            color: Some(color),
        }
    }
}

/// Trailing segments are joined with `" · "` and shrink from the front when
/// the row is too narrow (TS `reduceInlineTrailingSegments`).
fn reduce_trailing_segments<'a>(
    segments: &[MenuSegment<'a>],
    budget: usize,
) -> Vec<MenuSegment<'a>> {
    let mut current: Vec<MenuSegment> = segments
        .iter()
        .copied()
        .filter(|segment| !segment.text.is_empty())
        .collect();
    while current.len() > 1 && str_width(&segments_text(&current)) > budget {
        current.remove(0);
    }
    current
}

fn segments_text(segments: &[MenuSegment<'_>]) -> String {
    segments
        .iter()
        .map(|segment| segment.text)
        .collect::<Vec<&str>>()
        .join(" · ")
}

/// Rendered width of a trailing cluster at the given row width, mirroring how
/// the row degrades and truncates it (TS `getInlineTrailingWidth`). Pickers
/// use this to budget row content.
pub(crate) fn trailing_width(segments: &[MenuSegment<'_>], width: usize) -> usize {
    let inner_width = width.saturating_sub(2).max(1);
    let budget = inner_width.saturating_sub(5).max(1);
    let reduced = reduce_trailing_segments(segments, budget);
    if reduced.is_empty() {
        return 0;
    }
    str_width(&segments_text(&reduced)).min(budget)
}

/// Render the trailing cluster: segments joined with `" · "`, shrunk from
/// the front and truncated to the row's trailing budget (TS
/// `MenuRow.getInlineTrailing`); each segment carries its own theme color,
/// muted by default.
pub(crate) fn trailing_spans(
    theme: &Theme,
    segments: &[MenuSegment<'_>],
    inner_width: usize,
) -> Line {
    let budget = inner_width.saturating_sub(5).max(1);
    let reduced = reduce_trailing_segments(segments, budget);
    if reduced.is_empty() {
        return Vec::new();
    }
    let mut line: Line = Vec::with_capacity(reduced.len() * 2);
    for (index, segment) in reduced.iter().enumerate() {
        if index > 0 {
            line.push(theme.fg_span(ThemeColor::Muted, " \u{b7} ".to_string()));
        }
        match segment.color {
            Some(color) => line.push(theme.fg_span(color, segment.text)),
            None => line.push(theme.fg_span(ThemeColor::Muted, segment.text)),
        }
    }
    truncate_line(&line, budget, "\u{2026}")
}

/// One inline menu row (TS `MenuRow.renderContent`, inline mode): the `›`
/// marker, the primary cell, a filler gap, and the trailing cluster flush to
/// the right edge. Selected rows carry the soft selection background.
pub(crate) fn menu_row(
    theme: &Theme,
    width: usize,
    primary: Line,
    trailing: &[MenuSegment<'_>],
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

/// One plain-text cell truncated and padded to its column budget by
/// display width (wide glyphs never overflow into the next column; no
/// ellipsis — the tables stay aligned, and the detail drill-ins carry
/// the full text).
pub(crate) fn plain_cell(text: &str, width: usize) -> String {
    crate::width::pad_cell(text, width)
}

/// Non-newline control characters become spaces (ANSI/OSC sequences in
/// daemon- or process-supplied text can never execute terminal control
/// operations when rendered); newlines stay for the wraps.
pub(crate) fn scrub_controls(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_control() && c != '\n' { ' ' } else { c })
        .collect::<String>()
}

/// The status-dot vocabulary (the operator's 2026-09-23 directive; TS
/// `subagent-summary-line`'s counts box `● running / ◐ idle /
/// ○ inactive`): the filled circle rides the live states (running,
/// active), the half circle the waiting ones (idle, paused), the open
/// circle the dead ones. The glyph is the state at a glance; the
/// surface's word rides beside it.
pub(crate) fn status_dot(status: &str) -> (&'static str, ThemeColor) {
    match status {
        "running" | "active" => ("\u{25cf}", ThemeColor::Success),
        "idle" | "paused" => ("\u{25d0}", ThemeColor::Warning),
        _ => ("\u{25cb}", ThemeColor::Dim),
    }
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

/// The scroll-indicator status row: the selection's position in the full
/// list, `  (n/m)` muted, aligned with the rows' inner column. Menus show
/// it once the window cannot hold every item (model picker, mcp view,
/// completion dropdown). Like every status row, it truncates to the
/// frame width, so a narrow overlay never spills past its dock.
pub(crate) fn scroll_row(theme: &Theme, width: usize, position: usize, total: usize) -> Line {
    let line = vec![theme.fg_span(ThemeColor::Muted, format!("  ({position}/{total})"))];
    truncate_line(&line, width, "")
}

/// The no-match status row: `  {message}` muted, aligned with the rows'
/// inner column, shown when a filter empties the list. Like every status
/// row, it truncates to the frame width.
pub(crate) fn no_match_row(theme: &Theme, width: usize, message: &str) -> Line {
    let line = vec![
        Span::raw("  "),
        theme.fg_span(ThemeColor::Muted, message.to_string()),
    ];
    truncate_line(&line, width, "")
}

/// The key-hint status row: ` {hint}` dim, truncated to the frame width.
/// Each surface composes its own hint text (its key vocabulary); the row's
/// look is the shared grammar.
pub(crate) fn hint_row(theme: &Theme, width: usize, hint: &str) -> Line {
    let line = vec![
        Span::raw(" "),
        theme.fg_span(ThemeColor::Dim, hint.to_string()),
    ];
    truncate_line(&line, width, "")
}

/// One detail-block row: the selected item's metadata under the list,
/// truncated to the frame width (marked) and padded to the full row; the
/// content's own spans carry the color and leading indent.
pub(crate) fn detail_row(theme: &Theme, width: usize, content: Line) -> Line {
    let _ = theme;
    let mut line = truncate_line(&content, width, "\u{2026}");
    let used = crate::width::spans_width(&line);
    if used < width {
        line.push(Span::raw(" ".repeat(width - used)));
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ColorMode, Theme};

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn row_text(line: &Line) -> String {
        line.iter().map(|span| span.content.as_str()).collect()
    }

    /// The table cell pads by GRAPHEME width: a multi-codepoint cluster
    /// (the family emoji is four scalars but renders one cell-picture)
    /// never pads short or overflows its column.
    #[test]
    fn plain_cell_pads_by_grapheme_width() {
        use unicode_segmentation::UnicodeSegmentation;
        let family = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}";
        assert_eq!(family.graphemes(true).count(), 1, "one cluster");
        let cell = plain_cell(family, 6);
        // One emoji cell-picture plus five pad columns — not eight.
        assert_eq!(str_width(&cell), 6, "the cell is exactly the budget");
        let text = format!("{cell}next");
        assert_eq!(crate::width::str_width(&text), 10, "the columns align");
    }

    #[test]
    fn menu_rows_carry_muted_and_status_trailing() {
        let theme = theme();
        let muted = [
            MenuSegment::muted("current"),
            MenuSegment::muted("provider"),
        ];
        let row = menu_row(&theme, 60, vec![Span::raw("label")], &muted, false);
        let text = row_text(&row);
        // Unselected rows carry the blank marker column.
        assert!(text.starts_with("  "));
        assert!(text.contains("label"));
        assert!(text.ends_with("current · provider"));
        let status = [MenuSegment::themed(ThemeColor::Success, "connected")];
        let row = menu_row(&theme, 60, vec![Span::raw("label")], &status, true);
        let text = row_text(&row);
        assert!(text.starts_with("\u{203a}"));
        assert!(text.ends_with("connected"));
    }

    #[test]
    fn status_rows_share_the_frame_grammar() {
        let theme = theme();
        assert_eq!(row_text(&scroll_row(&theme, 40, 3, 17)), "  (3/17)");
        assert_eq!(
            row_text(&no_match_row(&theme, 40, "No matching models")),
            "  No matching models"
        );
        let hint = hint_row(&theme, 60, "Enter select · Esc close");
        assert!(row_text(&hint).starts_with(" Enter select"));
    }

    /// Every status row truncates to the frame width: a narrow menu never
    /// emits a row wider than its dock (the completion overlay renders
    /// the rows straight into the editor dock, so an unclamped `(n/m)`
    /// would overwrite the adjacent terminal cells).
    #[test]
    fn status_rows_never_exceed_the_frame_width() {
        let theme = theme();
        for row in [
            scroll_row(&theme, 6, 1, 482),
            no_match_row(&theme, 6, "No matching commands"),
        ] {
            assert!(
                crate::width::spans_width(&row) <= 6,
                "the row clamps to the frame width: {row:?}"
            );
        }
    }

    #[test]
    fn trailing_segments_shrink_from_the_front() {
        let segments = [
            MenuSegment::muted("a-long-first-segment"),
            MenuSegment::muted("mid"),
            MenuSegment::muted("end"),
        ];
        // At a narrow width the front segments drop off until the joined
        // cluster fits the budget (width 12 -> inner 10 -> budget 5: only
        // "end" survives).
        assert_eq!(trailing_width(&segments, 12), 3);
        // Wide rows keep every segment.
        assert_eq!(trailing_width(&segments, 60), 32);
    }
}
