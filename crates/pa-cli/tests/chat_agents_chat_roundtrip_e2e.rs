//! End-to-end verifier for the agents-view round trip's layout handoff
//! (the tui-switch-layout-reuse cut): a chat run that exits through the
//! agents-back handoff holds its visible-window entry packs (the
//! `view::handoff` store), the agents view's Enter opens the same
//! session, and the re-entry's chat run renders the same transcript rows
//! over them. The served-path oracles (the packs reused, no re-render;
//! every changed transcript re-rendering) live in the unit tests; this
//! e2e pins the REAL flow — one daemon, one worker, one session — the
//! re-entry attaches the unchanged session, adopts the held handoff on
//! the matching attach cursor, and its frames carry the identical
//! transcript content.
// Pedantic-gate dispositions for THIS test root (each tied to its own
// sites): the two round-trip flows are intentionally linear harness
// scripts (the fn-length gate is style, not correctness), and their
// async test futures are stack-resident by shape - boxing a test
// future for a lint tick is churn with no correctness gain.
#![allow(clippy::large_futures, clippy::too_many_lines)]
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::agents_view::{AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode};
use pa_tui::interactive::{
    HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection, SessionSelection, UiMode,
};

/// The layout handoff store is process-wide: the two round-trip tests
/// serialize through this lock so one test's stash is never adopted (or
/// overwritten) by the other's - the unit tests' `HANDOFF_TEST_LOCK`
/// discipline applied to the e2e pair (the slot lives inside pa-tui and
/// cannot be reset from this crate's tests).
static HANDOFF_E2E_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Supervisor {
    child: Child,
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
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
    let _ = reader.read_line(&mut String::new());
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
/// exchange.
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

/// The scripted faux provider's script file (the `interactive_daemon_e2e`
/// pattern): one scripted reply drives a REAL turn through the worker, so
/// the transcript grows and the worker's event sequence advances during
/// the chat run — the class the layout handoff's live-sequence key serves.
fn write_faux_script(dir: &Path, replies: &[&str]) -> PathBuf {
    let responses: Vec<serde_json::Value> = replies
        .iter()
        .map(|text| serde_json::json!({ "text": text }))
        .collect();
    let script = serde_json::json!({ "engine": "faux", "responses": responses });
    let path = dir.join("script.json");
    std::fs::write(&path, script.to_string()).expect("write faux script");
    path
}

fn chat_options(socket: PathBuf, cwd: PathBuf) -> InteractiveOptions {
    InteractiveOptions {
        models: None,
        socket_path: socket,
        cwd,
        session_dir: None,
        script_path: None,
        model_selection: ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: SessionSelection::New,
        initial_message: None,
        show_images: true,
        fullscreen_mouse: true,
        theme: "prime".to_string(),
        code_block_indent: "  ".to_string(),
        tree_filter_mode: String::new(),
        branch_summary_skip_prompt: false,
        version: "0.0.0".to_string(),
        onboarding: None,
        telemetry_disabled: None,
        client_auth: None,
        traces: None,
        provider_auth: None,
        update_commands: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        restore_dock_focus: false,
        client_settings: None,
    }
}

/// The real round trip over one daemon: chat (agents-back handoff) ->
/// agents view (Enter on the anchored session) -> the chat re-entry. The
/// re-entry attaches the SAME unchanged session, so the held layout
/// handoff's key matches and the re-entry renders the same transcript
/// rows (the adopt is output-neutral; the frames prove the flow and the
/// content, the unit tests prove the packs were the source).
#[tokio::test]
async fn the_roundtrip_reentry_renders_the_same_transcript() {
    let _handoff_guard = HANDOFF_E2E_LOCK.lock().await;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let session_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    let fixture = write_fixture(
        &session_dir,
        "roundtrip-01",
        "roundtrip session",
        &[
            ("ship the feature", "shipped the feature"),
            ("audit the flow", "flow audit clean"),
        ],
    );

    // The first chat run: open the fixture, wait for its rows, exit
    // through the agents-back LEFT handoff.
    let mut first = chat_options(supervisor.socket.clone(), dir.path().to_path_buf());
    first.session = SessionSelection::Resume(fixture.clone());
    let first_outcome = pa_tui::interactive::run_interactive(
        first,
        UiMode::Headless(HeadlessPlan {
            steps: vec![
                HeadlessStep::WaitRender {
                    needle: "flow audit clean".to_string(),
                    timeout_ms: 20_000,
                },
                HeadlessStep::Key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE)),
                HeadlessStep::WaitMs(500),
            ],
            width: 120,
            height: 36,
        }),
    )
    .await
    .expect("the first chat run");
    assert!(
        first_outcome.return_to_agents_view,
        "the LEFT handoff ended the run into the agents view"
    );
    assert!(
        first_outcome
            .frames
            .iter()
            .any(|frame| frame.contains("flow audit clean")),
        "the first run rendered the fixture rows"
    );
    assert_eq!(
        first_outcome.handoff_seeds, 0,
        "the FIRST run holds no handoff to serve (nothing stashed for it)"
    );

    // The agents view anchored on the session just left: Enter opens it.
    let view_options = AgentsViewOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: (!first_outcome.session_id.is_empty())
            .then(|| first_outcome.session_id.clone())
            .or(Some("roundtrip-01".to_string())),
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
    let view_run = pa_tui::agents_view::run_agents_view(
        view_options,
        AgentsViewUiMode::Headless(AgentsHeadlessPlan {
            steps: vec![
                AgentsStep::WaitSettle { timeout_ms: 1000 },
                AgentsStep::Key("enter".to_string()),
            ],
            width: 120,
            height: 36,
        }),
        None,
    )
    .await
    .expect("the agents view run");
    if let Some(link) = view_run.link {
        link.close();
    }
    let selection = view_run
        .outcome
        .selection
        .expect("Enter selected a session");

    // The re-entry: the same session opens again — the held handoff's
    // key matches this attach (the worker, the generation, the event
    // sequence, and the entry count all unchanged), and the re-entry
    // renders the same transcript rows over the adopted packs.
    let mut reentry = chat_options(supervisor.socket.clone(), dir.path().to_path_buf());
    reentry.session = selection;
    let reentry_outcome = pa_tui::interactive::run_interactive(
        reentry,
        UiMode::Headless(HeadlessPlan {
            steps: vec![
                HeadlessStep::WaitRender {
                    needle: "flow audit clean".to_string(),
                    timeout_ms: 20_000,
                },
                HeadlessStep::WaitMs(500),
            ],
            width: 120,
            height: 36,
        }),
    )
    .await
    .expect("the re-entry chat run");
    assert!(
        !reentry_outcome.return_to_agents_view,
        "the re-entry run completed"
    );
    assert!(
        reentry_outcome
            .frames
            .iter()
            .any(|frame| frame.contains("flow audit clean")),
        "the re-entry rendered the same transcript rows over the adopted handoff"
    );
    // The served-path assertion (the frames are byte-identical either way —
    // the frozen-surface property itself — so the reuse needs its own
    // observable): this idle round trip's re-entry SERVED the window from
    // the held packs.
    assert!(
        reentry_outcome.handoff_seeds > 0,
        "the idle round trip's re-entry served its first draw from the held packs"
    );
}

/// The post-turn sojourn class (the live-sequence key, `view::handoff`):
/// a turn run DURING the chat run advances the worker's event sequence
/// past the run's own attach value, the exit stashes under the LATEST
/// sequence, and the transcript-unchanged sojourn's re-entry still
/// adopts — the re-entry's first draw serves the held packs (the
/// observable the byte-identical frames cannot prove on their own).
#[tokio::test]
async fn a_post_turn_sojourn_reentry_still_serves_the_held_packs() {
    let _handoff_guard = HANDOFF_E2E_LOCK.lock().await;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let session_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    let fixture = write_fixture(
        &session_dir,
        "roundtrip-turn-01",
        "roundtrip turn session",
        &[
            ("ship the feature", "shipped the feature"),
            ("audit the flow", "flow audit clean"),
        ],
    );
    let script_path = write_faux_script(dir.path(), &["the live turn reply"]);

    // The first chat run opens the fixture, runs a REAL scripted turn (the
    // worker's event sequence advances past this run's attach value), then
    // exits through the agents-back LEFT handoff.
    let mut first = chat_options(supervisor.socket.clone(), dir.path().to_path_buf());
    first.session = SessionSelection::Resume(fixture.clone());
    first.script_path = Some(script_path.clone());
    let first_outcome = pa_tui::interactive::run_interactive(
        first,
        UiMode::Headless(HeadlessPlan {
            steps: vec![
                HeadlessStep::WaitRender {
                    needle: "flow audit clean".to_string(),
                    timeout_ms: 20_000,
                },
                HeadlessStep::Submit("one more turn".to_string()),
                HeadlessStep::WaitIdle { timeout_ms: 30_000 },
                HeadlessStep::WaitRender {
                    needle: "the live turn reply".to_string(),
                    timeout_ms: 20_000,
                },
                HeadlessStep::Key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE)),
                HeadlessStep::WaitMs(500),
            ],
            width: 120,
            height: 36,
        }),
    )
    .await
    .expect("the first chat run with the live turn");
    assert!(
        first_outcome.return_to_agents_view,
        "the LEFT handoff ended the run into the agents view"
    );
    assert!(
        first_outcome
            .frames
            .iter()
            .any(|frame| frame.contains("the live turn reply")),
        "the scripted turn landed in the transcript before the exit"
    );
    assert_eq!(
        first_outcome.handoff_seeds, 0,
        "the FIRST run holds no handoff to serve (nothing stashed for it)"
    );

    // The agents view anchored on the session just left: Enter opens it.
    let view_options = AgentsViewOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: (!first_outcome.session_id.is_empty())
            .then(|| first_outcome.session_id.clone())
            .or(Some("roundtrip-turn-01".to_string())),
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
    let view_run = pa_tui::agents_view::run_agents_view(
        view_options,
        AgentsViewUiMode::Headless(AgentsHeadlessPlan {
            steps: vec![
                AgentsStep::WaitSettle { timeout_ms: 1000 },
                AgentsStep::Key("enter".to_string()),
            ],
            width: 120,
            height: 36,
        }),
        None,
    )
    .await
    .expect("the agents view run");
    if let Some(link) = view_run.link {
        link.close();
    }
    let selection = view_run
        .outcome
        .selection
        .expect("Enter selected a session");

    // The re-entry over the transcript-unchanged sojourn: the stash was
    // keyed under the LATEST event sequence (the live tracker), so this
    // attach — reporting the same post-turn value — adopts, and the
    // re-entry's first draw serves the held packs instead of re-rendering
    // the window (the post-turn class the stale attach-sequence key
    // always missed).
    let mut reentry = chat_options(supervisor.socket.clone(), dir.path().to_path_buf());
    reentry.session = selection;
    reentry.script_path = Some(script_path);
    let reentry_outcome = pa_tui::interactive::run_interactive(
        reentry,
        UiMode::Headless(HeadlessPlan {
            steps: vec![
                HeadlessStep::WaitRender {
                    needle: "the live turn reply".to_string(),
                    timeout_ms: 20_000,
                },
                HeadlessStep::WaitMs(500),
            ],
            width: 120,
            height: 36,
        }),
    )
    .await
    .expect("the post-turn re-entry chat run");
    assert!(
        !reentry_outcome.return_to_agents_view,
        "the re-entry run completed"
    );
    assert!(
        reentry_outcome
            .frames
            .iter()
            .any(|frame| frame.contains("the live turn reply")),
        "the re-entry rendered the turn's rows"
    );
    assert!(
        reentry_outcome
            .frames
            .iter()
            .any(|frame| frame.contains("flow audit clean")),
        "the re-entry rendered the fixture rows too"
    );
    assert!(
        reentry_outcome.handoff_seeds > 0,
        "the post-turn sojourn's re-entry served its first draw from the held packs (the live-sequence key)"
    );
}
