//! TUI RSS stability regression: a long scripted session through the real
//! interactive loop must not grow memory monotonically; a sampler reads
//! `/proc/self/statm` and asserts a plateau in the last quarter. Linux-only
//! by construction (compiles to nothing elsewhere).
#![cfg(unix)]
#![warn(clippy::allow_attributes_without_reason)]

mod support;

use std::os::unix::net::UnixStream;
use std::time::Duration;

use pa_tui::interactive::{run_interactive, HeadlessPlan, HeadlessStep, UiMode};
use serde_json::{json, Value};

use support::{
    attach_response, create_response, detach_response, serve_connection, session_stats_response,
    write_json, MockSupervisor, Request,
};

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

/// The plateau allowance: transient allocator growth plus the headless harness's own retained
/// frames (one small text per distinct frame).
const PLATEAU_BYTES: u64 = 256 * 1024 * 1024;

impl MockSupervisor {
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        serve_connection(stream, &[], |writer, Request { id, kind, .. }| {
            match kind {
                "create" => {
                    write_json(writer, &create_response(id));
                }
                "attach" => {
                    write_json(writer, &attach_response(id, "rss session"));
                }
                "get_session_stats" => {
                    write_json(writer, &session_stats_response(id));
                }
                "prompt" => {
                    write_json(
                        writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "prompt",
                            "success": true,
                        }),
                    );
                    stream_turn(writer);
                }
                "detach" => {
                    write_json(writer, &detach_response(id));
                }
                _ => return false,
            }
            true
        });
    }
}

/// The per-turn pacing floor: unloaded, the scripted session ran faster than the 100ms RSS sampler
/// could collect the eight samples the plateau analysis needs. Pacing the producer gives a
/// deterministic minimum duration (40 turns x 50ms = 2s), so the samples stay above the floor.
const TURN_PACE: Duration = Duration::from_millis(50);

/// One scripted turn: streamed assistant text deltas, a tool call with a large result, and turn
/// completion. Larger than typical turns on purpose: per-frame retention becomes visible quickly.
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

/// A long scripted session must not grow the TUI's resident memory without bound: the transcript
/// grows with the session (as designed), but no per-frame or per-event class may accumulate.
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
    let options = support::options(socket);
    let plan = HeadlessPlan {
        steps,
        width: 100,
        height: 30,
    };

    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let samples = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u64>::new()));
    let recorded = std::sync::Arc::clone(&samples);
    let rss_thread = std::thread::spawn(move || loop {
        recorded.lock().unwrap().push(resident_bytes());
        if stop_rx.recv_timeout(Duration::from_millis(100)).is_ok() {
            break;
        }
    });

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
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
    let _ = rss_thread.join();
    let _ = handle.join();

    let outcome = outcome.expect("interactive run succeeded");
    assert_eq!(outcome.active_session_id, "s1");

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
