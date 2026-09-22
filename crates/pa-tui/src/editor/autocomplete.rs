//! Editor autocomplete integration: slash-command and file/path completion via
//! the configured provider.

use super::text_utils::{char_at, char_prefix, ends_with_symbol_token};
use super::*;

impl Editor {
    // ---- autocomplete ------------------------------------------------------

    pub(crate) fn current_slash_command_context(
        &self,
    ) -> Option<crate::autocomplete::SlashContext> {
        crate::autocomplete::get_slash_command_context(
            &self.lines,
            self.cursor_line,
            self.cursor_col,
        )
    }

    pub(crate) fn is_slash_name_completion_at_prompt_start(&self) -> bool {
        let ctx = self.current_slash_command_context();
        let kind_slash = self
            .autocomplete
            .as_ref()
            .map(|s| s.kind == Some(crate::autocomplete::SuggestionKind::SlashCommand))
            .unwrap_or(false);
        let default_slash = self.autocomplete.is_some()
            && self.autocomplete.as_ref().unwrap().prefix.starts_with('/');
        (kind_slash || default_slash)
            && matches!(ctx, Some(c) if c.kind == crate::autocomplete::SlashKind::Name && c.at_prompt_start)
    }

    pub(crate) fn apply_completion(
        &self,
        item: &crate::autocomplete::CompletionItem,
        prefix: &str,
    ) -> crate::autocomplete::CompletionResult {
        match self.autocomplete_provider.as_ref() {
            Some(provider) => provider.apply_completion(
                &self.lines,
                self.cursor_line,
                self.cursor_col,
                item,
                prefix,
            ),
            None => crate::autocomplete::CompletionResult {
                lines: self.lines.clone(),
                cursor_line: self.cursor_line,
                cursor_col: self.cursor_col,
            },
        }
    }

    pub(crate) fn handle_tab_completion(&mut self) {
        if self.autocomplete_provider.is_none() {
            return;
        }
        if matches!(self.current_slash_command_context(), Some(c) if c.kind == crate::autocomplete::SlashKind::Name)
        {
            self.request_autocomplete(false, true);
        } else {
            self.request_autocomplete(true, true);
        }
    }

    pub(crate) fn maybe_autocomplete_after_insert(&mut self, ch: &str) {
        if self.autocomplete.is_none() {
            let slash_ctx = self.current_slash_command_context();
            let c = ch.chars().next().unwrap_or(' ');
            if c == '/'
                && matches!(&slash_ctx, Some(ctx) if ctx.kind == crate::autocomplete::SlashKind::Name)
            {
                self.request_autocomplete(false, false);
            } else if c == '@' || c == '#' {
                let current_line = &self.lines[self.cursor_line];
                let before = char_prefix(current_line, self.cursor_col);
                let prev = char_at(&before, before.chars().count().saturating_sub(2));
                if before.chars().count() <= 1 || prev == Some(' ') || prev == Some('\t') {
                    self.request_autocomplete(false, false);
                }
            } else if c.is_ascii_alphanumeric() || ".-_".contains(c) {
                let current_line = &self.lines[self.cursor_line];
                let before = char_prefix(current_line, self.cursor_col);
                if slash_ctx.is_some() || ends_with_symbol_token(&before) {
                    self.request_autocomplete(false, false);
                }
            }
        } else {
            self.refresh_autocomplete_after_edit(false);
        }
    }

    pub(crate) fn request_autocomplete(&mut self, force: bool, explicit_tab: bool) {
        let Some(provider) = self.autocomplete_provider.as_ref() else {
            return;
        };
        if force {
            let should = provider.should_trigger_file_completion(
                &self.lines,
                self.cursor_line,
                self.cursor_col,
            );
            if !should {
                return;
            }
        }
        // TS resolves suggestions asynchronously (a `getSuggestions`
        // promise): the dropdown only materializes after the current
        // keystroke batch, so the request parks here and the host loop
        // materializes it when the input queue drains.
        self.pending_autocomplete = Some(PendingAutocomplete {
            force,
            explicit_tab,
        });
    }

    /// Materialize the parked suggestion request (TS
    /// `runAutocompleteRequest` after the promise resolves). The host loop
    /// calls this once the input queue drains, so a burst of keystrokes
    /// never sees a dropdown open mid-batch.
    pub fn materialize_autocomplete(&mut self) {
        let Some(pending) = self.pending_autocomplete.take() else {
            return;
        };
        self.run_autocomplete_request(pending.force, pending.explicit_tab);
    }

    fn run_autocomplete_request(&mut self, force: bool, explicit_tab: bool) {
        let Some(provider) = self.autocomplete_provider.as_ref() else {
            return;
        };
        let Some(suggestions) =
            provider.get_suggestions(&self.lines, self.cursor_line, self.cursor_col, force)
        else {
            self.cancel_autocomplete();
            return;
        };
        if suggestions.items.is_empty() {
            self.cancel_autocomplete();
            return;
        }
        if force && explicit_tab && suggestions.items.len() == 1 {
            let item = suggestions.items[0].clone();
            self.push_undo_snapshot();
            self.last_action = None;
            let prefix = suggestions.prefix.clone();
            let result = self.apply_completion(&item, &prefix);
            self.lines = result.lines;
            self.cursor_line = result.cursor_line;
            self.set_cursor_col(result.cursor_col);
            self.emit(EditorEvent::Changed(self.get_text()));
            return;
        }
        let matching_prefix =
            if suggestions.kind == Some(crate::autocomplete::SuggestionKind::SlashCommand) {
                suggestions
                    .prefix
                    .strip_prefix('/')
                    .unwrap_or(&suggestions.prefix)
                    .to_string()
            } else {
                suggestions.prefix.clone()
            };
        let mut state = crate::autocomplete::AutocompleteState::new(
            suggestions.items,
            5,
            suggestions.prefix.clone(),
            suggestions.kind,
        );
        if let Some(idx) = state.best_match_index(&matching_prefix) {
            state.set_selected_index(idx);
        }
        let was_showing = self.autocomplete.is_some();
        self.autocomplete = Some(state);
        if was_showing != self.autocomplete.is_some() {
            self.emit(EditorEvent::AutocompleteToggled(
                self.autocomplete.is_some(),
            ));
        }
    }

    pub(crate) fn refresh_autocomplete_after_edit(&mut self, retrigger: bool) {
        let current_line = &self.lines[self.cursor_line];
        let before = char_prefix(current_line, self.cursor_col);
        let has_ctx =
            self.current_slash_command_context().is_some() || ends_with_symbol_token(&before);

        if self.autocomplete.is_some() {
            if self.get_text().trim().is_empty() {
                self.cancel_autocomplete();
                return;
            }
            let force = self
                .autocomplete
                .as_ref()
                .map(|s| s.forced)
                .unwrap_or(false);
            self.request_autocomplete(force, false);
            return;
        }
        if retrigger && has_ctx {
            self.request_autocomplete(false, false);
        }
    }

    pub fn cancel_autocomplete(&mut self) {
        let was = self.autocomplete.is_some();
        self.autocomplete = None;
        self.pending_autocomplete = None;
        if was {
            self.emit(EditorEvent::AutocompleteToggled(false));
        }
    }

    // ---- layout / rendering ------------------------------------------------
}
