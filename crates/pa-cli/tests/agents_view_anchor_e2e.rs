// large_futures: stack futures on hot paths by design. too_many_lines:
// style gate only. Casts: 64-bit targets; narrowing sits at bounded
// OS/protocol boundaries.
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! End-to-end verifier for the agents-view entry anchor: the agents-back
//! handoff opens the view anchored on the session just left (TS
//! `launchAgentsView`), and Enter opens the anchor's file, not the
//! first-listed session's.
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_tui::agents_view::{AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode};
use pa_tui::interactive::SessionSelection;

struct Supervisor {
    child: Child,
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        // Stop by protocol so the supervisor shuts its workers down; kill the
        // child when it fails (a failing test must not leak workers).
        graceful_shutdown(&self.socket);
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// Stop the daemon on `socket` by protocol; kill the child when it fails.
fn graceful_shutdown(socket: &Path) {
    let Ok(stream) = UnixStream::connect(socket) else {
        return;
    };
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;
    let mut hello = String::new();
    let _ = reader.read_line(&mut hello); // daemon_hello
    let command = serde_json::json!({
        "type": "command",
        "id": "test-shutdown",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "command": { "type": "shutdown" },
    });
    let Ok(mut line) = serde_json::to_string(&command) else {
        return;
    };
    line.push('\n');
    let _ = writer.write_all(line.as_bytes());
    let _ = writer.flush();
    let _ = reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(5)));
    let mut response = String::new();
    let _ = reader.read_line(&mut response);
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(dir: &Path) -> Supervisor {
    let socket = dir.join("daemon.sock");
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(&socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for var in [
        pa_daemon::worker::WORKER_ROLE_ENV,
        pa_daemon::worker::WORKER_TOKEN_ENV,
        pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
        pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV,
        pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
        pa_daemon::worker::WORKER_SOCKET_ENV,
        pa_daemon::worker::WORKER_INSTANCE_ID_ENV,
        pa_daemon::worker::WORKER_SCRIPT_ENV,
    ] {
        command.env_remove(var);
    }
    command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    let child = command.spawn().expect("spawn prime-agent --mode daemon");
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if socket.exists() {
            return Supervisor { child, socket };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

/// One saved-session fixture: header, display name, and an exchange.
/// Identical timestamps make the list order fall to the title tie-break.
fn write_fixture(dir: &Path, id: &str, name: &str, turns: &[(&str, &str)]) -> PathBuf {
    let path = dir.join(format!("{id}.jsonl"));
    let mut content = format!(
        "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\"}}\n"
    );
    let _ = writeln!(content,
        "{{\"type\":\"session_info\",\"id\":\"{id}-info\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"name\":\"{name}\"}}"
    );
    for (index, (user, assistant)) in turns.iter().enumerate() {
        let _ = writeln!(content,
            "{{\"type\":\"message\",\"id\":\"{id}-m{index}u\",\"timestamp\":\"2024-01-01T00:00:0{index}.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"{user}\",\"timestamp\":{}}}}}",
            index * 1000
        );
        let _ = writeln!(content,
            "{{\"type\":\"message\",\"id\":\"{id}-m{index}a\",\"timestamp\":\"2024-01-01T00:00:0{index}.000Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{assistant}\"}}],\"timestamp\":{}}}}}",
            index * 1000 + 1
        );
    }
    std::fs::write(&path, content).expect("write fixture");
    path
}

/// Enter opens the anchor's file, not the first-listed session's.
#[tokio::test]
async fn entry_anchor_selects_the_left_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");

    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // The fixture roster: rows sort by last activity (mtime), so the cron session
    // lists first — the anchor is the second-listed gateway session.
    let gateway_path = write_fixture(
        &session_dir,
        "gateway-01",
        "gateway worker",
        &[("deploy the gateway", "gateway deployed")],
    );
    let cron_path = write_fixture(
        &session_dir,
        "cron-01",
        "cron keeper",
        &[("audit the cron jobs", "cron audit clean")],
    );

    let options = AgentsViewOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: Some("gateway-01".to_string()),
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
    };
    let plan = AgentsHeadlessPlan {
        steps: vec![
            // The roster snapshot precedes streaming pushes and the saved catalog lands right after
            // open; settle before the open key.
            AgentsStep::WaitSettle { timeout_ms: 1000 },
            AgentsStep::Key("enter".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::agents_view::run_agents_view(options, AgentsViewUiMode::Headless(plan), None)
            .await
            .expect("agents view run")
            .outcome;
    assert!(!outcome.frames.is_empty(), "frames were captured");
    // Enter opened the anchor's file, not the first-listed cron session's.
    assert_eq!(
        outcome.selection,
        Some(SessionSelection::Resume(gateway_path.clone())),
        "the anchor row, not the first row, opens"
    );
    assert_ne!(
        outcome.selection,
        Some(SessionSelection::Resume(cron_path.clone())),
        "the first row is not the opened one"
    );
}

/// The `--continue` launch's view contract (P6 continue-recent safety): preselect the
/// newest saved session; Enter opens the candidate — the user confirms.
#[tokio::test]
async fn continue_recent_view_preselects_the_candidate_and_renders_the_notice() {
    let dir = tempfile::TempDir::new().expect("temp dir");

    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // Two saved sessions for the launch cwd; the second write is the newest, so
    // the continue candidate is the second one even though the first would list first.
    let older_path = write_fixture(
        &session_dir,
        "aaaa-candidate",
        "alpha session",
        &[("first turn", "first reply")],
    );
    let candidate_path = write_fixture(
        &session_dir,
        "bbbb-candidate",
        "beta session",
        &[("second turn", "second reply")],
    );
    // The newest file strictly newer (same-mtime granularity guard).
    let future = std::time::SystemTime::now() + std::time::Duration::from_mins(1);
    let handle = std::fs::File::options()
        .append(true)
        .open(&candidate_path)
        .expect("open candidate");
    handle.set_modified(future).expect("nudge mtime");

    let notice = format!(
        "Most recent session for this directory: {} — Enter continues it, or pick another session.",
        "bbbb-candidate"
    );
    let options = AgentsViewOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: Some("bbbb-candidate".to_string()),
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: Some(notice.clone()),
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: serde_json::json!({}),
    };
    let plan = AgentsHeadlessPlan {
        steps: vec![
            // The saved catalog lands right after open; settle so the anchor preselection applies
            // before the open key.
            AgentsStep::WaitSettle { timeout_ms: 1000 },
            AgentsStep::Key("enter".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::agents_view::run_agents_view(options, AgentsViewUiMode::Headless(plan), None)
            .await
            .expect("agents view run")
            .outcome;
    assert!(!outcome.frames.is_empty(), "frames were captured");
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("Most recent session for this directory: bbbb-candidate"),
        "the continue notice rendered in the status line:\n{rendered}"
    );
    assert_eq!(
        outcome.selection,
        Some(SessionSelection::Resume(candidate_path.clone())),
        "the continue candidate opened"
    );
    assert_ne!(
        outcome.selection,
        Some(SessionSelection::Resume(older_path.clone())),
        "the first-listed row did not open"
    );
    drop(supervisor);
}

/// Through the real daemon (`rename_saved_session` wire path, which a unit test cannot
/// exercise): the row renames in place, the file gains the name.
#[tokio::test]
async fn rename_saved_session_renames_the_row_and_the_file() {
    let dir = tempfile::TempDir::new().expect("temp dir");

    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let path = write_fixture(
        &session_dir,
        "ren-01",
        "gateway worker",
        &[("rename me", "renamed by the daemon")],
    );

    let options = AgentsViewOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: Some("ren-01".to_string()),
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
    };
    let plan = AgentsHeadlessPlan {
        steps: vec![
            // The saved catalog lands right after open; settle so the fixture's row is selectable
            // before the rename key.
            AgentsStep::WaitSettle { timeout_ms: 1000 },
            AgentsStep::Key("ctrl+r".to_string()),
            AgentsStep::Key("ctrl+u".to_string()),
            AgentsStep::Type("renamed agent".to_string()),
            AgentsStep::Key("enter".to_string()),
            AgentsStep::WaitRender {
                needle: "Renamed to renamed agent".to_string(),
                timeout_ms: 10_000,
            },
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::agents_view::run_agents_view(options, AgentsViewUiMode::Headless(plan), None)
            .await
            .expect("agents view run")
            .outcome;
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("Renamed to renamed agent"),
        "the rename's TS status row rendered:\n{rendered}"
    );
    assert!(
        outcome
            .frames
            .last()
            .is_some_and(|frame| frame.contains("renamed agent")),
        "the final frame lists the new name:\n{rendered}"
    );
    // The old name left the row: the catalog loads once, never refetched, so
    // this pins the in-place saved-row patch in `rename_result`.
    assert!(
        outcome
            .frames
            .last()
            .is_some_and(|frame| !frame.contains("gateway worker")),
        "the final frame dropped the old name:\n{rendered}"
    );
    let content = std::fs::read_to_string(&path).expect("read fixture");
    assert!(
        content.contains("\"name\":\"renamed agent\""),
        "the fixture gained the session_info name entry:\n{content}"
    );
    drop(supervisor);
}
