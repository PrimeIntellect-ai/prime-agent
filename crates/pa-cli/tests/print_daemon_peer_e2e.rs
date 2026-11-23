// too_many_lines: style gate only.
#![allow(clippy::too_many_lines)]

//! End-to-end verifier for print mode over a running daemon (T-0016): a
//! `-r <id> -p` run drives a daemon session, so the daemon holds the
//! session lease and a peer's `send_message` reaches the session while the
//! print turn is in flight (TS main.ts `useDaemonClient`).
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The print turn's prompt marker: the mock holds a request carrying it
/// until the test releases the gate.
const HOLD_MARKER: &str = "HOLD-ME";

struct Daemon {
    child: Child,
    socket: PathBuf,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// The release gate for held requests: `true` once released.
type Gate = Arc<(Mutex<bool>, Condvar)>;

/// An OpenAI-completions mock: every request answers `answer`, except one
/// carrying [`HOLD_MARKER`] before the gate opens, which reports itself on
/// `held` and waits for the release.
fn spawn_mock(answer: &'static str, gate: &Gate, held: mpsc::Sender<()>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
    let url = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    let gate = Arc::clone(gate);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let gate = Arc::clone(&gate);
            let held = held.clone();
            std::thread::spawn(move || {
                let _ = serve(stream, answer, &gate, &held);
            });
        }
    });
    url
}

fn serve(
    mut stream: TcpStream,
    answer: &str,
    gate: &Gate,
    held: &mpsc::Sender<()>,
) -> std::io::Result<()> {
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
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or_default();
        }
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;
    if String::from_utf8_lossy(&body).contains(HOLD_MARKER) {
        let (released, wake) = &**gate;
        let mut released = released.lock().unwrap();
        if !*released {
            let _ = held.send(());
            while !*released {
                released = wake.wait(released).unwrap();
            }
        }
    }
    let mut payload = String::new();
    for (delta, finish_reason) in [
        (json!({"role": "assistant", "content": answer}), Value::Null),
        (json!({}), json!("stop")),
    ] {
        let chunk = json!({
            "id": "chatcmpl-print-daemon",
            "object": "chat.completion.chunk",
            "created": 1_750_000_000,
            "model": "mock-1",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        });
        write!(payload, "data: {chunk}\n\n").expect("write to String");
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
fn spawn_daemon(socket: &Path, home: &Path, agent_dir: &Path) -> Daemon {
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(socket)
        .env("HOME", home)
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for var in [
        pa_daemon::worker::WORKER_ROLE_ENV,
        pa_daemon::worker::WORKER_TOKEN_ENV,
        pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
        pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV,
        pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
        pa_daemon::worker::WORKER_SOCKET_ENV,
        pa_daemon::worker::WORKER_INSTANCE_ID_ENV,
        pa_daemon::worker::WORKER_SCRIPT_ENV,
    ] {
        command.env_remove(var);
    }
    // A supervisor killed at teardown must not leak its session workers into
    // later test binaries.
    command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    let child = command.spawn().expect("spawn prime-agent --mode daemon");
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
    panic!("daemon socket never appeared");
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> Self {
        let stream = UnixStream::connect(socket).expect("connect daemon");
        stream
            .set_read_timeout(Some(Duration::from_secs(90)))
            .expect("read timeout");
        let writer = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
        };
        assert_eq!(client.read_line()["type"], "daemon_hello");
        client
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        loop {
            line.clear();
            assert_ne!(
                self.reader.read_line(&mut line).expect("daemon line"),
                0,
                "the daemon closed the connection"
            );
            if !line.trim().is_empty() {
                return serde_json::from_str(line.trim()).expect("parse daemon line");
            }
        }
    }

    /// Send one command and return its response (other frames skipped).
    fn request(&mut self, id: &str, command: &Value) -> Value {
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": {
                "name": "prime-agent.daemon",
                "version": pa_types::daemon::DAEMON_PROTOCOL_VERSION,
            },
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        loop {
            let frame = self.read_line();
            if frame["type"] == "response" && frame["id"] == id {
                return frame;
            }
        }
    }

    fn create(&mut self, id: &str, name: &str, cwd: &Path, sessions: &Path) -> Value {
        let created = self.request(
            id,
            &json!({
                "type": "create",
                "name": name,
                "config": {
                    "cwd": cwd.to_string_lossy(),
                    "sessionDir": sessions.to_string_lossy(),
                    "provider": "prime-inference",
                    "model": "mock-1",
                },
            }),
        );
        assert_eq!(created["success"], true, "create {name} failed: {created}");
        created["data"].clone()
    }
}

/// A peer reaches a session driven by `-r <id> -p` while its turn runs:
/// the print run is a daemon session, never a daemonless lease holder the
/// daemon cannot wake.
#[test]
fn a_peer_message_reaches_a_resumed_print_session_mid_turn() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let home = dir.path().canonicalize().expect("canonical temp dir");
    let agent_dir = home.join("agent");
    let sessions = agent_dir.join("sessions");
    let work = home.join("work");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    std::fs::create_dir_all(&work).expect("work dir");
    // The direct delivery path keeps the delivered row in the transcript.
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({ "agentInbox": { "enabled": false } }).to_string(),
    )
    .expect("settings");
    let gate: Gate = Arc::new((Mutex::new(false), Condvar::new()));
    let (held_tx, held_rx) = mpsc::channel();
    let url = spawn_mock("mock reply", &gate, held_tx);
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": url,
                    "apiKey": "sk-print-daemon",
                    "models": [{
                        "id": "mock-1",
                        "name": "Mock 1",
                        "api": "openai-completions",
                        "contextWindow": 128_000,
                        "maxTokens": 4096
                    }]
                }
            }
        })
        .to_string(),
    )
    .expect("models.json");
    let socket = home.join("daemon.sock");
    let _daemon = spawn_daemon(&socket, &home, &agent_dir);
    let mut client = Client::connect(&socket);

    // The target: one turn on a daemon session, then stopped, so its file
    // is a saved session the print run resumes.
    let target = client.create("c-target", "target", &work, &sessions);
    let target_active = target["activeSessionId"].as_str().expect("active id");
    let session_id = target["sessionId"]
        .as_str()
        .expect("session id")
        .to_string();
    let seeded = client.request(
        "p-seed",
        &json!({ "type": "prompt_and_wait", "activeSessionId": target_active, "message": "seed" }),
    );
    assert_eq!(seeded["success"], true, "seed turn failed: {seeded}");
    let killed = client.request(
        "k-target",
        &json!({ "type": "kill", "activeSessionId": target_active }),
    );
    assert_eq!(killed["success"], true, "kill failed: {killed}");
    let peer = client.create("c-peer", "peer", &work, &sessions);
    let peer_active = peer["activeSessionId"].as_str().expect("peer active id");

    let mut print = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .args(["--daemon-socket"])
        .arg(&socket)
        .args(["--provider", "prime-inference", "--model", "mock-1"])
        .args(["-r", &session_id, "-p", &format!("resume {HOLD_MARKER}")])
        .current_dir(&work)
        .env("HOME", &home)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn the print run");
    if held_rx.recv_timeout(Duration::from_secs(90)).is_err() {
        let _ = print.kill();
        let output = print.wait_with_output().expect("print output");
        panic!(
            "the print turn never reached the provider: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let sent = client.request(
        "s-peer",
        &json!({
            "type": "send_message",
            "targetActiveSessionId": session_id,
            "fromActiveSessionId": peer_active,
            "message": "peer hello",
        }),
    );
    {
        let (released, wake) = &*gate;
        *released.lock().unwrap() = true;
        wake.notify_all();
    }
    let output = print.wait_with_output().expect("print output");
    assert_eq!(
        sent["success"], true,
        "the peer's send must reach the print-driven session: {sent}"
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let transcript =
        std::fs::read_to_string(sessions.join(format!("{session_id}.jsonl"))).expect("transcript");
    assert!(
        transcript.contains("peer hello"),
        "the delivery is in the session transcript: {transcript}"
    );
}
