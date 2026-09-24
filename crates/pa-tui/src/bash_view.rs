//! The dedicated bash view (the operator's 2026-09-23 redesign): the
//! session's kernel bash registry — the background commands the agent's
//! REPL started — as a columned table (command, duration, pid, status),
//! and Enter on a row opens the detail drill-in: the exact command, all
//! output fetched so far, and the actions (cancel the running command) in
//! the same up/down-selectable control pattern as the `/mcp` view. The
//! selected row washes a little past its text (the onboarding choice
//! treatment), never the whole terminal width. Pure presentation and
//! selection: the host owns the 2s registry refresh, fetches the output
//! tail, and executes the kill.

use serde_json::Value;

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::{hug_row, menu_list_layout, plain_cell, status_dot};
use crate::theme::{Theme, ThemeColor};
use crate::width::{str_width, truncate_line, wrap_text};
use crate::{Line, Span};

/// The preferred visible rows of the list.
const PREFERRED_VISIBLE: usize = 8;

/// Rows the list reserves outside its items (the inline geometry: rule,
/// title, blank, column header, blank, hint, rule — the conditional
/// scroll-indicator row rides `menu_list_layout`'s scroll reservation,
/// never counted twice).
const LIST_FRAME_ROWS: usize = 7;

/// The detail pane's labeled-pair row budget.
const MAX_DETAIL_ROWS: usize = 5;

/// The command column's width cap.
const COMMAND_CAP: usize = 44;

/// The lines the host asks the kernel's `tail` for (the wire's own cap,
/// a u32 on the `tail_kernel_bash` payload).
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
                command: row
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                pid: row
                    .get("pid")
                    .and_then(Value::as_u64)
                    .and_then(|pid| pid.try_into().ok()),
                started_at: row
                    .get("startedAt")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                status: row
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
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
    Detail { id: String, action_index: usize },
}

/// One key press while the view is open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BashViewAction {
    Close,
    /// Enter on a list row: the host fetches the row's output tail and
    /// delivers it back with [`BashView::set_output`]; `generation`
    /// stamps the open it was issued under.
    OpenDetail {
        id: String,
        generation: u64,
    },
    /// Enter on the cancel action: the host runs `kill_kernel_bash` and
    /// refreshes the registry.
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
    /// The fetched output tail of the open detail row: `Some` once the
    /// tail landed (empty output included), `None` while fetching.
    output_tail: Option<(String, Vec<String>)>,
    error: Option<String>,
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
            error: None,
            viewport_rows,
        };
        view.selected_id = view.activities.first().map(|row| row.id.clone());
        view
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
        if let Mode::Detail { id, .. } = self.mode.clone() {
            if !self.activities.iter().any(|row| row.id == id) {
                self.mode = Mode::List;
                self.output_tail = None;
            }
        }
        self.output_tail = self
            .output_tail
            .take()
            .filter(|(id, _)| self.activities.iter().any(|row| row.id == *id));
    }

    /// The fetched output tail of one row (the host's `tail_kernel_bash`
    /// response); a tail for a closed pane, a different row, or an
    /// earlier open of the same row is ignored.
    pub fn set_output(&mut self, id: &str, tail: &str, generation: u64) {
        if self.detail_id().as_deref() != Some(id) || self.detail_generation != generation {
            return;
        }
        let lines: Vec<String> = tail.lines().map(clean_line).collect();
        self.output_tail = Some((id.to_string(), lines));
    }

    pub(crate) fn detail_id(&self) -> Option<String> {
        match &self.mode {
            Mode::Detail { id, .. } => Some(id.clone()),
            Mode::List => None,
        }
    }

    /// Surface a fetch or kill failure (the host's error channel).
    pub fn set_error(&mut self, error: String) {
        self.error = Some(error);
    }

    /// A landed REGISTRY update supersedes a shown error (a retried kill
    /// proves the failure gone): the host calls this only when the
    /// registry itself changed, not on unrelated dock repaints.
    pub fn clear_error(&mut self) {
        self.error = None;
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

    /// One key id (the picker pattern: up/down move, Enter opens or runs,
    /// back returns, cancel closes).
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
            return BashViewAction::None;
        }
        if kb.matches(key, "tui.select.up") || kb.matches(key, "tui.select.down") {
            let delta = if kb.matches(key, "tui.select.up") {
                -1isize
            } else {
                1
            };
            self.move_selection(delta);
            return BashViewAction::None;
        }
        if kb.matches(key, "tui.select.confirm") {
            return self.confirm_selection();
        }
        BashViewAction::None
    }

    /// Move the selection: the list walks rows by id, the detail pane
    /// walks its action rows by index.
    fn move_selection(&mut self, delta: isize) {
        match self.mode.clone() {
            Mode::List => {
                if self.activities.is_empty() {
                    return;
                }
                let index = self.selected_index() as isize;
                let next = (index + delta).clamp(0, self.activities.len() as isize - 1) as usize;
                self.selected_id = Some(self.activities[next].id.clone());
            }
            Mode::Detail { id, action_index } => {
                let Some(activity) = self.find_activity(&id) else {
                    return;
                };
                let count = Self::available_actions(activity).len();
                if count == 0 {
                    return;
                }
                let next = (action_index as isize + delta).clamp(0, count as isize - 1) as usize;
                self.mode = Mode::Detail {
                    id,
                    action_index: next,
                };
            }
        }
    }

    /// Enter on the list opens the row's detail drill-in (the host fetches
    /// the output tail); Enter on the cancel action runs the kill.
    fn confirm_selection(&mut self) -> BashViewAction {
        match self.mode.clone() {
            Mode::List => {
                let Some(id) = self.selected_id.clone() else {
                    return BashViewAction::None;
                };
                if self.find_activity(&id).is_some() {
                    self.mode = Mode::Detail {
                        id: id.clone(),
                        action_index: 0,
                    };
                    self.detail_generation = self.detail_generation.wrapping_add(1);
                    self.output_tail = None;
                    return BashViewAction::OpenDetail {
                        id,
                        generation: self.detail_generation,
                    };
                }
                BashViewAction::None
            }
            Mode::Detail { id, action_index } => {
                let Some(activity) = self.find_activity(&id) else {
                    self.mode = Mode::List;
                    self.output_tail = None;
                    return BashViewAction::None;
                };
                if Self::available_actions(activity)
                    .get(action_index)
                    .is_some()
                {
                    return BashViewAction::Kill { id };
                }
                BashViewAction::None
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
            Mode::Detail { id, action_index } => {
                self.render_detail(theme, width, kb, id, *action_index)
            }
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
        lines
    }

    /// The detail drill-in: the exact command (wrapped, never
    /// truncated), the labeled facts, all output fetched so far, and the
    /// action rows in the `/mcp` view's control pattern. A short viewport
    /// shrinks the pairs first, then the command block, then the output
    /// tail — the action rows never yield.
    fn render_detail(
        &self,
        theme: &Theme,
        width: usize,
        kb: &KeybindingsManager,
        id: &str,
        action_index: usize,
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
        let name = single_line(&activity.command);
        // The drill-in's command block is the EXACT command — embedded
        // newlines and spacing stay verbatim — with the non-newline
        // control characters scrubbed: a command carrying an escape
        // sequence never executes terminal control operations when
        // rendered (only the title cell single-lines for identity).
        let command_exact: String = activity
            .command
            .chars()
            .map(|character| {
                if character.is_control() && character != '\n' {
                    ' '
                } else {
                    character
                }
            })
            .collect();
        let subtitle = if activity.running() {
            "running".to_string()
        } else {
            match activity.exit_code {
                Some(code) => format!("exit {code}"),
                None => activity.status.clone(),
            }
        };
        let mut lines = pane_header_lines(theme, width, &name, &[], Some(&subtitle));
        let actions = Self::available_actions(activity);
        let pairs = detail_pairs(activity);
        let error_rows = if self.error.is_some() { 2 } else { 0 };
        // The pane's fixed rows: the header block (rule, title, subtitle,
        // blank), the actions block (blank + rows), the footer (blank,
        // hint, rule), and the error rows when present. The command,
        // pairs, and output blocks ride the remaining budget in priority
        // order — the exact command, the output tail, then the labeled
        // pairs — and a block that cannot fit renders not at all.
        let fixed = 4
            + 3
            + error_rows
            + if actions.is_empty() {
                0
            } else {
                1 + actions.len()
            };
        let budget = self.viewport_rows.saturating_sub(fixed);
        // The pairs cap at a quarter of the budget so they never squeeze
        // the content blocks (they are the drill-in's least load-bearing
        // facts).
        let pairs_rows = pairs.len().min(MAX_DETAIL_ROWS).min(budget / 4);
        let mut left = budget.saturating_sub(if pairs_rows > 0 { 1 + pairs_rows } else { 0 });
        // The exact command wraps at the pane's content width; its block
        // renders only when its label and at least one line fit beside
        // the output block's own minimum.
        let command_width = width.saturating_sub(4).max(10);
        let command_wrapped = wrap_text(&command_exact, command_width);
        let mut command_rows = 0usize;
        let mut command_clipped = false;
        // The command renders only when the output block's own minimum
        // (its label plus a line, 3 rows) still fits beside it: the
        // fetched tail is the drill-in's point and never loses its
        // section to a long command.
        if left >= 6 {
            command_rows = (left - 5).min(command_wrapped.len());
            if command_wrapped.len() > command_rows {
                // The leading marker rides inside the block's own budget:
                // the clip never overspends the viewport.
                command_rows = command_rows.saturating_sub(1).max(1);
                command_clipped = true;
            }
            left -= 2 + command_rows;
        }
        let output_rows = left.saturating_sub(2).max(if left >= 3 { 1 } else { 0 });
        if command_rows > 0 {
            lines.push(Vec::new());
            lines.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Dim, "Command".to_string()),
            ]);
            if command_clipped {
                lines.push(vec![
                    Span::raw("  "),
                    theme.fg_span(ThemeColor::Dim, "\u{2026}".to_string()),
                ]);
            }
            for line in command_wrapped[..command_rows].iter() {
                let mut row = vec![Span::raw("  ")];
                row.extend(line.iter().cloned());
                lines.push(truncate_line(&row, width, ""));
            }
        }
        if pairs_rows > 0 {
            lines.push(Vec::new());
            lines.extend(detail_block_lines(theme, width, &pairs[..pairs_rows]));
        }
        // The output block: the fetched tail, a fetching note while the
        // tail is in flight, or the empty-output note once it landed.
        if output_rows > 0 {
            lines.push(Vec::new());
            lines.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Dim, "Output".to_string()),
            ]);
            let tail = self
                .output_tail
                .as_ref()
                .filter(|(tail_id, _)| tail_id == id);
            match tail {
                Some((_, output)) if !output.is_empty() => {
                    // The fetched tail is already the newest window: a
                    // short viewport drops the OLDEST lines (the leading
                    // marker says so), never the newest output.
                    let mut shown = output.len().min(output_rows);
                    let mut clipped = false;
                    if output.len() > shown && shown > 1 {
                        shown -= 1;
                        clipped = true;
                    }
                    if clipped {
                        lines.push(vec![
                            Span::raw("  "),
                            theme.fg_span(ThemeColor::Dim, "\u{2026}".to_string()),
                        ]);
                    }
                    for line in output[output.len() - shown..].iter() {
                        lines.push(truncate_line(
                            &vec![
                                Span::raw("  "),
                                theme.fg_span(ThemeColor::Muted, line.clone()),
                            ],
                            width,
                            "",
                        ));
                    }
                }
                Some((_, _)) => lines.push(vec![
                    Span::raw("  "),
                    theme.fg_span(ThemeColor::Dim, "No output yet".to_string()),
                ]),
                None => lines.push(vec![
                    Span::raw("  "),
                    theme.fg_span(ThemeColor::Dim, "Fetching output\u{2026}".to_string()),
                ]),
            }
        }
        if !actions.is_empty() {
            lines.push(Vec::new());
            for (index, (label, description)) in actions.iter().enumerate() {
                lines.push(action_row(
                    theme,
                    width,
                    label,
                    description,
                    index == action_index,
                ));
            }
        }
        lines.extend(self.pane_footer(theme, width, &self.detail_hint(kb)));
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

    /// The pane footer: the error row, a blank, the hint line, the
    /// bottom border.
    fn pane_footer(&self, theme: &Theme, width: usize, hint: &str) -> Vec<Line> {
        let mut lines = Vec::new();
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
    /// status word in its status color. The selected row's wash hugs the
    /// columns plus a little trailing pad.
    fn activity_row(
        &self,
        theme: &Theme,
        width: usize,
        activity: &BashActivity,
        selected: bool,
    ) -> Line {
        let status_color = if activity.running() {
            ThemeColor::Success
        } else {
            ThemeColor::Dim
        };
        let mut row = vec![Span::raw(if selected { "\u{203a}" } else { " " })];
        row.push(Span::raw(" "));
        let command = plain_cell(&single_line(&activity.command), self.command);
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

/// The detail drill-in's labeled pairs.
fn detail_pairs(activity: &BashActivity) -> Vec<(&'static str, String)> {
    let mut pairs = Vec::new();
    if let Some(pid) = activity.pid {
        pairs.push(("pid", pid.to_string()));
    }
    if let Some(started) = activity.started_at.as_deref() {
        pairs.push((
            "started",
            crate::heartbeats_picker::format_timestamp(started),
        ));
    }
    if let Some(ms) = activity.duration_ms {
        pairs.push(("duration", format!("{ms}ms")));
    }
    if let Some(code) = activity.exit_code {
        pairs.push(("exit", code.to_string()));
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

/// `single_line`: collapse all whitespace runs to single spaces.
fn single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Keep every fetched line inert as terminal text: process-provided
/// strings never forward control characters into the UI — but the
/// line's own leading and trailing spacing stays exactly as the kernel
/// wrote it (indented logs and fixed-width rows keep their shape).
fn clean_line(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
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

    fn frame_text(frame: &[Line]) -> Vec<String> {
        frame
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect()
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
            .any(|row| row.contains("↑/↓ move · Enter open · Esc close")));
        for line in &frame {
            assert!(crate::width::spans_width(line) <= 70);
        }
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

    /// Enter on a list row opens the detail drill-in and asks the host
    /// for the output tail; Enter on the cancel action runs the kill.
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
                id: "a".to_string(),
                action_index: 0
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

    /// The drill-in renders the exact command, the labeled facts, the
    /// fetched output, and the cancel action in the `/mcp` pattern.
    #[test]
    fn the_detail_renders_command_output_and_actions() {
        let mut view = BashView::new(activities(), 40);
        view.handle_key("enter", &kb());
        // The tail lands for the open row.
        view.set_output(
            "a",
            "line one\n\x1b[31mred\x1b[0m\nline three",
            view.detail_generation,
        );
        let frame = view.render(&theme(), 70, &kb());
        let text = frame_text(&frame);
        let joined = text.join("\n");
        // The exact command renders in full (not the column's truncation).
        assert!(joined.contains("cargo build --release"));
        // The labeled facts.
        assert!(text
            .iter()
            .any(|row| row.starts_with("  pid") && row.contains("42")));
        assert!(text
            .iter()
            .any(|row| row.starts_with("  duration") && row.contains("3412ms")));
        // The output renders, control characters scrubbed.
        assert!(joined.contains("line one"));
        assert!(joined.contains("red"));
        assert!(!joined.contains("\x1b"));
        // The action row.
        assert!(text.iter().any(|row| row.contains("Cancel command")));
        assert!(text
            .iter()
            .any(|row| row.contains("Terminate the running process")));
        assert!(text
            .iter()
            .any(|row| row.contains("↑/↓ move · Enter run · ← back · Esc close")));
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

    /// The clipped tail drops the OLDEST lines: the newest output always
    /// renders, with a leading marker for the hidden head.
    #[test]
    fn a_clipped_tail_keeps_the_newest_lines() {
        let mut catalog = activities();
        catalog[0].command = "run"; // short command, long output
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

    #[test]
    fn durations_format_compactly() {
        assert_eq!(format_duration(None), "\u{2014}");
        assert_eq!(format_duration(Some(780)), "780ms");
        assert_eq!(format_duration(Some(3_412)), "3.4s");
        assert_eq!(format_duration(Some(125_000)), "2m 05s");
    }
}
