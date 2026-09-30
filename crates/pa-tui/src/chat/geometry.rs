//! Shared chat framing decisions and count-only geometry.
use super::{AssistantMessage, Detail, MessageBlock};
use crate::markdown::{
    markdown_row_count, markdown_row_count_tagged, MarkdownBlockCache, MarkdownStyle,
};
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

/// The cache tag the dim thinking block renders and counts under: one
/// definition for `chat.rs`'s render call and the count below, so the
/// rows the paint caches are exactly the rows the count replays.
pub(super) const THINKING_CACHE_TAG: &str = "dim";

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
    cache: &MarkdownBlockCache,
) -> usize {
    let blocks = visible_blocks(message, detail);
    let mut count = usize::from(!blocks.is_empty());
    let mut md = MarkdownStyle::from_theme(theme);
    code_block_indent.clone_into(&mut md.code_block_indent);
    let content_width = width.saturating_sub(2).max(1);
    for (index, block) in blocks.iter().enumerate() {
        match block {
            MessageBlock::Text(text) => {
                count += markdown_row_count_tagged(text.trim(), content_width, &md, "", cache);
            }
            MessageBlock::Thinking(text) => {
                count += markdown_row_count_tagged(
                    text.trim(),
                    content_width,
                    &thinking_style(&md, theme),
                    THINKING_CACHE_TAG,
                    cache,
                );
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
