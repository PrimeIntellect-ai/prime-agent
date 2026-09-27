//! MCP product-path e2e: a settings-declared stdio MCP server reaches the
//! kernel's generic MCP client through the whole product stack.
//!
//! The verifier writes a `mcpServers` entry into the worker's agent-dir
//! `settings.json` pointing at the committed echo fixture, creates a real
//! daemon session over the real kernel (scripted faux provider), and runs a
//! turn whose ipython cell exercises `rlm.mcp.list_tools` and
//! `rlm.mcp.call_tool`. The kernel must resolve `mcp.config` through the
//! session's host handlers, spawn the fixture over stdio, list its `echo`
//! tool, and call it with the echoed argument.
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

/// The kernel Python with prime-agent-runtime (and its `mcp` package)
/// installed. Skipped (with a note) on machines without a live install.
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
        "kernel python {} not found; skipping live MCP product-path e2e",
        candidate.display()
    );
    None
}

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
        // Hermetic agent dir: the ambient environment exports this var
        // globally; point it at the test agent dir so every fallback that
        // reads it (supervisor, worker, kernel) resolves inside the test
        // sandbox instead of the shared real agent dir.
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .env_remove("PRIME_API_KEY")
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
        let deadline = Instant::now() + Duration::from_mins(2);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => {}
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

/// The kernel cell: list the fixture server's tools, call `echo`, record the
/// round trip on disk for the test (and print it so the tool result carries
/// the same proof).
fn mcp_cell(receipt_path: &Path) -> String {
    format!(
        "from rlm import mcp\nimport json, traceback\ntry:\n    tools = await mcp.list_tools(\"fixture-echo\")\n    result = await mcp.call_tool(\"fixture-echo\", \"echo\", {{\"message\": \"hello from the daemon e2e\"}})\n    payload = {{\"tools\": tools, \"result\": result}}\n    open({receipt_path:?}, \"w\").write(json.dumps(payload))\n    print(json.dumps(payload))\nexcept Exception:\n    open({error_path:?}, \"w\").write(traceback.format_exc())\n    raise",
        receipt_path = receipt_path.display().to_string(),
        error_path = receipt_path.with_extension("error").display().to_string(),
    )
}

/// The session's messages through the supervisor route.
fn messages(client: &mut Client, id: &str, active_session_id: &str) -> Vec<Value> {
    client.send_command(
        id,
        json!({ "type": "get_messages", "activeSessionId": active_session_id }),
    );
    let response = client.read_response(id);
    assert_eq!(response["success"], true, "get_messages failed: {response}");
    response["data"]["messages"]
        .as_array()
        .cloned()
        .expect("messages array")
}

/// The tool-result message rows the session recorded (TS `role: "toolResult"`).
fn tool_result_texts(session_messages: &[Value]) -> Vec<String> {
    session_messages
        .iter()
        .filter(|message| {
            message
                .get("role")
                .or_else(|| message.get("message").and_then(|m| m.get("role")))
                .and_then(Value::as_str)
                == Some("toolResult")
        })
        .map(|message| {
            let content = message
                .get("content")
                .or_else(|| message.get("message").and_then(|m| m.get("content")));
            match content {
                Some(Value::String(text)) => text.clone(),
                Some(Value::Array(blocks)) => blocks
                    .iter()
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => String::new(),
            }
        })
        .collect()
}

/// Settings-declared stdio server -> prompt gating -> `mcp.config` host
/// request -> kernel MCP client spawn -> `tools/list` -> `tools/call`.
#[test]
fn settings_declared_stdio_server_round_trips_through_the_kernel_mcp_client() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    // The committed stdio echo fixture (test env isolation: absolute paths,
    // because the kernel spawns the server process itself).
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("mcp_echo_server.py");
    assert!(fixture.exists(), "fixture missing: {fixture:?}");

    // The settings declaration the mcp gating reads at session create.
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({
            "mcpServers": {
                "fixture-echo": {
                    "type": "stdio",
                    "command": "python3",
                    "args": [fixture.to_string_lossy()],
                },
            },
        })
        .to_string(),
    )
    .expect("write settings.json");

    // The turn script: one ipython cell that runs the MCP round trip, then
    // a closing text turn.
    let receipts_dir = dir.path().join("receipts");
    std::fs::create_dir_all(&receipts_dir).expect("receipts dir");
    let receipt = receipts_dir.join("mcp.json");
    let script = dir.path().join("faux.json");
    std::fs::write(
        &script,
        json!({
            "engine": "faux",
            "responses": [
                { "content": [
                    { "type": "toolCall", "name": "ipython", "arguments": {
                        "code": mcp_cell(&receipt),
                    } },
                ] },
                { "text": "mcp round trip done" },
            ],
        })
        .to_string(),
    )
    .expect("write faux script");

    let socket = dir.path().join("mcp.sock");
    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    client.send_command(
        "c1",
        json!({
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
    let session_id = created["data"]["activeSessionId"]
        .as_str()
        .or_else(|| created["data"]["id"].as_str())
        .expect("active session id")
        .to_string();

    client.send_command(
        "p1",
        json!({ "type": "prompt", "activeSessionId": session_id, "message": "use the echo server" }),
    );
    let prompted = client.read_response("p1");
    assert_eq!(prompted["success"], true, "prompt failed: {prompted}");
    client.send_command(
        "w1",
        json!({ "type": "wait_for_idle", "activeSessionId": session_id }),
    );
    let idle = client.read_response("w1");
    assert_eq!(idle["success"], true, "wait_for_idle failed: {idle}");

    // The kernel cell recorded the round trip (or its failure, with the
    // traceback).
    let error_path = receipt.with_extension("error");
    let deadline = Instant::now() + Duration::from_secs(5);
    let payload = loop {
        if let Ok(error) = std::fs::read_to_string(&error_path) {
            panic!("MCP round trip failed in the kernel cell: {error}");
        }
        if let Ok(content) = std::fs::read_to_string(&receipt) {
            break serde_json::from_str::<Value>(&content).expect("receipt json");
        }
        assert!(
            Instant::now() < deadline,
            "receipt never appeared at {}",
            receipt.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    // tools/list: the fixture's single `echo` tool.
    let tools = payload["tools"].as_array().expect("tools array");
    assert_eq!(tools.len(), 1, "one tool: {payload}");
    assert_eq!(tools[0]["name"], "echo", "tool payload: {payload}");
    assert_eq!(
        tools[0]["description"], "Echoes the message argument back.",
        "tool payload: {payload}"
    );
    // tools/call: the echoed argument.
    assert_eq!(
        payload["result"], "hello from the daemon e2e",
        "echo result: {payload}"
    );

    // The same proof reached the session: the ipython tool result (cell
    // output) carries the tool name and the echoed argument.
    let session_messages = messages(&mut client, "m1", &session_id);
    let tool_results = tool_result_texts(&session_messages);
    let ipython_result = tool_results
        .iter()
        .find(|text| text.contains("hello from the daemon e2e"))
        .expect("ipython tool result with the echo payload: {tool_results:?}");
    assert!(
        ipython_result.contains("\"name\": \"echo\""),
        "tool name in the cell output: {ipython_result}"
    );
}

/// The `begin_login` host request is live in the daemon worker product path:
/// the kernel reaches the session's real MCP manager, which answers with
/// the TS wording for unknown servers (the full login flow is verified
/// against the fixture OAuth transport in the `mcp_login` unit tests — a
/// real login needs a live HTTPS provider, so this e2e pins the wiring).
#[test]
fn begin_login_host_request_is_live_in_the_worker() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let receipts_dir = dir.path().join("receipts");
    std::fs::create_dir_all(&receipts_dir).expect("receipts dir");
    let receipt = receipts_dir.join("begin-login.json");
    let error_receipt = receipt.with_extension("error");
    let cell = [
        "from rlm import host_request",
        "import json, traceback",
        "try:",
        "    outcomes = []",
        "    for payload in ({\"server\": \"unknown-e2e\"}, {}):",
        "        try:",
        "            await host_request(\"mcp.begin_login\", payload)",
        "            outcomes.append({\"ok\": True})",
        "        except Exception as exc:",
        "            outcomes.append({\"error\": str(exc)})",
        "    open(RECEIPT, \"w\").write(json.dumps(outcomes))",
        "    print(json.dumps(outcomes))",
        "except Exception:",
        "    open(ERROR_RECEIPT, \"w\").write(traceback.format_exc())",
        "    raise",
    ]
    .join("\n")
    .replace(
        "ERROR_RECEIPT",
        &format!("{:?}", error_receipt.display().to_string()),
    )
    .replace("RECEIPT", &format!("{:?}", receipt.display().to_string()));
    let script = dir.path().join("faux.json");
    std::fs::write(
        &script,
        json!({
            "engine": "faux",
            "responses": [
                { "content": [
                    { "type": "toolCall", "name": "ipython", "arguments": {
                        "code": cell,
                    } },
                ] },
                { "text": "begin_login probe done" },
            ],
        })
        .to_string(),
    )
    .expect("write faux script");

    let socket = dir.path().join("mcp.sock");
    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    client.send_command(
        "c1",
        json!({
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
    let session_id = created["data"]["activeSessionId"]
        .as_str()
        .or_else(|| created["data"]["id"].as_str())
        .expect("active session id")
        .to_string();
    client.send_command(
        "p1",
        json!({ "type": "prompt", "activeSessionId": session_id, "message": "probe begin_login" }),
    );
    assert_eq!(client.read_response("p1")["success"], true, "prompt failed");
    client.send_command(
        "w1",
        json!({ "type": "wait_for_idle", "activeSessionId": session_id }),
    );
    assert_eq!(
        client.read_response("w1")["success"],
        true,
        "wait_for_idle failed"
    );

    let deadline = Instant::now() + Duration::from_secs(5);
    let outcomes = loop {
        if let Ok(error) = std::fs::read_to_string(&error_receipt) {
            panic!("begin_login probe failed in the kernel cell: {error}");
        }
        if let Ok(content) = std::fs::read_to_string(&receipt) {
            break serde_json::from_str::<Value>(&content).expect("receipt json");
        }
        if Instant::now() > deadline {
            let session_messages = messages(&mut client, "dbg", &session_id);
            panic!(
                "receipt never appeared at {}; messages: {session_messages:?}",
                receipt.display()
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    // The manager answered with the TS wording: unknown integration, then
    // the missing-server error.
    let outcomes = outcomes.as_array().expect("outcomes array");
    assert_eq!(outcomes.len(), 2, "probe outcomes: {outcomes:?}");
    assert_eq!(
        outcomes[0]["error"], "Unknown MCP integration: unknown-e2e",
        "probe outcomes: {outcomes:?}"
    );
    assert_eq!(
        outcomes[1]["error"], "mcp.begin_login requires a server",
        "probe outcomes: {outcomes:?}"
    );
}
