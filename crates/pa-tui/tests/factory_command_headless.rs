//! Headless e2e for the `/factory` command (the factory's opt-in gate):
//! the status arm reports the disabled default, `on`/`off` persist the
//! gate through the settings seam (a stub seam: the write lands in
//! memory; the persisted settings-file shape is covered by the pa-cli
//! seam round-trip test), and a bad argument gets the usage error. The
//! harness daemon advertises no `factory_activity` lane, so the dock
//! mounts no factory group anywhere while it stays unadvertised (the
//! opt-in contract's off surface). The lane-advertised battery below
//! drives the off guard end to end, and the page battery opens the
//! dock's factory group into the live page and pins the picker keys'
//! repaint contract (the input loop paints every dispatched input — the
//! moved selection lands on the arrow's own repaint, never waiting for
//! the refresh poll).
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
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

struct MockSupervisor {
    listener: UnixListener,
    /// The hello's advertised capabilities (the default hello advertises
    /// none, so the factory lane stays unadvertised).
    server_capabilities: Vec<String>,
    /// The `factory_activity` graph reply the mock answers while the
    /// lane is advertised: `None` answers every action with empty data.
    factory_graph: Option<Value>,
    /// The daemon refusal the mock answers the `graph` action with
    /// (`None` keeps the success path): the worker arm's exact wire
    /// shape for a session whose kernel is not built.
    factory_graph_error: Option<String>,
}

impl MockSupervisor {
    fn bind_with(
        socket: &std::path::Path,
        server_capabilities: Vec<String>,
        factory_graph: Option<Value>,
        factory_graph_error: Option<String>,
    ) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            server_capabilities,
            factory_graph,
            factory_graph_error,
        }
    }

    /// Serve one connection: attach an empty session, then answer the
    /// loop's requests.
    fn serve(self) {
        let MockSupervisor {
            listener,
            server_capabilities,
            factory_graph,
            factory_graph_error,
        } = self;
        let (stream, _) = listener.accept().expect("accept");
        let write_stream = stream.try_clone().expect("clone mock socket");
        let mut writer = write_stream;
        let mut reader = BufReader::new(stream);

        let hello = json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": server_capabilities,
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
                "factory_activity" => {
                    // The lane's mock: a graph action answers the
                    // configured refusal (the worker arm's exact
                    // kernel-not-running wire shape) or the configured
                    // runs reply; every other action answers empty data
                    // (the guard reads the graph list only).
                    if command.get("action").and_then(Value::as_str) == Some("graph") {
                        if let Some(error) = factory_graph_error.as_ref() {
                            write_json(
                                &mut writer,
                                &json!({
                                    "type": "response",
                                    "id": id,
                                    "command": "factory_activity",
                                    "success": false,
                                    "error": error,
                                }),
                            );
                            continue;
                        }
                    }
                    let data = match (
                        factory_graph.as_ref(),
                        command.get("action").and_then(Value::as_str),
                    ) {
                        (Some(runs), Some("graph")) => runs.clone(),
                        _ => json!({}),
                    };
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "factory_activity",
                            "success": true,
                            "data": data,
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
                    "sessionName": "factory session",
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

/// A minimal settings seam for the harness: the factory gate reads and
/// writes through a recording cell (the opt-in default is disabled), and
/// every other getter returns its TS default with no-op writes.
#[derive(Default)]
struct RecordingSettings {
    factory_enabled: std::sync::Mutex<bool>,
}

impl pa_tui::client_settings::ClientSettings for RecordingSettings {
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
        *self.factory_enabled.lock().expect("factory gate lock")
    }
    fn set_factory_enabled(&self, enabled: bool) -> Result<()> {
        *self.factory_enabled.lock().expect("factory gate lock") = enabled;
        Ok(())
    }
    fn telemetry_status(&self) -> String {
        "telemetry enabled".to_string()
    }
    fn set_telemetry_enabled(&self, _enabled: bool) -> Result<String> {
        Ok("telemetry enabled".to_string())
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
        client_settings: Some(std::sync::Arc::new(RecordingSettings::default())),
    }
}

fn run_plan(steps: Vec<HeadlessStep>) -> Vec<String> {
    run_plan_config(Vec::new(), None, steps)
}

/// The harness entry with a configured mock daemon: the hello's
/// advertised capabilities and the `factory_activity` graph reply (the
/// `/factory off` lifecycle guard's lane).
fn run_plan_config(
    server_capabilities: Vec<String>,
    factory_graph: Option<Value>,
    steps: Vec<HeadlessStep>,
) -> Vec<String> {
    run_plan_config_with_graph_error(server_capabilities, factory_graph, None, steps)
}

/// The full mock configuration: the graph action can also answer a daemon
/// refusal (the kernel-not-running wire shape) instead of a runs reply.
fn run_plan_config_with_graph_error(
    server_capabilities: Vec<String>,
    factory_graph: Option<Value>,
    factory_graph_error: Option<String>,
    steps: Vec<HeadlessStep>,
) -> Vec<String> {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind_with(
        &socket,
        server_capabilities,
        factory_graph,
        factory_graph_error,
    );
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

/// The frames wrap notes to the frame width, so an assertion reads the
/// rendered text with the wraps collapsed.
fn flat_text(frames: &[String]) -> String {
    frames
        .join("\n")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// `/factory status` (and a bare `/factory`) report the disabled default,
/// and the dock never mounts a factory group while the daemon's hello
/// advertises no `factory_activity` lane: no `⚙` segment renders anywhere
/// (the opt-in contract's off surface).
#[test]
fn factory_status_reports_the_disabled_default_without_a_factory_group() {
    let steps = vec![
        HeadlessStep::Submit("/factory status".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/factory".to_string()),
        HeadlessStep::WaitMs(200),
    ];
    let frames = run_plan(steps);
    assert!(!frames.is_empty(), "frames were captured");
    let all = flat_text(&frames);
    assert!(
        all.contains(
            "The factory is disabled (off by default). Run /factory on to enable it (takes effect on the next client start)."
        ),
        "the disabled status note rendered:\n{all}"
    );
    assert!(
        !frames.join("\n").contains('⚙'),
        "no factory group renders while the lane is unadvertised:\n{all}"
    );
}

/// `/factory on` persists the gate and the status arm reads the new state
/// back; `/factory off` disables it again, and a bad argument keeps the
/// usage error.
#[test]
fn factory_on_and_off_round_trip_the_gate_through_the_seam() {
    let steps = vec![
        HeadlessStep::Submit("/factory on".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/factory status".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/factory off".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/factory status".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/factory maybe".to_string()),
        HeadlessStep::WaitMs(200),
    ];
    let frames = run_plan(steps);
    let all = flat_text(&frames);
    assert!(
        all.contains(
            "The factory is enabled. Restart the client to surface the factory group (the factory page and the agent-side factory API follow the same gate)."
        ),
        "the enabled note rendered:\n{all}"
    );
    assert!(
        all.contains("The factory is enabled. Run /factory off to disable it."),
        "the enabled status read back:\n{all}"
    );
    assert!(
        all.contains(
            "The factory is disabled. The factory group and page disappear on the next client start."
        ),
        "the off note rendered:\n{all}"
    );
    assert!(
        all.contains(
            "The factory is disabled (off by default). Run /factory on to enable it (takes effect on the next client start)."
        ),
        "the disabled status read back:\n{all}"
    );
    assert!(
        all.contains("Usage: /factory [on|off|status]"),
        "the usage error rendered:\n{all}"
    );
}

/// One factory run row in the wire shape the kernel's graph lane sends
/// (camelCase): the state a `running` row counts as live, a `done` row
/// with `running` children in flight counts (the resident lifecycle —
/// the dock's own liveness rule), and a terminal `done` row with none
/// does not.
fn factory_run_row(id: &str, state: &str, running_children: u64) -> Value {
    json!({
        "runId": id,
        "specId": "sw",
        "state": state,
        "elapsedMs": 100,
        "machine": { "states": [], "transitions": [] },
        "nodes": [],
        "usage": { "running": running_children },
    })
}

/// `/factory off` refuses while the session's kernel reports live runs
/// (the lifecycle guard, end to end through the daemon lane): the
/// refusal names the live count, and the gate stays enabled — the runs
/// keep their stop and visibility path (the page, `rlm.factory.stop`)
/// until the user stops them. The live count reads the dock's own
/// liveness rule: a `running` run and a `done` run with children still
/// in flight both count; a fully terminal run never does.
#[test]
fn factory_off_refuses_while_runs_are_live() {
    let graph = json!({
        "runs": [
            factory_run_row("terminal", "done", 0),
            factory_run_row("resident", "done", 2),
            factory_run_row("live", "running", 1),
        ]
    });
    let steps = vec![
        HeadlessStep::Submit("/factory on".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/factory off".to_string()),
        HeadlessStep::WaitMs(400),
        HeadlessStep::Submit("/factory status".to_string()),
        HeadlessStep::WaitMs(200),
    ];
    let frames = run_plan_config(vec!["factory_activity".to_string()], Some(graph), steps);
    let all = flat_text(&frames);
    assert!(
        all.contains(
            "Cannot disable the factory while 2 runs are still live — stop them first (the factory page's stop action or rlm.factory.stop), then /factory off."
        ),
        "the refusal names the live count:\n{all}"
    );
    assert!(
        all.contains("The factory is enabled. Run /factory off to disable it."),
        "the gate stayed enabled after the refused off:\n{all}"
    );
    assert!(
        !all.contains("The factory is disabled. The factory group and page disappear on the next client start."),
        "the off note never rendered:\n{all}"
    );
}

/// The complement: once no run is live (a fully terminal history), the
/// off write proceeds — the guard refuses only while the kernel reports
/// runs that still need their stop path.
#[test]
fn factory_off_proceeds_once_no_runs_are_live() {
    let graph = json!({
        "runs": [factory_run_row("terminal", "done", 0)]
    });
    let steps = vec![
        HeadlessStep::Submit("/factory on".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/factory off".to_string()),
        HeadlessStep::WaitMs(400),
        HeadlessStep::Submit("/factory status".to_string()),
        HeadlessStep::WaitMs(200),
    ];
    let frames = run_plan_config(vec!["factory_activity".to_string()], Some(graph), steps);
    let all = flat_text(&frames);
    assert!(
        all.contains("The factory is disabled. The factory group and page disappear on the next client start."),
        "the off proceeded with only terminal runs:\n{all}"
    );
    assert!(
        all.contains("The factory is disabled (off by default). Run /factory on to enable it (takes effect on the next client start)."),
        "the disabled status read back:\n{all}"
    );
}

/// The same refusal on a client whose hello predates the gate: a client
/// started while the factory was off keeps its unadvertised hello (the
/// running connection never re-reads the advertisement), but `/factory
/// on` opens the kernel gate immediately — runs started after the toggle
/// are live in that same client, so the off guard must read the lane even
/// without the advertisement and refuse while they run.
#[test]
fn factory_off_refuses_on_a_client_whose_hello_predates_the_gate() {
    let graph = json!({
        "runs": [factory_run_row("live", "running", 1)]
    });
    let steps = vec![
        HeadlessStep::Submit("/factory on".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/factory off".to_string()),
        HeadlessStep::WaitMs(400),
    ];
    // The hello advertises nothing; the daemon still answers the lane.
    let frames = run_plan_config(Vec::new(), Some(graph), steps);
    let all = flat_text(&frames);
    assert!(
        all.contains(
            "Cannot disable the factory while 1 run is still live — stop it first (the factory page's stop action or rlm.factory.stop), then /factory off."
        ),
        "the unadvertised-lane guard still refused:\n{all}"
    );
}

/// The None path never blocks the client whose hello predates the lane
/// (the fail-open half of the unreadable-count rule): a daemon that
/// cannot report runs — an older daemon answers the unknown command with
/// a failure, a session without a kernel refuses — carries no live runs,
/// so the write proceeds; only the lane-advertised client fails closed
/// (the pin below).
#[test]
fn factory_off_proceeds_when_the_lane_cannot_report() {
    let steps = vec![
        HeadlessStep::Submit("/factory on".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/factory off".to_string()),
        HeadlessStep::WaitMs(400),
    ];
    // The mock answers every factory action with empty data: no runs list.
    let frames = run_plan_config(Vec::new(), None, steps);
    let all = flat_text(&frames);
    assert!(
        all.contains("The factory is disabled. The factory group and page disappear on the next client start."),
        "the unreadable count never blocked off:\n{all}"
    );
    assert!(
        !all.contains("Cannot disable the factory"),
        "no refusal without a readable count:\n{all}"
    );
}

/// The advertised lane fails closed on an unreadable count: a timed-out
/// or malformed graph reply cannot prove zero live runs, so the off write
/// refuses (an unknown liveness never opens the gate) and names the
/// unreadable count; the gate stays enabled for the retry.
#[test]
fn factory_off_refuses_when_the_advertised_lane_cannot_count() {
    let steps = vec![
        HeadlessStep::Submit("/factory on".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/factory off".to_string()),
        HeadlessStep::WaitMs(400),
        HeadlessStep::Submit("/factory status".to_string()),
        HeadlessStep::WaitMs(200),
    ];
    // The lane is advertised; the mock answers every factory action with
    // empty data (a malformed reply the guard reads as an unreadable count).
    let frames = run_plan_config(vec!["factory_activity".to_string()], None, steps);
    let all = flat_text(&frames);
    assert!(
        all.contains(
            "Cannot disable the factory: the live-run count could not be read from the factory lane — try /factory off again once it answers."
        ),
        "the unreadable count refused the off:\n{all}"
    );
    assert!(
        all.contains("The factory is enabled. Run /factory off to disable it."),
        "the gate stayed enabled after the refused off:\n{all}"
    );
}

/// The kernel-not-running class never fails closed: the lane never
/// builds a kernel, and the kernel owns its run registry in memory, so a
/// session without a kernel cannot host live runs — the count reads as a
/// definitive zero even on the lane-advertised client (the refusal's
/// "try again once it answers" would never resolve otherwise: the lane
/// answers the same refusal until some other action boots the kernel,
/// so the advertised client could never disable an idle factory).
#[test]
fn factory_off_proceeds_when_the_kernel_is_not_running() {
    let steps = vec![
        HeadlessStep::Submit("/factory on".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/factory off".to_string()),
        HeadlessStep::WaitMs(400),
        HeadlessStep::Submit("/factory status".to_string()),
        HeadlessStep::WaitMs(200),
    ];
    // The lane is advertised; the mock answers the graph read with the
    // worker arm's exact kernel-not-running refusal.
    let frames = run_plan_config_with_graph_error(
        vec!["factory_activity".to_string()],
        None,
        Some("Kernel is not running".to_string()),
        steps,
    );
    let all = flat_text(&frames);
    assert!(
        all.contains("The factory is disabled. The factory group and page disappear on the next client start."),
        "the no-kernel count never blocked off:\n{all}"
    );
    assert!(
        all.contains("The factory is disabled (off by default). Run /factory on to enable it (takes effect on the next client start)."),
        "the disabled status read back:\n{all}"
    );
    assert!(
        !all.contains("Cannot disable the factory"),
        "no refusal without a kernel to host live runs:\n{all}"
    );
}

/// One live named run row for the page battery (the wire shape the
/// kernel's graph lane sends): the name the panel header paints.
fn factory_page_run(id: &str, name: &str) -> Value {
    json!({
        "runId": id,
        "specId": "sw",
        "name": name,
        "state": "running",
        "elapsedMs": 100,
        "machine": { "states": [], "transitions": [] },
        "nodes": [],
        "usage": { "running": 0 },
    })
}

/// One alt+a key event (the dock's focus hand-off).
fn alt_a() -> KeyEvent {
    KeyEvent::new(KeyCode::Char('a'), KeyModifiers::ALT)
}

/// One right-arrow key event (the dock's next-section step).
fn dock_right() -> KeyEvent {
    KeyEvent::new(KeyCode::Right, KeyModifiers::NONE)
}

/// One down-arrow key event (the page's `tui.select.down`).
fn down() -> KeyEvent {
    KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)
}

/// One plain Enter key event (the dock's focused-section open).
fn enter() -> KeyEvent {
    KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
}

/// One Esc key event (`tui.select.cancel`: the open page closes).
fn escape() -> KeyEvent {
    KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)
}

/// The page's picker keys repaint on the key itself, never waiting for
/// the 2-second refresh poll (the input loop's render contract: every
/// dispatched input paints — the same TS `handleInput` parity that
/// carries the dock's arrows and every other picker key). The pin closes
/// the page on the input right after the arrow, so no poll window can
/// sit between the move and the paint: the moved selection marker must
/// land in a captured frame on the arrow's own repaint — and the poll
/// alone could never produce it, because a fold preserves the selected
/// run id, so a picker key that skipped its repaint would leave the
/// marker on the old run forever (the fold repaints the same unmoved
/// selection).
#[test]
fn factory_page_picker_keys_paint_the_moved_selection_on_the_key() {
    // Oldest first on the wire; the page reads newest-first, so
    // second-run is the opening selection and first-run is one Down away.
    let graph = json!({
        "runs": [
            factory_page_run("run-old", "first-run"),
            factory_page_run("run-new", "second-run"),
        ]
    });
    let steps = vec![
        // Focus the dock and step to the factory group (subagents ->
        // heartbeats -> shells -> factory); Enter opens the page.
        HeadlessStep::Key(alt_a()),
        HeadlessStep::Key(dock_right()),
        HeadlessStep::Key(dock_right()),
        HeadlessStep::Key(dock_right()),
        HeadlessStep::Key(enter()),
        // The page opens on the feed's live head: the newest run.
        HeadlessStep::WaitRender {
            needle: "factory: second-run".to_string(),
            timeout_ms: 5_000,
        },
        // Down moves the selection to the older run, and Esc closes the
        // page on the very next input — no poll cycle can land between
        // the two, so the moved marker below can only be the arrow's own
        // repaint.
        HeadlessStep::Key(down()),
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(200),
    ];
    let frames = run_plan_config(vec!["factory_activity".to_string()], Some(graph), steps);
    let all = flat_text(&frames);
    assert!(
        all.contains("factory: second-run"),
        "the page mounted on the newest run:\n{all}"
    );
    assert!(
        all.contains("\u{25b8} factory: first-run"),
        "the arrow's own repaint painted the moved selection before the page closed:\n{all}"
    );
}
