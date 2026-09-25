//! Headless e2e for the non-update daemon-restart reconnect (TS #2458
//! `reconnectAfterShutdown` + `formatDaemonReconnectBanner`): a daemon
//! close WITHOUT the update payload (`prime-agent shutdown`, a stale
//! daemon's replacement) recovers the attached window — the pane
//! reconnects through the daemon's absence window, re-attaches the same
//! durable session under the restarted daemon's fresh active id, resyncs
//! the transcript, and reports the restarted daemon's version — instead
//! of dying with loss-y rows.
//!
//! The mock daemon models the restart on one socket path exactly: the
//! successor binds the SAME path only after the old daemon's listener is
//! gone (a mid-absence connect is refused), and the stop-pass variant
//! keeps the old daemon greeting while its shutdown gate refuses every
//! command (`Supervisor is shutting down`) — the early-arm's convergence
//! case (the recovery starts at the relayed close, before the socket
//! dies).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{Shutdown, UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// The answer text the first (pre-restart) turn streams.
const FIRST_ANSWER: &str = "the answer before the restart";
/// The answer text the successor daemon streams for the post-restart turn.
const SECOND_ANSWER: &str = "the restarted answer";
/// The pane's own version (the headless options' product version): a
/// successor reporting a higher `appVersion` exercises the
/// version-honest warning banner.
const CLIENT_VERSION: &str = "0.0.0";
const SUCCESSOR_APP_VERSION: &str = "9.9.9";

/// The restart shapes the mock daemon serves.
#[derive(Clone, Copy)]
enum RestartMode {
    /// The daemon closes at once (a `prime-agent shutdown` at idle): the
    /// socket refuses connections for `absence_ms`, then the successor
    /// binds the same path.
    Immediate { absence_ms: u64 },
    /// The daemon lives through its stop pass: new connections are
    /// greeted but every command is refused (`Supervisor is shutting
    /// down`) for `refusal_ms` while the pane's original connection
    /// stays open, then the daemon exits and the successor binds.
    StopPass { refusal_ms: u64, absence_ms: u64 },
}

impl RestartMode {
    fn absence(&self) -> Duration {
        match self {
            Self::Immediate { absence_ms } | Self::StopPass { absence_ms, .. } => {
                Duration::from_millis(*absence_ms)
            }
        }
    }
}

/// The daemon generations the mock moves through.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Generation 0: the pane's first connection is served.
    Initial,
    /// The shutdown frames landed: generation 0's stop pass — it greets
    /// and refuses; the original connection stays open.
    Stopping,
    /// The old daemon exited: the socket path refuses connections.
    Exited,
    /// The successor daemon (generation 1) serves the same socket path.
    Successor,
}

struct MockDaemon {
    socket_path: PathBuf,
    mode: RestartMode,
    /// The relayed `session_closed` reason: an orderly stop relays
    /// "shutdown"; the TS test matrix also covers "killed" (a stop pass
    /// that archive-stops workers).
    relay_reason: &'static str,
    /// (generation, payload) of every `prompt` request, in dispatch
    /// order — the recovery proof: the second prompt is served by the
    /// successor.
    prompt_requests: Arc<Mutex<Vec<(u32, Value)>>>,
    phase: Arc<Mutex<Phase>>,
    /// The live connections' streams: the old daemon's exit closes them
    /// (the pane's reader observes the EOF).
    streams: Arc<Mutex<Vec<UnixStream>>>,
}

impl MockDaemon {
    fn bind(socket: &std::path::Path, mode: RestartMode, relay_reason: &'static str) -> Self {
        MockDaemon {
            socket_path: socket.to_path_buf(),
            mode,
            relay_reason,
            prompt_requests: Arc::new(Mutex::new(Vec::new())),
            phase: Arc::new(Mutex::new(Phase::Initial)),
            streams: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// The daemon lifecycle: accept connections per phase, run the
    /// stop-pass/absence transitions, and serve the successor. Bounded by
    /// the overall bail so the harness join always finishes.
    fn serve(self) {
        let mut listener = Some(bind_nonblocking(&self.socket_path));
        let refusal = match self.mode {
            RestartMode::StopPass { refusal_ms, .. } => Duration::from_millis(refusal_ms),
            RestartMode::Immediate { .. } => Duration::from_millis(0),
        };
        let absence = self.mode.absence();
        let mut stop_started: Option<Instant> = None;
        let mut exit_started: Option<Instant> = None;
        let bail = Instant::now() + Duration::from_secs(30);
        loop {
            if Instant::now() > bail {
                return;
            }
            let phase = *self.phase.lock().unwrap();
            match phase {
                Phase::Initial | Phase::Successor => {
                    let generation = u32::from(phase == Phase::Successor);
                    if let Some((stream, _)) = accept(listener.as_ref()) {
                        self.serve_connection(stream, generation);
                    }
                }
                Phase::Stopping => {
                    let started = *stop_started.get_or_insert_with(Instant::now);
                    if started + refusal <= Instant::now() {
                        // The old daemon exits: every live connection
                        // closes (the pane's EOF) and the listener goes
                        // away (mid-absence connects are refused).
                        let mut streams = self.streams.lock().unwrap();
                        for stream in streams.drain(..) {
                            let _ = stream.shutdown(Shutdown::Both);
                        }
                        drop(listener.take());
                        *self.phase.lock().unwrap() = Phase::Exited;
                        continue;
                    }
                    if let Some((stream, _)) = accept(listener.as_ref()) {
                        self.serve_refusing(stream);
                    }
                }
                Phase::Exited => {
                    let started = *exit_started.get_or_insert_with(Instant::now);
                    if started + absence <= Instant::now() {
                        listener = Some(bind_nonblocking(&self.socket_path));
                        *self.phase.lock().unwrap() = Phase::Successor;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Serve one full daemon connection in its own thread (generation 0
    /// pre-restart, generation 1 the successor).
    fn serve_connection(&self, stream: UnixStream, generation: u32) {
        let immediate = matches!(self.mode, RestartMode::Immediate { .. });
        // The stop-pass exit closes the live connections from the serve
        // loop: only a daemon that stays up registers them (an immediate
        // exit drops its own stream with the thread).
        if generation == 0 && !immediate {
            self.streams
                .lock()
                .unwrap()
                .push(stream.try_clone().expect("clone the pane's stream"));
        }
        let reader_stream = stream;
        let writer = stream.try_clone().expect("clone the write half");
        let phase = Arc::clone(&self.phase);
        let prompt_requests = Arc::clone(&self.prompt_requests);
        let relay_reason = self.relay_reason;
        std::thread::spawn(move || {
            let mut reader = BufReader::new(reader_stream);
            handle_connection(
                &mut reader,
                writer,
                generation,
                relay_reason,
                immediate,
                &phase,
                &prompt_requests,
            );
        });
    }

    /// One stop-pass connection in its own thread: the old daemon greets,
    /// the shutdown gate refuses every command.
    fn serve_refusing(&self, stream: UnixStream) {
        let reader_stream = stream;
        let writer = stream.try_clone().expect("clone the refusing write half");
        std::thread::spawn(move || {
            let mut reader = BufReader::new(reader_stream);
            handle_refusing(&mut reader, writer);
        });
    }
}

/// Bind the socket and arm the nonblocking accept.
fn bind_nonblocking(socket: &std::path::Path) -> UnixListener {
    let listener = UnixListener::bind(socket).expect("bind the mock daemon");
    listener
        .set_nonblocking(true)
        .expect("nonblocking listener");
    listener
}

/// Poll one accept against the phase's listener.
fn accept(listener: Option<&UnixListener>) -> Option<(UnixStream, &UnixListener)> {
    let listener = listener?;
    match listener.accept() {
        Ok((stream, _)) => {
            let _ = stream.set_nonblocking(false);
            Some((stream, listener))
        }
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => None,
        Err(_) => None,
    }
}

/// The full generation handler: hello, create, attach, stats, prompt turns
/// — and generation 0's shutdown sequence after the first prompt (the
/// closing notice, the relayed session close, then the connection close
/// for an immediate exit, or the retained stop-pass idle).
fn handle_connection(
    reader: &mut BufReader<UnixStream>,
    mut writer: UnixStream,
    generation: u32,
    relay_reason: &str,
    immediate: bool,
    phase: &Mutex<Phase>,
    prompt_requests: &Mutex<Vec<(u32, Value)>>,
) {
    let mut hello = json!({
        "type": "daemon_hello",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "serverCapabilities": [],
        "clientId": "mock",
    });
    if generation == 1 {
        hello["appVersion"] = json!(SUCCESSOR_APP_VERSION);
    }
    write_json(&mut writer, &hello);

    let active_session_id = if generation == 0 { "s1" } else { "s2" };
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
                let messages = if generation == 0 {
                    Vec::new()
                } else {
                    pre_restart_messages()
                };
                write_json(&mut writer, &attach_data(id, active_session_id, &messages));
            }
            "get_session_stats" => {
                write_json(
                    &mut writer,
                    &json!({
                        "type": "response",
                        "id": id,
                        "command": "get_session_stats",
                        "success": true,
                        "data": {
                            "contextUsage": { "tokens": 1200, "contextWindow": 200_000 },
                            "cost": 0.01,
                        },
                    }),
                );
            }
            "prompt" => {
                prompt_requests
                    .lock()
                    .unwrap()
                    .push((generation, command.clone()));
                write_json(
                    &mut writer,
                    &json!({
                        "type": "response",
                        "id": id,
                        "command": "prompt",
                        "success": true,
                    }),
                );
                let answer = if generation == 0 {
                    FIRST_ANSWER
                } else {
                    SECOND_ANSWER
                };
                let question = command
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                write_session_event(
                    &mut writer,
                    active_session_id,
                    &json!({ "type": "turn_start" }),
                );
                write_session_event(
                    &mut writer,
                    active_session_id,
                    &json!({
                        "type": "message_start",
                        "message": { "role": "user", "content": question },
                    }),
                );
                write_session_event(
                    &mut writer,
                    active_session_id,
                    &json!({
                        "type": "message_start",
                        "message": {
                            "role": "assistant",
                            "content": [{ "type": "text", "text": "" }],
                        },
                        "assistantMessageEvent": { "type": "start" },
                    }),
                );
                write_session_event(
                    &mut writer,
                    active_session_id,
                    &json!({
                        "type": "message_update",
                        "message": {
                            "role": "assistant",
                            "content": [{ "type": "text", "text": answer }],
                        },
                        "assistantMessageEvent": { "type": "text_delta", "delta": answer },
                    }),
                );
                write_session_event(
                    &mut writer,
                    active_session_id,
                    &json!({
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "stopReason": "stop",
                            "content": [{ "type": "text", "text": answer }],
                        },
                    }),
                );
                write_session_event(
                    &mut writer,
                    active_session_id,
                    &json!({ "type": "turn_end" }),
                );
                if generation == 0 {
                    // The daemon shutdown: the closing notice (no update
                    // payload — this is the non-update restart), then the
                    // stop pass's relayed session close, then the exit.
                    write_json(
                        &mut writer,
                        &json!({ "type": "daemon_closing", "reason": "shutdown" }),
                    );
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "session_closed",
                            "activeSessionId": "s1",
                            "reason": relay_reason,
                        }),
                    );
                    if immediate {
                        // The process exits at once: the connection
                        // closes here; the loop's Exited phase drops the
                        // listener for the absence window.
                        *phase.lock().unwrap() = Phase::Exited;
                        return;
                    }
                    *phase.lock().unwrap() = Phase::Stopping;
                    // The stop pass keeps the connection open: stay idle
                    // until the exit's shutdown closes it.
                }
            }
            _ => {
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
}

/// The stop-pass handler: the shutdown gate refuses every command.
fn handle_refusing(reader: &mut BufReader<UnixStream>, mut writer: UnixStream) {
    write_json(
        &mut writer,
        &json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": [],
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
        write_json(
            &mut writer,
            &json!({
                "type": "response",
                "id": id,
                "command": command_type,
                "success": false,
                "error": "Supervisor is shutting down",
            }),
        );
        return;
    }
}

/// The successor's attach answer: the SAME durable session (`sess-1`)
/// under the restarted daemon's fresh active id, with the durable
/// transcript the successor re-opened from disk.
fn attach_data(id: &str, active_session_id: &str, messages: &[Value]) -> Value {
    json!({
        "type": "response",
        "id": id,
        "command": "attach",
        "success": true,
        "data": {
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "activeSessionId": active_session_id,
            "snapshot": {
                "activeSessionId": active_session_id,
                "summary": { "id": active_session_id, "cwd": "/tmp" },
                "state": {
                    "activeSessionId": active_session_id,
                    "cwd": "/tmp",
                    "sessionId": "sess-1",
                    "sessionName": "restart session",
                    "model": null,
                    "isStreaming": false,
                    "isCompacting": false,
                    "sessionFile": "/tmp/sess-1.jsonl",
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                },
                "messages": messages,
                "lastEventSequence": 6,
                "lastEventCursor": null,
            },
            "client": { "id": "mock", "capabilities": [] },
            "lastEventSequence": 6,
            "lastEventCursor": null,
        },
    })
}

/// The durable transcript the successor daemon re-opened: the
/// pre-restart turn, persisted in the session file.
fn pre_restart_messages() -> Vec<Value> {
    vec![
        json!({
            "role": "user",
            "content": [{ "type": "text", "text": "before the restart" }],
            "timestamp": 1,
        }),
        json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": FIRST_ANSWER }],
            "stopReason": "stop",
            "timestamp": 2,
        }),
    ]
}

fn write_session_event(writer: &mut UnixStream, active_session_id: &str, event: &Value) {
    write_json(
        writer,
        &json!({
            "type": "session_event",
            "activeSessionId": active_session_id,
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

/// The run outcome the recovery assertions need.
#[derive(Debug)]
struct RunOutcome {
    frames: Vec<String>,
    prompts: Vec<(u32, Value)>,
}

/// Run the headless plan against a mock daemon that restarts without an
/// update after the first prompt.
fn run_restart_plan(
    steps: Vec<HeadlessStep>,
    mode: RestartMode,
    relay_reason: &'static str,
) -> RunOutcome {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockDaemon::bind(&socket, mode, relay_reason);
    let prompt_requests = Arc::clone(&supervisor.prompt_requests);
    let handle = std::thread::spawn(move || supervisor.serve());

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps,
        width: 100,
        height: 40,
    };
    let options = options(socket);
    let outcome = runtime
        .block_on(run_interactive(options, UiMode::Headless(plan)))
        .expect("the interactive run stays mounted through the restart");
    let _ = handle.join();
    RunOutcome {
        frames: outcome.frames,
        prompts: Arc::try_unwrap(prompt_requests)
            .map(|locked| locked.into_inner().unwrap())
            .unwrap_or_else(|locked| locked.lock().unwrap().clone()),
    }
}

fn options(socket: PathBuf) -> InteractiveOptions {
    InteractiveOptions {
        socket_path: socket,
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        script_path: None,
        model_selection: ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: Default::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: SessionSelection::New,
        initial_message: None,
        show_images: true,
        fullscreen_mouse: false,
        theme: "prime".to_string(),
        code_block_indent: "  ".to_string(),
        tree_filter_mode: String::new(),
        branch_summary_skip_prompt: false,
        version: CLIENT_VERSION.to_string(),
        onboarding: None,
        telemetry_disabled: None,
        client_auth: None,
        traces: None,
        provider_auth: None,
        update_commands: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        prompt_stash: Default::default(),
        session_has_children: false,
        client_settings: None,
    }
}

/// The TS #2458 contract: a daemon close WITHOUT an update payload
/// recovers the attached window. The pane shows the reconnecting state
/// (not loss-y "session closed"/"shutting down" rows), reconnects through
/// the absence window, re-attaches the same durable session under the
/// successor's fresh active id, resyncs the durable transcript, reports
/// the restarted daemon's version honestly, and keeps dispatching — the
/// second prompt is served by the successor.
#[test]
fn shutdown_close_without_update_reconnects_to_the_restarted_daemon() {
    let steps = vec![
        HeadlessStep::Type("before the restart".to_string()),
        HeadlessStep::Key(enter()),
        // The first turn streams; the daemon then closes without an
        // update and stays gone for a moment (the absence window).
        HeadlessStep::WaitMs(400),
        // The reconnect driver's first attempt (~1s after the relay) plus
        // the reattach lands well inside this window.
        HeadlessStep::WaitMs(3000),
        HeadlessStep::Type("after the restart".to_string()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitMs(500),
    ];
    let run = run_restart_plan(
        steps,
        RestartMode::Immediate { absence_ms: 300 },
        "shutdown",
    );
    let all = run.frames.join("\n");
    let flat = all.split_whitespace().collect::<Vec<_>>().join(" ");
    // The relayed close never renders as a session stop, and the closing
    // notice is silent (TS `daemonClosingNotice` + `daemonShutdownClose`).
    assert!(
        !flat.contains("session closed"),
        "the daemon-shutdown relay is not a session-stop row:\n{all}"
    );
    assert!(
        !flat.contains("the daemon is shutting down"),
        "the closing notice is silent:\n{all}"
    );
    // The reconnecting row lands with the relay (TS
    // `connection_status: "reconnecting"`).
    assert!(
        flat.contains("Daemon connection lost; reconnecting…"),
        "the reconnecting state rendered:\n{all}"
    );
    // The connected banner is version-honest: the restarted daemon is
    // NEWER than this window's binary (TS
    // `formatDaemonReconnectBanner`'s warning arm).
    assert!(
        flat.contains(
            "Daemon restarted (v9.9.9), this window still runs v0.0.0 - restart the window to pick up the update."
        ),
        "the version-honest banner rendered:\n{all}"
    );
    assert!(
        !flat.contains("reconnected to the daemon"),
        "the shutdown recovery reports the daemon's version, not the plain note:\n{all}"
    );
    // The resync carried the durable transcript (the successor re-opened
    // the session file).
    assert!(
        flat.contains(FIRST_ANSWER),
        "the pre-restart turn survived the resync:\n{all}"
    );
    // The recovery delivered the next dispatch to the successor.
    assert_eq!(
        run.prompts.len(),
        2,
        "both prompts dispatched: {:#?}",
        run.prompts
    );
    assert_eq!(run.prompts[0].0, 0, "the first prompt hit generation 0");
    assert_eq!(run.prompts[1].0, 1, "the second prompt hit the successor");
    assert_eq!(
        run.prompts[1].1.get("message").and_then(Value::as_str),
        Some("after the restart"),
        "the post-restart dispatch rode the recovered connection"
    );
    // The post-restart turn streamed through the successor.
    assert!(
        flat.contains(SECOND_ANSWER),
        "the successor's turn rendered:\n{all}"
    );
}

/// The relayed close of a stop pass reads "killed" (an orderly shutdown
/// archive-stops its workers): the notice, not the close reason,
/// separates the daemon's shutdown from a bare session stop, so the
/// recovery owns the window exactly the same way.
#[test]
fn announced_shutdown_with_killed_relay_also_recovers() {
    let steps = vec![
        HeadlessStep::Type("before the restart".to_string()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitMs(400),
        HeadlessStep::WaitMs(3000),
        HeadlessStep::Type("after the restart".to_string()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitMs(500),
    ];
    let run = run_restart_plan(steps, RestartMode::Immediate { absence_ms: 300 }, "killed");
    let all = run.frames.join("\n");
    let flat = all.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(
        !flat.contains("session closed"),
        "the 'killed' relay after the notice is not a session-stop row:\n{all}"
    );
    assert!(
        flat.contains("Daemon connection lost; reconnecting…"),
        "the reconnecting state rendered:\n{all}"
    );
    assert!(
        flat.contains("Daemon restarted (v9.9.9)"),
        "the version-honest banner rendered:\n{all}"
    );
    assert_eq!(
        run.prompts.len(),
        2,
        "both prompts dispatched: {:#?}",
        run.prompts
    );
    assert_eq!(run.prompts[1].0, 1, "the second prompt hit the successor");
}

/// The recovery starts at the relayed close, BEFORE the socket dies: the
/// daemon's stop pass keeps greeting while its shutdown gate refuses
/// every command (`Supervisor is shutting down`), so the first reattach
/// is refused, the retry note lands, and the window converges once the
/// successor binds — no terminal close, no lost dispatch.
#[test]
fn shutdown_stop_pass_refusals_retry_through_to_the_successor() {
    let steps = vec![
        HeadlessStep::Type("before the restart".to_string()),
        HeadlessStep::Key(enter()),
        // The first turn streams; the daemon enters its stop pass (the
        // gate refuses the early reattach attempt).
        HeadlessStep::WaitMs(400),
        // ~1.5s of stop pass + the absence + the driver's backoff: the
        // refused attempt's retry and the successor's reattach.
        HeadlessStep::WaitMs(6500),
        HeadlessStep::Type("after the restart".to_string()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitMs(500),
    ];
    let run = run_restart_plan(
        steps,
        RestartMode::StopPass {
            refusal_ms: 1500,
            absence_ms: 200,
        },
        "shutdown",
    );
    let all = run.frames.join("\n");
    let flat = all.split_whitespace().collect::<Vec<_>>().join(" ");
    // The refused early attempt surfaced as the retry note (the
    // unexpected-loss recovery keeps retrying — the pane never dies).
    assert!(
        flat.contains("reattach failed") && flat.contains("retrying"),
        "the stop-pass refusal surfaced as a retry, not a close:\n{all}"
    );
    assert!(
        flat.contains("Supervisor is shutting down") || flat.contains("Supervisor is shutting"),
        "the gate's refusal text surfaced in the retry note:\n{all}"
    );
    assert!(
        !flat.contains("session closed"),
        "the relay is not a session-stop row:\n{all}"
    );
    // The convergence: the banner and the successor-served dispatch.
    assert!(
        flat.contains("Daemon restarted (v9.9.9)"),
        "the version-honest banner rendered after the refusals:\n{all}"
    );
    assert_eq!(
        run.prompts.len(),
        2,
        "both prompts dispatched: {:#?}",
        run.prompts
    );
    assert_eq!(run.prompts[1].0, 1, "the second prompt hit the successor");
    assert!(
        flat.contains(SECOND_ANSWER),
        "the successor's turn rendered:\n{all}"
    );
}

/// One Enter key event.
fn enter() -> crossterm::event::KeyEvent {
    crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Enter,
        crossterm::event::KeyModifiers::NONE,
    )
}
