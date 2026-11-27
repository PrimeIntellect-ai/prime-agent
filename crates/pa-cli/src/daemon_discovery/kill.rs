//! Process-kill primitives: every signal is identity-gated by the process start
//! id so a recycled pid can never be mistaken for the process discovery saw.

use std::path::Path;

use pa_core::platform::process::{kill_pid, Signal};
use pa_types::platform::process::{is_process_alive, process_start_id};

use super::{evaluate_shutdown_quiet_period, DaemonStateRoot, DiscoveredDaemonProcess};

/// How long the residual sweep may run before it declares the listener
/// set stuck.
const SHUTDOWN_CONVERGENCE_TIMEOUT_MS: u128 = 10_000;

/// Verified force-kill, hardened: SIGTERM, a 1s grace, then SIGKILL, then a
/// poll loop (25ms slices, 1s deadline) reporting the kill only once the
/// process is confirmed gone (zombies count as dead — [`is_process_alive`]).
/// Deliberate TS divergence (TS fires SIGKILL and returns without verifying):
/// a stop path must not claim a stop a D-state process never performed.
pub(super) fn force_kill_daemon(pid: u32) -> bool {
    kill_daemon(pid);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    while std::time::Instant::now() < deadline {
        if !is_alive(pid) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let _ = kill_pid(pid as i32, Signal::Kill);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    loop {
        if !is_alive(pid) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

pub(super) fn kill_daemon(pid: u32) {
    if pid > 0 {
        let _ = kill_pid(pid as i32, Signal::Term);
    }
}

pub(super) fn is_alive(pid: u32) -> bool {
    is_process_alive(pid).unwrap_or(false)
}

/// Remove a socket file if present; false when the unlink fails.
pub(super) fn remove_socket_file(socket_path: &Path) -> bool {
    match std::fs::remove_file(socket_path) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

/// Stop every worker tracked for one supervisor socket and clean up its records.
/// A tracked pid whose start id no longer matches belongs to a recycled pid, so
/// its worker is already gone and only the stale records are pruned. Returns the
/// failure reasons. Workers are read from the given agent dir.
pub(super) fn force_stop_tracked_workers(
    supervisor_socket_path: &Path,
    agent_dir: &Path,
) -> Vec<String> {
    let mut failures = Vec::new();
    for worker in super::find_all_tracked_workers(agent_dir) {
        if worker.supervisor_socket_path != supervisor_socket_path {
            continue;
        }
        if !stop_tracked_process(worker.pid, worker.process_start_id.as_deref()) {
            failures.push(format!("could not safely stop worker (pid {})", worker.pid));
            continue;
        }
        let _ = remove_socket_file(&worker.worker_socket_path);
        let _ = std::fs::remove_file(&worker.descriptor_path);
        let _ = std::fs::remove_file(&worker.recovery_journal_path);
    }
    failures
}

/// True when the pid no longer names the tracked process: it is dead, or its
/// start id proves the pid was recycled by an unrelated process.
fn tracked_process_gone(pid: u32, expected_start_id: Option<&str>) -> bool {
    if !is_alive(pid) {
        return true;
    }
    expected_start_id.is_some_and(|expected| process_start_id(pid).as_deref() != Some(expected))
}

/// Identity-gated stop: SIGTERM the worker (it exits keeping its resume entry),
/// then SIGKILL if it hangs. The start-id gate defeats pid reuse: a pid whose
/// start id no longer matches belongs to a recycled pid, so the tracked worker
/// is already gone — reported as stopped and never signalled.
pub(super) fn stop_tracked_process(pid: u32, expected_start_id: Option<&str>) -> bool {
    if tracked_process_gone(pid, expected_start_id) {
        return true;
    }
    let _ = kill_pid(pid as i32, Signal::Term);
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
    while is_alive(pid) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    if tracked_process_gone(pid, expected_start_id) {
        return true;
    }
    let _ = kill_pid(pid as i32, Signal::Kill);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    while is_alive(pid) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    tracked_process_gone(pid, expected_start_id)
}

/// The `--force` residual sweep: kill whatever product listeners remain in
/// the invocation's state root until the set quiets down or proves stuck;
/// report the survivors as failures. The sweep re-scans with the same root,
/// so daemons in any other root are never candidates, and worker sockets
/// never appear in the census (a supervisor's workers stop through their
/// tracked descriptors; deliberate TS divergence: TS's sweep killed worker
/// listeners too).
pub(super) fn terminate_verified_residuals(
    root: &DaemonStateRoot,
    stopped: &mut Vec<(String, String)>,
    failed: &mut Vec<(String, String)>,
    handled_pids: &std::collections::HashSet<u32>,
) {
    let started = std::time::Instant::now();
    let mut previous_signature: Option<String> = None;
    let mut quiet_since: Option<u128> = None;
    loop {
        let listeners = super::scan_listening_daemons(root);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis());
        if listeners.is_empty() {
            previous_signature = None;
            quiet_since = quiet_since.or(Some(now));
            if evaluate_shutdown_quiet_period(now, quiet_since) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
            continue;
        }
        quiet_since = None;
        let signature = listener_signature(&listeners);
        if started.elapsed().as_millis() >= SHUTDOWN_CONVERGENCE_TIMEOUT_MS {
            record_residuals(&listeners, failed, "kept respawning during shutdown");
            return;
        }
        if previous_signature.as_deref() == Some(signature.as_str()) {
            record_residuals(&listeners, failed, "remained after shutdown");
            return;
        }
        previous_signature = Some(signature);
        let mut seen_pids: std::collections::HashSet<u32> = std::collections::HashSet::new();
        for listener in &listeners {
            if !seen_pids.insert(listener.pid) {
                continue;
            }
            let already_reported = handled_pids.contains(&listener.pid);
            if terminate_verified_listener(listener) && !already_reported {
                stopped.push((
                    listener.socket_path.display().to_string(),
                    format!("stopped residual daemon process (pid {})", listener.pid),
                ));
            }
        }
    }
}

pub(super) fn record_residuals(
    listeners: &[DiscoveredDaemonProcess],
    failed: &mut Vec<(String, String)>,
    reason: &str,
) {
    for listener in listeners {
        let identity = process_start_id(listener.pid).map_or_else(
            || format!("pid {}, process identity unavailable", listener.pid),
            |start_id| format!("pid {}, start {start_id}", listener.pid),
        );
        failed.push((
            listener.socket_path.display().to_string(),
            format!("daemon {reason} ({identity})"),
        ));
    }
}

/// Kill one verified listener: the start-id gate must still name the
/// same process before and after the signal.
pub(super) fn terminate_verified_listener(listener: &DiscoveredDaemonProcess) -> bool {
    let Some(start_id) = process_start_id(listener.pid) else {
        return false;
    };
    if process_start_id(listener.pid).as_deref() != Some(start_id.as_str()) {
        return false;
    }
    let _ = kill_pid(listener.pid as i32, Signal::Term);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    while process_start_id(listener.pid).as_deref() == Some(start_id.as_str())
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if process_start_id(listener.pid).as_deref() == Some(start_id.as_str()) {
        let _ = kill_pid(listener.pid as i32, Signal::Kill);
        // Verified death (the same hardening as `force_kill_daemon`): a single
        // post-SIGKILL check races a slow teardown, so poll the identity.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while process_start_id(listener.pid).as_deref() == Some(start_id.as_str())
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
    process_start_id(listener.pid).as_deref() != Some(start_id.as_str())
}

pub(super) fn listener_signature(listeners: &[DiscoveredDaemonProcess]) -> String {
    let mut parts: Vec<String> = listeners
        .iter()
        .map(|listener| {
            format!(
                "{}:{}:{}",
                listener.pid,
                process_start_id(listener.pid).unwrap_or_else(|| "unknown".to_string()),
                listener.socket_path.display()
            )
        })
        .collect();
    parts.sort();
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::path::PathBuf;

    /// A state root inside a test-created fixture dir; the ambient
    /// environment's real paths are never part of any sweep.
    fn fixture_root(dir: &Path) -> DaemonStateRoot {
        DaemonStateRoot {
            agent_dir: dir.join("agent"),
            socket_dir: Some(dir.join("agent").join("sockets")),
            default_socket_path: dir.join("agent").join("sockets").join("daemon.sock"),
        }
    }

    /// A tracked-worker descriptor plus the record files the stop path prunes.
    /// The record names the given pid and start id, so a test can point it at a
    /// recycled pid or at a live worker.
    struct TrackedWorkerFixture {
        descriptor: PathBuf,
        worker_socket: PathBuf,
        recovery_journal: PathBuf,
    }

    fn write_tracked_worker(
        agent_dir: &Path,
        supervisor_socket_path: &Path,
        pid: u32,
        start_id: &str,
    ) -> TrackedWorkerFixture {
        let descriptor_dir = agent_dir.join("daemon-workers").join("fixture-supervisor");
        std::fs::create_dir_all(&descriptor_dir).expect("create the descriptor dir");
        let worker_socket = agent_dir.join("sockets").join("worker-fixture.sock");
        std::fs::create_dir_all(worker_socket.parent().expect("socket parent"))
            .expect("create the socket dir");
        std::fs::write(&worker_socket, b"").expect("write the worker socket fixture");
        let recovery_journal = agent_dir.join("journals").join("fixture.recovery.jsonl");
        std::fs::create_dir_all(recovery_journal.parent().expect("journal parent"))
            .expect("create the journal dir");
        std::fs::write(&recovery_journal, b"{}\n").expect("write the recovery journal");
        let descriptor = descriptor_dir.join("fixture-worker.json");
        let record = serde_json::json!({
            "workerId": "fixture-worker",
            "pid": pid,
            "processStartId": start_id,
            "supervisorSocketPath": supervisor_socket_path.display().to_string(),
            "socketPath": worker_socket.display().to_string(),
            "recoveryJournalPath": recovery_journal.display().to_string(),
        });
        std::fs::write(
            &descriptor,
            serde_json::to_string(&record).expect("serialize the descriptor"),
        )
        .expect("write the descriptor");
        TrackedWorkerFixture {
            descriptor,
            worker_socket,
            recovery_journal,
        }
    }

    #[test]
    fn residual_sweep_over_an_empty_fixture_root_reports_nothing() {
        // No product daemon is spawned here: the sweep over an empty listener
        // set completes after the quiet period and reports nothing.
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = fixture_root(tmp.path());
        let mut stopped: Vec<(String, String)> = Vec::new();
        let mut failed: Vec<(String, String)> = Vec::new();
        terminate_verified_residuals(&root, &mut stopped, &mut failed, &HashSet::new());
        assert!(stopped.is_empty());
        assert!(failed.is_empty());
    }

    fn spawn_term_ignoring_shell() -> std::process::Child {
        // A shell that swallows SIGTERM: the force-kill must escalate to SIGKILL
        // (the grandchild `sleep 1` exits on its own shortly after, no strays).
        std::process::Command::new("sh")
            .arg("-c")
            .arg("trap : TERM; while :; do sleep 1; done")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn a TERM-ignoring shell")
    }

    #[test]
    fn force_kill_daemon_confirms_the_death_of_a_killable_process() {
        let mut child = std::process::Command::new("sleep")
            .arg("60")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn a sleep child");
        assert!(
            force_kill_daemon(child.id()),
            "a TERM-killable process must die before SIGKILL"
        );
        let _ = child.wait();
    }

    #[test]
    fn force_kill_daemon_escalates_to_sigkill_and_waits_for_the_death() {
        let mut child = spawn_term_ignoring_shell();
        // This child ignores the 1s SIGTERM grace, so the confirmed-death
        // verdict can only come from the post-SIGKILL verify loop.
        assert!(
            force_kill_daemon(child.id()),
            "the post-SIGKILL verify loop must confirm the death"
        );
        let _ = child.wait();
    }

    #[test]
    fn force_kill_daemon_reports_an_already_dead_pid_as_dead() {
        let mut child = std::process::Command::new("true")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn a true child");
        let pid = child.id();
        let _ = child.wait();
        assert!(force_kill_daemon(pid));
    }

    #[test]
    fn terminate_verified_listener_confirms_the_death_of_a_live_listener() {
        let mut child = std::process::Command::new("sleep")
            .arg("60")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn a sleep child");
        let pid = child.id();
        // A dead direct child lingers as a zombie until its parent reaps it, and
        // a zombie's start id never changes — the test reaps concurrently.
        let reaper = std::thread::spawn(move || child.wait());
        let listener = DiscoveredDaemonProcess {
            pid,
            socket_path: PathBuf::from("/tmp/never-a-listener.sock"),
            uptime_seconds: None,
        };
        assert!(terminate_verified_listener(&listener));
        let _ = reaper.join();
    }

    #[test]
    fn force_stop_tracked_workers_prunes_a_recycled_pid_without_signalling_it() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let supervisor_socket_path = tmp.path().join("sockets").join("daemon.sock");
        // A live process stands in for the recycled pid: the record's start id
        // names the worker that used to own this pid, not its current owner.
        let mut child = std::process::Command::new("sleep")
            .arg("60")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn a sleep child");
        let pid = child.id();
        let stale_start_id = "ps:Fri Nov 13 02:42:27 2026";
        assert_ne!(process_start_id(pid).as_deref(), Some(stale_start_id));
        let fixture =
            write_tracked_worker(tmp.path(), &supervisor_socket_path, pid, stale_start_id);

        let failures = force_stop_tracked_workers(&supervisor_socket_path, tmp.path());

        assert!(
            failures.is_empty(),
            "a recycled pid is a stale record, not a stop failure: {failures:?}"
        );
        assert!(
            !fixture.descriptor.exists(),
            "the stale descriptor must be pruned"
        );
        assert!(
            !fixture.worker_socket.exists(),
            "the stale worker socket must be pruned"
        );
        assert!(
            !fixture.recovery_journal.exists(),
            "the stale recovery journal must be pruned"
        );
        assert!(
            is_alive(pid),
            "the pid's current owner must never be signalled"
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn force_stop_tracked_workers_stops_a_matching_worker_and_prunes_it() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let supervisor_socket_path = tmp.path().join("sockets").join("daemon.sock");
        let mut child = std::process::Command::new("sleep")
            .arg("60")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn a sleep child");
        let pid = child.id();
        let start_id = process_start_id(pid).expect("a live child exposes its start id");
        let fixture = write_tracked_worker(tmp.path(), &supervisor_socket_path, pid, &start_id);

        let failures = force_stop_tracked_workers(&supervisor_socket_path, tmp.path());

        assert!(
            failures.is_empty(),
            "the matching worker must stop: {failures:?}"
        );
        assert!(
            !fixture.descriptor.exists(),
            "the stopped worker's descriptor must be pruned"
        );
        assert!(
            !fixture.worker_socket.exists(),
            "the stopped worker's socket must be pruned"
        );
        assert!(
            !fixture.recovery_journal.exists(),
            "the stopped worker's journal must be pruned"
        );
        assert!(!is_alive(pid), "the matched worker must be stopped");
        let _ = child.wait();
    }
}
