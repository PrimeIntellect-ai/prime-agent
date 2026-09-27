//! Worker orphan garbage collection: the supervisor-lost exit monitor, port
//! of the TS daemon-mode `startSupervisorMonitor` /
//! `checkSupervisorAvailability` / `exitIfSupervisorOrphanedForTooLong`.
//!
//! A session worker outlives its supervisor process: the supervisor spawns
//! it detached (its own process group), so a supervisor that dies without
//! a graceful stop — a crash, a SIGKILL from a test harness — leaves the
//! worker listening on a socket nobody will dial again. The TS product
//! garbage-collects such workers: while the supervisor socket stays
//! unreachable and no authenticated supervisor connection is held, the
//! worker exits after a bounded window instead of lingering forever.
//! Sessions persist on disk, and a later supervisor spawns fresh workers on
//! demand, so an unreachable-supervisor worker serves nothing by lingering.
//!
//! Divergence from TS, documented: the TS monitor first tries to launch a
//! replacement supervisor (`launchReplacementSupervisor`) and exits only
//! when that fails; the Rust port has no replacement-launch machinery yet,
//! so this monitor implements the TS give-up branch directly (exit after
//! the window). A supervisor restart inside the window is still seamless:
//! the socket's return resets the absence timer and the registration link
//! re-presents the worker's identity.

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use crate::worker::{Worker, WORKER_SUPERVISOR_LOST_EXIT_MS_ENV};

/// TS `DEFAULT_WORKER_SUPERVISOR_LOST_EXIT_MS`: five minutes.
const DEFAULT_LOST_EXIT_MS: u64 = 5 * 60_000;
/// TS `scheduleSupervisorAvailabilityCheck` cadence: the first check
/// 1.5s after boot, then every 5s.
const FIRST_CHECK: Duration = Duration::from_millis(1_500);
const CHECK_INTERVAL: Duration = Duration::from_secs(5);
/// Bounded probe: a supervisor socket that answers slower than this counts
/// as unreachable for the window bookkeeping.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);

/// The supervisor-lost exit window (TS `workerSupervisorLostExitMs`): the
/// env override when it is a finite non-negative number, else the default.
fn lost_exit_ms() -> u64 {
    lost_exit_ms_from(
        std::env::var(WORKER_SUPERVISOR_LOST_EXIT_MS_ENV)
            .ok()
            .as_deref(),
    )
}

/// The TS parse contract: `Number(raw)` kept only when finite and >= 0.
fn lost_exit_ms_from(raw: Option<&str>) -> u64 {
    raw.and_then(|raw| raw.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map_or(DEFAULT_LOST_EXIT_MS, |value| value as u64)
}

/// Whether the supervisor socket accepts connections (TS
/// `canConnectToSupervisor`): a connect that lands at all proves a live
/// supervisor owns the socket.
async fn supervisor_reachable(socket: &Path) -> bool {
    crate::socket::can_connect(socket, CONNECT_TIMEOUT).await
}

/// Arm the orphan-exit monitor for `worker` (a no-op task spawn; the
/// monitor runs for the worker process's whole lifetime, like the TS
/// `startSupervisorMonitor` timer chain).
pub(crate) fn start(worker: Arc<Worker>) {
    tokio::spawn(async move {
        monitor(worker).await;
    });
}

/// The availability-check loop. Every iteration mirrors the TS
/// `checkSupervisorAvailability` guard order: a shutdown in flight or a
/// live authenticated supervisor connection disarms the monitor, a
/// reachable socket resets the absence timer, and only a socket that has
/// been unreachable for the whole window with no session work in flight
/// exits the worker.
async fn monitor(worker: Arc<Worker>) {
    let window = Duration::from_millis(lost_exit_ms());
    let mut absent_since: Option<tokio::time::Instant> = None;
    let mut delay = FIRST_CHECK;
    loop {
        tokio::time::sleep(delay).await;
        delay = CHECK_INTERVAL;
        if worker.core.lock().unwrap().shutdown_requested
            || worker.supervisor_claims.load(Ordering::SeqCst) > 0
        {
            absent_since = None;
            continue;
        }
        if supervisor_reachable(&worker.config.supervisor_socket_path).await {
            absent_since = None;
            continue;
        }
        let since = *absent_since.get_or_insert_with(tokio::time::Instant::now);
        if since.elapsed() < window {
            continue;
        }
        let ongoing = worker.core.lock().unwrap().has_ongoing_work();
        if ongoing {
            // TS `hasOngoingSessionWork`: an active run owns the worker a
            // little longer; its turn end lets the next availability check
            // reconsider.
            continue;
        }
        exit_orphaned(&worker, since).await;
    }
}

/// The TS give-up exit: dispose the session's kernel, persist the recovery
/// journal, remove the worker's own socket file, and end the process (the
/// same sequence the routed `shutdown` command runs; the monitor only
/// reaches this with no session work in flight, so nothing else needs to
/// settle first). The kernel dispose is the TS `shutdown(0)` close pass
/// (`closeSession` -> runtime dispose -> `IpythonKernelProvisioner.dispose`):
/// the process exit runs no destructors, so an undisposed kernel would be
/// orphaned here.
async fn exit_orphaned(worker: &Worker, absent_since: tokio::time::Instant) {
    eprintln!(
        "pa-daemon worker: supervisor {} unreachable for {}s; exiting orphaned worker",
        worker.config.supervisor_socket_path.display(),
        absent_since.elapsed().as_secs()
    );
    if let Some(agent_engine) = &worker.agent_engine {
        agent_engine.dispose_kernel().await;
    }
    let _ = worker.record_recovery(false, "shutdown");
    crate::socket::cleanup_socket_path(
        &worker.config.socket_path,
        crate::socket::socket_identity(&worker.config.socket_path),
    );
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The window parse is the TS `workerSupervisorLostExitMs` contract:
    /// any finite non-negative number wins, everything else (absent,
    /// garbage, negative, NaN) falls back to the default.
    #[test]
    fn lost_exit_window_parses_the_ts_contract() {
        assert_eq!(lost_exit_ms_from(None), DEFAULT_LOST_EXIT_MS);
        assert_eq!(lost_exit_ms_from(Some("garbage")), DEFAULT_LOST_EXIT_MS);
        assert_eq!(lost_exit_ms_from(Some("-1")), DEFAULT_LOST_EXIT_MS);
        assert_eq!(lost_exit_ms_from(Some("NaN")), DEFAULT_LOST_EXIT_MS);
        assert_eq!(lost_exit_ms_from(Some("0")), 0);
        assert_eq!(lost_exit_ms_from(Some("15000")), 15_000);
        assert_eq!(lost_exit_ms_from(Some("15000.5")), 15_000);
    }

    fn lost_exit_ms_from(raw: Option<&str>) -> u64 {
        raw.and_then(|raw| raw.parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map_or(DEFAULT_LOST_EXIT_MS, |value| value as u64)
    }
}
