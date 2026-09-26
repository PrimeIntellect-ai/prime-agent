//! TUI RSS stability regression: a long scripted session streamed through the
//! real interactive loop (headless renderer) must not grow memory
//! monotonically. The owner-facing watchdog report is TUI processes at 8GB+
//! RSS during long sessions; the classes under test are transcript/ChatEntry
//! retention per frame, event-buffer retention in the daemon client, and
//! snapshot replay copies.
//!
//! Method: an in-process mock supervisor speaks the same JSONL wire protocol
//! (`daemon_hello`, response envelopes, streamed session events) and serves
//! one long session: many turns, each with streamed assistant deltas, tool
//! calls with large results, and turn completion. A background sampler
//! reads `/proc/self/statm` while the interactive loop runs; the assertion
//! is a plateau: resident memory in the last quarter of the run must sit
//! within a bounded delta of the warm-up state.
//!
//! Linux-only by construction (`/proc/self/statm`, `AF_UNIX` mock sockets);
//! the whole file compiles to nothing elsewhere (Windows RSS regression
//! needs its own counter path; see docs/windows-readiness.md).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::time::Duration;

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// Resident memory of this process in bytes.
fn resident_bytes() -> u64 {
    let statm = std::fs::read_to_string("/proc/self/statm").expect("read statm");
    let pages: u64 = statm
        .split_whitespace()
        .nth(1)
        .expect("resident field")
        .parse()
        .expect("page count");
    pages * 4096
}

/// The plateau allowance: transient allocator growth plus the headless
/// harness's own retained frames (one small text per distinct frame).
const PLATEAU_BYTES: u64 = 256 * 1024 * 1024;

struct MockSupervisor {
    listener: UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// Serve one connection to completion: the interactive loop's requests
    /// plus the scripted event stream.
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
                    let mut data = attach_data();
                    data["id"] = json!(id);
                    write_json(&mut writer, &data);
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

/// The slim attach snapshot shape (`createAttachResult`).
fn attach_data() -> Value {
    json!({
        "type": "response",
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
                    "sessionName": "rss session",
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

/// The per-turn pacing floor: the mock streams turns as fast as the loop
/// can consume them, so on an idle box the whole scripted session finished
/// in under 0.8s and the 100ms RSS sampler collected fewer than the eight
/// samples the plateau analysis needs (a load-flake: the session ran
/// FASTER unloaded). Pacing the producer gives the session a deterministic
/// minimum duration (40 turns x 50ms = 2s) independent of machine speed,
/// so the sample count stays far above the floor under any legitimate
/// load. The plateau assertion itself is unchanged: resident memory in
/// the last quarter of the run must stay within the allowance of the
/// warm-up state.
const TURN_PACE: Duration = Duration::from_millis(50);

/// One scripted turn: streamed assistant text deltas, a tool call with a
/// large result, and turn completion. Larger than typical turns on purpose:
/// any per-frame or per-event retention becomes visible quickly.
fn stream_turn(writer: &mut UnixStream) {
    const DELTAS: usize = 30;
    std::thread::sleep(TURN_PACE);
    let event = |payload: Value| json!({ "type": "session_event", "activeSessionId": "s1", "event": payload });
    write_json(writer, &event(json!({ "type": "turn_start" })));
    write_json(
        writer,
        &event(json!({
            "type": "message_start",
            "message": { "role": "user", "content": "keep working" },
        })),
    );
    // Assistant stream: start, deltas, tool call, end.
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
    for delta in 0..DELTAS {
        let text = format!("chunk {delta} with some content to render. ");
        write_json(
            writer,
            &event(json!({
                "type": "message_update",
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": text.repeat(delta + 1) },
                        { "type": "toolCall", "id": "tc-1", "name": "bash", "arguments": { "command": "ls -la" } },
                    ],
                },
                "assistantMessageEvent": { "type": "text_delta", "delta": text },
            })),
        );
    }
    write_json(
        writer,
        &event(json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "done with the turn" },
                    { "type": "toolCall", "id": "tc-1", "name": "bash", "arguments": { "command": "ls -la" } },
                ],
            },
        })),
    );
    // Tool execution with partial and final results (large outputs).
    write_json(
        writer,
        &event(json!({
            "type": "tool_execution_start",
            "toolCallId": "tc-1",
            "toolName": "bash",
            "args": { "command": "ls -la" },
        })),
    );
    for partial in 0..4 {
        write_json(
            writer,
            &event(json!({
                "type": "tool_execution_update",
                "toolCallId": "tc-1",
                "partialResult": {
                    "content": [{ "type": "text", "text": format!("partial output {partial}: {}", "x".repeat(4096)) }]
                },
            })),
        );
    }
    write_json(
        writer,
        &event(json!({
            "type": "tool_execution_end",
            "toolCallId": "tc-1",
            "result": {
                "content": [{ "type": "text", "text": format!("final output: {}", "y".repeat(16 * 1024)) }]
            },
            "isError": false,
        })),
    );
    write_json(writer, &event(json!({ "type": "turn_end" })));
    write_json(writer, &event(json!({ "type": "agent_end" })));
}

/// A long scripted session must not grow the TUI's resident memory without
/// bound: the transcript grows with the session (as designed), but no
/// per-frame or per-event class may accumulate.
#[test]
fn interactive_session_rss_plateaus_over_long_stream() {
    const TURNS: usize = 40;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket);

    let mut steps = Vec::new();
    for turn in 0..TURNS {
        steps.push(HeadlessStep::Submit(format!("prompt {turn}")));
        steps.push(HeadlessStep::WaitIdle { timeout_ms: 30_000 });
    }
    let options = InteractiveOptions {
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
    };
    let plan = HeadlessPlan {
        steps,
        width: 100,
        height: 30,
    };

    // RSS sampler: every 100ms while the session runs.
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let samples = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u64>::new()));
    let sampler_samples = std::sync::Arc::clone(&samples);
    let sampler = std::thread::spawn(move || loop {
        sampler_samples.lock().unwrap().push(resident_bytes());
        if stop_rx.recv_timeout(Duration::from_millis(100)).is_ok() {
            break;
        }
    });

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    // The mock runs on its own blocking thread; the interactive loop runs
    // on the runtime.
    let handle = std::thread::spawn(move || supervisor.serve());
    let (outcome_tx, outcome_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = runtime.block_on(run_interactive(options, UiMode::Headless(plan)));
        let _ = outcome_tx.send(result);
    });

    let outcome = outcome_rx
        .recv_timeout(Duration::from_mins(5))
        .expect("interactive run finished");
    let _ = stop_tx.send(());
    let _ = sampler.join();
    let _ = handle.join();

    let outcome = outcome.expect("interactive run succeeded");
    assert_eq!(outcome.active_session_id, "s1");

    // Plateau analysis on the resident-memory samples.
    let samples = samples.lock().unwrap().clone();
    assert!(
        samples.len() >= 8,
        "RSS sampling looked broken ({} samples)",
        samples.len()
    );
    let first = samples[0];
    let warmup = samples[samples.len() / 4];
    let last_quarter = &samples[(samples.len() * 3) / 4..];
    let max_last = last_quarter.iter().copied().max().unwrap_or_default();
    println!(
        "rss samples: first={first} warmup={warmup} max_last_quarter={max_last} ({} samples)",
        samples.len()
    );
    assert!(
        max_last <= warmup + PLATEAU_BYTES,
        "TUI resident memory grew past the plateau allowance: warmup {warmup} bytes, \
         last-quarter max {max_last} bytes"
    );
    assert!(
        max_last <= first + PLATEAU_BYTES * 2,
        "TUI resident memory grew monotonically across the session: first {first}, \
         last-quarter max {max_last}"
    );
}
