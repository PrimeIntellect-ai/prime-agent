//! The resource-configuration modal: a filterable, grouped checkbox list
//! over session resources with Space to toggle and Esc to close. The
//! caller supplies flat rows; this module owns filtering, selection, and
//! the terminal loop, rendered through the shared menu-panel grammar.

use anyhow::Result;
use crossterm::event::{Event, KeyEvent};
use crossterm::terminal::{self};
use ratatui::Terminal;
use std::time::{Duration, Instant};

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::keys::key_event_to_id;
use crate::search_input::SearchInput;
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};

/// One flat selector row. `Item` rows carry the caller's identity key and
/// the texts the filter matches against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectorRow {
    Group(String),
    Subgroup(String),
    Item {
        key: String,
        label: String,
        checked: bool,
        type_label: String,
        path: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectorAction {
    /// Esc: close the view.
    Close,
    /// `app.clear`: exit the process (#2493 — the exit key is remappable).
    Exit,
    /// Space/Enter on an item: persist `enabled` for `key`; the selector
    /// has already flipped its row.
    Toggle { key: String, enabled: bool },
}

/// The maximum rows the list shows at once.
const MAX_VISIBLE: usize = 15;

/// The selector's frame chrome: which surface is being picked (the list,
/// filter, and selection behavior are shared).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectorKind {
    /// The resource-configuration modal (`prime-agent config`): checkbox
    /// semantics, Space toggles.
    ResourceConfig,
    /// The `/effort` picker: single-select semantics, Enter applies.
    Effort,
}

impl SelectorKind {
    /// The frame title and its `(key, action)` hint vocabulary.
    fn header(self) -> (&'static str, &'static [(&'static str, &'static str)]) {
        match self {
            SelectorKind::ResourceConfig => (
                "Resource Configuration",
                &[("space", "toggle"), ("escape", "close")],
            ),
            SelectorKind::Effort => (
                "Thinking Level",
                &[("enter", "select"), ("escape", "close")],
            ),
        }
    }
}

/// The selector state: rows, the active filter, and the cursor position
/// within the filtered view.
#[derive(Debug, Clone)]
pub struct ConfigSelector {
    kind: SelectorKind,
    rows: Vec<SelectorRow>,
    filtered: Vec<usize>,
    search: SearchInput,
    selected: usize,
}

impl ConfigSelector {
    /// Build the resource-configuration selector from flat rows.
    #[must_use]
    pub fn new(rows: Vec<SelectorRow>) -> Self {
        Self::with_kind(rows, SelectorKind::ResourceConfig)
    }

    /// Build the selector for a specific surface (`/effort` uses
    /// [`SelectorKind::Effort`]).
    #[must_use]
    pub fn with_kind(rows: Vec<SelectorRow>, kind: SelectorKind) -> Self {
        let filtered = (0..rows.len()).collect();
        let mut selector = ConfigSelector {
            kind,
            rows,
            filtered,
            search: SearchInput::new(),
            selected: 0,
        };
        selector.select_first_item();
        selector
    }

    /// The selector's frame kind.
    #[must_use]
    pub fn kind(&self) -> SelectorKind {
        self.kind
    }

    /// The current filter query.
    #[must_use]
    pub fn query(&self) -> &str {
        self.search.value()
    }

    /// Replace the filter query in one step (the `/model <search>` prefill;
    /// typing the same characters one key at a time cannot express a
    /// space, which the key loop treats as toggle). The caret lands at
    /// the prefill's end, so the next keystroke extends it.
    pub fn set_query(&mut self, query: &str) {
        self.search.prefill(query);
        self.apply_filter();
    }

    /// A bracketed paste into the filter (TS the search `Input`'s paste).
    pub fn paste(&mut self, text: &str) {
        self.search.paste(text);
        self.apply_filter();
    }

    /// The checked state of one item row.
    #[must_use]
    pub fn checked(&self, key: &str) -> Option<bool> {
        self.rows.iter().find_map(|row| match row {
            SelectorRow::Item {
                key: row_key,
                checked,
                ..
            } => (row_key == key).then_some(*checked),
            _ => None,
        })
    }

    /// Apply a new checked state to one item row (after the settings write
    /// settled).
    pub fn set_checked(&mut self, key: &str, checked: bool) {
        for row in &mut self.rows {
            if let SelectorRow::Item {
                key: row_key,
                checked: row_checked,
                ..
            } = row
            {
                if row_key == key {
                    *row_checked = checked;
                    return;
                }
            }
        }
    }

    /// Move the selection to one filtered position when it holds an item
    /// row; group and subgroup rows keep the selection where it was.
    pub fn select_position(&mut self, position: usize) {
        if self.is_item(position) {
            self.selected = position;
        }
    }

    /// The filtered positions the list window renders (the click
    /// surface's item-row span).
    #[must_use]
    pub fn visible_window(&self) -> (usize, usize) {
        if self.filtered.is_empty() {
            return (0, 0);
        }
        let start = self
            .selected
            .saturating_sub(MAX_VISIBLE / 2)
            .min(self.filtered.len().saturating_sub(MAX_VISIBLE));
        (start, (start + MAX_VISIBLE).min(self.filtered.len()))
    }

    /// One key id.
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> Option<SelectorAction> {
        if kb.matches(key, "tui.select.up") {
            self.selected = self.find_next_item(self.selected, -1);
            return None;
        }
        if kb.matches(key, "tui.select.down") {
            self.selected = self.find_next_item(self.selected, 1);
            return None;
        }
        if kb.matches(key, "tui.select.pageUp") {
            let target = self.selected.saturating_sub(MAX_VISIBLE);
            self.selected = self.nearest_item_forward(target);
            return None;
        }
        if kb.matches(key, "tui.select.pageDown") {
            let target = (self.selected + MAX_VISIBLE).min(self.filtered.len().saturating_sub(1));
            self.selected = self.nearest_item_backward(target);
            return None;
        }
        if kb.matches(key, "tui.select.cancel") {
            return Some(SelectorAction::Close);
        }
        if kb.matches(key, "app.clear") {
            return Some(SelectorAction::Exit);
        }
        if key == "space" || kb.matches(key, "tui.select.confirm") {
            return self.toggle_selected();
        }
        // TS `ConfigSelectorComponent.handleInput`'s final arm: every
        // other key id goes whole to the search `Input`.
        let previous = self.search.value().to_string();
        self.search.handle_key(key, kb);
        if self.search.value() != previous {
            self.apply_filter();
        }
        None
    }

    /// Flip the selected item and report the caller-visible toggle.
    fn toggle_selected(&mut self) -> Option<SelectorAction> {
        let index = self.filtered.get(self.selected).copied()?;
        let row = self.rows.get_mut(index)?;
        if let SelectorRow::Item {
            key,
            label: _,
            checked,
            type_label: _,
            path: _,
        } = row
        {
            *checked = !*checked;
            let enabled = *checked;
            return Some(SelectorAction::Toggle {
                key: key.clone(),
                enabled,
            });
        }
        None
    }

    /// The nearest item row at or after `from`.
    fn nearest_item_forward(&self, from: usize) -> usize {
        let mut index = from;
        while index < self.filtered.len() {
            if self.is_item(index) {
                return index;
            }
            index += 1;
        }
        self.selected
    }

    /// The nearest item row at or before `from`.
    fn nearest_item_backward(&self, from: usize) -> usize {
        let mut index = from as isize;
        while index >= 0 {
            if self.is_item(index as usize) {
                return index as usize;
            }
            index -= 1;
        }
        self.selected
    }

    fn is_item(&self, filtered_index: usize) -> bool {
        self.filtered
            .get(filtered_index)
            .is_some_and(|row_index| matches!(self.rows[*row_index], SelectorRow::Item { .. }))
    }

    /// Walk to the next/previous item row, skipping group headers (stays
    /// put when no item lies that way).
    fn find_next_item(&self, from: usize, direction: isize) -> usize {
        let mut index = from as isize + direction;
        while index >= 0 && (index as usize) < self.filtered.len() {
            if self.is_item(index as usize) {
                return index as usize;
            }
            index += direction;
        }
        from
    }

    /// Select the first item row of the filtered view (TS `selectFirstItem`).
    fn select_first_item(&mut self) {
        self.selected = self
            .filtered
            .iter()
            .position(|row_index| matches!(self.rows[*row_index], SelectorRow::Item { .. }))
            .unwrap_or(0);
    }

    /// Rebuild the filtered view: items matching the query, plus the group
    /// and subgroup rows that contain them (TS `filterItems`).
    fn apply_filter(&mut self) {
        if self.search.value().trim().is_empty() {
            self.filtered = (0..self.rows.len()).collect();
            self.select_first_item();
            return;
        }
        let query = self.search.value().to_lowercase();
        let item_matches = |row: &SelectorRow| match row {
            SelectorRow::Item {
                label,
                type_label,
                path,
                ..
            } => {
                label.to_lowercase().contains(&query)
                    || type_label.to_lowercase().contains(&query)
                    || path.to_lowercase().contains(&query)
            }
            _ => false,
        };
        // Mark matching items, then the group and subgroup headers whose
        // item region contains one.
        let mut item_kept = vec![false; self.rows.len()];
        for (index, row) in self.rows.iter().enumerate() {
            item_kept[index] = item_matches(row);
        }
        let mut header_kept = vec![false; self.rows.len()];
        let mut group_open = None;
        let mut subgroup_open = false;
        for (index, row) in self.rows.iter().enumerate() {
            match row {
                SelectorRow::Group(_) => {
                    group_open = Some(index);
                    subgroup_open = false;
                }
                SelectorRow::Subgroup(_) => {
                    subgroup_open = true;
                }
                SelectorRow::Item { .. } => {
                    if item_kept[index] {
                        if let Some(group) = group_open {
                            header_kept[group] = true;
                        }
                        if subgroup_open {
                            // Mark the nearest preceding subgroup row.
                            for back in (0..index).rev() {
                                if matches!(self.rows[back], SelectorRow::Subgroup(_)) {
                                    header_kept[back] = true;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
        self.filtered = (0..self.rows.len())
            .filter(|index| item_kept[*index] || header_kept[*index])
            .collect();
        self.select_first_item();
    }

    /// The selector's rendered rows through the shared menu-panel grammar:
    /// the `›` marker rows with the selection band, the group headers,
    /// the scroll indicator, the no-match row.
    fn list_rows(&self, theme: &Theme, width: usize) -> Vec<Line> {
        let mut lines: Vec<Line> = Vec::new();
        if self.filtered.is_empty() {
            lines.push(crate::menu_panel::no_match_row(
                theme,
                width,
                self.no_match_text(),
            ));
            return lines;
        }
        let (start, end) = self.visible_window();
        for (position, row_index) in self.filtered[start..end].iter().enumerate() {
            let position = start + position;
            let row = &self.rows[*row_index];
            match row {
                SelectorRow::Group(label) => lines.push(crate::width::truncate_line(
                    &vec![
                        Span::raw("  "),
                        theme.fg_span(ThemeColor::Accent, label.clone()),
                    ],
                    width,
                    "",
                )),
                SelectorRow::Subgroup(label) => lines.push(crate::width::truncate_line(
                    &vec![
                        Span::raw("    "),
                        theme.fg_span(ThemeColor::Dim, label.clone()),
                    ],
                    width,
                    "",
                )),
                SelectorRow::Item {
                    label,
                    checked,
                    type_label,
                    ..
                } => {
                    let selected = position == self.selected;
                    let checkbox = theme.fg_span(
                        if *checked {
                            ThemeColor::Success
                        } else {
                            ThemeColor::Dim
                        },
                        if *checked { "[x]" } else { "[ ]" },
                    );
                    let primary: Line = vec![checkbox, Span::raw(" "), Span::raw(label.clone())];
                    let trailing: Vec<crate::menu_panel::MenuSegment> = if type_label.is_empty() {
                        Vec::new()
                    } else {
                        vec![crate::menu_panel::MenuSegment::muted(type_label)]
                    };
                    lines.push(crate::menu_panel::menu_row(
                        theme, width, primary, &trailing, selected,
                    ));
                }
            }
        }
        if start > 0 || end < self.filtered.len() {
            let item_count = self
                .filtered
                .iter()
                .filter(|row_index| matches!(self.rows[**row_index], SelectorRow::Item { .. }))
                .count();
            let current = self.filtered[..=self.selected.min(self.filtered.len() - 1)]
                .iter()
                .filter(|row_index| matches!(self.rows[**row_index], SelectorRow::Item { .. }))
                .count();
            lines.push(crate::menu_panel::scroll_row(
                theme, width, current, item_count,
            ));
        }
        lines
    }

    /// The full modal frame: the title, the shared bordered search field,
    /// the grouped list, and the key hint (the shared menu-panel grammar).
    #[must_use]
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        let mut lines: Vec<Line> = vec![Vec::new(), self.header_line(theme), Vec::new()];
        lines.extend(crate::menu_panel::search_field_lines(
            theme,
            width,
            self.search.value(),
            self.search.cursor(),
            true,
            self.search_placeholder(),
        ));
        lines.extend(self.list_rows(theme, width));
        lines.push(Vec::new());
        lines.push(crate::menu_panel::hint_row(
            theme,
            width,
            &self.hint_text(kb),
        ));
        lines
    }

    /// The frame title: the surface's name, accent like every menu title.
    fn header_line(&self, theme: &Theme) -> Line {
        let (title, _) = self.kind.header();
        vec![theme.fg_span(ThemeColor::Accent, title.to_string())]
    }

    /// The search field's placeholder (the frame's filter hint).
    fn search_placeholder(&self) -> &'static str {
        match self.kind {
            SelectorKind::ResourceConfig => "Type to filter resources",
            SelectorKind::Effort => "Type to filter levels",
        }
    }

    /// The no-match row's message when the filter empties the list.
    fn no_match_text(&self) -> &'static str {
        match self.kind {
            SelectorKind::ResourceConfig => "No resources found",
            SelectorKind::Effort => "No matching levels",
        }
    }

    /// The key hint: an unbound action is omitted, never advertised
    /// with a default key.
    fn hint_text(&self, kb: &KeybindingsManager) -> String {
        let (_, hints) = self.kind.header();
        hints
            .iter()
            .filter_map(|(key, action)| raw_key_hint(kb, key, action))
            .collect::<Vec<String>>()
            .join(" \u{b7} ")
    }
}

/// One hint segment: the key's label when the action is available, None
/// when the action's binding is unconfigured.
fn raw_key_hint(kb: &KeybindingsManager, key: &str, action: &str) -> Option<String> {
    let label = match key {
        "space" => "Space".to_string(),
        "escape" => kb
            .first_key("tui.select.cancel")
            .map(|key| format_key_text(&key))?,
        "enter" => kb
            .first_key("tui.select.confirm")
            .map(|key| format_key_text(&key))?,
        other => format_key_text(other),
    };
    Some(format!("{label} {action}"))
}

/// Options for the selector's terminal loop.
pub struct ConfigSelectorOptions {
    pub theme: Theme,
    pub keybindings: KeybindingsManager,
    /// Headless verification seam: leave the loop after this many ms.
    pub auto_exit_ms: Option<u64>,
}

impl ConfigSelectorOptions {
    #[must_use]
    pub fn new(theme: Theme, keybindings: KeybindingsManager) -> Self {
        ConfigSelectorOptions {
            theme,
            keybindings,
            auto_exit_ms: None,
        }
    }
}

/// Run the selector until Esc (close) or Ctrl+C (exit); every error return funnels
/// through the one exit restore — an early `?` must not hand the shell a
/// terminal still in TUI state.
///
/// # Errors
///
/// Returns `Err` when the selector surface fails to mount or run.
pub fn run_config_selector(
    selector: ConfigSelector,
    options: ConfigSelectorOptions,
    on_toggle: &mut dyn FnMut(&str, bool) -> Result<()>,
) -> Result<()> {
    match run_selector_surface(selector, options, on_toggle) {
        Ok(()) => Ok(()),
        Err(error) => {
            crate::exit_restore::restore_terminal();
            Err(error)
        }
    }
}

fn run_selector_surface(
    mut selector: ConfigSelector,
    options: ConfigSelectorOptions,
    on_toggle: &mut dyn FnMut(&str, bool) -> Result<()>,
) -> Result<()> {
    crossterm::style::force_color_output(true);
    // A panic anywhere between the mount and the deliberate teardown
    // must still hand the terminal back whole.
    let _surface_restore = crate::exit_restore::SurfaceRestore::armed();
    // The raw-mode bracket's `cfmakeraw` write clears IXON, the kernel's
    // one trigger for lifting a pending Ctrl+S stop.
    terminal::enable_raw_mode()?;
    // The alternate screen mounts through the ownership module, so the
    // surface's alt-screen state is tracked for every exit path.
    crate::altscreen::enter()?;
    // The same enhanced-key modes as the session: a pasted filter query
    // arrives as one chunk instead of per-line keystrokes.
    crate::enhanced_keys::enable(&mut std::io::stdout())?;
    let mut terminal = Terminal::new(crate::hyperlinks::stdout_backend())?;
    let theme = options.theme;
    let kb = options.keybindings;
    let start = Instant::now();
    loop {
        let size = terminal.size()?;
        let (width, height) = (size.width, size.height);
        let mut frame: Vec<Line> = selector.render(&theme, width as usize, &kb);
        while frame.len() < height as usize {
            frame.push(Vec::new());
        }
        frame.truncate(height as usize);
        let frame_area = ratatui::layout::Rect::new(0, 0, width, height);
        crate::hyperlinks::install_frame(&frame);
        terminal.draw(|draw_frame| {
            let lines: Vec<ratatui::text::Line<'static>> =
                frame.iter().map(crate::markdown::to_ratatui_line).collect();
            draw_frame.render_widget(ratatui::text::Text::from(lines), frame_area);
        })?;
        if crossterm::event::poll(Duration::from_millis(50))? {
            let action = match crossterm::event::read()? {
                Event::Key(key) => handle_key_event(&mut selector, key, &kb),
                Event::Paste(text) => {
                    selector.paste(&text);
                    None
                }
                _ => None,
            };
            match action {
                Some(SelectorAction::Close) => break,
                Some(SelectorAction::Exit) => {
                    crate::exit_restore::restore_terminal();
                    std::process::exit(0);
                }
                Some(SelectorAction::Toggle { key, enabled }) => {
                    on_toggle(&key, enabled)?;
                }
                None => {}
            }
        }
        if let Some(ms) = options.auto_exit_ms {
            if start.elapsed() >= Duration::from_millis(ms) {
                break;
            }
        }
    }
    crate::exit_restore::restore_terminal();
    Ok(())
}

fn handle_key_event(
    selector: &mut ConfigSelector,
    key: KeyEvent,
    kb: &KeybindingsManager,
) -> Option<SelectorAction> {
    // TS #2493: ctrl+c is a keybinding, not a literal — the exit rides `app.clear` and
    // the close rides `tui.select.cancel`, so remapping either re-routes the key here too.
    let id = key_event_to_id(&key)?;
    selector.handle_key(&id, kb)
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

    fn rows() -> Vec<SelectorRow> {
        vec![
            SelectorRow::Group("Resources".to_string()),
            SelectorRow::Item {
                key: "kernel".to_string(),
                label: "Kernel".to_string(),
                checked: true,
                type_label: "tool".to_string(),
                path: "pa-core/kernel".to_string(),
            },
            SelectorRow::Item {
                key: "browser".to_string(),
                label: "Browser".to_string(),
                checked: false,
                type_label: "tool".to_string(),
                path: "pa-core/browser".to_string(),
            },
        ]
    }

    #[test]
    fn escape_closes_and_space_toggles() {
        let mut selector = ConfigSelector::new(rows());
        assert_eq!(
            selector.handle_key("escape", &kb()),
            Some(SelectorAction::Close)
        );
        let mut selector = ConfigSelector::new(rows());
        assert_eq!(
            selector.handle_key("space", &kb()),
            Some(SelectorAction::Toggle {
                key: "kernel".to_string(),
                enabled: false
            })
        );
        assert_eq!(selector.checked("kernel"), Some(false));
    }

    /// TS `ConfigSelectorComponent.handleInput`'s final arm hands every
    /// non-intercepted key to the search `Input`, so the word and line
    /// kills (ctrl+w, ctrl+u) edit the filter.
    #[test]
    fn word_and_line_edits_reach_the_filter() {
        let mut selector = ConfigSelector::new(rows());
        for key in ["k", "e", "r", "n", "e", "l"] {
            selector.handle_key(key, &kb());
        }
        assert_eq!(selector.query(), "kernel");
        selector.handle_key("ctrl+w", &kb());
        assert_eq!(selector.query(), "", "ctrl+w deletes the typed word");
        for key in ["b", "r", "o", "w", "s", "e", "r"] {
            selector.handle_key(key, &kb());
        }
        assert_eq!(selector.query(), "browser");
        selector.handle_key("ctrl+u", &kb());
        assert_eq!(selector.query(), "", "ctrl+u clears the line");
    }

    /// The filter's full grammar: home+delete edits the head, undo takes
    /// an edit back (TS the search `Input`'s bindings on the whole key
    /// ids).
    #[test]
    fn cursor_and_undo_bindings_reach_the_filter() {
        let mut selector = ConfigSelector::new(rows());
        for key in ["a", "b", "c"] {
            selector.handle_key(key, &kb());
        }
        assert_eq!(selector.query(), "abc");
        selector.handle_key("home", &kb());
        selector.handle_key("delete", &kb());
        assert_eq!(selector.query(), "bc", "home+delete removes the head");
        selector.handle_key("ctrl+-", &kb());
        assert_eq!(selector.query(), "abc", "undo takes the delete back");
    }

    /// The no-match edge state recovers through the same grammar: a
    /// garbage query that empties the list backspaces away, and the rows
    /// return.
    #[test]
    fn the_no_match_state_recovers_through_backspace() {
        let mut selector = ConfigSelector::new(rows());
        for key in ["z", "z"] {
            selector.handle_key(key, &kb());
        }
        assert!(selector.filtered.is_empty(), "garbage matches no row");
        selector.handle_key("backspace", &kb());
        selector.handle_key("backspace", &kb());
        assert_eq!(selector.query(), "");
        assert_eq!(selector.filtered.len(), rows().len(), "every row returns");
    }

    /// The frame renders through the shared menu grammar: the title, the
    /// bordered search field, the `›` marker row, and the hint status row
    /// (the hints ride the bottom row, not a header line).
    #[test]
    fn the_frame_renders_through_the_shared_menu_grammar() {
        let selector = ConfigSelector::new(rows());
        let lines = selector.render(&theme(), 80, &kb());
        let rendered: Vec<String> = lines
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect();
        assert!(rendered
            .iter()
            .any(|row| row.contains("Resource Configuration")));
        assert!(rendered
            .iter()
            .any(|row| row.contains("\u{203a} [x] Kernel")));
        assert!(rendered
            .iter()
            .any(|row| row.contains("Space toggle · Esc close")));
    }
}

#[cfg(test)]
mod keybind_tests {
    use super::*;
    use crate::keybindings::KeybindingsConfig;

    fn selector() -> ConfigSelector {
        ConfigSelector::new(vec![SelectorRow::Item {
            key: "0".to_string(),
            label: "resource one".to_string(),
            checked: false,
            type_label: "mcp".to_string(),
            path: "/tmp/one".to_string(),
        }])
    }

    fn manager(entries: &[(&str, &[&str])]) -> KeybindingsManager {
        let mut bindings = KeybindingsConfig::new();
        for (id, keys) in entries {
            bindings.insert(
                (*id).to_string(),
                keys.iter().map(|k| (*k).to_string()).collect(),
            );
        }
        KeybindingsManager::with_user_bindings(bindings)
    }

    /// The exit branch sits behind the cancel check.
    #[test]
    fn default_bindings_close_on_ctrl_c() {
        let mut selector = selector();
        let kb = KeybindingsManager::new();
        assert_eq!(
            selector.handle_key("ctrl+c", &kb),
            Some(SelectorAction::Close),
            "the cancel default owns ctrl+c first, like TS"
        );
        assert_eq!(
            selector.handle_key("escape", &kb),
            Some(SelectorAction::Close)
        );
    }

    /// The exit is a real keybinding.
    #[test]
    fn a_remapped_cancel_routes_ctrl_c_to_the_exit_binding() {
        let mut selector = selector();
        let kb = manager(&[("tui.select.cancel", &["escape"])]);
        assert_eq!(
            selector.handle_key("ctrl+c", &kb),
            Some(SelectorAction::Exit),
            "the freed ctrl+c now rides app.clear and exits"
        );
        assert_eq!(
            selector.handle_key("escape", &kb),
            Some(SelectorAction::Close)
        );
    }

    #[test]
    fn a_remapped_app_clear_exits_on_its_own_key() {
        let mut selector = selector();
        let kb = manager(&[("app.clear", &["ctrl+q"])]);
        assert_eq!(
            selector.handle_key("ctrl+q", &kb),
            Some(SelectorAction::Exit),
            "the remapped app.clear key exits"
        );
        assert_eq!(
            selector.handle_key("ctrl+c", &kb),
            Some(SelectorAction::Close),
            "the cancel default still owns ctrl+c"
        );
    }

    /// A rebound `tui.editor.deleteCharBackward` moves with the table
    /// (TS the search `Input`'s binding): the remapped key edits the
    /// filter and the freed key no longer deletes.
    #[test]
    fn a_remapped_backspace_binding_edits_the_filter() {
        let mut selector = selector();
        let kb = manager(&[("tui.editor.deleteCharBackward", &["ctrl+h"])]);
        for key in ["a", "b"] {
            selector.handle_key(key, &kb);
        }
        selector.handle_key("ctrl+h", &kb);
        assert_eq!(selector.query(), "a", "the remapped binding deletes");
        selector.handle_key("backspace", &kb);
        assert_eq!(
            selector.query(),
            "a",
            "the freed backspace matches no binding and never edits"
        );
    }

    /// With both bindings remapped away from ctrl+c the key is a plain
    /// no-op (a control character never edits the filter): nothing
    /// hard-codes it anymore.
    #[test]
    fn ctrl_c_is_a_noop_once_both_bindings_move_off_it() {
        let mut selector = selector();
        let kb = manager(&[
            ("tui.select.cancel", &["escape"]),
            ("app.clear", &["ctrl+q"]),
        ]);
        assert_eq!(
            selector.handle_key("ctrl+c", &kb),
            None,
            "ctrl+c matches no binding and never reaches the filter"
        );
        assert_eq!(selector.query(), "", "the control key edited nothing");
    }
}
