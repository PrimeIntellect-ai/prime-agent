//! Headless e2e for the dock panels' exit focus (operator ruling
//! 2026-09-26): ESC/left from a dock panel returns to chat with the
//! panel's dock item still selected — the dock holds focus, not the
//! prompt bar; the next Enter re-opens the SAME panel.
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
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, InteractiveOutcome,
    ModelSelection, SessionSelection, UiMode,
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

    /// Serve one connection: attach the session with the goal state, then answer the loop's
    /// requests.
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        let write_stream = stream.try_clone().expect("clone mock socket");
        let mut writer = write_stream;
        let mut reader = BufReader::new(stream);

        // The hello advertises the kernel-bash activity capability: the registry poll is
        // capability-gated (the dock and the shells view stay empty without it).
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
                "heartbeats_list" => {
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
                                            "label": "Workspace tidy",
                                            "prompt": "tidy the workspace hourly",
                                            "schedule": {"kind": "interval", "expression": "every 30m"},
                                        },
                                        "sessionName": "dock exit focus",
                                        "firstMessage": "hello",
                                    },
                                ]
                            },
                        }),
                    );
                }
                "list_kernel_bash" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "list_kernel_bash",
                            "success": true,
                            "data": {
                                "activities": [
                                    {"id": "shell-1", "command": "render the frames", "pid": 4242, "status": "running"},
                                ]
                            },
                        }),
                    );
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

/// The slim attach result: one session with an actively pursued goal, so every dock group except
/// Subagents is selectable.
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
                    "sessionName": "dock exit focus session",
                    "model": null,
                    "isStreaming": false,
                    "isCompacting": false,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                    "goal": {
                        "active": true,
                        "status": "active",
                        "goalId": "goal-1",
                        "objective": "land the dock exit focus",
                        "timeUsedSeconds": 0,
                    },
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

fn run_plan(steps: Vec<HeadlessStep>) -> InteractiveOutcome {
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
    outcome
}

fn key(code: KeyCode) -> HeadlessStep {
    HeadlessStep::Key(KeyEvent::new(code, KeyModifiers::NONE))
}

/// The dock's shortcut grab (`app.subagents.focus`, default alt+a): it
/// keeps the dock's current selection, where the prompt's Down always
/// lands on the subagents group.
fn alt_a() -> HeadlessStep {
    HeadlessStep::Key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::ALT))
}

fn wait_render(needle: &str) -> HeadlessStep {
    HeadlessStep::WaitRender {
        needle: needle.to_string(),
        timeout_ms: 10_000,
    }
}

fn wait_gone(needle: &str) -> HeadlessStep {
    HeadlessStep::WaitGone {
        needle: needle.to_string(),
        timeout_ms: 10_000,
    }
}

/// Enter the dock's Heartbeats panel, leave it with the exit key, and prove the restored focus: the
/// next Enter re-opens the Heartbeats panel, and the run never hands off to the agents view.
fn heartbeats_exit_plan(exit: KeyCode) -> Vec<HeadlessStep> {
    vec![
        // The barrier pins the panel's content (its row label); the navigation itself steps the
        // rendered groups, empty ones included, so it never depends on the feed's landing order.
        wait_render("\u{25f7} 1 heartbeat"),
        alt_a(),
        HeadlessStep::WaitMs(150),
        // The dock's focus starts on the subagents section (the default selection).
        key(KeyCode::Right),
        HeadlessStep::WaitMs(150),
        key(KeyCode::Enter),
        wait_render("Workspace tidy"),
        key(exit),
        wait_gone("Workspace tidy"),
        key(KeyCode::Enter),
        wait_render("Workspace tidy"),
    ]
}

/// Enter the dock's Shells panel, leave it, and prove the restored focus the same way.
fn shells_exit_plan(exit: KeyCode) -> Vec<HeadlessStep> {
    vec![
        wait_render("\u{25b8} 1 shell"),
        alt_a(),
        HeadlessStep::WaitMs(150),
        key(KeyCode::Right),
        HeadlessStep::WaitMs(150),
        key(KeyCode::Right),
        HeadlessStep::WaitMs(150),
        key(KeyCode::Enter),
        wait_render("render the frames"),
        key(exit),
        wait_gone("render the frames"),
        key(KeyCode::Enter),
        wait_render("render the frames"),
    ]
}

/// Enter the dock's goal panel (the row's last group), leave it, and prove the restored focus the
/// same way.
fn goal_exit_plan(exit: KeyCode) -> Vec<HeadlessStep> {
    vec![
        wait_render("Pursuing goal (0s)"),
        alt_a(),
        HeadlessStep::WaitMs(150),
        key(KeyCode::Right),
        HeadlessStep::WaitMs(150),
        key(KeyCode::Right),
        HeadlessStep::WaitMs(150),
        key(KeyCode::Right),
        HeadlessStep::WaitMs(150),
        key(KeyCode::Enter),
        wait_render("land the dock exit focus"),
        key(exit),
        wait_gone("land the dock exit focus"),
        key(KeyCode::Enter),
        wait_render("land the dock exit focus"),
    ]
}

/// ESC from the Heartbeats panel lands back on the dock's Heartbeates item: the second Enter
/// re-opens the same panel (an empty-draft Enter submits nothing).
#[test]
fn heartbeats_panel_esc_returns_to_the_dock_item() {
    let outcome = run_plan(heartbeats_exit_plan(KeyCode::Esc));
    let last = outcome.frames.last().expect("frames were captured");
    assert!(
        last.contains("Workspace tidy"),
        "the reopened Heartbeats panel owns the final frame:\n{last}"
    );
    assert!(
        !outcome.return_to_agents_view,
        "the exit stays in the chat view"
    );
}

/// The `/heartbeats` COMMAND path (not the dock's Enter) leaves the dock's Heartbeates item
/// selected too: with the selection parked on the goal row, submitting `/heartbeats` and leaving
/// with ESC lands on the Heartbeates item.
#[test]
fn heartbeats_command_path_esc_returns_to_the_dock_item() {
    let outcome = run_plan(vec![
        // The dock's selection walks to the goal section before the command opens the panel.
        wait_render("Pursuing goal (0s)"),
        alt_a(),
        HeadlessStep::WaitMs(150),
        key(KeyCode::Right),
        HeadlessStep::WaitMs(150),
        key(KeyCode::Right),
        HeadlessStep::WaitMs(150),
        key(KeyCode::Right),
        HeadlessStep::WaitMs(150),
        HeadlessStep::Submit("/heartbeats".to_string()),
        wait_render("Workspace tidy"),
        key(KeyCode::Esc),
        wait_gone("Workspace tidy"),
        key(KeyCode::Enter),
        wait_render("Workspace tidy"),
    ]);
    let last = outcome.frames.last().expect("frames were captured");
    assert!(
        last.contains("Workspace tidy"),
        "the reopened Heartbeats panel owns the final frame:\n{last}"
    );
    assert!(
        !last.contains("land the dock exit focus"),
        "the goal panel (the stale pre-command selection) must not open:\n{last}"
    );
    assert!(
        !outcome.return_to_agents_view,
        "the exit stays in the chat view"
    );
}

#[test]
fn heartbeats_panel_left_returns_to_the_dock_item() {
    let outcome = run_plan(heartbeats_exit_plan(KeyCode::Left));
    let last = outcome.frames.last().expect("frames were captured");
    assert!(
        last.contains("Workspace tidy"),
        "the reopened Heartbeats panel owns the final frame:\n{last}"
    );
    assert!(
        !outcome.return_to_agents_view,
        "the exit stays in the chat view"
    );
}

#[test]
fn shells_panel_esc_returns_to_the_dock_item() {
    let outcome = run_plan(shells_exit_plan(KeyCode::Esc));
    let last = outcome.frames.last().expect("frames were captured");
    assert!(
        last.contains("render the frames"),
        "the reopened Shells panel owns the final frame:\n{last}"
    );
    assert!(
        !outcome.return_to_agents_view,
        "the exit stays in the chat view"
    );
}

#[test]
fn shells_panel_left_returns_to_the_dock_item() {
    let outcome = run_plan(shells_exit_plan(KeyCode::Left));
    let last = outcome.frames.last().expect("frames were captured");
    assert!(
        last.contains("render the frames"),
        "the reopened Shells panel owns the final frame:\n{last}"
    );
    assert!(
        !outcome.return_to_agents_view,
        "the exit stays in the chat view"
    );
}

#[test]
fn goal_panel_esc_returns_to_the_dock_item() {
    let outcome = run_plan(goal_exit_plan(KeyCode::Esc));
    let last = outcome.frames.last().expect("frames were captured");
    assert!(
        last.contains("land the dock exit focus"),
        "the reopened goal panel owns the final frame:\n{last}"
    );
    assert!(
        !outcome.return_to_agents_view,
        "the exit stays in the chat view"
    );
}

#[test]
fn goal_panel_left_returns_to_the_dock_item() {
    let outcome = run_plan(goal_exit_plan(KeyCode::Left));
    let last = outcome.frames.last().expect("frames were captured");
    assert!(
        last.contains("land the dock exit focus"),
        "the reopened goal panel owns the final frame:\n{last}"
    );
    assert!(
        !outcome.return_to_agents_view,
        "the exit stays in the chat view"
    );
}
