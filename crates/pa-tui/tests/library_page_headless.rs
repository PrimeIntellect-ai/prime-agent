//! Headless e2e for the machine library page (the activity dock's `☰
//! machines` group): a daemon that advertises the `factory_activity`
//! lane mounts the group beside the factory group, the dock's arrows
//! reach it, and Enter opens the page over the lane's `library` action
//! — the open fetch lists every machine (name, description, source),
//! the arrows walk the list, Enter drills into the selected machine for
//! its ANSI diagram (the run page's own renderer over the same snapshot
//! shape the graph lane answers) and its mermaid text panel (the
//! scrollable document window; the terminal has no graphics subsystem,
//! so the panel ships copyable text, not pixels), and Esc backs out of
//! the drill-in before it closes the page (the activity pages' picker
//! grammar). A daemon that advertises no lane mounts no group anywhere
//! (the factory's default-off opt-in contract covers the library page
//! with it).
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
    /// The hello's advertised capabilities: `factory_activity` mounts the
    /// dock's factory and machine-library groups (the opt-in gate).
    server_capabilities: Vec<String>,
    /// The `library` list reply (no target): every machine row.
    library_machines: Value,
    /// The `library` graph reply for `pr-manager` (the drill-in target).
    library_graph: Value,
}

impl MockSupervisor {
    fn bind_with(
        socket: &std::path::Path,
        server_capabilities: Vec<String>,
        library_machines: Value,
        library_graph: Value,
    ) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            server_capabilities,
            library_machines,
            library_graph,
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
                    // The lane's mock: the `library` action answers the
                    // machine list (no target) or the drilled machine's
                    // graph payload (`pr-manager`); every other action
                    // answers empty data (the page reads the library
                    // shape only).
                    let data = match command.get("action").and_then(Value::as_str) {
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
                    "sessionName": "library session",
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
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind_with(
        &socket,
        server_capabilities,
        library_machines_reply(),
        library_graph_reply(),
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
/// arrows scroll the document to the guarded edges below the fold),
/// and Esc backs out of the drill-in before the second Esc closes the
/// page (the activity pages' picker grammar, end to end).
#[test]
fn library_page_lists_machines_drills_in_and_escs_back() {
    let steps = vec![
        // Focus the dock and step to the machine-library group
        // (subagents -> heartbeats -> shells -> factory -> machines);
        // Enter opens the page and the open fetch lists the machines.
        HeadlessStep::Key(alt_a()),
        HeadlessStep::Key(dock_right()),
        HeadlessStep::Key(dock_right()),
        HeadlessStep::Key(dock_right()),
        HeadlessStep::Key(dock_right()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "machine library".to_string(),
            timeout_ms: 15_000,
        },
        // Down walks the list to pr-manager (builder is the opening
        // selection), Enter drills in, and the arrows scroll the open
        // document to the mermaid panel's guarded edges.
        HeadlessStep::Key(down()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "machine: pr-manager".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::Key(down()),
        HeadlessStep::Key(down()),
        HeadlessStep::Key(down()),
        HeadlessStep::Key(down()),
        HeadlessStep::WaitMs(200),
        // Esc backs out of the drill-in to the list; the second Esc
        // closes the page.
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitRender {
            needle: "machine library".to_string(),
            timeout_ms: 15_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitGone {
            needle: "machine library".to_string(),
            timeout_ms: 15_000,
        },
    ];
    let frames = run_plan(vec!["factory_activity".to_string()], steps);
    assert!(!frames.is_empty(), "frames were captured");
    let all = flat_text(&frames);
    assert!(
        all.contains("\u{2630} machines"),
        "the dock mounted the machine-library group:\n{all}"
    );
    // The list: every machine row with its source.
    assert!(
        all.contains("builder [repo]"),
        "the list rendered the builder row:\n{all}"
    );
    assert!(
        all.contains("review-sweep [repo]"),
        "the list rendered the review-sweep row:\n{all}"
    );
    assert!(
        all.contains("\u{25b8} pr-manager"),
        "the arrows walked the selection to pr-manager:\n{all}"
    );
    // The drill-in: the ANSI diagram (the run page's renderer over the
    // same snapshot shape) and the mermaid panel with the seed's
    // guarded edges.
    assert!(
        all.contains("machine: pr-manager"),
        "the drill-in rendered the machine header:\n{all}"
    );
    assert!(
        all.contains("entry (pr-entry) pending [entry]"),
        "the diagram rendered the entry state row:\n{all}"
    );
    assert!(
        all.contains("when verdict.approved eq false"),
        "the diagram rendered the guarded edge:\n{all}"
    );
    assert!(
        all.contains("mermaid"),
        "the mermaid panel title rendered:\n{all}"
    );
    assert!(
        all.contains("stateDiagram-v2"),
        "the mermaid text rendered as plain rows:\n{all}"
    );
    assert!(
        all.contains("reviewing --> fixing: verdict.approved eq false"),
        "the mermaid panel carried the guarded fixing edge:\n{all}"
    );
    assert!(
        all.contains("reviewing --> monitoring: verdict.approved eq true"),
        "the mermaid panel carried the guarded monitoring edge:\n{all}"
    );
}

/// The opt-in contract's off surface: a daemon whose hello advertises
/// no `factory_activity` lane mounts no machine-library group anywhere
/// — no row, no traversal, no click — exactly like the factory group
/// (the library rides the same gate).
#[test]
fn an_unadvertised_lane_mounts_no_machines_group() {
    let steps = vec![
        // Focus the dock and walk its groups: the traversal must step
        // across the real groups only, never a hidden one.
        HeadlessStep::Key(alt_a()),
        HeadlessStep::Key(dock_right()),
        HeadlessStep::Key(dock_right()),
        HeadlessStep::Key(dock_right()),
        HeadlessStep::Key(dock_right()),
        HeadlessStep::WaitMs(300),
    ];
    let frames = run_plan(Vec::new(), steps);
    assert!(!frames.is_empty(), "frames were captured");
    let joined = frames.join("\n");
    assert!(
        !joined.contains('\u{2630}'),
        "no machine-library group renders while the lane is unadvertised:\n{joined}"
    );
    assert!(
        !joined.contains('\u{2699}'),
        "no factory group renders either:\n{joined}"
    );
}
