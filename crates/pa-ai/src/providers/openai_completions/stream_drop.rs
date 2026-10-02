//! The stream-drop pins: the SSE fixtures whose response body ends without
//! the protocol's terminal marker, and the healthy shapes that must never
//! classify as drops.
//!
//! The silent lane-death class: the provider (the internal glm-5.3 route)
//! ends the response stream mid-block — no stop signal (`finish_reason`),
//! no `[DONE]` marker, no error frame — and the turn must not settle as a
//! completed message. Each dropped shape pins the retryable `stream_drop`
//! failure; each healthy shape pins no drop.

use super::*;
use crate::event_stream::AssistantMessageEventExt;
use serde_json::Value;
use std::net::SocketAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Serve one SSE response body for the provider's POST and return the
/// bound address (one connection per spawned server).
async fn serve_sse(body: String) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![0u8; 8192];
        let _ = socket.read(&mut request).await.unwrap();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    });
    addr
}

/// Run the provider stream against the SSE body and return the terminal
/// event plus the full event-type sequence.
async fn stream_events(body: String) -> (Vec<&'static str>, AssistantMessageEvent) {
    let addr = serve_sse(body).await;
    let model: Model = serde_json::from_value(json!({
        "id": "glm-test", "name": "GLM test", "api": "openai-completions",
        "provider": "prime-inference", "baseUrl": format!("http://{addr}"),
        "reasoning": true, "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 131_072, "maxTokens": 8192,
    }))
    .expect("test model");
    let options = OpenAICompletionsOptions::from_base(crate::types::StreamOptions {
        api_key: Some("test".into()),
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
    let mut event_types = Vec::new();
    loop {
        let Some(event) = reader.next_event().await else {
            panic!("stream ended without a terminal event");
        };
        if event.is_terminal() {
            return (event_types, event);
        }
        event_types.push(event.event_type());
    }
}

/// The `provider_stream_failure` diagnostic's `details.kind` of a terminal
/// error message, if any.
fn failure_kind(message: &AssistantMessage) -> Option<String> {
    message
        .diagnostics
        .as_ref()?
        .iter()
        .find(|diagnostic| diagnostic.type_ == "provider_stream_failure")
        .and_then(|diagnostic| diagnostic.details.as_ref())
        .and_then(|details| details.get("kind"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn thinking_text(message: &AssistantMessage) -> Option<String> {
    match message.content.first() {
        Some(AssistantContent::Thinking(ThinkingContent { thinking, .. })) => {
            Some(thinking.clone())
        }
        _ => None,
    }
}

/// A thinking delta chunk (`finish_reason` still null — the stream is
/// mid-block).
const THINKING_DELTA: &str = "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"glm-test\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"Let me work through this step by step. First I\"},\"finish_reason\":null}]}\n\n";

/// A text delta chunk (mid-block, no stop signal yet).
const TEXT_DELTA: &str = "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"glm-test\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Here is the first half of\"},\"finish_reason\":null}]}\n\n";

/// The stop signal: the final chunk carries `finish_reason: "stop"`.
const FINISH: &str = "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"glm-test\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n";

/// The SSE terminal marker.
const DONE: &str = "data: [DONE]\n\n";

/// The dropped-mid-thinking fixture: the body ends inside a thinking block
/// with no stop signal and no `[DONE]` — the fleet's death signature (the
/// fresh spawn's first thinking block). The terminal event is the
/// retryable `stream_drop` failure, never a completed message.
#[tokio::test]
async fn a_stream_dropped_mid_thinking_classifies_as_stream_drop() {
    let (event_types, terminal) = stream_events(THINKING_DELTA.to_string()).await;
    let AssistantMessageEvent::Error { error, .. } = terminal else {
        panic!("a dropped stream must terminate with an error event");
    };
    assert_eq!(
        error.stop_reason,
        StopReason::Error,
        "events: {event_types:?}"
    );
    let error_message = error.error_message.as_deref().unwrap_or_default();
    assert!(error_message.contains("stream_drop"), "{error_message}");
    assert!(error_message.contains("thinking block"), "{error_message}");
    assert_eq!(failure_kind(&error).as_deref(), Some("stream_drop"));
    // The partial thinking rides the failed message (the retry arm drops
    // it from the context before re-issuing).
    assert_eq!(
        thinking_text(&error).as_deref(),
        Some("Let me work through this step by step. First I"),
        "the partial thinking block rides the failure"
    );
}

/// A stream dropped mid-text classifies the same way.
#[tokio::test]
async fn a_stream_dropped_mid_text_classifies_as_stream_drop() {
    let (_, terminal) = stream_events(TEXT_DELTA.to_string()).await;
    let AssistantMessageEvent::Error { error, .. } = terminal else {
        panic!("a dropped stream must terminate with an error event");
    };
    assert_eq!(error.stop_reason, StopReason::Error);
    assert!(error
        .error_message
        .as_deref()
        .unwrap_or_default()
        .contains("text block"));
    assert_eq!(failure_kind(&error).as_deref(), Some("stream_drop"));
}

/// A body that ends before any content (no block, no marker) is the same
/// drop class — the silent empty turn the daemon used to complete.
#[tokio::test]
async fn an_empty_body_is_a_stream_drop_not_an_empty_turn() {
    let (_, terminal) = stream_events(String::new()).await;
    let AssistantMessageEvent::Error { error, .. } = terminal else {
        panic!("an empty body must terminate with an error event");
    };
    assert_eq!(error.stop_reason, StopReason::Error);
    assert!(error
        .error_message
        .as_deref()
        .unwrap_or_default()
        .contains("before any response content"));
    assert_eq!(failure_kind(&error).as_deref(), Some("stream_drop"));
}

/// The healthy stream is unchanged: the stop signal (`finish_reason`) plus
/// the `[DONE]` marker complete the turn with no error and no
/// retryable classification.
#[tokio::test]
async fn a_healthy_stream_completes_without_a_drop() {
    let body = format!("{THINKING_DELTA}{FINISH}{DONE}");
    let (event_types, terminal) = stream_events(body).await;
    let AssistantMessageEvent::Done { message, .. } = terminal else {
        panic!("a healthy stream must complete: {event_types:?}");
    };
    assert_eq!(message.stop_reason, StopReason::Stop);
    assert_eq!(message.error_message, None);
    assert!(message.diagnostics.is_none());
    assert_eq!(
        thinking_text(&message).as_deref(),
        Some("Let me work through this step by step. First I")
    );
}

/// The stop signal alone completes the turn: gateways that close without
/// the `[DONE]` marker are completed streams, not drops.
#[tokio::test]
async fn a_finish_reason_without_done_marker_completes() {
    let body = format!("{TEXT_DELTA}{FINISH}");
    let (_, terminal) = stream_events(body).await;
    let AssistantMessageEvent::Done { message, .. } = terminal else {
        panic!("a finish_reason alone must complete the stream");
    };
    assert_eq!(message.stop_reason, StopReason::Stop);
    assert_eq!(message.error_message, None);
}

/// The `[DONE]` marker alone completes the turn: gateways that omit the
/// final `finish_reason` chunk are completed streams, not drops.
#[tokio::test]
async fn a_done_marker_without_finish_reason_completes() {
    let body = format!("{TEXT_DELTA}{DONE}");
    let (_, terminal) = stream_events(body).await;
    let AssistantMessageEvent::Done { message, .. } = terminal else {
        panic!("a [DONE] alone must complete the stream");
    };
    assert_eq!(message.stop_reason, StopReason::Stop);
    assert_eq!(message.error_message, None);
}
