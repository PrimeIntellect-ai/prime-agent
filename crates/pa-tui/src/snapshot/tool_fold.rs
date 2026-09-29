//! The live tool-card fold (the streamed tool-call card lifecycle: create-on-identify,
//! settle on execution start/end, the failed-frame sweep) and the assistant
//! message decode family (the ordered visible parts, the error rows, the
//! superseded-attempt ruling) - moved with their concern.
use super::{AssistantMessage, ChatEntry, MessageBlock, ToolCallCard, ToolResultView, Value};

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
pub fn settle_pending_tool_cards<S: std::hash::BuildHasher + Default>(
    view: &mut crate::view::AgentView,
    pending: &mut std::collections::HashSet<String, S>,
    aborted: &mut std::collections::HashSet<String, S>,
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
#[must_use]
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
#[must_use]
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
    for (id, name, args) in tool_calls {
        entries.push(ChatEntry::Tool(Box::new(ToolCallCard {
            id,
            name,
            args,
            started: false,
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
