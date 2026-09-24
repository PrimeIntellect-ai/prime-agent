//! End-to-end verifier for the print-mode active-session guard (B-11): a
//! headless `-c`/`-r` must refuse to open a session file that a live daemon
//! worker already hosts, with the exact TS `SessionAlreadyActiveError`
//! message. The real binary, a real daemon, and the scripted faux provider
//! drive the full path.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

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
    // The launcher strips inherited worker role env vars before spawning the
    // supervisor; a CLI running inside a daemon worker must not leak them
    // (this test process may itself be one).
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
    // A supervisor killed at teardown must not leak its session workers
    // into later test binaries: the worker's supervisor-lost exit (TS
    // `exitIfSupervisorOrphanedForTooLong`) runs on this short window
    // instead of the 5-minute default.
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
    panic!("daemon socket never appeared");
}

/// Open a session file as a live daemon worker (create with sessionPath),
/// so the print path's guard has an active session to find. Returns the
/// worker's active session id.
fn make_session_active(socket: &Path, session_path: &Path, cwd: &Path) -> String {
    let stream = UnixStream::connect(socket).expect("connect daemon");
    let write_half = stream.try_clone().expect("clone");
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;
    let mut hello = String::new();
    reader.read_line(&mut hello).expect("hello");
    let command = json!({
        "type": "command",
        "id": "guard-create",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "command": {
            "type": "create",
            "sessionPath": session_path.to_string_lossy(),
            "config": {
                "cwd": cwd.to_string_lossy(),
                "sessionDir": session_path.parent().expect("sessions dir").to_string_lossy(),
            },
        },
    });
    let mut line = serde_json::to_string(&command).expect("serialize");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("send");
    writer.flush().expect("flush");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() < deadline, "no create response");
        let mut line = String::new();
        reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
        match reader.read_line(&mut line) {
            Ok(0) => panic!("daemon closed during create"),
            Ok(_) if line.trim().is_empty() => continue,
            Ok(_) => {
                let response: Value = serde_json::from_str(line.trim()).expect("parse");
                assert_eq!(response["success"], true, "create failed: {response}");
                return response["data"]["id"]
                    .as_str()
                    .or_else(|| response["data"]["activeSessionId"].as_str())
                    .expect("active session id")
                    .to_string();
            }
            Err(_) => continue,
        }
    }
}

fn run_print(args: &[&str], env: &[(String, String)]) -> (String, String, i32) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command.args(args);
    for (key, value) in env {
        command.env(key, value);
    }
    let output = command.output().expect("binary present");
    (
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code().unwrap_or(-1),
    )
}

/// `-c` refuses an active session with the exact TS error; a fresh daemon
/// (no live worker) still continues the most recent session.
#[test]
fn print_continue_refuses_an_active_daemon_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let socket = dir.path().join("daemon.sock");
    let work = dir.path().join("work");
    std::fs::create_dir_all(&work).expect("work dir");
    let env = vec![
        ("HOME".to_string(), dir.path().to_string_lossy().to_string()),
        (
            "PRIME_AGENT_CODING_AGENT_DIR".to_string(),
            agent_dir.to_string_lossy().to_string(),
        ),
        (
            "PRIME_AGENT_FAUX_SCRIPT".to_string(),
            json!({"responses": [{"text": "first turn"}]}).to_string(),
        ),
    ];

    // One persisted print session for the work cwd.
    let (stdout, stderr, code) = run_print(
        &[
            "-p",
            "--daemon-socket",
            &socket.to_string_lossy(),
            "seed the session",
        ],
        &env,
    );
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "first turn\n");

    let session_files: Vec<PathBuf> = std::fs::read_dir(&sessions)
        .expect("sessions")
        .flatten()
        .map(|entry| entry.path())
        .collect();
    assert_eq!(session_files.len(), 1, "one persisted session");
    let session_path = session_files[0].clone();

    // With no daemon running, -c continues the saved session.
    let (stdout, stderr, code) = run_print(
        &[
            "-p",
            "--daemon-socket",
            &socket.to_string_lossy(),
            "-c",
            "continue offline",
        ],
        &env,
    );
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "first turn\n");

    // A live daemon worker hosting the file makes -c refuse it with the
    // exact TS `SessionAlreadyActiveError` message.
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let active_session_id = make_session_active(&socket, &session_path, &work);
    let (stdout, stderr, code) = run_print(
        &[
            "-p",
            "--daemon-socket",
            &socket.to_string_lossy(),
            "-c",
            "continue me",
        ],
        &env,
    );
    assert_eq!(code, 1);
    assert!(stdout.is_empty(), "stdout: {stdout}");
    // The descriptive refusal (operator-directed): the TS-identical first
    // line, then the holder's identity and the next steps.
    let first_line = format!(
        "Error: Session is already active in {active_session_id}: {}\n",
        session_path.canonicalize().expect("canonical").display()
    );
    assert!(
        stderr.starts_with(&first_line),
        "stderr keeps the TS refusal first line: {stderr}"
    );
    assert!(
        stderr.contains("Holder: session "),
        "the refusal identifies the holder: {stderr}"
    );
    assert!(
        stderr.contains(&format!(
            "Attach to it instead: prime-agent --resume {active_session_id}\n"
        )),
        "the refusal suggests attaching to the live session: {stderr}"
    );
    assert!(
        stderr.contains("the file unlocks when that session exits"),
        "the refusal names the unlock condition: {stderr}"
    );

    // The same guard applies to --resume of the active file.
    let (stdout, stderr, code) = run_print(
        &[
            "-p",
            "--daemon-socket",
            &socket.to_string_lossy(),
            "--resume",
            &session_path.to_string_lossy(),
            "resume me",
        ],
        &env,
    );
    assert_eq!(code, 1);
    assert!(stdout.is_empty(), "stdout: {stdout}");
    assert!(
        stderr.starts_with("Error: Session is already active in "),
        "stderr: {stderr}"
    );
}

/// A session file held by a live FOREIGN lease holder — this test process
/// stands in for the other product's holder on the shared session store —
/// refuses `--resume` with the session-hold refusal. No daemon runs: the
/// roster probe has nothing to answer, and the guard's lease probe is what
/// must catch a holder no roster of this product's daemon can see. The
/// guard runs before the file is opened, so the file itself only has to
/// exist (the resume selector names it directly).
#[test]
fn print_resume_refuses_a_foreign_lease_holder() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let socket = dir.path().join("daemon.sock");
    let env = vec![
        ("HOME".to_string(), dir.path().to_string_lossy().to_string()),
        (
            "PRIME_AGENT_CODING_AGENT_DIR".to_string(),
            agent_dir.to_string_lossy().to_string(),
        ),
        (
            "PRIME_AGENT_FAUX_SCRIPT".to_string(),
            json!({"responses": [{"text": "first turn"}]}).to_string(),
        ),
    ];
    let session_path = sessions.join("foreign-held.jsonl");
    std::fs::write(&session_path, "{}\n").expect("session file");

    // The foreign holder: this test process takes the runtime lease, in
    // exactly the role the other product's daemon worker plays on the
    // shared session store. The lease-enable env is consumed at the
    // acquire itself, so it leaves this test's window immediately.
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

    // The refusal: this test process runs a build of this product (the
    // cargo test binary under /target/), so the holder classification
    // reads as another Rust build, never the TypeScript product and never
    // an unnamed process.
    // The exact actionable refusal: the classified headline, the
    // continue path with the `--daemon-socket` attach shape, the
    // take-over `kill` of this test process's pid with the holder-image
    // annotation (the pid-reuse guard: the refusal names what the kill
    // would hit, here this test binary), and the session footer (the
    // `{}\n` fixture file carries no name, so no paren).
    let holder_image = std::env::current_exe()
        .expect("own exe")
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let expected = format!(
        concat!(
            "Error: This session is currently open in another Rust build of Prime Agent ",
            "(active in foreign01ab3c) — another daemon or window of this product holds the file's ",
            "runtime lease.\n",
            "\n",
            "• Continue where you left off:\n",
            "  prime-agent-rust --daemon-socket <socket> --resume 'foreign01ab3c'\n",
            "  (<socket> is that instance's daemon socket, from the shell where you started ",
            "it — that daemon owns this session)\n",
            "\n",
            "• Take over on this daemon:\n",
            "  kill {} # the holder is {}\n",
            "  Then retry — the file unlocks when the holder exits.\n",
            "\n",
            "Session: foreign01ab3c\n"
        ),
        std::process::id(),
        holder_image
    );
    let (stdout, stderr, code) = run_print(
        &[
            "-p",
            "--daemon-socket",
            &socket.to_string_lossy(),
            "--resume",
            &session_path.to_string_lossy(),
            "resume me",
        ],
        &env,
    );
    assert_eq!(code, 1);
    assert!(stdout.is_empty(), "stdout: {stdout}");
    assert_eq!(stderr, expected);

    holder.release();

    // With the holder gone the same open proceeds: the guard's lease
    // probe answers None for a released lease (the stale record is not
    // live ownership).
    let (_stdout, stderr, code) = run_print(
        &[
            "-p",
            "--daemon-socket",
            &socket.to_string_lossy(),
            "--resume",
            &session_path.to_string_lossy(),
            "resume me now",
        ],
        &env,
    );
    assert_eq!(
        code, 0,
        "the released holder must let the open proceed: stderr {stderr}"
    );
    assert!(!stderr.contains("This session is currently open"));
}
