//! Headless e2e for the agents view's machine-wide persistent shells against a mock daemon: the
//! kill commands a stop sends from the orphans' Bash list and from Ctrl+X on a `Persistent shells`
//! row, and a late kill failure staying on its own shell.
#![cfg(unix)]

mod support;

use std::io::BufReader;
use std::os::unix::net::UnixListener;
use std::time::Duration;

use pa_tui::agents_view::{
    run_agents_view, AgentsHeadlessPlan, AgentsStep, AgentsViewOutcome, AgentsViewUiMode,
};
use serde_json::{json, Value};

use support::{read_line, respond, respond_failure, view_options, write_json};

// Headless mouse tracking is process-global; all plans in this binary serialize.
static RUN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn shell(id: &str, command: &str, session_id: &str, status: &str) -> Value {
    json!({ "id": id, "command": command, "pid": 4242, "startedAt": "2026-01-01T00:00:00+00:00",
            "durationMs": 12_400, "status": status, "persistent": true, "sessionId": session_id })
}

/// Serves the roster (one live session, `release prep`), an empty saved catalog, and three shells:
/// `build-watch` assigned to the live session, the orphans `long-job` and `orphan-watch` to deleted
/// ones. A kill finishes the shell in later lists (`long-job`'s kill fails late, delivered with
/// `orphan-watch`'s next output read); returns the killed shell ids.
fn serve(listener: &UnixListener) -> Vec<String> {
    let (stream, _) = listener.accept().expect("accept view connection");
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .expect("read timeout");
    let mut writer = stream.try_clone().expect("clone socket");
    let mut reader = BufReader::new(stream);
    write_json(
        &mut writer,
        &json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": ["persistent_shells"],
        }),
    );
    let mut killed = Vec::new();
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
                let status = |id: &str| {
                    if killed.iter().any(|killed| killed == id) {
                        "finished"
                    } else {
                        "running"
                    }
                };
                json!({ "activities": [
                    shell("b", "build-watch", "p", status("b")),
                    shell("l", "long-job", "gone", status("l")),
                    shell("o", "orphan-watch", "gone-too", status("o")),
                ] })
            }
            "tail_persistent_shell" => {
                // Deliver the old shell's error only once another shell's
                // pane has opened and requested its output.
                if command["shellId"] == "o" {
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
            "roster_unsubscribe" => Value::Null,
            other => {
                respond_failure(&mut writer, id, other, "not handled by the mock");
                continue;
            }
        };
        respond(&mut writer, id, command_type, &data);
    }
}

/// Run one headless plan against the mock; returns the outcome and the killed shell ids.
async fn run_plan(steps: Vec<AgentsStep>) -> (AgentsViewOutcome, Vec<String>) {
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
    (outcome, server.join().expect("mock"))
}

fn wait_render(needle: &str) -> AgentsStep {
    AgentsStep::WaitRender {
        needle: needle.to_string(),
        timeout_ms: 8000,
    }
}

#[tokio::test]
async fn enter_on_an_orphan_lists_the_orphans_and_stops_one() {
    let (outcome, killed) = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        wait_render("$ orphan-watch"),
        AgentsStep::Key("home".to_string()),
        AgentsStep::Key("down".to_string()),
        AgentsStep::Key("down".to_string()),
        AgentsStep::Key("enter".to_string()),
        wait_render("Session deleted"),
        AgentsStep::Key("enter".to_string()),
        wait_render("watching..."),
        AgentsStep::Key("enter".to_string()),
        wait_render("\u{25cb} finished"),
        AgentsStep::Key("left".to_string()),
        wait_render("1 running"),
        AgentsStep::Key("escape".to_string()),
        wait_render("Persistent shells (2)"),
    ])
    .await;

    assert_eq!(killed, ["o"], "the stop named the Entered orphan");
    let last = outcome.frames.last().expect("a frame");
    assert!(
        !last.contains("$ orphan-watch") && last.contains("$ long-job"),
        "the stopped orphan left the list:\n{last}"
    );
}

#[tokio::test]
async fn a_late_kill_failure_does_not_move_to_another_shell_pane() {
    let (outcome, _) = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        wait_render("$ orphan-watch"),
        AgentsStep::Key("home".to_string()),
        AgentsStep::Key("down".to_string()),
        AgentsStep::Key("enter".to_string()),
        wait_render("Session deleted"),
        AgentsStep::Key("enter".to_string()),
        wait_render("watching..."),
        AgentsStep::Key("enter".to_string()),
        AgentsStep::Key("left".to_string()),
        AgentsStep::Key("down".to_string()),
        AgentsStep::Key("enter".to_string()),
        wait_render("watching..."),
    ])
    .await;
    let frames = &outcome.frames;
    assert!(frames
        .last()
        .expect("shell o frame")
        .contains("orphan-watch"));
    assert!(
        !frames
            .iter()
            .any(|frame| frame.contains("old shell kill failed")),
        "shell l's failure must not appear on shell o"
    );
}

#[tokio::test]
async fn ctrl_x_on_a_shell_row_stops_it_and_its_finished_row_leaves_the_list() {
    let (outcome, killed) = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        wait_render("$ orphan-watch"),
        AgentsStep::Key("home".to_string()),
        wait_render("open   Ctrl+X stop"),
        AgentsStep::Key("ctrl+x".to_string()),
        wait_render("Press Ctrl+X again to stop"),
        AgentsStep::Key("ctrl+x".to_string()),
        wait_render("Persistent shells (2)"),
    ])
    .await;

    assert_eq!(killed, ["b"], "the stop named the selected shell");
    let last = outcome.frames.last().expect("a frame");
    assert!(
        last.contains("Stopped build-watch") && !last.contains("$ build-watch"),
        "the stopped shell left the list:\n{last}"
    );
}

/// A session opened from its shell row returns onto that row: the handoff carries the shells list,
/// so the returning view's first frame already lists the shell the selection restores onto.
#[tokio::test]
async fn a_return_from_a_shells_session_restores_the_shell_row() {
    let _guard = RUN_LOCK.lock().await;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let listener = UnixListener::bind(&socket).expect("bind mock socket");
    let _server = std::thread::spawn(move || serve(&listener));
    let plan = |steps| {
        AgentsViewUiMode::Headless(AgentsHeadlessPlan {
            steps,
            width: 100,
            height: 30,
        })
    };
    let first = Box::pin(run_agents_view(
        view_options(&socket),
        plan(vec![
            AgentsStep::WaitSettle { timeout_ms: 2500 },
            wait_render("$ orphan-watch"),
            AgentsStep::Key("home".to_string()),
            AgentsStep::Key("enter".to_string()),
        ]),
        None,
    ))
    .await
    .expect("the first view opens the shell's session");
    assert_eq!(
        first.outcome.selected_row_identity.as_deref(),
        Some("shell:b")
    );
    let mut options = view_options(&socket);
    options.selected_row_identity = first.outcome.selected_row_identity.clone();
    options.selected_key = first.outcome.selected_key.clone();
    let second = Box::pin(run_agents_view(
        options,
        plan(vec![AgentsStep::Key("enter".to_string())]),
        first.link,
    ))
    .await
    .expect("the returning view")
    .outcome;
    let first_frame = second.frames.first().expect("a first frame");
    assert!(first_frame.contains("$ build-watch"), "{first_frame}");
    assert_eq!(
        second.selected_row_identity.as_deref(),
        Some("shell:b"),
        "Enter reopened the shell row the return restored"
    );
}
