//! The `/secrets` view: every secret bots can get, from the daemon's
//! `list_bot_secrets` answer, in the `/mcp` view's inline menu shape.
//! Each row shows whether bots get the secret, its status, and its rule
//! hosts; the detail line shows its kind and a short fingerprint, never a
//! value. Enter or Space turns a secret on or off for bots, Enter on the
//! last row adds a custom secret, the delete key (pressed twice) removes a
//! custom one, and Esc closes.

use serde_json::Value;

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::{
    detail_row, hint_row, key_hint, menu_list_layout, menu_row, scroll_row, MenuSegment,
};
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};

const PREFERRED_VISIBLE_ROWS: usize = 10;
const TITLE_ROWS: usize = 1;
const HINT_ROWS: usize = 1;
const DETAIL_ROWS: usize = 2;
const SCROLL_INDICATOR_ROWS: usize = 1;
const ADD_LABEL: &str = "+ Add a custom secret";
/// The binding that removes a custom secret (the agents view's delete key).
const REMOVE_BINDING: &str = "app.agents.delete";

/// One secret row of the daemon's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretRow {
    pub name: String,
    pub kind: String,
    pub inject: bool,
    pub status: String,
    pub hosts: Vec<String>,
    pub fingerprint: Option<String>,
    pub removable: bool,
}

impl SecretRow {
    fn from_value(value: &Value) -> Option<Self> {
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        Some(Self {
            name: text("name")?,
            kind: text("kind").unwrap_or_default(),
            inject: value.get("inject").and_then(Value::as_bool).unwrap_or(true),
            status: text("status").unwrap_or_default(),
            hosts: value
                .get("hosts")
                .and_then(Value::as_array)
                .map(|hosts| {
                    hosts
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            fingerprint: text("fingerprint"),
            removable: value
                .get("removable")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    fn status_color(&self) -> ThemeColor {
        match self.status.as_str() {
            "ok" => ThemeColor::Success,
            "stale" => ThemeColor::Warning,
            "off" => ThemeColor::Dim,
            _ => ThemeColor::Error,
        }
    }
}

/// A custom secret the add flow collected. `Debug` never prints the value.
#[derive(Clone)]
pub struct NewBotSecret {
    pub name: String,
    pub host: String,
    pub header: String,
    pub scheme: Option<String>,
    pub value: String,
}

impl std::fmt::Debug for NewBotSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NewBotSecret")
            .field("name", &self.name)
            .field("host", &self.host)
            .field("header", &self.header)
            .field("scheme", &self.scheme)
            .finish_non_exhaustive()
    }
}

/// One key press while the view is open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretsViewAction {
    /// Turn the secret `name` on or off for bots.
    Toggle { name: String, inject: bool },
    /// Start the add-a-custom-secret flow.
    Add,
    /// Remove the custom secret `name`.
    Remove { name: String },
    /// Close the view.
    Cancel,
    /// Navigation only.
    None,
}

/// The `/secrets` view.
#[derive(Debug)]
pub struct SecretsView {
    rows: Vec<SecretRow>,
    hosts: usize,
    max_hosts: usize,
    /// The bots that kept old header rules after the last change, with why.
    stale_bots: Vec<String>,
    /// The secret rows, then the add row.
    selected: usize,
    viewport_rows: usize,
    /// The custom secret the first delete press armed.
    armed_remove: Option<String>,
}

impl SecretsView {
    /// Build the view over a `list_bot_secrets` answer.
    #[must_use]
    pub fn from_response(data: &Value, viewport_rows: usize) -> Self {
        let mut view = Self {
            rows: Vec::new(),
            hosts: 0,
            max_hosts: 0,
            stale_bots: Vec::new(),
            selected: 0,
            viewport_rows,
            armed_remove: None,
        };
        view.apply(data);
        view
    }

    /// Replace the rows with a newer answer, keeping the selection on the
    /// same secret when it is still listed.
    pub fn apply(&mut self, data: &Value) {
        let selected = self.rows.get(self.selected).map(|row| row.name.clone());
        self.rows = data
            .get("secrets")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().filter_map(SecretRow::from_value).collect())
            .unwrap_or_default();
        let count = |key: &str| {
            data.get(key)
                .and_then(Value::as_u64)
                .and_then(|count| usize::try_from(count).ok())
                .unwrap_or(0)
        };
        self.hosts = count("hosts");
        self.stale_bots = data
            .get("staleBots")
            .and_then(Value::as_array)
            .map(|bots| {
                bots.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        self.max_hosts = count("maxHosts");
        self.armed_remove = None;
        self.selected = selected
            .and_then(|name| self.rows.iter().position(|row| row.name == name))
            .unwrap_or_else(|| self.selected.min(self.rows.len()));
    }

    /// Select the secret `name` when it is listed.
    pub fn select(&mut self, name: &str) {
        if let Some(index) = self.rows.iter().position(|row| row.name == name) {
            self.selected = index;
        }
    }

    /// The selected secret, or `None` on the add row.
    fn selected_row(&self) -> Option<&SecretRow> {
        self.rows.get(self.selected)
    }

    /// One key press: arrows move (clamped), Enter or Space toggles the
    /// selected secret (Enter on the add row adds one), the delete key
    /// removes a custom secret on its second press, and Esc closes.
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> SecretsViewAction {
        let last = self.rows.len();
        let armed = self.armed_remove.take();
        if kb.matches(key, "tui.select.cancel") || kb.matches(key, "app.modal.back") {
            return SecretsViewAction::Cancel;
        }
        if kb.matches(key, "tui.select.up") {
            self.selected = self.selected.saturating_sub(1);
        } else if kb.matches(key, "tui.select.down") {
            self.selected = (self.selected + 1).min(last);
        } else if kb.matches(key, "tui.select.pageUp") || kb.matches(key, "tui.select.top") {
            self.selected = 0;
        } else if kb.matches(key, "tui.select.pageDown") || kb.matches(key, "tui.select.bottom") {
            self.selected = last;
        } else if kb.matches(key, "tui.select.confirm") || key == "space" {
            return match self.selected_row() {
                Some(row) => SecretsViewAction::Toggle {
                    name: row.name.clone(),
                    inject: !row.inject,
                },
                None if key == "space" => SecretsViewAction::None,
                None => SecretsViewAction::Add,
            };
        } else if kb.matches(key, REMOVE_BINDING) {
            if let Some(row) = self.selected_row().filter(|row| row.removable) {
                if armed.as_deref() == Some(row.name.as_str()) {
                    return SecretsViewAction::Remove {
                        name: row.name.clone(),
                    };
                }
                self.armed_remove = Some(row.name.clone());
            }
        }
        SecretsViewAction::None
    }

    /// The frame: the title with the host count, the rows, the add row,
    /// the detail line, and the key hint.
    #[must_use]
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        let mut lines: Vec<Line> = Vec::new();
        let title = format!(
            " Secrets bots get \u{b7} {}/{} hosts",
            self.hosts, self.max_hosts
        );
        lines.push(crate::width::truncate_line(
            &vec![theme.fg_span(ThemeColor::Muted, title)],
            width,
            "",
        ));
        if !self.stale_bots.is_empty() {
            let warning = format!(
                " Kept old rules, retry by changing a secret: {}",
                self.stale_bots.join("; ")
            );
            lines.push(crate::width::truncate_line(
                &vec![theme.fg_span(ThemeColor::Warning, warning)],
                width,
                "\u{2026}",
            ));
        }
        let total = self.rows.len() + 1;
        let visible = self.visible_rows(total);
        let start = self
            .selected
            .saturating_sub(visible / 2)
            .min(total.saturating_sub(visible));
        let end = (start + visible).min(total);
        for index in start..end {
            let selected = index == self.selected;
            let Some(row) = self.rows.get(index) else {
                let add = vec![theme.fg_span(ThemeColor::Accent, ADD_LABEL)];
                lines.push(menu_row(theme, width, add, &[], selected));
                continue;
            };
            let check = if row.inject { "[x]" } else { "[ ]" };
            let primary = vec![Span::raw(format!("{check} {}", row.name))];
            let hosts = row.hosts.join(", ");
            let trailing = [
                MenuSegment::muted(&hosts),
                MenuSegment::themed(row.status_color(), &row.status),
            ];
            lines.push(menu_row(theme, width, primary, &trailing, selected));
        }
        if visible < total {
            lines.push(scroll_row(theme, width, self.selected + 1, total));
        }
        lines.push(Vec::new());
        let detail = vec![theme.fg_span(ThemeColor::Muted, self.detail(kb))];
        lines.push(detail_row(theme, width, &detail));
        lines.push(hint_row(theme, width, &self.hint(kb)));
        lines
    }

    fn detail(&self, kb: &KeybindingsManager) -> String {
        let Some(row) = self.selected_row() else {
            return " A custom secret: a name, an HTTPS host, a header, and a value typed once"
                .to_string();
        };
        if self.armed_remove.as_deref() == Some(row.name.as_str()) {
            let key = kb
                .first_key(REMOVE_BINDING)
                .map_or_else(|| "the delete key".to_string(), |key| format_key_text(&key));
            return format!(" Press {key} again to remove {}", row.name);
        }
        let mut parts = vec![row.kind.clone()];
        if let Some(fingerprint) = &row.fingerprint {
            parts.push(format!("fingerprint {fingerprint}"));
        }
        if row.hosts.is_empty() {
            parts.push("no rule host".to_string());
        }
        format!(" {}", parts.join(" \u{b7} "))
    }

    fn hint(&self, kb: &KeybindingsManager) -> String {
        let mut parts: Vec<String> = Vec::new();
        parts.extend(key_hint(
            kb,
            &["tui.select.up", "tui.select.down"],
            "navigate",
        ));
        match self.selected_row() {
            Some(row) => {
                parts.extend(key_hint(kb, &["tui.select.confirm"], "on/off"));
                if row.removable {
                    parts.extend(key_hint(kb, &[REMOVE_BINDING], "remove"));
                }
            }
            None => parts.extend(key_hint(kb, &["tui.select.confirm"], "add")),
        }
        parts.extend(key_hint(kb, &["tui.select.cancel"], "close"));
        parts.join(" \u{b7} ")
    }

    fn visible_rows(&self, total: usize) -> usize {
        let reserved =
            TITLE_ROWS + HINT_ROWS + DETAIL_ROWS + usize::from(!self.stale_bots.is_empty());
        if self.viewport_rows <= reserved {
            return 1;
        }
        menu_list_layout(
            Some(self.viewport_rows),
            PREFERRED_VISIBLE_ROWS,
            total,
            reserved,
            SCROLL_INDICATOR_ROWS,
        )
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn answer() -> Value {
        json!({
            "secrets": [
                { "name": "prime-inference", "kind": "api key", "inject": true, "status": "ok",
                  "hosts": ["api.pinference.ai"], "fingerprint": "A1B2C3D4E5F6", "removable": false },
                { "name": "ci", "kind": "custom", "inject": false, "status": "off",
                  "hosts": ["ci.example.com"], "fingerprint": "0F0F0F0F0F0F", "removable": true },
            ],
            "hosts": 1,
            "maxHosts": 32,
        })
    }

    /// Enter toggles, the add row adds, removal takes two presses on a
    /// custom secret only, and a refresh keeps the selected secret.
    #[test]
    fn keys_toggle_add_and_remove() {
        let kb = KeybindingsManager::default();
        let mut view = SecretsView::from_response(&answer(), 30);
        assert_eq!(
            view.handle_key("enter", &kb),
            SecretsViewAction::Toggle {
                name: "prime-inference".into(),
                inject: false
            }
        );
        assert_eq!(view.handle_key("ctrl+x", &kb), SecretsViewAction::None);
        assert_eq!(view.handle_key("ctrl+x", &kb), SecretsViewAction::None);
        view.handle_key("down", &kb);
        assert_eq!(view.handle_key("ctrl+x", &kb), SecretsViewAction::None);
        assert_eq!(
            view.handle_key("ctrl+x", &kb),
            SecretsViewAction::Remove { name: "ci".into() }
        );
        assert_eq!(
            view.handle_key("space", &kb),
            SecretsViewAction::Toggle {
                name: "ci".into(),
                inject: true
            }
        );
        let mut stale = answer();
        stale["staleBots"] = serde_json::json!(["triage: HTTP 503"]);
        view.apply(&stale);
        let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        let frame: String = view
            .render(&theme, 100, &kb)
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(frame.contains("Kept old rules"), "{frame}");
        let mut reordered = answer();
        reordered["secrets"].as_array_mut().unwrap().reverse();
        view.apply(&reordered);
        assert_eq!(view.selected_row().unwrap().name, "ci");
        view.handle_key("down", &kb);
        view.handle_key("down", &kb);
        assert_eq!(view.handle_key("enter", &kb), SecretsViewAction::Add);
        assert_eq!(view.handle_key("escape", &kb), SecretsViewAction::Cancel);
    }
}
