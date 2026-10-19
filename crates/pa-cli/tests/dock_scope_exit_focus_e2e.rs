// large_futures: stack futures on hot paths by design. too_many_lines: style gate
// only. Casts: 64-bit targets; narrowing sits at bounded OS/protocol boundaries.
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! End-to-end verifier for the dock's Subagents panel exit (the operator's
//! 2026-09-26 ruling): leaving the scoped agents view reopens the scope
//! root's chat with the dock focused on the SUBAGENTS item — the panel's own
//! dock icon — not the prompt bar. Proven behaviorally: a bare Enter re-opens
//! the scoped view, and the scoped view's outcome carries `scope_back`.
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_tui::agents_view::{
    AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewOutcome, AgentsViewScope,
    AgentsViewUiMode,
};
use pa_tui::interactive::{
    HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection, SessionSelection, UiMode,
};

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

// The Supervisor holds the Child so its Drop owns the protocol shutdown,
// the kill, and the wait; the lint wants the reap inline instead.
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
    // Readiness is the socket appearing (observable), not the wait: the
    // sleep is only the poll interval between checks, and the deadline
    // bounds failure — a missing socket panics, it never passes.
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
/// `rlmDepth` give the catalog the subagent linkage, a display name, and
/// a user/assistant exchange.
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
        let _ = write!(content, ",\"parentSession\":\"{}\"", parent.display());
    }
    let _ = write!(content, ",\"rlmDepth\":{rlm_depth}}}");
    content.push('\n');
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

/// The interactive options for one fixture session; `restore_dock_focus`
/// rides the scope-back reopen exactly the way the agents-view flow
/// passes it.
fn session_options(
    socket: &Path,
    session_dir: &Path,
    session: SessionSelection,
    restore_dock_focus: bool,
) -> InteractiveOptions {
    InteractiveOptions {
        models: None,
        socket_path: socket.to_path_buf(),
        cwd: PathBuf::from("/tmp"),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        session_dir: Some(session_dir.to_path_buf()),
        script_path: None,
        model_selection: ModelSelection::default(),
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
        session_rlm_depth: None,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: true,
        restore_dock_focus,
    }
}

/// The scoped agents view over `scope`, run headless through `steps`.
async fn run_scoped_view(
    socket: &Path,
    session_dir: &Path,
    scope: AgentsViewScope,
    steps: Vec<AgentsStep>,
) -> AgentsViewOutcome {
    let view_options = AgentsViewOptions {
        socket_path: socket.to_path_buf(),
        cwd: PathBuf::from("/tmp"),
        session_dir: Some(session_dir.to_path_buf()),
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
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: serde_json::json!({}),
    };
    let plan = AgentsHeadlessPlan {
        steps,
        width: 120,
        height: 36,
    };
    pa_tui::agents_view::run_agents_view(view_options, AgentsViewUiMode::Headless(plan), None)
        .await
        .expect("scoped agents view run")
        .outcome
}

/// One full scope-back cycle: the parent's chat opens with the dock's
/// Subagents group selectable, the scoped agents view is entered from the
/// dock and left with `exit_key`, and the reopened chat's bare Enter re-opens
/// the scoped view.
async fn scope_exit_keeps_the_subagents_item(exit_key: &'static str) {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    let parent_path = write_fixture(
        &session_dir,
        "scope-exit-parent",
        "scope exit parent",
        None,
        0,
        &[("dispatch the worker", "worker dispatched")],
    );
    let child_path = write_fixture(
        &session_dir,
        "scope-exit-worker",
        "scope exit worker",
        Some(&parent_path),
        1,
        &[("do the work", "work complete alpha")],
    );
    let ledger = pa_daemon::rlm_ledger::RlmSpawnLedger::new(&agent_dir, &session_dir, |_m| {});
    ledger
        .append_spawn(&pa_daemon::rlm_ledger::RlmSpawnInput {
            child_id: "scope-exit-child".to_string(),
            parent: parent_path.to_string_lossy().to_string(),
            child: child_path.to_string_lossy().to_string(),
            depth: 1,
            name: "scope exit worker".to_string(),
        })
        .expect("append spawn edge");

    // Run 1 — the attached parent's chat: Down focuses the dock (the
    // ledger-seeded child makes the Subagents group the first selectable
    // one) and Enter opens the scoped agents view (the panel).
    let options = session_options(
        &supervisor.socket,
        &session_dir,
        SessionSelection::Resume(parent_path),
        false,
    );
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::WaitIdle { timeout_ms: 15_000 },
            HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Down,
                crossterm::event::KeyModifiers::NONE,
            )),
            HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            )),
        ],
        width: 120,
        height: 36,
    };
    let run = pa_tui::interactive::run_interactive(options, UiMode::Headless(plan))
        .await
        .expect("parent session run");
    assert!(
        run.frames.iter().any(|frame| frame.contains("subagent")),
        "the parent renders the dock's subagents segment"
    );
    assert!(
        run.return_to_agents_view,
        "the dock's Enter hands the pane to the scoped agents view"
    );
    let scope = run
        .agents_view_scope
        .clone()
        .expect("the open came from the dock's direct navigation (scoped)");
    let parent_active = scope
        .active_session_id
        .clone()
        .filter(|id| !id.is_empty())
        .expect("the scope names the parent's live session");

    // Run 2 — the scoped agents view (the Subagents panel): the exit key
    // hands the pane back to the scope root's chat, and the outcome carries
    // `scope_back`.
    let view = run_scoped_view(
        &supervisor.socket,
        &session_dir,
        scope,
        vec![
            AgentsStep::WaitSettle { timeout_ms: 2_000 },
            AgentsStep::Key(exit_key.to_string()),
        ],
    )
    .await;
    assert_eq!(
        view.selection,
        Some(SessionSelection::Attach(parent_active.clone())),
        "the exit key reopens the scope root's chat"
    );
    assert!(
        view.scope_back,
        "the scoped panel's exit marks the reopen (the flag the flow passes on)"
    );

    // Run 3 — the reopened chat: the scope-back flag rides the options
    // (the flow's own wiring), so the dock starts focused on the
    // Subagents item. The bare Enter re-opens the scoped view.
    let options = session_options(
        &supervisor.socket,
        &session_dir,
        SessionSelection::Attach(parent_active.clone()),
        true,
    );
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::WaitIdle { timeout_ms: 15_000 },
            HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            )),
        ],
        width: 120,
        height: 36,
    };
    let run = pa_tui::interactive::run_interactive(options, UiMode::Headless(plan))
        .await
        .expect("reopened session run");
    assert!(
        run.frames.iter().any(|frame| frame.contains("subagent")),
        "the reopened chat renders the dock's subagents segment"
    );
    assert!(
        run.return_to_agents_view,
        "the reopened chat's dock held the focus on the Subagents item: a bare Enter re-opened the scoped view (the prompt bar would have swallowed it)"
    );
    let reopened_scope = run
        .agents_view_scope
        .expect("the re-open came from the dock's Subagents item");
    assert_eq!(
        Some(parent_active.as_str()),
        reopened_scope.active_session_id.as_deref(),
        "the re-opened scope is the same session's subtree"
    );
}

#[tokio::test]
async fn scoped_view_escape_returns_to_the_subagents_dock_item() {
    scope_exit_keeps_the_subagents_item("escape").await;
}

#[tokio::test]
async fn scoped_view_left_returns_to_the_subagents_dock_item() {
    scope_exit_keeps_the_subagents_item("left").await;
}

/// A fresh session with no subagents (and no messages yet): Down focuses the
/// dock, Enter opens the session's own scoped agents view. Returns the scope
/// and the session's file, the path a child binds to.
async fn open_fresh_session_scope(socket: &Path, session_dir: &Path) -> (AgentsViewScope, String) {
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::WaitIdle { timeout_ms: 15_000 },
            HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Down,
                crossterm::event::KeyModifiers::NONE,
            )),
            HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            )),
        ],
        width: 120,
        height: 36,
    };
    let run = pa_tui::interactive::run_interactive(
        session_options(socket, session_dir, SessionSelection::New, false),
        UiMode::Headless(plan),
    )
    .await
    .expect("fresh session run");
    let scope = run
        .agents_view_scope
        .expect("the dock's Enter opens the scoped agents view");
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect_with_retry(socket)
        .await
        .expect("connect");
    let roster = client
        .request_ok(
            serde_json::from_value(serde_json::json!({ "type": "roster_subscribe" }))
                .expect("roster_subscribe command"),
        )
        .await
        .expect("roster snapshot");
    client.close();
    let session_file = roster["roster"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|entry| entry["summary"]["activeSessionId"] == run.active_session_id.as_str())
        .and_then(|entry| entry["summary"]["sessionFile"].as_str())
        .map_or_else(
            || panic!("the fresh session's roster row: {roster}"),
            str::to_string,
        );
    (scope, session_file)
}

fn assert_scoped_frame(frame: &str) {
    assert!(
        frame.contains("\u{203a} subagents") && frame.contains("No subagents yet."),
        "the scoped view lists the session's empty subtree:\n{frame}"
    );
}

/// The operator's report: a session with zero subagents fell back to the
/// top-level agents view. Its dock entry opens the session's own scoped
/// view, empty, and the new action starts a child bound to the session.
#[tokio::test]
async fn a_session_without_subagents_opens_its_empty_scoped_view() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let session_dir = dir.path().join("agent").join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let (scope, session_file) = open_fresh_session_scope(&supervisor.socket, &session_dir).await;

    let view = run_scoped_view(
        &supervisor.socket,
        &session_dir,
        scope,
        vec![
            AgentsStep::WaitSettle { timeout_ms: 2_000 },
            AgentsStep::Key("ctrl+n".to_string()),
        ],
    )
    .await;
    assert!(
        !view.scope_dropped,
        "the scope holds: {:?}",
        view.frames.last()
    );
    let last = view.frames.last().expect("a rendered frame");
    assert_scoped_frame(last);
    assert!(
        last.contains("Ctrl+N new") && last.contains("\u{2190} parent"),
        "the hint offers the new action and the way back:\n{last}"
    );
    assert_eq!(
        view.selection,
        Some(SessionSelection::NewChild {
            parent_session_file: PathBuf::from(session_file),
            rlm_depth: 1,
        }),
        "the new action starts a child of the scoped session"
    );
}

/// A child bound to the session while its empty scoped view is open pops in
/// without reopening the view.
#[tokio::test]
async fn a_child_created_under_the_open_empty_scope_appears_live() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let session_dir = dir.path().join("agent").join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let (scope, session_file) = open_fresh_session_scope(&supervisor.socket, &session_dir).await;
    let live_dir = dir.path().join("live");
    std::fs::create_dir_all(&live_dir).expect("live dir");

    // The plan wakes the child's create once the empty scoped view rendered.
    let empty_rendered = std::sync::Arc::new(tokio::sync::Notify::new());
    let view = run_scoped_view(
        &supervisor.socket,
        &session_dir,
        scope,
        vec![
            AgentsStep::WaitRender {
                needle: "No subagents yet.".to_string(),
                timeout_ms: 5_000,
            },
            AgentsStep::Notify(empty_rendered.clone()),
            AgentsStep::WaitRender {
                needle: "late child".to_string(),
                timeout_ms: 15_000,
            },
            AgentsStep::Key("escape".to_string()),
        ],
    );
    // The child's file lives outside the session dir, so the saved catalog
    // never lists it: the row can only arrive live from the create. The
    // frame order below proves the view showed the empty scope first.
    let create_child = async {
        empty_rendered.notified().await;
        let child_path = write_fixture(
            &live_dir,
            "late-child",
            "late child",
            Some(Path::new(&session_file)),
            1,
            &[("join late", "joined")],
        );
        let (client, _events) =
            pa_tui::daemon_client::DaemonClient::connect_with_retry(&supervisor.socket)
                .await
                .expect("connect");
        client
            .request_ok(
                serde_json::from_value(serde_json::json!({
                    "type": "create",
                    "sessionPath": child_path.to_string_lossy(),
                    "config": {
                        "cwd": "/tmp",
                        "sessionDir": session_dir.to_string_lossy(),
                    },
                }))
                .expect("create command"),
            )
            .await
            .expect("the child session starts");
        client.close();
    };
    let (view, ()) = tokio::join!(view, create_child);
    let empty = view
        .frames
        .iter()
        .position(|frame| frame.contains("No subagents yet."))
        .unwrap_or_else(|| panic!("the empty scoped view rendered: {:?}", view.frames.last()));
    assert_scoped_frame(&view.frames[empty]);
    let child = view.frames[empty..]
        .iter()
        .find(|frame| frame.contains("late child"))
        .unwrap_or_else(|| panic!("the child row popped in: {:?}", view.frames.last()));
    assert!(
        child.contains("\u{203a} subagents"),
        "the child lists inside the same scoped view:\n{child}"
    );
    assert!(!view.scope_dropped);
}
