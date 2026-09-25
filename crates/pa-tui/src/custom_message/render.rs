//! Custom-message row rendering: each component's row geometry and theme
//! colors, ported from the TS interactive components (`agent-message.ts`,
//! `injected-prompt-message.ts`, `shell-completion.ts`, `custom-message.ts`,
//! `skill-invocation-message.ts`;
//! `expandable-event-message.ts` + `refinement-outcome-message.ts` live in
//! the sibling `refinement` module, `compaction-outcome-message.ts` renders
//! through the chat status rows).

use super::{
    AGENT_MESSAGE_LABEL, AgentMessageDirection, AgentMessageRow, CustomPanelRow, ShellCompletionRow,
};
use crate::chat::Detail;
use crate::theme::{Theme, ThemeBg, ThemeColor};
use crate::width::{pad_line, str_width, truncate_line, wrap_line, wrap_text};
use crate::{Line, Span};
use ratatui::style::Style;

/// One blank row (`Spacer(1)`).
pub(crate) fn spacer() -> Line {
    Vec::new()
}

/// A `Text(spans, 1, 0)` row set: content wrapped at `width - 2`, one margin
/// column, padded to the full width with the default style.
pub(crate) fn text_rows(spans: Line, width: usize) -> Vec<Line> {
    let content_width = width.saturating_sub(2).max(1);
    let flat: String = spans.iter().map(|s| s.content.as_str()).collect();
    if flat.trim().is_empty() {
        return Vec::new();
    }
    wrap_line(&spans, content_width)
        .into_iter()
        .map(|wrapped| {
            let mut row: Line = vec![Span::raw(" ")];
            row.extend(wrapped);
            pad_line(row, width)
        })
        .collect()
}

/// Markdown rows at `Markdown(text, 1, 0)` geometry (the assistant-block
/// layout): rendered at `width - 2`, one margin column, padded with the
/// default style.
pub(crate) fn markdown_rows(
    text: &str,
    body_color: ThemeColor,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let content_width = width.saturating_sub(2).max(1);
    let md = super::geometry::markdown_style(body_color, theme);
    crate::markdown::render_markdown(text, content_width, &md)
        .into_iter()
        .map(|line| {
            let mut row: Line = vec![Span::raw(" ")];
            row.extend(line);
            pad_line(row, width)
        })
        .collect()
}

/// TS `agentMessageSummaryLine` (`◆ <label> · <participant>`) with the
/// operator's sanctioned divergences: the row's icon is the `✉` mail
/// envelope (Kevin directive 2026-09-24 — the a2a rows read as agent
/// mail; the TS side is expected to adopt the same glyph) rendered green
/// (the operator's 2026-09-24 directive: "mail envelope glyph GREEN not
/// purple") — the Success color, the palette's green. The label is the
/// shared `Agent message` and the participant renders the viewer-relative
/// arrow plus the counterpart agent's name (the operator's 2026-09-25
/// arrow directive: "↓ for received and ↑ for sent/queued ... Display
/// only `Agent message` + arrow + counterpart agent name"): the arrow
/// comes from the row's actual direction — `↑` on sent and queued rows
/// (this chat's outgoing mail), `↓` on received ones (incoming) — never
/// parsed out of a participant or body string, and the direction word,
/// the relationship word, and the body preview never render (the TS
/// header carries no preview either).
pub(crate) fn agent_message_summary_line(
    direction: AgentMessageDirection,
    counterpart: &str,
    theme: &Theme,
) -> Line {
    let arrow = match direction {
        AgentMessageDirection::Received => "\u{2193}",
        AgentMessageDirection::Sent | AgentMessageDirection::Queued => "\u{2191}",
    };
    vec![
        Span::styled("\u{2709}".to_string(), theme.fg_style(ThemeColor::Success)),
        Span::raw(" "),
        Span::styled(
            AGENT_MESSAGE_LABEL.to_string(),
            theme.fg_style(ThemeColor::Muted),
        ),
        Span::styled(" \u{b7} ".to_string(), theme.fg_style(ThemeColor::Dim)),
        Span::styled(
            format!("{arrow} {counterpart}"),
            theme.fg_style(ThemeColor::Dim),
        ),
    ]
}

/// The received agent-message rows (TS `AgentMessageComponent`): a leading
/// blank (spacing-driven), the summary header (no body preview — the
/// collapsed row is the summary alone), and the `╰─`-guttered body when
/// expanded.
pub(crate) fn render_agent_message(
    row: &AgentMessageRow,
    detail: Detail,
    theme: &Theme,
    width: usize,
    leading: bool,
) -> Vec<Line> {
    let mut out = Vec::new();
    if leading {
        out.push(spacer());
    }
    let header = agent_message_summary_line(row.direction, &row.counterpart, theme);
    out.extend(text_rows(header, width));
    if detail.tool_output_expanded() {
        out.extend(agent_message_body(&row.message, theme, width));
    }
    out
}

/// TS `agentMessageBodyLines`: each source line wraps at `width - 4`, the
/// first rendered line carries the `╰─ ` gutter, the rest three spaces, all
/// in `customMessageText`, truncated to the width.
pub(crate) fn agent_message_body(message: &str, theme: &Theme, width: usize) -> Vec<Line> {
    let safe_width = width.max(1);
    let text_width = super::geometry::agent_body_width(width);
    let body = theme.fg_style(ThemeColor::CustomMessageText);
    let mut lines: Vec<Line> = Vec::new();
    for source in message.split('\n') {
        let wrapped = wrap_text(source, text_width);
        for line in wrapped {
            lines.push(line);
        }
    }
    if lines.is_empty() {
        lines.push(Vec::new());
    }
    let dim = theme.fg_style(ThemeColor::Dim);
    lines
        .into_iter()
        .enumerate()
        .map(|(index, line)| {
            // TS: the first rendered line carries the dim `╰─ ` gutter,
            // continuation lines three unstyled spaces.
            let mut row: Line = vec![Span::raw(" ")];
            if index == 0 {
                row.push(Span::styled("\u{2570}\u{2500} ".to_string(), dim));
            } else {
                row.push(Span::raw("   "));
            }
            for span in line {
                row.push(Span::styled(span.content, body));
            }
            truncate_line(&row, safe_width, "")
        })
        .collect()
}

/// Plain-text truncate (`truncateToWidth` over unstyled text) with an
/// explicit ellipsis.
pub(crate) fn truncate_text(text: &str, width: usize, ellipsis: &str) -> String {
    let line: Line = vec![Span::raw(text.to_string())];
    let truncated = truncate_line(&line, width, ellipsis);
    truncated
        .iter()
        .map(|s| s.content.as_str())
        .collect::<String>()
}

/// One shell-completion row (TS `ShellCompletionComponent`, standalone form).
pub(crate) fn render_shell_completion(
    row: &ShellCompletionRow,
    detail: Detail,
    theme: &Theme,
    width: usize,
    leading: bool,
) -> Vec<Line> {
    let failed = matches!(row.exit_code, Some(code) if code != 0);
    let color = if failed {
        theme.fg_style(ThemeColor::Error)
    } else {
        theme.fg_style(ThemeColor::Muted)
    };
    let label = if let (Some(code), true) = (row.exit_code, failed) {
        format!("Background shell command failed \u{b7} exit {code}")
    } else {
        "Background shell command finished".to_string()
    };
    let mark = if failed { "\u{2717}" } else { "\u{2713}" };
    let header = truncate_line(
        &vec![Span::styled(format!(" {mark} {label}"), color)],
        width,
        "",
    );
    let mut out = Vec::new();
    if leading {
        out.push(spacer());
    }
    out.push(header);
    if detail.tool_output_expanded() {
        // TS `Text(raw, 1, 0)`: one row per input line at the content width;
        // an empty line keeps its margins-only row.
        for line in row.content.split('\n') {
            if line.trim().is_empty() {
                out.push(vec![Span::raw(" ".repeat(width))]);
            } else {
                out.extend(text_rows(vec![Span::raw(line.to_string())], width));
            }
        }
    }
    out
}

/// Pad a rendered line to the full width with a base style (TS
/// `theme.bg` over `padToWidth`).
pub(crate) fn pad_with(mut line: Line, width: usize, base: Style) -> Line {
    let used: usize = line.iter().map(|s| str_width(&s.content)).sum();
    if used < width {
        line.push(Span::styled(" ".repeat(width - used), base));
    }
    line
}

/// One generic custom row (TS `CustomMessageComponent`): a leading blank,
/// then a `Box(1,1)` on `customMessageBg` holding the bold `[<customType>]`
/// label in `customMessageLabel` and the markdown body in
/// `customMessageText`.
pub(crate) fn render_custom_panel(row: &CustomPanelRow, theme: &Theme, width: usize) -> Vec<Line> {
    let bg = theme.bg_style(ThemeBg::CustomMessageBg);
    let blank = vec![Span::styled(" ".repeat(width), bg)];
    let mut out = vec![spacer(), blank.clone()];
    let content_width = width.saturating_sub(2).max(1);
    let label = Span::styled(
        format!("[{}]", row.custom_type),
        theme
            .fg_style(ThemeColor::CustomMessageLabel)
            .add_modifier(ratatui::style::Modifier::BOLD),
    );
    out.push(box_row(vec![label], bg, width));
    // The box's internal `Spacer(1)`: one blank surface row.
    out.push(blank.clone());
    if !row.content.trim().is_empty() {
        let md = super::geometry::custom_panel_style(theme);
        for line in crate::markdown::render_markdown(&row.content, content_width, &md) {
            out.push(box_row(line, bg, width));
        }
    }
    out.push(blank);
    out
}

/// One box content row: left padding column, content spans (bg-patched),
/// padded to the full width on the box background (TS `Box.applyBg` covers
/// the whole row, trailing padding included).
fn box_row(spans: Line, bg: Style, width: usize) -> Line {
    let mut row: Line = vec![Span::styled(" ".to_string(), bg)];
    for span in spans {
        row.push(Span::styled(span.content, span.style.patch(bg)));
    }
    pad_with(row, width, bg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::Detail;
    use crate::theme::{ColorMode, Theme};
    use crate::Span;

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn flat(row: &Line) -> String {
        row.iter().map(|s| s.content.as_str()).collect()
    }

    #[test]
    fn agent_message_header_shape() {
        let row = AgentMessageRow {
            direction: AgentMessageDirection::Received,
            counterpart: "model-probe".to_string(),
            message: "ready".to_string(),
        };
        let rows = render_agent_message(&row, Detail::Overview, &theme(), 60, true);
        // Leading blank + the envelope summary line, no body preview.
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert!(rows[0].is_empty());
        let header = flat(&rows[1]);
        assert_eq!(
            header.trim_end(),
            " \u{2709} Agent message \u{b7} \u{2193} model-probe"
        );
        // The collapsed row never carries the body text.
        assert!(!header.contains("ready"), "no preview: {header:?}");
        // Colors: green envelope (the operator's 2026-09-24 directive),
        // muted label, dim viewer-relative arrow plus name, and the
        // separator.
        let green = theme().fg_style(ThemeColor::Success);
        let muted = theme().fg_style(ThemeColor::Muted);
        let dim = theme().fg_style(ThemeColor::Dim);
        assert_eq!(rows[1][0], Span::styled(" ".to_string(), Style::default()));
        assert_eq!(rows[1][1], Span::styled("\u{2709}".to_string(), green));
        assert_eq!(rows[1][3], Span::styled("Agent message".to_string(), muted));
        assert_eq!(rows[1][4], Span::styled(" \u{b7} ".to_string(), dim));
        assert_eq!(
            rows[1][5],
            Span::styled("\u{2193} model-probe".to_string(), dim)
        );
    }

    #[test]
    fn agent_message_header_never_carries_the_body() {
        // An empty body and a long body render the SAME collapsed header:
        // no preview, no ellipsis (the operator's 2026-09-25 directive).
        for message in ["  \n  ".to_string(), format!("{} end", "word ".repeat(20))] {
            let row = AgentMessageRow {
                direction: AgentMessageDirection::Received,
                counterpart: "root".to_string(),
                message,
            };
            let rows = render_agent_message(&row, Detail::Overview, &theme(), 60, false);
            assert_eq!(rows.len(), 1, "one header row: {rows:?}");
            let header = flat(&rows[0]).trim_end().to_string();
            assert_eq!(header, " \u{2709} Agent message \u{b7} \u{2193} root");
            assert!(!header.contains("word"), "no preview: {header:?}");
            assert!(!header.contains("\u{2026}"), "no ellipsis: {header:?}");
        }
    }

    /// The arrow is viewer-relative (the operator's 2026-09-25 directive):
    /// `↑` on sent and queued rows (this chat's outgoing mail), `↓` on
    /// received ones (incoming). The arrow comes from the row's actual
    /// direction and the collapsed row carries the shared `Agent message`
    /// label plus the arrow and counterpart name only.
    #[test]
    fn agent_message_arrows_follow_the_row_direction() {
        for (direction, arrow) in [
            (AgentMessageDirection::Received, "\u{2193}"),
            (AgentMessageDirection::Sent, "\u{2191}"),
            (AgentMessageDirection::Queued, "\u{2191}"),
        ] {
            let row = AgentMessageRow {
                direction,
                counterpart: "worker".to_string(),
                message: "ping".to_string(),
            };
            let rows = render_agent_message(&row, Detail::Overview, &theme(), 80, false);
            let header = flat(&rows[0]);
            assert!(
                header.contains(&format!("\u{2709} Agent message \u{b7} {arrow} worker")),
                "{direction:?} header: {header}"
            );
            assert!(
                !header.contains("ping"),
                "the body never leaks into the collapsed row: {header}"
            );
        }
    }

    #[test]
    fn agent_message_body_gutter_when_expanded() {
        let row = AgentMessageRow {
            direction: AgentMessageDirection::Received,
            counterpart: "root".to_string(),
            message: "line one\nline two".to_string(),
        };
        let rows = render_agent_message(&row, Detail::All, &theme(), 60, false);
        // No leading blank (spacing decided otherwise), header, two body rows.
        assert_eq!(rows.len(), 3, "{rows:?}");
        assert_eq!(flat(&rows[1]), " \u{2570}\u{2500} line one");
        assert_eq!(flat(&rows[2]), "    line two");
        let dim = theme().fg_style(ThemeColor::Dim);
        let body = theme().fg_style(ThemeColor::CustomMessageText);
        // The first rendered line carries the dim gutter, continuation rows
        // three unstyled spaces, both bodies in `customMessageText`.
        assert_eq!(
            rows[1][1],
            Span::styled("\u{2570}\u{2500} ".to_string(), dim)
        );
        assert_eq!(rows[2][1], Span::raw("   "));
        assert!(rows[1]
            .iter()
            .any(|span| span.content == "line one" && span.style == body));
    }

    #[test]
    fn shell_completion_rows() {
        let ok = ShellCompletionRow {
            pid: Some(4371),
            exit_code: Some(0),
            content: "[bash-done pid:4371 exit:0]".to_string(),
        };
        let rows = render_shell_completion(&ok, Detail::Overview, &theme(), 60, true);
        assert!(rows[0].is_empty());
        assert_eq!(
            flat(&rows[1]),
            " \u{2713} Background shell command finished"
        );
        assert_eq!(
            rows[1][0].style,
            theme().fg_style(ThemeColor::Muted),
            "muted when exit 0"
        );
        let failed = ShellCompletionRow {
            pid: Some(11),
            exit_code: Some(2),
            content: "[bash-done pid:11 exit:2]".to_string(),
        };
        let rows = render_shell_completion(&failed, Detail::Overview, &theme(), 60, false);
        assert_eq!(rows.len(), 1);
        assert_eq!(
            flat(&rows[0]),
            " \u{2717} Background shell command failed \u{b7} exit 2"
        );
        assert_eq!(
            rows[0][0].style,
            theme().fg_style(ThemeColor::Error),
            "error when failed"
        );
    }

    #[test]
    fn custom_panel_box_shape() {
        let row = CustomPanelRow {
            custom_type: "autonomous_status".to_string(),
            content: "[autonomous-status: on]".to_string(),
        };
        let rows = render_custom_panel(&row, &theme(), 40);
        // Blank, bg row, label row, blank, content row, bg row.
        assert_eq!(rows.len(), 6, "{rows:?}");
        assert!(rows[0].is_empty());
        let bg = theme().bg_style(ThemeBg::CustomMessageBg);
        assert_eq!(rows[1][0].style, bg);
        let label_row = flat(&rows[2]);
        assert_eq!(label_row.trim_end(), " [autonomous_status]");
        assert!(
            rows[2][0].style.bg.is_some(),
            "label row carries the box bg"
        );
        assert!(rows[2][1]
            .style
            .add_modifier
            .contains(ratatui::style::Modifier::BOLD));
        assert_eq!(
            rows[2][1].style.fg,
            theme().fg_style(ThemeColor::CustomMessageLabel).fg
        );
        assert_eq!(flat(&rows[4]).trim_end(), " [autonomous-status: on]");
        assert_eq!(
            rows[4][1].style.fg,
            theme().fg_style(ThemeColor::CustomMessageText).fg
        );
    }
}
