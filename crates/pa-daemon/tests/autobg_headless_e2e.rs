//! Auto-backgrounding headless e2e: a model tool call that does a blocking
//! `await bash(...)` keeps the turn moving instead of wedging it.
//!
//! The mock provider scripts the turn: request 1 calls the ipython tool with a
//! one-shot `await bash('sleep 9; echo ...')` — the class that held the
//! agent's tool call for the command's full runtime. With
//! `PRIME_AGENT_AUTOBG_MS=1500` (inherited through the worker into the
//! kernel), the bash await degrades at ~1.5s: the cell finishes with the
//! live handle, the tool result returns, and the turn completes in ~2s —
//! while the command keeps running. Its `bash.completed` notice then still
//! arrives and wakes the session, exactly like a backgrounded handle's.

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

const AUTOBG_MS_ENV: &str = "PRIME_AGENT_AUTOBG_MS";

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

/// The sequential mock provider: request 0 starts the blocking one-shot bash
/// await through the ipython tool, request 1 ends the turn, and every later
/// request (the bash-done wake) answers with the woken reply.
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

fn chunk(delta: Value, finish_reason: Option<&str>) -> String {
    json!({
        "id": "chatcmpl-autobg",
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
    let request = next.fetch_add(1, Ordering::SeqCst);
    let data = match request {
        0 => [
            chunk(
                json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call-autobg-1",
                        "type": "function",
                        "function": {
                            "name": "ipython",
                            "arguments": "{\"code\": \"from rlm import bash\\nres = await bash('sleep 9; echo AUTOBG_E2E_DONE')\\nres\"}"
                        }
                    }]
                }),
                None,
            ),
            chunk(json!({}), Some("tool_calls")),
        ],
        1 => [
            chunk(json!({"role": "assistant", "content": "turn complete"}), None),
            chunk(json!({}), Some("stop")),
        ],
        _ => [
            chunk(
                json!({"role": "assistant", "content": "woken by the bash-done notice"}),
                None,
            ),
            chunk(json!({}), Some("stop")),
        ],
    };
    let mut payload = String::new();
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

    fn request(&mut self, id: &str, command: Value) -> Value {
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
        let deadline = Instant::now() + Duration::from_secs(30);
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
            json!({ "type": "get_messages", "activeSessionId": active_session_id }),
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

/// This e2e must run the CHECKOUT's runtime (the guard lives in it), so unlike
/// the wake e2e suites it does not pin a pre-provisioned kernel python: the
/// daemon bootstraps a dedicated kernel venv from the checkout's
/// prime-agent-runtime (the identity cache makes repeat runs cheap).
fn kernel_venv() -> PathBuf {
    let base = std::env::var_os("CARGO_TARGET_TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("autobg-e2e"));
    base.join("autobg-kernel-venv")
}

/// `PI_PACKAGE_DIR` pins the runtime source to THIS checkout: a binary built
/// in a shared target dir carries another checkout's compile-time root, and
/// the kernel venv would bootstrap that lane's runtime instead of the guard.
fn checkout_package_dir() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .map(Path::to_path_buf)
        .expect("the test compiles inside the workspace checkout")
}

#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &Path, agent_dir: &Path, venv: &Path) -> Daemon {
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
        // The auto-bg knob rides the plain env chain into the kernel
        // (supervisor -> worker -> kernel env), so the degrade fires fast
        // instead of the 10s default.
        .env(AUTOBG_MS_ENV, "1500")
        .env("PRIME_AGENT_KERNEL_VENV", venv)
        .env("PI_PACKAGE_DIR", checkout_package_dir())
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "20000",
        );
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
fn a_blocking_bash_await_degrades_and_the_turn_completes_while_it_runs() {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let venv = kernel_venv();
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
                    "apiKey": "sk-autobg",
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

    let supervisor = spawn_daemon(&socket, &agent_dir, &venv);
    let mut client = Client::connect(&socket);
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let created = client.request(
        "c1",
        json!({
            "type": "create",
            "name": "autobg-lane",
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

    // THE TURN: the tool call blocks a 9s command; with the auto-bg guard the
    // round trip must complete well before the command does (the blocked
    // baseline needs the full 9s plus the engine path).
    let started = Instant::now();
    let turn = client.request(
        "p1",
        json!({
            "type": "prompt_and_wait",
            "activeSessionId": active_id,
            "message": "run the blocking await and finish",
        }),
    );
    let turn_wall = started.elapsed();
    assert_eq!(turn["success"], true, "turn failed: {turn}");
    assert!(
        turn_wall < Duration::from_secs(8),
        "the turn took {turn_wall:?}; the bash await never degraded"
    );

    // The tool result is the degrade note: the live handle, the pid, the poll
    // instruction - the model received the handle and kept working.
    let after_turn = client.messages(&active_id);
    assert!(
        after_turn.contains("still running (pid"),
        "no degrade note in the turn transcript: {after_turn}"
    );
    assert!(
        after_turn.contains("AUTOBG_E2E_DONE") || after_turn.contains("poll or await later"),
        "the note should carry the handle contract: {after_turn}"
    );
    assert!(
        after_turn.contains("turn complete"),
        "the follow-up assistant reply never landed: {after_turn}"
    );

    // THE NOTIFICATION: the command keeps running past the turn, and its
    // completion notice still arrives and wakes the session.
    let settled = wait_until(Duration::from_secs(25), || {
        let messages = client.messages(&active_id);
        (messages.contains("[bash-done pid:") && messages.contains("woken by the bash-done notice"))
            .then_some(messages)
    });
    assert!(
        settled.contains("AUTOBG_E2E_DONE"),
        "the notice should reference the completed command: {settled}"
    );

    // Teardown: stop the session through the live supervisor so the worker
    // (and its kernel + the 9s sleeper) do not leak past the test.
    client.request("k1", json!({ "type": "kill", "activeSessionId": active_id }));
    drop(client);
    drop(supervisor);
}
