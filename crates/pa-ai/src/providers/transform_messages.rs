//! Message normalization shared by providers.

use std::collections::{HashMap, HashSet};

use serde_json::Map;

use crate::types::{
    AssistantContent, AssistantMessage, Message, Model, ModelExt, StopReason, TextContent,
    ToolCall, ToolResultMessage, UserMessage, UserMessageContent, UserOrToolContent,
};

const NON_VISION_USER_IMAGE_PLACEHOLDER: &str = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER: &str =
    "(tool image omitted: model does not support images)";

fn replace_images_with_placeholder(
    content: &[UserOrToolContent],
    placeholder: &str,
) -> Vec<UserOrToolContent> {
    let mut result: Vec<UserOrToolContent> = Vec::new();
    let mut previous_was_placeholder = false;
    for block in content {
        if let UserOrToolContent::Image(_) = block {
            if !previous_was_placeholder {
                result.push(UserOrToolContent::Text(TextContent {
                    text: placeholder.to_string(),
                    text_signature: None,
                    rest: Map::default(),
                }));
            }
            previous_was_placeholder = true;
            continue;
        }
        previous_was_placeholder =
            matches!(block, UserOrToolContent::Text(text) if text.text == placeholder);
        result.push(block.clone());
    }
    result
}

fn downgrade_unsupported_images(messages: &[Message], model: &Model) -> Vec<Message> {
    if model.supports_image_input() {
        return messages.to_vec();
    }
    messages
        .iter()
        .map(|msg| match msg {
            Message::User(user) => {
                let UserMessageContent::Blocks(blocks) = &user.content else {
                    return msg.clone();
                };
                Message::User(UserMessage {
                    content: UserMessageContent::Blocks(replace_images_with_placeholder(
                        blocks,
                        NON_VISION_USER_IMAGE_PLACEHOLDER,
                    )),
                    ..user.clone()
                })
            }
            Message::ToolResult(tool_result) => Message::ToolResult(ToolResultMessage {
                content: replace_images_with_placeholder(
                    &tool_result.content,
                    NON_VISION_TOOL_IMAGE_PLACEHOLDER,
                ),
                ..tool_result.clone()
            }),
            other @ Message::Assistant(_) => other.clone(),
        })
        .collect()
}

/// A tool call without a function name: some gateways synthesize a
/// `tool_calls` entry from a model's native tool-call template and lose the
/// name (often the id too). Nothing can execute it, and strict providers
/// reject every request that replays it (`tool_calls[N] is missing a
/// function name`), which would leave the session failing on every turn.
fn is_unnamed_tool_call(tool_call: &ToolCall) -> bool {
    tool_call.name.trim().is_empty()
}

/// Drop the tool calls a provider streamed without a function name from a
/// finished assistant message, so they never reach the agent loop or the
/// session file. A turn left with no tool call no longer ends in tool use.
pub(crate) fn drop_unnamed_tool_calls(output: &mut AssistantMessage) {
    let before = output.content.len();
    output.content.retain(
        |block| !matches!(block, AssistantContent::ToolCall(tool_call) if is_unnamed_tool_call(tool_call)),
    );
    if output.content.len() != before
        && output.stop_reason == StopReason::ToolUse
        && !output
            .content
            .iter()
            .any(|block| matches!(block, AssistantContent::ToolCall(_)))
    {
        output.stop_reason = StopReason::Stop;
    }
}

type Normalizer<'a> = dyn Fn(&str, &Model, &AssistantMessage) -> Option<String> + 'a;

/// Tool-call ID normalization plus synthetic tool results for unanswered calls, dropping errored
/// assistant turns (TS `transformMessages`). Unnamed tool calls already stored in a session (written
/// before the stream dropped them) are stripped here, and their results go with them as orphans, so
/// a session poisoned by one replays again.
// Long by design: mirrors the provider's stream shape.
#[allow(clippy::too_many_lines)]
pub fn transform_messages_with_normalizer(
    messages: &[Message],
    model: &Model,
    normalize_tool_call_id: &Normalizer<'_>,
) -> Vec<Message> {
    let mut tool_call_id_map: HashMap<String, String> = HashMap::new();
    let image_aware = downgrade_unsupported_images(messages, model);

    let transformed: Vec<Message> = image_aware
        .iter()
        .filter_map(|msg| match msg {
            Message::User(_) => Some(msg.clone()),
            Message::ToolResult(tool_result) => {
                if let Some(normalized) = tool_call_id_map.get(&tool_result.tool_call_id) {
                    if normalized != &tool_result.tool_call_id {
                        return Some(Message::ToolResult(ToolResultMessage {
                            tool_call_id: normalized.clone(),
                            ..tool_result.clone()
                        }));
                    }
                }
                Some(msg.clone())
            }
            Message::Assistant(assistant) => {
                let is_same_model = assistant.provider == model.provider
                    && assistant.api == model.api
                    && assistant.model == model.id;

                let transformed_content: Vec<AssistantContent> = assistant
                    .content
                    .iter()
                    .flat_map(|block| match block {
                        AssistantContent::Thinking(thinking) => {
                            let redacted = thinking.redacted.unwrap_or(false);
                            if redacted {
                                return if is_same_model {
                                    vec![block.clone()]
                                } else {
                                    vec![]
                                };
                            }
                            if is_same_model && thinking.thinking_signature.is_some() {
                                return vec![block.clone()];
                            }
                            if thinking.thinking.trim().is_empty() {
                                return vec![];
                            }
                            if is_same_model {
                                return vec![block.clone()];
                            }
                            vec![AssistantContent::Text(TextContent {
                                text: thinking.thinking.clone(),
                                text_signature: None,
                                rest: Map::default(),
                            })]
                        }
                        AssistantContent::Text(_) => vec![block.clone()],
                        AssistantContent::ToolCall(tool_call)
                            if is_unnamed_tool_call(tool_call) =>
                        {
                            vec![]
                        }
                        AssistantContent::ToolCall(tool_call) => {
                            let mut normalized: ToolCall = tool_call.clone();
                            if !is_same_model && tool_call.thought_signature.is_some() {
                                normalized.thought_signature = None;
                            }
                            if !is_same_model {
                                if let Some(normalizer) =
                                    normalize_tool_call_id(&tool_call.id, model, assistant)
                                {
                                    if normalizer != tool_call.id {
                                        tool_call_id_map
                                            .insert(tool_call.id.clone(), normalizer.clone());
                                        normalized.id = normalizer;
                                    }
                                }
                            }
                            vec![AssistantContent::ToolCall(normalized)]
                        }
                    })
                    .collect();

                // A turn that held nothing but unnamed tool calls has nothing left to replay.
                if transformed_content.is_empty()
                    && assistant.content.iter().any(|block| {
                        matches!(block, AssistantContent::ToolCall(tool_call) if is_unnamed_tool_call(tool_call))
                    })
                {
                    return None;
                }
                Some(Message::Assistant(crate::types::AssistantMessage {
                    content: transformed_content,
                    ..assistant.clone()
                }))
            }
        })
        .collect();

    // This preserves thinking signatures and satisfies API requirements
    let mut result: Vec<Message> = Vec::new();
    let mut pending_tool_calls: Vec<ToolCall> = Vec::new();
    let mut existing_tool_result_ids: HashSet<String> = HashSet::new();
    // Epoch millis fit u64 for ~584 million years; the u128 duration's millis are the timestamp's convention.
    #[allow(clippy::cast_possible_truncation)]
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);

    let insert_synthetic_tool_results =
        |result: &mut Vec<Message>, pending: &mut Vec<ToolCall>, existing: &mut HashSet<String>| {
            for tool_call in pending.drain(..) {
                if !existing.contains(&tool_call.id) {
                    result.push(Message::ToolResult(ToolResultMessage {
                        tool_call_id: tool_call.id.clone(),
                        tool_name: tool_call.name.clone(),
                        content: vec![UserOrToolContent::Text(TextContent {
                            text: "No result provided".to_string(),
                            text_signature: None,
                            rest: Map::default(),
                        })],
                        details: None,
                        is_error: true,
                        timestamp: now,
                        rest: Map::default(),
                    }));
                }
            }
            existing.clear();
        };

    for msg in transformed {
        match &msg {
            Message::Assistant(assistant) => {
                insert_synthetic_tool_results(
                    &mut result,
                    &mut pending_tool_calls,
                    &mut existing_tool_result_ids,
                );

                // Skip errored/aborted assistant messages entirely. These are incomplete turns that
                // shouldn't be replayed.
                if matches!(
                    assistant.stop_reason,
                    StopReason::Error | StopReason::Aborted
                ) {
                    continue;
                }

                let tool_calls: Vec<ToolCall> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        AssistantContent::ToolCall(tool_call) => Some(tool_call.clone()),
                        _ => None,
                    })
                    .collect();
                if !tool_calls.is_empty() {
                    pending_tool_calls = tool_calls;
                    existing_tool_result_ids.clear();
                }
                result.push(msg);
            }
            Message::ToolResult(tool_result) => {
                if !pending_tool_calls
                    .iter()
                    .any(|tool_call| tool_call.id == tool_result.tool_call_id)
                {
                    continue;
                }
                existing_tool_result_ids.insert(tool_result.tool_call_id.clone());
                result.push(msg);
            }
            Message::User(_) => {
                insert_synthetic_tool_results(
                    &mut result,
                    &mut pending_tool_calls,
                    &mut existing_tool_result_ids,
                );
                result.push(msg);
            }
        }
    }

    insert_synthetic_tool_results(
        &mut result,
        &mut pending_tool_calls,
        &mut existing_tool_result_ids,
    );

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Usage;

    fn user(text: &str) -> Message {
        Message::User(UserMessage {
            content: UserMessageContent::Text(text.to_string()),
            timestamp: 0,
            rest: Map::default(),
        })
    }

    fn assistant_with_tool_call(id: &str) -> Message {
        Message::Assistant(crate::types::AssistantMessage {
            content: vec![AssistantContent::ToolCall(ToolCall {
                id: id.to_string(),
                name: "echo".to_string(),
                arguments: Map::default(),
                thought_signature: None,
                rest: Map::default(),
            })],
            api: "openai-completions".into(),
            provider: "test".into(),
            model: "m".into(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::default(),
            stop_reason: StopReason::ToolUse,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: Map::default(),
        })
    }

    fn test_model() -> Model {
        Model {
            id: "m".into(),
            name: "m".into(),
            api: "openai-completions".into(),
            provider: "test".into(),
            base_url: "http://localhost".into(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![crate::types::ModelInput::Text],
            cost: crate::types::zero_model_cost(),
            context_window: 128_000,
            max_tokens: 8192,
            max_tokens_explicit: false,
            featured: None,
            headers: None,
            compat: None,
        }
    }

    #[test]
    fn inserts_synthetic_tool_results_for_unanswered_calls() {
        let messages = vec![
            user("hi"),
            assistant_with_tool_call("call-1"),
            user("again"),
        ];
        let transformed =
            transform_messages_with_normalizer(&messages, &test_model(), &|_, _, _| None);
        // tool call assistant, synthetic result, then the user message
        assert_eq!(transformed.len(), 4);
        assert!(matches!(&transformed[0], crate::types::Message::User(_)));
        match &transformed[2] {
            Message::ToolResult(result) => {
                assert_eq!(result.tool_call_id, "call-1");
                assert!(result.is_error);
                assert!(matches!(&result.content[0],
                    UserOrToolContent::Text(text) if text.text == "No result provided"));
            }
            other => panic!("expected synthetic tool result, got {other:?}"),
        }
    }

    #[test]
    fn drops_errored_assistant_turns() {
        let Message::Assistant(mut assistant) = assistant_with_tool_call("call-1") else {
            unreachable!()
        };
        assistant.stop_reason = StopReason::Error;
        let messages = vec![user("hi"), Message::Assistant(assistant)];
        let transformed =
            transform_messages_with_normalizer(&messages, &test_model(), &|_, _, _| None);
        assert_eq!(transformed.len(), 1);
    }

    #[test]
    fn keeps_matched_tool_results_and_drops_orphans() {
        let messages = vec![
            assistant_with_tool_call("call-1"),
            Message::ToolResult(ToolResultMessage {
                tool_call_id: "call-1".into(),
                tool_name: "echo".into(),
                content: vec![],
                details: None,
                is_error: false,
                timestamp: 1,
                rest: Map::default(),
            }),
            Message::ToolResult(ToolResultMessage {
                tool_call_id: "orphan".into(),
                tool_name: "echo".into(),
                content: vec![],
                details: None,
                is_error: false,
                timestamp: 2,
                rest: Map::default(),
            }),
        ];
        let transformed =
            transform_messages_with_normalizer(&messages, &test_model(), &|_, _, _| None);
        assert_eq!(transformed.len(), 2);
    }

    fn tool_call(id: &str, name: &str) -> AssistantContent {
        AssistantContent::ToolCall(ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            arguments: Map::default(),
            thought_signature: None,
            rest: Map::default(),
        })
    }

    fn text(text: &str) -> AssistantContent {
        AssistantContent::Text(TextContent {
            text: text.to_string(),
            text_signature: None,
            rest: Map::default(),
        })
    }

    fn assistant(content: Vec<AssistantContent>, stop_reason: StopReason) -> AssistantMessage {
        let Message::Assistant(assistant) = assistant_with_tool_call("unused") else {
            unreachable!()
        };
        AssistantMessage {
            content,
            stop_reason,
            ..assistant
        }
    }

    fn tool_result(id: &str, name: &str, text: &str) -> Message {
        Message::ToolResult(ToolResultMessage {
            tool_call_id: id.into(),
            tool_name: name.into(),
            content: vec![UserOrToolContent::Text(TextContent {
                text: text.into(),
                text_signature: None,
                rest: Map::default(),
            })],
            details: None,
            is_error: true,
            timestamp: 0,
            rest: Map::default(),
        })
    }

    #[test]
    fn a_session_poisoned_by_an_unnamed_tool_call_replays_without_it() {
        // The #3742 transcript: the gateway left the call without a name or id, the
        // loop answered `Tool  not found`, and both rows were persisted.
        let named = tool_call("call-1", "bash");
        let messages = vec![
            user("hi"),
            Message::Assistant(assistant(
                vec![text("probing"), tool_call("", "")],
                StopReason::ToolUse,
            )),
            tool_result("", "", "Tool  not found"),
            Message::Assistant(assistant(vec![tool_call("", "")], StopReason::ToolUse)),
            tool_result("", "", "Tool  not found"),
            Message::Assistant(assistant(
                vec![named.clone(), tool_call("call-2", " ")],
                StopReason::ToolUse,
            )),
            tool_result("call-1", "bash", "ok"),
            tool_result("call-2", " ", "Tool   not found"),
            user("again"),
        ];
        let transformed =
            transform_messages_with_normalizer(&messages, &test_model(), &|_, _, _| None);
        let expected = vec![
            user("hi"),
            Message::Assistant(assistant(vec![text("probing")], StopReason::ToolUse)),
            Message::Assistant(assistant(vec![named], StopReason::ToolUse)),
            tool_result("call-1", "bash", "ok"),
            user("again"),
        ];
        assert_eq!(transformed, expected);
    }

    #[test]
    fn a_streamed_turn_keeps_only_its_named_tool_calls() {
        let mut mixed = assistant(
            vec![text("x"), tool_call("", ""), tool_call("call-1", "bash")],
            StopReason::ToolUse,
        );
        drop_unnamed_tool_calls(&mut mixed);
        assert_eq!(
            mixed,
            assistant(
                vec![text("x"), tool_call("call-1", "bash")],
                StopReason::ToolUse
            )
        );

        let mut only_unnamed = assistant(vec![text("x"), tool_call("", "")], StopReason::ToolUse);
        drop_unnamed_tool_calls(&mut only_unnamed);
        assert_eq!(only_unnamed, assistant(vec![text("x")], StopReason::Stop));
    }
}
