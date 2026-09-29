//! The panel assembly: the dock — prompt-context rows, the queued-input
//! strip, the autocomplete overlay, the editor surface, the tray, the
//! subagent summary box (TS `SubagentSummaryLine`) — plus the share
//! loader and reload-box panels that replace the editor in flight.

use super::chunk_selection;
use super::click::{ClickAction, DockClickRegion, EditorClickSurface};
use super::flush::split_at_chars;
use super::frame::{indicator_row, pad_row};
use super::{AgentView, ShareLoader};
use crate::chrome::{render_prompt_context, render_tray_with_hint};
use crate::prompt_highlight::{
    command_token, editor_chunk_highlights, editor_text_spans, find_arg_tokens, ArgTokenSpan,
};
use crate::theme::{ThemeBg, ThemeColor};
use crate::width::str_width;
use crate::{Line, Span};
use pa_types::slash_commands::SlashCommandRegistry;
use ratatui::style::Style;

impl AgentView {
    /// Render the dock: prompt-context row(s), the autocomplete overlay
    /// (when showing), the editor surface, the tray, and the subagent
    /// summary box (TS `SubagentSummaryLine` under the tray).
    pub fn render_dock(&mut self, width: usize) -> Vec<Line> {
        // The queued-input strip sits directly above the prompt dock rows
        // (TS `queuedMessagesContainer` above the editor).
        let browse_key = {
            let kb = self.editor.keybindings();
            crate::keybindings::format_key_text(&kb.get_keys("app.message.navigateOlder").join("/"))
        };
        let queue_rows = crate::queued::render_queue(&self.theme, &self.queued, &browse_key, width);
        let mut lines = queue_rows;
        lines.extend(render_prompt_context(
            &self.detail_label(),
            &self.theme,
            width,
        ));
        let context_rows = lines.len();
        let overlay_rows = self.render_autocomplete_overlay(width);
        lines.extend(overlay_rows);
        let overlay_count = lines.len() - context_rows;
        let (editor_rows, cursor) = self.render_editor_surface(width, context_rows + overlay_count);
        self.dock_cursor = cursor.map(|(row, col)| (context_rows + overlay_count + row, col));
        lines.extend(editor_rows);
        // The tray's `← manage` hint is a click region (operator
        // directive 2026-09-29): its own cells — never the depth label
        // beside them — perform the hinted agents-back handoff.
        let tray_row = lines.len();
        let (tray, tray_hint) = render_tray_with_hint(&self.chrome, &self.theme, width);
        lines.push(tray);
        if let Some(hint) = tray_hint.filter(|hint| hint.start < width) {
            self.click.record_dock_region(DockClickRegion {
                dock_row: tray_row,
                cols: hint.start..hint.end.min(width),
                action: ClickAction::OpenAgentsView,
            });
        }
        // The activity dock's group segments are click regions too:
        // the groups sit on the frame's second row, under the rule.
        if let Some(dock) = &self.chrome.activity {
            let (frame, segments) =
                crate::chrome::render_activity_dock_segments(dock, &self.theme, width);
            for segment in segments {
                self.click.record_dock_region(DockClickRegion {
                    dock_row: tray_row + 2,
                    cols: segment.cols,
                    action: ClickAction::OpenDockGroup(segment.group),
                });
            }
            lines.extend(frame);
        }
        // The `/speed` footer (TS `footerSlot`, the main container's last
        // child): a dim row only while the display is on with a sample.
        if let Some(speed) = &self.chrome.speed_text {
            lines.push(crate::chrome::render_speed_footer(
                speed,
                &self.theme,
                width,
            ));
        }
        lines
    }

    /// The autocomplete dropdown, mounted just above the editor surface (TS
    /// anchors the overlay immediately above the cursor row; the editor's
    /// first content row carries the cursor in the common single-line
    /// case). The panel opens with the one full-width muted rule every
    /// inline menu panel opens with (the operator's 2026-09-26 top-border
    /// directive), its rows pad to the input width and float on the popup
    /// background between the editor's left padding and prompt prefix, and
    /// the selected row's wash spans the panel's full width like the
    /// `/model` picker's selected row.
    fn render_autocomplete_overlay(&mut self, width: usize) -> Vec<Line> {
        let Some(state) = self.editor.autocomplete_state() else {
            return Vec::new();
        };
        let theme = &self.theme;
        let bg = self.theme.bg_style(ThemeBg::ToolPanelBg);
        let selection = self.theme.soft_selection_style();
        let padding_x = 2usize;
        // The overlay anchors against the live prompt prefix (TS
        // `getRenderMetrics`'s `promptPrefixWidth`, the `!`/`!!` prompts
        // included).
        let prompt_width = str_width(self.editor.bash_prompt_prefix().unwrap_or("> "));
        let content_width = width.saturating_sub(padding_x * 2).max(1);
        let input_width = content_width.saturating_sub(prompt_width).max(1);
        // The panel's top border: the muted `─` rule that separates an
        // inline menu panel from the rows above it, drawn on the panel
        // surface.
        let border = theme.fg_style(ThemeColor::BorderMuted).patch(bg);
        let mut rows: Vec<Line> = vec![vec![Span::styled("\u{2500}".repeat(width.max(1)), border)]];
        let mut overlay = Vec::new();
        overlay.extend(state.render(theme, input_width));
        overlay.push(Vec::new());
        for mut line in overlay {
            // The shared menu rows pad to the full input width with
            // unstyled spans, so the remaining-width fill below never
            // lands: the popup background must ride on every span the
            // row left unstyled. The selected row is the one whose spans
            // carry the selection band: its edge padding washes with the
            // selection too, so the band spans the panel's full width
            // instead of stopping at the input's edges.
            let selected = line.iter().any(|span| span.style.bg.is_some());
            for span in &mut line {
                if span.style.bg.is_none() {
                    span.style = span.style.patch(bg);
                }
            }
            let used: usize = line.iter().map(|s| str_width(&s.content)).sum();
            let edge = if selected { bg.patch(selection) } else { bg };
            let mut row: Line = vec![Span::styled(" ".repeat(padding_x + prompt_width), edge)];
            row.extend(line);
            row.push(Span::styled(
                " ".repeat(input_width.saturating_sub(used)),
                edge,
            ));
            row.push(Span::styled(" ".repeat(padding_x), edge));
            rows.push(pad_row(row, width));
        }
        rows
    }

    /// The editor surface (TS `Editor.render` with a background): a blank
    /// bg row, content rows with the `> ` prompt and a reverse-video cursor,
    /// and a trailing bg row. Scroll indicators replace the blank rows.
    fn render_editor_surface(
        &mut self,
        width: usize,
        dock_row: usize,
    ) -> (Vec<Line>, Option<(usize, usize)>) {
        let bg = crate::chrome::editor_background(&self.theme);
        let border = self.theme.fg_style(ThemeColor::BorderMuted);
        let padding_x = 2usize;
        let content_width = width.saturating_sub(padding_x * 2).max(1);
        // TS `getPromptPrefix` + `getRenderMetrics`: a bang first line
        // swaps the `> ` for the `! `/`!! ` prompt (styled through the
        // editor border color, `formatPromptPrefix`), which also narrows
        // the input width.
        let bash_prompt = self.editor.bash_prompt_prefix();
        let prompt = bash_prompt.unwrap_or("> ");
        let prompt_width = str_width(prompt);
        let input_width = content_width.saturating_sub(prompt_width).max(1);
        let layout_width = input_width;
        let (visible, scroll_offset, _hidden_above, hidden_below) =
            self.editor.visible_window(layout_width, self.terminal_rows);
        // The content rows' click surface (view/click.rs): the TS editor
        // registers one region over its visible content rows, shifted by
        // the queue-selection header's rows (TS `getContentLineOffset`).
        self.click.record_editor(EditorClickSurface {
            dock_row,
            rows: visible.len(),
            queue_header_rows: usize::from(self.queue_selected.is_some()) * 2,
            prompt_width,
            content_width: layout_width,
        });
        let mut rows: Vec<Line> = Vec::new();
        if scroll_offset > 0 {
            let indicator = format!(" \u{2191} {scroll_offset} more");
            rows.push(indicator_row(&indicator, bg, border, width));
        } else {
            rows.push(vec![Span::styled(" ".repeat(width), bg)]);
        }
        if let Some(selected) = &self.queue_selected {
            // TS `getQueueSelectionHeader` (the editor's header line while a
            // parked message is selected): `CustomEditor.render` inserts the
            // dim header row plus an empty companion row BELOW the top row,
            // so the editor box grows by two rows while a message is selected
            // (TS `getContentLineOffset` shifts the click regions with it).
            let keys = {
                let kb = self.editor.keybindings();
                let display =
                    |id: &str| crate::keybindings::format_key_text(&kb.get_keys(id).join("/"));
                crate::queued::QueueBrowseKeys {
                    navigate_older: display("app.message.navigateOlder"),
                    navigate_newer: display("app.message.navigateNewer"),
                    move_earlier: display("app.message.moveEarlier"),
                    move_later: display("app.message.moveLater"),
                    follow_up: display("app.message.followUp"),
                }
            };
            // Dim text on the editor background (the header line renders
            // inside the editor box like the `> ` rows): the dim
            // foreground patched over the editor background style.
            let dim = bg.patch(self.theme.fg_style(ThemeColor::Dim));
            let header = crate::queued::browse_header_text(selected, &keys);
            let mut row: Line = vec![Span::styled(" ".repeat(padding_x), bg)];
            let line: Line = vec![Span::styled(header, dim)];
            row.extend(crate::width::truncate_line(&line, content_width, "..."));
            let used = crate::width::line_width(&row);
            row.push(Span::styled(" ".repeat(width.saturating_sub(used)), bg));
            rows.push(row);
            rows.push(vec![Span::styled(" ".repeat(width), bg)]);
        }
        // TS `CustomEditor.render`: a bare `--` separator highlights only
        // while the first line opens with an argument-taking slash command.
        let selection = self.editor.selection_range();
        let editor_lines = self.editor.get_lines();
        let registry = SlashCommandRegistry::builtin_cached();
        let include_bare_separator = editor_lines
            .first()
            .and_then(|first| command_token(first))
            .is_some_and(|token| registry.takes_argument(&token.name));
        let arg_token_spans: Vec<Vec<ArgTokenSpan>> = editor_lines
            .iter()
            .map(|line| find_arg_tokens(line, 0, include_bare_separator))
            .collect();
        let mut cursor: Option<(usize, usize)> = None;
        for (index, line) in visible.iter().enumerate() {
            let mut row: Line = vec![Span::styled(" ".to_string(), bg)];
            // The `> ` prompt prefix renders plain on the surface
            // background; the `!` bash prompts render through the editor
            // border color (TS `formatPromptPrefix`).
            if index == 0 {
                let style = if bash_prompt.is_some() { border } else { bg };
                row.push(Span::styled(prompt.to_string(), style));
            } else {
                row.push(Span::styled(" ".repeat(prompt_width), bg));
            }
            row.push(Span::styled(" ".to_string(), bg));
            let text: &str = &line.text;
            let cursor_pos = line
                .has_cursor
                .then(|| line.cursor_pos.min(text.chars().count()));
            // The prompt-highlight spans of this chunk: argument tokens, and
            // the command token of the first layout line in accent unless
            // the cursor sits inside it (TS `styleDisplayText`).
            let command = (scroll_offset + index == 0)
                .then(|| command_token(text))
                .flatten();
            let command_takes_argument = command
                .as_ref()
                .is_some_and(|token| registry.takes_argument(&token.name));
            let highlights = editor_chunk_highlights(
                text,
                arg_token_spans
                    .get(line.source_line)
                    .map_or(&[][..], |spans| spans),
                line.source_start,
                command.as_ref(),
                command_takes_argument,
                cursor_pos,
            );
            row.extend(editor_text_spans(
                &self.theme,
                text,
                &highlights,
                chunk_selection(selection, line.source_line, line.source_start, text),
                cursor_pos,
                bg,
            ));
            let mut used = str_width(text);
            if cursor_pos == Some(text.chars().count()) {
                // The end-of-line cursor appends one reversed cell.
                used += 1;
            }
            if let Some(position) = cursor_pos {
                let head = split_at_chars(text, position).0;
                cursor = Some((index + 1, str_width(head) + prompt_width + 2));
            }
            row.push(Span::styled(
                " ".repeat(input_width.saturating_sub(used)),
                bg,
            ));
            row.push(Span::styled(" ".repeat(padding_x), bg));
            rows.push(row);
        }
        if hidden_below > 0 {
            rows.push(indicator_row(
                &format!(" \u{2193} {hidden_below} more"),
                bg,
                border,
                width,
            ));
        } else {
            rows.push(vec![Span::styled(" ".repeat(width), bg)]);
        }
        (rows, cursor)
    }

    /// The `/share` loader rows (TS `BorderedLoader` + `CancellableLoader`):
    /// border, spinner + message, cancel hint, border — replacing the
    /// editor in the dock while `gh gist create` runs.
    pub(super) fn render_share_loader(&self, loader: &ShareLoader, width: usize) -> Vec<Line> {
        let border = self.theme.fg_style(ThemeColor::Border);
        let muted = self.theme.fg_style(ThemeColor::Muted);
        let dim = self.theme.fg_style(ThemeColor::Dim);
        let spinner =
            crate::chat::LOADER_FRAMES[self.pulse_frame % crate::chat::LOADER_FRAMES.len()];
        let mut rows: Vec<Line> = Vec::with_capacity(7);
        rows.push(vec![Span::styled("─".repeat(width.max(1)), border)]);
        let mut row: Line = vec![Span::styled(" ".to_string(), Style::default())];
        // TS `BorderedLoader` wraps a `Loader` with the muted spinner and
        // muted message color fns; the gap between them is the unstyled
        // plain space (the `Loader` pen reset — see `chat::render_loader`).
        row.push(Span::styled(spinner.to_string(), muted));
        row.push(Span::raw(" ".to_string()));
        row.push(Span::styled(loader.message.clone(), muted));
        rows.push(row);
        rows.push(vec![Span::raw(String::new())]);
        // TS `keyHint("tui.select.cancel", "cancel")`: every key of the
        // binding, first letter capitalized, then the description.
        let key_text = self.editor.keybindings().key_text("tui.select.cancel");
        let mut hint: Line = vec![Span::styled(" ".to_string(), Style::default())];
        hint.push(Span::styled(key_text, dim));
        hint.push(Span::styled(" cancel".to_string(), muted));
        rows.push(hint);
        rows.push(vec![Span::raw(String::new())]);
        rows.push(vec![Span::styled("─".repeat(width.max(1)), border)]);
        rows
    }

    /// The `/reload` box (TS `handleReloadCommand`): `DynamicBorder`, blank,
    /// the muted message, blank, `DynamicBorder` — the editor container's
    /// replacement while the reload runs.
    pub(super) fn render_reload_box(&self, message: &str, width: usize) -> Vec<Line> {
        let border = self.theme.fg_style(ThemeColor::Border);
        let muted = self.theme.fg_style(ThemeColor::Muted);
        let rule = "─".repeat(width.max(1));
        let rows: Vec<Line> = vec![
            vec![Span::styled(rule.clone(), border)],
            vec![Span::raw(String::new())],
            vec![
                Span::raw(" ".to_string()),
                Span::styled(message.to_string(), muted),
            ],
            vec![Span::raw(String::new())],
            vec![Span::styled(rule, border)],
        ];
        rows
    }
}
