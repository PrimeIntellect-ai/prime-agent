//! Line editor ported from `packages/tui/src/components/editor.ts`.

use crate::autocomplete::SlashCommandEntry;
use crate::keybindings::KeybindingsManager;
use crate::width::is_whitespace_char;
use std::collections::HashMap;

use text_utils::{char_at, split_at_char};
use wrap::{parse_paste_marker, segment_with_markers};

mod autocomplete;
mod click;
mod input;
mod kill_ring;
mod layout;
mod motion;
#[cfg(test)]
mod paste_tests;
mod selection;
mod text_ops;
mod text_utils;
mod wrap;

pub use kill_ring::KillRing;
pub(crate) use text_utils::decode_printable;
pub use text_utils::normalize_text;
pub use wrap::{is_atomic_marker, word_wrap_line, LayoutLine, Segment, TextChunk, VisualLine};

pub const MAX_HISTORY: usize = 100;
/// Large paste threshold: >10 lines or >1000 chars becomes a marker.
const LARGE_PASTE_LINES: usize = 10;
const LARGE_PASTE_CHARS: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
enum LastAction {
    Kill,
    Yank,
    TypeWord,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JumpDirection {
    Forward,
    Backward,
}

#[derive(Debug, Clone)]
struct EditorSnapshot {
    lines: Vec<String>,
    cursor_line: usize,
    cursor_col: usize,
    pastes: HashMap<usize, String>,
    paste_counter: usize,
    selection_anchor: Option<(usize, usize)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteDisposition {
    /// Paste applied inline (content merged into the buffer).
    Inline,
    /// Large paste stored as an atomic `[paste #N ...]` marker.
    Marker { id: usize },
}

/// The collapsed-paste registry: the id/content map behind `[paste #N ...]`
/// markers plus the id counter, so a draft moved to another editor still
/// expands.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EditorPasteSnapshot {
    pub pastes: Vec<(usize, String)>,
    pub paste_counter: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmitOutcome {
    /// Expanded + trimmed text, as delivered to `on_submit`.
    pub text: String,
}

/// Events produced by the editor for the host app.
#[derive(Debug, Clone)]
pub enum EditorEvent {
    Changed(String),
    Submitted(String),
    /// Autocomplete overlay visibility changed.
    AutocompleteToggled(bool),
    /// A selection cut/copy asks the host to write `text` to the system
    /// clipboard (the copy chain lives with the host, which owns the terminal).
    ClipboardWrite(String),
}

/// The multi-line editor.
pub struct Editor {
    pub lines: Vec<String>,
    pub cursor_line: usize,
    pub cursor_col: usize,

    pastes: HashMap<usize, String>,
    paste_counter: usize,
    history: Vec<String>,
    history_index: isize,
    kill_ring: KillRing,
    undo_stack: Vec<EditorSnapshot>,
    redo_stack: Vec<EditorSnapshot>,
    /// The selection anchor (TS has no editor selection; the selection spans
    /// the anchor to the cursor). `None` = no selection.
    selection_anchor: Option<(usize, usize)>,
    last_action: Option<LastAction>,
    jump_mode: Option<JumpDirection>,
    preferred_visual_col: Option<usize>,
    snapped_from_cursor_col: Option<usize>,
    last_width: usize,
    scroll_offset: usize,
    pub disable_submit: bool,
    keybindings: KeybindingsManager,
    terminal_rows: u16,

    autocomplete_provider: Option<Box<dyn crate::autocomplete::AutocompleteProvider + Send>>,
    autocomplete: Option<crate::autocomplete::AutocompleteState>,
    /// A suggestion request waiting to materialize (TS `getSuggestions` is
    /// async: a typed command plus Enter in one burst submits as typed). The
    /// host loop materializes it once the input queue drains.
    pending_autocomplete: Option<PendingAutocomplete>,
    /// The in-flight `@` file search with the editor state it answers: a
    /// result that lands after the lines or cursor moved is dropped.
    autocomplete_search: Option<AutocompleteSearch>,
    events: Vec<EditorEvent>,
}

#[derive(Debug)]
struct AutocompleteSearch {
    search: crate::autocomplete::FileSearch,
    request: PendingAutocomplete,
    lines: Vec<String>,
    cursor_line: usize,
    cursor_col: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PendingAutocomplete {
    pub force: bool,
    pub explicit_tab: bool,
}

impl Default for Editor {
    fn default() -> Self {
        Self::new()
    }
}

impl Editor {
    #[must_use]
    pub fn new() -> Self {
        Self {
            lines: vec![String::new()],
            cursor_line: 0,
            cursor_col: 0,
            pastes: HashMap::new(),
            paste_counter: 0,
            history: Vec::new(),
            history_index: -1,
            kill_ring: KillRing::default(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            selection_anchor: None,
            last_action: None,
            jump_mode: None,
            preferred_visual_col: None,
            snapped_from_cursor_col: None,
            last_width: 80,
            scroll_offset: 0,
            disable_submit: false,
            keybindings: KeybindingsManager::new(),
            terminal_rows: 24,
            autocomplete_provider: Some(Box::new(
                crate::autocomplete::CombinedAutocompleteProvider::from_registry(
                    std::env::current_dir().unwrap_or_default(),
                ),
            )),
            autocomplete: None,
            pending_autocomplete: None,
            autocomplete_search: None,
            events: Vec::new(),
        }
    }

    pub fn set_keybindings(&mut self, kb: KeybindingsManager) {
        self.keybindings = kb;
    }

    #[must_use]
    pub fn keybindings(&self) -> &KeybindingsManager {
        &self.keybindings
    }

    /// Terminal height, used for editor scroll window sizing.
    pub fn set_terminal_rows(&mut self, rows: u16) {
        self.terminal_rows = rows;
    }

    pub fn set_autocomplete_provider(
        &mut self,
        provider: Box<dyn crate::autocomplete::AutocompleteProvider + Send>,
    ) {
        self.cancel_autocomplete();
        self.autocomplete_provider = Some(provider);
    }

    /// Drop the installed autocomplete provider: an editor that must not complete
    /// (`Editor::new()` installs the builtin registry by default) answers nothing.
    pub fn clear_autocomplete_provider(&mut self) {
        self.cancel_autocomplete();
        self.autocomplete_provider = None;
    }

    #[must_use]
    pub fn autocomplete_state(&self) -> Option<&crate::autocomplete::AutocompleteState> {
        self.autocomplete.as_ref()
    }

    /// Replace the autocomplete provider's hidden-command set (the `/fast` model-eligibility
    /// filter).
    pub fn set_autocomplete_hidden_commands(&mut self, hidden: std::collections::HashSet<String>) {
        if let Some(provider) = self.autocomplete_provider.as_mut() {
            provider.set_hidden_commands(hidden);
        }
    }

    /// Replace one command's argument completions on the installed provider (e.g. the `/tier` tier
    /// choices).
    pub fn set_autocomplete_argument_completions(
        &mut self,
        command: &'static str,
        items: Vec<crate::autocomplete::CompletionItem>,
    ) {
        if let Some(provider) = self.autocomplete_provider.as_mut() {
            provider.set_argument_completions(command, items);
        }
    }

    /// Replace the provider's `skill:` commands (this port swaps the list on
    /// the installed provider; TS `setupAutocompleteProvider` rebuilds the
    /// whole list). The open dropdown drops, but a PARKED request stays: the
    /// host loop materializes it against the new provider.
    pub fn set_autocomplete_skill_commands(&mut self, skills: Vec<SlashCommandEntry>) {
        let was_showing = self.autocomplete.is_some();
        self.autocomplete = None;
        if was_showing {
            self.emit(EditorEvent::AutocompleteToggled(false));
        }
        if let Some(provider) = self.autocomplete_provider.as_mut() {
            provider.set_skill_commands(skills);
        }
    }

    #[must_use]
    pub fn is_showing_autocomplete(&self) -> bool {
        self.autocomplete.is_some()
    }

    /// Whether a completion request is parked or a background `@` search is
    /// running: a menu may open, so the guards that close it treat this like
    /// an open menu.
    #[must_use]
    pub fn has_pending_autocomplete(&self) -> bool {
        self.pending_autocomplete.is_some() || self.autocomplete_search.is_some()
    }

    /// Drain pending editor events (change/submit) for the host loop.
    pub fn take_events(&mut self) -> Vec<EditorEvent> {
        std::mem::take(&mut self.events)
    }

    fn emit(&mut self, ev: EditorEvent) {
        self.events.push(ev);
    }

    #[allow(dead_code)]
    fn valid_paste_id(&self, id: usize) -> bool {
        self.pastes.contains_key(&id)
    }

    fn segment(&self, text: &str) -> Vec<Segment> {
        let pastes = self.pastes.clone();
        segment_with_markers(text, &move |id| pastes.contains_key(&id))
    }

    #[must_use]
    pub fn get_text(&self) -> String {
        self.lines.join("\n")
    }

    #[must_use]
    pub fn get_expanded_text(&self) -> String {
        self.expand_paste_markers(&self.lines.join("\n"))
    }

    fn expand_paste_markers(&self, text: &str) -> String {
        // One scan with the shared marker shape (TS builds one regex per
        // registered id): a marker expands only when its parsed id is
        // registered, so a typed look-alike stays literal.
        let mut result = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(idx) = rest.find("[paste #") {
            result.push_str(&rest[..idx]);
            let candidate = &rest[idx..];
            if let Some((id, len)) = parse_paste_marker(candidate) {
                if let Some(content) = self.pastes.get(&id) {
                    result.push_str(content);
                } else {
                    // Well-formed but unregistered: keep it literal.
                    result.push_str(&candidate[..len]);
                }
                rest = &candidate[len..];
            } else {
                // Malformed marker head: keep up to the next `]` (or the
                // rest when none remains) so the scan still progresses.
                let skip = candidate.find(']').map_or(candidate.len(), |p| p + 1);
                result.push_str(&candidate[..skip]);
                rest = &candidate[skip..];
            }
        }
        result.push_str(rest);
        result
    }

    #[must_use]
    pub fn get_lines(&self) -> Vec<String> {
        self.lines.clone()
    }

    #[must_use]
    pub fn get_cursor(&self) -> (usize, usize) {
        (self.cursor_line, self.cursor_col)
    }

    /// Test-only direct cursor placement (the runtime paths position the
    /// cursor only through the motions).
    #[cfg(test)]
    pub(crate) fn set_cursor_for_tests(&mut self, line: usize, col: usize) {
        self.cursor_line = line;
        self.set_cursor_col(col);
    }

    /// The prompt prefix the first line renders in place of its leading
    /// `!`/`!!`: `! `/`!! ` for a bang command, `None` for the default `> `.
    #[must_use]
    pub fn bash_prompt_prefix(&self) -> Option<&'static str> {
        self.lines
            .first()
            .and_then(|line| crate::bash_bang::bash_prompt_info(line))
            .map(|(prefix, _)| prefix)
    }

    /// The hidden text prefix length of one line: the bang prefix the prompt
    /// renders in place on line 0, zero everywhere else. The cursor cannot
    /// move into it and edits treat it as the line's start.
    #[must_use]
    pub fn line_start_col(&self, line_index: usize) -> usize {
        if line_index != 0 {
            return 0;
        }
        self.lines
            .first()
            .and_then(|line| crate::bash_bang::bash_prompt_info(line))
            .map_or(0, |(_, hidden)| hidden)
    }

    /// The cursor sits at the end of the last logical line.
    #[must_use]
    pub fn is_cursor_at_end(&self) -> bool {
        let last = self.lines.len() - 1;
        self.cursor_line == last && self.cursor_col == self.lines[last].chars().count()
    }

    #[must_use]
    pub fn get_paste_snapshot(&self) -> EditorPasteSnapshot {
        let mut pastes: Vec<(usize, String)> =
            self.pastes.iter().map(|(k, v)| (*k, v.clone())).collect();
        pastes.sort();
        EditorPasteSnapshot {
            pastes,
            paste_counter: self.paste_counter,
        }
    }

    pub fn restore_paste_snapshot(&mut self, snapshot: EditorPasteSnapshot) {
        self.pastes = snapshot.pastes.into_iter().collect();
        self.paste_counter = snapshot.paste_counter;
    }

    pub fn set_text(&mut self, text: &str) {
        self.cancel_autocomplete();
        self.last_action = None;
        self.history_index = -1;
        let normalized = normalize_text(text);
        if self.get_text() != normalized {
            self.push_undo_snapshot();
        }
        self.set_text_internal(&normalized);
    }

    fn set_text_internal(&mut self, text: &str) {
        let lines: Vec<String> = text.split('\n').map(str::to_string).collect();
        self.lines = if lines.is_empty() {
            vec![String::new()]
        } else {
            lines
        };
        self.cursor_line = self.lines.len() - 1;
        let col = self.lines[self.cursor_line].chars().count();
        self.set_cursor_col(col);
        self.scroll_offset = 0;
        // A whole-text replacement has no spanning selection left.
        self.selection_anchor = None;
        self.emit(EditorEvent::Changed(self.get_text()));
    }

    pub fn insert_text_at_cursor(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.cancel_autocomplete();
        // The injected text lands at the cursor: a stale selection anchor
        // would make the NEXT keystroke splice a wrong range, so the
        // selection collapses first.
        self.selection_anchor = None;
        self.push_undo_snapshot();
        self.last_action = None;
        self.history_index = -1;
        self.insert_text_at_cursor_internal(text);
    }

    pub fn add_to_history(&mut self, text: &str) {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return;
        }
        if self.history.first() == Some(&trimmed.to_string()) {
            return;
        }
        self.history.insert(0, trimmed.to_string());
        if self.history.len() > MAX_HISTORY {
            self.history.pop();
        }
    }

    #[must_use]
    pub fn get_history(&self) -> &[String] {
        &self.history
    }

    pub fn clear_history(&mut self) {
        self.history.clear();
        self.history_index = -1;
    }

    fn is_editor_empty(&self) -> bool {
        self.lines.len() == 1 && self.lines[0].is_empty()
    }

    fn navigate_history(&mut self, direction: isize) {
        self.last_action = None;
        if self.history.is_empty() {
            return;
        }
        let new_index = self.history_index - direction;
        if new_index < -1 || new_index >= self.history.len() as isize {
            return;
        }
        if self.history_index == -1 && new_index >= 0 {
            self.push_undo_snapshot();
        }
        self.history_index = new_index;
        let idx = self.history_index;
        if idx == -1 {
            self.set_text_internal("");
        } else {
            let text = self.history[idx as usize].clone();
            self.set_text_internal(&text);
        }
    }

    /// History browsing holds the editor: the state that parks the
    /// move-below-prompt hand-off.
    #[must_use]
    pub fn is_history_navigation_active(&self) -> bool {
        self.history_index > -1
    }

    fn push_undo_snapshot(&mut self) {
        // A new edit invalidates the redo history (standard editor semantics; the TS product has no
        // redo).
        self.redo_stack.clear();
        self.undo_stack.push(self.current_snapshot());
    }

    /// The undoable state of the editor right now.
    fn current_snapshot(&self) -> EditorSnapshot {
        EditorSnapshot {
            lines: self.lines.clone(),
            cursor_line: self.cursor_line,
            cursor_col: self.cursor_col,
            pastes: self.pastes.clone(),
            paste_counter: self.paste_counter,
            selection_anchor: self.selection_anchor,
        }
    }

    fn apply_snapshot(&mut self, snapshot: EditorSnapshot) {
        self.lines = snapshot.lines;
        self.cursor_line = snapshot.cursor_line;
        self.cursor_col = snapshot.cursor_col;
        self.pastes = snapshot.pastes;
        self.paste_counter = snapshot.paste_counter;
        self.selection_anchor = snapshot.selection_anchor;
        self.last_action = None;
        self.preferred_visual_col = None;
        self.emit(EditorEvent::Changed(self.get_text()));
        self.refresh_autocomplete_after_edit(true);
    }

    fn undo(&mut self) {
        self.history_index = -1;
        let Some(snapshot) = self.undo_stack.pop() else {
            return;
        };
        self.redo_stack.push(self.current_snapshot());
        self.apply_snapshot(snapshot);
    }

    /// Redo the last undone edit (no TS counterpart — the TS editor has no
    /// redo): each undone edit lands on the redo stack, and any new edit clears it.
    fn redo(&mut self) {
        self.history_index = -1;
        let Some(snapshot) = self.redo_stack.pop() else {
            return;
        };
        self.undo_stack.push(self.current_snapshot());
        self.apply_snapshot(snapshot);
    }

    fn insert_character(&mut self, ch: &str) {
        self.insert_character_opts(ch, false);
    }

    fn insert_character_opts(&mut self, ch: &str, skip_undo_coalescing: bool) {
        self.history_index = -1;
        // Typing over an active selection replaces it in one undo step:
        // the snapshot below is taken with the selection still in place,
        // so undo restores the original text in a single press.
        let replacing = !skip_undo_coalescing && self.has_selection();
        if !skip_undo_coalescing {
            let is_ws = ch.chars().any(is_whitespace_char);
            if replacing || is_ws || self.last_action.as_ref() != Some(&LastAction::TypeWord) {
                self.push_undo_snapshot();
            }
            self.last_action = Some(LastAction::TypeWord);
        }
        if replacing {
            self.remove_selection();
        }
        let line = self.lines[self.cursor_line].clone();
        let (before, after) = split_at_char(&line, self.cursor_col);
        self.lines[self.cursor_line] = format!("{before}{ch}{after}");
        self.set_cursor_col(self.cursor_col + ch.chars().count());
        self.emit(EditorEvent::Changed(self.get_text()));
        self.maybe_autocomplete_after_insert(ch);
    }

    fn insert_text_at_cursor_internal(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let normalized = normalize_text(text);
        let inserted: Vec<String> = normalized.split('\n').map(str::to_string).collect();
        let current_line = self.lines[self.cursor_line].clone();
        let (before, after) = split_at_char(&current_line, self.cursor_col);
        if inserted.len() == 1 {
            self.lines[self.cursor_line] = format!("{before}{normalized}{after}");
            self.set_cursor_col(self.cursor_col + normalized.chars().count());
        } else {
            let mut new_lines: Vec<String> = Vec::with_capacity(self.lines.len() + inserted.len());
            new_lines.extend_from_slice(&self.lines[..self.cursor_line]);
            new_lines.push(format!("{}{}", before, inserted[0]));
            for mid in &inserted[1..inserted.len() - 1] {
                new_lines.push(mid.clone());
            }
            new_lines.push(format!("{}{}", inserted[inserted.len() - 1], after));
            new_lines.extend_from_slice(&self.lines[self.cursor_line + 1..]);
            self.lines = new_lines;
            self.cursor_line += inserted.len() - 1;
            let last_len = inserted[inserted.len() - 1].chars().count();
            self.set_cursor_col(last_len);
        }
        self.emit(EditorEvent::Changed(self.get_text()));
    }

    fn add_new_line(&mut self) {
        self.cancel_autocomplete();
        self.history_index = -1;
        self.last_action = None;
        self.push_undo_snapshot();
        // A newline over a selection replaces it (one undo step).
        if self.has_selection() {
            self.remove_selection();
        }
        let current_line = self.lines[self.cursor_line].clone();
        let (before, after) = split_at_char(&current_line, self.cursor_col);
        self.lines[self.cursor_line] = before;
        self.lines.insert(self.cursor_line + 1, after);
        self.cursor_line += 1;
        self.set_cursor_col(0);
        self.emit(EditorEvent::Changed(self.get_text()));
    }

    /// Submit the current text outside the Enter key path (the
    /// `app.message.followUp` key): the same clear-and-emit submit.
    pub fn submit(&mut self) {
        self.submit_value();
    }

    fn submit_value(&mut self) {
        self.cancel_autocomplete();
        let result = self
            .expand_paste_markers(&self.lines.join("\n"))
            .trim()
            .to_string();
        self.lines = vec![String::new()];
        self.cursor_line = 0;
        self.cursor_col = 0;
        self.pastes.clear();
        self.paste_counter = 0;
        self.history_index = -1;
        self.scroll_offset = 0;
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.selection_anchor = None;
        self.last_action = None;
        self.emit(EditorEvent::Changed(String::new()));
        self.emit(EditorEvent::Submitted(result));
    }

    /// Handle a bracketed-paste payload (including the large-paste marker logic).
    pub fn handle_paste(&mut self, pasted_text: &str) -> PasteDisposition {
        self.cancel_autocomplete();
        self.history_index = -1;
        self.last_action = None;

        // A tmux popup can re-encode control bytes inside the paste as
        // CSI-u Ctrl+letter sequences; decode them before the per-char
        // filter so newlines survive.
        let clean = normalize_text(&text_utils::decode_paste_ctrl_sequences(pasted_text));
        let filtered_raw: String = clean
            .chars()
            .filter(|&c| c == '\n' || (c as u32) >= 32)
            .collect();
        let mut filtered = filtered_raw;
        // A payload that filters to nothing (control-only bytes, empty
        // bracketed paste) changes nothing: no undo step, no selection
        // removal — the editor stays exactly as it was.
        if filtered.is_empty() {
            return PasteDisposition::Inline;
        }
        self.push_undo_snapshot();
        // Pasting over a selection replaces it (one undo step). The removal runs
        // BEFORE the path-space check below: the check inspects the character
        // before the INSERTION point, which after a selection replace is the
        // selection's start, not the live cursor a forward selection leaves.
        if self.has_selection() {
            self.remove_selection();
        }
        // File paths get a leading space when following a word char.
        if filtered.starts_with(['/', '~', '.']) {
            let line = &self.lines[self.cursor_line];
            let char_before = char_at(line, self.cursor_col.saturating_sub(1));
            if let Some(c) = char_before {
                if c.is_alphanumeric() || c == '_' {
                    filtered = format!(" {filtered}");
                }
            }
        }
        let line_count = filtered.split('\n').count();
        if line_count > LARGE_PASTE_LINES || filtered.chars().count() > LARGE_PASTE_CHARS {
            self.paste_counter += 1;
            let id = self.paste_counter;
            self.pastes.insert(id, filtered.clone());
            let marker = if line_count > LARGE_PASTE_LINES {
                format!("[paste #{id} +{line_count} lines]")
            } else {
                format!("[paste #{} {} chars]", id, filtered.chars().count())
            };
            self.insert_text_at_cursor_internal(&marker);
            return PasteDisposition::Marker { id };
        }
        self.insert_text_at_cursor_internal(&filtered);
        PasteDisposition::Inline
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ed() -> Editor {
        Editor::new()
    }

    #[test]
    fn typing_and_backspace() {
        let mut e = ed();
        e.handle_input("h");
        e.handle_input("i");
        assert_eq!(e.get_text(), "hi");
        e.handle_input("backspace");
        assert_eq!(e.get_text(), "h");
        e.handle_input("left");
        e.handle_input("backspace");
        assert_eq!(e.get_text(), "h");
    }

    #[test]
    fn newline_and_submit() {
        let mut e = ed();
        e.handle_input("a");
        e.handle_input("shift+enter");
        assert_eq!(e.get_lines(), vec!["a", ""]);
        e.handle_input("b");
        e.handle_input("enter");
        let events = e.take_events();
        let submitted = events
            .iter()
            .find_map(|ev| match ev {
                EditorEvent::Submitted(t) => Some(t.clone()),
                _ => None,
            })
            .expect("submit event");
        assert_eq!(submitted, "a\nb");
        assert_eq!(e.get_text(), "");
    }

    #[test]
    fn paste_decodes_reencoded_ctrl_bytes() {
        // A tmux csi-u paste re-encodes newlines as CSI-u Ctrl+J; the
        // newline survives instead of leaking "[106;5u" into the editor.
        let mut e = ed();
        e.handle_paste("alpha\x1b[106;5ubeta");
        assert_eq!(e.get_text(), "alpha\nbeta");
        assert_eq!(e.get_lines(), vec!["alpha", "beta"]);
    }

    #[test]
    fn undo_coalescing() {
        let mut e = ed();
        for c in ["h", "e", "l", "l", "o"] {
            e.handle_input(c);
        }
        e.handle_input("ctrl+-");
        assert_eq!(e.get_text(), "");
    }

    #[test]
    fn picker_argument_context_reports_command_and_partial() {
        let mut e = ed();
        e.set_text("/model gp");
        assert_eq!(
            e.picker_argument_context(),
            Some(("model".to_string(), "gp".to_string()))
        );
        e.set_text("/mcp lin ");
        assert_eq!(
            e.picker_argument_context(),
            Some(("mcp".to_string(), "lin ".to_string()))
        );
        e.set_text("/model");
        assert_eq!(e.picker_argument_context(), None);
        e.set_text("hello there");
        assert_eq!(e.picker_argument_context(), None);
        e.set_text("/export ht");
        assert_eq!(
            e.picker_argument_context(),
            Some(("export".to_string(), "ht".to_string()))
        );
    }

    #[test]
    fn deleting_to_an_empty_prompt_clears_the_parked_request() {
        let mut e = ed();
        e.handle_input(".");
        e.handle_input("/");
        e.handle_input("tab");
        assert!(e.pending_autocomplete.is_some(), "the request parks");
        e.handle_input("backspace");
        e.handle_input("backspace");
        assert_eq!(e.get_text(), "");
        assert!(
            e.pending_autocomplete.is_none(),
            "the parked request cancels"
        );
        e.materialize_autocomplete();
        assert!(
            e.autocomplete_state().is_none(),
            "no dropdown materializes on the emptied prompt"
        );
    }

    /// The session's Esc guard treats the parked-request window as an open
    /// menu; a cancel there must stop the request from ever opening.
    #[test]
    fn cancel_clears_a_parked_request_before_it_opens() {
        let mut e = ed();
        e.handle_input(".");
        e.handle_input("/");
        e.handle_input("tab");
        assert!(
            !e.is_showing_autocomplete(),
            "the dropdown is not visible before the idle tick"
        );
        assert!(e.has_pending_autocomplete(), "the request is parked");
        e.cancel_autocomplete();
        assert!(!e.has_pending_autocomplete());
        e.materialize_autocomplete();
        assert!(
            e.autocomplete_state().is_none(),
            "the cancelled request never opens"
        );
    }

    #[test]
    fn picker_argument_context_requires_the_cursor_at_the_argument_end() {
        // A cursor inside the argument would filter the picker on the head
        // and drop the tail on accept, so the Tab interception only fires
        // when the cursor sits at the argument's end.
        let mut e = ed();
        e.set_text("/model gp");
        assert_eq!(
            e.picker_argument_context(),
            Some(("model".to_string(), "gp".to_string()))
        );
        e.handle_input("left");
        assert_eq!(e.picker_argument_context(), None);
        e.set_text("/mcp lin ");
        assert_eq!(
            e.picker_argument_context(),
            Some(("mcp".to_string(), "lin ".to_string()))
        );
    }

    /// Applying from the picker clears the editor, so draft text on a later
    /// line must stop the Tab interception: opening the picker there would
    /// silently discard the draft on apply.
    #[test]
    fn picker_argument_context_rejects_later_draft_lines() {
        let mut e = ed();
        e.set_text("/model gp\ndraft reply");
        e.handle_input("up");
        assert_eq!(e.get_cursor(), (0, 9));
        assert_eq!(
            e.picker_argument_context(),
            None,
            "a later draft line must not be discarded by a picker apply"
        );
        e.set_text("/model gp\n   ");
        e.handle_input("up");
        e.handle_input("end");
        assert_eq!(e.get_cursor(), (0, 9));
        assert_eq!(
            e.picker_argument_context(),
            Some(("model".to_string(), "gp".to_string())),
            "whitespace-only later lines keep the interception"
        );
    }

    #[test]
    fn tab_on_an_empty_prompt_is_a_noop() {
        // Tab on an empty prompt must not open a completion menu: the forced
        // pass would list the whole cwd, with no anchor token to complete.
        let mut e = ed();
        e.handle_input("tab");
        e.materialize_autocomplete();
        assert!(!e.is_showing_autocomplete(), "no dropdown on empty Tab");
        e.handle_input(" ");
        e.handle_input(" ");
        e.handle_input("tab");
        e.materialize_autocomplete();
        assert!(!e.is_showing_autocomplete(), "no dropdown on blank Tab");
        e.set_text("/mo");
        e.handle_input("tab");
        e.materialize_autocomplete();
        assert!(
            e.is_showing_autocomplete(),
            "typed slash context still opens on Tab"
        );
    }

    #[test]
    fn history_navigation() {
        let mut e = ed();
        e.add_to_history("first prompt");
        e.add_to_history("second prompt");
        e.handle_input("up");
        assert_eq!(e.get_text(), "second prompt");
        assert!(e.is_history_navigation_active());
        e.handle_input("up");
        assert_eq!(e.get_text(), "first prompt");
        e.handle_input("down");
        assert_eq!(e.get_text(), "second prompt");
        e.handle_input("down");
        assert_eq!(e.get_text(), "");
        assert!(!e.is_history_navigation_active());
    }

    #[test]
    fn is_cursor_at_end_tracks_the_last_lines_end() {
        let mut e = ed();
        assert!(e.is_cursor_at_end());
        e.set_text("hello");
        e.handle_input("left");
        assert!(!e.is_cursor_at_end());
        e.handle_input("right");
        assert!(e.is_cursor_at_end());
        e.set_text("a\nb");
        assert_eq!(e.get_cursor(), (1, 1));
        e.handle_input("up");
        assert_eq!(e.get_cursor(), (0, 1));
        assert!(!e.is_cursor_at_end());
        e.handle_input("home");
        assert_eq!(e.get_cursor(), (0, 0));
        assert!(!e.is_cursor_at_end());
        e.handle_input("end");
        assert_eq!(e.get_cursor(), (0, 1));
        assert!(!e.is_cursor_at_end());
        e.handle_input("down");
        assert_eq!(e.get_cursor(), (1, 1));
        assert!(e.is_cursor_at_end());
    }

    #[test]
    fn large_paste_marker() {
        let mut e = ed();
        let big = (0..15)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let d = e.handle_paste(&big);
        assert!(matches!(d, PasteDisposition::Marker { id: 1 }));
        assert_eq!(e.get_text(), "[paste #1 +15 lines]");
        assert_eq!(e.get_expanded_text(), big);
    }

    #[test]
    fn small_paste_inline() {
        let mut e = ed();
        e.handle_paste("one\ntwo");
        assert_eq!(e.get_text(), "one\ntwo");
    }

    #[test]
    fn undo_removes_a_whole_paste_in_one_step() {
        let mut e = ed();
        e.handle_input("x");
        let big = (0..15)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(matches!(
            e.handle_paste(&big),
            PasteDisposition::Marker { .. }
        ));
        assert_eq!(e.get_text(), "x[paste #1 +15 lines]");
        e.handle_input("ctrl+-");
        assert_eq!(e.get_text(), "x", "one undo removed the whole paste");
        e.handle_paste("one\ntwo");
        assert_eq!(e.get_text(), "xone\ntwo");
        e.handle_input("ctrl+-");
        assert_eq!(e.get_text(), "x");
    }

    #[test]
    fn backslash_enter_newline() {
        let mut e = ed();
        e.handle_input("a");
        e.handle_input("\\");
        e.handle_input("enter");
        assert_eq!(e.get_lines(), vec!["a", ""]);
    }

    #[test]
    fn the_bang_prefix_is_hidden_and_protected() {
        let mut e = ed();
        e.set_text("!echo hi");
        assert_eq!(e.bash_prompt_prefix(), Some("! "));
        assert_eq!(e.line_start_col(0), 1);
        assert_eq!(e.line_start_col(1), 0, "later lines have no prefix");
        e.handle_input("home");
        assert_eq!(e.get_cursor(), (0, 1), "Home lands after the prefix");
        e.handle_input("left");
        assert_eq!(e.get_cursor(), (0, 1), "left cannot cross into the prefix");
        e.handle_input("right");
        e.handle_input("alt+b");
        assert_eq!(e.get_cursor(), (0, 1), "word-back stops at the prefix");
        e.handle_input("ctrl+u");
        assert_eq!(
            e.get_text(),
            "!echo hi",
            "kill-to-start keeps the prefix and the text behind the cursor"
        );
    }

    #[test]
    fn backspacing_the_bare_prefix_clears_the_prompt() {
        let mut e = ed();
        e.set_text("!x");
        e.handle_input("backspace");
        assert_eq!(e.get_text(), "!", "the body deleted, the prefix kept");
        assert_eq!(e.get_cursor(), (0, 1));
        e.handle_input("backspace");
        assert_eq!(e.get_text(), "", "backspacing the bare prefix clears it");
        assert_eq!(e.bash_prompt_prefix(), None);
    }

    #[test]
    fn the_double_bang_prefix_hides_two_characters() {
        let mut e = ed();
        e.set_text("!!echo hi");
        assert_eq!(e.bash_prompt_prefix(), Some("!! "));
        assert_eq!(e.line_start_col(0), 2);
        let layout = e.layout_text(20);
        assert_eq!(layout[0].text, "echo hi", "the raw prefix stays hidden");
        assert_eq!(layout[0].source_start, 2);
    }

    #[test]
    fn redo_restores_an_undone_edit() {
        let mut e = ed();
        for c in "hello".chars() {
            e.handle_input(&c.to_string());
        }
        e.handle_input("ctrl+-");
        assert_eq!(e.get_text(), "");
        e.handle_input("ctrl+shift+z");
        assert_eq!(e.get_text(), "hello");
    }

    #[test]
    fn redo_restores_an_undone_paste() {
        let mut e = ed();
        e.set_text("draft ");
        e.handle_paste("pasted");
        assert_eq!(e.get_text(), "draft pasted");
        e.handle_input("ctrl+-");
        assert_eq!(e.get_text(), "draft ");
        e.handle_input("ctrl+shift+z");
        assert_eq!(e.get_text(), "draft pasted");
        e.handle_input("super+z");
        assert_eq!(e.get_text(), "draft ");
        e.handle_input("super+shift+z");
        assert_eq!(e.get_text(), "draft pasted");
    }

    #[test]
    fn a_new_edit_clears_the_redo_stack() {
        let mut e = ed();
        for c in "ab".chars() {
            e.handle_input(&c.to_string());
        }
        e.handle_input("ctrl+-");
        assert_eq!(e.get_text(), "");
        e.handle_input("c");
        e.handle_input("ctrl+shift+z");
        assert_eq!(e.get_text(), "c");
    }

    #[test]
    fn doc_motions_reach_the_buffer_edges() {
        let mut e = ed();
        e.set_text("alpha\nbeta\ngamma");
        e.handle_input("ctrl+end");
        assert_eq!(e.get_cursor(), (2, 5));
        e.handle_input("ctrl+home");
        assert_eq!(e.get_cursor(), (0, 0));
        e.handle_input("super+down");
        assert_eq!(e.get_cursor(), (2, 5));
        e.handle_input("super+up");
        assert_eq!(e.get_cursor(), (0, 0));
    }

    #[test]
    fn paragraph_motions_skip_blank_lines() {
        let mut e = ed();
        e.set_text("p1 line one\np1 line two\n\np2 line one\np2 line two");
        e.set_cursor_for_tests(1, 11);
        e.handle_input("ctrl+up");
        assert_eq!(e.get_cursor(), (0, 0));
        e.handle_input("ctrl+down");
        assert_eq!(e.get_cursor(), (1, 11));
        e.handle_input("ctrl+down");
        assert_eq!(e.get_cursor(), (4, 11));
        e.handle_input("ctrl+up");
        assert_eq!(e.get_cursor(), (3, 0));
        e.handle_input("ctrl+up");
        assert_eq!(e.get_cursor(), (0, 0));
    }

    #[test]
    fn transpose_swaps_around_the_cursor() {
        let mut e = ed();
        e.set_text("abdc");
        e.set_cursor_for_tests(0, 3);
        e.handle_input("ctrl+t");
        assert_eq!(e.get_text(), "abcd");
        assert_eq!(e.get_cursor(), (0, 4));
        e.set_cursor_for_tests(0, 4);
        e.handle_input("ctrl+t");
        assert_eq!(e.get_text(), "abdc");
        e.handle_input("ctrl+-");
        assert_eq!(e.get_text(), "abcd");
    }
}
