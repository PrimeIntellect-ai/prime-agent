//! Wire-shape tests for the PostHog sink and flags client against a local
//! HTTP stub: batch endpoint path/body/headers, decide body, and the
//! offline-safe drop policy.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;

use pa_telemetry::{
    FlagsClient, PostHogEndpoint, PostHogSink, Properties, SinkOutcome, TelemetryEvent,
    TelemetrySink, VERSION,
};

/// One request captured by the stub.
struct StubRequest {
    request_line: String,
    headers: Vec<(String, String)>,
    body: serde_json::Value,
}

/// Serve `responses` (status, raw HTTP body) one per connection, capture each
/// request, and stop. Returns (base_url, receiver).
fn spawn_stub(responses: Vec<(u16, serde_json::Value)>) -> (String, mpsc::Receiver<StubRequest>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
    let addr = listener.local_addr().expect("stub addr");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for response in responses {
            let (mut stream, _) = listener.accept().expect("accept");
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
                read_total += n;
                request.push_str(&String::from_utf8_lossy(&buffer[..n]));
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

fn event(name: &str) -> TelemetryEvent {
    let mut properties = Properties::new();
    properties.set("version", serde_json::Value::from("9.9.9"));
    properties.set("outcome", serde_json::Value::from("success"));
    TelemetryEvent::new(name, properties)
}

#[tokio::test]
async fn batch_hits_capture_endpoint_with_documented_wire_shape() {
    let (base, rx) = spawn_stub(vec![(200, serde_json::json!({ "status": 1 }))]);
    let endpoint = PostHogEndpoint::new(&base, "phc-test-key");
    let sink = PostHogSink::new(&endpoint);
    let outcome = sink
        .send_batch(
            "install-1",
            vec![event("agent started"), event("tool executed")],
        )
        .await;
    assert_eq!(outcome, SinkOutcome::Sent);
    let request = rx.recv().expect("stub captured request");
    assert!(request.request_line.starts_with("POST /batch/ "));
    assert_eq!(
        header(&request.headers, "user-agent"),
        Some(format!("prime-agent/{VERSION}").as_str())
    );
    assert_eq!(
        header(&request.headers, "content-type"),
        Some("application/json")
    );
    assert_eq!(request.body["api_key"], "phc-test-key");
    let batch = request.body["batch"].as_array().expect("batch array");
    assert_eq!(batch.len(), 2);
    assert_eq!(batch[0]["event"], "agent started");
    assert_eq!(batch[0]["distinct_id"], "install-1");
    assert_eq!(batch[0]["properties"]["version"], "9.9.9");
    assert_eq!(batch[0]["properties"]["outcome"], "success");
    assert!(batch[0]["timestamp"]
        .as_str()
        .expect("timestamp")
        .ends_with('Z'));
}

#[tokio::test]
async fn non_success_status_drops_the_batch() {
    let (base, rx) = spawn_stub(vec![(500, serde_json::json!({ "status": 0 }))]);
    let endpoint = PostHogEndpoint::new(&base, "phc-test-key");
    let sink = PostHogSink::new(&endpoint);
    let outcome = sink
        .send_batch("install-1", vec![event("agent started")])
        .await;
    assert_eq!(outcome, SinkOutcome::Dropped);
    let _ = rx.recv().expect("stub captured request");
}

#[tokio::test]
async fn flags_client_decides_with_distinct_id() {
    let (base, rx) = spawn_stub(vec![(
        200,
        serde_json::json!({
            "featureFlags": {
                "new_engine": true,
                "legacy_mode": false,
                "variant": "control"
            }
        }),
    )]);
    let endpoint = PostHogEndpoint::new(&base, "phc-test-key");
    let flags = FlagsClient::new(&endpoint, "install-1");
    // First call refetches (cache empty), then serves the flag.
    assert!(flags.flag_enabled("new_engine", false).await);
    assert!(!flags.flag_enabled("legacy_mode", true).await);
    assert!(flags.flag_enabled("variant", false).await);
    assert!(!flags.flag_enabled("absent", false).await);
    let request = rx.recv().expect("stub captured decide request");
    assert!(request.request_line.starts_with("POST /decide/?v=3 "));
    assert_eq!(request.body["api_key"], "phc-test-key");
    assert_eq!(request.body["distinct_id"], "install-1");
    // Cache is now warm: a second lookup must not hit the stub again.
    assert!(flags.flag_enabled("new_engine", false).await);
}
