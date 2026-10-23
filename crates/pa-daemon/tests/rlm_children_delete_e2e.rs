//! The delete-turn e2e: a live child deleted through the product
//! `rlm.delete_subagent` surface mid-turn records its `child_cancelled`
//! line (with the `parent_delete` reason) on the parent's ledger — a
//! deleted running child leaves a cancel line, not a clean disappearance.
//! The harness is the self-contained supervisor/client scaffolding this
//! suite's e2e files each carry. Tests skip without a live kernel install.
// Fn length is a style gate, not correctness.
#![allow(clippy::too_many_lines)]
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_core::session_engine::semantic_edges::{
    ChildCancelledReason, SemanticEdgeLedgerEvent as LedgerEvent,
};

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
        // A supervisor killed at teardown must not leak its session workers into later
        // test binaries: the supervisor-lost exit runs here.
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

/// The kernel Python; `PA_E2E_KERNEL_PYTHON` points at an explicit interpreter instead.
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
        "kernel python {} not found; skipping live RLM delete e2e",
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
        let deadline = Instant::now() + Duration::from_mins(2);
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

/// Poll for a kernel cell's receipt content (the cell writes its verdict;
/// an empty read is the create-before-write window, not a verdict yet).
fn await_receipt(receipt: &Path) -> String {
    let deadline = Instant::now() + Duration::from_mins(1);
    loop {
        if let Ok(content) = std::fs::read_to_string(receipt) {
            if !content.is_empty() {
                return content;
            }
        }
        assert!(
            Instant::now() < deadline,
            "kernel cell receipt never appeared at {}",
            receipt.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

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

fn semantic_spawn_cell(receipt: &Path, error_receipt: &Path) -> String {
    format!(
        "import json, traceback\ntry:\n    handle = await rlm.spawn(\"child task text\", name=\"kid\")\n    open({receipt:?}, \"w\").write(json.dumps({{\"rlm_child_id\": handle.rlm_child_id, \"session_dir\": str(handle.session_dir)}}))\n    print(handle.rlm_child_id)\nexcept Exception:\n    open({error_receipt:?}, \"w\").write(traceback.format_exc())\n    raise",
        receipt = receipt.display().to_string(),
        error_receipt = error_receipt.display().to_string(),
    )
}

/// Parse one semantic-edge ledger file into its events. A file that does
/// not exist yet reads as empty: the settle poll runs ahead of the
/// parent's return recording.
fn semantic_ledger(path: &Path) -> Vec<LedgerEvent> {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    contents
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).expect("ledger line"))
        .collect()
}

/// The durable session id the child's `session_registered` names (the
/// parent-side `child_returned` assertions pin the same id across both
/// ledgers).
fn child_ledger_session_id(ledger: &[LedgerEvent]) -> String {
    ledger
        .iter()
        .find_map(|event| match event {
            LedgerEvent::SessionRegistered { session_id, .. } => Some(session_id.clone()),
            _ => None,
        })
        .expect("the child ledger registered its session")
}

/// The kernel cell of the delete turn: delete the spawned child through
/// the product `rlm.delete_subagent` surface and record its verdict.
fn semantic_delete_cell(
    spawn_receipt: &Path,
    delete_receipt: &Path,
    delete_error: &Path,
) -> String {
    format!(
        "import json, traceback\ntry:\n    child = json.load(open({spawn_receipt:?}))\n    sub = await rlm.delete_subagent(child[\"rlm_child_id\"])\n    open({delete_receipt:?}, \"w\").write(json.dumps({{\"status\": sub.status, \"rlm_child_id\": sub.rlm_child_id}}))\n    print(sub.status)\nexcept Exception:\n    open({delete_error:?}, \"w\").write(traceback.format_exc())\n    raise",
        spawn_receipt = spawn_receipt.display().to_string(),
        delete_receipt = delete_receipt.display().to_string(),
        delete_error = delete_error.display().to_string(),
    )
}

/// The parent's faux script whose two turns run the spawn cell, then the
/// delete cell (each toolCall turn ends with its own text response).
fn write_two_turn_parent_script(dir: &Path, first_cell: &str, second_cell: &str) -> PathBuf {
    let script = dir.join("parent.json");
    std::fs::write(
        &script,
        json!({
            "engine": "faux",
            "responses": [
                { "content": [
                    { "type": "toolCall", "name": "python_repl", "arguments": { "code": first_cell } },
                ] },
                { "text": "spawn turn done" },
                { "content": [
                    { "type": "toolCall", "name": "python_repl", "arguments": { "code": second_cell } },
                ] },
                { "text": "delete turn done" },
            ],
        })
        .to_string(),
    )
    .expect("write parent script");
    script
}

/// A delete that kills a live run records the cancel edge on the parent's
/// ledger (nano-rlm #202's delete gap): the `rlm.delete_subagent` tool runs
/// mid-turn, so the `child_cancelled` line anchors to that deleting request
/// and lands before the deleting turn commits — a deleted child leaves a
/// cancel line, not a clean disappearance, and a cut-short run never
/// records a `child_returned` one.
#[test]
fn a_deleted_running_child_records_the_cancel_edge() {
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
    let delete_receipt = receipts.join("delete.json");
    let delete_error = receipts.join("delete.error");

    // The child's delayed reply keeps its task turn running while the
    // delete lands (a live run the parent cuts short).
    let child_script = dir.path().join("child.json");
    std::fs::write(
        &child_script,
        json!({
            "engine": "faux",
            "responses": [ { "text": "child reply", "delayMs": 30_000 } ],
        })
        .to_string(),
    )
    .expect("write child script");
    let parent_script = write_two_turn_parent_script(
        dir.path(),
        &semantic_spawn_cell(&spawn_receipt, &spawn_error),
        &semantic_delete_cell(&spawn_receipt, &delete_receipt, &delete_error),
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
    let parent_session_id = parent["sessionId"]
        .as_str()
        .expect("parent session id")
        .to_string();
    let parent_session_file = parent["sessionFile"]
        .as_str()
        .expect("parent session file")
        .to_string();

    // Turn 1: the kernel cell spawns the child mid-turn.
    run_turn(&mut client, &parent_id, "spawn the kid", "t1");
    let spawned: Value =
        serde_json::from_str(&await_receipt(&spawn_receipt)).expect("spawn receipt json");
    assert!(
        !spawn_error.exists(),
        "the spawn cell failed: {}",
        std::fs::read_to_string(&spawn_error).unwrap_or_default()
    );
    let child_id = spawned["rlm_child_id"]
        .as_str()
        .expect("child id")
        .to_string();
    let child_session_dir = spawned["session_dir"]
        .as_str()
        .expect("child session dir")
        .to_string();

    // Turn 2: the kernel cell deletes the running child mid-turn.
    run_turn(&mut client, &parent_id, "delete the kid", "t2");
    let deleted: Value =
        serde_json::from_str(&await_receipt(&delete_receipt)).expect("delete receipt json");
    assert!(
        !delete_error.exists(),
        "the delete cell failed: {}",
        std::fs::read_to_string(&delete_error).unwrap_or_default()
    );
    assert_eq!(deleted["rlm_child_id"], json!(child_id));
    assert_eq!(
        deleted["status"], "cancelled",
        "a deleted running child reports the cancelled row: {deleted}"
    );

    // The ledger paths are spelled independently of the product's
    // derivation on purpose: byte-compatible LOCATIONS are part of the TS
    // parity contract this e2e pins.
    let parent_ledger_path = std::path::Path::new(&parent_session_file)
        .parent()
        .and_then(Path::parent)
        .map(|sessions| sessions.join("session-artifacts").join(&parent_session_id))
        .map(|artifacts| artifacts.join("semantic-edges.jsonl"))
        .expect("parent ledger path");
    let child_ledger_path = Path::new(&child_session_dir).join("semantic-edges.jsonl");
    // The cancel line lands while the deleting turn is still open; poll
    // until it exists (the same deadline; the terminal shape, not a fixed
    // delay).
    let settle_deadline = Instant::now() + Duration::from_mins(2);
    let (parent_ledger, child_ledger) = loop {
        let parent_ledger = semantic_ledger(&parent_ledger_path);
        let child_ledger = semantic_ledger(&child_ledger_path);
        // The cancel line names its parent-side actor: the delete, not a
        // user cancel or a close walk.
        let cancelled = parent_ledger.iter().any(|event| {
            matches!(
                event,
                LedgerEvent::ChildCancelled { child_session_id, reason: ChildCancelledReason::ParentDelete, .. }
                    if child_session_id == &child_ledger_session_id(&child_ledger)
            )
        });
        if cancelled {
            break (parent_ledger, child_ledger);
        }
        assert!(
            Instant::now() < settle_deadline,
            "the parent never recorded the cancel: parent {parent_ledger:?}; child {child_ledger:?}"
        );
        std::thread::sleep(Duration::from_millis(200));
    };
    // The cancel line names the parent, the child, and the IN-FLIGHT
    // deleting request: the last request the parent started before the
    // cancel line, still open at the line (its commit follows), and never
    // the spawn turn's request (that one committed long before).
    let cancelled_at = parent_ledger
        .iter()
        .position(|event| {
            matches!(
                event,
                LedgerEvent::ChildCancelled {
                    session_id,
                    child_session_id,
                    ..
                } if session_id == &parent_session_id
                    && child_session_id == &child_ledger_session_id(&child_ledger)
            )
        })
        .expect("the parent recorded the child's cancel");
    let (anchored_request, spawning_request) = {
        let anchored_request = match &parent_ledger[cancelled_at] {
            LedgerEvent::ChildCancelled { request_id, .. } => request_id.clone(),
            _ => unreachable!("the position above matched a cancel line"),
        };
        let spawning_request = parent_ledger
            .iter()
            .find_map(|event| match event {
                LedgerEvent::RequestStarted { request_id, .. } => Some(request_id.clone()),
                _ => None,
            })
            .expect("the parent's first request_started");
        (anchored_request, spawning_request)
    };
    assert_ne!(
        anchored_request, spawning_request,
        "the cancel anchors to the deleting turn, not the spawn turn: {parent_ledger:?}"
    );
    // The anchored request is the LAST request the parent started before
    // the cancel line: the deleting turn's request (the one whose tool
    // call ran `rlm.delete_subagent`). A later request — the cancelled
    // child's follow-up notice turn — only starts after the line lands.
    assert!(
        parent_ledger[..cancelled_at]
            .iter()
            .rev()
            .find_map(|event| match event {
                LedgerEvent::RequestStarted { request_id, .. } => Some(request_id.clone()),
                _ => None,
            })
            .is_some_and(|last_started| last_started == anchored_request),
        "the cancel line anchors to the deleting turn's last-started request: {parent_ledger:?}"
    );
    // A cut-short run never returns: no `child_returned` line may name the
    // deleted child.
    assert!(
        parent_ledger.iter().all(|event| {
            !matches!(
                event,
                LedgerEvent::ChildReturned { child_session_id, .. }
                    if child_session_id == &child_ledger_session_id(&child_ledger)
            )
        }),
        "a deleted running child records no return line: {parent_ledger:?}"
    );
}
