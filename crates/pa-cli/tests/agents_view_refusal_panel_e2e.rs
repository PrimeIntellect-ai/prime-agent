//! End-to-end verifier for the agents view's refusal panel: a session
//! open refused by a live foreign lease holder (the cross-product hold,
//! the operator's case) hands back to the view with the multi-line
//! refusal as its notice — and the view renders the panel with the full
//! text, both ways out (the continue path and the take-over kill)
//! visible and wrapped, never the one-line status truncation.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_tui::agents_view::{AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode};
use pa_tui::interactive::{SessionSelection, UiMode};

struct Daemon {
    child: Child,
    socket: PathBuf,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &Path, agent_dir: &Path) -> Daemon {
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
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
            return Daemon {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

/// A saved-session fixture: a version-3 header, a display name, and one
/// exchange, so the agents view's catalog carries its row.
fn write_fixture(dir: &Path, id: &str, name: &str) -> PathBuf {
    let path = dir.join(format!("{id}.jsonl"));
    let content = format!(
        "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\"}}\n\
{{\"type\":\"session_info\",\"id\":\"{id}-info\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"name\":\"{name}\"}}\n\
{{\"type\":\"message\",\"id\":\"{id}-m0u\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"hello\",\"timestamp\":0}}}}\n\
{{\"type\":\"message\",\"id\":\"{id}-m0a\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"hi\"}}],\"timestamp\":1}}}}\n"
    );
    std::fs::write(&path, content).expect("write fixture");
    path
}

fn view_options(socket: &Path, session_dir: &Path, notice: Option<String>) -> AgentsViewOptions {
    AgentsViewOptions {
        socket_path: socket.to_path_buf(),
        cwd: PathBuf::from("/tmp"),
        session_dir: Some(session_dir.to_path_buf()),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: notice,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
    }
}

fn frame_text(frames: &[String]) -> String {
    frames.join("\n")
}

/// The refused open surfaces in the view as the notice panel with both
/// ways out visible: the continue path and the take-over kill, wrapped
/// and readable, dismissed by any key.
#[tokio::test]
async fn the_refused_open_renders_both_ways_out_as_the_notice_panel() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let session_path = write_fixture(&sessions, "held-session", "held session");

    // The foreign holder: this test process takes the runtime lease, the
    // role the other product's daemon worker plays on the shared session
    // store (the same recipe as the print-mode guard's foreign-holder
    // test). The lease-enable env is consumed at the acquire itself.
    std::env::set_var(pa_daemon::lease::SESSION_LEASES_ENABLED_ENV, "1");
    std::env::set_var(
        pa_daemon::lease::SESSION_LEASE_OWNER_ID_ENV,
        "foreign01ab3c",
    );
    let holder = pa_daemon::lease::acquire_session_lease(Some(&session_path), &agent_dir)
        .expect("lease acquire probe")
        .expect("the lease must be held");
    std::env::remove_var(pa_daemon::lease::SESSION_LEASE_OWNER_ID_ENV);
    std::env::remove_var(pa_daemon::lease::SESSION_LEASES_ENABLED_ENV);

    let daemon = spawn_daemon(&dir.path().join("daemon.sock"), &agent_dir);

    // The refused open: the interactive run on the held file answers with
    // the refusal and hands back to the agents view.
    let options = pa_tui::interactive::InteractiveOptions {
        socket_path: daemon.socket.clone(),
        cwd: PathBuf::from("/tmp"),
        model_catalog: Vec::new(),
        model_configured_providers: Default::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        session_dir: Some(sessions.clone()),
        script_path: None,
        model_selection: Default::default(),
        no_session: false,
        session: SessionSelection::Resume(session_path.clone()),
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
        prompt_stash: Default::default(),
        session_has_children: false,
        client_settings: None,
    };
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 15_000 }],
        width: 120,
        height: 40,
    };
    let run = pa_tui::interactive::run_interactive(options, UiMode::Headless(plan))
        .await
        .expect("the refused session run");
    assert!(
        run.return_to_agents_view,
        "the refused open hands back to the agents view: {:?}",
        run.resume_hint
    );
    let notice = run
        .agents_view_notice
        .as_deref()
        .expect("the refusal rides the handoff notice");
    assert!(
        notice.contains("currently open in another"),
        "the headline: {notice}"
    );
    assert!(
        notice.contains("Continue where you left off"),
        "the continue way out: {notice}"
    );
    assert!(
        notice.contains("Take over on this daemon"),
        "the take-over way out: {notice}"
    );

    // The panel: the full notice visible in the frame, both ways out
    // included, then dismissed by one key.
    let open_plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitSettle { timeout_ms: 2_000 },
            AgentsStep::Key("down".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 200 },
        ],
        width: 120,
        height: 40,
    };
    let view = pa_tui::agents_view::run_agents_view(
        view_options(&daemon.socket, &sessions, Some(notice.to_string())),
        AgentsViewUiMode::Headless(open_plan),
        None,
    )
    .await
    .expect("the notice view run")
    .outcome;
    let shown = frame_text(&view.frames);
    for way_out in [
        "Continue where you left off",
        "--daemon-socket <socket> --resume 'foreign01ab3c'",
        "Take over on this daemon",
        "# the holder is",
        "Then retry",
    ] {
        assert!(
            shown.contains(way_out),
            "the panel shows {way_out:?} in full:\n{shown}"
        );
    }
    let last = view.frames.last().expect("the dismissed frame");
    assert!(
        !last.contains("Take over on this daemon"),
        "the one key dismissed the panel:\n{last}"
    );
    drop(holder);
    drop(daemon);
}
