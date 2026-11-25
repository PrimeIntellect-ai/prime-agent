//! Headless e2e for the idle backgrounded-cell cancel's gesture contract:
//! the scoped `abort` rides ONLY the bare Escape press (the tree shortcut
//! already spent) — never the first Escape that arms the tree/clear
//! repeat, never the Ctrl+C that arms the exit pair — and the response
//! reports whether a cell was stopped.
#![cfg(unix)]
// The headless harness's serve/setup helpers exceed the 100-line lint; the
// file-level allow matches the other daemon e2e suites.
#![allow(clippy::too_many_lines)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// A recording mock supervisor: every command line lands in the log.
struct RecordingSupervisor {
    listener: UnixListener,
    commands: Arc<Mutex<Vec<Value>>>,
}

impl RecordingSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        Self {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            commands: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Serve one connection. The hello advertises the scoped-abort
    /// capability, so the gate under test is the gesture, never the peer.
    fn serve(self) -> Arc<Mutex<Vec<Value>>> {
        let commands = Arc::clone(&self.commands);
        let served = Arc::clone(&commands);
        std::thread::spawn(move || {
            let (stream, _) = self.listener.accept().expect("accept mock");
            let write_stream = stream.try_clone().expect("clone mock socket");
            let mut writer = write_stream;
            let mut reader = BufReader::new(stream);
            write_json(
                &mut writer,
                &json!({
                    "type": "daemon_hello",
                    "protocol": { "name": "prime-agent.daemon", "version": 7 },
                    "serverCapabilities": ["background_cell_abort"],
                    "clientId": "mock",
                }),
            );
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
                commands
                    .lock()
                    .expect("command log")
                    .push(envelope.get("command").cloned().unwrap_or(Value::Null));
                let id = envelope.get("id").and_then(Value::as_str).unwrap_or("");
                let command_type = envelope
                    .get("command")
                    .and_then(|command| command.get("type"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let data = match command_type.as_str() {
                    "create" => json!({
                        "activeSessionId": "s1", "id": "s1",
                        "sessionId": "sess-1", "sessionFile": "/tmp/sess-1.jsonl",
                    }),
                    "attach" => json!({
                        "protocol": { "name": "prime-agent.daemon", "version": 7 },
                        "activeSessionId": "s1",
                        "snapshot": {
                            "activeSessionId": "s1",
                            "summary": { "id": "s1", "cwd": "/tmp" },
                            "state": {
                                "activeSessionId": "s1",
                                "cwd": "/tmp",
                                "sessionId": "sess-1",
                                "sessionName": "cell cancel",
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
                    }),
                    "get_commands" => json!({ "commands": [] }),
                    "get_session_stats" => json!({
                        "contextUsage": { "tokens": 1200, "contextWindow": 200_000 },
                        "cost": 0.01,
                    }),
                    "get_session_tree" => json!({
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
                    }),
                    "abort" => json!({ "stoppedBackgroundCell": true }),
                    _ => json!({}),
                };
                write_json(
                    &mut writer,
                    &json!({
                        "type": "response",
                        "id": id,
                        "command": command_type,
                        "success": true,
                        "data": data,
                    }),
                );
            }
        });
        served
    }
}

fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

fn esc() -> HeadlessStep {
    HeadlessStep::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
}

fn ctrl_c() -> HeadlessStep {
    HeadlessStep::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL))
}

fn run_plan(steps: Vec<HeadlessStep>) -> (Vec<String>, Arc<Mutex<Vec<Value>>>) {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = RecordingSupervisor::bind(&socket);
    let commands = supervisor.serve();

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
    (outcome.frames, commands)
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

/// A minimal settings seam for the harness: every getter returns its TS default, writes succeed
/// without persistence.
struct StubSettings;

impl pa_tui::client_settings::ClientSettings for StubSettings {
    fn compaction_threshold_percent(&self) -> f64 {
        95.0
    }
    fn set_compaction_threshold_percent(&self, _percent: f64) -> Result<()> {
        Ok(())
    }
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

fn scoped_aborts(commands: &Arc<Mutex<Vec<Value>>>) -> Vec<Value> {
    commands
        .lock()
        .expect("command log")
        .iter()
        .filter(|command| {
            command.get("type").and_then(Value::as_str) == Some("abort")
                && command.get("scope").and_then(Value::as_str) == Some("background_cell")
        })
        .cloned()
        .collect()
}

/// The arming presses never send the scoped abort: one first Escape
/// (arms the tree repeat), one first Ctrl+C (arms the exit pair) at an
/// idle session — no `abort` command with scope `background_cell` may
/// leave the TUI.
#[test]
fn the_arming_presses_never_stop_the_backgrounded_cell() {
    let steps = vec![
        HeadlessStep::WaitMs(300),
        esc(),
        HeadlessStep::WaitMs(150),
        ctrl_c(),
        HeadlessStep::WaitMs(300),
    ];
    let (_frames, commands) = run_plan(steps);
    assert!(
        scoped_aborts(&commands).is_empty(),
        "the arming gestures never sent the scoped abort: {:?}",
        scoped_aborts(&commands)
    );
}

/// The bare press sends it: the tree-shortcut-spent Escape stops the
/// parked cell, and the response's stopped-report lands as a note.
#[test]
fn the_bare_escape_stops_the_parked_cell_and_reports_it() {
    // Esc Esc opens the tree (the shortcut fires), Esc leaves it; the
    // NEXT idle Escape arms nothing (the tree shortcut is spent) and
    // stops the parked cell.
    let steps = vec![
        HeadlessStep::WaitMs(300),
        esc(),
        esc(),
        HeadlessStep::WaitMs(150),
        esc(),
        HeadlessStep::WaitMs(150),
        esc(),
        HeadlessStep::WaitMs(400),
    ];
    let (frames, commands) = run_plan(steps);
    let aborts = scoped_aborts(&commands);
    assert_eq!(
        aborts.len(),
        1,
        "exactly the bare press sent the scoped abort: {aborts:?}"
    );
    let last = frames.last().expect("the run captured frames");
    assert!(
        last.contains("the backgrounded cell was stopped"),
        "the response's stopped-report lands as a note: {last}"
    );
}
