//! A real custom-provider autonomous invocation retains ordinary usage telemetry.
//! The HTTP provider is loopback; a debug binary has no production telemetry sink.
#![cfg(unix)]

use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "requires a binary without a production telemetry endpoint"
)]
#[allow(clippy::too_many_lines)] // One full invocation keeps provider, subprocess, and telemetry assertions together.
async fn tiny_custom_provider_autonomous_runs_remain_counted() {
    assert!(pa_core::session_engine::telemetry::telemetry_endpoint().is_none());
    let home = tempfile::tempdir().unwrap();
    let agent_dir = home.path().join("agent");
    std::fs::create_dir(&agent_dir).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    std::fs::write(
        agent_dir.join("models.json"),
        json!({"providers": {
            "custom-automation": {"api": "openai-completions", "baseUrl": endpoint,
                "apiKey": "fixture-only", "models": [{"id": "custom-1", "name": "Custom 1",
                    "reasoning": false, "contextWindow": 128_000, "maxTokens": 1024}]}
        }})
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({
            "prewarmPythonKernel": false, "compaction": {"enabled": false},
            "telemetry": {"enabled": true, "noticeShown": true}
        })
        .to_string(),
    )
    .unwrap();
    // Print mode batches telemetry and finalizes the preceding run when the
    // next prompt starts. Hold that next provider response until the first
    // completed run reaches the local mirror, before the process exits.
    let (resume, paused) = tokio::sync::oneshot::channel();
    let provider = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(30), async move {
            let mut paused = Some(paused);
            for request_index in 0..2 {
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut content_length = 0;
                loop {
                    let mut line = String::new();
                    assert!(stream.read_line(&mut line).await.unwrap() > 0);
                    if line == "\r\n" { break; }
                    if let Some((_, value)) = line.split_once(':')
                        .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                    {
                        content_length = value.trim().parse::<usize>().unwrap();
                    }
                }
                let mut body = vec![0; content_length];
                stream.read_exact(&mut body).await.unwrap();
                let request: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(request["model"], "custom-1");
                if request_index == 1 {
                    paused.take().unwrap().await.unwrap();
                }
                let chunk = json!({"id": "fixture", "object": "chat.completion.chunk",
                    "choices": [{"index": 0, "delta": {"role": "assistant", "content": "done"},
                        "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 1, "total_tokens": 11}});
                let body = format!("data: {chunk}\n\ndata: [DONE]\n\n");
                let response = format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                stream.get_mut().write_all(response.as_bytes()).await.unwrap();
            }
        }).await.expect("the product contacts the loopback provider");
    });
    let child = tokio::process::Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .args([
            "--provider",
            "custom-automation",
            "--model",
            "custom-1",
            "--autonomous",
            "--autonomous-gate",
            "true",
            "--autonomous-max-turns",
            "2",
            "--no-session",
            "-p",
            "complete the work",
            "confirm the result",
        ])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", home.path())
        .env("TMPDIR", home.path())
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        .env("DO_NOT_TRACK", "0")
        .env("PI_OFFLINE", "0")
        .env("PRIME_AGENT_TELEMETRY", "1")
        .env("PI_SKIP_VERSION_CHECK", "1")
        .current_dir(home.path())
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let runs = tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            if let Ok(mirror) = std::fs::read_to_string(agent_dir.join("telemetry.jsonl")) {
                let runs: Vec<Value> = mirror.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .filter(|event| event["name"] == "agent run completed")
                    .map(|event| {
                        let props = &event["properties"];
                        json!({"origin": props["workload_origin"], "provider": props["provider_category"],
                            "input": props["input_tokens"], "output": props["output_tokens"], "total": props["total_tokens"]})
                    }).collect();
                if !runs.is_empty() { break runs; }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }).await.expect("the completed autonomous run reaches the local mirror");
    resume.send(()).unwrap();
    let output = tokio::time::timeout(Duration::from_secs(45), child.wait_with_output())
        .await
        .expect("the bounded autonomous invocation exits")
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "done");
    provider.await.unwrap();
    assert_eq!(
        runs,
        vec![
            json!({"origin": "automated", "provider": "custom", "input": 10, "output": 1, "total": 11})
        ]
    );
}
