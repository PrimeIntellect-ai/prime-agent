//! The `/fork` user-message selector (TS `UserMessageSelectorComponent`):
//! the session's user messages, one fork point per row.

use crate::keybindings::KeybindingsManager;
use crate::theme::{Theme, ThemeColor};
use crate::width::truncate_line;
use crate::{Line, Span};
use ratatui::style::Modifier;

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

    /// The full pane (TS `UserMessageSelectorComponent.render`).
    pub fn render(&self, theme: &Theme, width: usize) -> Vec<Line> {
        let border = || vec![theme.fg_span(ThemeColor::Border, "─".repeat(width.max(1)))];
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
            border(),
            Vec::new(),
        ];
        if self.messages.is_empty() {
            lines.push(vec![theme.fg_span(
                ThemeColor::Muted,
                "  No user messages found".to_string(),
            )]);
        } else {
            let start = self
                .selected
                .saturating_sub(MAX_VISIBLE / 2)
                .min(self.messages.len().saturating_sub(MAX_VISIBLE));
            let end = (start + MAX_VISIBLE).min(self.messages.len());
            for position in start..end {
                let message = &self.messages[position];
                let is_selected = position == self.selected;
                let normalized = message.text.replace('\n', " ").trim().to_string();
                let cursor = if is_selected {
                    theme.fg_span(ThemeColor::Accent, "› ".to_string())
                } else {
                    Span::raw("  ".to_string())
                };
                let mut row: Line = vec![cursor, Span::raw(normalized)];
                if is_selected {
                    for span in &mut row {
                        span.style = span.style.add_modifier(Modifier::BOLD);
                    }
                }
                lines.push(truncate_line(&row, width, ""));
                lines.push(vec![theme.fg_span(
                    ThemeColor::Muted,
                    format!("  Message {} of {}", position + 1, self.messages.len()),
                )]);
                lines.push(Vec::new());
            }
            if start > 0 || end < self.messages.len() {
                lines.push(vec![theme.fg_span(
                    ThemeColor::Muted,
                    format!("  ({}/{})", self.selected + 1, self.messages.len()),
                )]);
            }
        }
        lines.push(Vec::new());
        lines.push(border());
        lines
    }
}
