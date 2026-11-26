//! The per-entry transcript row builders: the spacing classification
//! (TS `getSpacingContent`), the leading-space scan (TS
//! `shouldAddLeadingSpace`), and `render_entry` — the one producer of
//! a chat entry's cached layout rows.

use super::AgentView;
use crate::chat::{
    render_assistant_with_style, render_text_rows, render_user_block_with_style, AssistantLayout,
    ChatEntry, Detail, ThinkingStep,
};
use crate::theme::ThemeColor;
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

impl AgentView {
    /// TS `createConversationSpacing.shouldAddLeadingSpace` for one spacing-driven custom row:
    /// scan back over entries that contribute no rows at this detail level, then apply the rules.
    pub(super) fn conversation_leading(&self, index: usize, expanded: bool) -> bool {
        let mut idx = index;
        let mut tool_separator = false;
        while idx > 0 {
            idx -= 1;
            match &self.chat[idx] {
                ChatEntry::Assistant(message) => {
                    match self.assistant_spacing_content(idx, message) {
                        SpacingContent::Hidden => {}
                        SpacingContent::ToolOnly => {
                            tool_separator = true;
                        }
                        SpacingContent::Visible => {
                            // TS `hasTrailingSpace` on the visible body (`precededByToolActivity`
                            // is the full compact set).
                            let preceded_by_tool =
                                idx > 0 && Self::is_compact_neighbor(&self.chat[idx - 1]);
                            if tool_separator
                                || message
                                    .has_trailing_space(self.thinking_shown(idx), preceded_by_tool)
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

    fn assistant_spacing_content(
        &self,
        index: usize,
        message: &crate::chat::AssistantMessage,
    ) -> SpacingContent {
        let thinking_shown = self.thinking_shown(index);
        let visible_body = message.blocks.iter().any(|block| match block {
            crate::chat::MessageBlock::Thinking(text) => thinking_shown && !text.trim().is_empty(),
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

    /// Whether an assistant entry's thinking renders rows: the compact-steps line, or the full
    /// reasoning at the entry's own level.
    fn thinking_shown(&self, index: usize) -> bool {
        self.compact_steps || self.entry_detail(index).show_thinking()
    }

    /// The inputs assistant entry `index` lays out under (its paint and its count).
    pub(super) fn assistant_layout(
        &self,
        index: usize,
        preceded_by_tool_activity: bool,
    ) -> AssistantLayout {
        AssistantLayout {
            detail: self.entry_detail(index),
            preceded_by_tool_activity,
            thinking_step: self.compact_steps.then(|| ThinkingStep {
                duration: self.thinking_times.get(&index).copied(),
            }),
        }
    }

    /// The level a tool card renders its body at. Compact steps open a clicked card whole: its
    /// diffs and sent-message bodies follow the row's own level, not the conversation's.
    pub(super) fn tool_card_level(&self, detail: Detail) -> Detail {
        if self.compact_steps {
            detail
        } else {
            self.detail
        }
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
                let mut md = crate::markdown::MarkdownStyle::from_theme(&self.theme);
                md.code_block_indent.clone_from(&self.code_block_indent);
                md.link_base_url = url::Url::from_directory_path(&self.chrome.cwd).ok();
                let mut rows = Vec::new();
                // TS `addMessageToChat`: a user submission leads with `Spacer(1)` EXCEPT the
                // skill invocation's argument text, which joins the card below.
                let follows_skill_card =
                    index > 0 && matches!(self.chat[index - 1], ChatEntry::SkillInvocation(_));
                if !first && !follows_skill_card {
                    rows.push(Vec::new());
                }
                rows.extend(render_user_block_with_style(text, &self.theme, &md, width));
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
                    text,
                    &self.theme,
                    width,
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
                    &self.theme,
                    width,
                ));
                rows
            }
            ChatEntry::Assistant(message) => {
                let mut md = crate::markdown::MarkdownStyle::from_theme(&self.theme);
                md.code_block_indent.clone_from(&self.code_block_indent);
                md.link_base_url = url::Url::from_directory_path(&self.chrome.cwd).ok();
                let layout = self.assistant_layout(index, preceded_by_tool_activity);
                // The per-entry block cache (TS's per-component `blockCache`): a streaming
                // message's settled blocks replay per frame; a settled message drops the copy.
                if message.streaming {
                    let mut caches = self.md_caches.borrow_mut();
                    let cache = caches.entry(index).or_default();
                    render_assistant_with_style(message, &layout, &self.theme, &md, width, cache)
                } else {
                    self.md_caches.borrow_mut().remove(&index);
                    let mut settled = crate::markdown::MarkdownBlockCache::default();
                    render_assistant_with_style(
                        message,
                        &layout,
                        &self.theme,
                        &md,
                        width,
                        &mut settled,
                    )
                }
            }
            ChatEntry::Tool(card) => {
                // TS `ToolExecutionComponent`: the leading spacer rides on `shouldAddLeadingSpace`
                // (consecutive cards stay flush).
                let mut rows: Vec<Line> = Vec::new();
                if self.conversation_leading(index, detail.tool_output_expanded()) {
                    rows.push(Vec::new());
                }
                if self.compact_steps && !detail.tool_output_expanded() {
                    rows.push(crate::tool_card::step_line(
                        card,
                        self.pulse_frame,
                        &self.theme,
                        width,
                    ));
                } else {
                    rows.extend(crate::tool_card::render_tool_card(
                        card,
                        self.pulse_frame,
                        detail,
                        self.tool_card_level(detail),
                        &self.theme,
                        width,
                        self.show_images,
                    ));
                }
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
                let cancel_hint = self.editor.keybindings().key_text("tui.select.cancel");
                rows.extend(crate::bash_card::render_bash_execution(
                    card,
                    self.pulse_frame,
                    detail.tool_output_expanded(),
                    &cancel_hint,
                    &self.theme,
                    width,
                ));
                rows
            }
            ChatEntry::AgentMessage(row) => crate::custom_message::render::render_agent_message(
                row,
                detail,
                &self.theme,
                width,
                self.conversation_leading(index, detail.tool_output_expanded()),
            ),
            ChatEntry::InboxNotice(row) => self.render_inbox_notice_entry(index, row, width),
            // TS `addMessageToChat`'s user case: `Spacer(1)` when the chat is non-empty, then the
            // card.
            ChatEntry::SkillInvocation(row) => {
                crate::custom_message::skill_invocation::render_skill_invocation(
                    row,
                    detail,
                    &self.theme,
                    width,
                    !first,
                )
            }
            ChatEntry::InjectedPrompt(row) => {
                crate::custom_message::injected_prompt::render_injected_prompt(
                    row,
                    detail,
                    &self.theme,
                    width,
                    true,
                )
            }
            ChatEntry::ShellCompletion(row) => {
                crate::custom_message::render::render_shell_completion(
                    row,
                    detail,
                    &self.theme,
                    width,
                    self.conversation_leading(index, detail.tool_output_expanded()),
                )
            }
            ChatEntry::RefinementOutcome(row) => {
                crate::custom_message::refinement::render_refinement_outcome(
                    row,
                    detail,
                    &self.theme,
                    width,
                )
            }
            ChatEntry::CustomPanel(row) => {
                crate::custom_message::render::render_custom_panel(row, &self.theme, width)
            }
        }
    }
}
