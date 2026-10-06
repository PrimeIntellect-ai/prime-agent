//! Headless e2e for the agents view's hover + click affordances (operator
//! directive 2026-09-29): EVERY row opens on a plain click (inactive
//! saved rows resume, the merged summary row expands its dropdown,
//! expanded child rows open the subagent); hover motions ride along.
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
use std::time::Duration;

use pa_tui::agents_view::{
    run_agents_view, AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode,
};
use pa_tui::interactive::SessionSelection;
use serde_json::{json, Value};

/// Mouse tracking is process-global state, so the headless runs serialize through one lock (the
/// click dispatch gates on it; tokio's, so the guard rides the run's awaits).
static RUN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn roster_row(id: &str, status: &str, summary: &Value) -> Value {
    json!({ "agentId": id, "status": status, "summary": summary })
}

fn parent_summary(id: &str) -> Value {
    json!({
        "sessionId": id,
        "lifecycle": "live",
        "activeSessionId": format!("{id}-live"),
        "sessionFile": format!("/tmp/{id}.jsonl"),
        "runtimeKind": "top-level",
        "sessionName": format!("{id} name"),
        "messageCount": 2,
        "rlmDepth": 0,
    })
}

fn child_summary(id: &str, parent: &str, name: &str) -> Value {
    json!({
        "sessionId": id,
        "lifecycle": "live",
        "activeSessionId": format!("{id}-live"),
        "sessionFile": format!("/tmp/{id}.jsonl"),
        "runtimeKind": "subagent",
        "rlmChildId": format!("child-{id}"),
        "parentActiveSessionId": format!("{parent}-live"),
        "parentSessionId": parent,
        "parentSessionPath": format!("/tmp/{parent}.jsonl"),
        "sessionName": name,
        "messageCount": 1,
        "rlmDepth": 1,
    })
}

/// One saved-catalog row (TS `serializeSavedSessionInfo`'s shape).
fn saved_row(path: &str, id: &str, name: &str) -> Value {
    json!({
        "path": path,
        "id": id,
        "cwd": "/tmp",
        "rlmDepth": 0,
        "created": "2024-01-01T00:00:00.000Z",
        "modified": "2024-01-01T00:00:00.000Z",
        "messageCount": 3,
        "name": name,
    })
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

    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept view connection");
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("read timeout");
        let write_stream = stream.try_clone().expect("clone socket");
        let mut writer = write_stream;
        let mut reader = BufReader::new(stream);
        let hello = json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": [],
        });
        write_line(&mut writer, &hello);
        loop {
            let Some(line) = read_line(&mut reader) else {
                return;
            };
            let Ok(envelope) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let id = envelope
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let command = envelope.get("command").cloned().unwrap_or(Value::Null);
            let command_type = command
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            match command_type.as_str() {
                "roster_subscribe" => {
                    respond(
                        &mut writer,
                        id,
                        "roster_subscribe",
                        &json!({
                            "roster": [
                                roster_row("p", "idle", &parent_summary("p")),
                                roster_row("c", "running", &child_summary("c", "p", "worker one")),
                            ]
                        }),
                    );
                }
                "list_saved_sessions" => {
                    respond(
                        &mut writer,
                        id,
                        "list_saved_sessions",
                        &json!({ "sessions": [saved_row("/tmp/sessions/old.jsonl", "old", "archived run")] }),
                    );
                }
                "roster_unsubscribe" => {
                    respond(&mut writer, id, "roster_unsubscribe", &Value::Null);
                }
                other => {
                    respond_failure(&mut writer, id, other, "not handled by the mock");
                }
            }
        }
    }
}

fn write_line(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize line");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write");
    writer.flush().expect("flush");
}

fn respond(writer: &mut UnixStream, id: &str, command: &str, data: &Value) {
    write_line(
        writer,
        &json!({
            "id": id,
            "type": "response",
            "command": command,
            "success": true,
            "data": data,
        }),
    );
}

fn respond_failure(writer: &mut UnixStream, id: &str, command: &str, error: &str) {
    write_line(
        writer,
        &json!({
            "id": id,
            "type": "response",
            "command": command,
            "success": false,
            "error": error,
        }),
    );
}

/// One line with a bounded quiet window; `None` ends the serve loop on EOF or the quiet cap.
fn read_line(reader: &mut BufReader<UnixStream>) -> Option<String> {
    const QUIET_WINDOW_MS: u32 = 90;
    let mut quiet_windows: u32 = 0;
    let mut line = String::new();
    loop {
        match reader.read_line(&mut line) {
            Ok(0) => return None,
            Ok(_) if line.trim().is_empty() => {
                line.clear();
            }
            Ok(_) => return Some(line),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                quiet_windows += 1;
                if quiet_windows >= QUIET_WINDOW_MS {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
                line.clear();
            }
            Err(_) => return None,
        }
    }
}

fn view_options(socket: &std::path::Path) -> AgentsViewOptions {
    AgentsViewOptions {
        socket_path: socket.to_path_buf(),
        cwd: PathBuf::from("/tmp"),
        session_dir: Some(PathBuf::from("/tmp/sessions")),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: serde_json::json!({}),
    }
}

/// Run one headless plan and return the outcome. Holds the run lock: the click dispatch gates on
/// the process-global tracking state.
async fn run_plan(steps: Vec<AgentsStep>) -> pa_tui::agents_view::AgentsViewOutcome {
    let _guard = RUN_LOCK.lock().await;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let mock = MockSupervisor::bind(&socket);
    let server = std::thread::spawn(move || mock.serve());
    let plan = AgentsHeadlessPlan {
        steps,
        width: 120,
        height: 36,
    };
    let outcome = run_agents_view(
        view_options(&socket),
        AgentsViewUiMode::Headless(plan),
        None,
    )
    .await
    .expect("the agents view run")
    .outcome;
    let _ = server.join();
    outcome
}

/// The settled roster's frames: the plan holds until the merged summary line and the saved
/// catalog's row both render (the catalog lands on the event cadence).
async fn settled_frames(needle: &str) -> Vec<String> {
    run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        AgentsStep::WaitRender {
            needle: needle.to_string(),
            timeout_ms: 8000,
        },
    ])
    .await
    .frames
}

/// The last frame holding a needle and its row.
fn locate_row(frames: &[String], needle: &str) -> Option<usize> {
    frames
        .iter()
        .filter_map(|frame| {
            frame
                .split('\n')
                .position(|row| row.contains(needle))
                .map(|row| (row, frame))
        })
        .next_back()
        .map(|(row, _)| row)
}

/// The `?1003` buttonless motion report (the hover affordance's input), one-based cells like the
/// terminal sends.
fn motion(col: usize, row: usize) -> String {
    format!("\x1b[<35;{};{}M", col + 1, row + 1)
}

/// A plain click on the INACTIVE saved row opens it: the resume selection — every row is clickable,
/// the archived ones included.
#[tokio::test]
async fn a_click_on_an_inactive_row_opens_it() {
    let frames = settled_frames("archived run").await;
    let row = locate_row(&frames, "archived run").expect("the inactive row renders");
    let outcome = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        AgentsStep::WaitRender {
            needle: "archived run".to_string(),
            timeout_ms: 8000,
        },
        AgentsStep::Click { row, col: 4 },
    ])
    .await;
    assert_eq!(
        outcome.selection,
        Some(SessionSelection::Resume(PathBuf::from(
            "/tmp/sessions/old.jsonl"
        ))),
        "the click resumed the saved session"
    );
}

/// A plain click on the merged `N subagents (M running)` row EXPANDS the dropdown — the toggle, not
/// an open: the frame renders the child rows and the run keeps running with no selection.
#[tokio::test]
async fn a_click_on_the_merged_summary_expands_the_dropdown() {
    let frames = settled_frames("subagents (").await;
    let row = locate_row(&frames, "subagents (").expect("the merged line renders");
    let outcome = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        AgentsStep::WaitRender {
            needle: "subagents (".to_string(),
            timeout_ms: 8000,
        },
        AgentsStep::Click { row, col: 4 },
        AgentsStep::WaitRender {
            needle: "worker one".to_string(),
            timeout_ms: 5000,
        },
    ])
    .await;
    let last = outcome.frames.last().expect("a frame after the click");
    assert!(
        last.contains("worker one"),
        "the click expanded the dropdown: {last}"
    );
    assert!(
        outcome.selection.is_none(),
        "the summary click toggles the dropdown, never an open"
    );
}

/// A plain click on the expanded CHILD row opens the subagent — the Enter action on the drilled-in
/// row.
#[tokio::test]
async fn a_click_on_the_expanded_child_opens_the_subagent() {
    let frames = settled_frames("subagents (").await;
    let summary = locate_row(&frames, "subagents (").expect("the merged line renders");
    let outcome = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        AgentsStep::WaitRender {
            needle: "subagents (".to_string(),
            timeout_ms: 8000,
        },
        AgentsStep::Click {
            row: summary,
            col: 4,
        },
        AgentsStep::WaitRender {
            needle: "worker one".to_string(),
            timeout_ms: 5000,
        },
    ])
    .await;
    let child = locate_row(&outcome.frames, "worker one").expect("the child renders expanded");
    let outcome = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        AgentsStep::WaitRender {
            needle: "subagents (".to_string(),
            timeout_ms: 8000,
        },
        AgentsStep::Click {
            row: summary,
            col: 4,
        },
        AgentsStep::WaitRender {
            needle: "worker one".to_string(),
            timeout_ms: 5000,
        },
        AgentsStep::Click { row: child, col: 4 },
    ])
    .await;
    assert_eq!(
        outcome.selection,
        Some(SessionSelection::Attach("c-live".to_string())),
        "the click opened the subagent row"
    );
}

/// The `?1003` hover motions ride the rows without disturbing the click grammar: motions across the
/// merged line, the child rows, and the headings, then a plain click — the subagent still opens.
#[tokio::test]
async fn hover_motions_never_disturb_the_agents_view_click() {
    let frames = settled_frames("subagents (").await;
    let summary = locate_row(&frames, "subagents (").expect("the merged line renders");
    let outcome = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        AgentsStep::WaitRender {
            needle: "subagents (".to_string(),
            timeout_ms: 8000,
        },
        AgentsStep::Click {
            row: summary,
            col: 4,
        },
        AgentsStep::WaitRender {
            needle: "worker one".to_string(),
            timeout_ms: 5000,
        },
    ])
    .await;
    let child = locate_row(&outcome.frames, "worker one").expect("the child renders expanded");
    let outcome = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        AgentsStep::WaitRender {
            needle: "subagents (".to_string(),
            timeout_ms: 8000,
        },
        // Hover motions across the parent row, the merged line, the heading, and the expanded child
        // (the buttonless reports the real terminal sends under any-event tracking).
        AgentsStep::Mouse(motion(4, 0)),
        AgentsStep::Mouse(motion(4, summary)),
        AgentsStep::Mouse(motion(2, summary - 1)),
        AgentsStep::Mouse(motion(4, summary)),
        AgentsStep::Click {
            row: summary,
            col: 4,
        },
        AgentsStep::WaitRender {
            needle: "worker one".to_string(),
            timeout_ms: 5000,
        },
        AgentsStep::Mouse(motion(4, child)),
        AgentsStep::Click { row: child, col: 4 },
    ])
    .await;
    assert_eq!(
        outcome.selection,
        Some(SessionSelection::Attach("c-live".to_string())),
        "the click opened the subagent after the hover motions"
    );
}
