//! The panel assembly: the dock — prompt-context rows, the queued-input
//! strip, the autocomplete overlay, the editor surface, the tray, the
//! subagent summary box (TS `SubagentSummaryLine`) — plus the share
//! loader and reload-box panels that replace the editor in flight.

use super::click::{ClickAction, DockClickRegion, EditorClickSurface};
use super::editor_surface;
use super::{AgentView, ShareLoader};
use crate::chrome::{render_prompt_context, render_tray_with_hint};
use crate::theme::ThemeColor;
use crate::{Line, Span};
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
        editor_surface::overlay(&self.editor, &self.theme, width)
    }

    /// The editor surface (TS `Editor.render` with a background): a blank
    /// bg row, content rows with the `> ` prompt and a reverse-video cursor,
    /// and a trailing bg row. Scroll indicators replace the blank rows.
    fn render_editor_surface(
        &mut self,
        width: usize,
        dock_row: usize,
    ) -> (Vec<Line>, Option<(usize, usize)>) {
        // TS `getQueueSelectionHeader` (the editor's header line while a
        // parked message is selected): the dim browse text on the editor
        // background, rendered by the shared box's header block.
        let header = self.queue_selected.as_ref().map(|selected| {
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
            let dim = crate::chrome::editor_background(&self.theme)
                .patch(self.theme.fg_style(ThemeColor::Dim));
            vec![Span::styled(
                crate::queued::browse_header_text(selected, &keys),
                dim,
            )]
        });
        let surface = editor_surface::render(
            &mut self.editor,
            &self.theme,
            width,
            self.terminal_rows,
            header,
            None,
        );
        // The content rows' click surface (view/click.rs): the TS editor
        // registers one region over its visible content rows, shifted by
        // the header block's rows (TS `getContentLineOffset`).
        self.click.record_editor(EditorClickSurface {
            dock_row,
            rows: surface.visible_rows,
            content_offset: surface.content_offset,
            prompt_width: surface.prompt_width,
            content_width: surface.content_width,
        });
        (surface.rows, surface.cursor)
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
