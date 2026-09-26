//! Headless e2e for the agents view's row-click grammar: a mock
//! supervisor serves a two-row roster, and the headless harness feeds the
//! same SGR press/release pair a terminal's plain click sends.
//!
//! Verifies the operator's named interaction: a plain click on a session
//! row selects and opens it — the Enter action — while a dragged
//! release never opens.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::time::Duration;

use pa_tui::agents_view::{
    run_agents_view, AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode,
};
use pa_tui::interactive::SessionSelection;
use serde_json::{json, Value};

/// Mouse tracking is process-global state, so the headless runs
/// serialize through one lock (the click dispatch gates on it). The
/// lock is tokio's so the guard can ride the run's awaits.
static RUN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// One roster row's wire summary (the mock `roster_subscribe` snapshot).
fn roster_row(id: &str, name: &str) -> Value {
    json!({
        "agentId": id,
        "status": "idle",
        "summary": {
            "sessionId": id,
            "lifecycle": "live",
            "activeSessionId": format!("{id}-live"),
            "sessionFile": format!("/tmp/{id}.jsonl"),
            "runtimeKind": "top-level",
            "sessionName": name,
            "messageCount": 2,
            "rlmDepth": 0,
        },
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

    /// Serve the view connection: hello, then the command loop until EOF.
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
                        json!({
                            "roster": [
                                roster_row("s1", "first one"),
                                roster_row("s2", "second one"),
                            ]
                        }),
                    );
                }
                "list_saved_sessions" => {
                    respond(
                        &mut writer,
                        id,
                        "list_saved_sessions",
                        json!({ "sessions": [] }),
                    );
                }
                "roster_unsubscribe" => {
                    respond(&mut writer, id, "roster_unsubscribe", Value::Null);
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

fn respond(writer: &mut UnixStream, id: &str, command: &str, data: Value) {
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

/// One line with a bounded quiet window; `None` ends the serve loop on
/// EOF or the quiet cap.
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
    }
}

/// Run one headless plan against a fresh mock supervisor and return the
/// outcome. Holds the run lock: the click dispatch gates on the
/// process-global tracking state the headless setup arms.
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

/// The last frame holding a needle and the needle's row within it.
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

/// A plain click on a session row opens it: the press/release pair on
/// the second row's line selects and opens that row — Enter's action
/// (the default Enter would have opened the FIRST row).
#[tokio::test]
async fn a_click_on_a_session_row_opens_it() {
    let outcome = run_plan(vec![AgentsStep::WaitSettle { timeout_ms: 2500 }]).await;
    let row = locate_row(&outcome.frames, "second one").expect("the second roster row renders");
    let outcome = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        AgentsStep::Click { row, col: 2 },
    ])
    .await;
    assert_eq!(
        outcome.selection,
        Some(SessionSelection::Attach("s2-live".to_string())),
        "the click opened the clicked row, not the default first one"
    );
}

/// A dragged release never opens the row under it (the press-drag
/// release is a select gesture, not a click).
#[tokio::test]
async fn a_dragged_release_never_opens_the_row() {
    let outcome = run_plan(vec![AgentsStep::WaitSettle { timeout_ms: 2500 }]).await;
    let row = locate_row(&outcome.frames, "second one").expect("the second roster row renders");
    // The raw reports a drag sends: the press, the motion report (button
    // 0 + the motion bit), then the release — the drag kills the pending
    // click.
    let press = format!("\x1b[<0;3;{}M", row + 1);
    let drag = format!("\x1b[<32;3;{}M", row + 1);
    let release = format!("\x1b[<0;3;{}m", row + 1);
    let outcome = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        AgentsStep::Mouse(press),
        AgentsStep::Mouse(drag),
        AgentsStep::Mouse(release),
    ])
    .await;
    assert_eq!(
        outcome.selection, None,
        "the dragged release never opened the row"
    );
}
