//! Editor layout for rendering: layout lines, scroll window, cursor position.

use super::*;
use crate::width::str_width;

impl Editor {
    /// Build layout lines for a given content width (port of layoutText).
    pub fn layout_text(&self, content_width: usize) -> Vec<LayoutLine> {
        let mut layout_lines = Vec::new();
        if self.lines.is_empty() || (self.lines.len() == 1 && self.lines[0].is_empty()) {
            layout_lines.push(LayoutLine {
                text: String::new(),
                has_cursor: true,
                cursor_pos: 0,
                source_line: 0,
                source_start: 0,
            });
            return layout_lines;
        }
        for (i, line) in self.lines.iter().enumerate() {
            let is_current = i == self.cursor_line;
            let line_vis_width = str_width(line);
            if line.is_empty() {
                layout_lines.push(LayoutLine {
                    text: String::new(),
                    has_cursor: is_current,
                    cursor_pos: 0,
                    source_line: i,
                    source_start: 0,
                });
                continue;
            }
            if line_vis_width <= content_width {
                if is_current {
                    layout_lines.push(LayoutLine {
                        text: line.clone(),
                        has_cursor: true,
                        cursor_pos: self.cursor_col.min(line.chars().count()),
                        source_line: i,
                        source_start: 0,
                    });
                } else {
                    layout_lines.push(LayoutLine {
                        text: line.clone(),
                        has_cursor: false,
                        cursor_pos: 0,
                        source_line: i,
                        source_start: 0,
                    });
                }
            } else {
                let chunks = word_wrap_line(line, content_width, Some(self.segment(line)));
                for (chunk_index, chunk) in chunks.iter().enumerate() {
                    let cursor_pos = self.cursor_col;
                    let is_last = chunk_index == chunks.len() - 1;
                    let (has_cursor, adjusted) = if is_current {
                        if is_last {
                            (
                                cursor_pos >= chunk.start_index,
                                cursor_pos.saturating_sub(chunk.start_index),
                            )
                        } else if cursor_pos >= chunk.start_index && cursor_pos < chunk.end_index {
                            let adj = cursor_pos - chunk.start_index;
                            (true, adj.min(chunk.text.chars().count()))
                        } else {
                            (false, 0)
                        }
                    } else {
                        (false, 0)
                    };
                    layout_lines.push(LayoutLine {
                        text: chunk.text.clone(),
                        has_cursor,
                        cursor_pos: adjusted,
                        source_line: i,
                        source_start: chunk.start_index,
                    });
                }
            }
        }
        layout_lines
    }

    /// Compute the scroll window and the visible layout lines. Returns
    /// (visible lines, scroll offset, lines hidden above, lines hidden below).
    pub fn visible_window(
        &mut self,
        width: usize,
        terminal_rows: u16,
    ) -> (Vec<LayoutLine>, usize, usize, usize) {
        self.last_width = width.max(1);
        self.terminal_rows = terminal_rows;
        let layout_lines = self.layout_text(self.last_width);
        let max_visible = (terminal_rows as f32 * 0.3).floor().max(5.0) as usize;
        let cursor_line_index = layout_lines.iter().position(|l| l.has_cursor).unwrap_or(0);
        if cursor_line_index < self.scroll_offset {
            self.scroll_offset = cursor_line_index;
        } else if cursor_line_index >= self.scroll_offset + max_visible {
            self.scroll_offset = cursor_line_index + 1 - max_visible;
        }
        let max_scroll = layout_lines.len().saturating_sub(max_visible);
        self.scroll_offset = self.scroll_offset.min(max_scroll);
        let end = (self.scroll_offset + max_visible).min(layout_lines.len());
        let visible: Vec<LayoutLine> = layout_lines[self.scroll_offset..end].to_vec();
        let below = layout_lines.len().saturating_sub(end);
        (visible, self.scroll_offset, self.scroll_offset, below)
    }

    pub fn cursor_visual(&self, visible: &[LayoutLine]) -> Option<(usize, usize)> {
        visible
            .iter()
            .position(|l| l.has_cursor)
            .map(|row| (row, visible[row].cursor_pos))
    }
}
