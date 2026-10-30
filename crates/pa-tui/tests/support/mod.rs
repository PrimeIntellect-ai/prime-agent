//! Shared plumbing for the pa-tui headless integration tests: each test binary includes it with
//! `mod support;` and serves its scenario-specific daemon answers on top of it.

#![allow(
    dead_code,
    reason = "every test binary compiles this module but uses only the helpers its scenarios need"
)]

use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use pa_tui::agents_view::AgentsViewOptions;
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, InteractiveOptions, InteractiveOutcome, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// Write one newline-delimited JSON frame to the client.
pub fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

/// Write one `session_event` frame for the attached session `s1`.
pub fn write_session_event(writer: &mut UnixStream, event: &Value) {
    write_json(
        writer,
        &json!({
            "type": "session_event",
            "activeSessionId": "s1",
            "event": event,
        }),
    );
}

/// Answer `id` with a successful `command` response carrying `data` (the agents-view wire shape).
pub fn respond(writer: &mut UnixStream, id: &str, command: &str, data: &Value) {
    write_json(
        writer,
        &json!({
            "id": id,
            "type": "response",
            "command": command,
            "success": true,
            "data": data,
        }),
    );
}

/// Answer `id` with a failed `command` response carrying `error`.
pub fn respond_failure(writer: &mut UnixStream, id: &str, command: &str, error: &str) {
    write_json(
        writer,
        &json!({
            "id": id,
            "type": "response",
            "command": command,
            "success": false,
            "error": error,
        }),
    );
}

/// One request line from a client socket with a read timeout: `None` on EOF or once 90 read
/// timeouts pass without a line (the bounded quiet window that ends a serve loop).
pub fn read_line(reader: &mut BufReader<UnixStream>) -> Option<String> {
    const QUIET_WINDOW_MS: u32 = 90;
    let mut quiet_windows: u32 = 0;
    let mut line = String::new();
    loop {
        match reader.read_line(&mut line) {
            Ok(0) => return None,
            Ok(_) if line.trim().is_empty() => {
                line.clear();
            }
            Ok(_) => return Some(line),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                quiet_windows += 1;
                if quiet_windows >= QUIET_WINDOW_MS {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
                line.clear();
            }
            Err(_) => return None,
        }
    }
}

/// The headless chat-mode options every scenario starts from: a new session over `socket` with
/// images and fullscreen mouse on and no client settings. Scenarios override fields with struct
/// update syntax.
pub fn options(socket: PathBuf) -> InteractiveOptions {
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
        session: SessionSelection::New,
        initial_message: None,
        show_images: true,
        fullscreen_mouse: true,
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
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        restore_dock_focus: false,
        client_settings: None,
    }
}

/// The headless agents-view options every scenario starts from: the daemon over `socket`, no
/// anchor session, and `/tmp/sessions` as the session dir.
pub fn view_options(socket: &Path) -> AgentsViewOptions {
    AgentsViewOptions {
        socket_path: socket.to_path_buf(),
        cwd: PathBuf::from("/tmp"),
        session_dir: Some(PathBuf::from("/tmp/sessions")),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: json!({}),
    }
}

/// A successful `attach` response for the idle session `s1` named `session_name`, with no model
/// and an empty transcript. Scenarios patch the returned value for anything else (for example
/// `response["data"]["snapshot"]["messages"]`).
pub fn attach_response(id: &str, session_name: &str) -> Value {
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
                    "sessionName": session_name,
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

/// A mock daemon listening on the test's socket; each test binary adds its own `serve`.
pub struct MockSupervisor {
    pub listener: UnixListener,
}

impl MockSupervisor {
    pub fn bind(socket: &Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }
}

/// One request a mock supervisor read off the wire.
pub struct Request<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub command: Value,
}

/// Accept the next client within a 1.5 s idle window; `None` when no client dials in time, so a
/// mock whose client may never connect still lets the plan's join finish.
pub fn accept_within_idle_window(listener: &UnixListener) -> Option<UnixStream> {
    listener
        .set_nonblocking(true)
        .expect("nonblocking mock listener");
    let idle_until = Instant::now() + Duration::from_millis(1500);
    loop {
        match listener.accept() {
            Ok((stream, _)) => return Some(stream),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if Instant::now() >= idle_until {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return None,
        }
    }
}

/// Serve one client connection until it hangs up: send the protocol-7 `daemon_hello` advertising
/// `capabilities`, then hand each request to `handle`. A request `handle` declines (returns
/// `false`) gets the generic `success: true, data: {}` reply.
pub fn serve_connection(
    stream: UnixStream,
    capabilities: &[&str],
    mut handle: impl FnMut(&mut UnixStream, Request<'_>) -> bool,
) {
    let mut writer = stream.try_clone().expect("clone mock socket");
    let mut reader = BufReader::new(stream);
    write_json(
        &mut writer,
        &json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": capabilities,
            "clientId": "mock",
        }),
    );
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
        let request = Request {
            id,
            kind: &command_type,
            command,
        };
        if !handle(&mut writer, request) {
            write_json(
                &mut writer,
                &json!({
                    "type": "response",
                    "id": id,
                    "command": command_type,
                    "success": true,
                    "data": {},
                }),
            );
        }
    }
}

/// The `create` reply for the new session `s1`.
pub fn create_response(id: &str) -> Value {
    json!({
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
    })
}

/// The `get_session_stats` reply: 1,200 of 200,000 context tokens used, one cent spent.
pub fn session_stats_response(id: &str) -> Value {
    json!({
        "type": "response",
        "id": id,
        "command": "get_session_stats",
        "success": true,
        "data": {
            "contextUsage": { "tokens": 1200, "contextWindow": 200_000 },
            "cost": 0.01,
        },
    })
}

/// The `detach` reply (no data).
pub fn detach_response(id: &str) -> Value {
    json!({
        "type": "response",
        "id": id,
        "command": "detach",
        "success": true,
    })
}

/// Run one headless chat `plan` against a mock daemon on a fresh socket, with the ambient `TMUX`
/// variable scrubbed (its startup notice must not reach the frames). `mock` binds the daemon on
/// the socket path and returns its serve loop, which runs on its own thread; the run waits for it.
pub fn run_headless<Serve>(
    plan: HeadlessPlan,
    options: impl FnOnce(PathBuf) -> InteractiveOptions,
    mock: impl FnOnce(&Path) -> Serve,
) -> InteractiveOutcome
where
    Serve: FnOnce() + Send + 'static,
{
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let handle = std::thread::spawn(mock(&socket));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    outcome
}
