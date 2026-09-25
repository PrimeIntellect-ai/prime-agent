//! RLM children lifecycle on a hard-killed parent worker: the supervisor's
//! parent-death cleanup e2e (the #246 documented adjacent gap).
//!
//! TS ground truth (`packages/coding-agent/src/modes/daemon/daemon-mode.ts`):
//! RLM children are hosted IN the parent's process, so they die with it -
//! a SIGKILLed parent session takes its children down, and the durable
//! spawn ledger keeps each closed child as a passive roster row
//! (`getChildActiveSessionStates` joins children by
//! `metadata.parentActiveSessionId`; `closeChildSessions` is the cascade).
//! The Rust redesign hosts each child as its own supervisor-owned worker
//! process, and the #246 close runs inside the parent worker's teardown
//! paths - all bypassed by SIGKILL. So the supervisor's worker-death
//! monitoring performs the close: on an unexpected exit, every resident
//! worker whose durable create names the dead worker as its parent stops
//! with it (a plain stop like the #246 close: no ledger tombstone, so the
//! spawn edge and the passive roster row survive), routed through the
//! child worker's own kill handler so grandchildren cascade.
//!
//! Verified end to end against a real supervisor, a real parent worker
//! session whose kernel cell spawns the child through the product
//! `rlm.spawn` surface, and a scripted child worker kept mid-run:
//!
//! 1. SIGKILLing the parent worker closes the spawned child: its worker
//!    leaves the supervisor roster, its session file archives, the
//!    respawned parent's `get_rlm_children` reads empty, and the `list
//!    --all` surface shows the child as a passive ledger row (the spawn
//!    edge survived - the close is a stop, not a delete).
//! 2. SIGKILLing the parent KEEPS an `rlm.create_session` depth-0 root
//!    session running: the close touches parent-linked children only.
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
    let candidate = PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
        |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
    ));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!("kernel python {candidate:?} not found; skipping live RLM parent-death e2e");
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

/// The supervisor roster's resident session summaries (the plain `list`
/// wire surface).
fn roster_summaries(client: &mut Client, id: &str) -> Vec<Value> {
    client.send_command(id, json!({ "type": "list" }));
    let list = client.read_response(id);
    assert_eq!(list["success"], true, "list failed: {list}");
    list["data"]["sessions"]
        .as_array()
        .cloned()
        .expect("sessions array")
}

/// The `list --all` surface: resident summaries plus the passive ledger
/// rows (TS `buildSessionList`).
fn all_roster_summaries(client: &mut Client, id: &str) -> Vec<Value> {
    client.send_command(id, json!({ "type": "list", "all": true }));
    let list = client.read_response(id);
    assert_eq!(list["success"], true, "list --all failed: {list}");
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
/// running while the parent dies, so the death close lands on a live child
/// (TS closes running children - abort, archive, dispose).
fn write_child_script(dir: &Path) -> PathBuf {
    let script = dir.join("child.json");
    std::fs::write(
        &script,
        json!({ "responses": [ { "text": "kid still working", "delayMs": 30_000 } ] }).to_string(),
    )
    .expect("write child script");
    script
}

/// The parent's faux script whose turns run the spawn cell.
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

/// The parent worker's process id, read from its durable descriptor (the
/// supervisor persists the live pid at every spawn). The environ check
/// guards the kill against a stale pid: the process we SIGKILL must be
/// the worker that owns `parent_id`.
fn parent_worker_pid(agent_dir: &Path, socket: &Path, parent_id: &str) -> u32 {
    let descriptor_path =
        pa_daemon::descriptor::descriptor_dir(agent_dir, socket).join(format!("{parent_id}.json"));
    let descriptor: Value = serde_json::from_str(
        &std::fs::read_to_string(&descriptor_path)
            .unwrap_or_else(|_| panic!("read parent descriptor {descriptor_path:?}")),
    )
    .expect("parent descriptor json");
    let pid = descriptor["pid"].as_u64().expect("descriptor pid") as u32;
    let environ = std::fs::read_to_string(format!("/proc/{pid}/environ"))
        .unwrap_or_else(|_| panic!("read /proc/{pid}/environ"));
    assert!(
        environ.contains(&format!("={parent_id}\0"))
            && environ.contains(pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV),
        "pid {pid} is not the worker for session {parent_id}"
    );
    pid
}

/// SIGKILL the parent worker (the failure class that bypasses every
/// worker-side close path).
fn sigkill(pid: u32) {
    let status = Command::new("kill")
        .arg("-9")
        .arg(pid.to_string())
        .status()
        .expect("run kill");
    assert!(status.success(), "kill -9 {pid} failed: {status}");
}

/// A parent worker killed with SIGKILL cannot run any teardown (#246's
/// closes all live in the worker), so the supervisor's death monitoring
/// closes its resident children: the spawned child's worker leaves the
/// roster, its session archives, the respawned parent's registry reads
/// empty, and the child stays visible as a passive ledger row (the close
/// is a plain stop - the spawn edge survives, no delete record).
#[test]
fn sigkill_closes_the_spawned_child_and_passivates_the_row() {
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

    let child_script = write_child_script(dir.path());
    let parent_script = write_parent_script(dir.path(), &spawn_cell(&spawn_receipt, &spawn_error));
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
    // tracked in the parent's registry.
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

    // The hard kill: SIGKILL bypasses every worker-side close path.
    let pid = parent_worker_pid(&agent_dir, &socket, &parent_id);
    sigkill(pid);

    // The supervisor's death monitoring closes the child: its worker
    // leaves the resident roster.
    wait_until(&mut client, Duration::from_mins(1), |client| {
        let summaries = roster_summaries(client, "l2");
        summaries
            .iter()
            .all(|summary| summary["activeSessionId"] != json!(child_active_session_id))
            .then_some(())
    });

    // The close is the shutdown-close shape (TS's in-process child dies
    // with its parent worker without a close; the Rust worker must be
    // told, and the `shutdown` reason keeps the child's resume entry):
    // the child's session file keeps its live state and its scheduled
    // jobs, so the wake model can still own reviving it later — it is
    // NOT archived like a killed close (the stop lifecycle lane).
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
        !child_session.contains("\"archived\""),
        "the parent-death close keeps the child's resume entry (no archive): {child_session}"
    );

    // The respawned parent's registry is fresh: the parent died before it
    // could track anything, and the death close owns its children now.
    // (get_rlm_children fails while the worker restarts; poll for the
    // respawned answer.)
    wait_until(&mut client, Duration::from_mins(1), |client| {
        client.send_command(
            "g3",
            json!({ "type": "get_rlm_children", "activeSessionId": parent_id }),
        );
        let response = client.read_response("g3");
        (response["success"] == true
            && response["data"]["children"]
                .as_array()
                .is_some_and(std::vec::Vec::is_empty))
        .then_some(())
    });

    // The passive row per TS: the spawn edge survived the close (a stop,
    // not a delete), so `list --all` shows the child as a passive ledger
    // row under the parent.
    let passive_row = wait_until(&mut client, Duration::from_secs(30), |client| {
        all_roster_summaries(client, "l3")
            .into_iter()
            .find(|summary| summary["rlmChildId"] == json!(child_id))
    });
    assert_eq!(passive_row["sessionName"], "kid");
    assert_eq!(passive_row["runtimeKind"], "subagent");
    assert_eq!(passive_row["isSessionActive"], false);
    assert_eq!(passive_row["parentActiveSessionId"], json!(parent_id));

    // The ledger carried the close as a stop, never a delete: the spawn
    // record stands and no tombstone exists.
    let ledger_dir = agent_dir.join(pa_daemon::rlm_ledger::RLM_LEDGER_DIR);
    let ledger = std::fs::read_dir(&ledger_dir)
        .expect("ledger dir")
        .filter_map(std::result::Result::ok)
        .map(|entry| std::fs::read_to_string(entry.path()).unwrap_or_default())
        .find(|content| content.contains(&child_id))
        .expect("the spawn ledger holds the child edge");
    assert!(
        ledger.contains("\"op\":\"spawn\""),
        "the spawn record must survive: {ledger}"
    );
    assert!(
        !ledger.contains("\"op\":\"delete\""),
        "a parent-death close is a stop, never a ledger delete: {ledger}"
    );
}

/// `rlm.create_session` depth-0 root sessions are NOT parent-linked (TS
/// `createRlmRootSession` builds a root `ActiveSessionState` with no
/// `parentActiveSessionId`), so `getChildActiveSessionStates` never
/// matches them: a created root session survives the parent's hard death
/// (the supervisor restarts the parent and the root keeps running),
/// while the parent's own registry reads empty.
#[test]
fn sigkill_keeps_a_created_root_session_running() {
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
    let root_active_session_id = wait_until(&mut client, Duration::from_secs(30), |client| {
        roster_summaries(client, "l1")
            .into_iter()
            .find(|summary| summary["sessionName"] == json!("rootkid"))
            .map(|summary| {
                summary["activeSessionId"]
                    .as_str()
                    .expect("root active session id")
                    .to_string()
            })
    });

    // The hard kill: the supervisor restarts the parent, and its death
    // close touches parent-linked children only.
    let pid = parent_worker_pid(&agent_dir, &socket, &parent_id);
    sigkill(pid);
    // The respawn (and with it the death close) settles before the
    // registry reads empty.
    wait_until(&mut client, Duration::from_mins(1), |client| {
        client.send_command(
            "g1",
            json!({ "type": "get_rlm_children", "activeSessionId": parent_id }),
        );
        let response = client.read_response("g1");
        (response["success"] == true
            && response["data"]["children"]
                .as_array()
                .is_some_and(std::vec::Vec::is_empty))
        .then_some(())
    });

    // The created root session is still resident and running: the close
    // touches parent-linked children only (TS `getChildActiveSessionStates`).
    let survivor = wait_until(&mut client, Duration::from_secs(30), |client| {
        roster_summaries(client, "l2")
            .into_iter()
            .find(|summary| summary["activeSessionId"] == json!(root_active_session_id))
    });
    assert_eq!(survivor["sessionName"], "rootkid");
}
