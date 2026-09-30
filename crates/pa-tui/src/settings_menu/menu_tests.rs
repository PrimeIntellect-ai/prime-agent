//! The settings-menu unit battery: the tab partitioning, the key loop,
//! the submenu previews, the filter, and the render shapes.
use super::*;
use crate::keybindings::KeybindingsManager;

fn kb() -> KeybindingsManager {
    KeybindingsManager::new()
}

fn menu() -> SettingsMenu {
    let values = SettingsCurrentValues {
        autocompact: true,
        steering_mode: "all".to_string(),
        available_thinking_levels: vec!["low".to_string(), "high".to_string()],
        thinking_level: Some("low".to_string()),
        available_themes: vec!["prime".to_string(), "dark".to_string()],
        theme: "prime".to_string(),
        idle_eviction_minutes: "90".to_string(),
        ..Default::default()
    };
    SettingsMenu::new(settings_menu_rows(&values))
}

fn render_text(menu: &SettingsMenu) -> Vec<String> {
    let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::Color256);
    menu.render(&theme, 100, &KeybindingsManager::new())
        .iter()
        .map(|line| line.iter().map(|span| span.content.as_str()).collect())
        .collect()
}

#[test]
fn tabs_partition_the_settings_rows() {
    let menu = menu();
    let tabs: Vec<(&str, Vec<&str>)> = menu
        .tabs
        .iter()
        .map(|tab| {
            (
                tab.name,
                tab.rows.iter().map(|&index| menu.rows[index].id).collect(),
            )
        })
        .collect();
    assert_eq!(
        tabs,
        vec![
            (
                "General",
                vec![
                    "autocompact",
                    "steering-mode",
                    "follow-up-mode",
                    "quiet-startup",
                    "warnings"
                ]
            ),
            (
                "Models",
                vec!["thinking", "transport", "default-service-tier"]
            ),
            (
                "Display",
                vec![
                    "theme",
                    "terminal-progress",
                    "clear-on-shrink",
                    "show-images",
                    "auto-resize-images",
                    "block-images",
                    "mermaid-rendering"
                ]
            ),
            (
                "Editor",
                vec![
                    "editor-padding",
                    "autocomplete-max-visible",
                    "show-hardware-cursor"
                ]
            ),
            (
                "Agents",
                vec![
                    "skill-commands",
                    "builtin-skills",
                    "idle-eviction-minutes",
                    "tree-filter-mode"
                ]
            ),
        ]
    );
    // The tabs carry every settings row exactly once.
    let grouped: usize = menu.tabs.iter().map(|tab| tab.rows.len()).sum();
    assert_eq!(grouped, menu.rows.len());
}

#[test]
fn an_empty_row_set_keeps_the_empty_state_and_closes() {
    let mut menu = SettingsMenu::new(Vec::new());
    // No tab state exists: the navigation keys no-op (never panic)
    // and the empty state renders with the tab-less hint.
    assert_eq!(menu.handle_key("down", &kb()), SettingsMenuAction::None);
    assert_eq!(menu.handle_key("2", &kb()), SettingsMenuAction::None);
    let text = render_text(&menu);
    assert!(text.iter().any(|row| row.contains("No settings available")));
    assert!(text
        .iter()
        .any(|row| { row.contains("Type to search · ←/→/Enter/Space change · Esc close") }));
    assert_eq!(menu.handle_key("esc", &kb()), SettingsMenuAction::Cancel);
}

#[test]
fn confirm_cycles_values_and_reports_the_change() {
    let mut menu = menu();
    // Auto-compact starts true; Enter flips it to false.
    assert_eq!(
        menu.handle_key("enter", &kb()),
        SettingsMenuAction::Change {
            id: "autocompact",
            value: "false".to_string()
        }
    );
    assert_eq!(
        menu.handle_key("enter", &kb()),
        SettingsMenuAction::Change {
            id: "autocompact",
            value: "true".to_string()
        }
    );
}

#[test]
fn enter_opens_the_thinking_submenu_and_selection_applies() {
    let mut menu = menu();
    // 2 jumps to the Models tab (thinking lives there).
    menu.handle_key("2", &kb());
    assert_eq!(menu.handle_key("enter", &kb()), SettingsMenuAction::None);
    // The submenu renders its title and options.
    let text = render_text(&menu);
    assert!(text.iter().any(|row| row.contains("Thinking Level")));
    assert!(text
        .iter()
        .any(|row| row.contains("Select reasoning depth for thinking-capable models")));
    // Down selects `high`; Enter applies and closes the submenu.
    menu.handle_key("down", &kb());
    assert_eq!(
        menu.handle_key("enter", &kb()),
        SettingsMenuAction::Change {
            id: "thinking",
            value: "high".to_string()
        }
    );
    // The submenu is gone (the hint line is back).
    let text = render_text(&menu);
    assert!(text.iter().any(|row| {
        row.contains("Type to search · Tab/1-5 tabs · ←/→/Enter/Space change · Esc close")
    }));
}

#[test]
fn theme_submenu_previews_and_esc_restores() {
    let mut menu = menu();
    // 3 jumps to the Display tab (theme leads it).
    menu.handle_key("3", &kb());
    menu.handle_key("enter", &kb());
    // Selection change previews.
    assert_eq!(
        menu.handle_key("down", &kb()),
        SettingsMenuAction::PreviewTheme {
            name: "dark".to_string()
        }
    );
    // Esc restores the row's theme (prime) and closes.
    assert_eq!(
        menu.handle_key("esc", &kb()),
        SettingsMenuAction::RestoreTheme {
            name: "prime".to_string()
        }
    );
    let text = render_text(&menu);
    assert!(text.iter().any(|row| row.contains("Theme")));
}

#[test]
fn enter_opens_the_service_tier_submenu_preselected_and_selection_applies() {
    let values = SettingsCurrentValues {
        default_service_tier: "flex".to_string(),
        ..Default::default()
    };
    let mut menu = SettingsMenu::new(settings_menu_rows(&values));
    // 2 jumps to the Models tab; two downs reach the tier row
    // (thinking, transport, default-service-tier).
    menu.handle_key("2", &kb());
    menu.handle_key("down", &kb());
    menu.handle_key("down", &kb());
    assert_eq!(menu.handle_key("enter", &kb()), SettingsMenuAction::None);
    let text = render_text(&menu);
    assert!(text.iter().any(|row| row.contains("Default Service Tier")));
    assert!(text
        .iter()
        .any(|row| row.contains("Cheaper, slower, may hit capacity limits")));
    // The submenu preselects the current value (flex is the second
    // option): Enter applies it as the row's change.
    assert_eq!(
        menu.handle_key("enter", &kb()),
        SettingsMenuAction::Change {
            id: "default-service-tier",
            value: "flex".to_string()
        }
    );
    // A walk down to auto applies the same change shape.
    assert_eq!(menu.handle_key("enter", &kb()), SettingsMenuAction::None);
    menu.handle_key("down", &kb());
    menu.handle_key("down", &kb());
    assert_eq!(
        menu.handle_key("enter", &kb()),
        SettingsMenuAction::Change {
            id: "default-service-tier",
            value: "auto".to_string()
        }
    );
    // Esc inside the submenu closes it (TS `onCancel` → `done()`)
    // while the menu itself stays open.
    assert_eq!(menu.handle_key("enter", &kb()), SettingsMenuAction::None);
    assert_eq!(
        menu.handle_key("esc", &kb()),
        SettingsMenuAction::SubmenuClosed
    );
    let text = render_text(&menu);
    // The menu hint returns with its full grammar (the tabs segment
    // sits between the search and change segments).
    assert!(text
        .iter()
        .any(|row| row.contains("Enter/Space change · Esc close")));
}

#[test]
fn typing_filters_the_active_tab_and_esc_cancels() {
    let mut menu = menu();
    // 2 jumps to the Models tab (thinking + transport).
    menu.handle_key("2", &kb());
    for key in ["t", "r", "a", "n", "s", "p"] {
        menu.handle_key(key, &kb());
    }
    let text = render_text(&menu);
    // The filter keeps the transport row visible and drops the
    // tab's other row from the window.
    assert!(text.iter().any(|row| row.contains("Transport")));
    assert!(!text.iter().any(|row| row.contains("Thinking")));
    assert_eq!(menu.handle_key("esc", &kb()), SettingsMenuAction::Cancel);
}

#[test]
fn switching_tabs_shows_that_tabs_settings() {
    let mut menu = menu();
    // General opens first.
    assert!(render_text(&menu)
        .iter()
        .any(|row| row.contains("Auto-compact")));
    // 4 jumps to the Editor tab: the editor-side settings only.
    menu.handle_key("4", &kb());
    let text = render_text(&menu);
    assert!(text.iter().any(|row| row.contains("Editor padding")));
    assert!(text
        .iter()
        .any(|row| row.contains("Autocomplete max items")));
    assert!(text.iter().any(|row| row.contains("Show hardware cursor")));
    assert!(!text.iter().any(|row| row.contains("Auto-compact")));
    assert!(!text.iter().any(|row| row.contains("Theme")));
}

#[test]
fn arrows_cycle_values_and_the_tab_keys_switch_tabs() {
    let mut menu = menu();
    // The arrows cycle the focused row's value (the operator's
    // 2026-09-28 rebind): right flips Auto-compact true → false
    // without leaving the General tab.
    assert_eq!(
        menu.handle_key("right", &kb()),
        SettingsMenuAction::Change {
            id: "autocompact",
            value: "false".to_string()
        }
    );
    assert!(render_text(&menu)
        .iter()
        .any(|row| row.contains("Auto-compact")));
    // left steps the other way: false → true.
    assert_eq!(
        menu.handle_key("left", &kb()),
        SettingsMenuAction::Change {
            id: "autocompact",
            value: "true".to_string()
        }
    );
    // The arrows never switch tabs anymore: after three rights the
    // General tab still owns the frame.
    for _ in 0..3 {
        menu.handle_key("right", &kb());
    }
    assert!(render_text(&menu)
        .iter()
        .any(|row| row.contains("Steering mode")));
    assert!(!render_text(&menu)
        .iter()
        .any(|row| row.contains("Transport")));
    // tab: General → Models (the arrows' old job).
    menu.handle_key("tab", &kb());
    assert!(render_text(&menu)
        .iter()
        .any(|row| row.contains("Transport")));
    // shift+tab: Models → General.
    menu.handle_key("shift+tab", &kb());
    assert!(render_text(&menu)
        .iter()
        .any(|row| row.contains("Auto-compact")));
    // 5 jumps to the Agents tab.
    menu.handle_key("5", &kb());
    assert!(render_text(&menu)
        .iter()
        .any(|row| row.contains("Skill commands")));
    // tab from the last tab wraps to the first: Agents → General.
    menu.handle_key("tab", &kb());
    assert!(render_text(&menu)
        .iter()
        .any(|row| row.contains("Auto-compact")));
}

#[test]
fn arrows_cycle_a_multi_option_row_in_place() {
    let mut menu = menu();
    // 2 jumps to the Models tab; down reaches Transport (a
    // four-value row, the multi-option cycling shape).
    menu.handle_key("2", &kb());
    menu.handle_key("down", &kb());
    // The row's current value is the unset default, so right lands on
    // the list's first option.
    assert_eq!(
        menu.handle_key("right", &kb()),
        SettingsMenuAction::Change {
            id: "transport",
            value: "sse".to_string()
        }
    );
    assert_eq!(
        menu.handle_key("right", &kb()),
        SettingsMenuAction::Change {
            id: "transport",
            value: "websocket".to_string()
        }
    );
    assert_eq!(
        menu.handle_key("right", &kb()),
        SettingsMenuAction::Change {
            id: "transport",
            value: "websocket-cached".to_string()
        }
    );
    // left walks the list back the other way.
    assert_eq!(
        menu.handle_key("left", &kb()),
        SettingsMenuAction::Change {
            id: "transport",
            value: "websocket".to_string()
        }
    );
    // The row shows the cycled value (the change persisted into the
    // menu's own display state).
    assert!(render_text(&menu)
        .iter()
        .any(|row| row.contains("websocket")));
    // Enter keeps its cycle: the next value after websocket.
    assert_eq!(
        menu.handle_key("enter", &kb()),
        SettingsMenuAction::Change {
            id: "transport",
            value: "websocket-cached".to_string()
        }
    );
}

#[test]
fn arrows_no_op_on_submenu_rows() {
    let mut menu = menu();
    // 2 jumps to the Models tab; Thinking level is a submenu row —
    // the arrows change nothing (Enter opens the submenu).
    menu.handle_key("2", &kb());
    assert_eq!(menu.handle_key("right", &kb()), SettingsMenuAction::None);
    assert_eq!(menu.handle_key("left", &kb()), SettingsMenuAction::None);
    assert_eq!(menu.handle_key("enter", &kb()), SettingsMenuAction::None);
    let text = render_text(&menu);
    assert!(text.iter().any(|row| row.contains("Thinking Level")));
}

#[test]
fn digits_type_into_an_active_query() {
    let mut menu = menu();
    // With an active query, digits are search text: 2 does not jump
    // to the Models tab (a jump would clear the search).
    menu.handle_key("s", &kb());
    menu.handle_key("2", &kb());
    let text = render_text(&menu);
    assert!(text.iter().any(|row| row.contains("s2")));
    assert!(text.iter().any(|row| row.contains("No matching settings")));
}

#[test]
fn switching_tabs_keeps_each_tabs_search_and_selection() {
    let mut menu = menu();
    // Down selects steering mode on General; the round trip keeps it.
    menu.handle_key("down", &kb());
    menu.handle_key("2", &kb());
    menu.handle_key("1", &kb());
    assert_eq!(
        menu.handle_key("enter", &kb()),
        SettingsMenuAction::Change {
            id: "steering-mode",
            value: "one-at-a-time".to_string()
        }
    );
    // Each tab keeps its own query: typing on General, switching to
    // Models and back, the filter and the field still hold. Tab
    // switches even under an active query (digits would type).
    for key in ["w", "a", "r", "n"] {
        menu.handle_key(key, &kb());
    }
    menu.handle_key("tab", &kb());
    assert!(render_text(&menu)
        .iter()
        .any(|row| row.contains("Transport")));
    menu.handle_key("shift+tab", &kb());
    let text = render_text(&menu);
    assert!(text.iter().any(|row| row.contains("warn")));
    assert!(text.iter().any(|row| row.contains("Warnings")));
    assert!(!text.iter().any(|row| row.contains("Quiet startup")));
}

#[test]
fn the_strip_lists_the_tabs_and_marks_the_active_one() {
    let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::Color256);
    let lines = menu().render(&theme, 100, &KeybindingsManager::new());
    // The strip rides under the search field with a blank row on
    // either side (the operator's 2026-09-28 spacing pass).
    let strip_blank_above: String = lines[3].iter().map(|span| span.content.as_str()).collect();
    assert_eq!(strip_blank_above, "");
    let text: String = lines[4].iter().map(|span| span.content.as_str()).collect();
    assert_eq!(
        text,
        "  1 General    2 Models    3 Display    4 Editor    5 Agents"
    );
    let strip_blank_below: String = lines[5].iter().map(|span| span.content.as_str()).collect();
    assert_eq!(strip_blank_below, "");
    // The active tab renders white bold (the operator's 2026-09-28
    // selection ruling — the theme's text color, not the dock's
    // background band).
    let active = lines[4]
        .iter()
        .find(|span| span.content == "General")
        .expect("the active tab renders");
    assert_eq!(
        active.style,
        theme
            .fg_style(ThemeColor::Text)
            .add_modifier(ratatui::style::Modifier::BOLD)
    );
    let inactive = lines[4]
        .iter()
        .find(|span| span.content == "Models")
        .expect("an inactive tab renders");
    assert_eq!(inactive.style, theme.fg_style(ThemeColor::Muted));
}

#[test]
fn the_header_and_the_settings_list_breathe_apart() {
    let text = render_text(&menu());
    // The search field: [rule, field, rule]; then the spacing pass's
    // blank row under the field, the strip, and the blank row below
    // the tabs before the settings list begins (the operator's
    // 2026-09-28 spacing directives 1 + 2).
    assert_eq!(text[0], "\u{2500}".repeat(100));
    assert!(text[1].starts_with(" >  Search settings"));
    assert_eq!(text[2], "\u{2500}".repeat(100));
    assert_eq!(text[3], "");
    assert_eq!(
        text[4],
        "  1 General    2 Models    3 Display    4 Editor    5 Agents"
    );
    assert_eq!(text[5], "");
    assert!(text[6].starts_with("\u{203a} Auto-compact"));
}

#[test]
fn render_shows_value_and_selected_description() {
    let text = render_text(&menu());
    assert!(text.iter().any(|row| row.contains("Auto-compact")));
    assert!(text
        .iter()
        .any(|row| row.contains("Automatically compact context when it gets too large")));
    assert!(text.iter().any(|row| {
        row.contains("Type to search · Tab/1-5 tabs · ←/→/Enter/Space change · Esc close")
    }));
    // The selected first row carries the menu marker and its value
    // rides the row's trailing cluster (the shared menu-row grammar).
    let selected = text
        .iter()
        .find(|row| row.starts_with("\u{203a}"))
        .expect("the selected row carries the marker");
    assert!(selected.contains("Auto-compact"));
    assert!(selected.contains("true"));
    // The separator rule rides below the description, above the
    // keyboard-shortcuts row (the operator's 2026-09-28 directive),
    // and the hint row carries the description's two-space padding-x
    // (the padding match, the same pass).
    let hint_index = text
        .iter()
        .position(|row| row.starts_with("  Type to search"))
        .expect("the hint row renders with its padding");
    assert_eq!(text[hint_index - 1], "\u{2500}".repeat(100));
    let description_index = text
        .iter()
        .position(|row| row.starts_with("  Automatically compact"))
        .expect("the description renders with its padding");
    assert_eq!(text[description_index + 1], "\u{2500}".repeat(100));
}

#[test]
fn opening_into_a_setting_keeps_the_top_bar_and_the_padding() {
    let mut menu = menu();
    // 2 jumps to the Models tab; Enter opens the Thinking level
    // submenu (the open-into-a-setting path).
    menu.handle_key("2", &kb());
    menu.handle_key("enter", &kb());
    let text = render_text(&menu);
    // The top bar — the full-width rule that separates the settings
    // surface from the chat view — stays over the submenu (the
    // operator's 2026-09-28 regression pin a).
    assert_eq!(text[0], "\u{2500}".repeat(100));
    // The setting's name and description keep the list rows'
    // padding-x (the regression pin b).
    assert_eq!(text[1], "  Thinking Level");
    assert!(text[3].starts_with("  Select reasoning depth"));
    // The submenu's own keyboard-shortcuts row carries the same
    // padding (the padding family).
    assert!(text
        .iter()
        .any(|row| row.starts_with("  Enter select · Esc back")));
}
