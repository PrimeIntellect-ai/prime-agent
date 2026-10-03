//! Swarm starvation eval e2e smoke: the harness over a real daemon swarm.
//!
//! One real supervisor, one real orchestrator worker session, and one real
//! child worker session scripted to reply over the real agent-message
//! delivery path with its REPORT line. The test runs the harness exactly as
//! the driver does: build the orchestrator prompt, drive the crew, wait for
//! the ANSWER, derive the messaging snapshot from the session transcript,
//! score the defense lines, and render the report.
//!
//! The orchestrator's spawn step is driven by the test through the daemon
//! `create` command (the same shape the RLM child host builds), because a
//! scripted parent cannot run the product `rlm.spawn` call from a faux
//! engine. The agent-message delivery, the transcript, the counters, and the
//! scoring are all real; only the spawn initiation is test-driven.
//!
//! The parent and child engines are scripted faux engines (the child answer
//! and the orchestrator's ANSWER line are the script's, not a model's), so
//! this verifies the harness plumbing end to end without spending tokens.
//!
//! Unix-only e2e (`AF_UNIX` sockets); skipped when no current kernel
//! Python is installed (`PA_E2E_KERNEL_PYTHON` overrides the default).
// Pedantic-gate dispositions (fleet-uniform ruling; see this lane's PR for
// the full rationale).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_core::swarm_eval::transcript::snapshot_from_transcript;
use pa_core::swarm_eval::{
    build_child_prompt, build_orchestrator_prompt, evaluate_messaging_defense_lines,
    parse_answer_line, render_markdown_report, seeded_secrets, trial_result_from_snapshot,
    ArrivalPattern, MessageSize, MessagingDefenseLineLimits, SwarmEvalConfig,
};
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
    let log_file = std::fs::File::create(socket.with_extension("daemon.log")).expect("log file");
    let log_err = log_file.try_clone().expect("clone log file");
    let child = Command::new(binary)
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .env("PRIME_AGENT_KERNEL_PYTHON", kernel_python)
        // Hermetic agent dir: the ambient environment exports a real agent
        // dir; point every fallback at the test sandbox instead.
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .env_remove("PRIME_API_KEY")
        .stdout(Stdio::null())
        .stderr(Stdio::from(log_err))
        // A supervisor killed at teardown must not leak its session workers
        // into later test binaries: the worker's supervisor-lost exit (TS
        // `exitIfSupervisorOrphanedForTooLong`) runs on this short window.
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
        "kernel python {} not found; skipping live swarm starvation eval e2e",
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
        let deadline = Instant::now() + Duration::from_secs(30);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                // A large supervisor frame can straddle the 100ms read
                // windows: the buffer keeps a partial frame's bytes across
                // the poll timeouts and resets only after a complete line
                // is consumed — the same fragmentation fix the driver's
                // own client carries.
                Ok(_) if line.trim().is_empty() => line.clear(),
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse line"),
                // Only the poll timeout (WouldBlock on Unix, TimedOut on
                // Windows) means "no line yet"; any other read error is
                // persistent and fails the read instead of busy-looping
                // to the deadline.
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.kind() == std::io::ErrorKind::TimedOut =>
                {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for supervisor line: {error}"
                    );
                }
                Err(error) => panic!("supervisor socket error: {error}"),
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

    fn command(&mut self, id: &str, command: &Value) -> Value {
        self.send_command(id, command);
        let response = self.read_response(id);
        assert_eq!(response["success"], true, "{id} failed: {response}");
        response["data"].clone()
    }
}

/// One faux engine script written to disk.
fn write_faux_script(dir: &Path, name: &str, responses: &Value) -> PathBuf {
    let path = dir.join(format!("{name}.json"));
    std::fs::write(
        &path,
        json!({ "engine": "faux", "responses": responses }).to_string(),
    )
    .expect("write faux script");
    path
}

/// Field of a daemon response object, falling back to `id`.
fn summary_str(summary: &Value, key: &str) -> String {
    summary[key]
        .as_str()
        .or_else(|| summary["id"].as_str())
        .unwrap_or_else(|| panic!("create summary missing {key}: {summary}"))
        .to_string()
}

/// Create the scripted crew child through the supervisor (the shape the RLM
/// child host builds: a depth-1 session whose durable parent edge points at
/// the orchestrator, so the agent-message family view resolves
/// `receiver_role = "parent"`). The child's `script` makes it a scripted
/// worker.
fn create_child(
    client: &mut Client,
    dir: &Path,
    child_script: &Path,
    parent_active_session_id: &str,
    parent_session_id: &str,
    parent_session_file: &str,
) -> Value {
    let child_dir = dir
        .join("child-sessions")
        .join(parent_session_id)
        .join("sub-smoke-1");
    std::fs::create_dir_all(&child_dir).expect("child dir");
    client.command(
        "create-child",
        &json!({
            "type": "create",
            "name": "c1",
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": child_dir.to_string_lossy(),
                "script": child_script.to_string_lossy(),
                "rlmDepth": 1,
                "rlmMaxDepth": 2,
                "parentSessionPath": parent_session_file,
            },
            "runtimeMetadata": {
                "kind": "subagent",
                "rlmChildId": "sub-smoke-1",
                "rlmDepth": 1,
                "parentActiveSessionId": parent_active_session_id,
                "parentSessionId": parent_session_id,
                "parentSessionFile": parent_session_file,
            },
        }),
    )
}

/// The child's kernel cell: send the REPORT line to the parent, recording
/// the receipt (or the failure).
fn child_report_cell(secret: u32, receipt: &Path, error: &Path) -> String {
    format!(
        "import json, traceback\nfrom rlm import host_request\ntry:\n    receipt = await host_request(\"agent_message.send\", {{\"message\": \"REPORT {secret}\", \"receiver_role\": \"parent\"}})\n    open({receipt:?}, \"w\").write(json.dumps(receipt))\nexcept Exception:\n    open({error:?}, \"w\").write(traceback.format_exc())\n    raise",
        receipt = receipt.display().to_string(),
        error = error.display().to_string(),
    )
}

/// Create the scripted orchestrator session through the supervisor.
fn create_parent(client: &mut Client, dir: &Path, parent_script: &Path) -> Value {
    let sessions_dir = dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    client.command(
        "create",
        &json!({
            "type": "create",
            "name": "orchestrator",
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": parent_script.to_string_lossy(),
            },
        }),
    )
}

fn last_assistant_text(client: &mut Client, session_id: &str) -> Option<String> {
    let data = client.command(
        "last-text",
        &json!({ "type": "get_last_assistant_text", "activeSessionId": session_id }),
    );
    data["text"].as_str().map(str::to_string)
}

fn running_children(client: &mut Client, session_id: &str) -> usize {
    let data = client.command(
        "children",
        &json!({ "type": "get_rlm_children", "activeSessionId": session_id }),
    );
    data["children"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter(|row| row["status"] == json!("running"))
                .count()
        })
        .unwrap_or_default()
}

fn messages(client: &mut Client, session_id: &str) -> Vec<Value> {
    let data = client.command(
        "messages",
        &json!({ "type": "get_messages", "activeSessionId": session_id }),
    );
    data["messages"].as_array().cloned().unwrap_or_default()
}

fn context_tokens(client: &mut Client, session_id: &str) -> Option<u64> {
    let data = client.command(
        "stats",
        &json!({ "type": "get_session_stats", "activeSessionId": session_id }),
    );
    data["contextUsage"]["tokens"].as_u64()
}

/// Poll until every child has settled and the ANSWER line is present.
fn wait_for_answer(client: &mut Client, session_id: &str) -> Option<String> {
    let deadline = Instant::now() + Duration::from_mins(1);
    loop {
        let text = last_assistant_text(client, session_id);
        let running = running_children(client, session_id);
        if running == 0 && parse_answer_line(text.as_deref()).is_some() {
            return text;
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// The receipts-dir listing plus any recorded kernel-cell failures.
fn receipt_listing(receipts: &Path) -> String {
    let mut names: Vec<String> = std::fs::read_dir(receipts)
        .map(|entries| {
            entries
                .filter_map(std::result::Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    let mut detail = names.join(", ");
    for name in ["spawn.error", "report.error", "spawn.json", "report.json"] {
        if let Ok(content) = std::fs::read_to_string(receipts.join(name)) {
            let _ = write!(detail, "\n{name}: {content}");
        }
    }
    detail
}

#[test]
fn swarm_eval_smoke_scores_a_real_one_child_swarm() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let socket = dir.path().join("supervisor.sock");
    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    // The harness configuration, its deterministic secret, and the two prompt
    // halves the driver hands to the session.
    let config = SwarmEvalConfig {
        model: "scripted/faux-1".to_string(),
        sizes: vec![1],
        message_size: MessageSize::Short,
        pattern: ArrivalPattern::Spread,
        trials: 1,
        gap_seconds: 2.0,
        timeout_minutes: 15.0,
        out_dir: dir.path().join("reports").to_string_lossy().to_string(),
        seed: 1,
    };
    let secrets = seeded_secrets(config.seed, 1);
    let secret = secrets[0];
    let orchestrator_prompt = build_orchestrator_prompt(&config, 1, &secrets);

    let receipts = dir.path().join("receipts");
    std::fs::create_dir_all(&receipts).expect("receipts dir");

    // The child's scripted turn: reply with the REPORT line.
    let child_script = write_faux_script(
        dir.path(),
        "child",
        &json!([
            { "content": [ { "type": "toolCall", "name": "ipython", "arguments": { "code": child_report_cell(secret, &receipts.join("report.json"), &receipts.join("report.error")) } } ] },
            { "text": "child turn done" },
        ]),
    );
    // The parent's scripted turns: the spawn turn, then the answer once the
    // child's REPORT arrives.
    let parent_script = write_faux_script(
        dir.path(),
        "parent",
        &json!([
            { "text": "spawn turn done" },
            { "text": format!("ANSWER: {secret}") },
        ]),
    );

    let created = create_parent(&mut client, dir.path(), &parent_script);
    let session_id = summary_str(&created, "activeSessionId");
    let parent_session_id = summary_str(&created, "sessionId");
    let parent_session_file = summary_str(&created, "sessionFile");

    let started = Instant::now();
    client.send_command(
        "prompt",
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": orchestrator_prompt }),
    );
    let prompted = client.read_response("prompt");
    assert_eq!(prompted["success"], true, "prompt failed: {prompted}");

    // The orchestrator's spawn step, driven here (see the module doc): create
    // the scripted child, then hand it the built child prompt. Its REPORT
    // reaches the orchestrator over the real agent-message path and drives
    // the orchestrator's ANSWER turn.
    let child = create_child(
        &mut client,
        dir.path(),
        &child_script,
        &session_id,
        &parent_session_id,
        &parent_session_file,
    );
    let child_session_id = summary_str(&child, "activeSessionId");
    client.send_command(
        "prompt-child",
        &json!({
            "type": "prompt",
            "activeSessionId": child_session_id,
            "message": build_child_prompt(0, secret, &config),
        }),
    );
    let child_prompted = client.read_response("prompt-child");
    assert_eq!(
        child_prompted["success"], true,
        "child prompt failed: {child_prompted}"
    );

    let Some(answer) = wait_for_answer(&mut client, &session_id) else {
        panic!(
            "timed out waiting for the ANSWER line; receipts={}",
            receipt_listing(&receipts)
        );
    };
    let seconds = started.elapsed().as_secs_f64();

    // The task verification: the orchestrator emitted every secret in order.
    assert_eq!(
        parse_answer_line(Some(answer.as_str())),
        Some(vec![u64::from(secret)]),
        "unexpected ANSWER: {answer:?}"
    );

    // Derive the snapshot from the daemon's session surfaces, score it, and
    // render the report exactly as the driver does.
    let transcript = messages(&mut client, &session_id);
    let snapshot = snapshot_from_transcript(&transcript, context_tokens(&mut client, &session_id));
    assert!(
        snapshot.arrivals.total >= 1,
        "the child REPORT must count as an arrival: {snapshot:?}; receipts={}",
        receipt_listing(&receipts)
    );
    assert!(
        snapshot.model_steps.total >= 2,
        "the orchestrator ran more than one step: {snapshot:?}"
    );
    assert!(
        snapshot.ingestion_steps.total >= 1,
        "the REPORT-triggered step must count as ingestion: {snapshot:?}"
    );

    let defense =
        evaluate_messaging_defense_lines(&snapshot, MessagingDefenseLineLimits::default());
    assert!(
        defense.context_share.passed.is_some(),
        "context share must be measurable with context tokens: {defense:?}"
    );

    let row = trial_result_from_snapshot(&config, 1, 1, &snapshot, true, None, seconds);
    assert!(row.task_success);
    let report = render_markdown_report(&[row], &config);
    assert!(report.contains("| 1 | 1 |"), "{report}");
    assert!(report.contains("## Verdict"), "{report}");
}

/// The e2e client's `read_line` must keep a frame's partial bytes across a
/// read timeout: a supervisor line can straddle the client's 100ms read
/// window, and dropping the first chunk fails the frame's parse (the same
/// flake class the driver's own client already fixed). No supervisor
/// needed — the client runs against a scripted socket.
#[test]
fn e2e_client_survives_fragmented_supervisor_frames() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("frag.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).expect("bind socket");
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept");
        let mut writer = stream.try_clone().expect("clone stream");
        let mut reader = BufReader::new(stream);
        let _ = writeln!(writer, r#"{{"type":"daemon_hello"}}"#);
        let mut line = String::new();
        let _ = reader.read_line(&mut line);
        // The response arrives in two pieces with a gap wider than the
        // client's 100ms read window.
        let response = r#"{"id":"frag-1","type":"response","success":true,"data":{"text":"ok"}}"#;
        writer
            .write_all(&response.as_bytes()[..20])
            .expect("first chunk");
        writer.flush().expect("flush chunk");
        std::thread::sleep(Duration::from_millis(300));
        writer.write_all(&response.as_bytes()[20..]).expect("rest");
        writer
            .write_all(
                b"
",
            )
            .expect("newline");
        writer.flush().expect("flush rest");
    });
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    client.send_command(
        "frag-1",
        &json!({ "type": "get_last_assistant_text", "activeSessionId": "s" }),
    );
    let response = client.read_response("frag-1");
    assert_eq!(response["data"]["text"], "ok", "{response}");
}
