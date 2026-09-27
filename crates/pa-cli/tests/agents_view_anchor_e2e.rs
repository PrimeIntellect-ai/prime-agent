//! End-to-end verifier for the agents-view entry anchor: the agents-back
//! handoff opens the view anchored on the session just left (TS
//! `launchAgentsView`), and the entry selection lands on that session's row
//! instead of the first row — proven by Enter opening the anchor's file,
//! not the first-listed session's.
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
        // Stop by protocol so the supervisor shuts its workers down, then
        // kill the child when the protocol path fails (a failing test must
        // not leak worker processes).
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

/// One saved-session fixture: header, display name, and a user/assistant
/// exchange. Identical timestamps across fixtures make the list order fall
/// to the title tie-break, so "cron keeper" lists before "gateway worker".
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

/// The agents-back handoff reopens the view anchored on the session just
/// left: the entry selection lands on the anchor's row, so Enter opens the
/// anchor's file — not the first-listed session's.
#[tokio::test]
async fn entry_anchor_selects_the_left_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");

    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // The fixture roster: two saved sessions. Rows sort by last activity
    // (the saved file's mtime) with the title as the tie-break, so the
    // later-written cron session lists first either way: a first-row default
    // would open the cron session, and the anchor is the second-listed
    // gateway session.
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
    };
    let plan = AgentsHeadlessPlan {
        steps: vec![
            // The roster snapshot precedes streaming pushes and the saved
            // catalog lands right after open; settle before the open key.
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
    // The entry selection sat on the anchor row: Enter opens the gateway
    // session's file, not the first-listed cron session's.
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

/// The `--continue` launch's view contract (P6 continue-recent safety): the
/// CLI resolves the newest saved session for the cwd, opens the agents view
/// preselected on it, and the status line names the candidate. Enter opens
/// the candidate — the user confirms what continues, never a blind
/// newest-session resume. This is exactly the option set the CLI's
/// continue-recent flow passes (`anchor` + `notice`).
#[tokio::test]
async fn continue_recent_view_preselects_the_candidate_and_renders_the_notice() {
    let dir = tempfile::TempDir::new().expect("temp dir");

    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // Two saved sessions for the launch cwd; the second write is the newest,
    // so the continue candidate is the second one even though the first
    // would list first without the anchor (the title tie-break).
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
    };
    let plan = AgentsHeadlessPlan {
        steps: vec![
            // The saved catalog lands right after open; settle so the
            // anchor preselection applies before the open key.
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
    // Enter opened the preselected candidate, not the first-listed row.
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
