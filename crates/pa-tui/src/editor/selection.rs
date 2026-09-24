//! Editor selection: the shift+arrow families, select-all, and the
//! selection-consuming edits (typing/backspace replace the selection like
//! every standard editor).
//!
//! SANCTIONED DIVERGENCE from TS (operator ask 2026-09-24, documented per
//! the #289 precedent): the TS editor has no selection model at all — its
//! `tui.input.copy` arm returns without acting. The selection here spans
//! the anchor (`selection_anchor`) to the cursor; rendering highlights it
//! (view.rs), edits delete it before inserting, and undo/redo carry it.

use super::text_utils::{char_at, char_prefix, char_suffix};
use super::*;

impl Editor {
    /// A selection is active: the anchor plus cursor produce a non-empty
    /// range after the hidden-prefix clamp. An anchor whose span the clamp
    /// floors away (a cursor parked inside the bang prefix) is a phantom
    /// the editor treats as no selection at all — every consumer gates on
    /// this, so no stale anchor can wedge Backspace or the insert path.
    pub fn has_selection(&self) -> bool {
        self.selection_anchor.is_some_and(|anchor| {
            anchor != (self.cursor_line, self.cursor_col) && self.selection_range().is_some()
        })
    }

    /// Drop the selection, keeping the cursor (the plain motions and a
    /// first Escape press land here).
    pub fn clear_selection(&mut self) {
        self.selection_anchor = None;
    }

    /// The selection as a normalized (start, end) pair of (line, col)
    /// positions, `None` when nothing is selected. Positions compare as
    /// tuples, so `start` is always the earlier one.
    pub fn selection_range(&self) -> Option<((usize, usize), (usize, usize))> {
        let anchor = self.selection_anchor?;
        let cursor = (self.cursor_line, self.cursor_col);
        if anchor == cursor {
            return None;
        }
        let (start, end) = if anchor < cursor {
            (anchor, cursor)
        } else {
            (cursor, anchor)
        };
        // The hidden bang prefix is never selectable: a cursor parked
        // inside it (a backward jump lands on the raw `!` at column 0)
        // floors the range's start at the protected column.
        let start = (start.0, start.1.max(self.line_start_col(start.0)));
        if start == end {
            return None;
        }
        Some((start, end))
    }

    /// The selected text, lines joined with `\n`.
    pub fn selection_text(&self) -> Option<String> {
        let ((start_line, start_col), (end_line, end_col)) = self.selection_range()?;
        if start_line == end_line {
            let line = &self.lines[start_line];
            return Some(char_suffix(&char_prefix(line, end_col), start_col));
        }
        let mut out = String::new();
        let first = char_suffix(&self.lines[start_line], start_col);
        out.push_str(&first);
        for line in &self.lines[start_line + 1..end_line] {
            out.push('\n');
            out.push_str(line);
        }
        out.push('\n');
        out.push_str(&char_prefix(&self.lines[end_line], end_col));
        Some(out)
    }

    /// Extend the selection by running `motion`: the first extension
    /// anchors at the cursor, later ones keep the anchor.
    fn extend_selection(&mut self, motion: fn(&mut Editor)) {
        if self.selection_anchor.is_none() {
            // The anchor floors at the hidden bang prefix (the cursor
            // itself never sits below it, but the anchor is what
            // remove_selection splices from).
            let col = self.cursor_col.max(self.line_start_col(self.cursor_line));
            self.selection_anchor = Some((self.cursor_line, col));
        }
        motion(self);
        if !self.has_selection() {
            // The motion collapsed back onto the anchor: the selection is
            // empty, so drop it (shift+left at the anchor round-trip).
            self.selection_anchor = None;
        }
    }

    pub(crate) fn select_left(&mut self) {
        self.extend_selection(|e| e.move_cursor(0, -1));
    }

    pub(crate) fn select_right(&mut self) {
        self.extend_selection(|e| e.move_cursor(0, 1));
    }

    pub(crate) fn select_up(&mut self) {
        self.extend_selection(|e| e.move_cursor(-1, 0));
    }

    pub(crate) fn select_down(&mut self) {
        self.extend_selection(|e| e.move_cursor(1, 0));
    }

    pub(crate) fn select_word_left(&mut self) {
        self.extend_selection(Editor::move_word_backwards);
    }

    pub(crate) fn select_word_right(&mut self) {
        self.extend_selection(Editor::move_word_forwards);
    }

    pub(crate) fn select_line_start(&mut self) {
        self.extend_selection(Editor::move_to_line_start);
    }

    pub(crate) fn select_line_end(&mut self) {
        self.extend_selection(Editor::move_to_line_end);
    }

    pub(crate) fn select_doc_start(&mut self) {
        self.extend_selection(Editor::move_to_doc_start);
    }

    pub(crate) fn select_doc_end(&mut self) {
        self.extend_selection(Editor::move_to_doc_end);
    }

    pub(crate) fn select_paragraph_up(&mut self) {
        self.extend_selection(Editor::move_paragraph_backward);
    }

    pub(crate) fn select_paragraph_down(&mut self) {
        self.extend_selection(Editor::move_paragraph_forward);
    }

    /// Select the whole text (macOS `Cmd+A` / editors' select-all): the
    /// anchor at the first character (past any hidden bang prefix), the
    /// cursor at the end.
    pub(crate) fn select_all(&mut self) {
        self.last_action = None;
        let anchor = (0, self.line_start_col(0));
        let last = self.lines.len() - 1;
        let col = self.lines[last].chars().count();
        self.selection_anchor = Some(anchor);
        self.cursor_line = last;
        self.set_cursor_col(col);
        // A prompt with nothing selectable (an empty prompt, or a bare
        // hidden `!` prefix) must not leave a zero-span anchor behind:
        // the next select motion would keep extending from it instead of
        // anchoring at the cursor.
        if !self.has_selection() {
            self.selection_anchor = None;
        }
    }

    /// Remove the selection from the buffer (the caller owns the undo
    /// push; the cursor lands at the selection's start).
    pub(super) fn remove_selection(&mut self) {
        let Some(((start_line, start_col), (end_line, end_col))) = self.selection_range() else {
            return;
        };
        if start_line == end_line {
            let line = &self.lines[start_line];
            let head = char_prefix(line, start_col);
            let tail = char_suffix(line, end_col);
            self.lines[start_line] = format!("{head}{tail}");
        } else {
            let head = char_prefix(&self.lines[start_line], start_col);
            let tail = char_suffix(&self.lines[end_line], end_col);
            let joined = format!("{head}{tail}");
            self.lines[start_line] = joined;
            self.lines.drain(start_line + 1..=end_line);
        }
        self.cursor_line = start_line;
        self.set_cursor_col(start_col);
        self.selection_anchor = None;
    }

    /// Delete the active selection, undoable as one edit. `Ok(())` when a
    /// selection existed, `Err(())` when nothing was selected.
    pub(crate) fn delete_selection(&mut self) -> Result<(), ()> {
        if !self.has_selection() {
            return Err(());
        }
        self.push_undo_snapshot();
        self.history_index = -1;
        self.last_action = None;
        self.remove_selection();
        self.emit(EditorEvent::Changed(self.get_text()));
        self.refresh_autocomplete_after_edit(true);
        Ok(())
    }

    /// Cut the active selection: the text onto the kill ring (a following
    /// `tui.editor.yank` pastes it back), the buffer without it, and the
    /// `ClipboardWrite` event for the host's copy chain.
    pub(crate) fn cut_selection(&mut self) -> Option<String> {
        let text = self.selection_text()?;
        self.delete_selection().ok()?;
        self.kill_ring.push(&text, false, false);
        self.last_action = Some(LastAction::Kill);
        Some(text)
    }

    /// Copy the active selection to the kill ring and the host clipboard
    /// (the buffer and cursor stay untouched).
    pub(crate) fn copy_selection(&mut self) -> Option<String> {
        let text = self.selection_text()?;
        self.kill_ring.push(&text, false, false);
        self.last_action = None;
        Some(text)
    }

    /// Swap the characters around the cursor (readline's `transpose-chars`,
    /// `Ctrl+T`): at the line end the last two swap, at the line start the
    /// first two do.
    pub(crate) fn transpose_chars(&mut self) {
        self.history_index = -1;
        self.last_action = None;
        let line = self.lines[self.cursor_line].clone();
        let len = line.chars().count();
        let line_start = self.line_start_col(self.cursor_line);
        if len - line_start < 2 {
            return;
        }
        let col = if self.cursor_col >= len {
            len - 1
        } else {
            self.cursor_col.max(line_start + 1)
        };
        // The snapshot is taken BEFORE the swap (undo/redo round-trips the
        // pre-swap state, selection included), and the selection collapses
        // only when the swap actually applies: a stale anchor would cover
        // different text than the highlight shows.
        self.push_undo_snapshot();
        self.selection_anchor = None;
        let head = char_prefix(&line, col - 1);
        let first = char_at(&line, col - 1).unwrap_or_default().to_string();
        let second = char_at(&line, col).unwrap_or_default().to_string();
        let tail = char_suffix(&line, col + 1);
        self.lines[self.cursor_line] = format!("{head}{second}{first}{tail}");
        self.set_cursor_col(col + 1);
        self.emit(EditorEvent::Changed(self.get_text()));
        self.refresh_autocomplete_after_edit(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ed() -> Editor {
        Editor::new()
    }

    /// `shift+left` twice selects two characters; typing replaces the
    /// selection as one undo step.
    #[test]
    fn shift_right_selects_and_typing_replaces() {
        let mut e = ed();
        for c in "abcdef".chars() {
            e.handle_input(&c.to_string());
        }
        e.handle_input("shift+left");
        e.handle_input("shift+left");
        assert!(e.has_selection());
        assert_eq!(e.selection_text().as_deref(), Some("ef"));
        e.handle_input("Z");
        assert_eq!(e.get_text(), "abcdZ");
        assert!(!e.has_selection());
        // One undo restores the whole original text.
        e.handle_input("ctrl+-");
        assert_eq!(e.get_text(), "abcdef");
    }

    /// Backspacing a selection deletes it (the selection, not one char).
    #[test]
    fn backspace_deletes_the_selection() {
        let mut e = ed();
        e.set_text("hello world");
        // Select the word `world` backwards from the end.
        e.move_to_doc_end();
        e.handle_input("shift+alt+left");
        assert_eq!(e.selection_text().as_deref(), Some("world"));
        e.handle_input("backspace");
        assert_eq!(e.get_text(), "hello ");
        e.handle_input("ctrl+-");
        assert_eq!(e.get_text(), "hello world");
    }

    /// A plain motion collapses the selection (shift+left, then plain left).
    #[test]
    fn plain_motion_collapses_the_selection() {
        let mut e = ed();
        e.set_text("abc");
        e.move_to_doc_end();
        e.handle_input("shift+left");
        assert!(e.has_selection());
        e.handle_input("left");
        assert!(!e.has_selection());
    }

    /// Shift+home extends to the line start; shift+end to the line end.
    #[test]
    fn shift_home_and_end_select_the_line() {
        let mut e = ed();
        e.set_text("one two");
        e.move_to_line_end();
        e.handle_input("shift+home");
        assert_eq!(e.selection_text().as_deref(), Some("one two"));
        e.handle_input("shift+end");
        assert!(!e.has_selection(), "end of the line: empty selection");
        // Extending beyond the anchor re-selects from the same anchor.
        e.handle_input("shift+home");
        assert_eq!(e.selection_text().as_deref(), Some("one two"));
    }

    /// Word selection extends across a word and punctuation.
    #[test]
    fn shift_word_selections() {
        let mut e = ed();
        e.set_text("fix, the bug");
        e.move_to_doc_end();
        e.handle_input("shift+ctrl+left");
        assert_eq!(e.selection_text().as_deref(), Some("bug"));
        e.handle_input("shift+alt+left");
        assert_eq!(e.selection_text().as_deref(), Some("the bug"));
        e.handle_input("shift+ctrl+left");
        assert_eq!(e.selection_text().as_deref(), Some(", the bug"));
    }

    /// Selection across lines: shift+up from the second line's end
    /// selects through the newline (the sticky column clamps to the
    /// shorter line above); deleting merges the lines at the selection.
    #[test]
    fn multiline_selection_delete_joins_lines() {
        let mut e = ed();
        e.set_text("first line\nsecond line");
        // Cursor at the end of the second line; select up one line.
        e.move_to_doc_end();
        e.handle_input("shift+up");
        assert_eq!(
            e.selection_text().as_deref(),
            Some("\nsecond line"),
            "the selection spans through the newline (the sticky column clamps to line 0's end)"
        );
        e.handle_input("delete");
        assert_eq!(e.get_text(), "first line");
        e.handle_input("ctrl+-");
        assert_eq!(e.get_text(), "first line\nsecond line");
    }

    /// Select-all anchors at the first character (the hidden bang prefix
    /// stays unselected) and the cursor lands at the very end.
    #[test]
    fn select_all_spans_the_whole_text() {
        let mut e = ed();
        e.set_text("alpha\nbeta");
        e.handle_input("ctrl+shift+a");
        assert_eq!(e.selection_text().as_deref(), Some("alpha\nbeta"));
        e.handle_input("x");
        assert_eq!(e.get_text(), "x");
    }

    /// Cut moves the selection onto the kill ring (yank pastes it back)
    /// and asks the host clipboard for the same text.
    #[test]
    fn cut_selection_feeds_the_kill_ring_and_clipboard() {
        let mut e = ed();
        e.set_text("keep drop this");
        e.move_to_doc_end();
        e.handle_input("shift+alt+left");
        assert_eq!(e.selection_text().as_deref(), Some("this"));
        e.handle_input("ctrl+x");
        assert_eq!(e.get_text(), "keep drop ");
        let events = e.take_events();
        let copied = events
            .iter()
            .filter_map(|event| match event {
                EditorEvent::ClipboardWrite(text) => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(copied, vec!["this"]);
        // Yank restores it at the cursor.
        e.handle_input("ctrl+y");
        assert_eq!(e.get_text(), "keep drop this");
    }

    /// Copy leaves the buffer untouched and only writes the clipboard.
    #[test]
    fn copy_selection_keeps_the_text() {
        let mut e = ed();
        e.set_text("unchanged");
        e.move_to_doc_end();
        e.handle_input("shift+alt+left");
        let _ = e.take_events();
        e.handle_input("ctrl+shift+c");
        assert_eq!(e.get_text(), "unchanged");
        assert!(e.has_selection(), "the selection stays active");
        let events = e.take_events();
        assert!(matches!(
            events.as_slice(),
            [EditorEvent::ClipboardWrite(text)] if text == "unchanged"
        ));
    }

    /// Cut without a selection is a consumed no-op (the buffer and the
    /// clipboard stay untouched).
    #[test]
    fn cut_without_selection_is_a_noop() {
        let mut e = ed();
        e.set_text("abc");
        let _ = e.take_events();
        e.handle_input("ctrl+x");
        assert_eq!(e.get_text(), "abc");
        assert!(e.take_events().is_empty());
    }

    /// Undo restores a selection edit and its undo restores the redo
    /// entry: undo -> redo round-trips the replaced text.
    #[test]
    fn undo_redo_round_trips_a_selection_replace() {
        let mut e = ed();
        e.set_text("alpha beta");
        e.move_to_line_end();
        e.handle_input("shift+alt+left");
        e.handle_input("b");
        assert_eq!(e.get_text(), "alpha b");
        e.handle_input("ctrl+-");
        assert_eq!(e.get_text(), "alpha beta");
        e.handle_input("ctrl+shift+z");
        assert_eq!(e.get_text(), "alpha b");
    }

    /// Yank inserts at the cursor: an active selection collapses first, or
    /// the stale anchor would splice a wrong range on the next keystroke.
    #[test]
    fn yank_collapses_a_stale_selection() {
        let mut e = ed();
        e.set_text("keep drop");
        e.move_to_doc_end();
        e.handle_input("ctrl+w");
        assert_eq!(e.get_text(), "keep ");
        e.handle_input("shift+alt+left");
        assert!(e.has_selection());
        e.handle_input("ctrl+y");
        assert!(!e.has_selection(), "yank collapses the stale selection");
        // The selection moved the cursor to the line start, so the yanked
        // word inserts there (a stale anchor would splice `keep ` away).
        assert_eq!(e.get_text(), "dropkeep ");
        // Typing after a yank never replaces a stale range (the cursor
        // sits after the yanked word).
        e.handle_input("!");
        assert_eq!(e.get_text(), "drop!keep ");
    }

    /// An empty paste payload (control-only bytes) is a full no-op: the
    /// selection, the text, and the undo stack stay untouched.
    #[test]
    fn an_empty_paste_with_a_selection_is_a_noop() {
        let mut e = ed();
        e.set_text("abc def");
        e.move_to_doc_end();
        e.handle_input("shift+alt+left");
        assert!(e.has_selection());
        let _ = e.take_events();
        let disposition = e.handle_paste("\u{7}\u{1}\u{2}");
        assert_eq!(disposition, PasteDisposition::Inline);
        assert_eq!(e.get_text(), "abc def", "nothing was inserted");
        assert!(e.has_selection(), "the selection survives");
        assert!(e.take_events().is_empty(), "no change event fired");
    }

    /// Transpose collapses a selection before swapping (the swap moves the
    /// cursor, which would strand the old anchor on different text).
    #[test]
    fn transpose_collapses_the_selection() {
        let mut e = ed();
        e.set_text("abdc");
        e.set_cursor_for_tests(0, 3);
        e.handle_input("shift+left");
        e.handle_input("shift+left");
        assert!(e.has_selection());
        e.handle_input("ctrl+t");
        assert!(!e.has_selection(), "transpose collapses the selection");
        // The selection left the cursor at col 1: transpose swaps the a/b
        // pair around it.
        assert_eq!(e.get_text(), "badc");
    }

    /// The selection anchor floors at the hidden bang prefix: extending
    /// from the prompt's start can never select or delete the prefix.
    #[test]
    fn selection_anchor_never_covers_the_hidden_prefix() {
        let mut e = ed();
        e.set_text("!cmd");
        // Cursor at the protected start of the bang line.
        e.set_cursor_for_tests(0, e.line_start_col(0));
        e.handle_input("shift+right");
        e.handle_input("shift+right");
        assert!(e.has_selection());
        let Some(((line, col), _)) = e.selection_range() else {
            panic!("selection expected");
        };
        assert_eq!((line, col), (0, 1), "the anchor sits past the prefix");
        // Replacing the selection keeps the prefix (the selection's tail
        // stays: `cm` replaced by `X` leaves the trailing `d`).
        e.handle_input("X");
        assert_eq!(e.get_text(), "!Xd", "the bang prefix survived the replace");
        assert_eq!(e.bash_prompt_prefix(), Some("! "));
    }

    /// Transpose over a selection: undo/redo round-trips the WHOLE
    /// pre-swap state, the selection included (the snapshot is taken
    /// before the swap collapses it).
    #[test]
    fn undo_round_trips_a_transposed_selection_state() {
        let mut e = ed();
        e.set_text("abdc");
        e.set_cursor_for_tests(0, 3);
        e.handle_input("shift+left");
        e.handle_input("shift+left");
        assert!(e.has_selection());
        e.handle_input("ctrl+t");
        assert!(!e.has_selection());
        assert_eq!(e.get_text(), "badc");
        // Undo restores the pre-swap text AND the selection span.
        e.handle_input("ctrl+-");
        assert_eq!(e.get_text(), "abdc");
        assert!(e.has_selection(), "undo restores the selection span");
        // Redo returns to the transposed, selection-collapsed state.
        e.handle_input("ctrl+shift+z");
        assert_eq!(e.get_text(), "badc");
        assert!(!e.has_selection(), "redo collapses it again");
    }

    /// A cursor parked inside the hidden bang prefix leaves a phantom
    /// anchor: the clamp floors its range away, and the editor treats it
    /// as NO selection at all — Backspace falls through to the normal
    /// single-character delete and typing inserts, instead of a wedged
    /// selection no-op that swallows keypresses.
    #[test]
    fn a_phantom_selection_inside_the_prefix_is_treated_as_none() {
        let mut e = ed();
        e.set_text("!cmd");
        // The exact phantom shape: the anchor sits inside the hidden
        // prefix (column 0) and the cursor on the protected start
        // (column 1) — the clamp floors the range to empty, so this is
        // NOT a live selection even though the anchor differs.
        e.selection_anchor = Some((0, 0));
        e.set_cursor_for_tests(0, 1);
        assert!(
            !e.has_selection(),
            "the clamped-away span is not a selection"
        );
        // Backspace falls through to the normal path (a no-op at the
        // protected prefix — NOT a wedged selection delete that pushes
        // an undo snapshot and swallows the keypress).
        e.handle_input("backspace");
        assert_eq!(e.get_text(), "!cmd");
        // Typing inserts instead of replacing a phantom range.
        e.handle_input("X");
        assert_eq!(e.get_text(), "!Xcmd");
    }

    /// A jump landing inside the hidden bang prefix can never seed a
    /// selection that covers it (the range start floors at the protected
    /// column).
    #[test]
    fn a_cursor_parked_on_the_bang_prefix_cannot_select_it() {
        let mut e = ed();
        e.set_text("!cmd");
        // A backward jump finds the raw `!` at column 0 and parks the
        // cursor there — inside the hidden prefix.
        e.set_cursor_for_tests(0, 4);
        e.handle_input("ctrl+alt+]");
        e.handle_input("!");
        assert_eq!(e.get_cursor(), (0, 0));
        // Extending right from inside the prefix: the anchor floors at
        // the protected column, so the first press yields no selection
        // and the second selects PAST the prefix.
        e.handle_input("shift+right");
        assert!(!e.has_selection(), "no zero-span anchor is parked");
        e.handle_input("shift+right");
        let Some(((line, col), _)) = e.selection_range() else {
            panic!("selection expected");
        };
        assert_eq!((line, col), (0, 1), "the selection starts past the prefix");
        e.handle_input("backspace");
        assert_eq!(e.get_text(), "!md", "the prefix itself is never deleted");
    }

    /// A prompt with nothing selectable leaves no zero-span anchor behind
    /// (Ctrl+Shift+A on an empty prompt, then typing, must not create a
    /// selection the NEXT keystroke would replace).
    #[test]
    fn select_all_on_an_empty_prompt_leaves_no_stale_anchor() {
        let mut e = ed();
        e.set_text("");
        e.handle_input("ctrl+shift+a");
        assert_eq!(e.selection_anchor, None);
        e.handle_input("a");
        assert!(!e.has_selection());
        e.handle_input("b");
        assert_eq!(e.get_text(), "ab", "the second keystroke inserts");
    }

    /// Pasting a file path over a forward selection inspects the
    /// INSERTION point (the selection start), not the live cursor the
    /// selection leaves behind.
    #[test]
    fn a_path_paste_over_a_forward_selection_gets_its_space_from_the_start() {
        let mut e = ed();
        e.set_text("abc def");
        // Forward selection: cursor at 0 (before the selection), anchor at 3.
        e.set_cursor_for_tests(0, 0);
        e.handle_input("shift+right");
        e.handle_input("shift+right");
        e.handle_input("shift+right");
        assert!(e.has_selection());
        let _ = e.take_events();
        e.handle_paste("/tmp/x");
        // The insertion point is the selection start (col 0), whose
        // preceding character is nothing — no leading space.
        assert_eq!(e.get_text(), "/tmp/x def");
    }

    /// Paragraph motion into line 0 lands on the protected column (the
    /// same position Home lands on), never inside or before the prefix.
    #[test]
    fn paragraph_motion_into_the_bang_line_lands_on_the_protected_start() {
        let mut e = ed();
        e.set_text("!cmd\ncontinuation");
        e.set_cursor_for_tests(1, 13);
        e.handle_input("ctrl+up");
        assert_eq!(
            e.get_cursor(),
            (0, e.line_start_col(0)),
            "the cursor lands exactly on the protected start (the Home position)"
        );
        // The hidden prefix itself is never inside a selection made by
        // the paragraph family.
        e.set_cursor_for_tests(1, 13);
        e.handle_input("shift+ctrl+up");
        let Some(((line, col), _)) = e.selection_range() else {
            panic!("selection expected");
        };
        assert_eq!(
            (line, col),
            (0, 1),
            "the selection starts past the hidden prefix"
        );
    }

    /// Doc/paragraph selection families reach the buffer edges.
    #[test]
    fn doc_selection_families() {
        let mut e = ed();
        e.set_text("one\n\ntwo");
        // From the end of line 0, select to the doc start.
        e.move_to_doc_start();
        e.move_to_line_end();
        e.handle_input("shift+ctrl+home");
        assert_eq!(e.selection_text().as_deref(), Some("one"));
        // The anchor persists: extending to the doc end selects from the
        // same anchor (line 0's end, so nothing of line 0) through the
        // buffer end.
        e.handle_input("shift+ctrl+end");
        assert_eq!(e.selection_text().as_deref(), Some("\n\ntwo"));
        // Anchor at the very start: extend to the doc end selects all.
        e.clear_selection();
        e.move_to_doc_start();
        e.handle_input("shift+ctrl+end");
        assert_eq!(e.selection_text().as_deref(), Some("one\n\ntwo"));
    }
}
