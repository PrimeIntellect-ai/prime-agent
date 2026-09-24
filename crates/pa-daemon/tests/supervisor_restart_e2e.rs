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

/// A plain supervisor boot (no update roster) adopts live workers and
/// revives only dead ones with durable busy evidence. The idle-at-exit
/// session completed its turn, so its journal's latest record settled to
/// `busy: false` (`turn_end` — the state a long-lived daemon accumulates
/// for every idle session); the busy-at-crash session is killed mid-turn,
/// so its journal still holds the boot `create` `busy: true` record. Only
/// the mid-turn one relaunches and re-registers.
#[test]
fn plain_boot_revives_only_journal_busy_workers() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let (mut client, _hello) = Client::connect(&socket);

    // Session 0 settles idle: its one turn completes before the kill.
    let script_idle = dir.path().join("journal-idle.json");
    std::fs::write(
        &script_idle,
        json!({ "responses": [
            { "text": "turn-idle", "delayMs": 10 },
        ] })
        .to_string(),
    )
    .expect("write script");
    client.send_command(
        "c0",
        json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script_idle.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c0");
    assert_eq!(created["success"], true, "create idle failed: {created}");
    let idle_session = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    client.send_command(
        "p0",
        json!({
            "type": "prompt_and_wait",
            "activeSessionId": idle_session,
            "message": "go",
        }),
    );
    let done = client.read_response("p0");
    assert_eq!(done["success"], true, "idle turn failed: {done}");

    // Session 1 dies busy-at-crash: its scripted turn is still streaming
    // when the supervisor and both workers are killed. The pacing keeps
    // the turn deterministically in flight (`delayMs` only gates the
    // stream start; `tokensPerSecond` drips the text out over seconds,
    // so the kill lands mid-stream, before the settle checkpoint).
    let script_busy = dir.path().join("journal-busy.json");
    let busy_text = "still streaming ".repeat(40);
    std::fs::write(
        &script_busy,
        json!({
            "responses": [ { "text": busy_text, "delayMs": 100 } ],
            "tokensPerSecond": 20,
        })
        .to_string(),
    )
    .expect("write script");
    client.send_command(
        "c1",
        json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script_busy.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create busy failed: {created}");
    let busy_session = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    client.send_command(
        "a1",
        json!({ "type": "attach", "activeSessionId": busy_session }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach busy failed: {attached}");
    client.send_command(
        "p1",
        json!({
            "type": "prompt",
            "activeSessionId": busy_session,
            "message": "go",
        }),
    );
    let (ack, mut busy_turn_lines) = client.read_response_and_lines("p1");
    assert_eq!(ack["success"], true, "busy prompt failed: {ack}");
    let mut started = false;
    while !started {
        let line = client.next_line_of_type(&mut busy_turn_lines, "session_event");
        if line["event"]["type"].as_str() == Some("message_start") {
            started = true;
        }
    }
    assert!(started, "the busy turn started streaming");

    // kill -9 the supervisor, then the workers: the descriptors stay on
    // disk with dead sockets and the journals keep their last evidence
    // (idle: a settled `turn_end` busy=false; busy: the boot `create`).
    // The workers are killed by the supervisor's live children, not the
    // descriptor pids — a mid-test replacement (crash backoff, a stop
    // re-finalization) can leave the descriptor stale, and a stale-pid
    // kill would leave the real worker streaming.
    let supervisor_pid = daemon.child.id();
    let worker_pids = child_pids_of(supervisor_pid);
    assert_eq!(
        worker_pids.len(),
        2,
        "two session workers under the supervisor"
    );
    daemon.child.kill().expect("kill -9 supervisor");
    let _ = daemon.child.wait();
    for pid in &worker_pids {
        std::process::Command::new("kill")
            .arg("-9")
            .arg(pid.to_string())
            .status()
            .expect("kill -9 worker");
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    for pid in &worker_pids {
        while process_alive(*pid) {
            assert!(Instant::now() < deadline, "worker {pid} never died");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    // Plain boot on the same socket (no update-roster environment).
    let restart_before = pa_daemon::util::now_iso();
    let mut daemon2 = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);

    // The busy-at-crash session (journal busy=true) relaunches and
    // re-registers; the idle-at-exit session never does.
    let deadline = Instant::now() + Duration::from_secs(15);
    let registered = loop {
        let registered = distinct(workers_registered_since(&log_path, &restart_before));
        if registered == vec![busy_session.clone()] {
            break registered;
        }
        assert!(
            Instant::now() < deadline,
            "busy-at-crash session did not re-register ({restart_before}): {registered:?}; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(registered, vec![busy_session.clone()]);

    // The idle-at-exit session is skipped with a log line and stays off
    // the roster.
    let skip_line = format!(
        "session worker {idle_session} was idle at exit; not revived",
        idle_session = idle_session
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !std::fs::read_to_string(&log_path)
        .unwrap_or_default()
        .contains(&skip_line)
    {
        assert!(
            Instant::now() < deadline,
            "idle session never skipped: {skip_line}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let (mut client2, _hello) = Client::connect(&socket);
    client2.send_command("list1", json!({ "type": "list" }));
    let list = client2.read_response("list1");
    assert_eq!(list["success"], true, "list failed: {list}");
    let listed = list["data"]["sessions"].as_array().expect("sessions");
    let listed_ids: Vec<String> = listed
        .iter()
        .map(|summary| summary["id"].as_str().expect("id").to_string())
        .collect();
    assert_eq!(
        distinct(listed_ids),
        vec![busy_session.clone()],
        "only the busy-at-crash session came back"
    );

    // Shutdown takes the restarted supervisor and the relaunched worker
    // down (the relaunch persisted the new pid in the descriptor).
    let relaunched = load_worker_descriptor(&agent_dir, &socket, &busy_session);
    client2.send_command("sd", json!({ "type": "shutdown" }));
    let shutdown = client2.read_response("sd");
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    let deadline = Instant::now() + Duration::from_secs(10);
    while daemon2.child.try_wait().expect("try wait").is_none() {
        assert!(Instant::now() < deadline, "restarted supervisor exited");
        std::thread::sleep(Duration::from_millis(50));
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while process_alive(relaunched.pid) {
        assert!(
            Instant::now() < deadline,
            "relaunched worker leaked after shutdown"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// An update boot relaunches the dead workers its roster keeps, plus any
/// with durable busy evidence; a dead descriptor the update did NOT keep
/// stays down even though update boots historically relaunched every
/// descriptor (the parked session may have a newer worker from a client
/// reopen — two workers on one session file — so an unkept idle
/// descriptor must never revive).
#[test]
fn update_boot_revives_only_roster_kept_workers() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let (mut client, _hello) = Client::connect(&socket);

    // Two scripted sessions, each with one completed turn: both settle
    // to `busy: false` (`turn_end`), so neither carries busy evidence —
    // only the roster's kept set can distinguish them.
    let mut sessions = Vec::new();
    for index in 0..2 {
        let script_path = dir.path().join(format!("update-{index}.json"));
        std::fs::write(
            &script_path,
            json!({ "responses": [
                { "text": format!("turn-{index}"), "delayMs": 10 },
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
            &format!("p{index}"),
            json!({
                "type": "prompt_and_wait",
                "activeSessionId": session_id,
                "message": "go",
            }),
        );
        let done = client.read_response(&format!("p{index}"));
        assert_eq!(done["success"], true, "turn {index} failed: {done}");
        sessions.push(session_id);
    }

    // kill -9 the supervisor, then both workers.
    // The workers are killed by the supervisor's live children, not the
    // descriptor pids — a mid-test replacement can leave the descriptor
    // stale, and a stale-pid kill would leave the real worker running.
    let supervisor_pid = daemon.child.id();
    let worker_pids = child_pids_of(supervisor_pid);
    assert_eq!(
        worker_pids.len(),
        2,
        "two session workers under the supervisor"
    );
    daemon.child.kill().expect("kill -9 supervisor");
    let _ = daemon.child.wait();
    for pid in &worker_pids {
        std::process::Command::new("kill")
            .arg("-9")
            .arg(pid.to_string())
            .status()
            .expect("kill -9 worker");
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    for pid in &worker_pids {
        while process_alive(*pid) {
            assert!(Instant::now() < deadline, "worker {pid} never died");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    // The update roster keeps only the first session's worker; no session
    // rows (the adoption pass's filter is under test, not the restore
    // pass's row walk).
    let roster_path = dir.path().join("update-roster.json");
    std::fs::write(
        &roster_path,
        json!({
            "format_version": 1,
            "update_id": "u-e2e-1",
            "socket_path": socket.to_string_lossy(),
            "created_at": "2026-01-01T00:00:00Z",
            "supervisor": { "pid": 1, "process_start_id": "p", "generation": "g" },
            "binary": { "from_version": "0.1", "to_version": "0.2" },
            "sessions": [],
            "workers": [{
                "worker_id": sessions[0],
                "sessions": [sessions[0]],
                "launch_env": {},
            }],
        })
        .to_string(),
    )
    .expect("write roster");

    // Update boot on the same socket.
    let restart_before = pa_daemon::util::now_iso();
    let mut daemon2 = spawn_supervisor_env(
        &socket,
        &agent_dir,
        &[(
            pa_types::daemon::update_flow::UPDATE_ROSTER_ENV,
            roster_path.to_string_lossy().to_string(),
        )],
    );
    wait_socket_ready(&socket);
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);

    // The kept worker relaunches and re-registers; the unkept one never
    // does.
    let deadline = Instant::now() + Duration::from_secs(15);
    let registered = loop {
        let registered = distinct(workers_registered_since(&log_path, &restart_before));
        if registered == vec![sessions[0].clone()] {
            break registered;
        }
        assert!(
            Instant::now() < deadline,
            "kept worker did not re-register ({restart_before}): {registered:?}; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(registered, vec![sessions[0].clone()]);

    let skip_line = format!(
        "session worker {} was idle at exit; not revived",
        sessions[1]
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !std::fs::read_to_string(&log_path)
        .unwrap_or_default()
        .contains(&skip_line)
    {
        assert!(
            Instant::now() < deadline,
            "unkept worker never skipped: {skip_line}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    let (mut client2, _hello) = Client::connect(&socket);
    client2.send_command("list1", json!({ "type": "list" }));
    let list = client2.read_response("list1");
    assert_eq!(list["success"], true, "list failed: {list}");
    let listed = list["data"]["sessions"].as_array().expect("sessions");
    let listed_ids: Vec<String> = listed
        .iter()
        .map(|summary| summary["id"].as_str().expect("id").to_string())
        .collect();
    assert_eq!(
        distinct(listed_ids),
        vec![sessions[0].clone()],
        "only the roster-kept session came back"
    );

    let relaunched = load_worker_descriptor(&agent_dir, &socket, &sessions[0]);
    client2.send_command("sd", json!({ "type": "shutdown" }));
    let shutdown = client2.read_response("sd");
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    let deadline = Instant::now() + Duration::from_secs(10);
    while daemon2.child.try_wait().expect("try wait").is_none() {
        assert!(Instant::now() < deadline, "restarted supervisor exited");
        std::thread::sleep(Duration::from_millis(50));
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while process_alive(relaunched.pid) {
        assert!(
            Instant::now() < deadline,
            "relaunched worker leaked after shutdown"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// One captured-shape revival fixture: a durable session file, a dead
/// worker's descriptor, and the worker's recovery journal — the on-disk
/// state a supervisor boots into on the rust-agent box after a failure
/// era (the 17:07 storm slots and the stopped fleet sessions). The
/// shapes mirror the captured artifacts: descriptor
/// `daemon-workers/<socket-key>/<workerId>.json`, journal
/// `<workerId>.recovery.jsonl` (the busy-record shape of
/// `93320d14c7d3`, busy written at 12:02 and read at 17:07), and a
/// session file with an explicit `session_state` row.
struct RevivalFixture {
    worker_id: String,
    session_file: PathBuf,
    session_bytes: Vec<u8>,
}

fn write_revival_fixture(
    dir: &Path,
    agent_dir: &Path,
    socket: &Path,
    session_state: &str,
    lifecycle: &str,
    busy_recorded_at: &str,
) -> RevivalFixture {
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let worker_id = format!("w{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let mut session =
        pa_daemon::session_store::SessionFile::create(&dir.to_string_lossy(), None, 0);
    session.append_message(json!({
        "role": "user", "content": "lane work", "timestamp": 1u64
    }));
    session.append_session_state(session_state);
    let session_id = session.session_id().to_string();
    let session_file = sessions_dir.join(format!("{session_id}.jsonl"));
    session.set_path(session_file.clone());
    session.rewrite().expect("session file");
    let session_bytes = std::fs::read(&session_file).expect("session bytes");

    // A script the relaunched create would drive: on the unpatched base
    // the fixture's worker comes back as a registered live worker; the
    // gate must park it instead.
    let script = dir.join(format!("{worker_id}-script.json"));
    std::fs::write(
        &script,
        json!({ "responses": [ { "text": "ok", "delayMs": 10 } ] }).to_string(),
    )
    .expect("write script");

    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(agent_dir, socket);
    std::fs::create_dir_all(&descriptor_dir).expect("descriptor dir");
    let journal_path = descriptor_dir.join(format!("{worker_id}.recovery.jsonl"));
    std::fs::write(
        &journal_path,
        json!({
            "activeSessionId": worker_id,
            "sessionId": session_id,
            "sessionFile": session_file.to_string_lossy(),
            "busy": true,
            "operation": "create",
            "recordedAt": busy_recorded_at,
        })
        .to_string()
            + "\n",
    )
    .expect("write journal");
    let now = pa_daemon::util::now_iso();
    std::fs::write(
        descriptor_dir.join(format!("{worker_id}.json")),
        json!({
            "version": 2,
            "workerId": worker_id,
            "pid": 4_194_303u64,
            "socketPath": dir.join(format!("{worker_id}.sock")).to_string_lossy(),
            "recoveryJournalPath": journal_path.to_string_lossy(),
            "supervisorSocketPath": socket.to_string_lossy(),
            "authenticationToken": format!("token-{worker_id}"),
            "rootActiveSessionId": worker_id,
            "rootSessionId": session_id,
            "sessionFile": session_file.to_string_lossy(),
            "sessionDir": sessions_dir.to_string_lossy(),
            "createdAt": now,
            "updatedAt": now,
            "lifecycle": lifecycle,
            "createCommand": {
                "sessionPath": session_file.to_string_lossy(),
                "rest": {
                    "cwd": dir.to_string_lossy(),
                    "sessionDir": sessions_dir.to_string_lossy(),
                    "script": script.to_string_lossy(),
                },
            },
            "consecutiveFailures": 0,
        })
        .to_string(),
    )
    .expect("write descriptor");
    RevivalFixture {
        worker_id,
        session_file,
        session_bytes,
    }
}

/// Boot one fixture supervisor, wait out the adoption pass, and answer the
/// (park log line, registered worker ids, listed session ids) the boot
/// produced — the shared assert core of the park regressions.
fn boot_and_observe(agent_dir: &Path, socket: &Path) -> (Daemon, PathBuf, String) {
    let daemon = spawn_supervisor(socket, agent_dir);
    wait_socket_ready(socket);
    let log_path = pa_daemon::paths::daemon_log_path(socket, agent_dir);
    let boot_before = pa_daemon::util::now_iso();
    // The adoption pass runs concurrently with the accept loop; give it a
    // bounded window to reach every descriptor before the assertions read
    // the log and the roster. A boot that revives instead of parking (the
    // unpatched base) never writes the line and falls through — the park
    // assertions below carry the failure with the log dump.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !std::fs::read_to_string(&log_path)
        .unwrap_or_default()
        .contains("not revived")
        && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(50));
    }
    (daemon, log_path, boot_before)
}

/// The 17:07 storm, as a regression: a plain boot must not relaunch a
/// dead descriptor whose journal busy record is hours old — the captured
/// 93320d14c7d3 shape (busy written at 12:02, read at the 17:07 boot)
/// resurrects on the unpatched base as a registered worker.
#[test]
fn plain_boot_parks_stale_busy_evidence() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let busy_at = pa_daemon::util::iso_from_unix_ms(pa_daemon::util::now_ms() - 5 * 60 * 60 * 1000);
    let fixture =
        write_revival_fixture(dir.path(), &agent_dir, &socket, "active", "ready", &busy_at);

    let (_supervisor, log_path, boot_before) = boot_and_observe(&agent_dir, &socket);

    let park_line = format!(
        "session worker {} not revived: its busy evidence is stale (recorded {busy_at}); not revived (reopens on the next client open)",
        fixture.worker_id
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !std::fs::read_to_string(&log_path)
        .unwrap_or_default()
        .contains(&park_line)
    {
        assert!(
            Instant::now() < deadline,
            "stale-evidence worker never parked: {park_line}; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        workers_registered_since(&log_path, &boot_before).is_empty(),
        "the stale-evidence worker resurrected"
    );
    let (mut client, _hello) = Client::connect(&socket);
    client.send_command("list1", json!({ "type": "list" }));
    let list = client.read_response("list1");
    assert_eq!(list["success"], true, "list failed: {list}");
    let listed = list["data"]["sessions"].as_array().expect("sessions");
    assert!(
        listed.is_empty(),
        "the parked session must not come back as a worker"
    );
    // Preserve the session file: the park never touches it.
    assert_eq!(
        std::fs::read(&fixture.session_file).expect("session bytes"),
        fixture.session_bytes,
        "the parked session file must stay byte-identical"
    );
}

/// The stopped-session resurrection, as a regression: even FRESH busy
/// evidence must not revive a session whose durable state is the stop
/// lifecycle's `archived` belt (#2592) — the captured zombie shape (a
/// fleet lane stopped at 15:57, journal still busy from its last turn).
#[test]
fn plain_boot_never_revives_a_stopped_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let busy_at = pa_daemon::util::now_iso();
    let fixture = write_revival_fixture(
        dir.path(),
        &agent_dir,
        &socket,
        "archived",
        "ready",
        &busy_at,
    );

    let (_supervisor, log_path, boot_before) = boot_and_observe(&agent_dir, &socket);

    let park_line = format!(
        "session worker {} not revived: its session is archived (stopped); not revived (reopens on the next client open)",
        fixture.worker_id
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !std::fs::read_to_string(&log_path)
        .unwrap_or_default()
        .contains(&park_line)
    {
        assert!(
            Instant::now() < deadline,
            "stopped session never parked: {park_line}; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        workers_registered_since(&log_path, &boot_before).is_empty(),
        "the stopped session resurrected as a worker"
    );
    // The archived belt survives the boot untouched.
    assert_eq!(
        std::fs::read(&fixture.session_file).expect("session bytes"),
        fixture.session_bytes,
        "the archived session file must stay byte-identical"
    );
}

/// The storm-cycle breaker, as a regression: a descriptor the supervisor
/// already gave up on (`lifecycle: failed`) never relaunches at a later
/// boot — the give-up verdict is durable (the 12:00 → 17:07 recurrence).
#[test]
fn plain_boot_never_revives_a_given_up_worker() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let busy_at = pa_daemon::util::now_iso();
    let fixture = write_revival_fixture(
        dir.path(),
        &agent_dir,
        &socket,
        "active",
        "failed",
        &busy_at,
    );

    let (_supervisor, log_path, boot_before) = boot_and_observe(&agent_dir, &socket);

    let park_line = format!(
        "session worker {} not revived: was failed at the last give-up; not revived (reopens on the next client open)",
        fixture.worker_id
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !std::fs::read_to_string(&log_path)
        .unwrap_or_default()
        .contains(&park_line)
    {
        assert!(
            Instant::now() < deadline,
            "given-up worker never parked: {park_line}; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        workers_registered_since(&log_path, &boot_before).is_empty(),
        "the given-up worker resurrected"
    );
}

/// The gate keeps the genuine case: a worker whose journal proves live
/// work that just crashed — fresh busy evidence, an active session, no
/// give-up, no lease holder — still relaunches at a plain boot (the
/// no-false-negative half of #2584's contract, driven through the same
/// captured fixture shape the park regressions use).
#[test]
fn plain_boot_still_revives_fresh_busy_evidence() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let busy_at = pa_daemon::util::now_iso();
    let fixture =
        write_revival_fixture(dir.path(), &agent_dir, &socket, "active", "ready", &busy_at);

    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);
    let boot_before = pa_daemon::util::now_iso();

    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let registered = distinct(workers_registered_since(&log_path, &boot_before));
        if registered == vec![fixture.worker_id.clone()] {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "fresh-busy worker did not revive ({boot_before}): {registered:?}; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(100));
    }

    let (mut client, _hello) = Client::connect(&socket);
    let relaunched = load_worker_descriptor(&agent_dir, &socket, &fixture.worker_id);
    client.send_command("sd", json!({ "type": "shutdown" }));
    let shutdown = client.read_response("sd");
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    let deadline = Instant::now() + Duration::from_secs(10);
    while daemon.child.try_wait().expect("try wait").is_none() {
        assert!(Instant::now() < deadline, "supervisor exited");
        std::thread::sleep(Duration::from_millis(50));
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while process_alive(relaunched.pid) {
        assert!(
            Instant::now() < deadline,
            "relaunched worker leaked after shutdown"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}
