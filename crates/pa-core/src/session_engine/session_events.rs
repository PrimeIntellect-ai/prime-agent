//! The TS `session_event` wire shape of one agent-loop event.
//!
//! Shared by every host that surfaces raw loop events the way the TS
//! product does (the json print stream's per-line events and the RPC
//! mode's forwarded session events): one serializer, one source of truth
//! for the wire shape.

use pa_agent::stream::AssistantMessageEvent;
use pa_agent::types::AgentEvent;

use super::provider_adapter::json_round_trip;

/// The wire shape of one streaming delta (the TS `AssistantMessageEvent`
/// as the daemon wire carries it: `partial` dropped — the partial
/// assistant message rides the event's `message` field already). Terminal
/// `start`/`done`/`error` events never ride a `message_update` (the loop
/// emits `message_start`/`message_end` for those), so they map to `None`.
pub fn assistant_message_event_json(event: &AssistantMessageEvent) -> Option<serde_json::Value> {
    use pa_agent::stream::AssistantMessageEvent as StreamEvent;
    Some(match event {
        StreamEvent::TextStart { content_index, .. } => serde_json::json!({
            "type": "text_start",
            "contentIndex": content_index,
        }),
        StreamEvent::TextDelta {
            content_index,
            delta,
            ..
        } => serde_json::json!({
            "type": "text_delta",
            "contentIndex": content_index,
            "delta": delta,
        }),
        StreamEvent::TextEnd {
            content_index,
            content,
            ..
        } => serde_json::json!({
            "type": "text_end",
            "contentIndex": content_index,
            "content": content,
        }),
        StreamEvent::ThinkingStart { content_index, .. } => serde_json::json!({
            "type": "thinking_start",
            "contentIndex": content_index,
        }),
        StreamEvent::ThinkingDelta {
            content_index,
            delta,
            ..
        } => serde_json::json!({
            "type": "thinking_delta",
            "contentIndex": content_index,
            "delta": delta,
        }),
        StreamEvent::ThinkingEnd {
            content_index,
            partial,
            ..
        } => serde_json::json!({
            "type": "thinking_end",
            "contentIndex": content_index,
            "content": thinking_block_text(partial, *content_index),
        }),
        StreamEvent::ToolCallStart { content_index, .. } => serde_json::json!({
            "type": "toolcall_start",
            "contentIndex": content_index,
        }),
        StreamEvent::ToolCallDelta {
            content_index,
            delta,
            ..
        } => serde_json::json!({
            "type": "toolcall_delta",
            "contentIndex": content_index,
            "delta": delta,
        }),
        StreamEvent::ToolCallEnd {
            content_index,
            tool_call,
            ..
        } => {
            // The TS tool-call block carries its `type: "toolCall"` tag in
            // the event payload.
            let mut value = serde_json::json!({
                "type": "toolCall",
                "id": tool_call.id,
                "name": tool_call.name,
                "arguments": tool_call.arguments,
            });
            if let Some(signature) = &tool_call.thought_signature {
                value["thoughtSignature"] = serde_json::json!(signature);
            }
            serde_json::json!({
                "type": "toolcall_end",
                "contentIndex": content_index,
                "toolCall": value,
            })
        }
        StreamEvent::Start { .. } | StreamEvent::Done { .. } | StreamEvent::Error { .. } => {
            return None;
        }
    })
}

/// The thinking text of one partial message block (the loop's thinking-end
/// event drops the content when the pa-ai event crosses the crate
/// boundary; the partial still carries the accumulated text).
fn thinking_block_text(
    partial: &pa_agent::types::AssistantMessage,
    content_index: usize,
) -> String {
    partial
        .content
        .get(content_index)
        .map(|block| match block {
            pa_agent::types::AssistantContent::Thinking(thinking) => thinking.thinking.clone(),
            _ => String::new(),
        })
        .unwrap_or_default()
}

/// Serialize one loop event to the TS `session_event` wire shape.
pub fn agent_event_json(event: &AgentEvent) -> Option<String> {
    fn message_value(value: &pa_agent::types::AgentMessage) -> serde_json::Value {
        json_round_trip(value).unwrap_or(serde_json::Value::Null)
    }
    let value = match event {
        AgentEvent::AgentStart => serde_json::json!({ "type": "agent_start" }),
        AgentEvent::AgentEnd { messages } => serde_json::json!({
            "type": "agent_end",
            "messages": messages.iter().map(message_value).collect::<Vec<_>>(),
        }),
        AgentEvent::TurnStart => serde_json::json!({ "type": "turn_start" }),
        AgentEvent::TurnEnd {
            message,
            tool_results,
        } => serde_json::json!({
            "type": "turn_end",
            "message": message_value(message),
            "toolResults": tool_results.iter().map(|r| json_round_trip(r).unwrap_or(serde_json::Value::Null)).collect::<Vec<_>>(),
        }),
        AgentEvent::MessageStart { message: m } => serde_json::json!({
            "type": "message_start",
            "message": message_value(m),
        }),
        AgentEvent::MessageUpdate {
            message,
            assistant_message_event,
        } => {
            // The TS wire carries the slimmed delta event (the daemon drops
            // the nested `partial` copy; `message` already carries it).
            let delta = assistant_message_event_json(assistant_message_event)?;
            serde_json::json!({
                "type": "message_update",
                "message": message_value(message),
                "assistantMessageEvent": delta,
            })
        }
        AgentEvent::MessageEnd { message: m } => serde_json::json!({
            "type": "message_end",
            "message": message_value(m),
        }),
        AgentEvent::ToolExecutionStart {
            tool_call_id,
            tool_name,
            args,
        } => serde_json::json!({
            "type": "tool_execution_start",
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "args": args,
        }),
        AgentEvent::ToolExecutionUpdate {
            tool_call_id,
            tool_name,
            args,
            partial_result,
        } => serde_json::json!({
            "type": "tool_execution_update",
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "args": args,
            "partialResult": json_round_trip(partial_result).unwrap_or(serde_json::Value::Null),
        }),
        AgentEvent::ToolExecutionEnd {
            tool_call_id,
            tool_name,
            result,
            ..
        } => serde_json::json!({
            "type": "tool_execution_end",
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "result": json_round_trip(result).unwrap_or(serde_json::Value::Null),
        }),
    };
    Some(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_agent::stream::AssistantMessageEvent;
    use pa_agent::types::{
        AgentEvent, AgentMessage, AssistantContent, AssistantMessage, TextContent, ToolCall, Usage,
    };

    /// A minimal partial assistant message (the faux wire fields).
    fn partial(content: Vec<AssistantContent>) -> AssistantMessage {
        AssistantMessage {
            content,
            api: "faux".to_string(),
            provider: "faux".to_string(),
            model: "faux-1".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::zero(),
            stop_reason: pa_agent::types::StopReason::Stop,
            error_message: None,
            stop_reason_raw: None,
            timestamp: 0,
        }
    }

    /// The `message_update` event wraps the partial message plus the slim
    /// delta, in the TS field order.
    #[test]
    fn message_update_event_json_wraps_the_partial_and_delta() {
        let message = partial(vec![AssistantContent::Text(TextContent {
            text: "first reply".to_string(),
            text_signature: None,
        })]);
        let event = AgentEvent::MessageUpdate {
            message: AgentMessage::Standard(pa_agent::types::Message::Assistant(message.clone())),
            assistant_message_event: Box::new(AssistantMessageEvent::TextDelta {
                content_index: 0,
                delta: "first reply".to_string(),
                partial: message,
            }),
        };
        let json = agent_event_json(&event).expect("a message_update json line");
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["type"], "message_update");
        assert_eq!(value["message"]["role"], "assistant");
        assert_eq!(value["message"]["content"][0]["text"], "first reply");
        assert_eq!(
            value["assistantMessageEvent"],
            serde_json::json!({"type": "text_delta", "contentIndex": 0, "delta": "first reply"})
        );
    }
    /// The wire shapes of the streaming deltas (TS `AssistantMessageEvent`
    /// as the daemon wire carries it — no nested `partial` copy).
    #[test]
    fn assistant_message_event_wire_shapes_match_ts() {
        let message = partial(Vec::new());
        let cases: Vec<(AssistantMessageEvent, serde_json::Value)> = vec![
            (
                AssistantMessageEvent::TextStart {
                    content_index: 0,
                    partial: message.clone(),
                },
                serde_json::json!({"type": "text_start", "contentIndex": 0}),
            ),
            (
                AssistantMessageEvent::TextDelta {
                    content_index: 0,
                    delta: "first reply".to_string(),
                    partial: message.clone(),
                },
                serde_json::json!({
                    "type": "text_delta",
                    "contentIndex": 0,
                    "delta": "first reply",
                }),
            ),
            (
                AssistantMessageEvent::TextEnd {
                    content_index: 0,
                    content: "first reply".to_string(),
                    partial: message.clone(),
                },
                serde_json::json!({
                    "type": "text_end",
                    "contentIndex": 0,
                    "content": "first reply",
                }),
            ),
            (
                AssistantMessageEvent::ThinkingStart {
                    content_index: 1,
                    partial: message.clone(),
                },
                serde_json::json!({"type": "thinking_start", "contentIndex": 1}),
            ),
            (
                AssistantMessageEvent::ThinkingDelta {
                    content_index: 1,
                    delta: "think".to_string(),
                    partial: message.clone(),
                },
                serde_json::json!({
                    "type": "thinking_delta",
                    "contentIndex": 1,
                    "delta": "think",
                }),
            ),
            (
                AssistantMessageEvent::ThinkingEnd {
                    content_index: 1,
                    partial: partial(vec![
                        AssistantContent::Text(TextContent {
                            text: "answer".to_string(),
                            text_signature: None,
                        }),
                        AssistantContent::Thinking(pa_agent::types::ThinkingContent {
                            thinking: "the reasoning".to_string(),
                            thinking_signature: None,
                            redacted: None,
                        }),
                    ]),
                },
                serde_json::json!({
                    "type": "thinking_end",
                    "contentIndex": 1,
                    "content": "the reasoning",
                }),
            ),
            (
                AssistantMessageEvent::ToolCallStart {
                    content_index: 0,
                    partial: message.clone(),
                },
                serde_json::json!({"type": "toolcall_start", "contentIndex": 0}),
            ),
            (
                AssistantMessageEvent::ToolCallDelta {
                    content_index: 0,
                    delta: r#"{"code""#.to_string(),
                    partial: message.clone(),
                },
                serde_json::json!({
                    "type": "toolcall_delta",
                    "contentIndex": 0,
                    "delta": "{\"code\"",
                }),
            ),
            (
                AssistantMessageEvent::ToolCallEnd {
                    content_index: 0,
                    tool_call: ToolCall {
                        id: "call-1".to_string(),
                        name: "ipython".to_string(),
                        arguments: serde_json::json!({"code": "1 + 1"}),
                        thought_signature: None,
                    },
                    partial: message.clone(),
                },
                serde_json::json!({
                    "type": "toolcall_end",
                    "contentIndex": 0,
                    "toolCall": {
                        "type": "toolCall",
                        "id": "call-1",
                        "name": "ipython",
                        "arguments": {"code": "1 + 1"},
                    },
                }),
            ),
        ];
        for (event, expected) in cases {
            assert_eq!(
                assistant_message_event_json(&event).as_ref(),
                Some(&expected),
                "wire shape of {event:?}"
            );
        }
        // Terminal events never ride a message_update.
        assert!(assistant_message_event_json(&AssistantMessageEvent::Start {
            partial: message.clone(),
        })
        .is_none());
        assert!(assistant_message_event_json(&AssistantMessageEvent::Done {
            reason: pa_agent::types::StopReason::Stop,
            message: message.clone(),
        })
        .is_none());
        assert!(assistant_message_event_json(&AssistantMessageEvent::Error {
            reason: pa_agent::types::StopReason::Error,
            error: message,
        })
        .is_none());
    }
}
