//! The `/effort` inline picker: the session's thinking levels rendered
//! through the inline-picker component (TS `ThinkingSelectorComponent`
//! reduced to this seam — list, select, apply; Esc cancels). Enter applies
//! the picked level through the caller; the picker itself owns only list
//! state.

use crate::config_selector::{ConfigSelector, SelectorAction, SelectorKind, SelectorRow};
use crate::keybindings::KeybindingsManager;
use crate::theme::Theme;
use crate::Line;

/// The reasoning-level descriptions the TS selector lists under each level
/// (TS `LEVEL_DESCRIPTIONS`).
pub fn level_description(level: &str) -> &'static str {
    match level {
        "off" => "No reasoning",
        "minimal" => "Very brief reasoning",
        "low" => "Light reasoning",
        "medium" => "Moderate reasoning",
        "high" => "Deep reasoning",
        "xhigh" => "Very deep reasoning",
        "max" => "Maximum reasoning",
        _ => "",
    }
}

/// One key press while the picker is open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EffortPickerAction {
    /// Enter or Space on a level: the caller applies it.
    Apply { level: String },
    /// Esc or Ctrl+C: close without applying.
    Cancel,
    /// Navigation or filter editing only.
    None,
}

/// The outcome of dispatching `/effort [level]` (TS `handleEffortCommand`).
#[derive(Debug)]
pub(crate) enum EffortCommandOutcome {
    /// Open the picker over the session's levels.
    Open(EffortPicker),
    /// The model cannot think: the TS status note.
    Unsupported,
    /// The requested level is not one of the model's: the TS error.
    Unknown {
        requested: String,
        levels: Vec<String>,
    },
    /// The requested level is valid: apply it directly.
    Apply { level: String },
}

/// Dispatch `/effort [level]`: `levels` are the session's available
/// thinking levels (empty when the model cannot think), `current` is the
/// session's active level.
pub(crate) fn effort_command(
    levels: &[String],
    current: Option<&str>,
    arg: &str,
) -> EffortCommandOutcome {
    if levels.is_empty() {
        return EffortCommandOutcome::Unsupported;
    }
    let requested = arg.trim().to_lowercase();
    if requested.is_empty() {
        return EffortCommandOutcome::Open(EffortPicker::new(levels, current));
    }
    if !levels.iter().any(|level| level == &requested) {
        return EffortCommandOutcome::Unknown {
            requested,
            levels: levels.to_vec(),
        };
    }
    EffortCommandOutcome::Apply { level: requested }
}

/// One picker over the session's thinking levels. Rows carry the level as
/// the identity key; the selector owns filtering, navigation, and
/// rendering.
#[derive(Debug)]
pub struct EffortPicker {
    selector: ConfigSelector,
    levels: Vec<String>,
}

impl EffortPicker {
    /// Build the picker: one item row per level (label = level,
    /// description as the secondary filter field), the current level
    /// checked.
    pub fn new(levels: &[String], current: Option<&str>) -> Self {
        let rows = levels
            .iter()
            .map(|level| SelectorRow::Item {
                key: level.clone(),
                label: level.clone(),
                checked: current == Some(level.as_str()),
                type_label: level_description(level).to_string(),
                path: String::new(),
            })
            .collect();
        EffortPicker {
            selector: ConfigSelector::with_kind(rows, SelectorKind::Effort),
            levels: levels.to_vec(),
        }
    }

    /// The session's levels the picker was built over.
    pub fn levels(&self) -> &[String] {
        &self.levels
    }

    /// The checked state of one level's row.
    pub fn checked(&self, level: &str) -> Option<bool> {
        self.selector.checked(level)
    }

    /// One key id. Cancel keys close without applying; Enter/Space apply
    /// the level at the selection (single-select).
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> EffortPickerAction {
        if key == "ctrl+c" {
            return EffortPickerAction::Cancel;
        }
        match self.selector.handle_key(key, kb) {
            Some(SelectorAction::Close | SelectorAction::Exit) => EffortPickerAction::Cancel,
            Some(SelectorAction::Toggle { key, .. }) => {
                if self.levels.contains(&key) {
                    EffortPickerAction::Apply { level: key }
                } else {
                    EffortPickerAction::None
                }
            }
            None => EffortPickerAction::None,
        }
    }

    /// The picker's rendered frame (the shared menu-panel grammar).
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        self.selector.render(theme, width, kb)
    }

    /// The level rows the picker's list window renders (the click
    /// surface's item-row span).
    pub fn visible_window(&self) -> (usize, usize) {
        self.selector.visible_window()
    }

    /// Move the selection to one filtered row (the click grammar's row
    /// select — the arrow keys' exact movement, no apply).
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

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn levels() -> Vec<String> {
        ["off", "low", "medium", "high"]
            .iter()
            .map(ToString::to_string)
            .collect()
    }

    #[test]
    fn an_empty_level_list_reports_the_unsupported_model() {
        assert!(matches!(
            effort_command(&[], None, ""),
            EffortCommandOutcome::Unsupported
        ));
    }

    #[test]
    fn a_missing_argument_opens_the_picker() {
        let outcome = effort_command(&levels(), Some("medium"), "");
        let EffortCommandOutcome::Open(picker) = outcome else {
            panic!("expected the picker to open, got {outcome:?}")
        };
        assert_eq!(picker.checked("medium"), Some(true));
        assert_eq!(picker.checked("low"), Some(false));
    }

    #[test]
    fn a_known_argument_applies_directly() {
        match effort_command(&levels(), None, " HIGH ") {
            EffortCommandOutcome::Apply { level } => assert_eq!(level, "high"),
            outcome => panic!("expected apply, got {outcome:?}"),
        }
    }

    #[test]
    fn an_unknown_argument_carries_the_ts_error_inputs() {
        let available = levels();
        match effort_command(&available, None, "sideways") {
            EffortCommandOutcome::Unknown { requested, levels } => {
                assert_eq!(requested, "sideways");
                assert_eq!(levels, available);
            }
            outcome => panic!("expected unknown, got {outcome:?}"),
        }
    }

    #[test]
    fn enter_applies_the_selected_level_and_escape_cancels() {
        let mut picker = EffortPicker::new(&levels(), None);
        assert_eq!(picker.handle_key("down", &kb()), EffortPickerAction::None);
        assert_eq!(
            picker.handle_key("enter", &kb()),
            EffortPickerAction::Apply {
                level: "low".to_string()
            }
        );
        assert_eq!(
            picker.handle_key("escape", &kb()),
            EffortPickerAction::Cancel
        );
    }

    #[test]
    fn the_frame_lists_levels_and_their_descriptions() {
        let picker = EffortPicker::new(&levels(), None);
        let frame = picker.render(&theme(), 60, &kb());
        let text: Vec<String> = frame
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect();
        assert!(text.iter().any(|row| row.contains("Thinking Level")));
        assert!(text.iter().any(|row| row.contains("medium")));
    }
}
