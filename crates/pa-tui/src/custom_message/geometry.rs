//! Count custom rows using the same headers and body geometry as rendering.
use super::{AgentMessageRow, CustomPanelRow, ShellCompletionRow};
use crate::chat::Detail;
use crate::theme::{Theme, ThemeColor};
use crate::width::{wrapped_line_count, wrapped_text_count};

pub(crate) fn text_row_count(spans: &crate::Line, width: usize) -> usize {
    if spans.iter().all(|span| span.content.trim().is_empty()) {
        return 0;
    }
    wrapped_line_count(spans, width.saturating_sub(2).max(1))
}

pub(crate) fn markdown_row_count(
    text: &str,
    body_color: ThemeColor,
    theme: &Theme,
    width: usize,
) -> usize {
    let md = markdown_style(body_color, theme);
    crate::markdown::markdown_row_count(text, width.saturating_sub(2).max(1), &md)
}

pub(super) fn markdown_style(
    body_color: ThemeColor,
    theme: &Theme,
) -> crate::markdown::MarkdownStyle {
    let mut md = crate::markdown::MarkdownStyle::from_theme(theme);
    md.body = theme.fg_style(body_color);
    md
}

pub(super) fn agent_body_width(width: usize) -> usize {
    width.max(1).saturating_sub(4).max(1)
}

pub(super) fn custom_panel_style(theme: &Theme) -> crate::markdown::MarkdownStyle {
    markdown_style(ThemeColor::CustomMessageText, theme)
}

pub(crate) fn agent_message_body_count(message: &str, width: usize) -> usize {
    message
        .split('\n')
        .map(|source| wrapped_text_count(source, agent_body_width(width)))
        .sum::<usize>()
        .max(1)
}

pub(crate) fn agent_message_row_count(
    row: &AgentMessageRow,
    detail: Detail,
    theme: &Theme,
    width: usize,
    leading: bool,
) -> usize {
    let header = super::render::agent_message_summary_line(row.direction, &row.counterpart, theme);
    usize::from(leading)
        + wrapped_line_count(&header, width.saturating_sub(2).max(1))
        + if detail.tool_output_expanded() {
            agent_message_body_count(&row.message, width)
        } else {
            0
        }
}

pub(crate) fn shell_completion_row_count(
    row: &ShellCompletionRow,
    detail: Detail,
    width: usize,
    leading: bool,
) -> usize {
    let body = if detail.tool_output_expanded() {
        row.content
            .split('\n')
            .map(|line| {
                if line.trim().is_empty() {
                    1
                } else {
                    wrapped_text_count(line, width.saturating_sub(2).max(1))
                }
            })
            .sum()
    } else {
        0
    };
    usize::from(leading) + 1 + body
}

pub(crate) fn custom_panel_row_count(row: &CustomPanelRow, theme: &Theme, width: usize) -> usize {
    5 + crate::markdown::markdown_row_count(
        &row.content,
        width.saturating_sub(2).max(1),
        &custom_panel_style(theme),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custom_message::AgentMessageDirection;
    use crate::theme::ColorMode;

    #[test]
    fn geometry_matches_custom_rows_and_receipt_bodies() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        for width in [0, 1, 2, 5, 19, 80] {
            for content in [
                "",
                "  \n\n",
                "long words 界 repeated words\nsecond",
                "# Heading\n\n| a | b |\n|---|---|\n| x | y |",
            ] {
                let agent = AgentMessageRow {
                    direction: AgentMessageDirection::Received,
                    counterpart: "worker".into(),
                    message: content.into(),
                };
                let shell = ShellCompletionRow {
                    pid: None,
                    exit_code: Some(1),
                    content: content.into(),
                };
                let custom = CustomPanelRow {
                    custom_type: "test".into(),
                    content: content.into(),
                };
                assert_eq!(
                    super::super::agent_message_body_count(content, width),
                    super::super::render::agent_message_body(content, &theme, width).len()
                );
                assert_eq!(
                    custom_panel_row_count(&custom, &theme, width),
                    super::super::render::render_custom_panel(&custom, &theme, width).len()
                );
                for detail in [Detail::Overview, Detail::Details, Detail::All] {
                    for leading in [false, true] {
                        assert_eq!(
                            agent_message_row_count(&agent, detail, &theme, width, leading),
                            super::super::render::render_agent_message(
                                &agent, detail, &theme, width, leading
                            )
                            .len()
                        );
                        assert_eq!(
                            shell_completion_row_count(&shell, detail, width, leading),
                            super::super::render::render_shell_completion(
                                &shell, detail, &theme, width, leading
                            )
                            .len()
                        );
                    }
                }
            }
        }
    }
}
