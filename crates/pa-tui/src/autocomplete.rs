//! Autocomplete: provider contract, suggestion state, and selection list
//! rendering ported from `packages/tui/src/autocomplete.ts` +
//! `components/select-list.ts` (the subset the interactive agent view uses:
//! slash-command and file/path completion with a select list).

use crate::fuzzy::fuzzy_filter;
use crate::width::str_width;
use crate::{Line, Span};
use pa_types::slash_commands::SlashCommandRegistry;
use ratatui::style::Style;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionItem {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
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

/// Provider contract mirroring TS AutocompleteProvider (synchronous).
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
        .map(|index| index + 1)
        .unwrap_or(0);
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

/// Column gap between the primary and description columns (TS
/// `PRIMARY_COLUMN_GAP`).
const PRIMARY_COLUMN_GAP: usize = 2;

/// Minimum description width for the inline description column (TS
/// `MIN_DESCRIPTION_WIDTH`).
const MIN_DESCRIPTION_WIDTH: usize = 10;

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
        .map(|index| index + 1)
        .unwrap_or(0);
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

/// Selection state for the autocomplete dropdown (port of SelectList).
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

    /// Render the dropdown (SelectList port). The slash-command layout
    /// shows the argument-hint column, directional scroll info, and the
    /// selected item's full description; the file layout inlines the
    /// description column.
    pub fn render(&self, width: usize, styles: &SelectListStyles) -> Vec<Line> {
        if self.items.is_empty() {
            return vec![vec![Span::styled(
                "  No matching commands".to_string(),
                styles.no_match,
            )]];
        }
        let slash_layout =
            self.kind == Some(SuggestionKind::SlashCommand) || self.prefix.starts_with('/');
        let (min_primary, max_primary) = if slash_layout { (12, 32) } else { (32, 32) };
        let primary_column_width = primary_column_width(&self.items, min_primary, max_primary);
        let start = self
            .selected_index
            .saturating_sub(self.max_visible / 2)
            .min(self.items.len().saturating_sub(self.max_visible));
        let end = (start + self.max_visible).min(self.items.len());
        let mut lines: Vec<Line> = Vec::new();
        for (index, item) in self.items[start..end].iter().enumerate() {
            let index = start + index;
            let selected = index == self.selected_index;
            lines.push(render_item(
                item,
                selected,
                width,
                primary_column_width,
                slash_layout,
                styles,
            ));
        }
        if start > 0 || end < self.items.len() {
            let scroll_text = if slash_layout {
                format!(
                    "  {}",
                    directional_scroll_info(start, self.items.len() - end)
                )
            } else {
                format!("  ({}/{})", self.selected_index + 1, self.items.len())
            };
            lines.push(vec![Span::styled(
                truncate_to_width(&scroll_text, width.saturating_sub(2), ""),
                styles.scroll_info,
            )]);
        }
        if slash_layout {
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
                    lines.push(vec![Span::styled(
                        format!("{indent}{text}"),
                        styles.description,
                    )]);
                }
            }
        }
        lines
    }
}

/// Select-list colors (TS `SelectListTheme`).
pub struct SelectListStyles {
    pub selected_prefix: Style,
    pub selected_text: Style,
    pub description: Style,
    pub argument_hint: Style,
    pub scroll_info: Style,
    pub no_match: Style,
}

/// One item row (TS `SelectList.renderItem`).
fn render_item(
    item: &CompletionItem,
    selected: bool,
    width: usize,
    primary_column_width: usize,
    slash_layout: bool,
    styles: &SelectListStyles,
) -> Line {
    let prefix = if selected { "\u{203a} " } else { "  " };
    let prefix_width = str_width(prefix);
    let single_line = |text: &str| -> String {
        text.chars()
            .filter(|c| *c != '\n')
            .collect::<String>()
            .trim()
            .to_string()
    };
    if slash_layout {
        return render_metadata_item(
            item,
            selected,
            width,
            primary_column_width,
            prefix,
            prefix_width,
            styles,
        );
    }
    let description = item.description.as_deref().map(single_line);
    if let Some(description) = description.filter(|_| width > 40) {
        let effective_primary = primary_column_width
            .min(width.saturating_sub(prefix_width + 4))
            .max(1);
        let max_primary = effective_primary.saturating_sub(PRIMARY_COLUMN_GAP).max(1);
        let value = truncate_to_width(&item.label, max_primary, "");
        let spacing = " ".repeat(effective_primary.saturating_sub(str_width(&value)).max(1));
        let description_start = prefix_width + str_width(&value) + spacing.len();
        let remaining = width.saturating_sub(description_start + 2);
        if remaining > MIN_DESCRIPTION_WIDTH {
            let description = truncate_to_width(&description, remaining, "\u{2026}");
            let content = format!("{prefix}{value}{spacing}{description}");
            if selected {
                return vec![Span::styled(content, styles.selected_text)];
            }
            return vec![
                Span::raw(format!("{prefix}{value}")),
                Span::styled(format!("{spacing}{description}"), styles.description),
            ];
        }
    }
    let max_width = width.saturating_sub(prefix_width + 2);
    let value = truncate_to_width(&item.label, max_width, "");
    let content = format!("{prefix}{value}");
    if selected {
        vec![Span::styled(content, styles.selected_text)]
    } else {
        vec![Span::raw(content)]
    }
}

/// The slash-layout row: primary column plus the argument-hint metadata
/// (TS `renderMetadataItem`).
#[allow(clippy::too_many_arguments)]
fn render_metadata_item(
    item: &CompletionItem,
    selected: bool,
    width: usize,
    primary_column_width: usize,
    prefix: &str,
    prefix_width: usize,
    styles: &SelectListStyles,
) -> Line {
    let argument_hint = item
        .argument_hint
        .as_deref()
        .map(|hint| hint.chars().filter(|c| *c != '\n').collect::<String>());
    let content_width = width.saturating_sub(prefix_width + 2).max(1);
    let show_metadata = argument_hint.is_some() && content_width > primary_column_width;
    let effective_primary = if show_metadata {
        primary_column_width
    } else {
        content_width
    };
    let max_primary = if show_metadata {
        effective_primary.saturating_sub(PRIMARY_COLUMN_GAP).max(1)
    } else {
        effective_primary
    };
    let primary = truncate_to_width(&item.label, max_primary, "");
    if !show_metadata {
        let content = format!("{prefix}{primary}");
        if selected {
            return vec![Span::styled(content, styles.selected_text)];
        }
        return vec![Span::raw(content)];
    }
    let spacing = " ".repeat(effective_primary.saturating_sub(str_width(&primary)).max(1));
    let remaining = width.saturating_sub(prefix_width + str_width(&primary) + spacing.len() + 2);
    let mut row: Line = Vec::new();
    if selected {
        row.push(Span::styled(prefix.to_string(), styles.selected_prefix));
        row.push(Span::styled(primary.clone(), styles.selected_text));
    } else {
        row.push(Span::raw(prefix.to_string()));
        row.push(Span::raw(primary.clone()));
    }
    row.push(Span::raw(spacing));
    if let Some(hint) = argument_hint.filter(|_| remaining > 0) {
        row.push(Span::styled(
            truncate_to_width(&hint, remaining, "\u{2026}"),
            styles.argument_hint,
        ));
    }
    row
}

/// The primary column width: widest label plus the gap, clamped.
fn primary_column_width(items: &[CompletionItem], min: usize, max: usize) -> usize {
    let widest = items
        .iter()
        .map(|item| str_width(&item.label))
        .max()
        .unwrap_or(0);
    (widest + PRIMARY_COLUMN_GAP).clamp(min.max(1), max.max(1))
}

/// `↑ N more  ↓ M more` (TS `formatDirectionalScrollInfo`).
fn directional_scroll_info(hidden_above: usize, hidden_below: usize) -> String {
    let mut indicators = Vec::new();
    if hidden_above > 0 {
        indicators.push(format!("\u{2191} {hidden_above} more"));
    }
    if hidden_below > 0 {
        indicators.push(format!("\u{2193} {hidden_below} more"));
    }
    indicators.join("  ")
}

/// Truncate to a display width, optionally marking the cut (TS
/// `truncateToWidth`).
fn truncate_to_width(text: &str, width: usize, ellipsis: &str) -> String {
    let mut out = String::new();
    let mut w = 0;
    for c in text.chars() {
        let cw = crate::width::char_width(c);
        if w + cw > width {
            if !ellipsis.is_empty() && w + str_width(ellipsis) <= width && !out.is_empty() {
                out.push_str(ellipsis);
            }
            break;
        }
        out.push(c);
        w += cw;
    }
    out
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

/// The installed provider: slash-command completion from the builtin
/// registry (fuzzy-filtered, like the TS `CombinedAutocompleteProvider`)
/// plus file/path completion.
pub struct CombinedAutocompleteProvider {
    commands: Vec<SlashCommandEntry>,
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
                aliases: command.aliases.iter().map(|a| a.to_string()).collect(),
                description: Some(command.description.to_string()),
                argument_hint: command.argument_hint.map(str::to_string),
                takes_argument: command.takes_argument,
            })
            .collect();
        Self {
            commands,
            hidden: Default::default(),
            paths: PathCompletionProvider { base },
        }
    }

    /// Replace the hidden-command set (the caller recomputes model
    /// eligibility on every model switch).
    pub fn set_hidden_commands(&mut self, hidden: std::collections::HashSet<String>) {
        self.hidden = hidden;
    }

    /// The slash-name suggestions for a typed prefix (fuzzy filter over
    /// `name + aliases`, registry order preserved on ties).
    fn slash_suggestions(&self, prefix: &str) -> Vec<CompletionItem> {
        let query = prefix.strip_prefix('/').unwrap_or(prefix);
        let commands: Vec<&SlashCommandEntry> = self
            .commands
            .iter()
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
        if is_slash
            && self
                .commands
                .iter()
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
            .map(|context| context.kind != SlashKind::Name)
            .unwrap_or(true)
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

    #[test]
    fn select_render_shows_metadata_and_scroll_info() {
        let items: Vec<CompletionItem> = (0..7)
            .map(|i| CompletionItem {
                value: format!("cmd{i}"),
                label: format!("cmd{i}"),
                description: Some(format!("description {i}")),
                argument_hint: Some("[arg]".to_string()),
            })
            .collect();
        let state = AutocompleteState::new(
            items,
            5,
            "/".to_string(),
            Some(SuggestionKind::SlashCommand),
        );
        let styles = SelectListStyles {
            selected_prefix: Style::new(),
            selected_text: Style::new(),
            description: Style::new(),
            argument_hint: Style::new(),
            scroll_info: Style::new(),
            no_match: Style::new(),
        };
        let lines = state.render(60, &styles);
        let text = |line: &Line| -> String { line.iter().map(|s| s.content.as_str()).collect() };
        let rendered: Vec<String> = lines.iter().map(text).collect();
        // 5 visible rows + scroll info + blank + selected description.
        assert!(rendered[0].starts_with("\u{203a} cmd0"));
        assert!(rendered.iter().any(|l| l.contains("[arg]")));
        assert!(rendered.iter().any(|l| l.contains("\u{2193} 2 more")));
        assert!(rendered.iter().any(|l| l.contains("description 0")));
    }

    #[test]
    fn empty_items_render_no_match() {
        let state = AutocompleteState::new(Vec::new(), 5, String::new(), None);
        let styles = SelectListStyles {
            selected_prefix: Style::new(),
            selected_text: Style::new(),
            description: Style::new(),
            argument_hint: Style::new(),
            scroll_info: Style::new(),
            no_match: Style::new(),
        };
        let lines = state.render(40, &styles);
        let text: String = lines[0].iter().map(|s| s.content.as_str()).collect();
        assert_eq!(text, "  No matching commands");
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
}
