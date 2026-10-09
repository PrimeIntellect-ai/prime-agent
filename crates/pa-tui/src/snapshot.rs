//! Attach/snapshot reconstruction: wire data from the daemon (slim
//! attach results, streamed session events) folded into UI transcript
//! items. Decoding is lenient — plain-string or block content, with or
//! without `type` tags — because the harness and the real engine both emit.

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
    /// The current model's provider (`state.model.provider`): the
    /// picker matches by provider plus id.
    pub model_provider: Option<String>,
    /// The tray effort suffix for that model, when the state's model
    /// carries its reasoning level.
    pub thinking_suffix: Option<String>,
    /// The tray's context usage (`state.contextUsage`): the snapshot
    /// feeds the first frame's tray row without a stats round-trip.
    /// `None` clears the tray display.
    pub context_usage: Option<crate::chrome::ContextUsage>,
    pub session_name: Option<String>,
    /// Session id of the persisted session file.
    pub session_id: String,
    /// The attach cursor's worker generation (`view::handoff` key): a
    /// restarted worker's sequence restarts, so the generation must match.
    pub event_generation: String,
    /// The session's goal state (`state.goal`), when the snapshot
    /// reports one.
    pub goal: Option<pa_types::goal::GoalState>,
    pub last_event_sequence: u64,
    /// Whether the attach supplied the resume cursor (sequence AND
    /// generation): the handoff refuses to key on the collapsed
    /// defaults of an absent cursor (`view::handoff`).
    pub cursor_present: bool,
    /// The queued input parked behind the run (`state.sessionActions`);
    /// TS re-reads after subscribe because a `session_action_update`
    /// in the gap is lost.
    pub queued: crate::queued::QueuedMessages,
    /// The LAST HUMAN PROMPT's wall-clock time (unix ms): the newest
    /// user message's `timestamp`; the rebuilt loader anchors its
    /// elapsed clock here (the operator's 2026-09-28 rule: the timer
    /// never resets on a view transition). `None` keeps the
    /// re-attach-instant anchor.
    pub last_user_prompt_ms: Option<u64>,
    /// The session's effective service tier (`state.serviceTier`), the
    /// `/fast` toggle's baseline.
    pub service_tier: Option<String>,
    pub history_before: usize,
    pub(crate) backfill_seam: BackfillSeam,
}

impl Reconstructed {
    /// Fold one raw message into the chat entries: a `toolResult` that
    /// completes a pending card adds no row; an unmatched one keeps its
    /// standalone orphan card.
    pub fn push_message(&mut self, message: &Value) {
        if let Some(result) = tool_result_message_view(message) {
            if let Some(view) = apply_tool_result(&mut self.chat, result) {
                self.chat
                    .push(ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
                        id: view.id,
                        name: view.name,
                        args: serde_json::Value::Null,
                        started: true,
                        result: Some(view.view),
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
    })
}

/// Complete the first pending card matching the result's tool call id;
/// an unmatched result comes back whole for the caller's orphan card.
fn apply_tool_result(chat: &mut [ChatEntry], result: ToolResultReplay) -> Option<OrphanResult> {
    let ToolResultReplay {
        tool_call_id,
        tool_name,
        view,
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
    })
}

/// An unmatched replay result: keeps its standalone card.
struct OrphanResult {
    id: String,
    name: String,
    view: crate::chat::ToolResultView,
}

/// The wire context is summary-first for the model, but the transcript
/// presents the compaction summary at its chronological boundary — after
/// the retained messages (`retainedMessageCount`). A missing count falls
/// back to the timestamp split (pre-count summaries).
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

/// Replay a whole transcript, folding `toolResult` messages onto their
/// pending cards; one id-to-index map keeps the fold linear.
pub fn transcript_to_entries(messages: &[Value]) -> Vec<ChatEntry> {
    transcript_with_backfill_seam(messages).0
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) enum BackfillSeam {
    #[default]
    Preserve,
    RetryOutcome,
}

fn transcript_with_backfill_seam(messages: &[Value]) -> (Vec<ChatEntry>, BackfillSeam) {
    let ordered = order_messages_for_transcript(messages);
    let mut seam = BackfillSeam::Preserve;
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
                // No pending card took the result (a true orphan or a
                // leftover settle): it keeps a standalone card at its
                // own wire position, like the live path.
                chat.push(orphan_card(result));
            }
            continue;
        }
        // The retry-episode collapse (SANCTIONED DIVERGENCE, operator
        // ruling 2026-09-23): a `provider_retry_outcome` row replaces
        // the per-attempt error rows TS renders; the superseded rows sit
        // at the tail, and the collapse never touches tool cards.
        if message.get("role").and_then(Value::as_str) == Some("custom")
            && message.get("customType").and_then(Value::as_str)
                == Some(crate::custom_message::PROVIDER_RETRY_OUTCOME_CUSTOM_TYPE)
        {
            pop_superseded_attempts(&mut chat);
            if chat.is_empty() {
                // This outcome also supersedes attempts in the omitted prefix.
                seam = BackfillSeam::RetryOutcome;
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
    (chat, seam)
}

/// Settle one result onto the LAST pending card among `indices` (the
/// live `rposition`); `Some(result)` hands it back for orphan handling.
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
    } = result;
    if let Some(ChatEntry::Tool(card)) = chat.get_mut(index) {
        card.started = true;
        let now = std::time::Instant::now();
        card.started_at = Some(now);
        card.ended_at = Some(now);
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
    } = result;
    ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
        id: tool_call_id,
        name: tool_name,
        args: serde_json::Value::Null,
        started: true,
        result: Some(view),
        ..Default::default()
    }))
}

fn pop_superseded_attempts(chat: &mut Vec<ChatEntry>) {
    while chat.last().is_some_and(is_superseded_attempt_row) {
        chat.pop();
    }
}

pub(crate) fn join_backfilled_entries(head: &mut Vec<ChatEntry>, seam: BackfillSeam) {
    if matches!(seam, BackfillSeam::RetryOutcome) {
        pop_superseded_attempts(head);
    }
}

pub fn reconstruct(attach: &AttachData) -> Reconstructed {
    let snapshot = &attach.snapshot;
    let (messages, backfill_seam) = snapshot
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| transcript_with_backfill_seam(messages))
        .unwrap_or_default();
    let state = snapshot.get("state");
    let (model_id, model_provider) = state
        .and_then(|state| state.get("model"))
        .and_then(model_identity_value)
        .map_or((None, None), |(id, provider)| (Some(id), provider));
    let thinking_suffix = state.and_then(crate::chrome::tray_thinking_suffix);
    let context_usage = state
        .and_then(|state| state.get("contextUsage"))
        .and_then(crate::chrome::ContextUsage::from_wire);
    let session_name = state
        .and_then(|state| state.get("sessionName"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let session_id = state
        .and_then(|state| state.get("sessionId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let snapshot_sequence = snapshot.get("lastEventSequence").and_then(Value::as_u64);
    let last_event_sequence = snapshot_sequence
        .or(attach.last_event_sequence)
        .unwrap_or_default();
    let event_generation = attach
        .last_event_cursor
        .as_ref()
        .map(|cursor| cursor.generation.clone())
        .or_else(|| {
            snapshot
                .get("lastEventCursor")
                .and_then(|cursor| cursor.get("generation"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    let cursor_present = (snapshot_sequence.is_some() || attach.last_event_sequence.is_some())
        && !event_generation.is_empty()
        && !session_id.is_empty();
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
            .map(|actions| queue_lane_indices(actions, "rlmChildStatus"))
            .unwrap_or_default(),
        injected_prompts: actions
            .as_ref()
            .map(|actions| queue_lane_indices(actions, "injectedPrompts"))
            .unwrap_or_default(),
    };

    let service_tier = state
        .and_then(|state| state.get("serviceTier"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let history_before = snapshot
        .get("historyBefore")
        .and_then(Value::as_u64)
        .map_or(0, |history| history as usize);
    let last_user_prompt_ms = if history_before > 0 {
        snapshot.get("lastUserPromptMs").and_then(Value::as_u64)
    } else {
        snapshot
            .get("messages")
            .and_then(Value::as_array)
            .and_then(|messages| {
                messages
                    .iter()
                    .rev()
                    .find(|message| {
                        message.get("role").and_then(Value::as_str) == Some("user")
                            && message_timestamp_ms(message).is_some()
                    })
                    .and_then(message_timestamp_ms)
            })
    };
    Reconstructed {
        chat: messages,
        model_id,
        model_provider,
        thinking_suffix,
        context_usage,
        session_name,
        session_id,
        event_generation,
        goal,
        last_event_sequence,
        cursor_present,
        queued,
        service_tier,
        last_user_prompt_ms,
        history_before,
        backfill_seam,
    }
}

/// One message's wall-clock timestamp (unix ms): the wire's numeric
/// `timestamp` (u64 or f64) or an ISO-8601 string. `None` when the
/// message carries no readable time.
fn message_timestamp_ms(message: &Value) -> Option<u64> {
    match message.get("timestamp") {
        Some(Value::Number(number)) => number.as_u64().or_else(|| {
            number
                .as_f64()
                .filter(|value| value.is_finite())
                .map(|value| value.max(0.0) as u64)
        }),
        Some(Value::String(iso)) => {
            let ms = crate::agents_view_state::timestamp_ms(Some(iso));
            (ms > 0).then_some(ms as u64)
        }
        _ => None,
    }
}

/// The preparing-turn label of a `sessionActions` wire value, or `None`
/// when none is preparing (TS #2063): the prompt left its lane at
/// pickup, so the strip shows it until the turn renders it.
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

/// One typed-provenance rider of a `sessionActions` wire value
/// (Rust-native, no TS counterpart): `rlmChildStatus` marks the parked
/// child-status notices, `injectedPrompts` the engine-minted
/// continuations; a projection without marks omits the rider.
fn queue_lane_indices(actions: &Value, rider: &str) -> crate::queued::QueueLaneIndices {
    let indices = |lane: &str| {
        actions
            .get(rider)
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
    crate::queued::QueueLaneIndices {
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

/// The model id and provider from a `state.model` wire value (`{id,
/// provider}` or a display string); the provider is `None` for the
/// display-string form and an object that omits it.
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
/// Returns `Err` when the payload does not decode into `AttachData`.
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
