//! The unified activity panel opened from the dock: every live activity of
//! this session in one grouped list (Subagents, Goals, Heartbeats, Bash)
//! with a detail pane for the selected row. Pure presentation and
//! selection: the host feeds the typed sources, owns the refresh cadence,
//! and executes the requested actions — this view owns no IO.

use pa_types::goal::GoalState;
use serde_json::Value;

use crate::heartbeats_picker::{session_label, HeartbeatEntry};
use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::{menu_list_layout, menu_row_trailing};
use crate::subagents::{descendant_entries, entry_status, SessionIdentity};
use crate::theme::{Theme, ThemeColor};
use crate::width::{str_width, truncate_line};
use crate::{Line, Span};
use pa_types::daemon::agent_roster::AgentRosterStatus;

const PREFERRED_VISIBLE: usize = 8;
// rule, title+counts, blank, blank, detail block, blank, hint, rule.
const RESERVED_ROWS: usize = 7;
/// The detail pane's per-row line budget (a fetched bash tail rides it).
const MAX_DETAIL_LINES: usize = 5;
const MAX_TAIL_LINES: usize = 3;

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

/// Which group a panel row belongs to; the declaration order is the
/// render order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityPanelGroup {
    Subagents,
    Goals,
    Heartbeats,
    Bash,
}

impl ActivityPanelGroup {
    fn label(self) -> &'static str {
        match self {
            ActivityPanelGroup::Subagents => "Subagents",
            ActivityPanelGroup::Goals => "Goals",
            ActivityPanelGroup::Heartbeats => "Heartbeats",
            ActivityPanelGroup::Bash => "Bash",
        }
    }
}

/// One selectable activity row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityPanelRow {
    pub group: ActivityPanelGroup,
    /// The source's opaque id (roster active session, goal id, job id,
    /// kernel bash id); never interpreted by the panel.
    pub id: String,
    pub label: String,
    pub status: String,
    /// Whether the row's source is doing something right now (a running
    /// subagent, an active heartbeat, a live bash process): idle rows
    /// render dimmed so a long quiet roster never reads as uniformly
    /// busy.
    pub active: bool,
    /// The detail pane's labeled lines for this row: `(label, value)`.
    pub detail: Vec<(&'static str, String)>,
    /// A running kernel bash row the `k` action may kill.
    pub killable: bool,
}

/// The actions the host executes. `ViewBashOutput` requests a bounded tail
/// via `tail_kernel_bash`; deliver it back with `set_bash_tail`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActivityPanelAction {
    Close,
    /// Open the group's management view; `selected_id` carries the panel's
    /// chosen row so the destination view opens on it (the heartbeat
    /// picker preselects; the agents view has no row preselection).
    OpenGroup {
        group: ActivityPanelGroup,
        selected_id: Option<String>,
    },
    ViewBashOutput {
        id: String,
    },
    KillBash {
        id: String,
    },
    None,
}

/// The four live feeds the panel builds its rows from.
pub struct ActivityPanelSources<'a> {
    pub roster: &'a [Value],
    pub identity: &'a SessionIdentity,
    pub goal: &'a GoalState,
    pub heartbeats: &'a [HeartbeatEntry],
    pub bash: &'a Value,
}

#[derive(Debug)]
pub struct ActivityPanel {
    rows: Vec<ActivityPanelRow>,
    groups: Vec<ActivityPanelGroup>,
    selected: usize,
    bash_tail: Option<(String, Vec<String>)>,
    viewport_rows: usize,
}

impl ActivityPanel {
    pub fn new(
        sources: &ActivityPanelSources<'_>,
        initial_group: Option<ActivityPanelGroup>,
        viewport_rows: usize,
    ) -> Self {
        let (rows, groups) = build_rows(sources);
        let mut selected = 0;
        if let Some(group) = initial_group {
            if let Some(position) = rows.iter().position(|row| row.group == group) {
                selected = position;
            }
        }
        Self {
            rows,
            groups,
            selected,
            bash_tail: None,
            viewport_rows,
        }
    }

    /// Rebuild the rows from fresh sources, keeping the selection on the
    /// same (group, id) pair when it survives; otherwise the first row of
    /// the same group, else the nearest remaining row.
    pub fn apply_sources(&mut self, sources: &ActivityPanelSources<'_>) {
        let previous = self.rows.get(self.selected).cloned();
        let (rows, groups) = build_rows(sources);
        self.rows = rows;
        self.groups = groups;
        self.selected = match previous {
            Some(previous) => self
                .rows
                .iter()
                .position(|row| row.group == previous.group && row.id == previous.id)
                .or_else(|| self.rows.iter().position(|row| row.group == previous.group))
                .unwrap_or(self.selected.min(self.rows.len().saturating_sub(1))),
            None => 0,
        };
        if self.bash_tail.as_ref().is_some_and(|(id, _)| {
            !self
                .rows
                .get(self.selected)
                .is_some_and(|row| row.group == ActivityPanelGroup::Bash && &row.id == id)
        }) {
            self.bash_tail = None;
        }
    }

    pub fn selected_row(&self) -> Option<&ActivityPanelRow> {
        self.rows.get(self.selected)
    }

    /// Store only the most recent bounded tail for the selected bash row.
    pub fn set_bash_tail(&mut self, id: &str, tail: &str) {
        let selected_bash = self
            .rows
            .get(self.selected)
            .filter(|row| row.group == ActivityPanelGroup::Bash);
        if selected_bash.is_some_and(|row| row.id == id) {
            let mut lines: Vec<String> = tail
                .lines()
                .rev()
                .take(MAX_TAIL_LINES)
                .map(clean_line)
                .collect();
            lines.reverse();
            self.bash_tail = Some((id.to_string(), lines));
        }
    }

    fn group_positions(&self, group: ActivityPanelGroup) -> Option<(usize, usize)> {
        let start = self.rows.iter().position(|row| row.group == group)?;
        let end = self
            .rows
            .iter()
            .rposition(|row| row.group == group)
            .map(|end| end + 1)?;
        Some((start, end))
    }

    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> ActivityPanelAction {
        // Group jumps take the raw left/right first: the default
        // `app.modal.back` binding is also `left`, and a group list
        // navigates instead of closing (the dock does the same).
        if key == "left" || key == "right" {
            let current = self
                .rows
                .get(self.selected)
                .and_then(|row| self.groups.iter().position(|group| *group == row.group));
            let next = match (key, current) {
                ("left", Some(index)) if index > 0 => self.groups[..index].last().copied(),
                ("right", Some(index)) if index + 1 < self.groups.len() => {
                    self.groups.get(index + 1).copied()
                }
                _ => None,
            };
            if let Some(group) = next {
                self.selected = self.group_positions(group).map_or(0, |(start, _)| start);
                self.bash_tail = None;
            }
            return ActivityPanelAction::None;
        }
        if key == "ctrl+c"
            || kb.matches(key, "tui.select.cancel")
            || kb.matches(key, "app.modal.back")
        {
            return ActivityPanelAction::Close;
        }
        let delta = if kb.matches(key, "tui.select.up") {
            -1isize
        } else if kb.matches(key, "tui.select.down") {
            1
        } else {
            0
        };
        if delta != 0 && !self.rows.is_empty() {
            let next =
                (self.selected as isize + delta).clamp(0, self.rows.len() as isize - 1) as usize;
            if next != self.selected {
                self.selected = next;
                self.bash_tail = None;
            }
            return ActivityPanelAction::None;
        }
        let Some(row) = self.rows.get(self.selected) else {
            return ActivityPanelAction::None;
        };
        if key == "k" {
            return if row.killable {
                ActivityPanelAction::KillBash { id: row.id.clone() }
            } else {
                ActivityPanelAction::None
            };
        }
        if kb.matches(key, "tui.select.confirm") {
            return match row.group {
                ActivityPanelGroup::Subagents | ActivityPanelGroup::Heartbeats => {
                    ActivityPanelAction::OpenGroup {
                        group: row.group,
                        selected_id: Some(row.id.clone()),
                    }
                }
                // The goal group is read-only: the dock segment and the
                // detail pane carry its state; Enter does nothing.
                ActivityPanelGroup::Goals => ActivityPanelAction::None,
                ActivityPanelGroup::Bash => {
                    ActivityPanelAction::ViewBashOutput { id: row.id.clone() }
                }
            };
        }
        ActivityPanelAction::None
    }

    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        let border =
            || vec![theme.fg_span(ThemeColor::BorderMuted, "\u{2500}".repeat(width.max(1)))];
        let text = |color, value: String| {
            truncate_line(
                &vec![Span::raw("  "), theme.fg_span(color, value)],
                width,
                "",
            )
        };
        // The title carries the live count (the picker idiom: one plain
        // heading line, no accent color, no separate subtitle).
        let mut title = vec![
            Span::raw("  "),
            theme.fg_span(ThemeColor::Text, "Activity".to_string()),
        ];
        title.push(theme.fg_span(
            ThemeColor::Muted,
            format!(" \u{00b7} {} live", self.rows.len()),
        ));
        let mut lines = vec![border(), truncate_line(&title, width, "")];
        lines.push(Vec::new());
        let list_entries = self.rows.len() + self.groups.len();
        let visible = menu_list_layout(
            Some(self.viewport_rows),
            PREFERRED_VISIBLE,
            list_entries,
            RESERVED_ROWS + self.detail_budget(),
            1,
        );
        // The list window over the interleaved headers and rows, centered
        // on the selection.
        let selected_entry = self.selected
            + self
                .groups
                .iter()
                .filter(|group| {
                    self.rows
                        .iter()
                        .position(|row| row.group == **group)
                        .is_some_and(|start| start <= self.selected)
                })
                .count();
        let start = selected_entry
            .saturating_sub(visible / 2)
            .min(list_entries.saturating_sub(visible));
        let mut cursor = 0usize;
        let mut last_group: Option<ActivityPanelGroup> = None;
        for (row_index, row) in self.rows.iter().enumerate() {
            if last_group != Some(row.group) {
                let header_in_window = cursor >= start && cursor < start + visible;
                if header_in_window {
                    lines.push(group_header(theme, width, row.group, &self.rows));
                }
                cursor += 1;
                if cursor >= start + visible {
                    break;
                }
                last_group = Some(row.group);
            }
            if cursor >= start && cursor < start + visible {
                // Idle rows render dimmed; only actively running sources
                // read at full strength.
                let primary = if row.active {
                    vec![Span::raw(clean_line(&row.label))]
                } else {
                    vec![theme.fg_span(ThemeColor::Dim, clean_line(&row.label))]
                };
                let trailing = vec![(status_color(row), clean_line(&row.status))];
                lines.push(menu_row_trailing(
                    theme,
                    width,
                    primary,
                    &trailing,
                    row_index == self.selected,
                ));
            }
            cursor += 1;
            if cursor >= start + visible {
                break;
            }
        }
        if start > 0 || cursor < list_entries {
            lines.push(text(
                ThemeColor::Muted,
                format!("({}/{})", self.selected + 1, self.rows.len()),
            ));
        }
        lines.push(Vec::new());
        if let Some(row) = self.rows.get(self.selected) {
            // The detail pairs and the fetched tail share one budget: a
            // collapsed viewport never overspends it (the tail is the
            // explicitly requested output, so the pairs give way first;
            // the heading and its lines never draw past the budget).
            let budget = self.detail_budget();
            let tail = self.bash_tail.as_ref().filter(|(id, _)| {
                self.rows
                    .get(self.selected)
                    .is_some_and(|row| row.group == ActivityPanelGroup::Bash && &row.id == id)
            });
            let tail_rows = tail
                .map(|(_, tail)| 1 + tail.len().min(MAX_TAIL_LINES))
                .unwrap_or(0);
            let detail_rows = budget.saturating_sub(tail_rows).min(MAX_DETAIL_LINES);
            lines.extend(detail_lines(theme, width, row, detail_rows));
            if let Some((_, tail)) = tail {
                // A zero budget renders no tail at all: the heading itself
                // would spend a line the frame needs on a short viewport.
                let tail_budget = budget.saturating_sub(detail_rows);
                if tail_budget > 0 {
                    lines.push(text(ThemeColor::Muted, "Output tail".to_string()));
                    for output in tail.iter().take(tail_budget.saturating_sub(1)) {
                        lines.push(text(ThemeColor::Muted, output.clone()));
                    }
                }
            }
        }
        lines.push(Vec::new());
        // One bottom hint line carries every shortcut (the close key never
        // repeats on a second row).
        let close_key = kb
            .get_keys("tui.select.cancel")
            .first()
            .map(|key| format_key_text(key))
            .unwrap_or_else(|| "Esc".to_string());
        let kill_hint = if self.rows.iter().any(|row| row.killable) {
            " \u{00b7} k kill".to_string()
        } else {
            String::new()
        };
        lines.push(text(
            ThemeColor::Dim,
            format!(
                "\u{2191}\u{2193} move \u{00b7} \u{2190}\u{2192} group \u{00b7} Enter open{kill_hint} \u{00b7} {close_key} close"
            ),
        ));
        lines.push(border());
        lines
    }

    fn detail_budget(&self) -> usize {
        // The full detail area (pairs plus a fetched bash tail) shrinks
        // on short viewports so the pane never clips: the frame rows and
        // at least one list row always render first.
        let full = MAX_DETAIL_LINES
            + self
                .bash_tail
                .as_ref()
                // The rendered heading plus the bounded tail lines.
                .map(|(_, tail)| 1 + tail.len().min(MAX_TAIL_LINES))
                .unwrap_or(0);
        // No forced minimum: a viewport with no room for the detail block
        // renders zero detail rows rather than clipping the hint and the
        // border (the block yields to the frame and at least one list
        // row, which the layout reserves first).
        full.min(self.viewport_rows.saturating_sub(RESERVED_ROWS + 2))
    }
}

/// The status word's color (the TS summary box's status colors: running
/// success, idle warning, inactive dim; paused heartbeats read as
/// warning like the heartbeat manager's rows).
fn status_color(row: &ActivityPanelRow) -> ThemeColor {
    match row.group {
        ActivityPanelGroup::Subagents => match row.status.as_str() {
            "running" => ThemeColor::Success,
            "idle" => ThemeColor::Warning,
            _ => ThemeColor::Dim,
        },
        ActivityPanelGroup::Heartbeats => {
            if row.status == "active" {
                ThemeColor::Success
            } else {
                ThemeColor::Warning
            }
        }
        ActivityPanelGroup::Bash => {
            if row.status == "running" {
                ThemeColor::Success
            } else {
                ThemeColor::Dim
            }
        }
        ActivityPanelGroup::Goals => ThemeColor::Success,
    }
}

/// One group header: the plain-text label with the group's status counts
/// trailing flush right, so a long roster reads as `2 running · 93 idle`
/// before a single row is inspected (TS `renderList` section headings
/// carry their counts; the box body uses the same status colors).
fn group_header(
    theme: &Theme,
    width: usize,
    group: ActivityPanelGroup,
    rows: &[ActivityPanelRow],
) -> Line {
    let count = |status: &str| {
        rows.iter()
            .filter(|row| row.group == group && row.status == status)
            .count()
    };
    let mut counts: Vec<(ThemeColor, String)> = Vec::new();
    match group {
        ActivityPanelGroup::Subagents => {
            let buckets = [
                ("running", ThemeColor::Success),
                ("idle", ThemeColor::Warning),
                ("inactive", ThemeColor::Dim),
            ];
            for (status, color) in buckets {
                let n = count(status);
                if n > 0 {
                    counts.push((color, format!("{n} {status}")));
                }
            }
        }
        ActivityPanelGroup::Heartbeats => {
            for (status, color) in [
                ("active", ThemeColor::Success),
                ("paused", ThemeColor::Warning),
            ] {
                let n = count(status);
                if n > 0 {
                    counts.push((color, format!("{n} {status}")));
                }
            }
        }
        ActivityPanelGroup::Bash => {
            let n = count("running");
            if n > 0 {
                counts.push((ThemeColor::Success, format!("{n} running")));
            }
        }
        // The goal group is a single row: its own status trail carries it.
        ActivityPanelGroup::Goals => {}
    }
    let mut line = vec![
        Span::raw("  "),
        theme.fg_span(ThemeColor::Text, group.label().to_string()),
    ];
    if counts.is_empty() {
        return truncate_line(&line, width, "");
    }
    let joined_width = counts
        .iter()
        .map(|(_, text)| str_width(text) + 3)
        .sum::<usize>()
        .saturating_sub(3);
    let gap = width
        .saturating_sub(2 + group.label().chars().count() + 2 + joined_width)
        .max(2);
    line.push(Span::raw(" ".repeat(gap)));
    for (index, (color, text)) in counts.iter().enumerate() {
        if index > 0 {
            line.push(theme.fg_span(ThemeColor::Muted, " \u{b7} ".to_string()));
        }
        line.push(theme.fg_span(*color, text.clone()));
    }
    truncate_line(&line, width, "")
}

/// The selected row's detail block: `(label, value)` pairs as an aligned
/// two-column block — the dim label column against muted values (the
/// `/model` picker's price block idiom), instead of a metadata run-on.
fn detail_lines(theme: &Theme, width: usize, row: &ActivityPanelRow, cap: usize) -> Vec<Line> {
    let details = row
        .detail
        .iter()
        .take(cap.min(MAX_DETAIL_LINES))
        .map(|(label, value)| (label, clean_line(value)))
        .collect::<Vec<_>>();
    if details.is_empty() {
        return Vec::new();
    }
    let label_width = details
        .iter()
        .map(|(label, _)| label.chars().count())
        .max()
        .unwrap_or(0)
        .min(20);
    details
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

/// Keep every row one line and inert as terminal text: process-provided
/// and roster strings never forward control characters into the UI.
fn clean_line(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

fn summary_str<'a>(summary: &'a Value, field: &str) -> Option<&'a str> {
    summary
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn subagent_rows(sources: &ActivityPanelSources<'_>) -> Vec<ActivityPanelRow> {
    descendant_entries(sources.roster, sources.identity)
        .into_iter()
        .map(|entry| {
            let summary = entry.get("summary").cloned().unwrap_or(Value::Null);
            let label = summary_str(&summary, "sessionName")
                .map(str::to_string)
                .or_else(|| {
                    summary_str(&summary, "firstMessage")
                        .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
                })
                .unwrap_or_else(|| {
                    summary_str(&summary, "activeSessionId")
                        .map(|id| id.chars().take(8).collect::<String>())
                        .or_else(|| summary_str(&summary, "sessionId").map(str::to_string))
                        .unwrap_or_else(|| "subagent".to_string())
                });
            let status = match entry_status(entry) {
                AgentRosterStatus::Running => "running",
                AgentRosterStatus::Idle => "idle",
                AgentRosterStatus::Inactive => "inactive",
            }
            .to_string();
            let mut detail = vec![("status", status.clone())];
            if let Some(activity) = summary_str(&summary, "activity") {
                detail.push(("activity", activity.to_string()));
            }
            if let Some(model) = summary.get("model") {
                let mut model_label = format!(
                    "{}/{}",
                    summary_str(model, "provider").unwrap_or_default(),
                    summary_str(model, "modelId").unwrap_or_default()
                );
                if let Some(level) = summary_str(&summary, "thinkingLevel") {
                    model_label.push_str(&format!(":{level}"));
                }
                detail.push(("model", model_label));
            }
            if let Some(cwd) = summary_str(&summary, "cwd") {
                detail.push(("cwd", cwd.to_string()));
            }
            ActivityPanelRow {
                group: ActivityPanelGroup::Subagents,
                id: summary_str(&summary, "activeSessionId")
                    .or_else(|| summary_str(&summary, "sessionId"))
                    .unwrap_or_default()
                    .to_string(),
                label,
                active: status == "running",
                status,
                detail,
                killable: false,
            }
        })
        .collect()
}

fn goal_rows(sources: &ActivityPanelSources<'_>) -> Vec<ActivityPanelRow> {
    let goal = sources.goal;
    // Only an actively pursued goal is a live activity: a completed or
    // error goal's token totals are bookkeeping, not something to act on
    // (the tray's TS label still narrates paused and budget-limited).
    (goal.status == pa_types::goal::GoalStatus::Active)
        .then(|| {
            let mut detail = vec![("status", goal.status.slug().to_string())];
            if let Some(objective) = goal
                .objective
                .as_deref()
                .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|text| !text.is_empty())
            {
                detail.push(("objective", objective));
            }
            detail.push(match goal.token_budget {
                Some(budget) => (
                    "tokens",
                    format!(
                        "{} / {}",
                        crate::chrome::format_token_count(goal.tokens_used),
                        crate::chrome::format_token_count(budget)
                    ),
                ),
                None => (
                    "tokens",
                    crate::chrome::format_token_count(goal.tokens_used),
                ),
            });
            if let Some(reason) = goal.last_reason.as_deref().filter(|text| !text.is_empty()) {
                detail.push(("last reason", reason.to_string()));
            }
            ActivityPanelRow {
                group: ActivityPanelGroup::Goals,
                id: goal.goal_id.clone().unwrap_or_else(|| "goal".to_string()),
                label: "goal".to_string(),
                active: true,
                status: goal.status.slug().to_string(),
                detail,
                killable: false,
            }
        })
        .into_iter()
        .collect()
}

fn heartbeat_rows(sources: &ActivityPanelSources<'_>) -> Vec<ActivityPanelRow> {
    sources
        .heartbeats
        .iter()
        .map(|entry| {
            let label = entry
                .job
                .label
                .clone()
                .unwrap_or_else(|| session_label(entry));
            let mut detail = vec![
                (
                    "created",
                    crate::heartbeats_picker::source_label(entry).to_string(),
                ),
                ("schedule", entry.job.schedule_expression.clone()),
                (
                    "delivery",
                    match entry.job.delivery_mode.as_deref() {
                        Some("follow_up") => "follow-up",
                        _ => "steer",
                    }
                    .to_string(),
                ),
            ];
            if let Some(next) = entry.job.next_run_at.as_deref() {
                detail.push(("next run", crate::heartbeats_picker::format_timestamp(next)));
            }
            if let Some(error) = entry
                .job
                .last_error
                .as_deref()
                .filter(|text| !text.is_empty())
            {
                detail.push(("last error", error.to_string()));
            }
            ActivityPanelRow {
                group: ActivityPanelGroup::Heartbeats,
                id: entry.job.id.clone(),
                label,
                active: entry.job.status == "active",
                status: entry.job.status.clone(),
                detail,
                killable: false,
            }
        })
        .collect()
}

fn bash_rows(sources: &ActivityPanelSources<'_>) -> Vec<ActivityPanelRow> {
    parse_bash_activities(sources.bash)
        .into_iter()
        .map(|activity| {
            let running = activity.running();
            let mut detail = Vec::new();
            if let Some(pid) = activity.pid {
                detail.push(("pid", pid.to_string()));
            }
            if let Some(started) = activity.started_at.as_deref() {
                detail.push((
                    "started",
                    crate::heartbeats_picker::format_timestamp(started),
                ));
            }
            if let Some(ms) = activity.duration_ms {
                detail.push(("duration", format!("{ms}ms")));
            }
            if let Some(code) = activity.exit_code {
                detail.push(("exit", code.to_string()));
            }
            ActivityPanelRow {
                group: ActivityPanelGroup::Bash,
                id: activity.id,
                label: activity.command,
                active: running,
                status: if running {
                    "running".to_string()
                } else {
                    activity.status
                },
                detail,
                killable: running,
            }
        })
        .collect()
}

fn build_rows(
    sources: &ActivityPanelSources<'_>,
) -> (Vec<ActivityPanelRow>, Vec<ActivityPanelGroup>) {
    let sections = [
        (ActivityPanelGroup::Subagents, subagent_rows(sources)),
        (ActivityPanelGroup::Goals, goal_rows(sources)),
        (ActivityPanelGroup::Heartbeats, heartbeat_rows(sources)),
        (ActivityPanelGroup::Bash, bash_rows(sources)),
    ];
    let mut rows = Vec::new();
    let mut groups = Vec::new();
    for (group, section) in sections {
        if !section.is_empty() {
            groups.push(group);
            rows.extend(section);
        }
    }
    (rows, groups)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keybindings::KeybindingsManager;
    use crate::theme::{ColorMode, Theme};
    use pa_types::goal::{GoalState, GoalStatus};
    use serde_json::json;

    fn entry(job: &Value) -> HeartbeatEntry {
        crate::heartbeats_picker::parse_heartbeat_job(job)
            .map(|job| HeartbeatEntry {
                job,
                session_name: None,
                first_message: None,
            })
            .expect("job parses")
    }

    fn goal(active: bool) -> GoalState {
        GoalState {
            active,
            status: if active {
                GoalStatus::Active
            } else {
                GoalStatus::Idle
            },
            tokens_used: 18_000,
            token_budget: Some(40_000),
            ..GoalState::default()
        }
    }

    fn roster() -> Vec<Value> {
        vec![
            json!({
                "agentId": "a1",
                "status": "running",
                "summary": {
                    "runtimeKind": "subagent",
                    "lifecycle": "live",
                    "parentActiveSessionId": "root",
                    "activeSessionId": "child-1",
                    "sessionName": "worker-a",
                    "activity": "working",
                    "model": {"provider": "p", "modelId": "m"},
                    "thinkingLevel": "high",
                    "cwd": "/tmp/project"
                }
            }),
            json!({
                "agentId": "a2",
                "status": "idle",
                "summary": {
                    "runtimeKind": "subagent",
                    "lifecycle": "live",
                    "parentActiveSessionId": "root",
                    "activeSessionId": "child-2",
                    "firstMessage": "fix the bug"
                }
            }),
        ]
    }

    fn bash() -> Value {
        json!({"activities": [
            {"id":"a","command":"sleep 9","pid":42,"startedAt":"2026-09-22T01:00:00Z","status":"running"},
            {"id":"b","command":"echo hi","status":"finished","exitCode":0,"durationMs":123},
        ]})
    }

    fn heartbeats() -> Vec<HeartbeatEntry> {
        vec![entry(&json!({
            "id": "hb1",
            "status": "active",
            "source": "heartbeat",
            "activeSessionId": "root",
            "sessionId": "s1",
            "label": "build-check",
            "schedule": {"kind": "interval", "expression": "every 30m"},
        }))]
    }

    fn sources<'a>(
        identity: &'a SessionIdentity,
        roster: &'a [Value],
        goal: &'a GoalState,
        heartbeats: &'a [HeartbeatEntry],
        bash: &'a Value,
    ) -> ActivityPanelSources<'a> {
        ActivityPanelSources {
            roster,
            identity,
            goal,
            heartbeats,
            bash,
        }
    }

    fn identity() -> SessionIdentity {
        SessionIdentity::new(Some("root".to_string()), None, None)
    }

    fn full_sources() -> (Vec<Value>, GoalState, Vec<HeartbeatEntry>, Value) {
        (roster(), goal(true), heartbeats(), bash())
    }

    #[test]
    fn builds_grouped_rows_from_all_four_feeds() {
        let (roster, goal, heartbeats, bash) = full_sources();
        let identity = identity();
        let src = sources(&identity, &roster, &goal, &heartbeats, &bash);
        let panel = ActivityPanel::new(&src, None, 16);
        let groups: Vec<_> = panel.rows.iter().map(|row| row.group).collect();
        assert_eq!(
            groups,
            vec![
                ActivityPanelGroup::Subagents,
                ActivityPanelGroup::Subagents,
                ActivityPanelGroup::Goals,
                ActivityPanelGroup::Heartbeats,
                ActivityPanelGroup::Bash,
                ActivityPanelGroup::Bash,
            ]
        );
        assert_eq!(panel.groups.len(), 4);
        let worker = &panel.rows[0];
        assert_eq!(worker.label, "worker-a");
        assert_eq!(worker.status, "running");
        assert!(worker.active, "a running subagent is an active row");
        assert!(worker.detail.contains(&("model", "p/m:high".to_string())));
        assert!(worker.detail.contains(&("cwd", "/tmp/project".to_string())));
        let unnamed = &panel.rows[1];
        assert_eq!(unnamed.label, "fix the bug");
        assert!(!unnamed.active, "an idle subagent renders dimmed");
        let goal_row = &panel.rows[2];
        assert_eq!(goal_row.status, "active");
        assert!(goal_row
            .detail
            .contains(&("tokens", "18k / 40k".to_string())));
        let heartbeat_row = &panel.rows[3];
        assert_eq!(heartbeat_row.label, "build-check");
        assert!(heartbeat_row
            .detail
            .contains(&("schedule", "every 30m".to_string())));
        let running_bash = &panel.rows[4];
        assert_eq!(running_bash.status, "running");
        assert!(running_bash.killable);
        assert!(running_bash.detail.contains(&("pid", "42".to_string())));
        let finished_bash = &panel.rows[5];
        assert!(!finished_bash.killable);
        assert!(finished_bash.detail.contains(&("exit", "0".to_string())));
    }

    #[test]
    fn empty_groups_are_omitted_and_non_active_goals_hide() {
        let roster = Vec::new();
        let heartbeats = Vec::new();
        let bash = json!({"activities": []});
        let identity = identity();
        for status in [
            pa_types::goal::GoalStatus::Idle,
            pa_types::goal::GoalStatus::Complete,
            pa_types::goal::GoalStatus::Error,
        ] {
            let mut goal = goal(false);
            goal.status = status;
            let src = sources(&identity, &roster, &goal, &heartbeats, &bash);
            let panel = ActivityPanel::new(&src, None, 16);
            assert!(
                panel.rows.is_empty() && panel.groups.is_empty(),
                "{status:?} is bookkeeping, not a live activity"
            );
        }
    }

    #[test]
    fn initial_group_selects_that_groups_first_row() {
        let (roster, goal, heartbeats, bash) = full_sources();
        let identity = identity();
        let src = sources(&identity, &roster, &goal, &heartbeats, &bash);
        let panel = ActivityPanel::new(&src, Some(ActivityPanelGroup::Bash), 16);
        assert_eq!(
            panel.selected_row().map(|row| row.group),
            Some(ActivityPanelGroup::Bash)
        );
        // An empty or unknown initial group falls back to the first row.
        let panel = ActivityPanel::new(&src, Some(ActivityPanelGroup::Goals), 16);
        assert_eq!(panel.selected, 2);
    }

    #[test]
    fn keys_move_select_jump_groups_and_act_in_place() {
        let (roster, goal, heartbeats, bash) = full_sources();
        let identity = identity();
        let src = sources(&identity, &roster, &goal, &heartbeats, &bash);
        let mut panel = ActivityPanel::new(&src, None, 16);
        let kb = KeybindingsManager::new();
        assert_eq!(panel.handle_key("down", &kb), ActivityPanelAction::None);
        assert_eq!(panel.selected, 1);
        // Right jumps to the next group's first row (Goals).
        assert_eq!(panel.handle_key("right", &kb), ActivityPanelAction::None);
        assert_eq!(
            panel.selected_row().map(|row| row.group),
            Some(ActivityPanelGroup::Goals)
        );
        // Enter on the read-only goal row does nothing.
        assert_eq!(panel.handle_key("enter", &kb), ActivityPanelAction::None);
        // Right twice lands on the Bash group; Enter fetches the output.
        panel.handle_key("right", &kb);
        panel.handle_key("right", &kb);
        assert_eq!(
            panel.selected_row().map(|row| row.group),
            Some(ActivityPanelGroup::Bash)
        );
        assert_eq!(
            panel.handle_key("enter", &kb),
            ActivityPanelAction::ViewBashOutput { id: "a".into() }
        );
        // k kills only the running bash row.
        assert_eq!(
            panel.handle_key("k", &kb),
            ActivityPanelAction::KillBash { id: "a".into() }
        );
        // Left walks back through the groups; Enter opens each group's
        // view and does nothing on the read-only goal row.
        panel.handle_key("left", &kb);
        assert_eq!(
            panel.handle_key("enter", &kb),
            ActivityPanelAction::OpenGroup {
                group: ActivityPanelGroup::Heartbeats,
                selected_id: Some("hb1".into())
            }
        );
        panel.handle_key("left", &kb);
        assert_eq!(panel.handle_key("enter", &kb), ActivityPanelAction::None);
        panel.handle_key("left", &kb);
        assert_eq!(
            panel.handle_key("enter", &kb),
            ActivityPanelAction::OpenGroup {
                group: ActivityPanelGroup::Subagents,
                selected_id: Some("child-1".into())
            }
        );
        assert_eq!(panel.handle_key("escape", &kb), ActivityPanelAction::Close);
    }

    #[test]
    fn k_is_inert_on_non_bash_and_finished_rows() {
        let (roster, goal, heartbeats, bash) = full_sources();
        let identity = identity();
        let src = sources(&identity, &roster, &goal, &heartbeats, &bash);
        let mut panel = ActivityPanel::new(&src, None, 16);
        let kb = KeybindingsManager::new();
        assert_eq!(panel.handle_key("k", &kb), ActivityPanelAction::None);
        panel.handle_key("right", &kb);
        panel.handle_key("right", &kb);
        panel.handle_key("right", &kb);
        panel.handle_key("down", &kb);
        // The finished bash row is not killable.
        assert_eq!(panel.handle_key("k", &kb), ActivityPanelAction::None);
    }

    #[test]
    fn selection_survives_rebuild_by_group_and_id() {
        let (roster, goal, heartbeats, bash) = full_sources();
        let identity = identity();
        let src = sources(&identity, &roster, &goal, &heartbeats, &bash);
        let mut panel = ActivityPanel::new(&src, Some(ActivityPanelGroup::Bash), 16);
        let kb = KeybindingsManager::new();
        panel.handle_key("down", &kb);
        assert_eq!(panel.selected_row().map(|row| row.id.as_str()), Some("b"));
        // Reorder the bash rows: the selection follows the id, not the index.
        let reordered =
            json!({"activities": [bash["activities"][1].clone(), bash["activities"][0].clone()]});
        let src2 = sources(&identity, &roster, &goal, &heartbeats, &reordered);
        panel.apply_sources(&src2);
        assert_eq!(panel.selected_row().map(|row| row.id.as_str()), Some("b"));
        // The id disappearing falls back to the same group's first row.
        let emptied =
            json!({"activities": [json!({"id":"a","command":"sleep 9","status":"running"})]});
        let src3 = sources(&identity, &roster, &goal, &heartbeats, &emptied);
        panel.apply_sources(&src3);
        assert_eq!(panel.selected_row().map(|row| row.id.as_str()), Some("a"));
        // The group disappearing clamps to the nearest remaining row.
        let no_bash = json!({"activities": []});
        let src4 = sources(&identity, &roster, &goal, &heartbeats, &no_bash);
        panel.apply_sources(&src4);
        assert!(panel.selected_row().is_some());
    }

    #[test]
    fn stale_tails_are_ignored_and_cleared_on_selection_change() {
        let (roster, goal, heartbeats, bash) = full_sources();
        let identity = identity();
        let src = sources(&identity, &roster, &goal, &heartbeats, &bash);
        let mut panel = ActivityPanel::new(&src, Some(ActivityPanelGroup::Bash), 16);
        panel.set_bash_tail("wrong", "stale");
        panel.set_bash_tail("a", "one\ntwo\nthree\nfour");
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let kb = KeybindingsManager::new();
        let lines = panel.render(&theme, 60, &kb);
        let rendered = lines
            .iter()
            .flat_map(|line| line.iter())
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert!(rendered.contains("Output tail"));
        assert!(rendered.contains("four"));
        assert!(!rendered.contains("one"), "only the bounded tail renders");
        // Moving the selection clears the tail of the previous row.
        panel.handle_key("down", &kb);
        let lines = panel.render(&theme, 60, &kb);
        let rendered = lines
            .iter()
            .flat_map(|line| line.iter())
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert!(!rendered.contains("Output tail"));
    }

    #[test]
    fn render_shows_group_counts_labeled_detail_and_one_hint() {
        let (roster, goal, heartbeats, bash) = full_sources();
        let identity = identity();
        let src = sources(&identity, &roster, &goal, &heartbeats, &bash);
        let mut panel = ActivityPanel::new(&src, None, 40);
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let kb = KeybindingsManager::new();
        let lines = panel.render(&theme, 80, &kb);
        let rendered = lines
            .iter()
            .flat_map(|line| line.iter())
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert!(rendered.contains("Activity"));
        assert!(rendered.contains("Subagents"));
        assert!(rendered.contains("Goals"));
        assert!(rendered.contains("Heartbeats"));
        assert!(rendered.contains("Bash"));
        // The group headers carry the status counts (active vs idle).
        assert!(rendered.contains("1 running"));
        assert!(rendered.contains("1 idle"));
        assert!(rendered.contains("1 active"));
        assert!(rendered.contains("worker-a"));
        // The detail block is a labeled two-column block, not a
        // metadata run-on.
        assert!(!rendered.contains("Selected"));
        assert!(rendered.contains("status    running"));
        assert!(rendered.contains("activity  working"));
        // Exactly one close hint rides the bottom bar (the close key
        // never repeats on a second row).
        let close_count = lines
            .iter()
            .filter(|line| {
                line.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
                    .contains("Esc close")
            })
            .count();
        assert_eq!(close_count, 1, "one close hint, not two: {rendered}");
        // A short viewport windows the list and shows the position.
        for _ in 0..5 {
            panel.handle_key("down", &kb);
        }
        let lines = panel.render(&theme, 80, &kb);
        let rendered = lines
            .iter()
            .flat_map(|line| line.iter())
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert!(
            rendered.contains("(6/6)"),
            "position indicator shows: {rendered}"
        );
        for line in &lines {
            assert!(
                crate::width::spans_width(line) <= 80,
                "every row fits the width"
            );
        }
    }

    /// A short viewport shrinks the detail block so the pane never
    /// exceeds the terminal budget, and the bottom hint survives.
    #[test]
    fn short_viewports_shrink_the_detail_block() {
        let (roster, goal, heartbeats, bash) = full_sources();
        let identity = identity();
        let src = sources(&identity, &roster, &goal, &heartbeats, &bash);
        let panel = ActivityPanel::new(&src, None, 10);
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let kb = KeybindingsManager::new();
        let lines = panel.render(&theme, 80, &kb);
        assert!(lines.len() <= 10, "viewport 10 fits: {}", lines.len());
        let rendered = lines
            .iter()
            .flat_map(|line| line.iter())
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert!(rendered.contains("Esc close"));
    }

    #[test]
    fn multibyte_ids_never_panic_in_the_label_fallback() {
        // A roster id with multibyte characters has a byte length that no
        // longer licenses byte slicing: the fallback truncates by chars.
        let roster = vec![json!({
            "agentId": "a1",
            "status": "running",
            "summary": {
                "runtimeKind": "subagent",
                "lifecycle": "live",
                "parentActiveSessionId": "root",
                "activeSessionId": "\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}"
            }
        })];
        let goal = goal(false);
        let heartbeats = Vec::new();
        let bash = json!({"activities": []});
        let identity = identity();
        let src = sources(&identity, &roster, &goal, &heartbeats, &bash);
        let panel = ActivityPanel::new(&src, None, 16);
        let row = panel.selected_row().expect("one row");
        assert_eq!(
            row.label,
            "\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}"
        );
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let kb = KeybindingsManager::new();
        let _ = panel.render(&theme, 60, &kb);
    }

    #[test]
    fn boundary_moves_keep_the_fetched_tail() {
        let (roster, goal, heartbeats, bash) = full_sources();
        let identity = identity();
        let src = sources(&identity, &roster, &goal, &heartbeats, &bash);
        let mut panel = ActivityPanel::new(&src, Some(ActivityPanelGroup::Bash), 16);
        let kb = KeybindingsManager::new();
        panel.set_bash_tail("a", "one\ntwo\nthree");
        // Down past the last bash row clamps at the boundary: the selection
        // does not move, so the fetched tail stays.
        panel.handle_key("down", &kb);
        assert_eq!(panel.selected_row().map(|row| row.id.as_str()), Some("b"));
        panel.set_bash_tail("b", "kept");
        panel.handle_key("down", &kb);
        assert_eq!(panel.selected_row().map(|row| row.id.as_str()), Some("b"));
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let lines = panel.render(&theme, 60, &kb);
        let rendered = lines
            .iter()
            .flat_map(|line| line.iter())
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert!(
            rendered.contains("Output tail"),
            "no-op move keeps the tail"
        );
        assert!(rendered.contains("kept"));
    }

    #[test]
    fn a_tail_never_attaches_to_a_non_bash_row_with_the_same_id() {
        // The id namespaces are independent: a subagent's roster id and a
        // kernel bash id can collide, so the cache must match the group too.
        let roster = vec![json!({
            "agentId": "a1",
            "status": "idle",
            "summary": {
                "runtimeKind": "subagent",
                "lifecycle": "live",
                "parentActiveSessionId": "root",
                "activeSessionId": "a",
                "sessionName": "clash"
            }
        })];
        let goal = goal(false);
        let heartbeats = Vec::new();
        let bash = json!({"activities": [
            {"id":"a","command":"sleep 9","status":"running"},
        ]});
        let identity = identity();
        let src = sources(&identity, &roster, &goal, &heartbeats, &bash);
        let mut panel = ActivityPanel::new(&src, Some(ActivityPanelGroup::Bash), 16);
        let kb = KeybindingsManager::new();
        panel.set_bash_tail("a", "process output");
        assert_eq!(
            panel.selected_row().map(|row| row.group),
            Some(ActivityPanelGroup::Bash)
        );
        // The bash feed disappears: the clamped fallback lands on the
        // subagent row whose id is also "a" - the tail must not follow.
        let emptied = json!({"activities": []});
        let src2 = sources(&identity, &roster, &goal, &heartbeats, &emptied);
        panel.apply_sources(&src2);
        assert_eq!(panel.selected_row().map(|row| row.id.as_str()), Some("a"));
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let lines = panel.render(&theme, 60, &kb);
        let rendered = lines
            .iter()
            .flat_map(|line| line.iter())
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert!(
            !rendered.contains("process output"),
            "the tail never renders under a non-bash row: {rendered}"
        );
    }

    #[test]
    fn parse_bash_activities_reads_wire_rows_and_drops_missing_ids() {
        let mut payload = json!({"activities": [
            {"id":"a","command":"sleep 9","pid":42,"startedAt":"2026-09-22T01:00:00Z","status":"running"},
            {"command":"ignored"},
        ]});
        payload["activities"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"  ","command":"blank id"}));
        let rows = parse_bash_activities(&payload);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "a");
        assert_eq!(rows[0].pid, Some(42));
        assert!(rows[0].running());
        // The bare array form is accepted too.
        let bare = parse_bash_activities(
            &json!([{"id":"b","status":"finished","exitCode":0,"durationMs":123}]),
        );
        assert_eq!(bare.len(), 1);
        assert_eq!(bare[0].exit_code, Some(0));
        assert_eq!(bare[0].duration_ms, Some(123));
        assert!(!bare[0].running());
    }

    #[test]
    fn detail_lines_are_sanitized_and_single_line() {
        let (roster, goal, heartbeats, _) = full_sources();
        let bash = json!({"activities": [
            {"id":"x","command":"printf 'a\\nb\\u{1b}[31mred\\r'","status":"running"},
        ]});
        let identity = identity();
        let src = sources(&identity, &roster, &goal, &heartbeats, &bash);
        let panel = ActivityPanel::new(&src, Some(ActivityPanelGroup::Bash), 16);
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let kb = KeybindingsManager::new();
        let lines = panel.render(&theme, 80, &kb);
        let rendered = lines
            .iter()
            .flat_map(|line| line.iter())
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert!(rendered.contains("printf"));
        assert!(
            !rendered.contains('\u{1b}'),
            "control characters never render"
        );
        assert!(!rendered.contains('\r'));
    }
}
