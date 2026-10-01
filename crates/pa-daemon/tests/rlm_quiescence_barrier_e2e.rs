//! The worker's RLM quiescence barrier e2e (`wait_for_headless_completion`
//! with `waitForRlmQuiescence`, the `rlm_quiescence_barrier` capability the
//! worker advertises).
//!
//! TS ground truth - `packages/coding-agent/src/modes/headless-completion.ts`
//! settles `waitForHeadlessCompletion({ waitForRlmQuiescence: true })` through
//! `core/agent-session.ts` `waitForRlmQuiescence()`, so the barrier owns the
//! parent's own idle FIRST, then every admitted descendant run's settlement,
//! and it loops back through the idle wait because work may start at the
//! child-settlement boundary (a settled child's terminal notice queues a
//! parent turn). A barrier without the flag - and the pre-fix worker, which
//! ignored the flag - answers at the parent's idle while a child run is
//! still in flight.
//!
//! Verified end to end against a real supervisor, a real parent worker
//! session whose kernel cell spawns the child through the product
//! `rlm.spawn` surface, and a scripted child worker held mid-run.
//!
//! 1. `wait_for_headless_completion` with `waitForRlmQuiescence: true`
//!    answers only after the held child turn settles and the terminal
//!    notice it queues on the parent drains: the parent's
//!    `get_rlm_children` reports the child terminal and its messages
//!    carry the notice turn at answer time. The pre-fix worker answered
//!    at the parent's idle (elapsed milliseconds) with the child still
//!    running.
//! 2. The barrier reads the run's settlement, not the roster status:
//!    the roster flips terminal inside the watcher's settle grace,
//!    ~250ms before the run's settle funnel, so a barrier sent once the
//!    roster says `done` still holds for the terminal notice's parent
//!    turn. A status-reading barrier answers inside that window.
//!
//! The parent's kernel Python is ambient product state; like the other
//! live-kernel verifiers these tests skip (with a note) on machines
//! without a live install.
// Pedantic-gate dispositions (fleet-uniform ruling; see this lane's PR for
// the full rationale): the timeout panic path cannot wait on the supervisor
// child; the test process exits immediately afterwards, reaping it.
#![allow(clippy::zombie_processes)]
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
/// `PA_E2E_KERNEL_PYTHON` to point at an explicit interpreter instead.
fn kernel_python() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PA_E2E_KERNEL_PYTHON") {
        let explicit = PathBuf::from(explicit);
        assert!(
            explicit.exists(),
            "PA_E2E_KERNEL_PYTHON {} not found",
            explicit.display()
        );
        return Some(explicit);
    }
    let candidate = PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
        |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
    ));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!(
        "kernel python {} not found; skipping live RLM quiescence e2e",
        candidate.display()
    );
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
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(120);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => {}
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
        let deadline = Instant::now() + Duration::from_secs(240);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

/// The parent's tracked-children wire surface (`get_rlm_children`).
fn rlm_children_rows(client: &mut Client, id: &str, parent: &str) -> Vec<Value> {
    client.send_command(
        id,
        &json!({ "type": "get_rlm_children", "activeSessionId": parent }),
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
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": message }),
    );
    let prompted = client.read_response(id);
    assert_eq!(prompted["success"], true, "prompt failed: {prompted}");
    let idle_id = format!("{id}-idle");
    client.send_command(
        &idle_id,
        &json!({ "type": "wait_for_idle", "activeSessionId": session_id }),
    );
    let idle = client.read_response(&idle_id);
    assert_eq!(idle["success"], true, "wait_for_idle failed: {idle}");
}

/// Poll until a kernel cell's receipt content appears (the cell writes its
/// verdict).
fn await_receipt(receipt: &Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(60);
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

/// The child's scripted engine: one held response keeps its task turn
/// running past the parent's idle, so the barrier must own it.
fn write_child_script(dir: &Path) -> PathBuf {
    let script = dir.join("child.json");
    std::fs::write(
        &script,
        json!({ "responses": [ { "text": "kid done", "delayMs": 5_000 } ] }).to_string(),
    )
    .expect("write child script");
    script
}

/// The parent's faux script whose turns run the spawn cell; the third
/// response answers the settled child's terminal-notice turn (the no-reply
/// notice the watcher queues on the parent).
fn write_parent_script(dir: &Path, first_cell: &str) -> PathBuf {
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
                { "text": "notice seen" },
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
        &json!({
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

/// The parent's messages as one JSON string (the barrier's answer-time
/// transcript read).
fn messages_text(client: &mut Client, id: &str, parent_id: &str) -> String {
    client.send_command(
        id,
        &json!({ "type": "get_messages", "activeSessionId": parent_id }),
    );
    client.read_response(id)["data"].to_string()
}

/// One scripted lane with a held scripted child (the shared setup of the
/// barrier tests): the parent went idle with the child's 5s held turn in
/// flight, ready for the barrier.
struct HeldChildLane {
    _daemon: Daemon,
    _dir: tempfile::TempDir,
    client: Client,
    parent_id: String,
    child_id: String,
}

fn spawn_held_child_lane(kernel_python: &Path) -> HeldChildLane {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let socket = dir.path().join("supervisor.sock");
    let receipts = dir.path().join("receipts");
    std::fs::create_dir_all(&receipts).expect("receipts dir");
    let spawn_receipt = receipts.join("spawn.json");
    let spawn_error = receipts.join("spawn.error");

    let child_script = write_child_script(dir.path());
    let parent_script = write_parent_script(dir.path(), &spawn_cell(&spawn_receipt, &spawn_error));
    let daemon = spawn_supervisor(&socket, &agent_dir, kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    let parent = create_parent(&mut client, dir.path(), &parent_script, &child_script, "c1");
    let parent_id = parent["activeSessionId"]
        .as_str()
        .expect("parent active session id")
        .to_string();

    // Turn 1: the kernel cell spawns the child through the parent's own
    // registry; the parent settles while the child's held turn runs on.
    run_turn(&mut client, &parent_id, "spawn the kid", "t1");
    let spawned: Value =
        serde_json::from_str(&await_receipt(&spawn_receipt)).expect("spawn receipt json");
    let child_id = spawned["rlm_child_id"]
        .as_str()
        .expect("child id")
        .to_string();
    assert!(
        !spawn_error.exists(),
        "the spawn cell failed: {}",
        std::fs::read_to_string(&spawn_error).unwrap_or_default()
    );
    HeldChildLane {
        _daemon: daemon,
        _dir: dir,
        client,
        parent_id,
        child_id,
    }
}

/// `wait_for_headless_completion` with `waitForRlmQuiescence: true` owns
/// descendant work (TS `waitForRlmQuiescence`): the parent goes idle while
/// the spawned child's 5s held turn still runs, and the barrier must
/// answer only after that turn settles and the terminal notice it queues
/// on the parent drains - the registry reports the child terminal, and
/// the parent's messages carry the notice turn at answer time. The
/// pre-fix worker ignored the flag and answered at the parent's idle,
/// with the child still running.
#[test]
fn headless_completion_waits_for_rlm_quiescence() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let mut lane = spawn_held_child_lane(&kernel_python);

    // The barrier request on the idle parent: the child's 5s hold is
    // unsettled descendant work, so the answer must hold past it.
    lane.client.send_command(
        "w1",
        &json!({
            "type": "wait_for_headless_completion",
            "activeSessionId": lane.parent_id,
            "waitForRlmQuiescence": true,
        }),
    );
    let completion = lane.client.read_response("w1");
    assert_eq!(
        completion["success"], true,
        "wait_for_headless_completion failed: {completion}"
    );

    // The answer lands only after the child's held turn settled and the
    // terminal notice's parent turn drained.
    let messages = messages_text(&mut lane.client, "m1", &lane.parent_id);
    assert!(
        messages.contains("notice seen"),
        "the barrier answered before the terminal-notice turn drained"
    );
    let rows = rlm_children_rows(&mut lane.client, "g1", &lane.parent_id);
    let child_row = rows
        .iter()
        .find(|row| row["id"] == json!(lane.child_id))
        .expect("the spawned child's roster row");
    assert_eq!(
        child_row["status"], "done",
        "the barrier answered while the child was still running"
    );
}

/// The barrier reads the run's settlement, not the roster status: the
/// roster flips terminal inside the watcher's settle grace, and the
/// record only settles at the settle funnel - after the grace re-check,
/// the usage emit, and the terminal-notice delivery (TS keeps
/// `run.status` and `run.settled`, set in the run's `finally`, apart). A
/// barrier sent once the roster says `done` must still hold for the
/// terminal notice's parent turn; a status-reading barrier answers
/// inside the settle window.
#[test]
fn headless_completion_holds_through_the_settle_window() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let mut lane = spawn_held_child_lane(&kernel_python);

    // The roster's terminal status is the settle window's start: the
    // roster says `done` here while the child's run has not settled yet.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let rows = rlm_children_rows(&mut lane.client, "g1", &lane.parent_id);
        let row = rows
            .iter()
            .find(|row| row["id"] == json!(lane.child_id))
            .expect("the spawned child's roster row");
        if row["status"] != "running" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the child never reached a terminal roster status"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    lane.client.send_command(
        "w1",
        &json!({
            "type": "wait_for_headless_completion",
            "activeSessionId": lane.parent_id,
            "waitForRlmQuiescence": true,
        }),
    );
    let completion = lane.client.read_response("w1");
    assert_eq!(
        completion["success"], true,
        "wait_for_headless_completion failed: {completion}"
    );
    let messages = messages_text(&mut lane.client, "m1", &lane.parent_id);
    assert!(
        messages.contains("notice seen"),
        "the barrier answered inside the settle window, before the terminal-notice turn drained"
    );
}
