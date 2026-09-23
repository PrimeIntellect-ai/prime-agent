//! Daemon discovery: find every product daemon in this state root and probe
//! it for identity and session count (TS `cli/daemon-ps.ts`).
//!
//! Discovery merges two sources by socket path: the OS census of listening
//! unix sockets owned by a product process (the only reliable socket→pid
//! mapping when daemons run on arbitrary `--daemon-socket` paths), and a sweep
//! of the default socket dir, which also catches orphaned socket files left
//! by daemons that are no longer running. Worker sockets (tracked by the
//! supervisor's worker descriptors) add their supervisor's socket to the set
//! so a supervisor whose own listener vanished is still reachable for
//! `shutdown --force`.
//!
//! Scope: one *state root* — the agent dir plus the default socket dir. A
//! daemon started under a different HOME or agent dir is another root's
//! business; stopping it from here would kill unrelated live sessions.
//! (TS also keeps a supervisor-ownership registry rule for custom socket
//! paths outside both directories; that registry is not ported yet, so such
//! paths are invisible to discovery from another invocation until the
//! registry lane lands.)
//!
//! Containment (operator-mandated; see PORTING-NOTES.md): every scan, probe,
//! and stop is scoped to an explicit [`DaemonStateRoot`] handed in by the
//! caller — the CLI passes the env-resolved current root, tests pass only
//! fixture directories they created — and [`NEVER_TOUCH_SOCKET_DIRS`] is a
//! hard exclusion list the scan, probe, and unlink paths check
//! unconditionally, so a state root that resolves onto this box's ambient
//! mission daemons (via a leaked HOME/TMPDIR) still cannot enumerate, probe,
//! or stop them. A daemon outside the root an invocation was given is
//! invisible to it, always.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use pa_types::daemon::DaemonCommand;
use serde::{Deserialize, Serialize};

use crate::config;
use crate::daemon_client::DaemonClient;

mod format;
mod kill;
pub(crate) mod plan;
pub(crate) mod scan;
pub(crate) mod stop;

pub(crate) use format::format_daemon_list_table;
pub(crate) use stop::{run_ps, run_reap, run_shutdown_all};

/// One discovered daemon process: an owning pid and the socket it listens on.
#[derive(Debug, Clone)]
pub(crate) struct DiscoveredDaemonProcess {
    pub pid: u32,
    pub socket_path: PathBuf,
    pub uptime_seconds: Option<u64>,
}

/// The state root an invocation reads: the agent dir and the default socket
/// dir (TS `DaemonStateRoot`). Both follow HOME/TMPDIR/agent-dir overrides,
/// so an isolated root resolves to isolated paths.
#[derive(Debug, Clone)]
pub(crate) struct DaemonStateRoot {
    pub agent_dir: PathBuf,
    pub socket_dir: PathBuf,
    pub default_socket_path: PathBuf,
}

/// Directories the discovery code must never touch, unconditionally
/// (operator-mandated containment guard; see the module docs and
/// PORTING-NOTES.md). These hold this box's live mission infrastructure;
/// an ambient `HOME`/`TMPDIR` leaking into a test process makes
/// `current_state_root()` resolve onto them, so root matching alone cannot
/// be trusted. NOTE: `/tmp/prime-agent-1000` is also the product-default
/// socket dir for uid 1000 — the exclusion is deliberate and mission-local;
/// see PORTING-NOTES.md before changing it. The `-0` entries are the uid-0
/// twins: the product-default socket dir is `<tmpdir>/prime-agent-<uid>`,
/// so on a root-user Linux box (uid 0 — the fleet's root-uid gate and
/// mission topology) the ambient mission daemon lives under
/// `/tmp/prime-agent-0` / `/tmp/mission-tmp/prime-agent-0`, and the guard
/// must cover it exactly like the uid-1000 pair; without them the whole
/// never-touch protection silently disappears at uid 0.
pub(crate) const NEVER_TOUCH_SOCKET_DIRS: &[&str] = &[
    "/tmp/prime-agent-1000",
    "/tmp/mission-tmp/prime-agent-1000",
    "/tmp/mission-daemon",
    "/tmp/prime-agent-0",
    "/tmp/mission-tmp/prime-agent-0",
];

/// True when `path` is or sits inside a never-touch directory.
pub(crate) fn is_never_touch(path: &Path) -> bool {
    NEVER_TOUCH_SOCKET_DIRS
        .iter()
        .any(|dir| path.starts_with(Path::new(dir)))
}

/// Discovered-daemon classification (TS `DaemonStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DaemonStatus {
    Current,
    Stale,
    Unreachable,
    OrphanFile,
}

/// How a discovered daemon's pid was established (TS `pidSource`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PidSource {
    Listener,
    Hello,
}

/// One discovered daemon, probed (TS `DaemonInfo`; field order is the TS JSON
/// shape, options omitted exactly like the TS spread/conditionals).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DaemonInfo {
    pub socket_path: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid_source: Option<PidSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_count: Option<u64>,
    pub status: DaemonStatus,
    pub is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_tracked_workers: Option<bool>,
}

/// The current invocation's state root (TS `currentDaemonStateRoot`).
pub(crate) fn current_state_root() -> DaemonStateRoot {
    DaemonStateRoot {
        agent_dir: config::get_agent_dir(),
        socket_dir: pa_daemon::platform::socket_dir(),
        default_socket_path: pa_daemon::platform::default_daemon_socket_path(),
    }
}

/// A socket belongs to the root when it is the default path, sits in the
/// socket dir, or anywhere inside the agent dir (TS
/// `createDaemonStateRootMatcher` minus the not-yet-ported ownership
/// registry rule).
fn state_root_matches(root: &DaemonStateRoot, socket_path: &Path) -> bool {
    if is_never_touch(socket_path) {
        return false;
    }
    #[cfg(windows)]
    {
        // Windows daemons share one named pipe per machine, so there is
        // nothing to scope beyond the containment guard (TS
        // `createDaemonStateRootMatcher` returns an always-true predicate on
        // win32).
        let _ = (root, socket_path);
        true
    }
    #[cfg(not(windows))]
    {
        if socket_path == root.default_socket_path || socket_path.parent() == Some(&root.socket_dir)
        {
            return true;
        }
        inside(socket_path.parent(), &root.agent_dir)
    }
}

/// True when `directory` is `parent` or sits below it (TS `isInside`). Only
/// the non-Windows root matcher scopes; the Windows arm accepts any path.
#[cfg(not(windows))]
fn inside(directory: Option<&Path>, parent: &Path) -> bool {
    let Some(directory) = directory else {
        return false;
    };
    match directory.strip_prefix(parent) {
        Ok(rest) => !rest.as_os_str().is_empty() || directory == parent,
        Err(_) => false,
    }
}

/// Worker sockets: `worker-*.sock` in the given socket dir (TS
/// `isWorkerSocketPath`) — the supervisor's own socket is never a worker
/// socket. The socket dir comes from the state root, never the ambient
/// environment.
pub(crate) fn is_worker_socket_path(socket_path: &Path, socket_dir: &Path) -> bool {
    if socket_path.parent() != Some(socket_dir) {
        return false;
    }
    let Some(name) = socket_path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    name.starts_with("worker-") && name.ends_with(".sock")
}

/// Listening daemons in this state root (TS `scanListeningDaemons`). The OS
/// census is filtered to the root inside the scan, before any probe or
/// uptime lookup touches a pid: a scan run from one root can never see —
/// let alone stop — a daemon in another root.
pub(crate) fn scan_listening_daemons(root: &DaemonStateRoot) -> Vec<DiscoveredDaemonProcess> {
    scan::scan_all_listening_daemons(config::APP_NAME, root)
}

/// True when the pid still listens on exactly this socket (TS
/// `isDaemonProcessListening`): a fresh scan against the same root, so a
/// re-probe sees the same listener set the discovery did.
pub(crate) fn is_daemon_process_listening(
    pid: u32,
    socket_path: &Path,
    root: &DaemonStateRoot,
) -> bool {
    scan_listening_daemons(root)
        .iter()
        .any(|daemon| daemon.pid == pid && daemon.socket_path == socket_path)
}

/// Socket files in the given socket dir (TS `scanSocketDir`): live daemons
/// and orphaned files alike. Never-touch paths are filtered out here too,
/// so even a root handed in on purpose cannot sweep them.
#[cfg(unix)]
fn scan_socket_dir(socket_dir: &Path) -> Vec<PathBuf> {
    let entries = match std::fs::read_dir(socket_dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut sockets = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if is_socket_file(&path) && !is_never_touch(&path) {
            sockets.push(path);
        }
    }
    sockets
}

/// Windows daemon endpoints are named pipes: there is no socket directory to
/// sweep, and discovery comes from tracked worker descriptors and the
/// default pipe (TS `scanSocketDir` returns [] on win32).
#[cfg(not(unix))]
fn scan_socket_dir(_socket_dir: &Path) -> Vec<PathBuf> {
    Vec::new()
}

/// True when the path is a unix socket file.
#[cfg(unix)]
fn is_socket_file(path: &Path) -> bool {
    use std::os::unix::fs::FileTypeExt;
    std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_socket())
        .unwrap_or(false)
}

/// One tracked worker from a supervisor descriptor (TS `TrackedWorker`).
#[derive(Debug, Clone)]
pub(crate) struct TrackedWorker {
    pub descriptor_path: PathBuf,
    pub supervisor_socket_path: PathBuf,
    pub worker_socket_path: PathBuf,
    pub pid: u32,
    pub process_start_id: Option<String>,
    pub recovery_journal_path: PathBuf,
}

/// Every tracked worker recorded in this agent dir (TS `findAllTrackedWorkers`):
/// `daemon-workers/*/<worker>.json` descriptors. The `supervisor-config` file
/// carries no `.json` extension and is skipped by construction.
pub(crate) fn find_all_tracked_workers(agent_dir: &Path) -> Vec<TrackedWorker> {
    let root = agent_dir.join("daemon-workers");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut workers = Vec::new();
    for directory in entries.flatten() {
        if !directory
            .file_type()
            .map(|kind| kind.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        let Ok(files) = std::fs::read_dir(directory.path()) else {
            continue;
        };
        for file in files.flatten() {
            if file.file_name().to_string_lossy().ends_with(".json") {
                if let Some(worker) = read_tracked_worker(&file.path()) {
                    workers.push(worker);
                }
            }
        }
    }
    workers
}

/// Parse one descriptor file; invalid or concurrently removed descriptors
/// are not safe shutdown targets and are skipped (TS `isTrackedWorkerDescriptor`).
fn read_tracked_worker(path: &Path) -> Option<TrackedWorker> {
    let content = std::fs::read_to_string(path).ok()?;
    let descriptor: serde_json::Value = serde_json::from_str(&content).ok()?;
    let pid = descriptor.get("pid")?.as_u64()?;
    if pid == 0 {
        return None;
    }
    let worker_id = descriptor.get("workerId")?.as_str()?;
    if worker_id.is_empty() {
        return None;
    }
    Some(TrackedWorker {
        descriptor_path: path.to_path_buf(),
        supervisor_socket_path: PathBuf::from(descriptor.get("supervisorSocketPath")?.as_str()?),
        worker_socket_path: PathBuf::from(descriptor.get("socketPath")?.as_str()?),
        pid: pid as u32,
        process_start_id: descriptor
            .get("processStartId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        recovery_journal_path: PathBuf::from(descriptor.get("recoveryJournalPath")?.as_str()?),
    })
}

/// What a probe learned about one daemon (TS `ProbeResult`).
#[derive(Debug, Default)]
pub(crate) struct ProbeResult {
    version: Option<String>,
    protocol_version: Option<u64>,
    schema_id: Option<String>,
    build_id: Option<String>,
    executable_path: Option<String>,
    session_count: Option<u64>,
    supervisor_pid: Option<u32>,
    supervisor_process_start_id: Option<String>,
    reachable: bool,
}

/// Probe one socket: connect (300ms), read the hello (1500ms), and ask for
/// the session count over `list` (30s when greeted, 1500ms otherwise). Old or
/// foreign daemons connect without a recognizable greeting; the session
/// count then also gets the short deadline (TS `probeDaemon`).
pub(crate) fn probe_daemon(socket_path: &Path) -> ProbeResult {
    if is_never_touch(socket_path) {
        // Containment: never even connect to a forbidden path, whatever the
        // caller's root says.
        return ProbeResult::default();
    }
    let Ok(mut client) = DaemonClient::connect_probe(socket_path) else {
        return ProbeResult::default();
    };
    let mut probe = ProbeResult {
        reachable: true,
        ..ProbeResult::default()
    };
    let greeted = client.wait_for_hello(HELLO_TIMEOUT_MS).ok().map(|hello| {
        probe.version = hello
            .get("appVersion")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        probe.protocol_version = hello
            .get("protocol")
            .and_then(|protocol| protocol.get("version"))
            .and_then(serde_json::Value::as_u64);
        probe.schema_id = hello
            .get("schemaId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        if let Some(runtime) = hello.get("runtime") {
            probe.build_id = runtime
                .get("buildId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            probe.executable_path = ["launcherPath", "entrypointPath", "executablePath"]
                .iter()
                .find_map(|key| {
                    runtime
                        .get(*key)
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                });
        }
        probe.supervisor_pid = hello
            .get("supervisorPid")
            .and_then(serde_json::Value::as_u64)
            .and_then(|pid| u32::try_from(pid).ok());
        probe.supervisor_process_start_id = hello
            .get("supervisorProcessStartId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
    });
    let timeout_ms = if greeted.is_some() {
        LIST_TIMEOUT_MS
    } else {
        HELLO_TIMEOUT_MS
    };
    let list = DaemonCommand::List {
        id: None,
        all: None,
        cwd: None,
        session_dir: None,
        include_client_owned: None,
        rest: Default::default(),
    };
    if let Ok(response) = client.request_with_timeout(list, timeout_ms) {
        if response.success {
            probe.session_count = response
                .data
                .as_ref()
                .and_then(|data| data.get("sessions"))
                .and_then(serde_json::Value::as_array)
                .map(|sessions| sessions.len() as u64);
        }
    }
    probe
}

/// Probe deadlines (TS `probeDaemon`).
const HELLO_TIMEOUT_MS: u64 = 1_500;
const LIST_TIMEOUT_MS: u64 = 30_000;

/// Reachable daemons are `current` only when the protocol, schema, and app
/// version all match this build (TS `classifyReachable`).
fn classify_reachable(probe: &ProbeResult) -> DaemonStatus {
    if probe.protocol_version == Some(pa_types::daemon::DAEMON_PROTOCOL_VERSION)
        && probe.schema_id.as_deref() == Some(pa_types::daemon::DAEMON_SCHEMA_ID)
        && probe.version.as_deref() == Some(config::version())
    {
        DaemonStatus::Current
    } else {
        DaemonStatus::Stale
    }
}

/// The hello's supervisor pid, but only when it is alive and its process
/// identity still matches the one the daemon reported (TS
/// `verifyHelloSupervisorPid`; the start-id gate defeats pid reuse).
pub(crate) fn verify_hello_supervisor_pid(
    pid: Option<u32>,
    expected_process_start_id: Option<&str>,
) -> Option<u32> {
    let pid = pid?;
    if pid == 0 {
        return None;
    }
    match pa_types::platform::process::is_process_alive(pid) {
        Ok(true) => {}
        Ok(false) => return None,
        // EPERM-equivalent: the process exists but is not ours to signal.
        Err(_) => return None,
    }
    if let Some(expected) = expected_process_start_id {
        if pa_types::platform::process::process_start_id(pid).as_deref() != Some(expected) {
            return None;
        }
    }
    Some(pid)
}

/// Discover every daemon in this state root and probe each (TS
/// `discoverDaemons`). The root is explicit: the CLI passes the env-resolved
/// current root, tests pass their own fixture dirs. A daemon outside the
/// root is never discovered, probed, or stopped.
pub(crate) fn discover_daemons(root: &DaemonStateRoot) -> Vec<DaemonInfo> {
    let mut process_by_socket = std::collections::HashMap::new();
    for daemon in scan_listening_daemons(root) {
        if is_worker_socket_path(&daemon.socket_path, &root.socket_dir) {
            continue;
        }
        process_by_socket.insert(daemon.socket_path.clone(), daemon);
    }
    let tracked = find_all_tracked_workers(&root.agent_dir);
    let worker_sockets: BTreeSet<PathBuf> = tracked
        .iter()
        .map(|worker| worker.supervisor_socket_path.clone())
        .collect();
    let mut sockets: BTreeSet<PathBuf> = process_by_socket
        .keys()
        .cloned()
        .chain(
            scan_socket_dir(&root.socket_dir)
                .into_iter()
                .filter(|path| !is_worker_socket_path(path, &root.socket_dir)),
        )
        .chain(worker_sockets.iter().cloned())
        .collect();
    sockets.retain(|path| state_root_matches(root, path));

    let mut infos: Vec<DaemonInfo> = sockets
        .into_iter()
        .map(|socket_path| {
            let proc = process_by_socket.get(&socket_path);
            let probe = probe_daemon(&socket_path);
            let pid = proc.map(|daemon| daemon.pid).or_else(|| {
                verify_hello_supervisor_pid(
                    probe.supervisor_pid,
                    probe.supervisor_process_start_id.as_deref(),
                )
            });
            let has_tracked_workers = worker_sockets.contains(&socket_path);
            let status = if probe.reachable {
                classify_reachable(&probe)
            } else if proc.is_some() || has_tracked_workers {
                DaemonStatus::Unreachable
            } else {
                DaemonStatus::OrphanFile
            };
            DaemonInfo {
                pid_source: pid.map(|_| {
                    if proc.is_some() {
                        PidSource::Listener
                    } else {
                        PidSource::Hello
                    }
                }),
                is_default: socket_path == root.default_socket_path,
                socket_path,
                pid,
                uptime_seconds: proc.and_then(|daemon| daemon.uptime_seconds),
                version: probe.version,
                protocol_version: probe.protocol_version,
                schema_id: probe.schema_id,
                build_id: probe.build_id,
                executable_path: probe.executable_path,
                session_count: probe.session_count,
                status,
                has_tracked_workers: has_tracked_workers.then_some(true),
            }
        })
        .collect();
    sort_daemons(&mut infos);
    infos
}

/// Default first, then by status severity, then by socket path (TS
/// `sortDaemons`).
pub(crate) fn sort_daemons(infos: &mut [DaemonInfo]) {
    infos.sort_by(|left, right| {
        right
            .is_default
            .cmp(&left.is_default)
            .then(left.status.cmp(&right.status))
            .then(left.socket_path.cmp(&right.socket_path))
    });
}

/// The quiet-period decision for the shutdown residual sweep (TS
/// `evaluateShutdownQuietPeriod`): a sweep completes once no listener has
/// been seen for a full quiet period.
pub(crate) fn evaluate_shutdown_quiet_period(now_ms: u128, quiet_since_ms: Option<u128>) -> bool {
    quiet_since_ms
        .is_some_and(|quiet_since| now_ms.saturating_sub(quiet_since) >= SHUTDOWN_QUIET_PERIOD_MS)
}

/// How long the residual sweep must see no listener before it succeeds (TS
/// `SHUTDOWN_QUIET_PERIOD_MS`).
const SHUTDOWN_QUIET_PERIOD_MS: u128 = 1_000;

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic state root inside a fixture directory: unit tests never
    /// touch the ambient environment's real agent dir or socket dir.
    #[cfg(not(windows))]
    fn fixture_root(dir: &Path) -> DaemonStateRoot {
        DaemonStateRoot {
            agent_dir: dir.join("agent"),
            socket_dir: dir.join("agent").join("sockets"),
            default_socket_path: dir.join("agent").join("sockets").join("daemon.sock"),
        }
    }

    #[test]
    fn worker_socket_paths_are_scoped_to_the_given_socket_dir() {
        let dir = Path::new("/fixture/agent/sockets");
        assert!(is_worker_socket_path(&dir.join("worker-abc-123.sock"), dir));
        assert!(!is_worker_socket_path(&dir.join("daemon.sock"), dir));
        assert!(!is_worker_socket_path(
            &dir.join("nested/worker-a.sock"),
            dir
        ));
        assert!(!is_worker_socket_path(
            &dir.join("worker-a.sock"),
            Path::new("/fixture/other-sockets")
        ));
    }

    /// Unix scoping semantics; the Windows matcher is deliberately
    /// always-true after the containment guard (one pipe per machine).
    #[cfg(not(windows))]
    #[test]
    fn state_root_matches_own_paths_only() {
        let root = fixture_root(Path::new("/fixture"));
        assert!(state_root_matches(&root, &root.default_socket_path));
        assert!(state_root_matches(
            &root,
            &root.socket_dir.join("daemon.sock")
        ));
        assert!(state_root_matches(
            &root,
            &root.agent_dir.join("nested/daemon.sock")
        ));
        assert!(!state_root_matches(
            &root,
            Path::new("/tmp/other-root/daemon.sock")
        ));
    }

    #[test]
    fn never_touch_paths_are_excluded_even_when_the_root_points_at_them() {
        for dir in NEVER_TOUCH_SOCKET_DIRS {
            let dir = Path::new(dir);
            let root = DaemonStateRoot {
                agent_dir: dir.to_path_buf(),
                socket_dir: dir.to_path_buf(),
                default_socket_path: dir.join("daemon.sock"),
            };
            assert!(
                !state_root_matches(&root, &root.default_socket_path),
                "containment must beat root matching for {dir:?}"
            );
            assert!(!state_root_matches(
                &root,
                &root.socket_dir.join("worker-x.sock")
            ));
        }
        assert!(is_never_touch(Path::new("/tmp/mission-daemon")));
        assert!(is_never_touch(Path::new("/tmp/mission-daemon/daemon.sock")));
        assert!(is_never_touch(Path::new("/tmp/prime-agent-1000")));
        assert!(!is_never_touch(Path::new("/tmp")));
        assert!(!is_never_touch(Path::new("/tmp/other/daemon.sock")));
    }

    #[test]
    fn a_scan_rooted_on_a_never_touch_dir_surfaces_no_listeners() {
        // The ambient mission daemon's workers listen under these dirs and
        // are owned by real `prime-agent` processes: root matching alone
        // would find them, the containment guard must not. The loop covers
        // every guarded dir — the uid-1000 mission paths on a devbox and
        // their uid-0 twins on a root-user Linux box.
        for dir in NEVER_TOUCH_SOCKET_DIRS {
            let dir = *dir;
            let root = DaemonStateRoot {
                agent_dir: PathBuf::from(dir),
                socket_dir: PathBuf::from(dir),
                default_socket_path: PathBuf::from(dir).join("daemon.sock"),
            };
            assert!(
                scan_listening_daemons(&root).is_empty(),
                "scan rooted at {dir} must not surface listeners"
            );
        }
    }

    #[test]
    fn a_probe_never_connects_to_a_never_touch_path() {
        // When the guard works, this never opens a connection. A regression
        // (guard removed) would probe the live mission daemon once and fail
        // the assertion — never kill it.
        let probe = probe_daemon(Path::new("/tmp/mission-daemon/daemon.sock"));
        assert!(!probe.reachable);
    }

    #[cfg(unix)]
    #[test]
    fn discovery_reports_orphan_files_inside_the_given_root_only() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = fixture_root(tmp.path());
        std::fs::create_dir_all(&root.socket_dir).expect("socket dir");
        // Bind and drop: the listener's socket file stays behind (std does
        // not unlink it), an orphan file in the fixture root.
        drop(
            std::os::unix::net::UnixListener::bind(root.socket_dir.join("leftover.sock"))
                .expect("bind"),
        );
        let infos = discover_daemons(&root);
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].socket_path, root.socket_dir.join("leftover.sock"));
        assert_eq!(infos[0].status, DaemonStatus::OrphanFile);
        // Not the root's default path: leftover.sock, not daemon.sock.
        assert!(!infos[0].is_default);
    }

    #[test]
    fn quiet_period_completes_after_the_threshold() {
        assert!(evaluate_shutdown_quiet_period(1_500, Some(500)));
        assert!(!evaluate_shutdown_quiet_period(1_200, Some(500)));
        assert!(!evaluate_shutdown_quiet_period(2_000, None));
    }
}
