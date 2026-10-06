//! The bash view's paint primitives: the columned table geometry and the
//! row/line shapers the pane's render methods assemble over.

use super::{
    fill_row, hug_row, plain_cell, scrub_controls, status_dot, str_width, truncate_line,
    BashActivity, Line, Span, Theme, ThemeColor,
};

/// The table's column geometry: the command, duration, pid, and status
/// cells, with the command column taking whatever width remains.
pub(super) struct Columns {
    command: usize,
    duration: usize,
    pid: usize,
    status: usize,
}

impl Columns {
    pub(super) fn new(width: usize, activities: &[BashActivity]) -> Self {
        let duration_content = activities
            .iter()
            .map(|activity| str_width(&format_duration(activity.duration_ms)))
            .chain([str_width("Duration")])
            .max()
            .unwrap_or(0);
        let pid = activities
            .iter()
            .map(|activity| match activity.pid {
                Some(pid) => str_width(&pid.to_string()),
                None => 1,
            })
            .chain([str_width("PID")])
            .max()
            .unwrap_or(0);
        // The status cell carries the status dot beside the word.
        let status = activities
            .iter()
            .map(|activity| str_width(&activity.status) + 2)
            .chain([str_width("Status")])
            .max()
            .unwrap_or(0);
        // The fixed cells: the indent, the three two-column gaps, and
        // the duration, pid, and status columns.
        let fixed = 2 + 2 + 2 + 2 + duration_content + pid + status;
        // The fixed fact columns hug their content; the command column absorbs the rest, so
        // the columns together span the terminal (operator ruling 2026-09-25).
        let command = width.saturating_sub(fixed);
        Self {
            command,
            duration: duration_content,
            pid,
            status,
        }
    }

    /// The dim column header row.
    pub(super) fn header_row(&self, theme: &Theme, width: usize) -> Line {
        let mut row = vec![Span::raw("  ")];
        row.push(theme.fg_span(ThemeColor::Dim, plain_cell("Command", self.command)));
        row.push(Span::raw("  "));
        row.push(theme.fg_span(ThemeColor::Dim, plain_cell("Duration", self.duration)));
        row.push(Span::raw("  "));
        row.push(theme.fg_span(ThemeColor::Dim, plain_cell("PID", self.pid)));
        row.push(Span::raw("  "));
        row.push(theme.fg_span(ThemeColor::Dim, plain_cell("Status", self.status)));
        truncate_line(&row, width, "")
    }

    /// One columned row: the command, the duration, the pid, and the status word in its status
    /// color (running green, a nonzero exit red, everything else dim). The selected row's wash
    /// spans the full frame width while the columns keep their content-hug geometry.
    pub(super) fn activity_row(
        &self,
        theme: &Theme,
        width: usize,
        activity: &BashActivity,
        selected: bool,
    ) -> Line {
        let status_color = status_state_color(activity);
        let mut row = vec![Span::raw(if selected { "\u{203a}" } else { " " })];
        row.push(Span::raw(" "));
        let command = plain_cell(
            &single_line(&scrub_controls(&activity.command)),
            self.command,
        );
        if selected {
            row.push(theme.bold(Span::raw(command)));
        } else {
            row.push(theme.fg_span(ThemeColor::Text, command));
        }
        row.push(Span::raw("  "));
        row.push(theme.fg_span(
            ThemeColor::Muted,
            plain_cell(&format_duration(activity.duration_ms), self.duration),
        ));
        row.push(Span::raw("  "));
        row.push(
            theme.fg_span(
                ThemeColor::Muted,
                plain_cell(
                    &activity
                        .pid
                        .map_or_else(|| "\u{2014}".to_string(), |pid| pid.to_string()),
                    self.pid,
                ),
            ),
        );
        row.push(Span::raw("  "));
        let (dot, _) = status_dot(&activity.status);
        row.push(theme.fg_span(
            status_color,
            plain_cell(&format!("{dot} {}", activity.status), self.status),
        ));
        // The selected row paints the ONE shared selection style, the
        // same band every surface carries.
        fill_row(&row, selected, width, theme.selection_row_style())
    }
}

/// One action row: the `›`-marker label with its dim description trailing,
/// the selected row washed over its hug.
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
        &row,
        str_width(label) + 2 + 2 + str_width(description),
        selected,
        width,
        theme.selection_row_style(),
    )
}

/// The status state's color: running green, a settled nonzero exit red,
/// everything else dim.
fn status_state_color(activity: &BashActivity) -> ThemeColor {
    if activity.running() {
        ThemeColor::Success
    } else if activity.exit_code.is_some_and(|code| code != 0) {
        ThemeColor::Error
    } else {
        ThemeColor::Dim
    }
}

/// The drill-in's one metadata row: pid, started, and duration joined by
/// dim dots, with the status dot and word trailing in its state color.
pub(super) fn metadata_row(theme: &Theme, width: usize, activity: &BashActivity) -> Line {
    let mut row = vec![Span::raw("  ")];
    let mut items: Vec<(&'static str, String)> = Vec::new();
    if let Some(pid) = activity.pid {
        items.push(("pid ", pid.to_string()));
    }
    if let Some(started) = activity.started_at.as_deref() {
        items.push((
            "started ",
            crate::heartbeats_picker::format_timestamp(started),
        ));
    }
    if let Some(ms) = activity.duration_ms {
        items.push(("duration ", format_duration(Some(ms))));
    }
    for (index, (label, value)) in items.iter().enumerate() {
        if index > 0 {
            row.push(theme.fg_span(ThemeColor::Dim, " \u{b7} ".to_string()));
        }
        row.push(theme.fg_span(ThemeColor::Dim, label.to_string()));
        row.push(theme.fg_span(ThemeColor::Muted, value.clone()));
    }
    // The status rides last in its state color: the shared status dot
    // and the current subtitle word.
    if !items.is_empty() {
        row.push(theme.fg_span(ThemeColor::Dim, " \u{b7} ".to_string()));
    }
    let (dot, _) = status_dot(&activity.status);
    let status_word = if activity.running() {
        "running".to_string()
    } else {
        match activity.exit_code {
            Some(code) => format!("exit {code}"),
            None => activity.status.clone(),
        }
    };
    row.push(theme.fg_span(status_state_color(activity), format!("{dot} {status_word}")));
    truncate_line(&row, width, "")
}

/// A dim region marker row (`\u{2026}` over the first row while output
/// continues above, `\u{2193}` under the last while scrolled up).
pub(super) fn marker_line(theme: &Theme, width: usize, marker: &str) -> Line {
    let line = vec![
        Span::raw("  "),
        theme.fg_span(ThemeColor::Dim, marker.to_string()),
    ];
    truncate_line(&line, width, "")
}

/// `single_line`: collapse all whitespace runs to single spaces.
fn single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Keep every fetched line inert as terminal text: control characters never reach the UI,
/// but the line's own spacing stays exactly as the kernel wrote it.
pub(super) fn clean_line(value: &str) -> String {
    scrub_controls(value)
}

/// The duration cell: whole milliseconds read as a compact human word
/// (`780ms`, `3.4s`, `2m 05s`), `—` when the wire carries none.
pub(super) fn format_duration(duration_ms: Option<u64>) -> String {
    let Some(ms) = duration_ms else {
        return "\u{2014}".to_string();
    };
    if ms < 1_000 {
        return format!("{ms}ms");
    }
    let total_seconds = ms / 1_000;
    if total_seconds < 60 {
        return format!("{total_seconds}.{}s", (ms % 1_000) / 100);
    }
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    format!("{minutes}m {seconds:02}s")
}

/// The pane's header block: a muted separator rule, then the title row with the status
/// counts trailing flush right, an optional muted subtitle, and a blank line.
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

/// The hint row: dim key text, muted ` description`.
pub(super) fn hint_line(theme: &Theme, width: usize, hint: &str) -> Line {
    let line = vec![
        Span::raw("  "),
        theme.fg_span(ThemeColor::Dim, hint.to_string()),
    ];
    truncate_line(&line, width, "")
}

/// An error line (`Error: <message>` in the error color).
pub(super) fn error_line(theme: &Theme, width: usize, message: &str) -> Line {
    let line = vec![
        Span::raw("  "),
        theme.fg_span(ThemeColor::Error, format!("Error: {message}")),
    ];
    truncate_line(&line, width, "")
}
