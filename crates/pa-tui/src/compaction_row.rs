//! Compaction feedback rows: the `◆ Context compacted` transcript row
//! with its collapsed summary, and the live `Compacting context...`
//! loader that replaces the working loader while a compaction runs.

use crate::info_commands::grouped;
use crate::theme::{Theme, ThemeColor};
use crate::width::{str_width, truncate_line, wrap_text};
use crate::{Line, Span};

/// Why a compaction runs (TS `CompactionOutcomeReason` on the wire events).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionReason {
    /// `/compact` (the session-command path).
    Manual,
    /// The model requested compaction at a turn boundary.
    Requested,
    /// Auto-compaction after a context overflow.
    Overflow,
    /// Auto-compaction at the context-usage threshold.
    Threshold,
}

impl CompactionReason {
    /// Parse the wire `reason` field (unknown values fall back to
    /// `manual`).
    #[must_use]
    pub fn parse(reason: &str) -> Self {
        match reason {
            "requested" => CompactionReason::Requested,
            "overflow" => CompactionReason::Overflow,
            "threshold" => CompactionReason::Threshold,
            _ => CompactionReason::Manual,
        }
    }

    /// The loader label: `focus` is the truncated custom instructions,
    /// `cancel_hint` the resolved `app.clear` key text.
    #[must_use]
    pub fn loader_label(self, focus: Option<&str>, cancel_hint: &str) -> String {
        let focus = focus
            .map(|focus| format!(" (focus: {focus})"))
            .unwrap_or_default();
        let label = match self {
            CompactionReason::Manual => format!("Compacting context{focus}..."),
            CompactionReason::Requested => {
                format!("Agent requested compaction, compacting context{focus}...")
            }
            CompactionReason::Overflow => {
                "Context overflow detected, Auto-compacting...".to_string()
            }
            CompactionReason::Threshold => "Auto-compacting...".to_string(),
        };
        format!("{label} ({cancel_hint} to cancel)")
    }
}

/// The live compaction loader (TS `autoCompactionLoader`): owns the status
/// area from `compaction_start` to `compaction_end`.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionState {
    /// Why the compaction runs (the wire event's `reason`).
    pub reason: CompactionReason,
    /// `/compact <instructions>` focus text (truncated for the label).
    pub custom_instructions: Option<String>,
    /// The summary as the compaction model generates it: one `compaction_summary_delta`
    /// append per event, from `compaction_start` to the `compaction_end` that resolves the
    /// block into the durable row. Empty until the first delta arrives.
    pub summary: String,
}

/// The compaction loader rows (both muted): `["", spinner + message]` with the reason
/// text, the custom instructions truncated to 60 columns, and the resolved `app.clear` cancel hint.
#[must_use]
pub fn render_compaction_loader(
    state: &CompactionState,
    frame: usize,
    cancel_hint: &str,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let muted = theme.fg_style(ThemeColor::Muted);
    let spinner = super::chat::LOADER_FRAMES[frame % super::chat::LOADER_FRAMES.len()];
    let focus = state
        .custom_instructions
        .as_deref()
        .filter(|instructions| !instructions.is_empty())
        .map(|instructions| {
            let truncated =
                truncate_line(&vec![Span::raw(instructions.to_string())], 60, "\u{2026}");
            truncated
                .iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        });
    let label = state.reason.loader_label(focus.as_deref(), cancel_hint);
    let mut row: Line = vec![Span::styled(
        " ".to_string(),
        ratatui::style::Style::default(),
    )];
    row.push(Span::styled(spinner.to_string(), muted));
    // The gap between the spinner and the label is unstyled (TS's row resets the pen
    // between the two muted runs) — a styled space would merge into one SGR run and
    // change the emitted frame.
    row.push(Span::raw(" ".to_string()));
    row.push(Span::styled(label, muted));
    let used: usize = row.iter().map(|span| str_width(&span.content)).sum();
    if used < width {
        row.push(Span::styled(
            " ".repeat(width - used),
            ratatui::style::Style::default(),
        ));
    }
    vec![Vec::new(), row]
}

/// The most wrapped rows the live streamed block renders: the block follows the generation
/// (a scrolling tail of the newest text), so a long summary never outgrows the status area.
pub const STREAM_BLOCK_MAX_ROWS: usize = 8;

/// The live streamed-summary block under the compaction loader: the expanded view (`all`)
/// renders the accumulated text, one `compaction_summary_delta` append at a time, nested on
/// the branch grammar; a settled `compaction_end` clears the block.
pub fn render_compaction_stream(
    state: &CompactionState,
    expanded: bool,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    if !expanded || state.summary.trim().is_empty() {
        return Vec::new();
    }
    let body = theme.fg_style(ThemeColor::RefinementSummary);
    let content_width = crate::branch::branch_content_width(width);
    // Re-wrapping the whole growing summary on every delta would be quadratic work;
    // wrapping a tail window is exact — a clamped window wraps to at least cap + 1
    // rows, so only the window's first row can be a partial cut, and it scrolls out.
    let window = (STREAM_BLOCK_MAX_ROWS + 1) * (content_width + 1);
    let total_chars = state.summary.chars().count();
    let clamped = total_chars > window;
    let text = if clamped {
        state
            .summary
            .chars()
            .skip(total_chars - window)
            .collect::<String>()
    } else {
        state.summary.clone()
    };
    let wrapped = crate::width::wrap_text(&text, content_width);
    // The marker must reflect dropped CONTENT, not the kept row count: the scalar window
    // bounds Unicode scalars while rows bound display columns, so a combining-mark-heavy
    // suffix can clamp yet wrap to fewer rows than the cap.
    let truncated = clamped || wrapped.len() > STREAM_BLOCK_MAX_ROWS;
    let rows_to_paint = wrapped.len().saturating_sub(STREAM_BLOCK_MAX_ROWS)..;
    let mut painted: Vec<Line> = Vec::new();
    for (offset, line) in wrapped[rows_to_paint].iter().enumerate() {
        let mut row: Line = Vec::new();
        if truncated && offset == 0 {
            // The ellipsis marks the cut on the oldest kept row: its two columns come out
            // of that row's own content, sliced to `content_width - 2` first.
            row.push(Span::styled(
                "\u{2026} ".to_string(),
                theme.fg_style(ThemeColor::Dim),
            ));
            row.extend(crate::width::slice_line_by_column(
                &line
                    .iter()
                    .map(|span| Span::styled(span.content.clone(), body))
                    .collect::<Line>(),
                0,
                content_width.saturating_sub(2),
            ));
        } else {
            row.extend(
                line.iter()
                    .map(|span| Span::styled(span.content.clone(), body)),
            );
        }
        painted.push(row);
    }
    crate::branch::branch_rows(painted, theme)
        .into_iter()
        .map(|row| {
            // The branch prefix alone can outgrow a tiny viewport, so
            // clip before padding (the expanded summary's own rule).
            let row = crate::width::truncate_line(&row, width, "");
            crate::chat::pad_to(row, width, ratatui::style::Style::default())
        })
        .collect()
}

/// The `◆ Context compacted` transcript row: the header, the dim metadata on the header
/// row when expanded, then the summary. Collapsed: the whitespace-collapsed `EventSummary`,
/// capped at two lines. Expanded: the full markdown summary under the branch gutter.
#[must_use]
pub fn render_compaction_summary(
    summary: &str,
    tokens_before: u64,
    custom_instructions: Option<&str>,
    expanded: bool,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let mut rows = SummaryRows::Paint(Vec::new());
    visit_summary(
        summary,
        tokens_before,
        custom_instructions,
        expanded,
        theme,
        width,
        &mut rows,
    );
    match rows {
        SummaryRows::Paint(output) => output,
        SummaryRows::Count(_) => unreachable!("paint sink"),
    }
}

pub(crate) fn count_compaction_summary(
    summary: &str,
    tokens_before: u64,
    custom_instructions: Option<&str>,
    expanded: bool,
    theme: &Theme,
    width: usize,
) -> usize {
    let mut rows = SummaryRows::Count(0);
    visit_summary(
        summary,
        tokens_before,
        custom_instructions,
        expanded,
        theme,
        width,
        &mut rows,
    );
    match rows {
        SummaryRows::Count(count) => count,
        SummaryRows::Paint(_) => unreachable!("count sink"),
    }
}

enum SummaryRows {
    Paint(Vec<Line>),
    Count(usize),
}

impl SummaryRows {
    /// The `Text(spans, 1, 0)` header row set: spans wrapped at `width - 2`,
    /// one margin column, padded to the full width with the default style.
    fn header(&mut self, line: &Line, width: usize) {
        match self {
            Self::Paint(output) => {
                output.extend(crate::custom_message::render::text_rows(line, width));
            }
            Self::Count(count) => {
                *count += crate::custom_message::geometry::text_row_count(line, width);
            }
        }
    }
}

fn visit_summary(
    summary: &str,
    tokens_before: u64,
    custom_instructions: Option<&str>,
    expanded: bool,
    theme: &Theme,
    width: usize,
    rows: &mut SummaryRows,
) {
    let header = theme.fg_style(ThemeColor::RefinementHeader);
    let body = theme.fg_style(ThemeColor::RefinementSummary);
    let dim = theme.fg_style(ThemeColor::Dim);
    let summary = if summary.trim().is_empty() {
        "No summary was recorded for this compaction."
    } else {
        summary
    };
    let focus = custom_instructions
        .filter(|instructions| !instructions.is_empty())
        .map(|instructions| format!(" \u{b7} focus: {instructions}"))
        .unwrap_or_default();
    let mut line: Line = vec![Span::styled("\u{25c6} Context compacted", header)];
    if expanded {
        line.push(Span::styled(
            format!(
                " \u{b7} Compacted from {} tokens{focus}",
                grouped(tokens_before)
            ),
            dim,
        ));
    }
    rows.header(&line, width);
    if !expanded {
        let collapsed = summary.split_whitespace().collect::<Vec<_>>().join(" ");
        match rows {
            SummaryRows::Paint(output) => {
                output.extend(collapsed_summary_rows(&collapsed, body, width));
            }
            SummaryRows::Count(count) => {
                *count +=
                    crate::width::wrapped_text_count(&collapsed, width.saturating_sub(1).max(1))
                        .min(2);
            }
        }
        return;
    }
    // The expanded view: the raw summary through the markdown renderer (untrimmed — the
    // final paragraph row keeps its trailing space) under the branch grammar: the first
    // markdown row carries the dim gutter, every row after the matching indent.
    let mut md = crate::markdown::MarkdownStyle::from_theme(theme);
    md.body = body;
    match rows {
        SummaryRows::Count(count) => {
            *count += crate::branch::branch_markdown_count(summary, &md, width);
        }
        SummaryRows::Paint(output) => {
            output.extend(crate::branch::branch_markdown(summary, &md, theme, width));
        }
    }
}

/// The collapsed summary: whitespace collapsed, wrapped at `width - 1`,
/// capped at two lines with the ellipsis on the second.
fn collapsed_summary_rows(summary: &str, style: ratatui::style::Style, width: usize) -> Vec<Line> {
    let content_width = width.saturating_sub(1).max(1);
    let wrapped = wrap_text(summary, content_width);
    let mut lines: Vec<String> = wrapped
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect();
    if lines.len() > 2 {
        lines.truncate(2);
        let second = vec![Span::raw(format!("{} \u{2026}", lines[1]))];
        let truncated = truncate_line(&second, content_width, "\u{2026}");
        lines[1] = truncated
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
    }
    lines
        .into_iter()
        .map(|line| {
            crate::chat::pad_to(
                vec![Span::styled(format!(" {line}"), style)],
                width,
                ratatui::style::Style::default(),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ColorMode, Theme};

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn plain(rows: &[Line]) -> Vec<String> {
        rows.iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
            })
            .map(|row| row.trim_end().to_string())
            .collect()
    }

    /// The label of one rendered loader row (spinner, margin, then the
    /// message text).
    fn loader_text(state: &CompactionState, cancel_hint: &str) -> String {
        let rows = render_compaction_loader(state, 0, cancel_hint, &theme(), 80);
        plain(&rows)[1].trim().to_string()
    }

    fn state(reason: CompactionReason, custom_instructions: Option<String>) -> CompactionState {
        CompactionState {
            reason,
            custom_instructions,
            summary: String::new(),
        }
    }

    fn streamed_state(reason: CompactionReason, summary: &str) -> CompactionState {
        CompactionState {
            reason,
            custom_instructions: None,
            summary: summary.to_string(),
        }
    }

    #[test]
    fn loader_label_matches_ts() {
        assert_eq!(
            loader_text(
                &state(
                    CompactionReason::Manual,
                    Some("focus on the goal".to_string())
                ),
                "Ctrl+C"
            ),
            "\u{280b} Compacting context (focus: focus on the goal)... (Ctrl+C to cancel)"
        );
        assert_eq!(
            loader_text(&state(CompactionReason::Manual, None), "Ctrl+C"),
            "\u{280b} Compacting context... (Ctrl+C to cancel)"
        );
        assert_eq!(
            loader_text(&state(CompactionReason::Requested, None), "Ctrl+C"),
            "\u{280b} Agent requested compaction, compacting context... (Ctrl+C to cancel)"
        );
        assert_eq!(
            loader_text(&state(CompactionReason::Overflow, None), "Ctrl+C"),
            "\u{280b} Context overflow detected, Auto-compacting... (Ctrl+C to cancel)"
        );
        assert_eq!(
            loader_text(&state(CompactionReason::Threshold, None), "Ctrl+C"),
            "\u{280b} Auto-compacting... (Ctrl+C to cancel)"
        );
    }

    /// Collapsed details keep the loader alone; the expanded block nests like the settled content.
    #[test]
    fn stream_block_renders_expanded_only_on_the_branch_grammar() {
        let state = streamed_state(
            CompactionReason::Threshold,
            "Summary line one.\nSecond line.",
        );
        // Collapsed details: nothing (the loader stands alone).
        assert!(render_compaction_stream(&state, false, &theme(), 80).is_empty());
        // An empty live summary: nothing yet (no delta arrived).
        let empty = CompactionState {
            reason: CompactionReason::Threshold,
            custom_instructions: None,
            summary: String::new(),
        };
        assert!(render_compaction_stream(&empty, true, &theme(), 80).is_empty());

        let rows = render_compaction_stream(&state, true, &theme(), 80);
        let text = plain(&rows);
        assert_eq!(text.len(), 2, "one wrapped row per summary line: {text:?}");
        assert!(
            text[0].starts_with(&format!(" {}", crate::branch::BRANCH_GUTTER)),
            "the first content row hangs off the loader on the branch gutter: {text:?}"
        );
        assert!(text[0].contains("Summary line one."));
        assert!(
            text[1].starts_with(crate::branch::BRANCH_INDENT),
            "continuation rows sit on the branch indent: {text:?}"
        );
        assert!(text[1].contains("Second line."));
    }

    /// The status area never outgrows [`STREAM_BLOCK_MAX_ROWS`].
    #[test]
    fn stream_block_follows_the_generation_tail() {
        let summary: String = (0..40)
            .map(|index| format!("generated line {index}."))
            .collect::<Vec<_>>()
            .join("\n");
        let state = streamed_state(CompactionReason::Threshold, &summary);
        let rows = render_compaction_stream(&state, true, &theme(), 80);
        assert_eq!(rows.len(), STREAM_BLOCK_MAX_ROWS);
        let text = plain(&rows);
        assert!(
            text[0].starts_with(&format!(" {}\u{2026}", crate::branch::BRANCH_GUTTER))
                || text[0].contains('\u{2026}'),
            "the cut tail is marked: {text:?}"
        );
        // The tail shows the NEWEST rows: the last rendered row carries
        // the summary's final line.
        assert!(
            text.last()
                .is_some_and(|row| row.contains("generated line 39.")),
            "the block follows the generation: {text:?}"
        );
        assert!(
            !text.iter().any(|row| row.contains("generated line 0.")),
            "the oldest rows scrolled out of the cap: {text:?}"
        );
    }

    #[test]
    fn stream_block_marks_the_cut_even_when_the_clamped_suffix_is_few_rows() {
        // Combining marks: each base char carries a zero-width mark, so the scalar count
        // doubles while the display columns stay one per pair.
        let mut summary = String::new();
        for _ in 0..400 {
            summary.push('x');
            summary.push('\u{0301}'); // combining acute accent
        }
        let state = streamed_state(CompactionReason::Threshold, &summary);
        let rows = render_compaction_stream(&state, true, &theme(), 80);
        let text = plain(&rows);
        // The scalar window clamps the 800-scalar summary — but the
        // invariant under test is the marker on the first rendered row.
        assert!(
            text.first().is_some_and(|row| row.contains('\u{2026}')),
            "the clamped cut shows its ellipsis: {text:?}"
        );
        assert!(
            rows.len() <= STREAM_BLOCK_MAX_ROWS,
            "the cap bounds the block: {text:?}"
        );
        // And a SHORT combining-mark summary (inside the window, at most
        // a few rows) stays unmarked — nothing was dropped.
        let mut short = String::new();
        for _ in 0..20 {
            short.push('x');
            short.push('\u{0301}');
        }
        let state = streamed_state(CompactionReason::Threshold, &short);
        let rows = render_compaction_stream(&state, true, &theme(), 80);
        let text = plain(&rows);
        assert!(
            !text.iter().any(|row| row.contains('\u{2026}')),
            "nothing was dropped, no marker: {text:?}"
        );
    }

    #[test]
    fn loader_label_truncates_long_focus() {
        let long = "x".repeat(80);
        let label = loader_text(&state(CompactionReason::Manual, Some(long)), "Ctrl+C");
        assert!(
            label.contains(&format!("(focus: {}…)", "x".repeat(59))),
            "{label}"
        );
    }

    #[test]
    fn loader_rows_match_ts_geometry() {
        let state = CompactionState {
            reason: CompactionReason::Manual,
            custom_instructions: None,
            summary: String::new(),
        };
        let rows = render_compaction_loader(&state, 0, "Ctrl+C", &theme(), 80);
        assert_eq!(rows.len(), 2, "TS Loader renders a blank then the row");
        let text = plain(&rows);
        assert!(text[1].contains("Compacting context... (Ctrl+C to cancel)"));
        // One margin column, then the spinner (the working loader's row
        // geometry), all muted.
        assert!(text[1].starts_with(&format!(" {}", crate::chat::LOADER_FRAMES[0])));
    }

    #[test]
    fn summary_row_collapsed_shape() {
        let rows = render_compaction_summary(
            "The session covered:\n  - task one\n  - task two",
            12345,
            None,
            false,
            &theme(),
            60,
        );
        let text = plain(&rows);
        assert_eq!(text[0].trim(), "\u{25c6} Context compacted");
        // Whitespace collapsed, one leading inset column, capped at 2 lines.
        assert_eq!(text[1].trim(), "The session covered: - task one - task two");
        assert_eq!(text.len(), 2, "a short summary renders no third line");
    }

    #[test]
    fn summary_row_truncates_long_summaries() {
        let summary = (0..40)
            .map(|i| format!("word{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        let rows = render_compaction_summary(&summary, 100, None, false, &theme(), 40);
        let text = plain(&rows);
        assert_eq!(text.len(), 3, "header + two summary lines");
        assert!(
            text[2].ends_with("\u{2026}"),
            "the second line carries the ellipsis: {:?}",
            text[2]
        );
    }

    #[test]
    fn summary_row_empty_summary_falls_back() {
        let rows = render_compaction_summary("", 100, None, false, &theme(), 60);
        let text = plain(&rows);
        assert_eq!(
            text[1].trim(),
            "No summary was recorded for this compaction."
        );
    }

    #[test]
    fn summary_row_expanded_metadata() {
        let rows =
            render_compaction_summary("the story so far", 1234, Some("tests"), true, &theme(), 80);
        let header = "\u{25c6} Context compacted";
        let meta = " \u{b7} Compacted from 1,234 tokens \u{b7} focus: tests";
        let used = 1 + str_width(header) + str_width(meta);
        assert_eq!(
            rows[0],
            vec![
                Span::raw(" "),
                Span::styled(header, theme().fg_style(ThemeColor::RefinementHeader)),
                Span::styled(meta, theme().fg_style(ThemeColor::Dim)),
                Span::raw(" ".repeat(80 - used)),
            ],
            "{rows:?}"
        );
    }

    /// The body hangs on the branch grammar, and nothing else renders below it.
    #[test]
    fn summary_row_expanded_renders_markdown_body() {
        let rows = render_compaction_summary(
            "## Summary\nthe session story",
            100,
            None,
            true,
            &theme(),
            60,
        );
        let text = plain(&rows);
        assert_eq!(
            text,
            vec![
                " \u{25c6} Context compacted \u{b7} Compacted from 100 tokens",
                format!(" {}Summary", crate::branch::BRANCH_GUTTER).as_str(),
                // TS markdown pushes a blank row between adjacent blocks (the heading and the
                // paragraph share no blank source line, but `renderToken` still separates them).
                "",
                format!("{}the session story", crate::branch::BRANCH_INDENT).as_str(),
            ],
            "no extra rows: {text:?}"
        );
        // The gutter is dim; the markdown rows keep their own block styles (headings the
        // heading color, paragraphs the summary body color); the continuation indent stays plain.
        assert_eq!(rows[1][1].style, theme().fg_style(ThemeColor::Dim));
        assert_eq!(rows[3][0].style, ratatui::style::Style::default());
    }

    #[test]
    fn digits_group_with_commas() {
        assert_eq!(grouped(0), "0");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(1234), "1,234");
        assert_eq!(grouped(12_345_678), "12,345,678");
    }
}
