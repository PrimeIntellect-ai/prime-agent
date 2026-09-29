//! Supervisor kill -9 restart e2e: sessions must survive a supervisor death
//! (invariable: a supervisor restart must not lose sessions). Three scripted
//! sessions with active streams, `kill -9` the supervisor, assert the worker
//! processes/sockets and their in-flight turns survive, restart the
//! supervisor on the same socket path, and assert all three workers
//! re-register within a bounded window, the roster rebuilds, and a scripted
//! turn completes through an attach to the rebuilt roster.
//!
//! Linux-only e2e (`AF_UNIX` sockets, `kill -9` semantics): compiles to
//! nothing elsewhere, like the other pa-daemon e2e verifiers.
// Pedantic-gate dispositions (fleet-uniform ruling; see this lane's PR for
// the full rationale).
// Stack-resident futures by design on the daemon's hot paths; boxing the
// call sites for a lint tick is a perf regression with zero correctness gain.
#![allow(clippy::large_futures)]
// 64-bit-only targets; the narrowing casts sit at OS boundaries
// (pid/fd/time/size) where the values are bounded by the kernel - the
// dead-guard expect()s would add panic paths where silent wrap was
// deliberate.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// The fn-length threshold is a style gate, not correctness; the structure
// campaign owns the god-fn splits as a follow-up.
#![allow(clippy::too_many_lines)]
// API-shape opinions, not defects; the surfaces are deliberate.
#![allow(
    clippy::unnecessary_wraps,
    clippy::zero_sized_map_values,
    clippy::struct_excessive_bools,
    clippy::struct_field_names
)]
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
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

fn spawn_supervisor(socket: &Path, agent_dir: &Path) -> Daemon {
    spawn_supervisor_env(socket, agent_dir, &[])
}

fn spawn_supervisor_env(socket: &Path, agent_dir: &Path, extra_env: &[(&str, String)]) -> Daemon {
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let mut command = Command::new(binary);
    let command = command
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // A supervisor killed at teardown must not leak its session workers
        // into later test binaries: the worker's supervisor-lost exit (TS
        // `exitIfSupervisorOrphanedForTooLong`) runs on this short window
        // instead of the 5-minute default.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        );
    for (key, value) in extra_env {
        command.env(key, value);
    }
    let child = command.spawn().expect("spawn pa-daemon supervisor");
    Daemon {
        child,
        socket: socket.to_path_buf(),
    }
}

/// Wait until the supervisor socket accepts connections (a restarted
/// supervisor parks on the stale socket file for up to a second before
/// replacing it, so file existence is not readiness).
fn wait_socket_ready(socket: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if UnixStream::connect(socket).is_ok() {
            return;
        }
        assert!(Instant::now() < deadline, "supervisor socket never came up");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Liveness that ignores zombies (a re-parented child nobody reaps keeps its
/// /proc entry until the status is collected).
fn process_alive(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    let Some((_, rest)) = stat.rsplit_once(')') else {
        return false;
    };
    let state = rest.split_whitespace().next().unwrap_or_default();
    !state.starts_with('Z') && !state.starts_with('X')
}

/// Pids whose parent is `ppid`.
fn child_pids_of(ppid: u32) -> Vec<u32> {
    let mut pids = Vec::new();
    let entries = std::fs::read_dir("/proc").expect("read /proc");
    for entry in entries.flatten() {
        let Ok(entry_pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{entry_pid}/stat")) else {
            continue;
        };
        let Some((_, rest)) = stat.rsplit_once(')') else {
            continue;
        };
        let mut fields = rest.split_whitespace();
        fields.next();
        let Ok(parent) = fields.next().unwrap_or_default().parse::<u32>() else {
            continue;
        };
        if parent == ppid {
            pids.push(entry_pid);
        }
    }
    pids
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> (Self, Value) {
        let stream = UnixStream::connect(socket).expect("connect supervisor");
        let write_stream = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer: write_stream,
        };
        let hello = client.read_line();
        (client, hello)
    }

    fn send(&mut self, value: &Value) {
        let mut line = serde_json::to_string(value).expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn send_command(&mut self, id: &str, command: &Value) {
        self.send(&json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        }));
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(20);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
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

    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }

    /// Read until the response for `id`, buffering the outbound lines seen
    /// first: the daemon emits events before the command reply (TS order),
    /// so a bare `read_response` would discard them.
    fn read_response_and_lines(&mut self, id: &str) -> (Value, std::collections::VecDeque<Value>) {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut lines = std::collections::VecDeque::new();
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return (line, lines);
            }
            lines.push_back(line);
        }
    }

    /// The first buffered-or-live outbound line of `line_type`. Buffered
    /// lines of other types stay buffered; live lines of other types are
    /// skipped, like a filtering read loop.
    fn next_line_of_type(
        &mut self,
        lines: &mut std::collections::VecDeque<Value>,
        line_type: &str,
    ) -> Value {
        if let Some(index) = lines.iter().position(|l| l["type"] == line_type) {
            return lines.remove(index).expect("indexed line");
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no {line_type} line arrived");
            let line = self.read_line();
            if line["type"] == line_type {
                return line;
            }
        }
    }
}

/// A raw private-frame client for one session worker's own socket (the
/// worker serves direct connections even while no supervisor exists).
struct WorkerClient {
    stream: UnixStream,
}

impl WorkerClient {
    fn connect(socket: &Path) -> (Self, Value) {
        let stream = UnixStream::connect(socket).expect("connect worker socket");
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        let mut client = WorkerClient { stream };
        let (header, payload) = client.read_frame();
        assert_eq!(header["outboundType"], "daemon_hello", "worker hello");
        let hello: Value = serde_json::from_slice(&payload).expect("hello payload");
        (client, hello)
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

    fn read_frame(&mut self) -> (Value, Vec<u8>) {
        let deadline = Instant::now() + Duration::from_secs(10);
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

    /// One request/response round trip with a fresh request id.
    fn request(&mut self, command_type: &str, payload: &Value) -> Value {
        static NEXT_REQUEST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let request_id = format!(
            "req-{}",
            NEXT_REQUEST.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        );
        self.send_frame(
            &json!({
                "kind": "command",
                "requestId": request_id,
                "commandType": command_type,
            }),
            payload,
        );
        loop {
            let (header, body) = self.read_frame();
            if header["outboundType"].as_str() == Some("response")
                && header["requestId"].as_str() == Some(request_id.as_str())
            {
                let mut value: Value = serde_json::from_slice(&body).expect("response body");
                value["id"] = json!(request_id);
                return value;
            }
        }
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

/// One persisted worker descriptor, as written by the supervisor.
#[derive(Clone)]
struct WorkerDescriptor {
    worker_id: String,
    pid: u32,
    socket_path: PathBuf,
    token: String,
}

/// Wait until the worker's recovery journal holds the admission `busy:
/// true` record for one session (the durable busy-at-crash evidence): the
/// kill that follows provably lands mid-turn, whatever the runner's
/// pacing does to the stream (the loaded-host failure mode where the
/// whole turn settled before the kill and the revival signal was lost).
fn wait_for_busy_journal_evidence(agent_dir: &Path, socket: &Path, session_id: &str) {
    let journal_path = pa_daemon::descriptor::descriptor_dir(agent_dir, socket)
        .join(format!("{session_id}.recovery.jsonl"));
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let evidence = std::fs::read_to_string(&journal_path).is_ok_and(|content| {
            content.lines().any(|line| {
                let Ok(record) = serde_json::from_str::<Value>(line) else {
                    return false;
                };
                record["activeSessionId"].as_str() == Some(session_id)
                    && record["busy"].as_bool() == Some(true)
            })
        });
        if evidence {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "busy journal evidence never landed for {session_id}: {}",
            journal_path.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn load_worker_descriptor(agent_dir: &Path, socket: &Path, worker_id: &str) -> WorkerDescriptor {
    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(agent_dir, socket);
    let content = std::fs::read_to_string(descriptor_dir.join(format!("{worker_id}.json")))
        .expect("descriptor file");
    let value: Value = serde_json::from_str(&content).expect("descriptor json");
    WorkerDescriptor {
        worker_id: worker_id.to_string(),
        pid: value["pid"].as_u64().expect("pid") as u32,
        socket_path: PathBuf::from(value["socketPath"].as_str().expect("socket path")),
        token: value["authenticationToken"]
            .as_str()
            .expect("token")
            .to_string(),
    }
}

/// Worker ids with a registration log line at or after `since`.
fn workers_registered_since(log_path: &Path, since: &str) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(log_path) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for line in content.lines() {
        let Some(rest) = line.strip_prefix('[') else {
            continue;
        };
        let Some((timestamp, message)) = rest.split_once(']') else {
            continue;
        };
        if timestamp < since {
            continue;
        }
        let message = message.trim();
        if let Some(id) = message.strip_prefix("session worker ") {
            if let Some((worker_id, tail)) = id.split_once(" re-registered (epoch") {
                if tail.contains(')') {
                    ids.push(worker_id.to_string());
                }
            } else if let Some((worker_id, tail)) = id.split_once(" registered (epoch") {
                if tail.contains(')') {
                    ids.push(worker_id.to_string());
                }
            }
        }
    }
    ids
}

fn distinct(values: Vec<String>) -> Vec<String> {
    let mut values = values;
    values.sort();
    values.dedup();
    values
}

// The restart regression families live in the child modules at the same
// tree position (supervisor_restart_e2e::{plain_boot, restart, revival,
// update_boot}); every child's use-super glob resolves through this
// root's harness, and the ONE test binary stays one CI shard unit.
mod plain_boot;
mod restart;
mod revival;
mod update_boot;
