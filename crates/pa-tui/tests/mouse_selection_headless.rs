//! Headless e2e for the in-app mouse selection surface: a mock supervisor
//! serves one attached session with a long snapshot transcript, and the
//! headless harness feeds byte-identical SGR mouse reports (press, drag,
//! release) through the same decode-and-dispatch path a terminal's mouse
//! takes.
//!
//! Verifies the TS parity contract of `tui.ts`'s `handleFullscreenInput`
//! selection branches: a press-drag-release over transcript rows copies the
//! spanned text (the run's recorded `copies` stand in for the OSC 52
//! write a terminal receives), a dock press starts a frame selection, and
//! a plain click without a drag copies nothing.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

/// Mouse tracking is process-global state, so the headless runs serialize
/// (each asserts on the tracking-active branch it drives).
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

    /// Serve one connection: attach a session whose snapshot holds a long
    /// transcript, then answer the loop's requests.
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

/// The slim attach result with a 40-message transcript: alternating user
/// and assistant messages, each one short row, so the transcript is far
/// taller than the 30-row frame.
fn attach_data(id: &str) -> Value {
    let messages: Vec<Value> = (0..40)
        .map(|index| {
            if index % 2 == 0 {
                json!({ "role": "user", "content": [{ "type": "text", "text": format!("row {index}") }] })
            } else {
                json!({
                    "role": "assistant",
                    "content": [{ "type": "text", "text": format!("answer {index}") }],
                })
            }
        })
        .collect();
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
                    "sessionName": "mouse session",
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

fn options(socket: PathBuf, fullscreen_mouse: bool) -> InteractiveOptions {
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
        fullscreen_mouse,
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
    }
}

/// Run the headless plan against a fresh mock supervisor and return the
/// captured frames and selection copies. Holds the run lock: mouse
/// tracking is process-global.
fn run_plan(steps: Vec<HeadlessStep>, fullscreen_mouse: bool) -> (Vec<String>, Vec<String>) {
    let _guard = run_lock();
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
        .block_on(run_interactive(
            options(socket, fullscreen_mouse),
            UiMode::Headless(plan),
        ))
        .expect("interactive run");
    let _ = handle.join();
    (outcome.frames, outcome.copies)
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

/// The transcript window at the top after `ScrollTop`: the chat opened
/// directly into content, so the brand splash is suppressed (the
/// operator's 2026-09-26 zero-shift directive) — the first user
/// message's text sits at row 2 (`  row 0`), its spacer rows at 3-4,
/// and the first assistant answer at row 5 — the layout the selection
/// coordinates below target (the geometry is asserted, not assumed,
/// before each drag).
fn top_layout() -> (usize, usize, usize, usize, usize, usize) {
    let probe = run_plan(vec![HeadlessStep::ScrollTop], true).0;
    let (_, row0, col0, _) = locate(&probe, "row 0").expect("row 0 rendered at the top");
    let (_, answer_row, answer_col, _) =
        locate(&probe, "answer 1").expect("answer 1 rendered below row 0");
    let (_, ctx_row, ctx_col, _) =
        locate(&probe, "Details mode").expect("the prompt-context row rendered");
    (row0, col0, answer_row, answer_col, ctx_row, ctx_col)
}

#[test]
fn press_drag_release_copies_the_spanned_transcript_text() {
    let (row0, col0, ..) = top_layout();
    assert_eq!(
        (row0, col0),
        (2, 2),
        "the first user message renders at 2:2"
    );
    // Drag across the first user message's text: press at its first text
    // column, drag to its end, release — the copy is the text slice.
    let steps = vec![
        // Mount the window at the transcript top: the probe layout is the
        // press target only while the view sits there.
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(col0 + 1, row0 + 1)),
        HeadlessStep::Mouse(drag(col0 + 6, row0 + 1)),
        HeadlessStep::Mouse(release(col0 + 6, row0 + 1)),
    ];
    let (_, copies) = run_plan(steps, true);
    assert_eq!(copies, vec!["row 0".to_string()], "the dragged text copied");
}

/// A drag spanning several rows copies each row's slice — the anchor's row
/// from the anchor column, the spacer rows as empty lines, the head's row
/// up to the head column (TS `extractSelectionText`).
#[test]
fn multi_row_drag_copies_each_line() {
    let (row0, col0, answer_row, answer_col, ..) = top_layout();
    assert_eq!(
        answer_row - row0,
        3,
        "two spacer rows sit between the messages"
    );
    let steps = vec![
        // Mount the window at the transcript top: the probe layout is the
        // press target only while the view sits there.
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(col0 + 1, row0 + 1)),
        HeadlessStep::Mouse(drag(answer_col + 8, answer_row + 1)),
        HeadlessStep::Mouse(release(answer_col + 8, answer_row + 1)),
    ];
    let (_, copies) = run_plan(steps, true);
    // `  row 0` from column 2; two blank spacer rows; ` answer 1` up to
    // column 8 — ` answer` after the trailing trim (the leading pad is
    // TS-faithful: only the trailing side trims).
    assert_eq!(
        copies,
        vec!["row 0\n\n\n answer".to_string()],
        "the spanned rows copied with their column slices"
    );
}

/// A press-release without any drag copies nothing (TS: the anchor and head
/// coincide, so the release takes the clear branch).
#[test]
fn click_without_drag_copies_nothing() {
    let (row0, col0, ..) = top_layout();
    let steps = vec![
        // Mount the window at the transcript top: the probe layout is the
        // press target only while the view sits there.
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(col0 + 1, row0 + 1)),
        HeadlessStep::Mouse(release(col0 + 1, row0 + 1)),
    ];
    let (_, copies) = run_plan(steps, true);
    assert!(copies.is_empty(), "a click never copies: {copies:?}");
}

/// A press on the dock (outside the transcript window) starts a frame
/// selection over the row's visible span (TS `beginFrameSelection`): the
/// drag's columns copy from the rendered row.
#[test]
fn dock_press_drag_copies_the_frame_region() {
    let (_, _, _, _, ctx_row, ctx_col) = top_layout();
    // The right-aligned detail label (TS #2447's middle-level startup:
    // "Details mode (Ctrl+O to expand)", 2 columns shorter than the old
    // collapsed label) renders at 25:68.
    assert_eq!(
        (ctx_row, ctx_col),
        (25, 68),
        "the context row renders at 25:68"
    );
    let steps = vec![
        // Mount the window at the transcript top: the probe layout is the
        // press target only while the view sits there.
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(ctx_col + 1, ctx_row + 1)),
        HeadlessStep::Mouse(drag(ctx_col + 7, ctx_row + 1)),
        HeadlessStep::Mouse(release(ctx_col + 7, ctx_row + 1)),
    ];
    let (_, copies) = run_plan(steps, true);
    assert_eq!(copies, vec!["Detail".to_string()], "the dock span copied");
}

/// With the `terminal.fullscreenMouse` setting off, tracking never enables
/// and the press-drag-release reports are consumed without a selection.
#[test]
fn selection_reports_are_consumed_when_tracking_is_disabled() {
    let (row0, col0, ..) = top_layout();
    let steps = vec![
        // Mount the window at the transcript top: the probe layout is the
        // press target only while the view sits there.
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(col0 + 1, row0 + 1)),
        HeadlessStep::Mouse(drag(col0 + 6, row0 + 1)),
        HeadlessStep::Mouse(release(col0 + 6, row0 + 1)),
    ];
    let (_, copies) = run_plan(steps, false);
    assert!(
        copies.is_empty(),
        "no copy with tracking disabled: {copies:?}"
    );
}
