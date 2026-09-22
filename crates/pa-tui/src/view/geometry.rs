//! Exact count-only geometry for every transcript entry family.
use super::AgentView;
use crate::chat::ChatEntry;

impl AgentView {
    pub(super) fn count_entry_rows(&self, index: usize, width: usize) -> usize {
        let entry = &self.chat[index];
        let preceded_by_tool = index > 0 && matches!(self.chat[index - 1], ChatEntry::Tool(_));
        let spacing = self.entry_spacing(index, entry, index == 0, preceded_by_tool);
        match entry {
            ChatEntry::Status { text, .. } => {
                1 + if text.trim().is_empty() {
                    0
                } else {
                    crate::width::wrapped_text_count(text, width.saturating_sub(2).max(1))
                }
            }
            ChatEntry::User { text } => {
                usize::from(spacing)
                    + crate::chat::user_block_row_count(
                        text,
                        &self.theme,
                        &self.code_block_indent,
                        width,
                    )
            }
            ChatEntry::Assistant(message) => crate::chat::assistant_row_count(
                message,
                self.detail,
                &self.theme,
                &self.code_block_indent,
                width,
                preceded_by_tool,
            ),
            ChatEntry::SlashCommand { text } => {
                usize::from(spacing)
                    + crate::chat_slash::slash_command_row_count(text, &self.theme, width)
            }
            ChatEntry::SlashCommandResult { content } => {
                2 + crate::width::wrapped_text_count(content, width.saturating_sub(4).max(1))
            }
            ChatEntry::AgentMessage(row) => {
                crate::custom_message::geometry::agent_message_row_count(
                    row,
                    self.detail,
                    &self.theme,
                    width,
                    spacing,
                )
            }
            ChatEntry::ShellCompletion(row) => {
                crate::custom_message::geometry::shell_completion_row_count(
                    row,
                    self.detail,
                    width,
                    spacing,
                )
            }
            ChatEntry::CustomPanel(row) => {
                crate::custom_message::geometry::custom_panel_row_count(row, &self.theme, width)
            }
            ChatEntry::ClientMarkdown { text } => {
                let mut style = crate::markdown::MarkdownStyle::from_theme(&self.theme);
                style.code_block_indent = self.code_block_indent.clone();
                3 + crate::markdown::markdown_row_count(
                    text.trim(),
                    width.saturating_sub(2).max(1),
                    &style,
                )
            }
            ChatEntry::ClientText { rows } => {
                crate::info_commands::client_text_row_count(rows, &self.theme, width)
            }
            ChatEntry::ChangelogPanel { markdown } => {
                crate::info_commands::changelog_panel_row_count(
                    markdown,
                    &self.theme,
                    &self.code_block_indent,
                    width,
                )
            }
            ChatEntry::Tool(card) => {
                usize::from(spacing)
                    + crate::tool_card::count_tool_card(
                        card,
                        self.pulse_frame,
                        self.detail,
                        &self.theme,
                        width,
                        self.show_images,
                    )
            }
            ChatEntry::SkillInvocation(row) => {
                crate::custom_message::skill_invocation::count_skill_invocation(
                    row,
                    self.detail,
                    &self.theme,
                    width,
                    spacing,
                )
            }
            ChatEntry::InjectedPrompt(row) => {
                crate::custom_message::injected_prompt::count_injected_prompt(
                    row,
                    self.detail,
                    &self.theme,
                    width,
                )
            }
            ChatEntry::RefinementOutcome(row) => {
                crate::custom_message::refinement::count_refinement_outcome(
                    row,
                    self.detail,
                    &self.theme,
                    width,
                )
            }
            ChatEntry::CompactionSummary {
                summary,
                tokens_before,
                custom_instructions,
            } => {
                usize::from(spacing)
                    + crate::compaction_row::count_compaction_summary(
                        summary,
                        *tokens_before,
                        custom_instructions.as_deref(),
                        self.detail.tool_output_expanded(),
                        &self.theme,
                        width,
                    )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::{AssistantMessage, Detail, MessageBlock, StatusKind};
    use crate::theme::{ColorMode, Theme};

    #[test]
    fn supported_entry_geometry_matches_rendering() {
        let mut view = AgentView::new(Theme::builtin("prime", ColorMode::TrueColor));
        for text in [
            "",
            " ",
            "界 words\nsecond",
            "/goal @path --flag value",
            "# Heading\n\n- list\n- second",
            "```rust\nfn main() {}\n```",
            "| a | b |\n|---|---|\n| one | 界 |",
        ] {
            view.push_entry(ChatEntry::Status {
                text: text.into(),
                kind: StatusKind::Info,
            });
            view.push_entry(ChatEntry::User { text: text.into() });
            view.push_entry(ChatEntry::SlashCommand { text: text.into() });
            view.push_entry(ChatEntry::SlashCommandResult {
                content: text.into(),
            });
            for error in [
                None,
                Some("Traceback error\n  context\nValueError: failed".to_string()),
            ] {
                view.push_entry(ChatEntry::Assistant(Box::new(AssistantMessage {
                    blocks: vec![
                        MessageBlock::Thinking(text.into()),
                        MessageBlock::Text(text.into()),
                    ],
                    has_tool_calls: true,
                    streaming: false,
                    error,
                    aborted: true,
                })));
            }
        }
        use crate::custom_message::*;
        view.push_entry(ChatEntry::AgentMessage(Box::new(AgentMessageRow {
            direction: AgentMessageDirection::Received,
            participant: "from child".into(),
            message: "hello 界\nnext".into(),
        })));
        view.push_entry(ChatEntry::ShellCompletion(Box::new(ShellCompletionRow {
            pid: Some(42),
            exit_code: Some(0),
            content: "output\nnext".into(),
        })));
        view.push_entry(ChatEntry::CustomPanel(Box::new(CustomPanelRow {
            custom_type: "notice".into(),
            content: "**body**".into(),
        })));
        view.push_entry(ChatEntry::SkillInvocation(Box::new(SkillInvocationRow {
            name: "skill".into(),
            content: "## Skill\nbody".into(),
        })));
        view.push_entry(ChatEntry::User {
            text: "skill arguments".into(),
        });
        view.push_entry(ChatEntry::InjectedPrompt(Box::new(InjectedPromptRow {
            kind: InjectedPromptKind::Heartbeat {
                schedule: Some("daily".into()),
            },
            body: Some("body\nsecond".into()),
        })));
        view.push_entry(ChatEntry::RefinementOutcome(Box::new(
            RefinementOutcomeRow {
                header: "Refined".into(),
                summary: "summary".into(),
                meta: "meta".into(),
                edits: Vec::new(),
            },
        )));
        view.push_entry(ChatEntry::CompactionSummary {
            summary: "summary\nnext".into(),
            tokens_before: 100,
            custom_instructions: Some("keep code".into()),
        });
        view.push_entry(ChatEntry::ClientMarkdown {
            text: "# help\nbody".into(),
        });
        view.push_entry(ChatEntry::ClientText {
            rows: vec![Vec::new()],
        });
        view.push_entry(ChatEntry::ChangelogPanel {
            markdown: "## Changes\n- fix".into(),
        });
        for name in ["bash", "ipython", "other"] {
            view.push_entry(ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
                name: name.into(),
                args: serde_json::json!({"command":"echo hi", "code":"print(1)"}),
                result: Some(crate::chat::ToolResultView {
                    content: vec![serde_json::json!({"type":"text","text":"out\nsecond"})],
                    details: serde_json::Value::Null,
                    is_error: false,
                }),
                ..Default::default()
            })));
        }
        for detail in [Detail::Overview, Detail::Details, Detail::All] {
            view.detail = detail;
            for width in [0, 1, 7, 20, 80] {
                for (index, entry) in view.chat.iter().enumerate() {
                    let preceded = index > 0 && matches!(view.chat[index - 1], ChatEntry::Tool(_));
                    assert_eq!(
                        view.count_entry_rows(index, width),
                        view.render_entry(index, entry, width, index == 0, preceded)
                            .len(),
                        "entry {index}, width {width}, detail {detail:?}"
                    );
                }
            }
        }
    }
}
