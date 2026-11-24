use super::*;
use std::time::Instant;

#[test]
#[ignore = "run with cargo test -p pa-ai --release stream_delta_benchmark -- --ignored --nocapture"]
fn stream_delta_benchmark() {
    let model: Model = serde_json::from_value(json!({
        "id": "benchmark", "name": "benchmark", "api": "openai-completions",
        "provider": "benchmark", "baseUrl": "http://localhost", "reasoning": false,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 4_000_000, "maxTokens": 4_000_000
    }))
    .unwrap();
    let delta = "x".repeat(20);
    let chunk = json!({"choices": [{"delta": {"content": delta}}]});
    for count in [1_000, 10_000, 100_000] {
        let output = crate::event_stream::initial_assistant_message(
            "openai-completions",
            "benchmark",
            "benchmark",
        );
        let mut state = StreamingState::new(output);
        let (writer, mut reader) = create_assistant_message_event_stream();
        let started = Instant::now();
        for _ in 0..count {
            handle_chunk(&chunk, &model, None, &mut state, &writer);
            let waker = futures::task::noop_waker_ref();
            let mut cx = std::task::Context::from_waker(waker);
            while let std::task::Poll::Ready(Some(_)) = reader.poll_next_event(&mut cx) {}
        }
        let duration = started.elapsed();
        let AssistantContent::Text(text) = &state.output.content[0] else {
            panic!("expected text block")
        };
        assert_eq!(text.text.len(), count * 20);
        eprintln!(
            "openai_completions count={count} delta_bytes=20 elapsed_ms={:.3}",
            duration.as_secs_f64() * 1000.0
        );
    }
}

#[test]
fn stream_event_snapshots() {
    let model: Model = serde_json::from_value(json!({
        "id": "parity", "name": "parity", "api": "openai-completions",
        "provider": "parity", "baseUrl": "http://localhost", "reasoning": true,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 128_000, "maxTokens": 8192
    }))
    .unwrap();
    let output =
        crate::event_stream::initial_assistant_message("openai-completions", "parity", "parity");
    let mut state = StreamingState::new(output);
    let (writer, mut reader) = create_assistant_message_event_stream();
    for chunk in [
        json!({"id":"req-1", "choices":[{"delta":{"content":"hello", "reasoning_content":"think"}}]}),
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"lookup","arguments":"{\"a\":"}}]}}]}),
        json!({"choices":[{"delta":{"content":" world","tool_calls":[{"index":0,"function":{"arguments":"1}"}}],"reasoning_details":[{"index":0,"type":"reasoning.encrypted","id":"call-1","data":"secret"}]}}]}),
        json!({"choices":[{"finish_reason":"stop","delta":{}}]}),
    ] {
        handle_chunk(&chunk, &model, None, &mut state, &writer);
    }
    finish_blocks(&mut state, &writer);
    let mut snapshots = Vec::new();
    let waker = futures::task::noop_waker_ref();
    let mut cx = std::task::Context::from_waker(waker);
    while let std::task::Poll::Ready(Some(event)) = reader.poll_next_event(&mut cx) {
        snapshots.push(serde_json::to_value(event).unwrap());
    }
    assert_eq!(snapshots.len(), 13);
    assert_eq!(snapshots[0]["type"], "thinking_start");
    assert_eq!(snapshots[2]["type"], "text_start");
    assert_eq!(snapshots[2]["partial"]["content"][1]["text"], "");
    assert_eq!(snapshots[3]["partial"]["content"][1]["text"], "hello");
    assert_eq!(snapshots[7]["partial"]["content"][1]["text"], "hello world");
    assert_eq!(
        snapshots.last().unwrap()["partial"]["content"][1]["text"],
        "hello world"
    );
    if std::env::var_os("PA_STREAM_PARITY_DUMP").is_some() {
        println!(
            "PARITY_SNAPSHOTS={}",
            serde_json::to_string(&snapshots).unwrap()
        );
    }
}

/// Feed each `reasoning_details` array as one delta and return the stream-end state.
fn stream_reasoning_details(deltas: &[Value]) -> StreamingState {
    let model: Model = serde_json::from_value(json!({
        "id": "parity", "name": "parity", "api": "openai-completions",
        "provider": "parity", "baseUrl": "http://localhost", "reasoning": true,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 128_000, "maxTokens": 8192
    }))
    .unwrap();
    let output =
        crate::event_stream::initial_assistant_message("openai-completions", "parity", "parity");
    let mut state = StreamingState::new(output);
    let (writer, _reader) = create_assistant_message_event_stream();
    for delta in deltas {
        handle_chunk(
            &json!({"choices":[{"delta": delta}]}),
            &model,
            None,
            &mut state,
            &writer,
        );
    }
    encode_reasoning_details_signature(&mut state);
    state
}

fn reasoning_signature(state: &StreamingState) -> Option<String> {
    let Some(AssistantContent::Thinking(block)) = state.output.content.last() else {
        panic!("expected the redacted thinking block");
    };
    block.thinking_signature.clone()
}

#[test]
fn reasoning_details_merge_by_index() {
    let state = stream_reasoning_details(&[
        json!({"reasoning_details": [{"type":"reasoning.text","text":"a","format":"unknown","index":0}]}),
        json!({"reasoning_details": [{"type":"reasoning.summary","summary":"s","text":"x","index":1}, {"text":"b","signature":null,"index":0}]}),
        json!({"reasoning_details": [{"text":7,"index":1}, {"text":"c","index":0}]}),
        json!({"reasoning_details": [{"summary":" t","text":"y","index":1}]}),
        json!({"reasoning_details": [{"type":"reasoning.encrypted","data":"e"}]}),
    ]);
    assert_eq!(
        reasoning_signature(&state),
        Some(encode_reasoning_details(&[
            json!({"type":"reasoning.text","text":"abc","format":"unknown","index":0,"signature":null}),
            json!({"type":"reasoning.summary","summary":"s t","text":"y","index":1}),
            json!({"type":"reasoning.encrypted","data":"e"}),
        ]))
    );
}

/// Gemini streams its reasoning text and its encrypted reasoning both at index 0. Merging them
/// into one record changes the replayed assistant message, so every next call branches.
#[test]
fn text_and_encrypted_details_at_the_same_index_stay_separate_records() {
    let encrypted = json!({"type":"reasoning.encrypted","data":"enc","id":"call-1","format":"google-gemini-v1","index":0});
    let state = stream_reasoning_details(&[
        json!({"tool_calls": [{"index":0,"id":"call-1","function":{"name":"lookup","arguments":"{}"}}]}),
        json!({"reasoning_details": [{"type":"reasoning.text","text":"think","format":"google-gemini-v1","index":0}]}),
        json!({"reasoning_details": [encrypted]}),
    ]);
    assert_eq!(
        reasoning_signature(&state),
        Some(encode_reasoning_details(&[
            json!({"type":"reasoning.text","text":"think","format":"google-gemini-v1","index":0}),
            encrypted.clone(),
        ]))
    );
    let AssistantContent::ToolCall(tool_call) = &state.output.content[0] else {
        panic!("expected the tool call block");
    };
    assert_eq!(tool_call.thought_signature, Some(encrypted.to_string()));
}

#[test]
fn text_fragments_with_the_same_type_and_index_concatenate() {
    let state = stream_reasoning_details(&[
        json!({"reasoning_details": [{"type":"reasoning.text","text":"thin","index":0}]}),
        json!({"reasoning_details": [{"type":"reasoning.text","text":"king","index":0}]}),
    ]);
    assert_eq!(
        reasoning_signature(&state),
        Some(encode_reasoning_details(&[
            json!({"type":"reasoning.text","text":"thinking","index":0}),
        ]))
    );
}

/// GPT and `DeepSeek` send one detail per index; their records are unchanged by the type key.
#[test]
fn one_detail_per_index_keeps_one_record_per_index() {
    let state = stream_reasoning_details(&[
        json!({"reasoning_details": [{"type":"reasoning.summary","summary":"plan","index":0}]}),
        json!({"reasoning_details": [{"summary":" more","index":0}]}),
        json!({"reasoning_details": [{"type":"reasoning.encrypted","data":"enc","index":1}]}),
    ]);
    assert_eq!(
        reasoning_signature(&state),
        Some(encode_reasoning_details(&[
            json!({"type":"reasoning.summary","summary":"plan more","index":0}),
            json!({"type":"reasoning.encrypted","data":"enc","index":1}),
        ]))
    );
}

#[tokio::test]
async fn abort_after_partial_preserves_content() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (request_seen_tx, request_seen) = tokio::sync::oneshot::channel::<()>();
    let (continue_stream_tx, continue_stream) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![0; 8192];
        let _ = socket.read(&mut request).await.unwrap();
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n";
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n", body.len()).as_bytes()).await.unwrap();
        let _ = request_seen_tx.send(());
        let _ = continue_stream.await;
    });
    let model: Model = serde_json::from_value(json!({
        "id": "abort", "name": "abort", "api": "openai-completions",
        "provider": "abort", "baseUrl": format!("http://{addr}"), "reasoning": false,
        "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 128_000, "maxTokens": 8192
    }))
    .unwrap();
    let token = tokio_util::sync::CancellationToken::new();
    let options = OpenAICompletionsOptions::from_base(crate::types::StreamOptions {
        api_key: Some("test".into()),
        signal: Some(token.clone()),
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
    request_seen.await.unwrap();
    loop {
        let event = reader.next_event().await.unwrap();
        if let AssistantMessageEvent::TextDelta { delta, partial, .. } = event {
            assert_eq!(delta, "partial");
            assert_eq!(
                serde_json::to_value(&partial.content[0]).unwrap()["text"],
                "partial"
            );
            break;
        }
    }
    token.cancel();
    let terminal = loop {
        let event = reader.next_event().await.unwrap();
        if let AssistantMessageEvent::Error { error, .. } = event {
            break error;
        }
    };
    assert_eq!(terminal.stop_reason, StopReason::Aborted);
    assert_eq!(
        serde_json::to_value(&terminal.content[0]).unwrap()["text"],
        "partial"
    );
    drop(continue_stream_tx);
}
