//! RLM child spend end to end: a spawned child settles, and the parent's durable
//! transcript records its spend as `child_spend` snapshots, so the parent's published
//! total includes the child's. Tests skip without a live kernel install.
// Stack-resident futures by design; boxing for a lint tick is a perf regression.
#![allow(clippy::large_futures)]
// Fn length is a style gate, not correctness.
#![allow(clippy::too_many_lines)]
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Daemon {
    child: Child,
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
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .spawn()
        .expect("spawn pa-daemon supervisor");
    Daemon { child }
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
        "kernel python {} not found; skipping live RLM child-usage e2e",
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

/// The kernel cell of the spawn turn: spawn one RLM child through the
/// product `rlm.spawn` surface and record its child id + session dir.
fn spawn_cell(receipt: &Path, error_receipt: &Path) -> String {
    format!(
        "import json, traceback\ntry:\n    handle = await rlm.spawn(\"run the lane task\", name=\"kid\")\n    open({receipt:?}, \"w\").write(json.dumps({{\"rlm_child_id\": handle.rlm_child_id, \"session_dir\": str(handle.session_dir)}}))\n    print(handle.rlm_child_id)\nexcept Exception:\n    open({error_receipt:?}, \"w\").write(traceback.format_exc())\n    raise",
        receipt = receipt.display().to_string(),
        error_receipt = error_receipt.display().to_string(),
    )
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

/// Create a scripted parent session through the supervisor. The create's `childScript`
/// (the harness seam for the TS inherited `sessionConfig`) makes every child scripted.
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

/// The transcript rows of one session file, in file order.
fn transcript_rows(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_else(|_| panic!("read session file {}", path.display()))
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

/// The child's foldable assistant rows (empty until the child replied).
fn settled_child_rows(child_file: &Path) -> Vec<Value> {
    transcript_rows(child_file)
        .into_iter()
        .filter(|row| {
            row["type"] == "message"
                && row["message"]["role"] == "assistant"
                && !matches!(
                    row["message"]["stopReason"].as_str(),
                    Some("error" | "aborted")
                )
        })
        .collect()
}

/// A spawned child's spend reaches the parent's durable transcript: the zero
/// snapshot at spawn, then the child's settled total, and the parent's
/// whole-file total adds the child's spend once.
#[test]
fn child_spend_reaches_the_parent_transcript() {
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

    // A real-engine child over the faux provider: its assistant row carries
    // estimated usage the parent attributes.
    let child_script = dir.path().join("child.json");
    std::fs::write(
        &child_script,
        json!({
            "engine": "faux",
            "responses": [ { "text": "child reply" } ],
        })
        .to_string(),
    )
    .expect("write child script");
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
    let parent_session_file = parent["sessionFile"]
        .as_str()
        .expect("parent session file")
        .to_string();

    // Turn 1: the kernel cell spawns the child mid-turn through the
    // product `rlm.spawn` surface.
    run_turn(&mut client, &parent_id, "spawn the kid", "t1");
    let spawned: Value =
        serde_json::from_str(&await_receipt(&spawn_receipt)).expect("spawn receipt json");
    assert!(
        !spawn_error.exists(),
        "the spawn cell failed: {}",
        std::fs::read_to_string(&spawn_error).unwrap_or_default()
    );
    let child_session_dir = spawned["session_dir"]
        .as_str()
        .expect("child session dir")
        .to_string();
    let child_session_file = std::fs::read_dir(&child_session_dir)
        .expect("child session dir")
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.extension().and_then(|extension| extension.to_str()) == Some("jsonl")
                && pa_daemon::session_store::is_valid_session_file(path)
        })
        .expect("one child session file");

    // Observable readiness: the child's settled total lands in the parent's
    // durable transcript once the child replied.
    let deadline = Instant::now() + Duration::from_mins(2);
    let (snapshots, child_cost) = loop {
        let child_cost = pa_daemon::session_store::read_session_info(&child_session_file)
            .map(|info| info.totals.total.cost.total.as_f64())
            .unwrap_or_default();
        let snapshots: Vec<Value> = transcript_rows(Path::new(&parent_session_file))
            .into_iter()
            .filter(|row| row["type"] == "child_spend")
            .collect();
        let replied = !settled_child_rows(&child_session_file).is_empty();
        if replied
            && snapshots
                .last()
                .is_some_and(|row| row["total"]["cost"]["total"].as_f64() == Some(child_cost))
        {
            break (snapshots, child_cost);
        }
        assert!(
            Instant::now() < deadline,
            "the child's settled total never reached the parent transcript; parent rows: {:?}; child file: {}",
            transcript_rows(Path::new(&parent_session_file)),
            std::fs::read_to_string(&child_session_file).unwrap_or_default(),
        );
        std::thread::sleep(Duration::from_millis(200));
    };
    let child_id = child_session_file
        .file_stem()
        .and_then(|stem| stem.to_str())
        .expect("child session id");
    assert!(
        snapshots
            .iter()
            .all(|row| row["childSessionId"] == json!(child_id)),
        "every snapshot names the child: {snapshots:?}"
    );
    assert_eq!(
        snapshots[0]["total"]["cost"]["total"].as_f64(),
        Some(0.0),
        "the first snapshot is the spawn's zero row"
    );
    let info = pa_daemon::session_store::read_session_info(Path::new(&parent_session_file))
        .expect("parent info");
    let own = info.totals.own.cost.total.as_f64();
    let total = info.totals.total.cost.total.as_f64();
    assert!(
        (total - own - child_cost).abs() < 1e-12,
        "the parent total adds the child's spend once: own {own}, total {total}, child {child_cost}"
    );
}
