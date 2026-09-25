//! End-to-end ACP-mode verification: the real binary speaks the ACP
//! JSON-RPC surface over stdio, driven by the scripted faux provider, and
//! the emitted frames are checked against the TS capture corpus
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
    stdin: std::process::ChildStdin,
    lines: Receiver<String>,
    next_id: u64,
    /// Held (never read) so the child's cwd directory outlives the process:
    /// dropping the tempdir deletes it and the child's `current_dir` fails.
    _home: tempfile::TempDir,
    spawn_stderr: Option<std::process::ChildStderr>,
}

impl AcpChild {
    fn adopt(mut child: std::process::Child) -> AcpChild {
        let home = tempfile::TempDir::new().unwrap();
        let _ = &home;
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
            stdin,
            lines,
            next_id: 0,
            _home: home,
            spawn_stderr: Some(stderr),
        }
    }

    fn spawn(args: &[&str], script: &serde_json::Value) -> AcpChild {
        let home = tempfile::TempDir::new().unwrap();
        let bin = env!("CARGO_BIN_EXE_prime-agent");
        let mut child = Command::new(bin)
            .args(args)
            .env("HOME", home.path())
            .env("PRIME_AGENT_AGENT_DIR", home.path().join("agent"))
            .env("PRIME_AGENT_FAUX_SCRIPT", script.to_string())
            .current_dir(home.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("binary present");
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
            stdin,
            lines,
            next_id: 0,
            _home: home,
            spawn_stderr: Some(stderr),
        }
    }

    fn send(&mut self, frame: Value) {
        let mut line = serde_json::to_string(&frame).unwrap();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).unwrap();
        self.stdin.flush().unwrap();
    }

    fn request(&mut self, method: &str, params: Value) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        id
    }

    fn notify(&mut self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    /// Read frames until the request `id` answers; returns the answer with
    /// the notifications seen before it, in order.
    fn wait_response(&mut self, id: u64, timeout: Duration) -> (Value, Vec<Value>) {
        let deadline = Instant::now() + timeout;
        let mut notifications = Vec::new();
        loop {
            let timeout_left = deadline.saturating_duration_since(Instant::now());
            if timeout_left.is_zero() {
                panic!("timed out waiting for response {id}");
            }
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
                Err(_) => panic!("ACP server closed stdout"),
            }
        }
    }
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
    let id = client.request("initialize", initialize_params());
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
    let first = client.request("initialize", initialize_params());
    let _ = client.wait_response(first, TIMEOUT);
    let second = client.request("initialize", initialize_params());
    let (response, _) = client.wait_response(second, TIMEOUT);
    assert_eq!(response["result"]["protocolVersion"], 1);
}

#[test]
fn acp_prompt_stream_completion_envelope_and_stop_reason_match_ts() {
    let script = json!({ "responses": ["ACP-OK"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let prompt = client.request(
        "session/prompt",
        json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "Reply with exactly: ACP-OK" }] }),
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

    let close = client.request("session/close", json!({ "sessionId": session_id }));
    let (close_response, _) = client.wait_response(close, TIMEOUT);
    assert_eq!(close_response["result"], json!({}));
}

#[test]
fn acp_prompt_chunk_carries_the_assistant_message_id() {
    let script = json!({ "responses": ["ACP-OK"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let prompt = client.request(
        "session/prompt",
        json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "hello" }] }),
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
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", json!({ "cwd": "/tmp", "mcpServers": [] }));
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
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);

    // Unknown session (ts-errors.jsonl): -32603 with the details string.
    let prompt = client.request(
        "session/prompt",
        json!({ "sessionId": "bogus-session", "prompt": [{ "type": "text", "text": "hi" }] }),
    );
    let (response, _) = client.wait_response(prompt, TIMEOUT);
    assert_eq!(response["error"]["code"], -32603);
    assert_eq!(response["error"]["message"], "Internal error");
    assert_eq!(
        response["error"]["data"]["details"],
        "Unknown ACP session: bogus-session"
    );

    let close = client.request("session/close", json!({ "sessionId": "bogus-session" }));
    let (response, _) = client.wait_response(close, TIMEOUT);
    assert_eq!(
        response["error"]["data"]["details"],
        "Unknown ACP session: bogus-session"
    );

    let new = client.request("session/new", json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    // Second session/new on a live connection (ts-errors.jsonl).
    let again = client.request("session/new", json!({ "mcpServers": [] }));
    let (response, _) = client.wait_response(again, TIMEOUT);
    assert_eq!(response["error"]["code"], -32603);
    assert_eq!(
        response["error"]["data"]["details"],
        "prime-agent ACP mode hosts one session per connection; start another prime-agent process for a second session"
    );

    // Unknown method (ts-errors.jsonl): -32601 with the observed message.
    let unknown = client.request("unknown/method", json!({}));
    let (response, _) = client.wait_response(unknown, TIMEOUT);
    assert_eq!(response["error"]["code"], -32601);
    assert_eq!(
        response["error"]["message"],
        "\"Method not found\": unknown/method"
    );
    assert_eq!(response["error"]["data"]["method"], "unknown/method");

    let close = client.request("session/close", json!({ "sessionId": session_id }));
    let (response, _) = client.wait_response(close, TIMEOUT);
    assert_eq!(response["result"], json!({}));
}

#[test]
fn acp_initialize_with_string_protocol_version_is_invalid_params() {
    let script = json!({ "responses": ["unused"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let id = client.request(
        "initialize",
        json!({ "protocolVersion": "1", "clientCapabilities": {} }),
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
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let prompt = client.request(
        "session/prompt",
        json!({ "sessionId": session_id, "prompt": [{ "type": "image", "data": "AAAA" }] }),
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
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    client.notify("session/cancel", json!({ "sessionId": session_id }));
    // The no-op cancel answers nothing; the session still closes cleanly.
    let close = client.request("session/close", json!({ "sessionId": session_id }));
    let (close_response, notifications) = client.wait_response(close, TIMEOUT);
    assert!(notifications.is_empty(), "a no-op cancel publishes nothing");
    assert_eq!(close_response["result"], json!({}));
}

#[test]
fn acp_initialize_advertises_mcp_capabilities() {
    let script = json!({ "responses": ["unused"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", initialize_params());
    let (response, _) = client.wait_response(init, TIMEOUT);
    assert_eq!(
        response["result"]["agentCapabilities"]["mcpCapabilities"],
        json!({ "http": true })
    );
}

#[test]
fn acp_mcp_admission_accepts_valid_servers_and_close_releases() {
    let script = json!({ "responses": ["unused"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request(
        "session/new",
        json!({ "mcpServers": [
            { "name": "capture-stdio", "type": "stdio", "command": "cat", "args": [], "env": [{"name": "A", "value": "1"}] },
            { "name": "capture-http", "type": "http", "url": "https://mcp.invalid/capture", "headers": [{"name": "X-A", "value": "yes"}] },
        ]}),
    );
    let (response, _) = client.wait_response(new, TIMEOUT);
    let session_id = response["result"]["sessionId"]
        .as_str()
        .expect("admission succeeds")
        .to_string();
    let close = client.request("session/close", json!({ "sessionId": session_id }));
    let (close_response, _) = client.wait_response(close, TIMEOUT);
    assert_eq!(close_response["result"], json!({}));
}

#[test]
fn acp_mcp_admission_rejects_a_second_session_only_when_open() {
    let script = json!({ "responses": ["unused"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request(
        "session/new",
        json!({ "mcpServers": [
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
        json!({ "mcpServers": [
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
    let close = client.request("session/close", json!({ "sessionId": session_id }));
    let (close_response, _) = client.wait_response(close, TIMEOUT);
    assert_eq!(close_response["result"], json!({}));
    let replacement = client.request(
        "session/new",
        json!({ "mcpServers": [
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
        let init = client.request("initialize", initialize_params());
        let _ = client.wait_response(init, TIMEOUT);
        let new = client.request("session/new", json!({ "mcpServers": servers }));
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
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request(
        "session/new",
        // No `env` (required), invalid env item, http without headers.
        json!({ "mcpServers": [
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
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let long = format!("a{}", "b".repeat(50));
    let new = client.request(
        "session/new",
        json!({ "mcpServers": [
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
fn acp_daemon_attached_serves_a_client_owned_session() {
    // The daemon-attached transport: the binary spawns a supervisor on
    // the sandboxed socket, hosts a client-owned scripted session, and
    // serves the same ACP surface (chunk + settle envelope + end_turn).
    let home = tempfile::TempDir::new().unwrap();
    let socket = home.path().join("daemon.sock");
    let script_path = home.path().join("worker-script.json");
    let script = json!({ "engine": "faux", "responses": ["The Thames flows through London."] });
    std::fs::write(&script_path, script.to_string()).unwrap();
    let bin = env!("CARGO_BIN_EXE_prime-agent");
    let child = Command::new(bin)
        .args([
            "--mode",
            "acp",
            "--no-session",
            "--daemon-socket",
            socket.to_str().unwrap(),
        ])
        .env("HOME", home.path())
        .env("PRIME_AGENT_AGENT_DIR", home.path().join("agent"))
        .env("PRIME_AGENT_ACP_DAEMON_SCRIPT", &script_path)
        // The ACP child spawns the sandboxed supervisor, which spawns the
        // session worker; a killed child must not leak that worker into
        // later test binaries. The supervisor-lost exit (TS
        // `exitIfSupervisorOrphanedForTooLong`) runs on this short window
        // (the env flows child -> supervisor -> worker) instead of the
        // 5-minute default.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .current_dir(home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("binary present");
    let mut client = AcpChild::adopt(child);
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, Duration::from_mins(1));
    assert!(
        new_response["result"]["sessionId"].is_string(),
        "daemon-attached admission succeeds: {new_response}"
    );
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let prompt = client.request(
        "session/prompt",
        json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "Name a river." }] }),
    );
    let (prompt_response, updates) = client.wait_response(prompt, Duration::from_mins(2));
    assert_eq!(prompt_response["result"]["stopReason"], "end_turn");
    let chunk = updates
        .iter()
        .find(|update| update["params"]["update"]["sessionUpdate"] == "agent_message_chunk");
    assert!(chunk.is_some(), "the daemon stream maps to ACP chunks");
    let close = client.request("session/close", json!({ "sessionId": session_id }));
    let (close_response, _) = client.wait_response(close, Duration::from_mins(1));
    assert_eq!(close_response["result"], json!({}));
    drop(client);
    shutdown_sandboxed_daemon(&socket);
}

#[test]
fn acp_daemon_attached_admits_mcp_servers_through_the_wire() {
    let home = tempfile::TempDir::new().unwrap();
    let socket = home.path().join("daemon.sock");
    let script_path = home.path().join("worker-script.json");
    std::fs::write(&script_path, json!({ "responses": ["unused"] }).to_string()).unwrap();
    let bin = env!("CARGO_BIN_EXE_prime-agent");
    let child = Command::new(bin)
        .args([
            "--mode",
            "acp",
            "--no-session",
            "--daemon-socket",
            socket.to_str().unwrap(),
        ])
        .env("HOME", home.path())
        .env("PRIME_AGENT_AGENT_DIR", home.path().join("agent"))
        .env("PRIME_AGENT_ACP_DAEMON_SCRIPT", &script_path)
        // The ACP child spawns the sandboxed supervisor, which spawns the
        // session worker; a killed child must not leak that worker into
        // later test binaries. The supervisor-lost exit (TS
        // `exitIfSupervisorOrphanedForTooLong`) runs on this short window
        // (the env flows child -> supervisor -> worker) instead of the
        // 5-minute default.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .current_dir(home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("binary present");
    let mut client = AcpChild::adopt(child);
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    // The admission validation runs in the transport; the servers ride
    // the replace_acp_mcp_servers wire command to the worker.
    let new = client.request(
        "session/new",
        json!({ "mcpServers": [
            { "name": "capture-stdio", "type": "stdio", "command": "cat", "args": [], "env": [] },
        ]}),
    );
    let (new_response, _) = client.wait_response(new, Duration::from_mins(1));
    assert!(
        new_response["result"]["sessionId"].is_string(),
        "{}",
        new_response
    );
    // A schema-invalid entry is dropped before the wire, exactly like
    // the in-process path.
    let close_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let close = client.request("session/close", json!({ "sessionId": close_id }));
    let (close_response, _) = client.wait_response(close, Duration::from_mins(1));
    assert_eq!(close_response["result"], json!({}));
    drop(client);
    shutdown_sandboxed_daemon(&socket);
}

#[test]
fn acp_daemon_attached_cancels_mid_turn() {
    // A scripted worker with a slow turn: the cancel lands while the
    // turn runs, and the prompt resolves `{stopReason: "cancelled"}`
    // with no boundary frames — the TS daemon-attached cancel shape.
    let home = tempfile::TempDir::new().unwrap();
    let socket = home.path().join("daemon.sock");
    let script_path = home.path().join("worker-script.json");
    std::fs::write(
        &script_path,
        json!({ "responses": [{ "text": "a slow answer", "delayMs": 8000 }] }).to_string(),
    )
    .unwrap();
    let bin = env!("CARGO_BIN_EXE_prime-agent");
    let child = Command::new(bin)
        .args([
            "--mode",
            "acp",
            "--no-session",
            "--daemon-socket",
            socket.to_str().unwrap(),
        ])
        .env("HOME", home.path())
        .env("PRIME_AGENT_AGENT_DIR", home.path().join("agent"))
        .env("PRIME_AGENT_ACP_DAEMON_SCRIPT", &script_path)
        // The ACP child spawns the sandboxed supervisor, which spawns the
        // session worker; a killed child must not leak that worker into
        // later test binaries. The supervisor-lost exit (TS
        // `exitIfSupervisorOrphanedForTooLong`) runs on this short window
        // (the env flows child -> supervisor -> worker) instead of the
        // 5-minute default.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .current_dir(home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("binary present");
    let mut client = AcpChild::adopt(child);
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, Duration::from_mins(1));
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let prompt = client.request(
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "a slow question" }] }),
        );
    // The turn is mid-delay: cancel, then wait for the prompt response.
    client.notify("session/cancel", json!({ "sessionId": session_id }));
    let (prompt_response, updates) = client.wait_response(prompt, Duration::from_mins(1));
    assert_eq!(prompt_response["result"]["stopReason"], "cancelled");
    assert!(
        updates.is_empty(),
        "a cancelled turn publishes no boundary frames after the cancel"
    );
    let close = client.request("session/close", json!({ "sessionId": session_id }));
    let (close_response, _) = client.wait_response(close, Duration::from_mins(1));
    assert_eq!(close_response["result"], json!({}));
    drop(client);
    shutdown_sandboxed_daemon(&socket);
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
    let script = json!({ "responses": ["one answer"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let prompt = client.request(
        "session/prompt",
        json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "/compact" }] }),
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
    // The tiny budget bounds the goal loop the direct-ACP settle loop now
    // hosts (TS parity: the continuation loop runs inside the same
    // session/prompt request): the crossing turn's budget-limit steer is
    // the second model segment, and the budget_limited goal settles the
    // prompt with end_turn instead of looping forever.
    let script = json!({ "responses": ["GOAL-PROGRESS", "WRAP-UP"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let prompt = client.request(
        "session/prompt",
        json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "/goal --budget 5 reply with exactly: GOAL-PROGRESS" }] }),
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
    let script = json!({ "responses": ["an answer"] });
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
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let prompt = client.request(
        "session/prompt",
        json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "do the thing" }] }),
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
    let script = json!({ "responses": ["an answer"] });
    let mut client = AcpChild::spawn(&["--mode", "acp", "--no-session"], &script);
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let prompt = client.request(
        "session/prompt",
        json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": "hi" }] }),
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
fn acp_daemon_attached_publishes_the_goal_update_meta() {
    // The daemon worker executes `/goal` and emits the `goal_update`
    // session event; the daemon-attached ACP surface maps it to the
    // namespaced `_meta.goal` update (TS acp-events.ts case "goal_update").
    let home = tempfile::TempDir::new().unwrap();
    let socket = home.path().join("daemon.sock");
    let script_path = home.path().join("worker-script.json");
    // A goal start schedules its continuation as the turn's model segment,
    // so the faux engine needs one response.
    let script = json!({ "engine": "faux", "responses": ["the goal turn settled"] });
    std::fs::write(&script_path, script.to_string()).unwrap();
    let bin = env!("CARGO_BIN_EXE_prime-agent");
    let child = Command::new(bin)
        .args([
            "--mode",
            "acp",
            "--no-session",
            "--daemon-socket",
            socket.to_str().unwrap(),
        ])
        .env("HOME", home.path())
        .env("PRIME_AGENT_AGENT_DIR", home.path().join("agent"))
        .env("PRIME_AGENT_ACP_DAEMON_SCRIPT", &script_path)
        // The ACP child spawns the sandboxed supervisor, which spawns the
        // session worker; a killed child must not leak that worker into
        // later test binaries. The supervisor-lost exit (TS
        // `exitIfSupervisorOrphanedForTooLong`) runs on this short window
        // (the env flows child -> supervisor -> worker) instead of the
        // 5-minute default.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .current_dir(home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("binary present");
    let mut client = AcpChild::adopt(child);
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, Duration::from_mins(1));
    assert!(
        new_response["result"]["sessionId"].is_string(),
        "daemon-attached admission succeeds: {new_response}"
    );
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let prompt = client.request(
        "session/prompt",
        json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": "/goal --budget 500 make the daemon publish goal state" }],
        }),
    );
    let (prompt_response, updates) = client.wait_response(prompt, Duration::from_mins(2));
    assert_eq!(prompt_response["result"]["stopReason"], "end_turn");
    let goal = updates.iter().find_map(|update| {
        let meta = &update["params"]["update"]["_meta"]["ai.primeintellect.prime-agent"]["goal"];
        (!meta.is_null()).then(|| meta.clone())
    });
    let goal = goal.expect("a _meta.goal update reached the ACP surface");
    assert_eq!(goal["status"], "active");
    assert_eq!(goal["objective"], "make the daemon publish goal state");
    assert_eq!(goal["tokenBudget"], 500);
    assert_eq!(goal["tokensUsed"], 0);
    let close = client.request("session/close", json!({ "sessionId": session_id }));
    let (close_response, _) = client.wait_response(close, Duration::from_mins(1));
    assert_eq!(close_response["result"], json!({}));
    drop(client);
    shutdown_sandboxed_daemon(&socket);
}

#[test]
fn acp_daemon_attached_reports_autonomous_accounting_and_limit_stop_reason() {
    // An autonomous run with --max-turns 1: the completion envelope carries
    // the _meta.autonomous accounting (TS waitForHeadlessCompletion), the
    // quiescence observation counts the remaining continuations, and the
    // turn limit surfaces as max_turn_requests (TS acpStopReason).
    let home = tempfile::TempDir::new().unwrap();
    let socket = home.path().join("daemon.sock");
    let script_path = home.path().join("worker-script.json");
    let script = json!({ "engine": "faux", "responses": [
        "enabling the run",
        "one turn runs, then the limit stops the run",
    ] });
    std::fs::write(&script_path, script.to_string()).unwrap();
    let bin = env!("CARGO_BIN_EXE_prime-agent");
    let child = Command::new(bin)
        .args([
            "--mode",
            "acp",
            "--no-session",
            "--daemon-socket",
            socket.to_str().unwrap(),
        ])
        .env("HOME", home.path())
        .env("PRIME_AGENT_AGENT_DIR", home.path().join("agent"))
        .env("PRIME_AGENT_ACP_DAEMON_SCRIPT", &script_path)
        // The ACP child spawns the sandboxed supervisor, which spawns the
        // session worker; a killed child must not leak that worker into
        // later test binaries. The supervisor-lost exit (TS
        // `exitIfSupervisorOrphanedForTooLong`) runs on this short window
        // (the env flows child -> supervisor -> worker) instead of the
        // 5-minute default.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .current_dir(home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("binary present");
    let mut client = AcpChild::adopt(child);
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", json!({ "mcpServers": [] }));
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
        json!({
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
        json!({
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
    let close = client.request("session/close", json!({ "sessionId": session_id }));
    let (close_response, _) = client.wait_response(close, Duration::from_mins(1));
    assert_eq!(close_response["result"], json!({}));
    drop(client);
    shutdown_sandboxed_daemon(&socket);
}

/// Spawn with compaction settings written into the agent dir (the
/// in-process session resolves them at session assembly).
fn spawn_with_compaction_settings(
    args: &[&str],
    script: &serde_json::Value,
    reserve_tokens: u64,
    keep_recent_tokens: u64,
) -> AcpChild {
    let home = tempfile::TempDir::new().unwrap();
    let agent_dir = home.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    std::fs::write(
        agent_dir.join("settings.json"),
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
    let bin = env!("CARGO_BIN_EXE_prime-agent");
    let mut child = Command::new(bin)
        .args(args)
        .env("HOME", home.path())
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        .env("PRIME_AGENT_FAUX_SCRIPT", script.to_string())
        .current_dir(home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("binary present");
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
        stdin,
        lines,
        next_id: 0,
        _home: home,
        spawn_stderr: Some(stderr),
    }
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
        "contextWindow": 128_000,
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
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    // Turn one crosses the headroom: the boundary arm ran and the
    // single-turn skip published the empty payload.
    let prompt = client.request(
        "session/prompt",
        json!({
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
        json!({
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
    let init = client.request("initialize", initialize_params());
    let _ = client.wait_response(init, TIMEOUT);
    let new = client.request("session/new", json!({ "mcpServers": [] }));
    let (new_response, _) = client.wait_response(new, TIMEOUT);
    let session_id = new_response["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    // The seed turn: nothing fires (context far below the headroom).
    let prompt = client.request(
        "session/prompt",
        json!({
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
    // seed turn's drain can outlive its response on a loaded runner (the
    // overflow retry then bounces off the still-running prompt guard) —
    // the probe is re-issued until the session settles (the recovered
    // turn's assertion itself is unchanged and strict).
    let mut probe_attempts = 0;
    let (prompt_response, updates) = loop {
        probe_attempts += 1;
        let prompt = client.request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": format!("overflow probe {}", "x".repeat(2_000)) }],
            }),
        );
        let (response, prompt_updates) = client.wait_response(prompt, TIMEOUT);
        // ACP `internal_error` carries the refusal text in `data.details`
        // (`Internal error` is the generic message) — match both fields.
        let refusal_text = response["error"]["data"]["details"]
            .as_str()
            .or_else(|| response["error"]["message"].as_str())
            .unwrap_or_default();
        let refused = response["error"].is_object() && refusal_text.contains("already running");
        if !refused {
            break (response, prompt_updates);
        }
        assert!(
            probe_attempts < 40,
            "the session never settled after the seed turn: {response}"
        );
        std::thread::sleep(std::time::Duration::from_millis(250));
    };
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
