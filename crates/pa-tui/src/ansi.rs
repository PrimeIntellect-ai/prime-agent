//! ANSI encoding of styled lines (used by debug output and tests).

use crate::{Line, Span};
use ratatui::style::{Color, Modifier};

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
