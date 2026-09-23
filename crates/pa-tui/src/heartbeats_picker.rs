//! The `/heartbeats` inline management view (TS
//! `HeartbeatManagerComponent`): the current session's heartbeats (the
//! TS `scopeHeartbeatsToSession` child-session clause is not carried by
//! the caller — operator scoping: nested sessions' heartbeats do not
//! surface here), one `›`-marker row per heartbeat with its status, the
//! selection's labeled detail block, and a per-heartbeat action pane
//! (pause/resume, stop). Rendered inline-picker style (the `/model`
//! geometry — a plain-text title line with the status counts, one
//! bottom hint line) instead of the TS full-pane overlay.

use serde_json::Value;

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::menu_list_layout;
use crate::theme::{Theme, ThemeColor};
use crate::width::{str_width, truncate_line};
use crate::{Line, Span};

/// The preferred visible rows of the list (TS
/// `PREFERRED_VISIBLE_HEARTBEATS`).
const PREFERRED_VISIBLE: usize = 8;

/// Rows the list reserves outside its items and the detail block (the
/// inline geometry: rule, title line, blank, blank, blank, hint, rule).
const LIST_FRAME_ROWS: usize = 7;

/// The selection's detail-block row budget.
const MAX_DETAIL_ROWS: usize = 6;

/// One scroll-indicator row when the list window is shorter than the list.
const SCROLL_INDICATOR_ROWS: usize = 1;

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
    let text = |field: &str| job.get(field).and_then(Value::as_str).map(str::to_string);
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
            .unwrap_or_default()
            .to_string(),
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
                    .map(str::to_string),
                first_message: row
                    .get("firstMessage")
                    .and_then(Value::as_str)
                    .map(str::to_string),
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

/// The selected heartbeat's detail line (TS `formatHeartbeatDetails` plus
/// the last error the TS rows carry as their secondary text: the inline
/// row has no secondary line, so the error joins the detail).
/// The selected heartbeat's detail block: `(label, value)` pairs (the
/// `/model` picker's detail-block idiom — a labeled two-column block
/// instead of a metadata run-on).
fn detail_pairs(entry: &HeartbeatEntry) -> Vec<(&'static str, String)> {
    let mut pairs = vec![
        ("created", source_label(entry).to_string()),
        ("session", session_label(entry)),
        ("schedule", entry.job.schedule_expression.clone()),
        ("delivery", delivery_label(entry).to_string()),
        (
            "next run",
            entry
                .job
                .next_run_at
                .as_deref()
                .map(format_timestamp)
                .unwrap_or_else(|| "\u{2014}".to_string()),
        ),
    ];
    if let Some(error) = entry.job.last_error.as_deref() {
        let error = single_line(error);
        if !error.is_empty() {
            pairs.push(("last error", error));
        }
    }
    pairs
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

/// The pane's interactive mode (TS `HeartbeatManagerMode`).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Mode {
    List,
    /// The selected heartbeat's action pane, `selected_index` in its rows.
    Actions {
        heartbeat_id: String,
        selected_index: usize,
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
        // A carried selection (the activity panel's chosen row) survives the
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

    /// Drop an actions pane whose heartbeat vanished (TS `render`'s mode
    /// fallback).
    fn dirty_conform_mode(&mut self) {
        if let Mode::Actions { heartbeat_id, .. } = self.mode.clone() {
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
        // Back (left): the action pane returns to the list, the list closes.
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
        // action pane from the list.
        if self.mode == Mode::List && kb.matches(key, "app.heartbeats.openSelected") {
            self.open_actions();
            return HeartbeatsPickerAction::None;
        }
        if kb.matches(key, "tui.select.confirm") {
            return self.confirm_selection();
        }
        HeartbeatsPickerAction::None
    }

    /// Move the selection (TS `moveSelection`): the list walks rows by job
    /// id, the action pane walks its rows by index.
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
            Mode::Actions {
                heartbeat_id,
                selected_index,
            } => {
                let Some(entry) = self.find_entry(&heartbeat_id) else {
                    return;
                };
                let count = Self::available_actions(entry).len();
                let next = (selected_index as isize + delta).clamp(0, count as isize - 1) as usize;
                self.mode = Mode::Actions {
                    heartbeat_id,
                    selected_index: next,
                };
            }
        }
    }

    /// Enter on the list opens the selected heartbeat's action pane; Enter
    /// on an action row runs it (TS `confirmSelection`).
    fn confirm_selection(&mut self) -> HeartbeatsPickerAction {
        match self.mode.clone() {
            Mode::List => {
                self.open_actions();
                HeartbeatsPickerAction::None
            }
            Mode::Actions {
                heartbeat_id,
                selected_index,
            } => {
                let Some(entry) = self.find_entry(&heartbeat_id) else {
                    self.mode = Mode::List;
                    return HeartbeatsPickerAction::None;
                };
                let actions = Self::available_actions(entry);
                let Some((_, action, _)) = actions.get(selected_index) else {
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

    /// Open the selected heartbeat's action pane (TS `confirmSelection`'s
    /// list branch).
    fn open_actions(&mut self) {
        let Some(id) = self.selected_heartbeat_id.clone() else {
            return;
        };
        if self.find_entry(&id).is_some() {
            self.mode = Mode::Actions {
                heartbeat_id: id,
                selected_index: 0,
            };
        }
    }

    /// The selection's detail-block row budget, shrinking on short
    /// viewports so the pane never clips: the frame rows, the scroll
    /// indicator, and the list rows always render first (frame 7 +
    /// scroll 1 + list 1 = 9 ride outside the budget) — on very short
    /// viewports the block yields entirely rather than overspending.
    fn detail_cap(&self) -> usize {
        MAX_DETAIL_ROWS.min(self.viewport_rows.saturating_sub(9))
    }

    /// The list's visible-row budget (TS `getListLayout`, inline shape).
    fn visible_items(&self) -> usize {
        let reserved = LIST_FRAME_ROWS
            + self.detail_cap()
            + if self.error.is_some() || self.fetch_error.is_some() {
                2
            } else {
                0
            };
        menu_list_layout(
            Some(self.viewport_rows),
            PREFERRED_VISIBLE,
            self.heartbeats.len(),
            reserved,
            SCROLL_INDICATOR_ROWS,
        )
    }

    /// Render the view's frame: the list pane or the action pane.
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        match &self.mode {
            Mode::List => self.render_list(theme, width, kb),
            Mode::Actions {
                heartbeat_id,
                selected_index,
            } => self.render_actions(theme, width, kb, heartbeat_id, *selected_index),
        }
    }

    /// The list pane (the `/model` picker idiom): the title line with the
    /// status counts, one `›`-marker row per heartbeat, the scroll
    /// indicator, the selection's labeled detail block, the error rows,
    /// and a single bottom hint line.
    fn render_list(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        let counts: Vec<(ThemeColor, String)> = self.status_counts();
        let mut lines = pane_header_lines(theme, width, "Heartbeats", &counts, None);
        if self.heartbeats.is_empty() {
            lines.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Muted, "No running or paused heartbeats"),
            ]);
        } else {
            let selected = self.selected_index();
            let visible = self.visible_items();
            let start = selected
                .saturating_sub(visible / 2)
                .min(self.heartbeats.len().saturating_sub(visible));
            let end = (start + visible).min(self.heartbeats.len());
            for (index, entry) in self.heartbeats[start..end].iter().enumerate() {
                let is_selected = start + index == selected;
                lines.push(self.heartbeat_row(theme, width, entry, is_selected));
            }
            if start > 0 || end < self.heartbeats.len() {
                lines.push(vec![
                    Span::raw("  "),
                    theme.fg_span(
                        ThemeColor::Muted,
                        format!("({}/{})", selected + 1, self.heartbeats.len()),
                    ),
                ]);
            }
            if let Some(entry) = self
                .heartbeats
                .get(selected)
                .filter(|_| self.selected_heartbeat_id.is_some())
            {
                lines.push(Vec::new());
                let cap = self.detail_cap();
                lines.extend(detail_block_lines(
                    theme,
                    width,
                    &detail_pairs(entry)
                        .into_iter()
                        .take(cap)
                        .collect::<Vec<_>>(),
                ));
            }
        }
        lines.extend(self.pane_footer(theme, width, kb, &self.list_hint(kb)));
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

    /// The action pane (TS `createActionPanel`): the heartbeat's name and
    /// prompt, its labeled detail block, the action rows, and the
    /// bottom hint line.
    fn render_actions(
        &self,
        theme: &Theme,
        width: usize,
        kb: &KeybindingsManager,
        heartbeat_id: &str,
        selected_index: usize,
    ) -> Vec<Line> {
        let Some(entry) = self.find_entry(heartbeat_id) else {
            // The heartbeat vanished: the TS panel degrades to this text.
            let mut lines = pane_header_lines(theme, width, "Heartbeats", &[], None);
            lines.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Muted, "This heartbeat is no longer available."),
            ]);
            lines.extend(self.pane_footer(theme, width, kb, &self.actions_hint(kb)));
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
        let prompt = single_line(&entry.job.prompt);
        let mut lines = pane_header_lines(theme, width, &name, &[], Some(&prompt));
        // The action pane has no list window to absorb a shortage: the
        // detail block shrinks on short viewports so the pane never
        // clips (its frame rows, the two action rows, and the hint
        // always render first; the error block adds two rows) — on very
        // short viewports the block yields entirely.
        let error_rows = if self.error.is_some() { 2 } else { 0 };
        let cap = MAX_DETAIL_ROWS.min(self.viewport_rows.saturating_sub(10 + error_rows));
        lines.extend(detail_block_lines(
            theme,
            width,
            &detail_pairs(entry)
                .into_iter()
                .take(cap)
                .collect::<Vec<_>>(),
        ));
        if let Some(error) = &self.error {
            lines.push(Vec::new());
            lines.push(error_line(theme, width, error));
        }
        lines.push(Vec::new());
        for (index, (label, _, description)) in Self::available_actions(entry).iter().enumerate() {
            lines.push(self.list_row(theme, width, label, description, index == selected_index));
        }
        lines.extend(self.pane_footer(theme, width, kb, &self.actions_hint(kb)));
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
            "{}/{} move \u{b7} {} manage \u{b7} {} close",
            key("tui.select.up", "\u{2191}"),
            key("tui.select.down", "\u{2193}"),
            key("tui.select.confirm", "Enter"),
            key("tui.select.cancel", "Esc"),
        )
    }

    /// The action pane's bottom hint line.
    fn actions_hint(&self, kb: &KeybindingsManager) -> String {
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

    /// One `›`-marker row: the primary cell (a heartbeat's name, or an
    /// action's label) with a colored trailing cluster — the status word
    /// for heartbeats, the action description for actions (the inline
    /// adaptation of TS `MenuRow`'s meta cell).
    fn list_row(
        &self,
        theme: &Theme,
        width: usize,
        primary: &str,
        trailing: &str,
        selected: bool,
    ) -> Line {
        self.row_with_trailing(theme, width, primary, trailing, None, selected)
    }

    /// One heartbeat row: primary name, the status word trailing
    /// (success/warning colored, TS `formatStatus`).
    fn heartbeat_row(
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
        self.row_with_trailing(
            theme,
            width,
            &row_primary(entry),
            &entry.job.status,
            Some(status_color),
            selected,
        )
    }

    /// A `›`-marker row with an optionally colored trailing cluster right
    /// aligned (the inline `MenuRow` geometry: marker, primary, filler,
    /// trailing, padded to width, soft selection background).
    fn row_with_trailing(
        &self,
        theme: &Theme,
        width: usize,
        primary: &str,
        trailing: &str,
        trailing_color: Option<ThemeColor>,
        selected: bool,
    ) -> Line {
        let inner_width = width.saturating_sub(2).max(1);
        let trailing_budget = inner_width.saturating_sub(5).max(1);
        let trailing = truncate_plain(trailing, trailing_budget);
        let trailing_width = str_width(&trailing);
        let gap = if trailing_width > 0 { 2 } else { 0 };
        let primary_width = inner_width.saturating_sub(trailing_width + gap).max(1);
        let primary = truncate_plain(primary, primary_width);
        let filler = inner_width
            .saturating_sub(str_width(&primary))
            .saturating_sub(trailing_width);
        let mut row: Line = Vec::with_capacity(8);
        row.push(Span::raw(if selected { "\u{203a}" } else { " " }));
        row.push(Span::raw(" "));
        if selected {
            row.push(theme.bold(Span::raw(primary)));
        } else {
            row.push(Span::raw(primary));
        }
        if filler > 0 {
            row.push(Span::raw(" ".repeat(filler)));
        }
        if !trailing.is_empty() {
            let span = match trailing_color {
                Some(color) => theme.fg_span(color, trailing),
                None => theme.fg_span(ThemeColor::Muted, trailing),
            };
            row.push(span);
        }
        let used = crate::width::spans_width(&row);
        if used < width {
            row.push(Span::raw(" ".repeat(width - used)));
        }
        let row = truncate_line(&row, width, "");
        if selected {
            let style = theme.soft_selection_style();
            row.into_iter()
                .map(|mut span| {
                    span.style = span.style.patch(style);
                    span
                })
                .collect()
        } else {
            row
        }
    }

    /// The pane footer: the fetch and action errors, a blank, the hint
    /// line, the bottom border.
    fn pane_footer(
        &self,
        theme: &Theme,
        width: usize,
        _kb: &KeybindingsManager,
        hint: &str,
    ) -> Vec<Line> {
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
        lines.push(vec![
            theme.fg_span(ThemeColor::BorderMuted, "\u{2500}".repeat(width.max(1)))
        ]);
        lines
    }
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

/// Plain-text truncate with the `…` marker (the list rows' budgeting).
fn truncate_plain(text: &str, width: usize) -> String {
    if str_width(text) <= width {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(width.saturating_sub(1)).collect();
    cut.push('\u{2026}');
    cut
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
                "schedule": {"kind": "interval", "expression": "every 10m", "intervalMs": 600000},
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

    #[test]
    fn a_carried_selection_opens_on_that_row() {
        let catalog = entries();
        let ids: Vec<_> = catalog.iter().map(|entry| entry.job.id.clone()).collect();
        let picker = HeartbeatsPicker::new(catalog.clone(), None, Some(ids[1].clone()), 24);
        assert_eq!(
            picker.selected_heartbeat_id.as_deref(),
            Some(ids[1].as_str())
        );
        // An id that is not in the catalog falls back to the first row.
        let picker = HeartbeatsPicker::new(catalog, None, Some("missing".to_string()), 24);
        assert_eq!(
            picker.selected_heartbeat_id.as_deref(),
            Some(ids[0].as_str())
        );
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

    #[test]
    fn the_list_renders_rows_status_and_hints() {
        let picker = HeartbeatsPicker::new(entries(), None, None, 24);
        let frame = picker.render(&theme(), 70, &kb());
        let text: Vec<String> = frame
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect();
        assert!(text.iter().any(|row| row.contains("Heartbeats")));
        // The title line carries the status counts in the status colors,
        // not a TS-style count sentence.
        assert!(text.iter().any(|row| row.contains("1 active · 1 paused")));
        assert!(text.iter().any(|row| row.contains("tick user-1")));
        assert!(text.iter().any(|row| row.contains("paused")));
        // The selection's detail is a labeled two-column block, not a
        // metadata run-on; each row stays one line.
        assert!(text
            .iter()
            .any(|row| row.starts_with("  schedule") && row.contains("every 10m")));
        assert!(text
            .iter()
            .any(|row| row.starts_with("  created") && row.contains("Created by you")));
        assert!(text
            .iter()
            .any(|row| row.starts_with("  next run") && row.contains("2026-01-01 00:10")));
        // Exactly one bottom hint line carries every shortcut.
        assert_eq!(
            text.iter().filter(|row| row.contains("Esc close")).count(),
            1,
            "the close hint appears once: {text:?}"
        );
        assert!(text
            .iter()
            .any(|row| row.contains("↑/↓ move · Enter manage · Esc close")));
    }

    #[test]
    fn enter_opens_the_action_pane_and_runs_the_pause_action() {
        let mut picker = HeartbeatsPicker::new(entries(), None, None, 24);
        // The user row (first) is paused: its first action is resume.
        assert_eq!(
            picker.handle_key("enter", &kb()),
            HeartbeatsPickerAction::None
        );
        assert_eq!(
            picker.mode,
            Mode::Actions {
                heartbeat_id: "user-1".to_string(),
                selected_index: 0,
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
        // The action pane renders the TS labels.
        let frame = picker.render(&theme(), 70, &kb());
        let text: Vec<String> = frame
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect();
        assert!(text.iter().any(|row| row.contains("Resume heartbeat")));
        assert!(text.iter().any(|row| row.contains("Stop heartbeat")));
        assert!(text
            .iter()
            .any(|row| row.contains("Continue scheduled deliveries")));
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
        let text: Vec<String> = frame
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect();
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
        let text: Vec<String> = frame
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect();
        assert!(text
            .iter()
            .any(|row| row.contains("No running or paused heartbeats")));
        assert!(text
            .iter()
            .any(|row| row.contains("Heartbeat refresh failed: daemon down")));
    }

    /// A short viewport shrinks the detail block so the pane never
    /// exceeds the terminal budget, and the hint line survives the
    /// squeeze (it is never the clipped row).
    #[test]
    fn short_viewports_never_clip_the_list_pane() {
        for viewport_rows in [9usize, 10, 12, 14] {
            let picker = HeartbeatsPicker::new(entries(), None, None, viewport_rows);
            let frame = picker.render(&theme(), 70, &kb());
            assert!(
                frame.len() <= viewport_rows,
                "viewport {viewport_rows} fits: pane is {} rows",
                frame.len()
            );
            let text: Vec<String> = frame
                .iter()
                .map(|line| line.iter().map(|span| span.content.as_str()).collect())
                .collect();
            assert!(
                text.iter().any(|row| row.contains("Esc close")),
                "the hint survives a {viewport_rows}-row viewport"
            );
            assert!(text.iter().any(|row| row.contains("tick user-1")));
        }
        // The action pane fits too: the fixed rows (name, prompt, two
        // action rows, hint) always render, the detail block gives way.
        let mut picker = HeartbeatsPicker::new(entries(), None, None, 12);
        picker.handle_key("enter", &kb());
        let frame = picker.render(&theme(), 70, &kb());
        assert!(frame.len() <= 12, "action pane fits: {}", frame.len());
        let text: Vec<String> = frame
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect();
        assert!(text.iter().any(|row| row.contains("Stop heartbeat")));
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
