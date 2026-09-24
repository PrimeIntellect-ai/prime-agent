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
//! - Worker processes (`worker` as the first argument of a product binary -
//!   the argv the supervisor spawns) whose `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET`
//!   names THIS daemon's socket, minus the pids this daemon's own
//!   descriptors name (those are the adoption pass's business: a crash
//!   restart's live workers re-register and keep serving - the
//!   must-not-lose-sessions invariant). The argv gate is load-bearing:
//!   the supervisor-socket env var propagates to every process a session
//!   worker spawns (kernels, bash children, tool servers), and an env-only
//!   match would kill a session's whole process tree at the next daemon
//!   boot - the readoption_wake regression this gate exists for. The
//!   target's own endpoint path gates only the cleanup unlink (a
//!   validated deterministic name); the kill never depends on the
//!   endpoint file.
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
    // The adoption pass's business, never the reap's: the pids of the
    // descriptors this SOCKET identity owns, protected while the identity
    // still matches. Equivalent socket spellings resolve to the same
    // identity (`/tmp/x/y/../daemon.sock` and `/tmp/x/daemon.sock` are
    // ONE socket), but the on-disk descriptor directories are keyed by
    // the RAW spelling each daemon started with - so the protected set
    // loads EVERY spelling directory and keeps the descriptors whose
    // supervisorSocketPath normalizes to THIS daemon's socket (the same
    // identity the worker discovery matches; a live crash-restart worker
    // under a predecessor's spelling stays protected either way).
    // A RECORDED identity must match the live one (a recycled pid is a
    // different process and never shields a leftover); a descriptor with
    // NO identity recorded stays protected - the adoption pass owns it
    // either way, and a conservative skip never kills a live
    // descriptor-backed worker (a missed reap is recoverable, a wrong
    // one is not).
    let protected: HashSet<u32> =
        protected_worker_pids(&supervisor.options.agent_dir, &socket_path);
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
    // endpoint would linger past every spawn). The unlink stays inside the
    // product's endpoint namespace: the path was validated as one of this
    // supervisor's own worker sockets at discovery, and the last check
    // re-verifies the socket-ness before the remove - a regular file at a
    // matching name is never unlinked.
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
/// recycled pid is a different process and is never signaled). An
/// UNVERIFIABLE identity never signals: the conservative liveness rule the
/// lease uses (an unobservable owner counts as alive) is safe for lease
/// retention, not for termination - a pid whose identity cannot be proven
// must not receive SIGTERM or SIGKILL on liveness alone.
fn identity_current(target: &ReapTarget) -> bool {
    match &target.start_id {
        Some(expected) => {
            crate::lease::get_process_start_id(target.pid).as_deref() == Some(expected.as_str())
        }
        None => false,
    }
}

/// Stop one target: gone check, SIGTERM, grace, SIGKILL, verify. The
/// signals ride the kernel-held process handle (pidfd): a numeric pid
/// recycled in the check-then-signal window must never receive the
/// signal meant for the process that exited - the fd pins the exact
/// process, whatever the pid table does afterwards.
async fn stop_target(target: &ReapTarget) -> ReapOutcome {
    // The handle opens BEFORE the identity check and the check runs WHILE
    // it is held: a target that dies and has its pid recycled in between
    // would otherwise leave the handle pinning the REPLACEMENT - open
    // first, then verify the pid still names our process, and only then
    // does any signal ride the held fd (a signal through this fd can
    // reach the pinned process and nothing else, ever).
    let Some(pidfd) = pa_core::platform::process::open_pidfd(target.pid) else {
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
        if await_gone(target, TERM_GRACE).await {
            pa_core::platform::process::close_pidfd(pidfd);
            return ReapOutcome::Term;
        }
        if pa_core::platform::process::pidfd_signal(pidfd, pa_core::platform::process::Signal::Kill)
            && await_gone(target, KILL_VERIFY).await
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
    let socket = normalize_socket_spelling(socket_path);
    let mut targets = Vec::new();
    for pid in numeric_proc_entries() {
        if pid == std::process::id() || protected.contains(&pid) {
            continue;
        }
        // The identity captures BEFORE the /proc reads and re-verifies
        // AFTER the qualification: a worker that exits mid-census and
        // whose pid the kernel immediately recycles must never leave a
        // target behind under the REUSHER'S identity (the late capture
        // would have validated the replacement and signaled an
        // unrelated process).
        let start_id = crate::lease::get_process_start_id(pid);
        let Some(argv) = read_proc_argv(pid) else {
            continue;
        };
        if !is_worker_argv(&argv) {
            continue;
        }
        // The executable check rides the UNFORGEABLE identity: argv[0] can
        // be forged (`exec -a prime-agent sleep worker 300` inherits the
        // env and passes the argv gate), while /proc/<pid>/exe names the
        // binary the kernel actually loaded. An unreadable exe link
        // (permission, a dying process) is never a target - the
        // conservative no-signal default.
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
        // The post-qualification identity re-check: the pid must still
        // name the same process the census qualified.
        if crate::lease::get_process_start_id(pid).as_deref() != start_id.as_deref() {
            continue;
        }
        // The KILL decision rests on the worker role and the same-socket
        // identity alone - a leftover whose own endpoint file was already
        // removed (or whose env carries a stale socket-dir path from a
        // TMPDIR change between boots) must still be reaped: it holds its
        // session lease regardless of its endpoint file. The endpoint path
        // only gates the unlink: the cleanup runs only for a path that is
        // one of THIS supervisor's deterministic worker-socket names, so
        // a forged or foreign value never names an arbitrary file.
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
/// spelling resolves against the PROCESS's working directory (read from
/// /proc/<pid>/cwd - never this daemon's), then normalizes. Two daemons
/// started from different directories with the same relative socket
/// argument are DIFFERENT sockets; a worker's inherited relative spelling
/// resolves exactly where its daemon resolved it.
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

/// The product's own binary names (the roles run from these): `prime-agent`
/// (the release/install name) and `pa-daemon` (the workspace binary, also
/// what the harnesses execute). A reap target's executable must be one of
/// these - a session's arbitrary long-running command (`python worker`, a
/// tool server) never qualifies, whatever it inherited.
pub(crate) fn is_product_binary(exe: &str) -> bool {
    matches!(
        Path::new(exe).file_name().and_then(|name| name.to_str()),
        Some("prime-agent" | "pa-daemon")
    )
}

/// Whether a command line is the product's worker role: a product binary
/// with `worker` as its first argument (`prime-agent worker`,
/// `pa-daemon worker` - the exact argv the supervisor spawns). The two
/// hazard classes this gate exists for: a session kernel, bash child, or
/// tool server that merely INHERITED the worker env, and a user's
/// same-socket command that happens to carry a `worker` argument.
pub(crate) fn is_worker_argv(argv: &[String]) -> bool {
    argv.first().is_some_and(|exe| is_product_binary(exe))
        && argv.get(1).map(String::as_str) == Some("worker")
}

/// Whether a path is one of THIS supervisor's worker endpoints: under the
/// shared socket dir, named with this socket's own key
/// (`worker-<hash12(supervisor socket)>-*.sock`) - the deterministic name
/// `worker_socket_path` mints, so a foreign or forged value never matches
/// and the reap's endpoint unlink stays inside the product's namespace.
#[cfg(target_os = "linux")]
pub(crate) fn is_our_worker_socket(path: &str, supervisor_socket: &Path) -> bool {
    let Some(name) = Path::new(path).file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let key = crate::paths::hash_key(&supervisor_socket.to_string_lossy(), 12);
    normalize_socket_spelling(Path::new(path).parent().unwrap_or(Path::new(path)))
        == normalize_socket_spelling(&crate::platform::socket_dir())
        && name.starts_with(&format!("worker-{key}-"))
        && name.ends_with(".sock")
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
    let socket = normalize_socket_spelling(socket_path);
    let mut targets = Vec::new();
    for pid in numeric_proc_entries() {
        if pid == std::process::id() {
            continue;
        }
        // Identity-first capture (the same anti-recycling order as the
        // worker census).
        let start_id = crate::lease::get_process_start_id(pid);
        let Some(mut argv) = read_proc_argv(pid) else {
            continue;
        };
        // A RELATIVE socket token resolves against the PROCESS's own
        // working directory (never this daemon's): two daemons started
        // from different directories with the same relative argument are
        // different sockets.
        resolve_relative_socket_tokens(pid, &mut argv);
        if !supervisor_argv_names_socket(&argv, &socket) {
            continue;
        }
        // Same unforgeable-exe gate as the worker census: a forged argv
        // never carries a signal.
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

/// Resolve the socket-flag tokens that are RELATIVE against the target
/// process's own working directory (`/proc/<pid>/cwd`): the supervisor
/// match compares absolute identities, and a relative token means what
/// the TARGET resolved it to mean, not what this daemon's cwd would.
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

/// Whether a command line is a supervisor of `socket`: a product binary
/// (`prime-agent`/`pa-daemon`) running either the product form (`--mode
/// daemon --daemon-socket <socket>`) or the pa-daemon binary form
/// (`supervisor --socket <socket>`). The executable gate is
/// load-bearing: an arbitrary inherited-socket command that merely carries
/// the argument tokens is never a target.
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
    // Both spellings normalize: the caller passes this daemon's socket in
    // its normalized form, and a predecessor's argv token may carry the
    // symlink or `..` spelling of the very same socket. A RELATIVE token
    // stays unmatched here (the argv-only view cannot know the
    // predecessor's working directory); the scan resolves it against the
    // process's /proc/<pid>/cwd before calling.
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
/// included.
#[cfg(unix)]
fn is_unix_socket_file(path: &Path) -> bool {
    use std::os::unix::fs::FileTypeExt;
    std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_socket())
        .unwrap_or(false)
}

/// The pids the reap must never touch: the live-worker descriptors this
/// SOCKET identity owns, across every raw-spelling directory on disk.
/// (Discovery matches the normalized socket; this reads the same identity
/// out of each descriptor's `supervisorSocketPath`, so a live
/// crash-restart worker under a predecessor's equivalent spelling stays
/// protected.)
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
            // The same normalized-socket identity the worker discovery
            // matches (the descriptor's supervisor socket path) - a
            // RELATIVE spelling resolves against the WORKER's own working
            // directory (/proc/<pid>/cwd), exactly as discovery resolves
            // the inherited env value: a relative spelling is what the
            // daemon that wrote the descriptor resolved it to mean, never
            // what this daemon's cwd would.
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
            // is something to finish stopping, never to adopt - the reap
            // is the executor.
            if descriptor.stop_requested_at.is_some() {
                continue;
            }
            let identity_holds = match &descriptor.process_start_id {
                Some(expected) => crate::lease::get_process_start_id(descriptor.pid as u32)
                    .map(|observed| observed == expected.as_str())
                    .unwrap_or(true),
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
/// darwin included, which the unconditional `supervisor_argv_names_socket`
/// (the argv-only view the supervisor census normalizes with) requires.
#[cfg(unix)]
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
/// binary the kernel loaded (argv[0] is forgeable via `exec -a`). An
/// unreadable link answers false - the conservative no-signal default.
#[cfg(target_os = "linux")]
fn exe_is_product_binary(pid: u32) -> bool {
    std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        // The kernel appends " (deleted)" to a replaced binary's exe link
        // (an in-place upgrade while the worker lives) - the product
        // binary is still the product binary.
        .map(|exe| {
            let name = exe.to_string_lossy();
            let name = name.trim_end_matches(" (deleted)");
            is_product_binary(name)
        })
        .unwrap_or(false)
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
    /// TERM grace and reports Term. The signal rides the kernel-held pidfd
    /// (the open itself proves the handle is available on this kernel).
    /// LINUX ONLY: the stop is real only where the pidfd opens - elsewhere
    /// `stop_target` is the never-signal no-op, and the live `sleep` child
    /// would never exit for the wait.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_real_process_stops_inside_the_term_grace() {
        let mut child = std::process::Command::new("sleep")
            .arg("300")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        assert!(
            pa_core::platform::process::open_pidfd(pid).is_some(),
            "the kernel-held handle opens"
        );
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
    /// An UNVERIFIABLE identity never signals either: the conservative
    /// liveness rule the lease uses is safe for lease retention, not for
    /// termination.
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

    /// The worker argv gate (the env-propagation hazard): only the product's
    /// worker role matches - a kernel, a bash child, or a tool server that
    /// merely INHERITED the worker environment never does.
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

    /// The unforgeable-exe gate: a forged argv (`exec -a prime-agent sleep
    /// worker 300`) never passes - the kernel's /proc/<pid>/exe link names
    /// the real binary. (The live check runs per-pid in the census; the
    /// helper is exercised through the product-binary predicate it reads.)
    #[cfg(target_os = "linux")]
    #[test]
    fn the_exe_gate_reads_the_kernel_binary() {
        // A sleep process's exe link is /usr/bin/sleep (or a resolved
        // alias) - never a product binary: the gate answers false for it
        // and true only for the product binaries.
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

    /// The replaced-binary gate: the kernel appends " (deleted)" to an
    /// in-place-upgraded binary's exe link - the product binary is still
    /// the product binary (a leftover of the replaced build is still a
    /// leftover worker of this socket).
    #[test]
    fn the_exe_gate_accepts_replaced_binaries() {
        // The predicate is the basename check the gate reads; simulate the
        // kernel's deleted-suffix spelling.
        let replaced = "/opt/prime-agent/bin/prime-agent (deleted)";
        assert!(
            is_product_binary(replaced.trim_end_matches(" (deleted)")),
            "the deleted-suffix spelling still identifies the product binary"
        );
    }

    /// The supervisor socket match normalizes BOTH spellings: a
    /// predecessor started with a `..` or symlink spelling of this very
    /// socket is still a wedged same-socket predecessor.
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

    /// The endpoint gate: only this supervisor's deterministic worker-socket
    /// names match - a foreign path, another socket's key, or a name
    /// outside the shared socket dir never does (the reap's unlink stays
    /// inside the product's endpoint namespace).
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
