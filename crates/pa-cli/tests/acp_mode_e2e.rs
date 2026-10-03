// The Tier-C/D ruling (fleet-uniform, 2026-09-28): stack-resident futures
// by design on hot paths (boxing 130 fns is allocation-churn with zero
// correctness gain); the fn-length threshold is a style gate, not
// correctness (the harness fns are intentionally linear); 64-bit targets -
// the narrowing sits at OS/protocol boundaries where the values are
// bounded (pid syscalls, epoch/elapsed milliseconds, calendar math,
// guarded parses), and checked conversions would add panic paths where
// silent wrap was deliberate (the one genuinely-suspect family, args.rs's
// parse_positive_u32 lacking its u32::MAX bound, is flagged in the lane
// dossier for the conductor).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! End-to-end ACP-mode verification: the real binary serves the ACP
//! JSON-RPC surface over stdio on the daemon-attached transport (a
//! sandboxed supervisor hosting a scripted faux worker), and the emitted
//! frames are checked against the TS capture corpus
//! (`crates/pa-daemon/testdata/acp`).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The child plus the tempdir it runs in: the tempdir must outlive the
/// child process (its cwd), so it is held on the struct.
struct AcpChild {
    child: Child,
    /// `None` once [`AcpChild::close_stdin`] sent EOF.
    stdin: Option<std::process::ChildStdin>,
    lines: Receiver<String>,
    next_id: u64,
    /// Held (never read) so the child's cwd directory outlives the process:
    /// dropping the tempdir deletes it and the child's `current_dir` fails.
    /// `None` for a second child sharing another child's home.
    _home: Option<tempfile::TempDir>,
    spawn_stderr: Option<std::process::ChildStderr>,
    /// The sandboxed supervisor socket the child spawned: the drop shuts
    /// the supervisor down with it (a killed child must not leak the
    /// supervisor into later test binaries).
    socket: std::path::PathBuf,
}

impl AcpChild {
    /// Wire one spawned process into the reader thread and the handle:
    /// the tempdir is held on the struct so the child's cwd directory
    /// outlives the process, and the supervisor socket is the one the
    /// drop shuts down.
    fn wrap(
        mut child: std::process::Child,
        home: Option<tempfile::TempDir>,
        socket: std::path::PathBuf,
    ) -> AcpChild {
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if tx.send(line).is_err() {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        AcpChild {
            child,
            stdin: Some(stdin),
            lines,
            next_id: 0,
            _home: home,
            spawn_stderr: Some(stderr),
            socket,
        }
    }

    /// The daemon-attached transport: the child spawns its own sandboxed
    /// supervisor on `<home>/daemon.sock` and hosts the scripted worker
    /// through the `PRIME_AGENT_FAUX_SCRIPT` create-config seam;
    /// the drop shuts the supervisor down. The socket sits on the struct
    /// for tests that speak raw daemon commands alongside the ACP frames.
    fn spawn(args: &[&str], script: &serde_json::Value) -> AcpChild {
        let home = tempfile::TempDir::new().unwrap();
        let socket = home.path().join("daemon.sock");
        std::fs::write(home.path().join("worker-script.json"), script.to_string()).unwrap();
        let child = daemon_attached_command(home.path(), &socket, args)
            .spawn()
            .expect("binary present");
        Self::wrap(child, Some(home), socket)
    }

    /// The daemon-attached lane whose `rlm.spawn` children are scripted:
    /// `<home>/child-script.json` rides the `PRIME_AGENT_FAUX_CHILD_SCRIPT`
    /// create-config seam (the worker already consumes the key), and the
    /// parent worker's kernel runs the given interpreter (the env flows
    /// ACP -> supervisor -> worker).
    fn spawn_with_child_script(
        args: &[&str],
        script: &serde_json::Value,
        child_script: &serde_json::Value,
        kernel_python: &std::path::Path,
    ) -> AcpChild {
        let home = tempfile::TempDir::new().unwrap();
        let socket = home.path().join("daemon.sock");
        let child_script_path = home.path().join("child-script.json");
        std::fs::write(home.path().join("worker-script.json"), script.to_string()).unwrap();
        std::fs::write(&child_script_path, child_script.to_string()).unwrap();
        let child = daemon_attached_command(home.path(), &socket, args)
            .env("PRIME_AGENT_FAUX_CHILD_SCRIPT", &child_script_path)
            .env("PRIME_AGENT_KERNEL_PYTHON", kernel_python)
            .spawn()
            .expect("binary present");
        Self::wrap(child, Some(home), socket)
    }

    fn send(&mut self, frame: &Value) {
        let mut line = serde_json::to_string(&frame).unwrap();
        line.push('\n');
        let stdin = self.stdin.as_mut().expect("stdin open");
        stdin.write_all(line.as_bytes()).unwrap();
        stdin.flush().unwrap();
    }

    /// Send EOF: the client disconnects.
    fn close_stdin(&mut self) {
        self.stdin = None;
    }

    fn request(&mut self, method: &str, params: &Value) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        id
    }

    fn notify(&mut self, method: &str, params: &Value) {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    /// Read frames until the request `id` answers; returns the answer with
    /// the notifications seen before it, in order.
    fn wait_response(&mut self, id: u64, timeout: Duration) -> (Value, Vec<Value>) {
        let deadline = Instant::now() + timeout;
        let mut notifications = Vec::new();
        loop {
            let timeout_left = deadline.saturating_duration_since(Instant::now());
            assert!(
                !timeout_left.is_zero(),
                "timed out waiting for response {id}"
            );
            match self.lines.recv_timeout(timeout_left) {
                Ok(line) => {
                    let frame: Value = serde_json::from_str(&line).expect("valid JSON line");
                    if frame.get("id").and_then(Value::as_u64) == Some(id)
                        && (frame.get("result").is_some() || frame.get("error").is_some())
                    {
                        return (frame, notifications);
                    }
                    notifications.push(frame);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    panic!("timed out waiting for response {id}")
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    panic!("ACP server closed stdout")
                }
            }
        }
    }

    /// Read frames until one matches — the predicate readiness signal,
    /// never a timer. The frames before it are dropped.
    fn wait_frame(
        &mut self,
        timeout: Duration,
        mut frame_matches: impl FnMut(&Value) -> bool,
    ) -> Value {
        let deadline = Instant::now() + timeout;
        loop {
            let timeout_left = deadline.saturating_duration_since(Instant::now());
            assert!(
                !timeout_left.is_zero(),
                "the stream never published the awaited frame"
            );
            let line = self
                .lines
                .recv_timeout(timeout_left)
                .expect("the ACP stream stayed open");
            let frame: Value = serde_json::from_str(&line).expect("valid JSON line");
            if frame_matches(&frame) {
                return frame;
            }
        }
    }

    /// Read frames until one `sessionUpdate` of `kind` arrives — the
    /// observed-event readiness signal, never a timer. The frames
    /// before it are dropped.
    fn wait_update(&mut self, kind: &str, timeout: Duration) {
        self.wait_frame(timeout, |frame| {
            frame["params"]["update"]["sessionUpdate"] == kind
        });
    }
}

/// The daemon-attached child's command on `home` and `socket`: the
/// supervisor-lost exit (TS `exitIfSupervisorOrphanedForTooLong`) runs on
/// a short window (the env flows child -> supervisor -> worker) instead
/// of the 5-minute default, and the worker script is
/// `<home>/worker-script.json`.
fn daemon_attached_command(
    home: &std::path::Path,
    socket: &std::path::Path,
    args: &[&str],
) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(args)
        .arg("--daemon-socket")
        .arg(socket)
        .env("HOME", home)
        .env("PRIME_AGENT_FAUX_SCRIPT", home.join("worker-script.json"))
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .current_dir(home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// The sandbox's single worker descriptor.
fn worker_descriptor(home: &std::path::Path) -> Value {
    std::fs::read_dir(home.join(".prime/agent/daemon-workers"))
        .expect("descriptor instances")
        .flatten()
        .flat_map(|instance| {
            std::fs::read_dir(instance.path())
                .expect("instance dir")
                .flatten()
        })
        .filter_map(|file| {
            serde_json::from_str::<Value>(&std::fs::read_to_string(file.path()).ok()?).ok()
        })
        .find(|descriptor| descriptor.get("authenticationToken").is_some())
        .expect("the worker descriptor")
}

impl Drop for AcpChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(mut stderr) = self.spawn_stderr.take() {
            use std::io::Read;
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            if !text.is_empty() {
                eprintln!("ACP child stderr: {text}");
            }
        }
        shutdown_sandboxed_daemon(&self.socket);
    }
}

fn initialize_params() -> Value {
    json!({
        "protocolVersion": 1,
        "clientCapabilities": {},
        "clientInfo": { "name": "acp-e2e", "title": "ACP E2E", "version": "0.0.1" },
    })
}

const TIMEOUT: Duration = Duration::from_mins(1);

/// The TS initialize response shape (capture `ts-happy_path.jsonl`), with the
/// version and sessionId-class fields normalized as volatile.
#[test]
fn acp_initialize_matches_the_ts_golden() {
    let script = json!({ "responses": ["unused"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let id = client.request("initialize", &initialize_params());
    let (response, notifications) = client.wait_response(id, TIMEOUT);
    assert!(notifications.is_empty(), "nothing precedes initialize");
    let result = &response["result"];
    assert_eq!(result["protocolVersion"], 1);
    let capabilities = &result["agentCapabilities"];
    assert_eq!(capabilities["loadSession"], false);
    assert_eq!(
        capabilities["promptCapabilities"],
        json!({ "image": true, "embeddedContext": true })
    );
    assert_eq!(capabilities["sessionCapabilities"], json!({ "close": {} }));
    // ACP MCP server admission is served, so the TS `mcpCapabilities`
    // flag (http support) is advertised.
    assert_eq!(capabilities["mcpCapabilities"], json!({ "http": true }));
    let info = &result["agentInfo"];
    assert_eq!(info["name"], "prime-agent");
    assert_eq!(info["title"], "Prime Agent");
    assert_eq!(
        result["_meta"],
        json!({ "ai.primeintellect.prime-agent": {} })
    );
}

#[test]
fn acp_second_initialize_is_served() {
    let script = json!({ "responses": ["unused"] });
    let mut client = AcpChild::spawn(&["--mode", "acp"], &script);
    let first = client.request("initialize", &initialize_params());
    let _ = client.wait_response(first, TIMEOUT);
    let second = client.request("initialize", &initialize_params());
    let (response, _) = client.wait_response(second, TIMEOUT);
    assert_eq!(response["result"]["protocolVersion"], 1);
}

#[test]
fn acp_prompt_stream_completion_envelope_and_stop_reason_match_ts() {
    let script = json!({ "engine": "faux", "responses": ["ACP-OK"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "Reply with exactly: ACP-OK" }] }),
    );
    let (prompt_response, updates) = client.wait_response(prompt, TIMEOUT);

    // Frame shape sequence from ts-happy_path.jsonl: the chunk stream, the
    // response boundary, the completion event, the terminal envelope, and
    // then the response. The faux provider emits its text in one chunk.
    let mut shapes = Vec::new();
    for update in &updates {
        let body = &update["params"]["update"];
        let meta = &body["_meta"]["ai.primeintellect.prime-agent"];
        shapes.push((
            body["sessionUpdate"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            meta["phase"].as_str().unwrap_or_default().to_string(),
            meta["outcome"].as_str().map(str::to_string),
            meta["terminalQuiescenceExpected"].as_bool(),
        ));
    }
    let boundary = (
        "session_info_update".to_string(),
        "responseBoundary".to_string(),
        Some("result".to_string()),
        Some(true),
    );
    let completion = (
        "session_info_update".to_string(),
        "event".to_string(),
        None,
        None,
    );
    let terminal = (
        "session_info_update".to_string(),
        "terminalQuiescence".to_string(),
        Some("result".to_string()),
        None,
    );
    assert_eq!(
        shapes.first().map(|(tag, _, _, _)| tag.clone()),
        Some("agent_message_chunk".to_string())
    );
    assert!(shapes.contains(&boundary), "shapes: {shapes:?}");
    assert!(shapes.contains(&completion), "shapes: {shapes:?}");
    assert!(shapes.contains(&terminal), "shapes: {shapes:?}");
    assert_eq!(shapes.last(), Some(&terminal));

    assert_eq!(
        prompt_response["result"],
        json!({ "stopReason": "end_turn" })
    );

    // Sequences are strictly increasing across the whole turn.
    let mut sequences: Vec<u64> = Vec::new();
    for update in &updates {
        sequences.push(
            update["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"]["eventSequence"]
                .as_u64()
                .unwrap(),
        );
    }
    let mut sorted = sequences.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sequences, sorted, "eventSequence strictly increases");

    let close = client.request("session/close", &json!({ "sessionId": session_id }));
    let (close_response, _) = client.wait_response(close, TIMEOUT);
    assert_eq!(close_response["result"], json!({}));
}

#[test]
fn acp_prompt_chunk_carries_the_assistant_message_id() {
    let script = json!({ "engine": "faux", "responses": ["ACP-OK"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "hello" }] }),
    );
    let (_, updates) = client.wait_response(prompt, TIMEOUT);
    let chunk = updates
        .iter()
        .find(|update| update["params"]["update"]["sessionUpdate"] == "agent_message_chunk")
        .expect("a message chunk");
    assert_eq!(
        chunk["params"]["update"]["messageId"],
        "prime-agent-assistant-1"
    );
    assert_eq!(
        chunk["params"]["update"]["content"],
        json!({ "type": "text", "text": "ACP-OK" })
    );
    assert_eq!(
        chunk["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"],
        json!({ "promptTurnId": 1, "eventSequence": 1, "phase": "event" })
    );
}

#[test]
fn acp_cwd_mismatch_is_reported_not_adopted() {
    let script = json!({ "responses": ["unused"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "cwd": "/tmp", "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let meta = &new_response["result"]["_meta"]["ai.primeintellect.prime-agent"]["cwd"];
    assert_eq!(meta["requested"], "/tmp");
    // The actual cwd is the temp dir the client runs in; only the mismatch
    // shape is asserted here (the value is tempdir-random).
    assert!(meta["actual"]
        .as_str()
        .is_some_and(|actual| actual.starts_with(std::path::MAIN_SEPARATOR)));
}

#[test]
fn acp_error_shapes_match_the_ts_goldens() {
    let script = json!({ "responses": ["unused"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);

    // Unknown session (ts-errors.jsonl): -32603 with the details string.
    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": "bogus-session", "prompt": [{ "type": "text", "text": "hi" }] }),
    );
    let (response, _) = client.wait_response(prompt, TIMEOUT);
    assert_eq!(response["error"]["code"], -32603);
    assert_eq!(response["error"]["message"], "Internal error");
    assert_eq!(
        response["error"]["data"]["details"],
        "Unknown ACP session: bogus-session"
    );

    let close = client.request("session/close", &json!({ "sessionId": "bogus-session" }));
    let (response, _) = client.wait_response(close, TIMEOUT);
    assert_eq!(
        response["error"]["data"]["details"],
        "Unknown ACP session: bogus-session"
    );

    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    // Second session/new on a live connection (ts-errors.jsonl).
    let again = client.request("session/new", &json!({ "mcpServers": [] }));
    let (response, _) = client.wait_response(again, TIMEOUT);
    assert_eq!(response["error"]["code"], -32603);
    assert_eq!(
        response["error"]["data"]["details"],
        "prime-agent ACP mode hosts one session per connection; start another prime-agent process for a second session"
    );

    // Unknown method (ts-errors.jsonl): -32601 with the observed message.
    let unknown = client.request("unknown/method", &json!({}));
    let (response, _) = client.wait_response(unknown, TIMEOUT);
    assert_eq!(response["error"]["code"], -32601);
    assert_eq!(
        response["error"]["message"],
        "\"Method not found\": unknown/method"
    );
    assert_eq!(response["error"]["data"]["method"], "unknown/method");

    let close = client.request("session/close", &json!({ "sessionId": session_id }));
    let (response, _) = client.wait_response(close, TIMEOUT);
    assert_eq!(response["result"], json!({}));
}

#[test]
fn acp_initialize_with_string_protocol_version_is_invalid_params() {
    let script = json!({ "responses": ["unused"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let id = client.request(
        "initialize",
        &json!({ "protocolVersion": "1", "clientCapabilities": {} }),
    );
    let (response, _) = client.wait_response(id, TIMEOUT);
    assert_eq!(response["error"]["code"], -32602);
    assert_eq!(response["error"]["message"], "Invalid params");
    assert_eq!(
        response["error"]["data"]["protocolVersion"]["_errors"][0],
        "Invalid input: expected number, received string"
    );
}

#[test]
fn acp_image_block_without_mime_type_is_invalid_params() {
    let script = json!({ "responses": ["unused"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "image", "data": "AAAA" }] }),
    );
    let (response, _) = client.wait_response(prompt, TIMEOUT);
    assert_eq!(response["error"]["code"], -32602);
    assert_eq!(response["error"]["message"], "Invalid params");
    assert_eq!(
        response["error"]["data"]["reason"],
        "image block requires base64 `data` and `mimeType` strings"
    );
}

#[test]
fn acp_cancel_without_an_active_turn_is_a_noop() {
    let script = json!({ "responses": ["unused"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    client.notify("session/cancel", &json!({ "sessionId": session_id }));
    // The no-op cancel answers nothing; the session still closes cleanly.
    let close = client.request("session/close", &json!({ "sessionId": session_id }));
    let (close_response, notifications) = client.wait_response(close, TIMEOUT);
    assert!(notifications.is_empty(), "a no-op cancel publishes nothing");
    assert_eq!(close_response["result"], json!({}));
}

#[test]
fn acp_mcp_admission_accepts_valid_servers_and_close_releases() {
    let script = json!({ "responses": ["unused"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request(
        "session/new",
        &json!({ "mcpServers": [
            { "name": "capture-stdio", "type": "stdio", "command": "cat", "args": [], "env": [{"name": "A", "value": "1"}] },
            { "name": "capture-http", "type": "http", "url": "https://mcp.invalid/capture", "headers": [{"name": "X-A", "value": "yes"}] },
        ]}),
    );
    let (response, _) = client.wait_response(new, TIMEOUT);
    let session_id = response["result"]["sessionId"]
        .as_str()
        .expect("admission succeeds")
        .to_string();
    let close = client.request("session/close", &json!({ "sessionId": session_id }));
    let (close_response, _) = client.wait_response(close, TIMEOUT);
    assert_eq!(close_response["result"], json!({}));
}

#[test]
fn acp_mcp_admission_rejects_a_second_session_only_when_open() {
    let script = json!({ "responses": ["unused"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request(
        "session/new",
        &json!({ "mcpServers": [
            { "name": "first", "type": "stdio", "command": "cat", "args": [], "env": [] },
        ]}),
    );
    let (response, _) = client.wait_response(new, TIMEOUT);
    let session_id = response["result"]["sessionId"]
        .as_str()
        .expect("admission succeeds")
        .to_string();
    // Rejected admission keeps serving: the single-session error is
    // internal with the raw details, exactly like the TS host.
    let second = client.request(
        "session/new",
        &json!({ "mcpServers": [
            { "name": "second", "type": "stdio", "command": "cat", "args": [], "env": [] },
        ]}),
    );
    let (second_response, _) = client.wait_response(second, TIMEOUT);
    assert_eq!(second_response["error"]["code"], -32603);
    assert_eq!(second_response["error"]["message"], "Internal error");
    assert_eq!(
        second_response["error"]["data"]["details"],
        "prime-agent ACP mode hosts one session per connection; start another prime-agent process for a second session"
    );
    // Close, then a replacement admission with a different server list.
    let close = client.request("session/close", &json!({ "sessionId": session_id }));
    let (close_response, _) = client.wait_response(close, TIMEOUT);
    assert_eq!(close_response["result"], json!({}));
    let replacement = client.request(
        "session/new",
        &json!({ "mcpServers": [
            { "name": "replacement", "type": "stdio", "command": "cat", "args": [], "env": [] },
        ]}),
    );
    let (replacement_response, _) = client.wait_response(replacement, TIMEOUT);
    assert!(
        replacement_response["result"]["sessionId"].is_string(),
        "replacement admission succeeds"
    );
}

#[test]
fn acp_mcp_admission_rejects_invalid_params_with_the_ts_reasons() {
    let script = json!({ "responses": ["unused"] });
    let cases: &[(Value, &str)] = &[
        (
            json!([{ "name": "-bad", "type": "stdio", "command": "cat", "args": [], "env": [] }]),
            "MCP server names must start with an alphanumeric character and contain at most 64 alphanumeric, underscore, or hyphen characters",
        ),
        (
            json!([
                { "name": "dup", "type": "stdio", "command": "cat", "args": [], "env": [] },
                { "name": "dup", "type": "stdio", "command": "cat", "args": [], "env": [] },
            ]),
            "duplicate MCP server name: dup",
        ),
        (
            json!([{ "name": "n", "type": "stdio", "command": "cat\u{0}", "args": [], "env": [] }]),
            "MCP server n has an invalid stdio command",
        ),
        (
            json!([{ "name": "e", "type": "stdio", "command": "cat", "args": [], "env": [
                { "name": "A", "value": "1" }, { "name": "A", "value": "2" },
            ]}]),
            "MCP server e has duplicate environment A",
        ),
        (
            json!([{ "name": "h", "type": "http", "url": "https://mcp.invalid/x", "headers": [
                { "name": "X-A", "value": "1" }, { "name": "x-a", "value": "2" },
            ]}]),
            "MCP server h has duplicate header x-a",
        ),
        (
            json!([{ "name": "s", "type": "sse", "url": "https://mcp.invalid/x", "headers": [] }]),
            "MCP server s uses unsupported sse transport",
        ),
        (
            json!([{ "name": "c", "type": "http", "url": "https://user:pw@mcp.invalid/x", "headers": [] }]),
            "MCP server c must use an HTTP(S) URL without embedded credentials",
        ),
    ];
    for (servers, reason) in cases {
        let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
        let init = client.request("initialize", &initialize_params());
        let _ = client.wait_response(init, TIMEOUT);
        let new = client.request("session/new", &json!({ "mcpServers": servers }));
        let (response, _) = client.wait_response(new, TIMEOUT);
        assert_eq!(response["error"]["code"], -32602, "case {reason}");
        assert_eq!(response["error"]["message"], "Invalid params");
        assert_eq!(response["error"]["data"]["reason"], *reason);
    }
}

#[test]
fn acp_mcp_schema_invalid_entries_are_dropped_like_the_sdk() {
    // The SDK zod filter (`vecSkipError(zMcpServer)`) silently drops
    // entries that miss required fields; admission succeeds with the
    // surviving list — the live TS behavior.
    let script = json!({ "responses": ["unused"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request(
        "session/new",
        // No `env` (required), invalid env item, http without headers.
        &json!({ "mcpServers": [
            { "name": "no-env", "type": "stdio", "command": "cat", "args": [] },
            { "name": "bad-item", "type": "stdio", "command": "cat", "args": [], "env": [{"name": 1, "value": "x"}] },
            { "name": "no-headers", "type": "http", "url": "https://mcp.invalid/x" },
        ]}),
    );
    let (response, _) = client.wait_response(new, TIMEOUT);
    assert!(
        response["result"]["sessionId"].is_string(),
        "schema-invalid entries are dropped, not rejected"
    );
}

#[test]
fn acp_mcp_long_names_fail_at_tool_derivation_with_internal_error() {
    let script = json!({ "responses": ["unused"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let long = format!("a{}", "b".repeat(50));
    let new = client.request(
        "session/new",
        &json!({ "mcpServers": [
            { "name": long, "type": "stdio", "command": "cat", "args": [], "env": [] },
        ]}),
    );
    let (response, _) = client.wait_response(new, TIMEOUT);
    assert_eq!(response["error"]["code"], -32603);
    assert_eq!(
        response["error"]["data"]["details"],
        format!("Invalid ACP MCP server name: {long}")
    );
}

#[test]
fn acp_daemon_attached_cancels_mid_turn() {
    // A scripted worker with a slow turn: the cancel lands while the
    // turn runs, and the prompt resolves `{stopReason: "cancelled"}`
    // with no boundary frames — the TS daemon-attached cancel shape.
    let mut client = AcpChild::spawn(
        &["--mode", "acp", "--no-session"],
        &json!({ "responses": [{ "text": "a slow answer", "delayMs": 8000 }] }),
    );
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, Duration::from_mins(1));
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let prompt = client.request(
            "session/prompt",
            &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "a slow question" }] }),
        );
    // The turn is mid-delay: cancel, then wait for the prompt response.
    client.notify("session/cancel", &json!({ "sessionId": session_id }));
    let (prompt_response, updates) = client.wait_response(prompt, Duration::from_mins(1));
    assert_eq!(prompt_response["result"]["stopReason"], "cancelled");
    assert!(
        updates.is_empty(),
        "a cancelled turn publishes no boundary frames after the cancel"
    );
    let close = client.request("session/close", &json!({ "sessionId": session_id }));
    let (close_response, _) = client.wait_response(close, Duration::from_mins(1));
    assert_eq!(close_response["result"], json!({}));
    drop(client);
}

#[test]
fn acp_daemon_attached_overlapping_prompt_is_refused() {
    // A second prompt while the first runs is refused; the running turn
    // is untouched and the next prompt after its settle runs.
    let mut client = AcpChild::spawn(
        &["--mode", "acp", "--no-session"],
        &json!({ "engine": "faux", "tokensPerSecond": 2, "responses": [
            { "text": "a paced answer that streams slowly enough to overlap a prompt" },
            "SECOND-OK",
        ] }),
    );
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let first = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "a slow question" }] }),
    );
    // Readiness is the turn's own first streamed chunk, not a timer.
    client.wait_update("agent_message_chunk", TIMEOUT);
    let second = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "the overlap" }] }),
    );
    let (second_response, _) = client.wait_response(second, TIMEOUT);
    assert_eq!(
        second_response["error"]["code"], -32603,
        "the overlapping prompt is refused: {second_response}"
    );
    assert!(
        second_response["error"]["data"]["details"]
            .as_str()
            .unwrap_or_default()
            .contains("A prompt turn is already running for this ACP session"),
        "the refusal names the running-turn rule: {second_response}"
    );
    let (first_response, _) = client.wait_response(first, TIMEOUT);
    assert_eq!(
        first_response["result"]["stopReason"], "end_turn",
        "the refused overlap never touched the running turn: {first_response}"
    );
    let third = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "after the settle" }] }),
    );
    let (third_response, updates) = client.wait_response(third, TIMEOUT);
    assert_eq!(
        third_response["result"]["stopReason"], "end_turn",
        "the turn slot frees at the settle: {third_response}"
    );
    let chunk = updates
        .iter()
        .find(|update| update["params"]["update"]["sessionUpdate"] == "agent_message_chunk")
        .expect("the next turn streams its scripted answer");
    assert_eq!(
        chunk["params"]["update"]["content"],
        json!({ "type": "text", "text": "SECOND-OK" })
    );
}

#[test]
fn acp_daemon_attached_close_mid_turn_answers_cancelled() {
    let mut client = AcpChild::spawn(
        &["--mode", "acp", "--no-session"],
        &json!({ "engine": "faux", "tokensPerSecond": 2, "responses": [
            { "text": "a paced answer that streams slowly enough to close mid-turn" },
        ] }),
    );
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "a slow question" }] }),
    );
    client.wait_update("agent_message_chunk", TIMEOUT);
    let close = client.request("session/close", &json!({ "sessionId": session_id }));
    let (prompt_response, frames) = client.wait_response(prompt, TIMEOUT);
    assert_eq!(
        prompt_response["result"]["stopReason"], "cancelled",
        "a prompt closed mid-turn answers cancelled: {prompt_response}"
    );
    let close_response = frames
        .into_iter()
        .find(|frame| frame["id"] == close)
        .unwrap_or_else(|| client.wait_response(close, TIMEOUT).0);
    assert_eq!(close_response["result"], json!({}));
}

/// `initialize` + `session/new` on a daemon-attached child; the ACP session id.
fn initialize_and_new_session(client: &mut AcpChild) -> String {
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    new_session(client)
}

fn new_session(client: &mut AcpChild) -> String {
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    new_response["result"]["sessionId"]
        .as_str()
        .unwrap_or_else(|| panic!("session/new succeeds: {new_response}"))
        .to_string()
}

fn assert_prompt_ends_turn(client: &mut AcpChild, session_id: &str, text: &str) -> Vec<Value> {
    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] }),
    );
    let (prompt_response, updates) = client.wait_response(prompt, Duration::from_mins(2));
    assert_eq!(
        prompt_response["result"]["stopReason"], "end_turn",
        "{prompt_response}"
    );
    updates
}

/// The supervisor's live sessions (`list`).
fn live_sessions(socket: &std::path::Path) -> Vec<Value> {
    let list = daemon_request(
        socket,
        "live-sessions",
        &json!({ "type": "list", "includeClientOwned": true }),
    );
    list["data"]["sessions"]
        .as_array()
        .unwrap_or_else(|| panic!("a session list: {list}"))
        .clone()
}

#[test]
fn acp_daemon_attached_default_session_persists_and_resumes() {
    // Without --no-session the daemon session is saved and resident: it
    // survives the client's EOF, and --resume binds the same live worker.
    let home = tempfile::TempDir::new().unwrap();
    let home_path = home.path().to_path_buf();
    let socket = home_path.join("daemon.sock");
    std::fs::write(
        home_path.join("worker-script.json"),
        json!({ "engine": "faux", "responses": ["The Nile.", "Everest."] }).to_string(),
    )
    .unwrap();
    let child = daemon_attached_command(&home_path, &socket, &["--mode", "acp"])
        .env("DO_NOT_TRACK", "1")
        .spawn()
        .expect("binary present");
    let mut first = AcpChild::wrap(child, Some(home), socket.clone());
    let session_id = initialize_and_new_session(&mut first);
    assert_prompt_ends_turn(&mut first, &session_id, "Name a river.");

    let sessions = live_sessions(&socket);
    assert_eq!(sessions.len(), 1, "{sessions:?}");
    let active_session_id = sessions[0]["activeSessionId"].clone();
    let session_file = sessions[0]["sessionFile"]
        .as_str()
        .unwrap_or_else(|| panic!("a saved session: {sessions:?}"))
        .to_string();
    assert!(
        std::path::Path::new(&session_file)
            .parent()
            .is_some_and(|dir| dir.ends_with("agent/sessions")),
        "the session is saved in the session dir: {session_file}"
    );
    assert!(std::fs::read_to_string(&session_file)
        .unwrap()
        .contains("Name a river."));
    let descriptor = worker_descriptor(&home_path);
    assert_eq!(descriptor["telemetryDisabled"], json!(true), "{descriptor}");
    assert!(
        descriptor.get("ownerClientId").is_none(),
        "a resident session has no owner: {descriptor}"
    );

    first.close_stdin();
    assert!(first.child.wait().expect("the ACP child exits").success());
    let sessions = live_sessions(&socket);
    assert_eq!(
        sessions.len(),
        1,
        "a resident session survives EOF: {sessions:?}"
    );
    assert_eq!(sessions[0]["activeSessionId"], active_session_id);

    // A relative `--resume` selector resolves against the CLI's working
    // directory: the agent dir here, not the stored session cwd.
    let file_name = std::path::Path::new(&session_file)
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .expect("a session file name");
    let agent_dir = std::path::Path::new(&session_file)
        .parent()
        .and_then(std::path::Path::parent)
        .expect("the agent dir holding the session dir");
    let child = daemon_attached_command(
        &home_path,
        &socket,
        &[
            "--mode",
            "acp",
            "--resume",
            &format!("sessions/{file_name}"),
        ],
    )
    .current_dir(agent_dir)
    .spawn()
    .expect("binary present");
    let mut second = AcpChild::wrap(child, None, socket.clone());
    let session_id = initialize_and_new_session(&mut second);
    assert_prompt_ends_turn(&mut second, &session_id, "Name a mountain.");
    let sessions = live_sessions(&socket);
    assert_eq!(sessions.len(), 1, "{sessions:?}");
    assert_eq!(
        sessions[0]["activeSessionId"], active_session_id,
        "--resume binds the live worker"
    );
    let saved = std::fs::read_to_string(&session_file).unwrap();
    assert!(saved.contains("Name a river.") && saved.contains("Name a mountain."));
}

#[test]
fn acp_daemon_attached_resident_eof_mid_turn_cancels_the_prompt() {
    let answer = "a paced answer that streams slowly enough to close mid-turn";
    let mut client = AcpChild::spawn(
        &["--mode", "acp"],
        &json!({ "engine": "faux", "tokensPerSecond": 2, "responses": [{ "text": answer }] }),
    );
    let socket = client.socket.clone();
    let session_id = initialize_and_new_session(&mut client);
    let _ = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "a slow question" }] }),
    );
    client.wait_update("agent_message_chunk", TIMEOUT);
    let session = live_sessions(&socket).remove(0);
    let active_session_id = session["activeSessionId"].clone();
    let session_file = session["sessionFile"]
        .as_str()
        .unwrap_or_else(|| panic!("a saved session: {session}"))
        .to_string();

    client.close_stdin();
    assert!(client.child.wait().expect("the ACP child exits").success());
    let idle = daemon_request(
        &socket,
        "idle",
        &json!({ "type": "wait_for_idle", "activeSessionId": active_session_id }),
    );
    assert_eq!(idle["success"], true, "{idle}");
    let sessions = live_sessions(&socket);
    assert_eq!(
        sessions.len(),
        1,
        "a resident session survives EOF: {sessions:?}"
    );
    assert_eq!(sessions[0]["activeSessionId"], active_session_id);
    let saved = std::fs::read_to_string(&session_file).unwrap();
    assert!(saved.contains("a slow question"), "{saved}");
    assert!(
        !saved.contains(answer),
        "the EOF cancelled the running prompt: {saved}"
    );
}

/// EOF while `session/new` is still running: the reader awaits the
/// handler before it reads further, so the teardown at EOF releases the
/// session it installs and the process exits.
#[test]
fn acp_daemon_attached_eof_during_session_new_exits() {
    let mut client = AcpChild::spawn(
        &["--mode", "acp"],
        &json!({ "engine": "faux", "responses": ["The Nile."] }),
    );
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    client.close_stdin();
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    assert!(
        new_response["result"]["sessionId"].is_string(),
        "session/new answers: {new_response}"
    );
    assert!(client.child.wait().expect("the ACP child exits").success());
}

#[test]
fn acp_daemon_attached_close_keeps_the_worker_and_new_rebinds_it() {
    let mut client = AcpChild::spawn(
        &["--mode", "acp", "--no-session"],
        &json!({ "engine": "faux", "responses": ["The Nile.", "Everest."] }),
    );
    let socket = client.socket.clone();
    let first = initialize_and_new_session(&mut client);
    let wrong = client.request("session/close", &json!({ "sessionId": "not-the-session" }));
    let (wrong_response, _) = client.wait_response(wrong, TIMEOUT);
    assert_eq!(
        wrong_response["error"]["data"]["details"], "Unknown ACP session: not-the-session",
        "{wrong_response}"
    );
    assert_prompt_ends_turn(&mut client, &first, "Name a river.");
    let active_session_id = live_sessions(&socket)[0]["activeSessionId"].clone();
    let descriptor = worker_descriptor(socket.parent().unwrap());
    let owner = json!(format!("acp:{}", client.child.id()));
    assert_eq!(descriptor["ownerClientId"], owner, "{descriptor}");

    let close = client.request("session/close", &json!({ "sessionId": first }));
    let (close_response, _) = client.wait_response(close, TIMEOUT);
    assert_eq!(close_response["result"], json!({}));
    let sessions = live_sessions(&socket);
    assert_eq!(sessions.len(), 1, "close keeps the worker: {sessions:?}");
    assert_eq!(sessions[0]["activeSessionId"], active_session_id);

    let second = new_session(&mut client);
    assert_ne!(second, first);
    let updates = assert_prompt_ends_turn(&mut client, &second, "Name a mountain.");
    let chunk = updates
        .iter()
        .find(|update| update["params"]["update"]["sessionUpdate"] == "agent_message_chunk")
        .expect("a message chunk");
    // The event mapping restarts with the session, like TS.
    assert_eq!(
        chunk["params"]["update"]["messageId"],
        "prime-agent-assistant-1"
    );
    let sessions = live_sessions(&socket);
    assert_eq!(sessions.len(), 1, "{sessions:?}");
    assert_eq!(
        sessions[0]["activeSessionId"], active_session_id,
        "session/new binds the same daemon session"
    );
}

#[test]
fn acp_daemon_attached_prompt_during_cancel_is_refused() {
    // A prompt behind a cancel is refused while the stop runs, and the
    // cancelled response comes after the stop, so a resend right after it
    // runs.
    let mut client = AcpChild::spawn(
        &["--mode", "acp", "--no-session"],
        &json!({ "engine": "faux", "tokensPerSecond": 2, "responses": [
            { "text": "a paced answer that streams slowly enough to cancel mid-turn" },
            "AFTER-STOP",
        ] }),
    );
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let first = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "a slow question" }] }),
    );
    client.wait_update("agent_message_chunk", TIMEOUT);
    client.notify("session/cancel", &json!({ "sessionId": session_id }));
    let second = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "behind the stop" }] }),
    );
    let (second_response, _) = client.wait_response(second, TIMEOUT);
    assert_eq!(
        second_response["error"]["code"], -32603,
        "the prompt behind the cancel is refused: {second_response}"
    );
    assert_eq!(
        second_response["error"]["data"]["details"],
        format!("ACP session is cancelling: {session_id}"),
        "the refusal names the cancelling window: {second_response}"
    );
    let (first_response, _) = client.wait_response(first, TIMEOUT);
    assert_eq!(
        first_response["result"]["stopReason"], "cancelled",
        "the cancel settles the running turn: {first_response}"
    );
    // The resend also resumes the queued-input admission the cancel
    // suspended (TS sends `followUp` + `queueIfBusy: true`).
    let third = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "the resend" }] }),
    );
    let (third_response, updates) = client.wait_response(third, TIMEOUT);
    assert_eq!(
        third_response["result"]["stopReason"], "end_turn",
        "the stop cleared before the cancelled response: {third_response}"
    );
    let chunk = updates
        .iter()
        .find(|update| update["params"]["update"]["sessionUpdate"] == "agent_message_chunk")
        .expect("the resent turn streams its scripted answer");
    assert_eq!(
        chunk["params"]["update"]["content"],
        json!({ "type": "text", "text": "AFTER-STOP" })
    );
}

#[test]
fn acp_daemon_attached_failed_turn_publishes_only_the_error_boundary() {
    // A failed turn (here: the empty-prompt rejection) publishes one
    // error boundary and no terminal-quiescence update (TS settle catch).
    let mut client = AcpChild::spawn(
        &["--mode", "acp", "--no-session"],
        &json!({ "engine": "faux", "responses": [] }),
    );
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [] }),
    );
    let (prompt_response, updates) = client.wait_response(prompt, TIMEOUT);
    assert_eq!(
        prompt_response["error"]["code"], -32603,
        "the failed turn errors the request: {prompt_response}"
    );
    assert!(
        prompt_response["error"]["data"]["details"]
            .as_str()
            .unwrap_or_default()
            .contains("Prompt cannot be empty"),
        "the worker's failure is the error: {prompt_response}"
    );
    let mut boundaries = 0;
    for update in &updates {
        let body = &update["params"]["update"];
        let meta = &body["_meta"]["ai.primeintellect.prime-agent"];
        assert_ne!(
            meta["phase"], "terminalQuiescence",
            "a failed turn never publishes a terminal frame: {updates:?}"
        );
        if meta["phase"] == "responseBoundary" {
            boundaries += 1;
            assert_eq!(
                meta["terminalQuiescenceExpected"], false,
                "the one boundary declares no terminal expectation: {updates:?}"
            );
            assert_eq!(meta["outcome"], "error");
        }
    }
    assert_eq!(
        boundaries, 1,
        "the failed turn published exactly one correlated error boundary: {updates:?}"
    );
}

#[cfg(unix)]
#[test]
fn acp_daemon_attached_supervisor_loss_fails_the_prompt() {
    // The supervisor dies while a prompt is in flight: the pending
    // request must fail fast with an error response, never hang, because
    // the link close is the turn's liveness bound (turn-long requests
    // carry no timer).
    let mut client = AcpChild::spawn(
        &["--mode", "acp", "--no-session"],
        &json!({ "engine": "faux", "tokensPerSecond": 2, "responses": [
            { "text": "a paced answer that streams slowly enough to outlive the supervisor" },
        ] }),
    );
    let socket = client.socket.clone();
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "a slow question" }] }),
    );
    // Readiness is the turn's own first streamed chunk: the prompt is
    // provably in flight before the supervisor goes away.
    client.wait_update("agent_message_chunk", TIMEOUT);
    // Crash the supervisor (no graceful drain, so the in-flight response
    // can never arrive). Its pid comes from the hello frame every new
    // connection receives.
    let probe = pa_types::platform::transport::connect_blocking(&socket).expect("daemon socket");
    let reader = probe.try_clone_box().expect("daemon socket clone");
    let _ = reader.set_read_timeout(Duration::from_mins(2));
    let hello = BufReader::new(reader)
        .lines()
        .map(|line| {
            serde_json::from_str::<Value>(&line.expect("daemon line")).expect("daemon JSON")
        })
        .find(|frame| frame["type"] == json!("daemon_hello"))
        .expect("the daemon closed without a hello");
    let pid = hello["supervisorPid"].as_u64().expect("supervisor pid");
    drop(probe);
    let killed = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .expect("kill the supervisor");
    assert!(killed.success(), "the supervisor crash did not run");
    let (prompt_response, _) = client.wait_response(prompt, TIMEOUT);
    assert_eq!(
        prompt_response["error"],
        json!({
            "code": -32603,
            "message": "Internal error",
            "data": { "details": "the daemon connection closed mid-request" }
        }),
        "the in-flight prompt fails fast on supervisor loss: {prompt_response}"
    );
}

#[test]
fn acp_daemon_attached_image_only_prompt_reaches_the_session() {
    let mut client = AcpChild::spawn(
        &["--mode", "acp", "--no-session"],
        &json!({ "engine": "faux", "responses": ["SAW-IMAGE"] }),
    );
    let socket = client.socket.clone();
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    // 1x1 PNG
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let prompt = client.request(
        "session/prompt",
        &json!({
            "sessionId": session_id,
            "prompt": [
                { "type": "image", "data": png, "mimeType": "image/png" },
            ],
        }),
    );
    let (prompt_response, _) = client.wait_response(prompt, TIMEOUT);
    assert_eq!(
        prompt_response["result"]["stopReason"], "end_turn",
        "an image-only prompt runs a turn: {prompt_response}"
    );
    // The stored user row carries the image: an empty text block first,
    // then the images (TS `_buildPromptContent`).
    let list = daemon_request(&socket, "img-list", &json!({ "type": "list" }));
    let active_session_id = &list["data"]["sessions"][0]["activeSessionId"];
    let messages = daemon_request(
        &socket,
        "img-msgs",
        &json!({ "type": "get_messages", "activeSessionId": active_session_id }),
    );
    let user = messages["data"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "user")
        .unwrap();
    assert_eq!(
        user["content"],
        json!([
            { "type": "text", "text": "" },
            { "type": "image", "data": png, "mimeType": "image/png" },
        ])
    );
}

/// Stop the sandboxed supervisor a test spawned (the shared-daemon
/// product behavior leaves it running; a test owns its sandbox).
fn shutdown_sandboxed_daemon(socket: &std::path::Path) {
    use std::io::Write as _;
    let Ok(mut stream) = pa_types::platform::transport::connect_blocking(socket) else {
        return;
    };
    let frame = format!(
            "{{\"type\":\"command\",\"id\":\"shutdown-test\",\"protocol\":{{\"name\":\"prime-agent.daemon\",\"version\":{}}},\"command\":{{\"type\":\"shutdown\"}}}}\n",
            pa_types::daemon::DAEMON_PROTOCOL_VERSION
        );
    let _ = stream.write_all(frame.as_bytes());
    let _ = stream.flush();
    // The supervisor exits after the shutdown response.
    std::thread::sleep(Duration::from_millis(300));
}

#[test]
fn acp_compact_command_publishes_the_compaction_meta_and_end_turn() {
    // The faux session is short, so `/compact` skips (TS
    // `CompactionSkippedError`): the observable parity is the
    // `compaction: {}` namespaced update and the normal end_turn response.
    let script = json!({ "engine": "faux", "responses": ["one answer"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "/compact" }] }),
    );
    let (prompt_response, updates) = client.wait_response(prompt, TIMEOUT);

    let compaction = updates
        .iter()
        .find(|update| {
            let meta = &update["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"];
            meta.get("compaction").is_some_and(|value| !value.is_null())
        })
        .expect("a compaction meta frame");
    let meta = &compaction["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"];
    assert_eq!(
        meta["compaction"],
        json!({}),
        "a skipped compaction publishes the empty payload"
    );
    assert_eq!(meta["phase"], "event");

    // The turn settles normally: boundary, completion, terminal, end_turn.
    let boundary = updates.iter().any(|update| {
        let meta = &update["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"];
        meta["phase"] == "responseBoundary" && meta["terminalQuiescenceExpected"] == true
    });
    assert!(boundary, "updates: {updates:?}");
    assert_eq!(
        prompt_response["result"],
        json!({ "stopReason": "end_turn" })
    );
}

#[test]
fn acp_goal_command_publishes_goal_meta_and_runs_the_continuation() {
    // `/goal` start schedules its continuation as the turn's model segment:
    // the goal meta frame precedes the streamed answer, and the usage
    // accounting publishes a second goal frame after the message settles.
    // The tiny budget bounds the goal loop the worker turn loop
    // hosts (TS parity: the continuation loop runs inside the same
    // session/prompt request): the crossing turn's budget-limit steer is
    // the second model segment, and the budget_limited goal settles the
    // prompt with end_turn instead of looping forever.
    let script = json!({ "engine": "faux", "responses": ["GOAL-PROGRESS", "WRAP-UP"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "/goal --budget 5 reply with exactly: GOAL-PROGRESS" }] }),
    );
    let (prompt_response, updates) = client.wait_response(prompt, TIMEOUT);

    let goal_frames: Vec<&Value> = updates
        .iter()
        .filter(|update| {
            let meta = &update["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"];
            meta.get("goal").is_some_and(|value| !value.is_null())
        })
        .collect();
    assert!(!goal_frames.is_empty(), "updates: {updates:?}");
    let first =
        &goal_frames[0]["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"]["goal"];
    assert_eq!(first["status"], "active");
    assert_eq!(first["objective"], "reply with exactly: GOAL-PROGRESS");
    assert_eq!(first["tokenBudget"], 5);
    assert_eq!(first["tokensUsed"], 0);
    // A usage update follows the settled message: the tiny budget
    // crosses at the first turn, so the goal is budget_limited before
    // the wrap-up steer segment runs.
    assert!(goal_frames.len() >= 2, "goal frames: {goal_frames:?}");
    let second =
        &goal_frames[1]["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"]["goal"];
    assert_eq!(second["status"], "budget_limited");
    assert!(second["tokensUsed"].as_u64().unwrap_or(0) > 0);
    // The budget-limit wrap-up steer ran as the prompt's second model
    // segment (its streamed answer is the second scripted response; the
    // faux pacing may split one answer into chunks, so the joined text
    // carries the observable contract).
    let streamed: String = updates
        .iter()
        .filter_map(|update| update["params"]["update"]["content"]["text"].as_str())
        .collect();
    assert!(streamed.contains("GOAL-PROGRESS"), "updates: {updates:?}");
    assert!(streamed.contains("WRAP-UP"), "updates: {updates:?}");
    assert_eq!(
        prompt_response["result"],
        json!({ "stopReason": "end_turn" })
    );
}

#[test]
fn acp_autonomous_token_limit_maps_to_max_tokens_stop_reason() {
    // A one-token budget is exhausted by the first turn: the driver stops
    // with the token limit, the completion envelope carries the autonomous
    // accounting, and the stop reason is `max_tokens`.
    let script = json!({ "engine": "faux", "responses": ["an answer"] });
    let mut client = AcpChild::spawn(
        &[
            "--mode",
            "acp",
            "--no-session",
            "--autonomous",
            "--autonomous-max-tokens",
            "1",
        ],
        &script,
    );
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "do the thing" }] }),
    );
    let (prompt_response, updates) = client.wait_response(prompt, TIMEOUT);

    let completion = updates
        .iter()
        .find(|update| {
            let meta = &update["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"];
            meta["phase"] == "event" && meta.get("autonomous").is_some_and(|v| !v.is_null())
        })
        .expect("an autonomous completion meta");
    let autonomous =
        &completion["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"]["autonomous"];
    assert_eq!(autonomous["enabled"], true);
    assert_eq!(autonomous["turnsUsed"], 1);
    let quiescence =
        &completion["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"]["quiescence"];
    assert_eq!(quiescence["outstandingSubagents"], 0);

    assert_eq!(
        prompt_response["result"],
        json!({ "stopReason": "max_tokens" })
    );
}

#[test]
fn acp_autonomous_disabled_reports_end_turn_without_accounting() {
    // Without autonomous flags the completion envelope carries no autonomous
    // meta and the stop reason is end_turn.
    let script = json!({ "engine": "faux", "responses": ["an answer"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "hi" }] }),
    );
    let (prompt_response, updates) = client.wait_response(prompt, TIMEOUT);
    for update in &updates {
        let meta = &update["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"];
        assert!(
            meta.get("autonomous")
                .is_none_or(serde_json::Value::is_null),
            "no autonomous meta"
        );
    }
    assert_eq!(
        prompt_response["result"],
        json!({ "stopReason": "end_turn" })
    );
}

#[test]
fn acp_daemon_attached_reports_autonomous_accounting_and_limit_stop_reason() {
    // An autonomous run with --max-turns 1: the completion envelope carries
    // the _meta.autonomous accounting (TS waitForHeadlessCompletion), the
    // quiescence observation counts the remaining continuations, and the
    // turn limit surfaces as max_turn_requests (TS acpStopReason).
    let mut client = AcpChild::spawn(
        &["--mode", "acp", "--no-session"],
        &json!({ "engine": "faux", "responses": [
            "enabling the run",
            "one turn runs, then the limit stops the run",
        ] }),
    );
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, Duration::from_mins(1));
    assert!(
        new_response["result"]["sessionId"].is_string(),
        "daemon-attached admission succeeds: {new_response}"
    );
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    // Turn on the run with a one-turn budget.
    let enable = client.request(
        "session/prompt",
        &json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": "/autonomous on --max-turns 1" }],
        }),
    );
    let (enable_response, updates) = client.wait_response(enable, Duration::from_mins(2));
    assert_eq!(enable_response["result"]["stopReason"], "end_turn");
    // The enabled accounting is already visible on the command turn's
    // completion envelope (the headless-completion status of the run).
    let enabled_meta = updates.iter().find_map(|update| {
        let meta =
            &update["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"]["autonomous"];
        (!meta.is_null()).then(|| meta.clone())
    });
    let enabled_meta = enabled_meta.expect("the enabled run's accounting reached the surface");
    assert_eq!(enabled_meta["enabled"], true);
    // The model turn: one turn runs, the max-turns limit stops the run.
    let prompt = client.request(
        "session/prompt",
        &json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": "say something" }],
        }),
    );
    let (prompt_response, updates) = client.wait_response(prompt, Duration::from_mins(2));
    assert_eq!(
        prompt_response["result"],
        json!({ "stopReason": "max_turn_requests" }),
        "the turn limit maps to the TS stop reason: {prompt_response}"
    );
    let accounted = updates.iter().find_map(|update| {
        let meta =
            &update["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"]["autonomous"];
        (meta["enabled"] == json!(true) && meta["turnsUsed"] == json!(1)).then(|| meta.clone())
    });
    let accounted = accounted.expect("the limited turn's accounting reached the surface");
    assert_eq!(accounted["continuationsUsed"], 0);
    // The quiescence observation subtracts the run's own limits (TS
    // quiescenceMeta): the named budget flag `--max-turns 1` makes the
    // unnamed limits the JSON-safe unlimited sentinel (TS
    // parseAutonomousCommand budget fill), so the remaining continuation
    // slots are that sentinel minus the zero the stopped run consumed.
    let remaining = updates.iter().find_map(|update| {
        let quiescence =
            &update["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"]["quiescence"];
        (!quiescence.is_null()).then(|| quiescence["remainingAutonomousContinuations"].clone())
    });
    assert_eq!(
        remaining,
        Some(json!(9_007_199_254_740_991u64)),
        "the run's unlimited continuation budget minus used"
    );
    let close = client.request("session/close", &json!({ "sessionId": session_id }));
    let (close_response, _) = client.wait_response(close, Duration::from_mins(1));
    assert_eq!(close_response["result"], json!({}));
    drop(client);
}

/// One raw daemon command on a fresh connection (the hello frame is skipped by the id match).
fn daemon_request(socket: &std::path::Path, id: &str, command: &Value) -> Value {
    use std::io::{BufRead as _, BufReader, Write as _};
    let mut writer =
        pa_types::platform::transport::connect_blocking(socket).expect("daemon socket");
    let reader = writer.try_clone_box().expect("daemon socket clone");
    let _ = reader.set_read_timeout(Duration::from_mins(2));
    let protocol = json!({ "name": "prime-agent.daemon", "version": pa_types::daemon::DAEMON_PROTOCOL_VERSION });
    let frame = json!({ "type": "command", "id": id, "protocol": protocol, "command": command });
    writeln!(writer, "{frame}").expect("daemon frame");
    writer.flush().expect("daemon flush");
    BufReader::new(reader)
        .lines()
        .map(|line| {
            serde_json::from_str::<Value>(&line.expect("daemon line")).expect("daemon JSON")
        })
        .find(|frame| frame["id"] == json!(id))
        .unwrap_or_else(|| panic!("the daemon closed without answering {id}"))
}

#[test]
fn acp_daemon_attached_forwards_cli_session_options() {
    // --append-system-prompt and --skill land in the daemon worker's system
    // prompt, and --autonomous-max-turns 1 stops the run.
    // Outside the agent dir: only --skill loads it.
    let skill_home = tempfile::TempDir::new().unwrap();
    let skill_dir = skill_home.path().join("argv-skill");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: acp-argv-probe\ndescription: probe\n---",
    )
    .unwrap();
    let skill = skill_dir.to_str().unwrap().to_string();
    let mut client = AcpChild::spawn(
        &[
            "--mode",
            "acp",
            "--no-session",
            "--append-system-prompt",
            "ACP_ARGV_MARKER",
            "--skill",
            &skill,
            "--autonomous",
            "--autonomous-max-turns",
            "1",
        ],
        &json!({ "engine": "faux", "responses": ["one turn, then the limit stops"] }),
    );
    let socket = client.socket.clone();
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let list = daemon_request(&socket, "argv-list", &json!({ "type": "list" }));
    let active_session_id = &list["data"]["sessions"][0]["activeSessionId"];
    let get_prompt = json!({ "type": "get_system_prompt", "activeSessionId": active_session_id });
    let reply = daemon_request(&socket, "argv-prompt", &get_prompt);
    let system_prompt = reply["data"]["systemPrompt"].as_str().unwrap_or_else(|| {
        panic!("the worker's system prompt: {reply} (list: {list}, new: {new_response})")
    });
    assert!(
        system_prompt.contains("ACP_ARGV_MARKER"),
        "--append-system-prompt reaches the worker"
    );
    assert!(
        system_prompt.contains("<name>acp-argv-probe</name>"),
        "--skill reaches the worker"
    );
    let turn = client.request(
        "session/prompt",
        &json!({ "sessionId": new_response["result"]["sessionId"], "prompt": [{ "type": "text", "text": "say something" }] }),
    );
    let (turn_response, _) = client.wait_response(turn, Duration::from_mins(2));
    assert_eq!(
        turn_response["result"],
        json!({ "stopReason": "max_turn_requests" })
    );
    drop(client);
}

/// Spawn with compaction settings written into the worker's agent dir
/// (`<home>/.prime/agent`: the worker inherits the child's HOME).
fn spawn_with_compaction_settings(
    args: &[&str],
    script: &serde_json::Value,
    reserve_tokens: u64,
    keep_recent_tokens: u64,
) -> AcpChild {
    let home = tempfile::TempDir::new().unwrap();
    std::fs::create_dir_all(home.path().join(".prime/agent")).expect("agent dir");
    std::fs::write(
        home.path().join(".prime/agent/settings.json"),
        json!({
            "compaction": {
                "enabled": true,
                "reserveTokens": reserve_tokens,
                "keepRecentTokens": keep_recent_tokens,
            }
        })
        .to_string(),
    )
    .expect("write settings.json");
    let socket = home.path().join("daemon.sock");
    std::fs::write(home.path().join("worker-script.json"), script.to_string()).unwrap();
    let child = daemon_attached_command(home.path(), &socket, args)
        .spawn()
        .expect("binary present");
    AcpChild::wrap(child, Some(home), socket)
}

/// The compaction metas among a turn's updates (the ACP `compaction_end`
/// mapping; a ran compaction carries `tokensBefore`/`summary`, every
/// skipped, failed, or cancelled run the empty payload).
fn compaction_metas(updates: &[Value]) -> Vec<Value> {
    updates
        .iter()
        .filter_map(|update| {
            let meta = &update["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"];
            Some(meta["compaction"].clone()).filter(|value| !value.is_null())
        })
        .collect()
}

/// The threshold arm on the ACP turn path: a settled turn whose usage
/// crosses the reserve headroom compacts at the boundary and publishes
/// the `compaction` meta with the summarizer's text (TS `_checkCompaction`
/// threshold arm, binary level).
///
/// Two turns over a 500-token combined ceiling (the f14 battery shape:
/// the window minus the faux harness model's `4_096` per-request output
/// budget and the reserve): the single-turn compaction skips (nothing
/// before the turn to summarize — the skip publishes the empty payload,
/// proving the arm ran), then the second turn's boundary compaction
/// summarizes turn one and publishes its result.
#[test]
fn acp_threshold_auto_compaction_publishes_the_compaction_meta() {
    let script = json!({
        "engine": "faux",
        "contextWindow": 128_000,
        "maxTokens": 4_096,
        "responses": [
            { "text": "turn one reply" },
            { "text": "turn two reply" },
            { "text": "the auto summary" },
        ]
    });
    let mut client = spawn_with_compaction_settings(
        &["--mode", "acp", "--no-session"],
        &script,
        128_000 - 4_096 - 500,
        10,
    );
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    // Turn one crosses the headroom: the boundary arm ran and the
    // single-turn skip published the empty payload.
    let prompt = client.request(
        "session/prompt",
        &json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": format!("turn one {}", "x".repeat(8_000)) }],
        }),
    );
    let (prompt_response, updates) = client.wait_response(prompt, TIMEOUT);
    assert_eq!(prompt_response["result"]["stopReason"], "end_turn");
    let metas = compaction_metas(&updates);
    assert!(!metas.is_empty(), "the threshold arm ran: {updates:?}");
    assert!(
        metas
            .iter()
            .all(|meta| meta.as_object().is_some_and(serde_json::Map::is_empty)),
        "the single-turn compaction skipped: {metas:?}"
    );

    // Turn two's boundary: the compaction summarizes turn one and
    // publishes its result.
    let prompt = client.request(
        "session/prompt",
        &json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": "turn two" }],
        }),
    );
    let (prompt_response, updates) = client.wait_response(prompt, TIMEOUT);
    assert_eq!(prompt_response["result"]["stopReason"], "end_turn");
    let metas = compaction_metas(&updates);
    let ran = metas
        .iter()
        .find(|meta| {
            meta["summary"]
                .as_str()
                .is_some_and(|summary| summary.contains("the auto summary"))
        })
        .unwrap_or_else(|| panic!("the compaction ran and published: {metas:?}"));
    assert!(ran["tokensBefore"].as_u64().unwrap() > 0);
}

/// The overflow arm on the ACP turn path: a provider context-overflow
/// error runs one compact-and-retry at the boundary and the retried turn
/// settles the prompt with `end_turn` instead of the error (TS
/// `_checkCompaction` Case 1, binary level).
#[test]
fn acp_overflow_recovery_compacts_and_retries_the_turn() {
    let script = json!({
        "engine": "faux",
        "contextWindow": 128_000,
        "responses": [
            { "text": "seed reply" },
            {
                "text": "",
                "stopReason": "error",
                "errorMessage": "prompt is too long: 213462 tokens > 200000 maximum",
            },
            { "text": "the summary" },
            { "text": "recovered reply" },
        ]
    });
    let mut client =
        spawn_with_compaction_settings(&["--mode", "acp", "--no-session"], &script, 1, 10);
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", &json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    // The seed turn: nothing fires (context far below the headroom).
    let prompt = client.request(
        "session/prompt",
        &json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": format!("seed turn {}", "x".repeat(48_000)) }],
        }),
    );
    let (prompt_response, updates) = client.wait_response(prompt, TIMEOUT);
    assert_eq!(prompt_response["result"]["stopReason"], "end_turn");
    assert!(
        compaction_metas(&updates).is_empty(),
        "nothing fires below the headroom"
    );

    // The overflow probe: the arm compacts once (the summarizer consumed
    // the third scripted response) and the retried turn recovers. The
    // daemon path releases the prompt slot before it answers the seed
    // turn, so the probe cannot bounce off the running-turn guard.
    let prompt = client.request(
        "session/prompt",
        &json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": format!("overflow probe {}", "x".repeat(2_000)) }],
        }),
    );
    let (prompt_response, updates) = client.wait_response(prompt, TIMEOUT);
    assert_eq!(
        prompt_response["result"],
        json!({ "stopReason": "end_turn" }),
        "the retry recovered the turn: {prompt_response}"
    );
    let metas = compaction_metas(&updates);
    assert_eq!(metas.len(), 1, "one compaction meta: {metas:?}");
    assert_eq!(metas[0]["summary"], "the summary");
    assert!(metas[0]["tokensBefore"].as_u64().unwrap() > 0);
}

/// The kernel Python with prime-agent-runtime installed; set
/// `PA_E2E_KERNEL_PYTHON` to point at an explicit interpreter instead.
/// Without one, the live RLM quiescence lanes below skip (with a note).
fn kernel_python() -> Option<std::path::PathBuf> {
    if let Some(explicit) = std::env::var_os("PA_E2E_KERNEL_PYTHON") {
        let explicit = std::path::PathBuf::from(explicit);
        assert!(
            explicit.exists(),
            "PA_E2E_KERNEL_PYTHON {} not found",
            explicit.display()
        );
        return Some(explicit);
    }
    let candidate = std::path::PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
        |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
    ));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!(
        "kernel python {} not found; skipping live RLM quiescence e2e",
        candidate.display()
    );
    None
}

/// The namespaced prime-agent payload of one session/update frame.
fn update_meta(frame: &Value) -> &Value {
    &frame["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"]
}

/// The kernel cell of the spawn turn (the worker's
/// `rlm_quiescence_barrier_e2e` lane): spawn one RLM child through the
/// product `rlm.spawn` surface and record its child id.
fn spawn_cell() -> &'static str {
    "handle = await rlm.spawn(\"run the lane task\", name=\"kid\")\nprint(handle.rlm_child_id)"
}

/// The parent faux script whose turns run the spawn cell; the third
/// response answers the settled child's terminal-notice turn (the no-reply
/// notice the watcher queues on the parent).
fn spawn_parent_script(spawn_cell: &str) -> Value {
    json!({
        "engine": "faux",
        "responses": [
            { "content": [
                { "type": "toolCall", "name": "ipython", "arguments": { "code": spawn_cell } },
            ] },
            { "text": "spawn turn done" },
            { "text": "notice seen" },
        ],
    })
}

/// One scripted-children lane: a daemon-attached resident session whose
/// parent turns spawn a held scripted child (resident because the RLM spawn
/// ledger needs the parent's session file — a `--no-session` parent cannot
/// spawn children). The parent's active session id is read at setup, before
/// the spawn: once a child runs, `live_sessions` lists both workers.
fn spawn_lane(
    args: &[&str],
    child_hold_ms: u64,
    kernel_python: &std::path::Path,
) -> (AcpChild, String, String) {
    let parent = spawn_parent_script(spawn_cell());
    let child_script = json!({ "responses": [ { "text": "kid done", "delayMs": child_hold_ms } ] });
    let mut client = AcpChild::spawn_with_child_script(args, &parent, &child_script, kernel_python);
    let init = client.request("initialize", &initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let session_id = new_session(&mut client);
    let socket = client.socket.clone();
    let active_session_id = live_sessions(&socket).remove(0)["activeSessionId"]
        .as_str()
        .expect("the parent session id")
        .to_string();
    (client, session_id, active_session_id)
}

/// The ACP settle waits for RLM quiescence (TS #1612): the completion
/// update reports the live outstanding-subagent count, the terminal update
/// reports zero, and the settled child's terminal-notice turn ("notice
/// seen") drains inside the barrier, between the two.
#[test]
fn acp_prompt_settles_after_rlm_quiescence() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let (mut client, session_id, _) = spawn_lane(&["--mode", "acp"], 5_000, &kernel_python);
    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "spawn the kid" }] }),
    );
    // Readiness is the completion update itself: the parent turn settled,
    // the held child turn is still in flight.
    let completion = client.wait_frame(TIMEOUT, |frame| {
        let meta = update_meta(frame);
        meta["phase"] == "event" && !meta["quiescence"].is_null()
    });
    assert_eq!(
        update_meta(&completion)["quiescence"]["outstandingSubagents"],
        1,
        "the completion reports the live child: {completion}"
    );
    // The settled child's terminal-notice turn drains inside the barrier:
    // its streamed answer lands between the completion and the terminal.
    let mut notice_seen = false;
    let terminal = client.wait_frame(TIMEOUT, |frame| {
        let meta = update_meta(frame);
        if meta["phase"] != "terminalQuiescence" {
            notice_seen |= frame["params"]["update"]["content"]["text"]
                .as_str()
                .is_some_and(|text| text.contains("notice seen"));
            return false;
        }
        true
    });
    assert!(
        notice_seen,
        "the settled child's notice turn drained inside the barrier: {terminal}"
    );
    assert_eq!(
        update_meta(&terminal)["quiescence"]["outstandingSubagents"],
        0,
        "the terminal reports a quiet family: {terminal}"
    );
    let (prompt_response, updates) = client.wait_response(prompt, TIMEOUT);
    assert!(
        updates.is_empty(),
        "the terminal frame is the last notification before the response: {updates:?}"
    );
    assert_eq!(
        prompt_response["result"],
        json!({ "stopReason": "end_turn" })
    );
}

/// A cancel during the settle cancels the outstanding subagents (TS
/// `cancelOutstandingRlmChildren` inside `stopSessionWork`): the prompt
/// answers cancelled once the stop sequence cancelled the held child, and
/// the roster reports the child cancelled. Close goes through the same
/// stop sequence, so it is not retested here.
#[test]
fn acp_cancel_during_settle_cancels_the_subagents() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let (mut client, session_id, active_session_id) =
        spawn_lane(&["--mode", "acp"], 120_000, &kernel_python);
    let socket = client.socket.clone();
    let prompt = client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "spawn the kid" }] }),
    );
    // Readiness is the completion update with the held child outstanding:
    // the settle is provably waiting on it.
    client.wait_frame(TIMEOUT, |frame| {
        let meta = update_meta(frame);
        meta["phase"] == "event" && meta["quiescence"]["outstandingSubagents"] == 1
    });
    client.notify("session/cancel", &json!({ "sessionId": session_id }));
    let (prompt_response, _) = client.wait_response(prompt, TIMEOUT);
    assert_eq!(
        prompt_response["result"],
        json!({ "stopReason": "cancelled" }),
        "the cancel settles the prompt: {prompt_response}"
    );
    // The roster shows the child the stop sequence cancelled.
    let roster = daemon_request(
        &socket,
        "children",
        &json!({ "type": "get_rlm_children", "activeSessionId": active_session_id }),
    );
    let children = roster["data"]["children"]
        .as_array()
        .unwrap_or_else(|| panic!("a children roster: {roster}"))
        .clone();
    assert_eq!(children.len(), 1, "one spawned child: {children:?}");
    assert_eq!(
        children[0]["status"], "cancelled",
        "the stop cancelled the held child: {children:?}"
    );
}

/// EOF during the settle exits without waiting for the outstanding
/// subagents (TS aborts the controller and exits): the process is gone
/// while the resident session's held child still runs — EOF does not
/// cancel a resident session's children.
#[test]
fn acp_eof_during_settle_exits_and_leaves_resident_subagents() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let (mut client, session_id, active_session_id) =
        spawn_lane(&["--mode", "acp"], 120_000, &kernel_python);
    let socket = client.socket.clone();
    client.request(
        "session/prompt",
        &json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "spawn the kid" }] }),
    );
    client.wait_frame(TIMEOUT, |frame| {
        let meta = update_meta(frame);
        meta["phase"] == "event" && meta["quiescence"]["outstandingSubagents"] == 1
    });
    client.close_stdin();
    assert!(client.child.wait().expect("the ACP child exits").success());
    // The resident session survives with the held child still running.
    let roster = daemon_request(
        &socket,
        "children",
        &json!({ "type": "get_rlm_children", "activeSessionId": active_session_id }),
    );
    let children = roster["data"]["children"]
        .as_array()
        .unwrap_or_else(|| panic!("a children roster: {roster}"))
        .clone();
    assert_eq!(children.len(), 1, "one spawned child: {children:?}");
    assert_eq!(
        children[0]["status"], "running",
        "EOF left the resident child running: {children:?}"
    );
}

/// A heartbeat change on the bound session broadcasts
/// `heartbeats_changed` to every client; the ACP link publishes the
/// change at origin turn 0 (connection-scoped like TS, never the active
/// prompt turn).
#[test]
fn acp_heartbeat_change_publishes_turn_zero_meta() {
    let mut client = AcpChild::spawn(
        &["--mode", "acp"],
        &json!({ "engine": "faux", "responses": ["The Nile."] }),
    );
    let socket = client.socket.clone();
    let _session_id = initialize_and_new_session(&mut client);
    let active_session_id = live_sessions(&socket)[0]["activeSessionId"].clone();
    let set = daemon_request(
        &socket,
        "heartbeat-set",
        &json!({
            "type": "heartbeat_set",
            "activeSessionId": active_session_id,
            "schedule": "every 90 seconds",
            "prompt": "check in",
        }),
    );
    assert_eq!(set["success"], true, "{set}");
    let change = client.wait_frame(TIMEOUT, |frame| {
        update_meta(frame)["heartbeatsChanged"] == json!(true)
    });
    assert_eq!(update_meta(&change)["promptTurnId"], 0, "{change}");
    assert_eq!(update_meta(&change)["phase"], "event", "{change}");
}

/// A bash run another client started on the bound session (the daemon's
/// `execute_bash`) surfaces as one synthetic tool call keyed by run id:
/// the started run, the streamed chunk, and the settled status.
#[test]
fn acp_user_bash_maps_to_a_synthetic_tool_call() {
    let mut client = AcpChild::spawn(
        &["--mode", "acp"],
        &json!({ "engine": "faux", "responses": ["The Nile."] }),
    );
    let socket = client.socket.clone();
    let _session_id = initialize_and_new_session(&mut client);
    let active_session_id = live_sessions(&socket)[0]["activeSessionId"].clone();
    let run = daemon_request(
        &socket,
        "bash",
        &json!({
            "type": "execute_bash",
            "activeSessionId": active_session_id,
            "command": "printf hi",
            "runId": "r1",
        }),
    );
    assert_eq!(run["success"], true, "{run}");
    let start = client.wait_frame(TIMEOUT, |frame| {
        frame["params"]["update"]["sessionUpdate"] == "tool_call"
    });
    assert_eq!(
        start["params"]["update"]["toolCallId"],
        "prime-agent-bash-r1"
    );
    assert_eq!(start["params"]["update"]["title"], "printf hi");
    assert_eq!(start["params"]["update"]["kind"], "execute");
    assert_eq!(
        start["params"]["update"]["rawInput"],
        json!({ "command": "printf hi" })
    );
    let output = client.wait_frame(TIMEOUT, |frame| {
        frame["params"]["update"]["sessionUpdate"] == "tool_call_update"
            && frame["params"]["update"]["toolCallId"] == "prime-agent-bash-r1"
            && frame["params"]["update"]["status"] == "in_progress"
    });
    assert_eq!(
        output["params"]["update"]["content"][0]["content"]["text"], "hi",
        "{output}"
    );
    let end = client.wait_frame(TIMEOUT, |frame| {
        frame["params"]["update"]["sessionUpdate"] == "tool_call_update"
            && frame["params"]["update"]["toolCallId"] == "prime-agent-bash-r1"
            && frame["params"]["update"]["status"] == "completed"
    });
    assert!(end["params"]["update"].get("content").is_none(), "{end}");
}
