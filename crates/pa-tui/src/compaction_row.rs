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
    /// The summary as the compaction model generates it: one
    /// `compaction_summary_delta` event's text appended per event, from
    /// `compaction_start` (which resets it) to the `compaction_end` that
    /// resolves the streamed block into the durable summary row. Empty
    /// until the first delta arrives (the loader stands alone).
    pub summary: String,
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

/// The most wrapped rows the live streamed block renders: the block
/// follows the generation (a scrolling tail of the newest text, not the
/// summary's head), so a long summary never outgrows the status area.
pub const STREAM_BLOCK_MAX_ROWS: usize = 8;

/// The live streamed-summary block under the compaction loader (the
/// operator's "stream the compacted summary" feature): while the
/// compaction model generates the summary, the expanded view (`all`
/// detail) renders the accumulated text — one `compaction_summary_delta`
/// append at a time — nested on the branch grammar, exactly like the
/// expanded `◆ Context compacted` content that later replaces it: the
/// first row hangs off the loader row on the dim `╰─ ` gutter, every
/// continuation row on the four-column branch indent. Collapsed details
/// render nothing (the loader stands alone, exactly like TS), and the
/// settled `compaction_end` clears the whole block when its durable
/// summary row lands.
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
    // The wrap window: the block renders only the newest
    // [`STREAM_BLOCK_MAX_ROWS`] rows, so re-wrapping the whole growing
    // summary on every delta would be quadratic work for no visual gain.
    // Wrapping a tail window instead is exact: a text that fits in the
    // cap rows holds at most cap * (content_width + 1) chars — inside
    // the (cap + 1) * (content_width + 1) window, so it wraps whole and
    // unclamped — and a clamped window wraps to at least cap + 1 rows
    // (no row holds more than content_width chars plus its newline), so
    // every kept row's boundaries live entirely inside the window. Only
    // the window's first row can be a partial cut, and it always
    // scrolls out of the cap.
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
    // The tail follows the generation: render the newest rows, marking
    // the cut with a dim ellipsis when older rows scroll out of the cap
    // (a clamped window always wraps past the cap, so both the clipped
    // and the many-row shapes keep the marker).
    let truncated = wrapped.len() > STREAM_BLOCK_MAX_ROWS;
    let rows_to_paint = wrapped.len().saturating_sub(STREAM_BLOCK_MAX_ROWS)..;
    let mut painted: Vec<Line> = Vec::new();
    for (offset, line) in wrapped[rows_to_paint].iter().enumerate() {
        let mut row: Line = Vec::new();
        if truncated && offset == 0 {
            // The ellipsis marks the cut on the oldest kept row. Its two
            // columns come out of that row's own content — the row is
            // sliced to `content_width - 2` columns first — so the
            // prefix never pushes the line past the width and
            // `truncate_line` never clips the row's tail.
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
    fn text(&mut self, text: &str, style: ratatui::style::Style, width: usize) {
        match self {
            Self::Paint(output) => output.extend(crate::chat::render_text_rows(text, style, width)),
            Self::Count(count) => {
                if !text.trim().is_empty() {
                    *count +=
                        crate::width::wrapped_text_count(text, width.saturating_sub(2).max(1))
                            .max(1);
                }
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
    let summary = if summary.trim().is_empty() {
        "No summary was recorded for this compaction."
    } else {
        summary
    };
    rows.text("\u{25c6} Context compacted", header, width);
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
    // The expanded view: the raw summary through the markdown renderer
    // (TS passes `this.message.summary` untrimmed — the final paragraph row
    // keeps its trailing space), then the dim token metadata with the
    // optional focus. The expanded block hangs on the branch grammar
    // (Kevin/Sebastian product improvement beyond TS: the TS expansion
    // keeps the plain one-column chat inset): the first markdown row
    // carries the dim `\u{2570}\u{2500} ` gutter hanging off the `\u{25c6}`
    // header, every row after the matching indent, the metadata row on the
    // continuation indent.
    let content_width = crate::branch::branch_content_width(width);
    let mut md = crate::markdown::MarkdownStyle::from_theme(theme);
    md.body = body;
    match rows {
        SummaryRows::Count(count) => {
            *count += crate::markdown::markdown_row_count(summary, content_width, &md);
        }
        SummaryRows::Paint(output) => {
            let painted = crate::markdown::render_markdown(summary, content_width, &md);
            for row in crate::branch::branch_rows(painted, theme) {
                // At tiny widths the branch prefix alone (the chat margin
                // plus the gutter) outgrows the viewport, so clip before
                // padding: `pad_to` only pads, never truncates.
                let row = crate::width::truncate_line(&row, width, "");
                output.push(crate::chat::pad_to(
                    row,
                    width,
                    ratatui::style::Style::default(),
                ));
            }
        }
    }
    let focus = custom_instructions
        .filter(|instructions| !instructions.is_empty())
        .map(|instructions| format!(" \u{b7} focus: {instructions}"))
        .unwrap_or_default();
    // TS `Spacer(1)` between the markdown body and the metadata row.
    match rows {
        SummaryRows::Paint(output) => output.push(Vec::new()),
        SummaryRows::Count(count) => *count += 1,
    }
    continuation_text_rows(
        &format!("Compacted from {} tokens{focus}", grouped(tokens_before)),
        theme.fg_style(ThemeColor::Dim),
        width,
        rows,
    );
}

/// One row set on the branch continuation indent (the chat margin plus
/// the gutter depth): content wrapped at the branch content width, every
/// row prefixed with four plain spaces, padded to the full width.
fn continuation_text_rows(
    text: &str,
    style: ratatui::style::Style,
    width: usize,
    rows: &mut SummaryRows,
) {
    let content_width = crate::branch::branch_content_width(width);
    if let SummaryRows::Count(count) = rows {
        if !text.trim().is_empty() {
            *count += crate::width::wrapped_text_count(text, content_width);
        }
        return;
    }
    let wrapped = crate::width::wrap_text(text, content_width);
    let painted = wrapped
        .into_iter()
        .map(|line| {
            let mut row = vec![Span::raw(crate::branch::BRANCH_INDENT.to_string())];
            row.extend(
                line.into_iter()
                    .map(|span| Span::styled(span.content, style)),
            );
            // The continuation indent alone can outgrow a tiny viewport
            // (widths 0..=4 wrap to one column): clip before padding.
            let row = crate::width::truncate_line(&row, width, "");
            crate::chat::pad_to(row, width, ratatui::style::Style::default())
        })
        .collect::<Vec<Line>>();
    if let SummaryRows::Paint(output) = rows {
        output.extend(painted);
    }
}

/// The collapsed summary (TS `EventSummary`): whitespace collapsed, wrapped
/// at `width - 1`, capped at two lines with the ellipsis on the second.
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

    /// The live streamed block renders only in the expanded detail
    /// (`all`): collapsed details keep the loader alone (TS geometry),
    /// and the expanded block nests on the branch grammar — the gutter
    /// on the first content row hanging off the loader, the four-column
    /// continuation indent on every row after — exactly like the
    /// expanded `◆ Context compacted` content that settles it.
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

    /// The live block follows the generation: a summary longer than the
    /// cap renders its newest wrapped rows (a scrolling tail), with a
    /// dim ellipsis marking the cut — the status area never outgrows
    /// [`STREAM_BLOCK_MAX_ROWS`].
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
            render_compaction_summary("the story so far", 1234, Some("tests"), true, &theme(), 60);
        let text = plain(&rows);
        let meta = text
            .iter()
            .position(|row| row.trim() == "Compacted from 1,234 tokens \u{b7} focus: tests")
            .expect("the metadata row");
        // The metadata row sits on the branch continuation indent (the
        // chat margin plus the three-column gutter depth).
        assert!(
            text[meta].starts_with(crate::branch::BRANCH_INDENT),
            "{text:?}"
        );
        // TS `Spacer(1)` between the markdown body and the metadata.
        assert!(
            text[meta - 1].trim().is_empty(),
            "the spacer row precedes the metadata: {text:?}"
        );
    }

    #[test]
    fn summary_row_expanded_renders_markdown_body() {
        // The expanded block hangs on the branch grammar (the
        // Kevin/Sebastian product improvement beyond TS: the TS `new
        // Markdown(summary, 1, 0, ...)` keeps the plain one-column chat
        // inset): the first markdown row carries the dim `\u{2570}\u{2500} `
        // gutter hanging off the `\u{25c6}` header, every row after the
        // matching indent, the metadata row on the continuation indent.
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
        assert_eq!(
            text[1],
            format!(" {}Summary", crate::branch::BRANCH_GUTTER),
            "the guttered heading row: {text:?}"
        );
        // TS markdown pushes a blank row between adjacent blocks (the
        // heading and the paragraph share no blank source line, but
        // `renderToken` still separates them); the TS expanded frame shows
        // exactly this seam.
        assert_eq!(text[2].trim(), "", "the heading/paragraph seam: {text:?}");
        assert_eq!(
            text[3],
            format!("{}the session story", crate::branch::BRANCH_INDENT)
        );
        assert_eq!(text[4].trim(), "", "the Spacer(1) row: {text:?}");
        assert_eq!(
            text[5],
            format!("{}Compacted from 100 tokens", crate::branch::BRANCH_INDENT),
            "the metadata row: {text:?}"
        );
        assert_eq!(text.len(), 6, "no extra rows: {text:?}");
        // The gutter is dim; the markdown rows keep their own block
        // styles (headings the heading color, paragraphs the summary
        // body color); the continuation indent stays plain.
        assert_eq!(rows[1][1].style, theme().fg_style(ThemeColor::Dim));
        assert_eq!(rows[3][0].style, ratatui::style::Style::default());
        assert_eq!(rows[5][0].style, ratatui::style::Style::default());
    }

    #[test]
    fn expanded_branch_rows_never_overflow_narrow_viewports() {
        // Widths 0..=4 wrap the markdown to one column, then the branch
        // prefix (the chat margin plus the gutter) alone is wider than the
        // viewport: the painted branch rows must clip to `width`, never
        // overflow it. The header rows keep `render_text_rows`'s own
        // geometry (outside this fix), so the check targets the branch
        // block rows that follow them.
        let theme = theme();
        let header = theme.fg_style(ThemeColor::RefinementHeader);
        for width in 0..=4usize {
            let rows = render_compaction_summary(
                "## Summary\nthe session story",
                100,
                None,
                true,
                &theme,
                width,
            );
            let header_rows =
                crate::chat::render_text_rows("\u{25c6} Context compacted", header, width);
            assert!(
                rows.len() > header_rows.len(),
                "width={width} renders the branch block after the header"
            );
            for row in &rows[header_rows.len()..] {
                let used: usize = row.iter().map(|span| str_width(&span.content)).sum();
                assert!(used <= width, "width={width} row is {used} cols wide");
            }
        }
    }

    #[test]
    fn digits_group_with_commas() {
        assert_eq!(grouped(0), "0");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(1234), "1,234");
        assert_eq!(grouped(12_345_678), "12,345,678");
    }
    #[test]
    fn summary_geometry_matches_render() {
        let theme = theme();
        for summary in [
            "",
            "   ",
            "plain text\n more words",
            "界e\u{301} 👩‍💻 end",
            "## heading\nbody  ",
            "- first\n- second",
            "```python\nprint(1)\n```",
            "| a | b |\n|---|---|\n| wide word | 界 |",
            "> quote\n\n---",
        ] {
            for width in 0..=80 {
                for expanded in [false, true] {
                    for focus in [None, Some(""), Some("a long focus with words and 界")] {
                        let painted = render_compaction_summary(
                            summary, 12345, focus, expanded, &theme, width,
                        );
                        assert_eq!(
                            count_compaction_summary(
                                summary, 12345, focus, expanded, &theme, width
                            ),
                            painted.len(),
                            "summary={summary:?} width={width} expanded={expanded}"
                        );
                    }
                }
            }
        }
    }
}
