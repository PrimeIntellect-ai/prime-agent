//! The live-event decoder: the `TurnUpdate` vocabulary (session-event
//! wire shapes) and the `event_to_update` fold.
use super::{
    assistant_value_to_entries, queue_lane, queue_lane_indices, starting_from_actions, ChatEntry,
    Value,
};

/// One live session event decoded for the transcript (the `event` field of
/// `session_event` frames, matching the worker's event vocabulary).
#[derive(Debug, Clone, PartialEq)]
pub enum TurnUpdate {
    /// `agent_start` / `turn_start`.
    TurnStarted,
    /// `session_info_changed`: the session display name (cleared when
    /// the event carries none).
    SessionInfoChanged { name: Option<String> },
    /// `service_tier_changed`: the session's effective service tier.
    ServiceTierChanged { tier: String },
    /// `message_start` with a user message.
    UserMessage(String),
    /// An assistant message; `streaming` distinguishes in-flight from
    /// final.
    AssistantMessage {
        message: Value,
        streaming: bool,
        stream_event: Option<Value>,
    },
    /// `tool_execution_start`: a tool call began executing.
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        args: Value,
    },
    /// `tool_execution_update`: a partial tool result.
    ToolExecutionUpdate {
        tool_call_id: String,
        partial: Value,
    },
    /// `tool_execution_end`: the final tool result.
    ToolExecutionEnd {
        tool_call_id: String,
        result: Value,
        is_error: bool,
    },
    /// `turn_end`, with the turn error string when the turn failed.
    TurnEnded { error: Option<String> },
    /// A `custom`-role message the transcript renders (session-command
    /// echo/result rows, or the malformed-notice fallback).
    CustomRow(ChatEntry),
    /// `auto_retry_start`: a provider failure is being retried after
    /// `delay_ms`.
    AutoRetryStart {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        error_message: String,
        reason: RetryStartReason,
    },
    /// `auto_retry_end`: the retry loop settled; `final_error` when
    /// retries were exhausted; `restored_model` after a successful
    /// failover.
    AutoRetryEnd {
        success: bool,
        attempt: u32,
        final_error: Option<String>,
        restored_model: Option<String>,
    },
    /// `agent_end`: the prompt queue drained.
    Idle,
    /// `compaction_start`: a compaction run began.
    CompactionStart {
        /// Why the compaction runs (`manual`/`requested`/`overflow`/`threshold`).
        reason: String,
        /// `/compact <instructions>` focus guidance.
        custom_instructions: Option<String>,
    },
    /// `compaction_summary_delta`: one streamed summary chunk (the
    /// operator's "stream the compacted summary" feature); the settling
    /// `compaction_end` clears the streamed block.
    CompactionSummaryDelta {
        /// The delta text (one summarizer text delta, verbatim).
        delta: String,
    },
    /// `compaction_end`: success carries the result; skip/failure
    /// carries the error message and its severity.
    CompactionEnd {
        reason: String,
        /// The TS `CompactionResult` on success.
        result: Option<Value>,
        /// `/compact <instructions>` focus guidance.
        custom_instructions: Option<String>,
        aborted: bool,
        error_message: Option<String>,
        /// `warning` or `error`.
        error_severity: Option<String>,
    },
    /// `goal_update`: the raw wire `goal` payload (the session view
    /// owns rendering).
    GoalUpdate(Value),
    /// `session_action_update`: the queue projection changed. `starting`
    /// carries the picked-up prompt still preparing (TS #2063); the
    /// `rlm_child_status`/`injected_prompts` riders are Rust-native
    /// provenance, so the strip folds exactly those rows.
    QueueUpdated {
        steering: Vec<String>,
        follow_ups: Vec<String>,
        starting: Option<String>,
        rlm_child_status: crate::queued::QueueLaneIndices,
        injected_prompts: crate::queued::QueueLaneIndices,
    },
    /// `bash_start` (the user-bash slot): a command run outside the model
    /// loop; `transient` marks a side-conversation run rendering only
    /// in the owning client's pane.
    BashStart {
        command: String,
        exclude_from_context: bool,
        transient: bool,
        run_id: Option<String>,
    },
    /// `bash_output` (the user-bash slot): one streamed output chunk.
    BashOutput { chunk: String },
    /// `bash_end` (the user-bash slot): the settled run.
    BashEnd {
        exit_code: Option<i64>,
        cancelled: bool,
        truncated: bool,
        full_output_path: Option<String>,
        error_message: Option<String>,
        transient: bool,
        run_id: Option<String>,
    },
    /// Other state churn: the footer status only.
    StatusUpdate,
}

/// Why one `auto_retry_start` fired (the TS wire `reason` field).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetryStartReason {
    /// Ordinary quick retry on the current provider.
    Quick,
    /// Provider-failover switch: the failed turn re-routes to
    /// `backup_model` ("provider/model-id").
    Backup { backup_model: String },
}

/// Decode the `event` payload of a `session_event` frame.
pub fn event_to_update(event: &Value) -> Option<TurnUpdate> {
    match event.get("type").and_then(Value::as_str)? {
        "compaction_start" => Some(TurnUpdate::CompactionStart {
            reason: event
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("manual")
                .to_string(),
            custom_instructions: event
                .get("customInstructions")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        "compaction_summary_delta" => Some(TurnUpdate::CompactionSummaryDelta {
            delta: event
                .get("delta")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }),
        "compaction_end" => Some(TurnUpdate::CompactionEnd {
            reason: event
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("manual")
                .to_string(),
            result: event
                .get("result")
                .cloned()
                .filter(|value| !value.is_null()),
            custom_instructions: event
                .get("customInstructions")
                .and_then(Value::as_str)
                .map(str::to_string),
            aborted: event
                .get("aborted")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            error_message: event
                .get("errorMessage")
                .and_then(Value::as_str)
                .map(str::to_string),
            error_severity: event
                .get("errorSeverity")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        "agent_start" | "turn_start" => Some(TurnUpdate::TurnStarted),
        // Every attached client re-reads the session display name.
        "session_info_changed" => Some(TurnUpdate::SessionInfoChanged {
            name: event
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        // The client patches its connection state (the `/fast` status
        // reads the tier from it).
        "service_tier_changed" => Some(TurnUpdate::ServiceTierChanged {
            tier: event
                .get("serviceTier")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }),
        "turn_end" => Some(TurnUpdate::TurnEnded {
            error: event
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        "agent_end" => Some(TurnUpdate::Idle),
        "message_start" | "message_update" | "message_end" => {
            let message = event.get("message")?.clone();
            let event_type = event.get("type").and_then(Value::as_str);
            let streaming = event_type != Some("message_end");
            match message.get("role").and_then(Value::as_str) {
                // The message_end twin must not re-render the full
                // user payload (TS interactive ignores user
                // message_end frames).
                Some("user")
                    if event_type == Some("message_update")
                        || event_type == Some("message_end") =>
                {
                    Some(TurnUpdate::StatusUpdate)
                }
                Some("user") => Some(match user_display_text(&message) {
                    Some(text) => TurnUpdate::UserMessage(text),
                    // Nothing to show: no blank row.
                    None => TurnUpdate::StatusUpdate,
                }),
                Some("assistant") => Some(TurnUpdate::AssistantMessage {
                    message,
                    streaming,
                    stream_event: event.get("assistantMessageEvent").cloned(),
                }),
                // Custom rows arrive as a message_start + message_end pair
                // carrying the same payload; only the start adds the row.
                Some("custom") if event_type == Some("message_start") => {
                    custom_row_update(&message)
                }
                _ => Some(TurnUpdate::StatusUpdate),
            }
        }
        "tool_execution_start" => Some(TurnUpdate::ToolExecutionStart {
            tool_call_id: event
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            tool_name: event
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            args: event.get("args").cloned().unwrap_or(Value::Null),
        }),
        "tool_execution_update" => Some(TurnUpdate::ToolExecutionUpdate {
            tool_call_id: event
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            partial: event.get("partialResult").cloned().unwrap_or(Value::Null),
        }),
        "tool_execution_end" => Some(TurnUpdate::ToolExecutionEnd {
            tool_call_id: event
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            result: event.get("result").cloned().unwrap_or(Value::Null),
            is_error: event
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        "auto_retry_start" => Some(TurnUpdate::AutoRetryStart {
            attempt: event
                .get("attempt")
                .and_then(Value::as_u64)
                .unwrap_or_default() as u32,
            max_attempts: event
                .get("maxAttempts")
                .and_then(Value::as_u64)
                .unwrap_or_default() as u32,
            delay_ms: event
                .get("delayMs")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            error_message: event
                .get("errorMessage")
                .and_then(Value::as_str)
                .unwrap_or("Unknown error")
                .to_string(),
            reason: match event.get("reason").and_then(Value::as_str) {
                Some("backup") => RetryStartReason::Backup {
                    backup_model: event
                        .get("backupModel")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                },
                _ => RetryStartReason::Quick,
            },
        }),
        "auto_retry_end" => Some(TurnUpdate::AutoRetryEnd {
            success: event
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            attempt: event
                .get("attempt")
                .and_then(Value::as_u64)
                .unwrap_or_default() as u32,
            final_error: event
                .get("finalError")
                .and_then(Value::as_str)
                .map(str::to_string),
            restored_model: event
                .get("restoredModel")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        "goal_update" => Some(TurnUpdate::GoalUpdate(
            event.get("goal").cloned().unwrap_or(Value::Null),
        )),
        "session_action_update" => {
            let actions = event.get("actions").cloned().unwrap_or(Value::Null);
            Some(TurnUpdate::QueueUpdated {
                steering: queue_lane(&actions, "steering"),
                follow_ups: queue_lane(&actions, "followUps"),
                starting: starting_from_actions(&actions),
                rlm_child_status: queue_lane_indices(&actions, "rlmChildStatus"),
                injected_prompts: queue_lane_indices(&actions, "injectedPrompts"),
            })
        }
        // The identity fields ride the same frame.
        "bash_start" => Some(TurnUpdate::BashStart {
            command: event
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            exclude_from_context: event
                .get("excludeFromContext")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            transient: event
                .get("transient")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            run_id: event
                .get("runId")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        "bash_output" => Some(TurnUpdate::BashOutput {
            chunk: event
                .get("chunk")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }),
        "bash_end" => Some(TurnUpdate::BashEnd {
            exit_code: event.get("exitCode").and_then(Value::as_i64),
            cancelled: event
                .get("cancelled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            truncated: event
                .get("truncated")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            full_output_path: event
                .get("fullOutputPath")
                .and_then(Value::as_str)
                .map(str::to_string),
            error_message: event
                .get("errorMessage")
                .and_then(Value::as_str)
                .map(str::to_string),
            transient: event
                .get("transient")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            run_id: event
                .get("runId")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),

        // Queue churn and unknown events only affect the status line.
        _ => Some(TurnUpdate::StatusUpdate),
    }
}

/// The loader note from a `tool_execution_update` partial result, if any:
/// the python-kernel bootstrap reports startup stages with
/// `details.status = "starting"`. `None` leaves the current note
/// untouched (streamed `ok` is not a note change).
pub fn working_message_from_update(partial: &Value) -> Option<String> {
    let status = partial
        .get("details")
        .and_then(|details| details.get("status"))
        .and_then(Value::as_str);
    if status != Some("starting") {
        return None;
    }
    partial
        .get("content")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|block| {
            (block.get("type") == Some(&Value::String("text".to_string())))
                .then(|| block.get("text"))
                .flatten()
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|text| !text.is_empty())
}

/// Decode one `custom`-role message into its transcript update: the
/// session-command echo/result rows render; an invalid payload renders
/// the malformed notice; everything else renders nothing.
fn custom_row_update(message: &Value) -> Option<TurnUpdate> {
    let entries = custom_message_entries(message);
    match entries.first() {
        Some(entry) => Some(TurnUpdate::CustomRow(entry.clone())),
        None => Some(TurnUpdate::StatusUpdate),
    }
}

/// The transcript entries for one `custom`-role message (the dispatch
/// lives in [`crate::custom_message::custom_message_entries`]).
#[must_use]
pub fn custom_message_entries(message: &Value) -> Vec<ChatEntry> {
    crate::custom_message::custom_message_entries(message)
}

/// The user-message display text: the text blocks joined, the `[image]`
/// placeholder for image-only content, or `None` for nothing to show.
#[must_use]
pub fn user_display_text(message: &Value) -> Option<String> {
    let text = message_text(message);
    if !text.is_empty() {
        return Some(text);
    }
    match message.get("content") {
        Some(Value::String(content)) if !content.is_empty() => Some("[image]".to_string()),
        Some(Value::Array(blocks)) if !blocks.is_empty() => Some("[image]".to_string()),
        _ => None,
    }
}

/// Concatenated text of a raw daemon message (string or block content).
pub fn message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks.iter().filter_map(block_text).collect::<String>(),
        _ => String::new(),
    }
}

/// Text of one content block: tagged text blocks and the engine's
/// untagged `{"text": ...}` form; fragments concatenate without separators.
fn block_text(block: &Value) -> Option<String> {
    match block {
        Value::Object(_) => block
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string),
        Value::String(text) => Some(text.clone()),
        _ => None,
    }
}

/// Fold one raw message into chat entries; assistant messages expand
/// into blocks plus one card per tool call, in content order.
pub fn message_value_to_entries(message: &Value) -> Vec<ChatEntry> {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match role {
        // A skill-block text renders the skill-invocation card (+ the
        // trailing argument text); every other text renders the user block.
        "user" => user_display_text(message)
            .map(|text| {
                crate::custom_message::skill_invocation_entries(&text)
                    .unwrap_or_else(|| vec![ChatEntry::User { text }])
            })
            .unwrap_or_default(),
        "assistant" => assistant_value_to_entries(message),
        "custom" => custom_message_entries(message),
        "compactionSummary" => compaction_summary_entries(message),
        // Other roles (tool results, bookkeeping) have no rendering here:
        // live tool results arrive as tool_execution events instead.
        _ => Vec::new(),
    }
}

/// The compaction summary row from its wire message.
fn compaction_summary_entries(message: &Value) -> Vec<ChatEntry> {
    let summary = message
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    vec![ChatEntry::CompactionSummary {
        summary,
        tokens_before: message
            .get("tokensBefore")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        custom_instructions: message
            .get("customInstructions")
            .and_then(Value::as_str)
            .map(str::to_string),
    }]
}
