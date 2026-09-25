//! Worker-to-worker peer messaging e2e (thin-supervisor stage 3).
//!
//! Three verifiers over real spawned worker processes and real supervisor
//! processes:
//!
//! 1. A kernel `agent_message.send` in worker A resolves the target through
//!    the supervisor roster, mints a single-use `worker` ticket, burns it on
//!    worker B's own socket, and delivers the message with the TS sender
//!    identity block; B runs the rendered prompt exactly once.
//! 2. The previously-hanging client-to-client shape (two attached clients,
//!    a message from A's kernel into session B) completes: the receipt is
//!    observed, the prompt renders once in B, and the supervisor's route
//!    plane never starves (both clients stay served afterwards).
//! 3. A supervisor `kill -9` mid-conversation does not stop messaging: the
//!    workers re-register with the restarted supervisor and the next kernel
//!    send still delivers.
//!
//! The sessions run the real agent engine over the scripted faux provider
//! (`engine: "faux"`), so the kernel host request, the supervisor link, the
//! peer ticket, and the direct socket delivery are all exercised for real.
//!
//! Linux-only e2e (`AF_UNIX` sockets, process-group kills): compiles to
//! nothing elsewhere, like the other pa-daemon e2e verifiers.
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

/// The kernel Python with prime-agent-runtime installed (the same
/// interpreter the TS product's ambient kernel venv provides). The tests
/// need it: the kernel executes the `agent_message.send` host request.
/// Skipped (with a note) on machines without a live install.
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
        "kernel python {} not found; skipping live peer-messaging e2e",
        candidate.display()
    );
    None
}

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

    fn send(&mut self, value: &Value) {
        let mut line = serde_json::to_string(value).expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn send_command(&mut self, id: &str, command: Value) {
        self.send(&json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        }));
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
                Ok(_) if line.trim().is_empty() => {}
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
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

/// One faux-engine session script written to disk.
fn write_faux_script(dir: &Path, name: &str, responses: Value) -> PathBuf {
    let path = dir.join(format!("{name}.json"));
    std::fs::write(
        &path,
        json!({ "engine": "faux", "responses": responses }).to_string(),
    )
    .expect("write faux script");
    path
}

/// The kernel cell that sends one agent message and records the receipt
/// (or the failure) on disk for the test to read. The kernel's `rlm` name is
/// the namespace object; `host_request` imports from the runtime module.
fn send_cell(message: &str, receiver_name: &str, receipt_path: &Path) -> String {
    format!(
        "from rlm import host_request\nimport json, traceback\ntry:\n    receipt = await host_request(\"agent_message.send\", {{\"message\": {message:?}, \"receiver_role\": \"sibling\", \"receiver_name\": {receiver_name:?}}})\n    open({receipt_path:?}, \"w\").write(json.dumps(receipt))\nexcept Exception:\n    open({error_path:?}, \"w\").write(traceback.format_exc())",
        receipt_path = receipt_path.display().to_string(),
        error_path = receipt_path.with_extension("error").display().to_string(),
    )
}

struct Session {
    active_session_id: String,
    session_id: String,
}

/// Create one named faux-engine session through the supervisor.
fn create_session(
    client: &mut Client,
    id: &str,
    name: &str,
    script: &Path,
    dir: &Path,
    sessions_dir: &Path,
) -> Session {
    client.send_command(
        id,
        json!({
            "type": "create",
            "name": name,
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script.to_string_lossy(),
            },
        }),
    );
    let response = client.read_response(id);
    assert_eq!(
        response["success"], true,
        "create {name} failed: {response}"
    );
    let data = &response["data"];
    Session {
        active_session_id: data["activeSessionId"]
            .as_str()
            .or_else(|| data["id"].as_str())
            .expect("active session id")
            .to_string(),
        session_id: data["sessionId"].as_str().unwrap_or_default().to_string(),
    }
}

fn prompt(client: &mut Client, id: &str, active_session_id: &str, text: &str) {
    client.send_command(
        id,
        json!({ "type": "prompt", "activeSessionId": active_session_id, "message": text }),
    );
    let response = client.read_response(id);
    assert_eq!(response["success"], true, "prompt failed: {response}");
}

fn wait_idle(client: &mut Client, id: &str, active_session_id: &str) {
    client.send_command(
        id,
        json!({ "type": "wait_for_idle", "activeSessionId": active_session_id }),
    );
    let response = client.read_response(id);
    assert_eq!(
        response["success"], true,
        "wait_for_idle failed: {response}"
    );
}

/// The session's messages through the supervisor route.
fn messages(client: &mut Client, id: &str, active_session_id: &str) -> String {
    client.send_command(
        id,
        json!({ "type": "get_messages", "activeSessionId": active_session_id }),
    );
    let response = client.read_response(id);
    assert_eq!(response["success"], true, "get_messages failed: {response}");
    serde_json::to_string(&response["data"]).expect("messages json")
}

/// A proof harness: supervisor, two faux sessions, a client.
struct Messaging {
    dir: tempfile::TempDir,
    daemon: Daemon,
    socket: PathBuf,
    receipts_dir: PathBuf,
    alpha: Session,
    beta: Session,
}

/// The receipt the kernel cell recorded for `index`, or the recorded
/// failure (which fails the test with the traceback).
fn read_receipt(messaging: &Messaging, index: usize) -> Value {
    let receipt_path = messaging.receipts_dir.join(format!("{index}.json"));
    let error_path = messaging.receipts_dir.join(format!("{index}.error"));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(error) = std::fs::read_to_string(&error_path) {
            panic!("agent_message.send failed in the kernel cell: {error}");
        }
        if let Ok(content) = std::fs::read_to_string(&receipt_path) {
            return serde_json::from_str(&content).expect("receipt json");
        }
        assert!(
            Instant::now() < deadline,
            "receipt {index} never appeared in {}",
            messaging.receipts_dir.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The alpha script: one tool-call turn that sends a message (recording
/// its receipt at `receipts/0.json`), followed by a closing text turn. The
/// worker's faux engine re-registers the response queue per turn, so every
/// prompted turn replays this pair.
/// Two full turns of alpha script (a send tool call plus the closing text
/// each): the faux provider queues its responses across the whole session,
/// so the second post-restart turn consumes the second pair.
fn alpha_responses(receipts_dir: &Path) -> Value {
    let receipt_path = receipts_dir.join("0.json");
    json!([
        { "content": [
            { "type": "toolCall", "name": "ipython", "arguments": {
                "code": send_cell("hello from alpha", "beta", &receipt_path),
            } },
        ] },
        { "text": "alpha turn done" },
        { "content": [
            { "type": "toolCall", "name": "ipython", "arguments": {
                "code": send_cell("hello from alpha", "beta", &receipt_path),
            } },
        ] },
        { "text": "alpha turn done" },
    ])
}

fn setup_messaging() -> Option<Messaging> {
    let kernel_python = kernel_python()?;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let receipts_dir = dir.path().join("receipts");
    std::fs::create_dir_all(&receipts_dir).expect("receipts dir");
    let alpha_path = write_faux_script(dir.path(), "alpha", alpha_responses(&receipts_dir));
    // One reply per delivered prompt (two turns arrive over the session).
    let beta_path = write_faux_script(
        dir.path(),
        "beta",
        json!([ { "text": "beta reply" }, { "text": "beta reply" } ]),
    );

    let receipts = receipts_dir;
    let daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, _hello) = Client::connect(&socket);
    let alpha = create_session(
        &mut client,
        "create-a",
        "alpha",
        &alpha_path,
        dir.path(),
        &sessions_dir,
    );
    let beta = create_session(
        &mut client,
        "create-b",
        "beta",
        &beta_path,
        dir.path(),
        &sessions_dir,
    );
    Some(Messaging {
        dir,
        daemon,
        socket,
        receipts_dir: receipts,
        alpha,
        beta,
    })
}

/// Verifier 1: a kernel send in worker A delivers straight through the
/// peer transport into worker B, with the TS sender identity.
#[test]
fn worker_to_worker_kernel_send_delivers_over_the_peer_transport() {
    let Some(messaging) = setup_messaging() else {
        return;
    };
    let Messaging {
        ref alpha,
        ref beta,
        ..
    } = &messaging;
    let (mut client, _hello) = Client::connect(&messaging.socket);

    prompt(
        &mut client,
        "p1",
        &alpha.active_session_id,
        "introduce yourself to beta",
    );
    wait_idle(&mut client, "w1", &alpha.active_session_id);
    // B runs the delivered prompt.
    wait_idle(&mut client, "w2", &beta.active_session_id);

    // The kernel cell observed the delivery receipt: the TS receipt shape
    // with the target endpoint and the delivery status.
    let receipt = read_receipt(&messaging, 0);
    assert_eq!(
        receipt["target"]["activeSessionId"], beta.active_session_id,
        "the receipt targets B: {receipt}"
    );
    assert_eq!(receipt["target"]["sessionId"], beta.session_id);
    assert_eq!(receipt["deliveryStatus"], "delivered", "{receipt}");
    assert_eq!(receipt["deliveryMode"], "steer");
    assert!(receipt["id"].as_str().unwrap().starts_with("agentmsg_"));
    let alpha_messages = messages(&mut client, "gm1", &alpha.active_session_id);
    assert!(
        alpha_messages.contains("alpha turn done"),
        "A's turn finished: {alpha_messages}"
    );

    // B rendered the agent-message prompt exactly once, from the TS sender
    // identity (the sending session's name).
    let beta_messages = messages(&mut client, "gm2", &beta.active_session_id);
    let prompt = "[agent-message from alpha]\\n\\nhello from alpha";
    assert_eq!(
        beta_messages.matches(prompt).count(),
        1,
        "B must render the delivered prompt once: {beta_messages}"
    );
    assert!(
        beta_messages.contains("beta reply"),
        "B answered the delivered prompt: {beta_messages}"
    );
    // The delivery renders as the agent_message custom row (TS
    // `createAgentSessionMessage`): the rendered prompt is the row content
    // and the raw body rides `details.message`, so the body shows up in
    // both. The delivered prompt is still the only extra prompt B ever
    // saw.
    assert_eq!(
        beta_messages.matches("hello from alpha").count(),
        2,
        "the body rides the card content and details.message: {beta_messages}"
    );
    let beta_rows: Value =
        serde_json::from_str(&beta_messages).expect("the messages payload parses");
    let delivered = beta_rows["messages"]
        .as_array()
        .expect("messages array")
        .iter()
        .find(|row| row.get("customType").and_then(Value::as_str) == Some("agent_message"))
        .expect("the delivered prompt renders as the agent_message custom row");
    assert_eq!(delivered["role"], "custom");
    assert_eq!(
        delivered["content"],
        "[agent-message from alpha]\n\nhello from alpha"
    );
    assert_eq!(delivered["display"], true);
    assert_eq!(delivered["details"]["message"], "hello from alpha");
    assert!(
        delivered["details"]["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("agentmsg_")),
        "the card details carry the delivery id: {delivered}"
    );

    // A's closing turn completed too.
    assert!(
        alpha_messages.contains("alpha turn done"),
        "A's turn finished: {alpha_messages}"
    );
}

/// Verifier 2: the previously-hanging client-to-client shape. Both clients
/// are attached; a kernel send from A into B completes with a receipt, B
/// renders the prompt once, and the supervisor's route plane stays healthy
/// (both clients keep getting answers afterwards).
#[test]
fn attached_client_to_client_send_completes_without_route_starvation() {
    let Some(messaging) = setup_messaging() else {
        return;
    };
    let Messaging {
        ref alpha,
        ref beta,
        ref socket,
        ..
    } = messaging;

    // Two attached clients, one per session.
    let (mut client_a, _hello_a) = Client::connect(socket);
    client_a.send_command(
        "attach-a",
        json!({ "type": "attach", "activeSessionId": alpha.active_session_id }),
    );
    let attached_a = client_a.read_response("attach-a");
    assert_eq!(attached_a["success"], true, "attach A failed: {attached_a}");
    let (mut client_b, _hello_b) = Client::connect(socket);
    client_b.send_command(
        "attach-b",
        json!({ "type": "attach", "activeSessionId": beta.active_session_id }),
    );
    let attached_b = client_b.read_response("attach-b");
    assert_eq!(attached_b["success"], true, "attach B failed: {attached_b}");

    // The send turn: A's kernel messages B while both clients are attached.
    prompt(
        &mut client_a,
        "p1",
        &alpha.active_session_id,
        "message beta please",
    );
    wait_idle(&mut client_a, "w1", &alpha.active_session_id);

    // B's attached client sees the delivered prompt turn.
    let started = Instant::now();
    let beta_messages = loop {
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "B never ran the delivered prompt"
        );
        let beta_messages = messages(&mut client_b, "gm2", &beta.active_session_id);
        if beta_messages.contains("beta reply") {
            break beta_messages;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(
        beta_messages.matches("[agent-message from alpha]").count(),
        1,
        "prompt rendered once in B: {beta_messages}"
    );
    assert!(beta_messages.contains("beta reply"), "{beta_messages}");

    // The receipt was observed by A's kernel.
    let receipt = read_receipt(&messaging, 0);
    assert_eq!(
        receipt["target"]["activeSessionId"], beta.active_session_id,
        "receipt observed: {receipt}"
    );

    // No route starvation: both clients keep getting fresh answers, and
    // events still flow to the attached clients.
    let served_by = Instant::now();
    client_a.send_command(
        "state-a",
        json!({ "type": "get_state", "activeSessionId": alpha.active_session_id }),
    );
    let state_a = client_a.read_response("state-a");
    assert_eq!(
        state_a["success"], true,
        "A's client stayed served: {state_a}"
    );
    client_b.send_command(
        "state-b",
        json!({ "type": "get_state", "activeSessionId": beta.active_session_id }),
    );
    let state_b = client_b.read_response("state-b");
    assert_eq!(
        state_b["success"], true,
        "B's client stayed served: {state_b}"
    );
    assert!(
        served_by.elapsed() < Duration::from_secs(5),
        "the supervisor route plane answered promptly"
    );
}

/// Verifier 3: a supervisor death mid-conversation does not stop the
/// workers; after they re-register with the restarted supervisor, the next
/// kernel send still delivers over the peer transport.
#[test]
fn supervisor_death_mid_conversation_still_delivers_after_re_registration() {
    let Some(mut messaging) = setup_messaging() else {
        return;
    };
    let alpha_id = messaging.alpha.active_session_id.clone();
    let beta_id = messaging.beta.active_session_id.clone();
    let agent_dir = messaging.dir.path().join("agent");

    let (mut client, _hello) = Client::connect(&messaging.socket);
    // Turn 1 completes before the supervisor dies.
    prompt(&mut client, "p1", &alpha_id, "first message");
    wait_idle(&mut client, "w1", &alpha_id);
    wait_idle(&mut client, "w2", &beta_id);
    let beta_messages = messages(&mut client, "gm1", &beta_id);
    assert_eq!(
        beta_messages.matches("[agent-message from alpha]").count(),
        1
    );

    // kill -9 the supervisor; both workers keep running.
    messaging.daemon.child.kill().expect("kill -9 supervisor");
    let _ = messaging.daemon.child.wait();

    // Restart the supervisor on the same socket and agent dir.
    let kernel_python = kernel_python().expect("kernel python was found in setup");
    let daemon = spawn_supervisor(&messaging.socket, &agent_dir, &kernel_python);
    messaging.daemon = daemon;
    wait_socket_ready(&messaging.socket);
    let (mut client, _hello2) = Client::connect(&messaging.socket);

    // Both workers re-register within a bounded window (the roster and the
    // worker connections come back with them).
    let started = Instant::now();
    let re_registered = loop {
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "workers did not re-register after the restart"
        );
        client.send_command("list", json!({ "type": "list" }));
        let response = client.read_response("list");
        let sessions = response["data"]["sessions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if sessions.len() == 2
            && sessions.iter().all(|session| {
                session
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.is_empty())
            })
        {
            break sessions;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(re_registered.len(), 2);

    // The next kernel send still delivers: the supervisor link reconnects,
    // the ticket mints against the rebuilt roster, and B runs the prompt.
    prompt(&mut client, "p2", &alpha_id, "second message");
    wait_idle(&mut client, "w3", &alpha_id);
    wait_idle(&mut client, "w4", &beta_id);

    // The post-restart send observed its own receipt (the script's second
    // turn rewrites the receipt file).
    let receipt = read_receipt(&messaging, 0);
    assert_eq!(
        receipt["target"]["activeSessionId"], beta_id,
        "post-restart receipt observed: {receipt}"
    );
    let beta_messages = messages(&mut client, "gm3", &beta_id);
    assert_eq!(
        beta_messages.matches("[agent-message from alpha]").count(),
        2,
        "both delivered prompts rendered in B: {beta_messages}"
    );
    // Each delivery's card carries the body twice (content plus
    // details.message), so two sends render the body four times while the
    // bracketed prompt stays once per send.
    assert_eq!(
        beta_messages.matches("hello from alpha").count(),
        4,
        "the delivered message body rendered twice per send: {beta_messages}"
    );
}
