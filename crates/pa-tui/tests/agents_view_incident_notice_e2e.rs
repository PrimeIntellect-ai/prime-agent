//! The agents-view incident notice against a mock supervisor (the TS
//! `agents-view-incident-notice.test.ts` view-level suite): the collapsed
//! warning line renders from the agent.jsonl tail, Esc dismisses it
//! without touching the armed delete confirmation, and a dismissal is
//! sticky across later polls and view re-entries (the carried state).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::time::Duration;

use pa_tui::agents_view::{AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode};
use serde_json::{json, Value};

/// Environment mutations are process-global: the
/// `PRIME_AGENT_CODING_AGENT_DIR` redirect serializes on one lock and
/// restores on exit. A tokio mutex: each test holds the guard across its
/// view-run awaits (a std guard across an await is a clippy error).
static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Take the env-serialization lock for the whole test body.
async fn env_lock() -> tokio::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().await
}

struct MockSupervisor {
    listener: UnixListener,
    /// How many view connections to serve before the serve thread ends
    /// (a run that exits without a selection closes its connection, so a
    /// multi-run test opens one connection per run).
    connections: usize,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path, connections: usize) -> Self {
        Self {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            connections,
        }
    }

    /// Serve the view connections: hello, then the command loop until EOF
    /// (the roster snapshot and an empty saved catalog), once per
    /// connection.
    fn serve(self) {
        for _ in 0..self.connections {
            let (stream, _) = self.listener.accept().expect("accept view connection");
            stream
                .set_read_timeout(Some(Duration::from_millis(100)))
                .expect("read timeout");
            let write_stream = stream.try_clone().expect("clone socket");
            let mut writer = write_stream;
            let mut reader = BufReader::new(stream);
            write_line(
                &mut writer,
                &json!({
                    "type": "daemon_hello",
                    "protocol": { "name": "prime-agent.daemon", "version": 7 },
                    "serverCapabilities": [],
                }),
            );
            while let Some(line) = read_line(&mut reader) {
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
                        respond(&mut writer, id, "list_saved_sessions", json!([]));
                    }
                    "roster_unsubscribe" => {
                        respond(&mut writer, id, "roster_unsubscribe", json!({}));
                    }
                    _ => {
                        respond_failure(
                            &mut writer,
                            id,
                            "unknown command",
                            "the mock supervisor does not serve it",
                        );
                    }
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

fn read_line(reader: &mut impl BufRead) -> Option<String> {
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(line.trim_end().to_string()),
    }
}

/// The env-mutating tests serialize on one lock (the pa-cli
/// `config::env_lock` convention).
fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Milliseconds since the Unix epoch (the notice window rides the real
/// clock; the fixture entries must be relative to it).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as i64)
}

/// ISO-8601 UTC with millisecond precision (the daemon's `ts` shape).
fn iso_ago(ago_ms: i64) -> String {
    let ms = now_ms() - ago_ms;
    let days = ms.div_euclid(86_400_000);
    let secs_of_day = ms.rem_euclid(86_400_000) / 1_000;
    let millis = ms.rem_euclid(1_000);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        secs_of_day / 3_600,
        secs_of_day / 60 % 60,
        secs_of_day % 60
    )
}

/// The supervisor's own listening line: a single start is routine and
/// must NOT produce an update-restart notice.
fn supervisor_start_line() -> String {
    json!({
        "ts": iso_ago(600_000),
        "level": "warn",
        "component": "coding-agent.daemon-supervisor",
        "msg": "Prime Agent daemon supervisor e14de15c listening on /tmp/prime-agent-501/daemon.sock",
        "socketPath": "/tmp/prime-agent-501/daemon.sock",
        "pid": 15026,
    })
    .to_string()
}

/// The worker-crash stderr forward: the notice's worker-crash line.
fn worker_crash_line() -> String {
    json!({
        "ts": iso_ago(120_000),
        "level": "warn",
        "component": "coding-agent.daemon-supervisor",
        "msg": "Session worker 5b1d3aeb91ee stderr: uncaught exception: Error: write EPIPE",
    })
    .to_string()
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
    }
}

/// The collapsed worker-crash notice line renders from the log tail, with
/// the pointer to the incident CLI (TS "renders the collapsed worker-crash
/// notice line from the log tail").
#[tokio::test]
async fn renders_the_collapsed_worker_crash_notice_line() {
    let _env = env_lock().await;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let mock = MockSupervisor::bind(&socket, 1);
    let server = std::thread::spawn(move || mock.serve());

    let agent_dir = tempfile::TempDir::new().expect("agent dir");
    let logs = agent_dir.path().join("logs");
    std::fs::create_dir_all(&logs).expect("logs dir");
    std::fs::write(
        logs.join("agent.jsonl"),
        format!("{}\n{}\n", supervisor_start_line(), worker_crash_line()),
    )
    .expect("write fixture log");
    let previous = std::env::var_os("PRIME_AGENT_CODING_AGENT_DIR");
    std::env::set_var("PRIME_AGENT_CODING_AGENT_DIR", agent_dir.path());

    let plan = AgentsHeadlessPlan {
        steps: vec![AgentsStep::WaitSettle { timeout_ms: 2_500 }],
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

    match previous {
        Some(previous) => std::env::set_var("PRIME_AGENT_CODING_AGENT_DIR", previous),
        None => std::env::remove_var("PRIME_AGENT_CODING_AGENT_DIR"),
    }

    let frames_text = outcome.frames.join("\n");
    assert!(
        frames_text.contains("worker 5b1d3aeb91ee crashed at"),
        "{frames_text}"
    );
    assert!(
        frames_text.contains("run prime-agent incident for the timeline"),
        "{frames_text}"
    );
    assert!(frames_text.contains("⚠"), "{frames_text}");
    // The notice rides under the splash, above the search prompt.
    let notice_line = frames_text
        .lines()
        .find(|line| line.contains("crashed at"))
        .expect("the notice line");
    assert!(
        notice_line.starts_with(" ⚠"),
        "the one-column gutter prefix: {notice_line:?}"
    );
    let _ = server.join();
}

/// Esc dismisses the notice with the status confirmation, and a dismissal
/// survives a later poll and the next view run's carried state (TS
/// "dismisses with Esc and never resurrects across later polls" — the
/// re-entry half exercises the flow's state carry, which the TS suite
/// asserts through `persistentState`).
#[tokio::test]
async fn dismisses_with_esc_and_the_dismissal_survives_reentry() {
    let _env = env_lock().await;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let mock = MockSupervisor::bind(&socket, 2);
    let server = std::thread::spawn(move || mock.serve());

    let agent_dir = tempfile::TempDir::new().expect("agent dir");
    let logs = agent_dir.path().join("logs");
    std::fs::create_dir_all(&logs).expect("logs dir");
    std::fs::write(
        logs.join("agent.jsonl"),
        format!("{}\n{}\n", supervisor_start_line(), worker_crash_line()),
    )
    .expect("write fixture log");
    let previous = std::env::var_os("PRIME_AGENT_CODING_AGENT_DIR");
    std::env::set_var("PRIME_AGENT_CODING_AGENT_DIR", agent_dir.path());

    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitSettle { timeout_ms: 2_500 },
            AgentsStep::Key("escape".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let run = pa_tui::agents_view::run_agents_view(
        view_options(&socket),
        AgentsViewUiMode::Headless(plan),
        None,
    )
    .await
    .expect("the agents view run");

    let outcome = run.outcome;
    let last_frame = outcome.frames.last().expect("the final frame");
    assert!(
        last_frame.contains("Incident notice dismissed"),
        "{last_frame}"
    );
    assert!(
        !last_frame.contains("prime-agent incident for the timeline"),
        "{last_frame}"
    );
    assert!(outcome.frames.iter().any(|frame| {
        frame.contains("worker 5b1d3aeb91ee crashed at")
            && frame.contains("prime-agent incident for the timeline")
    }));

    // Re-entry with the carried state: the dismissal horizon hides the
    // same incident; no poll re-reads consumed bytes into a phantom
    // restart.
    let mut options = view_options(&socket);
    options.incident_notice_state = Some(outcome.incident_notice_state);
    let plan = AgentsHeadlessPlan {
        steps: vec![AgentsStep::WaitSettle { timeout_ms: 1_500 }],
        width: 120,
        height: 36,
    };
    let second =
        pa_tui::agents_view::run_agents_view(options, AgentsViewUiMode::Headless(plan), None)
            .await
            .expect("the second agents view run")
            .outcome;

    match previous {
        Some(previous) => std::env::set_var("PRIME_AGENT_CODING_AGENT_DIR", previous),
        None => std::env::remove_var("PRIME_AGENT_CODING_AGENT_DIR"),
    }

    let frames_text = second.frames.join("\n");
    assert!(
        !frames_text.contains("prime-agent incident for the timeline"),
        "{frames_text}"
    );
    assert!(
        !frames_text.contains("daemon restarted for update"),
        "{frames_text}"
    );
    let _ = server.join();
}

/// An armed delete confirmation wins the Esc: it cancels (the take at the
/// top of `handle_key`) and the notice stays (TS "cancels an armed delete
/// confirmation with Esc instead of dismissing the notice").
#[tokio::test]
async fn esc_cancels_an_armed_delete_confirmation_and_keeps_the_notice() {
    let _env = env_lock().await;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let mock = MockSupervisor::bind(&socket, 1);
    let server = std::thread::spawn(move || mock.serve());

    let agent_dir = tempfile::TempDir::new().expect("agent dir");
    let logs = agent_dir.path().join("logs");
    std::fs::create_dir_all(&logs).expect("logs dir");
    std::fs::write(
        logs.join("agent.jsonl"),
        format!("{}\n{}\n", supervisor_start_line(), worker_crash_line()),
    )
    .expect("write fixture log");
    let previous = std::env::var_os("PRIME_AGENT_CODING_AGENT_DIR");
    std::env::set_var("PRIME_AGENT_CODING_AGENT_DIR", agent_dir.path());

    // ctrl+x arms the stop-or-delete confirm over the selected row; Esc
    // must cancel it and keep the notice, or the next ctrl+x would fire
    // without a fresh confirmation.
    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitSettle { timeout_ms: 2_500 },
            AgentsStep::Key("ctrl+x".to_string()),
            AgentsStep::Key("escape".to_string()),
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

    match previous {
        Some(previous) => std::env::set_var("PRIME_AGENT_CODING_AGENT_DIR", previous),
        None => std::env::remove_var("PRIME_AGENT_CODING_AGENT_DIR"),
    }

    // The run exited through the empty-editor Esc (the delete confirm
    // consumed the dismissal), and the notice stayed visible to the end.
    assert_eq!(outcome.selection, None);
    let last_frame = outcome.frames.last().expect("the final frame");
    assert!(
        last_frame.contains("worker 5b1d3aeb91ee crashed at"),
        "{last_frame}"
    );
    let _ = server.join();
}
