//! Headless e2e for the `/settings` menu's UX pass (the operator's
//! 2026-09-28 directive set): the spacing between the header/tabs and
//! the settings list (and between the tabs themselves), the arrow
//! value-cycling with its persisted writes, the Tab/number tab keys
//! (the arrows' old tab job is rebinded away), the detail block's
//! separator rule, the description-matched hint padding, the two
//! open-into-a-setting regression pins (the top bar and the padding-x
//! stay), the search field's edit keys after a no-match query, and the
//! fullscreen setting's retirement (the always-fullscreen surface has no
//! toggle left to advertise).
#![cfg(unix)]
// Pedantic-gate exceptions (every other pedantic warning in this crate is
// fixed in place; each exception carries its one-line justification):
// - the casts: terminal-layout arithmetic narrows structurally bounded
//   values (screen coordinates, byte counts, timestamps); guarded
//   conversions would add panic paths the bounds guarantee away.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// - the render routes are flat tables (one arm per route); splitting them
//   would add indirection without changing the flow.
#![allow(clippy::too_many_lines)]
// - widget state structs carry independent flag bits; a nested struct
//   would add indirection without changing the shape.
#![allow(clippy::struct_excessive_bools, clippy::fn_params_excessive_bools)]
// - the futures are bounded by the surface's lifetime; boxing them would
//   add an allocation to the steady-state loop.
#![allow(clippy::large_futures)]
// - the wrappers preserve a uniform Result-returning API surface; unwrap
//   removals would ripple through the callers without changing behavior.
#![allow(clippy::unnecessary_wraps)]

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

/// The rule row's glyph: the settings page's bars (the search field's
/// borders, the detail block's separator).
const RULE: &str = "\u{2500}";

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
    /// loop's requests. The connection state carries the session's
    /// thinking levels (the Models tab's submenu rows read them).
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
                            "data": { "commands": [] }
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
                "get_connection_state" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_connection_state",
                            "success": true,
                            "data": {
                                "activeSessionId": "s1",
                                "sessionId": "sess-1",
                                "sessionName": "settings session",
                                "autoCompactionEnabled": true,
                                "steeringMode": "all",
                                "followUpMode": "one-at-a-time",
                                "thinkingLevel": "low",
                                "availableThinkingLevels": ["low", "high"],
                                "isStreaming": false,
                            },
                        }),
                    );
                }
                "detach" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response", "id": id, "command": "detach", "success": true,
                        }),
                    );
                }
                _ => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response", "id": id, "command": command_type, "success": true, "data": {},
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
                    "sessionName": "settings session",
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

/// The recording settings seam: every setter appends `name=value` to the
/// log the arrow-cycling test reads (the persisted-write side of the
/// value cycling rides this seam for the rows under test).
struct RecordingSettings {
    writes: Mutex<Vec<String>>,
}

impl Default for RecordingSettings {
    fn default() -> Self {
        Self {
            writes: Mutex::new(Vec::new()),
        }
    }
}

impl RecordingSettings {
    fn record(&self, entry: &str) -> Result<()> {
        self.writes
            .lock()
            .expect("writes lock")
            .push(entry.to_string());
        Ok(())
    }

    fn log(&self) -> Vec<String> {
        self.writes.lock().expect("writes lock").clone()
    }
}

impl pa_tui::client_settings::ClientSettings for RecordingSettings {
    fn theme(&self) -> Option<String> {
        None
    }
    fn set_theme(&self, theme: &str) -> Result<()> {
        self.record(&format!("theme={theme}"))
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
    fn set_quiet_startup(&self, quiet: bool) -> Result<()> {
        self.record(&format!("quiet-startup={quiet}"))
    }
    fn idle_eviction_minutes(&self) -> String {
        "90".to_string()
    }
    fn set_idle_eviction_minutes(&self, value: &str) -> Result<()> {
        self.record(&format!("idle-eviction-minutes={value}"))
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
        "default".to_string()
    }
    fn set_default_service_tier(&self, _tier: &str) -> Result<()> {
        Ok(())
    }
    fn chat_detail(&self) -> String {
        "details".to_string()
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
    fn effective_update_channel(&self, version: &str) -> String {
        if version.contains("-beta") {
            "nightly".to_string()
        } else {
            "stable".to_string()
        }
    }
}

fn options(socket: PathBuf, settings: Arc<RecordingSettings>) -> InteractiveOptions {
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
        prompt_stash: Arc::default(),
        session_has_children: false,
        restore_dock_focus: false,
        client_settings: Some(settings),
    }
}

/// Run a plan against the mock daemon, with the recording settings seam.
fn run_plan(steps: Vec<HeadlessStep>) -> (Vec<String>, Arc<RecordingSettings>) {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket);
    let handle = std::thread::spawn(move || supervisor.serve());

    let settings = Arc::new(RecordingSettings::default());
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
            options(socket, settings.clone()),
            UiMode::Headless(plan),
        ))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    (outcome.frames, settings)
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

/// The frame rows as text, one String per row, with the frame's
/// full-width padding trimmed (the composed frame pads every row to the
/// terminal width; the asserts read the content).
fn frame_rows(frame: &str) -> Vec<String> {
    frame
        .split('\n')
        .map(|row| row.trim_end().to_string())
        .collect()
}

/// The last frame that contains `needle` (the plan's condition waits
/// guarantee it exists by the time the run ends).
fn frame_with(frames: &[String], needle: &str) -> Vec<String> {
    frames
        .iter()
        .rev()
        .find(|frame| frame.contains(needle))
        .map_or_else(
            || panic!("no frame contains {needle:?}"),
            |frame| frame_rows(frame),
        )
}

fn open_settings() -> Vec<HeadlessStep> {
    vec![
        HeadlessStep::WaitMs(300),
        HeadlessStep::Submit("/settings".to_string()),
        HeadlessStep::WaitRender {
            needle: "General".to_string(),
            timeout_ms: 5000,
        },
    ]
}

/// The settings page renders its spacing pass: a blank row above and
/// below the tab strip (the strip its own budget away from the search
/// field and the settings list), four spaces between the tabs, the
/// separator rule below the description above the keyboard-shortcuts
/// row, and the hint row carrying the description's padding — with the
/// new key vocabulary the operator's rebind mandates.
#[test]
fn the_settings_page_renders_the_spacing_and_the_new_keys() {
    let (frames, _) = run_plan(open_settings());
    let rows = frame_with(&frames, "Type to search");
    let strip_index = rows
        .iter()
        .position(|row| row.starts_with("  1 General"))
        .expect("the tab strip renders");
    assert_eq!(
        rows[strip_index], "  1 General    2 Models    3 Display    4 Editor    5 Agents",
        "the tabs sit four spaces apart (the spacing pass)"
    );
    // A blank row rides between the search field's bottom rule and the
    // strip, and between the strip and the settings list.
    assert_eq!(rows[strip_index - 1], "", "the blank above the strip");
    assert_eq!(
        rows[strip_index - 2],
        RULE.repeat(100),
        "the search field's bottom rule rides above the blank"
    );
    assert_eq!(rows[strip_index + 1], "", "the blank below the strip");
    assert!(
        rows[strip_index + 2].starts_with("\u{203a} Auto-compact"),
        "the settings list begins below the blank"
    );
    // The detail block: the description's two-space padding, the
    // separator rule below it, and the hint row above nothing else —
    // with the hint's own two-space padding (the padding match).
    let hint_index = rows
        .iter()
        .position(|row| row.starts_with("  Type to search"))
        .expect("the hint row renders");
    assert_eq!(
        rows[hint_index - 1],
        RULE.repeat(100),
        "the separator rule rides below the description, above the hint"
    );
    assert!(
        rows[hint_index - 2].starts_with("  Automatically compact"),
        "the description rides above the rule with its padding"
    );
    assert!(
        rows[hint_index].starts_with(
            "  Type to search · Tab/1-5 tabs · \u{2190}/\u{2192}/Enter/Space change · Esc close"
        ),
        "the hint names the Tab/number tab keys and the arrow value keys: {:?}",
        rows[hint_index]
    );
    // The fullscreen row is retired from the settings page.
    assert!(
        !frames.join("\n").contains("Fullscreen rendering"),
        "the fullscreen setting no longer lists"
    );
}

/// The arrows cycle the focused setting's value and the change persists
/// through the settings seam: right flips the Quiet startup toggle to
/// true (the write lands in the seam), left flips it back, Enter keeps
/// its cycle; the multi-option Idle eviction row walks its list the same
/// way.
#[test]
fn the_arrows_cycle_values_and_the_writes_persist() {
    let mut steps = open_settings();
    // Down x3 lands the selection on Quiet startup (General's fourth row).
    for _ in 0..3 {
        steps.push(HeadlessStep::Key(key(KeyCode::Down)));
    }
    steps.push(HeadlessStep::WaitMs(100));
    // Right cycles false -> true (the toggle).
    steps.push(HeadlessStep::Key(key(KeyCode::Right)));
    steps.push(HeadlessStep::WaitMs(100));
    // Left cycles back true -> false.
    steps.push(HeadlessStep::Key(key(KeyCode::Left)));
    steps.push(HeadlessStep::WaitMs(100));
    // Enter keeps its cycle: false -> true again.
    steps.push(HeadlessStep::Key(key(KeyCode::Enter)));
    steps.push(HeadlessStep::WaitMs(100));
    // 5 jumps to the Agents tab; down x2 lands on Idle worker eviction
    // (a multi-option row: off/30/60/90/180/360).
    steps.push(HeadlessStep::Key(key(KeyCode::Char('5'))));
    steps.push(HeadlessStep::WaitMs(100));
    steps.push(HeadlessStep::Key(key(KeyCode::Down)));
    steps.push(HeadlessStep::Key(key(KeyCode::Down)));
    steps.push(HeadlessStep::Key(key(KeyCode::Right)));
    steps.push(HeadlessStep::WaitMs(100));
    steps.push(HeadlessStep::Key(key(KeyCode::Left)));
    steps.push(HeadlessStep::WaitMs(150));
    let (frames, settings) = run_plan(steps);
    // The toggle: the row shows true (Enter's cycle landed last), and
    // the seam recorded the exact write sequence the arrows drove.
    let rows = frame_with(&frames, "Quiet startup");
    let row = rows
        .iter()
        .find(|row| row.contains("Quiet startup"))
        .expect("the quiet-startup row renders");
    assert!(row.contains("true"), "the cycled value shows: {row}");
    assert_eq!(
        settings.log(),
        vec![
            "quiet-startup=true",
            "quiet-startup=false",
            "quiet-startup=true",
            "idle-eviction-minutes=180",
            "idle-eviction-minutes=90",
        ],
        "every arrow cycle persisted through the settings seam"
    );
}

/// The rebind: left/right no longer switch tabs — the focused row's
/// value cycles instead — while Tab and the number keys move the tabs.
#[test]
fn tab_and_the_number_keys_move_the_tabs_not_the_arrows() {
    let mut steps = open_settings();
    // Right on General cycles Auto-compact's value; the General rows
    // still own the frame (no tab switch).
    steps.push(HeadlessStep::Key(key(KeyCode::Right)));
    steps.push(HeadlessStep::WaitMs(100));
    // Tab switches General -> Models.
    steps.push(HeadlessStep::Key(key(KeyCode::Tab)));
    steps.push(HeadlessStep::WaitMs(100));
    // 1 jumps back to General.
    steps.push(HeadlessStep::Key(key(KeyCode::Char('1'))));
    steps.push(HeadlessStep::WaitMs(100));
    // 3 jumps to Display.
    steps.push(HeadlessStep::Key(key(KeyCode::Char('3'))));
    steps.push(HeadlessStep::WaitMs(150));
    let (frames, _) = run_plan(steps);
    // Right after the menu opened: the General tab's rows stayed up
    // (the value cycled, not the tab).
    let after_right = frame_with(&frames, "Auto-compact");
    assert!(after_right.iter().any(|row| row.contains("Steering mode")));
    assert!(!after_right.iter().any(|row| row.contains("Transport")));
    // Tab moved to Models (Transport renders) — the arrow's old job.
    let after_tab = frame_with(&frames, "Transport");
    assert!(after_tab.iter().any(|row| row.contains("Thinking level")));
    // 1 jumped back to General.
    assert!(frame_with(&frames, "Warnings")
        .iter()
        .any(|row| row.contains("Quiet startup")));
    // 3 jumped to Display — and the retired fullscreen row is not there.
    let display = frame_with(&frames, "Mermaid diagrams");
    assert!(display.iter().any(|row| row.contains("Theme")));
    assert!(
        !display
            .iter()
            .any(|row| row.contains("Fullscreen rendering")),
        "the retired setting does not render"
    );
}

/// Opening into a setting (the submenu) keeps the top bar and the
/// padding-x (the two regression pins): the full-width rule that
/// separates the settings surface from the chat view stays over the
/// submenu, and the setting's name and description keep the list rows'
/// two-space padding — the submenu's own hint row too.
#[test]
fn opening_into_a_setting_keeps_the_bar_and_the_padding() {
    let mut steps = open_settings();
    // 2 jumps to the Models tab; Enter opens the Thinking level submenu.
    steps.push(HeadlessStep::Key(key(KeyCode::Char('2'))));
    steps.push(HeadlessStep::WaitMs(100));
    steps.push(HeadlessStep::Key(key(KeyCode::Enter)));
    steps.push(HeadlessStep::WaitRender {
        needle: "Thinking Level".to_string(),
        timeout_ms: 5000,
    });
    steps.push(HeadlessStep::WaitMs(150));
    let (frames, _) = run_plan(steps);
    let rows = frame_with(&frames, "Thinking Level");
    let title_index = rows
        .iter()
        .position(|row| row == "  Thinking Level")
        .expect("the submenu title renders with its padding");
    // The top bar stays: the rule row directly above the title.
    assert_eq!(
        rows[title_index - 1],
        RULE.repeat(100),
        "the menu's top bar stays over the submenu"
    );
    // The description keeps its padding.
    let description = rows
        .iter()
        .find(|row| row.starts_with("  Select reasoning depth"))
        .expect("the padded description renders");
    assert!(description.contains("Select reasoning depth for thinking-capable models"));
    // The submenu's options render through the shared menu-row grammar
    // (the session's levels from the connection state).
    assert!(rows.iter().any(|row| row.contains("\u{203a} low")));
    assert!(rows.iter().any(|row| row.contains("high")));
    // The back hint carries the description's padding too.
    assert!(rows
        .iter()
        .any(|row| row.starts_with("  Enter select · Esc back")));
}

/// The fullscreen setting retires everywhere: no settings row on any
/// tab, and the `/fullscreen` slash command no longer completes (the
/// surface is fullscreen-only; a toggle for an unsupported mode is
/// worse than none).
#[test]
fn the_fullscreen_setting_and_command_are_retired() {
    let mut steps = open_settings();
    // Walk every tab and collect the frames.
    for digit in ['1', '2', '3', '4', '5'] {
        steps.push(HeadlessStep::Key(key(KeyCode::Char(digit))));
        steps.push(HeadlessStep::WaitMs(100));
    }
    steps.push(HeadlessStep::WaitMs(150));
    let (frames, _) = run_plan(steps);
    let all = frames.join("\n");
    assert!(
        !all.contains("Fullscreen rendering"),
        "no tab lists the retired setting: {all}"
    );
    assert!(
        !all.contains("Alternate-screen UI"),
        "the retired setting's description is gone: {all}"
    );

    // The slash menu: /full completes to nothing fullscreen-shaped.
    let (frames, _) = run_plan(vec![
        HeadlessStep::WaitMs(300),
        HeadlessStep::Type("/full".to_string()),
        HeadlessStep::SettleIdle,
        HeadlessStep::WaitMs(200),
    ]);
    let all = frames.join("\n");
    assert!(
        !all.contains("Toggle fullscreen"),
        "the retired command no longer completes: {all}"
    );
    assert!(
        !all.contains("Fullscreen (alternate screen)"),
        "the retired command's description is gone: {all}"
    );
}

/// The search field keeps its edit keys after a no-match query: the
/// garbage backspaces away, the rows return, and Space still cycles
/// the selected row (TS `SettingsList.handleInput`).
#[test]
fn a_no_match_query_backspaces_away_and_space_still_cycles() {
    let mut steps = open_settings();
    for c in ['z', 'q', 'x'] {
        steps.push(HeadlessStep::Key(key(KeyCode::Char(c))));
    }
    steps.push(HeadlessStep::WaitRender {
        needle: "No matching settings".to_string(),
        timeout_ms: 5000,
    });
    for _ in 0..3 {
        steps.push(HeadlessStep::Key(key(KeyCode::Backspace)));
    }
    steps.push(HeadlessStep::WaitRender {
        needle: "Auto-compact".to_string(),
        timeout_ms: 5000,
    });
    steps.push(HeadlessStep::Key(key(KeyCode::Char(' '))));
    steps.push(HeadlessStep::WaitMs(300));
    let (frames, _) = run_plan(steps);
    let rows = frame_rows(frames.last().expect("the run captured frames"));
    let row = rows
        .iter()
        .find(|row| row.contains("Auto-compact"))
        .expect("the settings rows return once the query is backspaced away");
    assert!(
        row.contains("false"),
        "Space still cycles the selected row: {row}"
    );
}
