//! Emoji shortcodes: a typed `:name:` with a known GitHub shortcode becomes
//! its emoji, and a typed `:na` lists the matching emoji in the
//! autocomplete menu.

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

    /// Replace the `:name:` the just-typed colon closed with its emoji;
    /// one undo restores the typed shortcode.
    pub(super) fn convert_emoji_shortcode(&mut self) {
        let Some((start, name)) = self.shortcode_token(self.cursor_col - 1) else {
            return;
        };
        let Some(emoji) = emojis::get_by_shortcode(&name) else {
            return;
        };
        self.push_undo_snapshot();
        self.last_action = None;
        let result = self.replace_before_cursor(start, emoji.as_str());
        self.lines = result.lines;
        self.set_cursor_col(result.cursor_col);
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

    fn type_text(editor: &mut Editor, text: &str) {
        for c in text.chars() {
            match c {
                '\n' => editor.handle_input("shift+enter"),
                ' ' => editor.handle_input("space"),
                c => editor.handle_input(&c.to_string()),
            }
        }
    }

    #[test]
    fn the_closing_colon_converts_a_known_shortcode() {
        let mut e = editor();
        type_text(&mut e, "hi :heart");
        assert_eq!(e.get_text(), "hi :heart");
        type_text(&mut e, ":");
        assert_eq!(e.get_text(), "hi ❤️");
        e.handle_input("ctrl+-");
        assert_eq!(
            e.get_text(),
            "hi :heart:",
            "one undo restores the shortcode"
        );

        e.set_emoji_shortcodes(false);
        e.set_text("");
        type_text(&mut e, ":heart:");
        assert_eq!(e.get_text(), ":heart:", "the setting turns conversion off");
    }

    #[test]
    fn code_and_non_shortcodes_stay_as_typed() {
        for text in [
            "`:heart:",
            "```\n:heart:",
            "~~~\n:heart:",
            "~~~\n```\n:heart:",
            "https://example.com/:heart:",
            "10:30:",
            "a:heart:",
            "std::ok:",
            ":notanemoji:",
        ] {
            let mut e = editor();
            type_text(&mut e, text);
            assert_eq!(e.get_text(), text);
        }
    }

    #[test]
    fn two_name_chars_at_a_word_start_open_the_emoji_menu() {
        for (text, opens) in [(":h", false), ("a:he", false), (":hear", true)] {
            let mut e = editor();
            type_text(&mut e, text);
            e.materialize_autocomplete();
            let kind = e.autocomplete_state().and_then(|state| state.kind);
            assert_eq!(kind == Some(SuggestionKind::Emoji), opens, "{text}");
        }
        let mut e = editor();
        type_text(&mut e, ":hear");
        e.materialize_autocomplete();
        e.handle_input("tab");
        assert_eq!(e.get_text(), "❤️");

        // The menu stays open across cursor motions; accepting with no
        // shortcode at the cursor leaves the text alone.
        let mut e = editor();
        type_text(&mut e, "hello :hear");
        e.materialize_autocomplete();
        e.handle_input("home");
        assert!(e.is_showing_autocomplete());
        e.handle_input("tab");
        assert_eq!(e.get_text(), "hello :hear");
    }
}
