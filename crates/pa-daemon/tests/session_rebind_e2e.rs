//! End-to-end coverage of the stale active-session rebind: a worker
//! replacement supersedes the active id an attached client holds, and the
//! supervisor resolves the superseded id through the session-binding table
//! instead of failing with `Unknown active session`. Covers the
//! `session_binding` supersede event, the prompt route (admission seam
//! included), the attach route (the pane-restart path), the exactly-once
//! delivery of the rebound prompt, and the unchanged raw error for a
//! selector that never matched anything.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

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

// The timeout panic path cannot wait on the child; the test process exits
// immediately afterwards, reaping it.
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
    fn connect(socket: &std::path::Path) -> Self {
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
        let write_stream = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer: write_stream,
        };
        let hello = client.read_line();
        assert_eq!(hello["type"], "daemon_hello");
        client
    }

    fn send_command(&mut self, id: &str, command: serde_json::Value) {
        let mut line = serde_json::to_string(&serde_json::json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        }))
        .expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn read_line(&mut self) -> serde_json::Value {
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

    /// Read lines until one has the given `type`; other lines are skipped.
    fn read_line_of_type(&mut self, line_type: &str) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no {line_type} line arrived");
            let line = self.read_line();
            if line["type"] == line_type {
                return line;
            }
        }
    }

    /// Drive one prompt to its final scripted text: send, await the ack,
    /// then read streamed session events to the turn end.
    fn prompt_and_final_text(&mut self, id: &str, command: serde_json::Value) -> String {
        self.send_command(id, command);
        let mut final_text = String::new();
        let mut acked = false;
        let mut turn_ended = false;
        let deadline = Instant::now() + Duration::from_secs(20);
        while !(acked && turn_ended) {
            assert!(Instant::now() < deadline, "prompt {id} never settled");
            let line = self.read_line();
            if line.get("id").and_then(|v| v.as_str()) == Some(id) {
                assert_eq!(line["success"], true, "prompt failed: {line}");
                acked = true;
                continue;
            }
            if line["type"] == "session_event" {
                match line["event"]["type"].as_str() {
                    Some("message_end") => {
                        final_text = line["event"]["message"]["content"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string();
                    }
                    Some("turn_end") => turn_ended = true,
                    _ => {}
                }
            }
        }
        final_text
    }
}

#[test]
fn stale_active_id_rebinds_after_worker_replacement() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);

    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [
            { "text": "first scripted" },
            { "text": "second scripted" },
        ] })
        .to_string(),
    )
    .expect("write script");
    let create_config = serde_json::json!({
        "cwd": dir.path().to_string_lossy(),
        "sessionDir": agent_dir.join("sessions").to_string_lossy(),
        "script": script_path.to_string_lossy(),
    });

    // The session's first worker: create, attach, learn the durable
    // identity.
    let mut attached_client = Client::connect(&socket);
    attached_client.send_command(
        "c1",
        serde_json::json!({ "type": "create", "config": create_config }),
    );
    let created = attached_client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let created_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string();
    attached_client.send_command(
        "a1",
        serde_json::json!({ "type": "attach", "activeSessionId": created_id }),
    );
    let attached = attached_client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    // The id a pane actually holds: the attach result's active id (a
    // create-id selector resolves to the worker's current id).
    let old_id = attached["data"]["activeSessionId"]
        .as_str()
        .expect("active id in attach result")
        .to_string();
    attached_client.send_command(
        "s1",
        serde_json::json!({ "type": "get_session_stats", "activeSessionId": old_id }),
    );
    let stats = attached_client.read_response("s1");
    let session_file = stats["data"]["sessionFile"]
        .as_str()
        .expect("session file in stats")
        .to_string();

    // Forced replacement: kill the worker (registry entry and descriptor
    // gone - the give-up shape), then re-open the same session file. The
    // new worker mints a new active id over the same durable session.
    let mut driver = Client::connect(&socket);
    driver.send_command(
        "k1",
        serde_json::json!({ "type": "kill", "activeSessionId": old_id }),
    );
    let killed = driver.read_response("k1");
    assert_eq!(killed["success"], true, "kill failed: {killed}");
    driver.send_command(
        "c2",
        serde_json::json!({
            "type": "create",
            "sessionPath": session_file,
            "config": create_config,
        }),
    );
    let recreated = driver.read_response("c2");
    assert_eq!(recreated["success"], true, "re-create failed: {recreated}");
    let new_id = recreated["data"]["id"]
        .as_str()
        .or_else(|| recreated["data"]["sessionId"].as_str())
        .expect("session id in re-create response")
        .to_string();
    assert_ne!(new_id, old_id, "the replacement must mint a new active id");

    // The supersede notice reaches the client still attached to the old id.
    // The advertised id is the replacement worker's own active id (the
    // create response echoes the supervisor-side id, which may differ);
    // its routability is proven by the reattach below.
    let binding = attached_client.read_line_of_type("session_binding");
    assert_eq!(binding["previousActiveSessionId"], old_id.as_str());
    let new_active = binding["activeSessionId"]
        .as_str()
        .expect("current active id in binding event")
        .to_string();
    assert_ne!(new_active, old_id);
    assert_eq!(binding["sessionFile"].as_str(), Some(session_file.as_str()));

    // A prompt through the SUPERSEDED id (with an admission id: the
    // admission route's rebind seam) succeeds and streams its turn back to
    // this client - the rebind retargeted the connection's event routing.
    let first = attached_client.prompt_and_final_text(
        "p1",
        serde_json::json!({
            "type": "prompt",
            "activeSessionId": old_id,
            "message": "hi",
            "admissionId": "rebind-adm-1",
        }),
    );
    assert_eq!(first, "first scripted");

    // Exactly-once: the rebound prompt consumed exactly one scripted
    // response, so a follow-up prompt through the CURRENT id gets the next
    // one (a double delivery would have consumed both).
    let second = attached_client.prompt_and_final_text(
        "p2",
        serde_json::json!({
            "type": "prompt",
            "activeSessionId": new_active,
            "message": "again",
        }),
    );
    assert_eq!(second, "second scripted");

    // The pane-restart path: a fresh client attaching by the superseded id
    // lands attached to the session's current worker.
    let mut restarted_pane = Client::connect(&socket);
    restarted_pane.send_command(
        "a2",
        serde_json::json!({ "type": "attach", "activeSessionId": old_id }),
    );
    let reattached = restarted_pane.read_response("a2");
    assert_eq!(
        reattached["success"], true,
        "attach by the superseded id failed: {reattached}"
    );
    assert_eq!(reattached["data"]["activeSessionId"], new_active.as_str());

    // A selector that never matched anything keeps the raw TS error - the
    // rebind only applies to superseded ids with a live successor.
    driver.send_command(
        "p3",
        serde_json::json!({
            "type": "prompt",
            "activeSessionId": "no-such-session",
            "message": "hi",
        }),
    );
    let missing = driver.read_response("p3");
    assert_eq!(missing["success"], false);
    assert_eq!(missing["error"], "Unknown active session: no-such-session");
}
