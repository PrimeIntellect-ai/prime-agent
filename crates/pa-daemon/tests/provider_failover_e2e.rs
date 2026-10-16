//! Provider failover e2e: a two-provider session re-routes to the next
//! configured provider when the primary exhausts its quick retries (the
//! `reason: "backup"` retry event), succeeds, and restores the primary;
//! with every provider failing, the chain walks all candidates.
#![cfg(unix)]

use std::fmt::Write as _;
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

/// A mock OpenAI-completions provider: the first `failures` requests get a
/// 500 with an OpenAI-style error body; the rest get one fixed SSE answer.
/// `Probe` answers the first served request with a `python_repl` tool call
/// (the cell arguments string), the follow-ups with text.
#[derive(Clone)]
enum ReplyMode {
    Text(&'static str),
    Threshold,
    Probe(String),
}

struct FailingMock {
    requests: Arc<Mutex<usize>>,
    port: u16,
    reply: ReplyMode,
}

impl FailingMock {
    fn start(failures: usize, reply: ReplyMode) -> FailingMock {
        let requests = Arc::new(Mutex::new(0usize));
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().expect("mock addr").port();
        let requests_for_thread = Arc::clone(&requests);
        let reply_for_thread = reply.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let requests = Arc::clone(&requests_for_thread);
                let reply = reply_for_thread.clone();
                std::thread::spawn(move || {
                    let _ = serve(stream, failures, &reply, &requests);
                });
            }
        });
        FailingMock {
            requests,
            port,
            reply,
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    fn count(&self) -> usize {
        *self.requests.lock().expect("mock lock")
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
    failures: usize,
    reply: &ReplyMode,
    requests: &Arc<Mutex<usize>>,
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
    let index = {
        let mut requests = requests.lock().expect("mock lock");
        *requests += 1;
        *requests
    };
    if index <= failures {
        let body = json!({
            "error": { "message": "mock provider overloaded", "type": "server_error", "code": 500 }
        })
        .to_string();
        return stream.write_all(
            format!(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        );
    }
    let (delta, reason) = match reply {
        ReplyMode::Text(answer) => (json!({"role":"assistant","content":answer}), "stop"),
        ReplyMode::Probe(cell_arguments) => {
            if index == failures + 1 {
                (
                    json!({"role":"assistant","content":"","tool_calls":[{"index":0,"id":"cell-call","type":"function","function":{"name":"python_repl","arguments":cell_arguments}}]}),
                    "tool_calls",
                )
            } else {
                (json!({"role":"assistant","content":"probed"}), "stop")
            }
        }
        ReplyMode::Threshold => {
            let request: Value = serde_json::from_slice(&body_bytes).expect("request JSON");
            let summary = request["messages"]
                .to_string()
                .contains("context summarization assistant");
            if summary {
                (
                    json!({"role":"assistant","content":"compact summary"}),
                    "stop",
                )
            } else if index == 1 {
                (
                    json!({"role":"assistant","content":"x".repeat(80_000),"tool_calls":[{"index":0,"id":"synthetic-call","type":"function","function":{"name":"synthetic_missing_tool","arguments":"{}"}}]}),
                    "tool_calls",
                )
            } else {
                (
                    json!({"role":"assistant","content":"finished after compaction"}),
                    "stop",
                )
            }
        }
    };
    let mut payload = String::new();
    for data in [chunk(&delta, None), chunk(&json!({}), Some(reason))] {
        write!(payload, "data: {data}\n\n").expect("write to String");
    }
    if matches!(reply, ReplyMode::Threshold) {
        let usage = json!({"id":"chatcmpl-test","object":"chat.completion.chunk","created":1_750_000_000,"model":"mock-1","choices":[],"usage":{"prompt_tokens":if index == 1 { 50_000 } else { 100 },"completion_tokens":10,"total_tokens":if index == 1 { 50_010 } else { 110 }}});
        write!(payload, "data: {usage}\n\n").expect("usage SSE");
    }
    payload.push_str("data: [DONE]\n\n");
    stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}"
        )
        .as_bytes(),
    )
}

/// The kernel Python with prime-agent-runtime installed; set
/// `PA_E2E_KERNEL_PYTHON` to point at an explicit interpreter instead.
fn kernel_python() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PA_E2E_KERNEL_PYTHON") {
        let explicit = PathBuf::from(explicit);
        assert!(
            explicit.exists(),
            "PA_E2E_KERNEL_PYTHON {} not found",
            explicit.display()
        );
        return Some(explicit);
    }
    let candidate = PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
        |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
    ));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!(
        "kernel python {} not found; skipping live model-facts e2e",
        candidate.display()
    );
    None
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path, kernel_python: Option<&Path>) -> Supervisor {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(if std::env::var_os("PA_FAILOVER_E2E_DEBUG").is_some() {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .env_remove("PRIME_API_KEY")
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        // The probe-cell test boots a live kernel on its worker.
        .envs(kernel_python.map(|python| {
            (
                "PRIME_AGENT_KERNEL_PYTHON".to_string(),
                python.display().to_string(),
            )
        }))
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

/// One client connection: request/response plus the session events that stream while a response is
/// outstanding.
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
        let deadline = Instant::now() + Duration::from_mins(3);
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
        let deadline = Instant::now() + Duration::from_secs(30);
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
}

/// Shared harness: supervisor + a two-provider models.json (both serving
/// `mock-1`, the order the failover chain walks) + fast retry/failover
/// settings + a created, attached session.
fn setup(
    name: &str,
    primary: &FailingMock,
    backup: &FailingMock,
) -> (tempfile::TempDir, Supervisor, Client, String) {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": primary.url(),
                    "apiKey": "sk-primary",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096
                        }
                    ]
                },
                "prime-backup": {
                    "api": "openai-completions",
                    "baseUrl": backup.url(),
                    "apiKey": "sk-backup",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1 (backup)",
                            "api": "openai-completions",
                            "contextWindow": if matches!(backup.reply, ReplyMode::Threshold) { 64_000 } else { 128_000 },
                            "maxTokens": 4096
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    // Fast quick-retry (one on the primary) and failover (one per provider) so the
    // test asserts the chain, not the delays.
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({
            "compaction": {"enabled":true,"keepRecentTokens":10},
            "retry": {
                "enabled": true,
                "maxRetries": 1,
                "baseDelayMs": 50,
                "failover": { "enabled": true, "maxRetries": 1, "baseDelayMs": 50 }
            }
        })
        .to_string(),
    )
    .expect("write settings.json");
    let socket = dir.path().join(format!("{name}.sock"));
    let supervisor = spawn_supervisor(&socket, &agent_dir, /*kernel_python*/ None);
    let mut client = Client::connect(&socket);
    client.send_command(
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
    let created = client.request("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    client.send_command(
        "a1",
        &json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.request("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    (dir, supervisor, client, session_id)
}

fn retry_starts(events: &[Value]) -> Vec<&Value> {
    events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("auto_retry_start"))
        .collect()
}

fn retry_end(events: &[Value]) -> &Value {
    events
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("auto_retry_end"))
        .expect("auto_retry_end")
}

#[test]
fn provider_failure_fails_over_to_the_next_provider_and_recovers() {
    let primary = FailingMock::start(usize::MAX, ReplyMode::Text("never reached"));
    let backup = FailingMock::start(0, ReplyMode::Text("recovered on the backup provider"));
    let (_dir, _supervisor, mut client, session_id) = setup("failover", &primary, &backup);
    client.send_command(
        "p1",
        &json!({ "type": "prompt_and_wait", "activeSessionId": session_id, "message": "hi" }),
    );
    let done = client.request("p1");
    assert_eq!(done["success"], true, "prompt must succeed: {done}");
    client.drain_events(Duration::from_secs(1));

    assert_eq!(primary.count(), 2, "primary requests: initial + 1 retry");
    assert_eq!(backup.count(), 1, "backup served the switched turn");

    let starts = retry_starts(&client.events);
    assert_eq!(starts.len(), 2, "events: {:?}", client.events);
    assert_eq!(starts[0]["attempt"], 1);
    assert_eq!(starts[0]["maxAttempts"], 1);
    // The quick retry's wait sits in the ±20% jitter band around the 50ms base delay.
    let delay = starts[0]["delayMs"].as_u64().expect("delayMs");
    assert!(
        (40..=70).contains(&delay),
        "jittered delay {delay} outside [40, 70]"
    );
    assert_eq!(starts[0].get("reason"), None, "quick retry has no reason");
    assert_eq!(starts[1]["attempt"], 2);
    assert_eq!(starts[1]["reason"], "backup");
    assert_eq!(starts[1]["backupModel"], "prime-backup/mock-1");
    assert_eq!(starts[1]["delayMs"], 0);
    assert!(starts[1]["errorMessage"]
        .as_str()
        .expect("error message")
        .contains("mock provider overloaded"));

    let end = retry_end(&client.events);
    assert_eq!(end["success"], true);
    assert_eq!(end["attempt"], 2);
    assert_eq!(end["restoredModel"], "prime-inference/mock-1");

    let answer = client
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("message_end"))
        .find(|event| {
            event["message"]["role"] == "assistant"
                && event["message"]["stopReason"] != "error"
                && event["message"]["content"]
                    .as_array()
                    .is_some_and(|content| {
                        content.iter().any(|block| {
                            block["text"].as_str() == Some("recovered on the backup provider")
                        })
                    })
        })
        .expect("backup assistant message_end");
    assert_eq!(answer["message"]["provider"], "prime-backup");

    // The turn ends clean with the TS `turn_end` payload: the terminal assistant
    // message (the backup's answer) and the empty tool-result list, no error anywhere.
    let turn_end = client
        .events
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("turn_end"))
        .expect("turn_end");
    assert_eq!(turn_end.get("error"), None, "turn_end: {turn_end}");
    assert_eq!(turn_end["message"]["role"], "assistant");
    assert_eq!(turn_end["message"]["stopReason"], "stop");
    assert_eq!(turn_end["message"]["provider"], "prime-backup");
    assert!(
        turn_end["message"]["content"]
            .as_array()
            .is_some_and(|content| {
                content
                    .iter()
                    .any(|block| block["text"].as_str() == Some("recovered on the backup provider"))
            }),
        "turn_end carries the terminal assistant message: {turn_end}"
    );
    assert_eq!(
        turn_end["toolResults"].as_array().map(Vec::len),
        Some(0),
        "the recovered turn ran no tools"
    );
}

#[test]
fn every_provider_failing_surfaces_the_final_error() {
    let primary = FailingMock::start(usize::MAX, ReplyMode::Text("never reached"));
    let backup = FailingMock::start(usize::MAX, ReplyMode::Text("never reached"));
    let (_dir, _supervisor, mut client, session_id) = setup("exhausted", &primary, &backup);
    client.send_command(
        "p1",
        &json!({ "type": "prompt_and_wait", "activeSessionId": session_id, "message": "hi" }),
    );
    let done = client.request("p1");
    assert_eq!(done["success"], false, "prompt must fail: {done}");
    client.drain_events(Duration::from_secs(1));

    assert_eq!(primary.count(), 2);
    assert_eq!(backup.count(), 2);

    let starts = retry_starts(&client.events);
    assert_eq!(starts.len(), 3, "events: {:?}", client.events);
    assert_eq!(starts[0].get("reason"), None);
    assert_eq!(starts[1]["reason"], "backup");
    assert_eq!(starts[1]["backupModel"], "prime-backup/mock-1");
    assert_eq!(
        starts[2].get("reason"),
        None,
        "the backup quick-retries too"
    );

    let end = retry_end(&client.events);
    assert_eq!(end["success"], false);
    assert_eq!(end["attempt"], 4);
    assert!(end["finalError"]
        .as_str()
        .expect("final error")
        .contains("mock provider overloaded"));
    assert_eq!(end.get("restoredModel"), None);

    let failure = client
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("message_end"))
        .find(|event| {
            event["message"]["role"] == "assistant" && event["message"]["stopReason"] == "error"
        })
        .expect("failed assistant message_end");
    assert!(failure["message"]["errorMessage"]
        .as_str()
        .expect("error message")
        .contains("mock provider overloaded"));
    let turn_end = client
        .events
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("turn_end"))
        .expect("turn_end");
    // The TS `turn_end` shape: the terminal frame carries the failed assistant
    // message as its payload (no separate error field).
    assert_eq!(turn_end["message"]["stopReason"], "error");
    assert!(turn_end["message"]["errorMessage"]
        .as_str()
        .expect("turn error")
        .contains("mock provider overloaded"));
    assert_eq!(turn_end.get("error"), None, "turn_end: {turn_end}");
}

#[test]
fn threshold_yield_keeps_the_backup_until_the_tool_run_finishes() {
    let primary = FailingMock::start(usize::MAX, ReplyMode::Text("never"));
    let backup = FailingMock::start(0, ReplyMode::Threshold);
    let (_dir, _supervisor, mut client, session_id) =
        setup("threshold-failover", &primary, &backup);
    client.send_command("p1", &json!({"type":"prompt_and_wait","activeSessionId":session_id,"message":"u".repeat(120_000)}));
    let done = client.request("p1");
    assert_eq!(done["success"], true, "{done}");
    // Read until the authoritative run settles, with a bound even if unrelated
    // events keep arriving and every individual read succeeds.
    let settle_deadline = Instant::now() + Duration::from_secs(30);
    while !client
        .events
        .iter()
        .any(|event| event["type"] == "auto_retry_end")
    {
        assert!(
            Instant::now() < settle_deadline,
            "retry episode did not settle"
        );
        let line = client.read_line();
        client.collect_event(&line);
    }
    assert_eq!(
        primary.count(),
        2,
        "threshold yield must not retry the failed primary"
    );
    assert!(
        backup.count() >= 3,
        "tool turn, summary and continuation use the backup"
    );
    let compact = client
        .events
        .iter()
        .position(|event| event["type"] == "compaction_end")
        .expect("backup threshold compacted");
    assert_eq!(client.events[compact]["aborted"], false);
    assert!(
        client.events[compact]["result"].is_object(),
        "{:?}",
        client.events[compact]
    );
    assert!(client.events[compact]["errorMessage"].is_null());
    let final_reply = client
        .events
        .iter()
        .position(|event| {
            event["type"] == "message_end"
                && event["message"]["content"]
                    .to_string()
                    .contains("finished after compaction")
        })
        .expect("continued after summary");
    let restore = client
        .events
        .iter()
        .position(|event| event["type"] == "auto_retry_end")
        .unwrap();
    assert!(
        compact < final_reply && final_reply < restore,
        "primary restores only after real completion"
    );
    assert_eq!(
        client
            .events
            .iter()
            .filter(|event| event["type"] == "auto_retry_end")
            .count(),
        1
    );
}

/// The probe cell as the tool-call `arguments` string: the kernel-side
/// `model.info` and `compact.status` answered inside the turn, written to a
/// receipt for the verifier.
fn probe_cell(receipt: &Path) -> String {
    let code = format!(
        "import json\nfrom rlm import host_request\npayload = {{}}\npayload[\"model_info\"] = await host_request(\"model.info\", {{}})\npayload[\"compact_status\"] = await host_request(\"compact.status\", {{}})\nopen({receipt:?}, \"w\").write(json.dumps(payload))\nprint(\"FACTS_PROBED\")",
        receipt = receipt.display().to_string(),
    );
    serde_json::to_string(&json!({ "code": code })).expect("serialize the cell arguments")
}

/// Read a probe cell's receipt: the cell runs inside a settled turn, so
/// the file is on disk once `prompt_and_wait` returns. A missing receipt
/// means the tool call failed — the turn's tool result names why.
fn read_receipt(client: &mut Client, session_id: &str, receipt: &Path, read_id: &str) -> Value {
    let raw = std::fs::read_to_string(receipt).unwrap_or_else(|error| {
        client.send_command(
            read_id,
            &json!({ "type": "get_messages", "activeSessionId": session_id }),
        );
        let messages = client.request(read_id);
        let tool_result = messages["data"]["messages"]
            .as_array()
            .and_then(|rows| rows.iter().rev().find(|row| row["role"] == "toolResult"))
            .cloned()
            .unwrap_or(Value::Null);
        panic!(
            "probe cell receipt {} unreadable ({error}); the turn's tool result: {tool_result}",
            receipt.display()
        );
    });
    serde_json::from_str(&raw).unwrap_or_else(|error| panic!("receipt {raw:?}: {error}"))
}

/// The first successful backup response restores the session model before
/// its tool executes, matching the actual TS binary: both probe cells report
/// primary facts while the in-episode provider requests stay on the backup.
// Long by design: one failover flow asserted end to end.
#[allow(clippy::too_many_lines)]
#[test]
fn failover_switch_and_restore_rebind_the_kernel_model_facts() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    // Two request-failures on the primary drive the failover (initial +
    // one quick retry); the backup serves the in-episode probe, the
    // recovered primary the restore probe. Distinct backup input/window
    // facts catch leaving backup session facts after its first successful response.
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let episode_receipt = dir.path().join("facts-episode.json");
    let restored_receipt = dir.path().join("facts-restored.json");
    let primary = FailingMock::start(2, ReplyMode::Probe(probe_cell(&restored_receipt)));
    let backup = FailingMock::start(0, ReplyMode::Probe(probe_cell(&episode_receipt)));
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": primary.url(),
                    "apiKey": "sk-primary",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "input": ["text"],
                            "contextWindow": 128_000,
                            "maxTokens": 4096
                        }
                    ]
                },
                "prime-backup": {
                    "api": "openai-completions",
                    "baseUrl": backup.url(),
                    "apiKey": "sk-backup",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1 (backup)",
                            "api": "openai-completions",
                            "input": ["text", "image"],
                            "contextWindow": 64_000,
                            "maxTokens": 4096
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    // Fast quick-retry (one on the primary) and failover (one per provider)
    // so the test asserts the rebind, not the delays.
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({
            "retry": {
                "enabled": true,
                "maxRetries": 1,
                "baseDelayMs": 50,
                "failover": { "enabled": true, "maxRetries": 1, "baseDelayMs": 50 }
            }
        })
        .to_string(),
    )
    .expect("write settings.json");
    let socket = dir.path().join("facts-failover.sock");
    let _supervisor = spawn_supervisor(&socket, &agent_dir, Some(&kernel_python));
    let mut client = Client::connect(&socket);
    client.send_command(
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
    let created = client.request("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    client.send_command(
        "a1",
        &json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.request("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    // The primary fails its two attempts. The backup response restores
    // primary session state before this probe, while its run keeps backup traffic.
    client.send_command(
        "p1",
        &json!({ "type": "prompt_and_wait", "activeSessionId": session_id, "message": "probe the episode" }),
    );
    let done = client.request("p1");
    assert_eq!(done["success"], true, "the failover turn settled: {done}");
    let episode = read_receipt(&mut client, &session_id, &episode_receipt, "gm-e");
    assert_eq!(
        episode["model_info"],
        json!({ "id": "mock-1", "provider": "prime-inference", "input": ["text"] }),
        "model.info must report the restored primary session before backup tools execute: {episode}"
    );
    assert_eq!(
        episode["compact_status"]["context_window"], 128_000,
        "the primary session's context window returns before the backup probe: {episode}"
    );

    assert_eq!(
        (primary.count(), backup.count()),
        (2, 2),
        "the failed primary requests and both successful backup requests remain separate"
    );

    // Settlement restores the provider target; the next turn runs on the primary.
    client.send_command(
        "p2",
        &json!({ "type": "prompt_and_wait", "activeSessionId": session_id, "message": "probe the restore" }),
    );
    let done = client.request("p2");
    assert_eq!(done["success"], true, "the restore turn settled: {done}");
    let restored = read_receipt(&mut client, &session_id, &restored_receipt, "gm-r");
    assert_eq!(
        restored["model_info"],
        json!({ "id": "mock-1", "provider": "prime-inference", "input": ["text"] }),
        "model.info must rebind the primary on restore: {restored}"
    );
    assert_eq!(
        restored["compact_status"]["context_window"], 128_000,
        "the primary's context window returns on restore: {restored}"
    );
    assert_eq!(
        (primary.count(), backup.count()),
        (4, 2),
        "the next probe uses the primary without another backup request"
    );
}
