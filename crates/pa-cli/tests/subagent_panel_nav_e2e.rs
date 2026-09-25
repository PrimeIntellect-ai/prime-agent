//! End-to-end verifier for the subagent panel's keyboard path from the main
//! chat (Kevin's live-dogfood ruling, TS parity): the attached session with a
//! ledger-seeded child renders the subagent summary box; Down at the end of
//! the prompt hands the focus to the panel (the unfocused `↓ select` hint
//! flips to `Enter/→ open`); Enter opens the scoped agents view listing the
//! child; Enter drills into the child's transcript (the ancestor carry); and
//! the agents-back key returns from the child to the agents view.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_tui::agents_view::{AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode};
use pa_tui::interactive::SessionSelection;
use pa_tui::interactive::UiMode;

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

/// One saved-session fixture: a session header whose `parentSession` and
/// `rlmDepth` give the catalog the subagent linkage, a display name, and a
/// user/assistant exchange.
fn write_fixture(
    dir: &Path,
    id: &str,
    name: &str,
    parent: Option<&Path>,
    rlm_depth: u64,
    turns: &[(&str, &str)],
) -> PathBuf {
    let path = dir.join(format!("{id}.jsonl"));
    let mut content = format!(
        "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\""
    );
    if let Some(parent) = parent {
        content.push_str(&format!(",\"parentSession\":\"{}\"", parent.display()));
    }
    content.push_str(&format!(",\"rlmDepth\":{rlm_depth}}}"));
    content.push('\n');
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

/// The first frame showing `marker` (the state before the later keystrokes
/// mutate it).
fn first_frame_of(frames: &[String], marker: &str) -> String {
    frames
        .iter()
        .find(|frame| frame.contains(marker))
        .unwrap_or_else(|| {
            panic!(
                "no frame shows {marker:?}; frames:\n{}",
                frames.join("\n---frame---\n")
            )
        })
        .clone()
}

/// The last frame showing `marker`.
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

/// The interactive options for one fixture session.
fn session_options(
    socket: &Path,
    session_dir: &Path,
    session: SessionSelection,
    rlm_depth: Option<u32>,
    has_children: bool,
) -> pa_tui::interactive::InteractiveOptions {
    pa_tui::interactive::InteractiveOptions {
        socket_path: socket.to_path_buf(),
        cwd: PathBuf::from("/tmp"),
        model_catalog: Vec::new(),
        model_configured_providers: Default::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        session_dir: Some(session_dir.to_path_buf()),
        script_path: None,
        model_selection: Default::default(),
        no_session: false,
        session,
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
        client_settings: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: rlm_depth,
        prompt_stash: Default::default(),
        session_has_children: has_children,
    }
}

#[tokio::test]
async fn down_arrow_focuses_the_dock_and_enter_opens_the_scoped_agents_view() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // The family fixture: a parent with a transcript, and a child under it
    // (the linkage the ledger edge carries, with the child's own exchange
    // for its transcript frames).
    let parent_path = write_fixture(
        &session_dir,
        "panel-nav-parent",
        "panel nav parent",
        None,
        0,
        &[("dispatch the worker", "worker dispatched")],
    );
    let child_path = write_fixture(
        &session_dir,
        "panel-nav-worker",
        "panel nav worker",
        Some(&parent_path),
        1,
        &[("do the work", "work complete alpha")],
    );
    // The durable spawn edge: the roster surfaces the child as the parent's
    // passive descendant (the `roster_subscribe` seed walks it), so the
    // attached parent renders the subagent summary box from the real daemon.
    let ledger = pa_daemon::rlm_ledger::RlmSpawnLedger::new(&agent_dir, &session_dir, |_m| {});
    ledger
        .append_spawn(pa_daemon::rlm_ledger::RlmSpawnInput {
            child_id: "panel-nav-child".to_string(),
            parent: parent_path.to_string_lossy().to_string(),
            child: child_path.to_string_lossy().to_string(),
            depth: 1,
            name: "panel nav worker".to_string(),
        })
        .expect("append spawn edge");

    // Run 1 — the attached parent's main chat: Down at the end of the empty
    // prompt focuses the activity dock, and Enter opens the scoped agents
    // view DIRECTLY (the operator's direct-navigation redesign — the
    // grouped activity panel is gone, no intermediate step).
    let parent_options = session_options(
        &supervisor.socket,
        &session_dir,
        SessionSelection::Resume(parent_path.clone()),
        None,
        true,
    );
    let parent_plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 15_000 },
            pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Down,
                crossterm::event::KeyModifiers::NONE,
            )),
            pa_tui::interactive::HeadlessStep::WaitMs(300),
            pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            )),
        ],
        width: 120,
        height: 36,
    };
    let parent_run =
        pa_tui::interactive::run_interactive(parent_options, UiMode::Headless(parent_plan))
            .await
            .expect("parent session run");

    // The dock renders at attach as the one-line activity row (unfocused,
    // hint-free by design; Enter is the direct launcher). The subagents
    // segment reads `\u{25c6} subagents` with its live running count in
    // the `\u{25cb} 0 running` cluster (the operator's 2026-09-24 color
    // directive): the passivated child is finished, so the count reads
    // zero — the dock stays mounted and selectable because the child
    // remains browsable history.
    let attached = first_frame_of(&parent_run.frames, "subagent");
    assert!(
        attached.contains("\u{25c6} subagents"),
        "the unfocused dock shows the subagents segment:\n{attached}"
    );
    assert!(
        attached.contains("\u{25cb} 0 running"),
        "the live running count rides its cluster, zero at attach:\n{attached}"
    );
    // The single Enter opened the scoped agents view directly: no
    // grouped panel frame ever renders.
    assert!(
        !parent_run
            .frames
            .iter()
            .any(|frame| frame.contains("Activity")),
        "the grouped activity panel never opens (the direct-navigation redesign)"
    );
    assert!(
        parent_run.return_to_agents_view,
        "the dock's Enter hands the pane to the scoped agents view"
    );
    let scope = parent_run
        .agents_view_scope
        .clone()
        .expect("the open came from the dock's direct navigation (scoped)");

    // Run 2 — the scoped agents view: the child lists as the root's direct
    // child, and Enter drills into its transcript.
    let view_options = AgentsViewOptions {
        socket_path: supervisor.socket.clone(),
        cwd: PathBuf::from("/tmp"),
        session_dir: Some(session_dir.clone()),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: Some(scope),
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
    };
    let view_plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitSettle { timeout_ms: 2_000 },
            AgentsStep::Key("enter".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let view = pa_tui::agents_view::run_agents_view(
        view_options,
        AgentsViewUiMode::Headless(view_plan),
        None,
    )
    .await
    .expect("scoped agents view run")
    .outcome;
    let scoped = frame_of(&view.frames, "panel nav worker");
    assert!(
        scoped.contains("panel nav parent") || scoped.contains("subagent"),
        "the scoped view lists the child under the parent's subtree:\n{scoped}"
    );
    assert_eq!(
        view.selection,
        Some(SessionSelection::Resume(child_path.clone())),
        "Enter on the child row opened the child's transcript"
    );
    // The scoped view lists the child as a top-level row (the scope root is
    // excluded from its own subtree), so the open carries no ancestor
    // expansion chain — the return re-entry lands back in the scope frame
    // (TS `openSelected` on a direct scoped child).
    assert!(
        view.expanded_ancestors.is_empty(),
        "a direct scoped child carries no expansion ancestors: {:?}",
        view.expanded_ancestors
    );
    assert_eq!(view.opened_rlm_depth, Some(1), "the child's rlmDepth");

    // Run 3 — the child's transcript: its rows render with the `depth 1`
    // tray label, and the agents-back key returns to the agents view (the
    // TS escape path back from the nested transcript).
    let child_options = session_options(
        &supervisor.socket,
        &session_dir,
        SessionSelection::Resume(child_path.clone()),
        view.opened_rlm_depth,
        view.opened_has_children,
    );
    let child_plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 15_000 },
            pa_tui::interactive::HeadlessStep::ScrollTop,
            pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Left,
                crossterm::event::KeyModifiers::NONE,
            )),
        ],
        width: 120,
        height: 36,
    };
    let child_run =
        pa_tui::interactive::run_interactive(child_options, UiMode::Headless(child_plan))
            .await
            .expect("child session run");
    let child_frame = frame_of(&child_run.frames, "work complete alpha");
    assert!(
        child_frame.contains("\u{2190} manage  depth 1"),
        "the drilled-in child tray shows the manage hint and its depth:\n{child_frame}"
    );
    assert!(
        child_run.return_to_agents_view,
        "the agents-back key returned to the view"
    );
}
