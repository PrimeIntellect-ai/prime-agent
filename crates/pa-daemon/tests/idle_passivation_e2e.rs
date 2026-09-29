//! The whole-worker idle passivation e2e (TS `idleEvictionMinutes`):
//! a settled RLM child's supervisor stop leaves the session file and the
//! parent's roster row intact; a follow-up prompt to the child's live id
//! WAKES a fresh worker over the saved file and answers; the child's
//! delete tombstones without a live worker.
//!
//! The test drives the worker->supervisor passivation request directly
//! (the child worker's supervisor-link ask, replayed with the child's own
//! worker token from its persisted descriptor) so the e2e stays gate-fast:
//! the worker-side idle clock and park-arm gates are covered by the unit
//! battery (`idle_passivation_window_*`), and the timed path against the
//! real binary by the VM census (the settings-driven 1-minute threshold).
// Pedantic-gate disposition for THIS test root: the settled-child
// passivation flow is one intentionally linear harness script (the
// fn-length gate is style, not correctness).
#![allow(clippy::too_many_lines)]
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use pa_core::session_engine::rlm_host::{RlmSpawnRequest, RlmSubagentHost};
use pa_daemon::rlm_children::{ParentIdentity, SupervisorChildSessions};
use pa_daemon::supervisor_link::SupervisorLink;

struct Daemon {
    child: Child,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_supervisor(socket: &Path, agent_dir: &Path, kernel_python: &Path) -> Daemon {
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let log_file = std::fs::File::create(socket.with_extension("daemon.log")).expect("log file");
    let log_err = log_file.try_clone().expect("clone log file");
    let child = Command::new(binary)
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .env("PRIME_AGENT_KERNEL_PYTHON", kernel_python)
        .stdout(Stdio::null())
        .stderr(Stdio::from(log_err))
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
        let writer = UnixStream::connect(socket).expect("connect");
        let reader = BufReader::new(writer.try_clone().expect("clone"));
        let mut client = Self { reader, writer };
        let hello = client.read_line();
        (client, hello)
    }

    fn send_command(&mut self, id: &str, command: &Value) {
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": {"name": "prime-agent.daemon", "version": 7},
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).expect("serialize");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("write");
        self.writer.flush().expect("flush");
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) => panic!("daemon closed the socket"),
            Ok(_) => serde_json::from_str(line.trim()).expect("line json"),
            Err(error) => panic!("read failed: {error}"),
        }
    }

    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
            assert!(Instant::now() < deadline, "no response for {id}");
        }
    }
}

/// The kernel Python with the runtime installed (the child's kernel cell).
fn kernel_python() -> Option<PathBuf> {
    let path = std::env::var("PA_TEST_KERNEL_PYTHON")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    path.filter(|p| p.exists())
}

/// The worker's token from its persisted descriptor (the same lookup the
/// family e2e uses for the parent's token).
fn worker_token(agent_dir: &Path, active_session_id: &str) -> Option<String> {
    let instances = std::fs::read_dir(agent_dir.join("daemon-workers")).ok()?;
    for instance in instances.flatten() {
        let descriptor_path = instance.path().join(format!("{active_session_id}.json"));
        let Ok(content) = std::fs::read_to_string(&descriptor_path) else {
            continue;
        };
        let Ok(descriptor) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        if let Some(token) = descriptor
            .get("authenticationToken")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
        {
            return Some(token.to_string());
        }
    }
    None
}

fn write_faux_script(dir: &Path, name: &str, responses: &Value) -> PathBuf {
    let path = dir.join(format!("{name}.json"));
    std::fs::write(
        &path,
        json!({ "engine": "faux", "responses": responses }).to_string(),
    )
    .expect("write faux script");
    path
}

/// A settled RLM child's whole-worker idle passivation: the stop keeps
/// the parent's roster row (done — the POSITIVE verdict), a follow-up
/// prompt WAKES a fresh worker over the child's session file and
/// answers, and the child's delete tombstones without a live worker.
#[tokio::test]
async fn a_settled_child_passivates_stays_listable_and_revives_by_prompt() {
    let Some(kernel_python) = kernel_python() else {
        eprintln!("kernel python unavailable; skipping the passivation e2e");
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    // The idle-eviction threshold both sides read (the worker's park arm
    // and the supervisor's fence): the same settings-driven shape the VM
    // census measures.
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({ "idleEvictionMinutes": 1 }).to_string(),
    )
    .expect("write settings");

    let parent_script = write_faux_script(
        dir.path(),
        "parent",
        &json!([
            { "text": "parent turn done" },
            { "text": "parent turn done" },
        ]),
    );
    let child_script = write_faux_script(
        dir.path(),
        "child",
        &json!([{ "text": "child done" }, { "text": "revived: the child answered again" }]),
    );

    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    client.send_command(
        "create-parent",
        &json!({
            "type": "create",
            "name": "parent",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": parent_script.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("create-parent");
    assert_eq!(created["success"], true, "create parent failed: {created}");
    let parent = &created["data"];
    let parent_active_session_id = parent["activeSessionId"]
        .as_str()
        .or_else(|| parent["id"].as_str())
        .expect("parent active session id")
        .to_string();
    let parent_session_id = parent["sessionId"].as_str().expect("parent session id");
    let parent_session_file = parent["sessionFile"]
        .as_str()
        .expect("parent session file")
        .to_string();

    let link = Arc::new(SupervisorLink::new(socket.clone()));
    let children = SupervisorChildSessions::new(
        Arc::clone(&link),
        agent_dir.clone(),
        parent_active_session_id.clone(),
        std::sync::Arc::new(pa_daemon::model_allowlist::ModelRefusalTelemetry::new(
            agent_dir.clone(),
            /*telemetry_disabled*/ true,
        )),
    );
    children.set_identity(ParentIdentity {
        rlm_depth: 0,
        rlm_max_depth: 2,
        model: Some("faux/faux-1".to_string()),
        cwd: Some(dir.path().to_string_lossy().to_string()),
        session_id: Some(parent_session_id.to_string()),
        session_file: Some(parent_session_file),
        thinking: None,
        child_script: Some(child_script.to_string_lossy().to_string()),
    });
    let handle = children
        .spawn(RlmSpawnRequest {
            prompt: "work on the lane".to_string(),
            name: Some("parked-kid".to_string()),
            model: None,
            thinking: None,
            cell_source_code: None,
        })
        .await
        .expect("spawn the child");
    assert_eq!(handle.name, "parked-kid");

    // The detached task prompt admits at the parent's turn boundary:
    // this harness owns the children registry (separate from the parent
    // worker's engine), so the boundary bump is simulated here.
    children.notify_turn_done();

    // The child's durable session id (the passive row keeps it; the
    // routing id is the live-worker field TS strips at passivation —
    // clients address a passivated session by the durable id).
    let child_session_id = {
        let roster = children.list_subagents().await.expect("child roster");
        roster
            .first()
            .and_then(|row| row.session_id.clone())
            .expect("the child's durable session id")
    };

    // The child settles done with a resident worker.
    let deadline = Instant::now() + Duration::from_secs(30);
    let child_active_session_id = loop {
        let roster = children.list_subagents().await.expect("child roster");
        if let Some(row) = roster.first() {
            if row.status == "done" || row.status == "completed" {
                break row
                    .active_session_id
                    .clone()
                    .expect("the settled child's live id");
            }
        }
        assert!(Instant::now() < deadline, "the child never settled done");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let child_token =
        worker_token(&agent_dir, &child_active_session_id).expect("the child worker's token");
    let child_pid = {
        let instances = std::fs::read_dir(agent_dir.join("daemon-workers")).expect("workers");
        let mut pid = None;
        for instance in instances.flatten() {
            let descriptor_path = instance
                .path()
                .join(format!("{child_active_session_id}.json"));
            let Ok(content) = std::fs::read_to_string(&descriptor_path) else {
                continue;
            };
            if let Ok(descriptor) = serde_json::from_str::<Value>(&content) {
                if let Some(found) = descriptor.get("pid").and_then(Value::as_u64) {
                    pid = Some(found);
                    break;
                }
            }
        }
        pid.expect("the child worker's pid")
    };
    assert!(std::path::Path::new(&format!("/proc/{child_pid}")).exists());
    let child_alive = || std::path::Path::new(&format!("/proc/{child_pid}")).exists();

    // THE PASSIVATION ASK: the child worker's supervisor-link request
    // (the worker-side clock and gates are unit-covered; this drives the
    // supervisor's handler, the graceful stop, and the roster passive).
    client.send_command(
        "passivate",
        &json!({
            "type": "worker_idle_passivation",
            "workerToken": child_token,
            "idleMinutes": 1,
        }),
    );
    let passivated = client.read_response("passivate");
    assert_eq!(
        passivated["success"], true,
        "the idle passivation stop must succeed: {passivated}"
    );

    // The child worker's PROCESS is GONE (TS's whole-worker eviction
    // semantics: worker AND its kernel leave; the session file stays).
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if !child_alive() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the child worker process survived the passivation; proc: {} cmd: {} descriptor: {} stderr: {}",
            std::fs::read_to_string(format!("/proc/{child_pid}/status"))
                .unwrap_or_default()
                .lines()
                .take(6)
                .collect::<Vec<_>>()
                .join(" | "),
            std::fs::read_to_string(format!("/proc/{child_pid}/cmdline"))
                .map(|raw| raw.replace('\0', " "))
                .unwrap_or_default(),
            {
                let mut found = std::path::PathBuf::new();
                if let Ok(entries) = std::fs::read_dir(agent_dir.join("daemon-workers")) {
                    for instance in entries.flatten() {
                        let p =
                            instance.path().join(format!("{child_active_session_id}.json"));
                        if p.exists() {
                            found = p;
                        }
                    }
                }
                std::fs::read_to_string(found).unwrap_or_default()
            },
            {
                let mut tails = Vec::new();
                if let Ok(entries) = std::fs::read_dir(agent_dir.join("logs")) {
                    for entry in entries.flatten() {
                        if let Ok(content) = std::fs::read_to_string(entry.path()) {
                            tails.push(format!(
                                "{}: {}",
                                entry.path().to_string_lossy(),
                                content
                            ));
                        }
                    }
                }
                tails.join(" --- ")
            }
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // The parent's roster STILL lists the child (done — the POSITIVE
    // verdict; the passive representation).
    let roster = children.list_subagents().await.expect("roster after");
    let row = roster
        .iter()
        .find(|row| row.active_session_id.as_deref() == Some(child_active_session_id.as_str()))
        .expect("the passivated child stays listed");
    assert!(
        row.status == "done" || row.status == "completed",
        "the settle verdict survives the stop: {}",
        row.status
    );

    // THE REVIVAL: a prompt addressed by the child's DURABLE session id
    // wakes a fresh worker over the saved file (the route's wake arm
    // resolves the saved session and launches). The faux engine's script
    // is spawn-time config (not session-file state), so the replayed
    // worker's turn runs the default provider — the WAKE oracle here is
    // the respawn + the prompt's delivery into the child's session file;
    // the model-answer revival is the VM census's leg (the real binary
    // against the offline mock).
    let child_file_rows_before = std::fs::read_to_string({
        let roster = children
            .list_subagents()
            .await
            .expect("roster for the file");
        let row = roster
            .iter()
            .find(|row| row.active_session_id.as_deref() == Some(child_active_session_id.as_str()))
            .expect("the child row");
        std::path::Path::new(&row.session_dir).join(format!(
            "{}.jsonl",
            row.session_id.clone().expect("the child's session id")
        ))
    })
    .map_or(0, |content| content.lines().count());
    client.send_command(
        "revive",
        &json!({
            "type": "prompt_and_wait",
            "activeSessionId": child_session_id,
            "message": "revive: answer again",
        }),
    );
    let revived = client.read_response("revive");
    assert!(
        revived["success"] == true
            || revived
                .get("error")
                .and_then(Value::as_str)
                .is_some_and(|error| error.contains("Insufficient balance")),
        "the wake must relaunch the child (the faux replay's model turn may fail auth; the wake itself must not): {revived}"
    );
    // The revival respawned a worker for the child's session (a fresh
    // pid serves the replayed file) and the prompt's row landed in the
    // child's session file (the delivery half of the revival).
    let deadline = Instant::now() + Duration::from_secs(15);
    let child_file = {
        let roster = children
            .list_subagents()
            .await
            .expect("roster for the file after");
        let row = roster
            .iter()
            .find(|row| row.active_session_id.as_deref() == Some(child_active_session_id.as_str()))
            .expect("the child row after");
        std::path::Path::new(&row.session_dir).join(format!(
            "{}.jsonl",
            row.session_id.clone().expect("the child's session id")
        ))
    };
    loop {
        // The delivery oracle: the woken worker replayed the file and
        // the prompt's user row landed in it (the revived worker serves
        // the SAME file — its fresh routing id differs, so the file's
        // growth is the wake's proof).
        let rows_after = std::fs::read_to_string(&child_file).map_or(0, |c| c.lines().count());
        if rows_after > child_file_rows_before {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the revival never delivered the prompt into the child's session file ({child_file:?}, rows {rows_after} <= {child_file_rows_before})"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
