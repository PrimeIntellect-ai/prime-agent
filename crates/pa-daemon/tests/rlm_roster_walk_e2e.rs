//! The passive-RLM roster walk at scale: a synthetic ledger with one root
//! and 1,000 spawned children (each with a persisted session file in the
//! artifacts tree, none resident) must surface the full 1,001-row roster
//! from `list --all`, performance-bounded (TS: 1,001 rows in 0.78s).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// How long `list --all` over 1,000 ledger children may take: the TS daemon
/// answers the same shape in 0.78s; the bound stays generous for CI noise.
const LIST_ALL_BOUND: Duration = Duration::from_secs(10);

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

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        self.reader
            .read_line(&mut line)
            .expect("read supervisor line");
        assert!(!line.trim().is_empty(), "supervisor closed the connection");
        serde_json::from_str(line.trim()).expect("parse supervisor line")
    }

    fn send_command(&mut self, id: &str, command: Value) -> Value {
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
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let response = self.read_line();
            if response.get("id").and_then(Value::as_str) == Some(id) {
                return response;
            }
        }
    }

    /// Send one raw supervisor line (commands whose response interleaves
    /// with event pushes; `send_command` would drop the pushes).
    fn send(&mut self, value: &Value) {
        let mut line = serde_json::to_string(value).expect("serialize line");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    /// Read one supervisor line before the deadline: the roster pushes a
    /// kill produces interleave with its response, so the reader must be
    /// bounded instead of blocking.
    fn read_line_bounded(&mut self, timeout: Duration) -> Value {
        let deadline = Instant::now() + timeout;
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set read timeout");
        loop {
            assert!(Instant::now() < deadline, "no supervisor line arrived");
            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => continue,
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse line"),
                // Would-block (EAGAIN): keep polling until the deadline.
                Err(_) if Instant::now() < deadline => {}
                Err(error) => panic!("no supervisor line arrived: {error}"),
            }
        }
    }
}

/// One persisted child session file: a header plus two messages, laid out
/// the way a spawned child persists (per-child dir under the parent's
/// session-artifacts tree).
fn write_child_session(path: &Path, id: &str, name: &str, prompt: &str) {
    std::fs::create_dir_all(path.parent().expect("child dir")).expect("child dir");
    let content = format!(
        "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"2026-09-18T00:00:00.000Z\",\"cwd\":\"/tmp\",\"parentSession\":\"/parent/file.jsonl\",\"rlmDepth\":1}}\n\
         {{\"type\":\"session_info\",\"id\":\"i1\",\"timestamp\":\"2026-09-18T00:00:01.000Z\",\"name\":\"{name}\"}}\n\
         {{\"type\":\"message\",\"id\":\"m1\",\"timestamp\":\"2026-09-18T00:00:01.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"{prompt}\",\"timestamp\":1}}}}\n\
         {{\"type\":\"message\",\"id\":\"m2\",\"timestamp\":\"2026-09-18T00:00:02.000Z\",\"message\":{{\"role\":\"assistant\",\"content\":\"child answer\",\"timestamp\":2}}}}\n"
    );
    std::fs::write(path, content).expect("write child session");
}

/// Build one synthetic family: a root session in the sessions dir plus
/// `children` ledger spawn records pointing at persisted (non-resident)
/// child files, and write the ledger file at its canonical path.
fn write_synthetic_family(agent_dir: &Path, children: usize) -> (PathBuf, usize) {
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let root_id = "root-session-1";
    let root_path = sessions_dir.join(format!("{root_id}.jsonl"));
    std::fs::write(
        &root_path,
        format!(
            "{{\"type\":\"session\",\"version\":3,\"id\":\"{root_id}\",\"timestamp\":\"2026-09-18T00:00:00.000Z\",\"cwd\":\"/tmp\"}}\n\
             {{\"type\":\"message\",\"id\":\"m1\",\"timestamp\":\"2026-09-18T00:00:01.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"root task\",\"timestamp\":1}}}}\n"
        ),
    )
    .expect("write root session");

    let mut records = String::new();
    let mut live = 0;
    for index in 0..children {
        let child_id = format!("sub-{index:04}");
        let child_path = agent_dir
            .join("session-artifacts")
            .join(root_id)
            .join(&child_id)
            .join(format!("{child_id}.jsonl"));
        write_child_session(
            &child_path,
            &child_id,
            &format!("worker-{:04}", index),
            &format!("child task {index}"),
        );
        records.push_str(
            &json!({
                "v": 1,
                "op": "spawn",
                "at": "2026-09-18T00:00:03.000Z",
                "childId": child_id,
                "parent": root_path.to_string_lossy(),
                "child": child_path.to_string_lossy(),
                "depth": 1,
                "name": format!("worker-{:04}", index),
            })
            .to_string(),
        );
        records.push('\n');
        live += 1;
    }
    let ledger_path = pa_daemon::rlm_ledger::rlm_ledger_path(agent_dir, &sessions_dir);
    std::fs::create_dir_all(ledger_path.parent().expect("ledger dir")).expect("ledger dir");
    let payload = format!(
        "{{\"v\":1,\"op\":\"meta\",\"at\":\"2026-09-18T00:00:00.000Z\",\"sessionsDir\":\"{}\"}}\n{records}",
        sessions_dir.to_string_lossy(),
    );
    std::fs::write(&ledger_path, payload).expect("write ledger");
    (root_path, live)
}

#[test]
fn list_all_returns_the_full_synthetic_thousand_child_roster() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    const CHILDREN: usize = 1_000;
    write_synthetic_family(&agent_dir, CHILDREN);
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    let started = Instant::now();
    let response = client.send_command("l1", json!({ "type": "list", "all": true }));
    let elapsed = started.elapsed();
    assert_eq!(
        response["success"], true,
        "list --all succeeded: {response}"
    );
    let sessions = response["data"]["sessions"]
        .as_array()
        .expect("list sessions array");
    assert_eq!(sessions.len(), CHILDREN + 1, "root + every ledger child");
    assert!(
        elapsed < LIST_ALL_BOUND,
        "list --all over {CHILDREN} ledger children answered in {elapsed:?}"
    );

    // The root row and one child row carry the passive-roster identity.
    let root_row = sessions
        .iter()
        .find(|row| row["sessionId"].as_str() == Some("root-session-1"))
        .expect("root row");
    assert_eq!(root_row["messageCount"], 1);
    let child_row = sessions
        .iter()
        .find(|row| row["rlmChildId"].as_str() == Some("sub-0007"))
        .expect("ledger child row");
    assert_eq!(child_row["runtimeKind"], "subagent");
    assert_eq!(child_row["sessionName"], "worker-0007");
    assert_eq!(child_row["rlmDepth"], 1);
    assert_eq!(child_row["messageCount"], 2);
    assert_eq!(
        child_row["parentSessionPath"].as_str(),
        Some(
            agent_dir
                .join("sessions")
                .join("root-session-1.jsonl")
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .as_ref()
        )
    );
}

/// TS `seedRosterLedger` parity at the subscribe surface: a child spawned
/// under a real resident parent seeds into the live roster, so a subscriber
/// that subscribes after the spawn sees the full family in the snapshot;
/// after the child worker shuts down (a plain stop, no tombstone), the
/// child survives as a seeded passive row - both in the push the existing
/// subscriber receives and in a fresh subscriber's snapshot.
#[tokio::test]
async fn subscribe_after_spawn_then_shutdown_seeds_the_passive_child() {
    use pa_core::session_engine::rlm_host::{RlmSpawnRequest, RlmSubagentHost};
    use pa_daemon::rlm_children::{ParentIdentity, SupervisorChildSessions};

    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    // The parent is a real resident session: its session file is the seed
    // root the child's ledger edge must descend from.
    let script = dir.path().join("script.json");
    std::fs::write(
        &script,
        json!({ "responses": [ { "text": "child answer", "delayMs": 20 } ] }).to_string(),
    )
    .expect("write script");
    let created = client.send_command(
        "c1",
        json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script.to_string_lossy(),
            },
        }),
    );
    assert_eq!(created["success"], true, "create failed: {created}");
    let parent_file = created["data"]["sessionFile"]
        .as_str()
        .expect("parent session file")
        .to_string();
    let parent_active_id = created["data"]["activeSessionId"]
        .as_str()
        .expect("parent active session id")
        .to_string();
    let parent_session_id = created["data"]["sessionId"]
        .as_str()
        .expect("parent session id")
        .to_string();

    // Spawn the child under the parent's real session file.
    let children = SupervisorChildSessions::new(
        std::sync::Arc::new(pa_daemon::supervisor_link::SupervisorLink::new(
            socket.clone(),
        )),
        agent_dir.clone(),
        parent_active_id.clone(),
        std::sync::Arc::new(pa_daemon::model_allowlist::ModelRefusalTelemetry::new(
            agent_dir.clone(),
            agent_dir.clone(),
            /*telemetry_disabled*/ true,
        )),
    );
    children.set_identity(ParentIdentity {
        rlm_depth: 0,
        rlm_max_depth: 2,
        model: Some("scripted/faux-1".to_string()),
        cwd: Some(agent_dir.to_string_lossy().to_string()),
        session_id: Some(parent_session_id.clone()),
        session_file: Some(parent_file.clone()),
        thinking: None,
        child_script: Some(script.to_string_lossy().to_string()),
    });
    let handle = children
        .spawn(RlmSpawnRequest {
            prompt: "ship the seed lane".to_string(),
            name: Some("worker-a".to_string()),
            model: None,
            thinking: None,
            cell_source_code: None,
        })
        .await
        .expect("spawn child");
    let child_agent_id = format!("{parent_file}#{}", handle.rlm_child_id);

    // Both rows settle as residents in the supervisor roster.
    let deadline = Instant::now() + Duration::from_secs(15);
    let child_active_id = loop {
        assert!(Instant::now() < deadline, "list never showed the child");
        let list = client.send_command("l2", json!({ "type": "list" }));
        if let Some(active_id) = list["data"]["sessions"].as_array().and_then(|sessions| {
            sessions
                .iter()
                .find(|summary| summary["rlmChildId"] == handle.rlm_child_id)
                .and_then(|summary| summary["activeSessionId"].as_str())
                .map(str::to_string)
        }) {
            break active_id;
        }
        std::thread::sleep(Duration::from_millis(50));
    };

    // Subscribe after the spawn: the snapshot carries the resident family.
    let subscribed = client.send_command("r1", json!({ "type": "roster_subscribe" }));
    assert_eq!(
        subscribed["success"], true,
        "subscribe failed: {subscribed}"
    );
    let snapshot = subscribed["data"]["roster"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let child_entry = snapshot
        .iter()
        .find(|entry| entry["agentId"] == json!(child_agent_id))
        .unwrap_or_else(|| panic!("resident child row missing: {snapshot:?}"));
    assert_eq!(child_entry["summary"]["activeSessionId"], child_active_id);
    assert_eq!(child_entry["summary"]["runtimeKind"], "subagent");
    assert_eq!(child_entry["summary"]["parentSessionPath"], parent_file);

    // Shutdown the child worker: a plain kill, no ledger tombstone. The
    // kill's pushes and its response interleave in either order on the
    // wire, so the lines are read raw and DRAINED until both the k1
    // response and the seeded passive-row push have arrived: breaking on
    // the first seeded roster row would assert a kill failure whenever
    // that push lands before the response (an ordering race, not a
    // product bug).
    client.send(&json!({
        "type": "command",
        "id": "k1",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "command": { "type": "kill", "activeSessionId": child_active_id },
    }));
    let mut kill_ok = false;
    let mut removal_seen = false;
    let mut seeded_row: Option<Value> = None;
    loop {
        let line = client.read_line_bounded(Duration::from_secs(15));
        if line["type"] == "roster_update" {
            if line["removed"]
                .as_array()
                .is_some_and(|ids| ids.contains(&json!(child_agent_id)))
            {
                removal_seen = true;
            }
            if let Some(entry) = line["changed"].as_array().and_then(|entries| {
                entries
                    .iter()
                    .find(|entry| {
                        entry["agentId"] == json!(child_agent_id) && entry["status"] == "inactive"
                    })
                    .cloned()
            }) {
                seeded_row = Some(entry);
            }
        } else if line.get("id").and_then(Value::as_str) == Some("k1") {
            kill_ok = line["success"] == true;
        }
        if kill_ok && seeded_row.is_some() {
            break;
        }
    }
    assert!(kill_ok, "kill failed");
    let seeded = seeded_row.expect("seeded passive row");
    assert!(removal_seen, "the removal push never arrived");
    let seeded_summary = &seeded["summary"];
    assert!(seeded_summary["activeSessionId"].is_null());
    assert_eq!(seeded_summary["runtimeKind"], "subagent");
    assert_eq!(seeded_summary["rlmChildId"], handle.rlm_child_id);
    assert_eq!(seeded_summary["sessionName"], "worker-a");
    assert_eq!(seeded_summary["parentSessionPath"], parent_file);
    assert_eq!(seeded_summary["messageCount"], 0);

    // A fresh subscriber sees the full family immediately: the seeded
    // child plus the still-resident parent.
    let (mut client_b, _hello_b) = Client::connect(&socket);
    let resubscribed = client_b.send_command("r2", json!({ "type": "roster_subscribe" }));
    assert_eq!(
        resubscribed["success"], true,
        "second subscribe failed: {resubscribed}"
    );
    let roster = resubscribed["data"]["roster"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let seeded_entry = roster
        .iter()
        .find(|entry| entry["agentId"] == json!(child_agent_id))
        .unwrap_or_else(|| panic!("seeded child missing from the snapshot: {roster:?}"));
    assert_eq!(seeded_entry["status"], "inactive");
    assert_eq!(seeded_entry["summary"]["messageCount"], 0);
    let parent_entry = roster
        .iter()
        .find(|entry| entry["agentId"] == json!(parent_session_id))
        .expect("parent still resident");
    assert_eq!(parent_entry["summary"]["activeSessionId"], parent_active_id);
}
