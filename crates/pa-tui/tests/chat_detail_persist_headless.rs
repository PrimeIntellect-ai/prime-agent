//! Headless e2e for the persisted conversation-detail level (TS #2709):
//! Ctrl+O saves the cycled level as the `chatDetail` setting, and a later
//! chat — the same session re-entered or a fresh one — opens at the saved
//! level instead of the `overview` startup default.
#![cfg(unix)]
#![warn(clippy::allow_attributes_without_reason)]

mod support;

use std::os::unix::net::UnixListener;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::interactive::{HeadlessPlan, HeadlessStep, InteractiveOptions};
use serde_json::{json, Value};

use support::{options, run_headless, serve_connection, write_json, Request};

/// The session identity one run attaches to: the second run uses a different id, so the saved
/// level is shown to apply to another chat too.
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

    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        serve_connection(stream, &[], |writer, Request { id, kind, .. }| {
            match kind {
                "create" => {
                    write_json(
                        writer,
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
                    write_json(writer, &attach_data(id, &self.session));
                }
                _ => return false,
            }
            true
        });
    }
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

/// A minimal settings seam for the harness: every getter returns its TS default; the `chatDetail`
/// pair is stateful — the store models the settings file a fresh process re-reads.
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
    fn compaction_threshold_percent(&self) -> f64 {
        95.0
    }
    fn set_compaction_threshold_percent(&self, _percent: f64) -> Result<()> {
        Ok(())
    }

    fn theme(&self) -> Option<String> {
        None
    }
    fn image_model(&self) -> Option<String> {
        None
    }
    fn default_service_tier(&self) -> String {
        "default".to_string()
    }
    fn set_default_service_tier(&self, _tier: &str) -> Result<()> {
        Ok(())
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
        // `getChatDetail`: unset reads as the `overview` startup level (the collapse mode; operator
        // directive 2026-09-28).
        self.stored().unwrap_or_else(|| "overview".to_string())
    }
    fn set_chat_detail(&self, detail: &str) -> Result<()> {
        *self.chat_detail.lock().expect("chat detail lock") = Some(detail.to_string());
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
    fn effective_update_channel(&self, version: &str) -> String {
        if version.contains("-beta") {
            "nightly".to_string()
        } else {
            "stable".to_string()
        }
    }
}

fn run_plan(
    settings: Arc<StubSettings>,
    session: MockSession,
    steps: Vec<HeadlessStep>,
) -> Vec<String> {
    let outcome = run_headless(
        HeadlessPlan {
            steps,
            width: 100,
            height: 30,
        },
        |socket| InteractiveOptions {
            client_settings: Some(settings),
            ..options(socket)
        },
        |socket| {
            let supervisor = MockSupervisor::bind(socket, session);
            move || supervisor.serve()
        },
    );
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

/// TS #2709's regression shape: pick a level with Ctrl+O in one chat; the pick is saved as the
/// `chatDetail` setting, and a later run — a fresh process re-reading the store — opens at the
/// saved level. The later run attaches to a DIFFERENT session id: the setting is global.
#[test]
fn ctrl_o_pick_persists_and_a_later_chat_reopens_at_it() {
    // Run one: an unset store, so the chat starts at the `overview` startup level (the collapse
    // mode); one Ctrl+O reveals the thinking (details-with-thinking) and saves it.
    let run_one = Arc::new(StubSettings::default());
    let frames = run_plan(
        run_one.clone(),
        MockSession {
            active: "s1",
            wire: "sess-1",
            name: "detail persist session",
        },
        vec![
            wait_label(OVERVIEW_LABEL),
            HeadlessStep::Key(ctrl_o()),
            wait_label(DETAILS_LABEL),
        ],
    );
    let all = frames.join("\n");
    assert!(
        all.contains(OVERVIEW_LABEL),
        "the chat starts at the collapsed startup level: {all}"
    );
    assert!(
        all.contains(DETAILS_LABEL),
        "ctrl+o reveals the thinking level: {all}"
    );
    assert_eq!(
        run_one.stored().as_deref(),
        Some("details"),
        "the ctrl+o pick saves the chatDetail setting"
    );

    // Run two: a fresh process whose store carries the saved level, opening a different chat. TS
    // #2709 (`next = createMode(harness)`): it starts at `details`, no key pressed.
    let run_two = Arc::new(StubSettings {
        chat_detail: Mutex::new(Some("details".to_string())),
    });
    let frames = run_plan(
        run_two.clone(),
        MockSession {
            active: "s2",
            wire: "sess-2",
            name: "the next chat",
        },
        vec![wait_label(DETAILS_LABEL)],
    );
    let all = frames.join("\n");
    assert!(
        !all.contains(OVERVIEW_LABEL),
        "a later chat opens at the saved level, not the collapsed default: {all}"
    );
    assert!(
        all.contains(DETAILS_LABEL),
        "a later chat renders the saved details level: {all}"
    );
    assert_eq!(
        run_two.stored().as_deref(),
        Some("details"),
        "opening at the saved level re-saves nothing"
    );
}

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
