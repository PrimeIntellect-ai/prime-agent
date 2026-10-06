//! The TS log-message regexes (src/cli/incident.ts) the classifier
//! matches against, kept 1:1 with their TypeScript sources.

use regex::Regex;
use std::sync::LazyLock;

pub(super) static WORKER_SOCKET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:prime-agent-)?worker-[0-9a-f]+-([0-9a-f]{12})(?:\.sock)?$")
        .expect("valid worker socket pattern")
});

pub(super) static STDERR_FORWARD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Session worker ([0-9a-f]{12}) stderr: ?([\s\S]*)$")
        .expect("valid stderr forward pattern")
});

pub(super) static SUPERVISOR_LISTENING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Prime Agent daemon supervisor \S+ listening on \S+$")
        .expect("valid supervisor listening pattern")
});

pub(super) static WORKER_LISTENING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Prime Agent daemon listening on \S+$").expect("valid worker listening pattern")
});

pub(super) static CRASH_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:uncaught exception|unhandled rejection): (.+)$").expect("valid crash pattern")
});

/// Prefix-test form of [`CRASH_LINE`] (no capture of the message).
pub(super) static CRASH_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:uncaught exception|unhandled rejection): ").expect("valid crash prefix")
});

pub(super) static SHUTDOWN_EXIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^shutting down \(exit (\d+)\); closing (\d+) active session\(s\)$")
        .expect("valid shutdown exit pattern")
});

pub(super) static SIGNAL_SHUTDOWN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^received (\S+); shutting down$").expect("valid signal shutdown pattern")
});

pub(super) static STOP_REQUESTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^shutdown command received over socket; (\d+) active session\(s\) will be closed$")
        .expect("valid stop requested pattern")
});

pub(super) static PASSIVATED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^Passivated idle child sessionId=(\S+) name=("[^"]*"|\S+) idleMinutes=(\d+)$"#)
        .expect("valid passivated pattern")
});

pub(super) static STARTUP_FAILED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Daemon supervisor startup failed: (.+)$").expect("valid startup failed pattern")
});

pub(super) static SUPERVISOR_COMMAND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Supervisor command (\S+) failed: (.+)$")
        .expect("valid supervisor command pattern")
});

pub(super) static DAEMON_COMMAND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^daemon command "([^"]+)" failed: (.+)$"#).expect("valid daemon command pattern")
});

pub(super) static CATCH_UP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:Failed|could not)(?: to)? catch up (?:snapshot )?client \S+(?: for (\S+))?: (.+)$",
    )
    .expect("valid catch-up pattern")
});

pub(super) static HEARTBEATS_LIST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Could not list heartbeats from a worker: (.+)$")
        .expect("valid heartbeats pattern")
});

pub(super) static RECOVERED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Recovered worker (\S+) without replaying uncertain operations: (.+)$")
        .expect("valid recovered pattern")
});

pub(super) static RECOVERED_PLAIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Recovered worker (\S+)$").expect("valid plain recovered pattern")
});

pub(super) static ADOPT_FAILED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Could not adopt worker (\S+): (.+)$").expect("valid adopt failed pattern")
});

pub(super) static RECOVER_FAILED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Could not recover worker (\S+): (.+)$").expect("valid recover failed pattern")
});

pub(super) static FAILED_AFTER_RETRIES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Worker (\S+) failed after three recovery attempts$")
        .expect("valid failed after retries pattern")
});

pub(super) static UNRESPONSIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Worker (\S+) is unresponsive; parked failed after \d+ probe rounds$")
        .expect("valid unresponsive pattern")
});

pub(super) static RECLAIMED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Reclaimed stale registration for stopped worker (\S+)$")
        .expect("valid reclaimed pattern")
});

pub(super) static MIGRATED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Migrated (\d+) scheduled jobs into session artifacts$")
        .expect("valid migrated pattern")
});

pub(super) static REPLACEMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^launched replacement supervisor on \S+$").expect("valid replacement pattern")
});

pub(super) static WOKE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Woke session worker for a due scheduled job: \S+$").expect("valid woke pattern")
});

pub(super) static EVICTED_IDLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Evicted idle worker (\S+) root=\S* idleMinutes=(\d+) sessions=(\d+)$")
        .expect("valid evicted idle pattern")
});

pub(super) static EVICTED_EMPTY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Evicted empty session worker (\S+) root=\S+ on last client detach$")
        .expect("valid evicted empty pattern")
});

pub(super) static AUTH_FAILED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)authentication failed").expect("valid auth pattern"));

pub(super) static UNKNOWN_SESSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"Unknown active session: (\S+)").expect("valid unknown session pattern")
});

pub(super) static STACK_FRAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*at\s").expect("valid stack frame pattern"));
