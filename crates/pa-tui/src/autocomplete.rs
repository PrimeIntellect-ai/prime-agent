//! Autocomplete: provider contract, suggestion state, and selection
//! list rendering (the interactive agent view's subset: slash-command
//! and file/path completion with a select list, plus the `@` fuzzy
//! file search — a parallel walk on a background thread).

use std::collections::{HashMap, HashSet};

use crate::fuzzy::fuzzy_filter;
use crate::width::str_width;
use crate::{Line, Span};
use pa_types::slash_commands::SlashCommandRegistry;

mod fuzzy_file_search;
pub use fuzzy_file_search::FileSearch;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionItem {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    /// The dynamic command's source label (`#user`, `#project`, …), a
    /// muted trailing segment of the menu row.
    pub source_tag: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuggestionKind {
    SlashCommand,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Suggestions {
    pub prefix: String,
    pub kind: Option<SuggestionKind>,
    pub items: Vec<CompletionItem>,
}

/// A suggestion lookup: computed inline, or a background `@` file
/// search (only the fuzzy file walk is slow enough to need it).
#[derive(Debug)]
pub enum SuggestionLookup {
    Ready(Suggestions),
    Searching(FileSearch),
}

/// Result of applying a completion to the editor buffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionResult {
    pub lines: Vec<String>,
    pub cursor_line: usize,
    pub cursor_col: usize,
}

/// Provider contract mirroring TS `AutocompleteProvider` (synchronous).
pub trait AutocompleteProvider: Send {
    fn get_suggestions(
        &self,
        lines: &[String],
        cursor_line: usize,
        cursor_col: usize,
        force: bool,
    ) -> Option<SuggestionLookup>;
    fn apply_completion(
        &self,
        lines: &[String],
        cursor_line: usize,
        cursor_col: usize,
        item: &CompletionItem,
        prefix: &str,
    ) -> CompletionResult;
    fn should_trigger_file_completion(
        &self,
        _lines: &[String],
        _cursor_line: usize,
        _cursor_col: usize,
    ) -> bool {
        true
    }
    /// Replace the hidden-command set (the model-eligibility filter); a
    /// default no-op for providers without command listings.
    fn set_hidden_commands(&mut self, _hidden: std::collections::HashSet<String>) {}
    /// Replace the session's `skill:` commands. A default no-op for
    /// providers without command listings.
    fn set_skill_commands(&mut self, _skills: Vec<SlashCommandEntry>) {}
    /// Replace one command's argument completions; a default no-op for
    /// providers without argument completions.
    fn set_argument_completions(&mut self, _command: &'static str, _items: Vec<CompletionItem>) {}
}

/// Slash-command context: which part of a `/command args` line the cursor is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlashKind {
    /// The cursor is in the `/name` token.
    Name,
    /// The cursor is in the argument text of a recognized command token.
    Argument,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlashContext {
    pub kind: SlashKind,
    /// The text being completed: the command token including `/`, or the
    /// argument text after the separator.
    pub prefix: String,
    /// The command name (argument context only).
    pub command_name: Option<String>,
    pub at_prompt_start: bool,
}

/// Detect the active slash command context: line 0 with a slash at the trimmed start
/// is the command position; any other position completes a `/name` token mid-line.
#[must_use]
pub fn get_slash_command_context(
    lines: &[String],
    cursor_line: usize,
    cursor_col: usize,
) -> Option<SlashContext> {
    let line: Vec<char> = lines.get(cursor_line)?.chars().collect();
    let before: Vec<char> = line[..cursor_col.min(line.len())].to_vec();
    let trimmed_start: String = before.iter().skip_while(|c| c.is_whitespace()).collect();
    if cursor_line == 0 && trimmed_start.starts_with('/') {
        let trimmed: Vec<char> = trimmed_start.chars().collect();
        let separator_index = trimmed.iter().position(|c| *c == ' ' || *c == '\t');
        let command_token: Vec<char> = match separator_index {
            Some(index) => trimmed[..index].to_vec(),
            None => trimmed.clone(),
        };
        if command_token[1..].contains(&'/') {
            return None;
        }
        return match separator_index {
            None => Some(SlashContext {
                kind: SlashKind::Name,
                prefix: command_token.iter().collect(),
                command_name: None,
                at_prompt_start: true,
            }),
            Some(index) => {
                let command_name: String = command_token[1..].iter().collect();
                if command_name.is_empty() {
                    return None;
                }
                Some(SlashContext {
                    kind: SlashKind::Argument,
                    prefix: trimmed[index + 1..].iter().collect(),
                    command_name: Some(command_name),
                    at_prompt_start: true,
                })
            }
        };
    }
    // Anywhere else: a `/token` at the last whitespace boundary.
    let token_start = before
        .iter()
        .rposition(|c| *c == ' ' || *c == '\t')
        .map_or(0, |index| index + 1);
    let prefix: String = before[token_start..].iter().collect();
    if !prefix.starts_with('/') || prefix.chars().skip(1).any(|c| c == '/') {
        return None;
    }
    Some(SlashContext {
        kind: SlashKind::Name,
        prefix,
        command_name: None,
        at_prompt_start: false,
    })
}

/// Delimiters that end a path token.
const PATH_DELIMITERS: [char; 5] = [' ', '\t', '"', '\'', '='];

fn is_path_delimiter(c: char) -> bool {
    PATH_DELIMITERS.contains(&c)
}

/// The start index of the last unclosed `"` in the text.
fn find_unclosed_quote_start(text: &[char]) -> Option<usize> {
    let mut in_quotes = false;
    let mut quote_start = 0usize;
    for (index, c) in text.iter().enumerate() {
        if *c == '"' {
            in_quotes = !in_quotes;
            if in_quotes {
                quote_start = index;
            }
        }
    }
    in_quotes.then_some(quote_start)
}

/// True when the token at `index` begins at a delimiter boundary.
fn is_token_start(text: &[char], index: usize) -> bool {
    index == 0 || is_path_delimiter(text[index - 1])
}

/// An unterminated quoted token from its opening quote (`@"…` or `"…`).
fn extract_quoted_prefix(text: &[char]) -> Option<String> {
    let quote_start = find_unclosed_quote_start(text)?;
    if quote_start > 0 && text[quote_start - 1] == '@' {
        if !is_token_start(text, quote_start - 1) {
            return None;
        }
        return Some(text[quote_start - 1..].iter().collect());
    }
    if !is_token_start(text, quote_start) {
        return None;
    }
    Some(text[quote_start..].iter().collect())
}

/// Split a path prefix into its raw path and prefix flags (TS
/// `parsePathPrefix`).
fn parse_path_prefix(prefix: &str) -> (String, bool, bool) {
    if let Some(raw) = prefix.strip_prefix("@\"") {
        (raw.to_string(), true, true)
    } else if let Some(raw) = prefix.strip_prefix('"') {
        (raw.to_string(), false, true)
    } else if let Some(raw) = prefix.strip_prefix('@') {
        (raw.to_string(), true, false)
    } else {
        (prefix.to_string(), false, false)
    }
}

/// Expand `~` and `~/…` to the home directory.
fn expand_home_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        let home = home_dir();
        let expanded = home.join(rest);
        if path.ends_with('/') && !expanded.to_string_lossy().ends_with('/') {
            expanded.to_string_lossy().to_string() + "/"
        } else {
            expanded.to_string_lossy().to_string()
        }
    } else if path == "~" {
        home_dir().to_string_lossy().to_string()
    } else {
        path.to_string()
    }
}

/// The home directory (`HOME`, else the Windows profile chain).
fn home_dir() -> std::path::PathBuf {
    pa_types::platform::home_dir().unwrap_or_default()
}

/// The `@`-attachment token at the cursor: the token feeds the fuzzy
/// file search below the session cwd (or the typed scope).
fn extract_at_prefix(text: &[char]) -> Option<String> {
    if let Some(quoted) = extract_quoted_prefix(text) {
        if quoted.starts_with("@\"") {
            return Some(quoted);
        }
    }
    let token_start = text
        .iter()
        .rposition(|c| is_path_delimiter(*c))
        .map_or(0, |index| index + 1);
    if text.get(token_start) == Some(&'@') {
        return Some(text[token_start..].iter().collect());
    }
    None
}

/// The path token at the cursor. Explicit requests (`force`) take any
/// token; natural triggers only take tokens that look like paths.
fn extract_path_prefix(text: &[char], force_extract: bool) -> Option<String> {
    if let Some(quoted) = extract_quoted_prefix(text) {
        return Some(quoted);
    }
    let delimiter_index = text.iter().rposition(|c| is_path_delimiter(*c));
    let path_prefix: String = match delimiter_index {
        Some(index) => text[index + 1..].iter().collect(),
        None => text.iter().collect(),
    };
    if force_extract {
        return Some(path_prefix);
    }
    if path_prefix.contains('/') || path_prefix.starts_with('.') || path_prefix.starts_with("~/") {
        return Some(path_prefix);
    }
    if path_prefix.is_empty() && text.last() == Some(&' ') {
        return Some(path_prefix);
    }
    None
}

/// Quote a completion value when the prefix was quoted or the path has
/// spaces (TS `buildCompletionValue`).
fn build_completion_value(path: &str, is_at_prefix: bool, is_quoted_prefix: bool) -> String {
    let needs_quotes = is_quoted_prefix || path.contains(' ');
    let prefix = if is_at_prefix { "@" } else { "" };
    if !needs_quotes {
        return format!("{prefix}{path}");
    }
    format!("{prefix}\"{path}\"")
}

/// Selection state for the autocomplete dropdown.
#[derive(Debug, Clone)]
pub struct AutocompleteState {
    pub items: Vec<CompletionItem>,
    pub selected_index: usize,
    pub max_visible: usize,
    pub prefix: String,
    pub kind: Option<SuggestionKind>,
    pub forced: bool,
}

impl AutocompleteState {
    #[must_use]
    pub fn new(
        items: Vec<CompletionItem>,
        max_visible: usize,
        prefix: String,
        kind: Option<SuggestionKind>,
    ) -> Self {
        Self {
            items,
            selected_index: 0,
            max_visible: max_visible.clamp(3, 20),
            prefix,
            kind,
            forced: false,
        }
    }

    pub fn set_selected_index(&mut self, index: usize) {
        if !self.items.is_empty() {
            self.selected_index = index.min(self.items.len() - 1);
        }
    }

    pub fn move_up(&mut self) {
        if self.items.is_empty() {
            return;
        }
        self.selected_index = if self.selected_index == 0 {
            self.items.len() - 1
        } else {
            self.selected_index - 1
        };
    }

    pub fn move_down(&mut self) {
        if self.items.is_empty() {
            return;
        }
        self.selected_index = if self.selected_index == self.items.len() - 1 {
            0
        } else {
            self.selected_index + 1
        };
    }

    #[must_use]
    pub fn selected_item(&self) -> Option<CompletionItem> {
        self.items.get(self.selected_index).cloned()
    }

    /// Best match index: exact value match, else first prefix match, else none.
    #[must_use]
    pub fn best_match_index(&self, prefix: &str) -> Option<usize> {
        if prefix.is_empty() {
            return None;
        }
        let mut first_prefix = None;
        for (i, item) in self.items.iter().enumerate() {
            if item.value == prefix {
                return Some(i);
            }
            if first_prefix.is_none() && item.value.starts_with(prefix) {
                first_prefix = Some(i);
            }
        }
        first_prefix
    }

    /// Render the dropdown through the inline menu panel — the same
    /// grammar the `/model` picker and the `/mcp` view render with.
    #[must_use]
    pub fn render(&self, theme: &crate::theme::Theme, width: usize) -> Vec<Line> {
        if self.items.is_empty() {
            return vec![crate::menu_panel::no_match_row(
                theme,
                width,
                "No matching commands",
            )];
        }
        let start = self
            .selected_index
            .saturating_sub(self.max_visible / 2)
            .min(self.items.len().saturating_sub(self.max_visible));
        let end = (start + self.max_visible).min(self.items.len());
        let mut lines: Vec<Line> = Vec::new();
        for (index, item) in self.items[start..end].iter().enumerate() {
            let index = start + index;
            let selected = index == self.selected_index;
            // The argument hint, then the source tag, both muted — TS colors the source
            // tag separately; this palette folds it into the muted trailing.
            let mut trailing = Vec::new();
            if let Some(hint) = item.argument_hint.as_deref() {
                trailing.push(crate::menu_panel::MenuSegment::muted(hint));
            }
            if let Some(tag) = item.source_tag.as_deref() {
                trailing.push(crate::menu_panel::MenuSegment::muted(tag));
            }
            lines.push(crate::menu_panel::menu_row(
                theme,
                width,
                vec![Span::raw(item.label.clone())],
                &trailing,
                selected,
            ));
        }
        if start > 0 || end < self.items.len() {
            lines.push(crate::menu_panel::scroll_row(
                theme,
                width,
                self.selected_index + 1,
                self.items.len(),
            ));
        }
        if let Some(description) = self
            .items
            .get(self.selected_index)
            .and_then(|item| item.description.as_deref())
            .filter(|d| !d.trim().is_empty())
        {
            let indent = if width >= 4 { "  " } else { "" };
            let content_width = (width.saturating_sub(str_width(indent) + 2)).max(1);
            lines.push(Vec::new());
            for line in crate::width::wrap_text(description, content_width) {
                let text: String = line.iter().map(|s| s.content.as_str()).collect();
                lines.push(vec![
                    Span::raw(indent.to_string()),
                    theme.fg_span(crate::theme::ThemeColor::Muted, format!("{text} ")),
                ]);
            }
        }
        lines
    }
}

/// File/path completion against the filesystem (the readdir-based
/// `getFileSuggestions` half of the TS combined provider).
pub struct PathCompletionProvider {
    pub base: std::path::PathBuf,
}

impl PathCompletionProvider {
    /// Directory entries matching the typed prefix: `~` expansion, root
    /// and `dir/` prefixes, case-insensitive matching, directories first.
    fn file_suggestions(&self, prefix: &str) -> Vec<CompletionItem> {
        let (raw_prefix, is_at_prefix, is_quoted_prefix) = parse_path_prefix(prefix);
        let expanded_prefix = expand_home_path(&raw_prefix);
        let is_root_prefix = raw_prefix.is_empty()
            || raw_prefix == "./"
            || raw_prefix == "../"
            || raw_prefix == "~"
            || raw_prefix == "~/"
            || raw_prefix == "/"
            || (is_at_prefix && raw_prefix.is_empty());
        let (search_dir, search_prefix): (std::path::PathBuf, String) =
            if is_root_prefix || raw_prefix.ends_with('/') {
                let dir = if raw_prefix.starts_with('~') || expanded_prefix.starts_with('/') {
                    std::path::PathBuf::from(&expanded_prefix)
                } else {
                    self.base.join(&expanded_prefix)
                };
                (dir, String::new())
            } else {
                // TS `basename`: a trailing `.`/`..` IS the file component (`basename("src/.")`
                // is `.`), unlike `Path::file_name`, which normalizes it away and mis-splits
                // the dot-name browse prefixes.
                let file = expanded_prefix
                    .rsplit('/')
                    .next()
                    .unwrap_or_default()
                    .to_string();
                let raw_dir = match expanded_prefix.rfind('/') {
                    Some(index) if index > 0 => std::path::PathBuf::from(&expanded_prefix[..index]),
                    Some(_) => std::path::PathBuf::from("/"),
                    None => self.base.clone(),
                };
                // Relative prefixes resolve against the base directory (TS joins
                // `basePath`); `~` and absolute prefixes stand alone.
                let dir = if raw_prefix.starts_with('~')
                    || raw_prefix.starts_with('/')
                    || raw_dir.is_absolute()
                {
                    raw_dir
                } else {
                    self.base.join(raw_dir)
                };
                (dir, file)
            };
        // Hidden entries list exactly when the anchor (the typed component after the last
        // `/`) is dot-typed (`.`, `.z`, `src/.h`, `~/.`) — the bash semantics: a directory
        // browse never surfaces the cwd's dotfiles (operator ruling 2026-09-25).
        let anchor = raw_prefix.rsplit('/').next().unwrap_or_default();
        let dot_anchor = anchor.starts_with('.');
        let Ok(entries) = std::fs::read_dir(&search_dir) else {
            return Vec::new();
        };
        let lower_search = search_prefix.to_lowercase();
        let mut suggestions = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.to_lowercase().starts_with(&lower_search) {
                continue;
            }
            if name.starts_with('.') && !dot_anchor {
                continue;
            }
            let full_path = entry.path();
            let is_directory = full_path.is_dir();
            let relative_path = display_relative_path(&raw_prefix, &name);
            let path_value = if is_directory {
                format!("{relative_path}/")
            } else {
                relative_path
            };
            let value = build_completion_value(&path_value, is_at_prefix, is_quoted_prefix);
            suggestions.push(CompletionItem {
                value,
                source_tag: None,
                label: if is_directory {
                    format!("{name}/")
                } else {
                    name
                },
                description: None,
                argument_hint: None,
            });
        }
        suggestions.sort_by(|a, b| {
            let a_dir = a.value.ends_with('/');
            let b_dir = b.value.ends_with('/');
            match (a_dir, b_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.label.to_lowercase().cmp(&b.label.to_lowercase()),
            }
        });
        suggestions
    }
}

/// Rebuild the completion path from the typed display prefix and the entry
/// name (TS `getFileSuggestions` relativePath logic).
fn display_relative_path(display_prefix: &str, name: &str) -> String {
    if display_prefix.ends_with('/') {
        format!("{display_prefix}{name}")
    } else if display_prefix.contains('/') {
        if let Some(dir) = display_prefix.rsplit_once('/').map(|(dir, _)| dir) {
            if display_prefix.starts_with("~/") {
                if dir == "~" {
                    format!("~/{name}")
                } else {
                    format!("{dir}/{name}")
                }
            } else if display_prefix.starts_with('/') {
                if dir.is_empty() {
                    format!("/{name}")
                } else {
                    format!("{dir}/{name}")
                }
            } else {
                format!("{dir}/{name}")
            }
        } else {
            name.to_string()
        }
    } else if display_prefix.starts_with('~') {
        format!("~/{name}")
    } else {
        name.to_string()
    }
}

/// Apply a file/path completion: replace the prefix token with the item value, adjusting
/// for quoted prefixes, directories, and the `@` branch's trailing space.
fn apply_file_completion(
    lines: &[String],
    cursor_line: usize,
    cursor_col: usize,
    item: &CompletionItem,
    prefix: &str,
) -> CompletionResult {
    let line: Vec<char> = lines[cursor_line].chars().collect();
    let prefix_len = prefix.chars().count();
    let before_prefix: String = line[..cursor_col.saturating_sub(prefix_len).min(line.len())]
        .iter()
        .collect();
    let after_cursor: String = line[cursor_col.min(line.len())..].iter().collect();
    let is_quoted_prefix = prefix.starts_with('"') || prefix.starts_with("@\"");
    let adjusted_after_cursor =
        if is_quoted_prefix && item.value.ends_with('"') && after_cursor.starts_with('"') {
            after_cursor.chars().skip(1).collect()
        } else {
            after_cursor
        };
    let is_directory = item.label.ends_with('/');
    // TS `applyCompletion`'s `@` branch: a file leaves a trailing space so the next
    // word starts clean, a directory keeps the token open for further completion.
    let suffix = if prefix.starts_with('@') && !is_directory {
        " "
    } else {
        ""
    };
    let has_trailing_quote = item.value.ends_with('"');
    let cursor_offset = if is_directory && has_trailing_quote {
        item.value.chars().count() - 1
    } else {
        item.value.chars().count()
    };
    let new_line = format!(
        "{before_prefix}{}{suffix}{adjusted_after_cursor}",
        item.value
    );
    let mut new_lines = lines.to_vec();
    new_lines[cursor_line] = new_line;
    CompletionResult {
        lines: new_lines,
        cursor_line,
        cursor_col: before_prefix.chars().count() + cursor_offset + suffix.chars().count(),
    }
}

/// One slash command in the completion vocabulary.
#[derive(Debug, Clone)]
pub struct SlashCommandEntry {
    pub name: String,
    pub aliases: Vec<String>,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    pub takes_argument: bool,
    /// The source label (`#user`, `#project`, …) for dynamic commands.
    pub source_tag: Option<String>,
}

impl SlashCommandEntry {
    /// The fuzzy search text: the name plus its aliases.
    fn search_text(&self) -> String {
        let mut text = self.name.clone();
        for alias in &self.aliases {
            text.push(' ');
            text.push_str(alias);
        }
        text
    }
}

/// The source label of a command row: the scope prefix (`user`/`project`/`temporary`), the source
/// string itself for package-registry (`npm:…`) sources, `builtin` for builtins. The TS
/// ladder's git-URL branch is unreachable on this wire (the skills loader only emits `local`).
fn autocomplete_source_tag(source_info: &serde_json::Value) -> Option<String> {
    // TS guards the whole ladder with `if (!sourceInfo) return undefined`:
    // an absent source info gets no tag (the row renders bare).
    if source_info.is_null() {
        return None;
    }
    let scope_prefix = match source_info.get("scope").and_then(serde_json::Value::as_str) {
        Some("user") => "user",
        Some("project") => "project",
        _ => "temporary",
    };
    let source = source_info
        .get("source")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if source == "builtin" {
        return Some("builtin".to_string());
    }
    if source == "auto" || source == "local" || source == "cli" {
        return Some(scope_prefix.to_string());
    }
    if let Some(spec) = source.strip_prefix("npm:") {
        return Some(format!("{scope_prefix}:npm:{spec}"));
    }
    Some(scope_prefix.to_string())
}

/// The `#`-prefixed label the menu row renders (TS `getAutocompleteSourceLabel`).
fn autocomplete_source_label(source_info: &serde_json::Value) -> Option<String> {
    autocomplete_source_tag(source_info).map(|tag| format!("#{tag}"))
}

/// The argument hint every skill menu row carries: a skill invocation
/// always wants the user's request text.
pub const SKILL_ARGUMENT_HINT: &str = "your request";

/// The `skill:` commands of a daemon `get_commands` response: the name stays the wire
/// form (`skill:<name>`), and the entry always takes an argument (a bare submission
/// would expand into the protocol with no task text).
pub fn skill_command_entries(commands: &serde_json::Value) -> Vec<SlashCommandEntry> {
    let Some(entries) = commands
        .get("commands")
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    entries
        .iter()
        .filter(|entry| entry.get("source").and_then(serde_json::Value::as_str) == Some("skill"))
        .filter_map(|entry| {
            let name = entry.get("name").and_then(serde_json::Value::as_str)?;
            Some(SlashCommandEntry {
                name: name.to_string(),
                aliases: Vec::new(),
                description: entry
                    .get("description")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                argument_hint: Some(SKILL_ARGUMENT_HINT.to_string()),
                takes_argument: true,
                source_tag: entry.get("sourceInfo").and_then(autocomplete_source_label),
            })
        })
        .collect()
}

/// The installed provider: fuzzy-filtered slash-command completion from
/// the builtin registry plus file/path completion.
pub struct CombinedAutocompleteProvider {
    commands: Vec<SlashCommandEntry>,
    /// The session's `skill:<name>` commands: appended after the
    /// builtins, replaced whole on every catalog refresh.
    skill_commands: Vec<SlashCommandEntry>,
    /// Commands the current model filters out of the listing (TS drops
    /// `/fast` when the model is not fast-mode-eligible).
    hidden: std::collections::HashSet<String>,
    /// Per-command argument completions: the items offered at the
    /// command's argument position (e.g. the `/tier` tier choices).
    arguments: std::collections::HashMap<&'static str, Vec<CompletionItem>>,
    paths: PathCompletionProvider,
}

impl CombinedAutocompleteProvider {
    #[must_use]
    pub fn builtin_entries() -> Vec<SlashCommandEntry> {
        SlashCommandRegistry::builtin()
            .all()
            .iter()
            .map(|command| SlashCommandEntry {
                name: command.name.to_string(),
                aliases: command.aliases.iter().map(ToString::to_string).collect(),
                description: Some(command.description.to_string()),
                argument_hint: command.argument_hint.map(str::to_string),
                takes_argument: command.takes_argument,
                source_tag: None,
            })
            .collect()
    }

    #[must_use]
    pub fn from_registry(base: std::path::PathBuf) -> Self {
        Self::new(Self::builtin_entries(), base)
    }

    /// Build the provider from an explicit command list (the reply composer's
    /// session-owned subset plus its view commands).
    #[must_use]
    pub fn new(commands: Vec<SlashCommandEntry>, base: std::path::PathBuf) -> Self {
        Self {
            commands,
            skill_commands: Vec::new(),
            hidden: HashSet::default(),
            arguments: HashMap::default(),
            paths: PathCompletionProvider { base },
        }
    }

    /// Replace the hidden-command set (the caller recomputes model
    /// eligibility on every model switch).
    pub fn set_hidden_commands(&mut self, hidden: std::collections::HashSet<String>) {
        self.hidden = hidden;
    }

    /// Replace the session's `skill:` commands, appended after the
    /// builtins; the fetch replaces the whole list, never merges.
    pub fn set_skill_commands(&mut self, skills: Vec<SlashCommandEntry>) {
        self.skill_commands = skills;
    }

    /// Replace one command's argument completions (TS
    /// `command.getArgumentCompletions`, e.g. the `/tier` tier choices).
    pub fn set_argument_completions(&mut self, command: &'static str, items: Vec<CompletionItem>) {
        self.arguments.insert(command, items);
    }

    /// The slash-name suggestions for a typed prefix (fuzzy filter over `name + aliases`,
    /// registry order preserved on ties; the session's skill commands follow the builtins).
    fn slash_suggestions(&self, prefix: &str) -> Vec<CompletionItem> {
        let query = prefix.strip_prefix('/').unwrap_or(prefix);
        let commands: Vec<&SlashCommandEntry> = self
            .commands
            .iter()
            .chain(self.skill_commands.iter())
            .filter(|command| !self.hidden.contains(&command.name))
            .collect();
        let scored = fuzzy_filter(&commands, query, |command| command.search_text());
        scored
            .into_iter()
            .map(|command| CompletionItem {
                value: command.name.clone(),
                label: command.name.clone(),
                description: command.description.clone(),
                argument_hint: command.argument_hint.clone(),
                source_tag: command.source_tag.clone(),
            })
            .collect()
    }

    /// Apply a slash-command completion: argument-taking commands complete into the
    /// parameter position; bare commands keep no trailing separator, so a following submit
    /// runs them as typed.
    fn apply_slash_completion(
        &self,
        lines: &[String],
        cursor_line: usize,
        cursor_col: usize,
        item: &CompletionItem,
        prefix: &str,
    ) -> CompletionResult {
        let line: Vec<char> = lines[cursor_line].chars().collect();
        let prefix_len = prefix.chars().count();
        let before_prefix: String = line[..cursor_col.saturating_sub(prefix_len).min(line.len())]
            .iter()
            .collect();
        let after_cursor: String = line[cursor_col.min(line.len())..].iter().collect();
        let is_quoted_prefix = prefix.starts_with('"') || prefix.starts_with("@\"");
        let has_leading_quote_after_cursor = after_cursor.starts_with('"');
        let has_trailing_quote_in_item = item.value.ends_with('"');
        let adjusted_after_cursor =
            if is_quoted_prefix && has_trailing_quote_in_item && has_leading_quote_after_cursor {
                after_cursor.chars().skip(1).collect::<String>()
            } else {
                after_cursor
            };
        let takes_argument = self
            .commands
            .iter()
            .chain(self.skill_commands.iter())
            .find(|command| command.name == item.value)
            .is_some_and(|command| command.takes_argument);
        let has_separator_after_cursor =
            adjusted_after_cursor.starts_with(' ') || adjusted_after_cursor.starts_with('\t');
        let separator = if !takes_argument || has_separator_after_cursor {
            ""
        } else {
            " "
        };
        let new_line = format!(
            "{before_prefix}/{}{separator}{adjusted_after_cursor}",
            item.value
        );
        let mut new_lines = lines.to_vec();
        new_lines[cursor_line] = new_line;
        CompletionResult {
            lines: new_lines,
            cursor_line,
            cursor_col: before_prefix.chars().count()
                + item.value.chars().count()
                + if takes_argument { 2 } else { 1 },
        }
    }
}

impl AutocompleteProvider for CombinedAutocompleteProvider {
    fn set_hidden_commands(&mut self, hidden: std::collections::HashSet<String>) {
        self.hidden = hidden;
    }

    fn set_skill_commands(&mut self, skills: Vec<SlashCommandEntry>) {
        CombinedAutocompleteProvider::set_skill_commands(self, skills);
    }

    fn set_argument_completions(&mut self, command: &'static str, items: Vec<CompletionItem>) {
        CombinedAutocompleteProvider::set_argument_completions(self, command, items);
    }

    fn get_suggestions(
        &self,
        lines: &[String],
        cursor_line: usize,
        cursor_col: usize,
        force: bool,
    ) -> Option<SuggestionLookup> {
        let line: Vec<char> = lines.get(cursor_line)?.chars().collect();
        let before: Vec<char> = line[..cursor_col.min(line.len())].to_vec();
        if let Some(at_prefix) = extract_at_prefix(&before) {
            return Some(SuggestionLookup::Searching(fuzzy_file_search::spawn(
                &self.paths.base,
                at_prefix,
            )));
        }
        if !force {
            if let Some(context) = get_slash_command_context(lines, cursor_line, cursor_col) {
                match context.kind {
                    SlashKind::Name => {
                        let items = self.slash_suggestions(&context.prefix);
                        if items.is_empty() {
                            return None;
                        }
                        return Some(SuggestionLookup::Ready(Suggestions {
                            prefix: context.prefix,
                            kind: Some(SuggestionKind::SlashCommand),
                            items,
                        }));
                    }
                    // Argument items answer at the argument position (filtered by the typed
                    // term); commands without items and terms with no match answer nothing
                    // (the force-triggered path completion is the file surface there).
                    SlashKind::Argument => {
                        let command = context.command_name.as_deref()?;
                        let items = self.arguments.get(command)?;
                        let term = context.prefix.trim().to_lowercase();
                        let matches: Vec<CompletionItem> = items
                            .iter()
                            .filter(|item| term.is_empty() || item.value.starts_with(&term))
                            .cloned()
                            .collect();
                        if matches.is_empty() {
                            return None;
                        }
                        return Some(SuggestionLookup::Ready(Suggestions {
                            prefix: context.prefix.clone(),
                            kind: Some(SuggestionKind::SlashCommand),
                            items: matches,
                        }));
                    }
                }
            }
        }
        let prefix = extract_path_prefix(&before, force)?;
        let items = self.paths.file_suggestions(&prefix);
        if items.is_empty() {
            return None;
        }
        Some(SuggestionLookup::Ready(Suggestions {
            prefix,
            kind: Some(SuggestionKind::File),
            items,
        }))
    }

    fn apply_completion(
        &self,
        lines: &[String],
        cursor_line: usize,
        cursor_col: usize,
        item: &CompletionItem,
        prefix: &str,
    ) -> CompletionResult {
        let is_slash = get_slash_command_context(lines, cursor_line, cursor_col)
            .is_some_and(|context| context.kind == SlashKind::Name && context.prefix == prefix);
        // TS `applyCompletion` finds the item over its whole command list
        // (builtins and skills share one array), so a `skill:` item applies
        // through the slash path — the line keeps its leading `/`.
        if is_slash
            && self
                .commands
                .iter()
                .chain(self.skill_commands.iter())
                .any(|command| command.name == item.value)
        {
            return self.apply_slash_completion(lines, cursor_line, cursor_col, item, prefix);
        }
        apply_file_completion(lines, cursor_line, cursor_col, item, prefix)
    }

    fn should_trigger_file_completion(
        &self,
        lines: &[String],
        cursor_line: usize,
        cursor_col: usize,
    ) -> bool {
        get_slash_command_context(lines, cursor_line, cursor_col)
            .is_none_or(|context| context.kind != SlashKind::Name)
    }
}
#[cfg(test)]
mod tests;
