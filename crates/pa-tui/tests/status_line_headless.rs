//! Headless e2e for the user status line (settings `statusLine`): the
//! configured command runs with the session payload on stdin, and its stdout
//! renders as footer rows in the dock; a failing command renders nothing and
//! the built-in chrome stays.
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
use std::sync::Arc;

use anyhow::Result;
use pa_tui::client_settings::ClientSettings;
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use pa_types::status_line::StatusLineSpec;
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

    /// Serve one connection: create, attach, and a success response for the rest.
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        let mut writer = stream.try_clone().expect("clone mock socket");
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
                    "sessionName": "status line session",
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

/// The test settings seam: only `statusLine` is meaningful here.
struct MockClientSettings {
    status_line: Option<StatusLineSpec>,
}

impl ClientSettings for MockClientSettings {
    fn status_line(&self) -> Option<pa_types::status_line::StatusLineSpec> {
        self.status_line.clone()
    }

    fn compaction_threshold_percent(&self) -> f64 {
        0.9
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
        "30".to_string()
    }

    fn set_idle_eviction_minutes(&self, _value: &str) -> Result<()> {
        Ok(())
    }

    fn mermaid_rendering_mode(&self) -> String {
        "final".to_string()
    }

    fn set_mermaid_rendering_mode(&self, _mode: &str) -> Result<()> {
        Ok(())
    }

    fn tree_filter_mode(&self) -> String {
        "default".to_string()
    }

    fn set_tree_filter_mode(&self, _mode: &str) -> Result<()> {
        Ok(())
    }

    fn default_service_tier(&self) -> String {
        "default".to_string()
    }

    fn set_default_service_tier(&self, _tier: &str) -> Result<()> {
        Ok(())
    }

    fn factory_enabled(&self) -> bool {
        false
    }

    fn set_factory_enabled(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }

    fn chat_detail(&self) -> String {
        "overview".to_string()
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

    fn telemetry_status(&self) -> String {
        "off".to_string()
    }

    fn set_telemetry_enabled(&self, _enabled: bool) -> Result<String> {
        Ok("off".to_string())
    }
}

fn options(
    socket: PathBuf,
    client_settings: Option<Arc<dyn ClientSettings>>,
) -> InteractiveOptions {
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
        client_settings,
    }
}

fn run_plan(
    client_settings: Option<Arc<dyn ClientSettings>>,
    steps: Vec<HeadlessStep>,
) -> Vec<String> {
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
        .block_on(run_interactive(
            options(socket, client_settings),
            UiMode::Headless(plan),
        ))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    outcome.frames
}

/// A configured `statusLine` command runs and its stdout renders as footer rows in the dock.
#[test]
fn the_status_line_command_renders_footer_rows() {
    // Wait for the rendered needle (condition wait, not a fixed sleep): the worker thread
    // stores the output and the frame wake above repaints it.
    let steps = vec![HeadlessStep::WaitRender {
        needle: "PRIME-SL-OK".to_string(),
        timeout_ms: 10_000,
    }];
    let frames = run_plan(
        Some(Arc::new(MockClientSettings {
            status_line: Some(StatusLineSpec {
                command: "printf 'PRIME-SL-OK\\nsecond line'".to_string(),
                padding: None,
            }),
        })),
        steps,
    );
    assert!(!frames.is_empty(), "frames were captured");
    let all = frames.join("\n");
    let frame = frames
        .iter()
        .find(|frame| frame.contains("PRIME-SL-OK"))
        .unwrap_or_else(|| panic!("the status line rendered:\n{all}"));
    assert!(
        frame.contains("second line"),
        "the multi-line status line renders in the same dock:\n{frame}"
    );
}

/// A command that exits non-zero renders no status line: the failure keeps the
/// previous output (none here), and the built-in chrome stays.
#[test]
fn a_failing_command_renders_no_status_line() {
    // Wait for the attach frame (the session name in the top bar), then a bounded margin so
    // the failing command has run; the absence is what the assertion checks.
    let steps = vec![
        HeadlessStep::WaitRender {
            needle: "status line session".to_string(),
            timeout_ms: 10_000,
        },
        HeadlessStep::WaitMs(500),
    ];
    let frames = run_plan(
        Some(Arc::new(MockClientSettings {
            status_line: Some(StatusLineSpec {
                command: "echo PRIME-SL-FAIL; exit 3".to_string(),
                padding: None,
            }),
        })),
        steps,
    );
    let all = frames.join("\n");
    assert!(
        !all.contains("PRIME-SL-FAIL"),
        "the failed command printed no footer rows:\n{all}"
    );
}
