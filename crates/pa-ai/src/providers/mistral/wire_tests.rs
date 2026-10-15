use super::*;
use std::fmt::Write as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// Keep the split/interleaved fixtures beside their full HTTP/SSE verification.
#[allow(clippy::too_many_lines)]
#[tokio::test]
async fn streamed_tool_calls_keep_index_identity_and_complete_arguments() {
    let cases = [
        (
            vec![
                json!({"index": 0, "id": "python123", "function": {"name": "ipython", "arguments": "{\"code\":\""}}),
                json!({"index": 0, "function": {"arguments": "print(1)"}}),
                json!({"index": 0, "function": {"arguments": "\\nprint(2)\"}"}}),
            ],
            json!([{"id": "python123", "name": "ipython", "arguments": {"code": "print(1)\nprint(2)"}}]),
        ),
        (
            vec![
                json!({"index": 0, "id": "python123", "function": {"name": "ipython"}}),
                json!({"index": 1, "id": "other1234", "function": {"name": "edit", "arguments": "{\"path\":"}}),
                json!({"index": 0, "function": {"arguments": "{\"code\":\"print(1)\"}"}}),
                json!({"index": 1, "function": {"arguments": "\"file.txt\"}"}}),
            ],
            json!([
                {"id": "python123", "name": "ipython", "arguments": {"code": "print(1)"}},
                {"id": "other1234", "name": "edit", "arguments": {"path": "file.txt"}},
            ]),
        ),
        (
            vec![
                json!({"index": 0, "function": {"arguments": "{\"code\":"}}),
                json!({"index": 0, "id": "python123", "function": {"name": "ipython"}}),
                json!({"index": 0, "function": {"arguments": "\"print(1)\"}"}}),
            ],
            json!([{"id": "python123", "name": "ipython", "arguments": {"code": "print(1)"}}]),
        ),
    ];
    for (deltas, expected) in cases {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 4096];
            let (body_start, content_length) = loop {
                let read = socket.read(&mut chunk).await.unwrap();
                assert_ne!(read, 0, "request ended before its headers");
                request.extend_from_slice(&chunk[..read]);
                if let Some(pos) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let content_length = String::from_utf8_lossy(&request[..pos])
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .expect("POST has a content length");
                    break (pos + 4, content_length);
                }
            };
            while request.len() < body_start + content_length {
                let read = socket.read(&mut chunk).await.unwrap();
                assert_ne!(read, 0, "request ended before its body");
                request.extend_from_slice(&chunk[..read]);
            }
            let mut response_body = String::new();
            for delta in deltas {
                let event = json!({"id": "response1", "choices": [{"index": 0, "delta": {"tool_calls": [delta]}}]});
                write!(response_body, "data: {event}\n\n").unwrap();
            }
            response_body.push_str("data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                response_body.len(),
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        let model: Model = serde_json::from_value(json!({
            "id": "zai-glm-5-3", "name": "GLM",
            "api": API_MISTRAL_CONVERSATIONS, "provider": "mistral",
            "baseUrl": format!("http://{addr}"), "reasoning": false,
            "input": ["text"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 128_000, "maxTokens": 128,
        }))
        .unwrap();
        let options = SimpleStreamOptions {
            base: StreamOptions {
                api_key: Some("test".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        let context = Context {
            system_prompt: None,
            messages: vec![],
            tools: None,
        };
        let result = stream_simple_mistral(&model, &context, Some(&options))
            .result()
            .await;
        server.await.unwrap();
        assert_eq!(
            result.stop_reason,
            StopReason::ToolUse,
            "{:?}",
            result.error_message
        );
        let actual: Vec<Value> = result
            .content
            .iter()
            .map(|content| {
                let crate::types::AssistantContent::ToolCall(call) = content else {
                    panic!("expected only tool calls, got {content:?}");
                };
                json!({"id": call.id, "name": call.name, "arguments": call.arguments})
            })
            .collect();
        assert_eq!(json!(actual), expected);
    }
}
