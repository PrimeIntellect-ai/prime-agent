//! Headless e2e for the Anthropic subscription warning's once-per-session
//! LIFECYCLE gate (operator directive 2026-09-29): the warning fired on
//! every session open because its shown-flag lived on the TUI instance;
//! the fix persists the shown-state with the session (the daemon's
//! `anthropicWarningShown` served through `get_state`, marked through
//! `mark_anthropic_warning_shown`), so a genuinely new session warns once,
//! a reattach or a resume of a marked session never re-renders it, the
//! `warnings.anthropicExtraUsage` toggle stays first, and a FRESH auth
//! landing (a completed subscription login) still re-warns — each landing
//! is its own event. The daemon half (the marker row, the hydration, the
//! idempotent handler) is covered by the pa-daemon suites; these runs
//! verify the client gate over a scripted daemon socket.
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

/// The detection arm's warning text (the fake auth's
/// `anthropic_subscription_warning`): distinguishable from the
/// login-completed arm's product warning below, so each arm's row is
/// provably its own.
const DETECTION_WARNING: &str = "TEST anthropic subscription ban-risk warning";

/// The login-completed arm's row rides the product constant's text (the
/// `ANTHROPIC_SUBSCRIPTION_AUTH_WARNING` body); the arm renders it with the
/// same `\u{26a0}` prefix.
const LOGIN_WARNING_NEEDLE: &str = "Anthropic subscription auth is active";

/// The session gate the scripted daemon serves: `None` answers `get_state`
/// WITHOUT the field (an older daemon — the client must fail open), the
/// booleans answer the hydrated gate.
struct MockSession {
    active: &'static str,
    wire: &'static str,
    name: &'static str,
    warning_shown: Option<bool>,
}

impl MockSession {
    fn new(active: &'static str, warning_shown: Option<bool>) -> Self {
        Self {
            active,
            wire: "sess-1",
            name: "warning lifecycle session",
            warning_shown,
        }
    }
}

struct MockSupervisor {
    listener: UnixListener,
    session: MockSession,
    /// The commands the client sent, in arrival order (the mark assertion).
    commands: Arc<Mutex<Vec<String>>>,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path, session: MockSession) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            session,
            commands: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Serve one connection: attach the session, answer the loop's requests.
    /// `get_state` serves the model's provider plus the lifecycle gate;
    /// `mark_anthropic_warning_shown` answers success and lands in the
    /// command log.
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
            self.commands.lock().unwrap().push(command_type.clone());
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
                "get_state" => {
                    // The summary the worker serves: the model's provider
                    // (the detection arm's provider gate) plus the
                    // lifecycle gate the fix reads. `None` models a daemon
                    // that never emits the field (the fail-open degrade).
                    let mut data = json!({
                        "activeSessionId": self.session.active,
                        "sessionId": self.session.wire,
                        "model": { "provider": "anthropic", "modelId": "claude-test" },
                        "isStreaming": false,
                        "isCompacting": false,
                    });
                    if let Some(shown) = self.session.warning_shown {
                        data["anthropicWarningShown"] = json!(shown);
                    }
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_state",
                            "success": true,
                            "data": data,
                        }),
                    );
                }
                "mark_anthropic_warning_shown" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "mark_anthropic_warning_shown",
                            "success": true,
                            "data": {},
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
/// default except `warnings.anthropicExtraUsage`, which the store models
/// (the toggle test flips it).
#[derive(Default)]
struct StubSettings {
    anthropic_extra_usage: bool,
}

impl pa_tui::client_settings::ClientSettings for StubSettings {
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
    fn chat_detail(&self) -> String {
        "overview".to_string()
    }
    fn set_chat_detail(&self, _detail: &str) -> Result<()> {
        Ok(())
    }
    fn warnings_anthropic_extra_usage(&self) -> bool {
        self.anthropic_extra_usage
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

/// The fake auth surface: one Anthropic subscription row (the panel
/// login), and a subscription warning the detection arm resolves.
struct SubscriptionAuth;

impl pa_tui::provider_auth::ProviderAuthCommands for SubscriptionAuth {
    fn login_options(&self) -> pa_tui::provider_auth::ProviderRowsFuture {
        Box::pin(async move {
            vec![pa_tui::provider_auth::ProviderRow {
                id: "anthropic".to_string(),
                name: "Anthropic".to_string(),
                auth_type: pa_tui::provider_auth::AuthType::Oauth,
                status: None,
                flow: pa_tui::provider_auth::AuthFlow::TerminalFlow,
                configured: false,
                available: true,
            }]
        })
    }

    fn logout_options(&self) -> pa_tui::provider_auth::ProviderRowsFuture {
        Box::pin(async move { Vec::new() })
    }

    fn login(
        &self,
        _provider: &pa_tui::provider_auth::ProviderRow,
        _api_key: Option<&str>,
    ) -> pa_tui::provider_auth::ProviderAuthFuture {
        Box::pin(async move { pa_tui::provider_auth::ProviderAuthOutcome::Cancelled })
    }

    fn login_on_panel(
        &self,
        _provider: &pa_tui::provider_auth::ProviderRow,
        _panel: pa_tui::auth_panel::AuthPanelHandle,
    ) -> pa_tui::provider_auth::ProviderAuthFuture {
        Box::pin(async move {
            pa_tui::provider_auth::ProviderAuthOutcome::Status("Connected to Anthropic".to_string())
        })
    }

    fn logout(
        &self,
        _provider: &pa_tui::provider_auth::ProviderRow,
    ) -> pa_tui::provider_auth::ProviderAuthFuture {
        Box::pin(async move { pa_tui::provider_auth::ProviderAuthOutcome::Cancelled })
    }

    fn anthropic_subscription_warning(&self) -> pa_tui::provider_auth::ProviderWarningFuture {
        Box::pin(async move { Some(DETECTION_WARNING) })
    }
}

fn options(
    socket: PathBuf,
    settings: Arc<StubSettings>,
    auth: Option<pa_tui::provider_auth::ProviderAuthCommandsHandle>,
) -> InteractiveOptions {
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
        models: None,
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
        provider_auth: auth,
        update_commands: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        restore_dock_focus: false,
        client_settings: Some(settings),
    }
}

/// One headless run against the scripted daemon: the rendered frames plus
/// every command the client sent.
fn run_plan(
    settings: Arc<StubSettings>,
    session: MockSession,
    steps: Vec<HeadlessStep>,
) -> (Vec<String>, Vec<String>) {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket, session);
    let commands = supervisor.commands.clone();
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
    let auth = Some(pa_tui::provider_auth::ProviderAuthCommandsHandle(Arc::new(
        SubscriptionAuth,
    )));
    let outcome = runtime
        .block_on(run_interactive(
            options(socket, settings, auth),
            UiMode::Headless(plan),
        ))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    let sent = commands.lock().unwrap().clone();
    (outcome.frames, sent)
}

fn wait_render(needle: &str) -> HeadlessStep {
    HeadlessStep::WaitRender {
        needle: needle.to_string(),
        timeout_ms: 10_000,
    }
}

fn enter() -> HeadlessStep {
    HeadlessStep::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
}

fn warning_settings() -> Arc<StubSettings> {
    Arc::new(StubSettings {
        anthropic_extra_usage: true,
    })
}

/// The genuinely-new session (the daemon reports the gate closed): the
/// startup detection arm draws the warning once and marks the gate with
/// the daemon — exactly one mark leaves the client.
#[test]
fn a_new_session_warns_once_and_marks_the_gate() {
    let (frames, commands) = run_plan(
        warning_settings(),
        MockSession::new("s1", Some(false)),
        // The exit gate holds the run until the fire-and-forget mark's
        // write resolves, so the mark count reads completed state — no
        // timing window guards the assertion.
        vec![wait_render(DETECTION_WARNING)],
    );
    let all = frames.join("\n");
    assert!(
        all.contains(DETECTION_WARNING),
        "the new session drew the ban-risk warning:\n{all}"
    );
    let marks = commands
        .iter()
        .filter(|command| *command == "mark_anthropic_warning_shown")
        .count();
    assert_eq!(
        marks, 1,
        "the warned session marked the gate exactly once: {commands:?}"
    );
}

/// The reattach/resume read (a fresh TUI instance over a session whose
/// gate the daemon reports OPEN): no warning renders, and the client never
/// re-marks. This is the every-open re-warn the directive fixes.
#[test]
fn a_marked_session_reattach_never_rewarns() {
    let (frames, commands) = run_plan(
        warning_settings(),
        MockSession::new("s1", Some(true)),
        // The detection arm is awaited at open, so the first dock frame
        // proves its decision baked in — the negative reads completed
        // state, not a timing window.
        vec![wait_render("subagents")],
    );
    let all = frames.join("\n");
    assert!(
        !all.contains(DETECTION_WARNING),
        "the reattached session did not re-render the warning:\n{all}"
    );
    assert!(
        !commands
            .iter()
            .any(|command| command == "mark_anthropic_warning_shown"),
        "the skipped warning never marked: {commands:?}"
    );
}

/// The settings toggle stays FIRST: with `warnings.anthropicExtraUsage`
/// off, a genuinely new session on a subscription credential never warns
/// and never marks (the daemon-side gate is never asked).
#[test]
fn the_settings_toggle_off_never_warns() {
    let settings = Arc::new(StubSettings {
        anthropic_extra_usage: false,
    });
    let (frames, commands) = run_plan(
        settings,
        MockSession::new("s1", Some(false)),
        vec![wait_render("subagents")],
    );
    let all = frames.join("\n");
    assert!(
        !all.contains(DETECTION_WARNING),
        "the disabled toggle kept the warning down:\n{all}"
    );
    assert!(
        !commands
            .iter()
            .any(|command| command == "mark_anthropic_warning_shown"),
        "a suppressed warning never marked: {commands:?}"
    );
}

/// The fresh auth landing re-warns: on a session whose gate is OPEN (its
/// open drew no warning), a COMPLETED Anthropic subscription login still
/// draws the product warning — the login-completed arm is not gated by
/// the lifecycle marker, each landing is its own event — and it marks the
/// gate too.
#[test]
fn a_fresh_login_rewarns_on_a_marked_session() {
    let (frames, commands) = run_plan(
        warning_settings(),
        MockSession::new("s1", Some(true)),
        vec![
            // The detection arm is awaited at open: the first dock frame
            // proves it read the open gate and drew nothing.
            wait_render("subagents"),
            // The login: the selector mounts, Enter runs the panel flow,
            // the fake settles it, the login-completed arm draws the
            // product warning.
            HeadlessStep::Submit("/login".to_string()),
            wait_render("Anthropic"),
            enter(),
            wait_render(LOGIN_WARNING_NEEDLE),
        ],
    );
    let all = frames.join("\n");
    assert!(
        !all.contains(DETECTION_WARNING),
        "the open's detection arm stayed gated by the session's marker:\n{all}"
    );
    assert!(
        all.contains(LOGIN_WARNING_NEEDLE),
        "the completed login re-warned with the product warning:\n{all}"
    );
    assert!(
        all.contains("Connected to Anthropic"),
        "the login outcome's status row rendered:\n{all}"
    );
    assert!(
        commands
            .iter()
            .any(|command| command == "mark_anthropic_warning_shown"),
        "the login arm marked the gate too: {commands:?}"
    );
}

/// The degrade: a daemon whose `get_state` carries no
/// `anthropicWarningShown` field (the pre-fix build) keeps the warning
/// working — the gate fails OPEN, so an unreadable lifecycle state shows
/// the warning rather than suppressing it.
#[test]
fn a_daemon_without_the_gate_field_fails_open_and_warns() {
    let (frames, commands) = run_plan(
        warning_settings(),
        MockSession::new("s1", None),
        vec![wait_render(DETECTION_WARNING)],
    );
    let all = frames.join("\n");
    assert!(
        all.contains(DETECTION_WARNING),
        "the absent field failed open and the warning showed:\n{all}"
    );
    assert!(
        commands
            .iter()
            .any(|command| command == "mark_anthropic_warning_shown"),
        "the client still marks (the new daemon persists it): {commands:?}"
    );
}
