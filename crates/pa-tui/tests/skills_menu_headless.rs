//! Headless e2e for skills-as-slash-commands (TS `interactive-mode.ts`
//! `createBaseAutocompleteProvider`): the session's `get_commands`
//! response enumerates the installed skills into the slash menu — the
//! name, the description, and the source label (`#user`, `#project`, …)
//! — so typing `/` surfaces them exactly like the TS product.
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

use anyhow::Result;
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

struct MockSupervisor {
    listener: UnixListener,
    /// Every recorded `prompt` request payload (the bare-skill guard
    /// proof: a blocked submission never reaches the wire).
    prompt_requests: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            prompt_requests: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
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
                                "activeSessionId": "s1",
                                "id": "s1",
                                "sessionId": "sess-1",
                                "sessionFile": "/tmp/sess-1.jsonl",
                            },
                        }),
                    );
                }
                "get_commands" => {
                    // TS `createAgentConnectionCommands`: the skills ride
                    // the command catalog as `skill:<name>` entries with
                    // their description and source info.
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_commands",
                            "success": true,
                            "data": {
                                "commands": [
                                    {
                                        "name": "skill:web-search",
                                        "description": "Search the web for answers",
                                        "source": "skill",
                                        "sourceInfo": {
                                            "path": "/tmp/skills/web-search/SKILL.md",
                                            "source": "local",
                                            "scope": "user",
                                            "origin": "top-level",
                                            "baseDir": "/tmp/skills/web-search",
                                        },
                                    },
                                ]
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
                "prompt" => {
                    {
                        let mut requests = self.prompt_requests.lock().expect("prompt recorder");
                        requests.push(command.clone());
                    }
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "prompt",
                            "success": true,
                        }),
                    );
                    // A minimal streamed turn: a wrongly-sent prompt
                    // still settles (a regression fails on the
                    // recorder, not on a wedged settle gate).
                    write_session_event(&mut writer, &json!({ "type": "turn_start" }));
                    write_session_event(
                        &mut writer,
                        &json!({
                            "type": "message_start",
                            "message": { "role": "user", "content": "asked" },
                        }),
                    );
                    write_session_event(
                        &mut writer,
                        &json!({
                            "type": "message_end",
                            "message": {
                                "role": "assistant",
                                "stopReason": "stop",
                                "content": [{ "type": "text", "text": "the streamed answer" }],
                            },
                        }),
                    );
                    write_session_event(&mut writer, &json!({ "type": "turn_end" }));
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

fn write_session_event(writer: &mut UnixStream, event: &Value) {
    write_json(
        writer,
        &json!({
            "type": "session_event",
            "activeSessionId": "s1",
            "event": event,
        }),
    );
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
                    "sessionName": "skills session",
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
/// default, writes succeed without persistence. The skill-commands flag
/// starts at the TS default (true), not `bool::default`.
struct StubSettings {
    enable_skill_commands: std::sync::Mutex<bool>,
}

impl Default for StubSettings {
    fn default() -> Self {
        Self {
            enable_skill_commands: std::sync::Mutex::new(true),
        }
    }
}

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
        *self
            .enable_skill_commands
            .lock()
            .expect("skill commands lock")
    }
    fn set_enable_skill_commands(&self, enabled: bool) -> Result<()> {
        *self
            .enable_skill_commands
            .lock()
            .expect("skill commands lock") = enabled;
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
        client_settings: Some(std::sync::Arc::new(StubSettings::default())),
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
        width: 100,
        height: 30,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    outcome.frames
}

/// The same plan run with the mock's prompt recorder: the frames plus
/// every `prompt` request that reached the daemon (the guard's wire
/// proof — a blocked submission stays off the wire).
fn run_plan_with_prompts(steps: Vec<HeadlessStep>) -> (Vec<String>, Vec<Value>) {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket);
    let prompt_requests = std::sync::Arc::clone(&supervisor.prompt_requests);
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
    let prompts = prompt_requests
        .lock()
        .expect("prompt recorder lock")
        .clone();
    (outcome.frames, prompts)
}

/// Typing `/skill:<prefix>` surfaces the installed skill as a slash
/// command: the menu row names it (`skill:web-search`), carries its
/// description, and shows the source label from the source info
/// (`#user`).
#[test]
fn skill_commands_surface_in_the_slash_menu() {
    let steps = vec![
        // The command-catalog fetch lands in the background (the attach
        // spawns it); give the fold a beat before typing.
        HeadlessStep::WaitMs(300),
        HeadlessStep::Type("/skill:web".to_string()),
        HeadlessStep::SettleIdle,
        HeadlessStep::WaitMs(100),
    ];
    let frames = run_plan(steps);
    assert!(!frames.is_empty(), "frames were captured");
    let all = frames.join("\n");
    assert!(
        all.contains("skill:web-search"),
        "the skill lists as a slash command: {all}"
    );
    assert!(
        all.contains("Search the web for answers"),
        "the skill description renders: {all}"
    );
    assert!(all.contains("#user"), "the source label renders: {all}");
}

/// The TS default (`enableSkillCommands: true`) applies when the
/// composition root supplies no settings seam at all — an embedded run
/// without `/settings` still lists the skills.
#[test]
fn skills_surface_without_a_settings_seam() {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket);
    let handle = std::thread::spawn(move || supervisor.serve());

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let mut opts = options(socket);
    opts.client_settings = None;
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::WaitMs(300),
            HeadlessStep::Type("/skill:web".to_string()),
            HeadlessStep::SettleIdle,
            HeadlessStep::WaitMs(100),
        ],
        width: 100,
        height: 30,
    };
    let outcome = runtime
        .block_on(run_interactive(opts, UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    let all = outcome.frames.join("\n");
    assert!(
        all.contains("skill:web-search"),
        "the TS default lists skills without a settings seam: {all}"
    );
}

/// The `enableSkillCommands` setting gates the skill list (TS default
/// true; off hides them from the autocomplete).
#[test]
fn disabled_skill_commands_stay_out_of_the_menu() {
    use pa_tui::client_settings::ClientSettings;
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket);
    let handle = std::thread::spawn(move || supervisor.serve());

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let mut opts = options(socket);
    let settings = std::sync::Arc::new(StubSettings::default());
    settings
        .set_enable_skill_commands(false)
        .expect("pin settings");
    opts.client_settings = Some(settings);
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::WaitMs(300),
            HeadlessStep::Type("/skill:web".to_string()),
            HeadlessStep::SettleIdle,
            HeadlessStep::WaitMs(100),
        ],
        width: 100,
        height: 30,
    };
    let outcome = runtime
        .block_on(run_interactive(opts, UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    let all = outcome.frames.join("\n");
    assert!(
        !all.contains("skill:web-search"),
        "the setting hides the skill commands: {all}"
    );
}

/// One plain Enter key event (the completion apply, then the submit).
fn enter() -> crossterm::event::KeyEvent {
    crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Enter,
        crossterm::event::KeyModifiers::NONE,
    )
}

/// A bare `/skill:<name>` submission (the Tab-Enter completion flow)
/// never reaches the daemon: the guard restores the draft into the
/// editor, the notice names the fix, and the prompt recorder stays
/// empty (the incident class — a bare invocation expanding into the
/// skill's protocol with no task — is blocked at the client).
#[test]
fn a_bare_skill_submit_shows_the_notice_and_never_sends() {
    let (frames, prompts) = run_plan_with_prompts(vec![
        HeadlessStep::WaitMs(300),
        HeadlessStep::Type("/skill:web".to_string()),
        HeadlessStep::SettleIdle,
        // Enter applies the completion (into the argument position), the
        // second Enter submits the bare command — the incident flow.
        HeadlessStep::Key(enter()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitMs(200),
    ]);
    assert!(
        prompts.is_empty(),
        "the bare submission never reached the daemon: {prompts:?}"
    );
    let all = frames.join("\n");
    assert!(
        all.contains("add your request after the skill"),
        "the notice renders: {all}"
    );
    assert!(
        all.contains("make a release of PR #2731"),
        "the notice carries the worked example: {all}"
    );
    let last = frames.last().expect("a frame was captured");
    assert!(
        last.contains("skill:web-search"),
        "the draft restores into the editor: {last}"
    );
}

/// The recovery is ONE step (the restored draft keeps the argument
/// position): after the guard's notice, typing the request and
/// submitting sends the command WITH the request — the trailing space
/// survives, so the keystrokes become args instead of gluing onto the
/// command name.
#[test]
fn the_bare_skill_guard_restores_into_the_argument_position() {
    let (frames, prompts) = run_plan_with_prompts(vec![
        HeadlessStep::WaitMs(300),
        HeadlessStep::Type("/skill:web".to_string()),
        HeadlessStep::SettleIdle,
        HeadlessStep::Key(enter()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitMs(150),
        // The notice showed; the user types the request straight into the
        // restored draft and submits.
        HeadlessStep::Type("find rust tuis".to_string()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitMs(300),
    ]);
    assert_eq!(prompts.len(), 1, "one prompt dispatched: {prompts:?}");
    assert_eq!(
        prompts[0].get("message").and_then(Value::as_str),
        Some("/skill:web-search find rust tuis"),
        "the typed request became the command's args: {prompts:?}"
    );
    let all = frames.join("\n");
    assert!(
        all.contains("add your request after the skill"),
        "the notice rendered before the recovery: {all}"
    );
}

/// A completed skill invocation with the request typed after it sends
/// normally: the completion lands in the argument position (the
/// trailing space), the typed request follows, and the daemon receives
/// the command with its args — the with-args path is unchanged.
#[test]
fn a_completed_skill_with_args_sends_the_command_and_request() {
    let (frames, prompts) = run_plan_with_prompts(vec![
        HeadlessStep::WaitMs(300),
        HeadlessStep::Type("/skill:web".to_string()),
        HeadlessStep::SettleIdle,
        HeadlessStep::Key(enter()),
        HeadlessStep::Type("find rust tuis".to_string()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitMs(300),
    ]);
    assert_eq!(prompts.len(), 1, "one prompt dispatched: {prompts:?}");
    assert_eq!(
        prompts[0].get("message").and_then(Value::as_str),
        Some("/skill:web-search find rust tuis"),
        "the command and the request travel together: {prompts:?}"
    );
    let all = frames.join("\n");
    assert!(
        !all.contains("add your request after the skill"),
        "the with-args submit shows no notice: {all}"
    );
}
