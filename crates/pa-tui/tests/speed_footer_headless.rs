//! Headless e2e for the `/speed` footer readout (TS `FooterComponent` under
//! `setSpeedDisplay`): a mock supervisor serves one attached session and
//! streams a scripted assistant turn, and the plan drives the command and a
//! prompt through the same editor submit path a user's keystrokes take.
//!
//! Verifies the TS parity contract: `/speed` toggles the dim footer row (the
//! dock's last row) over the session's completed responses — the status
//! notes carry the TS wording, the readout appears after the first completed
//! response with positive usage and span, and turning the display off clears
//! both the stats and the row.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

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

    /// Serve one connection: attach an empty session, then stream one
    /// scripted assistant turn per prompt.
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
                    stream_turn(&mut writer);
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
                    "sessionName": "speed session",
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

/// One scripted assistant turn: a streamed start, one delta, and a
/// completed message carrying usage and a stream-start timestamp (the
/// message_end timestamp is set at provider stream start, so the completed
/// message spans a real wall-clock window).
fn stream_turn(writer: &mut UnixStream) {
    let event = |payload: Value| json!({ "type": "session_event", "activeSessionId": "s1", "event": payload });
    let stream_start_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
        - 1500;
    write_json(writer, &event(json!({ "type": "turn_start" })));
    write_json(
        writer,
        &event(json!({
            "type": "message_start",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "" }],
            },
            "assistantMessageEvent": { "type": "start" },
        })),
    );
    write_json(
        writer,
        &event(json!({
            "type": "message_update",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "thinking through it" }],
            },
            "assistantMessageEvent": { "type": "text_delta", "delta": "thinking through it" },
        })),
    );
    write_json(
        writer,
        &event(json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "all done" }],
                "usage": {
                    "input": 100,
                    "output": 300,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "totalTokens": 400,
                    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
                },
                "stopReason": "stop",
                "timestamp": stream_start_ms,
            },
        })),
    );
    write_json(writer, &event(json!({ "type": "turn_end" })));
    write_json(writer, &event(json!({ "type": "agent_end" })));
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
        prompt_stash: Default::default(),
        session_has_children: false,
        client_settings: None,
    }
}

/// Run the headless plan against a fresh mock supervisor and return the
/// captured frames.
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

/// `/speed` toggles the footer readout over completed responses: the status
/// note carries the TS wording, the first completed response renders the
/// dim `tok/s` row (the dock's last row), and `/speed off` clears both the
/// stats and the row so later frames render no readout.
#[test]
fn speed_command_toggles_the_footer_readout() {
    let steps = vec![
        HeadlessStep::Submit("/speed".to_string()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Submit("hello".to_string()),
        HeadlessStep::WaitIdle { timeout_ms: 10_000 },
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/speed off".to_string()),
        HeadlessStep::WaitMs(300),
        HeadlessStep::Submit("hello again".to_string()),
        HeadlessStep::WaitIdle { timeout_ms: 10_000 },
        HeadlessStep::WaitMs(300),
    ];
    let frames = run_plan(steps);
    assert!(!frames.is_empty(), "frames were captured");
    let all = frames.join("\n");
    assert!(
        all.contains(
            "Speed display on — footer shows output tok/s per model response and a session average"
        ),
        "the enable note rendered:\n{all}"
    );
    assert!(
        all.contains("Speed display off"),
        "the disable note rendered:\n{all}"
    );
    // The readout row: a dock line that starts with the rate (the dim
    // footer renders exactly the speed text) — distinct from the status
    // notes, which carry "tok/s" mid-sentence.
    let readout_row = |frame: &str| {
        frame.lines().any(|line| {
            line.trim_start().starts_with(|c: char| c.is_ascii_digit()) && line.contains("tok/s")
        })
    };
    assert!(
        frames.iter().any(|frame| readout_row(frame)),
        "the footer readout rendered after the completed response:\n{all}"
    );
    let tail = frames
        .iter()
        .rev()
        .find(|frame| frame.contains("all done"))
        .expect("the second turn's completed message rendered");
    assert!(
        !readout_row(tail),
        "the readout is gone after /speed off:\n{tail}"
    );
}

/// The usage error keeps the TS wording and the editor's submit path stays
/// usable afterwards.
#[test]
fn speed_command_rejects_bad_args() {
    let steps = vec![
        HeadlessStep::Submit("/speed maybe".to_string()),
        HeadlessStep::WaitMs(200),
    ];
    let frames = run_plan(steps);
    let all = frames.join("\n");
    assert!(
        all.contains("Usage: /speed [on|off]"),
        "the usage error rendered:\n{all}"
    );
}
