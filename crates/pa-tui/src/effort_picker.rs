//! The `/effort` command dispatch: the session's thinking levels and their
//! descriptions, opened in the shared [`ChoicePicker`] or applied directly.

use crate::choice_picker::ChoicePicker;

/// The reasoning-level descriptions the TS selector lists under each level.
#[must_use]
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

/// The outcome of dispatching `/effort [level]`.
#[derive(Debug)]
pub(crate) enum EffortCommandOutcome {
    /// Open the picker over the session's levels.
    Open(ChoicePicker),
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
        return EffortCommandOutcome::Open(ChoicePicker::effort(levels, current));
    }
    if !levels.iter().any(|level| level == &requested) {
        return EffortCommandOutcome::Unknown {
            requested,
            levels: levels.to_vec(),
        };
    }
    EffortCommandOutcome::Apply { level: requested }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
