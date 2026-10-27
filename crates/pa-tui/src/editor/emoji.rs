//! Emoji shortcodes: a typed `:na` lists the emoji whose GitHub shortcodes
//! match in the autocomplete menu, and accepting an item inserts the emoji.

use super::text_utils::{char_prefix, char_suffix};
use super::Editor;
use crate::autocomplete::{CompletionItem, CompletionResult, SuggestionKind, Suggestions};

/// The name characters typed after `:` before the menu opens.
const MIN_QUERY_CHARS: usize = 2;

impl Editor {
    pub fn set_emoji_shortcodes(&mut self, enabled: bool) {
        self.emoji_shortcodes = enabled;
    }

    /// The `:name` token ending at `col` on the cursor line: its start
    /// column and the name. The colon must start a word (`a:b:c`,
    /// `std::fmt` and URL paths never match), and code spans and fences
    /// are skipped.
    fn shortcode_token(&self, col: usize) -> Option<(usize, String)> {
        if !self.emoji_shortcodes {
            return None;
        }
        let before: Vec<char> = self.lines[self.cursor_line].chars().take(col).collect();
        let colon = before.iter().rposition(|c| *c == ':')?;
        let name: String = before[colon + 1..].iter().collect();
        if name.is_empty() || name.contains(char::is_whitespace) {
            return None;
        }
        if colon > 0
            && (before[colon - 1].is_alphanumeric() || matches!(before[colon - 1], ':' | '/'))
        {
            return None;
        }
        if self.in_code(&before[..colon]) {
            return None;
        }
        Some((colon, name))
    }

    /// Whether text after `before` on the cursor line sits in a fenced
    /// code block or an open backtick span.
    fn in_code(&self, before: &[char]) -> bool {
        let fence = |line: &str| {
            ["```", "~~~"]
                .into_iter()
                .find(|marker| line.trim_start().starts_with(marker))
        };
        // A fence closes only on its own marker, as in the markdown renderer.
        let mut open = None;
        for line in &self.lines[..self.cursor_line] {
            match (open, fence(line)) {
                (None, Some(marker)) => open = Some(marker),
                (Some(opener), Some(marker)) if opener == marker => open = None,
                _ => {}
            }
        }
        open.is_some()
            || fence(&self.lines[self.cursor_line]).is_some()
            || before.iter().filter(|c| **c == '`').count() % 2 == 1
    }

    /// Apply an emoji menu item to the shortcode token at the cursor. The
    /// menu stays open across cursor motions, so the token is found again
    /// here; with no token at the cursor the buffer stays unchanged.
    pub(super) fn apply_emoji_completion(&self, emoji: &str) -> CompletionResult {
        match self.shortcode_token(self.cursor_col) {
            Some((start, _)) => self.replace_before_cursor(start, emoji),
            None => CompletionResult {
                lines: self.lines.clone(),
                cursor_line: self.cursor_line,
                cursor_col: self.cursor_col,
            },
        }
    }

    /// The `:na` token at the cursor that opens the emoji menu.
    pub(super) fn emoji_query(&self) -> Option<(usize, String)> {
        self.shortcode_token(self.cursor_col)
            .filter(|(_, name)| name.chars().count() >= MIN_QUERY_CHARS)
    }

    /// The emoji whose shortcodes start with the typed name, shortest
    /// shortcode first.
    pub(super) fn emoji_suggestions(name: &str) -> Suggestions {
        let mut matches: Vec<(&str, &str)> = emojis::iter()
            .flat_map(|emoji| {
                emoji
                    .shortcodes()
                    .filter(|code| code.starts_with(name))
                    .map(|code| (code, emoji.as_str()))
            })
            .collect();
        matches.sort_by_key(|(code, _)| code.len());
        Suggestions {
            prefix: format!(":{name}"),
            kind: Some(SuggestionKind::Emoji),
            items: matches
                .into_iter()
                .map(|(code, emoji)| CompletionItem {
                    value: emoji.to_string(),
                    label: format!("{emoji} :{code}:"),
                    description: None,
                    argument_hint: None,
                    source_tag: None,
                })
                .collect(),
        }
    }

    /// The cursor line with `start..cursor` replaced by `text`.
    fn replace_before_cursor(&self, start: usize, text: &str) -> CompletionResult {
        let line = &self.lines[self.cursor_line];
        let mut lines = self.lines.clone();
        lines[self.cursor_line] = format!(
            "{}{text}{}",
            char_prefix(line, start),
            char_suffix(line, self.cursor_col)
        );
        CompletionResult {
            lines,
            cursor_line: self.cursor_line,
            cursor_col: start + text.chars().count(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editor() -> Editor {
        let mut editor = Editor::new();
        editor.set_emoji_shortcodes(true);
        editor
    }

    /// Type key by key, materializing suggestions after each key as the
    /// host loop does once the input queue drains.
    fn type_text(editor: &mut Editor, text: &str) {
        for c in text.chars() {
            match c {
                '\n' => editor.handle_input("shift+enter"),
                ' ' => editor.handle_input("space"),
                c => editor.handle_input(&c.to_string()),
            }
            editor.materialize_autocomplete();
        }
    }

    #[test]
    fn two_name_chars_at_a_word_start_outside_code_open_the_emoji_menu() {
        for (text, opens) in [
            (":he", true),
            (":h", false),
            ("a:he", false),
            ("std::he", false),
            ("https://example.com/:he", false),
            ("`:he", false),
            ("```\n:he", false),
            ("~~~\n```\n:he", false),
        ] {
            let mut e = editor();
            type_text(&mut e, text);
            let kind = e.autocomplete_state().and_then(|state| state.kind);
            assert_eq!(kind == Some(SuggestionKind::Emoji), opens, "{text:?}");
        }
    }

    #[test]
    fn only_accepting_from_the_menu_inserts_the_emoji() {
        let mut e = editor();
        type_text(&mut e, ":hear");
        e.handle_input("enter");
        assert_eq!(e.get_text(), "❤️");
        e.handle_input("ctrl+-");
        assert_eq!(e.get_text(), ":hear", "one undo restores the typed text");

        // A closing colon or a space keeps the text and dismisses the menu.
        for text in [":heart:", ":heart "] {
            let mut e = editor();
            type_text(&mut e, text);
            assert_eq!(e.get_text(), text);
            assert!(!e.is_showing_autocomplete(), "{text:?}");
        }

        // The menu stays open across cursor motions; accepting with no
        // shortcode at the cursor leaves the text alone.
        let mut e = editor();
        type_text(&mut e, "hello :hear");
        e.handle_input("home");
        assert!(e.is_showing_autocomplete());
        e.handle_input("enter");
        assert_eq!(e.get_text(), "hello :hear");

        let mut e = Editor::new();
        type_text(&mut e, ":hear");
        assert!(
            !e.is_showing_autocomplete(),
            "the setting turns the menu off"
        );
    }
}
