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

    /// Prefill a fresh filter from a typed partial (`/model <partial>` +
    /// Tab): the value lands whole and the caret sits at its end, so the
    /// next keystroke extends the filter and Backspace deletes the tail.
    /// Unlike `set_value` (TS `setValue`), which only clamps a caret
    /// already placed inside the value.
    pub(crate) fn prefill(&mut self, value: &str) {
        self.value = value.to_string();
        self.cursor = self.value.chars().count();
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
            // TS `handleBackspace`: delete one whole grapheme cluster.
            self.last_action = LastAction::None;
            if self.cursor > 0 {
                self.push_undo();
                let mut boundary = 0usize;
                for end in self.grapheme_ends() {
                    if end < self.cursor {
                        boundary = end;
                    } else {
                        break;
                    }
                }
                let chars = self.chars();
                self.value = chars[..boundary]
                    .iter()
                    .chain(chars[self.cursor..].iter())
                    .collect();
                self.cursor = boundary;
            }
            return;
        }
        if kb.matches(key, "tui.editor.deleteCharForward") {
            // TS `handleForwardDelete`: delete one whole grapheme cluster.
            self.last_action = LastAction::None;
            if let Some(end) = self.grapheme_ends().into_iter().find(|e| *e > self.cursor) {
                self.push_undo();
                let chars = self.chars();
                self.value = chars[..self.cursor]
                    .iter()
                    .chain(chars[end..].iter())
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
            // TS `cursorLeft`: move over one whole grapheme cluster.
            let mut boundary = 0usize;
            for end in self.grapheme_ends() {
                if end < self.cursor {
                    boundary = end;
                } else {
                    break;
                }
            }
            self.cursor = boundary;
            return;
        }
        if kb.matches(key, "tui.editor.cursorRight") {
            self.last_action = LastAction::None;
            // TS `cursorRight`: advance over one whole grapheme cluster.
            if let Some(end) = self.grapheme_ends().into_iter().find(|e| *e > self.cursor) {
                self.cursor = end;
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

    /// Word-boundary walk (TS `moveWordBackwards`): pop the trailing
    /// whitespace graphemes of the before-cursor slice, then the
    /// punctuation or word run in front of them. The slice is segmented
    /// standalone, exactly like the TS original, so the run starts at the
    /// grapheme that ends at the cursor and a mid-cluster cursor
    /// classifies the partial cluster the same way TS does.
    fn move_word_backward(&mut self) {
        use unicode_segmentation::UnicodeSegmentation;
        if self.cursor == 0 {
            return;
        }
        let before: String = self.chars()[..self.cursor].iter().collect();
        let mut graphemes: Vec<&str> = before.graphemes(true).collect();
        while graphemes.last().is_some_and(|g| g.chars().any(is_ws)) {
            let g = graphemes.pop().expect("last checked Some");
            self.cursor -= g.chars().count();
        }
        let Some(last) = graphemes.last().copied() else {
            return;
        };
        let punctuation_run = last.chars().any(is_punct);
        while let Some(g) = graphemes.last().copied() {
            if punctuation_run {
                if !g.chars().any(is_punct) {
                    break;
                }
            } else if g.chars().any(is_ws) || g.chars().any(is_punct) {
                break;
            }
            graphemes.pop();
            self.cursor -= g.chars().count();
        }
    }

    /// Word-boundary walk forward (TS `moveWordForwards`), grapheme by
    /// grapheme.
    fn move_word_forward(&mut self) {
        let ends = self.grapheme_ends();
        let mut idx = ends.partition_point(|e| *e <= self.cursor);
        while idx < ends.len() && self.grapheme_is_ws(idx) {
            idx += 1;
        }
        if idx == ends.len() {
            self.cursor = ends.last().copied().unwrap_or(self.cursor);
            return;
        }
        let punctuation_run = self.grapheme_is_punct(idx);
        while idx < ends.len() {
            if punctuation_run {
                if !self.grapheme_is_punct(idx) {
                    break;
                }
            } else if self.grapheme_is_ws(idx) || self.grapheme_is_punct(idx) {
                break;
            }
            idx += 1;
        }
        self.cursor = if idx == 0 { 0 } else { ends[idx - 1] };
    }

    /// Char offsets where each grapheme cluster of the value ends, in order.
    fn grapheme_ends(&self) -> Vec<usize> {
        use unicode_segmentation::UnicodeSegmentation;
        let mut end = 0usize;
        self.value
            .graphemes(true)
            .map(|g| {
                end += g.chars().count();
                end
            })
            .collect()
    }

    /// The `idx`-th grapheme cluster (a full segment, not one char).
    fn grapheme_at(&self, idx: usize) -> String {
        use unicode_segmentation::UnicodeSegmentation;
        self.value
            .graphemes(true)
            .nth(idx)
            .expect("index within the value")
            .to_string()
    }

    fn grapheme_is_ws(&self, idx: usize) -> bool {
        self.grapheme_at(idx).chars().any(is_ws)
    }

    fn grapheme_is_punct(&self, idx: usize) -> bool {
        self.grapheme_at(idx).chars().any(is_punct)
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

    /// A prefill from a typed partial (`/model gp` + Tab) continues where
    /// the user stopped: the caret sits at the end, typing extends the
    /// filter, and Backspace deletes the tail — unlike `set_value`, which
    /// leaves the caret at its old column (0 on a fresh input).
    #[test]
    fn prefill_places_the_caret_at_the_end() {
        let mut input = SearchInput::new();
        input.prefill("gp");
        assert_eq!(input.value(), "gp");
        assert_eq!(input.cursor(), 2);
        input.handle_key("t", &kb());
        assert_eq!(input.value(), "gpt");
        assert_eq!(input.cursor(), 3);
        input.handle_key("backspace", &kb());
        assert_eq!(input.value(), "gp");
    }

    #[test]
    fn paste_strips_newlines_and_expands_tabs() {
        let mut input = typed("mo");
        input.paste("ck\t1\n2");
        assert_eq!(input.value(), "mock    12");
    }

    /// Grapheme-model parity (TS `Input`, components/input.ts:18): the
    /// cursor, deletion, and word motion operate on whole grapheme
    /// clusters, never single chars of a multi-char cluster.
    #[test]
    fn backspace_deletes_whole_grapheme_clusters() {
        // e + combining acute is one cluster: one backspace removes both.
        let mut input = typed("cafe\u{301}");
        assert_eq!(input.value(), "cafe\u{301}");
        input.handle_key("backspace", &kb());
        assert_eq!(input.value(), "caf");
        // A ZWJ family emoji is one cluster of 7 chars.
        let mut emoji = typed("\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}x");
        emoji.handle_key("backspace", &kb());
        assert_eq!(
            emoji.value(),
            "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}"
        );
        emoji.handle_key("backspace", &kb());
        assert_eq!(emoji.value(), "");
    }

    #[test]
    fn forward_delete_removes_whole_clusters() {
        let mut input = SearchInput::new();
        input.set_value("a\u{301}b");
        input.handle_key("home", &kb());
        input.handle_key("delete", &kb());
        assert_eq!(input.value(), "b");
    }

    #[test]
    fn cursor_motion_steps_whole_clusters() {
        let mut input = SearchInput::new();
        input.set_value("ab\u{1f600}cd");
        input.handle_key("end", &kb());
        assert_eq!(input.cursor(), input.value().chars().count());
        // Left over the astral emoji (one char, one grapheme), then 'c'.
        input.handle_key("left", &kb());
        input.handle_key("left", &kb());
        assert_eq!(input.cursor(), 3);
        input.handle_key("right", &kb());
        assert_eq!(input.cursor(), 4);
    }

    #[test]
    fn word_motion_walks_graphemes() {
        // Word-right over a value with combining marks and an astral
        // cluster: the run ends at the punctuation boundary, whole
        // clusters at a time (TS moveWordForwards walks segmenter data).
        let mut input = SearchInput::new();
        input.set_value("wo\u{301}rd\u{1f600}  next");
        input.handle_key("home", &kb());
        // Word-right stops before the trailing spaces (TS moveWordForwards
        // only skips LEADING whitespace).
        input.handle_key("ctrl+right", &kb());
        assert_eq!(
            input
                .value()
                .chars()
                .take(input.cursor())
                .collect::<String>(),
            "wo\u{301}rd\u{1f600}"
        );
        input.handle_key("ctrl+right", &kb());
        assert_eq!(
            input
                .value()
                .chars()
                .take(input.cursor())
                .collect::<String>(),
            "wo\u{301}rd\u{1f600}  next"
        );
        // Word-left lands on the start of "next" (leading spaces skipped by
        // the next move), then walks the whole word run to the start.
        input.handle_key("ctrl+left", &kb());
        assert_eq!(
            input
                .value()
                .chars()
                .skip(input.cursor())
                .collect::<String>(),
            "next"
        );
        input.handle_key("ctrl+left", &kb());
        assert_eq!(input.cursor(), 0);
    }

    #[test]
    fn word_delete_kills_whole_clusters() {
        let mut input = SearchInput::new();
        input.set_value("cafe\u{301} done");
        input.handle_key("end", &kb());
        input.handle_key("ctrl+w", &kb());
        assert_eq!(input.value(), "cafe\u{301} ");
        // The killed text is one kill-ring entry (the whole cluster run).
        input.handle_key("ctrl+y", &kb());
        assert_eq!(input.value(), "cafe\u{301} done");
    }

    // Review repro (PR #2600, Cursor Bugbot + Macroscope): word-back must
    // classify the grapheme the cursor sits after. TS `moveWordBackwards`
    // pops runs from the end of the standalone-segmented before-cursor
    // slice; from the end of "abc!" it stops before the punctuation run
    // (column 3), never at 0, and Ctrl-W kills only "!".
    #[test]
    fn word_back_classifies_the_grapheme_at_the_cursor() {
        let mut input = typed("abc!");
        input.handle_key("ctrl+left", &kb());
        assert_eq!(input.cursor(), 3);
        input.handle_key("ctrl+left", &kb());
        assert_eq!(input.cursor(), 0);

        // A punctuation run is one word class: both "!" go at once.
        let mut bangs = typed("abc!!");
        bangs.handle_key("ctrl+w", &kb());
        assert_eq!(bangs.value(), "abc");
        assert_eq!(bangs.cursor(), 3);
        bangs.handle_key("ctrl+w", &kb());
        assert_eq!(bangs.value(), "");
        assert_eq!(bangs.cursor(), 0);

        // The whitespace run before a word is skipped only up to the word.
        let mut spaced = typed("   x");
        spaced.handle_key("ctrl+left", &kb());
        assert_eq!(spaced.cursor(), 3);

        // A wide ZWJ family cluster is one grapheme of the word run.
        let mut emoji = typed("ab\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}");
        emoji.handle_key("ctrl+left", &kb());
        assert_eq!(emoji.cursor(), 0);
    }

    // A mid-cluster cursor walks the before-cursor slice exactly like TS
    // (standalone segmentation). Pasting a lone combining mark, moving
    // Home, and typing "e" leaves the cursor inside the "e\u{301}" cluster:
    // backspace deletes the standalone "e" and orphans the mark in BOTH
    // implementations (TS `handleBackspace` segments value[..cursor]), and
    // word-back walks the "e" word run to the start. The (value, cursor)
    // pairs are pinned against the TS binary via the real input.ts class.
    #[test]
    fn mid_cluster_cursor_walks_the_before_cursor_slice() {
        let mut input = SearchInput::new();
        input.paste("\u{301}");
        input.handle_key("home", &kb());
        input.handle_key("e", &kb());
        assert_eq!(input.value(), "e\u{301}");
        assert_eq!(input.cursor(), 1);
        input.handle_key("backspace", &kb());
        assert_eq!(input.value(), "\u{301}");
        assert_eq!(input.cursor(), 0);

        let mut word = SearchInput::new();
        word.paste("\u{301}");
        word.handle_key("home", &kb());
        word.handle_key("e", &kb());
        word.handle_key("ctrl+w", &kb());
        assert_eq!(word.value(), "\u{301}");
        assert_eq!(word.cursor(), 0);
    }
}
