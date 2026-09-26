//! LLM-facing message conversion. Port of convertToLlm and the message
//! presentation constants in core/messages.ts.

use super::agent_messaging::sanitize_message_header_value;
use crate::cron::AgentCronJob;
use pa_types::ai::{
    AssistantMessage, TextContent, ToolResultMessage, UserContent, UserContentBlock, UserMessage,
};
use pa_types::session::AgentMessage;
use std::fmt::Write as _;

pub const COMPACTION_SUMMARY_PREFIX: &str = "[compaction-summary]\n\nThe conversation history before this point was compacted into the following summary:\n\n<summary>\n";
pub const COMPACTION_SUMMARY_SUFFIX: &str = "\n</summary>";
pub const BRANCH_SUMMARY_PREFIX: &str = "[branch-summary]\n\nThe following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
pub const BRANCH_SUMMARY_SUFFIX: &str = "\n</summary>";
pub const HARNESS_DIGEST_PREFIX: &str = "[harness-digest]\n\nThe persistent memories produced across this session so far:\n\n<harness_state>\n";
pub const HARNESS_DIGEST_SUFFIX: &str = "\n</harness_state>";

pub use pa_types::slash_commands::{
    SESSION_SLASH_COMMAND_CUSTOM_TYPE, SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
};
pub const COMPACTION_OUTCOME_CUSTOM_TYPE: &str = "compaction_outcome";
pub const REFINEMENT_OUTCOME_CUSTOM_TYPE: &str = "refinement_outcome";
pub const REFINEMENT_NOTICE_CUSTOM_TYPE: &str = "refinement_notice";
/// The durable single-row disclosure of one provider-retry episode
/// (SANCTIONED DIVERGENCE from TS, operator ruling 2026-09-23: the TS chat
/// leaves one error row per failed attempt, which a 429-storm turned into
/// chat spam): a `provider_retry_outcome` custom message carrying the one
/// resolved/terminal row of the whole episode, with
/// `{success, attempts, finalError}` details. Like the compaction outcome
/// it is a user-facing disclosure, never model context — `convert_to_llm`
/// drops it.
pub const PROVIDER_RETRY_OUTCOME_CUSTOM_TYPE: &str = "provider_retry_outcome";
pub const HEARTBEAT_PROMPT_CUSTOM_TYPE: &str = "heartbeat_prompt";
/// TS `ASYNC_BASH_COMPLETION_CUSTOM_TYPE`: the durable row a detached
/// kernel bash completion admits as the woken turn's injected prompt.
pub const ASYNC_BASH_COMPLETION_CUSTOM_TYPE: &str = "async_bash_completion";
/// TS `ASYNC_BASH_COMPLETION_PREVIEW_LABEL`: the queue-strip label the
/// notice's queued row carries (the TUI renders it with its own label,
/// no lane prefix).
pub const ASYNC_BASH_COMPLETION_PREVIEW_LABEL: &str = "Background command finished";
/// The queue-strip preview label for a parked heartbeat fire (TS
/// `HEARTBEAT_PROMPT_PREVIEW_LABEL`): the queued row reads
/// `Heartbeat prompt: <content>` instead of the lane-labeled preview.
pub const HEARTBEAT_PROMPT_PREVIEW_LABEL: &str = "Heartbeat prompt";

/// Why an unsuccessful compaction ran (TS `CompactionOutcomeReason`): the
/// automatic threshold trigger, the overflow recovery, or the model's
/// `compact.run` request consumed at a turn boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionOutcomeReason {
    /// The context crossed the auto-compaction threshold.
    Threshold,
    /// A context-overflow recovery attempt.
    Overflow,
    /// The model requested the compaction (`compact.run`).
    Requested,
}

impl CompactionOutcomeReason {
    /// The wire `reason` string: the outcome row's `details.reason` and the
    /// `compaction_end` event's `reason`.
    pub fn wire(self) -> &'static str {
        match self {
            Self::Threshold => "threshold",
            Self::Overflow => "overflow",
            Self::Requested => "requested",
        }
    }
}

/// How an unsuccessful compaction ended (TS `CompactionOutcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionOutcomeKind {
    /// Nothing to summarize (TS `CompactionSkippedError`).
    Skipped,
    /// Aborted mid-run.
    Cancelled,
    /// The summarization failed.
    Failed,
}

impl CompactionOutcomeKind {
    /// The wire `outcome` string: the outcome row's `details.outcome`.
    pub fn wire(self) -> &'static str {
        match self {
            Self::Skipped => "skipped",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

/// The resolved-line text of a retry episode that recovered: the last
/// error plus how many retries it took. This is the ONE line the episode
/// leaves in the chat (live and rebuilt), replacing the per-attempt error
/// rows TS keeps.
pub fn provider_retry_recovered_text(attempts: u32, last_error: &str) -> String {
    format!("Recovered after {attempts} retries: {last_error}")
}

/// The terminal-line text of a retry episode that gave up: the same text
/// the TS `auto_retry_end` live row carries, so the durable row and the
/// live one read identically.
pub fn provider_retry_exhausted_text(attempts: u32, final_error: &str) -> String {
    format!("\u{26a0} Error: Retry failed after {attempts} attempts: {final_error}")
}

/// The durable disclosure row of one provider-retry episode (see
/// [`PROVIDER_RETRY_OUTCOME_CUSTOM_TYPE`]): `content` carries the row text
/// the chat renders, `details` the structured verdict.
pub fn create_provider_retry_outcome_message(
    success: bool,
    attempts: u32,
    error: &str,
) -> pa_types::session::CustomMessage {
    let content = if success {
        provider_retry_recovered_text(attempts, error)
    } else {
        provider_retry_exhausted_text(attempts, error)
    };
    pa_types::session::CustomMessage {
        custom_type: PROVIDER_RETRY_OUTCOME_CUSTOM_TYPE.to_string(),
        content: UserContent::Text(content),
        display: true,
        details: Some(serde_json::json!({
            "success": success,
            "attempts": attempts,
            "finalError": error,
        })),
        timestamp: now_millis(),
        rest: serde_json::Map::default(),
    }
}

/// The durable disclosure row for an unsuccessful compaction (TS
/// `createCompactionOutcomeMessage`): a `compaction_outcome` custom message
/// carrying the outcome message and `{reason, outcome}` details. It is a
/// user-facing disclosure, never model context — `convert_to_llm` drops it,
/// so the KV-cacheable prefix is unaffected.
pub fn create_compaction_outcome_message(
    content: &str,
    reason: CompactionOutcomeReason,
    outcome: CompactionOutcomeKind,
) -> pa_types::session::CustomMessage {
    pa_types::session::CustomMessage {
        custom_type: COMPACTION_OUTCOME_CUSTOM_TYPE.to_string(),
        content: UserContent::Text(content.to_string()),
        display: true,
        details: Some(serde_json::json!({
            "reason": reason.wire(),
            "outcome": outcome.wire(),
        })),
        timestamp: now_millis(),
        rest: serde_json::Map::default(),
    }
}

/// The durable heartbeat delivery row (TS `createHeartbeatPromptMessage`):
/// a `heartbeat_prompt` custom message carrying the job's prompt under the
/// `[heartbeat: <schedule> run#<n>]` header, with the job's run bookkeeping
/// in details. The header value is sanitized like every other
/// `[<kind> ...]` header (TS `sanitizeMessageHeaderValue`); the daemon's
/// fire delivers the row as the turn's injected prompt, so the transcript
/// renders the heartbeat component instead of a plain user message.
pub fn create_heartbeat_prompt_message(
    job: &AgentCronJob,
    timestamp: u64,
) -> pa_types::session::CustomMessage {
    let schedule = sanitize_message_header_value(&job.schedule.expression);
    let content = format!(
        "[heartbeat: {schedule} run#{}]\n\n{}",
        job.run_count, job.prompt
    );
    // The details block mirrors the TS JSON exactly: the fixed keys in
    // the TS order, and the optional `nextRunAt`/`lastRunAt` omitted
    // while undefined (TS `JSON.stringify` drops undefined fields, so a
    // first fire carries no `lastRunAt`).
    let mut details = serde_json::Map::new();
    details.insert("jobId".to_string(), serde_json::json!(job.id));
    details.insert(
        "schedule".to_string(),
        serde_json::json!(job.schedule.expression),
    );
    details.insert(
        "status".to_string(),
        serde_json::to_value(job.status).unwrap_or(serde_json::Value::Null),
    );
    details.insert("runCount".to_string(), serde_json::json!(job.run_count));
    if let Some(next_run_at) = &job.next_run_at {
        details.insert("nextRunAt".to_string(), serde_json::json!(next_run_at));
    }
    if let Some(last_run_at) = &job.last_run_at {
        details.insert("lastRunAt".to_string(), serde_json::json!(last_run_at));
    }
    pa_types::session::CustomMessage {
        custom_type: HEARTBEAT_PROMPT_CUSTOM_TYPE.to_string(),
        content: UserContent::Text(content),
        display: true,
        details: Some(serde_json::Value::Object(details)),
        timestamp,
        rest: serde_json::Map::default(),
    }
}

/// The detached kernel bash completion notice (TS
/// `createAsyncBashCompletionMessage`): an `async_bash_completion`
/// custom message carrying `[bash-done pid:N exit:M]` plus the
/// JSON-encoded command, with the completion's `{pid, command,
/// exitCode}` in details. The daemon's `bash.completed` host handler
/// admits the row as the woken turn's injected prompt (the turn runs on
/// the row, so the transcript renders the bash-done component); a
/// later kernel read that reaches the model first withdraws it through
/// its details (`bash.consumed`).
pub fn create_async_bash_completion_message(
    pid: u32,
    command: &str,
    exit_code: i64,
    timestamp: u64,
) -> pa_types::session::CustomMessage {
    // TS `JSON.stringify(details.command)`: the quoted, escaped command.
    let encoded_command = serde_json::to_string(command).unwrap_or_default();
    let content = format!("[bash-done pid:{pid} exit:{exit_code}]\n\nCommand: {encoded_command}");
    pa_types::session::CustomMessage {
        custom_type: ASYNC_BASH_COMPLETION_CUSTOM_TYPE.to_string(),
        content: UserContent::Text(content),
        display: true,
        details: Some(serde_json::json!({
            "pid": pid,
            "command": command,
            "exitCode": exit_code,
        })),
        timestamp,
        rest: serde_json::Map::default(),
    }
}

/// Bash output rendered as a fenced block with a fence longer than any
/// backtick run inside the output.
fn bash_output_to_text(
    output: &str,
    exit_code: Option<i64>,
    cancelled: bool,
    truncated: bool,
    full_output_path: Option<&str>,
) -> String {
    let mut text = String::new();
    if output.is_empty() {
        text.push_str("(no output)");
    } else {
        let longest = output
            .match_indices('`')
            .fold(0usize, |longest, (index, _)| {
                let mut run = 0usize;
                let mut chars = output[index..].chars();
                while chars.next() == Some('`') {
                    run += 1;
                }
                run.max(longest)
            });
        let fence = "`".repeat(longest.max(3).max(longest + 1));
        text.push_str(&fence);
        text.push('\n');
        text.push_str(output);
        text.push('\n');
        text.push_str(&fence);
    }
    if cancelled {
        text.push_str("\n\n(command cancelled)");
    } else if let Some(code) = exit_code {
        if code != 0 {
            let _ = write!(text, "\n\nCommand exited with code {code}");
        }
    }
    if truncated {
        match full_output_path {
            Some(path) => {
                let _ = write!(text, "\n\n[Output truncated. Full output: {path}]");
            }
            None => text.push_str("\n\n[Output truncated.]"),
        }
    }
    text
}

/// Bash execution as user-facing text for LLM context.
pub fn bash_execution_to_text(message: &pa_types::session::BashExecutionMessage) -> String {
    format!(
        "Ran `{}`\n{}",
        message.command,
        bash_output_to_text(
            &message.output,
            message.exit_code,
            message.cancelled,
            message.truncated,
            message.full_output_path.as_deref(),
        )
    )
}

fn text_block(text: String) -> UserContentBlock {
    UserContentBlock::Text(TextContent {
        text,
        text_signature: None,
        rest: serde_json::Map::default(),
    })
}

/// The LLM message view of session messages: session-only roles become user
/// text turns; bookkeeping custom types drop out entirely.
pub fn convert_to_llm(messages: &[AgentMessage]) -> Vec<AgentMessage> {
    let mut out = Vec::new();
    for message in messages {
        let converted = match message {
            AgentMessage::BashExecution(bash) => {
                if bash.exclude_from_context.unwrap_or(false) {
                    continue;
                }
                AgentMessage::User(UserMessage {
                    content: UserContent::Blocks(vec![text_block(bash_execution_to_text(bash))]),
                    timestamp: bash.timestamp,
                    rest: serde_json::Map::default(),
                })
            }
            AgentMessage::Custom(custom) => {
                if matches!(
                    custom.custom_type.as_str(),
                    SESSION_SLASH_COMMAND_CUSTOM_TYPE
                        | SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE
                        | COMPACTION_OUTCOME_CUSTOM_TYPE
                        | REFINEMENT_OUTCOME_CUSTOM_TYPE
                        | PROVIDER_RETRY_OUTCOME_CUSTOM_TYPE
                ) {
                    continue;
                }
                // TS wraps a string content into a text-part array and
                // passes block content through (the request's cacheable
                // shape is the array either way).
                let content = match custom.content.clone() {
                    UserContent::Text(text) => UserContent::Blocks(vec![text_block(text)]),
                    blocks @ UserContent::Blocks(_) => blocks,
                };
                AgentMessage::User(UserMessage {
                    content,
                    timestamp: custom.timestamp,
                    rest: serde_json::Map::default(),
                })
            }
            AgentMessage::BranchSummary(summary) => AgentMessage::User(UserMessage {
                content: UserContent::Blocks(vec![text_block(format!(
                    "{BRANCH_SUMMARY_PREFIX}{}{BRANCH_SUMMARY_SUFFIX}",
                    summary.summary
                ))]),
                timestamp: summary.timestamp,
                rest: serde_json::Map::default(),
            }),
            AgentMessage::CompactionSummary(summary) => {
                let digest_block = summary
                    .harness_digest
                    .as_deref()
                    .map(|digest| {
                        format!("{HARNESS_DIGEST_PREFIX}{digest}{HARNESS_DIGEST_SUFFIX}\n\n")
                    })
                    .unwrap_or_default();
                AgentMessage::User(UserMessage {
                    content: UserContent::Blocks(vec![text_block(format!(
                        "{digest_block}{COMPACTION_SUMMARY_PREFIX}{}{COMPACTION_SUMMARY_SUFFIX}",
                        summary.summary
                    ))]),
                    timestamp: summary.timestamp,
                    rest: serde_json::Map::default(),
                })
            }
            AgentMessage::User(_) | AgentMessage::Assistant(_) | AgentMessage::ToolResult(_) => {
                message.clone()
            }
        };
        out.push(converted);
    }
    out
}

/// Convenience alias types used by the summarizer call.
pub type LlmAssistantMessage = AssistantMessage;
pub type LlmToolResultMessage = ToolResultMessage;

/// The loop-boundary LLM conversion wired into the agent's `convert_to_llm`
/// seam (TS `convertToLlm` at the agent prompt/request boundary): standard
/// rows pass through; custom rows cross through the session wire shape so
/// the session conversion rules apply — bookkeeping custom types and
/// unknown roles drop, everything else becomes a user turn. This is what
/// lets the harness-digest row ride the loop (prompt input and agent-end
/// message list) while still reaching the provider as model context.
pub fn loop_convert_to_llm(
    messages: Vec<pa_agent::types::AgentMessage>,
) -> Vec<pa_agent::types::Message> {
    let mut out = Vec::new();
    for message in messages {
        match message {
            pa_agent::types::AgentMessage::Standard(message) => out.push(message),
            pa_agent::types::AgentMessage::Custom(custom) => {
                let Some(session_message) = custom_message_to_session(&custom) else {
                    continue;
                };
                for converted in convert_to_llm(std::slice::from_ref(&session_message)) {
                    if let Some(message) = session_llm_row_to_loop(&converted) {
                        out.push(message);
                    }
                }
            }
        }
    }
    out
}

/// Cross the pa-core/pa-agent wire boundary in one buffered pass: the two
/// crates model the same TS wire shapes as separate Rust types, so the
/// bridge is the shared camelCase JSON form — serialized to compact
/// bytes and deserialized straight from the buffer. The JSON is
/// byte-equivalent to the `to_value`/`from_value` crossing this
/// replaces (the wire form is the contract; the deserialized result is
/// identical for these types — see `wire_cross_matches_value_crossing`),
/// without materializing the intermediate `Value` tree, whose cost is an
/// allocation per object and a duplicated `String` per key of the whole
/// context — paid on every context rebuild (compaction, tree
/// navigation, session resume).
pub(crate) fn cross_wire<T, U>(value: &T) -> Option<U>
where
    T: serde::Serialize,
    U: serde::de::DeserializeOwned,
{
    let mut bytes = Vec::new();
    let mut serializer = serde_json::Serializer::new(&mut bytes);
    if value.serialize(&mut serializer).is_ok() {
        let mut deserializer = serde_json::Deserializer::from_slice(&bytes);
        if let Ok(crossed) = U::deserialize(&mut deserializer) {
            return Some(crossed);
        }
    }
    // Degenerate-input fallback, the exact pre-buffering path: a
    // flattened `rest` key colliding with a typed field serializes the
    // wire key twice, and the buffered parse rejects the duplicate where
    // the `Value` map collapses it last-wins. The fallback keeps every
    // message the old crossing kept, with the old result — never a
    // drop. Real inputs never collide (a parsed message's `rest` holds
    // only keys its struct did not model), so the fallback never runs
    // in practice.
    let wire = serde_json::to_value(value).ok()?;
    serde_json::from_value(wire).ok()
}

/// The buffered crossing for the loop's untagged message type
/// (`pa_agent::AgentMessage = Standard(Message) | Custom(...)`), with
/// the old semantics preserved exactly: the standard shapes cross
/// through the compact byte path deserialized straight as the tagged
/// `Message` shape (no untagged variant probing — a colliding
/// degenerate input can never satisfy it and re-resolve as `Custom`,
/// where the old `Value` crossing collapsed the duplicate and produced
/// `Standard`), and anything the byte parse rejects falls back to the
/// full `to_value`/`from_value` round-trip — identical input, identical
/// output, never a drop.
pub(crate) fn cross_wire_loop_message<T>(value: &T) -> Option<pa_agent::types::AgentMessage>
where
    T: serde::Serialize,
{
    if let Some(standard) = cross_wire::<T, pa_agent::types::Message>(value) {
        return Some(pa_agent::types::AgentMessage::Standard(standard));
    }
    let wire = serde_json::to_value(value).ok()?;
    serde_json::from_value(wire).ok()
}

/// One loop custom row as its session wire shape, when the row matches a
/// known session role (`custom`, `bashExecution`, `branchSummary`,
/// `compactionSummary`). Unknown shapes read as unconvertible (TS drops
/// them via the exhaustive-switch default).
fn custom_message_to_session(custom: &pa_agent::types::CustomAgentMessage) -> Option<AgentMessage> {
    cross_wire(custom)
}

/// One converted session row back into its loop wire shape (the shared
/// camelCase wire form crosses the pa-core/pa-agent boundary by JSON
/// round-trip).
fn session_llm_row_to_loop(message: &AgentMessage) -> Option<pa_agent::types::Message> {
    cross_wire(message)
}

/// The `ConvertToLlmFn` handed to the pa-agent loop: infallible by contract
/// (a failed wire round-trip drops the row, mirroring the TS default arm).
pub fn engine_convert_to_llm() -> pa_agent::agent_loop::ConvertToLlmFn {
    std::sync::Arc::new(|messages: Vec<pa_agent::types::AgentMessage>| {
        Box::pin(async move { Ok(loop_convert_to_llm(messages)) })
    })
}

#[cfg(test)]
mod tests {
    use super::*;


    /// The buffered wire cross ([`cross_wire`]) is interchangeable with the
    /// `to_value`/`from_value` crossing it replaces, message for message,
    /// over every shape the context rebuilds produce: plain text users,
    /// block users (image and raw blocks, extra `rest` keys), assistants
    /// with thinking/tool-call blocks, usage, diagnostics and extra
    /// `rest` keys, and tool results. The wire JSON is the contract; the
    /// two crossings must agree on both the result and the failure cases.
    #[test]
    fn wire_cross_matches_value_crossing() {
        use pa_types::ai::{
            AssistantContentBlock, AssistantMessage, Message, TextContent, ThinkingContent,
            ToolCall, ToolResultMessage, Usage, UsageCost, UserContent, UserContentBlock,
            UserMessage,
        };
        use serde_json::Map;
        use pa_types::JsonMap;

        fn rest(pairs: &[(&str, serde_json::Value)]) -> JsonMap {
            pairs
                .iter()
                .map(|(key, value)| ((*key).to_string(), value.clone()))
                .collect()
        }

        let assistant = AssistantMessage {
            content: vec![
                AssistantContentBlock::Text(TextContent {
                    text: "answer".to_string(),
                    text_signature: Some("sig-v1".to_string()),
                    rest: rest(&[("extra", serde_json::json!({"nested": [1, 2, 3]}))]),
                }),
                AssistantContentBlock::Thinking(ThinkingContent {
                    thinking: "thinking hard".to_string(),
                    thinking_signature: None,
                    redacted: None,
                    rest: Map::default(),
                }),
                AssistantContentBlock::ToolCall(ToolCall {
                    id: "call-1".to_string(),
                    name: "echo".to_string(),
                    arguments: rest(&[
                        ("text", serde_json::json!("hi")),
                        ("flags", serde_json::json!([true, false])),
                    ]),
                    thought_signature: None,
                    rest: Map::default(),
                }),
            ],
            api: String::default(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage {
                input: 10,
                output: 2,
                cache_read: 0,
                cache_write: 0,
                total_tokens: 12,
                cost: UsageCost::default(),
            },
            stop_reason: pa_types::ai::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 20,
            rest: rest(&[("unknownAssistantKey", serde_json::json!("kept on the wire"))]),
        };

        let messages: Vec<Message> = vec![
            Message::User(UserMessage {
                content: UserContent::Text("plain".to_string()),
                timestamp: 1,
                rest: Map::default(),
            }),
            Message::User(UserMessage {
                content: UserContent::Blocks(vec![
                    UserContentBlock::Text(TextContent {
                        text: "block".to_string(),
                        text_signature: None,
                        rest: Map::default(),
                    }),
                    UserContentBlock::Image(pa_types::ai::ImageContent {
                        data: "aGk=".to_string(),
                        mime_type: "image/png".to_string(),
                        rest: Map::default(),
                    }),
                    UserContentBlock::Raw(serde_json::json!({"type": "mystery"})),
                ]),
                timestamp: 2,
                rest: rest(&[("unknownUserKey", serde_json::json!(42))]),
            }),
            Message::Assistant(assistant),
            Message::ToolResult(ToolResultMessage {
                tool_call_id: "call-1".to_string(),
                tool_name: "echo".to_string(),
                content: vec![UserContentBlock::Text(TextContent {
                    text: "result".to_string(),
                    text_signature: None,
                    rest: Map::default(),
                })],
                details: None,
                is_error: false,
                timestamp: 3,
                rest: rest(&[("unknownToolKey", serde_json::json!(null))]),
            }),
        ];

        for message in &messages {
            let value_crossing: Option<pa_agent::types::AgentMessage> =
                serde_json::from_value(serde_json::to_value(message).unwrap()).ok();
            let wire_crossing: Option<pa_agent::types::AgentMessage> = cross_wire(message);
            assert_eq!(value_crossing.is_some(), wire_crossing.is_some());
            assert_eq!(value_crossing, wire_crossing);
        }
    }


    /// Degenerate wire input, kept exactly like the old crossing: a
    /// flattened `rest` key colliding with a typed field (one per
    /// message shape) serializes the wire key twice — the buffered byte
    /// parse rejects the duplicate, the fallback `Value` round-trip
    /// collapses it last-wins exactly like the pre-buffering path. The
    /// message must survive with the old result, never drop and never
    /// re-resolve as a `Custom` row (the untagged variant the byte
    /// parse could otherwise land in).
    #[test]
    fn wire_cross_keeps_colliding_rest_keys_like_the_value_crossing() {
        use pa_types::ai::{
            AssistantMessage, Message, TextContent, ToolResultMessage, Usage, UsageCost,
            UserContent, UserContentBlock, UserMessage,
        };
        use serde_json::Map;
        use pa_types::JsonMap;

        fn rest(value: serde_json::Value) -> JsonMap {
            match value {
                serde_json::Value::Object(map) => map,
                other => {
                    let mut map = serde_json::Map::new();
                    map.insert("rest".to_string(), other);
                    map
                }
            }
        }

        fn old_path(value: &Message) -> Option<pa_agent::types::AgentMessage> {
            serde_json::from_value::<pa_agent::types::AgentMessage>(
                serde_json::to_value(value).unwrap(),
            )
            .ok()
        }

        let user = Message::User(UserMessage {
            content: UserContent::Text("kept".to_string()),
            timestamp: 1,
            rest: rest(serde_json::json!({"timestamp": 2})),
        });
        let assistant = Message::Assistant(AssistantMessage {
            content: vec![pa_types::ai::AssistantContentBlock::Text(TextContent {
                text: "kept".to_string(),
                text_signature: None,
                rest: Map::default(),
            })],
            api: String::default(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::default(),
            stop_reason: pa_types::ai::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 3,
            rest: rest(serde_json::json!({"model": "colliding"})),
        });
        let tool_result = Message::ToolResult(ToolResultMessage {
            tool_call_id: "call-1".to_string(),
            tool_name: "echo".to_string(),
            content: vec![UserContentBlock::Text(TextContent {
                text: "kept".to_string(),
                text_signature: None,
                rest: Map::default(),
            })],
            details: None,
            is_error: false,
            timestamp: 4,
            rest: rest(serde_json::json!({"isError": true})),
        });

        for message in [&user, &assistant, &tool_result] {
            let old = old_path(message);
            let buffered = cross_wire_loop_message(message);
            assert!(old.is_some(), "the old crossing kept the message");
            assert_eq!(old, buffered, "the buffered crossing must match the old");
        }
        // The collapsed value won: the user row crossed with the LAST
        // timestamp, never dropped.
        let crossed_user = cross_wire_loop_message(&user).unwrap();
        match crossed_user {
            pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::User(user)) => {
                assert_eq!(user.timestamp, 2);
            }
            other => panic!("expected standard user, got {other:?}"),
        }
    }

    /// Non-ASCII and malformed-wire content through the buffered cross:
    /// multi-byte text survives byte-identically, and an unmodeled raw
    /// block (the wire form this version does not model) keeps the old
    /// crossing's result — crossed as the standard shape when the target
    /// models it, never dropped.
    #[test]
    fn wire_cross_carries_non_ascii_and_raw_blocks_like_the_value_crossing() {
        use pa_types::ai::{Message, TextContent, UserContent, UserContentBlock, UserMessage};
        use pa_types::JsonMap;

        let text = "по-русски ✨ マルチバイト \u{00e9}\u{00e8} emoji 🚀";
        let user = Message::User(UserMessage {
            content: UserContent::Blocks(vec![
                UserContentBlock::Text(TextContent {
                    text: text.to_string(),
                    text_signature: None,
                    rest: Map::default(),
                }),
                UserContentBlock::Raw(serde_json::json!({"type": "mystery", "keep": [1]})),
            ]),
            timestamp: 1,
            rest: JsonMap::new(),
        });
        let old: Option<pa_agent::types::AgentMessage> =
            serde_json::from_value(serde_json::to_value(&user).unwrap()).ok();
        let buffered = cross_wire_loop_message(&user);
        assert_eq!(old.is_some(), buffered.is_some());
        assert_eq!(old, buffered);
    }
    /// The live-context crossing after #2810: the rebuilds hand session
    /// rows (user, assistant, tool result, and the session-only roles
    /// that ride the loop as loop `Custom` rows — custom, branch
    /// summary, compaction summary, bash execution) to the agent loop.
    /// The buffered crossing must match the `to_value`/`from_value`
    /// crossing row for row, roles included.
    #[test]
    fn wire_cross_matches_value_crossing_for_session_rows() {
        use pa_types::session::AgentMessage as SessionMessage;

        let session_rows = vec![
            SessionMessage::User(pa_types::ai::UserMessage {
                content: pa_types::ai::UserContent::Text("plain".to_string()),
                timestamp: 1,
                rest: Map::default(),
            }),
            SessionMessage::Custom(pa_types::session::CustomMessage {
                custom_type: "note".to_string(),
                content: pa_types::ai::UserContent::Text("a note".to_string()),
                display: true,
                details: None,
                timestamp: 2,
                rest: Map::default(),
            }),
            SessionMessage::BranchSummary(pa_types::session::BranchSummaryMessage {
                summary: "branch story".to_string(),
                from_id: "u0".to_string(),
                timestamp: 3,
            }),
            SessionMessage::CompactionSummary(pa_types::session::CompactionSummaryMessage {
                summary: "compacted story".to_string(),
                tokens_before: 999,
                retained_message_count: Some(3),
                custom_instructions: None,
                harness_digest: None,
                timestamp: 4,
            }),
            SessionMessage::BashExecution(pa_types::session::BashExecutionMessage {
                command: "echo hi".to_string(),
                output: "hi".to_string(),
                exit_code: Some(0),
                cancelled: false,
                truncated: false,
                full_output_path: None,
                timestamp: 5,
                exclude_from_context: None,
            }),
        ];

        for row in &session_rows {
            let value_crossing: Option<pa_agent::types::AgentMessage> =
                serde_json::from_value(serde_json::to_value(row).unwrap()).ok();
            let wire_crossing: Option<pa_agent::types::AgentMessage> = cross_wire(row);
            assert_eq!(value_crossing.is_some(), wire_crossing.is_some());
            assert_eq!(value_crossing, wire_crossing);
        }
    }
    /// The retry-outcome row (SANCTIONED DIVERGENCE, operator ruling
    /// 2026-09-23): one durable line per episode — the recovered and
    /// exhausted texts, the structured details — and never model context.
    #[test]
    fn provider_retry_outcome_row_is_the_one_line_and_never_context() {
        let recovered =
            create_provider_retry_outcome_message(true, 3, "429 Too many concurrent requests");
        assert_eq!(recovered.custom_type, PROVIDER_RETRY_OUTCOME_CUSTOM_TYPE);
        assert_eq!(
            recovered.content,
            UserContent::Text(
                "Recovered after 3 retries: 429 Too many concurrent requests".to_string()
            )
        );
        assert!(recovered.display);
        assert_eq!(
            recovered.details,
            Some(serde_json::json!({
                "success": true,
                "attempts": 3,
                "finalError": "429 Too many concurrent requests",
            }))
        );
        let exhausted = create_provider_retry_outcome_message(false, 2, "provider down");
        assert_eq!(
            exhausted.content,
            UserContent::Text(
                "\u{26a0} Error: Retry failed after 2 attempts: provider down".to_string()
            )
        );
        // The disclosure never enters the model context.
        let converted = convert_to_llm(&[AgentMessage::Custom(recovered)]);
        assert!(
            converted.is_empty(),
            "outcome row must not convert to LLM context"
        );
    }

    #[test]
    fn bash_output_fences_and_status() {
        let rendered = bash_output_to_text(
            "has `ticks` inside",
            Some(1),
            false,
            true,
            Some("/tmp/full.txt"),
        );
        assert!(rendered.contains("```\nhas `ticks` inside\n```")); // default fence
        assert!(rendered.contains("Command exited with code 1"));
        assert!(rendered.contains("[Output truncated. Full output: /tmp/full.txt]"));
        assert!(bash_output_to_text("", None, false, false, None).contains("(no output)"));
        let cancelled = bash_output_to_text("x", None, true, false, None);
        assert!(cancelled.contains("(command cancelled)"));
        // A 3-backtick run in the output forces a 4-backtick fence.
        let fenced = bash_output_to_text("a ``` b", None, false, false, None);
        assert!(fenced.contains("````\na ``` b\n````"));
    }

    #[test]
    fn conversion_wraps_summaries_and_drops_bookkeeping() {
        let messages = vec![
            AgentMessage::User(UserMessage {
                content: UserContent::Text("keep me".to_string()),
                timestamp: 0,
                rest: serde_json::Map::default(),
            }),
            AgentMessage::Custom(pa_types::session::CustomMessage {
                custom_type: SESSION_SLASH_COMMAND_CUSTOM_TYPE.to_string(),
                content: UserContent::Text("/model".to_string()),
                display: true,
                details: None,
                timestamp: 0,
                rest: serde_json::Map::default(),
            }),
            AgentMessage::Custom(pa_types::session::CustomMessage {
                custom_type: "extension_note".to_string(),
                content: UserContent::Text("a note".to_string()),
                display: true,
                details: None,
                timestamp: 0,
                rest: serde_json::Map::default(),
            }),
            AgentMessage::BranchSummary(pa_types::session::BranchSummaryMessage {
                summary: "the branch".to_string(),
                from_id: "x".to_string(),
                timestamp: 0,
            }),
            AgentMessage::CompactionSummary(pa_types::session::CompactionSummaryMessage {
                summary: "the story".to_string(),
                tokens_before: 1,
                retained_message_count: None,
                custom_instructions: None,
                harness_digest: Some("digest".to_string()),
                timestamp: 0,
            }),
        ];
        let converted = convert_to_llm(&messages);
        // Bookkeeping custom dropped; other custom becomes user.
        assert_eq!(converted.len(), 4);
        assert!(matches!(converted[0], AgentMessage::User(_)));
        let note = match &converted[1] {
            AgentMessage::User(user) => user.content.text(),
            _ => panic!("expected user"),
        };
        assert_eq!(note, "a note");
        let branch = match &converted[2] {
            AgentMessage::User(user) => user.content.text(),
            _ => panic!("expected user"),
        };
        assert!(branch.contains("[branch-summary]"));
        assert!(branch.contains("the branch"));
        let compaction = match &converted[3] {
            AgentMessage::User(user) => user.content.text(),
            _ => panic!("expected user"),
        };
        assert!(compaction.contains("[harness-digest]"));
        assert!(compaction.contains("<harness_state>\ndigest\n</harness_state>"));
        assert!(compaction.contains("[compaction-summary]"));
        assert!(compaction.contains("the story"));
    }

    #[test]
    fn loop_conversion_applies_session_rules_to_custom_rows() {
        let digest_row: pa_agent::types::AgentMessage = serde_json::from_value(serde_json::json!({
            "role": "custom",
            "customType": "harness_digest",
            "content": "[harness-digest]

<harness_state>
state
</harness_state>",
            "display": false,
            "details": { "digest": "state" },
            "timestamp": 5
        }))
        .unwrap();
        let outcome_row: pa_agent::types::AgentMessage =
            serde_json::from_value(serde_json::json!({
                "role": "custom",
                "customType": "compaction_outcome",
                "content": "compacted",
                "display": true,
                "details": { "reason": "threshold", "outcome": "failed" },
                "timestamp": 6
            }))
            .unwrap();
        let unknown_row: pa_agent::types::AgentMessage =
            serde_json::from_value(serde_json::json!({ "role": "extension", "payload": "x" }))
                .unwrap();
        let user = pa_agent::types::AgentMessage::user("keep");
        let converted = loop_convert_to_llm(vec![digest_row, user, outcome_row, unknown_row]);
        // The digest row converts to a user turn; bookkeeping custom rows
        // and unknown roles drop; standard rows pass through.
        assert_eq!(converted.len(), 2);
        match &converted[0] {
            pa_agent::types::Message::User(user) => {
                // The digest row converts to a text-part array (TS wraps
                // string custom content), not a bare string.
                assert!(
                    matches!(&user.content, pa_agent::types::UserContent::Parts(parts)
                        if parts.iter().any(|part| matches!(part,
                            pa_agent::types::UserPart::Text(text)
                                if text.text.contains("[harness-digest]"))))
                );
                assert_eq!(user.timestamp, 5);
            }
            _ => panic!("expected user message"),
        }
        match &converted[1] {
            pa_agent::types::Message::User(user) => {
                assert!(
                    matches!(&user.content, pa_agent::types::UserContent::Text(text)
                        if text == "keep")
                );
            }
            _ => panic!("expected user message"),
        }
    }

    #[test]
    fn heartbeat_prompt_message_matches_the_ts_shape() {
        let job = AgentCronJob {
            id: "job-1".to_string(),
            status: crate::cron::JobStatus::Active,
            source: Some("rlm_heartbeat".to_string()),
            runtime_kind: None,
            delivery_mode: Some(crate::cron::DeliveryMode::Steer),
            active_session_id: "live-1".to_string(),
            session_id: "session-1".to_string(),
            session_file: "/w/session.jsonl".to_string(),
            cwd: "/w".to_string(),
            label: Some("mission".to_string()),
            prompt: "check the mission".to_string(),
            schedule: crate::cron::AgentCronSchedule {
                kind: crate::cron::ScheduleKind::Interval,
                expression: "every 10m".to_string(),
                interval_ms: Some(600_000),
            },
            created_at: "2026-09-22T00:00:00.000Z".to_string(),
            updated_at: "2026-09-22T00:00:00.000Z".to_string(),
            next_run_at: Some("2026-09-22T00:10:00.000Z".to_string()),
            last_run_at: None,
            last_skipped_at: None,
            last_error: None,
            run_count: 0,
        };
        let message = create_heartbeat_prompt_message(&job, 1_000);
        assert_eq!(message.custom_type, "heartbeat_prompt");
        assert!(message.display);
        assert_eq!(message.timestamp, 1_000);
        // The header sanitizes its schedule value; the prompt rides as
        // the body (TS `createHeartbeatPromptMessage`).
        assert_eq!(
            message.content,
            UserContent::Text("[heartbeat: every 10m run#0]\n\ncheck the mission".to_string())
        );
        let details = message.details.unwrap();
        assert_eq!(details["jobId"], "job-1");
        assert_eq!(details["schedule"], "every 10m");
        assert_eq!(details["status"], "active");
        assert_eq!(details["runCount"], 0);
        assert_eq!(details["nextRunAt"], "2026-09-22T00:10:00.000Z");
        // An undefined lastRunAt is omitted, not null (TS JSON.stringify
        // drops undefined fields; a first fire carries no lastRunAt).
        assert!(details.get("lastRunAt").is_none());
        // A schedule with header delimiters collapses to spaces.
        let delimited = crate::cron::AgentCronJob {
            schedule: crate::cron::AgentCronSchedule {
                kind: crate::cron::ScheduleKind::Cron,
                expression: "0 0,12:every[day]".to_string(),
                interval_ms: None,
            },
            ..job.clone()
        };
        let message = create_heartbeat_prompt_message(&delimited, 2_000);
        assert!(matches!(message.content, UserContent::Text(text)
                if text.starts_with("[heartbeat: 0 0 12 every day run#0]")));
        // A repeat fire carries the previous run's lastRunAt.
        let repeat = crate::cron::AgentCronJob {
            last_run_at: Some("2026-09-22T00:10:00.000Z".to_string()),
            run_count: 1,
            ..job
        };
        let message = create_heartbeat_prompt_message(&repeat, 2_000);
        assert!(matches!(message.content, UserContent::Text(text)
                if text.starts_with("[heartbeat: every 10m run#1]")));
        let details = message.details.unwrap();
        assert_eq!(details["runCount"], 1);
        assert_eq!(details["lastRunAt"], "2026-09-22T00:10:00.000Z");
    }

    #[test]
    fn async_bash_completion_message_matches_the_ts_shape() {
        // TS `createAsyncBashCompletionMessage`: the custom type, the
        // `[bash-done pid:N exit:M]` header with the JSON-encoded
        // command, display, and the `{pid, command, exitCode}` details.
        let message =
            create_async_bash_completion_message(4321, "sleep 12; echo RW_WAKE_DONE", 0, 1_000);
        assert_eq!(message.custom_type, "async_bash_completion");
        assert!(message.display);
        assert_eq!(message.timestamp, 1_000);
        assert_eq!(
            message.content,
            UserContent::Text(
                "[bash-done pid:4321 exit:0]\n\nCommand: \"sleep 12; echo RW_WAKE_DONE\""
                    .to_string()
            )
        );
        let details = message.details.unwrap();
        assert_eq!(details["pid"], 4321);
        assert_eq!(details["command"], "sleep 12; echo RW_WAKE_DONE");
        assert_eq!(details["exitCode"], 0);
        // A nonzero exit and embedded quotes round the same shape.
        let message = create_async_bash_completion_message(11, "echo \"done\" && exit 2", 2, 2_000);
        assert_eq!(message.timestamp, 2_000);
        assert!(matches!(message.content, UserContent::Text(text)
            if text.starts_with("[bash-done pid:11 exit:2]\n\nCommand: \"echo \\\"done\\\" && exit 2\"")));
        let details = message.details.unwrap();
        assert_eq!(details["exitCode"], 2);
    }

    #[test]
    fn bash_execution_becomes_user_text() {
        let bash = AgentMessage::BashExecution(pa_types::session::BashExecutionMessage {
            command: "cargo test".to_string(),
            output: "ok".to_string(),
            exit_code: Some(0),
            cancelled: false,
            truncated: false,
            full_output_path: None,
            timestamp: 0,
            exclude_from_context: None,
        });
        let converted = convert_to_llm(std::slice::from_ref(&bash));
        match &converted[0] {
            AgentMessage::User(user) => {
                assert!(user.content.text().starts_with("Ran `cargo test`"));
                assert!(user.content.text().contains("```"));
            }
            _ => panic!("expected user"),
        }
        // Excluded executions drop out entirely.
        let excluded = AgentMessage::BashExecution(pa_types::session::BashExecutionMessage {
            exclude_from_context: Some(true),
            command: "secret".to_string(),
            output: String::new(),
            exit_code: None,
            cancelled: false,
            truncated: false,
            full_output_path: None,
            timestamp: 0,
        });
        assert!(convert_to_llm(std::slice::from_ref(&excluded)).is_empty());
    }
}
