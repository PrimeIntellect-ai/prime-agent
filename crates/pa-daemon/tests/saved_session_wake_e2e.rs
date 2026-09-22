//! Saved-session wake e2e (messaging-7 gap): a `send_message` that targets a
//! saved-but-inactive session wakes it. The supervisor catalog-resolves the
//! selector, spawns a worker over the persisted session file (the headless
//! resume machinery), and delivers; the woken session's turn completes
//! against the mock provider. A second send reuses the resident worker, and
//! a selector that matches no saved session keeps the TS unknown-session
//! error. The provider is a local always-200 OpenAI-completions mock, so
//! the woken worker resolves the real engine path hermetically.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
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

/// One always-200 SSE answer per request (the mock the woken session turns
/// against).
fn spawn_mock(answer: &'static str) -> PathBuf /* url */ {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
    let url = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            std::thread::spawn(move || {
                let _ = serve(stream, answer);
            });
        }
    });
    PathBuf::from(url)
}

fn chunk(delta: Value, finish_reason: Option<&str>) -> String {
    json!({
        "id": "chatcmpl-wake",
        "object": "chat.completion.chunk",
        "created": 1750000000,
        "model": "mock-1",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    })
    .to_string()
}

fn serve(mut stream: TcpStream, answer: &str) -> std::io::Result<()> {
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
    let mut payload = String::new();
    for data in [
        chunk(json!({"role": "assistant", "content": answer}), None),
        chunk(json!({}), Some("stop")),
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
fn spawn_daemon(socket: &Path, agent_dir: &Path) -> Daemon {
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        // The woken worker has no create-config model: it falls back to the
        // process pair, exactly like the TS daemon's default session config.
        .env("PRIME_AGENT_MODEL_PROVIDER", "prime-inference")
        .env("PRIME_AGENT_MODEL", "mock-1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
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
            return Daemon {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> (Self, Value) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let stream = loop {
            match UnixStream::connect(socket) {
                Ok(stream) => break stream,
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("connect supervisor: {error}"),
            }
        };
        let writer = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
        };
        let hello = client.read_line();
        (client, hello)
    }

    fn send_command(&mut self, id: &str, command: Value) {
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).expect("serialize command");
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
            .expect("set timeout");
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
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

/// Poll a sync probe until it yields a value.
fn wait_until<T>(deadline: Duration, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + deadline;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "condition never became true");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// One live session's transcript through the supervisor route.
fn messages(client: &mut Client, id: &str, active_session_id: &str) -> String {
    client.send_command(
        id,
        json!({ "type": "get_messages", "activeSessionId": active_session_id }),
    );
    let response = client.read_response(id);
    assert_eq!(response["success"], true, "get_messages failed: {response}");
    serde_json::to_string(&response["data"]).expect("messages json")
}

#[test]
fn send_to_a_saved_session_wakes_it_and_runs_the_turn() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let url = spawn_mock("wake reply");
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": url.to_string_lossy(),
                    "apiKey": "sk-wake",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128000,
                            "maxTokens": 4096
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    let socket = dir.path().join("daemon.sock");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    // One session that goes inactive: prompt a turn, then stop the worker.
    // The session file persists under the agent dir.
    client.send_command(
        "c1",
        json!({
            "type": "create",
            "name": "alpha",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions.to_string_lossy(),
                "provider": "prime-inference",
                "model": "mock-1",
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let active_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["activeSessionId"].as_str())
        .expect("active id")
        .to_string();
    let session_id = created["data"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_string();
    client.send_command(
        "p1",
        json!({
            "type": "prompt_and_wait",
            "activeSessionId": active_id,
            "message": "first turn",
        }),
    );
    let first_turn = client.read_response("p1");
    assert_eq!(
        first_turn["success"], true,
        "first turn failed: {first_turn}"
    );
    let first_messages = messages(&mut client, "gm1", &active_id);
    assert!(first_messages.contains("wake reply"), "{first_messages}");

    client.send_command(
        "k1",
        json!({ "type": "kill", "activeSessionId": active_id }),
    );
    assert_eq!(client.read_response("k1")["success"], true, "kill failed");
    // The session went inactive: no live residents, one saved session.
    client.send_command("l1", json!({ "type": "list" }));
    let list = client.read_response("l1");
    assert_eq!(
        list["data"]["sessions"].as_array().map(Vec::len),
        Some(0),
        "no live sessions after kill: {list}"
    );
    client.send_command(
        "l2",
        json!({ "type": "list_saved_sessions", "cwd": dir.path().to_string_lossy() }),
    );
    // The list streams item/progress events before the final response.
    let saved_rows = loop {
        let line = client.read_line();
        let sessions = line["data"]["sessions"].as_array().cloned();
        if line.get("id").and_then(Value::as_str) == Some("l2") {
            if let Some(sessions) = sessions {
                break sessions;
            }
        }
    };
    assert_eq!(saved_rows.len(), 1, "the killed session is saved");
    assert_eq!(saved_rows[0]["name"], "alpha");

    // The wake: send by name to the inactive session. The supervisor
    // catalog-resolves "alpha", spawns a worker over the saved file, and
    // delivers the message with the TS receipt.
    client.send_command(
        "s1",
        json!({ "type": "send_message", "targetActiveSessionId": "alpha", "message": "wake up" }),
    );
    let sent = client.read_response("s1");
    assert_eq!(sent["success"], true, "send by name failed: {sent}");
    let receipt = &sent["data"];
    assert_eq!(receipt["target"]["sessionName"], "alpha", "{receipt}");
    assert_eq!(receipt["deliveryStatus"], "delivered", "{receipt}");
    let woken_id = receipt["target"]["activeSessionId"]
        .as_str()
        .expect("woken active id")
        .to_string();
    assert_ne!(woken_id, active_id, "a new worker hosts the woken session");

    // The woken worker spawned: the roster lists the session again, with the
    // saved transcript (same sessionId, the wake resumed the file).
    let listed = wait_until(Duration::from_secs(15), || {
        client.send_command("l3", json!({ "type": "list" }));
        let list = client.read_response("l3");
        list["data"]["sessions"].as_array().and_then(|sessions| {
            sessions
                .iter()
                .find(|summary| summary["sessionId"].as_str() == Some(session_id.as_str()))
                .cloned()
        })
    });
    assert_eq!(listed["sessionName"], "alpha", "{listed}");

    // The delivered prompt ran as a turn and the mock answered it.
    let woken_messages = wait_until(Duration::from_secs(30), || {
        let text = messages(&mut client, "gm2", &woken_id);
        (text.contains("[agent-message from") && text.contains("wake reply")).then_some(text)
    });
    assert_eq!(
        woken_messages.matches("wake up").count(),
        1,
        "{woken_messages}"
    );

    // The reuse path: a second send finds the resident worker hosting the
    // file and delivers without a second wake (one new worker only).
    client.send_command(
        "s2",
        json!({ "type": "send_message", "targetActiveSessionId": "alpha", "message": "again" }),
    );
    let resent = client.read_response("s2");
    assert_eq!(resent["success"], true, "second send failed: {resent}");
    assert_eq!(
        resent["data"]["target"]["activeSessionId"], woken_id,
        "reuse keeps the same worker: {resent}"
    );
    wait_until(Duration::from_secs(30), || {
        let text = messages(&mut client, "gm3", &woken_id);
        (text.matches("again").count() == 1).then_some(())
    });

    // An unknown selector that matches no saved session keeps the TS error.
    client.send_command(
        "s3",
        json!({ "type": "send_message", "targetActiveSessionId": "ghost", "message": "no" }),
    );
    let missed = client.read_response("s3");
    assert_eq!(missed["success"], false, "{missed}");
    assert_eq!(missed["error"], "Unknown active session: ghost");

    // The stopped worker's 12-hex active id is not durable: the catalog
    // keys by session id and name, so it stays unknown (TS parity).
    client.send_command(
        "s4",
        json!({ "type": "send_message", "targetActiveSessionId": active_id, "message": "no" }),
    );
    let stale = client.read_response("s4");
    assert_eq!(stale["success"], false, "{stale}");
    assert_eq!(
        stale["error"],
        format!("Unknown active session: {active_id}")
    );

    // A saved-session id prefix still wakes: the session is resident now,
    // so the send lands on the reused worker.
    client.send_command(
        "s5",
        json!({
            "type": "send_message",
            "targetActiveSessionId": &session_id[..8],
            "message": "by id",
        }),
    );
    let by_id = client.read_response("s5");
    assert_eq!(by_id["success"], true, "send by session id failed: {by_id}");
    assert_eq!(
        by_id["data"]["target"]["activeSessionId"], woken_id,
        "the session-id prefix resolved to the resident worker: {by_id}"
    );
}
