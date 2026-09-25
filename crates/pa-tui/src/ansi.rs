//! ANSI encoding of styled lines (used by debug output and tests) and the
//! general-purpose ANSI stripper (TS `stripAnsi` in utils.ts).

use crate::{Line, Span};
use ratatui::style::{Color, Modifier};

/// Remove all escape sequences (CSI, OSC, DCS, APC/PM/SOS, and ordinary
/// two-char escapes), leaving plain text — the exact port of TS `stripAnsi`
/// (utils.ts:899): the common CSI form goes first (its regex fast path),
/// then the shared scanner (`escape_len`) handles the wider CSI grammar,
/// control strings, and malformed sequences. An ESC immediately before a
/// line separator stays (TS strips neither half of `ESC \n`).
pub fn strip_ansi(text: &str) -> String {
    if !text.contains('\u{1b}') {
        return text.to_string();
    }
    // TS COMMON_CSI_REGEX: `\x1b\[[0-9;:?<=>]*[\x40-\x7e]`, anywhere in the
    // string (including inside control strings — TS strips those too).
    let mut common_csi_stripped = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'[') {
            let mut j = i + 2;
            while j < bytes.len() && (0x30..=0x3f).contains(&bytes[j]) {
                j += 1;
            }
            if j < bytes.len() && (0x40..=0x7e).contains(&bytes[j]) {
                i = j + 1;
                continue;
            }
        }
        let c = text[i..].chars().next().expect("a char starts here");
        common_csi_stripped.push(c);
        i += c.len_utf8();
    }

    let input = common_csi_stripped;
    let mut result = String::with_capacity(input.len());
    let mut plain_start = 0usize;
    let mut escape_index = input.find('\u{1b}');
    while let Some(idx) = escape_index {
        if let Some(len) = crate::width::escape_len(&input[idx..]) {
            if plain_start < idx {
                result.push_str(&input[plain_start..idx]);
            }
            plain_start = idx + len;
        } else {
            let next = input[idx + 1..].chars().next();
            let strip_two =
                matches!(next, Some(c) if !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'));
            if strip_two {
                if plain_start < idx {
                    result.push_str(&input[plain_start..idx]);
                }
                plain_start = idx + 1 + next.expect("strip_two implies a char").len_utf8();
            }
        }
        let from = (idx + 1).max(plain_start);
        escape_index = input[from..].find('\u{1b}').map(|p| from + p);
    }
    if plain_start < input.len() {
        result.push_str(&input[plain_start..]);
    }
    result
}

fn fg_code(color: Color) -> Option<String> {
    Some(match color {
        Color::Reset => "39".to_string(),
        Color::Indexed(n) => format!("38;5;{n}"),
        Color::Rgb(r, g, b) => format!("38;2;{r};{g};{b}"),
        _ => return None,
    })
}

fn bg_code(color: Color) -> Option<String> {
    Some(match color {
        Color::Reset => "49".to_string(),
        Color::Indexed(n) => format!("48;5;{n}"),
        Color::Rgb(r, g, b) => format!("48;2;{r};{g};{b}"),
        _ => return None,
    })
}

/// Encode a line as an ANSI string with SGR sequences.
pub fn line_to_ansi(line: &Line) -> String {
    let mut out = String::new();
    let mut open = false;
    for span in line {
        let codes = sgr_codes(span);
        if let Some(codes) = codes {
            out.push_str(&format!("\x1b[{codes}m"));
            open = true;
        }
        out.push_str(&span.content);
    }
    if open {
        out.push_str("\x1b[0m");
    }
    out
}

fn sgr_codes(span: &Span) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if span.style.fg.is_some() || span.style.bg.is_some() || !span.style.add_modifier.is_empty() {
        if span.style.add_modifier.contains(Modifier::BOLD) {
            parts.push("1".into());
        }
        if span.style.add_modifier.contains(Modifier::ITALIC) {
            parts.push("3".into());
        }
        if span.style.add_modifier.contains(Modifier::UNDERLINED) {
            parts.push("4".into());
        }
        if span.style.add_modifier.contains(Modifier::CROSSED_OUT) {
            parts.push("9".into());
        }
        if span.style.add_modifier.contains(Modifier::REVERSED) {
            parts.push("7".into());
        }
        if span.style.add_modifier.contains(Modifier::DIM) {
            parts.push("2".into());
        }
        if let Some(fg) = span.style.fg.and_then(fg_code) {
            parts.push(fg);
        }
        if let Some(bg) = span.style.bg.and_then(bg_code) {
            parts.push(bg);
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(";"))
    }
}

/// Plain-text version of a line.
pub fn line_to_plain(line: &Line) -> String {
    line.iter().map(|s| s.content.as_str()).collect()
}

/// Render lines to an ANSI text block (with newlines). Pads to `width`.
pub fn lines_to_ansi_block(lines: &[Line], width: usize) -> String {
    let mut out = String::new();
    for line in lines {
        let padded = crate::width::pad_line(line.clone(), width);
        out.push_str(&line_to_ansi(&padded));
        out.push('\n');
    }
    out
}

pub fn raw_span(s: &str) -> Span {
    Span::raw(s.to_string())
}

#[cfg(test)]
mod tests {
    use super::strip_ansi;

    /// Goldens generated from the TS `stripAnsi` (utils.ts:899, the
    /// installed parity ground truth): the common CSI fast path, OSC-8
    /// (BEL- and ST-terminated), DCS, APC with astral content, SOS, the
    /// two-char rule, ESC-before-newline preserved, and malformed CSI
    /// (both halves of the leading `ESC [` go, the later valid CSI strips).
    #[test]
    fn strip_ansi_matches_ts_goldens() {
        let cases: Vec<(&str, &str)> = vec![
            ("a\u{1b}[31m你好\u{1b}[0mb", "a你好b"),
            (
                "\u{1b}]8;;http://例え.jp/\u{7}link\u{1b}]8;;\u{7}tail",
                "linktail",
            ),
            (
                "\u{1b}]8;;http://x\u{1b}\\link\u{1b}]8;;\u{1b}\\tail",
                "linktail",
            ),
            ("\u{1b}Pq...data...\u{1b}\\tail", "tail"),
            ("\u{1b}_apc😀\u{1b}\\tail", "tail"),
            ("a\u{1b}@bc", "abc"),
            ("a\u{1b}\u{a}b", "a\u{1b}\u{a}b"),
            ("a\u{1b}[13u", "a"),
            ("\u{1b}[\u{1b}[31mx", ""),
            ("\u{1b}X sos\u{1b}\\done", "done"),
        ];
        for (input, expected) in cases {
            assert_eq!(strip_ansi(input), expected, "strip mismatch for {input:?}");
        }
        // No escape codes: returned as-is.
        assert_eq!(strip_ansi("plain 你好"), "plain 你好");
    }
}
