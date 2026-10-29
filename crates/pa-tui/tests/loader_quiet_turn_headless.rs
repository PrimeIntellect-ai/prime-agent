//! Headless e2e for the loader during a quiet turn: while a turn runs
//! with no stream events (a foreground tool, a provider gap, silent
//! thinking), the spinner keeps its 80ms cadence and the elapsed
//! counter advances one second at a time. The regression: every paint
//! cleared the frame deadline and nothing re-armed the spinner's phase
//! boundary, so the quiet select parked — the loader froze and the
//! counter skipped whole seconds.
#![cfg(unix)]

mod support;

use std::io::{BufRead, BufReader};
use std::os::unix::net::UnixListener;

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, UiMode,
};
use serde_json::{json, Value};

use support::{attach_response, options, write_json};

/// One mock daemon: serves one client connection, answering the attach
/// with a mid-turn snapshot and then staying silent until the turn ends.
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
                    // No stream event arrives until the turn ends from a
                    // side thread (the reader loop keeps answering the
                    // client's post-attach requests): the quiet window a
                    // running tool or a provider gap leaves.
                    let mut event_writer = writer.try_clone().expect("clone event socket");
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(QUIET_TURN_MS));
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

/// The attach result: a streaming mid-turn snapshot whose prompt landed
/// just now, so the loader's elapsed counter starts at 0s.
fn attach_data(id: &str) -> Value {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after the epoch")
        .as_millis();
    let mut response = attach_response(id, "quiet turn session");
    response["data"]["snapshot"]["state"]["isStreaming"] = json!(true);
    response["data"]["snapshot"]["messages"] = json!([
        {
            "role": "user",
            "content": [{ "type": "text", "text": "run the sweep" }],
            "timestamp": now_ms,
        },
    ]);
    response
}

/// How long the mock's turn stays silent before `turn_end`.
const QUIET_TURN_MS: u64 = 3500;

#[test]
fn a_quiet_turn_keeps_the_loader_animating() {
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
    // No input during the window: the loader's own phase boundary is
    // the only thing that can wake the loop.
    let plan = HeadlessPlan {
        steps: vec![HeadlessStep::WaitMs(3000)],
        width: 100,
        height: 40,
    };
    let outcome = runtime
        .block_on(run_interactive(
            InteractiveOptions {
                fullscreen_mouse: false,
                ..options(socket)
            },
            UiMode::Headless(plan),
        ))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");

    let loader_lines: Vec<&str> = outcome
        .frames
        .iter()
        .filter_map(|frame| frame.lines().find(|line| line.contains("Waiting")))
        .collect();
    let elapsed: Vec<u64> = loader_lines
        .iter()
        .filter_map(|line| {
            line.split('·')
                .nth(1)?
                .trim()
                .split(|c: char| !c.is_ascii_digit())
                .next()?
                .parse()
                .ok()
        })
        .collect();
    let transcript = loader_lines.join("\n");
    // The plan's 3s of quiet at the 80ms cadence paints ~37 loader
    // frames before the counter reaches 3s; the parked loop painted the
    // 0s frame and nothing else until the plan ended.
    let quiet_frames = elapsed.iter().filter(|secs| **secs < 3).count();
    assert!(
        quiet_frames >= 10,
        "the spinner repaints through the quiet turn ({quiet_frames} frames under 3s):\n{transcript}"
    );
    assert!(
        elapsed.contains(&1) && elapsed.contains(&2),
        "the elapsed counter paints every whole second:\n{transcript}"
    );
}
