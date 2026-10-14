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

use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

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
/// (`prime-agent --mode daemon --daemon-socket`), with agent dir, TMPDIR,
/// and the supervisor-ownership registry pinned inside the fixture root so
/// every socket it ever makes stays there - and no shutdown test's
/// admission window can make a concurrent boot refuse (the registry is
/// shared state; an unpinned boot would read a sibling test's stop window).
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
        .env(
            pa_daemon::supervisor_ownership::REGISTRY_DIR_ENV,
            tmp_dir.join("registry"),
        )
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
        .env(
            pa_daemon::supervisor_ownership::REGISTRY_DIR_ENV,
            root.join("registry"),
        )
        .stdin(Stdio::null());
    for key in SCRUB_ENV {
        command.env_remove(key);
    }
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
