//! Headless e2e for the announced non-update daemon closing (TS #2458):
//! the operator's own daemon shutdown used to drop every attached window —
//! `daemon_closing` without an update only painted a note and the pane
//! rode the daemon down. The pane must arm the bounded shutdown recovery
//! at the notice and reconnect when the daemon comes back on the same
//! socket path: the waiting row, the version-honest reconnected banner
//! (the restarted daemon's `appVersion`), and the successor's durable-id
//! reattach are all pinned — and the hiccup loop's rows must never fire.
//!
//! TS parity anchor: `reconnectAfterShutdown` reconnects to the same socket
//! path and re-attaches the same session by durable identity
//! (packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.ts),
//! with the interactive mode's `formatDaemonReconnectBanner` reporting the
//! restart honestly.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// The wait for the recovered banner: the shutdown recovery's fixed poll
/// finds the successor well inside this bound.
const BANNER_WAIT_MS: u64 = 10_000;
/// One mock generation's accept window.
const ACCEPT_WAIT_MS: u64 = 10_000;

/// The first daemon generation: serve the startup create/attach, then
/// announce the non-update closing and exit — the operator's `shutdown`
/// as every attached window reads it.
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

    /// Serve until the announced closing, then free the socket path for
    /// the successor.
    fn serve(self, socket: &Path) {
        let stream = accept(&self.listener, "the first daemon never saw the client");
        let mut writer = stream.try_clone().expect("clone first daemon socket");
        let mut reader = BufReader::new(stream);
        write_json(&mut writer, &daemon_hello(None));
        // Answer the startup create + attach and the one mounted turn,
        // then announce and die — the operator's shutdown mid-chat.
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
                    // The mounted turn completes, then the daemon
                    // announces its non-update closing and exits (the
                    // socket dies with it).
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
                    write_session_event(
                        &mut writer,
                        &json!({
                            "type": "message_end",
                            "message": {
                                "role": "assistant",
                                "stopReason": "stop",
                                "content": [
                                    { "type": "text", "text": "the streamed answer" },
                                ],
                            },
                        }),
                    );
                    write_session_event(&mut writer, &json!({ "type": "turn_end" }));
                    write_json(
                        &mut writer,
                        &json!({ "type": "daemon_closing", "reason": "shutdown" }),
                    );
                    break;
                }
                _ => write_json(&mut writer, &success_response(id, &command_type)),
            }
        }
        // Dropping the socket closes the connection; the listener goes
        // with the scope so the successor can bind the same path again.
        drop(writer);
        drop(reader);
        drop(self.listener);
        std::fs::remove_file(socket).expect("free the socket path for the successor");
    }
}

/// The successor daemon generation: back on the SAME socket path with its
/// own version, serving the reattach and recording every `attach` it
/// sees.
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
                _ => write_json(&mut writer, &success_response(id, &command_type)),
            }
        }
    }
}

/// Accept one connection, bounded: a mock that never sees its client is a
/// broken mock, not a slow one.
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

/// The supervisor hello; `app_version` is the version the restarted daemon
/// reports (the first generation reports none — the banner reads only the
/// successor's).
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
        client_settings: None,
    }
}

/// The operator's daemon restart recovers an attached window (TS #2458):
/// the announced non-update closing arms the bounded shutdown recovery,
/// the pane stays mounted while it waits, and the restarted daemon's
/// reattach lands — the version-honest banner is the visible end state.
/// Without the recovery the pane rode the hiccup loop instead: its rows
/// ("the daemon connection closed — reconnecting…", "reconnected to the
/// daemon") and their 10-minute window, never the announced-closing
/// semantics this test pins.
#[test]
fn an_announced_shutdown_reconnects_when_the_daemon_comes_back() {
    // The ambient TMUX variable adds a startup notice to the transcript;
    // scrub it so the run is the same inside tmux and out.
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let first = FirstGeneration::bind(&socket);
    let attach_requests = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&attach_requests);
    let successor_socket = socket.clone();
    let successor_version = env!("CARGO_PKG_VERSION").to_string();
    let handle = std::thread::spawn(move || {
        // The first daemon's lifetime, then the successor's — the
        // stop-and-restart the operator performs.
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
            // The barrier arms before the shutdown can even fire (the
            // daemon answers the submitted turn with the closing), so the
            // recovery banner - which cannot render before the 100ms poll
            // - is always a post-barrier frame.
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

    // TS #2458's waiting row: the announced closing armed the bounded
    // shutdown recovery (not the hiccup loop).
    assert!(
        all.contains("the Prime Agent daemon shut down; waiting for it to come back"),
        "the shutdown recovery armed at the notice:\n{all}"
    );
    // The recovered window reports the restart version-honestly.
    let equal_banner = format!(
        "Daemon restarted (v{}) - reconnected",
        env!("CARGO_PKG_VERSION")
    );
    assert!(
        all.contains(&equal_banner),
        "the version-honest banner for the equal-version successor:\n{all}"
    );
    // The hiccup loop never fired: the announced closing owns the
    // recovery.
    assert!(
        !all.contains("the daemon connection closed — reconnecting"),
        "the announced closing must not fall back to the hiccup loop:\n{all}"
    );
    assert!(
        !all.contains("reconnected to the daemon"),
        "the hiccup loop's recovery row must not appear:\n{all}"
    );
    // The successor saw the reattach: the same session, by DURABLE id
    // (the active id can change across a restart, TS #2458).
    let requests = attach_requests.lock().unwrap().clone();
    let attached_by_durable_id = requests
        .iter()
        .any(|request| request.get("activeSessionId").and_then(Value::as_str) == Some("sess-1"));
    assert!(
        attached_by_durable_id,
        "the reattach reached the successor by durable id: {requests:?}"
    );
    // The saved-transcript close never fired: the pane recovered.
    assert!(
        !all.contains("The Prime Agent daemon shut down while this window was attached"),
        "the expiry row must not appear when the daemon came back:\n{all}"
    );
}
