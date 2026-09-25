//! End-to-end containment tests for the daemon-discovery commands.
//!
//! Every daemon lives in a test-created fixture directory. A discovery scan
//! or `shutdown --force` run from a *different* fixture root must never see
//! or stop it — nor any other live daemon on the machine (this sandbox runs
//! next to the real mission daemon; its sockets must never surface in a
//! report). See docs/PORTING-NOTES.md ("Daemon discovery containment").
#![cfg(unix)]

use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

/// Environment keys this box's own prime-agent worker sets; they must not
/// leak into spawned supervisors (the same scrub list as
/// `daemon_commands_e2e.rs`).
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
    // A supervisor killed at teardown must not leak its session workers
    // into later test binaries: the worker's supervisor-lost exit (TS
    // `exitIfSupervisorOrphanedForTooLong`) runs on this short window
    // instead of the 5-minute default.
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
    command.output().expect("spawn CLI binary")
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
                .map(|rows| rows.to_vec())
                .unwrap_or_default()
        })
        .filter_map(|row| {
            row.get("socketPath")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

/// A live supervisor on a non-default socket inside the root: `doctor`
/// (inspect only) lists it and leaves it running; `doctor --fix` stops the
/// idle daemon and reports the reap.
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

/// `shutdown` without `--force` demands confirmation: no TTY on stdin is the
/// router error, `--json` without force is the JSON confirmation error. The
/// daemon survives both.
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
