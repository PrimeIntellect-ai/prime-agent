//! End-to-end verifier for provider failover: a daemon worker session whose
//! model is served by two configured providers. When the primary provider
//! exhausts its quick retries, the turn must re-route to the next configured
//! provider serving the same model (the `reason: "backup"` retry event),
//! succeed there, and restore the primary (`restoredModel`). With every
//! provider failing, the chain walks all candidates and surfaces the final
//! failure like the single-provider loop does.
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Supervisor {
    child: Child,
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A mock OpenAI-completions provider: the first `failures` requests get a
/// 500 with an OpenAI-style error body; the rest get one fixed SSE answer.
struct FailingMock {
    requests: Arc<Mutex<usize>>,
    port: u16,
}

impl FailingMock {
    fn start(failures: usize, answer: &'static str) -> FailingMock {
        let requests = Arc::new(Mutex::new(0usize));
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().expect("mock addr").port();
        let requests_for_thread = Arc::clone(&requests);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let requests = Arc::clone(&requests_for_thread);
                std::thread::spawn(move || {
                    let _ = serve(stream, failures, answer, requests);
                });
            }
        });
        FailingMock { requests, port }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    fn count(&self) -> usize {
        *self.requests.lock().expect("mock lock")
    }
}

fn chunk(delta: Value, finish_reason: Option<&str>) -> String {
    json!({
        "id": "chatcmpl-test",
        "object": "chat.completion.chunk",
        "created": 1_750_000_000,
        "model": "mock-1",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    })
    .to_string()
}

fn serve(
    mut stream: TcpStream,
    failures: usize,
    answer: &str,
    requests: Arc<Mutex<usize>>,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut head = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        head.push_str(&line);
        if line == "\r\n" {
            break;
        }
    }
    let mut content_length = 0usize;
    for line in head.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or_default();
        }
    }
    let mut body_bytes = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body_bytes)?;
    }
    let index = {
        let mut requests = requests.lock().expect("mock lock");
        *requests += 1;
        *requests
    };
    if index <= failures {
        let body = json!({
            "error": { "message": "mock provider overloaded", "type": "server_error", "code": 500 }
        })
        .to_string();
        return stream.write_all(
            format!(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        );
    }
    let mut payload = String::new();
    for data in [
        chunk(json!({"role": "assistant", "content": answer}), None),
        chunk(json!({}), Some("stop")),
    ] {
        write!(payload, "data: {data}\n\n").expect("write to String");
    }
    payload.push_str("data: [DONE]\n\n");
    stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}"
        )
        .as_bytes(),
    )
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path) -> Supervisor {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(if std::env::var_os("PA_FAILOVER_E2E_DEBUG").is_some() {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .env_remove("PRIME_API_KEY")
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if socket.exists() {
            return Supervisor {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

/// One client connection: request/response plus every session event that
/// streamed while the response was outstanding.
struct Client {
    reader: BufReader<std::os::unix::net::UnixStream>,
    writer: std::os::unix::net::UnixStream,
    events: Vec<Value>,
}

impl Client {
    fn connect(socket: &Path) -> Client {
        let stream = std::os::unix::net::UnixStream::connect(socket).expect("connect");
        let writer = stream.try_clone().expect("clone");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
            events: Vec::new(),
        };
        let hello = client.read_line();
        assert_eq!(hello["type"], "daemon_hello");
        client
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_mins(1);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => {}
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse line"),
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for supervisor line: {error}"
                    );
                }
            }
        }
    }

    fn send_command(&mut self, id: &str, command: Value) {
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).expect("serialize");
        line.push('\n');
        self.writer
            .write_all(line.as_bytes())
            .unwrap_or_else(|error| panic!("write command {id}: {error}"));
    }

    fn request(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_mins(3);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
            self.collect_event(&line);
        }
    }

    fn collect_event(&mut self, line: &Value) {
        if line.get("type").and_then(Value::as_str) == Some("session_event") {
            self.events.push(line["event"].clone());
        }
    }

    /// Drain pending session events until the socket stays quiet for
    /// `quiet_ms`.
    fn drain_events(&mut self, quiet_ms: Duration) {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut last_line = Instant::now();
        loop {
            assert!(Instant::now() < deadline, "event drain timed out");
            let mut line = String::new();
            self.reader
                .get_mut()
                .set_read_timeout(Some(Duration::from_millis(100)))
                .expect("timeout");
            match self.reader.read_line(&mut line) {
                Ok(0) => return,
                Ok(_) => {
                    let value: Value = serde_json::from_str(line.trim()).expect("parse line");
                    self.collect_event(&value);
                    last_line = Instant::now();
                }
                Err(_) => {
                    if last_line.elapsed() >= quiet_ms {
                        return;
                    }
                }
            }
        }
    }
}

/// Shared harness: supervisor + a two-provider models.json (both serving
/// `mock-1`, the catalog order the failover chain walks) + fast retry and
/// failover settings + a created, attached session.
fn setup(
    name: &str,
    primary: &FailingMock,
    backup: &FailingMock,
) -> (tempfile::TempDir, Supervisor, Client, String) {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": primary.url(),
                    "apiKey": "sk-primary",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096
                        }
                    ]
                },
                "prime-backup": {
                    "api": "openai-completions",
                    "baseUrl": backup.url(),
                    "apiKey": "sk-backup",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1 (backup)",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    // A fast quick-retry policy (one retry on the primary) and a fast
    // failover policy (one retry per provider) so the test asserts the
    // chain, not the delays.
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({
            "retry": {
                "enabled": true,
                "maxRetries": 1,
                "baseDelayMs": 50,
                "failover": { "enabled": true, "maxRetries": 1, "baseDelayMs": 50 }
            }
        })
        .to_string(),
    )
    .expect("write settings.json");
    let socket = dir.path().join(format!("{name}.sock"));
    let supervisor = spawn_supervisor(&socket, &agent_dir);
    let mut client = Client::connect(&socket);
    client.send_command(
        "c1",
        json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "provider": "prime-inference",
                "model": "mock-1",
            },
        }),
    );
    let created = client.request("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    client.send_command(
        "a1",
        json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.request("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    (dir, supervisor, client, session_id)
}

fn retry_starts(events: &[Value]) -> Vec<&Value> {
    events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("auto_retry_start"))
        .collect()
}

fn retry_end(events: &[Value]) -> &Value {
    events
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("auto_retry_end"))
        .expect("auto_retry_end")
}

#[test]
fn provider_failure_fails_over_to_the_next_provider_and_recovers() {
    // The primary always fails; the backup answers on its first request.
    let primary = FailingMock::start(usize::MAX, "never reached");
    let backup = FailingMock::start(0, "recovered on the backup provider");
    let (_dir, _supervisor, mut client, session_id) = setup("failover", &primary, &backup);
    client.send_command(
        "p1",
        json!({ "type": "prompt_and_wait", "activeSessionId": session_id, "message": "hi" }),
    );
    let done = client.request("p1");
    assert_eq!(done["success"], true, "prompt must succeed: {done}");
    client.drain_events(Duration::from_secs(1));

    // The primary got the initial request plus one quick retry; the
    // failover switch routed the re-issued turn to the backup, which
    // answered it.
    assert_eq!(primary.count(), 2, "primary requests: initial + 1 retry");
    assert_eq!(backup.count(), 1, "backup served the switched turn");

    // The retry progression: one quick retry on the primary, then the
    // provider switch (reason "backup", the backup reference, no delay).
    let starts = retry_starts(&client.events);
    assert_eq!(starts.len(), 2, "events: {:?}", client.events);
    assert_eq!(starts[0]["attempt"], 1);
    assert_eq!(starts[0]["maxAttempts"], 1);
    // The quick retry's wait sits in the ±20% jitter band around the
    // 50ms base delay ([40, 70] with rounding headroom).
    let delay = starts[0]["delayMs"].as_u64().expect("delayMs");
    assert!(
        (40..=70).contains(&delay),
        "jittered delay {delay} outside [40, 70]"
    );
    assert_eq!(starts[0].get("reason"), None, "quick retry has no reason");
    assert_eq!(starts[1]["attempt"], 2);
    assert_eq!(starts[1]["reason"], "backup");
    assert_eq!(starts[1]["backupModel"], "prime-backup/mock-1");
    assert_eq!(starts[1]["delayMs"], 0);
    assert!(starts[1]["errorMessage"]
        .as_str()
        .expect("error message")
        .contains("mock provider overloaded"));

    // The loop settles with the primary restored.
    let end = retry_end(&client.events);
    assert_eq!(end["success"], true);
    assert_eq!(end["attempt"], 2);
    assert_eq!(end["restoredModel"], "prime-inference/mock-1");

    // The switched turn's assistant message reached the transcript.
    let answer = client
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("message_end"))
        .find(|event| {
            event["message"]["role"] == "assistant"
                && event["message"]["stopReason"] != "error"
                && event["message"]["content"]
                    .as_array()
                    .is_some_and(|content| {
                        content.iter().any(|block| {
                            block["text"].as_str() == Some("recovered on the backup provider")
                        })
                    })
        })
        .expect("backup assistant message_end");
    assert_eq!(answer["message"]["provider"], "prime-backup");

    // The turn ends clean with the TS `turn_end` payload: the terminal
    // assistant message (the backup provider's answer) and the turn's
    // empty tool-result list, no error anywhere.
    let turn_end = client
        .events
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("turn_end"))
        .expect("turn_end");
    assert_eq!(turn_end.get("error"), None, "turn_end: {turn_end}");
    assert_eq!(turn_end["message"]["role"], "assistant");
    assert_eq!(turn_end["message"]["stopReason"], "stop");
    assert_eq!(turn_end["message"]["provider"], "prime-backup");
    assert!(
        turn_end["message"]["content"]
            .as_array()
            .is_some_and(|content| {
                content
                    .iter()
                    .any(|block| block["text"].as_str() == Some("recovered on the backup provider"))
            }),
        "turn_end carries the terminal assistant message: {turn_end}"
    );
    assert_eq!(
        turn_end["toolResults"].as_array().map(Vec::len),
        Some(0),
        "the recovered turn ran no tools"
    );
}

#[test]
fn every_provider_failing_surfaces_the_final_error() {
    let primary = FailingMock::start(usize::MAX, "never reached");
    let backup = FailingMock::start(usize::MAX, "never reached");
    let (_dir, _supervisor, mut client, session_id) = setup("exhausted", &primary, &backup);
    client.send_command(
        "p1",
        json!({ "type": "prompt_and_wait", "activeSessionId": session_id, "message": "hi" }),
    );
    let done = client.request("p1");
    assert_eq!(done["success"], false, "prompt must fail: {done}");
    client.drain_events(Duration::from_secs(1));

    // Both providers got their budget: initial + one retry each.
    assert_eq!(primary.count(), 2);
    assert_eq!(backup.count(), 2);

    // The chain walked the only candidate, then surfaced the failure.
    let starts = retry_starts(&client.events);
    assert_eq!(starts.len(), 3, "events: {:?}", client.events);
    assert_eq!(starts[0].get("reason"), None);
    assert_eq!(starts[1]["reason"], "backup");
    assert_eq!(starts[1]["backupModel"], "prime-backup/mock-1");
    assert_eq!(
        starts[2].get("reason"),
        None,
        "the backup quick-retries too"
    );

    let end = retry_end(&client.events);
    assert_eq!(end["success"], false);
    assert_eq!(end["attempt"], 4);
    assert!(end["finalError"]
        .as_str()
        .expect("final error")
        .contains("mock provider overloaded"));
    assert_eq!(end.get("restoredModel"), None);

    // The final failed assistant message reached the transcript and the
    // turn ends with the error for headless callers.
    let failure = client
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("message_end"))
        .find(|event| {
            event["message"]["role"] == "assistant" && event["message"]["stopReason"] == "error"
        })
        .expect("failed assistant message_end");
    assert!(failure["message"]["errorMessage"]
        .as_str()
        .expect("error message")
        .contains("mock provider overloaded"));
    let turn_end = client
        .events
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("turn_end"))
        .expect("turn_end");
    // The TS `turn_end` shape: the terminal frame carries the failed
    // assistant message as its payload (no separate error field).
    assert_eq!(turn_end["message"]["stopReason"], "error");
    assert!(turn_end["message"]["errorMessage"]
        .as_str()
        .expect("turn error")
        .contains("mock provider overloaded"));
    assert_eq!(turn_end.get("error"), None, "turn_end: {turn_end}");
}
