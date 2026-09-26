//! Click-to-place-caret (TS `editor.ts`'s `placeCursorFromClick` and
//! `snapCursorOffset`): a plain click on one of the editor's visible
//! content rows places the caret at the clicked cell. The click's row
//! indexes the rendered layout (the visible window), its column maps
//! through the row's layout chunk into the source line, and grapheme
//! segments snap by their visible-width midpoint — a click past the
//! middle of a wide cell or an atomic paste marker lands after it.

use super::*;
use crate::width::str_width;

/// One source-line char span, `[from, to)`.
fn char_span(line: &str, from: usize, to: usize) -> String {
    line.chars()
        .skip(from)
        .take(to.saturating_sub(from))
        .collect()
}

impl Editor {
    /// Place the caret at the clicked cell: `click_row` indexes the
    /// editor's visible content rows, `click_col` is the column relative
    /// to the row's text start, and `content_width` is the width the
    /// rendered layout wrapped at.
    pub fn place_cursor_from_click(
        &mut self,
        content_width: usize,
        click_row: usize,
        click_col: usize,
    ) {
        let layout = self.layout_text(content_width.max(1));
        let Some(line) = layout.get(self.scroll_offset + click_row) else {
            return;
        };
        let Some(source_line) = self.lines.get(line.source_line) else {
            return;
        };
        let segments = self.segment(source_line);
        // The chunk this row renders: `[from, to)` in source chars.
        let from = line.source_start;
        let to = from + line.text.chars().count();
        let mut chunk_col = 0usize;
        let mut placed = to;
        for segment in &segments {
            let seg_end = segment.index + segment.segment.chars().count();
            if seg_end <= from {
                continue;
            }
            if segment.index >= to {
                break;
            }
            let slice_start = segment.index.max(from);
            let in_chunk = str_width(&char_span(source_line, slice_start, seg_end.min(to)));
            if chunk_col + in_chunk > click_col {
                // The click lands inside this segment: past its visible
                // midpoint the caret snaps after it, before it otherwise.
                let within = str_width(&char_span(source_line, segment.index, slice_start))
                    + (click_col - chunk_col);
                placed = if 2 * within >= str_width(&segment.segment) {
                    seg_end
                } else {
                    segment.index
                };
                break;
            }
            chunk_col += in_chunk;
        }
        // A click past the chunk's text leaves the chunk-end offset,
        // which can sit inside an atomic marker split across rows: snap
        // onto the marker's nearest boundary.
        placed = snap_cursor_offset(&segments, placed);
        // A caret placement is a selection cancel: a stale
        // selection_anchor would make the next typed character replace
        // the old anchor-to-cursor range instead of inserting here.
        self.selection_anchor = None;
        self.last_action = None;
        self.cursor_line = line.source_line;
        self.set_cursor_col(placed);
    }
}

/// Snap an offset sitting inside an atomic segment (a paste marker) to
/// its nearest boundary (TS `snapCursorOffset`, char-length midpoint).
fn snap_cursor_offset(segments: &[Segment], offset: usize) -> usize {
    for segment in segments {
        let seg_end = segment.index + segment.segment.chars().count();
        if segment.index >= offset {
            break;
        }
        if offset < seg_end {
            return if 2 * (offset - segment.index) >= segment.segment.chars().count() {
                seg_end
            } else {
                segment.index
            };
        }
    }
    offset
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editor(text: &str) -> Editor {
        let mut editor = Editor::new();
        editor.set_text(text);
        editor
    }

    #[test]
    fn a_click_places_the_caret_at_the_clicked_column() {
        let mut editor = editor("hello world");
        editor.place_cursor_from_click(40, 0, 5);
        assert_eq!(editor.get_cursor(), (0, 5));
    }

    #[test]
    fn a_click_past_the_rows_text_lands_at_its_end() {
        let mut editor = editor("hello");
        editor.place_cursor_from_click(40, 0, 50);
        assert_eq!(editor.get_cursor(), (0, 5));
    }

    #[test]
    fn a_click_before_a_wide_cell_snaps_in_front_of_it() {
        let mut editor = editor("日本語 x");
        // `日` covers columns 0-1: the left edge snaps in front.
        editor.place_cursor_from_click(40, 0, 0);
        assert_eq!(editor.get_cursor(), (0, 0));
    }

    #[test]
    fn a_click_past_a_wide_cells_midpoint_snaps_after_it() {
        let mut editor = editor("日本語 x");
        // Column 1 is `日`'s midpoint: the caret lands after it, and
        // column 2 falls on `本`'s left edge (in front of it).
        editor.place_cursor_from_click(40, 0, 1);
        assert_eq!(editor.get_cursor(), (0, 1));
        editor.place_cursor_from_click(40, 0, 2);
        assert_eq!(editor.get_cursor(), (0, 1));
    }

    #[test]
    fn a_click_on_a_wrapped_row_places_the_caret_at_the_wrap_point() {
        // One long word hard-wraps at exactly the content width, so the
        // second row renders the continuation chunk: its column 0 is the
        // source line's column 10.
        let mut editor = editor("aaaaaaaaaabbbbbbbbbb");
        editor.place_cursor_from_click(10, 1, 0);
        assert_eq!(editor.get_cursor(), (0, 10));
        editor.place_cursor_from_click(10, 1, 5);
        assert_eq!(editor.get_cursor(), (0, 15));
    }

    #[test]
    fn a_click_cancels_a_shift_arrow_selection() {
        let mut editor = editor("hello world");
        // Shift+right extends the selection: the anchor sits at the
        // line's start with the caret after `h`.
        editor.set_cursor_for_tests(0, 0);
        editor.handle_input("shift+right");
        assert!(editor.selection_range().is_some(), "the selection opened");
        editor.place_cursor_from_click(40, 0, 5);
        assert_eq!(editor.selection_range(), None, "the click cancelled it");
        assert_eq!(editor.get_cursor(), (0, 5));
    }

    #[test]
    fn a_click_on_a_later_source_line_moves_the_caret_to_it() {
        let mut editor = Editor::new();
        editor.set_text("first\nsecond");
        editor.place_cursor_from_click(40, 1, 3);
        assert_eq!(editor.get_cursor(), (1, 3));
    }
}
