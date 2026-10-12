//! Wire tests for the default analytics sink against a local HTTP stub: the
//! exact TS `TelemetryClient` request (path, headers, body), the batching
//! client's delivery through it, and the drop policy.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{mpsc, Arc};
use std::time::Duration;

use pa_telemetry::{
    AnalyticsSink, Properties, SinkOutcome, TelemetryClient, TelemetryClientConfig, TelemetryEvent,
    TelemetrySink,
};
use serde_json::json;

const INSTALL_ID: &str = "0b5f4c1e-6a59-4c6e-9d3a-2f1e8b7c9a10";

fn event(name: &str) -> TelemetryEvent {
    let mut properties = Properties::new();
    properties.set("version", json!("9.9.9"));
    properties.set("outcome", json!("success"));
    properties.set("visible_ttft_ms", serde_json::Value::Null);
    TelemetryEvent::new(name, properties)
}

/// The TS body, field for field: `{installation_id, events: [{id, name,
/// timestamp, properties}]}` and nothing else.
fn ts_body(events: &[TelemetryEvent]) -> serde_json::Value {
    json!({
        "installation_id": INSTALL_ID,
        "events": events
            .iter()
            .map(|event| json!({
                "id": event.id,
                "name": event.name,
                "timestamp": event.timestamp_iso8601(),
                "properties": event
                    .properties
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<serde_json::Map<_, _>>(),
            }))
            .collect::<Vec<_>>(),
    })
}

#[tokio::test]
async fn batch_posts_the_exact_ts_request() {
    // The binary's runtime version (a beta restamps only the packaged
    // manifest) rides the User-Agent and every event, not the crate's.
    pa_telemetry::set_version("0.9.9-beta.3");
    assert_eq!(
        pa_telemetry::base_properties("print").get("version"),
        Some(&json!("0.9.9-beta.3"))
    );
    let (base, rx) = spawn_stub(vec![(202, json!({ "accepted": 2 }))]);
    let sink = AnalyticsSink::new(format!("{base}/api/v1/agent-analytics/events"));
    let events = vec![event("agent started"), event("agent run completed")];
    let outcome = sink.send_batch(INSTALL_ID, events.clone()).await;
    assert_eq!(outcome, SinkOutcome::Sent);

    let request = rx.recv().expect("stub captured request");
    assert!(request
        .request_line
        .starts_with("POST /api/v1/agent-analytics/events "));
    assert_eq!(
        header(&request.headers, "content-type"),
        Some("application/json")
    );
    assert_eq!(
        header(&request.headers, "user-agent"),
        Some("prime-agent/0.9.9-beta.3")
    );
    assert_eq!(header(&request.headers, "authorization"), None);
    assert_eq!(request.body, ts_body(&events));

    let first = &request.body["events"][0];
    assert!(uuid_v4(first["id"].as_str().unwrap()));
    let timestamp = first["timestamp"].as_str().unwrap();
    // `new Date().toISOString()`: millisecond precision, UTC `Z`.
    assert_eq!(timestamp.len(), "2026-10-01T12:00:00.000Z".len());
    assert!(timestamp.ends_with('Z'));
}

#[tokio::test]
async fn the_client_batches_through_the_sink() {
    let (base, rx) = spawn_stub(vec![(202, json!({ "accepted": 2 }))]);
    let mut config = TelemetryClientConfig::new(INSTALL_ID);
    config.flush_interval = Duration::from_mins(1);
    config.sinks = vec![Arc::new(AnalyticsSink::new(base)) as Arc<dyn TelemetrySink>];
    let client = TelemetryClient::spawn(config).unwrap();
    client.track("agent command used", properties("command_name", "model"));
    client.track("agent command used", properties("command_name", "resume"));
    client.flush().await.unwrap();

    let request = rx.recv().expect("one request for both events");
    assert_eq!(request.body["installation_id"], INSTALL_ID);
    let events = request.body["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["name"], "agent command used");
    assert_eq!(events[0]["properties"]["command_name"], "model");
    assert_eq!(events[1]["properties"]["command_name"], "resume");
    assert_ne!(events[0]["id"], events[1]["id"]);
    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn failures_drop_the_batch() {
    let (base, rx) = spawn_stub(vec![
        (500, json!({ "detail": "boom" })),
        // The backend's answer when its PostHog delivery failed.
        (202, json!({ "accepted": 0 })),
    ]);
    let sink = AnalyticsSink::new(base);
    assert_eq!(
        sink.send_batch(INSTALL_ID, vec![event("agent started")])
            .await,
        SinkOutcome::Dropped
    );
    assert_eq!(
        sink.send_batch(INSTALL_ID, vec![event("agent started")])
            .await,
        SinkOutcome::Dropped
    );
    assert_eq!(rx.iter().take(2).count(), 2);
}

#[tokio::test]
async fn an_unreachable_endpoint_times_out_as_a_drop() {
    // A listener that never answers: the request timeout bounds the send.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let sink = AnalyticsSink::with_timeout(
        format!("http://{}", listener.local_addr().unwrap()),
        Duration::from_millis(200),
    );
    let started = std::time::Instant::now();
    let outcome = sink
        .send_batch(INSTALL_ID, vec![event("agent started")])
        .await;
    assert_eq!(outcome, SinkOutcome::Dropped);
    assert!(started.elapsed() < Duration::from_secs(5));
}

fn properties(key: &str, value: &str) -> Properties {
    let mut properties = Properties::new();
    properties.set(key, json!(value));
    properties
}

fn uuid_v4(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.get_version_num() == 4)
}

/// One request captured by the stub.
struct StubRequest {
    request_line: String,
    headers: Vec<(String, String)>,
    body: serde_json::Value,
}

/// Serve `responses` (status, raw HTTP body) one per connection, capture each
/// request, and stop. Returns (`base_url`, receiver).
fn spawn_stub(responses: Vec<(u16, serde_json::Value)>) -> (String, mpsc::Receiver<StubRequest>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
    let addr = listener.local_addr().expect("stub addr");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for response in responses {
            let (mut stream, _) = listener.accept().expect("accept");
            // 64 KiB read buffer on a dedicated stub thread is fine for a test.
            #[allow(clippy::large_stack_arrays)]
            let mut buffer = [0u8; 64 * 1024];
            let mut read_total = 0usize;
            let mut request = String::new();
            loop {
                let n = stream
                    .read(&mut buffer[read_total..])
                    .expect("read request");
                if n == 0 {
                    break;
                }
                request.push_str(&String::from_utf8_lossy(
                    &buffer[read_total..read_total + n],
                ));
                read_total += n;
                let header_end = request.find("\r\n\r\n").expect("headers terminator");
                if let Some(len) = content_length(&request[..header_end]) {
                    let body_start = header_end + 4;
                    if request.len() - body_start >= len {
                        break;
                    }
                }
            }
            let header_end = request.find("\r\n\r\n").expect("headers terminator");
            let header_text = &request[..header_end];
            let request_line = header_text.lines().next().unwrap_or_default().to_string();
            let headers: Vec<(String, String)> = header_text
                .lines()
                .skip(1)
                .filter_map(|line| line.split_once(':'))
                .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
                .collect();
            let body_text = &request[header_end + 4..];
            let body: serde_json::Value =
                serde_json::from_str(body_text).unwrap_or(serde_json::Value::Null);
            tx.send(StubRequest {
                request_line,
                headers,
                body,
            })
            .expect("send captured request");
            let payload = serde_json::to_string(&response.1).expect("serialize stub response");
            let status = response.0;
            let reply = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                payload.len()
            );
            stream
                .write_all(reply.as_bytes())
                .expect("write stub response");
        }
    });
    (format!("http://{addr}"), rx)
}

fn content_length(header_text: &str) -> Option<usize> {
    for line in header_text.lines() {
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                return value.trim().parse().ok();
            }
        }
    }
    None
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(candidate, _)| candidate == name)
        .map(|(_, value)| value.as_str())
}
