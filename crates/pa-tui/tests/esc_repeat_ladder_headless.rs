//! Headless e2e for the double-Escape repeat ladder's termination
//! (operator report 2026-09-29): repeated Escape at the empty editor
//! converges to the inert empty state — the repeat's tree action is one
//! shot per input chain, and any non-Escape key re-arms the gesture.
#![cfg(unix)]
// The mock supervisor's request loop is one arm per wire command; splitting adds indirection.
#![allow(clippy::too_many_lines)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

use anyhow::Result;
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

    /// Serve one connection: the tree answer carries two entries so the selector actually mounts
    /// (the empty-tree arm only notes "No entries").
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
                    write_json(
                        &mut writer,
                        &json!({
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
                                        "sessionName": "esc ladder",
                                        "model": null,
                                        "isStreaming": false,
                                        "isCompacting": false,
                                        "sessionActions": {
                                            "queuedCount": 0,
                                            "steering": [],
                                            "followUps": [],
                                        },
                                    },
                                    "messages": [],
                                    "lastEventSequence": 0,
                                    "lastEventCursor": null,
                                },
                                "client": { "id": "mock", "capabilities": [] },
                                "lastEventSequence": 0,
                                "lastEventCursor": null,
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
                "get_session_tree" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_session_tree",
                            "success": true,
                            "data": {
                                "flatNodes": [
                                    {
                                        "entry": {
                                            "type": "message",
                                            "id": "n0",
                                            "parentId": null,
                                            "timestamp": "2024-01-01T00:00:00.000Z",
                                            "message": {
                                                "role": "user",
                                                "content": "first",
                                                "timestamp": 0,
                                            },
                                        },
                                    },
                                    {
                                        "entry": {
                                            "type": "message",
                                            "id": "n1",
                                            "parentId": "n0",
                                            "timestamp": "2024-01-01T00:00:01.000Z",
                                            "message": {
                                                "role": "assistant",
                                                "content": "second",
                                                "timestamp": 1,
                                            },
                                        },
                                    },
                                ],
                                "leafId": "n1",
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

/// A minimal settings seam for the harness: every getter returns its TS default, writes succeed
/// without persistence.
struct StubSettings;

impl pa_tui::client_settings::ClientSettings for StubSettings {
    fn theme(&self) -> Option<String> {
        None
    }
    fn set_theme(&self, _theme: &str) -> Result<()> {
        Ok(())
    }
    fn show_images(&self) -> bool {
        true
    }
    fn set_show_images(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn clear_on_shrink(&self) -> bool {
        false
    }
    fn set_clear_on_shrink(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn show_terminal_progress(&self) -> bool {
        false
    }
    fn set_show_terminal_progress(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn image_auto_resize(&self) -> bool {
        true
    }
    fn set_image_auto_resize(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn block_images(&self) -> bool {
        false
    }
    fn set_block_images(&self, _blocked: bool) -> Result<()> {
        Ok(())
    }
    fn image_model(&self) -> Option<String> {
        None
    }
    fn enable_skill_commands(&self) -> bool {
        true
    }
    fn set_enable_skill_commands(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn enable_builtin_skills(&self) -> bool {
        true
    }
    fn set_enable_builtin_skills(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn show_hardware_cursor(&self) -> bool {
        false
    }
    fn set_show_hardware_cursor(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn editor_padding_x(&self) -> u64 {
        0
    }
    fn set_editor_padding_x(&self, _padding: u64) -> Result<()> {
        Ok(())
    }
    fn autocomplete_max_visible(&self) -> u64 {
        5
    }
    fn set_autocomplete_max_visible(&self, _max: u64) -> Result<()> {
        Ok(())
    }
    fn quiet_startup(&self) -> bool {
        false
    }
    fn set_quiet_startup(&self, _quiet: bool) -> Result<()> {
        Ok(())
    }
    fn idle_eviction_minutes(&self) -> String {
        "90".to_string()
    }
    fn set_idle_eviction_minutes(&self, _value: &str) -> Result<()> {
        Ok(())
    }
    fn mermaid_rendering_mode(&self) -> String {
        "streaming".to_string()
    }
    fn set_mermaid_rendering_mode(&self, _mode: &str) -> Result<()> {
        Ok(())
    }
    fn tree_filter_mode(&self) -> String {
        "user-only".to_string()
    }
    fn set_tree_filter_mode(&self, _mode: &str) -> Result<()> {
        Ok(())
    }
    fn default_service_tier(&self) -> String {
        "auto".to_string()
    }
    fn set_default_service_tier(&self, _tier: &str) -> Result<()> {
        Ok(())
    }
    fn chat_detail(&self) -> String {
        "collapsed".to_string()
    }
    fn set_chat_detail(&self, _detail: &str) -> Result<()> {
        Ok(())
    }
    fn factory_enabled(&self) -> bool {
        false
    }
    fn set_factory_enabled(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn warnings_anthropic_extra_usage(&self) -> bool {
        true
    }
    fn set_warnings_anthropic_extra_usage(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn update_channel(&self) -> Option<String> {
        None
    }
    fn set_update_channel(&self, _channel: &str) -> Result<()> {
        Ok(())
    }
    fn telemetry_status(&self) -> String {
        String::new()
    }
    fn set_telemetry_enabled(&self, _enabled: bool) -> Result<String> {
        Ok(String::new())
    }
    fn effective_update_channel(&self, _version: &str) -> String {
        "stable".to_string()
    }
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
        models: None,
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
        client_settings: Some(std::sync::Arc::new(StubSettings)),
    }
}

fn esc() -> HeadlessStep {
    HeadlessStep::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
}

/// Run one plan against a fresh mock supervisor and return the captured frames. The headless
/// capture dedupes consecutive identical frames, so each tree-selector mount lands as its own
/// frame.
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
        width: 100,
        height: 30,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    outcome.frames
}

/// The tree-selector pane's title row (the mount's needle).
const TREE_PANE: &str = "Session Tree";

/// Sixty Escape presses at the empty editor: the repeat's tree action fires exactly once and the
/// ladder terminates instead of cycling the selector every second press.
#[test]
fn repeated_escape_converges_to_the_inert_empty_state() {
    let mut steps = vec![HeadlessStep::WaitMs(300)];
    for _ in 0..60 {
        steps.push(esc());
    }
    steps.push(HeadlessStep::WaitMs(200));
    let frames = run_plan(steps);

    let tree_frames = frames
        .iter()
        .filter(|frame| frame.contains(TREE_PANE))
        .count();
    assert_eq!(
        tree_frames, 1,
        "the double-Esc gesture opens the tree selector exactly once; a cycling ladder reopens it every second press"
    );

    let last = frames.last().expect("the run captured frames");
    assert!(
        !last.contains(TREE_PANE),
        "the final frame is the inert empty editor, not the reopened selector: {last}"
    );
    assert!(
        last.contains('>') && !last.contains("No entries in session"),
        "the final frame shows the empty prompt, not a tree or note row: {last}"
    );
}

/// A non-Escape key re-arms the gesture: after the converged inert tail, one arrow press starts a
/// fresh input chain and the next double-Esc opens the selector again.
#[test]
fn a_non_escape_key_re_arms_the_double_escape_gesture() {
    let mut steps = vec![HeadlessStep::WaitMs(300)];
    for _ in 0..60 {
        steps.push(esc());
    }
    // A real interaction with no side effect: the editor's right arrow
    // (a cursor motion that stays put at the empty editor). Down would
    // move the focus into the activity dock below the prompt.
    steps.push(HeadlessStep::Key(KeyEvent::new(
        KeyCode::Right,
        KeyModifiers::NONE,
    )));
    steps.push(esc());
    steps.push(esc());
    steps.push(esc());
    steps.push(HeadlessStep::WaitMs(200));
    let frames = run_plan(steps);

    let tree_frames = frames
        .iter()
        .filter(|frame| frame.contains(TREE_PANE))
        .count();
    assert_eq!(
        tree_frames, 2,
        "the gesture fires once per input chain: the first chain's open plus the re-armed second"
    );

    let last = frames.last().expect("the run captured frames");
    assert!(
        !last.contains(TREE_PANE),
        "the second chain's selector also dismisses back to the empty editor: {last}"
    );
}
