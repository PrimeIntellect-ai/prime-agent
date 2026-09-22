//! Slash-command chat rows: the durable echo and result rows session commands
//! append (custom types `session_slash_command` /
//! `session_slash_command_result`). Both share the user-message block
//! geometry — `Box(2,1)` on the `userMessageBg` surface — with the echo's
//! `/name` token in `accent` and `@path` / `--flag` argument tokens in
//! `success` / `mdLink` (prompt-highlight token styling).

use crate::theme::{Theme, ThemeBg};
use crate::width::{str_width, wrap_text};
use crate::{Line, Span};
use ratatui::style::Style;

/// `Box(2,1)` content width: 2 columns of padding on each side, matching
/// the user-message block.
fn content_width(width: usize) -> usize {
    width.saturating_sub(4).max(1)
}

/// One block row: 2-col padding, spans, padded to the full width on the
/// block background. Every content span carries that background: the TS
/// `Box` paints it over the whole row, so a fg-only styled token must not
/// open a transparent gap in the block.
fn block_row(spans: Line, bg: Style, width: usize) -> Line {
    let mut row: Line = vec![Span::styled("  ".to_string(), bg)];
    for mut span in spans {
        if let Some(color) = bg.bg {
            span.style = span.style.bg(color);
        }
        row.push(span);
    }
    let used: usize = row.iter().map(|s| str_width(&s.content)).sum();
    row.push(Span::styled(" ".repeat(width.saturating_sub(used)), bg));
    row
}

/// The block layout: blank surface row, content rows, blank surface row.
fn wrap_block(
    text: &str,
    theme: &Theme,
    width: usize,
    style_row: impl Fn(&str) -> Line,
) -> Vec<Line> {
    let bg = theme.bg_style(ThemeBg::UserMessageBg);
    let mut rows = vec![vec![Span::styled(" ".repeat(width), bg)]];
    let wrapped = wrap_text(text, content_width(width));
    if wrapped.is_empty() {
        rows.push(block_row(Vec::new(), bg, width));
    }
    for line in wrapped {
        let plain: String = line.iter().map(|s| s.content.as_str()).collect();
        rows.push(block_row(style_row(&plain), bg, width));
    }
    rows.push(vec![Span::styled(" ".repeat(width), bg)]);
    rows
}

/// The command echo row: the full typed command, laid out like a user
/// message. TS `styleSlashCommandText` + `Text`: the `/name` command
/// segment renders in `accent` (the whole text when the row is not a slash
/// command); `@path` and `--flag` argument tokens highlight in `success`
/// and `mdLink`, a bare `--` separator only for argument-taking commands;
/// the styled text then wraps, so a token split by a line break keeps its
/// color on both halves.
pub fn render_slash_command(text: &str, theme: &Theme, width: usize) -> Vec<Line> {
    let bg = theme.bg_style(ThemeBg::UserMessageBg);
    // The styled source line: the accent and token spans over the typed
    // text (default foreground between them, TS `styleOther` identity).
    let mut styled: Line = Vec::new();
    let mut offset = 0usize;
    for span in crate::prompt_highlight::slash_command_source_spans(text) {
        if span.start > offset {
            styled.push(Span::raw(crate::prompt_highlight::char_slice(
                text, offset, span.start,
            )));
        }
        styled.push(theme.fg(
            span.color,
            crate::prompt_highlight::char_slice(text, span.start, span.end),
        ));
        offset = span.end;
    }
    let total = text.chars().count();
    if offset < total {
        styled.push(Span::raw(crate::prompt_highlight::char_slice(
            text, offset, total,
        )));
    }
    // Wrap the styled line (TS wraps the styled string), splitting on the
    // source newlines like `wrapTextWithAnsi` splits input lines.
    let mut paragraphs: Vec<Line> = vec![Vec::new()];
    for span in &styled {
        for (index, part) in span.content.split('\n').enumerate() {
            if index > 0 {
                paragraphs.push(Vec::new());
            }
            if !part.is_empty() {
                paragraphs
                    .last_mut()
                    .expect("paragraph list starts non-empty")
                    .push(Span::styled(part, span.style));
            }
        }
    }
    let mut rows = vec![vec![Span::styled(" ".repeat(width), bg)]];
    let mut wrapped_any = false;
    for paragraph in &paragraphs {
        for line in crate::width::wrap_line(paragraph, content_width(width)) {
            rows.push(block_row(line, bg, width));
            wrapped_any = true;
        }
    }
    if !wrapped_any {
        rows.push(block_row(Vec::new(), bg, width));
    }
    rows.push(vec![Span::styled(" ".repeat(width), bg)]);
    // Zone markers on the echo block (TS `SlashCommandMessageComponent`);
    // result rows render unmarked.
    if let Some(first) = rows.first_mut() {
        crate::osc133::mark_start(first);
    }
    if let Some(last) = rows.last_mut() {
        crate::osc133::mark_end(last);
    }
    rows
}

/// The result row: plain content, default foreground on the block surface.
pub fn render_slash_command_result(content: &str, theme: &Theme, width: usize) -> Vec<Line> {
    let style_row = |row: &str| -> Line {
        if row.is_empty() {
            Vec::new()
        } else {
            vec![Span::raw(row.to_string())]
        }
    };
    wrap_block(content, theme, width, style_row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::osc133;
    use crate::theme::{ColorMode, Theme, ThemeColor};

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn plain(rows: &[Line]) -> Vec<String> {
        rows.iter()
            .map(|l| l.iter().map(|s| s.content.as_str()).collect::<String>())
            .collect()
    }

    #[test]
    fn echo_row_uses_block_geometry() {
        let rows = render_slash_command("/goal status", &theme(), 40);
        // The echo block carries the zone markers (TS marks the echo but
        // never the result row).
        assert!(osc133::row_markers(&rows[0]).start);
        assert!(osc133::row_markers(&rows[2]).end);
        assert_eq!(
            plain(&rows),
            vec![
                osc133::ZONE_START.to_string() + &" ".repeat(40),
                format!("  {}  ", "/goal status") + &" ".repeat(40 - 2 - 12 - 2),
                osc133::ZONE_END_PREFIX.to_string() + &" ".repeat(40),
            ]
        );
    }

    #[test]
    fn echo_row_wraps_long_args() {
        let rows = render_slash_command("/goal make the verifier pass everywhere", &theme(), 30);
        let text = plain(&rows);
        assert_eq!(text.len(), 4);
        assert!(text[1].starts_with("  /goal make the verifier"));
        assert!(text[2].starts_with("  pass everywhere"));
    }

    #[test]
    fn result_row_renders_content() {
        let rows = render_slash_command_result("Goal active: ship it", &theme(), 40);
        let text = plain(&rows);
        assert_eq!(text.len(), 3);
        assert!(text[1].contains("Goal active: ship it"));
    }

    fn spans_of(row: &Line) -> Vec<(String, Style)> {
        row.iter()
            .map(|s| (s.content.to_string(), s.style))
            .collect()
    }

    /// The styled spans of one render at `Style` level: token colors on
    /// the block background (the block paints the whole row) and the
    /// default foreground on it between the tokens.
    fn echo_styles() -> (Style, Style, Style, Style, Style) {
        let theme = theme();
        let bg = theme
            .bg_style(ThemeBg::UserMessageBg)
            .bg
            .expect("the user-message background is set");
        let on_bg = |style: Style| Style::default().bg(bg).patch(style);
        (
            on_bg(theme.fg_style(ThemeColor::Accent)),
            on_bg(theme.fg_style(ThemeColor::Success)),
            on_bg(theme.fg_style(ThemeColor::MdLink)),
            Style::default().bg(bg),
            theme.bg_style(ThemeBg::UserMessageBg),
        )
    }

    #[test]
    fn echo_row_styles_command_and_tokens_like_ts() {
        // TS `styleSlashCommandText`: accent on the leading `/name`,
        // default foreground between, `success`/`mdLink` on the tokens.
        let (accent, success, md_link, plain, pad) = echo_styles();
        let rows = render_slash_command("/compact fix @Cargo.toml --quiet", &theme(), 60);
        let styled = spans_of(&rows[1]);
        assert_eq!(
            styled,
            vec![
                ("  ".to_string(), pad),
                ("/compact".to_string(), accent),
                (" fix ".to_string(), plain),
                ("@Cargo.toml".to_string(), success),
                (" ".to_string(), plain),
                ("--quiet".to_string(), md_link),
                (" ".repeat(26), pad),
            ]
        );
        // The whole text accents when the row is not a slash command (TS
        // falls back to `commandEnd = text.length`).
        let rows = render_slash_command("plain echo text", &theme(), 60);
        let styled = spans_of(&rows[1]);
        assert_eq!(
            styled,
            vec![
                ("  ".to_string(), pad),
                ("plain echo text".to_string(), accent),
                (" ".repeat(43), pad),
            ]
        );
        // An unrecognized leading `/name` still accents (the echo styles
        // the typed command, not the registry); its bare `--` does not.
        let rows = render_slash_command("/nope x -- y", &theme(), 60);
        let styled = spans_of(&rows[1]);
        assert!(
            styled.iter().any(|(t, s)| t == "/nope" && *s == accent),
            "unrecognized commands accent: {styled:?}"
        );
        assert!(
            !styled.iter().any(|(t, _)| t == "--"),
            "a no-argument command does not get the separator pattern: {styled:?}"
        );
    }

    #[test]
    fn echo_row_token_forms_follow_the_engine_pattern() {
        let (_, success, md_link, _, _) = echo_styles();
        // Quoted @-paths keep their spaces.
        let rows = render_slash_command(r#"/new @"my file" --draft"#, &theme(), 60);
        let styled = spans_of(&rows[1]);
        assert!(
            styled
                .iter()
                .any(|(t, s)| t == "@\"my file\"" && *s == success),
            "quoted @path keeps its spaces: {styled:?}"
        );
        assert!(styled.iter().any(|(t, s)| t == "--draft" && *s == md_link));
        // A bare `--` highlights for argument-taking commands.
        let rows = render_slash_command("/new x -- y", &theme(), 60);
        let styled = spans_of(&rows[1]);
        assert!(styled.iter().any(|(t, s)| t == "--" && *s == md_link));
    }

    #[test]
    fn echo_row_keeps_token_color_across_the_wrap() {
        // A long token split by the wrap keeps its color on both halves
        // (TS wraps the styled string, not the plain text): at content
        // width 16 the 23-char token breaks into two colored chunks.
        let rows = render_slash_command("/new @01234567890123456789012 tail", &theme(), 20);
        let (_, success, _, _, _) = echo_styles();
        let styled: Vec<Vec<(String, Style)>> = rows.iter().map(spans_of).collect();
        let token_parts: Vec<String> = styled
            .iter()
            .flatten()
            .filter(|(_, s)| *s == success)
            .map(|(t, _)| t.clone())
            .collect();
        assert_eq!(
            token_parts,
            vec!["@012345678901234".to_string(), "56789012".to_string()]
        );
        assert!(
            styled
                .iter()
                .flatten()
                .any(|(t, s)| t == "tail" && *s != success),
            "the plain word after the token stays default-fg: {styled:?}"
        );
    }
}
