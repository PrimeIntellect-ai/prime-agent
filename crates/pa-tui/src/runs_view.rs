//! The condensed tool runs view (the drill-in pane for the collapsed
//! transcript's condensed blocks, the shells-view drill-in's shape): the
//! session's condensed runs as a list (one row per run - the same
//! status glyph, call count, and wall-clock the block shows), Enter
//! opens the run's rows - the EXACT overview rows the block replaced -
//! in a scrollable region (bottom-anchored on the newest rows, the
//! `\u{2026}`/`\u{2193}` markers riding over the region's edges while
//! content continues beyond them), and Esc walks back out. Pure
//! presentation: the pane reads the view's own transcript (no wire
//! requests, no state beyond the cursor and the scroll), so a live run
//! keeps updating inside the open pane.

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::{hug_row, menu_list_layout};
use crate::theme::{Theme, ThemeColor};
use crate::tool_runs::{render_summary_row, RunSummary, ToolRun};
use crate::view::AgentView;
use crate::width::truncate_line;
use crate::{Line, Span};

/// The preferred visible rows of the list.
const PREFERRED_VISIBLE: usize = 8;

/// Rows the list reserves outside its items (the inline geometry: rule,
/// title, blank, the conditional scroll indicator, blank, hint).
const LIST_FRAME_ROWS: usize = 6;

/// The detail pane's fixed rows outside the region (the rule, the run's
/// summary row, the blank under it, the blank over the hint, the hint).
const DETAIL_FRAME_ROWS: usize = 5;

/// One key press while the view is open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunsViewAction {
    Close,
    None,
}

/// The pane's interactive mode: the runs list, or one run's drill-in.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Mode {
    List,
    Detail { start: usize },
}

/// The condensed runs view.
#[derive(Debug)]
pub struct RunsView {
    mode: Mode,
    /// The selected run's start index (stable across live growth).
    selected: Option<usize>,
    /// The detail region's scroll position: how many rows the window
    /// rides lifted off the newest row (0 = bottom-anchored).
    scroll_from_end: usize,
    viewport_rows: usize,
    /// The detail region's rendered height from the last paint (the key
    /// loop's scroll math walks the same window the pane rendered).
    detail_region_rows: std::cell::Cell<usize>,
}

impl RunsView {
    /// Build the view over the transcript's condensed runs, cursor on
    /// the newest run (the one the transcript tail is showing).
    pub fn new(viewport_rows: usize, runs: &[ToolRun]) -> Self {
        RunsView {
            mode: Mode::List,
            selected: runs.last().map(|run| run.start),
            scroll_from_end: 0,
            viewport_rows,
            detail_region_rows: std::cell::Cell::new(0),
        }
    }

    /// One key press: the same key vocabulary as the shells view (the
    /// select/cancel/confirm bindings, `app.modal.back` from the detail).
    pub fn handle_key(
        &mut self,
        key: &str,
        kb: &KeybindingsManager,
        runs: &[ToolRun],
    ) -> RunsViewAction {
        if key == "ctrl+c" || kb.matches(key, "tui.select.cancel") {
            return RunsViewAction::Close;
        }
        if kb.matches(key, "app.modal.back") {
            if self.mode == Mode::List {
                return RunsViewAction::Close;
            }
            self.mode = Mode::List;
            self.scroll_from_end = 0;
            return RunsViewAction::None;
        }
        if kb.matches(key, "tui.select.up") || kb.matches(key, "tui.select.down") {
            let delta = if kb.matches(key, "tui.select.up") {
                -1isize
            } else {
                1
            };
            self.move_selection(delta, runs);
            return RunsViewAction::None;
        }
        if kb.matches(key, "tui.select.confirm") {
            self.open_detail(runs);
            return RunsViewAction::None;
        }
        RunsViewAction::None
    }

    /// Up/down: the list walks runs; the detail scrolls the row region.
    fn move_selection(&mut self, delta: isize, runs: &[ToolRun]) {
        match self.mode {
            Mode::List => {
                if runs.is_empty() {
                    return;
                }
                let position = runs
                    .iter()
                    .position(|run| Some(run.start) == self.selected)
                    .unwrap_or(runs.len() - 1) as isize;
                let next = (position + delta).clamp(0, runs.len() as isize - 1) as usize;
                self.selected = Some(runs[next].start);
            }
            Mode::Detail { .. } => {
                if self.detail_region_rows.get() == 0 {
                    return;
                }
                self.scroll_from_end = self.scroll_from_end.saturating_add_signed(delta).max(0);
            }
        }
    }

    /// Enter on a list row opens the run's drill-in.
    fn open_detail(&mut self, runs: &[ToolRun]) {
        if let Mode::List = self.mode {
            if let Some(run) = runs.iter().find(|run| Some(run.start) == self.selected) {
                self.mode = Mode::Detail { start: run.start };
                self.scroll_from_end = 0;
            }
        }
    }

    /// The runs changed (a live run grew or split): keep the cursor on a
    /// surviving run and return `Close` when none remain.
    pub fn reconcile(&mut self, runs: &[ToolRun]) -> Option<RunsViewAction> {
        if let Some(start) = self.selected {
            if !runs.iter().any(|run| run.start == start) {
                self.selected = runs
                    .iter()
                    .map(|run| run.start)
                    .filter(|run_start| *run_start <= start)
                    .max()
                    .or_else(|| runs.first().map(|run| run.start));
            }
        } else if let Some(run) = runs.last() {
            self.selected = Some(run.start);
        }
        if let Mode::Detail { start } = self.mode {
            if !runs.iter().any(|run| run.start == start) {
                self.mode = Mode::List;
                self.scroll_from_end = 0;
            }
        }
        (runs.is_empty()).then_some(RunsViewAction::Close)
    }

    /// Render the view's frame: the runs list, or one run's drill-in.
    pub fn render(&self, view: &AgentView, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        let runs = view.condensed_runs();
        match &self.mode {
            Mode::List => self.render_list(view, &runs, width, kb),
            Mode::Detail { start } => self.render_detail(view, &runs, *start, width, kb),
        }
    }

    /// The list pane: the title rule with the live counts, one row per
    /// run, and the hint line.
    fn render_list(
        &self,
        view: &AgentView,
        runs: &[ToolRun],
        width: usize,
        kb: &KeybindingsManager,
    ) -> Vec<Line> {
        let running = runs
            .iter()
            .filter(|run| crate::tool_runs::run_summary(&view.chat, **run).live)
            .count();
        let counts = vec![(ThemeColor::Success, format!("{running} running"))];
        let mut lines = pane_header_lines(&view.theme, width, "Tool runs", &counts);
        if runs.is_empty() {
            lines.push(vec![
                Span::raw("  "),
                view.theme.fg_span(ThemeColor::Muted, "No condensed runs".to_string()),
            ]);
        } else {
            let visible = self.visible_items(runs.len());
            let selected = runs
                .iter()
                .position(|run| Some(run.start) == self.selected)
                .unwrap_or(runs.len() - 1);
            let start = selected
                .saturating_sub(visible / 2)
                .min(runs.len().saturating_sub(visible));
            let end = (start + visible).min(runs.len());
            for (offset, run) in runs[start..end].iter().enumerate() {
                let is_selected = start + offset == selected;
                lines.push(self.list_row(view, width, *run, is_selected));
            }
            if visible > 0 && (start > 0 || end < runs.len()) {
                lines.push(vec![
                    Span::raw("  "),
                    view.theme.fg_span(
                        ThemeColor::Muted,
                        format!("({}/{})", selected + 1, runs.len()),
                    ),
                ]);
            }
        }
        lines.extend(pane_footer(&view.theme, width, &self.list_hint(kb)));
        lines.truncate(self.viewport_rows.max(1));
        lines
    }

    /// One list row: the run's own summary row (the same glyph, call
    /// count, and wall-clock the transcript's block shows), the selected
    /// row washed over its hug.
    fn list_row(&self, view: &AgentView, width: usize, run: ToolRun, selected: bool) -> Line {
        let summary = crate::tool_runs::run_summary(&view.chat, run);
        let glyph = if selected { "\u{203a}" } else { " " };
        let mut row: Line = vec![Span::raw(format!(" {glyph} "))];
        // The summary row leads with its own one-column chat margin; the
        // list row already carried the indent, so the margin drops.
        row.extend(render_summary_row(
            &summary,
            view.pulse_frame,
            &view.theme,
            width,
        )
        .into_iter()
        .skip(1));
        if selected {
            row = row
                .into_iter()
                .map(|span| view.theme.bold(Span::raw(span.content)))
                .collect();
        }
        let content = crate::width::line_width(&row);
        hug_row(&view.theme, row, content, selected, width)
    }

    /// The detail drill-in: the run's summary row (with its class text
    /// inline), then the EXACT overview rows the block replaced in a
    /// scrollable region.
    fn render_detail(
        &self,
        view: &AgentView,
        runs: &[ToolRun],
        start: usize,
        width: usize,
        kb: &KeybindingsManager,
    ) -> Vec<Line> {
        let Some(run) = runs.iter().find(|run| run.start == start).copied() else {
            let mut lines = pane_header_lines(&view.theme, width, "Tool runs", &[]);
            lines.push(vec![
                Span::raw("  "),
                view.theme.fg_span(
                    ThemeColor::Muted,
                    "This run is no longer condensed.".to_string(),
                ),
            ]);
            lines.extend(pane_footer(&view.theme, width, &self.detail_hint(kb)));
            return lines;
        };
        let summary = crate::tool_runs::run_summary(&view.chat, run);
        // The run's rows, exactly as the uncondensed overview rendered
        // them (each member's own leading decision included).
        let mut rows: Vec<Line> = Vec::new();
        for index in run.start..run.end {
            let entry = &view.chat[index];
            let preceded = index > 0 && view.is_compact_neighbor(&view.chat[index - 1]);
            rows.extend(view.render_entry_uncondensed(
                index,
                entry,
                width,
                index == 0,
                preceded,
            ));
        }
        let budget = self.viewport_rows.saturating_sub(DETAIL_FRAME_ROWS);
        let mut lines = Vec::new();
        lines.push(vec![
            view.theme
                .fg_span(ThemeColor::BorderMuted, "\u{2500}".repeat(width.max(1))),
        ]);
        lines.push(detail_header(view, width, &summary));
        lines.push(Vec::new());
        if budget == 0 {
            lines.extend(pane_footer(&view.theme, width, &self.detail_hint(kb)));
            self.detail_region_rows.set(0);
            lines.truncate(self.viewport_rows.max(1));
            return lines;
        }
        let height = budget.min(rows.len().max(1));
        let from_end = self.scroll_from_end.min(rows.len().saturating_sub(height));
        let window_start = rows.len().saturating_sub(height + from_end);
        let more_bottom = from_end > 0 && height > 1;
        let more_top = window_start > 0 && height - usize::from(more_bottom) > 1;
        let content = height - usize::from(more_top) - usize::from(more_bottom);
        let show = window_start + usize::from(more_top);
        if more_top {
            lines.push(marker_row(view, width, "\u{2026}"));
        }
        lines.extend(rows[show..(show + content).min(rows.len())].iter().cloned());
        while lines.len() < DETAIL_FRAME_ROWS + height - usize::from(more_bottom) {
            lines.push(Vec::new());
        }
        if more_bottom {
            lines.push(marker_row(view, width, "\u{2193}"));
        }
        self.detail_region_rows.set(height);
        lines.extend(pane_footer(&view.theme, width, &self.detail_hint(kb)));
        lines.truncate(self.viewport_rows.max(1));
        lines
    }

    /// The list's visible-row budget (the inline shape).
    fn visible_items(&self, total: usize) -> usize {
        if self.viewport_rows <= LIST_FRAME_ROWS {
            return 0;
        }
        menu_list_layout(
            Some(self.viewport_rows),
            PREFERRED_VISIBLE,
            total,
            LIST_FRAME_ROWS,
            1,
        )
    }

    /// The list's bottom hint line.
    fn list_hint(&self, kb: &KeybindingsManager) -> String {
        let key = |binding: &str, fallback: &str| {
            kb.first_key(binding)
                .map(|key| format_key_text(&key))
                .unwrap_or_else(|| fallback.to_string())
        };
        format!(
            "{}/{} move \u{b7} {} open \u{b7} {} close",
            key("tui.select.up", "\u{2191}"),
            key("tui.select.down", "\u{2193}"),
            key("tui.select.confirm", "Enter"),
            key("tui.select.cancel", "Esc"),
        )
    }

    /// The detail pane's bottom hint line.
    fn detail_hint(&self, kb: &KeybindingsManager) -> String {
        let key = |binding: &str, fallback: &str| {
            kb.first_key(binding)
                .map(|key| format_key_text(&key))
                .unwrap_or_else(|| fallback.to_string())
        };
        format!(
            "{}/{} scroll \u{b7} {} back \u{b7} {} close",
            key("tui.select.up", "\u{2191}"),
            key("tui.select.down", "\u{2193}"),
            key("app.modal.back", "\u{2190}"),
            key("tui.select.cancel", "Esc"),
        )
    }
}

/// The drill-in's run header: the status glyph, the call count, the
/// wall-clock, and the class text on one row.
fn detail_header(view: &AgentView, width: usize, summary: &RunSummary) -> Line {
    let summary_row = render_summary_row(summary, view.pulse_frame, &view.theme, width);
    let classes = crate::tool_runs::class_text(summary);
    let mut row: Line = vec![Span::raw("  ")];
    row.extend(summary_row.into_iter().skip(1));
    if !classes.is_empty() {
        row.push(
            view.theme
                .fg_span(ThemeColor::Dim, format!(" \u{b7} {classes}")),
        );
    }
    truncate_line(&row, width, "")
}

/// A dim region marker row.
fn marker_row(view: &AgentView, width: usize, marker: &str) -> Line {
    let line = vec![
        Span::raw("  "),
        view.theme.fg_span(ThemeColor::Dim, marker.to_string()),
    ];
    truncate_line(&line, width, "")
}

/// The pane's header block (the shells view's shape): the muted rule,
/// the title row with the status counts trailing flush right, a blank.
fn pane_header_lines(
    theme: &Theme,
    width: usize,
    title: &str,
    counts: &[(ThemeColor, String)],
) -> Vec<Line> {
    let mut title_row = vec![
        Span::raw("  "),
        theme.fg_span(ThemeColor::Text, title.to_string()),
    ];
    if !counts.is_empty() {
        let joined_width = counts
            .iter()
            .map(|(_, text)| crate::width::str_width(text) + 3)
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
    vec![
        vec![
            theme.fg_span(ThemeColor::BorderMuted, "\u{2500}".repeat(width.max(1))),
        ],
        truncate_line(&title_row, width, ""),
        Vec::new(),
    ]
}

/// The pane footer: a blank and the hint line.
fn pane_footer(theme: &Theme, width: usize, hint: &str) -> Vec<Line> {
    vec![
        Vec::new(),
        truncate_line(
            &vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Dim, hint.to_string()),
            ],
            width,
            "",
        ),
    ]
}


