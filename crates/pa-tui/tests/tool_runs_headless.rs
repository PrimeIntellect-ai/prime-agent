//! Headless e2e for the collapsed view's condensed activity runs (the
//! operator feature): a mock supervisor serves one attached session whose
//! replayed transcript carries eight ipython calls split across a
//! received agent message with hidden thinking around it - one >=3
//! activity-item run with the received row and a queued receipt merged
//! into its aggregate - a live-streamed six-call run, and a live
//! two-call turn that must NOT condense. Ctrl+O owns the detail levels:
//! overview condenses, details renders every card, notice, and thinking
//! block individually.
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

    /// Serve one connection: the attach replay, then two live prompt
    /// turns (a six-call run and a four-call run).
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
        let mut served_turns = 0usize;
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
                    let prompt = command
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    served_turns += 1;
                    serve_turn(&mut writer, &prompt, served_turns);
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

/// One live streamed turn: an assistant message with hidden thinking and
/// `calls` ipython tool calls, the execution lifecycle for each call, the
/// turn end, and the agent drain.
fn serve_turn(writer: &mut UnixStream, prompt: &str, turn: usize) {
    let event = |payload: Value| json!({ "type": "session_event", "activeSessionId": "s1", "event": payload });
    let calls = if prompt.contains("short") { 2 } else { 6 };
    // Tool-call ids are unique per invocation (the real daemon's ids are
    // fresh per call): the TUI upserts streamed cards BY ID, so a reused
    // id updates the earlier invocation's card instead of opening a new
    // one.
    let call_id = |index: usize| format!("live{turn}_c{index}");
    // The daemon echoes the submitted prompt as the turn's user message:
    // the TUI renders the user row from this event.
    write_json(
        writer,
        &event(json!({
            "type": "message_start",
            "message": { "role": "user", "content": prompt, "timestamp": 50u64 },
        })),
    );
    let tool_calls: Vec<Value> = (0..calls)
        .map(|index| {
            json!({
                "type": "toolCall",
                "id": call_id(index),
                "name": "ipython",
                "arguments": { "code": format!("print({index})") },
            })
        })
        .collect();
    let message = json!({
        "role": "assistant",
        "content": [
            { "type": "thinking", "thinking": "thinking through it" },
        ],
        "timestamp": 100u64,
    });
    let message_with_calls = {
        let mut message = message;
        if let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) {
            content.extend(tool_calls);
        }
        message
    };
    for kind in ["message_start", "message_update", "message_end"] {
        let mut payload = json!({ "type": kind, "message": message_with_calls });
        if kind == "message_start" {
            payload["assistantMessageEvent"] = json!({ "type": "start" });
        }
        write_json(writer, &event(payload));
    }
    for index in 0..calls {
        write_json(
            writer,
            &event(json!({
                "type": "tool_execution_start",
                "toolCallId": call_id(index),
                "toolName": "ipython",
                "args": { "code": format!("print({index})") },
            })),
        );
        let mut details = json!({ "status": "ok", "durationMs": 20 });
        if index == 2 {
            // The queued receipt folds into the run's breakdown.
            details["sentAgentMessages"] = json!([
                {
                    "id": "amq_1",
                    "message": "queued note",
                    "deliveryStatus": "queued",
                    "receiverRole": "parent",
                }
            ]);
        }
        write_json(
            writer,
            &event(json!({
                "type": "tool_execution_end",
                "toolCallId": call_id(index),
                "result": {
                    "content": [{ "type": "text", "text": format!("out {index}") }],
                    "details": details,
                },
                "isError": false,
            })),
        );
    }
    write_json(writer, &event(json!({ "type": "turn_end" })));
    write_json(writer, &event(json!({ "type": "agent_end" })));
}

fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

/// The replayed transcript: eight ipython calls whose only separator
/// is a received agent message between two hidden-thinking stretches -
/// one activity run of eight calls plus the received row (a member, not
/// a boundary) with a queued receipt riding c5's result, so ONE
/// aggregate renders with both kinds counted. The wire timestamps carry
/// an honest 62-second wall clock.
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
        // c5's result carries the queued agent-message receipt (the
        // `agent_message.send` tool's undelivered marker): it folds into
        // the condensed group's breakdown.
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
                    "sessionName": "runs session",
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

fn options(socket: PathBuf) -> InteractiveOptions {
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
        prompt_stash: Default::default(),
        session_has_children: false,
        client_settings: None,
    }
}

fn ctrl_o() -> KeyEvent {
    KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL)
}

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
        height: 34,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    let _ = handle.join();
    outcome.frames
}

#[test]
fn replayed_runs_condense_with_the_received_message_merged() {
    // The condensed block renders at the collapsed overview level; a
    // chat starts at the middle details level, so the plan cycles down
    // (details -> all -> overview) before asserting the transcript.
    let frames = run_plan(vec![
        HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        HeadlessStep::Key(ctrl_o()),
        HeadlessStep::Key(ctrl_o()),
    ]);
    let last = frames.last().expect("a final frame");
    assert!(
        last.contains("8 tool calls \u{b7} 2 agent messages"),
        "the ONE aggregate spans the whole interleaved run: {last}"
    );
    assert!(
        last.contains(
            "\u{2570}\u{2500} 8 python \u{b7} 1 agent messages received \u{b7} 1 agent messages queued",
        ),
        "the breakdown carries the classes, the received row, and the queued receipt: {last}"
    );
    assert!(
        last.contains("62s"),
        "the wire timestamps carry the honest wall clock (63s - 1s): {last}"
    );
    assert!(
        !last.contains("Agent message received"),
        "the received notice renders nothing of its own inside the run: {last}"
    );
}

#[test]
fn details_renders_every_item_the_overview_condensed() {
    // The Ctrl+O path: the same replayed transcript at the startup
    // details level renders every card, the received notice's own row,
    // and the hidden thinking individually - no condensed block at all.
    let frames = run_plan(vec![HeadlessStep::WaitIdle { timeout_ms: 30_000 }]);
    let last = frames.last().expect("a final frame");
    assert!(
        !last.contains("tool calls"),
        "no condensed block at the details level: {last}"
    );
    assert!(
        last.contains("Agent message received"),
        "the notice keeps its own row at details: {last}"
    );
    assert!(
        last.contains("steering note"),
        "the notice's content stays visible: {last}"
    );
    assert!(
        last.contains("before the message"),
        "the thinking is visible at details: {last}"
    );
    assert!(
        last.contains("print(3)"),
        "every card renders its own rows: {last}"
    );
}

#[test]
fn live_runs_condense_and_short_runs_do_not() {
    // Cycle the transcript to the collapsed overview level first: the
    // condensed blocks render there, and the live turns stream onto it.
    let frames = run_plan(vec![
        HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        HeadlessStep::Key(ctrl_o()),
        HeadlessStep::Key(ctrl_o()),
        HeadlessStep::Submit("live one".to_string()),
        HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        HeadlessStep::Submit("keep it short".to_string()),
        HeadlessStep::WaitIdle { timeout_ms: 30_000 },
    ]);
    let tail = frames
        .iter()
        .rev()
        .find(|frame| frame.contains("keep it short"))
        .expect("the short turn rendered");
    assert!(
        tail.contains("6 tool calls"),
        "the live six-call run condenses: {tail}"
    );
    assert!(
        tail.contains("\u{2570}\u{2500} 6 python \u{b7} 1 agent messages queued"),
        "the live run's receipts fold into the breakdown: {tail}"
    );
    assert!(
        !tail.contains("2 tool calls"),
        "the two-call turn never condenses: {tail}"
    );
    assert!(
        tail.contains("print(1)"),
        "the short turn's cards render their own rows: {tail}"
    );
}
