//! Headless e2e for the prompt's Down into the activity dock (the tray
//! row under the editor), the operator's 2026-10-01 consistency ruling:
//! Down at the end of the prompt ALWAYS hands the focus to the dock — the
//! all-zero dock and a dock with only shells running included —
//! Left/Right walk its groups, Enter opens the focused group's view even
//! when it is empty, and Up/Esc return to the prompt. Before the fix the
//! Down only took the dock while subagents existed, so with zero
//! subagents every group below the prompt was out of the arrows' reach.
#![cfg(unix)]
// Pedantic-gate exceptions (every other pedantic warning in this crate is
// fixed in place; each exception carries its one-line justification):
// - the casts: terminal-layout arithmetic narrows structurally bounded
//   values (screen coordinates, byte counts, timestamps); guarded
//   conversions would add panic paths the bounds guarantee away.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// - the render routes are flat tables (one arm per route); splitting them
//   would add indirection without changing the flow.
#![allow(clippy::too_many_lines)]
// - widget state structs carry independent flag bits; a nested struct
//   would add indirection without changing the shape.
#![allow(clippy::struct_excessive_bools, clippy::fn_params_excessive_bools)]
// - the futures are bounded by the surface's lifetime; boxing them would
//   add an allocation to the steady-state loop.
#![allow(clippy::large_futures)]
// - the wrappers preserve a uniform Result-returning API surface; unwrap
//   removals would ripple through the callers without changing behavior.
#![allow(clippy::unnecessary_wraps)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

struct MockSupervisor {
    listener: UnixListener,
    /// Serve one running shell from `list_kernel_bash` (`false` serves
    /// the empty registry — the all-zero dock).
    shell_running: bool,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path, shell_running: bool) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            shell_running,
        }
    }

    /// Serve one client connection until it goes quiet (bounded, so the
    /// plan teardown join always finishes).
    fn serve(self) {
        self.listener
            .set_nonblocking(true)
            .expect("nonblocking mock listener");
        let idle_window = std::time::Duration::from_millis(1500);
        let idle_until = std::time::Instant::now() + idle_window;
        let (stream, _) = loop {
            match self.listener.accept() {
                Ok(accepted) => break accepted,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() >= idle_until {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(_) => return,
            }
        };
        let mut writer = stream.try_clone().expect("clone mock socket");
        let mut reader = BufReader::new(stream);

        let hello = json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": ["kernel_bash_activity"],
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
                "list_kernel_bash" => {
                    let activities = if self.shell_running {
                        json!([
                            {"id": "shell-1", "command": "render the frames", "pid": 4242, "status": "running"},
                        ])
                    } else {
                        json!([])
                    };
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "list_kernel_bash",
                            "success": true,
                            "data": { "activities": activities },
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
                    "sessionName": "tray session",
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

fn options(socket: PathBuf) -> InteractiveOptions {
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
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        restore_dock_focus: false,
        client_settings: None,
    }
}

/// One Down key event (the prompt's hand-off into the dock).
fn down() -> KeyEvent {
    KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)
}

/// One Up key event (the focused dock's return to the prompt).
fn up() -> KeyEvent {
    KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)
}

/// One right-arrow key event (the dock's next-section step).
fn right() -> KeyEvent {
    KeyEvent::new(KeyCode::Right, KeyModifiers::NONE)
}

/// One plain Enter key event (the focused section's open).
fn enter() -> KeyEvent {
    KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
}

/// One Esc key event (`tui.select.cancel`: the open view closes and the
/// focus returns to the editor).
fn escape() -> KeyEvent {
    KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)
}

/// Run the headless plan against a fresh mock supervisor and return the
/// captured frames.
fn run_plan(
    steps: Vec<HeadlessStep>,
    shell_running: bool,
) -> pa_tui::interactive::InteractiveOutcome {
    // The ambient TMUX variable adds a startup notice to the transcript;
    // scrub it so the run is the same inside tmux and out.
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket, shell_running);
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
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    outcome
}

/// The all-zero dock row.
const ALL_ZERO_DOCK: &str =
    " \u{25c6} 0 subagents  \u{b7}  \u{25f7} 0 heartbeats  \u{b7}  \u{25b8} 0 shells";

/// Bug 1: with zero subagents (every count zero), the prompt's Down
/// enters the dock on its subagents group, and Enter opens the scoped
/// agents view — whose empty roster is the view's own empty state.
#[test]
fn prompt_down_enters_the_all_zero_dock_and_enter_opens_subagents() {
    let steps = vec![
        HeadlessStep::WaitRender {
            needle: ALL_ZERO_DOCK.to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(down()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitMs(300),
    ];
    let outcome = run_plan(steps, false);
    assert!(
        outcome.return_to_agents_view,
        "Down then Enter opened the scoped agents view:\n{}",
        outcome.frames.join("\n")
    );
}

/// Every empty group stays reachable from the prompt's Down: Right walks
/// to the empty heartbeats and shells groups, and Enter opens each view's
/// empty state.
#[test]
fn prompt_down_reaches_every_empty_group() {
    let steps = vec![
        HeadlessStep::WaitRender {
            needle: ALL_ZERO_DOCK.to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(down()),
        HeadlessStep::Key(right()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "No running or paused heartbeats".to_string(),
            timeout_ms: 5_000,
        },
        // The panel's exit lands back on its own dock item.
        HeadlessStep::Key(escape()),
        HeadlessStep::Key(right()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "No background commands".to_string(),
            timeout_ms: 5_000,
        },
    ];
    let outcome = run_plan(steps, false);
    let all = outcome.frames.join("\n");
    assert!(
        all.contains("No running or paused heartbeats"),
        "the empty heartbeats group opened its view:\n{all}"
    );
    assert!(
        all.contains("No background commands"),
        "the empty shells group opened its view:\n{all}"
    );
}

/// Bug 2: with a shell running and zero subagents, the prompt's Down
/// enters the dock and two Right presses reach the shells group, whose
/// Enter opens the bash view listing the running shell.
#[test]
fn prompt_down_reaches_the_shells_group_with_zero_subagents() {
    let steps = vec![
        HeadlessStep::WaitRender {
            needle: "\u{25c6} 0 subagents  \u{b7}  \u{25f7} 0 heartbeats  \u{b7}  \u{25b8} 1 shell"
                .to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(down()),
        HeadlessStep::Key(right()),
        HeadlessStep::Key(right()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "render the frames".to_string(),
            timeout_ms: 5_000,
        },
    ];
    let outcome = run_plan(steps, true);
    let all = outcome.frames.join("\n");
    assert!(
        all.contains("render the frames"),
        "the shells group opened the bash view with the running shell:\n{all}"
    );
    assert!(!outcome.return_to_agents_view);
}

/// Up and Esc from the focused dock return to the prompt: the Enter that
/// follows reaches the empty prompt, never the dock's heartbeats group
/// (whose view would render its empty state), and the typed text after it
/// lands in the prompt — the barrier proves the Enter was handled.
#[test]
fn up_and_esc_return_from_the_dock_to_the_prompt() {
    for back in [up(), escape()] {
        let steps = vec![
            HeadlessStep::WaitRender {
                needle: ALL_ZERO_DOCK.to_string(),
                timeout_ms: 5_000,
            },
            HeadlessStep::Key(down()),
            HeadlessStep::Key(right()),
            HeadlessStep::Key(back),
            HeadlessStep::Key(enter()),
            HeadlessStep::Type("back at the prompt".to_string()),
            HeadlessStep::WaitRender {
                needle: "back at the prompt".to_string(),
                timeout_ms: 5_000,
            },
        ];
        let outcome = run_plan(steps, false);
        let all = outcome.frames.join("\n");
        assert!(
            all.contains("back at the prompt") && !all.contains("No running or paused heartbeats"),
            "{back:?} returned the focus to the prompt before the Enter:\n{all}"
        );
    }
}
