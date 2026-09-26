//! The read-only inline info panel (the operator's 2026-09-26
//! directive): the client info displays — `/context`, `/session`,
//! `/system-prompt`, `/logs`, `/changelog`, `/hotkeys`, the `/traces`
//! status and preview blocks, and `/list` — render as the docked popup
//! panel over the editor dock (the `/mcp` and `/model` panel grammar:
//! the ruled frame, the scroll indicator, the key hint, one blank under
//! the hint) instead of flooding the chat transcript with rows that
//! persist. The content builders are unchanged — the same
//! [`crate::info_commands`] row builders and the same markdown seam — so
//! only
//! the mount point moves: ESC closes, focus returns to the chat, and
//! the transcript never gained a row (TS renders these displays as chat
//! rows; the panel is a deliberate, operator-directed Rust delta).
//! Scrollable, because the payloads are unbounded (the system prompt,
//! the hotkeys guide, the context tree of a deep session).

use crate::info_commands::ClientLine;
use crate::keybindings::KeybindingsManager;
use crate::menu_panel::{hint_row, menu_list_layout, scroll_row};
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};

/// The panel's fixed frame rows outside the content window with a
/// title: the rule, the title, the blank under it, the key hint, and the
/// trailing blank (the operator's 2026-09-24 spacing directive: the
/// hint is the frame's last content row, one blank rides under it,
/// never a rule). Without a title the frame loses one row.
const FIXED_FRAME_ROWS_WITH_TITLE: usize = 5;
const FIXED_FRAME_ROWS: usize = 4;

/// The scroll indicator's row (shown when the window is partial).
const SCROLL_INDICATOR_ROWS: usize = 1;

/// The panel's content: styled info rows or one markdown document.
#[derive(Debug, Clone, PartialEq)]
pub enum InfoContent {
    /// Info rows built by the [`crate::info_commands`] builders — the
    /// same rows the chat display rendered, byte for byte.
    Rows(Vec<ClientLine>),
    /// A markdown document (the `/hotkeys` guide, the `/changelog`
    /// entries).
    Markdown(String),
}

/// The content's laid-out rows at one render width: rebuilt when the
/// terminal width changes (the same width-keyed discipline as the
/// transcript's entry layout).
#[derive(Debug, Clone, PartialEq)]
struct InfoLayout {
    width: usize,
    rows: Vec<Line>,
}

/// The outcome of one key press on the panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InfoPanelAction {
    /// The key was consumed (scrolling, or an inert key on a read-only
    /// surface).
    None,
    /// Close the panel: ESC, the modal-back key, and the clear key all
    /// return focus to the chat with the transcript untouched.
    Close,
}

/// The read-only info panel: a scrollable document in the editor dock.
/// The title is `None` for content that carries its own header row (the
/// `/context`, `/session`, `/system-prompt`, and `/logs` builders all
/// open with their heading — the panel never duplicates it).
#[derive(Debug, Clone, PartialEq)]
pub struct InfoPanel {
    title: Option<String>,
    content: InfoContent,
    /// The content window's first row (0 = the top of the document).
    scroll: usize,
    viewport_rows: usize,
    /// The content window's height from the last paint: the key loop's
    /// scroll math walks the same window the panel rendered (a render
    /// always precedes a key press).
    visible_rows: usize,
    layout: InfoLayout,
}

impl InfoPanel {
    pub fn new(title: Option<String>, content: InfoContent, viewport_rows: usize) -> Self {
        Self {
            title,
            content,
            scroll: 0,
            viewport_rows,
            visible_rows: 0,
            layout: InfoLayout {
                width: 0,
                rows: Vec::new(),
            },
        }
    }

    /// The content's rendered-row count (post-wrap): the scroll bounds
    /// and the indicator's denominator.
    fn content_rows(&self) -> usize {
        self.layout.rows.len()
    }

    /// Re-lay the content out when the render width changed: info rows
    /// re-wrap and markdown re-flows exactly like the chat display.
    fn ensure_layout(&mut self, theme: &Theme, width: usize, code_block_indent: &str) {
        if self.layout.width == width {
            return;
        }
        let rows = match &self.content {
            InfoContent::Rows(rows) => {
                let mut rendered = crate::info_commands::render_client_text(rows, theme, width);
                // The shared renderer's TS `Spacer(1)` leading blank is
                // the transcript mount's spacing; the panel's own blank
                // under the title replaces it.
                rendered.remove(0);
                rendered
            }
            InfoContent::Markdown(text) => {
                let mut md = crate::markdown::MarkdownStyle::from_theme(theme);
                md.code_block_indent = code_block_indent.to_string();
                crate::chat::render_markdown_block(
                    text,
                    &md,
                    width,
                    &mut crate::markdown::MarkdownBlockCache::default(),
                )
            }
        };
        self.layout = InfoLayout { width, rows };
    }

    /// The content window's height inside the row budget: the frame's own
    /// fixed rows (one fewer without a title) plus the scroll indicator
    /// (when the window is partial) are reserved first, exactly like the
    /// pickers' list layout.
    fn window_height(&self, total: usize) -> usize {
        let fixed = match self.title {
            Some(_) => FIXED_FRAME_ROWS_WITH_TITLE,
            None => FIXED_FRAME_ROWS,
        };
        menu_list_layout(
            Some(self.viewport_rows),
            self.viewport_rows,
            total,
            fixed,
            SCROLL_INDICATOR_ROWS,
        )
    }

    /// Clamp the scroll so the window never rides past the document's
    /// end (a re-layout at a new width can shrink the document).
    fn clamp_scroll(&mut self) {
        let max = self.content_rows().saturating_sub(self.visible_rows.max(1));
        self.scroll = self.scroll.min(max);
    }

    /// Scroll by a signed row delta, clamped at the document's bounds
    /// (a saturating add keeps an unbounded jump like bottom safe).
    fn scroll_by(&mut self, delta: isize) {
        let max = self.content_rows().saturating_sub(self.visible_rows.max(1));
        self.scroll = (self.scroll as isize)
            .saturating_add(delta)
            .clamp(0, max as isize) as usize;
    }

    /// One key press on the read-only surface: the close keys dismiss,
    /// the navigation keys scroll (arrows by one row, page keys by the
    /// window), and every other key is consumed (a read-only view never
    /// leaks a key back to the editor or the chat).
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> InfoPanelAction {
        if key == "ctrl+c"
            || kb.matches(key, "tui.select.cancel")
            || kb.matches(key, "app.modal.back")
            || kb.matches(key, "app.clear")
        {
            return InfoPanelAction::Close;
        }
        if kb.matches(key, "tui.select.up") {
            self.scroll_by(-1);
            return InfoPanelAction::None;
        }
        if kb.matches(key, "tui.select.down") {
            self.scroll_by(1);
            return InfoPanelAction::None;
        }
        if kb.matches(key, "tui.select.pageUp") || kb.matches(key, "tui.select.pageDown") {
            let delta = if kb.matches(key, "tui.select.pageDown") {
                self.visible_rows.max(1) as isize
            } else {
                -(self.visible_rows.max(1) as isize)
            };
            self.scroll_by(delta);
            return InfoPanelAction::None;
        }
        if kb.matches(key, "tui.select.top") {
            self.scroll = 0;
            return InfoPanelAction::None;
        }
        if kb.matches(key, "tui.select.bottom") {
            self.scroll_by(isize::MAX);
            return InfoPanelAction::None;
        }
        InfoPanelAction::None
    }

    /// Render the panel's frame: the rule, the title, the content
    /// window, the scroll indicator when the window is partial, the key
    /// hint, and one blank under it. The frame never exceeds the row
    /// budget it was opened with (a too-short terminal degrades by
    /// truncation, like the docked pickers).
    pub fn render(
        &mut self,
        theme: &Theme,
        width: usize,
        kb: &KeybindingsManager,
        code_block_indent: &str,
    ) -> Vec<Line> {
        self.ensure_layout(theme, width, code_block_indent);
        let total = self.content_rows();
        let visible = self.window_height(total);
        self.visible_rows = visible;
        self.clamp_scroll();
        let end = (self.scroll + visible).min(total);
        let mut lines: Vec<Line> = Vec::with_capacity(FIXED_FRAME_ROWS_WITH_TITLE + visible + 1);
        lines.push(vec![
            theme.fg_span(ThemeColor::BorderMuted, "\u{2500}".repeat(width.max(1)))
        ]);
        if let Some(title) = &self.title {
            let title: Line = vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Text, title.clone()),
            ];
            lines.push(crate::width::truncate_line(&title, width, ""));
        }
        lines.push(Vec::new());
        lines.extend(self.layout.rows[self.scroll..end].iter().cloned());
        if end < total || self.scroll > 0 {
            lines.push(scroll_row(theme, width, self.scroll + 1, total));
        }
        lines.push(hint_row(theme, width, &hint_text(kb)));
        lines.push(Vec::new());
        lines.truncate(self.viewport_rows.max(1));
        lines
    }
}

/// The key-hint text: the scroll keys and the close key, the same
/// vocabulary as the pickers' hints. An unbound action is omitted — the
/// hint never advertises a key the surface does not handle.
fn hint_text(kb: &KeybindingsManager) -> String {
    let scroll = crate::menu_panel::key_hint(kb, &["tui.select.up", "tui.select.down"], "scroll");
    let close = kb.first_key("tui.select.cancel").map_or_else(
        || "Esc".to_string(),
        |key| crate::keybindings::format_key_text(&key),
    );
    match scroll {
        Some(scroll) => format!("{scroll} \u{b7} {close} close"),
        None => format!("{close} close"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::info_commands::ClientSpan;
    use crate::theme::ColorMode;

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn kb() -> KeybindingsManager {
        KeybindingsManager::new()
    }

    fn plain(rows: &[Line]) -> Vec<String> {
        rows.iter()
            .map(|row| row.iter().map(|span| span.content.as_str()).collect())
            .collect()
    }

    fn rows(count: usize) -> Vec<ClientLine> {
        (0..count)
            .map(|index| {
                vec![ClientSpan {
                    text: format!("line {index}"),
                    color: None,
                }]
            })
            .collect()
    }

    #[test]
    fn frame_grammar_is_the_panel_shape() {
        let mut panel = InfoPanel::new(Some("Context".to_string()), InfoContent::Rows(rows(2)), 20);
        let frame = panel.render(&theme(), 40, &kb(), "  ");
        let text = plain(&frame);
        // Rule, title, blank, content, hint, blank — the docked-panel
        // grammar, and no rule below the shortcuts hint.
        assert_eq!(text[0], "\u{2500}".repeat(40));
        assert_eq!(text[1], "  Context");
        assert_eq!(text[2], "");
        assert_eq!(text[3], " line 0");
        assert_eq!(text[4], " line 1");
        assert!(text[5].starts_with(" \u{2191}/\u{2193} scroll \u{b7} Esc close"));
        assert_eq!(text[6], "");
        assert_eq!(text.len(), 7);
    }

    /// Content that carries its own header row (the `/context`-family
    /// builders) opens without a title: the rule alone heads the frame,
    /// so the panel never duplicates the content's heading.
    #[test]
    fn untitled_content_renders_without_a_title_row() {
        let mut rows = rows(2);
        rows.insert(
            0,
            vec![ClientSpan {
                text: "Session Info".to_string(),
                color: None,
            }],
        );
        let mut panel = InfoPanel::new(None, InfoContent::Rows(rows), 20);
        let frame = panel.render(&theme(), 40, &kb(), "  ");
        let text = plain(&frame);
        assert_eq!(text[0], "\u{2500}".repeat(40));
        assert_eq!(text[1], "");
        assert_eq!(text[2], " Session Info");
        assert_eq!(text[3], " line 0");
        assert_eq!(text[4], " line 1");
        assert!(text[5].starts_with(" \u{2191}/\u{2193} scroll"));
        assert_eq!(text.last(), Some(&String::new()));
    }

    #[test]
    fn long_content_windows_with_a_scroll_indicator() {
        let mut panel = InfoPanel::new(Some("Logs".to_string()), InfoContent::Rows(rows(50)), 20);
        let frame = panel.render(&theme(), 40, &kb(), "  ");
        let text = plain(&frame);
        // The window holds viewport - fixed - indicator rows and the
        // indicator rides under the content.
        let content_rows = text.len() - FIXED_FRAME_ROWS_WITH_TITLE - SCROLL_INDICATOR_ROWS;
        assert_eq!(
            content_rows,
            20 - FIXED_FRAME_ROWS_WITH_TITLE - SCROLL_INDICATOR_ROWS
        );
        assert!(text.contains(&"  (1/50)".to_string()), "{text:?}");
        assert_eq!(text[3], " line 0");
    }

    #[test]
    fn the_frame_never_exceeds_its_row_budget() {
        for (title, budget) in [
            (Some("T".to_string()), 1usize),
            (Some("T".to_string()), 2),
            (Some("T".to_string()), 5),
            (Some("T".to_string()), 7),
            (Some("T".to_string()), 8),
            (Some("T".to_string()), 30),
            (None, 4),
            (None, 12),
        ] {
            let mut panel = InfoPanel::new(title, InfoContent::Rows(rows(200)), budget);
            let frame = panel.render(&theme(), 40, &kb(), "  ");
            assert!(
                frame.len() <= budget.max(1),
                "budget {budget}: frame {} rows",
                frame.len()
            );
        }
    }

    #[test]
    fn arrows_page_keys_and_close_keys_drive_the_window() {
        let kb = kb();
        let mut panel = InfoPanel::new(None, InfoContent::Rows(rows(100)), 20);
        panel.render(&theme(), 40, &kb, "  ");
        assert_eq!(panel.handle_key("down", &kb), InfoPanelAction::None);
        assert_eq!(panel.scroll, 1);
        assert_eq!(panel.handle_key("up", &kb), InfoPanelAction::None);
        assert_eq!(panel.handle_key("up", &kb), InfoPanelAction::None);
        // The scroll clamps at the top, never wraps.
        assert_eq!(panel.scroll, 0);
        let page = panel.visible_rows;
        assert_eq!(panel.handle_key("pageDown", &kb), InfoPanelAction::None);
        assert_eq!(panel.scroll, page);
        assert_eq!(panel.handle_key("pageUp", &kb), InfoPanelAction::None);
        assert_eq!(panel.scroll, 0);
        // Down past the end clamps; up from the top stays.
        panel.scroll_by(10_000);
        panel.render(&theme(), 40, &kb, "  ");
        let max_scroll = panel.scroll;
        assert_eq!(panel.handle_key("down", &kb), InfoPanelAction::None);
        assert_eq!(panel.scroll, max_scroll);
        // Every close key dismisses; other keys are consumed.
        assert_eq!(panel.handle_key("escape", &kb), InfoPanelAction::Close);
        assert_eq!(panel.handle_key("ctrl+c", &kb), InfoPanelAction::Close);
        panel.scroll = 0;
        // Home/End jump to the document's bounds (the selection top and
        // bottom bindings, the same vocabulary the agents view uses).
        assert_eq!(panel.handle_key("home", &kb), InfoPanelAction::None);
        assert_eq!(panel.scroll, 0);
        assert_eq!(panel.handle_key("end", &kb), InfoPanelAction::None);
        assert_eq!(panel.scroll, max_scroll);
        // Read-only: inert keys are consumed, never leaked to the editor.
        assert_eq!(panel.handle_key("left", &kb), InfoPanelAction::None);
        assert_eq!(panel.handle_key("enter", &kb), InfoPanelAction::None);
    }

    #[test]
    fn a_relayout_at_a_new_width_rewraps_and_clamps() {
        let long = vec![vec![ClientSpan {
            text: "word ".repeat(20),
            color: None,
        }]];
        let mut panel = InfoPanel::new(None, InfoContent::Rows(long), 20);
        let narrow = panel.render(&theme(), 10, &kb(), "  ");
        let narrow_rows = narrow.len();
        let wide = panel.render(&theme(), 60, &kb(), "  ");
        assert!(wide.len() < narrow_rows, "the wider frame wraps tighter");
        // A scroll held at the narrow layout's end clamps into the new
        // document bounds.
        panel.scroll_by(1000);
        panel.render(&theme(), 60, &kb(), "  ");
        assert!(panel.scroll <= panel.content_rows());
    }

    #[test]
    fn markdown_content_flows_through_the_markdown_seam() {
        let mut panel = InfoPanel::new(
            Some("What's New".to_string()),
            InfoContent::Markdown("# Title\n\nbody words".to_string()),
            20,
        );
        let frame = panel.render(&theme(), 40, &kb(), "  ");
        let text = plain(&frame);
        assert!(
            text.iter().any(|row| row.contains("Title")),
            "markdown rendered: {text:?}"
        );
    }
}
