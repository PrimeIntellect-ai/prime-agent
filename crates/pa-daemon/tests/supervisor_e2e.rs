//! End-to-end supervisor tests against the real `pa-daemon` binary: spawn the
//! supervisor on a temp socket, drive it with a JSONL socket client, verify
//! session lifecycle and streamed events with the scripted engine.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

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
fn spawn_daemon(socket: &std::path::Path, agent_dir: &std::path::Path) -> Daemon {
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let child = Command::new(binary)
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
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
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if socket.exists() {
            return Daemon {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &std::path::Path) -> (Self, serde_json::Value) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let stream = loop {
            match UnixStream::connect(socket) {
                Ok(stream) => break stream,
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("connect supervisor: {error}"),
            }
        };
        let write_stream = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer: write_stream,
        };
        let hello = client.read_line();
        (client, hello)
    }

    fn send(&mut self, value: &serde_json::Value) {
        let mut line = serde_json::to_string(value).expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn send_command(&mut self, id: &str, command: serde_json::Value) {
        self.send(&serde_json::json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        }));
    }

    fn read_line(&mut self) -> serde_json::Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(15);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => continue,
                Ok(_) => {
                    return serde_json::from_str(line.trim()).expect("parse response line");
                }
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for supervisor line: {error}"
                    );
                }
            }
        }
    }

    /// Read lines until one answers the given command id.
    fn read_response(&mut self, id: &str) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(|v| v.as_str()) == Some(id) {
                return line;
            }
        }
    }

    /// Read until the response for `id`, buffering the outbound lines seen
    /// first: the daemon emits events before the command reply (TS order),
    /// so a bare `read_response` would discard them.
    fn read_response_and_lines(
        &mut self,
        id: &str,
    ) -> (
        serde_json::Value,
        std::collections::VecDeque<serde_json::Value>,
    ) {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut lines = std::collections::VecDeque::new();
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(|v| v.as_str()) == Some(id) {
                return (line, lines);
            }
            lines.push_back(line);
        }
    }

    /// The first buffered-or-live outbound line of `line_type`. Buffered
    /// lines of other types stay buffered; live lines of other types are
    /// skipped, like a filtering read loop.
    fn next_line_of_type(
        &mut self,
        lines: &mut std::collections::VecDeque<serde_json::Value>,
        line_type: &str,
    ) -> serde_json::Value {
        if let Some(index) = lines.iter().position(|l| l["type"] == line_type) {
            return lines.remove(index).expect("indexed line");
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no {line_type} line arrived");
            let line = self.read_line();
            if line["type"] == line_type {
                return line;
            }
        }
    }

    /// The first buffered-or-live `session_event` of `event_type`.
    fn take_session_event(
        &mut self,
        lines: &mut std::collections::VecDeque<serde_json::Value>,
        event_type: &str,
    ) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no {event_type} event arrived");
            let line = self.next_line_of_type(lines, "session_event");
            if line["event"]["type"] == event_type {
                return line["event"].clone();
            }
        }
    }
}

#[test]
fn supervisor_end_to_end_scripted_session_lifecycle() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    // Differential goldens captured from the TS supervisor
    // (`prime-agent --mode daemon`, protocol 7, schema 29 — the deployed
    // TS-main bundle reports the same schema id at the hello).
    assert_eq!(
        hello["protocol"],
        serde_json::json!({
            "name": "prime-agent.daemon", "version": 7
        })
    );
    assert_eq!(
        hello["schemaId"].as_str().map(|v| v.to_string()),
        Some("protocol-7-schema-29-a5c9d20f8b13".to_string())
    );
    assert!(hello["supervisorOwnerToken"].is_string());
    assert!(hello["supervisorProcessStartId"]
        .as_str()
        .unwrap_or_default()
        .starts_with("proc:"));
    assert_eq!(
        hello["serverCapabilities"],
        serde_json::json!([
            "attach_snapshot",
            "event_sequence",
            "extension_ui",
            "slim_attach",
            "chunked_snapshot",
            "client_owned_sessions",
            "delete_rlm_subagent",
            "heartbeat_catalog",
            "heartbeat_management",
            "model_catalog",
            "side_question_transcript",
            "transient_bash",
            "session_input_admission",
            "prompt_admission_cancellation",
            "owned_prompt_cancellation",
            "queue_message_mutation",
            "authoritative_child_roster",
            "owned_session_recovery_context",
            "rlm_quiescence_barrier",
            "session_input_pause",
            "acp_mcp_servers",
            "abort_and_send_queued",
            "agent_roster",
            "direct_peer_transport",
        ])
    );

    // Bare commands are rejected exactly like the TS supervisor: the
    // client-facing protocol requires the command envelope.
    client.send(&serde_json::json!({ "type": "list", "id": "bare" }));
    let rejected = client.read_response("bare");
    assert_eq!(rejected["command"], "parse");
    assert_eq!(rejected["success"], false);
    assert_eq!(
        rejected["error"],
        "Daemon commands require protocol 7 or newer"
    );

    // Empty list: no live sessions.
    client.send_command("l1", serde_json::json!({ "type": "list" }));
    let list = client.read_response("l1");
    assert_eq!(list["success"], true, "list failed: {list}");
    assert_eq!(list["data"]["sessions"], serde_json::json!([]));

    // Create a scripted session.
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [
            { "text": "hello from scripted", "delayMs": 30 },
            { "text": "second turn" },
        ] })
        .to_string(),
    )
    .expect("write script");
    client.send_command(
        "c1",
        serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string();

    // Attach and stream the first turn.
    client.send_command(
        "a1",
        serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    // Attach wire shape (differential goldens from the TS supervisor): slim
    // attach carries summary/messages only inside the snapshot, no
    // `session_attached` convenience event precedes the response.
    let data = &attached["data"];
    let keys: Vec<&str> = data
        .as_object()
        .expect("attach data object")
        .keys()
        .map(String::as_str)
        .collect();
    // TS `createAttachResult` key order (protocol, activeSessionId,
    // snapshot, replay, lastEventSequence, lastEventCursor, client): the
    // JSON map preserves insertion order, so this is the wire byte order.
    assert_eq!(
        keys,
        vec![
            "protocol",
            "activeSessionId",
            "snapshot",
            "replay",
            "lastEventSequence",
            "lastEventCursor",
            "client",
        ]
    );
    let snapshot = &data["snapshot"];
    let snapshot_keys: Vec<&str> = snapshot
        .as_object()
        .expect("snapshot object")
        .keys()
        .map(String::as_str)
        .collect();
    // TS `createSessionSnapshot` key order: activeSessionId, summary,
    // state, messages, lastEventSequence, lastEventCursor, children.
    assert_eq!(
        snapshot_keys,
        vec![
            "activeSessionId",
            "summary",
            "state",
            "messages",
            "lastEventSequence",
            "lastEventCursor",
            "children",
        ]
    );
    assert_eq!(snapshot["children"], serde_json::json!([]));
    // The attach result echoes the client's own capability set (live TS
    // golden: a client that sent none gets the default pair, not the
    // supervisor's worker-facing set).
    assert_eq!(
        data["client"]["capabilities"],
        serde_json::json!(["attach_snapshot", "event_sequence"])
    );
    assert_eq!(data["replay"]["status"], "complete");

    client.send_command(
        "p1",
        serde_json::json!({ "type": "prompt", "activeSessionId": session_id, "message": "hi" }),
    );
    let (prompt_ack, mut turn_lines) = client.read_response_and_lines("p1");
    assert_eq!(prompt_ack["success"], true, "prompt failed: {prompt_ack}");

    // Streamed session events: message_start, updates, message_end, turn_end.
    // Any of them may precede the prompt reply (TS order), so the lines
    // buffered during the ack are drained first.
    let mut saw_start = false;
    let mut updates = 0usize;
    let mut final_text = String::new();
    loop {
        let line = client.next_line_of_type(&mut turn_lines, "session_event");
        let event = &line["event"];
        match event["type"].as_str() {
            Some("message_start") => saw_start = true,
            Some("message_update") => updates += 1,
            Some("message_end") => {
                // The scripted engine emits plain-string content.
                final_text = event["message"]["content"]
                    .as_str()
                    .expect("final text")
                    .to_string();
            }
            Some("turn_end") => break,
            _ => {}
        }
    }
    assert!(saw_start, "message_start streamed");
    assert!(updates > 0, "assistant updates streamed ({updates} seen)");
    assert_eq!(final_text, "hello from scripted");

    // The final answer is queryable.
    client.send_command(
        "g1",
        serde_json::json!({
            "type": "get_last_assistant_text",
            "activeSessionId": session_id,
        }),
    );
    let last = client.read_response("g1");
    assert_eq!(
        last["success"], true,
        "get_last_assistant_text failed: {last}"
    );
    assert_eq!(last["data"]["text"], "hello from scripted");

    // The session appears in list.
    client.send_command("l2", serde_json::json!({ "type": "list" }));
    let list = client.read_response("l2");
    let sessions = list["data"]["sessions"].as_array().expect("sessions");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["id"], session_id.as_str());
    // Session-summary fields match the TS `SessionSummary` wire shape.
    assert_eq!(sessions[0]["runtimeKind"], "top-level");
    assert_eq!(sessions[0]["rlmDepth"], 0);
    assert_eq!(sessions[0]["unfinishedActionCount"], 0);
    assert!(sessions[0]["modified"]
        .as_str()
        .is_some_and(|v| v.ends_with('Z')));
    assert!(sessions[0]["lastActivityAt"]
        .as_str()
        .is_some_and(|v| v.ends_with('Z')));
    // Usage from the scripted turn: input tokens and cost, zero total absent.
    let usage = &sessions[0]["usage"];
    assert!(usage["inputTokens"].as_u64().unwrap_or_default() > 0);
    assert!(usage["outputTokens"].as_u64().unwrap_or_default() > 0);
    assert!(usage["cost"].as_f64().unwrap_or_default() >= 0.0);

    // Saved-session listing: item + progress events, then the final response
    // (differential shape from the TS supervisor's `handleSavedSessionList`).
    client.send_command("e1", serde_json::json!({ "type": "list_saved_sessions" }));
    let rejected = client.read_response("e1");
    assert_eq!(rejected["success"], false);
    assert_eq!(
        rejected["error"],
        "The \"paths[0]\" property must be of type string, got undefined"
    );
    client.send_command(
        "sl1",
        serde_json::json!({
            "type": "list_saved_sessions",
            "cwd": dir.path().to_string_lossy(),
            "sessionDir": agent_dir.join("sessions").to_string_lossy(),
            "scope": "all",
        }),
    );
    let mut items = 0usize;
    let mut progress = 0usize;
    let mut rows = Vec::new();
    let saved = loop {
        let line = client.read_line();
        match line["type"].as_str() {
            Some("session_list_item") => {
                items += 1;
                let session = line["session"].clone();
                assert!(session["path"]
                    .as_str()
                    .unwrap_or_default()
                    .ends_with(".jsonl"));
                assert!(session["firstMessage"].is_string());
                assert!(session["state"]["status"].is_string());
                rows.push(session);
            }
            Some("session_list_progress") => {
                progress += 1;
                assert!(line["loaded"].as_u64().unwrap_or_default() > 0);
                assert!(
                    line["total"].as_u64().unwrap_or_default()
                        >= line["loaded"].as_u64().unwrap_or_default()
                );
            }
            _ if line["id"] == "sl1" => break line,
            _ => {}
        }
    };
    assert_eq!(
        saved["success"], true,
        "list_saved_sessions failed: {saved}"
    );
    assert_eq!(items, 1, "expected exactly the one created session");
    assert!(progress >= 1);
    let sessions = saved["data"]["sessions"].as_array().expect("sessions");
    assert_eq!(sessions.len(), items);
    assert_eq!(rows[0], sessions[0]);

    // Agent-to-agent messaging: an unknown target is rejected with the TS
    // supervisor's unknown-session error. The full client-to-client shape
    // (including the previously-hanging supervisor route) is verified in
    // tests/peer_messaging_e2e.rs; the worker-side delivery itself is
    // unit-tested in `worker::agent_message_tests`.
    client.send_command(
        "m1",
        serde_json::json!({
            "type": "send_message",
            "targetActiveSessionId": "no-such-session",
            "message": "anybody there?",
        }),
    );
    let send_missing = client.read_response("m1");
    assert_eq!(
        send_missing["success"], false,
        "send_message should fail: {send_missing}"
    );
    assert_eq!(send_missing["command"], "send_message");
    assert_eq!(
        send_missing["error"],
        "Unknown active session: no-such-session"
    );

    // Second turn of the script replays the next response.
    client.send_command(
        "p2",
        serde_json::json!({
            "type": "prompt_and_wait",
            "activeSessionId": session_id,
            "message": "again",
        }),
    );
    let done = client.read_response("p2");
    assert_eq!(done["success"], true, "prompt_and_wait failed: {done}");
    client.send_command(
        "g2",
        serde_json::json!({
            "type": "get_last_assistant_text",
            "activeSessionId": session_id,
        }),
    );
    let last = client.read_response("g2");
    assert_eq!(last["data"]["text"], "second turn");
}
// Session-read commands over the persisted branch: differential goldens
// captured from the live TS daemon (protocol 7, schema 28, read-only
// `get_session_header` / `get_session_stats` against a live session).
#[test]
fn session_stats_and_header_match_live_daemon_goldens() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);

    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [{ "text": "hi", "delayMs": 0 }] }).to_string(),
    )
    .expect("write script");
    client.send_command(
        "c1",
        serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    // `id` is the short display/selector id; `sessionId` is the persisted
    // session UUID (what `get_session_header` / `get_session_stats` report).
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string();
    let session_uuid = created["data"]["sessionId"]
        .as_str()
        .expect("sessionId in create response")
        .to_string();

    // Attach like the lifecycle test: the turn's streamed events go to
    // attached clients only.
    client.send_command(
        "a1",
        serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    client.send_command(
        "p1",
        serde_json::json!({ "type": "prompt", "activeSessionId": session_id, "message": "hi" }),
    );
    let ack = client.read_response("p1");
    assert_eq!(ack["success"], true, "prompt failed: {ack}");
    // Drain the streamed turn until it settles.
    loop {
        let line = client.read_line();
        if line["type"] == "session_event" && line["event"]["type"].as_str() == Some("turn_end") {
            break;
        }
    }

    // get_session_header: same key set and header shape as the TS golden:
    // {"header": { type, version, id, timestamp, cwd, parentSession?, rlmDepth?, git? }}.
    client.send_command(
        "h1",
        serde_json::json!({ "type": "get_session_header", "activeSessionId": session_id }),
    );
    let header = client.read_response("h1");
    assert_eq!(
        header["success"], true,
        "get_session_header failed: {header}"
    );
    let header = &header["data"]["header"];
    assert_eq!(header["type"], "session");
    assert_eq!(header["version"], 3);
    assert_eq!(header["id"], session_uuid.as_str());
    assert_eq!(header["cwd"], dir.path().to_string_lossy().to_string());
    assert!(header["timestamp"]
        .as_str()
        .is_some_and(|v| v.ends_with('Z')));
    let header_keys: Vec<&str> = header
        .as_object()
        .expect("header object")
        .keys()
        .map(String::as_str)
        .collect();
    // The TS session-file header key order (the comment above): the JSON
    // map preserves insertion order, so this is the wire byte order.
    assert_eq!(
        header_keys,
        vec!["type", "version", "id", "timestamp", "cwd", "rlmDepth"]
    );

    // get_session_stats: the TS stats shape over the scripted turn. The
    // scripted engine has no model, so `contextUsage` is omitted exactly like
    // a TS session without a model context window.
    client.send_command(
        "st1",
        serde_json::json!({ "type": "get_session_stats", "activeSessionId": session_id }),
    );
    let stats = client.read_response("st1");
    assert_eq!(stats["success"], true, "get_session_stats failed: {stats}");
    let data = &stats["data"];
    assert_eq!(data["sessionId"], session_uuid.as_str());
    assert!(data["sessionFile"]
        .as_str()
        .is_some_and(|path| path.ends_with(".jsonl")));
    assert_eq!(data["userMessages"], 1);
    assert_eq!(data["assistantMessages"], 1);
    assert_eq!(data["toolCalls"], 0);
    assert_eq!(data["toolResults"], 0);
    assert_eq!(data["totalMessages"], 2);
    assert_eq!(data["cost"], 0.0);
    // Scripted usage block: input 120, output 8.
    assert_eq!(data["tokens"]["input"], 120);
    assert_eq!(data["tokens"]["output"], 8);
    assert_eq!(data["tokens"]["cacheRead"], 0);
    assert_eq!(data["tokens"]["cacheWrite"], 0);
    assert_eq!(data["tokens"]["total"], 128);
    let stats_keys: Vec<&str> = data
        .as_object()
        .expect("stats object")
        .keys()
        .map(String::as_str)
        .collect();
    // TS `SessionStats` key order (sessionFile, sessionId, userMessages,
    // assistantMessages, toolCalls, toolResults, totalMessages, tokens,
    // cost): the JSON map preserves insertion order.
    assert_eq!(
        stats_keys,
        vec![
            "sessionFile",
            "sessionId",
            "userMessages",
            "assistantMessages",
            "toolCalls",
            "toolResults",
            "totalMessages",
            "tokens",
            "cost",
        ]
    );

    // Unknown active session selector fails with the TS error string.
    client.send_command(
        "h2",
        serde_json::json!({ "type": "get_session_stats", "activeSessionId": "nope" }),
    );
    let missing = client.read_response("h2");
    assert_eq!(missing["success"], false);
    assert_eq!(missing["error"], "Unknown active session: nope");
}

/// Telemetry attach guard (TS `assertTelemetryAttachAllowed` parity): a
/// telemetry-disabled client may not attach to a worker running with
/// telemetry enabled, with the TS error text; attaching to a
/// telemetry-disabled worker stays allowed.
#[test]
fn telemetry_disabled_attach_guard_matches_ts_error() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);

    // Session 1: telemetry-enabled (no `telemetryDisabled` on create).
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [{ "text": "ok", "delayMs": 0 }] }).to_string(),
    )
    .expect("write script");
    let session_config = serde_json::json!({
        "cwd": dir.path().to_string_lossy(),
        "sessionDir": agent_dir.join("sessions").to_string_lossy(),
        "script": script_path.to_string_lossy(),
    });
    client.send_command(
        "tc1",
        serde_json::json!({ "type": "create", "config": session_config }),
    );
    let created = client.read_response("tc1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string();

    // Disabled attach to an enabled worker: the exact TS error.
    client.send_command(
        "ta1",
        serde_json::json!({
            "type": "attach",
            "activeSessionId": session_id,
            "telemetryDisabled": true,
        }),
    );
    let rejected = client.read_response("ta1");
    assert_eq!(
        rejected["success"], false,
        "attach must be refused: {rejected}"
    );
    assert_eq!(
        rejected["error"],
        "Cannot attach to this active agent while telemetry is disabled for the current invocation. Stop the agent and retry so it can restart without telemetry."
    );

    // Enabled attach to the same worker stays fine (guard does not over-block).
    client.send_command(
        "ta2",
        serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.read_response("ta2");
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    // Session 2: created with telemetry disabled — a disabled attach is
    // allowed against its worker.
    client.send_command(
        "tc2",
        serde_json::json!({
            "type": "create",
            "config": session_config,
            "telemetryDisabled": true,
        }),
    );
    let created2 = client.read_response("tc2");
    assert_eq!(created2["success"], true, "create 2 failed: {created2}");
    let session_id2 = created2["data"]["id"]
        .as_str()
        .or_else(|| created2["data"]["sessionId"].as_str())
        .expect("session id in create 2 response")
        .to_string();
    client.send_command(
        "ta3",
        serde_json::json!({
            "type": "attach",
            "activeSessionId": session_id2,
            "telemetryDisabled": true,
        }),
    );
    let attached2 = client.read_response("ta3");
    assert_eq!(
        attached2["success"], true,
        "disabled attach to disabled worker failed: {attached2}"
    );
}

/// Pids whose parent is `ppid` (the supervisor's live worker children).
fn child_pids_of(ppid: u32) -> Vec<u32> {
    let mut pids = Vec::new();
    let entries = std::fs::read_dir("/proc").expect("read /proc");
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        // `comm` can contain spaces and parens, so parse after the last ')'.
        let Some((_, rest)) = stat.rsplit_once(')') else {
            continue;
        };
        let mut fields = rest.split_whitespace();
        fields.next(); // process state
        let Ok(parent) = fields.next().unwrap_or_default().parse::<u32>() else {
            continue;
        };
        if parent == ppid {
            pids.push(pid);
        }
    }
    pids
}

/// Liveness that ignores zombies: a detached child nobody reaps keeps its
/// `/proc` entry (exit status pending), so path existence alone would call
/// an exited process alive.
fn process_alive(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    // `comm` can contain spaces and parens, so parse after the last ')'.
    let Some((_, rest)) = stat.rsplit_once(')') else {
        return false;
    };
    let state = rest.split_whitespace().next().unwrap_or_default();
    !state.starts_with('Z') && !state.starts_with('X')
}

/// Wait for the child to exit by itself within `timeout` (no kill).
fn wait_child_exit(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            return Some(status);
        }
        if Instant::now() > deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The shutdown command must stop every worker and exit the supervisor
/// process itself, cleaning up its socket (the CLI's stale-replacement and
/// shutdown paths wait for the daemon to be gone; a supervisor that stays
/// parked on its listening socket would block replacement forever and leak
/// both processes).
#[test]
fn shutdown_command_exits_the_supervisor_process() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");
    let mut daemon = spawn_daemon(&socket, &agent_dir);
    let supervisor_pid = daemon.child.id();
    let (mut client, _hello) = Client::connect(&socket);

    // A live session so a worker process exists when shutdown arrives.
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [ { "text": "x" } ] }).to_string(),
    )
    .expect("write script");
    client.send_command(
        "c1",
        serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    // The supervisor spawned exactly one worker child for the session.
    let deadline = Instant::now() + Duration::from_secs(10);
    let worker_pids = loop {
        let children = child_pids_of(supervisor_pid);
        if !children.is_empty() {
            break children;
        }
        assert!(Instant::now() < deadline, "worker never spawned");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(worker_pids.len(), 1, "one worker per session");

    client.send_command("sd", serde_json::json!({ "type": "shutdown" }));
    let shutdown = client.read_response("sd");
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");

    // The supervisor exits on its own, cleanly, and takes the socket file.
    let exit = wait_child_exit(&mut daemon.child, Duration::from_secs(10))
        .expect("the supervisor process exited after shutdown");
    assert!(exit.success(), "supervisor exit: {exit:?}");
    assert!(!socket.exists(), "the socket file is removed on exit");

    // No worker process outlives the shutdown.
    let deadline = Instant::now() + Duration::from_secs(10);
    for pid in worker_pids {
        while process_alive(pid) {
            assert!(
                Instant::now() < deadline,
                "worker {pid} leaked after shutdown"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

// Side questions end to end: `start_side_question`/`abort_side_question` over
// the scripted engine, events routed back to the owner client
// (TS daemon-mode handlers + `core/side-question.ts`).
#[test]
fn side_questions_start_abort_and_events_scripted() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);

    // Create a scripted session whose side-question script fails once
    // transiently (retried with fast delays), then answers after a delay long
    // enough to observe the in-flight guards and the abort.
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({
            "responses": [],
            "sideQuestion": {
                "responses": [
                    { "error": "stream failed once", "kind": "server_error", "status": 500 },
                    { "text": "the side answer", "delayMs": 1500 },
                ],
                "retry": {
                    "enabled": true, "maxRetries": 2,
                    "baseDelayMs": 5, "maxRetryDelayMs": 1000,
                },
            },
        })
        .to_string(),
    )
    .expect("write script");
    client.send_command(
        "c1",
        serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();

    // Attach first: the supervisor fans worker frames (including
    // `side_question_event`) out to clients attached to the session.
    client.send_command(
        "a1",
        serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    // Unknown session fails with the TS routing error.
    client.send_command(
        "sq-missing",
        serde_json::json!({
            "type": "start_side_question",
            "activeSessionId": "no-such-session",
            "sideQuestionId": "q0",
            "question": "hi?",
        }),
    );
    let missing = client.read_response("sq-missing");
    assert_eq!(missing["success"], false);
    assert_eq!(missing["error"], "Unknown active session: no-such-session");

    // Start a side question; the response acknowledges immediately.
    client.send_command(
        "sq1",
        serde_json::json!({
            "type": "start_side_question",
            "activeSessionId": session_id,
            "sideQuestionId": "q1",
            "question": "what is the answer?",
            "previousTurns": [],
        }),
    );
    let (started, mut sq1_lines) = client.read_response_and_lines("sq1");
    assert_eq!(started["success"], true, "start failed: {started}");

    // The retry played out before the partial answer: the failure was
    // transient and the second provider attempt answers.
    let mut running_answers: Vec<String> = Vec::new();
    let partial_answer = loop {
        let line = client.next_line_of_type(&mut sq1_lines, "side_question_event");
        let event = &line["event"];
        assert_eq!(line["activeSessionId"], serde_json::json!(session_id));
        assert_eq!(event["id"], serde_json::json!("q1"));
        assert_eq!(event["question"], serde_json::json!("what is the answer?"));
        assert_eq!(event["status"], serde_json::json!("running"));
        running_answers.push(event["answer"].as_str().expect("answer").to_string());
        if event["answer"] == serde_json::json!("the side answer") {
            break event["answer"].clone();
        }
    };
    assert_eq!(running_answers[0], "", "first running event is empty");

    // While the run is in flight (inside the scripted delay), the TS guards
    // hold: duplicate ids are rejected, and one run per client per session.
    client.send_command(
        "sq-dup",
        serde_json::json!({
            "type": "start_side_question",
            "activeSessionId": session_id,
            "sideQuestionId": "q1",
            "question": "same id?",
        }),
    );
    let duplicate = client.read_response("sq-dup");
    assert_eq!(duplicate["success"], false);
    assert_eq!(
        duplicate["error"], "Side question already exists: q1",
        "duplicate: {duplicate}"
    );
    client.send_command(
        "sq-busy",
        serde_json::json!({
            "type": "start_side_question",
            "activeSessionId": session_id,
            "sideQuestionId": "q2",
            "question": "second?",
        }),
    );
    let busy = client.read_response("sq-busy");
    assert_eq!(busy["success"], false);
    assert_eq!(
        busy["error"],
        "A side question is already running for this client and session"
    );

    // Aborting an unknown id reports { aborted: false }.
    client.send_command(
        "ab-unknown",
        serde_json::json!({
            "type": "abort_side_question",
            "activeSessionId": session_id,
            "sideQuestionId": "never-started",
        }),
    );
    let aborted = client.read_response("ab-unknown");
    assert_eq!(aborted["success"], true, "abort failed: {aborted}");
    assert_eq!(aborted["data"], serde_json::json!({ "aborted": false }));

    // Abort the live run: { aborted: true }, then a cancelled event carrying
    // the partial answer streamed so far.
    client.send_command(
        "ab1",
        serde_json::json!({
            "type": "abort_side_question",
            "activeSessionId": session_id,
            "sideQuestionId": "q1",
        }),
    );
    let (aborted, mut ab1_lines) = client.read_response_and_lines("ab1");
    assert_eq!(aborted["success"], true, "abort failed: {aborted}");
    assert_eq!(aborted["data"], serde_json::json!({ "aborted": true }));
    let cancelled = loop {
        let line = client.next_line_of_type(&mut ab1_lines, "side_question_event");
        if line["event"]["id"] == serde_json::json!("q1")
            && line["event"]["status"] == serde_json::json!("cancelled")
        {
            break line["event"].clone();
        }
    };
    assert_eq!(cancelled["answer"], partial_answer);

    // A cancelled run is gone: the same id starts again and this time
    // completes (the script replays from the top, fresh conversation).
    client.send_command(
        "sq2",
        serde_json::json!({
            "type": "start_side_question",
            "activeSessionId": session_id,
            "sideQuestionId": "q1",
            "question": "what is the answer?",
        }),
    );
    let (restarted, mut sq2_lines) = client.read_response_and_lines("sq2");
    assert_eq!(restarted["success"], true, "restart failed: {restarted}");
    let completed = loop {
        let line = client.next_line_of_type(&mut sq2_lines, "side_question_event");
        if line["event"]["id"] == serde_json::json!("q1")
            && line["event"]["status"] == serde_json::json!("complete")
        {
            break line["event"].clone();
        }
    };
    assert_eq!(completed["answer"], serde_json::json!("the side answer"));
    assert!(completed.get("errorMessage").is_none());
}

/// Chunked snapshot streaming on the attach path (live TS goldens in
/// `tests/goldens/chunked-attach-live-ts.json`): a `chunked_snapshot`
/// client gets the attach response with the transcript stripped, followed
/// by `session_snapshot_begin` / `session_snapshot_chunk` /
/// `session_snapshot_end` records whose reassembly equals the full
/// snapshot legacy clients receive.
#[test]
fn chunked_snapshot_attach_streams_begin_chunk_end() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("goldens/chunked-attach-live-ts.json"))
            .expect("golden fixture");

    // A scripted turn whose answer is large enough to split the transcript
    // into several chunks under the 512 KiB budget.
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({
            "responses": [{ "text": "x".repeat(700_000) }]
        })
        .to_string(),
    )
    .expect("write script");
    let (mut client, _hello) = Client::connect(&socket);
    client.send_command(
        "c1",
        serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string();

    // A plain (capability-less) client attaches first so the turn's events
    // stream; its result is also the no-capability echo golden.
    client.send_command(
        "a0",
        serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let plain_attach = client.read_response("a0");
    assert_eq!(plain_attach["success"], true, "plain attach failed");
    assert_eq!(
        plain_attach["data"]["client"]["capabilities"],
        golden["legacyClient"]["noCapabilityAttachEchoesDefaultCapabilities"]
    );

    client.send_command(
        "p1",
        serde_json::json!({
            "type": "prompt",
            "activeSessionId": session_id,
            "message": "give me a big answer"
        }),
    );
    let (prompt_ack, mut turn_lines) = client.read_response_and_lines("p1");
    assert_eq!(prompt_ack["success"], true, "prompt failed");
    // The turn_end event may precede the prompt reply (TS order).
    let _ = client.take_session_event(&mut turn_lines, "turn_end");

    // Attach with the chunked_snapshot capability.
    let caps = serde_json::json!([
        "attach_snapshot",
        "event_sequence",
        "slim_attach",
        "chunked_snapshot"
    ]);
    client.send_command(
        "a1",
        serde_json::json!({
            "type": "attach",
            "activeSessionId": session_id,
            "capabilities": caps,
        }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    let data = attached["data"].clone();
    let golden_data_keys: Vec<&str> = golden["attachResponse"]["dataKeys"]
        .as_array()
        .expect("golden data keys")
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    let mut data_keys: Vec<String> = data
        .as_object()
        .expect("attach data object")
        .keys()
        .cloned()
        .collect();
    data_keys.sort();
    let mut sorted_golden: Vec<String> = golden_data_keys.iter().map(|k| k.to_string()).collect();
    sorted_golden.sort();
    assert_eq!(data_keys, sorted_golden, "attach result key set");
    // The transcript is gone from the streamed result.
    assert_eq!(data["snapshot"]["messages"], serde_json::json!([]));
    assert!(
        data.get("messages").is_none(),
        "slim result has no top-level messages"
    );
    assert_eq!(
        data["client"]["capabilities"], caps,
        "client capabilities echo"
    );
    let target_chunk_bytes = &golden["begin"]["targetChunkBytes"];
    let stream = &data["snapshotStream"];
    assert_eq!(stream["targetChunkBytes"], *target_chunk_bytes);
    assert_eq!(
        stream["messageCount"],
        data["snapshot"]["summary"]["messageCount"]
    );
    let snapshot_id = stream["id"].as_str().expect("snapshot id").to_string();

    // begin / chunk / end records follow the response.
    let mut begin: Option<serde_json::Value> = None;
    let mut chunks: Vec<serde_json::Value> = Vec::new();
    let end = loop {
        let line = client.read_line();
        match line["type"].as_str() {
            Some("session_snapshot_begin") => begin = Some(line),
            Some("session_snapshot_chunk") => chunks.push(line),
            Some("session_snapshot_end") => break line,
            other => panic!("unexpected line during snapshot transfer: {other:?} {line}"),
        }
    };
    let begin = begin.expect("session_snapshot_begin");
    let golden_begin_keys: Vec<String> = golden["begin"]["keys"]
        .as_array()
        .expect("golden begin keys")
        .iter()
        .map(|v| v.as_str().expect("key").to_string())
        .collect();
    let mut begin_keys: Vec<String> = begin
        .as_object()
        .expect("begin object")
        .keys()
        .cloned()
        .collect();
    begin_keys.sort();
    let mut sorted_begin_golden = golden_begin_keys.clone();
    sorted_begin_golden.sort();
    assert_eq!(begin_keys, sorted_begin_golden, "begin key set");
    assert_eq!(begin["purpose"], "attach");
    assert_eq!(begin["purpose"], golden["begin"]["purpose"]);
    assert_eq!(begin["messageCount"], stream["messageCount"]);
    assert_eq!(begin["targetChunkBytes"], *target_chunk_bytes);
    assert_eq!(
        begin["snapshot"], data["snapshot"],
        "begin carries the header"
    );
    assert_eq!(begin["activeSessionId"], serde_json::json!(session_id));

    // Snapshot id: <activeSessionId>-<generation>-<sequence> from the event
    // cursor, shared by the response descriptor and every record.
    let cursor = &end["lastEventCursor"];
    assert_eq!(
        snapshot_id,
        format!(
            "{}-{}-{}",
            session_id,
            cursor["generation"].as_str().expect("generation"),
            end["lastEventSequence"].as_u64().expect("sequence")
        )
    );
    for record in [&begin, &end].into_iter().chain(chunks.iter()) {
        assert_eq!(record["snapshotId"], serde_json::json!(snapshot_id));
    }

    // Chunks: sequential indices, each record within the byte budget
    // (a single oversized message travels alone).
    let golden_chunk_keys: Vec<String> = golden["chunk"]["keys"]
        .as_array()
        .expect("golden chunk keys")
        .iter()
        .map(|v| v.as_str().expect("key").to_string())
        .collect();
    let budget = target_chunk_bytes.as_u64().expect("budget") as usize;
    assert!(
        chunks.len() >= 2,
        "the 700 KB transcript must split, got {} chunks",
        chunks.len()
    );
    for (index, chunk) in chunks.iter().enumerate() {
        assert_eq!(chunk["index"], serde_json::json!(index), "index order");
        assert_eq!(chunk["activeSessionId"], serde_json::json!(session_id));
        let mut chunk_keys: Vec<String> = chunk
            .as_object()
            .expect("chunk object")
            .keys()
            .cloned()
            .collect();
        chunk_keys.sort();
        let mut sorted_chunk_golden = golden_chunk_keys.clone();
        sorted_chunk_golden.sort();
        assert_eq!(chunk_keys, sorted_chunk_golden, "chunk key set");
        let serialized = serde_json::to_string(chunk).expect("serialize chunk");
        assert!(
            serialized.len() <= budget
                || chunk["messages"].as_array().is_some_and(|m| m.len() == 1),
            "chunk {index} over budget at {} bytes",
            serialized.len()
        );
    }

    // End record closes the transfer with the counts and cursor.
    let golden_end_keys: Vec<String> = golden["end"]["keys"]
        .as_array()
        .expect("golden end keys")
        .iter()
        .map(|v| v.as_str().expect("key").to_string())
        .collect();
    let mut end_keys: Vec<String> = end
        .as_object()
        .expect("end object")
        .keys()
        .cloned()
        .collect();
    end_keys.sort();
    let mut sorted_end_golden = golden_end_keys.clone();
    sorted_end_golden.sort();
    assert_eq!(end_keys, sorted_end_golden, "end key set");
    assert_eq!(end["chunkCount"], serde_json::json!(chunks.len()));
    assert_eq!(end["lastEventSequence"], data["lastEventSequence"]);
    assert_eq!(end["lastEventCursor"], data["lastEventCursor"]);

    // A legacy client still gets the full snapshot inside the response,
    // and the reassembled chunk transcript equals it exactly.
    let (mut legacy, _hello) = Client::connect(&socket);
    legacy.send_command(
        "a2",
        serde_json::json!({
            "type": "attach",
            "activeSessionId": session_id,
            "capabilities": ["attach_snapshot", "event_sequence", "slim_attach"],
        }),
    );
    let legacy_attach = legacy.read_response("a2");
    assert_eq!(
        legacy_attach["success"], true,
        "legacy attach failed: {legacy_attach}"
    );
    let legacy_data = &legacy_attach["data"];
    assert!(
        legacy_data.get("snapshotStream").is_none(),
        "no stream for legacy clients"
    );
    assert!(
        legacy_data["snapshot"]["messages"]
            .as_array()
            .is_some_and(|m| !m.is_empty()),
        "legacy snapshot carries the transcript"
    );
    let mut reassembled: Vec<serde_json::Value> = Vec::new();
    for chunk in &chunks {
        reassembled.extend(
            chunk["messages"]
                .as_array()
                .expect("chunk messages")
                .iter()
                .cloned(),
        );
    }
    assert_eq!(
        serde_json::json!(reassembled),
        legacy_data["snapshot"]["messages"],
        "reassembled chunk transcript equals the full snapshot"
    );
    assert_eq!(
        legacy_data["client"]["capabilities"],
        serde_json::json!(["attach_snapshot", "event_sequence", "slim_attach"])
    );
}

/// B-1 parity: explicit `--provider`/`--model` flags ride the create config
/// over the wire and are authoritative for the worker's model resolution —
/// no process-wide fallback (env or registry default) may answer instead.
/// The resolved model is observable through `get_session_stats`'s
/// `contextUsage.contextWindow`, which comes from the engine's model.
#[test]
fn create_config_model_flags_reach_the_worker_engine() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon-flags.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    // A models.json custom provider whose name has no env-key mapping: the
    // only way the worker can resolve it is the wire config.
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9",
                    "apiKey": "sk-battery",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128000,
                            "maxTokens": 4096
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);
    client.send_command(
        "c1",
        serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "provider": "battery",
                "model": "mock-1",
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string();
    client.send_command(
        "s1",
        serde_json::json!({ "type": "get_session_stats", "activeSessionId": session_id }),
    );
    let stats = client.read_response("s1");
    assert_eq!(stats["success"], true, "get_session_stats failed: {stats}");
    // The flagged model's context window (128000) proves the worker engine
    // resolved `battery/mock-1` from the create config.
    assert_eq!(
        stats["data"]["contextUsage"]["contextWindow"], 128000,
        "context usage reflects the wire-flagged model: {stats}"
    );
}

// Compaction on the daemon surface: `compact`/`abort_compaction`/
// `set_auto_compaction` over the scripted engine, with response and event
// shapes captured read-only from the live TS daemon
// (`tests/goldens/compaction-live-ts.json`).
#[test]
fn compaction_commands_scripted_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("goldens/compaction-live-ts.json"))
            .expect("golden fixture");
    let (mut client, _hello) = Client::connect(&socket);

    // A scripted session whose compaction script runs: (1) a success with a
    // delay long enough to observe the in-flight state and abort it,
    // (2) the TS nothing-to-compact skip, then (3) replay from the top.
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({
            "responses": [{ "text": "one turn" }],
            "compaction": { "responses": [
                // Run 1 (aborted mid-delay), run 2 (success), run 3 (skip).
                {
                    "summary": "first summary",
                    "firstKeptEntryId": "",
                    "tokensBefore": 4321,
                    "details": { "readFiles": ["a.rs"], "modifiedFiles": [] },
                    "delayMs": 1500,
                },
                {
                    "summary": "second summary",
                    "firstKeptEntryId": "",
                    "tokensBefore": 5000,
                    "details": { "readFiles": ["a.rs"], "modifiedFiles": [] },
                },
                { "error": "Session is too short to compact — try again once it grows", "skipped": true },
            ] },
        })
        .to_string(),
    )
    .expect("write script");
    client.send_command(
        "c1",
        serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();

    client.send_command(
        "a1",
        serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    // The attach snapshot's connection state defaults to auto-compaction on,
    // like the TS settings default.
    assert_eq!(
        attached["data"]["snapshot"]["state"]["autoCompactionEnabled"],
        serde_json::json!(true)
    );

    // One scripted turn so the session has content.
    client.send_command(
        "p1",
        serde_json::json!({ "type": "prompt", "activeSessionId": session_id, "message": "hi" }),
    );
    let (prompt_ack, mut turn_lines) = client.read_response_and_lines("p1");
    assert_eq!(prompt_ack["success"], true, "prompt failed");
    // The turn_end event may precede the prompt reply (TS order).
    let _ = client.take_session_event(&mut turn_lines, "turn_end");

    // Unknown session selector fails with the TS routing error.
    client.send_command(
        "cp-missing",
        serde_json::json!({ "type": "compact", "activeSessionId": "no-such-session" }),
    );
    let missing = client.read_response("cp-missing");
    assert_eq!(missing["success"], false);
    assert_eq!(missing["error"], golden["compact"]["unknownSessionError"]);

    // First compact: the scripted delay keeps it in flight. A second client
    // observes `isCompacting` mid-run, then aborts it.
    client.send_command(
        "cp1",
        serde_json::json!({
            "type": "compact",
            "activeSessionId": session_id,
            "customInstructions": "focus on the goal",
        }),
    );
    let start = loop {
        let line = client.read_line();
        if line["type"] == "session_event"
            && line["event"]["type"].as_str() == Some("compaction_start")
        {
            break line["event"].clone();
        }
    };
    assert_eq!(
        start,
        serde_json::json!({
            "type": "compaction_start",
            "reason": "manual",
            "customInstructions": "focus on the goal",
        })
    );

    let (mut second, _hello) = Client::connect(&socket);
    second.send_command(
        "a2",
        serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let second_attach = second.read_response("a2");
    assert_eq!(
        second_attach["success"], true,
        "second attach: {second_attach}"
    );
    second.send_command(
        "st1",
        serde_json::json!({ "type": "get_state", "activeSessionId": session_id }),
    );
    let state = second.read_response("st1");
    assert_eq!(state["success"], true, "get_state failed: {state}");
    assert_eq!(state["data"]["isCompacting"], serde_json::json!(true));
    assert_eq!(state["data"]["activity"], serde_json::json!("working"));
    assert_eq!(state["data"]["isSessionActive"], serde_json::json!(true));
    assert_eq!(state["data"]["isStreaming"], serde_json::json!(false));

    // Abort the in-flight compaction: success without data, then the
    // cancelled compact response and aborted `compaction_end` event.
    second.send_command(
        "ab1",
        serde_json::json!({
            "type": "abort_compaction",
            "activeSessionId": session_id,
        }),
    );
    let aborted = second.read_response("ab1");
    assert_eq!(aborted["success"], true, "abort failed: {aborted}");
    assert_eq!(aborted["command"], "abort_compaction");
    assert!(aborted.get("data").is_none(), "abort carries no data");
    let (compact_aborted, mut cp1_lines) = client.read_response_and_lines("cp1");
    assert_eq!(
        compact_aborted["success"], false,
        "aborted compact: {compact_aborted}"
    );
    assert_eq!(compact_aborted["error"], golden["compact"]["abortedError"]);
    let end_aborted = client.take_session_event(&mut cp1_lines, "compaction_end");
    // The golden's aborted capture ran without instructions; the TS catch
    // path (the `compact` catch in `agent-session.ts`) echoes the run's
    // `customInstructions`, so expect the golden plus the field this run
    // carried.
    let mut end_aborted_expected = golden["compactionEndAborted"].clone();
    end_aborted_expected["customInstructions"] = serde_json::json!("focus on the goal");
    assert_eq!(
        end_aborted, end_aborted_expected,
        "aborted compaction_end shape"
    );

    // Second compact: the next scripted result answers with the TS
    // `CompactionResult` response shape.
    client.send_command(
        "cp2",
        serde_json::json!({
            "type": "compact",
            "activeSessionId": session_id,
            "customInstructions": "focus on the goal",
        }),
    );
    let (compacted, mut cp2_lines) = client.read_response_and_lines("cp2");
    assert_eq!(compacted["success"], true, "compact failed: {compacted}");
    assert_eq!(compacted["command"], "compact");
    let data = &compacted["data"];
    // A key-set check: `serde_json` objects are BTreeMap-backed (sorted),
    // while the golden preserves the TS wire's insertion order.
    let mut data_keys: Vec<&str> = data
        .as_object()
        .expect("compact data object")
        .keys()
        .map(String::as_str)
        .collect();
    data_keys.sort_unstable();
    let mut golden_keys: Vec<&str> = golden["compact"]["successResponse"]["dataKeys"]
        .as_array()
        .expect("golden data keys")
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    golden_keys.sort_unstable();
    assert_eq!(data_keys, golden_keys, "CompactionResult key set");
    assert_eq!(data["summary"], serde_json::json!("second summary"));
    assert_eq!(data["tokensBefore"], serde_json::json!(5000));
    assert_eq!(
        data["details"],
        serde_json::json!({ "readFiles": ["a.rs"], "modifiedFiles": [] })
    );
    assert!(
        data.get("usage").is_none(),
        "usage never rides the compact response (TS parity)"
    );
    // The second compact emitted its own start event before the reply.
    let start = client.take_session_event(&mut cp2_lines, "compaction_start");
    assert_eq!(start["type"], serde_json::json!("compaction_start"));

    // The success `compaction_end` event carries the same result.
    let end_success = client.take_session_event(&mut cp2_lines, "compaction_end");
    let golden_end = &golden["compactionEndSuccess"];
    assert_eq!(end_success["type"], golden_end["type"]);
    assert_eq!(end_success["reason"], golden_end["reason"]);
    assert_eq!(end_success["result"], *data, "end result equals response");
    assert_eq!(end_success["aborted"], serde_json::json!(false));
    assert_eq!(end_success["willRetry"], serde_json::json!(false));
    assert_eq!(
        end_success["customInstructions"],
        serde_json::json!("focus on the goal")
    );
    assert!(end_success.get("errorMessage").is_none());

    // The compacted read: `compactionSummary` message first, retained
    // messages after it (the scripted empty cut keeps the whole transcript).
    client.send_command(
        "gm1",
        serde_json::json!({ "type": "get_messages", "activeSessionId": session_id }),
    );
    let messages = client.read_response("gm1");
    assert_eq!(messages["success"], true, "get_messages failed: {messages}");
    let messages = messages["data"]["messages"].as_array().expect("messages");
    assert_eq!(messages[0]["role"], serde_json::json!("compactionSummary"));
    assert_eq!(messages[0]["summary"], serde_json::json!("second summary"));
    assert_eq!(messages[0]["tokensBefore"], serde_json::json!(5000));
    assert!(
        messages[0]["retainedMessageCount"]
            .as_u64()
            .unwrap_or_default()
            > 0,
        "the empty scripted cut retains the transcript"
    );

    // The compaction is durable: a fresh attach replays the compacted view.
    let (mut third, _hello) = Client::connect(&socket);
    third.send_command(
        "a3",
        serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let reattached = third.read_response("a3");
    assert_eq!(reattached["success"], true, "reattach failed: {reattached}");
    let snapshot_messages = reattached["data"]["snapshot"]["messages"]
        .as_array()
        .expect("snapshot messages");
    assert_eq!(
        snapshot_messages[0]["role"],
        serde_json::json!("compactionSummary")
    );
    assert_eq!(
        reattached["data"]["snapshot"]["state"]["compactionCount"],
        serde_json::json!(1)
    );

    // Third compact: the script's third entry reports the TS
    // nothing-to-compact skip.
    client.send_command(
        "cp3",
        serde_json::json!({ "type": "compact", "activeSessionId": session_id }),
    );
    let (skipped, mut cp3_lines) = client.read_response_and_lines("cp3");
    assert_eq!(skipped["success"], false, "skip must fail: {skipped}");
    assert_eq!(skipped["error"], golden["compact"]["skippedError"]);
    let end_skipped = client.take_session_event(&mut cp3_lines, "compaction_end");
    let golden_skipped = &golden["compactionEndSkipped"];
    assert_eq!(end_skipped["type"], golden_skipped["type"]);
    assert_eq!(end_skipped["reason"], golden_skipped["reason"]);
    assert_eq!(end_skipped["aborted"], golden_skipped["aborted"]);
    assert_eq!(end_skipped["willRetry"], golden_skipped["willRetry"]);
    assert_eq!(end_skipped["errorMessage"], golden_skipped["errorMessage"]);
    assert_eq!(
        end_skipped["errorSeverity"],
        golden_skipped["errorSeverity"]
    );
    assert!(
        end_skipped.get("result").is_none(),
        "skip carries no result"
    );

    // set_auto_compaction: success without data; the flag lands in the
    // connection state.
    client.send_command(
        "sac1",
        serde_json::json!({
            "type": "set_auto_compaction",
            "activeSessionId": session_id,
            "enabled": false,
        }),
    );
    let disabled = client.read_response("sac1");
    assert_eq!(
        disabled,
        serde_json::json!({
            "id": "sac1",
            "type": "response",
            "command": "set_auto_compaction",
            "success": true,
        })
    );
    client.send_command(
        "a4",
        serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let reattached = client.read_response("a4");
    assert_eq!(
        reattached["data"]["snapshot"]["state"]["autoCompactionEnabled"],
        serde_json::json!(false),
        "set_auto_compaction updates the connection state"
    );
    client.send_command(
        "sac2",
        serde_json::json!({
            "type": "set_auto_compaction",
            "activeSessionId": session_id,
            "enabled": true,
        }),
    );
    let enabled = client.read_response("sac2");
    assert_eq!(enabled["success"], true, "re-enable failed: {enabled}");

    // abort_compaction with nothing running still succeeds (TS parity).
    client.send_command(
        "ab2",
        serde_json::json!({
            "type": "abort_compaction",
            "activeSessionId": session_id,
        }),
    );
    let idle_abort = client.read_response("ab2");
    assert_eq!(
        idle_abort["success"], true,
        "idle abort failed: {idle_abort}"
    );
}

// Tool-result entries (session-file parity, TS `_processAgentEvent`): a
// real-engine turn whose scripted response requests an unknown tool
// persists a `role: "toolResult"` message entry, streams the message pair
// to attached clients, and counts in `get_session_stats`.
#[test]
fn tool_result_entries_persisted_and_streamed() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let sessions_dir = agent_dir.join("sessions");
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({
            "engine": "faux",
            "responses": [
                { "content": [
                    { "type": "toolCall", "name": "no-such-tool", "id": "call-1", "arguments": {} },
                ] },
                { "text": "done" },
            ],
        })
        .to_string(),
    )
    .expect("write script");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);
    client.send_command(
        "c1",
        serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string();
    client.send_command(
        "a1",
        serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    assert_eq!(client.read_response("a1")["success"], true, "attach failed");

    client.send_command(
        "p1",
        serde_json::json!({ "type": "prompt", "activeSessionId": session_id, "message": "hi" }),
    );
    let (prompt_ack, mut lines) = client.read_response_and_lines("p1");
    assert_eq!(prompt_ack["success"], true, "prompt failed: {prompt_ack}");

    // Streamed events: the tool execution frames, then the toolResult
    // message pair, then the closing turn.
    let mut tool_result_message = serde_json::Value::Null;
    let mut message_pair = 0usize;
    let mut tool_execution_end = serde_json::Value::Null;
    loop {
        let event = client.next_line_of_type(&mut lines, "session_event")["event"].clone();
        match event["type"].as_str() {
            Some("tool_execution_start") => {
                assert_eq!(event["toolName"], "no-such-tool");
                assert_eq!(event["toolCallId"], "call-1");
            }
            Some("tool_execution_end") => tool_execution_end = event.clone(),
            Some("message_start") | Some("message_end") => {
                if event["message"]["role"] == "toolResult" {
                    message_pair += 1;
                    tool_result_message = event["message"].clone();
                }
            }
            Some("turn_end") => break,
            _ => {}
        }
    }
    assert_eq!(tool_execution_end["isError"], true);
    assert_eq!(
        tool_execution_end["toolCallId"], "call-1",
        "tool_execution_end: {tool_execution_end}"
    );
    assert_eq!(
        message_pair, 2,
        "toolResult message_start + message_end pair"
    );
    assert_eq!(tool_result_message["toolCallId"], "call-1");
    assert_eq!(tool_result_message["toolName"], "no-such-tool");
    assert_eq!(
        tool_result_message["content"][0]["text"],
        "Tool no-such-tool not found"
    );
    assert_eq!(tool_result_message["isError"], true);

    // The stats command counts the persisted entry.
    client.send_command(
        "s1",
        serde_json::json!({ "type": "get_session_stats", "activeSessionId": session_id }),
    );
    let stats = client.read_response("s1");
    assert_eq!(stats["success"], true, "get_session_stats failed: {stats}");
    assert_eq!(stats["data"]["toolCalls"], 1, "stats: {stats}");
    assert_eq!(stats["data"]["toolResults"], 1, "stats: {stats}");
    assert_eq!(stats["data"]["totalMessages"], 4, "stats: {stats}");

    // The session file carries the entry in the TS envelope shape.
    let session_file = std::path::PathBuf::from(
        stats["data"]["sessionFile"]
            .as_str()
            .expect("session file in stats"),
    );
    let entries: Vec<serde_json::Value> = std::fs::read_to_string(&session_file)
        .expect("read session file")
        .lines()
        .map(|line| serde_json::from_str(line).expect("parse entry line"))
        .collect();
    let tool_result_entry = entries
        .iter()
        .find(|entry| entry["message"]["role"] == "toolResult")
        .expect("toolResult entry on disk")
        .clone();
    assert_eq!(tool_result_entry["type"], "message");
    assert!(tool_result_entry["id"]
        .as_str()
        .is_some_and(|id| id.len() == 8));
    assert!(tool_result_entry["parentId"].as_str().is_some());
    assert!(tool_result_entry["timestamp"].as_str().is_some());
    assert_eq!(tool_result_entry["message"]["toolCallId"], "call-1");
    assert_eq!(
        tool_result_entry["message"]["content"],
        serde_json::json!([{ "type": "text", "text": "Tool no-such-tool not found" }])
    );
    assert_eq!(tool_result_entry["message"]["isError"], true);
    assert!(tool_result_entry["message"]["timestamp"].is_u64());
}

#[test]
fn create_path_duplicate_name_fails_with_current_ts_string() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [ { "text": "ok" } ] }).to_string(),
    )
    .expect("write script");

    // First create reserves the name (worker reports it via get_state).
    client.send_command(
        "c1",
        serde_json::json!({
            "type": "create",
            "name": "dup",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "first create failed: {created}");

    // Second create with the same name fails with the current TS string
    // (`formatAgentSessionNameUnavailable`, agent-messages.ts): the CLI's
    // auto-rename retry keys off the `Agent name "..." is unavailable`
    // prefix, so the old `Session name ... is unavailable for depth 0`
    // phrasing broke both parity and that fallback.
    client.send_command(
        "c2",
        serde_json::json!({
            "type": "create",
            "name": "dup",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let rejected = client.read_response("c2");
    assert_eq!(
        rejected["success"], false,
        "duplicate create succeeded: {rejected}"
    );
    assert_eq!(rejected["command"], "create");
    assert_eq!(
        rejected["error"],
        "Agent name \"dup\" is unavailable: an agent of that name already exists at depth 0 under this parent"
    );

    // An empty name keeps its own error (worker-side parity string).
    client.send_command(
        "c3",
        serde_json::json!({
            "type": "create",
            "name": "  ",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let empty = client.read_response("c3");
    assert_eq!(
        empty["success"], false,
        "empty-name create succeeded: {empty}"
    );
    assert_eq!(empty["error"], "Session name cannot be empty");
}
