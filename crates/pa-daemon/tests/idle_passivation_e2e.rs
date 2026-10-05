//! The whole-worker idle passivation e2e (TS `idleEvictionMinutes`):
//! a settled RLM child's supervisor stop leaves the session file and the
//! parent's roster row intact; the parent's `agent_message.send` to the
//! passivated child WAKES a fresh worker over the saved file and
//! delivers.
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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use pa_core::kernel::shared::{HostRequestHandlers, HostRequestPayload};
use pa_core::session_engine::agent_messaging::register_agent_message_host_handlers;
use pa_core::session_engine::rlm_host::{RlmSpawnRequest, RlmSubagentHost};
use pa_daemon::agent_messaging::LinkAgentMessageController;
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
        "kernel python {} not found; skipping live passivation e2e",
        candidate.display()
    );
    None
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

/// The worker's pid from its persisted descriptor (the process the
/// passivation must retire).
fn worker_pid(agent_dir: &Path, active_session_id: &str) -> Option<u64> {
    let instances = std::fs::read_dir(agent_dir.join("daemon-workers")).ok()?;
    for instance in instances.flatten() {
        let descriptor_path = instance.path().join(format!("{active_session_id}.json"));
        let Ok(content) = std::fs::read_to_string(&descriptor_path) else {
            continue;
        };
        if let Ok(descriptor) = serde_json::from_str::<Value>(&content) {
            if let Some(pid) = descriptor.get("pid").and_then(Value::as_u64) {
                return Some(pid);
            }
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
/// the parent's roster row (done — the POSITIVE verdict), the parent's
/// `agent_message.send` WAKES a fresh worker over the child's session
/// file and delivers.
#[tokio::test]
async fn a_settled_child_passivates_stays_listable_and_revives_by_agent_message() {
    let Some(kernel_python) = kernel_python() else {
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
            spawned_by_request_id: None,
        })
        .await
        .expect("spawn the child");
    assert_eq!(handle.name, "parked-kid");

    // The detached task prompt admits at the parent's turn boundary:
    // this harness owns the children registry (separate from the parent
    // worker's engine), so the boundary bump is simulated here.
    children.notify_turn_done();

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
    let child_pid =
        worker_pid(&agent_dir, &child_active_session_id).expect("the child worker's pid");
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

    // THE REVIVAL: the parent's real `agent_message.send` to the child,
    // through the same controller and handler the worker's engine wires:
    // the send resolves the passivated child through the family view
    // (keyed by its durable id) and wakes a fresh worker over the saved
    // file (the supervisor's ledger wake). The faux engine's script
    // is spawn-time config (not session-file state), so the replayed
    // worker's turn runs the default provider: the response's outcome
    // depends on the host's credentials and is not asserted — the WAKE
    // oracle is the delivered message's row in the child's session file
    // (only a woken worker writes it); the model-answer revival is the
    // VM census's leg (the real binary against the offline mock).
    let revive_prompt = "revive: answer again";
    let parent_token =
        worker_token(&agent_dir, &parent_active_session_id).expect("the parent worker's token");
    let own_summary = json!({
        "activeSessionId": parent_active_session_id,
        "sessionId": parent_session_id,
        "sessionName": "parent",
        "runtimeKind": "top-level",
    });
    let children = Arc::new(children);
    let controller = Arc::new(LinkAgentMessageController::new(
        Arc::clone(&link),
        parent_active_session_id.clone(),
        parent_token,
        Arc::new(Mutex::new(Some(own_summary))),
        Some(Arc::clone(&children)),
    ));
    let mut handlers = HostRequestHandlers::default();
    register_agent_message_host_handlers(Arc::clone(&controller) as Arc<_>, &mut handlers);
    let send = handlers.get("agent_message.send").expect("send handler");
    let revived = send(HostRequestPayload {
        data: json!({
            "message": revive_prompt,
            "receiver_role": "child",
            "receiver_name": "parked-kid",
        }),
        cell_source_code: None,
    })
    .await
    .expect("the send must wake the passivated child and deliver");
    // The send woke a fresh worker for the child's session (a new pid
    // serves the replayed file); the delivery's receipt arrives before
    // the delivered turn writes its rows, so the wake's proof is the
    // message's row itself landing in the child's session file (the
    // revived worker serves the SAME file — its fresh routing id
    // differs, so only a woken worker writes it).
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
        let grown = std::fs::read_to_string(&child_file).unwrap_or_default();
        if grown.contains(revive_prompt) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the send never delivered the message into the child's session file ({child_file:?}, tail: {:?}, receipt: {revived:?})",
            grown.lines().rev().take(3).collect::<Vec<_>>().join(" | ")
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The root active ids of the persisted worker descriptors (the
/// descriptor file's stem is the worker's active session id).
fn root_worker_ids(agent_dir: &Path) -> Vec<String> {
    let mut ids = Vec::new();
    let Ok(instances) = std::fs::read_dir(agent_dir.join("daemon-workers")) else {
        return ids;
    };
    for instance in instances.flatten() {
        let Ok(entries) = std::fs::read_dir(instance.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(descriptor) = serde_json::from_str::<Value>(&content) else {
                continue;
            };
            if let Some(id) = descriptor
                .get("rootActiveSessionId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            {
                ids.push(id.to_string());
            }
        }
    }
    ids.sort();
    ids
}

/// The rename arm of the passivation-aware wake (TS
/// `renameAgentFamilySession` resolving through the hydrated target):
/// the parent record keeps the child's SPAWN-time active id, a revival
/// re-keys the supervisor roster's child row to the revived worker's
/// fresh id (the registration's roster write drops the old id's index),
/// and the revived worker's own idle passivation stops it again — after
/// which the parent's rename, addressed by the record's stale id,
/// resolves NOWHERE (no live resident for the binding, no roster row,
/// no ledger edge: only the child's DURABLE id still names the session).
/// The rename must reach the child through the same durable-selector
/// wake retry `prompt_child` carries: the retry's wake launches a fresh
/// worker over the child's session file and the rename lands there.
#[tokio::test]
async fn a_parent_rename_after_a_revival_and_second_passivation_reaches_the_child() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({ "idleEvictionMinutes": 1 }).to_string(),
    )
    .expect("write settings");
    let parent_script = write_faux_script(
        dir.path(),
        "rename-parent",
        &json!([{ "text": "parent turn done" }]),
    );
    let child_script = write_faux_script(
        dir.path(),
        "rename-child",
        &json!([{ "text": "child done" }]),
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
            spawned_by_request_id: None,
        })
        .await
        .expect("spawn the child");
    children.notify_turn_done();

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
    let (child_session_id, child_session_dir) = {
        let row = children
            .list_subagents()
            .await
            .expect("roster for the file")
            .pop()
            .expect("the child row");
        (
            row.session_id.expect("the child's durable session id"),
            row.session_dir,
        )
    };
    let child_file =
        std::path::Path::new(&child_session_dir).join(format!("{child_session_id}.jsonl"));

    // THE FIRST PASSIVATION (same ask as the settled-child test).
    let child_token =
        worker_token(&agent_dir, &child_active_session_id).expect("the child worker's token");
    client.send_command(
        "passivate-1",
        &json!({
            "type": "worker_idle_passivation",
            "workerToken": child_token,
            "idleMinutes": 1,
        }),
    );
    let passivated = client.read_response("passivate-1");
    assert_eq!(
        passivated["success"], true,
        "the first idle passivation must succeed: {passivated}"
    );

    // THE REVIVAL: a fresh client attaches by the child's DURABLE session
    // id (the TUI resume selector): the route's wake arm resolves the
    // ledger edge and launches a fresh worker over the child's file, and
    // the fresh worker's registration re-keys the roster's child row to
    // its fresh active id — the spawn-time id the parent record keeps
    // stops resolving from here on.
    let (mut fresh, _hello) = Client::connect(&socket);
    fresh.send_command(
        "revive-attach",
        &json!({ "type": "attach", "activeSessionId": child_session_id }),
    );
    let revived = fresh.read_response("revive-attach");
    assert_eq!(
        revived["success"], true,
        "the attach by the durable id must wake the passivated child: {revived}"
    );

    // The fresh worker's identity (its descriptor's root active id is the
    // new routing id the roster row now carries).
    let deadline = Instant::now() + Duration::from_secs(30);
    let revived_active_session_id = loop {
        let ids = root_worker_ids(&agent_dir)
            .into_iter()
            .filter(|id| id != &child_active_session_id && id != &parent_active_session_id)
            .collect::<Vec<_>>();
        if let Some(id) = ids.first() {
            break id.clone();
        }
        assert!(
            Instant::now() < deadline,
            "the revival never wrote a fresh worker descriptor (ids so far: {:?})",
            root_worker_ids(&agent_dir)
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let revived_token =
        worker_token(&agent_dir, &revived_active_session_id).expect("the fresh worker's token");
    let revived_pid =
        worker_pid(&agent_dir, &revived_active_session_id).expect("the fresh worker's pid");

    // THE SECOND PASSIVATION: the revived worker stops the same way, so
    // the child is passive again — but its roster row is keyed by the
    // REVIVED id, and the parent record still holds the spawn-time id.
    client.send_command(
        "passivate-2",
        &json!({
            "type": "worker_idle_passivation",
            "workerToken": revived_token,
            "idleMinutes": 1,
        }),
    );
    let passivated = client.read_response("passivate-2");
    assert_eq!(
        passivated["success"], true,
        "the second idle passivation must succeed: {passivated}"
    );
    let deadline = Instant::now() + Duration::from_secs(60);
    while std::path::Path::new(&format!("/proc/{revived_pid}")).exists() {
        assert!(
            Instant::now() < deadline,
            "the revived worker survived the second passivation"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // THE RENAME: the parent's rename by the child handle resolves the
    // record's spawn-time active id — the stale id that no longer
    // routes. The durable-selector wake retry must land the rename on a
    // fresh worker over the child's session file.
    let renamed = children
        .rename(
            "renamed-lane".to_string(),
            Some(handle.rlm_child_id.clone()),
        )
        .await;
    let applied = renamed.unwrap_or_else(|error| {
        panic!(
            "the parent rename of the twice-passivated child must reach it through the durable wake: {error:#}"
        )
    });
    assert_eq!(applied, "renamed-lane");

    // The durable oracle: the child's session file carries the new name's
    // `session_info` row (only a woken worker writes it), and the
    // parent's registry row follows the applied name.
    let entries = std::fs::read_to_string(&child_file).unwrap_or_default();
    let named = entries
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .any(|entry| {
            entry.get("type").and_then(Value::as_str) == Some("session_info")
                && entry.get("name").and_then(Value::as_str) == Some("renamed-lane")
        });
    assert!(
        named,
        "the woken child must carry the renamed session_info row (tail: {:?})",
        entries
            .lines()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .join(" | ")
    );
    let row = children
        .list_subagents()
        .await
        .expect("roster after the rename")
        .into_iter()
        .find(|row| row.rlm_child_id == handle.rlm_child_id)
        .expect("the child row after the rename");
    assert_eq!(row.session_name, "renamed-lane");
}

/// An idle unowned ROOT passivates through the same worker-driven ask
/// (TS `canEvictWorker` reaches roots and children alike) and resumes
/// by its durable session id: the attach wakes a fresh worker over the
/// saved file and the snapshot carries the pre-passivation transcript.
#[tokio::test]
async fn an_idle_root_passivates_and_resumes_by_its_durable_id_with_its_transcript() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({ "idleEvictionMinutes": 1 }).to_string(),
    )
    .expect("write settings");
    let root_script = write_faux_script(dir.path(), "root", &json!([{ "text": "root turn done" }]));

    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    client.send_command(
        "create-root",
        &json!({
            "type": "create",
            "name": "root",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": root_script.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("create-root");
    assert_eq!(created["success"], true, "create root failed: {created}");
    let root_active_session_id = created["data"]["activeSessionId"]
        .as_str()
        .or_else(|| created["data"]["id"].as_str())
        .expect("root active session id")
        .to_string();
    let root_session_id = created["data"]["sessionId"]
        .as_str()
        .expect("root durable session id")
        .to_string();

    client.send_command(
        "first-turn",
        &json!({
            "type": "prompt_and_wait",
            "activeSessionId": root_active_session_id,
            "message": "first turn",
        }),
    );
    let first = client.read_response("first-turn");
    assert_eq!(first["success"], true, "the first turn failed: {first}");

    let root_token =
        worker_token(&agent_dir, &root_active_session_id).expect("the root worker's token");
    let root_pid = worker_pid(&agent_dir, &root_active_session_id).expect("the root worker's pid");
    assert!(std::path::Path::new(&format!("/proc/{root_pid}")).exists());

    // THE PASSIVATION ASK for a ROOT: the supervisor's handler accepts an
    // unowned worker regardless of depth (without the fix this answers
    // the child-worker-policy refusal).
    client.send_command(
        "passivate-root",
        &json!({
            "type": "worker_idle_passivation",
            "workerToken": root_token,
            "idleMinutes": 1,
        }),
    );
    let passivated = client.read_response("passivate-root");
    assert_eq!(
        passivated["success"], true,
        "the root's idle passivation must succeed: {passivated}"
    );

    // The root worker's process is gone (the whole-worker stop).
    let deadline = Instant::now() + Duration::from_secs(60);
    while std::path::Path::new(&format!("/proc/{root_pid}")).exists() {
        assert!(
            Instant::now() < deadline,
            "the root worker process survived the passivation"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // THE RESUME: a fresh client attaches by the DURABLE session id (the
    // TUI reattach selector); the route's wake arm resolves the saved
    // session, launches a fresh worker over the file, and the snapshot
    // carries the pre-passivation transcript.
    let (mut fresh, _hello) = Client::connect(&socket);
    fresh.send_command(
        "re-attach",
        &json!({ "type": "attach", "activeSessionId": root_session_id }),
    );
    let attached = fresh.read_response("re-attach");
    assert_eq!(
        attached["success"], true,
        "the attach by the durable id must wake the passivated root: {attached}"
    );
    let messages = attached["data"]["snapshot"]["messages"].to_string();
    assert!(
        messages.contains("first turn"),
        "the snapshot must carry the first turn's user prompt: {messages}"
    );
    assert!(
        messages.contains("root turn done"),
        "the snapshot must carry the first turn's reply: {messages}"
    );
}
