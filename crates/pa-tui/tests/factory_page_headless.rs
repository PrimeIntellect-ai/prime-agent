//! Headless e2e for the factory page: a daemon that advertises the
//! `factory_activity` lane opens the page on a bare `/factory`; the
//! open fetch lists every machine (name, source, description) over the
//! lane's `library` action, with every session's active runs (the
//! `overview` action) and the attached session's finished runs
//! (retained from the `graph` cache the dock polls) nested under their
//! machine. Enter on a machine drills into
//! its ANSI diagram and its mermaid rendered as a diagram; Enter on a run
//! opens the run
//! page, whose Esc returns to the factory page; Esc backs out of the
//! drill-in before it closes the page. A daemon that advertises no lane
//! mounts no factory group and opens no page.
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
use std::time::Duration;

use anyhow::Result;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

struct MockSupervisor {
    listener: UnixListener,
    /// The hello's advertised capabilities: `factory_activity` mounts the
    /// dock's factory and machine-library groups (the opt-in gate).
    server_capabilities: Vec<String>,
    /// The `library` list reply (no target): every machine row.
    library_machines: Value,
    /// The `library` graph reply for `pr-manager` (the drill-in target).
    library_graph: Value,
    /// The scoped `graph` reply: the first call answers `graph_first`,
    /// every later one `graph_later` (the dock poll's refreshes).
    graph_first: Value,
    graph_later: Value,
    /// The `overview` reply (the page's all-session rows): the first
    /// call answers `overview_first`, every later one `overview_later`
    /// (the page-only cadence's refreshes).
    overview_first: Value,
    overview_later: Value,
    /// When set, hold the FIRST `overview` reply this many milliseconds
    /// before answering (the page's mount-seed pin: the reply's real
    /// bound is the supervisor's catalog scan, which a large session
    /// catalog can hold for seconds — the reply never waits on a
    /// kernel read).
    overview_delay_first_ms: u64,
    /// When set, hold every LATER `overview` reply this many milliseconds
    /// before answering (the warm-reopen pin: the reopen's saved-era
    /// frames stay on screen while the page-only cadence's refresh is
    /// in flight).
    overview_delay_later_ms: u64,
    /// When set, every `overview` request answers this refusal instead —
    /// the older-daemon skew (`unknown factory activity action`).
    overview_error: Option<String>,
    /// When set, the attach's `sessionName` answers this instead of the
    /// default display name (the scrub pin's control-carrying name).
    session_name: Option<String>,
    /// Every `factory_activity` and child-control request the mock saw,
    /// for the read-only control assertions.
    requests: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

/// The mock daemon's whole configurable surface for one headless run:
/// the hello's advertised capabilities, the scoped `graph`'s first and
/// later replies, the `overview`'s first and later replies, the first
/// and later overview replies' holds, and the steps to run against it.
/// The `library` replies are the shared fixed helpers.
#[derive(Default)]
struct MockPlan {
    server_capabilities: Vec<String>,
    /// The scoped `graph` reply the first poll answers.
    graph_first: Value,
    /// The scoped `graph` reply every later poll answers.
    graph_later: Value,
    /// The `overview` reply the first fetch answers.
    overview_first: Value,
    /// The `overview` reply every later fetch answers.
    overview_later: Value,
    /// When set, hold the FIRST `overview` reply this many milliseconds
    /// before answering (the page's mount-seed pin: the supervisor's
    /// catalog scan can hold the reply for seconds — the reply never
    /// waits on a kernel read).
    overview_delay_first_ms: u64,
    /// When set, hold every LATER `overview` reply this many
    /// milliseconds before answering (the warm-reopen pin's saved-era
    /// window).
    overview_delay_later_ms: u64,
    /// When set, every `overview` request answers this refusal instead —
    /// the older-daemon skew (`unknown factory activity action`).
    overview_error: Option<String>,
    /// When set, the attach's `sessionName` answers this instead of the
    /// default display name (the scrub pin's control-carrying name).
    session_name: Option<String>,
    steps: Vec<HeadlessStep>,
}

impl MockSupervisor {
    fn bind_with(socket: &std::path::Path, plan: MockPlan) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            server_capabilities: plan.server_capabilities,
            library_machines: library_machines_reply(),
            library_graph: library_graph_reply(),
            graph_first: plan.graph_first,
            graph_later: plan.graph_later,
            overview_first: plan.overview_first,
            overview_later: plan.overview_later,
            overview_delay_first_ms: plan.overview_delay_first_ms,
            overview_delay_later_ms: plan.overview_delay_later_ms,
            overview_error: plan.overview_error,
            session_name: plan.session_name,
            requests: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    /// Serve one connection: attach an empty session, then answer the
    /// loop's requests.
    fn serve(self) {
        let MockSupervisor {
            listener,
            server_capabilities,
            library_machines,
            library_graph,
            graph_first,
            graph_later,
            overview_first,
            overview_later,
            overview_delay_first_ms,
            overview_delay_later_ms,
            overview_error,
            session_name,
            requests,
        } = self;
        let (stream, _) = listener.accept().expect("accept");
        let write_stream = stream.try_clone().expect("clone mock socket");
        let mut writer = write_stream;
        let mut reader = BufReader::new(stream);
        let mut graph_served = false;
        let mut overview_served = false;
        let mut overview_requests_served = 0;

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
                    write_json(&mut writer, &attach_data(id, session_name.as_deref()));
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
                    // The lane's mock: the `library` action answers the
                    // machine list (no target) or the drilled machine's
                    // graph payload (`pr-manager`); the `overview` action
                    // answers the page's all-session rows (the first call
                    // and every refresh); every other action answers empty
                    // data.
                    let action = command.get("action").and_then(Value::as_str);
                    if let Some(action) = action {
                        requests.lock().expect("request log").push(format!(
                            "factory_activity:{action}:runId={:?}:specId={:?}",
                            command.get("runId").and_then(Value::as_str),
                            command.get("specId").and_then(Value::as_str),
                        ));
                    }
                    let data = match action {
                        Some("graph") => {
                            // The refreshed graph reaches the page only
                            // once the cadence asked the overview twice:
                            // the refusal test's refreshed-counter needle
                            // then paints only through a LATER fallback
                            // fold (a re-asked refusal), never a first
                            // fold that raced the dock's refresh.
                            let later = graph_served && overview_requests_served >= 2;
                            if later {
                                graph_later.clone()
                            } else {
                                graph_served = true;
                                graph_first.clone()
                            }
                        }
                        Some("overview") => {
                            overview_requests_served += 1;
                            if let Some(message) = &overview_error {
                                write_json(
                                    &mut writer,
                                    &json!({
                                        "type": "response",
                                        "id": id,
                                        "command": "factory_activity",
                                        "success": false,
                                        "error": message,
                                    }),
                                );
                                continue;
                            }
                            if overview_served {
                                if overview_delay_later_ms > 0 {
                                    std::thread::sleep(Duration::from_millis(
                                        overview_delay_later_ms,
                                    ));
                                }
                                overview_later.clone()
                            } else {
                                overview_served = true;
                                if overview_delay_first_ms > 0 {
                                    // The held first reply: the
                                    // supervisor's catalog scan can hold
                                    // the overview past the page's open
                                    // (the reply serves the cache and
                                    // never waits on a kernel read) —
                                    // the mount seed's window.
                                    std::thread::sleep(Duration::from_millis(
                                        overview_delay_first_ms,
                                    ));
                                }
                                overview_first.clone()
                            }
                        }
                        Some("library") => match command.get("specId").and_then(Value::as_str) {
                            Some("pr-manager") => library_graph.clone(),
                            Some(_) => json!({}),
                            None => library_machines.clone(),
                        },
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
                "cancel_rlm_child" | "delete_rlm_subagent" => {
                    requests
                        .lock()
                        .expect("request log")
                        .push(command_type.clone());
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

/// The slim attach result: one empty session, its display name the
/// plan's override or the shared default.
fn attach_data(id: &str, session_name: Option<&str>) -> Value {
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
                    "sessionName": session_name.unwrap_or("library session"),
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

/// A minimal settings seam for the harness: every getter returns its
/// default with no-op writes (the factory gate is the daemon's lane
/// advertisement, which the mock's hello carries).
#[derive(Default)]
struct RecordingSettings;

impl pa_tui::client_settings::ClientSettings for RecordingSettings {
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
        client_settings: Some(std::sync::Arc::new(RecordingSettings)),
    }
}

/// The harness entry with a configured mock daemon: the hello's
/// advertised capabilities and the `factory_activity` library replies.
fn run_plan(server_capabilities: Vec<String>, steps: Vec<HeadlessStep>) -> Vec<String> {
    run_plan_overview(
        server_capabilities,
        owned_overview_reply(),
        owned_overview_reply(),
        steps,
    )
    .0
}

/// The harness entry with the mock daemon's overview replies configured:
/// the first fetch answers `overview_first`, every later fetch answers
/// `overview_later`. Returns the captured frames and the recorded
/// `factory_activity`/child-control requests.
fn run_plan_overview(
    server_capabilities: Vec<String>,
    overview_first: Value,
    overview_later: Value,
    steps: Vec<HeadlessStep>,
) -> (Vec<String>, Vec<String>) {
    run_plan_overview_mode(
        server_capabilities,
        overview_first,
        overview_later,
        None,
        steps,
    )
}

fn run_plan_overview_mode(
    server_capabilities: Vec<String>,
    overview_first: Value,
    overview_later: Value,
    overview_error: Option<String>,
    steps: Vec<HeadlessStep>,
) -> (Vec<String>, Vec<String>) {
    run_plan_overview_full(MockPlan {
        server_capabilities,
        overview_first,
        overview_later,
        overview_error,
        graph_first: scoped_graph_reply(),
        graph_later: scoped_graph_reply(),
        steps,
        ..MockPlan::default()
    })
}

/// [`run_plan_overview_mode`] with the full [`MockPlan`] surface: the
/// scoped graph's first and later replies and the first and later
/// overview replies' holds each configurable.
fn run_plan_overview_full(plan: MockPlan) -> (Vec<String>, Vec<String>) {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    // The steps run against the mock daemon; the daemon itself serves
    // only the plan's reply surface, so the steps leave the plan here.
    let mut plan = plan;
    let steps = std::mem::take(&mut plan.steps);
    let supervisor = MockSupervisor::bind_with(&socket, plan);
    let requests = std::sync::Arc::clone(&supervisor.requests);
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
    let requests = requests.lock().expect("request log").clone();
    (outcome.frames, requests)
}

/// The scoped `graph` reply the dock polls: the attached session's own
/// live `nightly-pr` run — the row the mount seed and the version-skew
/// fallback paint.
fn scoped_graph_reply() -> Value {
    json!({"runs": [{
        "runId": "run-1", "specId": "pr-manager", "name": "nightly-pr",
        "state": "running", "elapsedMs": 100,
        // A minimal valid one-state machine: the run page renders the
        // run's diagram, and a zero-state machine is loader-invalid.
        "machine": {"states": [ { "id": "entry", "entry": true } ], "transitions": []},
        "nodes": [], "usage": {"running": 0},
    }]})
}

/// The scoped `graph` reply's refreshed form: the same run with new
/// progress counters, so a later poll's repaint is an observable.
fn scoped_graph_reply_later() -> Value {
    json!({"runs": [{
        "runId": "run-1", "specId": "pr-manager", "name": "nightly-pr",
        "state": "running", "elapsedMs": 100,
        "machine": {"states": [], "transitions": []},
        "nodes": [], "usage": {"spawns": 2, "running": 2, "transitionsFired": 1},
    }]})
}

/// The dock-count pin's scoped `graph` reply: two stored factory specs
/// ride the reply (they prove the bar never numbers them), with one
/// running run and one paused run — the bar's ONE number is the running
/// count.
fn scoped_graph_with_specs_and_a_paused_run() -> Value {
    let mut reply = scoped_graph_reply();
    reply["factorySpecs"] = json!(2);
    reply["runs"]
        .as_array_mut()
        .expect("runs")
        .push(paused_scoped_run());
    reply
}

/// The dock-count pin's refreshed scoped `graph` reply: a second running
/// run joins, so the bar's one number reads the plural.
fn scoped_graph_with_specs_and_two_running() -> Value {
    let mut reply = scoped_graph_with_specs_and_a_paused_run();
    reply["runs"].as_array_mut().expect("runs").push(json!({
        "runId": "run-3", "specId": "builder", "name": "lint",
        "state": "running", "elapsedMs": 100,
        "machine": {"states": [], "transitions": []},
        "nodes": [], "usage": {"running": 0},
    }));
    reply
}

/// The dock-count pin's paused run: the attached session's own paused
/// run — a state-labeled item that never numbers the bar.
fn paused_scoped_run() -> Value {
    json!({
        "runId": "run-2", "specId": "builder", "name": "doc-sweep",
        "state": "paused", "elapsedMs": 90_000,
        "machine": {"states": [], "transitions": []},
        "nodes": [], "usage": {"running": 0},
    })
}

/// The dock-count pin's overview reply: the same two runs, owned by the
/// attached session, so the machines page paints the paused run's state
/// while the bar keeps its one number.
fn two_run_overview_reply() -> Value {
    json!({
        "runs": [
            {
                "runId": "run-1", "specId": "pr-manager", "name": "nightly-pr",
                "state": "running", "elapsedMs": 100,
                "machine": {"states": [], "transitions": []},
                "nodes": [], "usage": {"running": 0},
                "ownerId": "sess-1", "ownerName": "library session", "saved": false,
                "armed": null,
            },
            {
                "runId": "run-2", "specId": "builder", "name": "doc-sweep",
                "state": "paused", "elapsedMs": 90_000,
                "machine": {"states": [], "transitions": []},
                "nodes": [], "usage": {"running": 0},
                "ownerId": "sess-1", "ownerName": "library session", "saved": false,
                "armed": null,
            },
        ],
        "warnings": [],
    })
}

/// The session's own rows in the overview's wire shape: the attached
/// session (`sess-1`) owns the live `nightly-pr` run, so the existing
/// battery's Enter-on-run opens the run page exactly as before.
fn owned_overview_reply() -> Value {
    json!({
        "runs": [{
            "runId": "run-1", "specId": "pr-manager", "name": "nightly-pr",
            "state": "running", "elapsedMs": 100,
            // The same minimal valid one-state machine the scoped graph
            // reply carries for this run: the row's snapshot must stay
            // renderable wherever a fold carries it (a zero-state machine
            // is loader-invalid).
            "machine": {"states": [ { "id": "entry", "entry": true } ], "transitions": []},
            "nodes": [], "usage": {"running": 0},
            "ownerId": "sess-1", "ownerName": "library session", "saved": false,
            // The daemon's live-cache rows carry the peek lane's
            // `armed` marker (null for an executing run): the page routes
            // an owned row's Enter by it.
            "armed": null,
        }],
        "warnings": [],
    })
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

/// The `library` list reply (the kernel lane's own rows): the bundled
/// seeds, sorted as the library resolves them, with the file's
/// description and the source level.
fn library_machines_reply() -> Value {
    json!({
        "machines": [
            {
                "name": "builder",
                "description": "Build a documented status report from parallel section writers and merge their drafts.",
                "source": "repo",
            },
            {
                "name": "pr-manager",
                "description": "Drive a pull request through review and fix cycles, then keep a resident watcher on it.",
                "source": "repo",
            },
            {
                "name": "review-sweep",
                "description": "Sweep the changed files of a branch for review findings and merge them into one issue list.",
                "source": "repo",
            },
        ]
    })
}

/// The `library` graph reply for `pr-manager`: the kernel's spec-graph
/// snapshot shape (the same shape the active-run graph lane answers,
/// camelCase on the wire) plus the machine file's fields and the
/// mermaid rendering — the seed's own `spec_to_mermaid` text, guarded
/// edges verbatim.
fn library_graph_reply() -> Value {
    let mermaid = "stateDiagram-v2\n    state \"entry\" as entry\n    state \"reviewing\" as reviewing\n    state \"fixing\" as fixing\n    state \"monitoring\" as monitoring\n    [*] --> entry\n    entry --> reviewing\n    reviewing --> fixing: verdict.approved eq false\n    reviewing --> monitoring: verdict.approved eq true\n    fixing --> reviewing\n";
    json!({
        "runId": null,
        "specId": "pr-manager",
        "name": null,
        "state": null,
        "pauseReason": null,
        "elapsedMs": 0,
        "machine": {
            "run": {
                "maxParallel": 8,
                "maxTransitions": 24,
                "failurePolicy": "escalate",
                "maxChildren": 10_000,
                "budgetMs": 1_800_000,
            },
            "states": [
                { "id": "entry", "entry": true, "lifecycle": "task", "maxEntries": 1, "retries": 0, "subagent": "pr-entry" },
                { "id": "reviewing", "entry": false, "lifecycle": "task", "maxEntries": 4, "retries": 0, "subagent": "pr-reviewing" },
                { "id": "fixing", "entry": false, "lifecycle": "task", "maxEntries": 3, "retries": 0, "subagent": "pr-fixing" },
                { "id": "monitoring", "entry": false, "lifecycle": "resident", "maxEntries": 1, "retries": 0, "subagent": "pr-monitoring" },
            ],
            "transitions": [
                { "from": "entry", "to": "reviewing", "on": "settle" },
                { "from": "reviewing", "to": "fixing", "on": "settle",
                  "when": { "output": "verdict", "path": "approved", "op": "eq", "value": false } },
                { "from": "reviewing", "to": "monitoring", "on": "settle",
                  "when": { "output": "verdict", "path": "approved", "op": "eq", "value": true } },
                { "from": "fixing", "to": "reviewing", "on": "settle" },
            ],
            "order": ["entry", "reviewing", "fixing", "monitoring"],
        },
        "nodes": [],
        "activeNodes": [],
        "lastFired": [],
        "events": [],
        "usage": null,
        "budget": { "limitMs": 1_800_000, "consumedMs": 0 },
        "description": "Drive a pull request through review and fix cycles, then keep a resident watcher on it.",
        "version": "1",
        "author": "Prime Agent",
        "files": [
            {"path": "MACHINE.md \u{b7} entry", "text": "Identify the pull request for the current branch."},
            {"path": "MACHINE.md \u{b7} reviewing", "text": "Review the pull request at {pr_url} for merge-blocking defects."},
        ],
        "stateFiles": [
            {"state": "entry", "paths": ["MACHINE.md \u{b7} entry"]},
            {"state": "reviewing", "paths": ["MACHINE.md \u{b7} reviewing"]},
        ],
        "mermaid": mermaid,
    })
}

/// One alt+a key event (the dock's focus hand-off).
fn alt_a() -> KeyEvent {
    KeyEvent::new(KeyCode::Char('a'), KeyModifiers::ALT)
}

/// One right-arrow key event (the dock's next-group step).
fn dock_right() -> KeyEvent {
    KeyEvent::new(KeyCode::Right, KeyModifiers::NONE)
}

/// One page-down key event (`tui.select.pageDown`: the drill-in scrolls).
fn page_down() -> KeyEvent {
    KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE)
}

/// One down-arrow key event (the page's `tui.select.down`).
fn down() -> KeyEvent {
    KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)
}

/// One plain Enter key event (the dock's focused-group open, and the
/// list's drill-in).
fn enter() -> KeyEvent {
    KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
}

/// One Esc key event (`tui.select.cancel`: the drill-in's back, and
/// the open page's close).
fn escape() -> KeyEvent {
    KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)
}

/// The lane-advertised battery: the dock mounts the `☰ machines` group,
/// the dock's arrows reach it, Enter opens the page, and the open
/// fetch lists every machine; the arrows walk the list, Enter drills
/// into `pr-manager` for its ANSI diagram and its mermaid panel (the
/// arrows scroll the document to the second rendering below the fold),
/// and Esc backs out of the drill-in before the second Esc closes the
/// page (the activity pages' picker grammar, end to end).
#[test]
fn factory_page_lists_machines_with_runs_drills_in_and_escs_back() {
    let steps = vec![
        // A bare `/factory` opens the page; hold for a fetched machine row
        // and the nested run before the arrows walk the list.
        HeadlessStep::Submit("/factory".to_string()),
        HeadlessStep::WaitRender {
            needle: "\u{21b3} nightly-pr".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::WaitRender {
            needle: "builder [repo]".to_string(),
            timeout_ms: 15_000,
        },
        // The anchored cursor opens on pr-manager — the first live
        // machine — whatever order the machine list and the live rows
        // arrive in (the needle is the barrier: the machine is live
        // AND selected), so Enter drills into it directly.
        HeadlessStep::WaitRender {
            needle: "\u{25b8} \u{25c8} pr-manager".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "machine: pr-manager".to_string(),
            timeout_ms: 15_000,
        },
        // ↓ walks to the reviewing node; Enter opens its files; Esc
        // returns to the diagram; PgDn scrolls the drilled-in page.
        HeadlessStep::Key(down()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "node: reviewing".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::Key(page_down()),
        HeadlessStep::Key(page_down()),
        HeadlessStep::WaitMs(200),
        // Esc backs out of the drill-in to the list.
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitRender {
            needle: "machines \u{b7} 3 \u{b7} 1 live run".to_string(),
            timeout_ms: 15_000,
        },
        // Down to the nested run; Enter opens the run page on it; Esc
        // returns to the factory page; the next Esc closes it.
        HeadlessStep::Key(down()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "run: nightly-pr".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitGone {
            needle: "run: nightly-pr".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::WaitRender {
            needle: "machines \u{b7} 3".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitGone {
            needle: "machines \u{b7} 3".to_string(),
            timeout_ms: 15_000,
        },
    ];
    let frames = run_plan(vec!["factory_activity".to_string()], steps);
    assert!(!frames.is_empty(), "frames were captured");
    let all = flat_text(&frames);
    for needle in [
        "builder [repo]",
        "pr-manager [repo] \u{25cf} 1 live",
        "review-sweep [repo]",
        "\u{25b8} \u{25c8} pr-manager",
        "machine: pr-manager",
        "agent \u{b7} pr-entry",
        "\u{25bc} false",
        "\u{25bc} true",
        "node: reviewing",
        "MACHINE.md \u{b7} reviewing",
        "Review the pull request",
        "\u{25b8} \u{21b3} nightly-pr",
        "run: nightly-pr",
    ] {
        assert!(all.contains(needle), "the frames carry {needle:?}:\n{all}");
    }
    assert!(
        !all.contains("stateDiagram") && !all.contains("-->"),
        "mermaid renders as a diagram, never as source text:\n{all}"
    );
}

/// The cross-session battery: this client's scoped `graph` carries only
/// its own live run, and only the supervisor's `overview` carries
/// another session's run — the
/// page renders it under its machine with the owner, state, and progress
/// named; the page-only cadence updates the row without losing its
/// selection; Enter on the foreign row reports the owner instead of
/// opening the local run page; and no watch/stop/resume or child-control
/// request ever leaves this session.
#[test]
fn a_foreign_run_renders_reads_and_reports_its_owner() {
    let owner_row = |spawns: u64, running: u64, transitions: u64| {
        json!({
            "runs": [{
                "runId": "run-a", "specId": "pr-manager", "name": "a-run",
                "state": "running", "elapsedMs": 100,
                "machine": {"states": [{"id": "entry", "entry": true}], "transitions": []},
                "nodes": [{
                    "id": "entry", "status": "running",
                    "entries": [{"status": "running"}], "instances": []
                }],
                "usage": {"spawns": spawns, "running": running, "transitionsFired": transitions},
                "ownerId": "owner-a", "ownerName": "nightly builder", "saved": false,
                "armed": null,
            }],
            "warnings": [],
        })
    };
    let steps = vec![
        // A bare `/factory` opens the page; the anchored cursor opens
        // on the first live machine — pr-manager — whatever order the
        // machine list and the run rows arrive in (the needle is the
        // barrier the walk needs: the machine is live AND selected).
        HeadlessStep::Submit("/factory".to_string()),
        HeadlessStep::WaitRender {
            needle: "▸ ◈ pr-manager".to_string(),
            timeout_ms: 15_000,
        },
        // A's run renders from the overview alone: machine, owner, state,
        // active state, and progress.
        HeadlessStep::WaitRender {
            needle: "↳ a-run · nightly builder · running · 0s · entry".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::WaitRender {
            needle: "1 spawns · 1 running · 0 transitions".to_string(),
            timeout_ms: 15_000,
        },
        // Walk to the foreign run row — the cursor sits on pr-manager,
        // the anchored first live machine, so one Down reaches the
        // foreign row nested under it — and press Enter: the report
        // names the owner, the row stays read-only.
        HeadlessStep::Key(down()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "run belongs to session nightly builder".to_string(),
            timeout_ms: 15_000,
        },
        // The page-only cadence refreshes the overview: the row's progress
        // updates without losing its selection.
        HeadlessStep::WaitRender {
            needle: "▸ ↳ a-run · nightly builder · running · 0s · entry · 2 spawns · 2 running · 1 transitions".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitGone {
            needle: "machines · 3".to_string(),
            timeout_ms: 15_000,
        },
    ];
    let (frames, requests) = run_plan_overview(
        vec!["factory_activity".to_string()],
        owner_row(1, 1, 0),
        owner_row(2, 2, 1),
        steps,
    );
    assert!(!frames.is_empty(), "frames were captured");
    let all = flat_text(&frames);
    for needle in [
        // The badge counts the foreign run beside the attached
        // session's own live row, which the overview fold's retention
        // merge keeps on the page: both stay listed under the machine.
        "pr-manager [repo] ● 2 live",
        "↳ a-run · nightly builder · running · 0s · entry",
        "2 spawns · 2 running · 1 transitions",
        "run belongs to session nightly builder",
    ] {
        assert!(all.contains(needle), "the frames carry {needle:?}:\n{all}");
    }
    // No local run page ever mounted for the foreign run (its header is
    // `run: <name>`).
    assert!(
        !all.contains("run: a-run"),
        "a foreign row must not open the local run page:\n{all}"
    );
    // No control request ever left this session for the foreign run: the
    // scoped `graph` poll and the `overview`/`library` reads are all the
    // mock saw — no watch, no stop, no resume, no child control.
    let control_requests: Vec<&String> = requests
        .iter()
        .filter(|request| {
            request.contains("watch")
                || request.contains("stop")
                || request.contains("resume")
                || request.contains("cancel_rlm_child")
                || request.contains("delete_rlm_subagent")
        })
        .collect();
    assert!(
        control_requests.is_empty(),
        "a foreign row must not issue control requests: {control_requests:?}"
    );
    assert!(
        requests
            .iter()
            .any(|request| request.starts_with("factory_activity:overview")),
        "the page really fetched the overview lane: {requests:?}"
    );
}

/// The version-skew contract: a daemon older than the page forwards
/// `overview` to the attached session's worker, which refuses the
/// unknown action. The page falls back to the attached session's
/// scoped graph cache's rows — live and finished alike — instead of an
/// erroring empty page, and the refusal never paints. Every LATER
/// refusal re-applies the refreshed fallback rows: the finished row
/// and the refreshed counter must paint together on ONE factory-page
/// frame — a fallback frozen after its first refusal, or one that
/// drops finished rows, cannot produce that frame.
#[test]
fn an_older_daemons_overview_refusal_falls_back_to_the_scoped_graph() {
    let finished_run = || {
        json!({
            "runId": "run-done", "specId": "pr-manager", "name": "nightly-done",
            "state": "done", "elapsedMs": 100,
            "machine": {"states": [], "transitions": []},
            "nodes": [], "usage": {"running": 0},
        })
    };
    let scoped_with_finished_run = || {
        let mut reply = scoped_graph_reply();
        reply["runs"]
            .as_array_mut()
            .expect("runs")
            .push(finished_run());
        reply
    };
    let refreshed_with_finished_run = || {
        let mut reply = scoped_graph_reply_later();
        reply["runs"]
            .as_array_mut()
            .expect("runs")
            .push(finished_run());
        reply
    };
    let steps = vec![
        // A bare `/factory` opens the page; the machines list lands.
        HeadlessStep::Submit("/factory".to_string()),
        HeadlessStep::WaitRender {
            needle: "builder [repo]".to_string(),
            timeout_ms: 15_000,
        },
        // The scoped graph's own runs render from the fallback (the
        // dock's graph cache) — the live row AND the finished one —
        // even though every overview request refuses.
        HeadlessStep::WaitRender {
            needle: "\u{21b3} nightly-pr".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::WaitRender {
            needle: "\u{21b3} nightly-done".to_string(),
            timeout_ms: 15_000,
        },
        // The end is observable, not a fixed sleep: the mock serves the
        // refreshed graph (new progress counters) only once the cadence
        // asked the overview TWICE, so the frame asserted below can
        // paint only through a LATER refusal fold that re-applied the
        // fallback rows from the refreshed cache — a first fold racing
        // the dock's refresh cannot fake it.
        HeadlessStep::WaitRender {
            needle: "2 spawns \u{b7} 2 running \u{b7} 1 transitions".to_string(),
            timeout_ms: 15_000,
        },
    ];
    let (frames, requests) = run_plan_overview_full(MockPlan {
        server_capabilities: vec!["factory_activity".to_string()],
        overview_first: owned_overview_reply(),
        overview_later: owned_overview_reply(),
        overview_error: Some("unknown factory activity action".to_string()),
        graph_first: scoped_with_finished_run(),
        graph_later: refreshed_with_finished_run(),
        steps,
        ..MockPlan::default()
    });
    assert!(!frames.is_empty(), "frames were captured");
    let all = flat_text(&frames);
    assert!(
        all.contains("\u{21b3} nightly-pr"),
        "the fallback row renders:\n{all}"
    );
    // One factory-page frame carries the refreshed counter AND the
    // finished row together: a later refusal re-applied the refreshed
    // scoped rows — live and finished alike.
    assert!(
        frames.iter().any(|frame| {
            let flat = flat_text(std::slice::from_ref(frame));
            flat.contains("2 spawns \u{b7} 2 running \u{b7} 1 transitions")
                && flat.contains("\u{21b3} nightly-done \u{b7} library session \u{b7} done")
        }),
        "one factory-page frame carries the refreshed counter and the finished row:\n{all}"
    );
    assert!(
        !all.contains("unknown factory activity action"),
        "the refusal never paints as the page's state:\n{all}"
    );
    assert!(
        requests
            .iter()
            .filter(|request| request.starts_with("factory_activity:overview"))
            .count()
            >= 2,
        "the cadence re-asked the overview lane after the first refusal: {requests:?}"
    );
}

/// The held overview replies' fold marker: the page paints an overview
/// warning only when a reply folds, never from the seed, so a frame
/// carrying the seeded row WITHOUT the warning predates every fold.
const FOLD_WARNING: &str = "the held reply's fold marker";

/// The mount seed: a first open's overview cache is empty and the fetch
/// is in flight — the supervisor's catalog scan can hold the reply for
/// seconds (the reply never waits on a kernel read) — so the page
/// mounts the scoped graph cache's own rows at once (this pin's cache
/// carries the live one; the finished ones ride the same seed) and the
/// first overview reply folds over them through the uncarried-row fill,
/// live rows included — so the row's PRESENCE alone no longer proves
/// the seed painted it. The pin holds the first reply back, answers
/// ZERO runs, and stamps every overview reply with a warning the seed
/// cannot paint: a frame carrying the seeded row without the warning
/// predates every fold, so the open's own paint — the seed, never a
/// reply — painted the row.
#[test]
fn a_first_open_paints_the_scoped_graph_rows_while_the_overview_is_held() {
    let steps = vec![
        // The dock's factory count proves the scoped graph landed before
        // the page opens (the seed reads that cache).
        HeadlessStep::WaitRender {
            needle: "\u{2699} 1 machine".to_string(),
            timeout_ms: 15_000,
        },
        // Open. The held overview answers zero runs seconds later, so the
        // page's own fetch cannot paint anything yet — the seed does.
        HeadlessStep::Submit("/factory".to_string()),
        HeadlessStep::WaitRender {
            needle: "\u{21b3} nightly-pr".to_string(),
            timeout_ms: 15_000,
        },
    ];
    let (frames, _requests) = run_plan_overview_full(MockPlan {
        server_capabilities: vec!["factory_activity".to_string()],
        // Every reply carries the fold marker: the page paints the
        // warning the moment a reply folds, so no fold's frame can
        // pass for a seed-painted one.
        overview_first: json!({"runs": [], "warnings": [FOLD_WARNING]}),
        overview_later: json!({"runs": [], "warnings": [FOLD_WARNING]}),
        overview_delay_first_ms: 3_000,
        graph_first: scoped_graph_reply(),
        graph_later: scoped_graph_reply(),
        steps,
        ..MockPlan::default()
    });
    assert!(!frames.is_empty(), "frames were captured");
    let seeded_era: Vec<String> = frames
        .iter()
        .map(|frame| flat_text(std::slice::from_ref(frame)))
        .filter(|flat| flat.contains("\u{21b3} nightly-pr"))
        .collect();
    assert!(
        !seeded_era.is_empty(),
        "the seeded row paints while the overview is held:\n{}",
        seeded_era.join("\n")
    );
    assert!(
        seeded_era.iter().any(|flat| !flat.contains(FOLD_WARNING)),
        "one frame carries the seeded row before any overview fold stamped its warning:\n{}",
        seeded_era.join("\n")
    );
}

/// The dock's machines item shows ONE number — the running count,
/// pluralized — and nothing else numbers the bar (the operator's
/// dock-count directive): two stored factory specs ride the scoped graph
/// reply, one running run and one paused run, and the collapsed bar
/// renders exactly `\u{2699} 1 machine` with no paused cluster; the
/// expanded breakdown item is the same one number, followed by the two
/// state-labeled run items; a refreshed graph's second running run
/// reads `\u{2699} 2 machines`; and the paused run's state keeps
/// painting on the machines page exactly as before.
#[test]
fn the_docks_machines_item_shows_one_number_the_running_count() {
    let steps = vec![
        // Collapsed: one running run reads the singular, and the paused
        // run never clusters on the bar.
        HeadlessStep::WaitRender {
            needle: "\u{2699} 1 machine".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::WaitGone {
            needle: "\u{25d0} 1 paused".to_string(),
            timeout_ms: 5_000,
        },
        // Expanded: the breakdown item is the same one number, then the
        // two state-labeled run items — never the stored specs, a
        // running segment, or a paused segment.
        HeadlessStep::Key(alt_a()),
        HeadlessStep::WaitMs(150),
        HeadlessStep::WaitRender {
            needle: "1 machine  \u{b7}  doc-sweep paused  \u{b7}  nightly-pr running".to_string(),
            timeout_ms: 10_000,
        },
        HeadlessStep::WaitGone {
            needle: "machines \u{b7}".to_string(),
            timeout_ms: 5_000,
        },
        // Back to the editor; the machines page keeps painting the
        // paused run's state (the state lives on the page, not the bar).
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(150),
        HeadlessStep::Submit("/factory".to_string()),
        HeadlessStep::WaitRender {
            needle: "doc-sweep \u{b7} library session \u{b7} paused".to_string(),
            timeout_ms: 15_000,
        },
        // The refreshed scoped graph (the mock serves it once the page's
        // own cadence re-asked the overview twice) reaches the page
        // through the overview fold's uncarried-row fill — the second
        // running run painting on the page proves the refreshed cache
        // landed while the page stayed open.
        HeadlessStep::WaitRender {
            needle: "lint \u{b7} library session \u{b7} running".to_string(),
            timeout_ms: 15_000,
        },
        // Back to the editor: the dock paints only on the editor's own
        // frame (the page replaces the bar), so the bar's plural is
        // observable only after the close — the refreshed cache already
        // holds two running runs, so the first editor frame after Esc
        // reads the plural.
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(150),
        HeadlessStep::WaitRender {
            needle: "\u{2699} 2 machines".to_string(),
            timeout_ms: 15_000,
        },
    ];
    let (frames, _requests) = run_plan_overview_full(MockPlan {
        server_capabilities: vec!["factory_activity".to_string()],
        overview_first: two_run_overview_reply(),
        overview_later: two_run_overview_reply(),
        graph_first: scoped_graph_with_specs_and_a_paused_run(),
        graph_later: scoped_graph_with_specs_and_two_running(),
        steps,
        ..MockPlan::default()
    });
    assert!(!frames.is_empty(), "frames were captured");
    let all = flat_text(&frames);
    assert!(
        all.contains("doc-sweep \u{b7} library session \u{b7} paused"),
        "the paused run's state paints on the page:\n{all}"
    );
    assert!(
        all.contains("\u{2699} 1 machine") && all.contains("\u{2699} 2 machines"),
        "the bar's one number pluralizes across its frames:\n{all}"
    );
    assert!(
        !all.contains("2 machines \u{b7}"),
        "the stored specs never number the bar:\n{all}"
    );
    assert!(
        !all.contains("\u{2699} 1 machines"),
        "the singular run never reads the plural:\n{all}"
    );
    assert!(
        all.contains("1 machine \u{b7} doc-sweep paused \u{b7} nightly-pr running"),
        "the expanded breakdown item is the same one number, then the state-labeled run items:\n{all}"
    );
    assert!(
        !all.contains("\u{25d0} 1 paused"),
        "the paused run never clusters on the bar:\n{all}"
    );
}

/// A reopen mounts the cached overview rows SAVED: the cache is the last
/// reply of the page's PREVIOUS lifetime, so its live claims are as old
/// as the closed-page gap — the daemon itself would no longer serve them
/// unqualified. The pin reopens with a malformed later reply, so the
/// mounted rows stay on screen (the malformed report lands on the
/// overview's own error slot instead of replacing the rows) and the
/// saved marker is the reopen's own paint.
#[test]
fn a_reopen_mounts_the_cached_overview_rows_saved() {
    let steps = vec![
        // The first open: the live row lands and warms the cache.
        HeadlessStep::Submit("/factory".to_string()),
        HeadlessStep::WaitRender {
            needle: "builder [repo]".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::WaitRender {
            needle: "\u{21b3} nightly-pr".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::Key(escape()),
        // The reopen: the cached rows mount saved while the malformed
        // later reply keeps them on screen.
        HeadlessStep::Submit("/factory".to_string()),
        HeadlessStep::WaitRender {
            needle: "running \u{b7} saved".to_string(),
            timeout_ms: 15_000,
        },
    ];
    let (frames, _requests) = run_plan_overview_full(MockPlan {
        server_capabilities: vec!["factory_activity".to_string()],
        overview_first: owned_overview_reply(),
        overview_later: json!({"no runs list": true}),
        graph_first: scoped_graph_reply(),
        graph_later: scoped_graph_reply(),
        steps,
        ..MockPlan::default()
    });
    assert!(!frames.is_empty(), "frames were captured");
    let all = flat_text(&frames);
    assert!(
        all.contains("running \u{b7} saved"),
        "the reopened page paints its mounted rows saved:\n{all}"
    );
}

/// The mount seed carries the scoped graph's finished runs too — the
/// retention: the dock's graph cache keeps a window of recent terminal
/// runs for its own counts, and the attached session's own finished row
/// must stay inspectable instead of vanishing until the active-only
/// overview answers (its reply never lists it). The pin lands the
/// finished run in the dock's FIRST graph reply — the dock's own count
/// filters it already, so the dock needle proves the cache holds it —
/// then opens with the overview held: the finished run paints from the
/// seed carrying the session's own name, the walk reaches it, Enter
/// opens ITS run page (the selected header names it — the page lists
/// every run, so a bare `run:` needle would not tell which one
/// opened), and the dock and title counts do not gain it.
#[test]
fn the_mount_seed_keeps_the_scoped_graphs_finished_runs() {
    let scoped_with_done_run = || {
        let mut reply = scoped_graph_reply();
        // The finished run drills into its own run page below: a minimal
        // valid one-state machine (a zero-state machine is loader-invalid).
        reply["runs"].as_array_mut().expect("runs").push(json!({
            "runId": "run-done", "specId": "pr-manager", "name": "nightly-done",
            "state": "done", "elapsedMs": 100,
            "machine": {"states": [ { "id": "entry", "entry": true } ], "transitions": []},
            "nodes": [], "usage": {"running": 0},
        }));
        reply
    };
    let steps = vec![
        // The dock's poll proves the scoped graph — live and finished
        // rows both — landed before the page opens: the dock's count
        // already filters the finished run, so it stays "1 machine".
        HeadlessStep::WaitRender {
            needle: "\u{2699} 1 machine".to_string(),
            timeout_ms: 15_000,
        },
        // Open with the overview held: the seed paints the live row AND
        // the finished one — the attached session's own rows, the
        // finished one carrying the session's own name (the label the
        // overview gives this session's live rows, never the raw id).
        HeadlessStep::Submit("/factory".to_string()),
        HeadlessStep::WaitRender {
            needle: "\u{21b3} nightly-pr".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::WaitRender {
            needle: "\u{21b3} nightly-done \u{b7} library session".to_string(),
            timeout_ms: 15_000,
        },
        // The machines land (the walk needs the loaded list; the
        // title's live count is asserted below on the mount-era paint —
        // the zero-run folds keep the live row too through the
        // retention merge, so the count never gains the finished one
        // either way).
        HeadlessStep::WaitRender {
            needle: "machines \u{b7} 3".to_string(),
            timeout_ms: 15_000,
        },
        // Walk to the finished row and press Enter: the seed's live
        // rows mean the page opens on pr-manager itself (the first live
        // machine), so one Down reaches the finished row nested under
        // it. The owned, live-backed row opens the finished run's own
        // run page — SELECTED, so the run page's selected header names
        // the finished run.
        HeadlessStep::Key(down()),
        HeadlessStep::WaitRender {
            needle: "\u{25b8} \u{21b3} nightly-done".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "\u{25b8} run: nightly-done".to_string(),
            timeout_ms: 15_000,
        },
    ];
    let (frames, _requests) = run_plan_overview_full(MockPlan {
        server_capabilities: vec!["factory_activity".to_string()],
        overview_first: json!({"runs": [], "warnings": []}),
        overview_later: json!({"runs": [], "warnings": []}),
        overview_delay_first_ms: 3_000,
        graph_first: scoped_with_done_run(),
        graph_later: scoped_with_done_run(),
        steps,
        ..MockPlan::default()
    });
    assert!(!frames.is_empty(), "frames were captured");
    let all = flat_text(&frames);
    assert!(
        all.contains("\u{21b3} nightly-pr"),
        "the seeded live row paints while the overview is held:\n{all}"
    );
    assert!(
        all.contains("\u{21b3} nightly-done"),
        "the scoped graph's finished run seeds the page:\n{all}"
    );
    // The retained row carries the session's own name — the label the
    // overview gives this session's live rows, never the raw durable id
    // the unnamed fallback paints. The final assert pins it: a timed
    // WaitRender needle alone skips softly and pins nothing.
    assert!(
        all.contains("\u{21b3} nightly-done \u{b7} library session"),
        "the retained finished row carries the session's own name:\n{all}"
    );
    // The run page's SELECTED header names the finished run itself —
    // the page lists every run in the scoped cache, so the marker alone
    // proves the retained row's Enter opened ITS page, not any run
    // page.
    assert!(
        all.contains("\u{25b8} run: nightly-done"),
        "Enter on the retained finished row opens its run page, selected:\n{all}"
    );
    // The counts never gain the terminal row: the dock's factory count
    // stays one, and the mount-era title — painted with BOTH rows
    // seeded — counts one live run, never two.
    assert!(
        all.contains("\u{2699} 1 machine"),
        "the dock count stays live-only:\n{all}"
    );
    assert!(
        all.contains("machines \u{b7} 1 live run"),
        "the mounted title counts the seeded rows live-only:\n{all}"
    );
    assert!(
        !all.contains("2 live"),
        "the finished row never inflates a live count:\n{all}"
    );
}

/// The mount seed's warm-cache half: a reopen over a WARM overview
/// cache keeps its saved rows and gains the scoped graph's finished
/// rows at once — the merge, never an emptiness gate. The pin opens
/// the page once and waits for the FIRST overview fold's own marker
/// (the reply's unique 7-transition delta, held back 500 ms so the
/// wait is real) — the cold scoped seed already paints the owner
/// label the fold repaints, so the label alone cannot barrier the
/// fold — then closes and reopens while every LATER overview reply
/// is held: a finished row painting beside the SAVED warm row can
/// only come from the reopen's own mount seed — the held reply has
/// not folded anything in, and an emptiness gate would mount the
/// cached row alone, so the cold-cache pins cannot see this seam.
#[test]
fn a_warm_reopen_keeps_the_saved_rows_and_gains_the_scoped_graphs_finished_run() {
    let scoped_with_done_run = || {
        let mut reply = scoped_graph_reply();
        reply["runs"].as_array_mut().expect("runs").push(json!({
            "runId": "run-done", "specId": "pr-manager", "name": "nightly-done",
            "state": "done", "elapsedMs": 100,
            "machine": {"states": [], "transitions": []},
            "nodes": [], "usage": {"running": 0},
        }));
        reply
    };
    let steps = vec![
        // The dock's poll proves the scoped graph — the finished run
        // included — landed before the first open.
        HeadlessStep::WaitRender {
            needle: "\u{2699} 1 machine".to_string(),
            timeout_ms: 15_000,
        },
        // The first open: wait for the FIRST OVERVIEW FOLD's own
        // marker — the reply's unique 7-transition delta — before
        // closing, so the reopen's cache is provably warm (the cold
        // scoped seed paints the same owner label the fold repaints,
        // so the label alone cannot barrier the fold).
        HeadlessStep::Submit("/factory".to_string()),
        HeadlessStep::WaitRender {
            needle: "7 transitions".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::WaitRender {
            needle: "machines \u{b7} 3".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitGone {
            needle: "machines \u{b7} 3".to_string(),
            timeout_ms: 15_000,
        },
        // The reopen: every LATER overview reply is held, so the
        // reopen's saved-era frames stay on screen — the finished row
        // beside the SAVED warm row is the mount seed's merge alone.
        HeadlessStep::Submit("/factory".to_string()),
        HeadlessStep::WaitRender {
            needle: "running \u{b7} saved".to_string(),
            timeout_ms: 15_000,
        },
    ];
    let (frames, _requests) = run_plan_overview_full(MockPlan {
        server_capabilities: vec!["factory_activity".to_string()],
        // The first reply carries the 7-transition delta, and its
        // 500 ms hold makes the barrier's wait real: the fold, not a
        // race past it, warms the cache.
        overview_first: {
            let mut reply = owned_overview_reply();
            reply["runs"][0]["usage"]["transitionsFired"] = json!(7);
            reply
        },
        overview_later: owned_overview_reply(),
        overview_delay_first_ms: 500,
        overview_delay_later_ms: 2_500,
        graph_first: scoped_with_done_run(),
        graph_later: scoped_with_done_run(),
        steps,
        ..MockPlan::default()
    });
    assert!(!frames.is_empty(), "frames were captured");
    let saved_era: Vec<String> = frames
        .iter()
        .map(|frame| flat_text(std::slice::from_ref(frame)))
        .filter(|flat| flat.contains("running \u{b7} saved"))
        .collect();
    assert!(
        !saved_era.is_empty(),
        "the reopen mounts its cached rows saved:\n{}",
        saved_era.join("\n")
    );
    assert!(
        saved_era
            .iter()
            .any(|flat| flat.contains("\u{21b3} nightly-done")),
        "one saved-era frame carries the scoped graph's finished row beside the saved warm row:\n{}",
        saved_era.join("\n")
    );
}

/// The retained row's owner name is the session's own attach name,
/// scrubbed the way the overview scrubs the same name: a hostile
/// session name carries an OSC 8 hyperlink pair (an open with a URL
/// and a close) — raw, the pair rides the frame scanner as a hidden
/// clickable target; scrubbed, only printable text paints. The
/// headless capture EATS a raw OSC 8 pair (its sequences collapse to
/// their label text), so the proof is the residue: the scrubbed row
/// paints the URL text with the escapes gone, while an unscrubbed row
/// collapses to `beforeownerafter` with the URL swallowed.
#[test]
fn the_retained_row_scrubs_the_session_names_control_bytes() {
    let scoped_with_done_run = || {
        let mut reply = scoped_graph_reply();
        reply["runs"].as_array_mut().expect("runs").push(json!({
            "runId": "run-done", "specId": "pr-manager", "name": "nightly-done",
            "state": "done", "elapsedMs": 100,
            "machine": {"states": [], "transitions": []},
            "nodes": [], "usage": {"running": 0},
        }));
        reply
    };
    let hostile = concat!(
        "before",
        "\u{1b}]8;;https://example.test/retained\u{1b}\\",
        "owner",
        "\u{1b}]8;;\u{1b}\\",
        "after"
    );
    let (frames, _requests) = run_plan_overview_full(MockPlan {
        server_capabilities: vec!["factory_activity".to_string()],
        // The overview answers nothing: the retained row is the scoped
        // graph's seed alone, the seam this pin guards.
        overview_first: json!({"runs": [], "warnings": []}),
        overview_later: json!({"runs": [], "warnings": []}),
        graph_first: scoped_with_done_run(),
        graph_later: scoped_with_done_run(),
        session_name: Some(hostile.to_string()),
        steps: vec![
            // The dock's poll proves the scoped graph — the finished
            // run included — landed before the open.
            HeadlessStep::WaitRender {
                needle: "\u{2699} 1 machine".to_string(),
                timeout_ms: 15_000,
            },
            HeadlessStep::Submit("/factory".to_string()),
            HeadlessStep::WaitRender {
                needle: "\u{21b3} nightly-done".to_string(),
                timeout_ms: 15_000,
            },
            HeadlessStep::WaitRender {
                needle: "machines \u{b7} 3".to_string(),
                timeout_ms: 15_000,
            },
        ],
        ..MockPlan::default()
    });
    let all = flat_text(&frames);
    let row = frames
        .iter()
        .flat_map(|frame| frame.lines())
        .find(|line| line.contains("\u{21b3} nightly-done"))
        .expect("the retained row paints");
    // The scrub's residue: the URL text paints as plain characters
    // (every control byte became a space), never as a live sequence.
    assert!(
        row.contains("]8;;https://example.test/retained"),
        "the scrubbed session name's printable residue rides the retained row:\n{all}"
    );
    // Raw, the capture eats both OSC 8 sequences and the label
    // collapses to the link text alone — the URL vanishes with them.
    assert!(
        !row.contains("beforeownerafter"),
        "a raw OSC 8 pair in the session name must never reach the retained row:\n{all}"
    );
}

/// The unnamed-owner fallback: a run whose owner has no display name
/// paints the owner's IDENTITY as its label — and a session header id
/// may carry control bytes (its validator rejects path separators
/// alone), so the label seam scrubs the fallback before width
/// measurement and paint, exactly as the parse scrubs every name and
/// the retained row scrubs the attached session's own name. The
/// headless capture strips OSC 8 sequences but keeps every other
/// escape, so the id carries an SGR color change beside the OSC 8
/// pair: raw, the SGR rides the captured line verbatim and the
/// control-byte assert fires on it (the pair collapses to its label
/// text), while scrubbed, both sequences leave only printable residue
/// on the row.
#[test]
fn an_unnamed_owner_row_scrubs_the_ids_control_bytes() {
    let hostile_id = concat!(
        "before",
        "\u{1b}[31m",
        "\u{1b}]8;;example.test\u{7}",
        "linked",
        "\u{1b}]8;;\u{7}",
        "after"
    );
    let unnamed_owner_row = || {
        json!({
            "runs": [{
                "runId": "run-id", "specId": "pr-manager", "name": "unnamed-owner-run",
                "state": "running", "elapsedMs": 100,
                "machine": {"states": [], "transitions": []},
                "nodes": [], "usage": {"running": 0},
                "ownerId": hostile_id, "saved": false, "armed": null,
            }],
            "warnings": [],
        })
    };
    let (frames, _requests) = run_plan_overview_full(MockPlan {
        server_capabilities: vec!["factory_activity".to_string()],
        overview_first: unnamed_owner_row(),
        overview_later: unnamed_owner_row(),
        steps: vec![
            HeadlessStep::Submit("/factory".to_string()),
            HeadlessStep::WaitRender {
                needle: "\u{21b3} unnamed-owner-run".to_string(),
                timeout_ms: 15_000,
            },
            HeadlessStep::WaitRender {
                needle: "machines \u{b7} 3".to_string(),
                timeout_ms: 15_000,
            },
        ],
        ..MockPlan::default()
    });
    assert!(!frames.is_empty(), "frames were captured");
    let all = flat_text(&frames);
    let row = frames
        .iter()
        .flat_map(|frame| frame.lines())
        .find(|line| line.contains("\u{21b3} unnamed-owner-run"))
        .expect("the unnamed owner's row paints");
    assert!(
        !row.contains('\u{1b}') && !row.contains('\u{7}'),
        "the unnamed owner's id must scrub its control bytes before the row paints:\n{all}"
    );
    assert!(
        row.contains("]8;;example.test"),
        "the scrubbed fallback's OSC residue rides the row's owner label:\n{all}"
    );
    assert!(
        row.contains("[31m"),
        "the scrubbed fallback's SGR residue rides the row's owner label:\n{all}"
    );
}

/// The overview fold's retention through a REAL finish: the page
/// opens on the run LIVE — the overview lists it live, the scoped
/// graph cache reads it live — then the run finishes on the open
/// page: the next overview answers ZERO runs (its active-only
/// contract) while the dock's scoped graph still reads the run live
/// (the two caches' freshness skew, the moment the retention exists
/// for), and only the refreshed `graph_later` reply turns it done
/// with a fresh counter. The row must stay on the page through every
/// fold — cursor and all — and the done state with its fresh counter
/// must paint on the FACTORY PAGE's own row line: the mock serves the
/// refreshed graph only once the cadence asked the overview twice,
/// and the scoped fold never repaints the page, so the delta can
/// never be a seed-era paint. The final asserts read ONE frame's own
/// row line, never the joined frames (`flat_text` keeps every frame,
/// and a later page repaints the same counters).
#[test]
fn an_active_only_overview_fold_retains_the_scoped_graphs_finished_run() {
    let scoped_run = |state: &str, transitions: u64| {
        json!({"runs": [{
            "runId": "run-1", "specId": "pr-manager", "name": "nightly-pr",
            "state": state, "elapsedMs": 100,
            "machine": {"states": [], "transitions": []},
            "nodes": [], "usage": {"transitionsFired": transitions},
        }]})
    };
    let steps = vec![
        // The dock's count proves the scoped graph — the run LIVE —
        // landed before the page opens.
        HeadlessStep::WaitRender {
            needle: "\u{2699} 1 machine".to_string(),
            timeout_ms: 15_000,
        },
        // Open: the seed paints the live row, the first overview reply
        // lists it live too, and the machines land for the walk.
        HeadlessStep::Submit("/factory".to_string()),
        HeadlessStep::WaitRender {
            needle: "\u{21b3} nightly-pr".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::WaitRender {
            needle: "builder [repo]".to_string(),
            timeout_ms: 15_000,
        },
        // Walk the cursor onto the run's row: the finish below must
        // hold the row under the cursor.
        HeadlessStep::Key(down()),
        HeadlessStep::WaitRender {
            needle: "\u{25b8} \u{21b3} nightly-pr".to_string(),
            timeout_ms: 15_000,
        },
        // The run finishes on the open page: the overviews answer zero
        // runs while the scoped graph still reads it live, then the
        // refreshed graph turns it done with a fresh counter — the
        // fold's retention must carry the row through, done and
        // refreshed, still under the cursor.
        HeadlessStep::WaitRender {
            needle: "\u{25b8} \u{21b3} nightly-pr \u{b7} library session \u{b7} done".to_string(),
            timeout_ms: 15_000,
        },
    ];
    let (frames, requests) = run_plan_overview_full(MockPlan {
        server_capabilities: vec!["factory_activity".to_string()],
        overview_first: owned_overview_reply(),
        overview_later: json!({"runs": [], "warnings": []}),
        graph_first: scoped_run("running", 0),
        graph_later: scoped_run("done", 2),
        steps,
        ..MockPlan::default()
    });
    assert!(!frames.is_empty(), "frames were captured");
    let all = flat_text(&frames);
    // The finishing run paints on the factory page's own row line —
    // cursor glyph, run, done state, and the fresh counter together on
    // ONE line of ONE frame: a fold that drops the row (and moves the
    // cursor off it) can never produce this line, and the joined
    // frames would let a later page fake it.
    let row = frames
        .iter()
        .flat_map(|frame| frame.lines())
        .find(|line| {
            line.contains("\u{25b8} \u{21b3} nightly-pr")
                && line.contains("\u{b7} done \u{b7}")
                && line.contains("2 transitions")
        })
        .unwrap_or_else(|| {
            panic!("the finishing run stays on the factory row, done and refreshed, under the cursor:\n{all}")
        });
    assert!(
        row.contains("\u{b7} library session \u{b7}"),
        "the retained row carries the session's own owner label:\n{all}"
    );
    assert!(
        requests
            .iter()
            .filter(|request| request.starts_with("factory_activity:overview"))
            .count()
            >= 2,
        "the cadence really asked the overview lane twice: {requests:?}"
    );
}

/// Enter on this session's own row that no live read backs reports the
/// read-only state instead of opening the run page: only a durable
/// record lists the row (no kernel read confirms the run), so the local
/// run page would mount from an empty scoped graph and report a run the
/// list just showed as nonexistent. The report paints and no run page
/// mounts.
#[test]
fn enter_on_an_owned_saved_row_reports_the_state_not_a_dead_end() {
    let owned_saved_row = || {
        json!({"runs": [{
            "runId": "run-9", "specId": "pr-manager", "name": "nightly-hold",
            "state": "paused", "elapsedMs": 90_000,
            "machine": {"states": [], "transitions": [], "order": []},
            "nodes": [],
            "usage": {"running": 0},
            "ownerId": "sess-1", "ownerName": "library session", "saved": true,
        }], "warnings": []})
    };
    let steps = vec![
        HeadlessStep::Submit("/factory".to_string()),
        // The machines list and the owned saved row nest under
        // pr-manager.
        HeadlessStep::WaitRender {
            needle: "builder [repo]".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::WaitRender {
            needle: "\u{21b3} nightly-hold".to_string(),
            timeout_ms: 15_000,
        },
        // Walk to the saved row and press Enter: the anchored cursor
        // opens on pr-manager (the first live machine — the scoped
        // graph's live run rides beside the saved row), so one Down
        // reaches the saved row nested under it. The report paints;
        // the run page never mounts.
        HeadlessStep::WaitRender {
            needle: "▸ ◈ pr-manager".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::Key(down()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "resumes only through an explicit resume".to_string(),
            timeout_ms: 15_000,
        },
    ];
    let (frames, _requests) = run_plan_overview(
        vec!["factory_activity".to_string()],
        owned_saved_row(),
        owned_saved_row(),
        steps,
    );
    assert!(!frames.is_empty(), "frames were captured");
    let all = flat_text(&frames);
    // The report names what the marker means (no live read behind the
    // row) and the one action that resumes a paused run — the executor
    // never resumes it by starting or arming a kernel.
    assert!(
        all.contains("no live read backs it"),
        "the saved-row report paints:\n{all}"
    );
    assert!(
        all.contains("explicit resume"),
        "the saved-row report names the resume action:\n{all}"
    );
    assert!(
        !all.contains("run: nightly-hold"),
        "an owned saved row never opens the local run page:\n{all}"
    );
}

/// Enter on this session's own row whose kernel read listed it but
/// marked it still awaiting its re-arm (the peek lane's `armed: false`)
/// reports the RE-ARM, not a missing read: the kernel listed the run,
/// only its loop has not picked it up yet — and never promises an
/// automatic resume.
#[test]
fn enter_on_an_owned_unarmed_row_reports_the_re_arm() {
    let unarmed_row = || {
        json!({"runs": [{
            "runId": "run-10", "specId": "pr-manager", "name": "nightly-hold",
            "state": "paused", "elapsedMs": 90_000,
            "machine": {"states": [], "transitions": [], "order": []},
            "nodes": [],
            "usage": {"running": 0},
            "ownerId": "sess-1", "ownerName": "library session", "saved": true,
            "armed": false,
        }], "warnings": []})
    };
    let steps = vec![
        HeadlessStep::Submit("/factory".to_string()),
        HeadlessStep::WaitRender {
            needle: "builder [repo]".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::WaitRender {
            needle: "\u{21b3} nightly-hold".to_string(),
            timeout_ms: 15_000,
        },
        // Walk to the unarmed row (the anchored cursor opens on
        // pr-manager, the first live machine, so one Down reaches the
        // unarmed row nested under it) and press Enter: the re-arm
        // report paints; the run page never mounts.
        HeadlessStep::WaitRender {
            needle: "▸ ◈ pr-manager".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::Key(down()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "waiting for its kernel to re-arm it".to_string(),
            timeout_ms: 15_000,
        },
    ];
    let (frames, _requests) = run_plan_overview(
        vec!["factory_activity".to_string()],
        unarmed_row(),
        unarmed_row(),
        steps,
    );
    assert!(!frames.is_empty(), "frames were captured");
    let all = flat_text(&frames);
    assert!(
        all.contains("waiting for its kernel to re-arm it"),
        "the unarmed row's report names the pending re-arm:\n{all}"
    );
    assert!(
        !all.contains("no live read backs it"),
        "a listed run is not misreported as unread:\n{all}"
    );
    assert!(
        !all.contains("run: nightly-hold"),
        "an unarmed row never opens the local run page:\n{all}"
    );
}

/// The opt-in contract's off surface: a daemon whose hello advertises no
/// `factory_activity` lane mounts no factory group, and a bare `/factory`
/// opens no page.
#[test]
fn an_unadvertised_lane_mounts_no_factory_group_or_page() {
    let steps = vec![
        HeadlessStep::Key(alt_a()),
        HeadlessStep::Key(dock_right()),
        HeadlessStep::Key(dock_right()),
        HeadlessStep::Key(dock_right()),
        HeadlessStep::Key(dock_right()),
        HeadlessStep::Key(escape()),
        HeadlessStep::Submit("/factory".to_string()),
        HeadlessStep::WaitMs(300),
    ];
    let frames = run_plan(Vec::new(), steps);
    assert!(!frames.is_empty(), "frames were captured");
    let joined = frames.join("\n");
    assert!(
        !joined.contains('\u{2699}'),
        "no factory group renders while the lane is unadvertised:\n{joined}"
    );
    assert!(
        !joined.contains("machines \u{b7}") && !joined.contains("factory \u{b7}"),
        "no factory page opens:\n{joined}"
    );
}
