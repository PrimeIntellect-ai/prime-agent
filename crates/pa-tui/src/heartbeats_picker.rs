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
/// shrink to their content, the timestamp column is the fixed
/// `YYYY-MM-DD HH:MM` cell, and the status word keeps its own width.
const INTERVAL_CAP: usize = 18;
const LABEL_CAP: usize = 32;

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

/// One cron job as the view needs it (TS `AgentCronJob`), parsed from the
/// daemon's `heartbeats_list` wire shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeartbeatJob {
    pub id: String,
    /// `active` / `paused` (the catalog only carries these two).
    pub status: String,
    /// `heartbeat` (user) or `rlm_heartbeat` (agent).
    pub source: Option<String>,
    /// `steer` / `follow_up` (defaults to steer).
    pub delivery_mode: Option<String>,
    pub active_session_id: String,
    pub session_id: String,
    pub label: Option<String>,
    pub prompt: String,
    /// The schedule expression (TS `job.schedule.expression`).
    pub schedule_expression: String,
    pub created_at: String,
    pub next_run_at: Option<String>,
    pub last_error: Option<String>,
    pub run_count: u64,
}

impl HeartbeatJob {
    /// The job's status word, `active` or `paused`.
    fn is_active(&self) -> bool {
        self.status == "active"
    }

    /// Whether an agent created this job (TS source label test).
    fn is_user_created(&self) -> bool {
        self.source.as_deref() == Some("heartbeat")
    }
}

/// One catalog row (TS `AgentConnectionHeartbeat`): a job plus the saved
/// session's display name and first message, when the daemon knows them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeartbeatEntry {
    pub job: HeartbeatJob,
    pub session_name: Option<String>,
    pub first_message: Option<String>,
}

/// Parse one cron-job wire object (TS `AgentCronJob`). `None` when the id
/// is missing: rows without a parseable id drop, matching the
/// supervisor's own id-keyed merge.
pub fn parse_heartbeat_job(job: &Value) -> Option<HeartbeatJob> {
    // Every daemon-supplied string renders somewhere in the view (the
    // table cells, the subtitle, the detail pairs): control characters
    // scrub at the parse boundary — an ANSI/OSC sequence in catalog data
    // can never execute terminal control operations when rendered.
    let text = |field: &str| {
        job.get(field)
            .and_then(Value::as_str)
            .map(crate::menu_panel::scrub_controls)
    };
    let id = text("id").filter(|id| !id.is_empty())?;
    Some(HeartbeatJob {
        id,
        status: text("status").unwrap_or_else(|| "active".to_string()),
        source: text("source"),
        delivery_mode: text("deliveryMode"),
        active_session_id: text("activeSessionId").unwrap_or_default(),
        session_id: text("sessionId").unwrap_or_default(),
        label: text("label").filter(|label| !label.trim().is_empty()),
        prompt: text("prompt").unwrap_or_default(),
        schedule_expression: job
            .get("schedule")
            .and_then(|schedule| schedule.get("expression"))
            .and_then(Value::as_str)
            .map(crate::menu_panel::scrub_controls)
            .unwrap_or_default(),
        created_at: text("createdAt").unwrap_or_default(),
        next_run_at: text("nextRunAt"),
        last_error: text("lastError"),
        run_count: job
            .get("runCount")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
    })
}

/// Parse the daemon `heartbeats_list` response data (the `heartbeats`
/// array) into catalog rows.
pub fn parse_heartbeats(data: &Value) -> Vec<HeartbeatEntry> {
    let Some(rows) = data.get("heartbeats").and_then(Value::as_array) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let job = parse_heartbeat_job(row.get("job")?)?;
            Some(HeartbeatEntry {
                job,
                session_name: row
                    .get("sessionName")
                    .and_then(Value::as_str)
                    .map(crate::menu_panel::scrub_controls),
                first_message: row
                    .get("firstMessage")
                    .and_then(Value::as_str)
                    .map(crate::menu_panel::scrub_controls),
            })
        })
        .collect()
}

/// TS `scopeHeartbeatsToSession`: a heartbeat is in scope when its durable
/// session matches `session_id`, or its live session is the current one or
/// one of the session's RLM children. No session identity shows nothing.
pub fn scope_heartbeats(
    entries: Vec<HeartbeatEntry>,
    active_session_id: Option<&str>,
    session_id: Option<&str>,
    child_active_session_ids: &[String],
) -> Vec<HeartbeatEntry> {
    let Some(session_id) = session_id.filter(|id| !id.is_empty()) else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter(|entry| {
            entry.job.session_id == session_id
                || (active_session_id.is_some()
                    && entry.job.active_session_id == active_session_id.unwrap_or_default())
                || child_active_session_ids.contains(&entry.job.active_session_id)
        })
        .collect()
}

/// TS `HeartbeatManagerComponent.heartbeats` sort: session label, then
/// user-created before agent-created, then creation time.
pub fn sort_heartbeats(entries: &mut [HeartbeatEntry]) {
    entries.sort_by(|left, right| {
        let session_order = session_label(left).cmp(&session_label(right));
        if session_order != std::cmp::Ordering::Equal {
            return session_order;
        }
        // User-created (`heartbeat`) rows first: `false` sorts before
        // `true`, so `!user_created` orders user rows ahead of agent rows.
        let source_order = (!left.job.is_user_created()).cmp(&!right.job.is_user_created());
        if source_order != std::cmp::Ordering::Equal {
            return source_order;
        }
        left.job.created_at.cmp(&right.job.created_at)
    });
}

/// TS `sessionLabel`: the saved session's name, else its first message,
/// else the durable session id (all single-line).
pub fn session_label(entry: &HeartbeatEntry) -> String {
    entry
        .session_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(single_line)
        .or_else(|| {
            entry
                .first_message
                .as_deref()
                .map(single_line)
                .filter(|message| !message.is_empty())
        })
        .unwrap_or_else(|| entry.job.session_id.clone())
}

/// TS `sourceLabel`.
pub fn source_label(entry: &HeartbeatEntry) -> &'static str {
    if entry.job.is_user_created() {
        "Created by you"
    } else {
        "Created by agent"
    }
}

/// TS `defaultHeartbeatName`.
pub fn default_heartbeat_name(entry: &HeartbeatEntry) -> &'static str {
    if entry.job.is_user_created() {
        "Your heartbeat"
    } else {
        "Agent-created heartbeat"
    }
}

/// TS `singleLine`: collapse all whitespace runs to single spaces.
pub fn single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The delivery word (TS: `follow_up` renders `follow-up`).
fn delivery_label(entry: &HeartbeatEntry) -> &'static str {
    if entry.job.delivery_mode.as_deref() == Some("follow_up") {
        "follow-up"
    } else {
        "steer"
    }
}

/// TS `formatTimestamp`: ISO timestamps cut to `YYYY-MM-DD HH:MM`.
pub fn format_timestamp(value: &str) -> String {
    let Some(cut) = value.get(..16) else {
        return value.to_string();
    };
    let formatted = cut.replacen('T', " ", 1);
    if formatted.contains(' ') && formatted.len() == 16 {
        formatted
    } else {
        value.to_string()
    }
}

/// The detail drill-in's labeled pairs (the `/model` picker's
/// detail-block idiom): who created the heartbeat and the structured
/// schedule facts.
fn detail_pairs(entry: &HeartbeatEntry) -> Vec<(&'static str, String)> {
    let mut pairs = vec![
        ("created", source_label(entry).to_string()),
        ("session", session_label(entry)),
        ("delivery", delivery_label(entry).to_string()),
        ("schedule", human_schedule_pair(entry)),
        (
            "next run",
            entry
                .job
                .next_run_at
                .as_deref()
                .map(format_timestamp)
                .unwrap_or_else(|| "\u{2014}".to_string()),
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
    if human != expression {
        format!("{human} ({expression})")
    } else {
        human
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
        // Cancel keys — including the open binding (ctrl+r toggles closed)
        // — close the view (TS `tui.select.cancel` / `app.heartbeats.open`).
        if key == "ctrl+c"
            || kb.matches(key, "tui.select.cancel")
            || kb.matches(key, "app.heartbeats.open")
        {
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
            for (index, entry) in self.heartbeats[start..end].iter().enumerate() {
                let is_selected = start + index == selected;
                lines.push(columns.entry_row(theme, width, entry, is_selected));
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
            .map(str::to_string)
            .unwrap_or_else(|| default_heartbeat_name(entry).to_string());
        let subtitle = format!(
            "{} \u{b7} {}",
            human_schedule(&entry.job.schedule_expression),
            entry.job.status
        );
        let mut lines = pane_header_lines(theme, width, &name, &[], Some(&subtitle));
        let actions = Self::available_actions(entry);
        let pairs = detail_pairs(entry);
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
        if prompt_budget == 0 && pairs_rows > 0 {
            pairs_rows = pairs_rows.min(self.viewport_rows.saturating_sub(fixed + 2));
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
            for line in wrapped[..shown].iter() {
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
    /// key never repeats).
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

/// The interpreted form of one cron field: `*`, `*/n`, a single value,
/// or anything else the small interpreter below does not cover (lists,
/// ranges — those keep the raw expression).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CronField {
    Any,
    Step(u32),
    Value(u32),
    Other,
}

fn parse_cron_field(field: &str) -> CronField {
    if field == "*" {
        CronField::Any
    } else if let Some(step) = field.strip_prefix("*/") {
        step.parse::<u32>()
            .map_or(CronField::Other, CronField::Step)
    } else {
        field
            .parse::<u32>()
            .map_or(CronField::Other, CronField::Value)
    }
}

/// The day name for one cron day-of-week value (`0`/`7` Sunday through
/// `6` Saturday).
fn cron_day_name(value: u32) -> Option<&'static str> {
    Some(match value {
        0 | 7 => "Sunday",
        1 => "Monday",
        2 => "Tuesday",
        3 => "Wednesday",
        4 => "Thursday",
        5 => "Friday",
        6 => "Saturday",
        _ => return None,
    })
}

/// The human-readable form of one schedule expression for the interval
/// column (the operator's 2026-09-24 ruling: "cron format is not human
/// readable"). The storage format stays the raw cron — this is
/// render-side only, and the drill-in keeps the raw expression beside
/// the interpretation. The natural-language schedules (`every 10m`,
/// `in 2h`, `at <date>`) pass through unchanged, the five-field cron
/// forms interpret into their plain-English meaning (`*/2 * * * *` is
/// "every 2 minutes", `0 9 * * 1` is "Mondays 09:00", the stored
/// `@hourly`/`@daily` aliases expand at creation into the five-field
/// forms they mean), and anything the interpreter cannot cover falls
/// back to the raw expression.
pub fn human_schedule(expression: &str) -> String {
    let trimmed = expression.trim();
    match trimmed {
        "@hourly" => return "hourly".to_string(),
        "@daily" | "@midnight" => return "daily".to_string(),
        "@weekly" => return "weekly".to_string(),
        "@monthly" => return "monthly".to_string(),
        "@yearly" | "@annually" => return "yearly".to_string(),
        _ => {}
    }
    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    if fields.len() != 5 {
        // The passthrough stays the expression itself (a natural-language
        // schedule already reads), trimmed: a whitespace-padded wire value
        // must never render its padding into the column (or twice, via
        // the pair's raw-append fallback).
        return trimmed.to_string();
    }
    let minute = parse_cron_field(fields[0]);
    let hour = parse_cron_field(fields[1]);
    let dom = parse_cron_field(fields[2]);
    let month = parse_cron_field(fields[3]);
    let dow = parse_cron_field(fields[4]);
    if month != CronField::Any {
        return trimmed.to_string();
    }
    let at = |h: u32, m: u32| format!("{h:02}:{m:02}");
    if dom == CronField::Any && dow == CronField::Any {
        return match (hour, minute) {
            (CronField::Any, CronField::Any) => "every minute".to_string(),
            (CronField::Any, CronField::Step(1)) => "every minute".to_string(),
            (CronField::Any, CronField::Step(n)) => format!("every {n} minutes"),
            (CronField::Step(1), CronField::Value(0)) => "hourly".to_string(),
            (CronField::Step(n), CronField::Value(0)) => format!("every {n} hours"),
            (CronField::Any, CronField::Value(0)) => "hourly".to_string(),
            (CronField::Any, CronField::Value(m)) => format!("hourly at :{m:02}"),
            (CronField::Value(h), CronField::Value(m)) => format!("daily {}", at(h, m)),
            _ => trimmed.to_string(),
        };
    }
    if dom == CronField::Any {
        if let (CronField::Value(d), CronField::Value(h), CronField::Value(m)) = (dow, hour, minute)
        {
            if let Some(day) = cron_day_name(d) {
                return format!("{day}s {}", at(h, m));
            }
        }
        return trimmed.to_string();
    }
    if dow == CronField::Any {
        if let (CronField::Value(1), CronField::Value(h), CronField::Value(m)) = (dom, hour, minute)
        {
            return format!("monthly {}", at(h, m));
        }
    }
    trimmed.to_string()
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
        // timestamp column, and the status column.
        let fixed = 2 + 2 + 2 + 2 + 2 + 16 + status;
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
        row.push(theme.fg_span(ThemeColor::Dim, "Next run".to_string()));
        row.push(Span::raw(" ".repeat(16 - "Next run".len())));
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
        row.push(
            theme.fg_span(
                ThemeColor::Muted,
                plain_cell(
                    &entry
                        .job
                        .next_run_at
                        .as_deref()
                        .map(format_timestamp)
                        .unwrap_or_else(|| "\u{2014}".to_string()),
                    16,
                ),
            ),
        );
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ColorMode, Theme};

    fn kb() -> KeybindingsManager {
        KeybindingsManager::new()
    }

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn job_value(id: &str, source: &str, status: &str) -> Value {
        serde_json::json!({
            "job": {
                "id": id,
                "status": status,
                "source": source,
                "activeSessionId": "live-1",
                "sessionId": "sess-1",
                "prompt": format!("tick {id}"),
                "schedule": {"kind": "interval", "expression": "every 10m", "intervalMs": 600_000},
                "createdAt": "2026-01-01T00:00:00.000Z",
                "nextRunAt": "2026-01-01T00:10:00.000Z",
                "runCount": 2,
            },
            "sessionName": "the session",
        })
    }

    fn entries() -> Vec<HeartbeatEntry> {
        let data = serde_json::json!({
            "heartbeats": [
                job_value("agent-1", "rlm_heartbeat", "active"),
                job_value("user-1", "heartbeat", "paused"),
            ]
        });
        let mut parsed = parse_heartbeats(&data);
        sort_heartbeats(&mut parsed);
        parsed
    }

    fn frame_text(frame: &[Line]) -> Vec<String> {
        frame
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect()
    }

    #[test]
    fn parse_reads_the_wire_shape() {
        let parsed = entries();
        assert_eq!(parsed.len(), 2);
        let user = parsed
            .iter()
            .find(|entry| entry.job.id == "user-1")
            .expect("user row");
        assert_eq!(user.job.status, "paused");
        assert_eq!(user.job.source.as_deref(), Some("heartbeat"));
        assert_eq!(user.job.schedule_expression, "every 10m");
        assert_eq!(user.job.run_count, 2);
        assert_eq!(user.session_name.as_deref(), Some("the session"));
    }

    #[test]
    fn sort_puts_user_created_first_within_a_session() {
        let parsed = entries();
        assert_eq!(parsed[0].job.id, "user-1");
        assert_eq!(parsed[1].job.id, "agent-1");
    }

    #[test]
    fn scoping_keeps_own_and_child_sessions() {
        let mut all = entries();
        let agent = all
            .iter_mut()
            .find(|entry| entry.job.id == "agent-1")
            .expect("agent row");
        agent.job.session_id = "other-session".to_string();
        agent.job.active_session_id = "child-live".to_string();
        // The agent row belongs to a child session: in scope.
        let scoped = scope_heartbeats(
            all.clone(),
            Some("live-1"),
            Some("sess-1"),
            &["child-live".to_string()],
        );
        assert_eq!(scoped.len(), 2);
        // Without the child, only the session's own row stays.
        let scoped = scope_heartbeats(all, Some("live-1"), Some("sess-1"), &[]);
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].job.id, "user-1");
        // No session identity: nothing shows.
        assert!(scope_heartbeats(entries(), None, None, &[]).is_empty());
    }

    /// A carried selection (the dock's chosen heartbeat) opens on that
    /// row; anything else falls back to the first.
    #[test]
    fn a_carried_selection_opens_on_that_row() {
        let catalog = entries();
        let ids: Vec<_> = catalog.iter().map(|entry| entry.job.id.clone()).collect();
        let picker = HeartbeatsPicker::new(catalog.clone(), None, Some(ids[1].clone()), 24);
        assert_eq!(
            picker.selected_heartbeat_id.as_deref(),
            Some(ids[1].as_str())
        );
        let picker = HeartbeatsPicker::new(catalog, None, Some("missing".to_string()), 24);
        assert_eq!(picker.selected_heartbeat_id.as_deref(), Some("user-1"));
    }

    /// The list is a columned table: a dim column header naming the
    /// operator's columns (interval, label, next run, status), the rows
    /// aligned under it, and one bottom hint line — no text blobs.
    #[test]
    fn the_list_renders_columned_rows_and_one_hint() {
        let picker = HeartbeatsPicker::new(entries(), None, None, 24);
        let frame = picker.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(text.iter().any(|row| row.contains("Heartbeats")));
        // The title line carries the status counts in the status colors.
        assert!(text.iter().any(|row| row.contains("1 active · 1 paused")));
        // The dim column header names the four columns.
        let header = text
            .iter()
            .find(|row| row.contains("Interval") && row.contains("Next run"))
            .expect("a column header row");
        assert!(header.contains("Label"));
        assert!(header.contains("Status"));
        // The rows align under the columns: the schedule expression, the
        // label, the next-run timestamp, and the status word all ride
        // one row.
        let row = text
            .iter()
            .find(|row| row.contains("every 10m"))
            .expect("a columned row");
        assert!(row.contains("tick user-1"));
        assert!(row.contains("2026-01-01 00:10"));
        assert!(row.contains("paused"));
        // The prompt does not blob into the list: the detail drill-in
        // owns it.
        assert!(!text.iter().any(|row| row.starts_with("  created")));
        // Exactly one bottom hint line carries every shortcut.
        assert_eq!(
            text.iter().filter(|row| row.contains("Esc close")).count(),
            1,
            "the close hint appears once: {text:?}"
        );
        assert!(text
            .iter()
            .any(|row| row.contains("↑/↓ move · Enter open · Esc close")));
        for line in &frame {
            assert!(
                crate::width::spans_width(line) <= 70,
                "every row fits the width"
            );
        }
    }

    /// The table fills the full width of the TUI (the operator's
    /// 2026-09-24 ruling): the selected row's wash spans the whole
    /// terminal width, while the columns keep their content-hug geometry
    /// — the column text never stretches to the edge.
    #[test]
    fn the_table_fills_the_full_width() {
        let picker = HeartbeatsPicker::new(entries(), None, None, 24);
        let frame = picker.render(&theme(), 90, &kb());
        let selected = frame
            .iter()
            .find(|line| {
                line.iter()
                    .any(|span| span.style.bg.is_some() && span.content.contains("tick user-1"))
            })
            .expect("the selected row carries the wash");
        let used = crate::width::spans_width(selected);
        assert_eq!(
            used, 90,
            "the selected row's wash spans the whole terminal width: {used}"
        );
        // The columns still hug their content: the label text stops
        // well short of the edge, the wash fills the rest.
        let plain = frame
            .iter()
            .find(|line| {
                line.iter()
                    .any(|span| span.content.contains("tick agent-1"))
            })
            .expect("the other row");
        assert!(crate::width::spans_width(plain) < 90);
        assert!(plain.iter().all(|span| span.style.bg.is_none()));
    }

    /// The shortcuts ride the pane's last rows with no rule below them
    /// (the operator's 2026-09-24 /model ruling): one blank line of
    /// spacing rides under the hint, never a `─` divider.
    #[test]
    fn the_footer_is_a_blank_below_the_shortcuts_never_a_rule() {
        let picker = HeartbeatsPicker::new(entries(), None, None, 24);
        let frame = picker.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        let hint_index = text
            .iter()
            .position(|row| row.contains("Esc close"))
            .expect("the hint row");
        let last = text.last().expect("the pane's last row");
        assert!(
            last.trim().is_empty(),
            "one blank line rides below the shortcuts: {last:?} ({text:?})"
        );
        assert!(!last.contains("\u{2500}"), "no rule below the hint");
        // The rows below the hint are exactly one blank (the detail
        // pane's footer shares the shape).
        assert_eq!(
            text.len() - hint_index - 1,
            1,
            "exactly one blank below the hint: {text:?}"
        );
        // The pane never renders past its viewport budget.
        assert!(frame.len() <= 24);
        let mut drill = HeartbeatsPicker::new(entries(), None, None, 20);
        drill.handle_key("enter", &kb());
        let frame = drill.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        let last = text.last().expect("the detail pane's last row");
        assert!(
            last.trim().is_empty(),
            "the detail footer ends on the same blank: {last:?}"
        );
    }

    /// The interval column renders the human-readable form (the
    /// operator's 2026-09-24 ruling: "cron format is not human
    /// readable"): the interpreted expression rides the column, and the
    /// drill-in's pairs keep the raw cron reachable beside it.
    #[test]
    fn the_interval_column_is_human_readable() {
        assert_eq!(human_schedule("*/2 * * * *"), "every 2 minutes");
        assert_eq!(human_schedule("0 9 * * 1"), "Mondays 09:00");
        assert_eq!(human_schedule("@hourly"), "hourly");
        assert_eq!(human_schedule("0 * * * *"), "hourly");
        assert_eq!(human_schedule("0 0 * * *"), "daily 00:00");
        assert_eq!(human_schedule("0 */3 * * *"), "every 3 hours");
        assert_eq!(human_schedule("*/1 * * * *"), "every minute");
        assert_eq!(human_schedule("30 * * * *"), "hourly at :30");
        assert_eq!(human_schedule("0 0 1 * *"), "monthly 00:00");
        assert_eq!(human_schedule("*/2 9-17 * * 1-5"), "*/2 9-17 * * 1-5");
        assert_eq!(human_schedule("every 10m"), "every 10m");
        assert_eq!(human_schedule("0 9 * * 8"), "0 9 * * 8");
        // The bot-round pins: star-only fields read as every-minute, and
        // whitespace-padded passthroughs trim (never render twice).
        assert_eq!(human_schedule("* * * * *"), "every minute");
        assert_eq!(human_schedule(" every 10m "), "every 10m");

        // The column renders the interpreted form; the pairs keep the
        // raw cron beside it.
        let mut catalog = entries();
        catalog[1].job.schedule_expression = "*/2 * * * *".to_string();
        let mut picker = HeartbeatsPicker::new(catalog, None, None, 24);
        let frame = picker.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(
            text.iter().any(|row| row.contains("every 2 minutes")),
            "the interpreted interval rides the column: {text:?}"
        );
        assert!(
            !text.iter().any(|row| row.contains("*/2 * * * *")),
            "the raw cron leaves the column: {text:?}"
        );
        picker.handle_key("down", &kb());
        picker.handle_key("enter", &kb());
        let frame = picker.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        let schedule_row = text
            .iter()
            .find(|row| row.starts_with("  schedule"))
            .expect("the schedule pair");
        assert!(
            schedule_row.contains("every 2 minutes (*/2 * * * *)"),
            "the pairs keep the raw cron beside the interpretation: {schedule_row}"
        );
    }

    /// Enter on a list row opens the detail drill-in; Enter on an action
    /// row runs it (TS `confirmSelection`).
    #[test]
    fn enter_opens_the_detail_drill_in_and_runs_the_resume_action() {
        let mut picker = HeartbeatsPicker::new(entries(), None, None, 24);
        // The user row (first) is paused: its first action is resume.
        assert_eq!(
            picker.handle_key("enter", &kb()),
            HeartbeatsPickerAction::None
        );
        assert_eq!(
            picker.mode,
            Mode::Detail {
                heartbeat_id: "user-1".to_string(),
                action_index: 0,
            }
        );
        assert_eq!(
            picker.handle_key("enter", &kb()),
            HeartbeatsPickerAction::Manage {
                active_session_id: "live-1".to_string(),
                job_id: "user-1".to_string(),
                action: HeartbeatAction::Resume,
            }
        );
    }

    /// The drill-in renders the full prompt text (wrapped, not
    /// single-lined), which agent created the heartbeat, and the action
    /// rows in the `/mcp` control pattern.
    #[test]
    fn the_detail_renders_the_full_prompt_created_by_and_actions() {
        let mut catalog = entries();
        catalog[0].job.prompt = "first line of the prompt\n\nsecond\nparagraph".to_string();
        let mut picker = HeartbeatsPicker::new(catalog, None, None, 40);
        picker.handle_key("enter", &kb());
        let frame = picker.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        // The full prompt wraps over lines: every word renders, on more
        // than one row, and nothing collapses.
        let joined = text.join("\n");
        for word in [
            "first",
            "line",
            "of",
            "the",
            "prompt",
            "second",
            "paragraph",
        ] {
            assert!(joined.contains(word), "the prompt renders {word}: {joined}");
        }
        assert!(
            text.iter().any(|row| row.starts_with("  Prompt")),
            "the prompt block carries its label"
        );
        // Which agent created it.
        assert!(text
            .iter()
            .any(|row| row.starts_with("  created") && row.contains("Created by you")));
        assert!(text
            .iter()
            .any(|row| row.starts_with("  session") && row.contains("the session")));
        assert!(text.iter().any(|row| row.contains("runs")));
        // The actions.
        assert!(text.iter().any(|row| row.contains("Resume heartbeat")));
        assert!(text.iter().any(|row| row.contains("Stop heartbeat")));
        assert!(text
            .iter()
            .any(|row| row.contains("Continue scheduled deliveries")));
        assert!(text
            .iter()
            .any(|row| row.contains("↑/↓ move · Enter run · ← back · Esc close")));
    }

    #[test]
    fn back_returns_to_the_list_and_escape_closes() {
        let mut picker = HeartbeatsPicker::new(entries(), None, None, 24);
        picker.handle_key("enter", &kb());
        assert_eq!(
            picker.handle_key("left", &kb()),
            HeartbeatsPickerAction::None
        );
        assert_eq!(picker.mode, Mode::List);
        assert_eq!(
            picker.handle_key("escape", &kb()),
            HeartbeatsPickerAction::Close
        );
        assert_eq!(
            picker.handle_key("ctrl+c", &kb()),
            HeartbeatsPickerAction::Close
        );
    }

    #[test]
    fn navigation_moves_the_selection_by_id() {
        let mut picker = HeartbeatsPicker::new(entries(), None, None, 24);
        assert_eq!(
            picker.handle_key("down", &kb()),
            HeartbeatsPickerAction::None
        );
        assert_eq!(picker.selected_heartbeat_id.as_deref(), Some("agent-1"));
        assert_eq!(picker.handle_key("up", &kb()), HeartbeatsPickerAction::None);
        assert_eq!(picker.selected_heartbeat_id.as_deref(), Some("user-1"));
    }

    /// The detail pane walks its action rows (up/down select the action,
    /// never a heartbeat row).
    #[test]
    fn the_detail_pane_walks_its_action_rows() {
        let mut picker = HeartbeatsPicker::new(entries(), None, None, 24);
        picker.handle_key("enter", &kb());
        assert_eq!(
            picker.handle_key("down", &kb()),
            HeartbeatsPickerAction::None
        );
        assert_eq!(
            picker.mode,
            Mode::Detail {
                heartbeat_id: "user-1".to_string(),
                action_index: 1,
            }
        );
        assert_eq!(picker.handle_key("up", &kb()), HeartbeatsPickerAction::None);
        assert_eq!(
            picker.mode,
            Mode::Detail {
                heartbeat_id: "user-1".to_string(),
                action_index: 0,
            }
        );
    }

    #[test]
    fn a_managed_job_replaces_or_removes_its_row() {
        let mut picker = HeartbeatsPicker::new(entries(), None, None, 24);
        picker.handle_key("down", &kb());
        let mut updated = picker.heartbeats[1].job.clone();
        updated.status = "paused".to_string();
        picker.apply_managed_job(updated, false);
        assert_eq!(picker.mode, Mode::List);
        assert!(picker
            .heartbeats
            .iter()
            .any(|entry| entry.job.id == "agent-1" && entry.job.status == "paused"));
        // Stop removes the row and the selection conforms to the first.
        let id = picker.heartbeats[0].job.id.clone();
        let stopped = picker.heartbeats[0].job.clone();
        picker.apply_managed_job(stopped, true);
        assert!(picker.heartbeats.iter().all(|entry| entry.job.id != id));
        assert_eq!(
            picker.selected_heartbeat_id.as_deref(),
            picker.heartbeats.first().map(|entry| entry.job.id.as_str())
        );
    }

    /// A failed background refresh keeps the rows (TS stale-while-revalidate):
    /// the tray keeps counting, and only the in-view failure line appears.
    #[test]
    fn a_fetch_error_keeps_the_rows() {
        let mut picker = HeartbeatsPicker::new(entries(), None, None, 24);
        picker.set_fetch_error(Some("daemon busy".to_string()));
        assert_eq!(picker.heartbeats.len(), 2);
        assert_eq!(picker.fetch_error.as_deref(), Some("daemon busy"));
        let frame = picker.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(text
            .iter()
            .any(|row| row.contains("Heartbeat refresh failed: daemon busy")));
        assert!(text.iter().any(|row| row.contains("tick user-1")));
    }

    #[test]
    fn a_catalog_refresh_keeps_the_surviving_selection() {
        let mut picker = HeartbeatsPicker::new(entries(), None, None, 24);
        picker.handle_key("down", &kb());
        assert_eq!(picker.selected_heartbeat_id.as_deref(), Some("agent-1"));
        let refreshed = picker.heartbeats.clone();
        picker.apply_catalog(refreshed, None);
        assert_eq!(picker.selected_heartbeat_id.as_deref(), Some("agent-1"));
        picker.apply_catalog(Vec::new(), Some("daemon down".to_string()));
        assert!(picker.heartbeats.is_empty());
        assert_eq!(picker.selected_heartbeat_id, None);
        let frame = picker.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        assert!(text
            .iter()
            .any(|row| row.contains("No running or paused heartbeats")));
        assert!(text
            .iter()
            .any(|row| row.contains("Heartbeat refresh failed: daemon down")));
    }

    /// A short viewport shrinks the panes so they never exceed the
    /// terminal budget, and the hint line survives the squeeze (it is
    /// never the clipped row).
    #[test]
    fn short_viewports_never_clip_the_panes() {
        for viewport_rows in [9usize, 10, 12, 14] {
            let picker = HeartbeatsPicker::new(entries(), None, None, viewport_rows);
            let frame = picker.render(&theme(), 70, &kb());
            assert!(
                frame.len() <= viewport_rows,
                "viewport {viewport_rows} fits: pane is {} rows",
                frame.len()
            );
            let text = frame_text(&frame);
            assert!(
                text.iter().any(|row| row.contains("Esc close")),
                "the hint survives a {viewport_rows}-row viewport"
            );
        }
        // The detail pane fits too: the fixed rows (name, schedule, the
        // two action rows, the hint) always render, and the prompt and
        // pairs blocks give way.
        let mut picker = HeartbeatsPicker::new(entries(), None, None, 12);
        picker.handle_key("enter", &kb());
        let frame = picker.render(&theme(), 70, &kb());
        assert!(frame.len() <= 12, "detail pane fits: {}", frame.len());
        let text = frame_text(&frame);
        assert!(text.iter().any(|row| row.contains("Stop heartbeat")));
    }

    /// A long prompt clips with an ellipsis marker row rather than
    /// overspending the viewport.
    #[test]
    fn a_long_prompt_clips_with_a_marker() {
        let mut catalog = entries();
        catalog[0].job.prompt = (1..=40)
            .map(|n| format!("word-{n:02}"))
            .collect::<Vec<_>>()
            .join(" ");
        // The schedule pair (item 3) rides the block too, so the prompt
        // needs one more row than the pre-batch fixture budgeted.
        let mut picker = HeartbeatsPicker::new(catalog, None, None, 23);
        picker.handle_key("enter", &kb());
        let frame = picker.render(&theme(), 70, &kb());
        assert!(frame.len() <= 23, "the drill-in fits: {}", frame.len());
        let text = frame_text(&frame);
        assert!(
            text.iter().any(|row| row.trim() == "…"),
            "the clipped tail carries a marker: {text:?}"
        );
        // The first words render; the last ones do not.
        let joined = text.join(" ");
        assert!(joined.contains("word-01"));
        assert!(!joined.contains("word-40"));
    }

    /// A missing next-run pads its cell like the header: the status
    /// column stays under its header when the `—` placeholder renders.
    #[test]
    fn a_missing_next_run_keeps_the_columns_aligned() {
        let mut catalog = entries();
        catalog[0].job.next_run_at = None;
        let picker = HeartbeatsPicker::new(catalog, None, None, 24);
        let frame = picker.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        let row = text
            .iter()
            .find(|row| row.contains("every 10m"))
            .expect("the row");
        // The status cell sits at the same offset as the header's
        // (the selected row's half-circle dot starts the cell).
        let header = text
            .iter()
            .find(|row| row.contains("Interval") && row.contains("Next run"))
            .expect("the header");
        // The display column is a CHAR offset (the glyphs before the
        // status cell are multi-byte UTF-8; a byte offset would read the
        // row as misaligned).
        let column_of =
            |text: &str, needle: &str| text.find(needle).map(|byte| text[..byte].chars().count());
        let (Some(h), Some(r)) = (column_of(header, "Status"), column_of(row, "\u{25d0}")) else {
            panic!("header and row status cells: {header:?} {row:?}");
        };
        assert_eq!(h, r, "the status column aligns: {header:?} vs {row:?}");
    }

    /// The schedule pair never displaces the error row (the bot-round
    /// fix): a heartbeat carrying both a schedule fact and a last error
    /// renders every pair — MAX_DETAIL_ROWS covers the seven base pairs.
    #[test]
    fn the_schedule_pair_never_hides_the_error_row() {
        let mut catalog = entries();
        catalog[0].job.last_error = Some("provider 429".to_string());
        catalog[0].job.schedule_expression = "*/2 * * * *".to_string();
        let mut picker = HeartbeatsPicker::new(catalog, None, None, 40);
        picker.handle_key("enter", &kb());
        let frame = picker.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        let joined = text.join("\n");
        assert!(
            joined.contains("every 2 minutes (*/2 * * * *)"),
            "the schedule fact rides its pair: {joined}"
        );
        assert!(
            joined.contains("last error"),
            "the error row stays in the block: {joined}"
        );
        assert!(
            joined.contains("provider 429"),
            "the error's value renders: {joined}"
        );
    }

    /// The prompt block never degrades to a lone marker: a budget of one
    /// renders the first prompt line instead.
    #[test]
    fn a_one_row_prompt_budget_renders_the_first_line() {
        let mut catalog = entries();
        catalog[0].job.prompt = (1..=12)
            .map(|n| format!("word-{n:02}"))
            .collect::<Vec<_>>()
            .join(" ");
        // The schedule pair (item 3) rides the block too, so the
        // one-row prompt budget needs one more viewport row.
        let mut picker = HeartbeatsPicker::new(catalog, None, None, 20);
        picker.handle_key("enter", &kb());
        let frame = picker.render(&theme(), 70, &kb());
        assert!(frame.len() <= 20, "the drill-in fits: {}", frame.len());
        let text = frame_text(&frame);
        assert!(text.join(" ").contains("word-01"), "a prompt line renders");
        assert!(
            text.iter().filter(|row| row.trim() == "\u{2026}").count() == 0,
            "no lone marker: {text:?}"
        );
    }

    /// The scroll-indicator row is reserved exactly once: a scrolling
    /// viewport uses every row it can hold (the frame constant excludes
    /// the conditional indicator; menu_list_layout reserves it).
    #[test]
    fn a_scrolling_viewport_uses_every_row() {
        let mut catalog = entries();
        while catalog.len() < 10 {
            let mut extra = job_value(&format!("hb-{}", catalog.len()), "rlm_heartbeat", "active");
            extra["job"]["label"] = serde_json::json!(format!("job {}", catalog.len()));
            let job = parse_heartbeat_job(&extra["job"]).expect("job");
            catalog.push(HeartbeatEntry {
                job,
                session_name: None,
                first_message: None,
            });
        }
        let picker = HeartbeatsPicker::new(catalog, None, None, 12);
        let frame = picker.render(&theme(), 70, &kb());
        assert_eq!(
            frame.len(),
            12,
            "the scrolling pane spends the viewport exactly: {:#?}",
            frame
                .iter()
                .map(|line| line
                    .iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>())
                .collect::<Vec<_>>()
        );
    }

    /// A double failure (fetch error + action error) reserves both footer
    /// blocks: the list never renders past the viewport.
    #[test]
    fn double_errors_reserve_both_footer_blocks() {
        let mut picker = HeartbeatsPicker::new(entries(), None, None, 14);
        picker.set_fetch_error(Some("daemon busy".to_string()));
        picker.set_action_error("management failed".to_string());
        let frame = picker.render(&theme(), 70, &kb());
        assert!(frame.len() <= 14, "the pane fits: {}", frame.len());
        let text = frame_text(&frame);
        assert!(text.iter().any(|row| row.contains("daemon busy")));
        assert!(text
            .iter()
            .any(|row| row.contains("Error: management failed")));
    }

    /// A terminal shorter than the frame itself never renders past its
    /// allocated rows (both panes degrade by truncation).
    #[test]
    fn a_sub_frame_viewport_never_overflows() {
        for viewport_rows in [1usize, 2, 3, 5, 7, 9] {
            let picker = HeartbeatsPicker::new(entries(), None, None, viewport_rows);
            let frame = picker.render(&theme(), 70, &kb());
            assert!(
                frame.len() <= viewport_rows,
                "viewport {viewport_rows}: pane is {} rows",
                frame.len()
            );
            let mut drill = HeartbeatsPicker::new(entries(), None, None, viewport_rows);
            drill.handle_key("enter", &kb());
            let frame = drill.render(&theme(), 70, &kb());
            assert!(
                frame.len() <= viewport_rows,
                "viewport {viewport_rows}: detail is {} rows",
                frame.len()
            );
        }
    }

    /// A prompt carrying escape sequences renders inert (control
    /// characters scrub before the wrap).
    #[test]
    fn an_escape_sequence_in_the_prompt_never_reaches_the_terminal() {
        let mut catalog = entries();
        catalog[0].job.prompt = "run \u{1b}[31mred\u{1b}[0m now".to_string();
        let mut picker = HeartbeatsPicker::new(catalog, None, None, 24);
        picker.handle_key("enter", &kb());
        let frame = picker.render(&theme(), 70, &kb());
        let joined = frame_text(&frame).join("\n");
        assert!(!joined.contains('\u{1b}'), "the escape scrubs: {joined:?}");
        assert!(joined.contains("red"), "the visible text stays");
    }

    /// Daemon-supplied catalog fields render inert: an ANSI/OSC sequence
    /// in a schedule expression, status, or session label never reaches
    /// the terminal (the parse boundary scrubs it).
    #[test]
    fn catalog_control_sequences_scrub_at_the_parse_boundary() {
        let data = serde_json::json!({
            "heartbeats": [{
                "job": {
                    "id": "esc-1",
                    "status": "active\u{1b}[31m",
                    "source": "heartbeat",
                    "activeSessionId": "live-1",
                    "sessionId": "sess-1",
                    "prompt": "tick",
                    "schedule": {"kind": "interval", "expression": "every 10m\u{1b}[2J"},
                },
                "sessionName": "\u{1b}]52;c;clipboard\u{7} the session",
            }]
        });
        let mut parsed = parse_heartbeats(&data);
        sort_heartbeats(&mut parsed);
        let picker = HeartbeatsPicker::new(parsed, None, None, 24);
        let frame = picker.render(&theme(), 70, &kb());
        let joined = frame_text(&frame).join("\n");
        assert!(
            !joined.contains('\u{1b}'),
            "no escapes reach the render: {joined:?}"
        );
        assert!(joined.contains("every 10m"), "the visible schedule stays");
        // The drill-in's subtitle and pairs stay inert too.
        let data2 = serde_json::json!({
            "heartbeats": [{
                "job": {
                    "id": "esc-1",
                    "status": "active\u{1b}[31m",
                    "source": "heartbeat",
                    "activeSessionId": "live-1",
                    "sessionId": "sess-1",
                    "prompt": "tick",
                    "schedule": {"kind": "interval", "expression": "every 10m\u{1b}[2J"},
                },
                "sessionName": "the session",
            }]
        });
        let mut catalog = parse_heartbeats(&data2);
        sort_heartbeats(&mut catalog);
        let mut drill = HeartbeatsPicker::new(catalog, None, None, 24);
        drill.handle_key("enter", &kb());
        let frame = drill.render(&theme(), 70, &kb());
        let joined = frame_text(&frame).join("\n");
        assert!(
            !joined.contains('\u{1b}'),
            "the drill-in stays inert: {joined:?}"
        );
    }

    #[test]
    fn timestamps_cut_to_minutes_and_whitespace_collapses() {
        assert_eq!(
            format_timestamp("2026-01-02T03:04:05.000Z"),
            "2026-01-02 03:04"
        );
        assert_eq!(format_timestamp("not a date"), "not a date");
        assert_eq!(single_line("a  \n b\t c "), "a b c");
    }
}
