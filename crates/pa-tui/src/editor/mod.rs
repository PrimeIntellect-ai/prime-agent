//! Line editor ported from `packages/tui/src/components/editor.ts`.
//!
//! Behavior parity points: multi-line state, grapheme-aware cursor movement,
//! word wrap with atomic paste/image markers, prompt history, kill ring
//! (ctrl+k / ctrl+u / ctrl+w / alt+d, yank ctrl+y / alt+y), undo with
//! fish-style coalescing, jump mode, sticky vertical column, and bracketed
//! paste with large-paste markers.
//!
//! The editor is split by concern: `wrap` (segmentation/word wrap), `kill_ring`,
//! `text_ops` (deletion/yank), `motion` (cursor movement), `input` (key
//! dispatch), `autocomplete`, and `layout` (rendering-facing layout).

use crate::autocomplete::SlashCommandEntry;
use crate::keybindings::KeybindingsManager;
use crate::width::is_whitespace_char;
use std::collections::HashMap;

use text_utils::{char_at, split_at_char};
use wrap::{parse_paste_marker, segment_with_markers};

mod autocomplete;
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
pub use text_utils::normalize_text;
pub use wrap::{is_atomic_marker, word_wrap_line, LayoutLine, Segment, TextChunk, VisualLine};

pub const MAX_HISTORY: usize = 100;
/// Large paste threshold from TS: >10 lines or >1000 chars becomes a marker.
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

/// The collapsed-paste registry of an editor (TS `EditorPasteSnapshot`):
/// the id/content map behind `[paste #N ...]` markers plus the id
/// counter, so a draft moved to another editor still expands and keeps
/// its markers atomic.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EditorPasteSnapshot {
    pub pastes: Vec<(usize, String)>,
    pub paste_counter: usize,
}

/// Outcome of a submit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmitOutcome {
    /// Expanded + trimmed text, as delivered to on_submit.
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
    /// clipboard (the kill ring already holds it; the OSC 52/platform
    /// copy chain lives with the host, which owns the terminal).
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
    /// The selection anchor (TS has no editor selection; this is the
    /// prompt-editor-keybinds forward feature — the selection spans the
    /// anchor to the cursor). `None` = no selection.
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

    // Autocomplete
    autocomplete_provider: Option<Box<dyn crate::autocomplete::AutocompleteProvider + Send>>,
    autocomplete: Option<crate::autocomplete::AutocompleteState>,
    /// A suggestion request waiting to materialize (TS `getSuggestions` is
    /// async: the dropdown opens after the keystroke batch, so a typed
    /// command plus Enter in one burst submits as typed instead of hitting
    /// the dropdown's confirm arm). The host loop materializes it once the
    /// input queue drains.
    pending_autocomplete: Option<PendingAutocomplete>,
    events: Vec<EditorEvent>,
}

/// A deferred suggestion request (TS `requestAutocomplete` -> async
/// `getSuggestions` resolution).
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
            events: Vec::new(),
        }
    }

    pub fn set_keybindings(&mut self, kb: KeybindingsManager) {
        self.keybindings = kb;
    }

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

    pub fn autocomplete_state(&self) -> Option<&crate::autocomplete::AutocompleteState> {
        self.autocomplete.as_ref()
    }

    /// Replace the autocomplete provider's hidden-command set (the
    /// `/fast` model-eligibility filter; TS recomputes the command list
    /// per render).
    pub fn set_autocomplete_hidden_commands(&mut self, hidden: std::collections::HashSet<String>) {
        if let Some(provider) = self.autocomplete_provider.as_mut() {
            provider.set_hidden_commands(hidden);
        }
    }

    /// Replace the provider's `skill:` commands (TS
    /// `setupAutocompleteProvider` rebuilds the command list with the
    /// session's skills; this port swaps the list on the installed
    /// provider). The open dropdown — if any — drops, because its rows
    /// came from the old catalog (TS `setAutocompleteProvider` cancels
    /// too), but a PARKED request stays: the host loop materializes it
    /// against the new provider, so a `/` typed while the catalog
    /// refresh was still in flight still opens its menu (Cursor thread:
    /// the swap must not eat the parked request).
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

    pub fn is_showing_autocomplete(&self) -> bool {
        self.autocomplete.is_some()
    }

    /// Whether a completion request is parked: Tab or a trigger key
    /// queued it and the host loop materializes it at the next
    /// input-idle tick, so the dropdown is about to open.
    pub fn has_pending_autocomplete(&self) -> bool {
        self.pending_autocomplete.is_some()
    }

    /// Drain pending editor events (change/submit) for the host loop.
    pub fn take_events(&mut self) -> Vec<EditorEvent> {
        std::mem::take(&mut self.events)
    }

    fn emit(&mut self, ev: EditorEvent) {
        self.events.push(ev);
    }

    // ---- state helpers -------------------------------------------------

    #[allow(dead_code)]
    fn valid_paste_id(&self, id: usize) -> bool {
        self.pastes.contains_key(&id)
    }

    fn segment(&self, text: &str) -> Vec<Segment> {
        let pastes = self.pastes.clone();
        segment_with_markers(text, &move |id| pastes.contains_key(&id))
    }

    pub fn get_text(&self) -> String {
        self.lines.join("\n")
    }

    pub fn get_expanded_text(&self) -> String {
        self.expand_paste_markers(&self.lines.join("\n"))
    }

    fn expand_paste_markers(&self, text: &str) -> String {
        // One scan with the shared marker shape (TS builds one regex per
        // registered id): a marker expands only when its parsed id is
        // registered, so a typed or edited look-alike stays literal, and
        // `[paste #1` never swallows the head of `[paste #10]`.
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

    pub fn get_lines(&self) -> Vec<String> {
        self.lines.clone()
    }

    pub fn get_cursor(&self) -> (usize, usize) {
        (self.cursor_line, self.cursor_col)
    }

    /// Test-only direct cursor placement: the runtime paths position the
    /// cursor only through the motions, but the model tests need to start
    /// from an arbitrary position.
    #[cfg(test)]
    pub(crate) fn set_cursor_for_tests(&mut self, line: usize, col: usize) {
        self.cursor_line = line;
        self.set_cursor_col(col);
    }

    /// The prompt prefix the first line renders in place of its leading
    /// `!`/`!!` (TS `CustomEditor.getPromptPrefix`): `! ` / `!! ` when the
    /// first line opens a bang command, `None` for the default `> `.
    pub fn bash_prompt_prefix(&self) -> Option<&'static str> {
        self.lines
            .first()
            .and_then(|line| crate::bash_bang::bash_prompt_info(line))
            .map(|(prefix, _)| prefix)
    }

    /// The hidden text prefix length of one line (TS
    /// `getHiddenTextPrefixLength`): the bang prefix the prompt renders
    /// in place of on line 0, zero everywhere else. The cursor cannot
    /// move into it and edits treat it as the line's start.
    pub fn line_start_col(&self, line_index: usize) -> usize {
        if line_index != 0 {
            return 0;
        }
        self.lines
            .first()
            .and_then(|line| crate::bash_bang::bash_prompt_info(line))
            .map_or(0, |(_, hidden)| hidden)
    }

    /// The cursor sits at the end of the last logical line (TS
    /// `CustomEditor.isCursorAtEnd`): the position from which the
    /// move-below-prompt hook can hand the focus to the surface below the
    /// editor (the subagent summary line).
    pub fn is_cursor_at_end(&self) -> bool {
        let last = self.lines.len() - 1;
        self.cursor_line == last && self.cursor_col == self.lines[last].chars().count()
    }

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

    /// History browsing holds the editor (TS `isHistoryNavigationActive`):
    /// the state that parks the move-below-prompt hand-off.
    pub fn is_history_navigation_active(&self) -> bool {
        self.history_index > -1
    }

    // ---- undo / kill ring -----------------------------------------------

    fn push_undo_snapshot(&mut self) {
        // A new edit invalidates the redo history (standard editor
        // semantics; the TS product has no redo at all).
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

    /// Redo the last undone edit (standard editor semantics; no TS
    /// counterpart — the TS editor has no redo). Each undone edit lands
    /// on the redo stack, and any new edit clears it.
    fn redo(&mut self) {
        self.history_index = -1;
        let Some(snapshot) = self.redo_stack.pop() else {
            return;
        };
        self.undo_stack.push(self.current_snapshot());
        self.apply_snapshot(snapshot);
    }

    // ---- text mutation ---------------------------------------------------

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

    // ---- paste -----------------------------------------------------------

    /// Handle a bracketed-paste payload (port of handlePaste, including the
    /// large-paste marker logic).
    pub fn handle_paste(&mut self, pasted_text: &str) -> PasteDisposition {
        self.cancel_autocomplete();
        self.history_index = -1;
        self.last_action = None;

        // A tmux popup can re-encode control bytes inside the paste as
        // CSI-u Ctrl+letter sequences; decode them before the per-char
        // filter so newlines survive (TS handlePaste).
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
        // Pasting over a selection replaces it (one undo step; undo of a
        // paste-then-selection-paste restores the whole original text).
        // The removal runs BEFORE the path-space check below: the check
        // inspects the character before the INSERTION point, which after
        // a selection replace is the selection's start, not the live
        // cursor a forward selection leaves behind.
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
        // At column 0 of the first line backspace is a no-op (TS parity).
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
        // decode happens before the per-char filter, so the newline
        // survives instead of leaking "[106;5u" into the editor.
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
        // The argument position at the prompt start: command + partial.
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
        // The command-name position is not an argument context.
        e.set_text("/model");
        assert_eq!(e.picker_argument_context(), None);
        // A plain token is no context at all.
        e.set_text("hello there");
        assert_eq!(e.picker_argument_context(), None);
        // Other commands report their names; the caller picks the
        // picker-backed ones.
        e.set_text("/export ht");
        assert_eq!(
            e.picker_argument_context(),
            Some(("export".to_string(), "ht".to_string()))
        );
    }

    #[test]
    fn deleting_to_an_empty_prompt_clears_the_parked_request() {
        // `./` + Tab parks a forced completion request (no menu until the
        // queue drains). Deleting back to the empty prompt must cancel the
        // parked request too, not just the open menu: otherwise the parked
        // request materializes the whole-cwd dropdown on an empty prompt.
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

    /// The session's Esc guard treats the parked-request window (Tab
    /// queued a request the host loop materializes at the next idle
    /// tick) as an open menu: no dropdown is visible yet, so
    /// `has_pending_autocomplete` is what the guard tests, and a cancel
    /// there must stop the request from ever opening.
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
        // Whitespace after the cursor still counts as the argument end.
        e.set_text("/mcp lin ");
        assert_eq!(
            e.picker_argument_context(),
            Some(("mcp".to_string(), "lin ".to_string()))
        );
    }

    /// Applying from the picker clears the editor (the command is
    /// fulfilled), so draft text on a later line must stop the Tab
    /// interception: opening the picker there would silently discard the
    /// draft on apply. Whitespace-only later lines do not block it.
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
        // Tab on an empty prompt must not open a completion menu: the
        // forced pass would list the whole cwd (junk entries like a
        // `.claude` directory), with no anchor token to complete.
        let mut e = ed();
        e.handle_input("tab");
        e.materialize_autocomplete();
        assert!(!e.is_showing_autocomplete(), "no dropdown on empty Tab");
        // Whitespace-only prompts are the same empty prompt.
        e.handle_input(" ");
        e.handle_input(" ");
        e.handle_input("tab");
        e.materialize_autocomplete();
        assert!(!e.is_showing_autocomplete(), "no dropdown on blank Tab");
        // A typed token still completes on Tab (the slash-name context).
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

    /// TS `CustomEditor.isCursorAtEnd`: the move-below-prompt hook fires
    /// only from the last logical line's end — the common just-typed
    /// position (and the empty prompt), never mid-line or above the last
    /// line.
    #[test]
    fn is_cursor_at_end_tracks_the_last_lines_end() {
        // The empty prompt is at the end (col 0 of the empty last line).
        let mut e = ed();
        assert!(e.is_cursor_at_end());
        // Mid-line on the only line: not at the end.
        e.set_text("hello");
        e.handle_input("left");
        assert!(!e.is_cursor_at_end());
        // Back to the line end: at the end again.
        e.handle_input("right");
        assert!(e.is_cursor_at_end());
        // The end of a non-last line: not at the end.
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
        // The last line's end: at the end.
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

    /// One paste is one undo unit (TS `handlePaste` pushes a single undo
    /// snapshot before inserting): one undo removes the whole paste — the
    /// collapsed marker AND the stored content — never a fragment.
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
        // The same holds for a small inline paste: one undo, whole text.
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

    /// The hidden bang prefix (TS `getHiddenTextPrefixLength`): the prompt
    /// renders it in place, Home lands after it, and the cursor cannot
    /// step or word-skip into it.
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

    /// Backspacing the line down to its bare prefix clears the prompt (TS
    /// `handleBackspace`'s `lineStartCol` branch): the bang prefix
    /// included, so the editor returns to the plain `> ` prompt.
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

    /// The `!!` prefix hides two characters and the prompt width grows to
    /// three (the layout wraps the display line, not the raw one).
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

    // ---- redo / doc motion / transpose (prompt-editor-keybinds) ---------

    /// Undo then redo round-trips a typed word.
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

    /// A paste undo then redo: undo removes the whole paste, redo restores
    /// it (the operator's paste->undo->redo family).
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
        // The mac Cmd keys arrive as the super modifier: the same family.
        e.handle_input("super+z");
        assert_eq!(e.get_text(), "draft ");
        e.handle_input("super+shift+z");
        assert_eq!(e.get_text(), "draft pasted");
    }

    /// Any new edit clears the redo history.
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
        // The redo stack is empty: the redo press did nothing.
        assert_eq!(e.get_text(), "c");
    }

    /// Ctrl+Home / Ctrl+End jump to the buffer edges; the mac
    /// super+up/down aliases land the same way.
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

    /// Ctrl+Up / Ctrl+Down move one blank-line-separated paragraph.
    #[test]
    fn paragraph_motions_skip_blank_lines() {
        let mut e = ed();
        e.set_text("p1 line one\np1 line two\n\np2 line one\np2 line two");
        // From inside paragraph 1: up lands at its start, down at its end.
        e.set_cursor_for_tests(1, 11);
        e.handle_input("ctrl+up");
        assert_eq!(e.get_cursor(), (0, 0));
        e.handle_input("ctrl+down");
        assert_eq!(e.get_cursor(), (1, 11));
        // Already at the paragraph's end: down goes to the next
        // paragraph's end, up to the current paragraph's start, and a
        // second up to the previous paragraph's start.
        e.handle_input("ctrl+down");
        assert_eq!(e.get_cursor(), (4, 11));
        e.handle_input("ctrl+up");
        assert_eq!(e.get_cursor(), (3, 0));
        e.handle_input("ctrl+up");
        assert_eq!(e.get_cursor(), (0, 0));
    }

    /// Ctrl+T transposes the characters around the cursor, readline-style.
    #[test]
    fn transpose_swaps_around_the_cursor() {
        let mut e = ed();
        e.set_text("abdc");
        // Cursor between the d/c typo: the pair swaps.
        e.set_cursor_for_tests(0, 3);
        e.handle_input("ctrl+t");
        assert_eq!(e.get_text(), "abcd");
        assert_eq!(e.get_cursor(), (0, 4));
        // At the line end, the last two swap (readline's behavior).
        e.set_cursor_for_tests(0, 4);
        e.handle_input("ctrl+t");
        assert_eq!(e.get_text(), "abdc");
        // Undo restores the previous state in one press.
        e.handle_input("ctrl+-");
        assert_eq!(e.get_text(), "abcd");
    }
}
