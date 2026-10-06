//! Headless e2e for the read-only inline info panel (operator directive
//! 2026-09-26): the flooding client commands (`/context`, `/session`,
//! `/system-prompt`, `/logs`, `/changelog`, `/hotkeys`, `/list`) open the
//! docked panel; ESC closes it; `?` types into the editor (guide removed).
#![cfg(unix)]
// Casts: structurally bounded terminal-layout arithmetic; guarded conversions add panic paths.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// Render routes are flat tables (one arm per route); splitting adds indirection.
#![allow(clippy::too_many_lines)]
// Widget state structs carry independent flag bits.
#![allow(clippy::struct_excessive_bools, clippy::fn_params_excessive_bools)]
// Futures are bounded by the surface's lifetime; boxing adds a steady-state allocation.
#![allow(clippy::large_futures)]
// The wrappers preserve a uniform Result-returning API surface.
#![allow(clippy::unnecessary_wraps)]

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

    /// Serve one connection: the info commands' daemon fetches all land in the default arm's
    /// empty-data success.
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

/// The panel's key hint (the shared docked-panel grammar): the scroll keys and the close key.
const PANEL_HINT: &str = "Esc close";

/// Every flooding command opens the read-only info panel inline, ESC closes it, and the transcript
/// gains nothing; `?` types into the editor instead of mounting the removed guide.
#[test]
fn info_commands_open_inline_panels_that_esc_closes_without_transcript_rows() {
    let steps = vec![
        // `/context`: the tree opens the panel (its `Tokens` section is panel-only content).
        submit("/context"),
        wait_render("Tokens"),
        key(KeyCode::Down),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // `/session`: the Session Info rows.
        submit("/session"),
        wait_render("Session Info"),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // `/system-prompt`: the unbounded document, paged by the panel.
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
        // `/hotkeys`: the guide's rows ride the panel; End jumps to the guide's bottom.
        submit("/hotkeys"),
        wait_render("Move cursor / browse history"),
        key(KeyCode::End),
        wait_render("mouse click on link"),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // `/list`: the live-sessions listing (the mock answers an empty roster).
        submit("/list"),
        wait_render("live sessions:"),
        key(KeyCode::Esc),
        wait_gone(PANEL_HINT),
        // The removed `?` command: with an empty editor the key types a literal `?`; Esc clears the
        // editor.
        key(KeyCode::Char('?')),
        key(KeyCode::Esc),
    ];
    let frames = run_plan(steps);
    assert!(!frames.is_empty(), "frames were captured");
    let rendered = frames.join("\n");

    assert!(
        rendered.contains("\u{2191}/\u{2193} scroll \u{b7} Esc close"),
        "the panel hint rendered:\n{rendered}"
    );
    // End put the guide's last rows on screen (the first window never shows them).
    assert!(
        rendered.contains("mouse click on link"),
        "the End key jumped the panel to the guide's bottom:\n{rendered}"
    );
    // The `?` quick-shortcut guide never mounted anywhere in the run: the `?` press typed editor
    // text instead.
    assert!(
        !rendered.contains("full reference"),
        "the removed ? guide must never mount:\n{rendered}"
    );
    assert!(
        !rendered.contains("quick shortcuts"),
        "the removed ? guide's vocabulary is gone:\n{rendered}"
    );

    // The transcript after every panel closed: the editor dock and none of the panel content (the
    // operator's no-flooding directive).
    let last = frames.last().expect("frames");
    assert!(
        last.contains("Collapsed mode ("),
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
