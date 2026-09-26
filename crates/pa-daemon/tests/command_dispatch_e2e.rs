//! End-to-end verifier for client-command dispatch during a live turn:
//! the daemon-response timeout class from the 2026-09-22 dogfood
//! (`/system-prompt` timing out at the client's 10s cap) — a client
//! command (the TUI's `/system-prompt`, `/context`, `/usage`, `/session`
//! family) must answer fast while a turn streams, not wait for the turn
//! to settle (the TS bar: the TS daemon-mode `get_system_prompt` arm is
//! a synchronous `session.systemPrompt` read on the same event loop that
//! streams the turn; the provider awaits yield, so the read stays ms).
//!
//! The mock provider streams one chunk, then holds the turn open for
//! `TURN_HOLD_MS` before the finish chunk: every measurement below runs
//! while the turn is provably mid-flight (an assistant `message_start`
//! streamed but the run not settled).
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// How long the mock provider holds the turn open between its first
/// streamed chunk and the finish chunk. Must exceed the TUI's 10s
/// `UI_REQUEST_TIMEOUT_MS` so a serialized dispatch reproduces the exact
/// dogfood failure (a response that cannot arrive inside the client cap).
const TURN_HOLD_MS: u64 = 12_000;
/// The bar for "fast mid-turn" (the TS reference answers in single-digit
/// ms; this leaves generous CI margin for a cold first read).
const FAST_RESPONSE_MS: u64 = 2_000;

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

/// A mock OpenAI-completions provider that streams one content chunk,
/// sleeps `TURN_HOLD_MS`, then finishes: the client session is provably
/// mid-turn for the whole sleep window.
struct SlowMock {
    requests: Arc<Mutex<usize>>,
    port: u16,
}

impl SlowMock {
    fn start() -> SlowMock {
        let requests = Arc::new(Mutex::new(0usize));
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().expect("mock addr").port();
        let requests_for_thread = Arc::clone(&requests);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let requests = Arc::clone(&requests_for_thread);
                std::thread::spawn(move || {
                    let _ = serve(stream, requests);
                });
            }
        });
        SlowMock { requests, port }
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

fn serve(mut stream: TcpStream, requests: Arc<Mutex<usize>>) -> std::io::Result<()> {
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
    {
        let mut requests = requests.lock().expect("mock lock");
        *requests += 1;
    }
    // First chunk goes out immediately so the assistant `message_start`
    // streams; the sleep holds the turn open mid-stream.
    let mut payload = String::new();
    write!(
        payload,
        "data: {}\n\n",
        chunk(json!({"role": "assistant", "content": "streaming"}), None)
    )
    .expect("write to String");
    stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}"
        )
        .as_bytes(),
    )?;
    std::thread::sleep(Duration::from_millis(TURN_HOLD_MS));
    let mut tail = String::new();
    write!(tail, "data: {}\n\n", chunk(json!({}), Some("stop"))).expect("write to String");
    tail.push_str("data: [DONE]\n\n");
    stream.write_all(tail.as_bytes())
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
        let deadline = Instant::now() + Duration::from_mins(2);
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
                Err(_) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for supervisor line"
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

    /// Send a command and measure the time until its response arrives;
    /// session events observed along the way are collected like
    /// [`Self::request`].
    fn timed_request(&mut self, id: &str, command: Value) -> (Value, Duration) {
        let started = Instant::now();
        self.send_command(id, command);
        let response = self.request(id);
        (response, started.elapsed())
    }

    fn request(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_mins(2);
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

    /// Block until the live run settles (the `agent_end` frame), long
    /// after the mid-turn measurements: the mock's hold window outlasts
    /// them, so a quiet-drain would stop while the turn still streams.
    fn wait_for_settled(&mut self) {
        let deadline = Instant::now() + Duration::from_mins(1);
        loop {
            assert!(Instant::now() < deadline, "the turn never settled");
            let line = self.read_line();
            let settled = line.get("type").and_then(Value::as_str) == Some("session_event")
                && line["event"]["type"].as_str() == Some("agent_end");
            self.collect_event(&line);
            if settled {
                return;
            }
        }
    }

    /// Block until the stream shows the given event shape (a session event
    /// whose `message.role` matches), collecting everything on the way.
    fn wait_for_event(&mut self, role: &str) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() < deadline, "no assistant start streamed");
            let line = self.read_line();
            let is_match = line.get("type").and_then(Value::as_str) == Some("session_event")
                && line["event"]["message"]["role"].as_str() == Some(role)
                && line["event"]["type"].as_str() == Some("message_start");
            self.collect_event(&line);
            if is_match {
                return;
            }
        }
    }
}

/// One measured command: name, wire command, and the response time.
struct Measurement {
    command: String,
    elapsed: Duration,
    success: bool,
}

fn info_command(name: &str, session_id: &str) -> Value {
    json!({
        "type": name,
        "activeSessionId": session_id,
    })
}

/// The client command family the TUI serves through its 10s
/// `UI_REQUEST_TIMEOUT_MS` bound: `/system-prompt`, `/session`,
/// `/context` (+ its `/usage` alias), plus the same-route getters the TUI
/// refreshes (`get_session_context`, `get_tool_definition`,
/// `get_resource_snapshot`).
const MATRIX: &[(&str, &str)] = &[
    ("get_session_stats", "/session"),
    ("get_context_tree", "/context, /usage"),
    ("get_session_context", "wire: get_session_context"),
    ("get_system_prompt", "/system-prompt"),
    ("get_tool_definition", "wire: get_tool_definition"),
    ("get_resource_snapshot", "wire: get_resource_snapshot"),
];

fn run_matrix(client: &mut Client, session_id: &str, phase: &str) -> Vec<Measurement> {
    let mut measurements = Vec::new();
    for (index, (command, surface)) in MATRIX.iter().enumerate() {
        let id = format!("matrix-{phase}-{index}");
        let mut command_value = info_command(command, session_id);
        if *command == "get_tool_definition" {
            command_value["name"] = json!("bash");
        }
        let (response, elapsed) = client.timed_request(&id, command_value);
        measurements.push(Measurement {
            command: format!("{command} ({surface})"),
            elapsed,
            success: response["success"] == json!(true),
        });
    }
    measurements
}

fn print_table(phase: &str, measurements: &[Measurement]) {
    println!("== response-time table ({phase}) ==");
    for measurement in measurements {
        println!(
            "{:<40} {:>8.0} ms  {}",
            measurement.command,
            measurement.elapsed.as_millis(),
            if measurement.success { "ok" } else { "FAILED" }
        );
    }
}

#[test]
fn client_commands_answer_fast_while_a_turn_streams() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let mock = SlowMock::start();
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
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({ "onboardingCompleted": true }).to_string(),
    )
    .expect("write settings.json");
    let socket = dir.path().join("cmd-dispatch.sock");
    let _supervisor = spawn_supervisor(&socket, &agent_dir);
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

    // Phase 1: idle measurements (the baseline every command must beat).
    let idle = run_matrix(&mut client, &session_id, "idle");
    print_table("idle", &idle);
    for measurement in &idle {
        assert!(measurement.success, "idle {} failed", measurement.command);
        assert!(
            measurement.elapsed < Duration::from_millis(FAST_RESPONSE_MS),
            "idle {} took {:?}",
            measurement.command,
            measurement.elapsed
        );
    }

    // Phase 2: a turn holds open mid-stream, then the same matrix runs
    // while the assistant message is streaming (the dogfood window).
    client.send_command(
        "p1",
        json!({ "type": "prompt", "activeSessionId": session_id, "message": "hello" }),
    );
    let queued = client.request("p1");
    assert_eq!(queued["success"], true, "prompt rejected: {queued}");
    client.wait_for_event("assistant");
    assert_eq!(mock.count(), 1, "one provider request mid-turn");

    let mid_turn = run_matrix(&mut client, &session_id, "mid-turn");
    print_table("mid-turn", &mid_turn);
    for measurement in &mid_turn {
        assert!(
            measurement.success,
            "mid-turn {} failed",
            measurement.command
        );
        assert!(
            measurement.elapsed < Duration::from_millis(FAST_RESPONSE_MS),
            "mid-turn {} took {:?} — serialized behind the streaming turn              (the TS bar: commands interleave with the turn loop)",
            measurement.command,
            measurement.elapsed
        );
    }

    // The turn settles normally after the hold window.
    client.wait_for_settled();
    let types = client
        .events
        .iter()
        .filter_map(|event| event.get("type").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    assert!(
        types.iter().any(|t| t == "agent_end"),
        "the turn never settled: {types:?}"
    );
    assert_eq!(mock.count(), 1, "still one provider request");
}
