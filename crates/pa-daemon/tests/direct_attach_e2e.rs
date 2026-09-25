//! Direct-attach transport e2e (thin-supervisor stage 2): a client attaches to
//! a session through a supervisor-issued ticket, streams the session over the
//! worker's OWN socket, `kill -9`s the supervisor mid-stream, keeps receiving
//! events, restarts the supervisor, and reattaches with a fresh ticket for the
//! same session. Also verifies the peer gate (single-use grants, session-plane
//! command allowlist) at the socket level.
//!
//! Linux-only e2e (AF_UNIX sockets, `kill -9` semantics): compiles to
//! nothing elsewhere, like the other pa-daemon e2e verifiers.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
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

fn spawn_supervisor(socket: &Path, agent_dir: &Path) -> Daemon {
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
        let deadline = Instant::now() + Duration::from_secs(20);
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
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

/// A raw private-frame client for the session worker's own socket.
struct WorkerClient {
    stream: UnixStream,
}

impl WorkerClient {
    fn connect(socket: &Path) -> (Self, Value) {
        let stream = UnixStream::connect(socket).expect("connect worker socket");
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        let mut client = WorkerClient { stream };
        let (header, payload) = client.read_frame();
        assert_eq!(header["outboundType"], "daemon_hello", "worker hello");
        let hello: Value = serde_json::from_slice(&payload).expect("hello payload");
        (client, hello)
    }

    fn send_frame(&mut self, header: &Value, payload: &Value) {
        let frame = pa_daemon::framing::encode_private_frame(
            header,
            &serde_json::to_vec(payload).expect("payload"),
            pa_daemon::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .expect("encode frame");
        self.stream.write_all(&frame).expect("write frame");
        self.stream.flush().expect("flush");
    }

    fn read_frame(&mut self) -> (Value, Vec<u8>) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut prefix = [0u8; 8];
        read_exact_timeout(&mut self.stream, &mut prefix, deadline);
        let header_len = u32::from_be_bytes(prefix[0..4].try_into().unwrap()) as usize;
        let payload_len = u32::from_be_bytes(prefix[4..8].try_into().unwrap()) as usize;
        let mut header = vec![0u8; header_len];
        read_exact_timeout(&mut self.stream, &mut header, deadline);
        let mut payload = vec![0u8; payload_len];
        read_exact_timeout(&mut self.stream, &mut payload, deadline);
        let header: Value = serde_json::from_slice(&header).expect("frame header");
        (header, payload)
    }

    /// One request/response round trip with a fresh request id.
    fn request(&mut self, command_type: &str, payload: &Value) -> Value {
        static NEXT_REQUEST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let request_id = format!(
            "req-{}",
            NEXT_REQUEST.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        );
        self.send_frame(
            &json!({
                "kind": "command",
                "requestId": request_id,
                "commandType": command_type,
            }),
            payload,
        );
        loop {
            let (header, body) = self.read_frame();
            if header["outboundType"].as_str() == Some("response")
                && header["requestId"].as_str() == Some(request_id.as_str())
            {
                let mut value: Value = serde_json::from_slice(&body).expect("response body");
                value["id"] = json!(request_id);
                return value;
            }
        }
    }

    /// The next session-event frame payload, or `None` once the connection
    /// is closed.
    fn next_event(&mut self, timeout: Duration) -> Option<Value> {
        let deadline = Instant::now() + timeout;
        loop {
            assert!(Instant::now() < deadline, "timed out waiting for an event");
            let (header, body) = self.read_frame();
            if header["outboundType"].as_str() == Some("session_event") {
                return Some(serde_json::from_slice(&body).expect("event payload"));
            }
        }
    }
}

fn read_exact_timeout(stream: &mut UnixStream, buffer: &mut [u8], deadline: Instant) {
    let mut read = 0usize;
    while read < buffer.len() {
        assert!(Instant::now() < deadline, "worker frame read timed out");
        match stream.read(&mut buffer[read..]) {
            Ok(0) => panic!("worker closed the connection mid-frame"),
            Ok(n) => read += n,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => panic!("worker read: {error}"),
        }
    }
}

/// The persisted worker descriptor's live identity fields.
struct WorkerIdentity {
    socket_path: PathBuf,
    worker_instance_id: String,
}

fn load_worker_identity(agent_dir: &Path, socket: &Path, worker_id: &str) -> WorkerIdentity {
    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(agent_dir, socket);
    let content = std::fs::read_to_string(descriptor_dir.join(format!("{worker_id}.json")))
        .expect("descriptor file");
    let value: Value = serde_json::from_str(&content).expect("descriptor json");
    WorkerIdentity {
        socket_path: PathBuf::from(value["socketPath"].as_str().expect("socket path")),
        worker_instance_id: value["workerInstanceId"]
            .as_str()
            .expect("worker instance id")
            .to_string(),
    }
}

/// Read one `get_direct_worker_transport` ticket from the supervisor.
fn get_ticket(client: &mut Client, session_id: &str) -> Value {
    client.send_command(
        "ticket",
        json!({ "type": "get_direct_worker_transport", "activeSessionId": session_id }),
    );
    let response = client.read_response("ticket");
    assert_eq!(
        response["success"], true,
        "ticket request failed: {response}"
    );
    response["data"].clone()
}

/// `peer_auth` over a fresh worker connection.
fn peer_auth(worker: &mut WorkerClient, ticket: &Value) -> Value {
    worker.request(
        "peer_auth",
        &json!({
            "type": "peer_auth",
            "grantId": ticket["grantId"],
            "token": ticket["token"],
            "workerInstanceId": ticket["workerInstanceId"],
            "purpose": "session_client",
        }),
    )
}

#[test]
fn direct_attach_ticket_streams_across_supervisor_kill9() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    // A scripted session: turn 1 is slow so it is streaming when the
    // supervisor dies; turn 2 proves the reattach works end to end.
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        json!({ "responses": [
            { "text": "turn-1", "delayMs": 1500 },
            { "text": "turn-2", "delayMs": 10 },
        ] })
        .to_string(),
    )
    .expect("write script");

    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    assert!(
        hello["serverCapabilities"]
            .as_array()
            .expect("capabilities")
            .iter()
            .any(|capability| capability == "direct_peer_transport"),
        "supervisor advertises direct peer transport"
    );

    // Create the session through the supervisor (control plane).
    client.send_command(
        "create",
        json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("create");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    let identity = load_worker_identity(&agent_dir, &socket, &session_id);

    // Ticket: single-use, short-lived, pinned to the worker's own socket.
    let ticket = get_ticket(&mut client, &session_id);
    assert_eq!(ticket["purpose"], "session_client");
    assert_eq!(ticket["activeSessionId"], session_id);
    assert_eq!(ticket["workerInstanceId"], identity.worker_instance_id);
    assert_eq!(
        ticket["socketPath"].as_str().expect("socket path"),
        identity.socket_path.to_string_lossy().to_string()
    );
    let expires = pa_daemon::util::iso_to_unix_ms(ticket["expiresAt"].as_str().expect("expiry"))
        .expect("expiry is ISO");
    let now = pa_daemon::util::now_ms();
    assert!(
        expires > now && expires <= now + 10_000,
        "ticket TTL is the TS 10s window"
    );

    // The grant is registered in the worker's memory: peer_auth admits the
    // ticket, and the grant burns on first use.
    let (mut worker, _hello) = WorkerClient::connect(&identity.socket_path);
    let auth = peer_auth(&mut worker, &ticket);
    assert_eq!(auth["success"], true, "peer auth failed: {auth}");
    assert_eq!(auth["data"]["activeSessionId"], session_id);
    assert_eq!(
        auth["data"]["workerInstanceId"],
        identity.worker_instance_id
    );

    // Replay of the same grant on a second connection is rejected.
    let (mut replay, _hello2) = WorkerClient::connect(&identity.socket_path);
    let replay_auth = peer_auth(&mut replay, &ticket);
    assert_eq!(
        replay_auth["success"], false,
        "grants are single use: {replay_auth}"
    );
    assert_eq!(
        replay_auth["error"], "Peer authentication failed",
        "TS auth failure string"
    );
    replay.stream.shutdown(std::net::Shutdown::Both).ok();

    // The direct attach snapshot comes from the session process.
    let attach = worker.request(
        "attach",
        &json!({
            "type": "attach",
            "activeSessionId": session_id,
            "clientId": "e2e-direct-client",
            "capabilities": ["attach_snapshot", "event_sequence", "slim_attach"],
        }),
    );
    assert_eq!(attach["success"], true, "direct attach failed: {attach}");
    assert_eq!(attach["data"]["activeSessionId"], session_id);
    assert!(attach["data"]["snapshot"].is_object(), "snapshot present");

    // Control-plane commands never ride the peer link.
    let denied = worker.request("list", &json!({ "type": "list" }));
    assert_eq!(
        denied["success"], false,
        "list must not run on the direct peer transport: {denied}"
    );
    assert_eq!(
        denied["error"], "Command is not allowed on this direct peer transport",
        "TS gate string"
    );

    // Turn 1 streams over the DIRECT socket; the supervisor dies mid-stream
    // and the stream must not even hiccup.
    let prompt = worker.request(
        "prompt",
        &json!({
            "type": "prompt",
            "activeSessionId": session_id,
            "message": "first turn",
        }),
    );
    assert_eq!(prompt["success"], true, "direct prompt failed: {prompt}");
    // The wire emits the accepted user message as a message_start +
    // message_end pair at turn start; the scripted reply arrives after its
    // delayMs, so killing at the user row is still mid-turn. The break lands
    // on the assistant message_end (the user pair's message_end is not the
    // reply).
    let mut saw_message_start = false;
    let event = loop {
        let event = worker
            .next_event(Duration::from_secs(10))
            .expect("event on the direct socket");
        match event["event"]["type"].as_str() {
            Some("message_start") if !saw_message_start => {
                saw_message_start = true;
                // Mid-turn: kill -9 the supervisor NOW.
                daemon.child.kill().expect("kill -9 supervisor");
                let _ = daemon.child.wait();
            }
            Some("message_end") if event["event"]["message"]["role"] == "assistant" => {
                break event;
            }
            _ => {}
        }
    };
    assert!(saw_message_start, "the kill happened mid-stream");
    assert_eq!(
        event["event"]["message"]["content"], "turn-1",
        "the in-flight turn completed over the direct socket with the supervisor dead"
    );
    // The full event lifecycle still arrived: turn_end follows.
    let mut saw_turn_end = false;
    while !saw_turn_end {
        let event = worker
            .next_event(Duration::from_secs(10))
            .expect("turn end after the kill");
        if event["event"]["type"] == "turn_end" {
            saw_turn_end = true;
        }
    }

    // Restart the supervisor on the same socket path; the roster rebuilds
    // from the worker's re-registration.
    let mut daemon2 = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let (mut client2, _hello) = Client::connect(&socket);
    let deadline = Instant::now() + Duration::from_secs(15);
    let roster = loop {
        client2.send_command("list", json!({ "type": "list" }));
        let list = client2.read_response("list");
        assert!(Instant::now() < deadline, "roster never rebuilt: {list}");
        let sessions = list["data"]["sessions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if sessions
            .iter()
            .any(|summary| summary["id"].as_str() == Some(session_id.as_str()))
        {
            break sessions;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(roster.len(), 1, "roster rebuilt with the same session");

    // A NEW ticket for the same session from the restarted supervisor, and a
    // fresh direct attach with it.
    let ticket2 = get_ticket(&mut client2, &session_id);
    assert_eq!(ticket2["activeSessionId"], session_id);
    assert_ne!(
        ticket2["grantId"], ticket["grantId"],
        "the new ticket carries a fresh grant"
    );
    let (mut worker2, _hello) = WorkerClient::connect(&identity.socket_path);
    let auth2 = peer_auth(&mut worker2, &ticket2);
    assert_eq!(auth2["success"], true, "fresh ticket admitted: {auth2}");
    let attach2 = worker2.request(
        "attach",
        &json!({
            "type": "attach",
            "activeSessionId": session_id,
            "clientId": "e2e-direct-client-2",
            "capabilities": ["attach_snapshot", "event_sequence", "slim_attach"],
        }),
    );
    assert_eq!(attach2["success"], true, "reattach failed: {attach2}");
    assert_eq!(
        attach2["data"]["snapshot"]["messages"]
            .as_array()
            .map(Vec::len),
        Some(2),
        "the snapshot carries the persisted first turn: {attach2}"
    );

    // The second turn completes over the new direct link.
    let prompt2 = worker2.request(
        "prompt",
        &json!({
            "type": "prompt_and_wait",
            "activeSessionId": session_id,
            "message": "second turn",
        }),
    );
    assert_eq!(prompt2["success"], true, "second prompt failed: {prompt2}");
    let answer = loop {
        let event = worker2
            .next_event(Duration::from_secs(10))
            .expect("second turn event");
        // The user row arrives as its own message_end pair first; the
        // answer is the assistant's final message_end.
        if event["event"]["type"] == "message_end"
            && event["event"]["message"]["role"] == "assistant"
        {
            break event["event"]["message"]["content"].clone();
        }
    };
    assert_eq!(answer, "turn-2", "second scripted turn completed");

    // Shutdown: the restarted supervisor takes the adopted worker down.
    client2.send_command("sd", json!({ "type": "shutdown" }));
    let shutdown = client2.read_response("sd");
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    let deadline = Instant::now() + Duration::from_secs(10);
    while daemon2.child.try_wait().expect("try wait").is_none() {
        assert!(Instant::now() < deadline, "restarted supervisor exited");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The grant lifecycle's expiry side, live: a ticket that is never used dies
/// with its TTL and cannot be presented anymore.
#[test]
fn unused_ticket_expires() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        json!({ "responses": [ { "text": "x", "delayMs": 10 } ] }).to_string(),
    )
    .expect("write script");

    let daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let (mut client, _hello) = Client::connect(&socket);
    client.send_command(
        "create",
        json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("create");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    let identity = load_worker_identity(&agent_dir, &socket, &session_id);
    let _ = &daemon; // kept alive until the end; reaped by the Drop guard

    let ticket = get_ticket(&mut client, &session_id);
    // Wait out the 10s TTL (with slack) without using the grant.
    let expires = pa_daemon::util::iso_to_unix_ms(ticket["expiresAt"].as_str().expect("expiry"))
        .expect("expiry");
    let wait = expires.saturating_sub(pa_daemon::util::now_ms()) + 500;
    std::thread::sleep(Duration::from_millis(wait));

    let (mut worker, _hello) = WorkerClient::connect(&identity.socket_path);
    let auth = peer_auth(&mut worker, &ticket);
    assert_eq!(
        auth["success"], false,
        "an expired grant must not authenticate: {auth}"
    );

    // A fresh ticket still works: expiry is per grant. The rejected
    // connection was closed by the worker (TS ends failed peer_auth
    // sockets), so the fresh grant is presented on a new connection.
    let fresh = get_ticket(&mut client, &session_id);
    let (mut worker2, _hello) = WorkerClient::connect(&identity.socket_path);
    let auth_fresh = peer_auth(&mut worker2, &fresh);
    assert_eq!(
        auth_fresh["success"], true,
        "fresh grant works: {auth_fresh}"
    );

    client.send_command("sd", json!({ "type": "shutdown" }));
    let shutdown = client.read_response("sd");
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
}
