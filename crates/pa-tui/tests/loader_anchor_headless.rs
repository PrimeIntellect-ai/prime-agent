//! Headless e2e for the loader's anchor (the operator's 2026-09-28
//! report: "the waiting/executing timer resets on every agents-view
//! round trip — it should always count time since last human prompt").
//!
//! A mock supervisor serves an attach snapshot whose newest USER
//! message carries a wall-clock `timestamp` and whose state reports
//! `isStreaming` — the mid-turn frame an agents-view round trip
//! re-attaches into. The contract: the re-mounted loader anchors at
//! the LAST HUMAN PROMPT's time, so the elapsed readout picks up where
//! the turn left it (never the re-attach instant's ~0s), and a NEWER
//! prompt re-anchors the clock onto itself.
//!
//! The round trip itself is the second attach: the client that returns
//! from the agents view is a fresh process re-attaching to the same
//! mid-turn session, so each `run_plan` below IS one leg of the round
//! trip. The TS fork's loader tracker starts at its own mount (TS
//! `agent_start` resets `speedStats` per attach) — the
//! prompt-anchored rebuild is this port's own contract.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

use crossterm::event::KeyCode;
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// One mock daemon: serves one client connection, answering the attach
/// with a mid-turn snapshot whose user message is `prompt_age_ms` old.
struct MockSupervisor {
    listener: UnixListener,
    prompt_age_ms: u64,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path, prompt_age_ms: u64) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            prompt_age_ms,
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
                    write_json(&mut writer, &attach_data(id, self.prompt_age_ms));
                    // The turn settles 2.5s later from a side thread (the
                    // reader loop keeps answering the client's post-attach
                    // requests, so the loader's anchored frame always
                    // renders before the end clears it) and the headless
                    // run's settle completes instead of waiting on a turn
                    // that never ends.
                    let mut event_writer = writer.try_clone().expect("clone event socket");
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(2500));
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

/// The attach result: a mid-turn snapshot whose LAST HUMAN PROMPT is
/// `prompt_age_ms` old and whose state is streaming (the frame the
/// agents-view round trip returns into).
fn attach_data(id: &str, prompt_age_ms: u64) -> Value {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default();
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
                    "sessionName": "loader anchor session",
                    "model": null,
                    "isStreaming": true,
                    "isCompacting": false,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                },
                "messages": [
                    {
                        "role": "user",
                        "content": [{ "type": "text", "text": "run the sweep" }],
                        "timestamp": now_ms.saturating_sub(prompt_age_ms),
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

/// Run one headless leg against a fresh mock whose prompt is
/// `prompt_age_ms` old, and return the loader's rendered elapsed
/// seconds (the `Waiting · {elapsed}` readout).
fn loader_elapsed_secs(prompt_age_ms: u64) -> u64 {
    // The ambient TMUX variable adds a startup notice to the
    // transcript; scrub it so the run is the same inside tmux and out.
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket, prompt_age_ms);
    let handle = std::thread::spawn(move || supervisor.serve());

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    // The headless renderer paints on the event cadence: one harmless
    // editor keystroke after the attach lands forces the frame that
    // carries the re-anchored loader's readout.
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::WaitMs(700),
            HeadlessStep::Key(crossterm::event::KeyEvent::new(
                KeyCode::Char(' '),
                crossterm::event::KeyModifiers::NONE,
            )),
            HeadlessStep::WaitMs(500),
        ],
        width: 100,
        height: 40,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    let all = outcome.frames.join("\n");
    let loader_line = all
        .lines()
        .rev()
        .find(|line| line.contains("Waiting"))
        .unwrap_or_else(|| {
            panic!(
                "the loader renders ({} frames): {all}",
                outcome.frames.len()
            )
        });
    let elapsed = loader_line
        .split("·")
        .nth(1)
        .and_then(|tail| tail.trim().split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|secs| secs.parse::<u64>().ok())
        .unwrap_or_else(|| panic!("the loader carries an elapsed readout: {loader_line}"));
    elapsed
}

/// The operator's contract (2026-09-28): the waiting/executing timer
/// counts since the LAST HUMAN PROMPT and NEVER resets on a view
/// transition. The agents-view round trip is a fresh attach into the
/// same mid-turn session: the re-mounted loader keeps the prompt's
/// anchor (the elapsed continues, not ~0s), and a NEWER prompt
/// re-anchors the clock onto itself.
#[test]
fn the_loader_anchor_survives_the_agents_view_round_trip() {
    // The turn's prompt landed 25s ago. First attach (the turn running):
    // the loader already counts ~25s.
    let first = loader_elapsed_secs(25_000);
    assert!(
        first >= 20,
        "the loader counts since the prompt on the first attach: {first}s"
    );
    // The round trip: the client leaves for the agents view and a fresh
    // process re-attaches to the SAME mid-turn session. The anchor
    // holds — the clock continues from the prompt, never the
    // re-attach instant (the reported bug restarted it at ~0s).
    let returned = loader_elapsed_secs(25_000);
    assert!(
        returned >= 20,
        "the round trip keeps the prompt's anchor (the timer continues, not ~0s): {returned}s"
    );
    // A NEWER human prompt re-anchors: the clock follows the newest
    // prompt, not the old one.
    let reanchored = loader_elapsed_secs(3_000);
    assert!(
        reanchored <= 15,
        "a newer prompt re-anchors the timer onto itself: {reanchored}s"
    );
}
