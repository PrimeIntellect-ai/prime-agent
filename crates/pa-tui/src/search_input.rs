//! The single-line search input behind the inline menu panel (TS
//! `packages/tui/src/components/input.ts`): value, cursor, undo stack, and an
//! Emacs-style kill ring, dispatched through the shared keybinding manager.

use crate::keybindings::KeybindingsManager;

/// The single-line search input (TS `Input`): value, cursor, undo stack,
/// and an Emacs-style kill ring. Dispatch happens through the shared
/// keybinding manager; the model selector owns when keys reach it.
#[derive(Debug)]
pub(crate) struct SearchInput {
    value: String,
    /// Cursor position in characters.
    cursor: usize,
    undo_stack: Vec<(String, usize)>,
    kill_ring: Vec<String>,
    last_action: LastAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum LastAction {
    #[default]
    None,
    Kill,
    Yank,
    TypeWord,
}

impl SearchInput {
    pub(crate) fn new() -> Self {
        SearchInput {
            value: String::new(),
            cursor: 0,
            undo_stack: Vec::new(),
            kill_ring: Vec::new(),
            last_action: LastAction::None,
        }
    }

    pub(crate) fn value(&self) -> &str {
        &self.value
    }

    pub(crate) fn cursor(&self) -> usize {
        self.cursor
    }

    /// TS `setValue`: the cursor never moves past the new value.
    pub(crate) fn set_value(&mut self, value: &str) {
        self.value = value.to_string();
        self.cursor = self.cursor.min(self.value.chars().count());
    }

    fn chars(&self) -> Vec<char> {
        self.value.chars().collect()
    }

    fn push_undo(&mut self) {
        self.undo_stack.push((self.value.clone(), self.cursor));
    }

    fn was_kill(&self) -> bool {
        self.last_action == LastAction::Kill
    }

    fn kill_push(&mut self, text: String, prepend: bool, accumulate: bool) {
        if text.is_empty() {
            return;
        }
        if accumulate && !self.kill_ring.is_empty() {
            let last = self.kill_ring.pop().expect("checked non-empty");
            self.kill_ring
                .push(if prepend { text + &last } else { last + &text });
        } else {
            self.kill_ring.push(text);
        }
    }

    /// One key id (TS `Input.handleInput`, printable + edit bindings).
    pub(crate) fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) {
        if kb.matches(key, "tui.editor.undo") {
            if let Some((value, cursor)) = self.undo_stack.pop() {
                self.value = value;
                self.cursor = cursor;
                self.last_action = LastAction::None;
            }
            return;
        }
        if kb.matches(key, "tui.editor.deleteCharBackward") {
            self.last_action = LastAction::None;
            if self.cursor > 0 {
                self.push_undo();
                let chars = self.chars();
                let delete_from = self.cursor - 1;
                self.value = chars[..delete_from]
                    .iter()
                    .chain(chars[self.cursor..].iter())
                    .collect();
                self.cursor = delete_from;
            }
            return;
        }
        if kb.matches(key, "tui.editor.deleteCharForward") {
            self.last_action = LastAction::None;
            if self.cursor < self.chars().len() {
                self.push_undo();
                let chars = self.chars();
                self.value = chars[..self.cursor]
                    .iter()
                    .chain(chars[self.cursor + 1..].iter())
                    .collect();
            }
            return;
        }
        if kb.matches(key, "tui.editor.deleteWordBackward") {
            self.delete_word_backward();
            return;
        }
        if kb.matches(key, "tui.editor.deleteWordForward") {
            self.delete_word_forward();
            return;
        }
        if kb.matches(key, "tui.editor.deleteToLineStart") {
            if self.cursor == 0 {
                return;
            }
            self.push_undo();
            let deleted: String = self.chars()[..self.cursor].iter().collect();
            self.kill_push(deleted, true, self.was_kill());
            self.last_action = LastAction::Kill;
            self.value = self.chars()[self.cursor..].iter().collect();
            self.cursor = 0;
            return;
        }
        if kb.matches(key, "tui.editor.deleteToLineEnd") {
            if self.cursor >= self.chars().len() {
                return;
            }
            self.push_undo();
            let deleted: String = self.chars()[self.cursor..].iter().collect();
            self.kill_push(deleted, false, self.was_kill());
            self.last_action = LastAction::Kill;
            self.value = self.chars()[..self.cursor].iter().collect();
            return;
        }
        if kb.matches(key, "tui.editor.yank") {
            let Some(text) = self.kill_ring.last().cloned() else {
                return;
            };
            self.push_undo();
            self.insert_at_cursor(&text);
            self.last_action = LastAction::Yank;
            return;
        }
        if kb.matches(key, "tui.editor.yankPop") {
            if self.last_action != LastAction::Yank || self.kill_ring.len() <= 1 {
                return;
            }
            self.push_undo();
            let prev = self.kill_ring.last().cloned().unwrap_or_default();
            self.delete_before_cursor(prev.chars().count());
            // Rotate the ring, then paste the next-oldest entry.
            if let Some(last) = self.kill_ring.pop() {
                self.kill_ring.insert(0, last);
            }
            let text = self.kill_ring.last().cloned().unwrap_or_default();
            self.insert_at_cursor(&text);
            self.last_action = LastAction::Yank;
            return;
        }
        if kb.matches(key, "tui.editor.cursorLeft") {
            self.last_action = LastAction::None;
            self.cursor = self.cursor.saturating_sub(1);
            return;
        }
        if kb.matches(key, "tui.editor.cursorRight") {
            self.last_action = LastAction::None;
            let len = self.chars().len();
            if self.cursor < len {
                self.cursor += 1;
            }
            return;
        }
        if kb.matches(key, "tui.editor.cursorLineStart") {
            self.last_action = LastAction::None;
            self.cursor = 0;
            return;
        }
        if kb.matches(key, "tui.editor.cursorLineEnd") {
            self.last_action = LastAction::None;
            self.cursor = self.chars().len();
            return;
        }
        if kb.matches(key, "tui.editor.cursorWordLeft") {
            self.last_action = LastAction::None;
            self.move_word_backward();
            return;
        }
        if kb.matches(key, "tui.editor.cursorWordRight") {
            self.last_action = LastAction::None;
            self.move_word_forward();
            return;
        }
        // Regular character input: printable characters only, one char at a
        // time (control sequences never reach the value).
        if let [character] = key.chars().collect::<Vec<char>>()[..] {
            if !character.is_control() {
                self.push_type_undo(character);
                self.insert_at_cursor(&character.to_string());
            }
        }
    }

    /// A whole-word paste (bracketed paste, newlines stripped like TS).
    pub(crate) fn paste(&mut self, text: &str) {
        self.last_action = LastAction::None;
        self.push_undo();
        let mut clean = text.replace(['\r', '\n'], "");
        clean = clean.replace('\t', "    ");
        self.insert_at_cursor(&clean);
    }

    fn push_type_undo(&mut self, character: char) {
        if crate::width::is_whitespace_char(character) || self.last_action != LastAction::TypeWord {
            self.push_undo();
        }
        self.last_action = LastAction::TypeWord;
    }

    fn insert_at_cursor(&mut self, text: &str) {
        let chars = self.chars();
        let mut value: String = chars[..self.cursor].iter().collect();
        value.push_str(text);
        value.extend(chars[self.cursor..].iter());
        self.value = value;
        self.cursor += text.chars().count();
    }

    fn delete_before_cursor(&mut self, count: usize) {
        let chars = self.chars();
        let delete_from = self.cursor.saturating_sub(count);
        self.value = chars[..delete_from]
            .iter()
            .chain(chars[self.cursor..].iter())
            .collect();
        self.cursor = delete_from;
    }

    fn delete_word_backward(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let was_kill = self.was_kill();
        self.push_undo();
        let old_cursor = self.cursor;
        self.move_word_backward();
        let delete_from = self.cursor;
        self.cursor = old_cursor;
        let deleted: String = self.chars()[delete_from..self.cursor].iter().collect();
        self.kill_push(deleted, true, was_kill);
        self.last_action = LastAction::Kill;
        self.delete_before_cursor(self.cursor - delete_from);
    }

    fn delete_word_forward(&mut self) {
        if self.cursor >= self.chars().len() {
            return;
        }
        let was_kill = self.was_kill();
        self.push_undo();
        let old_cursor = self.cursor;
        self.move_word_forward();
        let delete_to = self.cursor;
        self.cursor = old_cursor;
        let deleted: String = self.chars()[self.cursor..delete_to].iter().collect();
        self.kill_push(deleted, false, was_kill);
        self.last_action = LastAction::Kill;
        let chars = self.chars();
        self.value = chars[..self.cursor]
            .iter()
            .chain(chars[delete_to..].iter())
            .collect();
    }

    /// Word-boundary walk (TS `moveWordBackwards`): trailing whitespace,
    /// then punctuation or word characters.
    fn move_word_backward(&mut self) {
        let mut chars = self.chars();
        while self.cursor > 0 && is_ws(chars[self.cursor - 1]) {
            self.cursor -= 1;
            chars.truncate(self.cursor);
        }
        if chars.is_empty() {
            return;
        }
        let punctuation_run = is_punct(chars[self.cursor - 1]);
        while self.cursor > 0 {
            let last = chars[self.cursor - 1];
            if punctuation_run {
                if !is_punct(last) {
                    break;
                }
            } else if is_ws(last) || is_punct(last) {
                break;
            }
            self.cursor -= 1;
            chars.truncate(self.cursor);
        }
    }

    /// Word-boundary walk forward (TS `moveWordForwards`).
    fn move_word_forward(&mut self) {
        let chars = self.chars();
        while self.cursor < chars.len() && is_ws(chars[self.cursor]) {
            self.cursor += 1;
        }
        if self.cursor >= chars.len() {
            return;
        }
        let punctuation_run = is_punct(chars[self.cursor]);
        while self.cursor < chars.len() {
            let next = chars[self.cursor];
            if punctuation_run {
                if !is_punct(next) {
                    break;
                }
            } else if is_ws(next) || is_punct(next) {
                break;
            }
            self.cursor += 1;
        }
    }
}

fn is_ws(c: char) -> bool {
    crate::width::is_whitespace_char(c)
}

fn is_punct(c: char) -> bool {
    crate::width::is_punctuation_char(c)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keybindings::KeybindingsManager;

    fn kb() -> KeybindingsManager {
        KeybindingsManager::new()
    }

    fn typed(text: &str) -> SearchInput {
        let mut input = SearchInput::new();
        for character in text.chars() {
            input.handle_key(&character.to_string(), &kb());
        }
        input
    }

    #[test]
    fn typing_moves_the_cursor_and_backspace_deletes() {
        let mut input = typed("abc");
        assert_eq!(input.value(), "abc");
        assert_eq!(input.cursor(), 3);
        input.handle_key("backspace", &kb());
        assert_eq!(input.value(), "ab");
        assert_eq!(input.cursor(), 2);
        // Forward delete at the end is a no-op.
        input.handle_key("delete", &kb());
        assert_eq!(input.value(), "ab");
        input.handle_key("left", &kb());
        input.handle_key("delete", &kb());
        assert_eq!(input.value(), "a");
        assert_eq!(input.cursor(), 1);
    }

    #[test]
    fn undo_restores_the_previous_snapshot() {
        // Word-typed continuations share one snapshot: undo rewinds the
        // whole word, then the whole line (TS `pushUndo` boundaries).
        let mut input = typed("model picker");
        input.handle_key("ctrl+-", &kb());
        assert_eq!(input.value(), "model");
        input.handle_key("ctrl+-", &kb());
        assert_eq!(input.value(), "");
    }

    #[test]
    fn word_deletes_push_to_the_kill_ring_and_yank_pastes() {
        let mut input = typed("model picker");
        input.handle_key("ctrl+w", &kb());
        assert_eq!(input.value(), "model ");
        // Yank pastes the killed word back at the caret.
        input.handle_key("ctrl+y", &kb());
        assert_eq!(input.value(), "model picker");
    }

    #[test]
    fn consecutive_kills_accumulate_into_one_ring_entry() {
        let mut input = typed("alpha beta gamma");
        // Two consecutive backward word kills accumulate: the second kill
        // prepends into the first entry (TS kill-ring `accumulate`).
        input.handle_key("ctrl+w", &kb());
        input.handle_key("ctrl+w", &kb());
        assert_eq!(input.value(), "alpha ");
        // A line kill still rides the same kill chain: the whole line
        // becomes one entry, so yank pastes it back in one piece.
        input.handle_key("ctrl+u", &kb());
        assert_eq!(input.value(), "");
        input.handle_key("ctrl+y", &kb());
        assert_eq!(input.value(), "alpha beta gamma");
        // One ring entry: yank-pop is a no-op.
        input.handle_key("alt+y", &kb());
        assert_eq!(input.value(), "alpha beta gamma");
    }

    #[test]
    fn yank_pop_rotates_through_separate_kills() {
        // A caret move ends the kill chain, so the line kill below starts a
        // fresh entry the yank-pop can rotate to.
        let mut input = typed("alpha beta");
        input.handle_key("ctrl+w", &kb());
        assert_eq!(input.value(), "alpha ");
        input.handle_key("ctrl+a", &kb());
        input.handle_key("ctrl+k", &kb());
        assert_eq!(input.value(), "");
        // Yank pastes the newest entry (the line kill)...
        input.handle_key("ctrl+y", &kb());
        assert_eq!(input.value(), "alpha ");
        // ...yank-pop replaces it with the next-oldest (the word kill).
        input.handle_key("alt+y", &kb());
        assert_eq!(input.value(), "beta");
    }

    #[test]
    fn delete_to_line_start_and_end() {
        let mut input = typed("one two three");
        input.handle_key("home", &kb());
        input.handle_key("ctrl+k", &kb());
        assert_eq!(input.value(), "");
        // Restore by yank to rebuild, then delete from the start.
        let mut input = typed("one two three");
        input.handle_key("ctrl+u", &kb());
        assert_eq!(input.value(), "");
        input.handle_key("ctrl+y", &kb());
        assert_eq!(input.value(), "one two three");
    }

    #[test]
    fn cursor_word_walks_stop_at_boundaries() {
        // Punctuation is its own word class (TS `isPunctuationChar`):
        // `mock-1` walks to the hyphen, not past it.
        let mut input = typed("mock-1 picker");
        input.handle_key("ctrl+a", &kb());
        input.handle_key("alt+f", &kb());
        assert_eq!(input.cursor(), 4);
        input.handle_key("alt+b", &kb());
        assert_eq!(input.cursor(), 0);
        input.handle_key("ctrl+e", &kb());
        assert_eq!(input.cursor(), 13);
    }

    #[test]
    fn set_value_keeps_the_cursor_inside_the_value() {
        let mut input = SearchInput::new();
        input.set_value("mock");
        assert_eq!(input.value(), "mock");
        assert_eq!(input.cursor(), 0);
    }

    #[test]
    fn paste_strips_newlines_and_expands_tabs() {
        let mut input = typed("mo");
        input.paste("ck\t1\n2");
        assert_eq!(input.value(), "mock    12");
    }
}
