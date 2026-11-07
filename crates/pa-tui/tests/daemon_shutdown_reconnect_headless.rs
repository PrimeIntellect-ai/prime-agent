//! Headless e2e for the daemon reconnects: the announced non-update daemon closing (TS #2458) must
//! arm the bounded shutdown recovery at the notice and reconnect when the daemon returns on the
//! same socket path (TS `reconnectAfterShutdown`: same path, same durable session id), and a full
//! reconnect after an expired session-plane window must unblock submits.
#![cfg(unix)]
#![warn(clippy::allow_attributes_without_reason)]

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use pa_types::daemon::framing::{
    encode_private_frame, PrivateFrameDecoder, DEFAULT_PRIVATE_FRAME_LIMITS,
};
use pa_types::platform::socket_identity;
use serde_json::{json, Value};

/// The wait for the recovered banner: the shutdown recovery's fixed poll finds the successor well
/// inside this bound.
const BANNER_WAIT_MS: u64 = 10_000;
/// One mock generation's accept window.
const ACCEPT_WAIT_MS: u64 = 10_000;

/// The first daemon generation: serve the startup create/attach, then announce the non-update
/// closing and exit.
struct FirstGeneration {
    listener: UnixListener,
}

impl FirstGeneration {
    fn bind(socket: &Path) -> Self {
        let listener = UnixListener::bind(socket)
            .unwrap_or_else(|error| panic!("bind {} failed: {error}", socket.display()));
        listener
            .set_nonblocking(true)
            .expect("nonblocking mock listener");
        FirstGeneration { listener }
    }

    /// Serve until the announced closing, then free the socket path for the successor.
    fn serve(self, socket: &Path) {
        let stream = accept(&self.listener, "the first daemon never saw the client");
        let mut writer = stream.try_clone().expect("clone first daemon socket");
        let mut reader = BufReader::new(stream);
        write_json(&mut writer, &daemon_hello(None));
        // Answer the startup create + attach and the one mounted turn, then announce and die.
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let Ok(envelope) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            let id = envelope.get("id").and_then(Value::as_str).unwrap_or("");
            let command = envelope.get("command").cloned().unwrap_or(Value::Null);
            let command_type = command
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            match command_type.as_str() {
                "create" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "create",
                            "success": true,
                            "data": {
                                "activeSessionId": "s1",
                                "id": "s1",
                                "sessionId": "sess-1",
                                "sessionFile": "/tmp/sess-1.jsonl",
                            },
                        }),
                    );
                }
                "attach" => {
                    write_json(&mut writer, &attach_data(id));
                }
                "prompt" => {
                    // The turn stays mid-flight when the daemon announces and exits — the
                    // operator's shutdown does not wait for turns (the sibling turn-end e2e
                    // pins the turn-settling stats refresh).
                    write_json(&mut writer, &success_response(id, "prompt"));
                    let question = command
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    write_session_event(&mut writer, &json!({ "type": "turn_start" }));
                    write_session_event(
                        &mut writer,
                        &json!({
                            "type": "message_start",
                            "message": { "role": "user", "content": question },
                        }),
                    );
                    write_session_event(
                        &mut writer,
                        &json!({
                            "type": "message_start",
                            "message": {
                                "role": "assistant",
                                "content": [{ "type": "text", "text": "" }],
                                "assistantMessageEvent": { "type": "start" },
                            },
                        }),
                    );
                    write_session_event(
                        &mut writer,
                        &json!({
                            "type": "message_update",
                            "message": {
                                "role": "assistant",
                                "content": [
                                    { "type": "text", "text": "the streamed answer" },
                                ],
                            },
                            "assistantMessageEvent": {
                                "type": "text_delta",
                                "delta": "the streamed answer",
                            },
                        }),
                    );
                    write_json(
                        &mut writer,
                        &json!({ "type": "daemon_closing", "reason": "shutdown" }),
                    );
                    break;
                }
                _ => write_json(&mut writer, &success_response(id, &command_type)),
            }
        }
        // Dropping the socket closes the connection; the listener frees the path for the successor.
        drop(writer);
        drop(reader);
        drop(self.listener);
        std::fs::remove_file(socket).expect("free the socket path for the successor");
    }
}

/// The successor daemon generation: back on the SAME socket path with its own version, serving the
/// reattach and recording every `attach` it sees.
struct SuccessorDaemon {
    listener: UnixListener,
    /// The reattach requests the successor served (the durable-id pin).
    attach_requests: Arc<Mutex<Vec<Value>>>,
    /// The version the restarted daemon reports in its hello.
    app_version: String,
}

impl SuccessorDaemon {
    fn bind(socket: &Path, app_version: String, attach_requests: Arc<Mutex<Vec<Value>>>) -> Self {
        let listener = UnixListener::bind(socket)
            .unwrap_or_else(|error| panic!("bind successor {} failed: {error}", socket.display()));
        listener
            .set_nonblocking(true)
            .expect("nonblocking mock listener");
        SuccessorDaemon {
            listener,
            attach_requests,
            app_version,
        }
    }

    /// Serve the reattached run until it disconnects.
    fn serve(self) {
        let stream = accept(&self.listener, "the successor never saw the client");
        let mut writer = stream.try_clone().expect("clone successor socket");
        let mut reader = BufReader::new(stream);
        write_json(&mut writer, &daemon_hello(Some(&self.app_version)));
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let Ok(envelope) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            let id = envelope.get("id").and_then(Value::as_str).unwrap_or("");
            let command = envelope.get("command").cloned().unwrap_or(Value::Null);
            let command_type = command
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            match command_type.as_str() {
                "attach" => {
                    self.attach_requests.lock().unwrap().push(command);
                    write_json(&mut writer, &attach_data(id));
                }
                "prompt" => {
                    write_json(&mut writer, &success_response(id, "prompt"));
                    write_answered_turn(&mut writer, "the successor answered");
                }
                _ => write_json(&mut writer, &success_response(id, &command_type)),
            }
        }
    }
}

/// One complete assistant turn answering a prompt.
fn write_answered_turn(writer: &mut UnixStream, answer: &str) {
    let content = json!([{ "type": "text", "text": answer }]);
    write_session_event(writer, &json!({ "type": "turn_start" }));
    write_session_event(
        writer,
        &json!({
            "type": "message_start",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "" }],
                "assistantMessageEvent": { "type": "start" },
            },
        }),
    );
    write_session_event(
        writer,
        &json!({
            "type": "message_end",
            "message": { "role": "assistant", "stopReason": "stop", "content": content },
        }),
    );
    write_session_event(writer, &json!({ "type": "turn_end" }));
}

/// The session worker behind the direct link: it greets, admits the peer, serves the startup
/// attach, then dies like a killed worker.
fn serve_worker_until_attach(listener: &UnixListener) {
    let mut stream = accept(listener, "the client never opened the direct worker link");
    stream
        .set_nonblocking(false)
        .expect("blocking worker socket");
    write_frame(
        &mut stream,
        &json!({ "kind": "outbound", "outboundType": "daemon_hello" }),
        &json!({ "type": "daemon_hello" }),
    );
    let mut decoder = PrivateFrameDecoder::new(DEFAULT_PRIVATE_FRAME_LIMITS);
    let mut chunk = [0u8; 8 * 1024];
    loop {
        let read = match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(read) => read,
        };
        for frame in decoder.push(&chunk[..read]).expect("decode a client frame") {
            let id = frame.header["requestId"].as_str().unwrap_or_default();
            let header = json!({ "kind": "outbound", "outboundType": "response", "requestId": id });
            match frame.header["commandType"].as_str().unwrap_or_default() {
                "peer_auth" => write_frame(
                    &mut stream,
                    &header,
                    &json!({
                        "type": "response",
                        "id": id,
                        "command": "peer_auth",
                        "success": true,
                        "data": {
                            "workerInstanceId": "inst-1",
                            "activeSessionId": "s1",
                            "purpose": "session_client",
                        },
                    }),
                ),
                "attach" => {
                    write_frame(&mut stream, &header, &attach_data(id));
                    // Dropping the stream is the worker's death: the client's direct link is lost.
                    return;
                }
                command => write_frame(&mut stream, &header, &success_response(id, command)),
            }
        }
    }
}

fn write_frame(stream: &mut UnixStream, header: &Value, payload: &Value) {
    let frame = encode_private_frame(
        header,
        &serde_json::to_vec(payload).expect("serialize worker frame"),
        DEFAULT_PRIVATE_FRAME_LIMITS,
    )
    .expect("encode worker frame");
    stream.write_all(&frame).expect("write worker frame");
}

/// The direct-transport ticket for the mock worker's socket.
fn worker_ticket(socket: &Path) -> Value {
    let identity = socket_identity(socket).expect("worker socket identity");
    json!({
        "purpose": "session_client",
        "socketPath": socket.to_string_lossy(),
        "socketIdentity": { "dev": identity.dev, "ino": identity.ino },
        "workerInstanceId": "inst-1",
        "activeSessionId": "s1",
        "grantId": "g1",
        "token": "t",
        "expiresAt": "2999-01-01T00:00:00.000Z",
    })
}

/// The supervisor whose session worker never comes back: it grants the startup direct ticket, then
/// refuses every re-attach until the run has shown the expired session-plane window; then the
/// daemon goes down and frees the socket path for its successor.
fn serve_supervisor_with_dead_worker(
    listener: &UnixListener,
    socket: &Path,
    ticket: &Value,
    window_expired: std::sync::mpsc::Receiver<(std::time::Instant, usize)>,
) {
    let stream = accept(listener, "the supervisor never saw the client");
    let mut writer = stream.try_clone().expect("clone supervisor socket");
    let closer = stream.try_clone().expect("clone supervisor socket");
    let mut reader = BufReader::new(stream);
    let mut hello = daemon_hello(None);
    hello["serverCapabilities"] = json!(["direct_peer_transport"]);
    write_json(&mut writer, &hello);
    std::thread::spawn(move || {
        let _ = window_expired.recv();
        let _ = closer.shutdown(std::net::Shutdown::Both);
    });
    let mut ticket_granted = false;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(envelope) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let id = envelope.get("id").and_then(Value::as_str).unwrap_or("");
        let command_type = envelope["command"]["type"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let refusal = |error: &str| {
            json!({
                "type": "response",
                "id": id,
                "command": command_type,
                "success": false,
                "error": error,
            })
        };
        match command_type.as_str() {
            "create" => write_json(
                &mut writer,
                &json!({
                    "type": "response",
                    "id": id,
                    "command": "create",
                    "success": true,
                    "data": {
                        "activeSessionId": "s1",
                        "id": "s1",
                        "sessionId": "sess-1",
                        "sessionFile": "/tmp/sess-1.jsonl",
                    },
                }),
            ),
            "get_direct_worker_transport" if !ticket_granted => {
                ticket_granted = true;
                write_json(
                    &mut writer,
                    &json!({
                        "type": "response",
                        "id": id,
                        "command": "get_direct_worker_transport",
                        "success": true,
                        "data": ticket,
                    }),
                );
            }
            "get_direct_worker_transport" | "attach" => {
                write_json(&mut writer, &refusal("the session worker is gone"));
            }
            _ => write_json(&mut writer, &success_response(id, &command_type)),
        }
    }
    drop(writer);
    std::fs::remove_file(socket).expect("free the socket path for the successor");
}

/// Accept one connection, bounded: a mock that never sees its client is a broken mock, not a slow
/// one.
fn accept(listener: &UnixListener, what: &str) -> UnixStream {
    let deadline = std::time::Instant::now() + Duration::from_millis(ACCEPT_WAIT_MS);
    loop {
        match listener.accept() {
            Ok((stream, _)) => return stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    std::time::Instant::now() < deadline,
                    "{what}: the accept window expired"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("{what}: accept failed: {error}"),
        }
    }
}

/// The supervisor hello; `app_version` is the version the restarted daemon reports (the first
/// generation reports none — the banner reads only the successor's).
fn daemon_hello(app_version: Option<&str>) -> Value {
    let mut hello = json!({
        "type": "daemon_hello",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "serverCapabilities": [],
        "clientId": "mock",
    });
    if let Some(app_version) = app_version {
        hello["appVersion"] = json!(app_version);
    }
    hello
}

fn success_response(id: &str, command: &str) -> Value {
    json!({
        "type": "response",
        "id": id,
        "command": command,
        "success": true,
        "data": {},
    })
}

/// One streamed session event, routed like the daemon's event pump routes it (the `session_event`
/// envelope keyed by the active session).
fn write_session_event(writer: &mut UnixStream, event: &Value) {
    write_json(
        writer,
        &json!({
            "type": "session_event",
            "activeSessionId": "s1",
            "event": event,
        }),
    );
}

fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

/// The slim attach result with an empty transcript.
fn attach_data(id: &str) -> Value {
    json!({
        "type": "response",
        "id": id,
        "command": "attach",
        "success": true,
        "data": {
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "activeSessionId": "s1",
            "snapshot": {
                "activeSessionId": "s1",
                "summary": { "id": "s1", "cwd": "/tmp" },
                "state": {
                    "activeSessionId": "s1",
                    "cwd": "/tmp",
                    "sessionId": "sess-1",
                    "sessionName": "restart session",
                    "model": null,
                    "isStreaming": false,
                    "isCompacting": false,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                },
                "messages": [],
                "lastEventSequence": 0,
                "lastEventCursor": null,
            },
            "client": { "id": "mock", "capabilities": [] },
            "lastEventSequence": 0,
            "lastEventCursor": null,
        },
    })
}

/// One plain Enter key event.
fn enter() -> KeyEvent {
    KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
}

fn options_with_session(socket: PathBuf, session: SessionSelection) -> InteractiveOptions {
    InteractiveOptions {
        models: None,
        socket_path: socket,
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        script_path: None,
        model_selection: ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session,
        initial_message: None,
        show_images: true,
        fullscreen_mouse: false,
        theme: "prime".to_string(),
        code_block_indent: "  ".to_string(),
        tree_filter_mode: String::new(),
        branch_summary_skip_prompt: false,
        version: "0.0.0".to_string(),
        onboarding: None,
        telemetry_disabled: None,
        client_auth: None,
        traces: None,
        provider_auth: None,
        update_commands: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        prompt_stash: Arc::default(),
        session_has_children: false,
        restore_dock_focus: false,
        client_settings: None,
    }
}

/// The operator's daemon restart recovers an attached window (TS #2458): the announced non-update
/// closing arms the bounded shutdown recovery, the pane stays mounted while it waits, and the
/// restarted daemon's reattach lands.
#[test]
fn an_announced_shutdown_reconnects_when_the_daemon_comes_back() {
    // The ambient TMUX variable adds a startup notice; scrub it so runs are the same inside tmux
    // and out.
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let first = FirstGeneration::bind(&socket);
    let attach_requests = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&attach_requests);
    let successor_socket = socket.clone();
    let successor_version = env!("CARGO_PKG_VERSION").to_string();
    let handle = std::thread::spawn(move || {
        // The first daemon's lifetime, then the successor's — the stop-and-restart the operator
        // performs.
        first.serve(&successor_socket);
        let successor = SuccessorDaemon::bind(&successor_socket, successor_version, recorder);
        successor.serve();
    });

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::Type("hello".to_string()),
            HeadlessStep::Key(enter()),
            // The barrier arms before the shutdown can even fire (the daemon answers the submitted
            // turn with the closing), so the recovery banner is always a post-barrier frame.
            HeadlessStep::WaitRender {
                needle: "Daemon restarted (v".to_string(),
                timeout_ms: BANNER_WAIT_MS,
            },
            HeadlessStep::WaitMs(200),
        ],
        width: 100,
        height: 40,
    };
    let options = options_with_session(socket, SessionSelection::New);
    let outcome = runtime.block_on(run_interactive(options, UiMode::Headless(plan)));
    let _ = handle.join();
    let outcome = outcome.expect("the recovered run returns normally");
    let all = outcome.frames.join("\n");

    // TS #2458's waiting row: the announced closing armed the bounded shutdown recovery (not the
    // hiccup loop).
    assert!(
        all.contains("the Prime Agent daemon shut down; waiting for it to come back"),
        "the shutdown recovery armed at the notice:\n{all}"
    );
    let equal_banner = format!(
        "Daemon restarted (v{}) - reconnected",
        env!("CARGO_PKG_VERSION")
    );
    assert!(
        all.contains(&equal_banner),
        "the version-honest banner for the equal-version successor:\n{all}"
    );
    assert!(
        !all.contains("the daemon connection closed — reconnecting"),
        "the announced closing must not fall back to the hiccup loop:\n{all}"
    );
    assert!(
        !all.contains("reconnected to the daemon"),
        "the hiccup loop's recovery row must not appear:\n{all}"
    );
    // The successor saw the reattach: the same session, by DURABLE id (the active id can change
    // across a restart, TS #2458).
    let requests = attach_requests.lock().unwrap().clone();
    let attached_by_durable_id = requests
        .iter()
        .any(|request| request.get("activeSessionId").and_then(Value::as_str) == Some("sess-1"));
    assert!(
        attached_by_durable_id,
        "the reattach reached the successor by durable id: {requests:?}"
    );
    assert!(
        !all.contains("The Prime Agent daemon shut down while this window was attached"),
        "the expiry row must not appear when the daemon came back:\n{all}"
    );
}

/// A full reconnect after an expired session-plane window unblocks submits: the direct worker link
/// dies, the session-plane re-attach window (a fixed minute, so this e2e runs over a minute) expires
/// with every re-attach refused, then the daemon itself goes down and comes back on the same socket
/// path. The recovered pane must dispatch the next submit instead of refusing it with the stale
/// "Daemon reconnection failed" error.
#[test]
fn a_full_reconnect_after_an_expired_session_window_unblocks_submits() {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let worker_socket = dir.path().join("worker.sock");
    let supervisor = UnixListener::bind(&socket).expect("bind supervisor");
    supervisor
        .set_nonblocking(true)
        .expect("nonblocking mock listener");
    let worker = UnixListener::bind(&worker_socket).expect("bind worker");
    worker
        .set_nonblocking(true)
        .expect("nonblocking mock listener");
    let ticket = worker_ticket(&worker_socket);
    let (expired_tx, expired_rx) = std::sync::mpsc::channel();
    let worker_handle = std::thread::spawn(move || serve_worker_until_attach(&worker));
    let daemon_socket = socket.clone();
    let daemon_handle = std::thread::spawn(move || {
        serve_supervisor_with_dead_worker(&supervisor, &daemon_socket, &ticket, expired_rx);
        drop(supervisor);
        let successor = SuccessorDaemon::bind(
            &daemon_socket,
            env!("CARGO_PKG_VERSION").to_string(),
            Arc::default(),
        );
        successor.serve();
    });

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::WaitRender {
                needle: "Daemon reconnection failed".to_string(),
                timeout_ms: 90_000,
            },
            // The window expired: the daemon goes down and its successor takes the socket path.
            HeadlessStep::Timestamp(expired_tx),
            HeadlessStep::WaitRender {
                needle: "Daemon restarted (v".to_string(),
                timeout_ms: BANNER_WAIT_MS,
            },
            HeadlessStep::Type("hello".to_string()),
            HeadlessStep::Key(enter()),
            HeadlessStep::WaitRender {
                needle: "the successor answered".to_string(),
                timeout_ms: BANNER_WAIT_MS,
            },
        ],
        width: 100,
        height: 40,
    };
    let options = options_with_session(socket, SessionSelection::New);
    let outcome = runtime.block_on(run_interactive(options, UiMode::Headless(plan)));
    let _ = worker_handle.join();
    let _ = daemon_handle.join();
    let all = outcome
        .expect("the recovered run returns normally")
        .frames
        .join("\n");

    assert!(
        all.contains("Daemon reconnection failed"),
        "the session-plane window expired before the full reconnect:\n{all}"
    );
    assert!(
        all.contains("Daemon restarted (v"),
        "the full reconnect attached to the successor:\n{all}"
    );
    assert!(
        all.contains("the successor answered"),
        "the submit after the reconnect reached the daemon:\n{all}"
    );
}
