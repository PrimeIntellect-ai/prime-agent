//! Supervisor kill -9 restart e2e: sessions must survive a supervisor death
//! (invariable: a supervisor restart must not lose sessions). Three scripted
//! sessions with active streams, `kill -9` the supervisor, assert the worker
//! processes/sockets and their in-flight turns survive, restart the
//! supervisor on the same socket path, and assert all three workers
//! re-register within a bounded window, the roster rebuilds, and a scripted
//! turn completes through an attach to the rebuilt roster.
//!
//! Linux-only e2e (AF_UNIX sockets, `kill -9` semantics): compiles to
//! nothing elsewhere, like the other pa-daemon e2e verifiers.
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
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let child = Command::new(binary)
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
        )
        .spawn()
        .expect("spawn pa-daemon supervisor");
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
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
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
            pids.push(pid);
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

    fn send_command(&mut self, id: &str, command: Value) {
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

#[test]
fn supervisor_kill9_restart_sessions_re_register_and_survive() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let supervisor_pid = daemon.child.id();
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    // Three scripted sessions, each with a slow first turn (streaming while
    // the supervisor dies) and a second turn for the post-restart attach.
    let mut sessions = Vec::new();
    for index in 0..3 {
        let script_path = dir.path().join(format!("script-{index}.json"));
        std::fs::write(
            &script_path,
            json!({ "responses": [
                { "text": format!("turn-1-{index}"), "delayMs": 1200 },
                { "text": format!("turn-2-{index}"), "delayMs": 10 },
            ] })
            .to_string(),
        )
        .expect("write script");
        client.send_command(
            &format!("c{index}"),
            json!({
                "type": "create",
                "config": {
                    "cwd": dir.path().to_string_lossy(),
                    "sessionDir": sessions_dir.to_string_lossy(),
                    "script": script_path.to_string_lossy(),
                },
            }),
        );
        let created = client.read_response(&format!("c{index}"));
        assert_eq!(created["success"], true, "create {index} failed: {created}");
        let session_id = created["data"]["id"]
            .as_str()
            .or_else(|| created["data"]["sessionId"].as_str())
            .expect("session id")
            .to_string();
        client.send_command(
            &format!("a{index}"),
            json!({ "type": "attach", "activeSessionId": session_id }),
        );
        let attached = client.read_response(&format!("a{index}"));
        assert_eq!(attached["success"], true, "attach {index} failed");
        sessions.push(session_id);
    }
    // Three worker children, one per session.
    let deadline = Instant::now() + Duration::from_secs(10);
    let worker_pids = loop {
        let children = child_pids_of(supervisor_pid);
        if children.len() == 3 {
            break children;
        }
        assert!(Instant::now() < deadline, "three workers never spawned");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(worker_pids.len(), 3, "one worker per session");

    // Start all three turns; they stream while the supervisor is killed.
    let mut turn_lines: std::collections::VecDeque<Value> = std::collections::VecDeque::new();
    for (index, session_id) in sessions.iter().enumerate() {
        client.send_command(
            &format!("p{index}"),
            json!({
                "type": "prompt",
                "activeSessionId": session_id,
                "message": "go",
            }),
        );
        let (ack, prompt_lines) = client.read_response_and_lines(&format!("p{index}"));
        assert_eq!(ack["success"], true, "prompt {index} failed: {ack}");
        turn_lines.extend(prompt_lines);
    }
    let mut started_streams = 0;
    while started_streams < 3 {
        let line = client.next_line_of_type(&mut turn_lines, "session_event");
        if line["event"]["type"].as_str() == Some("message_start") {
            started_streams += 1;
        }
    }
    assert_eq!(started_streams, 3, "all three sessions stream");

    // kill -9 the supervisor; sessions must keep running.
    daemon.child.kill().expect("kill -9 supervisor");
    let _ = daemon.child.wait();

    let mut descriptors = Vec::new();
    for session_id in &sessions {
        descriptors.push(load_worker_descriptor(&agent_dir, &socket, session_id));
    }

    // Workers alive, sockets accepting, and the in-flight turns complete
    // while no supervisor exists (direct worker connections).
    std::thread::sleep(Duration::from_millis(1600));
    for (descriptor, index) in descriptors.iter().zip(0..3) {
        assert!(
            process_alive(descriptor.pid),
            "worker {} survived the supervisor kill",
            descriptor.worker_id
        );
        let (mut worker, hello) = WorkerClient::connect(&descriptor.socket_path);
        assert_eq!(hello["type"], "daemon_hello");
        let auth = worker.request(
            "worker_auth",
            &json!({
                "token": descriptor.token,
                "supervisorGeneration": "sup:direct",
                "supervisorPid": 1,
                "supervisorSocketPath": socket.to_string_lossy(),
            }),
        );
        assert_eq!(auth["success"], true, "direct auth failed: {auth}");
        let answer = worker.request(
            "get_last_assistant_text",
            &json!({ "activeSessionId": descriptor.worker_id }),
        );
        assert_eq!(answer["success"], true, "last text failed: {answer}");
        assert_eq!(
            answer["data"]["text"],
            json!(format!("turn-1-{index}")),
            "in-flight turn completed without a supervisor"
        );
    }

    // Restart the supervisor on the same socket path.
    let restart_before = pa_daemon::util::now_iso();
    let mut daemon2 = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);

    // All three workers re-register within a bounded window.
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);
    let deadline = Instant::now() + Duration::from_secs(15);
    let registered = loop {
        let registered = distinct(workers_registered_since(&log_path, &restart_before));
        if registered.len() == 3 {
            break registered;
        }
        assert!(
            Instant::now() < deadline,
            "sessions did not re-register after restart ({restart_before}): {registered:?}; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(
        registered,
        {
            let mut expected = sessions.clone();
            expected.sort();
            expected
        },
        "the same three identities re-registered"
    );

    // The roster is rebuilt: list shows the sessions again.
    let (mut client2, _hello) = Client::connect(&socket);
    client2.send_command("list1", json!({ "type": "list" }));
    let list = client2.read_response("list1");
    assert_eq!(list["success"], true, "list failed: {list}");
    let listed = list["data"]["sessions"].as_array().expect("sessions");
    assert_eq!(listed.len(), 3, "roster rebuilt from re-registration");
    let listed_ids: Vec<String> = listed
        .iter()
        .map(|summary| summary["id"].as_str().expect("id").to_string())
        .collect();
    let mut expected = sessions.clone();
    expected.sort();
    assert_eq!(distinct(listed_ids), expected);

    // Attach to one session through the rebuilt roster and complete a turn.
    let target = &sessions[1];
    client2.send_command("a1", json!({ "type": "attach", "activeSessionId": target }));
    let attached = client2.read_response("a1");
    assert_eq!(
        attached["success"], true,
        "post-restart attach failed: {attached}"
    );
    client2.send_command(
        "p1",
        json!({
            "type": "prompt_and_wait",
            "activeSessionId": target,
            "message": "second turn",
        }),
    );
    let (done, mut second_turn_lines) = client2.read_response_and_lines("p1");
    assert_eq!(done["success"], true, "post-restart prompt failed: {done}");
    let answer = loop {
        let line = client2.next_line_of_type(&mut second_turn_lines, "session_event");
        // The user row arrives as its own message_end pair first; the
        // answer is the assistant's final message_end.
        if line["event"]["type"].as_str() == Some("message_end")
            && line["event"]["message"]["role"] == "assistant"
        {
            break line["event"]["message"]["content"]
                .as_str()
                .expect("final text")
                .to_string();
        }
    };
    assert_eq!(answer, "turn-2-1", "scripted turn completed post-restart");

    // Shutdown takes the restarted supervisor and its adopted workers down.
    client2.send_command("sd", json!({ "type": "shutdown" }));
    let shutdown = client2.read_response("sd");
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    let deadline = Instant::now() + Duration::from_secs(10);
    while daemon2.child.try_wait().expect("try wait").is_none() {
        assert!(Instant::now() < deadline, "restarted supervisor exited");
        std::thread::sleep(Duration::from_millis(50));
    }
    for descriptor in &descriptors {
        let deadline = Instant::now() + Duration::from_secs(10);
        while process_alive(descriptor.pid) {
            assert!(
                Instant::now() < deadline,
                "worker {} leaked after shutdown",
                descriptor.worker_id
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
