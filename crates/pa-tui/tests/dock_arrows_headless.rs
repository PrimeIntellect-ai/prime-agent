//! Headless e2e for the activity dock's arrow traversal (operator
//! directive 2026-09-26): every rendered section is one press away in
//! both directions (empty sections visited, cycle wraps), and entering
//! opens its view; the TS dock has no section traversal (Rust divergence).
//! The event-driven pins below hold the dock's update contract: every dock
//! input repaints on its own daemon event, never on a per-wake recompute.
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

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::agents_view::AgentsViewScope;
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

struct MockSupervisor {
    listener: UnixListener,
    /// The `heartbeats_list` catalog to answer with (`None` serves the empty catalog — the
    /// 0-heartbeats dock).
    heartbeats: Option<Value>,
    /// The live `goal_update` event to serve on attach (`None` mounts no goal row — the all-zero
    /// dock).
    goal: Option<Value>,
    /// Successive `roster_subscribe` snapshots, one per attach; an exhausted list keeps serving
    /// the last one, and an empty list serves the empty roster.
    roster: Vec<Value>,
    /// Live frames to push right after the `roster_subscribe` response (the events the dock pins
    /// drive): each attach re-sends them.
    pushes: Vec<Value>,
}

impl MockSupervisor {
    fn bind(
        socket: &std::path::Path,
        heartbeats: Option<Value>,
        goal: Option<Value>,
        roster: Vec<Value>,
        pushes: Vec<Value>,
    ) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            heartbeats,
            goal,
            roster,
            pushes,
        }
    }

    /// Serve one client connection until it goes quiet (bounded, so the plan teardown join always
    /// finishes).
    fn serve(self) {
        self.listener
            .set_nonblocking(true)
            .expect("nonblocking mock listener");
        let idle_window = std::time::Duration::from_millis(1500);
        let idle_until = std::time::Instant::now() + idle_window;
        let (stream, _) = loop {
            match self.listener.accept() {
                Ok(accepted) => break accepted,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() >= idle_until {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(_) => return,
            }
        };
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
        let mut subscribe = 0usize;
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
                    if let Some(goal) = &self.goal {
                        write_session_event(&mut writer, goal);
                    }
                }
                "heartbeats_list" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "heartbeats_list",
                            "success": true,
                            "data": self.heartbeats.clone().unwrap_or_else(|| json!({})),
                        }),
                    );
                }
                "roster_subscribe" => {
                    let snapshot = self
                        .roster
                        .get(subscribe)
                        .or_else(|| self.roster.last())
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    subscribe += 1;
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "roster_subscribe",
                            "success": true,
                            "data": snapshot,
                        }),
                    );
                    for frame in &self.pushes {
                        write_json(&mut writer, frame);
                    }
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

fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

/// The slim attach result with an empty transcript.
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
                    "sessionName": "dock arrows session",
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

/// The dock's live goal row: the session has no subagents, heartbeats, or shells, so every other
/// section renders empty and the arrows must still visit them.
fn live_goal() -> Value {
    json!({
        "type": "goal_update",
        "goal": {
            "active": true,
            "status": "active",
            "goalId": "g-dock",
            "objective": "ship the dock arrows",
            "tokensUsed": 0,
            "timeUsedSeconds": 0,
            "continuationsUsed": 0,
        },
    })
}

/// One session heartbeat row: the session's own job, so it scopes into the dock's heartbeats
/// section and its view.
fn canary_heartbeats() -> Value {
    json!({
        "heartbeats": [
            {
                "job": {
                    "id": "hb-1",
                    "status": "active",
                    "source": "heartbeat",
                    "activeSessionId": "s1",
                    "sessionId": "sess-1",
                    "label": "lane canary",
                    "schedule": { "kind": "interval", "expression": "every 30m" },
                },
            },
        ],
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
        fullscreen_mouse: false,
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
        client_settings: None,
    }
}

/// One alt+a key event (the dock's focus hand-off, `app.subagents.focus`).
fn alt_a() -> KeyEvent {
    KeyEvent::new(KeyCode::Char('a'), KeyModifiers::ALT)
}

fn right() -> KeyEvent {
    KeyEvent::new(KeyCode::Right, KeyModifiers::NONE)
}

fn left() -> KeyEvent {
    KeyEvent::new(KeyCode::Left, KeyModifiers::NONE)
}

fn enter() -> KeyEvent {
    KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
}

/// One Esc key event (`tui.select.cancel`: the open view closes and the focus returns to the
/// editor).
fn escape() -> KeyEvent {
    KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)
}

fn run_plan(
    steps: Vec<HeadlessStep>,
    heartbeats: Option<Value>,
    goal: Option<Value>,
) -> pa_tui::interactive::InteractiveOutcome {
    run_plan_with_roster(steps, heartbeats, goal, Vec::new(), Vec::new())
}

/// `run_plan` plus the `roster_subscribe` snapshots and the live frames pushed after each
/// subscription reply (the event-driven dock pins' mock surface).
fn run_plan_with_roster(
    steps: Vec<HeadlessStep>,
    heartbeats: Option<Value>,
    goal: Option<Value>,
    roster: Vec<Value>,
    pushes: Vec<Value>,
) -> pa_tui::interactive::InteractiveOutcome {
    // The ambient TMUX variable adds a startup notice; scrub it so runs are the same inside tmux
    // and out.
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket, heartbeats, goal, roster, pushes);
    let handle = std::thread::spawn(move || supervisor.serve());

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps,
        width: 100,
        height: 40,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    outcome
}

/// The arrows still visit each empty section in order, each opening its own view (panel-exit
/// ruling 2026-09-26); Left from the subagents section opens the scoped agents view (2026-09-28).
#[test]
fn dock_arrows_visit_each_empty_section_in_order_both_directions() {
    let steps = vec![
        HeadlessStep::WaitRender {
            needle: "Pursuing goal (0s)".to_string(),
            timeout_ms: 5_000,
        },
        // The selection starts on the subagents section.
        HeadlessStep::Key(alt_a()),
        HeadlessStep::WaitMs(100),
        // One right press lands on the EMPTY heartbeats section.
        HeadlessStep::Key(right()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "No running or paused heartbeats".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(right()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "No background commands".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(right()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "status   active".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(left()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(left()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "No running or paused heartbeats".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(left()),
        HeadlessStep::WaitMs(100),
        // Left from the subagents selection opens the scoped agents view (the operator's 2026-09-28
        // ask); the plan ends on the agents surface.
        HeadlessStep::Key(left()),
        HeadlessStep::WaitMs(300),
    ];
    let outcome = run_plan(steps, None, Some(live_goal()));
    let all = outcome.frames.join("\n");

    assert!(
        all.contains(
            " \u{25c6} 0 subagents  \u{b7}  \u{25f7} 0 heartbeats  \u{b7}  \u{25b8} 0 shells  \u{b7}  Pursuing goal (0s)"
        ),
        "the dock renders every section with its zero count:\n{all}"
    );

    assert!(
        all.contains("No running or paused heartbeats"),
        "the empty heartbeats section opens its view's empty state:\n{all}"
    );
    assert!(
        all.contains("No background commands"),
        "the empty shells section opens its view's empty state:\n{all}"
    );

    assert!(
        outcome.return_to_agents_view,
        "left from the subagents selection hands the pane to the agents view"
    );
}

/// Filling a section never moves another (panel-exit ruling 2026-09-26 keeps the dock focused).
#[test]
fn dock_arrows_visit_the_same_sections_when_one_has_rows() {
    let steps = vec![
        HeadlessStep::WaitRender {
            needle: "\u{25f7} 1 heartbeat".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(alt_a()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(right()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "lane canary".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(right()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "No background commands".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(right()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "status   active".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(left()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(left()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitRender {
            needle: "lane canary".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(escape()),
        HeadlessStep::WaitMs(100),
    ];
    let outcome = run_plan(steps, Some(canary_heartbeats()), Some(live_goal()));
    let all = outcome.frames.join("\n");
    assert!(
        all.contains(
            " \u{25c6} 0 subagents  \u{b7}  \u{25f7} 1 heartbeat  \u{b7}  \u{25b8} 0 shells  \u{b7}  Pursuing goal (0s)"
        ),
        "the dock row reads the live counts:\n{all}"
    );
    assert!(
        all.contains("lane canary"),
        "the filled heartbeats section lists its rows:\n{all}"
    );
    assert!(!outcome.return_to_agents_view);
}

/// Left from the subagents selection opens the agents view (the operator's 2026-09-28 ask): the TS
/// dock has no left/right handling at all, so this is the documented Rust divergence; the editor's
/// `agents back` is the same rule on the adjacent surface.
#[test]
fn left_from_the_subagents_selection_opens_the_agents_view() {
    let steps = vec![
        HeadlessStep::WaitRender {
            needle: "Pursuing goal (0s)".to_string(),
            timeout_ms: 5_000,
        },
        // The selection starts on the subagents section.
        HeadlessStep::Key(alt_a()),
        HeadlessStep::WaitMs(100),
        HeadlessStep::Key(left()),
        HeadlessStep::WaitMs(300),
    ];
    let outcome = run_plan(steps, None, Some(live_goal()));
    assert!(
        outcome.return_to_agents_view,
        "left from the subagents selection hands the pane to the agents view"
    );
    let all = outcome.frames.join("\n");
    assert!(
        all.contains("\u{25c6} 0 subagents"),
        "the dock row mounted before the handoff:\n{all}"
    );
}

/// The all-zero dock (the operator's 2026-09-28 directive): the dock row still renders zero
/// counts, and Enter on the Subagents group opens the scoped agents view's empty roster.
#[test]
fn an_all_zero_dock_renders_and_opens_the_empty_scoped_agents_view() {
    let steps = vec![
        HeadlessStep::WaitRender {
            needle:
                " \u{25c6} 0 subagents  \u{b7}  \u{25f7} 0 heartbeats  \u{b7}  \u{25b8} 0 shells"
                    .to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Key(alt_a()),
        HeadlessStep::Key(enter()),
    ];
    let outcome = run_plan(steps, None, None);
    let all = outcome.frames.join("\n");
    assert!(
        all.contains(
            " \u{25c6} 0 subagents  \u{b7}  \u{25f7} 0 heartbeats  \u{b7}  \u{25b8} 0 shells"
        ),
        "the all-zero dock renders:\n{all}"
    );
    assert!(
        outcome.return_to_agents_view,
        "Enter opened the scoped agents view"
    );
    assert_eq!(
        outcome.agents_view_scope,
        Some(AgentsViewScope {
            session_id: Some("sess-1".to_string()),
            active_session_id: Some("s1".to_string()),
            session_name: Some("dock arrows session".to_string()),
        })
    );
}

/// The attached session's own roster row: the family root the title cost bills.
fn parent_row() -> Value {
    json!({
        "agentId": "s1",
        "status": "idle",
        "summary": {
            "sessionId": "sess-1",
            "activeSessionId": "s1",
            "sessionFile": "/tmp/sess-1.jsonl",
            "lifecycle": "live",
            "runtimeKind": "top-level",
        },
    })
}

/// One direct subagent of the attached session: the dock's running count and the family cost.
fn child_row(id: &str, status: &str, cost: f64) -> Value {
    json!({
        "agentId": id,
        "status": status,
        "summary": {
            "sessionId": format!("{id}-sess"),
            "activeSessionId": format!("{id}-live"),
            "sessionFile": format!("/tmp/{id}.jsonl"),
            "lifecycle": "live",
            "runtimeKind": "subagent",
            "parentActiveSessionId": "s1",
            "usage": { "cost": cost },
        },
    })
}

/// One `roster_update` push (the supervisor's live roster deltas).
fn roster_push(changed: &[Value]) -> Value {
    json!({ "type": "roster_update", "changed": changed, "removed": [], "resync": false })
}

/// The `roster_subscribe` snapshot reply's data object.
fn roster_snapshot(rows: &[Value]) -> Value {
    json!({ "roster": rows })
}

/// One `goal_update` session event that starts pursuing a goal.
fn goal_event_push(seconds: u64) -> Value {
    json!({
        "type": "session_event",
        "activeSessionId": "s1",
        "event": {
            "type": "goal_update",
            "goal": {
                "active": true,
                "status": "active",
                "goalId": "g-dock",
                "objective": "ship the event-driven dock",
                "tokensUsed": 0,
                "timeUsedSeconds": seconds,
                "continuationsUsed": 0,
            },
        },
    })
}

/// The dock's event-driven update contract, pinned ahead of the run loop's per-wake recompute
/// removal: a `roster_update` push alone repaints the running count and the title's family cost.
#[test]
fn a_roster_push_alone_remounts_the_dock_count_and_the_title_cost() {
    let steps = vec![
        HeadlessStep::WaitRender {
            needle: "\u{25c6} 1 subagents".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::WaitRender {
            needle: "$0.42".to_string(),
            timeout_ms: 5_000,
        },
    ];
    let pushes = vec![roster_push(&[
        parent_row(),
        child_row("c1", "running", 0.42),
    ])];
    let outcome = run_plan_with_roster(steps, None, None, Vec::new(), pushes);
    let last = outcome.frames.last().cloned().unwrap_or_default();
    assert!(
        last.contains("\u{25c6} 1 subagents") && last.contains("$0.42"),
        "the roster push repainted the dock's running count and the title's family cost:\n{}",
        outcome.frames.join("\n")
    );
}

/// A `goal_update` event alone mounts the dock's goal row.
#[test]
fn b_a_goal_update_alone_mounts_the_dock_goal_row() {
    let steps = vec![HeadlessStep::WaitRender {
        needle: "shells  \u{b7}  Pursuing goal (12s)".to_string(),
        timeout_ms: 5_000,
    }];
    let pushes = vec![goal_event_push(12)];
    let outcome = run_plan_with_roster(steps, None, None, Vec::new(), pushes);
    let last = outcome.frames.last().cloned().unwrap_or_default();
    assert!(
        last.contains("shells  \u{b7}  Pursuing goal (12s)"),
        "the goal update mounted the dock's goal row:\n{}",
        outcome.frames.join("\n")
    );
}

/// A child's settle — the roster push flipping it running to idle — drops the dock's running count
/// on its own event.
#[test]
fn c_a_child_settle_alone_drops_the_dock_running_count() {
    let steps = vec![HeadlessStep::WaitRender {
        needle: "\u{25c6} 0 subagents".to_string(),
        timeout_ms: 5_000,
    }];
    let roster = vec![roster_snapshot(&[
        parent_row(),
        child_row("c1", "running", 0.42),
    ])];
    let pushes = vec![roster_push(&[child_row("c1", "idle", 0.42)])];
    let outcome = run_plan_with_roster(steps, None, None, roster, pushes);
    let last = outcome.frames.last().cloned().unwrap_or_default();
    assert!(
        last.contains("\u{25c6} 0 subagents"),
        "the settle push dropped the dock's running count:\n{}",
        outcome.frames.join("\n")
    );
}

/// The attach fold: the `roster_subscribe` snapshot's running counts mount in the open's FIRST
/// frame, and a session switch's fresh snapshot re-mounts them in the switch's first rebuilt
/// frame — the counts follow the newly attached session.
#[test]
fn d_the_attach_mounts_the_snapshot_counts_in_its_first_frame_and_a_switch_follows() {
    let steps = vec![
        HeadlessStep::WaitRender {
            needle: "\u{25c6} 2 subagents".to_string(),
            timeout_ms: 5_000,
        },
        HeadlessStep::Submit("/new".to_string()),
        HeadlessStep::WaitRender {
            needle: "\u{25c6} 1 subagents".to_string(),
            timeout_ms: 5_000,
        },
    ];
    let roster = vec![
        roster_snapshot(&[
            parent_row(),
            child_row("c1", "running", 0.42),
            child_row("c2", "running", 0.1),
        ]),
        roster_snapshot(&[parent_row(), child_row("c1", "running", 0.42)]),
    ];
    let outcome = run_plan_with_roster(steps, None, None, roster, Vec::new());
    let first_count = outcome
        .frames
        .iter()
        .position(|frame| frame.contains("\u{25c6} 1 subagents"));
    let first_note = outcome
        .frames
        .iter()
        .position(|frame| frame.contains("started session s1"));
    assert!(
        matches!((first_count, first_note), (Some(count), Some(note)) if count <= note),
        "the switch's first rebuilt frame carries the new snapshot's counts:\n{}",
        outcome.frames.join("\n")
    );
}
