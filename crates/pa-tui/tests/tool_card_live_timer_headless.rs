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
    /// The scripted frame sequence the mock daemon streams after the
    /// attach (one scenario per test).
    scenario: Scenario,
}

/// The attach-then-stream scenarios: which frames the mock writes decides
/// which settle path the test drives.
#[derive(Clone, Copy, PartialEq)]
enum Scenario {
    /// The quiet bash run: start, silent window, end, `turn_end`.
    Quiet,
    /// A streamed call never receives its execution-start frame before turn end.
    Queued,
    /// A completed call is repeated by a later streaming assistant update.
    CompletedRestream,
    /// The bash straggler: the end frame is dropped, so the turn's settle
    /// freezes the card; then a late end frame and a late start (the
    /// retick probe) must both land on nothing.
    Straggler,
    /// The `python_repl` straggler: same shape with the ipython shell, so
    /// the summary's duration slot freezes instead of vanishing.
    IpythonStraggler,
    /// The lost turn: turn one's call never ends and its `turn_end`
    /// never lands; turn two's `turn_start` settles turn one's leftover
    /// card (partial preserved, stale timer stopped) and runs to its
    /// own settle.
    LostTurn,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path, scenario: Scenario) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            scenario,
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
        // macOS inherits O_NONBLOCK from the listener on accept; the request loop blocks.
        stream.set_nonblocking(false).expect("blocking mock stream");
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
                    // The scripted stream happens from a side thread
                    // (the reader loop keeps answering the client's
                    // post-attach requests); the events queue on the
                    // socket behind the attach response, so the client
                    // consumes them in order (the same shape as the
                    // quiet-tick stream mock) — no readiness sleep to
                    // race.
                    let scenario = self.scenario;
                    let mut w = writer.try_clone().expect("clone event socket");
                    std::thread::spawn(move || {
                        match scenario {
                            Scenario::Quiet => {
                                tool_start(
                                    &mut w,
                                    "call_1",
                                    "bash",
                                    &json!({ "command": "sleep 1" }),
                                );
                                std::thread::sleep(std::time::Duration::from_millis(TOOL_RUN_MS));
                                tool_end(&mut w, "call_1", "bash", "ok");
                                event(&mut w, &json!({ "type": "turn_end" }));
                            }
                            Scenario::Queued => {
                                event(
                                    &mut w,
                                    &json!({
                                        "type": "message_update",
                                        "message": {
                                            "role": "assistant",
                                            "content": [{
                                                "type": "toolCall",
                                                "id": "call_queued",
                                                "name": "bash",
                                                "arguments": { "command": "echo never started" },
                                            }],
                                        },
                                    }),
                                );
                                event(&mut w, &json!({ "type": "turn_end" }));
                                drain_barrier(&mut w);
                            }
                            Scenario::CompletedRestream => {
                                tool_start(
                                    &mut w,
                                    "call_complete",
                                    "bash",
                                    &json!({ "command": "echo finished call output" }),
                                );
                                tool_end(&mut w, "call_complete", "bash", "finished call output");
                                event(
                                    &mut w,
                                    &json!({
                                        "type": "message_update",
                                        "message": {
                                            "role": "assistant",
                                            "content": [{
                                                "type": "toolCall",
                                                "id": "call_complete",
                                                "name": "bash",
                                                "arguments": { "command": "echo finished call output" },
                                            }],
                                        },
                                    }),
                                );
                                event(&mut w, &json!({ "type": "turn_end" }));
                                drain_barrier(&mut w);
                            }
                            Scenario::Straggler => {
                                tool_start(
                                    &mut w,
                                    "call_1",
                                    "bash",
                                    &json!({ "command": "sleep 1" }),
                                );
                                std::thread::sleep(std::time::Duration::from_millis(TOOL_RUN_MS));
                                // The end frame is dropped: the turn
                                // settles with a still-running card.
                                event(&mut w, &json!({ "type": "turn_end" }));
                                // The probes, after the turn: a late end
                                // (the resurrection probe — the aborted
                                // stamp must keep it landing on nothing)
                                // and a late start (the retick probe —
                                // outside a live turn it must land on
                                // nothing too, no fresh ticking card).
                                std::thread::sleep(std::time::Duration::from_millis(250));
                                tool_end(&mut w, "call_1", "bash", "late frame resurrection");
                                tool_start(
                                    &mut w,
                                    "call_1",
                                    "bash",
                                    &json!({ "command": "sleep 2" }),
                                );
                                drain_barrier(&mut w);
                            }
                            Scenario::IpythonStraggler => {
                                tool_start(
                                    &mut w,
                                    "call_1",
                                    "ipython",
                                    &json!({ "code": "print('x')" }),
                                );
                                std::thread::sleep(std::time::Duration::from_millis(300));
                                // The cell streams a partial before the turn
                                // cuts it off: the settle keeps the streamed
                                // output but must still close the card as an
                                // ERROR — an unfinished cell never renders
                                // the success checkmark.
                                event(
                                    &mut w,
                                    &json!({
                                        "type": "tool_execution_update",
                                        "toolCallId": "call_1",
                                        "partialResult": {
                                            "content": [{
                                                "type": "text",
                                                "text": "streamed cell output",
                                            }],
                                        },
                                    }),
                                );
                                std::thread::sleep(std::time::Duration::from_millis(TOOL_RUN_MS));
                                event(&mut w, &json!({ "type": "turn_end" }));
                                drain_barrier(&mut w);
                            }
                            Scenario::LostTurn => {
                                // Turn one (the attach's streaming turn):
                                // a start and a streamed partial, but the
                                // end frame AND the turn's own `turn_end`
                                // never land — the turn is lost.
                                tool_start(
                                    &mut w,
                                    "call_1",
                                    "bash",
                                    &json!({ "command": "sleep 1" }),
                                );
                                std::thread::sleep(std::time::Duration::from_millis(300));
                                event(
                                    &mut w,
                                    &json!({
                                        "type": "tool_execution_update",
                                        "toolCallId": "call_1",
                                        "partialResult": {
                                            "content": [{
                                                "type": "text",
                                                "text": "turn one partial output",
                                            }],
                                        },
                                    }),
                                );
                                // Turn two (its own call id) runs to its
                                // own settle; the pending-scoped sweep
                                // must leave turn one's card alone.
                                std::thread::sleep(std::time::Duration::from_millis(300));
                                event(&mut w, &json!({ "type": "turn_start" }));
                                tool_start(
                                    &mut w,
                                    "call_2",
                                    "bash",
                                    &json!({ "command": "sleep 2" }),
                                );
                                std::thread::sleep(std::time::Duration::from_millis(300));
                                tool_end(&mut w, "call_2", "bash", "turn two output");
                                event(&mut w, &json!({ "type": "turn_end" }));
                                drain_barrier(&mut w);
                            }
                        }
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

/// One session event frame on the mock socket.
fn event(writer: &mut UnixStream, payload: &Value) {
    write_json(
        writer,
        &json!({
            "type": "session_event",
            "activeSessionId": "s1",
            "event": payload,
        }),
    );
}

/// The `tool_execution_start` frame for one call id.
fn tool_start(writer: &mut UnixStream, call_id: &str, tool: &str, args: &Value) {
    event(
        writer,
        &json!({
            "type": "tool_execution_start",
            "toolCallId": call_id,
            "toolName": tool,
            "args": args,
        }),
    );
}

/// The `tool_execution_end` frame for one call id.
fn tool_end(writer: &mut UnixStream, call_id: &str, tool: &str, text: &str) {
    event(
        writer,
        &json!({
            "type": "tool_execution_end",
            "toolCallId": call_id,
            "toolName": tool,
            "result": {
                "content": [{ "type": "text", "text": text }],
                "isError": false,
            },
        }),
    );
}

/// The drain barrier: a visible user row whose render is the observable
/// proof the frames written just before it on the same socket were
/// processed first, so the tests' negative assertions cannot pass
/// vacuously when the plan finishes early.
fn drain_barrier(writer: &mut UnixStream) {
    event(
        writer,
        &json!({
            "type": "message_start",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "late-probe-drained" }],
            },
        }),
    );
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
    let supervisor = MockSupervisor::bind(&socket, Scenario::Quiet);
    let handle = std::thread::spawn(move || supervisor.serve());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    // No input during the run: the loader's own phase wake repaints the
    // running card, and the live timer rides those paints. The plan holds
    // on observable conditions, not wall-clock guesses: the first live
    // tick, then the settled card's static row.
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::WaitRender {
                needle: "Elapsed ".to_string(),
                timeout_ms: 5000,
            },
            HeadlessStep::WaitRender {
                needle: "Took ".to_string(),
                timeout_ms: 5000,
            },
        ],
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

/// The straggler: a tool call whose end frame never lands still gets its
/// timer frozen at the turn's settle — the `turn_end` sweep settles the card
/// the way the failed-frame sweep does (a terminal error result, the
/// settle instant, the aborted stamp): the frozen `Took` row renders, the
/// panel header is terminal (no running spinner), no later paint ticks
/// `Elapsed`, and the late end frame lands on nothing.
#[test]
fn a_straggler_tool_card_freezes_at_the_turn_settle() {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket, Scenario::Straggler);
    let handle = std::thread::spawn(move || supervisor.serve());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::WaitRender {
                needle: "Elapsed ".to_string(),
                timeout_ms: 5000,
            },
            HeadlessStep::WaitRender {
                needle: "Took ".to_string(),
                timeout_ms: 5000,
            },
            // The drain barrier: the late end frame is followed on the
            // same socket by the marker render, so waiting for the marker
            // proves the late frame was processed first — the
            // no-resurrection assertion cannot pass vacuously.
            HeadlessStep::WaitRender {
                needle: "late-probe-drained".to_string(),
                timeout_ms: 5000,
            },
            HeadlessStep::WaitIdle { timeout_ms: 5000 },
        ],
        width: 100,
        height: 40,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    let settle = outcome
        .frames
        .iter()
        .position(|frame| frame.contains("Took "))
        .expect("the straggler's timer froze at the turn settle");
    // A timed-out WaitRender only notes; assert the barrier rendered,
    // so the negatives below are read only after the late frame
    // demonstrably drained.
    assert!(
        outcome.frames[settle..]
            .iter()
            .any(|frame| frame.contains("late-probe-drained")),
        "the drain barrier rendered:\n{}",
        outcome.frames[settle..].join("\n===\n")
    );
    let rendered = outcome.frames[settle..].join("\n===\n");
    assert!(
        !rendered.contains("Elapsed "),
        "the frozen straggler never ticks again:
{rendered}"
    );
    assert!(
        !rendered.contains("running"),
        "the settled straggler carries a terminal header, not a running spinner:
{rendered}"
    );
    assert!(
        !rendered.contains("resurrection"),
        "the late end frame lands on the aborted straggler:
{rendered}"
    );
}

/// The lost turn: turn one's call never ends and its `turn_end` never
/// lands. Turn two's `turn_start` is the definitive end of turn one: its
/// leftover pending card settles there — the streamed partial output
/// preserved, the card terminal, its stale timer and header stopped from
/// ticking into turn two's paints — while the pending-scoped turn-end
/// sweep never stamps a card the turn did not track.
#[test]
fn a_lost_turns_card_settles_when_the_next_turn_starts() {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket, Scenario::LostTurn);
    let handle = std::thread::spawn(move || supervisor.serve());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::WaitRender {
                needle: "turn one partial output".to_string(),
                timeout_ms: 5000,
            },
            HeadlessStep::WaitRender {
                needle: "Took ".to_string(),
                timeout_ms: 5000,
            },
            HeadlessStep::WaitRender {
                needle: "late-probe-drained".to_string(),
                timeout_ms: 5000,
            },
            HeadlessStep::WaitIdle { timeout_ms: 5000 },
        ],
        width: 100,
        height: 40,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    // The barrier rendered: the assertions below are read only after turn
    // two's settle demonstrably drained — both calls are terminal by then,
    // so no card may tick or spin past it.
    let barrier = outcome
        .frames
        .iter()
        .position(|frame| frame.contains("late-probe-drained"))
        .expect("the drain barrier rendered");
    let settled = outcome.frames[barrier..].join("\n===\n");
    assert!(
        settled.contains("turn one partial output"),
        "the lost turn's streamed output survives the settle:\n{settled}"
    );
    assert!(
        !settled.contains("Elapsed "),
        "the lost turn's stale timer never ticks past the new turn's settle:\n{settled}"
    );
    assert!(
        !settled.contains("running"),
        "the lost turn's header is terminal, not a running spinner:\n{settled}"
    );
    assert!(
        settled.contains("turn two output"),
        "turn two's own call settles normally:\n{settled}"
    );
}

/// The `python_repl` straggler: the summary's duration slot ticks while the
/// cell runs, and at the settle it FREEZES on the run's honest duration
/// (from the card timestamps) instead of vanishing — the
/// bash panel keeps its static `Took` row from the same timestamps, and
/// the ipython summary keeps its duration segment.
#[test]
fn a_python_repl_straggler_freezes_its_duration_slot() {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket, Scenario::IpythonStraggler);
    let handle = std::thread::spawn(move || supervisor.serve());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::WaitRender {
                needle: "\u{2191} 1 lines".to_string(),
                timeout_ms: 5000,
            },
            // The settle marker: the terminal error status replaces the
            // working spinner.
            HeadlessStep::WaitRender {
                needle: "\u{2717}".to_string(),
                timeout_ms: 5000,
            },
            HeadlessStep::WaitRender {
                needle: "late-probe-drained".to_string(),
                timeout_ms: 5000,
            },
            HeadlessStep::WaitIdle { timeout_ms: 5000 },
        ],
        width: 100,
        height: 40,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    let settle = outcome
        .frames
        .iter()
        .position(|frame| frame.contains("\u{2717}"))
        .expect("the settled cell renders the error marker");
    assert!(
        outcome.frames[settle..]
            .iter()
            .any(|frame| frame.contains("late-probe-drained")),
        "the drain barrier rendered:\n{}",
        outcome.frames[settle..].join("\n===")
    );
    // The frozen duration: the summary's last segment on the settled
    // frame parses as the run's duration from the card timestamps.
    let settled = &outcome.frames[settle..];
    let with_duration = settled
        .iter()
        .filter_map(|frame| {
            frame
                .lines()
                .find(|line| line.contains("\u{2717} python"))
                .map(std::string::ToString::to_string)
        })
        .collect::<Vec<_>>();
    assert!(
        !with_duration.is_empty(),
        "the settled cell's summary renders:\n{}",
        settled.join("\n===")
    );
    let summary = with_duration[0].clone();
    let duration_part = summary
        .rsplit(" \u{00b7} ")
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    assert!(
        (duration_part.ends_with('s')
            && duration_part.trim_end_matches('s').parse::<f64>().is_ok())
            || (duration_part.ends_with("ms")
                && duration_part.trim_end_matches("ms").parse::<f64>().is_ok()),
        "the summary's duration slot freezes on the run's duration, not vanishes:\n{summary}"
    );
}

/// A queued streamed call must settle even when execution never started.
#[test]
fn a_queued_tool_card_settles_at_the_turn_boundary() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket, Scenario::Queued);
    let handle = std::thread::spawn(move || supervisor.serve());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::WaitRender {
                needle: "late-probe-drained".to_string(),
                timeout_ms: 5000,
            },
            HeadlessStep::WaitIdle { timeout_ms: 5000 },
        ],
        width: 100,
        height: 40,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    let settled = outcome.frames.last().expect("the drained frame rendered");
    assert!(
        settled.contains("the turn ended before this call returned"),
        "the queued call must settle: {settled}"
    );
    assert!(
        !settled.contains("queued"),
        "the queued state survived: {settled}"
    );
}

/// Later assistant updates repeat completed tool IDs; turn end must keep their success.
#[test]
fn a_completed_tool_repeated_by_a_streaming_update_stays_successful() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket, Scenario::CompletedRestream);
    let handle = std::thread::spawn(move || supervisor.serve());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::WaitRender {
                needle: "late-probe-drained".to_string(),
                timeout_ms: 5000,
            },
            HeadlessStep::WaitIdle { timeout_ms: 5000 },
        ],
        width: 100,
        height: 40,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    let settled = outcome.frames.last().expect("the drained frame rendered");
    assert!(
        settled.contains("finished call output"),
        "output lost: {settled}"
    );
    assert!(
        settled.contains("bash \u{00b7} done"),
        "completed call lost its success: {settled}"
    );
}
