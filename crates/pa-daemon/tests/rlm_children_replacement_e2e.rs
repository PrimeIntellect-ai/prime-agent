//! RLM children lifecycle on parent runtime replacement: the TS ruling
//! e2e (the #237 flagged divergence, left to the rlm-children surface).
//!
//! TS ground truth (`packages/coding-agent/src/core/agent-session-runtime.ts`
//! and `modes/daemon/daemon-mode.ts`): every whole-runtime replacement flow
//! (`newSession` / `switchSession` / `fork` / `importFromJsonl`) runs
//! `teardownForReplacement` -> `teardownCurrent`, which disposes the
//! session's kernel FIRST and then `disposeHostedSubagentRuntimes` - the
//! daemon host's `disposeRlmSubagentRuntimes` runs
//! `closeChildSessions(parentState, "replaced")`. So TS CLOSES the RLM
//! children at a parent replacement: they are archived, aborted, and
//! disposed with the parent runtime, the replacement session's roster
//! starts empty, and the close is a plain stop (no ledger tombstone; the
//! spawn edge and the passive roster row survive). `rlm.create_session`
//! root sessions are not parent-linked and SURVIVE the replacement.
//!
//! The Rust redesign hosts each child as its own supervisor-owned worker,
//! so the close ports as a signal through the supervisor: the worker's
//! replacement teardown (and `kill`/`shutdown`, TS
//! `closeSessionOnce`'s cascade) stops every tracked child session.
//!
//! Verified end to end against a real supervisor, a real parent worker
//! session whose kernel cell spawns the child through the product
//! `rlm.spawn` surface, and a scripted child worker kept mid-run:
//!
//! 1. `new_session` closes the spawned child: the supervisor roster drops
//!    it, its session file archives, the parent's `get_rlm_children` wire
//!    surface reads empty, and the replacement session's kernel
//!    `rlm.list_subagents()` returns an empty roster.
//! 2. `new_session` KEEPS an `rlm.create_session` depth-0 root session
//!    running: the close touches parent-linked children only.
//!
//! The parent's kernel Python is ambient product state; like the other
//! live-kernel verifiers these tests skip (with a note) on machines
//! without a live install.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
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

// The timeout panic path cannot wait on the child; the test process exits
// immediately afterwards, reaping it.
#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path, kernel_python: &Path) -> Daemon {
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let child = Command::new(binary)
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .env("PRIME_AGENT_KERNEL_PYTHON", kernel_python)
        // Hermetic agent dir: the ambient environment exports a real
        // agent dir; point every fallback at the test sandbox instead.
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .env_remove("PRIME_API_KEY")
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

/// The kernel Python with prime-agent-runtime installed; set
/// PA_E2E_KERNEL_PYTHON to point at an explicit interpreter instead.
fn kernel_python() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PA_E2E_KERNEL_PYTHON") {
        let explicit = PathBuf::from(explicit);
        assert!(
            explicit.exists(),
            "PA_E2E_KERNEL_PYTHON {explicit:?} not found"
        );
        return Some(explicit);
    }
    let candidate = PathBuf::from(
        std::env::var("HOME")
            .map(|home| format!("{home}/.prime/agent/kernel-venv/bin/python"))
            .unwrap_or_else(|_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string()),
    );
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!("kernel python {candidate:?} not found; skipping live RLM children replacement e2e");
    None
}

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

/// JSONL supervisor client (command envelopes, id-matched responses).
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
        let deadline = Instant::now() + Duration::from_mins(2);
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
        let deadline = Instant::now() + Duration::from_mins(4);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

/// Poll until a condition over the supervisor client yields a value.
fn wait_until<T>(
    client: &mut Client,
    budget: Duration,
    mut probe: impl FnMut(&mut Client) -> Option<T>,
) -> T {
    let deadline = Instant::now() + budget;
    loop {
        if let Some(value) = probe(client) {
            return value;
        }
        assert!(Instant::now() < deadline, "condition never became true");
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// The supervisor roster's session summaries (the `list` wire surface).
fn roster_summaries(client: &mut Client, id: &str) -> Vec<Value> {
    client.send_command(id, json!({ "type": "list" }));
    let list = client.read_response(id);
    assert_eq!(list["success"], true, "list failed: {list}");
    list["data"]["sessions"]
        .as_array()
        .cloned()
        .expect("sessions array")
}

/// The parent's tracked-children wire surface (`get_rlm_children`).
fn rlm_children_rows(client: &mut Client, id: &str, parent: &str) -> Vec<Value> {
    client.send_command(
        id,
        json!({ "type": "get_rlm_children", "activeSessionId": parent }),
    );
    let response = client.read_response(id);
    assert_eq!(
        response["success"], true,
        "get_rlm_children failed: {response}"
    );
    response["data"]["children"]
        .as_array()
        .cloned()
        .expect("children array")
}

/// Run one turn (prompt + idle wait) on the session.
fn run_turn(client: &mut Client, session_id: &str, message: &str, id: &str) {
    client.send_command(
        id,
        json!({ "type": "prompt", "activeSessionId": session_id, "message": message }),
    );
    let prompted = client.read_response(id);
    assert_eq!(prompted["success"], true, "prompt failed: {prompted}");
    let idle_id = format!("{id}-idle");
    client.send_command(
        &idle_id,
        json!({ "type": "wait_for_idle", "activeSessionId": session_id }),
    );
    let idle = client.read_response(&idle_id);
    assert_eq!(idle["success"], true, "wait_for_idle failed: {idle}");
}

/// Poll for a kernel cell's receipt content (the cell writes its verdict).
fn await_receipt(receipt: &Path) -> String {
    let deadline = Instant::now() + Duration::from_mins(1);
    loop {
        if let Ok(content) = std::fs::read_to_string(receipt) {
            return content;
        }
        assert!(
            Instant::now() < deadline,
            "kernel cell receipt never appeared at {}",
            receipt.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The kernel cell of the spawn turn: spawn one RLM child through the
/// product `rlm.spawn` surface and record its child id.
fn spawn_cell(receipt: &Path, error_receipt: &Path) -> String {
    format!(
        "import json, traceback\ntry:\n    handle = await rlm.spawn(\"run the lane task\", name=\"kid\")\n    open({receipt:?}, \"w\").write(json.dumps({{\"rlm_child_id\": handle.rlm_child_id}}))\n    print(handle.rlm_child_id)\nexcept Exception:\n    open({error_receipt:?}, \"w\").write(traceback.format_exc())\n    raise",
        receipt = receipt.display().to_string(),
        error_receipt = error_receipt.display().to_string(),
    )
}

/// The kernel cell of the probe turn: the replacement session's
/// `rlm.list_subagents()` roster, recorded verbatim.
fn roster_cell(receipt: &Path, error_receipt: &Path) -> String {
    format!(
        "import inspect, traceback\ntry:\n    roster = rlm.list_subagents()\n    if inspect.isawaitable(roster):\n        roster = await roster\n    open({receipt:?}, \"w\").write(repr(roster))\n    print(repr(roster))\nexcept Exception:\n    open({error_receipt:?}, \"w\").write(traceback.format_exc())\n    raise",
        receipt = receipt.display().to_string(),
        error_receipt = error_receipt.display().to_string(),
    )
}

/// The kernel cell that creates one depth-0 resident root session through
/// the product `rlm.create_session` surface.
fn create_session_cell(receipt: &Path, error_receipt: &Path) -> String {
    format!(
        "import json, traceback\ntry:\n    handle = await rlm.create_session(\"root session task\", name=\"rootkid\")\n    open({receipt:?}, \"w\").write(json.dumps({{\"name\": handle.name}}))\n    print(handle.name)\nexcept Exception:\n    open({error_receipt:?}, \"w\").write(traceback.format_exc())\n    raise",
        receipt = receipt.display().to_string(),
        error_receipt = error_receipt.display().to_string(),
    )
}

/// The child's scripted engine: one held response keeps its task turn
/// running while the replacement fires, so the close lands on a live
/// child (TS closes running children - abort, archive, dispose).
fn write_child_script(dir: &Path) -> PathBuf {
    let script = dir.join("child.json");
    std::fs::write(
        &script,
        json!({ "responses": [ { "text": "kid still working", "delayMs": 30_000 } ] }).to_string(),
    )
    .expect("write child script");
    script
}

/// The parent's faux script whose turns run the spawn/roster cells.
fn write_parent_script(dir: &Path, first_cell: &str, probe_cell: &str) -> PathBuf {
    let script = dir.join("parent.json");
    std::fs::write(
        &script,
        json!({
            "engine": "faux",
            "responses": [
                { "content": [
                    { "type": "toolCall", "name": "ipython", "arguments": { "code": first_cell } },
                ] },
                { "text": "spawn turn done" },
                { "content": [
                    { "type": "toolCall", "name": "ipython", "arguments": { "code": probe_cell } },
                ] },
                { "text": "probe turn done" },
            ],
        })
        .to_string(),
    )
    .expect("write parent script");
    script
}

/// Create a scripted parent session through the supervisor. The create's
/// `childScript` (the harness seam mirroring the TS child runtime's
/// inherited `sessionConfig`) makes every `rlm.spawn` child a scripted
/// worker.
fn create_parent(
    client: &mut Client,
    dir: &Path,
    parent_script: &Path,
    child_script: &Path,
    id: &str,
) -> Value {
    let sessions_dir = dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    client.send_command(
        id,
        json!({
            "type": "create",
            "name": "parent",
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": parent_script.to_string_lossy(),
                "childScript": child_script.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response(id);
    assert_eq!(created["success"], true, "create parent failed: {created}");
    created["data"].clone()
}

/// `new_session` (TS `AgentSessionRuntime.newSession` ->
/// `teardownForReplacement` -> `teardownCurrent` ->
/// `disposeHostedSubagentRuntimes` -> `closeChildSessions(parent,
/// "replaced")`): a spawned RLM child is supervisor-backed, so the close
/// ports as a stop through the supervisor. The child's observable state
/// after the replacement: gone from the supervisor roster, its session
/// file archived, the parent's wire roster empty, and the replacement
/// session's kernel `rlm.list_subagents()` reading an empty roster.
#[test]
fn new_session_closes_the_spawned_child_and_empties_the_roster() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let socket = dir.path().join("supervisor.sock");
    let receipts = dir.path().join("receipts");
    std::fs::create_dir_all(&receipts).expect("receipts dir");
    let spawn_receipt = receipts.join("spawn.json");
    let spawn_error = receipts.join("spawn.error");
    let roster_receipt = receipts.join("roster.txt");
    let roster_error = receipts.join("roster.error");

    let child_script = write_child_script(dir.path());
    let parent_script = write_parent_script(
        dir.path(),
        &spawn_cell(&spawn_receipt, &spawn_error),
        &roster_cell(&roster_receipt, &roster_error),
    );
    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    let parent = create_parent(&mut client, dir.path(), &parent_script, &child_script, "c1");
    let parent_id = parent["activeSessionId"]
        .as_str()
        .or_else(|| parent["id"].as_str())
        .expect("parent active session id")
        .to_string();
    let parent_session_id = parent["sessionId"].as_str().expect("parent session id");

    // Turn 1: the kernel cell spawns the child through the parent's own
    // registry (the `rlm.spawn` host surface).
    run_turn(&mut client, &parent_id, "spawn the kid", "t1");
    let spawned: Value =
        serde_json::from_str(&await_receipt(&spawn_receipt)).expect("spawn receipt json");
    let child_id = spawned["rlm_child_id"]
        .as_str()
        .expect("child id")
        .to_string();
    assert!(
        child_id.starts_with("sub-"),
        "the spawn handle must carry the child id: {spawned}"
    );
    assert!(
        !spawn_error.exists(),
        "the spawn cell failed: {}",
        std::fs::read_to_string(&spawn_error).unwrap_or_default()
    );

    // The child runs: its worker session is resident in the supervisor and
    // tracked in the parent's registry (the surface the close drains).
    let child_row = wait_until(&mut client, Duration::from_mins(1), |client| {
        let rows = rlm_children_rows(client, "g1", &parent_id);
        rows.into_iter()
            .find(|row| row["id"] == json!(child_id) && row["status"] == "running")
    });
    assert_eq!(child_row["sessionName"], "kid");
    let supervisor_row = wait_until(&mut client, Duration::from_secs(30), |client| {
        roster_summaries(client, "l1").into_iter().find(|summary| {
            summary["sessionName"] == json!("kid") && summary["runtimeKind"] == "subagent"
        })
    });
    let child_active_session_id = supervisor_row["activeSessionId"]
        .as_str()
        .expect("child active session id")
        .to_string();

    // The replacement (TS disposes the runtime, then the hosted children).
    client.send_command(
        "n1",
        json!({ "type": "new_session", "activeSessionId": parent_id }),
    );
    let replaced = client.read_response("n1");
    assert_eq!(replaced["success"], true, "new_session failed: {replaced}");

    // The child's observable state after: closed with the parent.
    wait_until(&mut client, Duration::from_mins(1), |client| {
        let summaries = roster_summaries(client, "l2");
        summaries
            .iter()
            .all(|summary| summary["activeSessionId"] != json!(child_active_session_id))
            .then_some(())
    });
    let rows = rlm_children_rows(&mut client, "g2", &parent_id);
    assert!(
        rows.is_empty(),
        "the replacement session's roster must start empty: {rows:?}"
    );
    // The close is a plain stop (TS `closeSessionOnce("replaced")`
    // archives the child session): the child's session file records it.
    let child_session_file = {
        let child_dir = agent_dir
            .join("session-artifacts")
            .join(parent_session_id)
            .join(&child_id);
        let file = std::fs::read_dir(&child_dir)
            .expect("child session dir")
            .filter_map(std::result::Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.extension().and_then(|extension| extension.to_str()) == Some("jsonl"))
            .expect("one child session file");
        file
    };
    let child_session =
        std::fs::read_to_string(&child_session_file).expect("read child session file");
    assert!(
        child_session.contains("\"archived\""),
        "the closed child's session must be archived: {child_session}"
    );

    // The model-facing surface agrees: the replacement session's kernel
    // reads an empty roster.
    run_turn(&mut client, &parent_id, "probe the roster", "t2");
    assert!(
        !roster_error.exists(),
        "the roster cell failed: {}",
        std::fs::read_to_string(&roster_error).unwrap_or_default()
    );
    assert_eq!(
        await_receipt(&roster_receipt),
        "[]",
        "the replacement session must list no children"
    );
}

/// `rlm.create_session` depth-0 root sessions are NOT parent-linked (TS
/// `createRlmRootSession` builds a root `ActiveSessionState` with no
/// `parentActiveSessionId`), so `closeChildSessions` never matches them:
/// a created root session survives the parent's replacement, while the
/// parent's own child registry still reads empty.
#[test]
fn new_session_keeps_a_created_root_session_running() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let socket = dir.path().join("supervisor.sock");
    let receipts = dir.path().join("receipts");
    std::fs::create_dir_all(&receipts).expect("receipts dir");
    let create_receipt = receipts.join("create.json");
    let create_error = receipts.join("create.error");

    let child_script = write_child_script(dir.path());
    let parent_script = write_parent_script(
        dir.path(),
        &create_session_cell(&create_receipt, &create_error),
        "pass",
    );
    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    let parent = create_parent(&mut client, dir.path(), &parent_script, &child_script, "c1");
    let parent_id = parent["activeSessionId"]
        .as_str()
        .or_else(|| parent["id"].as_str())
        .expect("parent active session id")
        .to_string();

    // Turn 1: the kernel cell creates the depth-0 root session.
    run_turn(&mut client, &parent_id, "create the root session", "t1");
    let created: Value =
        serde_json::from_str(&await_receipt(&create_receipt)).expect("create receipt json");
    assert_eq!(
        created["name"], "rootkid",
        "the create_session handle must carry the session name: {created}"
    );
    assert!(
        !create_error.exists(),
        "the create_session cell failed: {}",
        std::fs::read_to_string(&create_error).unwrap_or_default()
    );
    wait_until(&mut client, Duration::from_secs(30), |client| {
        roster_summaries(client, "l1")
            .into_iter()
            .find(|summary| summary["sessionName"] == json!("rootkid"))
    });

    // The replacement closes the parent's children only.
    client.send_command(
        "n1",
        json!({ "type": "new_session", "activeSessionId": parent_id }),
    );
    let replaced = client.read_response("n1");
    assert_eq!(replaced["success"], true, "new_session failed: {replaced}");
    let rows = rlm_children_rows(&mut client, "g1", &parent_id);
    assert!(
        rows.is_empty(),
        "the replacement session's roster must start empty: {rows:?}"
    );
    // The created root session is still resident and running: the close
    // touches parent-linked children only (TS `getChildActiveSessionStates`).
    let survivor = wait_until(&mut client, Duration::from_secs(30), |client| {
        roster_summaries(client, "l2")
            .into_iter()
            .find(|summary| summary["sessionName"] == json!("rootkid"))
    });
    assert_ne!(
        survivor["activeSessionId"],
        json!(parent_id),
        "the created root session is its own session, not the parent's"
    );
}
