//! Interrupt-path regressions (lane `interrupt-paths`): the Escape and
//! Ctrl+C interrupt ladders, and the aborted-run tool-card settle —
//! the client rows of docs/parity-next-wave.md §3, exercised through the
//! real interactive loop over an in-process mock daemon (the same JSONL
//! wire the tui_rss_stability harness speaks).
//!
//! The wire commands the interrupts emit are recorded by the mock and
//! asserted: the lane's contract is that an interrupt fires the TS abort
//! ladder (`abort` for the stream, `abort_retry`, `abort_compaction` +
//! `abort_branch_summary`, `abort_bash`, `abort_side_question`) — and
//! nothing else.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// The command frames the mock observed, in arrival order (normalized:
/// the command type only — the lane's primitive ladder).
type CommandLog = Arc<Mutex<Vec<String>>>;

/// One scripted stream writer (the mock's turn scripting callbacks).
type StreamWriter = Box<dyn Fn(&mut UnixStream) + Send + Sync>;

struct MockSupervisor {
    listener: UnixListener,
    commands: CommandLog,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path, commands: CommandLog) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            commands,
        }
    }

    /// Serve one connection: the loop's requests plus the scripted event
    /// stream. `on_prompt` writes the turn's events (each test scripts its
    /// own); the `abort` command's response is always success, and
    /// `end_aborted` (when given) writes the aborted end frames after it.
    fn serve(self, on_prompt: StreamWriter, on_abort: Option<StreamWriter>) {
        let (stream, _) = self.listener.accept().expect("accept");
        let write_stream = stream.try_clone().expect("clone mock socket");
        let mut writer = write_stream;
        let mut reader = BufReader::new(stream);

        let hello = json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": [],
            "clientId": "mock",
        });
        write_json(&mut writer, &hello);

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
            self.commands.lock().unwrap().push(command_type.clone());
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
                    let mut data = attach_data();
                    data["id"] = json!(id);
                    write_json(&mut writer, &data);
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
                                "contextUsage": { "tokens": 1200, "contextWindow": 200000 },
                                "cost": 0.01,
                            },
                        }),
                    );
                }
                "prompt" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "prompt",
                            "success": true,
                        }),
                    );
                    on_prompt(&mut writer);
                }
                "abort" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "abort",
                            "success": true,
                        }),
                    );
                    if let Some(on_abort) = &on_abort {
                        on_abort(&mut writer);
                    }
                }
                "detach" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "detach",
                            "success": true,
                        }),
                    );
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
}

fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

/// The slim attach snapshot shape (`createAttachResult`).
fn attach_data() -> Value {
    json!({
        "type": "response",
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
                    "sessionName": "interrupt session",
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

fn event(payload: Value) -> Value {
    json!({ "type": "session_event", "activeSessionId": "s1", "event": payload })
}

/// A turn that starts streaming a tool call and stays open (the run the
/// interrupt aborts).
fn stream_open_turn(writer: &mut UnixStream) {
    write_json(writer, &event(json!({ "type": "turn_start" })));
    write_json(
        writer,
        &event(json!({
            "type": "message_start",
            "message": { "role": "user", "content": "run the long check" },
        })),
    );
    write_json(
        writer,
        &event(json!({
            "type": "message_start",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "" }],
            },
            "assistantMessageEvent": { "type": "start" },
        })),
    );
    write_json(
        writer,
        &event(json!({
            "type": "message_update",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "Let me run the long check." },
                    { "type": "toolCall", "id": "tc-1", "name": "bash", "arguments": { "command": "sleep 30" } },
                ],
            },
            "assistantMessageEvent": { "type": "text_delta", "delta": "Let me run the long check." },
        })),
    );
    write_json(
        writer,
        &event(json!({
            "type": "tool_execution_start",
            "toolCallId": "tc-1",
            "toolName": "bash",
            "args": { "command": "sleep 30" },
        })),
    );
}

/// The aborted end frames the daemon streams after the abort lands (TS
/// `message_end` with `stopReason: "aborted"`, then the turn and agent
/// ends).
fn end_turn_aborted(writer: &mut UnixStream) {
    write_json(
        writer,
        &event(json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "stopReason": "aborted",
                "content": [
                    { "type": "text", "text": "Let me run the long check." },
                    { "type": "toolCall", "id": "tc-1", "name": "bash", "arguments": { "command": "sleep 30" } },
                ],
            },
        })),
    );
    write_json(writer, &event(json!({ "type": "turn_end" })));
    write_json(writer, &event(json!({ "type": "agent_end" })));
}

fn test_options(socket: &std::path::Path) -> InteractiveOptions {
    InteractiveOptions {
        socket_path: socket.to_path_buf(),
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
        prompt_stash: Default::default(),
        session_has_children: false,
        client_settings: None,
    }
}

/// Run one headless session against the mock: `steps` plus the harness's
/// trailing done marker. Returns the captured frames and the commands the
/// client emitted.
fn run_headless(
    socket: &std::path::Path,
    commands: CommandLog,
    steps: Vec<HeadlessStep>,
    on_prompt: StreamWriter,
    on_abort: Option<StreamWriter>,
) -> Vec<String> {
    let supervisor = MockSupervisor::bind(socket, commands);
    let plan = HeadlessPlan {
        steps,
        width: 100,
        height: 30,
    };
    let options = test_options(socket);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let handle = std::thread::spawn(move || supervisor.serve(on_prompt, on_abort));
    let (outcome_tx, outcome_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = runtime.block_on(run_interactive(options, UiMode::Headless(plan)));
        let _ = outcome_tx.send(result);
    });
    let outcome = outcome_rx
        .recv_timeout(Duration::from_secs(60))
        .expect("interactive run finished");
    let _ = handle.join();
    let outcome = outcome.expect("interactive run succeeded");
    outcome.frames
}

fn all_frames_text(frames: &[String]) -> String {
    frames.join("\n")
}

/// Escape during a streaming turn aborts it (TS `handleEscape` arms the
/// repeat and interrupts): the `abort` command goes out, the aborted end
/// settles the pending tool card, and no other ladder target fires.
#[test]
fn escape_interrupts_the_streaming_turn_and_settles_the_card() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let commands: CommandLog = Default::default();
    let steps = vec![
        HeadlessStep::Submit("run the long check".to_string()),
        // The turn must be live when the interrupt lands (turn_start +
        // the streamed frames apply first).
        HeadlessStep::WaitMs(300),
        HeadlessStep::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
        HeadlessStep::WaitIdle { timeout_ms: 10_000 },
    ];
    let frames = run_headless(
        &socket,
        Arc::clone(&commands),
        steps,
        Box::new(stream_open_turn),
        Some(Box::new(end_turn_aborted)),
    );
    let emitted = commands.lock().unwrap().clone();
    assert!(
        emitted.iter().any(|command| command == "abort"),
        "the escape interrupt must fire the turn abort, got: {emitted:?}"
    );
    // Nothing else was interruptible: only the stream target fires.
    let others = [
        "abort_compaction",
        "abort_branch_summary",
        "abort_retry",
        "abort_bash",
        "abort_side_question",
    ];
    for other in others {
        assert!(
            !emitted.iter().any(|command| command == other),
            "the idle-ladder interrupt fired {other}, got: {emitted:?}"
        );
    }
    let text = all_frames_text(&frames);
    assert!(
        text.contains("Operation aborted"),
        "the aborted assistant row/card must render the abort text, frames: {text}"
    );
    // TS `message_end` (aborted) appends the working elapsed:
    // "Operation aborted · 1s".
    assert!(
        text.contains("Operation aborted · "),
        "the aborted row must carry the elapsed suffix, frames: {text}"
    );
}

/// A message that ends aborted settles every pending tool card with the
/// error text, and the late `tool_execution_end` (the abort race) is
/// dropped: the card keeps the abort text, never the late output.
#[test]
fn aborted_message_end_settles_pending_cards_and_drops_the_late_result() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let commands: CommandLog = Default::default();

    let stream_and_abort = move |writer: &mut UnixStream| {
        stream_open_turn(writer);
        // The daemon reports the aborted end while the tool card is still
        // pending (TS `message_end`'s aborted arm), then the killed
        // tool's late result frame arrives after it.
        end_turn_aborted(writer);
        write_json(
            writer,
            &event(json!({
                "type": "tool_execution_end",
                "toolCallId": "tc-1",
                "result": {
                    "content": [{ "type": "text", "text": "late output after the abort" }]
                },
                "isError": false,
            })),
        );
    };
    let steps = vec![
        HeadlessStep::Submit("run the long check".to_string()),
        HeadlessStep::WaitIdle { timeout_ms: 10_000 },
        HeadlessStep::WaitMs(300),
    ];
    let frames = run_headless(
        &socket,
        Arc::clone(&commands),
        steps,
        Box::new(stream_and_abort),
        None,
    );
    let text = all_frames_text(&frames);
    assert!(
        text.contains("Operation aborted"),
        "the pending tool card must settle with the abort text, frames: {text}"
    );
    assert!(
        !text.contains("late output after the abort"),
        "the late tool result after the abort must be dropped, frames: {text}"
    );
}

/// The Ctrl+C interrupt ladder fires the same abort; a second Ctrl+C
/// inside the exit-hint window leaves the run (TS `handleCtrlC`).
#[test]
fn ctrl_c_interrupts_then_the_second_press_exits() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let commands: CommandLog = Default::default();
    let steps = vec![
        HeadlessStep::Submit("run the long check".to_string()),
        HeadlessStep::WaitMs(300),
        HeadlessStep::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
    ];
    let frames = run_headless(
        &socket,
        Arc::clone(&commands),
        steps,
        Box::new(stream_open_turn),
        Some(Box::new(end_turn_aborted)),
    );
    let emitted = commands.lock().unwrap().clone();
    assert!(
        emitted.iter().any(|command| command == "abort"),
        "the first Ctrl+C must fire the turn abort, got: {emitted:?}"
    );
    let text = all_frames_text(&frames);
    assert!(
        text.contains("again to exit"),
        "the first Ctrl+C must show the exit hint, frames: {text}"
    );
    // The second press exited the run (the headless harness returned; the
    // detach the teardown sends is the mock's last observed command).
    assert!(
        emitted.iter().any(|command| command == "detach"),
        "the second Ctrl+C must leave the run (detach in the teardown), got: {emitted:?}"
    );
}
