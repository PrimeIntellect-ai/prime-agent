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
/// The parent worker's real authentication token from its worker descriptor
/// (`daemon-workers/<instance>/<active-session-id>.json`): the family
/// roster (`list_agent_peers`) is worker-token gated, so the family view
/// needs the live token the supervisor issued the parent.
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
    panic!("parent worker descriptor not found for {active_session_id}");
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

/// The receipts-dir listing for a timeout message (what the workers
/// actually recorded so far).
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

/// A recorded JSON file, waiting for the turn that writes it. The
/// recording cell writes the receipt non-atomically (`open(w).write`),
/// so the file can exist while its content is still empty or partial:
/// readiness is a successful parse, not file existence — a read that
/// does not parse yet polls on like a missing one until the deadline.
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
            "record {name} never appeared or never parsed in {}: existing: {}",
            dir.display(),
            receipt_listing(dir)
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
    let children = Arc::new(children);
    // Both the sends and the family view ride the parent's real worker
    // token from its worker descriptor (the same wiring the worker's
    // engine performs): the supervisor roster (`list_agent_peers`) is
    // worker-token gated, and the supervisor-routed delivery requires
    // worker_auth - a deliberately token-less controller can never pass
    // it, so the token-less refusal premise belongs to the peer-transport
    // suite, not here.
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

    // The family view lists the child (by every identifier form) and no
    // phantom sibling for it.
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

    // Send by name, by RLM child id, and by persisted session id: every
    // form resolves through the family view and delivers into the real
    // child worker with the TS receipt shape.
    let mut expected_cards = 0;
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
        // Send sequentially - the next selector only fires after this
        // prompt's reply card renders. The batched-steering default (one
        // turn at the tool boundary) would otherwise merge rapid queued
        // prompts into a single turn and its single reply.
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

/// One recorded-JSON helper cell body: run one `host_request` and record
/// its result (or the failure text) under a name.
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

/// A faux turn running one kernel cell.
fn cell_turn(code: &str) -> Value {
    json!([
        { "content": [
            { "type": "toolCall", "name": "ipython", "arguments": { "code": code } },
        ] },
        { "text": "cell turn done" },
    ])
}

/// Verifier (the misroute regression, all through the real workers' own
/// kernels): the family roster derives from durable parent edges, never
/// from names or runtime kinds. A second root's child is NOT addressable
/// from the first family by role or name (the sibling send for its name
/// fails closed), a broadcast reaches only the nuclear family, the
/// child's parent-reply targets its true parent with the `child:` label,
/// another family's subagent never renders as a child of the recipient,
/// and the observe roster labels only true edges: kid-a's own spawned
/// grandchild nests under kid-a (never top-level in the root's roster),
/// and the other family's rows never enter either roster.
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

    // Parent-a's one kernel turn records its own observe roster and its
    // broadcast receipts (its real worker token authorizes the roster).
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
        json!([
            { "content": [
                { "type": "toolCall", "name": "ipython", "arguments": { "code": parent_a_cell } },
            ] },
            { "text": "parent-a turn done" },
            { "text": "parent-a turn done" },
            { "text": "parent-a turn done" },
        ]),
    );
    // Parent-b only absorbs turns (a sibling root on the receiving side).
    let parent_b_script = write_faux_script(
        dir.path(),
        "parent-b",
        json!([{ "text": "parent-b turn done" }]),
    );
    // Kid-a's kernel turns: the cross-family sibling probe (must fail),
    // the parent reply (must reach the true parent), its own broadcast
    // (must reach only its parent), and its own observe roster (the
    // grandchild nests under it, never under the root).
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
    // One scripted turn per cell: the tool-call entry, then the text
    // entry that closes it (a nested array is not a valid script).
    let mut kid_responses = vec![
        json!({ "text": "kid spawned" }),
        // The parent's broadcast (target=all) delivers into this
        // session's steering queue during the spawn turn; the loop's
        // steering poll drains it as the spawn turn's follow-up. The
        // filler text absorbs that delivered message's turn so the
        // scripted cells align with the driven to-kid-N turns (without
        // it every cell runs one turn early and the observe cell reads
        // the roster before the grandchild spawns).
        json!({ "text": "kid absorbed the broadcast" }),
    ];
    for cell in &kid_cells {
        let turn = cell_turn(cell);
        kid_responses.push(turn[0].clone());
        kid_responses.push(turn[1].clone());
    }
    let kid_script = write_faux_script(dir.path(), "kid", json!(kid_responses));

    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    let mut roots = Vec::new();
    for (name, script) in [("parent-a", parent_a_script), ("parent-b", parent_b_script)] {
        client.send_command(
            &format!("create-{name}"),
            json!({
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
    let (parent_b_active, _parent_b_session, _parent_b_file) = &roots[1];

    // Each root spawns its own child; the second family's child name is
    // one the first family might address (the historical misroute landed
    // on exactly such name-keyed sends).
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
            })
            .await
            .expect("spawn the child");
        assert_eq!(handle.name, kid_name);
        children.notify_turn_done();
        // The spawn turn settles once the child goes idle with an answer.
        loop {
            let roster = children.list_subagents().await.expect("child roster");
            let row = roster.first().expect("one child row");
            if row.status == "completed" || row.status == "error" {
                assert_eq!(row.status, "completed", "spawn turn: {row:?}");
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let roster = children.list_subagents().await.expect("child roster");
        let row = roster.first().expect("one child row");
        assert_eq!(row.session_name, kid_name);
        // The spawn row can settle in the admission-to-turn-pop window (the
        // watcher's stability re-check), before the child's first turn
        // writes its session file; the durable artifact is the proof, so
        // wait for it (bounded) before reading.
        let kid_session_id = row.session_id.clone().expect("child persisted id");
        // The per-child artifact dir IS the rlm child id (it already
        // carries the "sub-" prefix); do not prefix it again.
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
        // The kid's own session file (the grandchild's durable parent
        // edge): the spawn's per-child artifact dir holds exactly one.
        let kid_files: Vec<std::fs::DirEntry> = std::fs::read_dir(
            agent_dir
                .join("session-artifacts")
                .join(session)
                .join(&handle.rlm_child_id),
        )
        .expect("kid artifact dir")
        .flatten()
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .collect();
        assert_eq!(kid_files.len(), 1, "one kid session file: {kid_files:?}");
        kids.push((
            row.active_session_id.clone().expect("child active id"),
            row.session_id.clone().expect("child persisted id"),
            kid_files[0].path().to_string_lossy().to_string(),
        ));
    }
    let (kid_a_active, kid_a_session, kid_a_file) = &kids[0];
    let kid_b_active = &kids[1].0;

    // The kid's script accounts for the parent's broadcast draining into
    // its steering queue as the spawn turn's follow-up (the filler turn):
    // parent-a's first turn — the spawn-settle notice — runs the cell
    // that sends it. That notice rides a watcher with second-scale
    // cadence, so gate the drives on its own observable: once the
    // broadcast receipt exists the delivery completed, the broadcast is
    // already ahead of every drive in the FIFO steering lane, and each
    // scripted cell lands on its driven turn no matter when the drain
    // fires. Ungated, a slow notice shifts every cell one turn late and
    // the observe cell runs out of driven turns — its receipt then never
    // appears (the receipt-absent red).
    let _parent_broadcast = read_recorded(&receipts_dir, "parent-broadcast.json");

    // Drive kid-a's kernel turns: the cross-family sibling probe, the
    // parent reply, and its own broadcast.
    let drive_kid_turn = |client: &mut Client, id: &str, message: &str| {
        client.send_command(
            id,
            json!({
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

    // The grandchild: a second-family worker spawned through a registry
    // bound to KID-A's durable identity (depth 1 -> the grandchild runs
    // at depth 2, its parent edge keyed by kid-a's persisted id and
    // session file). It joins the supervisor roster as a live resident,
    // exactly like a grandchild kid-a itself would have spawned.
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
        })
        .await
        .expect("spawn the grandchild");
    assert_eq!(grandkid_handle.name, "grandkid");
    kid_children.notify_turn_done();
    let grandkid_active = loop {
        let roster = kid_children.list_subagents().await.expect("roster");
        let row = roster.first().expect("one grandchild row");
        if row.status == "completed" || row.status == "error" {
            assert_eq!(row.status, "completed", "grandchild spawn turn: {row:?}");
            break row.active_session_id.clone().expect("grandchild active id");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };

    // Kid-a's own observe roster: the grandchild nests under its true
    // parent.
    drive_kid_turn(&mut client, "to-kid-4", "drive the kid observe");
    // The cross-family sibling probe fails closed: the kernel raises the
    // host error, and the recorded traceback carries the TS error text
    // (the send resolves no sibling — the other family's session is not
    // addressable by name from this family).
    let crossed = match std::fs::read_to_string(receipts_dir.join("kid-sibling-cross.error")) {
        Ok(content) => content,
        Err(_) => {
            let transcript = client.messages("gm-kid-debug", kid_a_active);
            eprintln!("KEEP-DIR {}", dir.path().display());
            if std::env::var_os("PA_E2E_KEEP_DIR").is_some() {
                std::mem::forget(dir);
            }
            let daemon_log = std::fs::read_to_string(socket.with_extension("daemon.log"))
                .unwrap_or_else(|_| "<no daemon log>".to_string());
            panic!(
                "no sibling-probe record: success receipt: {:?}; kid-a transcript: {}; daemon log tail: {}",
                std::fs::read_to_string(receipts_dir.join("kid-sibling-cross.json")).ok(),
                transcript,
                daemon_log
                    .chars()
                    .rev()
                    .take(4000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            );
        }
    };
    assert!(
        crossed.contains("No sibling matches"),
        "a cross-family sibling send must fail closed: {crossed}"
    );
    if let Ok(error) = std::fs::read_to_string(receipts_dir.join("kid-parent-reply.error")) {
        panic!("kid kernel cell failed: {error}");
    }
    // The parent reply reaches the TRUE parent by its durable edge.
    let parent_reply = read_recorded(&receipts_dir, "kid-parent-reply.json");
    assert_eq!(
        parent_reply["target"]["activeSessionId"], *parent_a_active,
        "the parent reply reaches the true parent: {parent_reply}"
    );
    assert_eq!(parent_reply["receiverRole"], "parent", "{parent_reply}");
    if let Ok(error) = std::fs::read_to_string(receipts_dir.join("kid-broadcast.error")) {
        panic!("kid kernel cell failed: {error}");
    }
    // The TS broadcast ("all") reaches the family roster, which for a
    // subagent includes its own children; the grandkid's presence
    // depends on the broadcast-versus-spawn interleaving, so pin the
    // isolation, not the exact set.
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
        !kid_targets.contains(&kid_b_active.as_str())
            && !kid_targets.contains(&parent_b_active.as_str()),
        "the child's broadcast never crosses families: {kid_broadcast}"
    );
    if let Ok(error) = std::fs::read_to_string(receipts_dir.join("kid-observe.error")) {
        panic!("kid kernel cell failed: {error}");
    }
    // The grandchild nests under its TRUE parent: kid-a's observe roster
    // is its nuclear family — itself, its parent, its own child — and
    // the other family never appears.
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
            |summary| summary["activeSessionId"] == kid_b_active.as_str()
                || summary["activeSessionId"] == parent_b_active.as_str()
        ),
        "the other family never enters kid-a's roster: {kid_roster:?}"
    );

    // Drive parent-a's one kernel turn: its observe roster and its own
    // broadcast.
    client.send_command(
        "to-parent-a",
        json!({
            "type": "send_message",
            "targetActiveSessionId": parent_a_active,
            "message": "drive the parent turn",
            "fromActiveSessionId": parent_b_active,
            "agentOrigin": true,
        }),
    );
    let response = client.read_response("to-parent-a");
    assert_eq!(
        response["success"], true,
        "send to-parent-a failed: {response}"
    );
    client.wait_idle("to-parent-a", parent_a_active);
    if let Ok(error) = std::fs::read_to_string(receipts_dir.join("parent-observe.error")) {
        panic!("parent kernel cell failed: {error}");
    }
    // The parent's observe roster: itself (isCurrent), the sibling root,
    // its own child — labeled by durable edges, never another family's
    // subagent.
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
    let sibling_row = by_id(parent_b_active);
    assert_eq!(sibling_row["relationship"], "sibling", "{sibling_row:?}");
    let child_row = by_id(kid_a_active);
    assert_eq!(child_row["relationship"], "child", "{child_row:?}");
    assert!(
        !roster
            .iter()
            .any(|summary| { summary["activeSessionId"].as_str() == Some(kid_b_active.as_str()) }),
        "another family's subagent is never in the observe roster: {roster:?}"
    );
    // The grandchild never renders top-level in the root's view: it is
    // outside parent-a's nuclear family, nested under kid-a in kid-a's
    // own roster (the mislabeled-grandchild regression).
    assert!(
        !roster
            .iter()
            .any(|summary| summary["activeSessionId"] == grandkid_active.as_str()),
        "a grandchild never renders top-level in the root's roster: {roster:?}"
    );
    if let Ok(error) = std::fs::read_to_string(receipts_dir.join("parent-broadcast.error")) {
        panic!("parent kernel cell failed: {error}");
    }
    // The parent's broadcast reaches its sibling root and its own child —
    // never the other family's child.
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
    parent_targets.sort();
    let mut expected = vec![parent_b_active.as_str(), kid_a_active.as_str()];
    expected.sort();
    assert_eq!(
        parent_targets, expected,
        "the parent's broadcast stays inside its nuclear family: {parent_broadcast}"
    );

    // The rendered transcript labels: the child's reply rendered with the
    // `child:` prefix on its true parent; another family's subagent
    // (kid-b, delivered here as a probe) renders WITHOUT the label —
    // the mislabeled-ack regression.
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
        json!({
            "type": "send_message",
            "targetActiveSessionId": parent_a_active,
            "message": "foreign probe",
            "fromActiveSessionId": kid_b_active,
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
