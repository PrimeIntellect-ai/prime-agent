//! Headless e2e for the live tool-call timer (operator feature
//! 2026-10-03): while a tool call executes with no stream events, its card
//! shows the elapsed time ticking up, and once the result lands the
//! ticking stops and the card shows the final static duration — the
//! exact `Took` row the settled card always rendered. The red first:
//! a running card showed no duration until the first partial result
//! arrived, so a quiet tool run (no output) left the card with no
//! timing at all.
// - the mock's serve loop is one flat request table (one arm per
// command); splitting it would add indirection without changing the
// flow.
#![allow(clippy::too_many_lines)]
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// One mock daemon: serves one client connection, answering the attach
/// with a mid-turn snapshot and then running one quiet tool call — a
/// `tool_execution_start` frame, a silent window, the final
/// `tool_execution_end`, and `turn_end`.
struct MockSupervisor {
    listener: UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
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
                    // The quiet tool run happens from a side thread (the
                    // reader loop keeps answering the client's post-attach
                    // requests): start the call, stay silent while it
                    // executes, then land the final result and end the
                    // turn.
                    let mut event_writer = writer.try_clone().expect("clone event socket");
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        write_json(
                            &mut event_writer,
                            &json!({
                                "type": "session_event",
                                "activeSessionId": "s1",
                                "event": {
                                    "type": "tool_execution_start",
                                    "toolCallId": "call_1",
                                    "toolName": "bash",
                                    "args": { "command": "sleep 1" },
                                },
                            }),
                        );
                        std::thread::sleep(std::time::Duration::from_millis(TOOL_RUN_MS));
                        write_json(
                            &mut event_writer,
                            &json!({
                                "type": "session_event",
                                "activeSessionId": "s1",
                                "event": {
                                    "type": "tool_execution_end",
                                    "toolCallId": "call_1",
                                    "toolName": "bash",
                                    "result": {
                                        "content": [{ "type": "text", "text": "ok" }],
                                        "isError": false,
                                    },
                                },
                            }),
                        );
                        write_json(
                            &mut event_writer,
                            &json!({
                                "type": "session_event",
                                "activeSessionId": "s1",
                                "event": { "type": "turn_end" },
                            }),
                        );
                    });
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

/// The attach result: a streaming mid-turn snapshot whose prompt landed
/// just now, so the working loader (and the turn) is active when the
/// tool call starts.
fn attach_data(id: &str) -> Value {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after the epoch")
        .as_millis();
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
                    "sessionName": "live timer session",
                    "model": null,
                    "isStreaming": true,
                    "isCompacting": false,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                },
                "messages": [
                    {
                        "role": "user",
                        "content": [{ "type": "text", "text": "run the sweep" }],
                        "timestamp": now_ms,
                    },
                ],
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

/// How long the mock's tool call runs with no stream events.
const TOOL_RUN_MS: u64 = 1200;

/// The duration one card row paints, in tenths of a second: the `X.Y`
/// of an `Elapsed X.Ys` (or `Took X.Ys`) row.
fn row_tenths(frame: &str, label: &str) -> Option<u64> {
    let line = frame.lines().find(|line| line.contains(label))?;
    let value = line.split(label).nth(1)?;
    let value = value.trim_end().trim_end_matches('s').trim();
    let (whole, frac) = value.split_once('.')?;
    let tenths = u64::from(frac.chars().next()?.to_digit(10)?);
    Some(whole.parse::<u64>().ok()? * 10 + tenths)
}

#[test]
fn a_running_tool_card_ticks_and_settles_to_the_final_duration() {
    // The ambient TMUX variable adds a startup notice to the
    // transcript; scrub it so the run is the same inside tmux and out.
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket);
    let handle = std::thread::spawn(move || supervisor.serve());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    // No input during the run: the loader's own phase wake repaints the
    // running card, and the live timer rides those paints.
    let plan = HeadlessPlan {
        steps: vec![HeadlessStep::WaitMs(2200)],
        width: 100,
        height: 40,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");

    // The ticking phase: every frame that shows the running card paints
    // its elapsed, and the painted values advance with the repaints.
    let ticks: Vec<u64> = outcome
        .frames
        .iter()
        .filter_map(|frame| row_tenths(frame, "Elapsed "))
        .collect();
    assert!(
        ticks.len() >= 3,
        "the quiet tool run repaints the card with a live duration:\n{}",
        outcome.frames.join("\n===\n")
    );
    assert!(
        ticks.windows(2).all(|pair| pair[0] <= pair[1]),
        "the live duration only ticks up: {ticks:?}"
    );
    let distinct = ticks.iter().collect::<std::collections::HashSet<_>>();
    assert!(
        distinct.len() >= 3,
        "the live duration advances through the run: {ticks:?}"
    );

    // The settle: the final result lands and the ticking stops — the
    // settled card carries the static `Took` row and never an `Elapsed`
    // row again.
    let settle = outcome
        .frames
        .iter()
        .position(|frame| row_tenths(frame, "Took ").is_some())
        .expect("the settled card paints its final duration");
    let took = row_tenths(&outcome.frames[settle], "Took ").expect("the took row parses");
    assert!(
        took >= ticks.iter().copied().max().unwrap_or_default(),
        "the final duration covers the whole run (tenths of a second): \
         took {took}, live max {:?}",
        ticks.iter().copied().max()
    );
    let settled_tickers = outcome.frames[settle..]
        .iter()
        .filter(|frame| frame.contains("Elapsed "))
        .count();
    assert_eq!(
        settled_tickers,
        0,
        "the settled card never ticks again:\n{}",
        outcome.frames[settle..].join("\n===\n")
    );
}
