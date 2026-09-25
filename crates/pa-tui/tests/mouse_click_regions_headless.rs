//! Headless e2e for the fullscreen click surfaces (TS #2430): a mock
//! supervisor serves one attached session with tool calls and a markdown
//! link, and the headless harness feeds byte-identical SGR mouse reports
//! through the same decode-and-dispatch path a terminal's mouse (and a
//! touch tap — terminals synthesize the same press/release pairs) takes.
//!
//! Verifies the TS parity contract of `tui.ts`'s click branches: a clean
//! left press/release on a tool header toggles only that card's expansion,
//! a drag or a modified click never dispatches, a clean click on a
//! rendered OSC 8 link opens it, and a click in the editor's content rows
//! places the caret there.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

/// Mouse tracking is process-global state, so the headless runs serialize.
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

/// The SGR reports a real terminal (or touch tap) sends: a left press and
/// its release at the same cell dispatch; a drag carries the motion bit.
fn press(col: usize, row: usize) -> String {
    format!("\x1b[<0;{col};{row}M")
}

fn drag(col: usize, row: usize) -> String {
    format!("\x1b[<32;{col};{row}M")
}

fn release(col: usize, row: usize) -> String {
    format!("\x1b[<0;{col};{row}m")
}

/// A shift-modified press/release pair (the modifier bit rides `cb`).
fn shift_press(col: usize, row: usize) -> String {
    format!("\x1b[<4;{col};{row}M")
}

fn shift_release(col: usize, row: usize) -> String {
    format!("\x1b[<4;{col};{row}m")
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

    /// Serve one connection: attach a session whose snapshot holds two
    /// settled bash tool calls and a markdown link, then answer the
    /// loop's requests.
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
                                "id": "s1",
                                "stats": {
                                    "id": "s1",
                                    "cwd": "/tmp",
                                    "lastModified": "2026-09-24T00:00:00Z",
                                    "gitBranch": "main",
                                    "gitStatus": [],
                                    "queuedCount": 0,
                                    "sessionTurns": 3,
                                    "messageCount": 6,
                                },
                            },
                        }),
                    );
                }
                "get_sessions" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_sessions",
                            "success": true,
                            "data": { "sessions": [] },
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
                            "data": Value::Null,
                        }),
                    );
                }
            }
        }
    }
}

fn write_json(writer: &mut UnixStream, value: &Value) {
    let _ = writeln!(writer, "{value}");
    let _ = writer.flush();
}

/// The snapshot: a user prompt, two assistant turns each carrying one
/// settled bash tool call (distinct output markers), and an assistant
/// note with a markdown link.
fn attach_data(id: &str) -> Value {
    let messages: Vec<Value> = vec![
        json!({ "role": "user", "content": [{ "type": "text", "text": "run the tools please" }] }),
        json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "I will run them" },
                { "type": "toolCall", "id": "t1", "name": "bash", "arguments": { "command": "setup-one" } },
            ],
            "stopReason": "toolUse",
        }),
        json!({
            "role": "toolResult",
            "toolCallId": "t1",
            "toolName": "bash",
            // Seven output lines, the marker FIRST: the collapsed card
            // previews only the LAST five lines.
            "content": [{ "type": "text", "text": "OUTPUT-ONE\none second\none third\none fourth\none fifth\none sixth\none seventh" }],
            "isError": false,
        }),
        json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "and the second" },
                { "type": "toolCall", "id": "t2", "name": "bash", "arguments": { "command": "setup-two" } },
            ],
            "stopReason": "toolUse",
        }),
        json!({
            "role": "toolResult",
            "toolCallId": "t2",
            "toolName": "bash",
            "content": [{ "type": "text", "text": "OUTPUT-TWO\ntwo second\ntwo third\ntwo fourth\ntwo fifth\ntwo sixth\ntwo seventh" }],
            "isError": false,
        }),
        json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "the guide lives at [documentation](https://example.com/spec)" }],
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

fn options(socket: PathBuf, fullscreen_mouse: bool) -> InteractiveOptions {
    InteractiveOptions {
        socket_path: socket,
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        script_path: None,
        model_selection: ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: Default::default(),
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
        prompt_stash: Default::default(),
        session_has_children: false,
    }
}

/// Run the headless plan against a fresh mock supervisor and return the
/// captured frames, selection copies, and opened links. Holds the run
/// lock: mouse tracking is process-global.
fn run_plan(steps: Vec<HeadlessStep>) -> (Vec<String>, Vec<String>, Vec<String>) {
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
            options(socket, true),
            UiMode::Headless(plan),
        ))
        .expect("interactive run");
    let _ = handle.join();
    (outcome.frames, outcome.copies, outcome.opened_urls)
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

/// A clean press/release on a tool header toggles only that card's
/// expansion (TS `Clickable` over `ToolExecutionComponent`'s header);
/// clicking it again collapses it back.
#[test]
fn clicking_a_tool_header_toggles_only_that_card() {
    let probe = run_plan(vec![HeadlessStep::ScrollTop]);
    let last = probe.0.last().expect("a frame rendered");
    assert!(
        last.contains("bash \u{00b7} done"),
        "the card headers render"
    );
    assert!(
        !last.contains("OUTPUT-ONE") && !last.contains("OUTPUT-TWO"),
        "collapsed cards hide their outputs"
    );
    let (_, header_row, header_col, _) =
        locate(&probe.0, "bash \u{00b7} done").expect("the first card header");

    // Clean press/release on the first card's header (the touch tap shape).
    let clicked = run_plan(vec![
        HeadlessStep::WaitMs(700),
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(header_col + 2, header_row + 1)),
        HeadlessStep::Mouse(release(header_col + 2, header_row + 1)),
    ]);
    let after = clicked.0.last().expect("a frame after the click");
    assert!(
        after.contains("OUTPUT-ONE"),
        "the first card expanded:\n{after}"
    );
    assert!(
        !after.contains("OUTPUT-TWO"),
        "the second card stays collapsed:\n{after}"
    );

    // Clicking the header again collapses the card back.
    let recollapsed = run_plan(vec![
        HeadlessStep::WaitMs(700),
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(header_col + 2, header_row + 1)),
        HeadlessStep::Mouse(release(header_col + 2, header_row + 1)),
        HeadlessStep::Mouse(press(header_col + 2, header_row + 1)),
        HeadlessStep::Mouse(release(header_col + 2, header_row + 1)),
    ]);
    let after = recollapsed
        .0
        .last()
        .expect("a frame after the second click");
    assert!(
        !after.contains("OUTPUT-ONE") && !after.contains("OUTPUT-TWO"),
        "the card collapsed again:\n{after}"
    );
}

/// A drag's release and a shift-modified click never dispatch (TS: only
/// a clean, unmodified, drag-free press/release pair clicks).
#[test]
fn drags_and_modified_clicks_do_not_dispatch() {
    let probe = run_plan(vec![HeadlessStep::ScrollTop]);
    let (_, header_row, header_col, _) =
        locate(&probe.0, "bash \u{00b7} done").expect("the first card header");

    // Press, drag away, release: no dispatch.
    let dragged = run_plan(vec![
        HeadlessStep::WaitMs(700),
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(header_col + 2, header_row + 1)),
        HeadlessStep::Mouse(drag(header_col + 6, header_row + 1)),
        HeadlessStep::Mouse(release(header_col + 6, header_row + 1)),
    ]);
    let after = dragged.0.last().expect("a frame after the drag");
    assert!(
        !after.contains("OUTPUT-ONE"),
        "a drag's release never dispatches:\n{after}"
    );

    // Shift+click on the header: selection-only, no dispatch.
    let shifted = run_plan(vec![
        HeadlessStep::WaitMs(700),
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(shift_press(header_col + 2, header_row + 1)),
        HeadlessStep::Mouse(shift_release(header_col + 2, header_row + 1)),
    ]);
    let after = shifted.0.last().expect("a frame after the shift click");
    assert!(
        !after.contains("OUTPUT-ONE"),
        "a modified click never dispatches:\n{after}"
    );

    // A modified PRESS stays selection-only even when its release drops
    // the modifier (the pair is the unit, not the release alone).
    let slipped = run_plan(vec![
        HeadlessStep::WaitMs(700),
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(shift_press(header_col + 2, header_row + 1)),
        HeadlessStep::Mouse(release(header_col + 2, header_row + 1)),
    ]);
    let after = slipped.0.last().expect("a frame after the slipped release");
    assert!(
        !after.contains("OUTPUT-ONE"),
        "a modified press never dispatches, whatever its release:\n{after}"
    );
}

/// A clean click on a rendered OSC 8 link opens it (TS `openHyperlink`):
/// the run records the opened URL (the headless stand-in for the platform
/// opener a terminal receives).
#[test]
fn clicking_a_transcript_link_opens_it() {
    pa_tui::hyperlinks::set_hyperlinks_override(Some(true));
    // The link label rides the transcript tail - the default following
    // window shows it without scrolling (the top window folds it under
    // the fold). One idle hold lets the attach render land before the
    // probe frame.
    // Both runs settle identically before the probe/press: the attach
    // and stats renders land inside the hold, so the probe's last frame is
    // the same settled frame the plan's press dispatches against.
    let probe = run_plan(vec![HeadlessStep::WaitMs(1500)]);
    let (_, link_row, link_col, _) = locate(&probe.0, "documentation")
        .unwrap_or_else(|| panic!("the link label renders: {:#?}", probe.0));
    let opened = run_plan(vec![
        HeadlessStep::WaitMs(1500),
        HeadlessStep::Mouse(press(link_col + 1, link_row + 1)),
        HeadlessStep::Mouse(release(link_col + 1, link_row + 1)),
    ]);
    pa_tui::hyperlinks::set_hyperlinks_override(None);
    assert_eq!(
        opened.2,
        vec!["https://example.com/spec".to_string()],
        "the clicked link opened (press at {}, release at {}): {:#?}",
        press(link_col + 1, link_row + 1),
        release(link_col + 1, link_row + 1),
        opened.0
    );
}

/// A click in the editor's content rows places the caret there (TS
/// `Editor.placeCursorFromClick`): typing after the click inserts at the
/// clicked position.
#[test]
fn editor_click_places_the_caret() {
    let probe = run_plan(vec![
        HeadlessStep::WaitMs(700),
        HeadlessStep::Type("hello world".to_string()),
        HeadlessStep::ScrollTop,
    ]);
    let (_, editor_row, hello_col, _) = locate(&probe.0, "hello world")
        .unwrap_or_else(|| panic!("the editor renders the typed text: {:#?}", probe.0));
    // Click between "hello" and " world": the needle sits at the text's
    // first column (the row's leading pad, `> ` prompt, and inner pad
    // precede it), so the caret's cell is five text columns in.
    let click_col = hello_col + 5;
    let clicked = run_plan(vec![
        HeadlessStep::WaitMs(700),
        HeadlessStep::Type("hello world".to_string()),
        HeadlessStep::ScrollTop,
        HeadlessStep::Mouse(press(click_col + 1, editor_row + 1)),
        HeadlessStep::Mouse(release(click_col + 1, editor_row + 1)),
        HeadlessStep::Type("X".to_string()),
    ]);
    let after = clicked.0.last().expect("a frame after typing");
    assert!(
        after.contains("helloX world"),
        "the typed X landed at the clicked caret:\n{after}"
    );
}
