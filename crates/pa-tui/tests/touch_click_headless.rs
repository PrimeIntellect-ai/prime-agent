//! Headless e2e for the click/touch grammar: a mock supervisor serves a mixed activity run,
//! and the harness feeds byte-identical SGR pairs through the same decode-and-dispatch path
//! a terminal's clicks take. A plain click toggles the card it lands on (operator directive
//! 2026-09-26), places the caret, or moves a `/model` picker row.
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
use std::sync::{Mutex, MutexGuard};

/// Mouse tracking is process-global state, so the headless runs serialize (each asserts on the
/// tracking-active branch it drives).
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

/// The SGR left press / release pair a real terminal sends with ?1002+?1006 tracking active
/// (one-based screen cells).
fn press(col: usize, row: usize) -> String {
    format!("\x1b[<0;{col};{row}M")
}

fn release(col: usize, row: usize) -> String {
    format!("\x1b[<0;{col};{row}m")
}

struct MockSupervisor {
    listener: UnixListener,
    /// The catalog the picker's background `get_model_catalog` refresh answers with: the mock must
    /// serve the same models the run opened with, or the refresh would empty the picker's list.
    catalog: Vec<Model>,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path, catalog: Vec<Model>) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            catalog,
        }
    }

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
                "get_model_catalog" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_model_catalog",
                            "success": true,
                            "data": {
                                "models": self.catalog,
                                "configuredProviders": [],
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

/// The slim attach result: eight ipython calls around a received agent message and hidden thinking
/// — every call renders as its own card (the 2026-09-28 undo of the condensed-run summary block).
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
        models: None,
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
        restore_dock_focus: false,
        client_settings: None,
    }
}

/// Run the headless plan and return the captured frames. Holds the run lock: mouse tracking is
/// process-global.
fn run_plan(steps: Vec<HeadlessStep>, catalog: Vec<Model>) -> Vec<String> {
    let _guard = run_lock();
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket, catalog.clone());
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

/// The last frame holding a needle and its (row, column) — the coordinates a click targets.
fn locate(frames: &[String], needle: &str) -> Option<(usize, usize, usize)> {
    frames
        .iter()
        .enumerate()
        .filter_map(|(index, frame)| {
            let rows: Vec<&str> = frame.split('\n').collect();
            let row = rows.iter().position(|r| r.contains(needle))?;
            let col = rows[row].find(needle)?;
            Some((index, row, col))
        })
        .next_back()
}

/// A click on a tool card expands the card's own output (operator directive 2026-09-26); the
/// chat opens at the collapsed overview level (operator directive 2026-09-28).
#[test]
fn a_click_on_a_card_expands_it() {
    let frames = run_plan(
        vec![
            HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            HeadlessStep::WaitRender {
                needle: "print(7)".to_string(),
                timeout_ms: 5_000,
            },
        ],
        Vec::new(),
    );
    let (_, row, col) = locate(&frames, "print(7)").expect("the card renders before the click");
    // The SGR report's cells are one-based.
    let click = HeadlessStep::Mouse(press(col + 1, row + 1));
    let release = HeadlessStep::Mouse(release(col + 1, row + 1));
    let frames = run_plan(
        vec![
            HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            HeadlessStep::WaitRender {
                needle: "print(7)".to_string(),
                timeout_ms: 5_000,
            },
            click,
            release,
            // The card's own output body renders (the `╰─` gutter row only appears with tool output
            // expanded).
            HeadlessStep::WaitRender {
                needle: "\u{2570}\u{2500} print(7)".to_string(),
                timeout_ms: 5_000,
            },
        ],
        Vec::new(),
    );
    let last = frames.last().expect("a frame after the click");
    assert!(
        last.contains("\u{2570}\u{2500} print(7)"),
        "the click expanded the card's own output: {last}"
    );
    assert!(
        last.contains("print(7)"),
        "the card's own summary row stays rendered: {last}"
    );
}

#[test]
fn a_second_click_on_a_card_collapses_back() {
    let frames = run_plan(
        vec![
            HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            HeadlessStep::WaitRender {
                needle: "print(7)".to_string(),
                timeout_ms: 5_000,
            },
        ],
        Vec::new(),
    );
    let (_, card_row, card_col) =
        locate(&frames, "print(7)").expect("the card renders before the click");
    let frames = run_plan(
        vec![
            HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            HeadlessStep::WaitRender {
                needle: "print(7)".to_string(),
                timeout_ms: 5_000,
            },
            HeadlessStep::Mouse(press(card_col + 1, card_row + 1)),
            HeadlessStep::Mouse(release(card_col + 1, card_row + 1)),
            HeadlessStep::WaitRender {
                needle: "\u{2570}\u{2500} print(7)".to_string(),
                timeout_ms: 5_000,
            },
        ],
        Vec::new(),
    );
    let (_, row, col) =
        locate(&frames, "\u{2570}\u{2500} print(7)").expect("the card renders expanded");
    let frames = run_plan(
        vec![
            HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            HeadlessStep::WaitRender {
                needle: "print(7)".to_string(),
                timeout_ms: 5_000,
            },
            HeadlessStep::Mouse(press(card_col + 1, card_row + 1)),
            HeadlessStep::Mouse(release(card_col + 1, card_row + 1)),
            HeadlessStep::WaitRender {
                needle: "\u{2570}\u{2500} print(7)".to_string(),
                timeout_ms: 5_000,
            },
            HeadlessStep::Mouse(press(col + 1, row + 1)),
            HeadlessStep::Mouse(release(col + 1, row + 1)),
            HeadlessStep::WaitRender {
                needle: "print(7)".to_string(),
                timeout_ms: 5_000,
            },
        ],
        Vec::new(),
    );
    let last = frames.last().expect("a frame after the second click");
    assert!(
        last.contains("print(7)"),
        "the card keeps its own collapsed summary row: {last}"
    );
    assert!(
        !last.contains("\u{2570}\u{2500} print(7)"),
        "the expanded output folded away again: {last}"
    );
}

/// One click toggles exactly the clicked component (TS per-component `expanded`).
#[test]
fn a_click_toggles_only_the_clicked_component() {
    let frames = run_plan(
        vec![
            HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            HeadlessStep::WaitRender {
                needle: "print(7)".to_string(),
                timeout_ms: 5_000,
            },
        ],
        Vec::new(),
    );
    let (_, agent_row, agent_col) =
        locate(&frames, "\u{2193} fleet").expect("the agent-message header renders");
    let (_, card_row, card_col) = locate(&frames, "print(5)").expect("the tool card renders");
    // Run A: the click lands on the agent-message notice's header row.
    let frames = run_plan(
        vec![
            HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            HeadlessStep::WaitRender {
                needle: "print(7)".to_string(),
                timeout_ms: 5_000,
            },
            HeadlessStep::Mouse(press(agent_col + 1, agent_row + 1)),
            HeadlessStep::Mouse(release(agent_col + 1, agent_row + 1)),
            // The notice's own body opens (the `╰─` gutter row only renders with the notice
            // expanded).
            HeadlessStep::WaitRender {
                needle: "\u{2570}\u{2500} steering note".to_string(),
                timeout_ms: 5_000,
            },
        ],
        Vec::new(),
    );
    let last = frames
        .last()
        .expect("a frame after the agent-message click");
    assert!(
        last.contains("\u{2570}\u{2500} steering note"),
        "the click expanded the clicked agent message's own body: {last}"
    );
    assert!(
        !last.contains("\u{2570}\u{2500} print("),
        "no tool card expanded with the agent message: {last}"
    );
    assert!(
        !last.contains("before the message"),
        "the thinking blocks stay hidden - the level never moved: {last}"
    );
    // Run B: the click lands on the `print(5)` card (its own sent-message receipt).
    let frames = run_plan(
        vec![
            HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            HeadlessStep::WaitRender {
                needle: "print(7)".to_string(),
                timeout_ms: 5_000,
            },
            HeadlessStep::Mouse(press(card_col + 1, card_row + 1)),
            HeadlessStep::Mouse(release(card_col + 1, card_row + 1)),
            HeadlessStep::WaitRender {
                needle: "\u{2570}\u{2500} print(5)".to_string(),
                timeout_ms: 5_000,
            },
        ],
        Vec::new(),
    );
    let last = frames.last().expect("a frame after the card click");
    assert_eq!(
        last.matches("\u{2570}\u{2500} print(").count(),
        1,
        "only the clicked card expanded: {last}"
    );
    assert!(
        !last.contains("\u{2570}\u{2500} steering note"),
        "the agent message stays collapsed: {last}"
    );
    assert!(
        !last.contains("before the message"),
        "the thinking blocks stay hidden - the level never moved: {last}"
    );
}

/// Buttonless motion reports flow through the same decode-and-dispatch path.
#[test]
fn hover_motion_reports_do_not_disturb_the_click_grammar() {
    let frames = run_plan(
        vec![
            HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            HeadlessStep::WaitRender {
                needle: "print(7)".to_string(),
                timeout_ms: 5_000,
            },
        ],
        Vec::new(),
    );
    let (_, row, col) = locate(&frames, "print(7)").expect("the card renders before the motions");
    let motion = |col: usize, row: usize| HeadlessStep::Mouse(format!("\x1b[<35;{col};{row}M"));
    let frames = run_plan(
        vec![
            HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            HeadlessStep::WaitRender {
                needle: "print(7)".to_string(),
                timeout_ms: 5_000,
            },
            // Hover motions across the card row and the plain rows around it (the `?1003` any-event
            // reports the real terminal sends with the hover affordance active).
            motion(col + 1, row),
            motion(col + 1, row + 1),
            motion(3, 1),
            motion(col + 1, row),
            HeadlessStep::Mouse(press(col + 1, row + 1)),
            HeadlessStep::Mouse(release(col + 1, row + 1)),
            HeadlessStep::WaitRender {
                needle: "\u{2570}\u{2500} print(7)".to_string(),
                timeout_ms: 5_000,
            },
        ],
        Vec::new(),
    );
    let last = frames.last().expect("a frame after the click");
    assert!(
        last.contains("\u{2570}\u{2500} print(7)"),
        "the click expanded the card's own output after the hover motions: {last}"
    );
    assert!(
        last.contains("print(7)"),
        "the card keeps its own summary row: {last}"
    );
}

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
    // `world`'s first cell is the clicked one: the caret lands in front of the word, so the insert
    // splits `hello ` from `world`.
    let (_, row, col) = locate(&frames, "world").expect("the draft renders");
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

/// The clicked row carries the `›` marker, exactly like the arrows.
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
    let (_, row, col) = locate(&frames, "Mock Two").expect("the picker row renders");
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
            // Hold until the frame shows the marker on the clicked row.
            HeadlessStep::WaitRender {
                needle: "\u{203a} Mock Two".to_string(),
                timeout_ms: 5_000,
            },
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
