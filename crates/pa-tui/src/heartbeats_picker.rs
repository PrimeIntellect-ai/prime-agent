//! The `/heartbeats` management view (TS `HeartbeatManagerComponent`,
//! redesigned per the operator's 2026-09-23 directive): the current
//! session's heartbeats as a columned table (interval, label, next run,
//! status) instead of text blobs, and Enter on a row opens the detail
//! drill-in — the full prompt text, which agent created it, and the
//! management actions (pause/resume, stop) as up/down-selectable rows in
//! the same control pattern as the `/mcp` view. The table fills the full
//! width of the TUI (the operator's 2026-09-24 ruling): the selected
//! row's wash spans the terminal width while the columns keep their
//! content-hug geometry. Rendered inline-picker style (the `/model`
//! geometry — a plain-text title line with the status counts, the
//! shortcuts at the bottom with no rule below them, one blank line of
//! spacing under the hint).

use serde_json::Value;

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::{fill_row, hug_row, menu_list_layout, plain_cell, status_dot};
use crate::theme::{Theme, ThemeColor};
use crate::width::{str_width, truncate_line, wrap_text};
use crate::{Line, Span};

// The wire/parse + label layer (the cron-job and catalog shapes, the session scoping
// and sort, the session/source/default labels, and the timestamp/countdown helpers)
// moved to the child module at the same tree position (heartbeats_picker::data); the
// facade re-exports keep every crate path stable (the wire contract rides the
// facade, the composition-root pattern).
mod data;

pub use data::{
    default_heartbeat_name, format_timestamp, next_run_label, parse_heartbeat_job,
    parse_heartbeats, scope_heartbeats, session_label, single_line, sort_heartbeats, source_label,
    HeartbeatEntry, HeartbeatJob,
};

// The cron interpreter (the field vocabulary, the day names, and the
// human-readable schedule form) moved to the child module at the same tree
// position (heartbeats_picker::schedule); the facade re-export keeps the pub API
// path stable (human_schedule rides the facade).
mod schedule;

pub use schedule::human_schedule;

/// The preferred visible rows of the list (TS
/// `PREFERRED_VISIBLE_HEARTBEATS`).
const PREFERRED_VISIBLE: usize = 8;

/// Rows the list reserves outside its items (the inline geometry: rule,
/// title, blank, column header, blank, hint, blank — the shortcuts ride
/// the pane's last row with no rule below them, one blank line of
/// spacing under them instead (the operator's 2026-09-24 /model ruling);
/// the conditional scroll-indicator row rides `menu_list_layout`'s
/// scroll reservation, never counted twice).
const LIST_FRAME_ROWS: usize = 7;

/// The detail pane's labeled-pair row budget: the seven base pairs
/// (created, session, delivery, schedule, next run, runs, last error)
/// all fit — the schedule fact (item 3) must never displace the error
/// row to the clipped tail.
const MAX_DETAIL_ROWS: usize = 7;

/// The table's column width caps: the schedule expression and the label
/// shrink to their content, the next-run column is the fixed natural
/// language cell, and the status word keeps its own width.
const INTERVAL_CAP: usize = 18;
const LABEL_CAP: usize = 32;
/// The next-run column's fixed cell: wide enough for its header and every
/// countdown the schedule can produce (the next run is bounded within a
/// year, so at most "in 365d").
const NEXT_RUN_CELL: usize = 8;

/// The management-action vocabulary (TS `AgentHeartbeatManagementAction`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeartbeatAction {
    Pause,
    Resume,
    Stop,
}

impl HeartbeatAction {
    /// The wire word (TS `heartbeat_manage` action values).
    pub fn as_wire(self) -> &'static str {
        match self {
            HeartbeatAction::Pause => "pause",
            HeartbeatAction::Resume => "resume",
            HeartbeatAction::Stop => "stop",
        }
    }
}

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
fn detail_pairs(entry: &HeartbeatEntry, now_ms: u64) -> Vec<(&'static str, String)> {
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
fn detail_block_lines(theme: &Theme, width: usize, pairs: &[(&'static str, String)]) -> Vec<Line> {
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

/// The pane's interactive mode: the columned list, or the selected
/// heartbeat's detail drill-in (TS `HeartbeatManagerMode`, redesigned).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Mode {
    List,
    /// The selected heartbeat's detail drill-in: the full prompt text,
    /// the created-by facts, and the action rows (`action_index` in
    /// their selection).
    Detail {
        heartbeat_id: String,
        action_index: usize,
    },
}

/// One key press while the view is open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeartbeatsPickerAction {
    /// Esc / Ctrl+C / back on the list: close without acting.
    Close,
    /// Enter on an action row: the caller runs the management request.
    Manage {
        active_session_id: String,
        job_id: String,
        action: HeartbeatAction,
    },
    /// Navigation only.
    None,
}

/// The `/heartbeats` management view.
#[derive(Debug)]
pub struct HeartbeatsPicker {
    /// The scoped, sorted catalog.
    heartbeats: Vec<HeartbeatEntry>,
    /// The selected heartbeat's job id (TS `selectedHeartbeatId`).
    selected_heartbeat_id: Option<String>,
    mode: Mode,
    /// The last catalog fetch failure (TS `heartbeatCatalogFetchError`).
    fetch_error: Option<String>,
    /// The last management-action error (TS `error`).
    error: Option<String>,
    viewport_rows: usize,
}

impl HeartbeatsPicker {
    /// Build the view over a fetched (scoped, sorted) catalog.
    pub fn new(
        heartbeats: Vec<HeartbeatEntry>,
        fetch_error: Option<String>,
        preselect: Option<String>,
        viewport_rows: usize,
    ) -> Self {
        let mut picker = HeartbeatsPicker {
            heartbeats,
            selected_heartbeat_id: None,
            mode: Mode::List,
            fetch_error,
            error: None,
            viewport_rows,
        };
        // A carried selection (the dock's chosen row) survives the
        // open; anything else lands on the first row (TS default).
        picker.selected_heartbeat_id = preselect
            .filter(|id| picker.heartbeats.iter().any(|entry| &entry.job.id == id))
            .or_else(|| picker.heartbeats.first().map(|entry| entry.job.id.clone()));
        picker
    }

    /// A landed catalog refresh (TS `applyHeartbeatCatalog`): replace the
    /// rows, clear the fetch error, and keep the selection when the job
    /// survived.
    pub fn apply_catalog(&mut self, heartbeats: Vec<HeartbeatEntry>, fetch_error: Option<String>) {
        self.heartbeats = heartbeats;
        self.fetch_error = fetch_error;
        let selected = self.selected_heartbeat_id.clone();
        self.conform_selection(&selected);
        self.dirty_conform_mode();
    }

    /// A management result (TS `manageHeartbeat`'s catalog patch): a stop
    /// removes the row, anything else replaces the job in place; the pane
    /// returns to the list.
    pub fn apply_managed_job(&mut self, updated: HeartbeatJob, stopped: bool) {
        if stopped {
            self.heartbeats.retain(|entry| entry.job.id != updated.id);
        } else if let Some(entry) = self
            .heartbeats
            .iter_mut()
            .find(|entry| entry.job.id == updated.id)
        {
            entry.job = updated;
        }
        let selected = self.selected_heartbeat_id.clone();
        self.conform_selection(&selected);
        self.mode = Mode::List;
        self.error = None;
    }

    /// Surface a management-action failure (TS `runAction`'s catch).
    pub fn set_action_error(&mut self, error: String) {
        self.error = Some(error);
        self.mode = Mode::List;
    }

    /// Surface a background-catalog refresh failure (TS
    /// `heartbeatCatalogFetchError`): the rows stay (stale-while-revalidate)
    /// and the failure renders inside the view until the next good refresh.
    pub fn set_fetch_error(&mut self, error: Option<String>) {
        self.fetch_error = error;
    }

    /// Return to the list pane without a job patch (TS `runAction`'s
    /// success path still ends in `{ type: "list" }`).
    pub fn back_to_list(&mut self) {
        self.mode = Mode::List;
        self.error = None;
    }

    /// Reset the selection to the first row when the selected job vanished
    /// (TS `render`'s fallback).
    fn conform_selection(&mut self, selected: &Option<String>) {
        let exists = selected
            .as_deref()
            .is_some_and(|id| self.heartbeats.iter().any(|entry| entry.job.id == id));
        if !exists {
            self.selected_heartbeat_id = self.heartbeats.first().map(|entry| entry.job.id.clone());
        }
    }

    /// Drop a detail pane whose heartbeat vanished (TS `render`'s mode
    /// fallback).
    fn dirty_conform_mode(&mut self) {
        if let Mode::Detail { heartbeat_id, .. } = self.mode.clone() {
            if !self
                .heartbeats
                .iter()
                .any(|entry| entry.job.id == heartbeat_id)
            {
                self.mode = Mode::List;
            }
        }
    }

    /// The selected row's index (TS `getSelectedIndex`, first when unset).
    fn selected_index(&self) -> usize {
        self.heartbeats
            .iter()
            .position(|entry| Some(&entry.job.id) == self.selected_heartbeat_id.as_ref())
            .unwrap_or(0)
    }

    fn find_entry(&self, id: &str) -> Option<&HeartbeatEntry> {
        self.heartbeats.iter().find(|entry| entry.job.id == id)
    }

    /// The action rows of one heartbeat (TS `availableActions`): the
    /// pause/resume complement of its status, then stop.
    fn available_actions(entry: &HeartbeatEntry) -> Vec<(String, HeartbeatAction, String)> {
        let mut actions = Vec::with_capacity(2);
        if entry.job.is_active() {
            actions.push((
                "Pause heartbeat".to_string(),
                HeartbeatAction::Pause,
                "Stop deliveries until resumed".to_string(),
            ));
        } else {
            actions.push((
                "Resume heartbeat".to_string(),
                HeartbeatAction::Resume,
                "Continue scheduled deliveries".to_string(),
            ));
        }
        actions.push((
            "Stop heartbeat".to_string(),
            HeartbeatAction::Stop,
            "Permanently remove this heartbeat".to_string(),
        ));
        actions
    }

    /// One key id (TS `handleInput`, minus the busy gate: the session UI
    /// awaits the management request itself).
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> HeartbeatsPickerAction {
        // Cancel keys close the view (TS `tui.select.cancel`).
        if key == "ctrl+c" || kb.matches(key, "tui.select.cancel") {
            return HeartbeatsPickerAction::Close;
        }
        // Back (left): the detail pane returns to the list, the list closes.
        if kb.matches(key, "app.modal.back") {
            if self.mode == Mode::List {
                return HeartbeatsPickerAction::Close;
            }
            self.mode = Mode::List;
            self.error = None;
            return HeartbeatsPickerAction::None;
        }
        if kb.matches(key, "tui.select.up") || kb.matches(key, "tui.select.down") {
            let delta = if kb.matches(key, "tui.select.up") {
                -1isize
            } else {
                1
            };
            self.move_selection(delta);
            return HeartbeatsPickerAction::None;
        }
        // The open-selected binding (right) opens the selected heartbeat's
        // detail drill-in from the list.
        if self.mode == Mode::List && kb.matches(key, "app.heartbeats.openSelected") {
            self.open_detail();
            return HeartbeatsPickerAction::None;
        }
        if kb.matches(key, "tui.select.confirm") {
            return self.confirm_selection();
        }
        HeartbeatsPickerAction::None
    }

    /// Move the selection (TS `moveSelection`): the list walks rows by job
    /// id, the detail pane walks its action rows by index.
    fn move_selection(&mut self, delta: isize) {
        match self.mode.clone() {
            Mode::List => {
                if self.heartbeats.is_empty() {
                    return;
                }
                let index = self.selected_index() as isize;
                let next = (index + delta).clamp(0, self.heartbeats.len() as isize - 1) as usize;
                self.selected_heartbeat_id = Some(self.heartbeats[next].job.id.clone());
            }
            Mode::Detail {
                heartbeat_id,
                action_index,
            } => {
                let Some(entry) = self.find_entry(&heartbeat_id) else {
                    return;
                };
                let count = Self::available_actions(entry).len();
                let next = (action_index as isize + delta).clamp(0, count as isize - 1) as usize;
                self.mode = Mode::Detail {
                    heartbeat_id,
                    action_index: next,
                };
            }
        }
    }

    /// Enter on the list opens the selected heartbeat's detail drill-in;
    /// Enter on an action row runs it (TS `confirmSelection`).
    fn confirm_selection(&mut self) -> HeartbeatsPickerAction {
        match self.mode.clone() {
            Mode::List => {
                self.open_detail();
                HeartbeatsPickerAction::None
            }
            Mode::Detail {
                heartbeat_id,
                action_index,
            } => {
                let Some(entry) = self.find_entry(&heartbeat_id) else {
                    self.mode = Mode::List;
                    return HeartbeatsPickerAction::None;
                };
                let actions = Self::available_actions(entry);
                let Some((_, action, _)) = actions.get(action_index) else {
                    return HeartbeatsPickerAction::None;
                };
                HeartbeatsPickerAction::Manage {
                    active_session_id: entry.job.active_session_id.clone(),
                    job_id: entry.job.id.clone(),
                    action: *action,
                }
            }
        }
    }

    /// Open the selected heartbeat's detail drill-in (TS
    /// `confirmSelection`'s list branch).
    fn open_detail(&mut self) {
        let Some(id) = self.selected_heartbeat_id.clone() else {
            return;
        };
        if self.find_entry(&id).is_some() {
            self.mode = Mode::Detail {
                heartbeat_id: id,
                action_index: 0,
            };
        }
    }

    /// The list's visible-row budget (TS `getListLayout`, inline shape).
    fn visible_items(&self) -> usize {
        // Both error blocks render two rows each when present (the
        // fetch failure and the action failure stack in the footer).
        let reserved = LIST_FRAME_ROWS
            + match (self.error.is_some(), self.fetch_error.is_some()) {
                (true, true) => 4,
                (some, _) if some => 2,
                (_, true) => 2,
                _ => 0,
            };
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
            self.heartbeats.len(),
            reserved,
            1,
        )
    }

    /// Render the view's frame: the columned list or the detail drill-in.
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        match &self.mode {
            Mode::List => self.render_list(theme, width, kb),
            Mode::Detail {
                heartbeat_id,
                action_index,
            } => self.render_detail(theme, width, kb, heartbeat_id, *action_index),
        }
    }

    /// The list pane (the `/model` picker idiom over a columned table):
    /// the title line with the status counts, the dim column header, one
    /// row per heartbeat, the scroll indicator, and a single bottom hint
    /// line.
    fn render_list(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        let counts: Vec<(ThemeColor, String)> = self.status_counts();
        let mut lines = pane_header_lines(theme, width, "Heartbeats", &counts, None);
        if self.heartbeats.is_empty() {
            lines.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Muted, "No running or paused heartbeats"),
            ]);
        } else {
            let columns = Columns::new(width, &self.heartbeats);
            lines.push(columns.header_row(theme, width));
            let selected = self.selected_index();
            let visible = self.visible_items();
            let start = selected
                .saturating_sub(visible / 2)
                .min(self.heartbeats.len().saturating_sub(visible));
            let end = (start + visible).min(self.heartbeats.len());
            let now = crate::agents_view_state::now_ms();
            for (index, entry) in self.heartbeats[start..end].iter().enumerate() {
                let is_selected = start + index == selected;
                lines.push(columns.entry_row(theme, width, entry, is_selected, now));
            }
            if visible > 0 && (start > 0 || end < self.heartbeats.len()) {
                lines.push(vec![
                    Span::raw("  "),
                    theme.fg_span(
                        ThemeColor::Muted,
                        format!("({}/{})", selected + 1, self.heartbeats.len()),
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

    /// The active/paused counts for the title line's right-aligned
    /// cluster (TS `countLabel`'s numbers, in the status colors).
    fn status_counts(&self) -> Vec<(ThemeColor, String)> {
        let active = self
            .heartbeats
            .iter()
            .filter(|entry| entry.job.is_active())
            .count();
        let paused = self.heartbeats.len() - active;
        let mut counts = Vec::new();
        if active > 0 {
            counts.push((ThemeColor::Success, format!("{active} active")));
        }
        if paused > 0 {
            counts.push((ThemeColor::Warning, format!("{paused} paused")));
        }
        counts
    }

    /// The detail drill-in: the heartbeat's name and schedule, the full
    /// prompt text (wrapped, never single-lined), the created-by facts,
    /// and the action rows in the `/mcp` view's control pattern.
    fn render_detail(
        &self,
        theme: &Theme,
        width: usize,
        kb: &KeybindingsManager,
        heartbeat_id: &str,
        action_index: usize,
    ) -> Vec<Line> {
        let Some(entry) = self.find_entry(heartbeat_id) else {
            // The heartbeat vanished: the TS panel degrades to this text.
            let mut lines = pane_header_lines(theme, width, "Heartbeats", &[], None);
            lines.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Muted, "This heartbeat is no longer available."),
            ]);
            lines.extend(self.pane_footer(theme, width, &self.detail_hint(kb)));
            return lines;
        };
        let name = entry
            .job
            .label
            .as_deref()
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .map_or_else(|| default_heartbeat_name(entry).to_string(), str::to_string);
        let subtitle = format!(
            "{} \u{b7} {}",
            human_schedule(&entry.job.schedule_expression),
            entry.job.status
        );
        let mut lines = pane_header_lines(theme, width, &name, &[], Some(&subtitle));
        let actions = Self::available_actions(entry);
        let pairs = detail_pairs(entry, crate::agents_view_state::now_ms());
        // The pane's fixed rows: the header block (rule, title, subtitle,
        // blank), the blank before the actions, the action rows, the
        // footer (blank, hint, blank), and the error rows when present.
        let error_rows = match (self.fetch_error.is_some(), self.error.is_some()) {
            (true, true) => 4,
            (some, _) if some => 2,
            (_, true) => 2,
            _ => 0,
        };
        let fixed = 4 + 1 + actions.len() + 3 + error_rows;
        // The created-by pairs shrink first (they summarize; the full
        // prompt text is the drill-in's content), then the prompt clips
        // its tail — the action rows never yield. The prompt block's own
        // leading blank and label ride the budget too, and the pairs
        // block's blank renders only with its rows.
        let prompt_width = width.saturating_sub(4).max(10);
        // Non-newline control characters scrub before the wrap (an
        // escape sequence in a prompt can never execute terminal
        // control operations when rendered).
        let prompt = entry
            .job
            .prompt
            .chars()
            .map(|c| if c.is_control() && c != '\n' { ' ' } else { c })
            .collect::<String>();
        let wrapped = wrap_text(&prompt, prompt_width);
        let mut pairs_rows = pairs.len().min(MAX_DETAIL_ROWS);
        let mut prompt_budget = self
            .viewport_rows
            .saturating_sub(fixed + 1 + pairs_rows + 2);
        // The prompt is the drill-in's content: when the default math
        // starves it, the pairs shrink first (they summarize — the
        // documented order) until at least one prompt row renders. A
        // heartbeat without prompt text never trades pairs away.
        let has_prompt = !entry.job.prompt.trim().is_empty();
        if prompt_budget == 0 && pairs_rows > 0 && has_prompt {
            pairs_rows = pairs_rows.min(self.viewport_rows.saturating_sub(fixed + 4));
            prompt_budget = self
                .viewport_rows
                .saturating_sub(fixed + 1 + pairs_rows + 2);
        }
        if prompt_budget > 0 && !entry.job.prompt.trim().is_empty() {
            lines.push(Vec::new());
            lines.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Dim, "Prompt".to_string()),
            ]);
            let mut shown = wrapped.len().min(prompt_budget);
            let mut clipped = false;
            if wrapped.len() > shown && shown > 1 {
                shown -= 1;
                clipped = true;
            }
            for line in &wrapped[..shown] {
                let mut row = vec![Span::raw("  ")];
                row.extend(line.iter().cloned());
                lines.push(truncate_line(&row, width, ""));
            }
            if clipped {
                lines.push(vec![
                    Span::raw("  "),
                    theme.fg_span(ThemeColor::Dim, "\u{2026}".to_string()),
                ]);
            }
        }
        if pairs_rows > 0 {
            lines.push(Vec::new());
            lines.extend(detail_block_lines(
                theme,
                width,
                &pairs.into_iter().take(pairs_rows).collect::<Vec<_>>(),
            ));
        }
        lines.push(Vec::new());
        for (index, (label, _, description)) in actions.iter().enumerate() {
            lines.push(action_row(
                theme,
                width,
                label,
                description,
                index == action_index,
            ));
        }
        lines.extend(self.pane_footer(theme, width, &self.detail_hint(kb)));
        lines.truncate(self.viewport_rows.max(1));
        lines
    }

    /// The list's bottom hint line: every shortcut in one line (the close
    /// key never repeats). The open and close segments carry both of
    /// their keys while both are bound — the confirm/openSelected pair
    /// opens the detail drill-in, the back/cancel pair closes from the
    /// list — and an override that empties one of the pair drops that
    /// key (the hint never advertises a key the handler does not take;
    /// the confirm/cancel fallbacks are the pane's core keys).
    fn list_hint(&self, kb: &KeybindingsManager) -> String {
        let key = |binding: &str, fallback: &str| {
            kb.first_key(binding)
                .map_or_else(|| fallback.to_string(), |key| format_key_text(&key))
        };
        let bound = |binding: &str| kb.first_key(binding).map(|key| format_key_text(&key));
        let open = match bound("app.heartbeats.openSelected") {
            Some(detail) => format!("{}/{}", key("tui.select.confirm", "Enter"), detail),
            None => key("tui.select.confirm", "Enter"),
        };
        let close = match bound("app.modal.back") {
            Some(back) => format!("{}/{}", back, key("tui.select.cancel", "Esc")),
            None => key("tui.select.cancel", "Esc"),
        };
        format!(
            "{}/{} move \u{b7} {open} open \u{b7} {close} close",
            key("tui.select.up", "\u{2191}"),
            key("tui.select.down", "\u{2193}"),
        )
    }

    /// The detail pane's bottom hint line.
    fn detail_hint(&self, kb: &KeybindingsManager) -> String {
        let key = |binding: &str, fallback: &str| {
            kb.first_key(binding)
                .map_or_else(|| fallback.to_string(), |key| format_key_text(&key))
        };
        format!(
            "{}/{} move \u{b7} {} run \u{b7} {} back \u{b7} {} close",
            key("tui.select.up", "\u{2191}"),
            key("tui.select.down", "\u{2193}"),
            key("tui.select.confirm", "Enter"),
            key("app.modal.back", "\u{2190}"),
            key("tui.select.cancel", "Esc"),
        )
    }

    /// The pane footer: the fetch and action errors, a blank, the hint
    /// line, and one blank line below the shortcuts (the operator's
    /// 2026-09-24 ruling: no rule rides under the hint — the /model
    /// geometry, with the same single blank of spacing below).
    fn pane_footer(&self, theme: &Theme, width: usize, hint: &str) -> Vec<Line> {
        let mut lines = Vec::new();
        if let Some(fetch_error) = &self.fetch_error {
            lines.push(Vec::new());
            let line = vec![
                Span::raw("  "),
                theme.fg_span(
                    ThemeColor::Warning,
                    format!("Heartbeat refresh failed: {}", single_line(fetch_error)),
                ),
            ];
            lines.push(truncate_line(&line, width, ""));
        }
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

/// The table's column geometry: the interval, label, next-run, and status
/// cells sized over the rows and their header labels (the operator's
/// columned-table directive), with the label column taking whatever width
/// remains.
struct Columns {
    interval: usize,
    label: usize,
}

impl Columns {
    fn new(width: usize, entries: &[HeartbeatEntry]) -> Self {
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
    fn header_row(&self, theme: &Theme, width: usize) -> Line {
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
    fn entry_row(
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

/// The pane's header block: a muted separator rule, then the title row —
/// the title in plain text (the `/model` picker carries no accent color),
/// the status counts trailing flush right, an optional muted subtitle,
/// and a blank line.
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

/// The hint row (TS `keyHint`: dim key text, muted ` description`).
fn hint_line(theme: &Theme, width: usize, hint: &str) -> Line {
    let line = vec![
        Span::raw("  "),
        theme.fg_span(ThemeColor::Dim, hint.to_string()),
    ];
    truncate_line(&line, width, "")
}

/// An error line (TS `Error: <message>` in the error color).
fn error_line(theme: &Theme, width: usize, message: &str) -> Line {
    let line = vec![
        Span::raw("  "),
        theme.fg_span(ThemeColor::Error, format!("Error: {message}")),
    ];
    truncate_line(&line, width, "")
}

// The unit battery moved with its concern to the child module at the same tree
// position (heartbeats_picker::tests); the facade decl keeps the cfg(test) gate and
// the descendant glob reaches every facade-resident item (the agents-view/interactive
// stage-1 pattern).
#[cfg(test)]
mod tests;
