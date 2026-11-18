//! The routed `shutdown` exit must not tear a frame another connection is
//! still reading: the reply unlocks `process::exit`, so every connection's
//! fan-out flushes the frames broadcast before the shutdown first. A paced
//! reader keeps a large frame in flight past the reply on every platform
//! (the macOS shape: an 8 KB `AF_UNIX` send buffer splits even a small
//! `session_closed` frame across many writes).
#![cfg(unix)]

use std::io::{Read as _, Write as _};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const TOKEN: &str = "shutdown-flush-token";

struct WorkerGuard(Child);

impl Drop for WorkerGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn_worker(dir: &Path, socket: &Path) -> WorkerGuard {
    std::fs::create_dir_all(dir.join("agent")).expect("agent dir");
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("worker")
        .env(pa_daemon::worker::WORKER_ROLE_ENV, "1")
        .env(pa_daemon::worker::WORKER_TOKEN_ENV, TOKEN)
        .env(
            pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
            "shutdown-flush",
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
        .env("PRIME_AGENT_CODING_AGENT_DIR", dir.join("agent"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn pa-daemon worker");
    WorkerGuard(child)
}

/// Read one frame from `bytes` at `offset`; `None` when the bytes end first.
fn parse_frame(bytes: &[u8], offset: usize) -> Option<(Value, &[u8], usize)> {
    let prefix = bytes.get(offset..offset + 8)?;
    let header_len = u32::from_be_bytes(prefix[0..4].try_into().unwrap()) as usize;
    let payload_len = u32::from_be_bytes(prefix[4..8].try_into().unwrap()) as usize;
    let header_end = offset + 8 + header_len;
    let end = header_end + payload_len;
    let header = serde_json::from_slice(bytes.get(offset + 8..header_end)?).expect("header");
    Some((header, bytes.get(header_end..end)?, end))
}

/// Read frames until the response to `request_id` (blocking reads).
fn read_until_response(stream: &mut UnixStream, request_id: &str) -> Value {
    let mut bytes = Vec::new();
    let mut offset = 0;
    let mut chunk = [0u8; 16 * 1024];
    loop {
        while let Some((header, payload, end)) = parse_frame(&bytes, offset) {
            offset = end;
            if header["requestId"] == request_id {
                return serde_json::from_slice(payload).expect("response");
            }
        }
        let read = stream.read(&mut chunk).expect("read");
        assert!(read > 0, "the worker closed before answering {request_id}");
        bytes.extend_from_slice(&chunk[..read]);
    }
}

fn request(stream: &mut UnixStream, command_type: &str, payload: &Value) -> Value {
    let request_id = format!("req-{command_type}");
    let frame = pa_daemon::framing::encode_private_frame(
        &json!({ "kind": "command", "requestId": request_id, "commandType": command_type }),
        &serde_json::to_vec(payload).expect("payload"),
        pa_daemon::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
    )
    .expect("encode");
    stream.write_all(&frame).expect("write");
    read_until_response(stream, &request_id)
}

/// A streaming (supervisor-role) connection past its hello and auth.
fn connect(socket: &Path) -> UnixStream {
    let mut stream = UnixStream::connect(socket).expect("connect worker");
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .expect("read timeout");
    let auth = request(
        &mut stream,
        "worker_auth",
        &json!({
            "token": TOKEN,
            "supervisorGeneration": "sup:shutdown-flush",
            "supervisorPid": 1,
            "supervisorSocketPath": "/nonexistent/supervisor.sock",
        }),
    );
    assert_eq!(auth["success"], true, "auth: {auth}");
    stream
}

#[test]
fn the_shutdown_exit_waits_for_a_slow_readers_in_flight_frame() {
    let dir = tempfile::TempDir::new_in("/tmp").expect("temp dir");
    let socket = dir.path().join("worker.sock");
    let mut worker = spawn_worker(dir.path(), &socket);
    let deadline = Instant::now() + Duration::from_secs(15);
    while !socket.exists() {
        assert!(Instant::now() < deadline, "worker socket never appeared");
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut control = connect(&socket);
    let mut slow = connect(&socket);
    let created = request(
        &mut control,
        "create",
        &json!({ "noSession": true, "cwd": dir.path().to_string_lossy() }),
    );
    assert_eq!(created["success"], true, "create: {created}");
    // The rename's `session_info_changed` frame carries the 4 MB name:
    // the slow connection's fan-out blocks mid-frame on its full buffer.
    let name = "n".repeat(4 * 1024 * 1024);
    let renamed = request(&mut control, "rename", &json!({ "name": name }));
    assert_eq!(renamed["success"], true, "rename failed");

    // The slow reader drains at about 8 MB/s, so the frame is still in
    // flight when the shutdown reply lands.
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 8 * 1024];
        loop {
            match slow.read(&mut chunk) {
                Ok(0) | Err(_) => return bytes,
                Ok(read) => bytes.extend_from_slice(&chunk[..read]),
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    });
    let shutdown = request(&mut control, "shutdown", &json!({}));
    assert_eq!(shutdown["success"], true, "shutdown: {shutdown}");
    let bytes = reader.join().expect("reader");
    assert!(
        worker.0.wait().expect("worker exit").success(),
        "clean exit"
    );

    let mut offset = 0;
    let mut renamed_names = Vec::new();
    while offset < bytes.len() {
        let (header, payload, end) = parse_frame(&bytes, offset).unwrap_or_else(|| {
            panic!(
                "the exit tore a frame: {} of {} bytes after offset {offset}",
                bytes.len() - offset,
                bytes.len()
            )
        });
        offset = end;
        let outbound: Value = serde_json::from_slice(payload).expect("payload");
        let event = &outbound["event"];
        if header["outboundType"] == "session_event" && event["type"] == "session_info_changed" {
            renamed_names.push(event["name"].as_str().map(str::len));
        }
    }
    assert_eq!(renamed_names, vec![Some(name.len())]);
}
