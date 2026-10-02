//! Headless regression for the `/tree` selector's search keys (the
//! #3309 key-forwarding class, the tree's shape): TS's final arm reads the
//! RAW key data, where the space byte is a printable that joins the query
//! and every special key arrives as an escape sequence (a control
//! character) and drops. The port receives parsed ids, and its raw gate
//! appended the bare multi-character ids' own names — the `space` id
//! typed the literal "space", `home` typed "home" — so a query that
//! filtered the tree to nothing could not be corrected back to a match.
//! The ladder drives the operator's sequence through the real interactive
//! stack: the typed space lands as a space, named keys join nothing, and
//! Backspace walks the query back to the full tree.
#![cfg(unix)]
// Pedantic-gate exceptions (every other pedantic warning in this crate is
// fixed in place; each exception carries its one-line justification):
// - the mock supervisor's request loop is one arm per wire command (the
// same flat table the sibling headless e2es carry); splitting it would
// add indirection without changing the flow.
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

    /// Serve one connection: attach the session, then answer the loop's
    /// requests. The tree answer carries two entries whose contents the
    /// ladder's query discriminates ("second" matches the typed tokens).
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
                                        "sessionName": "tree search ladder",
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

/// A minimal settings seam for the harness: every getter returns its TS
/// default, writes succeed without persistence.
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

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

/// Run one plan against a fresh mock supervisor and return the captured
/// frames (the headless capture dedupes consecutive identical frames).
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

/// The typed space lands as a space, the named key ids join nothing, and
/// Backspace walks the query back to the full tree: the search stays
/// correctable through the operator's sequence (pre-fix the `space` id
/// appended the literal "space" and `home` its own name, so the query
/// filtered the tree to nothing and the Backspaces could not reach a
/// matching state).
#[test]
fn the_tree_search_types_spaces_and_stays_correctable() {
    let mut steps = vec![
        HeadlessStep::WaitMs(300),
        HeadlessStep::Submit("/tree".to_string()),
        HeadlessStep::WaitRender {
            needle: "Session Tree".to_string(),
            timeout_ms: 2000,
        },
    ];
    // "se cond": the space key id between the two words.
    for code in [
        KeyCode::Char('s'),
        KeyCode::Char('e'),
        KeyCode::Char(' '),
        KeyCode::Char('c'),
        KeyCode::Char('o'),
        KeyCode::Char('n'),
        KeyCode::Char('d'),
    ] {
        steps.push(HeadlessStep::Key(key(code)));
    }
    // Home joins nothing (TS drops its escape sequence; the raw gate
    // appended the id's own name).
    steps.push(HeadlessStep::Key(key(KeyCode::Home)));
    steps.push(HeadlessStep::WaitMs(200));
    // The operator's correction: Backspace walks the query back to empty.
    for _ in 0..7 {
        steps.push(HeadlessStep::Key(key(KeyCode::Backspace)));
    }
    steps.push(HeadlessStep::WaitMs(300));
    let frames = run_plan(steps);
    assert!(
        frames
            .iter()
            .any(|frame| frame.contains("Type to search: se cond")),
        "the typed space lands as a space"
    );
    assert!(
        frames.iter().all(|frame| !frame.contains("sespace")),
        "the space key id never joins the query as its name"
    );
    assert!(
        frames.iter().all(|frame| !frame.contains("se home")),
        "the home key id never joins the query as its name"
    );
    let last = frames.last().expect("a final frame");
    assert!(
        !last.contains("Type to search: s"),
        "the backspaced query is empty: {last}"
    );
    assert!(
        last.contains("user: first"),
        "the backspaced query returns the full tree: {last}"
    );
}
