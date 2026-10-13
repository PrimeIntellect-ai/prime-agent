//! The live tool-card fold (create-on-identify, settle on execution
//! start/end, the failed-frame sweep) and the assistant message decode
//! family.
use super::{AssistantMessage, ChatEntry, MessageBlock, ToolCallCard, ToolResultView, Value};

/// Fold one streamed tool call into the live transcript: a card is only
/// created once the call is identifiable AND named — the wire `toolCall`
/// block first arrives with an empty `name`, and a card created earlier
/// would carry it forever and render the raw arguments JSON. An existing
/// card refreshes from the latest frame; a settled card is not a match.
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
/// settles with the failure text and drops late result frames
/// (`resetPendingToolState` cleared the pending map).
pub fn settle_pending_tool_cards<S: std::hash::BuildHasher + Default>(
    view: &mut crate::view::AgentView,
    pending: &mut std::collections::HashSet<String, S>,
    aborted: &mut std::collections::HashSet<String, S>,
    text: &str,
) {
    for tool_call_id in pending.drain() {
        // Every drained id records as aborted — late frames for a call
        // that never created a card land on nothing the same way.
        aborted.insert(tool_call_id.clone());
        // The settle targets the newest card carrying the id; the older
        // settled card keeps the previous sweep's result.
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

/// `tool_execution_start` folded into the live transcript: mark the
/// matching card running, or create it when the assistant-message frames
/// have not arrived yet (the daemon-reported tool name backfills an
/// empty streamed name). A settled card is not a match: a reused id
/// gets a fresh card.
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
/// `AssistantMessageComponent.rebuild`): an abort always shows; a
/// provider `error` only without tool calls.
pub struct AssistantErrorRow {
    /// The rendered row text (provider errors carry the `Error: ` prefix).
    pub text: String,
    /// `stopReason: "aborted"` (drives the tool-call trailing spacer).
    pub aborted: bool,
}

/// The failed-attempt error row a retry supersedes (SANCTIONED
/// DIVERGENCE, operator ruling 2026-09-23): an error-only assistant
/// entry, no blocks, no tool calls, not an abort.
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
    // The component exists for every assistant message, so a
    // content-less failed provider attempt still folds into its own
    // error row.
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
