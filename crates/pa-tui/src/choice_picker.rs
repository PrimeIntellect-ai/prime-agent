//! The inline single-choice picker the `/effort` command opens: one list
//! rendered through the inline-picker component
//! (TS `ThinkingSelectorComponent` reduced to this seam - list, select,
//! apply; Esc cancels). Enter applies the picked row through the caller,
//! which dispatches on the picker's purpose; the picker owns only list state.

use crate::config_selector::{ConfigSelector, SelectorAction, SelectorKind, SelectorRow};
use crate::effort_picker::level_description;
use crate::keybindings::KeybindingsManager;
use crate::theme::Theme;
use crate::Line;

/// What the picked row applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChoicePurpose {
    /// `/effort`: the row key is a thinking level.
    Effort,
}

/// One key press while the picker is open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ChoicePickerAction {
    /// Enter or Space on a row: the caller applies its key.
    Apply { purpose: ChoicePurpose, key: String },
    /// Esc or Ctrl+C: close without applying.
    Cancel,
    /// Navigation or filter editing only.
    None,
}

/// One single-choice picker. Rows carry their key as the identity; the
/// selector owns filtering, navigation, and rendering.
#[derive(Debug)]
pub(crate) struct ChoicePicker {
    selector: ConfigSelector,
    purpose: ChoicePurpose,
    keys: Vec<String>,
}

impl ChoicePicker {
    /// The `/effort` picker: one row per level (label = level, description
    /// as the secondary filter field), the current level checked.
    #[must_use]
    pub fn effort(levels: &[String], current: Option<&str>) -> Self {
        let rows = levels
            .iter()
            .map(|level| (level.clone(), level.clone(), level_description(level)))
            .collect();
        Self::new(ChoicePurpose::Effort, rows, current)
    }

    fn new(
        purpose: ChoicePurpose,
        rows: Vec<(String, String, &str)>,
        current: Option<&str>,
    ) -> Self {
        let kind = match purpose {
            ChoicePurpose::Effort => SelectorKind::Effort,
        };
        let keys: Vec<String> = rows.iter().map(|(key, _, _)| key.clone()).collect();
        let rows = rows
            .into_iter()
            .map(|(key, label, description)| SelectorRow::Item {
                checked: current == Some(key.as_str()),
                key,
                label,
                type_label: description.to_string(),
                path: String::new(),
            })
            .collect();
        let selector = ConfigSelector::with_kind(rows, kind);
        ChoicePicker {
            selector,
            purpose,
            keys,
        }
    }

    /// One bracketed paste into the search (the config selector's own
    /// paste path).
    pub fn paste(&mut self, text: &str) {
        self.selector.paste(text);
    }

    /// The checked state of one row.
    #[cfg(test)]
    #[must_use]
    pub fn checked(&self, key: &str) -> Option<bool> {
        self.selector.checked(key)
    }

    /// One key id. Cancel keys close without applying; Enter/Space apply
    /// the row at the selection (single-select).
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> ChoicePickerAction {
        if key == "ctrl+c" {
            return ChoicePickerAction::Cancel;
        }
        match self.selector.handle_key(key, kb) {
            Some(SelectorAction::Close | SelectorAction::Exit) => ChoicePickerAction::Cancel,
            Some(SelectorAction::Toggle { key, .. }) => {
                if self.keys.contains(&key) {
                    ChoicePickerAction::Apply {
                        purpose: self.purpose,
                        key,
                    }
                } else {
                    ChoicePickerAction::None
                }
            }
            None => ChoicePickerAction::None,
        }
    }

    /// The picker's rendered frame (the shared menu-panel grammar).
    #[must_use]
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        self.selector.render(theme, width, kb)
    }

    /// The rows the picker's list window renders (the click surface's
    /// item-row span).
    #[must_use]
    pub fn visible_window(&self) -> (usize, usize) {
        self.selector.visible_window()
    }

    /// Move the selection to one filtered row (the click grammar's row
    /// select - the arrow keys' exact movement, no apply).
    pub fn select_position(&mut self, position: usize) {
        self.selector.select_position(position);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ColorMode, Theme};

    fn kb() -> KeybindingsManager {
        KeybindingsManager::new()
    }

    fn frame_text(picker: &ChoicePicker) -> Vec<String> {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        picker
            .render(&theme, 60, &kb())
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect()
    }

    fn levels() -> Vec<String> {
        ["off", "low", "medium", "high"]
            .iter()
            .map(ToString::to_string)
            .collect()
    }

    #[test]
    fn enter_applies_the_selected_level_and_escape_cancels() {
        let mut picker = ChoicePicker::effort(&levels(), None);
        assert_eq!(picker.handle_key("down", &kb()), ChoicePickerAction::None);
        assert_eq!(
            picker.handle_key("enter", &kb()),
            ChoicePickerAction::Apply {
                purpose: ChoicePurpose::Effort,
                key: "low".to_string()
            }
        );
        assert_eq!(
            picker.handle_key("escape", &kb()),
            ChoicePickerAction::Cancel
        );
    }

    #[test]
    fn the_effort_frame_lists_levels_and_their_descriptions() {
        let text = frame_text(&ChoicePicker::effort(&levels(), None));
        assert!(text.iter().any(|row| row.contains("Thinking Level")));
        assert!(text.iter().any(|row| row.contains("Moderate reasoning")));
    }
}
