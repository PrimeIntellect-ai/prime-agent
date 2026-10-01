//! The headless plan's render barrier (`AgentsStep::WaitRender`),
//! headless against a mock supervisor: the barrier holds the queued
//! plan batch until a frame rendered after arming carries the
//! daemon-driven row (the saved catalog's landing), and its deadline
//! pops the hold so a needle that never lands still ends the plan
//! honestly — the registered render/data-arrival race
//! (red-agentsview-search-ranked-hits-20260926-1) closes by
//! construction: the plan cannot reach `Done` before the data rendered,
//! where the retired wall-clock settle only won on an idle machine (the
//! mock's 2s answer lag outlives any 300ms budget deterministically).
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
use std::time::{Duration, Instant};

use pa_tui::agents_view::{AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode};
use pa_tui::interactive::SessionSelection;
use serde_json::{json, Value};

/// The mock's answer lag: longer than the retired budget-settle
/// ordering's whole window, so a plan gated on the old 300ms settle
/// deterministically ends before the catalog lands (the red the barrier
/// removes: `Done` fires while the frame is still the pre-arrival
/// "No sessions match" state).
const CATALOG_ANSWER_DELAY_MS: u64 = 2000;

/// How the mock answers `list_saved_sessions`.
enum CatalogAnswer {
    /// Hold the answer for `CATALOG_ANSWER_DELAY_MS`, then land the two
    /// catalog rows as the terminal response (no streamed frames: the
    /// response alone drives the row model — the wire shape a fast scan
    /// takes, and the exact path that queues behind an armed barrier).
    Lagged,
    /// Record the request and never answer: the needle that never lands
    /// (the deadline test's honest stall).
    Never,
}

struct MockSupervisor {
    listener: UnixListener,
    answer: CatalogAnswer,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path, answer: CatalogAnswer) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            answer,
        }
    }

    /// Serve one agents-view connection: hello, then the command loop.
    /// The roster answers one live idle session; the saved catalog
    /// answers per `answer`.
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
        if !write_line(&mut writer, &hello) {
            return;
        }
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
                "list_saved_sessions" => match self.answer {
                    CatalogAnswer::Lagged => {
                        std::thread::sleep(Duration::from_millis(CATALOG_ANSWER_DELAY_MS));
                        if !respond(
                            &mut writer,
                            id,
                            "list_saved_sessions",
                            &json!({ "sessions": saved_catalog() }),
                        ) {
                            return;
                        }
                    }
                    // The never-answered catalog: the request was heard,
                    // the needle never lands.
                    CatalogAnswer::Never => {}
                },
                "roster_unsubscribe" => {
                    // The view's teardown fires the unsubscribe
                    // fire-and-forget (selection handoff included); the
                    // answer ends the mock's one connection so the test's
                    // join never rides out the quiet cap.
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

/// The mock's saved catalog: two rows the roster does not carry, so the
/// Inactive section is entirely catalog-fed.
fn saved_catalog() -> Vec<Value> {
    vec![
        saved_catalog_row("/tmp/sessions/s2.jsonl", "s2", "carried one"),
        saved_catalog_row("/tmp/sessions/s3.jsonl", "s3", "carried two"),
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

/// One best-effort line write: `false` reports the view connection died
/// (the run's teardown closes it under the mock's own answer lag), so
/// the serve loop ends instead of panicking inside the test thread.
fn write_line(writer: &mut UnixStream, value: &Value) -> bool {
    let Ok(mut line) = serde_json::to_string(value) else {
        return false;
    };
    line.push('\n');
    writer.write_all(line.as_bytes()).is_ok() && writer.flush().is_ok()
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
/// between its inputs (settle waits), so timeouts keep the loop alive
/// for a bounded span; `None` ends the serve loop on EOF or the quiet
/// cap (a failing test's teardown never hangs the thread).
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

/// The barrier holds the queued plan batch until a frame rendered after
/// arming carries the daemon-driven row: the mock's 2s catalog answer
/// lands long after the barrier armed, so the Enter queued behind it
/// can only execute against the LOADED row model — the selection proves
/// the hold ordered the plan after the data. The retired
/// budget-settle ordering (a 300ms wall-clock window) reds here
/// deterministically: `Done` ends the run before the 2s answer lands,
/// the final frame is the pre-arrival "No sessions match" state, and
/// the Enter opens nothing.
#[tokio::test]
async fn the_render_barrier_holds_until_the_catalog_row_renders() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let mock = MockSupervisor::bind(&socket, CatalogAnswer::Lagged);
    let server = std::thread::spawn(move || mock.serve());

    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::Type("carried".to_string()),
            AgentsStep::WaitRender {
                needle: "carried one".to_string(),
                timeout_ms: 10_000,
            },
            // The Enter rides BEHIND the barrier: pre-arrival it opens
            // nothing (the query hides the roster's live row), post-
            // arrival it opens the catalog's ranked hit.
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

    assert!(
        outcome
            .frames
            .last()
            .is_some_and(|frame| frame.contains("carried one")),
        "the run ended on the arrived-catalog frame, never a pre-arrival one:\n{:?}",
        outcome.frames.last()
    );
    assert_eq!(
        outcome.selection,
        Some(SessionSelection::Resume(PathBuf::from(
            "/tmp/sessions/s2.jsonl"
        ))),
        "the Enter behind the barrier opened the catalog's ranked hit"
    );

    // Yield to the runtime so the teardown's fire-and-forget
    // roster_unsubscribe runs (a current-thread test runtime never
    // polls it while the join blocks): the mock answers it and ends,
    // so the join never rides out its quiet cap.
    tokio::time::sleep(Duration::from_millis(250)).await;
    let _ = server.join();
}

/// The barrier's deadline pops the hold and the plan proceeds honestly:
/// the needle the mock never renders ends the wait at its own bound
/// (never a wedge waiting on events that do not come — the deadline's
/// select arm wakes the loop without any), the status line reports the
/// wait that never satisfied, and the steps behind the barrier still
/// run.
#[tokio::test]
async fn the_barrier_deadline_pops_the_hold_and_the_plan_proceeds() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let mock = MockSupervisor::bind(&socket, CatalogAnswer::Never);
    let server = std::thread::spawn(move || mock.serve());

    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitRender {
                needle: "carried one".to_string(),
                timeout_ms: 500,
            },
            // The settle window paints the pop's status note before the
            // Enter opens the row.
            AgentsStep::WaitSettle { timeout_ms: 300 },
            AgentsStep::Key("enter".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let started = Instant::now();
    let outcome = pa_tui::agents_view::run_agents_view(
        view_options(&socket),
        AgentsViewUiMode::Headless(plan),
        None,
    )
    .await
    .expect("the agents view run")
    .outcome;

    // The hold popped at its deadline, not at the incident poll's 30s
    // arm: the plan proceeds in bounded time (the deadline is the only
    // wake that fires here — the catalog never answers, the roster
    // already did, and no running row pulses).
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the deadline popped the hold in bounded time: {:?}",
        started.elapsed()
    );
    let frames_text = outcome.frames.join("\n");
    assert!(
        frames_text.contains("timed out waiting for the headless render condition"),
        "the deadline's pop reports the wait that never satisfied: {frames_text}"
    );
    assert!(
        !frames_text.contains("carried one"),
        "the never-landing needle never renders: {frames_text}"
    );
    assert_eq!(
        outcome.selection,
        Some(SessionSelection::Attach("s1-live".to_string())),
        "the plan proceeded past the popped hold: the Enter opened the roster's default row"
    );

    // The join never rides the quiet cap (the teardown's fire-and-forget
    // unsubscribe runs on this yield and ends the mock).
    tokio::time::sleep(Duration::from_millis(250)).await;
    let _ = server.join();
}
