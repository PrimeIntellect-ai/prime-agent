//! Shared chat framing decisions and count-only geometry.
use super::{AssistantMessage, Detail, MessageBlock};
use crate::markdown::{markdown_row_count, MarkdownStyle};
use crate::theme::{Theme, ThemeColor};

pub(super) fn user_mask(text: &str) -> crate::prompt_highlight::PromptTokenMask {
    let (command_end, include_bare_separator) =
        crate::prompt_highlight::user_message_command_span(text);
    crate::prompt_highlight::PromptTokenMask::new(text, command_end, include_bare_separator)
}

pub(super) fn visible_blocks(message: &AssistantMessage, detail: Detail) -> Vec<&MessageBlock> {
    message
        .blocks
        .iter()
        .filter(|block| match block {
            MessageBlock::Thinking(text) => detail.show_thinking() && !text.trim().is_empty(),
            MessageBlock::Text(text) => !text.trim().is_empty(),
        })
        .collect()
}

pub(super) fn trailing_space(
    message: &AssistantMessage,
    has_visible_content: bool,
    preceded_by_tool_activity: bool,
) -> bool {
    message.has_tool_calls && (has_visible_content || message.aborted || !preceded_by_tool_activity)
}

pub(super) fn thinking_style(md: &MarkdownStyle, theme: &Theme) -> MarkdownStyle {
    let mut md = md.clone();
    let dim = theme.fg_style(ThemeColor::Dim);
    // TS `getThinkingMarkdownTheme` replaces `highlightCode` with uniform
    // dim lines: the thinking code blocks never highlight.
    md.syntax = None;
    md.body = dim;
    md.heading = dim;
    md.link = dim;
    md.link_url = dim;
    md.code = dim;
    md.code_block = dim;
    md.code_block_border = dim;
    md.quote = dim;
    md.quote_border = dim;
    md.hr = dim;
    md.list_bullet = dim;
    md
}

pub(crate) fn user_block_row_count(
    text: &str,
    theme: &Theme,
    code_block_indent: &str,
    width: usize,
) -> usize {
    let mut md = MarkdownStyle::from_theme(theme);
    code_block_indent.clone_into(&mut md.code_block_indent);
    let mask = user_mask(text);
    markdown_row_count(&mask.text, width.saturating_sub(4).max(1), &md).max(1) + 2
}

pub(crate) fn assistant_row_count(
    message: &AssistantMessage,
    detail: Detail,
    theme: &Theme,
    code_block_indent: &str,
    width: usize,
    preceded_by_tool_activity: bool,
) -> usize {
    let blocks = visible_blocks(message, detail);
    let mut count = usize::from(!blocks.is_empty());
    let mut md = MarkdownStyle::from_theme(theme);
    code_block_indent.clone_into(&mut md.code_block_indent);
    let content_width = width.saturating_sub(2).max(1);
    for (index, block) in blocks.iter().enumerate() {
        match block {
            MessageBlock::Text(text) => {
                count += markdown_row_count(text.trim(), content_width, &md)
            }
            MessageBlock::Thinking(text) => {
                count +=
                    markdown_row_count(text.trim(), content_width, &thinking_style(&md, theme));
                count += usize::from(index + 1 < blocks.len());
            }
        }
    }
    if let Some(error) = &message.error {
        // Mirrors the render site: eligible login-recovery errors count as
        // the merged inline line (TS `createErrorComponent`).
        let merged = crate::error_summary::format_inline_login_recovery_message(error);
        count += 1 + crate::error_summary::collapsible_error_row_count(
            merged.as_deref().unwrap_or(error),
            None,
            detail.tool_output_expanded(),
            width,
        );
    }
    count
        + usize::from(trailing_space(
            message,
            !blocks.is_empty(),
            preceded_by_tool_activity,
        ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::ColorMode;

    #[test]
    fn counts_match_user_and_assistant_frames() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        for width in [0, 1, 2, 5, 17, 80] {
            for text in [
                "",
                "/model --flag @some_path/file.rs",
                "# Header\n\nwords 界 words",
                "| a | b |\n|---|---|\n| x | y |",
            ] {
                assert_eq!(
                    super::super::user_block_row_count(text, &theme, "  ", width),
                    super::super::render_user_block(text, &theme, "  ", width).len()
                );
            }
            for detail in [Detail::Overview, Detail::Details, Detail::All] {
                for blocks in [
                    vec![],
                    vec![MessageBlock::Thinking(
                        "hidden or visible\n```python\nx=1\n```".into(),
                    )],
                    vec![
                        MessageBlock::Thinking("before".into()),
                        MessageBlock::Text("**body** [link](https://example.com)".into()),
                    ],
                ] {
                    for has_tool_calls in [false, true] {
                        for aborted in [false, true] {
                            for preceded in [false, true] {
                                for error in [
                                    None,
                                    Some("Traceback (most recent call last):\n  File test.py\nError: words words".to_owned()),
                                    Some("Auth failed. \n\nRun /login to update credentials.".to_owned()),
                                    Some("Auth failed\nfor provider.\n\nRun /login to update credentials.".to_owned()),
                                    Some(
                                        "Authentication failed for \"prime-inference\". Credentials may have expired or network is unavailable.\n\nRun /login to update credentials."
                                            .to_owned(),
                                    ),
                                ] {
                                    let message = AssistantMessage { blocks: blocks.clone(), has_tool_calls, streaming: false, aborted, error };
                                    let mut cache = crate::markdown::MarkdownBlockCache::default();
                                    assert_eq!(super::super::assistant_row_count(&message, detail, &theme, "  ", width, preceded), super::super::render_assistant(&message, detail, &theme, "  ", width, preceded, &mut cache).len());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
