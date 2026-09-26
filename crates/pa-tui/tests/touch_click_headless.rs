//! Headless e2e for the click/touch grammar on the session surface: a
//! mock supervisor serves one attached session whose replayed transcript
//! carries a condensed activity run, and the headless harness feeds
//! byte-identical SGR press/release pairs through the same
//! decode-and-dispatch path a terminal's clicks take.
//!
//! Verifies the operator's core interactions: a plain click on a
//! condensed run block expands it (the `app.tools.expand` cycle), a
//! plain click in the prompt bar places the caret at the clicked cell
//! (then typing inserts there), and a plain click on a `/model` picker
//! row moves the selection onto it.
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
use pa_types::ai::Model;
use serde_json::{json, Value};

/// The SGR left press / release pair a real terminal sends with
/// ?1002+?1006 tracking active (one-based screen cells).
fn press(col: usize, row: usize) -> String {
    format!("\x1b[<0;{col};{row}M")
}

fn release(col: usize, row: usize) -> String {
    format!("\x1b[<0;{col};{row}m")
}

struct MockSupervisor {
    listener: UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// Serve one connection: the attach replay, then answer the loop's
    /// requests.
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
                                "contextUsage": { "tokens": 1200, "contextWindow": 200_000 },
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

/// The slim attach result with the condensed-run transcript of
/// `tool_runs_headless.rs`: eight ipython calls around a received agent
/// message and hidden thinking - one >=3 activity-item run that
/// condenses at the overview level.
fn attach_data(id: &str) -> Value {
    let tool_call = |index: usize| {
        json!({
            "type": "toolCall",
            "id": format!("c{index}"),
            "name": "ipython",
            "arguments": { "code": format!("print({index})") },
        })
    };
    let mut messages: Vec<Value> = vec![
        json!({ "role": "user", "content": "run it", "timestamp": 1u64 }),
        json!({
            "role": "assistant",
            "content": [
                { "type": "thinking", "thinking": "before the message" },
                tool_call(0),
                tool_call(1),
                tool_call(2),
            ],
            "timestamp": 1_000u64,
        }),
        json!({
            "role": "toolResult",
            "toolCallId": "c0",
            "toolName": "ipython",
            "content": [{ "type": "text", "text": "out 0" }],
            "details": { "status": "ok" },
            "isError": false,
            "timestamp": 5_000u64,
        }),
        json!({
            "role": "toolResult",
            "toolCallId": "c1",
            "toolName": "ipython",
            "content": [{ "type": "text", "text": "out 1" }],
            "details": { "status": "ok" },
            "isError": false,
            "timestamp": 11_000u64,
        }),
        json!({
            "role": "toolResult",
            "toolCallId": "c2",
            "toolName": "ipython",
            "content": [{ "type": "text", "text": "out 2" }],
            "details": { "status": "ok" },
            "isError": false,
            "timestamp": 16_000u64,
        }),
        json!({
            "role": "custom",
            "customType": "agent_message",
            "display": true,
            "content": "steering note",
            "details": {
                "id": "am_1",
                "message": "steering note",
                "from": { "sessionName": "fleet" },
                "fromRelationship": "parent",
            },
            "timestamp": 17_000u64,
        }),
        json!({
            "role": "assistant",
            "content": [
                { "type": "thinking", "thinking": "after the message" },
                tool_call(3),
                tool_call(4),
                tool_call(5),
                tool_call(6),
                tool_call(7),
            ],
            "timestamp": 18_000u64,
        }),
    ];
    for index in 3..8 {
        let mut details = json!({ "status": "ok" });
        if index == 5 {
            details["sentAgentMessages"] = json!([
                {
                    "id": "amq_0",
                    "message": "a queued receipt",
                    "deliveryStatus": "queued",
                    "receiverRole": "parent",
                }
            ]);
        }
        messages.push(json!({
            "role": "toolResult",
            "toolCallId": format!("c{index}"),
            "toolName": "ipython",
            "content": [{ "type": "text", "text": format!("out {index}") }],
            "details": details,
            "isError": false,
            "timestamp": 18_000u64 + (index as u64 - 2) * 9_000,
        }));
    }
    messages.push(json!({
        "role": "assistant",
        "content": [{ "type": "text", "text": "all done" }],
        "timestamp": 79_000u64,
    }));
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
                    "sessionName": "click session",
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

/// One catalog model (the picker rows' identity).
fn model(id: &str, name: &str) -> Model {
    serde_json::from_value(serde_json::json!({
        "id": id, "name": name, "api": "openai-completions", "provider": "prime-inference",
        "baseUrl": "https://example.invalid/v1", "reasoning": false,
        "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 128_000, "maxTokens": 4096,
    }))
    .expect("mock model deserializes")
}

fn options(socket: PathBuf, catalog: Vec<Model>) -> InteractiveOptions {
    InteractiveOptions {
        socket_path: socket,
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        script_path: None,
        model_selection: ModelSelection::default(),
        model_catalog: catalog,
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

/// Run the headless plan against a fresh mock supervisor and return the
/// captured frames. Holds the run lock: mouse tracking is process-global.
fn run_plan(steps: Vec<HeadlessStep>, catalog: Vec<Model>) -> Vec<String> {
    let _guard = run_lock();
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
        height: 34,
    };
    let outcome = runtime
        .block_on(run_interactive(
            options(socket, catalog),
            UiMode::Headless(plan),
        ))
        .expect("interactive run");
    let _ = handle.join();
    outcome.frames
}

/// The last frame holding a needle and the needle's (row, column) within
/// it — the rendered coordinates a click targets.
fn locate(frames: &[String], needle: &str) -> Option<(usize, usize, usize, &str)> {
    frames
        .iter()
        .enumerate()
        .filter_map(|(index, frame)| {
            let rows: Vec<&str> = frame.split('\n').collect();
            let row = rows.iter().position(|r| r.contains(needle))?;
            let col = rows[row].find(needle)?;
            Some((index, row, col, frame.as_str()))
        })
        .next_back()
}

fn ctrl_o() -> crossterm::event::KeyEvent {
    crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Char('o'),
        crossterm::event::KeyModifiers::CONTROL,
    )
}

/// A click on a condensed run block expands it: the plain press/release
/// pair on the block's summary row cycles the conversation detail to the
/// level that renders every card (`app.tools.expand`'s action), so the
/// cards appear and the condensed block is gone.
#[test]
fn a_click_on_a_condensed_run_expands_it() {
    let frames = run_plan(
        vec![
            HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            // A chat starts at the middle details level; cycle down to
            // the collapsed overview where the run condenses.
            HeadlessStep::Key(ctrl_o()),
            HeadlessStep::Key(ctrl_o()),
            HeadlessStep::WaitRender {
                needle: "8 tool calls".to_string(),
                timeout_ms: 5_000,
            },
        ],
        Vec::new(),
    );
    let (_, row, col, _) =
        locate(&frames, "8 tool calls").expect("the condensed run renders before the click");
    // The SGR report's cells are one-based.
    let click = HeadlessStep::Mouse(press(col + 1, row + 1));
    let release = HeadlessStep::Mouse(release(col + 1, row + 1));
    let frames = run_plan(
        vec![
            HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            HeadlessStep::Key(ctrl_o()),
            HeadlessStep::Key(ctrl_o()),
            HeadlessStep::WaitRender {
                needle: "8 tool calls".to_string(),
                timeout_ms: 5_000,
            },
            click,
            release,
            // The click's frame: the cards render at the details level.
            HeadlessStep::WaitRender {
                needle: "print(3)".to_string(),
                timeout_ms: 5_000,
            },
        ],
        Vec::new(),
    );
    let last = frames.last().expect("a frame after the click");
    assert!(
        last.contains("print(3)"),
        "the click expanded the run's cards: {last}"
    );
    assert!(
        !last.contains("8 tool calls"),
        "the condensed block is gone at the expanded level: {last}"
    );
}

/// A click in the prompt bar places the caret at the clicked cell: click
/// on the cell of `world`'s first character, then type — the insert
/// lands right there, between `hello ` and `world`.
#[test]
fn a_click_in_the_prompt_bar_places_the_caret() {
    let typed = "hello world";
    let frames = run_plan(
        vec![
            HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            HeadlessStep::Type(typed.to_string()),
            HeadlessStep::WaitRender {
                needle: typed.to_string(),
                timeout_ms: 5_000,
            },
        ],
        Vec::new(),
    );
    // `world`'s first cell is the clicked one: the caret lands in front
    // of the word, so the insert splits `hello ` from `world`.
    let (_, row, col, _) = locate(&frames, "world").expect("the draft renders");
    // The caret goes in front of `world` (the needle's own column).
    let click = HeadlessStep::Mouse(press(col + 1, row + 1));
    let release = HeadlessStep::Mouse(release(col + 1, row + 1));
    let frames = run_plan(
        vec![
            HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            HeadlessStep::Type(typed.to_string()),
            HeadlessStep::WaitRender {
                needle: typed.to_string(),
                timeout_ms: 5_000,
            },
            click,
            release,
            HeadlessStep::Type("X".to_string()),
            HeadlessStep::WaitRender {
                needle: "hello Xworld".to_string(),
                timeout_ms: 5_000,
            },
        ],
        Vec::new(),
    );
    let last = frames.last().expect("a frame after the insert");
    assert!(
        last.contains("hello Xworld"),
        "the click placed the caret at the clicked cell: {last}"
    );
}

/// A click on a `/model` picker row moves the selection onto it: the
/// clicked row carries the `›` marker (the selection band), exactly
/// like the arrow keys.
#[test]
fn a_click_selects_a_model_picker_row() {
    let catalog = vec![model("mock-1", "Mock One"), model("mock-2", "Mock Two")];
    let frames = run_plan(
        vec![
            HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            HeadlessStep::Submit("/model".to_string()),
            HeadlessStep::WaitRender {
                needle: "Mock Two".to_string(),
                timeout_ms: 5_000,
            },
        ],
        catalog.clone(),
    );
    let (_, row, col, _) = locate(&frames, "Mock Two").expect("the picker row renders");
    let click = HeadlessStep::Mouse(press(col + 1, row + 1));
    let release = HeadlessStep::Mouse(release(col + 1, row + 1));
    let frames = run_plan(
        vec![
            HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            HeadlessStep::Submit("/model".to_string()),
            HeadlessStep::WaitRender {
                needle: "Mock Two".to_string(),
                timeout_ms: 5_000,
            },
            click,
            release,
        ],
        catalog,
    );
    let last = frames.last().expect("a frame after the click");
    let rows: Vec<&str> = last.split('\n').collect();
    let clicked = rows
        .iter()
        .find(|row| row.contains("Mock Two"))
        .expect("the clicked row still renders");
    assert!(
        clicked.starts_with("\u{203a}"),
        "the clicked row carries the selection marker: {clicked}"
    );
    let first = rows
        .iter()
        .find(|row| row.contains("Mock One"))
        .expect("the other row still renders");
    assert!(
        !first.starts_with("\u{203a}"),
        "the first row's marker moved away: {first}"
    );
}
