//! End-to-end verifier for the subagent panel surface of the agents view:
//! a fixture roster (saved sessions on disk, one child under a parent and a
//! grandchild under the child) behind a real supervisor, with the headless
//! agents-view plan expanding the parent's list (the per-child detail rows),
//! drilling into the child's transcript (whose frames pin the `depth N`
//! tray label), and returning to the view with the carried selection —
//! where the now-live resumed child renders per TS parity (a top-level
//! runtime row keeping its persisted depth) and Enter re-opens it.
#![cfg(unix)]

use std::fmt::Write as _;
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

/// The first frame showing `marker` (the state before the plan's later
/// keystrokes mutate it).
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

fn view_options(
    socket: &Path,
    session_dir: &Path,
    expanded_ancestors: Vec<String>,
    selected_row_identity: Option<String>,
    selected_key: Option<pa_tui::agents_view::AgentsViewSelectionKey>,
) -> AgentsViewOptions {
    AgentsViewOptions {
        socket_path: socket.to_path_buf(),
        cwd: PathBuf::from("/tmp"),
        session_dir: Some(session_dir.to_path_buf()),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors,
        selected_row_identity,
        selected_key,
        status_message: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
    }
}

#[tokio::test]
async fn panel_expand_drill_in_and_back_re_expands_the_tree() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // The fixture roster: a parent orchestrator, one child under it, and a
    // grandchild under the child (the catalog carries the linkage through
    // the session headers' parentSession/rlmDepth).
    let parent_path = write_fixture(
        &session_dir,
        "orchestrator",
        "orchestrator chat",
        None,
        0,
        &[("orchestrate the fleet", "children dispatched")],
    );
    let child_path = write_fixture(
        &session_dir,
        "worker-a",
        "worker alpha",
        Some(&parent_path),
        1,
        &[("do the work", "work complete alpha")],
    );
    let grandchild_path = write_fixture(
        &session_dir,
        "worker-a2",
        "nested alpha child",
        Some(&child_path),
        2,
        &[("dig deeper", "nested work complete")],
    );

    // View run 1: the collapsed parent carries its `N subagents` summary
    // row; alt+right expands it; the child row opens its transcript.
    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitSettle { timeout_ms: 2_000 },
            AgentsStep::Key("alt+right".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 300 },
            AgentsStep::Key("down".to_string()),
            AgentsStep::Key("down".to_string()),
            AgentsStep::Key("enter".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let options = view_options(&supervisor.socket, &session_dir, Vec::new(), None, None);
    let view =
        pa_tui::agents_view::run_agents_view(options, AgentsViewUiMode::Headless(plan), None)
            .await
            .expect("agents view run")
            .outcome;

    // Collapsed: the parent row and its `2 subagents` summary row — the
    // label aggregates the whole descendant tree (the child and the
    // grandchild under it), with both reachable only through the summary
    // row.
    let collapsed = first_frame_of(&view.frames, "orchestrator chat");
    assert!(
        collapsed.contains("\u{25b8} 2 subagents"),
        "the collapsed parent shows its tree-aggregated summary row:\n{collapsed}"
    );
    assert!(
        !collapsed.contains("worker alpha"),
        "the child stays hidden until the parent expands:\n{collapsed}"
    );

    // Expanded: the parent's summary row flips its marker, the child
    // detail row renders nested, and the child's own collapsed summary
    // row keeps the grandchild hidden until the child expands too.
    let expanded = first_frame_of(&view.frames, "worker alpha");
    assert!(
        expanded.contains("\u{25be} 2 subagents"),
        "the expanded summary row keeps the tree aggregate and flips its marker:\n{expanded}"
    );
    assert!(
        !expanded.contains("nested alpha child"),
        "the grandchild stays hidden until the child expands:\n{expanded}"
    );

    // The drill-in opened the child's session file, carrying the ancestor
    // chain for the return re-expansion and the child's depth for its tray.
    assert_eq!(
        view.selection,
        Some(SessionSelection::Resume(child_path.clone())),
        "Enter on the child row opened the child session"
    );
    assert_eq!(
        view.expanded_ancestors,
        vec!["orchestrator".to_string()],
        "the drill-in carries the parent's session id"
    );
    assert_eq!(view.opened_rlm_depth, Some(1), "the child's rlmDepth");
    assert!(
        view.opened_has_children,
        "the child has the grandchild under it"
    );

    // The drilled-in child's transcript: its rows render, and the tray
    // carries the subagent session's `depth N` label (TS
    // `getTrayLocationLabel`).
    let child_options = pa_tui::interactive::InteractiveOptions {
        socket_path: supervisor.socket.clone(),
        cwd: PathBuf::from("/tmp"),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        session_dir: Some(session_dir.clone()),
        script_path: None,
        model_selection: pa_tui::interactive::ModelSelection::default(),
        no_session: false,
        session: SessionSelection::Resume(child_path.clone()),
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
        session_rlm_depth: view.opened_rlm_depth,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: view.opened_has_children,
        client_settings: None,
    };
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

    // View run 2 (the flow's carried state): the drilled-in child is now
    // a live session that STAYS a child row: the live `top-level` runtime
    // carries the opened file's spawn-time parent binding one level below
    // the parent, so the view renders it behind the parent's summary (in
    // the parent's aggregate — a top-level flip would leave the grandchild
    // alone behind it), revealed by the expansion with its persisted
    // `rlmDepth` and its own saved descendants (the grandchild) behind its
    // own collapsed summary row.
    // Expand the parent from its own selected row (the child sits hidden
    // behind the collapsed summary, so the carried selection falls back to
    // the parent and re-syncs to it), then walk to the child — its summary
    // row, then the child — and open it.
    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitSettle { timeout_ms: 2_000 },
            AgentsStep::Key("alt+right".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 300 },
            AgentsStep::Key("down".to_string()),
            AgentsStep::Key("down".to_string()),
            AgentsStep::Key("enter".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let options = view_options(
        &supervisor.socket,
        &session_dir,
        view.expanded_ancestors.clone(),
        view.selected_row_identity.clone(),
        view.selected_key.clone(),
    );
    let back =
        pa_tui::agents_view::run_agents_view(options, AgentsViewUiMode::Headless(plan), None)
            .await
            .expect("agents view re-run")
            .outcome;
    // The settled frame is the one the saved-catalog scan landed in (the
    // first frame now renders from the live roster alone — TS
    // `applySessionList` before `armSavedSearchFetch` applies — so the
    // mount frame predates the saved rows and their summary markers).
    let returned = first_frame_of(&back.frames, "orchestrator chat");
    assert!(
        returned.contains("\u{25b8} 2 subagents"),
        "the opened child rides the parent's aggregate (a top-level flip would leave the grandchild alone behind the summary):\n{returned}"
    );
    assert!(
        returned.contains("agents 0 running, 0 idle, 1 inactive"),
        "the live child renders no top-level agent row of its own (the only agent row is the saved parent):\n{returned}"
    );
    let expanded = frame_of(&back.frames, "worker alpha");
    assert!(
        expanded.contains("\u{25be} 2 subagents"),
        "the expanded parent tree carries the live child:\n{expanded}"
    );
    assert!(
        !expanded.contains("nested alpha child"),
        "the grandchild stays hidden until the resumed child expands:\n{expanded}"
    );
    assert!(
        expanded.contains("\u{25b8} 1 subagent"),
        "the resumed child's own subtree stays behind its collapsed summary row:\n{expanded}"
    );
    assert!(
        expanded.contains("orchestrator chat"),
        "the parent stays reachable as its own saved-catalog row:\n{expanded}"
    );
    // The carried selection restored onto the resumed child's live row:
    // Enter re-opened that session (its live active id), and the open
    // carried the row's persisted depth for the tray label.
    assert_eq!(
        back.selection,
        Some(SessionSelection::Attach(
            child_run.active_session_id.clone()
        )),
        "the restored selection re-opened the live resumed child"
    );
    assert_eq!(
        back.opened_rlm_depth,
        Some(1),
        "the resumed child keeps its persisted depth (TS config.rlmDepth ?? header.rlmDepth)"
    );

    drop((grandchild_path, parent_path));
    drop(supervisor);
}

/// User-keybinding verifier for the standalone agents view (the #184
/// follow-up): a `keybindings.json` fixture rebinding the view's open
/// action (`app.agents.open` right -> ctrl+g) drives the whole surface —
/// the hint row renders the OVERRIDE key, the override key opens the
/// selection, and the default key no longer does.
#[tokio::test]
async fn agents_view_fires_user_keybindings_from_settings() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    // The settings fixture: one agents-view binding overridden exactly
    // like a user's `~/.prime/agent/keybindings.json` would, loaded
    // through the exact `KeybindingsManager::create` path the CLI uses.
    std::fs::write(
        agent_dir.join("keybindings.json"),
        r#"{ "app.agents.open": "ctrl+g" }"#,
    )
    .expect("write keybindings.json");
    let supervisor = spawn_supervisor(dir.path());
    let solo_path = write_fixture(
        &session_dir,
        "solo",
        "solo chat",
        None,
        0,
        &[("hello", "ok")],
    );

    // Run 1: the override opens the selection; the hint row renders it
    // (TS `renderHints` keyText slots).
    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitSettle { timeout_ms: 2_000 },
            AgentsStep::Key("ctrl+g".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let mut options = view_options(&supervisor.socket, &session_dir, Vec::new(), None, None);
    options.keybindings = pa_tui::keybindings::KeybindingsManager::create(&agent_dir);
    let view =
        pa_tui::agents_view::run_agents_view(options, AgentsViewUiMode::Headless(plan), None)
            .await
            .expect("agents view run")
            .outcome;
    assert_eq!(
        view.selection,
        Some(SessionSelection::Resume(solo_path.clone())),
        "the override key opened the saved session"
    );
    let hints = first_frame_of(&view.frames, "navigate");
    assert!(
        hints.contains("Enter/Ctrl+G open"),
        "the hint row renders the override key:\n{hints}"
    );
    assert!(
        !hints.contains("Enter/\u{2192} open"),
        "the default open hint is gone after the override:\n{hints}"
    );

    // Run 2: the default key is inert — a plan pressing it ends without
    // an open.
    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitSettle { timeout_ms: 2_000 },
            AgentsStep::Key("right".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let mut options = view_options(&supervisor.socket, &session_dir, Vec::new(), None, None);
    options.keybindings = pa_tui::keybindings::KeybindingsManager::create(&agent_dir);
    let view =
        pa_tui::agents_view::run_agents_view(options, AgentsViewUiMode::Headless(plan), None)
            .await
            .expect("agents view run")
            .outcome;
    assert_eq!(
        view.selection, None,
        "the default open key no longer opens after the override"
    );

    drop(supervisor);
}
