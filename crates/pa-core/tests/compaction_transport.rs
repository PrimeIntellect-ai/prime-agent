//! Synthetic-provider regressions for summary and refinement request controls and cancellation.
use std::time::Duration;

use pa_core::session_engine::branch_summarization::{
    generate_branch_summary, GenerateBranchSummaryOptions, DEFAULT_BRANCH_RESERVE_TOKENS,
};
use pa_core::session_engine::compaction_exec::complete_summary_call;
use pa_core::session_engine::refine::default_refiner_call;
use pa_types::session::{AgentMessage, EntryBase, FileEntry};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Clone, Copy)]
enum Reply {
    Complete,
    HangBeforeHeaders,
    HangAfterDelta,
}

async fn mock_summary(
    reply: Reply,
) -> (
    pa_types::ai::Model,
    tokio::sync::oneshot::Receiver<Value>,
    tokio::task::JoinHandle<bool>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (request_tx, request_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let body = loop {
            let mut buffer = [0; 4096];
            let count = socket.read(&mut buffer).await.unwrap();
            assert_ne!(count, 0);
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= end + 4 + length {
                    break serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
                }
            }
        };
        match reply {
            Reply::Complete | Reply::HangAfterDelta => {
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                let delta = json!({"id":"mock","object":"chat.completion.chunk","created":0,"model":"mock","choices":[{"index":0,"delta":{"role":"assistant","content":"summary"},"finish_reason":null}]});
                socket
                    .write_all(format!("data: {delta}\n\n").as_bytes())
                    .await
                    .unwrap();
            }
            Reply::HangBeforeHeaders => {}
        }
        request_tx.send(body).unwrap();
        match reply {
            Reply::Complete => {
                let done = json!({"id":"mock","object":"chat.completion.chunk","created":0,"model":"mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
                socket
                    .write_all(format!("data: {done}\n\ndata: [DONE]\n\n").as_bytes())
                    .await
                    .unwrap();
                true
            }
            Reply::HangBeforeHeaders | Reply::HangAfterDelta => {
                let mut byte = [0];
                matches!(
                    tokio::time::timeout(Duration::from_secs(2), socket.read(&mut byte)).await,
                    Ok(Ok(0) | Err(_))
                )
            }
        }
    });
    let model = serde_json::from_value(json!({
        "id":"mock-glm","name":"mock-glm","provider":"synthetic","api":"openai-completions",
        "baseUrl":format!("http://{address}/v1"),"reasoning":true,"input":["text"],
        "contextWindow":32000,"maxTokens":2048,
        "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},
        "thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},
        "compat":{"thinkingFormat":"zai"}
    })).unwrap();
    (model, request_rx, server)
}

#[tokio::test]
async fn summary_respects_mandatory_thinking() {
    let (model, request, server) = mock_summary(Reply::Complete).await;
    let summary = complete_summary_call(
        &model,
        "synthetic-session",
        Some("synthetic-key".into()),
        None,
        512,
        Vec::new(),
        None,
        "summary failed",
    )
    .await
    .unwrap();
    assert_eq!(summary.summary, "summary");
    assert_eq!(request.await.unwrap()["enable_thinking"], json!(true));
    assert!(server.await.unwrap());
}

#[tokio::test]
async fn dropped_summary_closes_hung_transport() {
    for reply in [Reply::HangBeforeHeaders, Reply::HangAfterDelta] {
        let (model, request, server) = mock_summary(reply).await;
        let (delta_tx, mut delta_rx) = tokio::sync::mpsc::unbounded_channel();
        let on_delta = matches!(reply, Reply::HangAfterDelta).then(|| {
            std::sync::Arc::new(move |delta: &str| {
                delta_tx.send(delta.to_owned()).unwrap();
            }) as pa_core::session_engine::compaction_exec::SummaryDeltaSink
        });
        let task = tokio::spawn(async move {
            complete_summary_call(
                &model,
                "synthetic-session",
                Some("synthetic-key".into()),
                None,
                512,
                Vec::new(),
                on_delta,
                "summary failed",
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), request)
            .await
            .unwrap()
            .unwrap();
        if matches!(reply, Reply::HangAfterDelta) {
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(5), delta_rx.recv())
                    .await
                    .unwrap(),
                Some("summary".into())
            );
        }
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(
            server.await.unwrap(),
            "cancelled summary left its provider connection alive"
        );
    }
}

#[tokio::test]
async fn summary_preserves_unspecified_reasoning_when_off_is_supported() {
    for map in [
        json!({"off":"none","low":"low"}),
        json!({"off":null,"minimal":null,"low":null,"medium":null,"high":null,"xhigh":null,"max":null}),
    ] {
        let (model, request, server) = mock_summary(Reply::Complete).await;
        let mut wire = serde_json::to_value(model).unwrap();
        wire["thinkingLevelMap"] = map;
        wire["compat"] = json!({"thinkingFormat":"openai","supportsReasoningEffort":true});
        let model = serde_json::from_value(wire).unwrap();
        complete_summary_call(
            &model,
            "synthetic-session",
            Some("synthetic-key".into()),
            None,
            512,
            Vec::new(),
            None,
            "summary failed",
        )
        .await
        .unwrap();
        assert!(request.await.unwrap().get("reasoning_effort").is_none());
        assert!(server.await.unwrap());
    }
}

#[tokio::test]
async fn branch_summary_respects_mandatory_thinking() {
    let (model, request, server) = mock_summary(Reply::Complete).await;
    let entries = [FileEntry::Message {
        message: AgentMessage::User(pa_types::ai::UserMessage {
            content: pa_types::ai::UserContent::Text("explored a side branch".to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        }),
        base: EntryBase {
            id: Some("u1".to_string()),
            parent_id: None,
            timestamp: Some("2024-01-01T00:00:00.000Z".to_string()),
            rest: serde_json::Map::default(),
        },
    }];
    let result = generate_branch_summary(
        &entries,
        GenerateBranchSummaryOptions {
            model: &model,
            api_key: Some("synthetic-key".into()),
            custom_instructions: None,
            replace_instructions: false,
            reserve_tokens: DEFAULT_BRANCH_RESERVE_TOKENS,
            auxiliary: None,
        },
    )
    .await;
    assert_eq!(result.error, None, "branch summary failed: {result:?}");
    assert!(result
        .summary
        .as_deref()
        .unwrap_or_default()
        .contains("summary"));
    assert_eq!(request.await.unwrap()["enable_thinking"], json!(true));
    assert!(server.await.unwrap());
}

#[tokio::test]
async fn refiner_call_respects_mandatory_thinking() {
    let (model, request, server) = mock_summary(Reply::Complete).await;
    let reply =
        default_refiner_call(Some("synthetic-key".into()))(model, "system", "prompt".into())
            .await
            .unwrap();
    assert!(matches!(
        reply.content.as_slice(),
        [pa_types::ai::AssistantContentBlock::Text(text)] if text.text == "summary"
    ));
    assert_eq!(request.await.unwrap()["enable_thinking"], json!(true));
    assert!(server.await.unwrap());
}
