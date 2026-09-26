//! Headless e2e for the activity dock's arrow traversal (the operator's
//! 2026-09-26 muscle-memory directive): a mock supervisor mounts the dock
//! with a live goal row and scripted heartbeat rows, and the plan drives
//! the dock with the same key path a user's arrows take (alt+a to focus,
//! left/right to step, enter to open the focused section's view).
//!
//! Verifies the contract: every rendered section is exactly one press
//! away in both directions — an empty section (0 subagents, 0 heartbeats,
//! 0 shells) is still visited, never skipped, and the cycle wraps — and
//! entering a section opens its view, whose existing empty state reads
//! the pane grammar ("No running or paused heartbeats" for heartbeats,
//! "No background commands" for shells). The TS dock has no section
//! traversal at all (`subagent-summary-line.ts` handles confirm/cancel
//! only and renders nothing when its counts are zero), so this surface
//! is the documented Rust divergence (docs/FEATURE_PARITY.md).
#![cfg(unix)]

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
    /// The `heartbeats_list` catalog to answer with (`None` serves the
    /// empty catalog — the 0-heartbeats dock).
    heartbeats: Option<Value>,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path, heartbeats: Option<Value>) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            heartbeats,
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
                    // The dock's mount for this run: a live goal row. The
                    // session has no subagents, heartbeats, or shells —
                    // every other section renders empty, so the arrows
                    // must still visit them.
                    write_session_event(
                        &mut writer,
                        &json!({
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
                        }),
                    );
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

/// One session heartbeat row: the session's own job, so it scopes into
/// the dock's heartbeats section and its view.
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
        client_settings: None,
    }
}

/// One alt+a key event (the dock's focus hand-off, `app.subagents.focus`).
fn alt_a() -> KeyEvent {
    KeyEvent::new(KeyCode::Char('a'), KeyModifiers::ALT)
}

/// One right-arrow key event (the dock's next-section step).
fn right() -> KeyEvent {
    KeyEvent::new(KeyCode::Right, KeyModifiers::NONE)
}

/// One left-arrow key event (the dock's previous-section step).
fn left() -> KeyEvent {
    KeyEvent::new(KeyCode::Left, KeyModifiers::NONE)
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
    heartbeats: Option<Value>,
) -> pa_tui::interactive::InteractiveOutcome {
    // The ambient TMUX variable adds a startup notice to the transcript;
    // scrub it so the run is the same inside tmux and out.
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket, heartbeats);
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

/// The dock's arrow traversal with every section empty: the goal row
/// mounts the dock (0 subagents, 0 heartbeats, 0 shells) and the arrows
/// still visit each section in order — right through the empty
/// heartbeats and shells sections to the goal section, then left back
/// through them, with the wrap landing on the row's last section. Each
/// visited section opens its own view, whose existing empty state reads
/// the pane grammar.
#[test]
fn dock_arrows_visit_each_empty_section_in_order_both_directions() {
    let steps = vec![
        // The goal row mounts the dock; the other three sections render
        // their zero counts.
        HeadlessStep::WaitRender {
            needle: "Pursuing goal (0s)".to_string(),
            timeout_ms: 5_000,
        },
        // Focus the dock: the selection starts on the subagents section.
        HeadlessStep::Key(alt_a()),
        HeadlessStep::WaitMs(100),
        // One right press lands on the EMPTY heartbeats section — the
        // old skip stepped straight over it.
        HeadlessStep::Key(right()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "No running or paused heartbeats".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
        // The next press in order: the empty shells section.
        HeadlessStep::Key(alt_a()),
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
        // The third press in order: the goal section, one press past
        // the empty shells section.
        HeadlessStep::Key(alt_a()),
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
        // Left walks the same sections in reverse: goal -> shells ->
        // heartbeats.
        HeadlessStep::Key(alt_a()),
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
        // Left wraps past the row's first section: two presses from the
        // heartbeats section land on the row's last section (the goal).
        HeadlessStep::Key(alt_a()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(left()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(left()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "status   active".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
    ];
    let outcome = run_plan(steps, None);
    let all = outcome.frames.join("\n");
    // The dock row itself: every section renders, empty ones included,
    // with its live count.
    assert!(
        all.contains(
            " \u{25c6} 0 subagents  \u{b7}  \u{25f7} 0 heartbeats  \u{b7}  \u{25b8} 0 shells  \u{b7}  Pursuing goal (0s)"
        ),
        "the dock renders every section with its zero count:\n{all}"
    );
    // Entering an empty section opens its view, and the empty state is
    // the pane's own grammar row.
    assert!(
        all.contains("No running or paused heartbeats"),
        "the empty heartbeats section opens its view's empty state:\n{all}"
    );
    assert!(
        all.contains("No background commands"),
        "the empty shells section opens its view's empty state:\n{all}"
    );
    // The run never left the session view: no press opened the scoped
    // agents view (the subagents section's destination).
    assert!(
        !outcome.return_to_agents_view,
        "the empty traversal stays in the session view"
    );
}

/// The same traversal with a section carrying rows: the heartbeats
/// section lists its heartbeat and the arrows take the identical press
/// count in the identical order — filling a section never moves another.
#[test]
fn dock_arrows_visit_the_same_sections_when_one_has_rows() {
    let steps = vec![
        // The dock row shows the filled section's live count beside the
        // other sections' zeros.
        HeadlessStep::WaitRender {
            needle: "\u{25f7} 1 heartbeat".to_string(),
            timeout_ms: 5_000,
        },
        // The identical right-walk: one press to the heartbeats section.
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
        // The second press: the empty shells section — the row-bearing
        // section never shifts the cycle.
        HeadlessStep::Key(alt_a()),
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
        // The third press: the goal section.
        HeadlessStep::Key(alt_a()),
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
        // The identical left-walk: two presses back to the row-bearing
        // heartbeats section.
        HeadlessStep::Key(alt_a()),
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
    let outcome = run_plan(steps, Some(canary_heartbeats()));
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
