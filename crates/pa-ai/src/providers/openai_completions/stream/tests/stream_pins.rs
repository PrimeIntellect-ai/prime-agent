//! The thinking-channel pins: a GLM-5.3-style response arrives either with
//! its reasoning in `delta.reasoning_content` (the healthy envelope —
//! the thinking block's signature is the field name) or with its
//! reasoning merged into `delta.content` (the content-only envelope —
//! no thinking block at all, the reasoning rides the text block). The
//! stream maps whichever envelope the provider sends; these two pins
//! document that BOTH assemblies are faithful, so stored rows whose
//! reasoning rides the text block are the provider's envelope, not a
//! local reclassification of a thinking stream.

use super::*;

/// The diagnosed session's model entry (the internal GLM-5.3 fast
/// route: reasoning mandatory, catalog `reasoning: true`).
fn glm_fast_model() -> Value {
    json!({
        "id": "internal/glm-5.3-fast",
        "name": "GLM 5.3 Fast",
        "api": "openai-completions",
        "provider": "prime-inference",
        "reasoning": true,
        "input": ["text"],
        "cost": { "input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0 },
        "contextWindow": 262_144,
        "maxTokens": 65_536,
    })
}

/// Stream one SSE body end-to-end, collecting every event plus the
/// final assistant message.
async fn stream_events(
    model: Value,
    body: String,
) -> (Vec<AssistantMessageEvent>, AssistantMessage) {
    let addr = serve_sse(body).await;
    let mut model = model;
    model["baseUrl"] = json!(format!("http://{addr}"));
    let model: Model = serde_json::from_value(model).unwrap();
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
    let mut events = Vec::new();
    loop {
        let event = reader.next_event().await.unwrap();
        let terminal = match &event {
            AssistantMessageEvent::Done { message, .. } => Some(message.clone()),
            AssistantMessageEvent::Error { error, .. } => {
                panic!("stream failed: {:?}", error.error_message)
            }
            _ => None,
        };
        events.push(event);
        if let Some(message) = terminal {
            return (events, message);
        }
    }
}

fn sse_body(chunks: &[Value]) -> String {
    use std::fmt::Write as _;
    let mut body = String::new();
    for chunk in chunks {
        let _ = write!(body, "data: {chunk}\n\n");
    }
    let _ = write!(body, "data: [DONE]\n\n");
    body
}

/// THE CONTENT-ONLY ENVELOPE: the reasoning arrives ONLY inside `content`
/// deltas — no `reasoning_content` delta — so the assembled message
/// carries no thinking block and the text block holds the reasoning
/// merged with the response. No thinking events fire: the stored rows
/// this assembly produces are the store being faithful to the envelope,
/// not a misclassification.
#[tokio::test]
async fn reasoning_in_content_deltas_assembles_no_thinking_block() {
    let reasoning_prose = "The domain-flip PR (#3142) is green. The plan:\n1. Create the worktree.\n2. Start the rebase.\nActually — the smarter route: let me execute.";
    let response_tail = "Now the fold takeover, executing directly:";
    let body = sse_body(&[
        json!({
            "id": "a42da6520be8102f-HEL", "object": "chat.completion.chunk",
            "model": "internal/glm-5.3-fast",
            "choices": [{ "index": 0, "delta": { "role": "assistant", "content": reasoning_prose } }]
        }),
        json!({
            "id": "a42da6520be8102f-HEL", "object": "chat.completion.chunk",
            "model": "internal/glm-5.3-fast",
            "choices": [{ "index": 0, "delta": { "content": response_tail } }]
        }),
        json!({
            "id": "a42da6520be8102f-HEL", "object": "chat.completion.chunk",
            "model": "internal/glm-5.3-fast",
            "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 244_064, "completion_tokens": 800, "total_tokens": 244_864 }
        }),
    ]);
    let (events, message) = stream_events(glm_fast_model(), body).await;
    // No thinking block: the reasoning channel never arrived.
    let [AssistantContent::Text(text)] = &message.content[..] else {
        panic!(
            "the content-only envelope assembles one text block: {:?}",
            message.content
        );
    };
    assert_eq!(
        text.text,
        format!("{reasoning_prose}{response_tail}"),
        "the reasoning prose merges with the response tail into the single text block"
    );
    assert!(
        !message
            .content
            .iter()
            .any(|block| matches!(block, AssistantContent::Thinking(_))),
        "no thinking block exists: {:?}",
        message.content
    );
    // No thinking events: the reasoning channel never announced itself.
    assert!(
        events.iter().all(|event| !matches!(
            event,
            AssistantMessageEvent::ThinkingStart { .. }
                | AssistantMessageEvent::ThinkingDelta { .. }
                | AssistantMessageEvent::ThinkingEnd { .. }
        )),
        "no thinking events fire for a content-only envelope: {events:?}"
    );
    // The text channel streamed the merged prose as plain text.
    let text_deltas: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            AssistantMessageEvent::TextDelta { delta, .. } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text_deltas, [reasoning_prose, response_tail]);
    assert_eq!(message.stop_reason, StopReason::Stop);
    assert_eq!(message.usage.input, 244_064);
}

/// THE HEALTHY ENVELOPE: the reasoning arrives in `delta.reasoning_content`,
/// the answer in `delta.content`, and the assembled message carries the
/// thinking block whose signature is the field name (the wire shape the
/// session rows' `thinkingSignature: "reasoning_content"` records),
/// followed by the text block. Thinking events fire.
#[tokio::test]
async fn reasoning_content_deltas_assemble_the_thinking_block_with_the_field_signature() {
    let thinking_a = "The operator asks: why do we need the nightly cron again?";
    let thinking_b = " It is the rehearsal for the release machinery itself.";
    let answer = "**The nightly cron exists for three reasons.**";
    let body = sse_body(&[
        json!({
            "id": "a42da4e81901102f-HEL", "object": "chat.completion.chunk",
            "model": "internal/glm-5.3-fast",
            "choices": [{ "index": 0, "delta": { "role": "assistant", "reasoning_content": thinking_a } }]
        }),
        json!({
            "id": "a42da4e81901102f-HEL", "object": "chat.completion.chunk",
            "model": "internal/glm-5.3-fast",
            "choices": [{ "index": 0, "delta": { "reasoning_content": thinking_b } }]
        }),
        json!({
            "id": "a42da4e81901102f-HEL", "object": "chat.completion.chunk",
            "model": "internal/glm-5.3-fast",
            "choices": [{ "index": 0, "delta": { "content": answer } }]
        }),
        json!({
            "id": "a42da4e81901102f-HEL", "object": "chat.completion.chunk",
            "model": "internal/glm-5.3-fast",
            "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 244_064, "completion_tokens": 800, "total_tokens": 244_864 }
        }),
    ]);
    let (events, message) = stream_events(glm_fast_model(), body).await;
    // The thinking block carries the field name as its signature.
    let [AssistantContent::Thinking(thinking), AssistantContent::Text(text)] = &message.content[..]
    else {
        panic!(
            "the healthy envelope assembles thinking then text: {:?}",
            message.content
        );
    };
    assert_eq!(thinking.thinking, format!("{thinking_a}{thinking_b}"));
    assert_eq!(
        thinking.thinking_signature.as_deref(),
        Some("reasoning_content")
    );
    assert_eq!(text.text, answer);
    // The thinking events announce the channel.
    let thinking_deltas: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            AssistantMessageEvent::ThinkingDelta { delta, .. } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(thinking_deltas, [thinking_a, thinking_b]);
    assert!(
        events
            .iter()
            .any(|event| matches!(event, AssistantMessageEvent::ThinkingStart { .. })),
        "the thinking channel announces its start: {events:?}"
    );
    assert_eq!(message.stop_reason, StopReason::Stop);
}
