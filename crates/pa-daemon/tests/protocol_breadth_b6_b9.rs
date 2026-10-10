//! Supervisor wire-shape tests for the protocol-breadth waves b6-b9 (roadmap
//! item 7): every new command rides the real supervisor + worker over the
//! socket and answers the exact TS wire shape (success and error paths).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
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

// The timeout panic path cannot wait on the child; the test process exits and reaps it.
#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &std::path::Path, agent_dir: &std::path::Path) -> Daemon {
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let child = Command::new(binary)
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // A supervisor killed at teardown must not leak its session workers: the worker's
        // supervisor-lost exit (TS `exitIfSupervisorOrphanedForTooLong`) runs on this short
        // window, not the 5-minute default.
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

#[allow(dead_code)]
impl Client {
    fn connect(socket: &std::path::Path) -> (Self, serde_json::Value) {
        // A previous supervisor in this fixture is force-killed at block exit.
        // Its renewable lock must become stale (5s) before the next holder
        // reclaims the socket; wait through the full acquisition retry budget.
        let deadline = Instant::now() + Duration::from_secs(20);
        let stream = loop {
            match UnixStream::connect(socket) {
                Ok(stream) => break stream,
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("connect supervisor: {error}"),
            }
        };
        let write_stream = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer: write_stream,
        };
        let hello = client.read_line();
        (client, hello)
    }

    fn send(&mut self, value: &serde_json::Value) {
        let mut line = serde_json::to_string(value).expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn send_command(&mut self, id: &str, command: &serde_json::Value) {
        self.send(&serde_json::json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        }));
    }

    fn read_line(&mut self) -> serde_json::Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(15);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => line.clear(),
                Ok(_) => {
                    return serde_json::from_str(line.trim()).expect("parse response line");
                }
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for supervisor line: {error}"
                    );
                }
            }
        }
    }

    fn read_response(&mut self, id: &str) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(|v| v.as_str()) == Some(id) {
                return line;
            }
        }
    }

    /// Read until the response for `id`, buffering the outbound lines seen first:
    /// the daemon emits events before the command reply (TS order).
    fn read_response_and_lines(
        &mut self,
        id: &str,
    ) -> (
        serde_json::Value,
        std::collections::VecDeque<serde_json::Value>,
    ) {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut lines = std::collections::VecDeque::new();
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(|v| v.as_str()) == Some(id) {
                return (line, lines);
            }
            lines.push_back(line);
        }
    }

    /// The first buffered-or-live outbound line of `line_type`; other types stay buffered or are
    /// skipped.
    fn next_line_of_type(
        &mut self,
        lines: &mut std::collections::VecDeque<serde_json::Value>,
        line_type: &str,
    ) -> serde_json::Value {
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

    fn take_session_event(
        &mut self,
        lines: &mut std::collections::VecDeque<serde_json::Value>,
        event_type: &str,
    ) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no {event_type} event arrived");
            let line = self.next_line_of_type(lines, "session_event");
            if line["event"]["type"] == event_type {
                return line["event"].clone();
            }
        }
    }
}

/// The wave tests spawn real process trees; one daemon tree runs at a time
/// (a binary's tests otherwise race each other's startup windows).
static SERIAL: Mutex<()> = Mutex::new(());

fn serial_lock() -> std::sync::MutexGuard<'static, ()> {
    match SERIAL.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Create one scripted session; returns (daemon, client, session id, socket path).
fn scripted_session(
    dir: &std::path::Path,
    agent_dir: &std::path::Path,
) -> (Daemon, Client, String, std::path::PathBuf) {
    let socket = dir.join("daemon.sock");
    let daemon = spawn_daemon(&socket, agent_dir);
    let (mut client, _hello) = Client::connect(&socket);
    let script_path = dir.join("script.json");
    std::fs::write(
        &script_path,
        json!({ "responses": [ { "text": "ack", "delayMs": 10 } ] }).to_string(),
    )
    .expect("write script");
    client.send_command(
        "create-1",
        &json!({
            "type": "create",
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("create-1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    (daemon, client, session_id, socket)
}

#[test]
fn wave_b6_rlm_surface_wire_shapes() {
    let _serial = serial_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let (_daemon, mut client, session_id, _socket) = scripted_session(dir.path(), &agent_dir);

    client.send_command(
        "r1",
        &json!({ "type": "cancel_rlm_child", "activeSessionId": session_id, "childId": "ghost" }),
    );
    let response = client.read_response("r1");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"], json!({ "cancelled": false }));

    client.send_command(
        "r2",
        &json!({ "type": "delete_rlm_subagent", "activeSessionId": session_id, "childId": "ghost" }),
    );
    let response = client.read_response("r2");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"], json!({ "deleted": false }));

    client.send_command(
        "r3",
        &json!({ "type": "set_rlm_max_depth", "activeSessionId": session_id, "maxDepth": 3 }),
    );
    let response = client.read_response("r3");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(
        response["data"],
        json!({ "maxDepth": 3, "source": "chat", "globalSaved": false })
    );
}

#[test]
fn wave_b7_agent_messages_wire_shapes() {
    let _serial = serial_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");

    {
        let socket = dir.path().join("daemon.sock");
        let _daemon = spawn_daemon(&socket, &agent_dir);
        let (mut client, _hello) = Client::connect(&socket);
        client.send_command("s0", &json!({ "type": "agent_messages_status" }));
        let response = client.read_response("s0");
        assert_eq!(response["success"], true, "{response}");
        assert_eq!(response["data"], json!({ "paused": false, "limits": {} }));

        client.send_command("p0", &json!({ "type": "agent_messages_pause" }));
        let response = client.read_response("p0");
        assert_eq!(response["success"], true, "{response}");
        assert_eq!(response["data"], Value::Null);
    }

    {
        let (_daemon, mut client, session_id, _socket) = scripted_session(dir.path(), &agent_dir);
        client.send_command("s1", &json!({ "type": "agent_messages_status" }));
        let response = client.read_response("s1");
        assert_eq!(response["success"], true, "{response}");
        assert_eq!(
            response["data"],
            json!({
                "paused": false,
                "maxMessageChars": 16384,
                "maxPendingPerSession": 20,
                "rateLimitCapacity": 3,
                "rateLimitRefillMs": 1000,
            })
        );

        client.send_command("p1", &json!({ "type": "agent_messages_pause" }));
        let response = client.read_response("p1");
        assert_eq!(response["success"], true, "{response}");
        assert_eq!(response["data"]["paused"], json!(true));

        client.send_command(
            "m1",
            &json!({
                "type": "send_message",
                "targetActiveSessionId": session_id,
                "message": "while paused",
            }),
        );
        let response = client.read_response("m1");
        assert_eq!(response["success"], false, "{response}");
        assert_eq!(response["error"], "Agent messaging is paused");

        client.send_command("r1", &json!({ "type": "agent_messages_resume" }));
        let response = client.read_response("r1");
        assert_eq!(response["success"], true, "{response}");
        assert_eq!(response["data"]["paused"], json!(false));

        client.send_command(
            "m2",
            &json!({
                "type": "send_message",
                "targetActiveSessionId": session_id,
                "message": "hello again",
            }),
        );
        let response = client.read_response("m2");
        assert_eq!(response["success"], true, "{response}");
        client.send_command(
            "c1",
            &json!({ "type": "agent_messages_clear", "activeSessionId": session_id }),
        );
        let response = client.read_response("c1");
        assert_eq!(response["success"], true, "{response}");
        // The delivered message already started its turn (the session was idle), so
        // nothing is queued to clear — TS clears queued agent messages only.
        assert_eq!(response["data"], json!({ "steering": [], "followUp": [] }));
    }
}

#[test]
fn wave_b8_session_input_pause_wire_shapes() {
    let _serial = serial_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let (_daemon, mut client, session_id, _socket) = scripted_session(dir.path(), &agent_dir);

    client.send_command(
        "pa-0",
        &json!({ "type": "acquire_session_input_pause", "activeSessionId": "bogus-1", "leaseKey": "k" }),
    );
    let response = client.read_response("pa-0");
    assert_eq!(response["success"], false, "{response}");
    assert_eq!(response["error"], "Unknown active session: bogus-1");

    // Acquire answers `{ pauseId }`; the identical lease deduplicates to the same pause id.
    client.send_command(
        "pa-1",
        &json!({ "type": "acquire_session_input_pause", "activeSessionId": session_id, "leaseKey": "lease-a" }),
    );
    let response = client.read_response("pa-1");
    assert_eq!(response["success"], true, "{response}");
    let pause_id = response["data"]["pauseId"]
        .as_str()
        .expect("pause id")
        .to_string();
    assert!(!pause_id.is_empty());

    client.send_command(
        "pa-2",
        &json!({ "type": "acquire_session_input_pause", "activeSessionId": session_id, "leaseKey": "lease-a" }),
    );
    let response = client.read_response("pa-2");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"]["pauseId"], json!(pause_id));

    client.send_command(
        "pa-3",
        &json!({ "type": "release_session_input_pause", "activeSessionId": "other-session", "pauseId": pause_id }),
    );
    let response = client.read_response("pa-3");
    assert_eq!(response["success"], false, "{response}");
    assert_eq!(
        response["error"],
        format!("Session input pause belongs to another session: {pause_id}")
    );

    client.send_command(
        "pa-4",
        &json!({ "type": "release_session_input_pause", "activeSessionId": session_id, "pauseId": pause_id }),
    );
    let response = client.read_response("pa-4");
    assert_eq!(response["success"], true, "{response}");
    client.send_command(
        "pa-5",
        &json!({ "type": "release_session_input_pause", "activeSessionId": session_id, "pauseId": pause_id }),
    );
    let response = client.read_response("pa-5");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"], Value::Null);
}

#[test]
fn wave_b8_held_pause_gates_queued_input() {
    let _serial = serial_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");

    // A scripted session with one slow reply: the first turn stays busy so a queued steer stays
    // queued.
    let socket = dir.path().join("daemon2.sock");
    let daemon = spawn_daemon(&socket, &agent_dir);
    let _ = &daemon;
    let (mut client, _hello) = Client::connect(&socket);
    let script_path = dir.path().join("slow-script.json");
    std::fs::write(
        &script_path,
        json!({ "responses": [
            { "text": "slow", "delayMs": 400 },
            { "text": "second", "delayMs": 10 },
        ] })
        .to_string(),
    )
    .expect("write script");
    client.send_command(
        "create-1",
        &json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("create-1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();

    client.send_command(
        "p-1",
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": "go" }),
    );
    let _ = client.read_response("p-1");
    client.send_command(
        "s-1",
        &json!({ "type": "steer", "activeSessionId": session_id, "message": "queued text" }),
    );
    let response = client.read_response("s-1");
    assert_eq!(response["success"], true, "{response}");

    // Acquire the pause while the turn runs; the queued steer must not start:
    // after the first turn settles, the queue keeps one item.
    client.send_command(
        "pa-1",
        &json!({ "type": "acquire_session_input_pause", "activeSessionId": session_id, "leaseKey": "gate" }),
    );
    let response = client.read_response("pa-1");
    assert_eq!(response["success"], true, "{response}");
    let pause_id = response["data"]["pauseId"]
        .as_str()
        .expect("pause id")
        .to_string();

    // Wait out the first turn (`wait_for_idle` would block by design on a
    // paused queue), then check the queue still holds the item.
    std::thread::sleep(Duration::from_millis(700));
    client.send_command(
        "q-1",
        &json!({ "type": "get_queue", "activeSessionId": session_id }),
    );
    let response = client.read_response("q-1");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(
        response["data"]["steering"],
        json!(["queued text"]),
        "the queued steer stays held behind the pause: {response}"
    );

    client.send_command(
        "pa-2",
        &json!({ "type": "release_session_input_pause", "activeSessionId": session_id, "pauseId": pause_id }),
    );
    let response = client.read_response("pa-2");
    assert_eq!(response["success"], true, "{response}");
    client.send_command(
        "w-2",
        &json!({ "type": "wait_for_idle", "activeSessionId": session_id }),
    );
    let response = client.read_response("w-2");
    assert_eq!(response["success"], true, "{response}");
    client.send_command(
        "q-2",
        &json!({ "type": "get_queue", "activeSessionId": session_id }),
    );
    let response = client.read_response("q-2");
    assert_eq!(response["data"]["steering"], json!([]), "{response}");
}

#[test]
fn wave_b9_session_navigation_wire_shapes() {
    let _serial = serial_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let (_daemon, mut client, session_id, _socket) = scripted_session(dir.path(), &agent_dir);

    client.send_command(
        "n-1",
        &json!({ "type": "new_session", "activeSessionId": session_id }),
    );
    let response = client.read_response("n-1");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"], json!({ "cancelled": false }));

    client.send_command(
        "i-0",
        &json!({ "type": "import_jsonl", "activeSessionId": session_id, "inputPath": "/tmp/no-such-import.jsonl" }),
    );
    let response = client.read_response("i-0");
    assert_eq!(response["success"], false, "{response}");
    assert_eq!(
        response["error"],
        "File not found: /tmp/no-such-import.jsonl"
    );

    let imported = dir.path().join("imported.jsonl");
    std::fs::write(
        &imported,
        concat!(
            r#"{"type":"session","id":"imported-1","timestamp":"2026-01-01T00:00:00Z","cwd":"","version":1}"#, "\n",
            r#"{"type":"message","id":"m1","message":{"role":"user","content":[{"type":"text","text":"imported question"}]}}"#, "\n",
        ),
    )
    .expect("write import");
    client.send_command(
        "i-1",
        &json!({ "type": "import_jsonl", "activeSessionId": session_id, "inputPath": imported.to_string_lossy() }),
    );
    let response = client.read_response("i-1");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"], json!({ "cancelled": false }));

    client.send_command(
        "s-1",
        &json!({ "type": "switch_session", "activeSessionId": session_id, "sessionPath": imported.to_string_lossy() }),
    );
    let response = client.read_response("s-1");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"], json!({ "cancelled": false }));
    client.send_command(
        "s-2",
        &json!({ "type": "switch_session", "activeSessionId": session_id, "sessionPath": "/tmp/missing-switch.jsonl" }),
    );
    let response = client.read_response("s-2");
    assert_eq!(response["success"], false, "{response}");
}

#[test]
fn wave_b9_prompt_admission_wire_shapes() {
    let _serial = serial_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");

    // A slow scripted session: the first turn stays busy so an admitted prompt queues behind it
    // (the deterministic cancel window).
    let socket = dir.path().join("adm.sock");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);
    let script_path = dir.path().join("slow.json");
    std::fs::write(
        &script_path,
        json!({ "responses": [
            { "text": "slow", "delayMs": 400 },
            { "text": "second", "delayMs": 10 },
        ] })
        .to_string(),
    )
    .expect("write script");
    client.send_command(
        "create-1",
        &json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("create-1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();

    client.send_command(
        "c-0",
        &json!({ "type": "cancel_prompt_admission", "activeSessionId": session_id, "admissionId": "never-registered" }),
    );
    let response = client.read_response("c-0");
    assert_eq!(response["data"], json!({ "status": "unknown" }));

    client.send_command(
        "p-0",
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": "x", "admissionId": "" }),
    );
    let response = client.read_response("p-0");
    assert_eq!(response["success"], false, "{response}");
    assert_eq!(response["command"], "parse");
    assert_eq!(response["error"], "admissionId must not be empty");

    client.send_command(
        "p-1",
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": "go" }),
    );
    let _ = client.read_response("p-1");
    // `prompt_and_wait` keeps its admission open for the whole turn (the route deletes
    // it when the turn settles), so the queued admitted prompt is in its cancel window.
    client.send_command(
        "p-2",
        &json!({ "type": "prompt_and_wait", "activeSessionId": session_id, "message": "queued behind", "admissionId": "adm-1" }),
    );
    // Give the admitted prompt's route its start: TS registers an admission at parse
    // time; this port registers in the dispatch task, so the cancel must not race it.
    std::thread::sleep(Duration::from_millis(100));

    // The queued prompt committed at admission: cancelOwned withdraws
    // that item without aborting the unrelated slow turn.
    client.send_command(
        "c-1",
        &json!({ "type": "cancel_prompt_admission", "activeSessionId": session_id, "admissionId": "adm-1", "cancelOwned": true }),
    );
    // The cancelled wait's failure response may land before the cancel's own response
    // (the dropped queue item settles the wait), so the read buffers instead of dropping.
    let (response, mut lines) = client.read_response_and_lines("c-1");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"], json!({ "status": "owned" }));
    // The cancelled prompt_and_wait fails its wait (the dropped queue item
    // never completes).
    let response = match lines
        .iter()
        .position(|line| line.get("id").and_then(|v| v.as_str()) == Some("p-2"))
    {
        Some(index) => lines.remove(index).expect("buffered p-2 response"),
        None => client.read_response("p-2"),
    };
    assert_eq!(response["success"], false, "{response}");

    std::thread::sleep(Duration::from_millis(700));
    client.send_command(
        "q-1",
        &json!({ "type": "get_queue", "activeSessionId": session_id }),
    );
    let response = client.read_response("q-1");
    assert_eq!(response["data"]["steering"], json!([]), "{response}");
    assert_eq!(response["data"]["followUp"], json!([]), "{response}");

    // A non-wait prompt's public admission ends when its success response
    // lands, even if its queued turn has not run yet (TS prompt lifetime).
    client.send_command(
        "p-3",
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": "non-wait", "admissionId": "adm-3" }),
    );
    let response = client.read_response("p-3");
    assert_eq!(response["success"], true, "{response}");
    client.send_command(
        "c-3",
        &json!({ "type": "cancel_prompt_admission", "activeSessionId": session_id, "admissionId": "adm-3", "cancelOwned": true }),
    );
    let response = client.read_response("c-3");
    assert_eq!(response["data"], json!({ "status": "unknown" }));

    // A cancel for a fresh id answers `unknown` (nothing registered).
    client.send_command(
        "c-2",
        &json!({ "type": "cancel_prompt_admission", "activeSessionId": session_id, "admissionId": "adm-2" }),
    );
    let response = client.read_response("c-2");
    assert_eq!(response["data"], json!({ "status": "unknown" }));
}

#[test]
fn wave_b9_owned_session_lifecycle_wire_shapes() {
    let _serial = serial_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let socket = dir.path().join("daemon.sock");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        json!({ "responses": [ { "text": "ack", "delayMs": 10 } ] }).to_string(),
    )
    .expect("write script");
    client.send_command(
        "create-1",
        &json!({
            "type": "create",
            "lifecycle": "client_owned",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("create-1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();

    client.send_command(
        "pr-1",
        &json!({ "type": "promote_owned_session", "activeSessionId": session_id }),
    );
    let response = client.read_response("pr-1");
    assert_eq!(response["success"], true, "{response}");
    assert!(response["data"]["id"].is_string(), "{response}");

    let (mut foreign, _hello) = Client::connect(&socket);
    foreign.send_command(
        "pr-2",
        &json!({ "type": "promote_owned_session", "activeSessionId": session_id }),
    );
    let response = foreign.read_response("pr-2");
    assert_eq!(response["success"], false, "{response}");
    assert_eq!(response["error"], "Session is not owned by this client");

    client.send_command(
        "pr-3",
        &json!({ "type": "promote_owned_session", "activeSessionId": session_id }),
    );
    let response = client.read_response("pr-3");
    assert_eq!(response["success"], true, "{response}");
    assert!(response["data"]["id"].is_string(), "{response}");

    // retry_worker on the live session answers the summary (the audit's fix: the supervisor arm,
    // not the worker route).
    client.send_command(
        "rt-1",
        &json!({ "type": "retry_worker", "activeSessionId": session_id }),
    );
    let response = client.read_response("rt-1");
    assert_eq!(response["success"], true, "{response}");
    assert!(response["data"]["id"].is_string(), "{response}");

    client.send_command(
        "co-1",
        &json!({ "type": "complete_owned_session", "activeSessionId": session_id }),
    );
    let response = client.read_response("co-1");
    assert_eq!(response["success"], false, "{response}");
    assert_eq!(response["error"], "Session is not owned by this client");
}
