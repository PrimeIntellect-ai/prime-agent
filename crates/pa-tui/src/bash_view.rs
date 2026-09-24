//! The dedicated bash view (the operator's 2026-09-23 redesign, refined
//! 2026-09-24): the session's kernel bash registry — the background
//! commands the agent's REPL started — as a columned table (command,
//! duration, pid, status) that hugs its content width (the columns never
//! stretch to the terminal edge), and Enter on a row opens the detail
//! drill-in (the operator's refined shape): one metadata row (pid,
//! started, duration, status), the exact command, and the fetched output
//! tail in a scrollable region — up/down walk the output, and reaching
//! the top of the loaded window lazily loads more of the tail (the
//! window starts at [`FIRST_TAIL_LINES`] and doubles on each load up to
//! the 200-line wire cap). The status colors code the rows (running
//! green, finished dim, failed red). The pane runs all the way to the
//! bottom of the screen: nothing rides below the shortcuts hint. Pure
//! presentation and selection: the host owns the 2s registry refresh,
//! fetches the output tails, and executes the kill.

use serde_json::Value;

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::{hug_row, menu_list_layout, plain_cell, scrub_controls, status_dot};
use crate::theme::{Theme, ThemeColor};
use crate::width::{str_width, truncate_line, wrap_text};
use crate::{Line, Span};

/// The preferred visible rows of the list.
const PREFERRED_VISIBLE: usize = 8;

/// Rows the list reserves outside its items (the inline geometry: rule,
/// title, blank, column header, blank, hint — the conditional
/// scroll-indicator row rides `menu_list_layout`'s scroll reservation,
/// never counted twice). The pane runs to the bottom of the screen: no
/// rule rides below the hint.
const LIST_FRAME_ROWS: usize = 6;

/// The command column's width cap.
const COMMAND_CAP: usize = 44;

/// The lines the open detail asks for first (the lazy tail: the pane
/// shows the newest output and loads more of it on upward scroll, so a
/// finished task's full output never loads up front).
pub const FIRST_TAIL_LINES: u32 = 50;

/// The lines the host's `tail_kernel_bash` request can carry at most (the
/// wire's own cap, a u32 on the payload): the load-more window doubles up
/// to this and stops.
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

/// Accept either the daemon response's `activities` array or the array
/// itself. Rows without a nonempty string id are ignored; ids are never
/// interpreted as pids.
pub fn parse_bash_activities(data: &Value) -> Vec<BashActivity> {
    let rows = data.get("activities").unwrap_or(data);
    rows.as_array()
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
                    .map(crate::menu_panel::scrub_controls)
                    .unwrap_or_else(|| "unknown".to_string()),
                exit_code: row.get("exitCode").and_then(Value::as_i64),
                duration_ms: row.get("durationMs").and_then(Value::as_u64),
            })
        })
        .collect()
}

/// The pane's interactive mode: the columned list, or a row's detail
/// drill-in.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Mode {
    List,
    Detail { id: String },
}

/// One key press while the view is open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BashViewAction {
    Close,
    /// Enter on a list row: the host fetches the row's output tail
    /// ([`FIRST_TAIL_LINES`] lines) and delivers it back with
    /// [`BashView::set_output`]; `generation` stamps the open it was
    /// issued under.
    OpenDetail {
        id: String,
        generation: u64,
    },
    /// Up at the top of the loaded output window (the lazy tail): the
    /// host re-fetches the row's output with the grown `lines` window
    /// and delivers it back the same way, stamped with the same open's
    /// `generation`.
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

/// The dedicated bash view over the kernel bash registry.
#[derive(Debug)]
pub struct BashView {
    /// The latest registry snapshot (the host's 2s refresh keeps it
    /// current).
    activities: Vec<BashActivity>,
    /// The detail drill-in's open generation: each open increments it,
    /// and the host stamps its tail requests with the generation they
    /// were issued under — a late response from an earlier open of the
    /// same row never overwrites the newer one's output.
    detail_generation: u64,
    selected_id: Option<String>,
    mode: Mode,
    /// The fetched output window of the open detail row: `Some` once a
    /// tail landed (empty output included), `None` while the open fetch
    /// is in flight.
    output_tail: Option<(String, Vec<String>)>,
    /// The tail window the current detail open holds: it starts at
    /// [`FIRST_TAIL_LINES`] and each lazy load doubles it up to
    /// [`TAIL_LINES`].
    tail_window: u32,
    /// The loaded window holds everything the wire can still give: set
    /// when a response came back shorter than its request (the kernel
    /// retained buffer's own end) or the wire's line cap was reached.
    /// Upward scroll at the top then shows the leading marker instead of
    /// issuing another fetch.
    tail_complete: bool,
    /// A lazy load-more fetch is in flight: the marker stays and the up
    /// key does not stack a second request.
    loading_more: bool,
    /// The output region's scroll position: how many lines the window
    /// rides lifted off the newest output (0 = bottom-anchored on the
    /// newest lines).
    scroll_from_end: usize,
    /// The output region's rendered height from the last paint: the key
    /// loop's scroll math walks the same window the pane rendered (a
    /// render always precedes a key press; 0 means nothing painted yet
    /// and the region cannot scroll).
    detail_region_rows: std::cell::Cell<usize>,
    error: Option<String>,
    /// Whether the shown error came from a tail fetch: a later
    /// successful fetch supersedes it (the retried load proves the
    /// failure gone); a kill error keeps the registry-refresh lifecycle
    /// ([`BashView::clear_error`]).
    fetch_error: bool,
    viewport_rows: usize,
}

impl BashView {
    /// Build the view over a registry snapshot.
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
            scroll_from_end: 0,
            detail_region_rows: std::cell::Cell::new(0),
            error: None,
            fetch_error: false,
            viewport_rows,
        };
        view.selected_id = view.activities.first().map(|row| row.id.clone());
        view
    }

    /// Reset the open detail's fetched-output state (new open, back to
    /// the list, or the row vanished): the next open starts from a fresh
    /// [`FIRST_TAIL_LINES`] window, bottom-anchored, with nothing in
    /// flight.
    fn reset_detail_output(&mut self) {
        self.output_tail = None;
        self.tail_window = FIRST_TAIL_LINES;
        self.tail_complete = false;
        self.loading_more = false;
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

    /// A fetched output window of one row (the host's `tail_kernel_bash`
    /// response); a window for a closed pane, a different row, or an
    /// earlier open of the same row is ignored. The open fetch
    /// bottom-anchors the region; a lazy load-more's larger window keeps
    /// the scroll anchored so the region continues into the newly loaded
    /// older lines, and a window that grew nothing keeps the current one
    /// (the retained buffer's end — or the wire's byte cap — was
    /// reached).
    pub fn set_output(&mut self, id: &str, tail: &str, generation: u64) {
        if self.detail_id().as_deref() != Some(id) || self.detail_generation != generation {
            return;
        }
        let lines: Vec<String> = tail.lines().map(clean_line).collect();
        // A landed window supersedes a shown fetch error (the retry — or
        // the fresh open — proves the failure gone); a kill error keeps
        // its registry-refresh lifecycle.
        if self.fetch_error {
            self.error = None;
            self.fetch_error = false;
        }
        if self.loading_more {
            self.loading_more = false;
            let loaded = self.output_tail.as_ref().map(|(_, output)| output.len());
            if loaded.is_some_and(|loaded| lines.len() > loaded) {
                // The region keeps walking into the newly loaded lines:
                // the user pressed up at the loaded top, so the window
                // lands anchored just above where it stopped (measured
                // from the end, one old window's height back).
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
            .map(|(_, output)| output.len())
            .unwrap_or(0);
        self.tail_complete = loaded < self.tail_window as usize || self.tail_window >= TAIL_LINES;
    }

    pub(crate) fn detail_id(&self) -> Option<String> {
        match &self.mode {
            Mode::Detail { id, .. } => Some(id.clone()),
            Mode::List => None,
        }
    }

    /// Surface a fetch or kill failure (the host's error channel). A
    /// fetch failure carries the detail-open generation it was issued
    /// under — like the tail responses, a late error from an earlier
    /// open of the same row never lands on the newer open (and never
    /// releases its in-flight load claim). A failed lazy load that DOES
    /// land releases its in-flight claim so a later up press can retry;
    /// `fetch` marks a tail-fetch failure, which the next successful
    /// fetch supersedes.
    pub fn set_error(&mut self, error: String, fetch: bool, generation: Option<u64>) {
        if fetch && generation.is_some_and(|generation| generation != self.detail_generation) {
            return;
        }
        self.loading_more = false;
        self.error = Some(error);
        self.fetch_error = fetch;
    }

    /// A landed REGISTRY update supersedes a shown error (a retried kill
    /// proves the failure gone): the host calls this only when the
    /// registry itself changed, not on unrelated dock repaints.
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

    /// One key id (the picker pattern: up/down move — in the detail they
    /// scroll the output region — Enter opens or runs, back returns,
    /// cancel closes).
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
    /// region (up toward the older lines, down back to the newest), and
    /// up at the top of the loaded window lazily loads more of the tail.
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

    /// Scroll the detail's output region: up lifts the window off the
    /// newest lines, down lowers it back; up at the loaded top issues the
    /// lazy load-more (the window doubles up to the wire's line cap) or
    /// stops at the retained buffer's beginning.
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
            // Nothing fetched yet: the open fetch owns the region.
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
            // At the top of the loaded window: load more of the tail.
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

    /// The list's visible-row budget (the inline shape).
    fn visible_items(&self) -> usize {
        let reserved = LIST_FRAME_ROWS + if self.error.is_some() { 2 } else { 0 };
        // The shared layout floors at one row so a picker never reads
        // empty; this view must never render past its viewport, so a
        // frame too short for any row renders none (the scroll
        // indicator follows: nothing to scroll).
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

    /// Render the view's frame: the columned list or the detail drill-in.
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        match &self.mode {
            Mode::List => self.render_list(theme, width, kb),
            Mode::Detail { id } => self.render_detail(theme, width, kb, id),
        }
    }

    /// The list pane: the title line with the live counts, the dim column
    /// header, one columned row per activity, the scroll indicator, and a
    /// single bottom hint line.
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
        lines.extend(self.pane_footer(theme, width, &self.list_hint(kb)));
        // The budget math keeps every normal viewport exact; a terminal
        // shorter than the frame itself degrades by truncation — the
        // pane never renders past its allocated rows.
        lines.truncate(self.viewport_rows.max(1));
        lines
    }

    /// The detail drill-in (the operator's refined shape): one metadata
    /// row (pid, started, duration, status), the exact command, and the
    /// fetched output in a scrollable region — nothing else. A short
    /// viewport shrinks the command first, then the output region — the
    /// action row and the hint never yield.
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
        // The drill-in's command block is the EXACT command — embedded
        // newlines and spacing stay verbatim — with the non-newline
        // control characters scrubbed: a command carrying an escape
        // sequence never executes terminal control operations when
        // rendered.
        let command_exact = scrub_controls(&activity.command);
        let actions = Self::available_actions(activity);
        let error_rows = if self.error.is_some() { 2 } else { 0 };
        // The pane's fixed rows: the rule, the metadata row, the blank
        // under the command, the blank over the hint, the hint, the
        // actions block (blank + row), and the error block when present.
        // The command and the output region ride the remaining budget in
        // that order — the output keeps at least one row, so a long
        // command clips before the region starves.
        let fixed = 5 + if actions.is_empty() { 0 } else { 2 } + error_rows;
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
                // The trailing marker rides inside the block's own
                // budget (a clipped block spends exactly its lines +
                // marker): the clip never overspends the viewport, and
                // the command's tail is what a clip drops.
                shown = command_rows.saturating_sub(1);
            }
            for line in command_wrapped[..shown].iter() {
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
        // The output region: the fetched window (scrollable — the newest
        // lines ride at the bottom, the `\u{2026}` marker rides over the
        // first row whenever content continues above, the `\u{2193}`
        // marker rides under the last row while the window sits lifted
        // off the newest output), a fetching note while the open fetch is
        // in flight, or the empty-output note once it landed.
        if output_rows > 0 {
            let tail = self
                .output_tail
                .as_ref()
                .filter(|(tail_id, _)| tail_id == id);
            match tail {
                Some((_, output)) if !output.is_empty() => {
                    let len = output.len();
                    let from_end = self.scroll_from_end.min(len.saturating_sub(output_rows));
                    // The pre-marker window: the `output_rows` rows the
                    // region covers, lifted `from_end` lines off the
                    // newest output (0 = the newest line rides the
                    // region's bottom).
                    let window_start = len.saturating_sub(output_rows + from_end);
                    // More below: the window sits lifted off the newest
                    // output (a scrolled-up view). A marker replaces its
                    // edge row of the window, so a marker renders only
                    // while a content row survives beside it: a one-row
                    // region (the designed minimum under a long command)
                    // always shows the output line itself, never a
                    // marker-only row (and the subtractions never
                    // underflow).
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
        // rendered: record its height after the truncation above (a
        // sub-frame viewport may have cut the region short).
        let total = fixed + command_rows + output_rows;
        let rendered = output_rows.saturating_sub(total.saturating_sub(self.viewport_rows));
        self.detail_region_rows.set(rendered);
        lines
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

    /// The detail pane's bottom hint line: the region's scroll keys, and
    /// the run key only while the open row still offers its cancel
    /// action.
    fn detail_hint(&self, kb: &KeybindingsManager) -> String {
        let key = |binding: &str, fallback: &str| {
            kb.first_key(binding)
                .map(|key| format_key_text(&key))
                .unwrap_or_else(|| fallback.to_string())
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

    /// The pane footer: the error block, a blank, and the hint line —
    /// the pane runs all the way to the bottom of the screen, so nothing
    /// rides below the shortcuts hint (no bottom border).
    fn pane_footer(&self, theme: &Theme, width: usize, hint: &str) -> Vec<Line> {
        let mut lines = Vec::new();
        if let Some(error) = &self.error {
            lines.push(Vec::new());
            lines.push(error_line(theme, width, error));
        }
        lines.push(Vec::new());
        lines.push(hint_line(theme, width, hint));
        lines
    }
}

/// The table's column geometry: the command, duration, pid, and status
/// cells sized over the rows and their header labels, with the command
/// column taking whatever width remains.
struct Columns {
    command: usize,
    duration: usize,
    pid: usize,
    status: usize,
}

impl Columns {
    fn new(width: usize, activities: &[BashActivity]) -> Self {
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
        // The status cell carries the operator's status dot beside the
        // word (menu_panel::status_dot).
        let status = activities
            .iter()
            .map(|activity| str_width(&activity.status) + 2)
            .chain([str_width("Status")])
            .max()
            .unwrap_or(0);
        // The fixed cells: the indent, the three two-column gaps, and
        // the duration, pid, and status columns.
        let fixed = 2 + 2 + 2 + 2 + 2 + duration_content + pid + status;
        let command_content = activities
            .iter()
            .map(|activity| str_width(&activity.command))
            .chain([str_width("Command")])
            .max()
            .unwrap_or(0);
        let command = command_content
            .min(COMMAND_CAP)
            .min(width.saturating_sub(fixed));
        Self {
            command,
            duration: duration_content,
            pid,
            status,
        }
    }

    /// The full span the row content covers (the hug's content width).
    fn content_width(&self) -> usize {
        2 + self.command + 2 + self.duration + 2 + self.pid + 2 + self.status
    }

    /// The dim column header row.
    fn header_row(&self, theme: &Theme, width: usize) -> Line {
        let mut row = vec![Span::raw("  ")];
        row.push(theme.fg_span(ThemeColor::Dim, plain_cell("Command", self.command)));
        row.push(Span::raw("  "));
        row.push(theme.fg_span(ThemeColor::Dim, plain_cell("Duration", self.duration)));
        row.push(Span::raw("  "));
        row.push(theme.fg_span(ThemeColor::Dim, plain_cell("PID", self.pid)));
        row.push(Span::raw("  "));
        row.push(theme.fg_span(ThemeColor::Dim, "Status".to_string()));
        truncate_line(&row, width, "")
    }

    /// One columned row: the command, the duration, the pid, and the
    /// status word in its status color (running green, a nonzero exit
    /// red — failed — everything else dim). The selected row's wash hugs
    /// the columns plus a little trailing pad.
    fn activity_row(
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
                        .map(|pid| pid.to_string())
                        .unwrap_or_else(|| "\u{2014}".to_string()),
                    self.pid,
                ),
            ),
        );
        row.push(Span::raw("  "));
        let (dot, _) = status_dot(&activity.status);
        row.push(theme.fg_span(status_color, format!("{dot} {}", activity.status)));
        hug_row(theme, row, self.content_width(), selected, width)
    }
}

/// One action row (the `/mcp` view's control pattern): the `›`-marker
/// label with its dim description trailing, the selected row washed over
/// its hug.
fn action_row(theme: &Theme, width: usize, label: &str, description: &str, selected: bool) -> Line {
    let mut row = vec![Span::raw(if selected { "\u{203a}" } else { " " })];
    row.push(Span::raw(" "));
    if selected {
        row.push(theme.bold(Span::raw(label.to_string())));
    } else {
        row.push(theme.fg_span(ThemeColor::Text, label.to_string()));
    }
    row.push(theme.fg_span(ThemeColor::Dim, format!("  {description}")));
    hug_row(
        theme,
        row,
        str_width(label) + 2 + 2 + str_width(description),
        selected,
        width,
    )
}

/// The status state's color (the operator's color-coding directive, on
/// the existing status vocabulary): running green, a settled nonzero
/// exit red — the failed state — everything else dim.
fn status_state_color(activity: &BashActivity) -> ThemeColor {
    if activity.running() {
        ThemeColor::Success
    } else if activity.exit_code.is_some_and(|code| code != 0) {
        ThemeColor::Error
    } else {
        ThemeColor::Dim
    }
}

/// The drill-in's one metadata row (the operator's refined shape): pid,
/// started, and duration joined by dim dots, with the status dot and
/// word trailing in its state color — the facts that frame the command,
/// one row, not a block of labeled pairs.
fn metadata_row(theme: &Theme, width: usize, activity: &BashActivity) -> Line {
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
    // The status rides last in its state color: the dot from the shared
    // status vocabulary and the current subtitle word (`running`, `exit
    // N`, or the wire's own status).
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

/// A dim region marker row (`\u{2026}` over the region's first row while
/// output continues above it, `\u{2193}` under the last while the window
/// sits lifted off the newest output).
fn marker_line(theme: &Theme, width: usize, marker: &str) -> Line {
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

/// Keep every fetched line inert as terminal text: process-provided
/// strings never forward control characters into the UI — but the
/// line's own leading and trailing spacing stays exactly as the kernel
/// wrote it (indented logs and fixed-width rows keep their shape).
fn clean_line(value: &str) -> String {
    scrub_controls(value)
}

/// The duration cell: whole milliseconds read as a compact human word
/// (`780ms`, `3.4s`, `2m 05s`), `—` when the wire carries none.
fn format_duration(duration_ms: Option<u64>) -> String {
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

/// The pane's header block: a muted separator rule, then the title row —
/// the title in plain text, the status counts trailing flush right, an
/// optional muted subtitle, and a blank line.
fn pane_header_lines(
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
fn hint_line(theme: &Theme, width: usize, hint: &str) -> Line {
    let line = vec![
        Span::raw("  "),
        theme.fg_span(ThemeColor::Dim, hint.to_string()),
    ];
    truncate_line(&line, width, "")
}

/// An error line (`Error: <message>` in the error color).
fn error_line(theme: &Theme, width: usize, message: &str) -> Line {
    let line = vec![
        Span::raw("  "),
        theme.fg_span(ThemeColor::Error, format!("Error: {message}")),
    ];
    truncate_line(&line, width, "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keybindings::KeybindingsManager;
    use crate::theme::{ColorMode, Theme};
    use serde_json::json;

    fn kb() -> KeybindingsManager {
        KeybindingsManager::new()
    }

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn activities() -> Vec<BashActivity> {
        parse_bash_activities(&json!({"activities": [
            {"id":"a","command":"cargo build --release","pid":42,"startedAt":"2026-09-22T01:00:00Z","status":"running","durationMs":3412},
            {"id":"b","command":"echo hi","status":"finished","exitCode":0,"durationMs":123},
        ]}))
    }

    /// A finished row with a nonzero exit (the failed state).
    fn failed_activities() -> Vec<BashActivity> {
        parse_bash_activities(&json!({"activities": [
            {"id":"f","command":"grep -rn panic src/","pid":7,"startedAt":"2026-09-22T01:00:00Z","status":"finished","exitCode":2,"durationMs":5_612},
        ]}))
    }

    fn frame_text(frame: &[Line]) -> Vec<String> {
        frame
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect()
    }

    /// The span styles of one frame row, for the color assertions.
    fn row_text(frame: &[Line], needle: &str) -> Option<Line> {
        frame
            .iter()
            .find(|line| line.iter().any(|span| span.content.contains(needle)))
            .cloned()
    }

    #[test]
    fn parse_reads_the_wire_shape() {
        let rows = activities();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "a");
        assert_eq!(rows[0].pid, Some(42));
        assert!(rows[0].running());
        assert_eq!(rows[1].exit_code, Some(0));
        assert!(!rows[1].running());
        // Rows without a nonempty id drop.
        let rows = parse_bash_activities(&json!({"activities": [
            {"command":"x"},
            {"id":"  ","command":"y"},
            {"id":"z","command":"w"},
        ]}));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "z");
    }

    /// The list is a columned table: a dim header naming the columns, the
    /// rows aligned under it, and one bottom hint line.
    #[test]
    fn the_list_renders_columned_rows_and_one_hint() {
        let view = BashView::new(activities(), 24);
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(text.iter().any(|row| row.contains("Bash")));
        assert!(text.iter().any(|row| row.contains("1 running")));
        let header = text
            .iter()
            .find(|row| row.contains("Command") && row.contains("Duration"))
            .expect("a column header row");
        assert!(header.contains("PID"));
        assert!(header.contains("Status"));
        let row = text
            .iter()
            .find(|row| row.contains("cargo build --release"))
            .expect("a columned row");
        assert!(row.contains("3.4s"));
        assert!(row.contains("42"));
        assert!(row.contains("running"));
        assert_eq!(
            text.iter().filter(|row| row.contains("Esc close")).count(),
            1,
            "the close hint appears once: {text:?}"
        );
        assert!(text
            .iter()
            .any(|row| row.contains("\u{2191}/\u{2193} move \u{b7} Enter open \u{b7} Esc close")));
        for line in &frame {
            assert!(crate::width::spans_width(line) <= 70);
        }
    }

    /// The table hugs its content width (the operator's 2026-09-24
    /// directive): the columns never stretch to the terminal edge — the
    /// rows, the header, and even the selected row's wash all stop before
    /// the end of the screen.
    #[test]
    fn the_table_hugs_its_content_width() {
        let view = BashView::new(activities(), 24);
        let frame = view.render(&theme(), 120, &kb());
        for line in &frame {
            let used = crate::width::spans_width(line);
            // Only the pane's top rule spans the frame; every table row
            // (header, plain, selected) stops well short of the edge.
            let is_rule = line.len() == 1 && line[0].content.starts_with("\u{2500}");
            assert!(
                is_rule || used < 120,
                "a content row never reaches the terminal edge: {used}"
            );
        }
        let selected = frame
            .iter()
            .find(|line| {
                line.iter()
                    .any(|span| span.style.bg.is_some() && span.content.contains("cargo"))
            })
            .expect("the selected row carries the wash");
        let used = crate::width::spans_width(selected);
        assert!(
            (crate::menu_panel::MIN_HUG_WIDTH..120).contains(&used),
            "the wash hugs the columns plus a little pad, never the width: {used}"
        );
        let header = frame
            .iter()
            .find(|line| line.iter().any(|span| span.content.contains("Duration")))
            .expect("the column header");
        assert!(crate::width::spans_width(header) < 120);
    }

    /// The selected row's wash hugs the columns plus a little trailing
    /// pad, never the whole terminal width.
    #[test]
    fn the_selection_hug_stops_a_little_past_the_text() {
        let view = BashView::new(activities(), 24);
        let frame = view.render(&theme(), 90, &kb());
        let selected = frame
            .iter()
            .find(|line| {
                line.iter()
                    .any(|span| span.style.bg.is_some() && span.content.contains("cargo"))
            })
            .expect("the selected row carries the wash");
        let used = crate::width::spans_width(selected);
        assert!(used < 90, "never the whole width: {used}");
        assert!(
            used >= crate::menu_panel::MIN_HUG_WIDTH,
            "hug floor: {used}"
        );
        let plain = frame
            .iter()
            .find(|line| line.iter().any(|span| span.content.contains("echo hi")))
            .expect("the other row");
        assert!(plain.iter().all(|span| span.style.bg.is_none()));
    }

    /// The status column color-codes the rows (the operator's
    /// color-coding directive): running green, a nonzero exit red — the
    /// failed state — a clean exit dim. The selected row's wash patches a
    /// background onto its spans, so the color check compares the
    /// foreground only.
    #[test]
    fn the_status_column_color_codes_the_states() {
        let success = theme().fg_style(ThemeColor::Success).fg;
        let dim = theme().fg_style(ThemeColor::Dim).fg;
        let error = theme().fg_style(ThemeColor::Error).fg;

        let view = BashView::new(activities(), 24);
        let frame = view.render(&theme(), 90, &kb());
        let running = row_text(&frame, "\u{25cf} running").expect("the running row");
        assert!(running.iter().any(|span| span.style.fg == success));
        let finished = row_text(&frame, "\u{25cb} finished").expect("the finished row");
        assert!(finished.iter().any(|span| span.style.fg == dim));
        assert!(finished.iter().all(|span| span.style.fg != error));

        let view = BashView::new(failed_activities(), 24);
        let frame = view.render(&theme(), 90, &kb());
        let failed = row_text(&frame, "\u{25cb} finished").expect("the failed row");
        assert!(failed.iter().any(|span| span.style.fg == error));
        assert!(failed.iter().all(|span| span.style.fg != success));
    }

    /// The pane runs all the way to the bottom of the screen (the
    /// operator's 2026-09-24 directive): the shortcuts hint is the pane's
    /// last row, and nothing — no blank, no rule — rides below it. A
    /// tall catalog fills the whole budget (the truncate keeps exactly
    /// the viewport rows), and a short catalog still ends on the hint
    /// (the dock's frame pads the rows above).
    #[test]
    fn the_pane_runs_to_the_bottom() {
        let rows: Vec<BashActivity> = (0..20)
            .map(|n| BashActivity {
                id: format!("run-{n}"),
                command: format!("command {n}"),
                pid: Some(n + 1),
                started_at: None,
                status: "finished".to_string(),
                exit_code: Some(0),
                duration_ms: Some(u64::from(n) * 1_000),
            })
            .collect();
        for viewport in [10usize, 16, 24] {
            let view = BashView::new(rows.clone(), viewport);
            let frame = view.render(&theme(), 70, &kb());
            // The pane never renders past its budget; its last row is the
            // hint (the dock anchors the pane's rows on the screen's
            // bottom — the rows above are the transcript, never a gap
            // below the shortcuts).
            assert!(frame.len() <= viewport, "never past the budget");
            let text = frame_text(&frame);
            let last_row = text.last().expect("the hint row");
            assert!(
                last_row.contains("close"),
                "the shortcuts hint rides the pane's last row: {last_row}"
            );
            assert!(
                !last_row.trim().is_empty() && !last_row.contains("\u{2500}"),
                "no rule or blank below the shortcuts: {last_row}"
            );
            let second_to_last = &text[text.len() - 2];
            assert!(
                second_to_last.trim().is_empty(),
                "the one blank above the hint stays: {second_to_last}"
            );
        }
        // A short catalog: the pane ends on the hint, never on a rule.
        let view = BashView::new(activities(), 24);
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        let last_row = text.last().expect("the hint row");
        assert!(last_row.contains("close"));
        assert!(!last_row.contains("\u{2500}"));
        // The detail pane too.
        let mut view = BashView::new(activities(), 16);
        view.handle_key("enter", &kb());
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        let last_row = text.last().expect("the detail hint row");
        assert!(last_row.contains("close"));
        assert!(!last_row.contains("\u{2500}"));
    }

    /// Enter on a list row opens the detail drill-in and asks the host
    /// for the output tail; Enter in the detail on the cancel action runs
    /// the kill.
    #[test]
    fn enter_opens_the_detail_and_the_cancel_action() {
        let mut view = BashView::new(activities(), 24);
        let action = view.handle_key("enter", &kb());
        let BashViewAction::OpenDetail {
            id: open_id,
            generation: first_generation,
        } = &action
        else {
            panic!("the first enter opens the detail: {action:?}");
        };
        assert_eq!(open_id, "a");
        assert_eq!(
            view.mode,
            Mode::Detail {
                id: "a".to_string()
            }
        );
        assert_eq!(
            view.handle_key("enter", &kb()),
            BashViewAction::Kill { id: "a".into() }
        );
        // Back to the list, then the finished row: it offers no actions.
        assert_eq!(view.handle_key("left", &kb()), BashViewAction::None);
        assert_eq!(view.mode, Mode::List);
        view.handle_key("down", &kb());
        let action = view.handle_key("enter", &kb());
        let BashViewAction::OpenDetail { id: open_id, .. } = &action else {
            panic!("the finished row opens its detail: {action:?}");
        };
        assert_eq!(open_id, "b");
        assert_eq!(view.handle_key("enter", &kb()), BashViewAction::None);
        let _ = first_generation;
    }

    /// The drill-in is the operator's refined shape: ONE metadata row
    /// (pid, started, duration together with the status), then the exact
    /// command, then the output — no labeled-pair blocks, no section
    /// labels, no duplicated title.
    #[test]
    fn the_detail_is_one_metadata_row_the_command_and_the_output() {
        let mut view = BashView::new(activities(), 40);
        view.handle_key("enter", &kb());
        view.set_output(
            "a",
            "line one\n\x1b[31mred\x1b[0m\nline three",
            view.detail_generation,
        );
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        let joined = text.join("\n");
        // The one metadata row carries pid, started, duration, and the
        // status together.
        assert!(
            text.iter().any(|row| {
                row.contains("pid 42")
                    && row.contains("started")
                    && row.contains("3.4s")
                    && row.contains("running")
            }),
            "one metadata row with the facts together: {text:?}"
        );
        // No labeled pairs, no section labels, no duplicate title.
        assert!(!text.iter().any(|row| row.contains("  Command")));
        assert!(!text.iter().any(|row| row.contains("  Output")));
        assert_eq!(
            text.iter()
                .filter(|row| row.contains("cargo build --release"))
                .count(),
            1,
            "the command renders once, not again as a title: {text:?}"
        );
        // The output renders under the command, control characters
        // scrubbed.
        let command_index = text
            .iter()
            .position(|row| row.contains("cargo build --release"))
            .expect("the command row");
        let output_index = text
            .iter()
            .position(|row| row.contains("line one"))
            .expect("the output row");
        assert!(
            output_index > command_index,
            "the output rides under the command"
        );
        assert!(joined.contains("red"));
        assert!(!joined.contains("\x1b"));
        // The cancel action and the scroll hint.
        assert!(text.iter().any(|row| row.contains("Cancel command")));
        assert!(text.iter().any(|row| row.contains(
            "\u{2191}/\u{2193} scroll \u{b7} Enter run \u{b7} \u{2190} back \u{b7} Esc close"
        )));
    }

    /// The metadata row's status rides in its state color: the running
    /// row green, the failed exit red.
    #[test]
    fn the_detail_status_color_codes_the_state() {
        let mut view = BashView::new(activities(), 40);
        view.handle_key("enter", &kb());
        let frame = view.render(&theme(), 70, &kb());
        let metadata = row_text(&frame, "running").expect("the metadata row");
        assert!(metadata
            .iter()
            .any(|span| span.style == theme().fg_style(ThemeColor::Success)));

        let mut view = BashView::new(failed_activities(), 40);
        view.handle_key("enter", &kb());
        let frame = view.render(&theme(), 70, &kb());
        let metadata = row_text(&frame, "exit 2").expect("the failed metadata row");
        assert!(metadata
            .iter()
            .any(|span| span.style == theme().fg_style(ThemeColor::Error)));
    }

    /// The finished row's drill-in carries no run key (nothing to run)
    /// and no action row.
    #[test]
    fn the_finished_detail_has_no_action_and_no_run_hint() {
        let mut view = BashView::new(activities(), 40);
        view.handle_key("down", &kb());
        view.handle_key("enter", &kb());
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(!text.iter().any(|row| row.contains("Cancel command")));
        assert!(
            text.iter().any(|row| row
                .contains("\u{2191}/\u{2193} scroll \u{b7} \u{2190} back \u{b7} Esc close")),
            "no run key without an action: {text:?}"
        );
    }

    /// A tail for another row never lands in the open pane, and an empty
    /// fetched tail reads as its own note.
    #[test]
    fn stale_and_empty_tails_are_handled() {
        let mut view = BashView::new(activities(), 40);
        view.handle_key("enter", &kb());
        view.set_output("b", "wrong row", view.detail_generation);
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(text.iter().any(|row| row.contains("Fetching output")));
        view.set_output("a", "", view.detail_generation);
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(text.iter().any(|row| row.contains("No output yet")));
        assert!(!text.iter().any(|row| row.contains("wrong row")));
    }

    #[test]
    fn back_returns_to_the_list_and_escape_closes() {
        let mut view = BashView::new(activities(), 24);
        view.handle_key("enter", &kb());
        assert_eq!(view.handle_key("left", &kb()), BashViewAction::None);
        assert_eq!(view.mode, Mode::List);
        assert_eq!(view.handle_key("escape", &kb()), BashViewAction::Close);
        assert_eq!(view.handle_key("ctrl+c", &kb()), BashViewAction::Close);
    }

    /// A registry refresh keeps the selection on the surviving id and
    /// drops a detail pane whose row vanished.
    #[test]
    fn a_refresh_keeps_the_surviving_selection() {
        let mut view = BashView::new(activities(), 24);
        view.handle_key("down", &kb());
        assert_eq!(view.selected_id.as_deref(), Some("b"));
        let refreshed = parse_bash_activities(&json!({"activities": [
            {"id":"c","command":"ls","status":"running"},
        ]}));
        view.apply_activities(refreshed);
        assert_eq!(view.selected_id.as_deref(), Some("c"));
        // The detail pane conforms when its row vanishes.
        view.handle_key("enter", &kb());
        let emptied = parse_bash_activities(&json!({"activities": []}));
        view.apply_activities(emptied);
        assert_eq!(view.mode, Mode::List);
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(text
            .iter()
            .any(|row| row.contains("No background commands")));
    }

    /// A short viewport shrinks the panes so they never exceed the
    /// terminal budget.
    #[test]
    fn short_viewports_never_clip_the_panes() {
        for viewport_rows in [9usize, 10, 12, 14] {
            let view = BashView::new(activities(), viewport_rows);
            let frame = view.render(&theme(), 70, &kb());
            assert!(frame.len() <= viewport_rows, "viewport {viewport_rows}");
            let text = frame_text(&frame);
            assert!(text.iter().any(|row| row.contains("Esc close")));
        }
        let mut view = BashView::new(activities(), 12);
        view.handle_key("enter", &kb());
        let frame = view.render(&theme(), 70, &kb());
        assert!(frame.len() <= 12, "detail pane fits: {}", frame.len());
        let text = frame_text(&frame);
        assert!(text.iter().any(|row| row.contains("Cancel command")));
    }

    /// A short viewport shrinks the command first, then the output — the
    /// action row and the hint never yield.
    #[test]
    fn a_tight_viewport_keeps_the_output_minimum_over_the_command() {
        let mut catalog = activities();
        catalog[0].command = "word ".repeat(80);
        let mut view = BashView::new(catalog, 12);
        view.handle_key("enter", &kb());
        let frame = view.render(&theme(), 70, &kb());
        assert!(frame.len() <= 12, "the drill-in fits: {}", frame.len());
        let text = frame_text(&frame);
        assert!(text.iter().any(|row| row.contains("word")));
        assert!(text.iter().any(|row| row.contains("Cancel command")));
        assert!(text.iter().any(|row| row.contains("Fetching output")));
    }

    /// The region's default view is the newest output: a tail taller than
    /// the region drops the OLDEST lines (the leading marker says so),
    /// never the newest.
    #[test]
    fn the_region_anchors_on_the_newest_output() {
        let mut catalog = activities();
        catalog[0].command = "run".to_string(); // short command, long output
        let mut view = BashView::new(catalog, 20);
        view.handle_key("enter", &kb());
        let tail: Vec<String> = (1..=30).map(|n| format!("line-{n:02}")).collect();
        view.set_output("a", &tail.join("\n"), view.detail_generation);
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(frame.len() <= 20, "the drill-in fits: {}", frame.len());
        let joined = text.join(" ");
        assert!(joined.contains("line-30"), "the newest line renders");
        assert!(!joined.contains("line-01"), "the oldest drops first");
        // The leading marker rides over the first region row.
        let marker = text
            .iter()
            .position(|row| row.trim() == "\u{2026}")
            .expect("the leading marker");
        let newest = text
            .iter()
            .position(|row| row.contains("line-30"))
            .expect("the newest row");
        assert!(marker < newest, "the marker rides above the content");
    }

    /// Up scrolls the region toward the older lines (a `\u{2193}` marker
    /// rides under the last row), and down walks back to the newest.
    #[test]
    fn the_region_scrolls_up_and_down() {
        let mut catalog = activities();
        catalog[0].command = "run".to_string();
        let mut view = BashView::new(catalog, 24);
        view.handle_key("enter", &kb());
        let tail: Vec<String> = (1..=40).map(|n| format!("line-{n:02}")).collect();
        view.set_output("a", &tail.join("\n"), view.detail_generation);
        // A paint records the region's height; the keys walk the same
        // window (the real flow paints before keys arrive).
        let _ = view.render(&theme(), 70, &kb());
        let mut frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(text.iter().any(|row| row.contains("line-40")));
        assert!(!text.iter().any(|row| row.contains("line-02")));

        view.handle_key("up", &kb());
        frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(
            text.iter().any(|row| row.contains("line-25")),
            "one up reveals the next older line: {text:?}"
        );
        assert!(
            !text.iter().any(|row| row.contains("line-40")),
            "the lifted window's newest edge hides under the trailing marker"
        );
        assert!(
            text.iter().any(|row| row.trim() == "\u{2193}"),
            "the trailing marker rides under a lifted window"
        );
        assert!(text.iter().any(|row| row.contains("\u{2026}")));

        view.handle_key("down", &kb());
        frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(
            text.iter().any(|row| row.contains("line-40")),
            "down walks back to the newest output"
        );
        assert!(
            !text.iter().any(|row| row.trim() == "\u{2193}"),
            "bottom-anchored again: no trailing marker"
        );
    }

    /// Up at the top of the loaded window lazily loads more of the tail:
    /// the window doubles (50 -> 100 -> 200, the wire's cap), the grown
    /// response anchors the region just above where it stopped, and the
    /// wire cap or a non-growing response ends the loads.
    #[test]
    fn up_at_the_loaded_top_lazily_loads_more_of_the_tail() {
        let mut catalog = activities();
        catalog[0].command = "run".to_string();
        let mut view = BashView::new(catalog, 24);
        view.handle_key("enter", &kb());
        let first: Vec<String> = (1..=FIRST_TAIL_LINES)
            .map(|n| format!("line-{n:03}"))
            .collect();
        view.set_output("a", &first.join("\n"), view.detail_generation);
        let _ = view.render(&theme(), 70, &kb());
        // A full window does not promise more: up walks the loaded lines.
        assert_eq!(view.handle_key("up", &kb()), BashViewAction::None);

        // Scroll to the loaded top: the next up issues the lazy load.
        for _ in 0..FIRST_TAIL_LINES {
            match view.handle_key("up", &kb()) {
                BashViewAction::LoadMore { id, lines, .. } => {
                    assert_eq!(id, "a");
                    assert_eq!(lines, FIRST_TAIL_LINES * 2);
                    // The grown window lands: it holds the same newest
                    // lines plus the older ones prepended.
                    let mut grown: Vec<String> = (1..=FIRST_TAIL_LINES * 2)
                        .map(|n| format!("line-{n:03}"))
                        .collect();
                    grown.truncate(FIRST_TAIL_LINES as usize * 2);
                    view.set_output("a", &grown.join("\n"), view.detail_generation);
                    break;
                }
                BashViewAction::None => continue,
                other => panic!("up only walks or loads: {other:?}"),
            }
        }
        assert_eq!(view.tail_window, FIRST_TAIL_LINES * 2);
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        let joined = text.join(" ");
        // The region continues into the older lines (anchored just above
        // where the walk stopped), not back onto the newest output.
        assert!(
            joined.contains("line-049"),
            "the region walks into the older lines: {joined}"
        );
        assert!(
            !joined.contains("line-100"),
            "the newest lines no longer fill the region: {joined}"
        );
        assert!(!view.tail_complete, "the grown window may still grow");

        // Up at the top again: the last possible window.
        for _ in 0..(FIRST_TAIL_LINES * 2 + 8) {
            match view.handle_key("up", &kb()) {
                BashViewAction::LoadMore { lines, .. } => {
                    assert_eq!(lines, TAIL_LINES);
                    let full: Vec<String> =
                        (1..=TAIL_LINES).map(|n| format!("line-{n:03}")).collect();
                    view.set_output("a", &full.join("\n"), view.detail_generation);
                    break;
                }
                BashViewAction::None => continue,
                other => panic!("up only walks or loads: {other:?}"),
            }
        }
        assert_eq!(view.tail_window, TAIL_LINES);
        assert!(view.tail_complete, "the wire's line cap is the end");
        // No further loads: the up key just walks (or rests at the top).
        for _ in 0..TAIL_LINES + 4 {
            assert!(
                matches!(view.handle_key("up", &kb()), BashViewAction::None),
                "no loads past the wire cap"
            );
        }
    }

    /// A lazy load that grew nothing (the retained buffer's end, or the
    /// wire's byte cap) completes the tail: no further loads, the window
    /// stays.
    #[test]
    fn a_load_more_that_grew_nothing_completes_the_tail() {
        let mut catalog = activities();
        catalog[0].command = "run".to_string();
        let mut view = BashView::new(catalog, 24);
        view.handle_key("enter", &kb());
        let tail: Vec<String> = (1..=FIRST_TAIL_LINES)
            .map(|n| format!("line-{n:03}"))
            .collect();
        view.set_output("a", &tail.join("\n"), view.detail_generation);
        let _ = view.render(&theme(), 70, &kb());
        for _ in 0..FIRST_TAIL_LINES {
            match view.handle_key("up", &kb()) {
                BashViewAction::LoadMore {
                    id,
                    generation,
                    lines,
                } => {
                    assert_eq!(id, "a");
                    assert_eq!(generation, view.detail_generation);
                    assert_eq!(lines, FIRST_TAIL_LINES * 2);
                    // The kernel's retained buffer had nothing more.
                    view.set_output("a", &tail.join("\n"), generation);
                    break;
                }
                BashViewAction::None => continue,
                other => panic!("up only walks or loads: {other:?}"),
            }
        }
        assert!(view.tail_complete, "a non-growing response ends the loads");
        assert!(!view.loading_more);
        for _ in 0..FIRST_TAIL_LINES {
            assert!(
                matches!(view.handle_key("up", &kb()), BashViewAction::None),
                "no further loads after completion"
            );
        }
    }

    /// A response shorter than the requested window is the retained
    /// buffer's own end: the tail is complete and the up key never loads.
    #[test]
    fn a_short_window_completes_the_tail() {
        let mut catalog = activities();
        catalog[0].command = "run".to_string();
        let mut view = BashView::new(catalog, 24);
        view.handle_key("enter", &kb());
        let tail: Vec<String> = (1..=20).map(|n| format!("line-{n:02}")).collect();
        view.set_output("a", &tail.join("\n"), view.detail_generation);
        assert!(view.tail_complete, "20 lines over a 50-line window");
        let _ = view.render(&theme(), 70, &kb());
        for _ in 0..30 {
            assert!(
                matches!(view.handle_key("up", &kb()), BashViewAction::None),
                "a complete tail never loads more"
            );
        }
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(
            text.iter().any(|row| row.contains("line-01")),
            "the retained beginning renders once scrolled to the top"
        );
        assert!(
            !text.iter().any(|row| row.trim() == "\u{2026}"),
            "no continuation marker over a complete tail"
        );
    }

    /// A fetch or load error surfaces in the pane and releases the
    /// in-flight load claim so a later up press can retry — and the
    /// retried load's success supersedes the shown fetch error (the
    /// failure it described is gone; a kill error keeps the
    /// registry-refresh lifecycle and never clears on a tail landing).
    #[test]
    fn an_error_releases_the_load_claim_and_a_success_clears_it() {
        let mut catalog = activities();
        catalog[0].command = "run".to_string();
        let mut view = BashView::new(catalog, 24);
        view.handle_key("enter", &kb());
        let tail: Vec<String> = (1..=FIRST_TAIL_LINES)
            .map(|n| format!("line-{n:03}"))
            .collect();
        view.set_output("a", &tail.join("\n"), view.detail_generation);
        let _ = view.render(&theme(), 70, &kb());
        let mut loaded = false;
        for _ in 0..FIRST_TAIL_LINES {
            match view.handle_key("up", &kb()) {
                BashViewAction::LoadMore {
                    generation, lines, ..
                } => {
                    view.set_error("kernel stalled".to_string(), true, Some(generation));
                    assert!(view.error.is_some());
                    assert!(!view.loading_more, "the failure releases the claim");
                    assert_eq!(view.tail_window, lines);
                    assert_eq!(generation, view.detail_generation);
                    loaded = true;
                    break;
                }
                BashViewAction::None => continue,
                other => panic!("up only walks or loads: {other:?}"),
            }
        }
        assert!(loaded, "the up press issued the load");
        let frame = view.render(&theme(), 70, &kb());
        assert!(
            frame_text(&frame)
                .iter()
                .any(|row| row.contains("Error: kernel stalled")),
            "the fetch error surfaces"
        );
        // A retry issues a fresh load (the window keeps growing from the
        // last requested size).
        let mut retried = false;
        for _ in 0..FIRST_TAIL_LINES {
            match view.handle_key("up", &kb()) {
                BashViewAction::LoadMore {
                    lines, generation, ..
                } => {
                    assert_eq!(lines, FIRST_TAIL_LINES * 4);
                    // The grown window lands: the shown fetch error is
                    // stale — the fetch just succeeded.
                    let grown: Vec<String> = (1..=FIRST_TAIL_LINES * 4)
                        .map(|n| format!("line-{n:03}"))
                        .collect();
                    view.set_output("a", &grown.join("\n"), generation);
                    retried = true;
                    break;
                }
                BashViewAction::None => continue,
                other => panic!("up only walks or loads: {other:?}"),
            }
        }
        assert!(retried, "the retry loads again");
        assert!(
            view.error.is_none(),
            "the successful fetch supersedes the fetch error"
        );
        let frame = view.render(&theme(), 70, &kb());
        assert!(
            !frame_text(&frame).iter().any(|row| row.contains("Error:")),
            "the error row is gone after the landing"
        );

        // A kill error keeps its lifecycle: a tail landing never clears
        // it (only the registry refresh does).
        view.set_error("Could not kill bash command: gone".to_string(), false, None);
        assert!(view.error.is_some());
        view.set_output("a", &tail.join("\n"), view.detail_generation);
        assert!(
            view.error.is_some(),
            "a tail landing never clears a kill error"
        );
        view.clear_error();
        assert!(view.error.is_none());
    }

    /// A late fetch error from an earlier open of the same row never
    /// lands on the newly reopened detail (the generation gate the tail
    /// responses already had): it never shows, and never releases the
    /// newer open's in-flight load claim. A kill error owns no
    /// generation and keeps its landing.
    #[test]
    fn a_late_fetch_error_never_lands_on_a_reopened_detail() {
        let mut view = BashView::new(activities(), 40);
        view.handle_key("enter", &kb());
        let first_generation = view.detail_generation;
        // Back out and reopen the same row while a load is in flight
        // under the new open.
        view.handle_key("left", &kb());
        view.handle_key("enter", &kb());
        assert_ne!(view.detail_generation, first_generation);
        view.loading_more = true;
        // The earlier open's late fetch error never lands.
        view.set_error(
            "stale fetch failure".to_string(),
            true,
            Some(first_generation),
        );
        assert!(view.error.is_none(), "the stale error never shows");
        assert!(
            view.loading_more,
            "a prior open's error never releases the current claim"
        );
        // The current open's fetch error lands and releases the claim.
        view.set_error(
            "current fetch failure".to_string(),
            true,
            Some(view.detail_generation),
        );
        assert_eq!(view.error.as_deref(), Some("current fetch failure"));
        assert!(!view.loading_more);
        // A kill error owns no generation: it still lands on the open
        // detail (its lifecycle is the registry refresh).
        view.set_error("Could not kill bash command: nope".to_string(), false, None);
        assert!(view.error.is_some());
    }

    /// A one-row output region (the designed minimum under a long
    /// command) always shows the output line itself: a marker renders
    /// only while a content row survives beside it, so scrolling never
    /// underflows the region and never leaves a marker-only row.
    #[test]
    fn a_one_row_region_keeps_the_output_line() {
        let mut catalog = activities();
        catalog[0].command = "run".to_string();
        // viewport 9: fixed 7 (running row) leaves a 2-row budget - the
        // one-line command and exactly one output row.
        let mut view = BashView::new(catalog, 9);
        view.handle_key("enter", &kb());
        let tail: Vec<String> = (1..=5).map(|n| format!("line-{n}")).collect();
        view.set_output("a", &tail.join("\n"), view.detail_generation);
        let frame = view.render(&theme(), 70, &kb());
        assert!(frame.len() <= 9, "the pane fits: {}", frame.len());
        let text = frame_text(&frame);
        assert!(
            text.iter().any(|row| row.contains("line-5")),
            "the one-row region anchors on the newest line: {text:?}"
        );
        // The recorded region height is exactly one row.
        assert_eq!(view.detail_region_rows.get(), 1);

        // Scrolling up never panics and never leaves a marker-only row:
        // the single row shows the scrolled line itself.
        for expected in ["line-4", "line-3", "line-2", "line-1"] {
            view.handle_key("up", &kb());
            let frame = view.render(&theme(), 70, &kb());
            let text = frame_text(&frame);
            assert!(
                text.iter().any(|row| row.contains(expected)),
                "the up press walks to {expected}: {text:?}"
            );
        }
        // Down walks back to the newest.
        for _ in 0..4 {
            view.handle_key("down", &kb());
        }
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(text.iter().any(|row| row.contains("line-5")));
    }

    /// The exact command renders verbatim: repeated spaces and embedded
    /// newlines stay (the drill-in is the full text, not the summary).
    #[test]
    fn the_detail_renders_the_exact_command_verbatim() {
        let mut catalog = activities();
        catalog[0].command = "echo  a\nls  --all".to_string();
        let mut view = BashView::new(catalog, 40);
        view.handle_key("enter", &kb());
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        let joined = text.join(" ");
        assert!(joined.contains("echo  a"), "repeated spaces stay: {joined}");
        assert!(joined.contains("ls  --all"), "the second line stays");
    }

    /// Fetched output keeps its own leading spacing (indented logs keep
    /// their shape); only control characters scrub.
    #[test]
    fn fetched_output_keeps_its_leading_spacing() {
        let mut view = BashView::new(activities(), 40);
        view.handle_key("enter", &kb());
        view.set_output("a", "    indented line\nplain line", view.detail_generation);
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(
            text.iter().any(|row| row.contains("    indented line")),
            "leading spacing stays: {text:?}"
        );
    }

    /// A late tail from an earlier open of the same row never overwrites
    /// the newer open's output (the generation token).
    #[test]
    fn a_stale_generation_never_overwrites_the_reopened_detail() {
        let mut view = BashView::new(activities(), 40);
        view.handle_key("enter", &kb());
        let first_generation = view.detail_generation;
        view.set_output("a", "first fetch", first_generation);
        // Back out and reopen the same row: a new generation.
        view.handle_key("left", &kb());
        view.handle_key("enter", &kb());
        assert_ne!(view.detail_generation, first_generation);
        // The earlier open's late response is ignored.
        view.set_output("a", "stale fetch", first_generation);
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(
            !text.iter().any(|row| row.contains("stale fetch")),
            "the stale generation never lands: {text:?}"
        );
        // The current generation's response lands.
        view.set_output("a", "fresh fetch", view.detail_generation);
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(text.iter().any(|row| row.contains("fresh fetch")));
    }

    /// A clipped command block spends exactly its budget: the marker
    /// trails the kept head (the tail is what a clip drops) and the
    /// pane never renders past the viewport.
    #[test]
    fn a_clipped_command_trails_the_marker_inside_the_budget() {
        let mut catalog = activities();
        catalog[0].command = "word ".repeat(200);
        let mut view = BashView::new(catalog, 18);
        view.handle_key("enter", &kb());
        let frame = view.render(&theme(), 70, &kb());
        assert!(frame.len() <= 18, "the drill-in fits: {}", frame.len());
        let text = frame_text(&frame);
        assert!(
            text.iter().any(|row| row.contains("word")),
            "the command's head renders"
        );
        let text_idx = text
            .iter()
            .position(|row| row.trim() == "\u{2026}")
            .expect("the marker renders");
        let word_idx = text
            .iter()
            .position(|row| row.contains("word"))
            .expect("the command line");
        assert!(
            text_idx > word_idx,
            "the marker trails the command: {text:?}"
        );
        assert!(text.iter().any(|row| row.contains("Fetching output")));
    }

    /// A terminal shorter than the frame itself never renders past its
    /// allocated rows (the pane degrades by truncation).
    #[test]
    fn a_sub_frame_viewport_never_overflows() {
        for viewport_rows in [1usize, 2, 3, 5, 7] {
            let view = BashView::new(activities(), viewport_rows);
            let frame = view.render(&theme(), 70, &kb());
            assert!(
                frame.len() <= viewport_rows,
                "viewport {viewport_rows}: pane is {} rows",
                frame.len()
            );
        }
    }

    #[test]
    fn durations_format_compactly() {
        assert_eq!(format_duration(None), "\u{2014}");
        assert_eq!(format_duration(Some(780)), "780ms");
        assert_eq!(format_duration(Some(3_412)), "3.4s");
        assert_eq!(format_duration(Some(125_000)), "2m 05s");
    }
}
