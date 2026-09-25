//! The saved-catalog lifecycle against a mock supervisor: a SUCCESSFUL
//! load that still does not carry the entry anchor's row settles the
//! wait (TS `resolveMissingSelectionAnchor`'s finally arm — the hint must
//! never re-arm on every open behind a catalog that already settled), and
//! the flow's carried catalog paints the next view run's first frame with
//! no re-fetch (TS `AgentsViewPersistentState.savedSessions` +
//! `armSavedSearchFetch`'s early return — the Inactive section never
//! rebuilds from empty on a chat handoff).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pa_tui::agents_view::{AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode};
use pa_tui::interactive::SessionSelection;
use serde_json::{json, Value};

/// The mock's answer lag: the catalog request is held long enough that a
/// keyed step lands while the load is still in flight (the pre-load Enter
/// that arms the loading hint).
const CATALOG_ANSWER_DELAY_MS: u64 = 400;

struct MockSupervisor {
    listener: UnixListener,
    /// Every recorded `list_saved_sessions` request (the carry test's
    /// no-refetch assertion reads it across BOTH view runs).
    saved_requests: Arc<Mutex<Vec<Value>>>,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            saved_requests: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Serve the agents-view connections (the carry test hands the SAME
    /// connection back, so one serve loop answers both view runs): hello,
    /// then the command loop until EOF. `roster_unsubscribe` only answers
    /// — the handoff's fire-and-forget unsubscribe must not end the
    /// connection the link keeps for the flow's next view run.
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
                    respond(
                        &mut writer,
                        id,
                        "roster_subscribe",
                        json!({ "roster": roster }),
                    );
                }
                "list_saved_sessions" => {
                    self.saved_requests.lock().unwrap().push(command.clone());
                    std::thread::sleep(Duration::from_millis(CATALOG_ANSWER_DELAY_MS));
                    // The streamed rows (newest first, the anchor's row
                    // first at the daemon's real scan), then the terminal
                    // response — the same wire the daemon sends.
                    for row in saved_catalog() {
                        write_line(
                            &mut writer,
                            &json!({
                                "id": id,
                                "type": "session_list_item",
                                "command": "list_saved_sessions",
                                "session": row,
                            }),
                        );
                    }
                    respond(
                        &mut writer,
                        id,
                        "list_saved_sessions",
                        json!({ "sessions": saved_catalog() }),
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

/// The mock's saved catalog (TS `serializeSavedSessionInfo`'s shape): two
/// rows the roster does not carry, so the Inactive section is entirely
/// catalog-fed.
fn saved_catalog() -> Vec<Value> {
    vec![
        saved_catalog_row("/tmp/sessions/s2.jsonl", "s2", "carried alpha"),
        saved_catalog_row("/tmp/sessions/s3.jsonl", "s3", "carried beta"),
    ]
}

fn saved_catalog_row(path: &str, id: &str, name: &str) -> Value {
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

/// One line with a bounded quiet window (the view connection sits quiet
/// between its inputs, so timeouts keep the loop alive for a bounded
/// span); `None` ends the serve loop on EOF or the quiet cap.
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

/// One view options set: `anchor` seeds the entry anchor (a session whose
/// row can only come from the saved catalog).
fn view_options(socket: &std::path::Path, anchor: Option<&str>) -> AgentsViewOptions {
    AgentsViewOptions {
        socket_path: socket.to_path_buf(),
        cwd: PathBuf::from("/tmp"),
        session_dir: Some(PathBuf::from("/tmp/sessions")),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: anchor.map(str::to_string),
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

/// A SUCCESSFUL catalog load that still does not carry the anchor's row
/// settles the entry anchor's wait (TS `resolveMissingSelectionAnchor`'s
/// finally arm): the Enter DURING the wait arms the loading hint, the load
/// lands without the row, the settle retires the hint, and the Enter after
/// the load opens the default row instead of re-arming "Still loading
/// sessions" forever behind a catalog that already settled.
#[tokio::test]
async fn a_successful_load_settles_the_anchor_wait_when_the_row_is_missing() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let mock = MockSupervisor::bind(&socket);
    let saved_requests = Arc::clone(&mock.saved_requests);
    let server = std::thread::spawn(move || mock.serve());

    let plan = AgentsHeadlessPlan {
        steps: vec![
            // Enter while the catalog is still loading (the mock holds its
            // answer for CATALOG_ANSWER_DELAY_MS): the wait arms the hint.
            AgentsStep::Key("enter".to_string()),
            // The load lands inside this window without the anchor's row;
            // the settle retires the hint with it.
            AgentsStep::WaitSettle { timeout_ms: 2500 },
            // Enter after the settled load: the default row opens —
            // pre-fix this Enter re-armed the loading hint instead.
            AgentsStep::Key("enter".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let outcome = pa_tui::agents_view::run_agents_view(
        view_options(&socket, Some("ghost-01")),
        AgentsViewUiMode::Headless(plan),
        None,
    )
    .await
    .expect("the agents view run")
    .outcome;

    {
        let requests = saved_requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            1,
            "the saved-catalog fetch ran exactly once: {requests:?}"
        );
    }
    assert_eq!(
        outcome.selection,
        Some(SessionSelection::Attach("s1-live".to_string())),
        "the Enter after the settled load opens the default row"
    );
    let frames_text = outcome.frames.join("\n");
    assert!(
        frames_text.contains("Still loading sessions"),
        "the pre-load Enter armed the loading hint once: {frames_text}"
    );
    assert!(
        !outcome
            .frames
            .last()
            .is_some_and(|frame| frame.contains("Still loading sessions")),
        "the settled load retired the loading hint: {:?}",
        outcome.frames.last()
    );

    let _ = server.join();
}

/// The flow's carried catalog (TS `persistentState.savedSessions` +
/// `savedCatalogLoaded`): a view run that hands its link back loads the
/// catalog once, and the flow's NEXT view run paints the Inactive rows on
/// its FIRST frame with no second fetch — the handoff never rebuilds the
/// section from empty behind a re-scan.
#[tokio::test]
async fn the_carried_catalog_paints_the_first_frame_and_skips_the_refetch() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let mock = MockSupervisor::bind(&socket);
    let saved_requests = Arc::clone(&mock.saved_requests);
    let server = std::thread::spawn(move || mock.serve());

    // Run 1: the catalog loads and the anchor (a saved row) opens — the
    // run ends with a selection, so the link hands back to the flow.
    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitSettle { timeout_ms: 2500 },
            AgentsStep::Key("enter".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let run = pa_tui::agents_view::run_agents_view(
        view_options(&socket, Some("s2")),
        AgentsViewUiMode::Headless(plan),
        None,
    )
    .await
    .expect("the first agents view run");
    assert_eq!(
        run.outcome.selection,
        Some(SessionSelection::Resume(PathBuf::from(
            "/tmp/sessions/s2.jsonl"
        ))),
        "the anchored saved row opened: {:?}",
        run.outcome.selection
    );
    let link = run
        .link
        .expect("the opening run hands its roster link back to the flow");

    // Run 2 (the chat handoff's re-entry): the SAME link, and the carried
    // catalog paints on the first frame with no second fetch.
    let plan = AgentsHeadlessPlan {
        steps: vec![AgentsStep::WaitSettle { timeout_ms: 600 }],
        width: 120,
        height: 36,
    };
    let run_two = pa_tui::agents_view::run_agents_view(
        view_options(&socket, None),
        AgentsViewUiMode::Headless(plan),
        Some(link),
    )
    .await
    .expect("the second agents view run");

    {
        let requests = saved_requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            1,
            "the loaded catalog never re-fetches on the handoff: {requests:?}"
        );
    }
    let first = run_two.outcome.frames.first().cloned().unwrap_or_default();
    assert!(
        first.contains("carried alpha"),
        "the carried catalog paints the Inactive rows on the FIRST frame:\n{first}"
    );
    assert!(
        first.contains("carried beta"),
        "the whole carried section paints, not just the anchor:\n{first}"
    );

    let _ = server.join();
}
