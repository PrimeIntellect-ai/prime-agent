//! The #755 output-budget wire pins: the request body's output budget
//! carries an explicitly configured `maxTokens` unchanged, a catalog
//! value stays capped at the default 32000 ceiling, and a model with no
//! declared max output sends no budget field at all (issue #755's
//! captured bodies; the TS fix PR's `max-tokens.test.ts` behavior, pinned
//! at the provider wire instead of the option assembly).

use super::*;
use std::sync::{Arc, Mutex};

/// The reporter's model (issue #755: a vLLM-served GLM configured in
/// models.json with `"maxTokens": 131072` and the OpenAI-completions
/// compat the captured bodies show). The `maxTokensExplicit` flag is what
/// the models.json parse attaches to a configured value.
fn glm_model(max_tokens: u64, explicit: bool) -> Value {
    json!({
        "id": "glm-5.2", "name": "GLM 5.2", "api": "openai-completions",
        "provider": "glm-h200", "reasoning": true, "input": ["text"],
        "cost": { "input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0 },
        "contextWindow": 393_216, "maxTokens": max_tokens,
        "compat": {
            "supportsDeveloperRole": false, "supportsReasoningEffort": false,
            "maxTokensField": "max_tokens", "thinkingFormat": "qwen-chat-template"
        },
        "maxTokensExplicit": explicit,
    })
}

/// Serve one SSE response body for the provider's POST, capturing the raw
/// request bytes it sent (the issue's logging-proxy capture, in-process).
async fn serve_sse_capturing(body: String) -> (SocketAddr, Arc<Mutex<Vec<u8>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let captured: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&captured);
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut head_end = None;
        let mut content_length = 0usize;
        loop {
            let read = socket.read(&mut chunk).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
            if head_end.is_none() {
                if let Some(pos) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    head_end = Some(pos + 4);
                    let head = String::from_utf8_lossy(&request[..pos]).to_lowercase();
                    content_length = head
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse().ok())
                        })
                        .unwrap_or(0);
                }
            }
            if let Some(end) = head_end {
                if request.len() >= end + content_length {
                    break;
                }
            }
        }
        *sink.lock().unwrap() = request;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    });
    (addr, captured)
}

/// One SSE body ending in the terminal marker, over `chunks`.
fn sse_body(chunks: &[Value]) -> String {
    use std::fmt::Write as _;
    let mut body = String::new();
    for chunk in chunks {
        let _ = write!(body, "data: {chunk}\n\n");
    }
    let _ = write!(body, "data: [DONE]\n\n");
    body
}

/// The captured POST body as JSON (the request head stripped).
fn request_body_json(request: &[u8]) -> Value {
    let text = String::from_utf8_lossy(request);
    let (_, body) = text
        .split_once("\r\n\r\n")
        .expect("the captured request carries its head");
    serde_json::from_str(body).expect("the captured request body is JSON")
}

/// Stream one minimal completion against `model` and return the JSON body
/// the provider put on the wire.
async fn wire_body_for(model: Value) -> Value {
    let body = sse_body(&[json!({
        "id": "m", "object": "chat.completion.chunk", "model": model["id"],
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
        "usage": { "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2 }
    })]);
    let (addr, captured) = serve_sse_capturing(body).await;
    let mut model = model;
    model["baseUrl"] = json!(format!("http://{addr}"));
    let model: Model = serde_json::from_value(model).unwrap();
    // The product path: the daemon's stream call goes through the SIMPLE
    // provider entry (`build_base_options` fills the per-model default
    // output budget there), so this is the request shape a real turn sends.
    let simple = crate::types::SimpleStreamOptions {
        base: crate::types::StreamOptions {
            api_key: Some("test".into()),
            ..Default::default()
        },
        ..Default::default()
    };
    let mut reader = crate::providers::openai_completions::stream_simple_openai_completions(
        &model,
        &Context {
            system_prompt: None,
            messages: vec![],
            tools: None,
        },
        Some(&simple),
    );
    loop {
        match reader.next_event().await.unwrap() {
            AssistantMessageEvent::Done { .. } => break,
            AssistantMessageEvent::Error { error, .. } => {
                panic!("stream failed: {:?}", error.error_message)
            }
            _ => {}
        }
    }
    let request = captured.lock().unwrap().clone();
    request_body_json(&request)
}

#[tokio::test]
async fn an_explicitly_configured_max_tokens_reaches_the_wire_unchanged() {
    // Issue #755's exact configuration: a models.json entry asking for
    // `"maxTokens": 131072`. The configured cap reaches the provider
    // unchanged — the captured body must not show the silent 32000.
    let body = wire_body_for(glm_model(131_072, true)).await;
    assert_eq!(body["max_tokens"], json!(131_072));
}

#[tokio::test]
async fn a_catalog_model_stays_capped_at_the_default_output_ceiling() {
    // The untouched default: a catalog model's declared maxTokens is a
    // ceiling the request clamps to 32000 (TS `DEFAULT_MAX_OUTPUT_TOKENS`)
    // — most catalog models declare far more than a turn needs, so their
    // request size must not change.
    let body = wire_body_for(glm_model(131_072, false)).await;
    assert_eq!(body["max_tokens"], json!(32_000));
}

#[tokio::test]
async fn a_model_without_max_tokens_sends_no_output_budget() {
    // A model that declares no max output (0) sends neither budget field:
    // the provider defaults server-side.
    let body = wire_body_for(glm_model(0, false)).await;
    assert!(body.get("max_tokens").is_none());
    assert!(body.get("max_completion_tokens").is_none());
}
