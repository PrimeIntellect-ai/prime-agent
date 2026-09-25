//! The resource-configuration modal (TS `ConfigSelectorComponent`): a
//! filterable, grouped checkbox list over session resources with Space to
//! toggle and Esc to close. Data comes from the caller as flat rows; this
//! module owns rendering, filtering, selection, and the terminal loop.

use anyhow::Result;
use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::terminal::{self};
use ratatui::Terminal;
use std::time::{Duration, Instant};

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::keys::key_event_to_id;
use crate::theme::{Theme, ThemeColor};
use crate::width::{str_width, truncate_line};
use crate::{Line, Span};

/// One flat selector row. `Item` rows carry the caller's identity key and
/// the texts the filter matches against (display name, resource type
/// label, path — the TS filter fields).
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

/// The outcome of one key press while the selector owns the terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectorAction {
    /// Esc: close the view.
    Close,
    /// Ctrl+C: exit the process.
    Exit,
    /// Space/Enter on an item: the caller should persist `enabled` for
    /// `key`; the selector has already flipped its row.
    Toggle { key: String, enabled: bool },
}

/// The maximum rows the list shows at once (TS `maxVisible`).
const MAX_VISIBLE: usize = 15;

/// The selector's frame chrome: which surface is being picked. The list,
/// filter, and selection behavior are shared; only the header title and
/// its key hints differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectorKind {
    /// The resource-configuration modal (`prime-agent config`): checkbox
    /// semantics, Space toggles.
    ResourceConfig,
    /// The `/model` picker: single-select semantics, Enter applies.
    Model,
    /// The `/effort` picker: single-select semantics, Enter applies.
    Effort,
}

impl SelectorKind {
    /// The header title and its `(key, action)` hints.
    fn header(self) -> (&'static str, &'static [(&'static str, &'static str)]) {
        match self {
            SelectorKind::ResourceConfig => (
                "Resource Configuration",
                &[("space", "toggle"), ("escape", "close")],
            ),
            SelectorKind::Model => ("Select Model", &[("enter", "select"), ("escape", "close")]),
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
    query: String,
    selected: usize,
}

impl ConfigSelector {
    /// Build the resource-configuration selector from flat rows (group,
    /// subgroup, item order).
    pub fn new(rows: Vec<SelectorRow>) -> Self {
        Self::with_kind(rows, SelectorKind::ResourceConfig)
    }

    /// Build the selector for a specific surface (the `/model` picker uses
    /// [`SelectorKind::Model`]).
    pub fn with_kind(rows: Vec<SelectorRow>, kind: SelectorKind) -> Self {
        let filtered = (0..rows.len()).collect();
        let mut selector = ConfigSelector {
            kind,
            rows,
            filtered,
            query: String::new(),
            selected: 0,
        };
        selector.select_first_item();
        selector
    }

    /// The selector's frame kind.
    pub fn kind(&self) -> SelectorKind {
        self.kind
    }

    /// The current filter query.
    pub fn query(&self) -> &str {
        &self.query
    }

    /// Replace the filter query in one step (the `/model <search>` prefill;
    /// typing the same characters one key at a time cannot express a
    /// space, which the key loop treats as toggle).
    pub fn set_query(&mut self, query: &str) {
        self.query = query.to_string();
        self.apply_filter();
    }

    /// The checked state of one item row.
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

    /// One key id, TS `ResourceList.handleInput`.
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
        if key == "ctrl+c" {
            return Some(SelectorAction::Exit);
        }
        if key == " " || kb.matches(key, "tui.select.confirm") {
            return self.toggle_selected();
        }
        if key == "backspace" {
            self.query.pop();
            self.apply_filter();
            return None;
        }
        // Every other key with a printable identity edits the filter.
        if let [character] = key.chars().collect::<Vec<char>>()[..] {
            if !character.is_control() {
                self.query.push(character);
                self.apply_filter();
            }
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

    /// Walk to the next/previous item row, skipping group headers (TS
    /// `findNextItem`; stays put when no item lies that way).
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
        if self.query.trim().is_empty() {
            self.filtered = (0..self.rows.len()).collect();
            self.select_first_item();
            return;
        }
        let query = self.query.to_lowercase();
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

    /// The selector's rendered rows for `render` (TS `ResourceList.render`).
    fn list_rows(&self, theme: &Theme, width: usize) -> Vec<Line> {
        let mut lines: Vec<Line> = Vec::new();
        lines.push(self.input_line(theme));
        lines.push(Vec::new());
        if self.filtered.is_empty() {
            lines.push(vec![
                theme.fg_span(ThemeColor::Muted, "  No resources found")
            ]);
            return lines;
        }
        let start = self
            .selected
            .saturating_sub(MAX_VISIBLE / 2)
            .min(self.filtered.len().saturating_sub(MAX_VISIBLE));
        let end = (start + MAX_VISIBLE).min(self.filtered.len());
        for (position, row_index) in self.filtered[start..end].iter().enumerate() {
            let position = start + position;
            let row = &self.rows[*row_index];
            let line = match row {
                SelectorRow::Group(label) => {
                    let line = vec![
                        Span::raw("  "),
                        theme.fg_span(ThemeColor::Accent, label.clone()),
                    ];
                    truncate_line(&line, width, "")
                }
                SelectorRow::Subgroup(label) => {
                    let line = vec![
                        Span::raw("    "),
                        theme.fg_span(ThemeColor::Dim, label.clone()),
                    ];
                    truncate_line(&line, width, "")
                }
                SelectorRow::Item { label, checked, .. } => {
                    let cursor = if position == self.selected {
                        "> "
                    } else {
                        "  "
                    };
                    let checkbox = theme.fg_span(
                        if *checked {
                            ThemeColor::Success
                        } else {
                            ThemeColor::Dim
                        },
                        if *checked { "[x]" } else { "[ ]" },
                    );
                    let mut line = vec![
                        Span::raw(cursor),
                        Span::raw("    "),
                        checkbox,
                        Span::raw(" "),
                    ];
                    let name = Span::raw(label.clone());
                    if position == self.selected {
                        line.push(theme.bold(name));
                    } else {
                        line.push(name);
                    }
                    truncate_line(&line, width, "...")
                }
            };
            lines.push(line);
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
            lines.push(vec![
                theme.fg_span(ThemeColor::Dim, format!("  ({current}/{item_count})"))
            ]);
        }
        lines
    }

    /// "> <query>" with the cursor block (TS `Input` render).
    fn input_line(&self, theme: &Theme) -> Line {
        let _ = theme;
        vec![
            Span::raw("> "),
            Span::raw(self.query.clone()),
            Span::styled(
                " ".to_string(),
                ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::REVERSED),
            ),
        ]
    }

    /// The full modal frame: border, header, filter input, list, border
    /// (TS `ConfigSelectorComponent.render` composition).
    pub fn render(&self, theme: &Theme, width: usize) -> Vec<Line> {
        let border = || vec![theme.fg_span(ThemeColor::Accent, "─".repeat(width.max(1)))];
        let mut lines: Vec<Line> = vec![
            Vec::new(),
            border(),
            Vec::new(),
            self.header_line(theme, width),
            vec![theme.fg_span(
                ThemeColor::Muted,
                match self.kind {
                    SelectorKind::ResourceConfig => "Type to filter resources",
                    SelectorKind::Model => "Type to filter models",
                    SelectorKind::Effort => "Type to filter levels",
                },
            )],
            Vec::new(),
        ];
        lines.extend(self.list_rows(theme, width));
        lines.push(Vec::new());
        lines.push(border());
        lines
    }

    /// "<title> ... <key action> · <key action>" (the resource header is TS
    /// `ConfigSelectorHeader.render`; the model header carries the picker's
    /// own hints).
    fn header_line(&self, theme: &Theme, width: usize) -> Line {
        let (title, hints) = self.kind.header();
        let mut hint_parts: Line = Vec::new();
        for (position, (key, action)) in hints.iter().enumerate() {
            if position > 0 {
                hint_parts.push(Span::raw(theme.fg_span(ThemeColor::Muted, " · ").content));
            }
            hint_parts.extend(raw_key_hint(theme, key, action));
        }
        let title_width = str_width(title);
        let hint_width = crate::width::spans_width(&hint_parts);
        let spacing = width.saturating_sub(title_width + hint_width).max(1);
        let mut line = vec![Span::raw(format!("{title}{}", " ".repeat(spacing)))];
        line.extend(hint_parts);
        truncate_line(&line, width, "")
    }
}

/// `theme.fg("dim", keyText) + theme.fg("muted", " description")`
/// (TS `rawKeyHint`).
fn raw_key_hint(theme: &Theme, key: &str, action: &str) -> Line {
    vec![
        theme.fg_span(ThemeColor::Dim, format_key_text(key)),
        theme.fg_span(ThemeColor::Muted, format!(" {action}")),
    ]
}

/// Options for the selector's terminal loop.
pub struct ConfigSelectorOptions {
    pub theme: Theme,
    pub keybindings: KeybindingsManager,
    /// Headless verification seam: leave the loop after this many ms.
    pub auto_exit_ms: Option<u64>,
}

impl ConfigSelectorOptions {
    pub fn new(theme: Theme, keybindings: KeybindingsManager) -> Self {
        ConfigSelectorOptions {
            theme,
            keybindings,
            auto_exit_ms: None,
        }
    }
}

/// Run the selector until Esc (close) or Ctrl+C (exit): full-screen mode,
/// redraws on every key and toggle, `on_toggle` persists each flip.
///
/// Every error return funnels through the one exit restore: an early `?`
/// after the mount (a draw failure, a persist error in `on_toggle`) must
/// not hand the shell a terminal still in TUI state.
///
/// # Errors
///
/// Returns `Err` when the selector surface fails to mount or run
/// (raw-mode enable, the alternate-screen enter, enhanced-key enable,
/// terminal creation, a draw, or an `on_toggle` persist error); the
/// terminal is restored on every error path.
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
    // A panic anywhere between the mount below and the deliberate
    // teardown must still hand the terminal back whole (the same
    // unwind-guard contract the session surface arms).
    let _surface_restore = crate::exit_restore::SurfaceRestore::armed();
    terminal::enable_raw_mode()?;
    // The alternate screen mounts through the ownership module (the same
    // `pendingAltScreenHandoff` semantics the session surface uses), so
    // the surface's alt-screen state is tracked for every exit path.
    crate::altscreen::enter()?;
    // The selector surface owns the same enhanced-key modes as the session
    // (TS `ProcessTerminal.start`): a pasted filter query arrives as one
    // chunk instead of per-line keystrokes.
    crate::enhanced_keys::enable(&mut std::io::stdout())?;
    let mut terminal = Terminal::new(crate::hyperlinks::stdout_backend())?;
    let theme = options.theme;
    let kb = options.keybindings;
    let start = Instant::now();
    loop {
        let size = terminal.size()?;
        let (width, height) = (size.width, size.height);
        let mut frame: Vec<Line> = selector.render(&theme, width as usize);
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
                    selector_query_insert(&mut selector, &text);
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
    // Ctrl+C arrives through the keybindings table ("tui.select.cancel"
    // includes it), but the TS selector treats it as exit, not close.
    if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
        return Some(SelectorAction::Exit);
    }
    let id = key_event_to_id(&key)?;
    selector.handle_key(&id, kb)
}

fn selector_query_insert(selector: &mut ConfigSelector, text: &str) {
    for c in text.chars() {
        let id = c.to_string();
        selector.handle_key(&id, &KeybindingsManager::new());
    }
}
