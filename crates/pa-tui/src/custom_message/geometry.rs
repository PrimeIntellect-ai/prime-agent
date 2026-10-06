//! Count custom rows using the same headers and body geometry as rendering.
use super::{AgentMessageRow, CustomPanelRow, ShellCompletionRow};
use crate::branch::{branch_block_count, branch_markdown_count};
use crate::chat::Detail;
use crate::theme::{Theme, ThemeColor};
use crate::width::{wrapped_line_count, wrapped_text_count};

pub(crate) fn text_row_count(spans: &crate::Line, width: usize) -> usize {
    if spans.iter().all(|span| span.content.trim().is_empty()) {
        return 0;
    }
    wrapped_line_count(spans, width.saturating_sub(2).max(1))
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
    usize::from(leading)
        + 1
        + if detail.tool_output_expanded() {
            branch_block_count(&row.content, width)
        } else {
            0
        }
}

pub(crate) fn custom_panel_row_count(row: &CustomPanelRow, theme: &Theme, width: usize) -> usize {
    1 + text_row_count(
        &vec![super::render::custom_message_label(&row.custom_type, theme)],
        width,
    ) + branch_markdown_count(
        &row.content,
        &markdown_style(ThemeColor::CustomMessageText, theme),
        width,
    )
}
