//! Headless e2e for the chat-open first frame (the operator's
//! 2026-09-26 layout-shift report): opening a chat view must paint its
//! final geometry in the FIRST frame. The activity dock — the muted
//! divider rule plus the panel row that render under the prompt bar —
//! and the pinned title bar ride the first content frame together with
//! the transcript, and a chat that opens directly into content never
//! renders the brand splash at all.
//!
//! The mock supervisor serves the attach snapshot immediately but
//! delays the `heartbeats_list` and `list_kernel_bash` responses (the
//! loaded-daemon repro from the report): the dock's visibility data
//! must fold synchronously with the attach, so no captured frame ever
//! repaints the dock in late.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// The loaded-daemon stand-in: the dock's data requests answer this
/// late, far past the first frame's render — late enough that a
/// fire-and-forget open-time fetch (the layout-shift bug) always paints
/// a first frame without the dock, and short enough to sit well inside
/// the attach's bounded waits.
const DOCK_DATA_DELAY_MS: u64 = 300;

struct MockSupervisor {
    listener: UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// Serve one connection: attach one session (with or without
    /// transcript messages), subscribe the roster, and answer the dock
    /// data requests after the delay.
    fn serve(self, with_content: bool) {
        let (stream, _) = self.listener.accept().expect("accept");
        let write_stream = stream.try_clone().expect("clone mock socket");
        let mut writer = write_stream;
        let mut reader = BufReader::new(stream);

        let hello = json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": ["kernel_bash_activity"],
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
                "attach" => {
                    write_json(&mut writer, &attach_data(id, with_content));
                }
                "heartbeats_list" => {
                    std::thread::sleep(std::time::Duration::from_millis(DOCK_DATA_DELAY_MS));
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "heartbeats_list",
                            "success": true,
                            "data": {
                                "heartbeats": [
                                    {
                                        "job": {
                                            "id": "hb-1",
                                            "status": "active",
                                            "source": "heartbeat",
                                            "activeSessionId": "s1",
                                            "sessionId": "sess-1",
                                            "schedule": {"kind": "interval", "expression": "every 30m"},
                                        },
                                        "sessionName": "layout probe",
                                    },
                                ],
                            },
                        }),
                    );
                }
                "list_kernel_bash" => {
                    std::thread::sleep(std::time::Duration::from_millis(DOCK_DATA_DELAY_MS));
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "list_kernel_bash",
                            "success": true,
                            "data": {
                                "activities": [
                                    {
                                        "id": "run-1",
                                        "command": "echo settled",
                                        "status": "finished",
                                        "exitCode": 0,
                                    },
                                ],
                            },
                        }),
                    );
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

/// The attach result: one live session whose transcript either carries
/// a settled exchange or is empty.
fn attach_data(id: &str, with_content: bool) -> Value {
    let messages = if with_content {
        json!([
            { "role": "user", "content": "hello", "timestamp": 1 },
            { "role": "assistant", "content": "settled answer", "provider": "scripted", "model": "faux-1", "timestamp": 2 },
        ])
    } else {
        json!([])
    };
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
                    "sessionName": "layout probe",
                    "model": "faux-1",
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
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: SessionSelection::Attach("s1".to_string()),
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

/// The attach snapshot's transcript shape the open drives.
enum OpeningTranscript {
    /// No messages: the chat opens empty (the splash's parity case).
    Empty,
    /// A settled user/assistant exchange: a direct open into content.
    Content,
}

/// Run one headless open against a fresh mock supervisor and return the
/// captured frames.
fn run_open(transcript: OpeningTranscript) -> Vec<String> {
    let with_content = matches!(transcript, OpeningTranscript::Content);
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket);
    let handle = std::thread::spawn(move || supervisor.serve(with_content));

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::WaitMs(100),
            HeadlessStep::WaitMs(100),
            HeadlessStep::WaitMs(100),
        ],
        width: 100,
        height: 30,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    outcome.frames
}

/// The dock's divider rule: one full-width row of box-drawing heavies.
fn is_divider_row(line: &str, width: usize) -> bool {
    !line.is_empty() && line.chars().count() == width && line.chars().all(|c| c == '\u{2500}')
}

/// The dock (the muted divider plus the activity panel row under the
/// prompt bar) is first-frame geometry: every captured frame carries
/// both rows, so the delayed dock data never repaints the layout in
/// late — the first frame is the final geometry (the operator's
/// zero-layout-shift report).
#[test]
fn the_activity_dock_is_in_every_frame_from_the_first() {
    let frames = run_open(OpeningTranscript::Empty);
    assert!(!frames.is_empty(), "frames were captured");
    let offenders: Vec<usize> = frames
        .iter()
        .enumerate()
        .filter(|(_, frame)| {
            !frame.contains("\u{25f7} 1 heartbeat")
                || !frame.lines().any(|line| is_divider_row(line, 100))
        })
        .map(|(index, _)| index)
        .collect();
    assert!(
        offenders.is_empty(),
        "every frame from the first carries the dock divider plus the \
         heartbeat panel row (frames {offenders:?} lack it) — the dock \
         data must fold with the attach, never land as a late repaint:\n{}",
        frames.join("\n---frame---\n")
    );
}

/// A chat that opens directly into content paints its first frame from
/// the snapshot: the transcript, the pinned title row, and the dock all
/// ride that same frame, and the brand splash (the new chat's header)
/// never renders — no splash flash above the title, no one-row shift.
#[test]
fn a_direct_open_into_content_never_renders_the_splash() {
    let frames = run_open(OpeningTranscript::Content);
    assert!(!frames.is_empty(), "frames were captured");
    let first = &frames[0];
    assert!(
        first.contains("settled answer"),
        "the first frame is the content frame:\n{first}"
    );
    assert!(
        first.contains("layout probe"),
        "the pinned title row rides the first content frame:\n{first}"
    );
    assert!(
        frames.iter().all(|frame| !frame.contains("prime agent")),
        "the brand splash never renders for a direct open into content:\n{}",
        frames.join("\n---frame---\n")
    );
}

/// The counter-pin: an empty chat keeps its brand splash — TS
/// `BrandSplashHeader` is the new chat's header, and the suppression is
/// scoped to opens into content.
#[test]
fn an_empty_open_keeps_the_brand_splash() {
    let frames = run_open(OpeningTranscript::Empty);
    assert!(!frames.is_empty(), "frames were captured");
    assert!(
        frames.iter().any(|frame| frame.contains("prime agent")),
        "the empty chat renders its header splash:\n{}",
        frames.join("\n---frame---\n")
    );
}
