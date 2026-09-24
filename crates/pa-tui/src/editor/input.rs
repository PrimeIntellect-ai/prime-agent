//! Editor key dispatch: decodes TS-style key ids to editor actions through the
//! user's keybindings.

use super::text_utils::{char_at, decode_printable};
use super::*;
use crate::keybindings::TUI_KEYBINDINGS;

impl Editor {
    // ---- input dispatch ----------------------------------------------------

    /// Handle one key event (already decoded to a TS-style key id, e.g.
    /// "ctrl+k", or a literal character for printable input).
    pub fn handle_input(&mut self, input: &str) {
        let kb_ids: Vec<String> = TUI_KEYBINDINGS
            .iter()
            .map(|(id, _)| id.to_string())
            .collect();
        let _ = kb_ids;
        self.handle_input_inner(input);
    }

    fn kb_matches(&self, input: &str, binding: &str) -> bool {
        self.keybindings.matches(input, binding)
    }

    fn handle_input_inner(&mut self, input: &str) {
        if let Some(direction) = self.jump_mode {
            if self.kb_matches(input, "tui.editor.jumpForward")
                || self.kb_matches(input, "tui.editor.jumpBackward")
            {
                self.jump_mode = None;
                return;
            }
            if let Some(printable) = decode_printable(input) {
                self.jump_mode = None;
                self.jump_to_char(&printable, direction == JumpDirection::Forward);
                return;
            }
            self.jump_mode = None;
        }

        if self.kb_matches(input, "tui.input.copy") {
            return;
        }
        if self.kb_matches(input, "tui.editor.undo") {
            self.undo();
            return;
        }
        if self.kb_matches(input, "tui.editor.redo") {
            self.redo();
            return;
        }
        // The selection families (standard editors' shift+arrow set; no TS
        // counterpart — see selection.rs): every plain motion below
        // collapses the selection, so these arms run first.
        if self.kb_matches(input, "tui.editor.selectAll") {
            self.select_all();
            return;
        }
        if self.kb_matches(input, "tui.editor.cutSelection") {
            if let Some(text) = self.cut_selection() {
                self.emit(EditorEvent::ClipboardWrite(text));
            }
            return;
        }
        if self.kb_matches(input, "tui.editor.copySelection") {
            if let Some(text) = self.copy_selection() {
                self.emit(EditorEvent::ClipboardWrite(text));
            }
            return;
        }
        if self.kb_matches(input, "tui.editor.transposeChars") {
            self.transpose_chars();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectLeft") {
            self.select_left();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectRight") {
            self.select_right();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectUp") {
            self.select_up();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectDown") {
            self.select_down();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectWordLeft") {
            self.select_word_left();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectWordRight") {
            self.select_word_right();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectLineStart") {
            self.select_line_start();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectLineEnd") {
            self.select_line_end();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectParagraphUp") {
            self.select_paragraph_up();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectParagraphDown") {
            self.select_paragraph_down();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectDocStart") {
            self.select_doc_start();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectDocEnd") {
            self.select_doc_end();
            return;
        }

        if self.autocomplete.is_some() {
            if self.kb_matches(input, "tui.select.cancel") {
                self.cancel_autocomplete();
                return;
            }
            if self.kb_matches(input, "tui.select.up") || self.kb_matches(input, "tui.select.down")
            {
                let up = self.kb_matches(input, "tui.select.up");
                if let Some(state) = self.autocomplete.as_mut() {
                    if up {
                        state.move_up();
                    } else {
                        state.move_down();
                    }
                }
                return;
            }
            if self.kb_matches(input, "tui.input.tab")
                || self.kb_matches(input, "tui.select.confirm")
            {
                let selected = self.autocomplete.as_ref().and_then(|s| s.selected_item());
                if let Some(item) = selected {
                    let is_typed_exact = self.is_slash_name_completion_at_prompt_start();
                    self.push_undo_snapshot();
                    self.last_action = None;
                    // A completion rewrites the buffer at the cursor: the
                    // selection collapses with it.
                    self.selection_anchor = None;
                    let (cl, cc) = (self.cursor_line, self.cursor_col);
                    let prefix = self
                        .autocomplete
                        .as_ref()
                        .map(|s| s.prefix.clone())
                        .unwrap_or_default();
                    let result = self.apply_completion(&item, &prefix);
                    let completed_noop = result.lines == self.lines
                        && result.cursor_line == cl
                        && result.cursor_col == cc;
                    self.lines = result.lines;
                    self.cursor_line = result.cursor_line;
                    self.set_cursor_col(result.cursor_col);
                    self.cancel_autocomplete();
                    if !is_typed_exact || !completed_noop {
                        self.emit(EditorEvent::Changed(self.get_text()));
                        return;
                    }
                    // Exact slash command typed: fall through so Enter submits.
                }
            }
        }

        if self.kb_matches(input, "tui.input.tab") && self.autocomplete.is_none() {
            self.handle_tab_completion();
            return;
        }

        if self.kb_matches(input, "tui.editor.deleteToLineEnd") {
            self.delete_to_end_of_line();
            return;
        }
        if self.kb_matches(input, "tui.editor.deleteToLineStart") {
            self.delete_to_start_of_line();
            return;
        }
        if self.kb_matches(input, "tui.editor.deleteWordBackward") {
            self.delete_word_backwards();
            return;
        }
        if self.kb_matches(input, "tui.editor.deleteWordForward") {
            self.delete_word_forward();
            return;
        }
        if self.kb_matches(input, "tui.editor.deleteCharBackward") || input == "shift+backspace" {
            self.handle_backspace();
            return;
        }
        if self.kb_matches(input, "tui.editor.deleteCharForward") || input == "shift+delete" {
            self.handle_forward_delete();
            return;
        }
        if self.kb_matches(input, "tui.editor.yank") {
            self.yank();
            return;
        }
        if self.kb_matches(input, "tui.editor.yankPop") {
            self.yank_pop();
            return;
        }
        if self.kb_matches(input, "tui.editor.cursorLineStart") {
            self.clear_selection();
            self.move_to_line_start();
            return;
        }
        if self.kb_matches(input, "tui.editor.cursorLineEnd") {
            self.clear_selection();
            self.move_to_line_end();
            return;
        }
        if self.kb_matches(input, "tui.editor.cursorDocStart") {
            self.clear_selection();
            self.move_to_doc_start();
            return;
        }
        if self.kb_matches(input, "tui.editor.cursorDocEnd") {
            self.clear_selection();
            self.move_to_doc_end();
            return;
        }
        if self.kb_matches(input, "tui.editor.cursorParagraphUp") {
            self.clear_selection();
            self.move_paragraph_backward();
            return;
        }
        if self.kb_matches(input, "tui.editor.cursorParagraphDown") {
            self.clear_selection();
            self.move_paragraph_forward();
            return;
        }
        if self.kb_matches(input, "tui.editor.cursorWordLeft") {
            self.clear_selection();
            self.move_word_backwards();
            return;
        }
        if self.kb_matches(input, "tui.editor.cursorWordRight") {
            self.clear_selection();
            self.move_word_forwards();
            return;
        }
        if self.kb_matches(input, "tui.input.newLine") {
            self.add_new_line();
            return;
        }
        if self.kb_matches(input, "tui.input.submit") {
            if self.disable_submit {
                return;
            }
            let current_line = self.lines[self.cursor_line].clone();
            if self.cursor_col > 0 && char_at(&current_line, self.cursor_col - 1) == Some('\\') {
                self.handle_backspace();
                self.add_new_line();
                return;
            }
            self.submit_value();
            return;
        }
        if self.kb_matches(input, "tui.editor.cursorUp") {
            self.clear_selection();
            if self.is_editor_empty()
                || (self.is_history_navigation_active() && self.is_on_first_visual_line())
            {
                self.navigate_history(-1);
            } else if self.is_on_first_visual_line() {
                self.move_to_line_start();
            } else {
                self.move_cursor(-1, 0);
            }
            return;
        }
        if self.kb_matches(input, "tui.editor.cursorDown") {
            self.clear_selection();
            if self.is_history_navigation_active() && self.is_on_last_visual_line() {
                self.navigate_history(1);
            } else if self.is_on_last_visual_line() {
                self.move_to_line_end();
            } else {
                self.move_cursor(1, 0);
            }
            return;
        }
        if self.kb_matches(input, "tui.editor.cursorRight") {
            self.clear_selection();
            self.move_cursor(0, 1);
            return;
        }
        if self.kb_matches(input, "tui.editor.cursorLeft") {
            self.clear_selection();
            self.move_cursor(0, -1);
            return;
        }
        if self.kb_matches(input, "tui.editor.pageUp") {
            self.clear_selection();
            self.page_scroll(-1);
            return;
        }
        if self.kb_matches(input, "tui.editor.pageDown") {
            self.clear_selection();
            self.page_scroll(1);
            return;
        }
        if self.kb_matches(input, "tui.editor.jumpForward") {
            self.clear_selection();
            self.jump_mode = Some(JumpDirection::Forward);
            return;
        }
        if self.kb_matches(input, "tui.editor.jumpBackward") {
            self.clear_selection();
            self.jump_mode = Some(JumpDirection::Backward);
            return;
        }
        if input == "shift+space" {
            self.insert_character(" ");
            return;
        }
        if let Some(printable) = decode_printable(input) {
            self.insert_character(&printable);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ed() -> Editor {
        Editor::new()
    }

    #[test]
    fn jump_mode() {
        let mut e = ed();
        e.set_text("hello world");
        e.move_to_line_start();
        e.handle_input("ctrl+]");
        e.handle_input("w");
        assert_eq!(e.get_cursor(), (0, 6));
    }

    /// A keystroke burst (typed command + Enter in one batch, the tmux
    /// send-keys pattern) submits as typed: the suggestion request is
    /// parked, so the dropdown never opens between the keys.
    #[test]
    fn typed_slash_burst_submits_as_typed() {
        let mut e = ed();
        for key in ["/", "g", "o", "a", "l"] {
            e.handle_input(key);
        }
        assert!(!e.is_showing_autocomplete(), "dropdown parks its request");
        e.handle_input("enter");
        let events = e.take_events();
        let submitted = events
            .iter()
            .filter_map(|event| match event {
                EditorEvent::Submitted(text) => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(submitted, vec!["/goal"]);
        assert_eq!(e.get_text(), "");
    }

    /// Once the parked request materializes (the input queue drained), a
    /// typed-exact command with an open dropdown completes into the
    /// argument position on Enter instead of submitting — the TS
    /// async-suggestion behavior for a command typed character-by-character
    /// with pauses.
    #[test]
    fn materialized_dropdown_enter_completes_into_args() {
        let mut e = ed();
        for key in ["/", "g", "o", "a", "l"] {
            e.handle_input(key);
        }
        e.materialize_autocomplete();
        assert!(
            e.is_showing_autocomplete(),
            "dropdown opens after the batch"
        );
        e.handle_input("enter");
        let events = e.take_events();
        assert!(!events
            .iter()
            .any(|event| matches!(event, EditorEvent::Submitted(_))));
        assert_eq!(e.get_text(), "/goal ");
    }

    /// A typed ZWJ family sequence lands in the buffer byte-exact (the
    /// 2026-09-22 harness reproduction of the audit crash class verified
    /// the editor MODEL is correct end to end: one key event per cluster
    /// char, each char inserted at the cursor).
    #[test]
    fn typed_zwj_family_lands_intact() {
        let mut e = ed();
        for ch in "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}x".chars() {
            e.handle_input(&ch.to_string());
        }
        eprintln!("text: {:?}", e.get_text());
        eprintln!("lines: {:?}", e.lines);
        assert_eq!(
            e.get_text(),
            "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}x"
        );
    }
}
