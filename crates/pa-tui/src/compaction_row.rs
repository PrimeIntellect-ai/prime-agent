//! Compaction feedback rows (TS `compaction-summary-message.ts` +
//! `compaction-outcome-message.ts` + the compaction loader from
//! `interactive-mode.ts` `startCompactionLoader`): the `◆ Context compacted`
//! transcript row with its collapsed summary, and the live
//! `Compacting context...` loader that replaces the working loader while a
//! compaction runs.

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
    /// Parse the wire `reason` field (unknown values fall back to the TS
    /// auto-compaction label shape's common ancestor: `manual`).
    pub fn parse(reason: &str) -> Self {
        match reason {
            "requested" => CompactionReason::Requested,
            "overflow" => CompactionReason::Overflow,
            "threshold" => CompactionReason::Threshold,
            _ => CompactionReason::Manual,
        }
    }

    /// The loader label (TS `startCompactionLoader`): `focus` is the
    /// truncated custom instructions, `cancel_hint` the resolved
    /// `app.clear` key text.
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
}

/// The compaction loader rows (TS `Loader`: `["", spinner + message]`, both
/// muted — the compaction loader colors spinner and text `muted`). The label
/// is TS `startCompactionLoader`'s: the reason text, the custom instructions
/// truncated to 60 columns as the focus (`truncateToWidth(..., 60, "…")`),
/// and the resolved `app.clear` cancel hint.
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
    // The gap between the spinner and the label is unstyled (TS's row
    // resets the pen between the two muted runs) — a styled space would
    // merge into one SGR run and change the emitted frame.
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

/// The `◆ Context compacted` transcript row (TS
/// `CompactionSummaryMessageComponent`, an `ExpandableEventMessage`): the
/// header line in `refinementHeader`, then the summary in
/// `refinementSummary`. Collapsed (detail below `all`, TS
/// `setExpanded(false)`): the whitespace-collapsed `EventSummary`, wrapped
/// at one column of inset, capped at two lines with an ellipsis.
/// Expanded (TS `setExpanded(true)`, the Ctrl+O `all` level): the full
/// markdown summary, a `Spacer(1)`, then the dim `Compacted from N tokens`
/// metadata row with the optional focus.
pub fn render_compaction_summary(
    summary: &str,
    tokens_before: u64,
    custom_instructions: Option<&str>,
    expanded: bool,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let header = theme.fg_style(ThemeColor::RefinementHeader);
    let body = theme.fg_style(ThemeColor::RefinementSummary);
    let summary = if summary.trim().is_empty() {
        "No summary was recorded for this compaction."
    } else {
        summary
    };
    let mut rows: Vec<Line> = Vec::new();
    rows.extend(crate::chat::render_text_rows(
        "\u{25c6} Context compacted",
        header,
        width,
    ));
    if !expanded {
        rows.extend(collapsed_summary_rows(summary, body, width));
        return rows;
    }
    // The expanded view: the raw summary through the markdown renderer
    // (TS passes `this.message.summary` untrimmed — the final paragraph row
    // keeps its trailing space), then the dim token metadata with the
    // optional focus.
    let content_width = width.saturating_sub(2).max(1);
    let mut md = crate::markdown::MarkdownStyle::from_theme(theme);
    md.body = body;
    for line in crate::markdown::render_markdown(summary, content_width, &md) {
        let mut row: Line = vec![Span::raw(" ".to_string())];
        row.extend(line);
        rows.push(crate::chat::pad_to(
            row,
            width,
            ratatui::style::Style::default(),
        ));
    }
    let focus = custom_instructions
        .filter(|instructions| !instructions.is_empty())
        .map(|instructions| format!(" \u{b7} focus: {instructions}"))
        .unwrap_or_default();
    // TS `Spacer(1)` between the markdown body and the metadata row.
    rows.push(Vec::new());
    rows.extend(crate::chat::render_text_rows(
        &format!("Compacted from {} tokens{focus}", grouped(tokens_before)),
        theme.fg_style(ThemeColor::Dim),
        width,
    ));
    rows
}

/// The collapsed summary (TS `EventSummary`): whitespace collapsed, wrapped
/// at `width - 1`, capped at two lines with the ellipsis on the second.
fn collapsed_summary_rows(summary: &str, style: ratatui::style::Style, width: usize) -> Vec<Line> {
    let content_width = width.saturating_sub(1).max(1);
    let collapsed = summary.split_whitespace().collect::<Vec<_>>().join(" ");
    let wrapped = wrap_text(&collapsed, content_width);
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
            render_compaction_summary("the story so far", 1234, Some("tests"), true, &theme(), 60);
        let text = plain(&rows);
        let meta = text
            .iter()
            .position(|row| row.trim() == "Compacted from 1,234 tokens \u{b7} focus: tests")
            .expect("the metadata row");
        // TS `Spacer(1)` between the markdown body and the metadata.
        assert!(
            text[meta - 1].trim().is_empty(),
            "the spacer row precedes the metadata: {text:?}"
        );
    }

    #[test]
    fn summary_row_expanded_renders_markdown_body() {
        // TS `new Markdown(summary, 1, 0, markdownTheme, { color:
        // refinementSummary })`: the heading renders on its own row in the
        // summary color, not flattened like the collapsed `EventSummary`.
        let rows = render_compaction_summary(
            "## Summary\nthe session story",
            100,
            None,
            true,
            &theme(),
            60,
        );
        let text = plain(&rows);
        assert_eq!(text[0].trim(), "\u{25c6} Context compacted");
        assert_eq!(text[1].trim(), "Summary", "the heading row: {text:?}");
        // TS markdown pushes a blank row between adjacent blocks (the
        // heading and the paragraph share no blank source line, but
        // `renderToken` still separates them); the TS expanded frame shows
        // exactly this seam.
        assert_eq!(text[2].trim(), "", "the heading/paragraph seam: {text:?}");
        assert_eq!(text[3].trim(), "the session story");
        assert_eq!(text[4].trim(), "", "the Spacer(1) row: {text:?}");
        assert_eq!(
            text[5].trim(),
            "Compacted from 100 tokens",
            "the metadata row: {text:?}"
        );
        assert_eq!(text.len(), 6, "no extra rows: {text:?}");
    }

    #[test]
    fn digits_group_with_commas() {
        assert_eq!(grouped(0), "0");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(1234), "1,234");
        assert_eq!(grouped(12_345_678), "12,345,678");
    }
}
