//! Headless e2e for the `/speed` footer readout (TS `FooterComponent`):
//! `/speed` toggles the dim footer row over the session's completed
//! responses — the readout appears after the first completed response
//! with positive usage and span; off clears both the stats and the row.
#![cfg(unix)]
#![warn(clippy::allow_attributes_without_reason)]

mod support;

use std::os::unix::net::UnixStream;

use pa_tui::interactive::{HeadlessPlan, HeadlessStep};
use serde_json::{json, Value};

use support::{
    attach_response, create_response, detach_response, options, run_headless, serve_connection,
    session_stats_response, write_json, MockSupervisor, Request,
};

impl MockSupervisor {
    /// Serve one connection: stream one scripted assistant turn per prompt.
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        serve_connection(stream, &[], |writer, Request { id, kind, .. }| {
            match kind {
                "create" => {
                    write_json(writer, &create_response(id));
                }
                "attach" => {
                    write_json(writer, &attach_response(id, "speed session"));
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

/// One scripted assistant turn: a streamed start, one delta, and a completed message carrying
/// usage and a stream-start timestamp (`message_end` is set at provider stream start).
fn stream_turn(writer: &mut UnixStream) {
    let event = |payload: Value| json!({ "type": "session_event", "activeSessionId": "s1", "event": payload });
    #[expect(
        clippy::cast_possible_truncation,
        reason = "epoch milliseconds stay far below the target type's max"
    )]
    let stream_start_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
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

fn run_plan(steps: Vec<HeadlessStep>) -> Vec<String> {
    let outcome = run_headless(
        HeadlessPlan {
            steps,
            width: 100,
            height: 30,
        },
        options,
        |socket| {
            let supervisor = MockSupervisor::bind(socket);
            move || supervisor.serve()
        },
    );
    outcome.frames
}

/// `/speed` toggles the footer readout over completed responses: the status note carries the TS
/// wording, and the first completed response renders the dim `tok/s` row (the dock's last row).
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
    // The readout row: a dock line that starts with the rate (the dim footer renders exactly the
    // speed text) — distinct from the status notes, which carry "tok/s" mid-sentence.
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
