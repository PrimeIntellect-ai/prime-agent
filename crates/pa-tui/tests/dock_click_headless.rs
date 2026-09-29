//! Headless e2e for the dock's hover + click affordances (operator
//! directive 2026-09-29): a mock supervisor serves one attached session
//! whose heartbeat catalog and kernel-bash registry mount the activity
//! dock, and the headless harness feeds byte-identical SGR reports
//! through the same decode-and-dispatch path a terminal's mouse takes.
//!
//! Verifies the affordance pass's click contract: a plain click on a
//! dock group segment opens that group's own view (the focused Enter
//! route — the heartbeats view, the bash view, the scoped agents view
//! for subagents), a plain click on the tray's `← manage` hint hands
//! the pane to the agents view (the hinted left-arrow action), and the
//! `?1003` hover motions ride the same path without disturbing the
//! click grammar.
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
use std::sync::{Mutex, MutexGuard};

/// Mouse tracking is process-global state, so the headless runs serialize
/// (each asserts on the tracking-active branch it drives).
static RUN_LOCK: Mutex<()> = Mutex::new(());

fn run_lock() -> MutexGuard<'static, ()> {
    match RUN_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// The SGR reports a real terminal sends: a left press, a release, and
/// the `?1003` buttonless motion report (base code 3 + the motion bit
/// — 35) the hover affordance rides.
fn press(col: usize, row: usize) -> String {
    format!("\x1b[<0;{col};{row}M")
}

fn release(col: usize, row: usize) -> String {
    format!("\x1b[<0;{col};{row}m")
}

fn motion(col: usize, row: usize) -> String {
    format!("\x1b[<35;{col};{row}M")
}

struct MockSupervisor {
    listener: UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// Serve one connection: attach the session, then answer the loop's
    /// requests — the heartbeat catalog and the kernel-bash registry
    /// carry the rows that mount the activity dock.
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        let write_stream = stream.try_clone().expect("clone mock socket");
        let mut writer = write_stream;
        let mut reader = BufReader::new(stream);

        // The kernel-bash capability gate: the dock's bash rows fold
        // only when the daemon advertises the registry.
        let hello = json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": ["kernel_bash_activity"],
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
                "heartbeats_list" => {
                    write_json(&mut writer, &heartbeat_data(id));
                    // A live goal rides the attach's first-frame fold as
                    // a session event (the daemon's push): the dock's
                    // goal group mounts with its row, the click surface's
                    // fourth group.
                    write_json(&mut writer, &goal_event());
                }
                "list_kernel_bash" => {
                    write_json(&mut writer, &bash_data(id));
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

/// The slim attach result with a one-prompt transcript: the dock mounts
/// under the editor and the window holds the exchange.
fn attach_data(id: &str) -> Value {
    let messages = vec![
        json!({ "role": "user", "content": "run it", "timestamp": 1u64 }),
        json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "all done" }],
            "timestamp": 2u64,
        }),
    ];
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
                    "sessionName": "dock click session",
                    "model": null,
                    "isStreaming": false,
                    "isCompacting": false,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                },
                "messages": messages,
                "lastEventSequence": 0,
                "lastEventCursor": null,
            },
            "client": { "id": "mock", "capabilities": [] },
            "lastEventSequence": 0,
            "lastEventCursor": null,
        },
    })
}

/// One scoped heartbeat (the session's own catalog row): the dock's
/// heartbeats group reads one live job, and the heartbeats view renders
/// the label a click on the group opens.
fn heartbeat_data(id: &str) -> Value {
    json!({
        "type": "response",
        "id": id,
        "command": "heartbeats_list",
        "success": true,
        "data": { "heartbeats": [
            {
                "job": {
                    "id": "hb-1",
                    "status": "active",
                    "source": "heartbeat",
                    "deliveryMode": "steer",
                    "activeSessionId": "s1",
                    "sessionId": "sess-1",
                    "label": "watch the fleet",
                    "prompt": "check the fleet",
                    "schedule": { "expression": "*/5 * * * *" },
                    "createdAt": "2024-01-01T00:00:00Z",
                    "runCount": 2,
                },
                "sessionName": "dock click session",
                "firstMessage": "run it",
            },
        ] },
    })
}

/// The `goal_update` session event: an actively-pursued goal mounts the
/// dock's goal group (the elapsed-time label) and the goal panel the
/// group's click opens.
fn goal_event() -> Value {
    json!({
        "type": "session_event",
        "activeSessionId": "s1",
        "event": {
            "type": "goal_update",
            "goal": {
                "active": true,
                "status": "active",
                "goalId": "g1",
                "objective": "land the hover affordances everywhere",
                "tokensUsed": 100u64,
                "timeUsedSeconds": 45u64,
                "continuationsUsed": 0u64,
            },
        },
    })
}

/// One running kernel bash row: the dock's shells group reads one live
/// run, and the bash view renders the command a click on the group
/// opens.
fn bash_data(id: &str) -> Value {
    json!({
        "type": "response",
        "id": id,
        "command": "list_kernel_bash",
        "success": true,
        "data": { "activities": [
            {
                "id": "b1",
                "command": "echo dock-click-probe",
                "pid": 4321,
                "startedAt": "2024-01-01T00:00:00Z",
                "status": "running",
            },
        ] },
    })
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
        client_settings: None,
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
    }
}

/// Run the headless plan against a fresh mock supervisor and return the
/// outcome. Holds the run lock: mouse tracking is process-global.
fn run_plan(steps: Vec<HeadlessStep>) -> pa_tui::interactive::InteractiveOutcome {
    let _guard = run_lock();
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
    let _ = handle.join();
    outcome
}

/// The settled open (the frames up to the dock's `needle` render):
/// every probe test starts here to locate the dock row's rendered
/// cells.
fn settled_frames(needle: &str) -> Vec<String> {
    let outcome = run_plan(vec![
        HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        HeadlessStep::WaitRender {
            needle: needle.to_string(),
            timeout_ms: 10_000,
        },
    ]);
    outcome.frames
}

/// The last frame holding a needle and the needle's (row, column)
/// within it — the rendered coordinates a mouse report targets.
fn locate(frames: &[String], needle: &str) -> Option<(usize, usize)> {
    frames
        .iter()
        .filter_map(|frame| {
            let rows: Vec<&str> = frame.split('\n').collect();
            let row = rows.iter().position(|r| r.contains(needle))?;
            let col = visible_col(rows[row], needle)?;
            Some((row, col))
        })
        .next_back()
}

/// The needle's VISIBLE column (the display cell the mouse targets):
/// the dock row's glyphs are multi-byte, so the byte offset a `find`
/// returns would land wide of the marked cell.
fn visible_col(line: &str, needle: &str) -> Option<usize> {
    let byte = line.find(needle)?;
    Some(line[..byte].chars().map(pa_tui::width::char_width).sum())
}

/// A plain click on the heartbeats group segment opens the heartbeats
/// view — the focused Enter's exact dispatch, arrived at by the mouse.
#[test]
fn a_click_on_the_heartbeats_group_opens_the_heartbeats_view() {
    let frames = settled_frames("1 heartbeat");
    let (row, col) = locate(&frames, "1 heartbeat").expect("the dock's heartbeats group renders");
    let outcome = run_plan(vec![
        HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        HeadlessStep::WaitRender {
            needle: "1 heartbeat".to_string(),
            timeout_ms: 10_000,
        },
        HeadlessStep::Mouse(press(col + 4, row + 1)),
        HeadlessStep::Mouse(release(col + 4, row + 1)),
        HeadlessStep::WaitRender {
            needle: "watch the fleet".to_string(),
            timeout_ms: 5_000,
        },
    ]);
    let last = outcome.frames.last().expect("a frame after the click");
    assert!(
        last.contains("watch the fleet"),
        "the click opened the heartbeats view: {last}"
    );
    assert!(
        !outcome.return_to_agents_view,
        "the heartbeats view is a dock surface, not an agents-view handoff"
    );
}

/// A plain click on the shells group segment opens the bash view.
#[test]
fn a_click_on_the_shells_group_opens_the_bash_view() {
    let frames = settled_frames("1 shell");
    let (row, col) = locate(&frames, "1 shell").expect("the dock's shells group renders");
    let outcome = run_plan(vec![
        HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        HeadlessStep::WaitRender {
            needle: "1 shell".to_string(),
            timeout_ms: 10_000,
        },
        HeadlessStep::Mouse(press(col + 4, row + 1)),
        HeadlessStep::Mouse(release(col + 4, row + 1)),
        HeadlessStep::WaitRender {
            needle: "echo dock-click-probe".to_string(),
            timeout_ms: 5_000,
        },
    ]);
    let last = outcome.frames.last().expect("a frame after the click");
    assert!(
        last.contains("echo dock-click-probe"),
        "the click opened the bash view: {last}"
    );
}

/// A plain click on the subagents group segment hands the pane to the
/// SCOPED agents view (the dock's Enter route for subagents): the run
/// exits with the agents-view handoff carrying this session's scope.
#[test]
fn a_click_on_the_subagents_group_hands_off_to_the_scoped_agents_view() {
    let frames = settled_frames("1 heartbeat");
    let (row, col) = locate(&frames, "subagents").expect("the dock's subagents group renders");
    let outcome = run_plan(vec![
        HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        HeadlessStep::WaitRender {
            needle: "subagents".to_string(),
            timeout_ms: 10_000,
        },
        HeadlessStep::Mouse(press(col + 4, row + 1)),
        HeadlessStep::Mouse(release(col + 4, row + 1)),
    ]);
    assert!(
        outcome.return_to_agents_view,
        "the click handed the pane to the agents view"
    );
    let scope = outcome
        .agents_view_scope
        .expect("the subagents group opens the SCOPED view");
    assert_eq!(scope.active_session_id.as_deref(), Some("s1"));
    assert_eq!(scope.session_id.as_deref(), Some("sess-1"));
}

/// A plain click on the tray's `← manage` hint performs the hinted
/// action: the left arrow's agents-back handoff, the GLOBAL agents
/// view (no scope).
#[test]
fn a_click_on_the_manage_hint_hands_off_to_the_agents_view() {
    let frames = settled_frames("1 heartbeat");
    let (row, col) = locate(&frames, "manage").expect("the tray's manage hint renders");
    let outcome = run_plan(vec![
        HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        HeadlessStep::WaitRender {
            needle: "manage".to_string(),
            timeout_ms: 10_000,
        },
        HeadlessStep::Mouse(press(col + 2, row + 1)),
        HeadlessStep::Mouse(release(col + 2, row + 1)),
    ]);
    assert!(
        outcome.return_to_agents_view,
        "the hint click handed the pane to the agents view"
    );
    assert!(
        outcome.agents_view_scope.is_none(),
        "the hint opens the global agents view, not a scope"
    );
}

/// A plain click on the goal group segment opens the read-only goal
/// panel (the dock's Enter route for the goal row).
#[test]
fn a_click_on_the_goal_group_opens_the_goal_panel() {
    let frames = settled_frames("Pursuing goal");
    let (row, col) = locate(&frames, "Pursuing goal").expect("the dock's goal group renders");
    let outcome = run_plan(vec![
        HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        HeadlessStep::WaitRender {
            needle: "Pursuing goal".to_string(),
            timeout_ms: 10_000,
        },
        HeadlessStep::Mouse(press(col + 4, row + 1)),
        HeadlessStep::Mouse(release(col + 4, row + 1)),
        HeadlessStep::WaitRender {
            needle: "land the hover affordances everywhere".to_string(),
            timeout_ms: 5_000,
        },
    ]);
    let last = outcome.frames.last().expect("a frame after the click");
    assert!(
        last.contains("land the hover affordances everywhere"),
        "the click opened the goal panel: {last}"
    );
}

/// The hint's click keeps the key's gate: with a draft in the editor
/// the left arrow is the caret motion, not the agents-back handoff, so
/// the click on the hint opens nothing either — the draft stays in the
/// editor (Macroscope: the unconditional dispatch stashed a draft the
/// key would have left in place).
#[test]
fn a_click_on_the_manage_hint_with_a_draft_opens_nothing() {
    let frames = settled_frames("manage");
    let (row, col) = locate(&frames, "manage").expect("the tray's manage hint renders");
    let outcome = run_plan(vec![
        HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        HeadlessStep::WaitRender {
            needle: "manage".to_string(),
            timeout_ms: 10_000,
        },
        HeadlessStep::Type("draft stays".to_string()),
        HeadlessStep::WaitRender {
            needle: "draft stays".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Mouse(press(col + 2, row + 1)),
        HeadlessStep::Mouse(release(col + 2, row + 1)),
        HeadlessStep::WaitRender {
            needle: "draft stays".to_string(),
            timeout_ms: 3_000,
        },
    ]);
    let last = outcome.frames.last().expect("a frame after the click");
    assert!(
        last.contains("draft stays"),
        "the draft stays in the editor: {last}"
    );
    assert!(
        !outcome.return_to_agents_view,
        "the hint click with a draft hands nothing off"
    );
}

/// A click on the separator between two dock groups opens nothing: the
/// gap between the segments is inert, exactly the cells the click
/// surface never recorded.
#[test]
fn a_click_on_the_separator_between_groups_opens_nothing() {
    let frames = settled_frames("1 heartbeat");
    let (row, _) = locate(&frames, "subagents").expect("the dock row renders");
    let text = frames
        .last()
        .expect("the settled frame")
        .split('\n')
        .nth(row)
        .expect("the dock row");
    // The separator's own column: the `·` between the groups.
    let col = visible_col(text, "  \u{b7}  ").expect("the separator renders") + 2;
    let outcome = run_plan(vec![
        HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        HeadlessStep::WaitRender {
            needle: "subagents".to_string(),
            timeout_ms: 10_000,
        },
        HeadlessStep::Mouse(press(col + 1, row + 1)),
        HeadlessStep::Mouse(release(col + 1, row + 1)),
        HeadlessStep::WaitRender {
            needle: "all done".to_string(),
            timeout_ms: 3_000,
        },
    ]);
    let last = outcome.frames.last().expect("a frame after the click");
    assert!(
        !last.contains("watch the fleet"),
        "the separator click opened no view: {last}"
    );
    assert!(
        !outcome.return_to_agents_view,
        "the separator click handed nothing off"
    );
}

/// The `?1003` hover motions ride the dock's rows without disturbing
/// the click grammar: motions across the groups, the hint, and the
/// editor, then a plain click — the group still opens its view.
#[test]
fn hover_motions_across_the_dock_never_disturb_the_click() {
    let frames = settled_frames("1 heartbeat");
    let (dock_row, dock_col) = locate(&frames, "1 heartbeat").expect("the dock row renders");
    let (hint_row, hint_col) = locate(&frames, "manage").expect("the tray hint renders");
    let outcome = run_plan(vec![
        HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        HeadlessStep::WaitRender {
            needle: "1 heartbeat".to_string(),
            timeout_ms: 10_000,
        },
        // Hover motions across the dock groups, the hint, and the
        // editor surface (the buttonless reports the real terminal
        // sends under any-event tracking).
        HeadlessStep::Mouse(motion(dock_col + 4, dock_row + 1)),
        HeadlessStep::Mouse(motion(hint_col + 2, hint_row + 1)),
        HeadlessStep::Mouse(motion(10, hint_row - 1)),
        HeadlessStep::Mouse(motion(dock_col + 4, dock_row + 1)),
        // The click still fires after the hover interleaving.
        HeadlessStep::Mouse(press(dock_col + 4, dock_row + 1)),
        HeadlessStep::Mouse(release(dock_col + 4, dock_row + 1)),
        HeadlessStep::WaitRender {
            needle: "watch the fleet".to_string(),
            timeout_ms: 5_000,
        },
    ]);
    let last = outcome.frames.last().expect("a frame after the click");
    assert!(
        last.contains("watch the fleet"),
        "the click opened the heartbeats view after the hover motions: {last}"
    );
}
