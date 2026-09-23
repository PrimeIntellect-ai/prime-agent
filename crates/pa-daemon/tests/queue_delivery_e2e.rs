//! End-to-end verifier for the queued-input delivery projection: a busy
//! session parks steering/follow-up prompts, the runner drains them one
//! item per turn, and every pickup must reach attached clients as a
//! `session_action_update` BEFORE the delivered item's turn starts (TS
//! `_pumpSessionInputs` emits the queue update at the action's
//! `preparing` transition). A delivered message that stays in the
//! projection for the duration of its own turn renders as a stale
//! queue strip row (dogfood P0: the steered message sends but still
//! shows in the queue), and a queued edit addressed against the stale
//! row is rejected as `rejected` even though the user sees it parked.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Per-request answer delay: the mock holds each response so the test can
/// park more prompts behind the busy turn and watch the pickup projection
/// while the delivered item's turn is still running.
const ANSWER_DELAY_MS: u64 = 1200;

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

/// A mock OpenAI-completions provider: request N (1-based) sleeps, then
/// answers `answer N` over SSE, so each turn's transcript row names its
/// request and the delivery order is observable in the user messages.
struct DelayedMock {
    requests: Arc<Mutex<usize>>,
    /// One excerpt per request, in order (the last user message text).
    bodies: Arc<Mutex<Vec<String>>>,
    port: u16,
}

impl DelayedMock {
    fn start() -> DelayedMock {
        let requests = Arc::new(Mutex::new(0usize));
        let bodies: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().expect("mock addr").port();
        let requests_for_thread = Arc::clone(&requests);
        let bodies_for_thread = Arc::clone(&bodies);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let requests = Arc::clone(&requests_for_thread);
                let bodies = Arc::clone(&bodies_for_thread);
                std::thread::spawn(move || {
                    let _ = serve(stream, requests, bodies);
                });
            }
        });
        DelayedMock {
            requests,
            bodies,
            port,
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    fn count(&self) -> usize {
        *self.requests.lock().expect("mock lock")
    }

    /// The last user message of every request, in request order.
    fn request_log(&self) -> Vec<String> {
        self.bodies.lock().expect("mock lock").clone()
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
    requests: Arc<Mutex<usize>>,
    bodies: Arc<Mutex<Vec<String>>>,
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
    let body: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);
    let last_user = body["messages"]
        .as_array()
        .and_then(|messages| {
            messages
                .iter()
                .rev()
                .find(|message| message["role"] == "user")
                .map(|message| match &message["content"] {
                    Value::String(text) => text.clone(),
                    content => content.to_string(),
                })
        })
        .unwrap_or_default();
    // The post-turn dashboard status request (TS `daemon-session-summarizer`
    // against the small summary model): it is not a turn - serve the canned
    // verdict without a delay and without consuming a scripted answer.
    if last_user.starts_with("<agent-state>") {
        let answer = "<recap>serving the queued prompts</recap>\n<status>NEEDS_INPUT</status>";
        let mut payload = String::new();
        for data in [
            chunk(json!({"role": "assistant", "content": answer}), None),
            chunk(json!({}), Some("stop")),
        ] {
            payload.push_str(&format!("data: {data}\n\n"));
        }
        payload.push_str("data: [DONE]\n\n");
        return stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}"
            )
            .as_bytes(),
        );
    }
    let index = {
        let mut requests = requests.lock().expect("mock lock");
        *requests += 1;
        *requests
    };
    bodies
        .lock()
        .expect("mock lock")
        .push(format!("#{index}: {last_user}"));
    std::thread::sleep(Duration::from_millis(ANSWER_DELAY_MS));
    let answer = format!("answer {index}");
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
        let deadline = Instant::now() + Duration::from_secs(60);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
        loop {
            let mut line = String::new();
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

    fn drain_events(&mut self, quiet_ms: Duration) {
        let deadline = Instant::now() + Duration::from_secs(60);
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

    fn send(&mut self, id: &str, command: Value) -> Value {
        self.send_command(id, command);
        self.request(id)
    }
}

fn setup(name: &str) -> (tempfile::TempDir, DelayedMock, Supervisor, Client, String) {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let mock = DelayedMock::start();
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
    std::fs::write(agent_dir.join("settings.json"), "{}").expect("write settings.json");
    let socket = dir.path().join(format!("{name}.sock"));
    let supervisor = spawn_supervisor(&socket, &agent_dir);
    let mut client = Client::connect(&socket);
    let created = client.send(
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
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    let attached = client.send(
        "a1",
        json!({ "type": "attach", "activeSessionId": session_id }),
    );
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    (dir, mock, supervisor, client, session_id)
}

/// One queued prompt (the TUI submit path): `streamingBehavior` picks the
/// lane, `queueIfBusy` parks it behind the running turn.
fn queued_prompt(session_id: &str, message: &str, behavior: &str) -> Value {
    json!({
        "type": "prompt",
        "activeSessionId": session_id,
        "message": message,
        "streamingBehavior": behavior,
        "queueIfBusy": true,
    })
}

/// Every `session_action_update` event with the given lane contents.
fn action_updates_with(events: &[Value], steering: &[&str], follow_ups: &[&str]) -> Vec<usize> {
    let expected = json!({ "steering": steering, "followUps": follow_ups });
    events
        .iter()
        .enumerate()
        .filter(|(_, event)| {
            event.get("type").and_then(Value::as_str) == Some("session_action_update")
                && event["actions"]["steering"] == expected["steering"]
                && event["actions"]["followUps"] == expected["followUps"]
        })
        .map(|(index, _)| index)
        .collect()
}

#[test]
fn queue_pickup_projection_reaches_clients_before_the_delivered_turn_starts() {
    let (_dir, mock, _supervisor, mut client, session_id) = setup("queue-pickup");

    // Turn one runs (the mock holds its answer), and three prompts park
    // behind it: two steers and one follow-up.
    let started = client.send(
        "p1",
        json!({ "type": "prompt", "activeSessionId": session_id, "message": "turn one" }),
    );
    assert_eq!(started["success"], true, "prompt failed: {started}");
    std::thread::sleep(Duration::from_millis(300));
    for (id, message, behavior) in [
        ("s1", "steer A", "steer"),
        ("s2", "steer B", "steer"),
        ("f1", "follow C", "followUp"),
    ] {
        let response = client.send(id, queued_prompt(&session_id, message, behavior));
        assert_eq!(response["success"], true, "{id} failed: {response}");
    }
    // The parked projection reaches attached clients.
    client.drain_events(Duration::from_millis(400));
    let parked = action_updates_with(&client.events, &["steer A", "steer B"], &["follow C"]);
    assert!(
        !parked.is_empty(),
        "the parked queue must project as session_action_update, events: {:?}",
        event_types(&client.events)
    );

    // Everything drains: three model requests (turn one + the steers'
    // ONE batched turn — the product default co-delivers the parked
    // steering prefix, Kevin's batch spec — + the follow-up's own turn).
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if mock.count() >= 3 {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    client.drain_events(Duration::from_secs(2));
    assert_eq!(
        mock.count(),
        3,
        "turn one, the steers' one batched turn, the follow-up's: {:?}",
        mock.request_log()
    );

    // Delivery order: steering lane first (both steers as the one batched
    // turn), the follow-up lane behind it.
    let user_messages: Vec<String> = client
        .events
        .iter()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("message_start")
                && event["message"]["role"] == "user"
        })
        .filter_map(|event| {
            event["message"]["content"]
                .as_array()
                .and_then(|blocks| blocks.first())
                .and_then(|block| block["text"].as_str())
                .map(str::to_string)
        })
        .collect();
    assert_eq!(
        user_messages,
        ["turn one", "steer A", "steer B", "follow C"],
        "the queue drains in lane order, one item per turn"
    );

    // The pickup projection: the delivered batch leaves the queue
    // projection BEFORE its turn starts (TS emits at the `preparing`
    // transition). A delivered message that stays projected for the whole
    // turn renders as a stale strip row and poisons browse-edit addresses.
    // Under the batched default BOTH steers leave the projection in the
    // one pickup update ahead of the one batched turn.
    let agent_starts: Vec<usize> = client
        .events
        .iter()
        .enumerate()
        .filter(|(_, event)| event.get("type").and_then(Value::as_str) == Some("agent_start"))
        .map(|(index, _)| index)
        .collect();
    assert_eq!(
        agent_starts.len(),
        3,
        "turn one, the steers' one batched turn, the follow-up's: {agent_starts:?}, events: {:?}",
        event_types(&client.events)
    );
    let parked_at = parked[0];
    let batch_start = agent_starts[1];
    let follow_c_start = agent_starts[2];
    assert!(
        action_updates_with(&client.events[..batch_start], &[], &["follow C"])
            .iter()
            .any(|index| *index > parked_at),
        "the steer batch's pickup must project before the batched turn starts (events: {:?})",
        event_types(&client.events)
    );
    assert!(
        !action_updates_with(&client.events[..follow_c_start], &[], &[]).is_empty(),
        "follow C's pickup must project before its turn starts (events: {:?})",
        event_types(&client.events)
    );
}

#[test]
fn multi_item_queue_delivers_every_item_in_lane_order() {
    let (_dir, mock, _supervisor, mut client, session_id) = setup("queue-multi");

    // A busy turn with a full parked lane: three steers and three
    // follow-ups behind it (dogfood: the queue appeared to accept only
    // one message).
    let started = client.send(
        "p1",
        json!({ "type": "prompt", "activeSessionId": session_id, "message": "turn zero" }),
    );
    assert_eq!(started["success"], true, "prompt failed: {started}");
    std::thread::sleep(Duration::from_millis(300));
    for (id, message, behavior) in [
        ("s1", "steer one", "steer"),
        ("s2", "steer two", "steer"),
        ("s3", "steer three", "steer"),
        ("f1", "follow one", "followUp"),
        ("f2", "follow two", "followUp"),
        ("f3", "follow three", "followUp"),
    ] {
        let response = client.send(id, queued_prompt(&session_id, message, behavior));
        assert_eq!(response["success"], true, "{id} failed: {response}");
    }
    client.drain_events(Duration::from_millis(400));
    let parked = action_updates_with(
        &client.events,
        &["steer one", "steer two", "steer three"],
        &["follow one", "follow two", "follow three"],
    );
    assert_eq!(
        parked.len(),
        1,
        "every parked item projects, events: {:?}",
        event_types(&client.events)
    );
    let actions = &client.events[parked[0]]["actions"];
    assert_eq!(actions["queuedCount"], 6, "queuedCount counts both lanes");

    // Five turns run: the starter, the three steers' ONE batched turn
    // (the product default co-delivers the parked steering prefix,
    // Kevin's batch spec), then the follow-ups one per turn behind it.
    let deadline = Instant::now() + Duration::from_secs(90);
    while Instant::now() < deadline {
        if mock.count() >= 5 {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    client.drain_events(Duration::from_secs(2));
    assert_eq!(
        mock.count(),
        5,
        "the starter, the steers' one batched turn, three follow-ups: {:?}",
        mock.request_log()
    );
    let user_messages: Vec<String> = client
        .events
        .iter()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("message_start")
                && event["message"]["role"] == "user"
        })
        .filter_map(|event| {
            event["message"]["content"]
                .as_array()
                .and_then(|blocks| blocks.first())
                .and_then(|block| block["text"].as_str())
                .map(str::to_string)
        })
        .collect();
    assert_eq!(
        user_messages,
        [
            "turn zero",
            "steer one",
            "steer two",
            "steer three",
            "follow one",
            "follow two",
            "follow three",
        ],
        "every queued item delivers, the steering lane's rows co-delivered ahead of the follow-up lane"
    );
}

fn event_types(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| event.get("type").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}
