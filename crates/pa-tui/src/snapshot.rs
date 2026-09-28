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
                        // An orphan keeps its own standalone row
                        // (it is not a call).
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
    /// an existing field the orphan card's own duration rows read - no
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

pub use decoder::{
    custom_message_entries, event_to_update, message_text, message_value_to_entries,
    user_display_text, working_message_from_update, RetryStartReason, TurnUpdate,
};
mod decoder;

pub use tool_fold::{
    apply_streamed_tool_card, apply_tool_execution_start, assistant_error_row,
    assistant_message_parts, assistant_value_to_entries, is_superseded_attempt_row,
    settle_pending_tool_cards, AssistantErrorRow,
};
mod tool_fold;

#[cfg(test)]
mod tests;
