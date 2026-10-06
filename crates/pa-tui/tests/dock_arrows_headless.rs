//! Headless e2e for the activity dock's arrow traversal (operator
//! directive 2026-09-26): every rendered section is one press away in
//! both directions (empty sections visited, cycle wraps), and entering
//! opens its view; the TS dock has no section traversal (Rust divergence).
#![cfg(unix)]
// Casts: structurally bounded terminal-layout arithmetic; guarded conversions add panic paths.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// Render routes are flat tables (one arm per route); splitting adds indirection.
#![allow(clippy::too_many_lines)]
// Widget state structs carry independent flag bits.
#![allow(clippy::struct_excessive_bools, clippy::fn_params_excessive_bools)]
// Futures are bounded by the surface's lifetime; boxing adds a steady-state allocation.
#![allow(clippy::large_futures)]
// The wrappers preserve a uniform Result-returning API surface.
#![allow(clippy::unnecessary_wraps)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::agents_view::AgentsViewScope;
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

struct MockSupervisor {
    listener: UnixListener,
    /// The `heartbeats_list` catalog to answer with (`None` serves the empty catalog — the
    /// 0-heartbeats dock).
    heartbeats: Option<Value>,
    /// The live `goal_update` event to serve on attach (`None` mounts no goal row — the all-zero
    /// dock).
    goal: Option<Value>,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path, heartbeats: Option<Value>, goal: Option<Value>) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            heartbeats,
            goal,
        }
    }

    /// Serve one client connection until it goes quiet (bounded, so the plan teardown join always
    /// finishes).
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
                    if let Some(goal) = &self.goal {
                        write_session_event(&mut writer, goal);
                    }
                }
                "heartbeats_list" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "heartbeats_list",
                            "success": true,
                            "data": self.heartbeats.clone().unwrap_or_else(|| json!({})),
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
                    "sessionName": "dock arrows session",
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

/// The dock's live goal row: the session has no subagents, heartbeats, or shells, so every other
/// section renders empty and the arrows must still visit them.
fn live_goal() -> Value {
    json!({
        "type": "goal_update",
        "goal": {
            "active": true,
            "status": "active",
            "goalId": "g-dock",
            "objective": "ship the dock arrows",
            "tokensUsed": 0,
            "timeUsedSeconds": 0,
            "continuationsUsed": 0,
        },
    })
}

/// One session heartbeat row: the session's own job, so it scopes into the dock's heartbeats
/// section and its view.
fn canary_heartbeats() -> Value {
    json!({
        "heartbeats": [
            {
                "job": {
                    "id": "hb-1",
                    "status": "active",
                    "source": "heartbeat",
                    "activeSessionId": "s1",
                    "sessionId": "sess-1",
                    "label": "lane canary",
                    "schedule": { "kind": "interval", "expression": "every 30m" },
                },
            },
        ],
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

/// One alt+a key event (the dock's focus hand-off, `app.subagents.focus`).
fn alt_a() -> KeyEvent {
    KeyEvent::new(KeyCode::Char('a'), KeyModifiers::ALT)
}

fn right() -> KeyEvent {
    KeyEvent::new(KeyCode::Right, KeyModifiers::NONE)
}

fn left() -> KeyEvent {
    KeyEvent::new(KeyCode::Left, KeyModifiers::NONE)
}

fn enter() -> KeyEvent {
    KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
}

/// One Esc key event (`tui.select.cancel`: the open view closes and the focus returns to the
/// editor).
fn escape() -> KeyEvent {
    KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)
}

fn run_plan(
    steps: Vec<HeadlessStep>,
    heartbeats: Option<Value>,
    goal: Option<Value>,
) -> pa_tui::interactive::InteractiveOutcome {
    // The ambient TMUX variable adds a startup notice; scrub it so runs are the same inside tmux
    // and out.
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket, heartbeats, goal);
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

/// The arrows still visit each empty section in order, each opening its own view (panel-exit
/// ruling 2026-09-26); Left from the subagents section opens the scoped agents view (2026-09-28).
#[test]
fn dock_arrows_visit_each_empty_section_in_order_both_directions() {
    let steps = vec![
        HeadlessStep::WaitRender {
            needle: "Pursuing goal (0s)".to_string(),
            timeout_ms: 5_000,
        },
        // The selection starts on the subagents section.
        HeadlessStep::Key(alt_a()),
        HeadlessStep::WaitMs(100),
        // One right press lands on the EMPTY heartbeats section.
        HeadlessStep::Key(right()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "No running or paused heartbeats".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(right()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "No background commands".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(right()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "status   active".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(left()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(left()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "No running or paused heartbeats".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(left()),
        HeadlessStep::WaitMs(100),
        // Left from the subagents selection opens the scoped agents view (the operator's 2026-09-28
        // ask); the plan ends on the agents surface.
        HeadlessStep::Key(left()),
        HeadlessStep::WaitMs(300),
    ];
    let outcome = run_plan(steps, None, Some(live_goal()));
    let all = outcome.frames.join("\n");

    assert!(
        all.contains(
            " \u{25c6} 0 subagents  \u{b7}  \u{25f7} 0 heartbeats  \u{b7}  \u{25b8} 0 shells  \u{b7}  Pursuing goal (0s)"
        ),
        "the dock renders every section with its zero count:\n{all}"
    );

    assert!(
        all.contains("No running or paused heartbeats"),
        "the empty heartbeats section opens its view's empty state:\n{all}"
    );
    assert!(
        all.contains("No background commands"),
        "the empty shells section opens its view's empty state:\n{all}"
    );

    assert!(
        outcome.return_to_agents_view,
        "left from the subagents selection hands the pane to the agents view"
    );
}

/// Filling a section never moves another (panel-exit ruling 2026-09-26 keeps the dock focused).
#[test]
fn dock_arrows_visit_the_same_sections_when_one_has_rows() {
    let steps = vec![
        HeadlessStep::WaitRender {
            needle: "\u{25f7} 1 heartbeat".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(alt_a()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(right()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "lane canary".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(right()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "No background commands".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(right()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "status   active".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(left()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(left()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "lane canary".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
    ];
    let outcome = run_plan(steps, Some(canary_heartbeats()), Some(live_goal()));
    let all = outcome.frames.join("\n");
    assert!(
        all.contains(
            " \u{25c6} 0 subagents  \u{b7}  \u{25f7} 1 heartbeat  \u{b7}  \u{25b8} 0 shells  \u{b7}  Pursuing goal (0s)"
        ),
        "the dock row reads the live counts:\n{all}"
    );
    assert!(
        all.contains("lane canary"),
        "the filled heartbeats section lists its rows:\n{all}"
    );
    assert!(!outcome.return_to_agents_view);
}

/// Left from the subagents selection opens the agents view (the operator's 2026-09-28 ask): the TS
/// dock has no left/right handling at all, so this is the documented Rust divergence; the editor's
/// `agents back` is the same rule on the adjacent surface.
#[test]
fn left_from_the_subagents_selection_opens_the_agents_view() {
    let steps = vec![
        HeadlessStep::WaitRender {
            needle: "Pursuing goal (0s)".to_string(),
            timeout_ms: 5_000,
        },
        // The selection starts on the subagents section.
        HeadlessStep::Key(alt_a()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(left()),
        HeadlessStep::WaitMs(300),
    ];
    let outcome = run_plan(steps, None, Some(live_goal()));
    assert!(
        outcome.return_to_agents_view,
        "left from the subagents selection hands the pane to the agents view"
    );
    let all = outcome.frames.join("\n");
    assert!(
        all.contains("\u{25c6} 0 subagents"),
        "the dock row mounted before the handoff:\n{all}"
    );
}

/// The all-zero dock (the operator's 2026-09-28 directive): the dock row still renders zero
/// counts, and Enter on the Subagents group opens the scoped agents view's empty roster.
#[test]
fn an_all_zero_dock_renders_and_opens_the_empty_scoped_agents_view() {
    let steps = vec![
        HeadlessStep::WaitRender {
            needle:
                " \u{25c6} 0 subagents  \u{b7}  \u{25f7} 0 heartbeats  \u{b7}  \u{25b8} 0 shells"
                    .to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(alt_a()),
        HeadlessStep::Key(enter()),
    ];
    let outcome = run_plan(steps, None, None);
    let all = outcome.frames.join("\n");
    assert!(
        all.contains(
            " \u{25c6} 0 subagents  \u{b7}  \u{25f7} 0 heartbeats  \u{b7}  \u{25b8} 0 shells"
        ),
        "the all-zero dock renders:\n{all}"
    );
    assert!(
        outcome.return_to_agents_view,
        "Enter opened the scoped agents view"
    );
    assert_eq!(
        outcome.agents_view_scope,
        Some(AgentsViewScope {
            session_id: Some("sess-1".to_string()),
            active_session_id: Some("s1".to_string()),
            session_name: Some("dock arrows session".to_string()),
        })
    );
}
