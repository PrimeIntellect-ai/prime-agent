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

//! End-to-end containment tests for the daemon-discovery commands. Every
//! daemon lives in a test-created fixture directory. A discovery scan or
//! `shutdown --force` run from a *different* fixture root must never see or
//! stop it — nor any other live daemon on the machine.
#![cfg(unix)]

use std::io::{BufRead as _, BufReader, Write as _};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Environment keys this box's own prime-agent worker sets; they must not
/// leak into spawned supervisors.
const SCRUB_ENV: [&str; 9] = [
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER",
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN",
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID",
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_INSTANCE_ID",
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL",
    "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET",
    "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL",
    "PRIME_AGENT_INTERNAL_SESSION_LEASES",
    "PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID",
];

/// Child-mode env var for the launcher test's re-exec'd client (below):
/// the socket the client must launch a supervisor on.
const LAUNCHER_CLIENT_SOCKET_ENV: &str = "PRIME_AGENT_TEST_LAUNCHER_CLIENT_SOCKET";

fn cli_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_prime-agent"))
}

/// A spawned supervisor, killed on drop so a failed test never leaks a
/// daemon into the machine.
struct Daemon {
    child: Child,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Spawn the real supervisor on a fixture socket the way production does
/// (`prime-agent --mode daemon --daemon-socket`), with agent dir and TMPDIR
/// pinned inside the fixture root so every socket it ever makes stays there.
#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &Path, agent_dir: &Path, tmp_dir: &Path) -> Daemon {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    std::fs::create_dir_all(tmp_dir).expect("tmp dir");
    let mut command = Command::new(cli_binary());
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .env("TMPDIR", tmp_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for key in SCRUB_ENV {
        command.env_remove(key);
    }
    // A supervisor killed at teardown must not leak its session workers into
    // later test binaries: the worker's supervisor-lost exit runs on this
    // short window instead of the 5-minute default.
    command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    let child = command.spawn().expect("spawn daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if socket.exists() {
            return Daemon { child };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

/// Run the CLI with its state root pinned inside `root`: agent dir and TMPDIR
/// resolve there, so the invocation's `DaemonStateRoot` can never be the
/// ambient environment's real paths.
fn run_cli(root: &Path, args: &[&str]) -> Output {
    let agent_dir = root.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let mut command = Command::new(cli_binary());
    command
        .args(args)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        .env("TMPDIR", root)
        .stdin(Stdio::null());
    for key in SCRUB_ENV {
        command.env_remove(key);
    }
    // The state root follows this var (the env-pinned root contract), so a
    // root-less invocation must not inherit an ambient pin.
    command.env_remove("PRIME_AGENT_DAEMON_SOCKET");
    command.output().expect("spawn CLI binary")
}

/// The same launcher used before the TUI attaches must create a supervisor
/// outside the TUI's terminal session. Otherwise closing that terminal can
/// hang up a daemon that still serves other clients.
///
/// The launching client is a separate process: this test binary re-exec'd
/// in the child mode below, with the fixture's state environment pinned on
/// its spawn the same way `spawn_daemon` pins its children. The supervisor
/// the client launches inherits that pinned environment — never this
/// process's ambient one, which on a dev box points at the real agent dir —
/// and afterwards the whole client process is gone, not just its runtime:
/// the terminal-close scenario. Only the supervisor it spawned may remain.
#[test]
fn interactive_launcher_detaches_supervisor_from_client_session() {
    use std::io::{BufRead as _, BufReader};

    let fixture = tempfile::tempdir().expect("fixture");
    let agent_dir = fixture.path().join("agent");
    let tmp_dir = fixture.path().join("tmp");
    let socket = fixture.path().join("launched.sock");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    std::fs::create_dir_all(&tmp_dir).expect("tmp dir");
    let _daemon = DetachedDaemon {
        socket: socket.clone(),
    };

    let mut client = Command::new(std::env::current_exe().expect("test binary"));
    client
        .arg("--exact")
        .arg("launcher_client_child_mode")
        .current_dir(fixture.path())
        .env(LAUNCHER_CLIENT_SOCKET_ENV, &socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        .env("TMPDIR", &tmp_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in SCRUB_ENV {
        client.env_remove(key);
    }
    // A supervisor killed at teardown must not leak its session workers
    // into later test binaries: the worker's supervisor-lost exit runs on
    // this short window instead of the 5-minute default.
    client.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    let client = client.output().expect("spawn launcher client");
    assert!(
        client.status.success(),
        "the launcher client failed: {}{}",
        String::from_utf8_lossy(&client.stdout),
        String::from_utf8_lossy(&client.stderr),
    );
    // The spawning client's process, runtime, and probe connection are gone.

    let stream = UnixStream::connect(&socket).expect("daemon socket");
    let mut hello = String::new();
    BufReader::new(stream)
        .read_line(&mut hello)
        .expect("read daemon hello");
    let hello: Value = serde_json::from_str(&hello).expect("parse daemon hello");
    let pid = hello["supervisorPid"].as_i64().expect("supervisor pid") as i32;
    assert_eq!(unsafe { libc::getsid(pid) }, pid, "daemon owns its session");
    assert_ne!(
        unsafe { libc::getsid(0) },
        pid,
        "daemon must not share the launching client's terminal session"
    );
    assert!(
        UnixStream::connect(&socket).is_ok(),
        "daemon remains available"
    );
}

/// Child mode for the test above (a plain `cargo test` run without the env
/// var passes trivially): this binary re-exec'd as the launching client —
/// run the real launcher (`ensure_daemon_running_with`, the interactive
/// mode's pre-TUI path) against the fixture socket and exit, leaving only
/// the detached supervisor behind.
#[test]
fn launcher_client_child_mode() {
    let Some(socket) = std::env::var_os(LAUNCHER_CLIENT_SOCKET_ENV) else {
        return;
    };
    let socket = PathBuf::from(socket);
    let spawn_cwd = std::env::current_dir().expect("cwd");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime
        .block_on(pa_cli::ensure_daemon_running_with(
            &cli_binary(),
            &socket,
            &spawn_cwd,
        ))
        .expect("launch supervisor");
}

/// Cleanup for a daemon spawned by the interactive launcher rather than by
/// this test process's `Command`, including a failed assertion's unwind:
/// write the force-shutdown command over the wire, wait for the supervisor
/// to stop listening (its listener is torn down as it exits), and SIGKILL
/// it when the bound passes — a hung daemon must not leak into later test
/// binaries, nor outlive the fixture tempdir's removal below.
struct DetachedDaemon {
    socket: PathBuf,
}

impl Drop for DetachedDaemon {
    fn drop(&mut self) {
        // `None`: the daemon is already gone, or wedged before its hello
        // with no pid to kill — nothing left to clean up.
        let Some(pid) = run_shutdown_on_socket(&self.socket) else {
            return;
        };
        if socket_stops_accepting(&self.socket, Duration::from_secs(10)) {
            return;
        }
        // The shutdown was accepted but the supervisor never exited. The
        // supervisor owns its own session (the property under test), so the
        // process-group kill takes any session workers with it.
        // SAFETY: the pid comes from the shutdown handshake above; this
        // test's own fixture supervisor.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
            libc::kill(pid, libc::SIGKILL);
        }
        socket_stops_accepting(&self.socket, Duration::from_secs(5));
    }
}

/// Connect to the daemon on `socket`, read its hello for the supervisor
/// pid, and write the force-shutdown command. `None`: the daemon is
/// already gone, or wedged before its hello.
fn run_shutdown_on_socket(socket: &Path) -> Option<i32> {
    use std::io::{BufRead as _, BufReader, Write as _};
    let mut stream = UnixStream::connect(socket).ok()?;
    // A wedged daemon must not hang the cleanup handshake: the hello is
    // read under a short bound.
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let mut hello = String::new();
    BufReader::new(stream.try_clone().ok()?)
        .read_line(&mut hello)
        .ok()?;
    let pid = serde_json::from_str::<Value>(&hello)
        .ok()?
        .get("supervisorPid")?
        .as_i64()? as i32;
    let command = serde_json::json!({
        "type": "command", "id": "test-cleanup",
        "protocol": { "name": "prime-agent.daemon", "version": pa_types::daemon::DAEMON_PROTOCOL_VERSION },
        "command": { "type": "shutdown", "force": true }
    });
    // The write is best-effort: a failed write leaves the kill path above
    // as the safety net.
    let _ = writeln!(stream, "{command}");
    Some(pid)
}

/// Wait until nothing accepts connections on `socket`, bounded; `false`
/// means the bound passed with the socket still live.
fn socket_stops_accepting(socket: &Path, bound: Duration) -> bool {
    let deadline = Instant::now() + bound;
    while UnixStream::connect(socket).is_ok() {
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// Every socketPath in a JSON report, from both the stopped and failed rows.
fn reported_socket_paths(report: &Value) -> Vec<String> {
    ["stopped", "failed", "reaped", "skipped"]
        .iter()
        .flat_map(|key| {
            report
                .get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|row| {
            row.get("socketPath")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

#[test]
fn doctor_lists_and_then_reaps_an_idle_root_owned_daemon() {
    let fixture = tempfile::tempdir().expect("fixture");
    let agent_dir = fixture.path().join("agent");
    let socket = agent_dir.join("daemon.sock"); // non-default: not <socket-dir>/daemon.sock
    let mut daemon = spawn_daemon(&socket, &agent_dir, &fixture.path().join("tmp"));

    // Inspect-only doctor: the daemon shows up in the table and survives.
    let inspect = run_cli(fixture.path(), &["doctor"]);
    assert_eq!(inspect.status.code(), Some(0), "{}", stderr(&inspect));
    let table = stdout(&inspect);
    let header = table.split('\n').next().unwrap_or_default();
    assert_eq!(
        header.split_whitespace().collect::<Vec<_>>(),
        ["socket", "pid", "version", "status", "sessions", "uptime"],
        "table header mismatch: {table}"
    );
    assert!(
        table.contains(&*socket.to_string_lossy()),
        "table must list the fixture daemon: {table}"
    );
    assert!(
        !table.contains("* default background service"),
        "a non-default socket must not carry the default footnote: {table}"
    );
    assert!(
        UnixStream::connect(&socket).is_ok(),
        "doctor (inspect) must leave the daemon listening"
    );
    assert!(daemon.child.try_wait().expect("wait").is_none());

    // `doctor --fix` reaps the idle non-default daemon.
    let fix = run_cli(fixture.path(), &["doctor", "--fix", "--json"]);
    assert_eq!(fix.status.code(), Some(0), "{}", stderr(&fix));
    let report: Value = serde_json::from_str(&stdout(&fix)).expect("reap json report");
    let reaped = report
        .get("reaped")
        .and_then(Value::as_array)
        .expect("reaped rows");
    assert_eq!(reaped.len(), 1, "reap report: {}", stdout(&fix));
    assert_eq!(
        reaped[0].get("socketPath").and_then(Value::as_str),
        Some(socket.to_string_lossy().as_ref())
    );
    let action = reaped[0]
        .get("action")
        .and_then(Value::as_str)
        .expect("action");
    assert!(
        action.starts_with("stopped idle background service"),
        "reap action: {action}"
    );
    assert!(
        report
            .get("skipped")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty),
        "skipped rows: {}",
        stdout(&fix)
    );
    wait_until_stopped(&socket, &mut daemon);
}

#[test]
fn shutdown_without_force_requires_confirmation_and_harms_nothing() {
    let fixture = tempfile::tempdir().expect("fixture");
    let agent_dir = fixture.path().join("agent");
    let socket = agent_dir.join("daemon.sock");
    let mut daemon = spawn_daemon(&socket, &agent_dir, &fixture.path().join("tmp"));

    // Non-interactive stdin: the router refuses before any discovery.
    let tty_error = run_cli(fixture.path(), &["shutdown"]);
    assert_eq!(tty_error.status.code(), Some(1));
    assert!(
        stderr(&tty_error).contains(
            "Shutdown requires confirmation in an interactive terminal. Use \"prime-agent shutdown --force\"."
        ),
        "router error mismatch: {}{}",
        stdout(&tty_error),
        stderr(&tty_error)
    );
    assert!(UnixStream::connect(&socket).is_ok());

    // JSON without force: the daemon is counted, the report demands --force.
    let json_error = run_cli(fixture.path(), &["shutdown", "--json"]);
    assert_eq!(json_error.status.code(), Some(1));
    let report: Value = serde_json::from_str(&stdout(&json_error)).expect("json report");
    let failed = report
        .get("failed")
        .and_then(Value::as_array)
        .expect("failed rows");
    assert_eq!(failed.len(), 1, "report: {}", stdout(&json_error));
    assert_eq!(
        failed[0].get("socketPath").and_then(Value::as_str),
        Some(socket.to_string_lossy().as_ref())
    );
    assert_eq!(
        failed[0].get("reason").and_then(Value::as_str),
        Some("confirmation required; use \"prime-agent shutdown --force --json\"")
    );
    assert!(
        report
            .get("stopped")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty),
        "stopped rows: {}",
        stdout(&json_error)
    );

    // The daemon is untouched by both refusals.
    assert!(UnixStream::connect(&socket).is_ok());
    assert!(daemon.child.try_wait().expect("wait").is_none());
}

#[test]
fn discovery_and_shutdown_from_another_root_leave_a_foreign_daemon_alive() {
    // Fixture A holds a live supervisor; fixture B is a completely different
    // state root. Everything run from B must leave A untouched.
    let fixture_a = tempfile::tempdir().expect("fixture A");
    let fixture_b = tempfile::tempdir().expect("fixture B");
    let agent_a = fixture_a.path().join("agent");
    // The socket must sit inside A's state root (the agent dir) so root-A
    // discovery is expected to own it; anything at the fixture root itself
    // is outside the root by the TS state-root rules.
    let socket_a = agent_a.join("daemon.sock");
    let mut daemon = spawn_daemon(&socket_a, &agent_a, &fixture_a.path().join("tmp"));

    // `status` from root B: A is not in B's root, so nothing is reported.
    let status = run_cli(fixture_b.path(), &["status", "--json"]);
    assert_eq!(
        status.status.code(),
        Some(0),
        "status stderr: {}",
        stderr(&status)
    );
    assert_eq!(stdout(&status).trim(), "[]");

    // `shutdown --force --json` from root B: succeeds, reports nothing, and
    // reports no socket outside fixture B (a containment regression would
    // surface this sandbox's live ambient daemons here — or kill them).
    let shutdown = run_cli(fixture_b.path(), &["shutdown", "--force", "--json"]);
    assert_eq!(
        shutdown.status.code(),
        Some(0),
        "shutdown stdout: {} stderr: {}",
        stdout(&shutdown),
        stderr(&shutdown)
    );
    let report: Value = serde_json::from_str(&stdout(&shutdown)).expect("shutdown json report");
    assert!(
        reported_socket_paths(&report).is_empty(),
        "shutdown from root B must not report any daemon: {}",
        stdout(&shutdown)
    );

    // The daemon in A survived untouched: still listening, still running.
    assert!(
        UnixStream::connect(&socket_a).is_ok(),
        "foreign daemon socket must still accept connections"
    );
    assert!(
        daemon.child.try_wait().expect("wait on daemon").is_none(),
        "foreign daemon process must still be running"
    );

    // Positive control: the same shutdown rooted at A does stop A's daemon —
    // containment only excludes what is outside the invocation's root.
    let shutdown = run_cli(fixture_a.path(), &["shutdown", "--force", "--json"]);
    assert_eq!(
        shutdown.status.code(),
        Some(0),
        "shutdown stdout: {} stderr: {}",
        stdout(&shutdown),
        stderr(&shutdown)
    );
    let report: Value = serde_json::from_str(&stdout(&shutdown)).expect("shutdown json report");
    let paths = reported_socket_paths(&report);
    assert_eq!(paths, vec![socket_a.to_string_lossy().to_string()]);
    assert!(
        report
            .get("failed")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty),
        "stopping the root-owned daemon must not fail: {}",
        stdout(&shutdown)
    );

    // The supervisor exits and stops listening.
    wait_until_stopped(&socket_a, &mut daemon);
}

/// Wait for the daemon's socket to stop accepting connections and its
/// process to exit, bounded at 10s (a supervisor shutdown handshake is fast;
/// the bound only guards a stuck test).
fn wait_until_stopped(socket: &Path, daemon: &mut Daemon) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while UnixStream::connect(socket).is_ok() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        UnixStream::connect(socket).is_err(),
        "daemon must stop listening: {}",
        socket.display()
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while daemon.child.try_wait().expect("wait on daemon").is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        daemon.child.try_wait().expect("wait on daemon").is_some(),
        "daemon process must exit: {}",
        socket.display()
    );
}

/// The env-pinned invocation shape: the CLI runs with daemon B's state
/// environment — B's agent dir, the shared TMPDIR, and B's socket through
/// `PRIME_AGENT_DAEMON_SOCKET` (a root-less invocation scrubs an ambient
/// pin so it resolves the default root).
fn run_cli_state_env(
    tmp: &Path,
    agent_dir: &Path,
    daemon_socket: Option<&Path>,
    args: &[&str],
) -> Output {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let mut command = Command::new(cli_binary());
    command
        .args(args)
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .env("TMPDIR", tmp)
        .stdin(Stdio::null());
    for key in SCRUB_ENV {
        command.env_remove(key);
    }
    match daemon_socket {
        Some(socket) => command.env("PRIME_AGENT_DAEMON_SOCKET", socket),
        None => command.env_remove("PRIME_AGENT_DAEMON_SOCKET"),
    };
    command.output().expect("spawn CLI binary")
}

/// A raw JSONL protocol client: connect, then wait for the response
/// carrying the request id (the hello line on a fresh connection is
/// skipped on the way).
struct Wire {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Wire {
    fn connect(socket: &Path) -> Wire {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match UnixStream::connect(socket) {
                Ok(stream) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(10)))
                        .expect("set read timeout");
                    let writer = stream.try_clone().expect("clone socket");
                    return Wire {
                        reader: BufReader::new(stream),
                        writer,
                    };
                }
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("connect daemon at {}: {error}", socket.display()),
            }
        }
    }

    fn request(&mut self, id: &str, command: &Value) -> Value {
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": pa_types::daemon::DAEMON_PROTOCOL_VERSION },
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
        loop {
            let mut line = String::new();
            self.reader.read_line(&mut line).expect("read daemon line");
            if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                if value.get("id").and_then(Value::as_str) == Some(id) {
                    return value;
                }
            }
        }
    }
}

/// One live scripted (faux) session: the supervisor spawns a real worker
/// whose engine answers from the script file, so a worker process exists
/// without any model traffic.
fn create_scripted_session(socket: &Path, agent_dir: &Path) -> String {
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let script = agent_dir.join("faux-script.json");
    std::fs::write(
        &script,
        json!({ "responses": [{ "text": "ok", "delayMs": 0 }] }).to_string(),
    )
    .expect("write script");
    let mut wire = Wire::connect(socket);
    let response = wire.request(
        "create-faux",
        &json!({
            "type": "create",
            "name": "scope",
            "config": {
                "cwd": agent_dir.to_string_lossy(),
                "sessionDir": sessions.to_string_lossy(),
                "script": script.to_string_lossy(),
            }
        }),
    );
    assert_eq!(response["success"], true, "create failed: {response}");
    response["data"]["activeSessionId"]
        .as_str()
        .or_else(|| response["data"]["id"].as_str())
        .expect("session id")
        .to_string()
}

fn pid_alive(pid: u32) -> bool {
    // Signal 0 is a pure liveness probe (the test binary runs as the same
    // user as the daemons it spawned).
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn wait_for_pid_exit(pid: u32, bound: Duration) -> bool {
    let deadline = Instant::now() + bound;
    while pid_alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    !pid_alive(pid)
}

/// The worker descriptors a supervisor persists under
/// `<agent-dir>/daemon-workers/<key>/` (`supervisor-config` has no .json and
/// is skipped); unreadable or unparsable files are not safe targets either.
fn worker_descriptors(agent_dir: &Path) -> Vec<Value> {
    let mut descriptors = Vec::new();
    let Ok(directories) = std::fs::read_dir(agent_dir.join("daemon-workers")) else {
        return descriptors;
    };
    for directory in directories.flatten() {
        let Ok(files) = std::fs::read_dir(directory.path()) else {
            continue;
        };
        for file in files.flatten() {
            if !file.file_name().to_string_lossy().ends_with(".json") {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(file.path()) {
                if let Ok(descriptor) = serde_json::from_str::<Value>(&content) {
                    descriptors.push(descriptor);
                }
            }
        }
    }
    descriptors
}

/// The pid of the live worker a supervisor tracks for its own socket.
fn tracked_worker_pid(agent_dir: &Path, supervisor_socket: &Path) -> u32 {
    let supervisor = supervisor_socket.to_string_lossy().to_string();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(pid) = worker_descriptors(agent_dir)
            .into_iter()
            .filter(|descriptor| {
                descriptor["supervisorSocketPath"].as_str() == Some(supervisor.as_str())
            })
            .find_map(|descriptor| {
                descriptor["pid"]
                    .as_u64()
                    .filter(|pid| *pid > 0 && pid_alive(*pid as u32))
            })
        {
            return pid as u32;
        }
        assert!(
            Instant::now() < deadline,
            "no live tracked worker for {}",
            supervisor_socket.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The 2026-10-14 incident, end to end: an isolated test daemon's
/// `shutdown --force` stopped the shared default daemon and killed every
/// live worker on the machine — the state root ignored
/// `PRIME_AGENT_DAEMON_SOCKET`, and the residual sweep treated worker
/// sockets as daemons. One shared TMPDIR, so every worker socket any daemon
/// spawns listens in the shared product socket dir, exactly like a real
/// machine: A owns the product-default socket, B and C are pinned to
/// sockets inside one shared directory outside the product socket dir, with
/// live workers of their own. A shutdown must stop only the daemons its
/// root owns — the pinned socket, never the pinned directory — and never
/// another daemon's workers.
#[test]
fn force_shutdown_from_an_env_pinned_root_stops_only_that_daemon_tree() {
    let shared_tmp = tempfile::tempdir().expect("shared tmpdir");
    let fixture_a = tempfile::tempdir().expect("fixture A");
    let fixture_b = tempfile::tempdir().expect("fixture B");
    let fixture_c = tempfile::tempdir().expect("fixture C");
    // SAFETY: getuid is a pure identity query.
    let socket_dir = shared_tmp
        .path()
        .join(format!("prime-agent-{}", unsafe { libc::getuid() }));

    let socket_a = socket_dir.join("daemon.sock"); // the product default
    let agent_a = fixture_a.path().join("agent");
    let mut daemon_a = spawn_daemon(&socket_a, &agent_a, shared_tmp.path());
    let _session_a = create_scripted_session(&socket_a, &agent_a);
    let worker_a = tracked_worker_pid(&agent_a, &socket_a);

    // B and C are pinned inside one shared pins directory OUTSIDE the
    // product socket dir: a pinned root must own its pinned socket, never
    // the whole directory (B's shutdown must not see C in there).
    let pins_dir = shared_tmp.path().join("pins");
    std::fs::create_dir_all(&pins_dir).expect("pins dir");

    let agent_b = fixture_b.path().join("agent");
    let socket_b = pins_dir.join("b.sock"); // env-pinned, isolated
    let mut daemon_b = spawn_daemon(&socket_b, &agent_b, shared_tmp.path());
    let _session_b = create_scripted_session(&socket_b, &agent_b);
    let worker_b = tracked_worker_pid(&agent_b, &socket_b);

    // Like the launcher-pinned daemon of the incident: C's supervisor socket
    // sits outside the product socket dir, but its worker still listens
    // there. C shares B's pins directory.
    let agent_c = fixture_c.path().join("agent");
    let socket_c = pins_dir.join("c.sock");
    let mut daemon_c = spawn_daemon(&socket_c, &agent_c, shared_tmp.path());
    let _session_c = create_scripted_session(&socket_c, &agent_c);
    let worker_c = tracked_worker_pid(&agent_c, &socket_c);

    assert!(
        pid_alive(worker_a) && pid_alive(worker_b) && pid_alive(worker_c),
        "all three workers must be live before any shutdown"
    );

    // (a) B's env-pinned shutdown stops only B: A and C — supervisors and
    // workers alike — are outside B's root.
    let shutdown = run_cli_state_env(
        shared_tmp.path(),
        &agent_b,
        Some(&socket_b),
        &["shutdown", "--force", "--json"],
    );
    assert_eq!(
        shutdown.status.code(),
        Some(0),
        "shutdown stdout: {} stderr: {}",
        stdout(&shutdown),
        stderr(&shutdown)
    );
    let report: Value = serde_json::from_str(&stdout(&shutdown)).expect("shutdown report");
    assert_eq!(
        reported_socket_paths(&report),
        vec![socket_b.to_string_lossy().to_string()],
        "the B-rooted report must name only B: {}",
        stdout(&shutdown)
    );
    wait_until_stopped(&socket_b, &mut daemon_b);
    assert!(
        wait_for_pid_exit(worker_b, Duration::from_secs(10)),
        "B's worker must stop with B (through its tracked descriptor)"
    );
    assert!(
        daemon_a
            .child
            .try_wait()
            .expect("wait on daemon A")
            .is_none(),
        "A's supervisor must survive B's env-pinned shutdown"
    );
    assert!(
        UnixStream::connect(&socket_a).is_ok(),
        "A must still accept connections"
    );
    assert!(
        pid_alive(worker_a),
        "A's worker must survive B's env-pinned shutdown"
    );
    assert!(
        daemon_c
            .child
            .try_wait()
            .expect("wait on daemon C")
            .is_none(),
        "C's supervisor must survive B's env-pinned shutdown"
    );
    assert!(
        UnixStream::connect(&socket_c).is_ok(),
        "C must still accept connections"
    );
    assert!(
        pid_alive(worker_c),
        "C's worker must survive B's env-pinned shutdown"
    );

    // (b) The default-rooted shutdown from A stops A and its worker, and
    // must leave C's worker alone even though it listens in A's socket dir:
    // the sweep only ever sees supervisors.
    let shutdown = run_cli_state_env(
        shared_tmp.path(),
        &agent_a,
        None,
        &["shutdown", "--force", "--json"],
    );
    assert_eq!(
        shutdown.status.code(),
        Some(0),
        "shutdown stdout: {} stderr: {}",
        stdout(&shutdown),
        stderr(&shutdown)
    );
    assert!(
        daemon_c
            .child
            .try_wait()
            .expect("wait on daemon C")
            .is_none(),
        "C's supervisor must survive A's default-rooted shutdown"
    );
    assert!(
        pid_alive(worker_c),
        "C's worker must survive A's default-rooted shutdown (the residual sweep may not stop another daemon's workers)"
    );
    let report: Value = serde_json::from_str(&stdout(&shutdown)).expect("shutdown report");
    assert_eq!(
        reported_socket_paths(&report),
        vec![socket_a.to_string_lossy().to_string()],
        "the A-rooted report must name only A: {}",
        stdout(&shutdown)
    );
    wait_until_stopped(&socket_a, &mut daemon_a);
    assert!(
        wait_for_pid_exit(worker_a, Duration::from_secs(10)),
        "A's worker must stop with A (through its tracked descriptor)"
    );
    assert!(
        UnixStream::connect(&socket_c).is_ok(),
        "C must still accept connections"
    );

    // (c) Cleanup: C's own env-pinned shutdown stops C and its worker.
    let shutdown = run_cli_state_env(
        shared_tmp.path(),
        &agent_c,
        Some(&socket_c),
        &["shutdown", "--force", "--json"],
    );
    assert_eq!(
        shutdown.status.code(),
        Some(0),
        "shutdown stdout: {} stderr: {}",
        stdout(&shutdown),
        stderr(&shutdown)
    );
    let report: Value = serde_json::from_str(&stdout(&shutdown)).expect("shutdown report");
    assert_eq!(
        reported_socket_paths(&report),
        vec![socket_c.to_string_lossy().to_string()],
        "the C-rooted report must name only C: {}",
        stdout(&shutdown)
    );
    wait_until_stopped(&socket_c, &mut daemon_c);
    assert!(
        wait_for_pid_exit(worker_c, Duration::from_secs(10)),
        "C's worker must stop with C (through its tracked descriptor)"
    );
}

/// An agent-dir override can contain the shared worker directory while its
/// own supervisor is pinned elsewhere. Such a root must still exclude other
/// supervisors' workers from both discovery and the force residual sweep.
#[test]
fn a_pinned_root_with_an_overlapping_agent_dir_never_stops_foreign_workers() {
    let shared_tmp = tempfile::tempdir().expect("shared worker tmpdir");
    let pins = tempfile::tempdir().expect("supervisor pins outside agent dir");
    let foreign_fixture = tempfile::tempdir().expect("foreign agent dir");
    let own_socket = pins.path().join("own.sock");
    let foreign_socket = pins.path().join("foreign.sock");
    // Every worker socket is below shared_tmp, which is also this root's
    // agent dir. Neither supervisor socket is below it.
    let own_agent = shared_tmp.path();
    let foreign_agent = foreign_fixture.path().join("agent");
    let mut own_daemon = spawn_daemon(&own_socket, own_agent, shared_tmp.path());
    let _own_session = create_scripted_session(&own_socket, own_agent);
    let own_worker = tracked_worker_pid(own_agent, &own_socket);
    let mut foreign_daemon = spawn_daemon(&foreign_socket, &foreign_agent, shared_tmp.path());
    let _foreign_session = create_scripted_session(&foreign_socket, &foreign_agent);
    let foreign_worker = tracked_worker_pid(&foreign_agent, &foreign_socket);

    let status = run_cli_state_env(
        shared_tmp.path(),
        own_agent,
        Some(&own_socket),
        &["status", "--json"],
    );
    assert!(status.status.success(), "{}", stderr(&status));
    let services: Vec<Value> = serde_json::from_str(&stdout(&status)).expect("status report");
    let sockets: Vec<&str> = services
        .iter()
        .map(|service| service["socketPath"].as_str().expect("socket path"))
        .collect();
    assert_eq!(
        sockets,
        vec![own_socket.to_str().expect("fixture path")],
        "a pinned root must discover supervisors only: {}",
        stdout(&status)
    );

    let shutdown = run_cli_state_env(
        shared_tmp.path(),
        own_agent,
        Some(&own_socket),
        &["shutdown", "--force", "--json"],
    );
    assert!(shutdown.status.success(), "{}", stderr(&shutdown));
    wait_until_stopped(&own_socket, &mut own_daemon);
    assert!(wait_for_pid_exit(own_worker, Duration::from_secs(10)));
    assert!(
        foreign_daemon
            .child
            .try_wait()
            .expect("foreign supervisor wait")
            .is_none()
            && pid_alive(foreign_worker),
        "the foreign supervisor and its original worker must survive"
    );
    assert!(UnixStream::connect(&foreign_socket).is_ok());

    // Teardown names the exact fixture socket; no machine-wide discovery.
    run_shutdown_on_socket(&foreign_socket).expect("foreign shutdown handshake");
    wait_until_stopped(&foreign_socket, &mut foreign_daemon);
    assert!(wait_for_pid_exit(foreign_worker, Duration::from_secs(10)));
}

/// A fresh top-level invocation must not inherit an ancestor worker's
/// identity: a kernel bash hands a worker's full environment to every
/// child, so `prime-agent --mode daemon --daemon-socket B` launched from
/// inside a worker must come up as B's supervisor — never as a second
/// worker of the live supervisor the inherited env points at.
#[test]
fn a_daemon_launched_with_an_inherited_worker_env_comes_up_as_a_supervisor() {
    let fixture = tempfile::tempdir().expect("fixture");
    let agent_dir = fixture.path().join("agent");
    let tmp_dir = fixture.path().join("tmp");
    let socket = fixture.path().join("daemon.sock");
    let worker_socket = fixture.path().join("worker.sock");
    let ancestor_socket = fixture.path().join("ancestor-supervisor.sock");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    std::fs::create_dir_all(&tmp_dir).expect("tmp dir");
    let mut command = Command::new(cli_binary());
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(&socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        .env("TMPDIR", &tmp_dir)
        // The inherited worker handshake set (what a kernel bash sees).
        .env(pa_daemon::worker::WORKER_ROLE_ENV, "1")
        .env(
            pa_daemon::worker::WORKER_TOKEN_ENV,
            "inherited-worker-token",
        )
        .env(
            pa_daemon::worker::WORKER_INSTANCE_ID_ENV,
            "inherited-instance",
        )
        .env(
            pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
            "inherited-session",
        )
        .env(pa_daemon::worker::WORKER_CWD_ENV, fixture.path())
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
            &ancestor_socket,
        )
        .env(pa_daemon::worker::WORKER_SOCKET_ENV, &worker_socket)
        .env(
            pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV,
            fixture.path().join("recovery.jsonl"),
        )
        .env(pa_daemon::worker::WORKER_TELEMETRY_DISABLED_ENV, "1")
        .env(
            pa_daemon::lease::SESSION_LEASE_OWNER_ID_ENV,
            "inherited-session",
        )
        .env(
            pa_core::kernel::orphan_journal::ORPHAN_PROCESS_JOURNAL_ENV,
            fixture.path().join("orphans.jsonl"),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = command.spawn().expect("spawn the daemon");
    let pid = child.id();
    let _daemon = Daemon { child };

    // The invocation must come up as B's supervisor. On a routing
    // regression the process starts as a worker instead and this socket
    // never appears.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !socket.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        socket.exists(),
        "the daemon must come up as a supervisor on {} (an inherited worker env must not reroute it into worker mode)",
        socket.display()
    );

    // The hello names this child as the supervisor.
    let stream = UnixStream::connect(&socket).expect("connect the supervisor");
    let mut hello = String::new();
    BufReader::new(stream)
        .read_line(&mut hello)
        .expect("read the daemon hello");
    let hello: Value = serde_json::from_str(hello.trim()).expect("parse the daemon hello");
    assert_eq!(
        hello["supervisorPid"].as_i64(),
        Some(i64::from(pid)),
        "the hello must name this child as the supervisor: {hello}"
    );
}
