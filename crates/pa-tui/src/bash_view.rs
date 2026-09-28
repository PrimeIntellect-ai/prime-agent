//! The dedicated bash view (the operator's 2026-09-23 redesign, refined
//! 2026-09-24): the session's kernel bash registry — the background
//! commands the agent's REPL started — as a columned table (command,
//! duration, pid, status) whose columns hug their content (the columns
//! never stretch to the terminal edge) while the table surface fills
//! the full width (the selected row's wash spans the terminal, the
//! operator's 2026-09-24 ruling), and Enter on a row opens the detail
//! drill-in (the operator's refined shape): one metadata row (pid,
//! started, duration, status), the exact command, and the fetched output
//! tail in a scrollable region — up/down walk the output, and reaching
//! the top of the loaded window lazily loads more of the tail (the
//! window starts at [`FIRST_TAIL_LINES`] and doubles on each load up to
//! the 200-line wire cap). The status colors code the rows (running
//! green, finished dim, failed red). The pane runs all the way to the
//! bottom of the screen: no rule rides below the shortcuts hint — one
//! blank line of spacing rides under it (the operator's 2026-09-24
//! ruling). Pure
//! presentation and selection: the host owns the 2s registry refresh,
//! fetches the output tails, and executes the kill.

use serde_json::Value;

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::{
    fill_row, hug_row, menu_list_layout, plain_cell, scrub_controls, status_dot,
};
use crate::theme::{Theme, ThemeColor};
use crate::width::{str_width, truncate_line, wrap_text};
use crate::{Line, Span};

/// The preferred visible rows of the list.
const PREFERRED_VISIBLE: usize = 8;

/// Rows the list reserves outside its items (the inline geometry: rule,
/// title, blank, column header, blank, hint, blank — the conditional
/// scroll-indicator row rides `menu_list_layout`'s scroll reservation,
/// never counted twice). No rule rides below the hint: one blank line of
/// spacing rides under the shortcuts instead (the operator's 2026-09-24
/// ruling).
const LIST_FRAME_ROWS: usize = 7;

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
/// interpreted as pids. Running shells ride the top (the operator's
/// running-first ruling, 2026-09-25): the stable sort keeps the
/// registry's own order within each side, the idle, stopped, and dead
/// rows follow the live work.
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
    /// The failed open fetch's retry is in flight (an Up press re-issued
    /// it): further Ups do not stack duplicates, and the retry's landing
    /// or failure clears the claim — a late duplicate failure can never
    /// paint an error over output that already arrived.
    open_retry: bool,
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

    /// Reset the open detail's fetched-output state (new open, back to
    /// the list, or the row vanished): the next open starts from a fresh
    /// [`FIRST_TAIL_LINES`] window, bottom-anchored, with nothing in
    /// flight.
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
        // its registry-refresh lifecycle. A landed window also releases
        // the open retry's in-flight claim.
        self.open_retry = false;
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
            .map_or(0, |(_, output)| output.len());
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
    /// releases its in-flight load claim). A landed fetch failure
    /// restores the lazy-load window to the loaded size (so the retry
    /// re-issues instead of reading the wire cap as the end) and
    /// releases the in-flight claim for the retry; a kill error touches
    /// neither — it knows nothing about the load's fate.
    pub fn set_error(&mut self, error: String, fetch: bool, generation: Option<u64>) {
        if fetch && generation.is_some_and(|generation| generation != self.detail_generation) {
            return;
        }
        if fetch {
            // A failed lazy load never leaves its grown window behind:
            // the retry re-issues from the loaded size (a window left at
            // the wire's line cap would read as the end and stop
            // retrying — the remaining output would be permanently
            // inaccessible).
            if self.loading_more {
                self.tail_window = self
                    .output_tail
                    .as_ref()
                    .map_or(FIRST_TAIL_LINES, |(_, output)| output.len() as u32);
            }
            // Only a fetch failure releases the in-flight claims (the
            // lazy load's, the open retry's): a kill error knows nothing
            // about the fetches' fate, and a duplicate racing the still-
            // in-flight one could let either response overwrite the
            // other's scroll state.
            self.loading_more = false;
            self.open_retry = false;
        }
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
            // The open fetch failed before anything loaded: an Up press
            // retries it (the shown fetch error has no other retry from
            // the detail view). While the open fetch is still in flight
            // (no error shown), Up does nothing.
            if self.fetch_error {
                // One retry at a time: the claim holds until the retry
                // lands or fails, so key repeats never stack duplicate
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
        // under the command, the blank over the hint, the hint, the blank
        // below the hint, the actions block (blank + row), and the error
        // block when present. The command and the output region ride the
        // remaining budget in that order — the output keeps at least one
        // row, so a long command clips before the region starves.
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
                // The trailing marker rides inside the block's own
                // budget (a clipped block spends exactly its lines +
                // marker): the clip never overspends the viewport, and
                // the command's tail is what a clip drops.
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
    /// The list's bottom hint line: the back and cancel keys both close
    /// from the list while both are bound, and an override that empties
    /// the back binding drops its key (the hint never advertises a key
    /// the handler does not take; the cancel fallback is the pane's
    /// core key).
    fn list_hint(&self, kb: &KeybindingsManager) -> String {
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

    /// The detail pane's bottom hint line: the region's scroll keys, and
    /// the run key only while the open row still offers its cancel
    /// action.
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
    /// blank line below the shortcuts (the operator's 2026-09-24 ruling:
    /// no rule rides under the hint — spacing, not a divider).
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
        let fixed = 2 + 2 + 2 + 2 + duration_content + pid + status;
        // The command column carries the full remaining width (the
        // operator's width-distribution ruling, 2026-09-25): the fixed
        // fact columns hug their content, the command prose column
        // absorbs the rest, so the columns together span the terminal —
        // no dead space past the last column.
        let command = width.saturating_sub(fixed);
        Self {
            command,
            duration: duration_content,
            pid,
            status,
        }
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
        row.push(theme.fg_span(ThemeColor::Dim, plain_cell("Status", self.status)));
        truncate_line(&row, width, "")
    }

    /// One columned row: the command, the duration, the pid, and the
    /// status word in its status color (running green, a nonzero exit
    /// red — failed — everything else dim). The selected row's wash
    /// spans the full frame width (the operator's "table fills the
    /// width" ruling) while the columns keep their content-hug
    /// geometry.
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
        fill_row(theme, row, selected, width)
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
mod tests;
