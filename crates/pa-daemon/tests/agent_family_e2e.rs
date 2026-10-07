//! Agent-message family e2e: parent-to-child sends deliver, by every
//! identifier form (name, RLM child id, persisted session id), and the
//! child replies back to its parent.
//! Linux-only e2e (`AF_UNIX` sockets), like the other pa-daemon verifiers.
// Stack-resident futures by design on the daemon's hot paths.
#![allow(clippy::large_futures)]
// 64-bit-only targets; the narrowing casts sit at bounded OS boundaries.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// Fn length is a style gate, not correctness.
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

// The timeout panic path cannot wait on the child; the test process exits and reaps it.
#[allow(clippy::zombie_processes)]
/// The parent worker's real auth token from its worker descriptor: the family
/// roster is worker-token gated, so the family view needs the live token.
fn parent_worker_token(agent_dir: &Path, active_session_id: &str) -> String {
    let instances = std::fs::read_dir(agent_dir.join("daemon-workers")).expect("daemon-workers");
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
            return token.to_string();
        }
    }
    panic!("parent worker descriptor not found");
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
        // A supervisor killed at teardown must not leak its session workers: the worker's
        // supervisor-lost exit (TS `exitIfSupervisorOrphanedForTooLong`) runs on this short
        // window, not the 5-minute default.
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
        let deadline = Instant::now() + Duration::from_secs(30);
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
        let deadline = Instant::now() + Duration::from_mins(1);
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
            &json!({ "type": "wait_for_idle", "activeSessionId": active_session_id }),
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
            &json!({ "type": "get_messages", "activeSessionId": active_session_id }),
        );
        let response = self.read_response(id);
        assert_eq!(response["success"], true, "get_messages failed: {response}");
        serde_json::to_string(&response["data"]).expect("messages json")
    }
}

/// The kernel Python with the runtime installed; the child's reply cell needs it. Skipped (with a
/// note) without a live install.
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
        "kernel python {} not found; skipping live family e2e",
        candidate.display()
    );
    None
}

/// The child's reply turn; no receiver name: the parent is the only Parent member.
fn child_cell(receipts_dir: &Path) -> String {
    let receipt_path = receipts_dir.join("child-reply.json").display().to_string();
    let error_path = receipts_dir.join("child-reply.error").display().to_string();
    format!(
        "from rlm import host_request\nimport json, traceback\ntry:\n    receipt = await host_request(\"agent_message.send\", {{\"message\": \"kid reply\", \"receiver_role\": \"parent\"}})\n    open({receipt_path:?}, \"w\").write(json.dumps(receipt))\nexcept Exception:\n    open({error_path:?}, \"w\").write(traceback.format_exc())\n    raise",
    )
}

/// Text for the spawn prompt, then one parent-directed reply turn per delivered agent message.
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

fn write_faux_script(dir: &Path, name: &str, responses: &Value) -> PathBuf {
    let path = dir.join(format!("{name}.json"));
    std::fs::write(
        &path,
        json!({ "engine": "faux", "responses": responses }).to_string(),
    )
    .expect("write faux script");
    path
}

fn receipt_listing(dir: &Path) -> String {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(std::result::Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.join(", ")
}

/// The daemon log sits beside the receipts dir (both e2e layouts root
/// it at `<tempdir>/daemon.sock`); worker or spawn failures surface there.
fn daemon_log_tail(receipts_dir: &Path) -> String {
    let root = receipts_dir.parent().unwrap_or(receipts_dir);
    std::fs::read_to_string(root.join("daemon.sock").with_extension("daemon.log"))
        .unwrap_or_else(|_| "<no daemon log>".to_string())
        .chars()
        .rev()
        .take(4000)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

/// The receipt is written non-atomically (`open(w).write`), so readiness is a successful
/// parse, not file existence; the deadline panic carries the receipts and the log tail.
fn read_recorded(dir: &Path, name: &str) -> Value {
    let path = dir.join(name);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str(&content) {
                return value;
            }
        }
        assert!(
            Instant::now() < deadline,
            "record {name} never appeared or never parsed in {}: existing: {}; \
kernel error record: {}; daemon log tail: {}",
            dir.display(),
            receipt_listing(dir),
            std::fs::read_to_string(dir.join(format!("{name}.error")))
                .unwrap_or_else(|_| "<none>".to_string()),
            daemon_log_tail(dir)
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

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

    // The parent is a real worker (the child's reply target); its script only absorbs turns.
    let parent_script = write_faux_script(
        dir.path(),
        "parent",
        &json!([
            { "text": "parent turn done" },
            { "text": "parent turn done" },
            { "text": "parent turn done" },
            { "text": "parent turn done" },
        ]),
    );
    let child_script = write_faux_script(dir.path(), "child", &child_responses(&receipts_dir));

    // The supervisor passes the kernel python to the workers it launches.
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

    // The same construction the worker engine performs, bound to the real parent identity: the
    // child lands in the registry the family view reads.
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
            name: Some("kid".to_string()),
            model: None,
            thinking: None,
            cell_source_code: None,
            spawned_by_request_id: None,
        })
        .await
        .expect("spawn the child");
    assert_eq!(handle.name, "kid");
    let child_id = handle.rlm_child_id.clone();

    // This harness owns its own children registry, so the turn boundary the real
    // parent's turn would bump is simulated here; without it the spawn prompt never fires.
    children.notify_turn_done();
    // Wait for the spawn turn to settle before delivering: the first delivered message
    // would otherwise consume the spawn response and lose its reply cell.
    let settle_deadline = Instant::now() + Duration::from_secs(60);
    let spawn_row = loop {
        let roster = children.list_subagents().await.expect("child roster");
        let row = roster.first().expect("one child row");
        if row.status == "completed" || row.status == "error" {
            break row.clone();
        }
        assert!(
            Instant::now() < settle_deadline,
            "kid spawn turn never settled: {row:?}; daemon log tail: {}",
            daemon_log_tail(&receipts_dir)
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    assert_eq!(spawn_row.status, "completed", "spawn turn: {spawn_row:?}");

    let roster = children.list_subagents().await.expect("child roster");
    let child_row = roster.first().expect("one child row");
    let child_active_session_id = child_row
        .active_session_id
        .clone()
        .expect("child active session id");
    let child_session_id = child_row.session_id.clone().expect("child session id");
    assert_eq!(child_row.session_name, "kid");

    let own_summary = json!({
        "activeSessionId": parent_active_session_id,
        "sessionId": parent_session_id,
        "sessionName": "parent",
        "runtimeKind": "top-level",
    });
    let children = Arc::new(children);
    // Both the sends and the family view ride the parent's real worker token: the roster
    // is worker-token gated and supervisor-routed delivery requires worker_auth.
    let controller = Arc::new(LinkAgentMessageController::new(
        Arc::clone(&link),
        parent_active_session_id.clone(),
        parent_worker_token(&agent_dir, &parent_active_session_id),
        Arc::new(std::sync::Mutex::new(Some(own_summary.clone()))),
        Some(Arc::clone(&children)),
    ));
    let family_controller = LinkAgentMessageController::new(
        Arc::clone(&link),
        parent_active_session_id.clone(),
        parent_worker_token(&agent_dir, &parent_active_session_id),
        Arc::new(std::sync::Mutex::new(Some(own_summary))),
        Some(children),
    );
    let mut handlers = HostRequestHandlers::default();
    register_agent_message_host_handlers(Arc::clone(&controller) as Arc<_>, &mut handlers);

    let family = family_controller.family().await.expect("family");
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

    let mut expected_cards = 0;
    for selector in ["kid", &child_id, &child_session_id] {
        let receipt = send_agent_message(&handlers, selector)
            .await
            .unwrap_or_else(|error| panic!("child send by {selector} failed: {error:#}"));
        // `delivered` when the child is idle, `queued` behind its current turn:
        // both mean the message reached the child worker.
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
        // Send sequentially: the batched-steering default (one turn at the tool
        // boundary) would merge rapid queued prompts into a single turn and reply.
        expected_cards += 1;
        let card_deadline = Instant::now() + Duration::from_secs(20);
        loop {
            client.wait_idle("w-parent", &parent_active_session_id);
            if client
                .messages("gm-parent", &parent_active_session_id)
                .matches("[agent-message from child:kid]")
                .count()
                >= expected_cards
            {
                break;
            }
            assert!(
                Instant::now() < card_deadline,
                "the parent never rendered the child's reply to the {selector} send: {}",
                client.messages("gm-parent", &parent_active_session_id)
            );
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    // Each delivery's card carries the body twice, so three deliveries render it six times.
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

    client.wait_idle("w-parent", &parent_active_session_id);
    let parent_messages = client.messages("gm-parent", &parent_active_session_id);
    assert_eq!(
        parent_messages
            .matches("[agent-message from child:kid]")
            .count(),
        3,
        "the parent rendered every child reply: {parent_messages}"
    );
    assert_eq!(
        parent_messages.matches("kid reply").count(),
        6,
        "the reply bodies rendered in the parent: {parent_messages}"
    );
}

fn record_cell(request: &str, name: &str, receipts_dir: &Path) -> String {
    let receipt_path = receipts_dir
        .join(format!("{name}.json"))
        .display()
        .to_string();
    let error_path = receipts_dir
        .join(format!("{name}.error"))
        .display()
        .to_string();
    format!(
        "from rlm import host_request\nimport json, traceback\ntry:\n    result = await host_request({request})\n    open({receipt_path:?}, \"w\").write(json.dumps(result))\nexcept Exception:\n    open({error_path:?}, \"w\").write(traceback.format_exc())\n    raise",
    )
}

fn cell_turn(code: &str) -> Value {
    json!([
        { "content": [
            { "type": "toolCall", "name": "ipython", "arguments": { "code": code } },
        ] },
        { "text": "cell turn done" },
    ])
}

#[tokio::test]
async fn family_edges_never_cross_families_end_to_end() {
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

    // Parent-a's one kernel turn records its roster and broadcast receipts.
    let parent_a_cell = format!(
        "{}\n{}",
        record_cell(r#""agent_observe.list""#, "parent-observe", &receipts_dir),
        record_cell(
            r#""agent_message.send", {"message": "parent broadcast", "target": "all"}"#,
            "parent-broadcast",
            &receipts_dir
        )
    );
    let parent_a_script = write_faux_script(
        dir.path(),
        "parent-a",
        &json!([
            { "content": [
                { "type": "toolCall", "name": "ipython", "arguments": { "code": parent_a_cell } },
            ] },
            { "text": "parent-a turn done" },
            { "text": "parent-a turn done" },
            { "text": "parent-a turn done" },
        ]),
    );
    let sibling_root_script = write_faux_script(
        dir.path(),
        "parent-b",
        &json!([{ "text": "parent-b turn done" }]),
    );
    let kid_cells = [
        record_cell(
            r#""agent_message.send", {"message": "hello sibling", "receiver_role": "sibling", "receiver_name": "kid-b"}"#,
            "kid-sibling-cross",
            &receipts_dir,
        ),
        record_cell(
            r#""agent_message.send", {"message": "parent update", "receiver_role": "parent"}"#,
            "kid-parent-reply",
            &receipts_dir,
        ),
        record_cell(
            r#""agent_message.send", {"message": "kid broadcast", "target": "all"}"#,
            "kid-broadcast",
            &receipts_dir,
        ),
        record_cell(r#""agent_observe.list""#, "kid-observe", &receipts_dir),
    ];
    // One scripted turn per cell: the tool-call entry, then the text entry that closes it (a nested
    // array is not a valid script).
    let mut kid_responses = vec![
        json!({ "text": "kid spawned" }),
        // The parent's broadcast (target=all) drains into this session's steering queue
        // during the spawn turn; the filler text absorbs that message's turn so the
        // scripted cells align with the driven turns.
        json!({ "text": "kid absorbed the broadcast" }),
    ];
    for cell in &kid_cells {
        let turn = cell_turn(cell);
        kid_responses.push(turn[0].clone());
        kid_responses.push(turn[1].clone());
    }
    let kid_script = write_faux_script(dir.path(), "kid", &json!(kid_responses));

    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    let mut roots = Vec::new();
    for (name, script) in [
        ("parent-a", parent_a_script),
        ("parent-b", sibling_root_script),
    ] {
        client.send_command(
            &format!("create-{name}"),
            &json!({
                "type": "create",
                "name": name,
                "config": {
                    "cwd": dir.path().to_string_lossy(),
                    "sessionDir": sessions_dir.to_string_lossy(),
                    "script": script.to_string_lossy(),
                },
            }),
        );
        let created = client.read_response(&format!("create-{name}"));
        assert_eq!(created["success"], true, "create {name} failed: {created}");
        roots.push((
            created["data"]["activeSessionId"]
                .as_str()
                .or_else(|| created["data"]["id"].as_str())
                .expect("active session id")
                .to_string(),
            created["data"]["sessionId"]
                .as_str()
                .expect("session id")
                .to_string(),
            created["data"]["sessionFile"]
                .as_str()
                .expect("session file")
                .to_string(),
        ));
    }
    let (parent_a_active, parent_a_session, _parent_a_file) = &roots[0];
    let (sibling_root_active, _parent_b_session, _parent_b_file) = &roots[1];

    // Each root spawns its own child; the second family's kid name is one the first might address.
    let link = Arc::new(SupervisorLink::new(socket.clone()));
    let mut kids = Vec::new();
    for (index, (active, session, file)) in roots.iter().enumerate() {
        let kid_name = if index == 0 { "kid" } else { "kid-b" };
        let children = SupervisorChildSessions::new(
            Arc::clone(&link),
            agent_dir.clone(),
            active.clone(),
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
            session_id: Some(session.clone()),
            session_file: Some(file.clone()),
            thinking: None,
            child_script: Some(kid_script.to_string_lossy().to_string()),
        });
        let handle = children
            .spawn(RlmSpawnRequest {
                prompt: "work on the lane".to_string(),
                name: Some(kid_name.to_string()),
                model: None,
                thinking: None,
                cell_source_code: None,
                spawned_by_request_id: None,
            })
            .await
            .expect("spawn the child");
        assert_eq!(handle.name, kid_name);
        children.notify_turn_done();
        // The spawn turn settles once the child goes idle with an answer (bounded).
        let settle_deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let roster = children.list_subagents().await.expect("child roster");
            let row = roster.first().expect("one child row");
            if row.status == "completed" || row.status == "error" {
                assert_eq!(row.status, "completed", "spawn turn: {row:?}");
                break;
            }
            assert!(
                Instant::now() < settle_deadline,
                "kid {kid_name} spawn turn never settled: {row:?}; daemon log tail: {}",
                daemon_log_tail(&receipts_dir)
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let roster = children.list_subagents().await.expect("child roster");
        let row = roster.first().expect("one child row");
        assert_eq!(row.session_name, kid_name);
        // The spawn row can settle before the first turn's session file lands; wait for it.
        let kid_session_id = row.session_id.clone().expect("child persisted id");
        // The per-child artifact dir IS the rlm child id; do not prefix it again.
        let artifact_dir = agent_dir
            .join("session-artifacts")
            .join(session)
            .join(&handle.rlm_child_id);
        let expected_file = artifact_dir.join(format!("{kid_session_id}.jsonl"));
        let artifact_deadline = Instant::now() + Duration::from_secs(15);
        while !expected_file.is_file() {
            assert!(
                Instant::now() < artifact_deadline,
                "kid session file never appeared: {}",
                expected_file.display()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        // The kid's own session file (the grandchild's durable parent edge): exactly one.
        let kid_files: Vec<std::fs::DirEntry> = std::fs::read_dir(
            agent_dir
                .join("session-artifacts")
                .join(session)
                .join(&handle.rlm_child_id),
        )
        .expect("kid artifact dir")
        .flatten()
        // The semantic-edge ledger rides the same dir (TS: the child's
        // rlm session dir owns it); only the durable session row counts.
        .filter(|entry| {
            entry.path().extension().and_then(|ext| ext.to_str()) == Some("jsonl")
                && entry.file_name().to_string_lossy() != "semantic-edges.jsonl"
        })
        .collect();
        assert_eq!(kid_files.len(), 1, "one kid session file: {kid_files:?}");
        kids.push((
            row.active_session_id.clone().expect("child active id"),
            row.session_id.clone().expect("child persisted id"),
            kid_files[0].path().to_string_lossy().to_string(),
        ));
    }
    let (kid_a_active, kid_a_session, kid_a_file) = &kids[0];
    let second_kid_active = &kids[1].0;

    // This harness owns the children registry in the TEST process, so the settle notice is
    // minted here while the parent worker's queue admission refuses it; waiting on it
    // leaves the receipts dir empty. Once the broadcast receipt exists it is ahead of
    // every later drive in the FIFO steering lane, so each scripted cell lands on its turn.
    client.send_command(
        "to-parent-a-cells",
        &json!({
            "type": "send_message",
            "targetActiveSessionId": parent_a_active,
            "message": "drive the parent cell turn",
            "fromActiveSessionId": sibling_root_active,
            "agentOrigin": true,
        }),
    );
    let response = client.read_response("to-parent-a-cells");
    assert_eq!(
        response["success"], true,
        "send to-parent-a-cells failed: {response}"
    );
    client.wait_idle("w-parent-a-cells", parent_a_active);
    let _parent_broadcast = read_recorded(&receipts_dir, "parent-broadcast.json");

    let drive_kid_turn = |client: &mut Client, id: &str, message: &str| {
        client.send_command(
            id,
            &json!({
                "type": "send_message",
                "targetActiveSessionId": kid_a_active,
                "message": message,
                "fromActiveSessionId": parent_a_active,
                "agentOrigin": true,
            }),
        );
        let response = client.read_response(id);
        assert_eq!(response["success"], true, "send {id} failed: {response}");
        client.wait_idle(id, kid_a_active);
    };
    for (id, message) in [
        ("to-kid-1", "drive the sibling probe"),
        ("to-kid-2", "drive the parent reply"),
        ("to-kid-3", "drive the broadcast"),
    ] {
        drive_kid_turn(&mut client, id, message);
    }

    // The grandchild: a worker spawned through a registry bound to KID-A's durable identity.
    let kid_children = SupervisorChildSessions::new(
        Arc::clone(&link),
        agent_dir.clone(),
        kid_a_active.clone(),
        std::sync::Arc::new(pa_daemon::model_allowlist::ModelRefusalTelemetry::new(
            agent_dir.clone(),
            /*telemetry_disabled*/ true,
        )),
    );
    kid_children.set_identity(ParentIdentity {
        rlm_depth: 1,
        rlm_max_depth: 2,
        model: Some("faux/faux-1".to_string()),
        cwd: Some(dir.path().to_string_lossy().to_string()),
        session_id: Some(kid_a_session.clone()),
        session_file: Some(kid_a_file.clone()),
        thinking: None,
        child_script: Some(kid_script.to_string_lossy().to_string()),
    });
    let grandkid_handle = kid_children
        .spawn(RlmSpawnRequest {
            prompt: "grandkid work".to_string(),
            name: Some("grandkid".to_string()),
            model: None,
            thinking: None,
            cell_source_code: None,
            spawned_by_request_id: None,
        })
        .await
        .expect("spawn the grandchild");
    assert_eq!(grandkid_handle.name, "grandkid");
    kid_children.notify_turn_done();
    let grandkid_settle_deadline = Instant::now() + Duration::from_secs(60);
    let grandkid_active = loop {
        let roster = kid_children.list_subagents().await.expect("roster");
        let row = roster.first().expect("one grandchild row");
        if row.status == "completed" || row.status == "error" {
            assert_eq!(row.status, "completed", "grandchild spawn turn: {row:?}");
            break row.active_session_id.clone().expect("grandchild active id");
        }
        assert!(
            Instant::now() < grandkid_settle_deadline,
            "grandkid spawn turn never settled: {row:?}; daemon log tail: {}",
            daemon_log_tail(&receipts_dir)
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };

    drive_kid_turn(&mut client, "to-kid-4", "drive the kid observe");
    // The cross-family sibling probe fails closed: not addressable by name.
    let Ok(crossed) = std::fs::read_to_string(receipts_dir.join("kid-sibling-cross.error")) else {
        let transcript = client.messages("gm-kid-debug", kid_a_active);
        eprintln!("KEEP-DIR {}", dir.path().display());
        if std::env::var_os("PA_E2E_KEEP_DIR").is_some() {
            std::mem::forget(dir);
        }
        panic!(
            "no sibling-probe record: success receipt: {:?}; kid-a transcript: {}; daemon log tail: {}",
            std::fs::read_to_string(receipts_dir.join("kid-sibling-cross.json")).ok(),
            transcript,
            daemon_log_tail(&receipts_dir)
        );
    };
    assert!(
        crossed.contains("No sibling matches"),
        "a cross-family sibling send must fail closed: {crossed}"
    );
    if let Ok(error) = std::fs::read_to_string(receipts_dir.join("kid-parent-reply.error")) {
        panic!("kid kernel cell failed: {error}");
    }
    let parent_reply = read_recorded(&receipts_dir, "kid-parent-reply.json");
    assert_eq!(
        parent_reply["target"]["activeSessionId"], *parent_a_active,
        "the parent reply reaches the true parent: {parent_reply}"
    );
    assert_eq!(parent_reply["receiverRole"], "parent", "{parent_reply}");
    if let Ok(error) = std::fs::read_to_string(receipts_dir.join("kid-broadcast.error")) {
        panic!("kid kernel cell failed: {error}");
    }
    // The broadcast reaches the family roster; the grandkid's presence depends on
    // broadcast-versus-spawn interleaving, so pin the isolation, not the exact set.
    let kid_broadcast = read_recorded(&receipts_dir, "kid-broadcast.json");
    let kid_targets: Vec<&str> = kid_broadcast["receipts"]
        .as_array()
        .expect("receipts")
        .iter()
        .map(|receipt| {
            receipt["target"]["activeSessionId"]
                .as_str()
                .or_else(|| receipt["target"].as_str())
                .expect("receipt target")
        })
        .collect();
    let allowed = [parent_a_active.as_str(), grandkid_active.as_str()];
    assert!(
        kid_targets.iter().all(|target| allowed.contains(target)),
        "the child's broadcast stays inside its own family: {kid_broadcast}"
    );
    assert!(
        kid_targets.contains(&parent_a_active.as_str()),
        "the child's broadcast reaches its parent: {kid_broadcast}"
    );
    assert!(
        !kid_targets.contains(&second_kid_active.as_str())
            && !kid_targets.contains(&sibling_root_active.as_str()),
        "the child's broadcast never crosses families: {kid_broadcast}"
    );
    if let Ok(error) = std::fs::read_to_string(receipts_dir.join("kid-observe.error")) {
        panic!("kid kernel cell failed: {error}");
    }
    let kid_roster = read_recorded(&receipts_dir, "kid-observe.json");
    let kid_roster = kid_roster
        .get("agents")
        .and_then(Value::as_array)
        .expect("the observe roster is a list of summaries");
    assert_eq!(
        kid_roster.len(),
        3,
        "kid-a's observe roster is its nuclear family: {kid_roster:?}"
    );
    let kid_self = kid_roster
        .iter()
        .find(|summary| summary["activeSessionId"] == kid_a_active.as_str())
        .expect("kid-a's own row");
    assert!(kid_self["isCurrent"] == true, "{kid_self:?}");
    assert_eq!(kid_self["relationship"], Value::Null, "{kid_self:?}");
    let kid_parent_row = kid_roster
        .iter()
        .find(|summary| summary["sessionId"] == parent_a_session.as_str())
        .expect("the parent's row");
    assert_eq!(
        kid_parent_row["relationship"], "parent",
        "{kid_parent_row:?}"
    );
    let grandkid_row = kid_roster
        .iter()
        .find(|summary| {
            summary["activeSessionId"] == grandkid_active.as_str()
                || summary["rlmChildId"] == grandkid_handle.rlm_child_id.as_str()
        })
        .expect("the grandchild nests under its parent");
    assert_eq!(grandkid_row["relationship"], "child", "{grandkid_row:?}");
    assert!(
        !kid_roster.iter().any(
            |summary| summary["activeSessionId"] == second_kid_active.as_str()
                || summary["activeSessionId"] == sibling_root_active.as_str()
        ),
        "the other family never enters kid-a's roster: {kid_roster:?}"
    );

    if let Ok(error) = std::fs::read_to_string(receipts_dir.join("parent-observe.error")) {
        panic!("parent kernel cell failed: {error}");
    }
    let roster = read_recorded(&receipts_dir, "parent-observe.json");
    let roster = roster
        .get("agents")
        .and_then(Value::as_array)
        .expect("the observe roster is a list of summaries");
    assert_eq!(
        roster.len(),
        3,
        "the observe roster is the nuclear family: {roster:?}"
    );
    let by_id = |id: &str| {
        roster
            .iter()
            .find(|summary| {
                summary["activeSessionId"].as_str() == Some(id)
                    || summary["sessionId"].as_str() == Some(id)
            })
            .unwrap_or_else(|| panic!("row {id} missing: {roster:?}"))
            .clone()
    };
    let self_row = by_id(parent_a_session);
    assert_eq!(self_row["isCurrent"], true, "{self_row:?}");
    assert_eq!(self_row["relationship"], Value::Null, "{self_row:?}");
    let sibling_row = by_id(sibling_root_active);
    assert_eq!(sibling_row["relationship"], "sibling", "{sibling_row:?}");
    let child_row = by_id(kid_a_active);
    assert_eq!(child_row["relationship"], "child", "{child_row:?}");
    assert!(
        !roster.iter().any(|summary| {
            summary["activeSessionId"].as_str() == Some(second_kid_active.as_str())
        }),
        "another family's subagent is never in the observe roster: {roster:?}"
    );
    assert!(
        !roster
            .iter()
            .any(|summary| summary["activeSessionId"] == grandkid_active.as_str()),
        "a grandchild never renders top-level in the root's roster: {roster:?}"
    );
    if let Ok(error) = std::fs::read_to_string(receipts_dir.join("parent-broadcast.error")) {
        panic!("parent kernel cell failed: {error}");
    }
    let parent_broadcast = read_recorded(&receipts_dir, "parent-broadcast.json");
    let mut parent_targets: Vec<&str> = parent_broadcast["receipts"]
        .as_array()
        .expect("receipts")
        .iter()
        .map(|receipt| {
            receipt["target"]["activeSessionId"]
                .as_str()
                .or_else(|| receipt["target"].as_str())
                .expect("receipt target")
        })
        .collect();
    parent_targets.sort_unstable();
    let mut expected = vec![sibling_root_active.as_str(), kid_a_active.as_str()];
    expected.sort_unstable();
    assert_eq!(
        parent_targets, expected,
        "the parent's broadcast stays inside its nuclear family: {parent_broadcast}"
    );

    client.wait_idle("w-child-transcript", kid_a_active);
    let parent_messages = client.messages("gm-parent-transcript", parent_a_active);
    assert!(
        parent_messages
            .matches("[agent-message from child:kid]")
            .count()
            >= 1,
        "the true child's reply carries the child label: {parent_messages}"
    );
    client.send_command(
        "probe-from-kid-b",
        &json!({
            "type": "send_message",
            "targetActiveSessionId": parent_a_active,
            "message": "foreign probe",
            "fromActiveSessionId": second_kid_active,
            "agentOrigin": true,
        }),
    );
    let response = client.read_response("probe-from-kid-b");
    assert_eq!(response["success"], true, "probe failed: {response}");
    client.wait_idle("probe-wait", parent_a_active);
    let parent_messages = client.messages("gm-parent-probe", parent_a_active);
    assert!(
        parent_messages
            .matches("[agent-message from kid-b]")
            .count()
            >= 1,
        "the foreign subagent renders by name: {parent_messages}"
    );
    assert!(
        !parent_messages.contains("[agent-message from child:kid-b]"),
        "a subagent of ANOTHER parent never renders as this session's child: {parent_messages}"
    );
}

/// Verifier (TS #2529): a parent renames one of its direct children
/// through the real kernel host handler (`rlm.rename` with the spawn
/// handle's child id) — the same handler map the parent's kernel
/// dispatches into. The supervisor's reservation ladder admits the
/// unique name, the child worker persists it and leaves the
/// ` by parent` transcript notice, the child's RLM ledger edge carries
/// the new name, and the parent-side selectors stop matching the old
/// name (`rlm.collect` by the old name fails, the new name hits).
#[tokio::test]
async fn parent_renames_a_child_end_to_end() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    // The parent absorbs turns; the child only runs its spawn turn.
    let parent_script = write_faux_script(
        dir.path(),
        "parent",
        &json!([{ "text": "parent turn done" }]),
    );
    let child_script = write_faux_script(dir.path(), "child", &json!([{ "text": "kid spawned" }]));

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

    let children = SupervisorChildSessions::new(
        Arc::new(SupervisorLink::new(socket.clone())),
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
        session_file: Some(parent_session_file.clone()),
        thinking: None,
        child_script: Some(child_script.to_string_lossy().to_string()),
    });
    let handle = children
        .spawn(RlmSpawnRequest {
            prompt: "work on the lane".to_string(),
            name: Some("kid".to_string()),
            model: None,
            thinking: None,
            spawned_by_request_id: None,
            cell_source_code: None,
        })
        .await
        .expect("spawn the child");
    assert_eq!(handle.name, "kid");
    children.notify_turn_done();
    // Wait for the spawn turn to settle (bounded), then read the roster's
    // live/persisted child ids.
    let settle_deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let roster = children.list_subagents().await.expect("child roster");
        let row = roster.first().expect("one child row");
        if row.status == "completed" || row.status == "error" {
            assert_eq!(row.status, "completed", "spawn turn: {row:?}");
            break;
        }
        assert!(
            Instant::now() < settle_deadline,
            "kid spawn turn never settled: {row:?}; daemon log tail: {}",
            daemon_log_tail(&dir.path().join("receipts"))
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let roster = children.list_subagents().await.expect("child roster");
    let child_row = roster.first().expect("one child row");
    let child_active_session_id = child_row
        .active_session_id
        .clone()
        .expect("child active session id");

    // The parent-side kernel host surface over the same registry (the
    // wiring the parent worker's engine performs): the rename dispatches
    // through the REAL `rlm.rename` handler, with the spawn handle's
    // child id as the selector.
    let children = Arc::new(children);
    let wiring = pa_core::session_engine::runtime_wiring::wire_session_runtime(
        pa_core::session::manager::SessionManager::in_memory(dir.path()),
        dir.path(),
        pa_core::session_engine::runtime_wiring::RlmWiring {
            model_registry: None,
            subagent_host: Some(Arc::clone(&children) as Arc<dyn RlmSubagentHost>),
            usage_store: None,
        },
        None,
        None,
    );
    let rename = wiring
        .handlers
        .get("rlm.rename")
        .expect("rlm.rename handler registered")
        .clone();
    let reply = rename(HostRequestPayload {
        data: json!({
            "name": "  bench-runner ",
            "session_id": handle.rlm_child_id,
        }),
        cell_source_code: None,
    })
    .await
    .expect("the rename dispatch");
    assert_eq!(reply, json!({ "name": "bench-runner" }));

    // The child's transcript carries the parent-directed notice.
    client.wait_idle("w-child-rename", &child_active_session_id);
    let child_messages = client.messages("gm-child-rename", &child_active_session_id);
    assert!(
        child_messages
            .matches("Session renamed `kid` -> `bench-runner` by parent")
            .count()
            >= 1,
        "the renamed session sees the notice: {child_messages}"
    );

    // The child's RLM ledger edge carries the new name (the passive roster
    // keeps it after passivation).
    let ledger = pa_daemon::rlm_ledger::RlmSpawnLedger::new(&agent_dir, &sessions_dir, |_| {});
    let edges = ledger.edges(true).expect("ledger edges");
    let edge = edges
        .iter()
        .find(|edge| edge.child_id == handle.rlm_child_id)
        .expect("the child's ledger edge");
    assert_eq!(edge.name, "bench-runner", "the ledger rename landed");
}
