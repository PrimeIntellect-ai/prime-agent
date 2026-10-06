//! Worker orphan garbage collection (TS `exitIfSupervisorOrphanedForTooLong`): a worker
//! whose supervisor died without a graceful stop exits after a bounded unreachable
//! window (sessions persist on disk). Divergence from TS: this port implements the
//! give-up branch directly, not the TS replacement-supervisor launch.

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

/// Whether the supervisor socket accepts connections (TS `canConnectToSupervisor`): a
/// connect that lands proves a live supervisor owns the socket.
async fn supervisor_reachable(socket: &Path) -> bool {
    crate::socket::can_connect(socket, CONNECT_TIMEOUT).await
}

/// Arm the orphan-exit monitor for `worker`: it runs for the process's whole lifetime,
/// like the TS `startSupervisorMonitor` timer chain.
pub(crate) fn start(worker: Arc<Worker>) {
    tokio::spawn(async move {
        monitor(worker).await;
    });
}

/// The availability-check loop (TS `checkSupervisorAvailability` guard order): a shutdown
/// in flight or a live supervisor connection disarms, a reachable socket resets the
/// absence timer, and a socket unreachable for the whole window with no session work
/// in flight exits the worker.
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
            // TS `hasOngoingSessionWork`: an active run owns the worker a little
            // longer; its turn end lets the next check reconsider.
            continue;
        }
        exit_orphaned(&worker, since).await;
    }
}

/// The TS give-up exit: dispose the session's kernel, persist the recovery
/// journal, close the listener and remove the worker's own socket file,
/// and end the process (the same sequence the routed `shutdown` command
/// runs; the monitor only reaches this with no session work in flight,
/// so nothing else needs to settle first). The kernel dispose is the TS
/// `shutdown(0)` close pass (`closeSession` -> runtime dispose ->
/// `IpythonKernelProvisioner.dispose`): the process exit runs no
/// destructors, so an undisposed kernel would be orphaned here.
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
    // The listener closes FIRST and the cleanup probes the path with the
    // owner's bind provably released (the TS graceful-shutdown sequence,
    // shared with `exit_after_close`), so both a REPLACED file and a
    // POISONED capture (a replacement landing in the bind->capture
    // window) spare a successor worker's live socket - the
    // deterministic-path relaunch - while the worker's own dead file
    // still unlinks through the identity gate.
    worker.close_listener_then_cleanup_socket().await;
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

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
