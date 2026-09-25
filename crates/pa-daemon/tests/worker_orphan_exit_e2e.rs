//! Worker orphan-exit e2e (TS `exitIfSupervisorOrphanedForTooLong`
//! parity): a session worker whose supervisor socket never answers must
//! exit on the supervisor-lost window instead of lingering forever, and a
//! worker whose supervisor is reachable must survive the same window.
//! Leaked workers from earlier e2e suites starve later test binaries on
//! the shared mission box, so the exit is load-bearing for test hygiene
//! too (the pa-daemon/pa-cli spawn helpers arm it with a short window).
#![cfg(unix)]

use std::os::unix::net::UnixListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Kill a leftover worker at scope exit (the control case ends alive).
struct WorkerGuard {
    child: Child,
}

impl Drop for WorkerGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Spawn the real `pa-daemon worker` binary under a supervisor socket it
/// must monitor, with the supervisor-lost exit window at zero (exit at the
/// first availability check that cannot connect).
fn spawn_worker(dir: &Path, supervisor_socket: &Path) -> WorkerGuard {
    std::fs::create_dir_all(dir.join("agent")).expect("agent dir");
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("worker")
        .env(pa_daemon::worker::WORKER_ROLE_ENV, "1")
        .env(
            pa_daemon::worker::WORKER_TOKEN_ENV,
            "orphan-e2e-bootstrap-token",
        )
        .env(
            pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
            "orphan-e2e-session",
        )
        .env(
            pa_daemon::worker::WORKER_SOCKET_ENV,
            dir.join("worker.sock"),
        )
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
            supervisor_socket,
        )
        .env(
            pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV,
            dir.join("recovery.jsonl"),
        )
        .env("PRIME_AGENT_CODING_AGENT_DIR", dir.join("agent"))
        .env(pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV, "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn pa-daemon worker");
    WorkerGuard { child }
}

/// Wait until the worker's socket file appears (the worker booted and
/// bound it).
fn wait_worker_socket(socket: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !socket.exists() {
        assert!(Instant::now() < deadline, "worker socket never appeared");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Wait for the child to exit on its own within `budget`; false when it is
/// still running at the deadline.
fn wait_exit(child: &mut Child, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        if let Some(status) = child.try_wait().expect("poll worker") {
            assert!(status.success(), "worker exited with {status}");
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn orphaned_worker_exits_when_the_supervisor_socket_never_answers() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    // A supervisor socket nobody ever bound: the worker's availability
    // checks can never connect.
    let supervisor_socket = dir.path().join("never-bound-supervisor.sock");
    let mut worker = spawn_worker(dir.path(), &supervisor_socket);
    wait_worker_socket(&dir.path().join("worker.sock"));
    // The first availability check (1.5s after boot) sees the unreachable
    // socket and the zero window exits the worker.
    assert!(
        wait_exit(&mut worker.child, Duration::from_secs(15)),
        "the orphaned worker exited on the supervisor-lost window"
    );
    // The TS graceful exit owns its socket file: the orphan exit removes
    // it, so a respawn does not wait out the stale-socket path.
    assert!(
        !dir.path().join("worker.sock").exists(),
        "the exited worker removed its socket file"
    );
}

#[test]
fn worker_with_a_reachable_supervisor_survives_the_lost_window() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let supervisor_socket = dir.path().join("live-supervisor.sock");
    let listener = UnixListener::bind(&supervisor_socket).expect("bind supervisor socket");
    let mut worker = spawn_worker(dir.path(), &supervisor_socket);
    wait_worker_socket(&dir.path().join("worker.sock"));
    // Past the first availability check (1.5s) with margin: the reachable
    // supervisor resets the absence timer every check, so the same zero
    // window that exits the orphan case must leave this worker alive.
    std::thread::sleep(Duration::from_secs(4));
    let exited = worker.child.try_wait().expect("poll worker").is_some();
    assert!(
        !exited,
        "the worker survived the lost window while its supervisor answered"
    );
    drop(listener);
}
