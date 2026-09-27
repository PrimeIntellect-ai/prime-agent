//! Shared diff computation utilities for the edit tool.
//!
//! Port of `packages/coding-agent/src/core/tools/edit-diff.ts`, including a
//! faithful port of jsdiff v9 `diffLines` (Myers O(ND) with the diagonal-bounds
//! optimization) so generated diffs match the TypeScript product byte for byte.

use std::path::Path;

use unicode_normalization::UnicodeNormalization;

use crate::tools::jsdiff::diff_lines;
use crate::tools::path_utils::resolve_to_cwd;

// ---------------------------------------------------------------------------
// Line endings / normalization
// ---------------------------------------------------------------------------

/// Detect whether the content uses CRLF or LF line endings.
pub fn detect_line_ending(content: &str) -> LineEnding {
    let crlf_idx = content.find("\r\n");
    let lf_idx = content.find('\n');
    match (crlf_idx, lf_idx) {
        (_, None) | (None, _) => LineEnding::Lf,
        (Some(c), Some(l)) => {
            if c < l {
                LineEnding::CrLf
            } else {
                LineEnding::Lf
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    CrLf,
    Lf,
}

/// Convert CRLF and lone CR line endings to LF.
pub fn normalize_to_lf(text: &str) -> String {
    // Replace \r\n first, then remaining \r (matches the TS chain).
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

/// Convert LF endings back to the original file's ending.
pub fn restore_line_endings(text: &str, ending: LineEnding) -> String {
    match ending {
        LineEnding::Lf => text.to_string(),
        LineEnding::CrLf => text.replace('\n', "\r\n"),
    }
}

/// JS `String.prototype.trimEnd` whitespace set (differs from Rust's).
fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{09}'
            ..='\u{0D}'
                | ' '
                | '\u{A0}'
                | '\u{1680}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    ) || ('\u{2000}'..='\u{200A}').contains(&ch)
}

fn js_trim_end(line: &str) -> &str {
    line.trim_end_matches(is_js_whitespace)
}

/// Normalize text for fuzzy matching. Applies progressive transformations:
/// - NFKC normalization
/// - Strip trailing whitespace from each line
/// - Normalize smart quotes to ASCII equivalents
/// - Normalize Unicode dashes/hyphens to ASCII hyphen
/// - Normalize special Unicode spaces to regular space
pub fn normalize_for_fuzzy_match(text: &str) -> String {
    let nfkc: String = text.chars().nfkc().collect();
    let trimmed: String = nfkc
        .split('\n')
        .map(js_trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        let mapped = match ch {
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => '-',
            '\u{00A0}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
            c if ('\u{2002}'..='\u{200A}').contains(&c) => ' ',
            c => c,
        };
        out.push(mapped);
    }
    out
}

/// Strip UTF-8 BOM if present, returning both the BOM and the text without it.
pub fn strip_bom(content: &str) -> (&str, &str) {
    if let Some(rest) = content.strip_prefix('\u{FEFF}') {
        ("\u{FEFF}", rest)
    } else {
        ("", content)
    }
}

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FuzzyMatchResult {
    /// Whether a match was found.
    pub found: bool,
    /// The match start index (in `content_for_replacement`).
    pub index: usize,
    /// Length of the matched text.
    pub match_length: usize,
    /// Whether fuzzy matching was used (false = exact match).
    pub used_fuzzy_match: bool,
    /// The content to use for replacement operations. When fuzzy matching is
    /// used, this is the fuzzy-normalized content.
    pub content_for_replacement: String,
}

/// Find `old_text` in `content`, trying exact match first, then fuzzy match.
pub fn fuzzy_find_text(content: &str, old_text: &str) -> FuzzyMatchResult {
    if let Some(exact_index) = content.find(old_text) {
        return FuzzyMatchResult {
            found: true,
            index: exact_index,
            match_length: old_text.len(),
            used_fuzzy_match: false,
            content_for_replacement: content.to_string(),
        };
    }

    let fuzzy_content = normalize_for_fuzzy_match(content);
    let fuzzy_old_text = normalize_for_fuzzy_match(old_text);
    if let Some(fuzzy_index) = fuzzy_content.find(&fuzzy_old_text) {
        return FuzzyMatchResult {
            found: true,
            index: fuzzy_index,
            match_length: fuzzy_old_text.len(),
            used_fuzzy_match: true,
            content_for_replacement: fuzzy_content,
        };
    }

    FuzzyMatchResult {
        found: false,
        index: 0,
        match_length: 0,
        used_fuzzy_match: false,
        content_for_replacement: content.to_string(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edit {
    pub old_text: String,
    pub new_text: String,
}

#[derive(Debug)]
struct MatchedEdit {
    edit_index: usize,
    match_index: usize,
    match_length: usize,
    new_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedEditsResult {
    pub base_content: String,
    pub new_content: String,
}

fn count_occurrences(content: &str, old_text: &str) -> usize {
    let fuzzy_content = normalize_for_fuzzy_match(content);
    let fuzzy_old_text = normalize_for_fuzzy_match(old_text);
    if fuzzy_old_text.is_empty() {
        return 0;
    }
    fuzzy_content.matches(&fuzzy_old_text).count()
}

fn get_not_found_error(path: &str, edit_index: usize, total_edits: usize) -> String {
    if total_edits == 1 {
        return format!(
            "Could not find the exact text in {path}. The old text must match exactly including all whitespace and newlines."
        );
    }
    format!(
        "Could not find edits[{edit_index}] in {path}. The oldText must match exactly including all whitespace and newlines."
    )
}

fn get_duplicate_error(
    path: &str,
    edit_index: usize,
    total_edits: usize,
    occurrences: usize,
) -> String {
    if total_edits == 1 {
        return format!(
            "Found {occurrences} occurrences of the text in {path}. The text must be unique. Please provide more context to make it unique."
        );
    }
    format!(
        "Found {occurrences} occurrences of edits[{edit_index}] in {path}. Each oldText must be unique. Please provide more context to make it unique."
    )
}

fn get_empty_old_text_error(path: &str, edit_index: usize, total_edits: usize) -> String {
    if total_edits == 1 {
        return format!("oldText must not be empty in {path}.");
    }
    format!("edits[{edit_index}].oldText must not be empty in {path}.")
}

fn get_no_change_error(path: &str, total_edits: usize) -> String {
    if total_edits == 1 {
        return format!(
            "No changes made to {path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected."
        );
    }
    format!("No changes made to {path}. The replacements produced identical content.")
}

/// Apply one or more exact-text replacements to LF-normalized content.
///
/// All edits are matched against the same original content. Replacements are
/// then applied in reverse order so offsets remain stable. If any edit needs
/// fuzzy matching, the operation runs in fuzzy-normalized content space.
pub fn apply_edits_to_normalized_content(
    normalized_content: &str,
    edits: &[Edit],
    path: &str,
) -> Result<AppliedEditsResult, String> {
    let normalized_edits: Vec<Edit> = edits
        .iter()
        .map(|edit| Edit {
            old_text: normalize_to_lf(&edit.old_text),
            new_text: normalize_to_lf(&edit.new_text),
        })
        .collect();

    for (i, edit) in normalized_edits.iter().enumerate() {
        if edit.old_text.is_empty() {
            return Err(get_empty_old_text_error(path, i, normalized_edits.len()));
        }
    }

    let initial_matches: Vec<FuzzyMatchResult> = normalized_edits
        .iter()
        .map(|edit| fuzzy_find_text(normalized_content, &edit.old_text))
        .collect();
    let base_content = if initial_matches.iter().any(|m| m.used_fuzzy_match) {
        normalize_for_fuzzy_match(normalized_content)
    } else {
        normalized_content.to_string()
    };

    let mut matched_edits: Vec<MatchedEdit> = Vec::new();
    for (i, edit) in normalized_edits.iter().enumerate() {
        let match_result = fuzzy_find_text(&base_content, &edit.old_text);
        if !match_result.found {
            return Err(get_not_found_error(path, i, normalized_edits.len()));
        }

        let occurrences = count_occurrences(&base_content, &edit.old_text);
        if occurrences > 1 {
            return Err(get_duplicate_error(
                path,
                i,
                normalized_edits.len(),
                occurrences,
            ));
        }

        matched_edits.push(MatchedEdit {
            edit_index: i,
            match_index: match_result.index,
            match_length: match_result.match_length,
            new_text: edit.new_text.clone(),
        });
    }

    matched_edits.sort_by_key(|edit| edit.match_index);
    for i in 1..matched_edits.len() {
        let previous = &matched_edits[i - 1];
        let current = &matched_edits[i];
        if previous.match_index + previous.match_length > current.match_index {
            return Err(format!(
                "edits[{}] and edits[{}] overlap in {path}. Merge them into one edit or target disjoint regions.",
                previous.edit_index, current.edit_index
            ));
        }
    }

    let mut new_content = base_content.clone();
    for edit in matched_edits.iter().rev() {
        new_content = format!(
            "{}{}{}",
            &new_content[..edit.match_index],
            edit.new_text,
            &new_content[edit.match_index + edit.match_length..]
        );
    }

    if base_content == new_content {
        return Err(get_no_change_error(path, normalized_edits.len()));
    }

    Ok(AppliedEditsResult {
        base_content,
        new_content,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffStringResult {
    pub diff: String,
    pub first_changed_line: Option<usize>,
}

/// Generate a unified diff string with line numbers and context.
/// Returns both the diff string and the first changed line number (in the new file).
pub fn generate_diff_string(
    old_content: &str,
    new_content: &str,
    context_lines: usize,
    start_line: usize,
) -> DiffStringResult {
    let parts = diff_lines(old_content, new_content);
    let mut output: Vec<String> = Vec::new();

    let old_lines: Vec<&str> = old_content.split('\n').collect();
    let new_lines: Vec<&str> = new_content.split('\n').collect();
    let max_line_num = start_line.saturating_sub(1) + old_lines.len().max(new_lines.len());
    let line_num_width = max_line_num.to_string().len();

    let mut old_line_num = start_line;
    let mut new_line_num = start_line;
    let mut last_was_change = false;
    let mut first_changed_line: Option<usize> = None;

    for (i, part) in parts.iter().enumerate() {
        let mut raw: Vec<&str> = part.value.split('\n').collect();
        if raw.last() == Some(&"") {
            raw.pop();
        }

        if part.added || part.removed {
            if first_changed_line.is_none() {
                first_changed_line = Some(new_line_num);
            }

            for line in &raw {
                if part.added {
                    let line_num = format!("{new_line_num:>line_num_width$}");
                    output.push(format!("+{line_num} {line}"));
                    new_line_num += 1;
                } else {
                    let line_num = format!("{old_line_num:>line_num_width$}");
                    output.push(format!("-{line_num} {line}"));
                    old_line_num += 1;
                }
            }
            last_was_change = true;
        } else {
            let next_part_is_change =
                i + 1 < parts.len() && (parts[i + 1].added || parts[i + 1].removed);
            let has_leading_change = last_was_change;
            let has_trailing_change = next_part_is_change;

            if has_leading_change && has_trailing_change {
                if raw.len() <= context_lines * 2 {
                    for line in &raw {
                        let line_num = format!("{old_line_num:>line_num_width$}");
                        output.push(format!(" {line_num} {line}"));
                        old_line_num += 1;
                        new_line_num += 1;
                    }
                } else {
                    let leading_lines = &raw[..context_lines];
                    let trailing_lines = &raw[raw.len() - context_lines..];
                    let skipped_lines = raw.len() - leading_lines.len() - trailing_lines.len();

                    for line in leading_lines {
                        let line_num = format!("{old_line_num:>line_num_width$}");
                        output.push(format!(" {line_num} {line}"));
                        old_line_num += 1;
                        new_line_num += 1;
                    }

                    output.push(format!(" {:>line_num_width$} ...", ""));
                    old_line_num += skipped_lines;
                    new_line_num += skipped_lines;

                    for line in trailing_lines {
                        let line_num = format!("{old_line_num:>line_num_width$}");
                        output.push(format!(" {line_num} {line}"));
                        old_line_num += 1;
                        new_line_num += 1;
                    }
                }
            } else if has_leading_change {
                let shown_lines = &raw[..context_lines.min(raw.len())];
                let skipped_lines = raw.len() - shown_lines.len();

                for line in shown_lines {
                    let line_num = format!("{old_line_num:>line_num_width$}");
                    output.push(format!(" {line_num} {line}"));
                    old_line_num += 1;
                    new_line_num += 1;
                }

                if skipped_lines > 0 {
                    output.push(format!(" {:>line_num_width$} ...", ""));
                    old_line_num += skipped_lines;
                    new_line_num += skipped_lines;
                }
            } else if has_trailing_change {
                let skipped_lines = raw.len().saturating_sub(context_lines);
                if skipped_lines > 0 {
                    output.push(format!(" {:>line_num_width$} ...", ""));
                    old_line_num += skipped_lines;
                    new_line_num += skipped_lines;
                }

                for line in raw.iter().skip(skipped_lines) {
                    let line_num = format!("{old_line_num:>line_num_width$}");
                    output.push(format!(" {line_num} {line}"));
                    old_line_num += 1;
                    new_line_num += 1;
                }
            } else {
                old_line_num += raw.len();
                new_line_num += raw.len();
            }

            last_was_change = false;
        }
    }

    DiffStringResult {
        diff: output.join("\n"),
        first_changed_line,
    }
}

impl Default for DiffStringContext {
    fn default() -> Self {
        Self {
            context_lines: 4,
            start_line: 1,
        }
    }
}

/// Optional parameters for [`generate_diff_string`].
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub struct DiffStringContext {
    pub context_lines: usize,
    pub start_line: usize,
}

/// [`generate_diff_string`] with TS defaults (4 context lines, start line 1).
pub fn generate_diff_string_default(old_content: &str, new_content: &str) -> DiffStringResult {
    generate_diff_string(old_content, new_content, 4, 1)
}

// ---------------------------------------------------------------------------
// Preview diff computation (reads the file from disk)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub struct EditDiffResult {
    pub diff: String,
    pub first_changed_line: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub enum EditDiffOutcome {
    Ok(EditDiffResult),
    Err(String),
}

/// Compute the diff for one or more edit operations without applying them.
/// Used for preview rendering in the TUI before the tool executes.
#[allow(dead_code)]
pub fn compute_edits_diff(path: &str, edits: &[Edit], cwd: &str) -> EditDiffOutcome {
    let absolute_path = resolve_to_cwd(path, cwd);

    // access(R_OK) probe with Node-style error codes.
    if let Err(code) = access_readable(&absolute_path) {
        return EditDiffOutcome::Err(format!("Could not edit file: {path}. Error code: {code}."));
    }

    let raw_content = match std::fs::read(&absolute_path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(err) => return EditDiffOutcome::Err(format!("Could not edit file: {path}. {err}.")),
    };
    apply_edits_with_diff(&raw_content, edits, path)
        .map_or_else(EditDiffOutcome::Err, EditDiffOutcome::Ok)
}

/// Strip the BOM, normalize endings, apply the edits, and generate the diff.
#[allow(dead_code)]
pub fn apply_edits_with_diff(
    raw_content: &str,
    edits: &[Edit],
    path: &str,
) -> Result<EditDiffResult, String> {
    let (_, content) = strip_bom(raw_content);
    let normalized_content = normalize_to_lf(content);
    let applied = apply_edits_to_normalized_content(&normalized_content, edits, path)?;
    let diff = generate_diff_string_default(&applied.base_content, &applied.new_content);
    Ok(EditDiffResult {
        diff: diff.diff,
        first_changed_line: diff.first_changed_line,
    })
}

/// Map an io error to the errno name Node exposes as `error.code`.
pub fn errno_name(err: &std::io::Error) -> String {
    if let Some(raw) = err.raw_os_error() {
        return match raw {
            1 => "EPERM".to_string(),
            2 => "ENOENT".to_string(),
            13 => "EACCES".to_string(),
            20 => "ENOTDIR".to_string(),
            21 => "EISDIR".to_string(),
            30 => "EROFS".to_string(),
            36 => "ENAMETOOLONG".to_string(),
            40 => "ELOOP".to_string(),
            other => format!("E{other}"),
        };
    }
    match err.kind() {
        std::io::ErrorKind::NotFound => "ENOENT".to_string(),
        std::io::ErrorKind::PermissionDenied => "EACCES".to_string(),
        _ => "EUNKNOWN".to_string(),
    }
}

#[allow(dead_code)]
fn access_readable(path: &str) -> Result<(), String> {
    crate::platform::perms::is_readable(Path::new(path)).map_err(|err| errno_name(&err))
}
