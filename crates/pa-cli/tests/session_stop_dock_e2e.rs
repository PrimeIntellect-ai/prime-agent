// Pedantic-gate dispositions: the flow is intentionally linear and its async test future is
// stack-resident by shape.
#![allow(clippy::large_futures, clippy::too_many_lines)]
#![cfg(unix)]

//! E2E verifier for the dock after a session stop: a chat attached to a live session whose kernel
//! runs a shell drops the shell from its dock when the daemon stops the session, instead of
//! keeping the dead kernel's last list.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_tui::interactive::{
    HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection, SessionSelection, UiMode,
};
use serde_json::{json, Value};

struct Supervisor {
    child: Child,
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = ask(&self.socket, &json!({ "type": "shutdown" }));
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// The kernel Python with prime-agent-runtime installed (`PA_E2E_KERNEL_PYTHON`, else the
/// product's kernel-venv layout). A missing kernel fails loudly: the shell needs a real kernel.
fn kernel_python() -> PathBuf {
    let python = std::env::var_os("PA_E2E_KERNEL_PYTHON").map_or_else(
        || {
            PathBuf::from(std::env::var("HOME").expect("HOME"))
                .join(".prime/agent/kernel-venv/bin/python")
        },
        PathBuf::from,
    );
    assert!(
        python.exists(),
        "kernel python {} not found: set PA_E2E_KERNEL_PYTHON",
        python.display()
    );
    python
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
        .env("PRIME_AGENT_KERNEL_PYTHON", kernel_python())
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
    let child = command.spawn().expect("spawn prime-agent --mode daemon");
    let deadline = Instant::now() + Duration::from_secs(15);
    while UnixStream::connect(&socket).is_err() {
        assert!(Instant::now() < deadline, "supervisor socket never came up");
        std::thread::sleep(Duration::from_millis(20));
    }
    Supervisor { child, socket }
}

/// One command over a fresh connection; the answer is the response carrying the command's id.
fn ask(socket: &Path, command: &Value) -> Option<Value> {
    let stream = UnixStream::connect(socket).ok()?;
    let mut writer = stream.try_clone().ok()?;
    let mut reader = BufReader::new(stream);
    reader.read_line(&mut String::new()).ok()?;
    let mut line = serde_json::to_string(&json!({
        "type": "command",
        "id": "stop-e2e",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "command": command,
    }))
    .ok()?;
    line.push('\n');
    writer.write_all(line.as_bytes()).ok()?;
    reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(60)))
        .ok()?;
    loop {
        let mut response = String::new();
        if reader.read_line(&mut response).ok()? == 0 {
            return None;
        }
        let value: Value = serde_json::from_str(&response).ok()?;
        if value.get("type").and_then(Value::as_str) == Some("response")
            && value.get("id").and_then(Value::as_str) == Some("stop-e2e")
        {
            return Some(value);
        }
    }
}

fn ask_ok(socket: &Path, command: &Value) -> Value {
    let response = ask(socket, command).expect("the daemon answered");
    assert_eq!(response["success"], true, "{command} failed: {response}");
    response
}

/// A live session whose kernel runs `cell` on its second turn (the first turn persists the
/// session); returns its active session id.
fn session_running(socket: &Path, dir: &Path, cell: &str) -> String {
    let script = dir.join("faux.json");
    std::fs::write(
        &script,
        json!({ "engine": "faux", "responses": [
            { "text": "ready" },
            { "content": [{ "type": "toolCall", "name": "python_repl",
                            "arguments": { "code": cell } }] },
            { "text": "started" },
        ] })
        .to_string(),
    )
    .expect("write faux script");
    let created = ask_ok(
        socket,
        &json!({ "type": "create", "config": {
            "script": script.to_string_lossy(),
            "cwd": dir.to_string_lossy(),
            "sessionDir": dir.join("agent").join("sessions").to_string_lossy(),
        } }),
    );
    let active = created["data"]["activeSessionId"]
        .as_str()
        .expect("the created session is live")
        .to_string();
    for message in ["warm up", "start the shell"] {
        ask_ok(
            socket,
            &json!({ "type": "prompt", "activeSessionId": active, "message": message }),
        );
        ask_ok(
            socket,
            &json!({ "type": "wait_for_idle", "activeSessionId": active }),
        );
    }
    let listed = ask_ok(
        socket,
        &json!({ "type": "list_kernel_bash", "activeSessionId": active }),
    );
    assert_eq!(
        listed["data"]["activities"][0]["status"], "running",
        "the kernel runs the shell: {listed}"
    );
    active
}

fn chat_options(socket: PathBuf, cwd: PathBuf, active: String) -> InteractiveOptions {
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
        session: SessionSelection::Attach(active),
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

fn dock_line(frame: &str) -> &str {
    frame
        .lines()
        .find(|line| line.contains("subagents") && line.contains("heartbeats"))
        .unwrap_or_default()
}

#[tokio::test]
async fn stopping_the_attached_session_clears_its_shells_from_the_dock() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let supervisor = spawn_supervisor(dir.path());
    let active = session_running(&supervisor.socket, dir.path(), "h = bash('sleep 300')");

    let (rendered_tx, rendered_rx) = std::sync::mpsc::channel();
    let kill_thread = {
        let socket = supervisor.socket.clone();
        let active = active.clone();
        std::thread::spawn(move || {
            rendered_rx
                .recv_timeout(Duration::from_secs(60))
                .expect("the chat rendered the shell");
            ask_ok(
                &socket,
                &json!({ "type": "kill", "activeSessionId": active }),
            );
        })
    };
    let outcome = pa_tui::interactive::run_interactive(
        chat_options(supervisor.socket.clone(), dir.path().to_path_buf(), active),
        UiMode::Headless(HeadlessPlan {
            steps: vec![
                HeadlessStep::WaitRender {
                    needle: "\u{25b8} 1 shell".to_string(),
                    timeout_ms: 20_000,
                },
                HeadlessStep::Timestamp(rendered_tx),
                HeadlessStep::WaitRender {
                    needle: "stopped this agent session".to_string(),
                    timeout_ms: 20_000,
                },
                HeadlessStep::WaitRender {
                    needle: "\u{25b8} 0 shells".to_string(),
                    timeout_ms: 2_500,
                },
            ],
            width: 160,
            height: 30,
        }),
    )
    .await
    .expect("the chat run");
    kill_thread.join().expect("the stop ran");

    let frames = &outcome.frames;
    let stop_frame = frames
        .iter()
        .position(|frame| frame.contains("stopped this agent session"))
        .unwrap_or_else(|| panic!("the stop reached the chat:\n{}", frames.join("\n")));
    assert!(
        frames[..stop_frame]
            .iter()
            .any(|frame| dock_line(frame).contains("\u{25b8} 1 shell")),
        "the dock counted the live shell before the stop:\n{}",
        frames.join("\n")
    );
    let last = frames.last().expect("frames");
    assert!(
        dock_line(last).contains("\u{25b8} 0 shells"),
        "the dock dropped the stopped session's shell; last dock: {:?}\n{last}",
        dock_line(last)
    );
}
