//! Headless e2e for the prompt bar's up/down input-history recall (TS
//! `packages/tui/src/components/editor.ts`'s `navigateHistory` behind
//! `tui.editor.cursorUp`/`cursorDown`): Up walks the recalled prompts
//! backward, Down walks them forward, and one Down past the newest returns
//! to the draft. The compact dock coexists with the recall: the Down at
//! the prompt's end keeps TS `SubagentSummaryLine.isSelectable()` — it
//! grabs focus only when subagents exist — while the dock's other groups
//! keep their own shortcut (`app.subagents.focus`). The regression this
//! pins: a dock group outside the subagents box (here, one heartbeat)
//! must never silently steal that Down, because the dock's focused-Up arm
//! then consumed the very next Up and the recall read broken.
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
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// Serve one connection: attach an empty session, list one heartbeat
    /// (the dock's heartbeats group is selectable while no subagents
    /// exist — the session shape that must not steal the prompt's Down),
    /// and ack every prompt with no turn events, so the transcript never
    /// echoes the prompts and the recalled text renders only in the
    /// prompt box.
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        let writer = stream.try_clone().expect("clone mock socket");
        let mut writer = writer;
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
                "heartbeats_list" => {
                    // One in-scope heartbeat row: the dock renders its
                    // heartbeats group, and that group is selectable.
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "heartbeats_list",
                            "success": true,
                            "data": {
                                "heartbeats": [
                                    {
                                        "job": {
                                            "id": "hb-1",
                                            "status": "active",
                                            "source": "heartbeat",
                                            "activeSessionId": "s1",
                                            "sessionId": "sess-1",
                                            "label": "dock recall beat",
                                            "schedule": {
                                                "kind": "interval",
                                                "expression": "every 30m",
                                            },
                                        },
                                    },
                                ],
                            },
                        }),
                    );
                }
                "prompt" => {
                    // An admitted prompt with no turn events: the turn
                    // never starts and the transcript keeps nothing.
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

/// The slim attach result: one empty session.
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
                    "sessionName": "recall session",
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
        client_settings: None,
    }
}

/// Run a headless plan against a fresh mock supervisor; the captured
/// frames show the editor surface (the prompt box) and the dock.
fn run_plan(steps: Vec<HeadlessStep>) -> Vec<String> {
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
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    outcome.frames
}

/// Every step's condition wait must have been satisfied: a barrier that
/// timed out renders its note, and the note would name the broken step.
fn assert_no_barrier_timeouts(frames: &[String]) {
    let all = frames.join("\n");
    assert!(
        !all.contains("timed out waiting"),
        "a plan barrier timed out (the step's condition never rendered):\n{all}"
    );
}

/// Submit one prompt through the typed path (the editor's own submit —
/// `HeadlessStep::Submit` bypasses the editor and would leave the
/// history empty), then hold until the prompt box renders empty again.
fn submit(prompt: &str) -> Vec<HeadlessStep> {
    vec![
        HeadlessStep::Type(prompt.to_string()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitGone {
            needle: prompt.to_string(),
            timeout_ms: 3000,
        },
    ]
}

fn enter() -> KeyEvent {
    KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
}

fn up() -> KeyEvent {
    KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)
}

fn down() -> KeyEvent {
    KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)
}

/// Alt+A: the dock's own focus shortcut (`app.subagents.focus`).
fn alt_a() -> KeyEvent {
    KeyEvent::new(KeyCode::Char('a'), KeyModifiers::ALT)
}

fn escape() -> KeyEvent {
    KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)
}

fn wait_render(needle: &str) -> HeadlessStep {
    HeadlessStep::WaitRender {
        needle: needle.to_string(),
        timeout_ms: 3000,
    }
}

fn wait_gone(needle: &str) -> HeadlessStep {
    HeadlessStep::WaitGone {
        needle: needle.to_string(),
        timeout_ms: 3000,
    }
}

/// TS `navigateHistory`: Up recalls the newest prompt, a second Up walks
/// one older, Down walks forward, and one Down past the newest returns to
/// the empty draft.
#[test]
fn up_walks_backward_down_forward_and_the_draft_returns() {
    let mut steps = Vec::new();
    steps.extend(submit("first prompt"));
    steps.extend(submit("second prompt"));
    steps.push(HeadlessStep::Key(up()));
    steps.push(wait_render("second prompt"));
    steps.push(HeadlessStep::Key(up()));
    steps.push(wait_gone("second prompt"));
    steps.push(wait_render("first prompt"));
    steps.push(HeadlessStep::Key(down()));
    steps.push(wait_gone("first prompt"));
    steps.push(wait_render("second prompt"));
    steps.push(HeadlessStep::Key(down()));
    steps.push(wait_gone("second prompt"));
    let frames = run_plan(steps);
    assert_no_barrier_timeouts(&frames);
    let last = frames.last().expect("the plan rendered frames");
    assert!(
        !last.contains("first prompt") && !last.contains("second prompt"),
        "the final Down returned to the empty draft, not a recalled prompt: {last:?}"
    );
}

/// The regression (operator report 2026-09-26): with a selectable dock
/// group outside the subagents box (one heartbeat, no subagents), the
/// Down at the draft's end must not hand the dock focus — TS
/// `SubagentSummaryLine.isSelectable()` grants that Down only when
/// subagents exist. Before the fix this Down grabbed the dock, and the
/// dock's focused-Up arm consumed the very next Up, so the recall read
/// broken.
#[test]
fn a_heartbeats_only_dock_never_takes_the_prompts_down() {
    let mut steps = Vec::new();
    // The dock's heartbeats group is mounted and selectable before the
    // walk starts: the frame carries its `◷ 1 heartbeat` row.
    steps.push(wait_render("heartbeat"));
    steps.extend(submit("first prompt"));
    steps.push(HeadlessStep::Key(up()));
    steps.push(wait_render("first prompt"));
    // The overshoot: Down back to the draft, then the draft's own Down —
    // the press that used to steal the focus.
    steps.push(HeadlessStep::Key(down()));
    steps.push(wait_gone("first prompt"));
    steps.push(HeadlessStep::Key(down()));
    // The very next Up must recall, not unfocus a silently grabbed dock.
    steps.push(HeadlessStep::Key(up()));
    steps.push(wait_render("first prompt"));
    let frames = run_plan(steps);
    assert_no_barrier_timeouts(&frames);
    let last = frames.last().expect("the plan rendered frames");
    assert!(
        last.contains("first prompt"),
        "the Up after the draft's Down recalled the prompt: {last:?}"
    );
}

/// Coexistence: the dock's own shortcut still focuses the heartbeats
/// group (the operator's direct-navigation redesign), Enter opens its
/// view, Escape returns to the editor, and the history recall works right
/// after the round trip.
#[test]
fn alt_a_still_opens_the_dock_group_view_and_recall_survives_it() {
    let mut steps = Vec::new();
    steps.push(wait_render("heartbeat"));
    steps.extend(submit("first prompt"));
    steps.push(HeadlessStep::Key(alt_a()));
    steps.push(HeadlessStep::Key(enter()));
    steps.push(wait_render("Heartbeats"));
    steps.push(HeadlessStep::Key(escape()));
    steps.push(wait_gone("Heartbeats"));
    steps.push(HeadlessStep::Key(up()));
    steps.push(wait_render("first prompt"));
    let frames = run_plan(steps);
    assert_no_barrier_timeouts(&frames);
    let last = frames.last().expect("the plan rendered frames");
    assert!(
        last.contains("first prompt"),
        "the recall works right after the dock round trip: {last:?}"
    );
}
