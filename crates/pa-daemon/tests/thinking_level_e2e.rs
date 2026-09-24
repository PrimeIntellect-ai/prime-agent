//! End-to-end verifier for thinking-level propagation on the interactive
//! daemon path: the `create` config's `thinking` flag (the TUI's
//! `--thinking`) must reach the worker, clamp to the model's supported
//! levels (`max` -> `high` for a reasoning model without xhigh/max maps),
//! persist the effective level in the session JSONL, and apply it to every
//! provider request — the hermetic reproduction of the owner's live
//! `--thinking max` trial that previously recorded `off` and drew a
//! provider 400 for the unsupported effort.
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

/// A mock OpenAI-completions provider that records every request body and
/// answers one fixed SSE stream. No network beyond loopback.
struct RecordingMock {
    bodies: Arc<Mutex<Vec<Value>>>,
    port: u16,
}

impl RecordingMock {
    fn start() -> RecordingMock {
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().expect("mock addr").port();
        let bodies_for_thread = Arc::clone(&bodies);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let bodies = Arc::clone(&bodies_for_thread);
                std::thread::spawn(move || {
                    let _ = serve(stream, bodies);
                });
            }
        });
        RecordingMock { bodies, port }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    fn request_bodies(&self) -> Vec<Value> {
        self.bodies.lock().expect("mock lock").clone()
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

fn serve(mut stream: TcpStream, bodies: Arc<Mutex<Vec<Value>>>) -> std::io::Result<()> {
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
    let body: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);
    bodies.lock().expect("mock lock").push(body);
    let answer = "thinking propagated";
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

    fn request(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_mins(2);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
            if line.get("type").and_then(Value::as_str) == Some("session_event") {
                self.events.push(line["event"].clone());
            }
        }
    }

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
                    if value.get("type").and_then(Value::as_str) == Some("session_event") {
                        self.events.push(value["event"].clone());
                    }
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

/// Shared harness: supervisor + a reasoning model behind the recording mock.
/// The model supports the thinking levels a reasoning model without a
/// `thinkingLevelMap` has (`off`..`high`), so `max` must clamp to `high` —
/// the same shape as the owner's `internal/glm-5.3-fast` trial.
struct Harness {
    #[allow(dead_code)]
    dir: tempfile::TempDir,
    agent_dir: PathBuf,
    session_dir: PathBuf,
    mock: RecordingMock,
    #[allow(dead_code)]
    supervisor: Supervisor,
    client: Client,
    session_id: String,
}

#[allow(clippy::zombie_processes)]
fn setup(name: &str, thinking: Option<&str>) -> Harness {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let mock = RecordingMock::start();
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": mock.url(),
                    "apiKey": "sk-battery",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "reasoning": true,
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
    let socket = dir.path().join(format!("{name}.sock"));
    let supervisor = spawn_supervisor(&socket, &agent_dir);
    let mut client = Client::connect(&socket);
    let mut config = json!({
        "cwd": dir.path().to_string_lossy(),
        "sessionDir": session_dir.to_string_lossy(),
        "provider": "battery",
        "model": "mock-1",
    });
    if let Some(thinking) = thinking {
        config["thinking"] = json!(thinking);
    }
    client.send_command("c1", json!({ "type": "create", "config": config }));
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
    Harness {
        dir,
        agent_dir,
        session_dir,
        mock,
        supervisor,
        client,
        session_id,
    }
}

impl Harness {
    /// Run one prompt turn and return the prompt_and_wait response.
    fn prompt(&mut self, id: &str, message: &str) -> Value {
        self.client.send_command(
            id,
            json!({ "type": "prompt_and_wait", "activeSessionId": self.session_id, "message": message }),
        );
        let done = self.client.request(id);
        self.client.drain_events(Duration::from_secs(1));
        done
    }

    /// The persisted session JSONL entries.
    fn session_entries(&self) -> Vec<Value> {
        let files: Vec<PathBuf> = std::fs::read_dir(&self.session_dir)
            .expect("read session dir")
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
            .collect();
        assert_eq!(files.len(), 1, "one session file, got {files:?}");
        let text = std::fs::read_to_string(&files[0]).expect("read session file");
        text.lines()
            .map(|line| serde_json::from_str(line).expect("parse entry"))
            .collect()
    }

    /// The recorded thinking level from the session's creation prefix.
    fn persisted_thinking_level(&self) -> String {
        let entries = self.session_entries();
        let level = entries
            .iter()
            .find(|entry| entry["type"] == "thinking_level_change")
            .expect("thinking_level_change persisted");
        level["thinkingLevel"]
            .as_str()
            .expect("level string")
            .to_string()
    }

    /// The persisted model_change pair.
    fn persisted_model_change(&self) -> (String, String) {
        let entries = self.session_entries();
        let change = entries
            .iter()
            .find(|entry| entry["type"] == "model_change")
            .expect("model_change persisted");
        (
            change["provider"].as_str().expect("provider").to_string(),
            change["modelId"].as_str().expect("modelId").to_string(),
        )
    }

    /// The durable create command's thinking flag on the worker descriptor
    /// (what a respawned worker replays).
    fn durable_create_thinking(&self) -> Value {
        let daemon_workers = self.agent_dir.join("daemon-workers");
        let descriptors: Vec<PathBuf> = std::fs::read_dir(&daemon_workers)
            .expect("read daemon-workers dir")
            .flatten()
            .flat_map(|key| {
                std::fs::read_dir(key.path())
                    .expect("read descriptor dir")
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| {
                        path.extension().and_then(|e| e.to_str()) == Some("json")
                            && path.file_name().and_then(|n| n.to_str())
                                != Some("supervisor-config")
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        assert_eq!(
            descriptors.len(),
            1,
            "one worker descriptor: {descriptors:?}"
        );
        let text = std::fs::read_to_string(&descriptors[0]).expect("read descriptor");
        let descriptor: Value = serde_json::from_str(&text).expect("parse descriptor");
        descriptor["createCommand"]["thinking"].clone()
    }
}

#[test]
fn interactive_thinking_max_clamps_to_effective_high_end_to_end() {
    let mut harness = setup("thinking-max", Some("max"));

    // The durable create carries the requested flag for respawned workers.
    assert_eq!(
        harness.durable_create_thinking(),
        json!("max"),
        "the durable create carries the requested flag for respawned workers"
    );

    let done = harness.prompt("p1", "hi");
    assert_eq!(done["success"], true, "turn failed: {done}");
    assert!(
        harness.client.events.iter().any(|event| {
            event.get("type").and_then(Value::as_str) == Some("message_end")
                && event["message"]["role"] == "assistant"
                && event["message"]["content"][0]["text"] == "thinking propagated"
        }),
        "assistant answer reached the client: {:?}",
        harness.client.events
    );

    // The session JSONL records the EFFECTIVE level (high, not the
    // unsupported max, and not the old hardcoded off).
    assert_eq!(harness.persisted_thinking_level(), "high");
    assert_eq!(
        harness.persisted_model_change(),
        ("battery".to_string(), "mock-1".to_string())
    );

    // Every provider request carries the clamped effort: high, never max
    // (the 400 of the live trial) and never off (the old default).
    let bodies = harness.mock.request_bodies();
    assert!(!bodies.is_empty(), "the provider was called");
    for body in &bodies {
        assert_eq!(body["reasoning_effort"], "high", "request effort: {body}");
    }
}

#[test]
fn interactive_sessions_without_a_flag_default_to_medium() {
    let mut harness = setup("thinking-default", None);
    let done = harness.prompt("p1", "hi");
    assert_eq!(done["success"], true, "turn failed: {done}");
    // The TS sdk default (settings default ?? DEFAULT_THINKING_LEVEL) is
    // medium, clamped by the model — not the old hardcoded off.
    assert_eq!(harness.persisted_thinking_level(), "medium");
    let bodies = harness.mock.request_bodies();
    assert!(!bodies.is_empty(), "the provider was called");
    for body in &bodies {
        assert_eq!(body["reasoning_effort"], "medium", "request effort: {body}");
    }
}

#[test]
fn invalid_thinking_level_fails_the_create() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let mock = RecordingMock::start();
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": mock.url(),
                    "apiKey": "sk-battery",
                    "models": [
                        { "id": "mock-1", "reasoning": true, "contextWindow": 128_000, "maxTokens": 4096 }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    let socket = dir.path().join("thinking-invalid.sock");
    let supervisor = spawn_supervisor(&socket, &agent_dir);
    let mut client = Client::connect(&socket);
    client.send_command(
        "c1",
        json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "provider": "battery",
                "model": "mock-1",
                "thinking": "ultra",
            },
        }),
    );
    let created = client.request("c1");
    assert_eq!(
        created["success"], false,
        "an invalid thinking level must fail loudly: {created}"
    );
    assert!(
        created["error"]
            .as_str()
            .or_else(|| created["error"]["message"].as_str())
            .unwrap_or_default()
            .contains("Invalid thinking level"),
        "error names the problem: {created}"
    );
    drop(supervisor);
}

/// The agents-view roster summaries carry the session's thinking level for
/// BOTH session kinds: a top-level session after `set_thinking_level`
/// (live `get_state`), a spawned subagent (the create summary), and — after
/// their workers stop — the durable-row-backed surfaces (`list --all` saved
/// rows and the ledger-seeded roster rows) keep rendering "model:level".
#[test]
fn session_summaries_carry_the_thinking_level_for_both_session_kinds() {
    let mut harness = setup("summary-levels", None);
    let top_level = harness.session_id.clone();

    // The top-level summary carries the level SetThinkingLevel applies.
    harness.client.send_command(
        "stl",
        json!({ "type": "set_thinking_level", "activeSessionId": top_level, "level": "high" }),
    );
    let applied = harness.client.request("stl");
    assert_eq!(
        applied["success"], true,
        "set_thinking_level failed: {applied}"
    );
    harness.client.send_command(
        "gs1",
        json!({ "type": "get_state", "activeSessionId": top_level }),
    );
    let state = harness.client.request("gs1");
    assert_eq!(state["success"], true, "get_state failed: {state}");
    assert_eq!(
        state["data"]["thinkingLevel"],
        json!("high"),
        "the top-level summary carries the SetThinkingLevel level: {state}"
    );

    // One prompt persists the durable rows (model_change + the new level).
    let done = harness.prompt("p1", "persist the level");
    assert_eq!(done["success"], true, "turn failed: {done}");

    // A spawned subagent (the spawn task context carries its thinking
    // level into the create): its summary carries it too.
    let parent_info = {
        let entries = harness.session_entries();
        entries
            .iter()
            .find(|entry| entry["type"] == "session")
            .expect("session header")
            .clone()
    };
    let parent_session_id = parent_info["id"].as_str().expect("id").to_string();
    let session_file = std::fs::read_dir(&harness.session_dir)
        .expect("read session dir")
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .expect("session file");
    let child_dir = harness.agent_dir.join("subagents");
    std::fs::create_dir_all(&child_dir).expect("child dir");
    harness.client.send_command(
        "cc",
        json!({
            "type": "create",
            "name": "summary-child",
            "config": {
                "cwd": harness.dir.path().to_string_lossy(),
                "sessionDir": child_dir.to_string_lossy(),
                "provider": "battery",
                "model": "mock-1",
                "thinking": "high",
                "rlmDepth": 1,
                "parentSessionPath": session_file.to_string_lossy(),
                "executionMode": "print",
            },
            "runtimeMetadata": {
                "kind": "subagent",
                "rlmChildId": "child-1",
                "rlmDepth": 1,
                "parentSessionFile": session_file.to_string_lossy(),
                "parentSessionId": parent_session_id,
                "parentActiveSessionId": top_level,
            },
        }),
    );
    let child_created = harness.client.request("cc");
    assert_eq!(
        child_created["success"], true,
        "subagent create failed: {child_created}"
    );
    assert_eq!(
        child_created["data"]["thinkingLevel"],
        json!("high"),
        "the subagent summary carries the spawn thinking level: {child_created}"
    );
    let child_id = child_created["data"]["activeSessionId"]
        .as_str()
        .or_else(|| child_created["data"]["id"].as_str())
        .expect("child active session id")
        .to_string();

    // The subagent's live roster row carries the level; after its worker
    // stops (a plain kill, no ledger tombstone), the ledger-seeded roster
    // row still carries the model and the persisted level.
    harness
        .client
        .send_command("ck", json!({ "type": "kill", "activeSessionId": child_id }));
    let killed = harness.client.request("ck");
    assert_eq!(killed["success"], true, "child kill failed: {killed}");
    let seeded = {
        let mut found = None;
        for _ in 0..50 {
            harness
                .client
                .send_command("rs", json!({ "type": "roster_subscribe" }));
            let roster = harness.client.request("rs");
            for entry in roster["data"]["roster"]
                .as_array()
                .cloned()
                .unwrap_or_default()
            {
                let summary = &entry["summary"];
                if summary["rlmChildId"] == json!("child-1") {
                    found = Some(summary.clone());
                }
            }
            if found.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        found.expect("the seeded subagent roster row appeared")
    };
    assert_eq!(
        seeded["model"],
        json!({ "provider": "battery", "modelId": "mock-1" }),
        "the seeded subagent row hydrates the durable model: {seeded}"
    );
    assert_eq!(
        seeded["thinkingLevel"],
        json!("high"),
        "the seeded subagent row hydrates the durable thinking level: {seeded}"
    );

    // After the top-level worker stops too, the saved-session summary row
    // (the `list --all` agents-view source) still carries the level the
    // SetThinkingLevel command persisted.
    harness.client.send_command(
        "tk",
        json!({ "type": "kill", "activeSessionId": top_level }),
    );
    let top_killed = harness.client.request("tk");
    assert_eq!(
        top_killed["success"], true,
        "top-level kill failed: {top_killed}"
    );
    harness.client.send_command(
        "la",
        json!({ "type": "list", "all": true, "sessionDir": harness.session_dir.to_string_lossy() }),
    );
    let listed = harness.client.request("la");
    assert_eq!(listed["success"], true, "list failed: {listed}");
    let top_row = listed["data"]["sessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .find(|row| row["sessionId"] == json!(parent_session_id))
        .expect("the top-level saved row is listed");
    assert_eq!(
        top_row["thinkingLevel"],
        json!("high"),
        "the saved top-level summary carries the persisted level: {top_row}"
    );
}
