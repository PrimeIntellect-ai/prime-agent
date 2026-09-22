//! Shared truncation utilities for tool outputs.
//!
//! Port of `packages/coding-agent/src/core/tools/truncate.ts`.
//!
//! Truncation is based on two independent limits - whichever is hit first wins:
//! - Line limit (default: 2000 lines)
//! - Byte limit (default: 50KB)
//!
//! Never returns partial lines (except bash tail truncation edge case).

/// Max chars per grep match line.
pub const GREP_MAX_LINE_LENGTH: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TruncationOptions {
    pub max_lines: usize,
    pub max_bytes: usize,
}

impl Default for TruncationOptions {
    fn default() -> Self {
        Self {
            max_lines: DEFAULT_MAX_LINES,
            max_bytes: DEFAULT_MAX_BYTES,
        }
    }
}

impl TruncationOptions {
    pub fn with_limits(max_lines: usize, max_bytes: usize) -> Self {
        Self {
            max_lines,
            max_bytes,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TruncatedBy {
    Lines,
    Bytes,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TruncationResult {
    /// The truncated content.
    pub content: String,
    /// Whether truncation occurred.
    pub truncated: bool,
    /// Which limit was hit: lines, bytes, or None if not truncated.
    pub truncated_by: Option<TruncatedBy>,
    /// Total number of lines in the original content.
    pub total_lines: usize,
    /// Total number of bytes in the original content.
    pub total_bytes: usize,
    /// Number of complete lines in the truncated output.
    pub output_lines: usize,
    /// Number of bytes in the truncated output.
    pub output_bytes: usize,
    /// Whether the last line was partially truncated (only for tail truncation edge case).
    pub last_line_partial: bool,
    /// Whether the first line exceeded the byte limit (for head truncation).
    pub first_line_exceeds_limit: bool,
    /// The max lines limit that was applied.
    pub max_lines: usize,
    /// The max bytes limit that was applied.
    pub max_bytes: usize,
}

/// Default line limit: 2000 lines.
pub const DEFAULT_MAX_LINES: usize = 2000;
/// Default byte limit: 50KB.
pub const DEFAULT_MAX_BYTES: usize = 50 * 1024;

/// Format bytes as human-readable size.
pub fn format_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes}B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1}KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// Truncate content from the head (keep first N lines/bytes).
/// Suitable for file reads where you want to see the beginning.
///
/// Never returns partial lines. If first line exceeds byte limit,
/// returns empty content with `first_line_exceeds_limit = true`.
pub fn truncate_head(content: &str, options: TruncationOptions) -> TruncationResult {
    let TruncationOptions {
        max_lines,
        max_bytes,
    } = options;

    let total_bytes = content.len();
    let lines: Vec<&str> = content.split('\n').collect();
    let total_lines = lines.len();

    if total_lines <= max_lines && total_bytes <= max_bytes {
        return TruncationResult {
            content: content.to_string(),
            truncated: false,
            truncated_by: None,
            total_lines,
            total_bytes,
            output_lines: total_lines,
            output_bytes: total_bytes,
            last_line_partial: false,
            first_line_exceeds_limit: false,
            max_lines,
            max_bytes,
        };
    }

    let first_line_bytes = lines[0].len();
    if first_line_bytes > max_bytes {
        return TruncationResult {
            content: String::new(),
            truncated: true,
            truncated_by: Some(TruncatedBy::Bytes),
            total_lines,
            total_bytes,
            output_lines: 0,
            output_bytes: 0,
            last_line_partial: false,
            first_line_exceeds_limit: true,
            max_lines,
            max_bytes,
        };
    }

    let mut output_lines: Vec<&str> = Vec::new();
    let mut output_bytes_count = 0usize;
    let mut truncated_by = TruncatedBy::Lines;

    for (i, line) in lines.iter().enumerate().take(max_lines) {
        // +1 for the newline before every line after the first.
        let line_bytes = line.len() + usize::from(i > 0);
        if output_bytes_count + line_bytes > max_bytes {
            truncated_by = TruncatedBy::Bytes;
            break;
        }
        output_lines.push(line);
        output_bytes_count += line_bytes;
    }

    if output_lines.len() >= max_lines && output_bytes_count <= max_bytes {
        truncated_by = TruncatedBy::Lines;
    }

    let output_content = output_lines.join("\n");
    let final_output_bytes = output_content.len();

    TruncationResult {
        content: output_content,
        truncated: true,
        truncated_by: Some(truncated_by),
        total_lines,
        total_bytes,
        output_lines: output_lines.len(),
        output_bytes: final_output_bytes,
        last_line_partial: false,
        first_line_exceeds_limit: false,
        max_lines,
        max_bytes,
    }
}

/// Truncate content from the tail (keep last N lines/bytes).
/// Suitable for bash output where you want to see the end (errors, final results).
///
/// May return partial first line if the last line of original content exceeds byte limit.
pub fn truncate_tail(content: &str, options: TruncationOptions) -> TruncationResult {
    let TruncationOptions {
        max_lines,
        max_bytes,
    } = options;

    let total_bytes = content.len();
    let lines: Vec<&str> = content.split('\n').collect();
    let total_lines = lines.len();

    if total_lines <= max_lines && total_bytes <= max_bytes {
        return TruncationResult {
            content: content.to_string(),
            truncated: false,
            truncated_by: None,
            total_lines,
            total_bytes,
            output_lines: total_lines,
            output_bytes: total_bytes,
            last_line_partial: false,
            first_line_exceeds_limit: false,
            max_lines,
            max_bytes,
        };
    }

    let mut collected: Vec<String> = Vec::new();
    let mut output_bytes_count = 0usize;
    let mut truncated_by = TruncatedBy::Lines;
    let mut last_line_partial = false;

    for line in lines.iter().rev() {
        if collected.len() >= max_lines {
            break;
        }
        let line_bytes = line.len() + usize::from(!collected.is_empty()); // +1 for newline
        if output_bytes_count + line_bytes > max_bytes {
            truncated_by = TruncatedBy::Bytes;
            // Trailing blanks must not defeat the oversized-line rescue; keep as
            // many as the budget allows.
            if collected.iter().all(String::is_empty) {
                let kept_blanks = collected.len().min(max_bytes.saturating_sub(1));
                collected.truncate(kept_blanks);
                let truncated_line =
                    truncate_string_to_bytes_from_end(line, max_bytes - kept_blanks);
                output_bytes_count = truncated_line.len() + kept_blanks;
                collected.insert(0, truncated_line);
                last_line_partial = true;
            }
            break;
        }
        collected.insert(0, (*line).to_string());
        output_bytes_count += line_bytes;
    }

    if collected.len() >= max_lines && output_bytes_count <= max_bytes {
        truncated_by = TruncatedBy::Lines;
    }

    let output_content = collected.join("\n");
    let final_output_bytes = output_content.len();

    TruncationResult {
        content: output_content,
        truncated: true,
        truncated_by: Some(truncated_by),
        total_lines,
        total_bytes,
        output_lines: collected.len(),
        output_bytes: final_output_bytes,
        last_line_partial,
        first_line_exceeds_limit: false,
        max_lines,
        max_bytes,
    }
}

/// Truncate a string to fit within a byte limit (from the end).
/// Handles multi-byte UTF-8 characters correctly.
fn truncate_string_to_bytes_from_end(s: &str, max_bytes: usize) -> String {
    let bytes = s.as_bytes();
    if bytes.len() <= max_bytes {
        return s.to_string();
    }

    let mut start = bytes.len() - max_bytes;

    // Find a valid UTF-8 boundary (start of a character).
    while start < bytes.len() && (bytes[start] & 0xc0) == 0x80 {
        start += 1;
    }

    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

/// Truncate a single line to max UTF-16 code units, adding a `[truncated]` suffix.
/// Used for grep match lines.
pub fn truncate_line(line: &str, max_chars: usize) -> TruncatedLine {
    if line.chars().map(char::len_utf16).sum::<usize>() <= max_chars {
        return TruncatedLine {
            text: line.to_string(),
            was_truncated: false,
        };
    }
    let cut = utf16_truncate_end(line, max_chars);
    TruncatedLine {
        text: format!("{cut}... [truncated]"),
        was_truncated: true,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TruncatedLine {
    pub text: String,
    pub was_truncated: bool,
}

/// Slice `s` to its first `max_units` UTF-16 code units.
fn utf16_truncate_end(s: &str, max_units: usize) -> String {
    let mut units = 0usize;
    let mut end = 0usize;
    for ch in s.chars() {
        let w = ch.len_utf16();
        if units + w > max_units {
            break;
        }
        units += w;
        end += ch.len_utf8();
    }
    s[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_size_matches_ts() {
        assert_eq!(format_size(512), "512B");
        assert_eq!(format_size(1023), "1023B");
        assert_eq!(format_size(1024), "1.0KB");
        assert_eq!(format_size(50 * 1024), "50.0KB");
        assert_eq!(format_size(1024 * 1024), "1.0MB");
        assert_eq!(format_size(2 * 1024 * 1024 + 512 * 1024), "2.5MB");
    }

    #[test]
    fn head_within_limits_is_passthrough() {
        let r = truncate_head("a\nb\nc", TruncationOptions::default());
        assert!(!r.truncated);
        assert_eq!(r.content, "a\nb\nc");
        assert_eq!(r.total_lines, 3);
        assert_eq!(r.output_bytes, 5);
    }

    #[test]
    fn head_line_limit() {
        let r = truncate_head("a\nb\nc\nd", TruncationOptions::with_limits(2, 100));
        assert!(r.truncated);
        assert_eq!(r.truncated_by, Some(TruncatedBy::Lines));
        assert_eq!(r.content, "a\nb");
        assert_eq!(r.output_lines, 2);
    }

    #[test]
    fn head_first_line_exceeds_byte_limit() {
        let r = truncate_head("xxxxxxxxxx\ny", TruncationOptions::with_limits(10, 4));
        assert!(r.truncated);
        assert!(r.first_line_exceeds_limit);
        assert_eq!(r.content, "");
        assert_eq!(r.output_bytes, 0);
        assert_eq!(r.truncated_by, Some(TruncatedBy::Bytes));
    }

    #[test]
    fn tail_keeps_last_lines() {
        let r = truncate_tail("1\n2\n3\n4\n5", TruncationOptions::with_limits(2, 100));
        assert_eq!(r.content, "4\n5");
        assert_eq!(r.truncated_by, Some(TruncatedBy::Lines));
    }

    #[test]
    fn tail_byte_limit_no_partial() {
        // 20 lines of 10 bytes + newline each = 220 bytes total.
        let content: String = (0..20)
            .map(|i| format!("{i:010}"))
            .collect::<Vec<_>>()
            .join("\n");
        let r = truncate_tail(&content, TruncationOptions::with_limits(1000, 32));
        assert!(r.truncated);
        assert_eq!(r.truncated_by, Some(TruncatedBy::Bytes));
        assert!(!r.last_line_partial);
        assert!(r.output_bytes <= 32);
        assert!(r.content.ends_with(&content[content.len() - 21..]));
    }

    #[test]
    fn tail_partial_line_rescue() {
        let long = "x".repeat(100);
        let content = format!("\n\n{long}");
        let r = truncate_tail(&content, TruncationOptions::with_limits(10, 50));
        assert!(r.last_line_partial);
        assert_eq!(r.output_lines, 1);
        assert_eq!(r.content.len(), 50);
    }

    #[test]
    fn multi_byte_boundary_from_end() {
        // "héllo" - é is 2 bytes.
        let s = "héllo";
        let cut = truncate_string_to_bytes_from_end(s, 4);
        assert_eq!(cut, "llo");
    }

    #[test]
    fn truncate_line_utf16() {
        let r = truncate_line("short", 10);
        assert!(!r.was_truncated);
        let r = truncate_line("a".repeat(600).as_str(), 500);
        assert!(r.was_truncated);
        assert_eq!(r.text.len(), 500 + "... [truncated]".len());
    }
}
