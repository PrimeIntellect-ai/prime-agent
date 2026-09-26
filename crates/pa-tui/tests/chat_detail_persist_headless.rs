//! Headless e2e for the persisted conversation-detail level (TS #2709
//! "Keep the chat detail level across sessions"): Ctrl+O saves the cycled
//! level as the `chatDetail` setting, and a later chat — the same session
//! re-entered or a brand-new one, both a fresh process re-reading the
//! settings store — opens at the saved level instead of resetting to the
//! `details` startup default.
#![cfg(unix)]

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

/// The session identity one run attaches to: the second run of the
/// regression uses a different id, so the saved level is shown to apply
/// to another chat too (the setting is global; TS #2709's `createMode`
/// opens a new client at the saved level).
struct MockSession {
    active: &'static str,
    wire: &'static str,
    name: &'static str,
}

struct MockSupervisor {
    listener: UnixListener,
    session: MockSession,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path, session: MockSession) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            session,
        }
    }

    /// Serve one connection: attach an empty session, then answer the
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
                                "activeSessionId": self.session.active,
                                "id": self.session.active,
                                "sessionId": self.session.wire,
                                "sessionFile": format!("/tmp/{}.jsonl", self.session.wire),
                            },
                        }),
                    );
                }
                "attach" => {
                    write_json(&mut writer, &attach_data(id, &self.session));
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
fn attach_data(id: &str, session: &MockSession) -> Value {
    json!({
        "type": "response",
        "id": id,
        "command": "attach",
        "success": true,
        "data": {
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "activeSessionId": session.active,
            "snapshot": {
                "activeSessionId": session.active,
                "summary": { "id": session.active, "cwd": "/tmp" },
                "state": {
                    "activeSessionId": session.active,
                    "cwd": "/tmp",
                    "sessionId": session.wire,
                    "sessionName": session.name,
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

/// A minimal settings seam for the harness: every getter returns its TS
/// default; the `chatDetail` pair is stateful — the store models the
/// settings file a fresh process re-reads.
#[derive(Default)]
struct StubSettings {
    chat_detail: Mutex<Option<String>>,
}

impl StubSettings {
    /// The stored level (what the settings file holds after a save).
    fn stored(&self) -> Option<String> {
        self.chat_detail.lock().expect("chat detail lock").clone()
    }
}

impl pa_tui::client_settings::ClientSettings for StubSettings {
    fn theme(&self) -> Option<String> {
        None
    }
    fn set_theme(&self, _theme: &str) -> Result<()> {
        Ok(())
    }
    fn fullscreen(&self) -> bool {
        true
    }
    fn set_fullscreen(&self, _enabled: bool) -> Result<()> {
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
    fn set_autocomplete_max_visible(&self, _max_visible: u64) -> Result<()> {
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
    fn chat_detail(&self) -> String {
        // TS `getChatDetail`: unset reads as the `details` startup level.
        self.stored().unwrap_or_else(|| "details".to_string())
    }
    fn set_chat_detail(&self, detail: &str) -> Result<()> {
        *self.chat_detail.lock().expect("chat detail lock") = Some(detail.to_string());
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
    fn effective_update_channel(&self, version: &str) -> String {
        if version.contains("-beta") {
            "nightly".to_string()
        } else {
            "stable".to_string()
        }
    }
}

fn options(socket: PathBuf, settings: Arc<StubSettings>) -> InteractiveOptions {
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
        client_settings: Some(settings),
    }
}

fn run_plan(
    settings: Arc<StubSettings>,
    session: MockSession,
    steps: Vec<HeadlessStep>,
) -> Vec<String> {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket, session);
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
            options(socket, settings),
            UiMode::Headless(plan),
        ))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    outcome.frames
}

fn ctrl_o() -> KeyEvent {
    KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL)
}

const DETAILS_LABEL: &str = "Details mode (Ctrl+O to expand)";
const ALL_LABEL: &str = "Expanded mode (Ctrl+O to collapse)";
const OVERVIEW_LABEL: &str = "Collapsed mode (Ctrl+O to expand)";

fn wait_label(label: &str) -> HeadlessStep {
    HeadlessStep::WaitRender {
        needle: label.to_string(),
        timeout_ms: 10_000,
    }
}

/// TS #2709's regression shape: pick a level with Ctrl+O in one chat;
/// the pick is saved as the `chatDetail` setting, and a later run — a
/// fresh process re-reading the settings store — opens at the saved
/// level with no key pressed. The later run attaches to a DIFFERENT
/// session id: the setting is global (the TS mechanism), so the saved
/// level applies to that chat too.
#[test]
fn ctrl_o_pick_persists_and_a_later_chat_reopens_at_it() {
    // Run one: an unset store, so the chat starts at the TS startup
    // level `details`; one Ctrl+O cycles to `all` and saves it.
    let run_one = Arc::new(StubSettings::default());
    let frames = run_plan(
        run_one.clone(),
        MockSession {
            active: "s1",
            wire: "sess-1",
            name: "detail persist session",
        },
        vec![
            wait_label(DETAILS_LABEL),
            HeadlessStep::Key(ctrl_o()),
            wait_label(ALL_LABEL),
        ],
    );
    let all = frames.join("\n");
    assert!(
        all.contains(DETAILS_LABEL),
        "the chat starts at the details startup level: {all}"
    );
    assert!(
        all.contains(ALL_LABEL),
        "ctrl+o cycles the visible level to all: {all}"
    );
    assert_eq!(
        run_one.stored().as_deref(),
        Some("all"),
        "the ctrl+o pick saves the chatDetail setting"
    );

    // Run two: a fresh process whose settings store carries the saved
    // level (the file the first run wrote), opening a different chat.
    // TS #2709 (`next = createMode(harness)`): it starts at `all`, with
    // no key pressed, and nothing re-saves.
    let run_two = Arc::new(StubSettings {
        chat_detail: Mutex::new(Some("all".to_string())),
    });
    let frames = run_plan(
        run_two.clone(),
        MockSession {
            active: "s2",
            wire: "sess-2",
            name: "the next chat",
        },
        vec![wait_label(ALL_LABEL)],
    );
    let all = frames.join("\n");
    assert!(
        !all.contains(DETAILS_LABEL),
        "a later chat opens at the saved level, not the details default: {all}"
    );
    assert!(
        all.contains(ALL_LABEL),
        "a later chat renders the saved all level: {all}"
    );
    assert_eq!(
        run_two.stored().as_deref(),
        Some("all"),
        "opening at the saved level re-saves nothing"
    );
}

/// The cycle saves every level, not just one hop: a chat opening at
/// `all` wraps to `overview` on the next Ctrl+O and saves that too.
#[test]
fn the_cycle_saves_the_overview_wrap_too() {
    let settings = Arc::new(StubSettings {
        chat_detail: Mutex::new(Some("all".to_string())),
    });
    let frames = run_plan(
        settings.clone(),
        MockSession {
            active: "s1",
            wire: "sess-1",
            name: "wrap session",
        },
        vec![
            wait_label(ALL_LABEL),
            HeadlessStep::Key(ctrl_o()),
            wait_label(OVERVIEW_LABEL),
        ],
    );
    let all = frames.join("\n");
    assert!(
        all.contains(OVERVIEW_LABEL),
        "ctrl+o wraps all -> overview: {all}"
    );
    assert_eq!(
        settings.stored().as_deref(),
        Some("overview"),
        "the wrap saves the overview level"
    );
}
