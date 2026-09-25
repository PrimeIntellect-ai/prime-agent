//! The saved-catalog loading lifecycle, headless against a mock supervisor:
//! a terminal `list_saved_sessions` failure settles the entry anchor's wait
//! and reports the honest error, so an Enter after the failure opens the
//! default row instead of re-arming "Still loading sessions" behind the
//! error it already showed (the operator's stuck loading state). The fetch
//! re-arms on the next query change (TS `rearmSavedSearchFetch`).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use pa_tui::agents_view::{AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode};
use pa_tui::interactive::SessionSelection;
use serde_json::{json, Value};

/// The failure the daemon answers `list_saved_sessions` with (the honest
/// terminal error class: the scan itself refused).
const SAVED_SCAN_ERROR: &str = "the session scan failed: no such directory";

struct MockSupervisor {
    listener: UnixListener,
    /// Every recorded `list_saved_sessions` request.
    saved_requests: Arc<Mutex<Vec<Value>>>,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            saved_requests: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Serve one agents-view connection: hello, then the command loop. The
    /// roster answers one live session; the saved catalog answers the
    /// terminal failure.
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept view connection");
        stream
            .set_read_timeout(Some(std::time::Duration::from_millis(100)))
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
                    respond_failure(&mut writer, id, "list_saved_sessions", SAVED_SCAN_ERROR);
                }
                "roster_unsubscribe" => {
                    respond(&mut writer, id, "roster_unsubscribe", Value::Null);
                    return;
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

/// One line with a bounded quiet window: the view connection sits quiet
/// between its inputs (settle waits), so timeouts keep the loop alive for a
/// bounded span; `None` ends the serve loop on EOF or the quiet cap (a
/// failing test's teardown never hangs the thread).
fn read_line(reader: &mut BufReader<UnixStream>) -> Option<String> {
    const QUIET_WINDOW_MS: u32 = 60;
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
                std::thread::sleep(std::time::Duration::from_millis(50));
                line.clear();
            }
            Err(_) => return None,
        }
    }
}

/// One view options set: anchored on a session whose row can only come from
/// the saved catalog (the roster carries a different live session).
fn view_options(socket: &std::path::Path) -> AgentsViewOptions {
    AgentsViewOptions {
        socket_path: socket.to_path_buf(),
        cwd: PathBuf::from("/tmp"),
        session_dir: Some(PathBuf::from("/tmp/none-such-sessions")),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: Some("ghost-01".to_string()),
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

/// The terminal saved-catalog failure settles the entry anchor's wait: the
/// status line keeps the honest error, an Enter after the failure opens the
/// default row (never the re-armed loading hint), and the anchor never
/// wedges the view behind the error it already showed.
#[tokio::test]
async fn a_terminal_saved_catalog_failure_settles_the_anchor_wait() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let mock = MockSupervisor::bind(&socket);
    let saved_requests = Arc::clone(&mock.saved_requests);
    let server = std::thread::spawn(move || mock.serve());

    let plan = AgentsHeadlessPlan {
        steps: vec![
            // The roster snapshot and the failed catalog land inside the
            // settle window; the failure settles the anchor's wait.
            AgentsStep::WaitSettle { timeout_ms: 2000 },
            // Enter after the failure: the settled view opens the default
            // row; pre-settle it would re-arm the loading hint instead.
            AgentsStep::Key("enter".to_string()),
        ],
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

    // The saved catalog was asked for (the lifecycle's fetch really ran)
    // and answered with the terminal failure.
    {
        let requests = saved_requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            1,
            "the saved-catalog fetch ran exactly once: {requests:?}"
        );
    }
    // The honest error survived to the frames (the status line carried it).
    let frames_text: String = outcome.frames.join("\n");
    assert!(
        frames_text.contains("Saved sessions unavailable"),
        "the frames carry the honest error: {frames_text}"
    );
    assert!(
        frames_text.contains(SAVED_SCAN_ERROR),
        "the error names the scan failure: {frames_text}"
    );
    // The anchor's wait settled: the loading hint never re-armed — the
    // last frames carry the error, not the hint, and Enter opened the
    // default row instead of parking the open.
    assert!(
        !outcome
            .frames
            .last()
            .is_some_and(|frame| frame.contains("Still loading sessions")),
        "the settled view never re-arms the loading hint: {:?}",
        outcome.frames.last()
    );
    assert_eq!(
        outcome.selection,
        Some(SessionSelection::Attach("s1-live".to_string())),
        "Enter after the failure opens the default row (the settled anchor)"
    );

    // The mock served one connection; its thread ends with the run.
    let _ = server.join();
}

/// The failed fetch re-arms on the next query change (TS
/// `rearmSavedSearchFetch`): a typed query after the failure sends a SECOND
/// saved-catalog request instead of leaving the Inactive section empty
/// behind one terminal error.
#[tokio::test]
async fn a_failed_fetch_rearms_on_the_next_query_change() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let mock = MockSupervisor::bind(&socket);
    let saved_requests = Arc::clone(&mock.saved_requests);
    let server = std::thread::spawn(move || mock.serve());

    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitSettle { timeout_ms: 2000 },
            // A query change after the failure re-arms the fetch.
            AgentsStep::Type("q".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 2000 },
        ],
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

    let requests = saved_requests.lock().unwrap().clone();
    assert_eq!(
        requests.len(),
        2,
        "the query change after the failure re-armed the saved-catalog fetch: {requests:?}"
    );
    // The typed query survived into the outcome (the view state rides it).
    assert_eq!(outcome.query.as_deref(), Some("q"));
    let _ = server.join();
}
