//! Queued-input delivery projection: pickups reach attached clients as a
//! `session_action_update` BEFORE the delivered item's turn starts (TS
//! `_pumpSessionInputs` emits at the action's `preparing` transition); a
//! delivered message still projected renders as a stale strip row (dogfood P0).
#![allow(clippy::large_futures)]
// 64-bit-only targets; the narrowing casts sit at bounded OS boundaries.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// Fn length is a style gate, not correctness.
#![allow(clippy::too_many_lines)]
// API-shape opinions, not defects; the surfaces are deliberate.
#![allow(
    clippy::unnecessary_wraps,
    clippy::zero_sized_map_values,
    clippy::struct_excessive_bools,
    clippy::struct_field_names
)]
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Per-request answer delay: holds each response so prompts park behind the busy turn.
const ANSWER_DELAY_MS: u64 = 1200;

/// The busy-turn hold: the gated turn's answer parks until released — a wall-clock answer
/// is a race, so holding makes the parked-lane setup deterministic.
#[derive(Default)]
struct HoldGate {
    state: Mutex<HoldState>,
    arrived: Condvar,
    released: Condvar,
}

#[derive(Default)]
struct HoldState {
    /// The gated busy turn's prompt text; `None` gates nothing.
    marker: Option<String>,
    /// The gated turn's model request reached the mock (the turn is streaming, so admissions park
    /// deterministically).
    request_arrived: bool,
    released: bool,
}

impl HoldGate {
    /// Gate the busy turn with the given prompt text (arm before the
    /// turn starts).
    fn arm(&self, marker: &str) {
        let mut state = self.state.lock().expect("hold lock");
        state.marker = Some(marker.to_string());
        state.request_arrived = false;
        state.released = false;
    }

    fn wait_request(&self) {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut state = self.state.lock().expect("hold lock");
        while !state.request_arrived {
            assert!(
                Instant::now() < deadline,
                "the held busy turn's model request never reached the mock"
            );
            let (guard, _) = self
                .arrived
                .wait_timeout(state, Duration::from_millis(100))
                .expect("hold lock");
            state = guard;
        }
    }

    fn release(&self) {
        let mut state = self.state.lock().expect("hold lock");
        state.released = true;
        self.released.notify_all();
    }

    /// Serve side: mark the gated turn's arrival and hold its answer until released.
    fn observe(&self, last_user: &str) -> bool {
        let mut state = self.state.lock().expect("hold lock");
        if state.marker.as_deref() != Some(last_user) {
            return false;
        }
        state.request_arrived = true;
        self.arrived.notify_all();
        while !state.released {
            state = self.released.wait(state).expect("hold lock");
        }
        true
    }
}

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

/// Request N (1-based) sleeps, then answers `answer N` over SSE.
struct DelayedMock {
    requests: Arc<Mutex<usize>>,
    bodies: Arc<Mutex<Vec<String>>>,
    /// The gated busy turn (see [`HoldGate`]).
    hold: Arc<HoldGate>,
    port: u16,
}

impl DelayedMock {
    fn start() -> DelayedMock {
        let requests = Arc::new(Mutex::new(0usize));
        let bodies: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let hold = Arc::new(HoldGate::default());
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().expect("mock addr").port();
        let requests_for_thread = Arc::clone(&requests);
        let bodies_for_thread = Arc::clone(&bodies);
        let hold_for_thread = Arc::clone(&hold);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let requests = Arc::clone(&requests_for_thread);
                let bodies = Arc::clone(&bodies_for_thread);
                let hold = Arc::clone(&hold_for_thread);
                std::thread::spawn(move || {
                    let _ = serve(stream, &requests, &bodies, &hold);
                });
            }
        });
        DelayedMock {
            requests,
            bodies,
            hold,
            port,
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    fn count(&self) -> usize {
        *self.requests.lock().expect("mock lock")
    }

    fn request_log(&self) -> Vec<String> {
        self.bodies.lock().expect("mock lock").clone()
    }

    /// Hold the busy turn's answer (gated by its prompt text) until
    /// [`DelayedMock::release_busy_turn`]; arm before the turn starts.
    fn hold_busy_turn(&self, text: &str) {
        self.hold.arm(text);
    }

    /// Wait for the gated turn's model request: the busy turn is streaming, so prompts park behind
    /// it deterministically.
    fn wait_busy_turn_request(&self) {
        self.hold.wait_request();
    }

    fn release_busy_turn(&self) {
        self.hold.release();
    }
}

fn chunk(delta: &Value, finish_reason: Option<&str>) -> String {
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
    requests: &Arc<Mutex<usize>>,
    bodies: &Arc<Mutex<Vec<String>>>,
    hold: &Arc<HoldGate>,
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
    // The gate matches the prompt TEXT: extract it from the last user message,
    // plain string or text parts.
    let marker_text = body["messages"]
        .as_array()
        .and_then(|messages| {
            messages
                .iter()
                .rev()
                .find(|message| message["role"] == "user")
                .and_then(|message| match &message["content"] {
                    Value::String(text) => Some(text.clone()),
                    Value::Array(parts) => parts.iter().rev().find_map(|part| {
                        part.get("text").and_then(Value::as_str).map(str::to_string)
                    }),
                    _ => None,
                })
        })
        .unwrap_or_default();
    let gate_observed = hold.observe(&marker_text);
    let index = {
        let mut requests = requests.lock().expect("mock lock");
        *requests += 1;
        *requests
    };
    bodies
        .lock()
        .expect("mock lock")
        .push(format!("#{index}: {marker_text}"));
    if !gate_observed {
        std::thread::sleep(Duration::from_millis(ANSWER_DELAY_MS));
    }
    let answer = format!("answer {index}");
    let mut payload = String::new();
    for data in [
        chunk(&json!({"role": "assistant", "content": answer}), None),
        chunk(&json!({}), Some("stop")),
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
        let deadline = Instant::now() + Duration::from_mins(1);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
        let mut line = String::new();
        loop {
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => line.clear(),
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

    fn send_command(&mut self, id: &str, command: &Value) {
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
            self.collect_event(&line);
        }
    }

    fn collect_event(&mut self, line: &Value) {
        if line.get("type").and_then(Value::as_str) == Some("session_event") {
            self.events.push(line["event"].clone());
        }
    }

    fn drain_events(&mut self, quiet_ms: Duration) {
        let deadline = Instant::now() + Duration::from_mins(1);
        let mut last_line = Instant::now();
        let mut line = String::new();
        loop {
            assert!(Instant::now() < deadline, "event drain timed out");
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
                    line.clear();
                }
                Err(_) => {
                    if last_line.elapsed() >= quiet_ms {
                        return;
                    }
                }
            }
        }
    }

    fn send(&mut self, id: &str, command: &Value) -> Value {
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
    std::fs::write(agent_dir.join("settings.json"), "{}").expect("write settings.json");
    let socket = dir.path().join(format!("{name}.sock"));
    let supervisor = spawn_supervisor(&socket, &agent_dir);
    let mut client = Client::connect(&socket);
    let created = client.send(
        "c1",
        &json!({
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
        &json!({ "type": "attach", "activeSessionId": session_id }),
    );
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    (dir, mock, supervisor, client, session_id)
}

/// One queued prompt (the TUI submit path): `streamingBehavior` picks the lane, `queueIfBusy`
/// parks it.
fn queued_prompt(session_id: &str, message: &str, behavior: &str) -> Value {
    json!({
        "type": "prompt",
        "activeSessionId": session_id,
        "message": message,
        "streamingBehavior": behavior,
        "queueIfBusy": true,
    })
}

/// Drain until the projection with the given lane contents arrives (a bounded wait).
fn wait_for_projection(
    client: &mut Client,
    steering: &[&str],
    follow_ups: &[&str],
    what: &str,
) -> Vec<usize> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        client.drain_events(Duration::from_millis(400));
        let parked = action_updates_with(&client.events, steering, follow_ups);
        if !parked.is_empty() {
            return parked;
        }
        assert!(
            Instant::now() < deadline,
            "the {what} never projected; events: {:?}",
            event_types(&client.events)
        );
    }
}

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

    // Turn one holds its answer until the parked lane is observed; three prompts
    // park behind it: two steers, one follow-up.
    mock.hold_busy_turn("turn one");
    let started = client.send(
        "p1",
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": "turn one" }),
    );
    assert_eq!(started["success"], true, "prompt failed: {started}");
    // The busy turn is streaming before anything parks behind it.
    mock.wait_busy_turn_request();
    for (id, message, behavior) in [
        ("s1", "steer A", "steer"),
        ("s2", "steer B", "steer"),
        ("f1", "follow C", "followUp"),
    ] {
        let response = client.send(id, &queued_prompt(&session_id, message, behavior));
        assert_eq!(response["success"], true, "{id} failed: {response}");
    }
    let parked = wait_for_projection(
        &mut client,
        &["steer A", "steer B"],
        &["follow C"],
        "parked queue",
    );
    assert!(
        !parked.is_empty(),
        "the parked queue must project as session_action_update, events: {:?}",
        event_types(&client.events)
    );
    // The parked lane was observed while the busy turn held its answer; release it and watch the
    // boundary drain.
    mock.release_busy_turn();

    // Everything drains: three requests (turn one + the steers' batched turn + the follow-up's).
    let deadline = Instant::now() + Duration::from_mins(1);
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

    // The delivered batch leaves the projection BEFORE its turn starts (TS emits at the
    // `preparing` transition); under the batched default BOTH steers leave in one pickup.
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

    // Three steers and three follow-ups park behind the busy turn (dogfood: the queue
    // appeared to accept only one); the mock HOLDS the answer until the lane was observed.
    mock.hold_busy_turn("turn zero");
    let started = client.send(
        "p1",
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": "turn zero" }),
    );
    assert_eq!(started["success"], true, "prompt failed: {started}");
    // The busy turn is streaming before anything parks behind it.
    mock.wait_busy_turn_request();
    for (id, message, behavior) in [
        ("s1", "steer one", "steer"),
        ("s2", "steer two", "steer"),
        ("s3", "steer three", "steer"),
        ("f1", "follow one", "followUp"),
        ("f2", "follow two", "followUp"),
        ("f3", "follow three", "followUp"),
    ] {
        let response = client.send(id, &queued_prompt(&session_id, message, behavior));
        assert_eq!(response["success"], true, "{id} failed: {response}");
    }
    let parked = wait_for_projection(
        &mut client,
        &["steer one", "steer two", "steer three"],
        &["follow one", "follow two", "follow three"],
        "six-item parked lane",
    );
    let actions = &client.events[parked[0]]["actions"];
    assert_eq!(actions["queuedCount"], 6, "queuedCount counts both lanes");

    // The six-item lane was observed while the busy turn held its answer; release it.
    mock.release_busy_turn();

    // Five turns run: the starter, the steers' ONE batched turn, then the follow-ups one per turn.
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

/// TS #2063 (RES-1306): a queue-visible delivery's active action rides the turn through
/// its client-rendered phases; the settle's projection carries no active action.
#[test]
fn queue_delivery_projects_the_active_action_phases_around_the_turn() {
    let (_dir, mock, _supervisor, mut client, session_id) = setup("active-action-phases");

    // The busy turn holds its answer while a follow-up parks behind it.
    mock.hold_busy_turn("turn one");
    let started = client.send(
        "p1",
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": "turn one" }),
    );
    assert_eq!(started["success"], true, "prompt failed: {started}");
    mock.wait_busy_turn_request();
    let parked = client.send("f1", &queued_prompt(&session_id, "follow C", "followUp"));
    assert_eq!(parked["success"], true, "follow-up failed: {parked}");
    // The parked lane projects while the busy turn still holds.
    wait_for_projection(&mut client, &[], &["follow C"], "parked lane");
    mock.release_busy_turn();
    // Readiness wait for the follow-up's turn to reach the mock: the wait observes
    // the request rather than sleeping blind.
    let deadline = Instant::now() + Duration::from_secs(30);
    while mock.count() < 2 {
        client.drain_events(Duration::from_millis(200));
        assert!(
            Instant::now() < deadline,
            "the follow-up's turn never reached the mock; requests: {:?}",
            mock.request_log()
        );
    }
    client.drain_events(Duration::from_secs(2));
    assert_eq!(
        mock.count(),
        2,
        "turn one, then follow C's turn: {:?}",
        mock.request_log()
    );
    // The settle's projection (empty lanes, no active action) is the readiness shape,
    // not a fixed quiet window (post-turn work can outlast any drain).
    let deadline = Instant::now() + Duration::from_secs(30);
    let settled_index = loop {
        client.drain_events(Duration::from_millis(400));
        let found = client
            .events
            .iter()
            .enumerate()
            .find(|(_, event)| {
                event.get("type").and_then(Value::as_str) == Some("session_action_update")
                    && event["actions"]["steering"]
                        .as_array()
                        .is_some_and(Vec::is_empty)
                    && event["actions"]["followUps"]
                        .as_array()
                        .is_some_and(Vec::is_empty)
                    && event["actions"]["active"].is_null()
            })
            .map(|(index, _)| index);
        if let Some(index) = found {
            break index;
        }
        assert!(
            Instant::now() < deadline,
            "the settle's projection never fired; events: {:?}",
            event_types(&client.events)
        );
    };

    let events = &client.events;
    let action_updates: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, event)| {
            event.get("type").and_then(Value::as_str) == Some("session_action_update")
        })
        .map(|(index, _)| index)
        .collect();
    let phase_at = |index: usize, phase: &str| {
        events[index]["actions"]["active"]["phase"].as_str() == Some(phase)
    };
    let preparing = action_updates
        .iter()
        .copied()
        .find(|index| phase_at(*index, "preparing"))
        .expect("the follow-up's preparing projection never fired");
    assert_eq!(
        events[preparing]["actions"]["active"]["label"], "follow C",
        "the active label is the delivery's text (no labeled preview)"
    );
    let agent_starts: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, event)| event.get("type").and_then(Value::as_str) == Some("agent_start"))
        .map(|(index, _)| index)
        .collect();
    assert!(
        preparing < agent_starts[1],
        "the pickup projection precedes the delivered turn's start (events: {:?})",
        event_types(events)
    );
    // The `committing` projection lands after the turn's first row.
    let user_row = events
        .iter()
        .enumerate()
        .find(|(_, event)| {
            event.get("type").and_then(Value::as_str) == Some("message_start")
                && event["message"]["role"] == "user"
                && event["message"]["content"]
                    .as_array()
                    .and_then(|blocks| blocks.first())
                    .and_then(|block| block["text"].as_str())
                    == Some("follow C")
        })
        .map(|(index, _)| index)
        .expect("the follow-up's accepted row never broadcast");
    let committing = action_updates
        .iter()
        .copied()
        .find(|index| phase_at(*index, "committing"))
        .expect("the committing projection never fired");
    assert!(
        preparing < user_row && user_row < committing,
        "preparing precedes the accepted row, committing follows it (events: {:?})",
        event_types(events)
    );
    let assistant_row = events
        .iter()
        .enumerate()
        .find(|(index, event)| {
            index > &user_row
                && event.get("type").and_then(Value::as_str) == Some("message_start")
                && event["message"]["role"] == "assistant"
        })
        .map(|(index, _)| index)
        .expect("the follow-up's assistant row never broadcast");
    let running = action_updates
        .iter()
        .copied()
        .find(|index| phase_at(*index, "running"))
        .expect("the running projection never fired");
    assert!(
        assistant_row < running,
        "running follows the turn's first assistant frame (events: {:?})",
        event_types(events)
    );
    assert_eq!(
        action_updates.last(),
        Some(&settled_index),
        "the settle's projection is the last queue frame (events: {:?})",
        event_types(events)
    );
    assert!(settled_index > running);
}

fn event_types(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| event.get("type").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}
