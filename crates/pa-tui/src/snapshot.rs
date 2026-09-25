//! Attach/snapshot reconstruction: wire data from the daemon (slim attach
//! results, streamed session events) folded into UI transcript items.
//!
//! Daemon message payloads are raw JSON (`Value`): the session engine owns
//! their evolution, and the TUI renders what arrives. Message decoding is
//! therefore lenient — it accepts plain-string content and content-block
//! arrays, with or without explicit block `type` tags, covering the shapes
//! the scripted harness and the real engine both emit.

use crate::chat::{AssistantMessage, ChatEntry, MessageBlock, ToolCallCard, ToolResultView};
use pa_types::daemon::{DaemonEventCursor, DaemonReplayInfo};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

/// The slim attach result: the `data` object of a successful `attach`
/// response (`createAttachResult` wire shape).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachData {
    pub active_session_id: String,
    /// Slim attach carries summary/state/messages inside the snapshot.
    pub snapshot: Value,
    #[serde(default)]
    pub replay: Option<DaemonReplayInfo>,
    #[serde(default)]
    pub last_event_sequence: Option<u64>,
    #[serde(default)]
    pub last_event_cursor: Option<DaemonEventCursor>,
    #[serde(default)]
    pub client: Option<AttachClient>,
}

/// Client block echoed back by attach.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachClient {
    pub id: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

/// A reconstructed attach: view-ready chat entries plus identity labels.
#[derive(Debug, Clone, Default)]
pub struct Reconstructed {
    pub chat: Vec<ChatEntry>,
    /// Current model id (`state.model.id`), when the session reports one.
    pub model_id: Option<String>,
    /// Session display name.
    pub session_name: Option<String>,
    /// Session id of the persisted session file.
    pub session_id: String,
    /// The session's goal state (`state.goal`), when the snapshot reports
    /// one (TS `snapshot.ts: goal: session.goalState`).
    pub goal: Option<pa_types::goal::GoalState>,
    pub last_event_sequence: u64,
    /// The queued input parked behind the run (`state.sessionActions`) so an
    /// attach re-syncs the queue strip (TS re-reads the queue after
    /// subscribe because a `session_action_update` in the gap is lost).
    pub queued: crate::queued::QueuedMessages,
    /// The session's effective service tier (`state.serviceTier`), the
    /// `/fast` toggle's baseline.
    pub service_tier: Option<String>,
}

impl Reconstructed {
    /// Fold one raw message into the chat entries. A `toolResult` message
    /// does not add a row WHEN it completes the pending tool card its
    /// `toolCallId` refers to (the TS transcript replay updates the
    /// pending tool component instead of rendering a new row); a result
    /// that matches no pending card keeps its standalone card exactly
    /// like the live `AgentView::push` path (the orphan never
    /// disappears from the rebuilt transcript).
    pub fn push_message(&mut self, message: &Value) {
        if let Some(result) = tool_result_message_view(message) {
            if let Some(view) = apply_tool_result(&mut self.chat, result) {
                self.chat
                    .push(ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
                        id: view.id,
                        name: view.name,
                        args: serde_json::Value::Null,
                        started: true,
                        ended_ms: (view.timestamp > 0).then_some(view.timestamp),
                        result: Some(view.view),
                        // An orphan keeps its own standalone row: it
                        // never joins a condensed run (it is not a
                        // call).
                        unmatched_result: true,
                        ..Default::default()
                    })));
            }
            return;
        }
        self.chat.extend(message_value_to_entries(message));
    }
}

/// A decoded `toolResult` transcript message: the id of the tool call it
/// completes plus the result view rendered on the matching card.
struct ToolResultReplay {
    tool_call_id: String,
    /// The wire `toolName` (the orphan card's own name when no pending
    /// card matches).
    tool_name: String,
    view: crate::chat::ToolResultView,
    /// The message's wire `timestamp` (Unix milliseconds; 0 when absent):
    /// reading an existing field for the condensed runs' wall-clock - no
    /// schema change.
    timestamp: u64,
}

/// Decode a `role: "toolResult"` message into its replay view; `None` for
/// any other message.
fn tool_result_message_view(message: &Value) -> Option<ToolResultReplay> {
    if message.get("role").and_then(Value::as_str) != Some("toolResult") {
        return None;
    }
    Some(ToolResultReplay {
        tool_call_id: message
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        tool_name: message
            .get("toolName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        view: crate::chat::ToolResultView {
            content: message
                .get("content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            details: message.get("details").cloned().unwrap_or(Value::Null),
            is_error: message
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        timestamp: message
            .get("timestamp")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    })
}

/// Complete the first pending tool card matching `result`'s tool call
/// id (the TS `renderedPendingTools` replay: results land on the card,
/// never as a new transcript row). A result that matches no pending
/// card comes back whole: the caller keeps its standalone orphan card
/// (the live `AgentView::push` path's twin).
fn apply_tool_result(chat: &mut [ChatEntry], result: ToolResultReplay) -> Option<OrphanResult> {
    let ToolResultReplay {
        tool_call_id,
        tool_name,
        view,
        timestamp,
    } = result;
    for entry in chat.iter_mut() {
        if let ChatEntry::Tool(card) = entry {
            if card.id == tool_call_id && card.result.is_none() {
                card.started = true;
                // Replayed cards never saw the live execution: the timing
                // collapses to the rebuild instant, so the bash `Took` row
                // renders the same `0.0s` the TS component does on replay.
                let now = std::time::Instant::now();
                card.started_at = Some(now);
                card.ended_at = Some(now);
                card.ended_ms = (timestamp > 0).then_some(timestamp);
                card.result = Some(view);
                card.result_partial = false;
                return None;
            }
        }
    }
    Some(OrphanResult {
        id: tool_call_id,
        name: tool_name,
        view,
        timestamp,
    })
}

/// An unmatched replay result: keeps its standalone card.
struct OrphanResult {
    id: String,
    name: String,
    view: crate::chat::ToolResultView,
    timestamp: u64,
}

/// Replay a whole transcript: map every message to its rows, then fold
/// `toolResult` messages onto the pending tool cards their ids refer to.
/// Card ids are unique, so one id-to-index map replaces the per-result
/// card scan (a replay-scale fold stays linear).
/// TS `orderMessagesForTranscript`: the wire context is summary-first for
/// the model, but the transcript presents the compaction summary at its
/// chronological boundary — after the retained messages
/// (`retainedMessageCount`), before anything appended after the
/// compaction. A missing count falls back to the timestamp split (TS
/// compatibility for pre-count summaries).
fn order_messages_for_transcript(messages: &[Value]) -> Vec<&Value> {
    let Some(summary_index) = messages.iter().position(|message| {
        message.get("role").and_then(Value::as_str) == Some("compactionSummary")
    }) else {
        return messages.iter().collect();
    };
    let summary = &messages[summary_index];
    let mut rest: Vec<&Value> = messages
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != summary_index)
        .map(|(_, message)| message)
        .collect();
    let boundary = if let Some(retained) =
        summary.get("retainedMessageCount").and_then(Value::as_u64)
    {
        (retained as usize).min(rest.len())
    } else {
        let summary_timestamp = summary.get("timestamp").and_then(Value::as_f64);
        let retained = rest
            .iter()
            .filter(|message| message.get("timestamp").and_then(Value::as_f64) < summary_timestamp)
            .count();
        retained.min(rest.len())
    };
    rest.insert(boundary, summary);
    rest
}

pub fn transcript_to_entries(messages: &[Value]) -> Vec<ChatEntry> {
    let ordered = order_messages_for_transcript(messages);
    let mut chat: Vec<ChatEntry> = Vec::new();
    let mut card_index: HashMap<String, Vec<usize>> = HashMap::new();
    for message in ordered {
        if let Some(result) = tool_result_message_view(message) {
            let tool_call_id = result.tool_call_id.clone();
            if let Some(result) = settle_last_pending(
                &mut chat,
                card_index.get(&tool_call_id).map(Vec::as_slice),
                result,
            ) {
                // No pending card took the result (a true orphan, or a
                // leftover settle): it keeps its standalone card AT ITS
                // OWN WIRE POSITION - exactly the live push path's
                // semantics (the result never crosses a later reused
                // invocation, and condensation never spans it).
                chat.push(orphan_card(result));
            }
            continue;
        }
        // The retry-episode collapse (SANCTIONED DIVERGENCE, operator
        // ruling 2026-09-23): a `provider_retry_outcome` row replaces the
        // failed attempts its episode superseded, so the rebuilt chat
        // shows ONE line per episode instead of the per-attempt error
        // rows TS renders. The superseded rows sit at the tail (attempts
        // are appended in order), and the collapse never touches tool
        // cards (their failures ride the cards, not error-only rows).
        if message.get("role").and_then(Value::as_str) == Some("custom")
            && message.get("customType").and_then(Value::as_str)
                == Some(crate::custom_message::PROVIDER_RETRY_OUTCOME_CUSTOM_TYPE)
        {
            while chat.last().is_some_and(is_superseded_attempt_row) {
                chat.pop();
            }
        }
        let first_new = chat.len();
        chat.extend(message_value_to_entries(message));
        for (offset, entry) in chat[first_new..].iter().enumerate() {
            if let ChatEntry::Tool(card) = entry {
                card_index
                    .entry(card.id.clone())
                    .or_default()
                    .push(first_new + offset);
            }
        }
    }
    chat
}

/// Settle one result onto the LAST pending card among `indices` (the
/// live `rposition` semantics). `Some(result)` hands the result back
/// whole for the caller's deferral or orphan handling; `None` settled
/// it.
fn settle_last_pending(
    chat: &mut [ChatEntry],
    indices: Option<&[usize]>,
    result: ToolResultReplay,
) -> Option<ToolResultReplay> {
    let Some(indices) = indices else {
        return Some(result);
    };
    let pending = indices.iter().rev().copied().find(
        |&index| matches!(chat.get(index), Some(ChatEntry::Tool(card)) if card.result.is_none()),
    );
    let Some(index) = pending else {
        return Some(result);
    };
    let ToolResultReplay {
        tool_call_id: _,
        tool_name: _,
        view,
        timestamp,
    } = result;
    if let Some(ChatEntry::Tool(card)) = chat.get_mut(index) {
        card.started = true;
        // Replayed cards never saw the live execution: the timing
        // collapses to the rebuild instant, so the bash `Took` row
        // renders the same `0.0s` the TS component does on replay.
        let now = std::time::Instant::now();
        card.started_at = Some(now);
        card.ended_at = Some(now);
        card.ended_ms = (timestamp > 0).then_some(timestamp);
        card.result = Some(view);
        card.result_partial = false;
    }
    None
}

/// The standalone card a true orphan result keeps (the live push
/// path's twin).
fn orphan_card(result: ToolResultReplay) -> ChatEntry {
    let ToolResultReplay {
        tool_call_id,
        tool_name,
        view,
        timestamp,
    } = result;
    ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
        id: tool_call_id,
        name: tool_name,
        args: serde_json::Value::Null,
        started: true,
        ended_ms: (timestamp > 0).then_some(timestamp),
        result: Some(view),
        unmatched_result: true,
        ..Default::default()
    }))
}

/// Reconstruct the view state from slim attach data.
pub fn reconstruct(attach: &AttachData) -> Reconstructed {
    let snapshot = &attach.snapshot;
    let messages = snapshot
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| transcript_to_entries(messages))
        .unwrap_or_default();
    let state = snapshot.get("state");
    let model_id = state
        .and_then(|state| state.get("model"))
        .and_then(model_id_value);
    let session_name = state
        .and_then(|state| state.get("sessionName"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let session_id = state
        .and_then(|state| state.get("sessionId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let last_event_sequence = snapshot
        .get("lastEventSequence")
        .and_then(Value::as_u64)
        .or(attach.last_event_sequence)
        .unwrap_or_default();
    let goal = state
        .and_then(|state| state.get("goal"))
        .and_then(|goal| serde_json::from_value::<pa_types::goal::GoalState>(goal.clone()).ok());
    let actions = state.and_then(|state| state.get("sessionActions")).cloned();
    let queued = crate::queued::QueuedMessages {
        steering: actions
            .as_ref()
            .map(|a| queue_lane(a, "steering"))
            .unwrap_or_default(),
        follow_ups: actions
            .as_ref()
            .map(|a| queue_lane(a, "followUps"))
            .unwrap_or_default(),
        starting: actions.as_ref().and_then(starting_from_actions),
        rlm_child_status: actions
            .as_ref()
            .map(queue_rlm_child_status)
            .unwrap_or_default(),
    };

    let service_tier = state
        .and_then(|state| state.get("serviceTier"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Reconstructed {
        chat: messages,
        model_id,
        session_name,
        session_id,
        goal,
        last_event_sequence,
        queued,
        service_tier,
    }
}

/// The preparing-turn label of a `sessionActions` wire value, or `None`
/// when no picked-up prompt is preparing (TS #2063
/// `connectionState.sessionActions.active`: the interactive strip renders
/// the "Starting" row exactly while the active action is a turn in its
/// `preparing` phase — the prompt left its lane at pickup, so the strip is
/// the only place it shows until the turn renders it).
fn starting_from_actions(actions: &Value) -> Option<String> {
    let active = actions.get("active")?;
    let is_preparing_turn = active.get("kind").and_then(Value::as_str) == Some("turn")
        && active.get("phase").and_then(Value::as_str) == Some("preparing");
    is_preparing_turn.then(|| {
        active
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    })
}

/// The RLM child status provenance rider of a `sessionActions` wire value
/// (`rlmChildStatus`: the parked child-status notices by lane index —
/// Rust-native typed provenance with no TS counterpart; the strip folds
/// exactly these rows). A projection without parked notices omits the
/// rider entirely.
fn queue_rlm_child_status(actions: &Value) -> crate::queued::RlmChildStatusIndices {
    let indices = |lane: &str| {
        actions
            .get("rlmChildStatus")
            .and_then(|rider| rider.get(lane))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_u64)
                    .map(|index| index as usize)
                    .collect::<Vec<usize>>()
            })
            .unwrap_or_default()
    };
    crate::queued::RlmChildStatusIndices {
        steering: indices("steering"),
        follow_up: indices("followUp"),
    }
}

/// One lane of a `sessionActions` wire value: the preview strings in order.
fn queue_lane(actions: &Value, key: &str) -> Vec<String> {
    actions
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// The model id from a `state.model` wire value (`{id, provider}` or a
/// display string).
fn model_id_value(model: &Value) -> Option<String> {
    match model {
        Value::String(label) => Some(label.clone()),
        Value::Object(map) => map.get("id").and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
}

/// Parse attach data out of a successful attach/create response payload.
///
/// # Errors
///
/// Returns `Err` when the payload does not decode into `AttachData`
/// (an unrecognizable daemon attach result).
pub fn attach_data_from_response(data: Value) -> anyhow::Result<AttachData> {
    serde_json::from_value(data).map_err(|error| {
        anyhow::anyhow!("the daemon returned an unrecognizable attach result: {error}")
    })
}

/// One live session event decoded for the transcript (the `event` field of
/// `session_event` frames, matching the worker's event vocabulary).
#[derive(Debug, Clone, PartialEq)]
pub enum TurnUpdate {
    /// `agent_start` / `turn_start`.
    TurnStarted,
    /// `session_info_changed`: the session display name (cleared when the
    /// event carries none).
    SessionInfoChanged { name: Option<String> },
    /// `service_tier_changed`: the session's effective service tier.
    ServiceTierChanged { tier: String },
    /// `message_start` with a user message.
    UserMessage(String),
    /// `message_start`/`message_update`/`message_end` with an assistant
    /// message (raw wire value); `streaming` distinguishes in-flight from
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
    /// `delay_ms` (TS retry loader countdown). A `Backup` reason is a
    /// provider-failover switch: the failed turn re-routes to
    /// `backup_model` ("provider/model-id") immediately.
    AutoRetryStart {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        error_message: String,
        reason: RetryStartReason,
    },
    /// `auto_retry_end`: the retry loop settled; `final_error` is set when
    /// the retries were exhausted; `restored_model` is the primary model
    /// restored after a failover switch succeeded.
    AutoRetryEnd {
        success: bool,
        attempt: u32,
        final_error: Option<String>,
        restored_model: Option<String>,
    },
    /// `agent_end`: the prompt queue drained.
    Idle,
    /// `compaction_start`: a compaction run began (TS compaction loader).
    CompactionStart {
        /// Why the compaction runs (`manual`/`requested`/`overflow`/`threshold`).
        reason: String,
        /// `/compact <instructions>` focus guidance.
        custom_instructions: Option<String>,
    },
    /// `compaction_summary_delta`: one streamed chunk of the summary the
    /// compaction model is generating (the operator's "stream the
    /// compacted summary" feature). The chunks accumulate onto the live
    /// loader's state; the settling `compaction_end` clears the streamed
    /// block when its durable summary row lands.
    CompactionSummaryDelta {
        /// The delta text (one summarizer text delta, verbatim).
        delta: String,
    },
    /// `compaction_end`: the compaction settled. Success carries the result
    /// (summary + token counts); skip/failure carries the error message and
    /// its severity (TS shows those for `manual` runs).
    CompactionEnd {
        /// Why the compaction ran.
        reason: String,
        /// The TS `CompactionResult` on success.
        result: Option<Value>,
        /// `/compact <instructions>` focus guidance (the event payload).
        custom_instructions: Option<String>,
        /// `true` when the run was cancelled.
        aborted: bool,
        /// The skip/failure message.
        error_message: Option<String>,
        /// `warning` or `error`.
        error_severity: Option<String>,
    },
    /// `goal_update`: the session goal state changed (raw wire `goal`
    /// payload; the session view owns announcement and tray rendering).
    GoalUpdate(Value),
    /// `session_action_update`: the queue projection changed (a message
    /// parked behind the run, was delivered, or was cleared). `starting`
    /// carries the picked-up prompt whose turn is still preparing (TS
    /// #2063 `sessionActions.active` with `kind: "turn"` / `phase:
    /// "preparing"`), so the strip keeps it visible until the turn
    /// begins. `rlm_child_status` carries the parked RLM child status
    /// notices' lane indices (the Rust-native typed provenance rider) so
    /// the strip folds exactly those rows, never a user-typed lookalike.
    QueueUpdated {
        steering: Vec<String>,
        follow_ups: Vec<String>,
        starting: Option<String>,
        rlm_child_status: crate::queued::RlmChildStatusIndices,
    },
    /// `bash_start` (the user-bash slot, TS `!command`): a command run
    /// outside the model loop; `transient` marks a side-conversation run
    /// that renders only in the owning client's pane.
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
        // `session_info_changed { name }` (TS `session.setSessionName`):
        // every attached client re-reads the session display name.
        "session_info_changed" => Some(TurnUpdate::SessionInfoChanged {
            name: event
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        // `service_tier_changed { serviceTier }` (TS fast-mode toggle):
        // the client patches its connection state (the `/fast` status
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
                // User messages carry the full payload on start; the
                // message_end twin of the same row must not re-render it
                // (TS interactive ignores user message_end frames), and
                // only a partial user frame would be a protocol anomaly.
                Some("user")
                    if event_type == Some("message_update")
                        || event_type == Some("message_end") =>
                {
                    Some(TurnUpdate::StatusUpdate)
                }
                Some("user") => Some(match user_display_text(&message) {
                    Some(text) => TurnUpdate::UserMessage(text),
                    // Nothing to show (an empty user message is a protocol
                    // anomaly): the transcript does not grow a blank row.
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
                rlm_child_status: queue_rlm_child_status(&actions),
            })
        }
        // `bash_start` (TS `runUserBash` emits before the process runs):
        // the identity fields ride the same frame (`transient` marks a
        // side-conversation run, `runId` matches the owning client).
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

/// The loader note from a `tool_execution_update` partial result, if the
/// tool owns one. The python-kernel bootstrap reports its startup stages as
/// partial results with `details.status = "starting"` (TS `reportStartupProgress`),
/// the same payload TS also hands its extension UI as the working message
/// (TS `setWorkingMessage`), so the loader row mirrors the stage text. `None`
/// leaves any current note untouched: streamed cell output reports `ok`,
/// which is not a note change.
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

/// Decode one `custom`-role wire message into its transcript update: the
/// session-command echo and result rows render as slash rows; a custom type
/// matching either shape with an invalid payload renders the malformed
/// notice; everything else (and non-display rows) renders nothing.
fn custom_row_update(message: &Value) -> Option<TurnUpdate> {
    let entries = custom_message_entries(message);
    match entries.first() {
        Some(entry) => Some(TurnUpdate::CustomRow(entry.clone())),
        None => Some(TurnUpdate::StatusUpdate),
    }
}

/// The transcript entries for one `custom`-role message: the custom-type
/// dispatch lives in [`crate::custom_message::custom_message_entries`]
/// (every entry type maps to its TS component).
pub fn custom_message_entries(message: &Value) -> Vec<ChatEntry> {
    crate::custom_message::custom_message_entries(message)
}

/// The user-message display text (TS `conversation-components`' user
/// branch): the text blocks joined, or the `[image]` placeholder when the
/// message carries content but no text (an image-only prompt), or `None`
/// for a message with nothing to show.
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
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(block_text)
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// Text of one content block: tagged text blocks and the engine's untagged
/// `{"text": ...}` form. Adjacent fragments of one message concatenate
/// without separators, like the TS message rendering.
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

/// Fold one raw message into chat entries. Assistant messages expand into a
/// message component (ordered text/thinking blocks) plus one card per tool
/// call, in content order.
pub fn message_value_to_entries(message: &Value) -> Vec<ChatEntry> {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match role {
        // TS `addMessageToChat`'s user case: a text that IS a skill block
        // renders the skill-invocation card (+ the trailing argument text
        // as its own user block); every other text renders the user block.
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

/// The compaction summary row (TS `CompactionSummaryMessageComponent`) from
/// its wire message: `summary`, `tokensBefore`, and the optional
/// `customInstructions` that focused it.
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

/// Fold one streamed tool call into the live transcript (TS
/// `getOrCreatePendingToolComponent` without its async deferral).
///
/// A provider announces a tool call before its function name streams in:
/// the wire `toolCall` block first arrives with an empty `name`, and later
/// `message_update` frames fill it. A card is therefore only created once
/// the call is identifiable (`id` non-empty) and named; a card created
/// earlier would carry the empty name forever (no later event corrects it),
/// fall through to the generic panel, and render the raw arguments JSON
/// instead of the tool's own card. An existing card refreshes from the
/// latest frame — the newest streamed name and arguments win (TS builds the
/// component against the latest streaming call). A card settled by a failed
/// frame is not an existing card for this purpose: a reused id re-arms as a
/// fresh card, the way TS's empty `pendingTools` map forces a new component
/// (`resetPendingToolState` cleared it) while the old aborted component keeps
/// its sweep-written result in the transcript.
pub fn apply_streamed_tool_card(
    view: &mut crate::view::AgentView,
    id: &str,
    name: &str,
    args: &Value,
) {
    if id.is_empty() || name.is_empty() {
        return;
    }
    let card_index = view.chat.iter().rposition(
        |entry| matches!(entry, ChatEntry::Tool(card) if card.id == id && !card.aborted),
    );
    match card_index {
        Some(index) => {
            view.prepare_entry_mutation(index);
            if let Some(ChatEntry::Tool(card)) = view.chat.get_mut(index) {
                card.name = name.to_string();
                card.args = args.clone();
            }
            view.mark_entry_stale(index);
        }
        None => view.push_entry(ChatEntry::Tool(Box::new(ToolCallCard {
            id: id.to_string(),
            name: name.to_string(),
            args: args.clone(),
            started: false,
            ..Default::default()
        }))),
    }
}

/// TS `message_end`'s failed-frame sweep: every still-pending tool card
/// settles with the failure text as an error result, and the card drops the
/// tool's late result frames (`resetPendingToolState` cleared the pending
/// map the same way — a late `tool_execution_end` finds no component there).
pub fn settle_pending_tool_cards(
    view: &mut crate::view::AgentView,
    pending: &mut std::collections::HashSet<String>,
    aborted: &mut std::collections::HashSet<String>,
    text: &str,
) {
    for tool_call_id in pending.drain() {
        // Every drained id records as aborted — late frames for a call that
        // never created a card land on nothing the same way (TS removed the
        // pending-map entry, and a late `tool_execution_start` finds no
        // component to re-create).
        aborted.insert(tool_call_id.clone());
        // The settle targets the newest card carrying the id: a re-armed
        // invocation pushed its own card, and the older settled card keeps
        // the previous sweep's result (TS's pending map only ever holds the
        // current component).
        if let Some(index) = view
            .chat
            .iter()
            .rposition(|entry| matches!(entry, ChatEntry::Tool(card) if card.id == tool_call_id))
        {
            view.prepare_entry_mutation(index);
            if let Some(ChatEntry::Tool(card)) = view.chat.get_mut(index) {
                card.result = Some(ToolResultView {
                    content: vec![serde_json::json!({ "type": "text", "text": text })],
                    details: serde_json::Value::Null,
                    is_error: true,
                });
                card.result_partial = false;
                card.ended_at = Some(std::time::Instant::now());
                card.aborted = true;
                view.mark_entry_stale(index);
            }
        }
    }
}

/// `tool_execution_start` folded into the live transcript: mark the matching
/// card running, or create it when the assistant-message frames have not
/// arrived yet. The daemon-reported tool name is authoritative — it
/// backfills a card still carrying an empty streamed name, so the card
/// routes to its tool-specific renderer (TS creates missing components with
/// `event.toolName`). A card settled by a failed frame is not a match: a
/// reused id gets a fresh card for its new invocation, exactly like TS's
/// empty pending map.
pub fn apply_tool_execution_start(
    view: &mut crate::view::AgentView,
    tool_call_id: &str,
    tool_name: &str,
    args: Value,
) {
    let card_index = view.chat.iter().rposition(
        |entry| matches!(entry, ChatEntry::Tool(card) if card.id == tool_call_id && !card.aborted),
    );
    if let Some(index) = card_index {
        view.prepare_entry_mutation(index);
        if let Some(ChatEntry::Tool(card)) = view.chat.get_mut(index) {
            card.started = true;
            card.started_at = Some(std::time::Instant::now());
            if card.name.is_empty() && !tool_name.is_empty() {
                card.name = tool_name.to_string();
            }
            if !args.is_null() {
                card.args = args;
            }
            view.mark_entry_stale(index);
        }
        return;
    }
    view.push_entry(ChatEntry::Tool(Box::new(ToolCallCard {
        id: tool_call_id.to_string(),
        name: tool_name.to_string(),
        args,
        started: true,
        started_at: Some(std::time::Instant::now()),
        ..Default::default()
    })));
}

/// The failure row a failed assistant message renders (TS
/// `AssistantMessageComponent.rebuild`): an abort always shows, a provider
/// `error` only when the message carries no tool calls (their cards carry
/// the failure then). `None` for settled messages.
pub struct AssistantErrorRow {
    /// The rendered row text (provider errors carry the `Error: ` prefix).
    pub text: String,
    /// `stopReason: "aborted"` (drives the tool-call trailing spacer).
    pub aborted: bool,
}

/// The failed-attempt error row a retry supersedes (SANCTIONED DIVERGENCE
/// from TS, operator ruling 2026-09-23 — the TS chat keeps one such row per
/// failed attempt): an error-only assistant entry, no blocks and no tool
/// calls (their cards carry the failure), not an abort. The episode's
/// `provider_retry_outcome` row replaces every superseded attempt.
pub fn is_superseded_attempt_row(entry: &ChatEntry) -> bool {
    matches!(
        entry,
        ChatEntry::Assistant(assistant)
            if assistant.error.is_some()
                && !assistant.aborted
                && assistant.blocks.is_empty()
                && !assistant.has_tool_calls
    )
}

/// Decode a failed assistant message's error row (TS `createErrorComponent`
/// inputs); `None` for settled messages.
pub fn assistant_error_row(
    message: &Value,
    tool_calls: &[(String, String, Value)],
) -> Option<AssistantErrorRow> {
    let stop_reason = message.get("stopReason").and_then(Value::as_str);
    match stop_reason {
        Some("aborted") => Some(AssistantErrorRow {
            text: message
                .get("errorMessage")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty() && *text != "Request was aborted")
                .unwrap_or("Operation aborted")
                .to_string(),
            aborted: true,
        }),
        Some("error") if tool_calls.is_empty() => Some(AssistantErrorRow {
            text: format!(
                "Error: {}",
                message
                    .get("errorMessage")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .unwrap_or("Unknown error")
            ),
            aborted: false,
        }),
        _ => None,
    }
}

/// Decode an assistant wire message into a message component plus tool cards.
pub fn assistant_value_to_entries(message: &Value) -> Vec<ChatEntry> {
    let (blocks, tool_calls) = assistant_message_parts(message);
    // TS `AssistantMessageComponent.rebuild`: an abort renders its error row
    // inside the message; a provider error renders only without tool calls
    // (their cards carry the failure). The component exists for every
    // assistant message (`message_start` creates one), so a content-less
    // failed provider attempt still folds into its own error row (TS
    // `buildConversationComponents` pushes the component unconditionally).
    let error = assistant_error_row(message, &tool_calls);
    if blocks.is_empty() && tool_calls.is_empty() && error.is_none() {
        return Vec::new();
    }
    let mut entries = Vec::new();
    if !blocks.is_empty() || error.is_some() {
        entries.push(ChatEntry::Assistant(Box::new(AssistantMessage {
            blocks,
            has_tool_calls: !tool_calls.is_empty(),
            streaming: false,
            error: error.as_ref().map(|row| row.text.clone()),
            aborted: error.as_ref().is_some_and(|row| row.aborted),
        })));
    }
    let started_ms = message
        .get("timestamp")
        .and_then(Value::as_u64)
        .filter(|ms| *ms > 0);
    for (id, name, args) in tool_calls {
        entries.push(ChatEntry::Tool(Box::new(ToolCallCard {
            id,
            name,
            args,
            started: false,
            started_ms,
            ..Default::default()
        })));
    }
    entries
}

/// The ordered visible blocks (thinking, text) and tool calls of one
/// assistant wire message.
pub fn assistant_message_parts(
    message: &Value,
) -> (Vec<MessageBlock>, Vec<(String, String, Value)>) {
    let mut blocks = Vec::new();
    let mut tool_calls = Vec::new();
    match message.get("content") {
        Some(Value::String(text)) => {
            if !text.is_empty() {
                blocks.push(MessageBlock::Text(text.clone()));
            }
        }
        Some(Value::Array(array)) => {
            for block in array {
                let block_type = block.get("type").and_then(Value::as_str);
                match block_type {
                    Some("thinking") => {
                        let thinking = block.get("thinking").and_then(Value::as_str);
                        if let Some(thinking) = thinking.filter(|text| !text.trim().is_empty()) {
                            blocks.push(MessageBlock::Thinking(thinking.to_string()));
                        }
                    }
                    Some("text") => {
                        let text = block.get("text").and_then(Value::as_str);
                        if let Some(text) = text.filter(|text| !text.trim().is_empty()) {
                            blocks.push(MessageBlock::Text(text.to_string()));
                        }
                    }
                    Some("toolCall") => {
                        tool_calls.push((
                            block
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            block.get("arguments").cloned().unwrap_or(Value::Null),
                        ));
                    }
                    None => {
                        // Untagged text blocks (the scripted engine's form).
                        let text = block.get("text").and_then(Value::as_str);
                        if let Some(text) = text.filter(|text| !text.is_empty()) {
                            blocks.push(MessageBlock::Text(text.to_string()));
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    (blocks, tool_calls)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::StatusKind;
    use serde_json::json;

    fn test_view() -> crate::view::AgentView {
        crate::view::AgentView::new(crate::theme::Theme::builtin(
            "prime",
            crate::theme::ColorMode::TrueColor,
        ))
    }

    fn card_of(view: &crate::view::AgentView) -> Option<&ToolCallCard> {
        view.chat.iter().find_map(|entry| match entry {
            ChatEntry::Tool(card) => Some(card.as_ref()),
            _ => None,
        })
    }

    fn cards_of(view: &crate::view::AgentView) -> Vec<ToolCallCard> {
        view.chat
            .iter()
            .filter_map(|entry| match entry {
                ChatEntry::Tool(card) => Some((**card).clone()),
                _ => None,
            })
            .collect()
    }

    fn rendered_card_text(view: &crate::view::AgentView) -> Vec<String> {
        let Some(card) = card_of(view) else {
            return Vec::new();
        };
        crate::tool_card::render_tool_card(
            card,
            0,
            crate::chat::Detail::Overview,
            &view.theme,
            100,
            true,
        )
        .iter()
        .map(|line| line.iter().map(|span| span.content.as_str()).collect())
        .collect()
    }

    #[test]
    fn image_only_user_message_shows_the_image_placeholder() {
        let message = json!({
            "role": "user",
            "content": [
                { "type": "image", "data": "QUJD", "mimeType": "image/png" }
            ]
        });
        assert_eq!(user_display_text(&message), Some("[image]".to_string()));
        assert_eq!(
            message_value_to_entries(&message),
            vec![ChatEntry::User {
                text: "[image]".to_string()
            }]
        );
    }

    #[test]
    fn a_skill_block_user_message_decodes_to_the_card() {
        // TS `addMessageToChat`'s user case: the persisted user message
        // that carried a skill invocation parses into the card + the
        // trailing argument text, never the raw block.
        let message = json!({
            "role": "user",
            "content": "<skill name=\"websearch\" location=\"/s/SKILL.md\">\nRun one query.\n</skill>\n\nfind parity tuis"
        });
        let entries = message_value_to_entries(&message);
        assert!(
            matches!(
                entries.as_slice(),
                [
                    ChatEntry::SkillInvocation(card),
                    ChatEntry::User { text }
                ] if card.name == "websearch"
                    && card.content == "Run one query."
                    && text == "find parity tuis"
            ),
            "entries: {entries:?}"
        );
    }

    #[test]
    fn user_message_with_text_and_image_keeps_the_text() {
        let message = json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "look at this" },
                { "type": "image", "data": "QUJD", "mimeType": "image/png" }
            ]
        });
        assert_eq!(
            user_display_text(&message),
            Some("look at this".to_string())
        );
    }

    #[test]
    fn empty_user_message_renders_no_entry() {
        let message = json!({ "role": "user", "content": [] });
        assert_eq!(user_display_text(&message), None);
        assert!(message_value_to_entries(&message).is_empty());
    }

    /// The live wire shape that broke the ipython card: a provider announces
    /// the tool call before the function name streams in (the openai-style
    /// toolcall-start frame carries the block unnamed), so the first
    /// `message_update` frame has an empty `name`. The card must not freeze
    /// on that frame — the named frame routes it to the ipython renderer and
    /// the collapsed line shows the code preview, not the raw arguments
    /// JSON.
    /// TS `orderMessagesForTranscript`: the wire context is summary-first
    /// for the model, but the transcript presents the summary at its
    /// chronological boundary — after the retained messages
    /// (`retainedMessageCount`), before anything appended after the
    /// compaction.
    #[test]
    fn transcript_presents_the_summary_after_the_retained_tail() {
        let messages = vec![
            json!({
                "role": "compactionSummary", "summary": "the story",
                "retainedMessageCount": 2, "tokensBefore": 12, "timestamp": 30u64
            }),
            json!({"role": "user", "content": "second turn", "timestamp": 20u64}),
            json!({"role": "assistant", "content": "kept intact", "timestamp": 25u64}),
            json!({
                "role": "custom", "customType": "session_slash_command",
                "content": "/compact focus on the goal", "display": true, "timestamp": 40u64,
                "details": { "command": {
                    "name": "compact",
                    "args": "focus on the goal",
                    "text": "/compact focus on the goal"
                } }
            }),
        ];
        let entries = transcript_to_entries(&messages);
        let order: Vec<String> = entries
            .iter()
            .filter_map(|entry| match entry {
                ChatEntry::User { .. } => Some("user".to_string()),
                ChatEntry::Assistant { .. } => Some("assistant".to_string()),
                ChatEntry::CompactionSummary { .. } => Some("summary".to_string()),
                ChatEntry::SlashCommand { .. } => Some("slash".to_string()),
                _ => None,
            })
            .collect();
        assert_eq!(order, ["user", "assistant", "summary", "slash"]);
    }

    #[test]
    fn unnamed_streamed_tool_call_renders_code_once_named() {
        let mut view = test_view();
        apply_streamed_tool_card(&mut view, "call-1", "", &json!({ "code": "fibonacci(23)" }));
        assert!(
            card_of(&view).is_none(),
            "a call without a streamed name renders no card yet"
        );
        apply_streamed_tool_card(
            &mut view,
            "call-1",
            "ipython",
            &json!({ "code": "fibonacci(23)" }),
        );
        let card = card_of(&view).expect("the named frame creates the card");
        assert_eq!(card.name, "ipython");
        assert!(card.args.get("code").is_some(), "args stream into the card");
        let rows = rendered_card_text(&view);
        assert!(
            rows.iter()
                .any(|row| row.contains("python") && row.contains("fibonacci(23)")),
            "the ipython card renders the code preview: {rows:?}"
        );
        assert!(
            rows.iter()
                .all(|row| !row.contains("\"code\"") && !row.contains('{')),
            "the raw arguments JSON must not render: {rows:?}"
        );
    }

    /// TS `message_end`'s failed-frame sweep: every still-pending card
    /// settles with the failure text as an error result, the pending set
    /// drains, and the card flags the abort so the tool's late result
    /// frames land on nothing.
    #[test]
    fn failed_frame_sweep_settles_pending_tool_cards() {
        let mut view = test_view();
        apply_streamed_tool_card(
            &mut view,
            "call-1",
            "bash",
            &json!({ "command": "sleep 10" }),
        );
        apply_tool_execution_start(&mut view, "call-1", "bash", Value::Null);
        let mut pending = std::collections::HashSet::from(["call-1".to_string()]);
        let mut aborted = std::collections::HashSet::new();
        settle_pending_tool_cards(
            &mut view,
            &mut pending,
            &mut aborted,
            "Operation aborted \u{00b7} 3s",
        );
        assert!(pending.is_empty(), "the sweep drains the pending set");
        // Every drained id records as aborted - late frames for a call
        // that never created a card land on nothing the same way.
        assert_eq!(
            aborted,
            std::collections::HashSet::from(["call-1".to_string()]),
            "the sweep records the settled ids"
        );
        let card = card_of(&view).expect("the streamed card");
        assert!(card.aborted, "the settled card flags the abort");
        let result = card.result.as_ref().expect("the settle result");
        assert!(result.is_error, "the settle result is an error");
        assert_eq!(result.text_output(false), "Operation aborted \u{00b7} 3s");
        assert!(!card.result_partial, "the settle result is final");
        assert!(card.ended_at.is_some(), "the settle stamps the card ended");
    }

    /// A reused id after a failed run re-arms as a fresh card (TS's cleared
    /// pending map forces a new component for the new invocation); the old
    /// settled card keeps its sweep-written abort result in the transcript.
    #[test]
    fn reused_id_after_abort_re_arms_as_a_fresh_card() {
        let mut view = test_view();
        apply_streamed_tool_card(
            &mut view,
            "call-1",
            "bash",
            &json!({ "command": "sleep 10" }),
        );
        apply_tool_execution_start(&mut view, "call-1", "bash", Value::Null);
        let mut pending = std::collections::HashSet::from(["call-1".to_string()]);
        let mut aborted = std::collections::HashSet::new();
        settle_pending_tool_cards(
            &mut view,
            &mut pending,
            &mut aborted,
            "Operation aborted \u{00b7} 3s",
        );
        let settled = cards_of(&view);
        // The re-armed invocation's streamed frame: a fresh card, not a
        // refresh of the settled one.
        apply_streamed_tool_card(
            &mut view,
            "call-1",
            "bash",
            &json!({ "command": "echo ready" }),
        );
        let cards = cards_of(&view);
        assert_eq!(cards.len(), 2, "two cards: {cards:?}");
        assert!(cards[0].aborted, "the old card keeps its abort");
        assert_eq!(
            cards[0]
                .result
                .as_ref()
                .expect("the settle result")
                .text_output(false),
            "Operation aborted \u{00b7} 3s"
        );
        assert!(!cards[1].aborted, "the new card starts fresh");
        assert_eq!(cards[1].result, None, "the new card has no result");
        assert_eq!(cards[1].args.get("command"), Some(&json!("echo ready")));
        // The execution start marks the new invocation's card; the old
        // settled card stays untouched.
        apply_tool_execution_start(&mut view, "call-1", "bash", Value::Null);
        let cards = cards_of(&view);
        assert_eq!(cards[0], settled[0], "the settled card is untouched");
        assert!(cards[1].started, "the fresh card runs");
    }

    /// A second failed run settles the re-armed invocation's own card — the
    /// newest card carrying the id — so the older card keeps the first
    /// sweep's result (TS's pending map only ever holds the current
    /// component).
    #[test]
    fn sweep_settles_the_re_armed_card_not_the_settled_one() {
        let mut view = test_view();
        apply_streamed_tool_card(
            &mut view,
            "call-1",
            "bash",
            &json!({ "command": "sleep 10" }),
        );
        let mut pending = std::collections::HashSet::from(["call-1".to_string()]);
        let mut aborted = std::collections::HashSet::new();
        settle_pending_tool_cards(
            &mut view,
            &mut pending,
            &mut aborted,
            "Operation aborted \u{00b7} 3s",
        );
        apply_streamed_tool_card(
            &mut view,
            "call-1",
            "bash",
            &json!({ "command": "echo ready" }),
        );
        let mut pending = std::collections::HashSet::from(["call-1".to_string()]);
        let mut aborted = std::collections::HashSet::new();
        settle_pending_tool_cards(
            &mut view,
            &mut pending,
            &mut aborted,
            "Aborted after 1 retry attempt \u{00b7} 8s",
        );
        let cards = cards_of(&view);
        assert_eq!(cards.len(), 2, "two cards: {cards:?}");
        assert_eq!(
            cards[0]
                .result
                .as_ref()
                .expect("the first settle")
                .text_output(false),
            "Operation aborted \u{00b7} 3s",
            "the older card keeps its own sweep result"
        );
        assert!(cards[1].aborted, "the re-armed card settled");
        assert_eq!(
            cards[1]
                .result
                .as_ref()
                .expect("the second settle")
                .text_output(false),
            "Aborted after 1 retry attempt \u{00b7} 8s"
        );
    }

    /// The latest streamed frame wins on an existing card (TS builds the
    /// pending component against the latest streaming call), so a card that
    /// somehow kept an empty name picks the name up from the next frame.
    #[test]
    fn existing_card_refreshes_name_and_args_from_latest_frame() {
        let mut view = test_view();
        view.push_entry(ChatEntry::Tool(Box::new(ToolCallCard {
            id: "call-1".into(),
            name: String::new(),
            args: Value::Null,
            ..Default::default()
        })));
        apply_streamed_tool_card(&mut view, "call-1", "ipython", &json!({ "code": "x = 1" }));
        let card = card_of(&view).expect("the streamed frame finds the card");
        assert_eq!(card.name, "ipython");
        assert_eq!(card.args.get("code"), Some(&json!("x = 1")));
    }

    /// `tool_execution_start` reports the actual tool name ("ipython" on
    /// the wire today); it backfills a card still unnamed and creates the
    /// card when the message frames have not arrived yet.
    #[test]
    fn tool_execution_start_reports_the_tool_name() {
        let mut view = test_view();
        view.push_entry(ChatEntry::Tool(Box::new(ToolCallCard {
            id: "call-1".into(),
            name: String::new(),
            args: Value::Null,
            ..Default::default()
        })));
        apply_tool_execution_start(
            &mut view,
            "call-1",
            "ipython",
            json!({ "code": "print('hi')" }),
        );
        let card = card_of(&view).expect("the start event finds the card");
        assert_eq!(card.name, "ipython");
        assert!(card.started, "the start event marks execution started");

        let mut fresh = test_view();
        apply_tool_execution_start(
            &mut fresh,
            "call-2",
            "ipython",
            json!({ "code": "fibonacci(23)" }),
        );
        let rows = rendered_card_text(&fresh);
        assert!(
            rows.iter()
                .any(|row| row.contains("python") && row.contains("fibonacci(23)")),
            "a card created from the start event renders the code preview: {rows:?}"
        );
    }

    fn slim_attach() -> Value {
        json!({
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "activeSessionId": "abc123def456",
            "snapshot": {
                "activeSessionId": "abc123def456",
                "summary": { "id": "abc123def456", "cwd": "/tmp" },
                "state": {
                    "activeSessionId": "abc123def456",
                    "cwd": "/tmp",
                    "sessionId": "0199-sess",
                    "sessionName": "my session",
                    "model": null,
                    "thinkingLevel": "default",
                    "serviceTier": "auto",
                    "isStreaming": false,
                    "isCompacting": false,
                    "retryAttempt": 0,
                    "steeringMode": "all",
                    "followUpMode": "all",
                    "autoCompactionEnabled": false,
                    "messageCount": 2,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                    "compactionCount": 0,
                    "goal": null,
                    "scopedModels": [],
                    "activeToolNames": [],
                },
                "messages": [
                    { "role": "user", "content": "hello", "timestamp": 1 },
                    { "role": "assistant", "content": "hi there", "provider": "scripted", "model": "faux-1", "usage": { "input": 120, "output": 8 }, "timestamp": 2 },
                ],
                "lastEventSequence": 9,
                "lastEventCursor": { "generation": "g", "sequence": 9 },
                "children": [],
            },
            "replay": { "status": "complete", "toSequence": 9, "toCursor": { "generation": "g", "sequence": 9 } },
            "lastEventSequence": 9,
            "lastEventCursor": { "generation": "g", "sequence": 9 },
            "client": { "id": "c1", "capabilities": ["attach_snapshot", "event_sequence", "slim_attach"] },
        })
    }

    #[test]
    fn an_unmatched_replay_result_keeps_its_standalone_card() {
        // A `toolResult` whose call never landed on a pending card
        // keeps its orphan card exactly like the live push path - the
        // rebuilt transcript never drops the standalone result.
        let mut rebuilt = Reconstructed::default();
        rebuilt.push_message(&json!({
            "role": "user",
            "content": "run it",
        }));
        rebuilt.push_message(&json!({
            "role": "toolResult",
            "toolCallId": "orphan",
            "toolName": "bash",
            "content": [{ "type": "text", "text": "orphan output" }],
            "isError": false,
            "timestamp": 123,
        }));
        assert_eq!(rebuilt.chat.len(), 2, "the orphan card lands");
        match &rebuilt.chat[1] {
            ChatEntry::Tool(card) => {
                assert_eq!(card.id, "orphan");
                assert_eq!(card.name, "bash");
                assert!(card.unmatched_result, "the orphan never joins a run");
                assert_eq!(
                    card.ended_ms,
                    Some(123),
                    "the wire timestamp rides the card"
                );
            }
            other => panic!("the orphan is a card: {other:?}"),
        }
    }

    #[test]
    fn a_bulk_replay_never_drops_an_orphan_result() {
        // The bulk path (slim attach, the get-messages rebuild) keeps
        // an unmatched `toolResult` as its standalone orphan card -
        // the rebuilt transcript matches the live and incremental
        // paths.
        let chat = transcript_to_entries(&[
            json!({
                "role": "user",
                "content": "run it",
            }),
            json!({
                "role": "toolResult",
                "toolCallId": "orphan",
                "toolName": "bash",
                "content": [{ "type": "text", "text": "orphan output" }],
                "isError": false,
                "timestamp": 123,
            }),
        ]);
        assert_eq!(chat.len(), 2, "the orphan card lands in the bulk path");
        match &chat[1] {
            ChatEntry::Tool(card) => {
                assert_eq!(card.id, "orphan");
                assert_eq!(card.name, "bash");
                assert!(card.unmatched_result, "the bulk orphan never joins a run");
            }
            other => panic!("the orphan is a card: {other:?}"),
        }
    }

    #[test]
    fn a_bulk_replay_settles_the_last_pending_card_for_a_reused_id() {
        // A later invocation reusing a `tool_call_id` settles its OWN
        // card (the live `rposition` match), never the first
        // invocation's pending one - and the result never becomes an
        // orphan.
        let chat = transcript_to_entries(&[
            json!({
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "calling twice" },
                    { "type": "toolCall", "id": "dup", "name": "ipython", "arguments": {"code": "1"} },
                ],
                "timestamp": 1,
            }),
            json!({
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "again" },
                    { "type": "toolCall", "id": "dup", "name": "ipython", "arguments": {"code": "2"} },
                ],
                "timestamp": 2,
            }),
            json!({
                "role": "toolResult",
                "toolCallId": "dup",
                "toolName": "ipython",
                "content": [{ "type": "text", "text": "the second run" }],
                "isError": false,
                "timestamp": 3,
            }),
        ]);
        let cards: Vec<&crate::chat::ToolCallCard> = chat
            .iter()
            .filter_map(|entry| match entry {
                ChatEntry::Tool(card) => Some(card.as_ref()),
                _ => None,
            })
            .collect();
        assert_eq!(cards.len(), 2, "two cards for the reused id: {chat:?}");
        assert!(cards[0].result.is_none(), "the first stays pending");
        let settled = cards[1].result.as_ref().expect("the LAST card settled");
        assert_eq!(
            settled.content,
            vec![json!({ "type": "text", "text": "the second run" })]
        );
    }

    #[test]
    fn an_interleaved_replay_pairs_results_in_arrival_order() {
        // Call, result, ANOTHER call reusing the id, result: each
        // result settles the call it FOLLOWED (the live arrival-order
        // pairing), never the later invocation's card.
        let chat = transcript_to_entries(&[
            json!({
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "first" },
                    { "type": "toolCall", "id": "dup", "name": "ipython", "arguments": {"code": "1"} },
                ],
                "timestamp": 1,
            }),
            json!({
                "role": "toolResult",
                "toolCallId": "dup",
                "toolName": "ipython",
                "content": [{ "type": "text", "text": "the first run" }],
                "isError": false,
                "timestamp": 2,
            }),
            json!({
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "second" },
                    { "type": "toolCall", "id": "dup", "name": "ipython", "arguments": {"code": "2"} },
                ],
                "timestamp": 3,
            }),
            json!({
                "role": "toolResult",
                "toolCallId": "dup",
                "toolName": "ipython",
                "content": [{ "type": "text", "text": "the second run" }],
                "isError": false,
                "timestamp": 4,
            }),
        ]);
        let cards: Vec<&crate::chat::ToolCallCard> = chat
            .iter()
            .filter_map(|entry| match entry {
                ChatEntry::Tool(card) => Some(card.as_ref()),
                _ => None,
            })
            .collect();
        assert_eq!(cards.len(), 2, "two cards: {chat:?}");
        assert_eq!(
            cards[0]
                .result
                .as_ref()
                .and_then(|result| result.content.first())
                .and_then(|block| block.get("text"))
                .and_then(Value::as_str),
            Some("the first run"),
            "the FIRST call kept its own result"
        );
        assert_eq!(
            cards[1]
                .result
                .as_ref()
                .and_then(|result| result.content.first())
                .and_then(|block| block.get("text"))
                .and_then(Value::as_str),
            Some("the second run"),
            "the SECOND call kept its own result"
        );
    }

    #[test]
    fn an_orphan_result_keeps_its_wire_position() {
        // An orphan result BETWEEN two ordinary messages lands at its
        // own wire position in the rebuilt transcript - never at the
        // tail (condensation can never span across it).
        let chat = transcript_to_entries(&[
            json!({
                "role": "user",
                "content": "before",
                "timestamp": 1,
            }),
            json!({
                "role": "toolResult",
                "toolCallId": "orphan",
                "toolName": "bash",
                "content": [{ "type": "text", "text": "orphan output" }],
                "isError": false,
                "timestamp": 2,
            }),
            json!({
                "role": "user",
                "content": "after",
                "timestamp": 3,
            }),
        ]);
        assert_eq!(chat.len(), 3, "the orphan card sits between: {chat:?}");
        match &chat[1] {
            ChatEntry::Tool(card) => assert!(card.unmatched_result),
            other => panic!("the orphan sits at its wire position: {other:?}"),
        }
        assert!(matches!(&chat[2], ChatEntry::User { text } if text == "after"));
    }

    #[test]
    fn a_leftover_settle_keeps_its_own_orphan_card() {
        // A result arriving after its card ALREADY settled (a leftover)
        // never crosses a later reused invocation: it keeps its own
        // orphan card at its wire position, and the later card stays
        // pending - exactly the live push path.
        let chat = transcript_to_entries(&[
            json!({
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "first" },
                    { "type": "toolCall", "id": "dup", "name": "ipython", "arguments": {"code": "1"} },
                ],
                "timestamp": 1,
            }),
            json!({
                "role": "toolResult",
                "toolCallId": "dup",
                "toolName": "ipython",
                "content": [{ "type": "text", "text": "the first run" }],
                "isError": false,
                "timestamp": 2,
            }),
            json!({
                "role": "toolResult",
                "toolCallId": "dup",
                "toolName": "ipython",
                "content": [{ "type": "text", "text": "the leftover" }],
                "isError": false,
                "timestamp": 3,
            }),
            json!({
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "second" },
                    { "type": "toolCall", "id": "dup", "name": "ipython", "arguments": {"code": "2"} },
                ],
                "timestamp": 4,
            }),
        ]);
        let cards: Vec<&crate::chat::ToolCallCard> = chat
            .iter()
            .filter_map(|entry| match entry {
                ChatEntry::Tool(card) => Some(card.as_ref()),
                _ => None,
            })
            .collect();
        assert_eq!(
            cards.len(),
            3,
            "the call, the leftover's orphan, and the later call: {chat:?}"
        );
        assert_eq!(
            cards[0]
                .result
                .as_ref()
                .and_then(|result| result.content.first())
                .and_then(|block| block.get("text"))
                .and_then(Value::as_str),
            Some("the first run"),
            "the FIRST call kept its own result"
        );
        let leftover = cards[1];
        assert_eq!(leftover.id, "dup");
        assert!(
            leftover.unmatched_result,
            "the leftover keeps its own orphan card"
        );
        assert_eq!(
            leftover
                .result
                .as_ref()
                .and_then(|result| result.content.first())
                .and_then(|block| block.get("text"))
                .and_then(Value::as_str),
            Some("the leftover")
        );
        // The second invocation's card stays pending (its result arrives
        // later or never).
        let second_call = chat.iter().rev().find_map(|entry| match entry {
            ChatEntry::Tool(card) if !card.unmatched_result => Some(card.as_ref()),
            _ => None,
        });
        let Some(second) = second_call else {
            panic!("the second call: {chat:?}")
        };
        assert!(
            second.result.is_none(),
            "the later invocation stays pending"
        );
    }

    #[test]
    fn reconstructs_slim_attach() {
        let data = attach_data_from_response(slim_attach()).unwrap();
        assert_eq!(data.active_session_id, "abc123def456");
        let view = reconstruct(&data);
        assert_eq!(view.chat.len(), 2);
        assert!(matches!(&view.chat[0], ChatEntry::User { text } if text == "hello"));
        assert!(matches!(&view.chat[1], ChatEntry::Assistant(m) if m.blocks
            == vec![MessageBlock::Text("hi there".to_string())]));
        assert_eq!(view.session_id, "0199-sess");
        assert_eq!(view.session_name.as_deref(), Some("my session"));
        assert_eq!(view.last_event_sequence, 9);
    }

    #[test]
    fn reconstructs_the_queue_from_session_actions() {
        let mut attach = slim_attach();
        attach["snapshot"]["state"]["sessionActions"] = json!({
            "queuedCount": 2,
            "steering": ["turn right"],
            "followUps": ["then summarize"],
        });
        let data = attach_data_from_response(attach).unwrap();
        let view = reconstruct(&data);
        assert_eq!(
            view.queued,
            crate::queued::QueuedMessages {
                steering: vec!["turn right".to_string()],
                follow_ups: vec!["then summarize".to_string()],
                starting: None,
                rlm_child_status: crate::queued::RlmChildStatusIndices::default(),
            },
            "an attach re-syncs the queue strip from the snapshot"
        );
    }

    /// The typed child-status provenance rides the attach snapshot too
    /// (replay parity with the live frames): the parked notices stay
    /// folded and inspectable across a re-attach, while a notice-free
    /// projection (the TS wire shape, rider omitted) still decodes.
    #[test]
    fn reconstructs_the_child_status_provenance_from_session_actions() {
        let mut attach = slim_attach();
        attach["snapshot"]["state"]["sessionActions"] = json!({
            "queuedCount": 3,
            "steering": ["turn right"],
            "followUps": [
                "[child-exited: no-reply child:lane]\n\nLast assistant text: done",
                "then summarize",
                "[child-failed child:broken]\n\nboom",
            ],
            "rlmChildStatus": { "steering": [], "followUp": [0, 2] },
        });
        let data = attach_data_from_response(attach).unwrap();
        let view = reconstruct(&data);
        assert_eq!(
            view.queued.rlm_child_status,
            crate::queued::RlmChildStatusIndices {
                steering: Vec::new(),
                follow_up: vec![0, 2],
            },
            "the attach re-sync carries the typed provenance"
        );
    }

    /// TS #2063: an attach re-sync mid-preparing keeps the picked-up
    /// prompt visible too — the snapshot's active action projects the
    /// same starting row the live frames carry.
    #[test]
    fn reconstructs_the_starting_row_from_session_actions() {
        let mut attach = slim_attach();
        attach["snapshot"]["state"]["sessionActions"] = json!({
            "queuedCount": 0,
            "steering": [],
            "followUps": [],
            "active": {
                "kind": "turn",
                "phase": "preparing",
                "label": "queued before compaction",
            },
        });
        let data = attach_data_from_response(attach).unwrap();
        let view = reconstruct(&data);
        assert_eq!(
            view.queued.starting,
            Some("queued before compaction".to_string()),
            "an attach re-sync keeps the preparing turn's prompt visible"
        );
    }

    #[test]
    fn decodes_the_user_bash_event_triple() {
        // The `!command` lane (TS `runUserBash`): bash_start carries the
        // command and identity, bash_output one chunk, bash_end the
        // settled outcome — all decoded whole-object.
        let start = event_to_update(&json!({
            "type": "bash_start",
            "command": "echo hi",
            "excludeFromContext": false,
        }))
        .expect("a bash start");
        assert_eq!(
            start,
            TurnUpdate::BashStart {
                command: "echo hi".to_string(),
                exclude_from_context: false,
                transient: false,
                run_id: None,
            }
        );
        let side_start = event_to_update(&json!({
            "type": "bash_start",
            "command": "echo pane",
            "excludeFromContext": true,
            "transient": true,
            "runId": "run-1",
        }))
        .expect("a transient bash start");
        assert_eq!(
            side_start,
            TurnUpdate::BashStart {
                command: "echo pane".to_string(),
                exclude_from_context: true,
                transient: true,
                run_id: Some("run-1".to_string()),
            }
        );
        assert_eq!(
            event_to_update(&json!({ "type": "bash_output", "chunk": "hi\n" })),
            Some(TurnUpdate::BashOutput {
                chunk: "hi\n".to_string()
            })
        );
        assert_eq!(
            event_to_update(&json!({
                "type": "bash_end",
                "exitCode": 0,
                "cancelled": false,
                "truncated": false,
            })),
            Some(TurnUpdate::BashEnd {
                exit_code: Some(0),
                cancelled: false,
                truncated: false,
                full_output_path: None,
                error_message: None,
                transient: false,
                run_id: None,
            })
        );
    }

    #[test]
    fn decodes_session_action_update_as_the_queue_projection() {
        let update = event_to_update(&json!({
            "type": "session_action_update",
            "actions": {
                "queuedCount": 1,
                "steering": [],
                "followUps": ["queued follow-up"],
            },
        }))
        .expect("a queue update");
        assert_eq!(
            update,
            TurnUpdate::QueueUpdated {
                steering: vec![],
                follow_ups: vec!["queued follow-up".to_string()],
                starting: None,
                rlm_child_status: crate::queued::RlmChildStatusIndices::default(),
            }
        );
    }

    /// The live queue update carries the typed child-status provenance
    /// (the Rust-native rider): the parked notices fold into the strip
    /// on the live path exactly like the attach path, and a notice-free
    /// projection decodes with empty provenance.
    #[test]
    fn decodes_the_child_status_provenance_from_the_live_queue_update() {
        let update = event_to_update(&json!({
            "type": "session_action_update",
            "actions": {
                "queuedCount": 2,
                "steering": ["[child-exited: no-reply child:lane]"],
                "followUps": ["then summarize"],
                "rlmChildStatus": { "steering": [0], "followUp": [] },
            },
        }))
        .expect("a queue update");
        assert_eq!(
            update,
            TurnUpdate::QueueUpdated {
                steering: vec!["[child-exited: no-reply child:lane]".to_string()],
                follow_ups: vec!["then summarize".to_string()],
                starting: None,
                rlm_child_status: crate::queued::RlmChildStatusIndices {
                    steering: vec![0],
                    follow_up: Vec::new(),
                },
            }
        );
    }

    /// TS #2063 (RES-1306): a queue update that reports a preparing turn
    /// carries the picked-up prompt's label as the strip's starting row,
    /// whatever the parked lanes hold; a later phase (the turn committed)
    /// drops it.
    #[test]
    fn decodes_the_preparing_turn_label_as_the_starting_row() {
        let preparing = json!({
            "type": "session_action_update",
            "actions": {
                "queuedCount": 0,
                "steering": [],
                "followUps": [],
                "active": {
                    "kind": "turn",
                    "phase": "preparing",
                    "label": "queued before compaction",
                },
            },
        });
        assert_eq!(
            event_to_update(&preparing),
            Some(TurnUpdate::QueueUpdated {
                steering: vec![],
                follow_ups: vec![],
                starting: Some("queued before compaction".to_string()),
                rlm_child_status: crate::queued::RlmChildStatusIndices::default(),
            })
        );
        let committed = json!({
            "type": "session_action_update",
            "actions": {
                "queuedCount": 0,
                "steering": [],
                "followUps": [],
                "active": {
                    "kind": "turn",
                    "phase": "committing",
                    "label": "queued before compaction",
                },
            },
        });
        assert_eq!(
            event_to_update(&committed),
            Some(TurnUpdate::QueueUpdated {
                steering: vec![],
                follow_ups: vec![],
                starting: None,
                rlm_child_status: crate::queued::RlmChildStatusIndices::default(),
            })
        );
        // An active action that is not a turn never projects a starting
        // row.
        let other_kind = json!({
            "type": "session_action_update",
            "actions": {
                "queuedCount": 0,
                "steering": [],
                "followUps": [],
                "active": {
                    "kind": "session_command",
                    "phase": "preparing",
                    "label": "/theme dark",
                },
            },
        });
        assert_eq!(
            event_to_update(&other_kind),
            Some(TurnUpdate::QueueUpdated {
                steering: vec![],
                follow_ups: vec![],
                starting: None,
                rlm_child_status: crate::queued::RlmChildStatusIndices::default(),
            })
        );
    }

    /// The rebuild side of the single-line retry UX (operator ruling
    /// 2026-09-23): the `provider_retry_outcome` row replaces the failed
    /// attempts its episode superseded — the rebuilt chat shows ONE line
    /// per episode, never the per-attempt error rows TS renders.
    #[test]
    fn retry_outcome_row_collapses_the_superseded_attempts() {
        let user = json!({"role": "user", "content": "run the deploy"});
        let failed = |text: &str| {
            json!({
                "role": "assistant",
                "content": [],
                "stopReason": "error",
                "errorMessage": text,
            })
        };
        let outcome = json!({
            "role": "custom",
            "customType": "provider_retry_outcome",
            "content": "Recovered after 2 retries: 429 Too many concurrent requests (limit: 32)",
            "display": true,
            "details": { "success": true, "attempts": 2, "finalError": "429 Too many concurrent requests (limit: 32)" },
        });
        let recovered = json!({"role": "assistant", "content": [{"type": "text", "text": "deployed"}], "stopReason": "stop"});
        let messages = vec![
            user,
            failed("Error: 429 Too many concurrent requests (limit: 32). Try again shortly."),
            failed("Error: 429 Too many concurrent requests (limit: 32). Try again shortly."),
            outcome,
            recovered,
        ];
        let entries = transcript_to_entries(&messages);
        // Exactly: the user row, the ONE outcome line, the recovered reply.
        assert_eq!(entries.len(), 3, "entries: {entries:?}");
        assert!(matches!(
            entries[1],
            ChatEntry::Status { ref text, kind: StatusKind::Info }
                if text.contains("Recovered after 2 retries")
                    && text.contains("429 Too many concurrent requests")
        ));
        // Zero superseded attempt rows survive.
        assert!(
            entries
                .iter()
                .all(|entry| !is_superseded_attempt_row(entry)),
            "per-attempt rows must collapse: {entries:?}"
        );
    }

    /// Without an outcome row the failure is not an episode: the lone
    /// error row keeps today's rendering (retries disabled or a
    /// non-retryable kind).
    #[test]
    fn a_lone_failed_attempt_without_an_outcome_row_stays() {
        let user = json!({"role": "user", "content": "hi"});
        let failed = json!({
            "role": "assistant",
            "content": [],
            "stopReason": "error",
            "errorMessage": "401 Unauthorized",
        });
        let entries = transcript_to_entries(&[user, failed]);
        assert_eq!(entries.len(), 2, "entries: {entries:?}");
        assert!(
            entries.iter().any(is_superseded_attempt_row),
            "the lone failure renders its own row: {entries:?}"
        );
    }

    /// Aborted attempts are never collateral of the collapse.
    #[test]
    fn aborted_attempts_never_collapse() {
        let user = json!({"role": "user", "content": "hi"});
        let aborted = json!({
            "role": "assistant",
            "content": [],
            "stopReason": "aborted",
            "errorMessage": "Operation aborted",
        });
        let outcome = json!({
            "role": "custom",
            "customType": "provider_retry_outcome",
            "content": "\u{26a0} Error: Retry failed after 1 attempts: Retry cancelled",
            "display": true,
            "details": { "success": false, "attempts": 1, "finalError": "Retry cancelled" },
        });
        let entries = transcript_to_entries(&[user, aborted, outcome]);
        assert_eq!(entries.len(), 3, "the abort row stays: {entries:?}");
        assert!(
            entries
                .iter()
                .any(|entry| matches!(entry, ChatEntry::Assistant(assistant) if assistant.aborted)),
            "the abort renders: {entries:?}"
        );
    }

    #[test]
    fn decodes_auto_retry_events() {
        let start = event_to_update(&json!({
            "type": "auto_retry_start",
            "attempt": 1,
            "maxAttempts": 2,
            "delayMs": 50,
            "errorMessage": "provider down",
        }))
        .expect("retry start maps");
        assert_eq!(
            start,
            TurnUpdate::AutoRetryStart {
                attempt: 1,
                max_attempts: 2,
                delay_ms: 50,
                error_message: "provider down".to_string(),
                reason: RetryStartReason::Quick,
            }
        );
        let backup = event_to_update(&json!({
            "type": "auto_retry_start",
            "attempt": 3,
            "maxAttempts": 5,
            "delayMs": 0,
            "errorMessage": "provider down",
            "reason": "backup",
            "backupModel": "prime-inference/glm-5.3",
        }))
        .expect("backup switch maps");
        assert_eq!(
            backup,
            TurnUpdate::AutoRetryStart {
                attempt: 3,
                max_attempts: 5,
                delay_ms: 0,
                error_message: "provider down".to_string(),
                reason: RetryStartReason::Backup {
                    backup_model: "prime-inference/glm-5.3".to_string()
                },
            }
        );
        let end = event_to_update(&json!({
            "type": "auto_retry_end",
            "success": false,
            "attempt": 2,
            "finalError": "provider down",
        }))
        .expect("retry end maps");
        assert_eq!(
            end,
            TurnUpdate::AutoRetryEnd {
                success: false,
                attempt: 2,
                final_error: Some("provider down".to_string()),
                restored_model: None,
            }
        );
        let settled = event_to_update(&json!({
            "type": "auto_retry_end",
            "success": true,
            "attempt": 2,
            "restoredModel": "prime-inference/glm-5.3",
        }))
        .expect("retry success maps");
        assert_eq!(
            settled,
            TurnUpdate::AutoRetryEnd {
                success: true,
                attempt: 2,
                final_error: None,
                restored_model: Some("prime-inference/glm-5.3".to_string()),
            }
        );
    }

    /// The python-kernel bootstrap's `starting` partials carry the loader
    /// note (the same stage text TS hands `setWorkingMessage`); streamed
    /// `ok` output and non-text payloads do not.
    #[test]
    fn loader_note_comes_from_starting_partials_only() {
        let booting = json!({
            "content": [
                { "type": "text", "text": "\u{203a} setting up python kernel (one-time, ~30s)\u{2026}" }
            ],
            "details": { "status": "starting" },
        });
        assert_eq!(
            working_message_from_update(&booting).as_deref(),
            Some("\u{203a} setting up python kernel (one-time, ~30s)\u{2026}")
        );
        let streamed = json!({
            "content": [{ "type": "text", "text": "visual parity ok" }],
            "details": { "status": "ok" },
        });
        assert_eq!(working_message_from_update(&streamed), None);
        let no_text = json!({
            "content": [],
            "details": { "status": "starting" },
        });
        assert_eq!(working_message_from_update(&no_text), None);
    }

    #[test]
    fn failed_assistant_message_end_maps_final() {
        let update = event_to_update(&json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "stopReason": "error",
                "errorMessage": "Provider server error",
                "content": [],
            },
        }))
        .expect("failed message_end maps");
        match update {
            TurnUpdate::AssistantMessage {
                streaming, message, ..
            } => {
                assert!(!streaming, "message_end is final");
                assert_eq!(message["stopReason"], "error");
            }
            other => panic!("unexpected update: {other:?}"),
        }
    }

    #[test]
    fn decodes_block_content() {
        let items = message_value_to_entries(&json!({
            "role": "user",
            "content": [{ "text": "hello " }, { "text": "world" }],
        }));
        assert_eq!(
            items,
            vec![ChatEntry::User {
                text: "hello world".to_string()
            }]
        );
        let items = message_value_to_entries(&json!({
            "role": "assistant",
            "content": [
                { "type": "thinking", "thinking": "hmm" },
                { "type": "text", "text": "working" },
                { "type": "toolCall", "id": "t1", "name": "bash", "arguments": { "command": "ls" } },
            ],
        }));
        assert_eq!(items.len(), 2);
        assert!(matches!(
            &items[0],
            ChatEntry::Assistant(m) if m.blocks.len() == 2 && m.has_tool_calls
        ));
        assert!(matches!(&items[1], ChatEntry::Tool(card) if card.name == "bash"));
    }

    #[test]
    fn decodes_streamed_events() {
        let user = event_to_update(&json!({
            "type": "message_start",
            "message": { "role": "user", "content": "go" },
        }))
        .unwrap();
        assert_eq!(user, TurnUpdate::UserMessage("go".to_string()));
        let partial = event_to_update(&json!({
            "type": "message_update",
            "message": { "role": "assistant", "content": "work" },
        }))
        .unwrap();
        assert!(matches!(
            &partial,
            TurnUpdate::AssistantMessage { message, streaming: true, .. } if message["content"] == "work"
        ));
        let final_message = event_to_update(&json!({
            "type": "message_end",
            "message": { "role": "assistant", "content": "done" },
        }))
        .unwrap();
        assert!(matches!(
            &final_message,
            TurnUpdate::AssistantMessage { message, streaming: false, .. } if message["content"] == "done"
        ));
        let ended = event_to_update(&json!({ "type": "turn_end" })).unwrap();
        assert_eq!(ended, TurnUpdate::TurnEnded { error: None });
        let failed = event_to_update(&json!({ "type": "turn_end", "error": "boom" })).unwrap();
        assert_eq!(
            failed,
            TurnUpdate::TurnEnded {
                error: Some("boom".to_string())
            }
        );
        assert_eq!(
            event_to_update(&json!({ "type": "agent_end" })),
            Some(TurnUpdate::Idle)
        );
    }

    #[test]
    fn session_command_rows_decode_once() {
        let echo = json!({
            "type": "message_start",
            "message": {
                "role": "custom",
                "customType": "session_slash_command",
                "content": "/goal ship it",
                "display": true,
                "details": { "command": { "name": "goal", "args": "ship it", "text": "/goal ship it" } },
            },
        });
        assert_eq!(
            event_to_update(&echo),
            Some(TurnUpdate::CustomRow(ChatEntry::SlashCommand {
                text: "/goal ship it".to_string()
            }))
        );
        // The closing frame of the pair must not duplicate the row.
        let end = json!({
            "type": "message_end",
            "message": echo["message"].clone(),
        });
        assert_eq!(event_to_update(&end), Some(TurnUpdate::StatusUpdate));

        let result = json!({
            "type": "message_start",
            "message": {
                "role": "custom",
                "customType": "session_slash_command_result",
                "content": "Goal active: ship it",
                "display": true,
                "details": {
                    "command": { "name": "goal", "args": "ship it", "text": "/goal ship it" },
                    "success": true, "severity": "info",
                },
            },
        });
        // The outcome row decodes as a system status row, never a user
        // block (the operator's 2026-09-25 ruling: command output is not
        // user text).
        assert_eq!(
            event_to_update(&result),
            Some(TurnUpdate::CustomRow(ChatEntry::Status {
                text: "Goal active: ship it".to_string(),
                kind: StatusKind::Info
            }))
        );
        // A failed command's outcome row carries the error tone.
        let failed = json!({
            "type": "message_start",
            "message": {
                "role": "custom",
                "customType": "session_slash_command_result",
                "content": "Command failed: boom",
                "display": true,
                "details": {
                    "command": { "name": "goal", "args": "clear", "text": "/goal clear" },
                    "success": false, "severity": "error",
                },
            },
        });
        assert_eq!(
            event_to_update(&failed),
            Some(TurnUpdate::CustomRow(ChatEntry::Status {
                text: "Command failed: boom".to_string(),
                kind: StatusKind::Error
            }))
        );
    }

    #[test]
    fn session_command_rows_respect_display_and_shape() {
        // Non-display rows (the refine result) render nothing.
        let hidden = json!({
            "role": "custom",
            "customType": "session_slash_command_result",
            "content": "Refined continual harness state: 1 edit applied.",
            "display": false,
        });
        assert!(custom_message_entries(&hidden).is_empty());
        // A displayed outcome row renders in the status-row class with
        // the severity's tone (the operator's 2026-09-25 ruling: command
        // output is system output, never user text).
        let outcome = json!({
            "role": "custom",
            "customType": "session_slash_command_result",
            "content": "Goal cleared.",
            "display": true,
            "details": {
                "command": { "name": "goal", "args": "clear", "text": "/goal clear" },
                "success": true, "severity": "info",
            },
        });
        assert_eq!(
            custom_message_entries(&outcome),
            vec![ChatEntry::Status {
                text: "Goal cleared.".to_string(),
                kind: StatusKind::Info,
            }]
        );
        // Unknown displayed custom types render the generic box (the TS
        // live dispatch fallthrough; harness digests persist with
        // display=false and render nothing).
        let other = json!({
            "role": "custom",
            "customType": "harness_digest",
            "content": "digest",
            "display": true,
        });
        assert!(matches!(
            custom_message_entries(&other).as_slice(),
            [ChatEntry::CustomPanel(_)]
        ));
        // A command row without command details renders the malformed
        // notice (TS `isSessionSlashCommandMessage` fallback).
        let malformed = json!({
            "role": "custom",
            "customType": "session_slash_command",
            "content": "/goal",
            "display": true,
            "details": {},
        });
        assert_eq!(
            custom_message_entries(&malformed),
            vec![ChatEntry::User {
                text: "[Malformed session command message]".to_string()
            }]
        );
    }

    /// A transcript with tool calls replays the way the TS attach does: the
    /// assistant's tool card stays pending until the matching
    /// `role: "toolResult"` message completes it; orphan results render
    /// nothing.
    #[test]
    fn transcript_replay_completes_tool_cards() {
        let transcript = [
            json!({ "role": "user", "content": "run it", "timestamp": 1 }),
            json!({
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "calling" },
                    { "type": "toolCall", "id": "call-1", "name": "ipython", "arguments": {"code": "1"} },
                ],
                "provider": "faux", "model": "faux-1",
                "usage": { "input": 10, "output": 2 }, "stopReason": "toolUse",
                "timestamp": 2,
            }),
            json!({
                "role": "toolResult",
                "toolCallId": "call-1",
                "toolName": "ipython",
                "content": [{ "type": "text", "text": "42" }],
                "details": { "durationMs": 3, "status": "ok" },
                "isError": false,
                "timestamp": 3,
            }),
            json!({
                "role": "toolResult",
                "toolCallId": "orphan",
                "toolName": "ipython",
                "content": [{ "type": "text", "text": "no card" }],
                "isError": false,
                "timestamp": 4,
            }),
            json!({
                "role": "assistant",
                "content": [{ "type": "text", "text": "done" }],
                "provider": "faux", "model": "faux-1",
                "usage": { "input": 10, "output": 2 }, "stopReason": "stop",
                "timestamp": 5,
            }),
        ];
        let chat = transcript_to_entries(&transcript);
        // user row, assistant text, tool card, final assistant text -
        // and the orphan result keeps its standalone card (the live
        // push path's twin; the rebuilt transcript never drops it).
        assert_eq!(chat.len(), 5, "chat: {chat:?}");
        let Some(ChatEntry::Tool(card)) = chat.get(2) else {
            panic!("tool card at index 2: {chat:?}");
        };
        assert!(card.started);
        assert!(!card.result_partial);
        let result = card.result.as_ref().expect("result replayed");
        assert_eq!(
            result.content,
            vec![json!({ "type": "text", "text": "42" })]
        );
        assert_eq!(result.details, json!({ "durationMs": 3, "status": "ok" }));
        assert!(!result.is_error);
        let Some(ChatEntry::Tool(orphan)) = chat.get(3) else {
            panic!("orphan card at its wire position (index 3): {chat:?}");
        };
        assert_eq!(orphan.id, "orphan");
        assert!(orphan.unmatched_result, "the orphan never joins a run");
    }

    /// A pending card (result absent) replays with no result, like a turn
    /// still in flight when the session was last persisted.
    #[test]
    fn transcript_replay_keeps_pending_cards_without_results() {
        let transcript = [
            json!({ "role": "user", "content": "run it", "timestamp": 1 }),
            json!({
                "role": "assistant",
                "content": [
                    { "type": "toolCall", "id": "call-1", "name": "ipython", "arguments": {} },
                ],
                "provider": "faux", "model": "faux-1",
                "usage": { "input": 10, "output": 2 }, "stopReason": "toolUse",
                "timestamp": 2,
            }),
        ];
        let chat = transcript_to_entries(&transcript);
        let Some(ChatEntry::Tool(card)) = chat.get(1) else {
            panic!("tool card at index 1: {chat:?}");
        };
        assert!(!card.started);
        assert!(card.result.is_none());
    }

    /// `Reconstructed::push_message` folds a late `toolResult` message onto
    /// the card an earlier chunk added (streamed snapshot reassembly).
    #[test]
    fn push_message_completes_pending_tool_card() {
        let mut reconstructed = Reconstructed::default();
        reconstructed.push_message(&json!({
            "role": "assistant",
            "content": [
                { "type": "toolCall", "id": "call-1", "name": "ipython", "arguments": {} },
            ],
            "provider": "faux", "model": "faux-1",
            "usage": { "input": 10, "output": 2 }, "stopReason": "toolUse",
            "timestamp": 2,
        }));
        reconstructed.push_message(&json!({
            "role": "toolResult",
            "toolCallId": "call-1",
            "toolName": "ipython",
            "content": [{ "type": "text", "text": "out" }],
            "isError": true,
            "timestamp": 3,
        }));
        assert_eq!(reconstructed.chat.len(), 1);
        let Some(ChatEntry::Tool(card)) = reconstructed.chat.first() else {
            panic!("single tool card: {:?}", reconstructed.chat);
        };
        let result = card.result.as_ref().expect("result applied");
        assert!(result.is_error);
        assert_eq!(
            result.content,
            vec![json!({ "type": "text", "text": "out" })]
        );
    }

    /// A provider-failure turn replays like the TS transcript: the healthy
    /// exchange renders once, and every failed retry attempt folds into its
    /// own error row (TS `buildConversationComponents` pushes one component
    /// per assistant message, even a content-less failure).
    #[test]
    fn transcript_replay_stacks_provider_failure_rows() {
        let failed_attempt = |timestamp: u64| {
            json!({
                "role": "assistant",
                "content": [],
                "provider": "prime-inference", "model": "mock-1",
                "stopReason": "error",
                "errorMessage": "Connection error.",
                "timestamp": timestamp,
            })
        };
        let transcript = [
            json!({ "role": "user", "content": "hello", "timestamp": 1 }),
            json!({
                "role": "assistant",
                "content": [{ "type": "text", "text": "battery hello from mock" }],
                "provider": "prime-inference", "model": "mock-1",
                "usage": { "input": 10, "output": 2 }, "stopReason": "stop",
                "timestamp": 2,
            }),
            json!({ "role": "user", "content": "again", "timestamp": 3 }),
            failed_attempt(4),
            failed_attempt(5),
            failed_attempt(6),
        ];
        let chat = transcript_to_entries(&transcript);
        // One user + reply, one user, then one entry per failed attempt.
        assert_eq!(chat.len(), 6, "chat: {chat:?}");
        let replies: Vec<&crate::chat::AssistantMessage> = chat
            .iter()
            .filter_map(|entry| match entry {
                ChatEntry::Assistant(message) => Some(message.as_ref()),
                _ => None,
            })
            .collect();
        assert_eq!(replies.len(), 4);
        assert_eq!(
            replies[0].blocks,
            vec![MessageBlock::Text("battery hello from mock".to_string())]
        );
        assert!(replies[0].error.is_none(), "the healthy reply stays clean");
        for row in &replies[1..] {
            assert!(row.blocks.is_empty());
            assert_eq!(
                row.error.as_deref(),
                Some("Error: Connection error."),
                "each failed attempt stacks its own error row"
            );
            assert!(!row.aborted);
        }
    }

    /// An aborted assistant message folds into its abort row even when the
    /// message streamed no content (TS renders the abort row always).
    #[test]
    fn transcript_replay_renders_contentless_abort() {
        let transcript = [
            json!({ "role": "user", "content": "hello", "timestamp": 1 }),
            json!({
                "role": "assistant",
                "content": [],
                "provider": "faux", "model": "faux-1",
                "stopReason": "aborted",
                "timestamp": 2,
            }),
        ];
        let chat = transcript_to_entries(&transcript);
        assert_eq!(chat.len(), 2, "chat: {chat:?}");
        let Some(ChatEntry::Assistant(message)) = chat.get(1) else {
            panic!("abort row: {chat:?}");
        };
        assert!(message.blocks.is_empty());
        assert_eq!(message.error.as_deref(), Some("Operation aborted"));
        assert!(message.aborted);
    }

    #[test]
    fn decodes_compaction_events() {
        // The start pair (TS `AgentSession.compact` event).
        assert_eq!(
            event_to_update(&json!({
                "type": "compaction_start",
                "reason": "manual",
                "customInstructions": "focus on the goal",
            })),
            Some(TurnUpdate::CompactionStart {
                reason: "manual".to_string(),
                custom_instructions: Some("focus on the goal".to_string()),
            })
        );
        assert_eq!(
            event_to_update(&json!({ "type": "compaction_start", "reason": "manual" })),
            Some(TurnUpdate::CompactionStart {
                reason: "manual".to_string(),
                custom_instructions: None,
            })
        );
        // Success carries the client-facing result.
        assert_eq!(
            event_to_update(&json!({
                "type": "compaction_end",
                "reason": "manual",
                "result": { "summary": "s", "firstKeptEntryId": "e1", "tokensBefore": 12 },
                "aborted": false,
                "willRetry": false,
                "customInstructions": "focus",
            })),
            Some(TurnUpdate::CompactionEnd {
                reason: "manual".to_string(),
                result: Some(
                    json!({ "summary": "s", "firstKeptEntryId": "e1", "tokensBefore": 12 })
                ),
                custom_instructions: Some("focus".to_string()),
                aborted: false,
                error_message: None,
                error_severity: None,
            })
        );
        // A skip carries the warning message; the result stays absent.
        assert_eq!(
            event_to_update(&json!({
                "type": "compaction_end",
                "reason": "manual",
                "aborted": false,
                "willRetry": false,
                "errorMessage": "Session is too short to compact",
                "errorSeverity": "warning",
            })),
            Some(TurnUpdate::CompactionEnd {
                reason: "manual".to_string(),
                result: None,
                custom_instructions: None,
                aborted: false,
                error_message: Some("Session is too short to compact".to_string()),
                error_severity: Some("warning".to_string()),
            })
        );
        // A summary delta carries its text chunk verbatim (the live
        // streamed block's input; the settling end stays the summary's
        // only durable source).
        assert_eq!(
            event_to_update(&json!({
                "type": "compaction_summary_delta",
                "delta": "The session covered the goal.",
            })),
            Some(TurnUpdate::CompactionSummaryDelta {
                delta: "The session covered the goal.".to_string(),
            })
        );
        // A missing delta field decodes as an empty chunk, never a drop
        // (the accumulation stays a pure append — the frame is real).
        assert_eq!(
            event_to_update(&json!({ "type": "compaction_summary_delta" })),
            Some(TurnUpdate::CompactionSummaryDelta {
                delta: String::new(),
            })
        );
    }

    #[test]
    fn transcript_replay_renders_the_compaction_outcome_row() {
        // A skipped auto-compaction warns (TS `CompactionOutcomeMessageComponent`).
        let items = message_value_to_entries(&json!({
            "role": "custom",
            "customType": "compaction_outcome",
            "content": "Auto-compaction skipped: not enough context",
            "display": true,
            "details": { "reason": "threshold", "outcome": "skipped" },
        }));
        assert_eq!(
            items,
            vec![ChatEntry::Status {
                text: "Auto-compaction skipped: not enough context".to_string(),
                kind: StatusKind::Warning,
            }]
        );
        // A failed overflow recovery errors.
        let items = message_value_to_entries(&json!({
            "role": "custom",
            "customType": "compaction_outcome",
            "content": "Context overflow recovery failed: boom",
            "display": true,
            "details": { "reason": "overflow", "outcome": "failed" },
        }));
        assert!(matches!(
            &items[0],
            ChatEntry::Status { kind: StatusKind::Error, text }
                if text == "Context overflow recovery failed: boom"
        ));
        // A cancelled compaction errors too (TS: only `skipped` warns).
        let items = message_value_to_entries(&json!({
            "role": "custom",
            "customType": "compaction_outcome",
            "content": "Compaction cancelled",
            "display": true,
            "details": { "reason": "threshold", "outcome": "cancelled" },
        }));
        assert!(matches!(
            &items[0],
            ChatEntry::Status { kind: StatusKind::Error, text }
                if text == "Compaction cancelled"
        ));
        // An envelope TS `isCompactionOutcomeMessage` rejects renders the
        // malformed notice (invalid reason and outcome both).
        for details in [
            json!({ "reason": "manual", "outcome": "skipped" }),
            json!({ "reason": "threshold", "outcome": "compacted" }),
            json!({}),
        ] {
            let items = message_value_to_entries(&json!({
                "role": "custom",
                "customType": "compaction_outcome",
                "content": "text",
                "display": true,
                "details": details,
            }));
            assert_eq!(
                items,
                vec![ChatEntry::Status {
                    text: "[Malformed compaction outcome message]".to_string(),
                    kind: StatusKind::Error,
                }]
            );
        }
    }

    #[test]
    fn transcript_replay_renders_the_compaction_summary() {
        // The attach snapshot's `role: "compactionSummary"` message (the
        // session store's fold) renders the summary row with its fields.
        let items = message_value_to_entries(&json!({
            "role": "compactionSummary",
            "summary": "the story so far",
            "tokensBefore": 1234,
            "retainedMessageCount": 2,
            "customInstructions": "tests",
            "timestamp": 1,
        }));
        assert_eq!(items.len(), 1);
        assert!(matches!(
            &items[0],
            ChatEntry::CompactionSummary { summary, tokens_before, custom_instructions }
            if summary == "the story so far"
                && *tokens_before == 1234
                && custom_instructions.as_deref() == Some("tests")
        ));
    }

    /// A settled content-less assistant message renders nothing (TS: the
    /// component's rows are empty and spacing stays `hidden`).
    #[test]
    fn transcript_replay_skips_contentless_settled_messages() {
        let items = message_value_to_entries(&json!({
            "role": "assistant",
            "content": [],
            "stopReason": "stop",
        }));
        assert_eq!(items, Vec::new());
        // A provider error beside tool calls renders no message row either:
        // the cards carry the failure.
        let items = message_value_to_entries(&json!({
            "role": "assistant",
            "content": [
                { "type": "toolCall", "id": "t1", "name": "bash", "arguments": { "command": "ls" } },
            ],
            "stopReason": "error",
            "errorMessage": "Connection error.",
        }));
        assert_eq!(items.len(), 1);
        assert!(matches!(&items[0], ChatEntry::Tool(card) if card.name == "bash"));
    }

    /// A `goal_update` event decodes to the wire goal payload (the session
    /// view owns announcement and tray rendering).
    #[test]
    fn goal_update_decodes_the_goal_payload() {
        let update = event_to_update(&json!({
            "type": "goal_update",
            "goal": {
                "active": false,
                "status": "complete",
                "goalId": "g-1",
                "objective": "ship it",
                "tokensUsed": 120,
                "timeUsedSeconds": 3,
                "continuationsUsed": 2,
                "lastReason": "Goal achieved"
            }
        }))
        .unwrap();
        let TurnUpdate::GoalUpdate(goal) = update else {
            panic!("expected a goal update");
        };
        let goal: pa_types::goal::GoalState = serde_json::from_value(goal).unwrap();
        assert_eq!(goal.status, pa_types::goal::GoalStatus::Complete);
        assert_eq!(goal.objective.as_deref(), Some("ship it"));
        assert_eq!(goal.last_reason.as_deref(), Some("Goal achieved"));
    }

    /// The attach snapshot's `state.goal` rehydrates with the session (TS
    /// `snapshot.ts: goal: session.goalState`); a null goal stays absent.
    #[test]
    fn attach_snapshot_carries_the_goal_state() {
        let attach = json!({
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "activeSessionId": "abc123def456",
            "snapshot": {
                "activeSessionId": "abc123def456",
                "summary": { "id": "abc123def456", "cwd": "/tmp" },
                "state": {
                    "activeSessionId": "abc123def456",
                    "cwd": "/tmp",
                    "sessionId": "0199-sess",
                    "model": null,
                    "thinkingLevel": "default",
                    "serviceTier": "auto",
                    "isStreaming": false,
                    "isCompacting": false,
                    "retryAttempt": 0,
                    "steeringMode": "all",
                    "followUpMode": "all",
                    "autoCompactionEnabled": false,
                    "messageCount": 0,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                    "compactionCount": 0,
                    "goal": {
                        "active": true,
                        "status": "active",
                        "objective": "keep shipping",
                        "tokensUsed": 10,
                        "timeUsedSeconds": 1,
                        "continuationsUsed": 0
                    },
                    "scopedModels": [],
                    "activeToolNames": []
                },
                "messages": [],
                "lastEventSequence": 3,
                "lastEventCursor": { "generation": 1, "sequence": 3 }
            },
            "lastEventSequence": 3
        });
        let data = attach_data_from_response(attach).unwrap();
        let reconstructed = reconstruct(&data);
        let goal = reconstructed.goal.expect("snapshot goal");
        assert_eq!(goal.status, pa_types::goal::GoalStatus::Active);
        assert_eq!(goal.objective.as_deref(), Some("keep shipping"));
    }
}
