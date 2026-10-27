//! The refinement-child e2e (`rlm.spawn kind="refine"`): the fire-and-wake
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
use std::sync::{Arc, Mutex};
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
}

/// An OpenAI-compatible SSE mock: the refinement child's planning request
/// (the one carrying the refinement prompt's harness overview) is answered
/// per [`PlanMode`] after [`PLAN_DELAY_MS`]; every other request gets the
/// fixed turn reply.
struct RefineMock {
    requests: Arc<Mutex<Vec<Value>>>,
    plan_mode: Arc<Mutex<PlanMode>>,
    port: u16,
}

impl RefineMock {
    fn start() -> RefineMock {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let plan_mode = Arc::new(Mutex::new(PlanMode::Proposal));
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().expect("mock addr").port();
        let requests_for_thread = Arc::clone(&requests);
        let mode_for_thread = Arc::clone(&plan_mode);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let requests = Arc::clone(&requests_for_thread);
                let mode = Arc::clone(&mode_for_thread);
                std::thread::spawn(move || {
                    let _ = serve(stream, &requests, &mode);
                });
            }
        });
        RefineMock {
            requests,
            plan_mode,
            port,
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    fn set_plan_mode(&self, mode: PlanMode) {
        *self.plan_mode.lock().expect("mock lock") = mode;
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

fn write_sse(stream: &mut TcpStream, reply: &str, usage: &Value) -> std::io::Result<()> {
    let mut payload = String::new();
    for data in [
        chunk(
            &json!({"role": "assistant", "content": reply}),
            None,
            &small_usage(),
        ),
        chunk(&json!({}), Some("stop"), usage),
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
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let body = read_body(&mut reader)?;
    requests.lock().expect("mock lock").push(body.clone());
    if is_refinement_plan_request(&body) {
        std::thread::sleep(Duration::from_millis(PLAN_DELAY_MS));
        let reply = match *plan_mode.lock().expect("mock lock") {
            PlanMode::Proposal => PROPOSAL,
            PlanMode::Garbage => "not a plan",
        };
        return write_sse(&mut stream, reply, &small_usage());
    }
    write_sse(&mut stream, "a reply", &small_usage())
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

/// The local harness state the wake-side apply wrote (the session's own
/// store under its session dir).
fn local_harness_state(session_dir: &Path) -> Value {
    let path = session_dir.join("harness").join("harness_state.json");
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

    // The registry row carries the kind: the child's own ledger line
    // registers as a refinement child.
    let deadline = Instant::now() + Duration::from_secs(10);
    let registered = loop {
        let ledger = child_ledger(&agent_dir, &durable_session_id, &child_id);
        let registered = ledger
            .iter()
            .find(|event| event["type"] == "session_registered" && event["refine_child"] == true);
        if let Some(registered) = registered {
            break registered.clone();
        }
        assert!(
            Instant::now() < deadline,
            "the child never registered its refine kind; ledger: {ledger:?}"
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
