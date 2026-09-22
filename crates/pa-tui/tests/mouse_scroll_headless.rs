//! Headless e2e for the mouse-wheel scroll surface: a mock supervisor
//! serves one attached session with a long snapshot transcript, and the
//! headless harness feeds byte-identical SGR mouse sequences through the
//! same decode-and-dispatch path the terminal's wheel reports take.
//!
//! Verifies the TS parity contract of `tui.ts`'s `handleFullscreenInput`
//! wheel branch: wheel up/down scroll the transcript window three lines
//! per turn, the wheel is consumed without scrolling while a picker owns
//! the frame, and no scroll happens when the `terminal.fullscreenMouse`
//! setting disabled tracking (reports consumed either way).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

/// Mouse tracking is process-global state, so the headless runs serialize
/// (each asserts on the tracking-active branch it drives).
static RUN_LOCK: Mutex<()> = Mutex::new(());

fn run_lock() -> MutexGuard<'static, ()> {
    match RUN_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// The SGR wheel-up / wheel-down press reports a real terminal sends.
const WHEEL_UP: &str = "\x1b[<64;10;10M";
const WHEEL_DOWN: &str = "\x1b[<65;10;10M";

struct MockSupervisor {
    listener: UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// Serve one connection: attach a session whose snapshot holds a long
    /// transcript, then answer the loop's requests.
    fn serve(self) {
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

/// The slim attach result with a 40-message transcript: alternating user
/// and assistant messages, each one short row, so the transcript is far
/// taller than the 30-row frame.
fn attach_data(id: &str) -> Value {
    let messages: Vec<Value> = (0..40)
        .map(|index| {
            if index % 2 == 0 {
                json!({ "role": "user", "content": [{ "type": "text", "text": format!("row {index}") }] })
            } else {
                json!({
                    "role": "assistant",
                    "content": [{ "type": "text", "text": format!("answer {index}") }],
                })
            }
        })
        .collect();
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
                    "sessionName": "mouse session",
                    "model": null,
                    "isStreaming": false,
                    "isCompacting": false,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                },
                "messages": messages,
                "lastEventSequence": 0,
                "lastEventCursor": null,
            },
            "client": { "id": "mock", "capabilities": [] },
            "lastEventSequence": 0,
            "lastEventCursor": null,
        },
    })
}

fn options(socket: PathBuf, fullscreen_mouse: bool) -> InteractiveOptions {
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
        fullscreen_mouse,
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

/// Run the headless plan against a fresh mock supervisor and return the
/// captured frames. Holds the run lock: mouse tracking is process-global.
fn run_plan(steps: Vec<HeadlessStep>, fullscreen_mouse: bool) -> Vec<String> {
    let _guard = run_lock();
    // The ambient TMUX variable makes the startup check add its extended-keys
    // notice to the transcript, which shifts the paused-frame geometry the
    // assertions below reason about; scrub it so the run is the same inside
    // tmux (a dev box) and out (the gate sandbox).
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket);
    let handle = std::thread::spawn(move || supervisor.serve());

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps,
        width: 100,
        height: 30,
    };
    let outcome = runtime
        .block_on(run_interactive(
            options(socket, fullscreen_mouse),
            UiMode::Headless(plan),
        ))
        .expect("interactive run");
    let _ = handle.join();
    outcome.frames
}

/// Wheel turns scroll the transcript: up pauses tail-following (the frame
/// shows the follow hint) and scrolls far enough to drop the newest
/// message from the window; wheel-down turns scroll back and reaching the
/// bottom resumes following.
#[test]
fn wheel_turns_scroll_the_transcript() {
    let steps = vec![
        // One wheel-up turn: three lines up — the tail pauses.
        HeadlessStep::Mouse(WHEEL_UP.to_string()),
        // Enough further turns to scroll the newest messages out of the
        // window (each user/assistant pair renders several rows): eighteen
        // lines up clears the bottom rows of the tail.
        HeadlessStep::Mouse(WHEEL_UP.to_string()),
        HeadlessStep::Mouse(WHEEL_UP.to_string()),
        HeadlessStep::Mouse(WHEEL_UP.to_string()),
        HeadlessStep::Mouse(WHEEL_UP.to_string()),
        HeadlessStep::Mouse(WHEEL_UP.to_string()),
        // Wheel-down turns scroll back: the window returns to the tail and
        // following resumes (extra turns clamp at the bottom).
        HeadlessStep::Mouse(WHEEL_DOWN.to_string()),
        HeadlessStep::Mouse(WHEEL_DOWN.to_string()),
        HeadlessStep::Mouse(WHEEL_DOWN.to_string()),
        HeadlessStep::Mouse(WHEEL_DOWN.to_string()),
        HeadlessStep::Mouse(WHEEL_DOWN.to_string()),
        HeadlessStep::Mouse(WHEEL_DOWN.to_string()),
        HeadlessStep::Mouse(WHEEL_DOWN.to_string()),
    ];
    let frames = run_plan(steps, true);
    assert!(!frames.is_empty(), "frames were captured");
    let all = frames.join("\n");
    assert!(
        all.contains("answer 39"),
        "the snapshot transcript's tail rendered:\n{all}"
    );
    assert!(
        all.contains("to follow"),
        "wheel-up paused tail-following (the follow hint rendered):\n{all}"
    );
    // Scrolling up moved the window: the deepest paused frame (all six
    // wheel-up turns applied) dropped the newest rows from the window,
    // and scrolling back down restored them.
    let paused = frames
        .iter()
        .rfind(|frame| frame.contains("to follow"))
        .expect("a paused frame");
    assert!(
        !paused.contains("answer 39"),
        "the scrolled-up window dropped the newest rows:\n{paused}"
    );
    let tail = frames
        .iter()
        .rfind(|frame| !frame.contains("to follow") && frame.contains("row 38"))
        .expect("a resumed tail frame");
    assert!(
        tail.contains("row 38"),
        "wheel-down returned the window to the tail:\n{tail}"
    );
}

/// The wheel is consumed without scrolling while the `/model` picker owns
/// the frame (the TS overlay-focus gate).
#[test]
fn wheel_is_ignored_while_a_picker_owns_the_frame() {
    let steps = vec![
        HeadlessStep::Submit("/model".to_string()),
        HeadlessStep::Mouse(WHEEL_UP.to_string()),
        HeadlessStep::Mouse(WHEEL_UP.to_string()),
        HeadlessStep::Mouse(WHEEL_UP.to_string()),
        HeadlessStep::Key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Esc,
            crossterm::event::KeyModifiers::NONE,
        )),
    ];
    let frames = run_plan(steps, true);
    let all = frames.join("\n");
    assert!(
        all.contains("row 38"),
        "the transcript tail stayed mounted through the picker cycle:\n{all}"
    );
    // The picker cycled without any paused frame: every frame that shows
    // the transcript still sits at the tail.
    assert!(
        !all.contains("to follow"),
        "the wheel never scrolled behind the picker:\n{all}"
    );
    let tail = frames.last().expect("a frame after the picker closed");
    assert!(
        tail.contains("row 38"),
        "the post-picker frame is the unscrolled tail:\n{tail}"
    );
}

/// With the `terminal.fullscreenMouse` setting off, tracking never enables
/// and wheel reports are consumed without scrolling.
#[test]
fn wheel_reports_are_consumed_when_tracking_is_disabled() {
    let steps = vec![
        HeadlessStep::Mouse(WHEEL_UP.to_string()),
        HeadlessStep::Mouse(WHEEL_UP.to_string()),
        HeadlessStep::Mouse(WHEEL_UP.to_string()),
    ];
    let frames = run_plan(steps, false);
    let all = frames.join("\n");
    assert!(
        !all.contains("to follow"),
        "no scroll with tracking disabled:\n{all}"
    );
    let tail = frames.last().expect("a frame");
    assert!(
        tail.contains("row 38"),
        "the tail frame stayed at the bottom:\n{tail}"
    );
}
