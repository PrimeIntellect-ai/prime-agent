//! The `/settings` inline menu (TS `SettingsSelectorComponent` over the
//! the TS TUI `SettingsList`): label/value rows with descriptions, Enter/Space
//! cycling values, Enter opening the submenus (thinking level, theme,
//! warnings), Esc closing, and type-to-search over the labels. The caller
//! owns the row data (daemon state + settings seam reads) and executes the
//! change actions; this module owns navigation, filtering, and rendering.

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::search_input::SearchInput;
use crate::theme::{Theme, ThemeColor};
use crate::width::wrap_text;

/// The reasoning-level descriptions the TS thinking submenu lists (TS
/// `THINKING_DESCRIPTIONS`).
fn thinking_description(level: &str) -> &'static str {
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

/// A submenu a row opens with Enter (TS `SettingItem.submenu`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsSubmenu {
    /// "Thinking Level" (the session's available levels).
    Thinking { levels: Vec<String> },
    /// "Theme" (the registered themes; selection change previews).
    Theme { themes: Vec<String> },
    /// "Warnings" (the single warning toggle as its own settings list).
    Warnings,
}

/// One settings row (TS `SettingItem`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsMenuRow {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// The displayed current value (right side).
    pub current: String,
    /// The values Enter/Space cycles through (`None` = submenu row).
    pub values: Option<Vec<String>>,
    pub submenu: Option<SettingsSubmenu>,
}

/// One key press while the menu is open. `Change` mirrors the TS
/// `onChange(id, newValue)` callback; the theme submenu's live preview and
/// its Esc restore come through as their own actions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsMenuAction {
    None,
    /// Esc from the top level (TS `onCancel`).
    Cancel,
    /// Enter/Space changed a row (or a submenu selected a value).
    Change {
        id: &'static str,
        value: String,
    },
    /// The theme submenu's selection moved: preview the theme live.
    PreviewTheme {
        name: String,
    },
    /// The theme submenu closed with Esc: restore the row's theme.
    RestoreTheme {
        name: String,
    },
}

/// The open submenu's own selection state (TS `SelectSubmenu`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct SubmenuState {
    row: usize,
    kind: SettingsSubmenu,
    selected: usize,
}

/// The settings menu (TS `SettingsList` with `enableSearch`).
#[derive(Debug)]
pub struct SettingsMenu {
    rows: Vec<SettingsMenuRow>,
    filtered: Vec<usize>,
    selected: usize,
    search: SearchInput,
    sub: Option<SubmenuState>,
    /// TS `SettingsList` maxVisible (the component is constructed with 10).
    max_visible: usize,
}

/// The TS settings-menu rows in the TS order, with the current values the
/// caller assembled (daemon state plus the settings seam).
pub fn settings_menu_rows(current: &SettingsCurrentValues) -> Vec<SettingsMenuRow> {
    let bool_value = || vec!["true".to_string(), "false".to_string()];
    let mut idle_values: Vec<String> = ["off"]
        .iter()
        .map(ToString::to_string)
        .chain([30, 60, 90, 180, 360].iter().map(ToString::to_string))
        .collect();
    if let Ok(minutes) = current.idle_eviction_minutes.parse::<u32>() {
        if minutes > 0 && !idle_values.contains(&minutes.to_string()) {
            idle_values.push(minutes.to_string());
            idle_values[1..].sort_by_key(|value| value.parse::<u32>().unwrap_or(0));
        }
    }
    vec![
        SettingsMenuRow {
            id: "autocompact",
            label: "Auto-compact",
            description: "Automatically compact context when it gets too large",
            current: current.autocompact.to_string(),
            values: Some(bool_value()),
            submenu: None,
        },
        SettingsMenuRow {
            id: "show-images",
            label: "Show image metadata",
            description: "Show image type and dimensions in terminal",
            current: current.show_images.to_string(),
            values: Some(bool_value()),
            submenu: None,
        },
        SettingsMenuRow {
            id: "auto-resize-images",
            label: "Auto-resize images",
            description: "Resize large images to 2000x2000 max for better model compatibility",
            current: current.auto_resize_images.to_string(),
            values: Some(bool_value()),
            submenu: None,
        },
        SettingsMenuRow {
            id: "block-images",
            label: "Block images",
            description: "Prevent images from being sent to LLM providers",
            current: current.block_images.to_string(),
            values: Some(bool_value()),
            submenu: None,
        },
        SettingsMenuRow {
            id: "skill-commands",
            label: "Skill commands",
            description: "Register skills as /skill:name commands",
            current: current.skill_commands.to_string(),
            values: Some(bool_value()),
            submenu: None,
        },
        SettingsMenuRow {
            id: "builtin-skills",
            label: "Built-in skills",
            description: "Load built-in skills shipped with prime-agent (takes effect after reload)",
            current: current.builtin_skills.to_string(),
            values: Some(bool_value()),
            submenu: None,
        },
        SettingsMenuRow {
            id: "show-hardware-cursor",
            label: "Show hardware cursor",
            description: "Show the terminal cursor while still positioning it for IME support",
            current: current.hardware_cursor.to_string(),
            values: Some(bool_value()),
            submenu: None,
        },
        SettingsMenuRow {
            id: "editor-padding",
            label: "Editor padding",
            description: "Horizontal padding for input editor (0-3)",
            current: current.editor_padding.to_string(),
            values: Some(vec!["0".into(), "1".into(), "2".into(), "3".into()]),
            submenu: None,
        },
        SettingsMenuRow {
            id: "autocomplete-max-visible",
            label: "Autocomplete max items",
            description: "Max visible items in autocomplete dropdown (3-20)",
            current: current.autocomplete_max_visible.to_string(),
            values: Some(vec!["3".into(), "5".into(), "7".into(), "10".into(), "15".into(), "20".into()]),
            submenu: None,
        },
        SettingsMenuRow {
            id: "clear-on-shrink",
            label: "Clear on shrink",
            description: "Clear empty rows when content shrinks (may cause flicker)",
            current: current.clear_on_shrink.to_string(),
            values: Some(bool_value()),
            submenu: None,
        },
        SettingsMenuRow {
            id: "terminal-progress",
            label: "Terminal progress",
            description: "Show OSC 9;4 progress indicators in the terminal tab bar",
            current: current.terminal_progress.to_string(),
            values: Some(bool_value()),
            submenu: None,
        },
        SettingsMenuRow {
            id: "fullscreen",
            label: "Fullscreen rendering",
            description: "Alternate-screen UI with scrollable transcript and pinned prompt",
            current: current.fullscreen.to_string(),
            values: Some(bool_value()),
            submenu: None,
        },
        SettingsMenuRow {
            id: "idle-eviction-minutes",
            label: "Idle worker eviction",
            description: "Stop fully idle agent trees after this many minutes (global daemon policy)",
            current: current.idle_eviction_minutes.clone(),
            values: Some(idle_values),
            submenu: None,
        },
        SettingsMenuRow {
            id: "steering-mode",
            label: "Steering mode",
            description: "Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
            current: current.steering_mode.clone(),
            values: Some(vec!["one-at-a-time".into(), "all".into()]),
            submenu: None,
        },
        SettingsMenuRow {
            id: "follow-up-mode",
            label: "Follow-up mode",
            description: "Alt+Enter queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
            current: current.follow_up_mode.clone(),
            values: Some(vec!["one-at-a-time".into(), "all".into()]),
            submenu: None,
        },
        SettingsMenuRow {
            id: "transport",
            label: "Transport",
            description: "Preferred transport for providers that support multiple transports",
            current: current.transport.clone(),
            values: Some(vec!["sse".into(), "websocket".into(), "websocket-cached".into(), "auto".into()]),
            submenu: None,
        },
        SettingsMenuRow {
            id: "mermaid-rendering",
            label: "Mermaid diagrams",
            description: "Render Mermaid code blocks as Unicode diagrams",
            current: current.mermaid.clone(),
            values: Some(vec!["off".into(), "final".into(), "streaming".into()]),
            submenu: None,
        },
        SettingsMenuRow {
            id: "quiet-startup",
            label: "Quiet startup",
            description: "Disable verbose printing at startup",
            current: current.quiet_startup.to_string(),
            values: Some(bool_value()),
            submenu: None,
        },
        SettingsMenuRow {
            id: "tree-filter-mode",
            label: "Tree filter mode",
            description: "Default filter when opening /tree",
            current: current.tree_filter_mode.clone(),
            values: Some(vec!["default".into(), "no-tools".into(), "user-only".into(), "labeled-only".into(), "all".into()]),
            submenu: None,
        },
        SettingsMenuRow {
            id: "warnings",
            label: "Warnings",
            description: "Enable or disable individual warnings",
            current: "configure".to_string(),
            values: None,
            submenu: Some(SettingsSubmenu::Warnings),
        },
        SettingsMenuRow {
            id: "thinking",
            label: "Thinking level",
            description: "Reasoning depth for thinking-capable models",
            current: current.thinking_level.clone().unwrap_or_default(),
            values: None,
            submenu: Some(SettingsSubmenu::Thinking {
                levels: current.available_thinking_levels.clone(),
            }),
        },
        SettingsMenuRow {
            id: "theme",
            label: "Theme",
            description: "Color theme for the interface",
            current: current.theme.clone(),
            values: None,
            submenu: Some(SettingsSubmenu::Theme {
                themes: current.available_themes.clone(),
            }),
        },
    ]
}

/// The row values the menu opens with: the daemon state (autocompact,
/// steering/follow-up, thinking) plus the settings seam reads.
#[derive(Debug, Clone, Default)]
pub struct SettingsCurrentValues {
    pub autocompact: bool,
    pub show_images: bool,
    pub auto_resize_images: bool,
    pub block_images: bool,
    pub skill_commands: bool,
    pub builtin_skills: bool,
    pub hardware_cursor: bool,
    pub editor_padding: u64,
    pub autocomplete_max_visible: u64,
    pub clear_on_shrink: bool,
    pub terminal_progress: bool,
    pub fullscreen: bool,
    pub idle_eviction_minutes: String,
    pub steering_mode: String,
    pub follow_up_mode: String,
    pub transport: String,
    pub mermaid: String,
    pub quiet_startup: bool,
    pub tree_filter_mode: String,
    pub warnings_anthropic_extra_usage: bool,
    pub thinking_level: Option<String>,
    pub available_thinking_levels: Vec<String>,
    pub theme: String,
    pub available_themes: Vec<String>,
}

impl SettingsMenu {
    pub fn new(rows: Vec<SettingsMenuRow>) -> Self {
        SettingsMenu {
            filtered: (0..rows.len()).collect(),
            rows,
            selected: 0,
            search: SearchInput::new(),
            sub: None,
            max_visible: 10,
        }
    }

    /// One key id (TS `SettingsList.handleInput`, submenu first).
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> SettingsMenuAction {
        if let Some(mut sub) = self.sub.take() {
            let action = self.handle_submenu_key(&mut sub, key, kb);
            // A value select or a theme restore closes the submenu (TS
            // `done()`); a plain navigation or live preview keeps it open.
            let closed = matches!(
                action,
                SettingsMenuAction::Change { .. } | SettingsMenuAction::RestoreTheme { .. }
            );
            if !closed {
                self.sub = Some(sub);
            }
            return action;
        }
        if kb.matches(key, "tui.select.up") {
            if !self.filtered.is_empty() {
                self.selected = if self.selected == 0 {
                    self.filtered.len() - 1
                } else {
                    self.selected - 1
                };
            }
            return SettingsMenuAction::None;
        }
        if kb.matches(key, "tui.select.down") {
            if !self.filtered.is_empty() {
                self.selected = (self.selected + 1) % self.filtered.len();
            }
            return SettingsMenuAction::None;
        }
        if key == " " || kb.matches(key, "tui.select.confirm") {
            return self.activate_selected();
        }
        if kb.matches(key, "tui.select.cancel") || key == "ctrl+c" {
            return SettingsMenuAction::Cancel;
        }
        // TS sanitizes the input (a bare space types nothing) and every
        // printable key edits the search field.
        if let [character] = key.chars().collect::<Vec<char>>()[..] {
            if !character.is_control() {
                self.search.handle_key(key, kb);
                self.apply_filter();
            }
        }
        SettingsMenuAction::None
    }

    /// Enter/Space on the selection (TS `activateItem`): submenus open;
    /// value rows cycle to the next value.
    fn activate_selected(&mut self) -> SettingsMenuAction {
        let Some(&row_index) = self.filtered.get(self.selected) else {
            return SettingsMenuAction::None;
        };
        let row = &mut self.rows[row_index];
        if let Some(kind) = row.submenu.clone() {
            self.sub = Some(SubmenuState {
                row: row_index,
                kind,
                selected: 0,
            });
            return SettingsMenuAction::None;
        }
        let Some(values) = &row.values else {
            return SettingsMenuAction::None;
        };
        let current = &row.current;
        let next = values
            .iter()
            .position(|value| value == current)
            .map_or(0, |index| (index + 1) % values.len());
        let value = values[next].clone();
        row.current.clone_from(&value);
        SettingsMenuAction::Change { id: row.id, value }
    }

    /// One key inside an open submenu (TS `SelectSubmenu.handleInput` —
    /// the `SelectList` gets every key; Enter selects, Esc goes back).
    fn handle_submenu_key(
        &mut self,
        sub: &mut SubmenuState,
        key: &str,
        kb: &KeybindingsManager,
    ) -> SettingsMenuAction {
        let options = match &sub.kind {
            SettingsSubmenu::Thinking { levels } => levels.len(),
            SettingsSubmenu::Theme { themes } => themes.len(),
            SettingsSubmenu::Warnings => 1,
        };
        if kb.matches(key, "tui.select.up") {
            if options > 0 {
                sub.selected = if sub.selected == 0 {
                    options - 1
                } else {
                    sub.selected - 1
                };
                return self.submenu_selection_change(sub);
            }
            return SettingsMenuAction::None;
        }
        if kb.matches(key, "tui.select.down") {
            if options > 0 {
                sub.selected = (sub.selected + 1) % options;
                return self.submenu_selection_change(sub);
            }
            return SettingsMenuAction::None;
        }
        if kb.matches(key, "tui.select.confirm") || key == " " {
            let row_id = self.rows[sub.row].id;
            let value = match &sub.kind {
                SettingsSubmenu::Thinking { levels } => {
                    levels
                        .get(sub.selected)
                        .cloned()
                        .map(|level| SettingsMenuAction::Change {
                            id: row_id,
                            value: level,
                        })
                }
                SettingsSubmenu::Theme { themes } => {
                    themes
                        .get(sub.selected)
                        .cloned()
                        .map(|name| SettingsMenuAction::Change {
                            id: row_id,
                            value: name,
                        })
                }
                SettingsSubmenu::Warnings => Some(SettingsMenuAction::Change {
                    id: "warnings-anthropic-extra-usage",
                    value: if sub.selected == 0 {
                        "true".into()
                    } else {
                        "false".into()
                    },
                }),
            };
            // TS `done(value)` closes the submenu and updates the row's
            // displayed value; the caller keeps its selected index (the
            // row it was opened from).
            if let Some(action) = value {
                if let SettingsMenuAction::Change { value, .. } = &action {
                    self.rows[sub.row].current.clone_from(value);
                }
                return action;
            }
            return SettingsMenuAction::None;
        }
        if kb.matches(key, "tui.select.cancel") || key == "ctrl+c" {
            // Theme: Esc restores the row's theme (TS `onThemePreview` with
            // the previous value); every submenu just goes back.
            return self.submenu_cancel(sub);
        }
        SettingsMenuAction::None
    }

    /// The selection-change side effect (TS `onSelectionChange` — only the
    /// theme submenu previews live).
    fn submenu_selection_change(&self, sub: &SubmenuState) -> SettingsMenuAction {
        match &sub.kind {
            SettingsSubmenu::Theme { themes } => themes
                .get(sub.selected)
                .map_or(SettingsMenuAction::None, |name| {
                    SettingsMenuAction::PreviewTheme { name: name.clone() }
                }),
            _ => SettingsMenuAction::None,
        }
    }

    /// The submenu's Esc behavior (TS `onCancel`): the theme submenu
    /// restores the theme the row opened with.
    fn submenu_cancel(&self, sub: &SubmenuState) -> SettingsMenuAction {
        match &sub.kind {
            SettingsSubmenu::Theme { .. } => SettingsMenuAction::RestoreTheme {
                name: self.rows[sub.row].current.clone(),
            },
            _ => SettingsMenuAction::None,
        }
    }

    /// Re-filter the rows (TS `applyFilter`, fuzzy over the label).
    fn apply_filter(&mut self) {
        let query = self.search.value();
        let kept: Vec<SettingsMenuRow> = if query.is_empty() {
            self.rows.clone()
        } else {
            crate::fuzzy::fuzzy_filter(&self.rows, query, |row| row.label.to_string())
        };
        self.filtered = kept
            .iter()
            .map(|row| {
                self.rows
                    .iter()
                    .position(|candidate| candidate == row)
                    .expect("fuzzy keeps row values")
            })
            .collect();
        self.selected = 0;
    }

    /// Render (TS `render`): the shared menu panel over the settings rows
    /// — the bordered search field, the windowed label/value rows, the
    /// scroll indicator, the selected row's description, and the hint
    /// line; a submenu replaces the whole list.
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<crate::Line> {
        if let Some(sub) = &self.sub {
            return self.render_submenu(sub, theme, width, kb);
        }
        let mut lines: Vec<crate::Line> = Vec::new();
        // The search field: the shared bordered field with its
        // placeholder.
        lines.extend(crate::menu_panel::search_field_lines(
            theme,
            width,
            self.search.value(),
            self.search.cursor(),
            true,
            "Search settings",
        ));
        if self.rows.is_empty() {
            lines.push(crate::menu_panel::no_match_row(
                theme,
                width,
                "No settings available",
            ));
            lines.push(crate::menu_panel::hint_row(theme, width, &hint(kb)));
            return lines;
        }
        if self.filtered.is_empty() {
            lines.push(crate::menu_panel::no_match_row(
                theme,
                width,
                "No matching settings",
            ));
            lines.push(crate::menu_panel::hint_row(theme, width, &hint(kb)));
            return lines;
        }
        let start = self
            .selected
            .saturating_sub(self.max_visible / 2)
            .min(self.filtered.len().saturating_sub(self.max_visible));
        let end = (start + self.max_visible).min(self.filtered.len());
        for (position, row_index) in self.filtered[start..end].iter().enumerate() {
            let position = start + position;
            let row = &self.rows[*row_index];
            let selected = position == self.selected;
            lines.push(crate::menu_panel::menu_row(
                theme,
                width,
                vec![crate::Span::raw(row.label.clone())],
                &[crate::menu_panel::MenuSegment::muted(&row.current)],
                selected,
            ));
        }
        if start > 0 || end < self.filtered.len() {
            lines.push(crate::menu_panel::scroll_row(
                theme,
                width,
                self.selected + 1,
                self.filtered.len(),
            ));
        }
        if let Some(&row_index) = self.filtered.get(self.selected) {
            let row = &self.rows[row_index];
            if !row.description.is_empty() {
                lines.push(Vec::new());
                for line in wrap_text(row.description, width.saturating_sub(4)) {
                    let plain: String = line.iter().map(|span| span.content.as_str()).collect();
                    lines.push(crate::width::truncate_line(
                        &vec![
                            crate::Span::raw("  ".to_string()),
                            crate::Span::styled(plain, theme.fg_style(ThemeColor::Dim)),
                        ],
                        width,
                        "",
                    ));
                }
            }
        }
        lines.push(crate::menu_panel::hint_row(theme, width, &hint(kb)));
        lines
    }

    /// The submenu render (TS `SelectSubmenu`): accent title, muted
    /// description, the shared menu rows over the option list, and the
    /// back hint.
    fn render_submenu(
        &self,
        sub: &SubmenuState,
        theme: &Theme,
        width: usize,
        kb: &KeybindingsManager,
    ) -> Vec<crate::Line> {
        let (title, description, options): (&str, &str, Vec<(String, Option<&'static str>)>) =
            match &sub.kind {
                SettingsSubmenu::Thinking { levels } => (
                    "Thinking Level",
                    "Select reasoning depth for thinking-capable models",
                    levels
                        .iter()
                        .map(|level| (level.clone(), Some(thinking_description(level))))
                        .collect(),
                ),
                SettingsSubmenu::Theme { themes } => (
                    "Theme",
                    "Select color theme",
                    themes.iter().map(|name| (name.clone(), None)).collect(),
                ),
                SettingsSubmenu::Warnings => (
                    "Warnings",
                    "Enable or disable individual warnings",
                    vec![(String::from("Anthropic extra usage"), None)],
                ),
            };
        let mut lines: Vec<crate::Line> = Vec::new();
        lines.push(vec![theme.fg_span(ThemeColor::Accent, title)]);
        if !description.is_empty() {
            lines.push(Vec::new());
            lines.push(vec![theme.fg_span(ThemeColor::Muted, description)]);
        }
        lines.push(Vec::new());
        let max_visible = options.len().min(10);
        let start = sub
            .selected
            .saturating_sub(max_visible / 2)
            .min(options.len().saturating_sub(max_visible));
        let end = (start + max_visible).min(options.len());
        for (position, (value, description)) in options[start..end].iter().enumerate() {
            let position = start + position;
            let selected = position == sub.selected;
            let trailing: Vec<crate::menu_panel::MenuSegment> = description
                .map(|description| vec![crate::menu_panel::MenuSegment::muted(description)])
                .unwrap_or_default();
            lines.push(crate::menu_panel::menu_row(
                theme,
                width,
                vec![crate::Span::raw(value.clone())],
                &trailing,
                selected,
            ));
        }
        lines.push(Vec::new());
        lines.push(crate::menu_panel::hint_row(theme, width, &submenu_hint(kb)));
        lines
    }
}

/// The menu's key hint: the shared hint-row grammar, this surface's
/// vocabulary (the search field types, Enter/Space cycles a row).
fn hint(kb: &KeybindingsManager) -> String {
    let select_key = kb
        .first_key("tui.select.confirm")
        .map_or_else(|| "Enter".to_string(), |key| format_key_text(&key));
    let close_key = kb
        .first_key("tui.select.cancel")
        .map_or_else(|| "Esc".to_string(), |key| format_key_text(&key));
    format!("Type to search · {select_key}/Space change · {close_key} close")
}

/// The submenu's key hint (TS `SelectSubmenu`'s back row): the selected
/// value applies, the cancel binding goes back.
fn submenu_hint(kb: &KeybindingsManager) -> String {
    let select_key = kb
        .first_key("tui.select.confirm")
        .map_or_else(|| "Enter".to_string(), |key| format_key_text(&key));
    let back_key = kb
        .first_key("tui.select.cancel")
        .map_or_else(|| "Esc".to_string(), |key| format_key_text(&key));
    format!("{select_key} select · {back_key} back")
}

#[cfg(test)]
mod menu_tests {
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
    fn rows_follow_the_ts_splice_order() {
        let rows = menu();
        let ids: Vec<&str> = rows.rows.iter().map(|row| row.id).collect();
        assert_eq!(
            ids,
            vec![
                "autocompact",
                "show-images",
                "auto-resize-images",
                "block-images",
                "skill-commands",
                "builtin-skills",
                "show-hardware-cursor",
                "editor-padding",
                "autocomplete-max-visible",
                "clear-on-shrink",
                "terminal-progress",
                "fullscreen",
                "idle-eviction-minutes",
                "steering-mode",
                "follow-up-mode",
                "transport",
                "mermaid-rendering",
                "quiet-startup",
                "tree-filter-mode",
                "warnings",
                "thinking",
                "theme",
            ]
        );
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
        // Walk to the thinking row (the 21st).
        for _ in 0..20 {
            menu.handle_key("down", &kb());
        }
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
        assert!(text
            .iter()
            .any(|row| row.contains("Type to search · Enter/Space change · Esc close")));
    }

    #[test]
    fn theme_submenu_previews_and_esc_restores() {
        let mut menu = menu();
        // Walk to the theme row (the 22nd).
        for _ in 0..21 {
            menu.handle_key("down", &kb());
        }
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
    fn typing_filters_and_esc_cancels() {
        let mut menu = menu();
        for key in ["t", "r", "a", "n", "s", "p"] {
            menu.handle_key(key, &kb());
        }
        let text = render_text(&menu);
        // The filter keeps the transport row visible and drops unrelated
        // rows from the window.
        assert!(text.iter().any(|row| row.contains("Transport")));
        assert!(!text.iter().any(|row| row.contains("Auto-compact")));
        assert_eq!(menu.handle_key("esc", &kb()), SettingsMenuAction::Cancel);
    }

    #[test]
    fn render_shows_value_and_selected_description() {
        let text = render_text(&menu());
        assert!(text.iter().any(|row| row.contains("Auto-compact")));
        assert!(text
            .iter()
            .any(|row| row.contains("Automatically compact context when it gets too large")));
        assert!(text
            .iter()
            .any(|row| row.contains("Type to search · Enter/Space change · Esc close")));
        // The selected first row carries the menu marker and its value
        // rides the row's trailing cluster (the shared menu-row grammar).
        assert!(text.iter().any(|row| row.contains("\u{203a} Auto-compact")));
        assert!(text.iter().any(|row| row.contains("on ")));
    }
}
