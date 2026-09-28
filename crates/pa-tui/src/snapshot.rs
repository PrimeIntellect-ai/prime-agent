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
    /// The current model's provider (`state.model.provider`), when the
    /// session reports one: the picker resolves the current-model catalog
    /// entry by provider plus id, so a same-id entry under another
    /// provider never wins (older daemons report no provider).
    pub model_provider: Option<String>,
    /// The tray effort suffix for that model (TS `getModelContextLabel`),
    /// when the state's model carries its reasoning level.
    pub thinking_suffix: Option<String>,
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
    let (model_id, model_provider) = state
        .and_then(|state| state.get("model"))
        .and_then(model_identity_value)
        .map_or((None, None), |(id, provider)| (Some(id), provider));
    let thinking_suffix = state.and_then(crate::chrome::tray_thinking_suffix);
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
        model_provider,
        thinking_suffix,
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

/// The model id and provider from a `state.model` wire value
/// (`{id, provider}` or a display string): the provider is `None` for the
/// display-string form and the object form that omits it (older daemons),
/// and the whole identity is `None` when no id parses — a provider
/// without an id matches nothing in the catalog.
fn model_identity_value(model: &Value) -> Option<(String, Option<String>)> {
    match model {
        Value::String(label) => Some((label.clone(), None)),
        Value::Object(map) => {
            let id = map.get("id").and_then(Value::as_str)?;
            let provider = map
                .get("provider")
                .and_then(Value::as_str)
                .map(str::to_string);
            Some((id.to_string(), provider))
        }
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
        Some(Value::Array(blocks)) => blocks.iter().filter_map(block_text).collect::<String>(),
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

pub use tool_fold::{
    apply_streamed_tool_card, apply_tool_execution_start, assistant_error_row,
    assistant_message_parts, assistant_value_to_entries, is_superseded_attempt_row,
    settle_pending_tool_cards, AssistantErrorRow,
};
mod tool_fold;

#[cfg(test)]
mod tests;
