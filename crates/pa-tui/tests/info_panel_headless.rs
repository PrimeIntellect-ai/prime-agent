//! Headless e2e for the read-only inline info panel (the operator's
//! 2026-09-26 directive): the flooding client commands — `/context`,
//! `/session`, `/system-prompt`, `/logs`, `/changelog`, `/hotkeys`, and
//! `/list` — must open the docked popup panel over the editor dock (the
//! `/mcp` and `/model` panel grammar: the ruled frame, the scroll
//! indicator, the key hint, one blank under it), ESC must close it back
//! to the editor dock, and no transcript row may ever carry the
//! command's content. The `?` quick-shortcut guide is REMOVED entirely
//! (the operator's directive): pressing `?` types into the editor and no
//! guide mounts anywhere in the run.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

struct MockSupervisor {
    listener: UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// Serve one connection: attach an empty session, then answer the
    /// loop's requests (the info commands' daemon fetches all land in
    /// the default arm's empty-data success).
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
                "get_commands" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_commands",
                            "success": true,
                            "data": { "commands": [] },
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

/// The slim attach result: one empty session.
fn attach_data(id: &str) -> Value {
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
                    "sessionName": "info panel session",
                    "model": null,
                    "isStreaming": false,
                    "isCompacting": false,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                },
                "messages": [],
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
        client_settings: None,
    }
}

fn run_plan(steps: Vec<HeadlessStep>) -> Vec<String> {
    std::env::remove_var("TMUX");
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
        width: 110,
        height: 30,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    outcome.frames
}

fn submit(text: &str) -> HeadlessStep {
    HeadlessStep::Submit(text.to_string())
}

fn key(code: KeyCode) -> HeadlessStep {
    HeadlessStep::Key(KeyEvent::new(code, KeyModifiers::NONE))
}

fn wait_render(needle: &str) -> HeadlessStep {
    HeadlessStep::WaitRender {
        needle: needle.to_string(),
        timeout_ms: 30_000,
    }
}

fn wait_gone(needle: &str) -> HeadlessStep {
    HeadlessStep::WaitGone {
        needle: needle.to_string(),
        timeout_ms: 30_000,
    }
}

/// The panel's key hint (the shared docked-panel grammar): the scroll
/// keys and the close key.
const PANEL_HINT: &str = "Esc close";

/// Every flooding command opens the read-only info panel inline, ESC
/// closes it, and the transcript gains nothing: the panel content appears
/// in the frames only while the panel is open, and the final frame holds
/// the empty transcript and the editor dock alone. `?` types into the
/// editor instead of mounting the removed quick-shortcut guide.
#[test]
fn info_commands_open_inline_panels_that_esc_closes_without_transcript_rows() {
    let steps = vec![
        // `/context`: the tree opens the panel (its `Tokens` section is
        // panel-only content), the read-only surface consumes a key, and
        // Esc closes it.
        submit("/context"),
        wait_render("Tokens"),
        key(KeyCode::Down),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // `/session`: the Session Info rows, same open/close cycle.
        submit("/session"),
        wait_render("Session Info"),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // `/system-prompt`: the unbounded document, paged by the panel's
        // page keys.
        submit("/system-prompt"),
        wait_render("chars)"),
        key(KeyCode::PageDown),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // `/logs`: the client-side directory listing.
        submit("/logs"),
        wait_render("Directory:"),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // `/changelog`: the What's New title rides the panel.
        submit("/changelog"),
        wait_render("What's New"),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // `/hotkeys`: the guide's first rows ride the panel, End jumps
        // the scrollable window to the guide's bottom, Esc closes.
        submit("/hotkeys"),
        wait_render("Move cursor / browse history"),
        key(KeyCode::End),
        wait_render("mouse click on link"),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // `/list`: the live-sessions listing (the mock daemon answers an
        // empty roster).
        submit("/list"),
        wait_render("live sessions:"),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // The removed `?` command: with an empty editor the key types a
        // literal `?` (the old build mounted the quick-shortcut guide);
        // Esc clears the editor.
        key(KeyCode::Char('?')),
        key(KeyCode::Esc),
    ];
    let frames = run_plan(steps);
    assert!(!frames.is_empty(), "frames were captured");
    let rendered = frames.join("\n");

    // The panel grammar rendered: the scroll keys and the close key.
    assert!(
        rendered.contains("\u{2191}/\u{2193} scroll \u{b7} Esc close"),
        "the panel hint rendered:\n{rendered}"
    );
    // The scrollable window scrolled: End put the guide's last rows on
    // the screen (the first window never shows them).
    assert!(
        rendered.contains("mouse click on link"),
        "the End key jumped the panel to the guide's bottom:\n{rendered}"
    );
    // The `?` quick-shortcut guide never mounted anywhere in the run
    // (its Help line is gone from the product): the `?` press typed
    // editor text instead.
    assert!(
        !rendered.contains("full reference"),
        "the removed ? guide must never mount:\n{rendered}"
    );
    assert!(
        !rendered.contains("quick shortcuts"),
        "the removed ? guide's vocabulary is gone:\n{rendered}"
    );

    // The transcript after every panel closed: the editor dock and none
    // of the panel content — the panels leave the transcript untouched
    // (the operator's no-flooding directive).
    let last = frames.last().expect("frames");
    assert!(
        last.contains("Details mode ("),
        "the editor dock returned after every panel closed:\n{last}"
    );
    for absent in [
        "Session Info",
        "Tokens",
        "Directory:",
        "What's New",
        "Move cursor / browse history",
        "live sessions:",
        "Use /context for token",
    ] {
        assert!(
            !last.contains(absent),
            "the panel content `{absent}` must not persist in the transcript:\n{last}"
        );
    }
}
