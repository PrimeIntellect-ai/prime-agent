//! Editor cursor movement: word/char motion, jump mode, sticky-column vertical
//! movement over the visual line map.

use super::text_utils::{char_find_after, char_find_before, char_prefix, char_suffix};
use super::*;
use crate::width::{is_punctuation_char, str_width};

impl Editor {
    // ---- cursor movement --------------------------------------------------

    pub(crate) fn set_cursor_col(&mut self, col: usize) {
        self.cursor_col = col;
        self.preferred_visual_col = None;
        self.snapped_from_cursor_col = None;
    }

    pub(crate) fn move_to_line_start(&mut self) {
        self.last_action = None;
        // Home lands after the hidden bang prefix (TS `moveToLineStart`).
        self.set_cursor_col(self.line_start_col(self.cursor_line));
    }

    pub(crate) fn move_to_line_end(&mut self) {
        self.last_action = None;
        let len = self.lines[self.cursor_line].chars().count();
        self.set_cursor_col(len);
    }

    /// Move to the start of the whole text (TS has no doc jump; the
    /// standard `Ctrl+Home` / macOS `Cmd+Up` editors' motion).
    pub(crate) fn move_to_doc_start(&mut self) {
        self.last_action = None;
        self.cursor_line = 0;
        self.set_cursor_col(self.line_start_col(0));
    }

    /// Place the caret from a click on the last rendered layout (TS
    /// `Editor.placeCursorFromClick`): `[from, to)` bounds the clicked
    /// visual chunk inside source line `line` (char offsets), `rel` is
    /// the clicked column past the chunk's text start. A click past the
    /// midpoint of an atomic segment (a wide grapheme or a paste marker)
    /// lands after it, before it otherwise; a click past the chunk's
    /// text keeps the chunk-end offset, snapped to a segment boundary.
    pub(crate) fn place_cursor_in_chunk(
        &mut self,
        line: usize,
        from: usize,
        to: usize,
        rel: usize,
    ) {
        let Some(source) = self.lines.get(line) else {
            return;
        };
        let source = source.clone();
        let slice =
            |from: usize, to: usize| -> String { char_suffix(&char_prefix(&source, to), from) };
        // Walk the source line's marker-aware graphemes covering this
        // visual chunk (TS iterates `this.segment(sourceLine)`).
        let mut chunk_col = 0usize;
        let mut placed = to;
        for seg in self.segment(&source) {
            let seg_end = seg.index + seg.segment.chars().count();
            if seg_end <= from {
                continue;
            }
            if seg.index >= to {
                break;
            }
            let slice_start = seg.index.max(from);
            let in_chunk_width = crate::width::str_width(&slice(slice_start, seg_end.min(to)));
            if chunk_col + in_chunk_width > rel {
                let within_segment = if slice_start > seg.index {
                    crate::width::str_width(&slice(seg.index, slice_start))
                } else {
                    0
                } + rel
                    - chunk_col;
                placed = if 2 * within_segment >= crate::width::str_width(&seg.segment) {
                    seg_end
                } else {
                    seg.index
                };
                break;
            }
            chunk_col += in_chunk_width;
        }
        // A click past the chunk's text (the trailing pad) leaves the
        // chunk-end offset, which can sit inside a marker split across
        // wrapped rows: snap to the nearest segment boundary.
        placed = self.snap_cursor_offset(&source, placed);
        self.cursor_line = line;
        self.last_action = None;
        self.set_cursor_col(placed);
    }

    /// Snap an offset sitting inside an atomic segment to its nearest
    /// boundary (TS `Editor.snapCursorOffset`).
    fn snap_cursor_offset(&self, line: &str, offset: usize) -> usize {
        for seg in self.segment(line) {
            let seg_end = seg.index + seg.segment.chars().count();
            if seg.index >= offset {
                break;
            }
            if offset < seg_end {
                return if 2 * (offset - seg.index) >= seg.segment.chars().count() {
                    seg_end
                } else {
                    seg.index
                };
            }
        }
        offset
    }

    /// Move to the end of the whole text (`Ctrl+End` / `Cmd+Down`).
    pub(crate) fn move_to_doc_end(&mut self) {
        self.last_action = None;
        self.cursor_line = self.lines.len() - 1;
        let len = self.lines[self.cursor_line].chars().count();
        self.set_cursor_col(len);
    }

    /// The first line of the paragraph containing `line` (paragraphs are
    /// blank-line separated; the bang prefix's line 0 is its own).
    fn paragraph_start(&self, mut line: usize) -> usize {
        while line > 0 && self.lines[line].trim().is_empty() {
            line -= 1;
        }
        while line > 0 && !self.lines[line - 1].trim().is_empty() {
            line -= 1;
        }
        line
    }

    /// The last line of the paragraph containing `line`.
    fn paragraph_end(&self, mut line: usize) -> usize {
        let last = self.lines.len() - 1;
        while line < last && self.lines[line].trim().is_empty() {
            line += 1;
        }
        while line < last && !self.lines[line + 1].trim().is_empty() {
            line += 1;
        }
        line
    }

    /// Move up one paragraph (readline's `backward-paragraph` shape): from
    /// inside a paragraph to its first line; already at the paragraph's
    /// first line, to the previous paragraph's first line. `Ctrl+Up`.
    pub(crate) fn move_paragraph_backward(&mut self) {
        self.last_action = None;
        let start = self.paragraph_start(self.cursor_line);
        let target = if self.cursor_line == start && start > 0 {
            self.paragraph_start(start - 1)
        } else {
            start
        };
        self.cursor_line = target;
        self.set_cursor_col(self.line_start_col(target));
    }

    /// Move down one paragraph (readline's `forward-paragraph`):
    /// `Ctrl+Down` lands at the END of the current paragraph's last line;
    /// already at that line, at the next paragraph's end.
    pub(crate) fn move_paragraph_forward(&mut self) {
        self.last_action = None;
        let end = self.paragraph_end(self.cursor_line);
        let last = self.lines.len() - 1;
        let target = if self.cursor_line == end && end < last {
            self.paragraph_end(end + 1)
        } else {
            end
        };
        self.cursor_line = target;
        let col = self.lines[target].chars().count();
        self.set_cursor_col(col);
    }

    pub(crate) fn move_word_backwards(&mut self) {
        self.last_action = None;
        let current_line = self.lines[self.cursor_line].clone();
        // The hidden bang prefix floors the word skip (TS
        // `moveWordBackwards` at or before the line start jumps to the
        // previous line's end).
        let line_start = self.line_start_col(self.cursor_line);
        if self.cursor_col <= line_start {
            if self.cursor_line > 0 {
                self.cursor_line -= 1;
                let prev_len = self.lines[self.cursor_line].chars().count();
                self.set_cursor_col(prev_len);
            }
            return;
        }
        let before_cursor = char_prefix(&current_line, self.cursor_col);
        let mut graphemes = self.segment(&before_cursor);
        let mut new_col = self.cursor_col;
        while let Some(last) = graphemes.last() {
            if is_atomic_marker(&last.segment) || !last.segment.chars().any(is_whitespace_char) {
                break;
            }
            new_col -= last.segment.chars().count();
            graphemes.pop();
        }
        if let Some(last) = graphemes.last() {
            let seg = &last.segment;
            if is_atomic_marker(seg) {
                new_col -= seg.chars().count();
                graphemes.pop();
            } else if seg.chars().any(is_punctuation_char) {
                while let Some(last) = graphemes.last() {
                    if !last.segment.chars().any(is_punctuation_char)
                        || is_atomic_marker(&last.segment)
                    {
                        break;
                    }
                    new_col -= last.segment.chars().count();
                    graphemes.pop();
                }
            } else {
                while let Some(last) = graphemes.last() {
                    let g = &last.segment;
                    if g.chars().any(is_whitespace_char)
                        || g.chars().any(is_punctuation_char)
                        || is_atomic_marker(g)
                    {
                        break;
                    }
                    new_col -= g.chars().count();
                    graphemes.pop();
                }
            }
        }
        self.set_cursor_col(new_col.max(line_start));
    }

    pub(crate) fn move_word_forwards(&mut self) {
        self.last_action = None;
        let current_line = self.lines[self.cursor_line].clone();
        let line_len = current_line.chars().count();
        if self.cursor_col >= line_len {
            if self.cursor_line < self.lines.len() - 1 {
                self.cursor_line += 1;
                self.set_cursor_col(0);
            }
            return;
        }
        let after_cursor = char_suffix(&current_line, self.cursor_col);
        let mut iter = self.segment(&after_cursor).into_iter().peekable();
        let mut new_col = self.cursor_col;
        while let Some(seg) = iter.peek() {
            if is_atomic_marker(&seg.segment) || !seg.segment.chars().any(is_whitespace_char) {
                break;
            }
            new_col += seg.segment.chars().count();
            iter.next();
        }
        if let Some(first) = iter.peek() {
            let g = &first.segment;
            if is_atomic_marker(g) {
                new_col += g.chars().count();
            } else if g.chars().any(is_punctuation_char) {
                while let Some(seg) = iter.peek() {
                    if !seg.segment.chars().any(is_punctuation_char)
                        || is_atomic_marker(&seg.segment)
                    {
                        break;
                    }
                    new_col += seg.segment.chars().count();
                    iter.next();
                }
            } else {
                while let Some(seg) = iter.peek() {
                    let g = &seg.segment;
                    if g.chars().any(is_whitespace_char)
                        || g.chars().any(is_punctuation_char)
                        || is_atomic_marker(g)
                    {
                        break;
                    }
                    new_col += g.chars().count();
                    iter.next();
                }
            }
        }
        self.set_cursor_col(new_col);
    }

    pub(crate) fn jump_to_char(&mut self, ch: &str, forward: bool) {
        self.last_action = None;
        let (end, step) = if forward {
            (self.lines.len() as isize, 1isize)
        } else {
            (-1isize, -1isize)
        };
        let mut line_idx = self.cursor_line as isize;
        while line_idx != end {
            let idx = line_idx as usize;
            let line = &self.lines[idx];
            let found = if idx == self.cursor_line {
                if forward {
                    char_find_after(line, self.cursor_col, ch)
                } else {
                    char_find_before(line, self.cursor_col, ch)
                }
            } else if forward {
                char_find_after(line, usize::MAX, ch)
            } else {
                char_find_before(line, usize::MAX, ch)
            };
            if let Some(pos) = found {
                self.cursor_line = idx;
                self.set_cursor_col(pos);
                return;
            }
            line_idx += step;
        }
    }

    pub fn build_visual_line_map(&self, width: usize) -> Vec<VisualLine> {
        let mut visual_lines = Vec::new();
        for (i, line) in self.lines.iter().enumerate() {
            // The hidden bang prefix on line 0 offsets the visual map
            // (TS `buildVisualLineMap` slices the display line first).
            let hidden = self.line_start_col(i);
            let display = char_suffix(line, hidden);
            let line_vis_width = str_width(&display);
            if display.is_empty() {
                visual_lines.push(VisualLine {
                    logical_line: i,
                    start_col: hidden,
                    length: 0,
                });
            } else if line_vis_width <= width {
                visual_lines.push(VisualLine {
                    logical_line: i,
                    start_col: hidden,
                    length: display.chars().count(),
                });
            } else {
                for chunk in word_wrap_line(&display, width, Some(self.segment(&display))) {
                    visual_lines.push(VisualLine {
                        logical_line: i,
                        start_col: hidden + chunk.start_index,
                        length: chunk.end_index - chunk.start_index,
                    });
                }
            }
        }
        visual_lines
    }

    fn find_visual_line_at(&self, visual_lines: &[VisualLine], line: usize, col: usize) -> usize {
        // A cursor column inside the hidden bang prefix (a backward
        // `jump_to_char` onto the `!` lands there) maps to the logical
        // line's first visual segment instead of falling through to the
        // whole map's last (TS `findVisualLineAt`'s hidden-prefix arm).
        let hidden = self.line_start_col(line);
        for (i, vl) in visual_lines.iter().enumerate() {
            if vl.logical_line != line {
                continue;
            }
            if hidden > 0 && col < hidden && vl.start_col == hidden {
                return i;
            }
            let offset = col as isize - vl.start_col as isize;
            let is_last_segment =
                i == visual_lines.len() - 1 || visual_lines[i + 1].logical_line != vl.logical_line;
            if offset >= 0
                && (offset < vl.length as isize
                    || (is_last_segment && offset == vl.length as isize))
            {
                return i;
            }
        }
        visual_lines.len().saturating_sub(1)
    }

    fn find_current_visual_line(&self, visual_lines: &[VisualLine]) -> usize {
        self.find_visual_line_at(visual_lines, self.cursor_line, self.cursor_col)
    }

    fn compute_vertical_move_column(
        &mut self,
        current_visual_col: usize,
        source_max: usize,
        target_max: usize,
    ) -> usize {
        let has_preferred = self.preferred_visual_col.is_some();
        let cursor_in_middle = current_visual_col < source_max;
        let target_too_short = target_max < current_visual_col;
        if !has_preferred || cursor_in_middle {
            if target_too_short {
                self.preferred_visual_col = Some(current_visual_col);
                return target_max;
            }
            self.preferred_visual_col = None;
            return current_visual_col;
        }
        let preferred = self.preferred_visual_col.unwrap_or(0);
        if target_too_short || target_max < preferred {
            return target_max;
        }
        self.preferred_visual_col = None;
        preferred
    }

    fn move_to_visual_line(
        &mut self,
        visual_lines: &[VisualLine],
        current_visual_line: usize,
        target_visual_line: usize,
    ) {
        let Some(current_vl) = visual_lines.get(current_visual_line) else {
            return;
        };
        let Some(target_vl) = visual_lines.get(target_visual_line) else {
            return;
        };
        let current_visual_col = if let Some(snapped) = self.snapped_from_cursor_col {
            let vl_idx = self.find_visual_line_at(visual_lines, current_vl.logical_line, snapped);
            snapped.saturating_sub(visual_lines[vl_idx].start_col)
        } else {
            self.cursor_col.saturating_sub(current_vl.start_col)
        };
        let is_last_source = current_visual_line == visual_lines.len() - 1
            || visual_lines[current_visual_line + 1].logical_line != current_vl.logical_line;
        let source_max = if is_last_source {
            current_vl.length
        } else {
            current_vl.length.saturating_sub(1)
        };
        let is_last_target = target_visual_line == visual_lines.len() - 1
            || visual_lines[target_visual_line + 1].logical_line != target_vl.logical_line;
        let target_max = if is_last_target {
            target_vl.length
        } else {
            target_vl.length.saturating_sub(1)
        };
        let move_to_visual_col =
            self.compute_vertical_move_column(current_visual_col, source_max, target_max);

        self.cursor_line = target_vl.logical_line;
        let target_col = target_vl.start_col + move_to_visual_col;
        let logical_len = self.lines[target_vl.logical_line].chars().count();
        self.cursor_col = target_col.min(logical_len);

        // Snap to atomic segment boundaries so the cursor never lands mid-marker.
        let logical_line = self.lines[self.cursor_line].clone();
        for seg in self.segment(&logical_line) {
            if seg.index > self.cursor_col {
                break;
            }
            if seg.segment.chars().count() <= 1 {
                continue;
            }
            let seg_len = seg.segment.chars().count();
            if self.cursor_col < seg.index + seg_len {
                let is_continuation = seg.index < target_vl.start_col;
                let is_moving_down = target_visual_line > current_visual_line;
                if is_continuation && is_moving_down {
                    let seg_end = seg.index + seg_len;
                    let mut next = target_visual_line + 1;
                    while next < visual_lines.len()
                        && visual_lines[next].logical_line == target_vl.logical_line
                        && visual_lines[next].start_col < seg_end
                    {
                        next += 1;
                    }
                    if next < visual_lines.len() {
                        self.move_to_visual_line(visual_lines, current_visual_line, next);
                        return;
                    }
                }
                self.snapped_from_cursor_col = Some(self.cursor_col);
                self.cursor_col = seg.index;
                return;
            }
        }
        self.snapped_from_cursor_col = None;
    }

    pub(crate) fn move_cursor(&mut self, delta_line: isize, delta_col: isize) {
        self.last_action = None;
        let visual_lines = self.build_visual_line_map(self.last_width);
        let current_visual_line = self.find_current_visual_line(&visual_lines);
        if delta_line != 0 {
            let target = current_visual_line as isize + delta_line;
            if target >= 0 && (target as usize) < visual_lines.len() {
                self.move_to_visual_line(&visual_lines, current_visual_line, target as usize);
            }
        }
        if delta_col != 0 {
            let current_line = self.lines[self.cursor_line].clone();
            if delta_col > 0 {
                if self.cursor_col < current_line.chars().count() {
                    let after = char_suffix(&current_line, self.cursor_col);
                    let advance = self
                        .segment(&after)
                        .first()
                        .map_or(1, |g| g.segment.chars().count());
                    self.set_cursor_col(self.cursor_col + advance);
                } else if self.cursor_line < self.lines.len() - 1 {
                    self.cursor_line += 1;
                    self.set_cursor_col(0);
                } else if let Some(current_vl) = visual_lines.get(current_visual_line) {
                    self.preferred_visual_col =
                        Some(self.cursor_col.saturating_sub(current_vl.start_col));
                }
            } else if self.cursor_col > self.line_start_col(self.cursor_line) {
                let before = char_prefix(&current_line, self.cursor_col);
                let back = self
                    .segment(&before)
                    .last()
                    .map_or(1, |g| g.segment.chars().count());
                // The hidden bang prefix floors the move (TS
                // `moveCursorHorizontally` clamps at the line start).
                self.set_cursor_col(
                    (self.cursor_col.saturating_sub(back))
                        .max(self.line_start_col(self.cursor_line)),
                );
            } else if self.cursor_line > 0 {
                self.cursor_line -= 1;
                let prev_len = self.lines[self.cursor_line].chars().count();
                self.set_cursor_col(prev_len);
            }
        }
    }

    pub(crate) fn page_scroll(&mut self, direction: isize) {
        self.last_action = None;
        let page_size = (self.terminal_rows as f32 * 0.3).floor().max(5.0) as usize;
        let visual_lines = self.build_visual_line_map(self.last_width);
        if visual_lines.is_empty() {
            return;
        }
        let current = self.find_current_visual_line(&visual_lines);
        let target = (current as isize + direction * page_size as isize)
            .clamp(0, visual_lines.len() as isize - 1) as usize;
        self.move_to_visual_line(&visual_lines, current, target);
    }

    pub(crate) fn is_on_first_visual_line(&self) -> bool {
        let vl = self.build_visual_line_map(self.last_width);
        self.find_current_visual_line(&vl) == 0
    }

    pub(crate) fn is_on_last_visual_line(&self) -> bool {
        let vl = self.build_visual_line_map(self.last_width);
        !vl.is_empty() && self.find_current_visual_line(&vl) == vl.len() - 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ed() -> Editor {
        Editor::new()
    }

    /// A backward jump onto the hidden bang prefix lands the cursor before
    /// the prefix (TS `jumpToChar` assigns the raw index); the visual-line
    /// lookup maps that column to the logical line's FIRST visual segment
    /// (TS `findVisualLineAt`'s hidden-prefix arm), never to the whole
    /// map's last visual line, and vertical motion consumes the mapped
    /// line.
    #[test]
    fn a_backward_jump_onto_the_bang_prefix_stays_on_the_first_visual_line() {
        let mut e = ed();
        e.set_text("!echo hi\nsecond line");
        e.move_to_line_end();
        e.handle_input("ctrl+alt+]");
        e.handle_input("!");
        assert_eq!(
            e.get_cursor(),
            (0, 0),
            "the backward jump landed on the hidden prefix"
        );
        assert!(
            e.is_on_first_visual_line(),
            "a pre-prefix cursor maps to the first visual line"
        );
        assert!(
            !e.is_on_last_visual_line(),
            "a pre-prefix cursor never maps to the map's last visual line"
        );
        e.handle_input("down");
        assert_eq!(
            e.get_cursor().0,
            1,
            "vertical motion from the pre-prefix column moves to the next line"
        );
    }

    #[test]
    fn visual_map_wrap() {
        let mut e = ed();
        e.set_text("aaaaaaaaaa bbbbbbbbbb");
        let vl = e.build_visual_line_map(10);
        // The trailing space of chunk 1 wraps to its own visual line (TS parity).
        assert_eq!(vl.len(), 3);
        assert_eq!(vl[0].length, 10);
        assert_eq!(vl[1].length, 1);
        assert_eq!(vl[0].logical_line, 0);
        assert_eq!(vl[1].logical_line, 0);
    }

    /// TS `placeCursorFromClick` (PR #2430): a click maps through the
    /// rendered chunk back to a source caret offset, snapping to atomic
    /// segment boundaries. `[from, to)` bound the clicked visual chunk in
    /// char offsets; `rel` is the clicked column past the chunk's start.
    #[test]
    fn click_places_the_caret_within_the_chunk() {
        let mut e = ed();
        e.set_text("hello world");
        // The whole line is one chunk: a click at column 5 lands between
        // the `o` and the space (before the space's tail).
        e.place_cursor_in_chunk(0, 0, 11, 5);
        assert_eq!(e.get_cursor(), (0, 5));
        // A click past the line's end keeps the chunk-end offset.
        e.place_cursor_in_chunk(0, 0, 11, 20);
        assert_eq!(e.get_cursor(), (0, 11));
        // The from-bound maps a wrapped chunk back to its source slice.
        e.place_cursor_in_chunk(0, 6, 11, 3);
        assert_eq!(e.get_cursor(), (0, 9));
    }

    /// An offset inside an atomic paste marker snaps to the marker's
    /// nearest boundary (TS `snapCursorOffset`).
    #[test]
    fn click_snaps_inside_paste_markers() {
        let mut e = ed();
        e.handle_input("A");
        // A large paste stores an atomic `[paste #0]` marker.
        e.handle_paste(&"line\n".repeat(20));
        e.handle_input("B");
        let text = e.get_text();
        let start = text.find("[paste #").expect("marker text");
        let end = text[start..].find(']').expect("marker end") + start + 1;
        let marker_len = text[start..end].chars().count();
        // A click at the marker's middle would compute an offset inside
        // the marker; the snap moves it to a boundary.
        e.place_cursor_in_chunk(0, 1, 1 + marker_len + 1, marker_len / 2);
        let (_, col) = e.get_cursor();
        assert!(
            col == 1 || col == 1 + marker_len,
            "the caret snapped to a marker boundary: {col}"
        );
    }
}
