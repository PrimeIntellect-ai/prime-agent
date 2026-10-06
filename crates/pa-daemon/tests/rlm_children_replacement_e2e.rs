//! RLM children lifecycle on parent runtime replacement (the #237 flagged
//! TS divergence): TS `teardownForReplacement` closes the parent-linked RLM
//! children and the replacement session's roster starts empty;
//! `rlm.create_session` root sessions are not parent-linked and survive.
// Stack-resident futures by design on the daemon's hot paths.
#![allow(clippy::large_futures)]
// Narrowing casts sit at OS boundaries (pid/fd/time/size) where the kernel
// bounds the values.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// Style gate only, not correctness.
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
        // Hermetic agent dir: the ambient environment exports a real one.
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .env_remove("PRIME_API_KEY")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // A supervisor killed at teardown must not leak its session workers
        // into later test binaries: the worker's supervisor-lost exit runs
        // on this short window instead of the 5-minute default.
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
        "kernel python {} not found; skipping live RLM children replacement e2e",
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

fn roster_summaries(client: &mut Client, id: &str) -> Vec<Value> {
    client.send_command(id, &json!({ "type": "list" }));
    let list = client.read_response(id);
    assert_eq!(list["success"], true, "list failed: {list}");
    list["data"]["sessions"]
        .as_array()
        .cloned()
        .expect("sessions array")
}

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

/// The kernel cell: spawn one RLM child through the product `rlm.spawn` surface.
fn spawn_cell(receipt: &Path, error_receipt: &Path) -> String {
    format!(
        "import json, traceback\ntry:\n    handle = await rlm.spawn(\"run the lane task\", name=\"kid\")\n    open({receipt:?}, \"w\").write(json.dumps({{\"rlm_child_id\": handle.rlm_child_id}}))\n    print(handle.rlm_child_id)\nexcept Exception:\n    open({error_receipt:?}, \"w\").write(traceback.format_exc())\n    raise",
        receipt = receipt.display().to_string(),
        error_receipt = error_receipt.display().to_string(),
    )
}

/// The kernel cell: the replacement session's `rlm.list_subagents()` roster,
/// recorded verbatim.
fn roster_cell(receipt: &Path, error_receipt: &Path) -> String {
    format!(
        "import inspect, traceback\ntry:\n    roster = rlm.list_subagents()\n    if inspect.isawaitable(roster):\n        roster = await roster\n    open({receipt:?}, \"w\").write(repr(roster))\n    print(repr(roster))\nexcept Exception:\n    open({error_receipt:?}, \"w\").write(traceback.format_exc())\n    raise",
        receipt = receipt.display().to_string(),
        error_receipt = error_receipt.display().to_string(),
    )
}

/// The probe cell: the restarted parent's roster rows, then a send to the child.
fn probe_cell(list_receipt: &Path, send_receipt: &Path, error_receipt: &Path) -> String {
    format!(
        "import inspect, json, traceback\ntry:\n    roster = rlm.list_subagents()\n    if inspect.isawaitable(roster):\n        roster = await roster\n    rows = [[s.rlm_child_id, s.status, s.active_session_id] for s in roster]\n    open({list:?}, \"w\").write(json.dumps(rows))\n    receipt = await agent_message.send(\"boot-ping\", receiver_role=\"child\", receiver_name=\"kid\")\n    open({send:?}, \"w\").write(json.dumps(receipt))\n    print(rows, receipt)\nexcept Exception:\n    open({error:?}, \"w\").write(traceback.format_exc())\n    raise",
        list = list_receipt.display().to_string(),
        send = send_receipt.display().to_string(),
        error = error_receipt.display().to_string(),
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

/// One held response keeps the child's task turn running while the
/// replacement fires, so the close lands on a live child.
fn write_child_script(dir: &Path) -> PathBuf {
    let script = dir.join("child.json");
    std::fs::write(
        &script,
        // The delay keeps the kid live at the replacement close (the test's
        // stated intent: the death close lands on a live child), but must
        // fit inside the kill route's budget: the child's kill handler
        // blocks behind its running turn (the turn holds the worker core
        // across the provider wait), so the close completes only after the
        // hold ends. 3s keeps the kid streaming at the close and settles
        // the kill well inside the budget; the previous 30s hold was dead
        // config while the childScript seam was broken (the kid never ran
        // the script) and only became live with that seam's fix.
        json!({ "responses": [ { "text": "kid still working", "delayMs": 3_000 } ] }).to_string(),
    )
    .expect("write child script");
    script
}

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

/// The create's `childScript` harness seam makes every `rlm.spawn` child a
/// scripted worker.
fn create_parent(
    client: &mut Client,
    dir: &Path,
    parent_script: &Path,
    child_script: &Path,
    session_path: Option<&Path>,
    id: &str,
) -> Value {
    let sessions_dir = dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let mut create = json!({
        "type": "create",
        "name": "parent",
        "config": {
            "cwd": dir.to_string_lossy(),
            "sessionDir": sessions_dir.to_string_lossy(),
            "script": parent_script.to_string_lossy(),
            "childScript": child_script.to_string_lossy(),
        },
    });
    if let Some(path) = session_path {
        create["sessionPath"] = json!(path.to_string_lossy());
    }
    client.send_command(id, &create);
    let created = client.read_response(id);
    assert_eq!(created["success"], true, "create parent failed: {created}");
    created["data"].clone()
}

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
    let parent = create_parent(
        &mut client,
        dir.path(),
        &parent_script,
        &child_script,
        None,
        "c1",
    );
    let parent_id = parent["activeSessionId"]
        .as_str()
        .or_else(|| parent["id"].as_str())
        .expect("parent active session id")
        .to_string();
    let parent_session_id = parent["sessionId"].as_str().expect("parent session id");

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

    client.send_command(
        "n1",
        &json!({ "type": "new_session", "activeSessionId": parent_id }),
    );
    let replaced = client.read_response("n1");
    assert_eq!(replaced["success"], true, "new_session failed: {replaced}");

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
    // TS `closeSessionOnce("replaced")` archives the child session: its
    // session file records it.
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

/// `rlm.create_session` root sessions are NOT parent-linked, so
/// `closeChildSessions` never matches them.
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
    let parent = create_parent(
        &mut client,
        dir.path(),
        &parent_script,
        &child_script,
        None,
        "c1",
    );
    let parent_id = parent["activeSessionId"]
        .as_str()
        .or_else(|| parent["id"].as_str())
        .expect("parent active session id")
        .to_string();

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

    client.send_command(
        "n1",
        &json!({ "type": "new_session", "activeSessionId": parent_id }),
    );
    let replaced = client.read_response("n1");
    assert_eq!(replaced["success"], true, "new_session failed: {replaced}");
    let rows = rlm_children_rows(&mut client, "g1", &parent_id);
    assert!(
        rows.is_empty(),
        "the replacement session's roster must start empty: {rows:?}"
    );
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

/// A daemon restart must not lose the parent's RLM children: the
/// reattached parent lists its child again and messaging it wakes the child.
#[test]
fn a_daemon_restart_relists_and_wakes_the_parents_child() {
    restart_relists_child(0, "completed");
}

#[test]
fn a_daemon_restart_marks_a_still_running_child_as_failed() {
    restart_relists_child(30_000, "running");
}

fn restart_relists_child(delay_ms: u64, display_status: &str) {
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
    let list_receipt = receipts.join("list.json");
    let send_receipt = receipts.join("send.json");
    let probe_error = receipts.join("probe.error");

    let child_script = dir.path().join("child.json");
    std::fs::write(
        &child_script,
        json!({ "responses": [ { "text": "kid done", "delayMs": delay_ms } ] }).to_string(),
    )
    .expect("write child script");
    let parent_script = write_parent_script(
        dir.path(),
        &spawn_cell(&spawn_receipt, &spawn_error),
        "pass",
    );
    let mut daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    let parent = create_parent(
        &mut client,
        dir.path(),
        &parent_script,
        &child_script,
        None,
        "c1",
    );
    let parent_id = parent["activeSessionId"]
        .as_str()
        .or_else(|| parent["id"].as_str())
        .expect("parent active session id")
        .to_string();
    let parent_session_id = parent["sessionId"].as_str().expect("parent session id");
    let parent_file = parent["sessionFile"]
        .as_str()
        .expect("parent session file")
        .to_string();

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
    let supervisor_row = wait_until(&mut client, Duration::from_secs(30), |client| {
        roster_summaries(client, "l1").into_iter().find(|summary| {
            summary["sessionName"] == json!("kid") && summary["runtimeKind"] == "subagent"
        })
    });
    let child_session_id = supervisor_row["sessionId"]
        .as_str()
        .expect("child session id")
        .to_string();
    let child_file = agent_dir
        .join("session-artifacts")
        .join(parent_session_id)
        .join(&child_id)
        .join(format!("{child_session_id}.jsonl"));
    let display_file = child_file.parent().unwrap().join("rlm-subagent.json");
    if delay_ms > 0 {
        wait_until(&mut client, Duration::from_secs(30), |client| {
            let rows = rlm_children_rows(client, "g-running", &parent_id);
            rows.iter()
                .any(|row| row["id"] == child_id && row["status"] == "running")
                .then_some(())
        });
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let display: Value =
            serde_json::from_slice(&std::fs::read(&display_file).expect("child display file"))
                .expect("child display json");
        if display["status"] == display_status {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "child display never completed: {display}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }

    client.send_command("bye", &json!({ "type": "shutdown" }));
    let deadline = Instant::now() + Duration::from_secs(30);
    while daemon
        .child
        .try_wait()
        .expect("wait for the supervisor exit")
        .is_none()
    {
        assert!(Instant::now() < deadline, "the supervisor never exited");
        std::thread::sleep(Duration::from_millis(50));
    }
    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    let probe_script = write_parent_script(
        dir.path(),
        &probe_cell(&list_receipt, &send_receipt, &probe_error),
        "pass",
    );
    let parent = create_parent(
        &mut client,
        dir.path(),
        &probe_script,
        &child_script,
        Some(Path::new(&parent_file)),
        "c2",
    );
    let new_parent_id = parent["activeSessionId"]
        .as_str()
        .or_else(|| parent["id"].as_str())
        .expect("parent active session id")
        .to_string();

    run_turn(
        &mut client,
        &new_parent_id,
        "probe the restarted roster",
        "t2",
    );
    assert!(
        !probe_error.exists(),
        "the probe cell failed: {}",
        std::fs::read_to_string(&probe_error).unwrap_or_default()
    );
    // (a) relisted
    let rows: Value =
        serde_json::from_str(&await_receipt(&list_receipt)).expect("list receipt json");
    assert_eq!(
        rows,
        json!([[
            child_id,
            if display_status == "completed" {
                "completed"
            } else {
                "error"
            },
            child_session_id
        ]]),
        "the restarted parent must relist its ledger child with its persisted status"
    );
    // (b) send receipt
    let _send: Value =
        serde_json::from_str(&await_receipt(&send_receipt)).expect("send receipt json");
    // (c) wake oracle
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let content = std::fs::read_to_string(&child_file).unwrap_or_default();
        if content.contains("boot-ping") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the send never woke the child into its session file: {content}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    // (d) child runtime
    client.send_command(
        "gs",
        &json!({ "type": "get_state", "activeSessionId": child_session_id }),
    );
    let state = client.read_response("gs");
    assert_eq!(state["success"], true, "get_state failed: {state}");
    assert_eq!(state["data"]["rlmChildId"], json!(child_id));
    assert_eq!(state["data"]["rlmDepth"], json!(1));
    assert_eq!(state["data"]["parentSessionPath"], json!(parent_file));
}
