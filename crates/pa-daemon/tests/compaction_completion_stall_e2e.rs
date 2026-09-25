//! The compaction completion contract (the compaction-completion-stall fix):
//! the settled compaction's completion event and the next prompt's
//! admission never wait on the compact-trigger auto-refine review's model
//! call (TS `_scheduleAutoRefineAfterCompaction` runs it as a background
//! `setTimeout(0)` round, never between the compaction and the settled
//! turn).
//!
//! Three regressions over a seeded mega session (~12MB):
//! * an approving review that lands while the next turn is streaming
//!   defers its refinement to the next settle (TS
//!   `_pendingAutoRefineReview`): no refinement rows surface mid-stream,
//!   the streaming turn settles untouched, and the retained review runs
//!   its refinement without a new review model call;
//! * a mocked-slow review (6s reply) cannot hold the crossing turn's
//!   settle — the `prompt_and_wait` response lands while the review is
//!   still in flight, a prompt admitted mid-review runs against the
//!   COMPACTED context (the summary rides the request, the compacted-away
//!   bulk does not), and the trace proves the completion event fired
//!   within a bounded window of the durable summary persist, before the
//!   review started;
//! * the operator's ctrl+c datapoint: an `abort_compaction` against the
//!   in-flight threshold run (the loader) settles to the aborted
//!   `compaction_end` with a consistent session (no compaction entry, the
//!   parent chain intact), and the next prompt runs against the
//!   un-compacted context.
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// One fattening assistant reply (the seeded session bulk).
const FATTENING_TURNS: usize = 3;
const FATTEN_REPLY_CHARS: usize = 4 * 1024 * 1024;

/// The mocked-slow review's reply delay: far past the settled turn's
/// completion (the settle must never wait for it).
const REVIEW_DELAY_MS: u64 = 6_000;

/// The mocked-slow summarizer's reply delay (the interrupted-compaction
/// window the ctrl+c lands in).
const SUMMARIZER_DELAY_MS: u64 = 6_000;

/// The bounded window between the durable summary persist and the
/// completion event (the trace's `emit.compaction_persist` ->
/// `auto.end_emitted`): sub-second is the measured contract on the mega
/// session; the bound leaves headroom for a loaded gate VM.
const COMPLETION_BOUND_MS: u64 = 2_000;

/// A declining review reply (the TS `AutoRefineReview` JSON shape).
const REVIEW_DECLINE: &str = r#"{"shouldRefine": false, "rationale": "one-off tool output"}"#;

/// The deferral test's failure diagnostics: the mock's request
/// classifications and the daemon trace's auto-refine phases, so a
/// timeout names the phase the round actually reached.
fn deferral_diagnostics(mock: &StallMock, trace_path: &Path) -> String {
    let requests = mock.requests.lock().expect("mock lock").clone();
    let mut parts: Vec<String> = vec![format!(
        "review_requests={}",
        requests
            .iter()
            .filter(|body| is_review_request(body))
            .count()
    )];
    parts.push(format!(
        "plan_requests={}",
        requests
            .iter()
            .filter(|body| is_refine_plan_request(body))
            .count()
    ));
    parts.push(format!(
        "summarizer_requests={}",
        requests
            .iter()
            .filter(|body| is_summarizer_request(body))
            .count()
    ));
    parts.push(format!("turn_requests={}", mock.turn_request_count()));
    let phases: Vec<String> = read_trace(trace_path)
        .into_iter()
        .filter(|(phase, _)| phase.starts_with("autorefine.") || phase.starts_with("compact."))
        .map(|(phase, at)| format!("{phase}@{at}us"))
        .collect();
    parts.push(format!("trace=[{}]", phases.join(", ")));
    let stderr = std::fs::read_to_string(daemon_stderr_path(trace_path)).unwrap_or_default();
    let tail: Vec<&str> = stderr
        .lines()
        .rev()
        .take(12)
        .collect::<Vec<&str>>()
        .into_iter()
        .rev()
        .collect();
    parts.push(format!("daemon_stderr=[{}]", tail.join(" | ")));
    parts.join(" ")
}

/// An approving review reply (the TS `AutoRefineReview` JSON shape).
const REVIEW_APPROVE: &str =
    r#"{"shouldRefine": true, "rationale": "the fattening markers recur"}"#;

/// The refinement plan the mock answers the retained review's planner
/// call with: an empty edits array, the shape `plan_refinement` parses.
const REFINE_EMPTY_PLAN: &str = r#"{"edits": [], "rationale": "no durable evidence"}"#;

/// The fixed compaction summary the mock answers the summarizer with
/// (the marker the compacted context must carry on the next request).
const CHECKPOINT_SUMMARY: &str = "the checkpoint summary";

struct Supervisor {
    child: Child,
    // Spawn bookkeeping only: the daemon binds the socket path; the test
    // drives the daemon through the client port, never this field.
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// An OpenAI-compatible SSE mock with per-request-type behavior: normal
/// turns answer the scripted reply (the fattening turns grow the
/// session; the crossing turn reports the over-threshold usage), the
/// compaction summarizer answers the fixed summary (optionally delayed —
/// the in-flight compaction the ctrl+c interrupts), and the auto-refine
/// review's reply is delayed past the whole settle (the heavyweight
/// phase the completion path must never wait on).
struct StallMock {
    requests: Arc<Mutex<Vec<Value>>>,
    turn_requests: Arc<Mutex<Vec<Instant>>>,
    turn_bodies: Arc<Mutex<Vec<Value>>>,
    review_request_at: Arc<Mutex<Option<Instant>>>,
    review_replied_at: Arc<Mutex<Option<Instant>>>,
    summarizer_delay_ms: Arc<AtomicU64>,
    review_delay_ms: Arc<AtomicU64>,
    approve_review: Arc<AtomicBool>,
    turn_delay_ms: Arc<AtomicU64>,
    port: u16,
}

impl StallMock {
    fn start() -> StallMock {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let turn_requests = Arc::new(Mutex::new(Vec::new()));
        let turn_bodies = Arc::new(Mutex::new(Vec::new()));
        let review_request_at = Arc::new(Mutex::new(None));
        let review_replied_at = Arc::new(Mutex::new(None));
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().expect("mock addr").port();
        let requests_for_thread = Arc::clone(&requests);
        let turn_requests_for_thread = Arc::clone(&turn_requests);
        let turn_bodies_for_thread = Arc::clone(&turn_bodies);
        let review_request_for_thread = Arc::clone(&review_request_at);
        let review_replied_for_thread = Arc::clone(&review_replied_at);
        let summarizer_delay = Arc::new(AtomicU64::new(0));
        let review_delay = Arc::new(AtomicU64::new(REVIEW_DELAY_MS));
        let approve_review = Arc::new(AtomicBool::new(false));
        let turn_delay = Arc::new(AtomicU64::new(0));
        let summarizer_delay_thread = Arc::clone(&summarizer_delay);
        let review_delay_thread = Arc::clone(&review_delay);
        let approve_review_thread = Arc::clone(&approve_review);
        let turn_delay_thread = Arc::clone(&turn_delay);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let requests = Arc::clone(&requests_for_thread);
                let turn_requests = Arc::clone(&turn_requests_for_thread);
                let turn_bodies = Arc::clone(&turn_bodies_for_thread);
                let review_request = Arc::clone(&review_request_for_thread);
                let review_replied = Arc::clone(&review_replied_for_thread);
                let summarizer_delay = Arc::clone(&summarizer_delay_thread);
                let review_delay = Arc::clone(&review_delay_thread);
                let approve_review = Arc::clone(&approve_review_thread);
                let turn_delay = Arc::clone(&turn_delay_thread);
                std::thread::spawn(move || {
                    let _ = serve(
                        stream,
                        requests,
                        turn_requests,
                        turn_bodies,
                        review_request,
                        review_replied,
                        summarizer_delay,
                        review_delay,
                        approve_review,
                        turn_delay,
                    );
                });
            }
        });
        StallMock {
            requests,
            turn_requests,
            turn_bodies,
            review_request_at,
            review_replied_at,
            summarizer_delay_ms: summarizer_delay,
            review_delay_ms: review_delay,
            approve_review,
            turn_delay_ms: turn_delay,
            port,
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    fn turn_request_count(&self) -> usize {
        self.turn_requests.lock().expect("turn lock").len()
    }
}

fn chunk(delta: Value, finish_reason: Option<&str>, usage: Value) -> String {
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

fn crossing_usage() -> Value {
    json!({
        "prompt_tokens": 126_000, "completion_tokens": 10, "total_tokens": 126_010,
        "prompt_tokens_details": {"cached_tokens": 80},
    })
}

fn is_status_line_request(body: &Value) -> bool {
    body["messages"].as_array().is_some_and(|messages| {
        messages.iter().any(|message| {
            message["role"] == "system"
                && message["content"]
                    .as_str()
                    .is_some_and(|text| text.starts_with("You generate a status line"))
        })
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

fn is_summarizer_request(body: &Value) -> bool {
    body["messages"].as_array().is_some_and(|messages| {
        messages
            .iter()
            .any(|message| message_text(message).contains("context summarization assistant"))
    })
}

fn is_review_request(body: &Value) -> bool {
    body["messages"].as_array().is_some_and(|messages| {
        messages
            .iter()
            .any(|message| message_text(message).contains("automatic /refine review gate"))
    })
}

fn is_refine_plan_request(body: &Value) -> bool {
    body["messages"].as_array().is_some_and(|messages| {
        messages
            .iter()
            .any(|message| message_text(message).contains("<user_refine_instructions>"))
    })
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
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or_default();
        }
    }
    let mut body_bytes = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body_bytes)?;
    }
    serde_json::from_slice(&body_bytes).map_err(|_| std::io::Error::other("bad body"))
}

fn write_sse(stream: &mut TcpStream, reply: String, usage: Value) -> std::io::Result<()> {
    let mut payload = String::new();
    for data in [
        chunk(
            json!({"role": "assistant", "content": reply}),
            None,
            small_usage(),
        ),
        chunk(json!({}), Some("stop"), usage.clone()),
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

// One Arc per captured concern keeps the mock's request handlers
// independent (requests, turn timing/bodies, review timing, delays);
// a parameter struct would only shuttle the same Arcs around.
#[allow(clippy::too_many_arguments)]
fn serve(
    mut stream: TcpStream,
    requests: Arc<Mutex<Vec<Value>>>,
    turn_requests: Arc<Mutex<Vec<Instant>>>,
    turn_bodies: Arc<Mutex<Vec<Value>>>,
    review_request_at: Arc<Mutex<Option<Instant>>>,
    review_replied_at: Arc<Mutex<Option<Instant>>>,
    summarizer_delay_ms: Arc<AtomicU64>,
    review_delay_ms: Arc<AtomicU64>,
    approve_review: Arc<AtomicBool>,
    turn_delay_ms: Arc<AtomicU64>,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let body = read_body(&mut reader)?;
    requests.lock().expect("mock lock").push(body.clone());
    if is_review_request(&body) {
        *review_request_at.lock().expect("review lock") = Some(Instant::now());
        let delay = review_delay_ms.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(delay));
        *review_replied_at.lock().expect("review lock") = Some(Instant::now());
        let reply = if approve_review.load(Ordering::SeqCst) {
            REVIEW_APPROVE
        } else {
            REVIEW_DECLINE
        };
        return write_sse(&mut stream, reply.to_string(), small_usage());
    }
    if is_refine_plan_request(&body) {
        return write_sse(&mut stream, REFINE_EMPTY_PLAN.to_string(), small_usage());
    }
    if is_summarizer_request(&body) {
        let delay = summarizer_delay_ms.load(Ordering::SeqCst);
        if delay > 0 {
            std::thread::sleep(Duration::from_millis(delay));
        }
        return write_sse(&mut stream, CHECKPOINT_SUMMARY.to_string(), small_usage());
    }
    if is_status_line_request(&body) {
        return write_sse(&mut stream, "idle".to_string(), small_usage());
    }
    let turn_delay = turn_delay_ms.load(Ordering::SeqCst);
    if turn_delay > 0 {
        std::thread::sleep(Duration::from_millis(turn_delay));
    }
    let index = {
        let mut turns = turn_requests.lock().expect("turn lock");
        turns.push(Instant::now());
        turn_bodies.lock().expect("turn lock").push(body);
        turns.len() - 1
    };
    let crossing_index = FATTENING_TURNS + 1;
    let (reply, usage) = match index {
        0 => ("seed reply".to_string(), small_usage()),
        // Each fattening reply carries its own marker: the compaction's
        // cut keeps whole messages (the last fattening reply rides the
        // kept tail; the earlier ones are the compacted-away bulk the
        // context assertions read).
        index if (1..=FATTENING_TURNS).contains(&index) => (
            format!("fatten-{}-{}", index - 1, "a".repeat(FATTEN_REPLY_CHARS)),
            small_usage(),
        ),
        index if index == crossing_index => ("crossing reply".to_string(), crossing_usage()),
        _ => ("post-review reply".to_string(), small_usage()),
    };
    write_sse(&mut stream, reply, usage)
}

/// The daemon child's stderr lands beside the trace (its `eprintln`
/// diagnostics — a failed background round names its error) so the
/// deferral test can surface them.
fn daemon_stderr_path(trace_path: &Path) -> std::path::PathBuf {
    trace_path.with_file_name("daemon-stderr.log")
}

// The child is reaped in Supervisor::drop (kill + wait); clippy's
// zombie_processes cannot see the Drop guard from the spawn site.
#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path, trace_path: &Path) -> Supervisor {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let stderr_path = daemon_stderr_path(trace_path);
    let stderr_file = std::fs::File::create(&stderr_path).expect("daemon stderr file");
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
        .env("PA_COMPACTION_TRACE", trace_path)
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

    fn send_command(&mut self, id: &str, command: Value) {
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

    /// Park session events for `quiet_ms` more.
    fn drain_events(&mut self, quiet_ms: u64) {
        let deadline = Instant::now() + Duration::from_millis(quiet_ms);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(50)))
            .expect("timeout");
        loop {
            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Ok(0) => return,
                Ok(_) if line.trim().is_empty() => {}
                Ok(_) => {
                    if let Ok(event) = serde_json::from_str::<Value>(line.trim()) {
                        if event.get("type").and_then(Value::as_str) == Some("session_event") {
                            self.events.push((event["event"].clone(), Instant::now()));
                        }
                    }
                }
                Err(_) => {}
            }
            if Instant::now() >= deadline {
                return;
            }
        }
    }
}

fn read_trace(path: &Path) -> Vec<(String, u128)> {
    let content = std::fs::read_to_string(path).unwrap_or_default();
    content
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("compaction-trace: ")?;
            let value: Value = serde_json::from_str(rest).ok()?;
            let phase = value.get("phase")?.as_str()?.to_string();
            let elapsed = value.get("elapsedMicros")?.as_u64()? as u128;
            Some((phase, elapsed))
        })
        .collect()
}

/// One entry id -> parent id map of the session file; panics on an
/// unparsable line (the consistency contract).
fn session_chain(session_dir: &Path) -> (bool, Vec<(String, String)>) {
    let session_file = session_dir
        .read_dir()
        .expect("session dir read")
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .expect("session file");
    let content = std::fs::read_to_string(&session_file).expect("session file read");
    let mut has_compaction = false;
    let mut ids = std::collections::HashSet::new();
    let mut chain = Vec::new();
    for line in content.lines() {
        let entry: Value = serde_json::from_str(line)
            .unwrap_or_else(|error| panic!("unparsable session line ({error}): {line}"));
        if entry["type"] == "compaction" {
            has_compaction = true;
        }
        if let Some(id) = entry["id"].as_str() {
            ids.insert(id.to_string());
            let parent = entry["parentId"].as_str().unwrap_or_default().to_string();
            chain.push((id.to_string(), parent));
        }
    }
    for (id, parent) in &chain {
        assert!(
            parent.is_empty() || ids.contains(parent),
            "entry {id} references a missing parent {parent}"
        );
    }
    (has_compaction, chain)
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
        json!({ "compaction": {"enabled": true, "reserveTokens": 500, "keepRecentTokens": 10} })
            .to_string(),
    )
    .expect("write settings.json");
}

fn create_and_attach(client: &mut TimedClient, session_dir: &Path) -> String {
    client.send_command(
        "c1",
        json!({
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
        json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    session_id
}

fn prompt_and_wait(client: &mut TimedClient, id: &str, session_id: &str, message: &str) -> Value {
    client.send_command(
        id,
        json!({"type": "prompt_and_wait", "activeSessionId": session_id, "message": message}),
    );
    let response = client.read_response(id);
    assert_eq!(response["success"], true, "prompt {id} failed: {response}");
    response
}

/// The seeded mega session (~12MB): the seed turn plus the fattening
/// turns, then the crossing turn whose reported usage fires the
/// threshold arm.
fn seed_mega_session(client: &mut TimedClient, session_id: &str, mock: &StallMock) {
    prompt_and_wait(client, "p0", session_id, "seed turn");
    for turn in 0..FATTENING_TURNS {
        prompt_and_wait(
            client,
            &format!("f{turn}"),
            session_id,
            &format!("fattening turn {turn}"),
        );
    }
    // Every fattening turn's request reached the mock before the crossing
    // turn admits (the seeded bulk is on the wire).
    let expected_turns = 1 + FATTENING_TURNS;
    assert!(
        mock.turn_request_count() >= expected_turns,
        "the seeding turns never all ran: {}",
        mock.turn_request_count()
    );
}

/// A mocked-slow review never holds the settled compaction: the crossing
/// turn's `prompt_and_wait` resolves while the review is still in
/// flight, the completion event fired within the bounded window of the
/// durable summary persist (trace), a prompt admitted mid-review runs
/// against the compacted context, and the session file stays consistent.
#[test]
#[ignore = "seeds ~12MB; asserts the compaction completion contract"]
fn mocked_slow_review_never_holds_the_settled_compaction() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    let mock = StallMock::start();
    write_fixture(&agent_dir, &session_dir, &mock.url());
    let trace_path = dir.path().join("compaction-trace.jsonl");
    let socket = dir.path().join("daemon.sock");
    let _supervisor = spawn_supervisor(&socket, &agent_dir, &trace_path);
    let mut client = TimedClient::connect(&socket);
    let session_id = create_and_attach(&mut client, &session_dir);
    seed_mega_session(&mut client, &session_id, &mock);

    let settle_started = Instant::now();
    prompt_and_wait(&mut client, "px", &session_id, "crossing turn");
    let settle_at = Instant::now();
    let settle_duration = settle_at.duration_since(settle_started);

    // The review was armed and its (delayed) reply had NOT landed when
    // the settle resolved: the completion path never waited on it.
    assert!(
        mock.review_request_at
            .lock()
            .expect("review lock")
            .is_none()
            || mock
                .review_replied_at
                .lock()
                .expect("review lock")
                .is_none(),
        "the settle waited out the mocked-slow review"
    );
    assert!(
        settle_duration < Duration::from_millis(REVIEW_DELAY_MS),
        "the settle took {settle_duration:?} — it must not wait for the review"
    );

    // A prompt admitted while the review is still in flight runs against
    // the COMPACTED context: the summary rides the request, the
    // compacted-away bulk does not. The assertion targets the last TURN
    // request — the background review and the status-line recap make
    // their own provider calls around the settle (the review deliberately
    // reads the full trajectory), so `requests.last()` is not the turn.
    prompt_and_wait(
        &mut client,
        "pn",
        &session_id,
        "next turn while the review runs",
    );
    let last_turn_request = mock
        .turn_bodies
        .lock()
        .expect("turn lock")
        .last()
        .cloned()
        .unwrap_or(Value::Null);
    let request_text = serde_json::to_string(&last_turn_request).unwrap_or_default();
    assert!(
        request_text.contains(CHECKPOINT_SUMMARY),
        "the compacted context did not carry the summary: {}",
        request_text.chars().take(2_000).collect::<String>()
    );
    // The compacted-away bulk is gone: the earlier fattening replies
    // never ride the request (the cut's kept tail keeps whole messages,
    // so the LAST fattening reply may legitimately remain).
    for dropped in 0..FATTENING_TURNS.saturating_sub(1) {
        assert!(
            !request_text.contains(&format!("fatten-{dropped}-")),
            "the compacted-away fattening reply {dropped} still rode the turn request"
        );
    }

    // The review's delayed reply lands in the background (bounded wait).
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if mock
            .review_replied_at
            .lock()
            .expect("review lock")
            .is_some()
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let review_replied_at = mock
        .review_replied_at
        .lock()
        .expect("review lock")
        .expect("the mocked-slow review reply never landed");
    assert!(
        settle_at < review_replied_at,
        "the settle resolved before the review's reply ({settle_at:?} < {review_replied_at:?})"
    );

    // The trace: the completion event fired within the bounded window of
    // the durable summary persist, and the review started after it.
    let trace = read_trace(&trace_path);
    let persist = trace
        .iter()
        .position(|(phase, _)| phase == "emit.compaction_persist")
        .expect("the durable compaction persist traced");
    let (_, persist_elapsed) = trace[persist];
    let end_emitted = trace
        .iter()
        .find(|(phase, _)| phase == "auto.end_emitted")
        .expect("the completion event traced");
    assert!(
        end_emitted.1.saturating_sub(persist_elapsed) < u128::from(COMPLETION_BOUND_MS) * 1_000,
        "the completion event took {}us after the durable persist (bound {}ms)",
        end_emitted.1.saturating_sub(persist_elapsed),
        COMPLETION_BOUND_MS
    );
    // The armed round starts AFTER the completion event: the trace line
    // fires for every settle's round (the no-op rounds when no trigger is
    // armed trace too), so the invariant is that a review round started
    // past this compaction's completion — never before it.
    assert!(
        trace.iter().any(|(phase, elapsed)| {
            phase == "autorefine.review_started" && *elapsed > end_emitted.1
        }),
        "no review round started after the completion event"
    );

    // The declined review surfaces nothing, and the session file stays
    // consistent with the compacted history.
    client.drain_events(500);
    assert!(
        !client.events.iter().any(|(event, _)| {
            event["type"] == "message_end" && event["message"]["customType"] == "refinement_outcome"
        }),
        "a declined review surfaced rows"
    );
    let (has_compaction, _) = session_chain(&session_dir);
    assert!(has_compaction, "the compaction entry persisted");
}

/// The operator's ctrl+c datapoint: an `abort_compaction` against the
/// in-flight threshold run (the loader) settles to the aborted
/// `compaction_end` with a consistent session (no compaction entry, the
/// parent chain intact), and the next prompt runs against the
/// un-compacted context — the interruptible/idempotent contract the
/// post-summary bookkeeping must keep.
#[test]
#[ignore = "seeds ~12MB; asserts the interrupted-compaction contract"]
fn interrupted_threshold_compaction_settles_consistent() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    let mock = StallMock::start();
    write_fixture(&agent_dir, &session_dir, &mock.url());
    // The summarizer's reply is held in flight: the ctrl+c lands in the
    // compaction's loader window.
    mock.summarizer_delay_ms
        .store(SUMMARIZER_DELAY_MS, Ordering::SeqCst);
    let trace_path = dir.path().join("compaction-trace.jsonl");
    let socket = dir.path().join("daemon.sock");
    let _supervisor = spawn_supervisor(&socket, &agent_dir, &trace_path);
    let mut client = TimedClient::connect(&socket);
    let session_id = create_and_attach(&mut client, &session_dir);
    seed_mega_session(&mut client, &session_id, &mock);

    // The crossing turn: the threshold arm's summarizer is held.
    client.send_command(
        "px",
        json!({"type": "prompt_and_wait", "activeSessionId": session_id, "message": "crossing turn"}),
    );

    // The compaction_start broadcast arrives (the loader), then the
    // ctrl+c (`abort_compaction` on the wire) from a second client.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if client
            .events
            .iter()
            .any(|(event, _)| event["type"] == "compaction_start")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the threshold compaction_start never broadcast"
        );
        let line = client.read_line();
        if line.get("type").and_then(Value::as_str) == Some("session_event") {
            client.events.push((line["event"].clone(), Instant::now()));
        }
    }
    let mut second = TimedClient::connect(&socket);
    second.send_command(
        "a2",
        json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = second.read_response("a2");
    assert_eq!(attached["success"], true, "second attach: {attached}");
    second.send_command(
        "ab1",
        json!({ "type": "abort_compaction", "activeSessionId": session_id }),
    );
    let aborted = second.read_response("ab1");
    assert_eq!(aborted["success"], true, "abort failed: {aborted}");
    let abort_ack = Instant::now();

    // The interrupted run settles fast (the abort never waits out the
    // held summarizer).
    let crossed = client.read_response("px");
    let settled_at = Instant::now();
    assert_eq!(
        crossed["success"], true,
        "crossing prompt failed: {crossed}"
    );
    assert!(
        settled_at - abort_ack < Duration::from_millis(SUMMARIZER_DELAY_MS),
        "the interrupted compaction took {:?} to settle after the abort ack",
        settled_at - abort_ack
    );
    client.drain_events(500);

    // The aborted end event and the durable cancelled row broadcast.
    assert!(
        client.events.iter().any(|(event, _)| {
            event["type"] == "compaction_end"
                && event["reason"] == "threshold"
                && event["aborted"] == json!(true)
        }),
        "the aborted compaction_end never broadcast; events: {:?}",
        client
            .events
            .iter()
            .map(|(event, _)| event["type"].clone())
            .collect::<Vec<_>>()
    );
    assert!(
        client.events.iter().any(|(event, _)| {
            event["type"] == "message_start"
                && event["message"]["customType"] == "compaction_outcome"
                && event["message"]["details"]["outcome"] == "cancelled"
        }),
        "the cancelled outcome row never broadcast"
    );

    // No compaction entry landed (the abort pre-dated the commit) and
    // the session file stays consistent.
    let (has_compaction, _) = session_chain(&session_dir);
    assert!(!has_compaction, "an aborted compaction committed an entry");

    // The next prompt runs against the un-compacted context (the seeded
    // bulk still rides the TURN request — nothing was lost to the
    // interrupt).
    prompt_and_wait(
        &mut client,
        "pn",
        &session_id,
        "next turn after the interrupt",
    );
    let last_turn_request = mock
        .turn_bodies
        .lock()
        .expect("turn lock")
        .last()
        .cloned()
        .unwrap_or(Value::Null);
    let request_text = serde_json::to_string(&last_turn_request).unwrap_or_default();
    // The interrupted run left the session usable: the next prompt's turn
    // served against a consistent context — either the un-compacted bulk
    // (no further compaction) or the summary of a LEGITIMATE post-abort
    // compaction at the prompt's own pre-turn boundary (the crossing
    // turn's usage is still the context estimate anchor, so the threshold
    // arm may fire again on the newly admitted prompt). Both are the
    // product's behavior; neither loses work to the interrupt.
    let un_compacted =
        (0..FATTENING_TURNS).all(|kept| request_text.contains(&format!("fatten-{kept}-")));
    let legitimately_compacted = request_text.contains(CHECKPOINT_SUMMARY);
    assert!(
        un_compacted || legitimately_compacted,
        "the post-interrupt context neither kept the seeded bulk nor carried a \
         legitimate compaction summary: {}",
        request_text.chars().take(2_000).collect::<String>()
    );
}

/// An approving review that lands while the next turn is streaming never
/// runs its refinement mid-stream: the round defers (TS
/// `_pendingAutoRefineReview` retained behind
/// `_shouldSkipAutoRefineForActiveAgent`), the streaming turn settles
/// untouched, and the retained review runs its refinement at the next
/// serviced boundary without a new review model call.
#[test]
#[ignore = "seeds ~12MB; asserts the deferred-refinement contract"]
fn approving_review_while_a_turn_streams_defers_its_refinement() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    let mock = StallMock::start();
    write_fixture(&agent_dir, &session_dir, &mock.url());
    let trace_path = dir.path().join("compaction-trace.jsonl");
    let socket = dir.path().join("daemon.sock");
    let _supervisor = spawn_supervisor(&socket, &agent_dir, &trace_path);
    let mut client = TimedClient::connect(&socket);
    let session_id = create_and_attach(&mut client, &session_dir);
    seed_mega_session(&mut client, &session_id, &mock);

    // The review approves, and both the review's reply (3s) and the next
    // turn's provider reply (7s) are mocked slow: the approval lands
    // while the turn is still streaming.
    mock.review_delay_ms.store(3_000, Ordering::SeqCst);
    mock.approve_review.store(true, Ordering::SeqCst);
    mock.turn_delay_ms.store(7_000, Ordering::SeqCst);

    prompt_and_wait(&mut client, "px", &session_id, "crossing turn");

    // The next turn is admitted while the round's review is in flight;
    // its response arrives when the turn settles (the 7s provider
    // reply).
    client.send_command(
        "pn",
        json!({
            "type": "prompt_and_wait",
            "activeSessionId": session_id,
            "message": "next turn over the in-flight review",
        }),
    );

    // The approval lands mid-stream (bounded wait on the mock's reply
    // stamp).
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline
        && mock
            .review_replied_at
            .lock()
            .expect("review lock")
            .is_none()
    {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        mock.review_replied_at
            .lock()
            .expect("review lock")
            .is_some(),
        "the approval never landed"
    );

    // The deferred round surfaced no refinement rows while the turn was
    // streaming.
    client.drain_events(300);
    assert!(
        !client.events.iter().any(|(event, _)| {
            event["type"] == "message_end" && event["message"]["customType"] == "refinement_outcome"
        }),
        "the deferred refinement surfaced rows while the turn streamed"
    );

    // The streaming turn settles normally; its settle services the
    // retained review.
    let settled = client.read_response("pn");
    assert_eq!(
        settled["success"], true,
        "the streaming turn failed: {settled}"
    );
    let turn_settled_at = Instant::now();

    // The retained review's refinement outcome row arrives (bounded
    // wait) AFTER the streaming turn settled — never mid-stream.
    let mut outcome_at = None;
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        client.drain_events(300);
        outcome_at = client
            .events
            .iter()
            .find(|(event, _)| {
                event["type"] == "message_end"
                    && event["message"]["customType"] == "refinement_outcome"
            })
            .map(|(_, at)| *at);
        if outcome_at.is_some() {
            break;
        }
    }
    let outcome_at = outcome_at.unwrap_or_else(|| {
        panic!(
            "the retained review never ran its refinement: {}",
            deferral_diagnostics(&mock, &trace_path)
        )
    });
    assert!(
        outcome_at >= turn_settled_at,
        "the refinement ran before the streaming turn settled ({outcome_at:?} < {turn_settled_at:?})"
    );

    // The retained round ran its refinement without a new review model
    // call: exactly one review request and one refinement plan request
    // ever reached the mock.
    let requests = mock.requests.lock().expect("mock lock").clone();
    let review_count = requests
        .iter()
        .filter(|body| is_review_request(body))
        .count();
    assert_eq!(
        review_count, 1,
        "the retained review re-ran a review model call"
    );
    let plan_count = requests
        .iter()
        .filter(|body| is_refine_plan_request(body))
        .count();
    assert_eq!(
        plan_count, 1,
        "the retained review never ran its refinement plan call"
    );

    let (has_compaction, _) = session_chain(&session_dir);
    assert!(has_compaction, "the compaction entry persisted");
}
