//! End-to-end verifier for the live `compaction_summary_delta` broadcast
//! (the operator's "stream the compacted summary" feature): a forced
//! threshold auto-compaction at the daemon worker must forward the
//! summarizer's streamed text chunks to the attached clients as
//! `compaction_summary_delta` session events, in generation order, strictly
//! between the owning `compaction_start` and the settling `compaction_end`
//! — and the frames stay ephemeral: the durable session file never records
//! them, and the settled end's result carries the same text the deltas
//! streamed (the streamed block resolves into the final summary entry).
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The compaction summarizer request marker (the fixed summarization
/// system prompt rides the request's first message).
const SUMMARIZER_MARKER: &str = "context summarization assistant";

/// The scripted summary the mock's summarizer streams, chunk by chunk.
const SUMMARY_CHUNKS: [&str; 4] = [
    "The session covered the fleet work: ",
    "one compaction summary, ",
    "streamed live to the attached clients ",
    "as it generated.",
];
const FULL_SUMMARY: &str = "The session covered the fleet work: one compaction summary, streamed live to the attached clients as it generated.";

struct Supervisor {
    child: Child,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// An OpenAI-compatible SSE mock: turn requests answer with the fixed
/// reply; the compaction summarizer request streams the scripted summary
/// in multiple content chunks (the live delta source). The per-request
/// usage list makes the second turn's usage cross the compaction
/// threshold (the f14-auto battery shape: `126_010` tokens against a
/// 500-token headroom).
struct CompactionMock {
    requests: Arc<Mutex<Vec<Value>>>,
    port: u16,
}

impl CompactionMock {
    fn start() -> CompactionMock {
        let requests = Arc::new(Mutex::new(Vec::new()));
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
        CompactionMock { requests, port }
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

fn serve(mut stream: TcpStream, requests: Arc<Mutex<Vec<Value>>>) -> std::io::Result<()> {
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
    let mut payload = String::new();
    if is_summarizer_request(&body) {
        // The summarizer request streams the scripted summary one content
        // chunk at a time: the daemon forwards each as one
        // `compaction_summary_delta` in generation order.
        for piece in SUMMARY_CHUNKS {
            let _ = write!(
                payload,
                "data: {}\n\n",
                chunk(
                    json!({"role": "assistant", "content": piece}),
                    None,
                    Value::Null
                )
            );
        }
        let _ = write!(
            payload,
            "data: {}\n\n",
            chunk(json!({}), Some("stop"), small_usage())
        );
        payload.push_str("data: [DONE]\n\n");
    } else {
        // Turn 2 (the crossing turn) reports the over-threshold usage;
        // every other request reports the small usage so the session
        // does not re-cross.
        let usage = if index == 1 {
            crossing_usage()
        } else {
            small_usage()
        };
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
            let _ = write!(payload, "data: {data}\n\n");
        }
        payload.push_str("data: [DONE]\n\n");
    }
    stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}"
        )
        .as_bytes(),
    )
}

// The supervisor child is reaped by `Supervisor`'s `Drop` (kill + wait),
// so the detached-process lint does not apply.
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
            return Supervisor { child };
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

/// A threshold auto-compaction at the worker streams its summarizer
/// deltas to the attached clients: the `compaction_summary_delta` frames
/// arrive in generation order between the owning `compaction_start` and
/// the settling `compaction_end`, concatenate to the summary the settled
/// end carries, and never persist to the session file (the streamed block
/// is ephemeral; the durable row is the end's entry).
#[test]
fn threshold_compaction_streams_summary_deltas_to_attached_clients() {
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

    // The crossing turn reports `126_010` tokens (over the 500-token
    // headroom): the post-turn threshold check fires a compaction, and
    // the mock streams the summarizer summary chunk by chunk. The turn's
    // user message is big on purpose: the 10-token keep-recent budget
    // then cuts AT the big user message's own boundary — a non-split cut
    // with the seed turn as the summarizable history (the interactive
    // e2e's same shape: a mid-turn cut would be a split-turn compaction
    // whose turn-prefix call does not stream, a different test shape
    // than this single-history-chunk script).
    client.send_command(
        "p2",
        json!({"type": "prompt_and_wait", "activeSessionId": session_id, "message": format!("crossing turn {}", "x".repeat(4_000))}),
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

    // The run's event family: the loader's start, the streamed deltas in
    // generation order, and the settling end whose result resolves the
    // streamed block.
    let start_index = client
        .events
        .iter()
        .position(|event| event["type"] == "compaction_start" && event["reason"] == "threshold")
        .expect("the threshold compaction_start broadcast");
    let end_index = client
        .events
        .iter()
        .position(|event| event["type"] == "compaction_end" && event["reason"] == "threshold")
        .unwrap_or_else(|| {
            panic!(
                "the threshold compaction_end broadcast; events: {:#?}",
                client.events
            )
        });
    let delta_indexes: Vec<usize> = client
        .events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| (event["type"] == "compaction_summary_delta").then_some(index))
        .collect();
    assert!(
        !delta_indexes.is_empty(),
        "the compaction streamed at least one summary delta: {:#?}",
        client.events
    );
    assert!(
        delta_indexes.iter().all(|index| *index > start_index && *index < end_index),
        "every delta lives between the start and the settling end: {delta_indexes:?} in {start_index}..{end_index}"
    );
    // The deltas arrive in generation order and concatenate to the full
    // scripted summary (the live block the expanded TUI renders).
    let deltas: Vec<&str> = delta_indexes
        .iter()
        .map(|index| client.events[*index]["delta"].as_str().expect("delta text"))
        .collect();
    assert_eq!(deltas, SUMMARY_CHUNKS.to_vec(), "generation order holds");
    let streamed = deltas.concat();
    assert_eq!(streamed, FULL_SUMMARY);
    // The settled end carries the same text: the streamed block resolves
    // into the final summary entry (the end's result is the summary's
    // only durable source).
    let end_event = client.events[end_index].clone();
    assert_eq!(
        end_event["result"]["summary"]
            .as_str()
            .expect("result summary"),
        FULL_SUMMARY
    );

    // The delta frames are ephemeral: the durable session file carries
    // the compaction entry but never a delta frame.
    let session_file = std::fs::read_dir(&session_dir)
        .expect("list session dir")
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
                && std::fs::read_to_string(path)
                    .is_ok_and(|content| content.contains("\"type\":\"compaction\""))
        })
        .expect("the durable compaction entry in the session file");
    let persisted = std::fs::read_to_string(&session_file).expect("read session file");
    assert!(
        !persisted.contains("compaction_summary_delta"),
        "the streamed deltas never persist: {persisted}"
    );
    assert!(
        persisted.contains(FULL_SUMMARY),
        "the durable compaction entry carries the summary"
    );
}
