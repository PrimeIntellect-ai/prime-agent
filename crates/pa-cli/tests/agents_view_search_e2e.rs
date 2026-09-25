//! End-to-end verifier for the agents-view session search: a fixture
//! roster (saved-catalog sessions on disk) behind a real supervisor, with
//! the headless agents-view plan typing queries and asserting the redesigned
//! picker contract (Kevin's 2026-09-23 directive): queries match the
//! session NAME, the durable session ID, and the CWD — never first
//! messages, transcript text, or file paths — and hits
//! render as one flat, relevance-ranked list. `PA_SEARCH_FRAMES_DIR`
//! dumps every frame for before/after evidence captures.
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
    let _ = write!(content,
        "{{\"type\":\"session_info\",\"id\":\"{id}-info\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"name\":\"{name}\"}}\n"
    );
    for (index, (user, assistant)) in turns.iter().enumerate() {
        let _ = write!(content,
            "{{\"type\":\"message\",\"id\":\"{id}-m{index}u\",\"timestamp\":\"2024-01-01T00:00:0{index}.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"{user}\",\"timestamp\":{}}}}}\n",
            index * 1000
        );
        let _ = write!(content,
            "{{\"type\":\"message\",\"id\":\"{id}-m{index}a\",\"timestamp\":\"2024-01-01T00:00:0{index}.000Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{assistant}\"}}],\"timestamp\":{}}}}}\n",
            index * 1000 + 1
        );
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

/// Writes every captured frame under `PA_SEARCH_FRAMES_DIR` when set: the
/// before/after evidence capture for the search redesign (run the same
/// driver against the base tree to diff behavior).
fn dump_frames(label: &str, frames: &[String]) {
    let Some(dir) = std::env::var("PA_SEARCH_FRAMES_DIR")
        .ok()
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    std::fs::create_dir_all(&dir).expect("frames dir");
    for (index, frame) in frames.iter().enumerate() {
        std::fs::write(
            std::path::Path::new(&dir).join(format!("{label}-{index:03}.txt")),
            frame,
        )
        .expect("frame dump");
    }
}

#[tokio::test]
async fn search_matches_names_ids_and_cwd_never_transcripts() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // The fixture roster: a named session whose transcript ALSO mentions
    // the query word, several sibling sessions whose transcripts mention
    // it but whose names do not, an id-only target (name without the id
    // fragment), and a session whose transcript text exists nowhere in its
    // identity fields.
    let fast_path = write_fixture(
        &session_dir,
        "fast-01",
        "fast lane refactor",
        &[("make the suite fast", "the gateway deploy is fast")],
    );
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
        &[(
            "run the migrations now",
            "migration 001 applied; it was fast",
        )],
    );
    write_fixture(
        &session_dir,
        "probe-01",
        "alpha probe",
        &[("probe the endpoint", "alpha probe complete")],
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
        show_hardware_cursor: false,
    };
    let plan = AgentsHeadlessPlan {
        steps: vec![
            // A noisy word: transcripts mention it, names mostly do not.
            AgentsStep::Type("fast".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 300 },
            AgentsStep::Key("escape".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 300 },
            // Transcript-only text: no identity field carries it.
            AgentsStep::Type("backoff".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 300 },
            AgentsStep::Key("escape".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 300 },
            // Fuzzy name fragment ranks the gateway session first.
            AgentsStep::Type("gtwy".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 300 },
            AgentsStep::Key("escape".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 300 },
            // Durable-id targeting: the id fragment lives nowhere else.
            AgentsStep::Type("probe-0".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 300 },
            AgentsStep::Key("escape".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 300 },
            // Enter opens the filtered match.
            AgentsStep::Type("gateway".to_string()),
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
    dump_frames("lane", &outcome.frames);

    // Name query: only the named hit renders — the sibling transcripts
    // that mention "fast" stay hidden (the redesign's headline behavior).
    let fast_frame = frame_of(&outcome.frames, " >  fast");
    assert!(
        fast_frame.contains("fast lane refactor"),
        "the named hit renders:\n{fast_frame}"
    );
    for absent in [
        "gateway worker",
        "migration runner",
        "alpha probe",
        "Inactive (",
    ] {
        assert!(
            !fast_frame.contains(absent),
            "{absent:?} hides under the query (flat ranked list):\n{fast_frame}"
        );
    }

    // Transcript-only text never matches: content is not a picker filter.
    let backoff_frame = frame_of(&outcome.frames, " >  backoff");
    assert!(
        backoff_frame.contains("No sessions match"),
        "transcript-only queries match nothing:\n{backoff_frame}"
    );

    // Fuzzy name fragment: the gateway session is the sole hit.
    let gtwy_frame = frame_of(&outcome.frames, " >  gtwy");
    assert!(
        gtwy_frame.contains("gateway worker"),
        "the fuzzy name fragment matches:\n{gtwy_frame}"
    );
    assert!(
        !gtwy_frame.contains("migration runner"),
        "unrelated names hide under the fuzzy query:\n{gtwy_frame}"
    );

    // Id targeting: "probe-0" hits only through the session id.
    let id_frame = frame_of(&outcome.frames, " >  probe-0");
    assert!(
        id_frame.contains("alpha probe"),
        "the id target renders:\n{id_frame}"
    );
    assert!(
        !id_frame.contains("gateway worker"),
        "other rows hide under the id query:\n{id_frame}"
    );

    // Enter opens the filtered match.
    assert_eq!(
        outcome.selection,
        Some(SessionSelection::Resume(gateway_path)),
        "Enter opened the filtered match"
    );
    drop((fast_path, migration_path));
    drop(supervisor);
}

#[tokio::test]
async fn ranked_hits_sort_by_relevance_then_recency() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // Three name-prefix hits for "run": two same-length prefixes (tie on
    // tier quality, title breaks the tie) and one longer prefix (worse
    // tier quality ranks it below them).
    write_fixture(
        &session_dir,
        "run-books-01",
        "run books",
        &[("start", "done")],
    );
    write_fixture(
        &session_dir,
        "run-dials-01",
        "run dials",
        &[("start", "done")],
    );
    let runway_path = write_fixture(
        &session_dir,
        "runway-01",
        "runway cleanup",
        &[("start", "done")],
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
        show_hardware_cursor: false,
    };
    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::Type("run".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 300 },
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::agents_view::run_agents_view(options, AgentsViewUiMode::Headless(plan), None)
            .await
            .expect("agents view run")
            .outcome;
    dump_frames("ranked", &outcome.frames);
    let frame = frame_of(&outcome.frames, " >  run");
    let positions: Vec<usize> = ["run books", "run dials", "runway cleanup"]
        .iter()
        .map(|needle| {
            frame
                .find(needle)
                .unwrap_or_else(|| panic!("row {needle:?} missing from:\n{frame}"))
        })
        .collect();
    assert!(
        positions.windows(2).all(|pair| pair[0] < pair[1]),
        "same-length prefixes tie by title, the longer prefix ranks last:\n{frame}"
    );
    drop(runway_path);
    drop(supervisor);
}
