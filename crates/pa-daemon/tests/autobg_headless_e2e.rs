//! Bounded bash await, headless e2e: a `python_repl` tool call that does a
//! blocking `await bash(...)` keeps the turn moving instead of wedging it,
//! with NO override — the kernel bootstrap's default wiring (the
//! bash.completed host handler flips the runtime's bounded default on) is
//! the thing under test. The late completion lands in the session inbox
//! (the default agent-inbox routing) and its short steering notice wakes
//! the idle session.
//!
//! The mock provider scripts the turn: request 1 calls `python_repl` with a
//! one-shot `await bash('sleep 13; echo ...')`. The await degrades at the
//! 10s default: the tool result carries the still-running handle, and the
//! turn settles while the command keeps running. Its `[bash-done ...]`
//! notice then wakes the idle session. Everything is asserted by transcript
//! event ORDER, not wall-clock caps.

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
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Daemon {
    child: Child,
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The kernel Python with prime-agent-runtime installed; `PA_E2E_KERNEL_PYTHON` overrides.
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
        "kernel python {} not found; skipping bounded-await e2e",
        candidate.display()
    );
    None
}

/// The sequential mock: one SSE answer per request in order.
fn spawn_mock(next: &'static AtomicUsize) -> PathBuf {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
    let url = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            std::thread::spawn(move || {
                let _ = serve(stream, next);
            });
        }
    });
    PathBuf::from(url)
}

fn chunk(delta: &Value, finish_reason: Option<&str>) -> String {
    json!({
        "id": "chatcmpl-bounded",
        "object": "chat.completion.chunk",
        "created": 1_750_000_000,
        "model": "mock-1",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    })
    .to_string()
}

fn serve(mut stream: TcpStream, next: &AtomicUsize) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line == "\r\n" {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or_default();
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }
    // The scripted sequence: request 1 answers the python_repl tool call that
    // runs the bounded one-shot await, request 2 ends the turn, every later
    // request the woken reply.
    let request = next.fetch_add(1, Ordering::SeqCst);
    let mut payload = String::new();
    let data = match request {
        0 => [
            chunk(
                &json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call-bounded-1",
                        "type": "function",
                        "function": {
                            "name": "python_repl",
                            "arguments": "{\"code\": \"from rlm import bash\\nres = await bash('sleep 13; echo BOUNDED_AWAIT_E2E_DONE')\\nres\"}"
                        }
                    }]
                }),
                None,
            ),
            chunk(&json!({}), Some("tool_calls")),
        ],
        1 => [
            chunk(
                &json!({"role": "assistant", "content": "turn complete"}),
                None,
            ),
            chunk(&json!({}), Some("stop")),
        ],
        _ => [
            chunk(
                &json!({"role": "assistant", "content": "woken by the bash-done notice"}),
                None,
            ),
            chunk(&json!({}), Some("stop")),
        ],
    };
    for data in data {
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

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> Client {
        let stream = UnixStream::connect(socket).expect("connect");
        let writer = stream.try_clone().expect("clone");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
        };
        let hello = client.read_line();
        assert_eq!(hello["type"], "daemon_hello");
        client
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_mins(2);
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

    fn request(&mut self, id: &str, command: &Value) -> Value {
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
        let deadline = Instant::now() + Duration::from_mins(2);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }

    fn messages(&mut self, active_session_id: &str) -> String {
        let response = self.request(
            "gm",
            &json!({ "type": "get_messages", "activeSessionId": active_session_id }),
        );
        assert_eq!(response["success"], true, "get_messages failed: {response}");
        serde_json::to_string(&response["data"]).expect("messages json")
    }
}

fn wait_until<T>(deadline: Duration, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + deadline;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "condition never became true");
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &Path, agent_dir: &Path, kernel_python: Option<&Path>) -> Daemon {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let mut command = Command::new(env!("CARGO_BIN_EXE_pa-daemon"));
    command
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .env_remove("PRIME_API_KEY")
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        // A supervisor killed at teardown must not leak its session workers.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "20000",
        );
    if let Some(kernel_python) = kernel_python {
        command.env("PRIME_AGENT_KERNEL_PYTHON", kernel_python);
    }
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if socket.exists() {
            return Daemon {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

#[test]
fn a_bounded_bash_await_degrades_and_the_notice_wakes_the_session() {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let root = tempfile::TempDir::new().expect("temp dir");
    let dir = root.path().to_path_buf();
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let socket = dir.join("daemon.sock");
    let url = spawn_mock(&NEXT);
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": url.to_string_lossy(),
                    "apiKey": "sk-bounded",
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

    let supervisor = spawn_daemon(&socket, &agent_dir, Some(&kernel_python));
    let mut client = Client::connect(&socket);
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let created = client.request(
        "c1",
        &json!({
            "type": "create",
            "name": "bounded-await-lane",
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": sessions.to_string_lossy(),
                "provider": "prime-inference",
                "model": "mock-1",
            },
        }),
    );
    assert_eq!(created["success"], true, "create failed: {created}");
    let active_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["activeSessionId"].as_str())
        .expect("active session id")
        .to_string();

    // THE TURN: the tool call awaits a 13s command with NO override; the
    // default wiring must degrade the await and settle the turn while the
    // command is still running.
    let turn = client.request(
        "p1",
        &json!({
            "type": "prompt_and_wait",
            "activeSessionId": active_id,
            "message": "run the blocking await and finish",
        }),
    );
    assert_eq!(turn["success"], true, "turn failed: {turn}");

    // Event ORDER, part 1 — the tool result shows the RUNNING snapshot (the
    // degrade hint rides the same stderr lane) and the turn settled before
    // the command finished: no completed-result repr anywhere yet.
    let after_turn = client.messages(&active_id);
    let snapshot = after_turn
        .find("<BashSnapshot running pid=")
        .expect("the tool result never showed the running snapshot");
    let turn_end = after_turn
        .find("turn complete")
        .expect("the follow-up assistant reply never landed");
    assert!(
        snapshot < turn_end,
        "the running-snapshot tool result must precede the turn's end: {after_turn}"
    );
    assert!(
        !after_turn.contains("BashResult("),
        "the await blocked to completion instead of degrading: {after_turn}"
    );
    assert!(
        after_turn.contains("still running after"),
        "the budgeted degrade hint never reached the tool result: {after_turn}"
    );

    // Event ORDER, part 2 — the command finishes past the turn, and its
    // notice wakes the idle session: the completion message lands in the
    // durable inbox, and the woken reply can only follow the short
    // steering notice that caused it.
    let settled = wait_until(Duration::from_mins(1), || {
        let messages = client.messages(&active_id);
        (messages.contains("[inbox ") && messages.contains("1 new message (bash-done)"))
            .then_some(messages)
    });
    let notice = settled
        .find("[inbox ")
        .expect("the inbox arrival notice never landed");
    assert!(
        notice > turn_end,
        "the notice must land after the turn settled, not inside it: {settled}"
    );
    // The inbox journal is the durable copy of the completion message.
    let session_file = std::fs::read_dir(dir.join("agent").join("sessions"))
        .expect("sessions dir")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .expect("the session file");
    let inbox_journal = session_file
        .parent()
        .and_then(Path::parent)
        .expect("session file grandparent")
        .join("session-artifacts")
        .join(session_file.file_stem().expect("session file stem"))
        .join("inbox.jsonl");
    let inbox = std::fs::read_to_string(&inbox_journal)
        .unwrap_or_else(|error| panic!("read {}: {error}", inbox_journal.display()));
    assert!(
        inbox.contains("BOUNDED_AWAIT_E2E_DONE"),
        "the completion message never journaled: {inbox}"
    );
    // The wake itself: the woken reply can only exist after the notice.
    wait_until(Duration::from_mins(1), || {
        let messages = client.messages(&active_id);
        let woken_after_notice = messages
            .find("woken by the bash-done notice")
            .is_some_and(|at| at > notice);
        woken_after_notice.then_some(messages)
    });

    // Teardown: stop the session through the live supervisor so the worker
    // (and its kernel + the 13s sleeper) do not leak past the test.
    client.request(
        "k1",
        &json!({ "type": "kill", "activeSessionId": active_id }),
    );
    drop(client);
    drop(supervisor);
}
