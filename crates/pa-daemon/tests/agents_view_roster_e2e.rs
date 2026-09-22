//! End-to-end verifier for the agent-roster wire protocol: a subscriber's
//! `roster_subscribe` snapshot, the live `roster_update` pushes a turn
//! produces (running on the busy flip, idle at settle), and the removal
//! push when the worker stops. The supervisor is the real binary driving a
//! scripted worker, so the deltas exercise the full worker->supervisor
//! roster push path.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
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

#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &Path, agent_dir: &Path) -> Daemon {
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
    fn connect(socket: &Path) -> (Self, serde_json::Value) {
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
        (client, hello)
    }

    fn send(&mut self, value: &serde_json::Value) {
        let mut line = serde_json::to_string(value).expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn send_command(&mut self, id: &str, command: serde_json::Value) {
        self.send(&serde_json::json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        }));
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
                    assert!(Instant::now() < deadline, "timed out reading: {error}");
                }
            }
        }
    }

    fn read_response(&mut self, id: &str) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(|v| v.as_str()) == Some(id) {
                return line;
            }
        }
    }

    /// The first `roster_update` line that satisfies `accept` (live or
    /// buffered through the read loop, like a subscribed view).
    fn next_roster_update<F>(&mut self, accept: F) -> serde_json::Value
    where
        F: Fn(&serde_json::Value) -> bool,
    {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(
                Instant::now() < deadline,
                "no matching roster_update arrived"
            );
            let line = self.read_line();
            if line["type"] == "roster_update" && accept(&line) {
                return line;
            }
        }
    }
}

#[test]
fn roster_subscribe_snapshot_and_live_update_pushes() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    // Create a scripted session; the worker joins the roster at creation.
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [
            { "text": "turn one", "delayMs": 60 },
        ] })
        .to_string(),
    )
    .expect("write script");
    client.send_command(
        "c1",
        serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();

    // Subscribe: the snapshot carries the session as an idle roster entry.
    client.send_command("r1", serde_json::json!({ "type": "roster_subscribe" }));
    let subscribed = client.read_response("r1");
    assert_eq!(
        subscribed["success"], true,
        "subscribe failed: {subscribed}"
    );
    let roster = subscribed["data"]["roster"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let entry = roster
        .iter()
        .find(|entry| entry["summary"]["activeSessionId"] == session_id.as_str())
        .unwrap_or_else(|| panic!("created session in the roster snapshot: {roster:?}"));
    // Top-level agents key by session id; the active id is the wire address.
    assert_eq!(entry["agentId"], entry["summary"]["sessionId"]);
    assert_eq!(entry["status"], "idle");
    let agent_id = entry["agentId"].as_str().expect("agent id").to_string();

    // A turn flips the entry to running and back to idle, both as live
    // pushes to subscribers. The pushes travel worker->supervisor->client
    // while the prompt response rides the command channel, so their order
    // is not fixed; collect all three observations in whatever order they
    // arrive.
    client.send_command(
        "p1",
        serde_json::json!({
            "type": "prompt_and_wait",
            "activeSessionId": session_id,
            "message": "go",
        }),
    );
    let mut saw_running = false;
    let mut saw_idle = false;
    let mut prompt_response = None;
    while !saw_idle || prompt_response.is_none() {
        let line = client.read_line();
        if line["type"] == "roster_update" {
            if line["removed"]
                .as_array()
                .is_some_and(|ids| !ids.is_empty())
            {
                panic!("no removals during a turn: {line}");
            }
            for entry in line["changed"].as_array().cloned().unwrap_or_default() {
                let mine = entry["summary"]["activeSessionId"] == session_id.as_str();
                if mine && entry["status"] == "running" {
                    saw_running = true;
                }
                if mine && entry["status"] == "idle" {
                    saw_idle = true;
                }
            }
        }
        if line.get("id").and_then(serde_json::Value::as_str) == Some("p1") {
            prompt_response = Some(line);
        }
    }
    assert!(saw_running, "the busy flip pushed a running status");
    let settled = prompt_response.expect("p1 response observed");
    assert_eq!(settled["success"], true, "prompt failed: {settled}");

    // Unsubscribe: no further roster pushes reach this client. A second
    // subscriber keeps receiving them, proving the flag gates delivery.
    let (mut client_b, _hello_b) = Client::connect(&socket);
    client_b.send_command("r2", serde_json::json!({ "type": "roster_subscribe" }));
    assert_eq!(client_b.read_response("r2")["success"], true);
    client.send_command("u1", serde_json::json!({ "type": "roster_unsubscribe" }));
    assert_eq!(client.read_response("u1")["success"], true);

    // Stopping the session removes the entry and pushes the removal.
    client.send_command(
        "k1",
        serde_json::json!({ "type": "kill", "activeSessionId": session_id }),
    );
    let stopped = client.read_response("k1");
    assert_eq!(stopped["success"], true, "kill failed: {stopped}");
    // Removal pushes key by the roster agent id (TS `rosterAgentIdForSummary`
    // = session id), not the active/worker id the commands address.
    let removed_update = client_b.next_roster_update(|line| {
        line["removed"]
            .as_array()
            .map(|ids| ids.iter().any(|id| id == agent_id.as_str()))
            .unwrap_or(false)
    });
    // TS always carries `changed` (empty for a removal-only push) and
    // omits `removed` when there are no removals.
    assert_eq!(
        removed_update["changed"],
        serde_json::json!([]),
        "removal-only push: {removed_update}"
    );
}

#[test]
fn worker_roster_delta_requires_authentication() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);
    client.send_command(
        "w1",
        serde_json::json!({
            "type": "worker_roster_delta",
            "workerToken": "not-a-real-token",
            "summary": { "sessionId": "s-forged", "activeSessionId": "a-forged" },
        }),
    );
    let rejected = client.read_response("w1");
    assert_eq!(rejected["success"], false, "forged token must be rejected");
    assert_eq!(rejected["error"], "Worker authentication failed");
}

/// Family-depth roster rows: a supervisor-backed RLM child (one supervised
/// worker per child) joins the roster keyed `parentSessionPath#childId`
/// (TS `rosterAgentIdForSummary`), carrying the subagent identity fields the
/// agents view and ACP subagent metas consume; deleting the child pushes the
/// removal under that same key. The parent identity mirrors the
/// `rlm_children` e2e harness: a scripted child over the supervisor link.
#[tokio::test]
async fn rlm_children_key_the_roster_by_parent_path_and_child_id() {
    use pa_core::session_engine::rlm_host::{RlmSpawnRequest, RlmSubagentHost};
    use pa_daemon::rlm_children::{ParentIdentity, SupervisorChildSessions};

    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let log = std::fs::File::create(dir.path().join("daemon.log")).expect("log file");
    // Underscore keeps the kill guard alive for the test's scope.
    let _daemon = {
        #[allow(clippy::zombie_processes)]
        let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
            .arg("supervisor")
            .arg("--socket")
            .arg(&socket)
            .arg("--agent-dir")
            .arg(&agent_dir)
            .env("RUST_LOG", "pa_daemon=debug")
            .stdout(log)
            .stderr(Stdio::inherit())
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
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        struct LoggedDaemon(Child);
        impl Drop for LoggedDaemon {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        LoggedDaemon(child)
    };
    let (mut client, _hello) = Client::connect(&socket);

    let script = dir.path().join("script.json");
    std::fs::write(
        &script,
        serde_json::json!({ "responses": [ { "text": "child done", "delayMs": 20 } ] }).to_string(),
    )
    .expect("write script");
    let parent_file = agent_dir.join("parent.jsonl");
    let children = SupervisorChildSessions::new(
        std::sync::Arc::new(pa_daemon::supervisor_link::SupervisorLink::new(
            socket.clone(),
        )),
        agent_dir.clone(),
        "parent-active-id".to_string(),
    );
    children.set_identity(ParentIdentity {
        rlm_depth: 0,
        rlm_max_depth: 2,
        model: Some("scripted/faux-1".to_string()),
        cwd: Some(agent_dir.to_string_lossy().to_string()),
        session_id: Some("parent-session-uuid".to_string()),
        session_file: Some(parent_file.to_string_lossy().to_string()),
        thinking: None,
        child_script: Some(script.to_string_lossy().to_string()),
    });

    let handle = children
        .spawn(RlmSpawnRequest {
            prompt: "ship the roster lane".to_string(),
            name: Some("child-a".to_string()),
            model: None,
            thinking: None,
            cell_source_code: None,
        })
        .await
        .expect("spawn child");

    // The roster snapshot keys the child `parentSessionPath#childId`.
    client.send_command("r1", serde_json::json!({ "type": "roster_subscribe" }));
    let subscribed = client.read_response("r1");
    assert_eq!(
        subscribed["success"], true,
        "subscribe failed: {subscribed}"
    );
    let child_agent_id = format!("{}#{}", parent_file.to_string_lossy(), handle.rlm_child_id);
    let roster = subscribed["data"]["roster"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let child_entry = roster
        .iter()
        .find(|entry| entry["agentId"] == serde_json::Value::String(child_agent_id.clone()))
        .unwrap_or_else(|| panic!("child keyed by parent path: {roster:?}"));
    let summary = &child_entry["summary"];
    assert_eq!(summary["runtimeKind"], "subagent");
    assert_eq!(summary["rlmChildId"], handle.rlm_child_id);
    assert_eq!(
        summary["parentSessionPath"],
        parent_file.to_string_lossy().to_string()
    );
    assert_eq!(summary["parentActiveSessionId"], "parent-active-id");
    assert_eq!(summary["rlmDepth"], 1);
    assert_eq!(summary["sessionName"], "child-a");

    // A second subscriber (the agents view pattern) sees the live delta of
    // the child's next turn under the same key. The child's spawn turn runs
    // before this subscribe, so wait for it to settle first.
    let child_active_id = child_entry["summary"]["activeSessionId"]
        .as_str()
        .expect("child active session id")
        .to_string();
    client.send_command(
        "w1",
        serde_json::json!({
            "type": "wait_for_idle",
            "activeSessionId": child_active_id,
        }),
    );
    assert_eq!(
        client.read_response("w1")["success"],
        true,
        "wait_for_idle failed"
    );
    let (mut client_b, _hello_b) = Client::connect(&socket);
    client_b.send_command("r2", serde_json::json!({ "type": "roster_subscribe" }));
    assert_eq!(client_b.read_response("r2")["success"], true);
    client.send_command(
        "p1",
        serde_json::json!({
            "type": "prompt",
            "activeSessionId": child_active_id,
            "message": "go",
        }),
    );
    let _ = client.read_response("p1");
    let update = client_b.next_roster_update(|line| {
        line["changed"]
            .as_array()
            .map(|entries| {
                entries.iter().any(|entry| {
                    entry["agentId"] == serde_json::Value::String(child_agent_id.clone())
                })
            })
            .unwrap_or(false)
    });
    let changed = update["changed"].as_array().cloned().unwrap_or_default();
    let changed_child = changed
        .iter()
        .find(|entry| entry["agentId"] == serde_json::Value::String(child_agent_id.clone()))
        .expect("child delta under the family key");
    assert!(
        changed_child["status"] == "running" || changed_child["status"] == "idle",
        "live status under the family key: {changed_child}"
    );

    // Deleting the child pushes the removal keyed by the same agent id.
    children
        .delete_subagent(handle.rlm_child_id.clone())
        .await
        .expect("delete child");
    let removal = client_b.next_roster_update(|line| {
        line["removed"]
            .as_array()
            .map(|ids| ids.contains(&serde_json::Value::String(child_agent_id.clone())))
            .unwrap_or(false)
    });
    assert!(
        removal["removed"]
            .as_array()
            .is_some_and(|ids| ids.contains(&serde_json::Value::String(child_agent_id.clone()))),
        "removal keyed by the family id: {removal}"
    );
}
