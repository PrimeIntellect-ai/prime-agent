//! Headless completion and print-mode terminal selection. Port of
//! modes/headless-completion.ts (selection half) and the text-output half of
//! modes/print-mode.ts: pick the terminal result from a headless run and turn
//! it into stdout/stderr/exit-code.

use pa_types::session::{AgentMessage, FileEntry};

use super::messages::SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE;

pub const COMPACTION_OUTCOME_CUSTOM_TYPE: &str = "compaction_outcome";
pub const HARNESS_DIGEST_CUSTOM_TYPE: &str = "harness_digest";
pub const REFINEMENT_OUTCOME_CUSTOM_TYPE: &str = "refinement_outcome";
pub const REFINEMENT_NOTICE_CUSTOM_TYPE: &str = "refinement_notice";

/// The primary terminal result of a headless run.
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum HeadlessPrimary {
    /// The final assistant message.
    Assistant(pa_types::ai::AssistantMessage),
    /// A session slash-command result custom message.
    SlashCommandResult {
        content: String,
        success: bool,
        severity: Option<String>,
    },
}

impl HeadlessPrimary {
    /// Stdout content (None for failed assistant runs).
    pub fn stdout_text(&self) -> Option<String> {
        match self {
            HeadlessPrimary::Assistant(message) => {
                let text = message
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("");
                Some(text)
            }
            HeadlessPrimary::SlashCommandResult { content, .. } => Some(content.clone()),
        }
    }

    /// Stderr content when the run should exit non-zero.
    pub fn stderr_text(&self, exit_code: &mut i32) -> Option<String> {
        match self {
            HeadlessPrimary::Assistant(message) => match message.stop_reason {
                pa_types::ai::StopReason::Error | pa_types::ai::StopReason::Aborted => {
                    *exit_code = 1;
                    Some(
                        message
                            .error_message
                            .clone()
                            .filter(|text| !text.is_empty())
                            .unwrap_or_else(|| {
                                format!("Request {}", stop_reason_name(message.stop_reason))
                            }),
                    )
                }
                _ => None,
            },
            HeadlessPrimary::SlashCommandResult {
                success, severity, ..
            } => {
                if !success || severity.as_deref() == Some("error") {
                    *exit_code = 1;
                }
                None
            }
        }
    }
}

fn stop_reason_name(reason: pa_types::ai::StopReason) -> &'static str {
    match reason {
        pa_types::ai::StopReason::Stop => "stop",
        pa_types::ai::StopReason::Length => "length",
        pa_types::ai::StopReason::ToolUse => "tool_use",
        pa_types::ai::StopReason::Error => "error",
        pa_types::ai::StopReason::Aborted => "aborted",
    }
}

/// One compaction outcome trailing the terminal result.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionOutcome {
    pub content: String,
    pub outcome: String,
}

/// The selected terminal result: primary message plus trailing outcomes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HeadlessTerminalResult {
    pub primary: Option<HeadlessPrimary>,
    pub compaction_outcomes: Vec<CompactionOutcome>,
}

/// Pick the terminal result from the message suffix: compaction outcomes are
/// collected, internal custom notices are skipped, and the first substantive
/// message (assistant or slash-command result) is the primary.
pub fn select_headless_terminal_result(messages: &[AgentMessage]) -> HeadlessTerminalResult {
    let mut index: i64 = messages.len() as i64 - 1;
    let mut compaction_outcomes: Vec<CompactionOutcome> = Vec::new();
    while index >= 0 {
        let message = &messages[index as usize];
        match message {
            AgentMessage::Custom(custom) => match custom.custom_type.as_str() {
                COMPACTION_OUTCOME_CUSTOM_TYPE => {
                    compaction_outcomes.insert(
                        0,
                        CompactionOutcome {
                            content: custom.content.text(),
                            outcome: custom
                                .details
                                .as_ref()
                                .and_then(|details| details.get("outcome"))
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                        },
                    );
                    index -= 1;
                    continue;
                }
                // A corrupt outcome is still part of the suffix; skip it
                // without letting it hide earlier valid outcomes.
                REFINEMENT_OUTCOME_CUSTOM_TYPE
                | REFINEMENT_NOTICE_CUSTOM_TYPE
                | HARNESS_DIGEST_CUSTOM_TYPE => {
                    index -= 1;
                    continue;
                }
                SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE => break,
                _ => break,
            },
            AgentMessage::Assistant(_) => break,
            _ => break,
        }
    }
    let primary = if index >= 0 {
        match &messages[index as usize] {
            AgentMessage::Assistant(assistant) => {
                Some(HeadlessPrimary::Assistant(assistant.clone()))
            }
            AgentMessage::Custom(custom)
                if custom.custom_type == SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE =>
            {
                let details = custom.details.clone().unwrap_or_default();
                Some(HeadlessPrimary::SlashCommandResult {
                    content: custom.content.text(),
                    success: details.get("success") == Some(&serde_json::json!(true)),
                    severity: details
                        .get("severity")
                        .and_then(serde_json::Value::as_str)
                        .map(std::string::ToString::to_string),
                })
            }
            _ => None,
        }
    } else {
        None
    };
    HeadlessTerminalResult {
        primary,
        compaction_outcomes,
    }
}

/// Terminal-selection over session entries (rebuilds the message list).
pub fn select_from_entries(entries: &[FileEntry]) -> HeadlessTerminalResult {
    let messages: Vec<AgentMessage> = entries
        .iter()
        .filter_map(|entry| match entry {
            FileEntry::Message { message, .. } => Some(message.clone()),
            _ => None,
        })
        .collect();
    select_headless_terminal_result(&messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autonomous::{AgentAutonomousStatus, AutonomousLimitReason};
    use pa_types::ai::{
        AssistantContentBlock, AssistantMessage, StopReason, TextContent, UserContent, UserMessage,
    };
    use pa_types::session::{CompactionSummaryMessage, CustomMessage};

    fn text_assistant(text: &str, stop_reason: StopReason) -> AgentMessage {
        AgentMessage::Assistant(AssistantMessage {
            content: vec![AssistantContentBlock::Text(TextContent {
                text: text.to_string(),
                text_signature: None,
                rest: Default::default(),
            })],
            api: "openai-completions".to_string(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Default::default(),
            stop_reason,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: Default::default(),
        })
    }

    fn custom(custom_type: &str, content: &str, outcome: Option<&str>) -> AgentMessage {
        let mut details = serde_json::json!({});
        if let Some(outcome) = outcome {
            details["outcome"] = serde_json::json!(outcome);
        }
        AgentMessage::Custom(CustomMessage {
            custom_type: custom_type.to_string(),
            content: UserContent::Text(content.to_string()),
            display: true,
            details: Some(details),
            timestamp: 0,
            rest: Default::default(),
        })
    }

    #[test]
    fn selects_final_assistant_message() {
        let messages = vec![
            AgentMessage::User(UserMessage {
                content: UserContent::Text("go".to_string()),
                timestamp: 0,
                rest: Default::default(),
            }),
            text_assistant("first", StopReason::Stop),
            text_assistant("final answer", StopReason::Stop),
        ];
        let result = select_headless_terminal_result(&messages);
        let primary = result.primary.unwrap();
        assert_eq!(primary.stdout_text().as_deref(), Some("final answer"));
        let mut exit_code = 0;
        assert!(primary.stderr_text(&mut exit_code).is_none());
        assert_eq!(exit_code, 0);
    }

    #[test]
    fn failed_assistant_runs_exit_nonzero() {
        let mut error = text_assistant("partial", StopReason::Error);
        if let AgentMessage::Assistant(message) = &mut error {
            message.error_message = Some("provider exploded".to_string());
        }
        let result = select_headless_terminal_result(&[error]);
        let primary = result.primary.unwrap();
        let mut exit_code = 0;
        assert_eq!(
            primary.stderr_text(&mut exit_code).as_deref(),
            Some("provider exploded")
        );
        assert_eq!(exit_code, 1);
        // Aborted runs fall back to a generic message.
        let aborted = text_assistant("partial", StopReason::Aborted);
        let result = select_headless_terminal_result(&[aborted]);
        let mut exit_code = 0;
        assert_eq!(
            result
                .primary
                .unwrap()
                .stderr_text(&mut exit_code)
                .as_deref(),
            Some("Request aborted")
        );
    }

    #[test]
    fn skips_internal_suffix_and_collects_compactions() {
        let messages = vec![
            text_assistant("answer", StopReason::Stop),
            custom(
                COMPACTION_OUTCOME_CUSTOM_TYPE,
                "compacted 3 entries",
                Some("success"),
            ),
            custom(REFINEMENT_NOTICE_CUSTOM_TYPE, "[self-refinement]", None),
            custom(HARNESS_DIGEST_CUSTOM_TYPE, "digest", None),
            custom(
                COMPACTION_OUTCOME_CUSTOM_TYPE,
                "compacted again",
                Some("failed"),
            ),
        ];
        let result = select_headless_terminal_result(&messages);
        assert_eq!(
            result.primary.unwrap().stdout_text().as_deref(),
            Some("answer")
        );
        assert_eq!(result.compaction_outcomes.len(), 2);
        assert_eq!(result.compaction_outcomes[0].content, "compacted 3 entries");
        assert_eq!(result.compaction_outcomes[1].outcome, "failed");
    }

    #[test]
    fn slash_command_results_are_primary() {
        let messages = vec![
            text_assistant("prior", StopReason::Stop),
            AgentMessage::Custom(CustomMessage {
                custom_type: SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE.to_string(),
                content: UserContent::Text("Compacted the session".to_string()),
                display: true,
                details: Some(serde_json::json!({ "success": true })),
                timestamp: 0,
                rest: Default::default(),
            }),
        ];
        let result = select_headless_terminal_result(&messages);
        let HeadlessPrimary::SlashCommandResult {
            content,
            success,
            severity,
        } = result.primary.unwrap()
        else {
            panic!("expected slash-command result");
        };
        assert_eq!(content, "Compacted the session");
        assert!(success);
        assert_eq!(severity, None);
    }

    #[test]
    fn non_suffix_messages_stop_the_walk() {
        // A compaction summary (not a custom message) ends the suffix walk.
        let messages = vec![
            text_assistant("answer", StopReason::Stop),
            AgentMessage::CompactionSummary(CompactionSummaryMessage {
                summary: "prior".to_string(),
                tokens_before: 0,
                retained_message_count: None,
                custom_instructions: None,
                harness_digest: None,
                harness_state_fingerprint: None,
                timestamp: 0,
            }),
            custom(COMPACTION_OUTCOME_CUSTOM_TYPE, "later", Some("success")),
        ];
        let result = select_headless_terminal_result(&messages);
        // The walk collects the trailing outcome, then stops at the
        // compaction summary: nothing before it is a terminal candidate.
        assert_eq!(result.compaction_outcomes.len(), 1);
        assert_eq!(result.compaction_outcomes[0].content, "later");
        assert!(result.primary.is_none());
    }

    #[test]
    fn gate_attempt_and_limit_descriptions() {
        let mut status = AgentAutonomousStatus {
            enabled: true,
            continuations_used: 2,
            turns_used: 5,
            tokens_used: 1_000,
            started_at: Some(1_000),
            limits: crate::autonomous::AutonomousLimits {
                max_continuations: 3,
                max_turns: 12,
                max_tokens: 80_000,
                timeout_ms: 1_800_000,
            },
            gates: crate::autonomous::NormalizedGateConfig {
                commands: vec!["make check".to_string()],
                max_retries: 3,
                timeout_ms: 300_000,
            },
            gate_attempts: [("make check".to_string(), 2u64)].into_iter().collect(),
            last_gate_failure: None,
            subagent_keep_alive_ms: None,
        };
        assert_eq!(
            crate::autonomous::latest_autonomous_gate_attempt(&status),
            2
        );
        status.last_gate_failure = Some(crate::autonomous::AgentAutonomousGateFailure {
            command: "make check".to_string(),
            attempt: 3,
            exit_text: "exited with code 1".to_string(),
            output: String::new(),
        });
        assert_eq!(
            crate::autonomous::latest_autonomous_gate_attempt(&status),
            3
        );
        assert_eq!(
            crate::autonomous::describe_autonomous_limit(
                &status,
                AutonomousLimitReason::MaxTurns,
                0,
            ),
            "maxTurns reached (5/12)"
        );
        assert_eq!(
            crate::autonomous::describe_autonomous_limit(
                &status,
                AutonomousLimitReason::MaxTokens,
                0
            ),
            "maxTokens reached (1000/80000)"
        );
        assert_eq!(
            crate::autonomous::describe_autonomous_limit(
                &status,
                AutonomousLimitReason::MaxContinuations,
                0
            ),
            "maxContinuations reached (2/3)"
        );
    }
}
