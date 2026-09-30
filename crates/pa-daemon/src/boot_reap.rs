//! The daemon-boot predecessor reap (operator-directed product behavior,
//! a sanctioned divergence from TS documented per the #289 precedent).
//! A daemon that boots on a socket owns that socket's lineage: same-socket
//! predecessors die at boot; other sockets are never touched.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::supervisor::Supervisor;

/// Grace after SIGTERM before the force escalation (the CLI stop contract's
/// worker grace).
const TERM_GRACE: Duration = Duration::from_secs(2);
/// Verify window after SIGKILL before the reap reports the survivor.
const KILL_VERIFY: Duration = Duration::from_secs(1);
/// Hard deadline after SIGKILL on the intentional-stop path (TS `STOP_FORCE_TIMEOUT`):
/// a killed worker's teardown may still take before the stop reports the survivor.
const STOP_FORCE_TIMEOUT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(25);

/// One reap target discovered on this socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReapTarget {
    pub(crate) pid: u32,
    /// The process start id at discovery (the identity gate).
    pub(crate) start_id: Option<String>,
    /// The target's own worker socket file, when known: removed with the process.
    pub(crate) worker_socket: Option<PathBuf>,
    pub(crate) kind: ReapKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReapKind {
    /// A leftover session worker of a previous daemon on this socket.
    Worker,
    /// A wedged supervisor process bound to this socket path (linux census only).
    #[cfg(target_os = "linux")]
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
    /// The process outlived SIGKILL (a D-state wedged task): its lease
    /// stays held; the operator-facing refusal keeps naming the holder.
    Survived,
}

/// Reap the same-socket predecessors before a client or adoption races the reap.
pub(crate) async fn reap_predecessors(supervisor: &Arc<Supervisor>) {
    let socket_path = supervisor.options.socket_path.clone();
    // The adoption pass's business, never the reap's: this daemon's own descriptors,
    // protected while the identity still matches (none recorded stays protected).
    let protected: HashSet<u32> =
        protected_worker_pids(&supervisor.options.agent_dir, &socket_path);
    let mut targets = same_socket_worker_targets(&socket_path, &protected, None);
    targets.extend(same_socket_supervisor_targets(&socket_path));
    if targets.is_empty() {
        return;
    }
    supervisor.log_line(&format!(
        "boot reap: {} same-socket predecessor process(es) to clear",
        targets.len()
    ));
    // Concurrent: a stuck target's escalation must not serialize the reap.
    let outcomes = futures::future::join_all(
        targets
            .iter()
            .map(|target| async move {
                let outcome = stop_target(target).await;
                supervisor.log_line(&format!(
                    "boot reap: {} pid {} (start id {:?}) - {:?}",
                    match target.kind {
                        ReapKind::Worker => "leftover worker",
                        #[cfg(target_os = "linux")]
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
    // The dead workers' socket files leave with them (a killed process cannot clean up).
    for (target, outcome) in outcomes {
        if let (Some(socket), ReapOutcome::Term | ReapOutcome::Kill) =
            (&target.worker_socket, outcome)
        {
            if is_unix_socket_file(socket) {
                let _ = std::fs::remove_file(socket);
            }
        }
    }
}

/// Stop one worker process by identity: the terminal-stop escalation (a worker that missed
/// its routed `shutdown`) on the `STOP_FORCE_TIMEOUT` budget, not the boot reap's fast
/// verify. `None` as the start id trusts liveness alone.
pub(crate) async fn stop_process(pid: u32, start_id: Option<String>) -> ReapOutcome {
    stop_target_within(
        &ReapTarget {
            pid,
            start_id,
            worker_socket: None,
            kind: ReapKind::Worker,
        },
        TERM_GRACE,
        STOP_FORCE_TIMEOUT,
    )
    .await
}

/// The give-up belt: when the supervisor abandons a worker id, no live process of THIS daemon
/// may outlive it under that id (the zombie-holder incident). Never touched: other daemons'
/// workers and any pid a live resident still owns.
pub(crate) async fn reap_abandoned_workers(supervisor: &Arc<Supervisor>, worker_id: &str) {
    let socket_path = supervisor.options.socket_path.clone();
    // Belt over the env filter: a pid a LIVE resident still owns is never
    // signaled, whatever its environment says.
    let mut protected = HashSet::new();
    for resident in supervisor.registry.list().await {
        let pid = resident.descriptor.lock().await.pid as u32;
        if pid != 0 {
            protected.insert(pid);
        }
    }
    let targets = same_socket_worker_targets(&socket_path, &protected, Some(worker_id));
    if targets.is_empty() {
        return;
    }
    supervisor.log_line(&format!(
        "give-up sweep: {} leftover process(es) of session worker {worker_id}",
        targets.len()
    ));
    let outcomes = futures::future::join_all(
        targets
            .iter()
            .map(|target| async move {
                let outcome = stop_target(target).await;
                supervisor.log_line(&format!(
                    "give-up sweep: leftover worker pid {} (start id {:?}) of {worker_id} - {:?}",
                    target.pid, target.start_id, outcome
                ));
                (target.clone(), outcome)
            })
            .collect::<Vec<_>>(),
    )
    .await;
    // The reaped leftovers' endpoint files leave with them (the same gate as the boot reap).
    for (target, outcome) in outcomes {
        if let (Some(socket), ReapOutcome::Term | ReapOutcome::Kill) =
            (&target.worker_socket, outcome)
        {
            if is_unix_socket_file(socket) {
                let _ = std::fs::remove_file(socket);
            }
        }
    }
}

/// Whether the pid still names the discovered process (the identity gate: a
/// recycled pid is never signaled). An UNVERIFIABLE identity never signals -
/// safe for lease retention, not for termination.
fn identity_current(target: &ReapTarget) -> bool {
    match &target.start_id {
        Some(expected) => {
            crate::lease::get_process_start_id(target.pid).as_deref() == Some(expected.as_str())
        }
        None => false,
    }
}

/// Stop one target on the boot reap's fast budgets.
async fn stop_target(target: &ReapTarget) -> ReapOutcome {
    stop_target_within(target, TERM_GRACE, KILL_VERIFY).await
}

/// Stop one target with explicit escalation budgets: gone check, SIGTERM,
/// grace, SIGKILL, verify. The signals ride the kernel-held pidfd: a pid
/// recycled in the check-then-signal window never receives the signal.
async fn stop_target_within(
    target: &ReapTarget,
    term_grace: Duration,
    kill_verify: Duration,
) -> ReapOutcome {
    // The handle opens BEFORE the identity check and the check runs WHILE
    // it is held: a target that dies and has its pid recycled in between
    // would otherwise leave the handle pinning the REPLACEMENT - open
    // first, then verify the pid still names our process, and only then
    // does any signal ride the held fd (a signal through this fd can
    // reach the pinned process and nothing else, ever).
    let Ok(pidfd) = pa_core::platform::process::open_pidfd(target.pid) else {
        // The kernel-held handle is unavailable (an unsupported platform,
        // an old kernel, or a process that just exited): the conservative
        // default never signals - a missed reap is recoverable, a wrong
        // one is not. A LIVE process behind an unobtainable handle is NOT
        // gone: the terminal stop keeps its tombstoned descriptor (the
        // next boot retries), never deletes it behind a false AlreadyGone.
        if identity_current(target) && crate::lease::is_process_alive(target.pid).unwrap_or(false) {
            return ReapOutcome::Survived;
        }
        return ReapOutcome::AlreadyGone;
    };
    if !identity_current(target) || !crate::lease::is_process_alive(target.pid).unwrap_or(false) {
        pa_core::platform::process::close_pidfd(pidfd);
        return ReapOutcome::AlreadyGone;
    }
    if pa_core::platform::process::pidfd_signal(pidfd, pa_core::platform::process::Signal::Term) {
        if await_gone(target, term_grace).await {
            pa_core::platform::process::close_pidfd(pidfd);
            return ReapOutcome::Term;
        }
        if pa_core::platform::process::pidfd_signal(pidfd, pa_core::platform::process::Signal::Kill)
            && await_gone(target, kill_verify).await
        {
            pa_core::platform::process::close_pidfd(pidfd);
            return ReapOutcome::Kill;
        }
    }
    pa_core::platform::process::close_pidfd(pidfd);
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

/// The same-socket leftover workers, identified by the WORKER PROCESS SHAPE,
/// never by the environment alone: an env-only match would kill a session's
/// whole process tree (the `readoption_wake` regression). Linux-only (/proc).
#[cfg(target_os = "linux")]
fn same_socket_worker_targets(
    socket_path: &Path,
    protected: &HashSet<u32>,
    active_session: Option<&str>,
) -> Vec<ReapTarget> {
    let socket = normalize_socket_spelling(socket_path);
    let mut targets = Vec::new();
    for pid in numeric_proc_entries() {
        if pid == std::process::id() || protected.contains(&pid) {
            continue;
        }
        // The identity captures BEFORE every /proc read and re-verifies AFTER the
        // qualification: a recycled pid must never leave a target under the REPLACEMENT'S identity.
        let start_id = crate::lease::get_process_start_id(pid);
        // The abandoned-id filter: workers whose env names the given-up id; `None` = whole census.
        if let Some(active_session) = active_session {
            if !proc_environ_names_active_session(pid, active_session) {
                continue;
            }
        }
        let Some(argv) = read_proc_argv(pid) else {
            continue;
        };
        if !is_worker_argv(&argv) {
            continue;
        }
        // The executable check rides the UNFORGEABLE identity: argv[0] can be forged
        // (`exec -a`); /proc/<pid>/exe names the binary the kernel actually loaded.
        if !exe_is_product_binary(pid) {
            continue;
        }
        let Some(environ) = read_proc_environ(pid) else {
            continue;
        };
        if !environ.iter().any(|entry| {
            entry
                .strip_prefix(&format!("{}=", crate::worker::WORKER_SUPERVISOR_SOCKET_ENV))
                .is_some_and(|value| socket_spelling_of(pid, value) == socket)
        }) {
            continue;
        }
        // The post-qualification identity re-check: the pid must still name the qualified process.
        if crate::lease::get_process_start_id(pid).as_deref() != start_id.as_deref() {
            continue;
        }
        // The KILL decision rests on the worker role and the same-socket identity alone - a
        // leftover without its endpoint file still holds its lease.
        let worker_socket = environ
            .iter()
            .find_map(|entry| entry.strip_prefix(&format!("{}=", crate::worker::WORKER_SOCKET_ENV)))
            .filter(|path| is_our_worker_socket(path, socket_path))
            .map(PathBuf::from);
        targets.push(ReapTarget {
            pid,
            start_id,
            worker_socket,
            kind: ReapKind::Worker,
        });
    }
    targets
}

/// One socket value's identity AS THE TARGET PROCESS SEES IT: a relative
/// spelling resolves against the PROCESS's working directory - the same
/// relative argument from different directories names DIFFERENT sockets.
#[cfg(target_os = "linux")]
fn socket_spelling_of(pid: u32, value: &str) -> String {
    let path = Path::new(value);
    if path.is_absolute() {
        return normalize_socket_spelling(path);
    }
    match std::fs::read_link(format!("/proc/{pid}/cwd")) {
        Ok(cwd) => normalize_socket_spelling(&cwd.join(path)),
        Err(_) => String::new(),
    }
}

/// The product's own binary names: `prime-agent` (release/install) and
/// `pa-daemon` (the workspace binary). Unix only, as [`is_worker_argv`].
#[cfg(unix)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn is_product_binary(exe: &str) -> bool {
    matches!(
        Path::new(exe).file_name().and_then(|name| name.to_str()),
        Some("prime-agent" | "pa-daemon")
    )
}

/// Whether a command line is the product's worker role: a product binary
/// with `worker` as its first argument. Unix only.
#[cfg(unix)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn is_worker_argv(argv: &[String]) -> bool {
    argv.first().is_some_and(|exe| is_product_binary(exe))
        && argv.get(1).map(String::as_str) == Some("worker")
}

/// Whether a path is one of THIS supervisor's worker endpoints: under the shared socket
/// dir, named with this socket's own key - a foreign value never matches.
#[cfg(target_os = "linux")]
pub(crate) fn is_our_worker_socket(path: &str, supervisor_socket: &Path) -> bool {
    let Some(name) = Path::new(path).file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let key = crate::paths::hash_key(&supervisor_socket.to_string_lossy(), 12);
    normalize_socket_spelling(Path::new(path).parent().unwrap_or(Path::new(path)))
        == normalize_socket_spelling(&crate::platform::socket_dir())
        && name.starts_with(&format!("worker-{key}-"))
        && Path::new(name).extension().is_some_and(|ext| ext == "sock")
}

#[cfg(not(target_os = "linux"))]
fn same_socket_worker_targets(
    _socket_path: &Path,
    _protected: &HashSet<u32>,
    _active_session: Option<&str>,
) -> Vec<ReapTarget> {
    Vec::new()
}

/// Whether one process's environment names `active_session` (unreadable never matches).
#[cfg(target_os = "linux")]
fn proc_environ_names_active_session(pid: u32, active_session: &str) -> bool {
    read_proc_environ(pid).is_some_and(|environ| {
        environ.iter().any(|entry| {
            entry
                .strip_prefix(&format!("{}=", crate::worker::WORKER_ACTIVE_SESSION_ID_ENV))
                .is_some_and(|value| value == active_session)
        })
    })
}

/// The non-linux unix stub: the only caller is the linux worker census,
/// so it stays compiled for the signature's parity and is inert
/// everywhere else (`allow(dead_code)` is the honest parity mark — the
/// linux side owns the real read).
#[cfg(all(unix, not(target_os = "linux")))]
#[allow(dead_code)]
fn proc_environ_names_active_session(_pid: u32, _active_session: &str) -> bool {
    false
}

/// The wedged supervisors of this socket path, excluding this process. A healthy
/// predecessor never reaches here: its listener refused this daemon's bind.
#[cfg(target_os = "linux")]
fn same_socket_supervisor_targets(socket_path: &Path) -> Vec<ReapTarget> {
    let socket = normalize_socket_spelling(socket_path);
    let mut targets = Vec::new();
    for pid in numeric_proc_entries() {
        if pid == std::process::id() {
            continue;
        }
        // Identity-first capture, as the worker census.
        let start_id = crate::lease::get_process_start_id(pid);
        let Some(mut argv) = read_proc_argv(pid) else {
            continue;
        };
        resolve_relative_socket_tokens(pid, &mut argv);
        if !supervisor_argv_names_socket(&argv, &socket) {
            continue;
        }
        // Same unforgeable-exe gate as the worker census.
        if !exe_is_product_binary(pid) {
            continue;
        }
        // The post-qualification identity re-check.
        if crate::lease::get_process_start_id(pid).as_deref() != start_id.as_deref() {
            continue;
        }
        targets.push(ReapTarget {
            pid,
            start_id,
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

/// Resolve RELATIVE socket-flag tokens against the target process's own working directory.
#[cfg(target_os = "linux")]
fn resolve_relative_socket_tokens(pid: u32, argv: &mut [String]) {
    let Ok(cwd) = std::fs::read_link(format!("/proc/{pid}/cwd")) else {
        return;
    };
    for flag in ["--daemon-socket", "--socket"] {
        for index in 0..argv.len().saturating_sub(1) {
            if argv[index] == flag && !Path::new(&argv[index + 1]).is_absolute() {
                argv[index + 1] = cwd.join(&argv[index + 1]).to_string_lossy().to_string();
            }
        }
    }
}

/// Whether a command line is a supervisor of `socket`: a product binary running either
/// the product form (`--mode daemon --daemon-socket <socket>`) or `supervisor --socket <socket>`.
/// The executable gate is load-bearing. Unix only.
#[cfg(unix)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn supervisor_argv_names_socket(argv: &[String], socket: &str) -> bool {
    let Some(exe) = argv.first() else {
        return false;
    };
    if !is_product_binary(exe) {
        return false;
    }
    let after_flag = |flag: &str| {
        argv.windows(2)
            .find(|pair| pair[0] == flag)
            .map(|pair| pair[1].as_str())
    };
    // Both spellings normalize: an argv token may carry the symlink or `..` spelling of
    // the same socket; a RELATIVE token stays unmatched here.
    let names_socket = |named: &str| {
        if Path::new(named).is_absolute() {
            normalize_socket_spelling(Path::new(named)) == socket
        } else {
            false
        }
    };
    match after_flag("--daemon-socket") {
        Some(named) => names_socket(named) && argv.iter().any(|arg| arg == "daemon"),
        None => {
            after_flag("--socket").is_some_and(names_socket)
                && argv.iter().any(|arg| arg == "supervisor")
        }
    }
}

/// Whether the path is a unix socket file (the reap's endpoint unlink
/// removes endpoints only - a regular file at a matching name is never
/// touched). UNIX-wide on purpose (the caller is unconditional): the
/// std `os::unix` socket-file probe compiles on every unix - darwin
/// included. No unix socket files exist on the other targets, so the
/// probe answers false there and the unlink never fires (the not(unix)
/// reaping stubs already collect zero targets).
#[cfg(unix)]
fn is_unix_socket_file(path: &Path) -> bool {
    use std::os::unix::fs::FileTypeExt;
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_socket())
}

/// Windows endpoints are named pipes, not files: the endpoint-unlink gate never fires.
#[cfg(not(unix))]
fn is_unix_socket_file(_path: &Path) -> bool {
    false
}

/// The pids the reap must never touch: the live-worker descriptors this
/// SOCKET identity owns. The descriptor directories are keyed by the RAW
/// spelling each daemon started with, so every spelling directory is read.
#[cfg(target_os = "linux")]
fn protected_worker_pids(agent_dir: &Path, socket_path: &Path) -> HashSet<u32> {
    let ours = normalize_socket_spelling(socket_path);
    let mut protected = HashSet::new();
    let Ok(spellings) = std::fs::read_dir(agent_dir.join("daemon-workers")) else {
        return protected;
    };
    for spelling in spellings.flatten() {
        let dir = spelling.path();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(descriptor) =
                serde_json::from_str::<crate::descriptor::WorkerDescriptor>(&content)
            else {
                continue;
            };
            if descriptor.version != 2 || descriptor.pid == 0 {
                continue;
            }
            // A RELATIVE spelling resolves against the WORKER's own cwd
            // (/proc/<pid>/cwd), exactly as discovery resolves the inherited env value.
            let spelling =
                match socket_spelling_of(descriptor.pid as u32, &descriptor.supervisor_socket_path)
                {
                    spelling if spelling.is_empty() => continue,
                    spelling => spelling,
                };
            if spelling != ours {
                continue;
            }
            // A tombstoned descriptor is DURABLE STOP INTENT: its worker
            // is something to finish stopping, never to adopt.
            if descriptor.stop_requested_at.is_some() {
                continue;
            }
            let identity_holds = match &descriptor.process_start_id {
                Some(expected) => crate::lease::get_process_start_id(descriptor.pid as u32)
                    .is_none_or(|observed| observed == expected.as_str()),
                None => true,
            };
            if identity_holds {
                protected.insert(descriptor.pid as u32);
            }
        }
    }
    protected
}

#[cfg(not(target_os = "linux"))]
fn protected_worker_pids(agent_dir: &Path, socket_path: &Path) -> HashSet<u32> {
    let _ = (agent_dir, socket_path);
    HashSet::new()
}

/// One socket path's NORMALIZED spelling: the canonicalized form when the
/// path exists (symlinks, `..`, and duplicate separators collapse), else
/// the lexically normalized path. The reap compares spellings this way on
/// BOTH sides (the socket it was spawned with and the env value the
/// leftover carries), so a leftover whose inherited spelling differs
/// (`/a/b/../c/daemon.sock` vs `/a/c/daemon.sock`, a symlinked tmpdir)
/// is still a same-socket predecessor - its lease is held either way.
/// Pure `std` (canonicalize + components): it compiles on every unix -
/// darwin included, which `supervisor_argv_names_socket` (the argv-only
/// view the supervisor census normalizes with) requires.
#[cfg(unix)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn normalize_socket_spelling(path: &Path) -> String {
    if let Ok(canonical) = path.canonicalize() {
        return canonical.to_string_lossy().to_string();
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized.to_string_lossy().to_string()
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

/// The UNFORGEABLE executable check for one pid: /proc/<pid>/exe names the
/// binary the kernel loaded (argv[0] is forgeable via `exec -a`).
#[cfg(target_os = "linux")]
fn exe_is_product_binary(pid: u32) -> bool {
    std::fs::read_link(format!("/proc/{pid}/exe"))
        // The kernel appends " (deleted)" to a replaced binary's exe link (in-place upgrade).
        .is_ok_and(|exe| {
            let name = exe.to_string_lossy();
            let name = name.trim_end_matches(" (deleted)");
            is_product_binary(name)
        })
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

    /// Kills and reaps the child on any exit path (a failed assertion in
    /// between would otherwise leak the `sleep` into the test machine: the
    /// std child kills nothing on drop). Linux only: the guard exists for
    /// the /proc census tests, which never compile elsewhere.
    #[cfg(target_os = "linux")]
    struct ReapOnDrop(Option<std::process::Child>);

    #[cfg(target_os = "linux")]
    impl Drop for ReapOnDrop {
        fn drop(&mut self) {
            if let Some(mut child) = self.0.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_abandoned_id_filter_matches_the_stamped_env_only() {
        let unstamped_guard = ReapOnDrop(
            std::process::Command::new("sleep")
                .arg("300")
                .env_remove(crate::worker::WORKER_ACTIVE_SESSION_ID_ENV)
                .spawn()
                .expect("spawn unstamped sleep")
                .into(),
        );
        assert!(
            !proc_environ_names_active_session(
                unstamped_guard
                    .0
                    .as_ref()
                    .expect("guard holds the child")
                    .id(),
                "6b558be357e3"
            ),
            "an unstamped environment never matches the abandoned id"
        );
        let stamped_guard = ReapOnDrop(
            std::process::Command::new("sleep")
                .arg("300")
                .env(crate::worker::WORKER_ACTIVE_SESSION_ID_ENV, "6b558be357e3")
                .spawn()
                .expect("spawn stamped sleep")
                .into(),
        );
        let stamped = stamped_guard
            .0
            .as_ref()
            .expect("guard holds the child")
            .id();
        // The stamp is readable only once execve completes: between fork and exec the
        // environment area still holds the parent's, so the read retries a bounded budget.
        let stamped_matches = {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                if proc_environ_names_active_session(stamped, "6b558be357e3") {
                    break true;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "the stamped environment never matched its abandoned id"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        assert!(
            stamped_matches,
            "the stamped environment matches its abandoned id"
        );
        assert!(
            !proc_environ_names_active_session(stamped, "other-id"),
            "a different abandoned id never matches"
        );
        assert!(
            !proc_environ_names_active_session(0, "6b558be357e3"),
            "an unreadable pid is the conservative no-match"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_real_process_stops_inside_the_term_grace() {
        let mut child = std::process::Command::new("sleep")
            .arg("300")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        assert!(
            pa_core::platform::process::open_pidfd(pid).is_ok(),
            "the kernel-held handle opens"
        );
        let outcome = stop_target(&target(pid)).await;
        let _ = child.wait();
        assert_eq!(outcome, ReapOutcome::Term, "sleep must exit on SIGTERM");
    }

    /// The `bash` ignores SIGTERM without spawning a child (a leaked grandchild would outlive
    /// the guard's kill); its marker file is the readiness barrier.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_term_ignoring_process_dies_to_the_stop_escalation() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let trap_armed = dir.path().join("trap-armed");
        let child = std::process::Command::new("bash")
            .arg("-c")
            .arg("trap '' TERM; : > \"$1\"; while :; do :; done")
            .arg("bash")
            .arg(&trap_armed)
            .spawn()
            .expect("spawn term-ignoring bash");
        let guard = ReapOnDrop(Some(child));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !trap_armed.exists() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(trap_armed.exists(), "the trap never armed");
        let pid = guard.0.as_ref().expect("guard holds the child").id();
        let outcome = stop_process(pid, crate::lease::get_process_start_id(pid)).await;
        drop(guard);
        assert_eq!(
            outcome,
            ReapOutcome::Kill,
            "the stop escalation must SIGKILL a term-ignoring worker"
        );
    }

    #[tokio::test]
    async fn a_vanished_pid_reports_already_gone() {
        let mut child = std::process::Command::new("true")
            .spawn()
            .expect("spawn true");
        let pid = child.id();
        let _ = child.wait();
        assert_eq!(stop_target(&target(pid)).await, ReapOutcome::AlreadyGone);
    }

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
        let mut unobservable = target(pid);
        unobservable.start_id = None;
        assert_eq!(
            stop_target(&unobservable).await,
            ReapOutcome::AlreadyGone,
            "an unverifiable identity is never signaled"
        );
        assert!(
            child.try_wait().expect("child alive").is_none(),
            "the unverifiable identity must not have been signaled"
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn worker_argv_shapes() {
        let worker = ["/bin/prime-agent", "worker"]
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let pa_daemon_worker = ["/usr/bin/pa-daemon", "worker", "--flag"]
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let kernel = [
            "/opt/kernel-venv/bin/python",
            "-m",
            "prime_agent_runtime.kernel",
        ]
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
        let bash_child = ["/usr/bin/sleep", "300"]
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let bare = ["/usr/local/bin/prime-agent"]
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let worker_flag_second = ["/usr/local/bin/prime-agent", "--mode", "worker"]
            .iter()
            .map(ToString::to_string)
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
        let foreign_worker_arg = ["/usr/bin/python", "worker"]
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        assert!(
            !is_worker_argv(&foreign_worker_arg),
            "a foreign binary with a worker argument never matches"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_exe_gate_reads_the_kernel_binary() {
        let mut child = std::process::Command::new("sleep")
            .arg("2")
            .spawn()
            .expect("spawn sleep");
        assert!(
            !exe_is_product_binary(child.id()),
            "a foreign executable never passes the unforgeable gate"
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn the_exe_gate_accepts_replaced_binaries() {
        let replaced = "/opt/prime-agent/bin/prime-agent (deleted)";
        assert!(
            is_product_binary(replaced.trim_end_matches(" (deleted)")),
            "the deleted-suffix spelling still identifies the product binary"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_supervisor_match_normalizes_both_spellings() {
        let direct = [
            "/usr/bin/prime-agent",
            "--mode",
            "daemon",
            "--daemon-socket",
            "/tmp/x/daemon.sock",
        ]
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
        assert!(supervisor_argv_names_socket(
            &direct,
            &normalize_socket_spelling(Path::new("/tmp/x/daemon.sock"))
        ));
        let dotted = [
            "/usr/bin/prime-agent",
            "--mode",
            "daemon",
            "--daemon-socket",
            "/tmp/x/y/../daemon.sock",
        ]
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
        assert!(
            supervisor_argv_names_socket(
                &dotted,
                &normalize_socket_spelling(Path::new("/tmp/x/daemon.sock"))
            ),
            "the .. spelling of the same socket still matches"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn our_worker_socket_names_only() {
        let supervisor = Path::new("/tmp/prime-agent-1000/daemon.sock");
        let key = crate::paths::hash_key(&supervisor.to_string_lossy(), 12);
        let dir = crate::platform::socket_dir().to_string_lossy().to_string();
        let ours = format!("{dir}/worker-{key}-abcdef123456.sock");
        assert!(
            is_our_worker_socket(&ours, supervisor),
            "the deterministic name matches"
        );
        assert!(
            !is_our_worker_socket(&format!("{dir}/worker-OTHERKEY00-abcdef.sock"), supervisor),
            "another socket's key never matches"
        );
        assert!(
            !is_our_worker_socket("/etc/passwd", supervisor),
            "an arbitrary path never matches"
        );
        assert!(
            !is_our_worker_socket(
                &format!("/tmp/elsewhere/worker-{key}-abcdef123456.sock"),
                supervisor
            ),
            "a matching name outside the socket dir never matches"
        );
    }

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
        .map(ToString::to_string)
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
        .map(ToString::to_string)
        .collect::<Vec<_>>();
        let other_socket = [
            "/usr/local/bin/prime-agent",
            "--mode",
            "daemon",
            "--daemon-socket",
            "/tmp/OTHER/daemon.sock",
        ]
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
        let interactive = ["/usr/local/bin/prime-agent"]
            .iter()
            .map(ToString::to_string)
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
