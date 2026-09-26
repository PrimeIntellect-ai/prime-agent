//! Headless e2e for the click-to-open hyperlink dispatch: a mock
//! supervisor serves one attached session whose transcript holds a
//! markdown link, and the headless harness feeds byte-identical SGR mouse
//! reports (press, release; drag variants) through the same
//! decode-and-dispatch path a terminal's mouse takes.
//!
//! Verifies the TS parity contract of `tui.ts`'s `handleFullscreenInput`
//! click branches: a plain release over a link opens its OSC 8 target
//! (the run's recorded `opened_urls` stand in for the browser spawn a
//! terminal receives — terminals gate their native link handling while
//! mouse reporting is active, so the TUI opens the clicks it consumes),
//! a release after a drag ends the selection instead of opening, and a
//! release over plain text opens nothing.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

/// Mouse tracking is process-global state, so the headless runs serialize
/// (the capability override rides the same thread-local the render reads).
static RUN_LOCK: Mutex<()> = Mutex::new(());

fn run_lock() -> MutexGuard<'static, ()> {
    match RUN_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// The SGR reports a real terminal sends with ?1002+?1006 tracking active:
/// a left press, a left drag (button 0 + the motion bit 32), and a release.
fn press(col: usize, row: usize) -> String {
    format!("\x1b[<0;{col};{row}M")
}

fn drag(col: usize, row: usize) -> String {
    format!("\x1b[<32;{col};{row}M")
}

fn release(col: usize, row: usize) -> String {
    format!("\x1b[<0;{col};{row}m")
}

struct MockSupervisor {
    listener: UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// Serve one connection: attach a session whose snapshot holds the
    /// linked transcript, then answer the loop's requests.
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
                                "contextUsage": { "tokens": 1200, "contextWindow": 200_000 },
                                "cost": 0.01,
                            },
                        }),
                    );
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

/// The slim attach result with the linked transcript: the assistant
/// message carries one markdown link, the row a click targets.
fn attach_data(id: &str) -> Value {
    let messages = vec![
        json!({ "role": "user", "content": [{ "type": "text", "text": "show the docs link" }] }),
        json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "see [handbook](https://example.com/docs) for more" },
            ],
        }),
    ];
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
                    "sessionName": "click session",
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
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: SessionSelection::New,
        initial_message: None,
        show_images: true,
        client_settings: None,
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
    }
}

/// Run the headless plan against a fresh mock supervisor and return the
/// captured frames, the opened links, and the selection copies. Holds the
/// run lock: mouse tracking is process-global, and the hyperlink
/// capability override rides the same thread-local the render reads.
fn run_plan(steps: Vec<HeadlessStep>) -> (Vec<String>, Vec<String>, Vec<String>) {
    let _guard = run_lock();
    // A hyperlink-capable terminal: the link's label carries its OSC 8
    // target, exactly the row the click dispatch resolves.
    pa_tui::hyperlinks::set_hyperlinks_override(Some(true));
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
    pa_tui::hyperlinks::set_hyperlinks_override(None);
    let _ = handle.join();
    (outcome.frames, outcome.opened_urls, outcome.copies)
}

/// The last frame holding a needle and the needle's (row, column) within
/// it — the rendered coordinates a mouse press targets.
fn locate<'a>(frames: &'a [String], needle: &str) -> Option<(usize, usize, usize, &'a str)> {
    frames
        .iter()
        .enumerate()
        .filter_map(|(index, frame)| {
            let rows: Vec<&str> = frame.split('\n').collect();
            let row = rows.iter().position(|r| r.contains(needle))?;
            let col = rows[row].find(needle)?;
            Some((index, row, col, frame.as_str()))
        })
        .next_back()
}

/// The link label's rendered position after `ScrollTop` (the probe's
/// captured frame is the click target's geometry).
fn link_position() -> (usize, usize) {
    let (frames, opened, _) = run_plan(vec![HeadlessStep::ScrollTop]);
    assert!(opened.is_empty(), "the probe never clicks: {opened:?}");
    let (_, row, col, _) = locate(&frames, "handbook").expect("the link label rendered");
    (row, col)
}

/// The dock's detail row — plain text, never a link — as a click target.
fn plain_position() -> (usize, usize) {
    let (frames, _, _) = run_plan(vec![HeadlessStep::ScrollTop]);
    let (_, row, col, _) = locate(&frames, "Details mode").expect("the detail row rendered");
    (row, col)
}

/// A press-release without a drag over the link label opens its OSC 8
/// target (TS `fullscreenPressedHyperlink`'s release branch): the click
/// the TUI consumes opens the browser itself.
#[test]
fn click_on_a_transcript_link_opens_it() {
    let (row, col) = link_position();
    let steps = vec![
        // Mount the window at the transcript top: the probe layout is the
        // click target only while the view sits there.
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(col + 4, row + 1)),
        HeadlessStep::Mouse(release(col + 4, row + 1)),
    ];
    let (_, opened, copies) = run_plan(steps);
    assert_eq!(
        opened,
        vec!["https://example.com/docs".to_string()],
        "the click opened the link target"
    );
    assert!(copies.is_empty(), "a click copies nothing: {copies:?}");
}

/// A drag over the link ends the selection instead — the release with a
/// selection copies and never opens (TS: the hasSelection branch wins).
#[test]
fn drag_over_a_link_selects_it_instead_of_opening() {
    let (row, col) = link_position();
    let steps = vec![
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(col + 1, row + 1)),
        HeadlessStep::Mouse(drag(col + 8, row + 1)),
        HeadlessStep::Mouse(release(col + 8, row + 1)),
    ];
    let (_, opened, copies) = run_plan(steps);
    assert!(opened.is_empty(), "a drag never opens: {opened:?}");
    assert_eq!(
        copies,
        vec!["handboo".to_string()],
        "the dragged label cells copied"
    );
}

/// A release over plain rendered text opens nothing: only cells inside a
/// link's OSC 8 range resolve a URL.
#[test]
fn click_on_plain_text_opens_nothing() {
    let (row, col) = plain_position();
    let steps = vec![
        // The dock's detail row sits far from every link range; no
        // ScrollTop is needed (the dock never moves).
        HeadlessStep::Mouse(press(col + 1, row + 1)),
        HeadlessStep::Mouse(release(col + 1, row + 1)),
    ];
    let (_, opened, copies) = run_plan(steps);
    assert!(
        opened.is_empty(),
        "a plain-text click opens nothing: {opened:?}"
    );
    assert!(
        copies.is_empty(),
        "the zero-width click copies nothing: {copies:?}"
    );
}
