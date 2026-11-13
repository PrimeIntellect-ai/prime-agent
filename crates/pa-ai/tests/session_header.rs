use pa_ai::types::{SimpleStreamOptions, StreamOptions};
use pa_types::ai::{Context, Model};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Issue one request against a local capture server and return its wire headers.
async fn capture(api: &str, session_id: Option<&str>) -> Vec<(String, String)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buf = [0; 4096];
        while !request.windows(4).any(|b| b == b"\r\n\r\n") {
            let count = socket.read(&mut buf).await.unwrap();
            assert!(count > 0);
            request.extend_from_slice(&buf[..count]);
        }
        socket
            .write_all(
                b"HTTP/1.1 400 Bad Request\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            )
            .await
            .unwrap();
        String::from_utf8(request)
            .unwrap()
            .split("\r\n\r\n")
            .next()
            .unwrap()
            .lines()
            .skip(1)
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_string()))
            .collect::<Vec<_>>()
    });
    let model: Model = serde_json::from_value(json!({
        "id":"test-model", "name":"Test", "provider":"prime-inference", "api":api,
        "baseUrl":format!("http://{address}"), "reasoning":false, "input":["text"],
        "contextWindow":10000, "maxTokens":100,
        "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}
    }))
    .unwrap();
    let options = SimpleStreamOptions::from_base(StreamOptions {
        api_key: Some("synthetic-only".into()),
        session_id: session_id.map(str::to_string),
        timeout_ms: Some(5_000),
        ..Default::default()
    });
    let context = Context {
        system_prompt: None,
        messages: vec![],
        tools: None,
    };
    let _ = pa_ai::complete_simple(&model, &context, Some(options))
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), server)
        .await
        .unwrap()
        .unwrap()
}

/// A session-scoped request declares its session identity on the wire, on every transport.
#[tokio::test]
async fn session_identity_header_reaches_every_transport() {
    for api in [
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
        "google-generative-ai",
        "mistral-conversations",
    ] {
        let headers = capture(api, Some("conversation")).await;
        assert_eq!(
            headers
                .iter()
                .filter(|(name, _)| name == "x-pi-session-id")
                .map(|(_, value)| value.as_str())
                .collect::<Vec<_>>(),
            vec!["conversation"],
            "{api}"
        );
    }
}

/// A session-less request fabricates no identity (`OTel GenAI`: gateways must not invent ids).
#[tokio::test]
async fn session_less_request_carries_no_session_identity_header() {
    for api in ["openai-completions", "openai-responses"] {
        let headers = capture(api, None).await;
        assert!(
            headers.iter().all(|(name, _)| name != "x-pi-session-id"),
            "{api}: {headers:?}"
        );
    }
}
