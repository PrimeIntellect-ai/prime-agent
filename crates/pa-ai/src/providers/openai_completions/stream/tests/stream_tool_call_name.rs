//! The nameless-tool-call pin: a gateway that converts a model's native
//! tool-call template can emit an `OpenAI` `tool_calls` entry with no
//! `function.name` (and sometimes no `id`). Replaying that call makes strict
//! providers reject the whole request on every later turn, so the stream must
//! name it before it reaches the transcript.

use super::*;

/// A `tool_calls` delta with neither `function.name` nor `id` (the shape seen
/// when a gateway parses `<tool_call><parameter=...>` and loses the function).
const NAMELESS_TOOL_CALL: &str = "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"glm-test\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"python_repl\\\":\\\"x\\\"}\"}}]},\"finish_reason\":null}]}\n\n";

/// The stop signal for a tool-call turn.
const TOOLCALL_FINISH: &str = "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"glm-test\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n";

/// The SSE terminal marker.
const DONE: &str = "data: [DONE]\n\n";

/// A named tool call must pass through untouched.
const NAMED_TOOL_CALL: &str = "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"glm-test\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"python_repl\",\"arguments\":\"{\\\"code\\\":\\\"x\\\"}\"}}]},\"finish_reason\":null}]}\n\n";

fn tool_call_of(message: &AssistantMessage) -> &ToolCall {
    message
        .content
        .iter()
        .find_map(|block| match block {
            AssistantContent::ToolCall(tool_call) => Some(tool_call),
            _ => None,
        })
        .expect("tool call block")
}

#[tokio::test]
async fn a_tool_call_without_a_function_name_is_named_before_it_is_stored() {
    let message = stream_final_message(
        completions_model("glm-test", "prime-inference", 0.0, 0.0),
        format!("{NAMELESS_TOOL_CALL}{TOOLCALL_FINISH}{DONE}"),
    )
    .await;
    assert_eq!(message.stop_reason, StopReason::ToolUse);
    let tool_call = tool_call_of(&message);
    assert_eq!(
        tool_call.name, UNNAMED_TOOL_CALL,
        "a nameless call must be named before it enters the transcript"
    );
    assert!(
        !tool_call.id.is_empty(),
        "a call without a provider id still needs a replayable id"
    );
}

#[tokio::test]
async fn a_named_tool_call_is_left_alone() {
    let message = stream_final_message(
        completions_model("glm-test", "prime-inference", 0.0, 0.0),
        format!("{NAMED_TOOL_CALL}{TOOLCALL_FINISH}{DONE}"),
    )
    .await;
    let tool_call = tool_call_of(&message);
    assert_eq!(tool_call.name, "python_repl");
    assert_eq!(tool_call.id, "call_1");
}
