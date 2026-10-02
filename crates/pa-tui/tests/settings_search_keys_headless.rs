//! Headless regression for the `/settings` menu's search field (the
//! operator's 2026-10-02 report: "type /settings, then type random keys
//! in the search, then cannot space-bar or backspace anymore"). The
//! settings search is TS `SettingsList.handleInput`'s final arm: every
//! non-intercepted key goes to the search `Input`, whose edit bindings
//! (Backspace first) dispatch on their whole multi-character key ids.
//! The port's single-character gate dropped them, so after garbage
//! filtered the list to the no-match row the query could never be
//! corrected — Backspace typed nothing away and Space had no row to
//! activate. This ladder drives the exact sequence through the real
//! interactive stack: the rows must return with the Backspaces and
//! Space must keep cycling the selected row.
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
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// Serve one connection: attach an empty session, then answer the
    /// loop's requests (the settings menu's daemon switch answers through
    /// the generic ok arm).
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
                "get_commands" => {
                    // No skill commands: the plain builtin registry.
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_commands",
                            "success": true,
                            "data": { "commands": [] },
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
                    "sessionName": "settings search session",
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

const WIDTH: usize = 100;

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
        width: WIDTH as u16,
        height: 30,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    outcome.frames
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

/// The frame rows as text, one String per row, with the frame's
/// full-width padding trimmed (the composed frame pads every row to the
/// terminal width; the asserts read the content).
fn frame_rows(frame: &str) -> Vec<String> {
    frame
        .split('\n')
        .map(|row| row.trim_end().to_string())
        .collect()
}

/// The operator's sequence through the real interactive stack: open the
/// `/settings` menu, type garbage into its search field, then Backspace
/// the garbage away and keep working — the rows must return (Backspace
/// still deletes) and Space must still cycle the selected row's value.
#[test]
fn garbage_query_keeps_backspace_and_space_alive() {
    let steps = vec![
        // The command-catalog fetch lands in the background (the attach
        // spawns it); give the fold a beat before the submit.
        HeadlessStep::WaitMs(300),
        HeadlessStep::Submit("/settings".to_string()),
        HeadlessStep::WaitRender {
            needle: "Type to search".to_string(),
            timeout_ms: 5000,
        },
        // Random keys into the settings search: the filter empties the
        // list to its no-match row.
        HeadlessStep::Key(key(KeyCode::Char('z'))),
        HeadlessStep::Key(key(KeyCode::Char('q'))),
        HeadlessStep::Key(key(KeyCode::Char('x'))),
        HeadlessStep::WaitRender {
            needle: "No matching settings".to_string(),
            timeout_ms: 5000,
        },
        // Backspace must delete the garbage: the query clears and the
        // settings rows return (the menu's own rows, not a closed menu).
        HeadlessStep::Key(key(KeyCode::Backspace)),
        HeadlessStep::Key(key(KeyCode::Backspace)),
        HeadlessStep::Key(key(KeyCode::Backspace)),
        HeadlessStep::WaitRender {
            needle: "Auto-compact".to_string(),
            timeout_ms: 5000,
        },
        // Space keeps its row-activation meaning on the restored list:
        // the selected Auto-compact row cycles true -> false.
        HeadlessStep::Key(key(KeyCode::Char(' '))),
        HeadlessStep::WaitMs(300),
    ];
    let frames = run_plan(steps);

    let last = frames.last().expect("the run captured frames");
    assert!(
        last.contains("Auto-compact"),
        "the settings rows return once the garbage query is backspaced away:\n{last}"
    );
    assert!(
        !last.contains("No matching settings"),
        "the no-match row clears with the query:\n{last}"
    );
    assert!(
        last.contains("1 General"),
        "the menu stays open (the tab strip still renders):\n{last}"
    );
    let row = frame_rows(last)
        .into_iter()
        .find(|row| row.contains("Auto-compact"))
        .expect("the Auto-compact settings row");
    assert!(
        row.contains("false"),
        "Space still cycles the selected row's value after the correction:\n{row}"
    );
}
