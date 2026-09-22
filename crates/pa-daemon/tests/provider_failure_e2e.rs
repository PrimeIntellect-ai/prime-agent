//! End-to-end verifier for interactive provider-failure handling: a daemon
//! worker session against a failing (then healing) OpenAI-compatible mock
//! must retry the turn per the shared retry policy, surface each retry
//! (`auto_retry_start`), close the loop (`auto_retry_end`), render the
//! failed assistant message, and end the turn with the error. The
//! success-after-retry path must settle the same loop with `success: true`.
#![cfg(unix)]

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
        "created": 1750000000,
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
        payload.push_str(&format!("data: {data}\n\n"));
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
        .stderr(Stdio::null())
        .env_remove("PRIME_API_KEY")
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        // A supervisor killed at teardown must not leak its session workers
        // into later test binaries: the worker's supervisor-lost exit (TS
        // `exitIfSupervisorOrphanedForTooLong`) runs on this short window
        // instead of the 5-minute default.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
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
        let deadline = Instant::now() + Duration::from_secs(60);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => continue,
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

    /// The response for `id`, with every session event observed on the way.
    fn request(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(120);
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
    /// `quiet_ms`. The supervisor buffers a client's session events while a
    /// routed command (`prompt_and_wait`) is in flight and writes them after
    /// its response, so a caller that stops at the response would miss the
    /// whole turn.
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
                    if Instant::now() - last_line >= quiet_ms {
                        return;
                    }
                }
            }
        }
    }
}

/// Shared harness: supervisor + models.json + fast retry settings + a
/// created, attached session. The supervisor handle must outlive the test
/// body: dropping it kills the supervisor process and closes the client
/// socket mid-turn.
fn setup(
    name: &str,
    failures: usize,
    answer: &'static str,
) -> (tempfile::TempDir, FailingMock, Supervisor, Client, String) {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let mock = FailingMock::start(failures, answer);
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": mock.url(),
                    "apiKey": "sk-battery",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128000,
                            "maxTokens": 4096
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    // A fast retry policy so the test asserts the loop, not the delays.
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({ "retry": { "enabled": true, "maxRetries": 2, "baseDelayMs": 50 } }).to_string(),
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
    (dir, mock, supervisor, client, session_id)
}

fn event_types(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| event.get("type").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

#[test]
fn provider_failure_is_retried_then_surfaced_to_attached_clients() {
    let (_dir, mock, _supervisor, mut client, session_id) = setup("failing", 5, "never reached");
    client.send_command(
        "p1",
        json!({ "type": "prompt_and_wait", "activeSessionId": session_id, "message": "hi" }),
    );
    let done = client.request("p1");
    assert_eq!(done["success"], false, "prompt must fail: {done}");
    client.drain_events(Duration::from_secs(1));

    // The retry policy applied: one initial request plus two retries.
    assert_eq!(mock.count(), 3, "requests: initial + 2 retries");

    // The accepted user message is a message_start + message_end pair
    // (TS wire), and an unchanged queue projection stays silent (TS
    // `_emitQueueUpdate` dedup): no session_action_update frames here.
    let types = event_types(&client.events);
    assert!(
        !types.iter().any(|t| t == "session_action_update"),
        "an empty-to-empty queue is not an update, events: {types:?}"
    );
    let user_pairs = client
        .events
        .iter()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("message_start")
                && event["message"]["role"] == "user"
        })
        .count();
    let user_ends = client
        .events
        .iter()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("message_end")
                && event["message"]["role"] == "user"
        })
        .count();
    assert_eq!(user_pairs, 1, "one user message_start, events: {types:?}");
    assert_eq!(user_ends, 1, "one user message_end, events: {types:?}");

    assert!(
        types.iter().filter(|t| *t == "auto_retry_start").count() == 2,
        "two retry starts expected, events: {types:?}"
    );
    // Each retry start carries the attempt and delay (50ms then 100ms).
    let starts: Vec<&Value> = client
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("auto_retry_start"))
        .collect();
    assert_eq!(starts[0]["attempt"], 1);
    assert_eq!(starts[0]["maxAttempts"], 2);
    assert_eq!(starts[0]["delayMs"], 50);
    assert!(starts[0]["errorMessage"]
        .as_str()
        .expect("error message")
        .contains("mock provider overloaded"));
    assert_eq!(starts[1]["attempt"], 2);
    assert_eq!(starts[1]["delayMs"], 100);

    // The loop closes with the final failure surfaced.
    let end = client
        .events
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("auto_retry_end"))
        .expect("auto_retry_end");
    assert_eq!(end["success"], false);
    assert_eq!(end["attempt"], 2);
    assert!(end["finalError"]
        .as_str()
        .expect("final error")
        .contains("mock provider overloaded"));

    // The failed assistant message reached the transcript: message_end with
    // stopReason error and the provider message.
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

    // The turn ends with the TS `turn_end` shape: the terminal frame
    // carries the failed assistant message as its payload (no separate
    // error field on the frame — TS `turn_end` never carries one).
    let turn_end = client
        .events
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("turn_end"))
        .expect("turn_end");
    assert_eq!(turn_end["message"]["role"], "assistant");
    assert_eq!(turn_end["message"]["stopReason"], "error");
    assert!(turn_end["message"]["errorMessage"]
        .as_str()
        .expect("turn error")
        .contains("mock provider overloaded"));
    assert_eq!(turn_end.get("error"), None, "turn_end: {turn_end}");
    assert_eq!(
        turn_end["toolResults"].as_array().map(Vec::len),
        Some(0),
        "the failed turn ran no tools"
    );
}

/// A direct-transport client (thin-supervisor stage 2): ticket from the
/// supervisor, `peer_auth` + `attach` on the worker's own socket. The turn
/// events must stream live on this path (the per-connection fan-out writes
/// while the routed command is still in flight).
struct DirectClient {
    stream: std::os::unix::net::UnixStream,
}

impl DirectClient {
    fn connect(socket: &Path, ticket: &Value, session_id: &str) -> DirectClient {
        let mut client = DirectClient {
            stream: std::os::unix::net::UnixStream::connect(socket).expect("connect worker"),
        };
        client
            .stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
        let (header, _hello) = client.read_frame();
        assert_eq!(header["outboundType"], "daemon_hello");
        let auth = client.request(
            "peer_auth",
            &json!({
                "type": "peer_auth",
                "grantId": ticket["grantId"],
                "token": ticket["token"],
                "workerInstanceId": ticket["workerInstanceId"],
                "purpose": "session_client",
            }),
        );
        assert_eq!(auth["success"], true, "peer auth failed: {auth}");
        let attach = client.request(
            "attach",
            &json!({
                "type": "attach",
                "activeSessionId": session_id,
                "capabilities": ["attach_snapshot", "event_sequence", "slim_attach"],
            }),
        );
        assert_eq!(attach["success"], true, "direct attach failed: {attach}");
        client
    }

    fn send_frame(&mut self, command_type: &str, request_id: &str, payload: &Value) {
        let header = json!({
            "kind": "command",
            "requestId": request_id,
            "commandType": command_type,
        });
        let frame = pa_daemon::framing::encode_private_frame(
            &header,
            &serde_json::to_vec(payload).expect("payload"),
            pa_daemon::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .expect("encode frame");
        self.stream.write_all(&frame).expect("write frame");
        self.stream.flush().expect("flush");
    }

    fn read_frame(&mut self) -> (Value, Value) {
        let deadline = Instant::now() + Duration::from_secs(60);
        let (header, payload) = self
            .read_frame_soft(deadline)
            .expect("worker frame read timed out");
        (header, payload)
    }

    /// One frame read that returns `None` at `deadline` instead of panicking:
    /// for bounded post-response drains whose end is "no more frames".
    fn read_frame_soft(&mut self, deadline: Instant) -> Option<(Value, Value)> {
        let mut prefix = [0u8; 8];
        read_exact_soft(&mut self.stream, &mut prefix, deadline)?;
        let header_len = u32::from_be_bytes(prefix[0..4].try_into().unwrap()) as usize;
        let payload_len = u32::from_be_bytes(prefix[4..8].try_into().unwrap()) as usize;
        let mut header = vec![0u8; header_len];
        read_exact_soft(&mut self.stream, &mut header, deadline)?;
        let mut payload = vec![0u8; payload_len];
        read_exact_soft(&mut self.stream, &mut payload, deadline)?;
        let header: Value = serde_json::from_slice(&header).expect("frame header");
        let payload: Value = serde_json::from_slice(&payload).expect("frame payload");
        Some((header, payload))
    }

    fn request(&mut self, command_type: &str, payload: &Value) -> Value {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let request_id = format!(
            "req-{}",
            NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        );
        self.send_frame(command_type, &request_id, payload);
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            assert!(Instant::now() < deadline, "no response for {request_id}");
            let (header, body) = self.read_frame();
            if header["outboundType"] == "response" && header["requestId"] == request_id {
                return body;
            }
        }
    }
}

/// One frame read with a soft deadline: `None` when no complete
/// frame arrives in time (a worker close still panics mid-frame).
fn read_exact_soft(
    stream: &mut std::os::unix::net::UnixStream,
    buffer: &mut [u8],
    deadline: Instant,
) -> Option<()> {
    let mut read = 0usize;
    while read < buffer.len() {
        if Instant::now() >= deadline {
            return None;
        }
        match stream.read(&mut buffer[read..]) {
            Ok(0) => panic!("worker closed the connection mid-frame"),
            Ok(n) => read += n,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => panic!("worker read: {error}"),
        }
    }
    Some(())
}

#[test]
fn provider_failure_surfaces_on_the_direct_transport_path() {
    let (_dir, mock, _supervisor, mut client, session_id) = setup("direct", 5, "never reached");

    // Ticket -> peer_auth -> attach on the worker's own socket.
    client.send_command(
        "ticket",
        json!({ "type": "get_direct_worker_transport", "activeSessionId": session_id }),
    );
    let ticket = client.request("ticket");
    assert_eq!(ticket["success"], true, "ticket failed: {ticket}");
    let mut direct = DirectClient::connect(
        Path::new(ticket["data"]["socketPath"].as_str().expect("socket path")),
        &ticket["data"],
        &session_id,
    );

    // The prompt rides the direct connection; the session events stream
    // live on the same socket while the command is in flight.
    direct.send_frame(
        "prompt_and_wait",
        "p-direct",
        &json!({ "type": "prompt_and_wait", "activeSessionId": session_id, "message": "hi" }),
    );
    let mut events: Vec<Value> = Vec::new();
    let mut response = None;
    let deadline = Instant::now() + Duration::from_secs(120);
    while response.is_none() {
        assert!(Instant::now() < deadline, "direct prompt never settled");
        let (header, body) = direct.read_frame();
        match header["outboundType"].as_str() {
            Some("session_event") => events.push(body["event"].clone()),
            Some("response") if header["requestId"] == "p-direct" => {
                assert_eq!(body["success"], false, "direct prompt must fail: {body}");
                assert!(
                    body["error"]
                        .as_str()
                        .expect("turn error")
                        .contains("mock provider overloaded"),
                    "unexpected error: {body}"
                );
                response = Some(body);
            }
            _ => {}
        }
    }
    // The response and the per-connection event fan-out are separate writer
    // tasks, so under load the trailing event frames can land just after the
    // response. Drain with a bounded wait until the retry loop settled; the
    // events themselves still prove live streaming (the worker has no
    // post-response replay mechanism).
    let settle = Instant::now() + Duration::from_secs(10);
    loop {
        let mut retry_starts = 0;
        let mut retry_end = false;
        let mut failed_message_end = false;
        for event in &events {
            match event.get("type").and_then(Value::as_str) {
                Some("auto_retry_start") => retry_starts += 1,
                Some("auto_retry_end") => retry_end = true,
                Some("message_end")
                    if event["message"]["role"] == "assistant"
                        && event["message"]["stopReason"] == "error" =>
                {
                    failed_message_end = true;
                }
                _ => {}
            }
        }
        if retry_starts == 2 && retry_end && failed_message_end {
            break;
        }
        match direct.read_frame_soft(settle) {
            Some((header, body)) => {
                if header["outboundType"] == "session_event" {
                    events.push(body["event"].clone());
                }
            }
            None => break,
        }
    }
    let types = event_types(&events);
    assert_eq!(
        types.iter().filter(|t| *t == "auto_retry_start").count(),
        2,
        "two retry starts expected, events: {types:?}"
    );
    let end = events
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("auto_retry_end"))
        .expect("auto_retry_end observed on the direct socket");
    assert_eq!(end["success"], false);
    let failure = events
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

    // The retry policy applied on this path too: initial + two retries.
    assert_eq!(mock.count(), 3, "requests: initial + 2 retries");
}

#[test]
fn provider_failure_recovered_by_retry_settles_the_turn() {
    let (_dir, mock, _supervisor, mut client, session_id) = setup("healing", 2, "recovered reply");
    client.send_command(
        "p1",
        json!({ "type": "prompt_and_wait", "activeSessionId": session_id, "message": "hi" }),
    );
    let done = client.request("p1");
    assert_eq!(done["success"], true, "prompt must succeed: {done}");
    client.drain_events(Duration::from_secs(1));

    // Two failures then the third attempt succeeds.
    assert_eq!(mock.count(), 3);

    let types = event_types(&client.events);
    assert!(
        types.iter().filter(|t| *t == "auto_retry_start").count() == 2,
        "two retry starts expected, events: {types:?}"
    );
    let end = client
        .events
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("auto_retry_end"))
        .expect("auto_retry_end");
    assert_eq!(end["success"], true);
    assert_eq!(end["attempt"], 2);
    assert!(end.get("finalError").is_none(), "no final error: {end}");

    // The recovered reply is the turn's final message.
    let last_message = client
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("message_end"))
        .rev()
        .find(|event| event["message"]["role"] == "assistant")
        .expect("final assistant message");
    assert_eq!(last_message["message"]["stopReason"], "stop");
    assert_eq!(
        last_message["message"]["content"][0]["text"],
        "recovered reply"
    );

    // One `agent_end` per agent run (TS parity: the `messages` payload
    // carries the run's whole message set, and a retried turn restarts its
    // runs on the wire with their own `agent_start`/`turn_start` frames).
    // The initial run carries the accepted rows plus its failed assistant
    // row; each retry run carries only its own messages (the failed row
    // left the loop context first, TS `messages.slice(0, -1)`).
    let agent_ends: Vec<&Value> = client
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_end"))
        .collect();
    assert_eq!(agent_ends.len(), 3, "one agent_end per run: {types:?}");
    let roles_of = |frame: &Value| -> Vec<String> {
        frame["messages"]
            .as_array()
            .map(|messages| {
                messages
                    .iter()
                    .map(|message| message["role"].as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default()
    };
    assert_eq!(
        roles_of(agent_ends[0]),
        ["custom", "user", "assistant"],
        "the initial run's message set (the deferred harness digest rides first): {agent_ends:?}"
    );
    assert_eq!(
        agent_ends[0]["messages"][0]["customType"],
        json!("harness_digest"),
        "the deferred digest row is the run's first message"
    );
    assert_eq!(
        agent_ends[0]["messages"][2]["stopReason"],
        json!("error"),
        "the initial run ends on the error row"
    );
    assert_eq!(
        roles_of(agent_ends[1]),
        ["assistant"],
        "the first retry carries only its own messages: {agent_ends:?}"
    );
    assert_eq!(
        agent_ends[1]["messages"][0]["stopReason"],
        json!("error"),
        "the first retry failed too"
    );
    assert_eq!(
        roles_of(agent_ends[2]),
        ["assistant"],
        "the second retry carries only its own messages: {agent_ends:?}"
    );
    assert_eq!(
        agent_ends[2]["messages"][0]["content"][0]["text"],
        json!("recovered reply"),
        "the recovered run's settled row"
    );
    // The two retry runs re-opened on the wire: three `agent_start` frames
    // (the worker's run-opening frame plus the two forwarded run starts)
    // and three `turn_start` frames, each retry pair after the prior run's
    // `agent_end`.
    assert_eq!(
        types.iter().filter(|t| *t == "agent_start").count(),
        3,
        "one agent_start per run: {types:?}"
    );
    assert_eq!(
        types.iter().filter(|t| *t == "turn_start").count(),
        3,
        "the run-opening turn_start plus the two retry runs': {types:?}"
    );
    // No bare synthesized frame trails the runs: every `agent_end` on the
    // wire carries the messages payload.
    assert!(
        agent_ends
            .iter()
            .all(|event| event.get("messages").is_some()),
        "no bare agent_end frames: {agent_ends:?}"
    );
}
