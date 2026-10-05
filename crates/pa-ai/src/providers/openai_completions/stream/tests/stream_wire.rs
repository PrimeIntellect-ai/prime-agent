//! The wire-level pins: the request head the shared transport puts on
//! the wire for a chat/completions POST. The JSON body carries exactly
//! one `content-type: application/json` label, and a caller-configured
//! content-type (`model.headers` or stream-options headers) still wins.

use super::*;

use std::net::SocketAddr;

/// The known-green SSE script from the tier pins (a content chunk, a
/// usage chunk, `[DONE]`): the stream completes so the head capture and
/// the response both land in one test.
fn tier_sse() -> String {
    format!("{TIERED_CONTENT_CHUNK}{USAGE_CHUNK}{DONE}")
}

/// Serve one SSE response for the provider's POST and hand the captured
/// request head back to the caller (the same one-request mock-server
/// harness as [`serve_sse`], plus the capture).
async fn serve_sse_capturing_head(
    body: String,
) -> (SocketAddr, tokio::sync::oneshot::Receiver<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (head_tx, head_rx) = tokio::sync::oneshot::channel::<String>();
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut captured = String::new();
        let mut buffer = [0u8; 4096];
        loop {
            let read = socket.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            captured.push_str(&String::from_utf8_lossy(&buffer[..read]));
            if captured.contains("\r\n\r\n") {
                break;
            }
        }
        let _ = head_tx.send(captured);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    });
    (addr, head_rx)
}

/// Stream the provider against the mock to completion and return the
/// request head it put on the wire.
async fn stream_capture_head(
    model: Value,
    headers: Option<std::collections::HashMap<String, String>>,
) -> String {
    let (addr, head_rx) = serve_sse_capturing_head(tier_sse()).await;
    let mut model = model;
    model["baseUrl"] = json!(format!("http://{addr}"));
    let model: Model = serde_json::from_value(model).unwrap();
    let options = OpenAICompletionsOptions::from_base(crate::types::StreamOptions {
        api_key: Some("test".into()),
        headers,
        ..Default::default()
    });
    let mut reader = stream_openai_completions(
        &model,
        &Context {
            system_prompt: None,
            messages: vec![],
            tools: None,
        },
        Some(&options),
    );
    loop {
        let event = reader.next_event().await.unwrap();
        if let AssistantMessageEvent::Done { .. } = event {
            break;
        }
        if let AssistantMessageEvent::Error { error, .. } = event {
            panic!("stream failed: {:?}", error.error_message);
        }
    }
    let captured = head_rx.await.unwrap();
    captured
        .split("\r\n\r\n")
        .next()
        .unwrap_or(&captured)
        .to_string()
}

/// The values of one wire header, case-insensitive on the name (HTTP/1.1
/// headers are case-insensitive; a duplicated header shows up twice).
fn header_values(head: &str, name: &str) -> Vec<String> {
    head.lines()
        .skip(1) // the request line: POST /chat/completions HTTP/1.1
        .filter_map(|line| line.split_once(':'))
        .filter(|(key, _)| key.trim().eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim().to_string())
        .collect()
}

/// The chat/completions POST carries exactly one
/// `content-type: application/json` label; a strict OpenAI-compatible
/// frontend 400s without it.
#[tokio::test]
async fn wire_carries_one_content_type_application_json() {
    let head = stream_capture_head(completions_model("gpt-5.5", "openai", 1.0, 1.0), None).await;
    assert_eq!(
        header_values(&head, "content-type"),
        vec!["application/json"],
        "the wire head: {head}"
    );
}

/// A caller-configured content-type (stream-options headers) still wins:
/// the transport stamps its label only when the caller did not provide
/// one, and it never duplicates the header.
#[tokio::test]
async fn wire_caller_content_type_override_wins() {
    let headers = std::collections::HashMap::from([(
        "Content-Type".to_string(),
        "application/vnd.api+json".to_string(),
    )]);
    let head = stream_capture_head(
        completions_model("gpt-5.5", "openai", 1.0, 1.0),
        Some(headers),
    )
    .await;
    assert_eq!(
        header_values(&head, "content-type"),
        vec!["application/vnd.api+json"],
        "the wire head: {head}"
    );
}
