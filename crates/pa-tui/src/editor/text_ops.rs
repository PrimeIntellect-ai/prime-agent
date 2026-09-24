//! Editor text operations: character/word/line deletion and kill-ring yank.

use super::text_utils::{char_prefix, char_suffix, split_at_char};
use super::*;

impl Editor {
    pub(crate) fn handle_backspace(&mut self) {
        self.history_index = -1;
        self.last_action = None;
        let line = self.lines[self.cursor_line].clone();
        // The hidden bang prefix protects the line's head (TS
        // `handleBackspace`): deleting at the prefix end clears the whole
        // line (the bang prefix included) instead of joining lines.
        let line_start = self.line_start_col(self.cursor_line);
        if self.cursor_col > line_start {
            self.push_undo_snapshot();
            let before_cursor = char_prefix(&line, self.cursor_col);
            let graphemes = self.segment(&before_cursor);
            let last_len = graphemes
                .last()
                .map(|g| g.segment.chars().count())
                .unwrap_or(1);
            let (before, after) = split_at_char(&line, self.cursor_col);
            let before = char_prefix(&before, before.chars().count() - last_len);
            self.lines[self.cursor_line] = format!("{before}{after}");
            self.set_cursor_col(self.cursor_col.saturating_sub(last_len));
        } else if line_start > 0 && line.chars().count() == line_start {
            self.push_undo_snapshot();
            self.lines[self.cursor_line] = String::new();
            self.set_cursor_col(0);
        } else if self.cursor_line > 0 {
            self.push_undo_snapshot();
            let current_line = self.lines[self.cursor_line].clone();
            let previous_line = self.lines[self.cursor_line - 1].clone();
            self.lines[self.cursor_line - 1] = format!("{previous_line}{current_line}");
            self.lines.remove(self.cursor_line);
            self.cursor_line -= 1;
            self.set_cursor_col(previous_line.chars().count());
        }
        self.emit(EditorEvent::Changed(self.get_text()));
        self.refresh_autocomplete_after_edit(true);
    }

    pub(crate) fn handle_forward_delete(&mut self) {
        self.history_index = -1;
        self.last_action = None;
        let current_line = self.lines[self.cursor_line].clone();
        if self.cursor_col < current_line.chars().count() {
            self.push_undo_snapshot();
            let after_cursor = char_suffix(&current_line, self.cursor_col);
            let first_len = self
                .segment(&after_cursor)
                .first()
                .map(|g| g.segment.chars().count())
                .unwrap_or(1);
            // Drop the first atomic segment after the cursor (TS
            // `handleForwardDelete`: before + after with the segment
            // removed — an atomic marker goes whole).
            let (before, after) = split_at_char(&current_line, self.cursor_col);
            let after = char_suffix(&after, first_len);
            self.lines[self.cursor_line] = format!("{before}{after}");
        } else if self.cursor_line < self.lines.len() - 1 {
            self.push_undo_snapshot();
            let next_line = self.lines[self.cursor_line + 1].clone();
            self.lines[self.cursor_line] = format!("{current_line}{next_line}");
            self.lines.remove(self.cursor_line + 1);
        }
        self.emit(EditorEvent::Changed(self.get_text()));
        self.refresh_autocomplete_after_edit(true);
    }

    pub(crate) fn delete_to_start_of_line(&mut self) {
        self.history_index = -1;
        let current_line = self.lines[self.cursor_line].clone();
        // The kill starts after the hidden bang prefix (TS
        // `deleteToStartOfLine` kills from the line start, prefix kept).
        let line_start = self.line_start_col(self.cursor_line);
        if self.cursor_col > line_start {
            self.push_undo_snapshot();
            let deleted = char_suffix(&char_prefix(&current_line, self.cursor_col), line_start);
            self.kill_ring.push(
                &deleted,
                true,
                self.last_action.as_ref() == Some(&LastAction::Kill),
            );
            self.last_action = Some(LastAction::Kill);
            let before = char_prefix(&current_line, line_start);
            let after = char_suffix(&current_line, self.cursor_col);
            self.lines[self.cursor_line] = format!("{before}{after}");
            self.set_cursor_col(line_start);
        } else if self.cursor_line > 0 {
            self.push_undo_snapshot();
            self.kill_ring.push(
                "\n",
                true,
                self.last_action.as_ref() == Some(&LastAction::Kill),
            );
            self.last_action = Some(LastAction::Kill);
            let previous_line = self.lines[self.cursor_line - 1].clone();
            self.lines[self.cursor_line - 1] = format!("{previous_line}{current_line}");
            self.lines.remove(self.cursor_line);
            self.cursor_line -= 1;
            self.set_cursor_col(previous_line.chars().count());
        }
        self.emit(EditorEvent::Changed(self.get_text()));
        self.refresh_autocomplete_after_edit(false);
    }

    pub(crate) fn delete_to_end_of_line(&mut self) {
        self.history_index = -1;
        let current_line = self.lines[self.cursor_line].clone();
        let line_len = current_line.chars().count();
        if self.cursor_col < line_len {
            self.push_undo_snapshot();
            let (before, deleted) = split_at_char(&current_line, self.cursor_col);
            self.kill_ring.push(
                &deleted,
                false,
                self.last_action.as_ref() == Some(&LastAction::Kill),
            );
            self.last_action = Some(LastAction::Kill);
            self.lines[self.cursor_line] = before;
        } else if self.cursor_line < self.lines.len() - 1 {
            self.push_undo_snapshot();
            self.kill_ring.push(
                "\n",
                false,
                self.last_action.as_ref() == Some(&LastAction::Kill),
            );
            self.last_action = Some(LastAction::Kill);
            let next_line = self.lines[self.cursor_line + 1].clone();
            self.lines[self.cursor_line] = format!("{current_line}{next_line}");
            self.lines.remove(self.cursor_line + 1);
        }
        self.emit(EditorEvent::Changed(self.get_text()));
        self.refresh_autocomplete_after_edit(false);
    }

    pub(crate) fn delete_word_backwards(&mut self) {
        self.history_index = -1;
        let current_line = self.lines[self.cursor_line].clone();
        if self.cursor_col == 0 {
            if self.cursor_line > 0 {
                self.push_undo_snapshot();
                self.kill_ring.push(
                    "\n",
                    true,
                    self.last_action.as_ref() == Some(&LastAction::Kill),
                );
                self.last_action = Some(LastAction::Kill);
                let previous_line = self.lines[self.cursor_line - 1].clone();
                self.lines[self.cursor_line - 1] = format!("{previous_line}{current_line}");
                self.lines.remove(self.cursor_line);
                self.cursor_line -= 1;
                self.set_cursor_col(previous_line.chars().count());
            }
        } else {
            self.push_undo_snapshot();
            let was_kill = self.last_action.as_ref() == Some(&LastAction::Kill);
            let old_cursor_col = self.cursor_col;
            self.move_word_backwards();
            let delete_from = self.cursor_col;
            self.set_cursor_col(old_cursor_col);
            let head = char_prefix(&current_line, old_cursor_col);
            let deleted = char_suffix(&head, delete_from);
            self.kill_ring.push(&deleted, true, was_kill);
            self.last_action = Some(LastAction::Kill);
            let before = char_prefix(&head, delete_from);
            let rest = char_suffix(&current_line, old_cursor_col);
            self.lines[self.cursor_line] = format!("{before}{rest}");
            self.set_cursor_col(delete_from);
        }
        self.emit(EditorEvent::Changed(self.get_text()));
        self.refresh_autocomplete_after_edit(false);
    }

    pub(crate) fn delete_word_forward(&mut self) {
        self.history_index = -1;
        let current_line = self.lines[self.cursor_line].clone();
        let line_len = current_line.chars().count();
        if self.cursor_col >= line_len {
            if self.cursor_line < self.lines.len() - 1 {
                self.push_undo_snapshot();
                self.kill_ring.push(
                    "\n",
                    false,
                    self.last_action.as_ref() == Some(&LastAction::Kill),
                );
                self.last_action = Some(LastAction::Kill);
                let next_line = self.lines[self.cursor_line + 1].clone();
                self.lines[self.cursor_line] = format!("{current_line}{next_line}");
                self.lines.remove(self.cursor_line + 1);
            }
        } else {
            self.push_undo_snapshot();
            let was_kill = self.last_action.as_ref() == Some(&LastAction::Kill);
            let old_cursor_col = self.cursor_col;
            self.move_word_forwards();
            let delete_to = self.cursor_col;
            self.set_cursor_col(old_cursor_col);
            let (before, deleted) = split_at_char(&current_line, self.cursor_col);
            let deleted = char_suffix(&deleted, delete_to - self.cursor_col);
            self.kill_ring.push(&deleted, false, was_kill);
            self.last_action = Some(LastAction::Kill);
            let (_, after) = split_at_char(&current_line, delete_to);
            self.lines[self.cursor_line] = format!("{before}{after}");
        }
        self.emit(EditorEvent::Changed(self.get_text()));
        self.refresh_autocomplete_after_edit(false);
    }

    pub(crate) fn yank(&mut self) {
        if self.kill_ring.is_empty() {
            return;
        }
        self.push_undo_snapshot();
        let text = self.kill_ring.peek().unwrap_or_default().to_string();
        self.insert_yanked_text(&text);
        self.last_action = Some(LastAction::Yank);
        self.refresh_autocomplete_after_edit(false);
    }

    pub(crate) fn yank_pop(&mut self) {
        if self.last_action.as_ref() != Some(&LastAction::Yank) || self.kill_ring.len() <= 1 {
            return;
        }
        self.push_undo_snapshot();
        self.delete_yanked_text();
        self.kill_ring.rotate();
        let text = self.kill_ring.peek().unwrap_or_default().to_string();
        self.insert_yanked_text(&text);
        self.last_action = Some(LastAction::Yank);
        self.refresh_autocomplete_after_edit(false);
    }

    fn insert_yanked_text(&mut self, text: &str) {
        self.history_index = -1;
        let parts: Vec<&str> = text.split('\n').collect();
        if parts.len() == 1 {
            let current_line = self.lines[self.cursor_line].clone();
            let (before, after) = split_at_char(&current_line, self.cursor_col);
            self.lines[self.cursor_line] = format!("{before}{text}{after}");
            self.set_cursor_col(self.cursor_col + text.chars().count());
        } else {
            let current_line = self.lines[self.cursor_line].clone();
            let (before, after) = split_at_char(&current_line, self.cursor_col);
            self.lines[self.cursor_line] = format!("{}{}", before, parts[0]);
            for (i, mid) in parts[1..parts.len() - 1].iter().enumerate() {
                self.lines.insert(self.cursor_line + 1 + i, mid.to_string());
            }
            let last_index = self.cursor_line + parts.len() - 1;
            self.lines
                .insert(last_index, format!("{}{}", parts[parts.len() - 1], after));
            self.cursor_line = last_index;
            let last_len = parts[parts.len() - 1].chars().count();
            self.set_cursor_col(last_len);
        }
        self.emit(EditorEvent::Changed(self.get_text()));
    }

    fn delete_yanked_text(&mut self) {
        let Some(yanked) = self.kill_ring.peek().map(str::to_string) else {
            return;
        };
        let parts: Vec<&str> = yanked.split('\n').collect();
        if parts.len() == 1 {
            let current_line = self.lines[self.cursor_line].clone();
            let delete_len = yanked.chars().count();
            let (before, after) = split_at_char(&current_line, self.cursor_col);
            let before = char_prefix(&before, before.chars().count() - delete_len);
            self.lines[self.cursor_line] = format!("{before}{after}");
            self.set_cursor_col(self.cursor_col.saturating_sub(delete_len));
        } else {
            let start_line = self.cursor_line - (parts.len() - 1);
            let start_col = self.lines[start_line].chars().count() - parts[0].chars().count();
            let after_cursor = char_suffix(&self.lines[self.cursor_line], self.cursor_col);
            let before_yank = char_prefix(&self.lines[start_line], start_col);
            let replacement = format!("{before_yank}{after_cursor}");
            self.lines.drain(start_line..=self.cursor_line);
            self.lines.insert(start_line, replacement);
            self.cursor_line = start_line;
            self.set_cursor_col(start_col);
        }
        self.emit(EditorEvent::Changed(self.get_text()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ed() -> Editor {
        Editor::new()
    }

    #[test]
    fn word_ops_and_kill_ring() {
        let mut e = ed();
        e.handle_input("h");
        e.handle_input("e");
        e.handle_input("l");
        e.handle_input("l");
        e.handle_input("o");
        e.handle_input(" ");
        e.handle_input("w");
        e.handle_input("o");
        e.handle_input("r");
        e.handle_input("l");
        e.handle_input("d");
        assert_eq!(e.get_text(), "hello world");
        e.handle_input("ctrl+w");
        assert_eq!(e.get_text(), "hello ");
        // ctrl+k at end of line is a no-op (TS parity: only kills forward text).
        e.handle_input("ctrl+k");
        assert_eq!(e.get_text(), "hello ");
        e.handle_input("ctrl+y");
        assert_eq!(e.get_text(), "hello world");
        // Ring holds one entry: yank-pop is a no-op.
        e.handle_input("alt+y");
        assert_eq!(e.get_text(), "hello world");
    }

    /// Forward delete drops the grapheme after the cursor (found red by
    /// the paste-marker suite: the pre-fix split kept the deleted span, so
    /// delete was a no-op everywhere).
    #[test]
    fn forward_delete_drops_the_next_grapheme() {
        let mut e = ed();
        for c in ["a", "b", "c"] {
            e.handle_input(c);
        }
        e.handle_input("home");
        e.handle_input("right");
        assert_eq!(e.get_cursor(), (0, 1));
        e.handle_input("delete");
        assert_eq!(e.get_text(), "ac");
        // At line end it merges with the next line (TS parity).
        e.set_text("ac\nxy");
        e.handle_input("up");
        assert_eq!(e.get_cursor(), (0, 2));
        e.handle_input("delete");
        assert_eq!(e.get_lines(), vec!["acxy"]);
    }
}
