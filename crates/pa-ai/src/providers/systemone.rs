//! The System One structured-decision protocol (Prime Inference's
//! `/api/v1/systemone` endpoint, the hosted port of the old `TypeSafe`
//! endpoint): the decision request body POSTs to the model's `baseUrl` +
//! `/systemone` with the merged request auth, and the reply envelope
//! (`model` + `answers`) becomes the assistant text. The host (pa-core)
//! owns the request and response policy; this is one registered transport
//! among the provider set, not a bespoke client.
//!
//! The body rides verbatim, so the protocol's full contract holds: one
//! state plus a schema of typed questions, answered with a probability for
//! every allowed option of every question in a single forward pass (the
//! clef model card's joint schema head). The host currently composes the
//! single `action` question; a multi-question schema passes through
//! unchanged.

use crate::event_stream::{
    create_assistant_message_event_stream, AssistantMessageEventStream, AssistantMessageEventWriter,
};
use crate::types::{Context, Model, SimpleStreamOptions, StreamOptions};
use crate::Provider;
use pa_types::ai::{AssistantContentBlock, AssistantMessage, StopReason, TextContent, Usage};
use serde_json::Value;

/// One request round-trip's wall-clock bound when the caller sets none.
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// The error body's bounded excerpt.
const ERROR_BODY_CHARS: usize = 500;

pub struct SystemOneProvider;

impl Provider for SystemOneProvider {
    fn api(&self) -> &'static str {
        "systemone"
    }

    fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> AssistantMessageEventStream {
        let (writer, reader) = create_assistant_message_event_stream();
        let model = model.clone();
        let request = systemone_request_body(context);
        let options = options.cloned();
        tokio::spawn(async move {
            serve_systemone(&writer, &model, request, options.as_ref()).await;
        });
        reader
    }

    fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> AssistantMessageEventStream {
        self.stream(model, context, options.map(|options| &options.base))
    }
}

/// The decision request body: the newest user message's JSON text.
fn systemone_request_body(context: &Context) -> Value {
    context
        .messages
        .iter()
        .rev()
        .find_map(|message| match message {
            pa_types::ai::Message::User(user) => {
                let text = user.content.text();
                serde_json::from_str::<Value>(&text).ok()
            }
            _ => None,
        })
        .unwrap_or(Value::Null)
}

/// One POST to the systemone endpoint; the reply envelope (or the surfaced
/// HTTP error) ends the stream as the final assistant message.
async fn serve_systemone(
    writer: &AssistantMessageEventWriter,
    model: &Model,
    request: Value,
    options: Option<&StreamOptions>,
) {
    let timeout_ms = options
        .and_then(|options| options.timeout_ms)
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        "application/json".parse().unwrap(),
    );
    if let Some(api_key) = options.and_then(|options| options.api_key.as_deref()) {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(&format!("Bearer {api_key}")) {
            headers.insert(reqwest::header::AUTHORIZATION, value);
        }
    }
    for (name, value) in options
        .and_then(|options| options.headers.as_ref())
        .into_iter()
        .flatten()
    {
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_str(value),
        ) {
            headers.insert(name, value);
        }
    }
    let url = format!("{}/systemone", model.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .default_headers(headers)
        .build()
        .expect("systemone client builds");
    let response = client.post(&url).json(&request).send().await;
    let message = match response {
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if status.is_success() {
                envelope_message(model, body)
            } else {
                let detail: String = body.chars().take(ERROR_BODY_CHARS).collect();
                error_message(
                    model,
                    &format!("systemone returned HTTP {status}: {detail}"),
                )
            }
        }
        Err(error) => error_message(model, &format!("the systemone request failed: {error}")),
    };
    writer.end(Some(message));
}

/// The reply envelope as the final assistant message.
fn envelope_message(model: &Model, body: String) -> AssistantMessage {
    let mut message =
        crate::event_stream::initial_assistant_message("systemone", &model.provider, &model.id);
    message
        .content
        .push(AssistantContentBlock::Text(TextContent {
            text: body,
            text_signature: None,
            rest: serde_json::Map::default(),
        }));
    message.usage = Usage::default();
    message
}

/// The surfaced transport error as the final assistant message.
fn error_message(model: &Model, error: &str) -> AssistantMessage {
    let mut message =
        crate::event_stream::initial_assistant_message("systemone", &model.provider, &model.id);
    message.stop_reason = StopReason::Error;
    message.error_message = Some(error.to_string());
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_types::ai::{Message, UserContent, UserMessage};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// One request the loopback server received.
    #[derive(Debug, Clone)]
    struct Seen {
        path: String,
        authorization: Option<String>,
        team: Option<String>,
        body: Value,
    }

    /// A loopback server answering POST `<base>/systemone`.
    async fn serve(
        status: u16,
        reply: Value,
        seen: std::sync::Arc<std::sync::Mutex<Vec<Seen>>>,
    ) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut raw = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head, body) = loop {
                    let read = socket.read(&mut chunk).await.unwrap();
                    assert_ne!(read, 0, "the client closed mid-request");
                    raw.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&raw).to_string();
                    let Some((head, body)) = text.split_once("\r\n\r\n") else {
                        continue;
                    };
                    let length = head
                        .lines()
                        .find_map(|line| {
                            let line = line.to_ascii_lowercase();
                            line.strip_prefix("content-length:")?.trim().parse().ok()
                        })
                        .unwrap_or(0);
                    if body.len() >= length {
                        break (head.to_string(), body.to_string());
                    }
                };
                let path = head
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .split(' ')
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                let authorization = head.lines().find_map(|line| {
                    let line = line.to_ascii_lowercase();
                    line.strip_prefix("authorization:")
                        .map(|value| value.trim().to_string())
                });
                let team = head.lines().find_map(|line| {
                    let line = line.to_ascii_lowercase();
                    line.strip_prefix("x-prime-team-id:")
                        .map(|value| value.trim().to_string())
                });
                seen.lock().unwrap().push(Seen {
                    path,
                    authorization,
                    team,
                    body: serde_json::from_str(&body).unwrap_or(Value::Null),
                });
                let reply = reply.to_string();
                let response = format!(
                    "HTTP/1.1 {status} Status\r\ncontent-type: application/json\r\n\
                     content-length: {}\r\nconnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        base
    }

    fn fixture_model(base_url: &str) -> Model {
        serde_json::from_value(json!({
            "id": "cloudflare/clef", "name": "clef", "api": "systemone",
            "provider": "prime-inference", "baseUrl": base_url, "reasoning": false,
            "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 100_000, "maxTokens": 8192,
        }))
        .unwrap()
    }

    fn decision_context(request: &Value) -> Context {
        Context {
            system_prompt: None,
            messages: vec![Message::User(UserMessage {
                content: UserContent::Text(request.to_string()),
                timestamp: 0,
                rest: serde_json::Map::default(),
            })],
            tools: None,
        }
    }

    #[tokio::test]
    async fn posts_the_request_to_the_systemone_path_with_the_merged_auth() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let envelope = json!({
            "model": "cloudflare/clef",
            "answers": {"action": {"choice": "left", "confidence": 0.9, "probabilities": {"left": 0.9}}}
        });
        let base = serve(200, envelope.clone(), std::sync::Arc::clone(&seen)).await;
        let model = fixture_model(&base);
        let request = json!({
            "state": {"observation": {"x": 1}},
            "questions": {"action": {"type": "choice", "criteria": {"left": "go left"}}},
            "model": "cloudflare/clef"
        });
        let stream = SystemOneProvider.stream(
            &model,
            &decision_context(&request),
            Some(&StreamOptions {
                api_key: Some("test-key".to_string()),
                headers: Some(
                    [("X-Prime-Team-ID".to_string(), "team-1".to_string())]
                        .into_iter()
                        .collect(),
                ),
                timeout_ms: Some(5_000),
                ..Default::default()
            }),
        );
        let message = stream.result().await;
        assert_eq!(message.stop_reason, StopReason::Stop);
        let text = message
            .content
            .iter()
            .map(|block| match block {
                AssistantContentBlock::Text(text) => text.text.clone(),
                _ => String::new(),
            })
            .collect::<String>();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), envelope);
        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/systemone");
        assert_eq!(
            requests[0].authorization.as_deref(),
            Some("bearer test-key"),
            "the merged key rides the bearer header"
        );
        assert_eq!(
            requests[0].team.as_deref(),
            Some("team-1"),
            "the merged team header rides the request"
        );
        assert_eq!(
            requests[0].body, request,
            "the decision body rides verbatim"
        );
    }

    /// Clef's contract (the model card's joint schema head): one state
    /// plus a schema of typed questions, answered per question in one pass.
    /// The transport rides the schema verbatim; the host composes one
    /// question today.
    #[tokio::test]
    async fn a_multi_question_schema_rides_verbatim_and_answers_per_question() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let envelope = json!({
            "model": "cloudflare/clef",
            "answers": {
                "action": {"type": "choice", "choice": "left", "confidence": 0.9, "probabilities": {"left": 0.9, "right": 0.1}},
                "speed": {"type": "choice", "choice": "fast", "confidence": 0.6, "probabilities": {"fast": 0.6, "slow": 0.4}}
            }
        });
        let base = serve(200, envelope.clone(), std::sync::Arc::clone(&seen)).await;
        let model = fixture_model(&base);
        let request = json!({
            "state": {"frame": 1},
            "questions": {
                "action": {"type": "choice", "criteria": {"left": "go left", "right": "go right"}},
                "speed": {"type": "choice", "criteria": {"fast": "run", "slow": "crawl"}}
            },
            "model": "cloudflare/clef"
        });
        let stream = SystemOneProvider.stream(&model, &decision_context(&request), None);
        let message = stream.result().await;
        assert_eq!(message.stop_reason, StopReason::Stop);
        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].body, request, "the schema rides verbatim");
        let text = message
            .content
            .iter()
            .map(|block| match block {
                AssistantContentBlock::Text(text) => text.text.clone(),
                _ => String::new(),
            })
            .collect::<String>();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), envelope);
    }

    #[tokio::test]
    async fn http_errors_surface_as_the_error_stop_reason() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let base = serve(404, json!({"error": "no such model"}), seen).await;
        let model = fixture_model(&base);
        let stream =
            SystemOneProvider.stream(&model, &decision_context(&json!({"state": {}})), None);
        let message = stream.result().await;
        assert_eq!(message.stop_reason, StopReason::Error);
        let error = message.error_message.unwrap();
        assert!(error.contains("HTTP 404"), "{error}");
        assert!(error.contains("no such model"), "{error}");
    }
}
