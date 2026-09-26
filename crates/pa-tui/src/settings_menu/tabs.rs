//! The `/settings` menu's tabs: the grouping of the settings rows and
//! the tab strip that navigates them. Claude Code's `/config` groups
//! its settings into categories (Model & Reasoning, Editor &
//! Interaction, Output & Display, …); ours adapts the same grouping to
//! our own settings rows, rendered inline through the shared
//! menu-panel grammar — one `N Name` strip row under the search field,
//! the active tab accent bold, the rest muted.
//!
//! The layout is the single source of the grouping: every settings row
//! id rides exactly one tab (pinned by the tests here and in
//! `settings_menu`), and the menu resolves it to row indices once at
//! construction.

use super::SettingsMenuRow;
use crate::theme::{Theme, ThemeColor};
use crate::width::truncate_line;
use crate::{Line, Span};

/// One tab of the settings menu: its label and the ids of the settings
/// rows it groups.
struct TabLayout {
    name: &'static str,
    ids: &'static [&'static str],
}

/// The settings tabs: General (session behavior), Models (model-side
/// choices), Display (what the UI renders), Editor (the input editor),
/// Agents (the agent tree and its services).
const TAB_LAYOUT: &[TabLayout] = &[
    TabLayout {
        name: "General",
        ids: &[
            "autocompact",
            "steering-mode",
            "follow-up-mode",
            "quiet-startup",
            "warnings",
        ],
    },
    TabLayout {
        name: "Models",
        ids: &["thinking", "transport"],
    },
    TabLayout {
        name: "Display",
        ids: &[
            "theme",
            "fullscreen",
            "terminal-progress",
            "clear-on-shrink",
            "show-images",
            "auto-resize-images",
            "block-images",
            "mermaid-rendering",
        ],
    },
    TabLayout {
        name: "Editor",
        ids: &[
            "editor-padding",
            "autocomplete-max-visible",
            "show-hardware-cursor",
        ],
    },
    TabLayout {
        name: "Agents",
        ids: &[
            "skill-commands",
            "builtin-skills",
            "idle-eviction-minutes",
            "tree-filter-mode",
        ],
    },
];

/// Resolve the layout against the menu's rows: each tab keeps the
/// indices of its rows, in the layout's order. An id the rows do not
/// carry is a programming error — the layout and the row builder ship
/// together in this module tree.
pub(crate) fn row_indices(rows: &[SettingsMenuRow]) -> Vec<(&'static str, Vec<usize>)> {
    TAB_LAYOUT
        .iter()
        .map(|tab| {
            (
                tab.name,
                tab.ids
                    .iter()
                    .map(|id| {
                        rows.iter()
                            .position(|row| row.id == *id)
                            .unwrap_or_else(|| {
                                panic!("the settings tab layout names {id}, which no settings row provides")
                            })
                    })
                    .collect(),
            )
        })
        .collect()
}

/// The tab strip (one row directly under the search field's bottom
/// border, aligned with the rows' inner column): one `N Name` per tab —
/// the number dim, the name muted, the active tab accent bold — two
/// spaces between tabs, truncated to the frame width like every
/// status row. The numbers are the digit keys that jump straight to
/// the tab.
pub(crate) fn strip_row(
    theme: &Theme,
    width: usize,
    names: &[&'static str],
    active: usize,
) -> Line {
    let mut line: Line = vec![Span::raw("  ")];
    for (index, name) in names.iter().enumerate() {
        if index > 0 {
            line.push(Span::raw("  "));
        }
        line.push(theme.fg_span(ThemeColor::Dim, (index + 1).to_string()));
        line.push(Span::raw(" "));
        line.push(if index == active {
            theme.bold(theme.fg_span(ThemeColor::Accent, name.to_string()))
        } else {
            theme.fg_span(ThemeColor::Muted, name.to_string())
        });
    }
    truncate_line(&line, width, "")
}

#[cfg(test)]
mod tabs_tests {
    use super::*;

    fn theme() -> crate::theme::Theme {
        crate::theme::Theme::builtin("prime", crate::theme::ColorMode::Color256)
    }

    #[test]
    fn the_layout_names_each_settings_id_once() {
        let names: Vec<&str> = TAB_LAYOUT
            .iter()
            .flat_map(|tab| tab.ids.iter().copied())
            .collect();
        let mut unique = names.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(names.len(), unique.len());
    }

    #[test]
    fn the_strip_lists_the_tabs_and_marks_the_active_one() {
        let line = strip_row(&theme(), 80, &["General", "Models"], 1);
        let text: String = line.iter().map(|span| span.content.as_str()).collect();
        assert_eq!(text, "  1 General  2 Models");
        let active = line
            .iter()
            .find(|span| span.content == "Models")
            .expect("the active tab renders");
        assert_eq!(
            active.style,
            theme()
                .fg_style(ThemeColor::Accent)
                .add_modifier(ratatui::style::Modifier::BOLD)
        );
        let inactive = line
            .iter()
            .find(|span| span.content == "General")
            .expect("an inactive tab renders");
        assert_eq!(inactive.style, theme().fg_style(ThemeColor::Muted));
    }

    #[test]
    fn the_strip_truncates_to_the_frame_width() {
        let line = strip_row(&theme(), 12, &["General", "Models", "Display"], 0);
        let text: String = line.iter().map(|span| span.content.as_str()).collect();
        assert!(crate::width::str_width(&text) <= 12);
        assert!(text.contains("General"));
        assert!(!text.contains("Models"));
    }
}
