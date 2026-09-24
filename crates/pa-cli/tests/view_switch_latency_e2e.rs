//! Latency regression guard for the operators' agents-view round trip
//! ("when I go to subagents view and hit esc to come back to this chat
//! view, it takes close to 5-10 seconds", 2026-09-24): the Esc handoff
//! back into the chat is a fresh interactive surface attaching to the
//! live session — a daemon `attach` (the full snapshot round trip) plus
//! the client-side rebuild. This test times exactly that second surface
//! (`run_interactive` on the same live session, the handoff's own code
//! path — the agents view's own surface has its separate guard in
//! `agents_view_saved_catalog_failure` / the flash-fix lane) under a
//! seeded store: real transcript entries plus a seeded session-artifact
//! tree, and asserts the round trip stays under the sub-second ceiling,
//! an order of magnitude under the operator's 5-10s report.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_types::daemon::DaemonCommand;

/// The generous-but-bounded view-switch ceiling: a healthy attach round
/// trip over a local daemon is tens of milliseconds; one full second is
/// the regression ceiling.
const VIEW_SWITCH_CEILING: Duration = Duration::from_millis(1_000);

/// The seeded artifact tree size: enough rows that the context-tree cache
/// warm at attach does real work in the background, without doubling the
/// fixture cost of the daemon-side guard (`context_latency_e2e`).
const SEEDED_CHILDREN: usize = 10;
const SEEDED_MESSAGES_PER_CHILD: usize = 50;

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
    use std::io::{BufRead, BufReader, Write};
    let Ok(stream) = std::os::unix::net::UnixStream::connect(socket) else {
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

/// Create a live session through the daemon protocol (the same `create`
/// config the TUI sends), writing the scripted engine config first.
async fn create_session_via_daemon(
    socket: &Path,
    script_path: &Path,
    script: &serde_json::Value,
    cwd: &Path,
    session_dir: &Path,
) -> (String, String) {
    std::fs::write(script_path, script.to_string()).expect("write script");
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(socket)
        .await
        .expect("connect supervisor");
    let data = client
        .request_ok(DaemonCommand::Create {
            id: None,
            session_path: None,
            continue_recent: None,
            no_session: None,
            name: None,
            config: Some(serde_json::json!({
                "cwd": cwd.display().to_string(),
                "sessionDir": session_dir.display().to_string(),
                "script": script_path.display().to_string(),
            })),
            telemetry_disabled: None,
            runtime_metadata: None,
            lifecycle: None,
            env: None,
            launch_env: None,
            rest: Default::default(),
        })
        .await
        .expect("create session");
    client.close();
    let active = data
        .get("activeSessionId")
        .or_else(|| data.get("id"))
        .and_then(serde_json::Value::as_str)
        .expect("session id")
        .to_string();
    let durable = data
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .expect("durable session id")
        .to_string();
    (active, durable)
}

/// Seed one persisted child session file (a version-3 header plus a
/// parent-chained message run), the artifact tree the context-tree cache
/// warms against at attach.
fn seed_child_session(dir: &Path, child_id: &str) {
    std::fs::create_dir_all(dir).expect("child dir");
    let file = dir.join(format!("{child_id}.jsonl"));
    let mut content = String::new();
    content.push_str(
        &serde_json::json!({
            "type": "session", "version": 3, "id": child_id,
            "timestamp": "2024-01-01T00:00:00.000Z", "cwd": "/tmp",
        })
        .to_string(),
    );
    content.push('\n');
    let mut parent_id: Option<String> = None;
    for index in 0..SEEDED_MESSAGES_PER_CHILD {
        let entry_id = format!("{child_id}-m{index}");
        content.push_str(
            &serde_json::json!({
                "type": "message",
                "id": entry_id,
                "parentId": parent_id,
                "timestamp": "2024-01-01T00:00:00.000Z",
                "message": {
                    "role": "assistant",
                    "content": "seeded child turn",
                    "usage": {
                        "input": 1000, "output": 100, "cacheRead": 0, "cacheWrite": 0,
                        "totalTokens": 1100,
                        "cost": { "input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "total": 2 },
                    },
                },
            })
            .to_string(),
        );
        content.push('\n');
        parent_id = Some(entry_id);
    }
    std::fs::write(&file, content).expect("write seeded child session");
}

/// The test's interactive options: a headless chat attach to the live
/// session (the same surface the agents-view Esc handoff reopens).
fn chat_options(
    socket: &Path,
    dir: &Path,
    session_dir: &Path,
    script_path: &Path,
    session: pa_tui::interactive::SessionSelection,
) -> pa_tui::interactive::InteractiveOptions {
    pa_tui::interactive::InteractiveOptions {
        socket_path: socket.to_path_buf(),
        cwd: dir.to_path_buf(),
        session_dir: Some(session_dir.to_path_buf()),
        script_path: Some(script_path.to_path_buf()),
        model_selection: Default::default(),
        model_catalog: Vec::new(),
        model_configured_providers: Default::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session,
        show_images: true,
        fullscreen_mouse: true,
        initial_message: None,
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
    }
}

#[tokio::test]
async fn agents_view_round_trip_reattaches_under_the_ceiling() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    let script = serde_json::json!({ "responses": [
        { "text": "hello from scripted", "delayMs": 20 },
        { "text": "second turn", "delayMs": 20 },
    ] });
    let script_path = dir.path().join("script.json");
    let (active, durable) = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;

    // A seeded artifact tree: the attach warm does real background work
    // (the context-tree cache) while the round trip is measured.
    let artifacts_root = agent_dir.join("session-artifacts").join(&durable);
    for index in 0..SEEDED_CHILDREN {
        let child_id = format!("viewswitch-child-{index:03}");
        seed_child_session(&artifacts_root.join(format!("sub-{child_id}")), &child_id);
    }

    // The first chat surface: attach, one scripted turn, idle (the
    // transcript the round trip re-attaches to).
    let first_plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("hi".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        ],
        width: 100,
        height: 30,
    };
    let first = chat_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        pa_tui::interactive::SessionSelection::Attach(active.clone()),
    );
    pa_tui::interactive::run_interactive(first, pa_tui::interactive::UiMode::Headless(first_plan))
        .await
        .expect("first interactive run");

    // The Esc handoff's own path: a fresh surface attaching to the same
    // live session (detach ran at the first surface's exit, exactly like
    // the agents-view round trip). The wall time is the view-switch
    // round trip the operator reported at 5-10s.
    let second_plan = pa_tui::interactive::HeadlessPlan {
        steps: Vec::new(),
        width: 100,
        height: 30,
    };
    let second = chat_options(
        &supervisor.socket,
        dir.path(),
        &session_dir,
        &script_path,
        pa_tui::interactive::SessionSelection::Attach(active.clone()),
    );
    let started = Instant::now();
    let outcome = pa_tui::interactive::run_interactive(
        second,
        pa_tui::interactive::UiMode::Headless(second_plan),
    )
    .await
    .expect("second interactive run");
    let elapsed = started.elapsed();
    assert!(
        elapsed <= VIEW_SWITCH_CEILING,
        "the agents-view Esc round trip took {elapsed:?} (ceiling {VIEW_SWITCH_CEILING:?}) — \
         the attach/snapshot path regressed (the operator's 5-10s handoff class)"
    );
    assert!(!outcome.frames.is_empty(), "frames were captured");
}
