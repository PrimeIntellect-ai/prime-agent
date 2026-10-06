//! The dedicated bash view: the kernel bash registry as a columned table
//! (command, duration, pid, status), with Enter opening a detail drill-in
//! (metadata, exact command, scrollable lazy-loaded output tail). Pure
//! presentation; the host owns the refresh, fetches, and kills.

use serde_json::Value;

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::{
    fill_row, hug_row, menu_list_layout, plain_cell, scrub_controls, status_dot,
};
use crate::theme::{Theme, ThemeColor};
use crate::width::{str_width, truncate_line, wrap_text};
use crate::{Line, Span};

mod render;

#[cfg(test)]
use render::format_duration;
use render::{
    action_row, clean_line, error_line, hint_line, marker_line, metadata_row, pane_header_lines,
    Columns,
};

const PREFERRED_VISIBLE: usize = 8;

/// Rows the list reserves outside its items: rule, title, blank, column
/// header, blank, hint, blank (the scroll indicator rides the layout's
/// own scroll reservation).
const LIST_FRAME_ROWS: usize = 7;

/// The lines the open detail asks for first: more of the tail loads on
/// upward scroll, so a finished task's full output never loads up front.
pub const FIRST_TAIL_LINES: u32 = 50;

/// The wire's per-request cap: the load-more window doubles up to this.
pub const TAIL_LINES: u32 = 200;

/// An opaque kernel bash id and its latest catalog metadata (the
/// `list_kernel_bash` wire rows).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BashActivity {
    pub id: String,
    pub command: String,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub status: String,
    pub exit_code: Option<i64>,
    pub duration_ms: Option<u64>,
}

impl BashActivity {
    pub(crate) fn running(&self) -> bool {
        self.status == "running"
    }
}

/// Accept either the daemon response's `activities` array or the array itself; rows
/// without a nonempty string id are ignored. Running shells sort first (stable within each side).
#[must_use]
pub fn parse_bash_activities(data: &Value) -> Vec<BashActivity> {
    let rows = data.get("activities").unwrap_or(data);
    let mut activities: Vec<BashActivity> = rows
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?.trim();
            if id.is_empty() {
                return None;
            }
            Some(BashActivity {
                id: id.to_string(),
                // Every process-supplied string renders somewhere in the
                // view: control characters scrub at the parse boundary.
                command: row
                    .get("command")
                    .and_then(Value::as_str)
                    .map(crate::menu_panel::scrub_controls)
                    .unwrap_or_default(),
                pid: row
                    .get("pid")
                    .and_then(Value::as_u64)
                    .and_then(|pid| pid.try_into().ok()),
                started_at: row
                    .get("startedAt")
                    .and_then(Value::as_str)
                    .map(crate::menu_panel::scrub_controls),
                status: row
                    .get("status")
                    .and_then(Value::as_str)
                    .map_or_else(|| "unknown".to_string(), crate::menu_panel::scrub_controls),
                exit_code: row.get("exitCode").and_then(Value::as_i64),
                duration_ms: row.get("durationMs").and_then(Value::as_u64),
            })
        })
        .collect();
    activities.sort_by_key(|activity| !activity.running());
    activities
}

/// The pane's interactive mode: the columned list, or a row's detail
/// drill-in.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Mode {
    List,
    Detail { id: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BashViewAction {
    Close,
    /// Enter on a list row: the host fetches the row's output tail ([`FIRST_TAIL_LINES`] lines)
    /// and delivers it with [`BashView::set_output`]; `generation` stamps the open.
    OpenDetail {
        id: String,
        generation: u64,
    },
    /// Up at the top of the loaded window: the host re-fetches with the
    /// grown `lines` window, stamped with the same open's `generation`.
    LoadMore {
        id: String,
        generation: u64,
        lines: u32,
    },
    /// Enter in the detail on the cancel action: the host runs
    /// `kill_kernel_bash` and refreshes the registry.
    Kill {
        id: String,
    },
    None,
}

#[derive(Debug)]
pub struct BashView {
    /// The latest registry snapshot (kept current by the host's refresh).
    activities: Vec<BashActivity>,
    /// Each open increments it; the host stamps tail requests with the open's
    /// generation, so a late response never overwrites the newer open's output.
    detail_generation: u64,
    selected_id: Option<String>,
    mode: Mode,
    /// The open detail row's fetched output window: `Some` once a tail
    /// landed (empty included), `None` while the fetch is in flight.
    output_tail: Option<(String, Vec<String>)>,
    /// The tail window the open holds: starts at [`FIRST_TAIL_LINES`],
    /// doubles per lazy load up to [`TAIL_LINES`].
    tail_window: u32,
    /// The loaded window holds everything the wire can still give (a short
    /// response or the cap was reached); scroll then shows the leading marker, not another fetch.
    tail_complete: bool,
    /// A lazy load-more fetch is in flight: the marker stays and the up
    /// key does not stack a second request.
    loading_more: bool,
    /// The failed open fetch's retry is in flight: further Ups stack no
    /// duplicates, and its landing or failure clears the claim.
    open_retry: bool,
    /// How many lines the window sits lifted off the newest output
    /// (0 = bottom-anchored on the newest lines).
    scroll_from_end: usize,
    /// The output region's rendered height from the last paint
    /// (0 means nothing painted yet and the region cannot scroll).
    detail_region_rows: std::cell::Cell<usize>,
    error: Option<String>,
    /// Whether the shown error came from a tail fetch (a kill error
    /// keeps the registry-refresh lifecycle, [`BashView::clear_error`]).
    fetch_error: bool,
    viewport_rows: usize,
}

impl BashView {
    #[must_use]
    pub fn new(activities: Vec<BashActivity>, viewport_rows: usize) -> Self {
        let mut view = BashView {
            activities,
            detail_generation: 0,
            selected_id: None,
            mode: Mode::List,
            output_tail: None,
            tail_window: FIRST_TAIL_LINES,
            tail_complete: false,
            loading_more: false,
            open_retry: false,
            scroll_from_end: 0,
            detail_region_rows: std::cell::Cell::new(0),
            error: None,
            fetch_error: false,
            viewport_rows,
        };
        view.selected_id = view.activities.first().map(|row| row.id.clone());
        view
    }

    /// Reset the open detail's fetched-output state (new open, back, or
    /// row vanished): the next open starts fresh, bottom-anchored.
    fn reset_detail_output(&mut self) {
        self.output_tail = None;
        self.tail_window = FIRST_TAIL_LINES;
        self.tail_complete = false;
        self.loading_more = false;
        self.open_retry = false;
        self.scroll_from_end = 0;
    }

    /// A landed registry refresh: replace the rows, keep the selection on
    /// the surviving id, and drop a detail pane whose row vanished.
    pub fn apply_activities(&mut self, activities: Vec<BashActivity>) {
        self.activities = activities;
        let selected = self.selected_id.clone();
        let exists = selected
            .as_deref()
            .is_some_and(|id| self.activities.iter().any(|row| row.id == id));
        if !exists {
            self.selected_id = self.activities.first().map(|row| row.id.clone());
        }
        if let Mode::Detail { id } = self.mode.clone() {
            if !self.activities.iter().any(|row| row.id == id) {
                self.mode = Mode::List;
                self.reset_detail_output();
            }
        }
        self.output_tail = self
            .output_tail
            .take()
            .filter(|(id, _)| self.activities.iter().any(|row| row.id == *id));
    }

    /// A fetched output window of one row; a window for a closed pane, a
    /// different row, or an earlier open is ignored. A lazy load-more keeps
    /// the scroll anchored; a window that grew nothing keeps the current one.
    pub fn set_output(&mut self, id: &str, tail: &str, generation: u64) {
        if self.detail_id().as_deref() != Some(id) || self.detail_generation != generation {
            return;
        }
        let lines: Vec<String> = tail.lines().map(clean_line).collect();
        // A landed window supersedes a shown fetch error and releases the
        // open retry's claim; a kill error keeps its own lifecycle.
        self.open_retry = false;
        if self.fetch_error {
            self.error = None;
            self.fetch_error = false;
        }
        if self.loading_more {
            self.loading_more = false;
            let loaded = self.output_tail.as_ref().map(|(_, output)| output.len());
            if loaded.is_some_and(|loaded| lines.len() > loaded) {
                // The window lands anchored just above where the scroll
                // stopped: one old window's height back from the end.
                self.scroll_from_end = loaded.unwrap_or(0);
                self.output_tail = Some((id.to_string(), lines));
            }
        } else {
            self.scroll_from_end = 0;
            self.output_tail = Some((id.to_string(), lines));
        }
        let loaded = self
            .output_tail
            .as_ref()
            .map_or(0, |(_, output)| output.len());
        self.tail_complete = loaded < self.tail_window as usize || self.tail_window >= TAIL_LINES;
    }

    pub(crate) fn detail_id(&self) -> Option<String> {
        match &self.mode {
            Mode::Detail { id, .. } => Some(id.clone()),
            Mode::List => None,
        }
    }

    /// A fetch failure carries its open generation — a late error from an earlier open
    /// never lands on the newer one; a kill error knows nothing about the load's fate.
    pub fn set_error(&mut self, error: String, fetch: bool, generation: Option<u64>) {
        if fetch && generation.is_some_and(|generation| generation != self.detail_generation) {
            return;
        }
        if fetch {
            // A failed lazy load never leaves its grown window behind:
            // a window left at the cap would read as the end.
            if self.loading_more {
                self.tail_window = self
                    .output_tail
                    .as_ref()
                    .map_or(FIRST_TAIL_LINES, |(_, output)| output.len() as u32);
            }
            // Only a fetch failure releases the in-flight claims; a kill
            // error knows nothing about the fetches' fate.
            self.loading_more = false;
            self.open_retry = false;
        }
        self.error = Some(error);
        self.fetch_error = fetch;
    }

    /// A landed registry update supersedes a shown error; the host calls
    /// this only when the registry itself changed.
    pub fn clear_error(&mut self) {
        self.error = None;
        self.fetch_error = false;
    }

    /// The selected row's index (first when unset).
    fn selected_index(&self) -> usize {
        self.activities
            .iter()
            .position(|row| Some(&row.id) == self.selected_id.as_ref())
            .unwrap_or(0)
    }

    fn find_activity(&self, id: &str) -> Option<&BashActivity> {
        self.activities.iter().find(|row| row.id == id)
    }

    /// The action rows of one activity: cancel while the process runs
    /// (the registry's only wire action — a finished row offers none).
    fn available_actions(activity: &BashActivity) -> Vec<(String, String)> {
        if activity.running() {
            vec![(
                "Cancel command".to_string(),
                "Terminate the running process".to_string(),
            )]
        } else {
            Vec::new()
        }
    }

    /// One key id; in the detail, up/down scroll the output region.
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> BashViewAction {
        if key == "ctrl+c" || kb.matches(key, "tui.select.cancel") {
            return BashViewAction::Close;
        }
        if kb.matches(key, "app.modal.back") {
            if self.mode == Mode::List {
                return BashViewAction::Close;
            }
            self.mode = Mode::List;
            self.error = None;
            self.reset_detail_output();
            return BashViewAction::None;
        }
        if kb.matches(key, "tui.select.up") || kb.matches(key, "tui.select.down") {
            let delta = if kb.matches(key, "tui.select.up") {
                -1isize
            } else {
                1
            };
            return self.move_selection(delta);
        }
        if kb.matches(key, "tui.select.confirm") {
            return self.confirm_selection();
        }
        BashViewAction::None
    }

    /// Up/down: the list walks rows by id; the detail scrolls the output
    /// region, and up at the loaded top lazily loads more of the tail.
    fn move_selection(&mut self, delta: isize) -> BashViewAction {
        match self.mode.clone() {
            Mode::List => {
                if self.activities.is_empty() {
                    return BashViewAction::None;
                }
                let index = self.selected_index() as isize;
                let next = (index + delta).clamp(0, self.activities.len() as isize - 1) as usize;
                self.selected_id = Some(self.activities[next].id.clone());
                BashViewAction::None
            }
            Mode::Detail { .. } => self.scroll_output(delta),
        }
    }

    /// Scroll the detail's output region: up lifts the window off the newest lines,
    /// down lowers it back; at the loaded top, load more or stop.
    fn scroll_output(&mut self, delta: isize) -> BashViewAction {
        let Mode::Detail { id } = self.mode.clone() else {
            return BashViewAction::None;
        };
        let Some(output) = self
            .output_tail
            .as_ref()
            .filter(|(tail_id, _)| tail_id == &id)
            .map(|(_, output)| output.len())
        else {
            // The open fetch failed before anything loaded: Up retries
            // it; while it is in flight, Up does nothing.
            if self.fetch_error {
                // One retry at a time: key repeats never stack duplicate
                // same-generation fetches.
                if self.open_retry {
                    return BashViewAction::None;
                }
                self.open_retry = true;
                return BashViewAction::OpenDetail {
                    id,
                    generation: self.detail_generation,
                };
            }
            return BashViewAction::None;
        };
        let height = self.detail_region_rows.get();
        if height == 0 {
            return BashViewAction::None;
        }
        let from_end = self.scroll_from_end.min(output.saturating_sub(height));
        if delta < 0 {
            if from_end < output.saturating_sub(height) {
                self.scroll_from_end = from_end + 1;
                return BashViewAction::None;
            }
            if !self.tail_complete && !self.loading_more {
                let next = self.tail_window.saturating_mul(2).min(TAIL_LINES);
                if next > self.tail_window {
                    self.tail_window = next;
                    self.loading_more = true;
                    return BashViewAction::LoadMore {
                        id,
                        generation: self.detail_generation,
                        lines: next,
                    };
                }
                self.tail_complete = true;
            }
            BashViewAction::None
        } else {
            self.scroll_from_end = from_end.saturating_sub(1);
            BashViewAction::None
        }
    }

    /// Enter on the list opens the row's detail drill-in (the host fetches
    /// the output tail); Enter in the detail runs the cancel action.
    fn confirm_selection(&mut self) -> BashViewAction {
        match self.mode.clone() {
            Mode::List => {
                let Some(id) = self.selected_id.clone() else {
                    return BashViewAction::None;
                };
                if self.find_activity(&id).is_some() {
                    self.mode = Mode::Detail { id: id.clone() };
                    self.detail_generation = self.detail_generation.wrapping_add(1);
                    self.reset_detail_output();
                    return BashViewAction::OpenDetail {
                        id,
                        generation: self.detail_generation,
                    };
                }
                BashViewAction::None
            }
            Mode::Detail { id } => {
                let Some(activity) = self.find_activity(&id) else {
                    self.mode = Mode::List;
                    self.reset_detail_output();
                    return BashViewAction::None;
                };
                if Self::available_actions(activity).is_empty() {
                    BashViewAction::None
                } else {
                    BashViewAction::Kill { id }
                }
            }
        }
    }

    fn visible_items(&self) -> usize {
        let reserved = LIST_FRAME_ROWS + if self.error.is_some() { 2 } else { 0 };
        // The shared layout floors at one row so a picker never reads empty; this view
        // never renders past its viewport, so a frame too short for any row renders none.
        if self.viewport_rows <= reserved {
            return 0;
        }
        menu_list_layout(
            Some(self.viewport_rows),
            PREFERRED_VISIBLE,
            self.activities.len(),
            reserved,
            1,
        )
    }

    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        match &self.mode {
            Mode::List => self.render_list(theme, width, kb),
            Mode::Detail { id } => self.render_detail(theme, width, kb, id),
        }
    }

    /// The list pane: title, column header, one row per activity, the
    /// scroll indicator, and one hint line.
    fn render_list(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        let running = self
            .activities
            .iter()
            .filter(|activity| activity.running())
            .count();
        let counts = vec![(ThemeColor::Success, format!("{running} running"))];
        let mut lines = pane_header_lines(theme, width, "Bash", &counts, None);
        if self.activities.is_empty() {
            lines.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Muted, "No background commands"),
            ]);
        } else {
            let columns = Columns::new(width, &self.activities);
            lines.push(columns.header_row(theme, width));
            let selected = self.selected_index();
            let visible = self.visible_items();
            let start = selected
                .saturating_sub(visible / 2)
                .min(self.activities.len().saturating_sub(visible));
            let end = (start + visible).min(self.activities.len());
            for (index, activity) in self.activities[start..end].iter().enumerate() {
                let is_selected = start + index == selected;
                lines.push(columns.activity_row(theme, width, activity, is_selected));
            }
            if visible > 0 && (start > 0 || end < self.activities.len()) {
                lines.push(vec![
                    Span::raw("  "),
                    theme.fg_span(
                        ThemeColor::Muted,
                        format!("({}/{})", selected + 1, self.activities.len()),
                    ),
                ]);
            }
        }
        lines.extend(self.pane_footer(theme, width, &Self::list_hint(kb)));
        // A terminal shorter than the frame degrades by truncation: the
        // pane never renders past its allocated rows.
        lines.truncate(self.viewport_rows.max(1));
        lines
    }

    /// The detail drill-in: one metadata row (pid, started, duration, status),
    /// the exact command, and the fetched output in a scrollable region. A short
    /// viewport shrinks the command first, then the output.
    fn render_detail(
        &self,
        theme: &Theme,
        width: usize,
        kb: &KeybindingsManager,
        id: &str,
    ) -> Vec<Line> {
        let Some(activity) = self.find_activity(id) else {
            let mut lines = pane_header_lines(theme, width, "Bash", &[], None);
            lines.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Muted, "This command is no longer available."),
            ]);
            lines.extend(self.pane_footer(theme, width, &self.detail_hint(kb)));
            return lines;
        };
        // The command renders verbatim with non-newline control characters scrubbed:
        // an embedded escape sequence never executes terminal control operations.
        let command_exact = scrub_controls(&activity.command);
        let actions = Self::available_actions(activity);
        let error_rows = if self.error.is_some() { 2 } else { 0 };
        // The command and the output region ride the remaining budget in
        // that order — the output keeps at least one row.
        let fixed = 6 + if actions.is_empty() { 0 } else { 2 } + error_rows;
        let budget = self.viewport_rows.saturating_sub(fixed);
        let command_width = width.saturating_sub(4).max(10);
        let command_wrapped = wrap_text(&command_exact, command_width);
        let command_rows = if budget >= 1 {
            command_wrapped.len().min(budget - 1)
        } else {
            0
        };
        let command_clipped = command_wrapped.len() > command_rows;
        let output_rows = budget.saturating_sub(command_rows);
        let mut lines = Vec::new();
        lines.push(vec![
            theme.fg_span(ThemeColor::BorderMuted, "\u{2500}".repeat(width.max(1)))
        ]);
        lines.push(metadata_row(theme, width, activity));
        if command_rows > 0 {
            let mut shown = command_rows;
            if command_clipped {
                // A clipped block spends exactly its lines + marker: the
                // clip never overspends the viewport.
                shown = command_rows.saturating_sub(1);
            }
            for line in &command_wrapped[..shown] {
                let mut row = vec![Span::raw("  ")];
                row.extend(line.iter().cloned());
                lines.push(truncate_line(&row, width, ""));
            }
            if command_clipped {
                lines.push(vec![
                    Span::raw("  "),
                    theme.fg_span(ThemeColor::Dim, "\u{2026}".to_string()),
                ]);
            }
        }
        lines.push(Vec::new());
        // The fetched window (scrollable, newest lines at the bottom, edge markers
        // continues), a fetching note while in flight, or the empty-output note once landed.
        if output_rows > 0 {
            let tail = self
                .output_tail
                .as_ref()
                .filter(|(tail_id, _)| tail_id == id);
            match tail {
                Some((_, output)) if !output.is_empty() => {
                    let len = output.len();
                    let from_end = self.scroll_from_end.min(len.saturating_sub(output_rows));
                    // The `output_rows` window lifted `from_end` lines
                    // off the newest output (0 = newest at the bottom).
                    let window_start = len.saturating_sub(output_rows + from_end);
                    // A marker replaces the window's edge row, so it renders only while a content
                    // row survives beside it: a one-row region never shows a marker-only row.
                    let more_bottom = from_end > 0 && output_rows > 1;
                    // More above: older loaded lines the window scrolled
                    // past, or a lazily loadable tail window.
                    let more_top = (window_start > 0 || !self.tail_complete)
                        && output_rows - usize::from(more_bottom) > 1;
                    let content = output_rows - usize::from(more_top) - usize::from(more_bottom);
                    let start = window_start + usize::from(more_top);
                    let shown = content.min(len - start);
                    let mut rows: Vec<Line> = Vec::with_capacity(output_rows);
                    if more_top {
                        rows.push(marker_line(theme, width, "\u{2026}"));
                    }
                    for line in &output[start..start + shown] {
                        rows.push(truncate_line(
                            &vec![
                                Span::raw("  "),
                                theme.fg_span(ThemeColor::Muted, line.clone()),
                            ],
                            width,
                            "",
                        ));
                    }
                    while rows.len() < output_rows - usize::from(more_bottom) {
                        rows.push(Vec::new());
                    }
                    if more_bottom {
                        rows.push(marker_line(theme, width, "\u{2193}"));
                    }
                    lines.extend(rows);
                }
                Some((_, _)) => {
                    lines.push(vec![
                        Span::raw("  "),
                        theme.fg_span(ThemeColor::Dim, "No output yet".to_string()),
                    ]);
                    lines.extend(std::iter::repeat_n(Vec::new(), output_rows - 1));
                }
                None => {
                    lines.push(vec![
                        Span::raw("  "),
                        theme.fg_span(ThemeColor::Dim, "Fetching output\u{2026}".to_string()),
                    ]);
                    lines.extend(std::iter::repeat_n(Vec::new(), output_rows - 1));
                }
            }
        }
        // The cancel action: one row while the command runs (the
        // region's scroll owns up/down; Enter runs it).
        if !actions.is_empty() {
            lines.push(Vec::new());
            let (label, description) = &actions[0];
            lines.push(action_row(theme, width, label, description, true));
        }
        lines.extend(self.pane_footer(theme, width, &self.detail_hint(kb)));
        lines.truncate(self.viewport_rows.max(1));
        // The key loop's scroll math walks the same region the pane
        // rendered: record its height after the truncation above.
        let total = fixed + command_rows + output_rows;
        let rendered = output_rows.saturating_sub(total.saturating_sub(self.viewport_rows));
        self.detail_region_rows.set(rendered);
        lines
    }
    /// The list's bottom hint: an override that empties the back binding drops
    /// its key (the hint never advertises a key the handler does not take).
    fn list_hint(kb: &KeybindingsManager) -> String {
        let key = |binding: &str, fallback: &str| {
            kb.first_key(binding)
                .map_or_else(|| fallback.to_string(), |key| format_key_text(&key))
        };
        let close = match kb.first_key("app.modal.back") {
            Some(back) => format!(
                "{}/{}",
                format_key_text(&back),
                key("tui.select.cancel", "Esc")
            ),
            None => key("tui.select.cancel", "Esc"),
        };
        format!(
            "{}/{} move \u{b7} {} open \u{b7} {close} close",
            key("tui.select.up", "\u{2191}"),
            key("tui.select.down", "\u{2193}"),
            key("tui.select.confirm", "Enter"),
        )
    }

    /// The detail pane's bottom hint: the scroll keys, and the run key
    /// only while the open row still offers its cancel action.
    fn detail_hint(&self, kb: &KeybindingsManager) -> String {
        let key = |binding: &str, fallback: &str| {
            kb.first_key(binding)
                .map_or_else(|| fallback.to_string(), |key| format_key_text(&key))
        };
        let up_down = format!(
            "{}/{}",
            key("tui.select.up", "\u{2191}"),
            key("tui.select.down", "\u{2193}")
        );
        let running = self
            .detail_id()
            .and_then(|id| self.find_activity(&id))
            .is_some_and(|activity| !Self::available_actions(activity).is_empty());
        if running {
            format!(
                "{up_down} scroll \u{b7} {} run \u{b7} {} back \u{b7} {} close",
                key("tui.select.confirm", "Enter"),
                key("app.modal.back", "\u{2190}"),
                key("tui.select.cancel", "Esc"),
            )
        } else {
            format!(
                "{up_down} scroll \u{b7} {} back \u{b7} {} close",
                key("app.modal.back", "\u{2190}"),
                key("tui.select.cancel", "Esc"),
            )
        }
    }

    /// The pane footer: the error block, a blank, the hint line, and one
    /// blank below the shortcuts (spacing, not a divider).
    fn pane_footer(&self, theme: &Theme, width: usize, hint: &str) -> Vec<Line> {
        let mut lines = Vec::new();
        if let Some(error) = &self.error {
            lines.push(Vec::new());
            lines.push(error_line(theme, width, error));
        }
        lines.push(Vec::new());
        lines.push(hint_line(theme, width, hint));
        lines.push(Vec::new());
        lines
    }
}

#[cfg(test)]
mod tests;
