//! Process-kill primitives for stopping daemons and tracked workers (TS
//! `forceKillDaemon`, `stopTrackedProcess`, `terminateVerifiedListener(s)`):
//! every signal is identity-gated by the process start id so a recycled pid
//! can never be mistaken for the process discovery saw.

use std::path::Path;

use pa_core::platform::process::{kill_pid, Signal};
use pa_types::platform::process::{is_process_alive, process_start_id};

use super::{evaluate_shutdown_quiet_period, DaemonStateRoot, DiscoveredDaemonProcess};

/// How long the residual sweep may run before it declares the listener set
/// stuck (TS `SHUTDOWN_CONVERGENCE_TIMEOUT_MS`).
const SHUTDOWN_CONVERGENCE_TIMEOUT_MS: u128 = 10_000;

/// Verified force-kill (TS `forceKillDaemon`, hardened): SIGTERM, a 1s
/// grace, then SIGKILL, then a poll loop (25ms slices, 1s deadline) that
/// reports the kill only once the process is confirmed gone (zombies count
/// as dead — [`is_process_alive`]'s lease semantics). TS fires the
/// SIGKILL and returns without verifying; the supervisor-side stop paths
/// here must not claim a stop a D-state process never performed, so the
/// verdict is the divergence.
pub(super) fn force_kill_daemon(pid: u32) -> bool {
    kill_daemon(pid);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    while std::time::Instant::now() < deadline {
        if !is_alive(pid) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    kill_pid(pid as i32, Signal::Kill);
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
        kill_pid(pid as i32, Signal::Term);
    }
}

pub(super) fn is_alive(pid: u32) -> bool {
    is_process_alive(pid).unwrap_or(false)
}

/// Remove a socket file if present; false when the unlink fails (TS
/// `removeSocketFile`). Never-touch paths are refused here as the last line
/// of containment, whatever the caller derived.
pub(super) fn remove_socket_file(socket_path: &Path) -> bool {
    if super::is_never_touch(socket_path) {
        return false;
    }
    match std::fs::remove_file(socket_path) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

/// Stop every worker tracked for one supervisor socket and clean up its
/// records (TS `forceStopTrackedWorkers`). Returns the failure reasons.
/// Workers are read from the given agent dir only (the invocation's state
/// root), never the ambient agent dir.
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

/// Identity-gated stop: SIGTERM the worker (it exits keeping its resume
/// entry), then SIGKILL if it hangs (TS `stopTrackedProcess`). The start-id
/// gate defeats pid reuse between discovery and the signal.
pub(super) fn stop_tracked_process(pid: u32, expected_start_id: Option<&str>) -> bool {
    if !is_alive(pid) {
        return true;
    }
    if let Some(expected) = expected_start_id {
        if process_start_id(pid).as_deref() != Some(expected) {
            return false;
        }
    }
    kill_pid(pid as i32, Signal::Term);
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
    while is_alive(pid) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    if !is_alive(pid) {
        return true;
    }
    if let Some(expected) = expected_start_id {
        if process_start_id(pid).as_deref() != Some(expected) {
            return false;
        }
    }
    kill_pid(pid as i32, Signal::Kill);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    while is_alive(pid) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    !is_alive(pid)
}

/// The `--force` residual sweep (TS `terminateVerifiedResiduals`): kill
/// whatever product listeners remain in the invocation's state root until
/// the set quiets down or proves stuck; report the survivors as failures.
/// The sweep re-scans with the same root it was given, so daemons in any
/// other root — or on the never-touch list — are never candidates.
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

/// Kill one verified listener (TS `terminateVerifiedListener`): the start-id
/// gate must still name the same process before and after the signal.
pub(super) fn terminate_verified_listener(listener: &DiscoveredDaemonProcess) -> bool {
    let Some(start_id) = process_start_id(listener.pid) else {
        return false;
    };
    if process_start_id(listener.pid).as_deref() != Some(start_id.as_str()) {
        return false;
    }
    kill_pid(listener.pid as i32, Signal::Term);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    while process_start_id(listener.pid).as_deref() == Some(start_id.as_str())
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if process_start_id(listener.pid).as_deref() == Some(start_id.as_str()) {
        kill_pid(listener.pid as i32, Signal::Kill);
        // Verified death (the same hardening as `force_kill_daemon`): a
        // single post-SIGKILL check races a slow teardown or reads a
        // mid-death process as survived, so poll the identity until it
        // changes or the deadline lapses.
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
            socket_dir: dir.join("agent").join("sockets"),
            default_socket_path: dir.join("agent").join("sockets").join("daemon.sock"),
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

    #[test]
    fn residual_sweep_never_touches_a_never_touch_dir() {
        // The ambient mission daemon's workers listen under these dirs; a
        // sweep rooted on them must see no listeners and harm nothing.
        for dir in ["/tmp/mission-tmp/prime-agent-1000", "/tmp/prime-agent-1000"] {
            let root = DaemonStateRoot {
                agent_dir: PathBuf::from(dir),
                socket_dir: PathBuf::from(dir),
                default_socket_path: PathBuf::from(dir).join("daemon.sock"),
            };
            let mut stopped: Vec<(String, String)> = Vec::new();
            let mut failed: Vec<(String, String)> = Vec::new();
            terminate_verified_residuals(&root, &mut stopped, &mut failed, &HashSet::new());
            assert!(
                stopped.is_empty(),
                "sweep rooted at {dir} must stop nothing"
            );
            assert!(failed.is_empty(), "sweep rooted at {dir} must fail nothing");
        }
    }

    fn spawn_term_ignoring_shell() -> std::process::Child {
        // A shell that swallows SIGTERM: the force-kill must escalate to
        // SIGKILL to make it die (the grandchild `sleep 1` exits on its own
        // at most a second after the shell dies, so no stray processes).
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
        // A dead direct child lingers as a zombie until its parent reaps
        // it, and a zombie's start id never changes - the production
        // daemon's parent (the spawning shell) reaps it, so the test
        // reaps concurrently or the identity poll would outwait both
        // deadlines on a process that is already dead.
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
    fn never_touch_socket_files_are_refused() {
        assert!(!remove_socket_file(Path::new(
            "/tmp/mission-daemon/daemon.sock"
        )));
        assert!(remove_socket_file(Path::new(
            "/tmp/discovery-no-such-socket.sock"
        )));
    }
}
