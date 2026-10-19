//! Kernel harness-env e2e: a persisted session's kernel must carry the session's RLM
//! session + local-harness dirs in its env (TS `_rlmKernelEnv`), so kernel-side
//! `rlm.harness` writes land in the session-local store. Skips (with a note)
//! without a live kernel install.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

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
        "kernel python {} not found; skipping live kernel-harness-env e2e",
        candidate.display()
    );
    None
}

struct Daemon {
    child: Child,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path, kernel_python: &Path) -> Daemon {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .env("PRIME_AGENT_KERNEL_PYTHON", kernel_python)
        // Hermetic agent dir: point every fallback at the test sandbox.
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        // Hermetic harness resolution: ambient session/harness dirs would
        // mask a missing kernel-env export (the regression this test guards).
        .env_remove("RLM_SESSION_DIR")
        .env_remove("RLM_HARNESS_STATE_DIR")
        .env_remove("RLM_GLOBAL_HARNESS_STATE_DIR")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .spawn()
        .expect("spawn pa-daemon supervisor");
    Daemon { child }
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
        let writer = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
        };
        let hello = client.read_line();
        (client, hello)
    }

    fn send_command(&mut self, id: &str, command: &Value) {
        self.write_line(&json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        }));
    }

    fn write_line(&mut self, value: &Value) {
        let mut line = serde_json::to_string(value).expect("serialize line");
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
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse line"),
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

/// The one scripted cell: create + read back a session-local memory and a global
/// one, recording success or the failure traceback in a receipt.
fn harness_cell(receipt: &Path) -> String {
    format!(
        "import json, traceback\nreceipt = {{\"ok\": False, \"error\": \"\"}}\ntry:\n    rlm.harness.create_memory(title=\"kernel session-local memory\", content=\"persisted from the session kernel\", id=\"kernel-local-memory\")\n    rlm.get_harness_state().entries[\"memory\"][\"kernel-local-memory\"]\n    rlm.harness.create_memory(title=\"kernel global memory\", content=\"persisted from the session kernel\", id=\"kernel-global-memory\", global_=True)\n    receipt = {{\"ok\": True, \"error\": \"\"}}\nexcept Exception:\n    receipt = {{\"ok\": False, \"error\": traceback.format_exc()}}\nopen({receipt_path:?}, \"w\").write(json.dumps(receipt))\n",
        receipt_path = receipt.to_string_lossy(),
    )
}

fn write_faux_script(dir: &Path, cell: &str) -> PathBuf {
    let script = dir.join("faux.json");
    std::fs::write(
        &script,
        json!({
            "engine": "faux",
            "responses": [
                { "content": [
                    { "type": "toolCall", "name": "python_repl", "arguments": {
                        "code": cell,
                    } },
                ] },
                { "text": "done" },
            ],
        })
        .to_string(),
    )
    .expect("write faux script");
    script
}

/// The stored entry equals the one the cell created, apart from its timestamps.
fn assert_stored_memory(state: &Value, id: &str, title: &str, content: &str, scope: &str) {
    let mut entry = state["entries"]["memory"][id].clone();
    assert!(entry.is_object(), "memory entry {id} missing: {state}");
    entry["created_at"] = json!("<timestamp>");
    entry["updated_at"] = json!("<timestamp>");
    assert_eq!(
        entry,
        json!({
            "id": id,
            "kind": "memory",
            "title": title,
            "content": content,
            "path": "general",
            "scope": scope,
            "reference": {},
            "arguments": {},
            "metadata": {},
            "source": "agent",
            "version": 1,
            "created_at": "<timestamp>",
            "updated_at": "<timestamp>",
        }),
        "the stored {scope} memory entry diverged"
    );
}

fn read_state(path: &Path) -> Value {
    let content = std::fs::read_to_string(path).expect("read harness state");
    serde_json::from_str(&content).expect("parse harness state")
}

#[test]
fn persistent_session_kernel_writes_the_session_local_harness_store() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let socket = dir.path().join("supervisor.sock");
    let receipts_dir = dir.path().join("receipts");
    std::fs::create_dir_all(&receipts_dir).expect("receipts dir");
    let receipt = receipts_dir.join("harness.json");
    let script = write_faux_script(dir.path(), &harness_cell(&receipt));

    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    // A persisted session: its artifact dir is `dirname(sessionDir)/session-artifacts/<id>`
    // (the same rule the session manager applies).
    let sessions_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    client.send_command(
        "c1",
        &json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["sessionId"].as_str().expect("session id");

    client.send_command(
        "t1",
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": "run the cell" }),
    );
    let prompted = client.read_response("t1");
    assert_eq!(prompted["success"], true, "prompt failed: {prompted}");
    client.send_command(
        "t1-idle",
        &json!({ "type": "wait_for_idle", "activeSessionId": session_id }),
    );
    let idle = client.read_response("t1-idle");
    assert_eq!(idle["success"], true, "wait_for_idle failed: {idle}");

    // The turn ended, so the cell's receipt is written: a `false` ok carries the
    // kernel-side failure (the instructive error when the env vars are missing).
    let cell_receipt = std::fs::read_to_string(&receipt)
        .unwrap_or_else(|error| panic!("kernel cell receipt missing: {error}"));
    let cell_receipt: Value =
        serde_json::from_str(&cell_receipt).expect("parse kernel cell receipt");
    assert_eq!(
        cell_receipt["ok"],
        true,
        "the kernel cell failed: {}",
        cell_receipt["error"].as_str().unwrap_or_default()
    );

    // The session-local store is the artifact dir's harness file.
    let artifact_dir = dir.path().join("session-artifacts").join(session_id);
    let local_state_file = artifact_dir.join("harness").join("harness_state.json");
    assert_stored_memory(
        &read_state(&local_state_file),
        "kernel-local-memory",
        "kernel session-local memory",
        "persisted from the session kernel",
        "local",
    );

    // The global store stays the agent dir's harness file.
    let global_state_file = agent_dir.join("harness").join("harness_state.json");
    assert_stored_memory(
        &read_state(&global_state_file),
        "kernel-global-memory",
        "kernel global memory",
        "persisted from the session kernel",
        "global",
    );
}
