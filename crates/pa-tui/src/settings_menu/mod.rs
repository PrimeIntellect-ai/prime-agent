//! The `/settings` inline menu: a tab strip under the bordered search field, each tab a list of
//! label/value rows the arrows and Enter/Space cycle (the operator's 2026-09-28 rebind: tabs move
//! on Tab/number keys only), Enter opens submenus, type-to-search per tab. The caller owns the row
//! data and change actions; this module navigation and rendering.

mod tabs;

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::search_input::SearchInput;
use crate::theme::{Theme, ThemeColor};
use crate::width::wrap_text;

/// The reasoning-level descriptions the TS thinking submenu lists.
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

/// A submenu a row opens with Enter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsSubmenu {
    /// "Thinking Level" (the session's available levels).
    Thinking { levels: Vec<String> },
    /// "Theme" (the registered themes; selection previews).
    Theme { themes: Vec<String> },
    /// "Warnings" (the single warning toggle as its own list).
    Warnings,
    /// "Default Service Tier" (TS `SERVICE_TIER_OPTIONS`).
    ServiceTier,
}

/// The service-tier descriptions the TS settings submenu lists.
#[must_use]
pub fn service_tier_description(tier: &str) -> &'static str {
    match tier {
        "default" => "Standard processing",
        "flex" => "Cheaper, slower, may hit capacity limits",
        "priority" => "Faster, more expensive (fast mode)",
        "auto" => "Provider picks the tier",
        _ => "",
    }
}

/// The settings-row and autocomplete choice order.
pub const SERVICE_TIER_CHOICES: [&str; 4] = ["default", "flex", "priority", "auto"];

/// One settings row.
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

/// One key press while the menu is open. The theme submenu's live preview
/// and its Esc restore come through as their own actions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsMenuAction {
    None,
    /// Esc from the top level.
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
    /// Esc inside a submenu closed it; the menu itself stays open.
    SubmenuClosed,
    /// The theme submenu closed with Esc: restore the row's theme.
    RestoreTheme {
        name: String,
    },
}

/// The open submenu's own selection state.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SubmenuState {
    row: usize,
    kind: SettingsSubmenu,
    selected: usize,
}

/// The settings menu: the strip rides under the search field, each tab
/// owns its own search input, filtered window, and selection.
#[derive(Debug)]
pub struct SettingsMenu {
    rows: Vec<SettingsMenuRow>,
    tabs: Vec<SettingsTab>,
    tab: usize,
    sub: Option<SubmenuState>,
    max_visible: usize,
}

/// One tab: the row indices it groups with its own search input, filtered window, and selection —
/// switching moves the focus only, so coming back restores where the user was.
#[derive(Debug)]
struct SettingsTab {
    name: &'static str,
    rows: Vec<usize>,
    filtered: Vec<usize>,
    search: SearchInput,
    selected: usize,
}

/// The TS settings-menu rows in the TS order, with the caller-assembled
/// current values.
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
            id: "default-service-tier",
            label: "Default service tier",
            description: "Service tier for new sessions; applies to the current session when the model supports it",
            current: current.default_service_tier.clone(),
            values: None,
            submenu: Some(SettingsSubmenu::ServiceTier),
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

/// The row values the menu opens with: the daemon state plus the settings
/// seam reads.
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
    pub idle_eviction_minutes: String,
    pub steering_mode: String,
    pub follow_up_mode: String,
    pub transport: String,
    pub default_service_tier: String,
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
    #[must_use]
    pub fn new(rows: Vec<SettingsMenuRow>) -> Self {
        let tabs = tabs::row_indices(&rows)
            .into_iter()
            .map(|(name, rows)| SettingsTab {
                name,
                filtered: rows.clone(),
                rows,
                search: SearchInput::new(),
                selected: 0,
            })
            .collect();
        SettingsMenu {
            tabs,
            tab: 0,
            rows,
            sub: None,
            max_visible: 10,
        }
    }

    fn active_mut(&mut self) -> &mut SettingsTab {
        &mut self.tabs[self.tab]
    }

    /// One key id: the submenu, when open, takes it first.
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> SettingsMenuAction {
        if let Some(mut sub) = self.sub.take() {
            let action = self.handle_submenu_key(&mut sub, key, kb);
            // A value select, a theme restore, or the submenu's Esc closes the
            // submenu; a plain navigation or live preview keeps it open.
            let closed = matches!(
                action,
                SettingsMenuAction::Change { .. }
                    | SettingsMenuAction::RestoreTheme { .. }
                    | SettingsMenuAction::SubmenuClosed
            );
            if !closed {
                self.sub = Some(sub);
            }
            return action;
        }
        // An empty row set carries no tabs: only the close keys act.
        if self.tabs.is_empty() {
            if kb.matches(key, "tui.select.cancel") || key == "ctrl+c" {
                return SettingsMenuAction::Cancel;
            }
            return SettingsMenuAction::None;
        }
        // Tab switching (the operator's 2026-09-28 rebind: the tabs move with Tab and the number
        // keys ONLY, freeing the arrows for value cycling): digits jump straight to their tab while
        // the search field is empty (an active query takes digits as search text).
        match key {
            "shift+tab" => {
                self.switch_tab((self.tab + self.tabs.len() - 1) % self.tabs.len());
                return SettingsMenuAction::None;
            }
            "tab" => {
                self.switch_tab((self.tab + 1) % self.tabs.len());
                return SettingsMenuAction::None;
            }
            _ => {}
        }
        // The arrows cycle the focused setting's value in place (a submenu row
        // has no inline values, so they no-op there).
        if key == "left" {
            return self.cycle_selected(-1);
        }
        if key == "right" {
            return self.cycle_selected(1);
        }
        if self.tabs[self.tab].search.value().is_empty() {
            if let [character] = key.chars().collect::<Vec<char>>()[..] {
                if let Some(tab) = character
                    .to_digit(10)
                    .filter(|digit| *digit > 0)
                    .map(|digit| digit as usize - 1)
                    .filter(|tab| *tab < self.tabs.len())
                {
                    self.switch_tab(tab);
                    return SettingsMenuAction::None;
                }
            }
        }
        if kb.matches(key, "tui.select.up") {
            let tab = self.active_mut();
            if !tab.filtered.is_empty() {
                tab.selected = if tab.selected == 0 {
                    tab.filtered.len() - 1
                } else {
                    tab.selected - 1
                };
            }
            return SettingsMenuAction::None;
        }
        if kb.matches(key, "tui.select.down") {
            let tab = self.active_mut();
            if !tab.filtered.is_empty() {
                tab.selected = (tab.selected + 1) % tab.filtered.len();
            }
            return SettingsMenuAction::None;
        }
        if key == "space" || kb.matches(key, "tui.select.confirm") {
            return self.activate_selected();
        }
        if kb.matches(key, "tui.select.cancel") || key == "ctrl+c" {
            return SettingsMenuAction::Cancel;
        }
        // TS `SettingsList.handleInput`: Space stays the row activation
        // above; every other key id goes whole to the active tab's search
        // input.
        let tab = self.active_mut();
        let previous = tab.search.value().to_string();
        tab.search.handle_key(key, kb);
        // The filter re-runs only when the query changed (the config
        // selector's rule): a caret-only key keeps the selection.
        let changed = tab.search.value() != previous;
        if changed {
            self.apply_filter();
        }
        SettingsMenuAction::None
    }

    /// One bracketed paste into the active tab's search field (TS routes
    /// the raw paste data to the `Input`): the sanitize strips the spaces
    /// (Space stays the row activation), and the filter re-runs when the
    /// query changed.
    pub fn paste(&mut self, text: &str) {
        // The submenu owns the frame while open (its key dispatch takes
        // every key first): a paste never edits the hidden parent list.
        if self.sub.is_some() {
            return;
        }
        // An empty row set carries no tabs (the menu renders its empty
        // state): nothing to paste into.
        if self.tabs.is_empty() {
            return;
        }
        let sanitized = text.replace(' ', "");
        let tab = self.active_mut();
        let previous = tab.search.value().to_string();
        tab.search.paste(&sanitized);
        let changed = tab.search.value() != previous;
        if changed {
            self.apply_filter();
        }
    }

    /// Enter/Space on the selection (TS `activateItem`): submenus open;
    /// value rows cycle to the next value.
    fn activate_selected(&mut self) -> SettingsMenuAction {
        let Some(tab) = self.tabs.get(self.tab) else {
            return SettingsMenuAction::None;
        };
        let Some(&row_index) = tab.filtered.get(tab.selected) else {
            return SettingsMenuAction::None;
        };
        let row = &mut self.rows[row_index];
        if let Some(kind) = row.submenu.clone() {
            // The tier submenu preselects the row's current tier.
            let selected = match &kind {
                SettingsSubmenu::ServiceTier => SERVICE_TIER_CHOICES
                    .iter()
                    .position(|tier| *tier == row.current)
                    .unwrap_or(0),
                _ => 0,
            };
            self.sub = Some(SubmenuState {
                row: row_index,
                kind,
                selected,
            });
            return SettingsMenuAction::None;
        }
        self.cycle_selected(1)
    }

    /// Cycle the selected row's value by `delta` steps, wrapping at the list's ends, and report the
    /// change. A submenu row (no inline values) and a missing selection no-op.
    fn cycle_selected(&mut self, delta: isize) -> SettingsMenuAction {
        let Some(tab) = self.tabs.get(self.tab) else {
            return SettingsMenuAction::None;
        };
        let Some(&row_index) = tab.filtered.get(tab.selected) else {
            return SettingsMenuAction::None;
        };
        let row = &mut self.rows[row_index];
        let Some(values) = &row.values else {
            return SettingsMenuAction::None;
        };
        let count = values.len();
        let index = values
            .iter()
            .position(|value| *value == row.current)
            .map_or(0, |index| {
                (index as isize + delta).rem_euclid(count as isize) as usize
            });
        let value = values[index].clone();
        row.current.clone_from(&value);
        SettingsMenuAction::Change { id: row.id, value }
    }

    /// One key inside an open submenu: Enter selects, Esc goes back.
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
            SettingsSubmenu::ServiceTier => SERVICE_TIER_CHOICES.len(),
        };
        if kb.matches(key, "tui.select.up") {
            if options > 0 {
                sub.selected = if sub.selected == 0 {
                    options - 1
                } else {
                    sub.selected - 1
                };
                return Self::submenu_selection_change(sub);
            }
            return SettingsMenuAction::None;
        }
        if kb.matches(key, "tui.select.down") {
            if options > 0 {
                sub.selected = (sub.selected + 1) % options;
                return Self::submenu_selection_change(sub);
            }
            return SettingsMenuAction::None;
        }
        if kb.matches(key, "tui.select.confirm") || key == "space" {
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
                SettingsSubmenu::ServiceTier => SERVICE_TIER_CHOICES
                    .get(sub.selected)
                    .copied()
                    .map(|tier| SettingsMenuAction::Change {
                        id: row_id,
                        value: tier.to_string(),
                    }),
            };
            // A value select closes the submenu and updates the row's displayed value.
            if let Some(action) = value {
                if let SettingsMenuAction::Change { value, .. } = &action {
                    self.rows[sub.row].current.clone_from(value);
                }
                return action;
            }
            return SettingsMenuAction::None;
        }
        if kb.matches(key, "tui.select.cancel") || key == "ctrl+c" {
            // Theme: Esc restores the row's theme; every submenu just goes back.
            return self.submenu_cancel(sub);
        }
        SettingsMenuAction::None
    }

    /// The selection-change side effect: only the theme submenu previews live.
    fn submenu_selection_change(sub: &SubmenuState) -> SettingsMenuAction {
        match &sub.kind {
            SettingsSubmenu::Theme { themes } => themes
                .get(sub.selected)
                .map_or(SettingsMenuAction::None, |name| {
                    SettingsMenuAction::PreviewTheme { name: name.clone() }
                }),
            _ => SettingsMenuAction::None,
        }
    }

    /// The submenu's Esc behavior: the theme submenu restores the theme the
    /// row opened with.
    fn submenu_cancel(&self, sub: &SubmenuState) -> SettingsMenuAction {
        match &sub.kind {
            SettingsSubmenu::Theme { .. } => SettingsMenuAction::RestoreTheme {
                name: self.rows[sub.row].current.clone(),
            },
            // Every other submenu just goes back; the menu itself stays open.
            _ => SettingsMenuAction::SubmenuClosed,
        }
    }

    /// Switch to a tab: a pure focus move, nothing resets.
    fn switch_tab(&mut self, tab: usize) {
        self.tab = tab;
    }

    /// Re-filter the active tab's rows (fuzzy over the label): a fresh query
    /// lands the tab's selection on its first match.
    fn apply_filter(&mut self) {
        let query = self.tabs[self.tab].search.value().to_string();
        let tab = &mut self.tabs[self.tab];
        tab.filtered = if query.is_empty() {
            tab.rows.clone()
        } else {
            let candidates: Vec<SettingsMenuRow> = tab
                .rows
                .iter()
                .map(|&index| self.rows[index].clone())
                .collect();
            crate::fuzzy::fuzzy_filter(&candidates, &query, |row| row.label.to_string())
                .iter()
                .map(|row| {
                    tab.rows
                        .iter()
                        .find(|&index| &self.rows[*index] == row)
                        .copied()
                        .expect("fuzzy keeps row values")
                })
                .collect()
        };
        tab.selected = 0;
    }

    /// Render the shared menu panel over the settings rows; a submenu replaces
    /// the whole list.
    #[must_use]
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<crate::Line> {
        if let Some(sub) = &self.sub {
            return Self::render_submenu(sub, theme, width, kb);
        }
        let mut lines: Vec<crate::Line> = Vec::new();
        if self.rows.is_empty() {
            lines.push(crate::menu_panel::no_match_row(
                theme,
                width,
                "No settings available",
            ));
            lines.push(hint_row(theme, width, &hint(kb, 0)));
            return lines;
        }
        let tab = &self.tabs[self.tab];
        lines.extend(crate::menu_panel::search_field_lines(
            theme,
            width,
            tab.search.value(),
            tab.search.cursor(),
            true,
            "Search settings",
        ));
        // The tab strip sits under the search field with a blank row on either
        // side (the operator's 2026-09-28 spacing pass).
        lines.push(Vec::new());
        let names: Vec<&'static str> = self.tabs.iter().map(|tab| tab.name).collect();
        lines.push(tabs::strip_row(theme, width, &names, self.tab));
        lines.push(Vec::new());
        if tab.filtered.is_empty() {
            lines.push(crate::menu_panel::no_match_row(
                theme,
                width,
                "No matching settings",
            ));
            lines.push(hint_row(theme, width, &hint(kb, self.tabs.len())));
            return lines;
        }
        let start = tab
            .selected
            .saturating_sub(self.max_visible / 2)
            .min(tab.filtered.len().saturating_sub(self.max_visible));
        let end = (start + self.max_visible).min(tab.filtered.len());
        for (position, &row_index) in tab.filtered[start..end].iter().enumerate() {
            let position = start + position;
            let row = &self.rows[row_index];
            let selected = position == tab.selected;
            lines.push(crate::menu_panel::menu_row(
                theme,
                width,
                vec![crate::Span::raw(row.label)],
                &[crate::menu_panel::MenuSegment::muted(&row.current)],
                selected,
            ));
        }
        if start > 0 || end < tab.filtered.len() {
            lines.push(crate::menu_panel::scroll_row(
                theme,
                width,
                tab.selected + 1,
                tab.filtered.len(),
            ));
        }
        if let Some(&row_index) = tab.filtered.get(tab.selected) {
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
                // The separator rule closes the detail block (the operator's 2026-09-28
                // directive).
                lines.push(crate::menu_panel::rule_row(theme, width));
            }
        }
        lines.push(hint_row(theme, width, &hint(kb, self.tabs.len())));
        lines
    }

    /// The submenu render: accent title, muted description, the shared menu
    /// rows, and the back hint.
    fn render_submenu(
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
                SettingsSubmenu::ServiceTier => (
                    "Default Service Tier",
                    "Service tier for new sessions; applies to the current session when the model supports it",
                    SERVICE_TIER_CHOICES
                        .iter()
                        .map(|tier| (tier.to_string(), Some(service_tier_description(tier))))
                        .collect(),
                ),
            };
        let mut lines: Vec<crate::Line> = Vec::new();
        // The list view's full-width top rule stays over the submenu too (the
        // operator's 2026-09-28 regression pin).
        lines.push(crate::menu_panel::rule_row(theme, width));
        // The setting's name and description carry the list rows' padding-x (the
        // operator's 2026-09-28 regression pin).
        lines.push(crate::width::truncate_line(
            &vec![
                crate::Span::raw("  ".to_string()),
                theme.fg_span(ThemeColor::Accent, title.to_string()),
            ],
            width,
            "",
        ));
        if !description.is_empty() {
            lines.push(Vec::new());
            lines.push(crate::width::truncate_line(
                &vec![
                    crate::Span::raw("  ".to_string()),
                    theme.fg_span(ThemeColor::Muted, description.to_string()),
                ],
                width,
                "",
            ));
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
        lines.push(hint_row(theme, width, &submenu_hint(kb)));
        lines
    }
}

/// The settings page's own key-hint row: this surface's keyboard-shortcuts row carries the
/// two-space inner column the detail block aligns on (the operator's 2026-09-28 padding pass).
fn hint_row(theme: &Theme, width: usize, hint: &str) -> crate::Line {
    let line = vec![
        crate::Span::raw("  ".to_string()),
        theme.fg_span(ThemeColor::Dim, hint.to_string()),
    ];
    crate::width::truncate_line(&line, width, "")
}

/// The menu's key hint: Space is a literal key the menu always handles; an
/// unbound Enter drops its label, an unbound Esc drops the close segment.
fn hint(kb: &KeybindingsManager, tabs: usize) -> String {
    let mut segments = vec!["Type to search".to_string()];
    if tabs > 0 {
        segments.push(format!("{}/1-{tabs} tabs", format_key_text("tab")));
    }
    let arrows = format!("{}/{}", format_key_text("left"), format_key_text("right"));
    segments.push(match kb.first_key("tui.select.confirm") {
        Some(key) => format!("{arrows}/{}/Space change", format_key_text(&key)),
        None => format!("{arrows}/Space change"),
    });
    if let Some(close) = crate::menu_panel::key_hint(kb, &["tui.select.cancel"], "close") {
        segments.push(close);
    }
    segments.join(" · ")
}

/// The submenu's key hint: an unbound action is omitted, never advertised
/// with a default key.
fn submenu_hint(kb: &KeybindingsManager) -> String {
    [
        crate::menu_panel::key_hint(kb, &["tui.select.confirm"], "select"),
        crate::menu_panel::key_hint(kb, &["tui.select.cancel"], "back"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<String>>()
    .join(" · ")
}

#[cfg(test)]
mod menu_tests;
