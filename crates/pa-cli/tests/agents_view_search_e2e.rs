//! End-to-end verifier for the agents-view session search: a fixture
//! roster (saved-catalog sessions on disk, one archived out of the catalog)
//! behind a real supervisor, with the headless agents-view plan typing
//! queries, asserting the roster narrows (name, first-message fuzzy, and
//! full-transcript matches), that Escape clears the filter and restores the
//! roster, and that Enter opens the filtered match.
#![cfg(unix)]

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
    if writer.write_all(line.as_bytes()).is_err() {
        return;
    }
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
/// exchange whose texts feed the name/first-message/transcript search.
fn write_fixture(dir: &Path, id: &str, name: &str, turns: &[(&str, &str)]) -> PathBuf {
    let path = dir.join(format!("{id}.jsonl"));
    let mut content = format!(
        "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\"}}\n"
    );
    content.push_str(&format!(
        "{{\"type\":\"session_info\",\"id\":\"{id}-info\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"name\":\"{name}\"}}\n"
    ));
    for (index, (user, assistant)) in turns.iter().enumerate() {
        content.push_str(&format!(
            "{{\"type\":\"message\",\"id\":\"{id}-m{index}u\",\"timestamp\":\"2024-01-01T00:00:0{index}.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"{user}\",\"timestamp\":{}}}}}\n",
            index * 1000
        ));
        content.push_str(&format!(
            "{{\"type\":\"message\",\"id\":\"{id}-m{index}a\",\"timestamp\":\"2024-01-01T00:00:0{index}.000Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{assistant}\"}}],\"timestamp\":{}}}}}\n",
            index * 1000 + 1
        ));
    }
    std::fs::write(&path, content).expect("write fixture");
    path
}

fn frame_of(frames: &[String], marker: &str) -> String {
    frames
        .iter()
        .rev()
        .find(|frame| frame.contains(marker))
        .unwrap_or_else(|| {
            panic!(
                "no frame shows {marker:?}; frames:\n{}",
                frames.join("\n---frame---\n")
            )
        })
        .clone()
}

#[tokio::test]
async fn search_narrows_the_roster_and_escape_restores_it() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    let archive_dir = agent_dir.join("sessions-archive");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    std::fs::create_dir_all(&archive_dir).expect("archive dir");
    let supervisor = spawn_supervisor(dir.path());

    // The fixture roster: three saved sessions with distinct names and
    // transcripts, plus one archived file that must stay out of the
    // catalog (and therefore out of every search) by construction.
    let gateway_path = write_fixture(
        &session_dir,
        "gateway-01",
        "gateway worker",
        &[(
            "deploy the gateway",
            "done; bumped the backoff ceiling to 30s",
        )],
    );
    let migration_path = write_fixture(
        &session_dir,
        "migration-01",
        "migration runner",
        &[("run the migrations now", "migration 001 applied")],
    );
    let cron_path = write_fixture(
        &session_dir,
        "cron-01",
        "cron keeper",
        &[("audit the cron jobs", "cron audit clean")],
    );
    write_fixture(
        &archive_dir,
        "archived-01",
        "archived gateway trove",
        &[("old gateway talk", "archived reply")],
    );

    let options = AgentsViewOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
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
    };
    let plan = AgentsHeadlessPlan {
        steps: vec![
            // Name search narrows to the gateway session.
            AgentsStep::Type("gateway".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 300 },
            // Escape clears the query and restores the full roster.
            AgentsStep::Key("escape".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 300 },
            // A transcript-only query (no name or first-message hit)
            // still finds the session that said it.
            AgentsStep::Type("backoff".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 300 },
            AgentsStep::Key("escape".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 300 },
            // Fuzzy partial on the first message narrows to the migration
            // session, and Enter opens it.
            AgentsStep::Type("migrat".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 300 },
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
    let all = outcome.frames.join("\n---frame---\n");
    assert!(
        !all.contains("archived gateway trove"),
        "an archived session never reaches the catalog or the view"
    );

    // Name query: only the gateway row renders.
    let gateway_frame = frame_of(&outcome.frames, " >  gateway");
    assert!(
        gateway_frame.contains("gateway worker"),
        "the gateway row renders under its name query:\n{gateway_frame}"
    );
    assert!(
        !gateway_frame.contains("migration runner"),
        "unrelated rows hide under the query:\n{gateway_frame}"
    );
    assert!(
        !gateway_frame.contains("cron keeper"),
        "unrelated rows hide under the query:\n{gateway_frame}"
    );

    // Escape clears the query: the full roster restores.
    let cleared_frame = frame_of(&outcome.frames, "Search sessions");
    for name in ["gateway worker", "migration runner", "cron keeper"] {
        assert!(
            cleared_frame.contains(name),
            "the cleared view lists {name} again:\n{cleared_frame}"
        );
    }

    // Transcript-only query matches through allMessagesText.
    let backoff_frame = frame_of(&outcome.frames, " >  backoff");
    assert!(
        backoff_frame.contains("gateway worker"),
        "a transcript-only query still finds the session:\n{backoff_frame}"
    );
    assert!(
        !backoff_frame.contains("migration runner"),
        "transcript queries narrow the roster:\n{backoff_frame}"
    );

    // Fuzzy partial narrows to the migration row, and Enter opens it.
    let migration_frame = frame_of(&outcome.frames, " >  migrat");
    assert!(
        migration_frame.contains("migration runner"),
        "the fuzzy partial matches the migration row:\n{migration_frame}"
    );
    assert!(
        !migration_frame.contains("gateway worker"),
        "the fuzzy partial narrows the roster:\n{migration_frame}"
    );
    assert_eq!(
        outcome.selection,
        Some(SessionSelection::Resume(migration_path)),
        "Enter opened the filtered match"
    );
    assert!(
        outcome.frames.len() > 3,
        "the run captured the intermediate keystroke frames"
    );
    drop((gateway_path, cron_path));
    drop(supervisor);
}
