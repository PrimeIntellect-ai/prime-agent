//! End-to-end verifier for the durable `compaction_outcome` row (TS
//! `_endCompactionUnsuccessfully` -> `_persistCompactionOutcome`): a forced
//! FAILED auto-compaction at the daemon worker must append the durable
//! `custom_message` row to the session file, broadcast it as a
//! `message_start`/`message_end` pair before the settled `compaction_end`
//! event, and keep it out of the provider request (the model never sees
//! the disclosure, so the KV-cacheable prefix is unaffected — the TS
//! contract, pinned by `agent-session-compaction.test.ts`).
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

/// An OpenAI-compatible SSE mock with a switchable failure mode for the
/// compaction summarizer request: while `fail_summarizer` is set, any
/// request carrying the summarization prompt gets a 500 (the forced
/// failed compaction); every other request is answered with the fixed
/// reply. The per-request usage list makes the second turn's usage cross
/// the compaction threshold (the f14-auto battery shape: 126010 tokens
/// against a 500-token headroom).
struct CompactionMock {
    requests: Arc<Mutex<Vec<Value>>>,
    fail_summarizer: Arc<AtomicBool>,
    port: u16,
}

impl CompactionMock {
    fn start() -> CompactionMock {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let fail_summarizer = Arc::new(AtomicBool::new(false));
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().expect("mock addr").port();
        let requests_for_thread = Arc::clone(&requests);
        let fail_for_thread = Arc::clone(&fail_summarizer);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let requests = Arc::clone(&requests_for_thread);
                let fail = Arc::clone(&fail_for_thread);
                std::thread::spawn(move || {
                    let _ = serve(stream, requests, fail);
                });
            }
        });
        CompactionMock {
            requests,
            fail_summarizer,
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
    fail_summarizer: Arc<AtomicBool>,
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
    if fail_summarizer.load(Ordering::SeqCst) && is_summarizer_request(&body) {
        let error = json!({"error": {"message": "summarizer unavailable"}}).to_string();
        return stream.write_all(
            format!(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                error.len(),
                error
            )
            .as_bytes(),
        );
    }
    // Turn 2 (the crossing turn) reports the over-threshold usage; every
    // other request (including the recovery compaction's summarizer)
    // reports the small usage so the session does not re-cross.
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
        let deadline = Instant::now() + Duration::from_secs(30);
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

    /// Read lines until the response for `id` arrives, parking broadcast
    /// events on the way.
    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_mins(1);
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

/// A forced-failed auto-compaction at the worker: the durable outcome row,
/// its broadcast pair before the settled end event, and the model-context
/// exclusion on the next turn.
#[test]
fn forced_failed_auto_compaction_records_the_durable_outcome_row() {
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
    // headroom): the post-turn threshold check fires a compaction, and the
    // mock fails its summarizer request.
    mock.fail_summarizer.store(true, Ordering::SeqCst);
    client.send_command(
        "p2",
        json!({"type": "prompt_and_wait", "activeSessionId": session_id, "message": "crossing turn"}),
    );
    let crossed = client.read_response("p2");
    assert_eq!(
        crossed["success"], true,
        "crossing prompt failed: {crossed}"
    );
    let summarizer_index = 2; // turn 1, turn 2, then the compaction summarizer
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && mock.request_count() <= summarizer_index {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        mock.request_count() > summarizer_index,
        "the compaction summarizer request never arrived"
    );
    client.drain_events(500);

    // The broadcast: the durable row's message pair, then the settled
    // compaction_end carrying the same failure message (TS
    // `_endCompactionUnsuccessfully` order).
    let row_start = client
        .events
        .iter()
        .position(|event| {
            event["type"] == "message_start"
                && event["message"]["customType"] == "compaction_outcome"
        })
        .unwrap_or_else(|| {
            panic!(
                "the outcome row's message_start broadcast; events: {:#?}; requests: {:#?}",
                client.events,
                mock.requests.lock().expect("mock lock").len()
            )
        });
    let row_end = client
        .events
        .iter()
        .position(|event| {
            event["type"] == "message_end" && event["message"]["customType"] == "compaction_outcome"
        })
        .expect("the outcome row's message_end broadcast");
    assert!(row_end > row_start, "the row's pair stays in order");
    let row = client.events[row_start]["message"].clone();
    assert_eq!(row["role"], "custom");
    let failure_message = row["content"].as_str().expect("row content");
    assert!(
        failure_message.starts_with("Auto-compaction failed:"),
        "the row carries the failure message: {failure_message}"
    );
    assert_eq!(
        row["details"],
        json!({"reason": "threshold", "outcome": "failed"})
    );
    assert_eq!(row["display"], true);
    let compaction_end_index = client
        .events
        .iter()
        .position(|event| {
            event["type"] == "compaction_end"
                && event["reason"] == "threshold"
                && event["errorMessage"].is_string()
        })
        .expect("the failed compaction_end broadcast");
    assert!(
        compaction_end_index > row_end,
        "the end event follows the disclosure pair"
    );
    let end_event = client.events[compaction_end_index].clone();
    assert_eq!(end_event["errorMessage"], json!(failure_message));
    // TS `_endCompactionUnsuccessfully` passes no `errorSeverity` for
    // automatic failures (the options carry customInstructions only), so
    // the wire carries no key at all.
    assert_eq!(end_event["errorSeverity"], json!(null));
    assert_eq!(end_event["aborted"], false);
    assert_eq!(end_event["willRetry"], false);

    // The durable session file carries the row (the TS
    // appendCustomMessageEntryWithRollback shape: customType/content/
    // display/details on a custom_message entry).
    // The session file carries a session UUID, not the worker's active id.
    let session_file = std::fs::read_dir(&session_dir)
        .expect("list session dir")
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
                && std::fs::read_to_string(path)
                    .is_ok_and(|content| content.contains("compaction_outcome"))
        })
        .expect("the durable outcome row in the session file");
    let persisted = std::fs::read_to_string(&session_file).expect("read session file");
    let durable_row: Vec<&str> = persisted
        .lines()
        .filter(|line| line.contains("\"compaction_outcome\""))
        .collect();
    assert_eq!(durable_row.len(), 1, "exactly one durable outcome row");
    let durable: Value = serde_json::from_str(durable_row[0]).expect("parse durable row");
    assert_eq!(durable["type"], "custom_message");
    assert_eq!(durable["customType"], "compaction_outcome");
    assert_eq!(durable["content"], json!(failure_message));
    assert_eq!(durable["display"], true);
    assert_eq!(
        durable["details"],
        json!({"reason": "threshold", "outcome": "failed"})
    );

    // The next turn: recovery compaction succeeds (the mock serves the
    // summarizer again), the turn runs on the rebuilt context, and the
    // provider request NEVER contains the disclosure — the model-context
    // exclusion that keeps the KV-cacheable prefix unaffected.
    mock.fail_summarizer.store(false, Ordering::SeqCst);
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
        .find(|body| !is_summarizer_request(body))
        .expect("the next turn reached the provider")
        .clone();
    let serialized = serde_json::to_string(&next_turn_request).expect("serialize request");
    assert!(
        !serialized.contains("compaction_outcome") && !serialized.contains(failure_message),
        "the disclosure never reaches the provider request"
    );
}
