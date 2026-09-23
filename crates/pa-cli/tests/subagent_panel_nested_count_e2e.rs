//! End-to-end verifier for the subagent panel's nested counts: a
//! two-level spawn through the real supervisor — a root session's child
//! that itself spawns a grandchild — must surface BOTH descendants on
//! every count surface. The roster rows the grandchild's worker pushes
//! carry its parent linkage, so the summary-box walk
//! (`subagents::count_descendants`, TS `countRosterSubagentStatuses` over
//! `collectSubagentDescendantSummaries`) counts the whole subtree at any
//! depth, and the agents dock's `N subagents` row aggregates the tree.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use pa_core::session_engine::rlm_host::{RlmSpawnRequest, RlmSubagentHost};
use pa_daemon::rlm_children::{ParentIdentity, SupervisorChildSessions};
use pa_daemon::supervisor_link::SupervisorLink;
use pa_tui::subagents::{count_descendants, SessionIdentity};
use serde_json::{json, Value};

struct Supervisor {
    child: Child,
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(dir: &Path) -> Supervisor {
    let socket = dir.join("daemon.sock");
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(&socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for var in [
        pa_daemon::worker::WORKER_ROLE_ENV,
        pa_daemon::worker::WORKER_TOKEN_ENV,
        pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
        pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV,
        pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
        pa_daemon::worker::WORKER_SOCKET_ENV,
        pa_daemon::worker::WORKER_INSTANCE_ID_ENV,
        pa_daemon::worker::WORKER_SCRIPT_ENV,
    ] {
        command.env_remove(var);
    }
    command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    let child = command.spawn().expect("spawn prime-agent --mode daemon");
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if socket.exists() {
            return Supervisor { child, socket };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

/// Minimal JSONL supervisor client (roster_subscribe / list).
struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> Self {
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
        let mut hello = String::new();
        let _ = client.reader.read_line(&mut hello); // daemon_hello
        client
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
        let deadline = Instant::now() + Duration::from_secs(15);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => continue,
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse response line"),
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
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(|v| v.as_str()) == Some(id) {
                return line;
            }
        }
    }

    /// The full roster snapshot (`roster_subscribe`).
    fn roster(&mut self, id: &str) -> Vec<Value> {
        self.send_command(id, json!({ "type": "roster_subscribe" }));
        let response = self.read_response(id);
        assert!(response["success"].as_bool().unwrap_or(false), "{response}");
        response["data"]["roster"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }
}

/// One scripted-response script file (the child worker's scripted engine).
fn write_script(dir: &Path, answer: &str) -> PathBuf {
    let script = dir.join("script.json");
    std::fs::write(
        &script,
        json!({ "responses": [ { "text": answer, "delayMs": 30 } ] }).to_string(),
    )
    .expect("write script");
    script
}

/// The identity of one supervisor-backed parent, keyed like the worker's
/// own engine binds it (TS `ParentIdentity`): its live active id, its
/// persisted session id, and its session file.
#[derive(Clone)]
struct Parent {
    active_session_id: String,
    session_id: String,
    session_file: String,
}

fn children_host(
    socket: &Path,
    agent_dir: &Path,
    script: &Path,
    parent: &Parent,
    depth: u32,
) -> SupervisorChildSessions {
    let sessions = SupervisorChildSessions::new(
        Arc::new(SupervisorLink::new(socket.to_path_buf())),
        agent_dir.to_path_buf(),
        parent.active_session_id.clone(),
        std::sync::Arc::new(pa_daemon::model_allowlist::ModelRefusalTelemetry::new(
            agent_dir.to_path_buf(),
            /*telemetry_disabled*/ true,
        )),
    );
    sessions.set_identity(ParentIdentity {
        rlm_depth: depth,
        rlm_max_depth: 3,
        // Off-catalog on purpose: scripted children do not resolve models.
        model: Some("scripted/faux-1".to_string()),
        cwd: Some(agent_dir.to_string_lossy().to_string()),
        session_id: Some(parent.session_id.clone()),
        session_file: Some(parent.session_file.clone()),
        thinking: None,
        child_script: Some(script.to_string_lossy().to_string()),
    });
    sessions
}

fn spawn_request(name: &str, prompt: &str) -> RlmSpawnRequest {
    RlmSpawnRequest {
        prompt: prompt.to_string(),
        name: Some(name.to_string()),
        model: None,
        thinking: None,
        cell_source_code: None,
    }
}

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

/// The summary value of one roster entry (the wire shape the TUI walks).
fn entry_summary(entry: &Value) -> &Value {
    entry.get("summary").unwrap_or(entry)
}

fn entry_field<'a>(entry: &'a Value, field: &str) -> Option<&'a str> {
    entry_summary(entry)
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

/// The parent keys of one roster entry (TS `getParentKeys`).
fn entry_parent_keys(entry: &Value) -> Vec<String> {
    [
        entry_field(entry, "parentActiveSessionId").map(|id| format!("active:{id}")),
        entry_field(entry, "parentSessionId").map(|id| format!("session:{id}")),
        entry_field(entry, "parentSessionPath").map(|file| format!("file:{file}")),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// A root session spawns a child, the child spawns a grandchild, and every
/// count surface reports the whole subtree: the roster walk the summary
/// box uses counts two descendants from the root (one from the child),
/// and the grandchild's roster row links to its parent's live ids.
#[tokio::test]
async fn a_two_level_spawn_counts_the_whole_tree() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let supervisor = spawn_supervisor(dir.path());
    let mut client = Client::connect(&supervisor.socket);
    let script = write_script(dir.path(), "child answer");
    let root = Parent {
        active_session_id: "root-active-id".to_string(),
        session_id: "root-session-uuid".to_string(),
        session_file: agent_dir.join("root.jsonl").to_string_lossy().to_string(),
    };
    let root_host = children_host(&supervisor.socket, &agent_dir, &script, &root, 0);

    // The root spawns its child (depth 1).
    let child_handle = root_host
        .spawn(spawn_request("worker-b", "ship the lane"))
        .await
        .expect("spawn child");
    root_host.notify_turn_done();

    // The child's roster row carries the live ids its own spawns key by.
    let child_row = wait_until(Duration::from_secs(15), || {
        let roster = client.roster("rs1");
        roster
            .iter()
            .find(|entry| {
                entry_field(entry, "rlmChildId") == Some(child_handle.rlm_child_id.as_str())
            })
            .cloned()
    });
    let child = Parent {
        active_session_id: entry_field(&child_row, "activeSessionId")
            .expect("child active id")
            .to_string(),
        session_id: entry_field(&child_row, "sessionId")
            .expect("child session id")
            .to_string(),
        session_file: entry_field(&child_row, "sessionFile")
            .expect("child session file")
            .to_string(),
    };

    // The child spawns its own child (the root's grandchild, depth 2),
    // through the same supervisor-backed host bound to the child's ids.
    let child_host = children_host(&supervisor.socket, &agent_dir, &script, &child, 1);
    let grandchild_handle = child_host
        .spawn(spawn_request("worker-c", "audit the lane"))
        .await
        .expect("spawn grandchild");
    child_host.notify_turn_done();

    // The grandchild's roster row appears with its parent linkage.
    let grandchild_row = wait_until(Duration::from_secs(15), || {
        let roster = client.roster("rs2");
        roster
            .iter()
            .find(|entry| {
                entry_field(entry, "rlmChildId") == Some(grandchild_handle.rlm_child_id.as_str())
            })
            .cloned()
    });
    assert_eq!(
        entry_summary(&grandchild_row)
            .get("rlmDepth")
            .and_then(Value::as_u64),
        Some(2),
        "the grandchild runs at depth 2"
    );
    let grandchild_parent_keys = entry_parent_keys(&grandchild_row);
    assert!(
        grandchild_parent_keys.contains(&format!("active:{}", child.active_session_id)),
        "the grandchild links to its parent's live id: {grandchild_parent_keys:?}"
    );
    assert!(
        grandchild_parent_keys.contains(&format!("file:{}", child.session_file)),
        "the grandchild links to its parent's session file: {grandchild_parent_keys:?}"
    );

    // The summary-box walk over the live roster counts the whole subtree:
    // the root sees both descendants, the child sees its own child.
    let roster = client.roster("rs3");
    let root_identity = SessionIdentity::new(
        Some(root.active_session_id.clone()),
        Some(root.session_id.clone()),
        Some(root.session_file.clone()),
    );
    let root_counts = count_descendants(&roster, &root_identity);
    assert_eq!(root_counts.total, 2, "one child and one grandchild");
    let child_identity = SessionIdentity::new(
        Some(child.active_session_id.clone()),
        Some(child.session_id.clone()),
        Some(child.session_file.clone()),
    );
    let child_counts = count_descendants(&roster, &child_identity);
    assert_eq!(child_counts.total, 1, "the child sees its own child");

    // Both child rows settle with their scripted answers.
    wait_until(Duration::from_secs(20), || {
        let roster = client.roster("rs4");
        let child_settled = roster.iter().any(|entry| {
            entry_field(entry, "rlmChildId") == Some(child_handle.rlm_child_id.as_str())
                && entry.get("status").and_then(Value::as_str) == Some("idle")
        });
        let grandchild_settled = roster.iter().any(|entry| {
            entry_field(entry, "rlmChildId") == Some(grandchild_handle.rlm_child_id.as_str())
                && entry.get("status").and_then(Value::as_str) == Some("idle")
        });
        child_settled
            .then_some(grandchild_settled)
            .filter(|both| *both)
    });
}
