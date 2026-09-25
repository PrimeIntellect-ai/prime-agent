//! The `/fork` user-message selector (TS `UserMessageSelectorComponent`):
//! the session's user messages, one fork point per row, rendered through
//! the shared menu grammar (the `›` marker rows, the `(n/m)` scroll row,
//! the key-hint status row every picker renders with).

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::{hint_row, menu_row, no_match_row, scroll_row};
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};

/// One forkable user message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserMessageItem {
    pub id: String,
    pub text: String,
}

/// What a key press did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserMessageSelectorAction {
    /// Enter on a message: fork from its entry id.
    Select(String),
    /// Escape: close.
    Cancel,
    None,
}

const MAX_VISIBLE: usize = 10;

/// The `/fork` selector state.
pub struct UserMessageSelector {
    messages: Vec<UserMessageItem>,
    selected: usize,
}

impl UserMessageSelector {
    /// Build over the `get_user_messages_for_forking` response; the latest
    /// message is preselected (TS `initialSelectedId` fallback).
    pub fn new(messages: Vec<UserMessageItem>) -> Self {
        let selected = messages.len().saturating_sub(1);
        UserMessageSelector { messages, selected }
    }

    /// True when there is nothing to fork from.
    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    pub fn handle_key(&mut self, kb: &KeybindingsManager, id: &str) -> UserMessageSelectorAction {
        if self.messages.is_empty() {
            return UserMessageSelectorAction::None;
        }
        if kb.matches(id, "tui.select.up") {
            self.selected = (self.selected + self.messages.len() - 1) % self.messages.len();
            UserMessageSelectorAction::None
        } else if kb.matches(id, "tui.select.down") {
            self.selected = (self.selected + 1) % self.messages.len();
            UserMessageSelectorAction::None
        } else if kb.matches(id, "tui.select.confirm") {
            let id = self.messages[self.selected].id.clone();
            UserMessageSelectorAction::Select(id)
        } else if kb.matches(id, "tui.select.cancel") {
            UserMessageSelectorAction::Cancel
        } else {
            UserMessageSelectorAction::None
        }
    }

    /// The full pane: the title and description rows, then the shared menu
    /// list (one row per message, the scroll indicator, the key hint).
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        // TS mounts the title and description with a one-space margin
        // (`new Text(..., 1, 0)`): the indent sits outside any escape.
        let mut lines: Vec<Line> = vec![
            Vec::new(),
            vec![Span::raw(" Fork from Message")],
            vec![
                Span::raw(" "),
                theme.fg_span(
                    ThemeColor::Muted,
                    "Select a user message to copy the active path up to that point into a new session"
                        .to_string(),
                ),
            ],
            Vec::new(),
        ];
        if self.messages.is_empty() {
            lines.push(no_match_row(theme, width, "No user messages found"));
        } else {
            let start = self
                .selected
                .saturating_sub(MAX_VISIBLE / 2)
                .min(self.messages.len().saturating_sub(MAX_VISIBLE));
            let end = (start + MAX_VISIBLE).min(self.messages.len());
            for position in start..end {
                let normalized = self.messages[position]
                    .text
                    .replace('\n', " ")
                    .trim()
                    .to_string();
                lines.push(menu_row(
                    theme,
                    width,
                    vec![Span::raw(normalized)],
                    &[],
                    position == self.selected,
                ));
            }
            if start > 0 || end < self.messages.len() {
                lines.push(scroll_row(
                    theme,
                    width,
                    self.selected + 1,
                    self.messages.len(),
                ));
            }
        }
        lines.push(Vec::new());
        lines.push(hint_row(theme, width, &hint(kb)));
        lines
    }
}

/// The selector's key hint: the shared hint-row grammar, this surface's
/// vocabulary.
fn hint(kb: &KeybindingsManager) -> String {
    let navigate = format!(
        "{}/{}",
        kb.first_key("tui.select.up")
            .map_or_else(|| "\u{2191}".to_string(), |key| format_key_text(&key)),
        kb.first_key("tui.select.down")
            .map_or_else(|| "\u{2193}".to_string(), |key| format_key_text(&key))
    );
    let select_key = kb
        .first_key("tui.select.confirm")
        .map_or_else(|| "Enter".to_string(), |key| format_key_text(&key));
    let close_key = kb
        .first_key("tui.select.cancel")
        .map_or_else(|| "Esc".to_string(), |key| format_key_text(&key));
    format!("{navigate} navigate · {select_key} select · {close_key} close")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kb() -> KeybindingsManager {
        KeybindingsManager::new()
    }

    fn theme() -> Theme {
        Theme::builtin("prime", crate::theme::ColorMode::TrueColor)
    }

    fn messages() -> Vec<UserMessageItem> {
        (0..12)
            .map(|index| UserMessageItem {
                id: format!("entry-{index}"),
                text: format!("message {index}"),
            })
            .collect()
    }

    fn row_text(line: &Line) -> String {
        line.iter().map(|span| span.content.as_str()).collect()
    }

    #[test]
    fn escape_cancels_and_enter_selects() {
        let mut selector = UserMessageSelector::new(messages());
        assert_eq!(
            selector.handle_key(&kb(), "escape"),
            UserMessageSelectorAction::Cancel
        );
        // The latest message is preselected; Enter forks from it.
        assert_eq!(
            selector.handle_key(&kb(), "enter"),
            UserMessageSelectorAction::Select("entry-11".to_string())
        );
    }

    #[test]
    fn navigation_wraps_around_the_list() {
        let mut selector = UserMessageSelector::new(messages());
        for _ in 0..12 {
            selector.handle_key(&kb(), "up");
        }
        assert_eq!(
            selector.handle_key(&kb(), "enter"),
            UserMessageSelectorAction::Select("entry-11".to_string())
        );
        selector.handle_key(&kb(), "down");
        assert_eq!(
            selector.handle_key(&kb(), "enter"),
            UserMessageSelectorAction::Select("entry-0".to_string())
        );
    }

    /// The selector renders through the shared menu grammar: the `›`
    /// marker on the selected row, the `(n/m)` scroll row once the window
    /// cannot hold every message, the hint row — and no per-row metadata
    /// lines.
    #[test]
    fn the_pane_renders_through_the_shared_menu_grammar() {
        let selector = UserMessageSelector::new(messages());
        let lines = selector.render(&theme(), 80, &kb());
        let rendered: Vec<String> = lines.iter().map(row_text).collect();
        assert!(
            rendered
                .iter()
                .any(|row| row.starts_with("\u{203a} message 11")),
            "the preselected latest message carries the menu marker:\n{rendered:?}"
        );
        assert!(
            rendered.iter().any(|row| row.contains("(12/12)")),
            "the shared scroll row replaces the per-row metadata:\n{rendered:?}"
        );
        assert!(!rendered.iter().any(|row| row.contains("Message 1 of")));
        assert!(rendered
            .iter()
            .any(|row| row.contains("\u{2191}/\u{2193} navigate · Enter select · Esc close")));
    }

    #[test]
    fn an_empty_session_renders_the_shared_no_match_row() {
        let selector = UserMessageSelector::new(Vec::new());
        let lines = selector.render(&theme(), 80, &kb());
        let rendered: Vec<String> = lines.iter().map(row_text).collect();
        assert!(rendered
            .iter()
            .any(|row| row.contains("No user messages found")));
    }
}
