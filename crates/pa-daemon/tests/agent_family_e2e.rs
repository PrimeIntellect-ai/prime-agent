//! Agent-message family e2e: parent-to-child sends deliver, by every
//! identifier form (name, RLM child id, persisted session id), and the
//! child replies back to its parent.
//!
//! One real supervisor, one real parent worker session (the reply target),
//! and one real RLM child spawned through a `SupervisorChildSessions`
//! registry bound to the parent (the same registry `rlm.list_subagents`
//! and the worker's own controller read). The parent-side sends go through
//! the real kernel host handler (`agent_message.send` with
//! receiver_role/receiver_name), resolving through the controller's
//! family view and delivering over the supervisor route; the child is a
//! real worker with a scripted engine whose kernel answers each delivered
//! prompt with a real `agent_message.send` addressed to its parent.
//!
//! Linux-only e2e (AF_UNIX sockets), like the other pa-daemon verifiers.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use pa_core::kernel::shared::{HostRequestHandlers, HostRequestPayload};
use pa_core::session_engine::agent_messaging::{
    register_agent_message_host_handlers, AgentFamilyRelationship, AgentMessageController,
};
use pa_core::session_engine::rlm_host::{RlmSpawnRequest, RlmSubagentHost};
use pa_daemon::agent_messaging::LinkAgentMessageController;
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
        let deadline = Instant::now() + Duration::from_secs(30);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => continue,
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
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }

    fn wait_idle(&mut self, id: &str, active_session_id: &str) {
        self.send_command(
            id,
            json!({ "type": "wait_for_idle", "activeSessionId": active_session_id }),
        );
        let response = self.read_response(id);
        assert_eq!(
            response["success"], true,
            "wait_for_idle failed: {response}"
        );
    }

    fn messages(&mut self, id: &str, active_session_id: &str) -> String {
        self.send_command(
            id,
            json!({ "type": "get_messages", "activeSessionId": active_session_id }),
        );
        let response = self.read_response(id);
        assert_eq!(response["success"], true, "get_messages failed: {response}");
        serde_json::to_string(&response["data"]).expect("messages json")
    }
}

/// The kernel Python with the runtime installed; the child's kernel cell
/// (the parent-directed reply) needs it. Skipped (with a note) on
/// machines without a live install.
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
    eprintln!("kernel python {candidate:?} not found; skipping live family e2e");
    None
}

/// The child's reply turn: a kernel `agent_message.send` addressed to the
/// parent (no receiver name: the parent is the only Parent member), with
/// the receipt recorded on disk for the test to read.
fn child_cell(receipts_dir: &Path) -> String {
    let receipt_path = receipts_dir.join("child-reply.json").display().to_string();
    let error_path = receipts_dir.join("child-reply.error").display().to_string();
    format!(
        "from rlm import host_request\nimport json, traceback\ntry:\n    receipt = await host_request(\"agent_message.send\", {{\"message\": \"kid reply\", \"receiver_role\": \"parent\"}})\n    open({receipt_path:?}, \"w\").write(json.dumps(receipt))\nexcept Exception:\n    open({error_path:?}, \"w\").write(traceback.format_exc())\n    raise",
        receipt_path = receipt_path,
        error_path = error_path,
    )
}

/// The child's scripted responses: text for the spawn prompt, then a
/// parent-directed reply turn for each delivered agent message.
fn child_responses(receipts_dir: &Path) -> Value {
    let cell = child_cell(receipts_dir);
    let reply = json!([
        { "content": [
            { "type": "toolCall", "name": "ipython", "arguments": { "code": cell } },
        ] },
        { "text": "kid turn done" },
    ]);
    json!([
        { "text": "kid spawned" },
        reply[0].clone(),
        reply[1].clone(),
        reply[0].clone(),
        reply[1].clone(),
        reply[0].clone(),
        reply[1].clone(),
    ])
}

/// One faux-engine script written to disk.
fn write_faux_script(dir: &Path, name: &str, responses: Value) -> PathBuf {
    let path = dir.join(format!("{name}.json"));
    std::fs::write(
        &path,
        json!({ "engine": "faux", "responses": responses }).to_string(),
    )
    .expect("write faux script");
    path
}

/// A recorded JSON file, waiting for the turn that writes it.
fn read_recorded(dir: &Path, name: &str) -> Value {
    let path = dir.join(name);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(content) = std::fs::read_to_string(&path) {
            return serde_json::from_str(&content).expect("recorded json");
        }
        assert!(
            Instant::now() < deadline,
            "record {name} never appeared in {}",
            dir.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// One `agent_message.send` host request through the real handler map.
async fn send_agent_message(
    handlers: &HostRequestHandlers,
    receiver_name: &str,
) -> anyhow::Result<Value> {
    let send = handlers.get("agent_message.send").expect("send handler");
    send(HostRequestPayload {
        data: json!({
            "message": "hello there",
            "receiver_role": "child",
            "receiver_name": receiver_name,
        }),
        cell_source_code: None,
    })
    .await
}

/// Verifier: the parent session's family view includes its spawned RLM
/// child; a child-directed `agent_message.send` resolves by name, by RLM
/// child id, and by persisted session id, delivers into the real child
/// worker, and the child's own parent-directed reply delivers back.
#[tokio::test]
async fn parent_child_agent_message_round_trip_end_to_end() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let receipts_dir = dir.path().join("receipts");
    std::fs::create_dir_all(&receipts_dir).expect("receipts dir");

    // The parent session: a real worker (the child's reply target) whose
    // script only needs to absorb the reply turns.
    let parent_script = write_faux_script(
        dir.path(),
        "parent",
        json!([
            { "text": "parent turn done" },
            { "text": "parent turn done" },
            { "text": "parent turn done" },
            { "text": "parent turn done" },
        ]),
    );
    let child_script = write_faux_script(dir.path(), "child", child_responses(&receipts_dir));

    // The supervisor passes the kernel python to the workers it launches.
    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    client.send_command(
        "create-parent",
        json!({
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

    // The parent's children registry (the same construction the worker
    // engine performs), bound to the real parent identity: the child
    // spawns through the supervisor and lands in the registry the
    // controller's family view reads.
    let link = Arc::new(SupervisorLink::new(socket.clone()));
    let children = SupervisorChildSessions::new(
        Arc::clone(&link),
        agent_dir.clone(),
        parent_active_session_id.clone(),
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
            name: Some("kid".to_string()),
            model: None,
            thinking: None,
            cell_source_code: None,
        })
        .await
        .expect("spawn the child");
    assert_eq!(handle.name, "kid");
    let child_id = handle.rlm_child_id.clone();

    // The detached task prompt waits for the parent's turn boundary (the
    // spawn admission ordering); this harness owns its own children
    // registry, separate from the parent worker's engine, so the boundary
    // the real parent's turn would bump has to be simulated here. Without
    // it the spawn prompt never fires and the delivered messages consume
    // the child's scripted spawn response.
    children.notify_turn_done();
    // Wait for the spawn prompt's turn to settle before delivering: the
    // child must run its spawn turn ("kid spawned") before the reply
    // script begins, or the first delivered message would consume the
    // spawn response and lose its own reply cell.
    let spawn_row = loop {
        let roster = children.list_subagents().await.expect("child roster");
        let row = roster.first().expect("one child row");
        // The spawn turn settled once the child went idle with an answer
        // (or an error); a still-running child keeps polling.
        if row.status == "completed" || row.status == "error" {
            break row.clone();
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    assert_eq!(spawn_row.status, "completed", "spawn turn: {spawn_row:?}");

    // The roster row gives the child's live and persisted session ids.
    let roster = children.list_subagents().await.expect("child roster");
    let child_row = roster.first().expect("one child row");
    let child_active_session_id = child_row
        .active_session_id
        .clone()
        .expect("child active session id");
    let child_session_id = child_row.session_id.clone().expect("child session id");
    assert_eq!(child_row.session_name, "kid");

    // The parent-side controller: the same wiring the worker's engine
    // performs (family + delivery over the supervisor link).
    let own_summary = json!({
        "activeSessionId": parent_active_session_id,
        "sessionId": parent_session_id,
        "sessionName": "parent",
        "runtimeKind": "top-level",
    });
    let controller = Arc::new(LinkAgentMessageController::new(
        Arc::clone(&link),
        parent_active_session_id.clone(),
        // The test has no worker token: the direct peer path is refused
        // and the supervisor-routed send (the TS remote path) delivers.
        "no-worker-token".to_string(),
        Arc::new(std::sync::Mutex::new(Some(own_summary))),
        Some(Arc::new(children)),
    ));
    let mut handlers = HostRequestHandlers::default();
    register_agent_message_host_handlers(Arc::clone(&controller) as Arc<_>, &mut handlers);

    // The family view lists the child (by every identifier form) and no
    // phantom sibling for it.
    let family = controller.family().await.expect("family");
    let child_members: Vec<_> = family
        .iter()
        .filter(|member| member.relationship == AgentFamilyRelationship::Child)
        .collect();
    assert_eq!(child_members.len(), 1, "{family:?}");
    let child_member = child_members[0];
    assert_eq!(child_member.id, child_active_session_id);
    assert_eq!(child_member.name.as_deref(), Some("kid"));
    assert!(child_member.aliases.contains(&child_id), "{child_member:?}");
    assert!(
        child_member.aliases.contains(&child_session_id),
        "{child_member:?}"
    );

    // Send by name, by RLM child id, and by persisted session id: every
    // form resolves through the family view and delivers into the real
    // child worker with the TS receipt shape.
    for selector in ["kid", &child_id, &child_session_id] {
        let receipt = send_agent_message(&handlers, selector)
            .await
            .unwrap_or_else(|error| panic!("child send by {selector} failed: {error:#}"));
        // `delivered` when the child is idle, `queued` behind its current
        // turn (the TS steer lane): both mean the message reached the
        // child worker; the rendering count below proves it ran.
        let status = receipt["deliveryStatus"].as_str().expect("status");
        assert!(
            status == "delivered" || status == "queued",
            "the send by {selector} must reach the child: {receipt}"
        );
        assert_eq!(
            receipt["target"]["activeSessionId"], child_active_session_id,
            "the send by {selector} targets the child: {receipt}"
        );
        assert_eq!(receipt["receiverRole"], "child", "{receipt}");
        assert!(receipt["id"].as_str().unwrap().starts_with("agentmsg_"));
    }

    // The child rendered every delivered prompt once and answered each
    // with a real parent-directed kernel send. Each delivery's card
    // carries the body twice (the row content plus details.message), so
    // three deliveries render the body six times.
    client.wait_idle("w-child", &child_active_session_id);
    let child_messages = client.messages("gm-child", &child_active_session_id);
    assert_eq!(
        child_messages.matches("hello there").count(),
        6,
        "the child rendered every delivered message once: {child_messages}"
    );
    if let Ok(error) = std::fs::read_to_string(receipts_dir.join("child-reply.error")) {
        panic!("child kernel cell failed: {error}");
    }
    let child_receipt = read_recorded(&receipts_dir, "child-reply.json");
    let reply_status = child_receipt["deliveryStatus"].as_str().expect("status");
    assert!(
        reply_status == "delivered" || reply_status == "queued",
        "the child's parent send must reach the parent: {child_receipt}"
    );
    assert_eq!(
        child_receipt["target"]["activeSessionId"], parent_active_session_id,
        "the child's send targets the parent: {child_receipt}"
    );
    assert_eq!(child_receipt["receiverRole"], "parent", "{child_receipt}");

    // The parent rendered every reply prompt from the child's name.
    client.wait_idle("w-parent", &parent_active_session_id);
    let parent_messages = client.messages("gm-parent", &parent_active_session_id);
    // The reply prompt carries the child relationship label (the TS
    // `child:<name>` sender prefix for subagent-origin messages).
    assert_eq!(
        parent_messages
            .matches("[agent-message from child:kid]")
            .count(),
        3,
        "the parent rendered every child reply: {parent_messages}"
    );
    // Each reply's card carries the body twice (row content plus
    // details.message), so three replies render the body six times.
    assert_eq!(
        parent_messages.matches("kid reply").count(),
        6,
        "the reply bodies rendered in the parent: {parent_messages}"
    );
}
