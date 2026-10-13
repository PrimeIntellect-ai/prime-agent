//! Exact count-only geometry for every transcript entry family.
use super::AgentView;
use crate::chat::ChatEntry;

impl AgentView {
    pub(super) fn count_entry_rows(&self, index: usize, width: usize) -> usize {
        #[cfg(test)]
        super::layout::ENTRY_VISITS.with(|count| count.set(count.get() + 1));
        let entry = &self.chat[index];
        // TS `precededByToolActivity` = the compact set.
        let preceded_by_tool = index > 0 && Self::is_compact_neighbor(&self.chat[index - 1]);
        let spacing = self.entry_spacing(index, entry, index == 0, preceded_by_tool);
        let detail = self.entry_detail(index);
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
            ChatEntry::Assistant(message) => {
                // Settled blocks replay from the entry's render cache.
                let caches = self.md_caches.borrow();
                let empty = crate::markdown::MarkdownBlockCache::default();
                crate::chat::assistant_row_count(
                    message,
                    detail,
                    &self.theme,
                    &self.code_block_indent,
                    width,
                    preceded_by_tool,
                    caches.get(&index).unwrap_or(&empty),
                )
            }
            ChatEntry::SlashCommand { text } => {
                usize::from(spacing)
                    + crate::chat_slash::slash_command_row_count(text, &self.theme, width)
            }
            ChatEntry::AgentMessage(row) => {
                crate::custom_message::geometry::agent_message_row_count(
                    row,
                    detail,
                    &self.theme,
                    width,
                    spacing,
                )
            }
            ChatEntry::ShellCompletion(row) => {
                crate::custom_message::geometry::shell_completion_row_count(
                    row, detail, width, spacing,
                )
            }
            ChatEntry::CustomPanel(row) => {
                crate::custom_message::geometry::custom_panel_row_count(row, &self.theme, width)
            }
            ChatEntry::Tool(card) => {
                usize::from(spacing)
                    + crate::tool_card::count_tool_card(
                        card,
                        self.pulse_frame,
                        detail,
                        &self.theme,
                        width,
                        self.show_images,
                    )
            }
            ChatEntry::BashExecution(card) => {
                // The card render is bounded (a 20-visual-line preview
                // plus its chrome), so the exact count reuses the render
                // instead of duplicating the wrap/preview/status logic.
                let cancel_hint = self.editor.keybindings().key_text("tui.select.cancel");
                usize::from(!card.suppress_leading_space)
                    + crate::bash_card::render_bash_execution(
                        card,
                        self.pulse_frame,
                        detail.tool_output_expanded(),
                        &cancel_hint,
                        &self.theme,
                        width,
                    )
                    .len()
            }
            ChatEntry::SkillInvocation(row) => {
                crate::custom_message::skill_invocation::count_skill_invocation(
                    row,
                    detail,
                    &self.theme,
                    width,
                    spacing,
                )
            }
            ChatEntry::InjectedPrompt(row) => {
                crate::custom_message::injected_prompt::count_injected_prompt(
                    row,
                    detail,
                    &self.theme,
                    width,
                )
            }
            ChatEntry::RefinementOutcome(row) => {
                crate::custom_message::refinement::count_refinement_outcome(
                    row,
                    detail,
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
                        detail.tool_output_expanded(),
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
    use crate::chat::{
        AssistantMessage, Detail, MessageBlock, StatusKind, ToolCallCard, ToolResultView,
    };
    use crate::custom_message::*;
    use crate::theme::{ColorMode, Theme};
    use proptest::prelude::*;
    use proptest::test_runner::RngSeed;

    /// Arbitrary markdown soup: inline noise (wide, combining, emoji,
    /// ZWJ, tabs), very long lines, and block starts (fences, tables,
    /// lists, quotes, headings, links, OSC-8).
    fn markdown_text() -> impl Strategy<Value = String> {
        let line = prop_oneof![
            4 => "[a-z 界é\u{301}🙂\u{200d}*_`#>|\\-\\[\\]()\t]{0,40}",
            1 => "[a-z ]{60,400}",
            1 => prop::sample::select(vec![
                "", "```python", "```", "| a | b |", "|---|---|", "- item",
                "1. item", "10. item", "> quote", "# Heading", "---",
                "    indented", "/model --flag @src/a.rs",
                "| a | b |\n|---|---|",
                "[link](https://example.com) **bold**",
                "\u{1b}]8;;https://example.com\u{7}link\u{1b}]8;;\u{7} tail",
                "\u{1b}[31mred\u{1b}[0m",
            ])
            .prop_map(str::to_owned),
        ];
        let text = prop::collection::vec(line, 0..12).prop_map(|lines| lines.join("\n"));
        prop_oneof![
            8 => text.clone(),
            1 => text.prop_map(|text| format!("/goal @path --flag {text}")),
            1 => prop::sample::select(vec!["", " ", "  \n\n"]).prop_map(str::to_owned),
        ]
    }

    fn error_text() -> impl Strategy<Value = String> {
        prop_oneof![
            markdown_text(),
            markdown_text().prop_map(|body| format!(
                "Traceback (most recent call last):\n  File test.py\nError:\n{body}"
            )),
            "[a-z 界]{1,40}"
                .prop_map(|base| format!("{base}\n\nRun /login to update credentials.")),
            markdown_text().prop_map(|body| format!("{body}\n\nRun /login to update credentials.")),
        ]
    }

    fn assistant_message() -> impl Strategy<Value = AssistantMessage> {
        (
            prop::collection::vec(
                prop_oneof![
                    markdown_text().prop_map(MessageBlock::Text),
                    markdown_text().prop_map(MessageBlock::Thinking),
                ],
                0..4,
            ),
            any::<bool>(),
            any::<bool>(),
            any::<bool>(),
            prop::option::of(error_text()),
        )
            .prop_map(|(blocks, has_tool_calls, streaming, aborted, error)| {
                AssistantMessage {
                    blocks,
                    has_tool_calls,
                    streaming,
                    error,
                    aborted,
                }
            })
    }

    /// Settled cards carry both instants (a stable `Took` row); unsettled
    /// ones carry none, so no live elapsed text races count against paint.
    /// Partial cards keep either both instants or none.
    fn tool_card() -> impl Strategy<Value = ToolCallCard> {
        let args = prop_oneof![
            Just(serde_json::json!({})),
            Just(serde_json::json!({"command": null})),
            Just(serde_json::json!({"long": [1, 2, 3, 4], "unicode": "数据"})),
            (
                prop::sample::select(vec!["", "!", "%%bash\n"]),
                markdown_text(),
                any::<bool>()
            )
                .prop_map(|(head, text, timeout)| {
                    let mut args =
                        serde_json::json!({"command": text, "code": format!("{head}{text}")});
                    if timeout {
                        args["timeout"] = serde_json::json!(123);
                    }
                    args
                }),
        ];
        let details = prop_oneof![
            Just(serde_json::Value::Null),
            Just(
                serde_json::json!({"truncation": {"truncated": true, "truncatedBy": "lines",
                "outputLines": 2, "totalLines": 10}, "fullOutputPath": "/tmp/full"})
            ),
            Just(
                serde_json::json!({"stdout": "abc 界\n\n", "stderr": "err\n", "result": "value",
                "backgroundOutput": "async\nlog", "status": "ok", "durationMs": 3})
            ),
            Just(serde_json::json!({"error": {"ename": "E", "evalue": "boom", "traceback": []}})),
            Just(serde_json::json!({"error": {"ename": "E", "evalue": "boom",
                "traceback": ["Traceback", "E: boom"]}, "status": "error"})),
            Just(
                serde_json::json!({"diffs": [{"path": "x", "diff": "-x\n+y"}], "stdout": "Edited x"})
            ),
            markdown_text().prop_map(|message| serde_json::json!({"sentAgentMessages": [
                {"message": message, "deliveryStatus": "delivered", "receiverRole": "parent"},
                {"id": "invalid"}]})),
        ];
        let image = prop::option::of(prop::sample::select(vec![
            serde_json::json!({"type": "image"}),
            serde_json::json!({"type": "image", "mimeType": "image/png"}),
            serde_json::json!({"type": "image", "data": "", "mimeType": "image/png"}),
            serde_json::json!({"type": "image", "data": "iVBORwAAAAAAAAAAAAAAAAAAAAIAAAAD",
                "mimeType": "image/png"}),
        ]));
        (
            prop::sample::select(vec!["bash", "ipython", "other"]),
            args,
            prop::bool::weighted(0.75),
            any::<bool>(),
            prop::option::of((
                prop::option::of(error_text()),
                image,
                details,
                any::<bool>(),
            )),
        )
            .prop_map(
                |(name, args, settled, result_partial, result)| ToolCallCard {
                    name: name.to_string(),
                    args,
                    started: settled,
                    started_at: settled.then(std::time::Instant::now),
                    ended_at: settled.then(std::time::Instant::now),
                    result_partial,
                    result: result.map(|(output, image, details, is_error)| ToolResultView {
                        content: output
                            .map(|text| serde_json::json!({"type": "text", "text": text}))
                            .into_iter()
                            .chain(image)
                            .collect(),
                        details,
                        is_error,
                    }),
                    ..Default::default()
                },
            )
    }

    fn injected_kind() -> impl Strategy<Value = InjectedPromptKind> {
        prop_oneof![
            prop::option::of("[a-z0-9 ]{0,20}")
                .prop_map(|schedule| InjectedPromptKind::Heartbeat { schedule }),
            (
                prop::option::of("[a-z]{1,12}"),
                prop::option::of(markdown_text())
            )
                .prop_map(|(kind, objective)| InjectedPromptKind::Goal { kind, objective }),
            any::<bool>().prop_map(|restored| InjectedPromptKind::KernelRestored { restored }),
            prop::collection::vec("[a-z 数据]{1,12}", 0..4)
                .prop_map(|skills| InjectedPromptKind::PythonSkillsUnavailable { skills }),
        ]
    }

    fn entry() -> impl Strategy<Value = ChatEntry> {
        prop_oneof![
            1 => (markdown_text(), prop::sample::select(vec![
                StatusKind::Info,
                StatusKind::Warning,
                StatusKind::Error,
            ]))
                .prop_map(|(text, kind)| ChatEntry::Status { text, kind }),
            1 => markdown_text().prop_map(|text| ChatEntry::User { text }),
            1 => markdown_text().prop_map(|text| ChatEntry::SlashCommand { text }),
            1 => (
                markdown_text(),
                any::<u64>(),
                prop::option::of(markdown_text())
            )
                .prop_map(|(summary, tokens_before, custom_instructions)| {
                    ChatEntry::CompactionSummary {
                        summary,
                        tokens_before,
                        custom_instructions,
                    }
                }),
            1 => assistant_message().prop_map(|message| ChatEntry::Assistant(Box::new(message))),
            6 => tool_card().prop_map(|card| ChatEntry::Tool(Box::new(card))),
            1 => markdown_text().prop_map(|message| {
                ChatEntry::AgentMessage(Box::new(AgentMessageRow {
                    direction: AgentMessageDirection::Received,
                    counterpart: "lane".to_string(),
                    message,
                }))
            }),
            1 => markdown_text().prop_map(|content| {
                ChatEntry::SkillInvocation(Box::new(SkillInvocationRow {
                    name: "skill 数据".to_string(),
                    content,
                }))
            }),
            1 => (injected_kind(), prop::option::of(markdown_text())).prop_map(|(kind, body)| {
                ChatEntry::InjectedPrompt(Box::new(InjectedPromptRow { kind, body }))
            }),
            1 => (
                prop::option::of(0i64..9),
                prop::option::of(0i64..3),
                markdown_text()
            )
                .prop_map(|(pid, exit_code, content)| {
                    ChatEntry::ShellCompletion(Box::new(ShellCompletionRow {
                        pid,
                        exit_code,
                        content,
                    }))
                }),
            1 => (markdown_text(), markdown_text()).prop_map(|(summary, meta)| {
                ChatEntry::RefinementOutcome(Box::new(RefinementOutcomeRow {
                    header: "Refined".to_string(),
                    summary,
                    meta,
                    edits: Vec::new(),
                }))
            }),
            1 => markdown_text().prop_map(|content| {
                ChatEntry::CustomPanel(Box::new(CustomPanelRow {
                    custom_type: "notice".to_string(),
                    content,
                }))
            }),
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: 512,
            rng_seed: RngSeed::Fixed(0x5649_4557),
            ..ProptestConfig::default()
        })]

        // Every transcript entry counts exactly the rows it paints, at
        // every detail level, including narrow widths.
        #[test]
        fn entry_rows_count_what_paint_draws(
            entries in prop::collection::vec(entry(), 1..8),
            detail in prop_oneof![Just(Detail::Overview), Just(Detail::Details), Just(Detail::All)],
            width in prop_oneof![0usize..=16, 0usize..=300],
            indent in prop::sample::select(vec!["", "  "]),
            color in prop::sample::select(vec![ColorMode::TrueColor, ColorMode::Color256]),
            show_images in any::<bool>(),
        ) {
            let mut view = AgentView::new(Theme::builtin("prime", color));
            view.detail = detail;
            view.show_images = show_images;
            indent.clone_into(&mut view.code_block_indent);
            for entry in entries {
                view.push_entry(entry);
            }
            for (index, entry) in view.chat.iter().enumerate() {
                let preceded = index > 0 && AgentView::is_compact_neighbor(&view.chat[index - 1]);
                // Cold count, paint, warm count: streaming entries fill
                // the render cache, and the second count replays it.
                let cold = view.count_entry_rows(index, width);
                prop_assert_eq!(
                    view.render_entry(index, entry, width, index == 0, preceded).len(),
                    cold
                );
                prop_assert_eq!(view.count_entry_rows(index, width), cold);
            }
        }
    }
}
