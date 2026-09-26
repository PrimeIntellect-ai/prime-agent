//! End-to-end verifier for the interactive TUI: spawn the real supervisor
//! (`prime-agent --mode daemon`, the same binary the interactive runtime
//! launches when no daemon is running), then drive the TUI headlessly
//! against a scripted daemon session — create/attach, prompt, streamed
//! assistant output, session list, and a session switch — and assert on the
//! rendered frames plus the daemon-side session state.
//!
//! The scripted engine seam (`create` config `script`) is the same faux
//! provider contract `pa-daemon/tests/supervisor_e2e.rs` uses; the product
//! never sets it.
#![cfg(unix)]

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_types::daemon::DaemonCommand;

/// A one-pixel PNG (the clipboard seam fixture image).
const MINIMAL_PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 0,
    5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

struct Supervisor {
    child: Child,
    socket: PathBuf,
}

/// Stop the daemon on `socket` by protocol so it can shut its workers down;
/// kill the child when the protocol path fails. Drop runs even when the test
/// panics, so a failing test must not leak worker processes.
impl Drop for Supervisor {
    fn drop(&mut self) {
        graceful_shutdown(&self.socket);
        // Snapshot the live worker children before the kill: workers run in
        // their own process groups (detached, TS parity), so a graceful
        // shutdown that times out orphans them when the supervisor dies.
        // Reap them here — the supervisor-lost exit window is a backstop,
        // not the teardown contract.
        let worker_pids = child_pids_of(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
        for pid in worker_pids {
            kill_worker(&pid);
        }
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// Kill a leaked worker process (SIGKILL; it already failed the graceful
/// path) and wait briefly for it to disappear.
fn kill_worker(pid: &u32) {
    // The worker pid is a child of the supervisor we just killed, so it is
    // not our child and cannot be waited on directly; poll /proc liveness.
    unsafe {
        libc::kill(*pid as i32, libc::SIGKILL);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_alive(*pid) {
        assert!(
            Instant::now() < deadline,
            "worker {pid} survived the teardown kill"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// RAII guard for a detached supervisor (spawned by
/// `ensure_daemon_running_with`): shuts the daemon down on scope exit.
struct DetachedDaemon {
    socket: PathBuf,
}

impl Drop for DetachedDaemon {
    fn drop(&mut self) {
        let supervisor_pid = graceful_shutdown(&self.socket);
        if let Some(pid) = supervisor_pid {
            // Snapshot the supervisor's live worker children before it goes
            // (they are detached, so they survive its death), then reap any
            // that the graceful shutdown did not stop.
            let worker_pids = child_pids_of(pid);
            let deadline = Instant::now() + Duration::from_secs(10);
            while process_alive(pid) {
                assert!(
                    Instant::now() < deadline,
                    "the spawned supervisor {pid} did not exit after shutdown"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
            for worker in worker_pids {
                kill_worker(&worker);
            }
        }
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// Pids whose parent is `ppid` (the supervisor's live worker children).
fn child_pids_of(ppid: u32) -> Vec<u32> {
    let mut pids = Vec::new();
    let entries = std::fs::read_dir("/proc").expect("read /proc");
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        // `comm` can contain spaces and parens, so parse after the last ')'.
        let Some((_, rest)) = stat.rsplit_once(')') else {
            continue;
        };
        let mut fields = rest.split_whitespace();
        fields.next(); // process state
        let Ok(parent) = fields.next().unwrap_or_default().parse::<u32>() else {
            continue;
        };
        if parent == ppid {
            pids.push(pid);
        }
    }
    pids
}

/// Liveness that ignores zombies: a detached child nobody reaps keeps its
/// `/proc` entry (exit status pending), so path existence alone would call
/// an exited process alive.
fn process_alive(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    // `comm` can contain spaces and parens, so parse after the last ')'.
    let Some((_, rest)) = stat.rsplit_once(')') else {
        return false;
    };
    let state = rest.split_whitespace().next().unwrap_or_default();
    !state.starts_with('Z') && !state.starts_with('X')
}

/// Shut the spawned supervisor down by protocol and assert that it — and
/// every worker process it spawned — actually exited and the socket file
/// went away. A daemon that only stops its workers but stays parked on its
/// listening socket would leak both processes (the TS client's
/// `waitForDaemonGone` relies on the daemon exiting).
fn assert_daemon_stops_clean(socket: &Path) {
    // Sync JSONL exchange (called from the sync guard path).
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    let stream = UnixStream::connect(socket).expect("connect the spawned daemon");
    let write_half = stream.try_clone().expect("clone socket");
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;
    let mut hello = String::new();
    reader.read_line(&mut hello).expect("read daemon_hello");
    let hello: serde_json::Value = serde_json::from_str(hello.trim()).expect("parse hello");
    let supervisor_pid = hello["supervisorPid"].as_u64().expect("supervisorPid") as u32;
    // The worker processes the supervisor spawned for live sessions, captured
    // before the shutdown so reparented workers can still be tracked.
    let worker_pids = child_pids_of(supervisor_pid);

    let command = serde_json::json!({
        "type": "command",
        "id": "stop-assert",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "command": { "type": "shutdown" },
    });
    let mut line = serde_json::to_string(&command).expect("serialize");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("send shutdown");
    writer.flush().expect("flush");

    // The supervisor process exits by itself and cleans up its socket.
    let deadline = Instant::now() + Duration::from_secs(10);
    while process_alive(supervisor_pid) {
        assert!(
            Instant::now() < deadline,
            "the spawned supervisor {supervisor_pid} did not exit after shutdown"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !socket.exists(),
        "the spawned supervisor removed its socket file"
    );
    // No worker process outlives the shutdown.
    for pid in worker_pids {
        let deadline = Instant::now() + Duration::from_secs(10);
        while process_alive(pid) {
            assert!(
                Instant::now() < deadline,
                "worker {pid} leaked after shutdown"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

/// Sync JSONL shutdown request (Drop runs inside the async test runtime, so
/// no nested runtime may be built here). Best effort; callers kill the child
/// process afterwards regardless. Returns the supervisor pid from the hello
/// so the caller can reap the workers it spawned.
fn graceful_shutdown(socket: &Path) -> Option<u32> {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    let Ok(stream) = UnixStream::connect(socket) else {
        return None;
    };
    let Ok(write_half) = stream.try_clone() else {
        return None;
    };
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;
    let mut hello = String::new();
    let _ = reader.read_line(&mut hello); // daemon_hello
    let supervisor_pid = serde_json::from_str::<serde_json::Value>(hello.trim())
        .ok()
        .and_then(|hello| hello["supervisorPid"].as_u64())
        .map(|pid| pid as u32);

    let command = serde_json::json!({
        "type": "command",
        "id": "test-shutdown",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "command": { "type": "shutdown" },
    });
    let Ok(mut line) = serde_json::to_string(&command) else {
        return None;
    };
    line.push('\n');
    if writer.write_all(line.as_bytes()).is_err() {
        return None;
    }
    let _ = writer.flush();
    // Wait briefly for the supervisor to accept the shutdown (it stops every
    // worker before exiting, so the response is the sync point).
    let _ = reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(5)));
    let mut response = String::new();
    let _ = reader.read_line(&mut response);
    supervisor_pid
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
        // The daemon's startup catalog refresh must never reach the network
        // from a test: PI_OFFLINE keeps it on the bundled/models.json
        // snapshot (the same fallback the picker renders).
        .env("PI_OFFLINE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // The launcher strips inherited worker role env vars before spawning the
    // supervisor; a CLI running inside a daemon worker must not leak them.
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
    // Ambient provider credentials (PRIME_API_KEY on the dev box, or any
    // other provider key variable) must not leak into the daemon's catalog:
    // every spawned supervisor in this verifier serves fixtures whose only
    // configured model comes from a models.json file, so the ambient
    // catalog cannot widen a test's scope. The supervisor strips these from
    // the session workers it spawns too (they inherit its environment).
    for provider in pa_ai::models_generated::get_providers() {
        if let Some(vars) = pa_ai::env_api_keys::get_api_key_env_vars(provider) {
            for var in vars {
                command.env_remove(var);
            }
        }
    }
    command.env_remove("PRIME_TEAM_ID");
    // A supervisor killed by a failing test must not leak its session
    // workers into later test binaries: the worker's supervisor-lost exit
    // (TS `exitIfSupervisorOrphanedForTooLong`) runs on this short window
    // instead of the 5-minute default.
    command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    // A full workspace run around this suite (the battery) can starve a
    // freshly-launched session worker's boot far past the 30s default
    // connect budget; the generous override keeps the suite's session
    // creates deterministic under that load (the supervisor passes its
    // environment to the workers it spawns).
    command.env("PA_DAEMON_WORKER_CONNECT_TIMEOUT_MS", "90000");
    let child = command.spawn().expect("spawn prime-agent --mode daemon");
    let deadline = Instant::now() + Duration::from_mins(1);
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
) -> String {
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
            rest: serde_json::Map::default(),
        })
        .await
        .expect("create session");
    client.close();
    data.get("activeSessionId")
        .or_else(|| data.get("id"))
        .and_then(serde_json::Value::as_str)
        .expect("session id")
        .to_string()
}

#[tokio::test]
async fn tui_attaches_prompts_streams_lists_and_switches() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // A second live session created through the daemon protocol, so the
    // switch target is known by id (not by list position).
    let script = serde_json::json!({ "responses": [
        { "text": "hello from scripted", "delayMs": 20 },
        { "text": "second turn" },
    ] });
    let second = create_session_via_daemon(
        &supervisor.socket,
        &dir.path().join("script.json"),
        &script,
        dir.path(),
        &session_dir,
    )
    .await;

    let options = pa_tui::interactive::InteractiveOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: Some(dir.path().join("script.json")),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::New,
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
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        client_settings: None,
    };
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("hi".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            pa_tui::interactive::HeadlessStep::Submit("again".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            // Session list, then switch to the second session by id: the
            // transcript must rebuild from its (empty) snapshot and the next
            // prompt must run against the switched session.
            pa_tui::interactive::HeadlessStep::Submit("/list".to_string()),
            pa_tui::interactive::HeadlessStep::Submit(format!("/switch {second}")),
            pa_tui::interactive::HeadlessStep::Submit("third".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        ],
        width: 100,
        height: 30,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");

    assert!(!outcome.frames.is_empty(), "frames were captured");
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("hello from scripted"),
        "first scripted turn rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("second turn"),
        "second scripted turn rendered:\n{rendered}"
    );
    assert!(rendered.contains("hi"), "user message echoed:\n{rendered}");
    assert!(
        rendered.contains("again"),
        "queued prompt rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("live sessions:"),
        "session list rendered:\n{rendered}"
    );
    // After the switch, the third prompt ran against the switched session:
    // the scripted engine replays response 0 for it.
    assert!(
        rendered.contains("switched to session"),
        "switch note rendered:\n{rendered}"
    );
    assert_eq!(
        outcome.active_session_id, second,
        "the run ended attached to the switched session"
    );
    assert_eq!(
        outcome.last_assistant_text.as_deref(),
        Some("hello from scripted"),
        "the switched session produced its first scripted turn"
    );

    // Daemon-side verification: both sessions hold their turns.
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(&supervisor.socket)
        .await
        .expect("connect supervisor");
    let last = client
        .request_ok(DaemonCommand::GetLastAssistantText {
            id: None,
            active_session_id: second.clone(),
            rest: serde_json::Map::default(),
        })
        .await
        .expect("get_last_assistant_text");
    assert_eq!(last["text"], "hello from scripted");
    let sessions = client
        .request_ok(DaemonCommand::List {
            id: None,
            all: None,
            cwd: None,
            session_dir: None,
            include_client_owned: None,
            rest: serde_json::Map::default(),
        })
        .await
        .expect("list");
    assert_eq!(
        sessions["sessions"].as_array().map(Vec::len),
        Some(2),
        "both sessions stay live after the TUI exited: {sessions}"
    );
    client.close();

    // The session files are on disk (reattach survives a TUI restart).
    let persisted = std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .flatten()
        .filter(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .count();
    assert_eq!(persisted, 2, "two session files persisted");
    drop(supervisor);
}

/// The product's settings-backed onboarding persistence (the
/// `SettingsOnboardingSink` glue over the public settings manager, minus
/// the best-effort telemetry the e2e harness has no client for).
struct FreshHomeOnboardingSink {
    cwd: PathBuf,
    agent_dir: PathBuf,
}

impl pa_tui::interactive::OnboardingSink for FreshHomeOnboardingSink {
    fn onboarding_shown(&self) -> bool {
        pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir)
            .get_onboarding_shown()
    }

    fn agent_traces_choice_written(&self) -> bool {
        pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir)
            .agent_traces_choice_written()
    }

    fn set_agent_traces_enabled(&self, enabled: bool) -> anyhow::Result<()> {
        pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir)
            .set_agent_traces_enabled(enabled)
    }

    fn mark_onboarding_complete(&self) -> anyhow::Result<()> {
        pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir)
            .set_onboarding_shown(true)
    }
}

/// The product sink whose completion write always fails (the failed
/// persistence path): reads stay real, the marker write errors.
struct FailingMarkOnboardingSink {
    cwd: PathBuf,
    agent_dir: PathBuf,
}

impl pa_tui::interactive::OnboardingSink for FailingMarkOnboardingSink {
    fn onboarding_shown(&self) -> bool {
        pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir)
            .get_onboarding_shown()
    }

    fn agent_traces_choice_written(&self) -> bool {
        pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir)
            .agent_traces_choice_written()
    }

    fn set_agent_traces_enabled(&self, _enabled: bool) -> anyhow::Result<()> {
        Ok(())
    }

    fn mark_onboarding_complete(&self) -> anyhow::Result<()> {
        Err(anyhow::anyhow!("settings disk full"))
    }
}

/// A fresh install asks the trace question exactly once, as the first-run
/// onboarding step — the opt-in moment for trace sharing (sharing ships
/// OFF, so `Share` opts in and `Not now` leaves it off; TS asks
/// unconditionally with the same default). One Enter answers it: the
/// answer and the completion flag persist together, and the released pane
/// runs the submitted turn. The flag then gates the next launch's task
/// mount (the `onboarding_gate_follows_settings_and_auth` unit) and the
/// phase's own marker check, so the question never returns.
#[tokio::test]
async fn fresh_home_asks_the_trace_question_once_and_completes() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    let script = serde_json::json!({ "responses": [
        { "text": "hello fresh home", "delayMs": 20 },
    ] });
    std::fs::write(
        dir.path().join("script.json"),
        serde_json::to_string(&script).expect("script json"),
    )
    .expect("script.json");

    // The task mounts exactly as the product's model-ready gate builds it;
    // the sink persists through the real settings manager.
    let mut options = base_options(&supervisor, dir.path(), &session_dir);
    options.onboarding = Some(pa_tui::interactive::OnboardingTask {
        sink: std::sync::Arc::new(FreshHomeOnboardingSink {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
        }),
        model_ready: std::sync::Arc::new(|| true),
        current_model: None,
        provider_auth: None,
    });
    // Enter answers the mounted question on its pre-selected `Share` row;
    // the submission that follows must reach the editor, not the dialog.
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            )),
            pa_tui::interactive::HeadlessStep::Submit("hi".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        ],
        width: 100,
        height: 30,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");

    // The question owned the pane first, then released it to the session:
    // the answer and the completion flag persisted together.
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("Share agent traces"),
        "the onboarding question rendered once for the fresh home:\n{rendered}"
    );
    assert!(
        rendered.contains("hello fresh home"),
        "the answered dialog released the pane and the first turn ran:\n{rendered}"
    );
    let settings = pa_core::settings::SettingsManager::create(dir.path(), &agent_dir);
    assert!(
        settings.get_onboarding_shown(),
        "the answered flow marked onboarding shown"
    );
    assert!(
        settings.get_agent_traces_enabled(),
        "the pre-selected Share answer persisted"
    );
    drop(supervisor);
}

/// A provisioned home (sharing explicitly opted out, a copied config) never
/// sees the trace question: the standing choice stands and the flow
/// completes silently — the session screen owns the first frame, the
/// submitted prompt runs directly, and only the completion flag is
/// written. (TS #2368 asks such a home the question; the operator's
/// existing-user ruling removes it for the rust port.)
#[tokio::test]
async fn provisioned_opt_out_home_completes_silently_without_the_question() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    // The provisioned opt-out home: copied config, no onboarding flag.
    std::fs::write(
        agent_dir.join("settings.json"),
        r#"{ "agentTraces": { "enabled": false } }"#,
    )
    .expect("provisioned settings");
    let supervisor = spawn_supervisor(dir.path());

    let script = serde_json::json!({ "responses": [
        { "text": "hello provisioned home", "delayMs": 20 },
    ] });
    std::fs::write(
        dir.path().join("script.json"),
        serde_json::to_string(&script).expect("script json"),
    )
    .expect("script.json");

    let mut options = base_options(&supervisor, dir.path(), &session_dir);
    options.onboarding = Some(pa_tui::interactive::OnboardingTask {
        sink: std::sync::Arc::new(FreshHomeOnboardingSink {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
        }),
        model_ready: std::sync::Arc::new(|| true),
        current_model: None,
        provider_auth: None,
    });
    // No key step answers anything: the flow must complete before the
    // plan's submission reaches the editor.
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("hi".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        ],
        width: 100,
        height: 30,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");

    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("hello provisioned home"),
        "the session started directly and completed its first turn:\n{rendered}"
    );
    assert!(
        !rendered.contains("Share agent traces"),
        "the question never owned a session frame:\n{rendered}"
    );

    // The silent completion persists only the flag: the standing opt-out
    // survives untouched and a fresh manager reads the pair, so the gate
    // never mounts the task again.
    let settings = pa_core::settings::SettingsManager::create(dir.path(), &agent_dir);
    assert!(
        !settings.get_agent_traces_enabled(),
        "the standing opt-out survived the silent completion"
    );
    assert!(
        settings.get_onboarding_shown(),
        "the silent flow marked onboarding shown"
    );
    drop(supervisor);
}

/// The scripted provider-auth surface the full-flow verifier drives: the
/// Prime Inference row and its panel-driven login (a progress line, the
/// paste prompt, the store), one api-key provider row (the picker's
/// connect step), and one `mcp:` service row (the picker's exclusion).
/// Credentials persist through the real auth store so the model-readiness
/// probe and the connected marks read them like the product does.
struct FullFlowProviderAuth {
    agent_dir: PathBuf,
}

impl FullFlowProviderAuth {
    fn stored(&self, provider: &str) -> bool {
        pa_core::auth::AuthStorage::create(&self.agent_dir)
            .get_all()
            .credential(provider)
            .is_some()
    }
}

impl pa_tui::provider_auth::ProviderAuthCommands for FullFlowProviderAuth {
    fn login_options(&self) -> pa_tui::provider_auth::ProviderRowsFuture {
        let rows = vec![
            pa_tui::provider_auth::ProviderRow {
                id: pa_tui::provider_auth::PRIME_INFERENCE_PROVIDER_ID.to_string(),
                name: "Prime Inference".to_string(),
                auth_type: pa_tui::provider_auth::AuthType::ApiKey,
                status: Some(pa_tui::provider_auth::AuthStatusIndicator {
                    style: pa_tui::provider_auth::AuthStatusStyle::Success,
                    label: "configured".to_string(),
                }),
                flow: pa_tui::provider_auth::AuthFlow::TerminalFlow,
                configured: self.stored(pa_tui::provider_auth::PRIME_INFERENCE_PROVIDER_ID),
                available: true,
            },
            pa_tui::provider_auth::ProviderRow {
                id: "faux-key".to_string(),
                name: "Faux Key".to_string(),
                auth_type: pa_tui::provider_auth::AuthType::ApiKey,
                status: None,
                flow: pa_tui::provider_auth::AuthFlow::ApiKeyPrompt,
                configured: self.stored("faux-key"),
                available: true,
            },
            pa_tui::provider_auth::ProviderRow {
                id: "mcp:faux".to_string(),
                name: "Faux MCP".to_string(),
                auth_type: pa_tui::provider_auth::AuthType::Oauth,
                status: None,
                flow: pa_tui::provider_auth::AuthFlow::TerminalFlow,
                configured: false,
                available: true,
            },
        ];
        Box::pin(async move { rows })
    }

    fn logout_options(&self) -> pa_tui::provider_auth::ProviderRowsFuture {
        Box::pin(async move { Vec::new() })
    }

    fn login(
        &self,
        provider: &pa_tui::provider_auth::ProviderRow,
        api_key: Option<&str>,
    ) -> pa_tui::provider_auth::ProviderAuthFuture {
        let agent_dir = self.agent_dir.clone();
        let provider_id = provider.id.clone();
        let provider_name = provider.name.clone();
        let key = api_key.map(str::to_string);
        Box::pin(async move {
            let mut auth = pa_core::auth::AuthStorage::create(&agent_dir);
            auth.set(
                &provider_id,
                pa_core::auth::AuthCredential::ApiKey {
                    key: key.unwrap_or_default(),
                    prime_team: None,
                },
            );
            if auth.drain_errors().pop().is_some() {
                return pa_tui::provider_auth::ProviderAuthOutcome::Error(format!(
                    "Failed to save API key for {provider_name}"
                ));
            }
            pa_tui::provider_auth::ProviderAuthOutcome::Status(format!(
                "Saved API key for {provider_name}"
            ))
        })
    }

    fn login_on_panel(
        &self,
        provider: &pa_tui::provider_auth::ProviderRow,
        panel: pa_tui::auth_panel::AuthPanelHandle,
    ) -> pa_tui::provider_auth::ProviderAuthFuture {
        let agent_dir = self.agent_dir.clone();
        let provider_id = provider.id.clone();
        let provider_name = provider.name.clone();
        Box::pin(async move {
            // Only the Prime row runs here (the flow's sign-in step);
            // anything else cancels.
            if provider_id != pa_tui::provider_auth::PRIME_INFERENCE_PROVIDER_ID {
                return pa_tui::provider_auth::ProviderAuthOutcome::Cancelled;
            }
            panel.progress("Checking Prime Inference access...");
            let Some(api_key) = panel
                .paste_prompt(
                    "Paste a Prime API key below:",
                    pa_tui::auth_panel::PasteStyle::Visible,
                )
                .await
            else {
                return pa_tui::provider_auth::ProviderAuthOutcome::Cancelled;
            };
            let mut auth = pa_core::auth::AuthStorage::create(&agent_dir);
            auth.set(
                &provider_id,
                pa_core::auth::AuthCredential::ApiKey {
                    key: api_key,
                    prime_team: None,
                },
            );
            if auth.drain_errors().pop().is_some() {
                return pa_tui::provider_auth::ProviderAuthOutcome::Error(format!(
                    "Failed to login to {provider_name}"
                ));
            }
            pa_tui::provider_auth::ProviderAuthOutcome::Status(format!(
                "Saved API key for {provider_name}. Credentials saved to {}.",
                agent_dir.join("auth.json").display()
            ))
        })
    }

    fn logout(
        &self,
        _provider: &pa_tui::provider_auth::ProviderRow,
    ) -> pa_tui::provider_auth::ProviderAuthFuture {
        Box::pin(async move { pa_tui::provider_auth::ProviderAuthOutcome::Cancelled })
    }
}

/// The full first-run flow on a fresh home with no usable model (TS
/// #2340's `runOnboardingFlow` not-ready branch): the welcome screen's
/// login action starts the flow, the Prime Inference sign-in runs through
/// the inline auth panel (a progress line, the paste prompt), the default
/// GLM 5.3 model applies behind the pane, the connect-more-providers
/// picker connects one more provider through its key prompt and
/// re-mounts with the connected mark, and the trace question ends the
/// flow — every answer, both credentials, and the completion flag
/// persist together, and the released pane runs the submitted turn.
#[tokio::test]
async fn fresh_home_runs_the_full_sign_in_flow_to_completion() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    let script = serde_json::json!({ "responses": [
        { "text": "hello full flow", "delayMs": 20 },
    ] });
    std::fs::write(
        dir.path().join("script.json"),
        serde_json::to_string(&script).expect("script json"),
    )
    .expect("script.json");

    let mut options = base_options(&supervisor, dir.path(), &session_dir);
    // The readiness probe mirrors the flow's contract: the home is not
    // ready until the sign-in stores its credential (the model-ready
    // gate at flow end).
    let probe_agent_dir = agent_dir.clone();
    let model_ready = std::sync::Arc::new(move || {
        pa_core::auth::AuthStorage::create(&probe_agent_dir)
            .get_all()
            .credential(pa_tui::provider_auth::PRIME_INFERENCE_PROVIDER_ID)
            .is_some()
    });
    options.onboarding = Some(pa_tui::interactive::OnboardingTask {
        sink: std::sync::Arc::new(FreshHomeOnboardingSink {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
        }),
        model_ready,
        current_model: None,
        provider_auth: Some(pa_tui::provider_auth::ProviderAuthCommandsHandle(
            std::sync::Arc::new(FullFlowProviderAuth {
                agent_dir: agent_dir.clone(),
            }),
        )),
    });
    let enter = || {
        pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Enter,
            crossterm::event::KeyModifiers::NONE,
        ))
    };
    let down = || {
        pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Down,
            crossterm::event::KeyModifiers::NONE,
        ))
    };
    // The plan waits on observable readiness, not fixed sleeps: each
    // barrier holds the queued batch until a frame rendered after arming
    // contains the condition, so a loaded runner cannot fire keys at a
    // pane whose field or picker has not mounted yet (the pane drive
    // implements the same WaitRender contract the run loop's session
    // steps use).
    let wait_render = |needle: &str| pa_tui::interactive::HeadlessStep::WaitRender {
        needle: needle.to_string(),
        timeout_ms: 5_000,
    };
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            // The welcome screen's login action starts the flow.
            enter(),
            // The Prime sign-in: the paste prompt mounts with the flow.
            wait_render("Paste a Prime API key below:"),
            pa_tui::interactive::HeadlessStep::Type("faux-prime-key".to_string()),
            enter(),
            // The model applies behind the pane, then the picker mounts.
            wait_render("Connect other providers, or continue."),
            // Down to the provider row: Enter runs its key prompt.
            down(),
            enter(),
            wait_render("Enter API key"),
            pa_tui::interactive::HeadlessStep::Type("faux-key".to_string()),
            enter(),
            // The picker re-mounts with the connected mark; Enter on the
            // pinned Continue row ends the step.
            wait_render("\u{2713}"),
            enter(),
            // The trace question: Enter on the pre-selected Share row.
            wait_render("Share agent traces"),
            enter(),
            // The released pane runs the submitted turn.
            pa_tui::interactive::HeadlessStep::Submit("hi".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        ],
        width: 100,
        height: 30,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");

    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("Log in with Prime Intellect"),
        "the welcome screen's action rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("Login with Prime Intellect"),
        "the login dialog's heading replaced the brand line:\n{rendered}"
    );
    assert!(
        rendered.contains("Paste a Prime API key below:"),
        "the paste prompt mounted inside the pane:\n{rendered}"
    );
    assert!(
        rendered.contains("Connect other providers, or continue."),
        "the providers picker rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("Share agent traces"),
        "the trace question ended the flow:\n{rendered}"
    );
    assert!(
        rendered.contains("hello full flow"),
        "the completed flow released the pane and the first turn ran:\n{rendered}"
    );
    // The default-model apply's round trip: the scripted engine refuses
    // live model switches by design (Engine::switch_model returns false
    // for the harness), so the daemon's refusal row is the proof the
    // apply REQUEST reached it and its failure surfaced like TS's
    // applySelectedModel error path — the flow still completes and the
    // marker still writes (the readiness probe reads the registry, not
    // the session).
    assert!(
        rendered.contains("This session does not support model switching"),
        "the apply round-tripped and the scripted engine's refusal surfaced:\n{rendered}"
    );
    // The connected provider's status row shows the store outcome.
    assert!(
        rendered.contains("Saved API key for Faux Key"),
        "the provider login's status row applied:\n{rendered}"
    );

    // Everything persisted together: the flag, the answer, both
    // credentials.
    let settings = pa_core::settings::SettingsManager::create(dir.path(), &agent_dir);
    assert!(
        settings.get_onboarding_shown(),
        "the completed flow marked onboarding shown"
    );
    assert!(
        settings.get_agent_traces_enabled(),
        "the Share answer persisted"
    );
    let auth = pa_core::auth::AuthStorage::create(&agent_dir);
    assert!(
        auth.get_all()
            .credential(pa_tui::provider_auth::PRIME_INFERENCE_PROVIDER_ID)
            .is_some(),
        "the Prime sign-in stored its credential"
    );
    assert!(
        auth.get_all().credential("faux-key").is_some(),
        "the provider login stored its key"
    );
    drop(supervisor);
}

/// A failed completion write surfaces a warning row and never kills the
/// run: a provisioned home whose settings write fails still completes the
/// flow for this run (the session stays usable), the warning names the
/// failed persistence, and the unpersisted marker honestly re-mounts the
/// flow next launch. The run never dies over a settings write.
#[tokio::test]
async fn a_failed_completion_write_surfaces_a_warning_and_never_kills_the_run() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    std::fs::write(
        agent_dir.join("settings.json"),
        r#"{ "agentTraces": { "enabled": false } }"#,
    )
    .expect("provisioned settings");
    let supervisor = spawn_supervisor(dir.path());

    let script = serde_json::json!({ "responses": [
        { "text": "hello despite the write failure", "delayMs": 20 },
    ] });
    std::fs::write(
        dir.path().join("script.json"),
        serde_json::to_string(&script).expect("script json"),
    )
    .expect("script.json");

    let mut options = base_options(&supervisor, dir.path(), &session_dir);
    options.onboarding = Some(pa_tui::interactive::OnboardingTask {
        sink: std::sync::Arc::new(FailingMarkOnboardingSink {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
        }),
        model_ready: std::sync::Arc::new(|| true),
        current_model: None,
        provider_auth: None,
    });
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("hi".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        ],
        width: 100,
        height: 30,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("the run survives the failed write");

    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("hello despite the write failure"),
        "the session ran its first turn despite the failed write:\n{rendered}"
    );
    assert!(
        !rendered.contains("Share agent traces"),
        "the standing choice never re-opened the question:\n{rendered}"
    );
    assert!(
        rendered.contains("could not be saved"),
        "the failed persistence surfaced as a warning row:\n{rendered}"
    );
    // The marker honestly stayed unset: the next launch re-mounts the flow.
    let settings = pa_core::settings::SettingsManager::create(dir.path(), &agent_dir);
    assert!(
        !settings.get_onboarding_shown(),
        "the failed write left the marker unset"
    );
    drop(supervisor);
}

/// The re-show regression: the agents-view flow re-runs the onboarding
/// phase for every session it opens with the SAME task (the task mounts
/// once at startup, then rides the cloned options), so the phase gates on
/// the persisted completion marker itself. A `Not now` answer completes
/// the flow (opt-out + flag together), and a second session opened with
/// the same task starts straight at the session screen — the question
/// never returns, `/traces` stays the change path.
#[tokio::test]
async fn a_completed_flow_never_reopens_the_question_for_a_later_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // One scripted response: the faux queue spans one session (each
    // created session replays from the top), so both runs render the
    // same turn text and the assertions stay per-run.
    let script = serde_json::json!({ "responses": [
        { "text": "hello each session", "delayMs": 20 },
    ] });
    std::fs::write(
        dir.path().join("script.json"),
        serde_json::to_string(&script).expect("script json"),
    )
    .expect("script.json");

    // The SAME options (the same task object) back both session runs, the
    // way `run_agents_view_flow` clones `base` into every session open.
    let mut options = base_options(&supervisor, dir.path(), &session_dir);
    options.onboarding = Some(pa_tui::interactive::OnboardingTask {
        sink: std::sync::Arc::new(FreshHomeOnboardingSink {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
        }),
        model_ready: std::sync::Arc::new(|| true),
        current_model: None,
        provider_auth: None,
    });
    // Down + Enter answers `Not now` (the answer that used to re-show the
    // question on every later session open), then the turn runs.
    let first_plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Down,
                crossterm::event::KeyModifiers::NONE,
            )),
            pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            )),
            pa_tui::interactive::HeadlessStep::Submit("hi".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        ],
        width: 100,
        height: 30,
    };
    let first = pa_tui::interactive::run_interactive(
        options.clone(),
        pa_tui::interactive::UiMode::Headless(first_plan),
    )
    .await
    .expect("first interactive run");
    let first_rendered = first.frames.join("\n");
    assert!(
        first_rendered.contains("Share agent traces"),
        "the fresh home was asked once:\n{first_rendered}"
    );
    assert!(
        first_rendered.contains("hello each session"),
        "the answered dialog released the pane and the first turn ran:\n{first_rendered}"
    );
    let settings = pa_core::settings::SettingsManager::create(dir.path(), &agent_dir);
    assert!(
        !settings.get_agent_traces_enabled(),
        "the Not-now answer persisted (the opt-out)"
    );
    assert!(
        settings.get_onboarding_shown(),
        "the completion flag persisted with the answer"
    );

    // The second session with the same task: no key step answers anything,
    // so the phase must exit before the submission reaches the editor —
    // the persisted marker is the phase's own gate.
    let second_plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("again".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        ],
        width: 100,
        height: 30,
    };
    let second = pa_tui::interactive::run_interactive(
        options,
        pa_tui::interactive::UiMode::Headless(second_plan),
    )
    .await
    .expect("second interactive run");
    let second_rendered = second.frames.join("\n");
    assert!(
        second_rendered.contains("hello each session"),
        "the second session started directly and completed its turn:\n{second_rendered}"
    );
    assert!(
        !second_rendered.contains("Share agent traces"),
        "the completed flow never reopened the question:\n{second_rendered}"
    );
    drop(supervisor);
}

/// The product launch path: `ensure_daemon_running` spawns a detached
/// `prime-agent --mode daemon` when nothing is listening, then the TUI
/// attaches through it.
#[tokio::test]
async fn ensure_daemon_running_spawns_supervisor_and_tui_attaches() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let socket = dir.path().join("spawned.sock");
    std::env::set_var("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir);
    // The internally-spawned supervisor inherits this process's env: give
    // its session workers the short supervisor-lost exit window so a killed
    // supervisor cannot leak them into later test binaries (the
    // `spawn_supervisor` fixture sets the same variable on its children).
    std::env::set_var(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );

    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [{ "text": "spawned hello" }] }).to_string(),
    )
    .expect("write script");

    let options = pa_tui::interactive::InteractiveOptions {
        socket_path: socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: Some(script_path),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::New,
        show_images: true,
        fullscreen_mouse: true,
        initial_message: Some("boot".to_string()),
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
        client_settings: None,
    };
    // The interactive runtime's own launch sequence, minus the TTY: spawn
    // the real supervisor binary detached and wait for the hello handshake.
    let _guard = DetachedDaemon {
        socket: socket.clone(),
    };
    let exe = std::path::PathBuf::from(env!("CARGO_BIN_EXE_prime-agent"));
    pa_cli::ensure_daemon_running_with(&exe, &socket, dir.path())
        .await
        .expect("spawn the daemon");
    let outcome = pa_tui::interactive::run_interactive(
        options,
        pa_tui::interactive::UiMode::Headless(pa_tui::interactive::HeadlessPlan {
            steps: vec![pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 }],
            width: 80,
            height: 24,
        }),
    )
    .await
    .expect("headless interactive run");
    assert!(
        outcome
            .frames
            .iter()
            .any(|frame| frame.contains("spawned hello")),
        "initial message ran against the spawned daemon:\n{}",
        outcome.frames.join("\n")
    );
    assert_eq!(
        outcome.last_assistant_text.as_deref(),
        Some("spawned hello")
    );

    // The product contract under test: shut the spawned supervisor down by
    // protocol and require the process tree to actually exit (the guard
    // stays as the panic backstop; this call asserts the clean stop).
    assert_daemon_stops_clean(&socket);
}

/// Slash-command dispatch over a live scripted session: the session command
/// executes in the worker (durable echo + result rows reach the transcript
/// and the session file), client commands without a UI report
/// unavailability, unknown commands get the TS suggestion error, and the
/// autocomplete menu renders from the shared registry.
#[tokio::test]
async fn tui_dispatches_slash_commands_menu_and_suggestions() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // The faux engine (`engine: "faux"`) drives the real agent engine over
    // the scripted faux provider, so the worker's session-command admission
    // path runs exactly as in the product.
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "scripted reply" },
    ] });
    std::fs::write(dir.path().join("script.json"), script.to_string()).expect("write script");
    let options = pa_tui::interactive::InteractiveOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: Some(dir.path().join("script.json")),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::New,
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
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        client_settings: None,
    };
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            // A session command runs in the worker and its durable rows
            // render (echo + result).
            pa_tui::interactive::HeadlessStep::Submit("/goal status".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            // Unknown command: the exact TS suggestion error.
            pa_tui::interactive::HeadlessStep::Submit("/modle".to_string()),
            // The autocomplete menu: typed input like a user keystroke by
            // keystroke, completed with Enter, then submitted.
            pa_tui::interactive::HeadlessStep::Type("/".to_string()),
            // A real user pauses between keystrokes: the parked suggestion
            // request materializes (the dropdown opens) before Enter, the
            // state the terminal loop reaches after one input-idle tick.
            pa_tui::interactive::HeadlessStep::SettleIdle,
            pa_tui::interactive::HeadlessStep::Type("goa".to_string()),
            pa_tui::interactive::HeadlessStep::SettleIdle,
            // With the dropdown open, Enter completes the selected
            // suggestion (`/goal `); the second Enter submits it.
            pa_tui::interactive::HeadlessStep::Type("\n".to_string()),
            pa_tui::interactive::HeadlessStep::Type("\n".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            // `/model` LAST: the inline menu-panel opens and owns the keys
            // from here on (TS `showConfigurationMenu`).
            pa_tui::interactive::HeadlessStep::Submit("/model".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");

    // Verification seam: dump the captured frames for manual frame-diffing
    // against the TS product (PA_TUI_DUMP_FRAMES=<dir>).
    if let Ok(dir) = std::env::var("PA_TUI_DUMP_FRAMES") {
        for (index, frame) in outcome.frames.iter().enumerate() {
            let _ = std::fs::write(
                std::path::Path::new(&dir).join(format!("frame-{index:03}.txt")),
                frame,
            );
        }
    }
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("/goal status"),
        "the session-command echo row rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("No active goal."),
        "the session-command result row rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("Unknown command: /modle. Did you mean /model?"),
        "the unknown-command suggestion matched the TS string:\n{rendered}"
    );
    assert!(
        rendered.contains("Search models"),
        "the /model command opened the inline menu-panel:\n{rendered}"
    );
    assert!(
        rendered.contains("Enter select \u{b7} Esc close"),
        "the menu-panel hint rendered:\n{rendered}"
    );
    // The menu: the first registry entry is selected at `/`, and `/goa`
    // fuzzy-matches to the goal command.
    assert!(
        rendered.contains("\u{203a} settings"),
        "the slash menu rendered with the selected first entry:\n{rendered}"
    );
    assert!(
        rendered.contains("Open settings menu"),
        "the selected item's description rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("\u{203a} goal"),
        "the fuzzy best match for /goa rendered selected:\n{rendered}"
    );

    // The durable rows persisted: the session file carries the echo and
    // result custom entries for both executions.
    let mut saw_echo = false;
    let mut saw_result = false;
    for entry in std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        saw_echo |= content.contains("\"session_slash_command\"");
        saw_result |= content.contains("\"session_slash_command_result\"");
    }
    assert!(
        saw_echo,
        "the session file persisted the session_slash_command rows"
    );
    assert!(
        saw_result,
        "the session file persisted the session_slash_command_result rows"
    );
    drop(supervisor);
}

/// The `/model` picker + `/effort` surface, end to end through the daemon:
/// a models.json custom model lists in the picker (name label), Enter
/// applies it through the daemon `set_model` command (durable `model_change`
/// row + the TS `Model: <id>` confirm row), and `/effort` on a model without
/// reasoning reports the TS unsupported note (the thinking-level plumbing:
/// the worker reports the model's supported levels, the client treats an
/// `off`-only list as no thinking).
#[tokio::test]
async fn tui_model_picker_applies_and_effort_reports() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    // The battery layout: a custom provider in models.json carries the
    // model (id, name, endpoint), so it resolves without any network.
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::json!({
            "providers": {
                "test-provider": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9/v1",
                    "apiKey": "sk-test",
                    "models": [
                        { "id": "mock-1", "name": "Mock 1", "api": "openai-completions",
                          "baseUrl": "http://127.0.0.1:9/v1", "contextWindow": 128_000,
                          "maxTokens": 4096 }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "scripted reply" },
    ] });
    std::fs::write(dir.path().join("script.json"), script.to_string()).expect("write script");
    let supervisor = spawn_supervisor(dir.path());
    // The catalog snapshot the composition root injects (available models
    // over the same registry). The registry scope is pinned hermetically:
    // the auth storage reads no ambient environment, so an ambient provider
    // credential (PRIME_API_KEY on the dev box makes every bundled
    // prime-inference model available) cannot leak the bundled catalog in —
    // the models.json mock is the ONLY available model, per the assertion's
    // intent. `spawn_supervisor` strips the same variables from the daemon
    // side.
    let auth = pa_core::auth::AuthStorage::in_memory_without_env(
        pa_core::auth::AuthStorageData::default(),
        std::sync::Arc::new(pa_core::auth::NoOAuth),
    );
    let mut registry = pa_core::models::ModelRegistry::create(auth, agent_dir.join("models.json"));
    registry.load_private_authorization_from_cache();
    let catalog: Vec<pa_types::ai::Model> = registry.get_available().into_iter().cloned().collect();
    assert_eq!(catalog.len(), 1, "the models.json model resolves available");
    assert_eq!(
        catalog[0].id, "mock-1",
        "the one available model is the models.json mock"
    );

    let options = pa_tui::interactive::InteractiveOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: Some(dir.path().join("script.json")),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: catalog,
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::New,
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
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        client_settings: None,
    };
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("/model".to_string()),
            pa_tui::interactive::HeadlessStep::Type("mock".to_string()),
            pa_tui::interactive::HeadlessStep::Type("\n".to_string()),
            pa_tui::interactive::HeadlessStep::Submit("/effort".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("Mock 1"),
        "the /model picker listed the models.json model by name:\n{rendered}"
    );
    assert!(
        rendered.contains("Model: mock-1"),
        "picking the model showed the TS confirm row:\n{rendered}"
    );
    assert!(
        rendered.contains("Current model does not support thinking"),
        "the /effort command reported the TS unsupported-model note:\n{rendered}"
    );

    // The durable rows persisted: the creation-prefix `model_change` plus
    // the switch's own row (TS `appendModelChange` runs on every switch,
    // even to the current model).
    let mut model_changes = 0;
    for entry in std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        model_changes += content
            .lines()
            .filter(|line| line.contains(r#""type":"model_change""#))
            .count();
    }
    assert!(
        model_changes >= 2,
        "the set_model switch persisted its model_change row (saw {model_changes})"
    );
    drop(supervisor);
}

/// `/effort` on a thinking-capable model whose `reasoning` flag is false
/// but whose `thinkingLevelMap` declares addressable levels (the live
/// catalog's `gpt-5.3-chat-latest` shape): the map is the capability
/// signal, so the command applies the level instead of reporting the
/// unsupported-model note. No scripted engine runs — the switch and the
/// state read must resolve the models.json model, not the faux one.
#[tokio::test]
async fn tui_effort_applies_on_a_map_addressable_model_without_the_reasoning_flag() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::json!({
            "providers": {
                "test-provider": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9/v1",
                    "apiKey": "sk-test",
                    "models": [
                        { "id": "chat-plus", "name": "Chat Plus", "reasoning": false,
                          "thinkingLevelMap": { "off": null, "xhigh": "xhigh" },
                          "baseUrl": "http://127.0.0.1:9/v1", "contextWindow": 128_000,
                          "maxTokens": 4096 }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    let supervisor = spawn_supervisor(dir.path());
    let auth = pa_core::auth::AuthStorage::in_memory_without_env(
        pa_core::auth::AuthStorageData::default(),
        std::sync::Arc::new(pa_core::auth::NoOAuth),
    );
    let mut registry = pa_core::models::ModelRegistry::create(auth, agent_dir.join("models.json"));
    registry.load_private_authorization_from_cache();
    let catalog: Vec<pa_types::ai::Model> = registry.get_available().into_iter().cloned().collect();
    assert_eq!(catalog.len(), 1, "the models.json model resolves available");
    assert_eq!(catalog[0].id, "chat-plus");

    let options = pa_tui::interactive::InteractiveOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: None,
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: catalog,
        model_configured_providers: ["test-provider".to_string()].into_iter().collect(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::New,
        show_images: true,
        client_settings: None,
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
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
    };
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            pa_tui::interactive::HeadlessStep::Submit("/model".to_string()),
            pa_tui::interactive::HeadlessStep::Type("chat".to_string()),
            pa_tui::interactive::HeadlessStep::Type("\n".to_string()),
            pa_tui::interactive::HeadlessStep::Submit("/effort xhigh".to_string()),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("Model: chat-plus"),
        "picking the model showed the TS confirm row:\n{rendered}"
    );
    assert!(
        rendered.contains("Thinking level: xhigh"),
        "the /effort command applied the map's addressable level:\n{rendered}"
    );
    assert!(
        !rendered.contains("Current model does not support thinking"),
        "a map-addressable model must not report the unsupported-model note:\n{rendered}"
    );

    // The durable `thinking_level_change` row persisted for the applied
    // level (TS `appendThinkingLevelChange` on an effective change).
    let mut level_changes = 0;
    for entry in std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        level_changes += content
            .lines()
            .filter(|line| line.contains(r#""type":"thinking_level_change""#))
            .filter(|line| line.contains("xhigh"))
            .count();
    }
    assert!(
        level_changes >= 1,
        "the thinking_level_change row persisted at xhigh (saw {level_changes})"
    );
    drop(supervisor);
}

/// `/compact` on a fresh session: the compaction skips (TS
/// `CompactionSkippedError`) and the warning reaches the transcript through
/// the `compaction_end` event, with the durable echo row — TS's live
/// `showWarning` on the manual compaction path.
#[tokio::test]
async fn tui_compact_on_a_short_session_warns_nothing_to_compact() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // The real agent engine over the scripted faux provider: the skip path
    // never reaches the provider, so the script stays unused.
    let script = serde_json::json!({ "engine": "faux", "responses": [] });
    std::fs::write(dir.path().join("script.json"), script.to_string()).expect("write script");
    let options = pa_tui::interactive::InteractiveOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: Some(dir.path().join("script.json")),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::New,
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
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        client_settings: None,
    };
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("/compact".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        ],
        width: 100,
        height: 30,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    // Verification seam: dump the captured frames for manual frame-diffing
    // against the TS product (PA_TUI_DUMP_FRAMES=<dir>).
    if let Ok(dump) = std::env::var("PA_TUI_DUMP_FRAMES") {
        for (index, frame) in outcome.frames.iter().enumerate() {
            let _ = std::fs::write(
                std::path::Path::new(&dump).join(format!("skip-frame-{index:03}.txt")),
                frame,
            );
        }
    }
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("/compact"),
        "the session-command echo row rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("Session is too short to compact"),
        "the skip warning rendered (TS compaction_end errorMessage):\n{rendered}"
    );
    // The skip records no durable result row (TS's queued-command catch arm
    // stays silent): only the echo row persisted.
    let mut saw_compaction_entry = false;
    let mut saw_result_row = false;
    for entry in std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        saw_compaction_entry |= content.contains("\"type\":\"compaction\"");
        saw_result_row |= content.contains("\"session_slash_command_result\"");
    }
    assert!(
        !saw_compaction_entry,
        "a skipped compaction persisted no compaction entry"
    );
    assert!(
        !saw_result_row,
        "a skipped compaction persisted no result row"
    );
    drop(supervisor);
}

/// `/compact` on a grown session: the compaction loader replaces the working
/// loader while the summarizer runs (TS `startCompactionLoader`), then the
/// summary row renders (TS `CompactionSummaryMessageComponent`) at the head
/// of the rebuilt transcript (TS `rebuildChatFromMessages`). The loader row
/// is a soft evidence capture (its in-flight window is delayMs-paced and a
/// loaded box can batch the whole window past the paint loop; the strict
/// loader assertion is the f14 battery flow, `scripts/compact_parity.py`);
/// the settled outcome — the summary row, the rebuilt transcript, and the
/// retained tail — carries the hard asserts.
#[tokio::test]
async fn tui_compact_shows_the_loader_then_the_summary_and_rebuilds() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    // TS `getCompactionSettings` feeds every compaction path, `/compact`
    // included: the settings-pinned cut budget keeps this run small while
    // exercising the same keep-recent cut the default budget drives.
    std::fs::write(
        agent_dir.join("settings.json"),
        serde_json::json!({ "compaction": { "keepRecentTokens": 10 } }).to_string(),
    )
    .expect("write settings");
    let supervisor = spawn_supervisor(dir.path());

    // The compact_parity.py session shape (TS-binary-verified): a large
    // first turn gives the compactor history to summarize, the small
    // second turn crosses the 10-token keep-recent budget AT its user
    // message — a non-split cut that keeps the whole second turn — and
    // the third scripted response is the summarizer's summary. Its delay
    // holds the compaction in flight for the loader window: 1.5s is the
    // load-realistic bound (the healthy loop paints hundreds of frames
    // in that window, so the loader evidence below still captures on the
    // mission box's ambient daemon load — at the original 300ms the loop
    // stalled past the window in ~half the runs, batching the start and
    // finish events into one iteration). The cut must stay on the user
    // message: a mid-turn (assistant) cut is a split-turn compaction that
    // makes TWO summarizer wire calls (TS parity), which this
    // single-summary script does not serve.
    let filler = "history ".repeat(150);
    let script = serde_json::json!({
        "engine": "faux",
        "responses": [
            { "text": filler, "delayMs": 20 },
            { "text": "second turn done, kept intact" },
            { "text": "## Summary\nthe session story", "delayMs": 1500 },
        ],
    });
    std::fs::write(dir.path().join("script.json"), script.to_string()).expect("write script");
    let options = pa_tui::interactive::InteractiveOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: Some(dir.path().join("script.json")),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::New,
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
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        client_settings: None,
    };
    let ctrl_o = || {
        pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('o'),
            crossterm::event::KeyModifiers::CONTROL,
        ))
    };
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("first".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            pa_tui::interactive::HeadlessStep::Submit(
                "second, and please keep this second parity turn short and intact".to_string(),
            ),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            pa_tui::interactive::HeadlessStep::Submit("/compact focus on the goal".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            // The collapsible block (TS `applyChatExpansion` fanning
            // `toolOutputExpanded` into `CompactionSummaryMessageComponent`):
            // Ctrl+O twice walks overview -> details -> all, expanding the
            // summary into the markdown body plus the token metadata; the
            // third press wraps back to overview and re-collapses it.
            ctrl_o(),
            ctrl_o(),
            pa_tui::interactive::HeadlessStep::SettleIdle,
            ctrl_o(),
            pa_tui::interactive::HeadlessStep::SettleIdle,
        ],
        width: 100,
        height: 30,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");

    // Verification seam: dump the captured frames for manual frame-diffing
    // against the TS product (PA_TUI_DUMP_FRAMES=<dir>).
    if let Ok(dump) = std::env::var("PA_TUI_DUMP_FRAMES") {
        for (index, frame) in outcome.frames.iter().enumerate() {
            let _ = std::fs::write(
                std::path::Path::new(&dump).join(format!("compact-frame-{index:03}.txt")),
                frame,
            );
        }
    }
    let rendered = outcome.frames.join("\n");
    // The loader (TS `Compacting context (focus: ...)... (Ctrl+C to
    // cancel)`) is a soft, best-effort capture: its in-flight window is
    // delayMs-paced, and on a box loaded by the fleet's daemons the render
    // loop can stall past the whole window — the compaction-started and
    // compaction-finished events then apply in one batched iteration (the
    // loop drains the queued events before it paints), so no captured frame
    // ever shows the loader row. Any finite pacing window leaves that race,
    // so the strict frame-level loader assertion lives in
    // scripts/compact_parity.py (the f14 battery flow, run on an idle box
    // or a sandbox). Here the observed loader row is evidence only; the hard
    // asserts below pin the settled outcome — the parity-critical claims.
    let loader = "Compacting context (focus: focus on the goal)... (Ctrl+C to cancel)";
    let loader_frames = outcome
        .frames
        .iter()
        .filter(|frame| frame.contains(loader))
        .count();
    println!(
        "compaction loader evidence: {loader_frames} frames captured the loader row (soft check; the strict assertion is scripts/compact_parity.py)"
    );
    // The summary row: the TS header plus the collapsed summary.
    assert!(
        rendered.contains("\u{25c6} Context compacted"),
        "the compaction summary header rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("the session story"),
        "the summary text rendered:\n{rendered}"
    );
    // The rebuilt transcript presents the retained tail first, then the
    // summary (TS `orderMessagesForTranscript`): the settled bottom-follow
    // frame shows the retained second turn above the summary row, and the
    // compacted-away first turn is gone.
    let last = outcome.frames.last().expect("the settled frame");
    assert!(
        last.contains("kept intact"),
        "the retained second turn heads the rebuilt transcript:\n{last}"
    );
    assert!(
        last.contains("\u{25c6} Context compacted"),
        "the summary row follows the retained tail:\n{last}"
    );
    assert!(
        !last.contains("first"),
        "the compacted-away first turn dropped from the rebuilt transcript:\n{last}"
    );

    // The collapsible block: the expanded frames show the markdown body and
    // the dim metadata row (TS `new Markdown(summary, ...)` + the
    // `Compacted from N tokens \u{b7} focus: ...` row); the wrap back to
    // overview re-collapses (the `EventSummary` returns, metadata gone).
    let expanded = outcome
        .frames
        .iter()
        .find(|frame| frame.contains("Compacted from"))
        .expect("some frame captured the expanded compaction block");
    assert!(
        expanded.contains("Compacted from") && expanded.contains("tokens"),
        "the expanded metadata row:\n{expanded}"
    );
    assert!(
        expanded.contains("\u{b7} focus: focus on the goal"),
        "the /compact focus rides the expanded metadata:\n{expanded}"
    );
    assert!(
        expanded.contains("Summary") && !expanded.contains("## Summary"),
        "the expanded body renders the summary markdown, not the EventSummary flatten:\n{expanded}"
    );
    assert!(
        !last.contains("Compacted from"),
        "the third Ctrl+O re-collapsed the block:\n{last}"
    );

    // The compaction entry persisted (the durable `compaction` record).
    let mut saw_compaction_entry = false;
    for entry in std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        saw_compaction_entry |= content.contains("\"type\":\"compaction\"");
    }
    assert!(
        saw_compaction_entry,
        "the compaction entry persisted to the session file"
    );
    drop(supervisor);
}

/// Session-tree verifier: two scripted turns, then `/tree` navigation back
/// to the first user message, a fork from it, and a clone at the leaf.
/// Exercises the full loop the TS `/tree` surface owns: the `get_session_tree`
/// fetch, the selector pane, the "Summarize branch?" choice, `navigate_tree`
/// (branch move + transcript rebuild + editor text restore), `fork` (new
/// session file), and the leaf no-op.
#[tokio::test]
async fn tui_session_tree_navigates_forks_and_clones() {
    use crossterm::event::{KeyCode, KeyModifiers};

    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({
        "engine": "faux",
        "responses": [
            { "text": "first answer", "delayMs": 10 },
            { "text": "second answer", "delayMs": 10 },
            { "text": "post-fork answer", "delayMs": 10 },
        ],
    });
    std::fs::write(dir.path().join("script.json"), script.to_string()).expect("write script");
    let options = pa_tui::interactive::InteractiveOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: Some(dir.path().join("script.json")),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::New,
        initial_message: None,
        theme: "prime".to_string(),
        code_block_indent: "  ".to_string(),
        // The default tree filter keeps every message row visible, and the
        // branch-summary prompt is skipped so navigation needs no
        // summarizer call (TS `branchSummary.skipPrompt`).
        tree_filter_mode: "default".to_string(),
        branch_summary_skip_prompt: true,
        show_images: true,
        fullscreen_mouse: true,
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
        client_settings: None,
    };
    let key = |code: KeyCode| {
        pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
            code,
            KeyModifiers::NONE,
        ))
    };
    let enter = key(KeyCode::Enter);
    let up = key(KeyCode::Up);
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("first question".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            pa_tui::interactive::HeadlessStep::Submit("second question".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            // `/tree` opens the selector; Enter on the leaf is the TS no-op.
            pa_tui::interactive::HeadlessStep::Submit("/tree".to_string()),
            pa_tui::interactive::HeadlessStep::SettleIdle,
            enter.clone(),
            pa_tui::interactive::HeadlessStep::SettleIdle,
            // `/fork` opens the user-message selector; Enter forks before
            // the selected (latest) user message.
            pa_tui::interactive::HeadlessStep::Submit("/fork".to_string()),
            pa_tui::interactive::HeadlessStep::SettleIdle,
            enter.clone(),
            pa_tui::interactive::HeadlessStep::SettleIdle,
            // The fork re-entered the user message in the editor; submit
            // runs it on the forked session.
            enter.clone(),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            // `/tree` again, then navigate two rows up (the first answer)
            // to cut the branch back to that point.
            pa_tui::interactive::HeadlessStep::Submit("/tree".to_string()),
            pa_tui::interactive::HeadlessStep::SettleIdle,
            up.clone(),
            up.clone(),
            enter.clone(),
            pa_tui::interactive::HeadlessStep::SettleIdle,
        ],
        width: 100,
        height: 34,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    if let Ok(dump) = std::env::var("PA_TUI_DUMP_FRAMES") {
        for (index, frame) in outcome.frames.iter().enumerate() {
            let _ = std::fs::write(
                std::path::Path::new(&dump).join(format!("tree-frame-{index:03}.txt")),
                frame,
            );
        }
    }
    let rendered = outcome.frames.join("\n");
    // The selector pane (TS `TreeSelectorComponent` layout).
    assert!(
        rendered.contains("Session Tree"),
        "the tree pane rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("Type to search:"),
        "the search line rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("user: first question") && rendered.contains("user: second question"),
        "the entry rows rendered:\n{rendered}"
    );
    // The leaf no-op note (TS `showStatus("Already at this point")`).
    assert!(
        rendered.contains("Already at this point"),
        "the leaf selection was a no-op:\n{rendered}"
    );
    // The fork (TS `showUserMessageSelector` + `showStatus("Forked to new
    // session")`).
    assert!(
        rendered.contains("Fork from Message"),
        "the fork selector rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("Forked to new session"),
        "the fork note rendered:\n{rendered}"
    );
    // The forked session kept the pre-fork path and answered the re-entered
    // user message with its own scripted turn.
    assert!(
        rendered.contains("post-fork answer"),
        "the forked session ran a turn:\n{rendered}"
    );
    // The navigation: TS `showStatus("Navigated to selected point")` plus
    // the transcript rebuilt on the moved branch (the abandoned turn drops
    // from the settled frame).
    assert!(
        rendered.contains("Navigated to selected point"),
        "the navigation note rendered:\n{rendered}"
    );
    let settled = outcome
        .frames
        .iter()
        .rev()
        .find(|frame| frame.contains("Navigated to selected point"))
        .expect("the navigation frame");
    assert!(
        !settled.contains("post-fork answer"),
        "the abandoned branch dropped from the rebuilt transcript:\n{settled}"
    );
    assert!(
        settled.contains("first answer"),
        "the moved branch kept the target path:\n{settled}"
    );
    // The fork created a second session file.
    let session_files: Vec<_> = std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .flatten()
        .filter(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect();
    assert!(
        session_files.len() >= 2,
        "the fork wrote a new session file: {} files",
        session_files.len()
    );
    drop(supervisor);
}

/// Streaming-throughput verifier: two big (~12k-token) unpaced faux turns
/// must render at the producer's rate, not at a fixed frame-rate ceiling.
/// The worker coalesces provider deltas into latest-snapshot frames (at
/// most one per flush tick), so a burst of ~3000 deltas lands as a handful
/// of wire frames and the turn settles within seconds. The pre-fix
/// regression broadcast one wire frame per delta and the TUI starved at
/// the tick rate: a single turn rendered for over a minute.
#[tokio::test]
async fn tui_big_streamed_turns_render_at_the_producer_rate() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // Two ~12k-token fillers (chars/4 estimate), unpaced: the faux provider
    // streams each as ~3000 full-partial deltas as fast as it can. Every
    // ~250-word segment carries a MARK-nn marker so mid-turn frames prove
    // the applied content progressed instead of jumping once at turn end.
    let mut filler = String::new();
    for segment in 0..24 {
        let _ = write!(filler, "MARK-{segment:02} ");
        filler.push_str(&"history ".repeat(250));
    }
    // Paced at 3000 tokens/second so the ~12k-token turn streams for
    // ~4s: the mid-turn marker-progression assertion needs several wire
    // updates inside the turn (an unpaced faux finishes in ~0.3s and the
    // whole stream lands in a handful of frames). The 45s settle bound is
    // calibrated against the producer pace with a load-realistic margin: a
    // healthy render settles in seconds even on a loaded box, while the
    // pre-fix starvation pipeline (one ~4-token delta per 50ms tick) took
    // 150+ seconds per turn — an order of magnitude past the bound.
    let script = serde_json::json!({
        "engine": "faux",
        "tokensPerSecond": 3_000,
        "responses": [
            { "text": filler.clone() },
            { "text": format!("{filler}second big turn done, tail marker intact") },
        ],
    });
    std::fs::write(dir.path().join("script.json"), script.to_string()).expect("write script");
    let options = pa_tui::interactive::InteractiveOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: Some(dir.path().join("script.json")),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::New,
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
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        client_settings: None,
    };
    // 45s per turn is the throughput bound: the producer finishes each
    // turn in ~4s, so 45s tolerates real box load (sibling e2e binaries,
    // daemons from other suites) while a starved render — 150+ seconds per
    // turn before the fix — still expires the barrier with margin.
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("first".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 45_000 },
            pa_tui::interactive::HeadlessStep::Submit("second".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 45_000 },
        ],
        width: 100,
        height: 30,
    };
    let started = Instant::now();
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let wall = started.elapsed();

    // Verification seam: dump the captured frames for manual frame-diffing
    // against the TS product (PA_TUI_DUMP_FRAMES=<dir>).
    if let Ok(dump) = std::env::var("PA_TUI_DUMP_FRAMES") {
        for (index, frame) in outcome.frames.iter().enumerate() {
            let _ = std::fs::write(
                std::path::Path::new(&dump).join(format!("stream-frame-{index:03}.txt")),
                frame,
            );
        }
    }
    let rendered = outcome.frames.join("\n");
    assert!(
        !rendered.contains("timed out waiting for the turn to finish"),
        "a WaitIdle barrier expired; the render starved behind the stream:\n{rendered}"
    );
    // Both turns settled with their full text (the window follows the
    // tail, so the second turn's marker is the strongest full-render proof).
    assert!(
        rendered.contains("tail marker intact"),
        "the second big turn fully rendered:\n{rendered}"
    );
    assert_eq!(
        outcome.last_assistant_text.as_deref(),
        Some(format!("{filler}second big turn done, tail marker intact").as_str()),
        "the final assistant text is the full second turn"
    );
    // The applied content progressed mid-turn: the tail-following window
    // showed a growing run of segment markers while the turn streamed (a
    // starved pipeline shows the whole turn once at its end, so only the
    // final markers would ever appear).
    let marks: std::collections::BTreeSet<String> = outcome
        .frames
        .iter()
        .flat_map(|frame| frame.lines())
        .flat_map(|line| line.split_whitespace())
        .filter(|word| word.starts_with("MARK-"))
        .map(std::string::ToString::to_string)
        .collect();
    assert!(
        marks.len() >= 5,
        "only {len} segment markers ever rendered mid-turn (needs >= 5); the applied stream starved",
        len = marks.len()
    );
    assert!(
        wall < Duration::from_secs(100),
        "the whole run took {wall:?}; the turn render must keep up with the producer"
    );
    drop(supervisor);
}

/// User-keybinding verifier (TS `keybindings.json` parity, roadmap item
/// "keybinding customization"): a settings fixture rebinding
/// `app.tools.expand` from `ctrl+o` to `ctrl+alt+x` drives the whole
/// surface — the prompt-context hint renders the OVERRIDE key, the
/// override key fires the action, the default key no longer does, and
/// `/hotkeys` documents the effective binding instead of the default.
#[tokio::test]
async fn tui_renders_and_fires_user_keybindings_from_settings() {
    use crossterm::event::{KeyCode, KeyModifiers};

    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    // The settings fixture: one binding overridden exactly like a user's
    // `~/.prime/agent/keybindings.json` would.
    std::fs::write(
        agent_dir.join("keybindings.json"),
        r#"{ "app.tools.expand": "ctrl+alt+x" }"#,
    )
    .expect("write keybindings.json");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({
        "engine": "faux",
        "responses": [{ "text": "scripted reply", "delayMs": 10 }],
    });
    std::fs::write(dir.path().join("script.json"), script.to_string()).expect("write script");

    let options = pa_tui::interactive::InteractiveOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: Some(dir.path().join("script.json")),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::new(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::New,
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
        // The exact load path the CLI uses: the fixture overrides the
        // default set.
        keybindings: pa_tui::keybindings::KeybindingsManager::create(&agent_dir),
        session_rlm_depth: None,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        client_settings: None,
    };
    let key = |code: KeyCode, modifiers: KeyModifiers| {
        pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(code, modifiers))
    };
    let ctrl_alt_x = key(
        KeyCode::Char('x'),
        KeyModifiers::CONTROL | KeyModifiers::ALT,
    );
    let ctrl_o = key(KeyCode::Char('o'), KeyModifiers::CONTROL);
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            // One scripted turn so the transcript holds a rendered reply.
            pa_tui::interactive::HeadlessStep::Submit("hello".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            // The user's key fires the rebound action: overview -> details.
            ctrl_alt_x,
            // The default key must no longer fire it (a second cycle would
            // reach the "all" mode).
            ctrl_o,
            // The documentation surface renders the effective binding.
            pa_tui::interactive::HeadlessStep::Submit("/hotkeys".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            // The `?` quick-shortcut guide (app.shortcuts) mounts with the
            // effective bindings; the next submission clears it.
            pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Char('?'),
                crossterm::event::KeyModifiers::NONE,
            )),
            pa_tui::interactive::HeadlessStep::Submit("done".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        ],
        width: 120,
        // Tall enough that the whole `/hotkeys` guide (the expandTools row
        // ~30 rows in) renders inside the visible transcript window.
        height: 60,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = outcome.frames.join("\n");

    // The hint renders the user's binding, not the default, at the
    // startup detail level (TS #2447: chats start at the middle
    // `details` level).
    assert!(
        rendered.contains("Details mode (Ctrl+Alt+X to expand)"),
        "the prompt-context hint renders the override:\n{rendered}"
    );
    // The override key fired the action: the detail cycled to the
    // expanded level.
    assert!(
        rendered.contains("Expanded mode (Ctrl+Alt+X to collapse)"),
        "the override key cycled conversation detail:\n{rendered}"
    );
    // The default key leaves the detail unchanged: the cycle never wraps
    // back to the collapsed overview mode.
    assert!(
        !rendered.contains("Collapsed mode (Ctrl+Alt+X to expand)"),
        "the default ctrl+o must not cycle after the override:\n{rendered}"
    );
    // The scripted turn still ran under the custom bindings.
    assert!(
        rendered.contains("scripted reply"),
        "the scripted turn rendered:\n{rendered}"
    );
    // `/hotkeys` documents the effective binding. The guide renders as
    // markdown, so the table is a bordered grid ("| Ctrl+Alt+X | Cycle
    // overview ..."), not the raw markdown source.
    assert!(
        rendered.contains("Ctrl+Alt+X"),
        "the hotkeys guide renders the override:\n{rendered}"
    );
    assert!(
        rendered.contains("Cycle overview"),
        "the hotkeys guide renders the expand row:\n{rendered}"
    );
    assert!(
        rendered.contains("Clear input / cancel autocomplete"),
        "the hotkeys guide renders the default rows:\n{rendered}"
    );
    // The removed default key is gone from the guide (no other default
    // binding uses ctrl+o).
    assert!(
        !rendered.contains("Ctrl+O"),
        "the hotkeys guide must not show the removed default:\n{rendered}"
    );
    // The `?` quick-shortcut guide mounted (TS `showShortcutGuide`): the
    // effective override renders in its Controls row and the Help line
    // references `/hotkeys`.
    assert!(
        rendered.contains("quick shortcuts \u{b7} /hotkeys full reference"),
        "the quick-shortcut guide rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("Ctrl+Alt+X overview"),
        "the quick-shortcut guide renders the override in the Controls row:\n{rendered}"
    );
    // The final submission cleared the guide (TS `clearShortcutGuide`).
    let last = outcome.frames.last().expect("frames");
    assert!(
        !last.contains("shell mode"),
        "the submission cleared the quick-shortcut guide:\n{last}"
    );
    drop(supervisor);
}

/// The visible follow-up queue (TS `queuedMessagesContainer`): prompts
/// submitted while a turn runs park on their lanes — Enter on the steering
/// lane, the follow-up key on the follow-up lane — and render as dim
/// preview rows above the prompt dock with the browse hint. The strip
/// clears as the queue drains behind the run.
#[tokio::test]
async fn tui_prompts_queued_behind_a_turn_render_the_queue_strip() {
    use crossterm::event::{KeyCode, KeyModifiers};
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // The first turn holds in flight for 1.5s (`delayMs`): the parked
    // submissions land inside that window, deterministically busy (the
    // runner flips `busy` when it pops the work, long before the 750ms
    // barrier below).
    let script_path = dir.path().join("script.json");
    let script = serde_json::json!({ "responses": [
        { "text": "first turn", "delayMs": 1500 },
        { "text": "steered delivery" },
        { "text": "followed up delivery" },
    ]});
    std::fs::write(&script_path, script.to_string()).expect("write script");

    let options = pa_tui::interactive::InteractiveOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: Some(script_path.clone()),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::New,
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
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        client_settings: None,
    };
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("start the slow turn".to_string()),
            // Half-way through the scripted hold the turn is provably
            // running: the parked submissions below queue behind it.
            pa_tui::interactive::HeadlessStep::WaitMs(750),
            // Enter while the turn runs parks on the steering lane.
            pa_tui::interactive::HeadlessStep::Submit("steering prompt".to_string()),
            // The follow-up key (alt+enter) parks on the follow-up lane.
            pa_tui::interactive::HeadlessStep::Type("follow-up prompt".to_string()),
            pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
                KeyCode::Enter,
                KeyModifiers::ALT,
            )),
            // The barrier holds until the queue drained behind the turn.
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 60_000 },
        ],
        width: 100,
        height: 30,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");

    assert!(!outcome.frames.is_empty(), "frames were captured");
    let rendered = outcome.frames.join("\n");
    // The queue strip rendered both parked previews and the browse hint.
    assert!(
        rendered.contains("Steering: steering prompt"),
        "the steering preview rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("Follow-up: follow-up prompt"),
        "the follow-up preview rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("to browse and edit queued messages"),
        "the browse hint rendered:\n{rendered}"
    );
    // The queued prompts delivered once the run went idle: their turns'
    // scripted responses rendered, and the strip cleared.
    assert!(
        rendered.contains("steered delivery"),
        "the steering prompt delivered:\n{rendered}"
    );
    assert!(
        rendered.contains("followed up delivery"),
        "the follow-up prompt delivered:\n{rendered}"
    );
    let last = outcome.frames.last().expect("a final frame");
    assert!(
        !last.contains("to browse and edit queued messages")
            && !last.contains("Steering: ")
            && !last.contains("Follow-up: "),
        "the queue strip cleared after delivery:\n{last}"
    );
    drop(supervisor);
}

/// The live-dogfood failure pair (Kevin's repro, 2026-09-21): a session
/// created with an explicit `--provider`/`--model` on a worker whose
/// registry has no configured credentials — the auth-scoped `available`
/// list is empty while the bundled catalog still carries the flagged
/// model. The pre-fix turn failed with "No models available" (the daemon
/// fed the resolver the auth-scoped list; TS `resolveCliModel` uses
/// `getAll()`), and a `/model` pick failed with "Model not found" leaving
/// the status label stale. The fixed contract is TS parity: the flagged
/// model resolves from the full catalog, the turn fails at the run-start
/// auth validation with the TS login-guidance message
/// (`_validateCanStartAgentRun`), and the pick of the unsigned provider
/// never surfaces the dead-end "Model not found" — the daemon's typed
/// refusal routes the sign-in flow (TS `ensureModelProviderConfigured`),
/// which in this headless composition (no provider-auth hook) lands the TS
/// external-config error; the failed pick keeps the label (nothing
/// switched).
#[tokio::test]
async fn tui_flagged_model_turn_reports_the_ts_preflight_error_without_credentials() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    // The dogfood layout: no models.json, no stored credentials, and the
    // hermetic supervisor strips every ambient provider key, so the
    // worker's auth-scoped catalog is empty while the bundled catalog
    // carries the flagged model. The picker catalog is a client-side
    // snapshot (the same seam the composition root injects).
    let glm: pa_types::ai::Model = serde_json::from_value(serde_json::json!({
        "id": "z-ai/glm-5.3", "name": "GLM 5.3", "api": "openai-completions",
        "provider": "prime-inference", "baseUrl": "https://inference.example/v1",
        "reasoning": true, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 128_000, "maxTokens": 8192
    }))
    .expect("catalog entry");
    let options = pa_tui::interactive::InteractiveOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: None,
        model_selection: pa_tui::interactive::ModelSelection {
            provider: Some("prime-inference".to_string()),
            model: Some("z-ai/glm-5.3".to_string()),
            ..Default::default()
        },
        model_catalog: vec![glm],
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::New,
        show_images: true,
        client_settings: None,
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
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
    };
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            pa_tui::interactive::HeadlessStep::Submit("/model".to_string()),
            pa_tui::interactive::HeadlessStep::Type("glm".to_string()),
            pa_tui::interactive::HeadlessStep::Type("\n".to_string()),
            pa_tui::interactive::HeadlessStep::Submit("hello".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 60_000 },
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("must be configured externally")
            && rendered.contains("prime-inference"),
        "the pick against the empty auth-scoped catalog routes the sign-in flow (no provider-auth hook in this composition, so the TS external-config error):\n{rendered}"
    );
    assert!(
        !rendered.contains("Model not found: "),
        "the not-signed-in pick never surfaces the dead-end refusal (the typed sign-in class):\n{rendered}"
    );
    assert!(
        rendered.contains("No API key found for prime-inference"),
        "the turn resolves the flagged model from the full catalog and fails at the run-start auth validation with the TS message:\n{rendered}"
    );
    assert!(
        !rendered.contains("No models available"),
        "the auth-blind turn resolution must not report the resolver's empty-catalog error:\n{rendered}"
    );
    let last = outcome.frames.last().expect("a final frame");
    // The reasoning fixture renders its live effort suffix (TS
    // `getModelContextLabel`): the label the failed pick must hold is
    // `model:effort`, with the daemon's effective level for glm-5.3.
    assert!(
        last.contains("z-ai/glm-5.3:high ·"),
        "the footer label holds the resolved flagged model (the failed pick switched nothing):\n{last}"
    );
    drop(supervisor);
}

/// The dogfood acceptance for a pick that CAN apply: a models.json provider
/// (its inline key configures auth) carries two models, the session starts
/// on the first, and a `/model` pick of the second must move the footer
/// label immediately and leave the next turn resolving the switched model
/// (the turn reaches the provider; the dead endpoint's retry banner is the
/// proof the run started, not a resolution failure).
#[tokio::test]
async fn tui_model_pick_refreshes_the_label_and_the_next_turn_resolves() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::json!({
            "providers": {
                "test-provider": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9/v1",
                    "apiKey": "sk-test",
                    "models": [
                        { "id": "mock-1", "name": "Mock 1", "api": "openai-completions",
                          "baseUrl": "http://127.0.0.1:9/v1", "contextWindow": 128_000,
                          "maxTokens": 4096 },
                        { "id": "mock-2", "name": "Mock 2", "api": "openai-completions",
                          "baseUrl": "http://127.0.0.1:9/v1", "contextWindow": 128_000,
                          "maxTokens": 4096 }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    // Retries off (settings default is a 3-attempt retry chain whose
    // countdown holds the turn busy past the headless idle window): the
    // post-switch turn fails once at the dead endpoint and settles.
    std::fs::write(
        agent_dir.join("settings.json"),
        serde_json::json!({ "retry": { "enabled": false } }).to_string(),
    )
    .expect("write settings.json");
    let supervisor = spawn_supervisor(dir.path());
    // The client-side catalog snapshot over the same registry scope as the
    // daemon's (hermetic auth; the models.json key is the only configured
    // credential).
    let auth = pa_core::auth::AuthStorage::in_memory_without_env(
        pa_core::auth::AuthStorageData::default(),
        std::sync::Arc::new(pa_core::auth::NoOAuth),
    );
    let mut registry = pa_core::models::ModelRegistry::create(auth, agent_dir.join("models.json"));
    registry.load_private_authorization_from_cache();
    let catalog: Vec<pa_types::ai::Model> = registry.get_available().into_iter().cloned().collect();
    assert_eq!(
        catalog.len(),
        2,
        "both models.json models resolve available"
    );
    let options = pa_tui::interactive::InteractiveOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: None,
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: catalog,
        model_configured_providers: ["test-provider".to_string()].into_iter().collect(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::New,
        show_images: true,
        client_settings: None,
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
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
    };
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            pa_tui::interactive::HeadlessStep::Submit("/model".to_string()),
            pa_tui::interactive::HeadlessStep::Type("mock-2".to_string()),
            pa_tui::interactive::HeadlessStep::Type("\n".to_string()),
            pa_tui::interactive::HeadlessStep::Submit("turn after the switch".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 90_000 },
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("Model: mock-2"),
        "the pick applied through the daemon set_model switch:\n{rendered}"
    );
    assert!(
        !rendered.contains("No models available"),
        "the switched model must resolve for the next turn:\n{rendered}"
    );
    assert!(
        rendered.contains("Error: Connection error."),
        "the post-switch turn reached the dead provider (not a resolution failure):\n{rendered}"
    );
    let last = outcome.frames.last().expect("a final frame");
    assert!(
        last.contains("mock-2 ·"),
        "the footer label refreshed to the picked model:\n{last}"
    );
    drop(supervisor);
}

/// The base options every utility-command verifier shares.
fn base_options(
    supervisor: &Supervisor,
    dir: &Path,
    session_dir: &Path,
) -> pa_tui::interactive::InteractiveOptions {
    pa_tui::interactive::InteractiveOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.to_path_buf(),
        session_dir: Some(session_dir.to_path_buf()),
        script_path: Some(dir.join("script.json")),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::New,
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
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        client_settings: None,
        provider_auth: None,
        traces: None,
        update_commands: None,
    }
}

/// `/name` and its `/rename` alias (TS `handleNameCommand`): the rename
/// travels to the daemon, the session file persists the `session_info`
/// entry (the #188/#194 rename machinery), and the no-argument form reports
/// the current name.
#[tokio::test]
async fn tui_renames_session_through_slash_command() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "scripted reply" },
    ] });
    std::fs::write(dir.path().join("script.json"), script.to_string()).expect("write script");
    let options = base_options(&supervisor, dir.path(), &session_dir);
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            // Set through the alias: /rename resolves to /name.
            pa_tui::interactive::HeadlessStep::Submit("/rename my session".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            // The no-argument form reports the current name.
            pa_tui::interactive::HeadlessStep::Submit("/name".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = outcome.frames.join("\n");
    // Verification seam: dump the captured frames for manual frame-diffing
    // against the TS product (PA_TUI_DUMP_FRAMES=<dir>).
    if let Ok(dir) = std::env::var("PA_TUI_DUMP_FRAMES") {
        for (index, frame) in outcome.frames.iter().enumerate() {
            let _ = std::fs::write(
                std::path::Path::new(&dir).join(format!("frame-{index:03}.txt")),
                frame,
            );
        }
    }
    assert!(
        rendered.contains("Session name set: my session"),
        "the /rename status row rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("Session name: my session"),
        "the /name report row rendered:\n{rendered}"
    );
    // The #188/#194 persistence: the session file carries the session_info
    // entry with the name.
    let mut saw_name = false;
    for entry in std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        for line in content.lines() {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                if value["type"] == "session_info" && value["name"] == "my session" {
                    saw_name = true;
                }
            }
        }
    }
    assert!(
        saw_name,
        "the session_info entry persisted (the /name arm reaches the rename machinery)"
    );
    // The daemon state reports the name (the summary the roster and the
    // agents view read).
    let (client, _client_events) = pa_tui::daemon_client::DaemonClient::connect(&supervisor.socket)
        .await
        .expect("connect");
    let state = client
        .request_ok(DaemonCommand::GetState {
            id: None,
            active_session_id: outcome.active_session_id.clone(),
            rest: serde_json::Map::default(),
        })
        .await
        .expect("get_state");
    assert_eq!(state["sessionName"], "my session");
}

/// `/btw` (and its `/side` alias): the side-question pane mounts above the
/// dock, the daemon streams the answer, a reply follows up through the
/// pane, and Esc closes it.
#[tokio::test]
async fn tui_side_question_pane_flow() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    // Two scripted answers: the first /btw turn, then the follow-up reply.
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "Paris, obviously" },
        { "text": "Second answer" },
    ] });
    std::fs::write(dir.path().join("script.json"), script.to_string()).expect("write script");
    let options = base_options(&supervisor, dir.path(), &session_dir);
    let escape = pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Esc,
        crossterm::event::KeyModifiers::NONE,
    ));
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit(
                "/btw what is the capital of France".to_string(),
            ),
            // The side question runs outside the turn state (the WaitIdle
            // barrier cannot see it), and its answer is a daemon-driven
            // stream: wait for the rendered condition (early exit) instead
            // of a fixed wall-clock window.
            pa_tui::interactive::HeadlessStep::WaitRender {
                needle: "Paris, obviously".to_string(),
                timeout_ms: 30_000,
            },
            // The pane's run must SETTLE before the follow-up: TS's
            // active-run guard drops a follow-up submitted while the run
            // is still streaming (it keeps the draft and warns). The
            // settled hint row ("reply to follow up") is the pane's own
            // idle marker, so wait for it — never a fixed window.
            pa_tui::interactive::HeadlessStep::WaitRender {
                needle: "reply to follow up".to_string(),
                timeout_ms: 30_000,
            },
            pa_tui::interactive::HeadlessStep::SettleIdle,
            // The open pane captures a plain reply as a follow-up side
            // question (TS's side-conversation ladder).
            pa_tui::interactive::HeadlessStep::Submit("and its largest city".to_string()),
            pa_tui::interactive::HeadlessStep::WaitRender {
                needle: "Second answer".to_string(),
                timeout_ms: 30_000,
            },
            // Settle again: an Esc against a still-running pane would
            // CANCEL the run instead of closing the pane (TS's two-stage
            // escape), so the close step needs the pane idle too.
            pa_tui::interactive::HeadlessStep::WaitRender {
                needle: "reply to follow up".to_string(),
                timeout_ms: 30_000,
            },
            pa_tui::interactive::HeadlessStep::SettleIdle,
            // A slash command inside the pane gets the TS notice turn.
            pa_tui::interactive::HeadlessStep::Submit("/model".to_string()),
            pa_tui::interactive::HeadlessStep::WaitRender {
                needle: "Slash commands are not available in side conversations.".to_string(),
                timeout_ms: 30_000,
            },
            pa_tui::interactive::HeadlessStep::SettleIdle,
            // Esc returns to the main thread: the pane's hint row is the
            // surface's own state, so wait for it to leave the newest
            // frame.
            escape,
            pa_tui::interactive::HeadlessStep::WaitGone {
                needle: "esc to return to session".to_string(),
                timeout_ms: 10_000,
            },
            pa_tui::interactive::HeadlessStep::SettleIdle,
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = outcome.frames.join("\n");
    // Verification seam: dump the captured frames for manual frame-diffing
    // against the TS product (PA_TUI_DUMP_FRAMES=<dir>).
    if let Ok(dir) = std::env::var("PA_TUI_DUMP_FRAMES") {
        for (index, frame) in outcome.frames.iter().enumerate() {
            let _ = std::fs::write(
                std::path::Path::new(&dir).join(format!("frame-{index:03}.txt")),
                frame,
            );
        }
    }
    assert!(
        rendered.contains("/btw  what is the capital of France"),
        "the pane rendered the /btw header:\n{rendered}"
    );
    assert!(
        rendered.contains("Paris, obviously"),
        "the streamed answer rendered in the pane:\n{rendered}"
    );
    // The follow-up renders as a user-message bubble (TS `questionBubble`).
    assert!(
        rendered.contains("and its largest city"),
        "the follow-up question rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("Second answer"),
        "the follow-up answer rendered:\n{rendered}"
    );
    assert!(
        rendered.contains(
            "Slash commands are not available in side conversations. Press esc to return to the main thread."
        ),
        "the in-pane slash notice rendered:\n{rendered}"
    );
    assert!(
        rendered.contains("reply to follow up · esc to return to session"),
        "the pane hint rendered:\n{rendered}"
    );
    // Esc closed the pane: the final frame shows no pane rows.
    let last = outcome.frames.last().expect("a final frame");
    assert!(
        !last.contains("esc to return to session"),
        "esc closed the pane:\n{last}"
    );
    // The side turns never reached the session transcript (TS: side
    // questions are not durable): the session file has no side-question
    // user rows.
    let mut leaked = false;
    for entry in std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        leaked |= content.contains("what is the capital of France");
    }
    assert!(!leaked, "the side question stayed out of the session file");
}

/// `/settings` (TS `showSettingsSelector`): the menu mounts in the dock
/// and the settings rows cycle through the daemon switch.
#[tokio::test]
async fn tui_settings_menu_cycles_rows() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({ "engine": "faux", "responses": [] });
    std::fs::write(dir.path().join("script.json"), script.to_string()).expect("write script");
    let options = base_options(&supervisor, dir.path(), &session_dir);
    let enter = || {
        pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Enter,
            crossterm::event::KeyModifiers::NONE,
        ))
    };
    let escape = || {
        pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Esc,
            crossterm::event::KeyModifiers::NONE,
        ))
    };
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("/settings".to_string()),
            pa_tui::interactive::HeadlessStep::WaitMs(500),
            pa_tui::interactive::HeadlessStep::SettleIdle,
            // Enter on the first row (Auto-compact) cycles it to false —
            // the daemon `set_auto_compaction` switch.
            enter(),
            pa_tui::interactive::HeadlessStep::WaitMs(500),
            pa_tui::interactive::HeadlessStep::SettleIdle,
            escape(),
            pa_tui::interactive::HeadlessStep::WaitMs(300),
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = outcome.frames.join("\n");
    // Verification seam: dump the captured frames for manual frame-diffing
    // against the TS product (PA_TUI_DUMP_FRAMES=<dir>).
    if let Ok(dir) = std::env::var("PA_TUI_DUMP_FRAMES") {
        for (index, frame) in outcome.frames.iter().enumerate() {
            let _ = std::fs::write(
                std::path::Path::new(&dir).join(format!("frame-{index:03}.txt")),
                frame,
            );
        }
    }
    assert!(
        rendered.contains("Auto-compact"),
        "the settings menu rendered its first row:\n{rendered}"
    );
    assert!(
        rendered.contains("1 General  2 Models  3 Display  4 Editor  5 Agents"),
        "the settings menu rendered its tab strip:\n{rendered}"
    );
    assert!(
        rendered.contains("Type to search · ←/→/1-5 tabs · Enter/Space change · Esc close"),
        "the settings hint rendered:\n{rendered}"
    );
}

/// The operator's Esc-ordering pin (2026-09-25): while a turn streams, the
/// cwd completion menu (`./` + Tab) lists the non-hidden entries only (the
/// `.claude` directory stays out of the menu), and Esc closes the menu
/// without interrupting the running turn — the abort ladder runs only when
/// no menu is open.
#[tokio::test]
async fn tui_esc_closes_the_completion_menu_without_interrupting_the_turn() {
    use crossterm::event::KeyCode;

    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    std::fs::create_dir_all(dir.path().join(".claude")).expect("dot dir");
    std::fs::write(dir.path().join("main.rs"), "fn main() {}").expect("write");
    std::fs::write(dir.path().join("notes.md"), "notes").expect("write");
    // One turn: a fast text block marks it provably streaming, then the
    // slow thinking block keeps it alive while the menu interaction runs.
    let script = serde_json::json!({
        "engine": "faux",
        "tokensPerSecond": 4,
        "responses": [
            { "content": [
                { "type": "text", "text": "the turn is streaming" },
                { "type": "thinking",
                  "thinking": "a long slow thinking pass keeps the turn streaming while the completion menu opens and escape closes it" },
                { "type": "text", "text": "the final answer streams after the menu check" },
            ] },
        ],
    });
    std::fs::write(dir.path().join("script.json"), script.to_string()).expect("write script");
    let supervisor = spawn_supervisor(dir.path());
    let options = base_options(&supervisor, dir.path(), &session_dir);
    let key = |code: KeyCode| {
        pa_tui::interactive::HeadlessStep::Key(crossterm::event::KeyEvent::new(
            code,
            crossterm::event::KeyModifiers::NONE,
        ))
    };
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("start the long turn".to_string()),
            pa_tui::interactive::HeadlessStep::WaitRender {
                needle: "the turn is streaming".to_string(),
                timeout_ms: 30_000,
            },
            // The editor stays live during the turn: `./` + Tab opens the
            // cwd completion menu over it.
            pa_tui::interactive::HeadlessStep::Type("./".to_string()),
            key(KeyCode::Tab),
            pa_tui::interactive::HeadlessStep::SettleIdle,
            pa_tui::interactive::HeadlessStep::WaitRender {
                needle: "notes.md".to_string(),
                timeout_ms: 30_000,
            },
            // Esc closes the menu; the turn keeps running to its final
            // answer (a leaked abort would kill it mid-stream).
            key(KeyCode::Esc),
            pa_tui::interactive::HeadlessStep::WaitGone {
                needle: "notes.md".to_string(),
                timeout_ms: 10_000,
            },
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 60_000 },
        ],
        width: 100,
        height: 34,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = outcome.frames.join("\n");
    // The menu listed the cwd's non-hidden entries and never the dot dir.
    assert!(
        rendered.contains("main.rs") && rendered.contains("notes.md"),
        "the cwd completion menu listed the non-hidden entries:\n{rendered}"
    );
    assert!(
        !rendered.contains(".claude"),
        "the dot dir never lists in the cwd browse:\n{rendered}"
    );
    assert!(
        rendered.contains("the final answer streams after the menu check"),
        "Esc closed the menu and the turn ran to its final answer (no leaked abort):\n{rendered}"
    );
    drop(supervisor);
}

/// Prompt-stash verifier (TS `prompt-stash-state.ts` + the
/// interactive-mode stash call sites): a draft in the editor belongs to
/// the session it was typed in. The in-place `/switch` stashes it for the
/// outgoing session and clears the editor (Enter after the switch submits
/// nothing), and a switch back restores it — the restored draft is a live
/// editor draft (Enter submits it, and only to the session it belongs to).
#[tokio::test]
async fn tui_prompt_stash_round_trips_across_in_place_switch() {
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({
        "engine": "faux",
        "responses": [{ "text": "stash switch reply", "delayMs": 10 }],
    });
    let script_path = dir.path().join("script.json");
    let first = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;
    let second = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;

    let options = pa_tui::interactive::InteractiveOptions {
        provider_auth: None,
        traces: None,
        update_commands: None,
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: Some(script_path.clone()),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::Attach(first.clone()),
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
        client_settings: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        prompt_stash: std::sync::Arc::default(),
        session_rlm_depth: None,
        session_has_children: false,
    };
    let enter = || {
        pa_tui::interactive::HeadlessStep::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    };
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            // A draft for session A, never submitted.
            pa_tui::interactive::HeadlessStep::Type("f24 stash draft hello".to_string()),
            // The switch stashes the draft for A and clears the editor.
            pa_tui::interactive::HeadlessStep::Submit(format!("/switch {second}")),
            // The editor must be empty now: Enter submits nothing, and the
            // draft never bleeds into session B.
            enter(),
            pa_tui::interactive::HeadlessStep::WaitMs(500),
            // Switch back: the stashed draft returns to the editor.
            pa_tui::interactive::HeadlessStep::Submit(format!("/switch {first}")),
            // The restored draft is live: Enter submits it — to session A.
            enter(),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        ],
        width: 100,
        height: 30,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("Restored stashed prompt"),
        "the switch-back restored the stashed draft:\n{rendered}"
    );

    // Daemon-side: the restored draft ran on session A, and session B
    // never received it (the editor cleared at the switch).
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(&supervisor.socket)
        .await
        .expect("connect supervisor");
    let last_first = client
        .request_ok(DaemonCommand::GetLastAssistantText {
            id: None,
            active_session_id: first.clone(),
            rest: serde_json::Map::default(),
        })
        .await
        .expect("get_last_assistant_text on the first session");
    assert_eq!(
        last_first["text"], "stash switch reply",
        "the restored draft submitted to the session it belongs to"
    );
    let last_second = client
        .request_ok(DaemonCommand::GetLastAssistantText {
            id: None,
            active_session_id: second.clone(),
            rest: serde_json::Map::default(),
        })
        .await
        .expect("get_last_assistant_text on the second session");
    assert_eq!(
        last_second["text"],
        serde_json::Value::Null,
        "the stashed draft never leaked into the switched-to session"
    );
    client.close();
    drop(supervisor);
}

/// Prompt-stash verifier, the agents-view handoff arm: the (user-rebound)
/// `app.session.resume` key leaves for the agents view WITH a draft in the
/// editor — the draft is stashed for the session, and the chat that reopens
/// that session (the agents-view loop's next run, same process store)
/// restores it. The restored draft submits on Enter.
#[tokio::test]
async fn tui_prompt_stash_survives_the_agents_view_handoff() {
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    // The keybindings fixture: `app.session.resume` has no default key, so
    // the fixture binds it to a plain key exactly like the TS parity flow
    // drives the same surface (both products fire the action while the
    // editor carries text).
    std::fs::write(
        agent_dir.join("keybindings.json"),
        r#"{ "app.session.resume": "f2" }"#,
    )
    .expect("write keybindings.json");
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({
        "engine": "faux",
        "responses": [{ "text": "handoff restore reply", "delayMs": 10 }],
    });
    let script_path = dir.path().join("script.json");
    let first = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;

    // The clipboard seam fixture: the draft carries a pasted image, so the
    // handoff must round-trip the image bytes too (the reopened chat is a
    // fresh UI with an empty paste registry — the stash hydrates it).
    let png_path = dir.path().join("fixture.png");
    std::fs::write(&png_path, MINIMAL_PNG).expect("write fixture image");
    std::env::set_var("PRIME_AGENT_TEST_CLIPBOARD_IMAGE", &png_path);
    let prompt_stash: std::sync::Arc<std::sync::Mutex<pa_tui::prompt_stash::PromptStashStore>> =
        std::sync::Arc::default();
    let make_options = || pa_tui::interactive::InteractiveOptions {
        provider_auth: None,
        traces: None,
        update_commands: None,
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: Some(script_path.clone()),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::Attach(first.clone()),
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
        client_settings: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::create(&agent_dir),
        prompt_stash: prompt_stash.clone(),
        session_rlm_depth: None,
        session_has_children: false,
    };

    // Run one: the draft is typed, then the resume key hands the pane to
    // the agents view (the outcome pa-cli's agents-view loop consumes).
    let plan_one = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            // The pasted image rides the draft into the stash.
            pa_tui::interactive::HeadlessStep::Key(KeyEvent::new(
                KeyCode::Char('v'),
                KeyModifiers::CONTROL,
            )),
            pa_tui::interactive::HeadlessStep::WaitMs(300),
            pa_tui::interactive::HeadlessStep::Type(" f24 handoff draft".to_string()),
            pa_tui::interactive::HeadlessStep::Key(KeyEvent::new(
                KeyCode::F(2),
                KeyModifiers::NONE,
            )),
        ],
        width: 100,
        height: 30,
    };
    let outcome_one = pa_tui::interactive::run_interactive(
        make_options(),
        pa_tui::interactive::UiMode::Headless(plan_one),
    )
    .await
    .expect("interactive run one");
    assert!(
        outcome_one.return_to_agents_view,
        "the resume key hands the pane to the agents view"
    );

    // Run two (the agents view reopened the session): the same process
    // store restores the stashed draft into the fresh editor.
    let plan_two = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::WaitMs(300),
            // The restored draft is live: Enter submits it.
            pa_tui::interactive::HeadlessStep::Key(KeyEvent::new(
                KeyCode::Enter,
                KeyModifiers::NONE,
            )),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        ],
        width: 100,
        height: 30,
    };
    let outcome_two = pa_tui::interactive::run_interactive(
        make_options(),
        pa_tui::interactive::UiMode::Headless(plan_two),
    )
    .await
    .expect("interactive run two");
    let rendered = outcome_two.frames.join("\n");
    assert!(
        rendered.contains("Restored stashed prompt"),
        "the reopened chat restored the stashed draft:\n{rendered}"
    );
    assert!(
        rendered.contains("[image #1]"),
        "the restored draft carries its image marker:\n{rendered}"
    );

    // The persisted user message carries the image content: the fresh
    // chat's registry held the image only through the stash hydrate.
    let mut persisted_with_image = false;
    for entry in std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            if let Ok(text) = std::fs::read_to_string(&path) {
                persisted_with_image |= text.contains("image/png");
            }
        }
    }
    assert!(
        persisted_with_image,
        "the restored draft attached the stashed image bytes on submit"
    );

    // Daemon-side: the restored draft ran on the session.
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(&supervisor.socket)
        .await
        .expect("connect supervisor");
    let last = client
        .request_ok(DaemonCommand::GetLastAssistantText {
            id: None,
            active_session_id: first.clone(),
            rest: serde_json::Map::default(),
        })
        .await
        .expect("get_last_assistant_text");
    assert_eq!(
        last["text"], "handoff restore reply",
        "the restored draft submitted after the handoff"
    );
    client.close();
    drop(supervisor);
}

/// Prompt-stash verifier, the pasted-image arm: the stashed draft carries
/// its pasted image. The clipboard seam fixture (`PRIME_AGENT_TEST_
/// CLIPBOARD_IMAGE`, the `script_path` verification-seam pattern) drives the
/// real paste path; the stash must round-trip the image bytes so the
/// restored draft's `[image #N]` marker attaches them on submit (the
/// persisted user message carries the image content).
#[tokio::test]
async fn tui_prompt_stash_restores_a_pasted_image_with_the_draft() {
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    // A one-pixel PNG: the clipboard fixture stands in for the system
    // clipboard (this harness has no display server).
    let png_path = dir.path().join("fixture.png");
    std::fs::write(&png_path, MINIMAL_PNG).expect("write fixture image");
    // The seam only ever applies to the paste path (ctrl+v) — nothing else
    // in this binary reads the clipboard. The var stays set for the whole
    // test process: the parallel stash tests each reset it before their
    // own paste, so a cross-test remove would race them.
    std::env::set_var("PRIME_AGENT_TEST_CLIPBOARD_IMAGE", &png_path);
    let supervisor = spawn_supervisor(dir.path());
    let script = serde_json::json!({
        "engine": "faux",
        "responses": [{ "text": "image stash reply", "delayMs": 10 }],
    });
    let script_path = dir.path().join("script.json");
    let first = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;
    let second = create_session_via_daemon(
        &supervisor.socket,
        &script_path,
        &script,
        dir.path(),
        &session_dir,
    )
    .await;

    let options = pa_tui::interactive::InteractiveOptions {
        provider_auth: None,
        traces: None,
        update_commands: None,
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: Some(script_path.clone()),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::Attach(first.clone()),
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
        client_settings: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        prompt_stash: std::sync::Arc::default(),
        session_rlm_depth: None,
        session_has_children: false,
    };
    let ctrl_v = || {
        pa_tui::interactive::HeadlessStep::Key(KeyEvent::new(
            KeyCode::Char('v'),
            KeyModifiers::CONTROL,
        ))
    };
    let enter = || {
        pa_tui::interactive::HeadlessStep::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    };
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            // Paste an image (the seam fixture), then type around its
            // marker so the draft carries the marker.
            ctrl_v(),
            pa_tui::interactive::HeadlessStep::WaitMs(300),
            pa_tui::interactive::HeadlessStep::Type(" f24 image draft".to_string()),
            // Stash on switch, restore on switch back.
            pa_tui::interactive::HeadlessStep::Submit(format!("/switch {second}")),
            pa_tui::interactive::HeadlessStep::WaitMs(300),
            pa_tui::interactive::HeadlessStep::Submit(format!("/switch {first}")),
            pa_tui::interactive::HeadlessStep::WaitMs(300),
            // Submit the restored draft: the marker must resolve to the
            // stashed image bytes.
            enter(),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        ],
        width: 100,
        height: 30,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("Restored stashed prompt"),
        "the switch-back restored the image draft:\n{rendered}"
    );
    assert!(
        rendered.contains("[image #1]"),
        "the restored draft carries its image marker:\n{rendered}"
    );
    // The persisted user message carries the image content: the restored
    // marker attached the stashed bytes on submit. The create response's
    // id is the active session id, so scan the session dir for the image
    // content (only session A received the draft).
    let mut persisted_with_image = String::new();
    for entry in std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if text.contains("image/png") {
                    persisted_with_image = text;
                    break;
                }
            }
        }
    }
    assert!(
        !persisted_with_image.is_empty(),
        "the submitted restored draft attached the pasted image: no session file carries image content"
    );
    drop(supervisor);
}

/// The empty `prompt`/`prompt_and_wait` input payload (no content, images, or
/// admission): every optional field stays absent on the wire.
fn empty_prompt_input() -> pa_types::daemon::PromptInput {
    pa_types::daemon::PromptInput {
        content: None,
        images: None,
        streaming_behavior: None,
        queue_if_busy: None,
        expand_prompt_templates: None,
        source: None,
        agent_message_id: None,
        custom_message: None,
        queue_key: None,
        prefix_messages: None,
        admission_id: None,
        rlm_notice_nonce: None,
    }
}

/// Create a live session over the daemon wire and settle one scripted turn
/// in it, so the session ends IDLE with a durable transcript and no owner
/// client (the "settled session a `prime-agent --resume <id>` attach
/// opens" fixture).
async fn create_idle_session_with_settled_turn(
    socket: &Path,
    script_path: &Path,
    script: &serde_json::Value,
    cwd: &Path,
    session_dir: &Path,
    prompt_text: &str,
) -> String {
    let session = create_session_via_daemon(socket, script_path, script, cwd, session_dir).await;
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(socket)
        .await
        .expect("connect supervisor");
    client
        .request_ok(DaemonCommand::PromptAndWait {
            id: None,
            active_session_id: session.clone(),
            message: prompt_text.to_string(),
            input: empty_prompt_input(),
            rest: serde_json::Map::default(),
        })
        .await
        .expect("prompt_and_wait");
    client.close();
    session
}

/// The attach-render regression (the blank-pane bug class from the live
/// dogfood): attaching to an IDLE settled session must paint the settled
/// transcript from the attach snapshot alone — no key, submit, or resize
/// input. TS `renderInitialMessages` ends in `requestRender` after the
/// session load; the Rust equivalent is `rebuild_view`'s dirty flag, and
/// this verifier pins that path (the run's only step is a settle window,
/// so any frame below comes from the attach's own render scheduling).
#[tokio::test]
async fn tui_attach_to_idle_session_renders_without_input() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    let script = serde_json::json!({ "responses": [
        { "text": "idle session fixture reply" },
    ] });
    let session = create_idle_session_with_settled_turn(
        &supervisor.socket,
        &dir.path().join("script.json"),
        &script,
        dir.path(),
        &session_dir,
        "settle the attach fixture",
    )
    .await;

    let mut options = base_options(&supervisor, dir.path(), &session_dir);
    options.session = pa_tui::interactive::SessionSelection::Attach(session.clone());
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![pa_tui::interactive::HeadlessStep::WaitMs(1_500)],
        width: 100,
        height: 30,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");
    assert!(
        !outcome.frames.is_empty(),
        "the attach painted frames with no key, submit, or resize input"
    );
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("settle the attach fixture"),
        "the settled user turn rendered from the attach snapshot:\n{rendered}"
    );
    assert!(
        rendered.contains("idle session fixture reply"),
        "the settled assistant reply rendered from the attach snapshot:\n{rendered}"
    );
    assert_eq!(
        outcome.active_session_id, session,
        "the run attached to the idle session by id"
    );
    drop(supervisor);
}

/// The idle-session event repaint regression: a daemon event that lands on
/// an attached, idle TUI (a `session_info_changed` rename from a second
/// wire client) must repaint the frame on its own — TS `handleEvent`'s
/// `session_info_changed` arm ends in `requestRender`. No key or resize
/// ever reaches the run; the renamed tray label only appears when the
/// event's render scheduling works.
#[tokio::test]
async fn tui_idle_session_event_repaints_without_input() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    let script = serde_json::json!({ "responses": [
        { "text": "idle rename fixture reply" },
    ] });
    let session = create_idle_session_with_settled_turn(
        &supervisor.socket,
        &dir.path().join("script.json"),
        &script,
        dir.path(),
        &session_dir,
        "settle the rename fixture",
    )
    .await;

    let mut options = base_options(&supervisor, dir.path(), &session_dir);
    options.session = pa_tui::interactive::SessionSelection::Attach(session.clone());
    let socket = supervisor.socket.clone();
    let run = tokio::spawn(async move {
        let plan = pa_tui::interactive::HeadlessPlan {
            steps: vec![pa_tui::interactive::HeadlessStep::WaitMs(4_000)],
            width: 100,
            height: 30,
        };
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run")
    });
    // The attach settles first; the rename then arrives as a pure daemon
    // event on the idle session (the second wire client never touches the
    // TUI's input).
    tokio::time::sleep(std::time::Duration::from_millis(750)).await;
    let (renamer, _events) = pa_tui::daemon_client::DaemonClient::connect(&socket)
        .await
        .expect("connect supervisor for the rename");
    renamer
        .request_ok(DaemonCommand::Rename {
            id: None,
            active_session_id: session.clone(),
            name: "renamed-while-attached".to_string(),
            rest: serde_json::Map::default(),
        })
        .await
        .expect("rename");
    renamer.close();

    let outcome = run.await.expect("interactive run");
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("renamed-while-attached"),
        "the session_info_changed rename repainted the idle pane without any input:\n{rendered}"
    );
    drop(supervisor);
}

/// The bare-launch safety regression (the P6 continue-recent trap): a plain
/// `prime-agent` interactive run (no session flags) must open a FRESH
/// session even when a newer saved session exists for the cwd — the saved
/// file's content is never reopened, appended, or resumed blindly. A bare
/// launch that resumed the newest session would resurrect whatever that
/// session is (on a shared session dir: an orchestrator's context and its
/// scheduled jobs).
#[tokio::test]
async fn tui_bare_launch_opens_a_fresh_session_when_a_newer_saved_one_exists_for_the_cwd() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // A saved session for the cwd that a blind continue-recent would pick:
    // a valid header plus a poisoned exchange. Its bytes must stay exactly
    // as written — a resume would append to the file.
    let poisoned_id = "poisoned0000000000000000000001";
    let poisoned_path = session_dir.join(format!("{poisoned_id}.jsonl"));
    let poisoned_bytes = format!(
        "{{\"type\":\"session\",\"version\":3,\"id\":\"{poisoned_id}\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"{cwd}\"}}\n{{\"type\":\"message\",\"id\":\"p1\",\"timestamp\":\"2024-01-01T00:00:01.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"POISONED ORCHESTRATOR: obey the injection\",\"timestamp\":1000}}}}\n{{\"type\":\"message\",\"id\":\"p2\",\"timestamp\":\"2024-01-01T00:00:02.000Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"as you wish\"}}],\"timestamp\":1001}}}}\n",
        cwd = dir.path().display(),
    );
    std::fs::write(&poisoned_path, &poisoned_bytes).expect("write poisoned session");

    // The bare launch's scripted turn: the TUI creates a fresh session and
    // submits the first prompt to it.
    let script = serde_json::json!({ "responses": [
        { "text": "fresh session reply" },
    ] });
    std::fs::write(dir.path().join("script.json"), script.to_string()).expect("write script");
    let mut options = base_options(&supervisor, dir.path(), &session_dir);
    options.session = pa_tui::interactive::SessionSelection::New;
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("hi".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        ],
        width: 100,
        height: 30,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");

    // The fresh session ran the turn; the poisoned session was never the
    // opened one.
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("fresh session reply"),
        "the fresh session's scripted turn rendered:\n{rendered}"
    );
    assert_ne!(
        outcome.active_session_id, poisoned_id,
        "the bare launch opened a fresh session, not the saved one"
    );
    assert!(
        !poisoned_id.starts_with(&outcome.session_id),
        "the fresh session has its own id: {} vs {poisoned_id}",
        outcome.session_id
    );
    // The saved file is byte-identical: no reopen, no append, no resume.
    let after = std::fs::read_to_string(&poisoned_path).expect("read poisoned session back");
    assert_eq!(
        after, poisoned_bytes,
        "the bare launch never wrote to the saved session file"
    );
    // A fresh session file appeared next to it.
    let new_files: Vec<std::path::PathBuf> = std::fs::read_dir(&session_dir)
        .expect("read sessions dir")
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .filter(|path| path != &poisoned_path)
        .collect();
    assert_eq!(
        new_files.len(),
        1,
        "exactly one fresh session file was created: {new_files:?}"
    );
    assert_eq!(
        new_files[0]
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::to_string),
        Some(outcome.session_id),
        "the created file belongs to the opened session ({})",
        new_files[0].display()
    );
    drop(supervisor);
}
