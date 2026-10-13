//! Model-facts switch e2e: a daemon `set_model` must rebind the kernel's
//! turn-boundary model facts to the switched-to model — `model.info` and
//! `compact.status`'s context window keep answering with the
//! session-creation model otherwise (the operator's `attach_image` vision
//! refusal on a switched-to vision model).
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
        "kernel python {} not found; skipping live model-facts e2e",
        candidate.display()
    );
    None
}

struct Supervisor {
    child: Child,
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path, kernel_python: &Path) -> Supervisor {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("PRIME_AGENT_KERNEL_PYTHON", kernel_python)
        .env_remove("PRIME_API_KEY")
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        // A supervisor killed at teardown must not leak its session workers
        // into later test binaries: the worker's supervisor-lost exit runs
        // on this short window instead of the 5-minute default.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if socket.exists() {
            return Supervisor {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
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

/// The models.json pair the switch walks: `text-a` is text-only with a
/// 100k window, `vision-b` takes images with a 200k window. Both carry the
/// faux api so the scripted turn streams through the registered faux
/// provider whatever model the session runs.
fn write_models_json(agent_dir: &Path) {
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "battery": {
                    "api": "faux",
                    "baseUrl": "http://127.0.0.1:9",
                    "apiKey": "sk-battery",
                    "models": [
                        {
                            "id": "text-a",
                            "name": "Text A",
                            "api": "faux",
                            "reasoning": false,
                            "input": ["text"],
                            "contextWindow": 100_000,
                            "maxTokens": 4096
                        },
                        {
                            "id": "vision-b",
                            "name": "Vision B",
                            "api": "faux",
                            "reasoning": false,
                            "input": ["text", "image"],
                            "contextWindow": 200_000,
                            "maxTokens": 4096
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
}

/// One probe cell: the kernel-side `model.info` and `compact.status` host
/// requests answered inside the turn, written to a receipt for the verifier.
fn probe_cell(receipt: &Path) -> String {
    format!(
        "import json\nfrom rlm import host_request\npayload = {{}}\npayload[\"model_info\"] = await host_request(\"model.info\", {{}})\npayload[\"compact_status\"] = await host_request(\"compact.status\", {{}})\nopen({receipt:?}, \"w\").write(json.dumps(payload))\nprint(\"FACTS_PROBED\")",
        receipt = receipt.display().to_string(),
    )
}

/// A faux script whose two turns each run one probe cell and settle.
fn write_faux_script(dir: &Path, on_a: &Path, on_b: &Path) -> PathBuf {
    let script = dir.join("faux.json");
    std::fs::write(
        &script,
        json!({
            "engine": "faux",
            "responses": [
                { "content": [
                    { "type": "toolCall", "name": "python_repl", "arguments": {
                        "code": probe_cell(on_a),
                    } },
                ] },
                { "text": "probed" },
                { "content": [
                    { "type": "toolCall", "name": "python_repl", "arguments": {
                        "code": probe_cell(on_b),
                    } },
                ] },
                { "text": "probed" },
            ],
        })
        .to_string(),
    )
    .expect("write faux script");
    script
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

/// Read a probe cell's receipt: the cell runs inside a settled turn, so
/// the file is on disk once the idle wait returns. A missing receipt
/// means the tool call failed — the turn's tool result names why.
fn read_receipt(client: &mut Client, session_id: &str, receipt: &Path, read_id: &str) -> Value {
    let raw = std::fs::read_to_string(receipt).unwrap_or_else(|error| {
        client.send_command(
            read_id,
            &json!({ "type": "get_messages", "activeSessionId": session_id }),
        );
        let messages = client.read_response(read_id);
        let tool_result = messages["data"]["messages"]
            .as_array()
            .and_then(|rows| rows.iter().rev().find(|row| row["role"] == "toolResult"))
            .cloned()
            .unwrap_or(Value::Null);
        panic!(
            "probe cell receipt {} unreadable ({error}); the turn's tool result: {tool_result}",
            receipt.display()
        );
    });
    serde_json::from_str(&raw).unwrap_or_else(|error| panic!("receipt {raw:?}: {error}"))
}

/// A `set_model` switch must rebind the kernel's model facts: the second
/// turn's cell answers the switched-to model's `model.info` and context
/// window, not the session-creation model's.
#[test]
fn set_model_rebinds_the_kernel_model_facts() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    write_models_json(&agent_dir);
    let on_a = dir.path().join("facts-on-a.json");
    let on_b = dir.path().join("facts-on-b.json");
    let script = write_faux_script(dir.path(), &on_a, &on_b);
    let socket = dir.path().join("model-facts.sock");
    let _supervisor = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    client.send_command(
        "c1",
        &json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "script": script.to_string_lossy(),
                "provider": "battery",
                "model": "text-a",
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["activeSessionId"]
        .as_str()
        .or_else(|| created["data"]["id"].as_str())
        .expect("active session id")
        .to_string();

    // Turn 1 builds the session on the creation model; its cell records
    // the facts the session started with.
    run_turn(&mut client, &session_id, "probe the creation model", "t1");
    let facts_on_a = read_receipt(&mut client, &session_id, &on_a, "gm-a");
    assert_eq!(
        facts_on_a["model_info"],
        json!({ "id": "text-a", "provider": "battery", "input": ["text"] }),
        "model.info before the switch: {facts_on_a}"
    );
    assert_eq!(
        facts_on_a["compact_status"]["context_window"], 100_000,
        "context window before the switch: {facts_on_a}"
    );

    client.send_command(
        "sm",
        &json!({
            "type": "set_model",
            "activeSessionId": session_id,
            "provider": "battery",
            "modelId": "vision-b",
        }),
    );
    let switched = client.read_response("sm");
    assert_eq!(switched["success"], true, "set_model failed: {switched}");

    // Turn 2's cell must answer the switched-to model.
    run_turn(&mut client, &session_id, "probe the switched model", "t2");
    let facts_on_b = read_receipt(&mut client, &session_id, &on_b, "gm-b");
    assert_eq!(
        facts_on_b["model_info"],
        json!({ "id": "vision-b", "provider": "battery", "input": ["text", "image"] }),
        "model.info must follow the switched-to model: {facts_on_b}"
    );
    assert_eq!(
        facts_on_b["compact_status"]["context_window"], 200_000,
        "compact.status must follow the switched-to model's window: {facts_on_b}"
    );
}
