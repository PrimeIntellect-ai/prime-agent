//! Headless e2e for the agents view's machine-wide persistent shells: the list's
//! `Persistent shells` block names each shell's assigned session (`(deleted)` once the session is
//! gone), and Enter on a shell opens its output with the kill action.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::time::Duration;

use pa_tui::agents_view::{
    run_agents_view, AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode,
};
use serde_json::{json, Value};

// Headless mouse tracking is process-global; all plans in this binary serialize.
static RUN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn shell(id: &str, command: &str, session_id: &str, status: &str) -> Value {
    json!({ "id": id, "command": command, "pid": 4242, "startedAt": "2026-01-01T00:00:00+00:00",
            "durationMs": 12_400, "status": status, "persistent": true, "sessionId": session_id })
}

/// Serves the roster (one live session, `release prep`), an empty saved catalog, and two shells:
/// `build-watch` assigned to the live session, `long-job` to a deleted one. A kill finishes the
/// shell in later lists; returns the killed shell ids.
fn serve(listener: &UnixListener) -> Vec<String> {
    let (stream, _) = listener.accept().expect("accept view connection");
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .expect("read timeout");
    let mut writer = stream.try_clone().expect("clone socket");
    let mut reader = BufReader::new(stream);
    write_line(
        &mut writer,
        &json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": ["persistent_shells"],
        }),
    );
    let mut killed = Vec::new();
    let mut deleted = Vec::new();
    let mut pending_kill_failure: Option<String> = None;
    loop {
        let Some(line) = read_line(&mut reader) else {
            return killed;
        };
        let Ok(envelope) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = envelope["id"].as_str().unwrap_or_default();
        let command = &envelope["command"];
        let command_type = command["type"].as_str().unwrap_or_default();
        let data = match command_type {
            "roster_subscribe" => json!({ "roster": [{
                "agentId": "p",
                "status": "idle",
                "summary": {
                    "sessionId": "p",
                    "lifecycle": "live",
                    "activeSessionId": "p-live",
                    "sessionFile": "/tmp/p.jsonl",
                    "runtimeKind": "top-level",
                    "sessionName": "release prep",
                    "messageCount": 2,
                    "rlmDepth": 0,
                },
            }] }),
            "list_saved_sessions" => json!({ "sessions": [] }),
            "list_persistent_shells" => {
                let build_status = if killed.is_empty() {
                    "running"
                } else {
                    "finished"
                };
                let shells: Vec<Value> = [
                    shell("b", "build-watch", "p", build_status),
                    shell("l", "long-job", "gone", "running"),
                ]
                .into_iter()
                .filter(|shell| !deleted.contains(&shell["id"]))
                .collect();
                json!({ "activities": shells })
            }
            "tail_persistent_shell" => {
                // Deliver the old shell's error only once another shell's
                // pane has opened and requested its output.
                if command["shellId"] == "b" {
                    if let Some(kill_id) = pending_kill_failure.take() {
                        respond_failure(
                            &mut writer,
                            &kill_id,
                            "kill_persistent_shell",
                            "old shell kill failed",
                        );
                    }
                }
                json!({ "shellId": command["shellId"], "tail": "watching..." })
            }
            "kill_persistent_shell" => {
                if command["shellId"] == "l" {
                    pending_kill_failure = Some(id.to_string());
                    continue;
                }
                killed.push(command["shellId"].as_str().unwrap_or_default().to_string());
                json!({ "shellId": command["shellId"] })
            }
            "delete_persistent_shell" => {
                deleted.push(command["shellId"].clone());
                json!({ "shellId": command["shellId"] })
            }
            "roster_unsubscribe" => Value::Null,
            other => {
                respond_failure(&mut writer, id, other, "not handled by the mock");
                continue;
            }
        };
        respond(&mut writer, id, command_type, &data);
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

/// Run one headless plan against the mock; returns the frames and the killed shell ids.
async fn run_plan(steps: Vec<AgentsStep>) -> (Vec<String>, Vec<String>) {
    let _guard = RUN_LOCK.lock().await;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let listener = UnixListener::bind(&socket).expect("bind mock socket");
    let server = std::thread::spawn(move || serve(&listener));
    let plan = AgentsHeadlessPlan {
        steps,
        width: 100,
        height: 30,
    };
    let outcome = Box::pin(run_agents_view(
        view_options(&socket),
        AgentsViewUiMode::Headless(plan),
        None,
    ))
    .await
    .expect("the agents view run")
    .outcome;
    (outcome.frames, server.join().expect("mock"))
}

fn wait_render(needle: &str) -> AgentsStep {
    AgentsStep::WaitRender {
        needle: needle.to_string(),
        timeout_ms: 8000,
    }
}

#[tokio::test]
async fn persistent_shells_list_with_their_session_or_deleted() {
    let (frames, _) = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        wait_render("long-job \u{b7} 12.4s \u{b7} (deleted)"),
    ])
    .await;

    let last = frames.last().expect("a frame");
    for needle in [
        "Persistent shells (2)",
        "$ build-watch \u{b7} 12.4s \u{b7} release prep",
        "$ long-job \u{b7} 12.4s \u{b7} (deleted)",
    ] {
        assert!(
            last.contains(needle),
            "{needle:?} in the last frame:\n{last}"
        );
    }
}

#[tokio::test]
async fn enter_on_a_shell_shows_its_output_and_kills_it() {
    let (frames, killed) = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        wait_render("long-job \u{b7} 12.4s \u{b7} (deleted)"),
        AgentsStep::Key("home".to_string()),
        AgentsStep::Key("enter".to_string()),
        wait_render("watching..."),
        AgentsStep::Key("enter".to_string()),
        wait_render("finished"),
    ])
    .await;

    assert!(
        frames.iter().any(|frame| frame.contains("watching...")),
        "the open showed the shell's output"
    );
    assert_eq!(killed, ["b"], "the kill named the selected shell");
    let last = frames.last().expect("a frame");
    assert!(
        last.contains("build-watch") && last.contains("finished"),
        "the killed shell's pane shows it finished:\n{last}"
    );
}

#[tokio::test]
async fn clicking_a_shell_dispatches_its_tail_without_another_key() {
    let (baseline, _) = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        wait_render("long-job \u{b7} 12.4s \u{b7} (deleted)"),
    ])
    .await;
    let row = baseline
        .last()
        .expect("list frame")
        .lines()
        .position(|line| line.contains("$ build-watch \u{b7} 12.4s \u{b7} release prep"))
        .expect("shell row");
    let (frames, killed) = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        wait_render("long-job \u{b7} 12.4s \u{b7} (deleted)"),
        AgentsStep::Click { row, col: 3 },
        wait_render("watching..."),
        // Click where the hidden session row sits: the overlay owns it.
        AgentsStep::Click {
            row: row + 4,
            col: 3,
        },
    ])
    .await;
    assert!(frames
        .last()
        .expect("overlay frame")
        .contains("watching..."));
    assert!(killed.is_empty());
}

#[tokio::test]
async fn a_late_kill_failure_does_not_move_to_another_shell_pane() {
    let (frames, _) = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        wait_render("long-job \u{b7} 12.4s \u{b7} (deleted)"),
        AgentsStep::Key("home".to_string()),
        AgentsStep::Key("down".to_string()),
        AgentsStep::Key("enter".to_string()),
        wait_render("watching..."),
        AgentsStep::Key("enter".to_string()),
        AgentsStep::Key("escape".to_string()),
        AgentsStep::Key("up".to_string()),
        AgentsStep::Key("enter".to_string()),
        wait_render("watching..."),
    ])
    .await;
    assert!(frames
        .last()
        .expect("shell B frame")
        .contains("build-watch"));
    assert!(
        !frames
            .iter()
            .any(|frame| frame.contains("old shell kill failed")),
        "shell A's failure must not appear on shell B"
    );
}

#[tokio::test]
async fn ctrl_x_on_a_shell_row_stops_it_then_deletes_it_through_the_session_confirm() {
    let (frames, killed) = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        wait_render("long-job \u{b7} 12.4s \u{b7} (deleted)"),
        AgentsStep::Key("home".to_string()),
        wait_render("open   Ctrl+X stop"),
        AgentsStep::Key("ctrl+x".to_string()),
        wait_render("Press Ctrl+X again to stop"),
        AgentsStep::Key("ctrl+x".to_string()),
        wait_render("Stopped build-watch"),
        wait_render("open   Ctrl+X delete"),
        AgentsStep::Key("ctrl+x".to_string()),
        wait_render("Press Ctrl+X again to delete"),
        AgentsStep::Key("ctrl+x".to_string()),
        wait_render("Persistent shells (1)"),
    ])
    .await;

    assert_eq!(killed, ["b"], "the stop named the selected shell");
    let mut needles = [
        "open   Ctrl+X stop",
        "Press Ctrl+X again to stop",
        "Stopped build-watch",
        "open   Ctrl+X delete",
        "Press Ctrl+X again to delete",
        "Persistent shells (1)",
    ]
    .into_iter()
    .peekable();
    for frame in &frames {
        if needles.peek().is_some_and(|needle| frame.contains(needle)) {
            needles.next();
        }
    }
    assert_eq!(
        needles.next(),
        None,
        "frames in order:\n{}",
        frames.join("\n---\n")
    );
    let last = frames.last().expect("a frame");
    assert!(
        !last.contains("$ build-watch"),
        "the deleted shell left the list:\n{last}"
    );
}
