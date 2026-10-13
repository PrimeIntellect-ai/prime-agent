//! Custom-message row rendering: each component's row geometry and theme
//! colors. The refinement components live in the sibling `refinement`
//! module; compaction outcomes render through the chat status rows.

use super::{
    AgentMessageDirection, AgentMessageRow, CustomPanelRow, ShellCompletionRow, AGENT_MESSAGE_LABEL,
};
use crate::chat::Detail;
use crate::theme::{Theme, ThemeColor};
use crate::width::{pad_line, str_width, truncate_line, wrap_line, wrap_text};
use crate::{Line, Span};
use ratatui::style::Style;

pub(crate) fn spacer() -> Line {
    Vec::new()
}

/// The bold `[<name>]` label shared by the skill card and the generic
/// custom panel.
pub(crate) fn custom_message_label(name: &str, theme: &Theme) -> Span {
    Span::styled(
        format!("[{name}]"),
        theme
            .fg_style(ThemeColor::CustomMessageLabel)
            .add_modifier(ratatui::style::Modifier::BOLD),
    )
}

/// A `Text(spans, 1, 0)` row set: content wrapped at `width - 2`, one margin
/// column, padded to the full width with the default style.
pub(crate) fn text_rows(spans: &Line, width: usize) -> Vec<Line> {
    let content_width = width.saturating_sub(2).max(1);
    let flat: String = spans.iter().map(|s| s.content.as_str()).collect();
    if flat.trim().is_empty() {
        return Vec::new();
    }
    wrap_line(spans, content_width)
        .into_iter()
        .map(|wrapped| {
            let mut row: Line = vec![Span::raw(" ")];
            row.extend(wrapped);
            pad_line(row, width)
        })
        .collect()
}

/// The `✉ <label> · <participant>` summary line, with sanctioned divergences from TS:
/// the `✉` mail envelope (Kevin directive 2026-09-24) renders green (operator directive
/// 2026-09-24), and the participant is the viewer-relative arrow plus the counterpart's
/// name (operator directive 2026-09-25).
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

/// The received agent-message rows: a leading blank (spacing-driven), the summary header
/// (no body preview), and the `╰─`-guttered body when expanded.
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
    out.extend(text_rows(&header, width));
    if detail.tool_output_expanded() {
        out.extend(agent_message_body(&row.message, theme, width));
    }
    out
}

/// Each source line wraps at `width - 4`: the first rendered line carries
/// the `╰─ ` gutter, the rest three spaces, all in `customMessageText`.
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
            // The first rendered line carries the dim `╰─ ` gutter,
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

/// Plain-text truncate with an explicit ellipsis.
pub(crate) fn truncate_text(text: &str, width: usize, ellipsis: &str) -> String {
    let line: Line = vec![Span::raw(text.to_string())];
    let truncated = truncate_line(&line, width, ellipsis);
    truncated
        .iter()
        .map(|s| s.content.as_str())
        .collect::<String>()
}

/// One shell-completion row, standalone form: the header mark, then the
/// raw content under the branch gutter when expanded.
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
        out.extend(crate::branch::branch_block(
            &vec![Span::raw(row.content.clone())],
            theme,
            width,
        ));
    }
    out
}

/// Pad a rendered line to the full width with a base style.
pub(crate) fn pad_with(mut line: Line, width: usize, base: Style) -> Line {
    let used: usize = line.iter().map(|s| str_width(&s.content)).sum();
    if used < width {
        line.push(Span::styled(" ".repeat(width - used), base));
    }
    line
}

/// One generic custom row: a leading blank, the bold `[<customType>]` label, then the
/// always-shown markdown body in `customMessageText` under the branch gutter.
pub(crate) fn render_custom_panel(row: &CustomPanelRow, theme: &Theme, width: usize) -> Vec<Line> {
    let md = super::geometry::markdown_style(ThemeColor::CustomMessageText, theme);
    let mut out = vec![spacer()];
    out.extend(text_rows(
        &vec![custom_message_label(&row.custom_type, theme)],
        width,
    ));
    out.extend(crate::branch::branch_markdown(
        &row.content,
        &md,
        theme,
        width,
    ));
    out
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
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert!(rows[0].is_empty());
        let header = flat(&rows[1]);
        assert_eq!(
            header.trim_end(),
            " \u{2709} Agent message \u{b7} \u{2193} model-probe"
        );
        assert!(!header.contains("ready"), "no preview: {header:?}");
        // Colors: green envelope, muted label, dim viewer-relative arrow
        // plus name.
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
        // An empty body and a long body render the SAME collapsed header.
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

    /// The arrow comes from the row's actual direction, never parsed out of a string.
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
        assert_eq!(rows.len(), 3, "{rows:?}");
        assert_eq!(flat(&rows[1]), " \u{2570}\u{2500} line one");
        assert_eq!(flat(&rows[2]), "    line two");
        let dim = theme().fg_style(ThemeColor::Dim);
        let body = theme().fg_style(ThemeColor::CustomMessageText);
        // The first rendered line carries the dim gutter, continuation
        // rows three unstyled spaces.
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
        // The expanded body is the raw content under the branch gutter: the gutter on
        // the first content row, the four-column continuation on the blank source line.
        let row = ShellCompletionRow {
            pid: Some(99),
            exit_code: Some(0),
            content: "[bash-done pid:99 exit:0]\n\nCommand: \"printf done\"".to_string(),
        };
        let rows = render_shell_completion(&row, Detail::All, &theme(), 60, true);
        let trimmed: Vec<String> = rows
            .iter()
            .map(|row| flat(row).trim_end().to_string())
            .collect();
        assert_eq!(
            trimmed,
            vec![
                "",
                " \u{2713} Background shell command finished",
                " \u{2570}\u{2500} [bash-done pid:99 exit:0]",
                "",
                "    Command: \"printf done\"",
            ],
            "{rows:?}"
        );
    }

    /// The un-boxed panel's label and body carry their shared spans with no box background.
    #[test]
    fn custom_panel_guttered_shape() {
        let row = CustomPanelRow {
            custom_type: "autonomous_status".to_string(),
            content: "[autonomous-status: on]".to_string(),
        };
        let rows = render_custom_panel(&row, &theme(), 40);
        // No box background anywhere on the row.
        assert_eq!(
            rows[1][1],
            custom_message_label("autonomous_status", &theme())
        );
        assert!(rows[1].iter().all(|span| span.style.bg.is_none()));
        let body = rows[2]
            .iter()
            .find(|span| span.content.contains("[autonomous-status: on]"))
            .expect("the body text renders");
        assert_eq!(
            body.style.fg,
            theme().fg_style(ThemeColor::CustomMessageText).fg
        );
    }
}
