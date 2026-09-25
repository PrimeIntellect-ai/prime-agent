//! The reusable question panel of the first-run flows (TS
//! `OnboardingChoiceComponent`): the prompt, a list of options in the
//! same selection language as the pickers, and an optional grey
//! footnote. The onboarding splash mounts one per question and drives
//! the cursor with the selection keys.

use crate::onboarding::{highlight_wash, wrap_words};
use crate::theme::{Theme, ThemeColor};
use crate::width::str_width;
use crate::{Line, Span};
use ratatui::style::{Modifier, Style};

/// Selection-row metrics (TS `OnboardingChoiceComponent`).
const CHOICE_MARKER_WIDTH: usize = 2;
const CHOICE_MIN_ROW_WIDTH: usize = 30;
const CHOICE_ROW_TRAILING: usize = 6;
const CHOICE_DESCRIPTION_WIDTH: usize = 50;

/// One choice row (TS `OnboardingChoiceOption`): a label with an optional
/// identifier shown as its dim subtitle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnboardingChoiceOption {
    /// The row label.
    pub label: String,
    /// Identifier rendered as `  @detail` after the label — dimmer than the
    /// label, and counted toward the label-width calc (TS `detail`).
    pub detail: Option<String>,
}

/// The choice panel's copy and layout (TS `OnboardingChoiceOptions`): the
/// question text around the rows and the row-width override.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OnboardingChoiceOptions {
    /// The question line above the options (TS `prompt`).
    pub prompt: Option<String>,
    /// Muted sentence under the prompt, before the options (TS
    /// `description`), wrapped at 50 columns.
    pub description: Option<String>,
    /// Grey footnote under the list, e.g. how to change the answer later
    /// (TS `note`).
    pub note: Option<String>,
    /// Row-width override (TS `rowWidth`); absent sizes the rows from the
    /// labels, always clamped to the panel width.
    pub row_width: Option<usize>,
}

/// A question in the onboarding block (TS `OnboardingChoiceComponent`): the
/// prompt, a list of options in the same selection language as the
/// first-run actions, and an optional grey footnote. The host mounts one
/// per question and drives the cursor with the selection keys.
#[derive(Debug, Clone)]
pub struct OnboardingChoice {
    options: Vec<OnboardingChoiceOption>,
    selected: usize,
    config: OnboardingChoiceOptions,
}

impl OnboardingChoice {
    /// TS constructor: the cursor seeds at `selected_index` (TS
    /// `selectedIndex`), clamped into the option list.
    pub fn new(
        options: Vec<OnboardingChoiceOption>,
        selected_seed: Option<usize>,
        config: OnboardingChoiceOptions,
    ) -> Self {
        let last = options.len().saturating_sub(1);
        Self {
            selected: selected_seed.unwrap_or(0).min(last),
            options,
            config,
        }
    }

    /// The row the cursor sits on.
    pub fn selected(&self) -> usize {
        self.selected
    }

    /// Move the cursor `delta` rows (TS `move`): no wrap; `false` when the
    /// move would leave the list, so the caller skips the re-render.
    pub fn move_selection(&mut self, delta: isize) -> bool {
        // The checked sum keeps a huge delta an out-of-range move (TS
        // `next < 0 || next >= options.length`) instead of an overflow.
        let Some(next) = self.selected.checked_add_signed(delta) else {
            return false;
        };
        if next >= self.options.len() {
            return false;
        }
        self.selected = next;
        true
    }

    /// The panel block (TS `OnboardingChoiceComponent.render`): the prompt,
    /// the wrapped description, the option rows (the selected one washed),
    /// and the change-anytime note, each indented one column.
    pub fn render(&self, theme: &Theme, width: usize) -> Vec<Line> {
        let safe_width = width.max(1);
        let mut lines: Vec<Line> = vec![Vec::new()];
        if let Some(prompt) = &self.config.prompt {
            lines.push(vec![Span::styled(
                format!(" {prompt}"),
                theme.fg_style(ThemeColor::Text),
            )]);
            lines.push(Vec::new());
        }
        if let Some(description) = &self.config.description {
            let wrap = CHOICE_DESCRIPTION_WIDTH
                .min(safe_width.saturating_sub(2))
                .max(1);
            for row in wrap_words(description, wrap) {
                lines.push(vec![Span::styled(
                    format!(" {row}"),
                    theme.fg_style(ThemeColor::Muted),
                )]);
            }
            lines.push(Vec::new());
        }
        lines.extend(self.option_rows(theme, safe_width));
        if let Some(note) = &self.config.note {
            lines.push(Vec::new());
            lines.push(vec![Span::styled(
                format!(" {note}"),
                theme.fg_style(ThemeColor::Dim),
            )]);
        }
        lines
    }

    /// The option rows (TS `render`'s row loop): marker + label + the dim
    /// `  @detail` subtitle, padded to the row width so the wash forms a
    /// band; the selected row lifts off the canvas with a bold label.
    fn option_rows(&self, theme: &Theme, safe_width: usize) -> Vec<Line> {
        let label_width = self
            .options
            .iter()
            .map(|option| match &option.detail {
                // TS joins label and detail with two spaces for the width
                // calc; the rendered subtitle adds the `@` on top.
                Some(detail) => str_width(&option.label) + 2 + str_width(detail),
                None => str_width(&option.label),
            })
            .max()
            .unwrap_or(0);
        // TS clamps the row to the panel width: a narrow pane shortens the
        // highlight instead of running past the edge.
        let row_width = self
            .config
            .row_width
            .unwrap_or(
                (CHOICE_MARKER_WIDTH + label_width + CHOICE_ROW_TRAILING).max(CHOICE_MIN_ROW_WIDTH),
            )
            .min(safe_width)
            .max(1);
        let wash = highlight_wash(theme);
        let mut rows: Vec<Line> = Vec::with_capacity(self.options.len());
        for (index, option) in self.options.iter().enumerate() {
            let selected = index == self.selected;
            let name = format!("{}{}", if selected { "> " } else { "  " }, option.label);
            let detail = match &option.detail {
                Some(detail) => format!("  @{detail}"),
                None => String::new(),
            };
            let pad = " ".repeat(row_width.saturating_sub(str_width(&name) + str_width(&detail)));
            let mut row: Line = vec![Span::styled(" ".to_string(), Style::default())];
            if selected {
                // The selected row lifts off the canvas (TS
                // `onboardingHighlightBackground`): a bold name over the
                // washed background, the dim detail and padding inside
                // the wash.
                let mut washed_name = Span::styled(
                    name,
                    theme
                        .fg_style(ThemeColor::Text)
                        .add_modifier(Modifier::BOLD),
                );
                washed_name.style = washed_name.style.bg(wash);
                row.push(washed_name);
                let mut washed_tail =
                    Span::styled(format!("{detail}{pad}"), theme.fg_style(ThemeColor::Dim));
                washed_tail.style = washed_tail.style.bg(wash);
                row.push(washed_tail);
            } else {
                row.push(Span::styled(name, theme.fg_style(ThemeColor::Muted)));
                row.push(Span::styled(
                    format!("{detail}{pad}"),
                    theme.fg_style(ThemeColor::Dim),
                ));
            }
            rows.push(row);
        }
        rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::ColorMode;

    fn option(label: &str, detail: Option<&str>) -> OnboardingChoiceOption {
        OnboardingChoiceOption {
            label: label.to_string(),
            detail: detail.map(str::to_string),
        }
    }

    fn choice_config(row_width: Option<usize>) -> OnboardingChoiceOptions {
        OnboardingChoiceOptions {
            prompt: Some("Pick one".to_string()),
            description: None,
            note: None,
            row_width,
        }
    }

    #[test]
    fn detail_renders_as_a_dim_subtitle_and_counts_toward_the_row_width() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let wash = highlight_wash(&theme);
        let choice = OnboardingChoice::new(
            vec![
                option("Personal account", None),
                option("Prime", Some("prime-intellect")),
            ],
            Some(1),
            choice_config(None),
        );
        let lines = choice.render(&theme, 80);
        // blank, prompt, blank, then the two option rows.
        assert_eq!(lines.len(), 5);
        let unselected = &lines[3];
        // Label width = max("Personal account" = 16, "Prime  prime-intellect"
        // = 19) → row width max(30, 2 + 19 + 6) = 30.
        assert_eq!(
            unselected[1],
            Span::styled("  Personal account", theme.fg_style(ThemeColor::Muted))
        );
        assert_eq!(
            unselected[2],
            Span::styled(
                " ".repeat(30 - "  Personal account".len()),
                theme.fg_style(ThemeColor::Dim)
            )
        );
        let selected = &lines[4];
        // The subtitle reads as a dimmer identifier after the name, and the
        // wash covers the detail and the padding inside the band.
        assert_eq!(
            selected[1],
            Span::styled(
                "> Prime",
                theme
                    .fg_style(ThemeColor::Text)
                    .add_modifier(Modifier::BOLD)
                    .bg(wash)
            )
        );
        assert_eq!(
            selected[2],
            Span::styled(
                format!("  @prime-intellect{}", " ".repeat(30 - 7 - 18)),
                theme.fg_style(ThemeColor::Dim).bg(wash)
            )
        );
    }

    #[test]
    fn row_width_overrides_and_clamps_to_the_pane() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        // An explicit override under the pane sizes the wash band exactly.
        let choice =
            OnboardingChoice::new(vec![option("Share", None)], None, choice_config(Some(20)));
        let lines = choice.render(&theme, 80);
        assert_eq!(lines[3][2].content, " ".repeat(20 - "  Share".len()));
        // An override past the pane clamps to the pane.
        let choice =
            OnboardingChoice::new(vec![option("Share", None)], None, choice_config(Some(100)));
        let lines = choice.render(&theme, 50);
        assert_eq!(lines[3][2].content, " ".repeat(50 - "  Share".len()));
        // Without an override the labels size the band, still clamped:
        // "Continue with the current setup" (31 columns) →
        // max(30, 2 + 31 + 6) = 39.
        let choice = OnboardingChoice::new(
            vec![option("Continue with the current setup", None)],
            None,
            choice_config(None),
        );
        let lines = choice.render(&theme, 80);
        assert_eq!(
            lines[3][2].content,
            " ".repeat(39 - "  Continue with the current setup".len())
        );
        let lines = choice.render(&theme, 35);
        assert_eq!(
            lines[3][2].content,
            " ".repeat(35 - "  Continue with the current setup".len())
        );
    }

    #[test]
    fn selected_seed_clamps_into_the_options() {
        let options = || vec![option("a", None), option("b", None), option("c", None)];
        assert_eq!(
            OnboardingChoice::new(options(), Some(2), OnboardingChoiceOptions::default()).selected(),
            2
        );
        assert_eq!(
            OnboardingChoice::new(options(), Some(99), OnboardingChoiceOptions::default()).selected(),
            2
        );
        assert_eq!(
            OnboardingChoice::new(options(), None, OnboardingChoiceOptions::default()).selected(),
            0
        );
        assert_eq!(
            OnboardingChoice::new(vec![], Some(3), OnboardingChoiceOptions::default()).selected(),
            0
        );
    }

    #[test]
    fn cursor_moves_without_wrapping() {
        let mut choice = OnboardingChoice::new(
            vec![option("a", None), option("b", None)],
            None,
            OnboardingChoiceOptions::default(),
        );
        assert!(choice.move_selection(1));
        assert!(!choice.move_selection(1));
        assert!(choice.move_selection(-1));
        assert!(!choice.move_selection(-1));
        // Extreme deltas stay out-of-range moves, never overflow panics.
        assert!(!choice.move_selection(isize::MAX));
        assert!(!choice.move_selection(isize::MIN));
    }
}
