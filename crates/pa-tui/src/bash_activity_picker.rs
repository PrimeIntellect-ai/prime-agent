//! Inline picker for kernel bash processes. The caller polls the catalog, fetches
//! the selected output tail, and performs requested actions; this view owns no IO.

use serde_json::Value;

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::{menu_list_layout, menu_row};
use crate::theme::{Theme, ThemeColor};
use crate::width::truncate_line;
use crate::{Line, Span};

const PREFERRED_VISIBLE: usize = 8;
const RESERVED_ROWS: usize = 8; // rules, title, subtitle, blank, detail, blank, hint, rule
const MAX_TAIL_LINES: usize = 3;

/// An opaque kernel process id and its latest catalog metadata.
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
    fn running(&self) -> bool {
        self.status == "running"
    }
}

/// Accept either the daemon response's `activities` array or the array itself.
/// Rows without a nonempty string id are ignored; ids are never interpreted as pids.
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

/// The host executes these actions. `ViewOutput` requests a bounded tail via
/// `tail_kernel_bash`; deliver it back with `set_output_tail`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BashActivityPickerAction {
    ViewOutput { id: String },
    Kill { id: String },
    Close,
    None,
}

#[derive(Debug)]
pub struct BashActivityPicker {
    rows: Vec<BashActivity>,
    selected_id: Option<String>,
    output_tail: Option<(String, String)>,
    viewport_rows: usize,
}

impl BashActivityPicker {
    pub fn new(data: &Value, viewport_rows: usize) -> Self {
        let rows = parse_bash_activities(data);
        let selected_id = rows.first().map(|row| row.id.clone());
        Self {
            rows,
            selected_id,
            output_tail: None,
            viewport_rows,
        }
    }

    /// Reconcile by id, not by index: poll reorderings do not move the cursor
    /// to a different process. If the id disappears, select its old position
    /// (clamped to the new list), then invalidate the old output.
    pub fn apply_rows(&mut self, data: &Value) {
        let previous_index = self.selected_index();
        let previous_id = self.selected_id.take();
        self.rows = parse_bash_activities(data);
        self.selected_id = previous_id
            .as_ref()
            .filter(|id| self.rows.iter().any(|row| &row.id == *id))
            .cloned()
            .or_else(|| {
                self.rows
                    .get(previous_index.min(self.rows.len().saturating_sub(1)))
                    .map(|row| row.id.clone())
            });
        if self
            .output_tail
            .as_ref()
            .is_some_and(|(id, _)| Some(id) != self.selected_id.as_ref())
        {
            self.output_tail = None;
        }
    }

    pub fn set_viewport_rows(&mut self, rows: usize) {
        self.viewport_rows = rows;
    }

    pub fn selected_id(&self) -> Option<&str> {
        self.selected_id.as_deref()
    }

    /// Store only the most recent bounded tail for the selected id. The
    /// caller decides when to fetch and how many lines to request.
    pub fn set_output_tail(&mut self, id: &str, tail: &str) {
        if self.selected_id.as_deref() == Some(id) {
            self.output_tail = Some((id.to_string(), tail.to_string()));
        }
    }

    fn selected_index(&self) -> usize {
        self.rows
            .iter()
            .position(|row| Some(row.id.as_str()) == self.selected_id.as_deref())
            .unwrap_or(0)
    }

    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> BashActivityPickerAction {
        if key == "ctrl+c"
            || kb.matches(key, "tui.select.cancel")
            || kb.matches(key, "app.modal.back")
        {
            return BashActivityPickerAction::Close;
        }
        let delta = if kb.matches(key, "tui.select.up") {
            -1
        } else if kb.matches(key, "tui.select.down") {
            1
        } else {
            0
        };
        if delta != 0 && !self.rows.is_empty() {
            let index = (self.selected_index() as isize + delta)
                .clamp(0, self.rows.len() as isize - 1) as usize;
            self.selected_id = Some(self.rows[index].id.clone());
            self.output_tail = None;
        } else if key == "k" {
            if let Some(row) = self
                .rows
                .get(self.selected_index())
                .filter(|row| row.running())
            {
                return BashActivityPickerAction::Kill { id: row.id.clone() };
            }
        } else if kb.matches(key, "tui.select.confirm") {
            if let Some(id) = self.selected_id.clone() {
                return BashActivityPickerAction::ViewOutput { id };
            }
        }
        BashActivityPickerAction::None
    }

    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        let border = || vec![theme.fg_span(ThemeColor::BorderMuted, "─".repeat(width.max(1)))];
        let text = |color, value: String| {
            truncate_line(
                &vec![Span::raw("  "), theme.fg_span(color, value)],
                width,
                "",
            )
        };
        let mut lines = vec![
            border(),
            text(ThemeColor::Accent, "Bash activity".to_string()),
            text(
                ThemeColor::Muted,
                format!(
                    "{} process{} · Enter output · k kill running",
                    self.rows.len(),
                    if self.rows.len() == 1 { "" } else { "es" }
                ),
            ),
            Vec::new(),
        ];
        let tail: Vec<String> = self
            .output_tail
            .as_ref()
            .filter(|(id, _)| Some(id.as_str()) == self.selected_id.as_deref())
            .map(|(_, tail)| {
                tail.lines()
                    .rev()
                    .take(MAX_TAIL_LINES)
                    .map(clean_line)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect()
            })
            .unwrap_or_default();
        let tail_lines = if self.viewport_rows >= 14 && !tail.is_empty() {
            1 + tail.len().min(self.viewport_rows.saturating_sub(12))
        } else {
            0
        };
        let visible = menu_list_layout(
            Some(self.viewport_rows),
            PREFERRED_VISIBLE,
            self.rows.len(),
            RESERVED_ROWS + tail_lines,
            1,
        );
        if self.rows.is_empty() {
            lines.push(text(ThemeColor::Muted, "No bash processes".to_string()));
        } else {
            let selected = self.selected_index();
            let start = selected
                .saturating_sub(visible / 2)
                .min(self.rows.len().saturating_sub(visible));
            let end = (start + visible).min(self.rows.len());
            for (offset, row) in self.rows[start..end].iter().enumerate() {
                let command = clean_line(&row.command);
                let status = if row.running() {
                    "running"
                } else {
                    &row.status
                };
                let pid = row.pid.map(|pid| format!("pid {pid}"));
                lines.push(menu_row(
                    theme,
                    width,
                    vec![Span::raw(command)],
                    &[pid.as_deref().unwrap_or(""), status],
                    start + offset == selected,
                ));
            }
            if start > 0 || end < self.rows.len() {
                lines.push(text(
                    ThemeColor::Muted,
                    format!(
                        "({selected}/{total})",
                        selected = selected + 1,
                        total = self.rows.len()
                    ),
                ));
            }
            let row = &self.rows[selected];
            let mut detail = vec![format!("id {id}", id = row.id)];
            if let Some(started) = &row.started_at {
                detail.push(format!("started {started}", started = clean_line(started)));
            }
            if let Some(ms) = row.duration_ms {
                detail.push(format!("{ms}ms"));
            }
            if let Some(code) = row.exit_code {
                detail.push(format!("exit {code}"));
            }
            lines.push(text(ThemeColor::Muted, detail.join(" · ")));
            if tail_lines > 0 {
                lines.push(text(ThemeColor::Muted, "Output tail".to_string()));
                for output in tail.iter().rev().take(tail_lines - 1).rev() {
                    lines.push(text(ThemeColor::Muted, output.clone()));
                }
            }
        }
        lines.push(Vec::new());
        let close_key = kb
            .get_keys("tui.select.cancel")
            .first()
            .map(|key| format_key_text(key))
            .unwrap_or_else(|| "Esc".to_string());
        lines.push(text(ThemeColor::Dim, format!("{close_key} close")));
        lines.push(border());
        lines
    }
}

// Keep command/output single-line and inert as terminal text; do not forward
// control characters from a process into the inline UI.
fn clean_line(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ColorMode, Theme};
    use serde_json::json;

    fn data() -> Value {
        json!({"activities": [
            {"id":"a","command":"sleep 9","pid":42,"startedAt":"2026-09-22T01:00:00Z","status":"running"},
            {"id":"b","command":"echo hi","status":"finished","exitCode":0,"durationMs":123},
        ]})
    }

    #[test]
    fn parses_wire_rows_and_drops_missing_ids() {
        let mut payload = data();
        payload["activities"]
            .as_array_mut()
            .unwrap()
            .push(json!({"command":"ignored"}));
        let rows = parse_bash_activities(&payload);
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0],
            BashActivity {
                id: "a".into(),
                command: "sleep 9".into(),
                pid: Some(42),
                started_at: Some("2026-09-22T01:00:00Z".into()),
                status: "running".into(),
                exit_code: None,
                duration_ms: None
            }
        );
        assert_eq!(rows[1].exit_code, Some(0));
        assert_eq!(rows[1].duration_ms, Some(123));
    }

    #[test]
    fn selection_survives_reorder_and_actions_use_opaque_id() {
        let kb = KeybindingsManager::new();
        let mut picker = BashActivityPicker::new(&data(), 16);
        assert_eq!(
            picker.handle_key("down", &kb),
            BashActivityPickerAction::None
        );
        assert_eq!(picker.handle_key("k", &kb), BashActivityPickerAction::None);
        picker
            .apply_rows(&json!({"activities": [data()["activities"][1], data()["activities"][0]]}));
        assert_eq!(picker.selected_id(), Some("b"));
        assert_eq!(
            picker.handle_key("enter", &kb),
            BashActivityPickerAction::ViewOutput { id: "b".into() }
        );
        assert_eq!(
            picker.handle_key("down", &kb),
            BashActivityPickerAction::None
        );
        assert_eq!(
            picker.handle_key("k", &kb),
            BashActivityPickerAction::Kill { id: "a".into() }
        );
        assert_eq!(
            picker.handle_key("escape", &kb),
            BashActivityPickerAction::Close
        );
    }

    #[test]
    fn stale_output_is_ignored_and_render_window_is_bounded() {
        let kb = KeybindingsManager::new();
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let many = json!({"activities": (0..20).map(|i| json!({"id":i.to_string(),"command":format!("cmd {i}"),"status":"running"})).collect::<Vec<_>>()});
        let mut picker = BashActivityPicker::new(&many, 15);
        picker.set_output_tail("wrong", "stale");
        picker.set_output_tail("0", "one\ntwo\nthree\nfour");
        let lines = picker.render(&theme, 48, &kb);
        let rendered = lines
            .iter()
            .flat_map(|line| line.iter())
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert!(rendered.contains("four"));
        assert!(!rendered.contains("one"));
        assert!(!rendered.contains("stale"));
        assert!(lines.len() <= 15);
        assert!(lines
            .iter()
            .all(|line| crate::width::spans_width(line) <= 48));
        picker.apply_rows(&json!({"activities": []}));
        assert_eq!(picker.selected_id(), None);
    }
}
