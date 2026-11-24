//! Editor key dispatch: decodes TS-style key ids to editor actions through the
//! user's keybindings.

use super::text_utils::{char_at, decode_printable};
use super::{Editor, EditorEvent, JumpDirection};
use crate::autocomplete::SuggestionKind;
use crate::keybindings::TUI_KEYBINDINGS;

impl Editor {
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
            // Selection motions move the cursor away from the completion
            // token: the dropdown closes instead of holding a stale
            // anchor for the next Enter.
            self.cancel_autocomplete();
            self.select_left();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectRight") {
            self.cancel_autocomplete();
            self.select_right();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectUp") {
            self.cancel_autocomplete();
            self.select_up();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectDown") {
            self.cancel_autocomplete();
            self.select_down();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectWordLeft") {
            self.cancel_autocomplete();
            self.select_word_left();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectWordRight") {
            self.cancel_autocomplete();
            self.select_word_right();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectLineStart") {
            self.cancel_autocomplete();
            self.select_line_start();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectLineEnd") {
            self.cancel_autocomplete();
            self.select_line_end();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectParagraphUp") {
            self.cancel_autocomplete();
            self.select_paragraph_up();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectParagraphDown") {
            self.cancel_autocomplete();
            self.select_paragraph_down();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectDocStart") {
            self.cancel_autocomplete();
            self.select_doc_start();
            return;
        }
        if self.kb_matches(input, "tui.editor.selectDocEnd") {
            self.cancel_autocomplete();
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
                // A parked request means keys arrived after the slash menu was built, so
                // its selection answers an older query. The stale menu closes: Enter
                // submits the text as typed, and Tab completes the current text afresh.
                let slash_menu = self
                    .autocomplete
                    .as_ref()
                    .is_some_and(|s| s.kind == Some(SuggestionKind::SlashCommand));
                if slash_menu && self.pending_autocomplete.is_some() {
                    self.cancel_autocomplete();
                }
                let selected = self
                    .autocomplete
                    .as_ref()
                    .and_then(crate::autocomplete::AutocompleteState::selected_item);
                if let Some(item) = selected {
                    let is_typed_exact = self.is_slash_name_completion_at_prompt_start();
                    self.push_undo_snapshot();
                    self.last_action = None;
                    // A completion rewrites the buffer at the cursor: the
                    // selection collapses with it.
                    self.selection_anchor = None;
                    let (cl, cc) = (self.cursor_line, self.cursor_col);
                    let kind = self.autocomplete.as_ref().and_then(|s| s.kind);
                    let result = self.apply_completion(&item, kind);
                    let completed_noop = result.lines == self.lines
                        && result.cursor_line == cl
                        && result.cursor_col == cc;
                    self.lines = result.lines;
                    self.cursor_line = result.cursor_line;
                    self.set_cursor_col(result.cursor_col);
                    self.cancel_autocomplete();
                    self.request_autocomplete_in_symbol_token();
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
            // Doc/paragraph jumps have no TS counterpart, so an open
            // completion dropdown has no anchor semantics for them: the
            // dropdown closes instead of staying stale at the old token.
            self.cancel_autocomplete();
            self.clear_selection();
            self.move_to_doc_start();
            return;
        }
        if self.kb_matches(input, "tui.editor.cursorDocEnd") {
            self.cancel_autocomplete();
            self.clear_selection();
            self.move_to_doc_end();
            return;
        }
        if self.kb_matches(input, "tui.editor.cursorParagraphUp") {
            self.cancel_autocomplete();
            self.clear_selection();
            self.move_paragraph_backward();
            return;
        }
        if self.kb_matches(input, "tui.editor.cursorParagraphDown") {
            self.cancel_autocomplete();
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

    fn submitted(e: &mut Editor) -> Vec<String> {
        e.take_events()
            .into_iter()
            .filter_map(|event| match event {
                EditorEvent::Submitted(text) => Some(text),
                _ => None,
            })
            .collect()
    }

    /// A keystroke burst (typed command + Enter in one batch, the tmux
    /// send-keys pattern) submits as typed: the request is parked, so the
    /// dropdown never opens between the keys.
    #[test]
    fn typed_slash_burst_submits_as_typed() {
        let mut e = ed();
        for key in ["/", "g", "o", "a", "l"] {
            e.handle_input(key);
        }
        assert!(!e.is_showing_autocomplete(), "dropdown parks its request");
        e.handle_input("enter");
        assert_eq!(submitted(&mut e), vec!["/goal"]);
        assert_eq!(e.get_text(), "");
    }

    /// Full-speed typing after the dropdown opened on `/`: the rest of the
    /// command and Enter land in one batch, so the open menu still selects
    /// the `/` query's first row (`settings`). Enter submits the typed
    /// command, never that stale row.
    #[test]
    fn fast_typing_past_an_open_dropdown_submits_the_typed_command() {
        for command in ["/login", "/compact", "/clear", "/stop", "/status"] {
            let mut e = ed();
            e.handle_input("/");
            e.materialize_autocomplete();
            assert!(e.is_showing_autocomplete(), "dropdown opens on {command}");
            for ch in command.chars().skip(1) {
                e.handle_input(&ch.to_string());
            }
            e.handle_input("enter");
            assert_eq!(
                (submitted(&mut e), e.get_text()),
                (vec![command.to_string()], String::new())
            );
        }
    }

    /// The TS async-suggestion behavior for character-by-character typing
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

    /// A typed ZWJ family sequence lands in the buffer byte-exact: one key
    /// event per cluster char, each char inserted at the cursor (the
    /// 2026-09-22 harness reproduction of the audit crash class).
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
