//! End-to-end RLM child machinery against the real `pa-daemon` supervisor:
//! supervisor-backed child sessions spawn through the supervisor link, run
//! in their own worker processes, appear in the supervisor roster, settle
//! with an answer the parent roster surfaces, and die on delete
//! (`rlm.spawn` / `rlm.list_subagents` / `rlm.collect` /
//! `rlm.delete_subagent` / `rlm.create_session` host surface).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use pa_core::session_engine::rlm_host::{
    RlmCreateSessionRequest, RlmSpawnRequest, RlmSubagentHost,
};
use pa_daemon::rlm_children::{ParentIdentity, SupervisorChildSessions};
use pa_daemon::supervisor_link::SupervisorLink;
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

// The timeout panic path cannot wait on the child; the test process exits
// immediately afterwards, reaping it.
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

/// Minimal JSONL supervisor client (list / kill / get_last_assistant_text).
struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> (Self, Value) {
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
        self.read_line_with_budget(Duration::from_secs(15))
    }

    /// `read_line` with a caller-chosen budget: a raw `create` that
    /// launches a worker answers after the worker's connect budget (TS
    /// `WORKER_CONNECT_TIMEOUT_MS`: up to 30s), which the shared 15s line
    /// budget turns into a false timeout under the binary's
    /// parallel-test load.
    fn read_line_with_budget(&mut self, budget: Duration) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + budget;
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

    /// `read_response` with a worker-boot budget (the raw-create path's
    /// reader): every line waits on the remaining wall budget, so a
    /// worker-launching create answers inside the same window the host's
    /// `CREATE_TIMEOUT_MS` covers.
    fn read_response_slow(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "no response for id {id}");
            let line = self.read_line_with_budget(remaining);
            if line.get("id").and_then(|v| v.as_str()) == Some(id) {
                return line;
            }
        }
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

/// Children registry bound to the running supervisor, with a parent identity
/// rooted at `agent_dir`.
async fn children(
    socket: &Path,
    agent_dir: &Path,
    script: &Path,
    depth: u32,
) -> SupervisorChildSessions {
    let sessions = SupervisorChildSessions::new(
        Arc::new(SupervisorLink::new(socket.to_path_buf())),
        agent_dir.to_path_buf(),
        "parent-active-id".to_string(),
        std::sync::Arc::new(pa_daemon::model_allowlist::ModelRefusalTelemetry::new(
            agent_dir.to_path_buf(),
            /*telemetry_disabled*/ true,
        )),
    );
    sessions.set_identity(ParentIdentity {
        rlm_depth: depth,
        rlm_max_depth: 2,
        // Off-catalog on purpose: scripted children do not resolve models.
        model: Some("scripted/faux-1".to_string()),
        cwd: Some(agent_dir.to_string_lossy().to_string()),
        session_id: Some("parent-session-uuid".to_string()),
        session_file: Some(agent_dir.join("parent.jsonl").to_string_lossy().to_string()),
        thinking: None,
        child_script: Some(script.to_string_lossy().to_string()),
    });
    sessions
}

/// Poll a sync probe (JSONL supervisor client) until it yields a value.
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

fn spawn_request(name: &str, prompt: &str) -> RlmSpawnRequest {
    RlmSpawnRequest {
        prompt: prompt.to_string(),
        name: Some(name.to_string()),
        model: None,
        thinking: None,
        cell_source_code: None,
    }
}

/// Spawn a child through the supervisor, observe it in both rosters, collect
/// its answer, then delete it and watch the supervisor roster drop it.
#[tokio::test]
async fn rlm_children_spawn_roster_collect_delete_end_to_end() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    let script = write_script(dir.path(), "child answer");
    let children = children(&socket, &agent_dir, &script, 0).await;

    // Spawn: one child worker session created through the supervisor.
    let handle = children
        .spawn(spawn_request("worker-a", "ship the lane"))
        .await
        .expect("spawn");
    // The registry sits outside a live worker turn here: release the
    // detached task prompt at the boundary the worker would signal.
    children.notify_turn_done();
    assert_eq!(handle.name, "worker-a");
    assert!(handle.rlm_child_id.starts_with("sub-"), "{handle:?}");
    assert_eq!(handle.model, "scripted/faux-1");
    // TS child-session layout: the child persists inside its per-child
    // directory under the parent's session-artifacts tree.
    let expected_dir = agent_dir
        .join("session-artifacts")
        .join("parent-session-uuid")
        .join(&handle.rlm_child_id);
    assert_eq!(handle.session_dir, expected_dir.to_string_lossy());
    // TS child-session layout: the child persists inside its per-child
    // directory under the parent's session-artifacts tree, alongside the
    // per-child display file the passive roster reads for hydration.
    let child_files: Vec<std::fs::DirEntry> = std::fs::read_dir(&expected_dir)
        .expect("child session dir")
        .filter_map(std::result::Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                == Some("jsonl")
        })
        .collect();
    assert_eq!(child_files.len(), 1, "one session file in the child dir");
    assert!(child_files[0].path().to_string_lossy().ends_with(".jsonl"));
    let display: Value = serde_json::from_str(
        &std::fs::read_to_string(expected_dir.join("rlm-subagent.json")).expect("display file"),
    )
    .expect("parse display file");
    assert_eq!(display["type"], "rlm_subagent");
    assert_eq!(display["childId"], handle.rlm_child_id);
    assert_eq!(display["sessionName"], "worker-a");
    assert_eq!(display["status"], "running");
    assert_eq!(
        display["model"],
        json!({ "provider": "scripted", "modelId": "faux-1" })
    );
    // The child session header records the recursion identity (TS parity:
    // parentSession + rlmDepth on child sessions).
    let header: Value = {
        let content =
            std::fs::read_to_string(child_files[0].path()).expect("read child session file");
        let first = content.lines().next().expect("header line");
        serde_json::from_str(first).expect("parse header")
    };
    assert_eq!(
        header["parentSession"],
        agent_dir.join("parent.jsonl").to_string_lossy().to_string()
    );
    assert_eq!(header["rlmDepth"], 1);

    // The supervisor roster shows the child as a depth-1 subagent session.
    let roster_summary = wait_until(Duration::from_secs(10), || {
        client.send_command("l1", json!({ "type": "list" }));
        let list = client.read_response("l1");
        list["data"]["sessions"].as_array().and_then(|sessions| {
            sessions
                .iter()
                .find(|summary| summary["runtimeKind"] == "subagent")
                .cloned()
        })
    });
    assert_eq!(roster_summary["rlmDepth"], 1);
    assert_eq!(roster_summary["sessionName"], "worker-a");

    // The parent roster settles with the child's answer preview.
    let entries = {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let entries = children.list_subagents().await.expect("list subagents");
            if entries
                .iter()
                .any(|entry| entry.answer_preview.as_deref() == Some("child answer"))
            {
                break entries;
            }
            assert!(
                Instant::now() < deadline,
                "child never settled: {entries:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    assert_eq!(entries.len(), 1, "one child in the roster");
    let entry = &entries[0];
    assert_eq!(entry.rlm_child_id, handle.rlm_child_id);
    assert_eq!(entry.status, "completed");
    assert_eq!(entry.session_name, "worker-a");
    assert_eq!(entry.label.as_deref(), Some("ship the lane"));
    assert!(entry.session_dir.ends_with(&handle.rlm_child_id));

    // Collect: settled snapshot of the child, and the selector errors.
    let results = children
        .collect(vec![handle.rlm_child_id.clone()], 5_000)
        .await
        .expect("collect");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, "done");
    assert!(results[0].settled);
    assert_eq!(results[0].answer_preview.as_deref(), Some("child answer"));
    let snapshot = children.collect(vec![], 0).await.expect("collect all");
    assert_eq!(snapshot.len(), 1);
    let missing = children
        .collect(vec!["ghost".to_string()], 0)
        .await
        .expect_err("unknown selector");
    assert_eq!(
        missing.to_string(),
        "No direct RLM child matches \"ghost\" in the current parent session"
    );

    // A live duplicate name is rejected with the TS conflict error.
    let duplicate = children
        .spawn(spawn_request("worker-a", "same name again"))
        .await
        .expect_err("duplicate name");
    assert_eq!(
        duplicate.to_string(),
        "Agent name \"worker-a\" is unavailable: an agent of that name already exists at depth 1 under this parent"
    );

    // Delete: the child dies and leaves both rosters.
    let deleted = children
        .delete_subagent(handle.rlm_child_id.clone())
        .await
        .expect("delete");
    assert_eq!(deleted.outcome, Some("deleted"));
    assert_eq!(deleted.subagent.rlm_child_id, handle.rlm_child_id);
    let remaining = children.list_subagents().await.expect("list after delete");
    assert!(remaining.is_empty(), "child removed from the parent roster");
    wait_until(Duration::from_secs(10), || {
        client.send_command("l2", json!({ "type": "list" }));
        let list = client.read_response("l2");
        list["data"]["sessions"]
            .as_array()
            .filter(|sessions| sessions.is_empty())
            .map(|_| ())
    });

    // An unknown delete target is the TS selector miss.
    let gone = children
        .delete_subagent("worker-a".to_string())
        .await
        .expect_err("deleted child no longer resolves");
    assert_eq!(
        gone.to_string(),
        "No direct RLM subagent matches \"worker-a\" in the current parent session"
    );

    // TS #2388 F4: a just-deleted target resolves immediately to the
    // settled cancelled envelope its delete receipt promised - by child id
    // and by session name - without spending the timeout budget.
    let cancelled = children
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .expect("collect the deleted child by id");
    assert_eq!(cancelled.len(), 1);
    assert_eq!(cancelled[0].rlm_child_id, handle.rlm_child_id);
    assert_eq!(cancelled[0].session_name.as_deref(), Some("worker-a"));
    assert_eq!(cancelled[0].status, "cancelled");
    assert!(cancelled[0].settled);
    assert_eq!(
        cancelled[0].error.as_deref(),
        Some("Deleted by parent orchestrator")
    );
    let cancelled_by_name = children
        .collect(vec!["worker-a".to_string()], 0)
        .await
        .expect("collect the deleted child by name");
    assert_eq!(cancelled_by_name.len(), 1);
    assert_eq!(cancelled_by_name[0].rlm_child_id, handle.rlm_child_id);
    assert_eq!(cancelled_by_name[0].status, "cancelled");
    assert!(cancelled_by_name[0].settled);
    assert_eq!(
        cancelled_by_name[0].error.as_deref(),
        Some("Deleted by parent orchestrator")
    );
    // An unknown selector keeps the TS miss.
    let missing = children
        .collect(vec!["ghost".to_string()], 0)
        .await
        .expect_err("unknown selector");
    assert_eq!(
        missing.to_string(),
        "No direct RLM child matches \"ghost\" in the current parent session"
    );

    // A reused name owns the selector again: the live respawn answers
    // collect, never the deleted generation's cancelled envelope.
    let replacement = children
        .spawn(spawn_request("worker-a", "second shard"))
        .await
        .expect("respawn under the freed name");
    children.notify_turn_done();
    let live = children
        .collect(vec!["worker-a".to_string()], 0)
        .await
        .expect("collect the live respawn");
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].rlm_child_id, replacement.rlm_child_id);
    assert_ne!(live[0].rlm_child_id, handle.rlm_child_id);
    // The live respawn answers, never the deleted generation's envelope
    // (the replacement may settle at any moment, but it is never the
    // tombstone's cancellation).
    assert_ne!(live[0].status, "cancelled");
}

/// `rlm.create_session`: a resident depth-0 daemon session over the link,
/// prompted, answering through its worker, and not part of the subagent
/// roster.
#[tokio::test]
async fn rlm_create_session_spawns_a_prompted_depth_zero_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);
    let script = write_script(dir.path(), "root session answer");
    let children = children(&socket, &agent_dir, &script, 0).await;

    let handle = children
        .create_session(RlmCreateSessionRequest {
            prompt: "start a root session".to_string(),
            name: Some("root-b".to_string()),
            model: None,
            thinking: None,
            cwd: Some(agent_dir.to_string_lossy().to_string()),
        })
        .await
        .expect("create session");
    assert_eq!(handle.name, "root-b");
    assert!(handle.session_file.ends_with(".jsonl"));
    assert!(Path::new(&handle.session_file).exists());
    assert_eq!(handle.model, "scripted/faux-1");

    // A depth-0 resident session, not a subagent roster row.
    client.send_command("l1", json!({ "type": "list" }));
    let list = client.read_response("l1");
    let sessions = list["data"]["sessions"].as_array().expect("sessions");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["rlmDepth"], 0);
    assert_eq!(sessions[0]["runtimeKind"], "top-level");
    let roster = children.list_subagents().await.expect("roster");
    assert!(
        roster.is_empty(),
        "create_session children are not subagents"
    );

    // The session was prompted: its worker answered.
    let active_id = handle.active_session_id.clone();
    let answer = wait_until(Duration::from_secs(10), || {
        client.send_command(
            "g1",
            json!({ "type": "get_last_assistant_text", "activeSessionId": active_id }),
        );
        let last = client.read_response("g1");
        last["data"]["text"]
            .as_str()
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    });
    assert_eq!(answer, "root session answer");

    // Killing the session removes it from the supervisor roster.
    client.send_command(
        "k1",
        json!({ "type": "kill", "activeSessionId": active_id }),
    );
    let killed = client.read_response("k1");
    assert_eq!(killed["success"], true, "kill failed: {killed}");
    wait_until(Duration::from_secs(10), || {
        client.send_command("l2", json!({ "type": "list" }));
        let list = client.read_response("l2");
        list["data"]["sessions"]
            .as_array()
            .filter(|sessions| sessions.is_empty())
            .map(|_| ())
    });
}

/// The recursion bound: a parent at its depth limit fails spawns with the
/// TS error, and depth-0-only create_session refuses from deeper sessions.
#[tokio::test]
async fn rlm_recursion_bound_is_enforced() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let script = write_script(dir.path(), "unreachable");
    // A depth-2 parent (the default bound): spawns are refused.
    let children = children(&socket, &agent_dir, &script, 2).await;
    let error = children
        .spawn(spawn_request("too-deep", "nope"))
        .await
        .expect_err("depth limit");
    assert_eq!(
        error.to_string(),
        "RLM recursion depth limit reached (RLM_DEPTH=2, RLM_MAX_DEPTH=2)"
    );
    let error = children
        .create_session(RlmCreateSessionRequest {
            prompt: "nope".to_string(),
            name: None,
            model: None,
            thinking: None,
            cwd: None,
        })
        .await
        .expect_err("create_session from depth 2");
    assert_eq!(
        error.to_string(),
        "rlm.create_session is available only from a depth-0 session"
    );
}

/// TS #2396's daemon-wide half (`createRlmSubagentRuntime`): the
/// supervisor holds a subagent spawn's name under a reservation for the
/// whole fresh-launch admission, so parallel same-name same-parent creates
/// cannot both admit - exactly one create lands and the rest fail closed
/// with the TS unavailability error before the durable ledger edge is
/// appended. The reservation releases with the admission: once the winner
/// is gone, the same name admits again.
#[tokio::test]
async fn parallel_same_name_subagent_creates_admit_exactly_one() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);
    let script = write_script(dir.path(), "twin answer");
    let parent_file = agent_dir.join("parent.jsonl");
    let parent_file = parent_file.to_string_lossy().to_string();

    // The raw create a worker's `rlm.spawn` routes: a scripted subagent
    // child of one parent scope, with the name the reservations key on.
    let subagent_create = |child_id: &str| {
        let session_dir = agent_dir
            .join("session-artifacts")
            .join("parent-session-uuid")
            .join(child_id);
        std::fs::create_dir_all(&session_dir).expect("child session dir");
        json!({
            "type": "create",
            "name": "twin-worker",
            "config": {
                "cwd": agent_dir.to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "rlmDepth": 1,
                "rlmMaxDepth": 2,
                "provider": "scripted",
                "model": "faux-1",
                "script": script.to_string_lossy(),
                "childScript": script.to_string_lossy(),
                "parentSessionPath": parent_file,
            },
            "runtimeMetadata": {
                "kind": "subagent",
                "rlmChildId": child_id,
                "parentActiveSessionId": "parent-active-id",
                "parentSessionId": "parent-session-uuid",
                "parentSessionFile": parent_file,
                "rlmDepth": 1,
                "createdAt": 0,
            },
            "lifecycle": "resident",
        })
    };

    // Four parallel same-name creates of the same parent scope: commands
    // on one connection are dispatched concurrently, so their responses
    // arrive out of order (the losers fail at the reservation in
    // milliseconds, the winner answers after its worker launch) - drain
    // the connection until every id is answered instead of reading ids
    // in sequence.
    let ids = ["c1", "c2", "c3", "c4"];
    for id in ids {
        client.send_command(id, subagent_create(&format!("sub-{id}")));
    }
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut responses: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    while responses.len() < ids.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "never answered: {ids:?}");
        let line = client.read_line_with_budget(remaining);
        if let Some(id) = line.get("id").and_then(Value::as_str).map(str::to_string) {
            responses.insert(id, line);
        }
    }
    let mut successes = Vec::new();
    let mut failures = 0;
    for id in ids {
        let response = &responses[id];
        if response["success"].as_bool().unwrap_or(false) {
            successes.push(response.clone());
        } else {
            failures += 1;
            assert_eq!(
                response["error"].as_str().expect("failure error"),
                "Agent name \"twin-worker\" is unavailable: an agent of that name already exists at depth 1 under this parent",
                "the losing create fails closed with the TS unavailability error"
            );
        }
    }
    assert_eq!(successes.len(), 1, "exactly one same-name create admits");
    assert_eq!(failures, 3, "every racing create fails closed");

    // The reservation released with the admission: once the winner is
    // gone, the same name admits again.
    let winner = &successes[0];
    let active_id = winner["data"]["activeSessionId"]
        .as_str()
        .expect("winner active id");
    client.send_command(
        "k1",
        json!({ "type": "kill", "activeSessionId": active_id }),
    );
    let killed = client.read_response_slow("k1");
    assert!(
        killed["success"].as_bool().unwrap_or(false),
        "kill winner: {killed}"
    );
    wait_until(Duration::from_secs(10), || {
        client.send_command("l1", json!({ "type": "list" }));
        let list = client.read_response("l1");
        list["data"]["sessions"]
            .as_array()
            .filter(|sessions| sessions.is_empty())
            .map(|_| ())
    });
    client.send_command("c5", subagent_create("sub-c5"));
    let retry = client.read_response_slow("c5");
    assert!(
        retry["success"].as_bool().unwrap_or(false),
        "the freed name admits again: {retry}"
    );
}
