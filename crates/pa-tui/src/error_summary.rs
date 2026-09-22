//! Error-detail normalization and collapsing, a port of the TS
//! `collapsible-error.ts`: multi-line provider/tool errors render as a
//! one-line summary (the last non-stack-context line) while conversation
//! detail is below `all`, and expand to the full text in `all` mode.

use crate::theme::{Theme, ThemeColor};
use crate::width::{str_width, wrap_line};
use crate::{Line, Span};

/// `normalizeErrorDetails`: strip ANSI, normalize newlines, trim the end.
pub fn normalize_error_details(text: &str) -> String {
    let stripped = strip_ansi(text);
    let unified = stripped.replace("\r\n", "\n").replace('\r', "\n");
    unified.trim_end().to_string()
}

/// `strip-ansi`: remove CSI/OSC escape sequences.
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    // The sequence ends at its final byte (0x40..=0x7e).
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                // OSC ends at BEL or ST (ESC backslash).
                let mut last_was_esc = false;
                for c in chars.by_ref() {
                    if c == '\u{7}' {
                        break;
                    }
                    if last_was_esc && c == '\\' {
                        break;
                    }
                    last_was_esc = c == '\u{1b}';
                }
            }
            // Two-character escape sequences.
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out
}

/// `shouldCollapseErrorDetails`: multi-line errors collapse.
pub fn should_collapse_error_details(text: &str) -> bool {
    normalize_error_details(text).contains('\n')
}

/// `startsStackContext` (trimmed line): the leading rows of a traceback.
fn starts_stack_context(line: &str) -> bool {
    line.starts_with("Traceback ")
        || (line.starts_with("File ") && line.contains(", line "))
        || (line.starts_with("Cell In[") && line.contains(", line "))
        || line.starts_with("---->")
}

/// `isStackContextLine` (raw line, keeps leading whitespace).
fn is_stack_context_line(raw: &str) -> bool {
    starts_stack_context(raw.trim_start()) || raw.starts_with(' ') || raw.starts_with('\t')
}

/// `summarizeErrorDetails`: the first line, or the last non-stack-context
/// line when the error opens with a traceback.
pub fn summarize_error_details(text: &str) -> String {
    let normalized = normalize_error_details(text);
    let lines: Vec<&str> = normalized
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.is_empty() {
        return "Error".to_string();
    }
    if lines.len() > 1 && starts_stack_context(lines[0].trim()) {
        for line in lines.iter().rev() {
            if !is_stack_context_line(line) {
                return line.trim().to_string();
            }
        }
        return "Error".to_string();
    }
    lines[0].trim().to_string()
}

fn display_content(text: &str, summary: Option<&str>, expanded: bool) -> Option<String> {
    let text = normalize_error_details(text);
    if text.is_empty() {
        return None;
    }
    let collapsed = should_collapse_error_details(&text);
    let content = if collapsed && !expanded {
        let summary = match summary {
            Some(summary) => normalize_error_details(summary),
            None => summarize_error_details(&text),
        };
        format!("{summary} ")
    } else {
        text
    };
    Some(content)
}

/// Count the same normalized and collapsed content without painting rows.
pub(crate) fn collapsible_error_row_count(
    text: &str,
    summary: Option<&str>,
    expanded: bool,
    width: usize,
) -> usize {
    let Some(content) = display_content(text, summary, expanded) else {
        return 0;
    };
    content
        .split('\n')
        .map(|raw| {
            let spans = if raw.is_empty() {
                Vec::new()
            } else {
                vec![Span::raw(raw)]
            };
            crate::width::wrapped_line_count(&spans, width.saturating_sub(1).max(1))
        })
        .sum()
}

/// The collapsible error rows (`CollapsibleErrorComponent.render`): the
/// summary line while collapsed, the full text expanded; every row
/// one-space indented, wrapped at `width - 1`, padded with plain spaces.
pub fn render_collapsible_error(
    text: &str,
    summary: Option<&str>,
    expanded: bool,
    color: ThemeColor,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let Some(content) = display_content(text, summary, expanded) else {
        return Vec::new();
    };
    let style = theme.fg_style(color);
    let content_width = width.saturating_sub(1).max(1);
    let mut out: Vec<Line> = Vec::new();
    for raw in content.split('\n') {
        let styled: Line = if raw.is_empty() {
            Vec::new()
        } else {
            vec![Span::styled(raw.to_string(), style)]
        };
        for mut line in wrap_line(&styled, content_width) {
            let mut row: Line = vec![Span::raw(" ")];
            row.append(&mut line);
            let used: usize = row.iter().map(|s| str_width(&s.content)).sum();
            if used < width {
                row.push(Span::raw(" ".repeat(width - used)));
            }
            out.push(row);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_and_summarize() {
        let text = "Traceback (most recent call last):\n  File \"x.py\", line 1\nValueError: boom";
        assert_eq!(summarize_error_details(text), "ValueError: boom");
        assert!(should_collapse_error_details(text));
        assert!(!should_collapse_error_details("single line"));
        assert_eq!(normalize_error_details("a\r\nb\u{1b}[31m"), "a\nb");
        assert_eq!(
            strip_ansi("\u{1b}]8;;http://x\u{1b}\\link\u{1b}]8;;\u{1b}\\"),
            "link"
        );
    }
}
