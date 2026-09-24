//! Concurrent-create join e2e (TS `openingSessions` parity): two `create`
//! commands racing on the worker's own socket must join the first create
//! instead of both initializing the session — duplicating creation-prefix
//! rows and overwriting the initialized core state. The race window is the
//! session-model restore's awaits (the spawn_blocking file scan), so the
//! driver runs the real engine (no script) and pads the session file until
//! the scan holds the first create open long enough for the second to land.
//! The join keeps the session file at exactly one creation prefix and one
//! `session_state` row, and both creates answer the created summary.
#![cfg(unix)]

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Kill a leftover worker at scope exit (the shutdown path is the primary
/// cleanup; this is the fallback).
struct WorkerGuard {
    child: Child,
}

impl Drop for WorkerGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Spawn the real `pa-daemon worker` binary with no create-config model
/// (the restore path runs) and a nonexistent supervisor socket (the two
/// authenticated clients below disarm the orphan monitor).
fn spawn_worker(dir: &Path, socket: &Path, token: &str) -> WorkerGuard {
    std::fs::create_dir_all(dir.join("agent")).expect("agent dir");
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("worker")
        .env(pa_daemon::worker::WORKER_ROLE_ENV, "1")
        .env(pa_daemon::worker::WORKER_TOKEN_ENV, token)
        .env(
            pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
            "create-join",
        )
        .env(pa_daemon::worker::WORKER_SOCKET_ENV, socket)
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
            dir.join("absent-supervisor.sock"),
        )
        .env(
            pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV,
            dir.join("recovery.jsonl"),
        )
        .env(pa_daemon::worker::WORKER_CWD_ENV, dir)
        .env("PRIME_AGENT_CODING_AGENT_DIR", dir.join("agent"))
        .env_remove("PRIME_AGENT_MODEL")
        .env_remove("PRIME_AGENT_MODEL_PROVIDER")
        // A supervisor killed at teardown must not leak this worker into
        // later test binaries: the orphan exit runs on this short window.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn session worker");
    WorkerGuard { child }
}

fn wait_socket_ready(socket: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if socket.exists() {
            return;
        }
        assert!(Instant::now() < deadline, "worker socket never came up");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A raw private-frame client for the worker socket (the same wire the
/// supervisor's request pump speaks).
struct WorkerClient {
    stream: UnixStream,
}

impl WorkerClient {
    fn connect(socket: &Path, token: &str) -> Self {
        let stream = UnixStream::connect(socket).expect("connect worker socket");
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        let mut client = WorkerClient { stream };
        let (header, _payload) = client.read_frame();
        assert_eq!(header["outboundType"], "daemon_hello", "worker hello");
        let auth = client.request(
            "worker_auth",
            &json!({
                "token": token,
                "supervisorGeneration": "sup:create-join",
                "supervisorPid": 1,
                "supervisorSocketPath": "/nonexistent/supervisor.sock",
            }),
        );
        assert_eq!(auth["success"], true, "worker auth failed: {auth}");
        client
    }

    fn send_frame(&mut self, header: &Value, payload: &Value) {
        let frame = pa_daemon::framing::encode_private_frame(
            header,
            &serde_json::to_vec(payload).expect("payload"),
            pa_daemon::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .expect("encode frame");
        self.stream.write_all(&frame).expect("write frame");
        self.stream.flush().expect("flush");
    }

    /// Fire a request and return without waiting for its response (the
    /// concurrent creates must both be in flight before either answer).
    fn fire(&mut self, command_type: &str, payload: &Value) -> String {
        let request_id = format!("req-{command_type}-{}", std::process::id());
        self.send_frame(
            &json!({
                "kind": "command",
                "requestId": request_id,
                "commandType": command_type,
            }),
            payload,
        );
        request_id
    }

    fn wait_response(&mut self, request_id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no response for {request_id}");
            let (header, body) = self.read_frame();
            if header["outboundType"].as_str() == Some("response")
                && header["requestId"].as_str() == Some(request_id)
            {
                return serde_json::from_slice(&body).expect("response body");
            }
        }
    }

    fn request(&mut self, command_type: &str, payload: &Value) -> Value {
        let request_id = self.fire(command_type, payload);
        self.wait_response(&request_id)
    }

    fn read_frame(&mut self) -> (Value, Vec<u8>) {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut prefix = [0u8; 8];
        read_exact_timeout(&mut self.stream, &mut prefix, deadline);
        let header_len = u32::from_be_bytes(prefix[0..4].try_into().unwrap()) as usize;
        let payload_len = u32::from_be_bytes(prefix[4..8].try_into().unwrap()) as usize;
        let mut header = vec![0u8; header_len];
        read_exact_timeout(&mut self.stream, &mut header, deadline);
        let mut payload = vec![0u8; payload_len];
        read_exact_timeout(&mut self.stream, &mut payload, deadline);
        let header: Value = serde_json::from_slice(&header).expect("frame header");
        (header, payload)
    }
}

fn read_exact_timeout(stream: &mut UnixStream, buffer: &mut [u8], deadline: Instant) {
    let mut read = 0usize;
    while read < buffer.len() {
        assert!(Instant::now() < deadline, "worker frame read timed out");
        match stream.read(&mut buffer[read..]) {
            Ok(0) => panic!("worker closed the connection mid-frame"),
            Ok(n) => read += n,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => panic!("worker read: {error}"),
        }
    }
}

/// A models.json custom provider whose apiKey rides the file (registry
/// auth without env or auth.json), pinned by the session file below so
/// the create's session-model restore resolves on the registry fast path.
fn write_models_json(agent_dir: &Path) {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9",
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
}

/// The session file the two racing creates both open: it pins the battery
/// model (the restore reads the pin) and carries filler messages so the
/// spawn_blocking scan of `saved_model_from_session_file` holds the first
/// create open long enough for the second create to land inside the
/// window the created check guards.
fn write_padded_session_file(dir: &Path) -> PathBuf {
    let mut session =
        pa_daemon::session_store::SessionFile::create(dir.to_str().expect("utf8 dir"), None, 0);
    session.append_model_change("battery", "mock-1");
    for index in 0..2_000 {
        session.append_message(json!({
            "role": "user",
            "content": format!("filler {index}"),
            "timestamp": index as u64,
        }));
    }
    let path = dir.join(pa_daemon::session_store::session_file_name(
        session.session_id(),
    ));
    session.set_path(path.clone());
    session.rewrite().expect("write session file");
    path
}

#[test]
fn concurrent_creates_join_the_first_create() {
    let dir =
        std::env::temp_dir().join(format!("pa-create-join-{}-{}", std::process::id(), line!()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let socket = dir.join("worker.sock");
    write_models_json(&dir.join("agent"));
    let session_path = write_padded_session_file(&dir);
    let token = "create-join-token";
    let mut worker = spawn_worker(&dir, &socket, token);
    wait_socket_ready(&socket);

    let payload = json!({
        "sessionPath": session_path.to_string_lossy(),
        "cwd": dir.to_string_lossy(),
    });
    // Two authenticated clients race the same create: both frames land
    // while the first create is still inside its restore awaits.
    let mut first = WorkerClient::connect(&socket, token);
    let mut second = WorkerClient::connect(&socket, token);
    let first_id = first.fire("create", &payload);
    let second_id = second.fire("create", &payload);
    let first_response = first.wait_response(&first_id);
    let second_response = second.wait_response(&second_id);
    assert_eq!(
        first_response["success"], true,
        "first create failed: {first_response}"
    );
    assert_eq!(
        second_response["success"], true,
        "second create failed: {second_response}"
    );
    // The join answer is the created summary: both creates serve the
    // same session.
    assert_eq!(
        first_response["data"]["sessionId"], second_response["data"]["sessionId"],
        "both creates answer the same created session"
    );

    // The worker is shut down through its own dispose path before the
    // file is inspected, so the creation-prefix writes are final.
    let shutdown = first.request("shutdown", &json!({}));
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match worker.child.try_wait().expect("worker wait") {
            Some(_) => break,
            None => {
                assert!(
                    Instant::now() < deadline,
                    "worker did not exit after shutdown"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }

    // The join contract: exactly one creation prefix. A raced double
    // initialization appends the thinking level (and the active-state
    // row) twice.
    let store =
        pa_daemon::session_store::SessionFile::open(&session_path).expect("reopen session file");
    let entries = store.entries();
    let thinking_rows = entries
        .iter()
        .filter(|entry| entry.type_ == "thinking_level_change")
        .count();
    let state_rows = entries
        .iter()
        .filter(|entry| entry.type_ == "session_state")
        .count();
    assert_eq!(
        thinking_rows, 1,
        "a joined create writes the creation prefix exactly once"
    );
    assert_eq!(
        state_rows, 1,
        "a joined create marks the session active exactly once"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
