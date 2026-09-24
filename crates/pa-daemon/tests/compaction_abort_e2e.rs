//! End-to-end verifier for the compaction abort (TS `abortCompaction` ->
//! `_runAutoCompaction`'s `aborted` arm): a threshold compaction aborted
//! while its summarizer request is in flight records the durable
//! `cancelled` outcome row (the #207 seam's `cancelled` arm), broadcasts
//! its `message_start`/`message_end` pair before the aborted
//! `compaction_end` event, and never commits a compaction entry; the turn
//! still settles and the session keeps working.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The compaction summarizer request marker (the fixed summarization
/// system prompt rides the request's first message).
const SUMMARIZER_MARKER: &str = "context summarization assistant";

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

/// An OpenAI-compatible SSE mock whose summarizer response can be held in
/// flight (`hold_summarizer`): while set, any request carrying the
/// summarization prompt sleeps before its response, so the client-side
/// abort lands mid-compaction (the dropped request kills the connection;
/// the mock thread exits on its failed write). The per-request usage list
/// makes the second turn's usage cross the compaction threshold (the
/// f14-auto battery shape: 126010 tokens against a 500-token headroom).
struct CompactionMock {
    requests: Arc<Mutex<Vec<Value>>>,
    hold_summarizer: Arc<AtomicBool>,
    port: u16,
}

impl CompactionMock {
    fn start() -> CompactionMock {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let hold_summarizer = Arc::new(AtomicBool::new(false));
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().expect("mock addr").port();
        let requests_for_thread = Arc::clone(&requests);
        let hold_for_thread = Arc::clone(&hold_summarizer);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let requests = Arc::clone(&requests_for_thread);
                let hold = Arc::clone(&hold_for_thread);
                std::thread::spawn(move || {
                    let _ = serve(stream, requests, hold);
                });
            }
        });
        CompactionMock {
            requests,
            hold_summarizer,
            port,
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    fn request_count(&self) -> usize {
        self.requests.lock().expect("mock lock").len()
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

/// The crossing turn's reported usage (the f14-auto battery shape).
fn crossing_usage() -> Value {
    json!({
        "prompt_tokens": 126_000, "completion_tokens": 10, "total_tokens": 126_010,
        "prompt_tokens_details": {"cached_tokens": 80},
    })
}

/// The dashboard status-line recap (`status_line.rs`) rides the same
/// provider entry, so its request also lands on the mock. It summarizes
/// the session's user-visible rows -- the outcome disclosure included --
/// so the wire-purity scan over model-context requests must skip it.
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

fn is_summarizer_request(body: &Value) -> bool {
    body["messages"].as_array().is_some_and(|messages| {
        messages.iter().any(|message| {
            let content = &message["content"];
            let text = content
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
                .unwrap_or_default();
            text.contains(SUMMARIZER_MARKER)
        })
    })
}

fn serve(
    mut stream: TcpStream,
    requests: Arc<Mutex<Vec<Value>>>,
    hold_summarizer: Arc<AtomicBool>,
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
    let index = requests.lock().expect("mock lock").len();
    requests.lock().expect("mock lock").push(body.clone());
    if is_summarizer_request(&body) && hold_summarizer.load(Ordering::SeqCst) {
        // Held in flight: the abort drops the request from the client side
        // long before this sleep ends; the write then fails on the closed
        // connection and the thread exits.
        std::thread::sleep(Duration::from_secs(30));
    }
    // Turn 2 (the crossing turn) reports the over-threshold usage; every
    // other request reports the small usage so the session does not
    // re-cross.
    let usage = if index == 1 {
        crossing_usage()
    } else {
        small_usage()
    };
    let mut payload = String::new();
    for data in [
        chunk(
            json!({"role": "assistant", "content": "parity reply"}),
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
        // The session create launches a worker inside this same connect
        // budget; a battery-loaded box (the whole workspace running around
        // this test) can starve a fresh worker's boot past the 30s default,
        // so the e2e uses the load-aware override (under the create's own
        // link budget).
        .env("PA_DAEMON_WORKER_CONNECT_TIMEOUT_MS", "90000")
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(60);
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
        // Generous: a battery-loaded box can starve the supervisor
        // process far past an interactive box's latency.
        let deadline = Instant::now() + Duration::from_secs(90);
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

    /// Park broadcast events still in flight after a response (the turn's
    /// trailing frames can land right after the prompt completes).
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
                            self.events.push(event["event"].clone());
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

    /// Park broadcast events until one matches `probe` (early exit) or the
    /// budget runs out. On a battery-loaded box (the whole workspace
    /// running around this test) the supervisor's event forwarding can lag
    /// many seconds behind the run itself, so fixed short drains are
    /// flakes; the generous budget keeps the solo path fast.
    fn wait_for_event(
        &mut self,
        budget: Duration,
        context: &str,
        probe: impl Fn(&Value) -> bool,
    ) -> Value {
        let deadline = Instant::now() + budget;
        loop {
            self.drain_events(200);
            if let Some(event) = self.events.iter().find(|event| probe(event)) {
                return event.clone();
            }
            assert!(
                Instant::now() < deadline,
                "{context} never arrived; events: {:#?}",
                self.events
            );
        }
    }

    /// Read lines until the response for `id` arrives, parking broadcast
    /// events on the way.
    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_mins(3);
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
}

/// Abort the in-flight threshold compaction over the daemon wire: the
/// durable `cancelled` outcome row, its broadcast pair before the aborted
/// `compaction_end` event, no committed compaction entry, and the session
/// keeps working.
#[test]
fn abort_compaction_mid_threshold_run_records_the_cancelled_outcome() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let mock = CompactionMock::start();
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
                            "maxTokens": 4096,
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    // The f14-auto battery settings shape: a tiny reserve (the 4_096
    // estimate-error floor governs the headroom), so the combined
    // input+output ceiling sits at 119_808 on the 128k window — the
    // 126_010 crossing fires. A tiny keep-recent budget keeps the seeded
    // turns summarizable.
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({ "compaction": {"enabled": true, "reserveTokens": 500, "keepRecentTokens": 10} })
            .to_string(),
    )
    .expect("write settings.json");
    let socket = dir.path().join("daemon.sock");
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

    // Seed turn (small usage): the compaction threshold stays silent.
    client.send_command(
        "p1",
        json!({"type": "prompt_and_wait", "activeSessionId": session_id, "message": "seed turn"}),
    );
    let seeded = client.read_response("p1");
    assert_eq!(seeded["success"], true, "seed prompt failed: {seeded}");

    // The crossing turn reports 126010 tokens (over the 500-token
    // headroom): the post-turn threshold check fires a compaction whose
    // summarizer request the mock holds in flight.
    mock.hold_summarizer.store(true, Ordering::SeqCst);
    client.send_command(
        "p2",
        json!({"type": "prompt_and_wait", "activeSessionId": session_id, "message": "crossing turn"}),
    );
    let summarizer_index = 2; // turn 1, turn 2, then the compaction summarizer
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline && mock.request_count() <= summarizer_index {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        mock.request_count() > summarizer_index,
        "the compaction summarizer request never arrived"
    );

    // Abort the in-flight compaction from a second attached client (TS
    // `abortCompaction` on the wire; the TUI interrupt key sends the same
    // command while the compaction loader is up).
    let mut second = Client::connect(&socket);
    second.send_command(
        "a2",
        json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached2 = second.read_response("a2");
    assert_eq!(attached2["success"], true, "second attach: {attached2}");
    second.send_command(
        "ab1",
        json!({ "type": "abort_compaction", "activeSessionId": session_id }),
    );
    let aborted = second.read_response("ab1");
    assert_eq!(aborted["success"], true, "abort failed: {aborted}");
    assert_eq!(aborted["command"], "abort_compaction");

    // The turn completes after the cancelled compaction (TS: the aborted
    // arm records the outcome and returns without stalling the loop).
    let crossed = client.read_response("p2");
    assert_eq!(
        crossed["success"], true,
        "crossing prompt failed: {crossed}"
    );
    // The run's trailing frames can land well after the response on a
    // battery-loaded box (the supervisor's event forwarding competes with
    // the whole workspace run), so wait for the run's LAST expected event
    // instead of a fixed short drain — the aborted `compaction_end` lands
    // after the disclosure pair, and its arrival implies the whole
    // sequence.
    client.wait_for_event(
        Duration::from_secs(60),
        "the aborted threshold compaction_end",
        |event| {
            event["type"] == "compaction_end"
                && event["reason"] == "threshold"
                && event["aborted"] == true
        },
    );

    // The start event went out before the summarizer ran (the loader).
    assert!(
        client
            .events
            .iter()
            .any(|event| { event["type"] == "compaction_start" && event["reason"] == "threshold" }),
        "the threshold compaction_start broadcast"
    );

    // The durable cancelled row's broadcast pair, then the aborted
    // `compaction_end` (TS `_endCompactionUnsuccessfully` order).
    let row_start = client
        .events
        .iter()
        .position(|event| {
            event["type"] == "message_start"
                && event["message"]["customType"] == "compaction_outcome"
                && event["message"]["details"]["outcome"] == "cancelled"
        })
        .unwrap_or_else(|| {
            panic!(
                "the cancelled row's message_start broadcast; events: {:#?}",
                client.events
            )
        });
    let row_end = client
        .events
        .iter()
        .position(|event| {
            event["type"] == "message_end"
                && event["message"]["customType"] == "compaction_outcome"
                && event["message"]["details"]["outcome"] == "cancelled"
        })
        .expect("the cancelled row's message_end broadcast");
    assert!(row_end > row_start, "the row's pair stays in order");
    let row = client.events[row_start]["message"].clone();
    assert_eq!(row["role"], "custom");
    assert_eq!(row["content"], "Compaction cancelled");
    assert_eq!(
        row["details"],
        json!({"reason": "threshold", "outcome": "cancelled"})
    );
    assert_eq!(row["display"], true);
    let compaction_end_index = client
        .events
        .iter()
        .position(|event| {
            event["type"] == "compaction_end"
                && event["reason"] == "threshold"
                && event["aborted"] == true
        })
        .expect("the aborted compaction_end broadcast");
    assert!(
        compaction_end_index > row_end,
        "the end event follows the disclosure pair"
    );
    let end_event = client.events[compaction_end_index].clone();
    // Aborts carry no error message or severity (TS: the row owns the
    // disclosure; the event carries `aborted: true`).
    assert!(end_event.get("errorMessage").is_none(), "{end_event}");
    assert!(end_event.get("errorSeverity").is_none(), "{end_event}");
    assert_eq!(end_event["willRetry"], false);

    // The durable session file carries exactly the cancelled row and no
    // compaction entry (an aborted run never commits).
    let session_file = std::fs::read_dir(&session_dir)
        .expect("list session dir")
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
                && std::fs::read_to_string(path)
                    .map(|content| content.contains("compaction_outcome"))
                    .unwrap_or(false)
        })
        .expect("the durable outcome row in the session file");
    let persisted = std::fs::read_to_string(&session_file).expect("read session file");
    assert!(
        !persisted.contains("\"type\":\"compaction\"")
            && !persisted.contains("\"type\": \"compaction\""),
        "the aborted compaction never commits an entry"
    );
    let durable_rows: Vec<&str> = persisted
        .lines()
        .filter(|line| line.contains("\"compaction_outcome\""))
        .collect();
    assert_eq!(durable_rows.len(), 1, "exactly one durable outcome row");
    let durable: Value = serde_json::from_str(durable_rows[0]).expect("parse durable row");
    assert_eq!(durable["type"], "custom_message");
    assert_eq!(durable["customType"], "compaction_outcome");
    assert_eq!(durable["content"], "Compaction cancelled");
    assert_eq!(
        durable["details"],
        json!({"reason": "threshold", "outcome": "cancelled"})
    );

    // The next turn works on the un-compacted context (the disclosure row
    // never reaches the provider request).
    mock.hold_summarizer.store(false, Ordering::SeqCst);
    let before_next = mock.request_count();
    client.send_command(
        "p3",
        json!({"type": "prompt_and_wait", "activeSessionId": session_id, "message": "next turn"}),
    );
    let next = client.read_response("p3");
    assert_eq!(next["success"], true, "next prompt failed: {next}");
    client.drain_events(500);
    let requests = mock.requests.lock().expect("mock lock").clone();
    let next_turn_request = requests[before_next..]
        .iter()
        .find(|body| !is_summarizer_request(body) && !is_status_line_request(body))
        .expect("the next turn reached the provider")
        .clone();
    let serialized = serde_json::to_string(&next_turn_request).expect("serialize request");
    assert!(
        !serialized.contains("compaction_outcome") && !serialized.contains("Compaction cancelled"),
        "the disclosure never reaches the provider request"
    );
}

/// Find the resident worker's pid from the persisted descriptors (the
/// supervisor's own durable state under `daemon-workers/<socket hash>/`).
fn worker_pid(agent_dir: &Path) -> u32 {
    let workers_dir = agent_dir.join("daemon-workers");
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        for hash_dir in std::fs::read_dir(&workers_dir)
            .into_iter()
            .flatten()
            .flatten()
        {
            for file in std::fs::read_dir(hash_dir.path())
                .into_iter()
                .flatten()
                .flatten()
            {
                let path = file.path();
                if path.extension().is_none_or(|extension| extension != "json") {
                    continue;
                }
                let Ok(content) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let Ok(descriptor) = serde_json::from_str::<Value>(&content) else {
                    continue;
                };
                if let Some(pid) = descriptor.get("pid").and_then(Value::as_u64) {
                    if pid > 0 {
                        return pid as u32;
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!(
        "no worker descriptor with a pid under {}",
        workers_dir.display()
    );
}

/// The supervisor's terminal-compaction journal for this socket, if written.
fn supervision_journal(agent_dir: &Path) -> Option<PathBuf> {
    let workers_dir = agent_dir.join("daemon-workers");
    for hash_dir in std::fs::read_dir(&workers_dir)
        .into_iter()
        .flatten()
        .flatten()
    {
        let path = hash_dir.path().join("compaction-supervision.jsonl");
        if path.exists() {
            return Some(path);
        }
    }
    None
}

fn signal(pid: u32, signal: &str) {
    let status = Command::new("kill")
        .arg(signal)
        .arg(pid.to_string())
        .status()
        .expect("send signal");
    assert!(status.success(), "kill {signal} {pid} failed");
}

/// The wedged-worker abort (the abort supervision): a worker frozen
/// mid-compaction cannot answer its own abort command. The supervisor
/// acknowledges the abort immediately (never the worker's 30s route
/// timeout), declares the run terminal after the grace window — the
/// synthetic aborted `compaction_end` clears every attached loader and the
/// terminal record lands in the supervisor's own journal — and the
/// replacement worker's create replay discloses the cancelled outcome in
/// the rebuilt durable transcript.
#[test]
fn wedged_worker_abort_acks_immediately_and_declares_terminal() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let mock = CompactionMock::start();
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
    let socket = dir.path().join("daemon.sock");
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

    // Seed turn, then the crossing turn whose summarizer the mock holds.
    client.send_command(
        "p1",
        json!({"type": "prompt_and_wait", "activeSessionId": session_id, "message": "seed turn"}),
    );
    let seeded = client.read_response("p1");
    assert_eq!(seeded["success"], true, "seed prompt failed: {seeded}");
    mock.hold_summarizer.store(true, Ordering::SeqCst);
    client.send_command(
        "p2",
        json!({"type": "prompt_and_wait", "activeSessionId": session_id, "message": "crossing turn"}),
    );
    let summarizer_index = 2;
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline && mock.request_count() <= summarizer_index {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        mock.request_count() > summarizer_index,
        "the compaction summarizer request never arrived"
    );

    // The forwarded `compaction_start` must reach an attached client
    // before the freeze: the client's loader is up exactly because that
    // frame flowed through the supervisor — which is also what arms the
    // supervisor's token. The generous budget rides out a battery-loaded
    // box's event-forwarding lag.
    client.wait_for_event(
        Duration::from_secs(60),
        "the compaction_start broadcast",
        |event| event["type"] == "compaction_start",
    );

    // The second client attaches while the worker still answers (the
    // loader-holding TUI in the real flow), then the worker freezes: a
    // SIGSTOP is the wedge — the connection stays open, the command plane
    // stops answering.
    let mut second = Client::connect(&socket);
    second.send_command(
        "a2",
        json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached2 = second.read_response("a2");
    assert_eq!(attached2["success"], true, "second attach: {attached2}");
    let pid = worker_pid(&agent_dir);
    signal(pid, "-STOP");

    // The abort acknowledges immediately from the supervisor plane (TS
    // daemon-mode's in-process `abortCompaction` always replies instantly;
    // the wedged worker must not turn it into the 30s route timeout).
    let sent_at = Instant::now();
    second.send_command(
        "ab1",
        json!({ "type": "abort_compaction", "activeSessionId": session_id }),
    );
    let aborted = second.read_response("ab1");
    let ack_elapsed = sent_at.elapsed();
    assert_eq!(aborted["success"], true, "abort failed: {aborted}");
    // The bound proves the ack never waited on the wedged worker's route
    // (30s), while staying generous for a battery-loaded box's scheduling
    // lag on the supervisor's own (immediate, worker-free) answer.
    assert!(
        ack_elapsed < Duration::from_secs(25),
        "the acknowledgment waited on the wedged worker: {ack_elapsed:?}"
    );

    // The supervisor declares the run terminal after the grace window: the
    // synthetic aborted `compaction_end` reaches the attached client (the
    // TUI clears its loader on it). An auto run's aborted end carries no
    // error message or severity, like the worker's own cancelled arm.
    let deadline = Instant::now() + Duration::from_secs(60);
    let end_event = loop {
        second.drain_events(200);
        if let Some(event) = second.events.iter().find(|event| {
            event["type"] == "compaction_end"
                && event["aborted"] == true
                && event["reason"] == "threshold"
        }) {
            break event.clone();
        }
        assert!(
            Instant::now() < deadline,
            "the synthetic compaction_end never landed; events: {:#?}",
            second.events
        );
    };
    assert!(end_event.get("errorMessage").is_none(), "{end_event}");
    assert!(end_event.get("errorSeverity").is_none(), "{end_event}");
    assert_eq!(end_event["willRetry"], false);

    // The terminal record persisted in the supervisor's own journal,
    // unconsumed (the replacement's create replay owns the consumption).
    let journal_path = supervision_journal(&agent_dir).expect("the supervision journal exists");
    let journal = std::fs::read_to_string(&journal_path).expect("read journal");
    let record: Value = serde_json::from_str(journal.lines().last().expect("a journal record"))
        .expect("parse journal record");
    assert_eq!(record["type"], "terminal_compaction");
    assert_eq!(record["activeSessionId"], session_id.as_str());
    assert_eq!(record["reason"], "threshold");

    // Kill the frozen worker: the supervisor relaunches it, and the create
    // replay discloses the aborted run — the same durable
    // `compaction_outcome` row the worker's own auto-abort arms persist.
    signal(pid, "-KILL");
    let deadline = Instant::now() + Duration::from_secs(90);
    let durable = loop {
        let row = std::fs::read_dir(&session_dir)
            .expect("list session dir")
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "jsonl")
            })
            .find_map(|path| {
                let content = std::fs::read_to_string(&path).ok()?;
                content
                    .lines()
                    .find(|line| line.contains("\"compaction_outcome\""))
                    .map(str::to_string)
            });
        if let Some(row) = row {
            break serde_json::from_str::<Value>(&row).expect("parse durable row");
        }
        assert!(
            Instant::now() < deadline,
            "the replacement never replayed the cancelled outcome row"
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(durable["type"], "custom_message");
    assert_eq!(durable["customType"], "compaction_outcome");
    assert_eq!(durable["content"], "Compaction cancelled");
    assert_eq!(
        durable["details"],
        json!({"reason": "threshold", "outcome": "cancelled"})
    );

    // The replay consumed the record: the journal drops it, so a later
    // relaunch never replays it again.
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let journal = std::fs::read_to_string(&journal_path).expect("read journal");
        let consumed = !journal
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .any(|record| record["activeSessionId"] == session_id.as_str());
        if consumed {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the journal record was never consumed by the replay"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}
