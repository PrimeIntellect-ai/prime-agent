//! End-to-end RLM child machinery against the real `pa-daemon` supervisor: child sessions
//! spawn through the supervisor link, run in their own worker processes, appear in the
//! supervisor roster, settle with an answer, and die on delete (`rlm.spawn`/
//! `list_subagents`/`collect`/`delete_subagent`/`create_session`).
// Stack-resident futures by design; boxing for a lint tick is a perf regression.
#![allow(clippy::large_futures)]
// 64-bit-only targets; narrowing casts sit at bounded OS/protocol boundaries.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// Fn length is a style gate, not correctness.
#![allow(clippy::too_many_lines)]
// API-shape opinions, not defects; the surfaces are deliberate.
#![allow(
    clippy::unnecessary_wraps,
    clippy::zero_sized_map_values,
    clippy::struct_excessive_bools,
    clippy::struct_field_names
)]
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

// The timeout panic path cannot wait on the child; the test exits and reaps it.
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
        // A supervisor killed at teardown must not leak its session workers into later
        // test binaries: the supervisor-lost exit runs here.
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

/// Minimal JSONL supervisor client (list / kill / `get_last_assistant_text`).
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

    fn send_command(&mut self, id: &str, command: &Value) {
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

    /// `read_line` with a caller-chosen budget: a raw `create` that launches a worker answers
    /// after the worker's connect budget (up to 30s, past the shared 15s line budget).
    fn read_line_with_budget(&mut self, budget: Duration) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + budget;
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => line.clear(),
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

    /// `read_response` with a worker-boot budget (the raw-create path's reader): every
    /// line waits on the remaining wall budget, covering the host's `CREATE_TIMEOUT_MS`.
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

/// Children registry bound to the running supervisor, with a parent identity rooted at `agent_dir`.
fn children(socket: &Path, agent_dir: &Path, script: &Path, depth: u32) -> SupervisorChildSessions {
    let sessions = SupervisorChildSessions::new(
        Arc::new(SupervisorLink::new(socket.to_path_buf())),
        agent_dir.to_path_buf(),
        "parent-active-id".to_string(),
        std::sync::Arc::new(pa_daemon::model_allowlist::ModelRefusalTelemetry::new(
            agent_dir.to_path_buf(),
            /*telemetry_disabled*/ true,
        )),
        String::new(),
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
    sessions.set_parent_session_name(Some("parent-name".to_string()));
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
        cwd: None,
        decision_child: false,
        spawned_by_request_id: None,
        factory: None,
    }
}

/// A child spawned with a relative `cwd` runs in that directory and loads only
/// its project context; a missing directory refuses the spawn.
#[tokio::test]
async fn rlm_spawn_cwd_starts_the_child_in_that_directory() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let main = dir.path().join("main");
    let project = dir.path().join("project");
    let marker = format!("SPAWN_CWD_CONTEXT_{}", uuid::Uuid::new_v4().simple());
    let main_marker = format!("SPAWN_CWD_PARENT_CONTEXT_{}", uuid::Uuid::new_v4().simple());
    for (path, content) in [(&main, &main_marker), (&project, &marker)] {
        std::fs::create_dir_all(path).expect("project dir");
        std::fs::write(path.join("AGENTS.md"), content).expect("write AGENTS.md");
    }
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _) = Client::connect(&socket);
    // The faux engine (and its faux model) runs the real agent engine, so the
    // child builds its system prompt.
    let script = dir.path().join("faux.json");
    std::fs::write(
        &script,
        json!({ "engine": "faux", "responses": [ { "text": "child answer" } ] }).to_string(),
    )
    .expect("write script");
    let children = children(&socket, &agent_dir, &script, 0);
    children.set_identity(ParentIdentity {
        rlm_depth: 0,
        rlm_max_depth: 2,
        model: Some("faux/faux-1".to_string()),
        cwd: Some(main.to_string_lossy().to_string()),
        session_id: Some("parent-session-uuid".to_string()),
        session_file: Some(agent_dir.join("parent.jsonl").to_string_lossy().to_string()),
        thinking: None,
        child_script: Some(script.to_string_lossy().to_string()),
    });

    let handle = children
        .spawn(RlmSpawnRequest {
            cwd: Some("../project".to_string()),
            ..spawn_request("worker-cwd", "ship the lane")
        })
        .await
        .expect("spawn");
    let summary = wait_until(Duration::from_secs(10), || {
        client.send_command("l1", &json!({ "type": "list" }));
        let list = client.read_response("l1");
        list["data"]["sessions"].as_array().and_then(|sessions| {
            sessions
                .iter()
                .find(|summary| summary["sessionName"] == "worker-cwd")
                .cloned()
        })
    });
    assert_eq!(
        summary["cwd"],
        json!(project.canonicalize().expect("project"))
    );
    client.send_command(
        "prompt",
        &json!({ "type": "get_system_prompt", "activeSessionId": summary["id"] }),
    );
    let context = client.read_response("prompt");
    let system_prompt = context["data"]["systemPrompt"].as_str().unwrap_or_default();
    assert!(system_prompt.contains(&marker), "{context}");
    assert!(!system_prompt.contains(&main_marker), "{context}");

    let missing = project.join("missing");
    let error = children
        .spawn(RlmSpawnRequest {
            cwd: Some(missing.to_string_lossy().to_string()),
            ..spawn_request("worker-missing", "ship the lane")
        })
        .await
        .expect_err("missing cwd");
    assert_eq!(
        error.to_string(),
        format!("rlm.spawn cwd {} is not a directory", missing.display())
    );
    let _ = children.delete_subagent(handle.rlm_child_id).await;
}

/// Spawn a child through the supervisor, observe it in both rosters, collect its answer,
/// then delete it (both rosters drop it).
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
    let children = children(&socket, &agent_dir, &script, 0);

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
    // Same layout, alongside the per-child display file the passive roster reads.
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
    // parentSession + rlmDepth).
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
        client.send_command("l1", &json!({ "type": "list" }));
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

    // The kickoff row (TS `spawnMessage`): the task prompt lands as the
    // parent-attributed `agent_message` custom row — never a user row —
    // carrying the promised `[task from parent]` label, the raw prompt as
    // `details.message`, `details.id "spawn:<child id>"`, and the
    // delivery's parent/child endpoints.
    let rows: Vec<Value> = std::fs::read_to_string(child_files[0].path())
        .expect("read child session file")
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect();
    let Some(kickoff) = rows
        .iter()
        .find(|row| row.get("type").and_then(Value::as_str) == Some("custom_message"))
    else {
        panic!("no custom_message row in the child file: {rows:?}");
    };
    assert_eq!(kickoff["customType"], "agent_message");
    assert_eq!(kickoff["content"], "[task from parent]\n\nship the lane");
    assert_eq!(
        kickoff["details"],
        json!({
            "id": format!("spawn:{}", handle.rlm_child_id),
            "message": "ship the lane",
            "from": {
                "activeSessionId": "parent-active-id",
                "sessionId": "parent-session-uuid",
                "sessionName": "parent-name",
            },
            "fromRelationship": "parent",
        }),
    );
    // The kickoff is the child's only prompt: no user row exists.
    assert!(
        rows.iter()
            .filter(|row| row.get("type").and_then(Value::as_str) == Some("message"))
            .all(|row| row.pointer("/message/role").and_then(Value::as_str) != Some("user")),
        "the kickoff left a user row: {rows:?}"
    );

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
        client.send_command("l2", &json!({ "type": "list" }));
        let list = client.read_response("l2");
        list["data"]["sessions"]
            .as_array()
            .filter(|sessions| sessions.is_empty())
            .map(|_| ())
    });

    // Retirement is idempotent (the M5 class): a re-delete of the deleted
    // child's name answers from the tombstone with the row's status at its
    // delete instead of the selector miss, so a repeated retire never
    // reports the name slot as still held.
    let redeleted = children
        .delete_subagent("worker-a".to_string())
        .await
        .expect("the re-delete of a retired child is idempotent");
    assert_eq!(redeleted.outcome, Some("deleted"));
    assert_eq!(redeleted.subagent.rlm_child_id, handle.rlm_child_id);
    // An unknown delete target keeps the TS selector miss.
    let gone = children
        .delete_subagent("ghost-worker".to_string())
        .await
        .expect_err("an unknown selector still errors");
    assert_eq!(
        gone.to_string(),
        "No direct RLM subagent matches \"ghost-worker\" in the current parent session"
    );

    // TS #2388 F4: a just-deleted target resolves immediately to the settled cancelled
    // envelope its delete receipt promised (by child id or name), without the timeout budget.
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

    // A reused name owns the selector again: the live respawn answers, never the tombstone.
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
    // The live respawn answers, never the deleted generation's envelope.
    assert_ne!(live[0].status, "cancelled");
}

/// A decision child (`rlm.spawn kind="decision"`) spawns through the real
/// supervisor on the settings decision model and runs the decision engine:
/// the protocol prompt settles as the engine's ready answer, never an
/// agent turn. Regression: the durable create command must ride the
/// `decisionChild` flag to the worker's launch env — a dropped flag
/// respawns the decision child as a regular agent session whose turn
/// fails on the decision model.
#[tokio::test]
async fn a_decision_child_spawn_runs_the_decision_engine_end_to_end() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    // The settings gate, the registry recipe, and the stored login, on an
    // unreachable endpoint: the protocol prompt makes no model call.
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({ "decisionApi": { "systemOneModel": "decision-fixture/clef" } }).to_string(),
    )
    .expect("write settings");
    std::fs::write(
        agent_dir.join("models.json"),
        json!({ "providers": { "decision-fixture": {
            "baseUrl": "http://127.0.0.1:1/api/v1",
            "apiKey": "DECISION_FIXTURE_KEY",
            "api": "systemone",
            "models": [ { "id": "clef", "input": ["text"] } ],
        } } })
        .to_string(),
    )
    .expect("write models");
    std::fs::write(
        agent_dir.join("auth.json"),
        json!({ "decision-fixture": { "type": "api_key", "key": "fixture-key" } }).to_string(),
    )
    .expect("write auth");
    // The fabricated parent identity names a session file: the ledger's
    // liveness pass stats the recorded endpoints, so the parent file must
    // exist for the spawn edge to read back live.
    std::fs::write(agent_dir.join("parent.jsonl"), "").expect("write the parent session file");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    // The children registry without a child script: the decision child is
    // an engine choice, never a scripted child.
    let children = {
        let sessions = SupervisorChildSessions::new(
            Arc::new(SupervisorLink::new(socket.clone())),
            agent_dir.clone(),
            "parent-active-id".to_string(),
            std::sync::Arc::new(pa_daemon::model_allowlist::ModelRefusalTelemetry::new(
                agent_dir.clone(),
                /*telemetry_disabled*/ true,
            )),
            String::new(),
        );
        sessions.set_identity(ParentIdentity {
            rlm_depth: 0,
            rlm_max_depth: 2,
            model: Some("scripted/faux-1".to_string()),
            cwd: Some(agent_dir.to_string_lossy().to_string()),
            session_id: Some("parent-session-uuid".to_string()),
            session_file: Some(agent_dir.join("parent.jsonl").to_string_lossy().to_string()),
            thinking: None,
            child_script: None,
        });
        sessions
    };
    let request = RlmSpawnRequest {
        prompt: "You are System 1, the decision child of a real-time control loop.".to_string(),
        name: Some("system-1".to_string()),
        model: None,
        thinking: None,
        decision_child: true,
        spawned_by_request_id: None,
    };
    let handle = children
        .spawn(request)
        .await
        .expect("spawn the decision child");
    children.notify_turn_done();
    // The spawn seam resolves the settings decision model, not the parent's.
    assert_eq!(handle.model, "decision-fixture/clef", "{handle:?}");
    // The child settles with the decision engine's protocol answer — an
    // agent-engine child instead fails its turn on the unreachable model.
    let entries = {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let entries = children.list_subagents().await.expect("list subagents");
            if entries
                .iter()
                .any(|entry| entry.answer_preview.as_deref() == Some("Decision child ready."))
            {
                break entries;
            }
            assert!(
                Instant::now() < deadline,
                "decision child never settled ready: {entries:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    assert_eq!(entries.len(), 1, "one child in the roster");
    assert_eq!(entries[0].session_name, "system-1");
    // The supervisor roster carries the same settled decision child.
    let roster_summary = wait_until(Duration::from_secs(10), || {
        client.send_command("l1", &json!({ "type": "list" }));
        let list = client.read_response("l1");
        list["data"]["sessions"].as_array().and_then(|sessions| {
            sessions
                .iter()
                .find(|summary| summary["sessionName"] == "system-1")
                .cloned()
        })
    });
    assert_eq!(roster_summary["rlmDepth"], 1);
    // The decision child keeps its subagent parent edge: the create arm
    // extracts the runtime identity for the decision kind too, so the
    // child's summary (and every reply route off it) reaches the parent.
    assert_eq!(roster_summary["parentActiveSessionId"], "parent-active-id");
    // The spawn admission recorded the durable ledger edge: recovery
    // after parent replacement and the nonresident wake resolve the
    // decision child through it (regression: the admission gate used to
    // admit only subagent-kind children, so a decision child's edge
    // never reached the ledger).
    let ledger =
        pa_daemon::rlm_ledger::RlmSpawnLedger::new(&agent_dir, &agent_dir.join("sessions"), |_| {});
    let edge = ledger
        .edges(true)
        .expect("ledger edges")
        .into_iter()
        .find(|edge| edge.child_id == handle.rlm_child_id)
        .expect("the decision child's ledger edge");
    // The ledger records the parent file's canonical path: recovery
    // resolves the edge through it after the parent worker is replaced.
    let parent_file = agent_dir
        .join("parent.jsonl")
        .canonicalize()
        .expect("the parent session file exists");
    assert_eq!(
        Path::new(&edge.parent),
        parent_file,
        "the edge names the parent session file for recovery"
    );
    assert_eq!(edge.name, "system-1", "the edge carries the spawn name");
}

/// A bounded read of one supervisor line: `None` means no line arrived
/// before the deadline (the roster pushes the pin below waits on are
/// optional traffic, so the wait must expire instead of blocking).
fn try_read_supervisor_line(client: &mut Client, deadline: Instant) -> Option<Value> {
    client
        .reader
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(100)))
        .expect("set read timeout");
    let mut line = String::new();
    loop {
        match client.reader.read_line(&mut line) {
            Ok(0) => panic!("supervisor closed the connection"),
            Ok(_) if line.trim().is_empty() => line.clear(),
            Ok(_) => return serde_json::from_str(line.trim()).expect("parse line"),
            Err(_) if Instant::now() < deadline => {}
            Err(_) => return None,
        }
    }
}

/// A decision child publishes its live roster activity: its worker runs
/// the roster push queue and the activity watch like any other engine
/// family, so a roster subscriber sees the child's turn transitions
/// without a separate summary pull (regression: the decision branch
/// built `RosterPushQueue::disabled()`, so a decision child's roster row
/// stayed stale until the next pull refreshed it).
#[tokio::test]
async fn a_decision_child_pushes_roster_deltas_to_subscribers() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    // The settings gate, the registry recipe, and the stored login, on an
    // unreachable endpoint: the protocol prompt makes no model call.
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({ "decisionApi": { "systemOneModel": "decision-fixture/clef" } }).to_string(),
    )
    .expect("write settings");
    std::fs::write(
        agent_dir.join("models.json"),
        json!({ "providers": { "decision-fixture": {
            "baseUrl": "http://127.0.0.1:1/api/v1",
            "apiKey": "DECISION_FIXTURE_KEY",
            "api": "systemone",
            "models": [ { "id": "clef", "input": ["text"] } ],
        } } })
        .to_string(),
    )
    .expect("write models");
    std::fs::write(
        agent_dir.join("auth.json"),
        json!({ "decision-fixture": { "type": "api_key", "key": "fixture-key" } }).to_string(),
    )
    .expect("write auth");
    // The fabricated parent identity names a session file the ledger's
    // liveness pass stats, so the parent file must exist.
    std::fs::write(agent_dir.join("parent.jsonl"), "").expect("write the parent session file");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    // The subscriber connects BEFORE the spawn: every roster write the
    // spawn flow and the child's own turns produce reaches this reader.
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    client.send_command("rs", &json!({ "type": "roster_subscribe" }));
    let subscribed = client.read_response("rs");
    assert_eq!(
        subscribed["success"], true,
        "roster_subscribe failed: {subscribed}"
    );
    let children = {
        let sessions = SupervisorChildSessions::new(
            Arc::new(SupervisorLink::new(socket.clone())),
            agent_dir.clone(),
            "parent-active-id".to_string(),
            std::sync::Arc::new(pa_daemon::model_allowlist::ModelRefusalTelemetry::new(
                agent_dir.clone(),
                /*telemetry_disabled*/ true,
            )),
            String::new(),
        );
        sessions.set_identity(ParentIdentity {
            rlm_depth: 0,
            rlm_max_depth: 2,
            model: Some("scripted/faux-1".to_string()),
            cwd: Some(agent_dir.to_string_lossy().to_string()),
            session_id: Some("parent-session-uuid".to_string()),
            session_file: Some(agent_dir.join("parent.jsonl").to_string_lossy().to_string()),
            thinking: None,
            child_script: None,
        });
        sessions
    };
    let handle = children
        .spawn(RlmSpawnRequest {
            prompt: "You are System 1, the decision child of a roster probe.".to_string(),
            name: Some("system-1".to_string()),
            model: None,
            thinking: None,
            decision_child: true,
            spawned_by_request_id: None,
        })
        .await
        .expect("spawn the decision child");
    children.notify_turn_done();
    // The spawn seam resolves the settings decision model, not the parent's.
    assert_eq!(handle.model, "decision-fixture/clef", "{handle:?}");
    let child_active_id = {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let entries = children.list_subagents().await.expect("list subagents");
            if let Some(active_id) = entries
                .iter()
                .find(|entry| entry.answer_preview.as_deref() == Some("Decision child ready."))
                .and_then(|entry| entry.active_session_id.clone())
            {
                break active_id;
            }
            assert!(
                Instant::now() < deadline,
                "decision child never settled ready: {entries:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    // The child row's message count in one roster_update frame, when the
    // frame carries it (matched by the active session id the routed prompt
    // below addresses).
    let child_row_count = |frame: &Value| {
        frame["changed"].as_array().and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry["summary"]["activeSessionId"] == json!(child_active_id))
                .and_then(|entry| entry["summary"]["messageCount"].as_u64())
        })
    };
    // Drain the spawn flow's roster writes (the registration and admission
    // pulls, the first protocol turn's own pushes) into the baseline: the
    // fresh turn below must advance past whatever the pull surfaces saw.
    let mut baseline = 0_u64;
    let drain_deadline = Instant::now() + Duration::from_secs(2);
    while let Some(line) = try_read_supervisor_line(&mut client, drain_deadline) {
        if let Some(count) = child_row_count(&line) {
            baseline = baseline.max(count);
        }
    }
    // One fresh protocol turn after the spawn flow went quiet: nothing
    // pulls in this window, so only the child's own roster pushes can
    // report the turn to the subscriber.
    client.send_command(
        "p2",
        &json!({
            "type": "prompt",
            "activeSessionId": child_active_id,
            "message": "one more protocol probe",
        }),
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    let fresh_row = loop {
        assert!(
            Instant::now() < deadline,
            "the decision child never pushed its turn's roster delta (baseline messageCount {baseline})"
        );
        let Some(line) = try_read_supervisor_line(&mut client, deadline) else {
            continue;
        };
        if line.get("id").and_then(Value::as_str) == Some("p2") {
            assert_eq!(line["success"], true, "the routed prompt failed: {line}");
            continue;
        }
        // A mid-turn busy delta (the accepted prompt row, isStreaming
        // true) can arrive first with the bumped count: keep reading until
        // the turn's settle push — the row this test pins — lands.
        if let Some(count) = child_row_count(&line) {
            let settled = line["changed"]
                .as_array()
                .and_then(|entries| {
                    entries
                        .iter()
                        .find(|entry| entry["summary"]["activeSessionId"] == json!(child_active_id))
                        .cloned()
                })
                .is_some_and(|entry| {
                    entry["summary"]["isStreaming"] == false
                        && entry["summary"]["activity"] == "idle"
                });
            if count > baseline && settled {
                break line;
            }
        }
    };
    // The pushed row reports the turn that produced it: the child went
    // busy, ran its protocol answer, and settled idle with the fresh
    // rows persisted.
    let summary = &fresh_row["changed"]
        .as_array()
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry["summary"]["activeSessionId"] == json!(child_active_id))
                .cloned()
        })
        .expect("the child's changed roster entry")["summary"];
    assert!(
        summary["messageCount"]
            .as_u64()
            .is_some_and(|count| count > baseline),
        "the pushed row carries the fresh turn's message count: {summary}"
    );
    assert_eq!(summary["isStreaming"], false, "the pushed row is settled");
    assert_eq!(summary["activity"], "idle", "the pushed row is idle");
}

#[tokio::test]
async fn rlm_create_session_spawns_a_prompted_depth_zero_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);
    let script = write_script(dir.path(), "root session answer");
    let children = children(&socket, &agent_dir, &script, 0);

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
    assert!(Path::new(&handle.session_file)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl")));
    assert!(Path::new(&handle.session_file).exists());
    assert_eq!(handle.model, "scripted/faux-1");

    // A depth-0 resident session, not a subagent roster row.
    client.send_command("l1", &json!({ "type": "list" }));
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
            &json!({ "type": "get_last_assistant_text", "activeSessionId": active_id }),
        );
        let final_answer = client.read_response("g1");
        final_answer["data"]["text"]
            .as_str()
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    });
    assert_eq!(answer, "root session answer");

    // Killing the session removes it from the supervisor roster.
    client.send_command(
        "k1",
        &json!({ "type": "kill", "activeSessionId": active_id }),
    );
    let killed = client.read_response("k1");
    assert_eq!(killed["success"], true, "kill failed: {killed}");
    wait_until(Duration::from_secs(10), || {
        client.send_command("l2", &json!({ "type": "list" }));
        let list = client.read_response("l2");
        list["data"]["sessions"]
            .as_array()
            .filter(|sessions| sessions.is_empty())
            .map(|_| ())
    });
}

#[tokio::test]
async fn rlm_recursion_bound_is_enforced() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let script = write_script(dir.path(), "unreachable");
    // A depth-2 parent (the default bound): spawns are refused.
    let children = children(&socket, &agent_dir, &script, 2);
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

/// TS #2396's daemon-wide half: the supervisor holds a subagent spawn's name under a
/// reservation for the whole fresh-launch admission; once the winner is gone, the name
/// admits again.
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

    // The raw create a worker's `rlm.spawn` routes: a scripted subagent with the reserved name.
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

    // Four parallel same-name creates of the same parent scope: responses arrive out of order
    // (the losers fail in milliseconds) - drain until every id is answered.
    let ids = ["c1", "c2", "c3", "c4"];
    for id in ids {
        client.send_command(id, &subagent_create(&format!("sub-{id}")));
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

    let winner = &successes[0];
    let active_id = winner["data"]["activeSessionId"]
        .as_str()
        .expect("winner active id");
    client.send_command(
        "k1",
        &json!({ "type": "kill", "activeSessionId": active_id }),
    );
    let killed = client.read_response_slow("k1");
    assert!(
        killed["success"].as_bool().unwrap_or(false),
        "kill winner: {killed}"
    );
    wait_until(Duration::from_secs(10), || {
        client.send_command("l1", &json!({ "type": "list" }));
        let list = client.read_response("l1");
        list["data"]["sessions"]
            .as_array()
            .filter(|sessions| sessions.is_empty())
            .map(|_| ())
    });
    client.send_command("c5", &subagent_create("sub-c5"));
    let retry = client.read_response_slow("c5");
    assert!(
        retry["success"].as_bool().unwrap_or(false),
        "the freed name admits again: {retry}"
    );
}
