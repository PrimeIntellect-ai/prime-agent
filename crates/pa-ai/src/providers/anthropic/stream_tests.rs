//! Characterization tests for the Anthropic SSE stream, replayed through a
//! local in-process SSE server.

use serde_json::{json, Map};

use crate::event_stream::AssistantMessageEventExt;
use crate::providers::anthropic::{stream_anthropic, AnthropicOptions};
use crate::types::{
    AssistantContent, Context, Model, StopReason, StreamOptions, ThinkingContent, ToolCall,
};

#[tokio::test]
#[allow(clippy::too_many_lines)] // one inline SSE script plus a whole-value snapshot of every event
async fn stream_events_snapshot_current_content() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut sse = [
        r#"event: message_start
data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1,"output_tokens":2}}}"#,
        r#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
        r#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"think"}}"#,
        r#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}"#,
        r#"event: content_block_stop
data: {"type":"content_block_stop","index":0}"#,
        r#"event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"lookup","input":{}}}"#,
        r#"event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"a\":1}"}}"#,
        r#"event: content_block_stop
data: {"type":"content_block_stop","index":1}"#,
        r#"event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}"#,
        r#"event: message_stop
data: {"type":"message_stop"}"#,
    ]
    .join("\n\n");
    sse.push_str("\n\n");
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![0; 8192];
        let _ = socket.read(&mut request).await.unwrap();
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{sse}",
                    sse.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    let model: Model = serde_json::from_value(json!({
        "id": "claude-test", "name": "Claude Test", "api": "anthropic-messages",
        "provider": "anthropic", "baseUrl": format!("http://{addr}"), "reasoning": false,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 128_000, "maxTokens": 8192
    }))
    .unwrap();
    let options = AnthropicOptions::from_base(StreamOptions {
        api_key: Some("sk-ant-api-test".into()),
        ..Default::default()
    });
    let mut reader = stream_anthropic(
        &model,
        &Context {
            system_prompt: None,
            messages: vec![],
            tools: None,
        },
        Some(&options),
    );
    let mut events = Vec::new();
    while let Some(event) = reader.next_event().await {
        events.push(event);
    }

    let thinking_base = ThinkingContent {
        thinking: String::new(),
        thinking_signature: Some(String::new()),
        redacted: None,
        rest: Map::default(),
    };
    let thinking_delta = AssistantContent::Thinking(ThinkingContent {
        thinking: "think".into(),
        ..thinking_base.clone()
    });
    let thinking_signed = AssistantContent::Thinking(ThinkingContent {
        thinking: "think".into(),
        thinking_signature: Some("sig".into()),
        ..thinking_base.clone()
    });
    let tool_call_base = ToolCall {
        id: "t1".into(),
        name: "lookup".into(),
        arguments: Map::default(),
        thought_signature: None,
        rest: Map::default(),
    };
    let tool_call_args = AssistantContent::ToolCall(ToolCall {
        arguments: json!({"a": 1}).as_object().cloned().unwrap(),
        ..tool_call_base.clone()
    });
    assert_eq!(
        events
            .iter()
            .map(|event| (event.event_type(), event.partial().content.clone()))
            .collect::<Vec<_>>(),
        vec![
            ("start", vec![]),
            (
                "thinking_start",
                vec![AssistantContent::Thinking(thinking_base)]
            ),
            ("thinking_delta", vec![thinking_delta]),
            ("thinking_end", vec![thinking_signed.clone()]),
            (
                "toolcall_start",
                vec![
                    thinking_signed.clone(),
                    AssistantContent::ToolCall(tool_call_base),
                ],
            ),
            (
                "toolcall_delta",
                vec![thinking_signed.clone(), tool_call_args.clone()]
            ),
            (
                "toolcall_end",
                vec![thinking_signed.clone(), tool_call_args.clone()]
            ),
            ("done", vec![thinking_signed, tool_call_args]),
        ]
    );
    assert_eq!(
        events.last().unwrap().partial().stop_reason,
        StopReason::ToolUse
    );
}
