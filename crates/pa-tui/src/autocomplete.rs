//! Autocomplete: provider contract, suggestion state, and selection list
//! rendering ported from `packages/tui/src/autocomplete.ts` +
//! `components/select-list.ts` (the subset the interactive agent view uses:
//! slash-command and file/path completion with a select list).

use crate::fuzzy::fuzzy_filter;
use crate::width::str_width;
use crate::{Line, Span};
use pa_types::slash_commands::SlashCommandRegistry;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionItem {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    /// The source label of a dynamic command (`#user`, `#project`, …; TS
    /// `sourceTag`, from `getAutocompleteSourceLabel`). Rendered as a
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
    ) -> Option<Suggestions>;
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
    /// Replace the hidden-command set (the model-eligibility filter). A
    /// default no-op so providers without command listings keep working.
    fn set_hidden_commands(&mut self, _hidden: std::collections::HashSet<String>) {}
    /// Replace the session's `skill:` commands (TS appends them to the
    /// command list). A default no-op for providers without command
    /// listings.
    fn set_skill_commands(&mut self, _skills: Vec<SlashCommandEntry>) {}
}

/// Slash-command context (port of slash-command-context.ts): which part of
/// a `/command args` line the cursor is in.
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
    /// The text being completed: the command token including `/` (name
    /// context) or the argument text after the separator (argument context).
    pub prefix: String,
    /// The command name (argument context only).
    pub command_name: Option<String>,
    pub at_prompt_start: bool,
}

/// Detect the active slash command context at the cursor. Line 0 with a
/// slash at the trimmed start is the command position (name or argument);
/// any other position completes a `/name` token mid-line (name only).
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

/// Delimiters that end a path token (TS `PATH_DELIMITERS`).
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

/// The `@`-attachment token at the cursor, when one is being typed (TS
/// `extractAtPrefix`). The TS product backs it with a fuzzy `fd` search;
/// this build has no `fd` dependency, so `@` tokens yield no suggestions —
/// the same behavior as the TS product without `fd` on PATH.
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

/// The path token at the cursor (TS `extractPathPrefix`). Explicit requests
/// (`force`) take any token; natural triggers only take tokens that look
/// like paths.
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

/// Selection state for the autocomplete dropdown (port of `SelectList`).
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

    pub fn selected_item(&self) -> Option<CompletionItem> {
        self.items.get(self.selected_index).cloned()
    }

    /// Best match index: exact value match, else first prefix match, else none.
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

    /// Render the dropdown through the inline menu panel: the ONE menu
    /// component's rows (`›` marker, BOLD primary, soft selection band,
    /// right-aligned muted trailing), its status rows (the `(n/m)` scroll
    /// indicator, the no-match row), and the selected slash command's
    /// description block — the same grammar the `/model` picker and the
    /// `/mcp` view render with.
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
            // The trailing metadata (TS `renderMetadataItem`: the
            // argument hint, then the source tag, both muted here — the
            // menu grammar's one trailing style; TS colors the source
            // tag with `theme.sourceTag`, which this palette folds into
            // the muted trailing).
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
    /// Directory entries matching the typed prefix (TS `getFileSuggestions`):
    /// `~` expansion, root and `dir/` prefixes, case-insensitive matching,
    /// directories first.
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
                let file = std::path::Path::new(&expanded_prefix)
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_default();
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
        // The filename anchor the entries must complete: the typed
        // component after the last `/` of the prefix. Dot entries list
        // only when that anchor is an explicit dot prefix of a filename
        // (`.z`, `./.claude`, `src/.h`) — never for the directory
        // references `.`/`..` or an empty browse anchor: a directory
        // browse must not surface the cwd's dotfiles as completion
        // candidates (the operator's 2026-09-25 directive: the menu's
        // "useless stuff" starting with a `.claude` directory).
        let anchor = raw_prefix.rsplit('/').next().unwrap_or(raw_prefix);
        let dot_anchor = anchor.starts_with('.') && anchor != "." && anchor != "..";
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

/// Apply a file/path completion: replace the prefix token with the item
/// value, adjusting for quoted prefixes and directories (TS default and
/// argument branches).
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
    let has_trailing_quote = item.value.ends_with('"');
    let cursor_offset = if is_directory && has_trailing_quote {
        item.value.chars().count() - 1
    } else {
        item.value.chars().count()
    };
    let new_line = format!("{before_prefix}{}{adjusted_after_cursor}", item.value);
    let mut new_lines = lines.to_vec();
    new_lines[cursor_line] = new_line;
    CompletionResult {
        lines: new_lines,
        cursor_line,
        cursor_col: before_prefix.chars().count() + cursor_offset,
    }
}

/// One slash command in the completion vocabulary (TS `SlashCommand`).
#[derive(Debug, Clone)]
pub struct SlashCommandEntry {
    pub name: String,
    pub aliases: Vec<String>,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    pub takes_argument: bool,
    /// The source label (`#user`, `#project`, …) for dynamic commands
    /// (TS `sourceTag`).
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

/// The source label of a command row (TS `getAutocompleteSourceTag` +
/// `getAutocompleteSourceLabel`): the scope prefix (`user`/`project`/
/// `temporary`), with the source string itself for package-registry
/// (`npm:…`) sources; `builtin` stays `builtin`. The TS ladder's git-URL
/// branch is not reachable on this port's daemon wire — the skills
/// loader only emits `local` sources — so the scope prefix is the
/// fallback for any other source, exactly like the TS tail.
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

/// The `skill:` commands of a daemon `get_commands` response (TS
/// `createBaseAutocompleteProvider`'s skill list over
/// `connectionCommands.filter(source === "skill")`): the name stays the
/// wire form (`skill:<name>`), the description and the source label ride
/// along for the menu row.
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
                argument_hint: None,
                takes_argument: false,
                source_tag: entry.get("sourceInfo").and_then(autocomplete_source_label),
            })
        })
        .collect()
}

/// The installed provider: slash-command completion from the builtin
/// registry (fuzzy-filtered, like the TS `CombinedAutocompleteProvider`)
/// plus file/path completion.
pub struct CombinedAutocompleteProvider {
    commands: Vec<SlashCommandEntry>,
    /// The session's `skill:<name>` commands (TS
    /// `skillCommandList`): appended after the builtins, replaced whole
    /// on every command-catalog refresh.
    skill_commands: Vec<SlashCommandEntry>,
    /// Commands the current model filters out of the listing (TS
    /// `getAvailableCommands` drops `/fast` when the model is not
    /// fast-mode-eligible).
    hidden: std::collections::HashSet<String>,
    paths: PathCompletionProvider,
}

impl CombinedAutocompleteProvider {
    /// Build the provider from the shared builtin registry (pa-types).
    pub fn from_registry(base: std::path::PathBuf) -> Self {
        let commands = SlashCommandRegistry::builtin()
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
            .collect();
        Self {
            commands,
            skill_commands: Vec::new(),
            hidden: Default::default(),
            paths: PathCompletionProvider { base },
        }
    }

    /// Replace the hidden-command set (the caller recomputes model
    /// eligibility on every model switch).
    pub fn set_hidden_commands(&mut self, hidden: std::collections::HashSet<String>) {
        self.hidden = hidden;
    }

    /// Replace the session's `skill:` commands (TS
    /// `createBaseAutocompleteProvider` appends the skill list after the
    /// builtin commands; the fetch replaces the whole list, never
    /// merges).
    pub fn set_skill_commands(&mut self, skills: Vec<SlashCommandEntry>) {
        self.skill_commands = skills;
    }

    /// The slash-name suggestions for a typed prefix (fuzzy filter over
    /// `name + aliases`, registry order preserved on ties; the session's
    /// skill commands follow the builtins, TS list order).
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

    /// Apply a slash-command completion: argument-taking commands complete
    /// into the parameter position; bare commands complete without a
    /// trailing separator so a following submit runs them as typed.
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

    fn get_suggestions(
        &self,
        lines: &[String],
        cursor_line: usize,
        cursor_col: usize,
        force: bool,
    ) -> Option<Suggestions> {
        let line: Vec<char> = lines.get(cursor_line)?.chars().collect();
        let before: Vec<char> = line[..cursor_col.min(line.len())].to_vec();
        // `@`-attachment completion is fd-backed in the TS product; without
        // fd it yields nothing, and so does this build.
        if extract_at_prefix(&before).is_some() {
            return None;
        }
        if !force {
            if let Some(context) = get_slash_command_context(lines, cursor_line, cursor_col) {
                match context.kind {
                    SlashKind::Name => {
                        let items = self.slash_suggestions(&context.prefix);
                        if items.is_empty() {
                            return None;
                        }
                        return Some(Suggestions {
                            prefix: context.prefix,
                            kind: Some(SuggestionKind::SlashCommand),
                            items,
                        });
                    }
                    // The builtin registry carries no argument completions
                    // (model/effort/… selectors are per-command UIs this
                    // build does not have yet); other positions fall through
                    // to path completion.
                    SlashKind::Argument => return None,
                }
            }
        }
        let prefix = extract_path_prefix(&before, force)?;
        let items = self.paths.file_suggestions(&prefix);
        if items.is_empty() {
            return None;
        }
        Some(Suggestions {
            prefix,
            kind: Some(SuggestionKind::File),
            items,
        })
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
mod tests {
    use super::*;

    fn provider(base: &str) -> CombinedAutocompleteProvider {
        CombinedAutocompleteProvider::from_registry(std::path::PathBuf::from(base))
    }

    fn item(value: &str) -> CompletionItem {
        CompletionItem {
            value: value.to_string(),
            label: value.to_string(),
            description: None,
            argument_hint: None,
            source_tag: None,
        }
    }

    #[test]
    fn slash_context_matches_ts_positions() {
        // Name at the prompt start.
        let ctx = get_slash_command_context(&["/he".to_string()], 0, 3).unwrap();
        assert_eq!(ctx.kind, SlashKind::Name);
        assert_eq!(ctx.prefix, "/he");
        assert!(ctx.at_prompt_start);
        // Argument position carries the command name.
        let ctx = get_slash_command_context(&["/goal ship".to_string()], 0, 10).unwrap();
        assert_eq!(ctx.kind, SlashKind::Argument);
        assert_eq!(ctx.command_name.as_deref(), Some("goal"));
        assert_eq!(ctx.prefix, "ship");
        // Leading whitespace still counts as the command position.
        let ctx = get_slash_command_context(&["  /he".to_string()], 0, 5).unwrap();
        assert_eq!(ctx.prefix, "/he");
        // A second `/` inside the token kills the context.
        assert!(get_slash_command_context(&["/a/b".to_string()], 0, 4).is_none());
        // A mid-line `/token` completes without prompt-start status.
        let ctx = get_slash_command_context(&["run /he".to_string()], 0, 7).unwrap();
        assert_eq!(ctx.kind, SlashKind::Name);
        assert_eq!(ctx.prefix, "/he");
        assert!(!ctx.at_prompt_start);
        assert!(get_slash_command_context(&["plain".to_string()], 0, 5).is_none());
    }

    #[test]
    fn slash_suggestions_filter_fuzzily() {
        let provider = provider("/tmp");
        let suggestions = provider
            .get_suggestions(&["/se".to_string()], 0, 3, false)
            .expect("suggestions");
        assert_eq!(suggestions.kind, Some(SuggestionKind::SlashCommand));
        assert_eq!(suggestions.prefix, "/se");
        assert!(suggestions.items.iter().any(|i| i.value == "settings"));
        // Aliases join the search text: /think matches the effort command.
        let suggestions = provider
            .get_suggestions(&["/think".to_string()], 0, 6, false)
            .expect("suggestions");
        assert_eq!(suggestions.items[0].value, "effort");
        // The bare '/' shows the whole registry.
        let suggestions = provider
            .get_suggestions(&["/".to_string()], 0, 1, false)
            .expect("suggestions");
        assert_eq!(
            suggestions.items.len(),
            SlashCommandRegistry::builtin().all().len()
        );
    }

    #[test]
    fn hidden_commands_drop_rows_from_the_menu() {
        let mut provider = provider("/tmp");
        let visible = provider.get_suggestions(&["/f".to_string()], 0, 2, false);
        let items = visible.expect("suggestions").items;
        assert!(
            items.iter().any(|item| item.value == "fast"),
            "fast lists by default: {items:?}"
        );
        provider.set_hidden_commands(std::collections::HashSet::from(["fast".to_string()]));
        let visible = provider.get_suggestions(&["/f".to_string()], 0, 2, false);
        let items = visible.expect("suggestions").items;
        assert!(
            !items.iter().any(|item| item.value == "fast"),
            "hidden fast drops from the menu: {items:?}"
        );
    }

    #[test]
    fn slash_completion_applies_separator_by_argument() {
        let provider = provider("/tmp");
        // Argument-taking command: completes into the parameter position.
        let result = provider.apply_completion(&["/goa".to_string()], 0, 4, &item("goal"), "/goa");
        assert_eq!(result.lines[0], "/goal ");
        assert_eq!(result.cursor_col, 6);
        // Bare command: no trailing separator.
        let result =
            provider.apply_completion(&["/refi".to_string()], 0, 5, &item("refine"), "/refi");
        assert_eq!(result.lines[0], "/refine");
        assert_eq!(result.cursor_col, 7);
    }

    #[test]
    fn path_completion_lists_directories_first() {
        let dir = std::env::temp_dir().join("pa-tui-path-completion");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).expect("mkdir");
        std::fs::create_dir_all(dir.join("docs")).expect("mkdir");
        std::fs::write(dir.join("main.rs"), "fn main() {}").expect("write");
        let provider = provider(dir.to_str().unwrap());
        let suggestions = provider
            .get_suggestions(&["./ma".to_string()], 0, 4, false)
            .expect("suggestions");
        assert_eq!(suggestions.kind, Some(SuggestionKind::File));
        assert_eq!(suggestions.items.len(), 1);
        assert_eq!(suggestions.items[0].value, "./main.rs");
        // Directories first, both with trailing slashes.
        let suggestions = provider
            .get_suggestions(&["./".to_string()], 0, 3, false)
            .expect("suggestions");
        let values: Vec<&str> = suggestions.items.iter().map(|i| i.value.as_str()).collect();
        assert!(values.contains(&"./docs/"));
        assert!(values.contains(&"./src/"));
        assert!(values.contains(&"./main.rs"));
        assert!(
            values.iter().position(|v| *v == "./main.rs").unwrap()
                > values.iter().position(|v| *v == "./src/").unwrap()
        );
        // Non-path tokens do not trigger on natural typing.
        assert!(provider
            .get_suggestions(&["hello wor".to_string()], 0, 9, false)
            .is_none());
        // ...but an explicit request (Tab) completes any token.
        assert!(provider
            .get_suggestions(&["hello ma".to_string()], 0, 8, true)
            .is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Dot entries list only for an explicit dot-prefix anchor (the
    /// operator's 2026-09-25 directive): a directory browse (`./`, `src/`,
    /// `..`, the empty root prefix) must not surface the cwd's dotfiles —
    /// the old forced pass listed the whole cwd and a `.claude` directory
    /// rode first — while a typed dot prefix (`.h`, `./.cl`) still
    /// completes hidden paths.
    #[test]
    fn dotfiles_list_only_for_a_dot_prefix_anchor() {
        let outer = tempfile::TempDir::new().expect("temp dir");
        let base = outer.path().join("base");
        std::fs::create_dir_all(base.join(".claude")).expect("mkdir");
        std::fs::create_dir_all(base.join("src")).expect("mkdir");
        std::fs::write(base.join(".hidden"), "x").expect("write");
        std::fs::write(base.join("main.rs"), "fn main() {}").expect("write");
        std::fs::write(outer.path().join(".outer-hidden"), "x").expect("write");
        let provider = provider(base.to_str().unwrap());
        let values = |text: &str| -> Vec<String> {
            provider
                .get_suggestions(&[text.to_string()], 0, text.chars().count(), true)
                .expect("suggestions")
                .items
                .into_iter()
                .map(|item| item.value)
                .collect()
        };
        // The root browse: non-hidden entries only.
        assert_eq!(
            values("./"),
            ["./src/", "./main.rs"],
            "the cwd browse hides the dot entries"
        );
        // The explicit `src/` browse and the empty-prefix forced pass are
        // the same class of listing.
        assert_eq!(values("src/"), ["src/main.rs"]);
        assert_eq!(values(""), ["src/", "main.rs"]);
        // The directory references `.`/`..` browse like any other empty
        // anchor: the dot entries stay hidden (the parent's too).
        assert_eq!(values("."), ["src/", "main.rs"]);
        assert_eq!(
            values(".."),
            ["base"],
            "the parent browse hides the dot entries"
        );
        // A typed dot prefix is the explicit hidden-path browse: dot
        // entries list again.
        assert_eq!(values("./.cl"), ["./.claude/"]);
        assert_eq!(values(".h"), [".hidden"]);
    }

    #[test]
    fn at_prefix_has_no_suggestions_without_fd() {
        let provider = provider("/tmp");
        assert!(provider
            .get_suggestions(&["see @src".to_string()], 0, 9, false)
            .is_none());
    }

    #[test]
    fn should_trigger_file_completion_skips_slash_names() {
        let provider = provider("/tmp");
        assert!(!provider.should_trigger_file_completion(&["/mo".to_string()], 0, 3));
        assert!(provider.should_trigger_file_completion(&["path/to".to_string()], 0, 7));
    }

    fn theme() -> crate::theme::Theme {
        crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor)
    }

    #[test]
    fn render_uses_the_menu_panel_grammar() {
        let items: Vec<CompletionItem> = (0..7)
            .map(|i| CompletionItem {
                value: format!("cmd{i}"),
                label: format!("cmd{i}"),
                description: Some(format!("description {i}")),
                argument_hint: Some("[arg]".to_string()),
                source_tag: None,
            })
            .collect();
        let state = AutocompleteState::new(
            items,
            5,
            "/".to_string(),
            Some(SuggestionKind::SlashCommand),
        );
        let lines = state.render(&theme(), 60);
        let text = |line: &Line| -> String { line.iter().map(|s| s.content.as_str()).collect() };
        let rendered: Vec<String> = lines.iter().map(text).collect();
        // The selected row carries the menu marker and the selection band
        // spans the row (padded to the full width).
        assert!(rendered[0].starts_with("\u{203a} cmd0"));
        assert_eq!(rendered[0].chars().count(), 60);
        // The argument hint rides the row's right-aligned trailing cluster.
        assert!(rendered.iter().any(|l| l.ends_with("[arg]")));
        // The shared scroll status row (the menu panel's `(n/m)`), not the
        // old directional `↑ N more` form.
        assert!(rendered.iter().any(|l| l.trim() == "(1/7)"));
        // The selected item's description block under the list.
        assert!(rendered.iter().any(|l| l.contains("description 0")));
    }

    #[test]
    fn empty_items_render_the_shared_no_match_row() {
        let state = AutocompleteState::new(Vec::new(), 5, String::new(), None);
        let lines = state.render(&theme(), 40);
        let text: String = lines[0].iter().map(|s| s.content.as_str()).collect();
        assert_eq!(text, "  No matching commands");
    }

    /// Every overlay row clamps to the render width: the menu rows pad to
    /// it and the status rows (scroll indicator, no-match) truncate to
    /// it, so a narrow dropdown never emits a row wider than its dock (the
    /// overlay renders the rows straight into the editor dock, and an
    /// unclamped `(n/m)` would overwrite the adjacent terminal cells).
    #[test]
    fn narrow_renders_never_exceed_the_frame_width() {
        let mut described = item("cmd0");
        described.description = Some("description 0".to_string());
        let items: Vec<CompletionItem> = std::iter::once(described)
            .chain((1..7).map(|index| item(&format!("cmd{index}"))))
            .collect();
        for width in [4usize, 6, 9, 40] {
            let state = AutocompleteState::new(
                items.clone(),
                5,
                "/".to_string(),
                Some(SuggestionKind::SlashCommand),
            );
            for line in &state.render(&theme(), width) {
                assert!(
                    crate::width::spans_width(line) <= width,
                    "every row clamps to the frame width {width}: {line:?}"
                );
            }
        }
        let empty = AutocompleteState::new(Vec::new(), 5, String::new(), None);
        for line in &empty.render(&theme(), 6) {
            assert!(
                crate::width::spans_width(line) <= 6,
                "the no-match row clamps to the frame width: {line:?}"
            );
        }
    }

    #[test]
    fn best_match_prefers_exact_then_prefix() {
        let state = AutocompleteState::new(
            vec![item("help"), item("hello")],
            5,
            "/hel".to_string(),
            Some(SuggestionKind::SlashCommand),
        );
        assert_eq!(state.best_match_index("hel"), Some(0));
        assert_eq!(state.best_match_index("hello"), Some(1));
        assert_eq!(state.best_match_index("zzz"), None);
    }

    /// A `skill:` entry as the daemon `get_commands` response carries it.
    fn skill_entry(name: &str, description: &str, scope: &str) -> serde_json::Value {
        serde_json::json!({
            "name": name,
            "description": description,
            "source": "skill",
            "sourceInfo": {
                "path": "/tmp/skills/web-search/SKILL.md",
                "source": "local",
                "scope": scope,
                "origin": "top-level",
                "baseDir": "/tmp/skills",
            },
        })
    }

    fn provider_with_skill(base: &str) -> CombinedAutocompleteProvider {
        let mut provider = provider(base);
        provider.set_skill_commands(vec![SlashCommandEntry {
            name: "skill:brainstorm".to_string(),
            aliases: Vec::new(),
            description: Some("Brainstorm approaches".to_string()),
            argument_hint: None,
            takes_argument: false,
            source_tag: Some("#project".to_string()),
        }]);
        provider
    }

    #[test]
    fn skill_commands_list_after_the_builtins() {
        // TS `createBaseAutocompleteProvider`: the skill commands follow
        // the builtin commands in the provider's list.
        let provider = provider_with_skill("/tmp");
        let items = provider.slash_suggestions("/");
        assert!(items.len() > SlashCommandRegistry::builtin().all().len());
        assert_eq!(items.last().unwrap().value, "skill:brainstorm");
        assert_eq!(
            items.last().unwrap().description.as_deref(),
            Some("Brainstorm approaches")
        );
        assert_eq!(
            items.last().unwrap().source_tag.as_deref(),
            Some("#project")
        );
    }

    #[test]
    fn skill_commands_suggest_for_the_typed_prefix_and_inline_references() {
        // TS autocomplete.test.ts: a `/skill:brain` prefix suggests the
        // skill command, and a mid-line reference suggests it too.
        let provider = provider_with_skill("/tmp");
        let items = provider.slash_suggestions("/skill:brain");
        let values: Vec<&str> = items.iter().map(|item| item.value.as_str()).collect();
        assert_eq!(values, vec!["skill:brainstorm"]);
        let suggestions = provider
            .get_suggestions(&["Please use /skill:brain".to_string()], 0, 23, false)
            .expect("mid-line skill reference suggests");
        assert_eq!(suggestions.prefix, "/skill:brain");
        assert_eq!(
            suggestions
                .items
                .iter()
                .map(|item| item.value.as_str())
                .collect::<Vec<_>>(),
            vec!["skill:brainstorm"]
        );
    }

    #[test]
    fn skill_command_completes_without_a_trailing_separator() {
        // TS `commandTakesArgument`: a skill command takes no argument,
        // so completion stays on the command token.
        let provider = provider_with_skill("/tmp");
        let item = item("skill:brainstorm");
        let result = provider.apply_slash_completion(
            &["/skill:brain".to_string()],
            0,
            12,
            &item,
            "/skill:brain",
        );
        assert_eq!(result.lines[0], "/skill:brainstorm");
        assert_eq!(result.cursor_col, "/skill:brainstorm".chars().count());
    }

    #[test]
    fn skill_completions_apply_through_the_slash_path() {
        // TS `applyCompletion` finds skill items over the whole command
        // list, so a menu-confirmed skill keeps the leading `/` and stays
        // a command submission (the file path would drop it).
        let provider = provider_with_skill("/tmp");
        let item = item("skill:brainstorm");
        let result =
            provider.apply_completion(&["/skill:brain".to_string()], 0, 12, &item, "/skill:brain");
        assert_eq!(result.lines[0], "/skill:brainstorm");
        assert_eq!(result.cursor_col, "/skill:brainstorm".chars().count());
    }

    #[test]
    fn command_catalog_parse_keeps_skills_and_source_labels() {
        // TS `connectionCommands.filter(source === "skill")` + the
        // `getAutocompleteSourceLabel` ladder.
        let response = serde_json::json!({
            "commands": [
                {
                    "name": "review",
                    "description": "Review template",
                    "source": "prompt",
                    "sourceInfo": { "source": "local", "scope": "project" },
                },
                skill_entry("skill:web-search", "Search Google", "user"),
                {
                    "name": "skill:packaged",
                    "description": "From the registry",
                    "source": "skill",
                    "sourceInfo": { "source": "npm:@prime/skill-pack", "scope": "project" },
                },
                {
                    "name": "skill:path-skill",
                    "description": "Path-provided",
                    "source": "skill",
                    "sourceInfo": { "source": "local", "scope": "temporary" },
                },
            ]
        });
        let entries = skill_command_entries(&response);
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["skill:web-search", "skill:packaged", "skill:path-skill"]
        );
        assert_eq!(entries[0].description.as_deref(), Some("Search Google"));
        assert_eq!(entries[0].source_tag.as_deref(), Some("#user"));
        assert_eq!(
            entries[1].source_tag.as_deref(),
            Some("#project:npm:@prime/skill-pack")
        );
        assert_eq!(entries[2].source_tag.as_deref(), Some("#temporary"));
        // Prompt-template entries are a different surface: they stay out.
        // A malformed or empty response yields no entries.
        assert!(skill_command_entries(&serde_json::json!({})).is_empty());
        assert!(skill_command_entries(&serde_json::json!({"commands": []})).is_empty());
    }

    #[test]
    fn source_tag_ladder_matches_ts() {
        let source_info = |source: &str, scope: Option<&str>| {
            let mut value = serde_json::json!({ "source": source });
            if let Some(scope) = scope {
                value["scope"] = serde_json::json!(scope);
            }
            value
        };
        // Builtins keep their own tag; auto/local/cli take the scope
        // prefix; an unknown scope reads temporary; an npm source appends
        // its spec.
        assert_eq!(
            autocomplete_source_label(&source_info("builtin", None)).as_deref(),
            Some("#builtin")
        );
        assert_eq!(
            autocomplete_source_label(&source_info("local", Some("user"))).as_deref(),
            Some("#user")
        );
        assert_eq!(
            autocomplete_source_label(&source_info("cli", Some("project"))).as_deref(),
            Some("#project")
        );
        assert_eq!(
            autocomplete_source_label(&source_info("local", None)).as_deref(),
            Some("#temporary")
        );
        assert_eq!(
            autocomplete_source_label(&source_info("npm:@scope/pack", Some("user"))).as_deref(),
            Some("#user:npm:@scope/pack")
        );
        // No sourceInfo at all: no tag.
        assert!(autocomplete_source_label(&serde_json::Value::Null).is_none());
    }

    #[test]
    fn render_shows_the_source_tag_as_a_trailing_segment() {
        // TS select-list renders the sourceTag after the argument hint;
        // the menu grammar renders both as muted trailing segments.
        let mut described = item("skill:web-search");
        described.description = Some("Search Google".to_string());
        described.source_tag = Some("#user".to_string());
        let state = AutocompleteState::new(
            vec![described],
            5,
            "/skill:web".to_string(),
            Some(SuggestionKind::SlashCommand),
        );
        let rendered = state.render(&theme(), 80);
        let all: String = rendered
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
            })
            .collect();
        assert!(
            all.contains("skill:web-search"),
            "the row names the skill: {all}"
        );
        assert!(
            all.contains("#user"),
            "the row carries the source tag: {all}"
        );
        assert!(
            all.contains("Search Google"),
            "the selected description renders: {all}"
        );
    }
}
