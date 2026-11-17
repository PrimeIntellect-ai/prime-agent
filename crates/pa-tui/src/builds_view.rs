//! The builds panel (ctrl+alt+b): a single-level tree of the session's feature
//! builds, each feature's name heading its build output. The view is a push
//! surface: a build pipeline delivers output through [`BuildsSink`] — append
//! for streamed deltas, replace for a settled log — and nothing in the TUI
//! generates build output itself. The panel is scrollable (the page keys page
//! the whole tree, Home/End jump to the ends) and consumes every key while
//! open; ctrl+alt+b closes it again.

use crate::keybindings::KeybindingsManager;
use crate::menu_panel::{hint_row, menu_list_layout, no_match_row, scroll_row};
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};

/// The panel's fixed frame rows outside the content window with a title: the
/// rule, the title, the blank under it, the key hint, and the trailing blank
/// (the same docked-panel grammar as the info panel).
const FIXED_FRAME_ROWS_WITH_TITLE: usize = 5;

const SCROLL_INDICATOR_ROWS: usize = 1;

/// One build entry: the feature's name and its accumulated output.
#[derive(Debug, Clone, PartialEq)]
pub struct BuildEntry {
    pub name: String,
    pub output: String,
}

/// The session's builds: a single-level tree of named entries in push order.
/// Seeded empty — the panel renders a minimal no-builds line until output
/// lands.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct BuildsState {
    entries: Vec<BuildEntry>,
}

/// The build-output push seam: a later build phase delivers output for a
/// named entry through these; the TUI state is the current implementation and
/// the panel renders whatever lands. Both methods create the entry on the
/// first push for a name, at the end of the tree; implementations never
/// reorder existing entries.
pub trait BuildsSink {
    /// Append a chunk to a named build's output (streamed deltas).
    fn append_output(&mut self, name: &str, output: &str);
    /// Replace a named build's output wholesale (a settled or re-run log).
    fn set_output(&mut self, name: &str, output: &str);
}

impl BuildsState {
    /// The entries in push order.
    #[must_use]
    pub fn entries(&self) -> &[BuildEntry] {
        &self.entries
    }
}

impl BuildsSink for BuildsState {
    fn append_output(&mut self, name: &str, output: &str) {
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.name == name) {
            entry.output.push_str(output);
        } else {
            self.entries.push(BuildEntry {
                name: name.to_string(),
                output: output.to_string(),
            });
        }
    }

    fn set_output(&mut self, name: &str, output: &str) {
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.name == name) {
            entry.output = output.to_string();
        } else {
            self.entries.push(BuildEntry {
                name: name.to_string(),
                output: output.to_string(),
            });
        }
    }
}

/// The outcome of one key press on the panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildsPanelAction {
    /// The key was consumed (scrolling, or an inert key on a read-only surface).
    None,
    /// Close the panel: the toggle key, the modal-back key, and the clear key
    /// return focus to the chat.
    Close,
}

/// The builds overlay: a scrollable single-level tree over the editor dock.
/// The scroll state lives only while the panel is open; the tree itself lives
/// in the view's [`BuildsState`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BuildsPanel {
    /// The content window's first row (0 = the top of the tree).
    scroll: usize,
    /// The content window's height from the last paint: the scroll math walks
    /// the same window the panel rendered (a render always precedes a key
    /// press).
    visible_rows: usize,
    /// The tree's row count from the last paint: the scroll bounds without
    /// re-laying the tree on every key press.
    total_rows: usize,
}

impl BuildsPanel {
    /// The tree's rendered rows at this width: each feature's name row
    /// followed by its wrapped, indented output rows. Re-laid every frame —
    /// build output changes under the open panel, so there is no width cache
    /// to invalidate.
    fn tree_rows(theme: &Theme, state: &BuildsState, width: usize) -> Vec<Line> {
        if state.entries.is_empty() {
            return vec![no_match_row(theme, width, "no builds")];
        }
        let mut rows = Vec::new();
        for entry in &state.entries {
            let name: Line = vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Accent, "\u{25cf} "),
                theme.fg_span(ThemeColor::Text, entry.name.clone()),
            ];
            rows.push(crate::width::truncate_line(&name, width, "\u{2026}"));
            let indent = 4;
            let output = entry.output.trim_end();
            if !output.is_empty() {
                for row in crate::width::wrap_text(output, width.saturating_sub(indent)) {
                    let mut row = row;
                    row.insert(0, Span::raw(" ".repeat(indent)));
                    rows.push(row);
                }
            }
        }
        rows
    }

    /// Clamp the scroll: the window never rides past the tree's end (a
    /// re-layout can shrink it).
    fn clamp_scroll(&mut self) {
        let max = self.total_rows.saturating_sub(self.visible_rows.max(1));
        self.scroll = self.scroll.min(max);
    }

    /// Scroll by a signed row delta, clamped at the tree's bounds (a
    /// saturating add keeps an unbounded jump like bottom safe).
    fn scroll_by(&mut self, delta: isize) {
        let max = self.total_rows.saturating_sub(self.visible_rows.max(1));
        self.scroll = (self.scroll as isize)
            .saturating_add(delta)
            .clamp(0, max as isize) as usize;
    }

    /// One key press on the read-only surface: the close keys dismiss, the
    /// navigation keys scroll (arrows by one row, page keys by the window,
    /// Home/End to the ends), and every other key is consumed.
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> BuildsPanelAction {
        if key == "ctrl+c"
            || kb.matches(key, "app.builds.toggle")
            || kb.matches(key, "tui.select.cancel")
            || kb.matches(key, "app.modal.back")
            || kb.matches(key, "app.clear")
        {
            return BuildsPanelAction::Close;
        }
        if kb.matches(key, "tui.select.up") {
            self.scroll_by(-1);
            return BuildsPanelAction::None;
        }
        if kb.matches(key, "tui.select.down") {
            self.scroll_by(1);
            return BuildsPanelAction::None;
        }
        if kb.matches(key, "tui.select.pageUp") || kb.matches(key, "tui.select.pageDown") {
            let delta = if kb.matches(key, "tui.select.pageDown") {
                self.visible_rows.max(1) as isize
            } else {
                -(self.visible_rows.max(1) as isize)
            };
            self.scroll_by(delta);
            return BuildsPanelAction::None;
        }
        if kb.matches(key, "tui.select.top") {
            self.scroll = 0;
            return BuildsPanelAction::None;
        }
        if kb.matches(key, "tui.select.bottom") {
            self.scroll_by(isize::MAX);
            return BuildsPanelAction::None;
        }
        BuildsPanelAction::None
    }

    /// Render the panel's frame at the CURRENT row budget. The frame never
    /// exceeds the budget (a too-short terminal degrades by truncation); a
    /// resized terminal re-budgets here.
    pub fn render(
        &mut self,
        theme: &Theme,
        width: usize,
        kb: &KeybindingsManager,
        state: &BuildsState,
        viewport_rows: usize,
    ) -> Vec<Line> {
        let rows = Self::tree_rows(theme, state, width);
        let total = rows.len();
        let visible = menu_list_layout(
            Some(viewport_rows),
            viewport_rows,
            total,
            FIXED_FRAME_ROWS_WITH_TITLE,
            SCROLL_INDICATOR_ROWS,
        );
        self.visible_rows = visible;
        self.total_rows = total;
        self.clamp_scroll();
        let end = (self.scroll + visible).min(total);
        let mut lines: Vec<Line> = Vec::with_capacity(FIXED_FRAME_ROWS_WITH_TITLE + visible + 1);
        lines.push(vec![
            theme.fg_span(ThemeColor::BorderMuted, "\u{2500}".repeat(width.max(1)))
        ]);
        let title: Line = vec![
            Span::raw("  "),
            theme.fg_span(ThemeColor::Text, "Builds".to_string()),
        ];
        lines.push(crate::width::truncate_line(&title, width, ""));
        lines.push(Vec::new());
        lines.extend(rows[self.scroll..end].iter().cloned());
        if end < total || self.scroll > 0 {
            lines.push(scroll_row(theme, width, self.scroll + 1, total));
        }
        lines.push(hint_row(theme, width, &hint_text(kb)));
        lines.push(Vec::new());
        lines.truncate(viewport_rows.max(1));
        lines
    }
}

/// The key-hint text: the page keys, the jump keys, and the close key, the
/// same vocabulary as the pickers' hints. An unbound action is omitted — the
/// hint never advertises a key the surface does not handle. A user who
/// unbinds `tui.select.cancel` loses the Esc close; the hint then names the
/// one close key that always works: Ctrl+C (hardwired in `handle_key`).
fn hint_text(kb: &KeybindingsManager) -> String {
    let mut parts = Vec::new();
    if let Some(page) =
        crate::menu_panel::key_hint(kb, &["tui.select.pageUp", "tui.select.pageDown"], "page")
    {
        parts.push(page);
    }
    if let Some(jump) =
        crate::menu_panel::key_hint(kb, &["tui.select.top", "tui.select.bottom"], "jump")
    {
        parts.push(jump);
    }
    let close = kb.first_key("tui.select.cancel").map_or_else(
        || "Ctrl+C".to_string(),
        |key| crate::keybindings::format_key_text(&key),
    );
    parts.push(format!("{close} close"));
    parts.join(" \u{b7} ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::ColorMode;

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn kb() -> KeybindingsManager {
        KeybindingsManager::new()
    }

    /// The frame text with trailing padding trimmed: the content rows pad to
    /// the full frame width (the panel surface), so the assertions read the
    /// content.
    fn plain(rows: &[Line]) -> Vec<String> {
        rows.iter()
            .map(|row| {
                row.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
            .collect()
    }

    fn state_with(name: &str, output: &str) -> BuildsState {
        let mut state = BuildsState::default();
        state.append_output(name, output);
        state
    }

    /// The empty state is the panel's minimal frame: rule, title, blank, the
    /// no-builds line, hint, blank.
    #[test]
    fn empty_state_renders_the_no_builds_line() {
        let mut panel = BuildsPanel::default();
        let frame = panel.render(&theme(), 80, &kb(), &BuildsState::default(), 20);
        let text = plain(&frame);
        assert_eq!(text[0], "\u{2500}".repeat(80));
        assert_eq!(text[1], "  Builds");
        assert_eq!(text[2], "");
        assert_eq!(text[3], "  no builds");
        assert!(text[4].contains("PageUp/PageDown page"));
        assert!(text[4].contains("Home/End jump"));
        assert!(text[4].contains("Esc close"));
        assert_eq!(text.last(), Some(&String::new()));
        assert_eq!(text.len(), 6);
    }

    /// The single-level tree: the feature's name row, then its output rows
    /// indented beneath it.
    #[test]
    fn a_build_renders_name_then_output() {
        let state = state_with("transcript-nav", "compiling\nerror: nope");
        let mut panel = BuildsPanel::default();
        let frame = panel.render(&theme(), 40, &kb(), &state, 20);
        let text = plain(&frame);
        assert_eq!(text[3], "  \u{25cf} transcript-nav");
        assert_eq!(text[4], "    compiling");
        assert_eq!(text[5], "    error: nope");
    }

    /// Output wraps at the frame width under the name's indent: no row
    /// spills past the panel surface.
    #[test]
    fn long_output_wraps_under_the_indent() {
        let state = state_with("wide", &"x".repeat(100));
        let mut panel = BuildsPanel::default();
        let frame = panel.render(&theme(), 40, &kb(), &state, 20);
        let text = plain(&frame);
        let output = &text[4..text.len() - 2];
        assert!(output.len() > 1, "100 columns wrap at 36");
        for row in output {
            assert!(row.chars().count() <= 40);
        }
    }

    /// Appending to a known entry extends its output; a first append creates
    /// the entry at the end of the tree.
    #[test]
    fn append_creates_then_extends() {
        let mut state = BuildsState::default();
        state.append_output("a", "one\n");
        state.append_output("b", "two");
        state.append_output("a", "two");
        assert_eq!(
            state.entries(),
            &[
                BuildEntry {
                    name: "a".to_string(),
                    output: "one\ntwo".to_string(),
                },
                BuildEntry {
                    name: "b".to_string(),
                    output: "two".to_string(),
                },
            ]
        );
    }

    /// A replace on a known entry swaps the output; a first replace creates
    /// the entry at the end of the tree.
    #[test]
    fn set_creates_then_replaces() {
        let mut state = BuildsState::default();
        state.set_output("a", "old");
        state.set_output("a", "new");
        state.set_output("b", "fresh");
        assert_eq!(
            state.entries(),
            &[
                BuildEntry {
                    name: "a".to_string(),
                    output: "new".to_string(),
                },
                BuildEntry {
                    name: "b".to_string(),
                    output: "fresh".to_string(),
                },
            ]
        );
    }

    /// The page keys move the window by its height and clamp at the ends;
    /// Home/End jump to the top and bottom.
    #[test]
    fn paging_and_jump_keys_walk_the_window() {
        let rows = (0..60).map(|i| format!("row {i}")).collect::<Vec<_>>();
        let state = state_with("long", &rows.join("\n"));
        let mut panel = BuildsPanel::default();
        panel.render(&theme(), 40, &kb(), &state, 20);
        panel.handle_key("pageDown", &kb());
        let after_page = panel.scroll;
        panel.handle_key("pageDown", &kb());
        assert!(panel.scroll > after_page, "the second page moves further");
        panel.handle_key("end", &kb());
        let text = plain(&panel.render(&theme(), 40, &kb(), &state, 20));
        assert!(text.iter().any(|row| row.contains("row 59")));
        panel.handle_key("home", &kb());
        let text = plain(&panel.render(&theme(), 40, &kb(), &state, 20));
        assert!(text.iter().any(|row| row.contains("\u{25cf} long")));
    }

    /// The toggle key closes the panel while it owns the frame.
    #[test]
    fn the_toggle_key_closes_the_open_panel() {
        let mut panel = BuildsPanel::default();
        assert_eq!(
            panel.handle_key("ctrl+alt+b", &kb()),
            BuildsPanelAction::Close
        );
    }

    /// An inert key is consumed without closing: a read-only surface never
    /// hands a stray press to the transcript behind it.
    #[test]
    fn an_inert_key_is_consumed() {
        let mut panel = BuildsPanel::default();
        assert_eq!(panel.handle_key("q", &kb()), BuildsPanelAction::None);
    }
}
