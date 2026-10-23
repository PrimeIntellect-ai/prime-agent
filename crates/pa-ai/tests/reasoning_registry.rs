//! Public registry callers must get the same strict replay policy as the facade.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pa_ai::types::{Context, Model, SimpleStreamOptions, StopReason, StreamOptions, Usage};
use pa_ai::{Provider, ProviderRegistry};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const SIGNATURE: &str = "U1lOVEhFVElDX1NJR05BVFVSRQ==";

struct Capture {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Capture {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&requests);
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let body_start = loop {
                    let mut chunk = [0; 8192];
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&chunk[..count]);
                    if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n")
                    {
                        break index + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&request[..body_start]);
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|length| length.trim().parse().unwrap())
                    })
                    .unwrap();
                while request.len() < body_start + length {
                    let mut chunk = [0; 8192];
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&chunk[..count]);
                }
                observed.lock().unwrap().push(
                    serde_json::from_slice(&request[body_start..body_start + length]).unwrap(),
                );
                let sse = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"SYNTHETIC_COMPLETE\"}]},\"finishReason\":\"STOP\"}]}\n\n";
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{sse}", sse.len()).as_bytes()).await.unwrap();
            }
        });
        Self {
            url: format!("http://{address}"),
            requests,
            task,
        }
    }
}

fn model(api: &str, url: &str) -> Model {
    serde_json::from_value(json!({
        "id": "gemini-destination", "name": "Synthetic model", "api": api, "provider": api,
        "baseUrl": url, "reasoning": true, "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}, "contextWindow": 128_000, "maxTokens": 8192
    })).unwrap()
}

fn history(
    source_api: &str,
    source_provider: &str,
    source_model: &str,
    content: &Value,
) -> Context {
    Context {
        system_prompt: None,
        tools: None,
        messages: vec![serde_json::from_value(json!({
            "role": "assistant", "api": source_api, "provider": source_provider, "model": source_model,
            "timestamp": 0, "stopReason": "stop", "usage": Usage::default(), "content": content
        }))
        .unwrap()],
    }
}

fn lookup(api: &str, route: usize) -> Arc<dyn Provider> {
    pa_ai::registry::ensure_builtins();
    match route {
        0 => pa_ai::registry::get_api_provider(api).unwrap(),
        1 => ProviderRegistry.get(api).unwrap(),
        2 => pa_ai::registry::get_api_providers()
            .into_iter()
            .find(|provider| provider.api() == api)
            .unwrap(),
        3 => ProviderRegistry
            .all()
            .into_iter()
            .find(|provider| provider.api() == api)
            .unwrap(),
        _ => unreachable!(),
    }
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // One no-network matrix across public lookup and streaming routes.
async fn public_google_registry_rejects_unsupported_history_without_sending() {
    let capture = Capture::start().await;
    for api in [
        "google-generative-ai",
        "google-vertex",
        "openai-completions",
    ] {
        let target = model(api, &capture.url);
        let contexts = [
            history(
                api,
                api,
                "source-model",
                &json!([{ "type": "thinking", "thinking": "SYNTHETIC_PRIVATE_PLAN", "thinkingSignature": SIGNATURE }]),
            ),
            history(
                "anthropic-messages",
                "anthropic",
                "claude-source",
                &json!([{ "type": "thinking", "thinking": "", "thinkingSignature": "SYNTHETIC_NATIVE_SIGNATURE" }]),
            ),
            history(
                "google-generative-ai",
                "google-generative-ai",
                "source-model",
                &json!([{ "type": "text", "text": "SYNTHETIC_ANSWER", "textSignature": SIGNATURE }]),
            ),
            history(
                "openai-completions",
                "zai",
                "glm-source",
                &json!([{ "type": "thinking", "thinking": "SYNTHETIC_PRIVATE_PLAN", "thinkingSignature": "reasoning_content" }]),
            ),
        ];
        for context in contexts {
            let original = context.messages.clone();
            for route in 0..4 {
                let provider = lookup(api, route);
                let base = StreamOptions {
                    api_key: Some("fixture-only".into()),
                    ..Default::default()
                };
                for simple in [false, true] {
                    let stream = if simple {
                        provider.stream_simple(
                            &target,
                            &context,
                            Some(&SimpleStreamOptions {
                                base: base.clone(),
                                ..Default::default()
                            }),
                        )
                    } else {
                        provider.stream(&target, &context, Some(&base))
                    };
                    let output = tokio::time::timeout(Duration::from_secs(5), stream.result())
                        .await
                        .unwrap();
                    assert_eq!(context.messages, original);
                    assert!(
                        capture.requests.lock().unwrap().is_empty(),
                        "unsupported replay escaped the public registry boundary"
                    );
                    assert_eq!(output.stop_reason, StopReason::Error);
                    let error = output.error_message.unwrap();
                    assert!(error.contains("Cannot replay reasoning"), "{error}");
                    assert!(error.contains("or start a new session"), "{error}");
                }
            }
            assert!(pa_ai::stream(&target, &context, None).is_err());
            assert!(pa_ai::stream_simple(&target, &context, None).is_err());
        }
    }
}

#[tokio::test]
async fn same_model_google_signature_only_parts_keep_native_thinking_and_text_signatures() {
    let capture = Capture::start().await;
    for api in ["google-generative-ai", "google-vertex"] {
        let target = model(api, &capture.url);
        let context = history(
            api,
            api,
            &target.id,
            &json!([
                { "type": "thinking", "thinking": "", "thinkingSignature": SIGNATURE },
                { "type": "text", "text": "", "textSignature": SIGNATURE },
                { "type": "text", "text": "SYNTHETIC_ANSWER" }
            ]),
        );
        let original = context.messages.clone();
        let options = StreamOptions {
            api_key: Some("fixture-only".into()),
            ..Default::default()
        };
        let output = tokio::time::timeout(
            Duration::from_secs(5),
            lookup(api, 0)
                .stream(&target, &context, Some(&options))
                .result(),
        )
        .await
        .unwrap();
        assert_eq!(
            output.stop_reason,
            StopReason::Stop,
            "{:?}",
            output.error_message
        );
        assert_eq!(context.messages, original);
        assert_eq!(
            capture.requests.lock().unwrap().last().unwrap()["contents"],
            json!([
                {"role": "model", "parts": [
                    {"thought": true, "text": "", "thoughtSignature": SIGNATURE},
                    {"text": "", "thoughtSignature": SIGNATURE},
                    {"text": "SYNTHETIC_ANSWER"}
                ]}
            ])
        );
    }
}

#[tokio::test]
async fn public_registry_rejects_a_model_for_another_adapter_before_http() {
    let capture = Capture::start().await;
    let target = model("openai-completions", &capture.url);
    let context = Context::default();
    let options = StreamOptions {
        api_key: Some("fixture-only".into()),
        ..Default::default()
    };
    for api in ["google-generative-ai", "google-vertex"] {
        let provider = lookup(api, 0);
        let output = tokio::time::timeout(
            Duration::from_secs(5),
            provider.stream(&target, &context, Some(&options)).result(),
        )
        .await
        .unwrap();
        assert_eq!(output.stop_reason, StopReason::Error);
        assert!(output
            .error_message
            .unwrap()
            .contains("does not match model API"));
        assert!(capture.requests.lock().unwrap().is_empty());
        assert!(context.messages.is_empty());
    }
}
