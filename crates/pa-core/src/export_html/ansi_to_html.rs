//! ANSI escape code to HTML conversion for the export's custom-tool
//! pre-render: the terminal escape sequences a tool's line-oriented
//! renderer emits (foreground/background colors, 256-color palette, RGB
//! true color, bold/dim/italic/underline) become inline-styled `<span>`s
//! wrapped in `<div class="ansi-line">` rows, ready to embed in the
//! exported file's `renderedTools` section.
//!
//! Public seam: [`ToolHtmlRenderer`](super::tool_render::ToolHtmlRenderer)
//! implementers render their line-oriented output through
//! [`ansi_lines_to_html`] before returning it (the TS renderer converts at
//! the same step, `ansi-to-html.ts` inside the export-html module).

/// The 16-color palette (indices 0-15): standard 30-37/40-47 plus the
/// bright 90-97/100-107 variants.
const ANSI_COLORS: [&str; 16] = [
    "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
    "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
];

/// Convert a 256-color index to a hex color (the 6x6x6 cube and the
/// 24-step grayscale ramp).
fn color256_to_hex(index: u64) -> String {
    if index < 16 {
        return ANSI_COLORS[index as usize].to_string();
    }
    if index < 232 {
        let cube = index - 16;
        let to_component = |n: u64| if n == 0 { 0 } else { 55 + n * 40 };
        format!(
            "#{:02x}{:02x}{:02x}",
            to_component(cube / 36),
            to_component((cube % 36) / 6),
            to_component(cube % 6)
        )
    } else {
        let gray = 8 + (index - 232) * 10;
        format!("#{gray:02x}{gray:02x}{gray:02x}")
    }
}

/// Escape HTML special characters.
fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#039;")
}

/// The SGR state carried across one conversion.
#[derive(Debug, Default, PartialEq, Eq)]
struct TextStyle {
    fg: Option<String>,
    bg: Option<String>,
    bold: bool,
    dim: bool,
    italic: bool,
    underline: bool,
}

impl TextStyle {
    fn reset(&mut self) {
        *self = TextStyle::default();
    }

    fn is_plain(&self) -> bool {
        *self == TextStyle::default()
    }

    fn to_inline_css(&self) -> String {
        let mut parts = Vec::new();
        if let Some(fg) = &self.fg {
            parts.push(format!("color:{fg}"));
        }
        if let Some(bg) = &self.bg {
            parts.push(format!("background-color:{bg}"));
        }
        if self.bold {
            parts.push("font-weight:bold".to_string());
        }
        if self.dim {
            parts.push("opacity:0.6".to_string());
        }
        if self.italic {
            parts.push("font-style:italic".to_string());
        }
        if self.underline {
            parts.push("text-decoration:underline".to_string());
        }
        parts.join(";")
    }
}

/// Apply one SGR parameter list to the style (the subset the TS converter
/// supports: reset, bold/dim/italic/underline and their resets, standard
/// and bright fg/bg, 256-color `38;5;N`/`48;5;N`, RGB `38;2;R;G;B`/
/// `48;2;R;G;B`, and default-fg/bg resets).
fn apply_sgr(params: &[u64], style: &mut TextStyle) {
    let mut i = 0;
    while i < params.len() {
        let code = params[i];
        match code {
            0 => style.reset(),
            1 => style.bold = true,
            2 => style.dim = true,
            3 => style.italic = true,
            4 => style.underline = true,
            22 => {
                style.bold = false;
                style.dim = false;
            }
            23 => style.italic = false,
            24 => style.underline = false,
            30..=37 => style.fg = Some(ANSI_COLORS[(code - 30) as usize].to_string()),
            38 => {
                if params.get(i + 1) == Some(&5) && params.len() > i + 2 {
                    style.fg = Some(color256_to_hex(params[i + 2]));
                    i += 2;
                } else if params.get(i + 1) == Some(&2) && params.len() > i + 4 {
                    style.fg = Some(format!(
                        "rgb({},{},{})",
                        params[i + 2],
                        params[i + 3],
                        params[i + 4]
                    ));
                    i += 4;
                }
            }
            39 => style.fg = None,
            40..=47 => style.bg = Some(ANSI_COLORS[(code - 40) as usize].to_string()),
            48 => {
                if params.get(i + 1) == Some(&5) && params.len() > i + 2 {
                    style.bg = Some(color256_to_hex(params[i + 2]));
                    i += 2;
                } else if params.get(i + 1) == Some(&2) && params.len() > i + 4 {
                    style.bg = Some(format!(
                        "rgb({},{},{})",
                        params[i + 2],
                        params[i + 3],
                        params[i + 4]
                    ));
                    i += 4;
                }
            }
            49 => style.bg = None,
            90..=97 => style.fg = Some(ANSI_COLORS[(code - 90 + 8) as usize].to_string()),
            100..=107 => style.bg = Some(ANSI_COLORS[(code - 100 + 8) as usize].to_string()),
            _ => {}
        }
        i += 1;
    }
}

/// The SGR parameters of one escape: empty (`\x1b[m`) is a bare reset;
/// each `;`-separated piece parses as a number, non-numeric pieces are 0.
fn sgr_params(sequence: &str) -> Vec<u64> {
    if sequence.is_empty() {
        return vec![0];
    }
    sequence
        .split(';')
        .map(|piece| piece.parse::<u64>().unwrap_or(0))
        .collect()
}

/// Convert ANSI-escaped text to HTML with inline styles: every escape
/// closes the open span and reopens with the new style; plain text is
/// HTML-escaped between escapes. Only complete SGR sequences (ESC `[`
/// then digits/semicolons then `m`) convert — any other escape byte
/// passes through as escaped literal text, exactly like the TS regex
/// converter.
pub fn ansi_to_html(text: &str) -> String {
    let mut style = TextStyle::default();
    let mut result = String::new();
    let mut in_span = false;
    let mut rest = text;
    while let Some(start) = rest.find('\x1b') {
        let after = &rest[start + 1..];
        let Some(params) = after.strip_prefix('[') else {
            // No `[` follows the control byte: not an SGR escape.
            result.push_str(&escape_html(&rest[..start + 1]));
            rest = &rest[start + 1..];
            continue;
        };
        // The parameter run: digits and semicolons up to the `m`.
        let end = params.find(|c: char| !c.is_ascii_digit() && c != ';');
        let (params_str, terminated) = match end {
            Some(idx) => {
                let terminated = params.as_bytes()[idx] == b'm';
                (&params[..idx], terminated)
            }
            // Only digits/semicolons to the end: no closing `m`, so no
            // SGR sequence at this position.
            None => (params, false),
        };
        if !terminated {
            result.push_str(&escape_html(&rest[..start + 1]));
            rest = &rest[start + 1..];
            continue;
        }
        result.push_str(&escape_html(&rest[..start]));
        if in_span {
            result.push_str("</span>");
            in_span = false;
        }
        apply_sgr(&sgr_params(params_str), &mut style);
        if !style.is_plain() {
            result.push_str(&format!("<span style=\"{}\">", style.to_inline_css()));
            in_span = true;
        }
        rest = &rest[start + 2 + params_str.len() + 1..];
    }
    result.push_str(&escape_html(rest));
    if in_span {
        result.push_str("</span>");
    }
    result
}

/// Convert ANSI-escaped lines to HTML: each line is one
/// `<div class="ansi-line">` row; an empty line renders as `&nbsp;`.
pub fn ansi_lines_to_html(lines: &[String]) -> String {
    lines
        .iter()
        .map(|line| {
            let converted = ansi_to_html(line);
            if converted.is_empty() {
                "<div class=\"ansi-line\">&nbsp;</div>".to_string()
            } else {
                format!("<div class=\"ansi-line\">{converted}</div>")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Plain text passes through escaped.
    #[test]
    fn plain_text() {
        assert_eq!(ansi_to_html("hello"), "hello");
        assert_eq!(ansi_to_html("a < b & c"), "a &lt; b &amp; c");
    }

    /// A color escape opens a styled span that the final reset closes.
    #[test]
    fn color_spans() {
        assert_eq!(
            ansi_to_html("\x1b[31mred\x1b[0m"),
            "<span style=\"color:#800000\">red</span>"
        );
        // Bright variants and backgrounds.
        assert_eq!(
            ansi_to_html("\x1b[91;44mbold red on blue\x1b[0m"),
            "<span style=\"color:#ff0000;background-color:#000080\">bold red on blue</span>"
        );
    }

    /// Style escapes compose into one inline CSS list.
    #[test]
    fn text_styles() {
        assert_eq!(
            ansi_to_html("\x1b[1;3;4mbold italic underline\x1b[0m"),
            "<span style=\"font-weight:bold;font-style:italic;text-decoration:underline\">bold italic underline</span>"
        );
        // 22/23/24 reset the styles individually.
        assert_eq!(
            ansi_to_html("\x1b[1;4ma\x1b[24mb\x1b[0m"),
            "<span style=\"font-weight:bold;text-decoration:underline\">a</span><span style=\"font-weight:bold\">b</span>"
        );
    }

    /// 256-color palette and RGB true color.
    #[test]
    fn extended_colors() {
        assert_eq!(
            ansi_to_html("\x1b[38;5;196mx\x1b[0m"),
            "<span style=\"color:#ff0000\">x</span>"
        );
        // Grayscale ramp entry 240 -> 8 + 8*10 = 88.
        assert_eq!(
            ansi_to_html("\x1b[48;5;240mx\x1b[0m"),
            "<span style=\"background-color:#585858\">x</span>"
        );
        assert_eq!(
            ansi_to_html("\x1b[38;2;10;20;30mx\x1b[0m"),
            "<span style=\"color:rgb(10,20,30)\">x</span>"
        );
    }

    /// Default-fg/bg resets (39/49) and a bare escape both clear style.
    #[test]
    fn resets() {
        assert_eq!(
            ansi_to_html("\x1b[31;41ma\x1b[39;49mb\x1b[0m"),
            "<span style=\"color:#800000;background-color:#800000\">a</span>b"
        );
        assert_eq!(ansi_to_html("\x1b[mplain"), "plain");
    }

    /// A trailing style without a reset still closes its span.
    #[test]
    fn unclosed_span() {
        assert_eq!(
            ansi_to_html("\x1b[32mgreen"),
            "<span style=\"color:#008000\">green</span>"
        );
    }

    /// Lines wrap in ansi-line divs; blank lines become non-breaking spaces.
    #[test]
    fn lines() {
        let lines = vec!["\x1b[1mx\x1b[0m".to_string(), String::new()];
        assert_eq!(
            ansi_lines_to_html(&lines),
            "<div class=\"ansi-line\"><span style=\"font-weight:bold\">x</span></div><div class=\"ansi-line\">&nbsp;</div>"
        );
    }
}
