//! The heartbeat badge, headless against a mock supervisor: the open
//! fetch lands an empty catalog, the daemon's `heartbeats_changed`
//! broadcast re-reads the catalog, and the landed answer (promoted past
//! the armed render barrier, the generation gate applied) repaints the
//! row with its `◷ N` badge — the badge can only come from the
//! event-driven refetch, so the plan proves the whole wiring.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::time::Duration;

use pa_tui::agents_view::{AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode};
use serde_json::{json, Value};

struct MockSupervisor {
    listener: UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// Serve one agents-view connection: hello, then the command loop.
    /// The first `heartbeats_list` answer is empty and pushes the
    /// daemon-global `heartbeats_changed` broadcast, so the badge can
    /// only render through the event-driven refetch.
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept view connection");
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("read timeout");
        let write_stream = stream.try_clone().expect("clone socket");
        let mut writer = write_stream;
        let mut reader = BufReader::new(stream);
        let mut heartbeats_served = 0usize;
        write_line(
            &mut writer,
            &json!({
                "type": "daemon_hello",
                "protocol": { "name": "prime-agent.daemon", "version": 7 },
                "serverCapabilities": [],
            }),
        );
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
                .unwrap_or_default();
            match command_type {
                "roster_subscribe" => {
                    let roster = vec![json!({
                        "agentId": "s1",
                        "status": "idle",
                        "summary": {
                            "sessionId": "s1",
                            "lifecycle": "live",
                            "activeSessionId": "s1-live",
                            "sessionFile": "/tmp/s1.jsonl",
                            "runtimeKind": "top-level",
                            "sessionName": "live one",
                            "messageCount": 2,
                            "rlmDepth": 0,
                        },
                    })];
                    if !respond(
                        &mut writer,
                        id,
                        "roster_subscribe",
                        &json!({ "roster": roster }),
                    ) {
                        return;
                    }
                }
                "list_saved_sessions" => {
                    if !respond(
                        &mut writer,
                        id,
                        "list_saved_sessions",
                        &json!({ "sessions": [] }),
                    ) {
                        return;
                    }
                }
                "heartbeats_list" => {
                    heartbeats_served += 1;
                    if !respond(
                        &mut writer,
                        id,
                        "heartbeats_list",
                        &heartbeat_answer(heartbeats_served),
                    ) {
                        return;
                    }
                    if heartbeats_served == 1 {
                        let changed = json!({ "type": "heartbeats_changed" });
                        if !write_line(&mut writer, &changed) {
                            return;
                        }
                    }
                }
                "roster_unsubscribe" => {
                    // The view's teardown fires the unsubscribe
                    // fire-and-forget; the answer ends the mock's one
                    // connection so the test's join never rides out the
                    // quiet cap.
                    let _ = respond(&mut writer, id, "roster_unsubscribe", &Value::Null);
                    return;
                }
                other => {
                    if !respond_failure(&mut writer, id, other, "not handled by the mock") {
                        return;
                    }
                }
            }
        }
    }
}

/// One best-effort line write: `false` reports the view connection died,
/// so the serve loop ends instead of panicking inside the test thread.
fn write_line(writer: &mut UnixStream, value: &Value) -> bool {
    let Ok(mut line) = serde_json::to_string(value) else {
        return false;
    };
    line.push('\n');
    writer.write_all(line.as_bytes()).is_ok() && writer.flush().is_ok()
}

/// The first `heartbeats_list` answer is an empty catalog; the next
/// carries the roster session's own heartbeat.
fn heartbeat_answer(heartbeats_served: usize) -> Value {
    if heartbeats_served == 1 {
        json!({ "heartbeats": [] })
    } else {
        json!({ "heartbeats": [json!({
            "job": {
                "id": "hb-1",
                "status": "active",
                "source": "heartbeat",
                "activeSessionId": "s1-live",
                "sessionId": "s1",
                "schedule": { "expression": "every 30m" },
            },
        })]})
    }
}

fn respond(writer: &mut UnixStream, id: &str, command: &str, data: &Value) -> bool {
    write_line(
        writer,
        &json!({
            "id": id,
            "type": "response",
            "command": command,
            "success": true,
            "data": data,
        }),
    )
}

fn respond_failure(writer: &mut UnixStream, id: &str, command: &str, error: &str) -> bool {
    write_line(
        writer,
        &json!({
            "id": id,
            "type": "response",
            "command": command,
            "success": false,
            "error": error,
        }),
    )
}

/// One line with a bounded quiet window: the view connection sits quiet
/// between its inputs, so timeouts keep the loop alive for a bounded
/// span; `None` ends the serve loop on EOF or the quiet cap.
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

/// One view options set.
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

/// The badge renders through the whole wiring: the open fetch lands an
/// empty catalog, the daemon's `heartbeats_changed` broadcast re-reads
/// the catalog (the only path the row's job arrives on), the landed
/// answer jumps the armed render barrier (without the daemon-answer
/// promotion it queues behind the hold it satisfies, the deadline pops
/// it, and `Done` ends the run before the badge ever paints), and the
/// row renders the dock's `◷ N` vocabulary between its status icon and
/// its title.
#[tokio::test]
async fn the_row_renders_its_heartbeat_count_after_a_heartbeats_changed() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let mock = MockSupervisor::bind(&socket);
    let server = std::thread::spawn(move || mock.serve());

    let plan = AgentsHeadlessPlan {
        steps: vec![AgentsStep::WaitRender {
            needle: "\u{25f7} 1".to_string(),
            timeout_ms: 10_000,
        }],
        width: 120,
        height: 36,
    };
    let outcome = pa_tui::agents_view::run_agents_view(
        view_options(&socket),
        AgentsViewUiMode::Headless(plan),
        None,
    )
    .await
    .expect("the agents view run")
    .outcome;

    assert!(
        outcome
            .frames
            .last()
            .is_some_and(|frame| frame.contains("\u{2022} \u{25f7} 1 live one")),
        "the run ended on the badge-rendered row:\n{:?}",
        outcome.frames.last()
    );

    // Yield to the runtime so the teardown's fire-and-forget
    // roster_unsubscribe runs: the mock answers it and ends, so the
    // join never rides out its quiet cap.
    tokio::time::sleep(Duration::from_millis(250)).await;
    let _ = server.join();
}
