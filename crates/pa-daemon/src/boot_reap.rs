//! The daemon-boot predecessor reap (operator-directed product behavior,
//! a sanctioned divergence from TS documented per the #289 precedent).
//!
//! A session worker outlives its supervisor by design (the TS daemon spawns
//! it detached; [`crate::supervisor_lost`] garbage-collects it only after a
//! five-minute unreachable-supervisor window). That window never fires for
//! a worker whose supervisor died while a NEW daemon took over the same
//! socket path: the worker's availability probe connects to the new
//! daemon and resets the absence timer, so a leftover worker holds its
//! runtime session lease forever - every open of its session bounces with
//! `Session is already active in <leftover id>`, and nothing on the new
//! daemon can reach it: its registration is refused (its descriptor was
//! deleted at the predecessor's terminal stop, or never written), the
//! adoption pass cannot adopt it (no descriptor), and the create-open
//! reuse seam cannot reuse it (no resident).
//!
//! The operator's semantics: a daemon that boots on a socket owns that
//! socket's lineage - same-socket predecessor leftovers die at boot, so
//! their leases clear and opening a session post-restart works. Daemons -
//! and workers - on DIFFERENT sockets are never touched (the two-daemons-
//! one-store fleet; the mission-box containment rule): the scan matches
//! the predecessor identity by the socket path alone.
//!
//! What the reap takes, exactly:
//! - Worker processes (`worker` as their first argument - the argv the
//!   supervisor spawns) whose `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET`
//!   names THIS daemon's socket, minus the pids this daemon's own
//!   descriptors name (those are the adoption pass's business: a crash
//!   restart's live workers re-register and keep serving - the
//!   must-not-lose-sessions invariant). The argv gate is load-bearing:
//!   the supervisor-socket env var propagates to every process a session
//!   worker spawns (kernels, bash children, tool servers), and an env-only
//!   match would kill a session's whole process tree at the next daemon
//!   boot - the readoption_wake regression this gate exists for.
//! - Supervisor processes of THIS socket path that are not this process:
//!   a wedged predecessor (alive but unreachable - its socket was probed
//!   stale and replaced) would otherwise keep its orphaned listener and
//!   its workers' supervisor connections forever.
//!
//! The escalation is the CLI stop contract (`stop_tracked_process`):
//! SIGTERM, a bounded grace, SIGKILL, a bounded verify - identity-gated by
//! the process start id so a recycled pid is never signaled. Processes the
//! platform cannot enumerate (non-Linux, no /proc) are not reaped here; the
//! worker-side refused-registration self-heal covers those platforms.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::supervisor::Supervisor;

/// Grace after SIGTERM before the force escalation (the CLI stop contract's
/// worker grace; TS `stopWorkerUntracked`'s non-force graceful deadline).
const TERM_GRACE: Duration = Duration::from_secs(2);
/// Verify window after SIGKILL before the reap reports the survivor.
const KILL_VERIFY: Duration = Duration::from_secs(1);
/// The reap poll cadence.
const POLL: Duration = Duration::from_millis(25);

/// One reap target discovered on this socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReapTarget {
    /// The target's pid.
    pub(crate) pid: u32,
    /// The process start id at discovery (the identity gate).
    pub(crate) start_id: Option<String>,
    /// The target's own worker socket file, when known (a worker): removed
    /// with the process so the socket dir keeps no stale endpoint.
    pub(crate) worker_socket: Option<PathBuf>,
    /// What the process is (the log line names it).
    pub(crate) kind: ReapKind,
}

/// The kind of same-socket predecessor a target is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReapKind {
    /// A leftover session worker of a previous daemon on this socket.
    Worker,
    /// A wedged supervisor process bound to this socket path.
    Supervisor,
}

/// The per-target outcome (the boot log line's evidence).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReapOutcome {
    /// The process was gone before any signal.
    AlreadyGone,
    /// The process exited inside the SIGTERM grace.
    Term,
    /// The process died to SIGKILL.
    Kill,
    /// The process outlived SIGKILL (a D-state wedged task): reported,
    /// never hidden - its lease stays held; the operator-facing refusal
    /// keeps naming the holder.
    Survived,
}

/// Reap the same-socket predecessors before the first client or adoption
/// pass can race the reap (a create that lands mid-reap against a leftover
/// holder answers the lease refusal; after the reap it succeeds).
pub(crate) async fn reap_predecessors(supervisor: &Arc<Supervisor>) {
    let socket_path = supervisor.options.socket_path.clone();
    let descriptor_dir = supervisor.descriptor_dir();
    // The adoption pass's business, never the reap's: the pids this
    // daemon's own descriptors name (a crash restart's live workers
    // re-register and keep serving).
    let protected: HashSet<u32> =
        crate::descriptor::load_descriptors(&descriptor_dir, &socket_path)
            .into_iter()
            .map(|(_, descriptor)| descriptor.pid as u32)
            .collect();
    let mut targets = same_socket_worker_targets(&socket_path, &protected);
    targets.extend(same_socket_supervisor_targets(&socket_path));
    if targets.is_empty() {
        return;
    }
    supervisor.log_line(&format!(
        "boot reap: {} same-socket predecessor process(es) to clear",
        targets.len()
    ));
    // Concurrent: a stuck target's bounded escalation must not serialize
    // the reap (a box of leftovers still boots in one escalation window).
    let outcomes = futures::future::join_all(
        targets
            .iter()
            .map(|target| async move {
                let outcome = stop_target(target).await;
                supervisor.log_line(&format!(
                    "boot reap: {} pid {} (start id {:?}) - {:?}",
                    match target.kind {
                        ReapKind::Worker => "leftover worker",
                        ReapKind::Supervisor => "wedged supervisor",
                    },
                    target.pid,
                    target.start_id,
                    outcome
                ));
                (target.clone(), outcome)
            })
            .collect::<Vec<_>>(),
    )
    .await;
    // The dead workers' socket files leave with them (a killed process
    // cannot clean up after itself; the ids never repeat, so a stale
    // endpoint would linger past every spawn).
    for (target, outcome) in outcomes {
        if let (Some(socket), ReapOutcome::Term | ReapOutcome::Kill) =
            (&target.worker_socket, outcome)
        {
            let _ = std::fs::remove_file(socket);
        }
    }
}

/// Stop one worker process by identity: the supervisor's terminal-stop
/// escalation (a worker that missed its routed `shutdown`). Same contract as
/// [`reap_predecessors`]'s targets: identity-gated SIGTERM, grace, SIGKILL,
/// verify. `None` as the start id trusts liveness alone (the same
/// conservative gate the lease's stale-owner rule applies).
pub(crate) async fn stop_process(pid: u32, start_id: Option<String>) -> ReapOutcome {
    stop_target(&ReapTarget {
        pid,
        start_id,
        worker_socket: None,
        kind: ReapKind::Worker,
    })
    .await
}

/// Whether the pid still names the discovered process (the identity gate: a
/// recycled pid is a different process and is never signaled).
fn identity_current(target: &ReapTarget) -> bool {
    match &target.start_id {
        Some(expected) => {
            crate::lease::get_process_start_id(target.pid).as_deref() == Some(expected.as_str())
        }
        // No observable identity: liveness alone answers (the conservative
        // gate - an unobservable holder is never signaled twice on a guess).
        None => true,
    }
}

/// Stop one target: gone check, SIGTERM, grace, SIGKILL, verify.
async fn stop_target(target: &ReapTarget) -> ReapOutcome {
    if !identity_current(target) || !crate::lease::is_process_alive(target.pid).unwrap_or(false) {
        return ReapOutcome::AlreadyGone;
    }
    pa_core::platform::process::kill_pid(
        target.pid as i32,
        pa_core::platform::process::Signal::Term,
    );
    if await_gone(target, TERM_GRACE).await {
        return ReapOutcome::Term;
    }
    pa_core::platform::process::kill_pid(
        target.pid as i32,
        pa_core::platform::process::Signal::Kill,
    );
    if await_gone(target, KILL_VERIFY).await {
        return ReapOutcome::Kill;
    }
    ReapOutcome::Survived
}

/// Poll until the identity-gated pid is gone or the budget runs out.
async fn await_gone(target: &ReapTarget, budget: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        if !identity_current(target) || !crate::lease::is_process_alive(target.pid).unwrap_or(false)
        {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(POLL).await;
    }
}

/// The same-socket leftover workers, identified by the WORKER PROCESS
/// SHAPE, never by the environment alone: the supervisor-socket env var
/// propagates to EVERY process a session worker spawns (its kernel, its
/// bash children, its tools' children - 223 processes on the mission box
/// name the default socket), so an env-only match would kill a session's
/// whole process tree at the next daemon boot. A leftover worker is a
/// process that (1) runs the product's worker role (`worker` as its first
/// argument - the exact argv the supervisor spawns, `prime-agent worker`),
/// (2) whose supervisor socket env names THIS daemon's socket, and
/// (3) whose own worker socket env names its endpoint - minus the pids
/// this daemon's own descriptors name (the adoption pass's business).
/// Linux-only (the /proc census); other platforms answer nothing.
#[cfg(target_os = "linux")]
fn same_socket_worker_targets(socket_path: &Path, protected: &HashSet<u32>) -> Vec<ReapTarget> {
    let socket = socket_path.to_string_lossy().to_string();
    let mut targets = Vec::new();
    for pid in numeric_proc_entries() {
        if pid == std::process::id() || protected.contains(&pid) {
            continue;
        }
        let Some(argv) = read_proc_argv(pid) else {
            continue;
        };
        if !is_worker_argv(&argv) {
            continue;
        }
        let Some(environ) = read_proc_environ(pid) else {
            continue;
        };
        if !environ.iter().any(|entry| {
            entry == &format!("{}={}", crate::worker::WORKER_SUPERVISOR_SOCKET_ENV, socket)
        }) {
            continue;
        }
        let worker_socket = environ
            .iter()
            .find_map(|entry| entry.strip_prefix(&format!("{}=", crate::worker::WORKER_SOCKET_ENV)))
            .map(PathBuf::from);
        targets.push(ReapTarget {
            pid,
            start_id: crate::lease::get_process_start_id(pid),
            worker_socket,
            kind: ReapKind::Worker,
        });
    }
    targets
}

/// Whether a command line is the product's worker role: `worker` as the
/// first argument (`prime-agent worker`, `pa-daemon worker` - the argv the
/// supervisor spawns). The env-propagation hazard this gate exists for: a
/// session kernel, a bash child, or a tool's server inherits the worker
/// env but never runs the worker role.
pub(crate) fn is_worker_argv(argv: &[String]) -> bool {
    argv.first()
        .is_some_and(|exe| !exe.is_empty() && Path::new(exe).file_name().is_some())
        && argv.get(1).map(String::as_str) == Some("worker")
}

#[cfg(not(target_os = "linux"))]
fn same_socket_worker_targets(_socket_path: &Path, _protected: &HashSet<u32>) -> Vec<ReapTarget> {
    Vec::new()
}

/// The wedged supervisors of this socket path: a supervisor-shaped process
/// whose command line names this socket (the CLI's `--mode daemon
/// --daemon-socket <path>` product form, or the `supervisor --socket <path>`
/// pa-daemon form), excluding this process. A healthy predecessor can never
/// be here: its listener would have refused this daemon's bind.
#[cfg(target_os = "linux")]
fn same_socket_supervisor_targets(socket_path: &Path) -> Vec<ReapTarget> {
    let socket = socket_path.to_string_lossy().to_string();
    let mut targets = Vec::new();
    for pid in numeric_proc_entries() {
        if pid == std::process::id() {
            continue;
        }
        let Some(argv) = read_proc_argv(pid) else {
            continue;
        };
        if !supervisor_argv_names_socket(&argv, &socket) {
            continue;
        }
        targets.push(ReapTarget {
            pid,
            start_id: crate::lease::get_process_start_id(pid),
            worker_socket: None,
            kind: ReapKind::Supervisor,
        });
    }
    targets
}

#[cfg(not(target_os = "linux"))]
fn same_socket_supervisor_targets(_socket_path: &Path) -> Vec<ReapTarget> {
    Vec::new()
}

/// Whether a command line is a supervisor of `socket`: either the product
/// form (`--mode daemon --daemon-socket <socket>`) or the pa-daemon binary
/// form (`supervisor --socket <socket>`).
pub(crate) fn supervisor_argv_names_socket(argv: &[String], socket: &str) -> bool {
    let after_flag = |flag: &str| {
        argv.windows(2)
            .find(|pair| pair[0] == flag)
            .map(|pair| pair[1].as_str())
    };
    match after_flag("--daemon-socket") {
        Some(named) => named == socket && argv.iter().any(|arg| arg == "daemon"),
        None => {
            after_flag("--socket") == Some(socket) && argv.iter().any(|arg| arg == "supervisor")
        }
    }
}

/// The numeric /proc entry names (the process census).
#[cfg(target_os = "linux")]
fn numeric_proc_entries() -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_string_lossy().parse::<u32>().ok())
        .collect()
}

/// One process's environment as `KEY=VALUE` entries (None when unreadable -
/// another user's process or a vanished pid is never a target).
#[cfg(target_os = "linux")]
fn read_proc_environ(pid: u32) -> Option<Vec<String>> {
    let bytes = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    Some(
        bytes
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
            .map(|entry| String::from_utf8_lossy(entry).to_string())
            .collect(),
    )
}

/// One process's argv (None when unreadable).
#[cfg(target_os = "linux")]
fn read_proc_argv(pid: u32) -> Option<Vec<String>> {
    let bytes = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(
        bytes
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
            .map(|entry| String::from_utf8_lossy(entry).to_string())
            .collect(),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn target(pid: u32) -> ReapTarget {
        ReapTarget {
            pid,
            start_id: crate::lease::get_process_start_id(pid),
            worker_socket: None,
            kind: ReapKind::Worker,
        }
    }

    /// A reaped process is provably gone after the escalation: the reap's
    /// own child (the same contract the CLI stop test uses) dies inside the
    /// TERM grace and reports Term.
    #[tokio::test]
    async fn a_real_process_stops_inside_the_term_grace() {
        let mut child = std::process::Command::new("sleep")
            .arg("300")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        let outcome = stop_target(&target(pid)).await;
        let _ = child.wait();
        assert_eq!(outcome, ReapOutcome::Term, "sleep must exit on SIGTERM");
    }

    /// A SIGKILL-survivor (a stopped, unkillable task) reports Survived -
    /// the boot log's honest line - and never claims a stop it did not
    /// perform. A `sleep` in its own process group, stopped with SIGSTOP:
    /// SIGTERM/`kill` cannot be delivered while it is stopped... SIGKILL
    /// CAN (it cannot be caught, blocked, or ignored - but a STOPPED task
    /// still answers SIGKILL immediately), so this verifies the dead-signal
    /// path instead: an un-signaled pid (0) reports AlreadyGone.
    #[tokio::test]
    async fn a_vanished_pid_reports_already_gone() {
        let mut child = std::process::Command::new("true")
            .spawn()
            .expect("spawn true");
        let pid = child.id();
        let _ = child.wait();
        assert_eq!(stop_target(&target(pid)).await, ReapOutcome::AlreadyGone);
    }

    /// The identity gate: a recycled pid (a different process now holding
    /// the number) is never signaled - the discovery's start id decides.
    #[tokio::test]
    async fn a_recycled_pid_is_never_signaled() {
        let mut child = std::process::Command::new("sleep")
            .arg("300")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        let mut stale = target(pid);
        stale.start_id = stale.start_id.map(|id| id + "recycled");
        assert_eq!(stop_target(&stale).await, ReapOutcome::AlreadyGone);
        assert!(
            child.try_wait().expect("child alive").is_none(),
            "the recycled identity must not have been signaled"
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    /// The worker argv gate (the env-propagation hazard): only the product's
    /// worker role matches - a kernel, a bash child, or a tool server that
    /// merely INHERITED the worker environment never does.
    #[test]
    fn worker_argv_shapes() {
        let worker = ["/bin/prime-agent", "worker"]
            .iter()
            .map(|arg| arg.to_string())
            .collect::<Vec<_>>();
        let pa_daemon_worker = ["/usr/bin/pa-daemon", "worker", "--flag"]
            .iter()
            .map(|arg| arg.to_string())
            .collect::<Vec<_>>();
        let kernel = [
            "/opt/kernel-venv/bin/python",
            "-m",
            "prime_agent_runtime.kernel",
        ]
        .iter()
        .map(|arg| arg.to_string())
        .collect::<Vec<_>>();
        let bash_child = ["/usr/bin/sleep", "300"]
            .iter()
            .map(|arg| arg.to_string())
            .collect::<Vec<_>>();
        let bare = ["/usr/local/bin/prime-agent"]
            .iter()
            .map(|arg| arg.to_string())
            .collect::<Vec<_>>();
        let worker_flag_second = ["/usr/local/bin/prime-agent", "--mode", "worker"]
            .iter()
            .map(|arg| arg.to_string())
            .collect::<Vec<_>>();
        assert!(is_worker_argv(&worker), "the product worker role");
        assert!(
            is_worker_argv(&pa_daemon_worker),
            "the pa-daemon worker role"
        );
        assert!(!is_worker_argv(&kernel), "a session kernel never matches");
        assert!(
            !is_worker_argv(&bash_child),
            "an inherited-env bash child never matches"
        );
        assert!(
            !is_worker_argv(&bare),
            "a bare product binary never matches"
        );
        assert!(
            !is_worker_argv(&worker_flag_second),
            "a flag never substitutes for the role argument"
        );
    }

    /// The supervisor argv shape: both spawn forms name their socket, and
    /// unrelated daemons (other sockets, plain CLIs) never match.
    #[test]
    fn supervisor_argv_shapes() {
        let product = [
            "/usr/local/bin/prime-agent",
            "--mode",
            "daemon",
            "--daemon-socket",
            "/tmp/sock/daemon.sock",
        ]
        .iter()
        .map(|arg| arg.to_string())
        .collect::<Vec<_>>();
        let direct = [
            "/usr/bin/pa-daemon",
            "supervisor",
            "--socket",
            "/tmp/sock/daemon.sock",
            "--agent-dir",
            "/agent",
        ]
        .iter()
        .map(|arg| arg.to_string())
        .collect::<Vec<_>>();
        let other_socket = [
            "/usr/local/bin/prime-agent",
            "--mode",
            "daemon",
            "--daemon-socket",
            "/tmp/OTHER/daemon.sock",
        ]
        .iter()
        .map(|arg| arg.to_string())
        .collect::<Vec<_>>();
        let interactive = ["/usr/local/bin/prime-agent"]
            .iter()
            .map(|arg| arg.to_string())
            .collect::<Vec<_>>();
        assert!(supervisor_argv_names_socket(
            &product,
            "/tmp/sock/daemon.sock"
        ));
        assert!(supervisor_argv_names_socket(
            &direct,
            "/tmp/sock/daemon.sock"
        ));
        assert!(!supervisor_argv_names_socket(
            &other_socket,
            "/tmp/sock/daemon.sock"
        ));
        assert!(!supervisor_argv_names_socket(
            &interactive,
            "/tmp/sock/daemon.sock"
        ));
    }
}
