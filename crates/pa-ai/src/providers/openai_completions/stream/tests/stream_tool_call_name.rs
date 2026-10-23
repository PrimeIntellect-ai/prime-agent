//! The nameless-tool-call pins (#3742): a gateway that converts a model's
//! native tool-call template can emit a `tool_calls` entry with no
//! `function.name` (and often no `id`). Stored and replayed, that call makes
//! strict providers reject every later request, so the stream must never let
//! a nameless call into the final message.

use super::*;
use crate::providers::transform_messages::UNNAMED_TOOL_CALL;

/// One chat-completions chunk carrying `delta`.
fn chunk(delta: &Value) -> String {
    let chunk = json!({
        "id": "c1",
        "object": "chat.completion.chunk",
        "model": "glm-test",
        "choices": [{"index": 0, "delta": delta, "finish_reason": null}],
    });
    format!("data: {chunk}\n\n")
}

/// The stop signal for a tool-call turn.
const TOOLCALL_FINISH: &str = "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"glm-test\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n";

fn tool_call(id: &str, name: &str, arguments: &Value) -> AssistantContent {
    AssistantContent::ToolCall(ToolCall {
        id: id.to_string(),
        name: name.to_string(),
        arguments: arguments.as_object().cloned().unwrap_or_default(),
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

async fn stream(chunks: &[String]) -> AssistantMessage {
    stream_final_message(
        completions_model("glm-test", "zenmux", 0.0, 0.0),
        format!("{}{TOOLCALL_FINISH}{DONE}", chunks.concat()),
    )
    .await
}

#[tokio::test]
async fn a_turn_of_only_nameless_calls_keeps_going_as_unknown_tool() {
    // The reported shape: the model's template leaks as text, and the gateway
    // adds a tool call with neither `function.name` nor `id`. The call is named
    // so the loop answers it with a not-found error and the model can retry.
    let message = stream(&[
        chunk(&json!({"role": "assistant", "content": "probing:"})),
        chunk(&json!({"tool_calls": [{
            "index": 0,
            "function": {"arguments": "{\"python_repl\":\"x\"}"},
        }]})),
    ])
    .await;
    let id = format!("call_unnamed_{}_1", message.timestamp);
    assert_eq!(
        message.content,
        vec![
            text("probing:"),
            tool_call(&id, UNNAMED_TOOL_CALL, &json!({"python_repl": "x"}))
        ]
    );
    assert_eq!(message.stop_reason, StopReason::ToolUse);
}

#[tokio::test]
async fn a_nameless_call_beside_a_named_one_is_dropped_alone() {
    let message = stream(&[
        chunk(&json!({"tool_calls": [{
            "index": 0,
            "id": "call_1",
            "function": {"name": "python_repl", "arguments": "{\"code\":\"x\"}"},
        }]})),
        chunk(&json!({"tool_calls": [{
            "index": 1,
            "function": {"arguments": "{\"code\":\"y\"}"},
        }]})),
    ])
    .await;
    assert_eq!(
        message.content,
        vec![tool_call("call_1", "python_repl", &json!({"code": "x"}))]
    );
    assert_eq!(message.stop_reason, StopReason::ToolUse);
}
