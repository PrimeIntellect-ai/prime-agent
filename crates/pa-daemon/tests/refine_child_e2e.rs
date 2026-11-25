//! The refinement-child e2e (the daemon's `refine_child` spawn): the fire-and-wake
//! contract end to end. `/refine` spawns one refinement child and answers
//! immediately — before the child's planning call settles — and the child's
//! proposal lands as its child-reply: the parent wakes, re-reads the harness
//! state fresh, applies the proposal, emits the durable outcome rows and the
//! `refine_complete` event, and tears the child down. A child whose proposal
//! fails to parse surfaces `refine_failed` — a failed refinement is never
//! silent.
#![allow(clippy::large_futures)]
// 64-bit-only targets; the narrowing casts sit at bounded OS/protocol boundaries.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// Fn length is a style gate, not correctness.
#![allow(clippy::too_many_lines)]
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The child's planning reply delay: far past the `/refine` command's own
/// answer (the fire-and-wake boundary).
const PLAN_DELAY_MS: u64 = 4_000;

/// The fire-and-wake boundary: the refine command's answer must land before
/// the (delayed) planning call settles, with room for the spawn admission.
const REFINE_ANSWER_BOUND_MS: u64 = 2_000;

/// The refinement proposal the mock answers the child's planning call with:
/// one memory create the wake-side apply persists into the local harness
/// store.
const PROPOSAL: &str = r#"{"summary":"tactic","rationale":"the seed turn repeats a tactic","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m1","title":"Tactic","content":"Use tactic A"}]}"#;

/// What the mock answers the refinement planning call with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlanMode {
    /// The proposal JSON (the happy path).
    Proposal,
    /// Non-JSON text (the failed-proposal path: the wake surfaces the
    /// parse error visibly).
    Garbage,
    /// An output-limit stop (the truncated-JSON path: the child fails
    /// with the stop-reason taxonomy, naming the budget the wire carried).
    Length,
}

/// The mock's turn hold: while `holding`, a turn request waits for the
/// release and the planning request waits until a held turn arrived, so
/// the child's reply always lands while the parent's turn is open.
#[derive(Default)]
struct TurnHold {
    state: Mutex<TurnHoldState>,
    changed: Condvar,
}

#[derive(Default)]
struct TurnHoldState {
    holding: bool,
    turn_seen: bool,
    plan: PlanHold,
}

/// The planning-request hold: while armed, a planning request waits for
/// the release instead of answering (the child stays mid-plan).
#[derive(Default, PartialEq, Eq)]
enum PlanHold {
    #[default]
    Off,
    Armed,
    Held,
}

/// An OpenAI-compatible SSE mock: the refinement child's planning request
/// (the one carrying the refinement prompt's harness overview) is answered
/// per [`PlanMode`] after [`PLAN_DELAY_MS`]; every other request gets the
/// fixed turn reply. While [`RefineMock::hold_turns`] is on, the
/// [`TurnHold`] orders the two instead.
struct RefineMock {
    requests: Arc<Mutex<Vec<Value>>>,
    plan_mode: Arc<Mutex<PlanMode>>,
    hold: Arc<TurnHold>,
    port: u16,
}

impl RefineMock {
    fn start() -> RefineMock {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let plan_mode = Arc::new(Mutex::new(PlanMode::Proposal));
        let hold = Arc::new(TurnHold::default());
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().expect("mock addr").port();
        let requests_for_thread = Arc::clone(&requests);
        let mode_for_thread = Arc::clone(&plan_mode);
        let hold_for_thread = Arc::clone(&hold);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let requests = Arc::clone(&requests_for_thread);
                let mode = Arc::clone(&mode_for_thread);
                let hold = Arc::clone(&hold_for_thread);
                std::thread::spawn(move || {
                    let _ = serve(stream, &requests, &mode, &hold);
                });
            }
        });
        RefineMock {
            requests,
            plan_mode,
            hold,
            port,
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    fn set_plan_mode(&self, mode: PlanMode) {
        *self.plan_mode.lock().expect("mock lock") = mode;
    }

    /// Hold every turn request until [`Self::release_turns`]; the planning
    /// request answers once a held turn arrived.
    fn hold_turns(&self) {
        self.hold.state.lock().expect("mock lock").holding = true;
    }

    /// Wait until a turn request is held.
    fn wait_for_held_turn(&self) {
        drop(
            self.hold
                .changed
                .wait_while(self.hold.state.lock().expect("mock lock"), |state| {
                    !state.turn_seen
                })
                .expect("mock lock"),
        );
    }

    fn release_turns(&self) {
        self.hold.state.lock().expect("mock lock").holding = false;
        self.hold.changed.notify_all();
    }

    /// Hold every planning request until [`Self::release_plans`].
    fn hold_plans(&self) {
        self.hold.state.lock().expect("mock lock").plan = PlanHold::Armed;
    }

    /// Wait until a planning request is held (the child is mid-plan).
    fn wait_for_held_plan(&self) {
        drop(
            self.hold
                .changed
                .wait_while(self.hold.state.lock().expect("mock lock"), |state| {
                    state.plan != PlanHold::Held
                })
                .expect("mock lock"),
        );
    }

    fn release_plans(&self) {
        self.hold.state.lock().expect("mock lock").plan = PlanHold::Off;
        self.hold.changed.notify_all();
    }

    fn planning_request_count(&self) -> usize {
        self.requests
            .lock()
            .expect("mock lock")
            .iter()
            .filter(|body| is_refinement_plan_request(body))
            .count()
    }
}

/// The refinement planning request: the child's prompt always carries the
/// harness overview section.
fn is_refinement_plan_request(body: &Value) -> bool {
    body["messages"].as_array().is_some_and(|messages| {
        messages
            .iter()
            .any(|message| message_text(message).contains("<current_harness_state>"))
    })
}

fn message_text(message: &Value) -> String {
    let content = &message["content"];
    content
        .as_str()
        .map(str::to_string)
        .or_else(|| {
            content
                .as_array()
                .and_then(|blocks| blocks.first())
                .and_then(|block| block.get("text"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn read_body(reader: &mut BufReader<TcpStream>) -> std::io::Result<Value> {
    let mut head = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(Value::Null);
        }
        head.push_str(&line);
        if line == "\r\n" {
            break;
        }
    }
    let mut content_length = 0usize;
    for line in head.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            content_length = rest.trim().parse().unwrap_or_default();
        }
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

fn chunk(delta: &Value, finish_reason: Option<&str>, usage: &Value) -> String {
    json!({
        "id": "chatcmpl-test",
        "object": "chat.completion.chunk",
        "created": 1_750_000_000,
        "model": "mock-1",
        "choices": [{
            "index": 0,
            "delta": delta,
            "finish_reason": finish_reason,
        }],
        "usage": usage,
    })
    .to_string()
}

fn small_usage() -> Value {
    json!({
        "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15,
        "prompt_tokens_details": {"cached_tokens": 0},
    })
}

fn write_sse(
    stream: &mut TcpStream,
    reply: &str,
    finish_reason: &str,
    usage: &Value,
) -> std::io::Result<()> {
    let mut payload = String::new();
    for data in [
        chunk(
            &json!({"role": "assistant", "content": reply}),
            None,
            &small_usage(),
        ),
        chunk(&json!({}), Some(finish_reason), usage),
        json!({
            "id": "chatcmpl-test",
            "object": "chat.completion.chunk",
            "created": 1_750_000_000,
            "model": "mock-1",
            "choices": [],
            "usage": usage,
        })
        .to_string(),
    ] {
        let _ = write!(payload, "data: {data}\n\n");
    }
    payload.push_str("data: [DONE]\n\n");
    stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}"
        )
        .as_bytes(),
    )
}

fn serve(
    mut stream: TcpStream,
    requests: &Arc<Mutex<Vec<Value>>>,
    plan_mode: &Arc<Mutex<PlanMode>>,
    hold: &TurnHold,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let body = read_body(&mut reader)?;
    requests.lock().expect("mock lock").push(body.clone());
    if is_refinement_plan_request(&body) {
        let mut state = hold.state.lock().expect("mock lock");
        if state.plan != PlanHold::Off {
            state.plan = PlanHold::Held;
            hold.changed.notify_all();
            drop(
                hold.changed
                    .wait_while(state, |state| state.plan != PlanHold::Off)
                    .expect("mock lock"),
            );
        } else if state.holding {
            drop(
                hold.changed
                    .wait_while(state, |state| state.holding && !state.turn_seen)
                    .expect("mock lock"),
            );
        } else {
            drop(state);
            std::thread::sleep(Duration::from_millis(PLAN_DELAY_MS));
        }
        let (reply, reason) = match *plan_mode.lock().expect("mock lock") {
            PlanMode::Proposal => (PROPOSAL, "stop"),
            PlanMode::Garbage => ("not a plan", "stop"),
            PlanMode::Length => ("{\"summary\":\"cut", "length"),
        };
        return write_sse(&mut stream, reply, reason, &small_usage());
    }
    let mut state = hold.state.lock().expect("mock lock");
    if state.holding {
        state.turn_seen = true;
        hold.changed.notify_all();
        drop(
            hold.changed
                .wait_while(state, |state| state.holding)
                .expect("mock lock"),
        );
    } else {
        drop(state);
    }
    write_sse(&mut stream, "a reply", "stop", &small_usage())
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

// The timeout panic path cannot wait on the child; the test exits and reaps it.
#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path, stderr_path: &Path) -> Supervisor {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let stderr_file = std::fs::File::create(stderr_path).expect("daemon stderr file");
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file))
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

fn write_fixture(agent_dir: &Path, session_dir: &Path, mock_url: &str) {
    std::fs::create_dir_all(session_dir).expect("session dir");
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": mock_url,
                    "apiKey": "sk-battery",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096,
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
        json!({ "compaction": {"enabled": false} }).to_string(),
    )
    .expect("write settings.json");
}

/// JSONL supervisor client (command envelopes, id-matched responses,
/// captured session events).
struct TimedClient {
    reader: BufReader<std::os::unix::net::UnixStream>,
    writer: std::os::unix::net::UnixStream,
    events: Vec<(Value, Instant)>,
}

impl TimedClient {
    fn connect(socket: &Path) -> TimedClient {
        let stream = std::os::unix::net::UnixStream::connect(socket).expect("connect");
        let writer = stream.try_clone().expect("clone");
        let mut client = TimedClient {
            reader: BufReader::new(stream),
            writer,
            events: Vec::new(),
        };
        let hello = client.read_line();
        assert_eq!(hello["type"], "daemon_hello");
        client
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
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(120);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
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

    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
            if line.get("type").and_then(Value::as_str) == Some("session_event") {
                self.events.push((line["event"].clone(), Instant::now()));
            }
        }
    }

    fn drain_events(&mut self, quiet_ms: u64) {
        let deadline = Instant::now() + Duration::from_millis(quiet_ms);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(50)))
            .expect("timeout");
        let mut line = String::new();
        loop {
            match self.reader.read_line(&mut line) {
                Ok(0) => return,
                Ok(_) if line.trim().is_empty() => line.clear(),
                Ok(_) => {
                    if let Ok(event) = serde_json::from_str::<Value>(line.trim()) {
                        if event.get("type").and_then(Value::as_str) == Some("session_event") {
                            self.events.push((event["event"].clone(), Instant::now()));
                        }
                    }
                    line.clear();
                }
                Err(_) => {}
            }
            if Instant::now() >= deadline {
                return;
            }
        }
    }
}

fn create_and_attach(client: &mut TimedClient, session_dir: &Path) -> (String, String) {
    client.send_command(
        "c1",
        &json!({
            "type": "create",
            "config": {
                "cwd": session_dir.to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "provider": "prime-inference",
                "model": "mock-1",
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .or_else(|| created["data"]["activeSessionId"].as_str())
        .expect("session id")
        .to_string();
    client.send_command(
        "a1",
        &json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    // The parent's durable session id (the roster row's `sessionId`): the
    // child's session artifacts and its ledger live under it.
    client.send_command("l1", &json!({ "type": "list" }));
    let listed = client.read_response("l1");
    assert_eq!(listed["success"], true, "list failed: {listed}");
    let row = listed["data"]["sessions"]
        .as_array()
        .expect("sessions array")
        .iter()
        .find(|row| row["activeSessionId"] == json!(session_id) || row["id"] == json!(session_id))
        .expect("the attached session's roster row");
    let durable_session_id = row["sessionId"]
        .as_str()
        .or_else(|| row["id"].as_str())
        .expect("durable session id")
        .to_string();
    (session_id, durable_session_id)
}

fn prompt_and_wait(client: &mut TimedClient, id: &str, session_id: &str, message: &str) {
    client.send_command(
        id,
        &json!({"type": "prompt_and_wait", "activeSessionId": session_id, "message": message}),
    );
    let response = client.read_response(id);
    assert_eq!(response["success"], true, "prompt {id} failed: {response}");
}

/// `/refine` with instructions (the planning request the child carries).
fn refine(client: &mut TimedClient, id: &str, session_id: &str) -> Value {
    client.send_command(
        id,
        &json!({
            "type": "refine",
            "activeSessionId": session_id,
            "instructions": "record the recurring tactic as a memory",
        }),
    );
    client.read_response(id)
}

/// Wait until the refinement child's run settled: the child sends its
/// reply before its turn ends, so by then the parent has parked it.
fn wait_for_refine_child_settle(client: &mut TimedClient, parent: &str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    for attempt in 0.. {
        let rows = rlm_children_rows(client, &format!("settle{attempt}"), parent);
        if rows.iter().all(|row| row["status"] != "running") {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the refinement child never settled; rows: {rows:?}"
        );
        client.drain_events(100);
    }
}

/// The parent's tracked-children wire surface (`get_rlm_children`).
fn rlm_children_rows(client: &mut TimedClient, id: &str, parent: &str) -> Vec<Value> {
    client.send_command(
        id,
        &json!({ "type": "get_rlm_children", "activeSessionId": parent }),
    );
    let response = client.read_response(id);
    assert_eq!(
        response["success"], true,
        "get_rlm_children failed: {response}"
    );
    response["data"]["children"]
        .as_array()
        .cloned()
        .expect("children array")
}

/// The child's semantic-edge ledger (its registration line carries the
/// refinement kind).
fn child_ledger(agent_dir: &Path, durable_session_id: &str, child_id: &str) -> Vec<Value> {
    let ledger_path = agent_dir
        .join("session-artifacts")
        .join(durable_session_id)
        .join(child_id)
        .join("semantic-edges.jsonl");
    let content = std::fs::read_to_string(&ledger_path)
        .unwrap_or_else(|error| panic!("read {}: {error}", ledger_path.display()));
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

/// The local harness state the wake-side apply wrote: the session's own
/// digest store — the artifact dir the conversation log implies — never a
/// shared sessions/harness file.
fn local_harness_state(session_dir: &Path) -> Value {
    let log = std::fs::read_dir(session_dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
        });
    let Some(store) = log
        .as_deref()
        .and_then(pa_core::session_engine::harness_digest::local_harness_dir_for_log)
    else {
        return Value::Null;
    };
    let path = pa_core::refinement::get_harness_state_path(&store);
    std::fs::read_to_string(&path).map_or(Value::Null, |content| {
        serde_json::from_str::<Value>(&content).expect("harness state parses")
    })
}

/// The captured daemon stderr's tail (the failure diagnostics).
fn daemon_stderr(path: &Path) -> String {
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let tail: Vec<&str> = content.lines().rev().take(16).collect();
    tail.into_iter().rev().collect::<Vec<&str>>().join(" | ")
}

/// Wait until the named event lands (the wake-side rows and events
/// arrive asynchronously); the panic surfaces the daemon stderr.
fn wait_for_event(
    client: &mut TimedClient,
    budget: Duration,
    name: &str,
    stderr_path: &Path,
) -> Value {
    let deadline = Instant::now() + budget;
    loop {
        client.drain_events(200);
        if let Some(event) = client
            .events
            .iter()
            .rev()
            .find(|(event, _)| event["type"] == json!(name))
            .map(|(event, _)| event.clone())
        {
            return event;
        }
        assert!(
            Instant::now() < deadline,
            "the {name} event never landed; events: {:?}; stderr: {}",
            client
                .events
                .iter()
                .map(|(event, _)| event["type"].clone())
                .collect::<Vec<_>>(),
            daemon_stderr(stderr_path)
        );
    }
}

/// The fire-and-wake round trip: `/refine` answers before the child's
/// (delayed) planning call settles; the child's reply wakes the parent,
/// which applies the proposal and tears the child down.
#[test]
fn refine_spawns_a_child_that_applies_on_its_reply_wake() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    let mock = RefineMock::start();
    write_fixture(&agent_dir, &session_dir, &mock.url());
    let socket = dir.path().join("daemon.sock");
    let _supervisor = spawn_supervisor(&socket, &agent_dir, &dir.path().join("daemon.stderr"));
    let mut client = TimedClient::connect(&socket);
    let (session_id, durable_session_id) = create_and_attach(&mut client, &session_dir);
    prompt_and_wait(&mut client, "p0", &session_id, "seed turn");

    // Fire: the command answers immediately, before the child's planning
    // call (mocked at PLAN_DELAY_MS) settles.
    let refine_started = Instant::now();
    let response = refine(&mut client, "r1", &session_id);
    let answer_elapsed = refine_started.elapsed();
    assert_eq!(response["success"], true, "refine failed: {response}");
    assert_eq!(
        response["data"]["refinementChildSpawned"], true,
        "the refine command ran a planning pass inline: {response}"
    );
    let child_id = response["data"]["rlmChildId"]
        .as_str()
        .expect("child id")
        .to_string();
    assert!(
        answer_elapsed < Duration::from_millis(REFINE_ANSWER_BOUND_MS),
        "the refine answer waited {answer_elapsed:?} — it must not hold for the child"
    );

    // The child's own ledger line registers its spawn provenance: the
    // parent edge anchors the refinement child's registration (its
    // `refineChild` kind rides the durable create's runtimeMetadata,
    // where the spawn records it once for the whole session).
    let deadline = Instant::now() + Duration::from_secs(10);
    let registered = loop {
        let ledger = child_ledger(&agent_dir, &durable_session_id, &child_id);
        let registered = ledger
            .iter()
            .find(|event| event["type"] == "session_registered");
        if let Some(registered) = registered {
            break registered.clone();
        }
        assert!(
            Instant::now() < deadline,
            "the child never registered its spawn provenance; ledger: {ledger:?}"
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(registered["parent_session_id"], json!(durable_session_id));

    // Wake: the child's proposal lands as its reply, and the parent
    // applies it — the durable outcome rows and the refine_complete
    // event.

    let complete = wait_for_event(
        &mut client,
        Duration::from_secs(20),
        "refine_complete",
        &dir.path().join("daemon.stderr"),
    );
    assert_eq!(
        complete["result"]["appliedEdits"][0]["id"], "m1",
        "the proposal applied: {complete}"
    );
    assert_eq!(complete["result"]["appliedEdits"][0]["applied"], true);
    assert!(
        client.events.iter().any(|(event, _)| {
            event["type"] == "message_end" && event["message"]["customType"] == "refinement_outcome"
        }),
        "the refinement outcome row never surfaced"
    );
    // The wake-side apply re-read the local harness store and persisted
    // the proposal's memory.
    let state = local_harness_state(&session_dir);
    assert_eq!(
        state["entries"]["memory"]["m1"]["title"], "Tactic",
        "the applied harness state: {state}"
    );
    assert_eq!(
        mock.planning_request_count(),
        1,
        "exactly one planning call (the child's, never the parent's)"
    );

    // The planning pass bills on the parent's totals: the child's answer
    // row carries the model reply's usage and stop reason, so the wake's
    // usage attribution folds the planning call into a durable
    // `child_usage_attributed` row (origin: the spawn task, the mock's
    // usage shape: input 10, output 5).
    let session_file = std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .filter_map(std::result::Result::ok)
        .find(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .expect("the parent's session file")
        .path();
    let attribution_deadline = Instant::now() + Duration::from_secs(20);
    let attributed_row = loop {
        let rows: Vec<Value> = std::fs::read_to_string(&session_file)
            .expect("read session file")
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let attributed = rows
            .iter()
            .find(|row| row["type"] == "child_usage_attributed");
        if let Some(attributed) = attributed {
            break attributed.clone();
        }
        assert!(
            Instant::now() < attribution_deadline,
            "the planning call never billed on the parent: no child_usage_attributed row"
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(attributed_row["origin"], "spawn_task", "{attributed_row}");
    assert_eq!(
        attributed_row["childUsage"]["input"], 10,
        "{attributed_row}"
    );
    assert_eq!(
        attributed_row["childUsage"]["output"], 5,
        "{attributed_row}"
    );

    // Teardown: the one-shot child retires after its reply's apply.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let rows = rlm_children_rows(&mut client, "g1", &session_id);
        if rows.is_empty() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the refinement child never tore down; rows: {rows:?}"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    assert!(
        !client
            .events
            .iter()
            .any(|(event, _)| event["type"] == "refine_failed"),
        "no failed refinement surfaced on the happy path"
    );
}

/// The slash `/refine` records its spawn result row and the child id: the
/// host skips the executor's first row as the already-emitted echo, so the
/// spawn result must ride after the echo. Red when the spawn path returns
/// only the result row: the host drops it and the transcript never names
/// the child.
#[test]
fn a_slash_refine_records_its_spawn_result_row() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    let mock = RefineMock::start();
    write_fixture(&agent_dir, &session_dir, &mock.url());
    let socket = dir.path().join("daemon.sock");
    let _supervisor = spawn_supervisor(&socket, &agent_dir, &dir.path().join("daemon.stderr"));
    let mut client = TimedClient::connect(&socket);
    let (session_id, _durable_session_id) = create_and_attach(&mut client, &session_dir);
    prompt_and_wait(&mut client, "p0", &session_id, "seed turn");

    prompt_and_wait(
        &mut client,
        "r2",
        &session_id,
        "/refine record the recurring tactic as a memory",
    );

    let result_text = client
        .events
        .iter()
        .rev()
        .find_map(|(event, _)| {
            (event["type"] == "message_end"
                && event["message"]["customType"] == "session_slash_command_result")
                .then(|| {
                    event["message"]["content"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string()
                })
        })
        .expect("the slash /refine result row surfaced");
    assert!(
        result_text.starts_with("Refinement child spawned ("),
        "unexpected slash /refine result row: {result_text}"
    );

    // The host's event persistence keeps the same row and the child id.
    let session_file = std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .filter_map(std::result::Result::ok)
        .find(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .expect("the parent's session file")
        .path();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let rows: Vec<Value> = std::fs::read_to_string(&session_file)
            .expect("read session file")
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        if rows.iter().any(|row| {
            row["type"] == "custom_message"
                && row["customType"] == "session_slash_command_result"
                && row["content"]
                    .as_str()
                    .is_some_and(|text| text.starts_with("Refinement child spawned ("))
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the slash /refine result row is not durable; rows: {rows:?}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// The failed proposal surfaces visibly: the child's unparseable reply
/// wakes the parent into a `refine_failed` event, and the child still
/// tears down (a failed refinement is never silent).
#[test]
fn a_failed_child_proposal_surfaces_the_refine_failed_event() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    let mock = RefineMock::start();
    mock.set_plan_mode(PlanMode::Garbage);
    write_fixture(&agent_dir, &session_dir, &mock.url());
    let socket = dir.path().join("daemon.sock");
    let _supervisor = spawn_supervisor(&socket, &agent_dir, &dir.path().join("daemon.stderr"));
    let mut client = TimedClient::connect(&socket);
    let (session_id, _durable) = create_and_attach(&mut client, &session_dir);
    prompt_and_wait(&mut client, "p0", &session_id, "seed turn");

    let response = refine(&mut client, "r1", &session_id);
    assert_eq!(response["success"], true, "refine failed: {response}");
    assert_eq!(response["data"]["refinementChildSpawned"], true);

    let failed = wait_for_event(
        &mut client,
        Duration::from_secs(20),
        "refine_failed",
        &dir.path().join("daemon.stderr"),
    );
    let error = failed["error"].as_str().unwrap_or_default();
    assert!(!error.is_empty(), "the failure message rides the event");
    assert!(
        client
            .events
            .iter()
            .all(|(event, _)| event["type"] != "refine_complete"),
        "no refinement completed on the failed path"
    );
    assert_eq!(
        local_harness_state(&session_dir),
        Value::Null,
        "the failed proposal never persisted harness state"
    );

    // The child tears down on the failed reply's wake too.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let rows = rlm_children_rows(&mut client, "g1", &session_id);
        if rows.is_empty() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the failed refinement child never tore down; rows: {rows:?}"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// An output-limit stop fails visibly and names the budget the wire request
/// carried: the parent's planning request fixes the budget, the child sends
/// it, and the parent's shared reply check names it. Red when the child
/// drops the parent's budget (the message would name a number the wire
/// never carried) or the stop parses as JSON.
#[test]
fn a_length_stop_names_the_budget_the_wire_carries() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    let mock = RefineMock::start();
    mock.set_plan_mode(PlanMode::Length);
    write_fixture(&agent_dir, &session_dir, &mock.url());
    let socket = dir.path().join("daemon.sock");
    let _supervisor = spawn_supervisor(&socket, &agent_dir, &dir.path().join("daemon.stderr"));
    let mut client = TimedClient::connect(&socket);
    let (session_id, _durable) = create_and_attach(&mut client, &session_dir);
    prompt_and_wait(&mut client, "p0", &session_id, "seed turn");

    let response = refine(&mut client, "r1", &session_id);
    assert_eq!(response["success"], true, "refine failed: {response}");
    assert_eq!(response["data"]["refinementChildSpawned"], true);

    let failed = wait_for_event(
        &mut client,
        Duration::from_secs(20),
        "refine_failed",
        &dir.path().join("daemon.stderr"),
    );
    let error = failed["error"].as_str().unwrap_or_default();
    let marker = "the model hit its output limit (";
    let start = error
        .find(marker)
        .unwrap_or_else(|| panic!("the failure names the output limit: {error}"))
        + marker.len();
    let end = match error[start..].find(" tokens") {
        Some(offset) => start + offset,
        None => panic!("the failure names the token count: {error}"),
    };
    let named: u64 = error[start..end]
        .parse()
        .unwrap_or_else(|_| panic!("the token count parses: {error}"));

    // The number the message names is the number the wire carried: the
    // captured planning request's `max_tokens`.
    let requests = mock.requests.lock().expect("mock lock");
    let planning = requests
        .iter()
        .find(|body| is_refinement_plan_request(body))
        .expect("the captured planning request");
    let wire_budget = planning["max_tokens"]
        .as_u64()
        .or_else(|| planning["max_completion_tokens"].as_u64())
        .expect("the planning request's output budget");
    assert_eq!(
        named, wire_budget,
        "the Length failure must name the wire budget: {error}"
    );
    drop(requests);
    assert!(
        client
            .events
            .iter()
            .all(|(event, _)| event["type"] != "refine_complete"),
        "no completion event on the length path"
    );
}

/// A reply that lands while the parent's turn is still running parks
/// instead of applying inside the delivery: the outcome and notice rows
/// surface only after that turn settled, so the parent's history never
/// gains a refinement notice between an in-flight assistant message and
/// its own completion. Red when the apply runs inside the delivery: the
/// notice's `message_end` precedes the turn's final assistant row.
#[test]
fn a_reply_that_lands_mid_turn_applies_only_after_the_turn_settles() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    let mock = RefineMock::start();
    write_fixture(&agent_dir, &session_dir, &mock.url());
    let socket = dir.path().join("daemon.sock");
    let _supervisor = spawn_supervisor(&socket, &agent_dir, &dir.path().join("daemon.stderr"));
    let mut client = TimedClient::connect(&socket);
    let (session_id, _durable) = create_and_attach(&mut client, &session_dir);
    prompt_and_wait(&mut client, "p0", &session_id, "seed turn");

    // Fire: the mock holds the parent's next turn open and answers the
    // child's planning request only once that turn is in flight, so the
    // child's reply lands mid-turn; the turn is released after the child
    // settled (its reply parked).
    mock.hold_turns();
    let response = refine(&mut client, "r1", &session_id);
    assert_eq!(response["success"], true, "refine failed: {response}");
    assert_eq!(response["data"]["refinementChildSpawned"], true);
    client.send_command(
        "p1",
        &json!({
            "type": "prompt_and_wait",
            "activeSessionId": session_id,
            "message": "second turn",
        }),
    );
    wait_for_refine_child_settle(&mut client, &session_id);
    mock.release_turns();
    let second = client.read_response("p1");
    assert_eq!(second["success"], true, "second turn failed: {second}");
    client.drain_events(200);

    // The wake completed: the apply ran after the open turn settled.
    let complete = wait_for_event(
        &mut client,
        Duration::from_secs(30),
        "refine_complete",
        &dir.path().join("daemon.stderr"),
    );
    assert_eq!(
        complete["result"]["appliedEdits"][0]["id"], "m1",
        "the proposal applied: {complete}"
    );
    assert_eq!(complete["result"]["appliedEdits"][0]["applied"], true);
    assert!(
        !client
            .events
            .iter()
            .any(|(event, _)| event["type"] == "refine_failed"),
        "no failed refinement surfaced on the parked-reply path"
    );

    // The ordering pin: the parent's open turn settled first — its final
    // assistant row precedes the refinement rows and the completion
    // event. An apply inside the delivery emits them while the turn is
    // still streaming, before that row.
    let assistant_end = client
        .events
        .iter()
        .rposition(|(event, _)| {
            event["type"] == "message_end" && event["message"]["role"] == "assistant"
        })
        .expect("the open turn's final assistant row");
    let event_index = |name: &str, matches: &dyn Fn(&Value) -> bool| -> usize {
        client
            .events
            .iter()
            .position(|(event, _)| matches(event))
            .unwrap_or_else(|| panic!("{name} never surfaced"))
    };
    let outcome_end = event_index("the refinement outcome row", &|event: &Value| {
        event["type"] == "message_end" && event["message"]["customType"] == "refinement_outcome"
    });
    let notice_end = event_index("the refinement notice row", &|event: &Value| {
        event["type"] == "message_end" && event["message"]["customType"] == "refinement_notice"
    });
    let complete_index = event_index("the refine_complete event", &|event: &Value| {
        event["type"] == "refine_complete"
    });
    for (name, index) in [
        ("the refinement outcome row", outcome_end),
        ("the refinement notice row", notice_end),
        ("the refine_complete event", complete_index),
    ] {
        assert!(
            index > assistant_end,
            "{name} (index {index}) must follow the open turn's settled row (index {assistant_end})"
        );
    }

    // The durable session file carries the same order: the parked reply's
    // notice row persists after the open turn's final assistant row.
    let session_file = std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .filter_map(std::result::Result::ok)
        .find(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .expect("the parent's session file")
        .path();
    let rows: Vec<Value> = std::fs::read_to_string(&session_file)
        .expect("read session file")
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let durable_assistant = rows
        .iter()
        .rposition(|row| row["type"] == "message" && row["message"]["role"] == "assistant")
        .expect("the durable assistant row");
    let durable_notice = rows
        .iter()
        .position(|row| row["type"] == "custom_message" && row["customType"] == "refinement_notice")
        .expect("the durable notice row");
    assert!(
        durable_notice > durable_assistant,
        "the durable notice row ({durable_notice}) must follow the settled turn's assistant row ({durable_assistant})"
    );
    assert_eq!(
        local_harness_state(&session_dir)["entries"]["memory"]["m1"]["title"],
        "Tactic",
        "the parked reply's apply wrote the harness state"
    );

    // The one-shot child still retires on the parked reply's apply.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let rows = rlm_children_rows(&mut client, "g2", &session_id);
        if rows.is_empty() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the refinement child never tore down; rows: {rows:?}"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// A queued follow-up sees the parked refinement before its own turn: the
/// runner applies the parked reply at each turn's park boundary, not only
/// when the queue drains. Red when the apply lives only in the idle
/// branch: the follow-up turn runs first and the outcome row lands after
/// its rows.
#[test]
fn a_queued_follow_up_sees_the_parked_apply_before_its_turn() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    let mock = RefineMock::start();
    write_fixture(&agent_dir, &session_dir, &mock.url());
    let socket = dir.path().join("daemon.sock");
    let _supervisor = spawn_supervisor(&socket, &agent_dir, &dir.path().join("daemon.stderr"));
    let mut client = TimedClient::connect(&socket);
    let (session_id, _durable) = create_and_attach(&mut client, &session_dir);
    prompt_and_wait(&mut client, "p0", &session_id, "seed turn");

    // The mock holds the parent's next turn open and answers the child's
    // planning request only once that turn is in flight; the follow-up is
    // queued during that turn, and the turn is released only after the
    // child settled (its reply parked).
    mock.hold_turns();
    let response = refine(&mut client, "r1", &session_id);
    assert_eq!(response["success"], true, "refine failed: {response}");
    assert_eq!(response["data"]["refinementChildSpawned"], true);
    client.send_command(
        "p1",
        &json!({
            "type": "prompt_and_wait",
            "activeSessionId": session_id,
            "message": "second turn",
        }),
    );
    // The follow-up is sent only once the second turn is in flight, so it
    // queues behind that turn.
    mock.wait_for_held_turn();
    client.send_command(
        "f1",
        &json!({
            "type": "follow_up",
            "activeSessionId": session_id,
            "message": "queued follow",
        }),
    );
    let follow = client.read_response("f1");
    assert_eq!(follow["success"], true, "follow_up failed: {follow}");
    wait_for_refine_child_settle(&mut client, &session_id);
    mock.release_turns();
    let second = client.read_response("p1");
    assert_eq!(second["success"], true, "second turn failed: {second}");

    // The follow-up turn starts after the park boundary: its user row must
    // surface after the refinement outcome row.
    let deadline = Instant::now() + Duration::from_secs(20);
    let follow_index = loop {
        if let Some(index) = client.events.iter().position(|(event, _)| {
            event["type"] == "message_end"
                && event["message"]["role"] == "user"
                && event["message"]["content"][0]["text"] == "queued follow"
        }) {
            break index;
        }
        assert!(
            Instant::now() < deadline,
            "the queued follow-up turn never started"
        );
        client.drain_events(100);
    };
    let outcome_index = client
        .events
        .iter()
        .position(|(event, _)| {
            event["type"] == "message_end" && event["message"]["customType"] == "refinement_outcome"
        })
        .expect("the refinement outcome row surfaced");
    assert!(
        outcome_index < follow_index,
        "the refinement outcome (index {outcome_index}) must precede the queued follow-up turn (index {follow_index})"
    );
    assert_eq!(
        local_harness_state(&session_dir)["entries"]["memory"]["m1"]["title"],
        "Tactic",
        "the parked reply's apply wrote the harness state"
    );
}

/// A branch move abandons the in-flight refinement child: the move cancels
/// the child while its planning call is still open and drops its lane, so
/// no proposal applies to the moved-to branch and no late reply reaches the
/// parent's conversation; the next `/refine` spawns at once. Red when the
/// move keeps the lane (the proposal applies after the move) or skips the
/// cancel (the child's late reply lands as an agent message).
#[test]
fn a_branch_move_cancels_the_in_flight_refine_child() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    let mock = RefineMock::start();
    write_fixture(&agent_dir, &session_dir, &mock.url());
    let socket = dir.path().join("daemon.sock");
    let stderr_path = dir.path().join("daemon.stderr");
    let _supervisor = spawn_supervisor(&socket, &agent_dir, &stderr_path);
    let mut client = TimedClient::connect(&socket);
    let (session_id, _durable) = create_and_attach(&mut client, &session_dir);
    prompt_and_wait(&mut client, "p0", &session_id, "seed turn");
    prompt_and_wait(&mut client, "p1", &session_id, "second turn");

    let response = refine(&mut client, "r1", &session_id);
    assert_eq!(response["success"], true, "refine failed: {response}");
    assert_eq!(response["data"]["refinementChildSpawned"], true);

    // The move lands while the child's planning call is still open (the
    // mock answers it after PLAN_DELAY_MS): back to the first reply.
    client.send_command(
        "t1",
        &json!({ "type": "get_session_tree", "activeSessionId": session_id }),
    );
    let tree = client.read_response("t1");
    let first_assistant_id = tree["data"]["flatNodes"]
        .as_array()
        .expect("flatNodes")
        .iter()
        .find(|node| {
            node["entry"]["type"] == "message" && node["entry"]["message"]["role"] == "assistant"
        })
        .and_then(|node| node["entry"]["id"].as_str())
        .expect("the first assistant entry")
        .to_string();
    client.send_command(
        "n1",
        &json!({
            "type": "navigate_tree",
            "activeSessionId": session_id,
            "targetId": first_assistant_id,
        }),
    );
    let moved = client.read_response("n1");
    assert_eq!(moved["success"], true, "the branch move failed: {moved}");
    // The move cancelled the child while its planning call was still open.
    let rows = rlm_children_rows(&mut client, "g0", &session_id);
    assert!(
        rows.iter().all(|row| row["status"] != "running"),
        "the abandoned refinement child still runs after the move: {rows:?}"
    );

    // Past the planning delay: nothing applied and nothing delivered.
    std::thread::sleep(Duration::from_millis(PLAN_DELAY_MS + 2_000));
    client.drain_events(500);
    assert!(
        client
            .events
            .iter()
            .all(|(event, _)| event["type"] != "refine_complete"),
        "the abandoned proposal applied after the branch move; stderr: {}",
        daemon_stderr(&stderr_path)
    );
    assert!(
        !client.events.iter().any(|(event, _)| {
            event["type"] == "message_end" && event["message"]["customType"] == "agent_message"
        }),
        "the abandoned child's late reply reached the parent's conversation"
    );
    assert_eq!(
        local_harness_state(&session_dir),
        Value::Null,
        "no abandoned proposal reached the harness store"
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let rows = rlm_children_rows(&mut client, "g1", &session_id);
        if rows.is_empty() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the cancelled refinement child never tore down; rows: {rows:?}"
        );
        std::thread::sleep(Duration::from_millis(200));
    }

    // The lane is free: the next `/refine` spawns and applies on the
    // moved-to branch.
    let response = refine(&mut client, "r2", &session_id);
    assert_eq!(
        response["success"], true,
        "the lane stayed held: {response}"
    );
    let complete = wait_for_event(
        &mut client,
        Duration::from_secs(20),
        "refine_complete",
        &stderr_path,
    );
    assert_eq!(complete["result"]["appliedEdits"][0]["applied"], true);
}

/// A refinement child that ends mid-plan without replying (a user cancel
/// of its run) fails its refinement: exactly one `refine_failed` names the
/// child's end, no generic child notice, late reply or follow-up turn
/// reaches the parent, the flight is released at the child's end, and the
/// next `/refine` spawns, plans and commits. Red when the child's end is
/// silent (no `refine_failed`), or when it still rides the generic
/// child-terminal notice into the parent.
#[test]
fn a_refine_child_that_ends_mid_plan_fails_the_refinement() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    let mock = RefineMock::start();
    write_fixture(&agent_dir, &session_dir, &mock.url());
    let socket = dir.path().join("daemon.sock");
    let stderr_path = dir.path().join("daemon.stderr");
    let _supervisor = spawn_supervisor(&socket, &agent_dir, &stderr_path);
    let mut client = TimedClient::connect(&socket);
    let (session_id, _durable) = create_and_attach(&mut client, &session_dir);
    prompt_and_wait(&mut client, "p0", &session_id, "seed turn");

    mock.hold_plans();
    let response = refine(&mut client, "r1", &session_id);
    assert_eq!(response["success"], true, "refine failed: {response}");
    let child_id = response["data"]["rlmChildId"]
        .as_str()
        .expect("child id")
        .to_string();
    mock.wait_for_held_plan();
    // The cancel's answer waits for the child's teardown, which the held
    // planning call blocks: it is not read here.
    client.send_command(
        "x1",
        &json!({
            "type": "cancel_rlm_child",
            "activeSessionId": session_id,
            "childId": child_id,
        }),
    );
    let failed = wait_for_event(
        &mut client,
        Duration::from_secs(30),
        "refine_failed",
        &stderr_path,
    );
    let error = failed["error"].as_str().unwrap_or_default();
    assert!(
        error.contains("Cancelled by user"),
        "the failure names the child's end: {error}"
    );
    // The planning call may finish and the child may still send its
    // reply; the one-shot record retires either way.
    mock.release_plans();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let rows = rlm_children_rows(&mut client, "g1", &session_id);
        if rows.is_empty() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the ended refinement child never retired; rows: {rows:?}"
        );
        std::thread::sleep(Duration::from_millis(200));
    }

    // The flight is released: the next refinement spawns, plans and
    // commits.
    mock.release_plans();
    let response = refine(&mut client, "r2", &session_id);
    assert_eq!(response["success"], true, "refine failed: {response}");
    let complete = wait_for_event(
        &mut client,
        Duration::from_secs(30),
        "refine_complete",
        &stderr_path,
    );
    assert_eq!(complete["result"]["appliedEdits"][0]["applied"], true);
    assert_eq!(
        client
            .events
            .iter()
            .filter(|(event, _)| event["type"] == "refine_failed")
            .count(),
        1,
        "exactly one refine_failed"
    );

    // No generic child notice, no late reply and no follow-up turn reached
    // the parent: its durable file holds only the seed turn's assistant
    // reply.
    let session_file = std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .filter_map(std::result::Result::ok)
        .find(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .expect("the parent's session file")
        .path();
    let rows: Vec<Value> = std::fs::read_to_string(&session_file)
        .expect("read session file")
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let child_notices: Vec<&Value> = rows
        .iter()
        .filter(|row| {
            [
                pa_core::session_engine::rlm_notices::RLM_CHILD_FAILURE_CUSTOM_TYPE,
                pa_core::session_engine::rlm_notices::RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
                pa_core::session_engine::agent_messaging::AGENT_MESSAGE_CUSTOM_TYPE,
            ]
            .iter()
            .any(|kind| row["customType"] == json!(kind))
        })
        .collect();
    assert!(
        child_notices.is_empty(),
        "a child notice or a late reply reached the parent: {child_notices:?}"
    );
    let assistant_rows = rows
        .iter()
        .filter(|row| row["type"] == "message" && row["message"]["role"] == "assistant")
        .count();
    assert_eq!(assistant_rows, 1, "no extra parent turn ran: {rows:?}");
}
