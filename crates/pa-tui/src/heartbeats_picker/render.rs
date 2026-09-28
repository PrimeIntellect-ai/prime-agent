//! The render concern (moved with its concern): the column geometry and its width
//! caps, the list's header/hint/error chrome, the detail drill-in's pair block, the
//! row's primary text, and the action rows the panes render with.

use super::*;

/// The table's column width caps: the schedule expression and the label
/// shrink to their content, the next-run column is the fixed natural
/// language cell, and the status word keeps its own width.
const INTERVAL_CAP: usize = 18;
const LABEL_CAP: usize = 32;
/// The next-run column's fixed cell: wide enough for its header and every
/// countdown the schedule can produce (the next run is bounded within a
/// year, so at most "in 365d").
const NEXT_RUN_CELL: usize = 8;

/// The delivery word (TS: `follow_up` renders `follow-up`).
fn delivery_label(entry: &HeartbeatEntry) -> &'static str {
    if entry.job.delivery_mode.as_deref() == Some("follow_up") {
        "follow-up"
    } else {
        "steer"
    }
}

/// The detail drill-in's labeled pairs (the `/model` picker's
/// detail-block idiom): who created the heartbeat and the structured
/// schedule facts.
pub(super) fn detail_pairs(entry: &HeartbeatEntry, now_ms: u64) -> Vec<(&'static str, String)> {
    let mut pairs = vec![
        ("created", source_label(entry).to_string()),
        ("session", session_label(entry)),
        ("delivery", delivery_label(entry).to_string()),
        ("schedule", human_schedule_pair(entry)),
        (
            "next run",
            next_run_label(entry.job.next_run_at.as_deref(), now_ms),
        ),
        ("runs", entry.job.run_count.to_string()),
    ];
    if let Some(error) = entry.job.last_error.as_deref() {
        let error = single_line(error);
        if !error.is_empty() {
            pairs.push(("last error", error));
        }
    }
    pairs
}

/// The schedule fact for the drill-in's pairs: the human-readable form,
/// with the raw cron riding beside it whenever the interpretation covers
/// it (the storage format stays reachable, "every 2 minutes (*/2 * * * *)").
fn human_schedule_pair(entry: &HeartbeatEntry) -> String {
    let expression = entry.job.schedule_expression.trim();
    let human = human_schedule(expression);
    if human == expression {
        human
    } else {
        format!("{human} ({expression})")
    }
}

/// Render a `(label, value)` detail block: the dim label column padded
/// against muted values, one row per pair.
pub(super) fn detail_block_lines(
    theme: &Theme,
    width: usize,
    pairs: &[(&'static str, String)],
) -> Vec<Line> {
    if pairs.is_empty() {
        return Vec::new();
    }
    let label_width = pairs
        .iter()
        .map(|(label, _)| label.chars().count())
        .max()
        .unwrap_or(0)
        .min(16);
    pairs
        .iter()
        .map(|(label, value)| {
            truncate_line(
                &vec![
                    Span::raw("  "),
                    theme.fg_span(ThemeColor::Dim, format!("{label:<label_width$}  ")),
                    theme.fg_span(ThemeColor::Muted, value.clone()),
                ],
                width,
                "",
            )
        })
        .collect()
}

/// The row's primary text (TS `primary`): the label, else the prompt, else
/// the default name.
fn row_primary(entry: &HeartbeatEntry) -> String {
    entry
        .job
        .label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let prompt = single_line(&entry.job.prompt);
            (!prompt.is_empty()).then_some(prompt)
        })
        .unwrap_or_else(|| default_heartbeat_name(entry).to_string())
}

/// The table's column geometry: the interval, label, next-run, and status
/// cells sized over the rows and their header labels (the operator's
/// columned-table directive), with the label column taking whatever width
/// remains.
pub(super) struct Columns {
    interval: usize,
    label: usize,
}

impl Columns {
    pub(super) fn new(width: usize, entries: &[HeartbeatEntry]) -> Self {
        let interval_content = entries
            .iter()
            .map(|entry| str_width(&human_schedule(&entry.job.schedule_expression)))
            .chain([str_width("Interval")])
            .max()
            .unwrap_or(0)
            .min(INTERVAL_CAP);
        // The status cell carries the operator's status dot beside the
        // word (menu_panel::status_dot).
        let status = entries
            .iter()
            .map(|entry| str_width(&entry.job.status) + 2)
            .chain([str_width("Status")])
            .max()
            .unwrap_or(0);
        let label_content = entries
            .iter()
            .map(|entry| str_width(&row_primary(entry)))
            .chain([str_width("Label")])
            .max()
            .unwrap_or(0);
        // The fixed cells: the indent, the three two-column gaps, the
        // next-run column, and the status column.
        let fixed = 2 + 2 + 2 + 2 + 2 + NEXT_RUN_CELL + status;
        let label = label_content
            .min(LABEL_CAP)
            .min(width.saturating_sub(fixed + interval_content));
        Self {
            interval: interval_content.min(width.saturating_sub(fixed + label)),
            label,
        }
    }

    /// The dim column header row.
    pub(super) fn header_row(&self, theme: &Theme, width: usize) -> Line {
        let mut row = vec![Span::raw("  ")];
        row.push(theme.fg_span(ThemeColor::Dim, plain_cell("Interval", self.interval)));
        row.push(Span::raw("  "));
        row.push(theme.fg_span(ThemeColor::Dim, plain_cell("Label", self.label)));
        row.push(Span::raw("  "));
        row.push(theme.fg_span(ThemeColor::Dim, plain_cell("Next run", NEXT_RUN_CELL)));
        row.push(Span::raw("  "));
        row.push(theme.fg_span(ThemeColor::Dim, "Status".to_string()));
        truncate_line(&row, width, "")
    }

    /// One columned row: the schedule expression (in its human-readable
    /// form), the label, the next run, and the status word in its status
    /// color. The selected row's wash spans the full frame width (the
    /// operator's "table fills the width" ruling) while the columns keep
    /// their content-hug geometry.
    pub(super) fn entry_row(
        &self,
        theme: &Theme,
        width: usize,
        entry: &HeartbeatEntry,
        selected: bool,
        now_ms: u64,
    ) -> Line {
        let status_color = if entry.job.is_active() {
            ThemeColor::Success
        } else {
            ThemeColor::Warning
        };
        let mut row = vec![Span::raw(if selected { "\u{203a}" } else { " " })];
        row.push(Span::raw(" "));
        row.push(theme.fg_span(
            ThemeColor::Muted,
            plain_cell(
                &human_schedule(&entry.job.schedule_expression),
                self.interval,
            ),
        ));
        row.push(Span::raw("  "));
        if selected {
            row.push(theme.bold(Span::raw(plain_cell(&row_primary(entry), self.label))));
        } else {
            row.push(theme.fg_span(
                ThemeColor::Text,
                plain_cell(&row_primary(entry), self.label),
            ));
        }
        row.push(Span::raw("  "));
        row.push(theme.fg_span(
            ThemeColor::Muted,
            plain_cell(
                &next_run_label(entry.job.next_run_at.as_deref(), now_ms),
                NEXT_RUN_CELL,
            ),
        ));
        row.push(Span::raw("  "));
        let (dot, _) = status_dot(&entry.job.status);
        row.push(theme.fg_span(status_color, format!("{dot} {}", entry.job.status)));
        // The selected row paints the ONE shared selection style (the
        // operator's 2026-09-28 consistency rule): the same purple band
        // and bold the dock's groups and the agents view's rows carry.
        fill_row(row, selected, width, theme.selection_row_style())
    }
}

/// One action row (the `/mcp` view's control pattern): the `›`-marker
/// label with its dim description trailing, the selected row washed over
/// its hug.
pub(super) fn action_row(
    theme: &Theme,
    width: usize,
    label: &str,
    description: &str,
    selected: bool,
) -> Line {
    let mut row = vec![Span::raw(if selected { "\u{203a}" } else { " " })];
    row.push(Span::raw(" "));
    if selected {
        row.push(theme.bold(Span::raw(label.to_string())));
    } else {
        row.push(theme.fg_span(ThemeColor::Text, label.to_string()));
    }
    row.push(theme.fg_span(ThemeColor::Dim, format!("  {description}")));
    hug_row(
        row,
        str_width(label) + 2 + 2 + str_width(description),
        selected,
        width,
        theme.selection_row_style(),
    )
}

/// The pane's header block: a muted separator rule, then the title row —
/// the title in plain text (the `/model` picker carries no accent color),
/// the status counts trailing flush right, an optional muted subtitle,
/// and a blank line.
pub(super) fn pane_header_lines(
    theme: &Theme,
    width: usize,
    title: &str,
    counts: &[(ThemeColor, String)],
    subtitle: Option<&str>,
) -> Vec<Line> {
    let mut title_row = vec![
        Span::raw("  "),
        theme.fg_span(ThemeColor::Text, title.to_string()),
    ];
    if !counts.is_empty() {
        let joined_width = counts
            .iter()
            .map(|(_, text)| str_width(text) + 3)
            .sum::<usize>()
            .saturating_sub(3);
        let gap = width
            .saturating_sub(2 + title.chars().count() + 2 + joined_width)
            .max(2);
        title_row.push(Span::raw(" ".repeat(gap)));
        for (index, (color, text)) in counts.iter().enumerate() {
            if index > 0 {
                title_row.push(theme.fg_span(ThemeColor::Muted, " \u{b7} ".to_string()));
            }
            title_row.push(theme.fg_span(*color, text.clone()));
        }
    }
    let mut lines = vec![
        vec![theme.fg_span(ThemeColor::BorderMuted, "\u{2500}".repeat(width.max(1)))],
        truncate_line(&title_row, width, ""),
    ];
    if let Some(subtitle) = subtitle {
        if !subtitle.is_empty() {
            let line = vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Muted, subtitle.to_string()),
            ];
            lines.push(truncate_line(&line, width, ""));
        }
    }
    lines.push(Vec::new());
    lines
}

/// The hint row (TS `keyHint`: dim key text, muted ` description`).
pub(super) fn hint_line(theme: &Theme, width: usize, hint: &str) -> Line {
    let line = vec![
        Span::raw("  "),
        theme.fg_span(ThemeColor::Dim, hint.to_string()),
    ];
    truncate_line(&line, width, "")
}

/// An error line (TS `Error: <message>` in the error color).
pub(super) fn error_line(theme: &Theme, width: usize, message: &str) -> Line {
    let line = vec![
        Span::raw("  "),
        theme.fg_span(ThemeColor::Error, format!("Error: {message}")),
    ];
    truncate_line(&line, width, "")
}
