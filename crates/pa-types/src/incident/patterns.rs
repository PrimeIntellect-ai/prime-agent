//! The TS log-message regexes (src/cli/incident.ts) the classifier
//! matches against, kept 1:1 with their TypeScript sources.

use regex::Regex;
use std::sync::LazyLock;

/// `^(?:prime-agent-)?worker-[0-9a-f]+-([0-9a-f]{12})(?:\.sock)?$`
/// (TS `WORKER_SOCKET_PATTERN`).
pub(super) static WORKER_SOCKET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:prime-agent-)?worker-[0-9a-f]+-([0-9a-f]{12})(?:\.sock)?$")
        .expect("valid worker socket pattern")
});

/// `^Session worker ([0-9a-f]{12}) stderr: ?([\s\S]*)$` — the supervisor's
/// stderr forward.
pub(super) static STDERR_FORWARD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Session worker ([0-9a-f]{12}) stderr: ?([\s\S]*)$")
        .expect("valid stderr forward pattern")
});

/// `/^Prime Agent daemon supervisor \S+ listening on \S+$/`.
pub(super) static SUPERVISOR_LISTENING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Prime Agent daemon supervisor \S+ listening on \S+$")
        .expect("valid supervisor listening pattern")
});

/// `^Prime Agent daemon listening on \S+$`.
pub(super) static WORKER_LISTENING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Prime Agent daemon listening on \S+$").expect("valid worker listening pattern")
});

/// `^(?:uncaught exception|unhandled rejection): (.+)$`.
pub(super) static CRASH_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:uncaught exception|unhandled rejection): (.+)$").expect("valid crash pattern")
});

/// `^(?:uncaught exception|unhandled rejection): ` (prefix test).
pub(super) static CRASH_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:uncaught exception|unhandled rejection): ").expect("valid crash prefix")
});

/// `^shutting down \(exit (\d+)\); closing (\d+) active session\(s\)$`.
pub(super) static SHUTDOWN_EXIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^shutting down \(exit (\d+)\); closing (\d+) active session\(s\)$")
        .expect("valid shutdown exit pattern")
});

/// `^received (\S+); shutting down$`.
pub(super) static SIGNAL_SHUTDOWN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^received (\S+); shutting down$").expect("valid signal shutdown pattern")
});

/// `^shutdown command received over socket; (\d+) active session\(s\) will be closed$`.
pub(super) static STOP_REQUESTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^shutdown command received over socket; (\d+) active session\(s\) will be closed$")
        .expect("valid stop requested pattern")
});

/// `^Passivated idle child sessionId=(\S+) name=("[^"]*"|\S+) idleMinutes=(\d+)$`.
pub(super) static PASSIVATED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^Passivated idle child sessionId=(\S+) name=("[^"]*"|\S+) idleMinutes=(\d+)$"#)
        .expect("valid passivated pattern")
});

/// `^Daemon supervisor startup failed: (.+)$`.
pub(super) static STARTUP_FAILED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Daemon supervisor startup failed: (.+)$").expect("valid startup failed pattern")
});

/// `^Supervisor command (\S+) failed: (.+)$`.
pub(super) static SUPERVISOR_COMMAND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Supervisor command (\S+) failed: (.+)$")
        .expect("valid supervisor command pattern")
});

/// `^daemon command "([^"]+)" failed: (.+)$`.
pub(super) static DAEMON_COMMAND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^daemon command "([^"]+)" failed: (.+)$"#).expect("valid daemon command pattern")
});

/// `^(?:Failed|could not)(?: to)? catch up (?:snapshot )?client \S+(?: for (\S+))?: (.+)$`.
pub(super) static CATCH_UP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:Failed|could not)(?: to)? catch up (?:snapshot )?client \S+(?: for (\S+))?: (.+)$",
    )
    .expect("valid catch-up pattern")
});

/// `^Could not list heartbeats from a worker: (.+)$`.
pub(super) static HEARTBEATS_LIST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Could not list heartbeats from a worker: (.+)$")
        .expect("valid heartbeats pattern")
});

/// `^Recovered worker (\S+) without replaying uncertain operations: (.+)$`.
pub(super) static RECOVERED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Recovered worker (\S+) without replaying uncertain operations: (.+)$")
        .expect("valid recovered pattern")
});

/// `^Recovered worker (\S+)$`.
pub(super) static RECOVERED_PLAIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Recovered worker (\S+)$").expect("valid plain recovered pattern")
});

/// `^Could not adopt worker (\S+): (.+)$`.
pub(super) static ADOPT_FAILED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Could not adopt worker (\S+): (.+)$").expect("valid adopt failed pattern")
});

/// `^Could not recover worker (\S+): (.+)$`.
pub(super) static RECOVER_FAILED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Could not recover worker (\S+): (.+)$").expect("valid recover failed pattern")
});

/// `^Worker (\S+) failed after three recovery attempts$`.
pub(super) static FAILED_AFTER_RETRIES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Worker (\S+) failed after three recovery attempts$")
        .expect("valid failed after retries pattern")
});

/// `^Worker (\S+) is unresponsive; parked failed after \d+ probe rounds$`.
pub(super) static UNRESPONSIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Worker (\S+) is unresponsive; parked failed after \d+ probe rounds$")
        .expect("valid unresponsive pattern")
});

/// `^Reclaimed stale registration for stopped worker (\S+)$`.
pub(super) static RECLAIMED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Reclaimed stale registration for stopped worker (\S+)$")
        .expect("valid reclaimed pattern")
});

/// `^Migrated (\d+) scheduled jobs into session artifacts$`.
pub(super) static MIGRATED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Migrated (\d+) scheduled jobs into session artifacts$")
        .expect("valid migrated pattern")
});

/// `^launched replacement supervisor on \S+$`.
pub(super) static REPLACEMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^launched replacement supervisor on \S+$").expect("valid replacement pattern")
});

/// `^Woke session worker for a due scheduled job: \S+$`.
pub(super) static WOKE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Woke session worker for a due scheduled job: \S+$").expect("valid woke pattern")
});

/// `^Evicted idle worker (\S+) root=\S* idleMinutes=(\d+) sessions=(\d+)$`.
pub(super) static EVICTED_IDLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Evicted idle worker (\S+) root=\S* idleMinutes=(\d+) sessions=(\d+)$")
        .expect("valid evicted idle pattern")
});

/// `^Evicted empty session worker (\S+) root=\S+ on last client detach$`.
pub(super) static EVICTED_EMPTY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Evicted empty session worker (\S+) root=\S+ on last client detach$")
        .expect("valid evicted empty pattern")
});

/// `/authentication failed/i` (TS case-insensitive).
pub(super) static AUTH_FAILED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)authentication failed").expect("valid auth pattern"));

/// `Unknown active session: (\S+)`.
pub(super) static UNKNOWN_SESSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"Unknown active session: (\S+)").expect("valid unknown session pattern")
});

/// `/^\s*at\s/` — a stack frame continuation line.
pub(super) static STACK_FRAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*at\s").expect("valid stack frame pattern"));
