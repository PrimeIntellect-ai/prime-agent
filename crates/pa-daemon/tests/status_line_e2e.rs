//! End-to-end verifier for the post-turn status line (B-7): a daemon worker
//! session, driven through the wire protocol, must issue the small-model
//! status request after each completed turn — same model, system prompt,
//! and token cap as the TS daemon-session-summarizer — and broadcast the
//! recap to attached clients as `session_status`. A local OpenAI-compatible
//! SSE mock stands in for the provider, so the exact request body is
//! asserted, not just that a request happened.
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

/// One recorded provider request (path, parsed body, Authorization header).
#[derive(Clone, Debug)]
struct RecordedRequest {
    path: String,
    body: Value,
    auth: String,
}

/// A minimal OpenAI-compatible SSE mock: every request is answered with one
/// fixed assistant message (the battery mock's chunk shapes), and the
/// request bodies land in `requests` for assertions.
struct SseMock {
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    port: u16,
}

impl SseMock {
    fn start(answer_text: &'static str) -> SseMock {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().expect("mock addr").port();
        let requests_for_thread = Arc::clone(&requests);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let requests = Arc::clone(&requests_for_thread);
                std::thread::spawn(move || {
                    let _ = serve(stream, answer_text, requests);
                });
            }
        });
        SseMock { requests, port }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    /// Wait until at least `count` requests were recorded (or panic).
    fn wait_for(&self, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if self.requests.lock().expect("mock lock").len() >= count {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!(
            "mock saw only {} of {count} requests",
            self.requests.lock().expect("mock lock").len()
        );
    }
}

fn chunk(delta: Value, finish_reason: Option<&str>) -> String {
    json!({
        "id": "chatcmpl-test",
        "object": "chat.completion.chunk",
        "created": 1750000000,
        "model": "mock",
        "choices": [{
            "index": 0,
            "delta": delta,
            "finish_reason": finish_reason,
        }],
    })
    .to_string()
}

fn serve(
    mut stream: TcpStream,
    answer_text: &str,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
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
    let mut method = String::new();
    let mut path = String::new();
    let mut auth = String::new();
    let mut content_length = 0usize;
    for line in head.lines() {
        let lower = line.to_ascii_lowercase();
        if method.is_empty() {
            let mut parts = line.split(' ');
            method = parts.next().unwrap_or_default().to_string();
            path = parts.next().unwrap_or_default().to_string();
        }
        // Match the header name case-insensitively; the value keeps its case.
        if let Some(rest) = line.strip_prefix("Authorization:") {
            auth = rest.trim().to_string();
        } else if lower.starts_with("authorization:") {
            auth = line[lower.find(':').unwrap_or_default() + 1..]
                .trim()
                .to_string();
        }
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or_default();
        }
    }
    let mut body_bytes = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body_bytes)?;
    }
    let body: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);
    requests.lock().expect("mock lock").push(RecordedRequest {
        path: path.clone(),
        body: body.clone(),
        auth,
    });
    if method != "POST" || !path.contains("chat/completions") {
        let body = json!({"error": {"message": format!("unexpected {method} {path}")}}).to_string();
        return stream.write_all(
            format!(
                "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        );
    }
    // One fixed assistant answer as SSE, closed by connection close.
    let mut payload = String::new();
    for data in [
        chunk(json!({"role": "assistant", "content": answer_text}), None),
        chunk(json!({}), Some("stop")),
        json!({
            "id": "chatcmpl-test",
            "object": "chat.completion.chunk",
            "created": 1750000000,
            "model": "mock",
            "choices": [],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
                "prompt_tokens_details": {"cached_tokens": 0},
            },
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
        // The models.json apiKey must be the auth source under test; ambient
        // provider env keys (the dev box's own credentials) would win.
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
}

impl Client {
    fn connect(socket: &Path) -> Client {
        let stream = std::os::unix::net::UnixStream::connect(socket).expect("connect");
        let writer = stream.try_clone().expect("clone");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
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

    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

#[test]
fn worker_issues_the_post_turn_status_line_request() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    // The mock stands in for the prime-inference provider: the built-in
    // summary model (qwen3-30b) resolves its base URL and apiKey from here.
    let mock =
        SseMock::start("<recap>Answering the user's question</recap><status>COMPLETED</status>");
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "baseUrl": mock.url(),
                    "apiKey": "sk-battery",
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    let socket = dir.path().join("daemon.sock");
    let _supervisor = spawn_supervisor(&socket, &agent_dir);
    let mut client = Client::connect(&socket);

    // A scripted session: the turn itself never touches the provider, so any
    // mock request after the turn is the status line.
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        json!({"responses": [{"text": "turn reply"}]}).to_string(),
    )
    .expect("write script");
    client.send_command(
        "c1",
        json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();

    // Attach first: the session_status broadcast only reaches attached
    // clients.
    client.send_command(
        "a1",
        json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    let before = mock.requests.lock().expect("mock lock").len();
    client.send_command(
        "p1",
        json!({ "type": "prompt_and_wait", "activeSessionId": session_id, "message": "hi" }),
    );
    let done = client.read_response("p1");
    assert_eq!(done["success"], true, "prompt_and_wait failed: {done}");

    // The status line fires after the settle debounce (2s).
    mock.wait_for(before + 1);
    let requests = mock.requests.lock().expect("mock lock").clone();
    let status_request = requests[before..]
        .iter()
        .find(|request| {
            request.body.get("model").and_then(Value::as_str)
                == Some("qwen/qwen3-30b-a3b-instruct-2507")
        })
        .expect("status-line request")
        .clone();
    assert_eq!(status_request.path, "/v1/chat/completions");
    // The TS daemon-session-summarizer contract: the exact system prompt,
    // the idle agent-state wrapper, the trailing-conversation body, and
    // max_tokens 400.
    let messages = status_request.body["messages"]
        .as_array()
        .expect("messages");
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "system");
    assert_eq!(
        messages[0]["content"],
        pa_daemon::status_line::AGENT_STATUS_SYSTEM_PROMPT
    );
    assert_eq!(messages[1]["role"], "user");
    let user_content = &messages[1]["content"];
    let user_text = user_content
        .as_str()
        .or_else(|| {
            user_content
                .as_array()
                .and_then(|blocks| blocks.first())
                .and_then(|block| block.get("text"))
                .and_then(Value::as_str)
        })
        .expect("user text");
    assert!(user_text.starts_with("<agent-state>idle (finished its turn)</agent-state>"));
    assert!(user_text.contains("<conversation>\nuser: hi\nassistant: turn reply\n</conversation>"));
    assert_eq!(status_request.body["max_tokens"], 400);
    assert_eq!(status_request.body["stream"], true);
    // The models.json apiKey authenticates the request (registry resolution,
    // not the provider-name env map).
    assert_eq!(status_request.auth, "Bearer sk-battery");

    // The recap broadcasts to the attached client as session_status.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut recap_seen = false;
    while Instant::now() < deadline && !recap_seen {
        client
            .reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
        let mut line = String::new();
        match client.reader.read_line(&mut line) {
            Ok(0) => panic!("supervisor closed"),
            Ok(_) if line.trim().is_empty() => continue,
            Ok(_) => {
                let event: Value = serde_json::from_str(line.trim()).expect("parse event");
                if event["type"] == "session_status"
                    && event["activeSessionId"] == session_id.as_str()
                    && event["recap"] == "Answering the user's question"
                {
                    recap_seen = true;
                }
            }
            Err(_) => continue,
        }
    }
    assert!(recap_seen, "session_status with the recap never broadcast");
}
