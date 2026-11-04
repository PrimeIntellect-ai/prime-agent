// Casts: narrowing sits at the pid boundary, where the kernel bounds the values.
#![allow(clippy::large_futures, clippy::cast_possible_wrap)]
#![cfg(target_os = "linux")]

//! E2E verifier for an inactive session's shells line: the open agents view follows the
//! daemon's live persistent shells, so a shell that ends (or starts) while the view stays open
//! moves its session's `$` line within a poll cycle instead of keeping the catalog's open-time
//! snapshot until a reopen.

use std::fmt::Write as _;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nix::sys::signal::{killpg, Signal};
use nix::unistd::Pid;
use pa_tui::agents_view::{AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode};
use serde_json::json;

struct Supervisor {
    child: Child,
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(dir: &Path) -> Supervisor {
    let socket = dir.join("daemon.sock");
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(&socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", dir.join("agent"))
        .env_remove("PRIME_AGENT_SESSION_DIR")
        .env_remove("PRIME_AGENT_CODING_AGENT_SESSION_DIR")
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

/// One saved session: a header plus a named user/assistant exchange.
fn write_session(sessions_dir: &Path, id: &str, name: &str) {
    let mut content = String::new();
    let _ = writeln!(
        content,
        r#"{{"type":"session","version":3,"id":"{id}","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/tmp"}}"#
    );
    let _ = writeln!(
        content,
        r#"{{"type":"session_info","id":"{id}-info","timestamp":"2024-01-01T00:00:00.000Z","name":"{name}"}}"#
    );
    let _ = writeln!(
        content,
        r#"{{"type":"message","id":"{id}-u","timestamp":"2024-01-01T00:00:00.000Z","message":{{"role":"user","content":"start a server","timestamp":0}}}}"#
    );
    let _ = writeln!(
        content,
        r#"{{"type":"message","id":"{id}-a","timestamp":"2024-01-01T00:00:01.000Z","message":{{"role":"assistant","content":[{{"type":"text","text":"started"}}],"timestamp":1}}}}"#
    );
    std::fs::write(sessions_dir.join(format!("{id}.jsonl")), content).expect("write session");
}

/// A persistent shell: a `sleep` leading its own process group, registered in the agent dir's
/// persistent-shell home under its real start identity and assigned to `session_id`.
struct Shell(Child);

impl Shell {
    fn start(agent_dir: &Path, session_id: &str) -> Shell {
        let mut command = Command::new("sleep");
        command.arg("300");
        pa_core::platform::process::set_new_session(&mut command);
        let child = command.spawn().expect("spawn shell");
        let pid = child.id();
        let home = agent_dir.join("persistent-shells");
        std::fs::create_dir_all(&home).expect("persistent-shell home");
        let id = format!("{pid:032}");
        let record = json!({
            "id": id,
            "pid": pid,
            "startId": pa_daemon::lease::get_process_start_id(pid).expect("start id"),
            "command": "sleep 300",
            "startedAt": "2026-01-01T00:00:00+00:00",
            "sessionId": session_id,
        });
        std::fs::write(home.join(format!("{id}.json")), record.to_string()).expect("write record");
        Shell(child)
    }

    /// End the shell's process group (what a user's kill does) and reap it.
    fn stop(mut self) {
        killpg(Pid::from_raw(self.0.id() as i32), Signal::SIGTERM).expect("signal the group");
        self.0.wait().expect("reap the shell");
    }
}

impl Drop for Shell {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn view_options(socket: &Path, session_dir: &Path) -> AgentsViewOptions {
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
        status_message: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: json!({}),
    }
}

/// The sessions' indented `$` lines: the unindented `Persistent shells` rows also start with `$`.
fn shell_lines(frame: &str) -> Vec<&str> {
    frame
        .lines()
        .filter(|line| line.starts_with(' '))
        .map(str::trim)
        .filter(|line| line.starts_with("$ "))
        .collect()
}

/// Session A's shell ends while the view is open, then session B (already listed, no shells at
/// the catalog load) starts two: B's line can only land from a registry read made after A's
/// shell was reaped, so the frame that shows it must also show A without a line.
#[tokio::test]
async fn an_inactive_sessions_shells_line_follows_its_live_persistent_shells() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("session dir");
    write_session(&sessions_dir, "session-a", "server session a");
    write_session(&sessions_dir, "session-b", "server session b");
    let shell_a = Shell::start(&agent_dir, "session-a");
    let supervisor = spawn_supervisor(dir.path());

    let line_rendered = std::sync::Arc::new(tokio::sync::Notify::new());
    let view = pa_tui::agents_view::run_agents_view(
        view_options(&supervisor.socket, &sessions_dir),
        AgentsViewUiMode::Headless(AgentsHeadlessPlan {
            steps: vec![
                AgentsStep::WaitRender {
                    needle: "$ 1 shell \u{b7} 1 persistent".to_string(),
                    timeout_ms: 20_000,
                },
                AgentsStep::Notify(line_rendered.clone()),
                // Two poll cycles: the change lands with the first cycle after it.
                AgentsStep::WaitRender {
                    needle: "$ 2 shells \u{b7} 2 persistent".to_string(),
                    timeout_ms: 2 * 2_000 + 500,
                },
            ],
            width: 120,
            height: 36,
        }),
        None,
    );
    let shells_b = async {
        line_rendered.notified().await;
        shell_a.stop();
        [
            Shell::start(&agent_dir, "session-b"),
            Shell::start(&agent_dir, "session-b"),
        ]
    };
    let (view, _shells_b) = tokio::join!(view, shells_b);
    let frames = view.expect("agents view run").outcome.frames;

    let before = frames
        .iter()
        .position(|frame| shell_lines(frame) == ["$ 1 shell \u{b7} 1 persistent"])
        .unwrap_or_else(|| panic!("A's line rendered:\n{}", frames.join("\n---\n")));
    let after = frames[before..]
        .iter()
        .find(|frame| frame.contains("$ 2 shells"))
        .unwrap_or_else(|| {
            panic!(
                "B's shells never reached the open view; last frame:\n{}",
                frames.last().map_or("", String::as_str)
            )
        });
    assert_eq!(
        shell_lines(after),
        ["$ 2 shells \u{b7} 2 persistent"],
        "A's ended shell left its line:\n{after}"
    );
}
