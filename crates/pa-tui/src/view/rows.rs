//! The per-entry transcript row builders: the spacing classification
//! (TS `getSpacingContent`), the leading-space scan (TS
//! `shouldAddLeadingSpace`), and `render_entry` — the one producer of
//! a chat entry's cached layout rows.

use super::AgentView;
use crate::chat::{
    render_assistant_with_style, render_text_rows, render_user_block_with_style, ChatEntry, Detail,
};
use crate::keybindings::KeybindingsManager;
use crate::theme::{Theme, ThemeColor};
use crate::Line;

#[cfg(test)]
use super::layout;

/// TS `getSpacingContent`: an assistant message's conversation-spacing
/// classification at the current detail level.
enum SpacingContent {
    Visible,
    ToolOnly,
    Hidden,
}

/// One composition's chat-format inputs: the entries to render (and the
/// spacing scan over them), the paint theme, the markdown inputs, and the
/// animation/detail knobs. The main chat renders its own transcript
/// through it; the hosted bot's conversation page reuses it with the
/// mirrored transcript in place of the view's own entries, so both pages
/// render the same format.
pub(crate) struct ChatRowCtx<'a> {
    /// The chat whose entries render.
    pub chat: &'a [ChatEntry],
    pub theme: &'a Theme,
    /// The chat markdown fenced-code indent (`markdown.codeBlockIndent`;
    /// default two spaces).
    pub code_block_indent: String,
    /// The owning view's session cwd: markdown link resolution stays
    /// local to the session that owns the page.
    pub cwd: String,
    /// The conversation's detail level.
    pub detail: Detail,
    /// Animation frame for spinners and the working icon.
    pub pulse_frame: usize,
    /// The `terminal.showImages` setting (default true): image blocks
    /// render metadata rows when set, `[Image: ...]` placeholders otherwise.
    pub show_images: bool,
    /// The editor's keybindings (the bash card's cancel hint).
    pub keybindings: &'a KeybindingsManager,
}

impl ChatRowCtx<'_> {
    /// Agent messages, tool calls, bash executions, and shell completions
    /// render flush against each other.
    pub(crate) fn is_compact_neighbor(entry: &ChatEntry) -> bool {
        matches!(
            entry,
            ChatEntry::Tool(_)
                | ChatEntry::AgentMessage(_)
                | ChatEntry::InboxNotice(_)
                | ChatEntry::ShellCompletion(_)
                | ChatEntry::BashExecution(_)
        )
    }

    /// TS `createConversationSpacing.shouldAddLeadingSpace` for one spacing-driven custom row:
    /// scan back over entries that contribute no rows at this detail level, then apply the rules.
    pub(crate) fn conversation_leading(&self, index: usize, expanded: bool) -> bool {
        Self::conversation_leading_scan(self.chat, self.detail, index, expanded)
    }

    /// The leading-space scan over `chat` at `detail`.
    fn conversation_leading_scan(
        chat: &[ChatEntry],
        detail: Detail,
        index: usize,
        expanded: bool,
    ) -> bool {
        let mut idx = index;
        let mut tool_separator = false;
        while idx > 0 {
            idx -= 1;
            match &chat[idx] {
                ChatEntry::Assistant(message) => {
                    match Self::assistant_spacing_content(detail, message) {
                        SpacingContent::Hidden => {}
                        SpacingContent::ToolOnly => {
                            tool_separator = true;
                        }
                        SpacingContent::Visible => {
                            // TS `hasTrailingSpace` on the visible body (`precededByToolActivity`
                            // is the full compact set).
                            let preceded_by_tool =
                                idx > 0 && Self::is_compact_neighbor(&chat[idx - 1]);
                            if tool_separator
                                || message.has_trailing_space(detail, preceded_by_tool)
                            {
                                return false;
                            }
                            // An assistant message is never a compact neighbor; both rules add
                            // the leading blank here.
                            return true;
                        }
                    }
                }
                preceding => {
                    if tool_separator && !Self::is_compact_neighbor(preceding) {
                        return false;
                    }
                    if expanded {
                        return true;
                    }
                    return !Self::is_compact_neighbor(preceding);
                }
            }
        }
        // The scan exhausted the transcript: TS keeps the tool separator with a trailing space;
        // with nothing preceding, the expanded form sits flush.
        if tool_separator {
            return false;
        }
        !expanded
    }

    /// The assistant message's conversation-spacing classification at
    /// the detail level.
    fn assistant_spacing_content(
        detail: Detail,
        message: &crate::chat::AssistantMessage,
    ) -> SpacingContent {
        let visible_body = message.blocks.iter().any(|block| match block {
            crate::chat::MessageBlock::Thinking(text) => {
                detail.show_thinking() && !text.trim().is_empty()
            }
            crate::chat::MessageBlock::Text(text) => !text.trim().is_empty(),
        });
        if visible_body || message.aborted || (message.error.is_some() && !message.has_tool_calls) {
            return SpacingContent::Visible;
        }
        if message.has_tool_calls {
            SpacingContent::ToolOnly
        } else {
            SpacingContent::Hidden
        }
    }

    /// Lay out one chat entry's transcript rows (the format producer
    /// behind the main chat's cached layout rows and the hosted
    /// conversation page's window). `entry_detail` is the entry's own
    /// detail level (the conversation's, flipped by the main chat's
    /// card toggles); `md_cache` is the caller's per-entry markdown
    /// block cache (a streaming message replays from a shared one, a
    /// settled message renders with a throwaway).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn render_entry(
        &self,
        entry_detail: Detail,
        index: usize,
        entry: &ChatEntry,
        width: usize,
        first: bool,
        preceded_by_tool_activity: bool,
        md_cache: &mut crate::markdown::MarkdownBlockCache,
    ) -> Vec<Line> {
        let detail = entry_detail;
        match entry {
            ChatEntry::Status { text, kind } => {
                let style = match kind {
                    crate::chat::StatusKind::Info => self.theme.fg_style(ThemeColor::Dim),
                    crate::chat::StatusKind::Warning => self.theme.fg_style(ThemeColor::Warning),
                    crate::chat::StatusKind::Error => self.theme.fg_style(ThemeColor::Error),
                };
                let mut rows = Vec::new();
                rows.push(Vec::new());
                rows.extend(render_text_rows(text, style, width));
                rows
            }
            ChatEntry::User { text } => {
                let mut md = crate::markdown::MarkdownStyle::from_theme(self.theme);
                md.code_block_indent.clone_from(&self.code_block_indent);
                md.link_base_url = url::Url::from_directory_path(&self.cwd).ok();
                let mut rows = Vec::new();
                // TS `addMessageToChat`: a user submission leads with `Spacer(1)` EXCEPT the
                // skill invocation's argument text, which joins the card below.
                let follows_skill_card =
                    index > 0 && matches!(self.chat[index - 1], ChatEntry::SkillInvocation(_));
                if !first && !follows_skill_card {
                    rows.push(Vec::new());
                }
                rows.extend(render_user_block_with_style(text, self.theme, &md, width));
                rows
            }
            ChatEntry::SlashCommand { text } => {
                // The echo row leads with a spacer when the chat is not
                // empty (TS `Spacer(1)`).
                let mut rows = Vec::new();
                if !first {
                    rows.push(Vec::new());
                }
                rows.extend(crate::chat_slash::render_slash_command(
                    text, self.theme, width,
                ));
                rows
            }
            ChatEntry::CompactionSummary {
                summary,
                tokens_before,
                custom_instructions,
            } => {
                // TS `addMessageToChat`: the summary follows the previous
                // component with `Spacer(1)` when not first.
                let mut rows = Vec::new();
                if !first {
                    rows.push(Vec::new());
                }
                rows.extend(crate::compaction_row::render_compaction_summary(
                    summary,
                    *tokens_before,
                    custom_instructions.as_deref(),
                    // TS `applyChatExpansion` fans `toolOutputExpanded` out to every
                    // `ExpandableEventMessage`; the summary stays collapsed until the cycle
                    // reaches `all`.
                    detail.tool_output_expanded(),
                    self.theme,
                    width,
                ));
                rows
            }
            ChatEntry::Assistant(message) => {
                let mut md = crate::markdown::MarkdownStyle::from_theme(self.theme);
                md.code_block_indent.clone_from(&self.code_block_indent);
                md.link_base_url = url::Url::from_directory_path(&self.cwd).ok();
                render_assistant_with_style(
                    message,
                    detail,
                    self.theme,
                    &md,
                    width,
                    preceded_by_tool_activity,
                    md_cache,
                )
            }
            ChatEntry::Tool(card) => {
                // TS `ToolExecutionComponent`: the leading spacer rides on `shouldAddLeadingSpace`
                // (consecutive cards stay flush).
                let mut rows: Vec<Line> = Vec::new();
                if self.conversation_leading(index, detail.tool_output_expanded()) {
                    rows.push(Vec::new());
                }
                rows.extend(crate::tool_card::render_tool_card(
                    card,
                    self.pulse_frame,
                    detail,
                    self.detail,
                    self.theme,
                    width,
                    self.show_images,
                ));
                rows
            }
            ChatEntry::BashExecution(card) => {
                // TS `BashExecutionComponent` mounts with `Spacer(1)` unless it follows an
                // agent-message component (`suppressLeadingSpace`).
                let mut rows: Vec<Line> = Vec::new();
                if !card.suppress_leading_space {
                    rows.push(Vec::new());
                }
                // TS `keyText("tui.select.cancel")`: every key of the
                // binding joins the hint ("Esc/Ctrl+C").
                let cancel_hint = self.keybindings.key_text("tui.select.cancel");
                rows.extend(crate::bash_card::render_bash_execution(
                    card,
                    self.pulse_frame,
                    detail.tool_output_expanded(),
                    &cancel_hint,
                    self.theme,
                    width,
                ));
                rows
            }
            ChatEntry::AgentMessage(row) => crate::custom_message::render::render_agent_message(
                row,
                detail,
                self.theme,
                width,
                self.conversation_leading(index, detail.tool_output_expanded()),
            ),
            ChatEntry::InboxNotice(row) => crate::custom_message::render::render_inbox_notice(
                row,
                self.theme,
                width,
                self.conversation_leading(index, detail.tool_output_expanded()),
            ),
            // TS `addMessageToChat`'s user case: `Spacer(1)` when the chat is non-empty, then the
            // card.
            ChatEntry::SkillInvocation(row) => {
                crate::custom_message::skill_invocation::render_skill_invocation(
                    row, detail, self.theme, width, !first,
                )
            }
            ChatEntry::InjectedPrompt(row) => {
                crate::custom_message::injected_prompt::render_injected_prompt(
                    row, detail, self.theme, width,
                )
            }
            ChatEntry::ShellCompletion(row) => {
                crate::custom_message::render::render_shell_completion(
                    row,
                    detail,
                    self.theme,
                    width,
                    self.conversation_leading(index, detail.tool_output_expanded()),
                )
            }
            ChatEntry::RefinementOutcome(row) => {
                crate::custom_message::refinement::render_refinement_outcome(
                    row, detail, self.theme, width,
                )
            }
            ChatEntry::CustomPanel(row) => {
                crate::custom_message::render::render_custom_panel(row, self.theme, width)
            }
        }
    }
}

impl AgentView {
    /// The main chat's per-entry render context: the view's own entries
    /// plus the theme, markdown inputs, and animation/detail knobs the
    /// format reads. The hosted conversation page reuses it with the
    /// mirrored transcript in place of the view's own entries.
    pub(crate) fn chat_row_ctx(&self) -> ChatRowCtx<'_> {
        ChatRowCtx {
            chat: &self.chat,
            theme: &self.theme,
            code_block_indent: self.code_block_indent.clone(),
            cwd: self.chrome.cwd.clone(),
            detail: self.detail,
            pulse_frame: self.pulse_frame,
            show_images: self.show_images,
            keybindings: self.editor.keybindings(),
        }
    }

    /// TS `createConversationSpacing.shouldAddLeadingSpace` for one spacing-driven custom row:
    /// scan back over entries that contribute no rows at this detail level, then apply the rules.
    pub(super) fn conversation_leading(&self, index: usize, expanded: bool) -> bool {
        ChatRowCtx::conversation_leading_scan(&self.chat, self.detail, index, expanded)
    }

    /// Lay out one chat entry's transcript rows (the only producer of
    /// cached layout rows).
    pub(super) fn render_entry(
        &self,
        index: usize,
        entry: &ChatEntry,
        width: usize,
        first: bool,
        preceded_by_tool_activity: bool,
    ) -> Vec<Line> {
        #[cfg(test)]
        layout::ENTRY_RENDERS.with(|count| count.set(count.get() + 1));
        let detail = self.entry_detail(index);
        let ctx = self.chat_row_ctx();
        // The per-entry block cache (TS's per-component `blockCache`): a streaming
        // message's settled blocks replay per frame from the shared cache; a
        // settled message drops its copy and renders with a throwaway.
        if let ChatEntry::Assistant(message) = entry {
            if message.streaming {
                let mut caches = self.md_caches.borrow_mut();
                let cache = caches.entry(index).or_default();
                return ctx.render_entry(
                    detail,
                    index,
                    entry,
                    width,
                    first,
                    preceded_by_tool_activity,
                    cache,
                );
            }
            self.md_caches.borrow_mut().remove(&index);
            let mut settled = crate::markdown::MarkdownBlockCache::default();
            return ctx.render_entry(
                detail,
                index,
                entry,
                width,
                first,
                preceded_by_tool_activity,
                &mut settled,
            );
        }
        let mut scratch = crate::markdown::MarkdownBlockCache::default();
        ctx.render_entry(
            detail,
            index,
            entry,
            width,
            first,
            preceded_by_tool_activity,
            &mut scratch,
        )
    }
}
