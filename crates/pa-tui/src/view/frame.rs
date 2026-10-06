//! The frame compose: the fullscreen frame (top bar, padded transcript
//! window, dock at the bottom), the inline exit layout, the hardware-
//! cursor query, and the compose free helpers.

use super::click::{
    self, PickerClickSurface, PickerKind, EFFORT_PICKER_CHROME_ROWS, MODEL_PICKER_CHROME_ROWS,
};
use super::AgentView;
use super::FULLSCREEN_MIN_TRANSCRIPT_ROWS;
use crate::chrome::{render_prompt_context, render_top_bar};
use crate::width::str_width;
use crate::{Line, Span};
use ratatui::style::{Modifier, Style};

impl AgentView {
    /// Compose the fullscreen frame: top bar, transcript window, dock —
    /// exactly `height` rows.
    pub fn render_frame(&mut self, width: usize, height: usize) -> Vec<Line> {
        // The fullscreen compose forces image components to their textual fallback: re-emitting
        // an image placement each repaint would corrupt the display.
        let frame = crate::image_component::with_fullscreen_image_fallback(|| {
            self.render_frame_inner(width, height)
        });
        // The composed frame is the click surface (TS `hyperlinkAt` reads the last painted
        // frame's OSC 8 sequences): one scan serves every pane.
        self.frame_links = crate::hyperlinks::frame_link_ranges(&frame);
        frame
    }

    fn render_frame_inner(&mut self, width: usize, height: usize) -> Vec<Line> {
        // The click surface records this frame's geometry as the compose
        // computes it.
        self.click.clear();
        // The onboarding splash covers the pane (TS `showOverlay` 100%); its rows select, so
        // the frame-selection regions span the whole frame.
        if let Some(screen) = self.onboarding.as_mut() {
            let kb = self.editor.keybindings();
            let mut frame = screen.render(&self.theme, width, height, kb);
            self.frame_rows = frame.len();
            self.apply_frame_selection(&mut frame, 0, width);
            return frame;
        }
        // The `/model` and `/effort` pickers mount in the editor dock
        // (TS `showConfigurationMenu`); the prompt context stays above.
        let prompt_context = render_prompt_context(&self.detail_label(), &self.theme, width);
        // The info panel's CURRENT row budget (a resize re-budgets every
        // frame): read before the borrow.
        let info_viewport_rows = crate::session_ui::picker_viewport_rows(self.terminal_rows());
        let pane_row = prompt_context.len();
        let picker_dock: Option<Vec<Line>> = if let Some(picker) = self.model_picker.as_mut() {
            let mut dock = prompt_context;
            dock.extend(picker.render(&self.theme, width, self.editor.keybindings()));
            // The pane's item rows are clickable: the recorded span
            // covers the filtered window the render drew.
            self.click.record_picker(PickerClickSurface {
                dock_row: pane_row,
                chrome_rows: MODEL_PICKER_CHROME_ROWS,
                items: picker.filtered_window(),
                kind: PickerKind::Model,
            });
            Some(dock)
        } else if let Some(picker) = &self.effort_picker {
            let mut dock = prompt_context;
            dock.extend(picker.render(&self.theme, width, self.editor.keybindings()));
            self.click.record_picker(PickerClickSurface {
                dock_row: pane_row,
                chrome_rows: EFFORT_PICKER_CHROME_ROWS,
                items: picker.visible_window(),
                kind: PickerKind::Effort,
            });
            Some(dock)
        } else if let Some(mcp_view) = self.mcp_view.as_mut() {
            let mut dock = prompt_context;
            dock.extend(mcp_view.render(&self.theme, width, self.editor.keybindings()));
            Some(dock)
        } else if let Some(factory_view) = self.factory_view.as_ref() {
            let mut dock = prompt_context;
            dock.extend(factory_view.render(&self.theme, width, self.editor.keybindings()));
            Some(dock)
        } else if let Some(picker) = &self.heartbeats_picker {
            let mut dock = prompt_context;
            dock.extend(picker.render(&self.theme, width, self.editor.keybindings()));
            Some(dock)
        } else if let Some(panel) = &self.goal_panel {
            let mut dock = prompt_context;
            dock.extend(crate::goal_surface::render_goal_panel(
                panel,
                &self.theme,
                width,
                self.editor.keybindings(),
            ));
            Some(dock)
        } else if let Some(view) = self.bash_view.as_ref() {
            let mut dock = prompt_context;
            dock.extend(view.render(&self.theme, width, self.editor.keybindings()));
            Some(dock)
        } else if let Some(panel) = self.info_panel.as_mut() {
            let mut dock = prompt_context;
            dock.extend(panel.render(
                &self.theme,
                width,
                self.editor.keybindings(),
                &self.code_block_indent,
                info_viewport_rows,
            ));
            Some(dock)
        } else {
            None
        };
        // The tree and fork selectors mount in the editor container
        // (TS `showSelector`): an auto-height pane over the dock's rows.
        let selector_dock: Option<Vec<Line>> = if self.tree_selector.is_some()
            || self.fork_selector.is_some()
            || self.share_loader.is_some()
            || self.confirm.is_some()
            || self.provider_auth.is_some()
            || self.auth_panel.is_some()
            || self.reload_box.is_some()
            || self.settings_menu.is_some()
        {
            // TS's editor container holds the prompt context and the
            // editor; `showSelector` replaces the editor part.
            let mut dock = render_prompt_context(&self.detail_label(), &self.theme, width);
            if let Some(selector) = self.tree_selector.as_ref() {
                dock.extend(selector.render(&self.theme, width, self.editor.keybindings()));
            } else if let Some(selector) = self.fork_selector.as_ref() {
                dock.extend(selector.render(&self.theme, width, self.editor.keybindings()));
            } else if let Some(loader) = self.share_loader.as_ref() {
                dock.extend(self.render_share_loader(loader, width));
            } else if let Some(confirm) = self.confirm.as_ref() {
                dock.extend(confirm.render(&self.theme, width, self.editor.keybindings()));
            } else if let Some(selector) = self.provider_auth.as_mut() {
                dock.extend(selector.render(&self.theme, width, self.editor.keybindings()));
            } else if let Some(panel) = self.auth_panel.as_mut() {
                let kb = self.editor.keybindings();
                dock.extend(panel.render(&self.theme, width, kb));
            } else if let Some(message) = self.reload_box.as_ref() {
                dock.extend(self.render_reload_box(message, width));
            } else if let Some(menu) = self.settings_menu.as_ref() {
                dock.extend(menu.render(&self.theme, width, self.editor.keybindings()));
            }
            Some(dock)
        } else {
            picker_dock
        };
        // The top bar always renders: the surface is fullscreen-only
        // (operator ruling 2026-09-28 — the bar has no gate left).
        let top = render_top_bar(&self.chrome, &self.theme, width);
        let top_rows = 1;
        let dock = match selector_dock {
            // The replacement surfaces swap only the editor part; the `/speed` footer stays
            // the dock's last row (TS `footerSlot`).
            Some(mut dock) => {
                if let Some(speed) = &self.chrome.speed_text {
                    dock.push(crate::chrome::render_speed_footer(
                        speed,
                        &self.theme,
                        width,
                    ));
                }
                dock
            }
            None => self.render_dock(width),
        };
        let dock_height = dock
            .len()
            .min(height.saturating_sub(FULLSCREEN_MIN_TRANSCRIPT_ROWS));
        let cropped = dock.len().saturating_sub(dock_height);
        // The hardware cursor rides the dock's rows: a front crop removes
        // the first `cropped` rows, so subtract — or the reported cursor
        // lands below the editor.
        self.dock_cursor = self
            .dock_cursor
            .map(|(row, col)| (row.saturating_sub(cropped), col));
        let dock: Vec<Line> = if dock.len() > dock_height {
            dock[dock.len() - dock_height..].to_vec()
        } else {
            dock
        };
        let window_height = height
            .saturating_sub(top_rows + dock.len())
            .max(FULLSCREEN_MIN_TRANSCRIPT_ROWS.min(height.saturating_sub(top_rows + dock.len())));
        let (window_rows, start) = self.visible_transcript_window(width, window_height);
        self.window_rows = window_height;
        // The selection restyle diff: only the rows the selection change
        // touched re-style.
        let window_rows = self.selection_styled_window(window_rows, start);
        let mut frame: Vec<Line> = Vec::with_capacity(height);
        frame.push(pad_row(top, width));
        for line in window_rows {
            frame.push(pad_row(line, width));
        }
        while frame.len() < height.saturating_sub(dock.len()) {
            frame.push(vec![Span::raw(" ".repeat(width))]);
        }
        // The click surface's frame scalars: a click's dock row indexes
        // the un-cropped dock.
        self.click.note_frame(top_rows, frame.len(), cropped);
        for line in dock {
            frame.push(pad_row(line, width));
        }
        // The hover affordance (operator directive 2026-09-26): the hovered card row brightens,
        // revalidated against THIS frame's click surface.
        if let Some((row, col)) = self.hover_pos {
            match self.click_target_at(row, col) {
                Some(click::ClickAction::ToggleCardExpansion(_)) => {
                    if let Some(line) = frame.get_mut(row) {
                        apply_hover_affordance(line, &self.theme);
                    }
                }
                // The dock's hover affordance (operator directive 2026-09-29): the hovered
                // segment or tray hint carries the ONE light band; the focused group's
                // selection band stays.
                Some(click::ClickAction::OpenDockGroup(_) | click::ClickAction::OpenAgentsView) => {
                    if let Some(region) = self.dock_region_at(row, col) {
                        if let Some(line) = frame.get_mut(row) {
                            self.theme.paint_hover_band(line, region.cols.clone());
                        }
                    }
                }
                _ => self.hover_pos = None,
            }
        }
        // A paused viewport carries the follow hint over the last window row — only when
        // following would actually scroll (operator directive 2026-09-26).
        if !self.following && !self.window_shows_tail {
            if let Some(row) = frame.get_mut(window_height) {
                let key = self
                    .editor
                    .keybindings()
                    .first_key("tui.viewport.follow")
                    .unwrap_or_else(|| "ctrl+shift+down".to_string());
                let label = format!(" {key} to follow ");
                *row = composite_follow_hint(row, &label, width);
                // The hint's row never reads as the content beneath it.
                self.click.mask_rows(window_height, window_height + 1);
            }
        }
        self.frame_rows = frame.len();
        self.apply_frame_selection(
            &mut frame,
            crate::selection::HEADER_ROWS + self.window_rows,
            width,
        );
        // The action toasts overlay the transcript window's top rows. The overlay sits out an
        // in-progress selection drag: releasing over covered text could copy content that was
        // not visible.
        let now = std::time::Instant::now();
        let toasts: Vec<String> = if self.selection.is_dragging() {
            Vec::new()
        } else {
            self.toasts.active(now)
        };
        if !toasts.is_empty() {
            // The action ack renders as the brand-purple pill (the
            // operator directive): the theme's Accent token flipped onto
            // the pill's background by REVERSED.
            let style = self
                .theme
                .fg_style(crate::theme::ThemeColor::Accent)
                .add_modifier(Modifier::REVERSED);
            crate::toast::overlay_toasts(
                &mut frame,
                top_rows,
                top_rows + window_height,
                &toasts,
                width,
                style,
            );
            // A click on the transient pill must not fire the hidden
            // row's target.
            let covered = toasts.len().min(window_height);
            self.click.mask_rows(top_rows, top_rows + covered);
        }
        frame
    }

    /// Hardware cursor position within the last composed frame, when the
    /// editor surface drew the cursor.
    pub fn frame_cursor(&self) -> Option<(usize, usize)> {
        if self.onboarding.is_some()
            || self.model_picker.is_some()
            || self.effort_picker.is_some()
            || self.heartbeats_picker.is_some()
            || self.goal_panel.is_some()
            || self.bash_view.is_some()
            || self.info_panel.is_some()
            || self.tree_selector.is_some()
            || self.fork_selector.is_some()
            || self.share_loader.is_some()
            || self.confirm.is_some()
            || self.provider_auth.is_some()
            || self.auth_panel.is_some()
            || self.reload_box.is_some()
            || self.settings_menu.is_some()
            || self.factory_view.is_some()
        {
            return None;
        }
        self.dock_cursor
            .map(|(row, col)| (row + 1 + self.window_rows, col))
    }

    /// The inline layout the exit flush paints onto the main screen: the full transcript plus
    /// the dock, without the fullscreen window. These rows persist in the terminal's native
    /// scrollback.
    pub fn render_inline_frame(&mut self, width: usize) -> Vec<Line> {
        let mut rows = self.render_transcript(width);
        rows.extend(self.render_dock(width));
        // The inline layout has no fullscreen window on screen: a click
        // must never resolve against a dock the terminal does not show.
        self.click.clear();
        rows
    }
}

/// The hover affordance's row restyle (operator directive 2026-09-26): Muted spans brighten to
/// the theme's foreground, Dim to Muted.
fn apply_hover_affordance(row: &mut Line, theme: &crate::theme::Theme) {
    let muted = theme.fg_style(crate::theme::ThemeColor::Muted).fg;
    let dim = theme.fg_style(crate::theme::ThemeColor::Dim).fg;
    let text = theme.fg_style(crate::theme::ThemeColor::Text);
    let bright = theme.fg_style(crate::theme::ThemeColor::Muted);
    for span in row.iter_mut() {
        if span.style.fg == muted {
            span.style = span.style.patch(text);
        } else if span.style.fg == dim {
            span.style = span.style.patch(bright);
        }
    }
}

pub(super) fn indicator_row(indicator: &str, bg: Style, border: Style, width: usize) -> Line {
    // The indicator text paints on the editor surface's background too (operator directive
    // 2026-09-26): the `↑/↓ N more` rows read as part of the prompt bar.
    let mut row: Line = vec![Span::styled(indicator.to_string(), border.patch(bg))];
    let used = str_width(indicator);
    row.push(Span::styled(" ".repeat(width.saturating_sub(used)), bg));
    row
}

/// Pad a rendered row to the full width (default background).
pub(super) fn pad_row(line: Line, width: usize) -> Line {
    let used: usize = line.iter().map(|s| str_width(&s.content)).sum();
    let mut out = line;
    if used < width {
        out.push(Span::raw(" ".repeat(width - used)));
    }
    out
}

/// Composite the follow hint over one frame row (TS `renderFullscreen`: reversed, centered).
/// Leading OSC-133 zone markers stay at the row head so the marker plan keeps flagging.
pub(super) fn composite_follow_hint(row: &Line, label: &str, width: usize) -> Line {
    let label_width = str_width(label);
    let (markers, rest) = crate::osc133::split_leading_markers(row);
    let col = width.saturating_sub(label_width) / 2;
    let mut out: Line = markers;
    out.extend(crate::width::slice_line_by_column_strict(
        &rest, 0, col, true,
    ));
    out.push(Span::styled(
        label.to_string(),
        Style::default().add_modifier(Modifier::REVERSED),
    ));
    out.extend(crate::width::slice_line_by_column_strict(
        &rest,
        col.saturating_add(label_width),
        width,
        true,
    ));
    out
}
